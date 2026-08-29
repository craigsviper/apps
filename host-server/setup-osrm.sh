#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# RSW Field App — OSRM road-matching service setup (v73.69)
#
# Builds the routing graph OSRM needs to serve /match (snap a whole hand-drawn
# trace to real roads) and /route (point-to-point, replaces the old local
# Dijkstra /api/roads/connect). Run this ONCE on the host-server machine (it
# needs internet access to Geofabrik and Docker installed) — re-run only when
# you want to refresh the road data (new roads built, etc).
#
# This does NOT need osmium — unlike extract-roads.sh, the filtering here is
# OSRM's own "car" driving profile, not a hand-picked highway=* whitelist, so
# it downloads and processes the raw extract directly.
#
# Requires: docker, wget (or curl)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── 1. EDIT THIS if your operating area isn't the Waikato/Hamilton default ───
# Same convention as extract-roads.sh's REGION_URL — "new-zealand-latest"
# covers the whole country and is the simplest choice even if you only
# operate in one region; OSRM's own bbox handling at match-time keeps queries
# fast regardless of how much of the country the graph covers.
REGION_URL="https://download.geofabrik.de/australia-oceania/new-zealand-latest.osm.pbf"

# ── 2. Output — do not edit ──────────────────────────────────────────────────
WORK_DIR="$(pwd)/osrm-data"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

PBF_FILE="$(basename "$REGION_URL")"
OSRM_BASE="${PBF_FILE%.osm.pbf}.osrm"

echo "→ Working in $WORK_DIR"

if [ ! -f "$PBF_FILE" ]; then
  echo "→ Downloading $REGION_URL ..."
  wget -c "$REGION_URL" -O "$PBF_FILE"
else
  echo "→ Found existing $PBF_FILE, skipping download (delete it to force a re-download)"
fi

# The three-stage OSRM graph build (MLD pipeline — the one osrm-routed
# expects to serve with --algorithm mld). Each stage is its own container run
# against the osrm-backend image so this script needs nothing installed
# locally except Docker itself. Re-running is safe/idempotent — each step
# overwrites its own output files.
echo "→ Extracting (car profile)..."
docker run --rm -t -v "$WORK_DIR:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-extract -p /opt/car.lua "/data/$PBF_FILE"

echo "→ Partitioning..."
docker run --rm -t -v "$WORK_DIR:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-partition "/data/$OSRM_BASE"

echo "→ Customizing..."
docker run --rm -t -v "$WORK_DIR:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-customize "/data/$OSRM_BASE"

echo ""
echo "✅ Done: $WORK_DIR/$OSRM_BASE (+ companion files)"
echo ""
echo "─────────────────────────────────────────────────────────────────────────"
echo "NEXT STEP — start the OSRM service:"
echo ""
echo "  From host-server/:"
echo "    docker compose up -d osrm"
echo ""
echo "  Check it's serving:"
echo "    curl 'http://localhost:5000/route/v1/driving/175.2793,-37.7870;175.2800,-37.7880'"
echo ""
echo "To refresh road data later (new roads built, etc), just re-run this"
echo "script then: docker compose restart osrm"
echo "─────────────────────────────────────────────────────────────────────────"
