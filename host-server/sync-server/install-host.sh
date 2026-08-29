#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  RSW Field App v41.0 — HOST SYNC SERVER INSTALLER              ║
# ║                                                                  ║
# ║  Run this on ONE machine only — the computer that stays on      ║
# ║  your network and stores shared data for all field devices.     ║
# ║                                                                  ║
# ║  After this is done, install the CLIENT APP on each field       ║
# ║  computer using:  install-linux-mint.sh (in the root folder)    ║
# ║                                                                  ║
# ║  Supports: Linux Mint · Ubuntu · Debian · Proxmox VM · LXC     ║
# ║  Sync port: 8055                                                 ║
# ╚══════════════════════════════════════════════════════════════════╝
set -e

HOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_PORT=8055
DOCKER_CMD="docker"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${BLUE}  ℹ  $*${NC}"; }
success() { echo -e "${GREEN}  ✔  $*${NC}"; }
warn()    { echo -e "${YELLOW}  ⚠  $*${NC}"; }
error()   { echo -e "${RED}  ✖  $*${NC}"; exit 1; }
step()    { echo -e "\n${CYAN}${BOLD}▶ $*${NC}"; }

function _ensure_docker() {
  step "Checking Docker..."
  if ! command -v docker &>/dev/null; then
    warn "Docker not found. Installing Docker CE..."
    sudo apt-get update -qq
    sudo apt-get install -y ca-certificates curl gnupg lsb-release
    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null
    sudo chmod a+r /etc/apt/keyrings/docker.gpg
    if [ -f /etc/os-release ]; then
      . /etc/os-release
      UBUNTU_CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
      [ -z "$UBUNTU_CODENAME" ] && UBUNTU_CODENAME=$(lsb_release -cs 2>/dev/null || echo "jammy")
    else
      UBUNTU_CODENAME=$(lsb_release -cs 2>/dev/null || echo "jammy")
    fi
    info "Using Ubuntu codename: ${UBUNTU_CODENAME}"
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME} stable" \
      | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    sudo apt-get update -qq
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    success "Docker installed successfully"
  else
    success "Docker found: $(docker --version | cut -d' ' -f3 | tr -d ',')"
  fi
  if ! docker compose version &>/dev/null 2>&1; then
    sudo apt-get install -y docker-compose-plugin
  fi
  success "Docker Compose: $(docker compose version --short 2>/dev/null || echo 'OK')"
  if ! groups "$USER" | grep -q docker; then
    sudo usermod -aG docker "$USER"
    warn "Added $USER to docker group — log out and back in after install."
    DOCKER_CMD="sudo docker"
  else
    DOCKER_CMD="docker"
  fi
  if ! docker info &>/dev/null 2>&1 && ! sudo docker info &>/dev/null 2>&1; then
    sudo systemctl enable docker --now; sleep 3
  fi
  success "Docker daemon running"
}

function _ensure_nodejs() {
  step "Checking Node.js..."
  NODE_OK=false
  if command -v node &>/dev/null; then
    NODE_VER=$(node --version | tr -d 'v' | cut -d. -f1)
    if [ "$NODE_VER" -ge 18 ]; then success "Node.js $(node --version) found"; NODE_OK=true
    else warn "Node.js $(node --version) too old (need v18+). Upgrading..."; fi
  fi
  if [ "$NODE_OK" = false ]; then
    info "Installing Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
    success "Node.js $(node --version) installed"
  fi
}

function _preserve_token() {
  # Read existing token from .env — never overwrite it during updates
  if [ -f "$HOST_DIR/.env" ]; then
    EXISTING_TOKEN=$(grep "^SYNC_TOKEN=" "$HOST_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d ' ')
    if [ -n "$EXISTING_TOKEN" ] && [ "$EXISTING_TOKEN" != "rsw-sync-token-change-me" ]; then
      echo "$EXISTING_TOKEN"
      return 0
    fi
  fi
  echo ""
}

function _create_env() {
  step "Creating configuration..."
  if [ ! -f "$HOST_DIR/.env" ]; then
    RANDOM_TOKEN=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1 2>/dev/null \
      || date +%s | sha256sum | base64 | head -c 32)
    cat > "$HOST_DIR/.env" << EOF
# RSW Host Sync Server — Environment Configuration
# Created: $(date)
# ──────────────────────────────────────────────────────────────────
# Share the SYNC_TOKEN with all field computers.
# They enter it in the app: Backup & Sync → ⚙️ Configure → Sync Token
# ──────────────────────────────────────────────────────────────────

SYNC_PORT=${SYNC_PORT}
TZ=Pacific/Auckland
SYNC_TOKEN=${RANDOM_TOKEN}
EOF
    success "Created .env with a unique sync token"
    # Also write to sync-server/.env so node server.js finds it without Docker
    cp "$HOST_DIR/.env" "$HOST_DIR/sync-server/.env" 2>/dev/null || true
    echo ""
    echo -e "  ${YELLOW}${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
    echo -e "  ${YELLOW}${BOLD}║   SAVE THIS SYNC TOKEN — you need it for all devices!   ║${NC}"
    echo -e "  ${YELLOW}${BOLD}╠══════════════════════════════════════════════════════════╣${NC}"
    echo -e "  ${YELLOW}${BOLD}║${NC}  Token: ${CYAN}${RANDOM_TOKEN}${NC}"
    echo -e "  ${YELLOW}${BOLD}║${NC}  Saved: ${CYAN}${HOST_DIR}/.env${NC}"
    echo -e "  ${YELLOW}${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${YELLOW}Field computers enter this in the app:${NC}"
    echo -e "  ${CYAN}Backup & Sync → ⚙️  Configure → Sync Token${NC}"
    echo ""
    read -rp "  Press Enter to continue..."
  else
    # Ensure SYNC_PORT is correct even if .env already exists
    if grep -q "SYNC_PORT" "$HOST_DIR/.env"; then
      sed -i "s/^SYNC_PORT=.*/SYNC_PORT=${SYNC_PORT}/" "$HOST_DIR/.env"
    else
      echo "SYNC_PORT=${SYNC_PORT}" >> "$HOST_DIR/.env"
    fi
    success ".env already exists — keeping your existing token, port set to ${SYNC_PORT}"
    # Mirror to sync-server/.env so node server.js always finds the token
    cp "$HOST_DIR/.env" "$HOST_DIR/sync-server/.env" 2>/dev/null || true
    SYNC_TOKEN_VAL=$(grep SYNC_TOKEN "$HOST_DIR/.env" | cut -d= -f2 | tr -d ' ')
    echo ""
    echo -e "  ${CYAN}Your sync token: ${BOLD}${SYNC_TOKEN_VAL}${NC}"
    echo ""
  fi
}

function _build_and_start() {
  step "Building and starting sync server container..."
  info "This may take 1–2 minutes the first time (downloading base image)..."
  echo ""
  cd "$HOST_DIR"
  if ! $DOCKER_CMD compose up -d --build; then
    echo ""
    warn "Build may have failed. Showing logs:"
    $DOCKER_CMD compose logs --tail=30 2>/dev/null || true
    error "Build failed. Run: docker compose up --build (without -d) for full output."
  fi
  step "Waiting for sync server to start..."
  HEALTHY=false
  for i in $(seq 1 30); do
    SYNC_STATUS=$($DOCKER_CMD inspect --format='{{.State.Health.Status}}' rsw-sync 2>/dev/null || echo "waiting")
    SYNC_RUN=$($DOCKER_CMD inspect --format='{{.State.Running}}' rsw-sync 2>/dev/null || echo "false")
    [[ "$SYNC_STATUS" == "healthy" ]] && { HEALTHY=true; break; }
    [[ "$SYNC_RUN" == "true" && "$i" -ge 5 ]] && { HEALTHY=true; break; }
    echo -ne "  Waiting... (${i}/30) status:${SYNC_STATUS}\r"; sleep 2
  done
  echo ""
  if [ "$HEALTHY" = true ]; then success "Sync server is running!"
  else warn "May still be starting. Check: docker compose ps"; fi
  sleep 2
  if curl -sfk --max-time 5 "https://localhost:${SYNC_PORT}/health" > /dev/null 2>&1; then
    success "Sync server responding at https://localhost:${SYNC_PORT}/health"
  else
    warn "Not yet responding — check in 15 seconds: curl -k https://localhost:${SYNC_PORT}/health"
  fi
}

function _ufw_allow() {
  step "Configuring firewall..."
  if command -v ufw &>/dev/null; then
    sudo ufw allow ${SYNC_PORT}/tcp comment 'RSW Sync Server' 2>/dev/null || true
    success "Firewall rule added for port ${SYNC_PORT}"
  else
    info "UFW not found — open port ${SYNC_PORT}/TCP in your firewall if needed"
  fi
}

function _create_docker_helper_scripts() {
  cat > "$HOST_DIR/start.sh" << 'SCRIPT'
#!/usr/bin/env bash
cd "$(dirname "$0")"
docker compose up -d
echo "RSW Sync Server started."
echo "Health: curl -k https://localhost:8055/health"
SCRIPT
  cat > "$HOST_DIR/stop.sh" << 'SCRIPT'
#!/usr/bin/env bash
cd "$(dirname "$0")"
docker compose down
echo "RSW Sync Server stopped."
SCRIPT
  cat > "$HOST_DIR/restart.sh" << 'SCRIPT'
#!/usr/bin/env bash
cd "$(dirname "$0")"
docker compose restart
echo "RSW Sync Server restarted."
SCRIPT
  cat > "$HOST_DIR/logs.sh" << 'SCRIPT'
#!/usr/bin/env bash
cd "$(dirname "$0")"
docker compose logs -f --tail=100
SCRIPT
  cat > "$HOST_DIR/status.sh" << SCRIPT
#!/usr/bin/env bash
cd "\$(dirname "\$0")"
echo ""
echo "=== RSW Sync Server Status ==="
docker compose ps
echo ""
if curl -sfk https://localhost:${SYNC_PORT}/health > /dev/null 2>&1; then
  echo "Sync Server: Responding ✔"
  curl -sk https://localhost:${SYNC_PORT}/health | python3 -m json.tool 2>/dev/null || curl -sk https://localhost:${SYNC_PORT}/health
else
  echo "Sync Server: NOT responding ✖"
fi
echo ""
echo "IP addresses (share with field computers):"
hostname -I | tr ' ' '\n' | grep -v '^\$' | while read ip; do
  echo "  Sync URL: http://\${ip}:${SYNC_PORT}"
done
echo ""
echo "Sync token: \$(grep SYNC_TOKEN \"\$(dirname \"\$0\")/.env\" 2>/dev/null | cut -d= -f2 | tr -d ' ')"
echo ""
SCRIPT
  cat > "$HOST_DIR/update.sh" << SCRIPT
#!/usr/bin/env bash
cd "\$(dirname "\$0")"
# Preserve sync token before update
SAVED_TOKEN=\$(grep "^SYNC_TOKEN=" .env 2>/dev/null | cut -d= -f2 | tr -d ' ')
echo "Stopping sync server..."
docker compose down
echo "Rebuilding from updated source..."
docker compose up -d --build
# Restore token if it was reset to placeholder
CURRENT_TOKEN=\$(grep "^SYNC_TOKEN=" .env 2>/dev/null | cut -d= -f2 | tr -d ' ')
if [ -n "\$SAVED_TOKEN" ] && [ "\$SAVED_TOKEN" != "rsw-sync-token-change-me" ] && [ "\$CURRENT_TOKEN" != "\$SAVED_TOKEN" ]; then
  sed -i "s/^SYNC_TOKEN=.*/SYNC_TOKEN=\${SAVED_TOKEN}/" .env
  echo "✔ Sync token preserved"
fi
echo ""
echo "Update complete!"
curl -sfk https://localhost:${SYNC_PORT}/health > /dev/null && echo "Sync server: Running ✔" || echo "Sync server: Check logs"
SCRIPT
  cat > "$HOST_DIR/backup-data.sh" << SCRIPT
#!/usr/bin/env bash
cd "\$(dirname "\$0")"
BACKUP_FILE="rsw-server-backup-\$(date +%Y-%m-%d_%H-%M).json"
docker cp rsw-sync:/data/rsw-data.json "./\${BACKUP_FILE}" 2>/dev/null && \
  echo "Backup saved: \${BACKUP_FILE}" || \
  echo "No data yet or container not running."
SCRIPT
  chmod +x "$HOST_DIR/start.sh" "$HOST_DIR/stop.sh" "$HOST_DIR/restart.sh" \
           "$HOST_DIR/logs.sh" "$HOST_DIR/status.sh" "$HOST_DIR/update.sh" \
           "$HOST_DIR/backup-data.sh"
  success "Helper scripts created: start, stop, restart, logs, status, update, backup-data"
}

function _create_nodejs_helper_scripts() {
  local TOKEN_VAL="$1"
  cat > "$HOST_DIR/start.sh" << EOF
#!/usr/bin/env bash
sudo systemctl start rsw-sync
echo "RSW Sync Server started."
echo "Health: curl -k https://localhost:${SYNC_PORT}/health"
EOF
  cat > "$HOST_DIR/stop.sh" << 'SCRIPT'
#!/usr/bin/env bash
sudo systemctl stop rsw-sync
echo "RSW Sync Server stopped."
SCRIPT
  cat > "$HOST_DIR/restart.sh" << 'SCRIPT'
#!/usr/bin/env bash
sudo systemctl restart rsw-sync
echo "RSW Sync Server restarted."
SCRIPT
  cat > "$HOST_DIR/logs.sh" << 'SCRIPT'
#!/usr/bin/env bash
sudo journalctl -u rsw-sync -f --no-pager
SCRIPT
  cat > "$HOST_DIR/status.sh" << SCRIPT
#!/usr/bin/env bash
echo ""
sudo systemctl status rsw-sync --no-pager -l | head -20
echo ""
curl -sfk https://localhost:${SYNC_PORT}/health > /dev/null && echo "Sync Server: Responding ✔" || echo "Sync Server: NOT responding ✖"
echo ""
hostname -I | tr ' ' '\n' | grep -v '^\$' | while read ip; do echo "  http://\${ip}:${SYNC_PORT}"; done
echo ""
SCRIPT
  cat > "$HOST_DIR/update.sh" << EOF
#!/usr/bin/env bash
cd "${HOST_DIR}"
sudo systemctl stop rsw-sync
cd sync-server && npm install --omit=dev --no-audit --no-fund && cd ..
sudo systemctl start rsw-sync
echo "Update complete!"
EOF
  cat > "$HOST_DIR/backup-data.sh" << EOF
#!/usr/bin/env bash
BACKUP_FILE="${HOST_DIR}/rsw-server-backup-\$(date +%Y-%m-%d_%H-%M).json"
cp "${HOST_DIR}/sync-data/rsw-data.json" "\$BACKUP_FILE" 2>/dev/null && \
  echo "Backup saved: \$BACKUP_FILE" || \
  echo "No data file found yet (no syncs performed yet)."
EOF
  chmod +x "$HOST_DIR/start.sh" "$HOST_DIR/stop.sh" "$HOST_DIR/restart.sh" \
           "$HOST_DIR/logs.sh" "$HOST_DIR/status.sh" "$HOST_DIR/update.sh" \
           "$HOST_DIR/backup-data.sh"
  success "Helper scripts created"
}

function _print_success_banner() {
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_IP")
  SYNC_TOKEN_VAL=$(grep SYNC_TOKEN "$HOST_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d ' ' || echo "check .env file")
  echo ""
  echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}${BOLD}║      ✅  Host Sync Server Installation Complete!             ║${NC}"
  echo -e "${GREEN}${BOLD}╠══════════════════════════════════════════════════════════════╣${NC}"
  echo -e "${GREEN}${BOLD}║${NC}  🌐 Sync URL: ${CYAN}http://${LAN_IP}:${SYNC_PORT}${NC}"
  echo -e "${GREEN}${BOLD}║${NC}  ❤  Health:   ${CYAN}http://${LAN_IP}:${SYNC_PORT}/health${NC}"
  echo -e "${GREEN}${BOLD}║                                                              ║${NC}"
  echo -e "${GREEN}${BOLD}║${NC}  🔑 Sync Token (enter this on every field computer):${NC}"
  echo -e "${GREEN}${BOLD}║${NC}     ${CYAN}${SYNC_TOKEN_VAL}${NC}"
  echo -e "${GREEN}${BOLD}║${NC}     (also saved in: ${CYAN}${HOST_DIR}/.env${NC})"
  echo -e "${GREEN}${BOLD}║                                                              ║${NC}"
  echo -e "${GREEN}${BOLD}║${NC}  On each field computer, open the app and go to:"
  echo -e "${GREEN}${BOLD}║${NC}    ${CYAN}Backup & Sync → ⚙️  Configure${NC}"
  echo -e "${GREEN}${BOLD}║${NC}    Enter the URL above + sync token above"
  echo -e "${GREEN}${BOLD}║                                                              ║${NC}"
  echo -e "${GREEN}${BOLD}║${NC}  Scripts: ${CYAN}./start.sh  ./stop.sh  ./status.sh${NC}"
  echo -e "${GREEN}${BOLD}║${NC}           ${CYAN}./logs.sh   ./update.sh  ./backup-data.sh${NC}"
  echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  ! groups "$USER" 2>/dev/null | grep -q " docker" && warn "Log out and back in to use Docker without sudo."
}

# =============================================================================
# OPTION 1: DOCKER (Recommended)
# =============================================================================
function install_docker() {
  echo -e "\n${GREEN}${BOLD}🐳 Installing Host Sync Server with Docker...${NC}\n"
  _ensure_docker
  _create_env
  _build_and_start
  _ufw_allow
  _create_docker_helper_scripts
  _print_success_banner
}

# =============================================================================
# OPTION 2: NODE.JS DIRECT
# =============================================================================
function install_nodejs() {
  echo -e "\n${YELLOW}${BOLD}📦 Installing Host Sync Server with Node.js (no Docker)...${NC}\n"
  _ensure_nodejs
  _create_env
  SYNC_TOKEN_VAL=$(grep SYNC_TOKEN "$HOST_DIR/.env" | cut -d= -f2 | tr -d ' ')

  step "Installing sync server dependencies..."
  cd "$HOST_DIR/sync-server"
  npm install --omit=dev --no-audit --no-fund
  cd "$HOST_DIR"
  success "Sync server dependencies installed"

  step "Creating data directory..."
  mkdir -p "$HOST_DIR/sync-data"
  success "Data directory: ${HOST_DIR}/sync-data"

  step "Creating systemd service..."
  sudo tee /etc/systemd/system/rsw-sync.service > /dev/null << EOF
[Unit]
Description=RSW Field App Sync Server v1.7.0
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=${HOST_DIR}/sync-server
Environment=SYNC_PORT=${SYNC_PORT}
Environment=SYNC_TOKEN=${SYNC_TOKEN_VAL}
Environment=DATA_DIR=${HOST_DIR}/sync-data
ExecStart=$(which node) server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable rsw-sync
  sudo systemctl start rsw-sync
  success "Service created and started"

  sleep 3
  curl -sfk --max-time 5 "https://localhost:${SYNC_PORT}/health" > /dev/null 2>&1 && \
    success "Sync server responding at https://localhost:${SYNC_PORT}/health" || \
    warn "Not yet responding — check: sudo systemctl status rsw-sync"

  _ufw_allow
  _create_nodejs_helper_scripts "$SYNC_TOKEN_VAL"
  _print_success_banner
}

# =============================================================================
# OPTION 3: UNINSTALL
# =============================================================================
function run_uninstall() {
  echo -e "\n${RED}${BOLD}🗑️  Uninstall RSW Host Sync Server${NC}\n"
  warn "This removes the sync server, service, and helper scripts."
  warn "Your source files in ${HOST_DIR} will NOT be deleted."
  echo ""; read -rp "  Are you sure? [y/N]: " CONFIRM
  [[ ! "$CONFIRM" =~ ^[Yy]$ ]] && { echo ""; info "Cancelled."; echo ""; exit 0; }
  echo ""

  if command -v docker &>/dev/null && [ -f "$HOST_DIR/docker-compose.yml" ]; then
    step "Stopping and removing Docker containers..."
    cd "$HOST_DIR"
    docker compose down --remove-orphans 2>/dev/null || sudo docker compose down --remove-orphans 2>/dev/null || true
    success "Docker containers removed"
    read -rp "  Remove Docker images? (frees disk space) [y/N]: " RM_IMAGES
    if [[ "$RM_IMAGES" =~ ^[Yy]$ ]]; then
      docker compose down --rmi all 2>/dev/null || sudo docker compose down --rmi all 2>/dev/null || true
      success "Images removed"
    fi
    read -rp "  Remove sync data volume? ⚠ ALL SHARED DATA WILL BE LOST [y/N]: " RM_VOL
    if [[ "$RM_VOL" =~ ^[Yy]$ ]]; then
      docker volume rm rsw-sync-data 2>/dev/null || sudo docker volume rm rsw-sync-data 2>/dev/null || true
      success "Data volume removed"
    fi
  fi

  if systemctl list-units --full -all 2>/dev/null | grep -q rsw-sync; then
    step "Removing systemd service..."
    sudo systemctl stop rsw-sync 2>/dev/null || true
    sudo systemctl disable rsw-sync 2>/dev/null || true
    sudo rm -f /etc/systemd/system/rsw-sync.service
    sudo systemctl daemon-reload; success "Service removed"
  fi

  command -v ufw &>/dev/null && { sudo ufw delete allow ${SYNC_PORT}/tcp 2>/dev/null || true; }

  step "Removing helper scripts..."
  rm -f "$HOST_DIR/start.sh" "$HOST_DIR/stop.sh" "$HOST_DIR/restart.sh" \
        "$HOST_DIR/logs.sh" "$HOST_DIR/status.sh" "$HOST_DIR/update.sh" \
        "$HOST_DIR/backup-data.sh"
  success "Scripts removed"

  if [ -d "$HOST_DIR/sync-data" ]; then
    read -rp "  Remove sync-data folder? ⚠ ALL SHARED DATA WILL BE LOST [y/N]: " RM_DATA
    if [[ "$RM_DATA" =~ ^[Yy]$ ]]; then rm -rf "$HOST_DIR/sync-data"; success "sync-data removed"
    else info "sync-data kept at: ${HOST_DIR}/sync-data"; fi
  fi

  if [ -f "$HOST_DIR/.env" ]; then
    read -rp "  Remove .env config file (contains sync token)? [y/N]: " RM_ENV
    [[ "$RM_ENV" =~ ^[Yy]$ ]] && { rm -f "$HOST_DIR/.env"; success ".env removed"; }
  fi

  echo -e "\n${GREEN}${BOLD}✅ Uninstall complete.${NC}"
  echo -e "  Source files: ${CYAN}${HOST_DIR}${NC}"
  echo -e "  Reinstall:    ${CYAN}bash install-host.sh${NC}\n"
}

# =============================================================================
# OPTION 4: UPDATE
# =============================================================================
function run_update() {
  echo -e "\n${CYAN}${BOLD}🔄 Updating RSW Host Sync Server...${NC}\n"
  cd "$HOST_DIR"
  INSTALL_TYPE="unknown"
  command -v docker &>/dev/null && \
    (docker inspect rsw-sync &>/dev/null 2>&1 || sudo docker inspect rsw-sync &>/dev/null 2>&1) && \
    INSTALL_TYPE="docker"
  systemctl list-units --full -all 2>/dev/null | grep -q rsw-sync && INSTALL_TYPE="nodejs"

  if [ "$INSTALL_TYPE" = "unknown" ]; then
    warn "Could not auto-detect install type."
    echo -e "  ${GREEN}1)${NC} Docker  ${YELLOW}2)${NC} Node.js"
    read -rp "  Enter choice [1-2]: " TC
    case "$TC" in 1) INSTALL_TYPE="docker";; 2) INSTALL_TYPE="nodejs";; *) error "Invalid.";; esac
  else info "Detected: ${INSTALL_TYPE}"; fi

  if [ "$INSTALL_TYPE" = "docker" ]; then
    groups "$USER" | grep -q docker || DOCKER_CMD="sudo docker"
    # Preserve token before any file operations
    SAVED_TOKEN=$(_preserve_token)
    [ -n "$SAVED_TOKEN" ] && info "Preserving sync token: ${SAVED_TOKEN:0:8}..."
    step "Stopping container..."; $DOCKER_CMD compose down
    step "Rebuilding..."; $DOCKER_CMD compose up -d --build || error "Rebuild failed."
    # Restore token if it was wiped
    if [ -n "$SAVED_TOKEN" ]; then
      if grep -q "^SYNC_TOKEN=" "$HOST_DIR/.env" 2>/dev/null; then
        sed -i "s/^SYNC_TOKEN=.*/SYNC_TOKEN=${SAVED_TOKEN}/" "$HOST_DIR/.env"
      else
        echo "SYNC_TOKEN=${SAVED_TOKEN}" >> "$HOST_DIR/.env"
      fi
      success "Sync token preserved ✔"
    fi
    sleep 5
    curl -sfk --max-time 5 "https://localhost:${SYNC_PORT}/health" > /dev/null && \
      success "Sync server running at https://localhost:${SYNC_PORT}" || \
      warn "Check: docker compose logs rsw-sync"
  elif [ "$INSTALL_TYPE" = "nodejs" ]; then
    # Preserve token before any file operations
    SAVED_TOKEN=$(_preserve_token)
    [ -n "$SAVED_TOKEN" ] && info "Preserving sync token: ${SAVED_TOKEN:0:8}..."
    step "Stopping service..."; sudo systemctl stop rsw-sync 2>/dev/null || true
    step "Updating dependencies..."
    cd "$HOST_DIR/sync-server"; npm install --omit=dev --no-audit --no-fund; cd "$HOST_DIR"
    step "Restarting..."; sudo systemctl start rsw-sync; sleep 3
    # Restore token if wiped
    if [ -n "$SAVED_TOKEN" ]; then
      if grep -q "^SYNC_TOKEN=" "$HOST_DIR/.env" 2>/dev/null; then
        sed -i "s/^SYNC_TOKEN=.*/SYNC_TOKEN=${SAVED_TOKEN}/" "$HOST_DIR/.env"
      else
        echo "SYNC_TOKEN=${SAVED_TOKEN}" >> "$HOST_DIR/.env"
      fi
      success "Sync token preserved ✔"
    fi
    curl -sfk --max-time 5 "https://localhost:${SYNC_PORT}/health" > /dev/null && \
      success "Sync server running at https://localhost:${SYNC_PORT}" || \
      warn "Check: sudo systemctl status rsw-sync"
  fi

  echo -e "\n${GREEN}${BOLD}✅ Update complete!${NC}\n    ${CYAN}https://localhost:${SYNC_PORT}/health${NC}\n"
}

# ── MENU ──────────────────────────────────────────────────────────
clear
echo ""
echo -e "${BLUE}${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}${BOLD}║     RSW Field App v41.0 — Host Sync Server Installer        ║${NC}"
echo -e "${BLUE}${BOLD}║     Linux Mint · Ubuntu · Debian · Proxmox VM · LXC          ║${NC}"
echo -e "${BLUE}${BOLD}╠══════════════════════════════════════════════════════════════╣${NC}"
echo -e "${BLUE}${BOLD}║  Run this on the HOST computer ONLY (one machine per team).  ║${NC}"
echo -e "${BLUE}${BOLD}║  After this, run install-linux-mint.sh on each field device. ║${NC}"
echo -e "${BLUE}${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Host folder: ${CYAN}${HOST_DIR}${NC}"
echo -e "  Sync port:   ${CYAN}https://localhost:${SYNC_PORT}${NC}"
echo ""
echo -e "${BOLD}What would you like to do?${NC}"
echo ""
echo -e "  ${GREEN}1)${NC}  🐳  ${BOLD}Docker               ${GREEN}(Recommended — Easiest)${NC}"
echo -e "            Runs sync server in an isolated container."
echo -e "            Auto-starts on boot. Easy updates."
echo ""
echo -e "  ${YELLOW}2)${NC}  📦  ${BOLD}Node.js Direct       ${YELLOW}(No Docker)${NC}"
echo -e "            Runs sync server directly with Node.js."
echo -e "            Uses systemd to auto-start on boot."
echo ""
echo -e "  ${RED}3)${NC}  🗑️   ${BOLD}Uninstall${NC}"
echo -e "            Remove sync server, services, and helper scripts."
echo ""
echo -e "  ${BLUE}4)${NC}  🔄  ${BOLD}Update${NC}"
echo -e "            Rebuild and restart with latest sync server code."
echo ""
echo -e "  ${RED}5)${NC}  ❌  ${BOLD}Cancel${NC}"
echo ""
read -rp "  Enter choice [1-5]: " CHOICE
echo ""
case "$CHOICE" in
  1) install_docker ;;
  2) install_nodejs ;;
  3) run_uninstall ;;
  4) run_update ;;
  5) echo "  Cancelled."; echo ""; exit 0 ;;
  *) error "Invalid choice '${CHOICE}'. Choose 1–5." ;;
esac
