#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  RSW Field App v40.6 — FIELD COMPUTER INSTALLER                   ║
# ║                                                                  ║
# ║  Installs the RSW Field App on THIS computer.                   ║
# ║  Run this on every laptop/tablet used in the field.             ║
# ║                                                                  ║
# ║  ⚠  Set up the sync server FIRST on the host computer using:    ║
# ║     host-server/install-host.sh                                  ║
# ║                                                                  ║
# ║  Supports: Linux Mint · Ubuntu · Debian                         ║
# ║  App port: 8050 (HTTPS — required for GPS & camera)             ║
# ╚══════════════════════════════════════════════════════════════════╝
set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_PORT=8050
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
    warn "Added $USER to docker group — you may need to log out and back in."
    DOCKER_CMD="sudo docker"
  fi
  if ! docker info &>/dev/null 2>&1 && ! sudo docker info &>/dev/null 2>&1; then
    sudo systemctl enable docker --now; sleep 3
  fi
  success "Docker daemon running"
}

function _docker_build_and_start() {
  step "Building and starting RSW Field App container..."
  info "This takes 1–3 minutes the first time (downloading base image)..."
  echo ""
  cd "$APP_DIR"
  if ! $DOCKER_CMD compose up -d --build; then
    echo ""
    warn "Build may have failed. Showing last 30 lines:"
    $DOCKER_CMD compose logs --tail=30 2>/dev/null || true
    error "Build failed. Run: docker compose up --build (without -d) for full output."
  fi
  step "Waiting for app to start..."
  for i in $(seq 1 30); do
    STATUS=$($DOCKER_CMD inspect --format='{{.State.Health.Status}}' rsw-app 2>/dev/null || echo "waiting")
    RUNNING=$($DOCKER_CMD inspect --format='{{.State.Running}}' rsw-app 2>/dev/null || echo "false")
    [[ "$STATUS" == "healthy" ]] && { success "App is healthy!"; break; }
    [[ "$RUNNING" == "true" && "$i" -ge 5 ]] && { success "App is running!"; break; }
    echo -ne "  Waiting... (${i}/30)\r"; sleep 3
  done
  echo ""
  sleep 2
  if curl -sf --max-time 5 -k "https://localhost:${APP_PORT}/" > /dev/null 2>&1; then
    success "App responding on https://localhost:${APP_PORT}/"
  else
    warn "Not yet responding — may still be starting. Wait 15 seconds then try."
  fi
}

function _ufw_allow() {
  step "Configuring firewall..."
  if command -v ufw &>/dev/null; then
    sudo ufw allow ${APP_PORT}/tcp comment 'RSW Field App HTTPS' 2>/dev/null || true
    success "Firewall rule added for port ${APP_PORT}"
  else
    info "UFW not found — manually open port ${APP_PORT}/TCP if needed"
  fi
}

function _desktop_shortcut() {
  if [ -d "$HOME/Desktop" ]; then
    cat > "$HOME/Desktop/RSW-Field-App.desktop" << EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=RSW Field App
Comment=Road & Stormwater Inspection & Sweeping Programme
Exec=xdg-open https://localhost:${APP_PORT}
Icon=applications-internet
Terminal=false
Categories=Application;
EOF
    chmod +x "$HOME/Desktop/RSW-Field-App.desktop" 2>/dev/null || true
    success "Desktop shortcut created"
  fi
}

function _create_helper_scripts() {
  cat > "$APP_DIR/start.sh" << EOF
#!/usr/bin/env bash
cd "\$(dirname "\$0")"
docker compose up -d
echo "RSW Field App started — https://localhost:${APP_PORT}"
sleep 2
xdg-open "https://localhost:${APP_PORT}" 2>/dev/null || echo "Open: https://localhost:${APP_PORT}"
EOF
  cat > "$APP_DIR/stop.sh" << 'SCRIPT'
#!/usr/bin/env bash
cd "$(dirname "$0")"
docker compose down
echo "RSW Field App stopped."
SCRIPT
  cat > "$APP_DIR/restart.sh" << 'SCRIPT'
#!/usr/bin/env bash
cd "$(dirname "$0")"
docker compose restart
echo "RSW Field App restarted."
SCRIPT
  cat > "$APP_DIR/logs.sh" << 'SCRIPT'
#!/usr/bin/env bash
cd "$(dirname "$0")"
docker compose logs -f --tail=100
SCRIPT
  cat > "$APP_DIR/update.sh" << 'SCRIPT'
#!/usr/bin/env bash
cd "$(dirname "$0")"
echo "Stopping app..."
docker compose down
echo "Rebuilding with latest HTML file..."
docker compose up -d --build
echo "Update complete!"
SCRIPT
  cat > "$APP_DIR/status.sh" << EOF
#!/usr/bin/env bash
cd "\$(dirname "\$0")"
echo ""
echo "=== RSW Field App Status ==="
docker compose ps
echo ""
curl -sfk https://localhost:${APP_PORT}/ > /dev/null && echo "App: Responding ✔" || echo "App: NOT responding ✖"
echo ""
echo "Access URLs:"
hostname -I | tr ' ' '\n' | grep -v '^\$' | while read ip; do
  echo "  https://\${ip}:${APP_PORT}"
done
echo ""
EOF
  chmod +x "$APP_DIR/start.sh" "$APP_DIR/stop.sh" "$APP_DIR/restart.sh" \
           "$APP_DIR/logs.sh" "$APP_DIR/update.sh" "$APP_DIR/status.sh"
  success "Helper scripts created: start, stop, restart, logs, update, status"
}

function _install_nodejs_simple() {
  step "Installing Python3 (for simple HTTP server)..."
  if ! command -v python3 &>/dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y python3
  fi
  success "Python3 available: $(python3 --version)"

  step "Creating systemd service (Python3 HTTP server)..."
  sudo tee /etc/systemd/system/rsw-app.service > /dev/null << EOF
[Unit]
Description=RSW Field App
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=${APP_DIR}
ExecStart=python3 -m http.server ${APP_PORT} --bind 0.0.0.0 --directory ${APP_DIR}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
  # Rename HTML to index.html at serve root
  cp "$APP_DIR/RSW-Field-App.html" "$APP_DIR/index.html" 2>/dev/null || true

  sudo systemctl daemon-reload
  sudo systemctl enable rsw-app
  sudo systemctl start rsw-app
  success "Service created and started"

  sleep 3
  if curl -sf --max-time 5 "http://localhost:${APP_PORT}/" > /dev/null 2>&1; then
    success "App responding on http://localhost:${APP_PORT}/"
    warn "Note: HTTP only (no HTTPS). GPS/camera require HTTPS — use Docker option for full support."
  else
    warn "Not responding yet — check: sudo systemctl status rsw-app"
  fi

  # Helper scripts for Node.js install
  cat > "$APP_DIR/start.sh" << EOF
#!/usr/bin/env bash
sudo systemctl start rsw-app
echo "RSW Field App started — http://localhost:${APP_PORT}"
xdg-open "http://localhost:${APP_PORT}" 2>/dev/null || echo "Open: http://localhost:${APP_PORT}"
EOF
  cat > "$APP_DIR/stop.sh" << 'SCRIPT'
#!/usr/bin/env bash
sudo systemctl stop rsw-app
echo "RSW Field App stopped."
SCRIPT
  cat > "$APP_DIR/status.sh" << EOF
#!/usr/bin/env bash
sudo systemctl status rsw-app --no-pager -l | head -20
echo ""
curl -sf http://localhost:${APP_PORT}/ > /dev/null && echo "App: Responding ✔" || echo "App: NOT responding ✖"
echo ""
hostname -I | tr ' ' '\n' | grep -v '^\$' | while read ip; do echo "  http://\${ip}:${APP_PORT}"; done
EOF
  cat > "$APP_DIR/logs.sh" << 'SCRIPT'
#!/usr/bin/env bash
sudo journalctl -u rsw-app -f --no-pager
SCRIPT
  chmod +x "$APP_DIR/start.sh" "$APP_DIR/stop.sh" "$APP_DIR/status.sh" "$APP_DIR/logs.sh"
  success "Helper scripts created"
}

function _print_success_docker() {
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_IP")
  echo ""
  echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}${BOLD}║         ✅  RSW Field App Installation Complete!             ║${NC}"
  echo -e "${GREEN}${BOLD}╠══════════════════════════════════════════════════════════════╣${NC}"
  echo -e "${GREEN}${BOLD}║${NC}  🔒 HTTPS:    ${CYAN}https://localhost:${APP_PORT}${NC}  ${GREEN}← Use this (GPS)${NC}"
  echo -e "${GREEN}${BOLD}║${NC}  📱 Network:  ${CYAN}https://${LAN_IP}:${APP_PORT}${NC}"
  echo -e "${GREEN}${BOLD}║${NC}  🔑 Login:    ${CYAN}admin@inspection.com / admin123${NC}"
  echo -e "${GREEN}${BOLD}║${NC}  ${YELLOW}→ Change password: Users → Edit User${NC}"
  echo -e "${GREEN}${BOLD}║                                                              ║${NC}"
  echo -e "${GREEN}${BOLD}║${NC}  ${YELLOW}⚠  First visit: browser will warn 'Not secure'${NC}"
  echo -e "${GREEN}${BOLD}║${NC}  ${YELLOW}   This is NORMAL for self-signed certificates.${NC}"
  echo -e "${GREEN}${BOLD}║${NC}  ${YELLOW}   Click Advanced → Proceed to localhost${NC}"
  echo -e "${GREEN}${BOLD}║${NC}  ${YELLOW}   Android: tap Details → Visit anyway${NC}"
  echo -e "${GREEN}${BOLD}║                                                              ║${NC}"
  echo -e "${GREEN}${BOLD}║${NC}  To connect sync server: App → Backup & Sync"
  echo -e "${GREEN}${BOLD}║${NC}  Enter host IP + port ${CYAN}8055${NC} + sync token"
  echo -e "${GREEN}${BOLD}║                                                              ║${NC}"
  echo -e "${GREEN}${BOLD}║${NC}  Scripts: ${CYAN}./start.sh  ./stop.sh  ./status.sh  ./logs.sh${NC}"
  echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  sleep 2
  xdg-open "https://localhost:${APP_PORT}" 2>/dev/null || \
  echo -e "  ${YELLOW}Open your browser: https://localhost:${APP_PORT}${NC}"
  echo ""
}

function _print_success_simple() {
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_IP")
  echo ""
  echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}${BOLD}║         ✅  RSW Field App Installation Complete!             ║${NC}"
  echo -e "${GREEN}${BOLD}╠══════════════════════════════════════════════════════════════╣${NC}"
  echo -e "${GREEN}${BOLD}║${NC}  🌐 HTTP:     ${CYAN}http://localhost:${APP_PORT}${NC}"
  echo -e "${GREEN}${BOLD}║${NC}  📱 Network:  ${CYAN}http://${LAN_IP}:${APP_PORT}${NC}"
  echo -e "${GREEN}${BOLD}║${NC}  🔑 Login:    ${CYAN}admin@inspection.com / admin123${NC}"
  echo -e "${GREEN}${BOLD}║${NC}  ${YELLOW}⚠  HTTP only — GPS requires HTTPS. Use Docker for GPS.${NC}"
  echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  xdg-open "http://localhost:${APP_PORT}" 2>/dev/null || \
  echo -e "  ${YELLOW}Open: http://localhost:${APP_PORT}${NC}"
  echo ""
}

function run_uninstall() {
  echo -e "\n${RED}${BOLD}🗑️  Uninstall RSW Field App${NC}\n"
  warn "This removes the service, container, desktop shortcut, and helper scripts."
  warn "Your RSW-Field-App.html file will NOT be deleted."
  echo ""; read -rp "  Are you sure? [y/N]: " CONFIRM
  [[ ! "$CONFIRM" =~ ^[Yy]$ ]] && { echo ""; info "Cancelled."; echo ""; exit 0; }
  echo ""
  cd "$APP_DIR"
  if command -v docker &>/dev/null && $DOCKER_CMD inspect rsw-app &>/dev/null 2>&1; then
    step "Stopping and removing Docker container..."
    $DOCKER_CMD compose down --remove-orphans 2>/dev/null || true
    success "Docker container removed"
    read -rp "  Remove Docker image? (frees ~50MB) [y/N]: " RM_IMG
    [[ "$RM_IMG" =~ ^[Yy]$ ]] && { $DOCKER_CMD compose down --rmi all 2>/dev/null || true; success "Image removed"; }
  fi
  if systemctl list-units --full -all 2>/dev/null | grep -q rsw-app; then
    step "Removing systemd service..."
    sudo systemctl stop rsw-app 2>/dev/null || true
    sudo systemctl disable rsw-app 2>/dev/null || true
    sudo rm -f /etc/systemd/system/rsw-app.service
    sudo systemctl daemon-reload; success "Service removed"
  fi
  command -v ufw &>/dev/null && { sudo ufw delete allow ${APP_PORT}/tcp 2>/dev/null || true; }
  rm -f "$APP_DIR/start.sh" "$APP_DIR/stop.sh" "$APP_DIR/restart.sh" \
        "$APP_DIR/update.sh" "$APP_DIR/logs.sh" "$APP_DIR/status.sh" \
        "$APP_DIR/index.html"
  rm -f "$HOME/Desktop/RSW-Field-App.desktop"
  success "Uninstall complete"
  echo -e "  Reinstall anytime: ${CYAN}bash install-linux-mint.sh${NC}\n"
}

function run_update() {
  echo -e "\n${CYAN}${BOLD}🔄 Updating RSW Field App...${NC}\n"
  cd "$APP_DIR"
  if command -v docker &>/dev/null && $DOCKER_CMD inspect rsw-app &>/dev/null 2>&1; then
    step "Stopping container..."
    $DOCKER_CMD compose down
    step "Rebuilding with latest RSW-Field-App.html..."
    $DOCKER_CMD compose up -d --build
    sleep 5
    curl -sfk --max-time 5 "https://localhost:${APP_PORT}/" > /dev/null && \
      success "App running at https://localhost:${APP_PORT}" || \
      warn "Check: docker compose ps"
  elif systemctl list-units --full -all 2>/dev/null | grep -q rsw-app; then
    cp "$APP_DIR/RSW-Field-App.html" "$APP_DIR/index.html" 2>/dev/null || true
    sudo systemctl restart rsw-app
    sleep 3
    curl -sf --max-time 5 "http://localhost:${APP_PORT}/" > /dev/null && \
      success "App running at http://localhost:${APP_PORT}" || \
      warn "Check: sudo systemctl status rsw-app"
  else
    warn "App not currently installed. Run this script and choose option 1 or 2."
  fi
  echo -e "\n${GREEN}${BOLD}✅ Update complete!${NC}\n"
}

# ── MENU ──────────────────────────────────────────────────────────
clear
echo ""
echo -e "${BLUE}${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}${BOLD}║     RSW Field App v40.6 — Field Computer Installer             ║${NC}"
echo -e "${BLUE}${BOLD}║     Linux Mint · Ubuntu · Debian                             ║${NC}"
echo -e "${BLUE}${BOLD}╠══════════════════════════════════════════════════════════════╣${NC}"
echo -e "${BLUE}${BOLD}║  This installs the app on THIS field computer.               ║${NC}"
echo -e "${BLUE}${BOLD}║  Run host-server/install-host.sh on the host first.          ║${NC}"
echo -e "${BLUE}${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  App folder: ${CYAN}${APP_DIR}${NC}"
echo -e "  App port:   ${CYAN}https://localhost:${APP_PORT}${NC}"
echo ""
echo -e "${BOLD}What would you like to do?${NC}"
echo ""
echo -e "  ${GREEN}1)${NC}  🐳  ${BOLD}Docker               ${GREEN}(Recommended — HTTPS + GPS)${NC}"
echo -e "            Runs app via nginx with HTTPS. Installs Docker"
echo -e "            automatically. GPS and camera work on mobile."
echo ""
echo -e "  ${YELLOW}2)${NC}  🌐  ${BOLD}Simple HTTP          ${YELLOW}(No Docker — HTTP only)${NC}"
echo -e "            Serves the HTML file with Python3."
echo -e "            No GPS support (HTTP). Works for basic use."
echo ""
echo -e "  ${RED}3)${NC}  🗑️   ${BOLD}Uninstall${NC}"
echo ""
echo -e "  ${BLUE}4)${NC}  🔄  ${BOLD}Update${NC}"
echo -e "            Rebuild container or restart service with latest file."
echo ""
echo -e "  ${RED}5)${NC}  ❌  ${BOLD}Cancel${NC}"
echo ""
read -rp "  Enter choice [1-5]: " CHOICE
echo ""
case "$CHOICE" in
  1) _ensure_docker; _docker_build_and_start; _ufw_allow; _create_helper_scripts; _desktop_shortcut; _print_success_docker ;;
  2) _install_nodejs_simple; _ufw_allow; _desktop_shortcut; _print_success_simple ;;
  3) run_uninstall ;;
  4) run_update ;;
  5) echo "  Cancelled."; echo ""; exit 0 ;;
  *) error "Invalid choice '${CHOICE}'. Choose 1–5." ;;
esac
