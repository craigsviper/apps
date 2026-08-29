# OSRM Setup Guide — "Snap to Roads" (v73.69+)

This is a **one-time, optional** step, same as `road-data-setup/README.md`.
Everything else in the app — Draw Points, Select Roads/Lasso, Simplify Points,
Find Long Jumps, Find Duplicate Lines — works completely fine without ever
doing this.

**What this actually is:** Areas & Roads → Edit Road has a "🛰️ Snap to Roads"
button that sends a segment's points to a real road-matching engine (OSRM)
and gets back the same route corrected onto actual OSM road geometry —
instead of the app just cleaning up your own drawn points with heuristics
(Simplify/Long Jumps/Duplicates), which is what those three tools have always
done and still do. This guide gets that engine running.

**Why is this a separate thing from `road-data-setup`?** `road-data-setup`
gives the app a road *reference map* to click/lasso from. This gives the app
a road *matching engine* to snap already-drawn points onto. Different tools,
different data, both derived from OpenStreetMap but built differently —
that's also why this has its own setup script instead of reusing
`extract-roads.sh`.

---

## Requirements

- Docker (already required for the rest of this project)
- Real internet access on the host-server machine — this downloads a ~380MB
  OSM extract for the whole of New Zealand
- A few GB of free disk space (extract + processed graph files) and roughly
  1-2GB of free RAM for the `osrm` container to run
- ~15-20 minutes for the one-time graph build (mostly unattended)

## Step 1 — Build the road graph (one-time)

```bash
cd ~/rsw-inspection-test/host-server
chmod +x setup-osrm.sh
./setup-osrm.sh
```

This downloads the NZ extract from Geofabrik, then runs OSRM's own three-step
graph build (`osrm-extract` → `osrm-partition` → `osrm-customize`) inside
temporary Docker containers. You'll see a lot of scrolling log output — that's
normal. It finishes with:

```
✅ Done: .../osrm-data/new-zealand-latest.osrm (+ companion files)
```

If it stops partway through with a Docker error, the most common cause is not
enough free disk space or RAM — check `df -h` and `free -h`.

## Step 2 — Confirm your `.env` has the two OSRM lines

Open `host-server/.env` and check these exist (add them if not — they were
auto-added if you're upgrading via a delivered zip that already had them):

```
OSRM_URL=http://osrm:5000
OSRM_PORT=5000
```

You don't need to change these unless you're running OSRM somewhere other
than this same `docker compose` stack.

## Step 3 — Start it

```bash
cd ~/rsw-inspection-test/host-server
docker compose up -d
docker compose ps
```

Wait ~15-30 seconds, then check again — `rsw-osrm` should show **healthy**.

## Step 4 — Verify it's actually routing

```bash
curl 'http://localhost:5000/route/v1/driving/175.2793,-37.7870;175.2800,-37.7880'
```

A working response looks like `{"code":"Ok","routes":[...`. If you get
`Connection refused`, the container isn't up — check
`docker compose logs osrm`. If curl itself isn't found, use a browser and
visit the same URL instead.

## Step 5 — Try it in the app

Open Areas & Roads → Edit Road on a real segment, click **🛰️ Snap to Roads**,
confirm the dialog. You should see a "Snapped: X → Y points" message and the
route should now follow real road curves. If anything looks wrong,
**↩ Undo Bulk** restores the pre-snap version in one click.

---

## Refreshing the road data later

New roads get built, existing ones change shape — when you want the graph to
reflect that:

```bash
cd ~/rsw-inspection-test/host-server
./setup-osrm.sh
docker compose restart osrm
```

Safe to re-run any time; each step overwrites its own output.

## Troubleshooting

**`rsw-osrm` stuck on "unhealthy"** — as of v73.70 the healthcheck is a plain
TCP check (`bash -c '</dev/tcp/localhost/5000'`), which should work reliably.
If you're still on an older `docker-compose.yml` with a `wget`-based
healthcheck, that will never pass — the `osrm-backend` image doesn't include
`wget`. Update to the current `docker-compose.yml` and `docker compose up -d`
again.

**Snap to Roads fails with a network/connection error in the app** —
confirm `rsw-sync` can actually reach `osrm` on the internal Docker network:
```bash
docker exec rsw-sync wget -qO- http://osrm:5000/route/v1/driving/175.28,-37.79;175.29,-37.80
```
If that fails but the host-machine `curl` in Step 4 worked, it's a Docker
networking issue between the two containers, not OSRM itself — check both
services are on the same compose network (`docker compose ps` should list
both under the same project).

**The whole thing feels too heavy for my hardware** — `setup-osrm.sh`
defaults to the whole-country NZ extract. Edit the `REGION_URL` line near the
top of the script to point at a smaller Geofabrik regional extract (e.g. just
the North Island) if you want a smaller graph and lower RAM use — OSRM's own
bbox handling at query time keeps things fast regardless of how much of the
country the graph covers, so this is purely a resource-usage tradeoff, not a
functionality one.

**A big point-count jump after snapping (e.g. 1200 → 4000+ points) froze the
browser** — fixed in v73.70 (server-side point pruning + a marker-density cap
in the editor). If you're seeing this on an older version, update the app.

**App image rebuilds taking 20-40+ minutes, build log shows "transferring
context: 1+ GB"** — fixed in v73.76. Before that fix, `.dockerignore` didn't
exclude `host-server/`, so this folder's `osrm-data/` (the graph
`setup-osrm.sh` builds — typically 1-1.5GB) was being bundled into the APP
image's Docker build context on every single `docker compose build`, even
though the frontend never touches it. If you're still seeing this, check
`.dockerignore` at the project root includes a `host-server` line. Also skip
`--no-cache` for a normal code update (only needed after a `package.json`
dependency change) — it throws away Docker's layer cache and reruns
`npm install`/`npm run build` from scratch every time, which compounds the
same slowdown.
