#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  RSW Field App v15 — Stop Script
# ─────────────────────────────────────────────────────────────
set -e

CYAN='\033[0;36m'; GREEN='\033[0;32m'; NC='\033[0m'

echo -e "${CYAN}"
echo "╔══════════════════════════════════════════════════╗"
echo "║         RSW Field App v15 — Stopping            ║"
echo "╚══════════════════════════════════════════════════╝"
echo -e "${NC}"

if ! command -v docker &>/dev/null; then
  echo "Docker not found. Nothing to stop."
  exit 0
fi

docker compose down
echo -e "${GREEN}✅ RSW Field App stopped.${NC}"
echo ""
echo "  Start again:  ./start.sh"
echo ""
