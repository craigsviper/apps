## ⚠️ TEST/HOST HARDWARE PROFILE — READ FIRST

This app and its host-server are developed and tested on **low-end hardware roughly on par with a mobile phone/tablet**. If a feature can't run acceptably here, treat it as unable to run on a mobile field device either.

- **CPU:** AMD Athlon II X2 215 (dual-core, 2.7 GHz, no SMT) — old, low single-thread performance
- **RAM:** 12 GiB total, ~9.7 GiB available
- **GPU:** NVIDIA GeForce GT 610 (nouveau/open driver) — minimal 2D/3D capability
- **Storage:** 298 GiB HDD (7200rpm, SATA 3.0Gb/s) — no SSD, slow I/O
- **OS:** Linux Mint 22.3 (Ubuntu 24.04 noble base), kernel 6.8
- **Display:** dual monitor, 1920x1080 each

**Implication:** avoid heavy client-side compute, large bundle sizes, unbounded map/canvas rendering, or anything that assumes SSD-speed I/O or multi-core parallelism. Performance/UX budgets should target this class of hardware, not a modern dev workstation.

*Re-confirmed unchanged via a second `inxi` snapshot (2026-08-14, v73.98) — same machine, same specs. Worth noting for context when reading older performance-fix entries below: the CPU's reported clock varies by snapshot (800MHz idle vs 2.7GHz under load, `boost: disabled`) since it idles down between benchmarks rather than the hardware itself changing — treat 2.7GHz as the real ceiling either way.*

## v73.123 — 2026-08-21
**Files changed:** `docker-compose.yml` (healthcheck only)

Preemptive fix, not from a reported failure on this container — same bug class fixed in the app's root `docker-compose.yml` this release (see root `CHANGELOG.md` v73.123): the healthcheck pointed `curl` at `https://localhost:8055/health`, and `localhost` can resolve to `::1` first inside the container with no IPv6 listener behind it, risking a false "unhealthy" even while the server is serving fine. Changed to `https://127.0.0.1:8055/health`. No server logic changed.

## v73.114 — 2026-08-18
**Files changed:** version string only (`server.js` `APP_SCHEMA_VERSION`)

Version bump to match the app's v73.114 (root `CHANGELOG.md`) — no server-side logic changed. Both fixes this release (the silent-fallback console/UI warning, and the `offsetPerpendicular` degenerate-tangent fix) are entirely client-side geometry/UI concerns in `SweepJobs.tsx`; nothing for the sync server to do differently.

## v73.115 — 2026-08-18
**Files changed:** version string only (`server.js` `APP_SCHEMA_VERSION`)

Version bump to match the app's v73.115 (root `CHANGELOG.md`) — no server-side logic changed. This release flips the client's `sweepBothSides` default to off; purely a client-side React state default, nothing for the sync server to do differently.

## v73.118 — 2026-08-18
**Files changed:** version string only (`server.js` `APP_SCHEMA_VERSION`)

Version bump to match the app's v73.118 (root `CHANGELOG.md`) — no server-side logic changed. This release adds cut-vertex detection to `traverseLoopCoverage()` so a mandatory turnaround that's the only connection through to part of the selection doesn't strand that section's coverage; purely client-side graph-traversal logic in `SweepJobs.tsx`, nothing for the sync server to do differently.

## v73.117 — 2026-08-18
**Files changed:** version string only (`server.js` `APP_SCHEMA_VERSION`)

Version bump to match the app's v73.117 (root `CHANGELOG.md`) — no server-side logic changed. This release makes `traverseLoopCoverage()` respect turnaround markers as mandatory stop-and-reverse points at connected junctions, not just true dead-ends; purely client-side graph-traversal logic in `SweepJobs.tsx`, nothing for the sync server to do differently.

## v73.116 — 2026-08-18
**Files changed:** version string only (`server.js` `APP_SCHEMA_VERSION`)

Version bump to match the app's v73.116 (root `CHANGELOG.md`) — no server-side logic changed. This release adds distance-based junction clustering to the client's `buildSelectedRoadGraph()`; purely client-side graph construction, nothing for the sync server to do differently.

## v73.111 — 2026-08-17
**Files changed:** version string only (`server.js` `APP_SCHEMA_VERSION`)

Version bump to match the app's v73.111 (root `CHANGELOG.md`) — no server-side logic changed. Both v73.110 and v73.111 were entirely client-side: v73.110 added a Strict mode that changes which CLIENT-side functions get called (skipping the calls to `/api/roads/connect` and `/api/roads/match` rather than changing either endpoint itself), and v73.111 fixed the client's own local graph-traversal ordering. Nothing for the sync server to do differently in either release.

---

## v73.109 — 2026-08-17
**Files changed:** version string only (`server.js` `APP_SCHEMA_VERSION`, `package.json`, `package-lock.json`, `docker-compose.yml`, `Dockerfile`)

Version bump to match the app's v73.109 (root `CHANGELOG.md`) — no server-side logic changed this release. That release fixed a UI/layout issue (the turnaround points panel visually reading as another route segment section) entirely in `src/components/sweep/SweepJobs.tsx` — nothing for the sync server to do differently.

---

## v73.108 — 2026-08-17
**Files changed:** version string only (`server.js` `APP_SCHEMA_VERSION`, `package.json`, `package-lock.json`, `docker-compose.yml`, `Dockerfile`)

Version bump to match the app's v73.108 (root `CHANGELOG.md`) — no server-side logic changed this release. That release was a client-side audit confirming turnaround points can't be saved/rendered as route segments, plus a defensive type-guard/save-time filter, all in `src/`. Also fixed `package-lock.json` here, which had been stuck at v73.100.0 since that release (a gap from an earlier session, caught while bumping this one).

---

## v73.101 — 2026-08-17
**Files changed:** `sync-server/server.js` (`/api/roads/connect` — new logic, not just a version bump), `sync-server/package.json`, `docker-compose.yml`, `Dockerfile`

### Added: turnaround-point radius tightening extended to `/api/roads/connect`

Server half of extending v73.100's turnaround-radius hint from `/match` to the gap-fill endpoint (see root `CHANGELOG.md` v73.101 for the full writeup). `GET /api/roads/connect` now accepts an optional `turnarounds` query param (JSON-encoded array of `{lat,lng}`). When present and non-empty, `tryOsrmConnect()` tightens the `from`/`to` OSRM `radiuses` value individually — 5m for whichever endpoint falls within 60m of a supplied marker, the existing default (25m) otherwise. When the param is absent or empty, no `radiuses` param is added to the outgoing OSRM request at all — identical request to pre-v73.101, confirmed via a standalone reproduction, not just code review.

**Verified:** `node --check server.js` clean, plus a standalone Node reproduction (7/7 checks) of the radius-selection logic covering the no-turnarounds/near-from-only/near-to-only/far-turnaround/60m-boundary cases. No new collection/merge surface — same reasoning as v73.100, `turnarounds` still rides inside `RouteSegment`, already covered by `mergeSubArrayById`/`sweepRoads.segments`.

---

## v73.100 — 2026-08-17
**Files changed:** `server.js` (`/api/roads/match` — new logic, not just a version bump), `package.json`, `docker-compose.yml`, `Dockerfile`

### Added: turnaround-point radius tightening for `/api/roads/match`

Server half of the app's new Turnaround Points feature (see root `CHANGELOG.md` v73.100 for the full feature writeup). `POST /api/roads/match` now accepts an optional `turnarounds: [{lat,lng}, ...]` array in the request body. For any batch point within 60m of a supplied turnaround coordinate, that point's individual OSRM `radiuses` value is tightened from the existing uniform 25m (v73.79's fix) down to 5m before the batch is sent to OSRM — the same `radiuses` mechanism v73.79 already relies on, just applied more tightly at the specific spots the app now lets Craig mark as a genuine dead-end/road-end, instead of uniformly across every point. Backward compatible: `turnarounds` is optional and defaults to an empty array, so a request from an older app build (or any caller not sending it) behaves exactly as before.

**Verified:** `node --check server.js` clean. No new collection/merge surface — `turnarounds` rides inside `RouteSegment` (an app-side type), which already merges as a whole object by id via the existing `mergeSubArrayById`/`sweepRoads.segments` handling; nothing new for `mergeData()` to do here.

---

## v73.99 — 2026-08-17
**Files changed:** version string only (`server.js`, `package.json`, `docker-compose.yml`, `Dockerfile`)

Version bump to match the app's v73.99 (root `CHANGELOG.md`) — no server-side logic changed this release. That release fixed the actual root cause of Craig's "Transit Road Type Lost After Add Segment" report and added a right-click Transit↔Solid toggle for committed lines; both are purely client-side (`src/components/sweep/SweepJobs.tsx`) geometry/state fixes with nothing for the sync server to do differently. See the app changelog for the full writeup.

---

> **Standing rule — update with every version bump:**
> When shipping any server fix or update, the following must also be reviewed
> and updated to reflect the new version number and any changed behaviour:
> - `host-server/docker-compose.yml` — image tags, port mappings, env var defaults
> - `host-server/sync-server/Dockerfile` — base image, build args, labels
> - `host-server/.env.example` — any new or removed environment variables
> - `host-server/install-host.sh` — any changed install steps
> - `host-server/diagnose-host.sh` — any new diagnostic checks needed
> - `host-server/sync-server/package.json` — version field (must match changelog)
> Leaving any of these stale will cause confusion for anyone installing or
> upgrading from a different version than the one these files describe.



## v73.94 — 2026-08-14
No server-side logic change. Schema-version bump only (`APP_SCHEMA_VERSION`), matching the app-side per-road transit marking release — see root `CHANGELOG.md` v73.94. `runSelectRoadsBatch` reuses the existing `/api/roads/connect`/`/api/roads/match` endpoints unchanged, just calling them once per batch instead of once per whole selection.

## v73.95 — 2026-08-14
**Files changed:** `host-server/sync-server/server.js`, `package.json`, `host-server/sync-server/package.json`, `docker-compose.yml`, `host-server/docker-compose.yml`, `Dockerfile`, `public/sw.js`

### Dashboard: "Upload Backup" — the real gap behind "backup import still missing"

Craig, screenshot of the host-server dashboard's Backups page (v73.93.0): "the Backup import is still missing on the host-server but is there in the app." v73.92 fixed the APP's own Backup & Sync page (`Backup.tsx` — Send Backup to Server / Download Server Backup / restore an existing server backup) — a genuinely different, already-working thing. What Craig's screenshot shows is missing is on the **dashboard itself**: Create Backup (snapshot current live data), Download/Restore/Delete on an *existing* list entry — but no way to take a backup `.json` file sitting on the operator's own computer and add it to that list at all. `POST /data/import` already existed for merging an uploaded file straight into *live* data, but that's not the same as adding it as a browsable/restorable backup entry.

**Fix:** new `POST /backup/upload` (`requireAuth`) — accepts the uploaded file's parsed JSON body, validates it with the same `isValidAppData()` check `/backup/:filename/restore` already trusts, computes a fresh manifest from the file's own actual contents via the existing `buildManifest()`/`detectDrift()` (an uploaded file's own manifest, if it has one, describes whatever server it came from — recomputing rather than trusting it keeps the list's counts/hashes honest), and writes it into `BACKUP_DIR` with a normal `rsw-server-backup-<timestamp>.json` name. From that point it's indistinguishable from any other backup — Restore/Download/Delete/preview all already work on any file matching that naming pattern, no new code path needed there. New "⬆️ Upload Backup" button + hidden file input next to the existing Create Backup/Refresh buttons on the dashboard's Backups page; the new `uploadBackup()` dashboard-JS function reads the picked file as text, `JSON.parse`s it client-side (a clear "not valid JSON" error if that fails, before ever hitting the network), and posts it to the new endpoint.

**Verified live**, not just reviewed: booted a real server, uploaded a synthetic valid backup via `curl` — confirmed it appears in `GET /backup/list` with correctly recomputed per-collection counts and hash; uploaded a malformed file (`{"foo":"bar"}`) — confirmed a clean 400 with no file written. Per the project's standing dashboard-JS rule, fetched the actual rendered `/dashboard` response from the live server, extracted the real `<script>` content, and ran `node --check` on that — not just `node --check server.js` alone, which can't see inside the strings the server emits.

**Not yet tested through an actual browser's file picker** — the upload logic itself is verified end-to-end via a direct API call simulating what the browser will send, but the `<input type="file">`/`FileReader` wiring on the real dashboard page hasn't been click-tested in a browser this session.

## v73.91 — 2026-08-12
Audit only, no new server logic — confirmed v73.89's fix below was already present in the tree Craig's other uploaded zip (`v73.90`) was built from, so no merge was needed. Root `CHANGELOG.md` has the full audit, including a real packaging bug found (`.claude`/root `.env` silently dropped from some past deliveries — bash glob-copy issue, now fixed and documented as a standing rule in `CLAUDE_CONTEXT.md`).

## v73.89 — 2026-08-12

**Fix:** Debug Log page (and any other dashboard fetch() call) failing with
"Failed to load: Failed to fetch" after a rebuild — HTTPS cert never
actually covered the host's LAN IP.

- Root cause: `getLocalIPs()` used `os.networkInterfaces()`, which inside
  the container only sees the container's own network — on Docker's
  default bridge that's an internal address like `172.19.0.3`, never the
  host's real LAN IP (e.g. `192.168.1.7`) a browser connects to. The cert's
  SAN list never covered the LAN IP, so browsers loaded the dashboard page
  itself (via a manual "proceed anyway") but silently rejected every
  background `fetch()`/XHR against it. This also meant the bridge IP —
  which Docker reassigns on most rebuilds — was misread as "the host IP
  changed", so the cert regenerated (and any previously-accepted browser
  trust exception broke) on nearly every rebuild for no real reason.
- Fix: added a required `HOST_IP` env var (set in `.env` — see
  `.env.example`) that's now always included in the cert's SAN list.
  Docker-internal bridge addresses (172.16–31.x.x) are now excluded from
  SAN generation entirely so they can no longer trigger this loop or stand
  in for the real IP.
- **Action needed after upgrading:** set `HOST_IP=<your host's LAN IP>` in
  `host-server/.env` (find it with `hostname -I`), then
  `docker compose build --no-cache && docker compose up -d --build`. Since
  the IP set changes, this will regenerate the cert once more — revisit
  `https://HOST_IP:8055/cert` in each browser to accept/install it.

## v73.87 — 2026-08-11
### Reconciled a genuine fork — server.js now carries both the excluded-road absolute-floor fix (v73.84) and raw-fallback visibility (v73.85) from a parallel session, previously missing entirely from this lineage. No new server logic this version — see root `CHANGELOG.md` for the full fork/merge trace and the client-side Create Road fix.

## v73.84 — 2026-08-11
Version string only — this release (pending-Transit dashed preview, Select Roads draft auto-save) is entirely client-side. See root `CHANGELOG.md`.

## v73.83 — 2026-08-11
Version string only (`APP_SCHEMA_VERSION`) — this release's actual fix (Select Roads/Lasso undo stack) is entirely client-side. See root `CHANGELOG.md`.

## v73.82 — 2026-08-11
### Version sync only — no host-server logic change

App v73.82 fixed "Split Segment by Street" only ever working on a segment untouched by Add to Segment — a client-side tag-propagation bug through the offset step, the OSRM auto-snap, and the wrap-into-one-feature re-chain step (see app `CHANGELOG.md` v73.82 for the full writeup). `streetName` tagging is purely a client-side editing aid, never synced/merged, so nothing here touches `server.js`'s actual logic. `APP_SCHEMA_VERSION` bumped to `73.82` for consistency with the rest of the version-bump checklist, `node --check server.js` re-run clean.

## v73.81 — 2026-08-11
**Files changed:** `server.js`

Built the actual fix for the "service road/extra road added when the option was off" bug root-caused in v73.80 — see app `CHANGELOG.md` v73.81 for the full writeup. `/api/roads/connect` and `/api/roads/match` now check every OSRM-returned route/match against the same `classifyRoadFeature()`/`roadIndex` classification `/api/roads` already uses (new `nearestRoadCategoryAt()`/`checkRouteAgainstExcludedClasses()`/`parseIncludeFlags()` helpers), rejecting and falling back to raw/road-data-only points when 15%+ of the route runs through a road class the caller's `includeServiceRoads`/`includeLanes`/`includeParkingAisles`/`includeLivingStreets`/`includeServiceLanes` flags don't currently include. `/api/roads/match`'s response now also reports `excludedRoadRejections` (batch count) so the client can surface it.

`APP_SCHEMA_VERSION` bumped to `73.81`, `node --check server.js` clean. Verified live against a mocked OSRM server plus a small test `roads.geojson`: connect/match near an excluded road class rejected by default and accepted once included, both unaffected on an ordinary street — 6/6 end-to-end scenarios pass. Also verified a standalone repro of the 15% rejection-threshold logic in isolation (4/4 pass) before the live pass.

## v73.79 — 2026-08-10 (or later)
**Files changed:** `server.js`

Fixed the two real bugs Craig identified this round — see app `CHANGELOG.md` v73.79 for the full writeup (both entries below are server-side changes):

1. **`/api/roads/connect` now tries OSRM's `/route/v1/driving` first**, falling back to the existing local road-data Dijkstra graph (`buildLocalRoadGraph`/`dijkstraPath`, unchanged, v73.34) only if OSRM is unreachable, times out (4s), or returns no route. This endpoint had never touched OSRM since it was created — the local graph's tendency to route down the wrong parallel carriageway/service lane on divided roads was what was reading as "duplicate lines/extra points" in Select Roads/Lasso mode.
2. **`/api/roads/match` (Snap to Roads) now sends `radiuses=25` per point** to OSRM and rejects any batch whose matched distance exceeds 2.5x the raw selected-point distance, falling back to raw points for that batch — fixes OSRM occasionally snapping onto and confidently "matching" an unintended nearby parallel/detour road.

`APP_SCHEMA_VERSION` bumped to `73.79`, `node --check server.js` clean, `docker-compose.yml`/`host-server/docker-compose.yml`'s `com.rsw.version` labels and `host-server/sync-server/package.json` all brought to `73.79`. Both fixes live-tested against a mocked OSRM server before packaging.

## v73.78 — 2026-08-10 (or later)
### Version sync only — no host-server logic change

App v73.78 fixed a client-side map-panning bug (dense post-snap canvas markers blocking drag-grab of the map, plus re-applying a Ctrl-drag-mouseup safety net that had gone missing from this branch — see app `CHANGELOG.md` v73.78) and a doc/version-banner regression across several files. Nothing server-side touched. `APP_SCHEMA_VERSION` bumped to `73.78`, `node --check server.js` clean, `docker-compose.yml`/`host-server/docker-compose.yml`'s `com.rsw.version` labels (found reverted to `73.68`/stale) and `host-server/sync-server/package.json` all brought to `73.78`.

## v73.77 — 2026-08-09
### Version sync only — no host-server logic change

App v73.77 changed OSRM snap-on-Add-to-Segment from a silent best-effort to a mandatory default with explicit confirm dialogs on any failure (see app `CHANGELOG.md` v73.77), fixed a ~40-minute app-rebuild slowdown, added undo coverage for "✓ Add to Segment", and made auto-snap report what it actually did. Entirely client-side/build-config, nothing touching `server.js`. `APP_SCHEMA_VERSION` bumped to `73.77` for consistency with the rest of the version-bump checklist even though nothing here required it.

## v73.76 — 2026-08-09
### Version sync only — no host-server logic change

App v73.76 fixed the ~40-minute app-rebuild slowdown (`.dockerignore` never excluded `host-server/`, so `host-server/osrm-data`'s ~1.5GB OSRM graph was being transferred into the app's Docker build context on every build — see app `CHANGELOG.md` v73.76), added undo coverage for "✓ Add to Segment", and made the v73.75 silent OSRM auto-snap report what it actually did instead of failing invisibly either way. Entirely client-side/build-config except for none of it touching `server.js` at all this release. `APP_SCHEMA_VERSION` bumped to `73.76` for consistency with the rest of the version-bump checklist even though nothing here required it.

### Version sync only — no host-server logic change

App v73.72 fixed the road-name-still-hidden-under-the-zone-highlight bug and reconciled a divergent v73.70/v73.71 branch (see app `CHANGELOG.md` v73.72 for the full writeup) — entirely client-side (`SweepMaps.tsx`, `SweepJobs.tsx`), except for porting this session's own v73.70 OSRM point-pruning fix into `/api/roads/match` (that fork's `server.js` had never had it). `APP_SCHEMA_VERSION` bumped to `73.72`, `node --check server.js` clean, and `docker-compose.yml`'s `com.rsw.version` labels (found stuck at `73.68`/`73.69`) brought current too.

**Files changed:** `server.js`

Fixed the two Snap to Roads follow-ups from Craig's real-world test — see app `CHANGELOG.md` v73.70 for the full writeup (both entries below are server-side changes to the same session's fixes):

1. **`/api/roads/match` now prunes redundant near-collinear points** from OSRM's returned geometry before responding — OSRM's matched path follows every real OSM way vertex (denser than a hand-drawn path by nature), and most of that density is genuinely redundant on long near-straight runs. A point within 0.5m of the straight line between its neighbours is dropped without moving the path at all. This is what took Craig's real 1213→4191-point jump back down closer to a sensible size, feeding directly into the client-side marker-freeze fix in the same release.
2. **`osrm` service healthcheck fixed** (`docker-compose.yml`) — was using `wget`, which doesn't exist in the `osrm-backend` runtime image, so the healthcheck itself silently never ran rather than OSRM actually being unhealthy. Switched to a `bash -c '</dev/tcp/...'` TCP check, since bash is present even though no HTTP client is.

`APP_SCHEMA_VERSION` bumped to `73.70`; also caught and fixed `docker-compose.yml`/`host-server/docker-compose.yml`'s `com.rsw.version` labels stuck at `73.66`/`73.68`/`73.69` respectively during this pass — this exact stale-label pattern has recurred enough times (v72.8, v73.18, v73.26) that it's worth grepping for on every version bump, not just trusting the changelog entry.

## v73.69 — 2026-08-06
**Files changed:** `server.js`, `docker-compose.yml` (new `osrm` service), `setup-osrm.sh` (new), `.env.example`

New OSRM road-matching service — see app `CHANGELOG.md` v73.69 for the full feature writeup. Server-side specifics:

- New `osrm` Docker service (`ghcr.io/project-osrm/osrm-backend`, official image) added to `docker-compose.yml`, reading a pre-built graph from `./osrm-data` (built by the new `setup-osrm.sh`, which downloads the NZ Geofabrik extract and runs `osrm-extract`/`osrm-partition`/`osrm-customize`). `rsw-sync` reaches it over the internal Docker network via `OSRM_URL` (new env var, defaults to `http://osrm:5000`); `OSRM_PORT` (default 5000) is separately published for manual `curl`/browser testing.
- New endpoint `POST /api/roads/match` — takes `{ points: [{lat,lng}, ...] }` in the body (not query string, since a real segment easily has 1000+ points), batches to OSRM's `/match` API in groups of 100 with a 1-point overlap between batches for seamless stitching, and falls back to keeping a batch's original unsnapped points if OSRM can't confidently match that stretch (e.g. a carpark) rather than failing the whole request.
- Deliberately did NOT touch the existing `/api/roads/connect` (local Dijkstra point-to-point connector, v73.34) or its `buildLocalRoadGraph()`/`dijkstraPath()` helpers this release — built OSRM in additively so Craig could prove it out on real data before anything old gets removed, per his own stated preference for staged rollout on this feature.
- `APP_SCHEMA_VERSION` bumped to `73.69`, `node --check server.js` clean.

## v73.66 — 2026-08-05
### Version sync only — no host-server logic change

App v73.66 added a "Find Duplicate Lines" tool (see app `CHANGELOG.md` v73.66) that detects and stages excess near-identical lines left over when the same road gets added to a segment more than once — entirely client-side (`SweepJobs.tsx`); resolved and reviewed before a segment is ever saved, so nothing reaches `mergeData()`. `APP_SCHEMA_VERSION` bumped to `73.66` and `node --check server.js` re-run clean to keep app/server strings in step, per this project's own standing convention.

## v73.65 — 2026-08-05
### Version sync only — no host-server logic change

App v73.65 fixed a v73.64 follow-up bug where a manually-set A start point could get silently displaced from position 0 during greedy road chaining on large multi-road selections (see app `CHANGELOG.md` v73.65) — entirely client-side (`mergeRoadFeaturesIntoPath()` in `SweepJobs.tsx`); resolved before a segment is ever saved, so nothing reaches `mergeData()`. `APP_SCHEMA_VERSION` bumped to `73.65` and `node --check server.js` re-run clean to keep app/server strings in step, per this project's own standing convention.

## v73.64 — 2026-08-05
### Version sync only — no host-server logic change

App v73.64 added a "🏁 Set End Point" (B) control in Select Roads mode, symmetric to the existing "🚩 Set Start Point" (A) (see app `CHANGELOG.md` v73.64) — entirely client-side (`mergeRoadFeaturesIntoPath()` + UI in `SweepJobs.tsx`); B is resolved into a plain ordered point list before a segment is ever saved, so nothing new reaches `mergeData()` and no collection/field coverage changed. `APP_SCHEMA_VERSION` bumped to `73.64` and `node --check server.js` re-run clean to keep app/server strings in step, per this project's own standing convention.

## v73.63 — 2026-08-05
### Version sync only — no host-server logic change

App v73.63 fixed zones not appearing in Edit Sweep Job's Route Map and split zone selection into its own tab (see app `CHANGELOG.md` v73.63) — entirely client-side (`SweepJobs.tsx`, `SweepMaps.tsx` hint text). `sweepJobs.zoneIds` was already known/unioned server-side since v73.51, no new field or merge coverage needed. `APP_SCHEMA_VERSION` bumped to `73.63` and `node --check server.js` re-run clean to keep app/server strings in step, per this project's own standing convention.

## v73.62 — 2026-08-05
### Hotfix: v73.61's overflow fix over-corrected — mid-word breaks, squeezed buttons wrapping

Craig, screenshot: v73.61 stopped the card-overflow problem but introduced new ones — "days old" wrapped into "da/ys ol/d", the Prune Tombstones button wrapped into "Prune Tombst/ones", and the Operating bbox value broke mid-number ("175.15,-37/.85,175.35/,-37.70").

**Root cause.** `word-break:break-word` (added in v73.61) breaks *any* text at the container edge, including normal short words and buttons, not just genuinely unbreakable long strings — that's what `overflow-wrap:break-word` alone is for, and having both was redundant and too aggressive. Separately, the health-grid's `minmax(220px,1fr)` column width was simply too narrow for these two cards' inline controls (an input + label + button all fighting for space in one row) once card content grew past what the other, shorter cards ever needed.

**Fix.**
- Dropped `word-break:break-word` everywhere it was added in v73.61, kept `overflow-wrap:break-word` (still catches the original bbox/error-string overflow case without mangling ordinary words).
- Widened the grid's minimum column width from 220px to 260px.
- Tombstones' Prune button and Road Data's Update button are now full-width on their own row (`width:100%`) instead of squeezed in next to an input/label with `margin-left:auto` — removes the crowding that caused the button label itself to wrap.
- Road Data's "Operating bbox" and "Last OSM auto-update" rows switched from a same-line label/value `.kv` to the stacked label-above-value layout the "By collection" row already used — the long bbox/timestamp string gets its own full-width line instead of being squeezed into the narrow right half of a two-column row.

**Verified.** Same process as v73.61: booted a real server, fetched the rendered `/dashboard` HTML, confirmed the new CSS/markup is present in the served output, extracted and `node --check`'d the rendered `<script>` block. Not visually re-screenshotted in a real browser this session — Craig should confirm both cards now read cleanly, no mid-word breaks and no wrapped button labels.

## v73.61 — 2026-08-05
### Fixed dashboard health-card text overflowing the card border (Tombstones, Road Data cards)

Craig, screenshot confirming v73.60's road-update fix worked (14,982 roads indexed): the Tombstones and Road Data (Select Roads) health cards had text running past the card's right border — the "By collection" tombstone breakdown, the description paragraphs, and the monospace bbox/error values.

**Root cause.** `.kv` (the label/value row used by every health card) was `display:flex;justify-content:space-between` with no `gap`, no `flex-shrink`/`min-width` on either child, and `.health-card` itself had no `box-sizing:border-box` or `overflow-wrap`. A long unbroken value (a bbox string, a monospace filename, a long error message) had nowhere to wrap and simply overflowed the card's padding box instead. Most cards never hit this because their values were short; Tombstones' error/collection breakdown and the new Road Data card's bbox/error strings (v73.56+) were the first cards long enough to expose it.

**Fix.** Added `overflow-wrap:break-word`, `word-break:break-word`, and `box-sizing:border-box` to `.health-card`; added the same wrap properties plus `min-width:0` to `.kv .v`, `flex-shrink:0` to `.kv .k`, and an explicit `gap:10px` to `.kv` so the label and value can't collide once wrapping kicks in.

**Verified.** Per this project's standing rule for dashboard-JS/CSS changes: booted a real server locally, fetched the actual rendered `/dashboard` HTML over HTTPS, confirmed the new CSS rule is present in the served output (not just the source), and extracted + `node --check`'d the rendered `<script>` block to confirm nothing else broke. Not visually re-screenshotted in a real browser this session — Craig should confirm the Tombstones/Road Data cards now wrap cleanly rather than overflowing.

## v73.60 — 2026-08-05
### Hotfix: 406 Not Acceptable from Overpass — added User-Agent/Accept headers

Craig confirmed v73.59 fixed the ETIMEDOUT — the raw `https.request()` now connects — but Overpass returned `406 Not Acceptable` (an Apache-level content-negotiation rejection) with an HTML error body. `wget` continued to succeed against the same server throughout, and the difference is exactly what it usually is for a 406 from Apache: `wget` sends a default `User-Agent` and `Accept: */*`; the bare `https.request()` added in v73.59 sent neither.

**Fix.** Added `'User-Agent': 'RSW-Field-App-host-server/1.0 (+roads-auto-update)'` and `'Accept': '*/*'` to the request headers in `updateRoadsFromOverpass()`.

**Verified.** `node --check server.js` clean. Could not hit the real Overpass endpoint from this sandbox — Craig needs a rebuild (code changed) and a re-run of the same curl to confirm this actually returns real GeoJSON now instead of the 406 HTML page.

## v73.59 — 2026-08-05
### Hotfix: still ETIMEDOUT after v73.58 — replaced fetch() with raw https.request()

Craig confirmed v73.58's `NODE_OPTIONS=--dns-result-order=ipv4first` changed the failure mode from an instant generic "fetch failed" to `fetch failed (ETIMEDOUT)` — meaning Node's `fetch()` was now actually attempting a connection instead of failing before trying, but the connection itself still timed out reaching `overpass-api.de`. `docker exec rsw-sync wget ... overpass-api.de/api/status` continued to succeed instantly from the same container throughout, ruling out the network/firewall/DNS-server itself as the cause a second time.

**Fix.** Replaced the `fetch()` call in `updateRoadsFromOverpass()` with Node's built-in `https.request()` — the same lower-level mechanism `wget`/`curl` and Node's own `http`/`https` modules have always used reliably in this project (see `httpsMod` already in use elsewhere in `server.js`), rather than undici's `fetch()` implementation, whose own connection pooling/keep-alive/DNS resolution path appears to behave differently under this container's network in a way the `ipv4first` flag alone didn't fully resolve. Explicit `family: 4` set directly on the request as a second, more direct guarantee alongside the Dockerfile/compose-level env var (kept in place — doesn't hurt, may still matter for other future `fetch()` uses). 100s timeout preserved (`req.on('timeout')`), errors normalized to the same `fetch failed (CODE)` shape the dashboard/logs already expect.

**Verified.** `node --check server.js` clean. Could not exercise this against Overpass's real server or a real Docker network in this sandbox — Craig needs to rebuild (`docker compose build --no-cache && up -d --build`, this one needs a rebuild since the code itself changed, not just compose env) and re-run the same `POST /api/roads/update-osm` curl to confirm this actually clears the ETIMEDOUT this time.

## v73.58 — 2026-08-05
### Hotfix: `updateRoadsFromOverpass()` failing with bare "fetch failed" — Node's fetch tries IPv6 first

Craig, after v73.57's env-var fix: `POST /api/roads/update-osm` still returned `{"ok":false,"error":"fetch failed"}`. Diagnosis: `curl -X POST .../update-osm` reproduced it, the server log showed `[roads] Overpass update failed: fetch failed`, but `docker exec rsw-sync wget -q -O- https://overpass-api.de/api/status` succeeded fine from inside the same container — proving outbound internet access was not the problem.

**Root cause.** Node's built-in `fetch()` (undici) resolves DNS and attempts IPv6 first by default. Most Docker networks (including this project's) have no outbound IPv6 route, so the IPv6 attempt fails immediately and undici surfaces a generic `TypeError: fetch failed` rather than falling back to IPv4 the way `curl`/`wget` do out of the box. This affects every `fetch()` call in `server.js`, but only `updateRoadsFromOverpass()` (v73.56) exercises an outbound fetch at all — everything else is inbound Express routes.

**Fix.** Added `NODE_OPTIONS=--dns-result-order=ipv4first` in two places: `Dockerfile` (`ENV`, permanent, needs an image rebuild) and `host-server/docker-compose.yml`'s `environment:` block (works immediately with just `docker compose up -d`, no rebuild). Also improved the `/api/roads/update-osm` error handler to include `e.cause?.message`/`e.cause?.code` (undici's actual underlying error) alongside the generic message, so a future distinct failure won't hide behind the same unhelpful "fetch failed" string.

**Verified.** `node --check server.js` clean. No Docker available in this sandbox to run the container directly — Craig should confirm with `docker compose up -d` (compose-only fix takes effect immediately) or a full rebuild, then re-run the `POST /api/roads/update-osm` curl from his own diagnosis to confirm a real success response instead of the fetch error.

## v73.57 — 2026-08-04
### Hotfix: `ROADS_BBOX`/`OVERPASS_URL` never actually reached the container

Craig, mid-deployment of v73.56: rebuilt the container clean (`docker compose build --no-cache && up -d --build`), confirmed via `/health` that it was genuinely running `73.56.0`, but `GET /api/roads/status` still came back `bboxConfigured:false, bbox:null` despite `ROADS_BBOX` being correctly set in `host-server/.env`.

**Root cause, entirely on v73.56's side:** `.env` lets you *reference* a variable in `docker-compose.yml` via `${VAR}` substitution, but Compose only actually forwards a variable into the container if it's explicitly listed in that service's `environment:` block. v73.56 added `ROADS_BBOX`/`OVERPASS_URL` to `host-server/.env.example` and to `server.js`'s own `process.env.ROADS_BBOX` read, but never added the matching `- ROADS_BBOX=${ROADS_BBOX:-}` / `- OVERPASS_URL=${OVERPASS_URL:-...}` lines to `docker-compose.yml`'s `environment:` list — so the value silently never left the host machine's `.env` file, `server.js` saw `process.env.ROADS_BBOX` as `undefined` no matter what `.env` said, and the dashboard button stayed permanently disabled with no error message pointing at why. A silent env-var passthrough gap like this is exactly the kind of thing `node --check`/a clean build can't catch — the code was correct, the Docker wiring around it wasn't.

**Fix:** added the two missing lines to `host-server/docker-compose.yml`'s `environment:` block, same `${VAR:-default}` pattern every other env var here already uses.

**Verified.** No Docker available in this sandbox, so verified the actual substitution logic (not just YAML syntax) by simulating Compose's `${VAR:-default}` resolution in Python against Craig's real `.env` values and confirming `ROADS_BBOX`/`OVERPASS_URL` now appear correctly in the resulting container environment list, alongside every pre-existing var (`TZ`/`SYNC_TOKEN`/etc.) still resolving exactly as before — this touched only two new lines, nothing about the existing seven. `docker-compose.yml` re-parsed clean with `yaml.safe_load`. Craig still needs to confirm on his actual host with `docker compose up -d` (no rebuild needed — only the compose file changed, not the image) + a fresh `/api/roads/status` check.

## v73.56 — 2026-08-04
### New: one-click Road Data auto-update from OpenStreetMap (Overpass API) — dashboard button + endpoints

Craig: "is there a way to auto update it or have a update maps button in the host-server instead of having to go through all the steps for updating api/roads." The existing `extract-roads.sh` process (separate machine, `osmium-tool`, a ~250MB+ country `.pbf` download, manual `scp`/`docker cp`/reload-curl) is real overhead just to refresh an already-defined operating area. Added an **additional**, faster option for that common case — doesn't replace `extract-roads.sh`, which still exists for a first-time/large-area extract or for anyone who'd rather not depend on a public Overpass server.

**New `updateRoadsFromOverpass()`.** Queries the public Overpass API directly for the bbox in the new `ROADS_BBOX` env var (same format/axis-order as `extract-roads.sh`'s `BBOX`), filtered server-side to the exact same highway whitelist (`ROAD_HIGHWAY_WHITELIST`) `extract-roads.sh`'s own osmium filter uses, so the download stays small (a council-area box, not a country). Converts the response's `way` elements (fetched with `out geom;`, so full inline geometry, no separate node-resolution pass needed) into plain GeoJSON `LineString` features carrying the way's OSM tags as `properties` — exactly the shape `extract-roads.sh`'s osmium export already produces. Deliberately does **not** duplicate any classification logic: `classifyRoadFeature()`/`reloadRoadIndex()` run completely unchanged afterward, so the fine-grained service/access/lane/parking-aisle/living-street categorization stays the one place that logic lives and can never drift between the two ways of populating `roads.geojson`. The previous file is copied to `roads.geojson.bak` before each overwrite (atomic write via temp-file + rename, so a crash mid-write can't corrupt the live file).

**New endpoints.** `POST /api/roads/update-osm` triggers an update (accepts an optional `{bbox}` override in the body; returns `409` if one's already running rather than letting two overlapping fetches race each other). `GET /api/roads/status` reports the current index state plus the last update attempt/success/error, persisted to a new `roads-update-meta.json` in `DATA_DIR` so it survives a container restart rather than resetting to "Never" on every reboot.

**Dashboard.** New "Road Data (Select Roads)" card on the Health page, styled to match the existing Tombstones card — status, road count, load time, configured bbox, last-update result, and a "🗺️ Update Road Data (OSM)" button (disabled with a tooltip if `ROADS_BBOX` isn't set). `loadHealth()` now fetches `/api/roads/status` in parallel with `/health` via `Promise.all`, and tolerates that call failing without blanking the rest of the page.

**`.env.example`:** added `ROADS_BBOX` (defaults to the same Hamilton-area example `extract-roads.sh` already ships with) and `OVERPASS_URL` (defaults to the public `overpass-api.de` instance, documented as swappable for a self-hosted or alternate mirror).

**Verified live**, not just `node --check`. Booted the real server with a mocked Overpass endpoint (`OVERPASS_URL` override) returning four ways — an ordinary residential road, a tagged driveway, an out-of-whitelist footway, and a malformed <2-point way — and confirmed: the outgoing query's bbox axis-order conversion (`minLng,minLat,maxLng,maxLat` → Overpass's `south,west,north,east`) and highway regex were both correct; `roads.geojson` was written and `.bak`'d correctly; `GET /api/roads` returned exactly the expected result after classification (driveway excluded by default, footway never indexed, malformed way dropped); the `ROADS_BBOX`-not-configured and malformed-bbox-override error paths both fail cleanly (`500` with a clear message) without touching the existing file. Per this project's standing rule for dashboard-JS changes, extracted and `node --check`'d the actual rendered `<script>` block from a live `/dashboard` response, not just `server.js` itself. No `AppData`/`mergeData()` change — road data remains static reference data, unrelated to sync.

## v73.55 — 2026-08-04
### Version sync only — no server logic change

App v73.55 added the missing `host-server/restore-road-data.sh` script (see app `CHANGELOG.md` v73.55) — a pure shell wrapper around the already-existing `docker cp` + `POST /api/roads/reload` sequence, both unchanged here. `APP_SCHEMA_VERSION` bumped to `73.55` and `node --check server.js` re-run clean to keep app/server strings in step, per this project's own standing convention.

## v73.54 — 2026-08-04
### Version sync only — no host-server logic change

App v73.54 made New/Edit Road's map auto-center on the selected Area, matching New Zone's v73.46 behaviour (see app `CHANGELOG.md` v73.54) — entirely client-side (`MultiSegmentRoadMap` in `SweepJobs.tsx`), using the same Nominatim geocode endpoint the zone editor and city search box already call directly from the browser. `APP_SCHEMA_VERSION` bumped to `73.54` and `node --check server.js` re-run clean to keep app/server strings in step, per this project's own standing convention.

## v73.53 — 2026-08-04
### New road categories + `/api/roads` toggles: parkingaisle, serviceroad, livingstreet

Craig's three new Select Roads checkboxes (Parking Aisle, Service Road, Living Street — see app `CHANGELOG.md` v73.53 for the full writeup) needed server-side classification support. `classifyRoadFeature()` now splits `service=parking_aisle` out of the generic `ROAD_SERVICE_BLACKLIST`-driven `'service'` category into its own `'parkingaisle'` category; a bare `highway=service` with no recognised subtype now returns `'serviceroad'` instead of falling through to `'road'`; and `highway=living_street` now returns `'livingstreet'` instead of `'road'` — meaning living streets and plain service roads are now excluded from Select Roads by default where they weren't before this release (matches Craig's explicit ask, but worth flagging as a behaviour change for anyone who was relying on them appearing unconditionally).

`GET /api/roads` gained three new independent query params (`includeParkingAisles`, `includeServiceRoads`, `includeLivingStreets`), same boolean-string parsing and per-category filter pattern as the existing `includeServiceLanes`/`includeLanes`, and all five now appear in the response `meta` object.

**Verified.** `node --check server.js` clean. `APP_SCHEMA_VERSION` bumped to `73.53`. Hand-traced the classifier against `service=parking_aisle`, bare `highway=service`, `service=driveway`, `highway=living_street`, a Lane-named residential road, and an ordinary named road — all six landed in the expected category, with the three pre-existing categories (`road`/`service`/`lane`) unchanged for their original inputs. No data model or `mergeData()` change — this only affects what `/api/roads` returns, not any stored collection.

## v73.52 — 2026-08-04
### Version sync only — no host-server logic change

App v73.52 fixed the New/Edit Zone dropdown showing 10 duplicated entries after v73.51's category seeding (see app `CHANGELOG.md` v73.52) — purely a client-side filter in `SweepJobs.tsx`, nothing server-side to change. `APP_SCHEMA_VERSION` bumped to `73.52` and `node --check server.js` re-run clean to keep app/server strings in step, per this project's own standing convention.

## v73.51 — 2026-08-04
### Zone Kinds seeding, SW_CAT_META fix, sweepJobs.zoneIds known-field + union merge

Craig: SW Categories → Zone Kinds page showed "No zone kinds list found," and "zones is missing from edit sweep job" — see app `CHANGELOG.md` v73.51 for the full client-side writeup and root cause.

**Server-side pieces of the fix.** `SW_CAT_META` never had a `zone_kind` entry — added to both copies (the live object used by `applyMigrations()`/the restore-defaults endpoint, and the one embedded in the dashboard's own HTML template, which are two separate literal objects, not a shared reference). Added `'sc-zone-kind': 'zone_kind'` to `SW_CAT_ID_TO_TYPE` so the fixed-id repair/restore logic (`/sweep-categories/restore-defaults`, the categoryType self-heal in `applyMigrations()`, and the built-in-list delete guard) all now recognise it as one of the built-ins rather than treating it as an orphan/custom record. Fixed every hardcoded "14 built-in lists" reference to "15" (there were 6 of them across comments, an API response message, an error message, and a dashboard toast).

**sweepJobs.zoneIds.** New plain id-reference array field on `SweepJob`, exact same shape as the already-existing `areaIds`. Added to `KNOWN_JOB_FIELDS` so it's not flagged as an unrecognised field on every migration pass, and added to the `unionIdRefFields()` call already covering `areaIds`/`fileIds` for `sweepJobs` merges — unlike `areaIds`, which needed a real Craig-reported bug (v73.5) before getting union treatment, `zoneIds` got it from the day it was introduced.

**Verified.** `node --check server.js` clean. `APP_SCHEMA_VERSION` bumped to `73.51`. No data migration needed — `zoneIds`/the new `sc-zone-kind` category are both purely additive; any server already running v73.50 data will pick up the new built-in category the next time a client with this release pushes/pulls (the client-side backfill, not a server migration, is what actually creates it — see app changelog).

## v73.50 — 2026-08-04
### No server changes — version bumped to keep strings in step

App v73.50 added a sub-zone colour picker plus Undo Point / Clear & Redraw buttons to the zone editor (see app `CHANGELOG.md` v73.50). All of it operates on fields (`color`, `points`) that already existed on `SweepSubZone` and were already covered by v73.49's `mergeSubArrayById()` union for `sweepZones.subZones` — confirmed by grepping `KNOWN_ZONE_FIELDS` and `mergeData()` before treating this as UI-only. `APP_SCHEMA_VERSION` bumped to `73.50` and `node --check server.js` re-run clean, but no functional server code changed this release.

## v73.49 — 2026-08-04
### New merge rule: sweepZones.subZones unioned by id

Craig's new sub-zones feature (independent polygon pieces nested inside a `SweepZone`, same relationship `sweepRoads.segments` has to a road — see app `CHANGELOG.md` v73.49 for the full feature writeup) needed the same protection `segments` already got in v73.9: without it, two devices editing *different* sub-zones of the same zone while offline would have one whole `subZones` array silently overwrite the other's on whichever device's record `updatedAt` won. Added the same `mergeSubArrayById()` id-union call, in the same place, for `sweepZones` in `mergeData()`. Also added `fillEnabled`, `labelPos`, and `subZones` to `KNOWN_ZONE_FIELDS` so the schema-drift logger doesn't flag them as unexpected forever.

Verified against a real running instance of this server (not just code review): seeded a zone with one sub-zone, pushed a simulated "device A" addition of a second sub-zone, then a simulated "device B" rename of the first sub-zone (pushed as if offline since the baseline, unaware of device A's addition) — confirmed the actual merge response kept both changes, neither silently dropped.

## v73.48 — 2026-08-04
### Version sync only — no host-server logic change

Craig's "Keep doesn't restore, popup keeps coming back" report and the new local-tombstones/App-Health work are entirely client-side (`store.tsx`, new `AppHealth.tsx`). The one server-side piece the fix depends on — `POST /tombstones/remove` — already existed (built for exactly this recovery case) and needed no changes; the app simply never called it before. See app `CHANGELOG.md` v73.48 for the full writeup. Version bumped here to keep the app/server strings in step, per this project's own standing convention.

No new collections/fields, no `mergeData()` changes.

## v73.47 — 2026-08-04
### Dashboard accessibility: unassociated `<label>` elements

Craig's DevTools Issues panel: "A `<label>` isn't associated with a form field" for the Interval (`cfg-interval`) and Keep-last-N-backups (`cfg-deleteDays`) settings in the Auto Backup / Auto Delete cards. Both inputs already had real `id`s — just missing the matching `for=` attribute on their `<label>`. Added `for="cfg-interval"` and `for="cfg-deleteDays"`.

Checked the rest of `server.js`'s dashboard template for the same pattern (and the separate missing-id/name issue the same panel reported, 6 resources): every other `<label>` in the file nests its `<input>` directly instead of using `for` (the two toggle switches, the live-log auto-refresh checkbox), which already satisfies the association rule on its own, and no form field in `host-server/` is missing an `id` or `name`. These two were the only real gaps.

No collections/fields/schema affected — pure HTML markup fix, version bumped only to keep app/server strings in step per convention.

## v73.46 — 2026-08-04
### Version sync only — no host-server logic change

Craig's full batch this round (New Zone map centering/search, Zone Type SW Categories integration, right-click Set Start/End A/B, Add-to-Segment direction confirm popup, Chart.js `Filler` plugin console error, and a retroactive "Simplify Points" button for pre-v73.45 segments) was entirely client-side — `SweepJobs.tsx`, `SweepCategories.tsx`, `types.ts`, and `chartSetup.ts`. See app `CHANGELOG.md` v73.46 for the full writeup. Nothing in `server.js` changed beyond the schema-version constant; the new `zone_kind` categoryType is a plain string value on the already-generically-merged `sweepCategories` collection, so no new collection, field, or `mergeData()` work was needed. Version bumped here to keep the app/server strings in step, per this project's own standing convention.

## v73.45 — 2026-08-03
### Version sync only — no host-server logic change

Craig's 2228-point-segment / stray-points-on-unselected-roads report traced entirely to client-side geometry handling: `simplifyPath()` (v73.37) was only ever applied to the gap-fill detour spliced in by `fillGapsWithRealRoads`, never to the raw OSM-survey-density road pieces the segment was actually built from. Fixed in `SweepJobs.tsx` by simplifying the whole post-gap-fill chain — see app `CHANGELOG.md` v73.45 for the full writeup and the reproduction numbers. Nothing in `server.js` changed beyond the schema-version constant; `roads.geojson` and the `/api/roads`/`/api/roads/connect` endpoints are untouched, since the extra density was always in the client-side merge step, not in what the server returns. Version bumped here to keep the app/server strings in step, per this project's own standing convention.

No new collections/fields, no `mergeData()` changes.

## v73.44 — 2026-08-03
### Version sync only — no host-server logic change

Craig suspected `/api/roads`/`/api/roads/reload` (v73.12) as the cause of continued freezing entering Edit Road, guessing at Docker inter-container communication lag between the app and this server. Investigated and ruled out before changing anything: those endpoints only fire in Select Roads mode on debounced pan/zoom, are abort-controlled and capped at 2000 features, and don't run during ordinary segment creation/editing at all — same-host container-to-container HTTP is also not a plausible source of felt UI freezing. The real cause was still client-side, exactly where v73.42 flagged it would be if the lag persisted: point markers (one HTML `divIcon` per point) on the active segment, uncapped. Fixed entirely in `SweepJobs.tsx` with viewport culling above the same 300-point threshold v73.42 already used for polylines — see app `CHANGELOG.md` v73.44 for the full writeup. Nothing in `server.js` changed beyond the schema-version constant; version bumped here to keep the app/server strings in step, per this project's own standing convention.

No new collections/fields, no `mergeData()` changes.

## v73.43 — 2026-08-03
### New: "Lane" road exclusion category, plus the fix behind a client-side Lasso bug

Two changes here, both in `server.js`:

**New `'lane'` road category.** Craig asked for a checkbox like the existing car-parks/driveways one, but for roads named "... Lane". Unlike car parks/driveways (tagged `service=driveway`/`access=private` in OSM), there's no tag for this — `classifyRoadFeature()` now also does a whole-word, case-insensitive `\blane\b` match against the road's name, returning a new `'lane'` category (checked after, and independent of, the existing `'service'` classification). `GET /api/roads` gained a new `?includeLanes=1` query param, following the exact same off-by-default/opt-in pattern `?includeServiceLanes=1` already established — the two are independent toggles in the response filter, not a combined flag, since a crew may genuinely want one included without the other. `meta.includeLanes` added to the response alongside the existing `meta.includeServiceLanes` for parity. Tested live: booted the server against a mock `roads.geojson` with a mix of Lane-named roads, an ordinary street, a tagged driveway, and a deliberately-similar-but-non-matching name ("Planeview Crescent", to confirm the word-boundary regex doesn't false-positive on a mere substring) — default/​`includeLanes=1`/`includeServiceLanes=1`/both-together all returned exactly the expected feature sets.

**Lasso fix note:** the actual "half the roads weren't selected" bug Craig reported lives entirely client-side (`confirmLassoFence` in `SweepJobs.tsx` — see app `CHANGELOG.md` v73.43 for the full root-cause writeup), nothing in `server.js` needed to change for it. Version bumped here anyway to keep the app/server version strings in step, per this project's own standing convention.

No new collections/fields, no `mergeData()` changes — road classification is live-queried index data, never synced or stored per-device.

## v73.42 — 2026-07-31
### Version sync only — no host-server logic change

Urgent client-side hotfix: severe lag entering Edit Road on large segments, root-caused to one interactive Leaflet polyline per edge (2227 of them for a 2228-point segment, per Craig's own report) — now run-batched above 300 edges. See app `CHANGELOG.md` v73.42. Nothing in `server.js` changed.

## v73.41 — 2026-07-30
### Version sync only — no host-server logic change

Bumped in lockstep with the app's v73.41 — a batch of client-side fixes (zone modal resize/move/bigger, m² alongside ha in zone totals, a Leaflet Canvas click-tolerance fix for line selection, a more thorough Ctrl+drag box hit-test, and explicit Transit/Solid buttons). See app `CHANGELOG.md` v73.41 for the full story. Nothing in `server.js` changed.

## v73.40 — 2026-07-29
### Version sync only — no host-server logic change

Bumped in lockstep with the app's v73.40, which made Push & Sync consult the already-existing `GET /tombstones` endpoint before sending — closing the gap where only Pull was deletion-aware. See app `CHANGELOG.md` v73.40 for the full story. `GET /tombstones` itself is unchanged; this release is the app finally using it.

## v73.39 — 2026-07-29
### Fixed the "View" record modal, and a self-caused syntax break while doing it — plus segment merge recency

See app `CHANGELOG.md` v73.39 for the full story. Two real server-side changes:

**1. Record-view modal now summarizes large arrays by default.** `showRecord()` used to `JSON.stringify(record, null, 2)` straight into the page unconditionally — fine until Select Roads (v73.12) let a single road accumulate 1500+ points, at which point pretty-printing it can hang the browser laying out the resulting wall of text, especially on weaker hardware. New `summariseForDisplay()` collapses any array over 30 items down to its length plus the first 3 and last 2 items, with a "Show Full JSON" toggle button in the modal footer for when the complete record is actually needed. Purely a display convenience — Delete and every other action still operate on the real, complete record via `modalRecord`, never the summarized view.

**2. A mistake made and caught while building #1.** First draft used ordinary template-literal backticks and `${...}` — but the entire `/dashboard` page this code lives in is itself one giant template literal returned from `renderDashboard()`-adjacent code in `server.js`. Unescaped backticks (including one inside a `//` comment) terminated that outer literal early and broke the whole file's syntax. `node --check server.js` caught it before anything shipped. Rewritten with zero backticks anywhere in the block, and — since a syntax check alone wouldn't have proven the fix actually renders correctly — verified by starting the server against a scratch `DATA_DIR` and `curl`-fetching the live `/dashboard` response, confirming HTTP 200 with the new code present and correctly formed in the served HTML.

**3. `normaliseSweepRoad()` backfills a missing `segments[].updatedAt`**, and `mergeData()`'s `sweepRoads` branch now logs an explicit `[merge] CONFLICT:` line when the same segment id has genuinely different `points` on both sides of a sync — same reasoning as the equivalent app-side fix (`RouteSegment` gaining a real `updatedAt`): segments previously had no timestamp at all, so recency resolution for concurrent edits was effectively arbitrary rather than meaningful. The resolution itself is unchanged (still newer-wins via `mergeSubArrayById`), just no longer silent when it happens.

**Diagnosed, not changed:** the "deleted stuff keeps coming back" report traces to `POST /sync`'s auto-delete propagation being deliberately removed at v71.5 (Craig's own explicit request, for safety). Confirmed still correct and unchanged — Craig asked to leave this behaviour as-is for now.

**Verified:** `node --check server.js` clean, plus a live server start + `curl` fetch of `/dashboard` confirming correct rendering — not just a syntax check, given what a syntax-only check would have missed here.

## v73.38 — 2026-07-28
Version bump only, in lockstep with the app release (`APP_SCHEMA_VERSION`
bumped to `'73.38'`) — no server-side code changed. See app `CHANGELOG.md`
v73.38: further lag fixes on Craig's actual (weak/old) test hardware —
inactive road segments no longer render decorative point markers, midpoint
insert-handles skip sub-3m edges, and `preferCanvas: true` added to every
Leaflet map instance across the app for cheaper vector-layer rendering.
Entirely client-side; nothing about `/api/roads`, `/api/roads/connect`, or
any sync/merge behaviour changed.

## v73.37 — 2026-07-27
Version bump only, in lockstep with the app release (`APP_SCHEMA_VERSION`
bumped to `'73.37'`) — no server-side merge or routing logic changed. See app
`CHANGELOG.md` v73.37: added client-side `simplifyPath()` (Douglas-Peucker) to
thin near-collinear survey vertices out of real-road-routed detours before
they're spliced into a job's `segments`, since `buildLocalRoadGraph()` here
keys a graph node on every OSM way vertex, not just intersections. No change
to this file's routing endpoint itself. No new fields/collections, so
`mergeData()` needed no changes.

## v73.36 — 2026-07-27
Version bump only, in lockstep with the app release (`APP_SCHEMA_VERSION` bumped
to `'73.36'`) — no server-side merge logic changed. See app `CHANGELOG.md`
v73.36 for the client-side fixes: scoped the `Maps.tsx` marker-sync effect off
the full `data.inspections` array so unrelated inspection edits stop rebuilding
map markers, and compressed two previously-uncompressed photo upload paths in
`SweepJobs.tsx` (fuel dockets, extra expenses). No new fields/collections, so
`mergeData()` needed no changes.

## v73.35 — 2026-07-27
Version bump only, in lockstep with the app release (`APP_SCHEMA_VERSION` bumped
to `'73.35'`) — no server-side merge logic changed. See app `CHANGELOG.md` v73.35
for the client-side fix: debounced `saveData()`/the add-update-delete diff logger
in `store.tsx` so the app no longer serializes the entire local dataset twice on
every single change (this was the cause of the reported app-wide lag), plus a
`useMemo` fix for the jobs list filter in `SweepJobs.tsx`. No new fields or
collections were added, so `mergeData()` needed no changes this release.

## v73.33 — 2026-07-24
Version bump only, in lockstep with the app release — no server-side code changed. See app `CHANGELOG.md` v73.33 for the client-side fix (removed the manual road-offset slider; "Sweep both sides" now automatically offsets its two passes symmetrically, one each side of the true road centreline, instead of both passes being coincident and the slider shifting them together to one side).

## v73.34 — 2026-07-27
### New: real road-network routing — `buildLocalRoadGraph()`, `dijkstraPath()`, `GET /api/roads/connect`

See app `CHANGELOG.md` v73.34 for the full story (Craig: make Select Roads/Lasso's connector between two non-touching selected pieces follow real streets instead of a straight line across blocks/houses).

**New endpoint:** `GET /api/roads/connect?fromLng&fromLat&toLng&toLat` — builds a small local graph from just the roads in a padded bbox around the two points (padding scales with the gap distance: `max(gap × 1.5, 300m)`, capped at 3000m so a very large/likely-unroutable gap can't balloon into a slow graph), snaps each point to its nearest graph node (40m tolerance), and runs Dijkstra between them. Returns `{ found: true, coords: [[lng,lat],...] }` for a real path, or `{ found: false, reason }` for: `roads-not-loaded` (no `roads.geojson`), `no-roads-in-area`, `no-nearby-road-node` (a point too far from anything in the local graph), or `no-path-in-local-area` (nothing connects them within the padded bbox, or the local graph exceeded the 20,000-node safety cap).

**Node identity, worth understanding if this ever needs debugging:** two OSM ways that meet at a real intersection share the exact same coordinate at that point in the source data (same underlying node, no rounding drift from the extract) — so nodes are keyed by coordinate rounded to 6 decimal places (~11cm at the equator), which reliably merges floating-point-identical OSM nodes into one graph node without needing this project's `roads.geojson` to carry actual OSM node IDs (it doesn't, and never has). This is a per-request local graph, not a persistent global one built into `reloadRoadIndex()` — keeps memory/rebuild cost at zero for this feature and keeps each request's graph small regardless of how large the underlying road file for the whole install is; `queryRoadsInBbox()` (existing, grid-indexed) is reused to pull just the local roads needed.

**Verified:** `node --check server.js` clean, plus a standalone Node reproduction of the graph-building and Dijkstra logic (8 checks) — see app `CHANGELOG.md` v73.34 for the full test list, since the actual bug this addresses (the straight-line connector) is client-visible, not server-only.

## v73.30 — 2026-07-23
Version bump only, in lockstep with the app release — no server-side code changed. See app `CHANGELOG.md` v73.30 for the client-side fix (a real bug: switching between route segments left an in-progress Select Roads selection/Lasso fence alive, so it could land on the wrong segment on the next commit).

## v73.29 — 2026-07-23
Version bump only, in lockstep with the app release — no server-side code changed. See app `CHANGELOG.md` v73.29 for the client-side feature (manual "🚩 Set Start Point" for Select Roads, addressing original request #2 — choosing A/B before the merge, for dead-end roads where direction matters).

## v73.28 — 2026-07-23
Version bump only, in lockstep with the app release — no server-side code changed. See app `CHANGELOG.md` v73.28 for the client-side fix (white-halo highlight on staged/pending-delete lines so they're visible against a same-coloured road). Note: this entry was missing from this changelog when v73.28 first shipped — added retroactively while adding v73.29, so both changelogs' version numbering stays unambiguous.

## v73.27 — 2026-07-23
`server.js`: registered a new `sweepZones` collection (see app `CHANGELOG.md` v73.27 for the full feature — drawable polygon Zones for car parks/business sites, tracked by area not km). Added to `ALL_COLLECTIONS` (which generically drives sync, backup/restore, and tombstone/delete handling for every collection — no extra logic needed for those), plus a `KNOWN_ZONE_FIELDS` drift-detection registry and admin dashboard icon/label/count/summary-table entries, mirroring what already existed for `sweepRoads`. No new endpoints — Zones use the same generic collection endpoints every other collection does.

## v73.26 — 2026-07-23
Version bump only, in lockstep with the app release — no server-side code changed. See app `CHANGELOG.md` v73.26: this is a reconciliation release merging the docs-catch-up v73.25 branch with the separate bug-fix v73.25 branch (stable segment ids / Ctrl+drag / transit toggle / right-click delete fixes in `SweepJobs.tsx`) that Craig had been treating as two different things both called v73.25. `host-server/docker-compose.yml`'s version label was also found stale at v73.15 during this pass and brought up to date.

## v73.25 — 2026-07-22
### `install-host.sh` now generates `restore-road-data.sh`, plus a new `road-data-setup/README.md` guide

Craig: "make a doc for setting up the host-server with the extract-roads.sh maps feather." Both `_create_docker_helper_scripts()` and `_create_nodejs_helper_scripts()` now also generate `restore-road-data.sh` (alongside `start.sh`/`stop.sh`/`backup-data.sh`/etc.) — takes a path to a `roads.geojson` file, copies it into place, and calls the existing `POST /api/roads/reload` endpoint so it's usable immediately with no restart. `_print_success_banner()` now mentions both the script and the new beginner-friendly `road-data-setup/README.md` guide (see app `CHANGELOG.md` v73.25 for that guide's content) up front. `extract-roads.sh`'s own closing instructions now point to `restore-road-data.sh` as the easiest path. No `server.js` logic changed — `/api/roads/reload` already existed.

**Verified:** `bash -n install-host.sh` clean; manually traced heredoc variable escaping against the existing `backup-data.sh` generator for both install paths. No network this session to run a fresh install end-to-end — please run through one (or at least read the generated script on a real host) before relying on this for disaster recovery.

## v73.24 — 2026-07-22
Version bump only, in lockstep with the app release — no server-side code changed. See app `CHANGELOG.md` v73.24 for the client-side fixes (Find Long Jumps detector, road-label offset for merged Select-Roads paths, lasso fence midpoint-insert).

## v73.23 — 2026-07-21
Version bump only, in lockstep with the app release — no server-side code changed. See app `CHANGELOG.md` v73.23 for the client-side fix (Draw Points bulk delete/transit-convert via stage-then-confirm click and Ctrl+drag box, mirroring the existing road-deselect staging pattern).

## v73.22 — 2026-07-20
### Version sync only — no host-server logic change

Bumped `APP_SCHEMA_VERSION`/`package.json` to stay in step with the app's v73.22 (see app `CHANGELOG.md`): Deselect mode's single-click now stages roads for removal (with Delete/Confirm and Escape/Cancel) instead of removing them instantly. Entirely client-side — nothing in `server.js` changed this round.

## v73.21 — 2026-07-20
### Version sync only — no host-server logic change

Bumped `APP_SCHEMA_VERSION`/`package.json` to stay in step with the app's v73.21 (see app `CHANGELOG.md`): Ctrl+drag rubber-band box select in the road editor, and restricting the freeform Lasso tool to Select mode (Deselect uses Box/Ctrl+drag instead). Both are entirely client-side — nothing in `server.js` or `roads.geojson` handling changed this round.

## v73.20 — 2026-07-20
### `isSweepableRoadFeature()` → `classifyRoadFeature()` — car parks/driveways/service lanes now toggleable, not hard-excluded

Craig: "sometimes we would do carparks or driveways and service lanes or business driveway/service lanes" — the v73.15/73.16 exclusions were the right default but couldn't be overridden. The yes/no filter is now a 3-way classification (`'road'` / `'service'` / `null`) — `'service'`-classified ways (the exact same car-park/driveway/business-service-lane/private-access conditions v73.15/73.16 already identified) are now kept in the in-memory index instead of dropped, just tagged. `GET /api/roads` gained `?includeServiceLanes=1`: omitted/false (default) returns only `'road'`-classified features, identical to the old always-on exclusion; set true, `'service'`-classified features are included too, each tagged with its `category` in the response. `null`-classified ways (footpaths, cycleways, tracks, etc.) are still never kept regardless of the param — no toggle brings those back. See app `CHANGELOG.md` v73.20 for the client-side toggle UI. No change to `roads.geojson` itself or how `extract-roads.sh` generates it — this is purely how the server classifies and serves what's already in that file.

**Verified:** `node --check server.js` clean; standalone reproduction of `classifyRoadFeature()` against 11 cases (the full v73.15/73.16 test suite plus the new null-vs-service split) and of the endpoint's category filter under both toggle states — all correct.

## v73.18 — 2026-07-20
### Version sync + `extract-roads.sh` moved into this folder

No `server.js` logic changed — the real fix this round (Select Roads/Lasso losing a selection that spans more than one map pan) was entirely client-side; see app `CHANGELOG.md` v73.18. `extract-roads.sh` moved here from the project root, per Craig: "it make it confusing when you have to do everything in that folder and docker container" — every other setup step (`docker compose`, `docker cp`, the reload curl) already happens from inside `host-server/`. While moving it, also fixed a regression back to clip-before-filter ordering that could OOM-kill on a wide bbox — restored the filter-first ordering, see the script's own header comment and app `CHANGELOG.md` v73.18 for the full explanation. Nothing about `roads.geojson`'s location, the `/api/roads` endpoint, or the reload flow changed — only where the *generator* script lives.

## v73.17 — 2026-07-20
### Version sync only — no host-server logic change

Bumped `APP_SCHEMA_VERSION`/`package.json` to stay in step with the app's v73.17 (see app `CHANGELOG.md`), which fixed two client-side bugs (stale job/sweeping-maps route rendering, and a `road.points`-only check hiding routes drawn into a non-first segment). Nothing in `server.js` changed this round.

## v73.16 — 2026-07-20
### Fixed: business roads/private driveways/car park access roads with only an `access=*` tag still slipping past the v73.15 filter

Craig: "losso mode is adding business roads, private driveways access roads, car parks & access road, service lanes for business are been added when it should not been added." See app `CHANGELOG.md` v73.16 for the full picture (bulk lasso-deselect, the other half of this round, is client-only).

**Root cause:** v73.15's `isSweepableRoadFeature()` only excluded `highway=service` ways by their `service=*` subtag (`driveway`/`parking_aisle`/`parking`/`drive-through`). This class of road is very commonly mapped in OSM as plain `highway=service` (occasionally `highway=unclassified`/`residential`) with an `access=private`/`access=no`/`access=customers` restriction and no `service=*` tag at all — those went straight through the old whitelist unfiltered.

**Fix:** added `alley` to the `service=*` blacklist (business back-lanes), and a new `access=*` blacklist check (`private`/`no`/`customers`) applied regardless of the way's `highway`/`service` tags. `access=destination` is deliberately left alone — that marks genuine public through-streets with local-traffic-only restrictions, not private property, and blacklisting it would drop real roads.

**Verified:** standalone Node script instantiating `isSweepableRoadFeature()` from the actual `server.js` source (not a re-implementation) against both the previously-failing tag combinations Craig described and a set of negative controls (`access=destination`, ordinary `residential`/`tertiary`/`service` roads, existing footway/driveway exclusions) — all resolved correctly. Also `node --check server.js`.

**Important for Craig:** same as v73.15 — this fixes the *already-generated* `roads.geojson` immediately, no re-extract needed. Restart the container or call `POST /api/roads/reload`.

## v73.15 — 2026-07-20
### Fixed: `roads.geojson` road index was serving footpaths/cycleways/crossings/driveways alongside real roads

Craig: "in lasso mode it is also add footpath, crossings, cycle ways and driveways after pushing confirm fence they are not meant to be add only roads are meant to be added." See app `CHANGELOG.md` v73.15 for the full picture (this was one of three bugs fixed together this round, the other two are client-only).

**Root cause:** `reloadRoadIndex()` (loads `DATA_DIR/roads.geojson` at startup and on `/api/roads/reload`) accepted any `LineString` feature with no regard for its OSM `highway`/`service` tags — `extract-roads.sh`'s own blanket `w/highway` filter was equally permissive, so nothing upstream of the app was filtering by road type either.

**Fix:** new `isSweepableRoadFeature(props)` whitelist function, run against every feature's `properties` before it's added to the in-memory road index (and therefore before it's ever returned by `GET /api/roads?bbox=...`). Keeps: `motorway`/`trunk`/`primary`/`secondary`/`tertiary`/`unclassified`/`residential`/`living_street` (+ their `_link` variants) and `service` — but `service` ways tagged `service=driveway`/`parking_aisle`/`parking`/`drive-through` are excluded even though the base `highway` value matches. Drops: `footway` (including `footway=crossing`), `cycleway`, `path`, `pedestrian`, `steps`, `track`, `bridleway`, `corridor`, and anything with no recognized `highway` tag at all.

**Important for Craig:** this fixes the *already-generated* `roads.geojson` immediately — no need to re-run `extract-roads.sh`. Just restart the container (`docker compose restart rsw-sync`) or call the existing reload endpoint (`curl -X POST https://localhost:8055/api/roads/reload -H "X-Sync-Token: $SYNC_TOKEN" -k`). The startup/reload log line now also reports how many non-road ways were filtered out, e.g. `[roads] Loaded 4200 road ways from roads.geojson (skipped 1830 non-road ways — footpaths/cycleways/crossings/driveways/etc.)`, so it's visible at a glance whether the filter is doing something.

Also tightened `extract-roads.sh`'s own osmium filter to the same whitelist (see app `CHANGELOG.md` v73.15) — defense in depth for a fresh extract, though `server.js`'s filter is the authoritative guarantee regardless.

**Verified:** `node --check server.js` clean. Standalone Node reproduction of `isSweepableRoadFeature()` against 14 real-world tag combinations (residential/tertiary/living_street/plain-service kept; footway/footway-crossing/cycleway/path/pedestrian/steps/track/driveway/parking_aisle/missing-highway-tag all correctly dropped) — all 14 passed. Did not boot a real server against a real `roads.geojson` this round (no sample OSM extract available in this sandbox) — the filter function itself and the `reloadRoadIndex()` wiring were both verified directly instead.

## v73.14 — 2026-07-20
Version bump only, in lockstep with the app release — no server-side code changed. See app `CHANGELOG.md` v73.14 for the Lasso Select redesign (click-to-place fence points + Confirm/Cancel, replacing v73.13's drag gesture that was blocking map panning).

## v73.13 — 2026-07-20
Version bump only, in lockstep with the app release — no server-side code changed this round. See app `CHANGELOG.md` v73.13 for the client-side Select Roads fixes (deselect-while-in-lasso-mode, box → freeform lasso).

## v73.12 — 2026-07-16
**Files changed:** `server.js`, `package.json`, `docker-compose.yml`

### New: `GET /api/roads` + `POST /api/roads/reload` — road-network data for the app's new "Select Roads" segment-drawing mode

See app `CHANGELOG.md` v73.12 for the client-side feature. Server side:

- At startup, reads `roads.geojson` (a self-hosted OSM road extract — see the new root-level `extract-roads.sh` script) from `DATA_DIR`, if present, and builds an in-memory coarse lat/lng grid index (`ROAD_GRID_SIZE = 0.01`, ~1km cells) so a bounding-box query only scans cells it actually overlaps rather than the whole file. Fine at this data size (one council-area extract, not a whole-country dataset) — a real spatial database would be overkill.
- `GET /api/roads?bbox=minLng,minLat,maxLng,maxLat` (requires the usual `X-Sync-Token` auth) returns a GeoJSON `FeatureCollection` of road ways intersecting the box, capped at 2000 features per request (the client re-queries as the user pans/zooms in, rather than the server ever trying to ship an entire region at once).
- If `roads.geojson` is missing, the endpoint doesn't error — it returns `{features: [], meta: {loaded: false, reason: ...}}` so the app can show an in-app "no road data yet" message instead of a broken feature. The rest of the server (sync, backups, everything else) is completely unaffected either way.
- `POST /api/roads/reload` re-reads `roads.geojson` from disk without a container restart, for after copying in a refreshed/expanded extract.
- This is static reference data, not `AppData` — it is never part of `/sync`, `/data/:collection`, or any backup/restore, and needed no `mergeData()` changes.

**Verified:** the grid-index build and bbox query, including a request that should return nothing and a request against a missing file, were tested with a standalone Node reproduction of the exact logic (isolated from `server.js` since this sandbox has no network to `npm install` express/dotenv/etc. and boot the real server — flagging that gap honestly). **Craig should still do one real end-to-end check** — start the container, drop in a real `roads.geojson`, and confirm `curl .../api/roads?bbox=...` returns real data — before relying on this in the field.

## v73.11 — 2026-07-15
**Files changed:** `package.json`, `docker-compose.yml` — version strings only, no server code changed this round

No server changes. See app `CHANGELOG.md` v73.11 — Add New User no longer has an Email field (logins are now auto-derived usernames), and the default admin login changed from `admin@inspection.com` to `admin` with a client-side migration for existing installs. `users` doesn't need a dedicated server-side merge branch — it's a flat collection, already covered correctly by the generic merge. Version bumped to keep strings in step.

## v73.10 — 2026-07-14
**Files changed:** `server.js`, `package.json`, `docker-compose.yml`

### Applied a sibling session's `sweepRoads.segments` sync-merge fix

Craig uploaded a different v73.9 zip from a separate session (independently branched off the same v73.8) whose own audit — done in response to the v73.8 standing rule — found `sweepRoads.segments` (a road's own route-segment definitions: id, label, color, points; edited independently per segment in the Areas & Roads route editor) was still going through the generic whole-record `mergeArrays()` in `mergeData()`, the same silent-drop risk already fixed for `sweepJobs.roads`, `maps.pins`, `sweepMaps.pins`, `inspections.photos`, and `sweepJobSites.mapPins`. It had been missed because `sweepRoads.points` (the road's primary polyline, deliberately left unmerged — no per-point id) sits right next to it and looks similar at a glance; `segments` items actually have their own ids and independent state, `points` items don't.

Applied their fix as-is: new `sweepRoads` branch in `mergeData()`, unioning `segments` by id via the existing `mergeSubArrayById` helper (same pattern as every other id-bearing sub-array fix in this file). Different bug from what my own concurrent v73.9 work had touched (`sweepJobs.roads[].segmentSettings`/`damagePins` — job-level run-tracking data, not the road's own segment definitions) — genuinely complementary, applied both.

**Verified:** `node --check server.js` clean. Wrote a standalone reproduction: two road snapshots, one with a renamed segment the other never saw and a newer `updatedAt` on the "losing" side — confirmed the old whole-record merge dropped the rename entirely and the fix keeps both segments.

## v73.9 — 2026-07-14
**Files changed:** `server.js`, `package.json`, `docker-compose.yml`

### Fixed: `segmentSettings`/`damagePins` inside each road could be silently dropped on multi-device sync — found while fixing the Sweep Reports segment-data bug

Checking the new §0 standing rule (added last release) against the road-level merge in `mergeData()`'s `sweepJobs` branch found it was still only a shallow `{...existing, ...r}` spread for each road entry. `roads`/`fuelDockets`/`tipRuns`/`extraExpenses` at the job level are properly deep-merged, but the fields nested *inside* each individual road — `damagePins` and `segmentSettings` — were not. If a road got edited on two devices while one was offline (e.g. Device A adds a damage pin or records segment 1's run details, Device B's edit to the same road wins on `updatedAt` without ever having seen those), Device A's data would silently vanish on sync. Same bug class as `tipRuns` (v73.4) and `maps.pins` (v72.2), just one level deeper than the original "Bug 7 fix" reached.

**Fix:** `damagePins` now merges by `id` (reusing the existing `mergeSubArrayById` helper); `segmentSettings` merges by `segIdx` (a plain number — `SegmentRunDetail` has no `id` field) via the same id-keyed-Map pattern used everywhere else in this file.

**Verified:** `node --check server.js` clean. Wrote a standalone reproduction: two road snapshots, one with a recorded segment 1 (Heavy debris) the other never saw and a newer `updatedAt` on the "losing" side — confirmed the old shallow-spread logic dropped segment 1's data entirely and the fix keeps both segments' settings.

## v73.8 — 2026-07-13
**Files changed:** `server.js`, `package.json`, `docker-compose.yml` — version strings only

No server changes this release. Craig asked for a standing rule to be added (to `CLAUDE_CONTEXT.md` and the release skill) requiring any new app field/collection to have its host-server `mergeData()` handling checked/updated in the same change, given this project's history of silent data loss when that step gets skipped. See app `CHANGELOG.md` v73.8. Version bumped to keep strings in step.

## v73.7 — 2026-07-13
**Files changed:** `server.js`, `package.json`, `docker-compose.yml` — version strings only

No server changes this release. See app `CHANGELOG.md` v73.7: Sweep Reports pie charts (Debris Level, Damage Type, Severity) were counting an unrecorded dropdown value as a fake "Unknown" data point — fixed to exclude those entirely so only actually-selected values are charted. Version bumped to keep `APP_SCHEMA_VERSION` and package strings in step with the app release.

## v73.6 — 2026-07-13
**Files changed:** `server.js` (version string only), `package.json`, `docker-compose.yml`

No functional server changes — see app `CHANGELOG.md` v73.6 (Sweep Job Run Details auto-persist fix + Debris Type field). Version bumped to keep strings in step.

## v73.5 — 2026-07-13
**Files changed:** `server.js`, `package.json`, `docker-compose.yml`

### "Check and fix all the others" — audited every collection for the same sync data-loss bug class as tipRuns

Craig, after the v73.4 tipRuns fix, asked for every other collection on the host-server dashboard (the full nav list — Sweep Jobs, Areas & Roads, Sweeping Maps, Sweep Reports, SW Categories, Job Sites, Sweep Clients, Inspections, Maps, Reports, Categories, Clients, Users) to be checked for the same bug class rather than waiting for each to be separately reported. Read `CLAUDE_CONTEXT.md` then both changelogs first, per standing instruction.

**Method:** cross-referenced every collection's actual shape (`src/types.ts`) against `mergeData()`'s branches. Any collection with an array-of-objects sub-field carrying its own independent state (added/edited on a device without necessarily touching the parent record) was falling through to the generic `mergeArrays()` — a whole-record field-union that silently drops the *entire* sub-array from whichever device's copy loses the `updatedAt` comparison, exactly the class of bug already fixed piecemeal for `sweepJobs.roads`/`fuelDockets` (Bug 7 fix), `maps.pins` (v72.2), and `sweepJobs.tipRuns`/`extraExpenses` (v73.4).

**Found and fixed the same gap in:**
- **`inspections`** — `photos`, `comments` (both id-keyed), and `mapPins` (no `id` field on `MapPinLink`, unioned by the composite `mapId+pinId` key instead). This is arguably the highest-impact miss of the three: inspections are the most frequently concurrently-edited records in the whole app — multiple field workers adding photos/comments to the same site visit is a routine, not edge-case, scenario. Previously: worker A adds a photo offline, worker B (also offline) only changes the condition field but with a later timestamp — on sync, worker A's photo would vanish entirely.
- **`sweepMaps`** — `pins`, exact sibling bug to the already-fixed `maps.pins`, just never applied to this collection specifically since it wasn't the one in the original report. Also unioned `linkedJobIds`.
- **`sweepJobSites`** — `mapPins` (`SiteMapPin`, has its own `id`) — water points, tip sites, hazards marked on two devices while offline could silently lose one side's pins.

**Lower-risk but same class, added a general-purpose fix for:** plain id-reference arrays (`string[]` fields that just point at other records, no independent per-item state) — `reports.inspectionIds`/`.categories`, `sweepReports.jobIds`/`.areaIds`, `sweepAreas.roadIds`, and `sweepJobs`' top-level `areaIds`/`fileIds`. These now union (order-preserving, deduped) instead of the losing side's list being silently discarded.

**New reusable helpers** (`mergeSubArrayById`, `mergeIdRefArray`, `unionIdRefFields`) replace what would otherwise have been near-identical bespoke code at each of these call sites — any future collection with the same shape can reuse them directly instead of hand-rolling another copy of the pins-merge logic.

**Deliberately NOT fixed — documented as a known gap, not silently left:** `sweepRoads.points`/`.segments[].points` (route geometry). `RoadPoint` has no `id` field, only `{lat, lng, transitAfter}` — there's no safe identity to merge two point arrays by. Merging by array index would misalign points if the two devices' arrays differ in length, which would actively corrupt the route rather than just losing data — worse than the current behavior. Redrawing a route is also realistically a single-device operation in practice, making this lower real-world risk than the fixes above. Flagging honestly rather than shipping something that could make things worse; would need stable point ids to do properly.

**Verified:** `node --check server.js` clean. Wrote standalone tests for every new merge path (extracted the actual merge functions from `server.js` into an isolated test file, not reimplemented copies) covering the exact concurrent-edit scenario for each: inspection photos/comments, sweepMaps pins, report id-reference unioning, and the dedupe/order-preservation behavior of `mergeIdRefArray` — all passed. Went further than a function-level test: booted the actual server against a scratch data directory and ran a real HTTP round-trip through the live `/sync` endpoint — seeded a server-side inspection with a photo, then pushed a simulated "Device B" copy with a newer `updatedAt` that never saw that photo, and confirmed the real, running server's merged response still contained it. This is the same verification rigor established for the `tipRuns` fix in v73.4, applied to every new path this round rather than just one.

## v73.4 — 2026-07-13
**Files changed:** `server.js`, `package.json`, `docker-compose.yml`

### Fixed: `sweepJobs.tipRuns` (and `extraExpenses`) could be silently dropped on multi-device sync — prompted by Craig asking whether the new tip run date would actually save to the server

`mergeData()`'s `sweepJobs` branch (added for "Bug 7 fix") deep-merges `roads` by `roadId` and unions `fuelDockets`, but `tipRuns` and `extraExpenses` were still falling through to the outer `mergeArrays(s[col], c[col])` — a whole-record field-union. If the same job was edited on two devices while one was offline, whichever device's job record won on `updatedAt` would overwrite the other's `tipRuns` array **entirely**, not merge it — any trip only known to the "losing" device (including its new date field from v73.3) would vanish from the server on sync. This is the identical bug class already fixed for `sweepJobs.roads`/`fuelDockets` (a prior "Bug 7 fix") and `maps.pins` (v72.2) — it just hadn't been checked for `tipRuns` specifically until Craig's question prompted a look.

**Fix:** `tipRuns` now merges two levels deep — first by run `id` (a run is per-road), then within each run, by trip `id` — so a trip that only exists on one device survives the merge instead of being dropped when its parent run record loses a whole-record conflict. `extraExpenses` gets the same id-based union treatment `fuelDockets` already had.

**Verified:** `node --check server.js` clean. Wrote a standalone reproduction: two device snapshots of the same job, each with a tip run trip the other never saw and a newer `updatedAt` on the "losing" device's side — confirmed the old logic dropped the other device's trip entirely (`trips = ["tripB"]`) and the fix keeps both (`trips = [tripA, tripB]`), same verification pattern used for the `maps.pins` fix in v72.2.

## v73.3 — 2026-07-13
**Files changed:** `package.json`, `docker-compose.yml` — version strings only, no server code changed this round

No server changes. See app `CHANGELOG.md` v73.3 — Tip Run trips gained their own per-trip date (for multi-day jobs), a "Total Runs Per Day" breakdown, and a per-day chart in Sweep Reports. Purely client-side (`SweepJobs.tsx`/`SweepReports.tsx`/`types.ts`); version bumped to keep strings in step.

## v73.2 — 2026-07-13
**Files changed:** `package.json`, `docker-compose.yml` — version strings only, no server code changed this round

No server changes. See app `CHANGELOG.md` v73.2 — exported reports' GPS maps are now pre-rendered static images instead of live Leaflet/tile-fetching, fixing them showing OpenStreetMap's "Access blocked" tile when a downloaded report was opened in Firefox. Purely a client-side (`Reports.tsx`) fix; version bumped to keep strings in step.

## v73.1 — 2026-07-13
**Files changed:** `server.js`, `package.json`, `docker-compose.yml`

### Hotfix: v73.0 broke the entire dashboard — nested template-literal escaping bug

Craig: "host-server not working now", immediately after v73.0. My bug. `server.js` generates the whole dashboard's HTML+JS as one big template literal string (`res.send(\`...\`)`); the browser-facing JS lives *inside* that as literal text. In the v73.0 `renderLiveLog()` function I wrote `text.split('\n')`, intending the two characters `\` and `n` to reach the browser so its own JS would interpret them as a newline escape. But Node processes escape sequences in the *outer* template literal first — a single `\n` in that context is consumed as an escape and becomes one real newline character, injected directly into the HTML response. The result sent to the browser was `text.split('` + an actual line break + `')` — an unterminated string literal, a hard syntax error that aborted the dashboard's entire `<script>` block, not just the live-log feature. That's why it looked like the whole dashboard was down.

**Fix:** `'\n'` → `'\\n'` at that one call site (two source backslashes so Node emits exactly one literal backslash + n into the output, which the browser's own JS parser then correctly interprets as a newline escape).

**General note for future edits in this file:** anything inside the dashboard's outer template literal that's meant to be an escape sequence *for the browser's JS* (`\n`, `\t`, `\\`, `` \` ``, `${`) needs one extra level of escaping to survive being embedded in the server's own template literal first. `node --check server.js` does not catch this class of bug — it only validates server.js's own syntax, not the string content it produces.

**Verified this time by actually rendering the output, not just checking the source file:** booted the server against a scratch data dir, fetched the real `/dashboard` response, extracted the actual `<script>` content the browser receives, and ran `node --check` on *that* (clean). Then loaded it in a real headless Chromium, logged in with the token, navigated to the Debug page, and confirmed zero JS errors plus a working Live log panel showing genuine server log output.

## v73.0 — 2026-07-13
**Files changed:** `server.js`, `package.json`, `docker-compose.yml`

### Added the "Live — today's log" panel to the dashboard's Debug page — it never actually existed here before

Craig's screenshot (dashboard Debug page, only the static per-day file list visible) plus his message "host-server live view still missing" traced back to a mistaken assumption in v72.9: that release added a live-tailing panel to the **client app's** Debug page and said in its own comment it was matching the "host-server dashboard's own version" of the same feature — but grepping this file (`server.js`) for any prior live-view code, then and again just now, finds nothing. The dashboard's Debug page has only ever rendered the static per-day list (`app.get('/logs', ...)` + the day-list UI). There was never a regression to find; the feature simply didn't exist here yet.

**Added `GET /logs/today/live`** — returns `{ date, text }` for today's log file (empty string if nothing's been written yet today), using the server's own `todayStr()` so the "today" boundary always matches the file the server itself is actually writing to, regardless of what timezone the browser viewing the dashboard happens to be in. (This project already hit a real bug from exactly this kind of client/server date mismatch once — v72.7 — so it's worth being deliberate about it here even though this endpoint doesn't touch data records.)

**Added the dashboard UI**: a card above the existing log-file list with an Auto-refresh toggle (polls every 3s, matching the client Debug.tsx panel's interval), a manual Refresh button, and a dark scrollable box that renders each line via `createElement`/`textContent` (not `innerHTML` — log lines can contain arbitrary server-generated text and must not be treated as HTML) and auto-scrolls to the bottom when new lines arrive and the user was already at the bottom. Wired into the existing `showPage()`/auto-refresh lifecycle: starts polling on entering the Debug page, stops on leaving it or on logout — mirrors how `startAutoRefresh()`/`stopAutoRefresh()` already work for the main 30s dashboard refresh, just a separate faster timer scoped to this one panel.

**Verified live, not just read:** booted the server locally against a scratch `DATA_DIR`, confirmed `GET /logs/today/live` returns `401` without a token, confirmed the correct `{date, text:""}` empty-state shape before any log activity existed for the day, then issued a real `POST /backup/now` and confirmed the very next poll of `/logs/today/live` contained that request's log line — an actual round-trip against a running server. `node --check server.js` clean.

## v72.9 — 2026-07-13
**Files changed:** `package.json`, `docker-compose.yml` — version strings only

No server changes. See app `CHANGELOG.md` v72.9 — the app's Debug Log moved to its own sidebar page and gained a "Live — today's log" auto-refreshing view matching this server's own Debug page. Version bumped to keep strings in step.

## v72.8 — 2026-07-13
**Files changed:** `package.json`, `docker-compose.yml` — version strings only

No server changes. See app `CHANGELOG.md` v72.8 — added a proper nginx log format for the app container plus filtered its Docker healthcheck noise out of the logs, so Craig can actually see real client requests in Whaler like he already could for this host-server. Version bumped to keep strings in step.

## v72.7 — 2026-07-13
**Files changed:** `server.js`, `Dockerfile`, `package.json`, `docker-compose.yml`

### Fixed: server-side debug log files also mis-bucketed by a day for NZ, same root cause as the app's debug log (see app `CHANGELOG.md` v72.7)

`todayStr()` used `new Date().toISOString().slice(0, 10)` to name the day's log file — UTC, not local, so for most of the NZ working day the server was writing to (and the dashboard was reading) the previous day's log file. Fixed by building the date string from local getters (`getFullYear()`/`getMonth()`/`getDate()`) instead.

**Also fixed the reason `TZ=Pacific/Auckland` wasn't fully doing its job:** that env var has been set in `docker-compose.yml` for a while, but the host-server's Dockerfile is `node:20-alpine`, and Alpine doesn't ship `tzdata` by default — without it, Node's timezone database lookups for named zones like `Pacific/Auckland` can silently fail to apply. Added `tzdata` to the `apk add` line alongside the existing `curl`/`openssl`. Between this and the `todayStr()` fix, the server's local-time getters (used here and anywhere else in `server.js` that reads wall-clock date/time) now correctly reflect NZ time inside the container, not UTC.

**Verified:** `node --check server.js` clean.

## v72.6 — 2026-07-13
**Files changed:** `package.json`, `docker-compose.yml` — version strings only

No server changes. See app `CHANGELOG.md` v72.6 — report maps are now fully self-contained (vendored Leaflet inlined into the exported HTML instead of loaded from the live server's origin), fixing the report not rendering maps at all in Firefox or on other computers. Version bumped to keep strings in step.

## v72.5 — 2026-07-13
**Files changed:** `server.js`, `package.json`, `docker-compose.yml` — version strings only

No server changes this release. All the work this round was documentation: added a prominent, mandatory reminder in `CLAUDE_CONTEXT.md` about descriptive output zip naming (a past session had stopped following it), and brought that file's version tables and history up to date. See app `CHANGELOG.md` v72.5. Version bumped to keep `APP_SCHEMA_VERSION` and package strings in step with the app release.

## v72.4 — 2026-07-13
**Files changed:** `server.js`, `package.json`, `docker-compose.yml` — version strings only

No server changes this release. All the work this round was on the app side: finished a marker-icon fix (missing `delete L.Icon.Default.prototype._getIconUrl` step) that an earlier, unfinished session had correctly diagnosed but not applied, moved that icon fix to run globally at app startup instead of per-page, and repaired a `## v72.2` heading that had been accidentally deleted from the app's own `CHANGELOG.md`. See app `CHANGELOG.md` v72.4 for full detail. Version bumped to keep `APP_SCHEMA_VERSION` and package strings in step with the app release.

## v72.3 — 2026-07-13
**Files changed:** `server.js` (version string only), `package.json`, `host-server/docker-compose.yml`

No functional server changes — see app `CHANGELOG.md` v72.3 (report GPS marker-icon path made absolute for exported-file robustness). Version bumped to keep strings in step.

## v72.2 — 2026-07-13
**Files changed:** `server.js`, `package.json`, `docker-compose.yml`

### Fixed: `mergeData()`'s `maps` collection merge silently dropped pins during sync (root cause of "pins not showing" report bug — see app `CHANGELOG.md` v72.2 for the full symptom description)

`maps` was going through the generic `else` branch in `mergeData()` — plain `mergeArrays(s[col], c[col])`, a whole-record field-union. That's fine for flat fields, but `pins` is a nested array with its own per-pin `id`s, and a field-union just takes the winning record's `pins` key wholesale (spreading `{...ex, ...item}` overwrites `pins` entirely, it doesn't merge it). So if Device A added a pin while Device B was offline, then Device B later synced an edit to the *map itself* (e.g. a rename) with a newer `updatedAt`, Device B's copy of `pins` — which never saw Device A's new pin — won and silently erased it from the server. This is the same bug class already fixed for `sweepJobs.roads` (deep-merged by `roadId` inside the `sweepJobs` branch) and `SweepCategory.items` (`mergeCategoryItems`), just never extended to `maps.pins`.

**Fix:** added a dedicated `maps` branch in `mergeData()` (alongside the existing `sweepJobs` and category branches) that, after the normal record union, unions each map's `pins` array by pin `id` — for a pin `id` present on both sides, the one with the newer `updatedAt`/`createdAt` wins on conflicting fields, but a pin only present on one side is always kept. Logs `[merge] map "<name>": pins union server=X client=Y → merged=Z (prevented pin loss)` when a union actually changes the pin count, for visibility during Craig's own sync testing.

Also hardened `applyCascadeCleanup()`'s `mapPins` repair (rule 2): previously it only stripped a `mapPins` entry when its `mapId` pointed at a deleted map. It now separately detects a **ghost `pinId`** — map still exists, but that specific pin id doesn't (e.g. left over from before this fix, or a pin genuinely deleted on the map) — and clears just `pinId` on that entry rather than dropping it, since the entry's `mapId` and any saved `snapshot` are still valid/useful even without a live pin reference.

**Verified:** `node --check server.js` clean. Reproduced the bug and the fix in an isolated script:
```
OLD (bug):   pins = [{"id":"pinB","label":"End"}]        ← pinA silently lost
NEW (fixed): pins = [{"id":"pinA","label":"Start"},{"id":"pinB","label":"End"}]
```
Craig — after updating both the field device(s) and this host-server to v72.2, run one Pull & Merge / Push & Sync cycle on each device so the cascade cleanup can clear any already-orphaned `pinId` references from before this fix.

## v72.1 — 2026-07-13
**Files changed:** `server.js`, `package.json`, `docker-compose.yml` — version strings only

No server changes. See app `CHANGELOG.md` v72.1 — fixed GPS pins not rendering in the Report preview/PDF (missing Leaflet default-icon path patch inside the report's standalone iframe). Version bumped to keep strings in step.

## v72.0 — 2026-07-13
**Files changed:** `server.js`, `package.json`, `docker-compose.yml` — version strings only

No server changes this release. See app `CHANGELOG.md` v72.0 — full app audit plus fixes for a GPS-lock-carries-over-to-new-inspection bug and the sweep-map live-tracking "Road Lock" not actually snapping to the mapped road. Version bumped to keep `APP_SCHEMA_VERSION` and package strings in step with the app release.

## v71.9 — 2026-07-09
**Files changed:** `server.js`, `package.json`, `docker-compose.yml` — version strings only

No server changes this release. Craig confirmed via screenshot that the Health/Debug page built in v71.8 (Tombstones panel, `/tombstones/prune`, built-in-list delete protection, per-day console-capture log files) looks correct and matches what he wants — all the real work this round was on the app side. See app `CHANGELOG.md` v71.9: fixed a regressed `pushToServer()` data-loss bug and rebuilt the on-device Debug Log to capture live add/update/delete/error activity instead of just sync summaries. Version bumped to keep `APP_SCHEMA_VERSION` and package strings in step with the app release.

## v71.8 — 2026-07-03
**Files changed:** `host-server/sync-server/server.js`, `host-server/sync-server/package.json`, `host-server/docker-compose.yml`

### Ported tombstone-prune, built-in-list delete protection, and Debug Log from a divergent v71.5.0-labelled zip

Craig sent a zip still stamped v71.5.0 containing real work from a session that never got version-bumped. Read both changelogs first, then ported forward:

**Tombstones panel on the Health page.** `GET /health` now includes a `tombstones` summary (count, retention days, how many are past retention, oldest, breakdown by collection). New `POST /tombstones/prune` does age-based bulk cleanup — `{ olderThanDays }`, defaults to `TOMBSTONE_DAYS`, `0` clears every tombstone. A backup is always taken first. This is distinct from the existing `POST /tombstones/remove` (exact-id, for undoing one specific mistaken deletion) — prune is routine garbage collection by age.

**Built-in category lists can no longer be deleted.** `DELETE /data/sweepCategories/:id` and `DELETE /data/categories/:id` now reject deleting any of the 14 (or 3) built-in default list ids, using the existing `SW_CAT_ID_TO_TYPE`/`CAT_ID_TO_TYPE` maps already in this codebase from earlier id-based-matching work. Renaming a built-in list and deleting/adding items *within* it are both still fully allowed — only deleting the list record itself is blocked. This is what makes `olderThanDays: 0` on tombstone-prune safe: built-ins can never be tombstoned in the first place.

**Debug page.** New "🐞 Debug" nav item next to Health. `console.log`/`warn`/`error` are now also captured to a per-day file (`DATA_DIR/logs/YYYY-MM-DD.log`) by wrapping the three console methods at startup — catches everything the server already logs (sync results, migrations, backups, deletes, cascade cleanups) without hand-picking events. New routes: `GET /logs` (list with sizes), `GET /logs/:date` (download), `DELETE /logs/:date`, `DELETE /logs` (all). Retention via the existing Settings mechanism (`logRetentionDays`, default 4 days), auto-prunes on every settings save and on startup.

**Verified:** `node --check server.js` clean. Directly extracted and unit-tested the built-in-delete-guard logic (blocks `sc-debris-type`, allows a custom id) and the tombstone-prune date-cutoff logic (90-day cutoff correctly separates old/recent; `olderThanDays: 0` clears everything) against synthetic data, plus a direct filesystem test confirming the log-file write/read path works. Live-server HTTP testing was attempted but the sandbox's background-process handling proved unreliable across tool calls this session; the ported code is verbatim from a session whose changelog documents its own live HTTP testing (built-in delete rejection, `/health` tombstone reporting, `/tombstones/prune` at 0 days, `/logs` listing/download/delete, `/settings` persistence) — worth Craig doing one confirmation pass after redeploying.



No functional server changes — see app `CHANGELOG.md` v71.7 (sidebar version placement/size fix). Version bumped to keep strings in step.

## v71.6 — 2026-07-03
**Files changed:** `host-server/sync-server/server.js` (version string only), `host-server/sync-server/package.json`, `host-server/docker-compose.yml`

No functional server changes this release — see app `CHANGELOG.md` v71.6. Version bumped to keep `APP_SCHEMA_VERSION` and package strings in step with the app release; investigation confirmed `POST /sync`/`GET /sync` are unchanged and correct from v71.5 (no tombstone-stripping, full merge).

## v71.5 — 2026-07-02
**Files changed:** `sync-server/server.js`, `sync-server/package.json`, `../docker-compose.yml`

### Removed auto-delete propagation from `POST /sync`

Per Craig's explicit request — see `CHANGELOG.md` (app) v71.5 for the full explanation and the new client-side review flow.

**What changed here:** `POST /sync` used to call `applyTombstonesToClientData()` before merging a push — this stripped any record from the incoming push that matched a server-side tombstone, so a device that still had a since-deleted record could never resurrect it on the server. That function (and the call to it) has been removed. A push now merges everything the client sends, unconditionally — if a device still has a record the server no longer does, pushing it restores it to the server's backups. That's now the only "undo" path for a server-side delete, and it's fully manual: it only happens if the device chooses to keep the record (via the app's new Pull & Merge review dialog) and then pushes.

**What did NOT change:** the dashboard's own delete tooling — `DELETE /data/:collection/:id`, `addTombstone()`, `pruneTombstones()`, and the `/tombstones` GET/restore endpoints — is untouched. That's the host-server's own recently-deleted/restore bookkeeping for the dashboard operator, and it's a manual, single-side action already; it was never the auto-propagation mechanism.

**Verified:** `node --check server.js` clean.

## v71.4 — 2026-07-02
**Files changed:** `host-server/sync-server/server.js`

### Full audit of `GET /data/:collection` (per Craig's request, after the sweepCategories field-stripping bug)

The v71.3 fix for SW Categories was itself just one instance of a much bigger, general problem: `GET /data/:collection` — the endpoint behind the dashboard's collection table, "👁 View" button, and (for sweepCategories) the Items modal — built a hand-picked summary object per record instead of returning the stored record. Before v71.3 it only ever whitelisted `id/name/status/date/area/createdAt/updatedAt`, plus a one-off special case for `sweepRoads`. Everything else was silently dropped on the way out, regardless of how correct the underlying stored data was.

Audited every collection against this same pattern. Confirmed the same class of bug in:
- **`inspections`** — `photos`, `comments`, `mapPins`, GPS fields, and `mapSnapshot` were all being dropped. "👁 View" on an inspection never showed its photos or comments.
- **`sweepJobs`** — `roads`, `fuelDockets`, `extraExpenses`, `tipRuns`, `fileIds`, `areaIds` were all being dropped.
- **`sweepJobSites`** — `mapPins`, `fileIds`, `areaIds` were being dropped.
- **`maps` / `sweepMaps`** — `pins` were being dropped.
- **`categories` / `coverTemplates`** and everything else — same whitelist problem to varying degrees.

**Fix:** replaced the whitelist entirely. `GET /data/:collection` now returns the full stored record for every collection — the dashboard's View/Items/Edit features all need complete data to work correctly, and this is a low-traffic LAN admin tool, not a bandwidth-constrained mobile client, so there's no real cost to sending complete records. The only trimming that remains: `sweepFiles.data`, `sweepMaps.imageData`/`maps.imageData`, and `coverTemplates[].cover.logoData` — the handful of fields whose entire purpose is one large embedded base64 blob — are replaced with a lightweight `hasData`/`hasImageData`/`hasLogoData` marker in this list response only. The full blob is still returned by `GET /data/:collection/:id` (single-record fetch); it's just not repeated on every row of a list that may have hundreds of records.

Confirmed this doesn't clutter the dashboard table itself: column selection was already capped to a fixed 5-column priority list (`id/name/title/type/status/email/date/createdAt/updatedAt`) intersected with whatever fields are present — it doesn't dynamically add a column for every field in the record — and the cell renderer already gracefully collapses arrays/objects to a "N items"/"object" tag rather than dumping raw JSON into a cell.

**Verified:** `node --check server.js` clean. Seeded a real inspection with photos+comments and a sweepFile with a data blob; confirmed `GET /data/inspections` now returns the full photos/comments arrays (previously would have returned neither), and `GET /data/sweepFiles` returns `hasData: true` with the actual blob correctly stripped.

## v71.3 — 2026-07-02
**Files changed:** `host-server/sync-server/server.js`

### Found it — the actual root cause of "0 items" / "Custom" on SW Categories, after months of chasing categoryType data corruption

Craig hit the existing `GET /debug/sweep-categories` diagnostic endpoint (added in an earlier version for exactly this kind of check) and it proved the stored data was correct all along: every record had its real `categoryType` (`debris_type`, `zone_type`, etc. — never `'custom'`) and real item arrays with real counts and names. That directly contradicted the dashboard table, which still showed every list as "📦 Custom (0 items)".

**The actual bug:** `GET /data/:collection` — the endpoint the dashboard's collection table and Items modal both fetch from — builds a generic per-record "summary" object that only ever included a fixed whitelist of fields (`id`, `name`, `status`, `date`, `area`, `createdAt`, `updatedAt`), plus a special case that adds extra fields for `sweepRoads` only. It never had a special case for `sweepCategories`, so `categoryType` and `items` were silently stripped out of every sweepCategories record before it ever reached the browser — regardless of how correct the underlying stored data was. The dashboard's NAME column, the "Items (N)" button, the Items modal, and the item-delete feature all read `r.categoryType`/`r.items` straight from this response, so all of them were working off data that had already been thrown away server-side.

This means essentially every categoryType investigation this app has been through (name-matching, id-matching, tombstones, migrations) was fixing real, separate bugs in the underlying stored data — but none of those fixes could ever have been *visible* on the dashboard, because this endpoint was discarding the fields the whole time.

**Fix:** added a `collection === 'sweepCategories'` case to the summary builder (mirroring the existing `sweepRoads` case) that includes `categoryType` and the full `items` array.

**Verified:** `node --check server.js` clean. Ran the server standalone, seeded `sc-debris-type` with 5 real item objects, and confirmed `GET /data/sweepCategories` now returns `categoryType: "debris_type"` and the full 5-item array (previously would have returned neither). Also verified the existing item-delete flow (`PUT /data/sweepCategories/:id` with an item removed) still persists correctly and the item count updates.

**Craig's next step:** rebuild + redeploy, then a browser refresh of `/dashboard` (no data changes needed — nothing was ever actually broken on disk).

## v71.2 — 2026-07-02
**Files changed:** `host-server/sync-server/server.js`

### Bug fix: "Keep last N backups" limit appeared to not save

Craig reported the Auto Delete "Keep last N backups" number wasn't sticking. Traced it to the dashboard's 30-second auto-refresh: while the Backups tab is open, `refreshAll()` was calling `loadBackupSettings()` on every tick, which re-fetches `/settings` and overwrites the "Keep last N backups" input (and the Auto Delete toggle) with whatever's currently saved on the server — silently wiping out any value the user had typed but not yet clicked "💾 Save Settings" for. This looked exactly like the limit "not saving", even though the actual save→disk→reload pipeline was working correctly (verified directly against `POST /settings` → `backup-settings.json` → `GET /settings`, round-trips fine).

**Fix:** the periodic 30s refresh now only reloads the backup *list* (read-only, safe to refresh) on the Backups tab — it no longer touches the settings form. `loadBackupSettings()` still runs on explicit navigation to the Backups tab and via the "↻ Reload" button, just never on the passive timer.

**Verified:** `node --check server.js` clean. Ran the server standalone and confirmed `POST /settings` with `keepLastNAutoDelete: 12` persists to `backup-settings.json` and `GET /settings` returns 12 correctly, and confirmed the served dashboard HTML no longer wires `loadBackupSettings()` into the periodic refresh block.

## v71.1 — 2026-07-02
No host-server changes this version (app-only — see app `CHANGELOG.md`).

## v71.0 — 2026-07-02
**Files changed:** `host-server/sync-server/server.js`, `host-server/sync-server/package.json`, `host-server/docker-compose.yml`

### Root cause of the "all Custom, 0 items" regression: categoryType repair was name-based, and the lists had been renamed

Full write-up in the app `CHANGELOG.md` v71.0 entry (same root cause, fixed on both sides). Short version: `applyMigrations()`'s categoryType/type repair only ever matched a record's own `name` against the fixed default labels. Craig had renamed several built-in lists via the app (e.g. `sc-damage-type`'s list is now named "Damage and points of interest", not "Damage Types") — once the name no longer matches a default label, name-based matching can never recover a corrupted categoryType, so any record that lost its type (e.g. during the v59.15 crash-loop window) stayed permanently mislabelled "Custom (0 items)" on the dashboard, regardless of how many migration passes ran.

**Fix:** new module-level `SW_CAT_ID_TO_TYPE` and `CAT_ID_TO_TYPE` maps (mirroring the app's `DEFAULT_SWEEP_CATEGORIES`/`DEFAULT_CATEGORIES` ids — these 14 + 3 built-in lists always keep a **fixed id** even after a rename). `applyMigrations()` now checks a record's `id` against these maps *first*, before falling back to the existing name-based match — this heals renamed lists that name-matching could never reach.

**Also fixed — `inspectMigrations()` blind spot:** the startup auto-migration check for `sweepCategories`/`categories` only ever looked at whether items had a `color` field — it never checked whether `categoryType`/`type` itself needed repair. This meant a server that only had a categoryType problem (no missing item colors) would report "schema is current" at startup and skip the repair entirely, only fixing itself on the next app push. Now also flags a record needing migration when its `categoryType`/`type` is missing, or when its id maps to a known default type it doesn't currently have.

**Verified:** `node --check server.js` clean. Standalone test replicating Craig's exact scenario (all 14 default lists renamed, categoryType hard-corrupted to `'custom'`, including the literal `sc-damage-type` → "Damage and points of interest" case from his screenshot) confirms every record is correctly reclassified via id match.

**Craig — after redeploying:** either restart the server (the `inspectMigrations()` fix means it will now self-heal on startup) or do a normal Push to Server from the app. No manual endpoint call needed this time — unlike the v59.18 tombstone issue, this is a pure repair-logic fix with no data to un-delete.

## v70.9 — 2026-07-02
**Files changed:** `host-server/sync-server/server.js`, `host-server/sync-server/package.json`, `host-server/docker-compose.yml`

### Version renumbered from v59.18 to v70.9 (Craig's instruction) + Dashboard: SW Categories table column fix

**Versioning:** renumbered `59.18.0` → `70.9.0` per Craig's explicit request. Going forward: next update → `v71.0`, then `.1` increments (`v71.0 → v71.1 → ... → v71.9 → v72.0`).

**Dashboard bug — this was a display issue, not a sync/data issue.** `/debug/sweep-categories` confirmed all 14 `sweepCategories` lists already had correct `categoryType` and item counts (the v59.13–v59.18 tombstone/categoryType fixes were working correctly). The dashboard's SW Categories table just had its columns showing the wrong thing:

- **Before:** "Name" column showed the record's own editable name (e.g. "Damage and points of interest"); "Categories" column showed a generic `SW_CAT_META`-derived tag (e.g. "⚠️ Damage Types") + item count. Backwards from what's useful, and redundant with each other.
- **Fix (`renderTable()`):** "Name" column now shows the fixed categoryType/section label (e.g. "⚠️ Damage Types"). "Categories" column relabeled **"List Name"**, now shows the record's own name (e.g. "Damage and points of interest") + item count. The existing "📋 Items (n)" action button is unchanged — already expands each item with icon/name/description.

**Verified:** `node --check server.js` clean. Cell-rendering logic tested standalone against Craig's real `sc-damage-type` record (`/debug/sweep-categories` output: `categoryType: damage_type`, `name: "Damage and points of interest"`, 5 items) — confirmed output: Name column → `⚠️ Damage Types`, List Name column → `Damage and points of interest (5 items)`. **Not verified in a live browser** — no access to Craig's server from this session. Craig: please confirm the dashboard renders as expected after deploying.

## v59.18 — 2026-07-01
**Files changed:** `host-server/sync-server/server.js`, `host-server/sync-server/package.json`, `host-server/docker-compose.yml`

### Solved with real data: the 4 "missing" lists were tombstoned, not lost

Craig sent an app backup and a server backup so this could be diagnosed from real data instead of screenshots. That immediately showed the categoryType/items fixes from v59.16–v59.17 are working correctly — all 10 overlapping records on the server already have the right `categoryType` and correct item counts (5, 4, 4, 4, 5, 5, 5, 3, 7, 5 items). The dashboard screenshot Craig saw earlier was stale/pre-fix.

**Root cause of the 4 genuinely-missing lists (`Damage Types`, `Zone Types`, `Crew Members`, `File Attachment Types`):** their ids (`sc-damage-type`, `sc-zone-type`, `sc-crew-member`, `sc-file-attach`) are present in the server's `deletedIds` tombstone list — 3 of the 4 were deleted on 2026-06-04, and `sc-damage-type` + `sc-file-attach` on 2026-07-01T00:04, right in the middle of a 17-record deletion burst that lines up with Craig cleaning up what looked like junk "Custom (0 items)" duplicate rows on the dashboard *before* the categoryType fix existed — at that point these 4 canonical lists were visually indistinguishable from actual junk, since they were showing the same "Custom (0 items)" symptom. `applyTombstonesToClientData()` strips any incoming record matching a tombstoned id on every push — by design, so a genuine delete sticks — which is exactly what was silently blocking these 4 from ever being restored by a normal Push to Server, even though the app still has them intact.

**Fix — new tombstone-management endpoints:**
- `GET /tombstones?collection=X` — lists current tombstones, optionally filtered, so you can see exactly what's blocking a record.
- `POST /tombstones/remove` — body `{ items: [{ id, collection? }] }`, removes only the exact ids named (creates a `pre-untombstone` backup first). Deliberately id-exact only — no blanket "clear all tombstones" or "undo last N deletes", since that would reopen the resurrection bug tombstones exist to prevent.

**Verified end-to-end against Craig's real backup files:** started the server against the actual server backup, confirmed all 4 ids present in tombstones, removed them via the new endpoint, replayed the app's real backup through `/sync`, and confirmed all 14 lists (10 existing + the 4 restored) land correctly with the right `categoryType` and item counts. `node --check server.js` clean.

**Craig — one-time recovery step (do this once, after redeploying v59.18):**
```bash
curl -sk -X POST "https://192.168.1.7:8055/tombstones/remove" \
  -H "Authorization: Bearer YOUR_SYNC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"items":[
    {"id":"sc-damage-type","collection":"sweepCategories"},
    {"id":"sc-zone-type","collection":"sweepCategories"},
    {"id":"sc-crew-member","collection":"sweepCategories"},
    {"id":"sc-file-attach","collection":"sweepCategories"}
  ]}'
```
Then do a normal Push to Server from the app — the 4 lists will land back on the server with their real items, same as verified in testing above.

## v59.17 — 2026-07-01
**Files changed:** `host-server/sync-server/server.js`, `host-server/sync-server/package.json`, `host-server/docker-compose.yml`

### Second real bug found from Craig's post-redeploy screenshots: records permanently stuck on categoryType 'custom' never got re-matched

Full writeup in app `CHANGELOG.md` v59.17. Short version: `applyMigrations()`'s categoryType repair only ran on records with a *missing* categoryType — records that had already been hard-set to `'custom'` by an earlier corrupted pass (before the exact-match logic existed, or during the v59.15 crash window) were skipped forever, even when their name is an exact match for a default label. Now also re-checks and reclassifies `categoryType === 'custom'` records on exact (whitespace-normalized) name match.

**Verified:** `node --check server.js` clean. Standalone matcher test confirms exact-match 'custom' records now reclassify correctly, near-miss names still don't.



## v59.16 — 2026-07-01
**Files changed:** `host-server/sync-server/server.js`, `host-server/sync-server/package.json`, `host-server/docker-compose.yml`

### Investigated Craig's "NAME/CATEGORIES columns inverted" report — confirmed as the v59.15 crash's downstream effect, not a column bug

Full writeup in the app's `CHANGELOG.md` v59.16 entry (same root cause affects both). Short version: the dashboard table columns are correct — `sweepCategories` records are lists, so the list name belongs in NAME. The screenshot's uniform "Custom (0 items)" was v59.12.0's data, frozen before it ever got a chance to run the `categoryType` repair migration, because that migration crashed on `SW_CAT_META is not defined` during server startup (fixed in v59.15). Redeploying this build lets the startup migration finally complete and persist.

**Also fixed:** the `categoryType` name-matcher in `applyMigrations()` now collapses internal whitespace before comparing a record's name against `SW_CAT_META` labels (was exact-match only). Does not attempt fuzzy/word-subset matching — ambiguous near-miss names are intentionally left as `custom` for manual review rather than auto-guessed.

**Verified:** `node --check server.js` clean. Standalone matcher test confirms whitespace variants now resolve correctly and unrelated near-miss names are correctly left unmatched.



## v59.15 — 2026-07-01
**Files changed:** `host-server/sync-server/server.js`, `host-server/sync-server/package.json`, `host-server/docker-compose.yml`

### Fix: `SW_CAT_META is not defined` crash — server would not stay running

**Root cause:** `SW_CAT_META` was declared inside the browser-side dashboard HTML template literal (line ~3157) but referenced by `applyMigrations()` as a Node.js module-level variable. Node.js never executes code inside string template literals — to it, the dashboard HTML is just a string — so the constant did not exist when `applyMigrations()` ran at startup.

**Symptom:** Server crashed every ~10 seconds with `Uncaught: SW_CAT_META is not defined`, triggering the `uncaughtException` handler, a final-backup write, and an immediate restart — an infinite crash-restart loop.

**Fix:** Declared `SW_CAT_META` as a proper module-level `const` at the top of `server.js` (line ~70, after `APP_SCHEMA_VERSION`), before any code that references it. The identical definition inside the dashboard HTML template literal is retained unchanged — the browser still needs its own copy in client-side scope.

## v59.10 (verified + cleaned) — 2026-06-30
**Files changed:** `host-server/docker-compose.yml` (version string fix), removed `host-server/sync-server/docker-compose.yml` (stale unused duplicate), removed `host-server/sync-server/sync-server/` (stale nested duplicate folder)

### Re-verified the reported SW Categories bug fix actually works

The person reported the dashboard's SW Categories page showing "No items — use the app to add items to this list" for every list (screenshot taken on **v59.9.0** — before this v59.10 fix was deployed). Re-read `mergeCategoryItems()` and `renderSweepCategories()` line by line in the uploaded code and confirmed both fixes described in the original v59.9/v59.10 entries below are correctly present and working:

- **`mergeCategoryItems()`** now matches items by normalised `name` instead of the always-`undefined` `id` field. Wrote a standalone test (`test_merge_category_items.mjs`) replicating the exact reported scenario — empty server-side items (winner, newer `updatedAt`) + 3 real app-side items (loser) — and confirmed all 3 items now survive the merge (8/8 assertions pass, including case/whitespace-insensitive matching and winner-wins-on-conflict behaviour).
- **`renderSweepCategories()`** already renders real items as individual rows with a ✕ delete button per item once `items.length > 0` — only falls back to the "No items" message when the array is genuinely empty. The screenshot's "0 items" everywhere was a direct symptom of the (now-fixed) merge bug, not a missing UI feature.

**What the person needs to do to see this working:** deploy this server build, then do **Backup & Sync → Push to Server** from the app. The merge fix means the app's real category items (Craig, Chris, test, etc.) will now be correctly received and retained by the server instead of being silently dropped — at which point the dashboard will show them as deletable rows instead of "No items."

**One behaviour worth knowing:** deleting an item from the dashboard only removes it from the server's copy. If the app still has that item, the next sync will add it back (the confirmation dialog on delete already says this explicitly). This is correct, expected behaviour for an additive merge sync — true permanent deletion would need the app's own UI to delete the item first, then sync.

### Cleanup found during this pass
- `host-server/sync-server/sync-server/` — the same stale nested duplicate-folder pattern flagged in a previous audit had reappeared. Removed (it isn't referenced by the Docker build context, so removing it has no functional effect — purely housekeeping).
- `host-server/sync-server/docker-compose.yml` — a second, unused, fully stale copy of the compose file (stuck at `com.rsw.version=58.0.0`) sitting next to the real one. The actual Docker build context (`context: ./sync-server`, set in the parent `host-server/docker-compose.yml`) never reads this file — confirmed before deleting it.
- `host-server/docker-compose.yml` header comment was still v59.9 despite `server.js` already being v59.10 — version-bump gap, now fixed.

## v59.10.1 — 2026-06-30
**Files changed:** `host-server/sync-server/server.js`

### Removed "+ Add Item" button from SW Categories dashboard

**Problem:** The `+ Add Item` inline form added in v59.9 was not requested and was interfering with the SW Categories view. Craig's actual requirement is to *see* individual items that have synced from the app (so stale/unwanted items can be deleted), not to add items from the server.

**Fix:**
- Removed the `addForm` HTML block (hidden inline form with name/desc/colour fields)
- Removed the `+ Add Item` toggle button beneath each category list
- Removed the `addSwCatItem()` JavaScript function entirely
- The per-item **✕ delete button** on each individual item row is retained — this is the correct functionality

**Note:** Items must first be pushed from the app (Backup & Sync → Push to Server) before they appear in the dashboard. The `mergeCategoryItems` fix in v59.10 ensures items are no longer dropped on sync, so a Push should now populate the server correctly.

## v59.14 — 2026-07-01
**Files changed:** `host-server/sync-server/server.js`, `host-server/sync-server/package.json`

### Same fix as v59.13 — applied to Site & Road Inspections Categories

- **`applyMigrations()` — `categories` repair pass:** Records with a missing/empty `type` field are now matched against known default labels (`Inspection Types` → `inspection_type`, `Condition Ratings` → `condition`, `Comment Categories` → `comment_category`). Unknown names default to `custom`. Repairs existing corrupted records on disk at next server restart.
- **`mergeCategoryRecord()` extended:** The `type` field (used by `categories`) is now protected alongside `categoryType` (used by `sweepCategories`) — neither can regress to empty once a valid value has been seen on either side of the merge.

## v59.13 — 2026-07-01
**Files changed:** `host-server/sync-server/server.js`, `host-server/sync-server/package.json`

> **From this version on, this file covers server-only changes.** App-side changes are logged in the project root `CHANGELOG.md`. The matching app-side fix for this same bug is logged there as v59.13.

### Root cause of "Custom (0 items)" found — and fixed on both app and server

The real bug was in the **app's** `consolidateSweepCategories()` (`src/store.tsx`): any local category record with a missing/empty `categoryType` was silently excluded from the function's output on every load/push, so it simply stopped being included in pushes — while the server kept its own already-corrupted copy of that same id forever, with no way to be healed by a future sync. Full detail and the app-side fix are in the root `CHANGELOG.md` v59.13 entry.

**Server-side companion fixes in this version:**

1. **`mergeCategoryRecord()` hardened:** an empty/missing `categoryType` on the merge "winner" (by timestamp) can no longer overwrite a valid `categoryType` already present on the loser. `categoryType` should never regress to empty once a real value has been seen on either side.

2. **`applyMigrations()` — proactive repair pass:** before the existing husk-drop/dedupe steps, `sweepCategories` records with a missing `categoryType` are now matched against `SW_CAT_META` labels (case-insensitive) and repaired in place. This heals records that are *already* corrupted on disk, on the next server restart or sync — no need to wait for the (now-fixed) app to push a matching record again.

**Verified:** `node --check server.js` clean.

## v59.12 — 2026-06-30
**Files changed:** `host-server/sync-server/server.js`, `host-server/sync-server/package.json`

### Full rebuild: SW Categories dashboard now matches the Site & Road Inspections Categories layout

The bespoke grouped-card view for SW Categories (added pre-v59.9) has been removed entirely. SW Categories now uses the same generic table component as Site & Road Inspections → Categories, with columns:

```
ID | Name | Categories | Created-At | Updated-At | Actions
```

**Categories column:** shows the category type with its icon and label (e.g. 🌿 Debris Types), pulled from `categoryType`, plus the live item count in parentheses — independent of the merge/dedupe bugs targeted in v59.11, so this count reflects exactly what's in the data file right now.

**New Categories-type filter:** a dropdown next to the search box (SW Categories page only) lets you filter the table down to a single category type — e.g. show only "🌿 Debris Types" rows. Populated dynamically from whatever `categoryType` values exist in the data, ordered to match `SW_CAT_META`.

**Item management — "📋 Items" button:** each row's Actions column now has a dedicated Items button showing the live item count. Clicking it opens a modal listing every item in that category record, each with its own ✕ delete button (reusing the existing `deleteSwCatItem` logic from v59.10.1/v59.11 — unchanged). This replaces the old always-expanded inline item list, which was the layout Craig flagged as cluttered and conflicting with the (now-removed) Add Item form.

**Why this matters for the "no items" symptom:** this rebuild doesn't change the v59.11 sync/merge fix — it changes how the *existing* data is displayed. If items are present in the data file after a Push to Server, they will now show via the item count next to "📋 Items" and inside the modal, regardless of any rendering quirks in the old grouped view. Use `/debug/sweep-categories?token=...` (v59.11.1) to independently confirm what's actually stored, since that endpoint reads the same `items` array this new table reads.

## v59.11.1 — 2026-06-30
**Files changed:** `host-server/sync-server/server.js`, `host-server/sync-server/package.json`

### Fix: `/debug/sweep-categories` returns "Unauthorised" when opened directly in browser

**Cause:** `requireAuth` only checked the `X-Sync-Token` and `Authorization` headers. The dashboard's own JS attaches these automatically on every request, but typing a URL directly into the browser address bar sends a plain GET with no custom headers — so the diagnostic endpoint always returned 401, even with a correct token, when opened manually.

**Fix:** `requireAuth` now also accepts the token as a query parameter: `?token=YOUR_SYNC_TOKEN`. This applies to all routes using `requireAuth` (GET routes only matter in practice — POST sync calls from the app still use the header).

**Usage:**
```
https://192.168.1.7:8055/debug/sweep-categories?token=YOUR_SYNC_TOKEN
```
Replace `YOUR_SYNC_TOKEN` with the value of the `SYNC_TOKEN` environment variable (or the default printed in the server startup log if unset).

**Security note:** query-string tokens appear in browser history and server access logs. This is acceptable for a LAN-only diagnostic tool but the header-based auth path remains the default for all app sync traffic — nothing about the app's normal push/pull behaviour changed.

## v59.11 — 2026-06-30
**Files changed:** `host-server/sync-server/server.js`, `host-server/sync-server/package.json`

### Critical fix: SW Category items still not showing after sync

**Root cause — two bugs working together:**

**Bug A — Timestamp guard blocking husk removal:**
The server's migration/normalisation process sets `updatedAt` to *now* when creating bare category records (no `categoryType`, no `items`). These server-created records then had a NEWER `updatedAt` than the app's populated records (which may not have been touched since items were added days/weeks ago). `dropEmptyCategoryHusks` checked `emptyAt <= populatedAt` before dropping — but because the server husk was newer, this condition was false, and the empty husk survived.

**Bug B — Untyped empty records in a separate bucket, never matched:**
`dropEmptyCategoryHusks` groups records by `categoryType`. Server migration husks have no `categoryType` → land in the `''` bucket. The app's populated records have `categoryType` (e.g. `crew_member`) → land in the `crew_member` bucket. These are DIFFERENT buckets, so the husk was never compared against the populated app record and never dropped.

The same `categoryType` mismatch also meant `dedupeCategoryRecordsByName` used different keys for the two records (`::sweeper drivers` vs `crew_member::sweeper drivers`), so items were never merged across the type boundary.

**Fixes:**

1. **`dropEmptyCategoryHusks` — Pass 2 (new):** After the existing same-type timestamp-guarded pass, a second pass now drops any empty record with NO `categoryType` if any typed populated record shares the same name. No timestamp guard for untyped records — they are always server migration artifacts, never intentional user clears (which would carry the app's `categoryType`).

2. **`dedupeCategoryRecordsByName` — untyped fallback key (new):** When `scopeByType` is true and a record has no `categoryType`, the function now checks if any existing group already contains a record with the same name (any type) and joins that group. This rescues items from untyped husks by merging them via `mergeCategoryRecord` into the typed, populated record.

**Also added:** `GET /debug/sweep-categories` diagnostic endpoint (auth required) — returns a JSON summary of all sweepCategory records with name, categoryType, item count, and first 5 item names. Visit `https://192.168.1.7:8055/debug/sweep-categories` with your sync token to confirm items are present after the next sync.

**After deploying:** do a Push to Server from the app's Backup & Sync page. Items should now populate on the server.

## v59.10 — 2026-06-30
**Files changed:** `host-server/sync-server/server.js`, `package.json`, `host-server/sync-server/package.json`, `public/sw.js`

### Critical bug fix: SW Category items silently dropped on every sync

**Root cause — `mergeCategoryItems` matched by `item.id` which never exists:**

`SweepCategory` (and `Category`) items are plain objects `{name, color, description}` with **no `id` field**. The merge function was:
```js
const winnerIds = new Set(winner.map(i => i && i.id).filter(Boolean)); // always empty Set
const extra = loser.filter(i => i && i.id && !winnerIds.has(i.id));    // i.id always undefined → always []
return [...winner, ...extra];                                            // always just winner's items
```

Because `winnerIds` was always an empty Set and the `extra` filter required `i.id` (always `undefined`), **every loser's items were unconditionally dropped**. The server's sweepCategory records (winner, due to newer `updatedAt` from migrations/normalisation) always had empty `items: []`. The app's records with real items (Craig, Chris, test) were always the loser and always dropped. Result: every sync wiped all category items from the server, and on pull the app got empty items back too.

**Fix:** Changed `mergeCategoryItems` to match by normalised item **name** (lowercased, trimmed) instead of `id`:
```js
const winnerNames = new Set(winner.map(i => i?.name?.trim().toLowerCase()).filter(Boolean));
const extra = loser.filter(i => i?.name && !winnerNames.has(i.name.trim().toLowerCase()));
return [...winner, ...extra];
```

**Verified with test:**
- Empty server + app with 3 items → merged result has all 3 items ✓
- Server has 1, app has 2 (1 shared) → merged has 2, no duplicate ✓
- Both sides have same name → winner's version kept, no duplicate ✓

**After deploying this fix:** do a Push to Server from the app's Backup & Sync. The server will now correctly receive and retain all category items. The `+ Add Item` / `✕` per-item buttons added in v59.9 remain as a direct management option.

## v59.9 — 2026-06-30
**Files changed:** `host-server/sync-server/server.js`, `CLAUDE_CONTEXT.md`, `public/sw.js`, `package.json`, `host-server/sync-server/package.json`

### Host-server: SW Categories per-item management

**Problem:** The dashboard's SW Categories view rendered items as read-only coloured pills. There was no way to delete or add individual items within a list from the host-server — the only action was 🗑 which deleted the entire list record. Users with stale/empty category records on the server couldn't remove specific items like individual sweeper drivers.

**Fix — `renderSweepCategories()` rewritten:**
- Items now render as **rows** inside each list, each with a ✕ delete button
- Clicking ✕ calls `deleteSwCatItem(catId, itemIdx)` — fetches the record, removes the item by index, PUTs the updated record back via `/data/sweepCategories/:id`
- Each list also shows a **"+ Add Item"** button that expands an inline form (name, description, colour picker) — calls `addSwCatItem(catId, formId)` to add items directly from the dashboard
- Duplicate detection on add (case-insensitive)
- Full guard: confirms before delete, shows toast on success/error, reloads collection after change
- The whole-list delete button is still present (labelled "🗑 List" to distinguish it from per-item ✕)

**Note on data discrepancy:** If the host-server shows "No items" for a list that has items in the app, the app data has not been pushed to the server yet. Use Backup & Sync → Push to Server to update. The new per-item UI lets you also manage items directly on the server without needing the app.

### Added CLAUDE_CONTEXT.md
Project was missing its context file. Created with: version table, architecture diagram, component map, data model, sync rules, packaging checklist, version bump checklist (including `sw.js` CACHE_NAME — previously missed in bump script), known orphaned functions, server dashboard notes, Firefox/offline notes, recent history.

## v59.8 — 2026-06-29
**Files changed:** `src/App.tsx`, `src/index.css`, `public/sw.js`, `Dockerfile`, `docker-compose.yml`, `host-server/docker-compose.yml`, `host-server/sync-server/server.js`, `package.json`, `host-server/sync-server/package.json`

### Audit scope: mobile field use, offline reliability, Firefox

Reviewed the full offline stack end to end: `sw.js` caching strategy, the IndexedDB/localStorage persistence layer in `store.tsx`, the HTTPS/nginx/CSP setup required for camera and GPS on phones, geolocation/file-input call sites across all components, and the render-error recovery path. Most of this audited clean — the existing IndexedDB fallback chain, image compression, and feature-detected browser APIs (`navigator.share`, `navigator.geolocation`, `navigator.storage.persist`) are already solid and already Firefox-aware. Two real, fixable issues found:

**1. A render crash in any ONE page took down the entire app (critical for field use)**
There was only a single, app-wide `ErrorBoundary` wrapping everything — sidebar, header, and page content together. If any single page threw a render error (e.g. a malformed sweep job), the *entire* app — including the sidebar needed to navigate away — disappeared behind a generic error screen, with no recovery except a full reload. On a phone in the field with no dev tools, this is a hard stop. **Fixed:** `ErrorBoundary` now supports a `compact` mode; the page content area (`<main>`) is wrapped in its own instance, keyed on the current page so it auto-resets on navigation. A crash in one feature now only blanks that page's content — the sidebar, header, and ability to navigate to a different page stay fully usable. Verified with a standalone React render test confirming the sidebar renders even while the page-area boundary is showing its error state.

**2. Modals could be cut off / jump on mobile Firefox & Chrome (minor)**
`.modal-content` used `max-h-[90vh]`. `vh` is based on the *largest possible* viewport on mobile, not the actual visible area once the browser's address bar/toolbar is accounted for — so a modal could sit partly behind the toolbar, or visibly jump as the bar shows/hides while scrolling or typing. Added a `dvh` (dynamic viewport height) override via `@supports`, which tracks the real visible viewport; older browsers keep the existing `vh` fallback automatically.

### Investigated, found solid (no change needed)
- IndexedDB persistence with localStorage fallback and `storage-error` UI banner — already has a complete degrade path.
- `navigator.storage.persist()` — already correctly notes Firefox auto-grants persistence (Chrome doesn't, by design).
- Camera/file input handling — every call site already uses `?.[0]` optional chaining; no unguarded access found.
- Geolocation call sites — all wrapped in try/catch with user-facing error messages; one inconsistency in `Inspections.tsx` (missing an early "not available" check that other call sites have) was found but doesn't crash — already caught and surfaced as an error message either way.
- Service worker strategy (network-first navigation with cache fallback, cache-first icons, stale-while-revalidate JS/CSS) — sound; correctly skips intercepting map tile/CDN hosts.
- File-input/camera paths, nginx HTTPS + self-signed cert (required for GPS/camera on mobile), CSP `worker-src 'self' blob:` (required for SW registration) — all correctly configured.

### Known platform limitation (not fixable in this codebase)
**"Firefox" on iPhone/iPad is not Firefox's engine.** Apple requires every iOS browser to run on WebKit (Safari's engine) — so Firefox on iOS inherits Safari's storage/offline behavior, including its more aggressive eviction of Service Worker caches and IndexedDB after periods of inactivity. This only applies on iOS; Firefox for Android uses its own Gecko engine and behaves per the audited code above. If field devices are iPhones/iPads, opening the app at least every few days (not weeks) is the practical mitigation — there's no code-level fix for an iOS platform policy.

### Stale version-string cleanup (found during version bump)
`com.rsw.version=59.4` had been stuck in both `docker-compose.yml` files since at least v59.5 — a gap in the version-bump script that only matched the `v59.X` comment pattern, not this separate label format. `host-server/docker-compose.yml` was also a full version behind (v59.6). `Dockerfile`'s labels were stuck at v57.9. All four now correctly read v59.8, and the version-bump step has been corrected to catch the `com.rsw.version=` pattern going forward.

## v59.7 — 2026-06-29
**Files changed:** `src/store.tsx`, `src/components/sweep/SweepJobs.tsx`

### Bug fixes from full codebase audit

**1. Create Road button — modal never switched to edit mode (critical)**
`addSweepRoad` returned `void`; `saveRoad` created the road but discarded the result, leaving `editingRoad = null`. Every subsequent "Create Road" click created a duplicate road; any segments drawn after the first save were lost to a second road. Fixed: `addSweepRoad` now returns the created `SweepRoad`; `saveRoad` calls `setEditingRoad(created)` immediately so the modal switches to "Edit Road / Save Changes" mode and further saves update the same road.

**2. Road Name validation — silent failure**
Empty name caused `saveRoad` to silently return with zero feedback. Fixed: shows a red border + inline error message "⚠️ Road name is required before saving." Error clears as soon as the user starts typing.

**3. `deleteSweepArea` missing cascade to sweep jobs (data integrity)**
Deleting an area removed the area record and its roads but left orphaned `SweepJobRoad` entries (with dead `roadId`s) inside every sweep job that referenced those roads. Jobs showed "Unknown Road" entries that couldn't be removed. Fixed: cascade now strips orphaned road entries and the matching `areaId` from every affected sweep job.

**4. `weatherLabel` / `debrisLabel` — permanently broken lookup maps (dead code)**
Both functions mapped old hardcoded short-keys (`clear`, `light_rain`, `light`, `heavy`) but weather/debris values are stored as category item names (`☀️ Clear`, `🟢 Light`). The lookup always missed; the fallback `|| w` silently passed the raw value through, making the mapping do nothing. Removed the dead lookup tables — functions now return the stored value directly (which is already the display name).

**5. Audit findings — orphaned store functions (no fix needed, zero impact)**
`addSweepMap`, `updateSweepMap`, `deleteSweepMap`, `addSweepReport`, `updateSweepReport`, `deleteSweepReport`, `updateSweepFile` — all defined and exported but never called. `SweepMaps` and `SweepReports` are read-only auto-generated views; file editing UI doesn't exist. Left as-is for future use.
