#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  RSW Field App v15 — Host Sync Server Diagnostic                     ║
# ║  Run if the sync server won't start or devices can't connect║
# ║  Usage: chmod +x diagnose-host.sh && ./diagnose-host.sh     ║
# ╚══════════════════════════════════════════════════════════════╝

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✔  $*${NC}"; }
fail() { echo -e "${RED}  ✖  $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠  $*${NC}"; }
info() { echo -e "${CYAN}  ℹ  $*${NC}"; }
head() { echo -e "\n${BOLD}$*${NC}"; }

SYNC_PORT=8055
SYNC_HTTP_PORT=8056
HOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo -e "${BOLD}╔═══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   RSW Host Sync Server — Diagnostic Report    ║${NC}"
echo -e "${BOLD}╚═══════════════════════════════════════════════╝${NC}"
echo ""

# ── 1. Docker ────────────────────────────────────────────────────
head "1. Docker"
if command -v docker &>/dev/null; then
  ok "Docker installed: $(docker --version 2>/dev/null | cut -d' ' -f3 | tr -d ',')"
else
  fail "Docker NOT installed"
  echo "     Fix: bash install-host.sh → choose option 1"
fi

if docker compose version &>/dev/null 2>&1; then
  ok "Docker Compose: $(docker compose version --short 2>/dev/null)"
else
  fail "docker compose plugin missing"
  echo "     Fix: sudo apt-get install docker-compose-plugin"
fi

if docker info &>/dev/null 2>&1 || sudo docker info &>/dev/null 2>&1; then
  ok "Docker daemon running"
else
  fail "Docker daemon NOT running"
  echo "     Fix: sudo systemctl start docker"
fi

# ── 2. Container ─────────────────────────────────────────────────
head "2. Sync Server Container"
cd "$HOST_DIR" 2>/dev/null

SYNC_STATE=$(docker inspect --format='{{.State.Status}}' rsw-sync 2>/dev/null || echo "not found")

if [ "$SYNC_STATE" = "running" ]; then
  ok "rsw-sync: running"
elif [ "$SYNC_STATE" = "not found" ]; then
  fail "rsw-sync: container not found"
  echo "     Fix: cd $HOST_DIR && docker compose up -d --build"
else
  fail "rsw-sync: $SYNC_STATE"
  echo "     Fix: docker compose up -d --build"
fi

# Also check systemd service
if systemctl list-units --full -all 2>/dev/null | grep -q rsw-sync; then
  SVC_STATUS=$(systemctl is-active rsw-sync 2>/dev/null || echo "unknown")
  if [ "$SVC_STATUS" = "active" ]; then
    ok "systemd rsw-sync service: active"
  else
    fail "systemd rsw-sync service: $SVC_STATUS"
    echo "     Fix: sudo systemctl start rsw-sync"
  fi
fi

# ── 3. Port ──────────────────────────────────────────────────────
head "3. Port ${SYNC_PORT} (HTTPS)"
# Use -k to accept the self-signed cert; we're just checking the server responds.
if curl -sfk --max-time 5 "https://localhost:${SYNC_PORT}/health" > /dev/null 2>&1; then
  ok "Port ${SYNC_PORT} responding (HTTPS) ✔"
  info "Health response:"
  curl -sk "https://localhost:${SYNC_PORT}/health" | python3 -m json.tool 2>/dev/null || \
  curl -sk "https://localhost:${SYNC_PORT}/health"
elif curl -sf --max-time 5 "http://localhost:${SYNC_HTTP_PORT}/health" > /dev/null 2>&1; then
  warn "HTTPS port ${SYNC_PORT} not responding, but HTTP helper port ${SYNC_HTTP_PORT} is up."
  info "HTTP helper response (use HTTPS URL in app):"
  curl -s "http://localhost:${SYNC_HTTP_PORT}/health" | python3 -m json.tool 2>/dev/null || true
else
  fail "Port ${SYNC_PORT} NOT responding"
  BLOCKER=$(sudo ss -tlnp 2>/dev/null | grep ":${SYNC_PORT}" || true)
  if [ -z "$BLOCKER" ]; then
    warn "Nothing is listening on port ${SYNC_PORT}"
    echo "     The sync server is not running."
  else
    warn "Something is using port ${SYNC_PORT}: $BLOCKER"
  fi
  echo "     Fix: cd $HOST_DIR && docker compose up -d --build"
fi

# ── 4. Configuration ─────────────────────────────────────────────
head "4. Configuration"
if [ -f "$HOST_DIR/.env" ]; then
  ok ".env file exists"
  TOKEN=$(grep SYNC_TOKEN "$HOST_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d ' ')
  if [ "$TOKEN" = "rsw-sync-token-change-me" ]; then
    warn "Using default sync token — change it in .env!"
  else
    ok "Custom sync token set (${#TOKEN} chars)"
  fi
else
  fail ".env file missing"
  echo "     Fix: bash install-host.sh"
fi

# ── 5. Files ─────────────────────────────────────────────────────
head "5. Required Files"
for f in "docker-compose.yml" "sync-server/server.js" "sync-server/package.json" "sync-server/Dockerfile"; do
  if [ -f "$HOST_DIR/$f" ]; then
    ok "$f"
  else
    fail "$f — MISSING"
  fi
done

# ── 6. Firewall ──────────────────────────────────────────────────
head "6. Firewall"
if command -v ufw &>/dev/null; then
  UFW_STATUS=$(sudo ufw status 2>/dev/null | head -1)
  if echo "$UFW_STATUS" | grep -q "inactive"; then
    ok "UFW firewall is inactive (ports are open)"
  else
    PORT_RULE=$(sudo ufw status 2>/dev/null | grep "$SYNC_PORT" || true)
    if [ -n "$PORT_RULE" ]; then
      ok "UFW: port $SYNC_PORT is allowed"
    else
      warn "UFW active but port $SYNC_PORT may not be allowed"
      echo "     Fix: sudo ufw allow ${SYNC_PORT}/tcp"
    fi
  fi
else
  info "UFW not installed — skipping firewall check"
fi

# ── 7. Network ───────────────────────────────────────────────────
head "7. Network — IP Addresses"
echo ""
echo -e "${CYAN}  The sync server runs HTTPS on port ${SYNC_PORT}.${NC}"
echo -e "${CYAN}  Share one of these sync URLs with field computers:${NC}"
hostname -I | tr ' ' '\n' | grep -v '^$' | while read ip; do
  echo "  Sync URL:      https://${ip}:${SYNC_PORT}"
done
echo ""
echo -e "${YELLOW}  ⚠  First-time browser setup — each browser must trust the self-signed cert:${NC}"
hostname -I | tr ' ' '\n' | grep -v '^$' | while read ip; do
  echo "  Cert download: https://${ip}:${SYNC_PORT}/cert"
done
echo ""
echo -e "${CYAN}  Steps per browser / device:${NC}"
echo "    Firefox: open the /cert URL → Advanced → Accept Risk → download .pem"
echo "             then: Settings → Privacy → Certificates → Import → select the .pem"
echo "    Chrome:  open the /cert URL → Advanced → Proceed (unsafe) → download .pem"
echo "             then: Settings → Privacy → Manage Certificates → Authorities → Import"
echo "    Mobile:  install the .pem via Settings → Certificates (iOS/Android)"
echo ""

# ── 8. Disk space ────────────────────────────────────────────────
head "8. Disk Space"
AVAIL=$(df -h / 2>/dev/null | awk 'NR==2{print $4}')
AVAIL_KB=$(df / 2>/dev/null | awk 'NR==2{print $4}')
if [ -n "$AVAIL_KB" ] && [ "$AVAIL_KB" -lt 1000000 ]; then
  fail "Low disk space: ${AVAIL} free"
  echo "     Fix: docker system prune -a  (removes unused images)"
else
  ok "Disk space OK: ${AVAIL} free"
fi

# ── 9. Recent Logs ───────────────────────────────────────────────
head "9. Recent Sync Server Logs"
if [ "$SYNC_STATE" != "not found" ]; then
  echo ""
  echo -e "${CYAN}--- rsw-sync (last 15 lines) ---${NC}"
  docker logs rsw-sync --tail=15 2>&1 || \
  sudo docker logs rsw-sync --tail=15 2>&1 || \
  echo "  (could not read logs)"
fi

# ── Summary ──────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}═══════════════════════════════════════════════${NC}"
echo -e "${BOLD}Quick Fix Commands:${NC}"
echo ""
echo -e "${CYAN}  # Start/restart the sync server:${NC}"
echo "  cd \"$HOST_DIR\""
echo "  docker compose up -d --build"
echo ""
echo -e "${CYAN}  # View live logs:${NC}"
echo "  cd \"$HOST_DIR\" && docker compose logs -f"
echo ""
echo -e "${CYAN}  # Check health (HTTPS, -k accepts self-signed cert):${NC}"
echo "  curl -sk https://localhost:${SYNC_PORT}/health | python3 -m json.tool"
echo ""
echo -e "${CYAN}  # Download cert for browser trust:${NC}"
echo "  curl -sk https://localhost:${SYNC_PORT}/cert -o rsw-sync-cert.pem"
echo ""
