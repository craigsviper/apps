import { useState, useRef, useEffect, useMemo } from 'react';
import { useStore } from '../store';
import { downloadFile } from '../utils/download';
import type { InspectionMap, MapPin } from '../types';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const uid = () => crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
const COLORS = ['#DC2626', '#2563EB', '#059669', '#D97706', '#7C3AED', '#BE185D', '#0891B2'];

type MapProvider = 'google' | 'openstreetmap' | 'custom_url' | 'uploaded' | 'company';

const PROVIDERS: { id: MapProvider; label: string; icon: string; desc: string }[] = [
  { id: 'google', label: 'Google Maps', icon: '🗺️', desc: 'Satellite/aerial view (Esri tiles)' },
  { id: 'openstreetmap', label: 'OpenStreetMap', icon: '🌍', desc: 'Street map view (OpenStreetMap tiles)' },
  { id: 'custom_url', label: 'Custom Online URL', icon: '🌐', desc: 'Paste any embeddable map URL' },
  { id: 'uploaded', label: 'Upload File', icon: '📤', desc: 'Upload an image file (JPG, PNG, SVG)' },
  { id: 'company', label: 'Company Map', icon: '🏢', desc: 'Upload a company-specific map file' },
];

/* ── Geocoding helpers ── */
async function geocode(query: string): Promise<{ lat: number; lng: number } | null> {
  const coordMatch = query.trim().match(/^([-\d.]+)\s*,\s*([-\d.]+)$/);
  if (coordMatch) return { lat: parseFloat(coordMatch[1]), lng: parseFloat(coordMatch[2]) };
  try {
    const resp = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`,
      { headers: { Accept: 'application/json' } });
    const results: { lat: string; lon: string }[] = await resp.json();
    if (results.length > 0) return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
  } catch { /* fall through */ }
  return null;
}

function googleEmbedUrl(lat: number, lng: number): string {
  return `https://maps.google.com/maps?q=${lat},${lng}&t=k&z=15&ie=UTF8&iwloc=&output=embed`;
}

function osmEmbedUrl(lat: number, lng: number, zoom = 16): string {
  const spread = 180 / Math.pow(2, zoom);
  const bbox = `${lng - spread},${lat - spread / 2},${lng + spread},${lat + spread / 2}`;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`;
}

function toEmbedUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return url;
  if (url.includes('/embed') || url.includes('export/embed') || url.includes('output=embed')) return url;
  if (url.match(/google\.[a-z.]+\/maps/i)) {
    const coordMatch = url.match(/@([-\d.]+),([-\d.]+),(\d+)/);
    if (coordMatch) return `https://maps.google.com/maps?q=${coordMatch[1]},${coordMatch[2]}&t=k&z=${coordMatch[3]}&ie=UTF8&iwloc=&output=embed`;
    const placeMatch = url.match(/\/place\/([^/]+)/);
    if (placeMatch) return `https://maps.google.com/maps?q=${encodeURIComponent(placeMatch[1].replace(/\+/g, ' '))}&t=k&z=15&ie=UTF8&iwloc=&output=embed`;
    return url;
  }
  if (url.includes('openstreetmap.org') && !url.includes('/export/embed')) {
    const hashMatch = url.match(/#map=(\d+)\/([-\d.]+)\/([-\d.]+)/);
    if (hashMatch) return osmEmbedUrl(parseFloat(hashMatch[2]), parseFloat(hashMatch[3]), parseInt(hashMatch[1]));
    return url;
  }
  return url;
}

function parseMapCoords(url: string): { lat: number; lng: number; zoom: number } | null {
  const gq = url.match(/[?&]q=([-\d.]+),([-\d.]+)/);
  if (gq) {
    const gz = url.match(/[?&]z=(\d+)/);
    return { lat: parseFloat(gq[1]), lng: parseFloat(gq[2]), zoom: parseInt(gz?.[1] || '15') };
  }
  const om = url.match(/marker=([-\d.]+),([-\d.]+)/);
  if (om) return { lat: parseFloat(om[1]), lng: parseFloat(om[2]), zoom: 16 };
  const bb = url.match(/bbox=([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)/);
  if (bb) return { lat: (parseFloat(bb[2]) + parseFloat(bb[4])) / 2, lng: (parseFloat(bb[1]) + parseFloat(bb[3])) / 2, zoom: 15 };
  return null;
}

function getMapCenter(m: InspectionMap): { lat: number; lng: number; zoom: number } {
  if (m.centerLat != null && m.centerLng != null) return { lat: m.centerLat, lng: m.centerLng, zoom: m.zoom ?? 15 };
  if (m.url) { const p = parseMapCoords(m.url); if (p) return p; }
  return { lat: 0, lng: 0, zoom: 2 };
}

function isImageType(m: InspectionMap): boolean {
  return (m.type === 'uploaded' || m.type === 'company') && !!m.imageData;
}

/* ── Component ── */
export default function Maps({ onNavigateToInspection }: { onNavigateToInspection?: (inspectionId: string) => void }) {
  const { data, addMap, updateMap, deleteMap, updateInspection } = useStore();

  /* === STATE === */
  const [showAdd, setShowAdd] = useState(false);
  const [viewMap, setViewMap] = useState<InspectionMap | null>(null);

  // Add modal
  const [provider, setProvider] = useState<MapProvider>('google');
  const [mapName, setMapName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState<{ lat: number; lng: number } | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [mapImage, setMapImage] = useState('');
  const [addPreviewLoading, setAddPreviewLoading] = useState(false);
  const [addSearchError, setAddSearchError] = useState('');

  // Pin
  const [addingPin, setAddingPin] = useState(false);
  const [pinLabel, setPinLabel] = useState('');
  const [pinDesc, setPinDesc] = useState('');
  const [pinColor, setPinColor] = useState('#DC2626');
  const [pinInspId, setPinInspId] = useState('');
  const [editPin, setEditPin] = useState<MapPin | null>(null);
  const [selectedPin, setSelectedPin] = useState<MapPin | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsError, setGpsError] = useState('');
  const [gpsSearchLoading, setGpsSearchLoading] = useState(false);

  // Edit modal
  const [editMapInfo, setEditMapInfo] = useState<InspectionMap | null>(null);
  const [editProvider, setEditProvider] = useState<MapProvider>('google');
  const [editSearch, setEditSearch] = useState('');
  const [editSearchResult, setEditSearchResult] = useState<{ lat: number; lng: number } | null>(null);
  const [editPreviewUrl, setEditPreviewUrl] = useState('');
  const [editCustomUrl, setEditCustomUrl] = useState('');
  const [editMapImage, setEditMapImage] = useState('');

  // Marker refresh trigger
  const [markerTick, setMarkerTick] = useState(0);

  /* === REFS === */
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const leafletRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const imageDimsRef = useRef({ w: 1000, h: 1000 });
  const imageReadyRef = useRef(false);

  // Refs synced with state (for Leaflet event handlers to avoid stale closures)
  const viewMapRef = useRef<InspectionMap | null>(null);
  const addingPinRef = useRef(false);
  const pinFormRef = useRef({ label: '', desc: '', color: '#DC2626', inspId: '' });

  useEffect(() => { viewMapRef.current = viewMap; }, [viewMap]);
  useEffect(() => { addingPinRef.current = addingPin; }, [addingPin]);
  useEffect(() => { pinFormRef.current = { label: pinLabel, desc: pinDesc, color: pinColor, inspId: pinInspId }; }, [pinLabel, pinDesc, pinColor, pinInspId]);

  /* === GPS HELPERS === */
  const getCurrentGPS = (): Promise<{ lat: number; lng: number }> => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('GPS is not supported by this browser. Try Chrome or Safari.'));
        return;
      }
      // Call directly — this triggers the browser permission prompt on ALL devices
      // (including mobile). Do NOT pre-check navigator.permissions as it silently
      // returns "denied" on some Android browsers without ever prompting the user.
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        (err) => {
          switch (err.code) {
            case err.PERMISSION_DENIED:
              reject(new Error(
                'Location access was denied. ' +
                'In your browser, tap the 🔒 icon in the address bar → ' +
                'Site Settings → Location → Allow, then try again.'
              ));
              break;
            case err.POSITION_UNAVAILABLE:
              reject(new Error('Location unavailable. Make sure GPS/Location Services are enabled on your device.'));
              break;
            case err.TIMEOUT:
              reject(new Error('GPS timed out. Move to an open area and try again.'));
              break;
            default:
              reject(new Error('Could not get location. Please try again.'));
          }
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      );
    });
  };

  const handleGPSPin = async () => {
    if (!viewMap) return;
    setGpsLoading(true);
    setGpsError('');
    try {
      const coords = await getCurrentGPS();
      if (isImageType(viewMap)) {
        // For image maps, we can't auto-place but we store GPS and tell user
        setGpsError(`GPS: ${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)} — Image maps require manual pin placement. Click on the map to place the pin. GPS coordinates will be stored with the pin.`);
        // Store GPS in the pin form ref for when they click
        pinFormRef.current = { ...pinFormRef.current, label: pinLabel || `GPS ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}` };
        setPinLabel(pinLabel || `GPS ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`);
      } else {
        // For online maps, place the pin at GPS coordinates and pan map there
        const map = leafletRef.current;
        if (map) {
          map.setView([coords.lat, coords.lng], Math.max(map.getZoom(), 16), { animate: true });
        }
        // Auto-fill label if empty
        if (!pinLabel) setPinLabel(`GPS ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`);
        // Create pin at GPS location
        createPin(0, 0, coords.lat, coords.lng);
      }
    } catch (err) {
      setGpsError(err instanceof Error ? err.message : 'Failed to get GPS location');
    } finally {
      setGpsLoading(false);
    }
  };

  const handleGPSSearch = async () => {
    setGpsSearchLoading(true);
    setAddSearchError('');
    try {
      const coords = await getCurrentGPS();
      setSearchQuery(`${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`);
      setSearchResult(coords);
      if (provider === 'google') setPreviewUrl(googleEmbedUrl(coords.lat, coords.lng));
      else setPreviewUrl(osmEmbedUrl(coords.lat, coords.lng, 16));
      if (!mapName.trim()) setMapName(`My Location (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`);
    } catch (err) {
      setAddSearchError(err instanceof Error ? err.message : 'Failed to get GPS location');
    } finally {
      setGpsSearchLoading(false);
    }
  };

  const handleGPSEditSearch = async () => {
    setGpsError('');
    try {
      const coords = await getCurrentGPS();
      setEditSearch(`${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`);
      setEditSearchResult(coords);
      if (editProvider === 'google') setEditPreviewUrl(googleEmbedUrl(coords.lat, coords.lng));
      else setEditPreviewUrl(osmEmbedUrl(coords.lat, coords.lng, 16));
    } catch (err) {
      setGpsError(err instanceof Error ? err.message : 'Failed to get GPS location');
      setTimeout(() => setGpsError(''), 6000);
    }
  };

  /* === HELPERS === */
  const getLinkedInspections = (mapData: InspectionMap, pin: MapPin) => {
    const ids = new Set<string>();
    if (pin.inspectionId) ids.add(pin.inspectionId);
    data.inspections.forEach(i => {
      // Legacy single-pin reference
      if (i.mapId === mapData.id && i.mapPinId === pin.id) ids.add(i.id);
      // New multi-pin array reference
      if ((i.mapPins || []).some(mp => mp.mapId === mapData.id && mp.pinId === pin.id)) ids.add(i.id);
    });
    return data.inspections.filter(i => ids.has(i.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };

  const condColor = (c: string) => {
    const m: Record<string, string> = { Excellent: 'bg-emerald-100 text-emerald-700', Good: 'bg-green-100 text-green-700', Fair: 'bg-amber-100 text-amber-700', Poor: 'bg-orange-100 text-orange-700', Critical: 'bg-red-100 text-red-700' };
    return m[c] || 'bg-gray-100 text-gray-700';
  };
  const statusColor = (s: string) => {
    const m: Record<string, string> = { draft: 'bg-gray-100 text-gray-700', in_progress: 'bg-blue-100 text-blue-700', completed: 'bg-emerald-100 text-emerald-700', reviewed: 'bg-purple-100 text-purple-700' };
    return m[s] || 'bg-gray-100 text-gray-700';
  };

  /* === HANDLERS === */
  const resetAddForm = () => {
    setMapName(''); setSearchQuery(''); setSearchResult(null); setPreviewUrl('');
    setCustomUrl(''); setMapImage(''); setProvider('google');
    setAddPreviewLoading(false); setAddSearchError('');
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setAddPreviewLoading(true);
    setAddSearchError('');
    const result = await geocode(searchQuery);
    if (result) {
      setSearchResult(result);
      if (provider === 'google') setPreviewUrl(googleEmbedUrl(result.lat, result.lng));
      else setPreviewUrl(osmEmbedUrl(result.lat, result.lng, 16));
      if (!mapName.trim()) setMapName(searchQuery);
    } else {
      setAddSearchError('Location not found. Try a different search or coordinates (e.g. -41.28, 174.77)');
    }
    setAddPreviewLoading(false);
  };

  const handleEditSearch = async () => {
    if (!editSearch.trim()) return;
    const result = await geocode(editSearch);
    if (result) {
      setEditSearchResult(result);
      if (editProvider === 'google') setEditPreviewUrl(googleEmbedUrl(result.lat, result.lng));
      else setEditPreviewUrl(osmEmbedUrl(result.lat, result.lng, 16));
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setMapImage(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleAddMap = () => {
    if (!mapName.trim()) return;
    let url = '', type: InspectionMap['type'] = 'uploaded', imageData = '';
    let centerLat: number | undefined, centerLng: number | undefined, zoom: number | undefined;

    if (provider === 'google' || provider === 'openstreetmap') {
      if (!searchResult) return;
      type = 'online'; url = previewUrl;
      centerLat = searchResult.lat; centerLng = searchResult.lng; zoom = 15;
    } else if (provider === 'custom_url') {
      if (!customUrl.trim()) return;
      type = 'online'; url = toEmbedUrl(customUrl);
      const parsed = parseMapCoords(url);
      if (parsed) { centerLat = parsed.lat; centerLng = parsed.lng; zoom = parsed.zoom; }
    } else {
      type = provider === 'company' ? 'company' : 'uploaded';
      imageData = mapImage;
    }
    addMap({ name: mapName, type, imageData, url, pins: [], centerLat, centerLng, zoom });
    resetAddForm(); setShowAdd(false);
  };

  const handleOpenMap = (m: InspectionMap) => {
    setViewMap(m); setSelectedPin(null); setAddingPin(false);
    imageReadyRef.current = false;
  };

  const handleCloseViewer = () => {
    // Save current Leaflet view position for online maps
    if (leafletRef.current && viewMap && viewMap.type === 'online') {
      const center = leafletRef.current.getCenter();
      const z = leafletRef.current.getZoom();
      updateMap({ ...viewMap, centerLat: center.lat, centerLng: center.lng, zoom: z });
    }
    setViewMap(null); setAddingPin(false); setSelectedPin(null);
  };

  const createPin = (x: number, y: number, lat: number, lng: number) => {
    const currentMap = viewMapRef.current;
    if (!currentMap) return;
    const form = pinFormRef.current;
    const pin: MapPin = {
      id: uid(), x, y, lat, lng,
      label: form.label || 'Pin',
      description: form.desc,
      inspectionId: form.inspId,
      color: form.color,
    };
    const updated = { ...currentMap, pins: [...currentMap.pins, pin] };
    updateMap(updated); setViewMap(updated);
    setPinLabel(''); setPinDesc(''); setPinInspId(''); setAddingPin(false);
  };

  const handleDeletePin = (pinId: string) => {
    if (!viewMap) return;
    const updated = { ...viewMap, pins: viewMap.pins.filter(p => p.id !== pinId) };
    updateMap(updated); setViewMap(updated);
    // Clean up ALL references to this pin — both old single-pin fields and new mapPins[]
    data.inspections.forEach(insp => {
      const hasSingleRef = insp.mapPinId === pinId;
      const hasMultiRef = (insp.mapPins || []).some(mp => mp.pinId === pinId);
      if (hasSingleRef || hasMultiRef) {
        updateInspection({
          ...insp,
          mapPinId: insp.mapPinId === pinId ? '' : insp.mapPinId,
          mapSnapshot: insp.mapPinId === pinId ? '' : insp.mapSnapshot,
          mapPins: (insp.mapPins || []).filter(mp => mp.pinId !== pinId),
        });
      }
    });
    setSelectedPin(null);
  };

  const handleUpdatePin = () => {
    if (!editPin || !viewMap) return;
    const updated = { ...viewMap, pins: viewMap.pins.map(p => p.id === editPin.id ? editPin : p) };
    updateMap(updated); setViewMap(updated); setEditPin(null);
    if (selectedPin?.id === editPin.id) setSelectedPin(editPin);
  };

  const exportPins = () => {
    if (!viewMap) return;
    const pinExportData = viewMap.pins.map(p => {
      const linked = getLinkedInspections(viewMap, p);
      return {
        label: p.label, description: p.description,
        lat: p.lat, lng: p.lng, x: p.x, y: p.y, color: p.color,
        linkedInspections: linked.map(i => ({ title: i.title, type: i.type, date: i.date, condition: i.condition, status: i.status })),
      };
    });
    const content = JSON.stringify({ mapName: viewMap.name, exportedAt: new Date().toISOString(), pins: pinExportData }, null, 2);
    const filename = `map-pins-${viewMap.name.replace(/\s+/g, '-')}.json`;
    downloadFile(content, filename, 'application/json');
  };

  const openEditMapInfo = (m: InspectionMap) => {
    setEditMapInfo({ ...m }); setEditMapImage(m.imageData || ''); setEditCustomUrl(m.url || '');
    setEditSearch(''); setEditSearchResult(null); setEditPreviewUrl(m.url || '');
    if (m.url?.includes('google')) setEditProvider('google');
    else if (m.url?.includes('openstreetmap')) setEditProvider('openstreetmap');
    else if (m.type === 'online') setEditProvider('custom_url');
    else if (m.type === 'company') setEditProvider('company');
    else setEditProvider('uploaded');
  };

  const handleUpdateMapInfo = () => {
    if (!editMapInfo) return;
    let url = editMapInfo.url, type = editMapInfo.type, imageData = editMapInfo.imageData;
    let centerLat = editMapInfo.centerLat, centerLng = editMapInfo.centerLng, zoom = editMapInfo.zoom;
    if (editProvider === 'google' || editProvider === 'openstreetmap') {
      type = 'online'; imageData = '';
      if (editSearchResult) {
        centerLat = editSearchResult.lat; centerLng = editSearchResult.lng; zoom = 15;
        url = editPreviewUrl || editMapInfo.url;
      } else { url = editPreviewUrl || editMapInfo.url; }
    } else if (editProvider === 'custom_url') {
      url = toEmbedUrl(editCustomUrl || editMapInfo.url); type = 'online'; imageData = '';
      const parsed = parseMapCoords(url);
      if (parsed) { centerLat = parsed.lat; centerLng = parsed.lng; zoom = parsed.zoom; }
    } else {
      type = editProvider as 'uploaded' | 'company';
      imageData = editMapImage || editMapInfo.imageData; url = '';
    }
    const updated = { ...editMapInfo, url, type, imageData, centerLat, centerLng, zoom };
    updateMap(updated);
    if (viewMap && viewMap.id === updated.id) setViewMap(updated);
    setEditMapInfo(null);
  };

  /* ═══════════════════════════════════════════
     LEAFLET MAP — Initialization
     ═══════════════════════════════════════════ */
  useEffect(() => {
    if (!viewMap || !mapContainerRef.current) return;

    // Destroy previous map instance
    if (leafletRef.current) {
      try { leafletRef.current.remove(); } catch { /* ignore */ }
      leafletRef.current = null;
    }
    markersRef.current.clear();
    imageReadyRef.current = false;

    const container = mapContainerRef.current;

    if (isImageType(viewMap)) {
      /* ── IMAGE MAP (CRS.Simple) ── */
      const map = L.map(container, {
        crs: L.CRS.Simple,
        minZoom: -3,
        maxZoom: 5,
        zoomSnap: 0.25,
        attributionControl: false,
        renderer: L.canvas({ tolerance: 8 }),
      });
      leafletRef.current = map;

      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        imageDimsRef.current = { w, h };
        const bounds: L.LatLngBoundsExpression = [[0, 0], [h, w]];
        L.imageOverlay(viewMap.imageData, bounds).addTo(map);
        map.fitBounds(bounds);
        imageReadyRef.current = true;
        setMarkerTick(t => t + 1);
      };
      img.src = viewMap.imageData;

      // Click handler for pin placement
      map.on('click', (e: L.LeafletMouseEvent) => {
        if (!addingPinRef.current) return;
        const { w, h } = imageDimsRef.current;
        const x = Math.max(0, Math.min(100, (e.latlng.lng / w) * 100));
        const y = Math.max(0, Math.min(100, (1 - e.latlng.lat / h) * 100));
        createPin(x, y, e.latlng.lat, e.latlng.lng);
      });

    } else {
      /* ── ONLINE MAP (Tile layers) ── */
      const center = getMapCenter(viewMap);
      const map = L.map(container, { attributionControl: true, renderer: L.canvas({ tolerance: 8 }) }).setView([center.lat, center.lng], center.zoom);
      leafletRef.current = map;

      const isGoogle = viewMap.type === 'online' && (viewMap.url?.includes('maps.google') ?? false);
      if (isGoogle) {
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
          attribution: 'Tiles &copy; Esri', maxZoom: 19,
        }).addTo(map);
        L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', {
          maxZoom: 19, pane: 'overlayPane',
        }).addTo(map);
      } else {
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          maxZoom: 19,
        }).addTo(map);
      }

      imageReadyRef.current = true;
      setMarkerTick(t => t + 1);

      // Click handler for pin placement
      map.on('click', (e: L.LeafletMouseEvent) => {
        if (!addingPinRef.current) return;
        createPin(0, 0, e.latlng.lat, e.latlng.lng);
      });
    }

    return () => {
      if (leafletRef.current) {
        try { leafletRef.current.remove(); } catch { /* ignore */ }
        leafletRef.current = null;
      }
      markersRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMap?.id]);

  // v73.124 — Craig: full mobile-field audit (Firefox Android primary target).
  // This map container's height is `calc(100dvh - 220px)` (see index.css),
  // which changes live as the mobile browser's address/tab bar shows or
  // hides on scroll, and again on device rotation. Leaflet caches its
  // internal pixel size at creation time and does NOT detect a resize of
  // its own container on its own — without this, the map would render at
  // its ORIGINAL size after the toolbar hid or the phone rotated: tiles
  // wrong, markers mispositioned, grey gaps at the edges, until something
  // else happened to trigger Leaflet's own resize handling. ResizeObserver
  // is the same proven pattern already used for the sweep-side map
  // containers (SweepJobs.tsx) — reused here rather than inventing a new
  // approach.
  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      try { leafletRef.current?.invalidateSize({ animate: false }); } catch { /* map not ready/already removed */ }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [viewMap?.id]);

  /* ═══════════════════════════════════════════
     LEAFLET MAP — Marker sync
     ═══════════════════════════════════════════ */
  // PERF FIX (v73.36): the marker-sync effect below used to depend on
  // `data.inspections` directly — the entire app's inspections array — so
  // editing ANY inspection anywhere, even one with no connection to the map
  // currently open, tore down and rebuilt every marker on this map (remove +
  // regenerate divIcon HTML + re-add + re-bind tooltip, per pin). This
  // signature narrows that down to only the inspections actually linked to
  // pins on `viewMap`, and only the fields that affect what a marker/tooltip
  // shows (id + updatedAt), so unrelated inspection edits elsewhere in the
  // app no longer touch this map's markers at all.
  const relevantInspSig = useMemo(() => {
    if (!viewMap) return '';
    const pinIds = new Set(viewMap.pins.map(p => p.id));
    return data.inspections
      .filter(i => (i.mapId === viewMap.id && i.mapPinId && pinIds.has(i.mapPinId)) ||
        (i.mapPins || []).some(mp => mp.mapId === viewMap.id && pinIds.has(mp.pinId)))
      .map(i => `${i.id}:${i.updatedAt}`)
      .sort()
      .join(',');
  }, [viewMap, data.inspections]);

  useEffect(() => {
    const map = leafletRef.current;
    if (!map || !viewMap) return;
    if (!imageReadyRef.current) return;

    // Clear old markers
    markersRef.current.forEach(m => m.remove());
    markersRef.current.clear();

    const isImage = isImageType(viewMap);
    const { w, h } = imageDimsRef.current;

    viewMap.pins.forEach(pin => {
      let lat: number, lng: number;
      if (isImage) {
        lng = (pin.x / 100) * w;
        lat = (1 - pin.y / 100) * h;
      } else {
        lat = pin.lat ?? pin.y ?? 0;
        lng = pin.lng ?? pin.x ?? 0;
      }

      const isSelected = selectedPin?.id === pin.id;
      const linkedCount = getLinkedInspections(viewMap, pin).length;
      const size = isSelected ? 36 : 28;

      const marker = L.marker([lat, lng], {
        icon: L.divIcon({
          className: 'leaflet-pin-marker',
          html: `
            <div style="position:relative;cursor:pointer;">
              <div style="
                background:${pin.color};
                width:${size}px; height:${size}px;
                border-radius:50%;
                border:${isSelected ? '3px solid #facc15' : '2px solid white'};
                box-shadow:0 2px 8px rgba(0,0,0,0.3)${isSelected ? ',0 0 0 4px rgba(250,204,21,0.4)' : ''};
                display:flex; align-items:center; justify-content:center;
                font-size:${isSelected ? 16 : 12}px;
                transition:all 0.15s;
              ">📍</div>
              ${linkedCount > 0 ? `<div style="
                position:absolute; top:-5px; right:-5px;
                min-width:18px; height:18px; padding:0 4px;
                background:#4f46e5; color:white;
                font-size:10px; font-weight:bold;
                border-radius:9px;
                display:flex; align-items:center; justify-content:center;
                box-shadow:0 1px 3px rgba(0,0,0,0.2);
              ">${linkedCount}</div>` : ''}
            </div>`,
          iconSize: [size, size],
          iconAnchor: [size / 2, size],
        }),
      }).addTo(map);

      marker.bindTooltip(
        `<strong>${pin.label}</strong>${linkedCount > 0 ? `<br><span style="color:#6366f1">${linkedCount} report${linkedCount !== 1 ? 's' : ''}</span>` : ''}`,
        { direction: 'top', offset: [0, -size / 2 - 4] }
      );

      marker.on('click', () => {
        if (!addingPinRef.current) setSelectedPin(pin);
      });

      markersRef.current.set(pin.id, marker);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMap, selectedPin?.id, markerTick, relevantInspSig]);

  /* === Toggle cursor when adding pin === */
  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el) return;
    if (addingPin) el.classList.add('leaflet-crosshair');
    else el.classList.remove('leaflet-crosshair');
  }, [addingPin]);

  // ════════════════════════════════════════════
  // MAP VIEWER
  // ════════════════════════════════════════════
  if (viewMap) {
    return (
      <div className="space-y-4">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <button onClick={handleCloseViewer} className="btn-secondary">← Back</button>
            <h1 className="text-xl font-bold text-gray-900">{viewMap.name}</h1>
            <span className="badge bg-gray-100 text-gray-600">{viewMap.type}</span>
            <span className="badge bg-blue-100 text-blue-700">{viewMap.pins.length} pins</span>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button onClick={() => openEditMapInfo(viewMap)} className="btn-secondary text-xs">✏️ Edit Info</button>
            <button onClick={exportPins} className="btn-secondary text-xs">📥 Export Pins</button>
            <button onClick={() => { setAddingPin(!addingPin); setSelectedPin(null); }}
              className={`text-xs ${addingPin ? 'btn-warning' : 'btn-primary'}`}>
              {addingPin ? '✕ Cancel Pin' : '📌 Add Pin'}
            </button>
          </div>
        </div>

        {/* Pin adding form */}
        {addingPin && (
          <div className="card bg-amber-50 border-amber-200">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm text-amber-800 font-medium">📌 Click on the map to place a pin, or use GPS</p>
              <button
                onClick={handleGPSPin}
                disabled={gpsLoading}
                className="btn-primary text-xs flex items-center gap-1.5 !py-1.5 !px-3"
              >
                {gpsLoading ? (
                  <><span className="animate-spin">⏳</span> Getting GPS...</>
                ) : (
                  <>📍 Use My GPS Location</>
                )}
              </button>
            </div>
            {gpsError && (
              <div className={`text-xs mb-3 p-2 rounded-lg ${gpsError.startsWith('GPS:') ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700'}`}>
                {gpsError.startsWith('GPS:') ? '📍 ' : '⚠️ '}{gpsError}
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <input className="input-field" value={pinLabel} onChange={e => setPinLabel(e.target.value)} placeholder="Pin label" />
              <input className="input-field" value={pinDesc} onChange={e => setPinDesc(e.target.value)} placeholder="Description" />
              <select className="input-field" value={pinInspId} onChange={e => setPinInspId(e.target.value)}>
                <option value="">Link to inspection…</option>
                {data.inspections.map(i => <option key={i.id} value={i.id}>{i.title}</option>)}
              </select>
              <div className="flex gap-1 items-center">
                {COLORS.map(c => (
                  <button key={c} onClick={() => setPinColor(c)}
                    className={`w-6 h-6 rounded-full border-2 ${pinColor === c ? 'border-gray-900 scale-110' : 'border-gray-200'}`}
                    style={{ backgroundColor: c }} />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Main grid */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          {/* Leaflet Map */}
          <div className="lg:col-span-3">
            <div className="card !p-2">
              <div
                ref={mapContainerRef}
                className="w-full rounded-lg"
                style={{ height: 'var(--map-h-offset-220)', minHeight: 500 }}
              />
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-3">
            {/* Pin detail panel */}
            {selectedPin && (() => {
              const linkedInsps = getLinkedInspections(viewMap, selectedPin);
              return (
                <div className="card border-2 border-indigo-200 bg-gradient-to-b from-indigo-50/50 to-white">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs shadow"
                        style={{ backgroundColor: selectedPin.color }}>📌</div>
                      <h3 className="font-bold text-gray-900">{selectedPin.label}</h3>
                    </div>
                    <button onClick={() => setSelectedPin(null)} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
                  </div>
                  {selectedPin.description && (
                    <p className="text-sm text-gray-600 mb-3 p-2 bg-white rounded-lg border border-gray-100">{selectedPin.description}</p>
                  )}
                  {selectedPin.lat != null && selectedPin.lng != null && (
                    <p className="text-xs text-gray-400 mb-2">📍 {selectedPin.lat.toFixed(6)}, {selectedPin.lng.toFixed(6)}</p>
                  )}
                  <div className="flex gap-2 mb-4">
                    <button onClick={() => setEditPin(selectedPin)} className="btn-secondary text-xs flex-1">✏️ Edit</button>
                    <button onClick={() => { if (confirm('Delete this pin?')) handleDeletePin(selectedPin.id); }} className="btn-danger text-xs flex-1">🗑️ Delete</button>
                  </div>
                  <div className="border-t border-indigo-100 pt-3">
                    <h4 className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-1.5">
                      📋 Inspection History
                      <span className="bg-indigo-100 text-indigo-700 text-xs px-1.5 py-0.5 rounded-full font-bold">{linkedInsps.length}</span>
                    </h4>
                    {linkedInsps.length === 0 ? (
                      <div className="text-center py-4">
                        <p className="text-xs text-gray-400">No inspections linked yet.</p>
                        <p className="text-xs text-gray-400">Link from the Inspections page.</p>
                      </div>
                    ) : (
                      <div className="space-y-2 max-h-[350px] overflow-y-auto">
                        {linkedInsps.map(insp => {
                          const client = data.clients.find(c => c.id === insp.assignedClientId);
                          return (
                            <div
                              key={insp.id}
                              className="p-3 bg-white rounded-lg border border-gray-200 hover:border-indigo-400 hover:shadow-md hover:bg-indigo-50 transition cursor-pointer group"
                              onClick={() => onNavigateToInspection?.(insp.id)}
                              title="Click to open this inspection"
                            >
                              <div className="flex items-center justify-between mb-1">
                                <div className="font-medium text-sm text-gray-900 group-hover:text-indigo-700">{insp.title}</div>
                                <span className="text-xs text-indigo-500 opacity-0 group-hover:opacity-100 transition font-medium">Open →</span>
                              </div>
                              <div className="flex flex-wrap gap-1 mb-2">
                                {insp.condition && <span className={`badge text-[10px] ${condColor(insp.condition)}`}>{insp.condition}</span>}
                                <span className={`badge text-[10px] ${statusColor(insp.status)}`}>{insp.status.replace('_', ' ')}</span>
                              </div>
                              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px] text-gray-500">
                                <span>📋 {insp.type || 'N/A'}</span>
                                <span>📅 {insp.date}</span>
                                {insp.location && <span className="col-span-2">📍 {insp.location}</span>}
                                <span>📷 {insp.photos.length} photo{insp.photos.length !== 1 ? 's' : ''}</span>
                                <span>💬 {insp.comments.length} comment{insp.comments.length !== 1 ? 's' : ''}</span>
                                {client && <span className="col-span-2">🏢 {client.name}</span>}
                              </div>
                              {insp.photos.length > 0 && (
                                <div className="flex gap-1 mt-2 overflow-x-auto">
                                  {insp.photos.slice(0, 4).map(p => (
                                    <img key={p.id} src={p.data} alt="" className="w-10 h-10 object-cover rounded shrink-0" />
                                  ))}
                                  {insp.photos.length > 4 && (
                                    <div className="w-10 h-10 bg-gray-100 rounded flex items-center justify-center text-[10px] text-gray-500 shrink-0">
                                      +{insp.photos.length - 4}
                                    </div>
                                  )}
                                </div>
                              )}
                              {insp.comments.length > 0 && (
                                <div className="mt-2 p-1.5 bg-amber-50 rounded text-[11px] text-amber-800">
                                  <span className="font-medium">[{insp.comments[insp.comments.length - 1].category}]</span>{' '}
                                  {insp.comments[insp.comments.length - 1].text.length > 80
                                    ? insp.comments[insp.comments.length - 1].text.slice(0, 80) + '…'
                                    : insp.comments[insp.comments.length - 1].text}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Pin list */}
            <div className="card">
              <h3 className="font-semibold text-gray-900 mb-3">Pins ({viewMap.pins.length})</h3>
              {viewMap.pins.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-4">No pins yet. Click "Add Pin" then click on the map.</p>
              ) : (
                <div className="space-y-2 max-h-[400px] overflow-y-auto">
                  {viewMap.pins.map(pin => {
                    const linkedInsps = getLinkedInspections(viewMap, pin);
                    const isSelected = selectedPin?.id === pin.id;
                    return (
                      <div key={pin.id}
                        className={`p-2 rounded-lg text-sm group cursor-pointer transition ${isSelected ? 'bg-indigo-100 border border-indigo-300' : 'bg-gray-50 hover:bg-gray-100'}`}
                        onClick={() => {
                          setSelectedPin(pin);
                          // Pan to pin on map
                          const marker = markersRef.current.get(pin.id);
                          if (marker && leafletRef.current) leafletRef.current.panTo(marker.getLatLng());
                        }}>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: pin.color }} />
                            <span className="font-medium text-gray-800">{pin.label}</span>
                            {linkedInsps.length > 0 && (
                              <span className="bg-indigo-100 text-indigo-700 text-[10px] px-1.5 py-0.5 rounded-full font-bold">{linkedInsps.length}</span>
                            )}
                          </div>
                          <div className="flex gap-1 opacity-0 group-hover:opacity-100" onClick={e => e.stopPropagation()}>
                            <button onClick={() => setEditPin(pin)} className="text-xs text-gray-400 hover:text-gray-600">✏️</button>
                            <button onClick={() => handleDeletePin(pin.id)} className="text-xs text-red-400 hover:text-red-600">🗑️</button>
                          </div>
                        </div>
                        {pin.description && <p className="text-xs text-gray-500 mt-1">{pin.description}</p>}
                        {linkedInsps.length > 0 && (
                          <div className="mt-1 space-y-0.5">
                            {linkedInsps.slice(0, 2).map(li => (
                              <p key={li.id} className="text-xs text-indigo-600 truncate">📋 {li.title}</p>
                            ))}
                            {linkedInsps.length > 2 && <p className="text-[10px] text-gray-400">+ {linkedInsps.length - 2} more…</p>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Edit Pin Modal */}
        {editPin && (
          <div className="modal-overlay" onClick={() => setEditPin(null)}>
            <div className="modal-content max-w-md p-6" onClick={e => e.stopPropagation()}>
              <h2 className="text-lg font-semibold mb-4">Edit Pin</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Label</label>
                  <input className="input-field" value={editPin.label} onChange={e => setEditPin({ ...editPin, label: e.target.value })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <textarea className="input-field" value={editPin.description} onChange={e => setEditPin({ ...editPin, description: e.target.value })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Link to Inspection</label>
                  <select className="input-field" value={editPin.inspectionId} onChange={e => setEditPin({ ...editPin, inspectionId: e.target.value })}>
                    <option value="">None</option>
                    {data.inspections.map(i => <option key={i.id} value={i.id}>{i.title}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Color</label>
                  <div className="flex gap-2">
                    {COLORS.map(c => (
                      <button key={c} onClick={() => setEditPin({ ...editPin, color: c })}
                        className={`w-8 h-8 rounded-full border-2 ${editPin.color === c ? 'border-gray-900 scale-110' : 'border-gray-200'}`}
                        style={{ backgroundColor: c }} />
                    ))}
                  </div>
                </div>
                <div className="flex gap-2 justify-between pt-2">
                  <button onClick={() => { handleDeletePin(editPin.id); setEditPin(null); }} className="btn-danger">Delete</button>
                  <div className="flex gap-2">
                    <button onClick={() => setEditPin(null)} className="btn-secondary">Cancel</button>
                    <button onClick={handleUpdatePin} className="btn-primary">Save</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Edit Map Info Modal */}
        {editMapInfo && (
          <div className="modal-overlay" onClick={() => setEditMapInfo(null)}>
            <div className="modal-content max-w-lg p-6" onClick={e => e.stopPropagation()}>
              <h2 className="text-lg font-semibold mb-4">Edit Map</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                  <input className="input-field" value={editMapInfo.name} onChange={e => setEditMapInfo({ ...editMapInfo, name: e.target.value })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Map Source</label>
                  <select className="input-field" value={editProvider} onChange={e => setEditProvider(e.target.value as MapProvider)}>
                    {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.icon} {p.label}</option>)}
                  </select>
                </div>
                              {(editProvider === 'google' || editProvider === 'openstreetmap') && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Search Location</label>
                  <div className="flex flex-col gap-2">
                    <input
                      className="input-field w-full"
                      style={{ minHeight: '48px', fontSize: '16px' }}
                      value={editSearch}
                      onChange={e => setEditSearch(e.target.value)}
                      placeholder="e.g. Auckland CBD, New Zealand"
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleEditSearch(); } }}
                      autoComplete="off" autoCorrect="off" spellCheck={false}
                    />
                    <div className="flex gap-2">
                      <button onClick={handleEditSearch} className="btn-primary flex-1" style={{ minHeight: '44px' }}>🔍 Search</button>
                      <button onClick={handleGPSEditSearch} className="btn-success flex-1" style={{ minHeight: '44px' }}>📍 GPS</button>
                    </div>
                  </div>
                    {editPreviewUrl && (
                      <div className="mt-3 rounded-lg overflow-hidden border border-gray-200">
                        <iframe src={editPreviewUrl} className="w-full border-0" style={{ height: 200 }} title="Preview" />
                      </div>
                    )}
                  </div>
                )}
                {editProvider === 'custom_url' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">URL</label>
                    <input className="input-field" value={editCustomUrl} onChange={e => setEditCustomUrl(e.target.value)} />
                  </div>
                )}
                {(editProvider === 'uploaded' || editProvider === 'company') && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Replace Image</label>
                    <input type="file" accept="image/*,.svg" onChange={(e) => {
                      const file = e.target.files?.[0]; if (!file) return;
                      const reader = new FileReader();
                      reader.onload = (ev) => setEditMapImage(ev.target?.result as string);
                      reader.readAsDataURL(file);
                    }} className="input-field" />
                    {editMapImage && <img src={editMapImage} alt="Preview" className="mt-2 w-full h-32 object-cover rounded-lg" />}
                  </div>
                )}
                <div className="flex gap-2 justify-end">
                  <button onClick={() => setEditMapInfo(null)} className="btn-secondary">Cancel</button>
                  <button onClick={handleUpdateMapInfo} className="btn-primary">Save</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ════════════════════════════════════════════
  // MAP LIST
  // ════════════════════════════════════════════
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Maps</h1>
          <p className="text-gray-500 text-sm mt-1">Manage maps, add location pins, and link to inspections</p>
        </div>
        <button onClick={() => { resetAddForm(); setShowAdd(true); }} className="btn-primary">+ Add Map</button>
      </div>

      {data.maps.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-4xl mb-3">🗺️</p>
          <p className="text-gray-500 mb-4">No maps yet. Add your first map to start pinning locations.</p>
          <button onClick={() => { resetAddForm(); setShowAdd(true); }} className="btn-primary">Add Your First Map</button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.maps.map(m => {
            const totalInspections = m.pins.reduce((acc, pin) => acc + getLinkedInspections(m, pin).length, 0);
            return (
              <div key={m.id} className="card cursor-pointer hover:shadow-md transition" onClick={() => handleOpenMap(m)}>
                {m.imageData ? (
                  <img src={m.imageData} alt={m.name} className="w-full h-40 object-cover rounded-lg mb-3" />
                ) : m.type === 'online' && m.url ? (
                  <div className="w-full h-40 bg-gradient-to-br from-blue-50 to-indigo-100 rounded-lg mb-3 flex flex-col items-center justify-center">
                    <span className="text-3xl mb-1">{m.url.includes('google') ? '🗺️' : m.url.includes('openstreetmap') ? '🌍' : '🌐'}</span>
                    <span className="text-xs text-indigo-600 font-medium">
                      {m.url.includes('google') ? 'Google Maps (Satellite)' : m.url.includes('openstreetmap') ? 'OpenStreetMap' : 'Online Map'}
                    </span>
                  </div>
                ) : (
                  <div className="w-full h-40 bg-gray-100 rounded-lg mb-3 flex items-center justify-center text-gray-400">
                    📄 No Preview
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-gray-900">{m.name}</h3>
                    <p className="text-xs text-gray-500">
                      {m.pins.length} pin(s) • {m.type}
                      {totalInspections > 0 && <span className="text-indigo-600 ml-1">• {totalInspections} inspection(s)</span>}
                    </p>
                  </div>
                  <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                    <button onClick={() => handleOpenMap(m)} className="p-1.5 rounded hover:bg-gray-100 text-gray-400">👁️</button>
                    <button onClick={() => openEditMapInfo(m)} className="p-1.5 rounded hover:bg-gray-100 text-gray-400">✏️</button>
                    <button onClick={() => {
                      if (confirm('Delete this map and unlink all related inspections?')) {
                        data.inspections.forEach(insp => {
                          const hasSingleRef = insp.mapId === m.id;
                          const hasMultiRef = (insp.mapPins || []).some(mp => mp.mapId === m.id);
                          if (hasSingleRef || hasMultiRef) {
                            updateInspection({
                              ...insp,
                              mapId: '',
                              mapPinId: '',
                              mapSnapshot: '',
                              mapPins: (insp.mapPins || []).filter(mp => mp.mapId !== m.id),
                            });
                          }
                        });
                        deleteMap(m.id);
                      }
                    }} className="p-1.5 rounded hover:bg-red-50 text-red-400">🗑️</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ADD MAP MODAL */}
      {showAdd && (
        <div className="modal-overlay" onClick={() => setShowAdd(false)}>
          <div className="modal-content max-w-2xl p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold">Add New Map</h2>
              <button onClick={() => setShowAdd(false)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Map Source</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                  {PROVIDERS.map(p => (
                    <button key={p.id} onClick={() => { setProvider(p.id); setPreviewUrl(''); setSearchResult(null); setAddSearchError(''); }}
                      className={`p-3 rounded-lg border-2 text-center transition ${provider === p.id
                        ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                      <span className="text-2xl block mb-1">{p.icon}</span>
                      <span className="text-xs font-medium leading-tight block">{p.label}</span>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-1">{PROVIDERS.find(p => p.id === provider)?.desc}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Map Name *</label>
                <input className="input-field" value={mapName} onChange={e => setMapName(e.target.value)} placeholder="e.g. Main Road Inspection Area" />
              </div>
              {(provider === 'google' || provider === 'openstreetmap') && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Search Location</label>
                    <div className="flex flex-col gap-2">
                      <input
                        className="input-field w-full"
                        style={{ minHeight: '52px', fontSize: '16px' }}
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        placeholder="e.g. 123 Main St, Auckland  or  -36.84, 174.76"
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSearch(); } }}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={handleSearch}
                          className="btn-primary flex-1"
                          style={{ minHeight: '48px', fontSize: '15px' }}
                          disabled={!searchQuery.trim() || addPreviewLoading}
                        >
                          {addPreviewLoading ? '⏳' : '🔍'} Search
                        </button>
                        <button
                          onClick={handleGPSSearch}
                          className="btn-success flex-1"
                          style={{ minHeight: '48px', fontSize: '15px' }}
                          disabled={gpsSearchLoading}
                        >
                          {gpsSearchLoading ? '⏳ Getting GPS…' : '📍 Use My Location'}
                        </button>
                      </div>
                    </div>
                    {addSearchError && <p className="text-xs text-red-600 mt-1">⚠️ {addSearchError}</p>}
                    {searchResult && <p className="text-xs text-green-600 mt-1">✅ Found: {searchResult.lat.toFixed(6)}, {searchResult.lng.toFixed(6)}</p>}
                  </div>
                  {previewUrl && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Preview</label>
                      <div className="rounded-lg overflow-hidden border border-gray-200">
                        <iframe src={previewUrl} className="w-full border-0" style={{ height: 250 }} title="Map Preview" />
                      </div>
                      <p className="text-xs text-green-600 mt-1">✅ Map ready — click "Add Map" to save</p>
                    </div>
                  )}
                </div>
              )}
              {provider === 'custom_url' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Map URL *</label>
                  <input className="input-field" value={customUrl} onChange={e => setCustomUrl(e.target.value)}
                    placeholder="https://www.openstreetmap.org/export/embed.html?..." />
                  <div className="mt-2 p-3 bg-blue-50 rounded-lg text-xs text-blue-700 space-y-1">
                    <p className="font-semibold">Note:</p>
                    <p>Custom URLs may not have coordinates parsed. For best results, use the Google Maps or OpenStreetMap provider above.</p>
                  </div>
                </div>
              )}
              {(provider === 'uploaded' || provider === 'company') && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {provider === 'company' ? 'Upload Company Map File' : 'Upload Map Image'}
                  </label>
                  <input type="file" accept="image/*,.svg" onChange={handleFileUpload} className="input-field" />
                  {mapImage && <img src={mapImage} alt="Preview" className="mt-2 w-full h-40 object-cover rounded-lg" />}
                  <p className="text-xs text-gray-400 mt-1">Supports: JPG, PNG, SVG</p>
                </div>
              )}
              <div className="flex gap-2 justify-end pt-2 border-t">
                <button onClick={() => setShowAdd(false)} className="btn-secondary">Cancel</button>
                <button onClick={handleAddMap} className="btn-primary"
                  disabled={
                    !mapName.trim() ||
                    ((provider === 'google' || provider === 'openstreetmap') && !searchResult) ||
                    (provider === 'custom_url' && !customUrl.trim())
                  }>
                  Add Map
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* EDIT MAP MODAL (from list view) */}
      {editMapInfo && !viewMap && (
        <div className="modal-overlay" onClick={() => setEditMapInfo(null)}>
          <div className="modal-content max-w-lg p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4">Edit Map</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input className="input-field" value={editMapInfo.name} onChange={e => setEditMapInfo({ ...editMapInfo, name: e.target.value })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Map Source</label>
                <select className="input-field" value={editProvider} onChange={e => setEditProvider(e.target.value as MapProvider)}>
                  {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.icon} {p.label}</option>)}
                </select>
              </div>
              {(editProvider === 'google' || editProvider === 'openstreetmap') && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Search Location</label>
                  <div className="flex flex-col gap-2">
                    <input
                      className="input-field w-full"
                      style={{ minHeight: '48px', fontSize: '16px' }}
                      value={editSearch}
                      onChange={e => setEditSearch(e.target.value)}
                      placeholder="e.g. Auckland, NZ"
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleEditSearch(); } }}
                      autoComplete="off" autoCorrect="off" spellCheck={false}
                    />
                    <div className="flex gap-2">
                      <button onClick={handleEditSearch} className="btn-primary flex-1" style={{ minHeight: '44px' }}>🔍 Search</button>
                      <button onClick={handleGPSEditSearch} className="btn-success flex-1" style={{ minHeight: '44px' }}>📍 GPS</button>
                    </div>
                  </div>
                  {editSearchResult && <p className="text-xs text-green-600 mt-1">✅ Found: {editSearchResult.lat.toFixed(6)}, {editSearchResult.lng.toFixed(6)}</p>}
                  {gpsError && <p className="text-xs text-red-600 mt-1">⚠️ {gpsError}</p>}
                  {editPreviewUrl && (
                    <div className="mt-3 rounded-lg overflow-hidden border border-gray-200">
                      <iframe src={editPreviewUrl} className="w-full border-0" style={{ height: 200 }} title="Preview" />
                    </div>
                  )}
                </div>
              )}
              {editProvider === 'custom_url' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">URL</label>
                  <input className="input-field" value={editCustomUrl} onChange={e => setEditCustomUrl(e.target.value)} />
                </div>
              )}
              {(editProvider === 'uploaded' || editProvider === 'company') && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Replace Image</label>
                  <input type="file" accept="image/*,.svg" onChange={(e) => {
                    const file = e.target.files?.[0]; if (!file) return;
                    const reader = new FileReader();
                    reader.onload = (ev) => setEditMapImage(ev.target?.result as string);
                    reader.readAsDataURL(file);
                  }} className="input-field" />
                  {editMapImage && <img src={editMapImage} alt="Preview" className="mt-2 w-full h-32 object-cover rounded-lg" />}
                </div>
              )}
              <div className="flex gap-2 justify-end">
                <button onClick={() => setEditMapInfo(null)} className="btn-secondary">Cancel</button>
                <button onClick={handleUpdateMapInfo} className="btn-primary">Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
