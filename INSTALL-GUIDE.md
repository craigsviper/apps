# RSW Field App v73.142 — Installation Guide

## What This App Is

RSW Field App is a Progressive Web App (PWA) for road sweeping and site inspection field operations.

- **Client app** — runs in Firefox on any device (desktop, tablet, phone), works offline
- **Host server** — optional Node.js sync server running on your office computer (Linux Mint)
- Data is saved locally in the browser. The host server provides sync, backup, and multi-device sharing.

---

## Quick Install (Linux Mint — Recommended)

### 1. Install prerequisites
```bash
# Install Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker

# Verify
docker --version
docker compose version
```

### 2. Create project folder and add your zip
```bash
mkdir -p ~/rsw-field-app
cd ~/rsw-field-app
# Copy RSW-Field-App_vX.X_*.zip into this folder, then:
unzip RSW-Field-App_*.zip
cd RSW-Field-App-v*/
```

### 3. Start the app
```bash
docker compose up -d --build
```

App is now running at: **https://localhost:8050**

> Accept the self-signed certificate warning in Firefox (click Advanced → Accept Risk).

---

## Host Server (Sync Server)

The sync server lets multiple devices share data and provides automatic backups.

### Start the host server
```bash
cd host-server/
docker compose up -d --build
```

Server runs at: **http://YOUR-IP:8055** (HTTP) or **https://YOUR-IP:8056** (HTTPS)

### Check it's working
```bash
curl http://localhost:8055/health
# Returns: {"status":"ok","version":"59.3",...}
```

### Server dashboard
Open **http://YOUR-IP:8055/dashboard** in a browser to:
- View all data collections
- Create/download backups
- Restore from backup (Full or Selective)
- Monitor health

Default token: set in `host-server/.env` as `SYNC_TOKEN=your-secret-token`

### Optional: enable "Select Roads" mode (v73.12+)

Areas & Roads → Edit Road's "Select Roads" mode (build a route segment by
clicking/lasso/box-selecting existing road geometry instead of drawing it
point-by-point — see the feature list above for everything this now covers)
needs a one-time road-network data file on the host server.

**Full step-by-step instructions — including what to do if you're setting
this up fresh, restoring it on a rebuilt/replaced host-server, or just
refreshing an already-loaded file (a one-click dashboard button as of
v73.56, no re-download needed) — live in `host-server/road-data-setup/README.md`**,
written for anyone regardless of technical background. A `./restore-road-data.sh`
helper script (generated automatically by `install-host.sh` alongside
`start.sh`/`stop.sh`/etc.) handles copying the file in and reloading it in
one step.

Without this file, Select Roads mode still appears in the UI but shows an
in-app message that no road data is loaded yet; "Draw Points" (the original
click-to-draw method, including its own bulk-delete/Find Long Jumps tools —
see above) is unaffected either way. This file is separate from your app
data and is **not** included in `backup-data.sh` or the app's own Backup &
Sync — see the "Why doesn't my regular backup cover this?" section in that
guide for why, and what (if anything) to do about it.

### Optional: enable "🛰️ Snap to Roads" (v73.69+)

Areas & Roads → Edit Road's "Snap to Roads" button corrects a drawn segment's
points onto real OSM road geometry via a self-hosted routing engine (OSRM) —
a different, more thorough tool than Simplify Points/Find Long Jumps/Find
Duplicate Lines (which still work fine without this and remain available
either way). Needs its own one-time Docker service and road-graph build,
separate from the `road-data-setup` file above (that one's a reference map
for Select Roads to click from; this is a matching engine to snap drawn
points onto).

**Full step-by-step instructions live in `host-server/OSRM_SETUP_GUIDE.md`**,
same beginner-friendly format as the road-data-setup guide. Short version:
`cd host-server && ./setup-osrm.sh` (one-time, needs real internet + ~15-20
min), then `docker compose up -d`.

Without this, Snap to Roads simply isn't available — everything else in the
app is unaffected.

---

## Connect the App to the Host Server

1. Open the app → **Backup & Sync**
2. Scroll to **Sync Server** section
3. Enter server URL: `http://192.168.x.x:8055`
4. Enter your sync token
5. Tap **Test Connection** — should show ✅ Connected
6. Tap **Push & Sync** to upload local data to server

---

## Updating to a New Version

```bash
# 1. Export backup from app first (Backup & Sync → Download Full Backup)
# 2. Stop running containers
docker compose down
cd host-server && docker compose down && cd ..
# 3. Replace files with new version zip
cd .. && unzip RSW-Field-App_vX.X_*.zip
cd RSW-Field-App-v*/
# 4. Rebuild and start
docker compose up -d --build
cd host-server && docker compose up -d --build && cd ..
# 5. Import your backup (Backup & Sync → Choose Backup File)
```

---

## Troubleshooting

### App shows blank page after update
The service worker is serving a cached version. Fix:
- Go to **Backup & Sync → Clear App Cache & Reload**
- Or in Firefox: Settings → History → Clear Recent History → Cache only

### Can't connect to host server
- Check server is running: `docker ps | grep rsw`
- Confirm IP address: `ip addr show | grep 192.168`
- Confirm port: `curl http://localhost:8055/health`
- Check Firefox isn't blocking mixed content (HTTP server from HTTPS app) — use HTTP for both

### Data disappeared after browser update
Browser cleared IndexedDB storage. Always keep a recent backup:
- Export backup regularly (Backup & Sync → Download Full Backup)
- Or use the host server for persistent storage

### Service worker not updating
```bash
# Force rebuild with no cache
docker compose down && docker compose build --no-cache && docker compose up -d
```

### Check app logs
```bash
docker logs rsw-app --tail 50
docker logs rsw-sync-server --tail 50
```

---

## File Structure

```
RSW-Field-App-vX.X/
├── src/                          ← React/TypeScript source
├── public/sw.js                  ← Service worker (auto-updates on version bump)
├── public/manifest.json          ← PWA manifest
├── host-server/
│   ├── sync-server/server.js     ← Express sync + backup server
│   ├── docker-compose.yml        ← Host server Docker config
│   └── sync-server/sync-data/    ← Server data + backups (created at runtime)
├── Dockerfile                    ← App Docker build (Nginx + Vite)
├── docker-compose.yml            ← App Docker config
├── nginx.conf                    ← Nginx config (HTTPS on port 8050)
├── CLAUDE_CONTEXT.md             ← AI session context + full change history
└── INSTALL-GUIDE.md              ← This file
```

---

## Ports Reference

| Port | Service | Protocol |
|------|---------|----------|
| 8050 | RSW Field App (Nginx) | HTTPS |
| 8055 | Sync Server API | HTTP |
| 8056 | Sync Server API | HTTPS (self-signed) |

---

*RSW Field App v73.142 — Road & Stormwater · Inspection & Sweeping*
