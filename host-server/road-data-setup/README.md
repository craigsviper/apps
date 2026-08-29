# Road Data Setup — Select Roads / Lasso / Box / Deselect Modes

This is a **one-time, optional** step. Everything else in the app — including
Draw Points (the original click-to-draw way of building a route, plus its own
bulk-delete staging, Ctrl+drag box, Find Long Jumps, etc.) — works completely
fine without ever doing this.

**What this actually is:** Areas & Roads → Edit Road has a faster way to build
a route called **"Select Roads"** — instead of clicking every point by hand,
you click roads, drag a Lasso or Box fence around a zone, or use Deselect mode
to pull unwanted roads (car parks, driveways, service lanes, etc.) back out —
and it builds the route from real road geometry automatically. To do any of
that, your host-server needs a copy of the real road network for your area, in
a file called `roads.geojson`. This guide is about getting that one file in
place.

**Why isn't this automatic?** `roads.geojson` is a downloaded/derived dataset
(from OpenStreetMap), not something your crews create — so it's deliberately
kept separate from your actual app data (`rsw-data.json`), and it is **not**
included in `backup-data.sh` or the app's own Backup & Sync. That's not a bug
— see "Why doesn't my regular backup cover this?" near the bottom.

There are two situations covered below. Find the one that matches you:

- **[A — Brand new host-server, never had this set up before](#a--brand-new-host-server)**
- **[B — Rebuilt/replaced/restored a host-server that HAD this working before](#b--restoring-on-a-rebuilt-or-replaced-host-server)**

**Already have `roads.geojson` loaded and just want to refresh it?** See
**[C — One-click refresh from the dashboard](#c--one-click-refresh-from-the-dashboard-v7356)**
below instead — it's faster than re-running `extract-roads.sh` for the common
case of "the map's changed a bit since I last did this."

---

## A — Brand new host-server

You've just installed the host-server for the first time (or Select Roads
mode has never worked for you yet). Follow these in order.

### Step 1 — Check if you actually need to do this

Open the app, go to **Areas & Roads → Edit Road**, and click the
**"Select Roads"** button (top-right of the map). If roads show up on the
map when you pan around, you're already done — stop here. If it says
something like *"no road data on server yet"*, continue to Step 2.

### Step 2 — Generate the road data file

You need a computer with **internet access** and a program called
`osmium-tool` installed. This does **not** need to be your host-server — any
laptop or the host-server itself both work, as long as it has internet.

```bash
sudo apt install osmium-tool
```

(If you're not on Ubuntu/Debian/Linux Mint, see the comment at the top of
`extract-roads.sh` for the Mac/other-OS install command.)

Now open `extract-roads.sh` (it's inside **`host-server/`** — this same
folder) in a text editor, and find this line near the top:

```bash
BBOX="175.15,-37.85,175.35,-37.70"
```

Change those four numbers to cover the area your crews actually work in.
Easiest way to get the right numbers:

1. Go to **https://boundingbox.klokantech.com/** in a browser.
2. Drag the box on the map until it covers your whole operating area
   (a bit generous is fine — you can't select a road that isn't in the box).
3. Find the **"CSV"** option on that page and copy those 4 numbers — they're
   already in the exact order this script wants.
4. Paste them in place of the example numbers above. Save the file.

Now run it, from inside `host-server/`:

```bash
cd host-server
./extract-roads.sh
```

This will:
- Download a New Zealand map file (~380MB, takes a few minutes — only
  happens once, it's kept for next time)
- Filter it down to just real drivable roads for your area (footpaths,
  cycleways, and similar are never included; car parks/driveways/business
  service lanes ARE included, tagged separately — see "About car parks and
  driveways" below)
- Produce a file called **`roads.geojson`** — this is the file you actually
  need, everything else was just steps to get here

When it finishes, it prints the exact path to `roads.geojson`. Keep that
path handy for the next step.

### Step 3 — Load it into your host-server

If you generated the file on a *different* computer than your host-server,
copy it over first:

```bash
scp /path/to/roads.geojson  <your-username>@<host-server-ip>:~/roads.geojson
```

Then, **on the host-server**, from inside the `host-server` folder:

```bash
./restore-road-data.sh ~/roads.geojson
```

(Swap `~/roads.geojson` for wherever the file actually is if it's somewhere
else.)

This one script copies the file in AND tells the server to start using it —
no restart, no extra steps. It'll print a confirmation when it's done.

### Step 4 — Check it worked

Go back to the app, **Areas & Roads → Edit Road → Select Roads**, pan around
the map — real roads should now appear as thin grey lines you can click.

**Done!** Skip section B below, it's not for you.

---

## B — Restoring on a rebuilt or replaced host-server

Select Roads mode was working before, but you've since rebuilt, replaced, or
migrated your host-server (new machine, fresh Docker volume, restored from a
backup, etc.) and now it's showing no road data again. This is **expected**
— `roads.geojson` genuinely isn't part of your regular backups (see below)
— and it's a quick fix.

### If you kept a copy of `roads.geojson` somewhere safe

(See the tip at the bottom of this guide — if you followed it, you'll have
one.) Just run, from inside the `host-server` folder:

```bash
./restore-road-data.sh /path/to/your/saved/roads.geojson
```

Done — no need to regenerate anything.

### If you don't have a saved copy

No problem, it's fully reproducible — just follow **Section A above from
Step 2 onward** (Step 1 doesn't apply since you already know you need this).
Since it's derived from public map data, regenerating it gives you the same
result as before, it just takes a few minutes for the download.

---

## C — One-click refresh from the dashboard (v73.56+)

Once you've done Section A at least once (so there's already a `roads.geojson`
loaded), you can refresh it later — e.g. OpenStreetMap has since added a new
subdivision's streets — without repeating the whole `extract-roads.sh`
process, straight from the dashboard:

1. In `host-server/.env`, set `ROADS_BBOX` to the same four numbers you used
   in `extract-roads.sh`'s `BBOX` (same order: min longitude, min latitude,
   max longitude, max latitude). Restart the container once after adding this.
2. Open the dashboard → **Health**, find the **"Road Data (Select Roads)"**
   card, and click **"🗺️ Update Road Data (OSM)"**.
3. That's it — it fetches fresh road geometry for your area directly from
   OpenStreetMap's Overpass API and reloads it, no download/copy/reload steps.
   The card shows when it last ran and whether it succeeded.

This talks to a free, public Overpass server, so it can occasionally be slow
or briefly unavailable at busy times — if the button reports an error, wait a
bit and try again, or fall back to Section A/B's `extract-roads.sh` method,
which doesn't depend on any public server once you've downloaded the country
file once. The previous `roads.geojson` is automatically kept as a `.bak`
before each refresh, so a bad or partial fetch can't leave you without roads.

---

## About car parks and driveways

By default, Select Roads/Lasso/Box only offer ordinary drivable roads — car
parks, driveways, and business service lanes are hidden unless you turn on
the **"🅿️ Include car parks/driveways"** toggle in the Select Roads toolbar.
That's a per-session toggle in the app itself — nothing to configure here in
`roads.geojson` or on the server. Footpaths, cycleways, and similar are never
offered either way, toggle or not; nobody sweeps a footpath.

## Keep a copy for next time (recommended, saves you re-running the script later)

Once you have a working `roads.geojson`, copy it somewhere you keep other
important files — a personal backups folder, a USB drive, cloud storage,
wherever you'd keep something you don't want to have to regenerate:

```bash
docker cp rsw-sync:/data/roads.geojson ~/rsw-road-data-backup/roads.geojson
```

Next time you rebuild or replace your host-server, you can skip straight to
`./restore-road-data.sh` with this saved file instead of re-running
`extract-roads.sh` and waiting on the download again.

---

## Why doesn't my regular backup cover this?

`backup-data.sh` (and the app's own Backup & Sync) only back up
**`rsw-data.json`** — your actual data: clients, jobs, roads your crews have
actually drawn, inspections, everything you or your team created. That's the
important, irreplaceable stuff, and it's fully covered.

`roads.geojson` is different — it's a big reference file downloaded from
OpenStreetMap, not something anyone typed in. Bundling a multi-megabyte
downloaded file into every single backup would make your backups bigger and
slower for no real benefit, since it's just as easy to regenerate on the rare
occasion you need to. That's why it gets this one separate, optional guide
instead of being silently included everywhere.

**The important part either way:** none of your actual swept routes, jobs,
or other data are at risk here. The absolute worst case if this file goes
missing is that Select Roads mode has nothing to show until you redo this
one step — Draw Points (and everything else in the app) is completely
unaffected.
