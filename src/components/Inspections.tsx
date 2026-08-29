import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useStore } from '../store';
import { generateMapSnapshot } from '../utils/mapSnapshot';
import { fixLeafletIcons } from '../utils/leafletIcons';
import type { Inspection, Photo, InspComment, InspectionMap } from '../types';
import { compressImage } from '../utils/imageCompress';
import { localDateKey } from '../utils/date';

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const now = () => new Date().toISOString();

interface PinLink {
  id: string;
  mapId: string;
  pinId: string;
  snapshot: string;
  loading: boolean;
}

type FormData = {
  title: string; type: string; date: string; location: string;
  latitude: string; longitude: string;
  description: string; photos: Photo[]; comments: InspComment[];
  condition: string; status: Inspection['status'];
  assignedClientId: string; createdBy: string;
};

const emptyForm = (): FormData => ({
  title: '', type: '', date: localDateKey(),
  location: '', latitude: '', longitude: '',
  description: '', photos: [], comments: [],
  condition: '', status: 'draft', assignedClientId: '', createdBy: '',
});

// fixLeafletIcons() now lives in ../utils/leafletIcons and is called once at
// app startup (main.tsx) — see v72.4. Still imported and called here too
// (harmless no-op after the first call) so this file keeps working exactly
// the same if it's ever refactored to mount before main.tsx's call somehow.

// ── PhotoGpsMap — read-only OSM map used in the photo detail modal ────────────
function PhotoGpsMap({ lat, lng }: { lat: number; lng: number }) {
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!mapRef.current || leafletRef.current) return;
    fixLeafletIcons();
    const map = L.map(mapRef.current, { center: [lat, lng], zoom: 16, zoomControl: true, scrollWheelZoom: true, renderer: L.canvas({ tolerance: 8 }) });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 19,
    }).addTo(map);
    L.marker([lat, lng]).addTo(map)
      .bindPopup(`<b>📍 Photo Location</b><br/>${lat.toFixed(6)}, ${lng.toFixed(6)}`).openPopup();
    leafletRef.current = map;
    return () => { leafletRef.current?.remove(); leafletRef.current = null; };
  }, [lat, lng]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={mapRef} style={{ height: 260, width: '100%', background: '#e5e7eb' }} aria-label="GPS location map" />;
}

// ── PhotoGpsMapEditable — draggable OSM map used inline in the edit form ──────
// The pin is draggable: when released, onPinMoved(lat, lng) fires so the
// photo's GPS coordinates update in real-time without re-mounting the map.
function PhotoGpsMapEditable({
  lat, lng, onPinMoved,
}: { lat: number; lng: number; onPinMoved: (lat: number, lng: number) => void }) {
  const mapRef    = useRef<HTMLDivElement>(null);
  const leafletRef= useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  // Keep latest callback in ref so the Leaflet event handler is never stale
  const cbRef     = useRef(onPinMoved);
  useEffect(() => { cbRef.current = onPinMoved; }, [onPinMoved]);

  useEffect(() => {
    if (!mapRef.current || leafletRef.current) return;
    fixLeafletIcons();

    const map = L.map(mapRef.current, {
      center: [lat, lng], zoom: 16,
      zoomControl: true, scrollWheelZoom: true, renderer: L.canvas({ tolerance: 8 }),
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 19,
    }).addTo(map);

    const marker = L.marker([lat, lng], { draggable: true })
      .addTo(map)
      .bindPopup(`<b>📍 Drag to adjust</b><br/>${lat.toFixed(6)}, ${lng.toFixed(6)}`);

    marker.on('drag', () => {
      const p = marker.getLatLng();
      marker.setPopupContent(`<b>📍 Photo Location</b><br/>${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`);
    });
    marker.on('dragend', () => {
      const p = marker.getLatLng();
      cbRef.current(p.lat, p.lng);
    });

    leafletRef.current = map;
    markerRef.current  = marker;
    return () => { leafletRef.current?.remove(); leafletRef.current = null; markerRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — intentional mount-once

  return (
    <div
      ref={mapRef}
      style={{ height: 220, width: '100%' }}
      aria-label="GPS location map — drag the pin to adjust coordinates"
    />
  );
}

export default function Inspections({ filterInspectionId, onClearFilter }: { filterInspectionId?: string | null; onClearFilter?: () => void } = {}) {
  const { data, currentUser, addInspection, updateInspection, deleteInspection, updateMap } = useStore();
  const [view, setView] = useState<'list' | 'form' | 'detail'>('list');
  const [editingInsp, setEditingInsp] = useState<Inspection | null>(null);
  const [form, setForm] = useState<FormData>(emptyForm());
  const [pinLinks, setPinLinks] = useState<PinLink[]>([]);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterCondition, setFilterCondition] = useState('');
  const [statusTab, setStatusTab] = useState<'all' | 'draft' | 'in_progress' | 'completed'>('all');
  const [photoComment, setPhotoComment] = useState('');
  const [commentText, setCommentText] = useState('');
  const [commentCat, setCommentCat] = useState('');
  const [detailInsp, setDetailInsp] = useState<Inspection | null>(null);
  const [showPhotoModal, setShowPhotoModal] = useState<Photo | null>(null);
  // Lightbox state — tracks the full photo list for prev/next navigation
  const [lbPhotos,  setLbPhotos]  = useState<Photo[]>([]);
  const [lbIdx,     setLbIdx]     = useState(0);
  const openLightbox = (photos: Photo[], idx: number) => {
    setLbPhotos(photos); setLbIdx(idx); setShowPhotoModal(photos[idx]);
  };
  const lbNext = () => { const i = (lbIdx + 1) % lbPhotos.length; setLbIdx(i); setShowPhotoModal(lbPhotos[i]); };
  const lbPrev = () => { const i = (lbIdx + lbPhotos.length - 1) % lbPhotos.length; setLbIdx(i); setShowPhotoModal(lbPhotos[i]); };
  const [saveMsg, setSaveMsg] = useState('');
  const fileRef       = useRef<HTMLInputElement>(null);
  const gpsFileRef      = useRef<HTMLInputElement>(null);   // separate input for GPS-tagged photos
  const extraPhotoRef   = useRef<HTMLInputElement>(null);   // input for "+ add photo" on existing cards
  const pendingGps    = useRef<{lat:number;lng:number}|null>(null); // GPS coords captured before camera opens
  const pendingPinLink= useRef<{mapId:string;pinId:string}|null>(null); // pin to auto-link to
  const [gpsLoading, setGpsLoading] = useState<Record<string, boolean>>({});
  const [gpsPhotoMsg, setGpsPhotoMsg] = useState('');
  // GPS Location Lock — keeps the same coords for up to 3 photos at one spot
  const [lockedGps,     setLockedGps]     = useState<{lat:number;lng:number}|null>(null);
  const [lockedPinLink, setLockedPinLink] = useState<{mapId:string;pinId:string}|null>(null);
  const [lockedPhotoCount, setLockedPhotoCount] = useState(0);
  const GPS_PHOTO_LIMIT = 5; // max photos per locked location
  // GPS pin detail inputs — shown before creating a new GPS pin on the map
  const [gpsPinInput, setGpsPinInput] = useState<{linkId:string;label:string;description:string;notes:string}|null>(null);
  // GPS location fields — collapsed by default, only shown when user wants them
  const [showGpsFields, setShowGpsFields] = useState(false);
  // Confirm/Cancel step shown before a freshly-fetched GPS reading is applied —
  // prevents a stale/wrong-location GPS fix from being silently attached to an
  // inspection (Craig-reported bug: new inspection picked up GPS from a
  // different location and conflicted).
  const [pendingGpsConfirm, setPendingGpsConfirm] = useState<{
    lat: number; lng: number; label: string; onConfirm: () => void; onCancel: () => void;
  } | null>(null);

  const inspTypes = data.categories.find(c => c.type === 'inspection_type')?.items || [];
  const conditions = data.categories.find(c => c.type === 'condition')?.items || [];
  const commentCats = data.categories.find(c => c.type === 'comment_category')?.items || [];

  // Auto-open detail view when navigated from Dashboard or map pin history
  // GUARD: never override 'form' view — user may be mid-edit when this fires
  useEffect(() => {
    if (!filterInspectionId) return;
    if (view === 'form') return; // don't yank user out of an edit in progress
    const insp = data.inspections.find(i => i.id === filterInspectionId);
    if (insp) {
      setDetailInsp(insp);
      setView('detail');
    }
  }, [filterInspectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep detailInsp in sync with live data when in DETAIL view only.
  // GUARD: never run when view='form' — updateInspection triggers data.inspections
  // to change, which would previously cause a state update mid-edit and could
  // interact with React's batching to reset view state.
  useEffect(() => {
    if (!detailInsp) return;
    if (view === 'form') return; // don't interfere while user is editing
    const fresh = data.inspections.find(i => i.id === detailInsp.id);
    if (fresh && fresh.updatedAt !== detailInsp.updatedAt) {
      setDetailInsp(fresh);
    }
  }, [data.inspections]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── PIN LINK HANDLERS ────────────────────────────────────────────────────

  const addPinLink = () => {
    setPinLinks(prev => [...prev, { id: uid(), mapId: '', pinId: '', snapshot: '', loading: false }]);
  };

  const removePinLink = (id: string) => {
    const updated = pinLinks.filter(p => p.id !== id);
    setPinLinks(updated);
    autoSavePinLinks(updated);
  };

  const addGpsPinToMap = async (linkId: string, pinLabel?: string, pinDescription?: string) => {
    const link = pinLinks.find(p => p.id === linkId);
    if (!link?.mapId) return;
    setGpsLoading(prev => ({ ...prev, [linkId]: true }));
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 })
      );
      const { latitude: lat, longitude: lng } = pos.coords;
      const selMap = data.maps.find(m => m.id === link.mapId);
      if (!selMap) return;
      // Create new pin on the map
      const newPin = {
        id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
        x: 50, y: 50, // default center position for image maps
        lat, lng,
        label: `GPS Pin ${selMap.pins.length + 1}`,
        description: `Added from inspection at ${new Date().toLocaleString()}`,
        inspectionId: '',
        color: '#DC2626',
      };
      const updatedMap = { ...selMap, pins: [...selMap.pins, newPin], updatedAt: new Date().toISOString() };
      updateMap(updatedMap);
      // Generate snapshot immediately using the updated map + new pin
      setPinLinks(prev => prev.map(p => p.id === linkId ? { ...p, pinId: newPin.id, loading: true, snapshot: '' } : p));
      try {
        const snap = await generateMapSnapshot(updatedMap, newPin, 480, 280);
        setPinLinks(prev => {
          const updated = prev.map(p => p.id === linkId ? { ...p, snapshot: snap || '', loading: false } : p);
          autoSavePinLinks(updated);
          return updated;
        });
      } catch {
        setPinLinks(prev => prev.map(p => p.id === linkId ? { ...p, loading: false } : p));
      }
      setGpsPinInput(null);
      setSaveMsg('📍 GPS pin added to map!');
      setTimeout(() => setSaveMsg(''), 3000);
    } catch (err: unknown) {
      const msg = err instanceof GeolocationPositionError
        ? (err.code === 1 ? 'Location permission denied' : err.code === 2 ? 'Location unavailable' : 'Location timeout')
        : 'GPS error';
      setSaveMsg(`❌ ${msg}`);
      setTimeout(() => setSaveMsg(''), 4000);
    } finally {
      setGpsLoading(prev => ({ ...prev, [linkId]: false }));
    }
  };

  // Auto-save pins to the inspection whenever pinLinks change so the map always reflects current state
  const autoSavePinLinks = (updatedLinks: typeof pinLinks) => {
    if (!editingInsp) return; // only auto-save when editing an existing inspection
    const mapPinsData = updatedLinks
      .filter(p => p.mapId)
      .map(p => ({ mapId: p.mapId, pinId: p.pinId, snapshot: p.snapshot }));
    const savePayload = {
      ...form,
      mapId: mapPinsData[0]?.mapId || '',
      mapPinId: mapPinsData[0]?.pinId || '',
      mapSnapshot: mapPinsData[0]?.snapshot || '',
      mapPins: mapPinsData,
    };
    updateInspection({ ...editingInsp, ...savePayload });
  };

  const updatePinLinkMap = (id: string, mapId: string) => {
    const updated = pinLinks.map(p => p.id === id ? { ...p, mapId, pinId: '', snapshot: '' } : p);
    setPinLinks(updated);
    // Auto-save so map section updates immediately without needing to click Save
    autoSavePinLinks(updated);
  };

  const updatePinLinkPin = async (id: string, pinId: string, mapId: string) => {
    // Set loading
    setPinLinks(prev => prev.map(p => p.id === id ? { ...p, pinId, loading: true, snapshot: '' } : p));

    // Generate snapshot
    try {
      const selMap = data.maps.find(m => m.id === mapId);
      const selPin = selMap?.pins.find(p => p.id === pinId);
      if (selMap) {
        const snap = await generateMapSnapshot(selMap, selPin, 480, 280);
        setPinLinks(prev => {
          const updated = prev.map(p => p.id === id ? { ...p, snapshot: snap || '', loading: false } : p);
          autoSavePinLinks(updated);
          return updated;
        });
      } else {
        setPinLinks(prev => prev.map(p => p.id === id ? { ...p, loading: false } : p));
      }
    } catch {
      setPinLinks(prev => prev.map(p => p.id === id ? { ...p, loading: false } : p));
    }
  };

  const refreshSnapshot = async (id: string) => {
    const link = pinLinks.find(p => p.id === id);
    if (!link) return;
    setPinLinks(prev => prev.map(p => p.id === id ? { ...p, loading: true } : p));
    try {
      const selMap = data.maps.find(m => m.id === link.mapId);
      const selPin = selMap?.pins.find(p => p.id === link.pinId);
      if (selMap) {
        const snap = await generateMapSnapshot(selMap, selPin, 480, 280);
        setPinLinks(prev => {
          const updated = prev.map(p => p.id === id ? { ...p, snapshot: snap || '', loading: false } : p);
          autoSavePinLinks(updated);
          return updated;
        });
      } else {
        setPinLinks(prev => prev.map(p => p.id === id ? { ...p, loading: false } : p));
      }
    } catch {
      setPinLinks(prev => prev.map(p => p.id === id ? { ...p, loading: false } : p));
    }
  };

  // ── OPEN FORM ────────────────────────────────────────────────────────────

  const openNew = () => {
    setForm({ ...emptyForm(), createdBy: currentUser?.name || '' });
    setPinLinks([]);
    setEditingInsp(null);
    setSaveMsg('');
    setShowGpsFields(false);
    // BUG FIX: these were never reset when starting a new inspection, so a
    // GPS Location Lock left engaged from a previous inspection (e.g. worker
    // didn't tap "Release" after finishing at site A) silently carried its
    // old coordinates into a brand-new inspection at site B — the exact
    // "new inspection got GPS from a different location" conflict Craig
    // reported. Always start a new inspection with a clean GPS-lock state.
    pendingGps.current = null;
    pendingPinLink.current = null;
    setLockedGps(null);
    setLockedPinLink(null);
    setLockedPhotoCount(0);
    setGpsPhotoMsg('');
    setPendingGpsConfirm(null);
    setView('form');
  };

  const openEdit = (insp: Inspection) => {
    setEditingInsp(insp);
    setForm({
      title: insp.title, type: insp.type, date: insp.date,
      location: insp.location, latitude: insp.latitude, longitude: insp.longitude,
      description: insp.description, photos: [...insp.photos], comments: [...insp.comments],
      condition: insp.condition, status: insp.status,
      assignedClientId: insp.assignedClientId, createdBy: insp.createdBy,
    });
    // Show GPS fields if this inspection already has coordinates saved
    setShowGpsFields(!!(insp.latitude && insp.longitude));
    // Same GPS-lock reset as openNew() — switching to edit a different
    // inspection must not carry over a GPS lock left engaged elsewhere.
    pendingGps.current = null;
    pendingPinLink.current = null;
    setLockedGps(null);
    setLockedPinLink(null);
    setLockedPhotoCount(0);
    setGpsPhotoMsg('');
    setPendingGpsConfirm(null);
    // Restore pin links from saved inspection
    const savedPins = insp.mapPins || [];
    if (savedPins.length > 0) {
      setPinLinks(savedPins.map(mp => ({ id: uid(), mapId: mp.mapId, pinId: mp.pinId, snapshot: mp.snapshot || '', loading: false })));
    } else if (insp.mapId) {
      // backward compat — single map/pin
      setPinLinks([{ id: uid(), mapId: insp.mapId, pinId: insp.mapPinId || '', snapshot: insp.mapSnapshot || '', loading: false }]);
    } else {
      setPinLinks([]);
    }
    setSaveMsg('');
    setView('form');
  };

  // ── SAVE ─────────────────────────────────────────────────────────────────

  const handleSave = (overrideStatus?: Inspection['status']) => {
    if (!form.title.trim()) {
      setSaveMsg('⚠️ Title is required');
      setTimeout(() => setSaveMsg(''), 3000);
      return;
    }
    const finalStatus = overrideStatus || form.status;
    const mapPinsData = pinLinks
      .filter(p => p.mapId)
      .map(p => ({ mapId: p.mapId, pinId: p.pinId, snapshot: p.snapshot }));

    const savePayload = {
      ...form,
      status: finalStatus,
      mapId: mapPinsData[0]?.mapId || '',
      mapPinId: mapPinsData[0]?.pinId || '',
      mapSnapshot: mapPinsData[0]?.snapshot || '',
      mapPins: mapPinsData,
    };

    if (editingInsp) {
      updateInspection({ ...editingInsp, ...savePayload });
      // Update form status so dropdown shows the new value (important for Save & Complete)
      if (overrideStatus && overrideStatus !== form.status) {
        setForm(prev => ({ ...prev, status: overrideStatus }));
      }
      setSaveMsg('✅ Inspection saved');
      setTimeout(() => setSaveMsg(''), 3000);
    } else {
      // Stay on the form in edit mode so user can keep adding details
      const created = addInspection(savePayload);
      setEditingInsp(created);
      setSaveMsg('✅ Inspection created — keep editing or go back when done');
      setTimeout(() => setSaveMsg(''), 4000);
    }
    // Do NOT navigate away — user stays on the form
  };

  // ── PHOTOS ───────────────────────────────────────────────────────────────

  // v73.135 — Craig: app/tab restarting while taking GPS photos, confirmed
  // happening in Firefox mobile too, not just the Android wrapper — this is
  // a genuine OS-level behavior (Android can kill a backgrounded tab/process
  // to reclaim memory while the camera app has focus), not something any
  // amount of native Android lifecycle code can fully prevent (see v73.131 —
  // that fix helps the Android-Activity-recreation case, but a real process
  // kill wipes the JS heap regardless of platform). The only real protection
  // is to make sure a photo is durably saved to the actual data store the
  // INSTANT it's taken — this used to only update this component's local
  // `form` state, leaving every photo taken since the last explicit "Save"
  // click sitting in memory only, and gone completely if the tab/process
  // died before that click. Persists each photo to the inspection record
  // immediately (auto-creating the inspection with a placeholder title if
  // this is a brand-new one never saved even once) so nothing is ever more
  // than one photo away from being safely in IndexedDB.
  const autoSavePhoto = (insp: Inspection, formSnapshot: FormData) => {
    const mapPinsData = pinLinks
      .filter(p => p.mapId)
      .map(p => ({ mapId: p.mapId, pinId: p.pinId, snapshot: p.snapshot }));
    updateInspection({
      ...insp,
      ...formSnapshot,
      mapId: mapPinsData[0]?.mapId || '',
      mapPinId: mapPinsData[0]?.pinId || '',
      mapSnapshot: mapPinsData[0]?.snapshot || '',
      mapPins: mapPinsData,
    });
  };

  const handlePhoto = (e: React.ChangeEvent<HTMLInputElement>, isGps = false) => {
    const files = e.target.files;
    if (!files) return;

    // Ensure a real, savable inspection record exists BEFORE any of the
    // actual photo files are read — synchronously, so if multiple photos
    // are picked at once (the multi-select "Add Photos" button) they all
    // share the one record instead of racing to create duplicates.
    let targetInsp = editingInsp;
    if (!targetInsp) {
      const mapPinsData = pinLinks
        .filter(p => p.mapId)
        .map(p => ({ mapId: p.mapId, pinId: p.pinId, snapshot: p.snapshot }));
      const safeTitle = form.title.trim() || `Inspection - ${new Date().toLocaleString('en-NZ')}`;
      const created = addInspection({
        ...form,
        title: safeTitle,
        mapId: mapPinsData[0]?.mapId || '',
        mapPinId: mapPinsData[0]?.pinId || '',
        mapSnapshot: mapPinsData[0]?.snapshot || '',
        mapPins: mapPinsData,
      });
      targetInsp = created;
      setEditingInsp(created);
      if (!form.title.trim()) setForm(prev => ({ ...prev, title: safeTitle }));
    }

    const capturedGps   = isGps ? pendingGps.current : null;
    const capturedPin   = isGps ? pendingPinLink.current : null;
    const capturedComment = photoComment;
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const raw = ev.target?.result as string;
        // v73.139 — Craig: still crashing (Save button, Release button — not
        // just camera-open) even after v73.138's flush-throttling fix. That
        // fix removed a REDUNDANT extra flush, but every genuinely-necessary
        // save still does a full JSON.stringify of the ENTIRE app dataset —
        // and this call was overriding compressImage's own deliberately
        // conservative defaults (1200px/0.65 quality — see its file header
        // comment: "without compression, localStorage fills after 1-2
        // photos") with a LARGER, higher-quality setting (1600px/0.75) that
        // produces meaningfully bigger base64 strings. On a long field
        // session with many photos across many inspections, that extra size
        // compounds every single save. Reduced below the utility's own
        // defaults given how directly this is implicated in real crashes —
        // 1280px is still perfectly legible for spotting a defect in a
        // photo, on a phone screen or in a PDF report.
        const compressed = await compressImage(raw, 1280, 0.6);
        const photo: Photo = {
          id: uid(), data: compressed, comment: capturedComment, takenAt: now(),
          lat: capturedGps?.lat, lng: capturedGps?.lng,
          mapId: capturedPin?.mapId || undefined,
          pinId: capturedPin?.pinId || undefined,
        };
        setForm(prev => {
          // Auto-fill form lat/lng from GPS photo if not already set
          const nextLat = (!prev.latitude && capturedGps) ? String(capturedGps.lat.toFixed(6)) : prev.latitude;
          const nextLng = (!prev.longitude && capturedGps) ? String(capturedGps.lng.toFixed(6)) : prev.longitude;
          const nextFormState = { ...prev, photos: [...prev.photos, photo], latitude: nextLat, longitude: nextLng };
          autoSavePhoto(targetInsp!, nextFormState); // persist THIS photo right now — don't wait for Save
          return nextFormState;
        });
      };
      reader.readAsDataURL(file);
    });
    setPhotoComment('');
    // GPS Location Lock: after first GPS photo, lock the location for up to GPS_PHOTO_LIMIT photos
    // Only set count to 1 for the VERY FIRST photo (prev === 0).
    // Subsequent photos use takeAnotherAtLockedLocation() which pre-increments before opening camera.
    if (isGps && pendingGps.current) {
      setLockedGps(pendingGps.current);
      setLockedPinLink(pendingPinLink.current);
      setLockedPhotoCount(prev => prev === 0 ? 1 : prev);
      setGpsPhotoMsg(`📍 Location locked — take up to ${GPS_PHOTO_LIMIT} photos here`);
      setTimeout(() => setGpsPhotoMsg(''), 4000);
    }
    pendingGps.current = null;
    pendingPinLink.current = null;
    e.target.value = '';
  };

  // Take another photo at the locked GPS location (no re-query needed)
  const takeAnotherAtLockedLocation = () => {
    if (!lockedGps) return;
    pendingGps.current = lockedGps;
    pendingPinLink.current = lockedPinLink;
    setLockedPhotoCount(c => c + 1);
    setGpsPhotoMsg(`📍 GPS locked: ${lockedGps.lat.toFixed(5)}, ${lockedGps.lng.toFixed(5)} — opening camera…`);
    setTimeout(() => setGpsPhotoMsg(''), 5000);
    setTimeout(() => gpsFileRef.current?.click(), 300);
  };

  // Release the GPS location lock
  const releaseGpsLock = () => {
    setLockedGps(null);
    setLockedPinLink(null);
    setLockedPhotoCount(0);
    setGpsPhotoMsg('');
  };

  // Take a photo tagged with current GPS + auto-link to a pin
  // v73.140 — Craig: first GPS reading of a new inspection is spot-on, but
  // subsequent readings (starting a new location/block later in the same
  // session) can be 200m-1km off, sometimes "three roads off." Within one
  // locked block, every photo already reuses the exact same locked
  // coordinate (see takeAnotherAtLockedLocation above — no fresh GPS query
  // happens per-photo there), so this isn't about avoiding repeat queries;
  // it's about the ACCURACY of each fresh query when a genuinely new
  // location is being locked. `getCurrentPosition()` can return the
  // device's first available fix immediately — often a coarse network/
  // cell-tower estimate (typically 100m-1km+ accuracy) returned before the
  // GPS chip has actually acquired a satellite lock, especially if it's
  // gone idle between captures to save battery. The first reading of a
  // session can happen to get lucky with an already-warm GPS chip; later
  // ones, taken after GPS had a chance to go idle again, are more likely to
  // hit this coarse-fix case. `watchPosition` (unlike a single
  // `getCurrentPosition` call) keeps delivering fixes as the chip refines
  // its lock over time, so waiting for accuracy to drop below a reasonable
  // threshold before accepting a reading gets a genuinely GPS-derived
  // position instead of settling for whatever showed up first.
  const getAccurateGpsPosition = (
    onProgress: (accuracyM: number) => void,
    accuracyThresholdM = 20,
    maxWaitMs = 15000
  ): Promise<GeolocationPosition> => {
    return new Promise((resolve, reject) => {
      let best: GeolocationPosition | null = null;
      let watchId = -1;
      const finish = (pos: GeolocationPosition | null) => {
        if (watchId !== -1) navigator.geolocation.clearWatch(watchId);
        if (pos) resolve(pos); else reject(new Error('GPS timed out without an accurate fix'));
      };
      const timer = setTimeout(() => finish(best), maxWaitMs);
      watchId = navigator.geolocation.watchPosition(
        pos => {
          if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
          onProgress(pos.coords.accuracy);
          if (pos.coords.accuracy <= accuracyThresholdM) {
            clearTimeout(timer);
            finish(pos);
          }
        },
        err => {
          // Permission denial won't resolve itself by waiting — fail fast.
          // Anything else (timeout, temporarily unavailable) is transient;
          // keep waiting for a better fix until our own maxWaitMs cutoff.
          if (err.code === err.PERMISSION_DENIED) {
            clearTimeout(timer);
            finish(null);
          }
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: maxWaitMs }
      );
    });
  };

  const captureGpsPhoto = async () => {
    if (!navigator.geolocation) {
      setGpsPhotoMsg('⚠️ GPS not available in this browser');
      setTimeout(() => setGpsPhotoMsg(''), 4000);
      return;
    }
    setGpsPhotoMsg('📍 Getting accurate GPS location…');
    try {
      const pos = await getAccurateGpsPosition(accuracyM => {
        setGpsPhotoMsg(`📍 Improving GPS accuracy… (currently ~${Math.round(accuracyM)}m)`);
      });
      const { latitude: lat, longitude: lng } = pos.coords;
      // BUG FIX: previously locked in and opened the camera immediately with
      // no review step — a stale/inaccurate fix (or a fix for a different
      // spot than intended) got locked and reused for up to 5 photos with no
      // way to catch it beforehand. Now requires Confirm before locking.
      setGpsPhotoMsg('');
      // v73.136 — Craig: "GPS not releasing for the next set of photos."
      // Rough same-spot check (flat-earth approximation — plenty accurate at
      // this scale) against whatever was previously locked: if the new fix
      // is suspiciously close (~3m) to the OLD locked location, flag it in
      // the confirm dialog so Craig can actually see a likely-stale/cached
      // GPS fix and choose to retry, instead of it silently reusing the
      // previous spot's coordinates.
      const metersFromLastLock = lockedGps
        ? Math.sqrt(
            Math.pow((lat - lockedGps.lat) * 111320, 2) +
            Math.pow((lng - lockedGps.lng) * 111320 * Math.cos(lat * Math.PI / 180), 2)
          )
        : null;
      const suspiciouslyClose = metersFromLastLock !== null && metersFromLastLock < 3;
      setPendingGpsConfirm({
        lat, lng,
        label: suspiciouslyClose
          ? `⚠️ This reading is only ~${metersFromLastLock!.toFixed(1)}m from the last locked location — GPS may not have updated yet. Lock anyway, or Cancel and try again in a few seconds?`
          : 'Lock this GPS location and take a photo here?',
        onConfirm: () => {
          // Reset any existing lock now that the fresh capture is confirmed
          setLockedGps(null);
          setLockedPinLink(null);
          setLockedPhotoCount(0);
          pendingGps.current = { lat, lng };
          // Auto-link to the first pinLink that has a mapId selected
          const firstPin = pinLinks.find(p => p.mapId);
          if (firstPin) {
            pendingPinLink.current = { mapId: firstPin.mapId, pinId: firstPin.pinId };
          }
          setGpsPhotoMsg(`📍 GPS: ${lat.toFixed(5)}, ${lng.toFixed(5)} — opening camera…`);
          setTimeout(() => setGpsPhotoMsg(''), 5000);
          setPendingGpsConfirm(null);
          // Small delay so user sees the GPS coords before camera opens
          setTimeout(() => gpsFileRef.current?.click(), 300);
        },
        onCancel: () => { setPendingGpsConfirm(null); setGpsPhotoMsg(''); },
      });
    } catch (err: unknown) {
      const msg = err instanceof GeolocationPositionError
        ? (err.code === 1 ? 'Location permission denied — allow location access and try again'
          : err.code === 2 ? 'Location unavailable — check GPS/location services are on'
          : 'GPS timed out — try again')
        : 'Couldn\'t get an accurate GPS fix in time — try moving to open sky and try again';
      setGpsPhotoMsg(`❌ ${msg}`);
      setTimeout(() => setGpsPhotoMsg(''), 5000);
    }
  };

  // Add an extra photo at the same GPS location as an existing photo card
  const addPhotoAtLocation = (lat: number, lng: number) => {
    pendingGps.current = { lat, lng };
    setTimeout(() => extraPhotoRef.current?.click(), 100);
  };

  // Link/unlink a photo to a map pin
  const linkPhotoToPin = (photoId: string, mapId: string, pinId: string) => {
    setForm(prev => ({
      ...prev,
      photos: prev.photos.map(p => p.id === photoId ? { ...p, mapId: mapId || undefined, pinId: pinId || undefined } : p),
    }));
  };

  const removePhoto = (id: string) => setForm(prev => ({ ...prev, photos: prev.photos.filter(p => p.id !== id) }));
  const updatePhotoComment = (id: string, comment: string) => setForm(prev => ({
    ...prev, photos: prev.photos.map(p => p.id === id ? { ...p, comment } : p)
  }));
  const updatePhotoGps = (id: string, lat: number, lng: number) => setForm(prev => ({
    ...prev, photos: prev.photos.map(p => p.id === id ? { ...p, lat, lng } : p)
  }));

  // ── COMMENTS ─────────────────────────────────────────────────────────────

  const addComment = () => {
    if (!commentText.trim()) return;
    const c: InspComment = { id: uid(), text: commentText, category: commentCat || 'General Note', createdAt: now(), createdBy: currentUser?.name || '' };
    setForm(prev => ({ ...prev, comments: [...prev.comments, c] }));
    setCommentText('');
    setCommentCat('');
  };

  const removeComment = (id: string) => setForm(prev => ({ ...prev, comments: prev.comments.filter(c => c.id !== id) }));

  const getGPS = () => {
    if (!navigator.geolocation) {
      setSaveMsg('⚠️ Geolocation is not supported by this browser.');
      setTimeout(() => setSaveMsg(''), 4000);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude: lat, longitude: lng } = pos.coords;
        // BUG FIX: previously applied instantly with no review step, so a
        // stale/wrong GPS fix (weak signal, cached fix, or a fix that raced
        // in after switching to a different inspection) silently overwrote
        // the location field. Now shows a Confirm/Cancel step first.
        setPendingGpsConfirm({
          lat, lng,
          label: 'Use this GPS location for the inspection?',
          onConfirm: () => {
            setForm(prev => ({ ...prev, latitude: lat.toFixed(6), longitude: lng.toFixed(6) }));
            setPendingGpsConfirm(null);
          },
          onCancel: () => setPendingGpsConfirm(null),
        });
      },
      () => {
        setSaveMsg('⚠️ Unable to get GPS location. Please check browser permissions.');
        setTimeout(() => setSaveMsg(''), 4000);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 } // v73.136 — see captureGpsPhoto's comment on maximumAge: 0
    );
  };

  // ── FILTERS ──────────────────────────────────────────────────────────────

  const filtered = data.inspections.filter(i => {
    // If navigated from map pin history — show only that inspection
    if (filterInspectionId) return i.id === filterInspectionId;
    if (search && !i.title.toLowerCase().includes(search.toLowerCase()) && !i.location.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterType && i.type !== filterType) return false;
    // statusTab drives primary filter; filterStatus dropdown is secondary (hidden when tab active)
    if (statusTab !== 'all' && i.status !== statusTab) return false;
    if (statusTab === 'all' && filterStatus && i.status !== filterStatus) return false;
    if (filterCondition && i.condition !== filterCondition) return false;
    return true;
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const condColor = (c: string) => {
    const m: Record<string, string> = { Excellent: 'bg-emerald-100 text-emerald-700', Good: 'bg-green-100 text-green-700', Fair: 'bg-amber-100 text-amber-700', Poor: 'bg-orange-100 text-orange-700', Critical: 'bg-red-100 text-red-700' };
    return m[c] || 'bg-gray-100 text-gray-700';
  };
  const statusColor = (s: string) => {
    const m: Record<string, string> = { draft: 'bg-gray-100 text-gray-700', in_progress: 'bg-blue-100 text-blue-700', completed: 'bg-emerald-100 text-emerald-700', reviewed: 'bg-purple-100 text-purple-700' };
    return m[s] || 'bg-gray-100 text-gray-700';
  };

  // ════════════════════════════════════════════════════════════════════════
  // DETAIL VIEW
  // ════════════════════════════════════════════════════════════════════════
  // ── Shared lightbox — rendered via React Portal directly into document.body ──
  // Portal bypasses all parent stacking contexts so position:fixed works
  // correctly on mobile Safari/Chrome regardless of parent overflow or transforms.
  const renderLightbox = () => {
    if (!showPhotoModal) return null;

    const content = (
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.93)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          WebkitOverflowScrolling: 'touch',
        }}
        onClick={() => setShowPhotoModal(null)}
      >
        {/* ── Close ── */}
        <button
          style={{
            position: 'fixed', top: 12, right: 16, zIndex: 10000,
            background: 'none', border: 'none', color: '#fff',
            fontSize: 44, lineHeight: 1, cursor: 'pointer',
            padding: '8px 12px', touchAction: 'manipulation',
          }}
          onClick={() => setShowPhotoModal(null)}
          aria-label="Close"
        >×</button>

        {/* ── Counter ── */}
        {lbPhotos.length > 1 && (
          <span style={{
            position: 'fixed', top: 20, left: 16, zIndex: 10000,
            color: '#94a3b8', fontSize: 13, pointerEvents: 'none',
          }}>
            {lbIdx + 1} / {lbPhotos.length}
          </span>
        )}

        {/* ── Prev ── */}
        {lbPhotos.length > 1 && (
          <button
            style={{
              position: 'fixed', left: 0, top: '50%', transform: 'translateY(-50%)',
              zIndex: 10000, background: 'rgba(0,0,0,0.4)', border: 'none',
              color: '#fff', fontSize: 48, lineHeight: 1, cursor: 'pointer',
              padding: '24px 18px', touchAction: 'manipulation',
              borderRadius: '0 8px 8px 0',
            }}
            onClick={e => { e.stopPropagation(); lbPrev(); }}
            aria-label="Previous photo"
          >‹</button>
        )}

        {/* ── Next ── */}
        {lbPhotos.length > 1 && (
          <button
            style={{
              position: 'fixed', right: 0, top: '50%', transform: 'translateY(-50%)',
              zIndex: 10000, background: 'rgba(0,0,0,0.4)', border: 'none',
              color: '#fff', fontSize: 48, lineHeight: 1, cursor: 'pointer',
              padding: '24px 18px', touchAction: 'manipulation',
              borderRadius: '8px 0 0 8px',
            }}
            onClick={e => { e.stopPropagation(); lbNext(); }}
            aria-label="Next photo"
          >›</button>
        )}

        {/* ── Scrollable content panel ── */}
        <div
          style={{
            position: 'relative', width: '100%', maxWidth: 720,
            maxHeight: '100dvh', overflowY: 'auto',
            padding: '56px 16px 24px',
            boxSizing: 'border-box',
          }}
          onClick={e => e.stopPropagation()}
        >
          {/* Photo */}
          <img
            src={showPhotoModal.data}
            alt=""
            style={{
              width: '100%', borderRadius: 12,
              objectFit: 'contain', maxHeight: '60dvh',
              display: 'block', boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
            }}
          />

          {/* Info */}
          <div style={{marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 16}}>
            {showPhotoModal.comment && (
              <p style={{
                fontSize: 14, color: '#e2e8f0', background: 'rgba(255,255,255,0.08)',
                padding: '10px 16px', borderRadius: 12, margin: 0,
              }}>💬 {showPhotoModal.comment}</p>
            )}

            {showPhotoModal.lat && showPhotoModal.lng && (
              <div style={{borderRadius: 12, overflow: 'hidden', border: '1px solid #065f46'}}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '8px 12px', background: 'rgba(6,78,59,0.6)',
                  borderBottom: '1px solid #065f46',
                }}>
                  <span style={{fontSize: 13, color: '#6ee7b7', fontWeight: 600}}>
                    📍 {showPhotoModal.lat.toFixed(6)}, {showPhotoModal.lng.toFixed(6)}
                  </span>
                  <a
                    href={`https://www.google.com/maps?q=${showPhotoModal.lat},${showPhotoModal.lng}`}
                    target="_blank" rel="noopener noreferrer"
                    style={{fontSize: 12, color: '#34d399', textDecoration: 'underline'}}
                    onClick={e => e.stopPropagation()}
                  >Google Maps ↗</a>
                </div>
                <PhotoGpsMap lat={showPhotoModal.lat} lng={showPhotoModal.lng} />
              </div>
            )}

            {showPhotoModal.mapId && (() => {
              const m = data.maps.find(m => m.id === showPhotoModal.mapId);
              const pin = m?.pins.find(p => p.id === showPhotoModal.pinId);
              if (!m) return null;
              return (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 13, color: '#a5b4fc',
                  background: 'rgba(67,56,202,0.25)', border: '1px solid #4338ca',
                  padding: '8px 12px', borderRadius: 12,
                }}>
                  {pin && <span style={{width: 12, height: 12, borderRadius: '50%', flexShrink: 0, background: pin.color, display: 'inline-block'}}/>}
                  📌 {pin ? pin.label : 'Pin'} on {m.name}
                </div>
              );
            })()}

            <p style={{fontSize: 12, color: '#64748b', textAlign: 'center', margin: 0}}>
              {new Date(showPhotoModal.takenAt).toLocaleString()}
            </p>

            <button
              onClick={() => setShowPhotoModal(null)}
              style={{
                width: '100%', padding: '12px', borderRadius: 12,
                background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)',
                color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer',
                touchAction: 'manipulation',
              }}
            >Close</button>
          </div>
        </div>
      </div>
    );

    return createPortal(content, document.body);
  };

  if (view === 'detail' && detailInsp) {
    const client = data.clients.find(c => c.id === detailInsp.assignedClientId);
    const savedPins = detailInsp.mapPins || [];
    const displayPins = savedPins.length > 0 ? savedPins : detailInsp.mapId ? [{ mapId: detailInsp.mapId, pinId: detailInsp.mapPinId, snapshot: detailInsp.mapSnapshot }] : [];

    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4 flex-wrap">
          <button onClick={() => { setView('list'); onClearFilter?.(); }} className="btn-secondary">← Back</button>
          <h1 className="text-2xl font-bold text-gray-900">{detailInsp.title}</h1>
          <span className={`badge ${statusColor(detailInsp.status)}`}>{detailInsp.status.replace('_', ' ')}</span>
          {detailInsp.condition && <span className={`badge ${condColor(detailInsp.condition)}`}>{detailInsp.condition}</span>}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <div className="card">
              <h2 className="font-semibold text-gray-900 mb-3">Details</h2>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div><span className="text-gray-500">Type:</span> <span className="font-medium ml-1">{detailInsp.type || 'N/A'}</span></div>
                <div><span className="text-gray-500">Date:</span> <span className="font-medium ml-1">{detailInsp.date}</span></div>
                <div><span className="text-gray-500">Location:</span> <span className="font-medium ml-1">{detailInsp.location || 'N/A'}</span></div>
                <div><span className="text-gray-500">GPS:</span> <span className="font-medium ml-1">{detailInsp.latitude && detailInsp.longitude ? `${detailInsp.latitude}, ${detailInsp.longitude}` : 'N/A'}</span></div>
                <div><span className="text-gray-500">Inspector:</span> <span className="font-medium ml-1">{detailInsp.createdBy}</span></div>
                {client && <div><span className="text-gray-500">Client:</span> <span className="font-medium ml-1">{client.name}</span></div>}
              </div>
              {detailInsp.description && <p className="text-sm text-gray-700 mt-4 p-3 bg-gray-50 rounded-lg">{detailInsp.description}</p>}
            </div>

            {/* Linked Map Pins */}
            {displayPins.length > 0 && (
              <div className="card">
                <h2 className="font-semibold text-gray-900 mb-3">🗺️ Linked Map & Pin Locations ({displayPins.length})</h2>
                <div className="space-y-4">
                  {displayPins.map((mp, idx) => {
                    const linkedMap = data.maps.find(m => m.id === mp.mapId);
                    const linkedPin = linkedMap?.pins.find(p => p.id === mp.pinId);
                    if (!linkedMap) return null;
                    return (
                      <div key={idx} className="p-4 bg-gradient-to-r from-indigo-50 to-blue-50 rounded-xl border border-indigo-100">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="w-5 h-5 rounded-full bg-indigo-600 text-white text-xs flex items-center justify-center font-bold">{idx + 1}</span>
                          <span className="font-semibold text-gray-900">{linkedMap.name}</span>
                          {linkedPin && (
                            <span className="flex items-center gap-1 text-sm text-gray-600">
                              → <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: linkedPin.color }}></span>
                              📌 {linkedPin.label}
                            </span>
                          )}
                        </div>
                        {mp.snapshot && (
                          <img src={mp.snapshot} alt={`Map ${idx + 1} snapshot`}
                            className="w-full rounded-lg border border-gray-200 shadow-sm mt-2"
                            style={{ maxHeight: 300, objectFit: 'contain', backgroundColor: '#f3f4f6' }} />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {detailInsp.photos.length > 0 && (
              <div className="card">
                <h2 className="font-semibold text-gray-900 mb-3">📷 Photos ({detailInsp.photos.length})</h2>
                {/* Photos grouped by pin link */}
                {(() => {
                  const pinned = detailInsp.photos.filter(p => p.mapId && p.pinId);
                  const unpinned = detailInsp.photos.filter(p => !p.mapId || !p.pinId);
                  const pinGroups: Record<string, {photos: Photo[]; mapName: string; pinLabel: string; pinColor: string}> = {};
                  pinned.forEach(p => {
                    const key = `${p.mapId}|${p.pinId}`;
                    if (!pinGroups[key]) {
                      const m = data.maps.find(m => m.id === p.mapId);
                      const pin = m?.pins.find(pp => pp.id === p.pinId);
                      pinGroups[key] = { photos: [], mapName: m?.name || 'Unknown map', pinLabel: pin?.label || 'Pin', pinColor: pin?.color || '#6366f1' };
                    }
                    pinGroups[key].photos.push(p);
                  });
                  return (
                    <>
                      {Object.entries(pinGroups).map(([key, group]) => (
                        <div key={key} className="mb-4">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="w-3 h-3 rounded-full shrink-0" style={{backgroundColor: group.pinColor}}/>
                            <span className="text-sm font-semibold text-indigo-800">📌 {group.pinLabel} — {group.mapName}</span>
                          </div>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                            {group.photos.map(p => (
                              <div key={p.id} className="cursor-pointer" onClick={() => openLightbox(group.photos, group.photos.indexOf(p))}>
                                <img src={p.data} alt="" className="w-full h-32 object-cover rounded-lg border-2 border-indigo-200 hover:opacity-90 transition" />
                                {p.comment && <p className="text-xs text-gray-500 mt-1 truncate">{p.comment}</p>}
                                {p.lat && p.lng && (
                                  <p className="text-xs text-emerald-600 mt-0.5">📍 {p.lat.toFixed(4)}, {p.lng.toFixed(4)}</p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                      {unpinned.length > 0 && (
                        <div>
                          {Object.keys(pinGroups).length > 0 && <p className="text-xs text-gray-500 mb-2 font-medium">Other photos (no pin link)</p>}
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                            {unpinned.map(p => (
                              <div key={p.id} className="cursor-pointer" onClick={() => openLightbox(unpinned, unpinned.indexOf(p))}>
                                <img src={p.data} alt="" className="w-full h-32 object-cover rounded-lg hover:opacity-90 transition" />
                                {p.comment && <p className="text-xs text-gray-500 mt-1 truncate">{p.comment}</p>}
                                {p.lat && p.lng && (
                                  <p className="text-xs text-emerald-600 mt-0.5">📍 {p.lat.toFixed(4)}, {p.lng.toFixed(4)}</p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
            {detailInsp.comments.length > 0 && (
              <div className="card">
                <h2 className="font-semibold text-gray-900 mb-3">Comments ({detailInsp.comments.length})</h2>
                <div className="space-y-3">
                  {detailInsp.comments.map(c => (
                    <div key={c.id} className="p-3 bg-gray-50 rounded-lg">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="badge bg-gray-200 text-gray-700">{c.category}</span>
                        <span className="text-xs text-gray-400">{new Date(c.createdAt).toLocaleString()}</span>
                        <span className="text-xs text-gray-400">by {c.createdBy}</span>
                      </div>
                      <p className="text-sm text-gray-700">{c.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="space-y-4">
            <button onClick={() => openEdit(detailInsp)} className="btn-primary w-full">✏️ Edit Inspection</button>
            <button onClick={() => { if (confirm('Delete?')) { deleteInspection(detailInsp.id); setView('list'); } }} className="btn-danger w-full">🗑️ Delete</button>
          </div>
        </div>
        {renderLightbox()}
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // FORM VIEW
  // ════════════════════════════════════════════════════════════════════════
  if (view === 'form') {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <button onClick={() => setView('list')} className="btn-secondary">← Back to List</button>
          <h1 className="text-2xl font-bold text-gray-900">{editingInsp ? 'Edit Inspection' : 'New Inspection'}</h1>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">

            {/* ── Basic Info ─────────────────────────────────────────────── */}
            <div className="card">
              <h2 className="font-semibold text-gray-900 mb-4">Basic Information</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
                  <input className="input-field" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Main Street Drain Inspection" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                    <select className="input-field" value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
                      <option value="">Select type...</option>
                      {inspTypes.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
                    <input className="input-field" type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Location</label>
                  <input className="input-field" value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} placeholder="Street address or location description" />
                </div>
                {/* ── GPS Location — optional, collapsed by default ── */}
                {!showGpsFields ? (
                  <button
                    type="button"
                    onClick={() => { setShowGpsFields(true); getGPS(); }}
                    className="flex items-center gap-2 w-full px-4 py-2.5 border border-dashed border-gray-300 hover:border-emerald-400 hover:bg-emerald-50 text-gray-500 hover:text-emerald-700 rounded-xl text-sm transition"
                  >
                    <span className="text-base">📍</span>
                    <span>Add GPS Location <span className="text-gray-400 text-xs font-normal">(optional)</span></span>
                  </button>
                ) : (
                  <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-emerald-800">📍 GPS Location</span>
                      <button
                        type="button"
                        onClick={() => { setShowGpsFields(false); setForm(prev => ({ ...prev, latitude: '', longitude: '' })); }}
                        className="text-xs text-gray-400 hover:text-red-500 transition px-2 py-0.5 rounded hover:bg-red-50"
                      >✕ Remove</button>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Latitude</label>
                        <input className="input-field text-sm" value={form.latitude} onChange={e => setForm({ ...form, latitude: e.target.value })} placeholder="e.g. -36.8485" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Longitude</label>
                        <input className="input-field text-sm" value={form.longitude} onChange={e => setForm({ ...form, longitude: e.target.value })} placeholder="e.g. 174.7633" />
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={getGPS}
                      className="btn-secondary text-xs w-full"
                    >📍 Get Current GPS Location</button>
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <textarea className="input-field" rows={3} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Detailed description of the inspection area" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Condition</label>
                    <select className="input-field" value={form.condition} onChange={e => setForm({ ...form, condition: e.target.value })}>
                      <option value="">Select condition...</option>
                      {conditions.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                    <select className="input-field" value={form.status} onChange={e => setForm({ ...form, status: e.target.value as Inspection['status'] })}>
                      <option value="draft">Draft</option>
                      <option value="in_progress">In Progress</option>
                      <option value="completed">Completed</option>
                      <option value="reviewed">Reviewed</option>
                    </select>
                  </div>
                </div>

                {/* ── Comments (between Condition/Status and Client) ───── */}
                <div className="p-4 bg-gradient-to-r from-amber-50 to-yellow-50 rounded-xl border border-amber-100 space-y-3">
                  <label className="block text-sm font-semibold text-gray-800">💬 Comments & Observations</label>
                  <div className="flex flex-col gap-2">
                    <select className="input-field w-full" value={commentCat} onChange={e => setCommentCat(e.target.value)}>
                      <option value="">Category...</option>
                      {commentCats.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                    </select>
                    <textarea
                      className="input-field w-full min-h-[80px] resize-y"
                      value={commentText}
                      onChange={e => setCommentText(e.target.value)}
                      placeholder="Add a comment..."
                      rows={3}
                    />
                    <button onClick={addComment} className="btn-primary w-full py-2">Add</button>
                  </div>
                  {form.comments.length > 0 && (
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {form.comments.map(c => (
                        <div key={c.id} className="flex items-start justify-between p-2 bg-white rounded-lg border border-amber-100">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                              <span className="badge bg-amber-100 text-amber-700 text-xs">{c.category}</span>
                              <span className="text-xs text-gray-400">by {c.createdBy}</span>
                            </div>
                            <p className="text-sm text-gray-700">{c.text}</p>
                          </div>
                          <button onClick={() => removeComment(c.id)} className="text-red-400 hover:text-red-600 ml-2 shrink-0 text-lg leading-none">×</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* ── Assign to Client ─────────────────────────────────── */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Assign to Client</label>
                  <select className="input-field" value={form.assignedClientId} onChange={e => setForm({ ...form, assignedClientId: e.target.value })}>
                    <option value="">No client assigned</option>
                    {data.clients.map(c => <option key={c.id} value={c.id}>{c.name}{c.company ? ` (${c.company})` : ''}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* ── Link to Map & Pin Locations ────────────────────────────── */}
            <div className="card">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="font-semibold text-gray-900">🗺️ Link to Map &amp; Pin Locations</h2>
                  <p className="text-xs text-gray-500 mt-0.5">Add one or more map pin locations for this inspection</p>
                </div>
                {pinLinks.length > 0 && (
                  <span className="badge bg-indigo-100 text-indigo-700">{pinLinks.length} pin{pinLinks.length !== 1 ? 's' : ''} linked</span>
                )}
              </div>

              {/* Pin link cards */}
              <div className="space-y-4">
                {pinLinks.map((link, idx) => {
                  const thisMap = data.maps.find(m => m.id === link.mapId);
                  const thisPin = thisMap?.pins.find(p => p.id === link.pinId);
                  return (
                    <div key={link.id} className="border-2 border-indigo-200 rounded-xl p-4 bg-indigo-50 relative">
                      {/* Header */}
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <span className="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs flex items-center justify-center font-bold">{idx + 1}</span>
                          <span className="text-sm font-semibold text-indigo-800">📌 Pin Location {idx + 1}</span>
                        </div>
                        <button
                          onClick={() => removePinLink(link.id)}
                          className="flex items-center gap-1 px-3 py-1 bg-red-100 hover:bg-red-200 text-red-600 rounded-lg text-xs font-medium transition"
                        >
                          🗑️ Remove
                        </button>
                      </div>

                      {/* Map dropdown */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Select Map</label>
                          <select
                            className="input-field"
                            value={link.mapId}
                            onChange={e => updatePinLinkMap(link.id, e.target.value)}
                          >
                            <option value="">— Choose a map —</option>
                            {data.maps.map(m => (
                              <option key={m.id} value={m.id}>
                                {m.type === 'online' ? '🌐' : m.type === 'company' ? '🏢' : '📤'} {m.name} ({m.pins.length} pin{m.pins.length !== 1 ? 's' : ''})
                              </option>
                            ))}
                          </select>
                          {data.maps.length === 0 && (
                            <p className="text-xs text-gray-400 mt-1">No maps yet — create one in the Maps section.</p>
                          )}
                        </div>

                        {/* Pin dropdown — only when map selected */}
                        {link.mapId && (
                          <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">Select Pin</label>
                            <select
                              className="input-field"
                              value={link.pinId}
                              onChange={e => updatePinLinkPin(link.id, e.target.value, link.mapId)}
                            >
                              <option value="">— Choose a pin —</option>
                              {(thisMap?.pins || []).map(pin => (
                                <option key={pin.id} value={pin.id}>
                                  📌 {pin.label}{pin.description ? ` — ${pin.description}` : ''}
                                </option>
                              ))}
                            </select>
                            {thisMap && thisMap.pins.length === 0 && (
                              <p className="text-xs text-amber-600 mt-1">⚠️ No pins on this map yet. Add pins in the Maps section.</p>
                            )}
                          </div>
                        )}
                      </div>

                      {/* GPS Add Pin button — shown when a map is selected */}
                      {link.mapId && (
                        <div className="mb-3">
                          {/* GPS pin detail form — shown when user clicks the GPS button */}
                        {gpsPinInput && gpsPinInput.linkId === link.id ? (
                          <div className="p-3 bg-emerald-50 border-2 border-emerald-300 rounded-xl space-y-2">
                            <p className="text-xs font-bold text-emerald-800">📍 New GPS Pin Details</p>
                            <input
                              className="input-field text-sm"
                              placeholder="Pin label (e.g. Blocked drain, Crack, Water point)"
                              value={gpsPinInput.label}
                              onChange={e => setGpsPinInput(prev => prev ? {...prev, label: e.target.value} : prev)}
                            />
                            <input
                              className="input-field text-sm"
                              placeholder="Description / notes (optional)"
                              value={gpsPinInput.description}
                              onChange={e => setGpsPinInput(prev => prev ? {...prev, description: e.target.value} : prev)}
                            />
                            <div className="flex gap-2">
                              <button
                                onClick={() => { setGpsPinInput(null); }}
                                className="flex-1 px-3 py-2 bg-white border border-gray-300 text-gray-600 rounded-lg text-xs font-medium"
                              >Cancel</button>
                              <button
                                onClick={() => addGpsPinToMap(link.id, gpsPinInput.label, gpsPinInput.description)}
                                disabled={!!gpsLoading[link.id]}
                                className="flex-1 px-3 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-xs font-bold disabled:opacity-60"
                              >
                                {gpsLoading[link.id] ? '⏳ Getting GPS…' : '📍 Create Pin at My Location'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={() => setGpsPinInput({linkId: link.id, label: `GPS Pin ${(data.maps.find(m=>m.id===link.mapId)?.pins.length||0)+1}`, description: '', notes: ''})}
                            disabled={!!gpsLoading[link.id]}
                            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 hover:border-emerald-400 text-emerald-700 rounded-xl transition text-sm font-medium disabled:opacity-60"
                          >
                            {gpsLoading[link.id] ? (
                              <><span className="animate-spin">⏳</span> Getting GPS location...</>
                            ) : (
                              <><span>📍</span> Add New Pin at Current GPS Location</>
                            )}
                          </button>
                        )}
                          <p className="text-xs text-gray-400 mt-1 text-center">
                            Creates a new pin on the selected map at your current location
                          </p>
                        </div>
                      )}

                      {/* Pin info strip */}
                      {thisMap && thisPin && (
                        <div className="flex items-center gap-2 p-2 bg-white rounded-lg border border-indigo-200 mb-3">
                          <span className="w-4 h-4 rounded-full shrink-0" style={{ backgroundColor: thisPin.color }}></span>
                          <span className="text-sm font-medium text-gray-900">{thisPin.label}</span>
                          <span className="text-xs text-gray-400">on {thisMap.name}</span>
                          {thisPin.description && <span className="text-xs text-gray-500 truncate">— {thisPin.description}</span>}
                        </div>
                      )}

                      {/* Photos linked to this pin */}
                      {(() => {
                        const linked = form.photos.filter(p => p.mapId === link.mapId && p.pinId === link.pinId && link.pinId);
                        if (linked.length === 0) return null;
                        return (
                          <div className="mb-3">
                            <p className="text-xs font-semibold text-indigo-700 mb-2">📷 {linked.length} photo{linked.length!==1?'s':''} linked to this pin:</p>
                            <div className="flex gap-2 flex-wrap">
                              {linked.map(lp => (
                                <div key={lp.id} className="relative cursor-pointer" onClick={() => setShowPhotoModal(lp)}>
                                  <img src={lp.data} alt="" className="w-16 h-16 object-cover rounded-lg border-2 border-indigo-200" />
                                  {lp.lat && <span className="absolute bottom-0.5 left-0.5 text-xs bg-emerald-500 text-white rounded px-1">📍</span>}
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })()}

                      {/* Snapshot */}
                      {link.mapId && (
                        <div className="mt-2">
                          {link.loading ? (
                            <div className="w-full h-36 bg-white rounded-xl border border-indigo-200 flex items-center justify-center">
                              <div className="text-center">
                                <div className="text-2xl mb-1 animate-spin">⏳</div>
                                <p className="text-xs text-gray-500">Generating snapshot...</p>
                              </div>
                            </div>
                          ) : link.snapshot ? (
                            <div className="relative group">
                              <img
                                src={link.snapshot}
                                alt={`Map snapshot ${idx + 1}`}
                                className="w-full rounded-xl border border-indigo-200 shadow-sm"
                                style={{ maxHeight: 280, objectFit: 'contain', backgroundColor: '#f8fafc' }}
                              />
                              <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition">
                                <button
                                  onClick={() => refreshSnapshot(link.id)}
                                  className="bg-white/90 hover:bg-white text-gray-700 text-xs font-medium px-2 py-1 rounded-lg shadow border border-gray-200"
                                >
                                  🔄 Refresh
                                </button>
                              </div>
                              <p className="text-xs text-gray-400 mt-1 text-center">
                                📸 {thisMap?.name}{thisPin ? ` → 📌 ${thisPin.label}` : ''}
                              </p>
                            </div>
                          ) : (
                            <div className="w-full h-24 bg-white rounded-xl border border-dashed border-indigo-200 flex items-center justify-center">
                              <p className="text-xs text-gray-400">
                                {link.pinId ? 'Snapshot will appear after saving' : 'Select a pin to generate snapshot'}
                              </p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* ── ADD PIN BUTTON ── always visible ────────────────────── */}
              <button
                onClick={addPinLink}
                className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-indigo-300 hover:border-indigo-500 hover:bg-indigo-50 text-indigo-600 hover:text-indigo-700 rounded-xl transition font-medium text-sm"
              >
                <span className="text-xl leading-none">＋</span>
                Add {pinLinks.length > 0 ? 'Another' : 'a'} Pin Location
              </button>

              {data.maps.length === 0 && (
                <p className="text-xs text-center text-gray-400 mt-2">
                  No maps available yet — go to the <strong>Maps</strong> section to create one first.
                </p>
              )}
            </div>

            {/* ── Photos ───────────────────────────────────────────────── */}
            <div className="card">
              <h2 className="font-semibold text-gray-900 mb-4">📷 Photos</h2>
              <div className="space-y-4">

                {/* Capture options */}
                <div className="p-4 border-2 border-dashed border-gray-300 rounded-xl space-y-3">
                  <p className="text-sm text-gray-500">Optional: add a comment before taking photos</p>
                  <input className="input-field" value={photoComment} onChange={e => setPhotoComment(e.target.value)} placeholder="e.g. Drain damaged by truck impact" />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button onClick={() => fileRef.current?.click()} className="btn-primary flex items-center justify-center gap-2">
                      📷 Take / Select Photo
                    </button>
                    <button onClick={captureGpsPhoto}
                      className="flex items-center justify-center gap-2 px-4 py-2 bg-emerald-50 hover:bg-emerald-100 border-2 border-emerald-300 hover:border-emerald-400 text-emerald-700 rounded-xl font-medium text-sm transition">
                      📍 Take Photo at GPS Location
                    </button>
                  </div>

                  {/* GPS Location Lock panel — shown after first GPS photo */}
                  {lockedGps && (
                    <div className="p-3 bg-emerald-50 border-2 border-emerald-400 rounded-xl space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-xs font-bold text-emerald-800">📍 Location Locked</p>
                          <p className="text-xs text-emerald-600 font-mono mt-0.5">
                            {lockedGps.lat.toFixed(5)}, {lockedGps.lng.toFixed(5)}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-semibold border border-emerald-300">
                            {lockedPhotoCount}/{GPS_PHOTO_LIMIT} photos
                          </span>
                        </div>
                      </div>
                      {lockedPhotoCount < GPS_PHOTO_LIMIT ? (
                        <div className="flex gap-2">
                          <button
                            onClick={takeAnotherAtLockedLocation}
                            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold text-xs transition">
                            📷 Take Another at This Location
                            <span className="bg-emerald-500 px-1.5 py-0.5 rounded-full text-xs">
                              {GPS_PHOTO_LIMIT - lockedPhotoCount} left
                            </span>
                          </button>
                          <button
                            onClick={releaseGpsLock}
                            className="px-3 py-2 bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50 rounded-lg text-xs font-medium transition">
                            🔓 Release
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between">
                          <p className="text-xs text-emerald-700 font-medium">✅ Maximum {GPS_PHOTO_LIMIT} photos reached for this location</p>
                          <button onClick={releaseGpsLock} className="text-xs px-3 py-1.5 bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50 rounded-lg font-medium transition">
                            🔓 New Location
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {gpsPhotoMsg && (
                    <div className={`text-xs p-2.5 rounded-lg font-medium ${gpsPhotoMsg.startsWith('❌') ? 'bg-red-50 text-red-700 border border-red-200' : gpsPhotoMsg.startsWith('📍 GPS:') || gpsPhotoMsg.startsWith('📍 Location') ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-blue-50 text-blue-700 border border-blue-200'}`}>
                      {gpsPhotoMsg}
                    </div>
                  )}
                  <input ref={fileRef}       type="file" accept="image/*" multiple capture="environment" onChange={e => handlePhoto(e, false)} className="hidden" />
                  <input ref={gpsFileRef}    type="file" accept="image/*"          capture="environment" onChange={e => handlePhoto(e, true)}  className="hidden" />
                  <input ref={extraPhotoRef} type="file" accept="image/*"          capture="environment" onChange={e => handlePhoto(e, true)}  className="hidden" />
                  <p className="text-xs text-gray-400 text-center">
                    📍 GPS button locks your location — take up to {GPS_PHOTO_LIMIT} before/after photos at the same spot
                  </p>
                </div>

                {/* v73.125 — Craig: mobile field pain point. With 20+ locations per
                    inspection, the only Save/Cancel buttons were in the Status card
                    at the very bottom of the page — below every photo taken so far.
                    Workflow was: take GPS photo (top) → scroll all the way down to
                    Save → scroll all the way back up to take the next GPS photo →
                    repeat, for every single location. This mirrors Save/Save & Complete/
                    Cancel right next to the GPS capture controls so both live in the
                    same screen area on a phone — no scrolling between them at all.
                    Mobile only (sm:hidden) — desktop is unchanged; the Status card
                    at the bottom still has the only save controls there. */}
                <div className="sm:hidden p-3 bg-gray-50 border-2 border-gray-200 rounded-xl space-y-2">
                  {saveMsg && <div className="p-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">{saveMsg}</div>}
                  <div className="grid grid-cols-2 gap-2">
                    <button onClick={() => handleSave()} className="btn-primary text-sm py-2">💾 Save</button>
                    <button onClick={() => handleSave('completed')} className="btn-success text-sm py-2">✅ Complete</button>
                  </div>
                  <button onClick={() => setView('list')} className="btn-secondary w-full text-sm py-2">Cancel</button>
                </div>

                {/* Photo grid — grouped by GPS location */}
                {form.photos.length > 0 && (() => {
                  // v73.137 — Craig: "photos taken near each other needs to be separate at
                  // all times... they are documenting different things." Any distance-based
                  // rounding (v73.136 tightened it to ~1.1m, but that's still a rounding
                  // tolerance) is the wrong approach entirely for this workflow — two photos a
                  // couple of metres apart can easily be documenting two completely different
                  // things and must never be auto-merged into one location card, full stop.
                  // Switched to EXACT coordinate match: photos only group together when they
                  // share the literal, bit-identical lat/lng — which happens ONLY when they
                  // come from the same deliberate GPS-lock session ("Take Another at This
                  // Location" reuses the exact same locked coordinate for every photo in that
                  // session). Two independent GPS reads, even standing in the same spot,
                  // essentially never produce identical floating-point values — so this
                  // guarantees separate captures are always separate groups, no tolerance,
                  // no exceptions, while still correctly grouping a single intentional
                  // multi-photo GPS lock together.
                  type LocGroup = {
                    key: string;
                    lat?: number; lng?: number;
                    photos: typeof form.photos;
                  };
                  const groups: LocGroup[] = [];
                  const keyOf = (p: typeof form.photos[0]) =>
                    p.lat != null && p.lng != null
                      ? `${p.lat},${p.lng}` // exact match — no rounding, ever
                      : `ungps-${p.id}`;

                  form.photos.forEach(p => {
                    const k = keyOf(p);
                    const existing = groups.find(g => g.key === k);
                    if (existing) {
                      existing.photos.push(p);
                    } else {
                      groups.push({ key: k, lat: p.lat, lng: p.lng, photos: [p] });
                    }
                  });

                  return (
                    // v73.125 — groups are always built oldest-first (new locations
                    // append to `groups`, matching form.photos' insertion order).
                    // `flex-col-reverse` visually flips that to newest-location-first
                    // on mobile ONLY (older locations pushed down, out of the way,
                    // exactly as asked), without touching the underlying data or
                    // DOM/key order — `sm:flex-col` puts desktop back to normal
                    // oldest-first. `gap-4` (not `space-y-4`) so spacing is correct
                    // in both visual directions.
                    <div className="flex flex-col-reverse gap-4 sm:flex-col">
                      {groups.map(group => {
                        const hasGps = group.lat != null && group.lng != null;
                        return (
                          <div key={group.key} className="border border-gray-200 rounded-xl overflow-hidden bg-white shadow-sm">

                            {/* Group header — GPS badge or plain label */}
                            <div className={`flex items-center justify-between px-3 py-2 ${hasGps ? 'bg-emerald-50 border-b border-emerald-100' : 'bg-gray-50 border-b border-gray-100'}`}>
                              {hasGps ? (
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-xs font-semibold text-emerald-800">📍 GPS Location</span>
                                  <span className="text-xs font-mono text-emerald-700">{group.lat!.toFixed(5)}, {group.lng!.toFixed(5)}</span>
                                  <a href={`https://www.openstreetmap.org/?mlat=${group.lat}&mlon=${group.lng}&zoom=16`}
                                    target="_blank" rel="noopener noreferrer"
                                    className="text-xs text-emerald-600 hover:underline">OSM ↗</a>
                                  <span className="text-xs text-emerald-600 bg-white border border-emerald-200 px-1.5 py-0.5 rounded-full">
                                    {group.photos.length} photo{group.photos.length !== 1 ? 's' : ''}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-xs font-medium text-gray-500">📷 Photo</span>
                              )}
                            </div>

                            {/* Photo thumbnails row */}
                            <div className="flex gap-2 p-3 flex-wrap">
                              {group.photos.map(p => {
                                const linkedMap = p.mapId ? data.maps.find(m => m.id === p.mapId) : null;
                                const linkedPin = linkedMap?.pins.find(pin => pin.id === p.pinId);
                                return (
                                  <div key={p.id} className="relative">
                                    {/* Thumbnail */}
                                    <img src={p.data} alt=""
                                      className="w-24 h-24 object-cover rounded-lg cursor-pointer border-2 border-gray-100 hover:border-indigo-300 transition"
                                      onClick={() => openLightbox(group.photos, group.photos.indexOf(p))} />
                                    {/* Delete button overlaid on thumb */}
                                    <button
                                      onClick={() => removePhoto(p.id)}
                                      className="absolute -top-1.5 -right-1.5 w-6 h-6 bg-red-500 hover:bg-red-600 text-white rounded-full text-xs flex items-center justify-center shadow transition"
                                      title="Delete photo">✕</button>
                                    {/* Pin badge if linked */}
                                    {linkedPin && (
                                      <div className="absolute bottom-1 left-1 right-1 flex items-center gap-0.5">
                                        <span className="w-2 h-2 rounded-full shrink-0" style={{backgroundColor: linkedPin.color}}/>
                                        <span className="text-[10px] text-white bg-black/50 px-1 rounded truncate">{linkedPin.label}</span>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}

                              {/* + Add Photo button — inside the group, same location */}
                              {hasGps && group.photos.length < GPS_PHOTO_LIMIT && (
                                <button
                                  onClick={() => addPhotoAtLocation(group.lat!, group.lng!)}
                                  className="w-24 h-24 border-2 border-dashed border-emerald-300 hover:border-emerald-500 bg-emerald-50 hover:bg-emerald-100 rounded-lg flex flex-col items-center justify-center gap-1 text-emerald-600 hover:text-emerald-800 transition touch-manipulation"
                                  title="Add another photo at this GPS location">
                                  <span className="text-2xl font-bold leading-none">+</span>
                                  <span className="text-xs font-medium text-center leading-tight">Add<br/>Photo</span>
                                </button>
                              )}
                            </div>

                            {/* Comment — shared for the group (use first photo's comment; individual comments shown on lightbox) */}
                            <div className="px-3 pb-2 space-y-2">
                              {group.photos.map(p => (
                                <div key={p.id} className="flex items-center gap-2">
                                  <input className="input-field text-xs flex-1" value={p.comment}
                                    onChange={e => updatePhotoComment(p.id, e.target.value)}
                                    placeholder={group.photos.length > 1 ? `Caption photo ${group.photos.indexOf(p)+1}…` : 'Add comment…'} />
                                  {/* Per-photo pin link */}
                                  <select className="input-field text-xs w-44 py-1 shrink-0"
                                    value={p.mapId ? `${p.mapId}|${p.pinId || ''}` : ''}
                                    onChange={e => { const [mId, pId] = e.target.value.split('|'); linkPhotoToPin(p.id, mId || '', pId || ''); }}>
                                    <option value="">— No pin link —</option>
                                    {pinLinks.filter(pl => pl.mapId).map((pl, i) => {
                                      const plMap = data.maps.find(m => m.id === pl.mapId);
                                      const plPin = plMap?.pins.find(pp => pp.id === pl.pinId);
                                      return (
                                        <option key={pl.id} value={`${pl.mapId}|${pl.pinId}`}>
                                          📌 Pin {i+1}: {plMap?.name || 'map'}{plPin ? ` → ${plPin.label}` : ''}
                                        </option>
                                      );
                                    })}
                                  </select>
                                </div>
                              ))}
                            </div>

                            {/* Inline GPS map — shown once per group */}
                            {hasGps && (
                              <div className="border-t border-emerald-100">
                                <div className="flex items-center justify-between px-3 py-1.5 bg-emerald-50">
                                  <span className="text-xs text-emerald-600 hidden sm:inline">— drag the 📍 pin to correct position</span>
                                  <span className="text-xs text-emerald-700 font-mono">{group.lat!.toFixed(5)}, {group.lng!.toFixed(5)}</span>
                                </div>
                                <PhotoGpsMapEditable
                                  key={`gpsmap-${group.key}`}
                                  lat={group.lat!}
                                  lng={group.lng!}
                                  onPinMoved={(newLat, newLng) => {
                                    // Update all photos in this group to the new location
                                    group.photos.forEach(p => updatePhotoGps(p.id, newLat, newLng));
                                  }}
                                />
                                <p className="text-xs text-emerald-600 text-center py-1.5 bg-emerald-50 border-t border-emerald-100">
                                  📌 OpenStreetMap · Pinch/scroll to zoom · Drag pin to update GPS coordinates
                                </p>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            </div>

          </div>

          {/* ── Sidebar ─────────────────────────────────────────────────── */}
          <div className="space-y-4">
            <div className="card">
              <h3 className="font-semibold text-gray-900 mb-3">Status</h3>
              {/* Status toggle badges */}
              <div className="flex gap-2 flex-wrap mb-4">
                <button
                  onClick={() => setForm(prev => ({ ...prev, status: 'draft' }))}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold border transition-all ${
                    form.status === 'draft'
                      ? 'bg-gray-500 text-white border-gray-500 shadow'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400 hover:text-gray-700'
                  }`}
                >
                  📝 Draft
                </button>
                <button
                  onClick={() => setForm(prev => ({ ...prev, status: 'in_progress' }))}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold border transition-all ${
                    form.status === 'in_progress'
                      ? 'bg-blue-600 text-white border-blue-600 shadow'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-blue-300 hover:text-blue-600'
                  }`}
                >
                  🔄 In Progress
                </button>
                <button
                  onClick={() => setForm(prev => ({ ...prev, status: 'completed' }))}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold border transition-all ${
                    form.status === 'completed'
                      ? 'bg-emerald-600 text-white border-emerald-600 shadow'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-emerald-300 hover:text-emerald-600'
                  }`}
                >
                  ✅ Completed
                </button>
              </div>
              <div className="space-y-2">
                {saveMsg && <div className="p-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">{saveMsg}</div>}
                <button onClick={() => handleSave()} className="btn-primary w-full">💾 Save Changes</button>
                <button onClick={() => handleSave('completed')} className="btn-success w-full">✅ Save & Complete</button>
                <button onClick={() => setView('list')} className="btn-secondary w-full">Cancel</button>
              </div>
            </div>
            <div className="card">
              <h3 className="font-semibold text-gray-900 mb-2">Summary</h3>
              <div className="space-y-2 text-sm text-gray-600">
                <p>📷 {form.photos.length} photo(s)</p>
                <p>💬 {form.comments.length} comment(s)</p>
                <p>📋 Status: {form.status.replace('_', ' ')}</p>
                {form.condition && <p>⭐ Condition: {form.condition}</p>}
                {pinLinks.length > 0 && <p>🗺️ {pinLinks.length} map pin{pinLinks.length !== 1 ? 's' : ''} linked</p>}
              </div>
            </div>
          </div>
        </div>
      {renderLightbox()}
      {pendingGpsConfirm && (
        <div
          className="fixed inset-0 z-[10001] bg-black/50 flex items-center justify-center p-4"
          onClick={() => pendingGpsConfirm.onCancel()}
        >
          <div className="bg-white rounded-2xl p-5 max-w-sm w-full space-y-3 shadow-2xl" onClick={e => e.stopPropagation()}>
            <p className="font-semibold text-gray-900">📍 Confirm GPS Location</p>
            <p className="text-sm text-gray-600">{pendingGpsConfirm.label}</p>
            <p className="text-xs font-mono bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-gray-700">
              {pendingGpsConfirm.lat.toFixed(6)}, {pendingGpsConfirm.lng.toFixed(6)}
            </p>
            {form.latitude && form.longitude && (Math.abs(parseFloat(form.latitude) - pendingGpsConfirm.lat) > 0.001
              || Math.abs(parseFloat(form.longitude) - pendingGpsConfirm.lng) > 0.001) && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                ⚠️ This is different from the location already saved on this inspection ({form.latitude}, {form.longitude}). Make sure this is the correct spot before confirming.
              </p>
            )}
            <div className="flex gap-2 pt-1">
              <button type="button" className="btn-secondary flex-1" onClick={() => pendingGpsConfirm.onCancel()}>Cancel</button>
              <button type="button" className="btn-primary flex-1" onClick={() => pendingGpsConfirm.onConfirm()}>Confirm</button>
            </div>
          </div>
        </div>
      )}
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // LIST VIEW
  // ════════════════════════════════════════════════════════════════════════
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Inspections</h1>
          <p className="text-gray-500 text-sm mt-1">{filtered.length} inspection(s)</p>
        </div>
        <button onClick={openNew} className="btn-primary">+ New Inspection</button>
      </div>

      {/* ── Status filter tabs ── */}
      {(() => {
        const counts = {
          all:         data.inspections.length,
          draft:       data.inspections.filter(i => i.status === 'draft').length,
          in_progress: data.inspections.filter(i => i.status === 'in_progress').length,
          completed:   data.inspections.filter(i => i.status === 'completed').length,
        };
        const tabs: { key: typeof statusTab; label: string; icon: string; active: string; pill: string }[] = [
          { key: 'all',         label: 'All Jobs',    icon: '🔍', active: 'bg-gray-800 text-white shadow',        pill: 'bg-gray-600 text-white' },
          { key: 'draft',       label: 'Draft',       icon: '📝', active: 'bg-gray-500 text-white shadow',        pill: 'bg-gray-400 text-white' },
          { key: 'in_progress', label: 'In Progress', icon: '🔄', active: 'bg-blue-600 text-white shadow',        pill: 'bg-blue-400 text-white' },
          { key: 'completed',   label: 'Completed',   icon: '✅', active: 'bg-emerald-600 text-white shadow',     pill: 'bg-emerald-400 text-white' },
        ];
        return (
          <div className="flex gap-2 flex-wrap">
            {tabs.map(t => (
              <button key={t.key} onClick={() => { setStatusTab(t.key); setFilterStatus(''); }}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
                  statusTab === t.key ? t.active : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}>
                <span>{t.icon}</span>
                <span>{t.label}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold min-w-[20px] text-center ${
                  statusTab === t.key ? t.pill : 'bg-gray-100 text-gray-600'
                }`}>
                  {counts[t.key]}
                </span>
              </button>
            ))}
          </div>
        );
      })()}

      <div className="card">
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <input className="input-field flex-1" value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Search inspections..." />
          <select className="input-field max-w-[180px]" value={filterType} onChange={e => setFilterType(e.target.value)}>
            <option value="">All Types</option>
            {inspTypes.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
          {statusTab === 'all' && (
            <select className="input-field max-w-[150px]" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="">All Status</option>
              <option value="draft">Draft</option>
              <option value="in_progress">In Progress</option>
              <option value="completed">Completed</option>
              <option value="reviewed">Reviewed</option>
            </select>
          )}
          <select className="input-field max-w-[150px]" value={filterCondition} onChange={e => setFilterCondition(e.target.value)}>
            <option value="">All Conditions</option>
            {conditions.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        </div>

        {/* Filter banner — shown when navigated from map pin */}
        {filterInspectionId && (
          <div className="flex items-center gap-3 p-3 bg-indigo-50 border border-indigo-200 rounded-xl mb-2">
            <span className="text-indigo-600 text-sm font-medium">📌 Showing inspection from map pin</span>
            <button
              onClick={() => { onClearFilter?.(); }}
              className="ml-auto text-xs bg-indigo-100 hover:bg-indigo-200 text-indigo-700 px-3 py-1.5 rounded-lg font-medium transition"
            >
              ✕ Show All Inspections
            </button>
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-4xl mb-3">🔍</p>
            <p className="text-gray-500">
              {statusTab !== 'all'
                ? `No ${statusTab === 'in_progress' ? 'in progress' : statusTab} inspections${search ? ' matching your search' : ''}.`
                : 'No inspections found.'}
            </p>
            {statusTab !== 'all' ? (
              <button onClick={() => setStatusTab('all')} className="text-indigo-600 text-sm font-medium mt-2 hover:underline">
                Show all inspections
              </button>
            ) : (
              <button onClick={openNew} className="btn-primary mt-4">Create Your First Inspection</button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map(insp => {
              const client = data.clients.find(c => c.id === insp.assignedClientId);
              const savedPins = insp.mapPins || [];
              const pinCount = savedPins.length || (insp.mapId ? 1 : 0);
              return (
                <div key={insp.id} className="border border-gray-200 rounded-xl p-4 hover:shadow-md transition cursor-pointer"
                  onClick={() => { setDetailInsp(insp); setView('detail'); }}>
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <h3 className="font-semibold text-gray-900 truncate">{insp.title}</h3>
                        <span className={`badge ${statusColor(insp.status)}`}>{insp.status.replace('_', ' ')}</span>
                        {insp.condition && <span className={`badge ${condColor(insp.condition)}`}>{insp.condition}</span>}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 mt-1">
                        <span>📋 {insp.type || 'No type'}</span>
                        <span>📅 {insp.date}</span>
                        {insp.location && <span>📍 {insp.location}</span>}
                        <span>📷 {insp.photos.length}</span>
                        <span>💬 {insp.comments.length}</span>
                        {client && <span>🏢 {client.name}</span>}
                        {pinCount > 0 && <span className="text-indigo-600">🗺️ {pinCount} pin location{pinCount !== 1 ? 's' : ''}</span>}
                      </div>
                    </div>
                    <div className="flex gap-1 ml-2 shrink-0" onClick={e => e.stopPropagation()}>
                      <button onClick={() => openEdit(insp)} className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600">✏️</button>
                      <button onClick={() => { if (confirm('Delete this inspection?')) deleteInspection(insp.id); }} className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-600">🗑️</button>
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
