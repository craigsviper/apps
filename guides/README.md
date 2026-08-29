# RSW Field App v73.142

**Road & Stormwater · Site & Road Inspections + Road Sweeping**

A unified field operations app for infrastructure inspection and road sweeping teams.
Works on phones, tablets, and computers. Runs fully offline after first load.

---

## What's In This App

```
RSW Field App v73.142
│
├── ROAD SWEEPING
│   ├── Sweep Jobs         — Create & conduct sweeping jobs with damage pins
│   ├── Areas & Roads      — Manage sweeping zones and road lists. Edit Road
│   │                        has two ways to build a route, used together on
│   │                        the same segment or across different segments:
│   │                          • Draw Points — click to add points by hand;
│   │                            drag to adjust; click a point/line to stage
│   │                            it, Ctrl+drag a box to stage a whole cluster,
│   │                            then bulk-delete or bulk-convert to Transit
│   │                            in one go; 🔍 Find Long Jumps auto-flags
│   │                            unusually long connecting lines to review;
│   │                            🧬 Find Duplicate Lines catches an
│   │                            accidentally-added-twice road; 🛰️ Snap to
│   │                            Roads (needs optional OSRM setup — see
│   │                            host-server/OSRM_SETUP_GUIDE.md) corrects
│   │                            the whole segment onto real road geometry
│   │                          • Select Roads — click, Lasso (freeform,
│   │                            editable, add points to refine after the
│   │                            fact), or Box (2-corner rectangle) to pick
│   │                            real road geometry instead of drawing it;
│   │                            Select/Deselect modes to add or pull roads
│   │                            back out of a build-up selection; 🚩 Set
│   │                            Start Point to choose exactly where a new
│   │                            selection begins (critical for dead-end
│   │                            roads where direction matters); optional
│   │                            "Include car parks/driveways" toggle (off
│   │                            by default); needs a one-time road-data
│   │                            setup, see `host-server/road-data-setup/
│   │                            README.md`
│   │                          • Zones — drawable polygons for car parks,
│   │                            business sites, or general areas; click to
│   │                            place boundary points, drag to move, click
│   │                            a midpoint to insert, right-click to delete
│   │                            (confirmed); tracks area (m²/ha), never
│   │                            counted in sweep km
│   ├── Sweeping Maps      — Google Maps / OSM / uploaded reference maps
│   ├── Sweep Reports      — Generate PDF sweeping reports
│   ├── SW Categories      — Debris types, damage types, vehicle types
│   ├── Job Sites          — Reusable site library with file attachments
│   └── Sweep Clients      — Sweeping client contacts & contracts
│
├── SITE & ROAD INSPECTIONS
│   ├── Inspections        — Create & conduct field inspections with photos
│   ├── Maps               — Upload site plans or use live maps with pins
│   ├── Reports            — Generate PDF inspection reports with cover pages
│   ├── Categories         — Inspection types, condition ratings, comments
│   └── Clients            — Client contacts for inspection assignments
│
└── SYSTEM
    ├── Users              — Team member accounts & roles (Admin only)
    └── Backup & Sync      — Export/import data, team sync server
```

---

## Quick Start — Easiest Method (Docker)

### Step 1 — Download & Extract

Download the ZIP file and extract it to your computer:

```
rsw-field-app-v51.0/
├── src/               ← App source code
├── Dockerfile
├── docker-compose.yml
├── install-linux-mint.sh
├── start.sh
├── stop.sh
└── README.md          ← You are here
```

### Step 2 — Open Terminal

**Linux Mint / Ubuntu:**  Press `Ctrl + Alt + T`

**macOS:**  Press `Cmd + Space`, type `Terminal`, press Enter

**Windows:**  Right-click on the folder → "Open in Terminal" (or use PowerShell)

### Step 3 — Navigate to App Folder

```bash
cd /path/to/rsw-field-app-v51.0
```

Example:
```bash
cd ~/Downloads/rsw-field-app-v51.0
```

### Step 4 — Run the Installer (Linux Mint / Ubuntu)

```bash
chmod +x install-linux-mint.sh
./install-linux-mint.sh
```

You'll see this menu:

```
╔═══════════════════════════════════════════════════════════╗
║   RSW Field App v73.142 - One-Click Installer                ║
╚═══════════════════════════════════════════════════════════╝

Choose your installation method:

  1) Docker (Recommended - Easiest)
  2) Direct Node.js (No Docker)
  3) Cancel

Enter choice [1-3]:
```

**Press `1` then Enter** for the easiest setup.

### Step 5 — Wait for Installation

The installer will:
- Install Docker (if not already installed)
- Build the application (~2-3 minutes first time)
- Start all services
- Show you the access URL

### Step 6 — Access the App

Open your browser and go to:

```
https://localhost:8050
```

> **Browser warning:** Your browser will show a security warning about the certificate.
> This is normal and safe — click **Advanced** → **Proceed to localhost** (or similar).

**Default login:**
- Email: `admin@inspection.com`
- Password: `admin123`

> ⚠️ **Change this password immediately** after first login in System → Users.

---

## Accessing From Phone or Tablet

Your phone must be on the **same WiFi network** as the computer running the app.

### Step 1 — Find Your Computer's IP Address

```bash
hostname -I
```

Example output: `192.168.1.105`

### Step 2 — Open on Phone

On your phone's browser, go to:

```
https://192.168.1.105:8050
```

> Accept the certificate warning on your phone the same way as on the computer.

### Step 3 — Add to Home Screen (optional but recommended)

**iPhone/iPad:** Tap Share → "Add to Home Screen"
**Android:** Tap the menu (⋮) → "Add to Home Screen" or "Install App"

The app will then work like a native app, including **offline**.

---

## Starting & Stopping

### Start the App

```bash
./start.sh
```

Or manually:
```bash
docker compose up -d
```

### Stop the App

```bash
./stop.sh
```

Or manually:
```bash
docker compose down
```

### View Live Logs

```bash
docker compose logs -f
```

Press `Ctrl+C` to stop watching logs.

### Restart the App

```bash
docker compose restart
```

---

## Installation on Other Systems

### Windows (with Docker Desktop)

1. Install [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/)
2. Open PowerShell in the app folder
3. Run:
   ```powershell
   docker compose up -d --build
   ```
4. Open `https://localhost:8050` in your browser

### macOS

1. Install [Docker Desktop for Mac](https://www.docker.com/products/docker-desktop/)
2. Open Terminal in the app folder
3. Run:
   ```bash
   chmod +x start.sh stop.sh
   ./start.sh
   ```

### Ubuntu / Debian

```bash
chmod +x install-linux-mint.sh
./install-linux-mint.sh
```

### Proxmox VMs / Linux Containers (LXC)

The app runs inside Docker, so it works in any Proxmox VM or LXC container that has Docker installed.

1. SSH into your VM/container
2. Copy the app folder to the VM
3. Install Docker:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
4. Run:
   ```bash
   docker compose up -d --build
   ```
5. Access via the VM's IP: `https://VM_IP:8050`

---

## Direct Node.js Installation (No Docker)

If you prefer not to use Docker:

### Requirements
- Node.js 18 or newer
- npm 9 or newer

### Install

```bash
# Install dependencies
npm install

# Build the app
npm run build

# Preview the built app
npm run preview
```

Then open `http://localhost:4173` in your browser.

> Note: The preview server is HTTP only (no HTTPS). GPS and camera may not work without HTTPS.

### Development Mode

```bash
npm run dev
```

Opens at `http://localhost:5173` with hot-reload.

---

## Updating the App

### With Docker

```bash
# Pull any new changes (if using git)
git pull

# Rebuild and restart
docker compose up -d --build
```

### Without Git

1. Download the new ZIP file
2. Extract it to the same folder (overwrite existing files)
3. Run:
   ```bash
   ./stop.sh
   ./start.sh
   ```

> **Your data is safe** — all inspection and sweeping data is stored in your browser's localStorage, not in the app files. It will not be affected by updates.

---

## Backup & Restore Your Data

### Export a Backup

1. Open the app
2. Go to **System → Backup & Sync**
3. Click **Export Backup**
4. Save the `.json` file somewhere safe

### Import a Backup

1. Open the app on any device
2. Go to **System → Backup & Sync**
3. Click **Import Backup**
4. Select your `.json` backup file

### Team Sync (Multi-Device)

For teams using multiple phones/tablets:

1. Set up the **RSW Sync Server** (see `host-server/` folder)
2. Go to **Backup & Sync → Sync Settings** on each device
3. Enter the sync server URL and shared token
4. Use **Push to Server** / **Pull from Server** to sync

---

## Permissions & sudo

Some commands require `sudo` (administrator) access:

```bash
# Install Docker (requires sudo)
sudo apt-get install docker-ce

# Add your user to docker group (so you don't need sudo every time)
sudo usermod -aG docker $USER

# After running the above, log out and log back in
# Then verify Docker works without sudo:
docker compose ps
```

---

## Troubleshooting

### "Permission denied" when running scripts

```bash
chmod +x start.sh stop.sh install-linux-mint.sh
```

### "Cannot connect to Docker" error

```bash
# Start Docker service
sudo systemctl start docker

# Make Docker start on boot
sudo systemctl enable docker

# Add yourself to docker group (then log out and back in)
sudo usermod -aG docker $USER
```

### App won't load in browser

```bash
# Check if container is running
docker compose ps

# Check logs for errors
docker compose logs rsw-app

# Restart the container
docker compose restart
```

### "Port 8050 already in use"

```bash
# Find what's using port 8050
sudo ss -tlnp | grep 8050

# Stop any conflicting service, then restart
./stop.sh
./start.sh
```

### Browser shows "Your connection is not private"

This is **normal and expected**. The app uses a self-signed SSL certificate (required for GPS and camera on mobile devices).

- **Chrome/Edge:** Click "Advanced" → "Proceed to localhost (unsafe)"
- **Firefox:** Click "Advanced" → "Accept the Risk and Continue"
- **Safari (iPhone):** Tap "Show Details" → "visit this website" → "Visit Website"

You only need to do this once per device.

### App is slow to load first time

The first build takes 2-5 minutes while Docker downloads Node.js and builds the app. Subsequent starts take only a few seconds.

### Data not saving

Check your browser's storage settings. The app stores data in localStorage. Make sure:
- You're not in Private/Incognito mode
- Browser storage is not set to "clear on close"
- You have enough free disk space

If storage is full, the app will show a red warning banner. Export a backup first, then delete old photos or inspections.

---

## File Structure

```
rsw-field-app-v51.0/
├── src/
│   ├── App.tsx                    ← Main app shell & routing (v51.0)
│   ├── store.tsx                  ← Data management & CRUD (v51.0)
│   ├── types.ts                   ← TypeScript type definitions
│   ├── main.tsx                   ← Entry point
│   ├── index.css                  ← Global styles
│   ├── utils/
│   │   ├── imageCompress.ts       ← Photo compression utility
│   │   ├── download.ts            ← File download helper
│   │   └── mapSnapshot.ts         ← Map screenshot utility
│   └── components/
│       ├── Dashboard.tsx          ← Dashboard (v51.0)
│       ├── Inspections.tsx        ← Inspections (v51.0)
│       ├── Maps.tsx               ← Inspection maps (v51.0)
│       ├── Reports.tsx            ← Inspection reports (v51.0)
│       ├── Categories.tsx         ← Inspection categories (v51.0)
│       ├── Clients.tsx            ← Inspection clients (v51.0)
│       ├── Users.tsx              ← User management (v51.0)
│       ├── Backup.tsx             ← Backup & sync (v51.0)
│       └── sweep/
│           ├── SweepJobs.tsx      ← Sweep jobs + areas (v51.0)
│           ├── SweepAreas.tsx     ← Areas & roads tab (v51.0)
│           ├── SweepMaps.tsx      ← Sweeping maps (v51.0)
│           ├── SweepReports.tsx   ← Sweep reports (v51.0)
│           ├── SweepCategories.tsx← Sweep categories (v51.0)
│           ├── SweepJobSites.tsx  ← Job sites (v51.0)
│           └── SweepClients.tsx   ← Sweep clients (v51.0)
│
├── host-server/                   ← Optional team sync server (v51.0)
│   ├── sync-server/server.js
│   ├── docker-compose.yml
│   ├── install-host.sh
│   ├── extract-roads.sh           ← Generates roads.geojson (v73.18+)
│   ├── restore-road-data.sh       ← Generated by install-host.sh (v73.24+)
│   ├── road-data-setup/README.md  ← Beginner setup/restore guide (v73.24+)
│   └── .env.example
│
├── public/
│   └── sw.js                      ← Service worker (offline support)
│
├── Dockerfile                     ← Multi-stage build (Node → Nginx)
├── docker-compose.yml             ← Service orchestration
├── nginx.conf                     ← HTTPS server config (port 8050)
├── install-linux-mint.sh          ← One-click Linux installer
├── start.sh                       ← Start the app
├── stop.sh                        ← Stop the app
├── .env.example                   ← Environment variable template
├── package.json                   ← Node.js dependencies
├── vite.config.ts                 ← Build configuration
└── README.md                      ← This file
```

---

## Version History

| Version | Changes |
|---|---|
| **v73.99** | **Reconciled a genuine two-way fork** — v73.83 forked into two independent real v73.84s in parallel sessions (Fork A: excluded-road-class server fix; Fork B: transit preview + a real Select Roads/Lasso draft-autosave feature), which then diverged further (Fork A → v73.85 raw-fallback visibility; Fork B's v73.86 attempted a Create Road data-loss fix on top of a *different* v73.84 that never actually had the draft-save code, so it correctly reported the draft feature as "never actually built" in that lineage). Merged both forks' real work into one build: server.js from Fork A/v73.85 (both server fixes intact), draft-save/transit-preview client feature from Fork B/v73.84 intact, and the Create Road remount fix re-applied against the REAL draft-save code this time — see `CHANGELOG.md` v73.99 for the full trace. |
| **v73.142** | **Fixed: a mandatory turnaround could silently drop coverage of the road beyond it** — v73.117's turnaround fix blocked every other edge at a turnaround node unconditionally, which is correct for an optional detour (T3) but wrong when that node is the *only* connection through to part of the selection (T1) — that coverage was silently lost, not deferred. Added cut-vertex detection so a turnaround on the only route through still gets its mandatory stop-and-reverse but no longer strands what's beyond it. See `CHANGELOG.md` v73.142. |
| **v73.117** | **Fixed: route traversal produced unnecessary repeated travel** — the greedy nearest-endpoint chainer couldn't recognise real intersections between selected road pieces, forcing avoidable backtracking on branching/looped selections. Now uses real graph pathfinding (Dijkstra with a reuse penalty) in Strict mode. See `CHANGELOG.md` v73.117. |
| **v73.110** | **Fixed: Add to Segment could pull in roads you never selected** — OSRM's snap and the real-road gap-fill both drew from the full OSM network, not your selection. New "🔒 Selected roads only" Strict mode (default ON) restricts generation to selected roads; added a "Segment needs rebuild" warning and full debug logging. See `CHANGELOG.md` v73.110. |
| **v73.109** | **Fixed: turnaround points visually looked like another route segment** — the "Turnaround Points (N)" panel sat directly under Route Segments, styled almost identically. Now collapsed by default behind a muted "Segment Controls" summary ("Turnarounds: N" + a "Manage Turnarounds" toggle); the full T1..Tn list only shows once explicitly expanded. See `CHANGELOG.md` v73.109. |
| **v73.108** | **Turnaround Points audit** — verified against Craig's spec that turnaround points can never be saved/rendered as route segments (they already lived in a separate array; added explicit `type` tag + `isTurnaroundPoint`/`isRouteSegment` guards and a save-time filter as belt-and-suspenders). See `CHANGELOG.md` v73.108. |
| **v73.100** | Added Turnaround Points — see `CHANGELOG.md` v73.100 for details. |
| **v73.81** | **Built the fix for excluded road classes appearing via OSRM** (root-caused in v73.80): `/api/roads/connect` and `/api/roads/match` now check OSRM's output against the same road-class filters used elsewhere and reject/fall back when a route runs through a class you don't have "include" checked. Include checkboxes are now wired through Snap to Roads, gap-fill, and Add to Segment auto-snap, with a rejection count shown in the status message. See `CHANGELOG.md` v73.81. |
| **v73.80** | **Fixed: Lasso/Box fence could select hundreds of roads with no warning** — a mis-closed or oversized fence in Select Roads mode silently selected/deselected everything inside it; now confirms first above 60 roads. Also fixed two toolbar buttons both being labelled "Select" (renamed to "Draw Fence"), made the A/B confirm dialog's Cancel button look like a real button, and renamed "Reverse it" to "Change Location". Root-caused (fixed in v73.81) a separate issue where excluded road classes (service roads etc.) can still appear via OSRM snap/match, since those filters were never passed to OSRM. See `CHANGELOG.md` v73.80. |
| **v73.79** | **Fixed: map panning stuck right after Snap to Roads** — OSRM's dense post-snap markers left almost no empty map space to grab, so a click near the route was very likely grabbing a point instead of panning; shrunk the dense-marker hit-radius and added a "🔓 Clear Any Locks" one-click recovery button. Also re-applied a v73.76 Ctrl+drag panning fix that had gone missing from this branch, and re-fixed several doc/version banners that had silently reverted to a much older state (v73.55/v73.63/v73.68) during an earlier session's file recovery. See `CHANGELOG.md` v73.79. |
| **v73.77** | **OSRM snap made mandatory (not silent best-effort) on ✓ Add to Segment** — any failure (no sync server, no OSRM match, OSRM unreachable) now shows a specific confirm dialog naming the reason and warning that proceeding uses the road-data chain, instead of silently falling back to it. Also fixed a ~40-minute app-rebuild slowdown and added undo coverage for ✓ Add to Segment. See `CHANGELOG.md` v73.77. |
| **v73.76** | **Doc/version audit + build-context fix** — fixed app rebuilds taking ~40 minutes (`.dockerignore` never excluded `host-server/`, so every app build was transferring the ~1.5GB OSRM road graph to Docker even though the app doesn't use it). Also caught the root `Dockerfile`'s version label stuck at v73.63 and this README's/`INSTALL-GUIDE.md`'s title banners stuck at v73.55 — both missed across many releases, now part of the standing version-bump checklist. Full documentation pass across `CHANGELOG.md` ×2, `CLAUDE_CONTEXT.md`, `INSTALL-GUIDE.md`, `OSRM_SETUP_GUIDE.md`, and `.claude/skills/`. |
| **v73.71–v73.75** | **Driver role, zone-highlight refinement, Select Roads workflow** — new restricted "Driver / Inspector" login (Sweeping Maps + full Inspections + Backup & Sync only, route-guarded). Zone-highlight band split by page (Sweeping Maps: band only, no line; Sweep Jobs: line only, no band) per Craig's own reference screenshot, after an earlier version's band-plus-opaque-line combo still buried the road name. New "Add as Transit" toggle in Select Roads mode. Snap to Roads now runs automatically (silent, best-effort) on "✓ Add to Segment" instead of a separate manual step. Fixed lasso-fence right-click delete (was left-click only). Fixed map zoom being too coarse per click/scroll step (zoomSnap/zoomDelta 1→0.25 across all 9 map instances). A separate parallel session's Canvas-rendered `CircleMarker` freeze fix and the original zone-highlight feature were reconciled back into the main line here too. See `CHANGELOG.md` v73.71–v73.75 for full detail per change. |
| **v73.12–v73.29** | **Select Roads / Lasso / Box / Deselect / Zones + Draw Points bulk-delete** — see feature list above and `CHANGELOG.md` for full per-release detail. Summary of the whole arc: Edit Road gained a second way to build a route (pick real road geometry instead of clicking every point), with click, freeform Lasso (editable, add points after the fact), and 2-corner Box selection styles, each usable in Select or Deselect mode, a "🚩 Set Start Point" tool for dead-end roads where direction matters, plus a Ctrl+drag rubber-band box and a "🅿️ Include car parks/driveways" toggle (off by default — footpaths/cycleways are never offered either way). The original Draw Points method gained its own bulk tools: click-to-stage points/lines (or Ctrl+drag a box) for one-shot delete or Transit/Solid conversion (a real two-way toggle), a one-step Undo for each bulk action, a right-click menu with confirmed delete, and a "🔍 Find Long Jumps" auto-detector for the greedy road-merge algorithm's known edge case. Select-Roads-derived lines get a small perpendicular offset so they no longer sit dead-center on the street-name label, and staged/pending-delete highlights get a white halo so they're visible even on a same-coloured road. Areas & Roads also gained **Zones** — drawable polygons for car parks/business sites/general areas, tracking area (m²/ha) instead of distance, never counted in sweep km. A real data-integrity bug (segment ids regenerating on every save, causing duplicate segments) was found and fixed along the way. Needs a one-time optional server-side data file for Select Roads — see `host-server/road-data-setup/README.md`. |
| **v53.10** | Backup & Sync: added Selective Restore for local app (choose which sections to restore from a backup file, with Merge or Replace mode); added Selective Restore to Server (choose sections to push to host server); Full Restore to Server now shows a confirm dialog before overwriting. |
| **v53.9** | Inspections/Clients: replaced modal popup with inline card form (matching Sweep Clients layout); added All/Active/Inactive filter tabs with live counts. Sweep Clients: added Active/Inactive toggle to form and All/Active/Inactive filter tabs with live counts. |
| **v53.8** | Areas & Roads: fixed Edit Road modal reverting to small size when clicked or dragged — modal now stays full-screen (98vw × 96vh) at all times, centred via CSS transform, drag only moves position not size. |
| **v53.7** | Maps: inspection map height now fills the full viewport (calc 100vh). Areas & Roads: Edit Road modal opens full-screen by default (98vw × 96vh); still draggable/resizable. |
| **v53.6** | Inspections: added All Jobs / Draft / In Progress / Completed status filter tabs (matching Sweep Jobs UX); Edit Inspection sidebar updated with Status toggle buttons (Draft / In Progress / Completed) and cleaner Save Changes / Save & Complete actions. |
| **v52.0** | Bug fix: per-segment colours now saved for single-segment roads (always-save segments); photo timestamps shown in reports; new 🗺️ Route Map tab in sweep job editor shows all selected roads with segment colours on full-screen OSM map. |
| v51.0     | Per-segment colours shown on background map after Save; road modal draggable; server backup normalises segment colour fields. |
| v15     | Merged v11.9 (Inspections) + v12.2 (Road Sweeping) + v14 (App Shell). Full multi-section app with separate layouts per section. |
| v14     | App shell, branding, Dashboard, Users, Backup & Sync |
| v12.2   | Road Sweeping section (Jobs, Areas, Maps, Reports, Categories, Sites, Clients) |
| v11.9   | Site & Road Inspections section (Inspections, Maps, Reports, Categories, Clients) |

---

## Support

If you encounter issues:

1. Run the diagnostics script:
   ```bash
   ./diagnose.sh
   ```

2. Check the logs:
   ```bash
   docker compose logs rsw-app
   ```

3. Export your data before doing anything else:
   - Open the app → System → Backup & Sync → Export Backup

---

*RSW Field App v73.142 — Road & Stormwater · Inspection & Sweeping*
