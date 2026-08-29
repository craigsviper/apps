#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  RSW Field App v40.6 — Start Script
# ─────────────────────────────────────────────────────────────
set -e

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

echo -e "${CYAN}"
echo "╔══════════════════════════════════════════════════╗"
echo "║         RSW Field App v40.6 — Starting            ║"
echo "╚══════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Check Docker is available ──────────────────────────────
if ! command -v docker &>/dev/null; then
  echo -e "${YELLOW}⚠  Docker not found. Run install-linux-mint.sh first.${NC}"
  exit 1
fi

# ── Build if needed, then start ───────────────────────────
echo -e "${CYAN}▶ Starting RSW Field App...${NC}"
docker compose up -d --build

# ── Wait for health check ─────────────────────────────────
echo -e "${CYAN}⏳ Waiting for app to be ready...${NC}"
sleep 5

for i in {1..12}; do
  if docker compose ps | grep -q "healthy"; then
    break
  fi
  sleep 3
done

# ── Show access info ──────────────────────────────────────
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')

echo ""
echo -e "${GREEN}✅ RSW Field App is running!${NC}"
echo ""
echo "  📱 On this computer:  https://localhost:8050"
if [ -n "$LOCAL_IP" ]; then
  echo "  📱 On phones/tablets: https://${LOCAL_IP}:8050"
fi
echo ""
echo -e "${YELLOW}⚠  Browser will show a security warning — click 'Advanced' → 'Proceed' (safe to do)${NC}"
echo ""
echo "  View logs:  docker compose logs -f"
echo "  Stop app:   ./stop.sh"
echo ""
