import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import * as React from 'react';
import { useStore } from '../../store';
import { compressImage } from '../../utils/imageCompress';
import { localDateKey, formatDMY } from '../../utils/date';
import { getRoadRunEntries, summariseRunEntries, hasSegmentRunData } from '../../utils/segmentStats';
import { simplifyPath } from '../../utils/simplifyPath';
import type {
  SweepArea, SweepRoad, SweepZone, SweepZoneKind, SweepSubZone, SweepJob, SweepJobRoad, SegmentRunDetail,
  DamagePin, DamagePinType, DamageSeverity, RoadPoint, RouteSegment, TurnaroundPoint,
} from '../../types';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
// v73.70 — adds dragging support to canvas-rendered L.CircleMarker (Leaflet
// core only supports it for L.Marker). Used by the large-segment canvas
// point-marker fix in the road editor below (freeze/lag fix, part D).
import 'leaflet-path-drag';

const uid = () => crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
const nowStr = () => new Date().toISOString();
const todayStr = () => localDateKey();

// v73.71 — shared sizing for the translucent "zone" road highlight (Craig's
// concept screenshot: a soft band over the road, wide enough to cover both
// sides, road name still legible on top). Pixel-based (Leaflet polyline
// weight, not a geographic buffer) — deliberately simple: it's a visual
// highlight, not a real road-width measurement, and scales like every other
// line weight in this app already does on zoom.
const ROAD_ZONE_HIGHLIGHT_WEIGHT = 16;
const ROAD_ZONE_HIGHLIGHT_OPACITY = 0.28;

// Convert HH:MM (24h) → h:MM AM/PM for display
function to12h(t: string | undefined): string {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Forced 12-hour time picker — works regardless of OS/browser locale
function TimeInput12h({ value, onChange, className = '' }: {
  value: string;           // HH:MM (24h) or ''
  onChange: (v: string) => void;  // emits HH:MM (24h) or ''
  className?: string;
}) {
  // Parse stored 24h value
  let initH = 12, initM = 0, initAmpm: 'AM' | 'PM' = 'AM';
  if (value) {
    const [hh, mm] = value.split(':').map(Number);
    initAmpm = hh >= 12 ? 'PM' : 'AM';
    initH = hh % 12 || 12;
    initM = mm;
  }
  const [hour, setHour]     = React.useState(value ? String(initH) : '');
  const [min,  setMin]      = React.useState(value ? String(initM).padStart(2, '0') : '00');
  const [ampm, setAmpm]     = React.useState<'AM' | 'PM'>(initAmpm);

  // Re-sync if parent value changes (e.g. reset)
  React.useEffect(() => {
    if (!value) { setHour(''); setMin('00'); setAmpm('AM'); return; }
    const [hh, mm] = value.split(':').map(Number);
    setAmpm(hh >= 12 ? 'PM' : 'AM');
    setHour(String(hh % 12 || 12));
    setMin(String(mm).padStart(2, '0'));
  }, [value]);

  const emit = (h: string, m: string, ap: 'AM' | 'PM') => {
    if (!h) { onChange(''); return; }
    let hh = parseInt(h, 10) % 12;
    if (ap === 'PM') hh += 12;
    onChange(`${String(hh).padStart(2, '0')}:${m}`);
  };

  const baseInput = `input-field text-sm text-center ${className}`;
  return (
    <div className="flex items-center gap-1">
      {/* Hour 1–12 */}
      <input
        type="number" min={1} max={12}
        className={baseInput}
        style={{ width: 52 }}
        placeholder="hh"
        value={hour}
        onChange={e => {
          const v = e.target.value;
          setHour(v);
          emit(v, min, ampm);
        }}
      />
      <span className="text-gray-500 font-bold select-none">:</span>
      {/* Minute 00–59 */}
      <select
        className={baseInput}
        style={{ width: 60 }}
        value={min}
        onChange={e => { setMin(e.target.value); emit(hour, e.target.value, ampm); }}
      >
        {Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0')).map(m => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
      {/* AM / PM toggle */}
      <div className="flex rounded-lg overflow-hidden border border-gray-300 text-xs font-semibold" style={{ height: 36 }}>
        {(['AM', 'PM'] as const).map(ap => (
          <button key={ap} type="button"
            onClick={() => { setAmpm(ap); emit(hour, min, ap); }}
            className={`px-2 transition-colors ${ampm === ap ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
          >{ap}</button>
        ))}
      </div>
    </div>
  );
}

// ─── Haversine distance (metres between two GPS points) ───────────────────────
function haversine(a: RoadPoint, b: RoadPoint): number {
  const R = 6371000;
  const φ1 = (a.lat * Math.PI) / 180, φ2 = (b.lat * Math.PI) / 180;
  const Δφ = ((b.lat - a.lat) * Math.PI) / 180;
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// v73.41 — Craig: "ctrl + drag box not always capturing everything." The
// box-select hit-test only ever checked whether a point/vertex fell INSIDE
// the box — a long edge that passes straight through the box without
// either endpoint landing inside it (common on real-road-routed paths,
// which can have long, sparse edges) was silently missed. Standard
// Liang-Barsky segment-vs-axis-aligned-box clipping test: returns true if
// the segment A→B intersects the box at all, not just if an endpoint sits
// inside it. Bounds are treated as axis-aligned in lat/lng — an
// approximation of the screen-rectangle's true (slightly non-rectangular
// at high zoom, due to map projection) shape, but close enough for a
// selection tool, and it's the same approximation `L.LatLngBounds` and the
// existing point-in-bounds check already made.
function segmentIntersectsBounds(a: RoadPoint, b: RoadPoint, bounds: L.LatLngBounds): boolean {
  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  const minX = sw.lng, maxX = ne.lng, minY = sw.lat, maxY = ne.lat;
  let t0 = 0, t1 = 1;
  const dx = b.lng - a.lng, dy = b.lat - a.lat;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0; // parallel to this boundary — reject only if outside
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  if (!clip(-dx, a.lng - minX)) return false;
  if (!clip(dx, maxX - a.lng)) return false;
  if (!clip(-dy, a.lat - minY)) return false;
  if (!clip(dy, maxY - a.lat)) return false;
  return t0 <= t1;
}

function polylineLength(pts: RoadPoint[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1], pts[i]);
  return d;
}

// v73.39 — used by saveRoad() to decide whether a segment's `points` actually
// changed since it was loaded, so `updatedAt` only gets bumped for segments
// genuinely touched this session — an untouched segment keeps its original
// timestamp, which is what lets the host-server's id-based segment merge
// resolve concurrent edits by real recency instead of always favouring
// whichever device happened to save last.
function pointsDeepEqual(a: RoadPoint[] | undefined, b: RoadPoint[] | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].lat !== b[i].lat || a[i].lng !== b[i].lng || (a[i].transitAfter === true) !== (b[i].transitAfter === true)) return false;
  }
  return true;
}

// v73.100 — same purpose as pointsDeepEqual above, for a segment's
// turnarounds array (order and coordinates both matter; id doesn't, since a
// dragged marker keeps its id).
function turnaroundsDeepEqual(a: TurnaroundPoint[] | undefined, b: TurnaroundPoint[] | undefined): boolean {
  const aa = a || [], bb = b || [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) {
    if (aa[i].lat !== bb[i].lat || aa[i].lng !== bb[i].lng) return false;
  }
  return true;
}

// v73.108 — Explicit type guards, added per Craig's audit spec as
// belt-and-suspenders (see TurnaroundPoint.type comment in types.ts for why
// this app's data model didn't structurally need them — turnarounds and
// segments have always lived in separate arrays, never a shared list that
// needs filtering by type). `isTurnaroundPoint` is deliberately lenient
// about a missing `.type` (shape-checks lat/lng instead) so it still
// recognises turnaround points saved by v73.100–v73.107, before the
// discriminant tag existed — a strict `=== 'turnaround'` check would wrongly
// reject every turnaround point saved before this release.
function isTurnaroundPoint(item: any): item is TurnaroundPoint {
  return !!item && typeof item.lat === 'number' && typeof item.lng === 'number'
    && typeof item.id === 'string' && item.type !== 'route-segment';
}
function isRouteSegment(item: any): item is RouteSegment {
  return !!item && Array.isArray(item.points) && typeof item.id === 'string' && item.type !== 'turnaround';
}
// v73.108 — used at save time as a last-line assertion: strips anything
// turnaround-shaped out of the segments array before it's written, so even
// a hypothetical future bug that pushed a turnaround into `roadSegments`
// can't actually reach saved data. Never expected to filter anything in
// normal operation — see the changelog for the full audit trail confirming
// nothing in this codebase ever mixes the two today.
function assertRouteSegmentsOnly(items: RouteSegment[]): RouteSegment[] {
  return items.filter(isRouteSegment);
}

function fmtMetres(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

function fmtTime(iso: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Date format helpers — store & display as DD-MM-YYYY ───────────────────────
// The native date picker uses YYYY-MM-DD internally; we convert on the way
// in and out so the stored value is always DD-MM-YYYY.
function toInputDate(ddmmyyyy: string | undefined): string {
  if (!ddmmyyyy || ddmmyyyy.length !== 10) return '';
  const [dd, mm, yyyy] = ddmmyyyy.split('-');
  if (!dd || !mm || !yyyy) return '';
  return `${yyyy}-${mm}-${dd}`;   // YYYY-MM-DD for <input type="date">
}
function fromInputDate(yyyymmdd: string): string | undefined {
  if (!yyyymmdd || yyyymmdd.length !== 10) return undefined;
  const [yyyy, mm, dd] = yyyymmdd.split('-');
  if (!dd || !mm || !yyyy) return undefined;
  return `${dd}-${mm}-${yyyy}`;   // DD-MM-YYYY for storage & display
}
// Compare two DD-MM-YYYY strings safely
function dateAfter(a: string, b: string): boolean {
  return toInputDate(a) > toInputDate(b);
}

const AREA_COLORS = ['#6366F1','#0891B2','#059669','#D97706','#DC2626','#7C3AED','#BE185D','#0D9488','#92400E','#1D4ED8'];




// ─── Empty helpers ──────────────────────────────────────────────────────────
const emptyArea = (): Omit<SweepArea, 'id' | 'createdAt' | 'updatedAt'> => ({
  name: '', description: '', color: AREA_COLORS[0], zoneType: '', roadIds: [],
});

const emptyRoad = (areaId = ''): Omit<SweepRoad, 'id' | 'createdAt' | 'updatedAt'> => ({
  name: '', areaId, points: [], lengthMetres: 0, notes: '', segments: undefined, color: undefined, showNumbers: true, showMarkers: true,
});

const emptyJobRoad = (roadId: string, road?: SweepRoad): SweepJobRoad => ({
  roadId,
  coverageMethod: 'full',
  metresSwept: 0,  // starts at 0 — recalculated when coverage method/slider is set
  damagePins: [],
  passCount: 1,
  debrisLevel: '',
  debrisType: '',
  weather: '',
  notes: '',
});

const emptyJob = (): Omit<SweepJob, 'id' | 'createdAt' | 'updatedAt'> => ({
  jobNumber: `SWP-${Date.now().toString().slice(-6)}`,
  title: '',
  status: 'planned',
  clientId: '',
  areaIds: [],
  zoneIds: [],
  roads: [],
  crewMember: '',
  equipment: '',
  date: todayStr(),
  startDate: undefined,
  finishDate: undefined,
  startTime: '',
  endTime: '',
  weather: '',
  notes: '',
  siteId: '',
  fileIds: [],
  fuelDockets: [],
  extraExpenses: [],
  tipRuns: [],
});

// ─── Leaflet map for road drawing ─────────────────────────────────────────────
// Supports: click to add, drag to move, click-popup to delete, midpoint insert.
// Cursors: crosshair (drawing), move (on point), grabbing (dragging), default (readOnly).
// ──────────────────────────────────────────────────────────────────────────────
interface RoadMapProps {
  points: RoadPoint[];
  onChange: (pts: RoadPoint[]) => void;
  readOnly?: boolean;
  color?: string;
  height?: number;
  showNumbers?: boolean;
  showMarkers?: boolean;
  // For read-only multi-segment display — extra segments drawn as same-style lines
  extraSegments?: RoadPoint[][];
  // Per-segment colour overrides for read-only display (index 0 = extraSegments[0], etc.)
  extraSegmentColors?: string[];
}

function RoadMap({ points, onChange, readOnly = false, color = '#6366F1', height = 460, showNumbers = true, showMarkers = true, extraSegments = [], extraSegmentColors = [] }: RoadMapProps) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const mapRef        = useRef<L.Map | null>(null);
  const polyRef       = useRef<L.Polyline | null>(null);
  const extraPolyRef  = useRef<L.Polyline[]>([]);
  const mainMkRef     = useRef<L.Marker[]>([]);
  const midMkRef      = useRef<L.Marker[]>([]);
  // Always-current refs (avoids stale closures in Leaflet event handlers)
  const livePointsRef = useRef<RoadPoint[]>(points);
  const onChangeRef   = useRef(onChange);
  const colorRef      = useRef(color);
  const readOnlyRef   = useRef(readOnly);
  const showNumbersRef = useRef(showNumbers);
  const showMarkersRef = useRef(showMarkers);
  // Stable handle to the rebuild function so event handlers can call it
  const rebuildRef    = useRef<(pts: RoadPoint[]) => void>(() => {});

  useEffect(() => { livePointsRef.current = points; },  [points]);
  useEffect(() => { onChangeRef.current   = onChange; }, [onChange]);
  useEffect(() => { colorRef.current      = color; },   [color]);
  useEffect(() => { readOnlyRef.current   = readOnly; }, [readOnly]);
  useEffect(() => { showNumbersRef.current = showNumbers; }, [showNumbers]);
  useEffect(() => { showMarkersRef.current = showMarkers; }, [showMarkers]);

  // ── Map initialisation (re-runs only when readOnly or color changes) ─────
  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) { try { mapRef.current.remove(); } catch { /**/ } mapRef.current = null; }

    const initPts = livePointsRef.current;
    const defaultCenter: [number, number] = initPts.length > 0
      ? [initPts[0].lat, initPts[0].lng]
      : [-36.8485, 174.7633]; // Auckland fallback

    const map = L.map(containerRef.current, {zoomSnap: 0.25, zoomDelta: 0.25, wheelPxPerZoomLevel: 120,  attributionControl: false, renderer: L.canvas({ tolerance: 8 }) })
      .setView(defaultCenter, 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap', maxZoom: 19,
    }).addTo(map);
    mapRef.current = map;

    // ── invalidateSize so Leaflet fills the container correctly when rendered
    // inside a modal, collapsed panel, or any initially-hidden element ─────
    setTimeout(() => { try { map.invalidateSize({ animate: false }); } catch { /**/ } }, 50);
    setTimeout(() => { try { map.invalidateSize({ animate: false }); } catch { /**/ } }, 250);

    // ── Apply crosshair cursor to THIS map only ──────────────────────────
    if (!readOnly) {
      map.getContainer().style.cursor = 'crosshair';
    }

    // ─────────────────────────────────────────────────────────────────────
    // REBUILD — clears and redraws polyline + all markers
    // ─────────────────────────────────────────────────────────────────────
    const rebuild = (pts: RoadPoint[]) => {
      const col = colorRef.current;
      const ro  = readOnlyRef.current;

      // Clear existing elements
      polyRef.current?.remove(); polyRef.current = null;
      mainMkRef.current.forEach(m => m.remove()); mainMkRef.current = [];
      midMkRef.current.forEach(m => m.remove());  midMkRef.current  = [];

      if (pts.length === 0) return;

      // Polyline
      if (pts.length > 1) {
        polyRef.current = L.polyline(
          pts.map(p => [p.lat, p.lng] as [number, number]),
          { color: col, weight: 4, opacity: 0.85 }
        ).addTo(map);
      }

      // ── Point markers (skip entirely if showMarkers=false) ────────────
      if (!showMarkersRef.current) return; // lines-only mode
      pts.forEach((p, i) => {
        const isFirst = i === 0, isLast = i === pts.length - 1;
        const bg  = isFirst ? '#059669' : isLast ? '#DC2626' : col;
        const sn  = showNumbersRef.current;
        const lbl = isFirst ? 'A' : isLast ? 'B' : (sn ? String(i + 1) : '·');

        const icon = L.divIcon({
          className: '',
          html: `<div style="
            width:22px;height:22px;border-radius:50%;
            background:${bg};border:2.5px solid white;
            box-shadow:0 2px 6px rgba(0,0,0,0.35);
            display:flex;align-items:center;justify-content:center;
            font-size:9px;font-weight:800;color:white;
            cursor:${ro ? 'default' : 'move'};
            user-select:none;pointer-events:all;
            transition:transform 0.1s;
          ">${lbl}</div>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        });

        const marker = L.marker([p.lat, p.lng], {
          icon,
          draggable: !ro,
          autoPan: false,
          zIndexOffset: 1000,
        }).addTo(map);

        if (!ro) {
          // ── DRAG — real-time polyline update ─────────────────────────
          marker.on('drag', () => {
            const ll = marker.getLatLng();
            const updated = livePointsRef.current.slice();
            updated[i] = { lat: ll.lat, lng: ll.lng };
            livePointsRef.current = updated;
            // Update polyline in real-time (no full rebuild needed)
            if (updated.length > 1) {
              polyRef.current?.setLatLngs(updated.map(pt => [pt.lat, pt.lng] as [number, number]));
            }
            // Set grabbing cursor on the map while dragging
            map.getContainer().style.cursor = 'grabbing';
          });

          marker.on('dragstart', () => {
            map.getContainer().style.cursor = 'grabbing';
          });

          marker.on('dragend', () => {
            // Snap the marker to its final position and commit
            const ll = marker.getLatLng();
            const updated = livePointsRef.current.slice();
            updated[i] = { lat: ll.lat, lng: ll.lng };
            livePointsRef.current = updated;
            onChangeRef.current(updated);
            rebuild(updated);               // full rebuild to fix midpoints & icons
            map.getContainer().style.cursor = 'crosshair';
          });

          // ── DELETE via popup (works on mobile + desktop) ──────────────
          const popEl = document.createElement('div');
          popEl.style.cssText = 'padding:2px 4px;text-align:center;min-width:130px;';
          const titleEl = document.createElement('p');
          titleEl.style.cssText = 'font-size:11px;font-weight:600;color:#374151;margin:0 0 6px;';
          titleEl.textContent = isFirst ? '🟢 Start (A)' : isLast ? '🔴 End (B)' : `Point ${i + 1}`;
          const delBtn = document.createElement('button');
          delBtn.textContent = '🗑️ Delete Point';
          delBtn.style.cssText = [
            'background:#fef2f2;color:#dc2626;',
            'border:1px solid #fecaca;border-radius:6px;',
            'padding:5px 12px;font-size:11px;font-weight:600;',
            'cursor:pointer;display:block;width:100%;',
          ].join('');
          delBtn.addEventListener('mouseenter', () => { delBtn.style.background = '#fee2e2'; });
          delBtn.addEventListener('mouseleave', () => { delBtn.style.background = '#fef2f2'; });
          delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const updated = livePointsRef.current.slice();
            updated.splice(i, 1);
            livePointsRef.current = updated;
            onChangeRef.current(updated);
            map.closePopup();
            rebuild(updated);
          });
          popEl.appendChild(titleEl);
          popEl.appendChild(delBtn);
          marker.bindPopup(popEl, { maxWidth: 170, closeButton: true });

          // Right-click = instant delete (desktop shortcut)
          marker.on('contextmenu', (e) => {
            L.DomEvent.stopPropagation(e);
            const updated = livePointsRef.current.slice();
            updated.splice(i, 1);
            livePointsRef.current = updated;
            onChangeRef.current(updated);
            rebuild(updated);
          });
        } else {
          // Read-only: tooltip only
          marker.bindTooltip(
            isFirst ? '🟢 Start (A)' : isLast ? '🔴 End (B)' : `Point ${i + 1}`,
            { direction: 'top' }
          );
        }

        mainMkRef.current.push(marker);
      });

      // ── Midpoint handles (click to insert a new point between two existing ones) ──
      if (!ro && pts.length > 1) {
        for (let j = 0; j < pts.length - 1; j++) {
          const midLat   = (pts[j].lat + pts[j + 1].lat) / 2;
          const midLng   = (pts[j].lng + pts[j + 1].lng) / 2;
          const insertAt = j + 1;

          const midIcon = L.divIcon({
            className: '',
            html: `<div style="
              width:14px;height:14px;border-radius:50%;
              background:white;border:2px solid #94a3b8;
              opacity:0.85;cursor:copy;
              box-shadow:0 1px 4px rgba(0,0,0,0.2);
            "></div>`,
            iconSize: [14, 14],
            iconAnchor: [7, 7],
          });

          const midMk = L.marker([midLat, midLng], {
            icon: midIcon,
            zIndexOffset: 500,
          }).addTo(map);

          midMk.bindTooltip(
            `➕ Insert point between ${j + 1} and ${j + 2}`,
            { direction: 'top', offset: [0, -8] }
          );

          midMk.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            const updated = livePointsRef.current.slice();
            updated.splice(insertAt, 0, { lat: midLat, lng: midLng });
            livePointsRef.current = updated;
            onChangeRef.current(updated);
            rebuild(updated);
          });

          midMkRef.current.push(midMk);
        }
      }
    }; // end rebuild

    rebuildRef.current = rebuild;
    rebuild(initPts);

    // ── Draw extra (read-only) segments for multi-segment display ─────────
    extraPolyRef.current.forEach(p => p.remove());
    extraPolyRef.current = [];
    extraSegments.forEach((seg, idx) => {
      if (seg.length > 1) {
        const segColor = extraSegmentColors[idx] || colorRef.current;
        const pl = L.polyline(seg.map(p => [p.lat, p.lng] as [number, number]), {
          color: segColor, weight: 4, opacity: 0.85,
        }).addTo(map);
        extraPolyRef.current.push(pl);
      }
    });

    // fit bounds ONCE on mount only — never re-zoom during editing
    const allPts = [...initPts, ...extraSegments.flat()];
    if (allPts.length > 1) {
      map.fitBounds(
        L.latLngBounds(allPts.map(p => L.latLng(p.lat, p.lng))),
        { padding: [20, 20], maxZoom: 18 }
      );
    }

    // ── Click on empty map → append new point ──────────────────────────
    if (!readOnly) {
      map.on('click', (e: L.LeafletMouseEvent) => {
        const cur  = livePointsRef.current;
        const next = [...cur, { lat: e.latlng.lat, lng: e.latlng.lng }];
        livePointsRef.current = next;
        onChangeRef.current(next);
        rebuildRef.current(next);
      });
    }

    return () => { try { map.remove(); } catch { /**/ } mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, color, showNumbers, showMarkers]);

  // ── Sync external changes (Undo / Clear / parent reset) ──────────────────
  useEffect(() => {
    livePointsRef.current = points;
    rebuildRef.current(points);
  }, [points]);

  return (
    <div
      className="relative rounded-xl overflow-hidden border border-gray-200 shadow-sm"
      style={{ height }}
      ref={el => {
        // ResizeObserver: whenever the container changes size (panel expand, modal open,
        // window resize) tell Leaflet to recalculate its dimensions so tiles fill correctly.
        if (!el) return;
        const ro = new ResizeObserver(() => {
          try { mapRef.current?.invalidateSize({ animate: false }); } catch { /**/ }
        });
        ro.observe(el);
        // Cleanup stored on the element so React doesn't need to track it
        (el as HTMLElement & { _ro?: ResizeObserver })._ro?.disconnect();
        (el as HTMLElement & { _ro?: ResizeObserver })._ro = ro;
      }}
    >
      <div ref={containerRef} className="w-full h-full" />

      {/* Toolbar (draw mode only) — bottom-right to avoid covering zoom buttons */}
      {!readOnly && (
        <div className="absolute bottom-10 right-2 z-[1000] flex flex-col items-end gap-1">
          <div className="bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-medium text-gray-700 shadow border border-gray-200 whitespace-nowrap">
            ✛ Click to add · Drag to move · Click point to delete
          </div>
          <div className="flex gap-1">
            {points.length > 0 && (
              <button
                onClick={() => { const next = points.slice(0, -1); onChange(next); }}
                className="bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-medium text-red-600 shadow border border-red-200 hover:bg-red-50"
              >
                ↩ Undo
              </button>
            )}
            {points.length > 0 && (
              <button
                onClick={() => onChange([])}
                className="bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-medium text-red-600 shadow border border-red-200 hover:bg-red-50"
              >
                🗑 Clear
              </button>
            )}
          </div>
        </div>
      )}

      {/* Distance / point count badge */}
      {points.length > 1 && (
        <div className="absolute bottom-2 left-2 z-[1000] bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-semibold text-gray-700 shadow border border-gray-200">
          📏 {fmtMetres(polylineLength(points))} · {points.length} points
        </div>
      )}
    </div>
  );
}

// ─── Helper: get all segments from a road (backward compat) ──────────────────
function getRoadSegments(road: SweepRoad): RoadPoint[][] {
  if (road.segments && road.segments.length > 0) {
    return road.segments.map(s => s.points);
  }
  return [road.points || []];
}

// v73.17 — Craig: "no total km for that segment as there no points... it
// doesn't see the roads". Several places gated their "has this road got a
// route drawn" check on `road.points.length > 1` alone — but `road.points`
// only ever mirrors the FIRST segment (see its own comment in types.ts:
// "primary/first-segment points, kept for backward compat"). A road whose
// only drawn segment isn't segment 0 (e.g. hand-added a blank Segment A,
// then used Select Roads/Lasso on Segment B before ever touching A) has
// real route data in `road.segments` while `road.points` stays empty,
// so every one of those checks wrongly reported "No route drawn" and hid
// the km/map entirely. Checks the actual segments (or the points fallback
// for roads saved before segments existed) instead.
function roadHasRoute(road: SweepRoad): boolean {
  return getRoadSegments(road).some(pts => pts.length > 1);
}

function getEffectiveColor(road: SweepRoad, areaColor?: string): string {
  return road.color || areaColor || '#6366F1';
}

// ─── MultiSegmentRoadMap — full-featured editor with multiple disconnected segments ──
interface MultiSegmentRoadMapProps {
  segments: RoadPoint[][];
  activeSegIdx: number;
  onSegmentsChange: (segs: RoadPoint[][]) => void;
  segmentNames?: string[];
  color?: string;
  segmentColors?: string[];     // per-segment colour overrides
  showNumbers?: boolean;
  showMarkers?: boolean;
  height?: number;
  syncServerUrl?: string;       // v73.12: Select Roads mode — host-server /api/roads base URL
  syncToken?: string;
  // v73.54 — Craig: "do the same to roads as zones when the area say e.g
  // Hamilton the map will automatically move to Hamilton as the default."
  // Same pattern as ZoneEditorMap's centerHint/autoSearchQuery (v73.46):
  // when there are no points yet to center on, prefer an existing road's
  // first point in the same Area (real geometry), falling back to
  // geocoding the Area's own name once on mount.
  centerHint?: { lat: number; lng: number } | null;
  autoSearchQuery?: string;
  // v73.68 — Craig: switching segments (via "+ Add Segment" or clicking another
  // segment tab) silently discards an in-progress, not-yet-committed Select
  // Roads selection/lasso fence with no warning — easy to trigger by mistake
  // ("✓ Add to Segment" and "+ Add Segment" are two differently-purposed
  // buttons with confusingly similar names) and looks exactly like "my segment
  // got cleared." Reports up whenever there's something that WOULD be lost by
  // the existing v73.30 segment/mode-switch clear effect, so the parent can
  // confirm with the user before actually switching.
  onPendingSelectionChange?: (pending: boolean) => void;
  // v73.84 — Craig: "i want to be able to save well working in ether confirm
  // fence & before pushing add to segment... in case i have to leave or
  // other thing happen." Stable identity used to scope the auto-saved
  // Select Roads/Lasso draft in localStorage — same identity already used
  // for this component's own remount `key` (see the call site), so a draft
  // survives closing/reopening the Edit Road modal or reloading the page,
  // but never bleeds into a different road.
  draftKey?: string;
  // v73.100 — Turnaround Points: one array PER SEGMENT (parallel to `segments`
  // by index), same shape as segments/segmentNames/segmentColors. Independent
  // markers, not part of the RoadPoint[] path — see TurnaroundPoint in types.ts.
  turnarounds?: TurnaroundPoint[][];
  onTurnaroundsChange?: (t: TurnaroundPoint[][]) => void;
}

// v73.12 — road feature as returned by the host-server's /api/roads endpoint
interface RoadFeature {
  id: string;
  name: string;
  category?: 'road' | 'service' | 'lane' | 'parkingaisle' | 'serviceroad' | 'livingstreet'; // v73.20: 'service' = car park/driveway/business service lane. v73.43: 'lane' = a road named "... Lane". v73.53: 'parkingaisle'/'serviceroad'/'livingstreet' = OSM service=parking_aisle / plain highway=service / highway=living_street — all excluded by default, includable via their own toggle
  coords: [number, number][]; // [lng, lat] pairs, GeoJSON order — converted to {lat,lng} only at the point it's merged into a segment
  // v73.82 — optional per-coordinate street-name override, one entry per
  // `coords` index. Real host-server-fetched RoadFeatures never set this
  // (their whole coords array genuinely is one street, `name` alone is
  // correct/cheaper) — this exists for the synthetic "wrap an already-built,
  // possibly-multi-street chain back into one pseudo-RoadFeature so it can
  // reuse mergeRoadFeaturesIntoPath's chaining logic" pattern
  // (addSelectedRoadsToSegment's loopFeature). Before this field existed,
  // that wrap always used a single `name: ''` for the whole pseudo-feature,
  // which silently overwrote every real per-point streetName the chain had
  // already picked up — see the v73.68 "Split Segment by Street" tags and
  // the mergeRoadFeaturesIntoPath comment below for the full story. When
  // present and its length matches `coords`, mergeRoadFeaturesIntoPath uses
  // this instead of `name` for tagging.
  pointNames?: string[];
  // v73.99 — Bug #6 fix ("Transit Road Type Lost After Add Segment"):
  // optional per-coordinate transitAfter override, one entry per `coords`
  // index, same shape/purpose as `pointNames` but for the transit flag
  // instead of the street name. Before this field existed, wrapping a
  // just-built loopChain (which DOES carry real transitAfter flags, set
  // right before this wrap — see runSelectRoadsBatch) into a RoadFeature
  // pseudo-feature for re-chaining silently dropped every one of those
  // flags, because RoadFeature/mergeRoadFeaturesIntoPath's output step had
  // no field to carry them in at all — a road marked Transit before
  // "✓ Add to Segment"/"✓ Add as Transit" always came out as a normal
  // (Main Road) pass on the committed segment. When present and its length
  // matches `coords`, mergeRoadFeaturesIntoPath threads this through the
  // same splice/reverse/concat pipeline pointNames already uses and applies
  // it to the final output points' `transitAfter`.
  pointTransit?: boolean[];
}

// v73.99 — mirrors a per-point transitAfter array through a piece reversal.
// transitAfter lives on a point but describes the edge OUT of it (point i ->
// point i+1), so reversing point order alone would silently leave the flags
// misaligned by one position (whatever was point i's outgoing-edge flag
// needs to become point (n-2-i)'s outgoing-edge flag in the reversed order,
// not stay at the same index) — the last point never has a meaningful
// outgoing edge either way, so its slot is always cleared. Used everywhere
// mergeRoadFeaturesIntoPath reverses a piece, exactly parallel to the plain
// `.slice().reverse()` it already does for coords/streetName tags.
function reversePointTransit(t: (boolean | undefined)[]): (boolean | undefined)[] {
  const n = t.length;
  const out: (boolean | undefined)[] = new Array(n).fill(undefined);
  for (let j = 0; j < n - 1; j++) out[j] = t[n - 2 - j];
  return out;
}

// v73.12 — merges a set of selected road ways into one continuous ordered
// point path by greedily chaining whichever remaining way has an endpoint
// closest to either end of the path built so far (reversing pieces as
// needed). Works regardless of click/selection order. An `existingChain`
// (already-drawn points on the active segment, in {lat,lng} form) can be
// passed in so a road-selected stretch extends what's already been drawn
// by hand instead of always starting fresh.
// v73.13 — standard ray-casting point-in-polygon test, used by Lasso Select
// to find which roads pass through a freely-drawn shape. point and each
// polygon vertex are [lat, lng] pairs — consistent ordering is all that
// matters, this isn't true geographic distance so no projection needed for
// small (sub-regional) shapes like a selection lasso.
function pointInPolygon(point: [number, number], polygon: [number, number][]): boolean {
  let inside = false;
  const [px, py] = point;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = ((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

// v73.43 — Craig: "not every road was selected when using lasso mode half
// was not selected in the lasso zone." Same root cause the v73.41 fix
// already found and fixed for the Ctrl+drag box-select: checking whether
// any VERTEX of a road falls inside the fence misses a road whose LINE
// passes straight through the fence without either endpoint (or any
// vertex) landing inside it — common on real-road-routed/OSM paths, which
// often have long, sparse edges. `confirmLassoFence` never got the same
// fix, so it kept using the vertex-only `pointInPolygon` check on its own.
// Standard segment-vs-segment intersection (orientation test), used below
// to also check every polygon EDGE against every road EDGE, not just
// vertices-in-polygon.
function segmentsIntersect(p1: [number, number], p2: [number, number], p3: [number, number], p4: [number, number]): boolean {
  const orient = (a: [number, number], b: [number, number], c: [number, number]): number => {
    const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return v > 0 ? 1 : v < 0 ? -1 : 0;
  };
  const o1 = orient(p1, p2, p3), o2 = orient(p1, p2, p4), o3 = orient(p3, p4, p1), o4 = orient(p3, p4, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  // Collinear/touching edge cases (rare for freehand fences, but cheap to cover).
  const onSeg = (a: [number, number], b: [number, number], c: [number, number]): boolean =>
    Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);
  if (o1 === 0 && onSeg(p1, p2, p3)) return true;
  if (o2 === 0 && onSeg(p1, p2, p4)) return true;
  if (o3 === 0 && onSeg(p3, p4, p1)) return true;
  if (o4 === 0 && onSeg(p3, p4, p2)) return true;
  return false;
}

// Checks a road edge (a→b) against every edge of the fence polygon —
// catches a road that crosses the fence boundary even when neither of the
// edge's own endpoints sits inside it.
function segmentIntersectsPolygon(a: [number, number], b: [number, number], polygon: [number, number][]): boolean {
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    if (segmentsIntersect(a, b, polygon[i], polygon[j])) return true;
  }
  return false;
}

// v73.27 — shoelace-formula polygon area in m², for Zones. Same
// approximate-flat-earth projection tradeoff `ZoneManager.calculateArea` in
// Craig's reference spec used (111,320 m/° longitude scaled by cos(lat) for
// the local meridian convergence, 110,540 m/° latitude) — accurate enough
// for a car-park/site-sized polygon (a few hundred metres across at most),
// not appropriate for anything approaching regional scale.
function polygonAreaM2(points: RoadPoint[]): number {
  const n = points.length;
  if (n < 3) return 0;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const xi = points[i].lng * 111320 * Math.cos(points[i].lat * Math.PI / 180);
    const yi = points[i].lat * 110540;
    const xj = points[j].lng * 111320 * Math.cos(points[j].lat * Math.PI / 180);
    const yj = points[j].lat * 110540;
    area += xi * yj;
    area -= xj * yi;
  }
  return Math.abs(area / 2);
}

// v73.49 — plain vertex-average centroid (not the geometrically-precise
// area-weighted centroid — for a roughly-convex car-park/site-sized
// polygon the difference is visually negligible, and this is only ever
// used as a default label position, not for anything measurement-related
// like polygonAreaM2 above). Used whenever a zone/sub-zone has no
// explicit user-placed labelPos yet.
function polygonCentroid(points: RoadPoint[]): RoadPoint {
  if (points.length === 0) return { lat: 0, lng: 0 };
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  return { lat, lng };
}

// v73.41 — Craig: "add square meters as well as HA to the totals." Was
// either/or before (ha once over 1 hectare, m² under) — now always shows
// both together so neither unit needs a mental conversion.
function fmtZoneArea(areaM2: number): string {
  const m2Str = `${Math.round(areaM2).toLocaleString()} m²`;
  const haStr = `${(areaM2 / 10000).toFixed(2)} ha`;
  return areaM2 >= 10000 ? `${haStr} (${m2Str})` : `${m2Str} (${haStr})`;
}

const ZONE_KIND_ICONS: Record<string, string> = {
  carpark: '🅿️', business: '🏢', area: '📍', park: '🌿', custom: '⬡',
};
const ZONE_KIND_LABELS: Record<string, string> = {
  carpark: 'Car Park', business: 'Business/Industrial', area: 'General Area', park: 'Park/Reserve', custom: 'Custom',
};
// v73.46 — zoneKind can now also be a custom SW Categories value (see
// SweepZoneKind widening in types.ts), which has no entry in the fixed
// lookups above. Falls back to a generic pin icon and the raw stored value
// itself as the label, rather than rendering `undefined`.
const zoneKindIcon = (k: string) => ZONE_KIND_ICONS[k] || '📍';
const zoneKindLabel = (k: string) => ZONE_KIND_LABELS[k] || k || 'Custom';

interface ZoneEditorMapProps {
  points: RoadPoint[];
  onChange: (points: RoadPoint[]) => void;
  color?: string;
  height?: number;
  readOnly?: boolean;
  // v73.46 — Craig: "need the map to default to [the] area it be select[ed]
  // to be made on... e.g. test area at the moment is Hamilton nz" — a New
  // Zone with no points yet was always centering on the hardcoded Auckland
  // fallback regardless of which Area was selected. When set and there are
  // no points yet to center on instead, the map opens centered here (an
  // existing zone's centroid in the same Area if one exists, otherwise the
  // Area's name geocoded via the same Nominatim search below).
  centerHint?: { lat: number; lng: number } | null;
  // v73.46 — when there's no existing zone in the same Area to derive a
  // centroid from (see centerHint), fall back to geocoding the Area's own
  // name via the same Nominatim search the city search box uses, once, on
  // mount — so a brand new Area with no zones yet still opens roughly in
  // the right place instead of Auckland. Never overrides an explicit
  // centerHint or existing points; silently no-ops if the geocode fails
  // (falls through to the Auckland default), same fail-open pattern as the
  // manual search box.
  autoSearchQuery?: string;
  // v73.49 — Craig: "i want it transparent like zone 1 i just draw lines."
  // Controls whether the ACTIVE polygon (the one `points`/`onChange` refer
  // to) renders filled or outline-only. Defaults true so every zone drawn
  // before this release looks exactly as it always has.
  fillEnabled?: boolean;
  // v73.49 — Craig: "add names anywhere in the sub zones and main zones
  // when wanted." A draggable text label independent of the polygon's
  // vertices. `labelPos` null means "not explicitly placed yet" — rendered
  // at the polygon's centroid (polygonCentroid) until the user drags it,
  // at which point `onLabelPosChange` reports the real position to persist.
  // `labelName` is shown as the marker's text — blank renders no label at
  // all (Craig: labels are "when wanted", not mandatory).
  labelName?: string;
  labelPos?: RoadPoint | null;
  onLabelPosChange?: (pos: RoadPoint) => void;
  // v73.49 — other polygons belonging to the SAME zone (the main boundary
  // plus every other sub-zone) that should stay visible for spatial
  // context while editing one of them — exactly the "Zone 1 / Zone 2 /
  // Zone 3 all visible together" look in Craig's screenshot. Entirely
  // static: no vertex/midpoint editing, no click-to-add, just the shape,
  // its own fill/outline setting, and its own label if it has one.
  otherPolygons?: { points: RoadPoint[]; color: string; fillEnabled: boolean; name: string; labelPos: RoadPoint | null }[];
}

// v73.27 — Zone polygon editor. Modeled on RoadMap's rebuild-on-ref-change
// architecture (avoids Leaflet stale-closure bugs the same way), but for a
// CLOSED POLYGON instead of an open path: filled L.polygon instead of
// L.polyline, midpoint-insert markers on every edge INCLUDING the closing
// one (last point back to first — a Zone always wraps around, a Road never
// does), and no A/B endpoint styling since a polygon has no start/end.
// Right-click delete requires confirmation and a 3-point floor, matching the
// v73.25 point-delete pattern established for Draw Points.
function ZoneEditorMap({
  points, onChange, color = '#0088ff', height = 420, readOnly = false, centerHint = null, autoSearchQuery = '',
  fillEnabled = true, labelName = '', labelPos = null, onLabelPosChange, otherPolygons = [],
}: ZoneEditorMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef        = useRef<L.Map | null>(null);
  const polyRef        = useRef<L.Polygon | L.Polyline | null>(null);
  const vertexMkRef    = useRef<L.Marker[]>([]);
  const midMkRef       = useRef<L.Marker[]>([]);
  const labelMkRef     = useRef<L.Marker | null>(null);
  const otherLayersRef = useRef<L.Layer[]>([]);
  const livePointsRef  = useRef<RoadPoint[]>(points);
  const onChangeRef    = useRef(onChange);
  const colorRef       = useRef(color);
  const readOnlyRef    = useRef(readOnly);
  const fillEnabledRef = useRef(fillEnabled);
  const labelNameRef   = useRef(labelName);
  const labelPosRef    = useRef(labelPos);
  const onLabelPosChangeRef = useRef(onLabelPosChange);
  const otherPolygonsRef    = useRef(otherPolygons);
  const rebuildRef     = useRef<(pts: RoadPoint[]) => void>(() => {});
  const [citySearch, setCitySearch]   = useState('');
  const [citySearching, setCitySearching] = useState(false);
  const [cityError, setCityError]     = useState('');

  useEffect(() => { livePointsRef.current = points; }, [points]);
  useEffect(() => { onChangeRef.current   = onChange; }, [onChange]);
  useEffect(() => { colorRef.current      = color; }, [color]);
  useEffect(() => { readOnlyRef.current   = readOnly; }, [readOnly]);
  useEffect(() => { fillEnabledRef.current = fillEnabled; }, [fillEnabled]);
  useEffect(() => { labelNameRef.current  = labelName; }, [labelName]);
  useEffect(() => { labelPosRef.current   = labelPos; }, [labelPos]);
  useEffect(() => { onLabelPosChangeRef.current = onLabelPosChange; }, [onLabelPosChange]);
  useEffect(() => { otherPolygonsRef.current = otherPolygons; }, [otherPolygons]);
  useEffect(() => { rebuildRef.current(livePointsRef.current); }, [points, color, readOnly, fillEnabled, labelName, labelPos, otherPolygons]);

  // v73.46 — City/town search, same Nominatim (free, no API key) pattern
  // MultiSegmentRoadMap's Edit Road already uses, so New Zone gets the same
  // "jump to a place before drawing" capability it was missing entirely.
  const searchCity = async () => {
    const q = citySearch.trim();
    if (!q || !mapRef.current) return;
    setCitySearching(true); setCityError('');
    try {
      const resp = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
        { headers: { 'Accept-Language': 'en' } }
      );
      const results = await resp.json();
      if (results.length > 0) {
        const { lat, lon } = results[0];
        mapRef.current.setView([parseFloat(lat), parseFloat(lon)], 15, { animate: true });
        setCityError('');
      } else {
        setCityError(`"${q}" not found — try a different spelling`);
      }
    } catch {
      setCityError('Search unavailable — check internet connection');
    } finally {
      setCitySearching(false);
    }
  };

  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) { try { mapRef.current.remove(); } catch { /**/ } mapRef.current = null; }

    const initPts = livePointsRef.current;
    const center: [number, number] = initPts.length > 0
      ? [initPts[0].lat, initPts[0].lng]
      : centerHint
      ? [centerHint.lat, centerHint.lng]
      : [-36.8485, 174.7633]; // Auckland fallback, matches RoadMap, only used when no points AND no centerHint

    const map = L.map(containerRef.current, {zoomSnap: 0.25, zoomDelta: 0.25, wheelPxPerZoomLevel: 120,  attributionControl: false, renderer: L.canvas({ tolerance: 8 }) }).setView(center, 17);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap', maxZoom: 19,
    }).addTo(map);
    mapRef.current = map;
    setTimeout(() => { try { map.invalidateSize({ animate: false }); } catch { /**/ } }, 50);
    setTimeout(() => { try { map.invalidateSize({ animate: false }); } catch { /**/ } }, 250);
    if (!readOnly) map.getContainer().style.cursor = 'crosshair';

    // v73.46 — no points to center on yet (a genuinely new zone) and no
    // centroid available from an existing zone in the same Area (see
    // centerHint prop) — geocode the Area's own name once so the map opens
    // somewhere sensible instead of defaulting to Auckland. Fire-and-forget:
    // a failed/empty geocode just leaves the map at the Auckland fallback
    // already set above, same as before this release.
    if (initPts.length === 0 && !centerHint && autoSearchQuery.trim()) {
      (async () => {
        try {
          const resp = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(autoSearchQuery.trim())}`,
            { headers: { 'Accept-Language': 'en' } }
          );
          const results = await resp.json();
          if (results.length > 0 && mapRef.current) {
            const { lat, lon } = results[0];
            mapRef.current.setView([parseFloat(lat), parseFloat(lon)], 14, { animate: false });
          }
        } catch { /* fails open — stays at the Auckland fallback */ }
      })();
    }

    const rebuild = (pts: RoadPoint[]) => {
      const col = colorRef.current;
      const ro  = readOnlyRef.current;
      const fillOn = fillEnabledRef.current;

      polyRef.current?.remove(); polyRef.current = null;
      vertexMkRef.current.forEach(m => m.remove()); vertexMkRef.current = [];
      midMkRef.current.forEach(m => m.remove());    midMkRef.current    = [];
      labelMkRef.current?.remove(); labelMkRef.current = null;
      otherLayersRef.current.forEach(l => l.remove()); otherLayersRef.current = [];

      // v73.49 — static reference polygons from the SAME zone (other
      // sub-zones + the main boundary), drawn first/underneath so the
      // active editable polygon's own vertex/midpoint markers stay on top
      // and clickable. No interaction handlers at all — purely visual
      // context, matching Craig's screenshot of Zone 1/2/3 all visible at
      // once while working on one of them.
      otherPolygonsRef.current.forEach(op => {
        if (op.points.length < 2) return;
        const layer = op.points.length >= 3
          ? L.polygon(op.points.map(p => [p.lat, p.lng] as [number, number]), {
              color: op.color, weight: 2, fillColor: op.color,
              fillOpacity: op.fillEnabled ? 0.15 : 0, dashArray: op.fillEnabled ? undefined : [6, 4],
              interactive: false,
            }).addTo(map)
          : L.polyline(op.points.map(p => [p.lat, p.lng] as [number, number]), {
              color: op.color, weight: 2, dashArray: [6, 4], interactive: false,
            }).addTo(map);
        otherLayersRef.current.push(layer);
        if (op.name.trim()) {
          const lp = op.labelPos || polygonCentroid(op.points);
          const lbl = L.marker([lp.lat, lp.lng], {
            icon: L.divIcon({
              className: '', html: `<div style="font-weight:700;font-size:13px;color:${op.color};text-shadow:0 1px 3px rgba(255,255,255,0.9),0 -1px 3px rgba(255,255,255,0.9);white-space:nowrap;pointer-events:none;">${op.name.trim().replace(/</g, '&lt;')}</div>`,
              iconSize: [0, 0],
            }),
            interactive: false, zIndexOffset: 500,
          }).addTo(map);
          otherLayersRef.current.push(lbl);
        }
      });

      if (pts.length === 0) return;

      if (pts.length >= 3) {
        polyRef.current = L.polygon(pts.map(p => [p.lat, p.lng] as [number, number]), {
          color: col, weight: 2, fillColor: col, fillOpacity: fillOn ? 0.2 : 0, dashArray: fillOn ? undefined : [8, 5],
        }).addTo(map);
      } else if (pts.length === 2) {
        polyRef.current = L.polyline(pts.map(p => [p.lat, p.lng] as [number, number]), {
          color: col, weight: 2, dashArray: [5, 5],
        }).addTo(map);
      }

      // v73.49 — draggable name label for the ACTIVE polygon, independent
      // of its vertices. Shown even in read-only mode (a placed label is
      // part of how the shape reads, not an editing control) but only
      // draggable when not read-only.
      const activeLabelName = labelNameRef.current.trim();
      if (activeLabelName && pts.length >= 2) {
        const lp = labelPosRef.current || polygonCentroid(pts);
        const labelIcon = L.divIcon({
          className: '',
          html: `<div style="font-weight:700;font-size:14px;color:${col};text-shadow:0 1px 3px rgba(255,255,255,0.95),0 -1px 3px rgba(255,255,255,0.95);white-space:nowrap;${ro ? '' : 'cursor:grab;'}">${activeLabelName.replace(/</g, '&lt;')}</div>`,
          iconSize: [0, 0],
        });
        const labelMk = L.marker([lp.lat, lp.lng], { icon: labelIcon, draggable: !ro, zIndexOffset: 1100 }).addTo(map);
        if (!ro) {
          labelMk.on('dragend', () => {
            const ll = labelMk.getLatLng();
            onLabelPosChangeRef.current?.({ lat: ll.lat, lng: ll.lng });
          });
        }
        labelMkRef.current = labelMk;
      }

      if (ro) return; // no vertex/midpoint editing controls in read-only mode

      // Vertex markers — draggable, right-click to delete (confirmed)
      pts.forEach((p, i) => {
        const icon = L.divIcon({
          className: '',
          html: `<div style="width:14px;height:14px;border-radius:50%;background:white;border:2.5px solid ${col};box-shadow:0 1px 4px rgba(0,0,0,0.35);cursor:grab;"></div>`,
          iconSize: [14, 14], iconAnchor: [7, 7],
        });
        const marker = L.marker([p.lat, p.lng], { icon, draggable: true, autoPan: false, zIndexOffset: 1000 }).addTo(map);

        marker.on('drag', () => {
          const ll = marker.getLatLng();
          const updated = livePointsRef.current.slice();
          updated[i] = { lat: ll.lat, lng: ll.lng };
          livePointsRef.current = updated;
          if (updated.length >= 2) polyRef.current?.setLatLngs(updated.map(pt => [pt.lat, pt.lng] as [number, number]));
        });
        marker.on('dragend', () => {
          onChangeRef.current(livePointsRef.current);
          rebuildRef.current(livePointsRef.current);
        });

        marker.on('contextmenu', (e) => {
          L.DomEvent.stopPropagation(e);
          if (livePointsRef.current.length <= 3) { alert('A zone needs at least 3 points.'); return; }
          if (!window.confirm(`Delete point ${i + 1}? This can't be undone.`)) return;
          const updated = livePointsRef.current.filter((_, pi) => pi !== i);
          livePointsRef.current = updated;
          onChangeRef.current(updated);
          rebuildRef.current(updated);
        });

        vertexMkRef.current.push(marker);
      });

      // Midpoint markers — one per edge, INCLUDING the closing edge once
      // there are 3+ points (a Zone is always a closed shape).
      if (pts.length >= 3) {
        pts.forEach((p, i) => {
          const next = pts[(i + 1) % pts.length];
          const midLat = (p.lat + next.lat) / 2;
          const midLng = (p.lng + next.lng) / 2;
          const midIcon = L.divIcon({
            className: '',
            html: `<div style="width:10px;height:10px;border-radius:50%;background:${col};border:1px solid white;opacity:0.6;cursor:pointer;"></div>`,
            iconSize: [10, 10], iconAnchor: [5, 5],
          });
          const midMarker = L.marker([midLat, midLng], { icon: midIcon, zIndexOffset: 900 }).addTo(map);
          midMarker.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            const updated = livePointsRef.current.slice();
            updated.splice(i + 1, 0, { lat: midLat, lng: midLng });
            livePointsRef.current = updated;
            onChangeRef.current(updated);
            rebuildRef.current(updated);
          });
          midMkRef.current.push(midMarker);
        });
      }
    };
    rebuildRef.current = rebuild;
    rebuild(initPts);

    if (!readOnly) {
      map.on('click', (e: L.LeafletMouseEvent) => {
        const updated = [...livePointsRef.current, { lat: e.latlng.lat, lng: e.latlng.lng }];
        livePointsRef.current = updated;
        onChangeRef.current(updated);
        rebuild(updated);
      });
    }

    return () => { try { map.remove(); } catch { /**/ } mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  const fillMode = height === -1;
  return (
    <div className={fillMode ? 'flex flex-col h-full' : undefined}>
      {!readOnly && (
        <div className="flex gap-2 shrink-0 p-2">
          <input
            type="text"
            className="input-field flex-1 text-sm"
            placeholder="🔍 Search town or city to navigate map (e.g. Otorohanga, Hamilton NZ)"
            value={citySearch}
            onChange={e => { setCitySearch(e.target.value); setCityError(''); }}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); searchCity(); } }}
          />
          <button
            onClick={searchCity}
            disabled={citySearching || !citySearch.trim()}
            className="btn-secondary text-sm px-4 shrink-0 disabled:opacity-50"
          >
            {citySearching ? '⏳' : '🔍 Go'}
          </button>
        </div>
      )}
      {cityError && <p className="text-xs text-red-500 shrink-0 px-2 pb-1">{cityError}</p>}
      <div ref={containerRef} className={fillMode ? 'flex-1' : undefined} style={{ height: fillMode ? undefined : height, width: '100%', borderRadius: 12, overflow: 'hidden' }} />
    </div>
  );
}

// v73.24 — Craig: Select Roads/Lasso lines sit exactly on the OSM road
// centerline (since that's the real geometry they're built from), which
// means they sit right under the street-name label too — unlike Draw
// Points, where a hand-click is never perfectly centered anyway, so the
// label stays legible. Nudges each road-derived point a small fixed
// distance perpendicular to its local direction of travel, consistently to
// one side, so the merged line clears the label without meaningfully
// changing the route's real-world accuracy (a sweeper truck a couple
// metres off dead-center is still unambiguously on that road). Direction
// is estimated from the previous/next point (a local tangent), so the
// offset side stays consistent along a normal road but can visually flip
// at a genuine hairpin — an acceptable limitation for a small cosmetic
// nudge, not a routing/accuracy feature.
function offsetPerpendicular(coords: [number, number][], offsetMetres: number): [number, number][] {
  if (coords.length < 2) return coords;
  const METRES_PER_DEG_LAT = 111320;
  return coords.map(([lng, lat], i) => {
    const prev = coords[Math.max(0, i - 1)];
    const next = coords[Math.min(coords.length - 1, i + 1)];
    let dLng = next[0] - prev[0], dLat = next[1] - prev[1];
    let len = Math.hypot(dLng, dLat);
    // v73.114 — Craig-reported: small overlapping loops/extra points
    // clustering at corners. Root cause: at a turnaround apex / any point
    // where the path reverses direction (goes out then immediately back
    // over itself), prev and next sit almost exactly on top of each
    // other, so the combined prev->next tangent degenerates to ~zero
    // length. The old `|| 1` fallback then produced an arbitrary,
    // unstable perpendicular direction right at that exact point instead
    // of erroring or holding steady — that's what was rendering as
    // small self-intersecting loops at corners/dead-ends. Fall back to a
    // one-sided tangent (current->next, then prev->current if that's ALSO
    // degenerate) so the offset direction stays geometrically meaningful
    // even at a reversal, instead of picking an arbitrary direction.
    if (len < 1e-9) {
      dLng = next[0] - lng; dLat = next[1] - lat;
      len = Math.hypot(dLng, dLat);
      if (len < 1e-9) { dLng = lng - prev[0]; dLat = lat - prev[1]; len = Math.hypot(dLng, dLat) || 1; }
    }
    const perpLng = -dLat / len, perpLat = dLng / len; // rotate tangent 90°, normalized
    const metresPerDegLng = METRES_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
    return [lng + (perpLng * offsetMetres) / metresPerDegLng, lat + (perpLat * offsetMetres) / METRES_PER_DEG_LAT] as [number, number];
  });
}
const ROAD_LABEL_OFFSET_METRES = 2.5; // single-pass (sweepBothSides OFF) default — small fixed cosmetic nudge off the OSM centreline so the line doesn't sit directly on top of the street-name label. Applied once, after chaining, by addSelectedRoadsToSegment — no longer user-adjustable (see v73.33).
// v73.33 — Craig: "off set side no good remove it i wish the two line were
// one on each side of the road from center." The old "Sweep both sides" was
// never actually two offset lines — it was the SAME chained coordinates
// traversed forward then backward, so the two passes were always exactly
// coincident. The old Offset slider then shifted that single coincident
// line sideways as one unit, which is why Craig saw "both lines offset to
// the same side" — there was only ever one line's worth of geometry to
// begin with. Now: when sweepBothSides is on, the two passes are genuinely
// offset in OPPOSITE directions from the true centreline by this fixed
// amount — one pass left, one pass right — no slider, no manual side
// selection, always symmetric. Matches what a hand-drawn "out one side, back
// the other" segment already looks like (see the sweepBothSides state
// comment above), just automatic instead of user-drawn.
const SWEEP_BOTH_SIDES_OFFSET_METRES = 2.5;

// v73.111 — Craig: "the traversal algorithm itself is producing too much
// repeated travel" — a real, separate bug from the extra-unselected-roads
// one v73.110 addressed. Root cause: mergeRoadFeaturesIntoPath below chains
// selected PIECES by nearest-endpoint greedy matching — it has no concept of
// a shared intersection node at all, so if piece C's middle coordinate
// happens to sit exactly where piece A ends (a real junction), the chainer
// can't see that connection; it only ever compares piece ENDPOINTS. On a
// branching/looped road network (exactly what Craig's screenshot showed —
// a Y-junction plus a park loop) that blindness forces genuinely
// unnecessary backtracking that has nothing to do with turnarounds or
// unselected roads. Strict mode (v73.110) now uses this graph+Dijkstra
// traversal INSTEAD of mergeRoadFeaturesIntoPath: build a real graph from
// every selected feature's own coordinates (nodes merged wherever two
// features share a coordinate, i.e. a real intersection), then find the
// shortest path — strictly along selected-road graph edges, nothing else —
// between each required stop in order (A → T1 → T2 → … → B). This can't
// eliminate ALL repeated travel (a genuinely tree-shaped/dead-end selection
// mathematically requires retracing some edges to get back out — no
// traversal algorithm can avoid that), but it removes the specific,
// avoidable repeats caused by the old chainer not recognising real
// junctions, and the debug log (see addSelectedRoadsToSegment) now reports
// exactly which edges got used more than once so a genuinely-required
// repeat (dead-end) is visible and distinguishable from a bug.
//
// Not a full Chinese-Postman solver (that needs minimum-weight matching
// across every odd-degree node to be provably optimal) — that's a
// meaningfully bigger undertaking than this pass. This is "shortest path
// through the ACTUAL selected-road graph between the stops Craig placed,"
// not "the globally optimal tour."
interface RoadGraph {
  nodes: Map<string, { key: string; lat: number; lng: number; edgeIds: string[] }>;
  // v73.112 — featureId/roadName added so per-edge traversal diagnostics
  // (see traverseSelectedGraphOrdered) can report which real selected road
  // an edge belongs to, not just an opaque synthetic edge id.
  edges: Map<string, { id: string; aKey: string; bKey: string; points: RoadPoint[]; dist: number; featureId: string; roadName: string }>;
}
// ~1.1m at NZ latitudes — exact-match dedup only; NOT the real junction
// tolerance (see JUNCTION_MERGE_METRES below, v73.116).
function graphNodeKey(p: RoadPoint): string {
  return `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
}
// v73.116 — Craig: "T3 pulled apart" — a genuine gap/split rendered right
// at a real junction (Weka Street crossing Moa Crescent). Root cause:
// graphNodeKey's exact-string-match dedup (~1.1m) is fine for the SAME
// point repeated across two selected pieces, but two independently
// surveyed OSM ways crossing at the "same" real-world corner are commonly
// a few metres apart in their raw coordinates — those never collapse to
// the same key, so the graph sees two disconnected nodes sitting right on
// top of each other visually, and the traversal genuinely can't route
// through what looks like one junction. Distance is a deliberately looser
// (~3m) real-world tolerance, applied as a second clustering pass below
// (union-find over haversine distance) rather than tightening the
// string-match, which would need many more decimal places and still miss
// non-grid-aligned offsets.
const JUNCTION_MERGE_METRES = 3;
function buildSelectedRoadGraph(features: RoadFeature[]): RoadGraph {
  const nodes: RoadGraph['nodes'] = new Map();
  const edges: RoadGraph['edges'] = new Map();
  const ensureNode = (p: RoadPoint): string => {
    const k = graphNodeKey(p);
    if (!nodes.has(k)) nodes.set(k, { key: k, lat: p.lat, lng: p.lng, edgeIds: [] });
    return k;
  };
  let counter = 0;
  const rawEdges: { a: RoadPoint; b: RoadPoint; aKey: string; bKey: string; featureId: string; roadName: string }[] = [];
  for (const f of features) {
    const coords = f.coords; // [lng, lat] pairs (GeoJSON order) — convert per point below
    for (let i = 0; i < coords.length - 1; i++) {
      const a: RoadPoint = { lng: coords[i][0], lat: coords[i][1] };
      const b: RoadPoint = { lng: coords[i + 1][0], lat: coords[i + 1][1] };
      const aKey = ensureNode(a), bKey = ensureNode(b);
      if (aKey === bKey) continue; // zero-length hop, skip
      rawEdges.push({ a, b, aKey, bKey, featureId: f.id, roadName: f.name });
    }
  }
  // v73.119 — Craig: "app is slow and lagging... freezes then screen whites
  // out" every first click on things in Edit Road. Root cause: this
  // clustering pass is genuinely O(n²) over `rawKeys`, and the comment
  // above it ("typically dozens to low hundreds") was wrong in practice —
  // `nodes` here has one entry per raw OSM survey VERTEX across every
  // selected piece (ensureNode is called for every coordinate, not just
  // piece endpoints), so a realistic Select Roads/Lasso pick easily reaches
  // several thousand nodes. At 2,500 nodes (GRAPH_TRAVERSAL_MAX_NODES,
  // which this function runs BEFORE checking) that's ~3.1 million haversine
  // (trig) calls; the debug block in addSelectedRoadsToSegment then calls
  // this function a SECOND time on the same data for its own diagnostics,
  // doubling the cost — on Craig's reference hardware (Athlon II X2,
  // single-thread ceiling ~2.7GHz) that is exactly a multi-second main-
  // thread block: the tab shows as frozen, then repaints (the white-out —
  // browser drawing an empty frame while blocked) once the loop finally
  // finishes and control returns to the event loop.
  // Fix: bucket nodes into a spatial grid sized to JUNCTION_MERGE_METRES
  // before comparing, and only compare each node against the handful of
  // nodes in its own + 8 neighbouring cells (the only cells a match within
  // JUNCTION_MERGE_METRES could possibly fall in) instead of every other
  // node in the whole selection. Same haversine tolerance/result, just
  // without the quadratic blow-up — near-linear in practice.
  const CELL_DEG = JUNCTION_MERGE_METRES / 111320; // ~metres-per-degree at the equator; fine as a bucket size (only used to limit candidates, exact haversine still decides the actual match)
  const cellKey = (lat: number, lng: number) => `${Math.floor(lat / CELL_DEG)},${Math.floor(lng / CELL_DEG)}`;
  const rawKeys = [...nodes.keys()];
  const parent = new Map<string, string>(rawKeys.map(k => [k, k]));
  const find = (k: string): string => { let r = k; while (parent.get(r) !== r) r = parent.get(r)!; return r; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const grid = new Map<string, string[]>();
  for (const k of rawKeys) {
    const n = nodes.get(k)!;
    const ck = cellKey(n.lat, n.lng);
    if (!grid.has(ck)) grid.set(ck, []);
    grid.get(ck)!.push(k);
  }
  for (let i = 0; i < rawKeys.length; i++) {
    const n1 = nodes.get(rawKeys[i])!;
    const cellLat = Math.floor(n1.lat / CELL_DEG), cellLng = Math.floor(n1.lng / CELL_DEG);
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLng = -1; dLng <= 1; dLng++) {
        const neighbours = grid.get(`${cellLat + dLat},${cellLng + dLng}`);
        if (!neighbours) continue;
        for (const k2 of neighbours) {
          if (k2 <= rawKeys[i]) continue; // string compare is enough here — just avoids comparing every pair twice/against itself, order doesn't matter for union()
          const n2 = nodes.get(k2)!;
          if (haversine(n1, n2) <= JUNCTION_MERGE_METRES) union(rawKeys[i], k2);
        }
      }
    }
  }
  const remap = new Map<string, string>(rawKeys.map(k => [k, find(k)]));
  const mergedNodes: RoadGraph['nodes'] = new Map();
  for (const k of rawKeys) {
    const rep = remap.get(k)!;
    if (!mergedNodes.has(rep)) {
      const n = nodes.get(rep)!;
      mergedNodes.set(rep, { key: rep, lat: n.lat, lng: n.lng, edgeIds: [] });
    }
  }
  for (const re of rawEdges) {
    const aKey = remap.get(re.aKey)!, bKey = remap.get(re.bKey)!;
    if (aKey === bKey) continue; // collapsed into the same merged junction node — zero-length hop now, skip
    const id = `e${counter++}`;
    edges.set(id, { id, aKey, bKey, points: [re.a, re.b], dist: haversine(re.a, re.b), featureId: re.featureId, roadName: re.roadName });
    mergedNodes.get(aKey)!.edgeIds.push(id);
    mergedNodes.get(bKey)!.edgeIds.push(id);
  }
  return { nodes: mergedNodes, edges };
}
function nearestGraphNodeKey(graph: RoadGraph, p: RoadPoint): string | null {
  let best: string | null = null, bestDist = Infinity;
  for (const n of graph.nodes.values()) {
    const d = haversine(p, { lat: n.lat, lng: n.lng });
    if (d < bestDist) { bestDist = d; best = n.key; }
  }
  return best;
}
// Simple O(V²) Dijkstra — selected-road graphs from a lasso/click selection
// are at most a few hundred nodes, well within budget even on Craig's
// weaker test hardware (see the v73.38–v73.42 lag-fix history for why that
// hardware matters here); a priority-queue version isn't worth the added
// code for graphs this size.
// v73.111 — Dijkstra between successive stops, with an edge-reuse penalty.
// Without this, two legs with the same shortest path (e.g. "go around a
// loop and come back") independently pick the IDENTICAL shortest route each
// time, retracing edges a real cycle would have let it avoid entirely —
// caught by this file's own standalone repro test before it shipped (see
// test_graph_traversal.mjs: the loop-traversal check failed until this
// penalty was added). `usedCounts` tracks how many times each edge has
// already been used by an EARLIER leg in this traversal; each edge's
// effective weight is multiplied up sharply per prior use, so a not-yet-used
// detour around the other side of a loop is strongly preferred over blindly
// retracing — while a genuine dead-end (no alternative exists at all, see
// the dead-end repro case) still completes, just at the correctly-higher
// cost, since there's nothing else to prefer.
const REPEAT_EDGE_PENALTY_FACTOR = 8;
function dijkstraPath(graph: RoadGraph, fromKey: string, toKey: string, usedCounts?: Map<string, number>): { points: RoadPoint[]; edgeIds: string[] } | null {
  const dist = new Map<string, number>([[fromKey, 0]]);
  const prevNode = new Map<string, string>();
  const prevEdge = new Map<string, string>();
  const visited = new Set<string>();
  while (true) {
    let u: string | null = null, ud = Infinity;
    for (const [k, d] of dist) { if (!visited.has(k) && d < ud) { ud = d; u = k; } }
    if (u === null || u === toKey) break;
    visited.add(u);
    for (const eid of graph.nodes.get(u)!.edgeIds) {
      const e = graph.edges.get(eid)!;
      const vKey = e.aKey === u ? e.bKey : e.aKey;
      const priorUses = usedCounts?.get(eid) ?? 0;
      const weight = e.dist * (1 + REPEAT_EDGE_PENALTY_FACTOR * priorUses);
      const nd = ud + weight;
      if (nd < (dist.get(vKey) ?? Infinity)) {
        dist.set(vKey, nd); prevNode.set(vKey, u); prevEdge.set(vKey, eid);
      }
    }
  }
  if (!dist.has(toKey)) return null;
  const edgeIds: string[] = [];
  let cur = toKey;
  while (cur !== fromKey) {
    const eid = prevEdge.get(cur);
    if (!eid) return null;
    edgeIds.push(eid);
    cur = prevNode.get(cur)!;
  }
  edgeIds.reverse();
  const points: RoadPoint[] = [];
  let atKey = fromKey;
  for (const eid of edgeIds) {
    const e = graph.edges.get(eid)!;
    const forward = e.aKey === atKey;
    const seg = forward ? e.points : [...e.points].reverse();
    if (points.length === 0) points.push(seg[0]);
    points.push(seg[seg.length - 1]);
    atKey = forward ? e.bKey : e.aKey;
  }
  return { points, edgeIds };
}
// Cap graph size so a huge whole-neighbourhood lasso selection can't hang
// the browser on O(V²) Dijkstra — falls back to the old chainer above this,
// same "never block, always produce something" principle every other
// best-effort step in this pipeline already follows.
const GRAPH_TRAVERSAL_MAX_NODES = 2500;

// Single-source Dijkstra distances to EVERY node (no edge-reuse penalty —
// this is only used to find where a turnaround branch attaches to the main
// spine, not to build the final path, so it must reflect true shortest
// distance, not a penalised one).
function dijkstraDistances(graph: RoadGraph, fromKey: string): Map<string, number> {
  const dist = new Map<string, number>([[fromKey, 0]]);
  const visited = new Set<string>();
  while (true) {
    let u: string | null = null, ud = Infinity;
    for (const [k, d] of dist) { if (!visited.has(k) && d < ud) { ud = d; u = k; } }
    if (u === null) break;
    visited.add(u);
    for (const eid of graph.nodes.get(u)!.edgeIds) {
      const e = graph.edges.get(eid)!;
      const vKey = e.aKey === u ? e.bKey : e.aKey;
      const nd = ud + e.dist;
      if (nd < (dist.get(vKey) ?? Infinity)) dist.set(vKey, nd);
    }
  }
  return dist;
}

export type TraversalReason = 'main-spine' | 'branch-out' | 'turnaround-return';
export interface TraversalEdgeStep {
  edgeId: string; from: string; to: string; reason: TraversalReason;
  roadName: string; lengthM: number;
}

// v73.112 — Craig, correcting v73.111's own description of itself: turnaround
// points are NOT sequential waypoints, and treating them as "route legs
// A→T1→T2→…→B" (what v73.111 actually did, one dijkstraPath() call per
// consecutive pair in creation order) is wrong regardless of the edge-reuse
// penalty, because it forces the route to travel BETWEEN turnarounds
// directly — including possibly crossing the whole selection — rather than
// servicing each one as a local branch off wherever the main route already
// passes closest to it. This is very likely the real source of the
// remaining ~3.39km (8.45 vs ~5.06km reference): REPEAT_EDGE_PENALTY_FACTOR
// discourages retracing an already-used edge, which is exactly the WRONG
// thing to discourage for a genuine turnaround return (J→branch→T then
// T→branch→J is supposed to reuse those exact edges) and can instead push
// Dijkstra onto a longer, technically-unused detour just to avoid the
// penalty — adding distance rather than removing it.
//
// New approach:
//   1. Compute ONE main spine: shortest path start→end through the selected
//      graph, completely ignoring turnarounds. This never repeats an edge
//      (Dijkstra shortest paths don't revisit nodes) and gives a stable,
//      order-independent backbone.
//   2. For each turnaround T, find the SPINE node it's actually closest to
//      (via a plain, unpenalised Dijkstra FROM T to the whole graph, then
//      picking the nearest node that's on the spine) — this is the branch's
//      entry/exit junction, decided by topology, never by T's creation
//      order or array position.
//   3. Walk the spine node-by-node. At each node, service every branch
//      whose entry junction is that node: travel out to T (reason
//      'branch-out'), then travel back over the EXACT SAME edges in reverse
//      (reason 'turnaround-return' — a literal array reversal, never routed
//      through Dijkstra/the penalty, so it can't be pushed onto a detour).
//      Only then continue one edge further along the spine (reason
//      'main-spine'). This guarantees turnarounds are serviced in the order
//      the spine actually reaches them, never in T-label/creation order.
// Every produced edge gets a `steps` record with its reason, road name and
// length so a caller can log exactly where distance is going (see
// runSelectRoadsBatch's debug log) instead of only a repeated-edge count.
// v73.113 — Craig's real-world test (A=B closed-loop route, 7 turnarounds)
// exposed a case the v73.112 spine rewrite didn't account for: when start
// and end are the SAME point (a loop route via "Set B=A"), dijkstraPath(A,A)
// collapses to a zero-edge path — there's nowhere to go, you're already
// there. That leaves EVERY turnaround attaching to that single degenerate
// "spine" point instead of to its real position around the loop, and each
// one independently re-walks the entire shared prefix out to its own
// branch — the repeated Weka Street blocks in Craig's console.table output
// (same edges as branch-out/turnaround-return four-plus times) are exactly
// that: N turnarounds sharing an approach path each redoing that whole
// approach from scratch, instead of it being walked once.
//
// A loop has no single meaningful "shortest path from A to itself" to use
// as a backbone. What it needs instead is a walk that covers every selected
// edge reachable from A exactly once in each direction — a depth-first
// spanning-tree traversal of the whole connected selected-road graph. This
// is the classic route-inspection pattern: descend an edge, recurse, back
// out over that same edge to the parent, try the next edge. Explicit
// recursion-frame backtracking means a return can only ever go back to its
// own immediate parent — it can't be pushed further up the tree by a
// child's child, which was the "backtracking propagates up the graph"
// failure mode the very first version of this fix was written to avoid.
// Implemented iteratively (explicit stack) so a long real selection can't
// blow the call stack.
//
// v73.117 — Craig confirmed the missing piece after a diagnostic back-and-
// forth: T3 (Moa Crescent meeting Weka Street) DOES physically connect —
// it's not a dead end — but Craig needs it treated as a MANDATORY
// turnaround regardless: truck drives to it, stops, reverses, continues —
// never flows straight through onto Weka Street just because that option
// exists. T1/T2/T4-T7 only "worked" by coincidence because they happen to
// be true dead-ends with no through option to accidentally take.
//
// Fix: turnaroundNodeKeys are now threaded into this function. Whenever the
// DFS arrives at a node that's in that set — via any edge, not the root
// start — it is forbidden from exploring ANY of that node's other edges
// during this visit, even ones that are unvisited and would otherwise be
// fair game. It immediately backtracks over the edge it arrived on. This
// doesn't lose coverage of whatever lies beyond it (e.g. Weka Street itself
// still needs sweeping) — that edge simply gets visited later, from a
// DIFFERENT frame, when the DFS reaches ITS other endpoint by some other
// route through the graph and tries that edge from there instead. When
// that happens, arriving back at the same turnaround node via that edge
// triggers the identical rule again — so a turnaround node always reverses
// on arrival, no matter which direction it's approached from, and can
// never be a pass-through in either direction.
// v73.118 — Craig, after v73.117: T3's fix (block every other edge at a
// turnaround node on arrival, forever) is correct for a genuine optional
// detour like T3/Weka Street, where the far side is reachable some OTHER
// way (the loop continues round and reaches it from its other end) — so
// blocking it here just correctly defers that coverage, nothing is lost.
// But T1 is different: it sits on the road that is the ONLY connection
// through to the rest of that section — a true cut vertex, not a spur.
// Blocking every other edge there unconditionally doesn't defer that
// coverage to "the other side" — there IS no other side, so the whole
// section beyond T1 silently never gets visited at all (75 selected
// edges in, only 59 points out). Distinguishing "optional detour" from
// "only way through" needs real graph structure, not another blanket
// rule: computeArticulationPoints() finds every node whose removal would
// disconnect the selected-road graph — a turnaround sitting on one of
// those genuinely has no alternate route to whatever lies beyond it.
//
// Fix: a turnaround node that ISN'T a cut vertex keeps the exact v73.117
// behaviour (reverse on arrival, block every other edge, that coverage
// happens later from the far side). A turnaround node that IS a cut
// vertex still gets its mandatory stop-and-reverse — Craig's actual
// requirement, "never flow straight through just because a through
// option exists" — but the maneuver is a genuine reverse-then-return: two
// extra traversals of the entry edge (there and back), after which the
// node's other edges are explored normally so the only-reachable-via-T1
// section still gets swept. Net effect at a cut-vertex turnaround: the
// truck visibly stops, backs up, comes forward again, then continues —
// exactly the mandatory-turnaround maneuver, just not a permanent block.
function computeArticulationPoints(graph: RoadGraph): Set<string> {
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const result = new Set<string>();
  const visited = new Set<string>();
  let timer = 0;
  interface AFrame { nodeKey: string; parentKey: string | null; parentEdgeId: string | null; edgeIdx: number; childCount: number }
  for (const rootKey of graph.nodes.keys()) {
    if (visited.has(rootKey)) continue;
    visited.add(rootKey);
    disc.set(rootKey, timer); low.set(rootKey, timer); timer++;
    const stack: AFrame[] = [{ nodeKey: rootKey, parentKey: null, parentEdgeId: null, edgeIdx: 0, childCount: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const node = graph.nodes.get(top.nodeKey)!;
      if (top.edgeIdx < node.edgeIds.length) {
        const eid = node.edgeIds[top.edgeIdx];
        top.edgeIdx++;
        if (eid === top.parentEdgeId) continue; // don't walk straight back over the exact edge we arrived by
        const e = graph.edges.get(eid)!;
        const to = e.aKey === top.nodeKey ? e.bKey : e.aKey;
        if (!visited.has(to)) {
          visited.add(to);
          disc.set(to, timer); low.set(to, timer); timer++;
          top.childCount++;
          stack.push({ nodeKey: to, parentKey: top.nodeKey, parentEdgeId: eid, edgeIdx: 0, childCount: 0 });
        } else {
          low.set(top.nodeKey, Math.min(low.get(top.nodeKey)!, disc.get(to)!));
        }
      } else {
        stack.pop();
        if (stack.length > 0) {
          const parent = stack[stack.length - 1];
          low.set(parent.nodeKey, Math.min(low.get(parent.nodeKey)!, low.get(top.nodeKey)!));
          if (parent.parentKey === null) {
            if (parent.childCount > 1) result.add(parent.nodeKey);
          } else if (low.get(top.nodeKey)! >= disc.get(parent.nodeKey)!) {
            result.add(parent.nodeKey);
          }
        }
      }
    }
  }
  return result;
}

function traverseLoopCoverage(
  graph: RoadGraph, startKey: string, turnaroundNodeKeys: Set<string>
): { points: RoadPoint[]; edgeUseCounts: Map<string, number>; steps: TraversalEdgeStep[] } {
  const articulationPoints = computeArticulationPoints(graph);
  const edgeUseCounts = new Map<string, number>();
  const steps: TraversalEdgeStep[] = [];
  const visitedEdges = new Set<string>();
  const nodePoint = (key: string): RoadPoint => { const n = graph.nodes.get(key)!; return { lat: n.lat, lng: n.lng }; };
  const allPoints: RoadPoint[] = [nodePoint(startKey)];
  const record = (eid: string, from: string, to: string, reason: TraversalReason) => {
    const e = graph.edges.get(eid)!;
    steps.push({ edgeId: eid, from, to, reason, roadName: e.roadName, lengthM: e.dist });
    edgeUseCounts.set(eid, (edgeUseCounts.get(eid) ?? 0) + 1);
    allPoints.push(nodePoint(to));
  };
  interface Frame { nodeKey: string; edgeIdx: number; enteredViaEdge: string | null; reversedAtCutVertex: boolean }
  const stack: Frame[] = [{ nodeKey: startKey, edgeIdx: 0, enteredViaEdge: null, reversedAtCutVertex: false }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const node = graph.nodes.get(top.nodeKey)!;
    // A turnaround-marked node reversed on arrival. Doesn't apply to the
    // very start of the whole walk (enteredViaEdge === null): starting AT
    // a turnaround with A=B is an edge case with no "arrival" to reverse
    // from, so it behaves as an ordinary junction.
    const mustReverseHere = top.enteredViaEdge !== null && turnaroundNodeKeys.has(top.nodeKey);
    const isCutVertexTurnaround = mustReverseHere && articulationPoints.has(top.nodeKey);
    if (isCutVertexTurnaround && !top.reversedAtCutVertex) {
      // Genuine "only way through" — do the mandatory stop-and-reverse
      // maneuver (back over the entry edge, then come forward over it
      // again) so the visit still reads as a turnaround, then fall through
      // below to explore the node's other edges normally instead of the
      // permanent block a true optional-detour turnaround gets.
      const enteredEdge = top.enteredViaEdge!;
      const parent = stack[stack.length - 2];
      record(enteredEdge, top.nodeKey, parent.nodeKey, 'turnaround-return');
      record(enteredEdge, parent.nodeKey, top.nodeKey, 'turnaround-return');
      top.reversedAtCutVertex = true;
    }
    const blockFurtherEdges = mustReverseHere && !isCutVertexTurnaround;
    let descended = false;
    if (!blockFurtherEdges) {
      while (top.edgeIdx < node.edgeIds.length) {
        const eid = node.edgeIds[top.edgeIdx];
        top.edgeIdx++;
        if (visitedEdges.has(eid)) continue; // already covered from the other end, or a cycle-closing edge — skip, don't retrace
        visitedEdges.add(eid);
        const e = graph.edges.get(eid)!;
        const to = e.aKey === top.nodeKey ? e.bKey : e.aKey;
        record(eid, top.nodeKey, to, stack.length === 1 ? 'main-spine' : 'branch-out');
        stack.push({ nodeKey: to, edgeIdx: 0, enteredViaEdge: eid, reversedAtCutVertex: false });
        descended = true;
        break;
      }
    }
    if (!descended) {
      stack.pop();
      if (top.enteredViaEdge !== null && stack.length > 0) {
        const parent = stack[stack.length - 1];
        record(top.enteredViaEdge, top.nodeKey, parent.nodeKey, 'turnaround-return');
      }
    }
  }
  return { points: allPoints, edgeUseCounts, steps };
}

function traverseSelectedGraphOrdered(
  graph: RoadGraph, start: RoadPoint, waypointsInOrder: RoadPoint[], end: RoadPoint
): { points: RoadPoint[]; edgeUseCounts: Map<string, number>; steps: TraversalEdgeStep[] } | null {
  if (graph.nodes.size > GRAPH_TRAVERSAL_MAX_NODES) return null;
  const startKey = nearestGraphNodeKey(graph, start);
  const endKey = nearestGraphNodeKey(graph, end);
  if (!startKey || !endKey) return null;

  if (startKey === endKey) {
    const turnaroundNodeKeys = new Set<string>();
    for (const wp of waypointsInOrder) {
      const k = nearestGraphNodeKey(graph, wp);
      if (k) turnaroundNodeKeys.add(k);
    }
    return traverseLoopCoverage(graph, startKey, turnaroundNodeKeys);
  }

  const spine = dijkstraPath(graph, startKey, endKey);
  if (!spine) return null; // start/end aren't connected within the selected-road graph — caller falls back

  // Ordered list of spine nodes, derived by walking spine.edgeIds from start.
  const spineNodeKeys: string[] = [startKey];
  { let at = startKey;
    for (const eid of spine.edgeIds) {
      const e = graph.edges.get(eid)!;
      at = e.aKey === at ? e.bKey : e.aKey;
      spineNodeKeys.push(at);
    }

  }
  // First occurrence only — a shortest path can't revisit a node, but guard
  // against a degenerate zero-length loop in the source data regardless.
  const spineIndexOf = new Map<string, number>();
  spineNodeKeys.forEach((k, i) => { if (!spineIndexOf.has(k)) spineIndexOf.set(k, i); });

  // Attach each turnaround to the spine node it's topologically closest to,
  // independent of the order T points were created/clicked in.
  interface Branch { entryKey: string; outEdgeIds: string[] }
  const branchesByEntry = new Map<string, Branch[]>();
  for (const wp of waypointsInOrder) {
    const tKey = nearestGraphNodeKey(graph, wp);
    if (!tKey || spineIndexOf.has(tKey)) continue; // no node found, or T sits ON the spine already — nothing to branch out to
    const distFromT = dijkstraDistances(graph, tKey);
    let bestKey: string | null = null, bestDist = Infinity;
    for (const sk of spineIndexOf.keys()) {
      const d = distFromT.get(sk);
      if (d !== undefined && d < bestDist) { bestDist = d; bestKey = sk; }
    }
    if (bestKey === null) continue; // T unreachable from the spine within this selected-road graph
    const outbound = dijkstraPath(graph, bestKey, tKey);
    if (!outbound || outbound.edgeIds.length === 0) continue;
    const list = branchesByEntry.get(bestKey) ?? [];
    list.push({ entryKey: bestKey, outEdgeIds: outbound.edgeIds });
    branchesByEntry.set(bestKey, list);
  }

  const nodePoint = (key: string): RoadPoint => { const n = graph.nodes.get(key)!; return { lat: n.lat, lng: n.lng }; };
  const allPoints: RoadPoint[] = [nodePoint(startKey)];
  const edgeUseCounts = new Map<string, number>();
  const steps: TraversalEdgeStep[] = [];
  const record = (eid: string, from: string, to: string, reason: TraversalReason) => {
    const e = graph.edges.get(eid)!;
    steps.push({ edgeId: eid, from, to, reason, roadName: e.roadName, lengthM: e.dist });
    edgeUseCounts.set(eid, (edgeUseCounts.get(eid) ?? 0) + 1);
    allPoints.push(nodePoint(to));
  };

  for (let i = 0; i < spineNodeKeys.length; i++) {
    const nodeKey = spineNodeKeys[i];
    for (const br of branchesByEntry.get(nodeKey) ?? []) {
      let at = nodeKey;
      for (const eid of br.outEdgeIds) {
        const e = graph.edges.get(eid)!;
        const to = e.aKey === at ? e.bKey : e.aKey;
        record(eid, at, to, 'branch-out');
        at = to;
      }
      for (let j = br.outEdgeIds.length - 1; j >= 0; j--) {
        const eid = br.outEdgeIds[j];
        const e = graph.edges.get(eid)!;
        const to = e.aKey === at ? e.bKey : e.aKey;
        record(eid, at, to, 'turnaround-return');
        at = to;
      }
    }
    if (i < spineNodeKeys.length - 1) {
      const eid = spine.edgeIds[i];
      const e = graph.edges.get(eid)!;
      const to = e.aKey === nodeKey ? e.bKey : e.aKey;
      record(eid, nodeKey, to, 'main-spine');
    }
  }

  return { points: allPoints, edgeUseCounts, steps };
}


// TRUE (unoffset) coordinates by default (roadOffsetMetres now defaults to 0,
// was ROAD_LABEL_OFFSET_METRES) — offsetting now happens exactly once, on the
// finished chain, by whichever caller needs it (see addSelectedRoadsToSegment
// below). This also retires the v73.31 "must remember to pass 0 on the
// second merge call or it double-offsets" landmine entirely, rather than
// just working around it — there's no longer an offset parameter threaded
// through two merge calls to get wrong in the first place.
function mergeRoadFeaturesIntoPath(features: RoadFeature[], existingChain?: RoadPoint[], manualStartPoint?: RoadPoint | null, roadOffsetMetres: number = 0, manualEndPoint?: RoadPoint | null): RoadPoint[] {
  // Offset every road-derived piece before merging — existingChain (any
  // points the user already drew by hand with Draw Points) is passed
  // through completely untouched below, only ever used to seed the start
  // of the chain, never routed through this offset step.
  const pieces = features.map(f => roadOffsetMetres === 0 ? f.coords.slice() : offsetPerpendicular(f.coords.slice(), roadOffsetMetres));
  // v73.68 — parallel array of street names, one per coordinate in `pieces`,
  // mirrored through every splice/reverse/concat the chaining loop below does
  // to `pieces` itself, so the final output can tag each point with which
  // real street it came from (feeds "Split Segment by Street"). offsetPerpendicular
  // preserves point count/order 1:1 so this stays aligned with zero extra work.
  // v73.82 — a feature can now carry its own per-point `pointNames` (see the
  // RoadFeature comment) instead of one shared `name` for every coordinate.
  // Used when this function is fed a synthetic "already-chained, possibly
  // multi-street" pseudo-feature (addSelectedRoadsToSegment's loopFeature)
  // rather than a real single-street RoadFeature straight from /api/roads.
  // Falls back to the old name-per-feature behaviour whenever pointNames is
  // absent or its length doesn't line up with coords, so this can never
  // silently misalign tags onto the wrong point.
  const pieceTags: string[][] = features.map(f =>
    (f.pointNames && f.pointNames.length === f.coords.length) ? f.pointNames.slice() : f.coords.map(() => f.name)
  );
  // v73.99 — Bug #6 fix: parallel per-coordinate transit array, mirrored
  // through every splice/reverse/concat this function does to `pieces`,
  // exactly the same pattern pieceTags already uses. See RoadFeature's
  // `pointTransit` comment for why this exists.
  const pieceTransit: (boolean | undefined)[][] = features.map(f =>
    (f.pointTransit && f.pointTransit.length === f.coords.length) ? f.pointTransit.slice() : f.coords.map(() => undefined)
  );
  if (pieces.length === 0) return existingChain ? existingChain.slice() : [];
  const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const TOLERANCE_DEG = 0.0004; // ~40m

  // v73.47 — Craig: "can set A point but not B" — mirrors the manualStartPoint
  // seeding below, but for the FAR end. Only meaningful for a fresh chain
  // (no existingChain, and more than one piece — a single selected piece has
  // exactly two ends already spoken for by the start anchor). Reserve
  // whichever piece/endpoint sits closest to manualEndPoint out of the pool
  // BEFORE the normal start-seeding/greedy-chaining runs, oriented so the
  // chosen point ends up literally last, then re-attach it at the very end
  // once every other piece has been chained. If it doesn't turn out to sit
  // flush against the rest of the chain, fillGapsWithRealRoads (called right
  // after this function by addSelectedRoadsToSegment) closes that gap with
  // real road geometry — same fallback the existing chaining already relies on.
  // v73.104 — Craig: "set A and B point at the same location" button wasn't
  // working — clicking it silently produced a broken/wrong chain instead of
  // a closed loop. Root cause: when A and B are the exact same coordinate
  // (same node), the endSeed reservation below would greedily pull OUT the
  // one piece whose endpoint actually sits at that node (to reserve it for
  // B) — but that's the SAME piece the manualStartPoint seeding further down
  // needs to anchor A to. With it already spliced out of the pool, the start
  // search below falls back to an arbitrary/unrelated piece, so A silently
  // fails to anchor. Fix: when A and B coincide, skip the separate endSeed
  // reservation entirely (there's nothing distinct to reserve) and instead
  // let the normal start-anchored chain get built, then close the loop back
  // onto that same point afterward (see sameStartEndPoint below) — the
  // physical gap back to the start gets bridged by fillGapsWithRealRoads
  // (real-road/OSRM routing) same as any other unclosed edge.
  const sameStartEndPoint = !!(manualStartPoint && manualEndPoint &&
    Math.abs(manualStartPoint.lat - manualEndPoint.lat) < 1e-9 &&
    Math.abs(manualStartPoint.lng - manualEndPoint.lng) < 1e-9);
  let endSeed: [number, number][] | null = null;
  let endSeedTags: string[] | null = null;
  let endSeedTransit: (boolean | undefined)[] | null = null;
  if (!existingChain && manualEndPoint && pieces.length > 1 && !sameStartEndPoint) {
    const target: [number, number] = [manualEndPoint.lng, manualEndPoint.lat];
    let bestIdx = -1, bestScore = Infinity, bestReverse = false;
    pieces.forEach((coords, i) => {
      const dStart = dist(target, coords[0]);
      const dEnd = dist(target, coords[coords.length - 1]);
      // bestReverse=true means the target matched this piece's START, so
      // flip it so the target point lands at the LAST index instead.
      if (dStart < bestScore) { bestScore = dStart; bestIdx = i; bestReverse = true; }
      if (dEnd < bestScore) { bestScore = dEnd; bestIdx = i; bestReverse = false; }
    });
    if (bestIdx !== -1 && bestScore <= TOLERANCE_DEG) {
      let seed = pieces.splice(bestIdx, 1)[0];
      let seedTags = pieceTags.splice(bestIdx, 1)[0];
      let seedTransit = pieceTransit.splice(bestIdx, 1)[0];
      if (bestReverse) { seed = seed.slice().reverse(); seedTags = seedTags.slice().reverse(); seedTransit = reversePointTransit(seedTransit); }
      endSeed = seed;
      endSeedTags = seedTags;
      endSeedTransit = seedTransit;
    }
  }

  let chain: [number, number][];
  let chainTags: string[];
  let chainTransit: (boolean | undefined)[];
  // v73.65 — Craig, screenshot: with a large multi-road selection, A ended
  // up buried mid-array at a random dead end instead of staying at index 0,
  // even though B (the reserved endSeed) landed correctly. Root cause: the
  // greedy chaining loop below was always allowed to PREPEND a newly-picked
  // piece onto the front of `chain` (`piece.concat(chain)`) whenever that
  // was the closest fit — which silently moves whatever was at chain[0]
  // (the manually-seeded A point) into the interior of the array. B never
  // showed this because its piece is reserved out of the pool entirely and
  // concatenated on at the very end, after the loop — nothing can grow
  // "in front of" it. `startAnchored` tracks whether chain[0] is a real,
  // deliberate commitment (an already-drawn segment, or a manualStartPoint
  // that actually matched a piece) — once true, the loop below is
  // restricted to only ever grow the chain's END, never its front, so A
  // can't be displaced the same way B already can't be.
  let startAnchored = false;
  if (existingChain && existingChain.length > 0) {
    // Already-drawn points win over a manual start pick — that's a
    // stronger, earlier commitment than a point just clicked this session.
    chain = existingChain.map(p => [p.lng, p.lat] as [number, number]);
    // Preserve whatever streetName tags the existing points already carried
    // (e.g. from an earlier road-selection add) rather than discarding them.
    chainTags = existingChain.map(p => p.streetName || '');
    // v73.99 — same preservation for transitAfter: whatever's already on
    // the segment (e.g. an earlier normal-pass batch) must survive being
    // re-chained against, not just its coordinates/tags.
    chainTransit = existingChain.map(p => p.transitAfter === true ? true : undefined);
    startAnchored = true;
  } else if (manualStartPoint) {
    // v73.29: find whichever piece has an endpoint closest to the manually
    // chosen start point (matched in the same offset coordinate space the
    // pieces are already in), seed the chain there, oriented so the chosen
    // point ends up literally first. A ~40m tolerance guards against a
    // stale/mismatched point (e.g. from a road that's since scrolled out of
    // view) silently seeding from the wrong end — falls back to the normal
    // unseeded behaviour rather than guessing.
    const target: [number, number] = [manualStartPoint.lng, manualStartPoint.lat];
    let bestIdx = -1, bestScore = Infinity, bestReverse = false;
    pieces.forEach((coords, i) => {
      const dStart = dist(target, coords[0]);
      const dEnd = dist(target, coords[coords.length - 1]);
      if (dStart < bestScore) { bestScore = dStart; bestIdx = i; bestReverse = false; }
      if (dEnd < bestScore) { bestScore = dEnd; bestIdx = i; bestReverse = true; }
    });
    if (bestIdx !== -1 && bestScore <= TOLERANCE_DEG) {
      let seed = pieces.splice(bestIdx, 1)[0];
      let seedTags = pieceTags.splice(bestIdx, 1)[0];
      let seedTransit = pieceTransit.splice(bestIdx, 1)[0];
      if (bestReverse) { seed = seed.slice().reverse(); seedTags = seedTags.slice().reverse(); seedTransit = reversePointTransit(seedTransit); }
      chain = seed;
      chainTags = seedTags;
      chainTransit = seedTransit;
      startAnchored = true;
    } else {
      chain = pieces.shift()!;
      chainTags = pieceTags.shift()!;
      chainTransit = pieceTransit.shift()!;
    }
  } else if (manualEndPoint && !endSeed && !sameStartEndPoint) {
    // v73.47 — no start anchor, and no separate endSeed was reserved (only
    // happens when there's just a single selected piece — see the guard
    // above). Orient that one piece directly so manualEndPoint lands last,
    // same matching logic as the manualStartPoint branch just mirrored.
    const target: [number, number] = [manualEndPoint.lng, manualEndPoint.lat];
    let bestIdx = -1, bestScore = Infinity, bestReverse = false;
    pieces.forEach((coords, i) => {
      const dStart = dist(target, coords[0]);
      const dEnd = dist(target, coords[coords.length - 1]);
      if (dStart < bestScore) { bestScore = dStart; bestIdx = i; bestReverse = true; }
      if (dEnd < bestScore) { bestScore = dEnd; bestIdx = i; bestReverse = false; }
    });
    if (bestIdx !== -1 && bestScore <= TOLERANCE_DEG) {
      let seed = pieces.splice(bestIdx, 1)[0];
      let seedTags = pieceTags.splice(bestIdx, 1)[0];
      let seedTransit = pieceTransit.splice(bestIdx, 1)[0];
      if (bestReverse) { seed = seed.slice().reverse(); seedTags = seedTags.slice().reverse(); seedTransit = reversePointTransit(seedTransit); }
      chain = seed;
      chainTags = seedTags;
      chainTransit = seedTransit;
    } else {
      chain = pieces.shift()!;
      chainTags = pieceTags.shift()!;
      chainTransit = pieceTransit.shift()!;
    }
  } else {
    chain = pieces.shift()!;
    chainTags = pieceTags.shift()!;
    chainTransit = pieceTransit.shift()!;
  }
  while (pieces.length > 0) {
    let bestIdx = -1, bestScore = Infinity, bestReverse = false, bestAtStart = false;
    const chainStart = chain[0], chainEnd = chain[chain.length - 1];
    pieces.forEach((coords, i) => {
      const fStart = coords[0], fEnd = coords[coords.length - 1];
      // v73.65 — when startAnchored, chainStart (A) must never move, so the
      // two "attach at start" options are excluded from consideration
      // entirely here rather than merely deprioritised — every piece can
      // only ever be appended after chainEnd from this point on.
      const options = startAnchored
        ? [
            { d: dist(chainEnd, fStart),  atStart: false, reverse: false },
            { d: dist(chainEnd, fEnd),    atStart: false, reverse: true  },
          ]
        : [
            { d: dist(chainEnd, fStart),  atStart: false, reverse: false },
            { d: dist(chainEnd, fEnd),    atStart: false, reverse: true  },
            { d: dist(chainStart, fEnd),  atStart: true,  reverse: false },
            { d: dist(chainStart, fStart),atStart: true,  reverse: true  },
          ];
      options.forEach(o => { if (o.d < bestScore) { bestScore = o.d; bestIdx = i; bestReverse = o.reverse; bestAtStart = o.atStart; } });
    });
    if (bestIdx === -1) break;
    let piece = pieces.splice(bestIdx, 1)[0];
    let pieceTagsArr = pieceTags.splice(bestIdx, 1)[0];
    let pieceTransitArr = pieceTransit.splice(bestIdx, 1)[0];
    if (bestReverse) { piece = piece.slice().reverse(); pieceTagsArr = pieceTagsArr.slice().reverse(); pieceTransitArr = reversePointTransit(pieceTransitArr); }
    chain = bestAtStart ? piece.concat(chain) : chain.concat(piece);
    chainTags = bestAtStart ? pieceTagsArr.concat(chainTags) : chainTags.concat(pieceTagsArr);
    chainTransit = bestAtStart ? pieceTransitArr.concat(chainTransit) : chainTransit.concat(pieceTransitArr);
  }
  // v73.47 — attach the reserved manualEndPoint piece last, regardless of
  // which side it geometrically sits nearest to — it was pulled out of the
  // pool specifically so nothing else could get chained after it and steal
  // the "last point" spot.
  if (endSeed) {
    chain = chain.concat(endSeed);
    chainTags = chainTags.concat(endSeedTags || endSeed.map(() => ''));
    chainTransit = chainTransit.concat(endSeedTransit || endSeed.map(() => undefined));
  }
  // v73.104 — loop closure: A and B were the same point, so explicitly
  // append that point as the chain's final vertex (unless the greedy
  // chaining above already happened to land back on it within ~1m). This
  // doesn't draw a straight line across the gap itself — it just marks
  // where the chain needs to end; fillGapsWithRealRoads (run by the caller
  // right after this function) sees the resulting long edge back to the
  // start and routes it through real road geometry, same as any other
  // unconnected edge between two selected pieces.
  if (sameStartEndPoint && manualStartPoint && chain.length > 0) {
    const last = chain[chain.length - 1];
    const closesAlready = Math.hypot(last[0] - manualStartPoint.lng, last[1] - manualStartPoint.lat) < 0.00001;
    if (!closesAlready) {
      chain = chain.concat([[manualStartPoint.lng, manualStartPoint.lat]]);
      chainTags = chainTags.concat(['']);
      chainTransit = chainTransit.concat([undefined]);
    }
  }
  // De-dup consecutive near-identical points (shared junction nodes counted by both ways)
  const out: RoadPoint[] = [];
  const EPS = 0.00001; // ~1m
  chain.forEach(([lng, lat], i) => {
    const prev = out[out.length - 1];
    if (prev && Math.hypot(prev.lat - lat, prev.lng - lng) < EPS) return;
    const tag = chainTags[i];
    // v73.99 — Bug #6 fix: carry the threaded transitAfter flag onto the
    // output point, same as streetName already was. This is the step that
    // used to silently drop every transit mark — see RoadFeature's
    // `pointTransit` comment for the full root-cause story.
    const tr = chainTransit[i] === true;
    const base: RoadPoint = tag ? { lat, lng, streetName: tag } : { lat, lng };
    out.push(tr ? { ...base, transitAfter: true } : base);
  });
  return out;
}

// v73.34 — Craig, screenshot with green ticks (selected pieces that
// genuinely touch) vs red X's (the greedy chain cutting straight across
// blocks/houses between two pieces that don't touch): "is there a way to
// make sure that does the same as the green ticks rather than the red x's."
// After the greedy chain above is built, this scans it for edges long
// enough to be a real gap (not just ordinary vertex spacing within one
// continuous way) and asks the host-server's new /api/roads/connect
// endpoint for a real-road path between the two points — splicing that path
// in place of the straight jump when one's found. Falls back to leaving the
// original straight edge untouched for any edge where the server has no
// server configured, the request fails, or no real-road path exists in the
// local area (a genuinely isolated selection, or older host-server without
// this endpoint yet) — never blocks or throws, worst case is identical to
// today's straight-line behaviour for that one edge.
const ROAD_CONNECT_GAP_THRESHOLD_METRES = 20; // edges longer than this are treated as "not touching" and get a routing attempt
// v73.101 — Craig: extend the turnaround-radius hint to gap-fill routing
// too, not just Snap to Roads/Add to Segment's /match call — his screenshot's
// two red-circled points were a dead-end tip AND a T-junction rejoin, and
// gap-fill (this function, via /api/roads/connect) is the path that actually
// runs for a Select Roads/Lasso selection with a gap between pieces, not
// /match. Purely additive and opt-in: `turnarounds` is only ever the
// CURRENTLY-PLACED markers on the active segment (never auto-detected dead
// ends), so a road with none placed sends an identical request to before —
// zero behaviour change unless Craig has actually put a marker down.
function turnaroundsQueryParam(turnarounds: { lat: number; lng: number }[]): string {
  if (!turnarounds || turnarounds.length === 0) return '';
  return `&turnarounds=${encodeURIComponent(JSON.stringify(turnarounds.map(t => ({ lat: t.lat, lng: t.lng }))))}`;
}
async function fillGapsWithRealRoads(chain: RoadPoint[], syncServerUrl: string, syncToken: string, includeParams: string = '', turnarounds: { lat: number; lng: number }[] = []): Promise<RoadPoint[]> {
  if (!syncServerUrl || chain.length < 2) return chain;
  const gapIdxs: number[] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    if (haversine(chain[i], chain[i + 1]) >= ROAD_CONNECT_GAP_THRESHOLD_METRES) gapIdxs.push(i);
  }
  if (gapIdxs.length === 0) return chain;
  const turnaroundParam = turnaroundsQueryParam(turnarounds);
  const results = await Promise.all(gapIdxs.map(async (i) => {
    const a = chain[i], b = chain[i + 1];
    try {
      const resp = await fetch(
        `${syncServerUrl}/api/roads/connect?fromLng=${a.lng}&fromLat=${a.lat}&toLng=${b.lng}&toLat=${b.lat}${includeParams}${turnaroundParam}`,
        { headers: { 'X-Sync-Token': syncToken } }
      );
      if (!resp.ok) return null; // older host-server without this endpoint, or a server error — fall back silently
      const data = await resp.json();
      if (!data?.found || !Array.isArray(data.coords) || data.coords.length < 2) return null;
      return { i, coords: data.coords as [number, number][] };
    } catch {
      return null; // network hiccup — fall back silently, don't block the rest of the merge
    }
  }));
  const byIdx = new Map(results.filter((r): r is { i: number; coords: [number, number][] } => r !== null).map(r => [r.i, r.coords]));
  if (byIdx.size === 0) return chain;
  const out: RoadPoint[] = [];
  for (let i = 0; i < chain.length; i++) {
    out.push(chain[i]);
    const detour = byIdx.get(i);
    if (detour) {
      // Splice in the real-road path's INTERIOR points only — detour[0]/[detour.length-1]
      // are (within snap tolerance of) chain[i]/chain[i+1] themselves, already present.
      // PERF FIX (v73.37): buildLocalRoadGraph() (server.js) keys a graph node on
      // EVERY vertex of every OSM way, not just true intersections, so `detour`
      // can carry many nearly-collinear survey points along a single street.
      // Simplify before splicing so the segment gets the route's actual shape
      // (turns, curves) without every intermediate survey vertex bloating it.
      const detourLatLng = detour.map(([lng, lat]) => ({ lat, lng }));
      const simplified = simplifyPath(detourLatLng, 1.5);
      simplified.slice(1, -1).forEach(p => out.push({ lat: p.lat, lng: p.lng }));
    }
  }
  return out;
}

// v73.82 — re-attaches streetName tags (v73.68, feeds "Split Segment by
// Street") to a chain of points that came back from OSRM's /match with no
// knowledge of tags at all. OSRM's snapped geometry doesn't line up 1:1 with
// the points sent to it (it can add/drop/shift points to follow the real
// road), so this can't just reuse the offsetPerpendicular index-preserving
// trick — for each snapped point, finds the closest TAGGED point in the
// pre-snap chain and copies its streetName across, but only if that closest
// point is within SNAP_RETAG_RADIUS_METRES; otherwise the point is left
// untagged, same as any other point with no well-defined street (e.g. a
// gap-fill detour, or a genuinely ambiguous stretch right at a street
// boundary). Purely a best-effort cosmetic aid for the Split button — never
// required to be exact, and errs toward leaving a point untagged over
// guessing wrong.
const SNAP_RETAG_RADIUS_METRES = 20;
function retagSnappedPoints(snapped: RoadPoint[], preSnap: RoadPoint[]): RoadPoint[] {
  const tagged = preSnap.filter(p => !!p.streetName);
  if (tagged.length === 0) return snapped;
  return snapped.map(p => {
    let bestTag = '';
    let bestDist = Infinity;
    for (const o of tagged) {
      const d = haversine(p, o);
      if (d < bestDist) { bestDist = d; bestTag = o.streetName!; }
    }
    if (bestDist <= SNAP_RETAG_RADIUS_METRES) {
      return p.transitAfter ? { lat: p.lat, lng: p.lng, transitAfter: true, streetName: bestTag } : { lat: p.lat, lng: p.lng, streetName: bestTag };
    }
    return p;
  });
}

function MultiSegmentRoadMap({ segments, activeSegIdx, onSegmentsChange, segmentNames = [], color = '#6366F1', segmentColors = [], showNumbers = true, showMarkers = true, height = 460, syncServerUrl = '', syncToken = '', centerHint = null, autoSearchQuery = '', onPendingSelectionChange, draftKey = 'new-road', turnarounds = [], onTurnaroundsChange }: MultiSegmentRoadMapProps) {
  const [citySearch, setCitySearch] = React.useState('');
  const [citySearching, setCitySearching] = React.useState(false);
  const [cityError, setCityError] = React.useState('');
  const [transitMode, setTransitMode] = React.useState(false); // toolbar toggle: new points mark previous edge as transit
  const transitModeRef = useRef(false);
  // v73.100 — Turnaround Points toolbar toggle: while on, a plain map click
  // (Draw Points mode only) drops an independent turnaround marker instead
  // of adding a route point. Mirrors transitMode's own ref-mirroring pattern
  // exactly, since the click handler below runs inside a Leaflet callback
  // captured once at mount and must read the LATEST value via a ref.
  const [turnaroundMode, setTurnaroundMode] = React.useState(false);
  const turnaroundModeRef = useRef(false);
  const turnaroundsRef = useRef<TurnaroundPoint[][]>(turnarounds);
  const onTurnaroundsChangeRef = useRef(onTurnaroundsChange);
  const turnaroundMarkersRef = useRef<L.Marker[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const polylinesRef = useRef<L.Polyline[]>([]);
  const markersRef = useRef<(L.Marker | L.CircleMarker)[][]>([]);
  const midMkRef = useRef<L.Marker[]>([]);
  const dragPreviewRef = useRef<L.Polyline | null>(null); // live drag preview — avoids rebuildAll during drag

  // ── v73.12: Select Roads mode — build a segment from existing road geometry
  // instead of clicking every point by hand. "Draw Points" (existing A-to-B
  // click-to-draw) is completely untouched; this is an alternate way to
  // populate the same RoadPoint[] array, side by side with it.
  const [editorMode, setEditorMode] = React.useState<'draw' | 'select'>('draw');
  const editorModeRef = useRef<'draw' | 'select'>('draw');
  const [lassoActive, setLassoActive] = React.useState(false);
  const lassoActiveRef = useRef(false);
  // v73.16 — Craig: needed a fast way to bulk-remove roads that lasso mode
  // had accidentally picked up, without wiping the whole selection (the
  // existing "Clear" button already does that). Lasso Deselect reuses the
  // exact same fence-drawing mechanism, just subtracting the hit roads from
  // selectedRoadIds instead of adding them, so it's a one-tap toggle rather
  // than a second tool to learn.
  const [lassoMode, setLassoMode] = React.useState<'select' | 'deselect'>('select');
  const lassoModeRef = useRef<'select' | 'deselect'>('select');
  useEffect(() => { lassoModeRef.current = lassoMode; }, [lassoMode]);
  // v73.29 — Craig's original request #2: "allow users to manually define
  // start (A) and end (B) points BEFORE segment creation in lasso mode...
  // critical use case: dead-end roads where start/end orientation matters."
  // The merge algorithm otherwise picks a start by nearest-endpoint
  // chaining alone, with no way to say "no, start HERE specifically."
  // settingStartPoint is a one-shot "pick mode" — turn it on, click an
  // endpoint marker on any currently-selected road, it captures that exact
  // point and turns itself back off. manualStartPoint then seeds
  // mergeRoadFeaturesIntoPath's chain-building for the NEW selection only
  // (see addSelectedRoadsToSegment) — it's cleared after every commit/
  // Clear All/mode or segment switch, same lifecycle as the other
  // in-progress selection state above.
  const [settingStartPoint, setSettingStartPoint] = React.useState(false);
  const settingStartPointRef = useRef(false);
  useEffect(() => { settingStartPointRef.current = settingStartPoint; }, [settingStartPoint]);
  const [manualStartPoint, setManualStartPoint] = React.useState<RoadPoint | null>(null);
  const manualStartPointRef = useRef<RoadPoint | null>(null);
  useEffect(() => { manualStartPointRef.current = manualStartPoint; }, [manualStartPoint]);
  // v73.47 — Craig: "can set A point but not B" — symmetric manual end-point
  // pick, mirrors manualStartPoint/settingStartPoint exactly.
  const [settingEndPoint, setSettingEndPoint] = React.useState(false);
  const settingEndPointRef = useRef(false);
  useEffect(() => { settingEndPointRef.current = settingEndPoint; }, [settingEndPoint]);
  const [manualEndPoint, setManualEndPoint] = React.useState<RoadPoint | null>(null);
  const manualEndPointRef = useRef<RoadPoint | null>(null);
  useEffect(() => { manualEndPointRef.current = manualEndPoint; }, [manualEndPoint]);
  // v73.110 — Craig: "Add to Segment" was letting OSRM's /match snap and the
  // real-road gap-fill (/api/roads/connect) both pull in road geometry
  // outside the current selection — genuinely correct complaint, confirmed
  // by re-reading fillGapsWithRealRoads/runSelectRoadsBatch: both of those
  // steps call out to the FULL OSM/OSRM graph, not anything restricted to
  // selectedFeatures. mergeRoadFeaturesIntoPath itself (the step that turns
  // selectedFeatures into a chain in the first place) was already confirmed
  // clean — it only ever reads features[].coords, no network call at all —
  // so locking this down means skipping those two specific steps, not
  // rebuilding the chaining logic from scratch. Defaults ON: Craig's ask was
  // that this be the actual behaviour, not an opt-in most people won't find.
  const [strictSelectedRoadsOnly, setStrictSelectedRoadsOnly] = React.useState(true);
  const strictSelectedRoadsOnlyRef = useRef(true);
  useEffect(() => { strictSelectedRoadsOnlyRef.current = strictSelectedRoadsOnly; }, [strictSelectedRoadsOnly]);
  // v73.110 — "Segment needs rebuild" staleness tracking: Craig's screenshot
  // showed a segment already sitting at 226 generated points AND turnaround
  // mode still active with markers placed — read (reasonably) as "the
  // turnarounds are corrupting the generated result," when the more likely
  // read of the actual code is that the 226 points were generated by an
  // EARLIER Add to Segment click, the turnarounds were added afterward, and
  // nothing on screen said those 226 points no longer reflect the current
  // A/B/turnaround/selection state. This tracks exactly that gap: any
  // segment that already has generated points gets flagged dirty the moment
  // A, B, a turnaround, or the working selection changes underneath it —
  // cleared only when Add to Segment actually regenerates that segment.
  const [dirtySegs, setDirtySegs] = React.useState<Set<number>>(new Set());
  const dirtyTrackingMountedRef = useRef(false);
  // v73.19: fence SHAPE — Lasso (freeform polygon, click each point) or Box
  // (click 2 opposite corners, a rectangle is computed instantly). Craig
  // wanted a faster way to grab a cluster of accidentally-included
  // driveways/car-parks/service-lanes in Deselect mode without click-placing
  // a whole polygon around them — a box is quicker when the unwanted stuff
  // is roughly rectangular. Deliberately NOT a drag gesture (that was
  // v73.13's mistake — disabling map.dragging broke panning); still just
  // two ordinary clicks, so panning is never touched, same as Lasso.
  const [fenceShape, setFenceShape] = React.useState<'lasso' | 'box'>('lasso');
  const fenceShapeRef = useRef<'lasso' | 'box'>('lasso');
  useEffect(() => { fenceShapeRef.current = fenceShape; }, [fenceShape]);
  // v73.21/73.22 — the staged-for-removal queue used by Deselect mode.
  // v73.21: Ctrl+drag box highlights everything inside it here instead of
  // removing immediately — a fast drag gesture is easy to overshoot, and
  // undoing an accidental bulk-REMOVAL from a route someone spent time
  // building is a lot more costly than undoing an accidental bulk-add, so
  // Deselect gets a stage-then-confirm step that Select doesn't need.
  // v73.22 — Craig: single-click in Deselect mode had the same problem one
  // road at a time — it deleted immediately, with "no chance to review" and
  // no way to see multiple segments of the same road highlighted together
  // before committing. Single-click now feeds this exact same queue (toggles
  // membership rather than replacing it, so clicks accumulate), and Delete/
  // Escape/the confirm & cancel buttons all apply to whatever's staged
  // regardless of whether it got there via a click, a Ctrl+drag box, or both
  // mixed together in the same session.
  const [stagedForRemovalIds, setStagedForRemovalIds] = React.useState<Set<string>>(new Set());
  const stagedForRemovalIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => { stagedForRemovalIdsRef.current = stagedForRemovalIds; }, [stagedForRemovalIds]);
  // v73.23 — Draw Points bulk delete/transit-convert, developer-prompt spec.
  // Same staged-then-confirm pattern as stagedForRemovalIds above, but for
  // POINTS and LINE SEGMENTS within the active segment being hand-drawn —
  // entirely separate queue, only ever touched while editorMode === 'draw',
  // never interacting with the Select Roads staging above. Indices are
  // stable for the lifetime of a staging session because nothing removes or
  // reorders array entries until the single atomic commit at Confirm —
  // dragging a point only changes its lat/lng, never its index. The one
  // exception is the midpoint "insert point" handles, which DO shift every
  // later index by one — those explicitly clear both sets on use (see the
  // midpoint click handler) rather than risk staging/deleting the wrong
  // point afterward.
  const [stagedPointIdx, setStagedPointIdx] = React.useState<Set<number>>(new Set());
  const stagedPointIdxRef = useRef<Set<number>>(new Set());
  useEffect(() => { stagedPointIdxRef.current = stagedPointIdx; }, [stagedPointIdx]);
  const [stagedLineIdx, setStagedLineIdx] = React.useState<Set<number>>(new Set()); // edge j = the line from pts[j] to pts[j+1]
  const stagedLineIdxRef = useRef<Set<number>>(new Set());
  useEffect(() => { stagedLineIdxRef.current = stagedLineIdx; }, [stagedLineIdx]);
  const clearDrawStaging = () => {
    stagedPointIdxRef.current = new Set(); setStagedPointIdx(new Set());
    stagedLineIdxRef.current = new Set(); setStagedLineIdx(new Set());
  };
  const clearDrawStagingRef = useRef(clearDrawStaging);
  useEffect(() => { clearDrawStagingRef.current = clearDrawStaging; });

  // v73.23 — developer-prompt acceptance criterion #16: each confirmed bulk
  // delete/transit-convert must be reversible as a SINGLE Undo step. There's
  // no general undo-history stack anywhere in this editor to hook into (the
  // existing "↩ Undo" button is a one-off — it only ever removes the single
  // most-recently-added point via `.slice(0,-1)`) — building a full
  // multi-level undo/redo system is well beyond what this fix needs, so
  // this is deliberately a single-slot, single-use snapshot: only the ONE
  // most recent bulk action can be undone, and only until some OTHER edit
  // touches the same segment afterward (every other point-mutating action
  // in this file — drag, midpoint insert, single-point delete, the
  // existing point-Undo, Clear — explicitly clears this snapshot, since
  // silently restoring over a newer edit would discard it without warning,
  // which is worse than just not offering the undo anymore).
  // v73.69 — Craig: Simplify Points had ZERO undo at all ("can't be undone
  // with Ctrl+Z"), while Find Long Jumps/Find Duplicate Lines only ever got
  // ONE level via this single-slot snapshot — a second bulk action before
  // reviewing the first's result silently discarded the ability to undo it.
  // Promoted to a capped history STACK (20 deep) instead of one slot, and
  // Simplify/Reverse/Clear now push onto it too, same as Delete/Transit
  // already did. Still cleared entirely by any OTHER point-mutating action
  // (drag, midpoint insert, single-point delete) — restoring an older
  // snapshot over edits the user made in between would silently discard
  // those, which is worse than just not offering the undo. Within the
  // stack itself that risk doesn't apply, since every entry is strictly
  // older work on the same lineage, popped most-recent-first.
  const BULK_UNDO_STACK_LIMIT = 20;
  const bulkUndoStackRef = useRef<{ segIdx: number; points: RoadPoint[]; kind: 'delete' | 'transit' | 'simplify' | 'reverse' | 'clear' | 'addSegment' }[]>([]);
  const [bulkUndoCount, setBulkUndoCount] = React.useState(0);
  const pushBulkUndo = (segIdx: number, points: RoadPoint[], kind: 'delete' | 'transit' | 'simplify' | 'reverse' | 'clear' | 'addSegment') => {
    const stack = bulkUndoStackRef.current;
    stack.push({ segIdx, points, kind });
    if (stack.length > BULK_UNDO_STACK_LIMIT) stack.shift();
    setBulkUndoCount(stack.length);
  };
  const clearBulkUndo = () => { bulkUndoStackRef.current = []; setBulkUndoCount(0); };
  const clearBulkUndoRef = useRef(clearBulkUndo);
  useEffect(() => { clearBulkUndoRef.current = clearBulkUndo; });
  // v73.79 — Craig: "Undo button not working" after "✓ Add to Segment".
  // Root cause: addSelectedRoadsToSegment's own pushBulkUndo() call was
  // immediately wiped by the [activeSegIdx, editorMode] cleanup effect
  // below, because that function's last step is setEditorMode('draw') —
  // which is exactly the mode change that effect watches for, and it
  // unconditionally clears the bulk-undo stack on every such change (by
  // design, for the segment/mode-switch case it was written for — see
  // v73.30 note above). One-shot flag: set immediately before the
  // pushBulkUndo+setEditorMode('draw') pair in addSelectedRoadsToSegment,
  // consumed (and reset) by the effect the very next time it fires, so
  // that specific transition skips the clear while every other
  // segment/mode switch still clears as before.
  const suppressNextBulkUndoClearRef = useRef(false);
  const bulkUndoKind = bulkUndoStackRef.current.length > 0
    ? bulkUndoStackRef.current[bulkUndoStackRef.current.length - 1].kind
    : null;
  const undoBulkAction = () => {
    const stack = bulkUndoStackRef.current;
    const last = stack.pop();
    setBulkUndoCount(stack.length);
    if (!last) return;
    const { segIdx, points } = last;
    const updated = liveSegsRef.current.map((s, si) => si === segIdx ? points : s);
    liveSegsRef.current = updated;
    onChangeRef.current(updated);
    rebuildAllRef.current();
  };

  // v73.23 — developer-prompt Fix 3: commit the staged queue as ONE atomic
  // point removal. A staged LINE (edge j) means "remove both its endpoint
  // points" — the union with any directly-staged points, then a single
  // `.filter()` over the active segment's points array. Filtering an array
  // naturally closes the gap between whatever's left on either side of a
  // removed run, which IS the auto-reconnect the spec asks for (A's next
  // surviving neighbour becomes whatever point immediately follows the
  // removed run) — no separate reconnect step needed. km total, point
  // count, and segment-tab point count are all derived live from this same
  // array elsewhere in the file, so they update the moment this commits,
  // with no separate recalculation step required either.
  const commitDrawStagedDelete = () => {
    const idx = activeIdxRef.current;
    const pts = liveSegsRef.current[idx] || [];
    const toRemove = new Set(stagedPointIdxRef.current);
    stagedLineIdxRef.current.forEach(j => { toRemove.add(j); toRemove.add(j + 1); });
    if (toRemove.size === 0) return;
    pushBulkUndo(idx, pts.slice(), 'delete');
    const updated = liveSegsRef.current.map((s, si) => si !== idx ? s : s.filter((_, pi) => !toRemove.has(pi)));
    liveSegsRef.current = updated;
    onChangeRef.current(updated);
    clearDrawStaging();
    rebuildAllRef.current();
  };
  const commitDrawStagedDeleteRef = useRef(commitDrawStagedDelete);
  useEffect(() => { commitDrawStagedDeleteRef.current = commitDrawStagedDelete; });

  // v73.23 — developer-prompt Fix 4: convert the staged queue to Transit
  // instead of deleting it. A staged POINT gets transitAfter = true (the
  // same field the existing per-point Transit toggle already used) — for
  // the last point in the segment this is a harmless no-op, it has no
  // outgoing edge to mark anyway. A staged LINE (edge j) sets
  // pts[j].transitAfter = true directly, same effect, expressed the other
  // way round (marking the edge itself rather than its start point).
  // v73.25 — Bug #3 fix: this previously always forced transitAfter to `true`,
  // so a line that was ALREADY transit could never be converted back to solid
  // through this button — the only way "back to solid" ever worked was via the
  // v73.23 staging queue not existing yet (i.e. never, once that shipped).
  // v73.41 — Craig: "have either it in transit or solid line mode options so
  // when I'm selecting multiple things it's not changing in between the two
  // it's either changing into one or the other that is set." The v73.25 fix
  // above made this a smart toggle (all-transit → all-solid, otherwise →
  // all-transit) — consistent in outcome, but which way a mixed selection
  // would go wasn't obvious from the button alone. Now takes an explicit
  // target instead of guessing from the current state — two buttons below
  // ("Set to Transit" / "Set to Solid"), always doing exactly what they say
  // regardless of what's currently staged.
  const commitDrawStagedTransitConvert = (targetTransit: boolean) => {
    const idx = activeIdxRef.current;
    const stagedPts = stagedPointIdxRef.current;
    const stagedLines = stagedLineIdxRef.current;
    if (stagedPts.size === 0 && stagedLines.size === 0) return;
    const pts = liveSegsRef.current[idx] || [];
    const stagedAll = new Set<number>([...stagedPts, ...stagedLines]);
    pushBulkUndo(idx, pts.slice(), 'transit');
    const updated = liveSegsRef.current.map((s, si) => {
      if (si !== idx) return s;
      return s.map((pt, pi) => stagedAll.has(pi) ? { ...pt, transitAfter: targetTransit } : pt);
    });
    liveSegsRef.current = updated;
    onChangeRef.current(updated);
    clearDrawStaging();
    rebuildAllRef.current();
  };

  // v73.24 — "Find Long Jumps": Craig's screenshot showed long straight
  // lines cutting across buildings/blocks between unrelated roads — the
  // known, previously-flagged consequence of mergeRoadFeaturesIntoPath's
  // greedy nearest-endpoint chaining having no distance cutoff, so it will
  // happily connect two genuinely disconnected clusters if that's the
  // closest match available. Auto-detects those edges and STAGES them as
  // LINES (not an immediate delete) — reuses the exact same staged queue
  // and Confirm/Cancel/Transit-convert UI Fix 1-4 already built, so Craig
  // decides per-jump whether to 🔀 Convert to Transit (keeps both real
  // point clusters, just hides the ugly connecting line and excludes it
  // from km — the safer default) or 🗑 Confirm Delete (actually removes the
  // boundary points, if that's genuinely what's wanted instead). No new
  // commit logic needed — only the detection step is new.
  //
  // Threshold: an edge counts as a "jump" if it's both over 60m AND at
  // least 4× the segment's own median edge length — the absolute floor
  // avoids flagging normal longer block-to-block edges in sparser/rural
  // areas, the relative multiplier avoids flagging normal edges in a
  // segment that's consistently long-legged throughout. Transit edges are
  // skipped entirely (already invisible/excluded, nothing to flag).
  const [noLongJumpsMessage, setNoLongJumpsMessage] = React.useState(false);
  const findLongJumps = () => {
    const idx = activeIdxRef.current;
    const pts = liveSegsRef.current[idx] || [];
    if (pts.length < 2) return;
    const edgeLens: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      if (pts[i].transitAfter) continue;
      edgeLens.push(haversine(pts[i], pts[i + 1]));
    }
    if (edgeLens.length === 0) return;
    const sorted = [...edgeLens].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const threshold = Math.max(60, median * 4);
    const hits = new Set<number>();
    for (let i = 0; i < pts.length - 1; i++) {
      if (pts[i].transitAfter) continue;
      if (haversine(pts[i], pts[i + 1]) >= threshold) hits.add(i);
    }
    if (hits.size === 0) {
      setNoLongJumpsMessage(true);
      setTimeout(() => setNoLongJumpsMessage(false), 3000);
      return;
    }
    setStagedLineIdx(prev => {
      const next = new Set(prev);
      hits.forEach(i => next.add(i));
      stagedLineIdxRef.current = next;
      return next;
    });
  };
  // v73.66 — "Find Duplicate Lines": Craig, screenshot — a dead-end/cul-de-sac
  // road sometimes ends up with extra lines and points on it, "2 or 3 times",
  // hard to pick out and remove by hand. Root cause: Select Roads mode has no
  // memory of what's already been added to the segment — re-selecting and
  // Add-to-Segment-ing the same physical road a second time (easy to do by
  // accident on a dead end, which sits at the edge of several different lasso
  // passes) runs it back through the exact same offsetPerpendicular() math,
  // producing a near-pixel-identical extra left/right pair right on top of
  // the one already there, since the convention (sweepBothSides) is already
  // exactly two lines per road — one either side — so a third+ occurrence at
  // the same spot is always excess, never legitimate.
  // Detection: group every non-transit edge by its two endpoints rounded to
  // ~1m and sorted (order-independent, so it doesn't matter which direction
  // either addition was drawn in, or which physical side ended up labelled
  // "left" vs "right" after a Reverse). A genuine one-either-side road
  // produces exactly 2 edges sharing a key; keep the first 2 occurrences
  // (in point order — the original pass) and stage every occurrence beyond
  // that as an excess duplicate, reusing the exact same staged-line
  // Confirm/Transit/Cancel review flow Find Long Jumps already uses.
  // v73.69 — Craig kept reporting this still missed real duplicates. Root
  // cause: it matched by rounded exact endpoints (~1m grid), so it only ever
  // caught a duplicate that happened to retrace the identical clicked
  // vertices. Two hand-drawn passes of the same street are never that —
  // different click points, and often opposite direction — so almost
  // nothing matched in practice. Replaced with a fuzzy, direction-agnostic
  // geometric match: an edge is a duplicate of another if BOTH of its
  // endpoints lie within DUPLICATE_MATCH_METRES of the other edge's line
  // (checked both ways), which catches "same street, different clicks,
  // either direction" while point-to-SEGMENT distance (not point-to-point)
  // makes it direction-agnostic for free. Threshold (15m) is comfortably
  // above the ~5m gap between a legitimate left/right sweepBothSides pair
  // (SWEEP_BOTH_SIDES_OFFSET_METRES=2.5 each side) so that real pair still
  // groups together as before, and comfortably below the width of a block,
  // so it won't bridge two genuinely different parallel streets.
  // Grouped with union-find over a spatial grid (candidates only checked
  // against edges whose midpoint falls in a nearby cell) to stay fast on a
  // ~1200-point segment instead of a full O(n²) pairwise scan. Within each
  // resulting group, same rule as before: the first 2 occurrences in point
  // order are the legitimate one-either-side pass, anything beyond that is
  // staged as excess.
  const DUPLICATE_MATCH_METRES = 15;
  // v73.96 — Craig, after "how can I show you any better" on a screenshot
  // where lines he considered obvious duplicates weren't flagged: the CAP
  // rule (max 2 legitimate passes per road, anything beyond that is
  // excess) was already exactly what he described — the gap was in
  // MATCHING, not policy. Pure geometric proximity (15m) can miss a
  // genuine re-add of the same road if each add-event's own sweepBothSides
  // offsetting put the two duplicate passes' lines further apart than
  // that. Edges sharing the same non-empty street name (already reliably
  // tagged through the whole pipeline since v73.82) are now ALSO grouped
  // together, using a wider distance allowance — but still bounded by a
  // distance, not name alone, since a single real long street can
  // legitimately span dozens of separate edges all sharing one name and
  // must never be treated as one giant "duplicate" cluster.
  const DUPLICATE_MATCH_METRES_SAME_STREET = 40;
  const [noDuplicatesMessage, setNoDuplicatesMessage] = React.useState(false);
  // v73.69 — "Snap to Roads": additive alongside Simplify/Long Jumps/
  // Duplicate Lines for now, not a replacement yet — see docker-compose.yml/
  // setup-osrm.sh comments for the new OSRM service this calls. Once this is
  // proven on real data those three heuristics can come out; until then they
  // stay as the fallback for anyone who hasn't stood up OSRM yet.
  const [snapInProgress, setSnapInProgress] = React.useState(false);
  const [snapMessage, setSnapMessage] = React.useState('');
  const snapToRoads = async () => {
    const idx = activeIdxRef.current;
    const pts = liveSegsRef.current[idx] || [];
    if (pts.length < 2) return;
    if (!syncServerUrlRef.current) {
      setSnapMessage('No sync server configured — set one up under System → Backup & Sync first.');
      setTimeout(() => setSnapMessage(''), 4000);
      return;
    }
    const hasTransit = pts.some(p => p.transitAfter === true);
    const ok = window.confirm(
      `Snap Segment ${segmentNames[idx] || String.fromCharCode(65 + idx)} to real roads via OSRM? This corrects the drawn points onto actual road geometry.` +
      (hasTransit ? '\n\n⚠️ This segment has Transit line markers — snapping rebuilds the point list, so Transit flags will be lost. Check Transit lines afterward.' : '') +
      `\n\nCurrently ${pts.length} points. Use ↩ Undo Bulk afterward if the result looks wrong.`
    );
    if (!ok) return;
    setSnapInProgress(true);
    try {
      const resp = await fetch(`${syncServerUrlRef.current}/api/roads/match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Token': syncTokenRef.current },
        body: JSON.stringify({
          points: pts.map(p => ({ lat: p.lat, lng: p.lng })),
          // v73.100 — pass this segment's turnaround points so the server can
          // tighten OSRM's per-point radius right at each one (see server.js).
          turnarounds: (turnaroundsRef.current[idx] || []).map(t => ({ lat: t.lat, lng: t.lng })),
          ...buildIncludeFlagsBody(),
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        setSnapMessage(`Snap failed: ${data.error || data.message || resp.statusText}`);
        setTimeout(() => setSnapMessage(''), 5000);
        return;
      }
      pushBulkUndo(idx, pts.slice(), 'simplify');
      // v73.82 — same fix as addSelectedRoadsToSegment's auto-snap: OSRM's
      // returned points have no idea `pts` was carrying streetName tags
      // (see retagSnappedPoints comment) — re-attach by nearest-neighbour
      // against the pre-snap segment instead of using data.points raw.
      const snappedPoints = retagSnappedPoints(data.points as RoadPoint[], pts);
      const updated = liveSegsRef.current.map((s, si) => si !== idx ? s : snappedPoints);
      liveSegsRef.current = updated;
      onChangeRef.current(updated);
      clearDrawStaging();
      rebuildAllRef.current();
      // v73.85 — was only ever reporting excludedRoadRejections here, which
      // made a batch silently falling back to raw for the OTHER two
      // reasons (OSRM NoMatch, or the 2.5x length-ratio sanity check) look
      // like a clean, total success.
      const totalRaw = data.rawFallbackBatches ?? data.excludedRoadRejections ?? 0;
      setSnapMessage(`Snapped: ${data.before} → ${data.after} points, following real roads.${totalRaw ? ` ⚠️ ${totalRaw} stretch${totalRaw === 1 ? '' : 'es'} could NOT be snapped and kept raw points — check the server log for why (excluded road class, no OSRM match, or an unreasonable-length match).` : ''}`);
      setTimeout(() => setSnapMessage(''), 4000);
    } catch (e: any) {
      setSnapMessage(`Snap failed: ${e?.message || 'network error — is the OSRM service running?'}`);
      setTimeout(() => setSnapMessage(''), 5000);
    } finally {
      setSnapInProgress(false);
    }
  };
  const findDuplicateLines = () => {
    const idx = activeIdxRef.current;
    const pts = liveSegsRef.current[idx] || [];
    if (pts.length < 2) return;
    const originLat = pts[0].lat;
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos((originLat * Math.PI) / 180);
    const toXY = (p: RoadPoint) => ({ x: p.lng * mPerDegLng, y: p.lat * mPerDegLat });
    type Edge = { i: number; ax: number; ay: number; bx: number; by: number; midX: number; midY: number; streetName: string };
    const edges: Edge[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      if (pts[i].transitAfter) continue;
      const a = toXY(pts[i]), b = toXY(pts[i + 1]);
      edges.push({ i, ax: a.x, ay: a.y, bx: b.x, by: b.y, midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2, streetName: pts[i].streetName || '' });
    }
    if (edges.length === 0) return;
    const distPointToSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
      const dx = bx - ax, dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx, cy = ay + t * dy;
      return Math.hypot(px - cx, py - cy);
    };
    // Spatial grid over edge midpoints, cell size = the WIDER of the two
    // match thresholds, so a same-street pair up to DUPLICATE_MATCH_METRES_
    // SAME_STREET apart still lands in a searchable neighbouring cell —
    // otherwise it'd never even become a candidate, regardless of what the
    // distance check below allows.
    const cellSize = DUPLICATE_MATCH_METRES_SAME_STREET;
    const cellKey = (x: number, y: number) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
    const grid = new Map<string, number[]>();
    edges.forEach((e, ei) => {
      const key = cellKey(e.midX, e.midY);
      const arr = grid.get(key);
      if (arr) arr.push(ei); else grid.set(key, [ei]);
    });
    const parent = edges.map((_, ei) => ei);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      const cx = Math.floor(e.midX / cellSize), cy = Math.floor(e.midY / cellSize);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const neighbours = grid.get(`${cx + dx},${cy + dy}`);
          if (!neighbours) continue;
          for (const ej of neighbours) {
            if (ej <= ei) continue; // each unordered pair once
            const o = edges[ej];
            if (Math.abs(o.i - e.i) <= 1) continue; // adjacent edges share a vertex, not a duplicate
            // v73.96 — the wider same-street threshold above is only safe
            // for edges that are far apart in point order. Two edges close
            // together in index (a normal bend in one continuous street)
            // can easily land within 40m of each other without being
            // duplicates at all — gate the wider allowance behind a real
            // index gap, so it only fires for genuinely separate re-add
            // events (which land far apart in the points array), not
            // ordinary consecutive points along a real curving road.
            const SAME_STREET_MIN_INDEX_GAP = 10;
            const d1 = distPointToSegment(e.ax, e.ay, o.ax, o.ay, o.bx, o.by);
            const d2 = distPointToSegment(e.bx, e.by, o.ax, o.ay, o.bx, o.by);
            const d3 = distPointToSegment(o.ax, o.ay, e.ax, e.ay, e.bx, e.by);
            const d4 = distPointToSegment(o.bx, o.by, e.ax, e.ay, e.bx, e.by);
            const sameStreet = !!e.streetName && e.streetName === o.streetName && Math.abs(o.i - e.i) >= SAME_STREET_MIN_INDEX_GAP;
            const threshold = sameStreet ? DUPLICATE_MATCH_METRES_SAME_STREET : DUPLICATE_MATCH_METRES;
            if (Math.max(d1, d2, d3, d4) < threshold) union(ei, ej);
          }
        }
      }
    }
    const groups = new Map<number, number[]>();
    edges.forEach((e, ei) => {
      const root = find(ei);
      const arr = groups.get(root);
      if (arr) arr.push(e.i); else groups.set(root, [e.i]);
    });
    const hits = new Set<number>();
    groups.forEach(idxs => {
      if (idxs.length > 2) {
        idxs.sort((a, b) => a - b).slice(2).forEach(i => hits.add(i));
      }
    });
    if (hits.size === 0) {
      setNoDuplicatesMessage(true);
      setTimeout(() => setNoDuplicatesMessage(false), 3000);
      return;
    }
    setStagedLineIdx(prev => {
      const next = new Set(prev);
      hits.forEach(i => next.add(i));
      stagedLineIdxRef.current = next;
      return next;
    });
  };
  // Also disables Lasso (freeform) automatically while in Deselect mode —
  // see the Select/Deselect toggle and fence-shape buttons below — the
  // Ctrl+drag box replaces it there per Craig's spec, since click-placing a
  // whole freeform outline is too slow just to strip out a few mis-picks.
  const [visibleRoads, setVisibleRoads] = React.useState<RoadFeature[]>([]);
  const [selectedRoadIds, setSelectedRoadIds] = React.useState<string[]>([]); // array (not Set) to keep it JSON-friendly for effect deps
  const selectedRoadIdsRef = useRef<string[]>([]);
  // v73.83 — Craig: "no undo last change button in lasso mode before add to
  // segment button pushed." Select Roads/Lasso had no way to step back a
  // single click, lasso confirm, box-select, or deselect-confirm before
  // committing via Add to Segment — only "Clear All", which wipes the whole
  // pending selection rather than just the last change. Snapshots of
  // {selectedRoadIds, stagedForRemovalIds} are pushed via pushSelectionUndo()
  // immediately before each of those mutations; the toolbar's "↩️ Undo" button
  // pops the last one back. Cleared on Add to Segment/Add as Transit commit,
  // Clear All, and mode/segment switches — same lifecycle as the selection
  // itself, so a stale snapshot from a previous segment can never be popped.
  const [selectionUndoStack, setSelectionUndoStack] = React.useState<Array<{ ids: string[]; staged: string[] }>>([]);
  const selectionUndoStackRef = useRef<Array<{ ids: string[]; staged: string[] }>>([]);
  const pushSelectionUndo = () => {
    const snap = { ids: [...selectedRoadIdsRef.current], staged: [...stagedForRemovalIdsRef.current] };
    const next = [...selectionUndoStackRef.current, snap].slice(-20); // cap history
    selectionUndoStackRef.current = next;
    setSelectionUndoStack(next);
  };
  const undoLastSelectionChange = () => {
    const stack = selectionUndoStackRef.current;
    if (stack.length === 0) return;
    const prevSnap = stack[stack.length - 1];
    const nextStack = stack.slice(0, -1);
    selectionUndoStackRef.current = nextStack;
    setSelectionUndoStack(nextStack);
    // Rebuild selectedFeaturesRef from visibleRoads/its own cache so the
    // restored ids still have their feature geometry available.
    const idSet = new Set(prevSnap.ids);
    selectedFeaturesRef.current.forEach((_f, id) => { if (!idSet.has(id)) selectedFeaturesRef.current.delete(id); });
    visibleRoadsRef.current.forEach(f => { if (idSet.has(f.id) && !selectedFeaturesRef.current.has(f.id)) selectedFeaturesRef.current.set(f.id, f); });
    setSelectedRoadIds(prevSnap.ids);
    selectedRoadIdsRef.current = prevSnap.ids;
    const stagedSet = new Set(prevSnap.staged);
    setStagedForRemovalIds(stagedSet);
    stagedForRemovalIdsRef.current = stagedSet;
  };
  const clearSelectionUndo = () => { selectionUndoStackRef.current = []; setSelectionUndoStack([]); };
  const [roadsLoading, setRoadsLoading] = React.useState(false);
  const [roadsError, setRoadsError] = React.useState('');
  const roadLayerRef = useRef<L.LayerGroup | null>(null);
  const lassoFenceLayerRef = useRef<L.LayerGroup | null>(null); // v73.14: the in-progress fence polygon + draggable/deletable vertex markers
  const [lassoVertices, setLassoVertices] = React.useState<RoadPoint[]>([]);
  const lassoVerticesRef = useRef<RoadPoint[]>([]);
  useEffect(() => { lassoVerticesRef.current = lassoVertices; }, [lassoVertices]);
  // v73.15 — Craig: hand-drawn segments (Draw Points) conventionally cover a
  // road by drawing it TWICE — out one side, back the other — so the km
  // total reflects sweeping both sides (see screenshot: the "Edit Road" blue
  // route makes an out-and-back loop, not a single line). Select Roads/Lasso
  // only ever produced ONE line (the OSM road centreline), which silently
  // undercounted by half against that same convention. Defaults ON so the
  // km total matches hand-drawn segments unless explicitly turned off for a
  // genuinely one-way/one-pass road.
  // v73.33: also now genuinely produces TWO laterally-separated lines (one
  // each side of centre, ±SWEEP_BOTH_SIDES_OFFSET_METRES) instead of the
  // same coordinates traversed forward then backward — see that constant's
  // comment above for why. The old manual Offset slider (v73.31/73.32) is
  // removed entirely; there's nothing left for it to control now that both-
  // sides offsetting is automatic and symmetric by construction.
  // v73.115 — Craig, direct: "the road is only swept once... it is only
  // meant to be swept once." Default flipped OFF. The toggle itself stays
  // (still user-controllable, for the genuine cases where a crew really
  // does drive both sides separately), but a fresh Select Roads session no
  // longer defaults to doubling every road into a there-and-back pair —
  // that was the second, confirmed-real cause of the "double lines/extra
  // points at every corner" reports (alongside the offsetPerpendicular
  // apex fix in v73.114), not a display artifact.
  const [sweepBothSides, setSweepBothSides] = React.useState(false);
  // v73.75 — Craig: "need option to add transit roads well in select road
  // mode to help with routing." When ON, whatever gets merged in by the
  // next "✓ Add to Segment" is marked transit (transitAfter on every edge
  // of the new addition, sweepBothSides looping skipped for it since a
  // transit pass is drive-through, not swept-both-sides) instead of a
  // normal sweep pass — lets a crew select a connector road straight from
  // the map (already real OSM geometry, so it's guaranteed to actually
  // route) instead of adding it as a normal pass and converting it via the
  // separate Transit toggle afterward, which is the extra-steps workflow
  // this is meant to replace. Resets to off after each Add to Segment so it
  // has to be deliberately re-enabled for the next addition, rather than
  // silently staying on and marking a real sweep road as transit by
  // mistake.
  const [addAsTransit, setAddAsTransit] = React.useState(false);
  const addAsTransitRef = useRef(false);
  useEffect(() => { addAsTransitRef.current = addAsTransit; }, [addAsTransit]);
  // v73.94 — Craig: the whole-selection "Add as Transit" toggle above only
  // ever marks an ENTIRE fresh addition transit or not — no way to mix
  // sweep roads and transit roads in one Lasso selection before committing.
  // "Mark Transit Roads" is a separate click-mode (like Select/Deselect):
  // while on, clicking an already-selected road toggles its membership in
  // transitRoadIds instead of adding/removing it from the selection.
  // addSelectedRoadsToSegment then splits the selection into a transit
  // batch and a normal batch and runs each through the exact same
  // pipeline (gap-fill, OSRM-first snap, simplify, A/B confirm, offset)
  // as two sequential merges instead of one, rather than re-tagging
  // individual points through that already-fragile chain (see v73.68/
  // v73.82's history of exactly that going wrong three times).
  const [transitRoadIds, setTransitRoadIds] = React.useState<Set<string>>(new Set());
  const transitRoadIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => { transitRoadIdsRef.current = transitRoadIds; }, [transitRoadIds]);
  const [markTransitMode, setMarkTransitMode] = React.useState(false);
  const markTransitModeRef = useRef(false);
  useEffect(() => { markTransitModeRef.current = markTransitMode; }, [markTransitMode]);
  // v73.34 — true while addSelectedRoadsToSegment is awaiting
  // /api/roads/connect for one or more gaps between selected pieces that
  // don't touch. Disables/relabels the Add to Segment button so it's clear
  // something's happening during what could be a few real network round
  // trips, not a frozen UI.
  const [routingGaps, setRoutingGaps] = React.useState(false);
  // v73.46 — Craig: "need a pop up to say set where you want the A start
  // point and the B end point to be after clicking the add segment
  // button." Holds the freshly-built (gap-filled + simplified) chain while
  // the confirm popup below is open, plus the resolver for the Promise
  // addSelectedRoadsToSegment awaits — the modal calls this with `true` to
  // reverse the chain before merging, `false` to keep it as calculated, or
  // `null` to cancel the whole Add to Segment action.
  const [pendingAddSegment, setPendingAddSegment] = React.useState<{ chain: RoadPoint[]; resolve: (reverse: boolean | null) => void } | null>(null);
  // v73.20 — Craig: "sometimes we would do carparks or driveways and service
  // lanes or business driveway/service lanes" — these are excluded by
  // default (v73.15/73.16) since normally they aren't roads a sweeper
  // drives, but that's sometimes wrong for his crews. Off by default,
  // matching the server's own default; turning it on re-fetches the current
  // view including the 'service'-tagged roads the server would otherwise
  // filter out.
  const [includeServiceLanes, setIncludeServiceLanes] = React.useState(false);
  const includeServiceLanesRef = useRef(false);
  useEffect(() => { includeServiceLanesRef.current = includeServiceLanes; }, [includeServiceLanes]);
  // v73.43 — Craig: "need also a check box like parks/driveway for Lane's
  // so they are not included." Same off-by-default/toggle-to-include
  // pattern as includeServiceLanes above, just for the separate 'lane'
  // category (roads named "... Lane" — see classifyRoadFeature server-side).
  const [includeLanes, setIncludeLanes] = React.useState(false);
  const includeLanesRef = useRef(false);
  useEffect(() => { includeLanesRef.current = includeLanes; }, [includeLanes]);
  // v73.53 — Craig: "add include check boxes like include carparks/driveways
  // and include lanes for the following that openstreet calls them. Service
  // road, Parking Aisle, living street." Same off-by-default/toggle pattern,
  // three more independent categories (see classifyRoadFeature server-side).
  const [includeParkingAisles, setIncludeParkingAisles] = React.useState(false);
  const includeParkingAislesRef = useRef(false);
  useEffect(() => { includeParkingAislesRef.current = includeParkingAisles; }, [includeParkingAisles]);
  const [includeServiceRoads, setIncludeServiceRoads] = React.useState(false);
  const includeServiceRoadsRef = useRef(false);
  useEffect(() => { includeServiceRoadsRef.current = includeServiceRoads; }, [includeServiceRoads]);
  const [includeLivingStreets, setIncludeLivingStreets] = React.useState(false);
  const includeLivingStreetsRef = useRef(false);
  useEffect(() => { includeLivingStreetsRef.current = includeLivingStreets; }, [includeLivingStreets]);

  // v73.81 — Craig: "service road added when the option was off." OSRM-backed
  // /api/roads/connect and /api/roads/match need to know the SAME Include
  // checkboxes fetchRoadsInView already sends, so the server can reject an
  // OSRM route/match that runs through a class the caller didn't ask to
  // include. Query-string form (for the GET /connect call) and POST-body
  // object form (for the JSON /match calls) both built from the same refs so
  // there's exactly one place these flags are read from.
  const buildIncludeParams = React.useCallback((): string => {
    const serviceLanesParam = includeServiceLanesRef.current ? '&includeServiceLanes=1' : '';
    const lanesParam = includeLanesRef.current ? '&includeLanes=1' : '';
    const parkingAislesParam = includeParkingAislesRef.current ? '&includeParkingAisles=1' : '';
    const serviceRoadsParam = includeServiceRoadsRef.current ? '&includeServiceRoads=1' : '';
    const livingStreetsParam = includeLivingStreetsRef.current ? '&includeLivingStreets=1' : '';
    return `${serviceLanesParam}${lanesParam}${parkingAislesParam}${serviceRoadsParam}${livingStreetsParam}`;
  }, []);
  const buildIncludeFlagsBody = React.useCallback(() => ({
    includeServiceLanes: includeServiceLanesRef.current,
    includeLanes: includeLanesRef.current,
    includeParkingAisles: includeParkingAislesRef.current,
    includeServiceRoads: includeServiceRoadsRef.current,
    includeLivingStreets: includeLivingStreetsRef.current,
  }), []);
  const roadFetchAbortRef = useRef<AbortController | null>(null);
  const visibleRoadsRef = useRef<RoadFeature[]>([]);
  useEffect(() => { visibleRoadsRef.current = visibleRoads; }, [visibleRoads]);
  // v73.18: persistent id→feature cache, separate from visibleRoads. Fixes a
  // real data-loss bug: visibleRoads is viewport-scoped and gets fully
  // REPLACED on every pan/zoom (see fetchRoadsInView's setVisibleRoads(feats)
  // below), but selectedRoadIds persists across pans. Selecting roads spread
  // across a wide area — panning between picks, exactly how Lasso/Select is
  // meant to be used — meant that by the time "Add to Segment" looked the
  // ids up against the CURRENT viewport's visibleRoads, most or all of the
  // earlier selections' actual geometry was gone, silently producing 0
  // points despite N roads still showing as "selected". Every place a road
  // is added to selectedRoadIds now also stashes its full feature here, and
  // addSelectedRoadsToSegment reads from this cache instead of visibleRoads.
  const selectedFeaturesRef = useRef<Map<string, RoadFeature>>(new Map());
  const fetchRoadsRef = useRef<() => void>(() => {});

  // v73.84 — Craig: "i want to be able to save well working in ether
  // confirm fence & before pushing add to segment button... in case i have
  // to leave or other thing happen." Previously an in-progress Select
  // Roads/Lasso selection lived only in React state — closing the Edit Road
  // modal, reloading the page, or the app being killed in the background
  // (common on a field Android device) lost it completely, with no warning
  // beyond the existing "you have an unconfirmed selection" close-confirm.
  // Auto-saves the pending selection (ids + full feature geometry so it
  // survives before visibleRoads has reloaded, staged-for-removal ids,
  // Add as Transit toggle, and an in-progress lasso fence) to localStorage,
  // debounced, and restores it once on mount for this road+segment. Cleared
  // on a successful commit or Clear All so a stale draft can never resurface.
  // v73.88 — Craig: "app lagging and freezing in the new road window,
  // can't test anything." Traced it to this draft-save feature itself
  // (added v73.84): the single write effect below rebuilt and
  // JSON.stringified FULL road geometry (every coordinate of every
  // selected road — potentially thousands of points, exactly the scale
  // Craig's own test selections reach) on every dependency change,
  // including `lassoVertices` — which changes on every single click while
  // drawing a fence, long before the fence is even confirmed and the
  // actual selection changes at all. Drawing a 30-40-point fence meant
  // 30-40 synchronous full-geometry localStorage writes, each blocking
  // the main thread, each one almost entirely redundant work (the
  // selection itself hadn't changed between most of those writes — only
  // the in-progress fence shape had). Split into two independently-
  // debounced storage keys so the expensive part (selection + full
  // geometry) only re-serializes when the SELECTION actually changes, and
  // the cheap, fast-changing part (the fence currently being drawn) never
  // touches the expensive one:
  //  - `:selection` — ids, features, staged removals, Add as Transit.
  //    Changes only on an actual selection mutation (click, box, confirmed
  //    fence, deselect) — rare relative to fence-drawing.
  //  - `:fence` — lassoVertices, lassoMode, fenceShape, manual A/B points.
  //    Changes on every fence-drawing click, but this payload is just
  //    click coordinates, nowhere near the size of full road geometry.
  const draftSelectionKey = `rsw-select-draft:${draftKey}:${activeSegIdx}:selection`;
  const draftFenceKey = `rsw-select-draft:${draftKey}:${activeSegIdx}:fence`;
  const draftRestoredRef = useRef(false);
  const [draftSavedAt, setDraftSavedAt] = React.useState<number | null>(null);
  useEffect(() => {
    draftRestoredRef.current = false;
    setDraftSavedAt(null);
    try {
      const rawSelection = localStorage.getItem(draftSelectionKey);
      const rawFence = localStorage.getItem(draftFenceKey);
      let restoredAny = false;
      let savedAt: number | null = null;
      if (rawSelection) {
        const draft = JSON.parse(rawSelection) as {
          ids: string[]; features: RoadFeature[]; staged: string[]; transitIds?: string[]; addAsTransit: boolean; savedAt: number;
        };
        if (draft.ids?.length) {
          draft.features.forEach(f => selectedFeaturesRef.current.set(f.id, f));
          setSelectedRoadIds(draft.ids || []);
          selectedRoadIdsRef.current = draft.ids || [];
          setStagedForRemovalIds(new Set(draft.staged || []));
          stagedForRemovalIdsRef.current = new Set(draft.staged || []);
          setAddAsTransit(!!draft.addAsTransit);
          // v73.97 — Craig: "should preserve exact editing state when
          // exiting." Confirmed gap (flagged in this build's own v73.94
          // changelog note): individually-marked transit roads were never
          // part of the saved draft at all — only the selection itself and
          // the whole-selection toggle were. Marking specific roads via
          // "Mark Transit Roads", saving a draft, then reopening lost which
          // roads had been marked, even though the roads stayed selected.
          setTransitRoadIds(new Set(draft.transitIds || []));
          restoredAny = true;
          savedAt = draft.savedAt || null;
        }
      }
      if (rawFence) {
        const draft = JSON.parse(rawFence) as {
          lassoVertices: RoadPoint[]; lassoMode: 'select' | 'deselect'; fenceShape: 'lasso' | 'box';
          manualStartPoint: RoadPoint | null; manualEndPoint: RoadPoint | null; savedAt: number;
        };
        if (draft.lassoVertices?.length) {
          setLassoVertices(draft.lassoVertices || []);
          lassoVerticesRef.current = draft.lassoVertices || [];
          setLassoMode(draft.lassoMode || 'select');
          setFenceShape(draft.fenceShape || 'lasso');
          setManualStartPoint(draft.manualStartPoint || null);
          setManualEndPoint(draft.manualEndPoint || null);
          restoredAny = true;
          savedAt = Math.max(savedAt || 0, draft.savedAt || 0) || savedAt;
        }
      }
      if (restoredAny) {
        setEditorMode('select');
        setDraftSavedAt(savedAt);
      }
    } catch { /* corrupt/old-format draft — ignore, start clean */ }
    draftRestoredRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftSelectionKey, draftFenceKey]);
  // v73.90 — Craig: "the save draft is not working, i don't mind just a
  // click a save draft button rather than having auto save." Replaced the
  // two debounced auto-save effects with one explicit save, fired only by
  // the toolbar's "💾 Save Draft" button — no more silent background writes
  // to reason about (or fail to reason about) if something doesn't save
  // when expected; pressing the button either works or the alert says why.
  const saveSelectionDraft = () => {
    const hasContent = selectedRoadIds.length > 0 || stagedForRemovalIds.size > 0 || lassoVertices.length > 0;
    if (!hasContent) return;
    try {
      const savedAt = Date.now();
      const features = selectedRoadIds.map(id => selectedFeaturesRef.current.get(id)).filter(Boolean) as RoadFeature[];
      if (selectedRoadIds.length > 0 || stagedForRemovalIds.size > 0) {
        localStorage.setItem(draftSelectionKey, JSON.stringify({
          ids: selectedRoadIds, features, staged: Array.from(stagedForRemovalIds), transitIds: Array.from(transitRoadIds), addAsTransit, savedAt,
        }));
      }
      if (lassoVertices.length > 0) {
        localStorage.setItem(draftFenceKey, JSON.stringify({
          lassoVertices, lassoMode, fenceShape, manualStartPoint, manualEndPoint, savedAt,
        }));
      }
      setDraftSavedAt(savedAt);
    } catch (e: any) {
      window.alert(`Couldn't save draft: ${e?.message || 'localStorage unavailable or full'}`);
    }
  };
  const clearSelectionDraft = () => {
    try { localStorage.removeItem(draftSelectionKey); localStorage.removeItem(draftFenceKey); } catch { /* ignore */ }
    setDraftSavedAt(null);
  };

  const syncServerUrlRef = useRef(syncServerUrl);
  const syncTokenRef = useRef(syncToken);
  useEffect(() => { syncServerUrlRef.current = syncServerUrl; }, [syncServerUrl]);
  useEffect(() => { syncTokenRef.current = syncToken; }, [syncToken]);
  useEffect(() => { editorModeRef.current = editorMode; }, [editorMode]);
  useEffect(() => { lassoActiveRef.current = lassoActive; }, [lassoActive]);
  useEffect(() => { selectedRoadIdsRef.current = selectedRoadIds; }, [selectedRoadIds]);

  const liveSegsRef = useRef<RoadPoint[][]>(segments);
  const activeIdxRef = useRef<number>(activeSegIdx);
  const onChangeRef = useRef(onSegmentsChange);
  const colorRef = useRef(color);
  const segmentColorsRef = useRef<string[]>(segmentColors);
  const showNumbersRef = useRef(showNumbers);
  const showMarkersRef = useRef(showMarkers);
  const rebuildAllRef = useRef<() => void>(() => {});
  // v73.54 — see MultiSegmentRoadMapProps.centerHint/autoSearchQuery above.
  const centerHintRef = useRef(centerHint);
  const autoSearchQueryRef = useRef(autoSearchQuery);
  useEffect(() => { centerHintRef.current = centerHint; }, [centerHint]);
  useEffect(() => { autoSearchQueryRef.current = autoSearchQuery; }, [autoSearchQuery]);

  useEffect(() => { liveSegsRef.current = segments; }, [segments]);
  useEffect(() => { activeIdxRef.current = activeSegIdx; }, [activeSegIdx]);
  useEffect(() => { onChangeRef.current = onSegmentsChange; }, [onSegmentsChange]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { segmentColorsRef.current = segmentColors; }, [segmentColors]);
  useEffect(() => { transitModeRef.current = transitMode; }, [transitMode]);
  useEffect(() => { turnaroundModeRef.current = turnaroundMode; }, [turnaroundMode]);
  // v73.110 — dirty-flag tracking (see strictSelectedRoadsOnly/dirtySegs
  // declaration above for the full reasoning). Skips its own first run —
  // otherwise restoring a saved draft (manualStartPoint/turnarounds getting
  // populated from storage on mount) would immediately flag every segment
  // dirty before the user has touched anything.
  useEffect(() => {
    if (!dirtyTrackingMountedRef.current) { dirtyTrackingMountedRef.current = true; return; }
    const idx = activeIdxRef.current;
    if ((liveSegsRef.current[idx]?.length ?? 0) > 0) {
      setDirtySegs(prev => prev.has(idx) ? prev : new Set(prev).add(idx));
    }
  }, [manualStartPoint, manualEndPoint, turnarounds, selectedRoadIds]);
  useEffect(() => { turnaroundsRef.current = turnarounds; rebuildAllRef.current?.(); }, [turnarounds]);
  useEffect(() => { onTurnaroundsChangeRef.current = onTurnaroundsChange; }, [onTurnaroundsChange]);
  // Update map cursor when transit mode / editor mode changes — gives visual feedback on the map itself
  useEffect(() => {
    if (mapRef.current) {
      mapRef.current.getContainer().style.cursor =
        editorMode === 'select' ? (lassoActive ? 'crosshair' : 'pointer')
        : (transitMode ? 'cell' : 'crosshair');
    }
  }, [transitMode, editorMode, lassoActive]);
  useEffect(() => { showNumbersRef.current = showNumbers; }, [showNumbers]);
  useEffect(() => { showMarkersRef.current = showMarkers; }, [showMarkers]);

  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) { try { mapRef.current.remove(); } catch { /**/ } mapRef.current = null; }

    const allPts = (liveSegsRef.current || []).flat();
    const defaultCenter: [number, number] = allPts.length > 0
      ? [allPts[0].lat, allPts[0].lng]
      : centerHintRef.current
      ? [centerHintRef.current.lat, centerHintRef.current.lng]
      : [-36.8485, 174.7633];

    // v73.41 — HOTFIX for a regression from v73.38's `preferCanvas: true`.
    // Canvas-rendered vector layers in Leaflet hit-test clicks with a small
    // fixed tolerance around the actual stroke, much less forgiving than
    // SVG's rendering (which had a larger effective click area). That made
    // clicking a thin road/edge line — already fiddly on a busy multi-point
    // route — noticeably harder, and a missed click falls straight through
    // to the map's own "add a new point here" handler instead (Craig: "the
    // B comes to that location" — B being wherever the missed click landed).
    // `L.canvas({ tolerance: 8 })` keeps the exact same Canvas rendering
    // performance win (still one canvas element instead of one SVG node per
    // shape) while giving every vector layer an explicit 8px click-tolerance
    // buffer — the correct fix, not reverting to SVG (loses the performance
    // win) and not adding fat invisible hit-lines on top (the mistake that
    // caused the v73.23/73.24 "click swallows add-point" regression before).
    const map = L.map(containerRef.current, {zoomSnap: 0.25, zoomDelta: 0.25, wheelPxPerZoomLevel: 120,  attributionControl: false, renderer: L.canvas({ tolerance: 8 }) }).setView(defaultCenter, 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19 }).addTo(map);
    mapRef.current = map;
    map.getContainer().style.cursor = 'crosshair';
    setTimeout(() => { try { map.invalidateSize({ animate: false }); } catch { /**/ } }, 50);
    setTimeout(() => { try { map.invalidateSize({ animate: false }); } catch { /**/ } }, 250);

    // v73.54 — no points to center on yet (a genuinely new road) and no
    // centerHint available from an existing road in the same Area — geocode
    // the Area's own name once so the map opens somewhere sensible instead
    // of defaulting to Auckland. Same fire-and-forget/fail-open pattern as
    // ZoneEditorMap's v73.46 equivalent: a failed/empty geocode just leaves
    // the map at the Auckland fallback already set above.
    if (allPts.length === 0 && !centerHintRef.current && autoSearchQueryRef.current.trim()) {
      (async () => {
        try {
          const resp = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(autoSearchQueryRef.current.trim())}`,
            { headers: { 'Accept-Language': 'en' } }
          );
          const results = await resp.json();
          if (results.length > 0 && mapRef.current) {
            const { lat, lon } = results[0];
            mapRef.current.setView([parseFloat(lat), parseFloat(lon)], 14, { animate: false });
          }
        } catch { /* fails open — stays at the Auckland fallback */ }
      })();
    }

    // v73.12: layer group holding the selectable road-network overlay (Select Roads mode)
    const roadLayer = L.layerGroup().addTo(map);
    roadLayerRef.current = roadLayer;
    // v73.14: separate layer for the in-progress lasso fence (polygon +
    // vertex markers) — kept apart from roadLayer so redrawing one never
    // touches the other.
    const lassoFenceLayer = L.layerGroup().addTo(map);
    lassoFenceLayerRef.current = lassoFenceLayer;

    const rebuildAll = () => {
      const segs = liveSegsRef.current || [];
      const activeIdx = activeIdxRef.current;
      const col = colorRef.current;
      const sn = showNumbersRef.current;

      // Clean up any live drag preview before rebuilding proper polylines
      if (dragPreviewRef.current) { dragPreviewRef.current.remove(); dragPreviewRef.current = null; }

      // Clear everything
      polylinesRef.current.forEach(p => p.remove()); polylinesRef.current = [];
      markersRef.current.forEach(ms => ms.forEach(m => m.remove())); markersRef.current = [];
      midMkRef.current.forEach(m => m.remove()); midMkRef.current = [];
      turnaroundMarkersRef.current.forEach(m => m.remove()); turnaroundMarkersRef.current = [];
      // Always reset cursor when rebuilding — restores transit/select mode cursor if active, otherwise crosshair
      map.getContainer().style.cursor =
        editorModeRef.current === 'select' ? (lassoActiveRef.current ? 'crosshair' : 'pointer')
        : (transitModeRef.current ? 'cell' : 'crosshair');

      segs.forEach((pts, segIdx) => {
        const isActive = segIdx === activeIdx;
        const perColor = segmentColorsRef.current[segIdx];
        const segColor = perColor || col;
        const segMarkers: (L.Marker | L.CircleMarker)[] = [];

        // ── Per-edge polylines ──
        // An edge from pts[i] → pts[i+1] is transit when pts[i].transitAfter === true.
        // v73.23: the ACTIVE segment renders ONE POLYLINE PER EDGE (not
        // batched) so each edge can be individually clicked to stage it for
        // bulk delete/transit-convert (developer-prompt Fix 1/2) — only the
        // active segment needs this, since only it is ever editable, so the
        // extra polyline-object count only applies where it's actually
        // needed. Inactive segments keep the original run-batching (still
        // just background reference lines, never interactive) for render
        // efficiency on jobs with many segments.
        //
        // v73.42 — HOTFIX. Craig: "the app is badly lagging trying to enter
        // edit roads so much so i can't test it." This is why: a real-road-
        // routed or Select-Roads-built segment can easily have 1000+ points,
        // meaning 1000+ SEPARATE interactive Canvas shapes just for this one
        // segment's lines (before even counting markers/insert-handles).
        // Every one of those is `interactive` (it has a click handler),
        // which means Leaflet's Canvas renderer has to hit-test the cursor
        // against ALL of them on every single mousemove to know what to
        // hover/highlight — not just on click. That's fine for tens of
        // edges, genuinely unusable for over a thousand, especially on
        // weaker hardware. Above LARGE_SEGMENT_EDGE_THRESHOLD edges, fall
        // back to the SAME run-batching inactive segments already use
        // (grouping consecutive same-state edges into one polyline) —
        // cutting the object count from one-per-edge to one-per-run, which
        // for a typical route (long stretches of solid line, occasional
        // transit gaps) is a small fraction of the raw edge count. Clicking
        // a run in this mode stages every edge in that run at once, not
        // just one edge — a reasonable trade for a huge route where
        // wanting to review or convert one specific 2-metre edge in
        // isolation is not the realistic use case anyway.
        const LARGE_SEGMENT_EDGE_THRESHOLD = 300;
        const useGranularEdges = isActive && pts.length - 1 <= LARGE_SEGMENT_EDGE_THRESHOLD;

        // v73.71 — "transparent zone" road highlight, Craig's concept
        // screenshot (a soft translucent band following the road, covering
        // both sides, so the road name underneath stays legible) — a purely
        // visual backdrop layer, drawn once per segment (not per edge/run),
        // BEHIND the existing centreline + halo + edge lines below, and
        // non-interactive so it never steals clicks from staging/dragging.
        // Single non-interactive polyline per segment keeps this cheap even
        // on the largest routes — no new per-point/per-edge object count.
        if (pts.length > 1) {
          const zoneLatLngs = pts.map(p => [p.lat, p.lng] as [number, number]);
          const zone = L.polyline(zoneLatLngs, {
            color: segColor,
            weight: ROAD_ZONE_HIGHLIGHT_WEIGHT,
            opacity: ROAD_ZONE_HIGHLIGHT_OPACITY,
            lineCap: 'round',
            lineJoin: 'round',
            interactive: false,
          }).addTo(map);
          polylinesRef.current.push(zone);
        }

        if (pts.length > 1) {
          if (useGranularEdges) {
            for (let j = 0; j < pts.length - 1; j++) {
              const edgeIsTransit = pts[j].transitAfter === true;
              const isStagedLine = editorModeRef.current === 'draw' &&
                (stagedLineIdxRef.current.has(j) || (stagedPointIdxRef.current.has(j) && stagedPointIdxRef.current.has(j + 1)));
              const runLatLngs: [number, number][] = [[pts[j].lat, pts[j].lng], [pts[j + 1].lat, pts[j + 1].lng]];
              // v73.28 — Craig: couldn't tell which lines were staged,
              // especially when the road's own colour was also red/orange —
              // a same-hue highlight on a same-hue line is nearly invisible.
              // A white "halo" underneath the highlight, independent of
              // whatever colour the line itself is, fixes that regardless of
              // base colour — same fix applied to Select Roads' staged/
              // pending-delete highlighting below.
              if (isStagedLine) {
                const halo = L.polyline(runLatLngs, { color: '#ffffff', weight: 9, opacity: 0.9 }).addTo(map);
                polylinesRef.current.push(halo);
              }
              // v73.90 — Craig: "when I click on a solid road and change it
              // to transit it would change to a gray hard to see line, I
              // only want for it to be better seen." Committed Transit
              // edges were '#94a3b8' (a light slate gray) at low opacity —
              // easy to lose against the basemap, especially next to the
              // segment's own colour. Switched to the same amber
              // ('#f59e0b') already used for a transit point's marker ring
              // just below, at full opacity and a touch heavier — visually
              // consistent (marker ring and the line it belongs to now
              // match) and stands out against both the map and the
              // segment colour instead of blending in.
              const pl = L.polyline(runLatLngs, isStagedLine
                ? { color: '#dc2626', weight: 6, opacity: 0.95, dashArray: '3 4' }
                : edgeIsTransit
                ? { color: '#f59e0b', weight: 4, opacity: 0.95, dashArray: '8 7' }
                : { color: segColor, weight: 4, opacity: 0.9 }
              ).addTo(map);
              if (edgeIsTransit && !isStagedLine) pl.bindTooltip('🔀 Transit (invisible in saved route, not counted in km)', { direction: 'top', sticky: true });
              if (isStagedLine) pl.bindTooltip('Staged for removal — click to unstage', { direction: 'top', sticky: true });
              // Click-to-stage only applies in Draw Points mode — Select
              // Roads mode uses a completely separate overlay/layer for its
              // own road-click-to-toggle, this handler must never fire there.
              pl.on('click', (e: L.LeafletMouseEvent) => {
                if (editorModeRef.current !== 'draw') return;
                L.DomEvent.stopPropagation(e);
                setStagedLineIdx(prev => {
                  const next = new Set(prev);
                  if (next.has(j)) next.delete(j); else next.add(j);
                  stagedLineIdxRef.current = next;
                  return next;
                });
              });
              // v73.99 — Bug #7/#8 fix. Craig: "Cannot Click the Line to
              // Change Road Type... have to hunt for a point"; "Right-click
              // on a line should do the same [Transit<->Solid toggle] as
              // points." Left-click above already selects/stages the LINE
              // itself (not a vertex) for bulk convert via the toolbar's
              // Set to Transit/Set to Solid buttons — this adds the other
              // half: right-click the line for an immediate one-click
              // toggle, mirroring the point marker's own contextmenu
              // handler above exactly (same edge index `j`, same
              // clearBulkUndo/rebuildAll pattern), instead of having to
              // find and right-click a specific vertex just to flip one run.
              pl.on('contextmenu', (e: L.LeafletMouseEvent) => {
                if (editorModeRef.current !== 'draw') return;
                L.DomEvent.stopPropagation(e);
                L.DomEvent.preventDefault(e.originalEvent);
                const curSegIdx = segIdx, curJ = j;
                const curTransit = liveSegsRef.current[curSegIdx]?.[curJ]?.transitAfter === true;
                clearBulkUndoRef.current();
                const updated = liveSegsRef.current.map((s, si) =>
                  si !== curSegIdx ? s : s.map((pt, pi) => pi === curJ ? { ...pt, transitAfter: !curTransit } : pt)
                );
                liveSegsRef.current = updated;
                onChangeRef.current(updated);
                rebuildAll();
              });
              polylinesRef.current.push(pl);
            }
          } else {
            // v73.42 — this branch now covers TWO cases that need different
            // styling/interactivity: a genuinely inactive segment (always
            // was here, decorative only, unchanged) and a LARGE active
            // segment that's over the granular-edge threshold (new) — still
            // needs the active segment's styling and click-to-stage, just
            // batched by run instead of per-edge. `runStartIdx` tracks each
            // run's first edge index so a click can stage every edge in it.
            let i = 0;
            while (i < pts.length - 1) {
              const edgeIsTransit = pts[i].transitAfter === true;
              const runStartIdx = i;
              const runLatLngs: [number, number][] = [[pts[i].lat, pts[i].lng]];
              while (i < pts.length - 1 && (pts[i].transitAfter === true) === edgeIsTransit) {
                runLatLngs.push([pts[i + 1].lat, pts[i + 1].lng]);
                i++;
              }
              const runEndIdx = i; // exclusive — edges [runStartIdx, runEndIdx) belong to this run
              if (!isActive) {
                const pl = L.polyline(runLatLngs, edgeIsTransit
                  ? { color: '#f59e0b', weight: 3, opacity: 0.95, dashArray: '8 7' }
                  : { color: segColor, weight: 2.5, opacity: 0.45, dashArray: '6 4' }
                ).addTo(map);
                if (edgeIsTransit) pl.bindTooltip('🔀 Transit (invisible in saved route, not counted in km)', { direction: 'top', sticky: true });
                polylinesRef.current.push(pl);
                continue;
              }
              // Large active segment: same visual language as the granular
              // path (staged = red dashed with white halo, transit = grey
              // dashed, solid = segment colour), just one shape per run.
              const isStagedRun = editorModeRef.current === 'draw' &&
                Array.from({ length: runEndIdx - runStartIdx }, (_, k) => runStartIdx + k)
                  .some(edgeIdx => stagedLineIdxRef.current.has(edgeIdx) || (stagedPointIdxRef.current.has(edgeIdx) && stagedPointIdxRef.current.has(edgeIdx + 1)));
              if (isStagedRun) {
                const halo = L.polyline(runLatLngs, { color: '#ffffff', weight: 9, opacity: 0.9 }).addTo(map);
                polylinesRef.current.push(halo);
              }
              const pl = L.polyline(runLatLngs, isStagedRun
                ? { color: '#dc2626', weight: 6, opacity: 0.95, dashArray: '3 4' }
                : edgeIsTransit
                ? { color: '#f59e0b', weight: 4, opacity: 0.95, dashArray: '8 7' }
                : { color: segColor, weight: 4, opacity: 0.9 }
              ).addTo(map);
              if (edgeIsTransit && !isStagedRun) pl.bindTooltip('🔀 Transit (invisible in saved route, not counted in km)', { direction: 'top', sticky: true });
              if (isStagedRun) pl.bindTooltip('Staged for removal — click to unstage this whole run', { direction: 'top', sticky: true });
              else pl.bindTooltip('Large segment — click stages this whole run (not just one edge) for performance', { direction: 'top', sticky: true });
              pl.on('click', (e: L.LeafletMouseEvent) => {
                if (editorModeRef.current !== 'draw') return;
                L.DomEvent.stopPropagation(e);
                setStagedLineIdx(prev => {
                  const next = new Set(prev);
                  const edgeIdxs = Array.from({ length: runEndIdx - runStartIdx }, (_, k) => runStartIdx + k);
                  const alreadyAllStaged = edgeIdxs.every(k => next.has(k));
                  edgeIdxs.forEach(k => alreadyAllStaged ? next.delete(k) : next.add(k));
                  stagedLineIdxRef.current = next;
                  return next;
                });
              });
              // v73.99 — Bug #7/#8 fix, same as the granular-edge branch
              // above: right-click a run toggles every edge in that whole
              // run Transit<->Solid immediately, one click, no vertex-
              // hunting. Uses the run's own current state (edgeIsTransit)
              // as the toggle source, same as the run's click-to-stage
              // logic above already treats it as one unit.
              pl.on('contextmenu', (e: L.LeafletMouseEvent) => {
                if (editorModeRef.current !== 'draw') return;
                L.DomEvent.stopPropagation(e);
                L.DomEvent.preventDefault(e.originalEvent);
                const curSegIdx = segIdx;
                const edgeIdxs = Array.from({ length: runEndIdx - runStartIdx }, (_, k) => runStartIdx + k);
                const targetTransit = !edgeIsTransit;
                clearBulkUndoRef.current();
                const updated = liveSegsRef.current.map((s, si) =>
                  si !== curSegIdx ? s : s.map((pt, pi) => edgeIdxs.includes(pi) ? { ...pt, transitAfter: targetTransit } : pt)
                );
                liveSegsRef.current = updated;
                onChangeRef.current(updated);
                rebuildAll();
              });
              polylinesRef.current.push(pl);
            }
          }
        }

        // ── Point markers ──
        // v73.38 — Craig: app "badly lagging" on old/weak hardware (Athlon
        // II X2, GT 610). Inactive segments' point markers were rendered in
        // full whenever "Show point markers" was on — but they're
        // `pointer-events:none` and wrapped in `if (isActive)` for every
        // handler (drag/click/right-click), meaning an inactive segment's
        // markers have never been anything but decorative dots — the
        // segment's shape is already fully conveyed by its polyline. For a
        // multi-segment road with 1000+ points spread across several
        // segments (not unusual after Select Roads / real-road routing),
        // that's a real number of HTML `divIcon` elements created purely
        // for decoration on every rebuild. Now: ONLY the active segment
        // ever gets point markers.
        //
        // v73.39 — HOTFIX for a regression this same change introduced.
        // Craig: "no longer able to adjust lines all Point control options
        // has disappeared... highlights is no longer working... hard to
        // select lines... the B comes to that location [instead]." Root
        // cause: the line below originally read `if (!showMk) return;`,
        // which gated the ACTIVE segment's marker creation behind the "Show
        // point markers" toggle. That's new, wrong behaviour — before
        // v73.38, `showMk` NEVER affected the active segment at all (the
        // old condition was `if (!showMk && !isActive) return;`, which is
        // only ever true when BOTH are false, i.e. never while isActive is
        // true). The active segment's markers aren't just a visual — they
        // ARE the drag handles, the click-to-stage targets, and the
        // right-click-to-delete targets, so silently skipping their
        // creation because a display toggle happened to be off removed
        // every point-editing capability at once, with no error and no
        // visual explanation — exactly what Craig described. Whenever a
        // click didn't land on a (nonexistent) marker or a staged line, it
        // fell straight through to the map's own "add a new point at the
        // end" handler instead — which is the "the B comes to that
        // location" symptom (B being the last-point marker, now wherever
        // was just clicked). Fixed: active segment markers no longer check
        // `showMk` at all, restoring the pre-v73.38 behaviour exactly.
        // v73.44 — HOTFIX, still on the mark v73.42 left. Craig confirmed
        // Edit Road/creating segments is still freezing after v73.42's
        // polyline run-batching. As flagged at the time, that fix only
        // addressed interactive polylines; every point still got its own
        // real HTML `divIcon` marker (drag/click/right-click handlers,
        // DOM-based regardless of Canvas vs SVG) unconditionally, for the
        // WHOLE active segment, on every rebuild — 2000+ of them for a
        // Select-Roads/real-road-routed segment, matching exactly the scale
        // Craig's own v73.42 screenshot showed. Above the same 300-point
        // threshold used for polyline batching, markers now only render
        // for points inside the current view (padded 20%) — off-screen
        // points can't be usefully dragged anyway, and rebuildAll() already
        // reruns on pan/zoom (added below) so panning to a point brings its
        // marker back. Segments under 300 points are completely unaffected
        // — every point still always gets a marker, identical to before.
        const cullOffscreenPoints = pts.length > LARGE_SEGMENT_EDGE_THRESHOLD;
        const viewBounds = cullOffscreenPoints ? map.getBounds().pad(0.2) : null;
        if (isActive) pts.forEach((p, i) => {
          const isFirst = i === 0, isLast = i === pts.length - 1;
          // Always keep A/B endpoints even off-screen — they're the segment's
          // start/end anchors and are referenced elsewhere (manual start point,
          // chaining), not just arbitrary interior points.
          if (viewBounds && !isFirst && !isLast && !viewBounds.contains([p.lat, p.lng])) return;
          // Tint the marker ring orange when the edge OUT of this point is transit
          const outTransit = !isLast && p.transitAfter === true;
          const isStagedPoint = isActive && editorModeRef.current === 'draw' && stagedPointIdxRef.current.has(i);
          const bg = isStagedPoint
            ? '#dc2626'
            : isActive
            ? (isFirst ? '#059669' : isLast ? '#DC2626' : (outTransit ? '#f59e0b' : col))
            : '#94a3b8';
          const lbl = isFirst ? 'A' : isLast ? 'B' : (sn ? String(i + 1) : '·');
          const size = isActive ? 22 : 16;

          // v73.70 — part D of the freeze fix. Craig's screenshots showed
          // the freeze happening on the INITIAL (fully zoomed-out, whole-
          // route) view straight after opening the editor — the v73.44/
          // v73.70-A viewport culling above doesn't help there, because
          // map.fitBounds() at mount means the whole route (all 1200-4200+
          // points) IS the viewport. Every interior point on a large active
          // segment was still a real DOM `divIcon` marker (drag handlers,
          // box-shadow, flex layout) — the actual freeze driver. For large
          // segments, interior points now render as canvas L.circleMarker
          // (via the leaflet-path-drag plugin for drag support, since
          // CircleMarker isn't natively draggable) instead — same colour/
          // staged/transit-tint logic, same drag/click/contextmenu/rotate-
          // to-A-or-B menu below (all Leaflet Layer APIs both marker types
          // share), just canvas-drawn instead of one DOM element each. The
          // number label is dropped in this mode (shown as a hover tooltip
          // instead of permanent text — canvas has no text-in-icon
          // equivalent) — an acceptable trade only on segments dense enough
          // that individual point numbers aren't readably legible anyway.
          // A and B endpoints always stay real divIcon markers (just one
          // each, negligible cost, and the "A"/"B" label matters for
          // orientation) regardless of segment size.
          const useCanvasPoint = pts.length > LARGE_SEGMENT_EDGE_THRESHOLD && !isFirst && !isLast;
          // v73.78 — Craig: "when you click and try to drag the map around
          // ... right after clicking it it's not letting go." Root cause:
          // OSRM's real road geometry (Snap to Roads) is much denser than
          // hand-clicked points — a vertex at nearly every curve/
          // intersection — so on a large segment (the only case that hits
          // useCanvasPoint at all) these markers end up packed edge-to-edge
          // with almost no empty map space between them to grab for a pan.
          // A click that lands "on the route" is very likely landing ON a
          // marker instead, which leaflet-path-drag then drags instead of
          // panning the map underneath — reads exactly like panning being
          // stuck, even though it's actually just grabbing the wrong thing.
          // Canvas circleMarker's radius IS its click hit-area (no separate
          // CSS hit-box like a DOM divIcon can have), so shrinking it here
          // shrinks both the dot and the target together — smaller/fiddlier
          // to click a specific point right after a snap, but leaves real
          // gaps to grab the map from. Only affects the dense (>300-point)
          // canvas-marker path; ordinary segments' normal-sized divIcon
          // points are completely unaffected.
          const canvasPointRadius = isActive ? 5 : 4;
          let marker: L.Marker | L.CircleMarker;
          if (useCanvasPoint) {
            marker = L.circleMarker([p.lat, p.lng], {
              radius: canvasPointRadius,
              color: isStagedPoint ? 'white' : (outTransit && isActive ? '#f59e0b' : 'white'),
              weight: 2,
              fillColor: bg,
              fillOpacity: 1,
              // draggable isn't in Leaflet's core CircleMarkerOptions type —
              // it's read by leaflet-path-drag's L.Path.addInitHook, hence the cast.
              ...( { draggable: isActive } as object ),
            } as L.CircleMarkerOptions).addTo(map);
            if (sn) marker.bindTooltip(String(i + 1), { direction: 'top', offset: [0, -(canvasPointRadius + 4)] });
          } else {
            const icon = L.divIcon({
              className: '',
              html: `<div style="
                width:${size}px;height:${size}px;border-radius:50%;
                background:${bg};border:2px solid ${isStagedPoint ? 'white' : (outTransit && isActive ? '#f59e0b' : 'white')};
                box-shadow:0 2px 6px rgba(0,0,0,0.3);
                display:flex;align-items:center;justify-content:center;
                font-size:${size <= 16 ? '7' : '9'}px;font-weight:800;color:white;
                cursor:${isActive ? 'move' : 'default'};
                user-select:none;pointer-events:${isActive ? 'all' : 'none'};
              ">${lbl}</div>`,
              iconSize: [size, size],
              iconAnchor: [size / 2, size / 2],
            });

            marker = L.marker([p.lat, p.lng], {
              icon,
              draggable: isActive,
              autoPan: false,
              zIndexOffset: isActive ? 1000 : 500,
            }).addTo(map);
          }
          if (isStagedPoint) marker.bindTooltip('Staged for removal — click to unstage', { direction: 'top' });

          if (isActive) {
            marker.on('drag', () => {
              const ll = marker.getLatLng();
              const updated = liveSegsRef.current.map((s, si) =>
                si !== segIdx ? s : s.map((pt, pi) => pi === i ? { ...pt, lat: ll.lat, lng: ll.lng } : pt)
              );
              liveSegsRef.current = updated;
              // Use a simple preview polyline during drag — do NOT call rebuildAll() here.
              // Calling rebuildAll() destroys the currently-dragged marker mid-drag which
              // breaks Leaflet's internal drag tracking: dragend never fires, leaving the
              // cursor permanently stuck on the grab/move icon instead of the crosshair +.
              const segPts = updated[segIdx].map(p => [p.lat, p.lng] as [number, number]);
              if (dragPreviewRef.current) {
                dragPreviewRef.current.setLatLngs(segPts);
              } else {
                dragPreviewRef.current = L.polyline(segPts, {
                  color: colorRef.current, weight: 4, opacity: 0.75,
                }).addTo(map);
              }
              map.getContainer().style.cursor = 'grabbing';
            });
            marker.on('dragend', () => {
              // Preview removed + cursor reset inside rebuildAll()
              clearBulkUndoRef.current();
              onChangeRef.current(liveSegsRef.current);
              rebuildAll(); // also resets cursor and removes dragPreview
            });

            // v73.23 — developer-prompt Fix 1: single-click now STAGES the
            // point (toggle red highlight) instead of opening a popup with
            // Delete/Transit buttons — too slow for bulk cleanup of 50-100+
            // stray points, which was the actual complaint. Right-click
            // (contextmenu, below) still deletes this one point instantly,
            // unchanged, for the common single-point case. A single point's
            // Transit toggle is now: stage it, then press the Transit
            // button (Fix 4) — one extra step for the one-point case, but
            // the same tool that does bulk conversion, not a separate path
            // to maintain.
            marker.on('click', (e: L.LeafletMouseEvent) => {
              if (editorModeRef.current !== 'draw') return;
              L.DomEvent.stopPropagation(e);
              setStagedPointIdx(prev => {
                const next = new Set(prev);
                if (next.has(i)) next.delete(i); else next.add(i);
                stagedPointIdxRef.current = next;
                return next;
              });
            });

            // v73.25 — Bug #3/#4 fix: right-click used to delete the point
            // INSTANTLY with no confirmation and no way to also toggle its
            // transit state from a single interaction. Now opens a small
            // popup menu instead — "Toggle Transit Line" (flips the
            // transitAfter flag of the edge OUT of this point) and "Delete
            // This Point" (still requires an explicit confirm click before
            // anything is actually removed — an accidental right-click no
            // longer costs a point).
            marker.on('contextmenu', (e) => {
              L.DomEvent.stopPropagation(e);
              const curSegIdx = segIdx, curI = i;
              const isLastPt = curI === (liveSegsRef.current[curSegIdx]?.length ?? 0) - 1;
              const menuEl = document.createElement('div');
              menuEl.style.cssText = 'padding:2px 4px;text-align:center;min-width:170px;';
              const titleEl = document.createElement('p');
              titleEl.style.cssText = 'font-size:11px;font-weight:600;color:#374151;margin:0 0 6px;';
              titleEl.textContent = `Point ${curI + 1}`;
              menuEl.appendChild(titleEl);

              if (!isLastPt) {
                const curTransit = liveSegsRef.current[curSegIdx]?.[curI]?.transitAfter === true;
                const transitBtn = document.createElement('button');
                transitBtn.textContent = curTransit ? '🔀 Toggle Transit → Solid' : '🔀 Toggle Transit Line';
                transitBtn.style.cssText = 'background:#fffbeb;color:#b45309;border:1px solid #fde68a;border-radius:6px;padding:5px 12px;font-size:11px;font-weight:600;cursor:pointer;display:block;width:100%;margin-bottom:4px;';
                transitBtn.addEventListener('click', (ev) => {
                  ev.stopPropagation();
                  clearBulkUndoRef.current();
                  const updated = liveSegsRef.current.map((s, si) =>
                    si !== curSegIdx ? s : s.map((pt, pi) => pi === curI ? { ...pt, transitAfter: !curTransit } : pt)
                  );
                  liveSegsRef.current = updated;
                  onChangeRef.current(updated);
                  map.closePopup();
                  rebuildAll();
                });
                menuEl.appendChild(transitBtn);
              }

              const delBtn = document.createElement('button');
              delBtn.textContent = '🗑️ Delete This Point';
              delBtn.style.cssText = 'background:#fef2f2;color:#dc2626;border:1px solid #fecaca;border-radius:6px;padding:5px 12px;font-size:11px;font-weight:600;cursor:pointer;display:block;width:100%;';
              delBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (!window.confirm(`Delete point ${curI + 1}? This can't be undone.`)) return;
                // v73.23: removing a point shifts every later index by one —
                // clear staging rather than risk a stale index now pointing
                // at the wrong point, same reasoning as the midpoint-insert
                // handler above. Also invalidates any pending bulk-undo
                // snapshot for the same reason.
                if (stagedPointIdxRef.current.size > 0 || stagedLineIdxRef.current.size > 0) clearDrawStagingRef.current();
                clearBulkUndoRef.current();
                const updated = liveSegsRef.current.map((s, si) =>
                  si !== curSegIdx ? s : s.filter((_, pi) => pi !== curI)
                );
                liveSegsRef.current = updated;
                onChangeRef.current(updated);
                map.closePopup();
                rebuildAll();
              });
              menuEl.appendChild(delBtn);

              // v73.46 — Craig: "want to be able to right click on any
              // point in edit road to change the start A or end B point
              // after a segment made." Reassigns which point is the
              // segment's A (first) or B (last) by rotating the array so
              // the clicked point lands at that end — the same rotation a
              // closed loop (Sweep Both Sides / a road that returns to its
              // own start) can do cleanly with zero visual change to the
              // shape, since it's still one continuous ring either way.
              // For a genuinely OPEN (non-looping) path this necessarily
              // creates a new straight connector between what used to be
              // the two separate ends — a real geometry change, not just a
              // relabelling — so it's flagged with an explicit confirm
              // that says exactly that, rather than silently doing
              // something a field crew wouldn't expect from a "set start
              // point" action.
              const setEndpointBtn = (label: string, makeFirst: boolean) => {
                if ((makeFirst && curI === 0) || (!makeFirst && isLastPt)) return; // already that endpoint
                const btn = document.createElement('button');
                btn.textContent = label;
                btn.style.cssText = 'background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:6px;padding:5px 12px;font-size:11px;font-weight:600;cursor:pointer;display:block;width:100%;margin-top:4px;';
                btn.addEventListener('click', (ev) => {
                  ev.stopPropagation();
                  const curPts = liveSegsRef.current[curSegIdx] || [];
                  const first = curPts[0], last = curPts[curPts.length - 1];
                  const isClosedLoop = first && last && haversine(first, last) < 5; // ~5m — same neighbourhood as a real closed ring
                  if (!isClosedLoop) {
                    const ok = window.confirm(
                      `This road doesn't form a closed loop, so making Point ${curI + 1} the new ${makeFirst ? 'start (A)' : 'end (B)'} will draw a new straight connector between the current start and end points, joining them together.\n\nContinue?`
                    );
                    if (!ok) return;
                  }
                  clearBulkUndoRef.current();
                  const rotated = makeFirst
                    ? [...curPts.slice(curI), ...curPts.slice(0, curI)]
                    : [...curPts.slice(curI + 1), ...curPts.slice(0, curI + 1)];
                  const updated = liveSegsRef.current.map((s, si) => si !== curSegIdx ? s : rotated);
                  liveSegsRef.current = updated;
                  onChangeRef.current(updated);
                  map.closePopup();
                  rebuildAll();
                });
                menuEl.appendChild(btn);
              };
              setEndpointBtn('🚩 Set as Start Point (A)', true);
              setEndpointBtn('🏁 Set as End Point (B)', false);

              marker.unbindPopup();
              marker.bindPopup(menuEl, { maxWidth: 210, closeButton: true }).openPopup();
            });
          }

          segMarkers.push(marker);
        });

        markersRef.current.push(segMarkers);

        // ── Midpoint insert handles for active segment ──
        // v73.38 — real-road routing (v73.34, simplified in v73.37) can
        // still leave points a few metres apart along a genuine curve/
        // intersection cluster — a midpoint "insert a point here" handle
        // for a 1-2m gap is rarely something anyone actually clicks, and
        // each one is another marker on top of everything else already
        // rendered for the active segment. Skipping handles for edges
        // under 3m measurably thins marker density on exactly the kind of
        // route that got dense from routing, without losing the ability to
        // insert a point anywhere that's actually a meaningfully sized gap.
        const MIN_INSERT_HANDLE_EDGE_METRES = 3;
        // v73.70 — HOTFIX. Craig: still freezing/unresponsive on large
        // Select-Roads/OSRM-snapped segments even after v73.44's point-
        // marker viewport culling (1213 pts -> ~2,400 markers before that
        // fix's threshold; OSRM-snapped came back denser at 4,191 pts ->
        // ~8,300 markers, matching Craig's own screenshot). v73.44 only
        // culled the POINT markers by viewport — this midpoint "insert a
        // point here" handle loop was never given the same treatment, so it
        // was still creating one marker per edge >=3m for the WHOLE active
        // segment regardless of what's on-screen. Reusing the exact same
        // viewBounds (already computed above for the point-marker cull) so
        // both marker types are culled consistently off one pass/zoom
        // handler — a handle whose midpoint falls outside the padded view
        // is skipped; panning already triggers rebuildAll() so it reappears
        // once scrolled into view, same as point markers already do.
        if (isActive && pts.length > 1) {
          for (let j = 0; j < pts.length - 1; j++) {
            if (haversine(pts[j], pts[j + 1]) < MIN_INSERT_HANDLE_EDGE_METRES) continue;
            const midLat = (pts[j].lat + pts[j + 1].lat) / 2;
            const midLng = (pts[j].lng + pts[j + 1].lng) / 2;
            if (viewBounds && !viewBounds.contains([midLat, midLng])) continue;
            const insertAt = j + 1;
            const edgeTx = pts[j].transitAfter === true;
            const midIcon = L.divIcon({
              className: '',
              // Transit edges get an amber midpoint handle to distinguish them
              html: `<div style="width:13px;height:13px;border-radius:50%;background:white;border:2px solid ${edgeTx ? '#f59e0b' : '#94a3b8'};opacity:0.85;cursor:copy;box-shadow:0 1px 4px rgba(0,0,0,0.2);"></div>`,
              iconSize: [13, 13], iconAnchor: [6, 6],
            });
            const midMk = L.marker([midLat, midLng], { icon: midIcon, zIndexOffset: 500 }).addTo(map);
            midMk.bindTooltip(`${edgeTx ? '🔀 Transit edge — ' : ''}➕ Insert between ${j + 1} & ${j + 2}`, { direction: 'top', offset: [0, -8] });
            midMk.on('click', (e) => {
              L.DomEvent.stopPropagation(e);
              // v73.23: inserting shifts every later point's index by one —
              // clear any in-progress staging rather than risk a stale
              // staged index now pointing at the wrong point/edge. Also
              // invalidates any pending bulk-undo snapshot for the same
              // reason (the snapshot's saved point order no longer lines
              // up with the just-inserted point).
              if (stagedPointIdxRef.current.size > 0 || stagedLineIdxRef.current.size > 0) clearDrawStagingRef.current();
              clearBulkUndoRef.current();
              const updated = liveSegsRef.current.map((s, si) => {
                if (si !== segIdx) return s;
                // New point inherits the transitAfter of the edge it splits INTO
                // (keeps the new edge consistent with what the user intended)
                const copy = [...s];
                copy.splice(insertAt, 0, { lat: midLat, lng: midLng });
                return copy;
              });
              liveSegsRef.current = updated;
              onChangeRef.current(updated);
              rebuildAll();
            });
            midMkRef.current.push(midMk);
          }
        }
      });

      // v73.100 — Turnaround Points: render only the ACTIVE segment's markers
      // (same scoping as the editable point/line handles above) — distinct
      // orange circular-arrow icon, labelled T1/T2..., draggable, right-click
      // to delete. Never part of polylinesRef (not a route line) and never
      // counted toward km — purely a snap-time hint for OSRM (see
      // buildIncludeFlagsBody/snapToRoads' request body).
      const activeTurnarounds = turnaroundsRef.current[activeIdx] || [];
      activeTurnarounds.forEach((tp, ti) => {
        const label = `T${ti + 1}`;
        const icon = L.divIcon({
          className: '',
          html: `<div style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:#f97316;border:2px solid #ffffff;box-shadow:0 1px 3px rgba(0,0,0,0.4);color:#fff;font-size:11px;font-weight:700;">${label}</div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        });
        const marker = L.marker([tp.lat, tp.lng], { icon, draggable: true, zIndexOffset: 1500 }).addTo(map);
        marker.bindTooltip('🔄 Turnaround Point — helps OSRM snap to the road end here', { direction: 'top' });
        marker.on('dragend', () => {
          const ll = marker.getLatLng();
          const updatedT = turnaroundsRef.current.map((t, si) =>
            si !== activeIdx ? t : t.map((p, pi) => pi === ti ? { ...p, lat: ll.lat, lng: ll.lng } : p)
          );
          turnaroundsRef.current = updatedT;
          onTurnaroundsChangeRef.current?.(updatedT);
        });
        marker.on('contextmenu', (ev: L.LeafletMouseEvent) => {
          ev.originalEvent?.preventDefault();
          if (!window.confirm(`Delete turnaround point ${label}?`)) return;
          const updatedT = turnaroundsRef.current.map((t, si) => si !== activeIdx ? t : t.filter((_, pi) => pi !== ti));
          turnaroundsRef.current = updatedT;
          onTurnaroundsChangeRef.current?.(updatedT);
          rebuildAllRef.current();
        });
        turnaroundMarkersRef.current.push(marker);
      });

    };

    rebuildAllRef.current = rebuildAll;
    rebuildAll();

    // Fit bounds ONCE on mount — never during editing to avoid zoom jumps
    const allPtsInit = (liveSegsRef.current || []).flat();
    if (allPtsInit.length > 1) {
      try { map.fitBounds(L.latLngBounds(allPtsInit.map(p => L.latLng(p.lat, p.lng))), { padding: [20, 20], maxZoom: 18 }); } catch { /**/ }
    }

    map.on('click', (e: L.LeafletMouseEvent) => {
      // v73.14: Select Roads mode has its own click handling — individual
      // road polylines toggle selection directly, and when Lasso Select is
      // active a plain map click places the next fence vertex instead (see
      // the fence-vertex render effect below). Either way the base map's
      // click-to-add-SEGMENT-point behaviour (used by Draw Points mode)
      // stays off while in Select Roads mode so clicking empty map space
      // doesn't accidentally start a manual segment point.
      if (editorModeRef.current === 'select') {
        // v73.104 — Craig: turnaround points must ONLY be placeable on the
        // same real road-endpoint picker A/B already use (see the picker
        // markers rendered further down, guarded by `turnaroundMode`) — a
        // raw click anywhere on the map or on a road line no longer places
        // anything. Still checked first and still returns, so a click while
        // Turnaround mode is on can never fall through to fence-vertex
        // placement or road selection either — it's just inert until the
        // user clicks one of the actual picker markers.
        if (turnaroundModeRef.current) return;
        if (lassoActiveRef.current) {
          if (fenceShapeRef.current === 'box') {
            // v73.19: Box shape — first click drops one corner, second click
            // drops the opposite corner and the rectangle is computed
            // immediately (4 corners from the two clicked points' min/max
            // lat/lng). A third click is ignored — Cancel Fence to start
            // over, or drag a corner marker to adjust, same as Lasso.
            const current = lassoVerticesRef.current;
            if (current.length === 0) {
              const next = [{ lat: e.latlng.lat, lng: e.latlng.lng }];
              lassoVerticesRef.current = next;
              setLassoVertices(next);
            } else if (current.length === 1) {
              const a = current[0];
              const b = { lat: e.latlng.lat, lng: e.latlng.lng };
              const corners: RoadPoint[] = [
                { lat: a.lat, lng: a.lng },
                { lat: a.lat, lng: b.lng },
                { lat: b.lat, lng: b.lng },
                { lat: b.lat, lng: a.lng },
              ];
              lassoVerticesRef.current = corners;
              setLassoVertices(corners);
            }
            // 4 corners already placed — ignore further clicks on the map itself
          } else {
            const next = [...lassoVerticesRef.current, { lat: e.latlng.lat, lng: e.latlng.lng }];
            lassoVerticesRef.current = next;
            setLassoVertices(next);
          }
        }
        return;
      }
      // v73.25 — Bug #2 fix: a Ctrl+drag box-select (see onDrawCtrlMouseDown
      // below) ends with a mouseup at the drag's release point — Leaflet still
      // synthesizes a plain 'click' event for that mouseup (map.dragging being
      // disabled doesn't suppress it), which this handler then treated as an
      // ordinary "add a new point here" click, silently appending a stray point/
      // line (the reported "endpoint B") right after every box-select. Ctrl is
      // never used to legitimately add a point, so ignore the click outright
      // whenever Ctrl is (still) held.
      if (e.originalEvent?.ctrlKey) return;
      // v73.104 — Turnaround points are placed only via the same real
      // road-endpoint picker A/B use, which only exists in Select Roads
      // mode (see the picker markers/toolbar guard there). Draw Points mode
      // has no such picker, so the toggle is disabled here (see the button
      // below) and this is just a defensive no-op in case it's ever
      // reachable — never places a raw-click marker.
      if (turnaroundModeRef.current) return;
      const segs = liveSegsRef.current || [];
      const idx = activeIdxRef.current;
      const updated = segs.map((s, si) => {
        if (si !== idx) return s;
        // If transit mode is on and there's already at least one point,
        // mark the current last point's edge as transit before appending
        // the new point (so the line FROM that point TO the new one is transit).
        if (transitModeRef.current && s.length > 0) {
          const withTransit = s.map((pt, pi) =>
            pi === s.length - 1 ? { ...pt, transitAfter: true } : pt
          );
          return [...withTransit, { lat: e.latlng.lat, lng: e.latlng.lng }];
        }
        return [...s, { lat: e.latlng.lat, lng: e.latlng.lng }];
      });
      liveSegsRef.current = updated;
      onChangeRef.current(updated);
      rebuildAllRef.current();
    });

    // v73.21 — Craig: "i want the highlight box... holding the shift key"
    // (screenshot shows a semi-transparent blue rubber-band box — done well
    // via a modifier+drag gesture, unlike Lasso/Box's click-only placement).
    // Shift is already taken by Leaflet's own built-in box-zoom, so this
    // uses Ctrl+drag instead, per the spec. Deliberately raw
    // mousedown/mousemove/mouseup (not the click-to-place-vertex pattern
    // used by Lasso/Box above) because a rubber-band selection is
    // conventionally a drag gesture on every desktop OS — the v73.13/73.14
    // lesson about drag gestures breaking panning doesn't apply here because
    // map.dragging is only ever disabled while Ctrl is actually held down
    // AND the drag started on the map, so plain panning (no Ctrl) is
    // completely untouched, and Shift+drag zoom-to-area is untouched since
    // this only ever triggers on ctrlKey, never shiftKey.
    let ctrlDragStart: L.Point | null = null;
    let ctrlDragRect: L.Rectangle | null = null;

    const onCtrlMouseDown = (e: L.LeafletMouseEvent) => {
      const orig = e.originalEvent;
      if (!orig.ctrlKey || editorModeRef.current !== 'select' || lassoActiveRef.current) return;
      orig.preventDefault();
      map.dragging.disable();
      ctrlDragStart = map.mouseEventToContainerPoint(orig);
      // v73.22: no longer clears the staged queue here — a Ctrl+drag should
      // ADD to whatever's already staged (including roads staged by a
      // previous click), not wipe it out. Only Delete/Confirm, Escape/
      // Cancel, or leaving Deselect mode clear the queue now.
    };
    map.on('mousedown', onCtrlMouseDown);

    const onWindowMouseMove = (orig: MouseEvent) => {
      if (!ctrlDragStart) return;
      const pt = map.mouseEventToContainerPoint(orig);
      const minX = Math.min(pt.x, ctrlDragStart.x), maxX = Math.max(pt.x, ctrlDragStart.x);
      const minY = Math.min(pt.y, ctrlDragStart.y), maxY = Math.max(pt.y, ctrlDragStart.y);
      const swPt = L.point(minX, maxY), nePt = L.point(maxX, minY);
      const bounds = L.latLngBounds(map.containerPointToLatLng(swPt), map.containerPointToLatLng(nePt));
      if (ctrlDragRect) {
        ctrlDragRect.setBounds(bounds);
      } else {
        // Blue border, ~20% opacity blue fill, per spec — matches a
        // Windows/macOS file-explorer rubber-band box.
        ctrlDragRect = L.rectangle(bounds, { color: '#2563eb', weight: 1.5, fillColor: '#3b82f6', fillOpacity: 0.2 }).addTo(map);
      }
    };
    window.addEventListener('mousemove', onWindowMouseMove);

    const onWindowMouseUp = () => {
      if (!ctrlDragStart) return;
      const bounds = ctrlDragRect ? ctrlDragRect.getBounds() : null;
      map.dragging.enable();
      ctrlDragStart = null;
      if (ctrlDragRect) { ctrlDragRect.remove(); ctrlDragRect = null; }
      if (!bounds) return;
      // v73.41 — checking every vertex already caught most cases, but a
      // road with just 2-3 sparse vertices whose LINE crosses the box
      // without any vertex landing inside it was still missed. Added the
      // same segment-intersection check used for points/lines in Draw mode.
      const hit = visibleRoadsRef.current.filter(f => {
        if (f.coords.some(([lng, lat]) => bounds.contains(L.latLng(lat, lng)))) return true;
        for (let i = 0; i < f.coords.length - 1; i++) {
          const a = { lat: f.coords[i][1], lng: f.coords[i][0] };
          const b = { lat: f.coords[i + 1][1], lng: f.coords[i + 1][0] };
          if (segmentIntersectsBounds(a, b, bounds)) return true;
        }
        return false;
      });
      if (hit.length === 0) return;
      if (lassoModeRef.current === 'deselect') {
        // v73.22: only stage roads that are actually IN the current
        // selection — deselect is about removing from an existing
        // selection, so a box that also sweeps over unselected roads
        // shouldn't stage those (nothing there to remove). Same
        // selected-only rule the single-click handler uses below.
        const selectedNow = new Set(selectedRoadIdsRef.current);
        const hitSelected = hit.filter(f => selectedNow.has(f.id));
        if (hitSelected.length === 0) return;
        pushSelectionUndo();
        // Merge into the staged queue (don't replace it), so a box can be
        // drawn multiple times, or combined with individual clicks, to
        // build up one removal batch before committing. Nothing is
        // actually removed until Delete/Confirm.
        setStagedForRemovalIds(prev => {
          const next = new Set(prev);
          hitSelected.forEach(f => next.add(f.id));
          stagedForRemovalIdsRef.current = next;
          return next;
        });
      } else {
        // Select mode: immediate, same as the spec table says.
        pushSelectionUndo();
        hit.forEach(f => selectedFeaturesRef.current.set(f.id, f));
        setSelectedRoadIds(prev => {
          const set = new Set(prev);
          hit.forEach(f => set.add(f.id));
          return Array.from(set);
        });
      }
    };
    window.addEventListener('mouseup', onWindowMouseUp);

    // v73.76 — Craig: "having trouble moving the map around with the mouse
    // it not moving," happening only sometimes / after doing something else
    // first. Root cause: onWindowMouseUp above is the ONLY thing that ever
    // re-enables map.dragging after a Ctrl+drag box-select, and it only
    // fires on an actual 'mouseup' event reaching window. If the mouse
    // button is released somewhere that swallows the event (losing window
    // focus mid-drag via Alt-Tab, a browser/OS dialog popping up, dev tools
    // stealing focus, etc.), 'mouseup' never fires and map.dragging stays
    // disabled with no error, until the page is reloaded. Safety net:
    // force-cleanup on window blur, tab/app going hidden, or Escape — same
    // cleanup onWindowMouseUp already does, just triggered by anything
    // OTHER than a normal mouseup too. (Re-applied v73.78 — this fix was
    // present in a parallel v73.76 built on a different base and was lost
    // when that branch's changes weren't carried into this OSRM-focused
    // v73.77 lineage; see CHANGELOG.md v73.78.)
    const forceReleaseCtrlDrag = () => {
      if (!ctrlDragStart) return;
      map.dragging.enable();
      ctrlDragStart = null;
      if (ctrlDragRect) { ctrlDragRect.remove(); ctrlDragRect = null; }
    };
    const onCtrlDragEscape = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') forceReleaseCtrlDrag();
    };
    window.addEventListener('blur', forceReleaseCtrlDrag);
    document.addEventListener('visibilitychange', forceReleaseCtrlDrag);
    window.addEventListener('keydown', onCtrlDragEscape);

    // v73.22: renamed from onDeleteKey — now also handles Escape (cancel the
    // staged queue without deleting anything), since both are keyboard
    // commits/cancels for the same staged-for-removal queue.
    const onStagedQueueKey = (ev: KeyboardEvent) => {
      const isDelete = ev.key === 'Delete' || ev.key === 'Backspace';
      const isEscape = ev.key === 'Escape';
      if (!isDelete && !isEscape) return;
      // Don't hijack these while the user is typing somewhere else in the
      // form (e.g. the road name field) — Escape in particular is commonly
      // used to blur/cancel a text field, so leave that alone.
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea' || (document.activeElement as HTMLElement | null)?.isContentEditable) return;
      if (editorModeRef.current !== 'select' || lassoModeRef.current !== 'deselect') return;
      if (stagedForRemovalIdsRef.current.size === 0) return;
      ev.preventDefault();
      if (isEscape) {
        // Cancel: clear the staged queue, delete nothing.
        stagedForRemovalIdsRef.current = new Set();
        setStagedForRemovalIds(new Set());
        return;
      }
      pushSelectionUndo();
      const ids = stagedForRemovalIdsRef.current;
      ids.forEach(id => selectedFeaturesRef.current.delete(id));
      setSelectedRoadIds(prev => prev.filter(id => !ids.has(id)));
      stagedForRemovalIdsRef.current = new Set();
      setStagedForRemovalIds(new Set());
    };
    window.addEventListener('keydown', onStagedQueueKey);

    // v73.23 — Draw Points bulk delete/transit-convert, developer-prompt
    // spec Fix 2: Ctrl+drag rubber-band box, same mechanic and same visual
    // style as the Select-mode road box above, but staging POINTS (by
    // index within the active segment) instead of roads. Deliberately a
    // SEPARATE mousedown/mousemove/mouseup set, gated on
    // editorModeRef.current === 'draw' (the road version above gates on
    // 'select'), so the two can never both fire for the same gesture —
    // map.dragging is only ever disabled while Ctrl is actually held AND a
    // drag started on the map, so plain panning and Shift+drag zoom stay
    // completely untouched here too, same reasoning as the road version.
    let drawCtrlDragStart: L.Point | null = null;
    let drawCtrlDragRect: L.Rectangle | null = null;
    const onDrawCtrlMouseDown = (e: L.LeafletMouseEvent) => {
      const orig = e.originalEvent;
      if (!orig.ctrlKey || editorModeRef.current !== 'draw') return;
      orig.preventDefault();
      map.dragging.disable();
      drawCtrlDragStart = map.mouseEventToContainerPoint(orig);
    };
    map.on('mousedown', onDrawCtrlMouseDown);

    const onDrawWindowMouseMove = (orig: MouseEvent) => {
      if (!drawCtrlDragStart) return;
      const pt = map.mouseEventToContainerPoint(orig);
      const minX = Math.min(pt.x, drawCtrlDragStart.x), maxX = Math.max(pt.x, drawCtrlDragStart.x);
      const minY = Math.min(pt.y, drawCtrlDragStart.y), maxY = Math.max(pt.y, drawCtrlDragStart.y);
      const swPt = L.point(minX, maxY), nePt = L.point(maxX, minY);
      const bounds = L.latLngBounds(map.containerPointToLatLng(swPt), map.containerPointToLatLng(nePt));
      if (drawCtrlDragRect) {
        drawCtrlDragRect.setBounds(bounds);
      } else {
        drawCtrlDragRect = L.rectangle(bounds, { color: '#2563eb', weight: 1.5, fillColor: '#3b82f6', fillOpacity: 0.2 }).addTo(map);
      }
    };
    window.addEventListener('mousemove', onDrawWindowMouseMove);

    const onDrawWindowMouseUp = () => {
      if (!drawCtrlDragStart) return;
      const bounds = drawCtrlDragRect ? drawCtrlDragRect.getBounds() : null;
      map.dragging.enable();
      drawCtrlDragStart = null;
      if (drawCtrlDragRect) { drawCtrlDragRect.remove(); drawCtrlDragRect = null; }
      if (!bounds) return;
      const idx = activeIdxRef.current;
      const pts = (liveSegsRef.current[idx]) || [];
      const hitIdx: number[] = [];
      pts.forEach((p, i) => { if (bounds.contains(L.latLng(p.lat, p.lng))) hitIdx.push(i); });
      // v73.41 — also catch edges that pass THROUGH the box without either
      // endpoint landing inside it (see segmentIntersectsBounds comment) —
      // stage both endpoints of any such edge too, same as if they'd been
      // individually inside the box.
      for (let i = 0; i < pts.length - 1; i++) {
        if (hitIdx.includes(i) && hitIdx.includes(i + 1)) continue; // already both staged above
        if (segmentIntersectsBounds(pts[i], pts[i + 1], bounds)) {
          if (!hitIdx.includes(i)) hitIdx.push(i);
          if (!hitIdx.includes(i + 1)) hitIdx.push(i + 1);
        }
      }
      if (hitIdx.length === 0) return;
      // Stage every point inside the box. A line/edge is drawn as staged
      // whenever BOTH its endpoints are staged points (derived at render
      // time, see isStagedLine above) — no separate "staged line" tracking
      // needed for the box tool specifically, since deleting the box's
      // staged points already removes every edge fully inside the box as a
      // natural side effect of the single reconnect-by-filter commit below.
      setStagedPointIdx(prev => {
        const next = new Set(prev);
        hitIdx.forEach(i => next.add(i));
        stagedPointIdxRef.current = next;
        return next;
      });
    };
    window.addEventListener('mouseup', onDrawWindowMouseUp);

    // v73.76 — same safety net as the Select-mode Ctrl-drag box above (see
    // its comment for the full root-cause explanation); re-applied v73.78,
    // see that comment too.
    const forceReleaseDrawCtrlDrag = () => {
      if (!drawCtrlDragStart) return;
      map.dragging.enable();
      drawCtrlDragStart = null;
      if (drawCtrlDragRect) { drawCtrlDragRect.remove(); drawCtrlDragRect = null; }
    };
    const onDrawCtrlDragEscape = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') forceReleaseDrawCtrlDrag();
    };
    window.addEventListener('blur', forceReleaseDrawCtrlDrag);
    document.addEventListener('visibilitychange', forceReleaseDrawCtrlDrag);
    window.addEventListener('keydown', onDrawCtrlDragEscape);

    // v73.23 — Fix 1 step 2/3: Delete/Backspace commits the staged
    // points+lines (one atomic removal, auto-reconnects and auto-
    // recalculates km/point-count/labels for free since those are all
    // derived live from the segments array on every render — see
    // totalLen/"{seg.length} pts" elsewhere in this file). Escape clears
    // the queue without deleting anything. Separate listener from the road
    // version above (which gates on 'select') — this one only ever acts
    // while editorMode === 'draw', and ignores both keys while focus is in
    // a text field so it can't clobber the road name/notes inputs.
    const onDrawStagedQueueKey = (ev: KeyboardEvent) => {
      const isDelete = ev.key === 'Delete' || ev.key === 'Backspace';
      const isEscape = ev.key === 'Escape';
      if (!isDelete && !isEscape) return;
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea' || (document.activeElement as HTMLElement | null)?.isContentEditable) return;
      if (editorModeRef.current !== 'draw') return;
      if (stagedPointIdxRef.current.size === 0 && stagedLineIdxRef.current.size === 0) return;
      ev.preventDefault();
      if (isEscape) { clearDrawStagingRef.current(); return; }
      commitDrawStagedDeleteRef.current();
    };
    window.addEventListener('keydown', onDrawStagedQueueKey);

    // v73.100 — Turnaround Points keyboard shortcuts: 'T' toggles turnaround-
    // placement mode on/off, Escape switches it off (only when nothing else
    // is staged — the staging queue's own Escape handler above takes
    // priority so this never fights it). Same input-focus guard as every
    // other shortcut in this file so it can't clobber the road name/notes
    // fields or steal a plain "type T" from a text box.
    const onTurnaroundKey = (ev: KeyboardEvent) => {
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea' || (document.activeElement as HTMLElement | null)?.isContentEditable) return;
      if (editorModeRef.current !== 'draw') return;
      if (ev.key === 't' || ev.key === 'T') {
        ev.preventDefault();
        turnaroundModeRef.current = !turnaroundModeRef.current;
        setTurnaroundMode(turnaroundModeRef.current);
      } else if (ev.key === 'Escape' && turnaroundModeRef.current
          && stagedPointIdxRef.current.size === 0 && stagedLineIdxRef.current.size === 0) {
        turnaroundModeRef.current = false;
        setTurnaroundMode(false);
      }
    };
    window.addEventListener('keydown', onTurnaroundKey);

    // v73.14: Lasso Select is now click-to-place-vertex (like Draw Points),
    // not a drag gesture — dragging to draw a shape was disabling map
    // panning for the whole gesture and gave no way to fix a wonky point
    // afterward. The map's own 'click' handler above now branches into
    // "add a fence vertex" when Lasso is active (see the click handler
    // near the top of this effect) instead of a separate mousedown/
    // mousemove/mouseup block — map dragging/panning is never touched, so
    // normal panning still works while placing fence points.

    // v73.12: re-fetch road geometry for whatever's in view whenever the map
    // moves, but only while Select Roads mode is actually active — no point
    // hitting the server on every pan while the user is just drawing points.
    let moveendTimer: ReturnType<typeof setTimeout> | null = null;
    map.on('moveend', () => {
      if (editorModeRef.current !== 'select') return;
      if (moveendTimer) clearTimeout(moveendTimer);
      moveendTimer = setTimeout(() => { fetchRoadsRef.current(); }, 300); // debounce rapid pan/zoom
    });

    // v73.44 — companion to the point-marker viewport culling above: while
    // in Draw mode with a large active segment, panning/zooming needs to
    // rebuild the marker layer so points that just entered/left the view
    // get their marker added/removed. Cheap no-op for normal-sized
    // segments (rebuildAll's own threshold check makes culling a no-op
    // under 300 points). Separate timer from the roads-fetch one above —
    // they gate on different modes and shouldn't cancel each other.
    let drawMoveendTimer: ReturnType<typeof setTimeout> | null = null;
    map.on('moveend', () => {
      if (editorModeRef.current !== 'draw') return;
      if (drawMoveendTimer) clearTimeout(drawMoveendTimer);
      drawMoveendTimer = setTimeout(() => { rebuildAllRef.current(); }, 150);
    });

    return () => {
      try { map.remove(); } catch { /**/ }
      mapRef.current = null;
      if (moveendTimer) clearTimeout(moveendTimer);
      if (drawMoveendTimer) clearTimeout(drawMoveendTimer);
      window.removeEventListener('mousemove', onWindowMouseMove);
      window.removeEventListener('mouseup', onWindowMouseUp);
      window.removeEventListener('blur', forceReleaseCtrlDrag);
      document.removeEventListener('visibilitychange', forceReleaseCtrlDrag);
      window.removeEventListener('keydown', onCtrlDragEscape);
      window.removeEventListener('keydown', onStagedQueueKey);
      window.removeEventListener('mousemove', onDrawWindowMouseMove);
      window.removeEventListener('mouseup', onDrawWindowMouseUp);
      window.removeEventListener('blur', forceReleaseDrawCtrlDrag);
      document.removeEventListener('visibilitychange', forceReleaseDrawCtrlDrag);
      window.removeEventListener('keydown', onDrawCtrlDragEscape);
      window.removeEventListener('keydown', onDrawStagedQueueKey);
      window.removeEventListener('keydown', onTurnaroundKey);
    };
    // Map is created ONCE on mount only. Style/drawing-option changes (color,
    // segmentColors, showNumbers, showMarkers) must NOT tear down and
    // recreate the map — doing so previously reset the view to defaultCenter
    // (the first drawn point, or a hardcoded fallback if nothing's drawn yet)
    // any time a drawing option was toggled. That's why searching for a
    // city/town and then clicking a drawing option (e.g. "show numbers")
    // would snap the map back to the default start location instead of
    // staying where the user had searched to. Style changes are now handled
    // by the lightweight redraw effect below, which calls rebuildAll()
    // without touching the underlying Leaflet map instance or its view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-draw (NOT recreate) when active segment switches, segments change
  // externally, or drawing-style options change (color/segmentColors/
  // showNumbers/showMarkers). Deliberately does NOT call fitBounds and does
  // NOT recreate the map — so the map stays wherever the user last navigated
  // it to (e.g. via city search), instead of jumping back to the default
  // start location.
  useEffect(() => {
    activeIdxRef.current = activeSegIdx;
    liveSegsRef.current = segments;
    rebuildAllRef.current();
  }, [activeSegIdx, segments, color, segmentColors, showNumbers, showMarkers]);

  // v73.23 — staged point/line indices are only meaningful for one specific
  // segment's array at one specific moment (they're plain array indices,
  // not stable ids) — switching which segment tab is active, or leaving
  // Draw Points mode entirely (e.g. to Select Roads), must clear them
  // rather than risk a stale index later deleting/converting the wrong
  // point in whatever segment is now active. Also covers the developer
  // prompt's "must clear if the user clicks Close or switches away from
  // the Edit Road panel" — closing/switching away unmounts this component
  // (or at minimum swaps `segments`/`activeSegIdx` to a different road),
  // so this same effect handles that case too without a separate listener.
  // v73.30 — Craig: "the segment where interfering with each other." Real
  // bug: this effect cleared Draw Points' staging/bulk-undo/manual-start-
  // point state on a segment or mode switch, but NOT Select Roads' own
  // in-progress state — selectedRoadIds, its selectedFeaturesRef cache,
  // stagedForRemovalIds (Deselect queue), or an in-progress lassoVertices
  // fence. Build a selection while Segment A is active, switch to Segment
  // B without committing, and that selection/fence was still sitting
  // there — the next "Add to Segment" or "Confirm Fence" would land on
  // whichever segment happened to be active THEN, not the one it was
  // actually built for. Now cleared alongside everything else here.
  useEffect(() => {
    setStagedPointIdx(new Set()); stagedPointIdxRef.current = new Set();
    setStagedLineIdx(new Set()); stagedLineIdxRef.current = new Set();
    if (suppressNextBulkUndoClearRef.current) {
      // v73.79 — this fire is addSelectedRoadsToSegment's own
      // setEditorMode('draw'), which just pushed an undo entry two lines
      // earlier. Skip the clear this one time only, then re-arm.
      suppressNextBulkUndoClearRef.current = false;
    } else {
      clearBulkUndo();
    }
    setManualStartPoint(null); manualStartPointRef.current = null;
    setSettingStartPoint(false); settingStartPointRef.current = false;
    setManualEndPoint(null); manualEndPointRef.current = null;
    setSettingEndPoint(false); settingEndPointRef.current = false;
    selectedFeaturesRef.current.clear();
    setSelectedRoadIds([]);
    setStagedForRemovalIds(new Set());
    setTransitRoadIds(new Set());
    setMarkTransitMode(false);
    setLassoVertices([]);
    setLassoActive(false);
    setLassoMode('select');
    clearSelectionUndo();
    clearSelectionDraft();
  }, [activeSegIdx, editorMode]);

  // v73.68 — reports whether there's currently an uncommitted Select Roads
  // selection/fence that the effect above would silently wipe on the NEXT
  // segment or mode switch, so the parent can warn before that switch happens
  // (this effect can't warn itself — by the time it runs, the switch already
  // happened and the clear is already correct/necessary).
  useEffect(() => {
    const pending = selectedRoadIds.length > 0 || lassoVertices.length > 0 || stagedForRemovalIds.size > 0;
    onPendingSelectionChange?.(pending);
  }, [selectedRoadIds, lassoVertices, stagedForRemovalIds, onPendingSelectionChange]);

  // ── v73.12: Select Roads mode ──────────────────────────────────────────────
  // Fetches road geometry for the current map view from the host-server's
  // self-hosted OSM extract (GET /api/roads?bbox=...) and keeps it in
  // visibleRoads. Read-only, no relation to segment data until "Add to
  // Segment" is pressed.
  const fetchRoadsInView = React.useCallback(async () => {
    const map = mapRef.current;
    if (!map || !syncServerUrlRef.current) {
      if (!syncServerUrlRef.current) setRoadsError('No sync server configured — set one up under System → Backup & Sync first.');
      return;
    }
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(',');
    const serviceLanesParam = includeServiceLanesRef.current ? '&includeServiceLanes=1' : '';
    const lanesParam = includeLanesRef.current ? '&includeLanes=1' : '';
    const parkingAislesParam = includeParkingAislesRef.current ? '&includeParkingAisles=1' : '';
    const serviceRoadsParam = includeServiceRoadsRef.current ? '&includeServiceRoads=1' : '';
    const livingStreetsParam = includeLivingStreetsRef.current ? '&includeLivingStreets=1' : '';
    roadFetchAbortRef.current?.abort();
    const controller = new AbortController();
    roadFetchAbortRef.current = controller;
    setRoadsLoading(true); setRoadsError('');
    try {
      const resp = await fetch(`${syncServerUrlRef.current}/api/roads?bbox=${bbox}${serviceLanesParam}${lanesParam}${parkingAislesParam}${serviceRoadsParam}${livingStreetsParam}`, {
        headers: { 'X-Sync-Token': syncTokenRef.current },
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
      const geo = await resp.json();
      if (geo?.meta?.loaded === false) {
        setVisibleRoads([]);
        setRoadsError('No road data on server yet — run extract-roads.sh and copy roads.geojson to the host-server (see setup notes).');
        return;
      }
      const feats: RoadFeature[] = (geo.features || []).map((f: { id: string; properties?: { name?: string; category?: 'road' | 'service' | 'lane' | 'parkingaisle' | 'serviceroad' | 'livingstreet' }; geometry: { coordinates: [number, number][] } }) => ({
        id: f.id, name: f.properties?.name || '', category: f.properties?.category, coords: f.geometry.coordinates,
      }));
      setVisibleRoads(feats);
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return; // superseded by a newer request — not a real error
      setRoadsError('Could not load road data — check your connection to the sync server.');
    } finally {
      setRoadsLoading(false);
    }
  }, []);
  useEffect(() => { fetchRoadsRef.current = () => { fetchRoadsInView(); }; }, [fetchRoadsInView]);

  // Entering Select Roads mode fetches immediately for the current view
  // rather than waiting for the next pan/zoom. Also re-fetches whenever the
  // "include car parks/driveways" toggle changes, so flipping it updates
  // the current view immediately instead of waiting for the next pan.
  useEffect(() => {
    if (editorMode === 'select') fetchRoadsInView();
  }, [editorMode, includeServiceLanes, includeLanes, includeParkingAisles, includeServiceRoads, includeLivingStreets, fetchRoadsInView]);

  // Render the road-select overlay whenever the visible roads or the current
  // selection changes. Separate from rebuildAll (the segment-drawing layer)
  // so toggling a road's selection never touches the segment being edited.
  useEffect(() => {
    const layer = roadLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (editorMode !== 'select') return;
    const selectedSet = new Set(selectedRoadIds);
    // v73.15: selected roads now render in the ACTIVE segment's own assigned
    // colour (segmentColors[activeSegIdx], falling back to the road's overall
    // colour) instead of always red — Craig: "the colors chosen need to show
    // after confirm fence is pushed... one meant to be blue the other is
    // meant to be a greenly color." This makes it visually obvious which
    // segment a selection will land in before "Add to Segment" is pressed.
    const activeSegColor = segmentColorsRef.current[activeIdxRef.current] || colorRef.current;
    const highlightedSet = stagedForRemovalIds;
    visibleRoads.forEach(f => {
      const isSelected = selectedSet.has(f.id);
      const isServiceLane = f.category === 'service';
      const isLane = f.category === 'lane'; // v73.43 — road named "... Lane", excluded by default like service lanes
      const isParkingAisle = f.category === 'parkingaisle'; // v73.53
      const isServiceRoadCat = f.category === 'serviceroad'; // v73.53 — plain OSM highway=service, no recognised subtype
      const isLivingStreet = f.category === 'livingstreet'; // v73.53
      const isExcludedByDefault = isServiceLane || isLane || isParkingAisle || isServiceRoadCat || isLivingStreet;
      // v73.21/73.22: roads staged for removal — via a Ctrl+drag box or a
      // direct click while in Deselect mode — render red/dashed/thicker
      // until the queue is committed (Delete/Confirm Delete) or cleared
      // (Escape/Cancel), distinct from both the normal selected colour and
      // the service-lane amber, so it's obvious at a glance what a commit
      // is about to remove — and, since staged roads stay visible together,
      // multiple segments of the same road can be reviewed before committing
      // instead of each click deleting on the spot.
      const isPendingDelete = highlightedSet.has(f.id);
      // v73.84 — Craig: "at the moment i can't tell what transit or not
      // selected road" — every selected road rendered identically
      // (activeSegColor, solid) regardless of the "🔀 Add as Transit"
      // toggle, so there was no visual difference between a pending normal
      // pass and a pending transit pass until AFTER commit. While the
      // toggle is on, preview every currently-selected road dashed
      // ("-------") in the same segment colour — distinct from solid
      // selected (normal pass) — and it reverts to the real committed
      // look (solid segment colour, or the amber transit-edge treatment
      // used elsewhere for already-committed transit runs) the instant
      // Add to Segment/Add as Transit is actually pushed.
      // v73.94 — preview dashed either while the whole-selection toggle is
      // on, OR when this specific road has been individually marked via
      // "Mark Transit Roads" mode.
      const isIndividuallyMarkedTransit = isSelected && transitRoadIdsRef.current.has(f.id);
      const isPendingTransitPreview = isSelected && (addAsTransitRef.current || isIndividuallyMarkedTransit);
      const latlngs = f.coords.map(([lng, lat]) => [lat, lng] as [number, number]);
      // v73.28 — same white-halo fix as Draw Points' staged-line highlight
      // above: a red highlight on an already-red/orange road was nearly
      // invisible. The halo goes in the same auto-cleared `layer` group,
      // added right before the coloured line so it renders underneath it.
      if (isPendingDelete) {
        L.polyline(latlngs, { color: '#ffffff', weight: 9, opacity: 0.9 }).addTo(layer);
      }
      const pl = L.polyline(latlngs, {
        color: isPendingDelete ? '#dc2626' : isSelected ? activeSegColor : (isExcludedByDefault ? '#d97706' : '#94a3b8'),
        weight: isPendingDelete ? 6 : isSelected ? 5 : 3,
        opacity: isPendingDelete ? 0.95 : isSelected ? 0.9 : 0.55,
        dashArray: isPendingDelete ? '3 4' : isPendingTransitPreview ? '10 8' : (!isSelected && isExcludedByDefault) ? '6 4' : undefined,
      });
      // v73.96 — Craig, screenshot: this tooltip sat right over the map,
      // "getting in the way" — worst on the pending-transit case since that
      // explanatory clause is the longest one and shows on every dashed
      // road in a big selection, not just one hover. Shortened specifically
      // for that case; the others are already short and only appear on a
      // single hovered road at a time.
      if (f.name || isExcludedByDefault || isPendingDelete || isPendingTransitPreview) pl.bindTooltip(`${f.name || '(unnamed)'}${isServiceLane ? ' — car park/driveway/service lane' : isLane ? ' — named Lane, excluded by default' : isParkingAisle ? ' — parking aisle, excluded by default' : isServiceRoadCat ? ' — service road, excluded by default' : isLivingStreet ? ' — living street, excluded by default' : ''}${isPendingDelete ? ' — staged for removal, click to unstage' : isPendingTransitPreview ? ' — Transit (pending)' : (lassoMode === 'deselect' && isSelected) ? ' — click to stage for removal' : ''}`, { direction: 'top', sticky: true, opacity: 0.85 });
      pl.on('click', (e: L.LeafletMouseEvent) => {
        // While actively placing fence points, a click landing on a road
        // line should still place a fence vertex there — not toggle that
        // road — so let it bubble up to the map's own click handler
        // instead of handling it here.
        if (lassoActiveRef.current) return;
        // v73.102 — same bubble-through as Lasso above: while Turnaround
        // mode is on, a click landing on a road line (very likely, since
        // turnaround points mark the actual end of a road) should place the
        // turnaround marker there, not toggle that road's selection.
        if (turnaroundModeRef.current) return;
        L.DomEvent.stopPropagation(e);
        // v73.22 — Craig: single-click in Deselect mode used to remove the
        // road from the selection immediately — "hard to see exactly what
        // was selected before it disappears" when a road is made of several
        // segments that each need clicking individually. Now it just
        // toggles membership in the same staged-for-removal queue the
        // Ctrl+drag box uses — nothing is actually removed until Delete/
        // Confirm Delete (or cleared via Escape/Cancel). Only meaningful on
        // roads that are actually in the current selection; clicking an
        // unselected road while in Deselect mode does nothing, since there's
        // nothing to stage for removal.
        // v73.94 — "Mark Transit Roads" mode: only meaningful on roads
        // already in the current selection (nothing to mark otherwise);
        // toggles membership in transitRoadIds rather than the selection
        // itself. Checked before Deselect mode so the two click-modes
        // never fight over the same click.
        if (markTransitModeRef.current) {
          if (!isSelected) return;
          setTransitRoadIds(prev => {
            const next = new Set(prev);
            if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
            return next;
          });
          return;
        }
        if (lassoModeRef.current === 'deselect') {
          if (!isSelected) return;
          pushSelectionUndo();
          setStagedForRemovalIds(prev => {
            const next = new Set(prev);
            if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
            stagedForRemovalIdsRef.current = next;
            return next;
          });
          return;
        }
        // Select mode: unchanged — a plain click always toggles just this
        // one road, including deselecting it.
        pushSelectionUndo();
        setSelectedRoadIds(prev => {
          if (prev.includes(f.id)) {
            selectedFeaturesRef.current.delete(f.id);
            return prev.filter(id => id !== f.id);
          }
          selectedFeaturesRef.current.set(f.id, f);
          return [...prev, f.id];
        });
      });
      pl.addTo(layer);
    });
    // v73.29 — "🚩 Set Start Point": while active, drop a small clickable
    // marker at each SELECTED road's two endpoints (not every point along
    // it — a start point is conceptually "which end of the network", not
    // an arbitrary spot mid-road). Clicking one captures it and turns the
    // picker off. If a start point is already chosen, show it as a
    // distinct flag marker instead, so it's clear one's active even after
    // leaving pick mode.
    // v73.31 — Craig specifically asked for a green "A"/red "B" pair, not
    // just a single start flag: relabeled the start marker "A" and added a
    // computed "B" marker at the far end of the resulting chain (run the
    // same merge preview used by Add to Segment, just to read off its last
    // point — nothing is committed by this, it's read-only).
    if (settingStartPoint || settingEndPoint || turnaroundMode) {
      // v73.47 — same clickable-endpoint picker used for both A and B now;
      // which one a click sets depends on which pick mode is active.
      // v73.104 — Craig: turnaround points must use this exact same picker
      // (real road-endpoint nodes only), not a raw map click — reused
      // outright rather than building a second one. Unlike A/B, picking a
      // turnaround does NOT turn the mode off — Craig places several in a
      // row (T1, T2, T3...), so the picker stays up and the next label just
      // increments, until he clicks the toolbar toggle again or Escape.
      const pickLabel = settingStartPoint ? 'A' : settingEndPoint ? 'B' : `T${(turnarounds[activeSegIdx]?.length ?? 0) + 1}`;
      const pickColor = settingStartPoint ? '#059669' : settingEndPoint ? '#dc2626' : '#f97316';
      // v73.106 — Craig: turnaround icons showing up "in places not needed"
      // and OSRM still detouring via extra roads even after placing one.
      // Root cause: this picker was showing a clickable node at BOTH ends of
      // EVERY selected road piece, including interior junctions where one
      // selected piece simply continues into the next (the vast majority of
      // nodes in a multi-road selection). A turnaround only means anything
      // at a genuine dead-end — Craig's own spec (v73.100) was "the actual
      // end of a road" — so those interior junction nodes were never valid
      // targets in the first place; they were just visual clutter it was
      // easy to misclick, planting a turnaround on an interior node instead
      // of the real dead-end tip. That misplaced point then sits nowhere
      // near either true end of a routing gap, so tryOsrmConnect's 60m
      // near-endpoint check never picks it up as a via-point — OSRM falls
      // straight back to its own (unwanted-detour) routing, which is
      // exactly the "as if the turnaround point didn't work" symptom.
      // Fix (turnaround mode only — A/B keep their existing full picker,
      // since mid-selection start/end points are legitimately useful
      // there): drop any endpoint that has another selected piece's
      // endpoint within JUNCTION_TOLERANCE_METRES of it — those are
      // interior junctions, not dead-ends. What's left is only the true
      // outer termini of the current selection.
      const JUNCTION_TOLERANCE_METRES = 8;
      let dedupedEndpoints: { f: RoadFeature; lng: number; lat: number }[] | null = null;
      if (turnaroundMode) {
        const allEndpoints: { f: RoadFeature; lng: number; lat: number }[] = [];
        visibleRoads.forEach(f => {
          if (!selectedSet.has(f.id)) return;
          const eps: [number, number][] = [f.coords[0], f.coords[f.coords.length - 1]];
          eps.forEach(([lng, lat]) => allEndpoints.push({ f, lng, lat }));
        });
        dedupedEndpoints = allEndpoints.filter(({ f: ownF, lng, lat }) =>
          !allEndpoints.some(other =>
            other.f.id !== ownF.id &&
            haversine({ lat, lng }, { lat: other.lat, lng: other.lng }) <= JUNCTION_TOLERANCE_METRES
          )
        );
      }
      const renderEndpoint = (lng: number, lat: number) => {
        const icon = L.divIcon({
          className: '',
          html: `<div style="width:16px;height:16px;border-radius:50%;background:${pickColor};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);cursor:pointer;display:flex;align-items:center;justify-content:center;color:white;font-size:9px;font-weight:800;">${pickLabel}</div>`,
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        });
        const mk = L.marker([lat, lng], { icon, zIndexOffset: 1200 }).addTo(layer);
        mk.bindTooltip(settingStartPoint ? '🚩 Set as start point (A)' : settingEndPoint ? '🏁 Set as end point (B)' : `🔄 Set as ${pickLabel} — real road node, forced OSRM waypoint`, { direction: 'top' });
        mk.on('click', (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e);
          if (settingStartPoint) {
            setManualStartPoint({ lat, lng });
            setSettingStartPoint(false);
          } else if (settingEndPoint) {
            setManualEndPoint({ lat, lng });
            setSettingEndPoint(false);
          } else {
            const idx = activeSegIdx;
            const next: TurnaroundPoint = { id: uid(), type: 'turnaround', lat, lng };
            const updatedT = turnarounds.map((t, ti) => ti === idx ? [...t, next] : t);
            onTurnaroundsChange?.(updatedT);
            // Deliberately NOT turning turnaroundMode off — stays active
            // for the next T marker, same as the toolbar description says.
          }
        });
      };
      if (turnaroundMode) {
        (dedupedEndpoints || []).forEach(({ lng, lat }) => renderEndpoint(lng, lat));
      } else {
        visibleRoads.forEach(f => {
          if (!selectedSet.has(f.id)) return;
          const endpoints: [number, number][] = [f.coords[0], f.coords[f.coords.length - 1]];
          endpoints.forEach(([lng, lat]) => renderEndpoint(lng, lat));
        });
      }
    }
    if (!settingStartPoint && manualStartPoint) {
      const aIcon = L.divIcon({
        className: '',
        html: `<div style="width:20px;height:20px;border-radius:50%;background:#059669;border:3px solid white;box-shadow:0 1px 5px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:800;">A</div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      });
      L.marker([manualStartPoint.lat, manualStartPoint.lng], { icon: aIcon, zIndexOffset: 1200 })
        .addTo(layer)
        .bindTooltip('Start point (A) — this is where the new selection will begin', { direction: 'top' });
    }
    // v73.47 — if B has been explicitly picked, always show it as a fixed
    // flag at that exact spot (never overridden by the computed preview).
    // Otherwise, once A is set, fall back to the old read-only computed
    // preview of where B would land given A alone — still useful when the
    // user only cares about A and is happy to let the far end fall out
    // naturally.
    if (!settingEndPoint && manualEndPoint) {
      const bIcon = L.divIcon({
        className: '',
        html: `<div style="width:20px;height:20px;border-radius:50%;background:#dc2626;border:3px solid white;box-shadow:0 1px 5px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:800;">B</div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      });
      L.marker([manualEndPoint.lat, manualEndPoint.lng], { icon: bIcon, zIndexOffset: 1200 })
        .addTo(layer)
        .bindTooltip('End point (B) — this is where the new selection will finish', { direction: 'top' });
    } else if (!settingStartPoint && !settingEndPoint && manualStartPoint && !manualEndPoint) {
      const previewFeatures = selectedRoadIds
        .map(id => selectedFeaturesRef.current.get(id))
        .filter((f): f is RoadFeature => !!f);
      if (previewFeatures.length > 0) {
        const previewChain = mergeRoadFeaturesIntoPath(previewFeatures, undefined, manualStartPoint);
        const endPt = previewChain[previewChain.length - 1];
        if (endPt && previewChain.length > 1) {
          const bIcon = L.divIcon({
            className: '',
            html: `<div style="width:20px;height:20px;border-radius:50%;background:#dc2626;border:3px solid white;box-shadow:0 1px 5px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:800;">B</div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          });
          L.marker([endPt.lat, endPt.lng], { icon: bIcon, zIndexOffset: 1200 })
            .addTo(layer)
            .bindTooltip('End point (B) — where the new selection ends up, given A (not set manually — click 🏁 Set End Point to pin it exactly)', { direction: 'top' });
        }
      }
    }
  }, [visibleRoads, selectedRoadIds, editorMode, activeSegIdx, segmentColors, stagedForRemovalIds, settingStartPoint, manualStartPoint, settingEndPoint, manualEndPoint, addAsTransit, transitRoadIds, turnaroundMode, turnarounds, onTurnaroundsChange]);

  // v73.14: Render the in-progress lasso fence — a polygon (or open line
  // while under 3 points) connecting lassoVertices, plus a draggable marker
  // per vertex. Drag updates a live preview directly on the shape/marker
  // (no React state change mid-drag — committing to state on every 'drag'
  // tick would rebuild this effect and destroy the marker mid-gesture,
  // breaking Leaflet's drag tracking the same way rebuildAll() would for a
  // segment point, per the existing warning on that code path). The
  // position is only committed to state on 'dragend'. Clicking a vertex
  // marker removes just that point.
  useEffect(() => {
    const layer = lassoFenceLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (editorMode !== 'select' || lassoVertices.length === 0) return;
    // v73.15: fence-in-progress also uses the active segment's colour, same
    // reasoning as the selected-road overlay above.
    // v73.16: except in Deselect mode, where it's always drawn red so it's
    // visually unmistakable that confirming will REMOVE roads, not add them.
    const activeSegColor = lassoModeRef.current === 'deselect' ? '#dc2626' : (segmentColorsRef.current[activeIdxRef.current] || colorRef.current);
    const latlngs = lassoVertices.map(p => [p.lat, p.lng] as [number, number]);
    const shape = lassoVertices.length >= 3
      ? L.polygon(latlngs, { color: activeSegColor, weight: 2, fillOpacity: 0.12, dashArray: '5 5' })
      : L.polyline(latlngs, { color: activeSegColor, weight: 2, dashArray: '5 5' });
    shape.addTo(layer);
    const markers: L.Marker[] = [];
    lassoVertices.forEach((p, i) => {
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:14px;height:14px;border-radius:50%;background:${activeSegColor};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);cursor:move;"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      const marker = L.marker([p.lat, p.lng], { icon, draggable: true, zIndexOffset: 1000 }).addTo(layer);
      markers.push(marker);
      marker.on('drag', () => {
        shape.setLatLngs(markers.map(m => m.getLatLng()));
      });
      marker.on('dragend', () => {
        const ll = marker.getLatLng();
        setLassoVertices(prev => prev.map((pt, pi) => pi === i ? { lat: ll.lat, lng: ll.lng } : pt));
      });
      marker.on('click', (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        setLassoVertices(prev => prev.filter((_, pi) => pi !== i));
      });
      // v73.74 — Craig: "right click delete point in lasso fence not
      // working." Real gap, not a bug in existing code — this marker only
      // ever had a left-click delete handler, no contextmenu handler at
      // all, so right-clicking genuinely did nothing (not misfiring,
      // simply nothing was listening). Draw Points' own vertex markers use
      // right-click-to-delete as their convention, so trying that here on
      // muscle memory is completely reasonable — added the same handler
      // here too. Left-click-to-delete (existing, matches the on-screen
      // instructions text below) still works exactly as before — this is
      // purely additive, not a replacement.
      marker.on('contextmenu', (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        L.DomEvent.preventDefault(e.originalEvent);
        setLassoVertices(prev => prev.filter((_, pi) => pi !== i));
      });
      marker.bindTooltip(`Point ${i + 1} — drag to adjust, click or right-click to remove`, { direction: 'top' });
    });

    // v73.24 — Craig: "enable adding additional points to refine the lasso
    // selection area after initial creation." Small insert-circle at the
    // midpoint of each edge (and the closing edge back to point 1, once
    // there are enough points to actually be a closed polygon) — click one
    // to splice a new vertex in at that position, same "small circles
    // insert points" pattern Draw Points already uses for segment edges.
    const edgeCount = lassoVertices.length >= 3 ? lassoVertices.length : lassoVertices.length - 1;
    for (let i = 0; i < edgeCount; i++) {
      const a = lassoVertices[i];
      const b = lassoVertices[(i + 1) % lassoVertices.length];
      const midLat = (a.lat + b.lat) / 2, midLng = (a.lng + b.lng) / 2;
      const insertAt = i + 1; // splices in right after vertex i
      const midIcon = L.divIcon({
        className: '',
        html: `<div style="width:9px;height:9px;border-radius:50%;background:white;border:2px solid ${activeSegColor};box-shadow:0 1px 3px rgba(0,0,0,0.35);cursor:copy;"></div>`,
        iconSize: [9, 9],
        iconAnchor: [4, 4],
      });
      const midMk = L.marker([midLat, midLng], { icon: midIcon, zIndexOffset: 900 }).addTo(layer);
      midMk.on('click', (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        setLassoVertices(prev => {
          const copy = [...prev];
          copy.splice(insertAt, 0, { lat: midLat, lng: midLng });
          return copy;
        });
      });
      midMk.bindTooltip('➕ Add fence point here', { direction: 'top', offset: [0, -6] });
    }
  }, [lassoVertices, editorMode, activeSegIdx, segmentColors, lassoMode]);

  // Confirm: select every road with a point inside the fence, then clear it
  // and drop back into single-click select mode. Cancel: discard the fence
  // without selecting anything, staying in Lasso mode so it can be redrawn.
  const confirmLassoFence = () => {
    if (lassoVerticesRef.current.length < 3) return;
    const polygonPts: [number, number][] = lassoVerticesRef.current.map(p => [p.lat, p.lng]);
    // v73.43: vertex-in-polygon catches most roads, but a road whose line
    // crosses the fence without any vertex actually landing inside it
    // (long/sparse edges) was silently missed — see segmentIntersectsPolygon
    // above. Checked second (cheaper) rather than first, since most roads
    // that match do so via a vertex and the edge check is a road-length
    // loop per candidate.
    const hit = visibleRoadsRef.current.filter(f => {
      if (f.coords.some(([lng, lat]) => pointInPolygon([lat, lng], polygonPts))) return true;
      for (let i = 0; i < f.coords.length - 1; i++) {
        const a: [number, number] = [f.coords[i][1], f.coords[i][0]];
        const b: [number, number] = [f.coords[i + 1][1], f.coords[i + 1][0]];
        if (segmentIntersectsPolygon(a, b, polygonPts)) return true;
      }
      return false;
    });
    // v73.80 — Craig: a fence that accidentally covers way more than
    // intended (mis-closed shape, or confirming while paused mid-drag)
    // used to select/deselect everything inside it with zero warning —
    // reported as "it selected every road" with no easy way back. Any
    // fence about to touch a large number of roads now confirms first;
    // small, deliberate fences (the normal case) are completely
    // unaffected.
    const LASSO_CONFIRM_THRESHOLD = 60;
    if (hit.length > LASSO_CONFIRM_THRESHOLD) {
      const verb = lassoModeRef.current === 'deselect' ? 'remove' : 'select';
      const proceed = window.confirm(
        `This fence would ${verb} ${hit.length} roads — that's a lot. Continue?\n\n` +
        `Cancel to back out and adjust the fence instead.`
      );
      if (!proceed) {
        lassoVerticesRef.current = [];
        setLassoVertices([]);
        setLassoActive(false);
        return;
      }
    }
    if (hit.length > 0) {
      pushSelectionUndo();
      if (lassoModeRef.current === 'deselect') {
        hit.forEach(f => selectedFeaturesRef.current.delete(f.id));
      } else {
        hit.forEach(f => selectedFeaturesRef.current.set(f.id, f));
      }
      setSelectedRoadIds(prev => {
        const set = new Set(prev);
        if (lassoModeRef.current === 'deselect') {
          hit.forEach(f => set.delete(f.id));
        } else {
          hit.forEach(f => set.add(f.id));
        }
        return Array.from(set);
      });
    }
    lassoVerticesRef.current = [];
    setLassoVertices([]);
    setLassoActive(false);
  };
  const cancelLassoFence = () => {
    lassoVerticesRef.current = [];
    setLassoVertices([]);
  };
  // v73.43 — Craig: "need also a undo button for lasso mode to undo a point
  // or be able to delete a point." Clicking directly on a placed vertex to
  // remove it already worked (see the marker's contextmenu handler below),
  // but that requires an accurate tap on a small marker — fiddly in the
  // field on a touchscreen, especially for the most recent point while
  // still actively placing more. This removes the single most-recently-
  // placed point, one tap per undo, without needing to hit a marker at all.
  const undoLastLassoPoint = () => {
    if (lassoVerticesRef.current.length === 0) return;
    const next = lassoVerticesRef.current.slice(0, -1);
    lassoVerticesRef.current = next;
    setLassoVertices(next);
  };

  // v73.94 — runs ONE batch of features (either the normal-pass subset or
  // the individually-marked-transit subset of the current selection)
  // through the exact same pipeline addSelectedRoadsToSegment always used
  // for its single whole-selection chain: gap-fill, OSRM-first snap
  // (mandatory since v73.77, falls back to road-data only if OSRM can't
  // resolve it and the user explicitly proceeds), Douglas-Peucker
  // simplify, the A/B confirm popup, offset, and (for the transit batch)
  // transitAfter tagging on every edge. Returns the new chain to merge
  // onto `existingChain`, or 'cancel' if the user backed out of a prompt
  // partway through — extracted out of addSelectedRoadsToSegment so the
  // exact same tested logic can run twice in one commit (normal roads,
  // then transit roads) instead of being duplicated by hand.
  const runSelectRoadsBatch = async (
    features: RoadFeature[],
    existingChain: RoadPoint[],
    isTransit: boolean,
  ): Promise<RoadPoint[] | 'cancel'> => {
    if (features.length === 0) return existingChain;
    // Chain the newly-selected roads on TRUE (unoffset) coordinates — v73.33:
    // offsetting is no longer baked into this step, see the function's own
    // comment. Chaining should happen on the real road geometry regardless
    // of what offset (if any) gets applied afterward.
    // v73.29: manualStartPoint (if set via "🚩 Set Start Point") seeds where
    // this new chain begins — only meaningful here, on the fresh selection,
    // not on the second merge below that attaches onto whatever's already
    // drawn (an existing chain always wins over a manual pick, see the
    // function itself).
    // v73.111 — Strict mode now tries the real graph+Dijkstra traversal
    // FIRST (see traverseSelectedGraphOrdered above): a genuine fix for
    // Craig's "too much repeated travel" report, not just the extra-roads
    // one. Falls back to the old nearest-endpoint chainer only if the graph
    // traversal can't run at all (graph too large, or A/B/turnarounds land
    // on disconnected pieces of the selection) — never silently produces
    // nothing.
    let rawChain: RoadPoint[];
    let repeatedEdgeCount = 0;
    let usedGraphTraversal = false;
    let traversalFallbackReason: string | null = null;
    if (strictSelectedRoadsOnlyRef.current) {
      const graph = buildSelectedRoadGraph(features);
      const firstFeature = features[0];
      const lastFeature = features[features.length - 1];
      const startP: RoadPoint | undefined = manualStartPointRef.current
        || (firstFeature ? { lng: firstFeature.coords[0][0], lat: firstFeature.coords[0][1] } : undefined);
      const endP: RoadPoint | undefined = manualEndPointRef.current
        || (lastFeature ? { lng: lastFeature.coords[lastFeature.coords.length - 1][0], lat: lastFeature.coords[lastFeature.coords.length - 1][1] } : undefined);
      const waypoints = (turnaroundsRef.current[activeIdxRef.current] || []).map(t => ({ lat: t.lat, lng: t.lng }));
      const traversal = (startP && endP)
        ? traverseSelectedGraphOrdered(graph, startP, waypoints, endP)
        : null;
      // v73.114 — Craig: the legacy mergeRoadFeaturesIntoPath fallback below
      // was completely silent — no console line, no UI message — so a
      // fallback (which is NOT junction-aware and can produce
      // overlapping/duplicated lines at corners, per the v73.111 changelog)
      // looked identical in the console to a clean graph-traversal run.
      // Work out *why* it's about to fall back, before it does, so both the
      // console and the on-map banner can say so explicitly instead of
      // this being invisible.
      if (!traversal) {
        if (!startP || !endP) {
          traversalFallbackReason = 'no start/end point resolved (no selected features and no manual A/B set)';
        } else if (graph.nodes.size > GRAPH_TRAVERSAL_MAX_NODES) {
          traversalFallbackReason = `selected graph too large (${graph.nodes.size} nodes, limit ${GRAPH_TRAVERSAL_MAX_NODES})`;
        } else {
          traversalFallbackReason = 'start/end not connected within the selected-road graph (disconnected selection)';
        }
        console.warn(
          `⚠️ [Add to Segment] Graph traversal FAILED — falling back to the legacy nearest-endpoint chainer (mergeRoadFeaturesIntoPath), which has no concept of shared junction nodes and can produce overlapping/duplicated lines at corners.\nReason: ${traversalFallbackReason}`
        );
      }
      if (traversal) {
        rawChain = traversal.points;
        usedGraphTraversal = true;
        for (const count of traversal.edgeUseCounts.values()) { if (count > 1) repeatedEdgeCount++; }
        // v73.112 — Craig-requested diagnostics: exactly which edges make up
        // the final distance and why, so a still-too-long result is
        // debuggable from this log instead of guesswork. uniqueM = each
        // selected edge counted once regardless of traversal count (the
        // true minimum, ignoring unavoidable turnaround retraces);
        // turnaroundReturnM = the mirrored branch-return distance (expected,
        // required repetition); otherRepeatedM = any edge used more than
        // its 'expected' count for its reason (main-spine or branch-out
        // used >1x, or turnaround-return count mismatched with its
        // branch-out) — this should be ~0; a nonzero value here means a
        // real bug, not a required retrace.
        {
          const expectedCount = new Map<string, number>();
          for (const s of traversal.steps) {
            const bump = s.reason === 'turnaround-return' ? 0 : 1; // return mirrors its branch-out 1:1, doesn't add to "expected"
            expectedCount.set(s.edgeId, (expectedCount.get(s.edgeId) ?? 0) + (s.reason === 'branch-out' || s.reason === 'main-spine' ? 1 : 0));
            void bump;
          }
          let totalM = 0, uniqueM = 0, turnaroundReturnM = 0, otherRepeatedM = 0;
          const seen = new Set<string>();
          const report = traversal.steps.map(s => {
            totalM += s.lengthM;
            if (s.reason === 'turnaround-return') turnaroundReturnM += s.lengthM;
            if (!seen.has(s.edgeId)) { seen.add(s.edgeId); uniqueM += s.lengthM; }
            return s;
          });
          for (const [eid, count] of traversal.edgeUseCounts) {
            const exp = expectedCount.get(eid) ?? 1;
            const hasReturn = report.some(s => s.edgeId === eid && s.reason === 'turnaround-return');
            const allowedCount = exp + (hasReturn ? 1 : 0);
            if (count > allowedCount) {
              const e = graph.edges.get(eid)!;
              otherRepeatedM += e.dist * (count - allowedCount);
            }
          }
          console.log(`[traverseSelectedGraphOrdered] total=${(totalM / 1000).toFixed(2)}km unique=${(uniqueM / 1000).toFixed(2)}km turnaround-return=${(turnaroundReturnM / 1000).toFixed(2)}km other-repeated=${(otherRepeatedM / 1000).toFixed(2)}km (should be ~0)`);
          if (otherRepeatedM > 1) {
            console.table(traversal.steps
              .filter(s => (traversal.edgeUseCounts.get(s.edgeId) ?? 0) > ((expectedCount.get(s.edgeId) ?? 1) + (report.some(x => x.edgeId === s.edgeId && x.reason === 'turnaround-return') ? 1 : 0)))
              .map(s => ({ edgeId: s.edgeId, road: s.roadName, lengthM: Math.round(s.lengthM), reason: s.reason, from: s.from, to: s.to })));
          }
        }
      } else {
        rawChain = mergeRoadFeaturesIntoPath(features, undefined, manualStartPointRef.current, 0, manualEndPointRef.current);
      }
    } else {
      rawChain = mergeRoadFeaturesIntoPath(features, undefined, manualStartPointRef.current, 0, manualEndPointRef.current);
    }
    // v73.34 — before doubling/offsetting, try to replace any straight
    // "flight line" gap between two selected pieces that don't actually
    // touch with a real road-network path (host-server's new
    // /api/roads/connect). Falls back to leaving the gap as a straight line
    // for any edge it can't resolve — never blocks the merge.
    // v73.110 — Craig: this real-road gap-fill routes through OSRM/road-data
    // covering the WHOLE network, not just selected roads — exactly the
    // "extra unwanted roads" complaint. In Strict mode, skip it entirely:
    // gaps stay as straight lines (the pre-v73.34 fallback, already an
    // honest, understood behaviour — never silently substitutes unselected
    // road geometry) instead of being bridged with real-but-unselected roads.
    const gapCountForLog = (() => {
      let n = 0;
      for (let i = 0; i < rawChain.length - 1; i++) {
        if (haversine(rawChain[i], rawChain[i + 1]) >= ROAD_CONNECT_GAP_THRESHOLD_METRES) n++;
      }
      return n;
    })();
    setRoutingGaps(true);
    let newChain: RoadPoint[];
    let gapsBridgedWithUnselectedRoads = 0;
    try {
      if (strictSelectedRoadsOnlyRef.current) {
        newChain = rawChain;
        gapsBridgedWithUnselectedRoads = 0; // deliberately not called — see comment above
      } else {
        // v73.101 — same active-segment turnaround markers used by the /match
        // snap below, now also passed to gap-fill so a placed marker helps
        // regardless of which path (gap-fill vs. Snap to Roads) actually
        // handles a given selection.
        newChain = await fillGapsWithRealRoads(
          rawChain, syncServerUrlRef.current, syncTokenRef.current, buildIncludeParams(),
          (turnaroundsRef.current[activeIdxRef.current] || []).map(t => ({ lat: t.lat, lng: t.lng }))
        );
        gapsBridgedWithUnselectedRoads = gapCountForLog; // best-effort count — see debug log below for the honest caveat
      }
    } finally {
      setRoutingGaps(false);
    }
    // v73.45 — Craig, two screenshots: a single Select-Roads addition
    // producing 2228+ points for one segment, and a second showing dense
    // clusters of extra points sitting off to the side of the actual
    // selected route ("extra Points for lane's and roads not selected").
    // Root cause: v73.37 only ever simplified the GAP-FILL detour spliced
    // in by fillGapsWithRealRoads above — every selected road PIECE itself
    // (rawChain, from mergeRoadFeaturesIntoPath) kept its full, unthinned
    // OSM survey-vertex density the whole time, since roads.geojson's
    // extract carries a vertex at every recorded survey point along a way,
    // not just at real turns/intersections. Selecting several ordinary
    // streets (screenshot 2's whole-neighbourhood lasso) accumulates that
    // raw density across every one of them, and dense vertex clusters near
    // bends/junctions on adjacent parallel ways (e.g. a divided road's two
    // carriageways surveyed as separate close-together ways) are exactly
    // what reads as "extra points on roads not selected" in screenshot 1 —
    // they're real vertices on the selected way, just visually close to a
    // neighbouring unselected one. Simplifying newChain as a whole (same
    // Douglas-Peucker helper and 1.5m tolerance already trusted for the
    // gap-fill detours, so no new visual behaviour, just applied
    // consistently everywhere instead of only at gaps) removes the
    // near-collinear survey vertices from the selected pieces too, without
    // changing the route's actual shape at anything above 1.5m of
    // deviation. First/last points are always preserved exactly (the
    // function's own guarantee), so this can't break the endpoint-based
    // chaining `mergeRoadFeaturesIntoPath` does immediately below.
    if (newChain.length > 2) {
      newChain = simplifyPath(newChain, 1.5);
    }
    // v73.75 — Craig: "Snap to Road should work when add segment button is
    // pushed... doing it after is creating extra work and confusion."
    // (Confirmed this means "✓ Add to Segment" — "+ Add Segment" just opens
    // a new empty segment tab, there's nothing yet to snap when THAT'S
    // pushed.) Best-effort, silent, non-blocking: if OSRM is configured,
    // snap this chain onto real road geometry right here, before it's ever
    // shown to the user or offset into a sweepBothSides pair, instead of
    // making them notice the result looks rough afterward and go find the
    // separate button. Deliberately NOT the same confirm-dialog/undo-stack
    // path the manual button uses — this runs before anything's on the
    // segment yet, so there's nothing to confirm or undo TO. Silently keeps
    // the un-snapped chain on any failure (no OSRM configured, network
    // error, no match) — this is a nice-to-have polish step, not something
    // that should ever block or alarm the user if it doesn't work.
    // v73.77 — Craig: "I want the OSRM auto-snap to be default and used
    // every time segments are added, as road data adds the extra lines and
    // points." Confirms the theory from v73.76's diagnostic message —
    // road-data/gap-fill chaining IS the source of the extra-lines problem,
    // not a red herring. Changed from "try silently, fall back silently on
    // any failure" to "try, and if it fails, ASK before proceeding with the
    // road-data chain instead of silently using it" — OSRM is now the
    // default path every time, and using the fallback is now something
    // Craig actively chooses in the moment (with the specific reason why
    // OSRM didn't run shown in the confirm dialog) rather than something
    // that just quietly happens to him.
    if (strictSelectedRoadsOnlyRef.current) {
      // v73.110 — Craig: OSRM's /match snaps against the FULL routable
      // graph, not anything restricted to selected roads — the other half
      // of the "extra unwanted roads" complaint alongside gap-fill above.
      // Strict mode skips it entirely: newChain stays exactly the selected
      // pieces' own coordinates (from the graph traversal above, or the old
      // chainer as its fallback — either way, never reads outside
      // features[].coords, confirmed no fetch/network call in either path),
      // simplified for point-density only, never re-geometried by OSRM.
      const parts: string[] = [];
      if (usedGraphTraversal) parts.push('routed through the selected-road graph');
      else parts.push(`⚠️ fell back to the legacy chainer (${traversalFallbackReason}) — not junction-aware, check corners for overlapping/duplicate lines`);
      if (gapCountForLog > 0 && !usedGraphTraversal) parts.push(`${gapCountForLog} gap${gapCountForLog === 1 ? '' : 's'} between selected pieces left as a straight line`);
      if (repeatedEdgeCount > 0) parts.push(`${repeatedEdgeCount} stretch${repeatedEdgeCount === 1 ? '' : 'es'} necessarily retraced (dead-end/branch — see console for exactly which)`);
      if (parts.length > 0) {
        setSnapMessage(`Added using selected roads only (Strict mode) — ${parts.join('; ')}${gapCountForLog > 0 ? ' (turn Strict mode off to bridge gaps with real roads instead)' : ''}`);
        setTimeout(() => setSnapMessage(''), 9000);
      }
    } else if (newChain.length > 2) {
      if (!syncServerUrlRef.current) {
        const proceed = window.confirm(
          'No sync server configured — OSRM Snap to Roads needs one (see host-server/OSRM_SETUP_GUIDE.md).\n\n' +
          'Without it, this segment will be added using the raw road-data chain, which is what has been causing extra lines/points.\n\n' +
          'Add it anyway using road data? (Cancel to stop and set up OSRM first)'
        );
        if (!proceed) { return 'cancel'; }
        setSnapMessage('Added using road data (no sync server configured)');
      } else {
        try {
          const resp = await fetch(`${syncServerUrlRef.current}/api/roads/match`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Sync-Token': syncTokenRef.current },
            body: JSON.stringify({
              points: newChain.map(p => ({ lat: p.lat, lng: p.lng })),
              // v73.100 — same turnaround-radius hint as the manual Snap to
              // Roads call above, applied to the active segment being built.
              turnarounds: (turnaroundsRef.current[activeIdxRef.current] || []).map(t => ({ lat: t.lat, lng: t.lng })),
              ...buildIncludeFlagsBody(),
            }),
          });
          const data = await resp.json();
          if (resp.ok && data.ok && Array.isArray(data.points) && data.points.length > 1) {
            // v73.82 — data.points comes back from OSRM with no idea any of
            // this chain had streetName tags at all (see the "Split Segment
            // by Street" architecture note at retagSnappedPoints). Re-attach
            // them against the pre-snap chain (still holds every tag
            // mergeRoadFeaturesIntoPath/fillGapsWithRealRoads assigned) by
            // nearest-neighbour before overwriting newChain.
            newChain = retagSnappedPoints(data.points, newChain);
            // v73.85 — same honesty fix: report every raw-fallback batch,
            // not just the excluded-road subset.
            const totalRaw = data.rawFallbackBatches ?? data.excludedRoadRejections ?? 0;
            setSnapMessage(`Auto-snapped to roads: ${data.before} → ${data.after} points${totalRaw ? ` — ⚠️ ${totalRaw} stretch${totalRaw === 1 ? '' : 'es'} could NOT be snapped and kept raw/unsnapped points (run 🛰️ Snap to Roads again after reviewing, or check the server log for why)` : ''}`);
          } else {
            const reason = data.error || data.message || resp.statusText;
            const proceed = window.confirm(
              `OSRM did not return a match (${reason}).\n\n` +
              'Add this segment using the raw road-data chain instead? This is what has been causing extra lines/points — Cancel to stop without adding anything.'
            );
            if (!proceed) { return 'cancel'; }
            setSnapMessage(`Added using road data (OSRM did not return a match: ${reason})`);
          }
        } catch (e: any) {
          const reason = e?.message || 'network error';
          const proceed = window.confirm(
            `OSRM is unreachable (${reason}) — is the osrm Docker service running?\n\n` +
            'Add this segment using the raw road-data chain instead? This is what has been causing extra lines/points — Cancel to stop without adding anything.'
          );
          if (!proceed) { return 'cancel'; }
          setSnapMessage(`Added using road data (OSRM unreachable: ${reason})`);
        }
      }
      setTimeout(() => setSnapMessage(''), 6000);
    }
    // v73.46 — Craig: "need a pop up to say set where you want the A start
    // point and the B end point to be after clicking the add segment
    // button." The chain so far is built by nearest-endpoint chaining
    // (mergeRoadFeaturesIntoPath) plus manualStartPoint if one was set —
    // reasonable defaults, but not always what a crew actually wants swept
    // first. Pausing here to show exactly where A and B landed and letting
    // the user reverse before it's merged in means a wrong direction is a
    // one-click fix now instead of a right-click-through-every-point fix
    // (or the toolbar's whole-segment Reverse Points button) after the
    // fact. Skipped entirely for a 0-1 point result — nothing meaningful
    // to confirm.
    if (newChain.length > 1) {
      const userChoice = await new Promise<boolean | null>(resolve => {
        setPendingAddSegment({ chain: newChain, resolve });
      });
      setPendingAddSegment(null);
      if (userChoice === null) return 'cancel'; // cancelled — nothing added, selection left as-is
      if (userChoice === true) newChain = newChain.slice().reverse();
    }
    let loopChain: RoadPoint[];
    const addingAsTransit = isTransit;
    // v73.82 — offsetPerpendicular only ever takes/returns bare [lng,lat]
    // tuples, so every streetName tag newChain is carrying at this point
    // (from mergeRoadFeaturesIntoPath, possibly re-attached post-OSRM-snap
    // above) would otherwise be silently dropped the instant it's rebuilt
    // into a plain {lat,lng} object below. offsetPerpendicular is
    // guaranteed 1:1 index-preserving (see its own comment), so tags can be
    // safely re-zipped back on by index afterward.
    const newChainTags = newChain.map(p => p.streetName || '');
    if (sweepBothSides && newChain.length > 1 && !addingAsTransit) {
      // v73.33 — two genuinely separate lateral passes, one each side of the
      // TRUE centreline, replacing the old "same coordinates forward then
      // backward" (never actually offset apart) plus the removed manual
      // Offset slider. Left pass out, right pass back — forms a proper
      // closed there-and-back loop the same way the old version did
      // structurally, just no longer coincident with itself.
      const rawCoords = newChain.map(p => [p.lng, p.lat] as [number, number]);
      const leftCoords = offsetPerpendicular(rawCoords, -SWEEP_BOTH_SIDES_OFFSET_METRES);
      const rightCoords = offsetPerpendicular(rawCoords, SWEEP_BOTH_SIDES_OFFSET_METRES);
      const leftPts: RoadPoint[] = leftCoords.map(([lng, lat], i) => newChainTags[i] ? { lat, lng, streetName: newChainTags[i] } : { lat, lng });
      const rightPts: RoadPoint[] = rightCoords.map(([lng, lat], i) => newChainTags[i] ? { lat, lng, streetName: newChainTags[i] } : { lat, lng });
      loopChain = [...leftPts, ...rightPts.reverse()];
    } else {
      // Single pass: small fixed cosmetic offset off the OSM centreline so
      // the line doesn't sit directly on top of the street-name label. Also
      // the path taken for a transit addition (v73.75) — a connector road
      // is driven once, not swept both sides, same as any other transit run.
      const rawCoords = newChain.map(p => [p.lng, p.lat] as [number, number]);
      loopChain = offsetPerpendicular(rawCoords, ROAD_LABEL_OFFSET_METRES).map(([lng, lat], i) => newChainTags[i] ? { lat, lng, streetName: newChainTags[i] } : { lat, lng });
    }
    // v73.75 — mark every edge of this addition transit, if the toggle was
    // on. Last point deliberately left untouched (transitAfter describes
    // the edge FROM that point, so the final point of the addition has
    // nothing after it yet — whatever gets chained on next, sweep or
    // transit, decides its own transitAfter independently).
    if (addingAsTransit) {
      loopChain = loopChain.map((p, i) => i < loopChain.length - 1 ? { ...p, transitAfter: true } : p);
    }
    // Wrap the (possibly looped) new chain as a single pseudo-feature and
    // reuse the same tested nearest-endpoint chaining logic to attach it
    // onto whatever's already drawn on this segment, in whichever order
    // (start or end) actually fits.
    // v73.82 — this pseudo-feature previously always used `name: ''` for
    // the WHOLE addition, which meant mergeRoadFeaturesIntoPath's own
    // pieceTags step (see its comment) tagged every point in loopChain with
    // an empty street name unconditionally — silently erasing whatever real
    // per-street tags loopChain had just carried through the offset step
    // above, on every single "Add to Segment"/"Add as Transit" call. That
    // made "Split Segment by Street" only ever work on a segment nothing
    // had ever been added to via Select Roads/Lasso, which is effectively
    // never in real use. `pointNames` (new field, see RoadFeature) carries
    // the real per-point tags through this wrap-and-rechain step instead;
    // `name: ''` is kept only as the correct fallback for any point that
    // genuinely has no tag (gap-fill detours, hand-drawn existingChain).
    const loopFeature: RoadFeature = {
      id: '__select_roads_addition__',
      name: '',
      coords: loopChain.map(p => [p.lng, p.lat] as [number, number]),
      pointNames: loopChain.map(p => p.streetName || ''),
      // v73.99 — Bug #6 fix ("Transit Road Type Lost After Add Segment"):
      // loopChain already carries the real transitAfter flags set just
      // above (from markedTransit/addAsTransit) — this is what makes sure
      // they actually reach the committed segment instead of silently
      // being dropped by the wrap-and-rechain step. See RoadFeature's
      // `pointTransit` comment.
      pointTransit: loopChain.map(p => p.transitAfter === true),
    };
    // v73.33 — loopChain above is already fully offset (either the
    // symmetric left/right pair or the single cosmetic nudge); this merge
    // just chains it onto `existingChain` with zero further offsetting,
    // same as before, just no longer relying on remembering to pass 0 —
    // it's the function's own default now.
    return mergeRoadFeaturesIntoPath([loopFeature], existingChain);
  };

  // "Add to Segment" — merges every currently-selected road into one ordered
  // path and appends it to the active segment (chaining onto whatever's
  // already been drawn by hand, if anything), then drops back into normal
  // Draw Points mode so the result can be adjusted with the usual
  // drag/transit-toggle/delete tools — no separate edit path for it.
  //
  // v73.15: when sweepBothSides is on (default), the newly-selected roads
  // are chained into an out-and-back loop (forward chain, then the same
  // chain reversed back to its start) BEFORE being merged onto whatever's
  // already on the segment — matching the km convention hand-drawn segments
  // already use (see the sweepBothSides state comment above). The result is
  // still a completely ordinary RoadPoint[] afterward — ordinary points, no
  // special flag — so transit-toggling and adding/dragging extra points
  // works exactly the same as any hand-drawn segment, immediately.
  //
  // v73.94 — the selection is now split into a normal-pass subset and an
  // individually-marked-transit subset (via "Mark Transit Roads" mode) and
  // run through runSelectRoadsBatch as two sequential batches — normal
  // roads merged first, then the transit roads chained onto the result.
  // The old whole-selection "Add as Transit" toggle still works exactly as
  // before for a selection with no individually-marked roads (transit
  // subset is just the whole selection, normal subset is empty).
  const addSelectedRoadsToSegment = async () => {
    // v73.18: was `visibleRoads.filter(...)` — broke for any selection built
    // up across more than one map viewport (panning between picks, which is
    // completely normal usage). Read from the persistent cache instead,
    // which was populated at the moment each road was actually selected and
    // isn't affected by the map having moved on since.
    const selectedFeatures = selectedRoadIds
      .map(id => selectedFeaturesRef.current.get(id))
      .filter((f): f is RoadFeature => !!f);
    if (selectedFeatures.length === 0) return;
    const idx = activeIdxRef.current;
    const originalExisting = (liveSegsRef.current[idx]) || [];
    const markedTransit = transitRoadIdsRef.current;
    // Whole-selection "Add as Transit" toggle (unchanged behaviour): if
    // it's on, everything not individually marked is ALSO transit — the
    // toggle still means "treat this whole batch as transit" when no
    // per-road marks are in play, exactly as before v73.94.
    const transitFeatures = addAsTransitRef.current
      ? selectedFeatures
      : selectedFeatures.filter(f => markedTransit.has(f.id));
    const normalFeatures = addAsTransitRef.current
      ? []
      : selectedFeatures.filter(f => !markedTransit.has(f.id));

    const afterNormal = await runSelectRoadsBatch(normalFeatures, originalExisting, false);
    if (afterNormal === 'cancel') { setAddAsTransit(false); return; }
    const afterTransit = await runSelectRoadsBatch(transitFeatures, afterNormal, true);
    // If the transit batch was cancelled partway through (an OSRM/A-B
    // confirm the user backed out of), keep whatever the normal batch
    // already produced rather than discarding real, already-confirmed
    // work — the transit roads simply stay selected/marked for another
    // attempt instead of vanishing.
    const merged = afterTransit === 'cancel' ? afterNormal : afterTransit;
    setAddAsTransit(false);
    // v73.111 — Craig's requested debug log, run every time regardless of
    // strict mode so both of us can see the actual routing decision instead
    // of guessing from a screenshot. "Unselected-looking points" is a
    // DISTANCE check (≥6m from every selected-feature vertex), not an exact
    // coordinate match — every point here has already been through
    // offsetPerpendicular's ~2.5m cosmetic/sweep-both-sides offset by this
    // point (see the offset step just above this function), so an exact
    // match would falsely flag literally every point. 6m tolerates that
    // offset while still catching genuine excursions onto a different,
    // unselected street (which run many metres away, not ~2.5m).
    try {
      const selectedWayIds = selectedFeatures.map(f => f.id);
      const debugGraph = buildSelectedRoadGraph(selectedFeatures);
      const selectedCoordFlat: RoadPoint[] = [];
      for (const f of selectedFeatures) for (const [lng, lat] of f.coords) selectedCoordFlat.push({ lat, lng });
      const FAR_FROM_SELECTED_METRES = 6;
      // v73.119 — same fix as buildSelectedRoadGraph's junction-merge pass:
      // this was a plain `.some()` scan of the FULL selectedCoordFlat array
      // for every single point in `merged` — O(N×M), and both N and M scale
      // with the size of the selection, not a fixed small number. This is
      // debug-only logging that ran unconditionally on every "Add to
      // Segment" click, so a large lasso selection paid this cost (on top
      // of buildSelectedRoadGraph's own, now-fixed, cost) every time.
      // Bucket selectedCoordFlat into a grid sized to the 6m tolerance and
      // only scan the point's own + 8 neighbouring cells — same result,
      // near-linear instead of quadratic.
      const FAR_CELL_DEG = FAR_FROM_SELECTED_METRES / 111320;
      const farCellKey = (lat: number, lng: number) => `${Math.floor(lat / FAR_CELL_DEG)},${Math.floor(lng / FAR_CELL_DEG)}`;
      const farGrid = new Map<string, RoadPoint[]>();
      for (const sp of selectedCoordFlat) {
        const ck = farCellKey(sp.lat, sp.lng);
        if (!farGrid.has(ck)) farGrid.set(ck, []);
        farGrid.get(ck)!.push(sp);
      }
      const isNearSelected = (p: RoadPoint): boolean => {
        const cellLat = Math.floor(p.lat / FAR_CELL_DEG), cellLng = Math.floor(p.lng / FAR_CELL_DEG);
        for (let dLat = -1; dLat <= 1; dLat++) {
          for (let dLng = -1; dLng <= 1; dLng++) {
            const bucket = farGrid.get(`${cellLat + dLat},${cellLng + dLng}`);
            if (!bucket) continue;
            for (const sp of bucket) { if (haversine(p, sp) <= FAR_FROM_SELECTED_METRES) return true; }
          }
        }
        return false;
      };
      const unselectedLookingPoints = merged.filter(p => !isNearSelected(p));
      console.group('🔍 Add to Segment debug (v73.111)');
      console.log('ACTIVE SEGMENT:');
      console.log('  Segment index:', idx, '(draft key:', draftKey + ')');
      console.log('  A:', manualStartPointRef.current ? `${manualStartPointRef.current.lat.toFixed(5)},${manualStartPointRef.current.lng.toFixed(5)}` : '(auto — first selected point)');
      console.log('  B:', manualEndPointRef.current ? `${manualEndPointRef.current.lat.toFixed(5)},${manualEndPointRef.current.lng.toFixed(5)}` : '(auto — last selected point)');
      console.log('  Turnaround nodes in order:', (turnaroundsRef.current[idx] || []).map((t, i) => `T${i + 1}: ${t.lat.toFixed(5)},${t.lng.toFixed(5)}`));
      console.log('SELECTED OSM DATA:');
      console.log('  Selected OSM way IDs:', selectedWayIds);
      console.log('  Selected graph node count:', debugGraph.nodes.size);
      console.log('  Selected graph edge count:', debugGraph.edges.size);
      console.log('ROUTE OUTPUT:');
      console.log('  Strict mode (selected roads only):', strictSelectedRoadsOnlyRef.current);
      console.log('  Generated point count:', merged.length);
      console.log(`  Unselected OSM edges used (points >${FAR_FROM_SELECTED_METRES}m from any selected-road vertex):`, unselectedLookingPoints.length === 0 ? '[]' : unselectedLookingPoints.map(p => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`));
      console.groupEnd();
      if (strictSelectedRoadsOnlyRef.current && unselectedLookingPoints.length > 0) {
        console.warn(`⚠️ Strict mode was ON but ${unselectedLookingPoints.length} generated point(s) are >${FAR_FROM_SELECTED_METRES}m from any selected-road vertex — this shouldn't happen under Strict mode; please screenshot this console output.`);
      }
    } catch (e) {
      console.warn('Add to Segment debug logging failed (non-fatal):', e);
    }
    // v73.76 — Craig: "I want the undo button... to undo any changes up to
    // add segment." Real gap, not a misunderstanding — this function never
    // pushed a bulk-undo snapshot at all, unlike every other bulk-style
    // action (Delete/Transit/Simplify/Reverse/Clear all do). Snapshot
    // `originalExisting` (the segment's points BEFORE either batch) so
    // Undo Bulk can remove exactly what this Add to Segment just added in
    // one step, same one-click pattern as the others.
    pushBulkUndo(idx, originalExisting.slice(), 'addSegment');
    // v73.79 — see suppressNextBulkUndoClearRef declaration above: the
    // setEditorMode('draw') a few lines down fires the cleanup effect that
    // would otherwise immediately wipe the undo entry just pushed above.
    suppressNextBulkUndoClearRef.current = true;
    const updated = liveSegsRef.current.map((s, si) => si === idx ? merged : s);
    liveSegsRef.current = updated;
    onChangeRef.current(updated);
    rebuildAllRef.current();
    // v73.110 — this segment's generated points now genuinely reflect the
    // current A/B/turnaround/selection state — clear its staleness flag.
    setDirtySegs(prev => prev.has(idx) ? (() => { const n = new Set(prev); n.delete(idx); return n; })() : prev);
    selectedFeaturesRef.current.clear();
    setSelectedRoadIds([]);
    setTransitRoadIds(new Set());
    setMarkTransitMode(false);
    setEditorMode('draw');
    setLassoActive(false);
    setLassoVertices([]);
    setLassoMode('select');
    setStagedForRemovalIds(new Set());
    clearSelectionUndo();
    clearSelectionDraft();
    setManualStartPoint(null);
    setSettingStartPoint(false);
    setManualEndPoint(null);
    setSettingEndPoint(false);
  };

  // Total length: exclude edges where pts[i].transitAfter === true
  const totalLen = segments.reduce((total, pts) =>
    total + pts.reduce((s, p, i) => (i < pts.length - 1 && !p.transitAfter) ? s + haversine(p, pts[i + 1]) : s, 0)
  , 0);
  const activePts = segments[activeSegIdx] || [];

  // ── City/town search using Nominatim (free, no API key) ─────────────────
  const searchCity = async () => {
    const q = citySearch.trim();
    if (!q || !mapRef.current) return;
    setCitySearching(true); setCityError('');
    try {
      const resp = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
        { headers: { 'Accept-Language': 'en' } }
      );
      const results = await resp.json();
      if (results.length > 0) {
        const { lat, lon } = results[0];
        mapRef.current.setView([parseFloat(lat), parseFloat(lon)], 15, { animate: true });
        setCityError('');
      } else {
        setCityError(`"${q}" not found — try a different spelling`);
      }
    } catch {
      setCityError('Search unavailable — check internet connection');
    } finally {
      setCitySearching(false);
    }
  };

  const fillMode = height === -1;
  return (
    <div className={fillMode ? "flex flex-col h-full" : "space-y-2"}>
      {/* City/town search — lets users jump to any location before drawing */}
      <div className="flex gap-2 shrink-0 p-2">
        <input
          type="text"
          className="input-field flex-1 text-sm"
          placeholder="🔍 Search town or city to navigate map (e.g. Otorohanga, Hamilton NZ)"
          value={citySearch}
          onChange={e => { setCitySearch(e.target.value); setCityError(''); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); searchCity(); } }}
        />
        <button
          onClick={searchCity}
          disabled={citySearching || !citySearch.trim()}
          className="btn-secondary text-sm px-4 shrink-0 disabled:opacity-50"
        >
          {citySearching ? '⏳' : '🔍 Go'}
        </button>
      </div>
      {cityError && <p className="text-xs text-red-500 shrink-0 px-2">{cityError}</p>}

    <div className={fillMode ? "relative flex-1 overflow-hidden" : "relative overflow-hidden rounded-xl border border-gray-200 shadow-sm"} style={{ height: fillMode ? undefined : height }}
      ref={el => {
        if (!el) return;
        const ro = new ResizeObserver(() => { try { mapRef.current?.invalidateSize({ animate: false }); } catch { /**/ } });
        ro.observe(el);
        (el as HTMLElement & { _ro?: ResizeObserver })._ro?.disconnect();
        (el as HTMLElement & { _ro?: ResizeObserver })._ro = ro;
      }}
    >
      <div ref={containerRef} className="w-full h-full" />

      {/* v73.12: Draw Points / Select Roads mode switch — top-right so it never
          fights with the existing bottom-right drawing toolbar or the zoom controls */}
      <div className="absolute top-2 right-2 z-[1000] flex flex-col items-end gap-1">
        <div className="flex rounded-lg shadow border border-gray-200 overflow-hidden bg-white/95 backdrop-blur">
          <button
            onClick={() => { setEditorMode('draw'); setLassoActive(false); setLassoVertices([]); setLassoMode('select'); setStagedForRemovalIds(new Set()); setManualStartPoint(null); setSettingStartPoint(false); setTurnaroundMode(false); }}
            title="Draw points one click at a time (A to B)"
            className={`px-3 py-1.5 text-xs font-semibold transition ${editorMode === 'draw' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
          >✏️ Draw Points</button>
          <button
            onClick={() => setEditorMode('select')}
            title="Build a segment from existing road geometry instead of drawing it by hand"
            className={`px-3 py-1.5 text-xs font-semibold transition border-l border-gray-200 ${editorMode === 'select' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
          >🧭 Select Roads</button>
        </div>
        {editorMode === 'select' && roadsLoading && (
          <div className="bg-white/95 backdrop-blur rounded-lg px-3 py-1 text-xs text-gray-500 shadow border border-gray-200">⏳ Loading roads…</div>
        )}
        {editorMode === 'select' && roadsError && (
          <div className="bg-red-50/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs text-red-600 shadow border border-red-200 max-w-[240px] text-right">⚠️ {roadsError}</div>
        )}
      </div>

      {/* v73.119 — Select Roads toolbar moved to a full-width bottom bar so it
          no longer covers the map. Draw Points toolbar stays bottom-right (small,
          never more than 2 buttons). The bottom bar sits above the stats badge
          (bottom-0) and the existing bottom-10 draw toolbar, so nothing overlaps. */}
      {editorMode === 'select' && (
        <div className="absolute bottom-0 left-0 right-0 z-[1000] bg-white/97 backdrop-blur border-t border-gray-200 shadow-lg">
          {/* Status bar — full width, one line */}
          <div className={`px-3 py-1 text-xs font-medium border-b whitespace-nowrap overflow-x-auto ${turnaroundMode ? 'bg-orange-50 border-orange-200 text-orange-700' : stagedForRemovalIds.size > 0 ? 'bg-red-50 border-red-200 text-red-700' : dirtySegs.has(activeSegIdx) ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-gray-50 border-gray-100 text-gray-700'}`}>
            {dirtySegs.has(activeSegIdx)
              ? '⚠ Segment needs rebuild — A/B/turnarounds/selection changed. Click ✓ Add to Segment to apply.'
              : turnaroundMode
              ? `🔄 Turnaround mode ON — click a highlighted road-end node (T${(turnarounds[activeSegIdx]?.length ?? 0) + 1}) · Escape or 🔄 to switch off`
              : stagedForRemovalIds.size > 0
              ? `🟥 ${stagedForRemovalIds.size} road${stagedForRemovalIds.size === 1 ? '' : 's'} staged — Delete/Confirm to remove, Escape/Cancel to clear`
              : lassoVertices.length > 0
              ? fenceShape === 'box'
                ? (lassoVertices.length < 4
                    ? '📍 1 corner placed — click the opposite corner to complete the box'
                    : `📍 Box placed — drag a corner to adjust · confirm to ${lassoMode === 'deselect' ? 'REMOVE' : 'select'} roads inside`)
                : `📍 ${lassoVertices.length} fence point${lassoVertices.length === 1 ? '' : 's'} — drag to adjust · click/right-click a point to remove${lassoVertices.length < 3 ? ' · need 3+ to confirm' : ` · confirm to ${lassoMode === 'deselect' ? 'REMOVE' : 'select'} roads inside`}`
              : lassoActive
              ? `${fenceShape === 'box' ? '▭ Box' : '✏️ Lasso'} ${lassoMode === 'deselect' ? 'DESELECT' : 'SELECT'} ON — click the map to ${fenceShape === 'box' ? 'place two opposite corners' : 'place fence points'}`
              : lassoMode === 'deselect'
              ? `🧭 Click roads to stage for removal${selectedRoadIds.length > 0 ? ` · ${selectedRoadIds.length} selected` : ''} · Ctrl+drag to box-stage`
              : `🧭 Click roads to select/deselect${selectedRoadIds.length > 0 ? ` · ${selectedRoadIds.length} selected` : ''} · Ctrl+drag to box-select`}
          </div>
          {/* Button row — scrollable so it never wraps or clips on narrow screens */}
          <div className="flex items-center gap-1 px-2 py-1.5 overflow-x-auto">
              {stagedForRemovalIds.size > 0 && (
                <>
                  <button onClick={() => setStagedForRemovalIds(new Set())} title="Clear the staged queue without removing anything (Escape)" className="bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-medium text-gray-600 shadow border border-gray-200 hover:bg-gray-50 whitespace-nowrap">✕ Cancel</button>
                  <button onClick={() => { pushSelectionUndo(); const ids = stagedForRemovalIdsRef.current; ids.forEach(id => selectedFeaturesRef.current.delete(id)); setSelectedRoadIds(prev => prev.filter(id => !ids.has(id))); setStagedForRemovalIds(new Set()); }} title="Remove all staged roads from the selection (Delete)" className="bg-red-600 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-semibold text-white shadow border border-red-700 hover:bg-red-700 whitespace-nowrap">🗑 Confirm Delete</button>
                </>
              )}
              {(lassoActive || lassoVertices.length > 0 || selectedRoadIds.length > 0) && (
                <div className="flex rounded-lg shadow border border-gray-200 overflow-hidden">
                  <button onClick={() => { setLassoMode('select'); setStagedForRemovalIds(new Set()); }} title="Lasso Select — fence adds roads inside it to the selection" className={`px-2.5 py-1.5 text-xs font-semibold transition whitespace-nowrap ${lassoMode === 'select' ? 'bg-indigo-600 text-white' : 'bg-white/95 text-gray-600 hover:bg-gray-50'}`}>Select</button>
                  <button onClick={() => { setLassoMode('deselect'); if (fenceShapeRef.current === 'lasso') { setFenceShape('box'); setLassoActive(false); lassoVerticesRef.current = []; setLassoVertices([]); } }} title="Lasso Deselect — fence REMOVES roads inside it from the selection" className={`px-2.5 py-1.5 text-xs font-semibold transition whitespace-nowrap ${lassoMode === 'deselect' ? 'bg-red-600 text-white' : 'bg-white/95 text-gray-600 hover:bg-gray-50'}`}>Deselect</button>
                </div>
              )}
              {(lassoActive || lassoVertices.length > 0) && (
                <div className="flex rounded-lg shadow border border-gray-200 overflow-hidden">
                  {lassoMode !== 'deselect' && (
                    <button onClick={() => setFenceShape('lasso')} disabled={lassoVertices.length > 0} title={lassoVertices.length > 0 ? 'Cancel the current fence first to change shape' : 'Freeform outline'} className={`px-2.5 py-1.5 text-xs font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap ${fenceShape === 'lasso' ? 'bg-indigo-600 text-white' : 'bg-white/95 text-gray-600 hover:bg-gray-50'}`}>✏️ Lasso</button>
                  )}
                  <button onClick={() => setFenceShape('box')} disabled={lassoVertices.length > 0} title={lassoVertices.length > 0 ? 'Cancel the current fence first to change shape' : 'Rectangle — click 2 opposite corners'} className={`px-2.5 py-1.5 text-xs font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap ${fenceShape === 'box' ? 'bg-indigo-600 text-white' : 'bg-white/95 text-gray-600 hover:bg-gray-50'}`}>▭ Box</button>
                </div>
              )}
              <button onClick={() => setLassoActive(b => !b)} title={lassoActive ? 'Pause lasso — click roads individually' : lassoVertices.length > 0 ? 'Resume lasso' : `Trace a ${fenceShape === 'box' ? 'box' : 'freeform fence'} to select/deselect roads inside`} className={`backdrop-blur rounded-lg px-3 py-1.5 text-xs font-semibold shadow border transition whitespace-nowrap ${lassoActive ? (lassoMode === 'deselect' ? 'bg-red-500 border-red-600 text-white hover:bg-red-600' : 'bg-indigo-500 border-indigo-600 text-white hover:bg-indigo-600') : 'bg-white/95 border-gray-200 text-gray-600 hover:border-red-400 hover:text-red-600'}`}>{fenceShape === 'box' ? '▭ Box' : '✏️ Lasso'} {lassoActive ? 'ON' : lassoVertices.length > 0 ? '(paused)' : 'Draw Fence'}</button>
              {lassoVertices.length > 0 && (
                <>
                  <button onClick={undoLastLassoPoint} title="Remove the most recently placed fence point" className="bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-medium text-gray-600 shadow border border-gray-200 hover:bg-gray-50 whitespace-nowrap">↩ Undo Point</button>
                  <button onClick={cancelLassoFence} className="bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-medium text-red-600 shadow border border-red-200 hover:bg-red-50 whitespace-nowrap">✕ Cancel Fence</button>
                  <button onClick={confirmLassoFence} disabled={lassoVertices.length < 3} title={lassoVertices.length < 3 ? 'Place at least 3 points to close a fence' : lassoMode === 'deselect' ? 'Remove every road inside this fence' : 'Select every road inside this fence'} className={`backdrop-blur rounded-lg px-3 py-1.5 text-xs font-semibold text-white shadow border disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap ${lassoMode === 'deselect' ? 'bg-red-600 border-red-700 hover:bg-red-700' : 'bg-indigo-600 border-indigo-700 hover:bg-indigo-700'}`}>{lassoMode === 'deselect' ? '✓ Confirm Removal' : '✓ Confirm Fence'}</button>
                </>
              )}
              {selectedRoadIds.length > 0 && lassoMode === 'select' && !lassoActive && lassoVertices.length === 0 && (
                <button onClick={() => setSettingStartPoint(b => !b)} title={settingStartPoint ? 'Click any endpoint marker on a selected road to set it as the start — click here again to cancel' : manualStartPoint ? 'A start point is set (green flag) — click to choose a different one' : 'Choose exactly where this selection should start'} className={`backdrop-blur rounded-lg px-3 py-1.5 text-xs font-semibold shadow border transition whitespace-nowrap ${settingStartPoint ? 'bg-emerald-600 border-emerald-700 text-white hover:bg-emerald-700' : manualStartPoint ? 'bg-emerald-50 border-emerald-300 text-emerald-700 hover:bg-emerald-100' : 'bg-white/95 border-gray-200 text-gray-600 hover:border-emerald-400 hover:text-emerald-600'}`}>🚩 {settingStartPoint ? 'Click an endpoint…' : manualStartPoint ? 'Start point set' : 'Set Start Point'}</button>
              )}
              {manualStartPoint && !settingStartPoint && (
                <button onClick={() => setManualStartPoint(null)} title="Remove the chosen start point" className="bg-white/95 backdrop-blur rounded-lg px-2 py-1.5 text-xs font-medium text-gray-500 shadow border border-gray-200 hover:bg-gray-50">✕</button>
              )}
              {manualStartPoint && !settingStartPoint && !settingEndPoint && (
                <button onClick={() => setManualEndPoint(manualStartPoint)} title="Set the finish (B) to the exact same spot as the start (A)" className={`backdrop-blur rounded-lg px-3 py-1.5 text-xs font-semibold shadow border transition whitespace-nowrap ${manualEndPoint && manualEndPoint.lat === manualStartPoint.lat && manualEndPoint.lng === manualStartPoint.lng ? 'bg-violet-50 border-violet-300 text-violet-700' : 'bg-white/95 border-gray-200 text-gray-600 hover:border-violet-400 hover:text-violet-600'}`}>🔁 {manualEndPoint && manualEndPoint.lat === manualStartPoint.lat && manualEndPoint.lng === manualStartPoint.lng ? 'B = A (set)' : 'Set B = A'}</button>
              )}
              {selectedRoadIds.length > 0 && lassoMode === 'select' && !lassoActive && lassoVertices.length === 0 && (
                <button onClick={() => setSettingEndPoint(b => !b)} title={settingEndPoint ? 'Click any endpoint marker on a selected road to set it as the finish — click here again to cancel' : manualEndPoint ? 'A finish point is set (red flag) — click to choose a different one' : 'Choose exactly where this selection should finish'} className={`backdrop-blur rounded-lg px-3 py-1.5 text-xs font-semibold shadow border transition whitespace-nowrap ${settingEndPoint ? 'bg-red-600 border-red-700 text-white hover:bg-red-700' : manualEndPoint ? 'bg-red-50 border-red-300 text-red-700 hover:bg-red-100' : 'bg-white/95 border-gray-200 text-gray-600 hover:border-red-400 hover:text-red-600'}`}>🏁 {settingEndPoint ? 'Click an endpoint…' : manualEndPoint ? 'End point set' : 'Set End Point'}</button>
              )}
              {manualEndPoint && !settingEndPoint && (
                <button onClick={() => setManualEndPoint(null)} title="Remove the chosen end point" className="bg-white/95 backdrop-blur rounded-lg px-2 py-1.5 text-xs font-medium text-gray-500 shadow border border-gray-200 hover:bg-gray-50">✕</button>
              )}
              {selectionUndoStack.length > 0 && !lassoActive && lassoVertices.length === 0 && (
                <button onClick={undoLastSelectionChange} title="Undo the last select/deselect change" className="bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-medium text-gray-600 shadow border border-gray-200 hover:bg-gray-50 whitespace-nowrap">↩️ Undo</button>
              )}
              {(selectedRoadIds.length > 0 || stagedForRemovalIds.size > 0 || lassoVertices.length > 0) && (
                draftKey.startsWith('new-road') ? (
                  <div title="Save Draft isn't available until this road has been saved once (Create Road)" className="bg-gray-50/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-medium text-gray-400 shadow border border-gray-200 whitespace-nowrap">💾 Save Draft (after Create Road)</div>
                ) : (
                  <button onClick={saveSelectionDraft} title="Save this selection to this device now — safe to close the window or reload." className="bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-medium text-emerald-700 shadow border border-emerald-200 hover:bg-emerald-50 whitespace-nowrap">💾 Save Draft</button>
                )
              )}
              {draftSavedAt && !draftKey.startsWith('new-road') && (
                <div title="Saved to this device as of the last time you pressed Save Draft." className="bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-medium text-emerald-600 shadow border border-emerald-200 whitespace-nowrap">💾 Draft saved</div>
              )}
              {selectedRoadIds.length > 0 && (
                <button onClick={() => { selectedFeaturesRef.current.clear(); setSelectedRoadIds([]); setStagedForRemovalIds(new Set()); setTransitRoadIds(new Set()); setMarkTransitMode(false); setManualStartPoint(null); setSettingStartPoint(false); setManualEndPoint(null); setSettingEndPoint(false); clearSelectionUndo(); clearSelectionDraft(); }} title="Deselect every road in the current selection" className="bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-medium text-red-600 shadow border border-red-200 hover:bg-red-50 whitespace-nowrap">✕ Clear All</button>
              )}
              {selectedRoadIds.length > 0 && (
                <button onClick={() => setAddAsTransit(v => !v)} title={addAsTransit ? 'Adding as Transit — click to switch back to normal sweep' : 'Add this selection as Transit (drive-through, not swept)'} className={`backdrop-blur rounded-lg px-3 py-1.5 text-xs font-semibold shadow border transition whitespace-nowrap ${addAsTransit ? 'bg-amber-500 border-amber-600 text-white hover:bg-amber-600' : 'bg-white/95 border-gray-200 text-gray-600 hover:border-amber-400 hover:text-amber-600'}`}>🔀 {addAsTransit ? 'Adding as Transit' : 'Add as Transit'}</button>
              )}
              {selectedRoadIds.length > 0 && (
                <button onClick={() => setMarkTransitMode(v => !v)} title={markTransitMode ? `On — click any selected road to mark/unmark it as transit individually (${transitRoadIds.size} marked)` : 'Mark individual roads within this selection as transit'} className={`backdrop-blur rounded-lg px-3 py-1.5 text-xs font-semibold shadow border transition whitespace-nowrap ${markTransitMode ? 'bg-amber-100 border-amber-500 text-amber-800 hover:bg-amber-200' : 'bg-white/95 border-gray-200 text-gray-600 hover:border-amber-400 hover:text-amber-600'}`}>🎯 {markTransitMode ? `Marking Transit (${transitRoadIds.size})` : 'Mark Transit Roads'}</button>
              )}
              {selectedRoadIds.length > 0 && (
                <button onClick={() => setTurnaroundMode(m => !m)} title={turnaroundMode ? 'Turnaround mode ON — click a highlighted road-end node; click again to switch off' : 'Place turnaround points — click a highlighted real road-end/intersection node'} className={`backdrop-blur rounded-lg px-3 py-1.5 text-xs font-semibold shadow border transition whitespace-nowrap ${turnaroundMode ? 'bg-orange-500 border-orange-600 text-white hover:bg-orange-600' : 'bg-white/95 border-gray-200 text-gray-600 hover:border-orange-400 hover:text-orange-600'}`}>🔄 Turnaround{(turnarounds[activeSegIdx]?.length ?? 0) > 0 ? ` (${turnarounds[activeSegIdx].length})` : ''}</button>
              )}
              <button onClick={addSelectedRoadsToSegment} disabled={selectedRoadIds.length === 0 || routingGaps} title={routingGaps ? 'Checking for real-road connections between selected pieces that don\'t touch...' : undefined} className="bg-indigo-600 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-semibold text-white shadow border border-indigo-700 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap">{routingGaps ? '⏳ Routing via real roads…' : addAsTransit ? '✓ Add as Transit' : '✓ Add to Segment'}</button>
              {/* Options / checkboxes — put in a collapsible to save bar space */}
              <div className="ml-2 pl-2 border-l border-gray-200 flex items-center gap-1">
                <label className="flex items-center gap-1.5 bg-white/95 backdrop-blur rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-700 shadow border border-gray-200 cursor-pointer select-none whitespace-nowrap" title="Sweep both sides of each road (two offset lines, doubles km)"><input type="checkbox" checked={sweepBothSides} onChange={e => setSweepBothSides(e.target.checked)} className="accent-indigo-600" />↔ Both sides</label>
                <label className="flex items-center gap-1.5 bg-white/95 backdrop-blur rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-700 shadow border border-gray-200 cursor-pointer select-none whitespace-nowrap" title="Use ONLY selected road geometry — no OSRM gap-filling between disconnected pieces"><input type="checkbox" checked={strictSelectedRoadsOnly} onChange={e => setStrictSelectedRoadsOnly(e.target.checked)} className="accent-indigo-600" />🔒 Selected only</label>
                <label className="flex items-center gap-1.5 bg-white/95 backdrop-blur rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-700 shadow border border-gray-200 cursor-pointer select-none whitespace-nowrap" title="Also show car parks, driveways and service lanes as selectable (dashed amber)"><input type="checkbox" checked={includeServiceLanes} onChange={e => setIncludeServiceLanes(e.target.checked)} className="accent-amber-600" />🅿️ Car parks</label>
                <label className="flex items-center gap-1.5 bg-white/95 backdrop-blur rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-700 shadow border border-gray-200 cursor-pointer select-none whitespace-nowrap" title="Also show roads named '... Lane' as selectable (dashed amber)"><input type="checkbox" checked={includeLanes} onChange={e => setIncludeLanes(e.target.checked)} className="accent-amber-600" />🛣️ Lanes</label>
                <label className="flex items-center gap-1.5 bg-white/95 backdrop-blur rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-700 shadow border border-gray-200 cursor-pointer select-none whitespace-nowrap" title="Also show parking aisles (OSM service=parking_aisle) as selectable"><input type="checkbox" checked={includeParkingAisles} onChange={e => setIncludeParkingAisles(e.target.checked)} className="accent-amber-600" />🅿 Parking Aisle</label>
                <label className="flex items-center gap-1.5 bg-white/95 backdrop-blur rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-700 shadow border border-gray-200 cursor-pointer select-none whitespace-nowrap" title="Also show service roads (OSM highway=service, no subtype) as selectable"><input type="checkbox" checked={includeServiceRoads} onChange={e => setIncludeServiceRoads(e.target.checked)} className="accent-amber-600" />🔧 Service Road</label>
                <label className="flex items-center gap-1.5 bg-white/95 backdrop-blur rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-700 shadow border border-gray-200 cursor-pointer select-none whitespace-nowrap" title="Also show living streets (OSM highway=living_street) as selectable"><input type="checkbox" checked={includeLivingStreets} onChange={e => setIncludeLivingStreets(e.target.checked)} className="accent-amber-600" />🏘️ Living Street</label>
              </div>
          </div>
        </div>
      )}

      {/* Toolbar — bottom-right, Draw Points mode only (small set of buttons) */}
      <div className="absolute bottom-10 right-2 z-[1000] flex flex-col items-end gap-1">
        {editorMode === 'draw' ? (
          <>
            <div className={`backdrop-blur rounded-lg px-3 py-1.5 text-xs font-medium shadow border whitespace-nowrap ${(stagedPointIdx.size > 0 || stagedLineIdx.size > 0) ? 'bg-red-50/95 border-red-300 text-red-700' : turnaroundMode ? 'bg-orange-50/95 border-orange-300 text-orange-700' : transitMode ? 'bg-amber-50/95 border-amber-300 text-amber-700' : 'bg-white/95 border-gray-200 text-gray-700'}`}>
              {(stagedPointIdx.size + stagedLineIdx.size) > 0
                ? `🟥 ${stagedPointIdx.size + stagedLineIdx.size} staged — Delete/🗑 to remove, Escape/✕ to clear, 🔀 to convert to transit instead`
                : turnaroundMode
                ? `🔄 Turnaround mode ON — click the road end to place a marker · Escape or 🔄 to switch off`
                : transitMode
                ? `🔀 Transit mode ON — lines will be invisible/not counted · click to add`
                : (segments.length > 1 ? `✛ Adding to ${(segmentNames[activeSegIdx]?.trim()) ? segmentNames[activeSegIdx].trim() : `Segment ${String.fromCharCode(65 + activeSegIdx)}`}` : '✛ Click to add · Click point/line to stage for bulk delete · Ctrl+drag to box-stage')}
            </div>
            <div className="flex gap-1">
              {/* v73.23 — staged-for-delete queue takes over Cancel/Confirm
                  here; Undo/Clear (below) stay available the whole time
                  since they're a different, older, always-on tool for
                  quickly undoing what was JUST drawn — not a replacement
                  for the staging queue. */}
              {(stagedPointIdx.size > 0 || stagedLineIdx.size > 0) && (
                <>
                  <button
                    onClick={clearDrawStaging}
                    title="Clear the staged queue without removing or converting anything (same as pressing Escape)"
                    className="bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-medium text-gray-600 shadow border border-gray-200 hover:bg-gray-50"
                  >✕ Cancel</button>
                  <button
                    onClick={commitDrawStagedDelete}
                    title="Delete every staged point/line in one go (same as pressing Delete)"
                    className="bg-red-600 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-semibold text-white shadow border border-red-700 hover:bg-red-700"
                  >🗑 Confirm Delete</button>
                </>
              )}
              {/* v73.41 — Craig: "have either it in transit or solid line
                  mode options so when I'm selecting multiple things it's
                  not changing in between the two it's either changing into
                  one or the other that is set." Two explicit buttons now,
                  instead of one button that guessed a target based on
                  whatever's currently staged — always does exactly what it
                  says regardless of the staged selection's current mix. The
                  "Transit mode" toggle for NEW points (no staged queue) is
                  unrelated and unchanged below. */}
              {(stagedPointIdx.size > 0 || stagedLineIdx.size > 0) ? (
                <>
                  <button
                    onClick={() => commitDrawStagedTransitConvert(true)}
                    title="Set every staged point/line to Transit (invisible, not counted in km)"
                    className="bg-amber-500 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-semibold text-white shadow border border-amber-600 hover:bg-amber-600"
                  >🔀 Set to Transit</button>
                  <button
                    onClick={() => commitDrawStagedTransitConvert(false)}
                    title="Set every staged point/line to a solid, counted line"
                    className="bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-semibold text-gray-700 shadow border border-gray-300 hover:border-amber-400 hover:text-amber-700"
                  >➖ Set to Solid</button>
                </>
              ) : (
                <button
                  onClick={() => setTransitMode(m => !m)}
                  title={transitMode ? 'Transit mode ON — click to switch back to solid lines' : 'Switch to transit mode — new lines will be invisible and not counted in km'}
                  className={`backdrop-blur rounded-lg px-3 py-1.5 text-xs font-semibold shadow border transition ${
                    transitMode
                      ? 'bg-amber-400 border-amber-500 text-white hover:bg-amber-500'
                      : 'bg-white/95 border-gray-200 text-gray-600 hover:border-amber-400 hover:text-amber-600'
                  }`}
                >🔀 Transit</button>
              )}
              {/* v73.104 — Turnaround points now require the real
                  road-endpoint picker (see Select Roads' own "🔄 Turnaround"
                  button), which only exists in Select Roads mode — there's
                  no equivalent picker of real road nodes for hand-drawn
                  Draw Points geometry. Disabled here rather than removed, so
                  it's clear where the feature moved instead of just
                  vanishing. */}
              {(stagedPointIdx.size === 0 && stagedLineIdx.size === 0) && (
                <button
                  disabled
                  title="Turnaround points now need a real road node to snap to — switch to 🧭 Select Roads and use its 🔄 Turnaround button instead"
                  className="backdrop-blur rounded-lg px-3 py-1.5 text-xs font-semibold shadow border bg-gray-50/95 border-gray-200 text-gray-400 cursor-not-allowed"
                >🔄 Turnaround{(turnarounds[activeSegIdx]?.length ?? 0) > 0 ? ` (${turnarounds[activeSegIdx].length})` : ''}</button>
              )}
              {/* v73.23 — undo for bulk delete/transit-convert/simplify/
                  reverse/clear (acceptance criterion #16). Distinct from
                  the always-available "↩ Undo" below (which only ever
                  removes the single most-recently-added point) — this one
                  only appears right after a bulk-style commit, and pops
                  ONE step per click off a capped 20-deep stack (v73.69),
                  so several bulk actions in a row can each be walked back
                  individually instead of only the very last one. Still
                  disappears entirely the moment any other edit (drag,
                  midpoint insert, single-point delete) touches this
                  segment — see pushBulkUndo/clearBulkUndo above. */}
              {bulkUndoKind && (
                <button
                  onClick={undoBulkAction}
                  title={`Undo the last bulk action (${bulkUndoKind}) — ${bulkUndoCount} step${bulkUndoCount === 1 ? '' : 's'} available`}
                  className="bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-medium text-indigo-600 shadow border border-indigo-200 hover:bg-indigo-50"
                >↩ Undo Bulk {bulkUndoKind === 'delete' ? 'Delete' : bulkUndoKind === 'transit' ? 'Convert' : bulkUndoKind === 'simplify' ? 'Simplify' : bulkUndoKind === 'reverse' ? 'Reverse' : bulkUndoKind === 'addSegment' ? 'Add Segment' : 'Clear'} ({bulkUndoCount})</button>
              )}
              {activePts.length > 300 && (
                // v73.46 — Craig: still freezing/slow on Seg A/B at
                // 2229/1354 points even after v73.45. Those segments were
                // BUILT before v73.45 shipped — v73.45 only stops NEW
                // Select-Roads additions from accumulating raw survey
                // density going forward, it can't retroactively thin
                // geometry that was already merged into a segment and
                // saved. This is that retroactive fix, as a manual,
                // on-demand action rather than something silently applied
                // to existing field data — same Douglas-Peucker helper and
                // 1.5m tolerance already trusted since v73.37/v73.45.
                // transitAfter is attached to individual points, so a
                // removed point's transit flag is genuinely lost if that
                // exact point goes — flagged explicitly in the confirm
                // rather than silently dropped, so Craig can check/reapply
                // Transit markers afterward if the segment had any.
                <button onClick={() => {
                  const before = activePts.length;
                  const hasTransit = activePts.some(p => p.transitAfter === true);
                  const ok = window.confirm(
                    `Simplify Segment ${segmentNames[activeSegIdx] || String.fromCharCode(65 + activeSegIdx)}? This removes redundant near-straight-line points (within 1.5m) to fix lag on dense/old segments.` +
                    (hasTransit ? '\n\n⚠️ This segment has Transit line markers — a removed point can lose its Transit flag. Check Transit lines afterward.' : '') +
                    `\n\nCurrently ${before} points. Ctrl+Z won't undo this, but ↩ Undo Bulk will restore the pre-simplify version.`
                  );
                  if (!ok) return;
                  const simplified = simplifyPath(activePts, 1.5);
                  pushBulkUndo(activeSegIdx, activePts.slice(), 'simplify');
                  const updated = segments.map((s, si) => si !== activeSegIdx ? s : simplified);
                  onSegmentsChange(updated);
                  clearDrawStaging();
                  alert(`Simplified: ${before} → ${simplified.length} points. Use ↩ Undo Bulk to restore if this looks wrong.`);
                }}
                  title="Thin out redundant near-straight-line points on this segment — fixes lag on segments built before v73.45's fix, which only applies to new Select Roads additions."
                  className="bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-medium text-amber-700 shadow border border-amber-300 hover:bg-amber-50"
                >🧹 Simplify Points ({activePts.length})</button>
              )}
              {
                // v73.78 — safety-net button for Craig: if map panning ever
                // gets stuck for ANY reason (the marker-density case above,
                // an interrupted Ctrl-drag, or anything not yet diagnosed),
                // this is a one-click recovery that doesn't need a page
                // reload. Always visible in the toolbar (not conditional on
                // any "stuck" detection — there's no reliable way to detect
                // "map won't pan" from code, only to provide an escape
                // hatch), since it's a harmless no-op click when panning is
                // already working fine.
              }
              <button
                onClick={() => { mapRef.current?.dragging.enable(); }}
                title="Map won't pan/drag? Click this to force it back on — safe to click any time, even if panning is already working fine."
                className="bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 shadow border border-gray-200 hover:bg-gray-50"
              >🔓 Clear Any Locks</button>
              {activePts.length > 0 && (
                <button onClick={() => {
                  const updated = segments.map((s, si) => si !== activeSegIdx ? s : s.slice(0, -1));
                  onSegmentsChange(updated);
                  clearDrawStaging();
                  clearBulkUndo();
                }} className="bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-medium text-red-600 shadow border border-red-200 hover:bg-red-50">↩ Undo</button>
              )}
              {activePts.length > 0 && (
                <button onClick={() => {
                  pushBulkUndo(activeSegIdx, activePts.slice(), 'clear');
                  const updated = segments.map((s, si) => si !== activeSegIdx ? s : []);
                  onSegmentsChange(updated);
                  clearDrawStaging();
                }} className="bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-medium text-red-600 shadow border border-red-200 hover:bg-red-50">🗑 Clear</button>
              )}
            </div>
          </>
        ) : (
          // v73.119 — Select Roads toolbar moved to the full-width bottom bar
          // (see the editorMode === 'select' block above this div). Nothing
          // rendered here in select mode; the bottom-right div only hosts the
          // Draw Points toolbar now, so it stays compact and out of the way.
          null
        )}
      </div>

      {/* Stats badge */}
      {totalLen > 0 && (
        <div className="absolute bottom-2 left-2 z-[1000] bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-semibold text-gray-700 shadow border border-gray-200">
          📏 {fmtMetres(totalLen)} swept · {segments.reduce((s, p) => s + p.length, 0)} points
        </div>
      )}

      {/* v73.46 — A/B confirm popup shown after "Add to Segment" builds a
          new chain, before it's merged in. See addSelectedRoadsToSegment
          and the pendingAddSegment state near the top of this component. */}
      {pendingAddSegment && (() => {
        const { chain } = pendingAddSegment;
        const a = chain[0], b = chain[chain.length - 1];
        const fmtCoord = (p: RoadPoint) => `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
        const km = (polylineLength(chain) / 1000).toFixed(2);
        return (
          <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4"
            onClick={() => { pendingAddSegment.resolve(null); }}>
            <div onClick={e => e.stopPropagation()}
              className="bg-white rounded-xl shadow-2xl p-5 w-full max-w-sm space-y-3">
              <h3 className="text-base font-bold text-gray-900">Confirm start (A) / end (B)</h3>
              <p className="text-xs text-gray-500">
                {chain.length} points · {km} km. Direction was set automatically — check it's what you want before this gets added to the segment.
              </p>
              <div className="text-xs bg-gray-50 border border-gray-200 rounded-lg p-2 space-y-1">
                <p>🚩 <strong>Start (A):</strong> {fmtCoord(a)}</p>
                <p>🏁 <strong>End (B):</strong> {fmtCoord(b)}</p>
              </div>
              <div className="flex flex-col gap-2 pt-1">
                <button onClick={() => pendingAddSegment.resolve(false)}
                  className="btn-primary text-sm py-2">✅ Keep this direction (A → B)</button>
                <button onClick={() => pendingAddSegment.resolve(true)}
                  className="btn-secondary text-sm py-2">🔄 Change Location (swap A and B)</button>
                <button onClick={() => pendingAddSegment.resolve(null)}
                  className="btn-danger text-sm py-2">✕ Cancel — don't add this selection</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
    {/* end outer search+map wrapper */}
    </div>
  );
}

// ─── PinSwatch — tiny pin preview for pin list ────────────────────────────────
function PinSwatch({ pin, getSevColor }: { pin: DamagePin; getSevColor: (s: string | undefined) => string }) {
  const bg = pin.bgColor || (pin.severity ? getSevColor(pin.severity) : pin.color) || '#DC2626';
  const ring = pin.outerColor || '#FFFFFF';
  const emojiM = (pin.damageType || '').match(/^(\p{Emoji}\uFE0F?|[\u{1F300}-\u{1FAFF}])/u);
  return (
    <div style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, marginTop: 2,
      background: bg, border: `3px solid ${ring}`, boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11 }}>
      {emojiM?.[0] || '⚠️'}
    </div>
  );
}

// ─── Damage Pin map (click to place damage pins on a job road) ────────────────
interface DamageMapProps {
  road: SweepRoad;
  pins: DamagePin[];
  onPinsChange: (pins: DamagePin[]) => void;
}

// ─── AllRoadsMap — full-screen read-only map showing ALL job roads with segment colours ──
interface AllRoadsMapProps {
  jobRoads: { roadId: string }[];
  sweepRoads: SweepRoad[];
  sweepAreas: SweepArea[];
  jobZoneIds?: string[];
  sweepZones?: SweepZone[];
}
function simpleCentroidJM(points: RoadPoint[]): RoadPoint {
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  return { lat, lng };
}
function AllRoadsMap({ jobRoads, sweepRoads, sweepAreas, jobZoneIds = [], sweepZones = [] }: AllRoadsMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) { try { mapRef.current.remove(); } catch { /**/ } mapRef.current = null; }

    const map = L.map(containerRef.current, {zoomSnap: 0.25, zoomDelta: 0.25, wheelPxPerZoomLevel: 120,  zoomControl: true, scrollWheelZoom: true, renderer: L.canvas({ tolerance: 8 }) });
    mapRef.current = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors', maxZoom: 19,
    }).addTo(map);

    const allLatLngs: [number, number][] = [];

    jobRoads.forEach(jr => {
      const road = sweepRoads.find(r => r.id === jr.roadId);
      if (!road) return;
      const area = sweepAreas.find(a => a.id === road.areaId);
      const fallbackColor = road.color || area?.color || '#6366F1';

      // drawSolidRuns: renders only the non-transit (solid) sub-runs of a point array.
      // Transit edges (pts[i].transitAfter===true) are completely skipped so they
      // are invisible in the saved route / job map.  Only solid runs contribute to
      // allLatLngs so fitBounds isn't distorted by repositioning paths.
      const drawSolidRuns = (pts: RoadPoint[], color: string, label?: string) => {
        if (pts.length < 2) return;
        let i = 0;
        let isFirstSolid = true;
        while (i < pts.length - 1) {
          const edgeIsTransit = pts[i].transitAfter === true;
          const runPts: RoadPoint[] = [pts[i]];
          while (i < pts.length - 1 && (pts[i].transitAfter === true) === edgeIsTransit) {
            runPts.push(pts[i + 1]);
            i++;
          }
          if (edgeIsTransit || runPts.length < 2) continue; // skip transit runs
          const latLngs = runPts.map(p => [p.lat, p.lng] as [number, number]);
          latLngs.forEach(ll => allLatLngs.push(ll));
          // v73.73 — Craig: Sweep Jobs' own route view should show plain
          // lines only, no translucent highlight band (that's Sweeping
          // Maps' job, see SweepMaps.tsx's own v73.73 comment). Removed the
          // v73.71 band entirely and restored the original pre-band halo/
          // centreline opacity (0.15/0.95) — the v73.72 dimmed values only
          // existed to compensate for a band that no longer renders here.
          L.polyline(latLngs, { color: '#000', weight: 7, opacity: 0.15 }).addTo(map);
          const pl = L.polyline(latLngs, { color, weight: 5, opacity: 0.95 }).addTo(map);
          if (isFirstSolid) {
            const mid = latLngs[Math.floor(latLngs.length / 2)];
            if (mid) pl.bindTooltip(`<b style="color:${color}">${label || road.name}</b>`, {
              permanent: false, direction: 'top', className: 'rsw-road-tooltip',
            });
            isFirstSolid = false;
          }
        }
      };

      if (road.segments && road.segments.length > 0) {
        road.segments.forEach(seg => {
          const segColor = seg.color || fallbackColor;
          drawSolidRuns(seg.points, segColor, `${road.name}${road.segments!.length > 1 ? ' · ' + seg.label : ''}`);
        });
      } else {
        drawSolidRuns(road.points || [], fallbackColor, road.name);
      }
    });

    // v73.63 — Craig: "zone not showing in Route Map in Edit Sweep Job."
    // Route Map only ever drew jobRoads — zones attached to the job
    // (jobZoneIds) were never rendered here at all, even though
    // SweepMaps.tsx's own RouteMap/MiniMap got this same zone-drawing
    // treatment back in v73.51. Same rendering rules, ported over:
    // main zone boundary + every sub-zone, fillEnabled/color/labelPos-or-
    // centroid, read-only (no vertex markers/drag — this is a summary map).
    jobZoneIds.forEach(zid => {
      const zone = sweepZones.find(z => z.id === zid);
      if (!zone) return;
      const shapes: { points: RoadPoint[]; color: string; fillEnabled: boolean; name: string; labelPos: RoadPoint | null }[] = [
        { points: zone.points, color: zone.color, fillEnabled: zone.fillEnabled ?? true, name: zone.name, labelPos: zone.labelPos ?? null },
        ...(zone.subZones || []).map(sz => ({
          points: sz.points, color: sz.color, fillEnabled: sz.fillEnabled ?? true, name: sz.name, labelPos: sz.labelPos ?? null,
        })),
      ];
      shapes.forEach(shape => {
        if (shape.points.length < 2) return;
        const latlngs = shape.points.map(p => [p.lat, p.lng] as [number, number]);
        latlngs.forEach(ll => allLatLngs.push(ll));
        if (shape.points.length >= 3) {
          L.polygon(latlngs, {
            color: shape.color, weight: 2,
            fillColor: shape.color, fillOpacity: shape.fillEnabled ? 0.15 : 0,
            dashArray: shape.fillEnabled ? undefined : [6, 4],
          }).addTo(map);
        } else {
          L.polyline(latlngs, { color: shape.color, weight: 2, dashArray: [6, 4] }).addTo(map);
        }
        if (shape.name.trim()) {
          const lp = shape.labelPos || simpleCentroidJM(shape.points);
          L.marker([lp.lat, lp.lng], {
            icon: L.divIcon({
              className: '',
              html: `<div style="font-size:12px;font-weight:600;color:${shape.color};text-shadow:0 0 3px white,0 0 3px white,0 0 3px white,0 0 3px white;white-space:nowrap;pointer-events:none;">${shape.name}</div>`,
              iconSize: [1, 1], iconAnchor: [0, 0],
            }),
            interactive: false, zIndexOffset: 500,
          }).addTo(map);
        }
      });
    });

    // Fit map to all drawn roads
    if (allLatLngs.length > 0) {
      map.fitBounds(L.latLngBounds(allLatLngs), { padding: [32, 32] });
    } else {
      map.setView([-38.6, 175.9], 11); // NZ default
    }

    return () => { try { mapRef.current?.remove(); } catch { /**/ } mapRef.current = null; };
  // v73.17 — Craig: after adding roads via Select Roads/Lasso (or any edit to
  // an already-job-assigned road's route), this map kept showing the OLD
  // geometry — "no data points" — because the effect only re-ran when the
  // job's *list of road ids* changed, never when a road already in that list
  // got its points/segments/lengthMetres edited in Areas & Roads. `sweepRoads`
  // itself was a fresh prop every render, but wasn't in the dependency array,
  // so React never knew to redraw. Fixed by keying the effect off each
  // relevant road's `updatedAt` (bumped by `updateSweepRoad()` on every save)
  // alongside the id list, so any route edit — lasso-added or hand-drawn —
  // is picked up immediately without needing to remove/re-add the road.
  // v73.63: same keying now also applied to jobZoneIds/sweepZones so a
  // zone added/edited/removed from the job updates this map immediately too.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    jobRoads.map(j => j.roadId).join(','),
    jobRoads.map(j => sweepRoads.find(r => r.id === j.roadId)?.updatedAt || '').join(','),
    jobZoneIds.join(','),
    jobZoneIds.map(id => sweepZones.find(z => z.id === id)?.updatedAt || '').join(','),
  ]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}

function DamageMap({ road, pins, onPinsChange }: DamageMapProps) {
  const { data: storeData } = useStore();
  // Collect items from ALL lists of each type (user may have multiple lists per type)
  const allDmgItems  = (storeData.sweepCategories || [])
    .filter(c => c.categoryType === 'damage_type')
    .flatMap(c => c.items);
  const allSevItems  = (storeData.sweepCategories || [])
    .filter(c => c.categoryType === 'damage_severity')
    .flatMap(c => c.items);
  const damageTypeItems = allDmgItems.length ? allDmgItems : [
    { id: 'p', name: '🕳️ Pothole',       color: '#dc2626', description: '' },
    { id: 'k', name: '🧱 Kerb Damage',    color: '#d97706', description: '' },
    { id: 'd', name: '💧 Drainage Issue', color: '#0891b2', description: '' },
    { id: 'm', name: '🚧 Marking Faded',  color: '#6b7280', description: '' },
    { id: 'o', name: '⚠️ Other',           color: '#6366f1', description: '' },
  ];
  const severityItems = allSevItems.length ? allSevItems : [
    { id: 'l',  name: 'Low',      color: '#FCD34D', description: '' },
    { id: 'm2', name: 'Medium',   color: '#FB923C', description: '' },
    { id: 'h',  name: 'High',     color: '#EF4444', description: '' },
    { id: 'c',  name: 'Critical', color: '#7F1D1D', description: '' },
  ];
  const getSevColor = (name: string | undefined) =>
    name ? (severityItems.find(s => s.name === name)?.color ?? '#EF4444') : '#6b7280';


  // Always sync initial pinForm defaults from live SW Category items
  useEffect(() => {
    setPinForm(f => ({
      ...f,
      damageType: f.damageType && damageTypeItems.some(i => i.name === f.damageType)
        ? f.damageType : (damageTypeItems[0]?.name || ''),
      severity: f.severity && severityItems.some(i => i.name === f.severity)
        ? f.severity : (severityItems[0]?.name || ''),
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [damageTypeItems[0]?.name, severityItems[0]?.name]);

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const pinsRef = useRef<DamagePin[]>(pins);
  const markersRef = useRef<L.Marker[]>([]);
  const onChangeRef = useRef(onPinsChange);

  const [pendingPin, setPendingPin] = useState<{ lat: number; lng: number } | null>(null);
  const [editingPin, setEditingPin] = useState<DamagePin | null>(null); // editing existing pin
  const [pinForm, setPinForm] = useState<{
    label: string; description: string; color: string;
    damageType: DamagePinType; severity: DamageSeverity; photo: string;
    bgColor: string; outerColor: string;
  }>({ label: '', description: '', color: '#DC2626', damageType: '', severity: '', photo: '',
       bgColor: '', outerColor: '#FFFFFF' });
  const photoRef = useRef<HTMLInputElement>(null);
  const editPhotoRef = useRef<HTMLInputElement>(null);

  useEffect(() => { pinsRef.current = pins; }, [pins]);
  useEffect(() => { onChangeRef.current = onPinsChange; }, [onPinsChange]);

  // ── Build draggable pin marker ────────────────────────────────────────────
  const buildMarker = useCallback((pin: DamagePin, map: L.Map) => {
    // bgColor: explicit override → severity colour → legacy color field
    const bg = pin.bgColor || (pin.severity ? getSevColor(pin.severity) : pin.color) || '#DC2626';
    const ring = pin.outerColor || '#FFFFFF';
    const emojiM = (pin.damageType || '').match(/^(\p{Emoji}\uFE0F?|[\u{1F300}-\u{1FAFF}])/u);
    const emoji = emojiM ? emojiM[0] : '⚠️';
    const icon = L.divIcon({
      className: '',
      html: `<div style="width:32px;height:32px;border-radius:50%;background:${bg};border:3px solid ${ring};box-shadow:0 2px 8px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;font-size:14px;cursor:move;">${emoji}</div>`,
      iconSize: [32, 32], iconAnchor: [16, 16],
    });
    const marker = L.marker([pin.lat, pin.lng], { icon, draggable: true }).addTo(map);

    // Drag to reposition
    marker.on('dragstart', () => { if (map.getContainer()) map.getContainer().style.cursor = 'grabbing'; });
    marker.on('dragend', () => {
      if (map.getContainer()) map.getContainer().style.cursor = 'crosshair';
      const ll = marker.getLatLng();
      const updated = pinsRef.current.map(p => p.id === pin.id ? { ...p, lat: ll.lat, lng: ll.lng, updatedAt: nowStr() } : p);
      pinsRef.current = updated;
      onChangeRef.current(updated);
    });

    // Click = open edit form for this pin
    marker.on('click', () => {
      setEditingPin({ ...pinsRef.current.find(p => p.id === pin.id)! });
      setPendingPin(null);
    });

    marker.bindTooltip(`<strong>${pin.label || pin.damageType || 'Pin'}</strong><br>${pin.description || ''}${pin.severity ? `<br>Severity: ${pin.severity}` : ''}<br><em>Click to edit · Drag to move</em>`, { direction: 'top' });

    return marker;
  }, []);

  const redrawPins = useCallback((allPins: DamagePin[], map: L.Map) => {
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    allPins.forEach(pin => {
      markersRef.current.push(buildMarker(pin, map));
    });
  }, [buildMarker]);

  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }

    const center: [number, number] = road.points.length > 0
      ? [road.points[0].lat, road.points[0].lng]
      : [-36.8485, 174.7633];

    const map = L.map(containerRef.current, {zoomSnap: 0.25, zoomDelta: 0.25, wheelPxPerZoomLevel: 120,  attributionControl: false, renderer: L.canvas({ tolerance: 8 }) }).setView(center, 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    mapRef.current = map;

    setTimeout(() => { try { map.invalidateSize({ animate: false }); } catch { /**/ } }, 80);

    // Draw ALL segments (primary + extra route segments from Areas & Roads)
    const allSegs = getRoadSegments(road);
    const areaColor = '#6366F1';
    const routeColor = road.color || areaColor;
    const allLatLngs: [number, number][] = [];
    allSegs.forEach((seg, si) => {
      if (seg.length > 1) {
        const lls = seg.map(p => [p.lat, p.lng] as [number, number]);
        L.polyline(lls, {
          color: routeColor,
          weight: si === 0 ? 5 : 4,
          opacity: si === 0 ? 0.8 : 0.6,
          dashArray: si === 0 ? undefined : '8 4',
        }).addTo(map);
        allLatLngs.push(...lls);
      }
    });
    if (allLatLngs.length > 1) {
      map.fitBounds(L.latLngBounds(allLatLngs), { padding: [30, 30] });
    }

    redrawPins(pins, map);

    // Always show crosshair on the damage pin map so user knows they can click to add
    map.getContainer().style.cursor = 'crosshair';

    map.on('click', (e: L.LeafletMouseEvent) => {
      setEditingPin(null); // close any open editor
      setPendingPin({ lat: e.latlng.lat, lng: e.latlng.lng });
    });

    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [road.id]);

  useEffect(() => {
    if (!mapRef.current) return;
    redrawPins(pins, mapRef.current);
  }, [pins, redrawPins]);

  // ── Save NEW pin ─────────────────────────────────────────────────────────
  const savePin = () => {
    if (!pendingPin) return;
    const autoColor = getSevColor(pinForm.severity);
    const newPin: DamagePin = {
      id: uid(),
      lat: pendingPin.lat, lng: pendingPin.lng,
      label: pinForm.label || (pinForm.damageType.replace(/^\S+\s*/, '') || pinForm.damageType) || 'Pin',
      description: pinForm.description,
      color: autoColor,
      bgColor: pinForm.bgColor || autoColor,
      outerColor: pinForm.outerColor || '#FFFFFF',
      damageType: pinForm.damageType,
      severity: pinForm.severity,
      pinMode: 'damage',
      photo: pinForm.photo || undefined,
      createdAt: nowStr(),
    };
    const next = [...pinsRef.current, newPin];
    onPinsChange(next);
    setPendingPin(null);
    setPinForm(f => ({ ...f, label: '', description: '', photo: '', bgColor: '', outerColor: '#FFFFFF' }));
  };

  // ── Save EDITED existing pin ─────────────────────────────────────────────
  const saveEditPin = () => {
    if (!editingPin) return;
    const autoColor = getSevColor(editingPin.severity ?? 'medium');
    const savedPin: DamagePin = {
      ...editingPin,
      pinMode: 'damage',
      color: editingPin.bgColor || autoColor,
      bgColor: editingPin.bgColor || autoColor,
      outerColor: editingPin.outerColor || '#FFFFFF',
      updatedAt: nowStr(),
    };
    const updated = pinsRef.current.map(p => p.id === editingPin.id ? savedPin : p);
    onPinsChange(updated);
    setEditingPin(null);
  };

  const deleteEditPin = () => {
    if (!editingPin) return;
    if (!confirm('Delete this damage pin?')) return;
    const updated = pinsRef.current.filter(p => p.id !== editingPin.id);
    onPinsChange(updated);
    setEditingPin(null);
  };

  // ── Shared photo upload handler ──────────────────────────────────────────
  const handlePhotoUpload = async (file: File, target: 'new' | 'edit') => {
    const reader = new FileReader();
    reader.onload = async ev => {
      const raw = ev.target?.result as string;
      const compressed = await compressImage(raw, 800, 0.7);
      if (target === 'new') setPinForm(f => ({ ...f, photo: compressed }));
      else setEditingPin(ep => ep ? { ...ep, photo: compressed } : ep);
    };
    reader.readAsDataURL(file);
  };

  /* ── PIN FORM COLOUR PRESETS ─────────────────────────────────────────────── */
  const PIN_FILL_PRESETS   = ['#DC2626','#D97706','#16A34A','#0891B2','#6366F1','#7C3AED','#DB2777','#000000','#FFFFFF'];
  const PIN_RING_PRESETS   = ['#FFFFFF','#000000','#FCD34D','#6366F1','#DC2626','#16A34A','#0891B2'];

  /* ── SHARED PIN FORM UI (used for both new and edit) ─────────────────── */
  const renderPinFields = (
    mode: 'new' | 'edit',
    data2: { label: string; description: string; color: string; bgColor?: string | undefined; outerColor?: string | undefined;
             damageType: DamagePinType; severity: DamageSeverity; photo?: string | undefined; pinMode?: 'damage' | 'standard' | undefined },
    set: (patch: Partial<typeof data2>) => void,
    photoInputRef: React.RefObject<HTMLInputElement | null>
  ) => {
    const autoFill  = getSevColor(data2.severity);
    const activeFill  = data2.bgColor  || autoFill;
    const activeRing  = data2.outerColor || '#FFFFFF';

    return (
    <>
      {/* Damage Type + Severity */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Damage Type</label>
          <select className="input-field text-sm" value={data2.damageType}
            onChange={e => set({ damageType: e.target.value })}>
            {damageTypeItems.map(i => <option key={i.id} value={i.name}>{i.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Severity</label>
          <select className="input-field text-sm" value={data2.severity}
            onChange={e => set({ severity: e.target.value, bgColor: '' } as never)}>
            {severityItems.map(i => <option key={i.id} value={i.name}>{i.name}</option>)}
          </select>
        </div>
      </div>

      {/* Colour pickers */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        {/* Fill / background */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Fill Colour <span className="text-[10px] text-gray-400">(auto from severity)</span>
          </label>
          <div className="flex flex-wrap gap-1.5 mb-1">
            <button title="Auto (from severity)"
              onClick={() => set({ bgColor: '' } as never)}
              className={`w-6 h-6 rounded-full border-2 text-[9px] flex items-center justify-center font-bold ${!data2.bgColor ? 'border-gray-900 scale-110' : 'border-gray-300'}`}
              style={{ backgroundColor: autoFill, color: '#fff' }}>A</button>
            {PIN_FILL_PRESETS.map(c => (
              <button key={c} title={c} onClick={() => set({ bgColor: c } as never)}
                className={`w-6 h-6 rounded-full border-2 ${activeFill === c && !!data2.bgColor ? 'border-gray-900 scale-110' : 'border-gray-200'}`}
                style={{ backgroundColor: c }} />
            ))}
            <input type="color" value={activeFill}
              onChange={e => set({ bgColor: e.target.value } as never)}
              className="w-6 h-6 rounded cursor-pointer border border-gray-300" title="Custom colour" />
          </div>
        </div>

        {/* Outer ring */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Ring Colour</label>
          <div className="flex flex-wrap gap-1.5 mb-1">
            {PIN_RING_PRESETS.map(c => (
              <button key={c} title={c} onClick={() => set({ outerColor: c } as never)}
                className={`w-6 h-6 rounded-full border-2 ${activeRing === c ? 'border-gray-900 scale-110' : 'border-gray-200'}`}
                style={{ backgroundColor: c }} />
            ))}
            <input type="color" value={activeRing}
              onChange={e => set({ outerColor: e.target.value } as never)}
              className="w-6 h-6 rounded cursor-pointer border border-gray-300" title="Custom colour" />
          </div>
        </div>
      </div>

      {/* Live preview */}
      <div className="flex items-center gap-3 mb-3 p-2 bg-gray-50 rounded-lg border border-gray-200">
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: activeFill, border: `4px solid ${activeRing}`,
          boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
        }}>
          {(data2.damageType || '').match(/^(\p{Emoji}\uFE0F?|[\u{1F300}-\u{1FAFF}])/u)?.[0] || '⚠️'}
        </div>
        <span className="text-xs text-gray-500">Pin preview</span>
      </div>

      <input className="input-field text-sm mb-2" placeholder="Label (optional)" value={data2.label}
        onChange={e => set({ label: e.target.value })} />
      <textarea className="input-field text-sm mb-2" rows={2} placeholder="Description / notes"
        value={data2.description} onChange={e => set({ description: e.target.value })} />

      {/* Photo */}
      <div className="mb-2">
        <input ref={photoInputRef} type="file" accept="image/*" capture="environment" className="hidden"
          onChange={async e => { const f = e.target.files?.[0]; if (f) await handlePhotoUpload(f, mode); e.target.value = ''; }} />
        {data2.photo ? (
          <div className="relative inline-block">
            <img src={data2.photo} alt="" className="h-20 rounded-lg object-cover" />
            <button onClick={() => set({ photo: '' })}
              className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full text-xs flex items-center justify-content:center">×</button>
          </div>
        ) : (
          <button onClick={() => photoInputRef.current?.click()} className="btn-secondary text-xs">📷 Add Photo</button>
        )}
      </div>
    </>
    );
  };

  return (
    <div className="space-y-2">
      <div className="relative rounded-xl overflow-hidden border border-gray-200" style={{ height: 560 }}>
        <div ref={containerRef} style={{ height: '100%' }} />
        <div className="absolute top-2 right-2 z-[1000]">
          <div className="bg-white/95 backdrop-blur rounded-lg px-3 py-1.5 text-xs font-medium text-gray-700 shadow border border-gray-200">
            🖱️ Click map to add pin · Click pin to edit · Drag pin to move
          </div>
        </div>
      </div>

      {/* NEW PIN FORM */}
      {pendingPin && (
        <div className="border-2 border-amber-300 bg-amber-50 rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-amber-800">📍 New pin at {pendingPin.lat.toFixed(5)}, {pendingPin.lng.toFixed(5)}</p>
            <button onClick={() => setPendingPin(null)} className="text-gray-400 hover:text-gray-600 text-lg">✕</button>
          </div>
          {renderPinFields('new',
            { label: pinForm.label, description: pinForm.description, color: pinForm.color,
              bgColor: pinForm.bgColor, outerColor: pinForm.outerColor,
              damageType: pinForm.damageType, severity: pinForm.severity, photo: pinForm.photo, pinMode: 'damage' },
            patch => setPinForm(f => ({ ...f, ...(patch as Record<string, unknown>) })),
            photoRef
          )}
          <div className="flex gap-2">
            <button onClick={() => setPendingPin(null)} className="btn-secondary flex-1 text-sm">Cancel</button>
            <button onClick={savePin} className="btn-primary flex-1 text-sm">📍 Save Pin</button>
          </div>
        </div>
      )}

      {/* EDIT EXISTING PIN FORM */}
      {editingPin && (
        <div className="border-2 border-blue-300 bg-blue-50 rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-blue-800">✏️ Editing: {editingPin.label || editingPin.damageType || 'Pin'}</p>
            <button onClick={() => setEditingPin(null)} className="text-gray-400 hover:text-gray-600 text-lg">✕</button>
          </div>
          <p className="text-xs text-blue-600">📍 {editingPin.lat.toFixed(5)}, {editingPin.lng.toFixed(5)} — Drag the pin on the map to reposition it</p>
          {renderPinFields('edit',
            { label: editingPin.label, description: editingPin.description, color: editingPin.color,
              bgColor: editingPin.bgColor, outerColor: editingPin.outerColor,
              damageType: editingPin.damageType ?? 'pothole', severity: editingPin.severity ?? 'medium',
              photo: editingPin.photo, pinMode: 'damage' },
            patch => setEditingPin(ep => ep ? { ...ep, ...patch } : ep),
            editPhotoRef
          )}
          <div className="flex gap-2">
            <button onClick={deleteEditPin} className="btn-danger text-sm">🗑️ Delete</button>
            <button onClick={() => setEditingPin(null)} className="btn-secondary flex-1 text-sm">Cancel</button>
            <button onClick={saveEditPin} className="btn-primary flex-1 text-sm">💾 Save Changes</button>
          </div>
        </div>
      )}

      {/* PIN LIST */}
      {pins.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-600">{pins.length} pin{pins.length !== 1 ? 's' : ''} — click to edit</p>
          {pins.map(pin => (
            <div key={pin.id}
              onClick={() => { setEditingPin({ ...pin }); setPendingPin(null); }}
              className={`flex items-start gap-2 p-2 rounded-lg border cursor-pointer transition hover:border-blue-300 hover:bg-blue-50 ${editingPin?.id === pin.id ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-gray-50'}`}>
              {/* Mini pin swatch */}
              <PinSwatch pin={pin} getSevColor={getSevColor} />
              {pin.photo && <img src={pin.photo} alt="" className="w-12 h-12 rounded object-cover shrink-0" />}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-gray-900">{pin.label}</span>
                  {pin.damageType && (
                    <span className="badge bg-amber-100 text-amber-700 text-xs">{pin.damageType}</span>
                  )}
                  {pin.severity && <span className="text-xs font-semibold" style={{ color: getSevColor(pin.severity) }}>{pin.severity}</span>}
                  {pin.updatedAt && <span className="text-[10px] text-blue-500">edited</span>}
                </div>
                {pin.description && <p className="text-xs text-gray-500 mt-0.5">{pin.description}</p>}
                <p className="text-xs text-gray-400">{pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}</p>
              </div>
              <span className="text-xs text-blue-500 shrink-0 mt-1">✏️</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════
export default function Sweeping({ initialTab }: { initialTab?: 'jobs' | 'areas' }) {
  const {
    data, currentUser,
    addSweepArea, updateSweepArea, deleteSweepArea,
    addSweepRoad, updateSweepRoad, deleteSweepRoad,
    addSweepZone, updateSweepZone, deleteSweepZone,
    addSweepJob, updateSweepJob, deleteSweepJob,
    syncServerUrl, syncToken, // v73.12: Select Roads mode fetches road geometry from the host-server's /api/roads
  } = useStore();

  const sweepAreas = data.sweepAreas || [];
  const sweepRoads = data.sweepRoads || [];
  const sweepZones = data.sweepZones || [];
  const sweepJobs  = data.sweepJobs  || [];

  // ── Dynamic display helpers ───────────────────────────────────────────────
  const getSeverityColor = (name: string | undefined): string => {
    if (!name) return '#6b7280';
    const sevItems = (data.sweepCategories || []).filter(c => c.categoryType === 'damage_severity').flatMap(c => c.items);
    return sevItems.find(i => i.name === name)?.color ?? '#EF4444';
  };
  // Weather and debris values are stored as category item names (e.g. "☀️ Clear", "🟢 Light").
  // No translation needed — display the stored value directly.
  const weatherLabel = (w: string) => w || '—';
  const debrisLabel  = (d: string) => d || '—';


  const [tab, setTab] = useState<'jobs' | 'areas'>(initialTab || 'jobs');

  // ── Area / Road state ──────────────────────────────────────────────────────
  const [showAreaForm, setShowAreaForm]     = useState(false);
  const [editingArea, setEditingArea]       = useState<SweepArea | null>(null);
  const [areaForm, setAreaForm]             = useState(emptyArea());
  const [showRoadForm, setShowRoadForm]     = useState<string | false>(false); // areaId
  const [editingRoad, setEditingRoad]       = useState<SweepRoad | null>(null);
  const [roadSaved, setRoadSaved]           = useState(false); // shows brief "Saved ✓" badge
  const [roadNameError, setRoadNameError]   = useState(false); // validation: name required
  const [roadForm, setRoadForm]             = useState(emptyRoad());
  const [roadPoints, setRoadPoints]         = useState<RoadPoint[]>([]);
  // v73.27 — Zone form state, mirroring the Road form state immediately above.
  const [showZoneForm, setShowZoneForm]     = useState<string | false>(false); // areaId
  const [editingZone, setEditingZone]       = useState<SweepZone | null>(null);
  const [zoneSaved, setZoneSaved]           = useState(false);
  const [zoneNameError, setZoneNameError]   = useState(false);
  const [zoneForm, setZoneForm]             = useState<Omit<SweepZone, 'id' | 'createdAt' | 'updatedAt'>>({
    name: '', areaId: '', zoneKind: 'carpark', color: '#0088ff', points: [], areaM2: 0, notes: '',
  });
  const [zonePoints, setZonePoints]         = useState<RoadPoint[]>([]);
  // v73.49 — sub-zone editing state, mirroring roadSegments/activeSegIdx's
  // relationship to the road form. -1 means "editing the main zone
  // boundary" (zonePoints/zoneForm.fillEnabled/zoneForm.labelPos); >= 0
  // indexes into zoneSubZones. uid() import already exists in this file
  // (used throughout for road segments, pins, etc.).
  const [zoneSubZones, setZoneSubZones]     = useState<SweepSubZone[]>([]);
  const [activeSubZoneIdx, setActiveSubZoneIdx] = useState<number>(-1);
  const [expandedArea, setExpandedArea]     = useState<string | null>(null);
  // Feature 2 & 3 — multi-segment + drawing options
  const [roadSegments, setRoadSegments]     = useState<RoadPoint[][]>([[]]); // Feature 3
  // v73.25 — Bug #1 fix: each segment's persisted id, parallel to roadSegments/
  // segmentNames/segmentColors by index. Previously saveRoad() called uid() for
  // EVERY segment on EVERY save (including a no-op re-save of an already-existing,
  // unchanged segment), so a segment's id changed every single time the road was
  // saved. mergeSweepRoads() / server.js's equivalent merge sync segments by id
  // ("union by id") — with the id changing every save, the old id's entry never
  // gets recognised as "the same segment, just newer" and instead survives
  // forever as a separate, stale duplicate every time a pull/merge runs (e.g. on
  // a Docker rebuild re-pulling from the host-server). Segment ids must now stay
  // stable across edits — only a genuinely NEW segment gets a fresh uid().
  const [segmentIds, setSegmentIds]         = useState<string[]>([uid()]);
  // v73.39 — snapshot of segments as loaded (openEditRoad) or empty
  // (openAddRoad), keyed by id — saveRoad() diffs each final segment against
  // its entry here to decide whether to bump `updatedAt` or keep the
  // original timestamp. Updated after every successful save too, so repeated
  // saves within the same modal session diff against the latest state.
  const originalSegmentsRef = useRef<RouteSegment[]>([]);
  const [segmentNames, setSegmentNames]     = useState<string[]>(['']);       // editable names
  const [segmentColors, setSegmentColors]   = useState<string[]>(['']);       // per-segment colour ('' = inherit road colour)
  // v73.100 — Turnaround Points, one array per segment (parallel to
  // roadSegments/segmentIds/segmentNames/segmentColors by index). Saved onto
  // each RouteSegment (RouteSegment.turnarounds) in saveRoad(), loaded back
  // in openEditRoad() — same lifecycle as every other per-segment array here.
  const [roadTurnarounds, setRoadTurnarounds] = useState<TurnaroundPoint[][]>([[]]);
  // v73.109 — Craig: the turnaround list rendered directly under Route
  // Segments read as "another segment section" even though it was never
  // stored as one — a UI/layout problem, not a data problem (v73.108 already
  // ruled the data side out). Collapsed behind this toggle by default so the
  // left panel's default view is just Route Segments; the full T1..Tn list
  // only appears once Craig explicitly asks for it via "Manage Turnarounds".
  const [showTurnaroundManager, setShowTurnaroundManager] = useState(false);
  const [activeSegIdx, setActiveSegIdx]     = useState(0);                   // Feature 3
  // v73.68 — mirrors MultiSegmentRoadMap's own onPendingSelectionChange report;
  // true whenever the map currently has an uncommitted Select Roads selection/
  // fence that would be silently discarded by switching segments or mode.
  const [hasPendingSelection, setHasPendingSelection] = useState(false);
  // Guard wrapping any segment-switch trigger ("+ Add Segment", clicking another
  // segment tab): if nothing's pending, switches immediately as before; if
  // something IS pending, confirms with the user first rather than discarding
  // it silently — addresses Craig's "Add Segment resets everything" report,
  // traced to "✓ Add to Segment" (commits a selection) and "+ Add Segment"
  // (creates a new segment tab) being two easily-confused buttons.
  const guardSegmentSwitch = (doSwitch: () => void) => {
    if (!hasPendingSelection || window.confirm(
      'You have an unconfirmed road selection (Select Roads / Lasso) that hasn\'t been added to this segment yet. ' +
      'Switching segments now will discard it — use "✓ Add to Segment" first if you want to keep it.\n\nSwitch anyway and discard it?'
    )) {
      doSwitch();
    }
  };
  const [useAreaColor, setUseAreaColor]     = useState(true);                // Feature 2
  const [roadCustomColor, setRoadCustomColor] = useState('#6366F1');         // Feature 2
  const [roadShowNumbers, setRoadShowNumbers] = useState(true);              // Feature 2
  const [roadShowMarkers, setRoadShowMarkers] = useState(true);              // Feature 2
  // Road modal drag state
  const [roadModalPos, setRoadModalPos]     = useState<{x: number; y: number} | null>(null);
  const roadModalDragRef = useRef<{startX: number; startY: number; origX: number; origY: number} | null>(null);
  // v73.41 — Craig: "make all the pop up windows able to be adjusted and
  // moved when needed" + zone map screenshot showing it cramped in a
  // fixed-size modal. Mirrors roadModalPos/roadModalDragRef exactly — same
  // drag-to-move-by-header + native CSS `resize: both` pattern already used
  // for Edit Road, just not yet applied to Edit Zone. Scoped to these two
  // map-editing modals specifically (the ones actually screenshotted/
  // complained about) rather than attempting every modal in the app in one
  // pass — flagged to Craig as the scoping choice made.
  const [zoneModalPos, setZoneModalPos]     = useState<{x: number; y: number} | null>(null);
  const zoneModalDragRef = useRef<{startX: number; startY: number; origX: number; origY: number} | null>(null);

  // ── Job state ──────────────────────────────────────────────────────────────
  const [jobView, setJobView]               = useState<'list' | 'form' | 'detail'>('list');
  const [editingJob, setEditingJob]         = useState<SweepJob | null>(null);
  const [jobForm, setJobForm]               = useState(emptyJob());
  const [detailJob, setDetailJob]           = useState<SweepJob | null>(null);
  const [jobTab, setJobTab] = useState<'info' | 'roads' | 'zones' | 'quicksettings' | 'overview' | 'map' | 'fuel' | 'expenses' | 'tip'>('info');
  const [activeRoadIdx, setActiveRoadIdx]   = useState(0);
  const [activeOverviewRoadIdx, setActiveOverviewRoadIdx] = useState(0);
  const [msg, setMsg]                       = useState('');
  const [jobSearch, setJobSearch]           = useState('');
  const [statusFilter, setStatusFilter]     = useState<'all' | 'planned' | 'in_progress' | 'completed'>('all');

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 4000); };

  // ── Area CRUD ───────────────────────────────────────────────────────────────
  const openAddArea = () => {
    setAreaForm({ ...emptyArea(), color: AREA_COLORS[sweepAreas.length % AREA_COLORS.length] });
    setEditingArea(null);
    setShowAreaForm(true);
  };
  const openEditArea = (a: SweepArea) => {
    setAreaForm({ name: a.name, description: a.description, color: a.color, roadIds: [...a.roadIds], zoneType: a.zoneType || '' });
    setEditingArea(a);
    setShowAreaForm(true);
  };
  const saveArea = () => {
    if (!areaForm.name.trim()) return;
    if (editingArea) updateSweepArea({ ...editingArea, ...areaForm });
    else addSweepArea(areaForm);
    setShowAreaForm(false);
  };

  // ── Road CRUD ───────────────────────────────────────────────────────────────
  // v73.86 — Craig: "Create Road" refreshes the map and loses everything
  // right after saving; separately reported the draft-save feature (added
  // v73.84, just above) as "completely corrupted, no longer saving
  // anything." Same root cause for both, traced from the actual code: the
  // MultiSegmentRoadMap `key` AND the `draftKey` prop below were both
  // derived from `editingRoad?.id`. saveRoad() on a brand-new road calls
  // setEditingRoad(created) so further saves update it instead of
  // duplicating it — correct — but that flips both props from
  // 'new-road'/`'new-road'` to `road-<realId>`/`<realId>` on the very next
  // render. React treats a changed `key` as a different component: it
  // unmounts the old MultiSegmentRoadMap and mounts a fresh one, wiping
  // any state that lives *inside* it (pan/zoom, an in-progress Select
  // Roads/Lasso selection, its own undo stack, an unconfirmed fence) even
  // though the road's actual saved data is untouched — indistinguishable
  // from "the save button ate my work." The `draftKey` change compounds
  // it: the restore-on-mount effect below re-runs against a brand new,
  // empty storage key, so even a draft that HAD been auto-saved a moment
  // earlier (under the old 'new-road' key) looks like it vanished —
  // "completely corrupted" from the outside, though the old entry was
  // never actually deleted, just orphaned under a key nothing looks at
  // again.
  //
  // Fix: mint one stable id per editor-session visit, set once in
  // openAddRoad/openEditRoad and never touched by saveRoad, and key BOTH
  // the map's `key` prop and its `draftKey` prop on that instead of
  // `editingRoad?.id` — one continuous identity across the null→created
  // transition for everything tied to "this editing session", not two
  // separately-drifting ones. Still remounts/starts a fresh draft
  // correctly when actually switching to a different road or opening a
  // new blank form — those are genuinely new sessions.
  const roadMapSessionKeyRef = useRef<string>('new-road');
  const openAddRoad = (areaId: string) => {
    roadMapSessionKeyRef.current = 'new-road-' + uid();
    setRoadForm(emptyRoad(areaId));
    setRoadPoints([]);
    setRoadSegments([[]]);
    setSegmentIds([uid()]);
    originalSegmentsRef.current = [];
    setSegmentNames(['']);
    setSegmentColors(['']);
    setRoadTurnarounds([[]]);
    setShowTurnaroundManager(false);
    setActiveSegIdx(0);
    setUseAreaColor(true);
    const area = sweepAreas.find(a => a.id === areaId);
    setRoadCustomColor(area?.color || '#6366F1');
    setRoadShowNumbers(true);
    setRoadShowMarkers(true);
    setEditingRoad(null);
    setRoadModalPos(null);
    setRoadSaved(false);
    setRoadNameError(false);
    setHasPendingSelection(false);
    setShowRoadForm(areaId);
  };
  const openEditRoad = (r: SweepRoad) => {
    roadMapSessionKeyRef.current = `road-${r.id}`;
    setRoadForm({ name: r.name, areaId: r.areaId, points: r.points, lengthMetres: r.lengthMetres, notes: r.notes });
    setRoadPoints([...r.points]);
    // Feature 3: load segments (points carry transitAfter flags directly)
    const segs = r.segments && r.segments.length > 0
      ? r.segments.map(s => [...s.points])
      : [[...(r.points || [])]];
    setRoadSegments(segs);
    // v73.25 — Bug #1 fix: carry over each segment's REAL id from storage
    // instead of letting saveRoad() mint a brand new one on the next save.
    // A road with no segments yet (legacy single-`points` road) gets one
    // fresh id here — that's a genuinely new segment being created.
    const ids = r.segments && r.segments.length > 0
      ? r.segments.map(s => s.id)
      : [uid()];
    setSegmentIds(ids.length === segs.length ? ids : segs.map(() => uid()));
    // v73.39 — snapshot for updatedAt diffing in saveRoad()
    originalSegmentsRef.current = (r.segments && r.segments.length > 0) ? r.segments : [];
    // Load segment names from saved labels, or default to empty strings
    const names = r.segments && r.segments.length > 0
      ? r.segments.map(s => s.label && !s.label.startsWith('Segment ') ? s.label : '')
      : [''];
    setSegmentNames(names.length === segs.length ? names : segs.map(() => ''));
    // Load per-segment colours
    const colors = r.segments && r.segments.length > 0
      ? r.segments.map(s => s.color || '')
      : [''];
    setSegmentColors(colors.length === segs.length ? colors : segs.map(() => ''));
    // v73.100 — load each segment's saved turnaround points, if any.
    const turns = r.segments && r.segments.length > 0
      ? r.segments.map(s => s.turnarounds ? [...s.turnarounds] : [])
      : [[]];
    setRoadTurnarounds(turns.length === segs.length ? turns : segs.map(() => []));
    setShowTurnaroundManager(false);
    setActiveSegIdx(0);
    // Feature 2: load color/numbers
    setUseAreaColor(!r.color);
    setRoadCustomColor(r.color || (() => { const a = sweepAreas.find(x => x.id === r.areaId); return a?.color || '#6366F1'; })());
    setRoadShowNumbers(r.showNumbers !== false);
    setRoadShowMarkers(r.showMarkers !== false);
    setEditingRoad(r);
    setRoadModalPos(null);
    setRoadSaved(false);
    setRoadNameError(false);
    setHasPendingSelection(false);
    setShowRoadForm(r.areaId);
  };
  const saveRoad = () => {
    if (!roadForm.name.trim()) { setRoadNameError(true); return; }
    setRoadNameError(false);
    // Pair each segment with its name/color/id, then filter empty segments.
    // v73.25 — Bug #1 fix: id now comes from segmentIds (stable across saves)
    // instead of a fresh uid() minted here every time — see segmentIds decl.
    const pairs = roadSegments.map((pts, i) => ({
      pts, name: segmentNames[i] ?? '', color: segmentColors[i] ?? '', id: segmentIds[i] || uid(),
    }));
    const validPairs = pairs.filter(p => p.pts.length > 0);
    const effectivePairs = validPairs.length > 0 ? validPairs : [{ pts: [] as RoadPoint[], name: '', color: '', id: segmentIds[0] || uid() }];
    const effectiveSegs = effectivePairs.map(p => p.pts);
    const effectiveNames = effectivePairs.map(p => p.name);
    const areaCol = sweepAreas.find(a => a.id === roadForm.areaId)?.color;
    // Strip segment colours that are still set to the area colour from a previous
    // "Use area colour" session — only keep colours the user explicitly changed.
    const effectiveColors = effectivePairs.map(p =>
      (!useAreaColor && p.color && p.color === areaCol) ? '' : p.color
    );
    // km: exclude edges where pts[i].transitAfter === true (invisible repositioning)
    const totalLen = effectiveSegs.reduce((total, pts) =>
      total + pts.reduce((s, p, i) => (i < pts.length - 1 && !p.transitAfter) ? s + haversine(p, pts[i + 1]) : s, 0)
    , 0);
    const firstPts = effectiveSegs[0] || [];
    // Build segment objects for storage — transitAfter lives on each RoadPoint
    // v73.39 — `updatedAt` is only bumped for a segment whose content
    // genuinely changed since it was loaded (or that's brand new) — an
    // untouched segment keeps its original timestamp. This is what makes
    // "newer wins" on the server actually mean something instead of tying
    // at blank forever (found while investigating a reported segment
    // duplication/content-loss issue — ids were already stable since v73.25,
    // but recency resolution for concurrent edits to the SAME segment id was
    // still effectively arbitrary without this).
    const segmentObjs: RouteSegment[] = effectiveSegs.map((pts, i) => {
      const id = effectivePairs[i].id;
      const label = (effectiveNames[i] && effectiveNames[i].trim()) ? effectiveNames[i].trim() : `Segment ${String.fromCharCode(65 + i)}`;
      const color = effectiveColors[i] || undefined;
      const original = originalSegmentsRef.current.find(s => s.id === id);
      // v73.100 — turnarounds participate in the same unchanged/updatedAt
      // diff as points/label/color, so a turnaround-only edit correctly
      // bumps updatedAt (and a segment with no turnaround changes at all
      // keeps its original timestamp, same reasoning as pointsDeepEqual's
      // own comment above).
      const segTurnarounds = roadTurnarounds[i] || [];
      const turnaroundsUnchanged = turnaroundsDeepEqual(original?.turnarounds, segTurnarounds);
      const unchanged = !!original
        && original.label === label
        && (original.color || undefined) === color
        && pointsDeepEqual(original.points, pts)
        && turnaroundsUnchanged;
      return {
        id, label, points: pts, color,
        turnarounds: segTurnarounds.length > 0 ? segTurnarounds : undefined,
        updatedAt: unchanged ? original!.updatedAt : new Date().toISOString(),
      };
    });
    const effectiveColor = useAreaColor ? undefined : roadCustomColor;
    const payload: Omit<SweepRoad, 'id' | 'createdAt' | 'updatedAt'> = {
      ...roadForm,
      points: firstPts,
      // Always store segments so per-segment colours survive single-segment roads
      segments: assertRouteSegmentsOnly(segmentObjs),
      lengthMetres: totalLen,
      color: effectiveColor,
      showNumbers: roadShowNumbers,
      showMarkers: roadShowMarkers,
    };
    if (editingRoad) {
      updateSweepRoad({ ...editingRoad, ...payload });
    } else {
      // addSweepRoad returns the persisted road (with real id/timestamps).
      // Switch to edit mode immediately so further saves update this road
      // instead of creating duplicates.
      const created = addSweepRoad(payload);
      setEditingRoad(created);
    }
    // v73.39 — snapshot what was just saved so a further save within this
    // same modal session diffs against it (not the original load) — keeps
    // `updatedAt` stable for segments that stay untouched across multiple
    // saves in a row.
    originalSegmentsRef.current = segmentObjs;
    // Do NOT close the modal — user explicitly closes with the Close button or ✕
    // v73.68 — REMOVED: this used to wipe roadSegments/segmentIds/segmentNames/
    // segmentColors back to a blank canvas on a brand-new road's FIRST save,
    // intended as "clean slate to draw the next road." Real bug found from
    // Craig's report ("save resets and clears everything") plus a screenshot-
    // matched repro: `editingRoad` here is still the value captured by THIS
    // render's closure — `setEditingRoad(created)` a few lines above only takes
    // effect on the NEXT render, so `if (!editingRoad)` was STILL true on the
    // very save that just created the road, wiping the just-drawn/just-selected
    // segments the instant they were saved. Every save after the first was fine
    // (editingRoad was genuinely non-null by then), which is exactly why it
    // looked random/first-save-only. The data itself was never actually lost
    // (save happens before this ran), but visually it was indistinguishable
    // from data loss and forced starting over. Fixed by simply not resetting —
    // a road's first save now behaves exactly like every save after it: the
    // map keeps showing what was just built, same as an existing road always has.
    setRoadSaved(true);
    setTimeout(() => setRoadSaved(false), 2500);
  };

  // v73.68 — "Split Segment by Street". Craig: doing a whole suburb as one
  // Select Roads/Lasso segment is what makes Find Long Jumps/Find Duplicate
  // Lines/Simplify Points get WORSE with every pass — a suburb's street
  // network is a branching graph, forced into a single greedy nearest-endpoint
  // chain it inevitably jumps between unrelated branches somewhere, and every
  // cleanup pass re-chains the remainder differently, creating new jumps that
  // weren't there before. The real fix is one segment per physical street —
  // this button does that automatically instead of requiring the whole
  // suburb to be redrawn by hand, street by street.
  // Groups the active segment's points into runs by `streetName` (tagged
  // during Select Roads/Lasso chaining — see mergeRoadFeaturesIntoPath) and
  // replaces the one oversized segment with one new segment per run, named
  // after the actual street. A run's total km is preserved exactly — the
  // shared boundary point between two consecutive runs is duplicated as the
  // first point of the next run so the connecting edge (which belonged to
  // neither run in the naive grouping) is still counted, not lost or
  // double-counted (it's the LAST point of the previous segment, and
  // reappears only as the FIRST point of the next one).
  // v73.97 — "Split by Street" removed entirely per Craig: "no longer
  // needed since OSRM was added... should be removed." It was originally a
  // pre-OSRM-era suggestion to help clean up road-data-only routing before
  // OSRM existed; Craig confirmed it never actually got used ("I didn't
  // know what it does as it never worked").

  const getRoadsForArea = (areaId: string) => sweepRoads.filter(r => r.areaId === areaId);

  // ── Zone CRUD ───────────────────────────────────────────────────────────────
  const getZonesForArea = (areaId: string) => sweepZones.filter(z => z.areaId === areaId);
  const openAddZone = (areaId: string) => {
    const area = sweepAreas.find(a => a.id === areaId);
    setZoneForm({ name: '', areaId, zoneKind: 'carpark', color: area?.color || '#0088ff', points: [], areaM2: 0, notes: '', fillEnabled: true, labelPos: null, subZones: [] });
    setZonePoints([]);
    setZoneSubZones([]);
    setActiveSubZoneIdx(-1);
    setEditingZone(null);
    setZoneNameError(false);
    setZoneSaved(false);
    setZoneModalPos(null);
    setShowZoneForm(areaId);
  };
  const openEditZone = (z: SweepZone) => {
    setZoneForm({
      name: z.name, areaId: z.areaId, zoneKind: z.zoneKind, color: z.color, points: z.points, areaM2: z.areaM2, notes: z.notes,
      fillEnabled: z.fillEnabled ?? true, labelPos: z.labelPos ?? null, subZones: z.subZones || [],
    });
    setZonePoints([...z.points]);
    setZoneSubZones((z.subZones || []).map(sz => ({ ...sz, points: [...sz.points] })));
    setActiveSubZoneIdx(-1);
    setEditingZone(z);
    setZoneNameError(false);
    setZoneSaved(false);
    setZoneModalPos(null);
    setShowZoneForm(z.areaId);
  };
  // v73.49 — Craig: "add extra sub zones in a main zone... like a segment."
  // Same shape (own id/color/points), same "+ Add" pattern already used
  // for road segments (see addSegment in the road form) — new sub-zone
  // starts empty and becomes the active one to draw immediately.
  const addSubZone = () => {
    const newSub: SweepSubZone = {
      id: uid(), name: '', points: [], color: zoneForm.color, fillEnabled: false,
      labelPos: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    setZoneSubZones(prev => [...prev, newSub]);
    setActiveSubZoneIdx(zoneSubZones.length); // index it'll have once the state above lands
  };
  const deleteSubZone = (idx: number) => {
    const sub = zoneSubZones[idx];
    if (!window.confirm(`Delete sub-zone "${sub.name || `#${idx + 1}`}"? This can't be undone.`)) return;
    setZoneSubZones(prev => prev.filter((_, i) => i !== idx));
    setActiveSubZoneIdx(-1);
  };
  // v73.50 — Craig: "want to be able to change a sub-zone's colour
  // independently... also need the option to delete points or undo a line
  // or redraw without deleting the whole sub zone and starting again."
  // Point-level delete already existed (right-click a vertex, see
  // ZoneEditorMap's contextmenu handler), but there was no way to undo the
  // last placed point or wipe just the drawn shape and start over WITHOUT
  // losing the sub-zone record itself (id/name/color) — the only prior
  // option was deleteSubZone, which throws the whole thing away. These two
  // act on whichever polygon (main zone or a sub-zone) is currently active,
  // mirroring the isSubActive/activePoints pattern already used below for
  // rendering the map.
  const isSubActiveForPoints = activeSubZoneIdx >= 0 && activeSubZoneIdx < zoneSubZones.length;
  const activePointsForUndo = isSubActiveForPoints ? (zoneSubZones[activeSubZoneIdx]?.points || []) : zonePoints;
  const undoLastPoint = () => {
    if (activePointsForUndo.length === 0) return;
    if (isSubActiveForPoints) {
      setZoneSubZones(prev => prev.map((sz, i) => i === activeSubZoneIdx ? { ...sz, points: sz.points.slice(0, -1) } : sz));
    } else {
      setZonePoints(prev => prev.slice(0, -1));
    }
  };
  const clearActivePoints = () => {
    if (activePointsForUndo.length === 0) return;
    const label = isSubActiveForPoints
      ? (zoneSubZones[activeSubZoneIdx]?.name.trim() || `Sub-Zone ${activeSubZoneIdx + 1}`)
      : 'the main zone boundary';
    if (!window.confirm(`Clear all points for ${label}? This removes the drawn shape only — the ${isSubActiveForPoints ? 'sub-zone' : 'zone'} itself (name, colour) stays, so you can redraw it right away.`)) return;
    if (isSubActiveForPoints) {
      setZoneSubZones(prev => prev.map((sz, i) => i === activeSubZoneIdx ? { ...sz, points: [] } : sz));
    } else {
      setZonePoints([]);
    }
  };
  const saveZone = () => {
    if (!zoneForm.name.trim()) { setZoneNameError(true); return; }
    if (zonePoints.length < 3) { alert('Draw at least 3 points to make a zone shape.'); return; }
    setZoneNameError(false);
    const now = new Date().toISOString();
    const payload: Omit<SweepZone, 'id' | 'createdAt' | 'updatedAt'> = {
      ...zoneForm,
      points: zonePoints,
      areaM2: polygonAreaM2(zonePoints),
      // v73.49 — sub-zones with fewer than 3 points are silently dropped
      // rather than saved broken — same floor the main zone itself already
      // enforces above. updatedAt refreshed on every save so
      // mergeSubArrayById (server.js) has a real, current timestamp to
      // resolve concurrent multi-device edits by, same as road segments.
      subZones: zoneSubZones.filter(sz => sz.points.length >= 3).map(sz => ({ ...sz, updatedAt: now })),
    };
    if (editingZone) {
      updateSweepZone({ ...editingZone, ...payload });
    } else {
      const created = addSweepZone(payload);
      setEditingZone(created);
    }
    setZoneSaved(true);
    setTimeout(() => setZoneSaved(false), 2500);
  };

  // Effective colour for the road form (used in the modal)
  const roadFormEffectiveColor = useAreaColor
    ? (sweepAreas.find(a => a.id === roadForm.areaId)?.color || '#6366F1')
    : roadCustomColor;

  // ── Job helpers ─────────────────────────────────────────────────────────────
  const totalSwept = (job: SweepJob) => job.roads.reduce((a, r) => a + (r.metresSwept || 0), 0);

  const openNewJob = () => {
    setJobForm({ ...emptyJob(), crewMember: currentUser?.name || '' });
    setEditingJob(null);
    setJobTab('info');
    setActiveRoadIdx(0);
    setJobView('form');
  };

  const openEditJob = (j: SweepJob) => {
    const legacyWeather: Record<string,string> = {
      clear: '☀️ Clear', cloudy: '☁️ Cloudy', light_rain: '🌦 Light Rain',
      heavy_rain: '🌧 Heavy Rain', windy: '💨 Windy',
    };
    const legacyDebris: Record<string,string> = { light: 'Light', moderate: 'Moderate', heavy: 'Heavy' };
    const legacyDamageType: Record<string,string> = {
      pothole: '🕳️ Pothole', kerb: '🧱 Kerb Damage', drainage: '💧 Drainage Issue',
      marking: '🚧 Marking Faded', other: '⚠️ Other',
    };
    const legacySeverity: Record<string,string> = {
      low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical',
    };
    setJobForm({
      jobNumber: j.jobNumber, title: j.title, status: j.status,
      clientId: j.clientId, siteId: j.siteId || '', areaIds: [...j.areaIds], zoneIds: [...(j.zoneIds || [])],
      roads: j.roads.map(jr => ({
        ...jr,
        debrisLevel: legacyDebris[jr.debrisLevel] ?? jr.debrisLevel,
        damagePins: jr.damagePins.map(p => ({
          ...p,
          damageType: p.damageType ? (legacyDamageType[p.damageType] ?? p.damageType) : p.damageType,
          severity: p.severity ? (legacySeverity[p.severity] ?? p.severity) : p.severity,
        })),
      })),
      crewMember: j.crewMember, equipment: j.equipment ?? '',
      date: j.date, startDate: j.startDate, finishDate: j.finishDate,
      startTime: j.startTime, endTime: j.endTime,
      weather: legacyWeather[j.weather] ?? j.weather,
      notes: j.notes, fileIds: [...(j.fileIds || [])],
      fuelDockets: [...(j.fuelDockets || [])],
      extraExpenses: [...(j.extraExpenses || [])],
      tipRuns: [...(j.tipRuns || [])],
    });
    setEditingJob(j);
    setJobTab('info');
    setActiveRoadIdx(0);
    setJobView('form');
  };

  const saveJob = (overrideStatus?: SweepJob['status']) => {
    if (!jobForm.title.trim()) { flash('⚠️ Job title is required'); return; }
    // Derive areaIds from selected roads (v29 fix)
    const derivedAreaIds = Array.from(new Set(
      jobForm.roads
        .map(jr => sweepRoads.find(r => r.id === jr.roadId)?.areaId)
        .filter((id): id is string => !!id)
    ));
    const mergedAreaIds = Array.from(new Set([...derivedAreaIds, ...jobForm.areaIds]));
    const payload = { ...jobForm, areaIds: mergedAreaIds, status: overrideStatus || jobForm.status };
    if (editingJob) {
      updateSweepJob({ ...editingJob, ...payload });
      flash('✅ Job saved — continue editing or press ← Back when done');
    } else {
      // Stay on form in edit mode — user can keep adding areas, roads, photos etc.
      const created = addSweepJob(payload);
      setEditingJob(created);
      setDetailJob(created);
      flash('✅ Job created — keep editing or press ← Back when done');
    }
  };

  // Toggle area in job — adds/removes all roads of that area
  const toggleAreaInJob = (areaId: string) => {
    const isIn = jobForm.areaIds.includes(areaId);
    if (isIn) {
      const areaRoadIds = getRoadsForArea(areaId).map(r => r.id);
      setJobForm(prev => ({
        ...prev,
        areaIds: prev.areaIds.filter(id => id !== areaId),
        roads: prev.roads.filter(jr => !areaRoadIds.includes(jr.roadId)),
      }));
    } else {
      const areaRoads = getRoadsForArea(areaId);
      const newJobRoads: SweepJobRoad[] = areaRoads
        .filter(r => !jobForm.roads.find(jr => jr.roadId === r.id))
        .map(r => emptyJobRoad(r.id, r));
      setJobForm(prev => ({
        ...prev,
        areaIds: [...prev.areaIds, areaId],
        roads: [...prev.roads, ...newJobRoads],
      }));
    }
  };

  // Toggle individual road in job
  const toggleRoadInJob = (road: SweepRoad) => {
    const isIn = jobForm.roads.find(jr => jr.roadId === road.id);
    if (isIn) {
      setJobForm(prev => ({ ...prev, roads: prev.roads.filter(jr => jr.roadId !== road.id) }));
    } else {
      setJobForm(prev => ({ ...prev, roads: [...prev.roads, emptyJobRoad(road.id, road)] }));
    }
  };

  // v73.51 — Craig: "zones is missing from edit sweep job." Mirrors
  // toggleRoadInJob exactly (a Zone has no per-job settings to seed the way
  // a Road does via emptyJobRoad — it's just a plain id-reference, same as
  // areaIds already was), just against jobForm.zoneIds instead of jobForm.roads.
  const toggleZoneInJob = (zoneId: string) => {
    const isIn = (jobForm.zoneIds || []).includes(zoneId);
    setJobForm(prev => ({
      ...prev,
      zoneIds: isIn ? (prev.zoneIds || []).filter(id => id !== zoneId) : [...(prev.zoneIds || []), zoneId],
    }));
  };

  const updateJobRoad = (idx: number, patch: Partial<SweepJobRoad>) => {
    setJobForm(prev => {
      const newRoads = prev.roads.map((jr, i) => {
        if (i !== idx) return jr;
        const updated = { ...jr, ...patch };
        // Auto-calc metresSwept based on coverageMethod
        if (patch.coverageMethod || patch.percentSwept !== undefined) {
          const road = sweepRoads.find(r => r.id === jr.roadId);
          const total = road?.lengthMetres || 0;
          if (updated.coverageMethod === 'full') updated.metresSwept = total;
          else if (updated.coverageMethod === 'percent') updated.metresSwept = total * ((updated.percentSwept || 0) / 100);
          else if (updated.coverageMethod === 'ab' && updated.startPoint && updated.endPoint)
            updated.metresSwept = haversine(updated.startPoint, updated.endPoint);
        }
        return updated;
      });
      const updatedForm = { ...prev, roads: newRoads };
      // v73.6: previously only auto-persisted to the store when damagePins
      // changed — every other Run Details field (coverage method, pass count,
      // debris level/type, weather, dates, notes) sat in local jobForm state
      // until the user explicitly hit Save. That meant Sweep Reports (which
      // correctly reacts to the global store) showed stale data for any of
      // those fields until a save happened — exactly Craig's "not live
      // updating" report. Now auto-persists on every change, same as
      // damagePins already did, so any edited job (one that already exists —
      // editingJob is unset for a brand-new unsaved job, correctly local-only
      // until its first Save) reflects immediately everywhere else.
      if (editingJob) {
        const mergedAreaIds = Array.from(new Set([
          ...newRoads.map(jr => sweepRoads.find(r => r.id === jr.roadId)?.areaId).filter((id): id is string => !!id),
          ...updatedForm.areaIds,
        ]));
        setTimeout(() => updateSweepJob({ ...editingJob, ...updatedForm, areaIds: mergedAreaIds, updatedAt: new Date().toISOString() }), 0);
      }
      return updatedForm;
    });
  };

  // Update a single segment's run details within a road
  const updateJobRoadSegment = (roadIdx: number, segIdx: number, updates: Partial<SegmentRunDetail>) => {
    setJobForm(prev => {
      const roads = prev.roads.map((jr, ri) => {
        if (ri !== roadIdx) return jr;
        const existing: SegmentRunDetail[] = jr.segmentSettings || [];
        const cur = existing.find(s => s.segIdx === segIdx) || {
          segIdx, coverageMethod: jr.coverageMethod, percentSwept: jr.percentSwept,
          fromLandmark: jr.fromLandmark, toLandmark: jr.toLandmark, visualNote: jr.visualNote,
          passCount: jr.passCount, debrisLevel: jr.debrisLevel, debrisType: jr.debrisType, weather: jr.weather,
          startDate: jr.startDate, startTime: jr.startTime, finishDate: jr.finishDate,
          finishTime: jr.finishTime, notes: jr.notes,
        };
        const updated = { ...cur, ...updates };
        const newSettings = [...existing.filter(s => s.segIdx !== segIdx), updated];

        // Recalculate road-level metresSwept by summing each segment's contribution
        // so the Distance Swept display stays correct after each per-segment change.
        const roadDef = sweepRoads.find(r => r.id === jr.roadId);
        const segs = roadDef?.segments || [];
        let totalMetres = 0;
        if (segs.length > 1) {
          // Multi-segment: sum each non-transit segment's distance × coverage fraction
          segs.forEach((seg, si) => {
            if (seg.transit) return;
            const segPts = seg.points || [];
            let segLen = 0;
            for (let pi = 1; pi < segPts.length; pi++) segLen += haversine(segPts[pi - 1], segPts[pi]);
            const ss = newSettings.find(s => s.segIdx === si) || cur;
            const method = si === segIdx ? updated.coverageMethod : ss.coverageMethod;
            const pct    = si === segIdx ? updated.percentSwept   : ss.percentSwept;
            if (method === 'full')    totalMetres += segLen;
            else if (method === 'percent') totalMetres += segLen * ((pct || 0) / 100);
            // ab / landmark / visual: no auto-calculation for segments; keep as 0 until saved
          });
        } else {
          // Single-segment road: use road-level length × percent
          const total = roadDef?.lengthMetres || 0;
          const method = updated.coverageMethod;
          const pct    = updated.percentSwept;
          if (method === 'full')    totalMetres = total;
          else if (method === 'percent') totalMetres = total * ((pct || 0) / 100);
          else totalMetres = jr.metresSwept; // keep existing for ab/landmark/visual
        }

        return { ...jr, segmentSettings: newSettings, metresSwept: totalMetres };
      });
      const updatedForm = { ...prev, roads };
      // v73.6: this function had NO auto-persist at all before — every
      // multi-segment road's Run Details field (the dropdowns this whole tab
      // is for) only ever reached the store on an explicit Save. Same fix and
      // reasoning as updateJobRoad above.
      if (editingJob) {
        const mergedAreaIds = Array.from(new Set([
          ...roads.map(jr => sweepRoads.find(r => r.id === jr.roadId)?.areaId).filter((id): id is string => !!id),
          ...updatedForm.areaIds,
        ]));
        setTimeout(() => updateSweepJob({ ...editingJob, ...updatedForm, areaIds: mergedAreaIds, updatedAt: new Date().toISOString() }), 0);
      }
      return updatedForm;
    });
  };

  const activeJobRoad = jobForm.roads[activeRoadIdx];
  const activeRoadDef = activeJobRoad ? sweepRoads.find(r => r.id === activeJobRoad.roadId) : undefined;

  // PERF FIX (v73.35): this is a ~5,800-line component where a single
  // setState anywhere (e.g. typing in the job-edit form) re-renders the
  // whole component. filteredJobs was recomputed — filter + sort over the
  // full sweepJobs array — on every one of those renders, even ones with
  // nothing to do with the job list (e.g. editing a damage pin note).
  // Memoized so it's only recomputed when the jobs list, search text, or
  // status filter actually change.
  const filteredJobs = useMemo(() => sweepJobs.filter(j => {
    const matchesSearch = j.title.toLowerCase().includes(jobSearch.toLowerCase()) ||
      j.jobNumber.toLowerCase().includes(jobSearch.toLowerCase());
    const matchesStatus = statusFilter === 'all' || j.status === statusFilter;
    return matchesSearch && matchesStatus;
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [sweepJobs, jobSearch, statusFilter]);

  const statusColor = (s: string) => ({
    planned:     'bg-gray-100 text-gray-700 border border-gray-300',
    in_progress: 'bg-blue-100 text-blue-700 border border-blue-200',
    completed:   'bg-emerald-100 text-emerald-700 border border-emerald-200',
  }[s] || 'bg-gray-100 text-gray-600');

  const statusLabel = (s: string) => ({
    planned:     '📅 Planned',
    in_progress: '🔄 In Progress',
    completed:   '✅ Completed',
  }[s] || s);

  // ══════════════════════════════════════════════════════════
  // DETAIL VIEW
  // ══════════════════════════════════════════════════════════
  if (jobView === 'detail' && detailJob) {
    // Always read fresh data from the store so edits are reflected immediately
    const freshDetailJob = sweepJobs.find(j => j.id === detailJob.id) || detailJob;
    const client = (data.sweepClients || []).find(c => c.id === freshDetailJob.clientId);
    const jobTotalMetres = totalSwept(freshDetailJob);
    const allDamagePins = freshDetailJob.roads.flatMap(jr => jr.damagePins);
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4 flex-wrap">
          <button onClick={() => setJobView('list')} className="btn-secondary">← Back</button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{freshDetailJob.title}</h1>
            <p className="text-gray-500 text-sm">#{freshDetailJob.jobNumber}</p>
          </div>
          <span className={`badge ${statusColor(freshDetailJob.status)}`}>{statusLabel(freshDetailJob.status)}</span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            {/* Summary cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Roads Swept', value: freshDetailJob.roads.length, icon: '🛣️', color: 'bg-indigo-50 text-indigo-700' },
                { label: 'Total Distance', value: fmtMetres(jobTotalMetres), icon: '📏', color: 'bg-emerald-50 text-emerald-700' },
                { label: 'Damage Pins', value: allDamagePins.length, icon: '⚠️', color: 'bg-red-50 text-red-700' },
                { label: 'Duration', value: freshDetailJob.startTime && freshDetailJob.endTime ? `${freshDetailJob.startTime}–${freshDetailJob.endTime}` : '—', icon: '⏱️', color: 'bg-amber-50 text-amber-700' },
              ].map(s => (
                <div key={s.label} className={`${s.color} rounded-xl p-3 text-center`}>
                  <div className="text-xl mb-1">{s.icon}</div>
                  <div className="font-bold text-sm">{s.value}</div>
                  <div className="text-xs opacity-70">{s.label}</div>
                </div>
              ))}
            </div>

            {/* Job Info */}
            <div className="card">
              <h2 className="font-semibold text-gray-900 mb-3">Job Details</h2>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-gray-500">Date:</span> <span className="font-medium ml-1">{freshDetailJob.date}</span></div>
                <div><span className="text-gray-500">Crew:</span> <span className="font-medium ml-1">{freshDetailJob.crewMember || '—'}</span></div>
                {client && <div><span className="text-gray-500">Client:</span> <span className="font-medium ml-1">{client.name}</span></div>}
                {freshDetailJob.siteId && (() => { const site = (data.sweepJobSites||[]).find(s => s.id === freshDetailJob.siteId); return site ? <div><span className="text-gray-500">Site:</span> <span className="font-medium ml-1">{site.name}</span></div> : null; })()}
                {freshDetailJob.weather && <div><span className="text-gray-500">Weather:</span> <span className="font-medium ml-1">{weatherLabel(freshDetailJob.weather)}</span></div>}
                {freshDetailJob.startTime && <div><span className="text-gray-500">Start:</span> <span className="font-medium ml-1">{freshDetailJob.startTime}</span></div>}
                {freshDetailJob.endTime && <div><span className="text-gray-500">End:</span> <span className="font-medium ml-1">{freshDetailJob.endTime}</span></div>}
              </div>
              {freshDetailJob.notes && <p className="mt-3 p-3 bg-gray-50 rounded-lg text-sm text-gray-700">{freshDetailJob.notes}</p>}
            </div>

            {/* Roads */}
            {/* ── Road selector + single large map (matches Road Detail tab layout) ── */}
            {(() => {
              const safeIdx = Math.min(activeOverviewRoadIdx, freshDetailJob.roads.length - 1);
              const activeJr = freshDetailJob.roads[safeIdx];
              const activeRd = activeJr ? sweepRoads.find(r => r.id === activeJr.roadId) : undefined;
              const activeArea = activeRd ? sweepAreas.find(a => a.id === activeRd.areaId) : undefined;
              const effColor = activeRd ? getEffectiveColor(activeRd, activeArea?.color) : '#6366F1';
              return (
                <div className="card space-y-4">
                  {/* Road selector tabs */}
                  <div className="flex flex-wrap gap-2">
                    {freshDetailJob.roads.map((jr, idx) => {
                      const road = sweepRoads.find(r => r.id === jr.roadId);
                      const area = road ? sweepAreas.find(a => a.id === road.areaId) : undefined;
                      return (
                        <button key={jr.roadId + idx} onClick={() => setActiveOverviewRoadIdx(idx)}
                          className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition ${safeIdx === idx ? 'bg-orange-600 text-white border-orange-600' : 'bg-white text-gray-600 border-gray-300 hover:border-orange-400'}`}>
                          <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: area?.color || '#6366F1', verticalAlign: 'middle' }} />
                          {road?.name || 'Road'}
                          {jr.damagePins.length > 0 && <span className="ml-1.5 bg-red-100 text-red-700 text-xs px-1.5 rounded-full">{jr.damagePins.length}</span>}
                        </button>
                      );
                    })}
                  </div>

                  {/* Road detail info strip */}
                  {activeJr && activeRd && (() => {
                    // BUG FIX (Craig-reported, v73.9): this strip used to read
                    // activeJr.coverageMethod/passCount/debrisLevel directly —
                    // meaningless/stale for a multi-segment road, since that
                    // data lives in activeJr.segmentSettings[] instead (see
                    // utils/segmentStats.ts for the full explanation). Now
                    // shows a segment-aware summary either way.
                    const entries = getRoadRunEntries(activeJr, activeRd);
                    const isSeg = hasSegmentRunData(activeJr, activeRd);
                    const summary = summariseRunEntries(entries);
                    const segDates = isSeg ? (activeJr.segmentSettings || []) : [];
                    const earliestStart = isSeg ? segDates.filter(s => s.startDate).sort((a, b) => (a.startDate! < b.startDate! ? -1 : 1))[0] : undefined;
                    const latestFinish = isSeg ? segDates.filter(s => s.finishDate).sort((a, b) => (a.finishDate! > b.finishDate! ? -1 : 1))[0] : undefined;
                    return (
                      <div className="flex flex-wrap gap-4 text-sm bg-gray-50 rounded-xl px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: activeArea?.color || '#6366F1' }} />
                          <span className="font-semibold text-gray-900">{activeRd.name}</span>
                          {activeArea && <span className="badge bg-gray-100 text-gray-600 text-xs">{activeArea.name}</span>}
                          {isSeg && <span className="badge bg-blue-100 text-blue-600 text-xs">{entries.length} segments</span>}
                        </div>
                        <span className="badge bg-indigo-100 text-indigo-700 text-xs">📏 {fmtMetres(activeJr.metresSwept)}</span>
                        <span className="text-xs text-gray-600">Coverage: <strong>{summary.coverage}</strong></span>
                        <span className="text-xs text-gray-600">Passes: <strong>{summary.passCount}</strong></span>
                        <span className="text-xs text-gray-600">Debris: <strong>{debrisLabel(summary.debris)}</strong>{summary.debrisType !== '—' ? ` (${summary.debrisType})` : ''}</span>
                        {!isSeg && activeJr.startDate && <span className="text-xs text-gray-600">📅 <strong>{activeJr.startDate}{activeJr.startTime ? ` ${to12h(activeJr.startTime)}` : ''}</strong></span>}
                        {!isSeg && activeJr.finishDate && <span className="text-xs text-gray-600">🏁 <strong>{activeJr.finishDate}{activeJr.finishTime ? ` ${to12h(activeJr.finishTime)}` : ''}</strong></span>}
                        {isSeg && earliestStart && <span className="text-xs text-gray-600">📅 <strong>{earliestStart.startDate}{earliestStart.startTime ? ` ${to12h(earliestStart.startTime)}` : ''}</strong></span>}
                        {isSeg && latestFinish && <span className="text-xs text-gray-600">🏁 <strong>{latestFinish.finishDate}{latestFinish.finishTime ? ` ${to12h(latestFinish.finishTime)}` : ''}</strong></span>}
                      </div>
                    );
                  })()}
                  {activeJr?.notes && <p className="text-xs text-gray-500 px-1 italic">{activeJr.notes}</p>}

                  {/* Large map — same style as Road Detail tab */}
                  {activeRd && activeRd.points.length > 1 ? (() => {
                    const segs = getRoadSegments(activeRd);
                    return (
                      <div>
                        <RoadMap points={segs[0] || []} onChange={() => {}} readOnly
                          color={effColor} height={560}
                          showNumbers={activeRd.showNumbers !== false}
                          showMarkers={activeRd.showMarkers !== false}
                          extraSegments={segs.slice(1)} />
                      </div>
                    );
                  })() : activeRd ? (
                    <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-700">
                      ⚠️ <strong>{activeRd.name}</strong> has no route drawn yet. Go to Areas & Roads to draw the route.
                    </div>
                  ) : null}

                  {/* Damage pins for selected road */}
                  {activeJr && activeJr.damagePins.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-gray-600 mb-2">⚠️ {activeJr.damagePins.length} damage pin{activeJr.damagePins.length !== 1 ? 's' : ''}</p>
                      <div className="space-y-2">
                        {activeJr.damagePins.map(pin => (
                          <div key={pin.id} className="flex items-start gap-2 p-2 bg-red-50 rounded-lg border border-red-100">
                            {pin.photo && <img src={pin.photo} alt="" className="w-12 h-12 rounded object-cover shrink-0" />}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium">{pin.label}</span>
                                {pin.damageType && <span className="badge bg-red-100 text-red-700 text-xs">{pin.damageType}</span>}
                                {pin.severity && <span className="text-xs font-bold" style={{ color: getSeverityColor(pin.severity) }}>{pin.severity}</span>}
                              </div>
                              {pin.description && <p className="text-xs text-gray-600 mt-0.5">{pin.description}</p>}
                              <p className="text-xs text-gray-400">{pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Sidebar */}
          <div className="space-y-4">
            <button onClick={() => openEditJob(detailJob)} className="btn-primary w-full">✏️ Edit Job</button>
            <button onClick={() => {
              if (freshDetailJob.status !== 'completed') {
                updateSweepJob({ ...detailJob, status: 'completed' });
                setDetailJob({ ...detailJob, status: 'completed' });
              }
            }} disabled={freshDetailJob.status === 'completed'} className="btn-success w-full disabled:opacity-50">
              ✅ Mark Completed
            </button>
            <button onClick={() => {
              if (confirm('Delete this sweep job?')) { deleteSweepJob(detailJob.id); setJobView('list'); }
            }} className="btn-danger w-full">🗑️ Delete Job</button>

            {/* Areas in job */}
            <div className="card">
              <h3 className="font-semibold text-gray-900 mb-2">Areas</h3>
              {freshDetailJob.areaIds.map(aid => {
                const area = sweepAreas.find(a => a.id === aid);
                return area ? (
                  <div key={aid} className="flex items-center gap-2 mb-1">
                    <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: area.color }} />
                    <span className="text-sm text-gray-700">{area.name}</span>
                  </div>
                ) : null;
              })}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════
  // JOB FORM VIEW
  // ══════════════════════════════════════════════════════════
  if (jobView === 'form') {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4 flex-wrap">
          <button onClick={() => setJobView('list')} className="btn-secondary">← Back</button>
          <h1 className="text-2xl font-bold text-gray-900">{editingJob ? 'Edit Sweep Job' : 'New Sweep Job'}</h1>
        </div>

        {msg && (
          <div className={`p-3 rounded-xl text-sm border ${msg.startsWith('✅') ? 'bg-green-50 border-green-200 text-green-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
            {msg}
          </div>
        )}

        {/* Tab bar */}
        <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit flex-wrap">
          {[
            { id: 'info',          label: '📋 Job Info' },
            { id: 'roads',         label: `🛣️ Roads (${jobForm.roads.length})` },
            { id: 'zones',         label: `📍 Zones (${(jobForm.zoneIds || []).length})` },
            { id: 'quicksettings', label: '🗒️ Sweep Run Details' },
            { id: 'overview',      label: '🗺️ Route Map' },
            { id: 'map',           label: '⚠️ Road Damage / Warning Pins' },
            { id: 'fuel',     label: `⛽ Fuel (${(jobForm.fuelDockets || []).length})` },
            { id: 'expenses', label: `💲 Expenses (${(jobForm.extraExpenses || []).length})` },
            { id: 'tip',      label: `🗑️ Tip Runs (${(jobForm.tipRuns || []).reduce((s, r) => s + r.trips.length, 0)})` },
          ].map(t => (
            <button key={t.id} onClick={() => setJobTab(t.id as typeof jobTab)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition ${jobTab === t.id ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">

            {/* ── INFO TAB ── */}
            {jobTab === 'info' && (
              <div className="card space-y-4">
                <h2 className="font-semibold text-gray-900">Job Information</h2>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Job Title *</label>
                    <input className="input-field" value={jobForm.title} placeholder="e.g. Area 1 Weekly Sweep"
                      onChange={e => setJobForm(p => ({ ...p, title: e.target.value }))} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Job Number</label>
                    <input className="input-field font-mono text-sm" value={jobForm.jobNumber}
                      onChange={e => setJobForm(p => ({ ...p, jobNumber: e.target.value }))} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
                    <input className="input-field" type="date" value={jobForm.date}
                      onChange={e => setJobForm(p => ({ ...p, date: e.target.value }))} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Crew Member</label>
                    {(() => {
                      const crewItems = (data.sweepCategories || []).filter(c => c.categoryType === 'crew_member').flatMap(c => c.items);
                      return (
                        <select className="input-field" value={jobForm.crewMember}
                          onChange={e => setJobForm(p => ({ ...p, crewMember: e.target.value }))}>
                          <option value="">— Select crew member —</option>
                          {crewItems.map(i => <option key={i.id} value={i.name}>{i.name}{i.description ? ` (${i.description})` : ''}</option>)}
                          {crewItems.length === 0 && <option disabled>Add crew in SW Categories → Crew Members</option>}
                        </select>
                      );
                    })()}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Equipment / Vehicle</label>
                    {(() => {
                      const equipItems = (data.sweepCategories || []).filter(c => c.categoryType === 'equipment').flatMap(c => c.items);
                      return (
                        <select className="input-field" value={jobForm.equipment ?? ''}
                          onChange={e => setJobForm(p => ({ ...p, equipment: e.target.value }))}>
                          <option value="">— Select equipment —</option>
                          {equipItems.map(i => <option key={i.id} value={i.name}>{i.name}{i.description ? ` (${i.description})` : ''}</option>)}
                          {equipItems.length === 0 && <option disabled>Add equipment in SW Categories first</option>}
                        </select>
                      );
                    })()}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Start Time</label>
                    <input className="input-field" type="time" value={jobForm.startTime}
                      onChange={e => setJobForm(p => ({ ...p, startTime: e.target.value }))} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">End Time</label>
                    <input className="input-field" type="time" value={jobForm.endTime}
                      onChange={e => setJobForm(p => ({ ...p, endTime: e.target.value }))} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Client</label>
                    <select className="input-field" value={jobForm.clientId}
                      onChange={e => setJobForm(p => ({ ...p, clientId: e.target.value }))}>
                      <option value="">No client assigned</option>
                      {(data.sweepClients || []).map(c => <option key={c.id} value={c.id}>{c.name}{c.company ? ` (${c.company})` : ''}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Job Site</label>
                  <select className="input-field" value={jobForm.siteId}
                    onChange={e => setJobForm(p => ({ ...p, siteId: e.target.value }))}>
                    <option value="">No site linked</option>
                    {(data.sweepJobSites || []).map(s => <option key={s.id} value={s.id}>{s.name}{s.address ? ` — ${s.address}` : ''}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                  <textarea className="input-field" rows={3} value={jobForm.notes} placeholder="General job notes"
                    onChange={e => setJobForm(p => ({ ...p, notes: e.target.value }))} />
                </div>

                {/* Job Start / Finish Dates */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">📅 Start Date</label>
                    <input type="date" className="input-field"
                      value={toInputDate(jobForm.startDate)}
                      onChange={e => setJobForm(p => ({ ...p, startDate: fromInputDate(e.target.value) }))} />
                    {jobForm.startDate && <p className="text-xs text-gray-400 mt-0.5">{jobForm.startDate}</p>}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">🏁 Finish Date</label>
                    <input type="date" className="input-field"
                      value={toInputDate(jobForm.finishDate)}
                      onChange={e => setJobForm(p => ({ ...p, finishDate: fromInputDate(e.target.value) }))} />
                    {jobForm.finishDate && <p className="text-xs text-gray-400 mt-0.5">{jobForm.finishDate}</p>}
                    {jobForm.startDate && jobForm.finishDate && dateAfter(jobForm.startDate, jobForm.finishDate) && (
                      <p className="text-xs text-red-500 mt-1">⚠️ Finish date is before start date</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ── ROADS TAB ── */}
            {jobTab === 'roads' && (
              <div className="space-y-4">
                <div className="card">
                  <h2 className="font-semibold text-gray-900 mb-3">Select Areas & Roads</h2>
                  {sweepAreas.length === 0 ? (
                    <p className="text-gray-400 text-sm text-center py-4">
                      No areas set up yet. Go to <button onClick={() => setTab('areas')} className="text-indigo-600 underline">Areas & Roads</button> to create them first.
                    </p>
                  ) : sweepAreas.map(area => {
                    const areaRoads = getRoadsForArea(area.id);
                    const areaInJob = jobForm.areaIds.includes(area.id);
                    return (
                      <div key={area.id} className="mb-4 border border-gray-200 rounded-xl overflow-hidden">
                        <div className="flex items-center gap-3 p-3 bg-gray-50">
                          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: area.color }} />
                          <span className="font-semibold text-gray-900">{area.name}</span>
                          <span className="text-xs text-gray-500">{areaRoads.length} road{areaRoads.length !== 1 ? 's' : ''}</span>
                          <button onClick={() => toggleAreaInJob(area.id)}
                            className={`ml-auto text-xs px-3 py-1 rounded-lg border font-medium transition ${areaInJob ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-300 hover:border-indigo-400'}`}>
                            {areaInJob ? '✓ All Selected' : 'Add All'}
                          </button>
                        </div>
                        <div className="divide-y divide-gray-100">
                          {areaRoads.map(road => {
                            const inJob = !!jobForm.roads.find(jr => jr.roadId === road.id);
                            return (
                              <div key={road.id} className="flex items-center gap-3 px-4 py-2.5">
                                <input type="checkbox" checked={inJob}
                                  onChange={() => toggleRoadInJob(road)}
                                  className="w-4 h-4 rounded accent-indigo-600" />
                                <span className="text-sm text-gray-900">{road.name}</span>
                                <span className="text-xs text-gray-400 ml-auto">{roadHasRoute(road) ? fmtMetres(road.lengthMetres) : 'No route drawn'}</span>
                              </div>
                            );
                          })}
                          {areaRoads.length === 0 && (
                            <p className="text-xs text-gray-400 px-4 py-3">No roads in this area yet.</p>
                          )}
                        </div>
                        {/* v73.63 — Craig: moved to its own Zones tab (was nested here per-area, see below) */}
                      </div>
                    );
                  })}
                </div>

              </div>
            )}

            {/* ── ZONES TAB — v73.63: split out of Roads tab into its own tab ── */}
            {jobTab === 'zones' && (
              <div className="space-y-4">
                <div className="card">
                  <h2 className="font-semibold text-gray-900 mb-3">Select Zones</h2>
                  {sweepAreas.length === 0 ? (
                    <p className="text-gray-400 text-sm text-center py-4">
                      No areas set up yet. Go to <button onClick={() => setTab('areas')} className="text-indigo-600 underline">Areas & Roads</button> to create them first.
                    </p>
                  ) : sweepAreas.every(area => getZonesForArea(area.id).length === 0) ? (
                    <p className="text-gray-400 text-sm text-center py-4">No zones drawn yet in any area.</p>
                  ) : sweepAreas.map(area => {
                    const areaZones = getZonesForArea(area.id);
                    if (areaZones.length === 0) return null;
                    return (
                      <div key={area.id} className="mb-4 border border-gray-200 rounded-xl overflow-hidden">
                        <div className="flex items-center gap-3 p-3 bg-gray-50">
                          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: area.color }} />
                          <span className="font-semibold text-gray-900">{area.name}</span>
                          <span className="text-xs text-gray-500">{areaZones.length} zone{areaZones.length !== 1 ? 's' : ''}</span>
                        </div>
                        <div className="divide-y divide-gray-100">
                          {areaZones.map(zone => {
                            const inJob = (jobForm.zoneIds || []).includes(zone.id);
                            return (
                              <div key={zone.id} className="flex items-center gap-3 px-4 py-2.5">
                                <input type="checkbox" checked={inJob}
                                  onChange={() => toggleZoneInJob(zone.id)}
                                  className="w-4 h-4 rounded accent-indigo-600" />
                                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: zone.color }} />
                                <span className="text-sm text-gray-900">{zoneKindIcon(zone.zoneKind)} {zone.name}</span>
                                <span className="text-xs text-gray-400 ml-auto">{fmtZoneArea(zone.areaM2)}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── QUICK SETTINGS PER ROAD TAB ── */}
            {jobTab === 'quicksettings' && (
              <div className="space-y-4 pb-4">
                {jobForm.roads.length === 0 ? (
                  <div className="card text-center py-10 text-gray-400 text-sm">
                    No roads selected yet. Add roads in the Roads tab first.
                  </div>
                ) : (
                  <div className="card space-y-4">
                    <h2 className="font-semibold text-gray-900">🗒️ Sweep Run Details</h2>
                    {jobForm.roads.map((jr, roadIdx) => {
                      const road = sweepRoads.find(r => r.id === jr.roadId);
                      const area = road ? sweepAreas.find(a => a.id === road.areaId) : undefined;
                      const segments = (road?.segments && road.segments.length > 0)
                        ? road.segments
                        : [{ label: road?.name || 'Full Road', points: road?.points || [], color: road?.color || area?.color || '#6366F1', transit: false }];
                      const isMultiSeg = road?.segments && road.segments.length > 1;

                      // Get or init per-segment setting
                      const getSegSetting = (sIdx: number): SegmentRunDetail => {
                        const saved = (jr.segmentSettings || []).find(s => s.segIdx === sIdx);
                        return saved || {
                          segIdx: sIdx, coverageMethod: jr.coverageMethod,
                          percentSwept: jr.percentSwept, fromLandmark: jr.fromLandmark,
                          toLandmark: jr.toLandmark, visualNote: jr.visualNote,
                          passCount: jr.passCount, debrisLevel: jr.debrisLevel, debrisType: jr.debrisType,
                          weather: jr.weather, startDate: jr.startDate, startTime: jr.startTime,
                          finishDate: jr.finishDate, finishTime: jr.finishTime, notes: jr.notes,
                        };
                      };

                      const segKm = (sIdx: number) => {
                        if (!road?.segments?.[sIdx]) return jr.metresSwept;
                        const pts = road.segments[sIdx].points;
                        let d = 0;
                        for (let pi = 1; pi < pts.length; pi++) d += haversine(pts[pi-1], pts[pi]);
                        return d;
                      };

                      const passCountItems  = (data.sweepCategories || []).filter(c => c.categoryType === 'pass_count').flatMap(c => c.items);
                      const debrisItems     = (data.sweepCategories || []).filter(c => c.categoryType === 'debris_level').flatMap(c => c.items);
                      const debrisTypeItems = (data.sweepCategories || []).filter(c => c.categoryType === 'debris_type').flatMap(c => c.items);
                      const weatherItems    = (data.sweepCategories || []).filter(c => c.categoryType === 'weather').flatMap(c => c.items);

                      return (
                        <div key={jr.roadId + roadIdx} className="border border-gray-200 rounded-xl overflow-hidden">
                          {/* Road header */}
                          <div className="flex items-center gap-2 px-4 py-3 bg-gray-50 border-b border-gray-200">
                            <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: area?.color || '#6366F1' }} />
                            <span className="font-semibold text-gray-900">{road?.name || 'Unknown Road'}</span>
                            {area && <span className="text-xs text-gray-400">{area.name}</span>}
                            {jr.damagePins.length > 0 && (
                              <span className="text-xs text-red-600 font-medium ml-1">⚠️ {jr.damagePins.length} pin{jr.damagePins.length !== 1 ? 's' : ''}</span>
                            )}
                            <button onClick={() => { setActiveRoadIdx(roadIdx); setJobTab('map'); }}
                              className="ml-auto text-xs text-indigo-600 hover:underline shrink-0">🗺️ Add Damage Pins →</button>
                          </div>

                          {/* One section per segment */}
                          {segments.map((seg, sIdx) => {
                            if (seg.transit) return null; // skip invisible transit segments
                            const ss = getSegSetting(sIdx);
                            const segColor = seg.color || area?.color || '#6366F1';
                            const segLabel = seg.label?.trim() || ('Segment ' + String.fromCharCode(65 + sIdx));
                            const km = segKm(sIdx);

                            const upd = (patch: Partial<SegmentRunDetail>) => {
                              if (isMultiSeg) updateJobRoadSegment(roadIdx, sIdx, patch);
                              else updateJobRoad(roadIdx, patch as Partial<SweepJobRoad>);
                            };

                            return (
                              <div key={sIdx} className={'p-4 space-y-3' + (sIdx > 0 ? ' border-t border-gray-100' : '')}>
                                {/* Segment label */}
                                {isMultiSeg && (
                                  <div className="flex items-center gap-2 mb-1">
                                    <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: segColor }} />
                                    <span className="font-semibold text-gray-800 text-sm">{segLabel}</span>
                                    {km > 0 && <span className="text-xs text-indigo-600 font-medium">{fmtMetres(km)}</span>}
                                    {seg.label && seg.label.trim() !== segLabel && (
                                      <span className="text-xs text-gray-400 italic">{seg.label}</span>
                                    )}
                                  </div>
                                )}

                                {/* Coverage Method */}
                                <div>
                                  <label className="block text-xs font-medium text-gray-700 mb-1">Coverage Method</label>
                                  <div className="flex flex-wrap gap-1.5">
                                    {([
                                      { v: 'full',    l: '✅ Full Road' },
                                      { v: 'percent', l: '% Swept' },
                                      { v: 'ab',      l: '📍 A→B Points' },
                                      { v: 'landmark',l: '🏠 Landmark' },
                                      { v: 'visual',  l: '👁 Visual Note' },
                                    ] as const).map(opt => (
                                      <button key={opt.v} onClick={() => upd({ coverageMethod: opt.v })}
                                        className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${ss.coverageMethod === opt.v ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-300'}`}>
                                        {opt.l}
                                      </button>
                                    ))}
                                  </div>
                                </div>

                                {ss.coverageMethod === 'percent' && (
                                  <div className="flex items-center gap-3">
                                    <input type="range" min={0} max={100} step={1} value={ss.percentSwept || 0}
                                      onChange={e => {
                                        const pct = +e.target.value;
                                        upd({ percentSwept: pct, coverageMethod: 'percent' });
                                      }}
                                      className="flex-1 accent-indigo-600" />
                                    <span className="text-sm font-bold text-gray-900 w-12 text-right">{ss.percentSwept || 0}%</span>
                                  </div>
                                )}
                                {ss.coverageMethod === 'landmark' && (
                                  <div className="grid grid-cols-2 gap-2">
                                    <input className="input-field text-sm" placeholder="From landmark" value={ss.fromLandmark || ''}
                                      onChange={e => upd({ fromLandmark: e.target.value })} />
                                    <input className="input-field text-sm" placeholder="To landmark" value={ss.toLandmark || ''}
                                      onChange={e => upd({ toLandmark: e.target.value })} />
                                  </div>
                                )}
                                {ss.coverageMethod === 'visual' && (
                                  <textarea className="input-field text-sm" rows={2} placeholder="Describe what was swept…"
                                    value={ss.visualNote || ''} onChange={e => upd({ visualNote: e.target.value })} />
                                )}

                                <div className="grid grid-cols-2 gap-3">
                                  <div>
                                    <label className="block text-xs font-medium text-gray-700 mb-1">Pass Count</label>
                                    <select className="input-field text-sm" value={ss.passCount}
                                      onChange={e => upd({ passCount: +e.target.value })}>
                                      {passCountItems.length > 0
                                        ? passCountItems.map(item => {
                                            const n = parseInt(item.name, 10);
                                            const lbl = isNaN(n) ? item.name : `${n}${n===1?'st':n===2?'nd':n===3?'rd':'th'} pass`;
                                            return <option key={item.id} value={isNaN(n) ? item.name : n}>{lbl}</option>;
                                          })
                                        : [1,2,3,4,5].map(n => <option key={n} value={n}>{n}{n===1?'st':n===2?'nd':n===3?'rd':'th'} pass</option>)
                                      }
                                    </select>
                                  </div>
                                  <div>
                                    <label className="block text-xs font-medium text-gray-700 mb-1">Debris Level</label>
                                    <select className="input-field text-sm" value={ss.debrisLevel}
                                      onChange={e => upd({ debrisLevel: e.target.value })}>
                                      <option value="">Not recorded</option>
                                      {debrisItems.length > 0
                                        ? debrisItems.map(i => <option key={i.id} value={i.name}>{i.name}</option>)
                                        : (<><option value="Light">🟢 Light</option><option value="Moderate">🟡 Moderate</option><option value="Heavy">🔴 Heavy</option></>)
                                      }
                                    </select>
                                  </div>
                                </div>

                                <div>
                                  <label className="block text-xs font-medium text-gray-700 mb-1">Debris Type</label>
                                  <select className="input-field text-sm" value={ss.debrisType || ''}
                                    onChange={e => upd({ debrisType: e.target.value })}>
                                    <option value="">Not recorded</option>
                                    {debrisTypeItems.map(i => <option key={i.id} value={i.name}>{i.name}</option>)}
                                  </select>
                                  {debrisTypeItems.length === 0 && (
                                    <p className="text-xs text-gray-400 mt-1">No Debris Types set up yet — add some under SW Categories → Debris Types.</p>
                                  )}
                                </div>

                                <div className="grid grid-cols-2 gap-3">
                                  <div>
                                    <label className="block text-xs font-medium text-gray-700 mb-1">📅 Start Date</label>
                                    <input type="date" className="input-field text-sm"
                                      value={toInputDate(ss.startDate)}
                                      onChange={e => upd({ startDate: fromInputDate(e.target.value) })} />
                                  </div>
                                  <div>
                                    <label className="block text-xs font-medium text-gray-700 mb-1">🏁 Finish Date</label>
                                    <input type="date" className="input-field text-sm"
                                      value={toInputDate(ss.finishDate)}
                                      onChange={e => upd({ finishDate: fromInputDate(e.target.value) })} />
                                    {ss.startDate && ss.finishDate && dateAfter(ss.startDate, ss.finishDate) && (
                                      <p className="text-xs text-red-500 mt-1">⚠️ Finish date before start</p>
                                    )}
                                  </div>
                                </div>

                                <div className="grid grid-cols-2 gap-3">
                                  <div>
                                    <label className="block text-xs font-medium text-gray-700 mb-1">⏱️ Start Time</label>
                                    <TimeInput12h value={ss.startTime || ''}
                                      onChange={v => upd({ startTime: v || undefined })} />
                                  </div>
                                  <div>
                                    <label className="block text-xs font-medium text-gray-700 mb-1">🏁 Finish Time</label>
                                    <TimeInput12h value={ss.finishTime || ''}
                                      onChange={v => upd({ finishTime: v || undefined })} />
                                    {ss.startTime && ss.finishTime && ss.startTime > ss.finishTime &&
                                      (!ss.startDate || !ss.finishDate || ss.startDate === ss.finishDate) && (
                                      <p className="text-xs text-amber-500 mt-1">⚠️ Finish time before start</p>
                                    )}
                                  </div>
                                </div>

                                {/* Fuel docket link — only on first segment (job-level) */}
                                {sIdx === 0 && (jobForm.fuelDockets || []).length > 0 && (
                                  <div>
                                    <label className="block text-xs font-medium text-gray-700 mb-1">⛽ Fuel Docket</label>
                                    <select className="input-field text-sm" value={jr.fuelDocketId || ''}
                                      onChange={e => updateJobRoad(roadIdx, { fuelDocketId: e.target.value || undefined })}>
                                      <option value="">— None —</option>
                                      {(jobForm.fuelDockets || []).map(fd => (
                                        <option key={fd.id} value={fd.id}>
                                          {fd.date} · {fd.totalLitres}L · ${fd.totalCost} · Hub {fd.hubKm} km
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}

                                <div>
                                  <label className="block text-xs font-medium text-gray-700 mb-1">🌤️ Weather</label>
                                  <select className="input-field text-sm" value={ss.weather || ''}
                                    onChange={e => upd({ weather: e.target.value })}>
                                    <option value="">Not recorded</option>
                                    {weatherItems.length > 0
                                      ? weatherItems.map(i => <option key={i.id} value={i.name}>{i.name}</option>)
                                      : (<><option value="☀️ Clear">☀️ Clear</option><option value="☁️ Cloudy">☁️ Cloudy</option><option value="🌦 Light Rain">🌦 Light Rain</option><option value="🌧 Heavy Rain">🌧 Heavy Rain</option><option value="💨 Windy">💨 Windy</option></>)
                                    }
                                  </select>
                                </div>

                                <div>
                                  <label className="block text-xs font-medium text-gray-700 mb-1">Distance Swept</label>
                                  {/* Compute display distance live from current UI controls — never use
                                      jr.metresSwept directly here, as it may hold a stale saved value
                                      that hasn't yet been recalculated by the slider/method buttons. */}
                                  {(() => {
                                    let d: number;
                                    if (ss.coverageMethod === 'full')    d = km;
                                    else if (ss.coverageMethod === 'percent') d = km * ((ss.percentSwept || 0) / 100);
                                    else d = isMultiSeg ? 0 : jr.metresSwept; // ab/landmark/visual: use saved
                                    return <p className="text-sm font-bold text-indigo-700">{fmtMetres(d)}</p>;
                                  })()}
                                </div>

                                <div>
                                  <label className="block text-xs font-medium text-gray-700 mb-1">
                                    {isMultiSeg ? `${segLabel} Notes` : 'Road Notes'}
                                  </label>
                                  <input className="input-field text-sm" value={ss.notes || ''}
                                    placeholder={'Notes for this ' + (isMultiSeg ? 'segment' : 'road')}
                                    onChange={e => upd({ notes: e.target.value })} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ── MAP TAB (damage pins per road) ── */}
            {/* ── ROUTE MAP TAB — all selected roads with segment colours ── */}
            {jobTab === 'overview' && (
              <div style={{ borderRadius: 16, overflow: 'hidden', border: '1px solid #e5e7eb', height: 'var(--map-h-offset-260)', minHeight: 420 }}>
                {jobForm.roads.length === 0 && (jobForm.zoneIds || []).length === 0 ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: '#f8fafc' }}>
                    <p className="text-gray-400 text-sm">Select roads or zones to see them on the map.</p>
                  </div>
                ) : (
                  <AllRoadsMap
                    jobRoads={jobForm.roads}
                    sweepRoads={sweepRoads}
                    sweepAreas={sweepAreas}
                    jobZoneIds={jobForm.zoneIds || []}
                    sweepZones={sweepZones}
                  />
                )}
              </div>
            )}

            {/* ── ROAD DETAIL MAP TAB ── */}
            {jobTab === 'map' && (
              <div className="card space-y-4">
                <h2 className="font-semibold text-gray-900">⚠️ Road Damage / Warning Pins</h2>

                {jobForm.roads.length === 0 ? (
                  <p className="text-gray-400 text-sm text-center py-8">Select roads in the Roads tab first.</p>
                ) : (
                  <>
                    {/* Road selector */}
                    <div className="flex flex-wrap gap-2">
                      {jobForm.roads.map((jr, idx) => {
                        const road = sweepRoads.find(r => r.id === jr.roadId);
                        const area = road ? sweepAreas.find(a => a.id === road.areaId) : undefined;
                        return (
                          <button key={jr.roadId + idx} onClick={() => setActiveRoadIdx(idx)}
                            className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition ${activeRoadIdx === idx ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-300 hover:border-indigo-400'}`}>
                            <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: area?.color || '#6366F1', verticalAlign: 'middle' }} />
                            {road?.name || 'Road'}
                            {jr.damagePins.length > 0 && <span className="ml-1.5 bg-red-100 text-red-700 text-xs px-1.5 rounded-full">{jr.damagePins.length}</span>}
                          </button>
                        );
                      })}
                    </div>

                    {activeRoadDef ? (
                      <>
                        {!roadHasRoute(activeRoadDef) ? (
                          <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-700">
                            ⚠️ <strong>{activeRoadDef.name}</strong> has no route drawn yet. Go to Areas & Roads to draw the route first, then you can place damage pins on it.
                          </div>
                        ) : (
                          <DamageMap
                            road={activeRoadDef}
                            pins={activeJobRoad.damagePins}
                            onPinsChange={pins => updateJobRoad(activeRoadIdx, { damagePins: pins })}
                          />
                        )}
                      </>
                    ) : (
                      <p className="text-gray-400 text-sm">Select a road above.</p>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── FUEL TAB ── */}
            {jobTab === 'fuel' && (
              <div className="card space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-gray-900">⛽ Fuel Dockets</h2>
                  <button
                    className="btn-primary text-sm flex items-center gap-1.5"
                    onClick={() => {
                      const newDocket: import('../../types').FuelDocket = {
                        id: `fd-${Date.now()}`,
                        date: fromInputDate(localDateKey()) || '',
                        costPerLitre: '',
                        totalLitres: '',
                        totalCost: '',
                        hubKm: '',
                        photo: undefined,
                        notes: '',
                        createdAt: new Date().toISOString(),
                      };
                      setJobForm(p => ({ ...p, fuelDockets: [...(p.fuelDockets || []), newDocket] }));
                    }}
                  >
                    🧾 Add Fuel Docket ✚
                  </button>
                </div>

                {(jobForm.fuelDockets || []).length === 0 ? (
                  <div className="text-center py-10 text-gray-400">
                    <div className="text-4xl mb-3">⛽</div>
                    <p className="font-medium text-gray-500">No fuel dockets yet</p>
                    <p className="text-sm mt-1">Click <strong>Add Fuel Docket ✚</strong> to record fuel usage for this job.</p>
                  </div>
                ) : (
                  <div className="space-y-5">
                    {(jobForm.fuelDockets || []).map((fd, fdIdx) => (
                      <div key={fd.id} className="border border-gray-200 rounded-xl p-4 space-y-3 relative">
                        {/* Header */}
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-semibold text-gray-700">🧾 Docket #{fdIdx + 1}</span>
                          <button
                            onClick={() => {
                              if (!confirm('Delete this fuel docket?')) return;
                              setJobForm(p => ({ ...p, fuelDockets: (p.fuelDockets || []).filter(d => d.id !== fd.id) }));
                            }}
                            className="text-red-400 hover:text-red-600 text-xs px-2 py-1 rounded hover:bg-red-50 border border-red-200"
                          >🗑️ Delete</button>
                        </div>

                        {/* Date */}
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">🗓️ Date (DD-MM-YYYY)</label>
                            <input type="date" className="input-field text-sm"
                              value={toInputDate(fd.date)}
                              onChange={e => {
                                const val = fromInputDate(e.target.value) || '';
                                setJobForm(p => ({ ...p, fuelDockets: (p.fuelDockets || []).map((d, i) => i === fdIdx ? { ...d, date: val } : d) }));
                              }} />
                            {fd.date && <p className="text-xs text-gray-400 mt-0.5">{fd.date}</p>}
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">⏲ Hub Reading (km)</label>
                            <input type="text" inputMode="decimal" className="input-field text-sm"
                              placeholder="e.g. 124500"
                              value={fd.hubKm}
                              onChange={e => setJobForm(p => ({ ...p, fuelDockets: (p.fuelDockets || []).map((d, i) => i === fdIdx ? { ...d, hubKm: e.target.value } : d) }))} />
                          </div>
                        </div>

                        {/* Fuel figures */}
                        <div className="grid grid-cols-3 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">💧 Total Litres</label>
                            <input type="text" inputMode="decimal" className="input-field text-sm"
                              placeholder="e.g. 86.990"
                              value={fd.totalLitres}
                              onChange={e => setJobForm(p => ({ ...p, fuelDockets: (p.fuelDockets || []).map((d, i) => i === fdIdx ? { ...d, totalLitres: e.target.value } : d) }))} />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">💲 Cost per Litre</label>
                            <input type="text" inputMode="decimal" className="input-field text-sm"
                              placeholder="e.g. 2.209"
                              value={fd.costPerLitre}
                              onChange={e => setJobForm(p => ({ ...p, fuelDockets: (p.fuelDockets || []).map((d, i) => i === fdIdx ? { ...d, costPerLitre: e.target.value } : d) }))} />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">💲 Total Fuel Cost</label>
                            <input type="text" inputMode="decimal" className="input-field text-sm"
                              placeholder="e.g. 192.00"
                              value={fd.totalCost}
                              onChange={e => setJobForm(p => ({ ...p, fuelDockets: (p.fuelDockets || []).map((d, i) => i === fdIdx ? { ...d, totalCost: e.target.value } : d) }))} />
                          </div>
                        </div>

                        {/* Notes */}
                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">Notes</label>
                          <input type="text" className="input-field text-sm"
                            placeholder="Optional notes about this fill-up"
                            value={fd.notes || ''}
                            onChange={e => setJobForm(p => ({ ...p, fuelDockets: (p.fuelDockets || []).map((d, i) => i === fdIdx ? { ...d, notes: e.target.value } : d) }))} />
                        </div>

                        {/* Photo */}
                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">📷 Docket Photo</label>
                          {fd.photo ? (
                            <div className="relative inline-block">
                              <img src={fd.photo} alt="Fuel docket" className="h-32 rounded-lg object-cover border border-gray-200" />
                              <button
                                onClick={() => setJobForm(p => ({ ...p, fuelDockets: (p.fuelDockets || []).map((d, i) => i === fdIdx ? { ...d, photo: undefined } : d) }))}
                                className="absolute top-1 right-1 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs hover:bg-red-600"
                              >✕</button>
                            </div>
                          ) : (
                            <label className="flex items-center gap-2 cursor-pointer w-fit">
                              <span className="btn-secondary text-xs py-1.5 px-3">📷 Add Photo</span>
                              <input type="file" accept="image/*" capture="environment" className="hidden"
                                onChange={e => {
                                  const file = e.target.files?.[0];
                                  if (!file) return;
                                  const reader = new FileReader();
                                  reader.onload = async ev => {
                                    const raw = ev.target?.result as string;
                                    // PERF FIX (v73.36): this used to store the raw, uncompressed
                                    // camera photo (often 3-6MB) directly in job data. Every other
                                    // photo path in the app compresses first; this one didn't,
                                    // which directly bloated the size of every debounced save.
                                    let b64 = raw;
                                    try { b64 = await compressImage(raw, 1200, 0.75); } catch { /* fall back to raw */ }
                                    setJobForm(p => ({ ...p, fuelDockets: (p.fuelDockets || []).map((d, i) => i === fdIdx ? { ...d, photo: b64 } : d) }));
                                  };
                                  reader.readAsDataURL(file);
                                }} />
                            </label>
                          )}
                        </div>

                        {/* Summary strip */}
                        {(fd.totalLitres || fd.totalCost || fd.hubKm) && (
                          <div className="bg-indigo-50 rounded-lg px-3 py-2 text-xs text-indigo-700 flex flex-wrap gap-4">
                            {fd.totalLitres && <span>💧 {fd.totalLitres} L</span>}
                            {fd.costPerLitre && <span>@ ${fd.costPerLitre}/L</span>}
                            {fd.totalCost && <span>= <strong>${fd.totalCost}</strong></span>}
                            {fd.hubKm && <span>⏲ Hub: {fd.hubKm} km</span>}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── EXTRA EXPENSES TAB ── */}
            {jobTab === 'expenses' && (
              <div className="card space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-gray-900">💲 Extra Expenses</h2>
                  <button className="btn-primary text-sm flex items-center gap-1.5"
                    onClick={() => {
                      const newExp: import('../../types').ExtraExpense = {
                        id: `exp-${Date.now()}`,
                        expenseType: '',
                        date: fromInputDate(localDateKey()) || '',
                        totalCost: '',
                        notes: '',
                        photo: undefined,
                        createdAt: new Date().toISOString(),
                      };
                      setJobForm(p => ({ ...p, extraExpenses: [...(p.extraExpenses || []), newExp] }));
                    }}>
                    💲 Add Expense ✚
                  </button>
                </div>

                {(jobForm.extraExpenses || []).length === 0 ? (
                  <div className="text-center py-10 text-gray-400">
                    <div className="text-4xl mb-3">💲</div>
                    <p className="font-medium text-gray-500">No extra expenses yet</p>
                    <p className="text-sm mt-1">Click <strong>Add Expense ✚</strong> to record food, parts, oil or any other cost.</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {(jobForm.extraExpenses || []).map((exp, ei) => (
                      <div key={exp.id} className="border border-gray-200 rounded-xl p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-gray-700">💲 Expense #{ei + 1}</span>
                          <button onClick={() => { if (!confirm('Delete this expense?')) return; setJobForm(p => ({ ...p, extraExpenses: (p.extraExpenses || []).filter(e => e.id !== exp.id) })); }}
                            className="text-red-400 hover:text-red-600 text-xs px-2 py-1 rounded hover:bg-red-50 border border-red-200">🗑️ Delete</button>
                        </div>

                        {/* Type + Date */}
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">Expense Type</label>
                            {(() => {
                              const items = (data.sweepCategories || []).filter(c => c.categoryType === 'extra_expense').flatMap(c => c.items);
                              return (
                                <select className="input-field text-sm" value={exp.expenseType}
                                  onChange={e => setJobForm(p => ({ ...p, extraExpenses: (p.extraExpenses || []).map((x, i) => i === ei ? { ...x, expenseType: e.target.value } : x) }))}>
                                  <option value="">— Select type —</option>
                                  {items.length > 0
                                    ? items.map(i => <option key={i.id} value={i.name}>{i.name}</option>)
                                    : (<><option value="🍔 Food & Meals">🍔 Food & Meals</option><option value="🔧 Parts">🔧 Parts</option><option value="🛢️ Oil / Lubricants">🛢️ Oil / Lubricants</option><option value="⛽ Other Fuel">⛽ Other Fuel</option><option value="⚠️ Other">⚠️ Other</option></>)
                                  }
                                </select>
                              );
                            })()}
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">🗓️ Date (DD-MM-YYYY)</label>
                            <input type="date" className="input-field text-sm"
                              value={toInputDate(exp.date)}
                              onChange={e => setJobForm(p => ({ ...p, extraExpenses: (p.extraExpenses || []).map((x, i) => i === ei ? { ...x, date: fromInputDate(e.target.value) || '' } : x) }))} />
                            {exp.date && <p className="text-xs text-gray-400 mt-0.5">{exp.date}</p>}
                          </div>
                        </div>

                        {/* Cost + Notes */}
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">💲 Total Cost ($)</label>
                            <input type="text" inputMode="decimal" className="input-field text-sm" placeholder="e.g. 45.50"
                              value={exp.totalCost}
                              onChange={e => setJobForm(p => ({ ...p, extraExpenses: (p.extraExpenses || []).map((x, i) => i === ei ? { ...x, totalCost: e.target.value } : x) }))} />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">Notes</label>
                            <input type="text" className="input-field text-sm" placeholder="Optional notes"
                              value={exp.notes || ''}
                              onChange={e => setJobForm(p => ({ ...p, extraExpenses: (p.extraExpenses || []).map((x, i) => i === ei ? { ...x, notes: e.target.value } : x) }))} />
                          </div>
                        </div>

                        {/* Photo */}
                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">📷 Receipt Photo</label>
                          {exp.photo ? (
                            <div className="relative inline-block">
                              <img src={exp.photo} alt="Receipt" className="h-28 rounded-lg object-cover border border-gray-200" />
                              <button onClick={() => setJobForm(p => ({ ...p, extraExpenses: (p.extraExpenses || []).map((x, i) => i === ei ? { ...x, photo: undefined } : x) }))}
                                className="absolute top-1 right-1 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs hover:bg-red-600">✕</button>
                            </div>
                          ) : (
                            <label className="flex items-center gap-2 cursor-pointer w-fit">
                              <span className="btn-secondary text-xs py-1.5 px-3">📷 Add Photo</span>
                              <input type="file" accept="image/*" capture="environment" className="hidden"
                                onChange={e => { const f = e.target.files?.[0]; if (!f) return; const r = new FileReader(); r.onload = async ev => {
                                  const raw = ev.target?.result as string;
                                  // PERF FIX (v73.36): was storing the raw, uncompressed photo directly.
                                  let b64 = raw;
                                  try { b64 = await compressImage(raw, 1200, 0.75); } catch { /* fall back to raw */ }
                                  setJobForm(p => ({ ...p, extraExpenses: (p.extraExpenses || []).map((x, i) => i === ei ? { ...x, photo: b64 } : x) }));
                                }; r.readAsDataURL(f); }} />
                            </label>
                          )}
                        </div>

                        {/* Summary */}
                        {(exp.expenseType || exp.totalCost) && (
                          <div className="bg-amber-50 rounded-lg px-3 py-2 text-xs text-amber-800 flex flex-wrap gap-3">
                            {exp.expenseType && <span>{exp.expenseType}</span>}
                            {exp.totalCost && <span>= <strong>${exp.totalCost}</strong></span>}
                            {exp.date && <span>on {exp.date}</span>}
                          </div>
                        )}
                      </div>
                    ))}

                    {/* Total */}
                    {(jobForm.extraExpenses || []).some(e => e.totalCost) && (
                      <div className="bg-gray-50 rounded-xl px-4 py-3 flex items-center justify-between">
                        <span className="text-sm font-semibold text-gray-700">Total Extra Expenses</span>
                        <span className="text-lg font-bold text-amber-700">
                          ${(jobForm.extraExpenses || []).reduce((s, e) => s + (parseFloat(e.totalCost) || 0), 0).toFixed(2)}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── TIP RUNS TAB ── */}
            {jobTab === 'tip' && (
              <div className="card space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-gray-900">🗑️ Travel To Tip Site</h2>
                  <button className="btn-primary text-sm"
                    onClick={() => {
                      const newRun: import('../../types').TipRun = {
                        id: `tip-${Date.now()}`,
                        roadId: jobForm.roads[0]?.roadId || '',
                        trips: [],
                      };
                      setJobForm(p => ({ ...p, tipRuns: [...(p.tipRuns || []), newRun] }));
                    }}>
                    ➕ Add Tip Run for Road
                  </button>
                </div>

                {jobForm.roads.length === 0 ? (
                  <p className="text-center text-gray-400 text-sm py-6">Select roads in the Roads tab first.</p>
                ) : (jobForm.tipRuns || []).length === 0 ? (
                  <div className="text-center py-10 text-gray-400">
                    <div className="text-4xl mb-3">🗑️</div>
                    <p className="font-medium text-gray-500">No tip runs recorded yet</p>
                    <p className="text-sm mt-1">Click <strong>Add Tip Run for Road</strong> to record trips to the tip site.</p>
                  </div>
                ) : (
                  <div className="space-y-5">
                    {(jobForm.tipRuns || []).map((run, ri) => {
                      const roadDef = sweepRoads.find(r => r.id === run.roadId);
                      const area = roadDef ? sweepAreas.find(a => a.id === roadDef.areaId) : undefined;

                      // Totals for this run
                      const totalKm = run.trips.reduce((s, t) => {
                        const dep = parseFloat(t.departHubKm) || 0;
                        const ret = parseFloat(t.returnHubKm) || 0;
                        return s + Math.max(0, ret - dep);
                      }, 0);
                      const totalMins = run.trips.reduce((s, t) => {
                        if (!t.departTime || !t.returnTime) return s;
                        const [dh, dm] = t.departTime.split(':').map(Number);
                        const [rh, rm] = t.returnTime.split(':').map(Number);
                        return s + Math.max(0, (rh * 60 + rm) - (dh * 60 + dm));
                      }, 0);

                      return (
                        <div key={run.id} className="border border-gray-200 rounded-xl overflow-hidden">
                          {/* Run header */}
                          <div className="flex items-center gap-3 p-3 bg-gray-50">
                            <span className="text-lg">🗑️</span>
                            <div className="flex-1">
                              <select className="input-field text-sm font-semibold"
                                value={run.roadId}
                                onChange={e => setJobForm(p => ({ ...p, tipRuns: (p.tipRuns || []).map((r, i) => i === ri ? { ...r, roadId: e.target.value } : r) }))}>
                                <option value="">— Select Road —</option>
                                {jobForm.roads.map(jr => {
                                  const rd = sweepRoads.find(r => r.id === jr.roadId);
                                  const ar = rd ? sweepAreas.find(a => a.id === rd.areaId) : undefined;
                                  return <option key={jr.roadId} value={jr.roadId}>{rd?.name || jr.roadId}{ar ? ` (${ar.name})` : ''}</option>;
                                })}
                              </select>
                              {area && roadDef && <p className="text-xs text-gray-400 mt-0.5">{area.name}</p>}
                            </div>
                            <button onClick={() => { if (!confirm('Delete this tip run?')) return; setJobForm(p => ({ ...p, tipRuns: (p.tipRuns || []).filter((_, i) => i !== ri) })); }}
                              className="text-red-400 hover:text-red-600 text-xs px-2 py-1 rounded hover:bg-red-50 border border-red-200 shrink-0">🗑️ Delete Run</button>
                          </div>

                          {/* Trips */}
                          <div className="p-3 space-y-3">
                            {run.trips.map((trip, ti) => {
                              const depKm = parseFloat(trip.departHubKm) || 0;
                              const retKm = parseFloat(trip.returnHubKm) || 0;
                              const tripKm = Math.max(0, retKm - depKm);
                              const [dh, dm] = trip.departTime ? trip.departTime.split(':').map(Number) : [0, 0];
                              const [rh, rm] = trip.returnTime ? trip.returnTime.split(':').map(Number) : [0, 0];
                              const tripMins = trip.departTime && trip.returnTime ? Math.max(0, (rh * 60 + rm) - (dh * 60 + dm)) : 0;

                              const updateTrip = (patch: Partial<import('../../types').TipTrip>) =>
                                setJobForm(p => ({ ...p, tipRuns: (p.tipRuns || []).map((r, rIdx) => rIdx !== ri ? r : { ...r, trips: r.trips.map((t, tIdx) => tIdx !== ti ? t : { ...t, ...patch }) }) }));

                              return (
                                <div key={trip.id} className="bg-gray-50 rounded-xl p-3 space-y-2">
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="text-xs font-bold text-gray-600">Trip #{ti + 1}</span>
                                    <button onClick={() => setJobForm(p => ({ ...p, tipRuns: (p.tipRuns || []).map((r, rIdx) => rIdx !== ri ? r : { ...r, trips: r.trips.filter((_, tIdx) => tIdx !== ti) }) }))}
                                      className="text-red-400 hover:text-red-600 text-xs">✕ Remove</button>
                                  </div>

                                  <div>
                                    <label className="text-xs text-gray-500">📅 Date</label>
                                    <input type="date" className="input-field text-sm" value={toInputDate(trip.date)}
                                      onChange={e => updateTrip({ date: fromInputDate(e.target.value) })} />
                                  </div>

                                  <div className="grid grid-cols-2 gap-2">
                                    <div className="space-y-1">
                                      <p className="text-xs font-semibold text-indigo-700">🚛 Depart to Tip Site</p>
                                      <div className="flex gap-2">
                                        <div className="flex-1">
                                          <label className="text-xs text-gray-500">Time</label>
                                          <input type="time" className="input-field text-sm" value={trip.departTime}
                                            onChange={e => updateTrip({ departTime: e.target.value })} />
                                        </div>
                                        <div className="flex-1">
                                          <label className="text-xs text-gray-500">Hub km</label>
                                          <input type="text" inputMode="numeric" className="input-field text-sm" placeholder="e.g. 15165"
                                            value={trip.departHubKm} onChange={e => updateTrip({ departHubKm: e.target.value })} />
                                        </div>
                                      </div>
                                    </div>
                                    <div className="space-y-1">
                                      <p className="text-xs font-semibold text-green-700">🔙 Returned to Sweep Point</p>
                                      <div className="flex gap-2">
                                        <div className="flex-1">
                                          <label className="text-xs text-gray-500">Time</label>
                                          <input type="time" className="input-field text-sm" value={trip.returnTime}
                                            onChange={e => updateTrip({ returnTime: e.target.value })} />
                                        </div>
                                        <div className="flex-1">
                                          <label className="text-xs text-gray-500">Hub km</label>
                                          <input type="text" inputMode="numeric" className="input-field text-sm" placeholder="e.g. 15190"
                                            value={trip.returnHubKm} onChange={e => updateTrip({ returnHubKm: e.target.value })} />
                                        </div>
                                      </div>
                                    </div>
                                  </div>

                                  {/* Auto-calc totals for this trip */}
                                  {(tripKm > 0 || tripMins > 0) && (
                                    <div className="bg-indigo-50 rounded-lg px-3 py-1.5 text-xs text-indigo-700 flex gap-4">
                                      {tripKm > 0 && <span>📏 {tripKm} km traveled</span>}
                                      {tripMins > 0 && <span>⏱ {tripMins} min</span>}
                                    </div>
                                  )}
                                </div>
                              );
                            })}

                            {/* Add trip button */}
                            <button className="btn-secondary text-xs w-full"
                              onClick={() => {
                                const newTrip: import('../../types').TipTrip = { id: `tr-${Date.now()}`, date: fromInputDate(localDateKey()), departTime: '', departHubKm: '', returnTime: '', returnHubKm: '' };
                                setJobForm(p => ({ ...p, tipRuns: (p.tipRuns || []).map((r, i) => i !== ri ? r : { ...r, trips: [...r.trips, newTrip] }) }));
                              }}>
                              ➕ New Trip
                            </button>
                          </div>

                          {/* Run totals */}
                          {run.trips.length > 0 && (totalKm > 0 || totalMins > 0) && (
                            <div className="bg-indigo-100 px-4 py-2 text-sm font-semibold text-indigo-800 flex flex-wrap gap-6">
                              <span>📏 Total km to Tip & Back: <strong>{totalKm} km</strong></span>
                              <span>⏱ Total Time: <strong>{totalMins >= 60 ? `${Math.floor(totalMins / 60)}h ${totalMins % 60}min` : `${totalMins} min`}</strong></span>
                              <span>🔢 Trips: <strong>{run.trips.length}</strong></span>
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* Grand totals across all runs */}
                    {(jobForm.tipRuns || []).some(r => r.trips.length > 0) && (() => {
                      const grandKm = (jobForm.tipRuns || []).reduce((s, run) =>
                        s + run.trips.reduce((ts, t) => ts + Math.max(0, (parseFloat(t.returnHubKm) || 0) - (parseFloat(t.departHubKm) || 0)), 0), 0);
                      const grandMins = (jobForm.tipRuns || []).reduce((s, run) =>
                        s + run.trips.reduce((ts, t) => {
                          if (!t.departTime || !t.returnTime) return ts;
                          const [dh, dm] = t.departTime.split(':').map(Number);
                          const [rh, rm] = t.returnTime.split(':').map(Number);
                          return ts + Math.max(0, (rh * 60 + rm) - (dh * 60 + dm));
                        }, 0), 0);
                      return (
                        <div className="bg-gray-900 text-white rounded-xl px-4 py-3 flex flex-wrap gap-6 text-sm font-semibold">
                          <span>📏 Total km to Tip & Back Over the Day: <strong>{grandKm} km</strong></span>
                          <span>⏱ Total Time: <strong>{grandMins >= 60 ? `${(grandMins / 60).toFixed(2)} hours` : `${grandMins} min`}</strong></span>
                        </div>
                      );
                    })()}

                    {/* Total runs per day — only shown once a job's tip runs span more than one date,
                        since that's the whole point (multi-day jobs where trips need their own date). */}
                    {(() => {
                      const allTrips = (jobForm.tipRuns || []).flatMap(r => r.trips);
                      const byDate = new Map<string, number>();
                      allTrips.forEach(t => {
                        const key = t.date || '(no date)';
                        byDate.set(key, (byDate.get(key) || 0) + 1);
                      });
                      const distinctDates = [...byDate.keys()].filter(k => k !== '(no date)');
                      if (distinctDates.length < 2) return null;
                      const sortedEntries = [...byDate.entries()].sort(([a], [b]) => {
                        if (a === '(no date)') return 1;
                        if (b === '(no date)') return -1;
                        return toInputDate(a).localeCompare(toInputDate(b));
                      });
                      return (
                        <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3">
                          <p className="text-xs font-semibold text-indigo-700 mb-2">📅 Total Runs Per Day</p>
                          <div className="flex flex-wrap gap-2">
                            {sortedEntries.map(([date, count]) => (
                              <span key={date} className="bg-white border border-indigo-200 rounded-lg px-3 py-1.5 text-xs">
                                <strong className="text-indigo-800">{date === '(no date)' ? 'No date set' : formatDMY(toInputDate(date))}</strong>
                                <span className="text-gray-500"> — {count} run{count !== 1 ? 's' : ''}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-4">
            <div className="card">
              <h3 className="font-semibold text-gray-900 mb-3">Status</h3>
              <div className="flex flex-wrap gap-2 mb-4">
                {(['planned', 'in_progress', 'completed'] as SweepJob['status'][]).map(s => (
                  <button key={s} onClick={() => setJobForm(p => ({ ...p, status: s }))}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${jobForm.status === s ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-300'}`}>
                    {s === 'planned' ? '📅 Planned' : s === 'in_progress' ? '🔄 In Progress' : '✅ Completed'}
                  </button>
                ))}
              </div>
              <div className="space-y-2">
                <button onClick={() => saveJob()} className="btn-primary w-full">💾 {editingJob ? 'Save Changes' : 'Save & Continue Editing'}</button>
                <button onClick={() => saveJob('completed')} className="btn-success w-full">✅ Save & Complete</button>
                <button onClick={() => setJobView('list')} className="btn-secondary w-full">Cancel</button>
              </div>
            </div>

            <div className="card">
              <h3 className="font-semibold text-gray-900 mb-2">Summary</h3>
              <div className="space-y-1.5 text-sm text-gray-600">
                <p>🛣️ {jobForm.roads.length} road{jobForm.roads.length !== 1 ? 's' : ''} selected</p>
                <p>📏 {fmtMetres(jobForm.roads.reduce((a, r) => a + (r.metresSwept || 0), 0))} total</p>
                <p>⚠️ {jobForm.roads.reduce((a, r) => a + r.damagePins.length, 0)} damage pins</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════
  // MAIN LIST / AREAS VIEW
  // ══════════════════════════════════════════════════════════
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🧹 Road Sweeping</h1>
          <p className="text-gray-500 text-sm mt-1">
            {sweepJobs.length} job{sweepJobs.length !== 1 ? 's' : ''} · {sweepAreas.length} area{sweepAreas.length !== 1 ? 's' : ''} · {sweepRoads.length} road{sweepRoads.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex gap-2">
          {tab === 'jobs' && <button onClick={openNewJob} className="btn-primary">+ New Sweep Job</button>}
          {tab === 'areas' && <button onClick={openAddArea} className="btn-primary">+ New Area</button>}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
        <button onClick={() => setTab('jobs')}
          className={`px-5 py-2 rounded-lg text-sm font-medium transition ${tab === 'jobs' ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}>
          🧹 Sweep Jobs
        </button>
        <button onClick={() => setTab('areas')}
          className={`px-5 py-2 rounded-lg text-sm font-medium transition ${tab === 'areas' ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}>
          🗺️ Areas & Roads
        </button>
      </div>

      {/* ── JOBS LIST ── */}
      {tab === 'jobs' && (
        <div className="space-y-4">
          {sweepJobs.length === 0 ? (
            <div className="card text-center py-16">
              <div className="text-5xl mb-4">🧹</div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">No sweep jobs yet</h2>
              <p className="text-gray-500 text-sm mb-6">Create your first sweep job to track roads, coverage and damage.</p>
              <button onClick={openNewJob} className="btn-primary">+ Create First Sweep Job</button>
            </div>
          ) : (
            <>
              {/* ── Status filter tabs ── */}
              {(() => {
                const counts = {
                  all:         sweepJobs.length,
                  planned:     sweepJobs.filter(j => j.status === 'planned').length,
                  in_progress: sweepJobs.filter(j => j.status === 'in_progress').length,
                  completed:   sweepJobs.filter(j => j.status === 'completed').length,
                };
                const tabs: { key: typeof statusFilter; label: string; icon: string; active: string; pill: string }[] = [
                  { key: 'all',         label: 'All Jobs',   icon: '🧹', active: 'bg-gray-800 text-white shadow',                       pill: 'bg-gray-600 text-white' },
                  { key: 'planned',     label: 'Planned',    icon: '📅', active: 'bg-gray-100 text-gray-800 shadow border border-gray-300', pill: 'bg-gray-500 text-white' },
                  { key: 'in_progress', label: 'In Progress', icon: '🔄', active: 'bg-blue-600 text-white shadow',                      pill: 'bg-blue-400 text-white' },
                  { key: 'completed',   label: 'Completed',  icon: '✅', active: 'bg-emerald-600 text-white shadow',                    pill: 'bg-emerald-400 text-white' },
                ];
                return (
                  <div className="flex gap-2 flex-wrap">
                    {tabs.map(t => (
                      <button key={t.key} onClick={() => setStatusFilter(t.key)}
                        className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
                          statusFilter === t.key ? t.active : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
                        }`}>
                        <span>{t.icon}</span>
                        <span>{t.label}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold min-w-[20px] text-center ${
                          statusFilter === t.key ? t.pill : 'bg-gray-100 text-gray-600'
                        }`}>
                          {counts[t.key]}
                        </span>
                      </button>
                    ))}
                  </div>
                );
              })()}

              <input className="input-field max-w-sm" value={jobSearch} onChange={e => setJobSearch(e.target.value)}
                placeholder="🔍 Search jobs..." />

              {filteredJobs.length === 0 ? (
                <div className="card text-center py-10">
                  <p className="text-gray-400 text-sm">
                    {statusFilter === 'all'
                      ? 'No jobs match your search.'
                      : `No ${statusFilter === 'in_progress' ? 'in progress' : statusFilter} jobs${jobSearch ? ' matching your search' : ''}.`}
                  </p>
                  {statusFilter !== 'all' && (
                    <button onClick={() => setStatusFilter('all')} className="text-indigo-600 text-sm font-medium mt-2 hover:underline">
                      Show all jobs
                    </button>
                  )}
                </div>
              ) : (
              <div className="space-y-3">
                {filteredJobs.map(job => {
                  const client = (data.sweepClients || []).find(c => c.id === job.clientId);
                  const metres = totalSwept(job);
                  const dmgCount = job.roads.reduce((a, r) => a + r.damagePins.length, 0);
                  return (
                    <div key={job.id} className="card hover:shadow-md transition cursor-pointer"
                      onClick={() => { setDetailJob(job); setJobView('detail'); setActiveOverviewRoadIdx(0); }}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <h3 className="font-semibold text-gray-900">{job.title}</h3>
                            <span className={`badge ${statusColor(job.status)}`}>{statusLabel(job.status)}</span>
                            <span className="text-xs font-mono text-gray-400">#{job.jobNumber}</span>
                          </div>
                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                            <span>📅 {job.date}</span>
                            {job.crewMember && <span>👤 {job.crewMember}</span>}{job.equipment && <span>🚛 {job.equipment}</span>}
                            {client && <span>🏢 {client.name}</span>}
                            <span>🛣️ {job.roads.length} road{job.roads.length !== 1 ? 's' : ''}</span>
                            {metres > 0 && <span className="text-indigo-600 font-semibold">📏 {fmtMetres(metres)}</span>}
                            {dmgCount > 0 && <span className="text-red-600">⚠️ {dmgCount} damage pin{dmgCount !== 1 ? 's' : ''}</span>}
                            {job.weather && <span>{weatherLabel(job.weather)}</span>}
                          </div>
                          {/* Area colour dots */}
                          <div className="flex gap-1 mt-2">
                            {job.areaIds.map(aid => {
                              const area = sweepAreas.find(a => a.id === aid);
                              return area ? (
                                <span key={aid} className="flex items-center gap-1 text-xs text-gray-600 bg-gray-50 px-2 py-0.5 rounded-full border">
                                  <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: area.color }} />
                                  {area.name}
                                </span>
                              ) : null;
                            })}
                          </div>
                        </div>
                        <div className="flex gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                          <button onClick={() => openEditJob(job)} className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600">✏️</button>
                          <button onClick={() => { if (confirm('Delete this sweep job?')) deleteSweepJob(job.id); }}
                            className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-600">🗑️</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── AREAS & ROADS LIST ── */}
      {tab === 'areas' && (
        <div className="space-y-4">
          {sweepAreas.length === 0 ? (
            <div className="card text-center py-16">
              <div className="text-5xl mb-4">🗺️</div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">No areas set up yet</h2>
              <p className="text-gray-500 text-sm mb-6">Create areas (e.g. Area 1, Area 2) then add roads to each with drawn GPS routes.</p>
              <button onClick={openAddArea} className="btn-primary">+ Create First Area</button>
            </div>
          ) : (
            sweepAreas.map(area => {
              const areaRoads = getRoadsForArea(area.id);
              const areaZones = getZonesForArea(area.id);
              const isExpanded = expandedArea === area.id;
              const totalLen = areaRoads.reduce((a, r) => a + r.lengthMetres, 0);
              return (
                <div key={area.id} className="card" style={{ borderLeft: `4px solid ${area.color}` }}>
                  <div className="flex items-start justify-between gap-3">
                    <button className="flex items-center gap-3 flex-1 text-left" onClick={() => setExpandedArea(isExpanded ? null : area.id)}>
                      <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold"
                        style={{ backgroundColor: area.color }}>
                        {area.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <h3 className="font-bold text-gray-900">{area.name}</h3>
                        <p className="text-xs text-gray-500">
                          {areaRoads.length} road{areaRoads.length !== 1 ? 's' : ''}{totalLen > 0 ? ` · ${fmtMetres(totalLen)} total` : ''}
                          {areaZones.length > 0 ? ` · ${areaZones.length} zone${areaZones.length !== 1 ? 's' : ''}` : ''}
                        </p>
                      </div>
                      <span className="text-gray-400 ml-2">{isExpanded ? '▲' : '▼'}</span>
                    </button>
                    <div className="flex gap-1 shrink-0">
                      <button onClick={() => openAddRoad(area.id)} className="btn-secondary text-xs py-1">+ Road</button>
                      <button onClick={() => openAddZone(area.id)} className="btn-secondary text-xs py-1">+ Zone</button>
                      <button onClick={() => openEditArea(area)} className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600">✏️</button>
                      <button onClick={() => { if (confirm(`Delete area "${area.name}" and all its roads?`)) deleteSweepArea(area.id); }}
                        className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-600">🗑️</button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="mt-4 space-y-3">
                      {areaZones.length > 0 && (
                        <div className="space-y-2">
                          {areaZones.map(zone => (
                            <div key={zone.id} className="flex items-center gap-3 p-3 bg-gray-50 border border-gray-200 rounded-xl">
                              <span className="text-lg">{zoneKindIcon(zone.zoneKind)}</span>
                              <div className="flex-1">
                                <span className="font-semibold text-gray-900">{zone.name}</span>
                                <span className="text-xs text-gray-400 ml-2">{zoneKindLabel(zone.zoneKind)} · {fmtZoneArea(zone.areaM2)}</span>
                              </div>
                              <span className="w-3 h-3 rounded-full inline-block border border-gray-300" style={{ backgroundColor: zone.color }} />
                              <button onClick={() => openEditZone(zone)} className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600">✏️</button>
                              <button onClick={() => { if (confirm(`Delete zone "${zone.name}"?`)) deleteSweepZone(zone.id); }}
                                className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-600">🗑️</button>
                            </div>
                          ))}
                        </div>
                      )}
                      {areaRoads.length === 0 ? (
                        <p className="text-gray-400 text-sm text-center py-4">No roads yet. Click <strong>+ Road</strong> to add one.</p>
                      ) : areaRoads.map(road => (
                        <div key={road.id} className="border border-gray-200 rounded-xl overflow-hidden" style={{ borderLeft: `3px solid ${getEffectiveColor(road, area.color)}` }}>
                          <div className="flex items-center gap-3 p-3 bg-gray-50">
                            <span className="text-lg">🛣️</span>
                            <div className="flex-1">
                              <span className="font-semibold text-gray-900">{road.name}</span>
                              <span className="text-xs text-gray-400 ml-2">
                                {roadHasRoute(road) ? fmtMetres(road.lengthMetres) : 'No route drawn yet'}
                              </span>
                              {road.segments && road.segments.length > 1 && (
                                <span className="text-xs bg-blue-100 text-blue-600 rounded-full px-2 py-0.5 ml-2">{road.segments.length} segments</span>
                              )}
                              {road.color && (
                                <span className="inline-flex items-center gap-1 text-xs text-gray-400 ml-2">
                                  <span className="w-3 h-3 rounded-full inline-block border border-gray-300" style={{ backgroundColor: road.color }} />custom colour
                                </span>
                              )}
                            </div>
                            <button onClick={() => openEditRoad(road)} className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600">✏️</button>
                            <button onClick={() => { if (confirm(`Delete road "${road.name}"?`)) deleteSweepRoad(road.id); }}
                              className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-600">🗑️</button>
                          </div>
                          {roadHasRoute(road) && (() => {
                            const segs = getRoadSegments(road);
                            const effColor = getEffectiveColor(road, area.color);
                            const firstSeg = segs[0] || [];
                            const extraSegs = segs.slice(1);
                            // Extract per-segment colours from saved segments
                            const allSegColors = road.segments && road.segments.length > 0
                              ? road.segments.map(s => s.color || effColor)
                              : segs.map(() => effColor);
                            const firstColor = allSegColors[0] || effColor;
                            const extraSegColors = allSegColors.slice(1);
                            return (
                              <div className="p-2">
                                <RoadMap points={firstSeg} onChange={() => {}} readOnly color={firstColor} height={420}
                                  showNumbers={road.showNumbers !== false}
                                  showMarkers={road.showMarkers !== false}
                                  extraSegments={extraSegs}
                                  extraSegmentColors={extraSegColors} />
                              </div>
                            );
                          })()}
                          {road.notes && <p className="text-xs text-gray-500 px-3 pb-3">{road.notes}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ══ MODALS ══ */}

      {/* Area form — overlay click does NOT close to prevent data loss */}
      {showAreaForm && (
        <div className="modal-overlay">
          <div className="modal-content max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-gray-900">{editingArea ? 'Edit Area' : 'New Area'}</h2>
              <button onClick={() => setShowAreaForm(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none p-1 rounded hover:bg-gray-100" title="Cancel">✕</button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Area Name *</label>
                <input className="input-field" value={areaForm.name} placeholder="e.g. Area 1"
                  onChange={e => setAreaForm(p => ({ ...p, name: e.target.value }))} autoFocus />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <input className="input-field" value={areaForm.description} placeholder="Optional notes about this area"
                  onChange={e => setAreaForm(p => ({ ...p, description: e.target.value }))} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Zone Type</label>
                {(() => {
                  const zoneItems = (data.sweepCategories || []).filter(c => c.categoryType === 'zone_type').flatMap(c => c.items);
                  const builtIn = ['CBD','Industrial','Residential','Rural','Local'];
                  const allZones = [...builtIn, ...zoneItems.map(i => i.name).filter(n => !builtIn.includes(n))];
                  return (
                    <select className="input-field" value={areaForm.zoneType}
                      onChange={e => setAreaForm(p => ({ ...p, zoneType: e.target.value }))}>
                      <option value="">— Select zone type —</option>
                      {allZones.map(z => <option key={z} value={z}>{z}</option>)}
                    </select>
                  );
                })()}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Colour</label>
                <div className="flex gap-2 flex-wrap">
                  {AREA_COLORS.map(c => (
                    <button key={c} onClick={() => setAreaForm(p => ({ ...p, color: c }))}
                      className={`w-8 h-8 rounded-full border-2 transition ${areaForm.color === c ? 'border-gray-900 scale-110' : 'border-transparent'}`}
                      style={{ backgroundColor: c }} />
                  ))}
                </div>
              </div>
              <div className="flex gap-2 pt-2">
                <button onClick={() => setShowAreaForm(false)} className="btn-secondary flex-1">Cancel</button>
                <button onClick={saveArea} className="btn-primary flex-1">{editingArea ? 'Save Changes' : 'Create Area'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Road form */}
      {showRoadForm && (
        <div className="modal-overlay" style={{alignItems: 'center', justifyContent: 'center'}}
          onMouseMove={e => {
            if (!roadModalDragRef.current) return;
            const dx = e.clientX - roadModalDragRef.current.startX;
            const dy = e.clientY - roadModalDragRef.current.startY;
            setRoadModalPos({ x: roadModalDragRef.current.origX + dx, y: roadModalDragRef.current.origY + dy });
          }}
          onMouseUp={() => { roadModalDragRef.current = null; }}
          onMouseLeave={() => { roadModalDragRef.current = null; }}
        >
          {/* Resizable + draggable modal */}
          <div
            data-road-modal="1"
            onClick={e => e.stopPropagation()}
            style={{
              background: 'white',
              borderRadius: '16px',
              boxShadow: '0 25px 60px rgba(0,0,0,0.3)',
              display: 'flex',
              flexDirection: 'column',
              width: '98vw',
              height: '96vh',
              minWidth: '640px',
              minHeight: '480px',
              resize: 'both',
              overflow: 'hidden',
              position: 'fixed',
              left: roadModalPos ? roadModalPos.x : '50%',
              top: roadModalPos ? roadModalPos.y : '50%',
              transform: roadModalPos ? 'none' : 'translate(-50%, -50%)',
              margin: 0,
            }}
          >
            {/* Two-column layout: form left, map right */}
            <div style={{display: 'flex', flexDirection: 'row', flex: 1, minHeight: 0}}>

              {/* LEFT COLUMN — fixed 390px, scrollable form */}
              <div style={{width: '390px', flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #f0f0f0', minHeight: 0}}>
                {/* Header — drag handle */}
                <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-100 shrink-0"
                  style={{cursor: 'grab'}}
                  onMouseDown={e => {
                    e.preventDefault();
                    const el = (e.currentTarget as HTMLElement).closest('[data-road-modal]') as HTMLElement | null;
                    const rect = el ? el.getBoundingClientRect() : { left: 0, top: 0 };
                    roadModalDragRef.current = {
                      startX: e.clientX,
                      startY: e.clientY,
                      origX: roadModalPos ? roadModalPos.x : rect.left,
                      origY: roadModalPos ? roadModalPos.y : rect.top,
                    };
                    if (!roadModalPos) setRoadModalPos({ x: rect.left, y: rect.top });
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-gray-300 text-sm select-none" title="Drag to move">⠿⠿</span>
                    <h2 className="text-lg font-bold text-gray-900">{editingRoad ? 'Edit Road' : 'New Road'}</h2>
                  </div>
                  <button onClick={() => { setShowRoadForm(false); setEditingRoad(null); setRoadSaved(false); setRoadNameError(false); }}
                    className="text-gray-400 hover:text-gray-600 text-xl leading-none p-1 rounded hover:bg-gray-100" title="Close">✕</button>
                </div>
                <div style={{flex: 1, overflowY: 'auto', padding: '16px 24px'}} className="space-y-4">

              {/* Road Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Road Name *</label>
                <input className={`input-field${roadNameError ? ' border-red-400 ring-1 ring-red-400' : ''}`} value={roadForm.name} placeholder="e.g. Road A, Main Street"
                  onChange={e => { setRoadForm(p => ({ ...p, name: e.target.value })); if (roadNameError && e.target.value.trim()) setRoadNameError(false); }} autoFocus />
                {roadNameError && <p className="mt-1 text-xs text-red-600">⚠️ Road name is required before saving.</p>}
              </div>

              {/* Feature 1 — Area dropdown (move route between areas) */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Area</label>
                <select className="input-field" value={roadForm.areaId}
                  onChange={e => setRoadForm(p => ({ ...p, areaId: e.target.value }))}>
                  {sweepAreas.map(a => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                {editingRoad && roadForm.areaId !== editingRoad.areaId && (
                  <p className="text-xs text-amber-600 mt-1">
                    ⚠️ This road will be moved from <strong>{sweepAreas.find(a => a.id === editingRoad.areaId)?.name}</strong> to <strong>{sweepAreas.find(a => a.id === roadForm.areaId)?.name}</strong>
                  </p>
                )}
              </div>

              {/* Feature 2 — Drawing options */}
              <div className="bg-gray-50 rounded-xl p-3 space-y-3">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Drawing Options</p>

                {/* Color picker */}
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={useAreaColor}
                      onChange={e => {
                        setUseAreaColor(e.target.checked);
                        if (e.target.checked) {
                          // Ticked on: sync custom colour to area colour
                          const area = sweepAreas.find(a => a.id === roadForm.areaId);
                          if (area) setRoadCustomColor(area.color);
                        } else {
                          // Ticked off: reset to neutral so area colour stops showing
                          setRoadCustomColor('#6366F1');
                          // Also clear any per-segment colours that were inherited from area
                          setSegmentColors(prev => prev.map(c =>
                            (!c || c === (sweepAreas.find(a => a.id === roadForm.areaId)?.color)) ? '' : c
                          ));
                        }
                      }}
                      className="rounded border-gray-300 text-indigo-600" />
                    <span className="text-sm text-gray-700">Use area colour</span>
                  </label>
                  {!useAreaColor && (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-600">Route colour:</span>
                      <input type="color" value={roadCustomColor}
                        onChange={e => setRoadCustomColor(e.target.value)}
                        className="w-9 h-9 rounded-lg border border-gray-300 cursor-pointer p-0.5 bg-white" />
                      <span className="text-xs text-gray-400 font-mono">{roadCustomColor}</span>
                    </div>
                  )}
                  {useAreaColor && (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-500">Route colour:</span>
                      <span className="w-6 h-6 rounded-full border-2 border-white shadow" style={{ backgroundColor: sweepAreas.find(a => a.id === roadForm.areaId)?.color || '#6366F1', display: 'inline-block' }} />
                      <span className="text-xs text-gray-400">from area</span>
                    </div>
                  )}
                </div>

                {/* Show point numbers */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={roadShowNumbers}
                    onChange={e => setRoadShowNumbers(e.target.checked)}
                    className="rounded border-gray-300 text-indigo-600" />
                  <span className="text-sm text-gray-700">Show point numbers on map</span>
                  <span className="text-xs text-gray-400">(when off, only A/B markers shown)</span>
                </label>

                {/* Show point markers / circles */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={roadShowMarkers}
                    onChange={e => setRoadShowMarkers(e.target.checked)}
                    className="rounded border-gray-300 text-indigo-600" />
                  <span className="text-sm text-gray-700">Show point circles on map</span>
                  <span className="text-xs text-gray-400">(when off, only clean lines shown — no dots)</span>
                </label>
              </div>

              {/* Feature 3 — Segment management */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-700">Route Segments</label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => guardSegmentSwitch(() => {
                        setRoadSegments(prev => [...prev, []]);
                        setSegmentIds(prev => [...prev, uid()]);
                        setSegmentNames(prev => [...prev, '']);
                        setSegmentColors(prev => [...prev, '']);
                        setRoadTurnarounds(prev => [...prev, []]);
                        setActiveSegIdx(roadSegments.length);
                      })}
                      className="btn-secondary text-xs py-1 px-3">+ Add Segment</button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 mb-2">
                  {roadSegments.map((seg, i) => {
                    // When useAreaColor is off, don't let area colour bleed into segments
                    const segEffectiveColor = segmentColors[i] || (useAreaColor ? roadFormEffectiveColor : roadCustomColor);
                    return (
                    <div key={i} className={`flex items-center gap-1 rounded-lg border px-2 py-1 transition ${
                      i === activeSegIdx
                        ? 'border-indigo-400 bg-indigo-50'
                        : 'border-gray-200 bg-white hover:bg-gray-50'
                    }`}>
                      {/* Colour dot — click to select segment */}
                      <button
                        onClick={() => guardSegmentSwitch(() => setActiveSegIdx(i))}
                        className="w-5 h-5 rounded-full flex-shrink-0 flex items-center justify-center text-white text-[9px] font-bold"
                        style={{ backgroundColor: segEffectiveColor }}
                        title={`Switch to segment ${String.fromCharCode(65 + i)}`}
                      >
                        {String.fromCharCode(65 + i)}
                      </button>
                      {/* Editable name */}
                      <input
                        className="text-xs font-semibold bg-transparent border-none outline-none w-20 min-w-0 placeholder-gray-400"
                        style={{ color: i === activeSegIdx ? '#4338ca' : '#6b7280' }}
                        value={segmentNames[i] ?? ''}
                        placeholder={`Seg ${String.fromCharCode(65 + i)}`}
                        onChange={e => setSegmentNames(prev => prev.map((n, ni) => ni === i ? e.target.value : n))}
                        onClick={() => guardSegmentSwitch(() => setActiveSegIdx(i))}
                        title="Click to edit segment name"
                      />
                      <span className="text-gray-400 text-xs shrink-0">({seg.length} pts)</span>
                      {/* Per-segment colour picker */}
                      <div className="relative flex items-center shrink-0" title="Set segment colour">
                        <input
                          type="color"
                          value={segmentColors[i] || (useAreaColor ? roadFormEffectiveColor : roadCustomColor)}
                          onChange={e => setSegmentColors(prev => prev.map((c, ci) => ci === i ? e.target.value : c))}
                          onClick={e => e.stopPropagation()}
                          className="w-5 h-5 rounded cursor-pointer border border-gray-300 p-0"
                          style={{ padding: 0, minWidth: '20px' }}
                          title="Segment route colour"
                        />
                      </div>
                      {roadSegments.length > 1 && (
                        <button
                          onClick={() => {
                            const updated = roadSegments.filter((_, si) => si !== i);
                            const updatedIds = segmentIds.filter((_, si) => si !== i);
                            const updatedNames = segmentNames.filter((_, si) => si !== i);
                            const updatedColors = segmentColors.filter((_, si) => si !== i);
                            const updatedTurnarounds = roadTurnarounds.filter((_, si) => si !== i);
                            setRoadSegments(updated);
                            setSegmentIds(updatedIds);
                            setSegmentNames(updatedNames);
                            setSegmentColors(updatedColors);
                            setRoadTurnarounds(updatedTurnarounds);
                            setActiveSegIdx(Math.min(activeSegIdx, updated.length - 1));
                          }}
                          className="text-red-400 hover:text-red-600 text-xs px-1 rounded hover:bg-red-50 shrink-0"
                          title="Delete segment">✕</button>
                      )}
                    </div>
                    );
                  })}
                </div>
                {roadSegments.length > 1 && (
                  <p className="text-xs text-blue-600 bg-blue-50 rounded-lg px-3 py-2 mb-2">
                    🗺️ Editing <strong>{segmentNames[activeSegIdx]?.trim() || `Segment ${String.fromCharCode(65 + activeSegIdx)}`}</strong> — click another segment tab to switch. All segments saved together as one route.
                  </p>
                )}
                <p className="text-xs text-gray-500">Click the map to add points · Drag to move · Right-click a point to delete it instantly · Click a point or line to stage it for bulk delete/transit (red = staged; Delete/🗑 to remove, Escape/✕ to clear, 🔀 to convert to transit instead) · Ctrl+drag to box-stage several at once · Small circles insert points</p>
              </div>

              {/* v73.109 — Segment Controls: a visually distinct, muted
                  "properties" panel for the active segment — NOT another
                  entry in the Route Segments list above (different
                  background/border style, smaller header, no colour-dot/tab
                  chrome) so it can't be mistaken for a segment row the way
                  the old always-visible "Turnaround Points (N)" block could
                  be. Turnarounds count shown as a summary line; the actual
                  T1..Tn list only renders once "Manage Turnarounds" is
                  clicked — collapsed by default, same principle as the rest
                  of this form (nothing shown unless there's a reason to). */}
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                  {(segmentNames[activeSegIdx]?.trim()) || `Segment ${String.fromCharCode(65 + activeSegIdx)}`} Controls
                </p>
                <div className="flex items-center justify-between text-xs text-gray-600">
                  <span>🔄 Turnarounds: <strong className="text-gray-800">{roadTurnarounds[activeSegIdx]?.length ?? 0}</strong></span>
                  <button
                    onClick={() => setShowTurnaroundManager(v => !v)}
                    className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                  >{showTurnaroundManager ? 'Hide' : 'Manage Turnarounds'}</button>
                </div>
                {showTurnaroundManager && (
                  <div className="mt-2 pt-2 border-t border-gray-200">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-xs font-medium text-gray-600">
                        {(segmentNames[activeSegIdx]?.trim()) || `Segment ${String.fromCharCode(65 + activeSegIdx)}`} — Turnaround Controls
                      </p>
                      {(roadTurnarounds[activeSegIdx]?.length ?? 0) > 0 && (
                        <button
                          onClick={() => {
                            if (!window.confirm(`Clear all ${roadTurnarounds[activeSegIdx].length} turnaround point(s) on this segment?`)) return;
                            setRoadTurnarounds(prev => prev.map((t, i) => i === activeSegIdx ? [] : t));
                          }}
                          className="text-xs text-red-500 hover:text-red-700"
                        >Clear Turnarounds</button>
                      )}
                    </div>
                    {(roadTurnarounds[activeSegIdx]?.length ?? 0) === 0 ? (
                      <p className="text-xs text-gray-400 italic">No turnaround points on this segment yet — use the 🔄 Turnaround button on the map toolbar to place one.</p>
                    ) : (
                      <div className="space-y-1 max-h-32 overflow-y-auto">
                        {roadTurnarounds[activeSegIdx].map((tp, ti) => (
                          <div key={tp.id} className="flex items-center gap-2 text-xs bg-orange-50 border border-orange-200 rounded px-2 py-1">
                            <span className="font-semibold text-orange-700">T{ti + 1}</span>
                            <span className="text-gray-500 font-mono">{tp.lat.toFixed(5)}, {tp.lng.toFixed(5)}</span>
                            <button
                              onClick={() => setRoadTurnarounds(prev => prev.map((t, i) => i !== activeSegIdx ? t : t.filter((_, pi) => pi !== ti)))}
                              className="ml-auto text-red-400 hover:text-red-600"
                              title="Delete this turnaround point"
                            >✕</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>


              {/* Notes */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <input className="input-field" value={roadForm.notes} placeholder="e.g. One-way, steep section at north end"
                  onChange={e => setRoadForm(p => ({ ...p, notes: e.target.value }))} />
              </div>
                </div>{/* end scrollable form */}

                {/* Footer buttons */}
                <div style={{padding: '12px 24px', borderTop: '1px solid #f0f0f0', flexShrink: 0}}>
                  {roadSaved && (
                    <div className="flex items-center justify-center gap-1.5 mb-2 py-1.5 px-3 bg-green-50 border border-green-200 rounded-lg text-sm font-semibold text-green-700">
                      ✅ Saved — keep drawing or close when finished
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setShowRoadForm(false); setEditingRoad(null); setRoadSaved(false); setRoadNameError(false); }}
                      className="btn-secondary flex-1"
                    >✕ Close</button>
                    <button onClick={saveRoad} className="btn-primary flex-1">
                      💾 {editingRoad ? 'Save Changes' : 'Create Road'}
                    </button>
                  </div>
                </div>
              </div>{/* end LEFT COLUMN */}

              {/* RIGHT COLUMN — full-height map fills remaining width */}
              <div style={{flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, background: '#f8fafc'}}>
                {(() => {
                  // v73.54 — Craig: "do the same to roads as zones when the
                  // area say e.g Hamilton the map will automatically move
                  // to Hamilton as the default." Same derivation
                  // ZoneEditorMap already uses (v73.46): prefer an existing
                  // road's first point in the same Area (real geometry),
                  // falling back to geocoding the Area's own name inside
                  // MultiSegmentRoadMap when no road exists yet to anchor to.
                  const areaRoadsForHint = roadForm.areaId ? getRoadsForArea(roadForm.areaId) : [];
                  const anchorRoad = areaRoadsForHint.find(r => r.points.length > 0);
                  const centerHint = anchorRoad ? { lat: anchorRoad.points[0].lat, lng: anchorRoad.points[0].lng } : null;
                  const areaName = sweepAreas.find(a => a.id === roadForm.areaId)?.name || '';
                  return (
                    <MultiSegmentRoadMap
                      // v73.86 — was keyed on `editingRoad ? road-${editingRoad.id}
                      // : 'new-road'`, which flips (and force-remounts,
                      // wiping in-map-only state) on a brand-new road's
                      // very first save, the moment setEditingRoad(created)
                      // runs — see the roadMapSessionKeyRef comment above
                      // for the full trace. One stable id per editor-session
                      // visit instead, set once in openAddRoad/openEditRoad,
                      // untouched by saveRoad.
                      key={roadMapSessionKeyRef.current}
                      draftKey={roadMapSessionKeyRef.current}
                      segments={roadSegments}
                      activeSegIdx={activeSegIdx}
                      onSegmentsChange={segs => setRoadSegments(segs)}
                      segmentNames={segmentNames}
                      color={roadFormEffectiveColor}
                      segmentColors={segmentColors}
                      showNumbers={roadShowNumbers}
                      showMarkers={roadShowMarkers}
                      height={-1}
                      syncServerUrl={syncServerUrl}
                      syncToken={syncToken}
                      centerHint={centerHint}
                      autoSearchQuery={areaName ? `${areaName} NZ` : ''}
                      onPendingSelectionChange={setHasPendingSelection}
                      turnarounds={roadTurnarounds}
                      onTurnaroundsChange={setRoadTurnarounds}
                    />
                  );
                })()}
              </div>{/* end RIGHT COLUMN */}

            </div>{/* end two-column flex */}
          </div>
        </div>
      )}

      {/* v73.27 — Zone add/edit modal. Simpler fixed-layout two-column modal
          (no drag/resize) — a Zone's form has far fewer fields than a Road's
          (no segments, no transit, no per-segment colour), so the extra
          complexity of the Road modal's draggable/resizable chrome isn't
          earning its keep here. */}
      {showZoneForm && (
        <div className="modal-overlay" style={{ alignItems: 'center', justifyContent: 'center' }}
          onMouseMove={e => {
            if (!zoneModalDragRef.current) return;
            const dx = e.clientX - zoneModalDragRef.current.startX;
            const dy = e.clientY - zoneModalDragRef.current.startY;
            setZoneModalPos({ x: zoneModalDragRef.current.origX + dx, y: zoneModalDragRef.current.origY + dy });
          }}
          onMouseUp={() => { zoneModalDragRef.current = null; }}
          onMouseLeave={() => { zoneModalDragRef.current = null; }}
        >
          <div data-zone-modal="1" onClick={e => e.stopPropagation()} style={{
            background: 'white', borderRadius: '16px', boxShadow: '0 25px 60px rgba(0,0,0,0.3)',
            display: 'flex', flexDirection: 'row',
            width: '98vw', height: '96vh', minWidth: '640px', minHeight: '480px',
            resize: 'both', overflow: 'hidden',
            position: 'fixed',
            left: zoneModalPos ? zoneModalPos.x : '50%',
            top: zoneModalPos ? zoneModalPos.y : '50%',
            transform: zoneModalPos ? 'none' : 'translate(-50%, -50%)',
            margin: 0,
          }}>
            {/* LEFT — form */}
            <div style={{ width: '340px', flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #f0f0f0' }}>
              <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-100 shrink-0"
                style={{ cursor: 'grab' }}
                onMouseDown={e => {
                  e.preventDefault();
                  const el = (e.currentTarget as HTMLElement).closest('[data-zone-modal]') as HTMLElement | null;
                  const rect = el ? el.getBoundingClientRect() : { left: 0, top: 0 };
                  zoneModalDragRef.current = {
                    startX: e.clientX,
                    startY: e.clientY,
                    origX: zoneModalPos ? zoneModalPos.x : rect.left,
                    origY: zoneModalPos ? zoneModalPos.y : rect.top,
                  };
                  if (!zoneModalPos) setZoneModalPos({ x: rect.left, y: rect.top });
                }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-gray-300 text-sm select-none" title="Drag to move">⠿⠿</span>
                  <h2 className="text-lg font-bold text-gray-900">{editingZone ? 'Edit Zone' : 'New Zone'}</h2>
                </div>
                <button onClick={() => { setShowZoneForm(false); setEditingZone(null); setZoneSaved(false); setZoneNameError(false); }}
                  className="text-gray-400 hover:text-gray-600 text-xl leading-none p-1 rounded hover:bg-gray-100" title="Close">✕</button>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Zone Name *</label>
                  <input className={`input-field${zoneNameError ? ' border-red-400 ring-1 ring-red-400' : ''}`}
                    value={zoneForm.name} placeholder="e.g. Fulton Hogan Waikato"
                    onChange={e => { setZoneForm(p => ({ ...p, name: e.target.value })); if (zoneNameError && e.target.value.trim()) setZoneNameError(false); }}
                    autoFocus />
                  {zoneNameError && <p className="mt-1 text-xs text-red-600">⚠️ Zone name is required before saving.</p>}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Area</label>
                  <select className="input-field" value={zoneForm.areaId}
                    onChange={e => setZoneForm(p => ({ ...p, areaId: e.target.value }))}>
                    {sweepAreas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Zone Type</label>
                  {(() => {
                    // v73.46 — Craig: "need to add zone type to the SW
                    // Categories so we can add, edit or delete the zone
                    // type drop down box in Areas & Roads / Zone / New
                    // Zone." The 5 original built-ins (Car Park, Business,
                    // Area, Park, Custom) stay first and keep their own
                    // icons — nothing about already-saved zones changes —
                    // with anything added under SW Categories → Zone Kinds
                    // appended after, same pattern already used for Area's
                    // own Zone Type selector just above.
                    // v73.51 seeded the 5 built-ins into the zone_kind
                    // SW Categories list too (so they're manageable there),
                    // but that means they now also come back out of this
                    // same query — without this filter they'd render a
                    // second time here with a generic 📍 instead of their
                    // real emoji, doubling the dropdown to 10 entries.
                    // Exclude anything whose name matches a built-in label
                    // (case-insensitive) so only genuinely custom items —
                    // ones actually added via SW Categories — get appended.
                    const builtInLabels = new Set(Object.values(ZONE_KIND_LABELS).map(l => l.toLowerCase()));
                    const customKinds = (data.sweepCategories || []).filter(c => c.categoryType === 'zone_kind').flatMap(c => c.items)
                      .filter(item => !builtInLabels.has((item.name || '').trim().toLowerCase()));
                    return (
                      <select className="input-field" value={zoneForm.zoneKind}
                        onChange={e => setZoneForm(p => ({ ...p, zoneKind: e.target.value }))}>
                        {(Object.keys(ZONE_KIND_LABELS)).map(k => (
                          <option key={k} value={k}>{ZONE_KIND_ICONS[k]} {ZONE_KIND_LABELS[k]}</option>
                        ))}
                        {customKinds.map(item => (
                          <option key={item.id} value={item.name}>📍 {item.name}</option>
                        ))}
                      </select>
                    );
                  })()}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Zone Colour</label>
                  <div className="flex items-center gap-2">
                    <input type="color" value={zoneForm.color}
                      onChange={e => setZoneForm(p => ({ ...p, color: e.target.value }))}
                      className="w-10 h-10 rounded cursor-pointer border border-gray-300" />
                    <span className="text-xs text-gray-500">{zoneForm.color}</span>
                  </div>
                </div>

                {/* v73.49 — Craig: "add extra sub zones in a main zone...
                    like a segment." Same tab pattern as Route Segments in
                    the road form — "Main" is always present (the zone's own
                    boundary, zonePoints), one tab per sub-zone. Whichever
                    tab is active determines what the map on the right is
                    currently drawing into. */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium text-gray-700">Sub-Zones</label>
                    <button onClick={addSubZone} className="text-xs text-blue-600 font-medium hover:underline">+ Add Sub-Zone</button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button onClick={() => setActiveSubZoneIdx(-1)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold border flex items-center gap-1.5 ${activeSubZoneIdx === -1 ? 'text-white border-transparent' : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'}`}
                      style={activeSubZoneIdx === -1 ? { backgroundColor: zoneForm.color } : undefined}>
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: zoneForm.color }} />
                      Main{zonePoints.length > 0 ? ` (${zonePoints.length} pts)` : ''}
                    </button>
                    {zoneSubZones.map((sz, i) => (
                      <span key={sz.id} className="inline-flex items-center">
                        <button onClick={() => setActiveSubZoneIdx(i)}
                          className={`px-2.5 py-1 rounded-l-lg text-xs font-semibold border flex items-center gap-1.5 ${activeSubZoneIdx === i ? 'text-white border-transparent' : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'}`}
                          style={activeSubZoneIdx === i ? { backgroundColor: sz.color } : undefined}>
                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: sz.color }} />
                          {sz.name.trim() || `Sub-Zone ${i + 1}`}{sz.points.length > 0 ? ` (${sz.points.length} pts)` : ''}
                        </button>
                        <button onClick={() => deleteSubZone(i)} title="Delete this sub-zone"
                          className="px-1.5 py-1 rounded-r-lg text-xs border border-l-0 border-gray-300 bg-white text-gray-400 hover:text-red-600 hover:border-red-300">✕</button>
                      </span>
                    ))}
                  </div>
                </div>

                {/* v73.49 — controls for whichever polygon (Main or a
                    sub-zone) is currently active, above the shared
                    click/drag/delete instructions since those apply to
                    both. */}
                <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-gray-600">
                      Editing: {activeSubZoneIdx === -1 ? 'Main zone boundary' : (zoneSubZones[activeSubZoneIdx]?.name.trim() || `Sub-Zone ${activeSubZoneIdx + 1}`)}
                    </p>
                    {/* v73.50 — Undo last point / Clear & Redraw, scoped to
                        whichever polygon is active. Disabled (not hidden)
                        when there's nothing to undo/clear yet, so the
                        buttons are always discoverable. */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button type="button" onClick={undoLastPoint} disabled={activePointsForUndo.length === 0}
                        title="Remove the last point you placed"
                        className="text-xs px-2 py-1 rounded border border-gray-300 bg-white text-gray-600 hover:border-gray-400 hover:text-gray-800 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-gray-300">
                        ↩ Undo Point
                      </button>
                      <button type="button" onClick={clearActivePoints} disabled={activePointsForUndo.length === 0}
                        title="Clear this shape's points and redraw — keeps the name/colour"
                        className="text-xs px-2 py-1 rounded border border-red-300 bg-white text-red-600 hover:border-red-400 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-red-300 disabled:hover:bg-white">
                        🗑 Clear &amp; Redraw
                      </button>
                    </div>
                  </div>
                  {activeSubZoneIdx >= 0 && (
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Sub-Zone Name (label)</label>
                      <input className="input-field text-sm py-1.5" placeholder="e.g. Zone 2"
                        value={zoneSubZones[activeSubZoneIdx]?.name || ''}
                        onChange={e => setZoneSubZones(prev => prev.map((sz, i) => i === activeSubZoneIdx ? { ...sz, name: e.target.value } : sz))} />
                    </div>
                  )}
                  {/* v73.50 — Craig: "want to be able to change a sub-zone's
                      colour independently from the main zone's colour."
                      SweepSubZone.color has existed since v73.49 (each
                      sub-zone already stored its own colour and the tabs/
                      map already read from it), but nothing in the UI ever
                      let it be changed after creation — addSubZone() just
                      seeded it from the parent zone's colour once. This is
                      the missing control. */}
                  {activeSubZoneIdx >= 0 && (
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Sub-Zone Colour</label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={zoneSubZones[activeSubZoneIdx]?.color || '#0088ff'}
                          onChange={e => setZoneSubZones(prev => prev.map((sz, i) => i === activeSubZoneIdx ? { ...sz, color: e.target.value } : sz))}
                          className="w-8 h-8 rounded cursor-pointer border border-gray-300" />
                        <span className="text-xs text-gray-500">{zoneSubZones[activeSubZoneIdx]?.color || '#0088ff'}</span>
                      </div>
                    </div>
                  )}
                  <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
                    <input type="checkbox"
                      checked={activeSubZoneIdx === -1 ? (zoneForm.fillEnabled ?? true) : (zoneSubZones[activeSubZoneIdx]?.fillEnabled ?? true)}
                      onChange={e => {
                        const checked = e.target.checked;
                        if (activeSubZoneIdx === -1) setZoneForm(p => ({ ...p, fillEnabled: checked }));
                        else setZoneSubZones(prev => prev.map((sz, i) => i === activeSubZoneIdx ? { ...sz, fillEnabled: checked } : sz));
                      }} />
                    Filled shading (uncheck for outline only — "transparent")
                  </label>
                  <p className="text-xs text-gray-500">
                    🏷️ Drag the coloured name label on the map to reposition it anywhere — it doesn't have to sit at the centre.
                  </p>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-700">
                  ℹ️ Zones are <strong>not</strong> included in sweep km totals — they track area (m²/ha), not distance. Use Roads for anything that needs km tracked.
                </div>

                <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 space-y-1">
                  <p>🔵 Click the map to place a boundary point</p>
                  <p>✋ Drag a point to move it</p>
                  <p>➕ Click a midpoint dot to add a point there</p>
                  <p>🖱️ Right-click a point to delete it (confirmed)</p>
                  <p>↩ Undo Point / 🗑 Clear &amp; Redraw above — undo the last point or wipe the shape without deleting the sub-zone</p>
                </div>

                {zonePoints.length > 0 && activeSubZoneIdx === -1 && (
                  <p className="text-xs text-gray-500">
                    {zonePoints.length} point{zonePoints.length !== 1 ? 's' : ''}
                    {zonePoints.length >= 3 ? ` · ${fmtZoneArea(polygonAreaM2(zonePoints))}` : ' · need at least 3 points'}
                  </p>
                )}
                {activeSubZoneIdx >= 0 && zoneSubZones[activeSubZoneIdx]?.points.length > 0 && (
                  <p className="text-xs text-gray-500">
                    {zoneSubZones[activeSubZoneIdx].points.length} point{zoneSubZones[activeSubZoneIdx].points.length !== 1 ? 's' : ''}
                    {zoneSubZones[activeSubZoneIdx].points.length >= 3 ? ` · ${fmtZoneArea(polygonAreaM2(zoneSubZones[activeSubZoneIdx].points))}` : ' · need at least 3 points to keep this sub-zone on save'}
                  </p>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                  <textarea className="input-field" rows={2} value={zoneForm.notes}
                    onChange={e => setZoneForm(p => ({ ...p, notes: e.target.value }))} />
                </div>
              </div>

              <div className="px-6 py-4 border-t border-gray-100 shrink-0 flex items-center gap-2">
                <button onClick={saveZone} className="btn-primary flex-1">{editingZone ? 'Save Changes' : 'Create Zone'}</button>
                {zoneSaved && <span className="text-xs text-green-600 font-medium">Saved ✓</span>}
              </div>
            </div>

            {/* RIGHT — map editor */}
            <div style={{ flex: 1, minWidth: 0, padding: '12px', display: 'flex', flexDirection: 'column' }}>
              {(() => {
                // v73.46 — derive where the map should open for a brand-new
                // zone: prefer the centroid of an existing zone already in
                // this Area (most accurate — real drawn geometry, not a
                // geocoded guess), falling back to geocoding the Area's own
                // name (autoSearchQuery) inside ZoneEditorMap itself when no
                // zone exists yet to anchor to.
                const areaZonesForHint = zoneForm.areaId ? getZonesForArea(zoneForm.areaId) : [];
                const anchorZone = areaZonesForHint.find(z => z.points.length > 0);
                const centerHint = anchorZone
                  ? {
                      lat: anchorZone.points.reduce((s, p) => s + p.lat, 0) / anchorZone.points.length,
                      lng: anchorZone.points.reduce((s, p) => s + p.lng, 0) / anchorZone.points.length,
                    }
                  : null;
                const areaName = sweepAreas.find(a => a.id === zoneForm.areaId)?.name || '';
                // v73.49 — which points/color/fillEnabled/label the map is
                // CURRENTLY editing depends on the active tab above; every
                // OTHER polygon belonging to this same zone (main + every
                // other sub-zone) renders underneath as static context —
                // Craig's "Zone 1 / Zone 2 / Zone 3 all visible together"
                // screenshot.
                const isSubActive = activeSubZoneIdx >= 0 && activeSubZoneIdx < zoneSubZones.length;
                const activePoints = isSubActive ? zoneSubZones[activeSubZoneIdx].points : zonePoints;
                const activeColor = isSubActive ? zoneSubZones[activeSubZoneIdx].color : zoneForm.color;
                const activeFillEnabled = isSubActive ? (zoneSubZones[activeSubZoneIdx].fillEnabled ?? true) : (zoneForm.fillEnabled ?? true);
                const activeLabelName = isSubActive ? zoneSubZones[activeSubZoneIdx].name : zoneForm.name;
                const activeLabelPos = isSubActive ? (zoneSubZones[activeSubZoneIdx].labelPos ?? null) : (zoneForm.labelPos ?? null);
                const handleActiveChange = (pts: RoadPoint[]) => {
                  if (isSubActive) setZoneSubZones(prev => prev.map((sz, i) => i === activeSubZoneIdx ? { ...sz, points: pts } : sz));
                  else setZonePoints(pts);
                };
                const handleActiveLabelPosChange = (pos: RoadPoint) => {
                  if (isSubActive) setZoneSubZones(prev => prev.map((sz, i) => i === activeSubZoneIdx ? { ...sz, labelPos: pos } : sz));
                  else setZoneForm(p => ({ ...p, labelPos: pos }));
                };
                const otherPolygons = [
                  ...(activeSubZoneIdx !== -1 && zonePoints.length > 0
                    ? [{ points: zonePoints, color: zoneForm.color, fillEnabled: zoneForm.fillEnabled ?? true, name: zoneForm.name, labelPos: zoneForm.labelPos ?? null }]
                    : []),
                  ...zoneSubZones
                    .filter((_, i) => i !== activeSubZoneIdx)
                    .filter(sz => sz.points.length > 0)
                    .map(sz => ({ points: sz.points, color: sz.color, fillEnabled: sz.fillEnabled ?? true, name: sz.name, labelPos: sz.labelPos ?? null })),
                ];
                return (
                  <ZoneEditorMap key={zonePoints.length === 0 && zoneSubZones.length === 0 ? `empty-${zoneForm.areaId}` : 'has-points'}
                    points={activePoints} onChange={handleActiveChange} color={activeColor} height={-1}
                    fillEnabled={activeFillEnabled} labelName={activeLabelName} labelPos={activeLabelPos}
                    onLabelPosChange={handleActiveLabelPosChange} otherPolygons={otherPolygons}
                    centerHint={centerHint} autoSearchQuery={areaName ? `${areaName} NZ` : ''} />
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
