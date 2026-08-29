import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useStore } from '../store';
import { downloadFile } from '../utils/download';
import { localDateKey } from '../utils/date';
import { generateMultiPointGpsMap } from '../utils/mapSnapshot';
import type { Report, Inspection, CoverPage, CoverTemplate } from '../types';
// BUG FIX (Craig-reported, v73.2): v72.6 fixed the report's GPS maps failing
// to load Leaflet at all when opened outside the live app by vendoring
// Leaflet's JS/CSS/icons and inlining them into every report's <head> instead
// of loading them from an external URL. That fixed "the map never appears"
// — but a second, separate problem surfaced once maps DID start loading in
// that context: a report opened as a local file:// document (as every
// downloaded report is) sends no HTTP referrer at all when Leaflet then goes
// on to fetch OpenStreetMap's live tiles. OSM's own tile usage policy
// requires a referrer and rejects requests without one — Firefox enforces
// this correctly and shows OSM's actual "Access blocked" tile image tiled
// across the whole map; Chrome happens to be more lenient about what it
// sends for file:// pages, which is why Craig only saw this on Firefox.
// There is no code-level fix for a file:// page having no referrer — this
// was confirmed against OSM's own documentation. OSM's own suggested
// workaround for exactly this situation: don't embed a live, tile-fetching
// map in a document that might be opened offline/referrerless — render a
// static image instead. GPS maps are now pre-rendered to a JPEG data URL
// *while the live app is open* (a real https:// page, so the tiles load
// normally) via generateMultiPointGpsMap() in utils/mapSnapshot.ts, and
// embedded as a plain <img> — see precomputeStaticMaps()/staticMapCache
// below. This also means Leaflet's JS/CSS no longer need to be inlined into
// every report at all (nothing in the exported file uses it anymore),
// so the vendored-Leaflet imports that used to sit here have been removed —
// smaller report files, one less thing that can go wrong on the way out.

// Default logo — the app icon used when no custom logo has been uploaded.
// Embedded as base64 so it works in both the live preview AND downloaded HTML reports.
const DEFAULT_LOGO_DATA = 'data:image/png;base64,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';

const emptyCover = (): CoverPage => ({
  companyName: 'Unicus',
  companyTagline: 'Expert In Road Sweeping, Cleaning And Hydro Excavating',
  companyAddress: '',
  companyPhone: '',
  companyEmail: '',
  reportTitle: '',
  reportSubtitle: '',
  preparedBy: '',
  preparedFor: '',
  reportDate: localDateKey(),
  reportNumber: `RPT-${Date.now().toString().slice(-6)}`,
  coverNotes: '',
  primaryColor: '#1e3a5f',
  headerTextColor: '#ffffff',
  titleTextColor: '#1e3a5f',
  bodyTextColor: '#1e293b',
  accentTextColor: '#64748b',
  showLogo: true,
  logoData: '',
  reportTypeLabel: 'Road & Storm Water Inspection',
  titleFontSize: 30,
  subtitleFontSize: 16,
  bodyFontSize: 13,
  accentFontSize: 10,
  headerFontSize: 20,
  taglineFontSize: 14,
  logoSize: 80,
  coverBodyText: '',
});

const emptyReport = (): Omit<Report, 'id' | 'createdAt' | 'updatedAt'> => ({
  title: '', date: localDateKey(), inspectionIds: [],
  clientId: '', createdBy: '', categories: [], includePhotos: true,
  includeComments: true, includeMaps: true, detailLevel: 'standard',
  status: 'draft', notes: '',
});

export default function Reports() {
  const { data, currentUser, addReport, updateReport, deleteReport, addCoverTemplate, updateCoverTemplate, deleteCoverTemplate } = useStore();
  const [view, setView] = useState<'list' | 'form' | 'preview'>('list');
  const [editingReport, setEditingReport] = useState<Report | null>(null);
  const [form, setForm] = useState(emptyReport());
  const [cover, setCover] = useState<CoverPage>(emptyCover());
  const [coverTab, setCoverTab] = useState<'report' | 'cover' | 'options' | 'inspections' | 'preview'>('report');
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [saveTplForm, setSaveTplForm] = useState({ name: '', description: '', clientId: '' });
  const [previewReport, setPreviewReport] = useState<Report | null>(null);
  // v73.2 — pre-rendered GPS map images (data URLs), keyed by groupMapKey()/overviewKey() (v73.120: one map per location group, not per photo).
  // `undefined` (key absent) = not yet generated (shows a "Generating…" placeholder,
  // only ever visible transiently in the live in-app preview). `null` = generation
  // was attempted and failed (e.g. offline) — shows an explicit "unavailable" note.
  // See precomputeStaticMaps() below and the big comment above buildPhotoGpsMapStatic.
  const [staticMapCache, setStaticMapCache] = useState<Map<string, string | null>>(new Map());
  const [previewCover, setPreviewCover] = useState<CoverPage>(emptyCover());
  const [search, setSearch] = useState('');
  const [saveMsg, setSaveMsg] = useState('');
  const [downloadMenuId, setDownloadMenuId] = useState<string | null>(null);
  const [pdfGenerating, setPdfGenerating] = useState(false);
  const [livePreviewHtml, setLivePreviewHtml] = useState('');
  const downloadMenuRef = useRef<HTMLDivElement | null>(null);
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const inspTypes = data.categories.find(c => c.type === 'inspection_type')?.items || [];

  useEffect(() => {
    if (!downloadMenuId) return;
    const handler = (e: MouseEvent) => {
      if (downloadMenuRef.current && !downloadMenuRef.current.contains(e.target as Node)) {
        setDownloadMenuId(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [downloadMenuId]);

  const openNew = () => {
    const newCover = emptyCover();
    newCover.preparedBy = currentUser?.name || '';
    setForm({ ...emptyReport(), createdBy: currentUser?.name || '' });
    setCover(newCover);
    setEditingReport(null);
    setCoverTab('report');
    setView('form');
  };

  const openEdit = (r: Report) => {
    setEditingReport(r);
    // Strip stale IDs — inspections deleted since this report was saved
    // would otherwise ghost as counted-but-invisible in the selection list
    const validInspectionIds = (r.inspectionIds || []).filter(id =>
      data.inspections.some(ins => ins.id === id)
    );
    setForm({
      title: r.title, date: r.date, inspectionIds: validInspectionIds,
      clientId: r.clientId, createdBy: r.createdBy, categories: [...r.categories],
      includePhotos: r.includePhotos, includeComments: r.includeComments,
      includeMaps: r.includeMaps, detailLevel: r.detailLevel,
      status: r.status, notes: r.notes,
    } as Omit<Report, 'id' | 'createdAt' | 'updatedAt'>);
    const savedCover = r.coverPage;
    setCover(savedCover || { ...emptyCover(), preparedBy: r.createdBy, reportTitle: r.title, reportDate: r.date });
    setCoverTab('report');
    setView('form');
  };

  const handleSave = (overrideStatus?: Report['status']) => {
    const baseForm = overrideStatus ? { ...form, status: overrideStatus } : form;
    // Strip any stale IDs that may have crept in before persisting
    const finalForm = {
      ...baseForm,
      inspectionIds: baseForm.inspectionIds.filter(id => data.inspections.some(ins => ins.id === id)),
    };
    if (!finalForm.title.trim()) {
      setSaveMsg('⚠️ Report title is required'); setTimeout(() => setSaveMsg(''), 3000); return;
    }
    if (finalForm.inspectionIds.length === 0) {
      setSaveMsg('⚠️ Select at least one inspection'); setTimeout(() => setSaveMsg(''), 3000); return;
    }
    const reportData = { ...finalForm, coverPage: cover };
    if (editingReport) {
      updateReport({ ...editingReport, ...reportData });
      setSaveMsg('✅ Report saved');
      setTimeout(() => setSaveMsg(''), 3000);
    } else {
      // Stay in edit mode — switch to editing the newly created report
      const created = addReport(reportData);
      setEditingReport(created);
      setSaveMsg('✅ Report created — keep editing or go back when done');
      setTimeout(() => setSaveMsg(''), 4000);
    }
    // Do NOT navigate away — user stays on the form
  };

  const toggleInspection = (id: string) => {
    setForm(prev => ({
      ...prev,
      inspectionIds: prev.inspectionIds.includes(id)
        ? prev.inspectionIds.filter(i => i !== id)
        : [...prev.inspectionIds, id]
    }));
  };

  const toggleCategory = (name: string) => {
    setForm(prev => ({
      ...prev,
      categories: prev.categories.includes(name)
        ? prev.categories.filter(c => c !== name)
        : [...prev.categories, name]
    }));
  };

  const [inspSearch, setInspSearch] = useState('');

  const selectAllInspections = () => {
    setForm(prev => ({ ...prev, inspectionIds: getFilteredInspections().map(i => i.id) }));
  };

  // useMemo: recomputes whenever inspections list, categories filter, or search text changes.
  // Previously a plain function — newly added inspections were invisible until
  // the filter/search state changed to force a re-run.
  const filteredInspectionsMemo = useMemo(() => {
    let ins = [...(data.inspections || [])];
    ins.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (form.categories.length > 0) ins = ins.filter(i => form.categories.includes(i.type));
    if (inspSearch.trim()) {
      const q = inspSearch.toLowerCase();
      ins = ins.filter(i =>
        i.title.toLowerCase().includes(q) ||
        i.location.toLowerCase().includes(q) ||
        i.type.toLowerCase().includes(q)
      );
    }
    return ins;
  }, [data.inspections, form.categories, inspSearch]);
  const getFilteredInspections = () => filteredInspectionsMemo;

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setCover(prev => ({ ...prev, logoData: ev.target?.result as string }));
    reader.readAsDataURL(file);
  };

  // ─── Cover Page HTML ──────────────────────────────────────────────────────
  const generateCoverHTML = useCallback((cv: CoverPage, rpt: Report | Omit<Report, 'id' | 'createdAt'> & { id?: string; createdAt?: string }) => {
    const client = data.clients.find(c => c.id === rpt.clientId);
    const inspections = data.inspections.filter(i => rpt.inspectionIds.includes(i.id));
    const totalPhotos = inspections.reduce((a, i) => a + i.photos.length, 0);
    const totalComments = inspections.reduce((a, i) => a + i.comments.length, 0);
    const primary = cv.primaryColor || '#1e3a5f';
    const headerTxt = cv.headerTextColor || '#ffffff';
    const titleTxt = cv.titleTextColor || primary;
    const bodyTxt = cv.bodyTextColor || '#1e293b';
    const accentTxt = cv.accentTextColor || '#64748b';

    // Derive solid-colour fallbacks for alpha hex codes (print-safe)
    const primaryLight = '#eef2f7';   // replaces ${primary}08 / ${primary}18
    const primaryBorder = '#c5d0de';  // replaces ${primary}30
    const headerTxtMuted = '#cccccc'; // replaces ${headerTxt}aa / ${headerTxt}cc

    return `
<div class="cover-wrapper" style="page-break-after:always; font-family:Arial,Helvetica,sans-serif; color:${bodyTxt};">
  <!-- top accent bar -->
  <div style="background:${primary}; height:12px; width:100%; line-height:0; font-size:0;"></div>
  <!-- header band -->
  <div style="background:${primary}; padding:28px 48px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td valign="middle" style="padding:0; width:${(cv.logoSize||80)+20}px;">
          <img src="${cv.logoData || DEFAULT_LOGO_DATA}" style="height:${cv.logoSize||80}px; width:${cv.logoSize||80}px; object-fit:contain; display:block; border-radius:10px;" alt="Logo"/>
        </td>
        <td valign="middle" align="center" style="padding:0 24px;">
          <div style="color:${headerTxt}; font-size:${cv.headerFontSize||20}px; font-weight:700; margin:0 0 4px 0;">${cv.companyName}</div>
          ${cv.companyTagline ? `<div style="color:${headerTxtMuted}; font-size:${cv.taglineFontSize||14}px; margin:0;">${cv.companyTagline}</div>` : ''}
        </td>
        <td valign="middle" align="right" style="padding:0; width:180px;">
          <div style="background:rgba(255,255,255,0.15); border:1px solid rgba(255,255,255,0.35); border-radius:8px; padding:12px 16px; display:inline-block;">
            <div style="color:${headerTxtMuted}; font-size:10px; text-transform:uppercase; letter-spacing:1px; margin-bottom:4px;">Report Number</div>
            <div style="color:${headerTxt}; font-size:15px; font-weight:700; font-family:monospace;">${('reportNumber' in cv ? cv.reportNumber : '') || ''}</div>
          </div>
        </td>
      </tr>
    </table>
  </div>
  <!-- cover body -->
  <div style="padding:36px 48px 28px; background:#fff;">
    <div style="display:inline-block; border:2px solid ${primary}; border-radius:20px; padding:5px 16px; font-size:11px; font-weight:700; color:${titleTxt}; text-transform:uppercase; letter-spacing:1.5px; margin-bottom:18px;">
      ${cv.reportTypeLabel || 'Road &amp; Storm Water Inspection'}
    </div>
    <div style="font-size:${cv.titleFontSize||30}px; font-weight:800; color:${titleTxt}; margin:0 0 8px; line-height:1.2; border-bottom:4px solid ${primary}; padding-bottom:12px;">
      ${cv.reportTitle || rpt.title}
    </div>
    ${cv.reportSubtitle ? `<div style="font-size:${cv.subtitleFontSize||16}px; color:${accentTxt}; margin:10px 0 0; font-style:italic;">${cv.reportSubtitle}</div>` : ''}
    ${cv.coverBodyText ? `<div style="font-size:${cv.bodyFontSize||13}px; color:${bodyTxt}; margin:16px 0 0; line-height:1.7; white-space:pre-wrap;">${cv.coverBodyText}</div>` : ''}
    <!-- 2x2 info grid via table -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
      <tr>
        <td width="49%" valign="top" style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:16px;">
          <div style="font-size:${cv.accentFontSize||10}px; text-transform:uppercase; letter-spacing:1px; color:${accentTxt}; margin-bottom:8px; font-weight:700;">Prepared For</div>
          <div style="font-size:${cv.bodyFontSize||16}px; font-weight:700; color:${bodyTxt};">${cv.preparedFor || (client ? client.name : '—')}</div>
          ${client?.company ? `<div style="color:${accentTxt}; font-size:12px; margin-top:3px;">${client.company}</div>` : ''}
          ${client?.email ? `<div style="color:${accentTxt}; font-size:11px; margin-top:2px;">✉ ${client.email}</div>` : ''}
        </td>
        <td width="2%" style="padding:0;"></td>
        <td width="49%" valign="top" style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:16px;">
          <div style="font-size:${cv.accentFontSize||10}px; text-transform:uppercase; letter-spacing:1px; color:${accentTxt}; margin-bottom:8px; font-weight:700;">Prepared By</div>
          <div style="font-size:${cv.bodyFontSize||16}px; font-weight:700; color:${bodyTxt};">${cv.preparedBy || rpt.createdBy}</div>
          ${cv.companyName ? `<div style="color:${accentTxt}; font-size:12px; margin-top:3px;">${cv.companyName}</div>` : ''}
          ${cv.companyEmail ? `<div style="color:${accentTxt}; font-size:11px; margin-top:2px;">✉ ${cv.companyEmail}</div>` : ''}
        </td>
      </tr>
      <tr><td colspan="3" style="height:10px;"></td></tr>
      <tr>
        <td width="49%" valign="top" style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:16px;">
          <div style="font-size:${cv.accentFontSize||10}px; text-transform:uppercase; letter-spacing:1px; color:${accentTxt}; margin-bottom:8px; font-weight:700;">Report Date</div>
          <div style="font-size:${cv.bodyFontSize||16}px; font-weight:700; color:${bodyTxt};">${new Date(cv.reportDate || rpt.date).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
          <div style="color:${accentTxt}; font-size:12px; margin-top:3px;">Detail Level: <strong>${rpt.detailLevel.charAt(0).toUpperCase() + rpt.detailLevel.slice(1)}</strong></div>
        </td>
        <td width="2%" style="padding:0;"></td>
        <td width="49%" valign="top" style="background:${primaryLight}; border:2px solid ${primaryBorder}; border-radius:10px; padding:16px;">
          <div style="font-size:${cv.accentFontSize||10}px; text-transform:uppercase; letter-spacing:1px; color:${accentTxt}; margin-bottom:8px; font-weight:700;">Report Summary</div>
          <table width="100%" cellpadding="0" cellspacing="4" border="0">
            <tr>
              <td align="center" style="background:#fff; border-radius:6px; padding:8px;">
                <div style="font-size:22px; font-weight:800; color:${titleTxt};">${inspections.length}</div>
                <div style="font-size:10px; color:${accentTxt};">Inspections</div>
              </td>
              <td align="center" style="background:#fff; border-radius:6px; padding:8px;">
                <div style="font-size:22px; font-weight:800; color:${titleTxt};">${totalPhotos}</div>
                <div style="font-size:10px; color:${accentTxt};">Photos</div>
              </td>
              <td align="center" style="background:#fff; border-radius:6px; padding:8px;">
                <div style="font-size:22px; font-weight:800; color:${titleTxt};">${totalComments}</div>
                <div style="font-size:10px; color:${accentTxt};">Comments</div>
              </td>
              <td align="center" style="background:#fff; border-radius:6px; padding:8px;">
                <div style="font-size:18px; font-weight:800; color:${titleTxt};">${rpt.status === 'final' ? 'Final' : 'Draft'}</div>
                <div style="font-size:10px; color:${accentTxt};">Status</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    ${cv.coverNotes ? `
    <div style="margin-top:18px; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:14px 18px;">
      <div style="font-size:10px; text-transform:uppercase; letter-spacing:1px; color:#92400e; margin-bottom:5px; font-weight:700;">Notes</div>
      <div style="margin:0; color:${bodyTxt}; font-size:${cv.bodyFontSize||13}px; line-height:1.6;">${cv.coverNotes}</div>
    </div>` : ''}
    ${(cv.companyAddress || cv.companyPhone || cv.companyEmail) ? `
    <div style="margin-top:24px; padding-top:16px; border-top:1px solid #e2e8f0; font-size:11px; color:${accentTxt};">
      ${cv.companyAddress ? `<span style="margin-right:16px;">📍 ${cv.companyAddress}</span>` : ''}
      ${cv.companyPhone ? `<span style="margin-right:16px;">📞 ${cv.companyPhone}</span>` : ''}
      ${cv.companyEmail ? `<span>✉ ${cv.companyEmail}</span>` : ''}
    </div>` : ''}
  </div>
  <!-- bottom accent bar -->
  <div style="background:${primary}; height:8px; width:100%; line-height:0; font-size:0;"></div>
</div>`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.clients, data.inspections, data.maps]);

  // ─── Full HTML Generation ─────────────────────────────────────────────────

// ── GPS map HTML builders — static image, cache-backed (v73.2) ───────────────
// These are plain functions (not inside template literals) so quote conflicts
// with esbuild are impossible. They return safe HTML strings.
//
// No live Leaflet/tile-fetching happens here anymore — see the big comment
// on the removed vendored-Leaflet imports above for why. Each function does
// a synchronous lookup into a pre-populated `staticMapCache` (data URL
// strings, built ahead of time by precomputeStaticMaps() while the live app
// is open — see below). A cache miss renders a lightweight "Generating…"
// placeholder with zero network calls of its own; this is only ever visible
// transiently in the live in-app preview before the async cache-fill effect
// completes — every actual export path (Download HTML/PDF, Print) awaits
// precomputeStaticMaps() first, so a shipped report file always contains
// either a real embedded image or an explicit "map unavailable" note, never
// a stuck placeholder or a live map that depends on the file having network
// access or a referrer.

type GpsPoint = { lat: number; lng: number; lbl: string; ico: string };

/** Stable cache key for a multi-point set (the overview map) — order-sensitive but that's fine, the point order is deterministic for a given report's inspection list. */
function overviewKey(pts: GpsPoint[]): string {
  return 'ov_' + pts.map(p => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|');
}

/** Stable cache key for a location-group map (one map per photo group, v73.120) — sorted so the same set of points always dedupes to the same cached image regardless of iteration order. */
function groupMapKey(pts: { lat: number; lng: number }[]): string {
  return 'grp_' + pts.map(p => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).sort().join('|');
}

/** Collects every GPS point the overview map would show, respecting the same toggles buildGpsOverviewMap used to check. Shared so precompute and render always agree on exactly what needs an image. */
function collectOverviewPoints(inspections: Inspection[], report: { includePhotos: boolean; includeMaps: boolean }): GpsPoint[] {
  if (!report.includeMaps || !report.includePhotos) return [];
  const pts: GpsPoint[] = [];
  inspections.forEach(ins => {
    (ins.photos || []).filter(p => p.lat && p.lng).forEach(p =>
      pts.push({ lat: Number(p.lat), lng: Number(p.lng), lbl: (p.comment || 'Photo') + ' - ' + ins.title, ico: '📷' })
    );
    if (ins.latitude && !isNaN(parseFloat(ins.latitude))) {
      pts.push({ lat: parseFloat(ins.latitude), lng: parseFloat(ins.longitude || '0'), lbl: ins.location || ins.title || 'Inspection', ico: '📍' });
    }
  });
  return pts;
}

const MAP_PLACEHOLDER = (height: number) =>
  `<div style="height:${height}px;min-height:${height}px;display:flex;align-items:center;justify-content:center;background:#f3f4f6;border-radius:8px;color:#9ca3af;font-size:12px">Generating map preview…</div>`;
const MAP_UNAVAILABLE = (height: number) =>
  `<div style="height:${Math.min(height, 80)}px;display:flex;align-items:center;justify-content:center;background:#f3f4f6;border-radius:8px;color:#9ca3af;font-size:12px">Map preview unavailable (offline when this report was generated)</div>`;

// NOTE: per-photo map rendering (one Leaflet-snapshot map per individual
// photo) was removed in v73.120 — see groupPhotosByLocation()/
// renderLocationGroupHtml()/buildLocationGroupMapStatic() below, which
// render ONE map per location group instead.

function buildGpsOverviewMapStatic(
  inspections: Inspection[],
  report: { includePhotos: boolean; includeMaps: boolean },
  staticMapCache: Map<string, string | null>
): string {
  const pts = collectOverviewPoints(inspections, report);
  if (pts.length === 0) return '';
  const key = overviewKey(pts);
  const cached = staticMapCache.get(key);
  const body = cached === undefined ? MAP_PLACEHOLDER(360)
    : cached === null ? MAP_UNAVAILABLE(360)
    : `<img src="${cached}" alt="GPS overview map" style="width:100%;height:360px;object-fit:cover;border-radius:8px;display:block" />`;
  return '<div class="gps-map-wrap" style="margin-top:16px;max-width:900px">'
    + '<div class="gps-map-label">🗺️ GPS Overview Map — ' + pts.length + ' location' + (pts.length !== 1 ? 's' : '') + ' across all inspections</div>'
    + body
    + '</div>';
}

// ── One-map-per-location-group (v73.120) ─────────────────────────────────
// Craig-reported (screenshot): the report was rendering a separate map under
// EVERY individual photo, even when several photos at the same inspection
// shared the same (or near-identical) GPS spot — producing e.g. 34 maps for
// 34 photos at one location. Required layout: photos for a location grouped
// together above ONE map for that whole group. This section holds the group
// rendering primitives; the actual grouping logic (by pin, then by GPS
// proximity for unpinned photos) lives in groupPhotosByLocation() below and
// is shared between generateHTML (render) and ensureStaticMaps (precompute)
// so the two never disagree about what needs a map image.

type ReportPhoto = Inspection['photos'][number];

/** Single photo card — shared by every group-rendering call site so there's exactly one place that defines what a photo card looks like. */
function photoCardHtml(p: ReportPhoto): string {
  return `<div class="photo-card">
    <img src="${p.data}" alt="Photo" onclick="rswLbOpen(this)" data-caption="${p.comment ? p.comment.split('"').join('&quot;') : ''}"/>
    ${p.comment ? `<p class="photo-comment">💬 ${p.comment}</p>` : ''}
    ${p.takenAt ? `<p class="photo-timestamp">🕐 ${new Date(p.takenAt).toLocaleString('en-NZ', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>` : ''}
    ${p.lat && p.lng ? `<p class="photo-timestamp">📍 ${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}</p>` : ''}
  </div>`;
}

/** GPS points (lat/lng only) for a group's map — the same helper used both to render the group's map and to know what to precompute. */
function groupGpsPts(photos: ReportPhoto[]): { lat: number; lng: number }[] {
  return photos.filter(p => p.lat && p.lng).map(p => ({ lat: Number(p.lat), lng: Number(p.lng) }));
}

/** ONE map for a whole photo group — multiple markers if the photos' GPS points differ slightly, matching Craig's "still use one map, show multiple markers" requirement. Never called per-photo. */
function buildLocationGroupMapStatic(
  pts: { lat: number; lng: number }[],
  staticMapCache: Map<string, string | null>,
  height = 260
): string {
  if (pts.length === 0) return '';
  const key = groupMapKey(pts);
  const cached = staticMapCache.get(key);
  const body = cached === undefined ? MAP_PLACEHOLDER(height)
    : cached === null ? MAP_UNAVAILABLE(height)
    : `<img src="${cached}" alt="GPS location map" style="width:100%;height:${height}px;object-fit:cover;border-radius:8px;display:block" />`;
  const single = pts.length === 1;
  const labelTxt = single
    ? `📍 ${pts[0].lat.toFixed(5)}, ${pts[0].lng.toFixed(5)}`
    : `📍 ${pts.length} photo location${pts.length !== 1 ? 's' : ''} in this group`;
  const osmLink = single
    ? ` <a href="https://www.openstreetmap.org/?mlat=${pts[0].lat.toFixed(6)}&mlon=${pts[0].lng.toFixed(6)}&zoom=17" target="_blank" style="color:#059669;font-size:10px">Open in OSM ↗</a>`
    : '';
  return '<div class="location-group-map">'
    + '<div class="photo-gps-map-label">' + labelTxt + osmLink + '</div>'
    + body
    + '</div>';
}

/**
 * Groups a set of photos by physical location for report rendering:
 * - Pinned photos (mapId+pinId set) are grouped by pin — that's already an
 *   explicit, named location, so no proximity guessing needed.
 * - Unpinned photos are clustered by GPS proximity, rounding to 4 decimal
 *   places (~11m) so photos taken walking around the same site/drain/road
 *   fault land in one group instead of one-map-per-photo. Photos with no
 *   GPS at all fall into a single trailing "no location" group (no map).
 * Order is preserved (pin groups first in first-seen order, then location
 * clusters in first-seen order, then the no-GPS group last) so this always
 * matches what ensureStaticMaps precomputed.
 */
function groupPhotosByLocation(
  photos: ReportPhoto[],
  data: { maps: any[] }
): { headerHtml: string; photos: ReportPhoto[] }[] {
  const pinned = photos.filter(p => p.mapId && p.pinId);
  const unpinned = photos.filter(p => !p.mapId || !p.pinId);

  const pinGroups: { headerHtml: string; photos: ReportPhoto[] }[] = [];
  const pinIndex = new Map<string, number>();
  pinned.forEach(p => {
    const key = `${p.mapId}|${p.pinId}`;
    let idx = pinIndex.get(key);
    if (idx === undefined) {
      const m = data.maps.find((mm: any) => mm.id === p.mapId);
      const pin = m?.pins?.find((pp: any) => pp.id === p.pinId);
      const headerHtml = `
        <div class="photo-group-header">
          <span style="width:10px;height:10px;border-radius:50%;background:${pin?.color || '#4f46e5'};display:inline-block"></span>
          📌 ${pin?.label || 'Pin'} — ${m?.name || 'Map'}
        </div>`;
      idx = pinGroups.length;
      pinGroups.push({ headerHtml, photos: [] });
      pinIndex.set(key, idx);
    }
    pinGroups[idx].photos.push(p);
  });

  const withGps = unpinned.filter(p => p.lat && p.lng);
  const noGps = unpinned.filter(p => !(p.lat && p.lng));
  const clusterGroups: { headerHtml: string; photos: ReportPhoto[] }[] = [];
  const clusterIndex = new Map<string, number>();
  withGps.forEach(p => {
    // v73.137 — Craig: nearby photos document DIFFERENT things and must never be
    // auto-merged, ever — no distance tolerance at all, not even the ~1.1m from
    // v73.136. Exact coordinate match only: two photos land in the same report
    // location block ONLY if they share the literal same lat/lng, which happens
    // when they come from the same deliberate GPS-lock session (see the matching
    // comment in Inspections.tsx for the full reasoning).
    const key = `${Number(p.lat)}_${Number(p.lng)}`;
    let idx = clusterIndex.get(key);
    if (idx === undefined) {
      idx = clusterGroups.length;
      clusterGroups.push({ headerHtml: '', photos: [] });
      clusterIndex.set(key, idx);
    }
    clusterGroups[idx].photos.push(p);
  });

  const showClusterHeaders = clusterGroups.length > 1 || pinGroups.length > 0;
  clusterGroups.forEach((g, i) => {
    if (!showClusterHeaders) return;
    const label = pinGroups.length > 0 ? (clusterGroups.length > 1 ? `Other photos — Location ${i + 1}` : 'Other photos')
      : `📍 Location ${i + 1}`;
    g.headerHtml = `<div class="photo-group-header">${label}</div>`;
  });

  const groups = [...pinGroups, ...clusterGroups];
  if (noGps.length > 0) {
    groups.push({
      headerHtml: groups.length > 0 ? `<div class="photo-group-header">Other photos (no GPS)</div>` : '',
      photos: noGps,
    });
  }
  return groups;
}

/** Renders one location group: photos above, ONE map below (or none if no GPS in the group) — never a map per photo. */
function renderLocationGroupHtml(
  group: { headerHtml: string; photos: ReportPhoto[] },
  isDetailed: boolean,
  staticMapCache: Map<string, string | null>
): string {
  const cardsHtml = group.photos.map(photoCardHtml).join('');
  const pts = isDetailed ? groupGpsPts(group.photos) : [];
  const mapHtml = pts.length > 0 ? buildLocationGroupMapStatic(pts, staticMapCache) : '';
  return `${group.headerHtml}
        <div class="location-block">
          <div class="photos-grid">${cardsHtml}</div>
          ${mapHtml}
        </div>`;
}

  // Collects the ONE group-map job needed per photo-location-group (v73.120)
  // across an inspection set — mirrors groupPhotosByLocation()'s grouping
  // exactly (same function, same pin/proximity rules) so precompute never
  // generates an image that won't be used, and never misses one that will.
  // Replaces the old per-photo collection (one map per photo) that caused
  // Craig's reported bug: 34 photos at one location produced 34 maps.
  const collectGroupPoints = (
    inspections: Inspection[]
  ): { key: string; pts: { lat: number; lng: number }[] }[] => {
    const jobs: { key: string; pts: { lat: number; lng: number }[] }[] = [];
    const seen = new Set<string>();
    inspections.forEach(ins => {
      groupPhotosByLocation(ins.photos || [], data).forEach(g => {
        const pts = groupGpsPts(g.photos);
        if (pts.length === 0) return;
        const key = groupMapKey(pts);
        if (seen.has(key)) return;
        seen.add(key);
        jobs.push({ key, pts });
      });
    });
    return jobs;
  };

  // Fills in any GPS map images this report needs that aren't already cached —
  // called from the live-preview effect (background fill, tolerant of being
  // slightly behind) and awaited directly before every export path (Download
  // HTML/PDF, Print) so the shipped file is always fully rendered, never
  // showing a "Generating…" placeholder. See the big comment above
  // buildPhotoGpsMapStatic for why these are static images at all.
  const ensureStaticMaps = useCallback(async (
    report: { detailLevel?: string; includePhotos: boolean; includeMaps: boolean },
    inspections: Inspection[]
  ): Promise<void> => {
    if (report.detailLevel !== 'detailed') return; // matches the isDetailed gate in generateHTML exactly
    const jobs: { key: string; pts: { lat: number; lng: number; label?: string }[]; size: [number, number] }[] = [];

    const overviewPts = collectOverviewPoints(inspections, report);
    if (overviewPts.length > 0) {
      const key = overviewKey(overviewPts);
      if (!staticMapCache.has(key)) jobs.push({ key, pts: overviewPts.map(p => ({ lat: p.lat, lng: p.lng, label: p.lbl })), size: [900, 360] });
    }
    collectGroupPoints(inspections).forEach(g => {
      if (staticMapCache.has(g.key)) return;
      jobs.push({ key: g.key, pts: g.pts, size: [700, 260] });
    });

    if (jobs.length === 0) return;
    const results = await Promise.all(jobs.map(async j => ({
      key: j.key,
      dataUrl: await generateMultiPointGpsMap(j.pts, j.size[0], j.size[1]),
    })));
    setStaticMapCache(prev => {
      const next = new Map(prev);
      results.forEach(r => next.set(r.key, r.dataUrl)); // dataUrl may be null on failure — still cached so we don't retry forever
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staticMapCache, data]);

  const generateHTML = useCallback((report: Report | (Omit<Report, 'id' | 'createdAt'> & { id?: string; createdAt?: string }), cv?: CoverPage, forPdf = false) => {
    const inspections = data.inspections.filter(i => report.inspectionIds.includes(i.id)) as Inspection[];
    const client = data.clients.find(c => c.id === report.clientId);
    const isSummary = report.detailLevel === 'summary';
    // BUG FIX (Craig-reported): "Standard" and "Detailed" produced identical
    // output — the only branch anywhere was isSummary (summary vs everything
    // else), even though the Options tab UI promises Detailed adds "GPS & all
    // data" on top of Standard's "descriptions & photos". Gate the per-photo
    // and overview GPS maps behind isDetailed so the two levels are actually
    // different, and so switching between them in the live preview visibly changes something.
    const isDetailed = report.detailLevel === 'detailed';
    const coverData = cv || report.coverPage || emptyCover();
    const primary = coverData.primaryColor || '#1e3a5f';
    const titleTxt = coverData.titleTextColor || primary;
    const bodyTxt = coverData.bodyTextColor || '#1e293b';
    const accentTxt = coverData.accentTextColor || '#64748b';

    const condBg = (c: string) => {
      const m: Record<string, string> = { Critical: '#fecaca', Poor: '#fed7aa', Fair: '#fef3c7', Good: '#d1fae5', Excellent: '#a7f3d0' };
      return m[c] || '#e2e8f0';
    };

    const getLinks = (ins: Inspection) => {
      // mapPins is the authoritative field (set by v36+ inspection saves).
      // Only fall back to the legacy single-pin fields (mapId/mapPinId) if mapPins
      // has never been set — i.e. the inspection predates the multi-pin feature.
      // If mapPins exists as an empty array it means all pins were deliberately removed.
      if (Array.isArray(ins.mapPins)) {
        // mapPins field exists — use it exclusively (may be empty = no pins)
        return ins.mapPins
          .filter(mp => mp.mapId)
          .map(mp => {
            const map = data.maps.find(m => m.id === mp.mapId);
            const pin = map?.pins.find(p => p.id === mp.pinId);
            return { map, pin, snapshot: mp.snapshot || '', mapId: mp.mapId, pinId: mp.pinId };
          })
          .filter(lk => lk.map);
      }
      // Legacy fallback: inspection predates mapPins (never had the field)
      if (ins.mapId) {
        const map = data.maps.find(m => m.id === ins.mapId);
        const pin = map?.pins.find(p => p.id === ins.mapPinId);
        return [{ map, pin, snapshot: ins.mapSnapshot || '', mapId: ins.mapId, pinId: ins.mapPinId || '' }].filter(lk => lk.map);
      }
      return [];
    };

    // CSS is the same for both PDF and preview — forPdf only sets the page width hint
    const css = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;color:${bodyTxt};line-height:1.6;background:#fff;font-size:13px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:794px;margin:0 auto;padding:0;background:#fff}
.content-body{padding:28px 36px}

/* ── Typography ── */
h1{color:${titleTxt};border-bottom:3px solid ${primary};padding-bottom:10px;font-size:20px;margin-bottom:14px;margin-top:24px}
h2{color:${titleTxt};margin-top:24px;border-bottom:2px solid #e2e8f0;padding-bottom:6px;font-size:16px;margin-bottom:12px}
h3{font-size:13px;margin:12px 0 6px;color:${bodyTxt};font-weight:700}
p{margin:6px 0}

/* ── Table of Contents ── */
.toc-section{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;margin:12px 0}
.toc-entry{display:flex;align-items:center;gap:0;padding:5px 0;border-bottom:1px dotted #e2e8f0;font-size:13px}
.toc-entry:last-child{border-bottom:none}
.toc-num{color:${primary};font-weight:700;min-width:32px;flex-shrink:0}
.toc-title{flex:1;color:${bodyTxt}}
.toc-dots{flex:1;border-bottom:1px dotted #94a3b8;margin:0 10px;align-self:center;min-width:20px}
.toc-page{color:${accentTxt};font-size:12px;flex-shrink:0;white-space:nowrap}

/* ── Meta block ── */
.meta-block{background:#f8fafc;padding:14px 16px;border-radius:10px;margin:12px 0;border:1px solid #e2e8f0}
.meta-row{display:flex;flex-wrap:wrap;gap:4px 20px;margin-bottom:0}
.meta-item{font-size:13px;display:flex;align-items:baseline;gap:4px;min-width:140px}
.meta-item strong{color:${bodyTxt};white-space:nowrap}

/* ── Inspection card ── */
.inspection-card{border:1px solid #e2e8f0;border-radius:10px;padding:0;margin:18px 0;page-break-inside:avoid;background:#fff;border-left:4px solid ${primary};overflow:hidden}
.insp-header{background:#f0f4f8;border-bottom:1px solid #d1d9e0;padding:10px 16px;display:flex;align-items:center;gap:10px}
.insp-header-num{background:${primary};color:#fff;border-radius:50%;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0}
.insp-header-title{color:${primary};font-size:14px;font-weight:700;margin:0}
.insp-body{padding:14px 16px}

/* ── Badge ── */
.badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600;margin:0 2px;white-space:nowrap}

/* ── Photos ── */
.photos-grid{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0}
.photo-card{display:inline-block;vertical-align:top}
.photo-card img{width:180px;height:135px;object-fit:cover;border-radius:6px;border:1px solid #e2e8f0;display:block;cursor:pointer;transition:transform .15s ease,box-shadow .15s ease}
.photo-card img:hover{transform:scale(1.03);box-shadow:0 4px 16px rgba(0,0,0,0.18)}
/* ── Lightbox ── */
#rsw-lb{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:99999;align-items:center;justify-content:center;padding:20px;box-sizing:border-box}
#rsw-lb.open{display:flex}
#rsw-lb img{max-width:100%;max-height:90vh;object-fit:contain;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.6)}
#rsw-lb-close{position:fixed;top:16px;right:20px;color:#fff;font-size:36px;font-weight:300;cursor:pointer;line-height:1;user-select:none;z-index:100000}
#rsw-lb-close:hover{color:#f87171}
#rsw-lb-caption{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);color:#e2e8f0;font-size:13px;text-align:center;max-width:80%;background:rgba(0,0,0,0.5);padding:6px 14px;border-radius:20px}
#rsw-lb-counter{position:fixed;top:20px;left:20px;color:#94a3b8;font-size:13px}
.photo-comment{font-size:11px;color:#64748b;margin:4px 0;max-width:180px;font-style:italic}
.photo-timestamp{font-size:10px;color:#94a3b8;margin:2px 0;max-width:180px}
.photo-gps{font-size:10px;color:#059669;margin:2px 0;max-width:180px;font-weight:600}
.photo-gps a{color:#059669;text-decoration:underline}
.gps-map-wrap{border-radius:10px;overflow:hidden;margin:14px 0;border:1.5px solid #c7d2fe}
.photo-gps-map-wrap{border-radius:8px;overflow:hidden;margin:6px 0 14px;border:1.5px solid #6ee7b7;max-width:600px}
.photo-gps-map-label{background:#ecfdf5;color:#065f46;font-size:11px;font-weight:600;padding:5px 10px}
.gps-map-label{background:#eef2ff;color:#3730a3;font-size:11px;font-weight:700;padding:6px 12px;display:flex;align-items:center;gap:6px}
.photo-pin{font-size:10px;color:#4338ca;margin:2px 0;max-width:180px;font-weight:600}
.photo-group-header{background:#eef2ff;border:1px solid #c7d2fe;border-radius:8px;padding:6px 10px;margin:10px 0 6px;font-size:12px;font-weight:700;color:#3730a3;display:flex;align-items:center;gap:6px}
/* ── Location group block (v73.120) — photos above ONE shared map, one bordered block per location ── */
.location-block{border:1.5px solid #e2e8f0;border-radius:10px;padding:12px;margin:6px 0 14px;background:#fff}
.location-group-map{border-radius:8px;overflow:hidden;margin:10px 0 0;border:1.5px solid #6ee7b7;max-width:100%}

/* ── Comments ── */
.comment-item{background:#f1f5f9;padding:10px 14px;border-radius:8px;margin:6px 0;font-size:13px;border-left:3px solid #94a3b8;display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}
.comment-text{flex:1;min-width:0}
.comment-meta{color:#94a3b8;font-size:12px;white-space:nowrap}

/* ── Map section ── */
.map-section{background:#eef2ff;border:1px solid #c7d2fe;padding:14px 16px;border-radius:10px;margin:10px 0}
.map-section-title{color:#3730a3;margin:0 0 10px 0;font-size:13px;font-weight:700}
.pin-entry{background:#fff;border-radius:8px;margin:6px 0;border:1px solid #e0e7ff;padding:12px}
.pin-header{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap}
.pin-num{background:${primary};color:#fff;border-radius:50%;width:22px;height:22px;min-width:22px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
.pin-map-name{font-weight:700;color:#1e3a5f}
.pin-arrow{color:#64748b}
.pin-dot{width:12px;height:12px;min-width:12px;border-radius:50%;display:inline-block}
.pin-label{font-weight:700;color:#3730a3}
.pin-desc{color:#94a3b8;font-size:12px;font-style:italic}
.pin-snapshot{width:100%;border-radius:8px;border:1px solid #c7d2fe;margin-top:8px;max-height:280px;object-fit:contain;display:block}
.pin-snapshot-caption{font-size:11px;color:#94a3b8;margin-top:4px}

/* ── Summary table ── */
.summary-table{width:100%;border-collapse:collapse;margin:14px 0;font-size:12px}
.summary-table th{background:${primary};color:#fff;font-weight:700;padding:9px 10px;text-align:left;border:1px solid ${primary}}
.summary-table td{border:1px solid #e2e8f0;padding:8px 10px;vertical-align:top}
.summary-table tr:nth-child(even) td{background:#f8fafc}

/* ── Notes ── */
.notes-block{background:#fffbeb;border:1px solid #fde68a;padding:12px 16px;border-radius:8px;margin:10px 0;font-size:13px}

/* ── Footer ── */
.footer{margin-top:40px;padding:16px 36px;border-top:3px solid ${primary};background:#f8fafc;text-align:center;font-size:12px;color:#64748b}

/* ── Page breaks ── */
@media print{
  .inspection-card{page-break-inside:avoid}
  .page-break{page-break-before:always}
  .photos-grid{page-break-inside:avoid}
  .location-block{page-break-inside:avoid}
  /* Force background colors/images to print — overrides browser "print backgrounds" setting */
  *{
    -webkit-print-color-adjust:exact !important;
    print-color-adjust:exact !important;
    color-adjust:exact !important;
  }
  /* Cover page: always followed by a page break */
  .cover-wrapper{page-break-after:always !important; page-break-inside:avoid}
}
`;

    const tocEntries = isSummary
      ? `<div class="toc-entry"><span class="toc-num">1.</span><span class="toc-title">Report Overview</span><span class="toc-dots"></span><span class="toc-page">Section 1</span></div>
         <div class="toc-entry"><span class="toc-num">2.</span><span class="toc-title">Summary Table</span><span class="toc-dots"></span><span class="toc-page">Section 2</span></div>`
      : `<div class="toc-entry"><span class="toc-num">1.</span><span class="toc-title">Report Overview</span><span class="toc-dots"></span><span class="toc-page">Section 1</span></div>
         ${inspections.map((ins, i) => `<div class="toc-entry"><span class="toc-num">${i + 2}.</span><span class="toc-title">${ins.title}</span><span class="toc-dots"></span><span class="toc-page">Section ${i + 2}</span></div>`).join('')}`;

    const overviewMeta = `
<div class="meta-block">
  <span class="meta-item"><strong>Report Title:</strong> ${report.title}</span>
  <span class="meta-item"><strong>Date:</strong> ${report.date}</span>
  <span class="meta-item"><strong>Prepared By:</strong> ${report.createdBy}</span>
  ${client ? `<span class="meta-item"><strong>Client:</strong> ${client.name}${client.company ? ` (${client.company})` : ''}</span>` : ''}
  <span class="meta-item"><strong>Total Inspections:</strong> ${inspections.length}</span>
  <span class="meta-item"><strong>Total Photos:</strong> ${inspections.reduce((a, i) => a + i.photos.length, 0)}</span>
  <span class="meta-item"><strong>GPS-Tagged Photos:</strong> ${inspections.reduce((a, i) => a + i.photos.filter((p: any) => p.lat && p.lng).length, 0)}</span>
  <span class="meta-item"><strong>Photos Linked to Pins:</strong> ${inspections.reduce((a, i) => a + i.photos.filter((p: any) => p.mapId && p.pinId).length, 0)}</span>
  <span class="meta-item"><strong>Total Comments:</strong> ${inspections.reduce((a, i) => a + i.comments.length, 0)}</span>
  ${isDetailed ? buildGpsOverviewMapStatic(inspections, report, staticMapCache) : ''}
  <span class="meta-item"><strong>Detail Level:</strong> ${report.detailLevel.charAt(0).toUpperCase() + report.detailLevel.slice(1)}</span>
  <span class="meta-item"><strong>Status:</strong> ${report.status.charAt(0).toUpperCase() + report.status.slice(1)}</span>
  <span class="meta-item"><strong>Report #:</strong> ${coverData.reportNumber}</span>
</div>`;

    const inspectionCards = inspections.map((ins, idx) => {
      const links = getLinks(ins);
      return `
<div class="inspection-card page-break">
  <div class="insp-header">
    <span class="insp-header-num">${idx + 2}</span>
    <span class="insp-header-title">${ins.title}</span>
  </div>
  <div class="insp-body">
    <div class="meta-block">
      <div class="meta-row">
        <span class="meta-item"><strong>Type:</strong> ${ins.type || 'N/A'}</span>
        <span class="meta-item"><strong>Date:</strong> ${ins.date}</span>
        <span class="meta-item"><strong>Location:</strong> ${ins.location || 'N/A'}</span>
        <span class="meta-item"><strong>Condition:</strong> <span class="badge" style="background:${condBg(ins.condition)};color:#374151">${ins.condition || 'N/A'}</span></span>
        <span class="meta-item"><strong>Status:</strong> ${ins.status.replace('_', ' ')}</span>
        <span class="meta-item"><strong>Inspector:</strong> ${ins.createdBy || 'N/A'}</span>
        ${ins.latitude && ins.longitude ? `<span class="meta-item"><strong>GPS:</strong> ${ins.latitude}, ${ins.longitude}</span>` : ''}
      </div>
    </div>
    ${ins.description ? `<p style="color:#374151;margin:8px 0;font-size:13px;line-height:1.7">${ins.description}</p>` : ''}

    ${report.includeMaps && links.length > 0 ? `
    <div class="map-section">
      <div class="map-section-title">🗺️ Map &amp; Pin Locations (${links.length} pin${links.length !== 1 ? 's' : ''})</div>
      ${links.map((lk, lkIdx) => lk.map ? (() => {
        const pinPhotos = report.includePhotos
          ? ins.photos.filter(p => p.mapId === lk.mapId && lk.pinId && p.pinId === lk.pinId)
          : [];
        // ONE map for this pin's whole photo set — not one per photo (v73.120 fix).
        const pinPhotosPts = isDetailed ? groupGpsPts(pinPhotos) : [];
        const pinPhotosMapHtml = pinPhotosPts.length > 0 ? buildLocationGroupMapStatic(pinPhotosPts, staticMapCache) : '';
        return `
      <div class="pin-entry">
        <div class="pin-header">
          <span class="pin-num">${lkIdx + 1}</span>
          <span class="pin-map-name">${lk.map.name}</span>
          ${lk.pin ? `
          <span class="pin-arrow">→</span>
          <span class="pin-dot" style="background:${lk.pin.color}"></span>
          <span class="pin-label">${lk.pin.label}</span>
          ${lk.pin.description ? `<span class="pin-desc">— ${lk.pin.description}</span>` : ''}
          ` : ''}
        </div>
        ${lk.snapshot ? `
        <img src="${lk.snapshot}" class="pin-snapshot" alt="Map snapshot for ${lk.map.name}"/>
        <p class="pin-snapshot-caption">📸 ${lk.map.name}${lk.pin ? ' → 📌 ' + lk.pin.label : ''}</p>
        ` : ''}
        ${pinPhotos.length > 0 ? `
        <div style="margin-top:8px">
          <p style="font-size:11px;font-weight:700;color:#4338ca;margin:0 0 6px">📷 ${pinPhotos.length} photo${pinPhotos.length!==1?'s':''} at this pin:</p>
          <div class="location-block">
            <div class="photos-grid">${pinPhotos.map(photoCardHtml).join('')}</div>
            ${pinPhotosMapHtml}
          </div>
        </div>` : ''}
      </div>`;
      })() : '').join('')}
    </div>` : ''}

    ${report.includePhotos && ins.photos.length > 0 ? (() => {
      // One location group = photos above, ONE shared map below (v73.120).
      // Pin groups first (explicit named locations), then GPS-proximity
      // clusters for unpinned photos, then a trailing no-GPS group — see
      // groupPhotosByLocation() for the exact grouping rules.
      const gpsCount = ins.photos.filter(p => p.lat && p.lng).length;
      const groups = groupPhotosByLocation(ins.photos, data);
      const groupsHtml = groups.map(g => renderLocationGroupHtml(g, isDetailed, staticMapCache)).join('');

      return `
    <h3>📷 Photos (${ins.photos.length}${gpsCount > 0 ? ` · ${gpsCount} GPS-tagged` : ''})</h3>
    ${groupsHtml}`;
    })() : ''}

    ${report.includeComments && ins.comments.length > 0 ? `
    <h3>💬 Comments (${ins.comments.length})</h3>
    ${ins.comments.map(c => `
    <div class="comment-item">
      <span class="badge" style="background:#e0e7ff;color:#3730a3;flex-shrink:0">${c.category}</span>
      <span class="comment-text">${c.text}</span>
      <span class="comment-meta">— ${c.createdBy}, ${new Date(c.createdAt).toLocaleDateString('en-NZ')}</span>
    </div>`).join('')}` : ''}
  </div>
</div>`;
    }).join('');

    const summaryTable = `
<h2>2. Summary Table</h2>
<table class="summary-table">
<thead><tr>
  <th>#</th><th>Title</th><th>Type</th><th>Location</th>
  <th>Condition</th><th>Status</th><th>Date</th>
  <th>Photos</th><th>Comments</th>
  ${report.includeMaps ? '<th>Map Pins</th>' : ''}
</tr></thead>
<tbody>
${inspections.map((ins, i) => {
  const links = getLinks(ins);
  const mapPinText = links.map(lk => `${lk.map?.name || ''}${lk.pin ? ' → ' + lk.pin.label : ''}`).join('; ') || '—';
  return `<tr>
  <td>${i + 1}</td>
  <td><strong>${ins.title}</strong></td>
  <td>${ins.type || '—'}</td>
  <td>${ins.location || '—'}</td>
  <td><span class="badge" style="background:${condBg(ins.condition)};color:#374151">${ins.condition || '—'}</span></td>
  <td>${ins.status.replace('_', ' ')}</td>
  <td>${ins.date}</td>
  <td style="text-align:center">${ins.photos.length}</td>
  <td style="text-align:center">${ins.comments.length}</td>
  ${report.includeMaps ? `<td style="font-size:12px">${mapPinText}${links[0]?.snapshot ? `<br/><img src="${links[0].snapshot}" style="width:120px;border-radius:4px;margin-top:4px;border:1px solid #e2e8f0" alt="map"/>` : ''}</td>` : ''}
</tr>`;
}).join('')}
</tbody>
</table>`;

    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>${report.title}</title>
<style>${css}</style>
</head><body><div class="page">

${generateCoverHTML(coverData, report)}

<div class="content-body page-break">
  <h1>📑 Table of Contents</h1>
  <div class="toc-section">${tocEntries}</div>

  <h1>1. Report Overview</h1>
  ${overviewMeta}
  ${report.notes ? `<div class="notes-block"><strong style="color:#92400e">Notes:</strong> <span style="color:#78350f">${report.notes}</span></div>` : ''}
</div>

<div class="content-body">
  ${isSummary ? summaryTable : inspectionCards}
</div>

<div class="footer">
  <p><strong>${coverData.companyName}</strong>${coverData.companyPhone ? ` | 📞 ${coverData.companyPhone}` : ''}${coverData.companyEmail ? ` | ✉ ${coverData.companyEmail}` : ''}</p>
  <p style="margin-top:4px">Generated: ${new Date().toLocaleString('en-NZ')} | Report #: ${coverData.reportNumber} | ${coverData.reportTypeLabel || 'Road &amp; Storm Water Inspection'}</p>
  <p style="margin-top:4px">Total: ${inspections.length} inspection(s) | ${inspections.reduce((a, i) => a + i.photos.length, 0)} photo(s) | ${inspections.reduce((a, i) => a + i.comments.length, 0)} comment(s)</p>
</div>

</div>

  <!-- ── Lightbox ── -->
  <div id="rsw-lb" role="dialog" aria-modal="true" aria-label="Photo viewer"
       onclick="if(event.target===this)rswLbClose()" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:99999;align-items:center;justify-content:center;padding:20px;box-sizing:border-box">
    <span id="rsw-lb-close" onclick="rswLbClose()" title="Close (Esc)" style="position:fixed;top:16px;right:20px;color:#fff;font-size:40px;font-weight:300;cursor:pointer;line-height:1;user-select:none;z-index:100000">&#215;</span>
    <span id="rsw-lb-counter" style="position:fixed;top:20px;left:20px;color:#94a3b8;font-size:13px"></span>
    <img id="rsw-lb-img" src="" alt="" style="max-width:95vw;max-height:90vh;object-fit:contain;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.6)"/>
    <div id="rsw-lb-caption" style="position:fixed;bottom:24px;left:50%;transform:translateX(-50%);color:#e2e8f0;font-size:13px;text-align:center;max-width:80%;background:rgba(0,0,0,.55);padding:6px 16px;border-radius:20px;pointer-events:none"></div>
  </div>
  <script>
    (function(){
      var imgs=[], cur=0;
      function gather(){ imgs=Array.from(document.querySelectorAll('.photo-card img')); }
      window.rswLbOpen=function(el){
        gather(); cur=imgs.indexOf(el); if(cur<0){cur=0;imgs=[el];}
        show(); document.getElementById('rsw-lb').style.display='flex';
        document.addEventListener('keydown',onKey);
      };
      window.rswLbClose=function(){
        document.getElementById('rsw-lb').style.display='none';
        document.removeEventListener('keydown',onKey);
      };
      function show(){
        var el=imgs[cur];
        document.getElementById('rsw-lb-img').src=el.src;
        var cap=el.getAttribute('data-caption')||'';
        var capEl=document.getElementById('rsw-lb-caption');
        capEl.textContent=cap; capEl.style.display=cap?'block':'none';
        document.getElementById('rsw-lb-counter').textContent=
          imgs.length>1?(cur+1)+' / '+imgs.length:'';
      }
      function onKey(e){
        if(e.key==='Escape'){rswLbClose();}
        else if(e.key==='ArrowRight'&&imgs.length>1){cur=(cur+1)%imgs.length;show();}
        else if(e.key==='ArrowLeft'&&imgs.length>1){cur=(cur+imgs.length-1)%imgs.length;show();}
      }
    })();
  </script>
</div></body></html>`;
  // Depend on the specific data slices that affect report output.
  // Using the whole `data` object can miss updates if the object reference doesn't change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.inspections, data.maps, data.clients, staticMapCache, generateCoverHTML]);

  // ─── Live preview: regenerate on ANY form/cover/data change with debounce ──────
  useEffect(() => {
    if (view !== 'form') return;
    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    previewDebounceRef.current = setTimeout(() => {
      if (!form.title && form.inspectionIds.length === 0) {
        setLivePreviewHtml('');
        return;
      }
      const fakeReport = {
        ...form,
        id: editingReport?.id || 'preview',
        createdAt: editingReport?.createdAt || new Date().toISOString(),
        coverPage: cover,
      } as Report;
      setLivePreviewHtml(generateHTML(fakeReport, cover));
      // Background-fill any missing GPS map images — not awaited here (the
      // preview shows a "Generating…" placeholder in the meantime), but once
      // it resolves setStaticMapCache updates state, generateHTML's deps pick
      // that up, and this same effect re-runs and regenerates the preview
      // with the real images in place.
      const previewInspections = data.inspections.filter(i => fakeReport.inspectionIds.includes(i.id)) as Inspection[];
      void ensureStaticMaps(fakeReport, previewInspections);
    }, 600);
    return () => { if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current); };
  // generateHTML changes when data.inspections/maps/clients change (see its own deps).
  // Also depend on data.inspections directly as an extra safety net.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, cover, view, generateHTML, ensureStaticMaps, data.inspections, data.maps]);

  // ─── CSV / JSON ───────────────────────────────────────────────────────────
  const generateCSV = (report: Report) => {
    const inspections = data.inspections.filter(i => report.inspectionIds.includes(i.id)) as Inspection[];
    const headers = ['#', 'Title', 'Type', 'Date', 'Location', 'Latitude', 'Longitude',
      'Condition', 'Status', 'Description', 'Photos Count', 'Photo Comments',
      'Comments Count', 'Comment Details', 'Inspector', 'Client', 'Map Pins Count', 'Map & Pin Details'];
    const rows = inspections.map((ins, idx) => {
      const client = data.clients.find(c => c.id === ins.assignedClientId);
      let links: { map: typeof data.maps[0] | undefined; pin: typeof data.maps[0]['pins'][0] | undefined; snapshot: string }[] = [];
      if (ins.mapPins && ins.mapPins.length > 0) {
        links = ins.mapPins.map(mp => {
          const map = data.maps.find(m => m.id === mp.mapId);
          const pin = map?.pins.find(p => p.id === mp.pinId);
          return { map, pin, snapshot: mp.snapshot || '' };
        });
      } else if (ins.mapId) {
        const map = data.maps.find(m => m.id === ins.mapId);
        const pin = map?.pins.find(p => p.id === ins.mapPinId);
        links = [{ map, pin, snapshot: ins.mapSnapshot || '' }];
      }
      const mapPinDetails = links.map(lk => `${lk.map?.name || ''}${lk.pin ? ' -> ' + lk.pin.label : ''}`).join(' | ');
      const photoComments = ins.photos.filter(p => p.comment).map(p => p.comment).join(' | ');
      const commentDetails = ins.comments.map(c => `[${c.category}] ${c.text}`).join(' | ');
      return [
        idx + 1, `"${ins.title}"`, `"${ins.type}"`, ins.date, `"${ins.location}"`,
        ins.latitude || '', ins.longitude || '', `"${ins.condition}"`, `"${ins.status}"`,
        `"${ins.description.replace(/"/g, '""')}"`, ins.photos.length,
        `"${photoComments}"`, ins.comments.length, `"${commentDetails}"`,
        `"${ins.createdBy}"`, `"${client?.name || ''}"`, links.length, `"${mapPinDetails}"`
      ];
    });
    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  };

  // ─── Download Handlers ────────────────────────────────────────────────────
  const getCoverForReport = (report: Report) =>
    report.coverPage || emptyCover();

  const inspectionsForReport = (report: { inspectionIds: string[] }) =>
    data.inspections.filter(i => report.inspectionIds.includes(i.id)) as Inspection[];

  const downloadHTML = async (report: Report) => {
    // Await so the downloaded file always has real map images embedded —
    // never the transient "Generating…" placeholder the live preview can show.
    await ensureStaticMaps(report, inspectionsForReport(report));
    downloadFile(generateHTML(report, getCoverForReport(report)), `${report.title.replace(/\s+/g, '-')}.html`, 'text/html;charset=utf-8');
  };

  const downloadCSV = (report: Report) =>
    downloadFile(generateCSV(report), `${report.title.replace(/\s+/g, '-')}.csv`, 'text/csv;charset=utf-8');

  const downloadPDF = async (report: Report, cv?: CoverPage) => {
    // Generate the full HTML with print-color-adjust applied via CSS.
    // We open it in a new window — identical to handlePrint — so the browser's
    // native print engine renders everything (backgrounds, flex, shadows) correctly.
    // The user sees the "Save as PDF" destination pre-selected if they have Chrome's
    // default set to PDF, or can choose it from the destination dropdown.
    // The window title becomes the PDF filename when saving via Save as PDF.
    setPdfGenerating(true);
    // window.open() must happen before any `await` — calling it after an async
    // gap breaks the "triggered by a user gesture" chain most browsers require,
    // and it gets silently popup-blocked. Open a blank window immediately,
    // write into it once the (possibly async) map images are ready.
    const w = window.open('', '_blank');
    await ensureStaticMaps(report, inspectionsForReport(report));
    const htmlContent = generateHTML(report, cv || getCoverForReport(report));
    const filename = report.title.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    // Inject the filename as the document title so "Save as PDF" uses it
    const titledHTML = htmlContent.replace(
      '<title>' + report.title + '</title>',
      '<title>' + filename + '</title>'
    );
    if (w) {
      w.document.write(titledHTML);
      w.document.close();
      // Small delay lets images/fonts load before triggering print dialog
      setTimeout(() => {
        w.focus();
        w.print();
        setPdfGenerating(false);
      }, 800);
    } else {
      setPdfGenerating(false);
    }
  };

  const handlePrint = async (report: Report, cv?: CoverPage) => {
    const w = window.open('', '_blank'); // before the await — see downloadPDF's comment
    await ensureStaticMaps(report, inspectionsForReport(report));
    if (w) { w.document.write(generateHTML(report, cv || getCoverForReport(report))); w.document.close(); setTimeout(() => w.print(), 500); }
  };

  // Warms the static map cache for the standalone Preview view (reached via
  // the report list's "Preview" button) the same way the live editor preview
  // does — generateHTML's own dependency on staticMapCache means this render
  // just re-runs automatically once the fetch resolves and updates state.
  useEffect(() => {
    if (view !== 'preview' || !previewReport) return;
    void ensureStaticMaps(previewReport, inspectionsForReport(previewReport));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, previewReport, ensureStaticMaps]);

  // ─── PREVIEW VIEW ─────────────────────────────────────────────────────────
  if (view === 'preview' && previewReport) {
    const html = generateHTML(previewReport, previewCover);
    return (
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={() => setView('list')} className="btn-secondary">← Back to List</button>
            {editingReport && (
              <button onClick={() => setView('form')} className="btn-secondary">← Back to Editor</button>
            )}
            <h1 className="text-xl font-bold text-gray-900">{previewReport.title}</h1>
            <span className={`badge ${previewReport.status === 'final' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'}`}>
              {previewReport.status}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => downloadPDF(previewReport, previewCover)} disabled={pdfGenerating}
              className="btn-primary flex items-center gap-1.5 disabled:opacity-50">
              {pdfGenerating ? <><span className="animate-spin">⏳</span> Generating...</> : <>📄 PDF</>}
            </button>
            <button onClick={() => downloadHTML(previewReport)} className="btn-secondary">🌐 HTML</button>
            <button onClick={() => downloadCSV(previewReport)} className="btn-success">📊 CSV</button>
            <button onClick={() => handlePrint(previewReport, previewCover)} className="btn-warning">🖨️ Print</button>
          </div>
        </div>
        <div className="card !p-0 overflow-hidden">
          <iframe srcDoc={html} className="w-full h-[800px] border-0" title="Report Preview" />
        </div>
      </div>
    );
  }

  // ─── FORM VIEW ────────────────────────────────────────────────────────────
  if (view === 'form') {
    const filteredInsp = filteredInspectionsMemo;
    const selClient = data.clients.find(c => c.id === form.clientId);
    const tabs = [
      { id: 'report', label: '📋 Details' },
      { id: 'cover', label: '🎨 Cover Page' },
      { id: 'options', label: '⚙️ Options' },
      { id: 'inspections', label: `📝 Inspections (${form.inspectionIds.filter(id => data.inspections.some(i => i.id === id)).length})` },
      { id: 'preview', label: '👁️ Live Preview' },
    ] as const;

    return (
      <>
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <button onClick={() => setView('list')} className="btn-secondary">← Back</button>
          <h1 className="text-2xl font-bold text-gray-900">{editingReport ? 'Edit Report' : 'Generate Report'}</h1>
        </div>

        {/* Tab navigation */}
        <div className="flex gap-1 bg-gray-100 p-1 rounded-xl overflow-x-auto">
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setCoverTab(tab.id)}
              className={`flex-1 min-w-max px-3 py-2 rounded-lg text-sm font-medium transition whitespace-nowrap ${
                coverTab === tab.id
                  ? tab.id === 'preview' ? 'bg-indigo-600 text-white shadow' : 'bg-white shadow text-indigo-700'
                  : 'text-gray-600 hover:text-gray-900'
              }`}>
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── LIVE PREVIEW TAB ── */}
        {coverTab === 'preview' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-gray-900">👁️ Live Report Preview</h2>
                <p className="text-sm text-gray-500 mt-0.5">Updates automatically as you make changes — switch between tabs and come back to see updates</p>
              </div>
              <div className="flex gap-2">
                {form.title && form.inspectionIds.length > 0 && (() => {
                  const fakeReport = { ...form, id: editingReport?.id || 'preview', createdAt: editingReport?.createdAt || new Date().toISOString(), coverPage: cover } as Report;
                  return (
                    <>
                      <button onClick={() => downloadPDF(fakeReport, cover)} disabled={pdfGenerating}
                        className="btn-primary text-sm flex items-center gap-1 disabled:opacity-50">
                        {pdfGenerating ? '⏳ Generating...' : '📄 Download PDF'}
                      </button>
                      <button onClick={() => downloadHTML(fakeReport)} className="btn-secondary text-sm">🌐 HTML</button>
                      <button onClick={() => handlePrint(fakeReport, cover)} className="btn-warning text-sm">🖨️ Print</button>
                    </>
                  );
                })()}
              </div>
            </div>

            {!form.title && form.inspectionIds.length === 0 ? (
              <div className="card text-center py-16">
                <p className="text-5xl mb-4">📄</p>
                <p className="text-gray-500 font-medium">No preview yet</p>
                <p className="text-gray-400 text-sm mt-2">Add a report title and select at least one inspection to see a live preview here.</p>
                <div className="flex gap-3 justify-center mt-4">
                  <button onClick={() => setCoverTab('report')} className="btn-primary text-sm">📋 Add Details</button>
                  <button onClick={() => setCoverTab('inspections')} className="btn-secondary text-sm">📝 Select Inspections</button>
                </div>
              </div>
            ) : !form.title ? (
              <div className="card text-center py-12">
                <p className="text-3xl mb-3">✏️</p>
                <p className="text-gray-500">Please add a report title first.</p>
                <button onClick={() => setCoverTab('report')} className="btn-primary text-sm mt-3">📋 Go to Details Tab</button>
              </div>
            ) : form.inspectionIds.length === 0 ? (
              <div className="card text-center py-12">
                <p className="text-3xl mb-3">📝</p>
                <p className="text-gray-500">Select at least one inspection to preview the report.</p>
                <button onClick={() => setCoverTab('inspections')} className="btn-primary text-sm mt-3">📝 Select Inspections</button>
              </div>
            ) : livePreviewHtml ? (
              <div className="card !p-0 overflow-hidden shadow-xl">
                <div className="bg-gray-800 px-4 py-2 flex items-center gap-3">
                  <div className="flex gap-1.5">
                    <div className="w-3 h-3 rounded-full bg-red-500" />
                    <div className="w-3 h-3 rounded-full bg-yellow-500" />
                    <div className="w-3 h-3 rounded-full bg-green-500" />
                  </div>
                  <span className="text-gray-300 text-xs font-mono flex-1 text-center">{form.title || 'Report Preview'}</span>
                  <span className="text-gray-500 text-xs">Live Preview</span>
                </div>
                <iframe
                  srcDoc={livePreviewHtml}
                  className="w-full border-0"
                  style={{ height: '80vh', minHeight: '600px' }}
                  title="Live Report Preview"
                  sandbox="allow-scripts allow-same-origin"
                />
              </div>
            ) : (
              <div className="card text-center py-12">
                <div className="animate-spin text-4xl mb-3">⏳</div>
                <p className="text-gray-500">Generating preview...</p>
              </div>
            )}
          </div>
        )}

        {coverTab !== 'preview' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">

              {/* ── REPORT DETAILS TAB ── */}
              {coverTab === 'report' && (
                <div className="card space-y-4">
                  <h2 className="font-semibold text-gray-900">Report Details</h2>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Report Title *</label>
                    <input className="input-field" value={form.title}
                      onChange={e => { setForm({ ...form, title: e.target.value }); setCover(prev => ({ ...prev, reportTitle: e.target.value })); }}
                      placeholder="e.g. Monthly Drain Inspection Report – June 2024" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Report Date</label>
                      <input className="input-field" type="date" value={form.date}
                        onChange={e => { setForm({ ...form, date: e.target.value }); setCover(prev => ({ ...prev, reportDate: e.target.value })); }} />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Report Number</label>
                      <input className="input-field" value={cover.reportNumber}
                        onChange={e => setCover(prev => ({ ...prev, reportNumber: e.target.value }))}
                        placeholder="e.g. RPT-2024-001" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Prepared By</label>
                      <input className="input-field" value={cover.preparedBy}
                        onChange={e => { setCover(prev => ({ ...prev, preparedBy: e.target.value })); setForm(prev => ({ ...prev, createdBy: e.target.value })); }}
                        placeholder="Your name" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Assign to Client</label>
                      <select className="input-field" value={form.clientId}
                        onChange={e => { setForm({ ...form, clientId: e.target.value }); const cl = data.clients.find(c => c.id === e.target.value); setCover(prev => ({ ...prev, preparedFor: cl?.name || '' })); }}>
                        <option value="">No client</option>
                        {data.clients.map(c => <option key={c.id} value={c.id}>{c.name}{c.company ? ` (${c.company})` : ''}</option>)}
                      </select>
                    </div>
                  </div>
                  {selClient && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
                      <strong>Client:</strong> {selClient.name}{selClient.company ? ` — ${selClient.company}` : ''}{selClient.email ? ` | ${selClient.email}` : ''}
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Report Notes</label>
                    <textarea className="input-field" rows={3} value={form.notes}
                      onChange={e => setForm({ ...form, notes: e.target.value })}
                      placeholder="Additional notes for this report..." />
                  </div>
                </div>
              )}

              {/* ── COVER PAGE TAB ── */}
              {coverTab === 'cover' && (
                <div className="space-y-4">
                  {/* Template load/save bar */}
                  <div className="p-3 bg-purple-50 border border-purple-200 rounded-xl space-y-2">
                    <span className="text-sm font-semibold text-purple-800 block">🎨 Cover Templates</span>
                    <div className="flex flex-col sm:flex-row gap-2">
                      {/* Load — inline dropdown */}
                      <div className="flex-1">
                        <select
                          className="input-field w-full"
                          value=""
                          onChange={e => {
                            const tpl = (data.coverTemplates || []).find(t => t.id === e.target.value);
                            if (!tpl) return;
                            setCover(prev => ({
                              ...tpl.cover,
                              reportTitle:    prev.reportTitle,
                              reportSubtitle: prev.reportSubtitle,
                              preparedFor:    prev.preparedFor,
                              reportDate:     prev.reportDate,
                              reportNumber:   prev.reportNumber,
                              coverNotes:     prev.coverNotes,
                              // Safe fallbacks for fields added after template was created
                              reportTypeLabel:   tpl.cover.reportTypeLabel  || 'Road & Storm Water Inspection',
                              titleFontSize:     tpl.cover.titleFontSize    || 30,
                              subtitleFontSize:  tpl.cover.subtitleFontSize || 16,
                              bodyFontSize:      tpl.cover.bodyFontSize     || 13,
                              accentFontSize:    tpl.cover.accentFontSize   || 10,
                              headerFontSize:    tpl.cover.headerFontSize   || 20,
                              taglineFontSize:   tpl.cover.taglineFontSize  || 14,
                              logoSize:          tpl.cover.logoSize         || 80,
                              coverBodyText:     tpl.cover.coverBodyText    || '',
                            }));
                          }}
                        >
                          <option value="">📂 Load a saved template...</option>
                          {/* Client-specific templates first */}
                          {(data.coverTemplates || []).filter(t => t.clientId && t.clientId === form.clientId).length > 0 && (
                            <optgroup label={`— This client's templates —`}>
                              {(data.coverTemplates || [])
                                .filter(t => t.clientId === form.clientId)
                                .map(t => <option key={t.id} value={t.id}>✦ {t.name}{t.description ? ` — ${t.description}` : ''}</option>)
                              }
                            </optgroup>
                          )}
                          {/* Global templates */}
                          {(data.coverTemplates || []).filter(t => !t.clientId).length > 0 && (
                            <optgroup label="— Global templates —">
                              {(data.coverTemplates || [])
                                .filter(t => !t.clientId)
                                .map(t => <option key={t.id} value={t.id}>🌐 {t.name}{t.description ? ` — ${t.description}` : ''}</option>)
                              }
                            </optgroup>
                          )}
                          {/* Other client templates */}
                          {(data.coverTemplates || []).filter(t => t.clientId && t.clientId !== form.clientId).length > 0 && (
                            <optgroup label="— Other client templates —">
                              {(data.coverTemplates || [])
                                .filter(t => t.clientId && t.clientId !== form.clientId)
                                .map(t => { const cl = data.clients.find(c => c.id === t.clientId); return <option key={t.id} value={t.id}>👤 {t.name} ({cl?.name || t.clientName}){t.description ? ` — ${t.description}` : ''}</option>; })
                              }
                            </optgroup>
                          )}
                          {(data.coverTemplates || []).length === 0 && (
                            <option disabled value="">No templates saved yet</option>
                          )}
                        </select>
                        {/* Template management — delete saved templates */}
                        {(data.coverTemplates || []).length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {(data.coverTemplates || []).map(t => (
                              <span key={t.id} className="inline-flex items-center gap-1 text-xs bg-gray-100 rounded-full px-2 py-0.5">
                                {t.name}
                                <button
                                  onClick={() => { if (window.confirm(`Delete template "${t.name}"?`)) deleteCoverTemplate(t.id); }}
                                  className="text-gray-400 hover:text-red-500 transition ml-0.5 font-bold"
                                  title="Delete this template"
                                >×</button>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      {/* Save button */}
                      <button
                        onClick={() => {
                          setSaveTplForm({ name: '', description: '', clientId: form.clientId || '' });
                          setShowSaveTemplate(true);
                        }}
                        className="flex items-center justify-center gap-1.5 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm font-medium transition whitespace-nowrap"
                      >
                        💾 Save as Template
                      </button>
                    </div>
                  </div>

                  {/* Live mini-preview */}
                  <div className="card">
                    <h2 className="font-semibold text-gray-900 mb-3">🎨 Cover Page Editor</h2>
                    <p className="text-sm text-gray-500 mb-4">This is the first page of your printed/PDF report.</p>
                    <div className="bg-gray-100 rounded-xl p-3">
                      <div className="aspect-[210/297] bg-white rounded-lg shadow-lg overflow-hidden max-w-xs mx-auto border border-gray-200">
                        <div style={{ backgroundColor: cover.primaryColor, height: '6px' }} />
                        <div style={{ backgroundColor: cover.primaryColor, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <img src={cover.logoData || DEFAULT_LOGO_DATA} alt="logo"
                            style={{ height: 28, width: 28, objectFit: 'contain', borderRadius: 5, flexShrink: 0 }} />
                          <div style={{ flex: 1, textAlign: 'center' }}>
                            <div className="font-bold text-xs truncate" style={{ color: cover.headerTextColor }}>{cover.companyName || 'Company Name'}</div>
                            <div className="text-[9px] truncate" style={{ color: cover.headerTextColor + 'cc' }}>{cover.companyTagline || 'Tagline'}</div>
                          </div>
                        </div>
                        <div className="p-3">
                          <div className="text-[8px] font-bold uppercase tracking-widest mb-1" style={{ color: cover.titleTextColor }}>{cover.reportTypeLabel || 'Road & Storm Water Inspection'}</div>
                          <div className="font-bold text-xs leading-tight mb-2" style={{ color: cover.titleTextColor, borderBottom: `2px solid ${cover.primaryColor}`, paddingBottom: '4px' }}>
                            {cover.reportTitle || form.title || 'Report Title'}
                          </div>
                          <div className="grid grid-cols-2 gap-1 mt-2">
                            {['Prepared For', 'Prepared By', 'Date', 'Summary'].map(label => (
                              <div key={label} className="bg-gray-50 rounded p-1">
                                <div className="uppercase" style={{ color: cover.accentTextColor, fontSize: '7px' }}>{label}</div>
                                <div className="text-[8px] font-semibold truncate" style={{ color: cover.titleTextColor }}>
                                  {label === 'Prepared For' ? (cover.preparedFor || selClient?.name || '—') :
                                   label === 'Prepared By' ? (cover.preparedBy || '—') :
                                   label === 'Date' ? cover.reportDate :
                                   `${form.inspectionIds.filter(id => data.inspections.some(i => i.id === id)).length} inspections`}
                                </div>
                              </div>
                            ))}
                          </div>
                          {cover.coverNotes && (
                            <div className="mt-2 bg-amber-50 rounded p-1">
                              <div className="text-[7px] text-amber-700 font-bold">NOTES</div>
                              <div className="text-[7px] line-clamp-2" style={{ color: cover.bodyTextColor }}>{cover.coverNotes}</div>
                            </div>
                          )}
                        </div>
                        <div style={{ backgroundColor: cover.primaryColor, height: '4px' }} />
                      </div>
                      <p className="text-center text-xs text-gray-500 mt-2">Live mini-preview (not to scale) — see "👁️ Live Preview" tab for full preview</p>
                    </div>
                  </div>

                  <div className="card space-y-4">
                    <h3 className="font-semibold text-gray-800">Company Information</h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="col-span-2">
                        <label className="block text-sm font-medium text-gray-700 mb-1">Company Name</label>
                        <input className="input-field" value={cover.companyName} onChange={e => setCover(prev => ({ ...prev, companyName: e.target.value }))} placeholder="Unicus" />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-sm font-medium text-gray-700 mb-1">Company Tagline</label>
                        <input className="input-field" value={cover.companyTagline} onChange={e => setCover(prev => ({ ...prev, companyTagline: e.target.value }))} placeholder="Expert In Road Sweeping, Cleaning And Hydro Excavating" />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                        <input className="input-field" value={cover.companyPhone} onChange={e => setCover(prev => ({ ...prev, companyPhone: e.target.value }))} placeholder="+61 400 000 000" />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                        <input className="input-field" value={cover.companyEmail} onChange={e => setCover(prev => ({ ...prev, companyEmail: e.target.value }))} placeholder="info@company.com.au" />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
                        <input className="input-field" value={cover.companyAddress} onChange={e => setCover(prev => ({ ...prev, companyAddress: e.target.value }))} placeholder="123 Main Street, City, State, Postcode" />
                      </div>
                    </div>
                  </div>

                  <div className="card space-y-4">
                    <h3 className="font-semibold text-gray-800">Cover Page Content</h3>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Report Type Label <span className="text-xs text-gray-400">(shown on cover page banner)</span></label>
                      <input
                        className="input-field"
                        value={cover.reportTypeLabel ?? 'Road & Storm Water Inspection'}
                        onChange={e => setCover(prev => ({ ...prev, reportTypeLabel: e.target.value }))}
                        placeholder="e.g. Road & Storm Water Inspection"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Report Subtitle <span className="text-xs text-gray-400 font-normal">— italic line below the title</span></label>
                      <input className="input-field mb-2" value={cover.reportSubtitle} onChange={e => setCover(prev => ({ ...prev, reportSubtitle: e.target.value }))} placeholder="e.g. Site Assessment — Eastern District" />
                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="flex items-center gap-2 flex-1 min-w-[160px]">
                          <span className="text-xs text-gray-500 whitespace-nowrap">Size: {cover.subtitleFontSize || 16}px</span>
                          <input type="range" min={10} max={28} step={1} value={cover.subtitleFontSize || 16}
                            onChange={e => setCover(prev => ({ ...prev, subtitleFontSize: Number(e.target.value) }))}
                            className="flex-1 accent-indigo-600" />
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">Colour:</span>
                          <input type="color" value={cover.accentTextColor}
                            onChange={e => setCover(prev => ({ ...prev, accentTextColor: e.target.value }))}
                            className="w-8 h-8 rounded cursor-pointer border border-gray-300" title="Subtitle colour" />
                        </div>
                      </div>
                      {cover.reportSubtitle && (
                        <div className="mt-2 px-2 py-1 bg-gray-50 rounded border border-gray-100 italic" style={{ fontSize: `${cover.subtitleFontSize || 16}px`, color: cover.accentTextColor }}>
                          {cover.reportSubtitle}
                        </div>
                      )}
                    </div>

                    {/* Cover body text — fills empty space on cover */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Cover Body Text
                        <span className="text-xs text-gray-400 font-normal ml-1">— appears below the title, fills the empty cover area</span>
                      </label>
                      <textarea className="input-field mb-2" rows={4}
                        value={cover.coverBodyText || ''}
                        onChange={e => setCover(prev => ({ ...prev, coverBodyText: e.target.value }))}
                        placeholder="e.g. This report documents the site sweep carried out at the above address. All findings, photos and observations are recorded in the sections below..." />
                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="flex items-center gap-2 flex-1 min-w-[160px]">
                          <span className="text-xs text-gray-500 whitespace-nowrap">Size: {cover.bodyFontSize || 13}px</span>
                          <input type="range" min={10} max={20} step={1} value={cover.bodyFontSize || 13}
                            onChange={e => setCover(prev => ({ ...prev, bodyFontSize: Number(e.target.value) }))}
                            className="flex-1 accent-indigo-600" />
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">Colour:</span>
                          <input type="color" value={cover.bodyTextColor}
                            onChange={e => setCover(prev => ({ ...prev, bodyTextColor: e.target.value }))}
                            className="w-8 h-8 rounded cursor-pointer border border-gray-300" title="Body text colour" />
                        </div>
                      </div>
                      {cover.coverBodyText && (
                        <div className="mt-2 px-2 py-1.5 bg-gray-50 rounded border border-gray-100 whitespace-pre-wrap leading-relaxed" style={{ fontSize: `${cover.bodyFontSize || 13}px`, color: cover.bodyTextColor }}>
                          {cover.coverBodyText}
                        </div>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Prepared For</label>
                        <input className="input-field" value={cover.preparedFor} onChange={e => setCover(prev => ({ ...prev, preparedFor: e.target.value }))} placeholder="Client or organisation name" />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Prepared By</label>
                        <input className="input-field" value={cover.preparedBy} onChange={e => setCover(prev => ({ ...prev, preparedBy: e.target.value }))} placeholder="Your name" />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Cover Notes / Executive Summary <span className="text-xs text-gray-400 font-normal">— yellow highlighted box at bottom of cover</span></label>
                      <textarea className="input-field mb-2" rows={3} value={cover.coverNotes} onChange={e => setCover(prev => ({ ...prev, coverNotes: e.target.value }))}
                        placeholder="Optional highlighted notes box at the bottom of the cover page..." />
                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="flex items-center gap-2 flex-1 min-w-[160px]">
                          <span className="text-xs text-gray-500 whitespace-nowrap">Size: {cover.bodyFontSize || 13}px</span>
                          <input type="range" min={10} max={20} step={1} value={cover.bodyFontSize || 13}
                            onChange={e => setCover(prev => ({ ...prev, bodyFontSize: Number(e.target.value) }))}
                            className="flex-1 accent-indigo-600" />
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">Colour:</span>
                          <input type="color" value={cover.bodyTextColor}
                            onChange={e => setCover(prev => ({ ...prev, bodyTextColor: e.target.value }))}
                            className="w-8 h-8 rounded cursor-pointer border border-gray-300" title="Notes text colour" />
                        </div>
                      </div>
                      {cover.coverNotes && (
                        <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                          <div className="text-xs font-bold text-amber-700 mb-1">NOTES PREVIEW</div>
                          <div className="whitespace-pre-wrap" style={{ fontSize: `${cover.bodyFontSize || 13}px`, color: cover.bodyTextColor }}>{cover.coverNotes}</div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="card space-y-5">
                    <h3 className="font-semibold text-gray-800">Branding & Colours</h3>

                    {/* Header background colour */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">🎨 Header Background Colour</label>
                      <div className="flex items-center gap-2 flex-wrap">
                        {['#1e3a5f','#1d4ed8','#0f766e','#7c3aed','#be123c','#1a1a1a','#b45309','#065f46','#0e7490','#831843'].map(col => (
                          <button key={col} onClick={() => setCover(prev => ({ ...prev, primaryColor: col }))}
                            style={{ backgroundColor: col }}
                            className={`w-9 h-9 rounded-full border-4 transition ${cover.primaryColor === col ? 'border-white ring-2 ring-offset-1 ring-gray-500 scale-110' : 'border-transparent hover:scale-105'}`} />
                        ))}
                        <input type="color" value={cover.primaryColor} onChange={e => setCover(prev => ({ ...prev, primaryColor: e.target.value }))}
                          className="w-9 h-9 rounded cursor-pointer border border-gray-300" title="Custom colour" />
                        <span className="text-xs font-mono text-gray-500">{cover.primaryColor}</span>
                      </div>
                    </div>

                    {/* Text colour grid */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-3">🖊️ Text Colours</label>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

                        {/* Header text */}
                        <div className="bg-gray-50 rounded-xl p-3 border border-gray-200">
                          <label className="block text-xs font-semibold text-gray-600 mb-1">Header Text</label>
                          <p className="text-xs text-gray-400 mb-2">Company name on coloured header</p>
                          <div className="flex items-center gap-2 flex-wrap mb-2">
                            {['#ffffff','#f1f5f9','#fef3c7','#d1fae5','#e0e7ff','#000000'].map(col => (
                              <button key={col} onClick={() => setCover(prev => ({ ...prev, headerTextColor: col }))}
                                style={{ backgroundColor: col, border: cover.headerTextColor === col ? '3px solid #6366f1' : '2px solid #d1d5db' }}
                                className="w-7 h-7 rounded-full transition hover:scale-110" />
                            ))}
                            <input type="color" value={cover.headerTextColor} onChange={e => setCover(prev => ({ ...prev, headerTextColor: e.target.value }))}
                              className="w-8 h-8 rounded cursor-pointer border border-gray-300" />
                            <span className="text-xs font-mono text-gray-400">{cover.headerTextColor}</span>
                          </div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs text-gray-500 whitespace-nowrap">Name: {cover.headerFontSize || 20}px</span>
                            <input type="range" min={12} max={40} step={1} value={cover.headerFontSize || 20}
                              onChange={e => setCover(prev => ({ ...prev, headerFontSize: Number(e.target.value) }))}
                              className="flex-1 accent-indigo-600" />
                          </div>
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs text-gray-500 whitespace-nowrap">Tagline: {cover.taglineFontSize || 14}px</span>
                            <input type="range" min={9} max={24} step={1} value={cover.taglineFontSize || 14}
                              onChange={e => setCover(prev => ({ ...prev, taglineFontSize: Number(e.target.value) }))}
                              className="flex-1 accent-indigo-600" />
                          </div>
                          <div className="rounded-lg px-3 py-2 font-bold" style={{ backgroundColor: cover.primaryColor, color: cover.headerTextColor }}>
                            <div style={{ fontSize: `${cover.headerFontSize || 20}px`, fontWeight: 700 }}>{cover.companyName || 'Company Name Preview'}</div>
                            <div style={{ fontSize: `${cover.taglineFontSize || 14}px`, opacity: 0.8, marginTop: 2 }}>{cover.companyTagline || 'Tagline preview'}</div>
                          </div>
                        </div>

                        {/* Title text */}
                        <div className="bg-gray-50 rounded-xl p-3 border border-gray-200">
                          <label className="block text-xs font-semibold text-gray-600 mb-1">Title & Headings</label>
                          <p className="text-xs text-gray-400 mb-2">Report title, names, stat numbers</p>
                          <div className="flex items-center gap-2 flex-wrap mb-2">
                            {['#1e3a5f','#1d4ed8','#0f766e','#7c3aed','#be123c','#000000','#374151'].map(col => (
                              <button key={col} onClick={() => setCover(prev => ({ ...prev, titleTextColor: col }))}
                                style={{ backgroundColor: col, border: cover.titleTextColor === col ? '3px solid #6366f1' : '2px solid #d1d5db' }}
                                className="w-7 h-7 rounded-full transition hover:scale-110" />
                            ))}
                            <input type="color" value={cover.titleTextColor} onChange={e => setCover(prev => ({ ...prev, titleTextColor: e.target.value }))}
                              className="w-8 h-8 rounded cursor-pointer border border-gray-300" />
                            <span className="text-xs font-mono text-gray-400">{cover.titleTextColor}</span>
                          </div>
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs text-gray-500 whitespace-nowrap">Size: {cover.titleFontSize || 30}px</span>
                            <input type="range" min={18} max={52} step={1} value={cover.titleFontSize || 30}
                              onChange={e => setCover(prev => ({ ...prev, titleFontSize: Number(e.target.value) }))}
                              className="flex-1 accent-indigo-600" />
                          </div>
                          <div className="rounded-lg px-3 py-1.5 font-bold truncate bg-white border border-gray-200" style={{ color: cover.titleTextColor, fontSize: `${cover.titleFontSize || 30}px` }}>
                            {cover.reportTitle || form.title || 'Report Title Preview'}
                          </div>
                        </div>

                        {/* Body text */}
                        <div className="bg-gray-50 rounded-xl p-3 border border-gray-200">
                          <label className="block text-xs font-semibold text-gray-600 mb-1">Body Text</label>
                          <p className="text-xs text-gray-400 mb-2">Descriptions, notes content</p>
                          <div className="flex items-center gap-2 flex-wrap mb-2">
                            {['#1e293b','#374151','#111827','#000000','#1e3a5f','#3f3f46'].map(col => (
                              <button key={col} onClick={() => setCover(prev => ({ ...prev, bodyTextColor: col }))}
                                style={{ backgroundColor: col, border: cover.bodyTextColor === col ? '3px solid #6366f1' : '2px solid #d1d5db' }}
                                className="w-7 h-7 rounded-full transition hover:scale-110" />
                            ))}
                            <input type="color" value={cover.bodyTextColor} onChange={e => setCover(prev => ({ ...prev, bodyTextColor: e.target.value }))}
                              className="w-8 h-8 rounded cursor-pointer border border-gray-300" />
                            <span className="text-xs font-mono text-gray-400">{cover.bodyTextColor}</span>
                          </div>
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs text-gray-500 whitespace-nowrap">Size: {cover.bodyFontSize || 13}px</span>
                            <input type="range" min={10} max={18} step={1} value={cover.bodyFontSize || 13}
                              onChange={e => setCover(prev => ({ ...prev, bodyFontSize: Number(e.target.value) }))}
                              className="flex-1 accent-indigo-600" />
                          </div>
                          <div className="rounded-lg px-3 py-1.5 bg-white border border-gray-200" style={{ color: cover.bodyTextColor, fontSize: `${cover.bodyFontSize || 13}px` }}>
                            Sample body text — notes and descriptions appear like this.
                          </div>
                        </div>

                        {/* Accent text */}
                        <div className="bg-gray-50 rounded-xl p-3 border border-gray-200">
                          <label className="block text-xs font-semibold text-gray-600 mb-1">Accent / Labels</label>
                          <p className="text-xs text-gray-400 mb-2">Section labels, secondary info</p>
                          <div className="flex items-center gap-2 flex-wrap mb-2">
                            {['#64748b','#94a3b8','#6b7280','#4b5563','#0f766e','#1d4ed8'].map(col => (
                              <button key={col} onClick={() => setCover(prev => ({ ...prev, accentTextColor: col }))}
                                style={{ backgroundColor: col, border: cover.accentTextColor === col ? '3px solid #6366f1' : '2px solid #d1d5db' }}
                                className="w-7 h-7 rounded-full transition hover:scale-110" />
                            ))}
                            <input type="color" value={cover.accentTextColor} onChange={e => setCover(prev => ({ ...prev, accentTextColor: e.target.value }))}
                              className="w-8 h-8 rounded cursor-pointer border border-gray-300" />
                            <span className="text-xs font-mono text-gray-400">{cover.accentTextColor}</span>
                          </div>
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs text-gray-500 whitespace-nowrap">Size: {cover.accentFontSize || 10}px</span>
                            <input type="range" min={8} max={16} step={1} value={cover.accentFontSize || 10}
                              onChange={e => setCover(prev => ({ ...prev, accentFontSize: Number(e.target.value) }))}
                              className="flex-1 accent-indigo-600" />
                          </div>
                          <div className="rounded-lg px-3 py-1.5 bg-white border border-gray-200">
                            <div className="uppercase tracking-widest font-bold" style={{ color: cover.accentTextColor, fontSize: `${cover.accentFontSize || 10}px` }}>PREPARED FOR</div>
                            <div className="mt-0.5" style={{ color: cover.accentTextColor, fontSize: `${cover.accentFontSize || 10}px` }}>Organisation · email@example.com</div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Full live colour preview */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">👁️ Live Colour Preview</label>
                      <div className="rounded-xl overflow-hidden border border-gray-200 shadow-sm">
                        <div className="px-4 py-3 flex items-center gap-3" style={{ backgroundColor: cover.primaryColor }}>
                          {/* Logo */}
                          <img
                            src={cover.logoData || DEFAULT_LOGO_DATA}
                            alt="Logo"
                            style={{ height: `${cover.logoSize || 80}px`, width: `${cover.logoSize || 80}px`, objectFit: 'contain', borderRadius: '10px', flexShrink: 0 }}
                          />
                          {/* Company name + tagline — centered */}
                          <div className="flex-1 text-center">
                            <div className="font-bold" style={{ color: cover.headerTextColor, fontSize: `${cover.headerFontSize || 20}px` }}>{cover.companyName || 'Your Company Name'}</div>
                            <div className="mt-0.5" style={{ color: cover.headerTextColor + 'cc', fontSize: `${cover.taglineFontSize || 14}px` }}>{cover.companyTagline || 'Tagline'}</div>
                          </div>
                          {/* Report number */}
                          <div className="text-right bg-white/10 rounded-lg px-3 py-1.5 shrink-0">
                            <div className="text-xs" style={{ color: cover.headerTextColor + 'aa' }}>Report No.</div>
                            <div className="font-mono font-bold text-sm" style={{ color: cover.headerTextColor }}>{cover.reportNumber}</div>
                          </div>
                        </div>
                        <div className="bg-white p-4">
                          <div className="text-xs uppercase tracking-widest font-bold mb-1" style={{ color: cover.titleTextColor }}>{cover.reportTypeLabel || 'Road & Storm Water Inspection'}</div>
                          <div className="font-bold border-b-2 pb-2 mb-3" style={{ fontSize: `${cover.titleFontSize || 30}px`, color: cover.titleTextColor, borderColor: cover.primaryColor }}>
                            {cover.reportTitle || form.title || 'Report Title'}
                          </div>
                          {cover.reportSubtitle && <div className="italic mb-3" style={{ fontSize: `${cover.subtitleFontSize || 16}px`, color: cover.accentTextColor }}>{cover.reportSubtitle}</div>}
                          {cover.coverBodyText && <div className="leading-relaxed mt-3 mb-3 whitespace-pre-wrap" style={{ fontSize: `${cover.bodyFontSize || 13}px`, color: cover.bodyTextColor }}>{cover.coverBodyText}</div>}
                          <div className="grid grid-cols-2 gap-2 mb-3">
                            <div className="bg-gray-50 rounded-lg p-2">
                              <div className="uppercase tracking-wide font-bold mb-0.5" style={{ color: cover.accentTextColor, fontSize: `${cover.accentFontSize || 10}px` }}>Prepared For</div>
                              <div className="font-semibold" style={{ color: cover.bodyTextColor, fontSize: `${cover.bodyFontSize || 13}px` }}>{cover.preparedFor || selClient?.name || 'Client Name'}</div>
                            </div>
                            <div className="bg-gray-50 rounded-lg p-2">
                              <div className="uppercase tracking-wide font-bold mb-0.5" style={{ color: cover.accentTextColor, fontSize: `${cover.accentFontSize || 10}px` }}>Prepared By</div>
                              <div className="font-semibold" style={{ color: cover.bodyTextColor, fontSize: `${cover.bodyFontSize || 13}px` }}>{cover.preparedBy || 'Inspector Name'}</div>
                            </div>
                          </div>
                          {cover.coverNotes && (
                            <div className="bg-amber-50 border border-amber-200 rounded-lg p-2">
                              <div className="text-xs font-bold text-amber-700 mb-1">NOTES</div>
                              <div style={{ fontSize: `${cover.bodyFontSize || 13}px`, color: cover.bodyTextColor }}>{cover.coverNotes}</div>
                            </div>
                          )}
                        </div>
                        <div style={{ backgroundColor: cover.primaryColor, height: '6px' }} />
                      </div>
                      <p className="text-xs text-gray-400 mt-2 text-center">Updates in real time • Switch to "👁️ Live Preview" tab for full report preview</p>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">🖼️ Company Logo</label>
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-xs text-gray-500 whitespace-nowrap">Logo Size: {cover.logoSize || 80}px</span>
                        <input type="range" min={40} max={180} step={4} value={cover.logoSize || 80}
                          onChange={e => setCover(prev => ({ ...prev, logoSize: Number(e.target.value) }))}
                          className="flex-1 accent-indigo-600" />
                      </div>
                      {/* Always show a logo preview — default app icon if none uploaded */}
                      <div className="flex items-center gap-3 mb-3">
                        <img
                          src={cover.logoData || DEFAULT_LOGO_DATA}
                          alt="Logo"
                          className="h-16 w-16 object-contain border border-gray-200 rounded-xl p-1.5 bg-white shadow-sm"
                        />
                        <div className="text-xs text-gray-500">
                          {cover.logoData
                            ? <span className="text-emerald-600 font-semibold">✅ Custom logo uploaded</span>
                            : <span className="text-indigo-500 font-semibold">Using default RSW app icon</span>
                          }
                        </div>
                      </div>
                      {cover.logoData ? (
                        <button onClick={() => setCover(prev => ({ ...prev, logoData: '' }))} className="btn-secondary text-sm w-full mb-2">↩ Revert to Default Logo</button>
                      ) : null}
                      <label className="flex items-center justify-center gap-2 border-2 border-dashed border-gray-300 rounded-xl p-4 cursor-pointer hover:border-indigo-400 hover:bg-indigo-50 transition">
                        <span className="text-xl">🖼️</span>
                        <div className="text-sm">
                          <span className="text-indigo-600 font-medium">{cover.logoData ? 'Replace logo' : 'Upload custom logo'}</span>
                          <span className="text-gray-500"> — PNG, JPG, SVG</span>
                        </div>
                        <input type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" />
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {/* ── OPTIONS TAB ── */}
              {coverTab === 'options' && (
                <div className="card space-y-6">
                  <h2 className="font-semibold text-gray-900">Report Options</h2>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Detail Level</label>
                    <div className="grid grid-cols-3 gap-3">
                      {(['summary', 'standard', 'detailed'] as const).map(level => (
                        <button key={level} onClick={() => setForm({ ...form, detailLevel: level })}
                          className={`p-4 rounded-xl border-2 text-sm font-medium transition ${form.detailLevel === level ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                          {level === 'summary' ? '📄 Summary' : level === 'standard' ? '📋 Standard' : '📖 Detailed'}
                          <p className="text-xs font-normal mt-1.5 leading-snug">
                            {level === 'summary' ? 'Table overview only' : level === 'standard' ? 'With descriptions & photos' : 'Full detail with GPS & all data'}
                          </p>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Include in Report</label>
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { key: 'includePhotos', label: 'Photos', icon: '📷' },
                        { key: 'includeComments', label: 'Comments', icon: '💬' },
                        { key: 'includeMaps', label: 'Map Pins', icon: '🗺️' },
                      ].map(opt => (
                        <button key={opt.key}
                          onClick={() => setForm({ ...form, [opt.key]: !form[opt.key as keyof typeof form] })}
                          className={`flex items-center justify-between p-3 rounded-xl border-2 transition ${form[opt.key as keyof typeof form] ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200 bg-gray-50'}`}>
                          <span className="text-sm">{opt.icon} {opt.label}</span>
                          <div className={`relative w-9 h-5 rounded-full transition ${form[opt.key as keyof typeof form] ? 'bg-indigo-600' : 'bg-gray-300'}`}>
                            <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form[opt.key as keyof typeof form] ? 'translate-x-4' : 'translate-x-0.5'}`} />
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                  {inspTypes.length > 0 && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Filter by Inspection Type</label>
                      <p className="text-xs text-gray-500 mb-3">Leave empty to include all types.</p>
                      <div className="flex flex-wrap gap-2">
                        {inspTypes.map(t => (
                          <button key={t.id} onClick={() => toggleCategory(t.name)}
                            className={`badge cursor-pointer transition border ${form.categories.includes(t.name) ? 'text-white border-transparent' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 border-gray-200'}`}
                            style={form.categories.includes(t.name) ? { backgroundColor: t.color } : {}}>
                            {t.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── INSPECTIONS TAB ── */}
              {coverTab === 'inspections' && (
                <div className="card">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="font-semibold text-gray-900">
                      Select Inspections
                      <span className="ml-2 text-sm font-normal text-gray-500">
                        ({form.inspectionIds.filter(id => data.inspections.some(i => i.id === id)).length} of {data.inspections.length} selected)
                      </span>
                    </h2>
                    <div className="flex gap-2">
                      <button onClick={selectAllInspections} className="text-indigo-600 text-sm font-medium hover:text-indigo-800">Select All</button>
                      <button onClick={() => setForm({ ...form, inspectionIds: [] })} className="text-gray-500 text-sm hover:text-gray-700">Clear</button>
                    </div>
                  </div>
                  {/* Search — shows all inspections newest-first; filters as you type */}
                  <div className="mb-3">
                    <input
                      className="input-field"
                      placeholder="🔍 Search by title, location or type..."
                      value={inspSearch}
                      onChange={e => setInspSearch(e.target.value)}
                    />
                    {inspSearch && (
                      <p className="text-xs text-gray-400 mt-1">{filteredInsp.length} result{filteredInsp.length !== 1 ? 's' : ''} — sorted newest first</p>
                    )}
                  </div>
                  {filteredInsp.length === 0 ? (
                    <div className="text-center py-8">
                      <p className="text-3xl mb-2">🔍</p>
                      <p className="text-gray-400 text-sm">No inspections match the selected filters.</p>
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
                      {filteredInsp.map(ins => {
                        const pinCount = (ins.mapPins?.length || 0) + (ins.mapId && !ins.mapPins?.length ? 1 : 0);
                        return (
                          <label key={ins.id}
                            className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer transition border ${form.inspectionIds.includes(ins.id) ? 'bg-indigo-50 border-indigo-200' : 'bg-gray-50 border-transparent hover:bg-gray-100'}`}>
                            <input type="checkbox" checked={form.inspectionIds.includes(ins.id)}
                              onChange={() => toggleInspection(ins.id)} className="w-4 h-4 text-indigo-600 rounded" />
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-sm text-gray-900 truncate">{ins.title}</div>
                              <div className="text-xs text-gray-500 flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                                <span>{ins.type || 'No type'}</span>
                                <span>{ins.date}</span>
                                {ins.condition && <span>{ins.condition}</span>}
                                {ins.location && <span>📍 {ins.location}</span>}
                              </div>
                            </div>
                            <div className="flex gap-2 text-xs text-gray-400 shrink-0">
                              {ins.photos.length > 0 && <span>📷{ins.photos.length}</span>}
                              {ins.comments.length > 0 && <span>💬{ins.comments.length}</span>}
                              {pinCount > 0 && <span className="text-indigo-500">🗺️{pinCount}</span>}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── SIDEBAR ── */}
            <div className="space-y-4">
              <div className="card">
                <h3 className="font-semibold text-gray-900 mb-3">Actions</h3>
                <div className="space-y-2">
                  {saveMsg && <div className="p-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">{saveMsg}</div>}
                  <button onClick={() => handleSave()} className="btn-primary w-full">💾 {editingReport ? 'Save Changes' : 'Save & Continue Editing'}</button>
                  <button onClick={() => handleSave('final')} className="btn-success w-full">✅ Save & Finalize</button>
                  <button onClick={() => setCoverTab('preview')} className="btn-secondary w-full">👁️ Live Preview</button>
                  <button onClick={() => setView('list')} className="btn-secondary w-full">Cancel</button>
                </div>
              </div>

              <div className="card">
                <h3 className="font-semibold text-gray-900 mb-3">Summary</h3>
                <div className="space-y-2 text-sm text-gray-600">
                  <div className="flex justify-between"><span>Inspections</span><strong>{form.inspectionIds.filter(id => data.inspections.some(i => i.id === id)).length}</strong></div>
                  <div className="flex justify-between"><span>Detail Level</span><strong className="capitalize">{form.detailLevel}</strong></div>
                  <div className="flex justify-between"><span>📷 Photos</span><strong>{form.includePhotos ? 'Yes' : 'No'}</strong></div>
                  <div className="flex justify-between"><span>💬 Comments</span><strong>{form.includeComments ? 'Yes' : 'No'}</strong></div>
                  <div className="flex justify-between"><span>🗺️ Map Pins</span><strong>{form.includeMaps ? 'Yes' : 'No'}</strong></div>
                  {form.inspectionIds.length > 0 && (() => {
                    const sel = data.inspections.filter(i => form.inspectionIds.includes(i.id)) as Inspection[];
                    return (
                      <div className="border-t border-gray-100 pt-2 mt-2 space-y-1">
                        <div className="flex justify-between text-xs"><span>Total Photos</span><strong>{sel.reduce((a, i) => a + i.photos.length, 0)}</strong></div>
                        <div className="flex justify-between text-xs"><span>Total Comments</span><strong>{sel.reduce((a, i) => a + i.comments.length, 0)}</strong></div>
                        <div className="flex justify-between text-xs"><span>Total Map Pins</span><strong>{sel.reduce((a, i) => a + (i.mapPins?.length || (i.mapId ? 1 : 0)), 0)}</strong></div>
                      </div>
                    );
                  })()}
                </div>
              </div>

              <div className="card" style={{ borderLeft: `4px solid ${cover.primaryColor}` }}>
                <h3 className="font-semibold text-gray-900 mb-2">🎨 Cover Preview</h3>
                <div className="text-xs text-gray-600 space-y-1">
                  <div><span className="text-gray-400">Company:</span> {cover.companyName || '—'}</div>
                  <div><span className="text-gray-400">Prepared for:</span> {cover.preparedFor || selClient?.name || '—'}</div>
                  <div><span className="text-gray-400">Report #:</span> {cover.reportNumber}</div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-400">Colour:</span>
                    <span className="w-4 h-4 rounded-full inline-block border border-gray-200" style={{ backgroundColor: cover.primaryColor }} />
                    <span className="font-mono text-xs">{cover.primaryColor}</span>
                  </div>
                  <div className={cover.logoData ? "text-green-600" : "text-indigo-400"}>
                    {cover.logoData ? "✅ Custom logo" : "🖼️ Default RSW logo"}
                  </div>
                </div>
                <button onClick={() => setCoverTab('cover')} className="mt-3 text-xs text-indigo-600 hover:text-indigo-800 font-medium">Edit Cover Page →</button>
              </div>

              {/* Quick preview snippet */}
              {livePreviewHtml && (
                <div className="card">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold text-gray-900 text-sm">👁️ Preview</h3>
                    <button onClick={() => setCoverTab('preview')} className="text-xs text-indigo-600 hover:text-indigo-800">Full Preview →</button>
                  </div>
                  <div className="rounded-lg overflow-hidden border border-gray-200" style={{ height: '200px' }}>
                    <iframe srcDoc={livePreviewHtml} className="w-full h-full border-0 pointer-events-none" style={{ transform: 'scale(0.35)', transformOrigin: 'top left', width: '286%', height: '286%' }} title="Mini preview" sandbox="allow-scripts allow-same-origin" />
                  </div>
                  <p className="text-xs text-gray-400 mt-1 text-center">Updates as you type</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {/* ── Save Template Modal ── */}
      {showSaveTemplate && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowSaveTemplate(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-1">💾 Save Cover as Template</h2>
            <p className="text-sm text-gray-500 mb-4">Save the current cover page style to reuse on future reports.</p>
            <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl border border-gray-200 mb-4">
              <div className="w-8 h-8 rounded-lg shrink-0 border border-gray-200" style={{ backgroundColor: cover.primaryColor }} />
              <div className="text-sm text-gray-700">
                <div className="font-semibold">{cover.companyName || 'No company name'}</div>
                <div className="text-xs text-gray-400 font-mono">{cover.primaryColor} · {cover.reportTypeLabel || 'Road & Storm Water Inspection'}</div>
              </div>
            </div>
            {/* Update existing template option */}
            {(data.coverTemplates || []).length > 0 && (
              <div className="mb-4 p-3 bg-indigo-50 rounded-xl border border-indigo-100">
                <p className="text-xs font-semibold text-indigo-700 mb-2">⟳ Update an existing template instead?</p>
                <select
                  className="input-field text-sm"
                  defaultValue=""
                  onChange={e => {
                    if (!e.target.value) return;
                    const tpl = (data.coverTemplates || []).find(t => t.id === e.target.value);
                    if (!tpl) return;
                    const { logoData: _logo, ...coverNoLogo } = cover;
                    updateCoverTemplate({
                      ...tpl,
                      cover: {
                        ...tpl.cover,
                        ...coverNoLogo,
                        logoData: '',
                        reportTypeLabel: coverNoLogo.reportTypeLabel || 'Road & Storm Water Inspection',
                      },
                    });
                    setShowSaveTemplate(false);
                  }}
                >
                  <option value="">— select template to overwrite —</option>
                  {(data.coverTemplates || []).map(t => (
                    <option key={t.id} value={t.id}>{t.name}{t.clientName ? ` (${t.clientName})` : ''}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-400 mt-1">This will overwrite that template's cover design with the current settings.</p>
              </div>
            )}
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Template Name <span className="text-red-500">*</span> <span className="text-xs text-gray-400 font-normal">(for new template)</span></label>
                <input className="input-field" placeholder="e.g. Unicus Blue, WDC Green"
                  value={saveTplForm.name} onChange={e => setSaveTplForm(p => ({ ...p, name: e.target.value }))} autoFocus />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <input className="input-field" placeholder="Optional notes"
                  value={saveTplForm.description} onChange={e => setSaveTplForm(p => ({ ...p, description: e.target.value }))} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Assign to Client</label>
                <select className="input-field" value={saveTplForm.clientId}
                  onChange={e => setSaveTplForm(p => ({ ...p, clientId: e.target.value }))}>
                  <option value="">🌐 Global (all clients)</option>
                  {data.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <p className="text-xs text-gray-400 mt-1">Client templates appear first in the dropdown for that client's reports.</p>
              </div>
              <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">📎 Logos are not saved in templates — re-upload after loading if needed.</p>
              <div className="flex gap-3 pt-2">
                <button onClick={() => setShowSaveTemplate(false)} className="btn-secondary flex-1">Cancel</button>
                <button
                  disabled={!saveTplForm.name.trim()}
                  onClick={() => {
                    if (!saveTplForm.name.trim()) return;
                    setShowSaveTemplate(false);
                    const client = data.clients.find(c => c.id === saveTplForm.clientId);
                    const { logoData: _logo, ...coverNoLogo } = cover;
                    addCoverTemplate({
                      name: saveTplForm.name.trim(),
                      description: saveTplForm.description.trim(),
                      clientId: saveTplForm.clientId,
                      clientName: client?.name || '',
                      cover: {
                        ...coverNoLogo,
                        logoData: '',
                        reportTypeLabel: coverNoLogo.reportTypeLabel || 'Road & Storm Water Inspection',
                      },
                    });
                  }}
                  className="btn-primary flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
                >💾 Save Template</button>
              </div>
            </div>
          </div>
        </div>
      )}
      </>
    );
  }

  // ─── LIST VIEW ────────────────────────────────────────────────────────────
  const filtered = data.reports
    .filter(r => r.title.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="space-y-6" onClick={() => downloadMenuId && setDownloadMenuId(null)}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Reports</h1>
          <p className="text-gray-500 text-sm mt-1">Generate, view, and download inspection reports</p>
        </div>
        <button onClick={openNew} className="btn-primary">+ Generate Report</button>
      </div>



      {pdfGenerating && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
          <div className="bg-white rounded-2xl p-8 shadow-2xl flex flex-col items-center gap-4">
            <div className="animate-spin text-4xl">⏳</div>
            <p className="text-lg font-semibold">Generating PDF...</p>
            <p className="text-sm text-gray-500">This may take a moment for large reports</p>
          </div>
        </div>
      )}

      <div className="card">
        <input className="input-field mb-4" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="🔍 Search reports..." />

        {filtered.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-4xl mb-3">📊</p>
            <p className="text-gray-500 mb-4">No reports yet. Generate your first report.</p>
            <button onClick={openNew} className="btn-primary">Generate Report</button>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map(report => {
              const client = data.clients.find(c => c.id === report.clientId);
              // Only count IDs that still exist — stale IDs from deleted inspections otherwise ghost here
              const selInsp = data.inspections.filter(i => report.inspectionIds.includes(i.id)) as Inspection[];
              const inspCount = selInsp.length;
              const totalPhotos = selInsp.reduce((a, i) => a + i.photos.length, 0);
              const totalPins = selInsp.reduce((a, i) => a + (i.mapPins?.length || (i.mapId ? 1 : 0)), 0);
              const cv = getCoverForReport(report);

              return (
                <div key={report.id} className="border border-gray-200 rounded-xl p-4 hover:shadow-md transition" style={{ borderLeft: `4px solid ${cv.primaryColor || '#1e3a5f'}` }}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <h3 className="font-semibold text-gray-900">{report.title}</h3>
                        <span className={`badge ${report.status === 'final' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'}`}>
                          {report.status}
                        </span>
                        {cv.reportNumber && <span className="text-xs font-mono text-gray-400">#{cv.reportNumber}</span>}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                        <span>📅 {report.date}</span>
                        <span>📋 {inspCount} inspection{inspCount !== 1 ? 's' : ''}</span>
                        <span>📊 {report.detailLevel}</span>
                        {totalPhotos > 0 && <span>📷 {totalPhotos}</span>}
                        {totalPins > 0 && <span className="text-indigo-600">🗺️ {totalPins} pins</span>}
                        {client && <span>🏢 {client.name}</span>}
                        <span>👤 {report.createdBy}</span>
                      </div>
                    </div>
                    <div className="flex gap-1 shrink-0 items-center">
                      <button onClick={() => { setPreviewReport(report); setPreviewCover(getCoverForReport(report)); setView('preview'); }}
                        className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition" title="Preview">👁️</button>

                      <div className="relative" ref={downloadMenuId === report.id ? downloadMenuRef : undefined}>
                        <button onClick={e => { e.stopPropagation(); setDownloadMenuId(downloadMenuId === report.id ? null : report.id); }}
                          className="p-2 rounded-lg hover:bg-blue-50 text-gray-500 hover:text-blue-600 transition" title="Download">📥</button>
                        {downloadMenuId === report.id && (
                          <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-xl z-50 w-52 py-1"
                            onClick={e => e.stopPropagation()}>
                            <div className="px-3 py-2 border-b border-gray-100">
                              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Download As</p>
                            </div>
                            {[
                              { icon: '📄', label: 'PDF', desc: 'Best for printing', action: () => downloadPDF(report) },
                              { icon: '🌐', label: 'HTML', desc: 'Open in browser', action: () => downloadHTML(report) },
                              { icon: '📊', label: 'CSV', desc: 'Excel / Sheets', action: () => downloadCSV(report) },
                            ].map(opt => (
                              <button key={opt.label} onClick={() => { opt.action(); setDownloadMenuId(null); }}
                                className="w-full text-left px-3 py-2.5 text-sm hover:bg-blue-50 flex items-center gap-3 transition">
                                <span className="text-lg">{opt.icon}</span>
                                <div><div className="font-medium text-gray-900">{opt.label}</div><div className="text-xs text-gray-500">{opt.desc}</div></div>
                              </button>
                            ))}
                            <div className="border-t border-gray-100 mt-1 pt-1">
                              <button onClick={() => { handlePrint(report); setDownloadMenuId(null); }}
                                className="w-full text-left px-3 py-2.5 text-sm hover:bg-blue-50 flex items-center gap-3 transition">
                                <span className="text-lg">🖨️</span>
                                <div><div className="font-medium text-gray-900">Print</div><div className="text-xs text-gray-500">Send to printer</div></div>
                              </button>
                            </div>
                          </div>
                        )}
                      </div>

                      <button onClick={() => openEdit(report)} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition" title="Edit">✏️</button>
                      <button onClick={() => { if (confirm('Delete this report?')) deleteReport(report.id); }}
                        className="p-2 rounded-lg hover:bg-red-50 text-gray-500 hover:text-red-600 transition" title="Delete">🗑️</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
