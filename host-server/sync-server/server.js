/**
 * RSW Field App — Sync Server
 * See CLAUDE_CONTEXT.md for full version history and architecture notes.
 * Current schema version: see APP_SCHEMA_VERSION constant below.
 */

// Load .env from current dir (sync-server/) OR parent dir (host-server/)
// This handles both: node server.js directly, AND Docker/systemd via env vars
const path = require('path');
const os   = require('os');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });               // sync-server/.env
dotenv.config({ path: path.join(__dirname, '..', '.env') });         // host-server/.env (docker)
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });   // app root .env (fallback)
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const crypto  = require('crypto');
let multer;
try { multer = require('multer'); } catch { multer = null; }

const app  = express();
const PORT = parseInt(process.env.SYNC_PORT || '8055', 10);

const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, 'sync-data');
const DATA_FILE  = path.join(DATA_DIR, 'rsw-data.json');
const BACKUP_DIR    = path.join(DATA_DIR, 'backups');
const SETTINGS_FILE = path.join(DATA_DIR, 'backup-settings.json');

// Default backup settings — read directly from env so there's no
// dependency on consts declared later in the file.
const DEFAULT_SETTINGS = {
  autoBackup:          true,
  intervalMinutes:     Math.max(5, parseInt(process.env.BACKUP_INTERVAL_MINUTES || '60', 10)),
  maxBackups:          parseInt(process.env.MAX_BACKUPS || '48', 10),
  autoDelete:          false,
  keepLastNAutoDelete: 4,
  logRetentionDays:    4, // v71.8: days of Debug Log files to keep — see LOGS_DIR below
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE))
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch (e) { console.error('[settings] Load error:', e.message); }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
  try {
    const merged = { ...loadSettings(), ...settings };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  } catch (e) { console.error('[settings] Save error:', e.message); return null; }
}
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Road Select data (v73.12+) ────────────────────────────────────────────────
// A self-hosted OSM road-network extract (see extract-roads.sh at the project
// root for how Craig generates this) used by Areas & Roads → Edit Road's
// "Select Roads" mode — lets a route be built by picking existing road
// geometry instead of clicking every point by hand. This is static reference
// data, not part of AppData, so it has no sync/mergeData() implications.
// Read once at startup (and re-read on demand if the file changes, via
// reloadRoadIndex()) and bucketed into a coarse lat/lng grid so a bbox query
// doesn't have to scan the whole file — fine at this data size (one
// council-area extract, not the whole country) without needing a real
// spatial database.
const ROADS_FILE = path.join(DATA_DIR, 'roads.geojson');
const ROAD_GRID_SIZE = 0.01; // ~1km grid cells at NZ latitudes — coarse is fine, we still bbox-filter within cells
let roadIndex = { features: [], grid: new Map(), loadedAt: null, error: null };

function haversineMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// v73.34 — Craig, screenshot with green ticks (selected pieces that genuinely
// touch) vs red X's (the greedy chain jumping straight across blocks/houses
// between two selected pieces that DON'T touch): "is there a way to make
// sure that does the same as the green ticks rather than the red x's."
// Builds a small local graph of the ACTUAL road network around two points
// and finds a real shortest path between them, so the connector follows
// real streets instead of a straight line. Scoped to a local bbox per
// request (not one giant persistent graph over the whole roads.geojson) —
// keeps each request's graph small (a few hundred to a few thousand nodes
// for a realistic gap) regardless of how large the underlying road file is,
// and needs no change to reloadRoadIndex()'s existing grid index.
//
// Node identity: two ways that meet at a real OSM intersection share the
// exact same coordinate at that point (same source node, no rounding drift
// introduced by the extract) — so nodes are keyed by coordinate, rounded to
// 6 decimal places (~11cm at the equator, less at higher latitudes) to
// safely merge floating-point-identical OSM nodes without falsely merging
// distinct nearby points. Edges are undirected (either direction is a valid
// route for the purpose of finding *a* real-road connection, not a
// direction-aware driving route).
function buildLocalRoadGraph(features) {
  const nodes = new Map(); // key -> { lng, lat }
  const adj = new Map();   // key -> [{ to: key, dist: metres }]
  const nodeKey = (lng, lat) => `${lng.toFixed(6)},${lat.toFixed(6)}`;
  features.forEach(f => {
    const coords = f.coords;
    for (let i = 0; i < coords.length - 1; i++) {
      const [lngA, latA] = coords[i], [lngB, latB] = coords[i + 1];
      const kA = nodeKey(lngA, latA), kB = nodeKey(lngB, latB);
      if (!nodes.has(kA)) nodes.set(kA, { lng: lngA, lat: latA });
      if (!nodes.has(kB)) nodes.set(kB, { lng: lngB, lat: latB });
      const dist = haversineMetres(latA, lngA, latB, lngB);
      if (!adj.has(kA)) adj.set(kA, []);
      if (!adj.has(kB)) adj.set(kB, []);
      adj.get(kA).push({ to: kB, dist });
      adj.get(kB).push({ to: kA, dist });
    }
  });
  return { nodes, adj, nodeKey };
}

// Snap an arbitrary point to the nearest graph node within toleranceMetres.
// Returns null if nothing is close enough — the caller should fall back to
// the straight-line connector rather than snap to a wildly wrong node.
function snapToNearestNode(graph, lng, lat, toleranceMetres) {
  let bestKey = null, bestDist = Infinity;
  graph.nodes.forEach((pos, key) => {
    const d = haversineMetres(lat, lng, pos.lat, pos.lng);
    if (d < bestDist) { bestDist = d; bestKey = key; }
  });
  if (bestKey === null || bestDist > toleranceMetres) return null;
  return bestKey;
}

// Simple binary-heap Dijkstra — local per-request graphs are small (a
// realistic gap pulls in a few hundred to a few thousand nodes), but a
// proper heap costs little and avoids any risk of the naive O(V²) approach
// getting slow on a dense city-block bbox.
function dijkstraPath(graph, startKey, endKey, maxNodes = 20000) {
  if (startKey === endKey) return [startKey];
  if (graph.nodes.size > maxNodes) return null; // safety valve — bail rather than hang on a pathological bbox
  const dist = new Map();
  const prev = new Map();
  const visited = new Set();
  // [distance, key] min-heap, array-backed, sift up/down
  const heap = [];
  const push = (d, k) => { heap.push([d, k]); let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0]; const last = heap.pop();
    if (heap.length > 0) { heap[0] = last; let i = 0;
      while (true) { let l = i * 2 + 1, r = i * 2 + 2, s = i;
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
        if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
        if (s === i) break; [heap[s], heap[i]] = [heap[i], heap[s]]; i = s; } }
    return top; };
  dist.set(startKey, 0);
  push(0, startKey);
  while (heap.length > 0) {
    const [d, key] = pop();
    if (visited.has(key)) continue;
    visited.add(key);
    if (key === endKey) break;
    const neighbours = graph.adj.get(key) || [];
    for (const { to, dist: edgeDist } of neighbours) {
      if (visited.has(to)) continue;
      const nd = d + edgeDist;
      if (nd < (dist.get(to) ?? Infinity)) { dist.set(to, nd); prev.set(to, key); push(nd, to); }
    }
  }
  if (!visited.has(endKey)) return null; // no path found within the local graph
  const path = [endKey];
  let cur = endKey;
  while (cur !== startKey) {
    const p = prev.get(cur);
    if (p === undefined) return null; // shouldn't happen if visited.has(endKey), but guard anyway
    path.push(p);
    cur = p;
  }
  path.reverse();
  return path;
}


function roadGridKey(lng, lat) {
  return `${Math.floor(lng / ROAD_GRID_SIZE)}:${Math.floor(lat / ROAD_GRID_SIZE)}`;
}

// v73.15 — Craig: Select Roads / Lasso Select was pulling in footpaths,
// crossings, cycleways, and driveways alongside real roads ("only roads are
// meant to be added"). roads.geojson (extract-roads.sh) is generated with a
// blanket `w/highway` osmium filter, which keeps EVERY OSM way tagged
// highway=* — that includes footway/cycleway/path/pedestrian/steps/track/
// bridleway/corridor and highway=crossing, plus highway=service ways that
// are actually driveways or parking-lot aisles (service=driveway/
// parking_aisle/parking). None of those are roads a sweeper truck drives.
// Filtering is done HERE (at load time), not just in extract-roads.sh,
// because it applies to Craig's already-generated roads.geojson without
// needing a re-extract, and because it's the single choke point every road
// passes through regardless of how the file was produced.
// Whitelist approach (only known drivable road classes), matching Craig's
// ask exactly rather than guessing at every possible thing to exclude.
const ROAD_HIGHWAY_WHITELIST = new Set([
  'motorway', 'motorway_link',
  'trunk', 'trunk_link',
  'primary', 'primary_link',
  'secondary', 'secondary_link',
  'tertiary', 'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service', // filtered further below — excludes driveway/parking_aisle/parking
]);
// v73.53: 'parking_aisle' pulled out of this set into its own category (see
// classifyRoadFeature) — Craig wants it as a separately-toggleable checkbox
// rather than lumped in with driveways/car parks under one "service lanes"
// switch, matching OSM's own service=parking_aisle tag name.
const ROAD_SERVICE_BLACKLIST = new Set(['driveway', 'parking', 'drive-through', 'alley']);
// v73.16 — Craig: Lasso/Select Roads was still pulling in business roads,
// private driveways/access roads, car parks & their access roads, and
// business service lanes. The v73.15 fix only excluded these BY
// service=driveway/parking_aisle/parking/drive-through, but OSM commonly
// tags exactly this class of road as highway=service with an `access=*`
// restriction instead of, or in addition to, a `service=*` subtype — e.g. a
// business's own service lane or a car park's access road is very often
// just highway=service + access=private, with no service=* tag at all,
// which slipped straight through the old check. Added 'alley' to the
// service blacklist (business back-lanes) and a new access-tag check that
// drops any road explicitly marked private/no-access/customers-only,
// regardless of its highway/service tag. `access=destination` is
// deliberately NOT blacklisted — that's used on genuinely public
// through-roads with local traffic restrictions, not private property, and
// excluding it would drop real streets.
const ROAD_ACCESS_BLACKLIST = new Set(['private', 'no', 'customers']);

// v73.20 — Craig: "sometimes we would do carparks or driveways and service
// lanes or business driveway/service lanes" — the v73.15/73.16 exclusions
// were correct as a DEFAULT (these aren't roads a sweeper normally drives),
// but Craig's crews sometimes genuinely do need to sweep exactly this class
// of area. A hard server-side exclusion can't be toggled per-request, so
// this is now a 3-way classification instead of a yes/no filter:
//   'road'    — an ordinary drivable road, always included
//   'service' — a car park, driveway, or business service lane; excluded by
//               default but includable on request via the new
//               ?includeServiceLanes=1 query param on GET /api/roads
//   null      — never included regardless of the toggle (footpath/cycleway/
//               path/pedestrian/steps/track/etc. — nobody sweeps these)
// v73.43 — Craig: "need also a check box like parks/driveway for Lane's so
// they are not included." Unlike car parks/driveways/service lanes, OSM has
// no dedicated tag for "this residential street happens to be named X
// Lane" — it's a genuine, publicly-driveable `highway=residential` (or
// similar) way, just named that way. So this can only be detected from the
// name itself, not a tag. Matches "Lane" as a whole word (case-insensitive)
// anywhere in the name — e.g. "Smith Lane", "Lane End Road" — rather than a
// substring match, so it doesn't misfire on unrelated words that merely
// contain "lane" as a substring (there don't happen to be common ones in
// NZ road naming, but a word-boundary match costs nothing and is the more
// correct rule regardless). Checked only for otherwise-'road' features —
// a car park/driveway already correctly classifies as 'service' first and
// keeps that classification even if it happens to be named e.g. "Church
// Lane Car Park".
const LANE_NAME_RE = /\blane\b/i;
// v73.53 — Craig: "add include check boxes like include carparks/driveways
// and include lanes for the following that openstreet calls them. Service
// road, Parking Aisle, living street." Three more excluded-by-default
// categories, each matching an OSM tag/value directly (unlike 'lane', which
// is name-only):
//   'parkingaisle'  — highway=service, service=parking_aisle (was previously
//                      lumped into the generic 'service' car-park/driveway
//                      bucket; split out to its own checkbox/category)
//   'serviceroad'   — highway=service with no service=* subtype (or one not
//                      otherwise classified above) — a plain OSM "service
//                      road", distinct from a tagged driveway/parking aisle
//   'livingstreet'  — highway=living_street — was previously always
//                      included as an ordinary 'road'; now excluded by
//                      default like the other special classes, includable
//                      via its own toggle
function classifyRoadFeature(props) {
  const highway = String(props?.highway || '').toLowerCase();
  if (!ROAD_HIGHWAY_WHITELIST.has(highway)) return null; // footway/cycleway/path/pedestrian/steps/track/bridleway/corridor/crossing/etc. — never offered
  if (highway === 'service') {
    const service = String(props?.service || '').toLowerCase();
    if (service === 'parking_aisle') return 'parkingaisle';
    if (ROAD_SERVICE_BLACKLIST.has(service)) return 'service'; // driveway/parking-lot/alley/etc.
  }
  const access = String(props?.access || '').toLowerCase();
  if (ROAD_ACCESS_BLACKLIST.has(access)) return 'service'; // private/no-access/customers-only, regardless of highway/service tag
  const name = String(props?.name || props?.['name:en'] || '');
  if (LANE_NAME_RE.test(name)) return 'lane';
  if (highway === 'service') return 'serviceroad'; // plain service road, no recognised subtype and not access-restricted
  if (highway === 'living_street') return 'livingstreet';
  return 'road';
}

function reloadRoadIndex() {
  if (!fs.existsSync(ROADS_FILE)) {
    roadIndex = { features: [], grid: new Map(), loadedAt: null, error: 'not-found' };
    console.log('[roads] No roads.geojson found at', ROADS_FILE, '— Select Roads mode will show no roads until one is added (see extract-roads.sh).');
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(ROADS_FILE, 'utf8'));
    const rawFeatures = Array.isArray(raw.features) ? raw.features : [];
    const features = [];
    const grid = new Map();
    let skipped = 0;
    let skippedNonRoad = 0;
    rawFeatures.forEach((f, i) => {
      const geom = f.geometry;
      if (!geom || geom.type !== 'LineString' || !Array.isArray(geom.coordinates) || geom.coordinates.length < 2) { skipped++; return; }
      const category = classifyRoadFeature(f.properties);
      if (!category) { skippedNonRoad++; return; } // footpath/cycleway/etc. — never kept, toggle or not
      const id = String(f.id ?? f.properties?.['@id'] ?? f.properties?.id ?? `way-${i}`);
      const name = f.properties?.name || f.properties?.['name:en'] || '';
      const coords = geom.coordinates.map(c => [Number(c[0]), Number(c[1])]); // [lng, lat] — kept as GeoJSON order throughout
      let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
      coords.forEach(([lng, lat]) => {
        if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      });
      const feature = { id, name, category, coords, bbox: [minLng, minLat, maxLng, maxLat] };
      features.push(feature);
      // Register this feature in every grid cell its bbox touches, so a
      // bbox query only needs to check cells it actually overlaps.
      const gx0 = Math.floor(minLng / ROAD_GRID_SIZE), gx1 = Math.floor(maxLng / ROAD_GRID_SIZE);
      const gy0 = Math.floor(minLat / ROAD_GRID_SIZE), gy1 = Math.floor(maxLat / ROAD_GRID_SIZE);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const key = `${gx}:${gy}`;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(feature);
        }
      }
    });
    roadIndex = { features, grid, loadedAt: new Date().toISOString(), error: null };
    console.log(`[roads] Loaded ${features.length} road ways from roads.geojson`
      + `${skipped ? ` (skipped ${skipped} non-LineString features)` : ''}`
      + `${skippedNonRoad ? ` (skipped ${skippedNonRoad} non-road ways — footpaths/cycleways/crossings/tracks/etc.; car parks/driveways/service lanes are now kept and tagged 'service', excluded by default but includable via ?includeServiceLanes=1)` : ''}`);
  } catch (e) {
    roadIndex = { features: [], grid: new Map(), loadedAt: null, error: e.message };
    console.error('[roads] Failed to load roads.geojson:', e.message);
  }
}
reloadRoadIndex();

// ── OSM Road Data Auto-Update (Overpass API) — v73.57 ────────────────────────
// Craig: "is there a way to auto update it or have a update maps button in
// the host-server instead of having to go through all the steps for
// updating api/roads." The existing extract-roads.sh process needs a
// separate machine with osmium-tool, a ~250MB+ country .pbf download, and a
// manual scp/docker-cp/reload-curl sequence — real overhead just to refresh
// an already-defined operating area. The Overpass API can serve exactly the
// features inside a bbox directly, in one request, small enough (a few
// hundred KB–low MB for a council-area box) to fetch straight from this
// container with no extra tooling. This is an ADDITIONAL option, not a
// replacement — extract-roads.sh still exists for a first-time/large-area
// extract or if Craig would rather not depend on a public, rate-limited
// Overpass server.
//
// Deliberately reuses classifyRoadFeature()/reloadRoadIndex() completely
// unchanged: the Overpass query itself only filters down to
// ROAD_HIGHWAY_WHITELIST (the same whitelist extract-roads.sh's osmium
// filter uses) to keep the download small, and writes plain GeoJSON
// LineString features with the way's OSM tags as properties — exactly the
// shape extract-roads.sh's osmium export already produces. The fine-grained
// service/access/lane/parking-aisle/living-street categorization stays the
// single choke point it already was, so this can never drift out of sync
// with a manually-generated file.
const OVERPASS_URL  = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const ROADS_BBOX     = process.env.ROADS_BBOX || ''; // "minLng,minLat,maxLng,maxLat" — same format/axis-order as extract-roads.sh's BBOX
const ROADS_UPDATE_META_FILE = path.join(DATA_DIR, 'roads-update-meta.json');
const OVERPASS_HIGHWAY_RE = '^(' + Array.from(ROAD_HIGHWAY_WHITELIST).join('|') + ')$';

let roadsUpdateInProgress = false;

function loadRoadsUpdateMeta() {
  try {
    if (fs.existsSync(ROADS_UPDATE_META_FILE)) return JSON.parse(fs.readFileSync(ROADS_UPDATE_META_FILE, 'utf8'));
  } catch (e) { console.error('[roads] Failed to read update meta:', e.message); }
  return { lastAttempt: null, lastSuccess: null, lastError: null, lastFeatureCount: null, source: null, bbox: null };
}
function saveRoadsUpdateMeta(meta) {
  try { fs.writeFileSync(ROADS_UPDATE_META_FILE, JSON.stringify(meta, null, 2), 'utf8'); }
  catch (e) { console.error('[roads] Failed to save update meta:', e.message); }
}

async function updateRoadsFromOverpass(bboxOverride) {
  const bboxStr = (bboxOverride && bboxOverride.trim()) || ROADS_BBOX;
  if (!bboxStr) throw new Error("ROADS_BBOX not configured — set it in .env (same format as extract-roads.sh's BBOX: minLng,minLat,maxLng,maxLat)");
  const parts = bboxStr.split(',').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) throw new Error('ROADS_BBOX is malformed — expected minLng,minLat,maxLng,maxLat');
  const [minLng, minLat, maxLng, maxLat] = parts;
  // Overpass's own bbox query syntax is south,west,north,east — the
  // opposite axis order from the minLng,minLat,maxLng,maxLat convention
  // used everywhere else in this file (extract-roads.sh/osmium/GeoJSON) —
  // convert right here, the one place that has to remember it.
  const overpassBbox = `${minLat},${minLng},${maxLat},${maxLng}`;
  const query = `[out:json][timeout:90];(way["highway"~"${OVERPASS_HIGHWAY_RE}"](${overpassBbox}););out geom;`;

  // v73.59: switched from fetch() to Node's raw https module. fetch()
  // (undici) kept ETIMEDOUT'ing against the real Overpass server from
  // inside this container even after the v73.58 IPv4-first DNS fix, while
  // plain wget/curl (and now this) succeed every time — undici's own
  // connection/DNS handling behaves differently from a traditional
  // request under musl/Alpine in some Docker networks. Explicit
  // family: 4 belt-and-braces on top of the Dockerfile/compose-level fix.
  const body = 'data=' + encodeURIComponent(query);
  let json;
  try {
    json = await new Promise((resolve, reject) => {
      const url = new URL(OVERPASS_URL);
      const req = httpsMod.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        family: 4,
        timeout: 100000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          // v73.60: Overpass's Apache front-end returns 406 Not Acceptable
          // for requests with no recognizable User-Agent/Accept — wget
          // sends both by default, our raw https.request() sent neither.
          'User-Agent': 'RSW-Field-App-host-server/1.0 (+roads-auto-update)',
          'Accept': '*/*',
        },
      }, (resp) => {
        if (resp.statusCode && resp.statusCode >= 300) {
          let errText = '';
          resp.on('data', (c) => { errText += c; });
          resp.on('end', () => reject(new Error(`Overpass API returned HTTP ${resp.statusCode}${errText ? ': ' + errText.slice(0, 200) : ''}`)));
          return;
        }
        let raw = '';
        resp.setEncoding('utf8');
        resp.on('data', (c) => { raw += c; });
        resp.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error('Overpass response was not valid JSON: ' + e.message)); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('Overpass request timed out (100s)')));
      req.on('error', (e) => reject(new Error(`fetch failed (${e.code || e.message})`)));
      req.write(body);
      req.end();
    });
  } catch (e) {
    throw e;
  }

  const elements = Array.isArray(json.elements) ? json.elements : [];
  const features = [];
  let skipped = 0;
  for (const el of elements) {
    if (el.type !== 'way' || !Array.isArray(el.geometry)) { skipped++; continue; }
    const coords = el.geometry
      .filter(pt => pt && Number.isFinite(pt.lon) && Number.isFinite(pt.lat))
      .map(pt => [pt.lon, pt.lat]);
    if (coords.length < 2) { skipped++; continue; }
    features.push({
      type: 'Feature',
      id: `way/${el.id}`,
      properties: { id: `way/${el.id}`, ...(el.tags || {}) },
      geometry: { type: 'LineString', coordinates: coords },
    });
  }
  if (features.length === 0) {
    throw new Error('Overpass returned zero usable road ways for this bbox — check ROADS_BBOX and the Overpass server; nothing was written, existing roads.geojson untouched');
  }

  // Same safety net the manual process already has: back up the previous
  // file before overwriting, so a bad/partial Overpass response can't
  // strand Craig with no roads at all and no way back short of re-running
  // extract-roads.sh from scratch.
  if (fs.existsSync(ROADS_FILE)) {
    try { fs.copyFileSync(ROADS_FILE, ROADS_FILE + '.bak'); }
    catch (e) { console.error('[roads] Could not back up existing roads.geojson before overwrite:', e.message); }
  }
  const tmpFile = ROADS_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify({ type: 'FeatureCollection', features }), 'utf8');
  fs.renameSync(tmpFile, ROADS_FILE); // atomic swap — no half-written file if reloadRoadIndex() (or a restart) races this

  reloadRoadIndex();

  return { featureCount: features.length, skipped, bbox: bboxStr, source: OVERPASS_URL };
}

function queryRoadsInBbox(minLng, minLat, maxLng, maxLat) {
  const gx0 = Math.floor(minLng / ROAD_GRID_SIZE), gx1 = Math.floor(maxLng / ROAD_GRID_SIZE);
  const gy0 = Math.floor(minLat / ROAD_GRID_SIZE), gy1 = Math.floor(maxLat / ROAD_GRID_SIZE);
  const seen = new Set();
  const results = [];
  for (let gx = gx0; gx <= gx1; gx++) {
    for (let gy = gy0; gy <= gy1; gy++) {
      const cell = roadIndex.grid.get(`${gx}:${gy}`);
      if (!cell) continue;
      for (const f of cell) {
        if (seen.has(f.id)) continue;
        // Actual bbox-overlap test (grid cell membership alone is only an approximation at cell edges)
        const [fMinLng, fMinLat, fMaxLng, fMaxLat] = f.bbox;
        if (fMaxLng < minLng || fMinLng > maxLng || fMaxLat < minLat || fMinLat > maxLat) continue;
        seen.add(f.id);
        results.push(f);
      }
    }
  }
  return results;
}

// v73.81 — Craig: "let's do a full rebuild including road data to fix this
// ongoing issue" (service road / extra road added when the Include checkbox
// is off). Root cause (see classifyRoadFeature comments and v73.80's
// CHANGELOG entry): the Include Service Road/Lanes/Parking Aisle checkboxes
// only ever filtered what /api/roads?bbox= offers as *selectable* — they
// were never sent to OSRM, so /route and /match could freely snap through
// an excluded road class since OSRM has no concept of the app's filters.
// This checks each point OSRM actually returned against the same
// classifyRoadFeature()/roadIndex used for the selectable-roads list, and
// rejects the match if a meaningful fraction of it runs down a road class
// the caller currently has unchecked.
const EXCLUDED_ROAD_MATCH_TOLERANCE_METRES = 15; // how close an OSRM point must be to a road-data way to "count" as running along it
const EXCLUDED_ROAD_REJECT_FRACTION = 0.15; // reject if >=15% of matched points fall on an excluded class the caller didn't ask for
// v73.84 — Craig kept pushing on this after the fraction-only check above
// shipped in v73.81: on a long batch (up to 100 raw points, and OSRM's
// matched geometry is denser still — often hundreds of shape points), a
// genuinely real but SHORT detour through an excluded road (the exact
// pattern in Craig's screenshot — a brief diversion near a roundabout, not
// the whole route) can easily land under 15% of points and slip through
// uncaught. Added an absolute-distance floor alongside the fraction check
// so a short real diversion can't hide behind a long, otherwise-clean
// route diluting the percentage.
const EXCLUDED_ROAD_REJECT_ABSOLUTE_METRES = 20;
// v73.107 — Craig, full OSRM/road-data audit: OSRM's own routable graph
// (built by setup-osrm.sh, from a whole-country extract processed through
// OSRM's stock `car` profile) and roads.geojson (built by extract-roads.sh,
// a hand-picked highway=* whitelist clipped to Craig's operating bbox) are
// two INDEPENDENT extracts of OpenStreetMap — different scripts, run at
// different times against whatever Geofabrik happened to be serving as
// "latest" that day, with no version/date check tying them together. That
// means OSRM's graph can, and does, contain roads that simply don't exist
// in roads.geojson at all (outside Craig's bbox, added/changed since his
// last extract, or a highway/access tag combination osmium's filter
// handles differently than OSRM's car profile does). Every check above this
// point only ever asks "is this point on a road-data way we recognise as an
// EXCLUDED class" — a point that matches NOTHING in roads.geojson was
// treated as clean and waved through untouched (`if (!category) continue`
// in checkRouteAgainstExcludedClasses below), which is exactly backwards
// for an app whose entire premise is a known, fixed set of streets to
// sweep: a road OSRM invented out of a dataset Craig never generated is at
// least as suspicious as one flagged 'service'/'lane'/etc., arguably more
// so, since there's no way to even classify what it actually is. Given a
// separate, more lenient threshold (unmapped connectors — a short driveway
// stub bridging two mapped roads, etc. — are common and fine): a SUSTAINED
// run through unmapped territory now also rejects the batch, same as a
// sustained run through a known-excluded class already did.
const UNMAPPED_ROAD_REJECT_FRACTION = 0.30; // more lenient than the excluded-class fraction — brief unmapped connectors are normal
const UNMAPPED_ROAD_REJECT_ABSOLUTE_METRES = 60; // a short unmapped driveway/carpark stub is fine; a sustained unmapped stretch isn't

// Returns the category ('road'/'lane'/'serviceroad'/'parkingaisle'/'livingstreet'/'service') of
// the nearest road-data way within toleranceMetres of (lng,lat), or null if none is close enough.
// Reuses the same grid (queryRoadsInBbox) the selectable-roads endpoint already relies on, so this
// is always checking against the identical classification a road would have gotten if fetched directly.
function nearestRoadCategoryAt(lng, lat, toleranceMetres) {
  const padDeg = toleranceMetres / 111320;
  const candidates = queryRoadsInBbox(lng - padDeg, lat - padDeg, lng + padDeg, lat + padDeg);
  let best = null, bestDist = toleranceMetres;
  for (const f of candidates) {
    const coords = f.coords;
    for (let i = 0; i < coords.length - 1; i++) {
      const [aLng, aLat] = coords[i], [bLng, bLat] = coords[i + 1];
      const d = distancePointToSegmentMetres(lat, lng, aLat, aLng, bLat, bLng);
      if (d < bestDist) { bestDist = d; best = f.category; }
    }
  }
  return best;
}

// Metric-flat approximation (fine at this tolerance/scale, same assumption pruneCollinear already makes).
function distancePointToSegmentMetres(pLat, pLng, aLat, aLng, bLat, bLng) {
  const latMid = (pLat + aLat + bLat) / 3;
  const mPerDegLat = 111320, mPerDegLng = 111320 * Math.cos((latMid * Math.PI) / 180);
  const px = pLng * mPerDegLng, py = pLat * mPerDegLat;
  const ax = aLng * mPerDegLng, ay = aLat * mPerDegLat;
  const bx = bLng * mPerDegLng, by = bLat * mPerDegLat;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Given a matched/routed point list ([lng,lat] pairs) and which excluded classes the caller
// currently has checked "include" for, returns { rejected, fraction, excludedMetres, excludedPoints } —
// rejected is true when EITHER a big enough share of the points (fraction) OR a real minimum
// distance (excludedMetres) runs along a class the caller did NOT ask to include. The distance
// floor exists specifically so a short, real detour on an otherwise-long/dense route can't hide
// behind a low percentage — see v73.84 note above.
function checkRouteAgainstExcludedClasses(coordsLngLat, includeFlags) {
  const EXCLUDABLE = ['lane', 'serviceroad', 'parkingaisle', 'livingstreet', 'service'];
  const included = new Set(EXCLUDABLE.filter(c => includeFlags[c]));
  let checked = 0, excludedHits = 0, excludedMetres = 0;
  let prevExcluded = null; // [lng, lat] of the previous point if it was on an excluded class, for distance accumulation
  // v73.107 — parallel tracking for "point matches nothing in roads.geojson
  // at all" — see the UNMAPPED_ROAD_* constants' comment above for why this
  // is checked separately from (and in addition to) the excluded-class check.
  let unmappedHits = 0, unmappedMetres = 0, unmappedChecked = 0;
  let prevUnmapped = null;
  for (const [lng, lat] of coordsLngLat) {
    const category = nearestRoadCategoryAt(lng, lat, EXCLUDED_ROAD_MATCH_TOLERANCE_METRES);
    unmappedChecked++;
    if (!category) {
      unmappedHits++;
      if (prevUnmapped) unmappedMetres += haversineMetres(prevUnmapped[1], prevUnmapped[0], lat, lng);
      prevUnmapped = [lng, lat];
      prevExcluded = null;
      continue; // no nearby road-data way at all — not evidence of a known EXCLUDED class, but tracked separately above
    }
    prevUnmapped = null;
    checked++;
    const isExcluded = EXCLUDABLE.includes(category) && !included.has(category);
    if (isExcluded) {
      excludedHits++;
      if (prevExcluded) excludedMetres += haversineMetres(prevExcluded[1], prevExcluded[0], lat, lng);
      prevExcluded = [lng, lat];
    } else {
      prevExcluded = null;
    }
  }
  const fraction = checked > 0 ? excludedHits / checked : 0;
  const excludedRejected = fraction >= EXCLUDED_ROAD_REJECT_FRACTION || excludedMetres >= EXCLUDED_ROAD_REJECT_ABSOLUTE_METRES;
  const unmappedFraction = unmappedChecked > 0 ? unmappedHits / unmappedChecked : 0;
  const unmappedRejected = unmappedFraction >= UNMAPPED_ROAD_REJECT_FRACTION || unmappedMetres >= UNMAPPED_ROAD_REJECT_ABSOLUTE_METRES;
  return {
    rejected: excludedRejected || unmappedRejected,
    fraction, checked, excludedHits, excludedMetres: Math.round(excludedMetres),
    unmappedFraction, unmappedHits, unmappedMetres: Math.round(unmappedMetres), unmappedRejected,
  };
}

// Parses the same include-flag query/body params /api/roads already accepts, so a single flags
// object can be threaded through connect/match without re-deriving the parsing logic twice.
function parseIncludeFlags(source) {
  const truthy = v => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());
  return {
    lane: truthy(source.includeLanes),
    serviceroad: truthy(source.includeServiceRoads),
    parkingaisle: truthy(source.includeParkingAisles),
    livingstreet: truthy(source.includeLivingStreets),
    service: truthy(source.includeServiceLanes),
  };
}

// ── Debug Log — daily-rotated capture of everything the server logs ──────────
// v71.8: per Craig's request for a "Debug menu" showing everything going on
// (what's uploading/not uploading, what's being added/deleted). Rather than
// hand-picking specific events to log (which inevitably misses things — the
// exact lesson from the GET /data/:collection field-stripping saga), this
// wraps console.log/warn/error so EVERY existing log line the server already
// prints (sync results, migrations, backups, deletes, cascade cleanups, etc.)
// is also written to a per-day file. Old days are auto-pruned to a
// configurable retention (default 4 days, same Settings panel pattern as
// backup auto-delete).
const LOGS_DIR = path.join(DATA_DIR, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

const logFilePath = (date) => path.join(LOGS_DIR, `${date}.log`);
// BUG FIX (Craig-reported, v72.7): toISOString().slice(0,10) is always UTC —
// for NZ (UTC+12/+13) this bucketed the server's own debug log under the
// previous day for most of the working day. Alpine's `TZ` env var (already
// set to Pacific/Auckland in docker-compose.yml) only takes effect for named
// zones once `tzdata` is installed in the image (added this release) — with
// that in place, plain local-time getters below correctly return NZ local date.
const pad2 = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

function appendToLogFile(line) {
  try { fs.appendFileSync(logFilePath(todayStr()), line + '\n'); } catch { /* best-effort — never crash on log write */ }
}

function pruneOldLogFiles() {
  try {
    const keep = Math.max(1, loadSettings().logRetentionDays || 4);
    const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.log')).sort().reverse();
    files.slice(keep).forEach(f => { try { fs.unlinkSync(path.join(LOGS_DIR, f)); } catch { /* ignore */ } });
  } catch { /* ignore — logs dir may not exist yet on first run */ }
}

const _origConsole = { log: console.log, warn: console.warn, error: console.error };
function wrapConsole(orig, level) {
  return (...args) => {
    orig.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()).join(' ');
    appendToLogFile(`[${new Date().toISOString()}] [${level}] ${msg}`);
  };
}
console.log   = wrapConsole(_origConsole.log,   'LOG');
console.warn  = wrapConsole(_origConsole.warn,  'WARN');
console.error = wrapConsole(_origConsole.error, 'ERROR');
pruneOldLogFiles();

const AUTH_TOKEN = (process.env.SYNC_TOKEN || 'qg5YAagV88rHWv1eatfzMdmfirX3tcZD').trim();

const BACKUP_INTERVAL_MINUTES = Math.max(5, parseInt(process.env.BACKUP_INTERVAL_MINUTES || '60', 10));
const MAX_BACKUPS              = parseInt(process.env.MAX_BACKUPS || '48', 10);
const TOMBSTONE_DAYS           = parseInt(process.env.TOMBSTONE_DAYS || '90', 10);

// ── Schema version — bump whenever types.ts / store.tsx changes ──────────────
const APP_SCHEMA_VERSION = '73.118';
const PKG_VERSION = (() => { try { return require('./package.json').version; } catch { return APP_SCHEMA_VERSION; } })();
// ── SW Category type metadata — used both server-side (applyMigrations) and  ─
// ── client-side (dashboard HTML). Must be declared here at module scope so    ─
// ── applyMigrations() can reference it before the dashboard template renders. ─
const SW_CAT_META = {
  damage_type:     { icon:'⚠️',  label:'Damage Types' },
  damage_severity: { icon:'🔴',  label:'Damage Severity' },
  debris_type:     { icon:'🌿',  label:'Debris Types' },
  debris_level:    { icon:'📊',  label:'Debris Levels' },
  zone_type:       { icon:'🗺️',  label:'Zone Types' },
  zone_kind:       { icon:'📍',  label:'Zone Type' }, // v73.51 — added, was missing entirely (root cause of "No zone kinds list found")
  frequency:       { icon:'🔁',  label:'Sweep Frequencies' },
  crew_member:     { icon:'👷',  label:'Crew Members / Roles' },
  equipment:       { icon:'🚛',  label:'Equipment & Vehicles' },
  pass_count:      { icon:'🔢',  label:'Pass Counts' },
  site_type:       { icon:'📍',  label:'Site Types' },
  file_attachment: { icon:'📎',  label:'File Attachment Types' },
  weather:         { icon:'🌤️',  label:'Weather Conditions' },
  extra_expense:   { icon:'💵',  label:'Extra Expenses' },
  job_site_map_pin:{ icon:'📌',  label:'Job Sites Map Pins' },
  custom:          { icon:'⚙️',  label:'Custom' },
};
// ── Fixed default ids -> type, mirrored from src/store.tsx's DEFAULT_SWEEP_CATEGORIES
// and DEFAULT_CATEGORIES. v71.0: name-only matching permanently fails once a user
// renames a built-in list (e.g. "Damage Types" -> "Damage and points of interest"),
// because the record's `name` no longer matches any default label — a corrupted
// categoryType could then never be healed again. The 15 built-in (v73.51: zone_kind added) sweepCategories
// lists (and 3 categories lists) always keep their FIXED id even after a rename,
// so matching by id first is fully reliable and rename-proof. See applyMigrations().
const SW_CAT_ID_TO_TYPE = {
  'sc-debris-type':   'debris_type',
  'sc-zone-type':     'zone_type',
  'sc-zone-kind':     'zone_kind', // v73.51
  'sc-damage-type':   'damage_type',
  'sc-damage-sev':    'damage_severity',
  'sc-frequency':     'frequency',
  'sc-crew-member':   'crew_member',
  'sc-equipment':     'equipment',
  'sc-pass-count':    'pass_count',
  'sc-site-type':     'site_type',
  'sc-file-attach':   'file_attachment',
  'sc-weather':       'weather',
  'sc-debris-level':  'debris_level',
  'sc-extra-expense': 'extra_expense',
  'sc-site-map-pin':  'job_site_map_pin',
};
const CAT_ID_TO_TYPE = {
  'cat-insp-type-default': 'inspection_type',
  'cat-condition-default': 'condition',
  'cat-comment-default':   'comment_category',
};

if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR,   { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// Body-size limit reads from SYNC_MAX_BODY_SIZE so the host operator can tune
// it to their machine without touching code.  Defaults to '10gb' — effectively
// unlimited for any realistic field-app dataset.
const SYNC_MAX_BODY_SIZE = process.env.SYNC_MAX_BODY_SIZE || '10gb';
app.use(express.json({ limit: SYNC_MAX_BODY_SIZE })); // FIX: was hardcoded 100mb — large JSON sync payloads caused 413 / JSON.parse errors
app.use(express.urlencoded({ extended: true, limit: SYNC_MAX_BODY_SIZE }));
// ── CORS: must list EVERY header the client sends, including Authorization.
// Firefox enforces preflight (OPTIONS) strictly and will block requests if
// the header isn't in allowedHeaders, even with origin: '*'.
// Chrome silently allows unlisted headers — that's why it worked in Chrome only.
const CORS_OPTIONS = {
  origin: '*',
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',    // used by export/import routes ("Bearer TOKEN")
    'X-Sync-Token',     // used by sync/push/pull routes
    'X-Requested-With',
    'Accept',
  ],
  exposedHeaders: ['Content-Disposition', 'Content-Length'],
  optionsSuccessStatus: 200, // Some legacy browsers choke on 204
};
app.use(cors(CORS_OPTIONS));

// Explicitly handle OPTIONS preflight for ALL routes.
// Firefox sends a preflight before every cross-origin request with custom headers.
// Without this, preflight gets 401 from requireAuth before CORS headers are set.
app.options('*', cors(CORS_OPTIONS));
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Public cert-accept landing page (no auth) ────────────────────────────────
// Navigating to https://HOST:8055/cert triggers the SSL warning first.
// After accepting, this page confirms the cert is trusted and guides
// the user back to the app. Also downloads the PEM/mobileconfig for
// permanent trust (iOS profile, Android cert, desktop trust store).
app.get('/cert', (req, res) => {
  const certDir  = process.env.CERT_DIR || '/certs';
  const certFile = path.join(certDir, 'rsw-sync-cert.pem');
  const certExists = fs.existsSync(certFile);
  const host = (req.headers.host || 'localhost').split(':')[0];
  const dashUrl = `https://${host}:${PORT}/`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RSW Sync Server — Certificate Trust</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:28px 24px;max-width:460px;width:100%}
h1{font-size:1.3rem;font-weight:800;color:#f8fafc;margin-bottom:6px;display:flex;align-items:center;gap:10px}
.sub{font-size:13px;color:#64748b;margin-bottom:24px}
.ok{background:#064e3b;border:1px solid #065f46;border-radius:12px;padding:14px 16px;margin-bottom:20px}
.ok p{color:#6ee7b7;font-weight:600;font-size:14px}
.ok small{color:#34d399;font-size:12px;display:block;margin-top:4px}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:14px;border-radius:10px;font-size:15px;font-weight:700;text-decoration:none;border:none;cursor:pointer;transition:opacity .15s;margin-bottom:10px}
.btn:hover{opacity:.85}
.btn-indigo{background:#6366f1;color:#fff}
.btn-emerald{background:#059669;color:#fff}
.btn-amber{background:#d97706;color:#fff}
.divider{border:none;border-top:1px solid #334155;margin:18px 0}
.steps{font-size:12px;color:#94a3b8;line-height:1.9}
.steps strong{color:#e2e8f0}
.badge{display:inline-block;background:#1e3a5f;color:#93c5fd;border-radius:6px;padding:1px 7px;font-size:11px;font-family:monospace}
</style>
</head>
<body>
<div class="card">
  <h1>🔐 RSW Sync Server</h1>
  <p class="sub">SSL Certificate Trust — ${host}:${PORT}</p>

  ${certExists ? `
  <div class="ok">
    <p>✅ Certificate is trusted by this browser</p>
    <small>You can now use the sync server and access the dashboard.</small>
  </div>

  <a href="${dashUrl}" class="btn btn-indigo">📊 Go to Dashboard →</a>

  <hr class="divider">
  <p style="font-size:12px;color:#64748b;margin-bottom:12px;font-weight:600">Install for permanent trust (no more warnings):</p>

  <a href="/cert/download" class="btn btn-emerald" style="font-size:13px;padding:11px">
    📄 Download .pem Certificate (Android / Desktop)
  </a>
  <a href="/cert.mobileconfig" class="btn btn-amber" style="font-size:13px;padding:11px">
    📱 Download iOS Profile (iPhone / iPad)
  </a>

  <hr class="divider">
  <div class="steps">
    <strong>Chrome / Android:</strong> tap Advanced → Proceed to [IP] (unsafe)<br>
    <strong>Firefox / Android:</strong> tap Advanced → Accept the Risk<br>
    <strong>Safari / iPhone:</strong> tap Show Details → Visit this Website<br>
    <strong>Desktop Chrome:</strong> type <span class="badge">thisisunsafe</span> on the warning page
  </div>
  ` : `
  <div style="background:#450a0a;border:1px solid #7f1d1d;border-radius:12px;padding:14px 16px;margin-bottom:20px">
    <p style="color:#fca5a5;font-weight:600">⚠️ Certificate not found on server</p>
    <small style="color:#f87171;font-size:12px">Server may be running in HTTP-only mode.</small>
  </div>
  `}
</div>
</body>
</html>`);
});

// ── Raw PEM download (separate route) ────────────────────────────────────────
app.get('/cert/download', (_req, res) => {
  const certDir  = process.env.CERT_DIR || '/certs';
  const certFile = path.join(certDir, 'rsw-sync-cert.pem');
  if (!fs.existsSync(certFile))
    return res.status(404).json({ error: 'No certificate found.' });
  res.setHeader('Content-Type', 'application/x-pem-file');
  res.setHeader('Content-Disposition', 'attachment; filename="rsw-sync-cert.pem"');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendFile(path.resolve(certFile));
});

// iOS mobileconfig profile — served over HTTPS too (for when cert already trusted on device)
app.get('/cert.mobileconfig', (_req, res) => {
  const certDir  = process.env.CERT_DIR || '/certs';
  const certFile = path.join(certDir, 'rsw-sync-cert.pem');
  if (!fs.existsSync(certFile)) {
    return res.status(404).json({ error: 'No certificate found.' });
  }
  try {
    const { execSync } = require('child_process');
    const derB64 = execSync(`openssl x509 -in "${certFile}" -outform DER 2>/dev/null | base64`, {stdio:'pipe'}).toString().trim();
    const profileUuid = 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890';
    const certUuid    = 'B2C3D4E5-F6A7-8901-BCDE-F01234567891';
    const mc = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>PayloadContent</key><array><dict>
    <key>PayloadCertificateFileName</key><string>rsw-sync.cer</string>
    <key>PayloadContent</key><data>${derB64}</data>
    <key>PayloadDescription</key><string>RSW Sync Server SSL Certificate</string>
    <key>PayloadDisplayName</key><string>RSW Sync Server Certificate</string>
    <key>PayloadIdentifier</key><string>com.rsw.sync.cert.${certUuid}</string>
    <key>PayloadOrganization</key><string>RSW Field App</string>
    <key>PayloadType</key><string>com.apple.security.root</string>
    <key>PayloadUUID</key><string>${certUuid}</string>
    <key>PayloadVersion</key><integer>1</integer>
  </dict></array>
  <key>PayloadDescription</key><string>Installs the RSW Sync Server SSL certificate.</string>
  <key>PayloadDisplayName</key><string>RSW Field App — Sync Server Certificate</string>
  <key>PayloadIdentifier</key><string>com.rsw.sync.profile.${profileUuid}</string>
  <key>PayloadOrganization</key><string>RSW Field App</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${profileUuid}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict></plist>`;
    res.setHeader('Content-Type', 'application/x-apple-aspen-config');
    res.setHeader('Content-Disposition', 'attachment; filename="rsw-sync.mobileconfig"');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(mc);
  } catch(e) {
    res.status(500).json({ error: 'Could not generate mobileconfig: ' + e.message });
  }
});

function requireAuth(req, res, next) {
  // Accept token from any of:
  //   X-Sync-Token: TOKEN           (used by sync/push/pull routes)
  //   Authorization: Bearer TOKEN   (used by export/import routes)
  //   ?token=TOKEN                  (query string — lets you open auth'd GET routes
  //                                  directly in a browser address bar, e.g. /debug/*,
  //                                  since you can't set custom headers by typing a URL)
  const syncHeader  = (req.headers['x-sync-token'] || '').trim();
  const authHeader  = req.headers['authorization'];
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const queryToken  = typeof req.query.token === 'string' ? req.query.token.trim() : null;
  const token       = syncHeader || bearerToken || queryToken;

  if (!token || token !== AUTH_TOKEN) {
    res.set('Access-Control-Allow-Origin', '*'); // ensure CORS header even on 401
    return res.status(401).json({ error: 'Unauthorised. Check your sync token.' });
  }
  next();
}

// ── Canonical collection list — must match client AppData exactly ─────────────
// Add new collections here the moment they are added to types.ts / store.tsx.
const ALL_COLLECTIONS = [
  // ── Inspection module ──────────────────────────────────────────────────────
  'users',
  'clients',
  'inspections',
  'maps',
  'categories',
  'reports',
  'coverTemplates',
  // ── Road-Sweeping module ───────────────────────────────────────────────────
  'sweepAreas',
  'sweepRoads',
  'sweepZones',
  'sweepJobs',
  'sweepClients',
  'sweepJobSites',
  'sweepFiles',
  'sweepCategories',
  'sweepMaps',
  'sweepReports',
];

// Legacy key aliases — translate old server data transparently on load.
// _legacySweepMaps: shadow key created by a buggy migration (v52.9–v55.4)
// that wrongly archived valid modern SweepMaps; the recovery migration above
// deletes it, but alias it here as a belt-and-suspenders guard so any
// remaining copies on disk don't trigger health/backup drift warnings.
const LEGACY_ALIASES = { sweepSites: 'sweepJobSites', _legacySweepMaps: null };

// ── I/O helpers ───────────────────────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return applyLegacyAliases(raw);
    }
  } catch (e) { console.error('Error loading data:', e.message); }
  return null;
}

// ── Collection-agnostic helper ───────────────────────────────────────────────
// Returns ALL array-collection keys present in a data object — both known
// (ALL_COLLECTIONS) and any extra/future ones the app has sent.
// The server NEVER needs updating when the app adds new collections.
function getAllKeys(data) {
  if (!data || typeof data !== 'object') return [...ALL_COLLECTIONS];
  const extra = Object.keys(data).filter(
    k => Array.isArray(data[k]) && k !== 'deletedIds' && !ALL_COLLECTIONS.includes(k)
  );
  if (extra.length > 0)
    console.log(`[keys] Auto-discovered ${extra.length} extra collection(s): ${extra.join(', ')}`);
  return [...ALL_COLLECTIONS, ...extra];
}

function applyLegacyAliases(data) {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  for (const [oldKey, newKey] of Object.entries(LEGACY_ALIASES)) {
    if (!(oldKey in out)) continue;
    if (newKey && Array.isArray(out[oldKey]) && !Array.isArray(out[newKey])) {
      // Rename: move old key to new key
      console.warn(`[migration] Renamed legacy key "${oldKey}" → "${newKey}"`);
      out[newKey] = out[oldKey];
    } else if (!newKey) {
      // null newKey = drop the key entirely (no rename, just discard)
      console.log(`[migration] Dropped obsolete key "${oldKey}" (${Array.isArray(out[oldKey]) ? out[oldKey].length + ' records' : typeof out[oldKey]})`);
    }
    delete out[oldKey];
  }
  return out;
}

function saveData(data) {
  const tmp = DATA_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function dataHash(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
}

function collectionHash(arr) {
  return crypto.createHash('sha256').update(JSON.stringify(arr || [])).digest('hex').slice(0, 12);
}

function isValidAppData(data) {
  // FIX: Accept any object that has at least one array key — not just known collections.
  // New app features may send new collection names; we must accept and preserve them.
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  return Object.values(data).some(v => Array.isArray(v));
}

function detectDrift(data) {
  if (!data || typeof data !== 'object') return [];
  const known = new Set([...ALL_COLLECTIONS, 'deletedIds', ...Object.keys(LEGACY_ALIASES)]);
  return Object.keys(data).filter(k => !known.has(k) && Array.isArray(data[k]));
}

// ── Schema migration helpers ──────────────────────────────────────────────────
/**
 * Normalise a single SweepRoad record to include all fields introduced in
 * app v25 / v26.  Safe to call on records that already have these fields —
 * existing non-undefined values are left untouched.
 *
 * New fields and their backward-compatible defaults:
 *   segments    — undefined  (single-segment roads use `points` as before)
 *   color       — undefined  (inherit area colour, same as before)
 *   showNumbers — true       (numbers were always shown before)
 *   showMarkers — true       (markers were always shown before)
 */
function normaliseSweepRoad(road) {
  if (!road || typeof road !== 'object') return road;
  const out = { ...road };
  if (!('showNumbers'  in out)) out.showNumbers  = true;
  if (!('showMarkers'  in out)) out.showMarkers  = true;
  // v34: per-road weather, dates, fuelDocketId
  if (!('weather'      in out)) out.weather      = '';
  if (!('startDate'    in out)) out.startDate     = undefined;
  if (!('finishDate'   in out)) out.finishDate    = undefined;
  if (!('fuelDocketId' in out)) out.fuelDocketId  = undefined;
  // v51: ensure segments[].color is present ('' = inherit road/area colour)
  // v52: segments always saved even for single-segment roads; backfill if missing
  // v73.39: ensure segments[].updatedAt is present — backfilled from the
  // road's own updatedAt/createdAt (best available approximation for
  // already-saved data). Without this, two segments that both predate this
  // release compare '' >= '' forever in mergeSubArrayById's recency check,
  // silently defaulting to "whichever side is `client` in this particular
  // merge call wins" rather than anything resembling actual recency — this
  // is exactly the gap found while investigating a reported segment
  // duplication/content-loss issue (ids were already stable since v73.25,
  // this closes the remaining recency-resolution gap).
  if (Array.isArray(out.segments)) {
    out.segments = out.segments.map(seg => {
      if (!seg || typeof seg !== 'object') return seg;
      let s = seg;
      if (!('color' in s)) s = { ...s, color: '' };
      if (!('updatedAt' in s) || !s.updatedAt) s = { ...s, updatedAt: out.updatedAt || out.createdAt || undefined };
      return s;
    });
  }
  return out;
}

/**
 * normaliseSweepJob — schema v5.0
 * Backfills all fields added through v29–v34.
 */
// ── normaliseClient — backfill fields added after initial release ─────────────
function normaliseClient(c) {
  if (!c || typeof c !== 'object') return c;
  return { contractNumber: '', loginEmail: '', loginPassword: '', active: true, ...c };
}

function normaliseSweepJob(job, roadAreaMap) {
  if (!job || typeof job !== 'object') return job;
  const out = { ...job };

  // Basic missing fields
  if (!Array.isArray(out.areaIds))        out.areaIds       = [];
  if (!('siteId'     in out))             out.siteId        = '';
  if (!Array.isArray(out.fileIds))        out.fileIds       = [];
  if (!('equipment'  in out))             out.equipment     = '';
  if (!('startDate'  in out))             out.startDate     = undefined;
  if (!('finishDate' in out))             out.finishDate    = undefined;
  // v32: fuel dockets
  if (!Array.isArray(out.fuelDockets))    out.fuelDockets   = [];
  // v34: extra expenses and tip runs
  if (!Array.isArray(out.extraExpenses))  out.extraExpenses = [];
  if (!Array.isArray(out.tipRuns))        out.tipRuns       = [];

  // Normalise each road entry
  if (Array.isArray(out.roads)) {
    out.roads = out.roads.map(r => ({
      ...r,
      weather:      r.weather      ?? '',
      startDate:    r.startDate    ?? undefined,
      startTime:    r.startTime    ?? undefined,   // v52: per-road start time (HH:MM)
      finishDate:   r.finishDate   ?? undefined,
      finishTime:   r.finishTime   ?? undefined,   // v52: per-road finish time (HH:MM)
      fuelDocketId: r.fuelDocketId ?? undefined,
    }));
  }

  // Derive areaIds from roads (v29 fix — mirrors saveJob client logic)
  if (roadAreaMap) {
    const derived = [...new Set(
      (out.roads || []).map(r => roadAreaMap[r.roadId]).filter(Boolean)
    )];
    derived.forEach(id => { if (!out.areaIds.includes(id)) out.areaIds.push(id); });
  }

  return out;
}

/**
 * normaliseSweepJobSite — schema v6.0
 * Backfills mapPins, mapCenter, areaIds, fileIds fields added in app v36.
 */
function normaliseSweepJobSite(site) {
  if (!site || typeof site !== 'object') return site;
  const out = { ...site };
  // mapPins is the correct field name (client uses mapPins, not sitePins)
  if (!Array.isArray(out.mapPins))   out.mapPins   = [];
  // Legacy: migrate old sitePins field to mapPins
  if (Array.isArray(out.sitePins) && out.sitePins.length > 0 && out.mapPins.length === 0) {
    out.mapPins = out.sitePins;
  }
  delete out.sitePins; // remove stale legacy field
  if (!Array.isArray(out.areaIds))   out.areaIds   = [];
  if (!Array.isArray(out.fileIds))   out.fileIds   = [];
  if (!('address' in out))           out.address   = '';
  if (!('notes' in out))             out.notes     = '';
  if (!('siteType' in out))          out.siteType  = '';
  if (!('clientId' in out))          out.clientId  = '';
  return out;
}

/**
 * normaliseSweepArea — schema v5.0
 */
function normaliseSweepArea(area) {
  if (!area || typeof area !== 'object') return area;
  const out = { ...area };
  if (!('zoneType'       in out)) out.zoneType = '';
  if (!Array.isArray(out.roadIds)) out.roadIds = [];
  return out;
}

/**
 * normaliseInspection — v8.0
 * Backfills photo GPS/pin-link fields (lat, lng, mapId, pinId) introduced in v42.
 */
function normaliseInspection(insp) {
  if (!insp || typeof insp !== 'object') return insp;
  const out = { ...insp };
  if (!Array.isArray(out.photos))   out.photos   = [];
  if (!Array.isArray(out.comments)) out.comments = [];
  // FIX (CRITICAL): client uses 'mapPins' NOT 'pinLinks' — old code was destroying pin data every sync
  if (!Array.isArray(out.mapPins)) {
    out.mapPins = Array.isArray(out.pinLinks) ? out.pinLinks : [];
  }
  delete out.pinLinks; // remove wrong legacy field
  if (!('mapId'       in out)) out.mapId       = '';
  if (!('mapPinId'    in out)) out.mapPinId    = '';
  if (!('mapSnapshot' in out)) out.mapSnapshot  = '';
  if (!('latitude'  in out)) out.latitude  = '';
  if (!('longitude' in out)) out.longitude = '';
  out.photos = out.photos.map(p => {
    if (!p || typeof p !== 'object') return p;
    const np = { ...p };
    if (!('lat'   in np)) np.lat   = undefined;
    if (!('lng'   in np)) np.lng   = undefined;
    if (!('mapId' in np)) np.mapId = undefined;
    if (!('pinId' in np)) np.pinId = undefined;
    return np;
  });
  return out;
}

/**
 * normaliseSweepCategory — v8.0
 * Backfills item.color and item.description; accepts job_site_map_pin type.
 */
/**
 * dedupeItemsByName(items)
 * Collapses items that share the same name (case-insensitive, trimmed) into one —
 * keeping whichever has the most recent updatedAt/createdAt. This is the server-side
 * mirror of the client's duplicate-name guard: it catches duplicates that slip through
 * via direct API writes, sync merges between two devices, or older app versions that
 * didn't have the client-side check.
 */
function dedupeItemsByName(items) {
  if (!Array.isArray(items) || items.length === 0) return { items: items || [], removed: 0 };
  const byKey = new Map(); // normalised name -> kept item
  for (const item of items) {
    if (!item || typeof item !== 'object' || !item.name) continue;
    const key = String(item.name).trim().toLowerCase();
    const ex = byKey.get(key);
    if (!ex) { byKey.set(key, item); continue; }
    const et = ex.updatedAt || ex.createdAt || '';
    const it = item.updatedAt || item.createdAt || '';
    byKey.set(key, it >= et ? item : ex); // keep the more recently touched one
  }
  const deduped = Array.from(byKey.values());
  return { items: deduped, removed: items.length - deduped.length };
}

function normaliseSweepCategory(cat) {
  if (!cat || typeof cat !== 'object') return cat;
  const out = { ...cat };
  if (!Array.isArray(out.items)) out.items = [];
  out.items = out.items.map(item => {
    if (!item || typeof item !== 'object') return item;
    const ni = { ...item };
    if (!('color'       in ni)) ni.color       = '#6b7280';
    if (!('description' in ni)) ni.description = '';
    return ni;
  });
  // Defense-in-depth: collapse any item-name duplicates that slipped through
  const { items: dedupedItems, removed } = dedupeItemsByName(out.items);
  out.items = dedupedItems;
  if (removed > 0) console.log(`[normalise] sweepCategory "${out.name || out.id}": removed ${removed} duplicate-named item(s)`);
  return out;
}

/**
 * normaliseCategory(cat) — equivalent of normaliseSweepCategory for the plain
 * `categories` collection (used by Inspection Categories). Ensures item fields
 * have sane defaults and collapses any duplicate-named items.
 */
function normaliseCategory(cat) {
  if (!cat || typeof cat !== 'object') return cat;
  const out = { ...cat };
  if (!Array.isArray(out.items)) out.items = [];
  out.items = out.items.map(item => {
    if (!item || typeof item !== 'object') return item;
    const ni = { ...item };
    if (!('color'       in ni)) ni.color       = '#4F46E5';
    if (!('description' in ni)) ni.description = '';
    return ni;
  });
  const { items: dedupedItems, removed } = dedupeItemsByName(out.items);
  out.items = dedupedItems;
  if (removed > 0) console.log(`[normalise] category "${out.name || out.id}": removed ${removed} duplicate-named item(s)`);
  return out;
}

/**
 * normaliseSweepJobSitePin — v8.0
 * Ensures map pins have a notes field (v39 pin-comments feature).
 */
function normaliseSweepJobSitePin(pin) {
  if (!pin || typeof pin !== 'object') return pin;
  const out = { ...pin };
  if (!('notes' in out)) out.notes = '';
  return out;
}

/**
 * Apply all pending schema migrations to a full data object.
 * Returns { data, migrated, details } where:
 *   migrated — true if any records were modified
 *   details  — human-readable summary of what changed
 */
function applyMigrations(data) {
  if (!data || typeof data !== 'object') return { data, migrated: false, details: [] };
  const details = []; let migrated = false;

  // Build road→area lookup for job migration
  const roadAreaMap = {};
  if (Array.isArray(data.sweepRoads))
    data.sweepRoads.forEach(r => { if (r.id && r.areaId) roadAreaMap[r.id] = r.areaId; });

  // ── sweepRoads: v25/v26/v51 fields ──────────────────────────────────────────
  if (Array.isArray(data.sweepRoads)) {
    let n = 0;
    data.sweepRoads = data.sweepRoads.map(r => {
      const missingTopLevel = !('showNumbers' in r) || !('showMarkers' in r) ||
        !('weather' in r) || !('startDate' in r) || !('finishDate' in r);
      // v51: detect segments missing the color field
      const missingSegColor = Array.isArray(r.segments) &&
        r.segments.some(s => s && typeof s === 'object' && !('color' in s));
      if (missingTopLevel || missingSegColor) { n++; return normaliseSweepRoad(r); }
      return r;
    });
    if (n > 0) { migrated = true; details.push(`sweepRoads: backfilled missing fields on ${n} record(s)`); }
  }

  // ── sweepJobs: v29–v34 fields ────────────────────────────────────────────────
  if (Array.isArray(data.sweepJobs)) {
    let n = 0;
    data.sweepJobs = data.sweepJobs.map(job => {
      const needs = !Array.isArray(job.areaIds) || !('siteId' in job) ||
        !Array.isArray(job.fileIds) || !('equipment' in job) ||
        !Array.isArray(job.fuelDockets) || !Array.isArray(job.extraExpenses) ||
        !Array.isArray(job.tipRuns) || !('startDate' in job);
      // Also check areaIds completeness
      const derivable = (job.roads || []).map(r => roadAreaMap[r.roadId]).filter(Boolean);
      const incomplete = derivable.some(id => !(job.areaIds || []).includes(id));
      if (needs || incomplete) { n++; return normaliseSweepJob(job, roadAreaMap); }
      return job;
    });
    if (n > 0) { migrated = true; details.push(`sweepJobs: normalised ${n} record(s) — backfilled fuelDockets, extraExpenses, tipRuns, areaIds`); }
  }

  // ── sweepAreas: v15 fields ───────────────────────────────────────────────────
  if (Array.isArray(data.sweepAreas)) {
    let n = 0;
    data.sweepAreas = data.sweepAreas.map(a => {
      const needs = !('zoneType' in a) || !Array.isArray(a.roadIds);
      if (needs) { n++; return normaliseSweepArea(a); }
      return a;
    });
    if (n > 0) { migrated = true; details.push(`sweepAreas: added missing v15 fields to ${n} record(s)`); }
  }

  // ── sweepJobSites: v36 fields (sitePins, mapCenter, areaIds, fileIds) ────────
  if (Array.isArray(data.sweepJobSites)) {
    let n = 0;
    data.sweepJobSites = data.sweepJobSites.map(s => {
      const needs = !Array.isArray(s.mapPins) || !Array.isArray(s.areaIds) || !Array.isArray(s.fileIds);
      if (needs) { n++; return normaliseSweepJobSite(s); }
      return s;
    });
    if (n > 0) { migrated = true; details.push(`sweepJobSites: backfilled mapPins/areaIds/fileIds on ${n} record(s)`); }
  }

  // ── inspections: v8.0 photo GPS + pin-link fields ────────────────────────
  if (Array.isArray(data.inspections)) {
    let n = 0;
    data.inspections = data.inspections.map(insp => {
      const photosNeedUpdate = (insp.photos || []).some(p =>
        !('lat' in p) || !('lng' in p) || !('mapId' in p) || !('pinId' in p)
      );
      const needs = !Array.isArray(insp.photos) || !Array.isArray(insp.pinLinks) || photosNeedUpdate;
      if (needs) { n++; return normaliseInspection(insp); }
      return insp;
    });
    if (n > 0) { migrated = true; details.push(`inspections: backfilled photo GPS/pin-link on ${n} record(s)`); }
  }

  // ── sweepCategories: v8.0 item color + description ────────────────────────
  if (Array.isArray(data.sweepCategories)) {
    let n = 0;
    data.sweepCategories = data.sweepCategories.map(cat => {
      const needs = (cat.items || []).some(item => !('color' in item) || !('description' in item));
      if (needs) { n++; return normaliseSweepCategory(cat); }
      return cat;
    });
    if (n > 0) { migrated = true; details.push(`sweepCategories: backfilled item color/description on ${n} category(s)`); }
  }

  // ── categories / sweepCategories: dedupe pass — clean up pre-existing duplicates ──
  // Catches duplicate-named lists and duplicate-named items that were created before
  // this fix existed (e.g. via the old buggy client, or two devices syncing offline).
  if (Array.isArray(data.categories)) {
    const before = data.categories.length;
    // Bug fix (v59.14): repair records with a missing/empty `type` by matching
    // their name against the known default labels — same pattern as the
    // sweepCategories categoryType repair in v59.13.
    const CAT_NAME_TO_TYPE = new Map([
      ['inspection types', 'inspection_type'],
      ['condition ratings', 'condition'],
      ['comment categories', 'comment_category'],
    ]);
    let typesRepaired = 0, typesReclassified = 0;
    data.categories = data.categories.map(cat => {
      if (!cat) return cat;
      // v71.0: id-based match first — rename-proof (see CAT_ID_TO_TYPE comment above).
      const byId = CAT_ID_TO_TYPE[cat.id];
      if (byId && cat.type !== byId) { typesRepaired++; return { ...cat, type: byId }; }
      if (!cat.type) {
        const inferred = CAT_NAME_TO_TYPE.get(String(cat.name || '').trim().toLowerCase());
        if (inferred) { typesRepaired++; return { ...cat, type: inferred }; }
        // Unknown name — default to 'custom' so it's preserved rather than orphaned
        typesRepaired++;
        return { ...cat, type: 'custom' };
      }
      if (cat.type === 'custom') {
        const inferred = CAT_NAME_TO_TYPE.get(String(cat.name || '').trim().toLowerCase());
        if (inferred) { typesReclassified++; return { ...cat, type: inferred }; }
      }
      return cat;
    });
    const { records: dedupedCats, removed: catsRemoved } = dedupeCategoryRecordsByName(data.categories, false);
    let itemsRemoved = 0;
    data.categories = dedupedCats.map(cat => {
      const { items, removed } = dedupeItemsByName(cat.items);
      itemsRemoved += removed;
      return removed > 0 ? { ...cat, items } : cat;
    });
    if (typesRepaired > 0 || typesReclassified > 0 || catsRemoved > 0 || itemsRemoved > 0) {
      migrated = true;
      details.push(`categories: repaired type on ${typesRepaired} record(s), reclassified ${typesReclassified} mislabelled 'custom' record(s), collapsed ${catsRemoved} duplicate list(s) and ${itemsRemoved} duplicate item(s) (${before} → ${data.categories.length} lists)`);
    }
  }
  if (Array.isArray(data.sweepCategories)) {
    const before = data.sweepCategories.length;
    // Bug fix (v59.13): repair records with a missing/empty categoryType by
    // matching their name against SW_CAT_META labels (case-insensitive), instead
    // of leaving them as untyped "Custom (0 items)" husks forever. This is the
    // server-side mirror of the same fix in the app's consolidateSweepCategories —
    // it heals records already stuck on disk, not just newly-pushed ones.
    // v59.16: match on whitespace-collapsed name too (e.g. "Zone   Types" or a
    // trailing/leading-space variant that survived an old buggy import) — exact
    // string match alone missed these. Deliberately NOT fuzzy/word-subset matching:
    // near-miss names like "All Zone Types" or "Frequencies" are left untouched and
    // fall back to categoryType 'custom' below, because auto-guessing which default
    // list a differently-worded name "really means" risks silently merging what may
    // be a genuinely distinct custom list into the wrong bucket — worse than leaving
    // it visibly labelled Custom for a human to review.
    const normCatName = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const NAME_TO_TYPE = new Map(
      Object.entries(SW_CAT_META).map(([type, meta]) => [normCatName(meta.label), type])
    );
    // v59.17: also repair records already stuck with categoryType === 'custom'
    // from an earlier corrupted run — the v59.13 fallback (`inferred || 'custom'`)
    // permanently hard-set categoryType to 'custom' on any exact-match miss that
    // happened *before* this build existed (e.g. a slightly different separator,
    // or the match simply never ran because of the startup-crash bug fixed in
    // v59.15). Once categoryType is a real, present string, the old `!cat.categoryType`
    // guard skipped these forever, so "Debris Types", "Damage Severity", etc. stayed
    // mislabelled "Custom" even though their name is an exact match for a default
    // label. Re-attempting the match here only reclassifies when the name matches
    // EXACTLY (still no fuzzy/word-subset guessing) — a record literally named
    // "Damage Severity" that's currently tagged 'custom' is essentially certain to
    // be this migration artifact, not a deliberate user list of the same name.
    let typesRepaired = 0, typesReclassified = 0;
    data.sweepCategories = data.sweepCategories.map(cat => {
      if (!cat) return cat;
      // v71.0 BUG FIX: name-matching alone permanently fails once a user renames
      // a built-in list (e.g. "Damage Types" -> "Damage and points of interest"),
      // since the record's name no longer matches any SW_CAT_META label — a
      // corrupted/missing categoryType could then never be healed again, and
      // the record stayed mislabelled "Custom (0 items)" forever regardless of
      // how many times this migration ran. The 15 built-in lists always keep
      // their FIXED id (sc-debris-type, sc-damage-type, ...) even after a
      // rename, so matching by id first is fully reliable and rename-proof.
      const byId = SW_CAT_ID_TO_TYPE[cat.id];
      if (byId && cat.categoryType !== byId) { typesRepaired++; return { ...cat, categoryType: byId }; }
      if (!cat.categoryType) {
        const inferred = NAME_TO_TYPE.get(normCatName(cat.name));
        if (inferred) { typesRepaired++; return { ...cat, categoryType: inferred }; }
      } else if (cat.categoryType === 'custom') {
        const inferred = NAME_TO_TYPE.get(normCatName(cat.name));
        if (inferred) { typesReclassified++; return { ...cat, categoryType: inferred }; }
      }
      return cat;
    });
    const { records: husklessCats, removed: husksRemoved } = dropEmptyCategoryHusks(data.sweepCategories, true);
    const { records: dedupedCats, removed: catsRemoved } = dedupeCategoryRecordsByName(husklessCats, true);
    let itemsRemoved = 0;
    data.sweepCategories = dedupedCats.map(cat => {
      const { items, removed } = dedupeItemsByName(cat.items);
      itemsRemoved += removed;
      return removed > 0 ? { ...cat, items } : cat;
    });
    if (typesRepaired > 0 || typesReclassified > 0 || husksRemoved > 0 || catsRemoved > 0 || itemsRemoved > 0) {
      migrated = true;
      details.push(`sweepCategories: repaired categoryType on ${typesRepaired} record(s), reclassified ${typesReclassified} mislabelled 'custom' record(s), dropped ${husksRemoved} empty husk list(s), collapsed ${catsRemoved} duplicate list(s) and ${itemsRemoved} duplicate item(s) (${before} → ${data.sweepCategories.length} lists)`);
    }
  }

  // ── sweepJobSites: v8.0 pin notes ─────────────────────────────────────────
  if (Array.isArray(data.sweepJobSites)) {
    let pinsMigrated = 0;
    data.sweepJobSites = data.sweepJobSites.map(site => {
      if (!Array.isArray(site.mapPins) || site.mapPins.every(p => 'notes' in p)) return site;
      const cnt = site.mapPins.filter(p => !('notes' in p)).length;
      pinsMigrated += cnt;
      return { ...site, mapPins: site.mapPins.map(pin => normaliseSweepJobSitePin(pin)) };
    });
    if (pinsMigrated > 0) { migrated = true; details.push(`sweepJobSites: backfilled pin.notes on ${pinsMigrated} pin(s)`); }
  }

  // ── clients: backfill contractNumber (v54.3+) ───────────────────────────────
  if (Array.isArray(data.clients)) {
    let n = 0;
    data.clients = data.clients.map(c => {
      if (!('contractNumber' in c) || !('active' in c)) {
        n++;
        return { contractNumber: '', active: true, ...c };
      }
      return c;
    });
    if (n > 0) { migrated = true; details.push(`clients: backfilled contractNumber/active on ${n} record(s)`); }
  }

  // ── sweepMaps: obsolescence cleanup (v52.9+) ─────────────────────────────
  // SweepMaps are now derived from SweepJob route data — old manually-created
  // maps (those with a 'type' or 'url' or 'imageData' field from the legacy
  // map builder) are no longer displayed by the app.
  //
  // BUG FIX (v55.5): the original filter incorrectly included `'pins' in m`
  // which is a VALID field on modern SweepMap objects, causing ALL maps with
  // pins to be wrongly archived. Only `type`, `url`, and `imageData` are
  // markers of the old map-builder format and should be treated as legacy.
  if (Array.isArray(data.sweepMaps) && data.sweepMaps.length > 0) {
    const legacyMaps = data.sweepMaps.filter(m =>
      m && typeof m === 'object' &&
      ('type' in m || 'url' in m || 'imageData' in m)  // ← pins removed: it's a valid modern field
    );
    if (legacyMaps.length > 0) {
      data._legacySweepMaps = [...(data._legacySweepMaps || []), ...legacyMaps];
      data.sweepMaps = data.sweepMaps.filter(m => !legacyMaps.includes(m));
      migrated = true;
      details.push(`sweepMaps: archived ${legacyMaps.length} truly-legacy map(s) (had type/url/imageData)`);
    }
  }

  // ── _legacySweepMaps: recover incorrectly-archived modern maps (v55.5) ───
  // Previous versions wrongly used `'pins' in m` as a legacy indicator,
  // archiving valid modern SweepMaps. Restore any archived records that do NOT
  // have the truly-legacy fields (type / url / imageData) back into sweepMaps,
  // then delete the shadow key entirely so it stops causing health/sync noise.
  if (Array.isArray(data._legacySweepMaps) && data._legacySweepMaps.length > 0) {
    const trulyLegacy = data._legacySweepMaps.filter(m =>
      m && typeof m === 'object' &&
      ('type' in m || 'url' in m || 'imageData' in m)
    );
    const falselyArchived = data._legacySweepMaps.filter(m =>
      m && typeof m === 'object' &&
      !('type' in m) && !('url' in m) && !('imageData' in m)
    );
    if (falselyArchived.length > 0) {
      // Merge recovered maps back into sweepMaps (deduplicate by id)
      const liveIds = new Set((data.sweepMaps || []).map(m => m && m.id).filter(Boolean));
      const toRestore = falselyArchived.filter(m => m.id && !liveIds.has(m.id));
      data.sweepMaps = [...(data.sweepMaps || []), ...toRestore];
      migrated = true;
      details.push(`sweepMaps: recovered ${toRestore.length} map(s) incorrectly archived by previous migration`);
    }
    // Only keep truly-legacy records in the shadow key; if none, remove the key entirely
    if (trulyLegacy.length > 0) {
      data._legacySweepMaps = trulyLegacy;
    } else {
      delete data._legacySweepMaps;
    }
    if (!data._legacySweepMaps || data._legacySweepMaps.length === 0) {
      delete data._legacySweepMaps;
      migrated = true; // ensure saveData is called so the key is removed from disk
    }
  }

  // ── Auto-detect unknown fields on known records — log only, never drop ─────
  const KNOWN_ROAD_FIELDS  = new Set(['id','name','areaId','points','segments','color','showNumbers','showMarkers','lengthMetres','notes','createdAt','updatedAt','weather','startDate','startTime','finishDate','finishTime','fuelDocketId']);
  const KNOWN_ZONE_FIELDS  = new Set(['id','name','areaId','zoneKind','color','points','areaM2','notes','createdAt','updatedAt','fillEnabled','labelPos','subZones']);
  const KNOWN_JOB_FIELDS   = new Set(['id','title','jobNumber','status','date','startDate','finishDate','areaId','areaIds','zoneIds','siteId','roads','notes','clientId','equipment','fuelDockets','extraExpenses','tipRuns','fileIds','createdAt','updatedAt','crewMember','startTime','endTime','weather']); // v73.51: zoneIds added
  const driftLog = [];
  if (Array.isArray(data.sweepRoads)) {
    const newFields = new Set();
    data.sweepRoads.forEach(r => Object.keys(r||{}).forEach(k => { if (!KNOWN_ROAD_FIELDS.has(k)) newFields.add(k); }));
    if (newFields.size) driftLog.push(`sweepRoads has new fields: ${[...newFields].join(', ')}`);
  }
  if (Array.isArray(data.sweepZones)) {
    const newFields = new Set();
    data.sweepZones.forEach(z => Object.keys(z||{}).forEach(k => { if (!KNOWN_ZONE_FIELDS.has(k)) newFields.add(k); }));
    if (newFields.size) driftLog.push(`sweepZones has new fields: ${[...newFields].join(', ')}`);
  }
  if (Array.isArray(data.sweepJobs)) {
    const newFields = new Set();
    data.sweepJobs.forEach(j => Object.keys(j||{}).forEach(k => { if (!KNOWN_JOB_FIELDS.has(k)) newFields.add(k); }));
    if (newFields.size) driftLog.push(`sweepJobs has new fields: ${[...newFields].join(', ')}`);
  }
  if (driftLog.length) console.log('[migrate] ℹ️  New app fields detected (preserved automatically):', driftLog.join(' | '));

  return { data, migrated, details };
}

/**
 * Inspect data for records that need migration without modifying them.
 * Returns counts and details of what would be changed.
 */
function inspectMigrations(data) {
  const report = { needsMigration: false, collections: {} };
  if (!data) return report;

  const roadAreaMap = {};
  if (Array.isArray(data.sweepRoads))
    data.sweepRoads.forEach(r => { if (r.id && r.areaId) roadAreaMap[r.id] = r.areaId; });

  // sweepRoads
  if (Array.isArray(data.sweepRoads)) {
    const need = data.sweepRoads.filter(r => !('showNumbers' in r) || !('showMarkers' in r) || !('weather' in r));
    if (need.length > 0) {
      report.needsMigration = true;
      report.collections.sweepRoads = { total: data.sweepRoads.length, needsMigration: need.length };
    }
  }

  // sweepJobs
  if (Array.isArray(data.sweepJobs)) {
    const need = data.sweepJobs.filter(j =>
      !Array.isArray(j.areaIds) || !('siteId' in j) || !Array.isArray(j.fuelDockets) ||
      !Array.isArray(j.extraExpenses) || !Array.isArray(j.tipRuns) ||
      (j.roads || []).some(r => !(j.areaIds || []).includes(roadAreaMap[r.roadId]))
    );
    if (need.length > 0) {
      report.needsMigration = true;
      report.collections.sweepJobs = { total: data.sweepJobs.length, needsMigration: need.length,
        affected: need.map(j => ({ id: j.id, title: j.title || j.jobNumber, status: j.status })) };
    }
  }

  // sweepAreas
  if (Array.isArray(data.sweepAreas)) {
    const need = data.sweepAreas.filter(a => !('zoneType' in a) || !Array.isArray(a.roadIds));
    if (need.length > 0) {
      report.needsMigration = true;
      report.collections.sweepAreas = { total: data.sweepAreas.length, needsMigration: need.length };
    }
  }

  // sweepJobSites — v36 fields
  if (Array.isArray(data.sweepJobSites)) {
    const need = data.sweepJobSites.filter(s => !Array.isArray(s.mapPins) || !Array.isArray(s.areaIds) || !Array.isArray(s.fileIds));
    if (need.length > 0) {
      report.needsMigration = true;
      report.collections.sweepJobSites = { total: data.sweepJobSites.length, needsMigration: need.length };
    }
  }

  // inspections — v8.0 photo GPS fields
  if (Array.isArray(data.inspections)) {
    const need = data.inspections.filter(i =>
      !Array.isArray(i.photos) || (i.photos || []).some(p => !('lat' in p) || !('mapId' in p))
    );
    if (need.length > 0) {
      report.needsMigration = true;
      report.collections.inspections = { total: data.inspections.length, needsMigration: need.length };
    }
  }

  // sweepCategories — v8.0 item color, plus v71.0: categoryType needing id/name repair
  // (missing, or a fixed default id whose categoryType doesn't match its known type —
  // e.g. still 'custom' after a rename). Without this check, applyMigrations() would
  // never run at server startup for data that only has a categoryType problem, since
  // it would only run on the next app push — leaving the dashboard mislabelled until
  // then even though a fix is already deployed.
  if (Array.isArray(data.sweepCategories)) {
    const need = data.sweepCategories.filter(c =>
      (c.items || []).some(i => !('color' in i)) ||
      !c.categoryType ||
      (SW_CAT_ID_TO_TYPE[c.id] && c.categoryType !== SW_CAT_ID_TO_TYPE[c.id])
    );
    if (need.length > 0) {
      report.needsMigration = true;
      report.collections.sweepCategories = { total: data.sweepCategories.length, needsMigration: need.length };
    }
  }

  // categories — v71.0: same type-repair check as sweepCategories above
  if (Array.isArray(data.categories)) {
    const need = data.categories.filter(c =>
      !c.type || (CAT_ID_TO_TYPE[c.id] && c.type !== CAT_ID_TO_TYPE[c.id])
    );
    if (need.length > 0) {
      report.needsMigration = true;
      report.collections.categories = { total: data.categories.length, needsMigration: need.length };
    }
  }

  // sweepJobSites — v8.0 pin notes
  if (Array.isArray(data.sweepJobSites)) {
    const need = data.sweepJobSites.filter(s => (s.mapPins || []).some(p => !('notes' in p)));
    if (need.length > 0) {
      report.needsMigration = true;
      report.collections.sweepJobSites = { ...(report.collections.sweepJobSites || {}),
        pinNotesMissing: need.length };
    }
  }

  // sweepRoads — v52.9 RouteSegment.color field
  if (Array.isArray(data.sweepRoads)) {
    const need = data.sweepRoads.filter(r =>
      Array.isArray(r.segments) && r.segments.some(s => s && !('color' in s))
    );
    if (need.length > 0) {
      report.needsMigration = true;
      report.collections.sweepRoads = { ...(report.collections.sweepRoads || {}),
        segmentColorMissing: need.length };
    }
  }

  // sweepMaps — v52.9 obsolescence (legacy manual maps should be archived)
  if (Array.isArray(data.sweepMaps) && data.sweepMaps.length > 0) {
    const legacyCount = data.sweepMaps.filter(m =>
      m && typeof m === 'object' && ('type' in m || 'url' in m || 'imageData' in m || 'pins' in m)
    ).length;
    if (legacyCount > 0) {
      report.needsMigration = true;
      report.collections.sweepMaps = { total: data.sweepMaps.length, legacyToArchive: legacyCount };
    }
  }

  return report;
}

// ── Normalise / Merge ─────────────────────────────────────────────────────────
function normaliseData(data) {
  // FIX: always preserve unknown/future collections — never drop data the server
  // doesn't recognise. New app features send new collection names; we must keep them.
  const d = applyLegacyAliases(data || {});
  const norm = {};
  for (const col of ALL_COLLECTIONS)
    norm[col] = Array.isArray(d[col]) ? d[col] : [];
  norm.deletedIds = Array.isArray(d.deletedIds) ? d.deletedIds : [];
  // Always preserve unknown collections (custom or future)
  for (const [k, v] of Object.entries(d)) {
    if (!norm.hasOwnProperty(k) && Array.isArray(v)) {
      norm[k] = v;
      console.log(`[normalise] Preserving future/custom collection "${k}" (${v.length} records)`);
    }
  }
  return norm;
}

function mergeArrays(server, client) {
  // FIX: Field-union merge — winner's record takes precedence for conflicts,
  // but any fields ONLY in the loser are preserved on the winner.
  // This ensures new app fields added to a record on one device are never
  // silently dropped when another device's version of the same record wins.
  const map = new Map();
  for (const item of (server || [])) if (item && item.id) map.set(item.id, item);
  for (const item of (client || [])) {
    if (!item || !item.id) continue;
    const ex = map.get(item.id);
    if (!ex) { map.set(item.id, item); continue; }
    const st = ex.updatedAt || ex.createdAt || '';
    const ct = item.updatedAt || item.createdAt || '';
    if (ct >= st) {
      // Client is newer — use client as base, but preserve any server-only fields
      map.set(item.id, { ...ex, ...item });
    } else {
      // Server is newer — use server as base, but preserve any client-only fields
      map.set(item.id, { ...item, ...ex });
    }
  }
  return Array.from(map.values());
}

// ── Generic nested-array deep-merge helpers ──────────────────────────────────
// BUG FIX (Craig-reported, v73.5): "check and fix all the others" — after
// tipRuns/extraExpenses (v73.4) turned out to have the same unprotected-
// nested-array gap already fixed once for sweepJobs.roads/fuelDockets (Bug 7
// fix) and once more for maps.pins (v72.2), Craig asked for every other
// collection to be checked for the same class of bug rather than fixing them
// one at a time as each is separately reported. Audited every collection's
// shape in types.ts against mergeData()'s branches below; every collection
// with an array-of-objects sub-field that has independent per-item state
// (edited by more than one device without any relation to the parent
// record's own updatedAt) was at risk of exactly this: two devices editing
// the same parent record while offline, whichever one has the newer
// updatedAt silently overwrites the other's entire sub-array, dropping any
// item the "losing" device added that the "winning" device never saw.
//
// mergeSubArrayById: for a sub-array of objects that each have their own
// `id` (photos, comments, pins, etc.) — unions by id, newer item wins field
// conflicts on a shared id, but preserves fields the older side had that the
// newer side doesn't (same philosophy as mergeArrays above).
function mergeSubArrayById(serverArr, clientArr) {
  const map = new Map();
  for (const item of (serverArr || [])) if (item && item.id) map.set(item.id, item);
  for (const item of (clientArr || [])) {
    if (!item || !item.id) continue;
    const existing = map.get(item.id);
    if (!existing) { map.set(item.id, item); continue; }
    const st = existing.updatedAt || existing.createdAt || '';
    const ct = item.updatedAt || item.createdAt || '';
    map.set(item.id, ct >= st ? { ...existing, ...item } : { ...item, ...existing });
  }
  return Array.from(map.values());
}

// mergeIdRefArray: for a plain array of string ids/references (inspectionIds,
// areaIds, roadIds, fileIds, jobIds, categories, etc. — no independent
// per-item state, just "this parent record points at these other records").
// A whole-record field-union still risks silently dropping a reference one
// device added if the other device's record wins on updatedAt for an
// unrelated field change — so these get unioned (order-preserving, deduped)
// rather than left to whole-record overwrite.
function mergeIdRefArray(serverArr, clientArr) {
  const out = [];
  const seen = new Set();
  for (const id of [...(serverArr || []), ...(clientArr || [])]) {
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// Applies mergeIdRefArray to a list of field names on a merged record, using
// the server/client copies of that same record as the two sources to union.
function unionIdRefFields(mergedRecord, serverRecord, clientRecord, fields) {
  if (!serverRecord || !clientRecord) return mergedRecord;
  const patch = {};
  for (const f of fields) patch[f] = mergeIdRefArray(serverRecord[f], clientRecord[f]);
  return { ...mergedRecord, ...patch };
}


/**
/**
 * mergeCategoryItems(winnerItems, loserItems)
 * Merges the nested items arrays inside a Category or SweepCategory record.
 * Winner's items take precedence for matching names, but items ONLY in the loser
 * are appended — so adding items on two devices simultaneously never loses either.
 *
 * NOTE: Category/SweepCategory items do NOT have an id field — they are plain
 * objects {name, color, description}.  Earlier code matched by i.id which was
 * always undefined, so loser items were always silently dropped.  Fixed to
 * match by normalised name instead.
 */
function mergeCategoryItems(winnerItems, loserItems) {
  const winner = Array.isArray(winnerItems) ? winnerItems : [];
  const loser  = Array.isArray(loserItems)  ? loserItems  : [];
  // Build a set of the winner's item names (lower-cased) for fast lookup
  const winnerNames = new Set(
    winner.map(i => i && i.name ? String(i.name).trim().toLowerCase() : null).filter(Boolean)
  );
  // Append any loser items whose name is not already covered by the winner
  const extra = loser.filter(i => i && i.name && !winnerNames.has(String(i.name).trim().toLowerCase()));
  return [...winner, ...extra];
}

/**
 * mergeCategoryRecord(winner, loser)
 * Merges two category records: uses winner's fields (it has newer updatedAt),
 * but unions their nested items so neither device's additions are lost.
 * After unioning, collapses any items that ended up sharing the same name —
 * e.g. both devices independently added an item called "Cracked" with different
 * IDs while offline; without this, both would survive the merge as duplicates.
 */
function mergeCategoryRecord(winner, loser) {
  if (!winner) return loser;
  if (!loser)  return winner;
  const unionedItems = mergeCategoryItems(winner.items, loser.items);
  const { items: dedupedItems, removed } = dedupeItemsByName(unionedItems);
  if (removed > 0)
    console.log(`[merge] Category "${winner.name || winner.id}": collapsed ${removed} duplicate-named item(s) from concurrent edits`);
  const merged = {
    ...loser,   // loser fields as base (field-union from mergeArrays)
    ...winner,  // winner fields override
    items: dedupedItems,
  };
  // Bug fix (v59.13/v59.14): `type` or `categoryType` should never regress to
  // empty once a real value has been seen on either side of the merge.
  if (!merged.categoryType && loser.categoryType)  merged.categoryType = loser.categoryType;
  if (!merged.categoryType && winner.categoryType) merged.categoryType = winner.categoryType;
  if (!merged.type && loser.type)  merged.type = loser.type;
  if (!merged.type && winner.type) merged.type = winner.type;
  return merged;
}

/**
 * dropEmptyCategoryHusks(records, scopeByType)
 * BUG FIX: an old client build (pre-v58) split "Damage Types" so that each
 * item (Pothole, Kerb Damage, Drainage Issue, ...) became its OWN category
 * record with an empty items[] array, instead of living inside the single
 * "Damage Types" list. Because dedupeCategoryRecordsByName only collapses
 * records that share the same NAME, those husks (different names, 0 items)
 * survive forever and keep re-syncing to every device.
 *
 * This drops any record with 0 items whenever a sibling of the same
 * categoryType already HAS items — there is nothing inside the husk to lose.
 * If every record of a type is empty, all are left alone (nothing to do).
 */
function dropEmptyCategoryHusks(records, scopeByType) {
  // Bug 2 fix: only drop an empty record if a POPULATED record of the same type
  // has an equal-or-newer updatedAt — never drop a record the user just cleared.
  //
  // Bug 11 fix (v59.11): two additional husk scenarios were causing items to be lost:
  //  A) Server migration bumped empty record's updatedAt to NOW, making it look newer
  //     than the app's populated record — the timestamp guard blocked husk removal.
  //     Fix: untyped records (no categoryType) are always migration artifacts, never
  //     intentional user clears — so skip the timestamp guard for them.
  //  B) Empty records with no categoryType were in a separate '' bucket and never
  //     matched against populated records that have categoryType set.
  //     Fix: after same-type pass, drop untyped empties if any typed record shares
  //     the same name, regardless of timestamp.
  if (!Array.isArray(records) || records.length === 0) return { records: records || [], removed: 0 };
  const groupKey = rec => scopeByType ? (rec.categoryType || '') : '__all__';

  // For each group key, find the most-recently-updated populated record's timestamp
  const newestPopulatedAt = new Map();
  for (const r of records) {
    if (!Array.isArray(r.items) || r.items.length === 0) continue;
    const k = groupKey(r);
    const t = r.updatedAt || r.createdAt || '';
    if (!newestPopulatedAt.has(k) || t > newestPopulatedAt.get(k)) {
      newestPopulatedAt.set(k, t);
    }
  }

  // Build name set of all populated records that have a proper categoryType —
  // used in Pass 2 to catch untyped empty husks that survived Pass 1.
  const populatedTypedNames = new Set();
  if (scopeByType) {
    for (const r of records) {
      if (r.categoryType && Array.isArray(r.items) && r.items.length > 0) {
        populatedTypedNames.add(String(r.name || '').trim().toLowerCase());
      }
    }
  }

  const kept = [];
  let removed = 0;
  for (const rec of records) {
    const isEmpty = !Array.isArray(rec.items) || rec.items.length === 0;
    if (isEmpty) {
      // Pass 1: same-type timestamp guard (original logic)
      if (newestPopulatedAt.has(groupKey(rec))) {
        const emptyAt     = rec.updatedAt || rec.createdAt || '';
        const populatedAt = newestPopulatedAt.get(groupKey(rec));
        if (emptyAt <= populatedAt) {
          removed++;
          console.log(`[merge] Dropped empty husk list "${rec.name}" (type: ${rec.categoryType || 'n/a'}) — older than populated sibling`);
          continue;
        }
      }
      // Pass 2: untyped empty — drop if any TYPED populated record has the same name.
      // Untyped records are server-side migration artifacts (the app always sets categoryType).
      // No timestamp guard: a typed populated record always beats an untyped empty one.
      if (scopeByType && !rec.categoryType) {
        const nameLower = String(rec.name || '').trim().toLowerCase();
        if (populatedTypedNames.has(nameLower)) {
          removed++;
          console.log(`[merge] Dropped untyped empty husk "${rec.name}" — superseded by typed populated record`);
          continue;
        }
      }
    }
    kept.push(rec);
  }
  return { records: kept, removed };
}

/**
 * dedupeCategoryRecordsByName(records, scopeByType)
 * Collapses category/list RECORDS that share the same name — e.g. two devices
 * each independently created a "Damage Types" list (different ids) while offline.
 * Rather than silently dropping one (which would lose its items), this merges
 * all duplicates' items into the most-recently-updated record, then drops the rest.
 *
 * scopeByType: when true (sweepCategories), duplicates are only collapsed within
 * the same categoryType — e.g. "Other" in Equipment and "Other" in Damage Types
 * are different lists and should NOT be merged together.
 */
function dedupeCategoryRecordsByName(records, scopeByType) {
  if (!Array.isArray(records) || records.length === 0) return { records: records || [], removed: 0 };

  const groups = new Map(); // key -> records[]
  for (const rec of records) {
    if (!rec || typeof rec !== 'object' || !rec.name) continue;
    // Bug 11 fix (v59.11): when scopeByType and the record has no categoryType,
    // fall back to name-only keying so untyped server husks are grouped with
    // same-named typed records and their items can be rescued via mergeCategoryRecord.
    let key;
    if (scopeByType && rec.categoryType) {
      key = `${rec.categoryType}::${String(rec.name).trim().toLowerCase()}`;
    } else if (scopeByType && !rec.categoryType) {
      // Untyped: find if any existing group has the same name (any type)
      const nameLower = String(rec.name).trim().toLowerCase();
      let matched = null;
      for (const [k] of groups) {
        if (k.endsWith(`::${nameLower}`) || k === nameLower) { matched = k; break; }
      }
      key = matched || nameLower; // join an existing typed group or create name-only group
    } else {
      key = String(rec.name).trim().toLowerCase();
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }

  const out = [];
  let removed = 0;
  for (const group of groups.values()) {
    if (group.length === 1) { out.push(group[0]); continue; }
    // Multiple records share this name — pick the most recently updated as primary,
    // fold every other record's items into it, then drop the rest.
    const sorted = [...group].sort((a, b) =>
      (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
    let primary = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      primary = mergeCategoryRecord(primary, sorted[i]);
      removed++;
    }
    console.log(`[merge] Collapsed ${group.length} duplicate "${primary.name}" lists into one (merged all items)`);
    out.push(primary);
  }
  return { records: out, removed };
}

function mergeData(serverData, clientData) {
  const s = normaliseData(serverData);
  const c = normaliseData(clientData);
  const merged = {};
  // Bug 5 fix: run normaliseSweepCategory / normaliseCategory on merged results
  // so records arriving via sync path get the same item-dedup as explicit API writes.
  // (Previously only PATCH/PUT routes called these normalise functions.)

  // Merge known collections — categories use item-level merge to prevent losing
  // items added simultaneously on two devices.
  const CATEGORY_COLS = new Set(['categories', 'sweepCategories']);
  for (const col of ALL_COLLECTIONS) {
    if (CATEGORY_COLS.has(col)) {
      // Category-aware merge: union items from both sides, winner record's fields win
      const serverArr = s[col] || [];
      const clientArr = c[col] || [];
      const map = new Map();
      for (const item of serverArr) if (item && item.id) map.set(item.id, item);
      for (const item of clientArr) {
        if (!item || !item.id) continue;
        const ex = map.get(item.id);
        if (!ex) { map.set(item.id, item); continue; }
        const st = ex.updatedAt || ex.createdAt || '';
        const ct = item.updatedAt || item.createdAt || '';
        const winner = ct >= st ? item : ex;
        const loser  = ct >= st ? ex   : item;
        map.set(item.id, mergeCategoryRecord(winner, loser));
      }
      merged[col] = Array.from(map.values());
      // Drop empty "husk" lists (0 items) whenever a populated list of the
      // same categoryType already exists — fixes the old "Damage Types split
      // into Pothole/Kerb Damage/..." corruption permanently on every sync.
      const { records: husklessRecords } = dropEmptyCategoryHusks(merged[col], col === 'sweepCategories');
      // Final pass: collapse any duplicate-NAMED records that survived the
      // id-based merge above (e.g. two devices each created a list with the
      // same name while offline — different ids, so both would otherwise survive).
      const { records: dedupedRecords } = dedupeCategoryRecordsByName(husklessRecords, col === 'sweepCategories');
      merged[col] = dedupedRecords;
    } else {
      // Bug 7 fix: for sweepJobs, deep-merge nested arrays (roads, fuelDockets)
      // so that road-level settings (photos, notes, damagePins) aren't clobbered
      // by a field-union that picks the record with the newer updatedAt wholesale.
      if (col === 'sweepJobs') {
        merged[col] = mergeArrays(s[col], c[col]).map(job => {
          const sJob = (s[col] || []).find(j => j.id === job.id);
          const cJob = (c[col] || []).find(j => j.id === job.id);
          if (!sJob || !cJob) return job;
          // Deep merge roads array by roadId
          const sRoads = sJob.roads || [];
          const cRoads = cJob.roads || [];
          const roadsById = new Map();
          for (const r of sRoads) roadsById.set(r.roadId, r);
          for (const r of cRoads) {
            const existing = roadsById.get(r.roadId);
            if (!existing) { roadsById.set(r.roadId, r); continue; }
            // BUG FIX (v73.9 — found while fixing Sweep Reports' segment-data
            // blindness, per CLAUDE_CONTEXT.md's §0 standing rule to check
            // server-side merge coverage for anything touched): the road-level
            // merge above was only ever a SHALLOW `{...existing, ...r}` spread
            // — damagePins and segmentSettings (the field the whole
            // segment-aware-reports fix depends on) were still at risk of one
            // device's entire array silently overwriting the other's, same
            // bug class as tipRuns/maps.pins/etc., just one level deeper than
            // the original "Bug 7 fix" reached. damagePins merges by id;
            // segmentSettings has no id field (SegmentRunDetail is keyed by
            // segIdx, a plain number), so it merges by that instead.
            const damagePins = mergeSubArrayById(existing.damagePins, r.damagePins);
            const segSettingsById = new Map();
            for (const ss of (existing.segmentSettings || [])) if (ss && typeof ss.segIdx === 'number') segSettingsById.set(ss.segIdx, ss);
            for (const ss of (r.segmentSettings || [])) {
              if (!ss || typeof ss.segIdx !== 'number') continue;
              const ex = segSettingsById.get(ss.segIdx);
              segSettingsById.set(ss.segIdx, ex ? { ...ex, ...ss } : ss);
            }
            const segmentSettings = [...segSettingsById.values()].sort((a, b) => a.segIdx - b.segIdx);
            roadsById.set(r.roadId, { ...existing, ...r, damagePins, segmentSettings });
          }
          const fuelDockets = mergeArrays(sJob.fuelDockets || [], cJob.fuelDockets || []);
          // BUG FIX (Craig-reported, v73.4 — asked "will it save or will it drop
          // it" about the new per-trip tip run date, prompting this check):
          // tipRuns and extraExpenses had the exact same unprotected-nested-array
          // gap already fixed above for roads/fuelDockets and in v72.2 for
          // maps.pins — a job edited on two devices while offline would have
          // one device's entire tipRuns (or extraExpenses) array silently
          // overwrite the other's on sync, dropping trips/expenses that were
          // never seen by the "winning" device. tipRuns is nested two levels
          // deep (runs containing trips), so this merges runs by id, then
          // trips within each run by id, rather than just the run list.
          const sRuns = sJob.tipRuns || [];
          const cRuns = cJob.tipRuns || [];
          const runsById = new Map();
          for (const r of sRuns) if (r && r.id) runsById.set(r.id, r);
          for (const r of cRuns) {
            if (!r || !r.id) continue;
            const existing = runsById.get(r.id);
            if (!existing) { runsById.set(r.id, r); continue; }
            const tripsById = new Map();
            for (const t of (existing.trips || [])) if (t && t.id) tripsById.set(t.id, t);
            for (const t of (r.trips || [])) { if (t && t.id) tripsById.set(t.id, tripsById.has(t.id) ? { ...tripsById.get(t.id), ...t } : t); }
            runsById.set(r.id, { ...existing, ...r, trips: [...tripsById.values()] });
          }
          const extraExpenses = mergeArrays(sJob.extraExpenses || [], cJob.extraExpenses || []);
          // BUG FIX (v73.5): areaIds/fileIds are plain id-reference arrays at
          // the job's top level — same reasoning as everywhere else in this
          // audit, union rather than risk one device's link silently lost.
          // v73.51: zoneIds (new) is the exact same shape as areaIds — same
          // union treatment, same reasoning, added the day the field was born
          // rather than waiting for a reported bug like areaIds/fileIds got.
          return unionIdRefFields(
            { ...job, roads: [...roadsById.values()], fuelDockets, tipRuns: [...runsById.values()], extraExpenses },
            sJob, cJob, ['areaIds', 'fileIds', 'zoneIds']
          );
        });
      } else if (col === 'maps') {
        // BUG FIX (Craig-reported, v72.2): "pins not showing" / reports showing
        // just the map name with no pin dot/label/snapshot ("Marl" with nothing
        // after it). Root cause: mergeArrays() does a whole-record field-union —
        // if a map's `updatedAt` on one device is newer (e.g. it renamed the map),
        // that device's `pins` array replaces the other device's ENTIRELY, since
        // spreading a record just overwrites the `pins` key wholesale. Any pin
        // that only existed on the "losing" device silently vanishes from the
        // server's map record. Inspections on that device still reference the
        // vanished pin's id, so Reports.tsx's `map.pins.find(p => p.id === pinId)`
        // returns undefined and the report renders only the map name.
        // This is the exact same class of bug already fixed for sweepJobs.roads
        // and SweepCategory.items — pins need an id-based union, not last-write-wins.
        merged[col] = mergeArrays(s[col], c[col]).map(m => {
          const sMap = (s[col] || []).find(x => x.id === m.id);
          const cMap = (c[col] || []).find(x => x.id === m.id);
          if (!sMap || !cMap) return m;
          const sPins = Array.isArray(sMap.pins) ? sMap.pins : [];
          const cPins = Array.isArray(cMap.pins) ? cMap.pins : [];
          const pinsById = new Map();
          for (const p of sPins) if (p && p.id) pinsById.set(p.id, p);
          for (const p of cPins) {
            if (!p || !p.id) continue;
            const existing = pinsById.get(p.id);
            if (!existing) { pinsById.set(p.id, p); continue; }
            const pt = p.updatedAt || p.createdAt || '';
            const et = existing.updatedAt || existing.createdAt || '';
            pinsById.set(p.id, pt >= et ? { ...existing, ...p } : { ...p, ...existing });
          }
          const unionedPins = [...pinsById.values()];
          if (unionedPins.length !== (m.pins || []).length) {
            console.log(`[merge] map "${m.name || m.id}": pins union server=${sPins.length} client=${cPins.length} → merged=${unionedPins.length} (prevented pin loss)`);
          }
          return { ...m, pins: unionedPins };
        });
      } else if (col === 'sweepMaps') {
        // BUG FIX (Craig-reported, v73.5 — "check and fix all the others"):
        // sweepMaps has the exact same shape and exact same risk as `maps`
        // (fixed in v72.2) — a `pins: MapPin[]` sub-array with independent
        // per-pin state — but was never given the same fix, since it wasn't
        // the collection in the original pin-loss report. Same fix, same
        // reasoning: pins need an id-based union, not last-write-wins on the
        // whole map record. Also unions `linkedJobIds` (plain id-reference
        // array — a job linked to this map on one device shouldn't vanish
        // because the other device's copy of the map record won on
        // updatedAt for an unrelated reason, e.g. renaming it).
        merged[col] = mergeArrays(s[col], c[col]).map(m => {
          const sMap = (s[col] || []).find(x => x.id === m.id);
          const cMap = (c[col] || []).find(x => x.id === m.id);
          if (!sMap || !cMap) return m;
          const unionedPins = mergeSubArrayById(sMap.pins, cMap.pins);
          if (unionedPins.length !== (m.pins || []).length) {
            console.log(`[merge] sweepMap "${m.name || m.id}": pins union server=${(sMap.pins||[]).length} client=${(cMap.pins||[]).length} → merged=${unionedPins.length} (prevented pin loss)`);
          }
          return unionIdRefFields({ ...m, pins: unionedPins }, sMap, cMap, ['linkedJobIds']);
        });
      } else if (col === 'inspections') {
        // BUG FIX (Craig-reported, v73.5 — "check and fix all the others"):
        // Inspection has THREE independent-state sub-arrays — photos,
        // comments, and mapPins — all with the same unprotected-nested-array
        // gap as sweepJobs.roads/tipRuns and maps.pins. This is arguably the
        // highest-impact collection to have missed it: inspections are the
        // most frequently concurrently-edited records in the app (multiple
        // field workers adding photos/comments to the same site visit).
        // Previously: if worker A added a photo offline while worker B (also
        // offline) changed the inspection's condition field, whichever
        // device synced with the newer updatedAt would silently delete the
        // other's photo/comment entirely on merge.
        // mapPins (MapPinLink) has no `id` field — {mapId, pinId, snapshot}
        // — so it's unioned by the composite mapId+pinId key instead.
        merged[col] = mergeArrays(s[col], c[col]).map(ins => {
          const sIns = (s[col] || []).find(x => x.id === ins.id);
          const cIns = (c[col] || []).find(x => x.id === ins.id);
          if (!sIns || !cIns) return ins;
          const unionedPhotos = mergeSubArrayById(sIns.photos, cIns.photos);
          const unionedComments = mergeSubArrayById(sIns.comments, cIns.comments);
          const pinLinkMap = new Map();
          for (const mp of [...(sIns.mapPins || []), ...(cIns.mapPins || [])]) {
            if (!mp || !mp.mapId || !mp.pinId) continue;
            pinLinkMap.set(mp.mapId + '|' + mp.pinId, mp);
          }
          const unionedMapPins = Array.isArray(sIns.mapPins) || Array.isArray(cIns.mapPins) ? [...pinLinkMap.values()] : undefined;
          if (unionedPhotos.length !== (ins.photos || []).length || unionedComments.length !== (ins.comments || []).length) {
            console.log(`[merge] inspection "${ins.title || ins.id}": photos server=${(sIns.photos||[]).length} client=${(cIns.photos||[]).length} → merged=${unionedPhotos.length}; comments server=${(sIns.comments||[]).length} client=${(cIns.comments||[]).length} → merged=${unionedComments.length} (prevented data loss)`);
          }
          return { ...ins, photos: unionedPhotos, comments: unionedComments, ...(unionedMapPins ? { mapPins: unionedMapPins } : {}) };
        });
      } else if (col === 'sweepJobSites') {
        // BUG FIX (Craig-reported, v73.5 — "check and fix all the others"):
        // SweepJobSite.mapPins (SiteMapPin[], has its own `id`) is the same
        // class of risk as maps.pins/sweepMaps.pins — water points, tip
        // sites, hazards marked on two devices while offline could silently
        // lose one side's pins. fileIds/areaIds are plain id-reference
        // arrays unioned the same way as elsewhere in this function.
        merged[col] = mergeArrays(s[col], c[col]).map(site => {
          const sSite = (s[col] || []).find(x => x.id === site.id);
          const cSite = (c[col] || []).find(x => x.id === site.id);
          if (!sSite || !cSite) return site;
          const unionedPins = mergeSubArrayById(sSite.mapPins, cSite.mapPins);
          if (unionedPins.length !== (site.mapPins || []).length) {
            console.log(`[merge] sweepJobSite "${site.name || site.id}": mapPins union server=${(sSite.mapPins||[]).length} client=${(cSite.mapPins||[]).length} → merged=${unionedPins.length} (prevented pin loss)`);
          }
          return unionIdRefFields({ ...site, mapPins: unionedPins }, sSite, cSite, ['fileIds', 'areaIds']);
        });
      } else if (col === 'sweepAreas') {
        // BUG FIX (v73.5): roadIds is a plain id-reference array — union it
        // rather than risk losing a road linked on one device.
        merged[col] = mergeArrays(s[col], c[col]).map(area => {
          const sArea = (s[col] || []).find(x => x.id === area.id);
          const cArea = (c[col] || []).find(x => x.id === area.id);
          return unionIdRefFields(area, sArea, cArea, ['roadIds']);
        });
      } else if (col === 'sweepZones') {
        // v73.49 — `subZones` (SweepSubZone[]) is a zone's independent
        // sub-polygon list, each with its own id, added/renamed/redrawn
        // separately from the parent zone's own boundary — the exact same
        // shape of risk `sweepRoads.segments` already had fixed above.
        // Without this, two devices editing different sub-zones of the
        // same parent Zone while offline would have one whole `subZones`
        // array silently overwrite the other's on whichever device's
        // `updatedAt` won, same as the pre-v73.9 sweepRoads bug. Unioned by
        // id instead, same helper, same pattern.
        merged[col] = mergeArrays(s[col], c[col]).map(zone => {
          const sZone = (s[col] || []).find(x => x.id === zone.id);
          const cZone = (c[col] || []).find(x => x.id === zone.id);
          if (!sZone || !cZone) return zone;
          if (!Array.isArray(sZone.subZones) && !Array.isArray(cZone.subZones)) return zone;
          const unionedSubZones = mergeSubArrayById(sZone.subZones, cZone.subZones);
          if (unionedSubZones.length !== (zone.subZones || []).length) {
            console.log(`[merge] sweepZone "${zone.name || zone.id}": subZones union server=${(sZone.subZones||[]).length} client=${(cZone.subZones||[]).length} → merged=${unionedSubZones.length} (prevented sub-zone loss)`);
          }
          return { ...zone, subZones: unionedSubZones };
        });
      } else if (col === 'reports') {
        // BUG FIX (v73.5): inspectionIds/categories are plain id-reference
        // arrays on a Report — union them so adding an inspection to a
        // report on one device can't be wiped out by an unrelated field
        // edit winning on another device.
        merged[col] = mergeArrays(s[col], c[col]).map(rep => {
          const sRep = (s[col] || []).find(x => x.id === rep.id);
          const cRep = (c[col] || []).find(x => x.id === rep.id);
          return unionIdRefFields(rep, sRep, cRep, ['inspectionIds', 'categories']);
        });
      } else if (col === 'sweepReports') {
        // BUG FIX (v73.5): jobIds/areaIds are plain id-reference arrays —
        // same reasoning as the 'reports' branch above.
        merged[col] = mergeArrays(s[col], c[col]).map(rep => {
          const sRep = (s[col] || []).find(x => x.id === rep.id);
          const cRep = (c[col] || []).find(x => x.id === rep.id);
          return unionIdRefFields(rep, sRep, cRep, ['jobIds', 'areaIds']);
        });
      } else if (col === 'sweepRoads') {
        // BUG FIX (found via Craig's "check the host-server for anything
        // dropping silently" audit request, v73.9 — a sibling session's fix,
        // reconciled into this one): `segments` (RouteSegment[]) is a road's
        // actual editable route data — each segment has its own stable `id`,
        // gets renamed/recoloured/redrawn independently in the road editor,
        // and is saved via a whole-record `updateSweepRoad()` call. That's
        // the exact same shape of risk already fixed for sweepJobs.roads,
        // maps.pins, sweepMaps.pins, inspections.photos, and
        // sweepJobSites.mapPins — but this one had been missed, because the
        // ROAD's own `points` array (no per-point id, deliberately left as a
        // known accepted gap — see CLAUDE_CONTEXT.md) sits right next to it
        // and looks like the same kind of thing at a glance. It isn't:
        // `segments` items have ids and independent state, `points` items
        // don't. Two devices editing the same road's segments while offline
        // (one renames segment A, the other redraws segment B) would
        // previously have one whole `segments` array silently overwrite the
        // other's on whichever device's `updatedAt` won. Unioned by id now,
        // same as every other id-bearing sub-array in this function. Left
        // `points` (the road's primary/backward-compat polyline) exactly as
        // documented — still no safe per-point id to merge by.
        merged[col] = mergeArrays(s[col], c[col]).map(road => {
          const sRoad = (s[col] || []).find(x => x.id === road.id);
          const cRoad = (c[col] || []).find(x => x.id === road.id);
          if (!sRoad || !cRoad) return road;
          if (!Array.isArray(sRoad.segments) && !Array.isArray(cRoad.segments)) return road;
          // v73.39 — log it when the SAME segment id was genuinely edited
          // differently on both sides (not just "one side has it, one
          // doesn't" — that's the segment-loss case logged below). Doesn't
          // change the resolution (still newer-updatedAt-wins, now
          // meaningful since segments carry a real timestamp — see
          // saveRoad() in SweepJobs.tsx and normaliseSweepRoad() above) but
          // makes a real concurrent edit VISIBLE in the server log instead
          // of resolving silently — added while investigating a reported
          // segment duplication/content-loss issue.
          const sSegs = sRoad.segments || [], cSegs = cRoad.segments || [];
          sSegs.forEach(sSeg => {
            if (!sSeg || !sSeg.id) return;
            const cSeg = cSegs.find(x => x && x.id === sSeg.id);
            if (!cSeg) return; // only on one side — loss/addition case, not a same-id conflict
            const samePoints = JSON.stringify(sSeg.points || []) === JSON.stringify(cSeg.points || []);
            if (!samePoints) {
              const st = sSeg.updatedAt || 'unknown', ct = cSeg.updatedAt || 'unknown';
              const winner = ct >= st ? 'client' : 'server';
              console.log(`[merge] CONFLICT: sweepRoad "${road.name || road.id}" segment "${sSeg.label || sSeg.id}" edited differently on both sides `
                + `(server: ${(sSeg.points||[]).length} pts @ ${st}, client: ${(cSeg.points||[]).length} pts @ ${ct}) — keeping ${winner}'s version. `
                + `If this looks wrong, the losing side's edit was overwritten — check with whoever made it.`);
            }
          });
          const unionedSegments = mergeSubArrayById(sRoad.segments, cRoad.segments);
          if (unionedSegments.length !== (road.segments || []).length) {
            console.log(`[merge] sweepRoad "${road.name || road.id}": segments union server=${(sRoad.segments||[]).length} client=${(cRoad.segments||[]).length} → merged=${unionedSegments.length} (prevented segment loss)`);
          }
          return { ...road, segments: unionedSegments };
        });
      } else {
        merged[col] = mergeArrays(s[col], c[col]);
      }
    }
  }
  // Merge any unknown (custom/future) collections from both sides
  const allKeys = new Set([...Object.keys(s), ...Object.keys(c)]);
  for (const key of allKeys) {
    if (!ALL_COLLECTIONS.includes(key) && key !== 'deletedIds' && !merged.hasOwnProperty(key)) {
      const sa = Array.isArray(s[key]) ? s[key] : [];
      const ca = Array.isArray(c[key]) ? c[key] : [];
      if (sa.length > 0 || ca.length > 0) {
        merged[key] = mergeArrays(sa, ca);
        console.log(`[merge] Custom collection "${key}": server=${sa.length}, client=${ca.length} → merged=${merged[key].length}`);
      }
    }
  }
  // Bug 5 fix: run normalise functions on merged category records (same as explicit API writes)
  if (Array.isArray(merged.sweepCategories)) {
    merged.sweepCategories = merged.sweepCategories.map(normaliseSweepCategory);
  }
  if (Array.isArray(merged.categories)) {
    merged.categories = merged.categories.map(normaliseCategory);
  }
  if (Array.isArray(merged.clients)) {
    merged.clients = merged.clients.map(normaliseClient);
  }

  return merged;
}

// ── Tombstones ────────────────────────────────────────────────────────────────
function addTombstone(data, collection, id) {
  if (!Array.isArray(data.deletedIds)) data.deletedIds = [];
  if (!data.deletedIds.some(t => t.id === id))
    data.deletedIds.push({ id, collection, deletedAt: new Date().toISOString() });
}

function pruneTombstones(data) {
  if (!Array.isArray(data.deletedIds)) return;
  const cutoff = new Date(Date.now() - TOMBSTONE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  data.deletedIds = data.deletedIds.filter(t => t.deletedAt >= cutoff);
}

// applyTombstonesToClientData() removed in v71.5 — it used to strip any
// pushed record matching a server tombstone, which was the server-side half
// of auto-delete propagation. Manual deletes (addTombstone, pruneTombstones,
// the dashboard's Tombstones panel) are kept for the dashboard's own
// recently-deleted/restore UI, but they no longer affect what a push can add
// back to the server. See the v71.5 comment in the POST /sync handler.

// ── Cascade cleanup ──────────────────────────────────────────────────────────
/**
 * applyCascadeCleanup(data)
 *
 * Runs after EVERY write (sync merge, overwrite, import, direct delete).
 * Ensures referential integrity across collections so ghost IDs can never
 * accumulate on the server the way they did on the client.
 *
 * Rules enforced:
 *  1. reports[].inspectionIds  — strip any ID not in data.inspections
 *  2. inspections[].mapPins    — strip pins whose mapId is not in data.maps
 *  3. inspections[].mapId      — clear legacy single-pin field if that map is gone
 *
 * Returns { data, changed, details } so callers can log what was cleaned.
 */
function applyCascadeCleanup(data) {
  if (!data || typeof data !== 'object') return { data, changed: false, details: [] };

  const details = [];
  let changed = false;

  const inspectionIds = new Set((data.inspections || []).map(i => i.id).filter(Boolean));
  const mapIds        = new Set((data.maps        || []).map(m => m.id).filter(Boolean));
  // pinIds keyed by mapId — used below to catch stale pinId refs (map still
  // exists, but the specific pin was deleted/lost) which the old check missed.
  const pinIdsByMap = new Map((data.maps || []).map(m => [m.id, new Set((m.pins || []).map(p => p.id).filter(Boolean))]));

  // ── 1. reports → strip ghost inspectionIds ──────────────────────────────
  if (Array.isArray(data.reports)) {
    let ghostsRemoved = 0;
    data.reports = data.reports.map(report => {
      if (!Array.isArray(report.inspectionIds)) return report;
      const clean = report.inspectionIds.filter(id => inspectionIds.has(id));
      if (clean.length === report.inspectionIds.length) return report;
      const removed = report.inspectionIds.length - clean.length;
      ghostsRemoved += removed;
      console.log(`[cascade] report "${report.title || report.id}": removed ${removed} ghost inspectionId(s)`);
      return { ...report, inspectionIds: clean, updatedAt: new Date().toISOString() };
    });
    if (ghostsRemoved > 0) {
      changed = true;
      details.push(`reports: stripped ${ghostsRemoved} ghost inspection reference(s)`);
    }
  }

  // ── 2. inspections → strip mapPins whose mapId no longer exists ─────────
  if (Array.isArray(data.inspections)) {
    let ghostPinsRemoved = 0;
    let legacyCleared    = 0;
    data.inspections = data.inspections.map(insp => {
      let updated = { ...insp };
      let dirty   = false;

      // Multi-pin field
      if (Array.isArray(insp.mapPins)) {
        const clean = insp.mapPins
          .filter(mp => mp.mapId && mapIds.has(mp.mapId))
          // Ghost pinId: the map still exists but the specific pin doesn't
          // (e.g. lost during an old sync before the maps.pins union-merge fix).
          // Clear pinId rather than drop the whole entry — the snapshot image
          // and mapId link are still valid/useful even without a live pin.
          .map(mp => (mp.pinId && !pinIdsByMap.get(mp.mapId)?.has(mp.pinId)) ? { ...mp, pinId: '' } : mp);
        const pinIdsCleared = clean.filter((mp, i) => mp.pinId !== insp.mapPins[i]?.pinId).length;
        if (clean.length !== insp.mapPins.length || pinIdsCleared > 0) {
          const removed = insp.mapPins.length - clean.length;
          ghostPinsRemoved += removed + pinIdsCleared;
          console.log(`[cascade] inspection "${insp.title || insp.id}": removed ${removed} ghost mapPin(s), cleared ${pinIdsCleared} ghost pinId(s)`);
          updated.mapPins = clean;
          dirty = true;
        }
      }

      // Legacy single-pin fields (mapId / mapPinId / mapSnapshot)
      if (insp.mapId && !mapIds.has(insp.mapId)) {
        console.log(`[cascade] inspection "${insp.title || insp.id}": cleared legacy mapId "${insp.mapId}" (map deleted)`);
        updated.mapId       = '';
        updated.mapPinId    = '';
        updated.mapSnapshot = '';
        legacyCleared++;
        dirty = true;
      }

      if (dirty) { updated.updatedAt = new Date().toISOString(); }
      return dirty ? updated : insp;
    });
    if (ghostPinsRemoved > 0) {
      changed = true;
      details.push(`inspections: stripped ${ghostPinsRemoved} ghost mapPin reference(s)`);
    }
    if (legacyCleared > 0) {
      changed = true;
      details.push(`inspections: cleared legacy mapId on ${legacyCleared} inspection(s) (map deleted)`);
    }
  }

  return { data, changed, details };
}

// ── Backup helpers ────────────────────────────────────────────────────────────────
function getBackupTimestamp() {
  // Use LOCAL time so the filename matches the timezone set in TZ env var.
  // toISOString() always returns UTC — it ignores TZ completely.
  // Node's getFullYear()/getMonth()/etc. respect the TZ environment variable.
  // Include milliseconds so two backups in the same second get unique names.
  const d   = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ms  = String(d.getMilliseconds()).padStart(3, '0');
  const yr  = d.getFullYear();
  const mo  = pad(d.getMonth() + 1);
  const dy  = pad(d.getDate());
  const hr  = pad(d.getHours());
  const mn  = pad(d.getMinutes());
  const sc  = pad(d.getSeconds());
  return `${yr}-${mo}-${dy}_${hr}-${mn}-${sc}-${ms}`;
}

function buildManifest(data, driftKeys, reason) {
  const manifest = {
    version: PKG_VERSION,
    createdAt: new Date().toISOString(),
    reason: reason || 'unknown',
    collections: {},
    totalRecords: 0,
    tombstones: Array.isArray(data.deletedIds) ? data.deletedIds.length : 0,
    integrityHash: dataHash(data),
    driftKeysDetected: driftKeys || [],
  };
  for (const col of getAllKeys(data)) {
    const arr = Array.isArray(data[col]) ? data[col] : [];
    manifest.collections[col] = { count: arr.length, hash: collectionHash(arr) };
    manifest.totalRecords += arr.length;
  }
  return manifest;
}

function createBackup(reason) {
  const data = loadData();
  if (!data) { console.log('[backup] Skipped — no data'); return null; }

  const driftKeys = detectDrift(data);
  if (driftKeys.length > 0)
    console.log(`[backup] ℹ️  Extra/future keys included in backup: ${driftKeys.join(', ')}`);

  const manifest = buildManifest(data, driftKeys, reason);
  const filename  = `rsw-server-backup-${getBackupTimestamp()}.json`;
  const filepath  = path.join(BACKUP_DIR, filename);
  const payload   = { _manifest: manifest, ...data };

  try {
    fs.writeFileSync(filepath, JSON.stringify(payload), 'utf8');
    const sizeKb = Math.round(fs.statSync(filepath).size / 1024);
    console.log(`[backup] ✅ ${reason}: ${filename} (${manifest.totalRecords} records, ${sizeKb} KB)`);
    // Immediately enforce auto-delete limit after EVERY backup (manual or scheduled)
    runAutoDelete('post-backup');
    return filename;
  } catch (e) { console.error('[backup] ❌', e.message); return null; }
}

// Central auto-delete function — called after every backup AND on a timer.
// Always reads fresh settings so changes take effect immediately without restart.
function runAutoDelete(trigger) {
  try {
    const cfg = loadSettings();

    if (!cfg.autoDelete) {
      // Auto-delete OFF — only enforce the hard env cap (MAX_BACKUPS)
      const files = getBackupFiles();
      if (files.length > MAX_BACKUPS) {
        let removed = 0;
        files.slice(MAX_BACKUPS).forEach(f => {
          try { fs.unlinkSync(path.join(BACKUP_DIR, f)); removed++; } catch {}
        });
        if (removed > 0) console.log(`[backup] Hard-cap prune (${trigger}): removed ${removed}, keeping ${MAX_BACKUPS}`);
      }
      return;
    }

    const keepN = Math.max(1, Number(cfg.keepLastNAutoDelete) || 4);
    const files = getBackupFiles();

    console.log(`[backup] Auto-delete (${trigger}): ${files.length} backup(s) on disk, keeping last ${keepN}`);

    if (files.length <= keepN) {
      console.log(`[backup] Auto-delete (${trigger}): nothing to remove`);
      return;
    }

    let deleted = 0;
    files.slice(keepN).forEach(f => {
      try {
        fs.unlinkSync(path.join(BACKUP_DIR, f));
        deleted++;
        console.log(`[backup] Auto-delete: removed ${f}`);
      } catch (e) {
        console.error(`[backup] Auto-delete: failed to remove ${f}: ${e.message}`);
      }
    });
    console.log(`[backup] Auto-delete (${trigger}): done — kept ${keepN}, removed ${deleted}`);

  } catch (e) { console.error('[backup] Auto-delete error:', e.message); }
}

function getBackupFiles() {
  if (!fs.existsSync(BACKUP_DIR)) { fs.mkdirSync(BACKUP_DIR, { recursive: true }); return []; }
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('rsw-server-backup-') && f.endsWith('.json'))
    .sort().reverse(); // newest first
}

// Legacy aliases — kept for compatibility
function pruneAfterBackup()  { runAutoDelete('post-backup'); }
function pruneOldBackups()   { runAutoDelete('post-backup'); }

function listBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('rsw-server-backup-') && f.endsWith('.json'))
      .sort().reverse()
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        let manifest = null;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), 'utf8'));
          manifest = raw._manifest || null;
        } catch {}
        return { filename: f, size: stat.size, created: stat.mtime.toISOString(), manifest };
      });
  } catch { return []; }
}

function verifyBackup(filepath) {
  const result = { ok: true, errors: [], warnings: [], collections: {}, totalRecords: 0 };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) {
    result.ok = false;
    result.errors.push(`Cannot parse backup file: ${e.message}`);
    return result;
  }

  const manifest = raw._manifest || null;
  const dataOnly = { ...raw };
  delete dataOnly._manifest;

  if (manifest && manifest.integrityHash) {
    const recomputed = dataHash(dataOnly);
    if (recomputed !== manifest.integrityHash) {
      result.ok = false;
      result.errors.push(`Integrity hash mismatch — backup may be corrupted (stored: ${manifest.integrityHash}, computed: ${recomputed})`);
    }
  } else {
    result.warnings.push('No integrity hash found (pre-v2.0 backup) — skipping hash check');
  }

  for (const col of ALL_COLLECTIONS) {
    const arr = Array.isArray(dataOnly[col]) ? dataOnly[col] : null;
    const count = arr ? arr.length : 0;
    result.collections[col] = { present: arr !== null, count };
    result.totalRecords += count;
    if (arr === null) {
      result.warnings.push(`Collection "${col}" is absent from this backup`);
    }
    if (manifest && manifest.collections && manifest.collections[col]) {
      const storedHash = manifest.collections[col].hash;
      const liveHash   = collectionHash(arr || []);
      if (storedHash !== liveHash) {
        result.ok = false;
        result.errors.push(`Collection "${col}" hash mismatch — data may be corrupted`);
      }
    }
  }

  return result;
}

// Holds the active timer handles so we can restart without restarting Docker
let _backupTimer         = null;
let _autoDelTimer        = null;
let _postSyncBackupTimer = null; // debounced backup triggered 15s after data-changing syncs

// Bug 1 fix: schedule a backup 15s after any sync that changed data.
// Resets on each sync burst so rapid syncs create only one backup.
function schedulePostSyncBackup() {
  if (_postSyncBackupTimer) clearTimeout(_postSyncBackupTimer);
  _postSyncBackupTimer = setTimeout(() => {
    _postSyncBackupTimer = null;
    createBackup('post-sync');
    console.log('[backup] Post-sync backup created (data changed)');
  }, 15_000);
}

function startScheduledBackups() {
  const cfg = loadSettings();

  // ── Auto-backup timer ────────────────────────────────────────────────────
  if (_backupTimer) { clearInterval(_backupTimer); _backupTimer = null; }
  if (cfg.autoBackup) {
    const mins = Math.max(5, cfg.intervalMinutes || BACKUP_INTERVAL_MINUTES);
    const ms   = mins * 60 * 1000;
    const human = mins >= 1440 ? `${mins/1440}d` : mins >= 60 ? `${mins/60}h` : `${mins}min`;
    _backupTimer = setInterval(() => createBackup('scheduled'), ms);
    console.log(`[backup] Auto-backup ON — every ${mins} min (${human}) · next in ${human}`);
  } else {
    console.log('[backup] Auto-backup OFF');
  }

  // ── Auto-delete timer ────────────────────────────────────────────────────
  // Runs every 5 minutes when auto-delete is ON so it catches any backup
  // created by any means (manual, scheduled, pre-restore, import, etc.).
  // Also fires immediately so existing excess backups are removed straight away.
  if (_autoDelTimer) { clearInterval(_autoDelTimer); _autoDelTimer = null; }
  if (cfg.autoDelete) {
    const keepN = Math.max(1, cfg.keepLastNAutoDelete || 4);
    runAutoDelete('scheduler-start'); // Run immediately on start/settings-change
    _autoDelTimer = setInterval(() => runAutoDelete('scheduler-tick'), 5 * 60 * 1000);
    console.log(`[backup] Auto-delete ON — keeping last ${keepN} backup(s), checking every 5 min + after every backup`);
  } else {
    console.log('[backup] Auto-delete OFF');
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// /ping — unauthenticated liveness check for mobile connectivity detection
app.get('/ping', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, server: 'RSW Sync Server', timestamp: new Date().toISOString() });
});

app.get('/health', (_req, res) => {
  const data = loadData();
  let dataFileSize = 0, diskInfo = null;
  const backups = listBackups();
  try {
    if (fs.existsSync(DATA_FILE)) dataFileSize = fs.statSync(DATA_FILE).size;
    const { execSync } = require('child_process');
    const df = execSync(`df -k "${DATA_DIR}" 2>/dev/null | tail -1`, { timeout: 2000 }).toString().trim();
    const p = df.split(/\s+/);
    if (p.length >= 4) diskInfo = { total: p[1]*1024, used: p[2]*1024, available: p[3]*1024, percentage: Math.round(p[2]/p[1]*100) };
  } catch {}
  const counts = {};
  if (data) {
    for (const key of getAllKeys(data)) counts[key] = Array.isArray(data[key]) ? data[key].length : 0;
  }

  const driftKeys = data ? detectDrift(data) : [];
  if (driftKeys.length > 0)
    console.warn(`[health] ⚠️  Live data drift — unknown collection keys: ${driftKeys.join(', ')}`);

  const migrationReport = data ? inspectMigrations(data) : { needsMigration: false };

  // Tombstone summary — for the Health page's "Tombstones" panel.
  const tombstones = (data && Array.isArray(data.deletedIds)) ? data.deletedIds : [];
  const tombstoneCutoff = new Date(Date.now() - TOMBSTONE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const byCollection = {};
  let oldest = null;
  for (const t of tombstones) {
    byCollection[t.collection] = (byCollection[t.collection] || 0) + 1;
    if (!oldest || t.deletedAt < oldest) oldest = t.deletedAt;
  }

  res.json({
    status: 'ok', server: 'RSW Sync Server', version: PKG_VERSION,
    schemaVersion: APP_SCHEMA_VERSION,
    hasData: !!data, dataHash: data ? dataHash(data) : null, dataFileSize,
    collections: counts,
    disk: diskInfo,
    backup: (() => {
      const cfg = loadSettings();
      return {
        intervalMinutes: cfg.intervalMinutes,
        maxBackups:      cfg.maxBackups,
        autoBackup:      cfg.autoBackup,
        autoDelete:      cfg.autoDelete,
        keepLastNAutoDelete: cfg.keepLastNAutoDelete,
        count:           backups.length,
        latest:          backups[0] || null,
      };
    })(),
    files: { count: listUploadedFiles().length, uploadsDir: UPLOADS_DIR },
    customCollections: loadCustomCollections(),
    drift: { unknownKeys: driftKeys, hasUnknownKeys: driftKeys.length > 0 },
    migration: migrationReport,
    tombstones: {
      count: tombstones.length,
      byCollection,
      oldest,
      retentionDays: TOMBSTONE_DAYS,
      olderThanRetention: tombstones.filter(t => t.deletedAt < tombstoneCutoff).length,
    },
    timestamp: new Date().toISOString(),
  });
});

app.get('/sync', requireAuth, (_req, res) => {
  const data = loadData();
  if (!data) return res.status(404).json({ error: 'No data yet. Push from a device first.' });
  res.json({ data, deletedIds: data.deletedIds || [], hash: dataHash(data), timestamp: new Date().toISOString() });
});

app.post('/sync', requireAuth, (req, res) => {
  const { data: clientData, mode } = req.body;
  if (!clientData) return res.status(400).json({ error: 'Missing data.' });
  if (!isValidAppData(clientData)) return res.status(400).json({ error: 'Invalid data format.' });

  const driftKeys = detectDrift(clientData);
  // Drift keys are NOW fully preserved in normaliseData — no action needed.
  // Log only for informational purposes so operators can optionally add to ALL_COLLECTIONS.
  if (driftKeys.length > 0)
    console.log(`[sync] ℹ️  Client sent future/custom collection keys (preserved): ${driftKeys.join(', ')}`);

  const serverData = loadData();

  // v71.5: Push & Sync no longer strips records that match a server-side
  // tombstone before merging. Auto-delete propagation has been removed — a
  // manual delete on the server (via the dashboard) or on the app only ever
  // affects that one side now. If a device still has a record locally and
  // pushes it, that record is restored to the server backups, the same as
  // any other push adds/updates a record. This is the intended "undo" path:
  // Pull & Merge asks the user whether to keep or discard a record that's
  // missing from the server, and choosing "keep" is what allows a follow-up
  // push to restore it here. (See src/store.tsx pullFromServer / v71.5.)
  let merged;
  if (!serverData || mode === 'overwrite') {
    merged = normaliseData(clientData);
  } else {
    merged = mergeData(serverData, clientData);
    merged.deletedIds = serverData.deletedIds || [];
  }
  pruneTombstones(merged);

  // Apply schema migrations to newly merged data
  const { data: migratedMerged, migrated, details } = applyMigrations(merged);
  if (migrated) {
    console.log(`[sync] Schema migration applied during sync: ${details.join('; ')}`);
  }

  // Cascade cleanup: strip ghost inspectionIds from reports, ghost mapPins from inspections
  const { data: cascadedMerge, changed: cascadeChanged, details: cascadeDetails } = applyCascadeCleanup(migratedMerged);
  if (cascadeChanged) {
    console.log(`[sync] Cascade cleanup: ${cascadeDetails.join('; ')}`);
  }

  try { saveData(cascadedMerge); }
  catch (e) { return res.status(500).json({ error: 'Save failed: ' + e.message }); }

  // Bug 1 fix: schedule a backup shortly after any sync that actually changed data
  schedulePostSyncBackup();

  const hash = dataHash(cascadedMerge);
  const response = {
    success: true, data: cascadedMerge, deletedIds: cascadedMerge.deletedIds || [],
    hash, timestamp: new Date().toISOString(), mode: mode || 'merge',
    schemaVersion: APP_SCHEMA_VERSION,
  };
  if (driftKeys.length > 0) response.info = [`Future/custom collection keys preserved: ${driftKeys.join(', ')}`];
  if (migrated) response.migrationApplied = details;
  if (cascadeChanged) response.cascadeCleanup = cascadeDetails;
  console.log(`[${new Date().toISOString()}] Sync ${mode || 'merge'} hash:${hash}`);
  res.json(response);
});

// ── Diagnostic endpoint — SW Categories item summary ──────────────────────────
// GET /debug/sweep-categories  — returns a summary of every sweepCategory record:
// name, categoryType, item count, and the first 5 item names.  Useful for verifying
// that items from the app have been correctly merged onto the server.
app.get('/debug/sweep-categories', requireAuth, (req, res) => {
  const data = loadData();
  if (!data) return res.json({ error: 'No data on server.' });
  const cats = Array.isArray(data.sweepCategories) ? data.sweepCategories : [];
  const summary = cats.map(c => ({
    id:           c.id,
    name:         c.name,
    categoryType: c.categoryType || '(none)',
    itemCount:    Array.isArray(c.items) ? c.items.length : '(no items field)',
    items:        Array.isArray(c.items) ? c.items.slice(0, 5).map(i => i.name) : [],
    updatedAt:    c.updatedAt,
  }));
  res.json({ total: cats.length, sweepCategories: summary });
});

// ── Road Select data endpoint (v73.12+) ──────────────────────────────────────
// Returns the road ways within a bounding box from the self-hosted OSM
// extract (roads.geojson) for Areas & Roads → Edit Road's "Select Roads"
// mode. Static reference data — no relation to /data/:collection or AppData.
app.get('/api/roads', requireAuth, (req, res) => {
  const bboxStr = String(req.query.bbox || '');
  const parts = bboxStr.split(',').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
    return res.status(400).json({ error: 'bbox query param required as minLng,minLat,maxLng,maxLat' });
  }
  const [minLng, minLat, maxLng, maxLat] = parts;
  if (roadIndex.error === 'not-found') {
    return res.json({ type: 'FeatureCollection', features: [], meta: { loaded: false, reason: 'roads.geojson not found on server — see extract-roads.sh' } });
  }
  // v73.20: car parks/driveways/business service lanes are tagged 'service'
  // in the index (see classifyRoadFeature) and excluded by default — set
  // ?includeServiceLanes=1 to include them too, for the cases Craig
  // described where a crew genuinely needs to sweep that kind of area.
  const includeServiceLanes = ['1', 'true', 'yes'].includes(String(req.query.includeServiceLanes || '').toLowerCase());
  // v73.43: roads named "... Lane" are tagged 'lane' (see classifyRoadFeature)
  // and excluded by default the same way — set ?includeLanes=1 to include
  // them. A separate toggle from includeServiceLanes since these are two
  // unrelated exclusion reasons (one's a car park/driveway by OSM tag, this
  // one's an ordinary public street excluded purely by naming convention) —
  // a crew may want one included without the other.
  const includeLanes = ['1', 'true', 'yes'].includes(String(req.query.includeLanes || '').toLowerCase());
  // v73.53: three more independent opt-in toggles, same pattern as the two
  // above — each one only affects its own category, so a crew can include
  // any combination without pulling in the others.
  const includeParkingAisles = ['1', 'true', 'yes'].includes(String(req.query.includeParkingAisles || '').toLowerCase());
  const includeServiceRoads = ['1', 'true', 'yes'].includes(String(req.query.includeServiceRoads || '').toLowerCase());
  const includeLivingStreets = ['1', 'true', 'yes'].includes(String(req.query.includeLivingStreets || '').toLowerCase());
  const allMatches = queryRoadsInBbox(minLng, minLat, maxLng, maxLat);
  const matches = allMatches.filter(f =>
    f.category === 'road' ||
    (f.category === 'service' && includeServiceLanes) ||
    (f.category === 'lane' && includeLanes) ||
    (f.category === 'parkingaisle' && includeParkingAisles) ||
    (f.category === 'serviceroad' && includeServiceRoads) ||
    (f.category === 'livingstreet' && includeLivingStreets)
  );
  // Cap response size defensively — a huge bbox at low zoom shouldn't try to
  // ship the whole region; the client re-queries as the user zooms/pans in.
  const MAX_ROADS_PER_REQUEST = 2000;
  const capped = matches.slice(0, MAX_ROADS_PER_REQUEST);
  res.json({
    type: 'FeatureCollection',
    meta: { loaded: true, totalInView: matches.length, returned: capped.length, truncated: matches.length > MAX_ROADS_PER_REQUEST, loadedAt: roadIndex.loadedAt, includeServiceLanes, includeLanes, includeParkingAisles, includeServiceRoads, includeLivingStreets },
    features: capped.map(f => ({
      type: 'Feature',
      id: f.id,
      properties: { id: f.id, name: f.name, category: f.category },
      geometry: { type: 'LineString', coordinates: f.coords },
    })),
  });
});

// Lets the dashboard (or a manual curl) trigger a re-read of roads.geojson
// without restarting the container, e.g. after copying a refreshed extract in.
app.post('/api/roads/reload', requireAuth, (_req, res) => {
  reloadRoadIndex();
  res.json({ ok: true, loaded: roadIndex.error !== 'not-found' && !roadIndex.error, featureCount: roadIndex.features.length, error: roadIndex.error });
});

// v73.57 — status for the dashboard's Road Data card: current index state
// plus the last Overpass auto-update attempt/result (persisted to disk so
// it survives a container restart, not just kept in memory).
app.get('/api/roads/status', requireAuth, (_req, res) => {
  const meta = loadRoadsUpdateMeta();
  res.json({
    loaded: roadIndex.error !== 'not-found' && !roadIndex.error,
    featureCount: roadIndex.features.length,
    loadedAt: roadIndex.loadedAt,
    error: roadIndex.error,
    bboxConfigured: !!ROADS_BBOX,
    bbox: ROADS_BBOX || null,
    overpassUrl: OVERPASS_URL,
    updateInProgress: roadsUpdateInProgress,
    lastUpdate: meta,
  });
});

// v73.57 — one-click auto-update: fetches fresh road geometry for the
// configured (or request-overridden) bbox from the Overpass API and
// reloads it, replacing the extract-roads.sh + scp/docker-cp/reload-curl
// manual sequence for the common case of "just refresh my existing area."
app.post('/api/roads/update-osm', requireAuth, async (req, res) => {
  if (roadsUpdateInProgress) {
    return res.status(409).json({ ok: false, error: 'An update is already in progress' });
  }
  roadsUpdateInProgress = true;
  const meta = loadRoadsUpdateMeta();
  meta.lastAttempt = new Date().toISOString();
  saveRoadsUpdateMeta(meta);
  try {
    const bboxOverride = typeof req.body?.bbox === 'string' ? req.body.bbox : undefined;
    const result = await updateRoadsFromOverpass(bboxOverride);
    meta.lastSuccess = new Date().toISOString();
    meta.lastError = null;
    meta.lastFeatureCount = result.featureCount;
    meta.source = result.source;
    meta.bbox = result.bbox;
    saveRoadsUpdateMeta(meta);
    res.json({ ok: true, ...result, loadedAt: roadIndex.loadedAt });
  } catch (e) {
    // v73.58: Node's fetch() collapses DNS/network failures into a bare
    // "fetch failed" with the real reason buried in e.cause (undici's
    // underlying error) — surface that instead of the useless top message.
    const detail = e.cause?.message || e.cause?.code || null;
    const fullMessage = detail ? `${e.message} (${detail})` : e.message;
    meta.lastError = fullMessage;
    saveRoadsUpdateMeta(meta);
    console.error('[roads] Overpass update failed:', fullMessage);
    res.status(500).json({ ok: false, error: fullMessage });
  } finally {
    roadsUpdateInProgress = false;
  }
});

// v73.34 — real road-network routing between two points, so Select
// Roads/Lasso's "flight line" connector between two selected pieces that
// don't actually touch can follow real streets instead of cutting straight
// across blocks/houses. See buildLocalRoadGraph/dijkstraPath above for how.
// v73.79 — Craig: gap-bridging between selected road pieces was still
// pure road-data graph routing (buildLocalRoadGraph/dijkstraPath), which
// can legitimately follow a divided road's wrong parallel carriageway or
// an adjacent service lane — that's what was reading as "duplicate
// lines/extra points" in Select Roads/Lasso mode. Try OSRM's real
// routing first (same engine Snap to Roads uses, follows actual
// driveable roads correctly); only fall back to the local road-data
// graph if OSRM is unreachable/unconfigured/times out.
const OSRM_URL = process.env.OSRM_URL || 'http://osrm:5000';
const OSRM_CONNECT_TIMEOUT_MS = 4000;
// v73.101 — Craig: extend the turnaround-radius hint (v73.100, previously
// /match only) to /api/roads/connect's gap-fill routing too — his own
// screenshot showed both a dead-end tip AND a T-junction rejoin needing
// help, and gap-fill (this function) is what actually runs for a Select
// Roads/Lasso selection with a gap, not /match. Deliberately opt-in per
// point, not a blanket radius change: only a gap endpoint that falls within
// TURNAROUND_HINT_RADIUS_METRES of a marker Craig has actually placed gets
// tightened — every other gap endpoint keeps OSRM's own default snap
// behaviour exactly as before, so nothing changes for the vast majority of
// dead-end streets that have no marker on them at all. When `turnarounds`
// is empty (the default/no-markers-placed case), no `radiuses` param is
// sent at all — byte-identical request to pre-v73.101 behaviour.
// v73.104 — Craig: a radius hint only narrows where OSRM SNAPS the from/to
// points themselves — it never stops OSRM choosing a completely different,
// unwanted road in between to actually connect them, which was the real
// complaint ("stop OSRM choosing extra unwanted roads to reach the far
// side"). OSRM's own /route endpoint accepts any number of ;-separated
// coordinates as MANDATORY via-points the route must pass through in
// order — tryOsrmConnect now includes, as literal via-coordinates (not
// just a radius nudge), every turnaround marker within
// TURNAROUND_HINT_RADIUS_METRES of EITHER gap endpoint (from or to) — i.e.
// only markers Craig actually placed near this specific gap, sorted by
// distance from `from` so OSRM visits them in a sensible order. A gap with
// no nearby turnaround still sends the exact same 2-point request as
// before this release (empty vias -> coordParts is just from;to, no
// radiuses param) — nothing changes unless a marker is actually near this
// gap, same "opt-in per gap" guarantee v73.101 established for the
// radius-hint version this replaces.
const OSRM_CONNECT_DEFAULT_RADIUS_METRES = 25;
function connectPointRadius(lng, lat, turnarounds) {
  const near = (turnarounds || []).some(t => haversineMetres(lat, lng, t.lat, t.lng) <= TURNAROUND_HINT_RADIUS_METRES);
  return near ? TURNAROUND_MATCH_RADIUS_METRES : OSRM_CONNECT_DEFAULT_RADIUS_METRES;
}
async function tryOsrmConnect(fromLng, fromLat, toLng, toLat, turnarounds = []) {
  const nearFrom = (turnarounds || []).filter(t => haversineMetres(fromLat, fromLng, t.lat, t.lng) <= TURNAROUND_HINT_RADIUS_METRES);
  const nearTo = (turnarounds || []).filter(t => haversineMetres(toLat, toLng, t.lat, t.lng) <= TURNAROUND_HINT_RADIUS_METRES);
  // De-dupe (a marker close enough to count as "near" both from and to —
  // e.g. a very short gap — only needs to appear once in the via list) and
  // order by distance from `from` so OSRM is asked to visit them in a
  // sensible sequence rather than whatever order they happened to be
  // placed in.
  const viaMap = new Map();
  [...nearFrom, ...nearTo].forEach(t => viaMap.set(`${t.lat},${t.lng}`, t));
  const vias = Array.from(viaMap.values()).sort(
    (a, b) => haversineMetres(fromLat, fromLng, a.lat, a.lng) - haversineMetres(fromLat, fromLng, b.lat, b.lng)
  );
  const coordParts = [`${fromLng},${fromLat}`, ...vias.map(v => `${v.lng},${v.lat}`), `${toLng},${toLat}`];
  const radiusParts = (turnarounds && turnarounds.length > 0)
    ? [connectPointRadius(fromLng, fromLat, turnarounds), ...vias.map(() => TURNAROUND_MATCH_RADIUS_METRES), connectPointRadius(toLng, toLat, turnarounds)]
    : null;
  const radiusParam = radiusParts ? `&radiuses=${radiusParts.join(';')}` : '';
  const url = `${OSRM_URL}/route/v1/driving/${coordParts.join(';')}?geometries=geojson&overview=full${radiusParam}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OSRM_CONNECT_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) return { ok: false, reason: `osrm-http-${r.status}` };
    const data = await r.json();
    if (data.code !== 'Ok' || !Array.isArray(data.routes) || data.routes.length === 0) {
      return { ok: false, reason: data.code || 'osrm-no-route' };
    }
    const coords = data.routes[0].geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return { ok: false, reason: 'osrm-empty-geometry' };
    return { ok: true, coords };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'osrm-timeout' : (e.message || 'osrm-error') };
  } finally {
    clearTimeout(timer);
  }
}

app.get('/api/roads/connect', requireAuth, async (req, res) => {
  const fromLng = Number(req.query.fromLng), fromLat = Number(req.query.fromLat);
  const toLng = Number(req.query.toLng), toLat = Number(req.query.toLat);
  if (![fromLng, fromLat, toLng, toLat].every(Number.isFinite)) {
    return res.status(400).json({ error: 'fromLng, fromLat, toLng, toLat query params all required' });
  }
  const includeFlags = parseIncludeFlags(req.query);
  // v73.101 — optional turnaround markers, same shape/parsing as /match's
  // body param (see below), just JSON-encoded in a query string here since
  // this is a GET endpoint. Malformed/missing param -> empty array, i.e.
  // identical behaviour to before this feature existed.
  let turnarounds = [];
  if (typeof req.query.turnarounds === 'string' && req.query.turnarounds) {
    try {
      const parsed = JSON.parse(req.query.turnarounds);
      if (Array.isArray(parsed)) {
        turnarounds = parsed.filter(t => typeof t?.lat === 'number' && typeof t?.lng === 'number');
      }
    } catch { /* malformed param — fall back to no turnaround hint, don't error the request */ }
  }
  const osrmResult = await tryOsrmConnect(fromLng, fromLat, toLng, toLat, turnarounds);
  if (osrmResult.ok) {
    // v73.81: OSRM has no idea about the Include Service Road/Lanes/Parking
    // Aisle checkboxes — check its route against the same classification the
    // selectable-roads list uses, and fall through to the road-data graph
    // (which already only ever returns category === 'road') if it ran
    // through a class the caller didn't ask to include.
    const excludedCheck = checkRouteAgainstExcludedClasses(osrmResult.coords, includeFlags);
    if (!excludedCheck.rejected) {
      return res.json({ found: true, coords: osrmResult.coords, via: 'osrm' });
    }
    console.warn(`[roads/connect] OSRM route rejected: ${(excludedCheck.fraction * 100).toFixed(0)}% of points / ~${excludedCheck.excludedMetres}m ran through an excluded road class not checked "include" (${excludedCheck.excludedHits}/${excludedCheck.checked})${excludedCheck.unmappedRejected ? `, plus ${(excludedCheck.unmappedFraction * 100).toFixed(0)}% / ~${excludedCheck.unmappedMetres}m through roads not in roads.geojson at all (${excludedCheck.unmappedHits} pts)` : ''}, falling back to road-data graph`);
  } else {
    console.warn(`[roads/connect] OSRM routing failed (${osrmResult.reason}), falling back to road-data graph`);
  }
  if (roadIndex.error === 'not-found' || roadIndex.error) {
    return res.json({ found: false, reason: 'roads-not-loaded' });
  }
  const straightLineMetres = haversineMetres(fromLat, fromLng, toLat, toLng);
  // Pad the search bbox generously beyond the straight-line gap — a real
  // route is very often longer than the direct distance (has to go around
  // a block), but an unbounded pad risks pulling in a huge, slow graph for
  // a large gap. Floor keeps small gaps from getting a bbox too tiny to
  // include any actual intersecting cross-street; cap bounds worst-case
  // graph size for a very large, likely-unroutable gap.
  const padMetres = Math.min(Math.max(straightLineMetres * 1.5, 300), 3000);
  const padDegLat = padMetres / 111320;
  const padDegLng = padMetres / (111320 * Math.cos(((fromLat + toLat) / 2) * Math.PI / 180));
  const minLng = Math.min(fromLng, toLng) - padDegLng, maxLng = Math.max(fromLng, toLng) + padDegLng;
  const minLat = Math.min(fromLat, toLat) - padDegLat, maxLat = Math.max(fromLat, toLat) + padDegLat;
  // v73.107 — Craig, full OSRM/road-data audit: this fallback graph was
  // hardcoded to `category === 'road'` only, completely ignoring the
  // Include Service Roads/Lanes/Parking Aisles/Living Streets flags that
  // OSRM's own path (tryOsrmConnect above, via checkRouteAgainstExcludedClasses)
  // already respects. Whenever OSRM failed or got rejected and this local
  // Dijkstra fallback ran instead, any selection that legitimately included
  // one of those road classes silently lost it here — the fallback could
  // only ever route through plain 'road' ways, either finding no path at
  // all through a road Craig explicitly asked to include, or routing around
  // it via a real but unintended detour. Same includeFlags parsed above for
  // the OSRM leg now gate this local graph's road pool too, so both paths
  // agree on what's actually selectable.
  const localFeatures = queryRoadsInBbox(minLng, minLat, maxLng, maxLat).filter(f =>
    f.category === 'road' ||
    (f.category === 'service' && includeFlags.service) ||
    (f.category === 'lane' && includeFlags.lane) ||
    (f.category === 'parkingaisle' && includeFlags.parkingaisle) ||
    (f.category === 'serviceroad' && includeFlags.serviceroad) ||
    (f.category === 'livingstreet' && includeFlags.livingstreet)
  );
  if (localFeatures.length === 0) return res.json({ found: false, reason: 'no-roads-in-area' });
  const graph = buildLocalRoadGraph(localFeatures);
  // Snap tolerance: generous enough for a selected road's endpoint to not
  // sit exactly on a graph node (floating point / slightly different
  // extract vintage), tight enough to not snap onto a clearly wrong,
  // distant node instead of correctly reporting "not close enough."
  const SNAP_TOLERANCE_METRES = 40;
  const startKey = snapToNearestNode(graph, fromLng, fromLat, SNAP_TOLERANCE_METRES);
  const endKey = snapToNearestNode(graph, toLng, toLat, SNAP_TOLERANCE_METRES);
  if (!startKey || !endKey) return res.json({ found: false, reason: 'no-nearby-road-node' });
  const path = dijkstraPath(graph, startKey, endKey);
  if (!path) return res.json({ found: false, reason: 'no-path-in-local-area' });
  const coords = path.map(key => { const n = graph.nodes.get(key); return [n.lng, n.lat]; });
  res.json({ found: true, coords, via: 'road-data' });
});

// v73.69 — "Snap to Roads": sends a whole hand-drawn/Select-Roads trace to
// OSRM's /match, which finds the most probable real-road path the points
// were meant to follow and corrects GPS/click wander onto it — this is the
// thing Simplify Points/Find Long Jumps/Find Duplicate Lines were all
// separately, imperfectly working around (see v73.66/73.68 comments above).
// POST body (not GET query) because a real segment easily has 1000+ points,
// too long for a URL — OSRM's own HTTP API is GET-only with coordinates in
// the URL path, so this endpoint batches internally and stitches the
// results back into one continuous point list.
// OSRM has no hard coordinate-count limit by default, but a very long URL
// risks hitting proxy/server URL-length limits well before that — batching
// keeps each request small and fast regardless of segment size. Batches
// overlap by 1 point so the stitched result has no gap at the seam.
const OSRM_MATCH_BATCH_SIZE = 100;
// v73.100 — Turnaround Points: optional `turnarounds: [{lat,lng}, ...]` in the
// request body (a segment's independent end-of-road markers — see
// TurnaroundPoint in the app's types.ts, never part of the `points` path
// itself). For any batch point that falls within TURNAROUND_HINT_RADIUS_METRES
// of a turnaround, its per-point OSRM radius is tightened from the default
// 25m down to this much smaller value — the same "radiuses" mechanism
// v73.79's comment above already explains, just applied more tightly at the
// specific spots Craig has told the app are a genuine dead-end/road-end,
// rather than uniformly everywhere. This directly reduces the "OSRM snapped
// onto/past the wrong nearby road at a dead end" case the feature exists for.
const TURNAROUND_MATCH_RADIUS_METRES = 5;
const TURNAROUND_HINT_RADIUS_METRES = 60; // how far a batch point can be from a turnaround and still get the tightened radius
app.post('/api/roads/match', requireAuth, async (req, res) => {
  const points = Array.isArray(req.body?.points) ? req.body.points : null;
  if (!points || points.length < 2) {
    return res.status(400).json({ error: 'body must be { points: [{lat, lng}, ...] } with at least 2 points' });
  }
  const turnarounds = Array.isArray(req.body?.turnarounds)
    ? req.body.turnarounds.filter(t => typeof t?.lat === 'number' && typeof t?.lng === 'number')
    : [];
  const includeFlags = parseIncludeFlags(req.body || {});
  let excludedRoadRejections = 0;
  // v73.85 — Craig, screenshots: "still having the same issue... extra
  // lines and points being added [by Add to Segment]... then being
  // cleaned up after using Snap to Roads." Traced it: TWO other silent
  // per-batch raw-fallback paths already existed below (OSRM returning
  // "NoMatch"/similar for a batch, and the 2.5x length-ratio sanity
  // check) but were never counted or surfaced — only the excluded-road
  // rejection (added v73.81) was ever reported back. A big multi-street
  // selection splits into ~1 OSRM call per 100 points; it's entirely
  // plausible several of those silently fell back to raw on the very
  // first Add to Segment call, with the response still saying `ok:
  // true` and the UI showing a plain "Auto-snapped" success message —
  // exactly matching scattered loopy artifacts inside an otherwise-clean
  // route, and exactly why a later manual Snap to Roads call (different
  // batch boundaries, since the whole committed segment is a different
  // length/shape than just the fresh addition) can come out cleaner.
  // Counting and reporting all three now — this doesn't yet fix why any
  // individual batch fails, but makes every raw fallback visible instead
  // of hidden behind a false "success" message, which is the necessary
  // next diagnostic step before chasing why a specific batch fails.
  let noMatchBatches = 0;
  let lengthRatioRejections = 0;
  try {
    const matched = [];
    for (let start = 0; start < points.length - 1; start += OSRM_MATCH_BATCH_SIZE - 1) {
      const batch = points.slice(start, start + OSRM_MATCH_BATCH_SIZE);
      if (batch.length < 2) break;
      const coordStr = batch.map(p => `${p.lng},${p.lat}`).join(';');
      // v73.79 — Craig: after Snap to Roads, an extra road appears in the
      // bottom-right that was never selected (see screenshots). Root cause:
      // OSRM's /match was given no search radius per point, so on a batch
      // seam near two close-together parallel roads it could snap onto the
      // WRONG one entirely and then happily "match" a long detour along it
      // — no signal that anything went wrong because OSRM itself considered
      // it a confident match. `radiuses` caps how far (metres) OSRM is
      // allowed to look for each point before giving up, which prevents it
      // from ever jumping to a road that isn't actually near what was
      // selected/drawn.
      const OSRM_MATCH_RADIUS_METRES = 25;
      // v73.100 — per-point override: any batch point within
      // TURNAROUND_HINT_RADIUS_METRES of a turnaround marker gets the much
      // tighter TURNAROUND_MATCH_RADIUS_METRES instead of the uniform
      // default, so OSRM can't drift onto a nearby-but-wrong road right at
      // the spot Craig has explicitly marked as the road end.
      const radiusesStr = batch.map(p => {
        const nearTurnaround = turnarounds.some(t => haversineMetres(p.lat, p.lng, t.lat, t.lng) <= TURNAROUND_HINT_RADIUS_METRES);
        return nearTurnaround ? TURNAROUND_MATCH_RADIUS_METRES : OSRM_MATCH_RADIUS_METRES;
      }).join(';');
      const url = `${OSRM_URL}/match/v1/driving/${coordStr}?geometries=geojson&overview=full&radiuses=${radiusesStr}`;
      const r = await fetch(url);
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`OSRM /match returned ${r.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
      }
      const data = await r.json();
      const useRawBatch = () => {
        batch.forEach((p, i) => { if (start === 0 || i > 0) matched.push([p.lng, p.lat]); });
      };
      if (data.code !== 'Ok' || !Array.isArray(data.matchings) || data.matchings.length === 0) {
        // v73.69: a batch with points too far from any road, or too sparse
        // for OSRM to confidently match, comes back as e.g. "NoMatch" — fall
        // back to keeping this batch's original points unsnapped rather
        // than failing the whole segment, so one bad stretch (e.g. a
        // carpark) doesn't block snapping the rest of a long segment.
        console.warn(`[roads/match] rejecting batch at ${start}: OSRM returned "${data.code}" (no usable match), using raw points`);
        noMatchBatches++;
        useRawBatch();
        continue;
      }
      // v73.79 — sanity check: a valid snap should track roughly the same
      // distance as what was actually selected/drawn. A batch that jumped
      // onto an unintended parallel/detour road comes back MUCH longer
      // (Craig's repro was ~6.7x) even though OSRM reported "Ok" — reject
      // that batch's match and fall back to its raw points instead of
      // silently splicing in a road nobody selected.
      const rawBatchMetres = batch.slice(1).reduce((sum, p, i) => sum + haversineMetres(batch[i].lat, batch[i].lng, p.lat, p.lng), 0);
      const matchedBatchMetres = data.matchings.reduce((sum, m) => sum + (m.distance || 0), 0);
      const MAX_MATCH_LENGTH_RATIO = 2.5;
      if (rawBatchMetres > 5 && matchedBatchMetres > rawBatchMetres * MAX_MATCH_LENGTH_RATIO) {
        console.warn(`[roads/match] rejecting batch at ${start}: matched ${matchedBatchMetres.toFixed(0)}m vs raw ${rawBatchMetres.toFixed(0)}m (${(matchedBatchMetres / rawBatchMetres).toFixed(1)}x) — likely wrong-road detour, using raw points`);
        lengthRatioRejections++;
        useRawBatch();
        continue;
      }
      // v73.81 — Craig: "service road added when the option was off." A
      // batch can be a perfectly reasonable LENGTH (passes the check above)
      // and still run down a road class the caller has excluded, since OSRM
      // itself has no concept of the app's Include checkboxes. Check every
      // matched point in this batch against the same road-data
      // classification the selectable-roads list uses, and fall back to
      // this batch's raw points if a meaningful share of it sits on an
      // excluded class the caller didn't ask to include.
      const batchExcludedCheck = checkRouteAgainstExcludedClasses(
        data.matchings.flatMap(m => m.geometry.coordinates), includeFlags
      );
      if (batchExcludedCheck.rejected) {
        console.warn(`[roads/match] rejecting batch at ${start}: ${(batchExcludedCheck.fraction * 100).toFixed(0)}% / ~${batchExcludedCheck.excludedMetres}m of matched points ran through an excluded road class not checked "include" (${batchExcludedCheck.excludedHits}/${batchExcludedCheck.checked})${batchExcludedCheck.unmappedRejected ? `, plus ${(batchExcludedCheck.unmappedFraction * 100).toFixed(0)}% / ~${batchExcludedCheck.unmappedMetres}m through roads not in roads.geojson at all (${batchExcludedCheck.unmappedHits} pts)` : ''}, using raw points`);
        excludedRoadRejections++;
        useRawBatch();
        continue;
      }
      // Multiple "matchings" happens when OSRM finds a gap it can't bridge
      // within this batch — concatenate all of them in order, since each is
      // still a valid snapped sub-path and dropping the gap silently would
      // lose real distance/coverage.
      data.matchings.forEach((m, mi) => {
        const coords = m.geometry.coordinates;
        // Drop the first coordinate of every batch after the first (it
        // duplicates the previous batch's last point, the 1-point overlap).
        coords.forEach((c, ci) => { if (start === 0 && mi === 0 || ci > 0) matched.push(c); });
      });
    }
    // v73.70 (ported into this branch at v73.72) — Craig: the app froze/hung
    // after Snap to Roads on a 1213-point segment came back as 4191 (a
    // ~3.5x jump). OSRM's matched geometry follows every real OSM way
    // vertex, denser than a hand-drawn/Select-Roads path — most of that
    // density is genuinely redundant (near-straight runs with a vertex
    // every few metres). Unlike the client's existing simplifyPath()
    // (Douglas-Peucker, meant for imprecise hand-drawn points and can cut
    // real corners), this is safe to prune more simply: OSRM's points
    // already sit exactly ON the real road, so dropping a point within
    // ~0.5m of the straight line between its neighbours removes redundant
    // density without moving the path at all. Endpoints always kept.
    const pruneCollinear = (coords) => {
      if (coords.length < 3) return coords;
      const toXY = ([lng, lat]) => ({ x: lng * 111320 * Math.cos((lat * Math.PI) / 180), y: lat * 111320 });
      const distToSeg = (p, a, b) => {
        const dx = b.x - a.x, dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy;
        let t = lenSq > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq : 0;
        t = Math.max(0, Math.min(1, t));
        const cx = a.x + t * dx, cy = a.y + t * dy;
        return Math.hypot(p.x - cx, p.y - cy);
      };
      const out = [coords[0]];
      let anchor = toXY(coords[0]);
      for (let i = 1; i < coords.length - 1; i++) {
        const p = toXY(coords[i]);
        const next = toXY(coords[i + 1]);
        if (distToSeg(p, anchor, next) > 0.5) { out.push(coords[i]); anchor = p; }
      }
      out.push(coords[coords.length - 1]);
      return out;
    };
    const pruned = pruneCollinear(matched);
    if (pruned.length < 2) {
      return res.json({ ok: false, reason: 'no-match', message: 'OSRM could not match this trace to any roads.' });
    }
    const rawFallbackBatches = noMatchBatches + lengthRatioRejections + excludedRoadRejections;
    res.json({
      ok: true,
      points: pruned.map(([lng, lat]) => ({ lat, lng })),
      before: points.length,
      after: pruned.length,
      excludedRoadRejections,
      noMatchBatches,
      lengthRatioRejections,
      rawFallbackBatches, // v73.85 — total across all three reasons, so the client can show one honest "N stretches weren't actually snapped" figure instead of only ever seeing the excluded-road subset
    });
  } catch (e) {
    const detail = e.cause?.message || e.cause?.code || null;
    const fullMessage = detail ? `${e.message} (${detail})` : e.message;
    console.error('[roads/match] OSRM match failed:', fullMessage);
    res.status(502).json({ ok: false, error: fullMessage });
  }
});

app.get('/status', requireAuth, (req, res) => {
  const data = loadData();
  if (!data) return res.json({ changed: false, hasData: false });
  const h = dataHash(data);
  res.json({ changed: req.query.hash !== h, hash: h, hasData: true });
});

app.get('/collections', requireAuth, (_req, res) => {
  const data = loadData();
  const allKeys = getAllKeys(data || {});
  const counts = {};
  for (const key of allKeys) counts[key] = data && Array.isArray(data[key]) ? data[key].length : 0;
  const extraKeys = allKeys.filter(k => !ALL_COLLECTIONS.includes(k));
  const driftKeys = data ? detectDrift(data) : [];
  res.json({
    collections: allKeys,
    knownCollections: ALL_COLLECTIONS,
    extraCollections: extraKeys,
    counts,
    drift: { unknownKeys: driftKeys },
    note: 'Server is collection-agnostic — all array keys are saved and synced automatically',
  });
});

// ── Migration routes ──────────────────────────────────────────────────────────

// GET /migrate — inspect stored data for records needing migration (dry run)
app.get('/migrate', requireAuth, (_req, res) => {
  const data = loadData();
  if (!data) return res.json({ hasData: false, needsMigration: false });
  const report = inspectMigrations(data);
  res.json({
    hasData: true,
    schemaVersion: APP_SCHEMA_VERSION,
    ...report,
    hint: report.needsMigration
      ? 'POST /migrate to apply migrations automatically'
      : 'All records are up to date — no migration needed',
  });
});

// POST /migrate — apply schema migrations to stored data
app.post('/migrate', requireAuth, (_req, res) => {
  const data = loadData();
  if (!data) return res.status(404).json({ error: 'No data on server.' });

  const before = inspectMigrations(data);
  if (!before.needsMigration) {
    return res.json({ success: true, migrated: false, message: 'All records already up to date — nothing to migrate.' });
  }

  // Back up before migrating
  const backupFile = createBackup('pre-migration');

  const { data: migratedData, migrated, details } = applyMigrations(data);
  try {
    saveData(migratedData);
  } catch (e) {
    return res.status(500).json({ error: 'Migration save failed: ' + e.message });
  }

  const after = inspectMigrations(migratedData);
  const hash = dataHash(migratedData);
  console.log(`[migrate] ✅ Migration complete: ${details.join('; ')}`);

  res.json({
    success: true,
    migrated,
    details,
    backupCreated: backupFile,
    before: before.collections,
    after: after.collections,
    newHash: hash,
    timestamp: new Date().toISOString(),
  });
});

// ── Backup routes ─────────────────────────────────────────────────────────────

app.get('/backup/list', requireAuth, (_req, res) => {
  const backups = listBackups();
  res.json({ backups, count: backups.length });
});

app.post('/backup/now', requireAuth, (_req, res) => {
  const filename = createBackup('manual-api');
  filename ? res.json({ success: true, filename }) : res.status(500).json({ success: false, message: 'No data or write failed' });
});

// v73.95 — Craig: "the Backup import is still missing on the host-server
// but is there in the app" — meaning the DASHBOARD itself (this endpoint's
// caller), not the app-side Backup.tsx card fixed in v73.92. The dashboard
// could Create/Download/Restore/Delete an EXISTING server-side backup, but
// had no way to take a backup .json file from the operator's own computer
// and add it to that list — the only path onto the server for outside
// data was live-data /data/import (merges straight into current data,
// no backup-list entry, no easy "just add this file for later" option).
// This adds that missing piece: accepts a backup file's JSON content,
// validates it's genuine RSW backup shape (same isValidAppData check the
// restore endpoint already trusts, tolerating a missing/foreign
// `_manifest` since the file may have come from a different server), and
// writes it into BACKUP_DIR with a fresh, correctly-prefixed filename so
// it shows up in the list exactly like any other backup — Restore/
// Download/Delete/preview all work on it unchanged, no separate code path.
app.post('/backup/upload', requireAuth, (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object')
      return res.status(400).json({ error: 'No backup data received.' });
    const { _manifest, ...dataOnly } = incoming;
    if (!isValidAppData(dataOnly))
      return res.status(400).json({ error: 'That file does not look like a valid RSW backup — missing or malformed collections.' });
    const filename = `rsw-server-backup-${getBackupTimestamp()}.json`;
    const filepath  = path.join(BACKUP_DIR, filename);
    // Re-stamp the manifest instead of trusting an uploaded one verbatim —
    // an uploaded file's own integrityHash/collections counts describe ITS
    // origin server's data, not necessarily anything about this one; the
    // list/preview/verify UI just needs a manifest shaped correctly, and
    // buildManifest recomputes real counts/hashes from what's actually in
    // dataOnly regardless of where the file came from.
    const driftKeys = detectDrift(dataOnly);
    const manifest = buildManifest(dataOnly, driftKeys, 'uploaded-backup');
    fs.writeFileSync(filepath, JSON.stringify({ _manifest: manifest, ...dataOnly }), 'utf8');
    console.log(`[backup] ✅ Uploaded backup saved: ${filename} (${manifest.totalRecords} records)`);
    runAutoDelete('post-backup');
    res.json({ success: true, filename });
  } catch (e) {
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

app.post('/backup/verify', requireAuth, (req, res) => {
  let filename = req.query.filename || null;
  if (!filename) {
    const latest = listBackups()[0];
    if (!latest) return res.status(404).json({ error: 'No backups found.' });
    filename = latest.filename;
  }
  const safeName = path.basename(filename);
  if (!safeName.startsWith('rsw-server-backup-') || !safeName.endsWith('.json'))
    return res.status(400).json({ error: 'Invalid backup filename.' });
  const filepath = path.join(BACKUP_DIR, safeName);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Backup file not found.' });
  const result = verifyBackup(filepath);
  console.log(`[backup] Verification of ${safeName}: ${result.ok ? '✅ OK' : '❌ FAILED'}`);
  res.json({ filename: safeName, ...result });
});

app.get('/backup/audit', requireAuth, (_req, res) => {
  const live    = loadData();
  const backups = listBackups();
  if (!live) return res.json({ hasLiveData: false });
  if (!backups.length) return res.json({ hasLiveData: true, hasBackup: false, message: 'No backups exist yet.' });

  const latest  = backups[0];
  let backupData;
  try {
    backupData = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, latest.filename), 'utf8'));
    delete backupData._manifest;
  } catch (e) {
    return res.status(500).json({ error: 'Could not read latest backup: ' + e.message });
  }

  const audit = { latestBackup: latest.filename, backupCreated: latest.created, collections: {}, summary: { added: 0, unchanged: 0 } };
  for (const col of ALL_COLLECTIONS) {
    const liveCount   = Array.isArray(live[col])       ? live[col].length       : 0;
    const backupCount = Array.isArray(backupData[col]) ? backupData[col].length : 0;
    const diff        = liveCount - backupCount;
    audit.collections[col] = { live: liveCount, backup: backupCount, diff };
    if (diff !== 0) audit.summary.added += Math.abs(diff);
    else audit.summary.unchanged++;
  }
  audit.liveHash   = dataHash(live);
  audit.backupHash = latest.manifest ? latest.manifest.integrityHash : dataHash(backupData);
  audit.inSync     = audit.liveHash === audit.backupHash;
  res.json(audit);
});

app.post('/backup/:filename/restore', requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!filename.startsWith('rsw-server-backup-') || !filename.endsWith('.json'))
    return res.status(400).json({ error: 'Invalid backup filename' });
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Backup file not found' });
  try {
    const raw = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    const { _manifest, ...dataOnly } = raw;
    if (!isValidAppData(dataOnly)) return res.status(400).json({ error: 'Backup file is not valid RSW data' });

    // ── Auto-backup current data before overwriting ──────────────────────────
    const preRestoreBackup = createBackup('pre-restore safety backup');
    const safetyFile = preRestoreBackup ? path.basename(preRestoreBackup) : null;

    // ── Backwards-compatible restore ─────────────────────────────────────────
    // Start from current server data so that collections absent from older
    // backups (e.g. sweepAreas didn't exist before v30) are PRESERVED rather
    // than silently wiped to [].  Only collections actually present in the
    // backup file replace their counterparts on the server.
    const currentData  = loadData() || {};
    const baseRestored = normaliseData(currentData); // current data as baseline
    for (const col of ALL_COLLECTIONS) {
      if (Array.isArray(dataOnly[col])) baseRestored[col] = dataOnly[col];
    }
    // Preserve any unknown/future collections from the backup too
    for (const [k, v] of Object.entries(dataOnly)) {
      if (!baseRestored.hasOwnProperty(k) && Array.isArray(v)) baseRestored[k] = v;
    }
    if (Array.isArray(dataOnly.deletedIds)) baseRestored.deletedIds = dataOnly.deletedIds;

    // ── Normalise + auto-migrate the restored data ───────────────────────────
    const normalised = normaliseData(baseRestored);
    const { data: migrated, migrated: wasMigrated, details } = applyMigrations(normalised);

    saveData(migrated);
    console.log(`[restore] ✅ Restored from: ${filename}${wasMigrated ? ' (+ auto-migrated: ' + details.join('; ') + ')' : ''}`);
    res.json({
      success: true,
      message: `Restored from ${filename}`,
      restoredAt: new Date().toISOString(),
      safetyBackup: safetyFile,
      migrationApplied: wasMigrated ? details : [],
    });
  } catch (e) {
    res.status(500).json({ error: 'Restore failed: ' + e.message });
  }
});

app.delete('/backup/:filename', requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!filename.startsWith('rsw-server-backup-') || !filename.endsWith('.json'))
    return res.status(400).json({ error: 'Invalid backup filename' });
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Not found' });
  try {
    fs.unlinkSync(filepath);
    console.log(`[backup] Deleted backup: ${filename}`);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// /backup/prune is registered below in the settings routes section

// Add GET /backup/:filename/preview - returns summary without full data
app.get('/backup/:filename/preview', requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!filename.startsWith('rsw-server-backup-') || !filename.endsWith('.json'))
    return res.status(400).json({ error: 'Invalid backup filename' });
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Not found' });
  try {
    const raw = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    const { _manifest, ...data } = raw;
    const summary = {
      filename,
      manifest: _manifest,
      counts: {
        users:           (data.users           || []).length,
        clients:         (data.clients         || []).length,
        inspections:     (data.inspections     || []).length,
        maps:            (data.maps            || []).length,
        reports:         (data.reports         || []).length,
        categories:      (data.categories      || []).length,
        coverTemplates:  (data.coverTemplates  || []).length,
        sweepJobs:       (data.sweepJobs       || []).length,
        sweepAreas:      (data.sweepAreas      || []).length,
        sweepRoads:      (data.sweepRoads      || []).length,
        sweepZones:      (data.sweepZones      || []).length,
        sweepClients:    (data.sweepClients    || []).length,
        sweepJobSites:   (data.sweepJobSites   || []).length,
        sweepFiles:      (data.sweepFiles      || []).length,
        sweepMaps:       (data.sweepMaps       || []).length,
        sweepCategories: (data.sweepCategories || []).length,
        sweepReports:    (data.sweepReports    || []).length,
      },
      // Recent items preview (no photos/binary data)
      recentInspections: (data.inspections || []).slice(0, 5).map(i => ({
        id: i.id, title: i.title, status: i.status, site: i.site,
        client: i.clientId, date: i.date || i.createdAt, photoCount: (i.photos||[]).length,
        pinCount: (i.mapPins||[]).length,
      })),
      recentSweepJobs: (data.sweepJobs || []).slice(0, 5).map(j => ({
        id: j.id, jobNumber: j.jobNumber, status: j.status, area: j.areaId,
        date: j.date || j.createdAt, photoCount: (j.photos||[]).length,
      })),
      recentMaps: (data.maps || []).slice(0, 5).map(m => ({
        id: m.id, name: m.name, type: m.type, pinCount: (m.pins||m.mapPins||[]).length,
        hasImage: !!(m.imageData || m.image),
      })),
      recentSweepMaps: (data.sweepMaps || []).slice(0, 5).map(m => ({
        id: m.id, name: m.name, pinCount: (m.pins||m.mapPins||[]).length,
        hasImage: !!(m.imageData || m.image),
      })),
    };
    res.json(summary);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/backup/:filename', requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!filename.startsWith('rsw-server-backup-') || !filename.endsWith('.json'))
    return res.status(400).json({ error: 'Invalid backup filename' });
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.sendFile(filepath);
});

// ── Server full-data export (download as JSON, same format as local export) ───
app.get('/data/export', requireAuth, (req, res) => {
  const live = loadData();
  if (!live) return res.status(500).json({ error: 'No data on server.' });
  const exportPayload = {
    ...live,
    _exportMeta: {
      exportedAt:    new Date().toISOString(),
      exportedBy:    'server',
      appVersion:    APP_SCHEMA_VERSION,
      source:        'host-sync-server',
      serverUrl:     req.headers.host || 'unknown',
    },
  };
  const json = JSON.stringify(exportPayload, null, 2);
  const _ed  = new Date();
  const _pad = n => String(n).padStart(2,'0');
  const ts   = `${_ed.getFullYear()}-${_pad(_ed.getMonth()+1)}-${_pad(_ed.getDate())}T${_pad(_ed.getHours())}-${_pad(_ed.getMinutes())}-${_pad(_ed.getSeconds())}`;
  const filename = `rsw-server-export-${ts}.json`;
  // Create a backup snapshot before exporting
  createBackup('pre-export');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', Buffer.byteLength(json, 'utf8'));
  console.log(`[export] Full server data export: ${filename} (${(json.length/1024).toFixed(0)} KB)`);
  res.send(json);
});

// ── Server full-data import/restore (accepts JSON body OR uploaded file) ──────
app.post('/data/import', requireAuth, (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ error: 'Invalid JSON body. Send the export file as the request body.' });
    }

    // Strip export meta before restoring
    const { _exportMeta, _manifest, ...payload } = incoming;

    // Validate: must have at least one known collection
    const hasKnownCollection = ALL_COLLECTIONS.some(col => Array.isArray(payload[col]));
    if (!hasKnownCollection) {
      return res.status(400).json({ error: 'This does not look like a valid RSW export file. No recognised collections found.' });
    }

    // Snapshot current server data before overwriting
    const preBk = createBackup('pre-import');
    console.log(`[import] Pre-import backup: ${preBk || 'skipped (no existing data)'}`);

    // Backwards-compatible import: start from current server data so that
    // collections absent from older backup files are preserved rather than
    // wiped.  Only collections present in the payload replace their server
    // counterparts — everything else is left untouched.
    const currentData = loadData() || {};
    let merged = normaliseData(currentData);
    for (const col of ALL_COLLECTIONS) {
      if (Array.isArray(payload[col])) merged[col] = payload[col];
    }
    // Preserve any unknown/future collections from the import too
    for (const [k, v] of Object.entries(payload)) {
      if (!merged.hasOwnProperty(k) && Array.isArray(v)) merged[k] = v;
    }
    if (Array.isArray(payload.deletedIds)) merged.deletedIds = payload.deletedIds;
    merged = normaliseData(merged);
    const { data: cascadedImport, changed: icChanged, details: icDetails } = applyCascadeCleanup(merged);
    if (icChanged) console.log(`[import] Cascade cleanup: ${icDetails.join('; ')}`);
    merged = cascadedImport;
    saveData(merged);

    const postBk = createBackup('post-import');
    console.log(`[import] Post-import backup: ${postBk}`);

    // Count totals
    const counts = {};
    for (const col of ALL_COLLECTIONS) {
      counts[col] = Array.isArray(merged[col]) ? merged[col].length : 0;
    }

    res.json({
      success:     true,
      message:     'Server data restored successfully.',
      preBackup:   preBk,
      postBackup:  postBk,
      restoredAt:  new Date().toISOString(),
      source:      _exportMeta?.source || 'unknown',
      exportedAt:  _exportMeta?.exportedAt || 'unknown',
      counts,
    });
  } catch (err) {
    console.error('[import] Error:', err);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// ── Tombstone management ────────────────────────────────────────────────────
// GET: list current tombstones (optionally filtered by collection) so an operator
// can see exactly what's blocking a record from being resurrected by a push.
app.get('/tombstones', requireAuth, (req, res) => {
  const data = loadData();
  const all = (data && Array.isArray(data.deletedIds)) ? data.deletedIds : [];
  const { collection } = req.query;
  const filtered = collection ? all.filter(t => t.collection === collection) : all;
  res.json({ count: filtered.length, tombstones: filtered });
});

// POST: remove specific tombstone entries by id (+ optional collection to disambiguate),
// so a record that was deleted by mistake — e.g. mis-identified as a duplicate/junk
// row while it was still displaying corrupted data — can be pushed back up from a
// device that still has it. This intentionally requires the caller to name exact
// ids; there's no "undo the last N deletes" or blanket tombstone-clearing here,
// since that would reopen the door to the exact resurrection bugs tombstones exist
// to prevent. Body: { items: [{ id, collection? }, ...] }
// v71.3: narrow, safe recovery for the 15 fixed built-in (v73.51: zone_kind added) sweepCategories lists —
// NOT a general "create list" endpoint (that was deliberately removed in v71.0/71.1).
// Only recreates whichever of the 14 known default ids are currently missing
// (e.g. deleted via the dashboard, or lost some other way), using the same
// id->type->label mapping used by applyMigrations(). Also clears any lingering
// tombstone for a restored id so a stale sync merge doesn't immediately re-delete it.
app.post('/sweep-categories/restore-defaults', requireAuth, (req, res) => {
  const data = loadData();
  if (!data) return res.status(404).json({ error: 'No data on server yet.' });
  if (!Array.isArray(data.sweepCategories)) data.sweepCategories = [];

  const existingIds = new Set(data.sweepCategories.map(c => c.id));
  const missing = Object.keys(SW_CAT_ID_TO_TYPE).filter(id => !existingIds.has(id));

  if (missing.length === 0) {
    return res.json({ success: true, restored: [], message: 'All 15 built-in SW Categories lists are already present — nothing to restore.' });
  }

  createBackup('pre-restore-defaults');
  const now = new Date().toISOString();
  const restored = [];
  for (const id of missing) {
    const type = SW_CAT_ID_TO_TYPE[id];
    const meta = SW_CAT_META[type] || { label: id };
    data.sweepCategories.push({ id, name: meta.label, categoryType: type, items: [], createdAt: now, updatedAt: now });
    restored.push({ id, name: meta.label, categoryType: type });
  }
  if (Array.isArray(data.deletedIds)) {
    const restoredIds = new Set(restored.map(r => r.id));
    data.deletedIds = data.deletedIds.filter(t => !restoredIds.has(t.id));
  }

  try {
    saveData(data);
  } catch (e) {
    return res.status(500).json({ error: 'Save failed: ' + e.message });
  }
  console.log(`[sweepCategories] Restored ${restored.length} missing default list(s): ${restored.map(r => r.id).join(', ')}`);
  res.json({ success: true, restored, message: `Restored ${restored.length} missing built-in list(s).` });
});

app.post('/tombstones/remove', requireAuth, (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'Body must be { items: [{ id, collection? }, ...] }.' });
  }
  const data = loadData();
  if (!data || !Array.isArray(data.deletedIds)) {
    return res.status(404).json({ error: 'No tombstone data on server.' });
  }
  const targets = items
    .filter(it => it && typeof it.id === 'string' && it.id.trim())
    .map(it => ({ id: it.id.trim(), collection: it.collection || null }));
  if (targets.length === 0) return res.status(400).json({ error: 'No valid { id } entries in items.' });

  createBackup('pre-untombstone');
  const before = data.deletedIds.length;
  const removed = [];
  data.deletedIds = data.deletedIds.filter(t => {
    const match = targets.some(x => x.id === t.id && (!x.collection || x.collection === t.collection));
    if (match) removed.push(t);
    return !match;
  });
  try {
    saveData(data);
  } catch (e) {
    return res.status(500).json({ error: 'Save failed: ' + e.message });
  }
  console.log(`[tombstones] Removed ${removed.length} tombstone(s): ${removed.map(t => t.id).join(', ')}`);
  res.json({
    success: true,
    removedCount: removed.length,
    removed,
    remainingTombstones: data.deletedIds.length,
    before,
    note: 'These ids can now be re-added by the next Push to Server from a device that still has them.',
  });
});

// Age-based bulk tombstone cleanup — unlike POST /tombstones/remove (a
// specific mistaken deletion), this is routine garbage collection: once a
// tombstone is old enough that every device has long since synced the
// deletion, keeping it around forever serves no purpose except growing the
// data file. Body: { olderThanDays?: number } — defaults to the server's
// TOMBSTONE_DAYS retention setting; pass 0 to clear every tombstone regardless
// of age. Safe to run at 0 as of v71.8 because the 14+3 built-in category
// lists can no longer be deleted (and therefore can never be tombstoned) —
// see the DELETE /data/:collection/:id guard above.
app.post('/tombstones/prune', requireAuth, (req, res) => {
  const raw = req.body?.olderThanDays;
  const days = (raw === undefined || raw === null || raw === '') ? TOMBSTONE_DAYS : Number(raw);
  if (!Number.isFinite(days) || days < 0) {
    return res.status(400).json({ error: 'olderThanDays must be a non-negative number (0 = delete all tombstones).' });
  }
  const data = loadData();
  if (!data || !Array.isArray(data.deletedIds) || data.deletedIds.length === 0) {
    return res.json({ success: true, removedCount: 0, remainingTombstones: 0, before: 0, olderThanDays: days });
  }
  const before = data.deletedIds.length;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const removed = data.deletedIds.filter(t => t.deletedAt < cutoff);
  if (removed.length === 0) {
    return res.json({
      success: true, removedCount: 0, remainingTombstones: before, before, olderThanDays: days,
      message: `No tombstones older than ${days} day(s).`,
    });
  }
  createBackup('pre-prune-tombstones');
  data.deletedIds = data.deletedIds.filter(t => t.deletedAt >= cutoff);
  try {
    saveData(data);
  } catch (e) {
    return res.status(500).json({ error: 'Save failed: ' + e.message });
  }
  console.log(`[tombstones] Pruned ${removed.length} tombstone(s) older than ${days} day(s) (${before} → ${data.deletedIds.length})`);
  res.json({
    success: true,
    removedCount: removed.length,
    remainingTombstones: data.deletedIds.length,
    before,
    olderThanDays: days,
    note: 'Pruned ids can be re-added by a future push from a device that still has them — this is routine garbage collection of old delete-tracking entries, not a data restore.',
  });
});

// ── Debug Log routes ─────────────────────────────────────────────────────────
app.get('/logs', requireAuth, (_req, res) => {
  try {
    const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.log')).sort().reverse();
    const dates = files.map(f => {
      const stat = fs.statSync(path.join(LOGS_DIR, f));
      return { date: f.replace('.log', ''), sizeBytes: stat.size };
    });
    res.json({ dates, retentionDays: loadSettings().logRetentionDays || 4 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// FEATURE (Craig-reported "host-server live view still missing"): the
// server dashboard's Debug page has only ever shown the static per-day file
// list below — there was never actually a live-tailing view here, despite
// the client app's own Debug.tsx (v72.9) being built on the assumption one
// already existed here to match. Adding it now, for real. Uses the server's
// own todayStr() (not a client-computed date) so this can't drift out of
// sync with which file actually gets written to — same class of UTC-vs-local
// bug already fixed elsewhere in this project (v72.7) for exactly this
// reason: the browser's local date and the server's TZ=Pacific/Auckland
// date can disagree, especially if the dashboard is viewed from elsewhere.
app.get('/logs/today/live', requireAuth, (_req, res) => {
  try {
    const date = todayStr();
    const p = logFilePath(date);
    if (!fs.existsSync(p)) return res.json({ date, text: '' });
    res.json({ date, text: fs.readFileSync(p, 'utf8') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/logs/:date', requireAuth, (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date — expected YYYY-MM-DD.' });
  const p = logFilePath(date);
  if (!fs.existsSync(p)) return res.status(404).json({ error: `No log for ${date}.` });
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="rsw-server-log-${date}.log"`);
  res.send(fs.readFileSync(p, 'utf8'));
});

app.delete('/logs/:date', requireAuth, (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date — expected YYYY-MM-DD.' });
  const p = logFilePath(date);
  if (!fs.existsSync(p)) return res.status(404).json({ error: `No log for ${date}.` });
  fs.unlinkSync(p);
  console.log(`[logs] Deleted log file for ${date}`);
  res.json({ success: true, date });
});

app.delete('/logs', requireAuth, (_req, res) => {
  try {
    const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.log'));
    files.forEach(f => fs.unlinkSync(path.join(LOGS_DIR, f)));
    console.log(`[logs] Deleted all ${files.length} log file(s)`);
    res.json({ success: true, deletedCount: files.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CRUD for all collections ──────────────────────────────────────────────────

app.get('/data/:collection', requireAuth, (req, res) => {
  const { collection } = req.params;
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(collection))
    return res.status(400).json({ error: `Invalid collection name "${collection}".` });
  const data = loadData();
  if (!data) return res.json({ collection, records: [], count: 0 });
  const records = Array.isArray(data[collection]) ? data[collection] : [];

  // v71.4 — FULL AUDIT FIX (per Craig's request after the sweepCategories bug):
  // this endpoint used to hand-pick a small whitelist of fields per record
  // (id/name/status/date/area/createdAt/updatedAt, plus one-off special cases
  // for sweepRoads and, until v71.3, nothing at all for sweepCategories).
  // EVERY field not on that whitelist was silently dropped before it ever
  // reached the dashboard's collection table, Items modal, and "👁 View" button
  // (all three read from this same response) — no matter how correct the
  // underlying stored data was. That's exactly the bug that made SW Categories
  // show "Custom (0 items)" for months.
  //
  // Audited every other collection for the same pattern: `inspections` (photos/
  // comments/mapPins were being dropped — View showed none of them),
  // `sweepJobs` (fuelDockets/extraExpenses/tipRuns/roads were being dropped),
  // `sweepJobSites` (mapPins/fileIds were being dropped), `maps`/`sweepMaps`
  // (pins were being dropped), `categories`/`coverTemplates` — all had the same
  // problem to varying degrees. Fixed for all of them at once by returning the
  // FULL record instead of a hand-picked subset. This is a low-traffic LAN/
  // admin dashboard, not a bandwidth-constrained mobile client, so there's no
  // real cost to sending complete records.
  //
  // The only trimming that remains is for the handful of fields whose entire
  // purpose is to hold one large embedded base64 blob (a full-resolution image/
  // file, not metadata) — those are replaced with a lightweight `hasXxx` marker
  // in this LIST response only. The full blob is still returned in full by
  // GET /data/:collection/:id (single-record fetch), so nothing is lost —
  // it's just not repeated on every row of a list that may have hundreds of
  // records, most of which the user isn't looking at right now.
  const stripBlob = (rec) => {
    const r = { ...rec };
    if (collection === 'sweepFiles' && typeof r.data === 'string') {
      r.hasData = r.data.length > 0;
      delete r.data;
    }
    if ((collection === 'sweepMaps' || collection === 'maps') && typeof r.imageData === 'string') {
      r.hasImageData = r.imageData.length > 0;
      delete r.imageData;
    }
    if (collection === 'coverTemplates' && r.cover && typeof r.cover.logoData === 'string') {
      r.cover = { ...r.cover, hasLogoData: r.cover.logoData.length > 0, logoData: undefined };
    }
    return r;
  };

  const summary = records.map(stripBlob);
  res.json({ collection, records: summary, count: summary.length });
});

app.get('/data/:collection/:id', requireAuth, (req, res) => {
  const { collection, id } = req.params;
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(collection))
    return res.status(400).json({ error: `Invalid collection name "${collection}".` });
  const data = loadData();
  if (!data) return res.status(404).json({ error: 'No data on server.' });
  const record = (data[collection] || []).find(r => r.id === id);
  if (!record) return res.status(404).json({ error: `"${id}" not found in ${collection}.` });
  res.json({ collection, id, record });
});

app.post('/data/overwrite', requireAuth, (req, res) => {
  const { data: clientData } = req.body;
  if (!clientData || !isValidAppData(clientData))
    return res.status(400).json({ error: 'Invalid or missing data.' });
  const driftKeys = detectDrift(clientData);
  if (driftKeys.length > 0)
    console.warn(`[overwrite] ⚠️  Drift keys in overwrite payload: ${driftKeys.join(', ')}`);
  const { data: migratedData, migrated, details } = applyMigrations(normaliseData(clientData));
  if (migrated) console.log(`[overwrite] Migration applied: ${details.join('; ')}`);
  const { data: cascadedOverwrite, changed: ocChanged, details: ocDetails } = applyCascadeCleanup(migratedData);
  if (ocChanged) console.log(`[overwrite] Cascade cleanup: ${ocDetails.join('; ')}`);
  // Bug 8: normalise categories on overwrite sync path same as merge path
  if (Array.isArray(cascadedOverwrite.sweepCategories)) {
    cascadedOverwrite.sweepCategories = cascadedOverwrite.sweepCategories.map(normaliseSweepCategory);
  }
  if (Array.isArray(cascadedOverwrite.categories)) {
    cascadedOverwrite.categories = cascadedOverwrite.categories.map(normaliseCategory);
  }
  try { createBackup('pre-overwrite'); saveData(cascadedOverwrite); }
  catch (e) { return res.status(500).json({ error: 'Save failed: ' + e.message }); }
  console.log(`[${new Date().toISOString()}] Full overwrite applied.`);
  res.json({ success: true, hash: dataHash(cascadedOverwrite), timestamp: new Date().toISOString(), migrationApplied: migrated ? details : null, cascadeCleanup: ocChanged ? ocDetails : null });
});

app.post('/data/:collection', requireAuth, (req, res) => {
  const { collection } = req.params;
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(collection))
    return res.status(400).json({ error: `Invalid collection name "${collection}".` });
  let record = req.body;
  if (!record || typeof record !== 'object')
    return res.status(400).json({ error: 'Body must be a JSON object.' });
  if (!record.id) record.id = crypto.randomUUID();
  const now = new Date().toISOString();
  if (!record.createdAt) record.createdAt = now;
  record.updatedAt = now;
  // Auto-normalise on write for all migrated collections
  if (collection === 'sweepRoads')     record = normaliseSweepRoad(record);
  if (collection === 'sweepJobs')      record = normaliseSweepJob(record, null);
  if (collection === 'sweepAreas')     record = normaliseSweepArea(record);
  if (collection === 'sweepJobSites')  record = normaliseSweepJobSite(record);
  if (collection === 'inspections')    record = normaliseInspection(record);
  if (collection === 'sweepCategories') record = normaliseSweepCategory(record);
  if (collection === 'categories')      record = normaliseCategory(record);
  const data = loadData() || normaliseData({});
  if (!Array.isArray(data[collection])) data[collection] = [];
  if (data[collection].some(r => r.id === record.id))
    return res.status(409).json({ error: `"${record.id}" already exists.` });
  // Defense-in-depth: reject duplicate-named category/list creation via direct API,
  // mirroring the client-side guard so this can't reintroduce the duplication bug.
  if ((collection === 'categories' || collection === 'sweepCategories') && record.name) {
    const nameKey = String(record.name).trim().toLowerCase();
    const clash = data[collection].some(r =>
      r.name && String(r.name).trim().toLowerCase() === nameKey &&
      (collection === 'sweepCategories' ? r.categoryType === record.categoryType : true)
    );
    if (clash) return res.status(409).json({ error: `A list named "${record.name}" already exists.` });
  }
  data[collection].push(record);
  try { saveData(data); }
  catch (e) { return res.status(500).json({ error: 'Save failed: ' + e.message }); }
  console.log(`[${now}] Created ${collection}/${record.id}`);
  res.status(201).json({ success: true, collection, id: record.id, record });
});

app.put('/data/:collection/:id', requireAuth, (req, res) => {
  const { collection, id } = req.params;
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(collection))
    return res.status(400).json({ error: `Invalid collection name "${collection}".` });
  let update = req.body;
  if (!update || typeof update !== 'object')
    return res.status(400).json({ error: 'Body must be a JSON object.' });
  if (collection === 'users') {
    const d2 = loadData();
    if (d2) {
      const others = (d2.users || []).filter(u => u.id !== id);
      if ((update.role !== 'admin') && others.filter(u => u.role === 'admin').length === 0)
        return res.status(400).json({ error: 'Cannot demote the last admin user.' });
    }
  }
  const data = loadData();
  if (!data) return res.status(404).json({ error: 'No data on server.' });
  const records = Array.isArray(data[collection]) ? data[collection] : [];
  const idx = records.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: `"${id}" not found in ${collection}.` });
  const now = new Date().toISOString();
  let replaced = { ...update, id, updatedAt: now };
  if (!replaced.createdAt) replaced.createdAt = records[idx].createdAt || now;
  if (collection === 'sweepRoads')     replaced = normaliseSweepRoad(replaced);
  if (collection === 'sweepJobs')      replaced = normaliseSweepJob(replaced, null);
  if (collection === 'sweepAreas')     replaced = normaliseSweepArea(replaced);
  if (collection === 'sweepJobSites')  replaced = normaliseSweepJobSite(replaced);
  if (collection === 'inspections')    replaced = normaliseInspection(replaced);
  if (collection === 'sweepCategories') replaced = normaliseSweepCategory(replaced);
  if (collection === 'categories')      replaced = normaliseCategory(replaced);
  records[idx] = replaced;
  data[collection] = records;
  try { saveData(data); }
  catch (e) { return res.status(500).json({ error: 'Save failed: ' + e.message }); }
  console.log(`[${now}] PUT ${collection}/${id}`);
  res.json({ success: true, collection, id, record: replaced });
});

app.patch('/data/:collection/:id', requireAuth, (req, res) => {
  const { collection, id } = req.params;
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(collection))
    return res.status(400).json({ error: `Invalid collection name "${collection}".` });
  const patch = req.body;
  if (!patch || typeof patch !== 'object')
    return res.status(400).json({ error: 'Body must be a JSON object.' });
  const data = loadData();
  if (!data) return res.status(404).json({ error: 'No data on server.' });
  const records = Array.isArray(data[collection]) ? data[collection] : [];
  const idx = records.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: `"${id}" not found in ${collection}.` });
  const now = new Date().toISOString();
  let updated = { ...records[idx], ...patch, id, updatedAt: now };
  if (collection === 'sweepRoads')     updated = normaliseSweepRoad(updated);
  if (collection === 'sweepJobs')      updated = normaliseSweepJob(updated, null);
  if (collection === 'sweepAreas')     updated = normaliseSweepArea(updated);
  if (collection === 'sweepJobSites')  updated = normaliseSweepJobSite(updated);
  if (collection === 'inspections')    updated = normaliseInspection(updated);
  if (collection === 'sweepCategories') updated = normaliseSweepCategory(updated);
  if (collection === 'categories')      updated = normaliseCategory(updated);
  records[idx] = updated;
  data[collection] = records;
  try { saveData(data); }
  catch (e) { return res.status(500).json({ error: 'Save failed: ' + e.message }); }
  console.log(`[${now}] PATCH ${collection}/${id}`);
  res.json({ success: true, collection, id, record: updated });
});

app.delete('/data/:collection/:id', requireAuth, (req, res) => {
  const { collection, id } = req.params;
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(collection))
    return res.status(400).json({ error: `Invalid collection name "${collection}".` });
  if (collection === 'users') {
    const d2 = loadData();
    if (d2 && (d2.users || []).filter(u => u.id !== id && u.role === 'admin').length === 0)
      return res.status(400).json({ error: 'Cannot delete the last admin user.' });
  }
  // v71.8: block deleting the 15 built-in sweepCategories lists (or 3 built-in
  // categories lists) by id — deleting one tombstones the id, and since the
  // app's own "+ New List" was deliberately removed, there was no way to
  // recreate a built-in list without server-side intervention. Renaming and
  // deleting/adding items *within* a built-in list are both still fully
  // allowed — only deleting the list record itself is blocked.
  if (collection === 'sweepCategories' && SW_CAT_ID_TO_TYPE[id]) {
    return res.status(400).json({
      error: `"${id}" is one of the 15 built-in SW Categories lists and can't be deleted. You can still rename it or remove its items.`,
    });
  }
  if (collection === 'categories' && CAT_ID_TO_TYPE[id]) {
    return res.status(400).json({
      error: `"${id}" is one of the built-in Site & Road Inspections category lists and can't be deleted. You can still rename it or remove its items.`,
    });
  }
  const data = loadData();
  if (!data) return res.status(404).json({ error: 'No data on server.' });
  const before = Array.isArray(data[collection]) ? data[collection] : [];
  const after  = before.filter(r => r.id !== id);
  if (after.length === before.length)
    return res.status(404).json({ error: `"${id}" not found in ${collection}.` });
  data[collection] = after;
  addTombstone(data, collection, id);
  // Cascade: if we deleted an inspection, clean ghost refs from reports.
  // If we deleted a map, clean ghost mapPins from inspections.
  if (collection === 'inspections' || collection === 'maps') {
    const { data: cascadedDel, changed: dcChanged, details: dcDetails } = applyCascadeCleanup(data);
    if (dcChanged) {
      console.log(`[delete] Cascade cleanup after ${collection} delete: ${dcDetails.join('; ')}`);
      Object.assign(data, cascadedDel);
    }
  }
  try { saveData(data); }
  catch (e) { return res.status(500).json({ error: 'Save failed: ' + e.message }); }
  console.log(`[${new Date().toISOString()}] Deleted ${collection}/${id} (tombstoned)`);
  res.json({ success: true, collection, id, remaining: after.length });
});

// ── File Storage routes ───────────────────────────────────────────────────────
// Separate binary file storage — files are stored on disk as their original
// format, not base64-in-JSON.  This keeps the main sync payload small.

function listUploadedFiles() {
  try {
    const meta = path.join(UPLOADS_DIR, '_meta.json');
    if (!fs.existsSync(meta)) return [];
    return JSON.parse(fs.readFileSync(meta, 'utf8'));
  } catch { return []; }
}

function saveUploadedFileMeta(files) {
  try {
    const meta = path.join(UPLOADS_DIR, '_meta.json');
    const tmp  = meta + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(files), 'utf8');
    fs.renameSync(tmp, meta);
  } catch (e) { console.error('[files] meta save error:', e.message); }
}

// GET /files — list all uploaded files
app.get('/files', requireAuth, (_req, res) => {
  const files = listUploadedFiles();
  const enriched = files.map(f => ({
    ...f,
    exists: fs.existsSync(path.join(UPLOADS_DIR, f.id + '_' + f.name)),
  }));
  res.json({ files: enriched, count: enriched.length });
});

// POST /files/upload — upload any file (multipart or raw body)
app.post('/files/upload', requireAuth, (req, res) => {
  try {
    const id       = crypto.randomUUID();
    const now      = new Date().toISOString();
    const rawName  = req.headers['x-file-name'] || 'upload';
    const mimeType = req.headers['content-type'] || 'application/octet-stream';
    // Strip multipart boundary from MIME if needed
    const baseMime = mimeType.split(';')[0].trim();
    const safeName = path.basename(rawName.replace(/[^a-zA-Z0-9._-]/g, '_'));
    const disk     = path.join(UPLOADS_DIR, id + '_' + safeName);
    const chunks   = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      fs.writeFileSync(disk, buf);
      const meta = { id, name: safeName, mimeType: baseMime, size: buf.length, uploadedAt: now, uploadedBy: req.headers['x-uploaded-by'] || 'unknown' };
      const files = listUploadedFiles();
      files.unshift(meta);
      saveUploadedFileMeta(files);
      console.log(`[files] Uploaded: ${safeName} (${buf.length} bytes)`);
      res.status(201).json({ success: true, file: meta });
    });
    req.on('error', e => res.status(500).json({ error: e.message }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /files/:id — download a file
app.get('/files/:id', requireAuth, (req, res) => {
  const files  = listUploadedFiles();
  const record = files.find(f => f.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'File not found.' });
  const disk = path.join(UPLOADS_DIR, record.id + '_' + record.name);
  if (!fs.existsSync(disk)) return res.status(404).json({ error: 'File missing from disk.' });
  res.setHeader('Content-Type', record.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${record.name}"`);
  res.sendFile(path.resolve(disk));
});

// DELETE /files/:id — delete a file
app.delete('/files/:id', requireAuth, (req, res) => {
  const files  = listUploadedFiles();
  const idx    = files.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'File not found.' });
  const record = files[idx];
  const disk   = path.join(UPLOADS_DIR, record.id + '_' + record.name);
  try { if (fs.existsSync(disk)) fs.unlinkSync(disk); } catch {}
  files.splice(idx, 1);
  saveUploadedFileMeta(files);
  console.log(`[files] Deleted: ${record.name}`);
  res.json({ success: true, id: record.id });
});

// ── Dynamic custom collection registration ────────────────────────────────────
// Allows the app to register a new collection name at runtime so the server
// saves it instead of silently dropping it as a drift key.
const CUSTOM_COLLECTIONS_FILE = path.join(DATA_DIR, 'custom-collections.json');

function loadCustomCollections() {
  try {
    if (fs.existsSync(CUSTOM_COLLECTIONS_FILE))
      return JSON.parse(fs.readFileSync(CUSTOM_COLLECTIONS_FILE, 'utf8'));
  } catch {}
  return [];
}

// Register custom collections at startup
const customCols = loadCustomCollections();
customCols.forEach(col => {
  if (!ALL_COLLECTIONS.includes(col)) {
    ALL_COLLECTIONS.push(col);
    console.log(`[collections] Loaded custom collection: "${col}"`);
  }
});

// POST /collections/register — add a new collection dynamically
app.post('/collections/register', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name))
    return res.status(400).json({ error: 'Invalid collection name. Use letters, numbers, underscores only.' });
  if (ALL_COLLECTIONS.includes(name))
    return res.json({ success: true, message: `Collection "${name}" is already registered.`, collections: ALL_COLLECTIONS });
  ALL_COLLECTIONS.push(name);
  const saved = loadCustomCollections();
  if (!saved.includes(name)) {
    saved.push(name);
    try { fs.writeFileSync(CUSTOM_COLLECTIONS_FILE, JSON.stringify(saved), 'utf8'); } catch {}
  }
  console.log(`[collections] Registered new collection: "${name}"`);
  res.status(201).json({ success: true, message: `Collection "${name}" registered.`, collections: ALL_COLLECTIONS });
});

// ── Root route — simple JSON so the PWA service worker is not confused ────────
// The dashboard is at /dashboard. The app shell is served from the file system.
app.get('/', (req, res) => {
  // Browser navigation → redirect to dashboard
  // API clients (fetch/curl with no text/html accept) → return JSON index
  const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
  if (acceptsHtml) {
    return res.redirect(302, '/dashboard');
  }
  res.json({
    service: 'RSW Sync Server',
    version: PKG_VERSION,
    status: 'ok',
    dashboard: '/dashboard',
    health: '/health',
    docs: 'Open /dashboard in your browser for the full server dashboard.',
  });
});

// ── Interactive Server Dashboard ─────────────────────────────────────────────
// Served at GET /dashboard — move from / to avoid breaking the PWA service worker
// which expects GET / to return the app shell, not a dashboard HTML page.
// Access at: https://192.168.1.7:8055/dashboard
app.get('/dashboard', (_req, res) => {
  try {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RSW Sync Server — Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f172a;--surface:#1e293b;--surface2:#334155;--border:#475569;
  --text:#f1f5f9;--muted:#94a3b8;--accent:#6366f1;--accent2:#818cf8;
  --green:#10b981;--red:#ef4444;--amber:#f59e0b;--blue:#3b82f6;
  --r:10px;--font:'Inter',system-ui,sans-serif;
}
body{background:var(--bg);color:var(--text);font-family:var(--font);min-height:100vh}
#login{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
#login .box{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:40px;width:100%;max-width:400px;text-align:center}
#login h1{font-size:1.5rem;font-weight:700;margin-bottom:6px}
#login p{color:var(--muted);font-size:.875rem;margin-bottom:24px}
#login input{width:100%;padding:12px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:1rem;margin-bottom:12px;outline:none}
#login input:focus{border-color:var(--accent)}
#login button{width:100%;padding:12px;background:var(--accent);border:none;border-radius:8px;color:#fff;font-size:1rem;font-weight:600;cursor:pointer;transition:.15s}
#login button:hover{background:var(--accent2)}
#login .err{color:var(--red);font-size:.8rem;margin-top:8px}
#app{display:none;flex-direction:column;min-height:100vh}
header{background:var(--surface);border-bottom:1px solid var(--border);padding:14px 24px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:100}
header h1{font-size:1.125rem;font-weight:700;flex:1}
header .meta{font-size:.75rem;color:var(--muted)}
.hbtn{background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:6px 12px;font-size:.8rem;cursor:pointer;transition:.15s}
.hbtn:hover{border-color:var(--accent);color:var(--accent2)}
.hbtn.danger:hover{border-color:var(--red);color:var(--red)}
.layout{display:flex;flex:1;overflow:hidden}
nav{width:220px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto;flex-shrink:0}
nav .nav-section{padding:12px 16px 4px;font-size:.65rem;font-weight:700;color:var(--muted);letter-spacing:.08em;text-transform:uppercase}
nav .nav-item{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;cursor:pointer;font-size:.825rem;border-left:3px solid transparent;transition:.1s}
nav .nav-item:hover{background:var(--surface2);color:var(--accent2)}
nav .nav-item.active{background:var(--surface2);border-left-color:var(--accent);color:var(--accent2);font-weight:600}
nav .badge{background:var(--surface2);color:var(--muted);font-size:.7rem;padding:1px 6px;border-radius:99px;min-width:22px;text-align:center}
nav .nav-item.active .badge{background:var(--accent);color:#fff}
main{flex:1;overflow-y:auto;padding:24px}
.page{display:none}
.page.active{display:block}
/* Dashboard cards */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:24px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px;cursor:pointer;transition:.15s}
.stat-card:hover{border-color:var(--accent);transform:translateY(-1px)}
.stat-card .count{font-size:2rem;font-weight:700;color:var(--accent2);line-height:1}
.stat-card .label{font-size:.75rem;color:var(--muted);margin-top:4px}
.stat-card .icon{font-size:1.5rem;margin-bottom:6px}
/* Health cards */
.health-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-bottom:24px}
.health-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px;box-sizing:border-box}
.health-card h3{font-size:.75rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px}
.kv{display:flex;justify-content:space-between;gap:10px;font-size:.8rem;padding:4px 0;border-bottom:1px solid var(--border)}
.kv:last-child{border:none}
.kv .k{color:var(--muted);flex-shrink:0;white-space:nowrap}
.kv .v{font-weight:600;text-align:right;min-width:0;overflow-wrap:break-word}
.v.ok{color:var(--green)} .v.warn{color:var(--amber)} .v.err{color:var(--red)}
/* Collection browser */
.toolbar{display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap}
.search{flex:1;min-width:180px;padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.875rem;outline:none}
.search:focus{border-color:var(--accent)}
.btn{padding:8px 14px;border-radius:8px;font-size:.825rem;font-weight:600;cursor:pointer;border:none;transition:.15s;display:inline-flex;align-items:center;gap:6px}
.btn-primary{background:var(--accent);color:#fff}.btn-primary:hover{background:var(--accent2)}
.btn-danger{background:rgba(239,68,68,.15);color:var(--red);border:1px solid rgba(239,68,68,.3)}.btn-danger:hover{background:rgba(239,68,68,.25)}
.btn-ghost{background:var(--surface2);color:var(--text);border:1px solid var(--border)}.btn-ghost:hover{border-color:var(--accent);color:var(--accent2)}
/* Table */
.tbl-wrap{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
table{width:100%;border-collapse:collapse;font-size:.8rem}
th{background:var(--surface2);padding:10px 12px;text-align:left;font-weight:600;color:var(--muted);font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--border)}
td{padding:9px 12px;border-bottom:1px solid var(--border);vertical-align:middle;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
tr:last-child td{border:none}
tr:hover td{background:rgba(99,102,241,.06)}
.tag{display:inline-block;padding:2px 7px;border-radius:99px;font-size:.7rem;font-weight:600}
.tag-green{background:rgba(16,185,129,.15);color:var(--green)}
.tag-red{background:rgba(239,68,68,.15);color:var(--red)}
.tag-blue{background:rgba(59,130,246,.15);color:var(--blue)}
.tag-amber{background:rgba(245,158,11,.15);color:var(--amber)}
/* Record detail modal */
.modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:200;align-items:center;justify-content:center;padding:16px}
.modal-bg.open{display:flex}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:12px;width:100%;max-width:640px;max-height:85vh;display:flex;flex-direction:column;overflow:hidden}
.modal-header{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
.modal-title{font-weight:700;font-size:1rem}
.modal-body{padding:20px;overflow-y:auto;flex:1}
.modal-footer{padding:12px 20px;border-top:1px solid var(--border);display:flex;gap:10px;justify-content:flex-end}
pre.json{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;font-size:.75rem;white-space:pre-wrap;word-break:break-all;max-height:420px;overflow-y:auto;color:#a5b4fc;font-family:'JetBrains Mono',monospace}
/* Backups */
.backup-item{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;display:flex;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap}
.backup-info{flex:1;min-width:180px}
.backup-name{font-size:.825rem;font-weight:600;font-family:monospace}
.backup-meta{font-size:.72rem;color:var(--muted);margin-top:2px}
.backup-actions{display:flex;gap:8px;flex-shrink:0}
/* Toast */
#toast{position:fixed;bottom:24px;right:24px;z-index:300;display:flex;flex-direction:column;gap:8px}
.toast-item{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 16px;font-size:.825rem;max-width:320px;box-shadow:0 8px 24px rgba(0,0,0,.4);display:flex;align-items:center;gap:10px}
.toast-item.success{border-color:var(--green)}.toast-item.error{border-color:var(--red)}.toast-item.info{border-color:var(--accent)}
/* Disk bar */
.disk-bar{background:var(--bg);border-radius:99px;height:8px;overflow:hidden;margin-top:4px}
.disk-fill{height:100%;border-radius:99px;background:var(--accent);transition:.5s}
.disk-fill.warn{background:var(--amber)}.disk-fill.crit{background:var(--red)}
/* Empty state */
.empty{text-align:center;padding:48px;color:var(--muted)}
.empty .icon{font-size:2.5rem;margin-bottom:12px}
/* Pagination */
.pagination{display:flex;align-items:center;gap:8px;margin-top:12px;justify-content:flex-end;font-size:.8rem}
.pg-btn{padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer}
.pg-btn:disabled{opacity:.4;cursor:default}
.pg-info{color:var(--muted)}
@media(max-width:640px){nav{width:56px}.nav-item span,.badge,.nav-section{display:none}nav .nav-item{justify-content:center;padding:12px}}
</style>
</head>
<body>

<!-- LOGIN -->
<div id="login">
  <div class="box">
    <div style="font-size:2.5rem;margin-bottom:10px">🔐</div>
    <h1>RSW Sync Server</h1>
    <p>Enter your Sync Token to access the server dashboard</p>
    <input type="password" id="tokenInput" placeholder="Sync token" autocomplete="current-password" />
    <button onclick="doLogin()">Sign In</button>
    <div class="err" id="loginErr"></div>
    <p style="margin-top:16px;font-size:.72rem;color:var(--muted)">Server v<span id="svrVer">—</span></p>
  </div>
</div>

<!-- APP SHELL -->
<div id="app">
  <header>
    <div style="font-size:1.4rem">📡</div>
    <h1>RSW Sync Server Dashboard</h1>
    <span class="meta" id="headerMeta"></span>
    <button class="hbtn" onclick="createBackup()">💾 Backup Now</button>
    <button class="hbtn" onclick="refreshAll()">🔄 Refresh</button>
    <span class="meta" id="autoRefreshBadge" style="font-size:.7rem;color:#6ee7b7">● Auto-refresh on</span>
    <button class="hbtn danger" onclick="doLogout()" title="Sign out and clear saved session">Sign Out 🔒</button>
  </header>

  <div class="layout">
    <nav id="nav">
      <div class="nav-section">Overview</div>
      <div class="nav-item active" data-page="dashboard" onclick="showPage('dashboard')">
        <span>📊 Dashboard</span>
      </div>
      <div class="nav-section">Data</div>
      <div id="navCollections"></div>
      <div class="nav-section">Server System</div>
      <div class="nav-item" data-page="backups" onclick="showPage('backups')">
        <span>💾 Backups</span><span class="badge" id="badgeBackups">—</span>
      </div>
      <div class="nav-item" data-page="health" onclick="showPage('health')">
        <span>❤️ Health</span>
      </div>
      <div class="nav-item" data-page="debug" onclick="showPage('debug')">
        <span>🐞 Debug</span>
      </div>
    </nav>

    <main>
      <!-- DASHBOARD -->
      <div class="page active" id="page-dashboard">
        <h2 style="font-size:1.25rem;font-weight:700;margin-bottom:16px">Server Overview</h2>
        <div class="stats-grid" id="statsGrid"></div>
        <div class="health-grid" id="quickHealth"></div>
      </div>

      <!-- COLLECTION BROWSER -->
      <div class="page" id="page-collection">
        <div class="toolbar">
          <h2 id="colTitle" style="font-size:1.1rem;font-weight:700;min-width:120px"></h2>
          <input class="search" id="colSearch" placeholder="🔍 Search records…" oninput="renderTable()">
          <select id="colCatFilter" style="display:none;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--fg);font-size:.82rem" onchange="state.page=0;renderTable()"></select>
          <button class="btn btn-ghost" onclick="loadCollection()">🔄</button>
          <button class="btn btn-secondary" id="btnRestoreDefaults" style="display:none" onclick="restoreDefaultSweepCategories()">♻️ Restore Missing Defaults</button>
          <button class="btn btn-danger" id="btnClearCol" onclick="clearCollection()">🗑️ Clear All</button>
        </div>
        <div class="tbl-wrap"><table id="colTable"><thead id="colHead"></thead><tbody id="colBody"></tbody></table></div>
        <div class="pagination" id="colPagination"></div>
      </div>

      <!-- BACKUPS -->
      <div class="page" id="page-backups">
        <div class="toolbar">
          <h2 style="font-size:1.1rem;font-weight:700">Backups</h2>
          <button class="btn btn-primary" onclick="createBackup()">💾 Create Backup</button>
          <button class="btn btn-ghost" onclick="document.getElementById('backupUploadInput').click()">⬆️ Upload Backup</button>
          <input type="file" id="backupUploadInput" accept=".json,application/json" style="display:none" onchange="uploadBackup(this)">
          <button class="btn btn-ghost" onclick="loadBackups()">🔄 Refresh</button>
        </div>

        <!-- ── Backup Settings Panel ── -->
        <div id="backupSettingsPanel" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:18px 20px;margin-bottom:16px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
            <h3 style="font-size:.95rem;font-weight:700;color:var(--text)">⚙️ Backup Schedule Settings</h3>
            <div style="display:flex;gap:8px">
              <button class="btn btn-ghost" onclick="loadBackupSettings()" style="padding:5px 12px;font-size:.8rem">↻ Reload</button>
              <button class="btn btn-primary" onclick="saveBackupSettings()" style="padding:5px 14px;font-size:.8rem">💾 Save Settings</button>
            </div>
          </div>

          <!-- Auto Backup row -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px">
              <div style="font-size:.8rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">🕐 Auto Backup</div>
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:10px">
                <div style="position:relative;display:inline-block;width:44px;height:24px">
                  <input type="checkbox" id="cfg-autoBackup" style="opacity:0;width:0;height:0;position:absolute" onchange="updateToggleStyle('cfg-autoBackup','toggle-autoBackup')">
                  <span id="toggle-autoBackup" style="position:absolute;cursor:pointer;inset:0;background:var(--surface2);border-radius:24px;transition:.3s">
                    <span style="position:absolute;height:18px;width:18px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.3s;display:block" id="knob-autoBackup"></span>
                  </span>
                </div>
                <span style="font-size:.9rem;font-weight:600" id="label-autoBackup">ON</span>
              </label>
              <div>
                <label for="cfg-interval" style="font-size:.8rem;color:var(--muted);display:block;margin-bottom:4px">Interval</label>
                <select id="cfg-interval" style="width:100%;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:.875rem">
                  <option value="5">Every 5 minutes</option>
                  <option value="15">Every 15 minutes</option>
                  <option value="30">Every 30 minutes</option>
                  <option value="60" selected>Every hour</option>
                  <option value="120">Every 2 hours</option>
                  <option value="360">Every 6 hours</option>
                  <option value="720">Every 12 hours</option>
                  <option value="1440">Every 24 hours</option>
                </select>
              </div>
            </div>

            <!-- Auto Delete row -->
            <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px">
              <div style="font-size:.8rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">🗑️ Auto Delete</div>
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:10px">
                <div style="position:relative;display:inline-block;width:44px;height:24px">
                  <input type="checkbox" id="cfg-autoDelete" style="opacity:0;width:0;height:0;position:absolute" onchange="updateToggleStyle('cfg-autoDelete','toggle-autoDelete')">
                  <span id="toggle-autoDelete" style="position:absolute;cursor:pointer;inset:0;background:var(--surface2);border-radius:24px;transition:.3s">
                    <span style="position:absolute;height:18px;width:18px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.3s;display:block" id="knob-autoDelete"></span>
                  </span>
                </div>
                <span style="font-size:.9rem;font-weight:600" id="label-autoDelete">OFF</span>
              </label>
              <div>
                <label for="cfg-deleteDays" style="font-size:.8rem;color:var(--muted);display:block;margin-bottom:4px">Keep last N backups</label>
                <div style="display:flex;align-items:center;gap:8px">
                  <input type="number" id="cfg-deleteDays" min="1" max="9999" value="4"
                    style="flex:1;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:.875rem">
                  <span style="font-size:.85rem;color:var(--muted);white-space:nowrap">backups</span>
                </div>
              </div>
              <div style="margin-top:10px">
                <button class="btn btn-danger" onclick="runDeleteOldNow()" style="width:100%;padding:7px;font-size:.8rem">
                  🗑 Apply Limit Now
                </button>
              </div>
            </div>
          </div>

          <div id="settingsMsg" style="display:none;margin-top:10px;padding:8px 12px;border-radius:6px;font-size:.85rem"></div>
        </div>

        <!-- Backup list -->
        <div id="backupList"></div>
      </div>

      <!-- HEALTH -->
      <div class="page" id="page-health">
        <h2 style="font-size:1.1rem;font-weight:700;margin-bottom:16px">Server Health</h2>
        <div class="health-grid" id="healthGrid"></div>
      </div>
      <div class="page" id="page-debug">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:16px">
          <h2 style="font-size:1.1rem;font-weight:700">Debug Log</h2>
          <div style="display:flex;align-items:center;gap:8px;font-size:.8rem;color:var(--muted)">
            <span>Keep last</span>
            <input id="logRetentionDays" type="number" min="1" value="4" onchange="saveLogRetention()"
              style="width:56px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--fg)">
            <span>days</span>
            <button class="btn btn-danger" style="font-size:.78rem" onclick="deleteAllLogs()">🗑️ Delete All</button>
          </div>
        </div>

        <div class="card" style="padding:14px;margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px">
            <h3 style="font-size:.95rem;font-weight:700">Live — today's log</h3>
            <div style="display:flex;align-items:center;gap:10px">
              <label style="display:flex;align-items:center;gap:5px;font-size:.75rem;color:var(--muted);cursor:pointer;user-select:none">
                <input type="checkbox" id="liveLogToggle" checked onchange="toggleLiveLog(this.checked)">
                Auto-refresh
              </label>
              <button class="btn btn-ghost" style="padding:4px 10px;font-size:.72rem" onclick="loadLiveLog()">🔄 Refresh</button>
            </div>
          </div>
          <div id="liveLogBox" style="background:#0f172a;border-radius:8px;padding:10px;max-height:288px;overflow-y:auto">
            <p style="text-align:center;color:#6b7280;font-size:.78rem;padding:16px 0">Loading…</p>
          </div>
        </div>

        <p style="color:var(--muted);font-size:.78rem;margin-bottom:14px">Everything the server logs to its console — sync results, migrations, backups, deletes, cascade cleanups — captured to a file per day. Download a day and share it here if you need help debugging something.</p>
        <div id="logsList"></div>
      </div>
    </main>
  </div>
</div>

<!-- RECORD DETAIL MODAL -->
<div class="modal-bg" id="recordModal">
  <div class="modal">
    <div class="modal-header">
      <div class="modal-title" id="modalTitle">Record Detail</div>
      <button class="btn btn-ghost" onclick="closeModal()" style="padding:4px 10px">✕</button>
    </div>
    <div class="modal-body"><pre class="json" id="modalJson"></pre></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="modalToggleFull" onclick="toggleFullJson()" style="margin-right:auto"></button>
      <button class="btn btn-danger" id="modalDelete" onclick="deleteFromModal()">🗑️ Delete Record</button>
      <button class="btn btn-ghost" onclick="closeModal()">Close</button>
    </div>
  </div>
</div>

<!-- CONFIRM MODAL -->
<div class="modal-bg" id="confirmModal">
  <div class="modal" style="max-width:400px">
    <div class="modal-header"><div class="modal-title" id="confirmTitle">Confirm</div></div>
    <div class="modal-body"><p id="confirmMsg" style="color:var(--muted);font-size:.875rem;line-height:1.6"></p></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="confirmResolve(false)">Cancel</button>
      <button class="btn btn-danger" onclick="confirmResolve(true)" id="confirmOk">Delete</button>
    </div>
  </div>
</div>

<!-- SW CATEGORY ITEMS MODAL -->
<div class="modal-bg" id="itemsModal">
  <div class="modal" style="max-width:560px">
    <div class="modal-header">
      <div class="modal-title" id="itemsModalTitle">Items</div>
      <button class="btn btn-ghost" onclick="closeItemsModal()" style="padding:4px 10px">✕</button>
    </div>
    <div class="modal-body" id="itemsModalBody" style="max-height:60vh;overflow-y:auto"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeItemsModal()">Close</button>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
const ICONS = {
  users:'👤', clients:'🏢', inspections:'🔍', maps:'🗺️', categories:'🏷️',
  reports:'📄', coverTemplates:'📋',
  sweepAreas:'🗺️', sweepRoads:'🛣️', sweepZones:'🅿️', sweepJobs:'🧹', sweepClients:'🏗️',
  sweepJobSites:'📍', sweepFiles:'📎', sweepCategories:'🏷️', sweepMaps:'🗺️', sweepReports:'📊',
};
const COL_LABELS = {
  users:'Users', clients:'Clients', inspections:'Inspections', maps:'Maps',
  categories:'Categories', reports:'Reports', coverTemplates:'Cover Templates',
  sweepAreas:'SW Areas', sweepRoads:'SW Roads', sweepZones:'SW Zones', sweepJobs:'SW Jobs',
  sweepClients:'SW Clients', sweepJobSites:'Job Sites', sweepFiles:'SW Files',
  sweepCategories:'SW Categories', sweepMaps:'SW Maps', sweepReports:'SW Reports',
};

let TOKEN = '';
let state = { health: null, collections: {}, currentCol: '', colData: [], page: 0, pageSize: 25 };
let confirmResolve = () => {};

const STORAGE_KEY = 'rsw_dashboard_token';

// ── Auth ────────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'X-Sync-Token': TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401) { doLogout(); throw new Error('Unauthorised'); }
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(e.error || 'Request failed');
  }
  return res.json();
}

async function doLogin() {
  const t = document.getElementById('tokenInput').value.trim();
  if (!t) return;
  TOKEN = t;
  try {
    const h = await api('/health');
    // Save token so the dashboard stays logged in across refreshes
    try { localStorage.setItem(STORAGE_KEY, TOKEN); } catch(e) {}
    document.getElementById('svrVer').textContent = h.version || '?';
    document.getElementById('loginErr').textContent = '';
    document.getElementById('login').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    refreshAll();
    startAutoRefresh();
  } catch {
    document.getElementById('loginErr').textContent = '❌ Invalid token or server unreachable';
    TOKEN = '';
  }
}
document.getElementById('tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

// ── Auto-login on page load if token is saved ────────────────────────────────
(async function autoLogin() {
  // Load server version on login screen first
  fetch('/health').then(r=>r.json()).then(h=>{
    document.getElementById('svrVer').textContent = h.version || '?';
  }).catch(()=>{});

  let saved = '';
  try { saved = localStorage.getItem(STORAGE_KEY) || ''; } catch(e) {}
  if (!saved) return; // No saved token — show login screen

  TOKEN = saved;
  try {
    const h = await api('/health');
    document.getElementById('svrVer').textContent = h.version || '?';
    document.getElementById('login').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    refreshAll();
    startAutoRefresh();
  } catch {
    // Saved token is invalid — clear it and show login screen
    try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
    TOKEN = '';
  }
})();

function doLogout() {
  TOKEN = '';
  stopAutoRefresh();
  stopLiveLog();
  // Clear saved token so login screen is shown next time
  try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
  document.getElementById('app').style.display = 'none';
  document.getElementById('login').style.display = 'flex';
  document.getElementById('tokenInput').value = '';
}

// ── Navigation ───────────────────────────────────────────────────────────────
function showPage(name, colName) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const pageEl = name === 'collection'
    ? document.getElementById('page-collection')
    : document.getElementById('page-' + name);
  if (pageEl) pageEl.classList.add('active');
  const navEl = colName
    ? document.querySelector('[data-col="'+colName+'"]')
    : document.querySelector('[data-page="'+name+'"]');
  if (navEl) navEl.classList.add('active');

  if (name === 'collection' && colName) {
    state.currentCol = colName;
    state.page = 0;
    document.getElementById('colTitle').textContent = (ICONS[colName] || '📦') + ' ' + (COL_LABELS[colName] || colName);
    document.getElementById('colSearch').value = '';
    loadCollection();
  }
  if (name === 'backups') { loadBackups(); loadBackupSettings(); }
  if (name === 'health') loadHealth();
  if (name === 'debug') { loadLogs(); toggleLiveLog(document.getElementById('liveLogToggle')?.checked ?? true); }
  else stopLiveLog(); // leaving the Debug page — no point polling a hidden panel
}

// ── Refresh ──────────────────────────────────────────────────────────────────
let autoRefreshTimer = null;

async function refreshAll() {
  try {
    state.health = await api('/health');
    renderDashboard();
    buildNav();
    const now = new Date().toLocaleTimeString();
    document.getElementById('headerMeta').textContent =
      'v' + (state.health.version || '?') + ' · ' + (state.health.hasData ? 'Data loaded' : 'No data') + ' · Updated ' + now;

    // Also reload whichever page is currently visible so data stays fresh.
    // v71.2 BUG FIX: loadBackupSettings() deliberately NOT called here. This
    // block fires every 30s while the Backups tab is open — calling
    // loadBackupSettings() would overwrite the "Keep last N backups" input
    // (and the Auto Delete toggle) with whatever's currently saved on the
    // server. If the user has typed a new limit but hasn't clicked
    // "💾 Save Settings" yet, that silently wiped their edit back to the old
    // value, which looked exactly like the new limit "isn't saving". The
    // settings form now only (re)loads on explicit navigation to the page
    // (showPage) or the ↻ Reload button — never on the passive timer.
    const activePage = document.querySelector('.page.active');
    if (activePage) {
      const pid = activePage.id;
      if (pid === 'page-collection' && state.currentCol) loadCollection();
      else if (pid === 'page-backups') loadBackups(); // v71.2: settings form no longer auto-refreshed (see below)
      else if (pid === 'page-health') loadHealth();
    }
  } catch (e) { toast('Failed to load: ' + e.message, 'error'); }
}

// Auto-refresh every 30 seconds to keep sync status current
function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer = setInterval(() => {
    // Only refresh if not in the middle of an operation (modal open)
    if (!document.getElementById('recordModal').classList.contains('open') &&
        !document.getElementById('confirmModal').classList.contains('open')) {
      refreshAll();
    }
  }, 30000);
}
function stopAutoRefresh() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
}

// ── Dashboard ────────────────────────────────────────────────────────────────
function renderDashboard() {
  const h = state.health;
  if (!h) return;
  const cols = h.collections || {};
  const grid = document.getElementById('statsGrid');
  const ALL_COLS = Object.keys(ICONS);
  grid.innerHTML = ALL_COLS.map(col => {
    const count = cols[col] ?? 0;
    return \`<div class="stat-card" onclick="showPage('collection','\${col}')">
      <div class="icon">\${ICONS[col]||'📦'}</div>
      <div class="count">\${count}</div>
      <div class="label">\${COL_LABELS[col]||col}</div>
    </div>\`;
  }).join('');

  const qh = document.getElementById('quickHealth');
  const disk = h.disk;
  const diskPct = disk ? Math.round(disk.used/disk.total*100) : null;
  const fmtBytes = b => b > 1e9 ? (b/1e9).toFixed(1)+'GB' : b > 1e6 ? (b/1e6).toFixed(1)+'MB' : (b/1e3).toFixed(0)+'KB';
  qh.innerHTML = \`
    <div class="health-card">
      <h3>Server</h3>
      <div class="kv"><span class="k">Status</span><span class="v ok">Online ✓</span></div>
      <div class="kv"><span class="k">Schema</span><span class="v">\${h.schemaVersion||'?'}</span></div>
      <div class="kv"><span class="k">Data hash</span><span class="v" style="font-family:monospace;font-size:.7rem">\${h.dataHash||'—'}</span></div>
      <div class="kv"><span class="k">Records</span><span class="v">\${Object.values(cols).reduce((a,b)=>a+b,0)}</span></div>
    </div>
    \${disk ? \`<div class="health-card">
      <h3>Disk</h3>
      <div class="kv"><span class="k">Used</span><span class="v \${diskPct>90?'err':diskPct>70?'warn':''}">\${diskPct}%</span></div>
      <div class="kv"><span class="k">Free</span><span class="v">\${fmtBytes(disk.available)}</span></div>
      <div class="kv"><span class="k">Total</span><span class="v">\${fmtBytes(disk.total)}</span></div>
      <div class="disk-bar"><div class="disk-fill \${diskPct>90?'crit':diskPct>70?'warn':''}" style="width:\${diskPct}%"></div></div>
    </div>\` : ''}
    <div class="health-card">
      <h3>Backups</h3>
      <div class="kv"><span class="k">Count</span><span class="v">\${h.backup?.count??0}</span></div>
      <div class="kv"><span class="k">Interval</span><span class="v">\${h.backup?.intervalMinutes??60} min</span></div>
      <div class="kv"><span class="k">Latest</span><span class="v" style="font-size:.7rem;font-family:monospace">\${h.backup?.latest?(h.backup.latest.filename||String(h.backup.latest)).replace('rsw-server-backup-','').replace('.json',''):'None'}</span></div>
      <div class="kv"><span class="k">Data size</span><span class="v">\${h.dataFileSize?fmtBytes(h.dataFileSize):'—'}</span></div>
    </div>
    <div class="health-card">
      <h3>Migration</h3>
      <div class="kv"><span class="k">Needed</span><span class="v \${h.migration?.needsMigration?'warn':'ok'}">\${h.migration?.needsMigration?'Yes — run /migrate':'None ✓'}</span></div>
      <div class="kv"><span class="k">Drift keys</span><span class="v">\${h.drift?.unknownKeys?.length||0}</span></div>
    </div>\`;
}

// ── Nav ──────────────────────────────────────────────────────────────────────
const NAV_SECTIONS = [
  {
    label: 'Road Sweeping',
    cols: ['sweepJobs','sweepAreas','sweepRoads','sweepZones','sweepMaps','sweepReports','sweepCategories','sweepJobSites','sweepFiles','sweepClients'],
  },
  {
    label: 'Site & Road Inspections',
    cols: ['inspections','maps','reports','categories','clients','coverTemplates'],
  },
  {
    label: 'App System',
    cols: ['users'],
  },
];

function buildNav() {
  const cols = state.health?.collections || {};
  const nav = document.getElementById('navCollections');
  nav.innerHTML = NAV_SECTIONS.map(section => {
    const items = section.cols
      .filter(col => ICONS[col] !== undefined || cols[col] !== undefined)
      .map(col => \`<div class="nav-item" data-page="collection" data-col="\${col}" onclick="showPage('collection','\${col}')">
        <span>\${ICONS[col]||'📦'} \${COL_LABELS[col]||col}</span>
        <span class="badge">\${cols[col]??0}</span>
      </div>\`).join('');
    if (!items) return '';
    return \`<div class="nav-section">\${section.label}</div>\${items}\`;
  }).join('');
  document.getElementById('badgeBackups').textContent = state.health?.backup?.count ?? '—';
}

// ── Collection browser ────────────────────────────────────────────────────────
async function loadCollection() {
  document.getElementById('colBody').innerHTML = '<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--muted)">Loading…</td></tr>';
  try {
    const res = await api('/data/' + state.currentCol);
    state.colData = res.records || res.data || [];
    renderTable();
  } catch(e) {
    document.getElementById('colBody').innerHTML = \`<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--red)">\${e.message}</td></tr>\`;
  }
}

function renderTable() {
  const isSwCat = state.currentCol === 'sweepCategories';
  const catFilterEl = document.getElementById('colCatFilter');
  const restoreBtn  = document.getElementById('btnRestoreDefaults');
  if (restoreBtn) restoreBtn.style.display = isSwCat ? '' : 'none';

  // Build/refresh the Categories-type filter dropdown (SW Categories only)
  if (isSwCat) {
    const typesPresent = [...new Set(state.colData.map(r => r.categoryType || 'custom'))];
    const orderedTypes = Object.keys(SW_CAT_META).filter(t => typesPresent.includes(t));
    typesPresent.forEach(t => { if (!orderedTypes.includes(t)) orderedTypes.push(t); });
    const prevValue = catFilterEl.value || 'all';
    catFilterEl.innerHTML = '<option value="all">All Categories</option>' +
      orderedTypes.map(t => {
        const meta = SW_CAT_META[t] || { icon: '📦', label: t };
        return \`<option value="\${t}">\${meta.icon} \${meta.label}</option>\`;
      }).join('');
    catFilterEl.value = [...catFilterEl.options].some(o => o.value === prevValue) ? prevValue : 'all';
    catFilterEl.style.display = '';
  } else {
    catFilterEl.style.display = 'none';
    catFilterEl.innerHTML = '';
  }

  const q = document.getElementById('colSearch').value.toLowerCase();
  let rows = state.colData.filter(r => !q || JSON.stringify(r).toLowerCase().includes(q));
  if (isSwCat && catFilterEl.value !== 'all') {
    rows = rows.filter(r => (r.categoryType || 'custom') === catFilterEl.value);
  }
  const total = rows.length;
  const pg = Math.min(state.page, Math.floor((total-1)/state.pageSize) || 0);
  state.page = pg;
  const slice = rows.slice(pg * state.pageSize, (pg+1) * state.pageSize);

  // ── Columns ──
  // SW Categories gets a fixed layout matching the Site & Road Inspections
  // Categories table: ID, Name, Categories (type), Created-At, Updated-At, Actions.
  let cols;
  if (isSwCat) {
    cols = ['id', 'name', 'categoryType', 'createdAt', 'updatedAt'];
  } else {
    // Auto-detect columns from first few records (unchanged generic behaviour)
    const sampleKeys = new Set();
    rows.slice(0, 5).forEach(r => Object.keys(r).forEach(k => sampleKeys.add(k)));
    const priority = ['id','name','title','type','status','email','date','createdAt','updatedAt'];
    const allKeys = [...sampleKeys];
    cols = priority.filter(k => allKeys.includes(k)).slice(0, 5);
    if (cols.length < 3) allKeys.filter(k => !cols.includes(k) && k !== 'id').slice(0,3-cols.length).forEach(k => cols.push(k));
    if (!cols.includes('id') && allKeys.includes('id')) cols.unshift('id');
  }

  // SW Categories column semantics (per Craig — 2026-07-02):
  //   "Name" column      -> the categoryType's fixed label (e.g. "⚠️ Damage Types")
  //                          so you always know which section a list belongs to.
  //   "List Name" column -> the record's own editable name (e.g. "Damage and
  //                          points of interest"), plus item count. This used to
  //                          show a generic "Custom" tag derived from categoryType,
  //                          which was redundant with the Name column and never
  //                          reflected the record's actual list name.
  const COL_LABEL_OVERRIDE = isSwCat
    ? { id:'ID', name:'Name', categoryType:'List Name', createdAt:'Created-At', updatedAt:'Updated-At' }
    : { id:'ID', name:'Name', categoryType:'Categories', createdAt:'Created-At', updatedAt:'Updated-At' };
  const head = document.getElementById('colHead');
  head.innerHTML = '<tr>' + cols.map(k => \`<th>\${COL_LABEL_OVERRIDE[k] || k}</th>\`).join('') + '<th>Actions</th></tr>';

  const fmtDate = v => {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d) ? String(v) : d.toLocaleString();
  };

  const body = document.getElementById('colBody');
  if (!slice.length) {
    body.innerHTML = \`<tr><td colspan="\${cols.length+1}"><div class="empty"><div class="icon">📭</div><div>No records found</div></div></td></tr>\`;
  } else {
    body.innerHTML = slice.map(r => {
      const cells = cols.map(k => {
        if (isSwCat && k === 'name') {
          // "Name" column now shows the fixed section this list belongs to
          // (categoryType), not the record's own editable name.
          const meta = SW_CAT_META[r.categoryType] || { icon: '📦', label: r.categoryType || 'Custom' };
          return \`<td><span class="tag tag-blue">\${meta.icon} \${meta.label}</span></td>\`;
        }
        if (isSwCat && k === 'categoryType') {
          // "List Name" column shows the record's own name + item count.
          // Clicking "📋 Items" (in Actions) expands the actual item rows —
          // matching the app's SW Categories view (list name -> items below it).
          const itemCount = Array.isArray(r.items) ? r.items.length : 0;
          const listName = r.name || '(unnamed list)';
          return \`<td><span style="font-weight:600;color:var(--fg)">\${listName}</span> <span style="color:var(--muted);font-size:.72rem">(\${itemCount} item\${itemCount!==1?'s':''})</span></td>\`;
        }
        if (isSwCat && (k === 'createdAt' || k === 'updatedAt')) {
          const f = fmtDate(r[k]);
          return f ? \`<td style="font-size:.78rem">\${f}</td>\` : \`<td style="color:var(--muted)">—</td>\`;
        }
        const v = r[k];
        if (v === null || v === undefined || v === '') return \`<td style="color:var(--muted)">—</td>\`;
        if (typeof v === 'boolean') return \`<td><span class="tag \${v?'tag-green':'tag-red'}">\${v?'Yes':'No'}</span></td>\`;
        if (Array.isArray(v)) return \`<td><span class="tag tag-blue">\${v.length} items</span></td>\`;
        if (typeof v === 'object') return \`<td><span class="tag tag-blue">object</span></td>\`;
        const str = String(v);
        if (str.length > 50) return \`<td title="\${str.replace(/"/g,'&quot;')}">\${str.slice(0,48)}…</td>\`;
        return \`<td>\${str}</td>\`;
      }).join('');
      return \`<tr>\${cells}<td>
        <button class="btn btn-ghost" style="padding:3px 8px;font-size:.72rem" onclick='showRecord(\${JSON.stringify(JSON.stringify(r))})'>👁 View</button>
        \${isSwCat ? \`<button class="btn btn-ghost" style="padding:3px 8px;font-size:.72rem;margin-left:4px" onclick='showItemsModal("\${r.id}")'>📋 Items (\${Array.isArray(r.items)?r.items.length:0})</button>\` : ''}
        <button class="btn btn-danger" style="padding:3px 8px;font-size:.72rem;margin-left:4px" onclick='deleteRecord("\${state.currentCol}","\${r.id}")'>🗑</button>
      </td></tr>\`;
    }).join('');
  }

  // Pagination
  const pg_el = document.getElementById('colPagination');
  const totalPg = Math.ceil(total / state.pageSize);
  pg_el.innerHTML = total > state.pageSize ? \`
    <span class="pg-info">\${q ? rows.length + ' of ' + state.colData.length : total} records — Page \${pg+1} of \${totalPg}</span>
    <button class="pg-btn" onclick="state.page--;renderTable()" \${pg===0?'disabled':''}>← Prev</button>
    <button class="pg-btn" onclick="state.page++;renderTable()" \${pg>=totalPg-1?'disabled':''}>Next →</button>
  \` : \`<span class="pg-info">\${total} record\${total!==1?'s':''}\${q?' matching':''}</span>\`;
}

// ── SW Categories grouped view ────────────────────────────────────────────────
const SW_CAT_META = {
  damage_type:     { icon:'⚠️',  label:'Damage Types' },
  damage_severity: { icon:'🔴',  label:'Damage Severity' },
  debris_type:     { icon:'🌿',  label:'Debris Types' },
  debris_level:    { icon:'📊',  label:'Debris Levels' },
  zone_type:       { icon:'🗺️',  label:'Zone Types' },
  zone_kind:       { icon:'📍',  label:'Zone Type' }, // v73.51
  frequency:       { icon:'🔁',  label:'Sweep Frequencies' },
  crew_member:     { icon:'👷',  label:'Crew Members / Roles' },
  equipment:       { icon:'🚛',  label:'Equipment & Vehicles' },
  pass_count:      { icon:'🔢',  label:'Pass Counts' },
  site_type:       { icon:'📍',  label:'Site Types' },
  file_attachment: { icon:'📎',  label:'File Attachment Types' },
  weather:         { icon:'🌤️',  label:'Weather Conditions' },
  extra_expense:   { icon:'💵',  label:'Extra Expenses' },
  job_site_map_pin:{ icon:'📌',  label:'Job Sites Map Pins' },
  custom:          { icon:'⚙️',  label:'Custom' },
};

// ── SW Categories per-item management ────────────────────────────────────────
// Items modal: lists every item inside a category record with an inline ✕ delete.
// Triggered from the "📋 Items" action button on each SW Categories table row.
function showItemsModal(catId) {
  const rec = state.colData.find(r => r.id === catId);
  if (!rec) { toast('Category not found — try refreshing', 'error'); return; }
  const items = Array.isArray(rec.items) ? rec.items : [];
  const meta = SW_CAT_META[rec.categoryType] || { icon: '📦', label: rec.categoryType || 'Custom' };

  const rows = items.length === 0
    ? '<div style="color:var(--muted);font-size:.82rem;font-style:italic;padding:12px 0">No items in this list yet — items sync from the app.</div>'
    : items.map((item, idx) => \`
        <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">
          <span style="width:11px;height:11px;border-radius:50%;background:\${item.color||'#6366f1'};display:inline-block;flex-shrink:0"></span>
          <span style="font-size:.85rem;color:var(--fg);flex:1">\${item.name || '(unnamed)'}
            \${item.description ? \`<span style="color:var(--muted);font-size:.75rem"> — \${item.description}</span>\` : ''}
          </span>
          <button class="btn btn-danger" style="padding:2px 9px;font-size:.72rem" onclick='deleteSwCatItem("\${catId}", \${idx})' title="Remove this item from the list">✕</button>
        </div>\`).join('');

  const modal = document.getElementById('itemsModal');
  document.getElementById('itemsModalTitle').textContent = \`\${meta.icon} \${rec.name} — \${items.length} item\${items.length!==1?'s':''}\`;
  document.getElementById('itemsModalBody').innerHTML = rows;
  modal.classList.add('open');
}
function closeItemsModal() { document.getElementById('itemsModal').classList.remove('open'); }

async function deleteSwCatItem(catId, itemIdx) {
  const rec = state.colData.find(r => r.id === catId);
  if (!rec) { toast('Category not found — try refreshing', 'error'); return; }
  const items = Array.isArray(rec.items) ? [...rec.items] : [];
  const item  = items[itemIdx];
  if (!item) { toast('Item not found', 'error'); return; }
  const ok = await confirm2(\`Remove item <strong>\${item.name}</strong> from list <strong>\${rec.name}</strong>?<br><br>This only removes it from this list — re-sync from the app will restore it if the app still has it.\`);
  if (!ok) return;
  items.splice(itemIdx, 1);
  const updated = { ...rec, items, updatedAt: new Date().toISOString() };
  try {
    await api(\`/data/sweepCategories/\${catId}\`, { method: 'PUT', body: JSON.stringify(updated) });
    toast(\`✅ Removed "\${item.name}" from "\${rec.name}"\`, 'success');
    await loadCollection();
    showItemsModal(catId); // refresh the modal in place rather than closing it
  } catch(e) { toast('Remove failed: ' + e.message, 'error'); }
}


async function clearCollection() {
  const ok = await confirm2(\`Delete ALL records in <strong>\${COL_LABELS[state.currentCol]||state.currentCol}</strong>?<br><br>This cannot be undone. A backup will be created first.\`);
  if (!ok) return;
  try {
    await createBackup();
    // Delete one by one (no bulk delete endpoint)
    let deleted = 0;
    for (const r of state.colData) {
      if (r.id) { await api('/data/'+state.currentCol+'/'+r.id, {method:'DELETE'}); deleted++; }
    }
    toast(\`🗑️ Deleted \${deleted} records from \${COL_LABELS[state.currentCol]||state.currentCol}\`, 'success');
    loadCollection();
    refreshAll();
  } catch(e) { toast('Delete failed: '+e.message,'error'); }
}

async function restoreDefaultSweepCategories() {
  try {
    const res = await api('/sweep-categories/restore-defaults', { method: 'POST' });
    if (res.restored && res.restored.length > 0) {
      toast(\`♻️ Restored \${res.restored.length} missing list(s): \${res.restored.map(r => r.name).join(', ')}\`, 'success');
    } else {
      toast('✅ All 15 built-in lists are already present.', 'success');
    }
    loadCollection();
    refreshAll();
  } catch(e) { toast('Restore failed: ' + e.message, 'error'); }
}

// ── Record modal ─────────────────────────────────────────────────────────────
let modalRecord = null;
// v73.39 -- Craig: "host-server not show all data when clicking view this is
// after V73.12... when select-roads-mode was added." Root cause: this modal
// always did a raw JSON.stringify(record, null, 2) straight into a <pre>
// element. That was fine for the record sizes this dashboard was built
// around, but Select Roads/Lasso (v73.12) lets a single road accumulate
// thousands of points across its segments -- pretty-printing that produces
// a multi-hundred-KB (sometimes multi-MB) string and asking the browser to
// lay out tens of thousands of lines of text in one go. On typical dev
// hardware that's just slow; on older/weaker hardware (see the lag reports
// around this same v73.12+ line of work) it can appear to hang or simply
// never finish rendering -- which looks exactly like "not showing all data"
// even though nothing was actually being hidden or dropped. Fixed by
// summarizing large arrays by default (fast to render, shows array length +
// first/last few items) with a one-click toggle to the complete, unmodified
// JSON when the full detail is actually needed -- the summarized view is a
// display convenience, never what gets sent anywhere or what Delete acts on.
// NOTE: no template-literal backticks anywhere in this block, including
// comments -- this whole dashboard page is itself built from ONE big
// template literal in server.js, so a stray backtick here would terminate
// THAT outer string early and corrupt the entire dashboard response.
var JSON_SUMMARY_ARRAY_THRESHOLD = 30;
function summariseForDisplay(value, depth) {
  if (depth === undefined) depth = 0;
  if (Array.isArray(value)) {
    if (value.length > JSON_SUMMARY_ARRAY_THRESHOLD) {
      var head = value.slice(0, 3).map(function(v){ return summariseForDisplay(v, depth + 1); });
      var tail = value.slice(-2).map(function(v){ return summariseForDisplay(v, depth + 1); });
      var marker = '... ' + (value.length - 5) + ' more items (Array(' + value.length + ') total) -- click "Show Full JSON" for all of them ...';
      return head.concat([marker], tail);
    }
    return value.map(function(v){ return summariseForDisplay(v, depth + 1); });
  }
  if (value && typeof value === 'object') {
    var out = {};
    for (var k in value) if (Object.prototype.hasOwnProperty.call(value, k)) out[k] = summariseForDisplay(value[k], depth + 1);
    return out;
  }
  return value;
}

var modalShowingFull = false;
function renderModalJson() {
  var btn = document.getElementById('modalToggleFull');
  var display = modalShowingFull ? modalRecord : summariseForDisplay(modalRecord);
  document.getElementById('modalJson').textContent = JSON.stringify(display, null, 2);
  btn.textContent = modalShowingFull ? '\ud83d\udccb Show Summarized (faster)' : '\ud83d\udcc4 Show Full JSON';
}
function toggleFullJson() {
  modalShowingFull = !modalShowingFull;
  renderModalJson();
}
function showRecord(jsonStr) {
  modalRecord = JSON.parse(jsonStr);
  modalShowingFull = false;
  document.getElementById('modalTitle').textContent = modalRecord.name || modalRecord.title || modalRecord.id || 'Record';
  renderModalJson();
  document.getElementById('recordModal').classList.add('open');
}
function closeModal() {
  document.getElementById('recordModal').classList.remove('open');
  document.getElementById('confirmModal').classList.remove('open');
  modalRecord = null;
}
async function deleteFromModal() {
  if (!modalRecord?.id) return;
  const ok = await confirm2(\`Delete record <strong>\${modalRecord.name || modalRecord.title || modalRecord.id}</strong>?\`);
  if (!ok) return;
  await deleteRecord(state.currentCol, modalRecord.id);
  closeModal();
}
async function deleteRecord(col, id) {
  try {
    await api('/data/'+col+'/'+id, {method:'DELETE'});
    toast('🗑️ Record deleted', 'success');
    state.colData = state.colData.filter(r => r.id !== id);
    renderTable();
    refreshAll();
  } catch(e) { toast('Delete failed: '+e.message, 'error'); }
}
document.getElementById('recordModal').addEventListener('click', e => {
  if (e.target === document.getElementById('recordModal')) closeModal();
});

// ── Confirm dialog ───────────────────────────────────────────────────────────
function confirm2(msg) {
  return new Promise(resolve => {
    document.getElementById('confirmMsg').innerHTML = msg;
    document.getElementById('confirmModal').classList.add('open');
    confirmResolve = val => {
      document.getElementById('confirmModal').classList.remove('open');
      resolve(val);
    };
  });
}

// ── Backups ──────────────────────────────────────────────────────────────────
async function downloadBackup(filename) {
  try {
    toast('⬇ Downloading…', 'info');
    const res = await fetch('/backup/' + filename, {
      headers: { 'X-Sync-Token': TOKEN }
    });
    if (!res.ok) throw new Error('Download failed: ' + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('✅ Downloaded ' + filename, 'success');
  } catch(e) { toast('❌ Download failed: ' + e.message, 'error'); }
}

async function deleteBackup(filename) {
  const ok = await confirm2(\`Delete backup <strong>\${filename}</strong>?<br><small style="color:var(--muted)">This cannot be undone.</small>\`);
  if (!ok) return;
  try {
    const res = await fetch('/backup/' + filename, {
      method: 'DELETE',
      headers: { 'X-Sync-Token': TOKEN }
    });
    if (!res.ok) throw new Error('Delete failed');
    toast('🗑️ Backup deleted', 'success');
    loadBackups();
  } catch(e) { toast('❌ ' + e.message, 'error'); }
}

async function deleteOldBackups() {
  const keepN = parseInt(document.getElementById('cfg-deleteDays')?.value || '4', 10);
  const ok = await confirm2(\`Keep only the last <strong>\${keepN} backup\${keepN!==1?'s':''}</strong> and delete the rest?<br><small style="color:var(--muted)">This cannot be undone.<\/small>\`);
  if (!ok) return;
  try {
    const res = await api('/backup/prune?keep=' + keepN, { method: 'POST' });
    toast(\`🗑️ Deleted \${res.deleted || 0} old backup(s)\`, 'success');
    loadBackups();
  } catch(e) { toast('❌ ' + e.message, 'error'); }
}

async function viewBackup(filename) {
  const safe = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const panel = document.getElementById('backup-preview-' + safe);
  if (panel) { panel.remove(); return; }
  const row = document.getElementById('backup-row-' + safe);
  if (!row) return;
  const loading = document.createElement('div');
  loading.id = 'backup-preview-' + safe;
  loading.style.cssText = 'padding:16px 20px;background:var(--surface2);border-top:1px solid var(--border);font-size:.82rem;color:var(--muted)';
  loading.textContent = 'Loading preview…';
  row.after(loading);
  try {
    const s = await api('/backup/' + filename + '/preview');
    const c = s.counts || {};
    const fmtDate = d => d ? new Date(d).toLocaleString() : '—';
    const colRows = [
      ['👤 Users', c.users], ['👥 Clients', c.clients],
      ['🔍 Inspections', c.inspections], ['🗺 Maps', c.maps],
      ['📋 Reports', c.reports], ['📁 Categories', c.categories],
      ['🧹 Sweep Jobs', c.sweepJobs], ['🗺 Sweep Maps', c.sweepMaps],
      ['📍 Sweep Areas', c.sweepAreas], ['🛣 Sweep Roads', c.sweepRoads], ['🅿️ Sweep Zones', c.sweepZones],
      ['👥 Sweep Clients', c.sweepClients], ['📂 SW Job Sites', c.sweepJobSites],
      ['📎 SW Files', c.sweepFiles], ['🏷 SW Categories', c.sweepCategories],
    ].filter(([,n]) => n > 0);

    let html = \`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;margin-bottom:14px">\`;
    html += colRows.map(([label, n]) =>
      \`<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 12px;display:flex;justify-content:space-between;align-items:center">
        <span>\${label}</span><span style="font-weight:700;color:var(--accent)">\${n}</span>
      </div>\`
    ).join('');
    html += '</div>';

    if (s.recentInspections?.length) {
      html += \`<div style="margin-bottom:10px"><div style="font-weight:600;margin-bottom:6px;color:var(--text)">🔍 Recent Inspections</div><div style="display:flex;flex-direction:column;gap:4px">\`;
      html += s.recentInspections.map(i => \`
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 12px;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          <span style="font-weight:600;color:var(--text)">\${i.title||'Untitled'}</span>
          <span style="color:var(--muted);font-size:.78rem">\${i.site||''}</span>
          <span style="color:var(--muted);font-size:.78rem">\${fmtDate(i.date)}</span>
          \${i.photoCount ? \`<span style="color:var(--accent);font-size:.78rem">📷 \${i.photoCount}</span>\` : ''}
          \${i.pinCount   ? \`<span style="color:var(--accent);font-size:.78rem">📍 \${i.pinCount} pins</span>\` : ''}
          <span style="padding:2px 8px;border-radius:99px;font-size:.72rem;background:rgba(99,102,241,.15);color:var(--accent2)">\${i.status||'draft'}</span>
        </div>\`).join('');
      html += '</div></div>';
    }

    if (s.recentSweepJobs?.length) {
      html += \`<div style="margin-bottom:10px"><div style="font-weight:600;margin-bottom:6px;color:var(--text)">🧹 Recent Sweep Jobs</div><div style="display:flex;flex-direction:column;gap:4px">\`;
      html += s.recentSweepJobs.map(j => \`
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 12px;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          <span style="font-weight:600;color:var(--text)">\${j.jobNumber||'No #'}</span>
          <span style="color:var(--muted);font-size:.78rem">\${fmtDate(j.date)}</span>
          \${j.photoCount ? \`<span style="color:var(--accent);font-size:.78rem">📷 \${j.photoCount}</span>\` : ''}
          <span style="padding:2px 8px;border-radius:99px;font-size:.72rem;background:rgba(99,102,241,.15);color:var(--accent2)">\${j.status||'draft'}</span>
        </div>\`).join('');
      html += '</div></div>';
    }

    if (s.recentMaps?.length || s.recentSweepMaps?.length) {
      const allMaps = [...(s.recentMaps||[]).map(m=>({...m,type:'Inspection'})), ...(s.recentSweepMaps||[]).map(m=>({...m,type:'Sweep'}))];
      html += \`<div><div style="font-weight:600;margin-bottom:6px;color:var(--text)">🗺 Recent Maps</div><div style="display:flex;flex-direction:column;gap:4px">\`;
      html += allMaps.map(m => \`
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 12px;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          <span style="font-weight:600;color:var(--text)">\${m.name||'Untitled'}</span>
          <span style="padding:2px 8px;border-radius:99px;font-size:.72rem;background:rgba(16,185,129,.12);color:#34d399">\${m.type}</span>
          \${m.pinCount ? \`<span style="color:var(--accent);font-size:.78rem">📍 \${m.pinCount} pins</span>\` : ''}
          \${m.hasImage ? \`<span style="color:var(--muted);font-size:.78rem">🖼 Has image</span>\` : ''}
        </div>\`).join('');
      html += '</div></div>';
    }

    loading.innerHTML = html;
    loading.style.color = '';
  } catch(e) {
    loading.textContent = '⚠️ Preview failed: ' + e.message;
  }
}

// ── Backup Settings ──────────────────────────────────────────────────────────
function updateToggleStyle(checkId, toggleId) {
  const cb     = document.getElementById(checkId);
  const toggle = document.getElementById(toggleId);
  const knob   = document.getElementById('knob-' + checkId.replace('cfg-',''));
  const label  = document.getElementById('label-' + checkId.replace('cfg-',''));
  if (!toggle || !cb) return;
  const on = cb.checked;
  toggle.style.background   = on ? 'var(--accent)' : 'var(--surface2)';
  if (knob) knob.style.transform = on ? 'translateX(20px)' : 'translateX(0)';
  if (label) label.textContent  = on ? 'ON' : 'OFF';
}

async function loadBackupSettings() {
  try {
    const res = await api('/settings');
    const cfg = res.settings || {};
    const setChk = (id, val) => {
      const el = document.getElementById(id);
      if (el) { el.checked = !!val; updateToggleStyle(id, id.replace('cfg-','toggle-')); }
    };
    // Always coerce to string so <select> option matching works reliably
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = String(val); };
    setChk('cfg-autoBackup', cfg.autoBackup !== false);
    setChk('cfg-autoDelete', !!cfg.autoDelete);
    setVal('cfg-interval',    cfg.intervalMinutes ?? 60);
    setVal('cfg-deleteDays',  cfg.keepLastNAutoDelete ?? 4);
    showSettingsMsg('');
  } catch(e) { showSettingsMsg('Failed to load settings: ' + e.message, 'error'); }
}

async function saveBackupSettings() {
  const chk = id => { const el = document.getElementById(id); return el ? el.checked : false; };
  // Safe number read: parse the select/input value, fall back to the data-* attribute or
  // a known default — never fall back to 0 (which would get clamped to 5 minutes by the server).
  const num = (id, fallback) => {
    const el = document.getElementById(id);
    if (!el) return fallback;
    const v = parseInt(el.value, 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const settings = {
    autoBackup:          chk('cfg-autoBackup'),
    intervalMinutes:     num('cfg-interval', 60),       // fallback: 60 min (every hour)
    autoDelete:          chk('cfg-autoDelete'),
    keepLastNAutoDelete: num('cfg-deleteDays', 4),      // fallback: keep 4
  };
  try {
    await api('/settings', { method: 'POST', body: JSON.stringify(settings) });
    showSettingsMsg(\`✅ Settings saved — scheduler restarted (every \${settings.intervalMinutes} min)\`, 'success');
    setTimeout(() => showSettingsMsg(''), 4000);
    refreshAll();
  } catch(e) { showSettingsMsg('❌ Failed: ' + e.message, 'error'); }
}

async function runDeleteOldNow() {
  const keepN = parseInt(document.getElementById('cfg-deleteDays')?.value || '4', 10);
  const ok    = await confirm2(\`Keep only the last <strong>\${keepN} backup\${keepN!==1?'s':''}</strong> and delete the rest?<br><br>This cannot be undone.\`);
  if (!ok) return;
  try {
    const res = await api('/backup/prune?keep=' + keepN, { method: 'POST' });
    toast(\`🗑️ Deleted \${res.deleted || 0} old backup(s)\`, 'success');
    loadBackups();
  } catch(e) { toast('Delete failed: ' + e.message, 'error'); }
}

function showSettingsMsg(msg, type) {
  const el = document.getElementById('settingsMsg');
  if (!el) return;
  if (!msg) { el.style.display = 'none'; return; }
  el.style.display  = 'block';
  el.style.background = type === 'error' ? 'rgba(239,68,68,.15)' : type === 'success' ? 'rgba(16,185,129,.15)' : 'rgba(99,102,241,.15)';
  el.style.color    = type === 'error' ? 'var(--red)' : type === 'success' ? 'var(--green)' : 'var(--accent)';
  el.style.border   = \`1px solid \${type === 'error' ? 'var(--red)' : type === 'success' ? 'var(--green)' : 'var(--accent)'}\`;
  el.textContent    = msg;
}

async function loadBackups() {
  document.getElementById('backupList').innerHTML = '<div style="color:var(--muted);padding:20px">Loading…</div>';
  try {
    const res = await api('/backup/list');
    const backups = res.backups || res || [];
    document.getElementById('badgeBackups').textContent = backups.length;
    if (!backups.length) {
      document.getElementById('backupList').innerHTML = '<div class="empty"><div class="icon">💾</div><div>No backups yet</div></div>';
      return;
    }
    const fmtBytes = b => b > 1e6 ? (b/1e6).toFixed(1)+'MB' : (b/1e3).toFixed(0)+'KB';
    const fmtTs = fn => {
      // rsw-server-backup-2026-05-24_17-32-51.json → 24/05/2026 17:32:51 (includes seconds — unique per backup)
      const m = fn.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
      if (!m) return fn;
      return \`\${m[3]}/\${m[2]}/\${m[1]} \${m[4]}:\${m[5]}:\${m[6]}\`;
    };
    // Reason badge — shows WHY each backup was created (a scheduled hourly
    // tick, a sync that changed data, a manual click, a safety copy before a
    // restore/import/migration, etc.). Without this, several different
    // legitimate triggers landing close together looks like the Interval
    // setting isn't being respected, when really it's working fine alongside
    // other automatic safety backups.
    const reasonBadge = reason => {
      const map = {
        'scheduled':                  { icon: '⏰', label: 'Scheduled',     color: 'var(--accent)' },
        'post-sync':                  { icon: '🔄', label: 'Post-Sync',     color: 'var(--green)' },
        'manual-api':                 { icon: '✋', label: 'Manual',        color: 'var(--accent2)' },
        'pre-restore safety backup':  { icon: '🛡️', label: 'Pre-Restore',   color: 'var(--amber)' },
        'pre-import':                 { icon: '🛡️', label: 'Pre-Import',    color: 'var(--amber)' },
        'post-import':                { icon: '📥', label: 'Post-Import',   color: 'var(--green)' },
        'pre-export':                 { icon: '📤', label: 'Pre-Export',    color: 'var(--amber)' },
        'pre-overwrite':              { icon: '🛡️', label: 'Pre-Overwrite', color: 'var(--amber)' },
        'pre-migration':              { icon: '🛡️', label: 'Pre-Migration', color: 'var(--amber)' },
        'pre-auto-migration':         { icon: '🛡️', label: 'Pre-Migration', color: 'var(--amber)' },
        'shutdown':                   { icon: '🔌', label: 'Shutdown',      color: 'var(--muted)' },
      };
      const m = map[reason] || { icon: '❔', label: reason || 'Unknown', color: 'var(--muted)' };
      return \`<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:99px;font-size:.68rem;font-weight:600;background:color-mix(in srgb, \${m.color} 18%, transparent);color:\${m.color};margin-left:6px;vertical-align:middle">\${m.icon} \${m.label}</span>\`;
    };
    document.getElementById('backupList').innerHTML = backups.map(b => {
      const records = b.manifest?.totalRecords ?? '?';
      const safe = b.filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
      return \`<div id="backup-row-\${safe}" style="border:1px solid var(--border);border-radius:10px;margin-bottom:8px;overflow:hidden">
        <div class="backup-item" style="cursor:pointer" onclick="viewBackup('\${b.filename}')">
          <div style="font-size:1.5rem">💾</div>
          <div class="backup-info">
            <div class="backup-name">\${b.filename}\${reasonBadge(b.manifest?.reason)}</div>
            <div class="backup-meta">\${fmtTs(b.filename)} · \${fmtBytes(b.size)} · \${records} records · <span style="color:var(--accent);font-size:.72rem">click to preview ▾</span></div>
          </div>
          <div class="backup-actions" onclick="event.stopPropagation()">
            <button class="btn btn-ghost" style="padding:6px 12px;font-size:.8rem" onclick="downloadBackup('\${b.filename}')">⬇ Download</button>
            <button class="btn btn-primary" style="padding:6px 12px;font-size:.8rem" onclick="restoreBackup('\${b.filename}')">↺ Restore</button>
            <button class="btn btn-danger" style="padding:6px 12px;font-size:.8rem" onclick="deleteBackup('\${b.filename}')">🗑 Delete</button>
          </div>
        </div>
      </div>\`;
    }).join('');
  } catch(e) { document.getElementById('backupList').innerHTML = \`<div class="empty"><div class="icon">⚠️</div><div>\${e.message}</div></div>\`; }
}

async function createBackup() {
  try {
    const result = await api('/backup/now', {method:'POST'});
    toast('💾 Backup created: ' + (result.filename || 'done'), 'success');
    // Small delay so the filesystem has flushed the new file before we re-list
    await new Promise(r => setTimeout(r, 400));
    loadBackups();
    refreshAll();
  } catch(e) { toast('Backup failed: '+e.message,'error'); }
}

// v73.95 — reads a backup .json file picked from the operator's own
// computer and sends its parsed content to the new /backup/upload
// endpoint, which validates and adds it to this server's own backup
// list — same list Create Backup/Restore/Download/Delete all work on,
// no separate storage path. Resets the file input afterward so picking
// the exact same file twice in a row still fires onchange.
async function uploadBackup(inputEl) {
  const file = inputEl.files && inputEl.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch(e) { throw new Error('That file is not valid JSON.'); }
    const result = await api('/backup/upload', { method: 'POST', body: JSON.stringify(parsed) });
    toast('⬆️ Backup uploaded: ' + (result.filename || 'done'), 'success');
    await new Promise(r => setTimeout(r, 400));
    loadBackups();
    refreshAll();
  } catch(e) {
    toast('Upload failed: '+e.message,'error');
  } finally {
    inputEl.value = '';
  }
}

async function restoreBackup(filename) {
  const ok = await confirm2(\`Restore backup <strong>\${filename}</strong>?<br><br>⚠️ This will replace ALL current server data.<br>✅ A safety backup is created automatically before restoring.<br>🔄 Old data is auto-migrated to the current schema.\`);
  if (!ok) return;
  try {
    toast('Restoring…', 'info');
    const res = await api('/backup/'+filename+'/restore', {method:'POST'});
    let msg = '✅ Restored from ' + filename;
    if (res && res.safetyBackup) msg += ' · 🛡️ Safety: ' + res.safetyBackup;
    if (res && res.migrationApplied && res.migrationApplied.length > 0)
      msg += ' · 🔄 Migrated: ' + res.migrationApplied.join(', ');
    toast(msg, 'success');
    refreshAll();
  } catch(e) { toast('Restore failed: '+e.message,'error'); }
}

// ── Health detail ─────────────────────────────────────────────────────────────
async function loadHealth() {
  try {
    const [h, roadsStatus] = await Promise.all([
      api('/health'),
      api('/api/roads/status').catch(() => null), // don't let a roads-status hiccup blank the whole Health page
    ]);
    const fmtBytes = b => b > 1e9 ? (b/1e9).toFixed(1)+'GB' : b > 1e6 ? (b/1e6).toFixed(1)+'MB' : (b/1e3).toFixed(0)+'KB';
    const cols = h.collections || {};
    document.getElementById('healthGrid').innerHTML = \`
      <div class="health-card">
        <h3>Server Info</h3>
        <div class="kv"><span class="k">Status</span><span class="v ok">Online</span></div>
        <div class="kv"><span class="k">Schema Version</span><span class="v">\${h.schemaVersion||'?'}</span></div>
        <div class="kv"><span class="k">Data Hash</span><span class="v" style="font-family:monospace;font-size:.68rem">\${h.dataHash||'—'}</span></div>
        <div class="kv"><span class="k">Data File Size</span><span class="v">\${h.dataFileSize?fmtBytes(h.dataFileSize):'—'}</span></div>
        <div class="kv"><span class="k">Timestamp</span><span class="v" style="font-size:.72rem">\${new Date(h.timestamp).toLocaleString()}</span></div>
      </div>
      \${h.disk ? \`<div class="health-card">
        <h3>Disk Usage</h3>
        <div class="kv"><span class="k">Total</span><span class="v">\${fmtBytes(h.disk.total)}</span></div>
        <div class="kv"><span class="k">Used</span><span class="v">\${fmtBytes(h.disk.used)} (\${h.disk.percentage}%)</span></div>
        <div class="kv"><span class="k">Available</span><span class="v \${h.disk.percentage>90?'err':h.disk.percentage>70?'warn':'ok'}">\${fmtBytes(h.disk.available)}</span></div>
        <div class="disk-bar"><div class="disk-fill \${h.disk.percentage>90?'crit':h.disk.percentage>70?'warn':''}" style="width:\${h.disk.percentage}%"></div></div>
      </div>\` : ''}
      <div class="health-card">
        <h3>Backup Config</h3>
        <div class="kv"><span class="k">Interval</span><span class="v">\${h.backup?.intervalMinutes??60} minutes</span></div>
        <div class="kv"><span class="k">Max kept</span><span class="v">\${h.backup?.maxBackups??48}</span></div>
        <div class="kv"><span class="k">Count</span><span class="v">\${h.backup?.count??0}</span></div>
        <div class="kv"><span class="k">Latest</span><span class="v" style="font-size:.72rem;font-family:monospace">\${h.backup?.latest?(h.backup.latest.filename||String(h.backup.latest)).replace('rsw-server-backup-','').replace('.json',''):'None'}</span></div>
      </div>
      <div class="health-card">
        <h3>Collections</h3>
        \${Object.entries(cols).map(([k,v])=>\`<div class="kv"><span class="k">\${ICONS[k]||''} \${COL_LABELS[k]||k}</span><span class="v">\${v}</span></div>\`).join('')}
      </div>
      <div class="health-card">
        <h3>Schema / Migration</h3>
        <div class="kv"><span class="k">Migration needed</span><span class="v \${h.migration?.needsMigration?'warn':'ok'}">\${h.migration?.needsMigration?'Yes':'None ✓'}</span></div>
        <div class="kv"><span class="k">Drift keys</span><span class="v">\${(h.drift?.unknownKeys||[]).join(', ')||'None ✓'}</span></div>
        <div class="kv"><span class="k">Custom collections</span><span class="v">\${(h.customCollections||[]).join(', ')||'None'}</span></div>
      </div>
      <div class="health-card">
        <h3>Tombstones</h3>
        <div class="kv"><span class="k">Total</span><span class="v">\${h.tombstones?.count??0}</span></div>
        <div class="kv"><span class="k">Retention</span><span class="v">\${h.tombstones?.retentionDays??90} days</span></div>
        <div class="kv"><span class="k">Older than retention</span><span class="v \${(h.tombstones?.olderThanRetention||0)>0?'warn':'ok'}">\${h.tombstones?.olderThanRetention??0}</span></div>
        <div class="kv"><span class="k">Oldest</span><span class="v" style="font-size:.72rem">\${h.tombstones?.oldest?new Date(h.tombstones.oldest).toLocaleDateString():'—'}</span></div>
        \${h.tombstones?.byCollection && Object.keys(h.tombstones.byCollection).length ? \`<div class="kv" style="align-items:flex-start"><span class="k">By collection</span><span class="v" style="text-align:right;font-size:.72rem">\${Object.entries(h.tombstones.byCollection).map(([c,n])=>\`\${COL_LABELS[c]||c}: \${n}\`).join('<br>')}</span></div>\` : ''}
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px">
          <input id="tombstonePruneDays" type="number" min="0" value="\${h.tombstones?.retentionDays??90}" title="Delete tombstones older than this many days. 0 = delete all."
            style="width:60px;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:.875rem">
          <span style="color:var(--muted);font-size:.72rem;white-space:nowrap">days old</span>
          <button class="btn btn-danger" style="font-size:.78rem;white-space:nowrap;width:100%" onclick="pruneTombstones()">🧹 Prune Tombstones</button>
        </div>
        <div style="color:var(--muted);font-size:.68rem;margin-top:6px">Deletes tombstone entries older than the number of days above (0 = delete every tombstone). A backup is taken first. Built-in category lists can't be deleted (so can't be tombstoned) as of v71.8, so this is safe routine cleanup.</div>
      </div>
      \${roadsStatus ? \`<div class="health-card">
        <h3>Road Data (Select Roads)</h3>
        <div class="kv"><span class="k">Status</span><span class="v \${roadsStatus.loaded?'ok':'warn'}">\${roadsStatus.loaded?'Loaded':(roadsStatus.error==='not-found'?'Not loaded':'Error')}</span></div>
        <div class="kv"><span class="k">Roads indexed</span><span class="v">\${roadsStatus.featureCount||0}</span></div>
        <div class="kv"><span class="k">Loaded at</span><span class="v" style="font-size:.72rem">\${roadsStatus.loadedAt?new Date(roadsStatus.loadedAt).toLocaleString():'—'}</span></div>
        <div class="kv" style="align-items:flex-start"><span class="k">Operating bbox</span><span class="v" style="font-size:.68rem;font-family:monospace;max-width:65%">\${roadsStatus.bbox||'Not set — ROADS_BBOX'}</span></div>
        <div class="kv" style="align-items:flex-start"><span class="k">Last OSM auto-update</span><span class="v \${roadsStatus.lastUpdate?.lastError?'err':(roadsStatus.lastUpdate?.lastSuccess?'ok':'')}" style="font-size:.72rem;max-width:65%">\${roadsStatus.lastUpdate?.lastError ? '❌ '+roadsStatus.lastUpdate.lastError : (roadsStatus.lastUpdate?.lastSuccess ? new Date(roadsStatus.lastUpdate.lastSuccess).toLocaleString() : 'Never')}</span></div>
        <div style="display:flex;margin-top:12px">
          <button id="updateRoadsBtn" class="btn btn-primary" style="font-size:.78rem;white-space:nowrap;width:100%"\${roadsStatus.bboxConfigured?'':' disabled title="Set ROADS_BBOX in .env first"'} onclick="updateRoadsFromOsm()">🗺️ Update Road Data (OSM)</button>
        </div>
        <div style="color:var(--muted);font-size:.68rem;margin-top:6px">Fetches fresh road geometry for your operating area straight from OpenStreetMap (Overpass API) and reloads it — no separate machine, osmium-tool, or manual file copy needed. The previous roads.geojson is kept as a .bak first. For a first-time/large-area extract, or to avoid depending on a public Overpass server, extract-roads.sh + restore-road-data.sh still works exactly as before.</div>
      </div>\` : ''}\`;
  } catch(e) { document.getElementById('healthGrid').innerHTML = \`<div class="empty"><div class="icon">⚠️</div><div>\${e.message}</div></div>\`; }
}

async function pruneTombstones() {
  const input = document.getElementById('tombstonePruneDays');
  const days = Math.max(0, parseInt(input?.value, 10) || 0);
  const msg = days === 0
    ? 'Delete <strong>every</strong> tombstone entry, regardless of age?<br><br>A backup will be created first. Built-in category lists can\\'t be affected — they can no longer be deleted (or tombstoned) as of v71.8.'
    : \`Delete tombstone entries older than <strong>\${days} day\${days!==1?'s':''}</strong>?<br><br>A backup will be created first.\`;
  const ok = await confirm2(msg);
  if (!ok) return;
  try {
    const r = await api('/tombstones/prune', { method: 'POST', body: JSON.stringify({ olderThanDays: days }) });
    toast(r.removedCount > 0
      ? \`🧹 Pruned \${r.removedCount} old tombstone\${r.removedCount!==1?'s':''} (\${r.before} → \${r.remainingTombstones})\`
      : (r.message || 'No tombstones matched — nothing pruned.'), 'success');
    loadHealth();
  } catch(e) { toast('Prune failed: '+e.message,'error'); }
}

// ── Road Data auto-update (OSM/Overpass) ────────────────────────────────────
async function updateRoadsFromOsm() {
  const ok = await confirm2('Fetch fresh road data for your operating area from OpenStreetMap (via the Overpass API) and replace the current roads.geojson?<br><br>This calls out to a public server and can take up to a minute or two for a larger area. The previous file is kept as a backup (.bak) first.');
  if (!ok) return;
  const btn = document.getElementById('updateRoadsBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Updating…'; }
  try {
    const r = await api('/api/roads/update-osm', { method: 'POST', body: JSON.stringify({}) });
    toast(\`🗺️ Road data updated — \${r.featureCount} road ways loaded\`, 'success');
  } catch(e) {
    toast('Road data update failed: '+e.message, 'error');
  } finally {
    loadHealth(); // restores the button's normal enabled/label state via re-render either way
  }
}

// ── Debug Log — Live (today) ────────────────────────────────────────────────
let liveLogTimer = null;

async function loadLiveLog() {
  try {
    const r = await api('/logs/today/live');
    renderLiveLog(r.text || '');
  } catch (e) {
    // Transient failure (e.g. one 30s auto-refresh tick) — don't spam toasts,
    // the next poll will likely succeed.
  }
}

function renderLiveLog(text) {
  const box = document.getElementById('liveLogBox');
  if (!box) return;
  const wasAtBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 12;
  box.innerHTML = '';
  const lines = text.split('\\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) {
    const p = document.createElement('p');
    p.style.cssText = 'text-align:center;color:#6b7280;font-size:.78rem;padding:16px 0';
    p.textContent = "No entries yet today — they'll appear here live as the server does things.";
    box.appendChild(p);
    return;
  }
  // Built with createElement/textContent rather than innerHTML — log lines
  // can contain arbitrary text (record titles, error messages, etc.) and
  // must never be interpreted as HTML.
  lines.forEach(line => {
    const div = document.createElement('div');
    div.style.cssText = 'font-family:monospace;font-size:.72rem;color:#d1d5db;white-space:pre-wrap;word-break:break-all;line-height:1.5';
    div.textContent = line;
    box.appendChild(div);
  });
  if (wasAtBottom) box.scrollTop = box.scrollHeight;
}

function toggleLiveLog(on) {
  stopLiveLog();
  if (on) {
    loadLiveLog();
    liveLogTimer = setInterval(loadLiveLog, 3000);
  }
}
function stopLiveLog() {
  if (liveLogTimer) { clearInterval(liveLogTimer); liveLogTimer = null; }
}

// ── Debug Log ────────────────────────────────────────────────────────────────
function fmtBytes(b) { return b > 1e6 ? (b/1e6).toFixed(1)+'MB' : b > 1e3 ? (b/1e3).toFixed(0)+'KB' : b+'B'; }

async function loadLogs() {
  try {
    const r = await api('/logs');
    const input = document.getElementById('logRetentionDays');
    if (input) input.value = r.retentionDays || 4;
    const el = document.getElementById('logsList');
    if (!r.dates || r.dates.length === 0) {
      el.innerHTML = \`<div class="empty"><div class="icon">🐞</div><div>No log files yet — they're created as the server runs.</div></div>\`;
      return;
    }
    el.innerHTML = r.dates.map(d => \`
      <div class="kv" style="padding:10px 4px;border-bottom:1px solid var(--border)">
        <span class="k">\${d.date} <span style="color:var(--muted);font-size:.72rem">(\${fmtBytes(d.sizeBytes)})</span></span>
        <span class="v" style="display:flex;gap:6px">
          <button class="btn btn-ghost" style="padding:4px 10px;font-size:.72rem" onclick="downloadServerLog('\${d.date}')">⬇️ Download</button>
          <button class="btn btn-danger" style="padding:4px 10px;font-size:.72rem" onclick="deleteServerLog('\${d.date}')">🗑️</button>
        </span>
      </div>\`).join('');
  } catch(e) { toast('Failed to load logs: '+e.message, 'error'); }
}

async function downloadServerLog(date) {
  try {
    toast('⬇ Downloading…', 'info');
    const res = await fetch('/logs/' + date, { headers: { 'X-Sync-Token': TOKEN } });
    if (!res.ok) throw new Error('Download failed: ' + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'rsw-server-log-' + date + '.log';
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('✅ Downloaded log for ' + date, 'success');
  } catch(e) { toast('❌ Download failed: ' + e.message, 'error'); }
}

async function deleteServerLog(date) {
  const ok = await confirm2(\`Delete the log file for <strong>\${date}</strong>?\`);
  if (!ok) return;
  try { await api('/logs/' + date, { method: 'DELETE' }); toast('🗑️ Deleted log for ' + date, 'success'); loadLogs(); }
  catch(e) { toast('Delete failed: '+e.message, 'error'); }
}

async function deleteAllLogs() {
  const ok = await confirm2('Delete <strong>all</strong> server log files?');
  if (!ok) return;
  try { const r = await api('/logs', { method: 'DELETE' }); toast(\`🗑️ Deleted \${r.deletedCount} log file(s)\`, 'success'); loadLogs(); }
  catch(e) { toast('Delete failed: '+e.message, 'error'); }
}

async function saveLogRetention() {
  const input = document.getElementById('logRetentionDays');
  const days = Math.max(1, parseInt(input?.value, 10) || 4);
  try { await api('/settings', { method: 'POST', body: JSON.stringify({ logRetentionDays: days }) }); toast(\`✅ Keeping last \${days} day(s) of logs\`, 'success'); loadLogs(); }
  catch(e) { toast('Save failed: '+e.message, 'error'); }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type='info') {
  const el = document.createElement('div');
  el.className = 'toast-item ' + type;
  el.innerHTML = msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
</script>
</body>
</html>`);
  } catch(e) {
    console.error('[dashboard]', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message, status: 500 });
  }
});

// ── Backup Settings routes ───────────────────────────────────────────────────
// POST /backup/prune?keep=N — keep only last N backups on demand
// Accepts keep from JSON body (req.body.keep) OR query string (?keep=N)
app.post('/backup/prune', requireAuth, (req, res) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('rsw-server-backup-') && f.endsWith('.json'))
      .sort().reverse();  // newest first

    let deleted = 0;

    // Read keep from body OR query param — dashboard sends it as ?keep=N with no body
    const rawKeep = req.body?.keep ?? req.query.keep;
    const keepN   = rawKeep ? Math.max(1, parseInt(rawKeep, 10)) : 4;

    files.slice(keepN).forEach(f => {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); deleted++; } catch {}
    });
    console.log(`[backup] Prune: kept ${keepN} most recent, deleted ${deleted}`);
    res.json({ success: true, deleted, kept: keepN });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/settings', requireAuth, (_req, res) => {
  res.json({ settings: loadSettings() });
});

app.post('/settings', requireAuth, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object')
    return res.status(400).json({ error: 'Invalid settings payload' });

  // Validate
  const patch = {};
  if (typeof body.autoBackup === 'boolean')       patch.autoBackup = body.autoBackup;
  if (typeof body.intervalMinutes === 'number')   patch.intervalMinutes = Math.max(5, Math.round(body.intervalMinutes));
  if (typeof body.maxBackups === 'number')         patch.maxBackups = Math.max(1, Math.round(body.maxBackups));
  if (typeof body.autoDelete === 'boolean')        patch.autoDelete = body.autoDelete;
  if (typeof body.keepLastNAutoDelete === 'number') patch.keepLastNAutoDelete = Math.max(1, Math.round(body.keepLastNAutoDelete));
  if (typeof body.logRetentionDays === 'number')    patch.logRetentionDays = Math.max(1, Math.round(body.logRetentionDays));

  const saved = saveSettings(patch);
  if (!saved) return res.status(500).json({ error: 'Failed to save settings' });

  // Restart scheduler with new settings immediately — no Docker restart needed
  startScheduledBackups();
  if (typeof patch.logRetentionDays === 'number') pruneOldLogFiles();

  console.log('[settings] Backup settings updated:', JSON.stringify(patch));
  res.json({ success: true, settings: saved });
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
// FIX: error handler must explicitly set CORS + Content-Type on ALL errors.
// body-parser 413 (payload too large) can bypass the cors() middleware response
// headers if the body stream is still open — causing a bare text/HTML 413 that
// the client cannot JSON.parse (→ "unexpected character at line 1 column 1").
app.use((err, _req, res, _next) => {
  const status  = err.status || err.statusCode || 500;
  const isTooBig = status === 413 || (err.type === 'entity.too.large');
  const message = isTooBig
    ? 'Payload too large — your dataset exceeds the server body limit. Increase SYNC_MAX_BODY_SIZE in .env (current default: 10gb).'
    : (err.message || 'Internal server error');
  console.error(`[error] ${status} ${message}`);
  // Always set CORS + JSON headers before writing the body
  if (!res.headersSent) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Sync-Token, X-Requested-With, Accept');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(status).json({ error: message, status });
  }
});

// ── HTTPS support ────────────────────────────────────────────────────────────
// The RSW app is served over HTTPS. Firefox and Safari block HTTP requests
// (fetch/XHR) from HTTPS pages — this is the "mixed content" security rule.
// Chrome allows it with a warning; Firefox/Safari do not.
// We auto-generate a self-signed cert so the sync server also runs HTTPS.
//
// IMPORTANT — Subject Alternative Names (SANs):
//   Chrome 58+, Firefox 63+, and all modern browsers reject self-signed certs
//   that lack a SAN for the IP/hostname the client is connecting to.
//   The CN field alone is no longer sufficient. We detect all local IPs at
//   startup and embed them as IP SANs so browsers can at least be told to trust
//   this specific cert (via Advanced → Accept Risk, then install via /cert).
const fsSync  = require('fs');
const httpMod = require('http');
const httpsMod= require('https');

/**
 * Returns the IPv4 addresses + localhost to embed as cert SANs.
 *
 * v73.89 fix (Craig-reported: Debug Log "Failed to fetch" after rebuild):
 * os.networkInterfaces() only sees interfaces *inside* the container. On
 * Docker's default bridge network that's just the internal bridge IP
 * (e.g. 172.19.0.3) — never the host's real LAN IP (e.g. 192.168.1.7) that
 * a browser on the network actually connects to. Two bugs followed from
 * that:
 *   1. The cert's SAN list never covered the LAN IP, so browsers accepted
 *      the top-level page (manual "proceed anyway") but silently rejected
 *      every background fetch()/XHR to it — exactly what the Debug page's
 *      live-log polling does. Any page relying on fetch() after load would
 *      show the same "Failed to fetch".
 *   2. The bridge IP is reassigned by Docker on most rebuilds/recreates, so
 *      certNeedsRegen() saw a "new" IP every time and regenerated the cert
 *      on every rebuild — repeatedly invalidating the trust exception the
 *      user had already accepted, even when nothing about the host changed.
 *
 * Fix: read the host's real LAN IP from HOST_IP (set in .env / compose —
 * see .env.example) and always include it. Docker-internal bridge/overlay
 * addresses (RFC1918 172.16-31.x.x, the default Docker bridge range) are
 * excluded from SAN generation entirely so they can no longer trigger
 * pointless regeneration or end up in the cert in place of the real IP.
 */
function getLocalIPs() {
  const result = new Set(['127.0.0.1', 'localhost']);
  if (process.env.HOST_IP) result.add(process.env.HOST_IP.trim());
  try {
    const nets = os.networkInterfaces();
    for (const netArr of Object.values(nets)) {
      for (const net of netArr) {
        if (net.family === 'IPv4' && !net.internal && !isDockerBridgeIP(net.address)) {
          result.add(net.address);
        }
      }
    }
  } catch {}
  return [...result];
}

/** True for addresses in 172.16.0.0/12 — Docker's default bridge network range. */
function isDockerBridgeIP(ip) {
  const m = /^172\.(\d{1,3})\./.exec(ip);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

/**
 * Returns true if the cert at certFile was generated WITHOUT SANs (old certs),
 * or if the set of local IPs has changed since the cert was last generated.
 * We track this with a small sidecar file: cert-ips.json.
 */
function certNeedsRegen(certDir, currentIPs) {
  const ipsFile = path.join(certDir, 'cert-ips.json');
  // If the sidecar doesn't exist the cert predates SAN support → must regen.
  if (!fsSync.existsSync(ipsFile)) {
    console.log('[ssl] cert-ips.json missing — cert predates SAN support, regenerating.');
    return true;
  }
  try {
    const saved = JSON.parse(fsSync.readFileSync(ipsFile, 'utf8'));
    const added = currentIPs.filter(ip => !saved.includes(ip));
    if (added.length > 0) {
      console.log(`[ssl] New local IPs detected (${added.join(', ')}) — regenerating cert.`);
      return true;
    }
  } catch {
    return true; // unreadable sidecar → regenerate to be safe
  }
  return false;
}

function startListening(callback) {
  const certDir  = process.env.CERT_DIR || '/certs';
  const keyFile  = path.join(certDir, 'rsw-sync-key.pem');
  const certFile = path.join(certDir, 'rsw-sync-cert.pem');
  const ipsFile  = path.join(certDir, 'cert-ips.json');

  const currentIPs = getLocalIPs();

  // Delete stale certs so they get regenerated with proper SANs.
  // This runs on every container start if the cert lacks SANs (no sidecar file)
  // or if the host machine's IP has changed.
  const certsExist = fsSync.existsSync(keyFile) && fsSync.existsSync(certFile);
  if (certsExist && certNeedsRegen(certDir, currentIPs)) {
    try {
      fsSync.unlinkSync(keyFile);
      fsSync.unlinkSync(certFile);
      console.log('[ssl] Deleted stale cert — will regenerate with correct SANs.');
    } catch (e) {
      console.warn('[ssl] Could not delete stale cert:', e.message);
    }
  }

  // Auto-generate self-signed cert if missing (or just deleted above)
  if (!fsSync.existsSync(keyFile) || !fsSync.existsSync(certFile)) {
    try {
      fsSync.mkdirSync(certDir, { recursive: true });
      const { execSync } = require('child_process');

      // Build the SAN string — IP SANs for every local interface address.
      // DNS:localhost covers the name; IP:x.x.x.x covers direct-IP access.
      // Modern browsers check the SAN list; without it they always reject the cert.
      const sanEntries = currentIPs
        .map(ip => (/^\d+\.\d+/.test(ip) ? `IP:${ip}` : `DNS:${ip}`))
        .join(',');

      console.log(`[ssl] Generating self-signed cert (SANs: ${sanEntries}) ...`);
      execSync(
        `openssl req -x509 -nodes -newkey rsa:2048 -days 3650 ` +
        `-keyout "${keyFile}" -out "${certFile}" ` +
        `-subj "/C=NZ/ST=Auckland/O=RSW Sync Server/CN=rsw-sync" ` +
        `-addext "subjectAltName=${sanEntries}"`,
        { stdio: 'pipe' }
      );

      // Save the IP list so we can detect future changes without running openssl.
      fsSync.writeFileSync(ipsFile, JSON.stringify(currentIPs), 'utf8');
      console.log('[ssl] ✅ Self-signed certificate generated →', certFile);
      console.log(`[ssl]    SANs: ${sanEntries}`);
      console.log('[ssl]    To trust in browser: visit https://HOST:' + PORT + '/cert');
    } catch (e) {
      console.warn('[ssl] openssl failed, running HTTP only:', e.message);
    }
  }

  if (fsSync.existsSync(keyFile) && fsSync.existsSync(certFile)) {
    // HTTPS — required for Firefox/Safari when app is on HTTPS
    const sslOpts = {
      key:  fsSync.readFileSync(keyFile),
      cert: fsSync.readFileSync(certFile),
    };
    const srv = httpsMod.createServer(sslOpts, app);
    srv.listen(PORT, '0.0.0.0', callback);

    // ── HTTP helper on PORT+1 (8056) ─────────────────────────────────────────
    // CRITICAL for mobile devices:
    //   Mobile browsers can't download the cert from the HTTPS port (8055) because
    //   they don't trust it yet — classic chicken-and-egg problem.
    //   Port 8056 (plain HTTP, no cert needed) solves this:
    //   Mobile user visits http://HOST:8056 → gets a setup page + cert download links.
    //
    // iOS PWA note: Safari's "Accept Risk" exceptions do NOT carry over to
    //   standalone (home-screen) mode. The cert MUST be installed via Settings.
    //   We serve a .mobileconfig profile which iOS auto-prompts to install.
    //
    // Android note: Chrome "Proceed anyway" also doesn't help in standalone mode.
    //   We serve the .pem for Android's CA install flow in Security Settings.
    httpMod.createServer((req, res) => {
      const host = (req.headers.host || 'HOST').split(':')[0];
      const httpsUrl = `https://${host}:${PORT}`;

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Sync-Token, X-Requested-With, Accept');
      if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

      // ── /cert.pem — serve cert as PEM over HTTP (no chicken-and-egg) ──────
      // Android users download this, then install via Settings → Security → CA cert
      if (req.url === '/cert.pem' || req.url === '/cert') {
        if (!fsSync.existsSync(certFile)) {
          res.writeHead(404, {'Content-Type':'text/plain'}); res.end('No certificate generated yet.'); return;
        }
        const pem = fsSync.readFileSync(certFile);
        res.setHeader('Content-Type', 'application/x-pem-file');
        res.setHeader('Content-Disposition', 'attachment; filename="rsw-sync-cert.pem"');
        res.writeHead(200); res.end(pem); return;
      }

      // ── /cert.mobileconfig — iOS profile (auto-prompts install in Safari) ──
      // The .mobileconfig format lets iOS install the cert as a trusted root CA
      // with one tap — far more reliable than the Settings manual flow.
      if (req.url === '/cert.mobileconfig') {
        if (!fsSync.existsSync(certFile)) {
          res.writeHead(404, {'Content-Type':'text/plain'}); res.end('No certificate generated yet.'); return;
        }
        try {
          const { execSync } = require('child_process');
          // Convert PEM → DER → base64 for embedding in the plist
          const derB64 = execSync(`openssl x509 -in "${certFile}" -outform DER 2>/dev/null | base64`, {stdio:'pipe'}).toString().trim();
          const profileUuid  = 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890';
          const certUuid     = 'B2C3D4E5-F6A7-8901-BCDE-F01234567891';
          const mobileconfig = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>rsw-sync.cer</string>
      <key>PayloadContent</key><data>${derB64}</data>
      <key>PayloadDescription</key><string>RSW Sync Server SSL Certificate</string>
      <key>PayloadDisplayName</key><string>RSW Sync Server Certificate</string>
      <key>PayloadIdentifier</key><string>com.rsw.sync.cert.${certUuid}</string>
      <key>PayloadOrganization</key><string>RSW Field App</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>${certUuid}</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key><string>Installs the RSW Sync Server SSL certificate so your device can connect securely.</string>
  <key>PayloadDisplayName</key><string>RSW Field App — Sync Server Certificate</string>
  <key>PayloadIdentifier</key><string>com.rsw.sync.profile.${profileUuid}</string>
  <key>PayloadOrganization</key><string>RSW Field App</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${profileUuid}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>`;
          res.setHeader('Content-Type', 'application/x-apple-aspen-config');
          res.setHeader('Content-Disposition', 'attachment; filename="rsw-sync.mobileconfig"');
          res.writeHead(200); res.end(mobileconfig);
        } catch(e) {
          res.writeHead(500, {'Content-Type':'text/plain'}); res.end('Could not generate mobileconfig: ' + e.message);
        }
        return;
      }

      // ── /health — JSON for automated checks ──────────────────────────────
      if (req.url === '/health' || req.url === '/health/') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'http-setup-port', httpsUrl, certPem: `http://${host}:${PORT+1}/cert.pem`,
          certMobileconfig: `http://${host}:${PORT+1}/cert.mobileconfig`,
          setupPage: `http://${host}:${PORT+1}/`,
        })); return;
      }

      // ── / — Mobile setup guide HTML page ─────────────────────────────────
      // This is what mobile users see when they first navigate to http://HOST:8056
      // No external resources — fully self-contained so it works with no internet.
      const setupHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RSW Sync Server — Mobile Setup</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;color:#1e293b;padding:0 0 40px}
.hero{background:linear-gradient(135deg,#0f172a,#1e293b);color:#fff;padding:32px 20px;text-align:center}
.hero h1{font-size:1.5em;font-weight:800;margin-bottom:4px}
.hero p{color:#94a3b8;font-size:14px}
.hero .ip{background:#ea580c;color:#fff;padding:4px 14px;border-radius:20px;font-size:13px;font-weight:700;display:inline-block;margin-top:10px}
.container{max-width:600px;margin:0 auto;padding:20px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:20px;margin:16px 0}
.card h2{font-size:1.1em;font-weight:700;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.step{display:flex;gap:12px;margin:10px 0;align-items:flex-start}
.n{width:26px;height:26px;min-width:26px;line-height:26px;text-align:center;background:#ea580c;color:#fff;border-radius:50%;font-size:12px;font-weight:800}
.step p{font-size:14px;color:#374151;line-height:1.5}
.step code{font-size:12px;background:#f1f5f9;padding:1px 5px;border-radius:4px;color:#dc2626}
.btn{display:block;width:100%;padding:14px;border-radius:10px;font-size:15px;font-weight:700;text-align:center;text-decoration:none;color:#fff;margin:8px 0;cursor:pointer;border:none}
.btn-ios{background:#007AFF}
.btn-android{background:#059669}
.box{border-radius:10px;padding:12px 16px;margin:12px 0;font-size:13px}
.box.warn{background:#fffbeb;border:1.5px solid #fcd34d;color:#92400e}
.box.info{background:#eff6ff;border:1.5px solid #93c5fd;color:#1e40af}
.box.ok{background:#ecfdf5;border:1.5px solid #6ee7b7;color:#065f46}
b{font-weight:700}
</style>
</head>
<body>
<div class="hero">
  <h1>🧹 RSW Sync Server</h1>
  <p>Mobile device setup — connect your phone or tablet</p>
  <span class="ip">Server: ${host}:${PORT}</span>
</div>
<div class="container">

  <div class="box warn">
    <b>⚠️ Why you see this page:</b> Your mobile browser cannot connect to the sync server yet because the server uses a self-signed SSL certificate that your device does not trust. Follow the steps below for your device.
  </div>

  <!-- iOS -->
  <div class="card">
    <h2>🍎 iPhone &amp; iPad (iOS)</h2>
    <div class="box info"><b>Important:</b> You must use <b>Safari</b> to install the certificate. Other browsers cannot trigger the iOS install prompt.</div>

    <div class="step"><span class="n">1</span><p>Tap the button below to download the certificate profile. Safari will ask "Allow download?" — tap <b>Allow</b>.</p></div>
    <a href="/cert.mobileconfig" class="btn btn-ios">📲 Download Certificate Profile (iOS)</a>

    <div class="step"><span class="n">2</span><p>Open the <b>Settings</b> app. You will see a banner at the top: <b>"Profile Downloaded"</b> — tap it.</p></div>
    <div class="step"><span class="n">3</span><p>Tap <b>Install</b> (top right) → enter your passcode → tap <b>Install</b> again → tap <b>Done</b>.</p></div>
    <div class="step"><span class="n">4</span><p>Go to <b>Settings → General → About → Certificate Trust Settings</b>. Find <b>"RSW Sync Server Certificate"</b> and toggle it <b>ON</b> → tap Continue.</p></div>
    <div class="step"><span class="n">5</span><p>Open Safari and visit <code>${httpsUrl}</code> — it should load without a warning now.</p></div>
    <div class="step"><span class="n">6</span><p>In the RSW app: <b>Backup &amp; Sync → Configure</b> → set Server URL to <code>${httpsUrl}</code> and enter your sync token.</p></div>
    <div class="box ok"><b>✅ That's it!</b> The certificate is permanently trusted on this device — no more warnings.</div>
  </div>

  <!-- Android -->
  <div class="card">
    <h2>🤖 Android</h2>
    <div class="step"><span class="n">1</span><p>Tap the button below to download the certificate file.</p></div>
    <a href="/cert.pem" class="btn btn-android">📥 Download Certificate (Android)</a>

    <div class="step"><span class="n">2</span><p>Open <b>Settings → Security → Encryption &amp; Credentials → Install a Certificate → CA Certificate</b>.<br>
    (On Samsung: Settings → Biometrics and Security → Other Security Settings → Install from Device Storage)</p></div>
    <div class="step"><span class="n">3</span><p>Tap <b>"Install anyway"</b> → find and select the downloaded <code>rsw-sync-cert.pem</code> file → confirm with your PIN/password.</p></div>
    <div class="step"><span class="n">4</span><p>Open Chrome and visit <code>${httpsUrl}</code> — it should load without a warning.</p></div>
    <div class="step"><span class="n">5</span><p>In the RSW app: <b>Backup &amp; Sync → Configure</b> → Server URL: <code>${httpsUrl}</code> and your sync token.</p></div>
    <div class="box ok"><b>✅ Certificate trusted system-wide</b> — works in Chrome, Firefox, and all apps on this device.</div>
  </div>

  <!-- Open app -->
  <div class="card">
    <h2>🧹 Open RSW Field App</h2>
    <div class="step"><span class="n">1</span><p>After installing the certificate, open the app:</p></div>
    <a href="${httpsUrl.replace(':'+PORT, ':8050')}" class="btn" style="background:#4f46e5">Open RSW Field App →</a>
    <p style="font-size:12px;color:#94a3b8;margin-top:8px;text-align:center">If the link doesn't work, your device's IP may differ — ask your administrator for the correct address.</p>
  </div>

  <div class="box info" style="font-size:12px">
    <b>ℹ️ How sync works:</b> Your device stores all data locally (offline-first). When on the same WiFi as this server, push your work to keep a backup and share with other devices. This server at <b>${host}</b> is your team's sync hub.
  </div>
</div>
</body>
</html>`;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200);
      res.end(setupHtml);
    }).listen(PORT + 1, '0.0.0.0', () => {
      console.log(`    📱 Mobile setup: http://HOST:${PORT + 1}  ← open this on mobile browsers to install cert`);
    });
    return srv;
  } else {
    // Fallback: plain HTTP (openssl unavailable)
    console.warn('[ssl] Running HTTP only — Firefox may block requests from HTTPS app pages');
    const srv = app.listen(PORT, '0.0.0.0', callback);
    return srv;
  }
}

const server = startListening(() => {
  console.log(`\n✅  RSW Sync Server v${PKG_VERSION}  →  https://0.0.0.0:${PORT}`);
  console.log(`    Schema:      v${APP_SCHEMA_VERSION} (app v37+)`);
  console.log(`    Migrations:  sweepRoads (v25+), sweepJobs (v29+), sweepAreas (v15+), sweepJobSites (v36+/v39+), inspections (v42+: photo GPS/pin-link), sweepCategories (v39+/v42+)\n`);
  console.log(`    Data:        ${DATA_FILE}`);
  console.log(`    Backups:     ${BACKUP_DIR}`);
  console.log(`    Token:       ${AUTH_TOKEN === 'qg5YAagV88rHWv1eatfzMdmfirX3tcZD' ? '✅ configured' : '✅ custom (from SYNC_TOKEN env)'}`);
  console.log(`    Collections: ${ALL_COLLECTIONS.join(', ')}\n`);
  console.log(`    🔐 Browser cert trust (first-time setup per browser):`);
  const localIPs = getLocalIPs().filter(ip => ip !== '127.0.0.1' && ip !== 'localhost');
  if (localIPs.length > 0) {
    localIPs.forEach(ip => {
      console.log(`       https://${ip}:${PORT}/cert  ← open in browser, accept exception, install cert`);
    });
  } else {
    console.log(`       https://HOST_IP:${PORT}/cert  ← open in browser, accept exception, install cert`);
  }
  console.log(`    Backup endpoints:`);
  console.log(`      GET  /backup/list       — list all backups with manifests`);
  console.log(`      POST /backup/now        — trigger manual backup`);
  console.log(`      POST /backup/verify     — verify latest backup integrity`);
  console.log(`      GET  /backup/audit      — compare live data vs latest backup`);
  console.log(`    Migration endpoints:`);
  console.log(`      GET  /migrate           — inspect records needing migration (dry run)`);
  console.log(`      POST /migrate           — apply schema migrations to stored data\n`);
  startScheduledBackups();

  // On startup: verify latest backup and check for pending migrations
  const backups = listBackups();
  if (backups.length > 0) {
    const result = verifyBackup(path.join(BACKUP_DIR, backups[0].filename));
    if (result.ok) console.log(`[backup] ✅ Latest backup verified OK (${result.totalRecords} records)`);
    else console.warn(`[backup] ⚠️  Latest backup verification issues: ${result.errors.join('; ')}`);
  }

  // Check if stored data needs migration and auto-apply
  const storedData = loadData();
  if (storedData) {
    const report = inspectMigrations(storedData);
    if (report.needsMigration) {
      console.log(`[migrate] 🔄 Stored data needs schema migration — applying automatically...`);
      const backupFile = createBackup('pre-auto-migration');
      const { data: migratedData, migrated, details } = applyMigrations(storedData);
      if (migrated) {
        try {
          saveData(migratedData);
          console.log(`[migrate] ✅ Auto-migration complete (backup: ${backupFile}): ${details.join('; ')}`);
        } catch (e) {
          console.error(`[migrate] ❌ Auto-migration save failed: ${e.message}`);
        }
      }
    } else {
      console.log(`[migrate] ✅ Stored data schema is current — no migration needed`);
    }
  }
});

function shutdown(sig) {
  console.log(`[${new Date().toISOString()}] ${sig} — creating final backup and shutting down...`);
  createBackup('shutdown');
  server.close(() => { console.log('Done.'); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => { console.error('Uncaught:', e.message); shutdown('uncaughtException'); });
