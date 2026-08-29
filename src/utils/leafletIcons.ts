import L from 'leaflet';

// v72.4 audit fix: this used to live only inside Inspections.tsx, called
// on-mount from that one component. Since Leaflet's `L` module is a shared
// singleton across the whole app bundle, that one call patched icons
// globally — but ONLY once Inspections.tsx had actually mounted at least
// once. A user who opened Maps, Sweeping Maps, Sweep Jobs, or Job Sites
// first (very plausible for a road-sweeping crew who rarely touches the
// Site & Road Inspections section) would see the exact same broken/missing
// marker icon there, because nothing had patched `L.Icon.Default` yet.
// Moving this to a shared module and calling it once at app startup
// (main.tsx) — before any component ever renders a map — means every
// Leaflet map anywhere in the app gets the fix regardless of navigation
// order. Kept safe to call again from anywhere (e.g. still called from
// Inspections.tsx) via the one-time guard below.
let _leafletIconFixed = false;

export function fixLeafletIcons() {
  if (_leafletIconFixed) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (L.Icon.Default.prototype as any)._getIconUrl;
  L.Icon.Default.mergeOptions({
    // Leaflet marker icons — served from /public/leaflet/ (bundled with the app)
    // so they're always available offline. Previously fetched from unpkg.com CDN
    // which breaks offline use and can be blocked by Firefox ETP / firewalls.
    iconRetinaUrl: '/leaflet/marker-icon-2x.png',
    iconUrl:       '/leaflet/marker-icon.png',
    shadowUrl:     '/leaflet/marker-shadow.png',
  });
  _leafletIconFixed = true;
}
