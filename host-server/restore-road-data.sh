#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  RSW Field App v73.55 — Road Data Restore/Reload             ║
# ║  Loads a roads.geojson file into the running host-server     ║
# ║  Usage: ./restore-road-data.sh /path/to/roads.geojson        ║
# ╚══════════════════════════════════════════════════════════════╝
#
# Documented in road-data-setup/README.md and referenced by
# extract-roads.sh's own printed next-steps, but never actually
# existed in the repo until now (v73.55) — this was a real gap:
# both docs told Craig to run a script that didn't exist, and the
# only way to load a refreshed roads.geojson was the manual
# docker cp + curl sequence.
#
# What this does, in one step:
#   1. Copies the given roads.geojson into the running rsw-sync
#      container's /data volume (docker cp)
#   2. Calls POST /api/roads/reload so the server picks it up
#      immediately — no container restart needed
#   3. Reports the result (feature count / any error) so you know
#      it actually worked, not just that the commands ran

set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✔  $*${NC}"; }
fail() { echo -e "${RED}  ✖  $*${NC}"; }
info() { echo -e "${CYAN}  ℹ  $*${NC}"; }

SYNC_PORT=8055
CONTAINER_NAME="rsw-sync"
HOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 1. Validate the input file ────────────────────────────────────
if [ $# -lt 1 ]; then
  fail "Usage: ./restore-road-data.sh /path/to/roads.geojson"
  exit 1
fi
SRC_FILE="$1"
if [ ! -f "$SRC_FILE" ]; then
  fail "File not found: $SRC_FILE"
  exit 1
fi
# Cheap sanity check — a real roads.geojson is a GeoJSON FeatureCollection.
# Not a full schema validation (that's the server's job on load), just
# enough to catch "wrong file" before copying it into the container.
if command -v python3 &>/dev/null; then
  if ! python3 -c "
import json, sys
try:
    d = json.load(open('$SRC_FILE'))
except Exception as e:
    print(f'Not valid JSON: {e}'); sys.exit(1)
if d.get('type') != 'FeatureCollection' or not isinstance(d.get('features'), list):
    print('Not a GeoJSON FeatureCollection — is this the right file?'); sys.exit(1)
" >/tmp/rsw-road-check-err 2>&1; then
    fail "$(cat /tmp/rsw-road-check-err)"
    rm -f /tmp/rsw-road-check-err
    exit 1
  fi
  rm -f /tmp/rsw-road-check-err
fi
FILE_SIZE=$(du -h "$SRC_FILE" | cut -f1)
info "Source file: $SRC_FILE ($FILE_SIZE)"

# ── 2. Check the container is actually running ────────────────────
if ! docker inspect --format='{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null | grep -q running; then
  fail "$CONTAINER_NAME container is not running"
  echo "     Fix: cd $HOST_DIR && docker compose up -d --build"
  exit 1
fi
ok "$CONTAINER_NAME container is running"

# ── 3. Copy the file in ────────────────────────────────────────────
info "Copying roads.geojson into $CONTAINER_NAME:/data/roads.geojson ..."
docker cp "$SRC_FILE" "$CONTAINER_NAME:/data/roads.geojson"
ok "File copied"

# ── 4. Read the sync token from .env for the reload call ──────────
SYNC_TOKEN=""
if [ -f "$HOST_DIR/.env" ]; then
  SYNC_TOKEN=$(grep -E '^SYNC_TOKEN=' "$HOST_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d '[:space:]')
fi
if [ -z "$SYNC_TOKEN" ]; then
  fail "Could not read SYNC_TOKEN from $HOST_DIR/.env"
  echo "     File was copied in, but you'll need to reload it manually:"
  echo "       curl -X POST https://localhost:${SYNC_PORT}/api/roads/reload -H \"X-Sync-Token: <your token>\" -k"
  exit 1
fi

# ── 5. Trigger the live reload — no restart needed ─────────────────
info "Reloading road data (no container restart needed)..."
RESPONSE=$(curl -sk -X POST "https://localhost:${SYNC_PORT}/api/roads/reload" -H "X-Sync-Token: $SYNC_TOKEN")

if echo "$RESPONSE" | grep -q '"ok":true'; then
  FEATURE_COUNT=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('featureCount', '?'))" 2>/dev/null || echo "?")
  ok "Reloaded successfully — $FEATURE_COUNT road features loaded"
  echo ""
  echo "Next: open the app → Areas & Roads → Edit Road → Select Roads, and pan"
  echo "around your operating area to confirm the roads actually show up."
else
  fail "Reload call did not report success"
  echo "     Server response: $RESPONSE"
  echo "     Check the container logs: docker logs $CONTAINER_NAME --tail=30"
  exit 1
fi
