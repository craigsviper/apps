import { useState, useRef, useEffect, useCallback } from 'react';
import { useStore } from '../store';
import { downloadFile } from '../utils/download';
import type { AppData } from '../types';
import { formatBytes, getStorageUsage, getRealStorageQuota, getAndroidRealFreeSpaceBytes } from '../utils/imageCompress';

// ─── Types ───────────────────────────────────────────────────────────────────
interface SyncLogEntry {
  id: string;
  timestamp: string;
  type: 'manual' | 'auto';
  status: 'success' | 'error';
  message: string;
}

interface HostAutoSyncSettings {
  enabled: boolean;
  intervalMinutes: number;
  mode: 'push' | 'pull' | 'both';
}

const SYNCLOG_KEY       = 'rsw_synclog';
const HOST_AUTOSYNC_KEY = 'rsw_host_autosync';

const SYNC_INTERVALS = [
  { label: '5 minutes',  value: 5 },
  { label: '10 minutes', value: 10 },
  { label: '15 minutes', value: 15 },
  { label: '30 minutes', value: 30 },
  { label: '1 hour',     value: 60 },
  { label: '6 hours',    value: 360 },
  { label: '24 hours',   value: 1440 },
];

function loadJSON<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function saveJSON(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}

// ── Forward-compatible collection discovery ─────────────────────────────────
// Known collections get a friendly label + icon. Any OTHER array-valued key
// found on a data object (current data, an uploaded backup file, etc.) is still
// picked up automatically — with a generated label + generic icon — so a brand
// new collection added to the app before this screen is updated is never
// silently dropped from backups, selective backup/restore, or import/merge.
const KNOWN_META: Record<string, { label: string; icon: string }> = {
  users:           { label: 'Users',           icon: '👥' },
  clients:         { label: 'Clients',         icon: '🏢' },
  inspections:     { label: 'Inspections',     icon: '🔍' },
  maps:            { label: 'Maps',            icon: '🗺️' },
  categories:      { label: 'Categories',      icon: '📁' },
  reports:         { label: 'Reports',         icon: '📊' },
  coverTemplates:  { label: 'Cover Templates', icon: '🎨' },
  sweepAreas:      { label: 'Sweep Areas',     icon: '🗺️' },
  sweepRoads:      { label: 'Sweep Roads',     icon: '🛣️' },
  sweepJobs:       { label: 'Sweep Jobs',      icon: '🚛' },
  sweepClients:    { label: 'Sweep Clients',   icon: '🏢' },
  sweepJobSites:   { label: 'Job Sites',       icon: '📌' },
  sweepFiles:      { label: 'Sweep Files',     icon: '📎' },
  sweepCategories: { label: 'SW Categories',   icon: '🏷️' },
  sweepMaps:       { label: 'Sweep Maps',      icon: '🗺️' },
  sweepReports:    { label: 'Sweep Reports',   icon: '📋' },
};
const KNOWN_ORDER = Object.keys(KNOWN_META);

function humanizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}

/** Returns {key, label, icon, count} for every array-valued field on `obj` —
 *  known collections first (in declared order), then any unknown/future ones. */
function statsFor(obj: Record<string, unknown> | null | undefined): { key: string; label: string; icon: string; count: number }[] {
  if (!obj || typeof obj !== 'object') return [];
  const present = Object.keys(obj).filter(k => Array.isArray((obj as any)[k]) && k !== 'deletedIds');
  const ordered = KNOWN_ORDER.filter(k => present.includes(k));
  const extras  = present.filter(k => !KNOWN_ORDER.includes(k)).sort();
  return [...ordered, ...extras].map(k => ({
    key: k,
    label: KNOWN_META[k]?.label || humanizeKey(k),
    icon:  KNOWN_META[k]?.icon  || '📦',
    count: (obj as any)[k].length,
  }));
}

export default function Backup() {
  const {
    data, exportData, importData, setData,
    syncServerUrl, syncToken, setSyncConfig,
    syncError, lastSyncAt,
    pushToServer, pullFromServer,
    pendingServerDeletions, resolveServerDeletions,
  } = useStore();

  const [msg,      setMsg]      = useState('');
  const [msgType,  setMsgType]  = useState<'success' | 'error'>('success');
  const [exporting, setExporting] = useState('');
  const [syncUrlInput,   setSyncUrlInput]   = useState(syncServerUrl);
  const [syncTokenInput, setSyncTokenInput] = useState(syncToken);

  // Detect mobile device — show cert setup banner
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  // Derive mobile setup URL from the sync server URL (same host, port 8056)
  const mobileSetupUrl = syncServerUrl
    ? syncServerUrl.replace(/^https?:\/\//, 'http://').replace(/:\d+$/, ':8056')
    : '';
  const [syncTestMsg,    setSyncTestMsg]    = useState('');
  // v71.4 BUG FIX: Pull & Merge / Push & Sync used to share the store's single
  // global `syncStatus` flag to disable/label themselves — so triggering either
  // one disabled BOTH buttons until it finished, even though a pull and a push
  // are independent, unrelated requests. Each button now tracks its own local
  // in-flight state so they work independently of each other again.
  const [pulling, setPulling] = useState(false);
  const [pushing, setPushing] = useState(false);
  // v71.5: choices for the "record missing on server" review dialog, keyed
  // by "collection:id". Defaults to 'keep' for any candidate not yet chosen.
  const [deletionChoices, setDeletionChoices] = useState<Record<string, 'delete' | 'keep'>>({});
  const [applyingDeletions, setApplyingDeletions] = useState(false);
  useEffect(() => {
    if (pendingServerDeletions.length === 0) return;
    setDeletionChoices(prev => {
      const next = { ...prev };
      for (const c of pendingServerDeletions) {
        const key = `${c.collection}:${c.id}`;
        if (!(key in next)) next[key] = 'keep';
      }
      return next;
    });
  }, [pendingServerDeletions]);
  const [syncTestOk,     setSyncTestOk]     = useState(false);
  const [showSyncPanel,  setShowSyncPanel]  = useState(false);
  const [selectiveKeys, setSelectiveKeys] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(statsFor(data as unknown as Record<string, unknown>).map(s => [s.key, true]))
  );
  const [showSelectiveModal, setShowSelectiveModal] = useState(false);
  const [importPreview, setImportPreview] = useState<AppData | null>(null);
  const [mergeMode,     setMergeMode]     = useState<'replace' | 'merge'>('merge');
  const [importing,     setImporting]     = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Selective Restore state
  const [showSelectiveRestoreModal, setShowSelectiveRestoreModal] = useState(false);
  const [selectiveRestorePreview,   setSelectiveRestorePreview]   = useState<AppData | null>(null);
  const [selectiveRestoreKeys,      setSelectiveRestoreKeys]      = useState<Record<string, boolean>>({});
  const [selectiveRestoreMode,      setSelectiveRestoreMode]      = useState<'replace' | 'merge'>('merge');
  const [selectiveRestoring,        setSelectiveRestoring]        = useState(false);
  const selectiveRestoreRef = useRef<HTMLInputElement>(null);

  // Server selective restore state
  // Server selective restore state removed — feature lives on host-server dashboard
  const [syncLog,     setSyncLog]     = useState<SyncLogEntry[]>(() => loadJSON(SYNCLOG_KEY, []));
  const [showSyncLog, setShowSyncLog] = useState(false);
  const [hostAutoSync, setHostAutoSync] = useState<HostAutoSyncSettings>(() =>
    loadJSON(HOST_AUTOSYNC_KEY, { enabled: false, intervalMinutes: 30, mode: 'both' })
  );
  const [hostNextSyncIn,   setHostNextSyncIn]   = useState(0);
  const [showHostAutoSync, setShowHostAutoSync] = useState(false);
  const [hostSyncRunning,  setHostSyncRunning]  = useState(false);
  const hostAutoSyncRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const hostCountdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hostLastSyncRef  = useRef<number>(Date.now());
  const fileUploadRef = useRef<HTMLInputElement>(null);

  // Server backup / restore state
  const [serverImportMsg,     setServerImportMsg]     = useState('');
  const [serverImportConfirm, setServerImportConfirm] = useState(false);
  const [serverImportData,    setServerImportData]    = useState<string|null>(null);
  const [serverImportName,    setServerImportName]    = useState('');
  const serverImportRef = useRef<HTMLInputElement>(null);
  const [usage,             setUsage]             = useState(() => getStorageUsage());
  // v73.142 — real device free space, available ONLY inside the native Android
  // app (see MainActivity.kt's "AndroidNative" JS bridge) — null in every
  // browser context (Firefox mobile/desktop, Chrome, etc), where there's no
  // way to get this accurately and the browser's own estimate is shown instead.
  const [androidRealFreeBytes, setAndroidRealFreeBytes] = useState<number | null>(null);
  const [isPersisted,       setIsPersisted]       = useState<boolean>(false);
  const [refreshing,        setRefreshing]        = useState(false);
  const [refreshMsg,        setRefreshMsg]        = useState('');
  const [persistGranted,    setPersistGranted]    = useState<boolean | null>(null);
  const [localStorageAt,    setLocalStorageAt]    = useState<Date | null>(null);
  const [localStorageAge,   setLocalStorageAge]   = useState(0);
  const [localStorageLoading, setLocalStorageLoading] = useState(false);
  const [serverDisk,        setServerDisk]        = useState<{ total: number; used: number; available: number; percentage: number; dataFileSize: number } | null>(null);
  const [serverDiskLoading, setServerDiskLoading] = useState(false);
  const [serverDiskAt,      setServerDiskAt]      = useState<Date | null>(null);
  const [serverFiles,        setServerFiles]        = useState<{ id: string; name: string; size: number; uploadedAt: string; uploadedBy: string }[]>([]);
  const [serverFilesLoading, setServerFilesLoading] = useState(false);
  const [serverFilesMsg,     setServerFilesMsg]     = useState('');
  const [serverBackupList,    setServerBackupList]    = useState<{ filename: string; size: number; created: string; manifest?: { totalRecords?: number; version?: string } | null }[]>([]);
  const [serverBackupsLoading,setServerBackupsLoading]= useState(false);
  const [serverBackupsMsg,    setServerBackupsMsg]    = useState('');
  const [serverExportMsg,    setServerExportMsg]    = useState('');
  const [serverExporting,    setServerExporting]    = useState(false);
  const [serverImporting,    setServerImporting]    = useState(false);
  const [serverMgrVersion,   setServerMgrVersion]   = useState('');
  const [diskAgeSecs,        setDiskAgeSecs]        = useState(0);

  const fetchLocalUsage = useCallback(async (silent = false) => {
    if (!silent) setLocalStorageLoading(true);
    try {
      const q = await getRealStorageQuota();
      setUsage(q);
      setLocalStorageAt(new Date());
      if (q.isPersisted   !== undefined) setIsPersisted(q.isPersisted);
      if (q.persistGranted !== undefined) setPersistGranted(q.persistGranted);
      setAndroidRealFreeBytes(getAndroidRealFreeSpaceBytes());
    } catch { /* ignore */ }
    finally { if (!silent) setLocalStorageLoading(false); }
  }, []);

  // Poll every 30 s — mirrors the server storage bar behaviour
  useEffect(() => {
    fetchLocalUsage();
    const id = setInterval(() => fetchLocalUsage(true), 30_000);
    return () => clearInterval(id);
  }, [fetchLocalUsage]);

  // Also refresh whenever app data changes (user adds photos etc.)
  useEffect(() => { fetchLocalUsage(true); }, [data, fetchLocalUsage]);

  // "X s ago" age ticker for local storage bar
  useEffect(() => {
    const id = setInterval(() => setLocalStorageAge(localStorageAt ? Math.round((Date.now() - localStorageAt.getTime()) / 1000) : 0), 1000);
    return () => clearInterval(id);
  }, [localStorageAt]);

  // ── Server disk polling ──────────────────────────────────────────────────
  const fetchServerDisk = useCallback(async (silent = false) => {
    if (!syncServerUrl) return;
    if (!silent) setServerDiskLoading(true);
    try {
      try { await fetch(`${syncServerUrl}/ping`, { signal: AbortSignal.timeout(3000) }); } catch { return; }
      const r = await fetch(`${syncServerUrl}/health`, { headers: { 'X-Sync-Token': syncToken }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return;
      const j = await r.json();
      if (j.disk) { setServerDisk({ ...j.disk, dataFileSize: j.dataFileSize || 0 }); setServerDiskAt(new Date()); }
      if (j.version) setServerMgrVersion(j.version);
    } catch { /* server unreachable — keep last known value */ }
    finally { if (!silent) setServerDiskLoading(false); }
  }, [syncServerUrl, syncToken]);

  // ── "last updated X ago" ticker inside the server storage bar ──────────

  // Poll every 30 s while the manager panel is open; cancel on close.

  const flash = (m: string, t: 'success' | 'error' = 'success') => {
    setMsg(m); setMsgType(t);
    setTimeout(() => setMsg(''), 8000);
  };

  const generateBackup = useCallback((selective = false): string => {
    if (!selective) return exportData();
    const obj: Record<string, unknown> = {};
    Object.keys(selectiveKeys).forEach(k => {
      if (selectiveKeys[k]) obj[k] = (data as any)[k] ?? [];
    });
    // Safety net: include any collection present in `data` that hasn't been
    // wired into the checklist yet (e.g. shipped in app code before this
    // screen was updated) — a future collection can never be silently dropped.
    // IMPORTANT: only for keys the checklist doesn't know about at all — a
    // known key the person explicitly unticked must stay excluded.
    Object.keys(data).forEach(k => {
      if (!(k in selectiveKeys) && Array.isArray((data as any)[k]) && k !== 'deletedIds') {
        obj[k] = (data as any)[k];
      }
    });
    return JSON.stringify(obj, null, 2);
  }, [exportData, data, selectiveKeys]);

  // en-CA locale gives YYYY-MM-DD — same digits, correct NZ local date
  const getFileName = () =>
    `rsw-app-backup-${new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' })}.json`;

  const addLog = useCallback((entry: Omit<SyncLogEntry, 'id' | 'timestamp'>) => {
    setSyncLog(prev => {
      const next = [
        { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, timestamp: new Date().toISOString() },
        ...prev.slice(0, 49),
      ];
      saveJSON(SYNCLOG_KEY, next);
      return next;
    });
  }, []);

  const handleLocalExport = (selective = false) => {
    setExporting(selective ? 'selective' : 'local');
    try {
      const content = generateBackup(selective);
      downloadFile(content, getFileName(), 'application/json');
      flash('✅ Backup downloading! Check your Downloads folder.');
      addLog({ type: 'manual', status: 'success', message: `${selective ? 'Selective' : 'Full'} backup downloaded` });
    } catch (e) {
      flash('❌ Export failed: ' + (e instanceof Error ? e.message : String(e)), 'error');
    }
    setTimeout(() => setExporting(''), 2000);
  };

  const handleMobileShare = async () => {
    try {
      const content = generateBackup(false);
      const file = new File([content], getFileName(), { type: 'application/json' });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'RSW Inspection Backup', text: 'Road & Storm Water Inspection backup' });
        flash('✅ Shared successfully!');
      } else {
        downloadFile(content, getFileName(), 'application/json');
        flash('✅ Downloaded — transfer this file to your other device.');
      }
    } catch (e) {
      if (e instanceof Error && e.name !== 'AbortError')
        flash('❌ Share failed: ' + e.message, 'error');
    }
  };

  const handleCopyJson = async () => {
    const content = generateBackup(false);
    if (content.length > 1_500_000) { flash('⚠️ Backup too large to copy — use the Download button instead.', 'error'); return; }
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(content); }
      else {
        const ta = document.createElement('textarea');
        ta.value = content; ta.style.cssText = 'position:fixed;left:-9999px;opacity:0;pointer-events:none;';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      }
      flash('✅ Backup JSON copied to clipboard!');
    } catch { flash('❌ Copy failed. Use the Download button instead.', 'error'); }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.json') && file.type !== 'application/json') {
      flash('❌ Please select a valid .json backup file.', 'error'); e.target.value = ''; return;
    }
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        if (typeof parsed !== 'object' || parsed === null) throw new Error('Not an object');
        setImportPreview(parsed);
      } catch { flash('❌ Invalid file — please select a valid RSW backup .json file.', 'error'); }
    };
    reader.readAsText(file); e.target.value = '';
  };

  // Selective restore — local app
  const handleSelectiveRestoreFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.json') && file.type !== 'application/json') {
      flash('❌ Please select a valid .json backup file.', 'error'); e.target.value = ''; return;
    }
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        if (typeof parsed !== 'object' || parsed === null) throw new Error('Not an object');
        // Default-check every section the backup actually contains data for —
        // including any future/unknown collection, not just the known ones.
        const keys: Record<string, boolean> = {};
        Object.keys(parsed).forEach(k => {
          const v = (parsed as any)[k];
          if (Array.isArray(v)) keys[k] = v.length > 0;
        });
        setSelectiveRestorePreview(parsed as AppData);
        setSelectiveRestoreKeys(keys);
        setSelectiveRestoreMode('merge');
        setShowSelectiveRestoreModal(true);
      } catch { flash('❌ Invalid file — please select a valid RSW backup .json file.', 'error'); }
    };
    reader.readAsText(file); e.target.value = '';
  };

  const handleSelectiveRestore = () => {
    if (!selectiveRestorePreview || selectiveRestoring) return;
    setSelectiveRestoring(true);
    const preview = selectiveRestorePreview as unknown as Record<string, unknown>;

    if (selectiveRestoreMode === 'replace') {
      // Build a partial object with only the ticked sections, then layer it
      // over current data — generic over every key the backup contains.
      const merged: Record<string, unknown> = { ...(data as unknown as Record<string, unknown>) };
      Object.keys(selectiveRestoreKeys).forEach(k => {
        if (selectiveRestoreKeys[k] && Array.isArray(preview[k])) merged[k] = preview[k];
      });
      setData(merged as unknown as AppData);
      addLog({ type: 'manual', status: 'success', message: 'Selective Restore — Replace selected sections' });
      flash('✅ Selected sections restored! Page will reload in 2s…');
      setShowSelectiveRestoreModal(false); setSelectiveRestorePreview(null); setSelectiveRestoring(false);
      setTimeout(() => window.location.reload(), 2000);
    } else {
      // Merge mode — dedup by id, generic over every key the backup contains.
      const dedup = <T extends { id: string }>(existing: T[], incoming: T[]) => {
        const ids = new Set(existing.map(x => x.id));
        return [...existing, ...incoming.filter(x => !ids.has(x.id))];
      };
      const merged: Record<string, unknown> = { ...(data as unknown as Record<string, unknown>) };
      Object.keys(selectiveRestoreKeys).forEach(k => {
        if (selectiveRestoreKeys[k] && Array.isArray(preview[k])) {
          const existing = Array.isArray((data as any)[k]) ? (data as any)[k] : [];
          merged[k] = dedup(existing, preview[k] as any[]);
        }
      });
      setData(merged as unknown as AppData);
      addLog({ type: 'manual', status: 'success', message: 'Selective Restore — Merge selected sections' });
      flash('✅ Selected sections merged successfully!');
      setShowSelectiveRestoreModal(false); setSelectiveRestorePreview(null); setSelectiveRestoring(false);
    }
  };

  const handleImport = () => {
    if (!importPreview || importing) return;
    setImporting(true);
    if (mergeMode === 'replace') {
      const err = importData(JSON.stringify(importPreview));
      if (err) { flash('❌ ' + err, 'error'); setImporting(false); }
      else {
        addLog({ type: 'manual', status: 'success', message: 'Full restore — Replace mode' });
        flash('✅ Data replaced! Refreshing in 2 seconds...');
        setImportPreview(null);
        setTimeout(() => window.location.reload(), 2000);
      }
    } else {
      const dedup = <T extends { id: string }>(existing: T[], incoming: T[]) => {
        const ids = new Set(existing.map(x => x.id));
        return [...existing, ...incoming.filter(x => !ids.has(x.id))];
      };
      const preview = importPreview as unknown as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...(data as unknown as Record<string, unknown>) };
      Object.keys(preview).forEach(k => {
        if (Array.isArray(preview[k])) {
          const existing = Array.isArray((data as any)[k]) ? (data as any)[k] : [];
          merged[k] = dedup(existing, preview[k] as any[]);
        }
      });
      setData(merged as unknown as AppData);
      addLog({ type: 'manual', status: 'success', message: 'Data merged — Merge mode' });
      flash('✅ Data merged successfully!');
      setImportPreview(null); setImporting(false);
    }
  };

  const updateHostAutoSync = (patch: Partial<HostAutoSyncSettings>) => {
    setHostAutoSync(prev => { const next = { ...prev, ...patch }; saveJSON(HOST_AUTOSYNC_KEY, next); return next; });
  };

  // ── Stable refs so auto-sync timer never restarts just because data changed ──
  const pushToServerRef = useRef(pushToServer);
  const pullFromServerRef = useRef(pullFromServer);
  useEffect(() => { pushToServerRef.current = pushToServer; }, [pushToServer]);
  useEffect(() => { pullFromServerRef.current = pullFromServer; }, [pullFromServer]);

  const performHostAutoSync = useCallback(async () => {
    if (!syncServerUrl) return;
    setHostSyncRunning(true);
    let errMsg = '';
    try {
      if (hostAutoSync.mode === 'push' || hostAutoSync.mode === 'both') {
        const err = await pushToServerRef.current(); if (err) errMsg += `Push: ${err} `;
      }
      if (hostAutoSync.mode === 'pull' || hostAutoSync.mode === 'both') {
        const err = await pullFromServerRef.current(); if (err) errMsg += `Pull: ${err}`;
      }
      addLog({ type: 'auto', status: errMsg ? 'error' : 'success', message: errMsg || `Host auto-sync (${hostAutoSync.mode}) completed` });
    } catch (e) {
      addLog({ type: 'auto', status: 'error', message: `Host auto-sync failed: ${e instanceof Error ? e.message : 'Unknown error'}` });
    } finally { setHostSyncRunning(false); hostLastSyncRef.current = Date.now(); }
  // Only recreate when server URL, mode or addLog changes — NOT when data/push/pull change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncServerUrl, hostAutoSync.mode, addLog]);

  useEffect(() => {
    if (hostAutoSyncRef.current)  clearInterval(hostAutoSyncRef.current);
    if (hostCountdownRef.current) clearInterval(hostCountdownRef.current);
    if (!hostAutoSync.enabled || !syncServerUrl) { setHostNextSyncIn(0); return; }
    const ms = hostAutoSync.intervalMinutes * 60 * 1000;
    hostLastSyncRef.current = Date.now();
    hostCountdownRef.current = setInterval(() => {
      const elapsed = Date.now() - hostLastSyncRef.current;
      setHostNextSyncIn(Math.max(0, Math.ceil((ms - elapsed) / 1000)));
    }, 1000);
    hostAutoSyncRef.current = setInterval(() => { performHostAutoSync(); hostLastSyncRef.current = Date.now(); }, ms);
    return () => { if (hostAutoSyncRef.current) clearInterval(hostAutoSyncRef.current); if (hostCountdownRef.current) clearInterval(hostCountdownRef.current); };
  }, [hostAutoSync.enabled, hostAutoSync.intervalMinutes, syncServerUrl, performHostAutoSync]);


  // ── Server File Manager ────────────────────────────────────────────────────
  const fetchServerFiles = async () => {
    if (!syncServerUrl) return;
    setServerFilesLoading(true); setServerFilesMsg('');
    try {
      const r = await fetch(`${syncServerUrl}/files`, { headers: { 'X-Sync-Token': syncToken }, signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setServerFiles(j.files || []);
      setServerFilesMsg(`✅ ${j.count} file(s) on server`);
    } catch (e) { setServerFilesMsg(`❌ ${e instanceof Error ? e.message : 'Failed to load files'}`); }
    finally { setServerFilesLoading(false); }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !syncServerUrl) return;
    setServerFilesMsg(`⏳ Uploading "${file.name}"…`);
    try {
      const buf = await file.arrayBuffer();
      const r = await fetch(`${syncServerUrl}/files/upload`, {
        method: 'POST',
        headers: { 'X-Sync-Token': syncToken, 'X-File-Name': file.name, 'Content-Type': file.type || 'application/octet-stream', 'X-Uploaded-By': 'webapp' },
        body: buf,
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setServerFilesMsg(`✅ "${file.name}" uploaded successfully`);
      fetchServerFiles();
    } catch (e) { setServerFilesMsg(`❌ ${e instanceof Error ? e.message : 'Upload failed'}`); }
    e.target.value = '';
  };

  const deleteServerFile = async (id: string, name: string) => {
    if (!syncServerUrl || !window.confirm(`Delete "${name}" from server?`)) return;
    try {
      const r = await fetch(`${syncServerUrl}/files/${id}`, { method: 'DELETE', headers: { 'X-Sync-Token': syncToken } });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
      setServerFiles(prev => prev.filter(f => f.id !== id));
      setServerFilesMsg(`✅ "${name}" deleted`);
    } catch (e) { setServerFilesMsg(`❌ ${e instanceof Error ? e.message : 'Delete failed'}`); }
  };

  const fetchServerBackups = async () => {
    if (!syncServerUrl) return;
    setServerBackupsLoading(true); setServerBackupsMsg('');
    try {
      const r = await fetch(`${syncServerUrl}/backup/list`, { headers: { 'X-Sync-Token': syncToken }, signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setServerBackupList(j.backups || []);
      setServerBackupsMsg(`✅ ${j.count} backup(s) found`);
    } catch (e) { setServerBackupsMsg(`❌ ${e instanceof Error ? e.message : 'Failed'}`); }
    finally { setServerBackupsLoading(false); }
  };
  // v73.92 — load the list once a sync server is actually configured,
  // instead of leaving it empty until the user thinks to press Refresh.
  useEffect(() => { if (syncServerUrl) fetchServerBackups(); }, [syncServerUrl]);

  const [restoringBackup,    setRestoringBackup]    = useState('');      // filename being restored
  const [restoreBackupConfirm, setRestoreBackupConfirm] = useState(''); // filename awaiting confirm
  const [deletingBackup,     setDeletingBackup]     = useState('');

  const handleRestoreFromServerBackup = async (filename: string) => {
    if (!syncServerUrl) return;
    setRestoringBackup(filename);
    setServerBackupsMsg('⏳ Restoring server data from backup…');
    try {
      const r = await fetch(`${syncServerUrl}/backup/${encodeURIComponent(filename)}/restore`, {
        method: 'POST',
        headers: { 'X-Sync-Token': syncToken },
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || `HTTP ${r.status}`);
      const mig = j.migrationApplied?.length ? ` (migrated: ${j.migrationApplied.join(', ')})` : '';
      setServerBackupsMsg(`✅ Restored from "${filename}". Safety backup: ${j.safetyBackup || 'none'}${mig}`);
      fetchServerBackups(); // refresh list (new safety backup appeared)
    } catch (e: any) {
      setServerBackupsMsg(`❌ Restore failed: ${e.message}`);
    } finally {
      setRestoringBackup('');
      setRestoreBackupConfirm('');
    }
  };

  const handleDownloadServerBackup = async (filename: string) => {
    if (!syncServerUrl) return;
    try {
      const r = await fetch(`${syncServerUrl}/backup/${encodeURIComponent(filename)}`, { headers: { 'X-Sync-Token': syncToken } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a'); a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) { setServerBackupsMsg(`❌ Download failed: ${e.message}`); }
  };

  const handleDeleteServerBackup = async (filename: string) => {
    if (!syncServerUrl) return;
    setDeletingBackup(filename);
    try {
      const r = await fetch(`${syncServerUrl}/backup/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
        headers: { 'X-Sync-Token': syncToken },
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || `HTTP ${r.status}`);
      setServerBackupList(prev => prev.filter(b => b.filename !== filename));
      setServerBackupsMsg(`✅ Deleted "${filename}"`);
    } catch (e: any) {
      setServerBackupsMsg(`❌ Delete failed: ${e.message}`);
    } finally { setDeletingBackup(''); }
  };

  const formatFileBytes = (b: number) => {
    if (!b) return '0 B';
    const units = ['B','KB','MB','GB'];
    let i = 0; let n = b;
    while (n >= 1024 && i < units.length-1) { n /= 1024; i++; }
    return `${n.toFixed(i>0?1:0)} ${units[i]}`;
  };

  // Called from the "Enable Persistent Storage" button — Chrome needs a
  // user-gesture triggered request for best grant rate.
  // Force a full app cache clear + reload without touching IndexedDB data.
  // Clears only the service worker Cache API (JS, CSS, HTML shell, icons).
  // All inspection data, reports, photos etc in IndexedDB are untouched.
  const forceAppRefresh = async () => {
    setRefreshing(true);
    setRefreshMsg('⏳ Clearing app cache…');
    try {
      // Step 1: Delete ALL Cache API entries
      let cacheCount = 0;
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
        cacheCount = keys.length;
      }

      // Step 2: Unregister ALL service workers so they don't intercept
      // the next request and serve stale pages from an empty cache.
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
        // Give Firefox a moment to fully tear down the SW before reload
        await new Promise(res => setTimeout(res, 300));
      }

      setRefreshMsg(`✅ Cleared ${cacheCount} cache(s) — reloading…`);

      // Step 3: Hard reload for Firefox.
      // Firefox ignores location.href = location.href (serves from cache).
      // Cache-busting query param forces Firefox to treat it as a new URL.
      // location.replace() avoids adding a back-history entry.
      setTimeout(() => {
        try {
          const url = new URL(window.location.href);
          url.searchParams.set('_cb', Date.now().toString());
          window.location.replace(url.toString());
        } catch {
          window.location.reload();
        }
      }, 500);
    } catch (e) {
      setRefreshMsg('❌ ' + (e instanceof Error ? e.message : 'Refresh failed'));
      setRefreshing(false);
    }
  };

  const requestPersist = async () => {
    try {
      if (navigator.storage?.persist) {
        const granted = await navigator.storage.persist();
        setPersistGranted(granted);
        setIsPersisted(granted);
        // Re-fetch quota immediately — Chrome updates it after granting
        await fetchLocalUsage();
      }
    } catch { /* ignore */ }
  };

  const formatCountdown = (secs: number) => {
    if (secs <= 0) return 'Syncing...';
    if (secs < 60) return `${secs}s`;
    const m = Math.floor(secs / 60), s = secs % 60;
    if (m < 60) return `${m}m ${s}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  // Dynamic — always reflects every collection actually present in `data`,
  // including any future ones this screen hasn't been explicitly updated for.
  const dataStats = statsFor(data as unknown as Record<string, unknown>);

  // Keep selectiveKeys in sync if a new collection appears in `data` that
  // wasn't there when this component first mounted (e.g. right after a
  // restore/import added a brand-new collection type).
  useEffect(() => {
    setSelectiveKeys(prev => {
      let changed = false;
      const next = { ...prev };
      dataStats.forEach(s => { if (!(s.key in next)) { next[s.key] = true; changed = true; } });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);


  // ── Server Export — downloads full server data as JSON file ────────────────
  const handleServerExport = async () => {
    if (!syncServerUrl) { setServerExportMsg('❌ No server URL configured.'); return; }
    setServerExporting(true);
    setServerExportMsg('⏳ Fetching data from server…');
    try {
      const res = await fetch(`${syncServerUrl}/data/export`, {
        headers: { 'X-Sync-Token': syncToken },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const ts = new Date().toISOString().replace(/[:.]/g,'').slice(0,15);
      const filename = `rsw-server-backup-${ts}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); document.body.removeChild(a); }, 1000);
      setServerExportMsg(`✅ Server backup downloaded as "${filename}"`);
    } catch (e: any) {
      setServerExportMsg(`❌ Export failed: ${e.message}`);
    } finally {
      setServerExporting(false);
    }
  };

  // ── Server Import — read file then show confirm dialog ─────────────────────
  const handleServerImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const raw = ev.target?.result as string;
      try {
        JSON.parse(raw); // validate it's valid JSON
        setServerImportData(raw);
        setServerImportName(file.name);
        setServerImportMsg('');
        setServerImportConfirm(true);
      } catch {
        setServerImportMsg('❌ Invalid JSON file. Please select a valid RSW export file.');
      }
    };
    reader.onerror = () => setServerImportMsg('❌ Could not read file.');
    reader.readAsText(file);
    e.target.value = '';
  };

  // ── Server Import — execute restore after confirmation ────────────────────
  const handleServerImportConfirm = async () => {
    if (!serverImportData || !syncServerUrl) return;
    setServerImporting(true);
    setServerImportConfirm(false);
    setServerImportMsg('⏳ Uploading and restoring server data…');
    try {
      const res = await fetch(`${syncServerUrl}/data/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Token': syncToken },
        body: serverImportData,
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      const counts = json.counts || {};
      const summary = Object.entries(counts).filter(([,v]) => (v as number) > 0).map(([k,v]) => `${k}: ${v}`).join(' · ');
      setServerImportMsg(`✅ Server restored from "${serverImportName}". Pre-import backup saved on server. ${summary}`);
      setServerImportData(null);
      setServerImportName('');
    } catch (e: any) {
      setServerImportMsg(`❌ Restore failed: ${e.message}`);
    } finally {
      setServerImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">💾 Backup, Restore & Sync</h1>
          <p className="text-gray-500 text-sm mt-1">Export to device · Sync via host server · Import & restore</p>
          <p className="text-gray-500 text-sm font-medium mt-1">App build: v{__APP_VERSION__}</p>
        </div>
        {hostAutoSync.enabled && syncServerUrl && (
          <div className="flex items-center gap-2 bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-2">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-indigo-500" />
            </span>
            <span className="text-sm font-semibold text-indigo-800">Host Auto-Sync ON</span>
            {hostNextSyncIn > 0 && <span className="text-xs text-indigo-600">· next in {formatCountdown(hostNextSyncIn)}</span>}
          </div>
        )}
      </div>

      {msg && (
        <div className={`p-4 rounded-xl text-sm font-medium border ${msgType === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-red-50 text-red-800 border-red-200'}`}>
          {msg}
        </div>
      )}

      {/* ── Mobile cert setup banner — shown when sync is configured on a mobile device ── */}
      {isMobile && syncServerUrl && (
        <div className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <span className="text-2xl shrink-0">📱</span>
            <div>
              <p className="font-bold text-amber-900 text-sm">Mobile device setup required</p>
              <p className="text-xs text-amber-800 mt-1">
                To connect this phone to the sync server, your device must trust the server's SSL certificate.
                Open the link below in your browser — it gives you a one-tap install for your device type.
              </p>
            </div>
          </div>
          <div className="bg-white border border-amber-300 rounded-lg px-3 py-2 font-mono text-sm text-amber-900 break-all select-all">
            {mobileSetupUrl || 'http://192.168.1.X:8056'}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {mobileSetupUrl && (
              <a href={mobileSetupUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-sm font-bold transition">
                🔓 Open Setup Page
              </a>
            )}
            <div className="text-xs text-amber-700 flex items-center gap-1.5 bg-amber-100 rounded-lg px-3 py-2">
              <span>📲 iPhone: downloads iOS profile<br/>🤖 Android: downloads .pem cert</span>
            </div>
          </div>
          <p className="text-xs text-amber-600">
            After installing the cert, come back here and tap <strong>Test Connection</strong>.
            If it still fails, open <span className="font-mono">{syncServerUrl}</span> in a new tab and accept the security warning first.
          </p>
        </div>
      )}

      {/* ── Also show if we get a "Failed to fetch" error on mobile ── */}
      {isMobile && syncError && syncError.includes('fetch') && mobileSetupUrl && (
        <div className="rounded-xl border-2 border-red-400 bg-red-50 p-4">
          <p className="font-bold text-red-900 text-sm mb-2">❌ Cannot reach server — certificate not trusted</p>
          <p className="text-xs text-red-800 mb-3">
            Your device does not trust the sync server's certificate yet. Open the setup page to install it:
          </p>
          <a href={mobileSetupUrl} target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-bold transition w-full">
            🔓 Open Mobile Certificate Setup — {mobileSetupUrl}
          </a>
        </div>
      )}

      {/* Host Sync Server */}
      <div className="card border-2 border-indigo-200 bg-indigo-50/40">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🔄</span>
            <div>
              <h2 className="font-bold text-gray-900">Host Sync Server</h2>
              <p className="text-xs text-gray-500">
                {syncServerUrl ? <><>Connected to </><span className="font-mono text-indigo-700">{syncServerUrl}</span></> : 'Not configured — all devices share data through your host computer'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {syncServerUrl && (<>
              <button
                onClick={async () => {
                  setPulling(true);
                  try {
                    const err = await pullFromServer();
                    if (err) { setSyncTestMsg('❌ ' + err); setSyncTestOk(false); }
                    else { setSyncTestMsg('✅ Pulled & merged latest data from server'); setSyncTestOk(true); }
                  } finally {
                    setPulling(false);
                    setTimeout(() => setSyncTestMsg(''), 5000);
                  }
                }}
                disabled={pulling}
                className="btn-secondary text-xs">{pulling ? '⏳ Pulling…' : '⬇️ Pull & Merge'}</button>
              <button
                onClick={async () => {
                  setPushing(true);
                  try {
                    const err = await pushToServer();
                    if (err) { setSyncTestMsg('❌ ' + err); setSyncTestOk(false); }
                    else { setSyncTestMsg('✅ Data pushed & merged on server'); setSyncTestOk(true); }
                  } finally {
                    setPushing(false);
                    setTimeout(() => setSyncTestMsg(''), 5000);
                  }
                }}
                disabled={pushing}
                className="btn-primary text-xs">{pushing ? '⏳ Pushing…' : '⬆️ Push & Sync'}</button>
            </>)}
            <button onClick={() => setShowSyncPanel(v => !v)} className="btn-secondary text-xs">⚙️ {showSyncPanel ? 'Close' : 'Configure'}</button>
          </div>
        </div>
        {syncTestMsg && <div className={`mt-3 text-sm p-2 rounded-lg ${syncTestOk ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>{syncTestMsg}</div>}
        {syncError && !syncTestMsg && <div className="mt-3 text-sm p-2 rounded-lg bg-red-100 text-red-800">❌ {syncError}</div>}
        {lastSyncAt && !syncTestMsg && <p className="mt-2 text-xs text-gray-400">Last sync: {new Date(lastSyncAt).toLocaleString()}</p>}
        {showSyncPanel && (
          <div className="mt-4 pt-4 border-t border-indigo-200 space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Sync Server URL <span className="ml-2 font-normal text-gray-400 text-xs">(host computer's IP via Twingate)</span></label>
              <input
                className={`input-field font-mono text-sm ${syncUrlInput && !syncUrlInput.startsWith('https://') ? 'border-red-400 bg-red-50' : ''}`}
                value={syncUrlInput}
                onChange={e => setSyncUrlInput(e.target.value)}
                onBlur={e => {
                  // Auto-fix: if user typed without https://, add it
                  const v = e.target.value.trim();
                  if (v && !v.startsWith('https://') && !v.startsWith('http://')) {
                    setSyncUrlInput('https://' + v);
                  } else if (v.startsWith('http://')) {
                    setSyncUrlInput(v.replace('http://', 'https://'));
                  }
                }}
                placeholder="https://192.168.1.x:8055"
                autoCorrect="off" autoCapitalize="none" spellCheck={false}
              />
              {syncUrlInput && !syncUrlInput.startsWith('https://') && (
                <p className="text-xs text-red-600 font-medium mt-1">
                  ⚠️ URL must start with <strong>https://</strong> — the server uses SSL. Without it the certificate page won't work.
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Sync Token <span className="ml-2 font-normal text-gray-400 text-xs">(must match SYNC_TOKEN in docker-compose.yml)</span></label>
              <input className="input-field font-mono text-sm" type="password" value={syncTokenInput} onChange={e => setSyncTokenInput(e.target.value)} placeholder="rsw-sync-token-change-me" />
            </div>
            <div className="flex gap-2">
              <button onClick={async () => { setSyncTestMsg(''); setSyncTestOk(false); const url = syncUrlInput.replace(/\/$/, ''); try { await fetch(`${url}/ping`, { signal: AbortSignal.timeout(3000) }); const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) }); const j = await r.json(); if (j.status === 'ok') { setSyncTestMsg(`✅ Server reachable`); setSyncTestOk(true); if (j.disk) { setServerDisk({ ...j.disk, dataFileSize: j.dataFileSize || 0 }); setServerDiskAt(new Date()); } } else throw new Error('Unexpected response'); } catch (e) { setSyncTestMsg(`❌ Cannot reach server: ${e instanceof Error ? e.message : 'timeout'}`); setSyncTestOk(false); } }} className="btn-secondary text-sm">🔌 Test Connection</button>
              <button onClick={() => { setSyncConfig(syncUrlInput, syncTokenInput); setSyncTestMsg('✅ Sync settings saved'); setSyncTestOk(true); setTimeout(() => setSyncTestMsg(''), 3000); }} className="btn-primary text-sm">💾 Save Settings</button>
            </div>
            <div className="space-y-2">
              <div className="p-3 bg-amber-50 border-2 border-amber-400 rounded-xl space-y-2">
                <p className="font-bold text-amber-900 text-sm">🔐 Step 1 — Accept the SSL Certificate</p>
                <p className="text-xs text-amber-800">
                  The sync server uses a self-signed SSL certificate. You must open the server address in your
                  browser <strong>with https://</strong> and accept the security warning once per device.
                </p>
                {syncUrlInput ? (
                  <>
                    {/* Open /cert on the sync server — accepts the SSL cert AND confirms trust */}
                    {(() => {
                      const base = syncUrlInput.replace(/\/+$/, '').replace(/^http:\/\//, 'https://');
                      const certUrl = base.startsWith('https://') ? base + '/cert' : 'https://' + base.replace(/^https?:\/\//, '') + '/cert';
                      const dashUrl = base.startsWith('https://') ? base + '/dashboard' : 'https://' + base.replace(/^https?:\/\//, '') + '/dashboard';
                      return (
                        <>
                          <div className="bg-white/80 rounded-lg px-3 py-2 text-xs text-amber-900 border border-amber-200 space-y-1">
                            <p className="font-semibold">Step 1 — Accept the SSL certificate:</p>
                            <p className="font-mono text-sm font-bold text-amber-700 break-all">{certUrl}</p>
                            <p className="text-amber-600">When the browser warns "connection not private" — tap <strong>Advanced → Proceed</strong>. The page will then confirm the cert is trusted.</p>
                          </div>
                          <a
                            href={certUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center justify-center gap-2 w-full px-4 py-3.5 bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white rounded-xl text-base font-bold transition shadow-md"
                          >
                            🛡️ Accept SSL Certificate
                          </a>
                          <a
                            href={dashUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center justify-center gap-2 w-full px-3 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold transition"
                          >
                            📊 Open Server Dashboard
                          </a>
                        </>
                      );
                    })()}
                  </>
                ) : (
                  <p className="text-xs text-amber-700 italic">Enter your Server URL above first (e.g. <span className="font-mono font-bold">https://192.168.1.7:8055</span>), then this button will appear.</p>
                )}
                {syncUrlInput && (
                  <div className="bg-white/70 rounded-lg px-3 py-2 space-y-1 text-xs text-amber-800">
                    <p className="font-semibold text-amber-900 mb-1">What to do when the browser warns you:</p>
                    <p><strong>Chrome / Android:</strong> Tap <em>Advanced</em> → <em>Proceed to [IP] (unsafe)</em></p>
                    <p><strong>Safari / iPhone:</strong> Tap <em>Show Details</em> → <em>Visit this Website</em> → <em>Visit Website</em></p>
                    <p><strong>Firefox:</strong> Tap <em>Advanced</em> → <em>Accept the Risk and Continue</em></p>
                    <p className="text-red-700 font-medium mt-1">🚫 If you see a normal webpage or nothing happens — you may have used http:// instead of https://. Check the URL bar starts with <strong>https://</strong></p>
                  </div>
                )}
              </div>
              <div className="p-3 bg-white/80 rounded-lg text-xs text-gray-600 space-y-1 border border-indigo-100">
                <p className="font-semibold text-gray-700">💡 After accepting, come back here and tap <strong>Test Connection</strong></p>
                <p className="text-gray-500">For a permanent fix (no warning ever again), use the mobile setup page to install the cert: <span className="font-mono text-amber-700">{mobileSetupUrl || 'http://SERVER_IP:8056'}</span></p>
                <p className="text-indigo-700 font-semibold mt-1">🔄 Push and Pull always merge — no data is ever lost</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Host Server Auto-Sync */}
      <div className="card border-2" style={{ borderColor: hostAutoSync.enabled ? '#6366F1' : '#E5E7EB' }}>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="font-bold text-gray-900 text-lg">🖥️ Host Server — Auto-Sync</h2>
            <p className="text-xs text-gray-500 mt-0.5">Automatically push and/or pull data to/from the host sync server at a set interval</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-gray-700">{hostAutoSync.enabled ? '🟢 ON' : '⚫ OFF'}</span>
            <div onClick={() => { if (!syncServerUrl && !hostAutoSync.enabled) { flash('⚠️ Configure your Host Sync Server URL first', 'error'); return; } updateHostAutoSync({ enabled: !hostAutoSync.enabled }); }} className={`relative w-14 h-7 rounded-full transition-colors duration-300 cursor-pointer ${hostAutoSync.enabled ? 'bg-indigo-500' : 'bg-gray-300'}`}>
              <div className={`absolute top-1 w-5 h-5 bg-white rounded-full shadow transition-all duration-300 ${hostAutoSync.enabled ? 'left-8' : 'left-1'}`} />
            </div>
            <button onClick={() => setShowHostAutoSync(v => !v)} className="btn-secondary text-xs">{showHostAutoSync ? '▲ Less' : '▼ Configure'}</button>
          </div>
        </div>
        {hostAutoSync.enabled && hostNextSyncIn > 0 && (
          <div className="mb-4 p-3 bg-indigo-50 rounded-xl flex items-center justify-between">
            <span className="text-sm text-indigo-700 font-medium">⏱ Next auto-sync in</span>
            <span className="text-lg font-bold text-indigo-900">{formatCountdown(hostNextSyncIn)}</span>
          </div>
        )}
        {hostSyncRunning && <div className="mb-4 p-3 bg-indigo-50 rounded-xl text-sm text-indigo-700 animate-pulse">⏳ Running host auto-sync...</div>}
        {showHostAutoSync && (
          <div className="space-y-4 pt-4 border-t border-gray-200">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">⏱ Sync Interval</label>
              <div className="flex flex-wrap gap-2">
                {SYNC_INTERVALS.map(opt => (
                  <button key={opt.value} onClick={() => updateHostAutoSync({ intervalMinutes: opt.value })} className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${hostAutoSync.intervalMinutes === opt.value ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{opt.label}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">🔁 Sync Mode</label>
              <div className="grid grid-cols-3 gap-2">
                {(['push', 'pull', 'both'] as const).map(mode => (
                  <button key={mode} onClick={() => updateHostAutoSync({ mode })} className={`p-3 rounded-xl border-2 text-center text-xs font-medium transition-all ${hostAutoSync.mode === mode ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                    <div className="text-lg mb-1">{mode === 'push' ? '⬆️' : mode === 'pull' ? '⬇️' : '🔄'}</div>
                    <div className="capitalize">{mode}</div>
                    <div className="text-gray-400 font-normal mt-0.5">{mode === 'push' ? 'Upload only' : mode === 'pull' ? 'Download only' : 'Both'}</div>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => performHostAutoSync()} disabled={hostSyncRunning || !syncServerUrl} className="btn-primary flex-1 text-sm">{hostSyncRunning ? '⏳ Syncing...' : '▶️ Run Now'}</button>
            </div>
            {!syncServerUrl && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 p-3 rounded-xl">⚠️ Configure your Host Sync Server URL in the Sync Settings panel above to enable host auto-sync.</p>}
          </div>
        )}
        <div className="mt-4 pt-4 border-t border-gray-100">
          <button onClick={() => setShowSyncLog(v => !v)} className="text-xs text-gray-500 hover:text-gray-700 font-medium">📋 {showSyncLog ? 'Hide' : 'View'} Sync Log ({syncLog.length})</button>
          {showSyncLog && (
            <div className="mt-3 space-y-1.5 max-h-48 overflow-y-auto">
              {syncLog.length === 0 ? <p className="text-xs text-gray-400">No sync activity yet.</p> : syncLog.map(entry => (
                <div key={entry.id} className={`flex items-start gap-2 p-2 rounded-lg text-xs ${entry.status === 'success' ? 'bg-emerald-50' : 'bg-red-50'}`}>
                  <span>{entry.status === 'success' ? '✅' : '❌'}</span>
                  <div className="flex-1 min-w-0"><span className="text-gray-700">{entry.message}</span><div className="text-gray-400 mt-0.5">{new Date(entry.timestamp).toLocaleString()} · {entry.type}</div></div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>


            {/* ── Force App Refresh ── */}
      <div className="card border-2 border-blue-100">
        <div className="flex items-start gap-4">
          <div className="text-3xl mt-0.5">🔄</div>
          <div className="flex-1 min-w-0">
            <h2 className="font-bold text-gray-900 text-base">Force App Refresh</h2>
            <p className="text-xs text-gray-500 mt-1">
              Clears the app's cached files (JS, CSS, HTML, icons) and reloads fresh from the server.{' '}
              <strong className="text-gray-700">Your data is safe</strong> — inspections, reports, photos and sweep jobs
              are stored in IndexedDB which is separate from the file cache and is never touched by this.
            </p>
            <p className="text-xs text-blue-600 mt-1.5 font-medium">
              📱 Firefox mobile tip: use this instead of clearing all site data, which would also wipe your local data.
              Always sync to the host server first if you have unsynced changes.
            </p>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          <button
            onClick={forceAppRefresh}
            disabled={refreshing}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 text-white rounded-xl text-sm font-bold transition shadow-sm touch-manipulation"
          >
            {refreshing
              ? <><span className="animate-spin inline-block">↻</span> Refreshing…</>
              : <>🔄 Clear App Cache &amp; Reload</>
            }
          </button>

          {refreshMsg && (
            <div className={`text-xs px-3 py-2.5 rounded-xl font-medium ${
              refreshMsg.startsWith('✅') ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
              : refreshMsg.startsWith('❌') ? 'bg-red-50 text-red-700 border border-red-200'
              : 'bg-blue-50 text-blue-700 border border-blue-200'
            }`}>{refreshMsg}</div>
          )}

          <div className="grid grid-cols-2 gap-2 pt-1">
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-xs">
              <p className="font-bold text-emerald-800 mb-1">✅ Cleared (safe)</p>
              <p className="text-emerald-700">App JS &amp; CSS files</p>
              <p className="text-emerald-700">HTML shell &amp; icons</p>
              <p className="text-emerald-700">Service worker cache</p>
            </div>
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 text-xs">
              <p className="font-bold text-gray-800 mb-1">🔒 Preserved</p>
              <p className="text-gray-600">Inspections &amp; reports</p>
              <p className="text-gray-600">Photos &amp; sweep data</p>
              <p className="text-gray-600">Sync settings &amp; users</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Local Device Storage ── */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="font-semibold text-gray-900">📱 This Device — Storage Usage</h2>
            <p className="text-xs text-gray-400 mt-0.5">Browser storage on <em>this</em> device (phone, tablet, or computer)</p>
          </div>
          <button
            onClick={() => fetchLocalUsage()}
            disabled={localStorageLoading}
            className="text-xs text-indigo-600 hover:text-indigo-800 disabled:opacity-40 flex items-center gap-1"
            title="Refresh now"
          >
            <span className={localStorageLoading ? 'animate-spin inline-block' : ''}>↻</span>
            {localStorageLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {(() => {
          // Always use the local browser's storage estimate — never mix in server
          // disk numbers here. navigator.storage.estimate() returns:
          //   usage = how many bytes this origin is using in IndexedDB + Cache API
          //   quota = how many bytes the BROWSER (not the OS) is willing to let this
          //           origin use, per its own internal heuristic
          //
          // v73.141 — Craig-reported (screenshots): this page showed "Available to
          // app: 112.5 GB" while Android's own file manager showed only ~50GB
          // actually free (256GB total, 205.8GB used) — and a real "storage full"
          // write failure happened anyway. The `quota` number is NOT a live "how
          // much space is really free on your device" figure — it's the browser's
          // own estimate/upper-bound, and on Firefox in particular it can stay
          // large even as real free space drops, because there is no cross-browser
          // API that hands a web page the OS's actual current free-space number
          // (deliberately, for privacy — a page could otherwise fingerprint/probe
          // your device). So `quota` and true free space can and do diverge,
          // especially on devices with no expandable storage. Caveat text added
          // below so this is never read as a literal guarantee again.
          const appUsed  = usage.used;   // bytes RSW is actually storing
          const quota    = usage.total;  // bytes the BROWSER'S OWN ESTIMATE allows for this origin — see note above, this can diverge from actual device free space
          const hasQuota = quota > 0;
          const freePct  = hasQuota ? Math.max(0, 100 - usage.percentage) : 0;
          const usedPct  = hasQuota ? usage.percentage : 0;

          const barColor  = usedPct >= 80 ? 'bg-red-500'   : usedPct >= 60 ? 'bg-amber-500'  : 'bg-indigo-500';
          const textColor = usedPct >= 80 ? 'text-red-700' : usedPct >= 60 ? 'text-amber-700': 'text-indigo-700';
          const bgColor   = usedPct >= 80 ? 'bg-red-50'    : usedPct >= 60 ? 'bg-amber-50'   : 'bg-indigo-50';

          return (
            <div className="space-y-3">
              {/* Bar */}
              <div className="w-full h-5 bg-gray-200 rounded-full overflow-hidden flex" title={`${usedPct}% of browser quota used`}>
                <div className={`h-full ${barColor} transition-all duration-700 rounded-full`} style={{ width: `${usedPct}%` }} title={`RSW data: ${formatBytes(appUsed)}`} />
              </div>

              {/* Numbers */}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <span className="flex items-center gap-1.5">
                  <span className={`inline-block w-2.5 h-2.5 rounded-sm ${barColor}`} />
                  RSW app data: <strong>{appUsed > 0 ? formatBytes(appUsed) : 'Calculating…'}</strong>
                </span>
                {hasQuota && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-2.5 h-2.5 rounded-sm bg-gray-200" />
                    Available to app (browser estimate): <strong>{formatBytes(quota - appUsed)}</strong>
                  </span>
                )}
              </div>

              {/* v73.142 — genuinely accurate, only available inside the native Android app
                  (see MainActivity.kt's "AndroidNative" bridge / getAndroidRealFreeSpaceBytes()
                  in imageCompress.ts) — this is the one place this app can show a real number
                  instead of a browser estimate, so it's called out distinctly when present. */}
              {androidRealFreeBytes !== null && (
                <div className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200">
                  <span>📱</span>
                  <span className="text-emerald-800">
                    Real device free space (from Android): <strong>{formatBytes(androidRealFreeBytes)}</strong> — this one matches your phone's own Settings → Storage.
                  </span>
                </div>
              )}

              {hasQuota && (
                <p className="text-xs text-gray-400">
                  {androidRealFreeBytes !== null ? (
                    <>⚠️ The "Available to app" figure above is the <em>browser's</em> own estimate, not the real number —
                    use the green figure above instead, which comes from Android directly.</>
                  ) : (
                    <>⚠️ This is the browser's own estimate, not a live reading of your device's actual free space —
                    it can be wrong, especially on a device with no expandable storage. Check your phone's own
                    Settings → Storage for the real number.</>
                  )} If you ever see a "Storage full" warning, trust that —
                  it means a save genuinely failed — regardless of what any estimate says.
                </p>
              )}

              {/* Summary */}
              {hasQuota && (
                <div className={`flex items-center justify-between text-xs px-3 py-2 rounded-lg ${bgColor}`}>
                  <span className="text-gray-600">
                    {appUsed > 0 ? formatBytes(appUsed) : '—'} used of {formatBytes(quota)} browser quota
                  </span>
                  <span className={`font-bold ${textColor}`}>{usedPct}% · {formatBytes(quota - appUsed)} free</span>
                </div>
              )}
              {!hasQuota && (
                <div className="text-xs text-gray-400 italic py-1">
                  {localStorageLoading ? '⏳ Measuring storage…' : 'Storage quota unavailable on this browser.'}
                </div>
              )}

              {usedPct >= 60 && usedPct < 80 && (
                <p className="text-xs text-amber-700 font-semibold bg-amber-50 p-2 rounded-lg">
                  ⚠️ Storage getting full on this device — export a backup and delete old data.
                </p>
              )}
              {usedPct >= 80 && (
                <p className="text-xs text-red-700 font-semibold bg-red-50 p-2 rounded-lg">
                  🚨 Storage nearly full on this device! Export a backup immediately and clear old data.
                </p>
              )}

              {/* ── Persistent storage status + Chrome unlock button ── */}
              {(() => {
                // Firefox auto-grants persistence → shows full quota immediately.
                // Chrome requires an explicit persist() request. Until granted,
                // Chrome caps the quota at ~10 GB regardless of free disk space.
                // Once granted, Chrome reports the real large quota like Firefox.
                const isChromeLike = /Chrome|Chromium|Edg/.test(navigator.userAgent) && !/Firefox/.test(navigator.userAgent);
                const notYetPersisted = persistGranted === false || (persistGranted === null && !isPersisted);
                const denied = persistGranted === false;

                return (
                  <div className="space-y-2">
                    {/* Status pill */}
                    <div className={`flex items-center gap-2 text-xs px-3 py-2 rounded-lg border ${isPersisted ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
                      <span className={`text-base ${isPersisted ? '' : 'animate-pulse'}`}>{isPersisted ? '🔒' : '⚠️'}</span>
                      <div className="flex-1">
                        {isPersisted ? (
                          <span className="text-emerald-700 font-semibold">Persistent storage active — full device quota unlocked</span>
                        ) : (
                          <span className="text-amber-700 font-semibold">
                            {isChromeLike
                              ? 'Chrome is using limited quota (~10 GB). Tap below to unlock full device storage.'
                              : 'Storage not yet set to persistent — data may be cleared under pressure.'}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Unlock button — only show when not persisted and not denied */}
                    {!isPersisted && !denied && (
                      <button
                        onClick={requestPersist}
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white rounded-xl text-sm font-bold transition shadow-sm"
                      >
                        🔓 Enable Persistent Storage — Unlock Full Quota
                      </button>
                    )}

                    {/* Chrome denied explanation */}
                    {denied && (
                      <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                        <p className="font-semibold text-gray-700 mb-1">Chrome denied the storage request.</p>
                        <p>To fix: install the app (tap <strong>⋮ → Add to Home Screen</strong>), then return here and tap Refresh. Installed PWAs are always granted persistent storage by Chrome.</p>
                      </div>
                    )}
                  </div>
                );
              })()}

              <div className="text-xs text-gray-400 space-y-0.5">
                <p>📱 This shows storage on <strong>this device</strong> — your phone, tablet, or computer.</p>
                <p>🔄 All data is saved locally in IndexedDB — works fully offline in the field.</p>
                <p>⏱ Last measured: {localStorageAge < 5 ? 'just now' : `${localStorageAge}s ago`} · Auto-refreshes every 30s</p>
              </div>
            </div>
          );
        })()}
      </div>

      {/* ── Mobile Field Workflow ── */}
      <div className="card border-2 border-orange-200 bg-orange-50/30">
        <div className="flex items-start gap-3 mb-4">
          <span className="text-3xl">📱</span>
          <div>
            <h2 className="font-bold text-gray-900 text-lg">Mobile Field Workflow</h2>
            <p className="text-sm text-gray-500">How to use the app offline in the field on your phone or tablet</p>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-white rounded-xl p-4 border border-orange-100 space-y-2">
            <p className="font-semibold text-gray-800 text-sm flex items-center gap-2">🖥️ On the Office Computer</p>
            <ul className="text-xs text-gray-600 space-y-1.5">
              <li className="flex items-start gap-1.5"><span className="text-orange-500 font-bold mt-0.5">1.</span> Create sweep jobs, maps, areas &amp; roads</li>
              <li className="flex items-start gap-1.5"><span className="text-orange-500 font-bold mt-0.5">2.</span> Set up clients, job sites &amp; categories</li>
              <li className="flex items-start gap-1.5"><span className="text-orange-500 font-bold mt-0.5">3.</span> Push data to the sync server</li>
            </ul>
          </div>
          <div className="bg-white rounded-xl p-4 border border-orange-100 space-y-2">
            <p className="font-semibold text-gray-800 text-sm flex items-center gap-2">📱 On Mobile in the Field</p>
            <ul className="text-xs text-gray-600 space-y-1.5">
              <li className="flex items-start gap-1.5"><span className="text-indigo-500 font-bold mt-0.5">1.</span> Pull latest data before leaving office WiFi</li>
              <li className="flex items-start gap-1.5"><span className="text-indigo-500 font-bold mt-0.5">2.</span> Open any sweep job &rarr; tap <strong>Edit / Add Data</strong></li>
              <li className="flex items-start gap-1.5"><span className="text-indigo-500 font-bold mt-0.5">3.</span> Add fuel dockets, tip runs, expenses, photos</li>
              <li className="flex items-start gap-1.5"><span className="text-indigo-500 font-bold mt-0.5">4.</span> All saves go to <em>this device</em> — no internet needed</li>
              <li className="flex items-start gap-1.5"><span className="text-indigo-500 font-bold mt-0.5">5.</span> Back at WiFi — tap <strong>Push &amp; Sync</strong> above ⬆️</li>
            </ul>
          </div>
        </div>
        <div className="mt-4 p-3 bg-white rounded-xl border border-orange-100 flex items-center gap-3">
          <span className="text-2xl">💡</span>
          <div>
            <p className="text-xs font-semibold text-gray-800">Same goes for Site &amp; Road Inspections</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Open any inspection in the field, add photos and findings — they save instantly to this device.
              Sync back to the server when you're on WiFi or data.
            </p>
          </div>
        </div>
      </div>


      {/* Data Overview */}
      <div className="card">
        <h2 className="font-semibold text-gray-900 mb-3">📊 Current Data</h2>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {dataStats.map(s => (
            <div key={String(s.key)} className="text-center p-3 bg-gray-50 rounded-xl">
              <div className="text-xl">{s.icon}</div>
              <div className="text-2xl font-bold text-gray-900">{s.count}</div>
              <div className="text-xs text-gray-500">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Export & Import */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h2 className="font-semibold text-gray-900 mb-1">📥 Export to Device</h2>
          <p className="text-xs text-gray-500 mb-4">Downloads a .json file to Mac, Windows, Linux, iPhone or Android.</p>
          <button onClick={() => handleLocalExport(false)} disabled={!!exporting} className="btn-primary w-full mb-2">{exporting === 'local' ? '⏳ Preparing...' : '⬇️ Download Full Backup'}</button>
          <button onClick={() => setShowSelectiveModal(true)} className="btn-secondary w-full mb-3 text-sm">📦 Selective Backup</button>
          <div className="flex gap-2">
            <button onClick={handleCopyJson} className="btn-secondary flex-1 text-xs">📋 Copy JSON</button>
            <button onClick={handleMobileShare} className="btn-secondary flex-1 text-xs">📱 Mobile Share</button>
          </div>
        </div>
        <div className="card">
          <h2 className="font-semibold text-gray-900 mb-1">📤 Import & Restore</h2>
          <p className="text-xs text-gray-500 mb-4">Restore from any .json backup file.</p>
          <input ref={fileRef} type="file" accept=".json,application/json" onChange={handleFileSelect} className="hidden" />
          <input ref={selectiveRestoreRef} type="file" accept=".json,application/json" onChange={handleSelectiveRestoreFileSelect} className="hidden" />
          <button onClick={() => fileRef.current?.click()} className="btn-warning w-full mb-2">📂 Choose Backup File (.json)</button>
          <button onClick={() => selectiveRestoreRef.current?.click()} className="btn-secondary w-full mb-3 text-sm">📦 Selective Restore</button>
          <div className="p-3 bg-blue-50 rounded-xl border border-blue-100 space-y-2">
            <p className="text-xs text-blue-800 font-semibold">Two import modes:</p>
            <p className="text-xs text-blue-700"><strong>➕ Merge</strong> — Adds new records, keeps existing data.</p>
            <p className="text-xs text-blue-700"><strong>🔄 Replace All</strong> — Deletes everything and restores from backup.</p>
          </div>
        </div>
      </div>

      {/* ── Selective Backup Modal (local) ── */}
      {/* ── Server Deletions Review Modal (v71.5, hardened v73.40) ─────────────
          Shown whenever a record on this device matches a server-side
          deletion — either because Pull & Merge noticed a previously-known
          server record is now missing (the original v71.5 detection), or
          because Push & Sync checked the server's tombstone list before
          sending and found this device still holds a record that was
          explicitly deleted elsewhere (v73.40 — closes the gap where only
          Pull was deletion-aware and a push could silently resurrect a
          deleted record). Same dialog, same Keep/Delete choice either way —
          the app never auto-deletes anything; the user always decides. */}
      {pendingServerDeletions.length > 0 && (
        <div className="modal-overlay">
          <div className="modal-content max-w-md p-6">
            <h2 className="text-lg font-bold text-gray-900 mb-1">🗑️ Records removed on the server</h2>
            <p className="text-sm text-gray-500 mb-4">
              {pendingServerDeletions.length} record{pendingServerDeletions.length === 1 ? '' : 's'} previously on the server {pendingServerDeletions.length === 1 ? 'is' : 'are'} no longer there — likely deleted on the host-server or by another device.
              Choose <strong>Delete</strong> to remove it here too, or <strong>Keep</strong> to hang onto your copy (then Push & Sync to restore it on the server).
            </p>
            <div className="space-y-3 mb-4 max-h-80 overflow-y-auto">
              {Object.entries(
                pendingServerDeletions.reduce<Record<string, typeof pendingServerDeletions>>((acc, c) => {
                  (acc[c.collection] ||= []).push(c);
                  return acc;
                }, {})
              ).map(([col, items]) => (
                <div key={col} className="border rounded-xl overflow-hidden">
                  <div className="px-3 py-1.5 bg-gray-50 text-xs font-bold text-gray-600 flex items-center gap-1.5">
                    <span>{KNOWN_META[col]?.icon || '📦'}</span>
                    <span>{KNOWN_META[col]?.label || humanizeKey(col)}</span>
                  </div>
                  {items.map(c => {
                    const key = `${c.collection}:${c.id}`;
                    const choice = deletionChoices[key] || 'keep';
                    return (
                      <div key={key} className="flex items-center justify-between px-3 py-2 border-t text-sm">
                        <span className="truncate mr-2 text-gray-800">{c.label}</span>
                        <div className="flex gap-1 shrink-0">
                          <button
                            onClick={() => setDeletionChoices(p => ({ ...p, [key]: 'keep' }))}
                            className={`px-2.5 py-1 rounded-lg text-xs font-semibold border ${choice === 'keep' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'}`}>
                            Keep
                          </button>
                          <button
                            onClick={() => setDeletionChoices(p => ({ ...p, [key]: 'delete' }))}
                            className={`px-2.5 py-1 rounded-lg text-xs font-semibold border ${choice === 'delete' ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'}`}>
                            Delete
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="flex gap-2 mb-2">
              <button
                onClick={() => setDeletionChoices(Object.fromEntries(pendingServerDeletions.map(c => [`${c.collection}:${c.id}`, 'keep'])))}
                className="btn-secondary flex-1 text-xs">Keep All</button>
              <button
                onClick={() => setDeletionChoices(Object.fromEntries(pendingServerDeletions.map(c => [`${c.collection}:${c.id}`, 'delete'])))}
                className="btn-secondary flex-1 text-xs">Delete All</button>
            </div>
            <button
              disabled={applyingDeletions}
              onClick={async () => {
                setApplyingDeletions(true);
                try {
                  const actions = pendingServerDeletions.map(c => ({
                    collection: c.collection,
                    id: c.id,
                    action: deletionChoices[`${c.collection}:${c.id}`] || 'keep',
                  }));
                  const err = await resolveServerDeletions(actions);
                  if (err) alert(`Some records couldn't be restored: ${err}\n\nThey'll be shown again next sync — check your connection to the sync server and try again.`);
                } finally {
                  setApplyingDeletions(false);
                }
              }}
              className="btn-primary w-full">
              {applyingDeletions ? '⏳ Applying…' : '✅ Apply'}
            </button>
          </div>
        </div>
      )}

      {showSelectiveModal && (
        <div className="modal-overlay" onClick={() => !exporting && setShowSelectiveModal(false)}>
          <div className="modal-content max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-1">📦 Selective Backup</h2>
            <p className="text-sm text-gray-500 mb-4">Choose which sections to include in the download:</p>
            <div className="space-y-1.5 mb-4 max-h-72 overflow-y-auto">
              {dataStats.map(s => (
                <label key={s.key} className="flex items-center justify-between p-2.5 rounded-xl cursor-pointer transition bg-gray-50 hover:bg-gray-100">
                  <div className="flex items-center gap-2.5">
                    <input type="checkbox" checked={!!selectiveKeys[s.key]}
                      onChange={() => setSelectiveKeys(p => ({ ...p, [s.key]: !p[s.key] }))}
                      className="w-4 h-4 rounded accent-indigo-600" />
                    <span className="text-sm font-medium">{s.icon} {s.label}</span>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded-full border font-medium bg-white text-gray-500">{s.count}</span>
                </label>
              ))}
            </div>
            <div className="flex gap-2 mb-2">
              <button onClick={() => setSelectiveKeys(Object.fromEntries(dataStats.map(s => [s.key, true])))} className="btn-secondary flex-1 text-xs">Select All</button>
              <button onClick={() => setSelectiveKeys(p => { const next = { ...p }; Object.keys(next).forEach(k => next[k] = false); return next; })} className="btn-secondary flex-1 text-xs">Select None</button>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setShowSelectiveModal(false)} disabled={!!exporting} className="btn-secondary flex-1">Cancel</button>
              <button
                onClick={() => { handleLocalExport(true); setShowSelectiveModal(false); }}
                disabled={!!exporting || !Object.values(selectiveKeys).some(Boolean)}
                className={`flex-1 py-2.5 rounded-xl font-bold text-sm text-white transition bg-indigo-600 hover:bg-indigo-700 ${exporting ? 'opacity-50 cursor-wait' : ''}`}>
                {exporting === 'selective' ? '⏳ Preparing…' : '⬇️ Download Selected'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Selective Restore Modal (local) ── */}
      {showSelectiveRestoreModal && selectiveRestorePreview && (
        <div className="modal-overlay" onClick={() => !selectiveRestoring && setShowSelectiveRestoreModal(false)}>
          <div className="modal-content max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-1">📦 Selective Restore</h2>
            <p className="text-sm text-gray-500 mb-4">Choose which sections to restore from the backup:</p>
            <div className="space-y-1.5 mb-4 max-h-72 overflow-y-auto">
              {statsFor(selectiveRestorePreview as unknown as Record<string, unknown>).map(s => {
                const count = s.count;
                return (
                  <label key={s.key} className={`flex items-center justify-between p-2.5 rounded-xl cursor-pointer transition ${count === 0 ? 'opacity-40 pointer-events-none bg-gray-50' : 'bg-gray-50 hover:bg-gray-100'}`}>
                    <div className="flex items-center gap-2.5">
                      <input type="checkbox" checked={!!selectiveRestoreKeys[s.key]} disabled={count === 0}
                        onChange={() => setSelectiveRestoreKeys(p => ({ ...p, [s.key]: !p[s.key] }))}
                        className="w-4 h-4 rounded accent-indigo-600" />
                      <span className="text-sm font-medium">{s.icon} {s.label}</span>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${count > 0 ? 'bg-white text-gray-500' : 'bg-gray-100 text-gray-300'}`}>{count}</span>
                  </label>
                );
              })}
            </div>
            <p className="text-sm font-semibold text-gray-700 mb-2">Restore mode:</p>
            <div className="grid grid-cols-2 gap-2 mb-4">
              <button onClick={() => setSelectiveRestoreMode('merge')} className={`p-2.5 rounded-xl border-2 text-left transition-all ${selectiveRestoreMode === 'merge' ? 'border-emerald-500 bg-emerald-50' : 'border-gray-200 hover:border-gray-300'}`}>
                <div className="font-bold text-sm text-gray-900">➕ Merge</div>
                <p className="text-xs text-gray-500 mt-0.5">Adds new records only</p>
              </button>
              <button onClick={() => setSelectiveRestoreMode('replace')} className={`p-2.5 rounded-xl border-2 text-left transition-all ${selectiveRestoreMode === 'replace' ? 'border-red-500 bg-red-50' : 'border-gray-200 hover:border-gray-300'}`}>
                <div className="font-bold text-sm text-gray-900">🔄 Replace Sections</div>
                <p className="text-xs text-gray-500 mt-0.5">Overwrites chosen sections</p>
              </button>
            </div>
            {selectiveRestoreMode === 'replace' && (
              <div className="p-2.5 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700 mb-3">
                ⚠️ <strong>Warning:</strong> Ticked sections will be replaced with backup data.
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={() => setShowSelectiveRestoreModal(false)} disabled={selectiveRestoring} className="btn-secondary flex-1">Cancel</button>
              <button onClick={handleSelectiveRestore} disabled={selectiveRestoring || !Object.values(selectiveRestoreKeys).some(Boolean)}
                className={`flex-1 py-2.5 rounded-xl font-bold text-sm text-white transition ${selectiveRestoreMode === 'replace' ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'} ${selectiveRestoring ? 'opacity-50 cursor-wait' : ''}`}>
                {selectiveRestoring ? '⏳ Restoring…' : selectiveRestoreMode === 'replace' ? '🔄 Restore Selected' : '➕ Merge Selected'}
              </button>
            </div>
          </div>
        </div>
      )}

      {importPreview && (
        <div className="modal-overlay" onClick={() => !importing && setImportPreview(null)}>
          <div className="modal-content max-w-md p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-2">📤 Import Backup</h2>
            <p className="text-sm text-gray-600 mb-3">This backup contains:</p>
            <div className="grid grid-cols-3 gap-2 mb-5">
              {statsFor(importPreview as unknown as Record<string, unknown>).map(s => (
                <div key={s.key} className="p-2.5 bg-gray-50 rounded-xl text-center">
                  <div className="text-lg">{s.icon}</div>
                  <div className="font-bold text-gray-900">{s.count}</div>
                  <div className="text-xs text-gray-500">{s.label}</div>
                </div>
              ))}
            </div>
            <p className="text-sm font-semibold text-gray-700 mb-3">Choose import mode:</p>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <button onClick={() => setMergeMode('merge')} className={`p-3 rounded-xl border-2 text-left transition-all ${mergeMode === 'merge' ? 'border-emerald-500 bg-emerald-50' : 'border-gray-200 hover:border-gray-300'}`}><div className="font-bold text-sm text-gray-900">➕ Merge</div><p className="text-xs text-gray-500 mt-1">Adds new records, keeps existing data</p></button>
              <button onClick={() => setMergeMode('replace')} className={`p-3 rounded-xl border-2 text-left transition-all ${mergeMode === 'replace' ? 'border-red-500 bg-red-50' : 'border-gray-200 hover:border-gray-300'}`}><div className="font-bold text-sm text-gray-900">🔄 Replace All</div><p className="text-xs text-gray-500 mt-1">Overwrites ALL data with backup</p></button>
            </div>
            {mergeMode === 'replace' && <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 mb-4">⚠️ <strong>Warning:</strong> This deletes all current data!</div>}
            <div className="flex gap-2">
              <button onClick={() => setImportPreview(null)} disabled={importing} className="btn-secondary flex-1">Cancel</button>
              <button onClick={handleImport} disabled={importing} className={`flex-1 py-2.5 rounded-xl font-bold text-sm text-white ${mergeMode === 'replace' ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'} ${importing ? 'opacity-50 cursor-wait' : ''}`}>{importing ? '⏳ Importing...' : mergeMode === 'replace' ? '🔄 Replace All' : '➕ Merge Data'}</button>
            </div>
          </div>
        </div>
      )}

      {/* v73.92 — Craig: "no way to import a backup to the server anymore or
          to send a backup from the app." Confirmed: real bug, not a
          misunderstanding. This entire card — server disk usage, download-
          from-server, send/import-to-server, and the server backup list
          with restore/download/delete — had complete, working handler
          functions (handleServerExport, handleServerImportFile/Confirm,
          fetchServerBackups, handleRestoreFromServerBackup,
          handleDownloadServerBackup, handleDeleteServerBackup) sitting
          unused: no JSX ever rendered the buttons/inputs that call them,
          and the confirm dialog for a full server restore (below) was
          unreachable with nothing to open it. Rebuilding the missing card
          here, wired to the pre-existing (untouched) handlers — this is
          new rendering only, no handler logic changed. */}
      <div className="card">
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-semibold text-gray-900">🖥️ Server Backup</h2>
          {serverDisk && (
            <span className="text-xs text-gray-400" title={serverDiskAt ? `Checked ${serverDiskAt.toLocaleTimeString()}` : undefined}>
              {formatFileBytes(serverDisk.available)} free of {formatFileBytes(serverDisk.total)}
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500 mb-4">Back up or restore the host-server's data directly — separate from the on-device backups above.</p>

        <input ref={serverImportRef} type="file" accept=".json,application/json" onChange={handleServerImportFile} className="hidden" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
          <button onClick={handleServerExport} disabled={!syncServerUrl || serverExporting} className="btn-secondary w-full text-sm disabled:opacity-40 disabled:cursor-not-allowed">{serverExporting ? '⏳ Downloading...' : '⬇️ Download Server Backup'}</button>
          <button onClick={() => serverImportRef.current?.click()} disabled={!syncServerUrl || serverImporting} className="btn-warning w-full text-sm disabled:opacity-40 disabled:cursor-not-allowed">{serverImporting ? '⏳ Restoring...' : '📤 Send Backup to Server'}</button>
        </div>
        {!syncServerUrl && <p className="text-xs text-amber-600 mb-2">Set up a Sync Server above first.</p>}
        {serverExportMsg && <p className="text-xs text-gray-600 mb-2">{serverExportMsg}</p>}
        {serverImportMsg && <p className="text-xs text-gray-600 mb-3">{serverImportMsg}</p>}

        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-gray-700">Backups stored on the server</p>
          <button onClick={fetchServerBackups} disabled={!syncServerUrl || serverBackupsLoading} className="text-xs text-indigo-600 hover:text-indigo-800 disabled:opacity-40 disabled:cursor-not-allowed">{serverBackupsLoading ? '⏳ Loading...' : '🔄 Refresh'}</button>
        </div>
        {serverBackupsMsg && <p className="text-xs text-gray-500 mb-2">{serverBackupsMsg}</p>}
        {serverBackupList.length > 0 && (
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {serverBackupList.map(b => (
              <div key={b.filename} className="flex items-center justify-between gap-2 p-2 bg-gray-50 rounded-lg text-xs">
                <div className="min-w-0">
                  <div className="font-mono text-gray-800 truncate" title={b.filename}>{b.filename}</div>
                  <div className="text-gray-400">{formatFileBytes(b.size)} · {new Date(b.created).toLocaleString()}{b.manifest?.totalRecords ? ` · ${b.manifest.totalRecords} records` : ''}</div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button onClick={() => handleDownloadServerBackup(b.filename)} title="Download this backup" className="px-2 py-1 rounded bg-white border border-gray-200 hover:bg-gray-100">⬇️</button>
                  <button onClick={() => setRestoreBackupConfirm(b.filename)} disabled={restoringBackup === b.filename} title="Restore server data from this backup" className="px-2 py-1 rounded bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 disabled:opacity-40">{restoringBackup === b.filename ? '⏳' : '↺'}</button>
                  <button onClick={() => handleDeleteServerBackup(b.filename)} disabled={deletingBackup === b.filename} title="Delete this backup from the server" className="px-2 py-1 rounded bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 disabled:opacity-40">{deletingBackup === b.filename ? '⏳' : '🗑️'}</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Server full restore confirm dialog */}
      {serverImportConfirm && (
        <div className="modal-overlay" onClick={() => setServerImportConfirm(false)}>
          <div className="modal-content max-w-md p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-2">🖥️ Full Restore to Server</h2>
            <p className="text-sm text-gray-600 mb-1">File: <span className="font-mono text-xs text-indigo-700">{serverImportName}</span></p>
            <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 my-4">
              ⚠️ <strong>This replaces ALL data on the server</strong> with the contents of the selected file. A pre-restore backup is saved automatically on the server.
            </div>
            <div className="flex gap-2">
              <button onClick={() => setServerImportConfirm(false)} className="btn-secondary flex-1">Cancel</button>
              <button onClick={handleServerImportConfirm} className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white bg-red-600 hover:bg-red-700 transition">🔄 Restore Server</button>
            </div>
          </div>
        </div>
      )}

      {/* v73.92 — restore-from-existing-server-backup confirm dialog. The
          handler (handleRestoreFromServerBackup) already existed; this
          dialog didn't, so there was no way to trigger it either. */}
      {restoreBackupConfirm && (
        <div className="modal-overlay" onClick={() => setRestoreBackupConfirm('')}>
          <div className="modal-content max-w-md p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-2">↺ Restore Server From Backup</h2>
            <p className="text-sm text-gray-600 mb-1">File: <span className="font-mono text-xs text-indigo-700">{restoreBackupConfirm}</span></p>
            <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 my-4">
              ⚠️ <strong>This replaces ALL data on the server</strong> with the contents of this backup. A pre-restore safety backup is saved automatically first.
            </div>
            <div className="flex gap-2">
              <button onClick={() => setRestoreBackupConfirm('')} className="btn-secondary flex-1">Cancel</button>
              <button onClick={() => handleRestoreFromServerBackup(restoreBackupConfirm)} className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white bg-red-600 hover:bg-red-700 transition">↺ Restore</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
