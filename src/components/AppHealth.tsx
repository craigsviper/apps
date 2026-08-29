import { useState, useEffect, useCallback } from 'react';
import { useStore, getLocalTombstones, pruneLocalTombstones } from '../store';
import { logEvent } from '../logger';

// v73.48 — Craig: "need a Health menu for the app as the one that in the app
// side menu is for the host-server." The existing Health.tsx (still mounted
// at the 'health' page) reports the SERVER's health — disk, backups, server
// tombstones. It never told you anything about THIS device: how much is
// stored locally, whether IndexedDB actually loaded, or how stale the local
// copy is relative to the last successful sync. This is that missing
// device-side page — no server call required to show most of it, since the
// whole point is it should still say something useful when the sync server
// is unreachable or unconfigured.

const fmtBytes = (b: number) => {
  if (!Number.isFinite(b) || b < 0) return '—';
  return b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : (b / 1e3).toFixed(0) + ' KB';
};

const COLLECTION_LABELS: Record<string, string> = {
  users: 'Users', clients: 'Clients', inspections: 'Inspections', maps: 'Maps',
  categories: 'Categories', reports: 'Reports', coverTemplates: 'Cover Templates',
  sweepAreas: 'Sweep Areas', sweepRoads: 'Sweep Roads', sweepZones: 'Sweep Zones',
  sweepJobs: 'Sweep Jobs', sweepClients: 'Sweep Clients', sweepJobSites: 'Job Sites',
  sweepFiles: 'Sweep Files', sweepCategories: 'Sweep Categories', sweepMaps: 'Sweep Maps',
  sweepReports: 'Sweep Reports',
};

function timeAgo(iso: string): string {
  if (!iso) return 'Never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return new Date(iso).toLocaleString();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function AppHealth() {
  const { data, lastSyncAt, syncStatus, syncError, syncServerUrl, pendingServerDeletions } = useStore();
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [storageErr, setStorageErr] = useState('');
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [tombstones, setTombstones] = useState(() => getLocalTombstones());
  const [pruneDays, setPruneDays] = useState(90);
  const [pruneMsg, setPruneMsg] = useState('');

  const loadStorage = useCallback(async () => {
    try {
      if (navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        setStorage({ usage: est.usage || 0, quota: est.quota || 0 });
      } else {
        setStorageErr('Storage estimate API not available in this browser.');
      }
      if (navigator.storage?.persisted) {
        setPersisted(await navigator.storage.persisted());
      }
    } catch (e) {
      setStorageErr(e instanceof Error ? e.message : 'Failed to read storage estimate');
    }
  }, []);

  useEffect(() => { loadStorage(); }, [loadStorage]);

  const pruneTombstones = () => {
    const days = Math.max(0, Math.round(pruneDays) || 0);
    const confirmMsg = days === 0
      ? 'Delete every local tombstone entry, regardless of age? This only affects THIS device\'s "don\'t resurrect" list — it does not touch the sync server or any actual app data. A record cleared here could reappear from the server on the next sync if it still exists there.'
      : `Delete local tombstone entries older than ${days} day${days !== 1 ? 's' : ''}? This only affects this device's local list — no app data or server data is touched.`;
    if (!confirm(confirmMsg)) return;
    const result = pruneLocalTombstones(days);
    setTombstones(getLocalTombstones());
    setPruneMsg(result.removedCount > 0
      ? `🧹 Pruned ${result.removedCount} local tombstone${result.removedCount !== 1 ? 's' : ''} (${result.removedCount + result.remaining} → ${result.remaining})`
      : 'No local tombstones matched — nothing pruned.');
    logEvent('info', `Pruned local tombstones (older than ${days}d): ${result.removedCount} removed`);
    setTimeout(() => setPruneMsg(''), 6000);
  };

  const collections = Object.keys(COLLECTION_LABELS) as (keyof typeof data)[];
  const totalRecords = collections.reduce((sum, k) => {
    const arr = data[k];
    return sum + (Array.isArray(arr) ? arr.length : 0);
  }, 0);

  const approxDataSize = (() => {
    try { return new Blob([JSON.stringify(data)]).size; } catch { return null; }
  })();

  const pct = storage && storage.quota > 0 ? Math.min(100, Math.round((storage.usage / storage.quota) * 100)) : null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">📱 App Health</h1>
        <p className="text-sm text-gray-500 mt-1">This device — local data, storage, and sync status. For the sync server itself, see the Health page.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div className="card p-4">
          <h2 className="font-semibold text-gray-800 mb-3">Local Database</h2>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between"><span className="text-gray-500">Status</span>
              <span className="text-emerald-600 font-medium">✅ Ready</span>
            </div>
            <div className="flex justify-between"><span className="text-gray-500">Total records</span><span className="font-medium">{totalRecords.toLocaleString()}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Approx. data size</span><span className="font-medium">{approxDataSize !== null ? fmtBytes(approxDataSize) : '—'}</span></div>
          </div>
        </div>

        <div className="card p-4">
          <h2 className="font-semibold text-gray-800 mb-3">Device Storage</h2>
          {storageErr ? (
            <p className="text-sm text-amber-600">{storageErr}</p>
          ) : storage ? (
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between"><span className="text-gray-500">Used</span><span className="font-medium">{fmtBytes(storage.usage)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Quota</span><span className="font-medium">{fmtBytes(storage.quota)}</span></div>
              {pct !== null && (
                <div className="pt-1">
                  <div className="w-full bg-gray-100 rounded-full h-2">
                    <div className={`h-2 rounded-full ${pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="text-xs text-gray-400 mt-1">{pct}% of quota used</div>
                </div>
              )}
              <div className="flex justify-between pt-1"><span className="text-gray-500">Persisted storage</span>
                <span className="font-medium">{persisted === null ? '—' : persisted ? '✅ Yes' : '⚠️ No'}</span>
              </div>
              {persisted === false && (
                <p className="text-xs text-amber-600 mt-1">Not marked persistent — the browser may evict local data under storage pressure. Sync regularly as a precaution.</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-400">Loading…</p>
          )}
        </div>

        <div className="card p-4">
          <h2 className="font-semibold text-gray-800 mb-3">Sync Status</h2>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between"><span className="text-gray-500">Sync server</span><span className="font-medium">{syncServerUrl ? '✅ Configured' : '⚠️ Not set'}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Last sync</span><span className="font-medium">{lastSyncAt ? timeAgo(lastSyncAt) : 'Never'}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Last result</span>
              <span className={`font-medium ${syncStatus === 'error' ? 'text-red-600' : syncStatus === 'success' ? 'text-emerald-600' : 'text-gray-600'}`}>
                {syncStatus === 'idle' ? '—' : syncStatus}
              </span>
            </div>
            {syncError && <div className="text-xs text-red-600 pt-1">{syncError}</div>}
            <div className="flex justify-between pt-1"><span className="text-gray-500">Pending deletion review</span>
              <span className={`font-medium ${pendingServerDeletions.length > 0 ? 'text-amber-600' : 'text-gray-600'}`}>{pendingServerDeletions.length}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card p-4">
        <h2 className="font-semibold text-gray-800 mb-3">Records by Collection</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 text-sm">
          {collections.map(k => {
            const arr = data[k];
            const count = Array.isArray(arr) ? arr.length : 0;
            return (
              <div key={String(k)} className="flex justify-between border-b border-gray-100 py-1">
                <span className="text-gray-500">{COLLECTION_LABELS[k as string]}</span>
                <span className="font-medium">{count}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="card p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold text-gray-800">🪦 Local Tombstones</h2>
          <span className="text-xs text-gray-400">{tombstones.length} on this device</span>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Records this device has deleted. Kept independently of the sync server so a record
          deleted here can never silently reappear on this device — even if the server's own
          tombstone gets reset (e.g. by a host-server rebuild) or another device restores it.
        </p>
        {tombstones.length > 0 && (
          <div className="max-h-40 overflow-y-auto border border-gray-100 rounded-lg mb-3 text-xs divide-y divide-gray-100">
            {tombstones.slice(0, 100).map(t => (
              <div key={`${t.collection}:${t.id}`} className="flex justify-between px-2 py-1">
                <span className="text-gray-600 truncate pr-2">{COLLECTION_LABELS[t.collection] || t.collection}: {t.label}</span>
                <span className="text-gray-400 shrink-0">{new Date(t.deletedAt).toLocaleDateString()}</span>
              </div>
            ))}
            {tombstones.length > 100 && <div className="px-2 py-1 text-gray-400">…and {tombstones.length - 100} more</div>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="local-tombstone-prune-days" className="text-xs text-gray-500">Delete tombstones older than</label>
          <input id="local-tombstone-prune-days" type="number" min={0} value={pruneDays} onChange={e => setPruneDays(Number(e.target.value))}
            className="w-20 border border-gray-300 rounded-lg px-2 py-1 text-sm" />
          <span className="text-xs text-gray-500">days (0 = delete all)</span>
          <button onClick={pruneTombstones} className="btn-secondary text-xs ml-auto">🧹 Prune</button>
        </div>
        {pruneMsg && <div className="text-xs text-emerald-600 mt-2">{pruneMsg}</div>}
      </div>
    </div>
  );
}
