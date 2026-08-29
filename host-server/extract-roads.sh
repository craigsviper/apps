#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# RSW Field App — Road Select data extract generator
#
# Lives in host-server/ (moved here from the project root in v73.18) since
# every other step of this process — docker compose, docker cp, the reload
# curl — already happens from inside this folder; having this one script sit
# up at the project root was just an extra cd for no reason.
#
# Produces roads.geojson: the road-network file used by the "Select Roads"
# mode in Areas & Roads → Edit Road. Run this ONCE (re-run only if you want to
# refresh/expand coverage) on ANY machine that has internet + osmium — it does
# NOT need to be your host-server. Copy the resulting roads.geojson onto the
# host-server afterwards (see final step below).
#
# Requires: osmium-tool, wget (or curl)
#   Ubuntu/Debian: sudo apt install osmium-tool
#   macOS (brew):  brew install osmium-tool
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── 1. EDIT THIS — your operating area bounding box ──────────────────────────
# Format: min_longitude,min_latitude,max_longitude,max_latitude
# The example below covers Hamilton + a margin of surrounding Waikato roads.
# Keep it as tight as you can — a smaller box = smaller/faster roads.geojson.
# Find your own bbox easily at: https://boundingbox.klokantech.com/ (draw a
# box over your operating area, copy the "CSV" values in minX,minY,maxX,maxY
# order — that's exactly this format).
BBOX="175.15,-37.85,175.35,-37.70"

# ── 2. EDIT THIS — which NZ region extract to download from Geofabrik ───────
# "new-zealand-latest" covers the whole country (~250MB download) and works
# for any BBOX above. Leave as-is unless you specifically want a smaller
# regional extract from https://download.geofabrik.de/australia-oceania.html
REGION_URL="https://download.geofabrik.de/australia-oceania/new-zealand-latest.osm.pbf"

# ── 3. Output — do not edit ──────────────────────────────────────────────────
WORK_DIR="$(pwd)/rsw-road-extract"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

echo "→ Working in $WORK_DIR"
echo "→ Bounding box: $BBOX"

# Download the country/region extract (skipped if already present)
PBF_FILE="$(basename "$REGION_URL")"
if [ ! -f "$PBF_FILE" ]; then
  echo "→ Downloading $REGION_URL ..."
  wget -c "$REGION_URL" -O "$PBF_FILE"
else
  echo "→ Found existing $PBF_FILE, skipping download (delete it to force a re-download)"
fi

# Filter to real, drivable road ways FIRST — before the spatial clip, not
# after. This order matters for two separate reasons:
#
# 1. MEMORY: clipping a wide bounding box straight out of the full ~380MB+
#    country file can get OOM-killed (`osmium extract` builds a spatial index
#    over EVERYTHING in the file — buildings, land use, footpaths, the lot —
#    which is the expensive part). Filtering down to just road ways first is
#    a cheap streaming pass that shrinks the file a lot before the clip ever
#    has to run, avoiding that crash. (Real incident: this exact ordering was
#    right once already, then regressed back to clip-first in a later
#    session — restored here.)
# 2. CORRECTNESS: a blanket `w/highway` filter also pulls in footpaths,
#    cycleways, pedestrian crossings, tracks, and driveways, none of which a
#    sweeper truck drives. This whitelist matches the app's own server-side
#    filter in server.js's isSweepableRoadFeature() — keep the two in sync if
#    you ever change one. highway=service is included (short council-
#    maintained access roads are sometimes legitimately swept) but
#    service=driveway/parking_aisle/parking/alley and access=private/no/
#    customers ways are NOT filtered out at this step — osmium tags-filter
#    can't cleanly express that combination in one reliable pass across
#    osmium versions. That exclusion is instead enforced authoritatively,
#    and guaranteed regardless of exactly what this script lets through, by
#    server.js's isSweepableRoadFeature() at load time — so anything that
#    slips through this script is still correctly dropped before the app
#    ever sees it.
echo "→ Filtering to real road ways first (keeps memory use down for the clip, and excludes footpaths/cycleways/crossings/tracks)..."
osmium tags-filter "$PBF_FILE" \
  w/highway=motorway,motorway_link,trunk,trunk_link,primary,primary_link,secondary,secondary_link,tertiary,tertiary_link,unclassified,residential,living_street,service \
  -o country-roads-only.osm.pbf --overwrite

# NOW clip to your operating area — working from the much smaller
# roads-only file instead of the full country file.
echo "→ Clipping to bounding box..."
osmium extract -b "$BBOX" country-roads-only.osm.pbf -o roads-only.osm.pbf --overwrite

# Convert to GeoJSON — this is the file the app actually reads.
echo "→ Exporting to GeoJSON..."
osmium export roads-only.osm.pbf -o roads.geojson --overwrite \
  --geometry-types=linestring \
  -c /dev/null 2>/dev/null || osmium export roads-only.osm.pbf -o roads.geojson --overwrite --geometry-types=linestring

echo ""
echo "✅ Done: $WORK_DIR/roads.geojson"
ls -lh roads.geojson
echo ""
echo "─────────────────────────────────────────────────────────────────────────"
echo "NEXT STEP — load roads.geojson into your host-server:"
echo ""
echo "  EASIEST — from inside host-server/ on the host-server machine:"
echo "    ./restore-road-data.sh $WORK_DIR/roads.geojson"
echo "  (copies it in AND reloads it, one step — see road-data-setup/README.md"
echo "  if this script isn't there yet or you want the full walkthrough)"
echo ""
echo "  MANUAL, if you'd rather do it yourself or ran this on a different"
echo "  machine than the host-server:"
echo "  1. Copy the file to the Docker host machine (skip if already there):"
echo "       scp $WORK_DIR/roads.geojson  <user>@<host-server-ip>:~/roads.geojson"
echo "  2. Copy it into the running container's /data volume:"
echo "       docker cp roads.geojson rsw-sync:/data/roads.geojson"
echo "  3. Reload it without a restart (or just restart the container):"
echo "       curl -X POST https://localhost:8055/api/roads/reload -H \"X-Sync-Token: \$SYNC_TOKEN\" -k"
echo "     — or —"
echo "       docker compose restart rsw-sync"
echo ""
echo "To refresh/expand coverage later, just re-run this script (from"
echo "host-server/) and repeat the load step above."
echo "─────────────────────────────────────────────────────────────────────────"
