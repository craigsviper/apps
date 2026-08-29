import { useState, useRef, useEffect, useMemo } from 'react';
import { useStore } from '../../store';
import type { RoadPoint, SweepRoad, SweepArea, DamagePin, SweepZone } from '../../types';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// v73.71 — same translucent "zone" road-highlight treatment as
// SweepJobs.tsx's editor/AllRoadsMap (see that file's comment near the top
// for the full rationale) — kept as a separate local const here since this
// is a separate module, values intentionally identical for a consistent look.
const ROAD_ZONE_HIGHLIGHT_WEIGHT = 16;
const ROAD_ZONE_HIGHLIGHT_OPACITY = 0.28;

/* ─── Inject location marker CSS once ─── */
const STYLE_ID = 'rsw-loc-styles';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    @keyframes rsw-pulse {
      0%   { transform: scale(1);   opacity: 0.9; }
      70%  { transform: scale(2.2); opacity: 0;   }
      100% { transform: scale(1);   opacity: 0;   }
    }
    .rsw-loc-dot-wrap { position: relative; width: 22px; height: 22px; }
    .rsw-loc-dot {
      position: absolute; inset: 3px;
      border-radius: 50%;
      background: var(--lc, #2563eb);
      border: 2.5px solid #fff;
      box-shadow: 0 1px 4px rgba(0,0,0,.4);
    }
    .rsw-loc-ring {
      position: absolute; inset: 0;
      border-radius: 50%;
      background: var(--lc, #2563eb);
      opacity: .5;
      animation: rsw-pulse 1.6s ease-out infinite;
    }
    .rsw-loc-arrow {
      width: 0; height: 0;
      border-left: 9px solid transparent;
      border-right: 9px solid transparent;
      border-bottom: 20px solid var(--lc, #2563eb);
      filter: drop-shadow(0 1px 2px rgba(0,0,0,.4));
    }
    .rsw-loc-pin {
      width: 18px; height: 26px;
      background: var(--lc, #2563eb);
      border-radius: 50% 50% 50% 0;
      transform: rotate(-45deg);
      border: 2.5px solid #fff;
      box-shadow: 0 1px 4px rgba(0,0,0,.4);
    }
  `;
  document.head.appendChild(s);
}

/* ─── Marker colour presets ─── */
const MARKER_COLORS = [
  { label: 'Blue',   value: '#2563eb' },
  { label: 'Cyan',   value: '#06b6d4' },
  { label: 'Green',  value: '#16a34a' },
  { label: 'Orange', value: '#ea580c' },
  { label: 'Red',    value: '#dc2626' },
  { label: 'Purple', value: '#7c3aed' },
  { label: 'Pink',   value: '#db2777' },
  { label: 'Yellow', value: '#ca8a04' },
];

type MarkerShape = 'dot' | 'arrow' | 'pin';
interface LocMarkerSettings { color: string; shape: MarkerShape; }

/* ─── Build Leaflet divIcon for current shape/colour ─── */
function makeLocIcon(s: LocMarkerSettings, heading?: number | null) {
  const c = s.color;
  if (s.shape === 'arrow') {
    const rot = heading != null && isFinite(heading) ? heading : 0;
    return L.divIcon({
      className: '',
      iconSize:   [18, 26],
      iconAnchor: [9, 13],
      html: `<div class="rsw-loc-arrow" style="--lc:${c};transform:rotate(${rot}deg)"></div>`,
    });
  }
  if (s.shape === 'pin') {
    return L.divIcon({
      className: '',
      iconSize:   [18, 26],
      iconAnchor: [9, 26],
      html: `<div class="rsw-loc-pin" style="--lc:${c}"></div>`,
    });
  }
  // default: pulsing dot
  return L.divIcon({
    className: '',
    iconSize:   [22, 22],
    iconAnchor: [11, 11],
    html: `<div class="rsw-loc-dot-wrap" style="--lc:${c}"><div class="rsw-loc-ring"></div><div class="rsw-loc-dot"></div></div>`,
  });
}

/* ─── Extracted settings panel — used in both mobile bottom sheet and desktop dropdown ─── */
interface LocSettingsProps { marker: LocMarkerSettings; onChange: (m: LocMarkerSettings) => void; onClose: () => void; }
function LocSettings({ marker, onChange, onClose }: LocSettingsProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="font-bold text-gray-900">Marker Settings</p>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">✕</button>
      </div>
      <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Colour</p>
      <div className="flex flex-wrap gap-2 mb-4">
        {MARKER_COLORS.map(mc => (
          <button key={mc.value} onClick={() => onChange({ ...marker, color: mc.value })} title={mc.label}
            className={`w-10 h-10 rounded-full border-4 transition-transform active:scale-95 ${marker.color === mc.value ? 'border-gray-900 scale-110' : 'border-white shadow'}`}
            style={{ backgroundColor: mc.value }} />
        ))}
        <label className="w-10 h-10 rounded-full border-2 border-dashed border-gray-300 flex items-center justify-center cursor-pointer hover:border-gray-500 relative" title="Custom colour">
          <span className="text-sm text-gray-400 font-bold">+</span>
          <input type="color" value={marker.color} onChange={e => onChange({ ...marker, color: e.target.value })}
            className="opacity-0 absolute inset-0 w-full h-full cursor-pointer" />
        </label>
      </div>
      <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Shape</p>
      <div className="grid grid-cols-3 gap-2 mb-4">
        {([
          { shape: 'dot'   as MarkerShape, label: '⬤ Dot',  desc: 'Pulsing circle' },
          { shape: 'arrow' as MarkerShape, label: '▲ Arrow', desc: 'Shows heading' },
          { shape: 'pin'   as MarkerShape, label: '📍 Pin',  desc: 'Classic pin' },
        ]).map(opt => (
          <button key={opt.shape} onClick={() => onChange({ ...marker, shape: opt.shape })}
            className={`py-3 rounded-xl border-2 text-center transition-all active:scale-95 ${marker.shape === opt.shape ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 text-gray-600'}`}>
            <div className="text-base">{opt.label}</div>
            <div className={`text-[10px] mt-0.5 ${marker.shape === opt.shape ? 'text-gray-300' : 'text-gray-400'}`}>{opt.desc}</div>
          </button>
        ))}
      </div>
      {/* Live preview */}
      <div className="p-3 bg-gray-50 rounded-xl flex items-center gap-3 border border-gray-100">
        <div dangerouslySetInnerHTML={{ __html:
          marker.shape === 'dot'
            ? `<div class="rsw-loc-dot-wrap" style="--lc:${marker.color}"><div class="rsw-loc-ring"></div><div class="rsw-loc-dot"></div></div>`
            : marker.shape === 'arrow'
            ? `<div class="rsw-loc-arrow" style="--lc:${marker.color}"></div>`
            : `<div class="rsw-loc-pin" style="--lc:${marker.color}"></div>`
        }} />
        <div>
          <p className="text-xs font-semibold text-gray-700">Preview</p>
          <p className="text-xs text-gray-400">{MARKER_COLORS.find(c => c.value === marker.color)?.label || 'Custom'} · {marker.shape}</p>
        </div>
      </div>
    </div>
  );
}

/* ─── Route Map with live location ─── */
interface RouteMapProps {
  jobRoads:       { roadId: string }[];
  jobDamagePins?: { roadId: string; pins: DamagePin[] }[];
  sweepRoads:     SweepRoad[];
  sweepAreas:     SweepArea[];
  jobZoneIds?:    string[];      // v73.51
  sweepZones?:    SweepZone[];   // v73.51
  height?:        number;
  tracking:       boolean;
  marker:      LocMarkerSettings;
  fullScreen:  boolean;
  keepScreen:  boolean;
  smoothGps:   boolean;  // "Road Lock": EMA jitter smoothing + snap to the job's mapped road geometry
  onGpsError:  (msg: string) => void;
}

// How much weight to give each new GPS reading (0–1).
// 0.35 = heavy smoothing — good for slow road-sweeper speeds (5–20 km/h).
// Raw GPS is used as-is when smoothGps is OFF (e.g. tip runs, off-road).
const SMOOTH_ALPHA = 0.35;

// ─── Snap-to-road ───────────────────────────────────────────────────────────
// BUG FIX (Craig-reported): the "Steady" toggle only ever did EMA jitter
// smoothing on the raw GPS reading — it never actually looked at where the
// road is, so the dot could still visibly wander off the road even while
// "locked". This adds real map-matching: the live position is snapped onto
// the nearest point of the job's own stored road geometry (RoadMap builder
// already has this data — the coloured lines drawn on this same map) whenever
// the GPS fix is within SNAP_THRESHOLD_METERS of a known road. If the fix is
// further away than that (off the mapped route — a tip run, unmapped street,
// parking, etc.) it's left alone rather than force-snapped somewhere wrong.
const SNAP_THRESHOLD_METERS = 25;

function metersPerDegree(lat: number) {
  const latRad = (lat * Math.PI) / 180;
  return { lat: 111320, lng: 111320 * Math.cos(latRad) };
}

// v73.51 — simple polygon centroid for zone labels with no explicit labelPos,
// same formula SweepJobs.tsx's polygonCentroid uses (average of vertices —
// good enough for label placement, not meant to be a true area-weighted
// centroid).
function simpleCentroid(points: RoadPoint[]): RoadPoint {
  if (points.length === 0) return { lat: 0, lng: 0 };
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  return { lat, lng };
}

// Projects (lat,lng) onto the nearest point of the nearest polyline in
// `segments`. Returns null if nothing is within SNAP_THRESHOLD_METERS.
function snapToNearestRoad(
  lat: number, lng: number, segments: [number, number][][]
): { lat: number; lng: number; distM: number } | null {
  if (segments.length === 0) return null;
  const { lat: mLat, lng: mLng } = metersPerDegree(lat);
  // Local planar (metres) projection with the query point as the origin —
  // accurate enough over the short segment lengths involved here.
  const toXY = (plat: number, plng: number): [number, number] => [(plng - lng) * mLng, (plat - lat) * mLat];
  let best: { x: number; y: number; distSq: number } | null = null;
  for (const seg of segments) {
    for (let i = 0; i < seg.length - 1; i++) {
      const [ax, ay] = toXY(seg[i][0], seg[i][1]);
      const [bx, by] = toXY(seg[i + 1][0], seg[i + 1][1]);
      const dx = bx - ax, dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      let t = lenSq > 0 ? (-ax * dx - ay * dy) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx, cy = ay + t * dy;
      const distSq = cx * cx + cy * cy;
      if (!best || distSq < best.distSq) best = { x: cx, y: cy, distSq };
    }
  }
  if (!best) return null;
  const distM = Math.sqrt(best.distSq);
  if (distM > SNAP_THRESHOLD_METERS) return null;
  return { lat: lat + best.y / mLat, lng: lng + best.x / mLng, distM };
}

function RouteMap({ jobRoads, jobDamagePins = [], sweepRoads, sweepAreas, jobZoneIds = [], sweepZones = [], height = 520, tracking, marker, fullScreen, keepScreen, smoothGps, onGpsError }: RouteMapProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const mapRef         = useRef<L.Map | null>(null);
  const locMarkerRef   = useRef<L.Marker | null>(null);
  const accCircleRef   = useRef<L.Circle | null>(null);
  const wakeLockRef    = useRef<WakeLockSentinel | null>(null);
  const watchIdRef     = useRef<number | null>(null);
  const smoothedPosRef = useRef<{ lat: number; lng: number } | null>(null); // EMA state
  const roadSegmentsRef = useRef<[number, number][][]>([]); // flattened road geometry for snap-to-road

  /* ── Wake lock — keep screen on while tracking + keepScreen ON ── */
  useEffect(() => {
    const acquire = async () => {
      if (!('wakeLock' in navigator)) return;
      try {
        wakeLockRef.current = await (navigator as Navigator & { wakeLock: { request: (t: string) => Promise<WakeLockSentinel> } }).wakeLock.request('screen');
        wakeLockRef.current.addEventListener('release', () => { wakeLockRef.current = null; });
      } catch { /* permission denied or not supported — fail silently */ }
    };
    const release = async () => {
      try { await wakeLockRef.current?.release(); } catch {/**/ }
      wakeLockRef.current = null;
    };
    const onVisibility = () => {
      // Re-acquire lock when tab/app comes back to foreground
      if (document.visibilityState === 'visible' && tracking && keepScreen) acquire();
    };

    if (tracking && keepScreen) {
      acquire();
      document.addEventListener('visibilitychange', onVisibility);
    } else {
      release();
    }
    return () => {
      release();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [tracking, keepScreen]);

  /* ── Build route map once ── */
  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) { try { mapRef.current.remove(); } catch {/**/ } mapRef.current = null; }

    const map = L.map(containerRef.current, {zoomSnap: 0.25, zoomDelta: 0.25, wheelPxPerZoomLevel: 120,  zoomControl: true, scrollWheelZoom: true, renderer: L.canvas({ tolerance: 8 }) });
    mapRef.current = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors', maxZoom: 19,
    }).addTo(map);

    const allLatLngs: [number, number][] = [];

    // drawSolidRuns: splits a point array into solid/transit runs and only
    // renders the solid ones. Transit edges (pts[i].transitAfter===true) are
    // completely invisible in the saved map view — only the editor shows them.
    const drawSolidRuns = (pts: RoadPoint[], color: string, road: SweepRoad, label?: string) => {
      if (pts.length < 2) return;
      let i = 0;
      let firstSolid = true;
      while (i < pts.length - 1) {
        const edgeTransit = pts[i].transitAfter === true;
        const runPts: [number, number][] = [[pts[i].lat, pts[i].lng]];
        while (i < pts.length - 1 && (pts[i].transitAfter === true) === edgeTransit) {
          runPts.push([pts[i + 1].lat, pts[i + 1].lng]);
          i++;
        }
        if (edgeTransit || runPts.length < 2) continue; // skip transit runs entirely
        runPts.forEach(x => allLatLngs.push(x));
        // v73.73 — Craig, referencing his own concept screenshot: Sweeping
        // Maps should show ONLY the translucent highlight band, no line at
        // all — Sweep Jobs' own route view is the one that keeps plain
        // lines (see that file's own v73.73 comment). Removed the halo +
        // centreline entirely here; the band itself now carries the road-
        // name tooltip since there's no longer a centreline to bind it to.
        const zone = L.polyline(runPts, {
          color, weight: ROAD_ZONE_HIGHLIGHT_WEIGHT, opacity: ROAD_ZONE_HIGHLIGHT_OPACITY,
          lineCap: 'round', lineJoin: 'round', interactive: !!firstSolid,
        }).addTo(map);
        if (firstSolid) {
          const mid = runPts[Math.floor(runPts.length / 2)];
          if (mid) zone.bindTooltip(`<b style="color:${color}">${label || road.name}</b>`, { permanent: false, direction: 'top' });
          firstSolid = false;
        }
      }
    };

    // Also flatten the raw road geometry (independent of the solid/transit
    // drawing split above) for live GPS snap-to-road — see snapToNearestRoad.
    const flatSegments: [number, number][][] = [];
    jobRoads.forEach(jr => {
      const road = sweepRoads.find(r => r.id === jr.roadId);
      if (!road) return;
      const area = sweepAreas.find(a => a.id === road.areaId);
      const fallback = road.color || area?.color || '#6366F1';
      if (road.segments && road.segments.length > 0) {
        road.segments.forEach(seg => {
          drawSolidRuns(seg.points, seg.color || fallback, road,
            `${road.name}${road.segments!.length > 1 ? ' · ' + seg.label : ''}`);
          if (seg.points && seg.points.length >= 2) flatSegments.push(seg.points.map(p => [p.lat, p.lng]));
        });
      } else {
        drawSolidRuns(road.points || [], fallback, road);
        if (road.points && road.points.length >= 2) flatSegments.push(road.points.map(p => [p.lat, p.lng]));
      }
    });
    roadSegmentsRef.current = flatSegments;

    // v73.51 — Craig: "zones is missing from... sweeping maps." Draws every
    // zone attached to this job (jobZoneIds) — its main boundary plus any
    // sub-zones — the same fillEnabled/color/labelPos-or-centroid rendering
    // rules the New/Edit Zone editor itself uses (v73.49/50), just read-only
    // here (no vertex markers, no drag, no click-to-add — this is a live
    // navigation map, not an editor).
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
          const lp = shape.labelPos || simpleCentroid(shape.points);
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


    // Draw damage / warning pins so they appear on the navigation map with popup details
    jobDamagePins.forEach(({ pins }) => {
      pins.forEach(pin => {
        const pinMode = pin.pinMode ?? (pin.damageType ? 'damage' : 'standard');
        const sev = (pin.severity || '').toLowerCase();
        const sevCol = sev.includes('critical') ? '#DC2626'
          : sev.includes('high')   ? '#EA580C'
          : sev.includes('medium') ? '#D97706'
          : sev.includes('low')    ? '#16A34A'
          : null;
        const col = sevCol || pin.color || (pinMode === 'damage' ? '#DC2626' : '#6366F1');
        const emojiMatch = (pin.damageType || '').match(/^(\p{Emoji}\uFE0F?)/u);
        const emoji = pinMode === 'standard' ? '📌' : (emojiMatch ? emojiMatch[0] : '⚠️');
        const icon = L.divIcon({
          className: '',
          html: `<div style="width:28px;height:28px;border-radius:50%;background:${col};border:2.5px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;font-size:13px;">${emoji}</div>`,
          iconSize: [28, 28], iconAnchor: [14, 14],
        });
        const mk = L.marker([pin.lat, pin.lng], { icon }).addTo(map);
        const tipLines = [
          `<strong>${pin.label || pin.damageType || 'Pin'}</strong>`,
          pin.damageType && pinMode === 'damage' ? `Type: ${pin.damageType}` : '',
          pin.severity ? `Severity: ${pin.severity}` : '',
          pin.description || '',
        ].filter(Boolean).join('<br>');
        mk.bindPopup(tipLines, { maxWidth: 220 });
      });
    });

    if (allLatLngs.length > 0) {
      map.fitBounds(L.latLngBounds(allLatLngs), { padding: [32, 32] });
    } else {
      map.setView([-38.6, 175.9], 10);
    }

    return () => {
      try { mapRef.current?.remove(); } catch {/**/ }
      mapRef.current = null;
      locMarkerRef.current = null;
      accCircleRef.current = null;
    };
  // v73.17 — Craig: "sweeping maps can't see the selected road after using
  // road mode and lasso mode as there no data points" — same root cause as
  // AllRoadsMap in SweepJobs.tsx: this effect only re-ran when the job's list
  // of road ids changed, never when a road already in the job had its route
  // (points/segments) edited afterward in Areas & Roads. Keyed off each
  // road's `updatedAt` too now, so a lasso-added/edited route shows up
  // immediately.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    jobRoads.map(j => j.roadId).join(','),
    jobRoads.map(j => sweepRoads.find(r => r.id === j.roadId)?.updatedAt || '').join(','),
    jobZoneIds.join(','), // v73.51
    jobZoneIds.map(id => sweepZones.find(z => z.id === id)?.updatedAt || '').join(','), // v73.51
  ]);

  /* ── Live location tracking ── */
  useEffect(() => {
    const stopWatch = () => {
      if (watchIdRef.current != null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      locMarkerRef.current?.remove(); locMarkerRef.current = null;
      accCircleRef.current?.remove(); accCircleRef.current = null;
      smoothedPosRef.current = null;  // Reset EMA state when tracking stops
    };

    if (!tracking) { stopWatch(); return; }
    if (!navigator.geolocation) { onGpsError('GPS not available in this browser'); return; }

    const onPos = (pos: GeolocationPosition) => {
      const map = mapRef.current;
      if (!map) return;
      const { latitude: rawLat, longitude: rawLng, accuracy, heading } = pos.coords;

      // EMA smoothing — reduces GPS jitter while driving roads.
      // Each update blends the new reading with the previous smoothed position.
      // Turned OFF for off-road (tip runs etc.) so raw GPS is used.
      let lat: number, lng: number;
      if (smoothGps && smoothedPosRef.current) {
        lat = SMOOTH_ALPHA * rawLat + (1 - SMOOTH_ALPHA) * smoothedPosRef.current.lat;
        lng = SMOOTH_ALPHA * rawLng + (1 - SMOOTH_ALPHA) * smoothedPosRef.current.lng;
      } else {
        lat = rawLat;
        lng = rawLng;
      }
      smoothedPosRef.current = { lat, lng };

      // Snap onto the actual stored road geometry when close enough — this
      // is what actually keeps the dot on the road; EMA smoothing above only
      // reduces jitter, it has no idea where the road physically is.
      if (smoothGps) {
        const snapped = snapToNearestRoad(lat, lng, roadSegmentsRef.current);
        if (snapped) { lat = snapped.lat; lng = snapped.lng; }
      }

      const latlng: [number, number] = [lat, lng];
      const icon = makeLocIcon(marker, heading);

      if (!locMarkerRef.current) {
        // First fix — create marker + accuracy circle and pan to location
        accCircleRef.current = L.circle(latlng, {
          radius: accuracy, color: marker.color, fillColor: marker.color,
          fillOpacity: 0.08, weight: 1, opacity: 0.4,
        }).addTo(map);
        locMarkerRef.current = L.marker(latlng, { icon, zIndexOffset: 1000 })
          .bindTooltip('📍 Your location', { permanent: false, direction: 'top' })
          .addTo(map);
        map.panTo(latlng, { animate: true, duration: 0.8 });
      } else {
        // Subsequent fixes — update position
        locMarkerRef.current.setLatLng(latlng);
        locMarkerRef.current.setIcon(icon);
        accCircleRef.current?.setLatLng(latlng).setRadius(accuracy);
        accCircleRef.current?.setStyle({ color: marker.color, fillColor: marker.color });
        // Auto-pan if location dot has moved outside the visible map area
        const bounds = map.getBounds();
        if (!bounds.contains(L.latLng(lat, lng))) {
          map.panTo(latlng, { animate: true, duration: 0.6 });
        }
      }
    };

    const onErr = (err: GeolocationPositionError) => {
      const msgs: Record<number, string> = {
        1: 'Location permission denied — allow GPS access in Firefox settings',
        2: 'Location unavailable — GPS signal lost',
        3: 'GPS timeout — check device settings',
      };
      onGpsError(msgs[err.code] || 'GPS error');
    };

    watchIdRef.current = navigator.geolocation.watchPosition(onPos, onErr, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 3000,
    });

    return stopWatch;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracking, marker.color, marker.shape, smoothGps]);

  /* ── Invalidate map size on fullscreen toggle so Leaflet redraws correctly ── */
  useEffect(() => {
    if (!mapRef.current) return;
    setTimeout(() => mapRef.current?.invalidateSize(), 50);
  }, [fullScreen]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}

/* ─── Mini thumbnail map ─── */
interface MiniMapProps { jobRoads: { roadId: string }[]; sweepRoads: SweepRoad[]; sweepAreas: SweepArea[]; jobZoneIds?: string[]; sweepZones?: SweepZone[]; }
function MiniMap({ jobRoads, sweepRoads, sweepAreas, jobZoneIds = [], sweepZones = [] }: MiniMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) { try { mapRef.current.remove(); } catch {/**/ } mapRef.current = null; }
    const map = L.map(containerRef.current, {zoomSnap: 0.25, zoomDelta: 0.25, wheelPxPerZoomLevel: 120,  zoomControl: false, scrollWheelZoom: false, dragging: false, attributionControl: false, renderer: L.canvas({ tolerance: 8 }) });
    mapRef.current = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    const allLatLngs: [number, number][] = [];
    jobRoads.forEach(jr => {
      const road = sweepRoads.find(r => r.id === jr.roadId);
      if (!road) return;
      const area = sweepAreas.find(a => a.id === road.areaId);
      const fallback = road.color || area?.color || '#6366F1';
      const drawSolidRuns = (pts: RoadPoint[], color: string) => {
        if (pts.length < 2) return;
        let i = 0;
        while (i < pts.length - 1) {
          const edgeTransit = pts[i].transitAfter === true;
          const runPts: [number, number][] = [[pts[i].lat, pts[i].lng]];
          while (i < pts.length - 1 && (pts[i].transitAfter === true) === edgeTransit) {
            runPts.push([pts[i + 1].lat, pts[i + 1].lng]);
            i++;
          }
          if (edgeTransit || runPts.length < 2) continue;
          runPts.forEach(x => allLatLngs.push(x));
          // v73.71 — same transparent zone highlight as RouteMap above,
          // scaled down (weight 10 vs 16) to match this thumbnail's thinner
          // 3px road lines instead of RouteMap's 5px.
          // v73.73 — no line here either, band only, same as RouteMap.
          L.polyline(runPts, {
            color, weight: 10, opacity: ROAD_ZONE_HIGHLIGHT_OPACITY,
            lineCap: 'round', lineJoin: 'round', interactive: false,
          }).addTo(map);
        }
      };
      if (road.segments?.length) road.segments.forEach(s => drawSolidRuns(s.points, s.color || fallback));
      else drawSolidRuns(road.points || [], fallback);
    });
    // v73.51 — same zones-on-the-map addition as RouteMap, simplified for a
    // small non-interactive thumbnail: shapes only, no labels (would be
    // illegible at thumbnail scale).
    jobZoneIds.forEach(zid => {
      const zone = sweepZones.find(z => z.id === zid);
      if (!zone) return;
      const shapes = [
        { points: zone.points, color: zone.color, fillEnabled: zone.fillEnabled ?? true },
        ...(zone.subZones || []).map(sz => ({ points: sz.points, color: sz.color, fillEnabled: sz.fillEnabled ?? true })),
      ];
      shapes.forEach(shape => {
        if (shape.points.length < 2) return;
        const latlngs = shape.points.map(p => [p.lat, p.lng] as [number, number]);
        latlngs.forEach(ll => allLatLngs.push(ll));
        if (shape.points.length >= 3) {
          L.polygon(latlngs, { color: shape.color, weight: 1.5, fillColor: shape.color, fillOpacity: shape.fillEnabled ? 0.15 : 0, dashArray: shape.fillEnabled ? undefined : [4, 3] }).addTo(map);
        } else {
          L.polyline(latlngs, { color: shape.color, weight: 1.5, dashArray: [4, 3] }).addTo(map);
        }
      });
    });
    if (allLatLngs.length > 0) map.fitBounds(L.latLngBounds(allLatLngs), { padding: [12, 12] });
    else map.setView([-38.6, 175.9], 8);
    return () => { try { mapRef.current?.remove(); } catch {/**/ } mapRef.current = null; };
  // v73.17 — same stale-geometry fix as RouteMap above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    jobRoads.map(j => j.roadId).join(','),
    jobRoads.map(j => sweepRoads.find(r => r.id === j.roadId)?.updatedAt || '').join(','),
    jobZoneIds.join(','), // v73.51
    jobZoneIds.map(id => sweepZones.find(z => z.id === id)?.updatedAt || '').join(','), // v73.51
  ]);
  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}

/* ─── Status styles ─── */
const STATUS_STYLE: Record<string, string> = {
  completed:   'bg-green-100 text-green-700',
  in_progress: 'bg-blue-100 text-blue-700',
  scheduled:   'bg-amber-100 text-amber-700',
  cancelled:   'bg-red-100 text-red-700',
};

/* ════════════════════════════════════════════════════════════
   MAIN COMPONENT
   ════════════════════════════════════════════════════════════ */
export default function SweepMaps() {
  const { data } = useStore();
  const sweepJobs  = data.sweepJobs  || [];
  const sweepRoads = data.sweepRoads || [];
  const sweepAreas = data.sweepAreas || [];
  const sweepZones = data.sweepZones || []; // v73.51

  const [viewJobId,    setViewJobId]    = useState<string | null>(null);
  const [search,       setSearch]       = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');

  /* ── Live location state ── */
  const [tracking,        setTracking]        = useState(false);
  const [showLocSettings, setShowLocSettings] = useState(false);
  const [locMarker,       setLocMarker]       = useState<LocMarkerSettings>({ color: '#2563eb', shape: 'dot' });
  const [gpsError,        setGpsError]        = useState('');
  const [fullScreen,      setFullScreen]      = useState(false);
  const [keepScreen,      setKeepScreen]      = useState(true);   // Screen wake lock — default ON for navigation use
  const [smoothGps,       setSmoothGps]       = useState(true);   // EMA smoothing to reduce GPS jitter — default ON

  const viewJob = sweepJobs.find(j => j.id === viewJobId) ?? null;

  /* ── Stop tracking when leaving map view ── */
  useEffect(() => {
    if (!viewJobId) {
      setTracking(false);
      setGpsError('');
      setShowLocSettings(false);
    }
  }, [viewJobId]);

  const filtered = useMemo(() => sweepJobs.filter(j => {
    const matchSearch = !search.trim() ||
      j.title?.toLowerCase().includes(search.toLowerCase()) ||
      j.jobNumber?.toLowerCase().includes(search.toLowerCase());
    const matchStatus = filterStatus === 'all' || j.status === filterStatus;
    return matchSearch && matchStatus;
  }), [sweepJobs, search, filterStatus]);

  const jobAreaLabel = (jobRoads: { roadId: string }[]) => {
    const areaIds = [...new Set(jobRoads.map(jr => sweepRoads.find(r => r.id === jr.roadId)?.areaId).filter(Boolean))];
    return areaIds.map(id => sweepAreas.find(a => a.id === id)?.name).filter(Boolean).join(', ') || '—';
  };

  /* ════════════════════════════════
     FULL MAP VIEW
     ════════════════════════════════ */
  if (viewJob) {
    const jobRoads      = viewJob.roads || [];
    // Collect damage/warning pins per road for display on navigation map
    const jobDamagePins = jobRoads
      .filter(jr => jr.damagePins && jr.damagePins.length > 0)
      .map(jr => ({ roadId: jr.roadId, pins: jr.damagePins }));
    const areaLabel  = jobAreaLabel(jobRoads);
    const statusClass = STATUS_STYLE[viewJob.status] || 'bg-gray-100 text-gray-600';

    return (
      <div className="flex flex-col h-full space-y-3">

        {/* ── Header ── */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-wrap min-w-0">
            <button onClick={() => setViewJobId(null)} className="btn-secondary shrink-0">← Back</button>
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-gray-900 truncate">{viewJob.title}</h1>
              <p className="text-sm text-gray-500">
                {viewJob.jobNumber && <span className="mr-2">{viewJob.jobNumber}</span>}
                {areaLabel && <span className="mr-2">📍 {areaLabel}</span>}
                <span>{jobRoads.length} road{jobRoads.length !== 1 ? 's' : ''}</span>
              </p>
            </div>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full shrink-0 ${statusClass}`}>
              {viewJob.status?.replace('_', ' ')}
            </span>
          </div>

          {/* ── Live Location controls ── */}
          <div className="flex items-center gap-2 relative">
            {viewJob.date && <span className="text-sm text-gray-400 hidden sm:block">📅 {viewJob.date}</span>}

            {/* Toggle button */}
            <button
              onClick={() => { setTracking(t => !t); setGpsError(''); }}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl font-semibold text-sm transition-all border-2 ${
                tracking
                  ? 'bg-emerald-600 border-emerald-600 text-white shadow-lg shadow-emerald-200'
                  : 'bg-white border-gray-300 text-gray-600 hover:border-emerald-400 hover:text-emerald-600'
              }`}
              title={tracking ? 'Turn off live location' : 'Turn on live location'}>
              <span className={`text-base ${tracking ? 'animate-pulse' : ''}`}>📍</span>
              <span className="hidden sm:inline">{tracking ? 'Live: ON' : 'Live Location'}</span>
              {/* ON/OFF pill */}
              <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${tracking ? 'bg-emerald-500 text-white' : 'bg-gray-200 text-gray-500'}`}>
                {tracking ? 'ON' : 'OFF'}
              </span>
            </button>

            {/* ── Settings button ── */}
            <button
              onClick={() => setShowLocSettings(s => !s)}
              className={`p-2.5 rounded-xl border-2 transition font-bold text-sm ${
                showLocSettings ? 'bg-gray-900 border-gray-900 text-white' : 'bg-white border-gray-300 text-gray-600 hover:border-gray-400'
              }`}
              title="Location marker settings">
              ⚙️
            </button>
          </div>
        </div>

        {/* ── GPS error banner ── */}
        {gpsError && (
          <div className="flex items-center justify-between px-4 py-2.5 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            <span>⚠️ {gpsError}</span>
            <button onClick={() => setGpsError('')} className="text-red-400 hover:text-red-700 ml-2 font-bold">✕</button>
          </div>
        )}

        {/* ── GPS tracking info banner — shows nav toggles when active ── */}
        {tracking && !gpsError && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-700">
            <span className="animate-pulse">📍</span>
            <span className="font-medium">Live location active</span>
            <span className="text-emerald-500 text-xs hidden sm:inline">· Circle = GPS accuracy</span>
            {/* Navigation toggles — right side */}
            <div className="flex items-center gap-2 ml-auto">
              {/* Keep Screen ON toggle */}
              <button
                onClick={() => setKeepScreen(v => !v)}
                title={keepScreen ? 'Screen stays on — tap to allow sleep' : 'Screen may sleep — tap to keep on'}
                className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg font-semibold border transition active:scale-95 ${
                  keepScreen
                    ? 'bg-amber-500 border-amber-500 text-white shadow-sm'
                    : 'bg-white border-gray-300 text-gray-500'
                }`}>
                <span>☀️</span>
                <span className="hidden xs:inline">{keepScreen ? 'Screen: ON' : 'Screen'}</span>
                <span className={`text-[10px] px-1 rounded font-bold ${keepScreen ? 'bg-amber-400 text-white' : 'bg-gray-200 text-gray-400'}`}>
                  {keepScreen ? 'ON' : 'OFF'}
                </span>
              </button>
              {/* Smooth GPS toggle */}
              <button
                onClick={() => setSmoothGps(v => !v)}
                title={smoothGps ? 'Road Lock ON — smooths GPS and snaps to the mapped road — tap for raw GPS (off-road)' : 'Raw GPS — tap to lock onto the mapped road and reduce wandering'}
                className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg font-semibold border transition active:scale-95 ${
                  smoothGps
                    ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm'
                    : 'bg-white border-gray-300 text-gray-500'
                }`}>
                <span>🔒</span>
                <span className="hidden xs:inline">{smoothGps ? 'Road Lock' : 'Raw GPS'}</span>
                <span className={`text-[10px] px-1 rounded font-bold ${smoothGps ? 'bg-indigo-500 text-white' : 'bg-gray-200 text-gray-400'}`}>
                  {smoothGps ? 'ON' : 'OFF'}
                </span>
              </button>
            </div>
          </div>
        )}

        {/* ── Map ── */}
        {jobRoads.length === 0 && (viewJob.zoneIds || []).length === 0 ? (
          <div className="card flex-1 flex flex-col items-center justify-center text-center py-16">
            <p className="text-4xl mb-3">🗺️</p>
            <p className="font-semibold text-gray-600">No roads or zones added to this job yet</p>
            <p className="text-sm text-gray-400 mt-1">Add roads in Sweep Jobs → Roads tab, or zones in the Zones tab</p>
          </div>
        ) : (
          <div className="card !p-0 overflow-hidden flex-1 relative" style={{ minHeight: 380 }}
            onClick={() => setShowLocSettings(false)}>
            {/* Fullscreen toggle button overlaid on map */}
            <button
              onClick={e => { e.stopPropagation(); setFullScreen(true); }}
              className="absolute top-3 right-3 z-[1000] bg-white/90 hover:bg-white border border-gray-300 rounded-lg p-2 shadow text-gray-700 text-base"
              title="Full screen map">
              ⛶
            </button>
            <div style={{ height: Math.max(380, window.innerHeight - 320) }}>
              <RouteMap
                jobRoads={jobRoads}
                jobDamagePins={jobDamagePins}
                sweepRoads={sweepRoads}
                sweepAreas={sweepAreas}
                jobZoneIds={viewJob?.zoneIds || []}
                sweepZones={sweepZones}
                tracking={tracking}
                marker={locMarker}
                fullScreen={false}
                keepScreen={keepScreen}
                smoothGps={smoothGps}
                onGpsError={msg => { setGpsError(msg); setTracking(false); }}
              />
            </div>
          </div>
        )}

        {/* ── Full-screen map modal ── */}
        {fullScreen && (
          <div className="fixed inset-0 z-[9999] bg-black flex flex-col">
            {/* Minimal header bar */}
            <div className="flex items-center justify-between px-4 py-2 bg-gray-900/95 text-white shrink-0">
              <span className="text-sm font-semibold truncate max-w-[40%]">{viewJob.title}</span>
              <div className="flex items-center gap-1.5 flex-wrap justify-end">
                {/* Live location toggle */}
                <button
                  onClick={() => { setTracking(t => !t); setGpsError(''); }}
                  className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-semibold transition ${
                    tracking ? 'bg-emerald-500 text-white' : 'bg-white/10 text-white border border-white/30'
                  }`}>
                  <span className={tracking ? 'animate-pulse' : ''}>📍</span>
                  {tracking ? 'Live: ON' : 'Live'}
                </button>
                {/* Keep Screen toggle */}
                <button
                  onClick={() => setKeepScreen(v => !v)}
                  title="Keep screen on"
                  className={`flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg font-semibold transition ${
                    keepScreen ? 'bg-amber-500 text-white' : 'bg-white/10 text-white border border-white/30'
                  }`}>
                  <span>☀️</span>
                  <span className="hidden sm:inline">{keepScreen ? 'Screen ON' : 'Screen'}</span>
                  <span className={`text-[10px] px-1 rounded font-bold ${keepScreen ? 'bg-amber-400 text-white' : 'bg-white/20 text-white'}`}>
                    {keepScreen ? 'ON' : 'OFF'}
                  </span>
                </button>
                {/* Smooth GPS toggle */}
                <button
                  onClick={() => setSmoothGps(v => !v)}
                  title="Road Lock (snap to mapped road) / Raw GPS"
                  className={`flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg font-semibold transition ${
                    smoothGps ? 'bg-indigo-500 text-white' : 'bg-white/10 text-white border border-white/30'
                  }`}>
                  <span>🔒</span>
                  <span className="hidden sm:inline">{smoothGps ? 'Road Lock' : 'Raw GPS'}</span>
                  <span className={`text-[10px] px-1 rounded font-bold ${smoothGps ? 'bg-indigo-400 text-white' : 'bg-white/20 text-white'}`}>
                    {smoothGps ? 'ON' : 'OFF'}
                  </span>
                </button>
                <button onClick={() => setShowLocSettings(s => !s)}
                  className="text-xs px-2.5 py-1.5 bg-white/10 border border-white/30 rounded-lg text-white">⚙️</button>
                <button onClick={() => setFullScreen(false)}
                  className="text-xs px-2.5 py-1.5 bg-white/10 border border-white/30 rounded-lg text-white font-bold" title="Exit fullscreen">✕</button>
              </div>
            </div>
            {/* GPS error in fullscreen */}
            {gpsError && (
              <div className="flex items-center justify-between px-4 py-2 bg-red-600/90 text-white text-xs shrink-0">
                <span>⚠️ {gpsError}</span>
                <button onClick={() => setGpsError('')} className="ml-2 font-bold">✕</button>
              </div>
            )}
            {/* Map fills all remaining space */}
            <div className="flex-1 min-h-0">
              <RouteMap
                jobRoads={jobRoads}
                jobDamagePins={jobDamagePins}
                sweepRoads={sweepRoads}
                sweepAreas={sweepAreas}
                jobZoneIds={viewJob?.zoneIds || []}
                sweepZones={sweepZones}
                tracking={tracking}
                marker={locMarker}
                fullScreen={true}
                keepScreen={keepScreen}
                smoothGps={smoothGps}
                onGpsError={msg => { setGpsError(msg); setTracking(false); }}
              />
            </div>
          </div>
        )}

        {/* ── Marker settings — bottom sheet on mobile, panel on desktop ── */}
        {showLocSettings && (
          <>
            {/* Mobile: full overlay + bottom sheet */}
            <div className="fixed inset-0 z-[10000] flex flex-col justify-end sm:hidden"
              onClick={() => setShowLocSettings(false)}>
              <div className="bg-white rounded-t-2xl shadow-2xl p-5 safe-bottom" onClick={e => e.stopPropagation()}>
                <div className="w-10 h-1 bg-gray-300 rounded-full mx-auto mb-4" />
                <LocSettings marker={locMarker} onChange={setLocMarker} onClose={() => setShowLocSettings(false)} />
              </div>
            </div>
            {/* Desktop: floating panel top-right of content area */}
            <div className="hidden sm:block fixed top-20 right-6 z-[10000] bg-white rounded-2xl shadow-2xl border border-gray-200 p-4 w-72">
              <LocSettings marker={locMarker} onChange={setLocMarker} onClose={() => setShowLocSettings(false)} />
            </div>
          </>
        )}

        {/* ── Road list ── */}
        {jobRoads.length > 0 && (
          <div className="card">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Roads in this job</p>
            <div className="flex flex-wrap gap-2">
              {jobRoads.map(jr => {
                const road = sweepRoads.find(r => r.id === jr.roadId);
                const area = road ? sweepAreas.find(a => a.id === road.areaId) : null;
                const color = road?.color || area?.color || '#6366F1';
                if (!road) return null;
                return (
                  <span key={jr.roadId} className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 font-medium">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                    {road.name}
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  /* ════════════════════════════════
     JOB CARD GRID
     ════════════════════════════════ */
  const statuses = [...new Set(sweepJobs.map(j => j.status).filter(Boolean))];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🗺️ Sweep Maps</h1>
          <p className="text-gray-500 text-sm mt-0.5">Route maps for each sweep job — updated automatically as jobs change</p>
        </div>
        <span className="text-xs bg-green-100 text-green-700 px-3 py-1.5 rounded-full font-medium">
          ✅ Auto-synced · {sweepJobs.length} job{sweepJobs.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <input className="input-field max-w-xs" placeholder="🔍 Search jobs…" value={search} onChange={e => setSearch(e.target.value)} />
        <div className="flex gap-1 flex-wrap">
          <button onClick={() => setFilterStatus('all')}
            className={`text-xs px-3 py-1.5 rounded-full border font-medium transition ${filterStatus === 'all' ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}`}>All</button>
          {statuses.map(s => (
            <button key={s} onClick={() => setFilterStatus(s)}
              className={`text-xs px-3 py-1.5 rounded-full border font-medium transition capitalize ${filterStatus === s ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}`}>
              {s.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      {sweepJobs.length === 0 ? (
        <div className="card text-center py-16">
          <p className="text-5xl mb-4">🗺️</p>
          <p className="font-semibold text-gray-600 text-lg mb-1">No sweep jobs yet</p>
          <p className="text-gray-400 text-sm">Create a sweep job with roads — its route map will appear here automatically.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card text-center py-12"><p className="text-gray-500">No jobs match your search or filter.</p></div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map(job => {
            const jobRoads = job.roads || [];
            const hasRoads = jobRoads.length > 0;
            const hasZones = (job.zoneIds || []).length > 0; // v73.51
            const areaLabel = jobAreaLabel(jobRoads);
            const statusClass = STATUS_STYLE[job.status] || 'bg-gray-100 text-gray-600';
            return (
              <div key={job.id} onClick={() => setViewJobId(job.id)}
                className="card cursor-pointer hover:shadow-lg transition group p-0 overflow-hidden">
                <div className="w-full bg-gray-100 rounded-t-xl overflow-hidden" style={{ height: 180 }}>
                  {hasRoads || hasZones
                    ? <MiniMap jobRoads={jobRoads} sweepRoads={sweepRoads} sweepAreas={sweepAreas} jobZoneIds={job.zoneIds || []} sweepZones={sweepZones} />
                    : <div className="w-full h-full flex flex-col items-center justify-center text-gray-400"><span className="text-3xl mb-1">🗺️</span><span className="text-xs">No roads added yet</span></div>
                  }
                </div>
                <div className="p-4">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      <h3 className="font-bold text-gray-900 truncate group-hover:text-indigo-700 transition">{job.title}</h3>
                      {job.jobNumber && <p className="text-xs text-gray-400">{job.jobNumber}</p>}
                    </div>
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0 capitalize ${statusClass}`}>
                      {job.status?.replace('_', ' ')}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
                    {areaLabel !== '—' && <span>📍 {areaLabel}</span>}
                    <span>🛣️ {jobRoads.length} road{jobRoads.length !== 1 ? 's' : ''}</span>
                    {job.date && <span>📅 {job.date}</span>}
                  </div>
                  {hasRoads && (() => {
                    const colors = [...new Set(jobRoads.map(jr => {
                      const road = sweepRoads.find(r => r.id === jr.roadId);
                      const area = road ? sweepAreas.find(a => a.id === road.areaId) : null;
                      return road?.color || area?.color || '#6366F1';
                    }))];
                    return (
                      <div className="flex gap-1 mt-2">
                        {colors.slice(0, 8).map((c, i) => <span key={i} className="w-3 h-3 rounded-full border border-white shadow-sm" style={{ backgroundColor: c }} />)}
                        {colors.length > 8 && <span className="text-xs text-gray-400">+{colors.length - 8}</span>}
                      </div>
                    );
                  })()}
                  <div className="flex items-center justify-between mt-3">
                    <p className="text-xs text-indigo-500 group-hover:text-indigo-700 font-medium transition">View route map →</p>
                    <span className="text-xs text-gray-400 flex items-center gap-1">📍 Live tracking</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
