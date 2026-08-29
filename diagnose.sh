#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  RSW Field App v12 — Diagnostic Tool          ║
# ║  Run this if the app won't start or shows blank screen.     ║
# ║  Usage: chmod +x diagnose.sh && ./diagnose.sh               ║
# ╚══════════════════════════════════════════════════════════════╝

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✔  $*${NC}"; }
fail() { echo -e "${RED}  ✖  $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠  $*${NC}"; }
info() { echo -e "${CYAN}  ℹ  $*${NC}"; }
head() { echo -e "\n${BOLD}$*${NC}"; }

APP_PORT=8050
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_PORT=8055

echo ""
echo -e "${BOLD}╔═══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   RSW Inspector — Diagnostic Report           ║${NC}"
echo -e "${BOLD}╚═══════════════════════════════════════════════╝${NC}"
echo ""

# ── 1. Docker ──────────────────────────────────────────────────────────────
head "1. Docker"
if command -v docker &>/dev/null; then
  ok "Docker installed: $(docker --version 2>/dev/null | cut -d' ' -f3 | tr -d ',')"
else
  fail "Docker NOT installed"
  echo "     Fix: sudo apt-get install docker-ce docker-compose-plugin"
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

# ── 2. Containers ──────────────────────────────────────────────────────────
head "2. Containers"
cd "$APP_DIR" 2>/dev/null

APP_STATE=$(docker inspect --format='{{.State.Status}}' rsw-app 2>/dev/null || echo "not found")

if [ "$APP_STATE" = "running" ]; then
  ok "rsw-app: running"
elif [ "$APP_STATE" = "not found" ]; then
  fail "rsw-app: container not found (never built or removed)"
  echo "     Fix: docker compose up -d --build"
else
  fail "rsw-app: $APP_STATE"
  echo "     Fix: docker compose up -d --build"
fi


# ── 3. Port check ──────────────────────────────────────────────────────────
head "3. Ports"
if curl -sf --max-time 5 "http://localhost:${APP_PORT}/" > /dev/null 2>&1; then
  ok "Port ${APP_PORT} is responding ✅"
else
  fail "Port ${APP_PORT} NOT responding (this is your 'refused to connect' error)"
  BLOCKER=$(sudo ss -tlnp 2>/dev/null | grep ":${APP_PORT}" || true)
  if [ -z "$BLOCKER" ]; then
    warn "Nothing is listening on port ${APP_PORT}"
    echo "     The container is not running or the build failed."
  else
    warn "Something else is on port ${APP_PORT}: $BLOCKER"
    echo "     Fix: edit .env → change RSW_PORT=8060 → docker compose up -d"
  fi
fi

if curl -sf --max-time 5 "http://localhost:${SYNC_PORT}/health" > /dev/null 2>&1; then
  ok "Port ${SYNC_PORT} (sync) is responding"
else
  warn "Port ${SYNC_PORT} (sync) not responding (optional — only needed for multi-device sync)"
fi

# ── 4. Build logs ──────────────────────────────────────────────────────────
head "4. Recent Container Logs"
if [ "$APP_STATE" != "not found" ]; then
  echo ""
  echo -e "${CYAN}--- rsw-app (last 20 lines) ---${NC}"
  docker logs rsw-app --tail=20 2>&1 || sudo docker logs rsw-app --tail=20 2>&1 || echo "  (could not read logs)"
else
  info "No container found — attempting a build now to show errors..."
  echo ""
  if [ -f "$APP_DIR/docker-compose.yml" ]; then
    docker compose build 2>&1 | tail -30 || sudo docker compose build 2>&1 | tail -30
  fi
fi

# ── 5. Files ───────────────────────────────────────────────────────────────
head "5. Required Files"
for f in "Dockerfile" "docker-compose.yml" "package.json" "package-lock.json" "vite.config.ts" "nginx.conf"; do
  if [ -f "$APP_DIR/$f" ]; then
    ok "$f"
  else
    fail "$f — MISSING"
  fi
done

# ── 6. Firewall ────────────────────────────────────────────────────────────
head "6. Firewall"
if command -v ufw &>/dev/null; then
  UFW_STATUS=$(sudo ufw status 2>/dev/null | head -1)
  if echo "$UFW_STATUS" | grep -q "inactive"; then
    ok "UFW firewall is inactive (ports are open)"
  else
    PORT_RULE=$(sudo ufw status 2>/dev/null | grep "$APP_PORT" || true)
    if [ -n "$PORT_RULE" ]; then
      ok "UFW: port $APP_PORT is allowed"
    else
      warn "UFW active but port $APP_PORT may not be allowed"
      echo "     Fix: sudo ufw allow ${APP_PORT}/tcp"
    fi
  fi
else
  info "UFW not installed — skipping firewall check"
fi

# ── 7. Disk space ──────────────────────────────────────────────────────────
head "7. Disk Space"
AVAIL=$(df -h / 2>/dev/null | awk 'NR==2{print $4}')
AVAIL_G=$(df / 2>/dev/null | awk 'NR==2{print $4}')
if [ -n "$AVAIL_G" ] && [ "$AVAIL_G" -lt 1000000 ]; then
  fail "Low disk space: ${AVAIL} free — Docker needs at least 2 GB"
  echo "     Fix: docker system prune -a  (removes unused images)"
else
  ok "Disk space OK: ${AVAIL} free"
fi

# ── 8. .env file ───────────────────────────────────────────────────────────
head "8. Configuration"
if [ -f "$APP_DIR/.env" ]; then
  ok ".env file exists"
  RSW_PORT=$(grep RSW_PORT "$APP_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d ' ')
  if [ -n "$RSW_PORT" ] && [ "$RSW_PORT" != "$APP_PORT" ]; then
    warn "RSW_PORT in .env is $RSW_PORT — open http://localhost:$RSW_PORT instead"
  fi
else
  warn ".env file missing — will be created on next install run"
fi

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}═══════════════════════════════════════════════${NC}"
echo -e "${BOLD}Quick Fix Commands:${NC}"
echo ""

if [ "$APP_STATE" = "not found" ] || [ "$APP_STATE" = "exited" ]; then
  echo -e "${CYAN}  # Rebuild and start everything from scratch:${NC}"
  echo "  cd \"$APP_DIR\""
  echo "  docker compose down"
  echo "  docker compose up -d --build"
  echo ""
  echo -e "${CYAN}  # See full build output (no -d flag):${NC}"
  echo "  docker compose up --build"
else
  echo -e "${CYAN}  # Restart containers:${NC}"
  echo "  cd \"$APP_DIR\" && docker compose restart"
  echo ""
  echo -e "${CYAN}  # View live logs:${NC}"
  echo "  cd \"$APP_DIR\" && docker compose logs -f"
fi

echo ""
echo -e "${CYAN}  # Check what's running:${NC}"
echo "  docker compose ps"
echo ""
echo -e "${CYAN}  # Your IP addresses (for phone access):${NC}"
hostname -I | tr ' ' '\n' | grep -v '^$' | while read ip; do
  echo "  http://${ip}:${APP_PORT}"
done
echo ""
