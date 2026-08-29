---
name: rsw-field-app-release
description: Use this skill for ANY change to Craig's RSW Field App project (React/TypeScript/Vite PWA + Node.js host-server, distributed as versioned zips like RSW-Field-App_vXX_X_description.zip). Trigger on any code fix, feature, or version bump in this codebase — before editing files, before packaging a zip, and before touching RSW-Update-and-Install-Guide.docx. Covers: the mandatory rule that any new app field/collection must have its host-server sync-merge handling checked/updated in the same change (this project's most common recurring bug is silent data loss from exactly this being skipped), the exact version-bump checklist (6+ files, easy to miss one), the mandatory pre-package verification commands, a docx same-path read/write corruption bug to never repeat, and zip packaging/naming conventions. Also read CLAUDE_CONTEXT.md and both CHANGELOG.md files in the project itself first — this skill is the *procedural* checklist, CLAUDE_CONTEXT.md is the *project-specific* history/architecture knowledge.
---

# RSW Field App — Release Workflow

Procedural checklist for any change to this project. Always read `CLAUDE_CONTEXT.md`,
`CHANGELOG.md`, and `host-server/CHANGELOG.md` from the zip itself first — this skill
covers *how to ship a change safely*, not what the app does.

## 0. MANDATORY: app changes and host-server sync are not separate changes

**Any new field on a record, or any new collection added to `AppData`, must have its
host-server merge handling checked and updated in the SAME change.** Do not treat
"add the app feature" and "make sure the server can sync it" as two separate tasks
where the second one is optional or can wait. If `server.js`'s `mergeData()` doesn't
know a nested array (photos, pins, roads, tipRuns, segmentSettings, etc.) needs an
id-based union merge, the very next sync between two devices can silently overwrite
one device's data with the other's — no error, nothing — and that has been this
project's single most common category of real bug (see `CLAUDE_CONTEXT.md`'s
top warning banner and Recent History for the running list of times this exact
mistake has already happened). Before considering any feature/field addition done:
- grep `mergeData()` in `server.js` for the collection you touched
- confirm any nested array on the new/changed field has its own id-merge, not just
  a whole-record field-union
- if it's a brand-new top-level collection, confirm it's in `ALL_COLLECTIONS`
  (server) and `ALL_INSPECTION_KEYS`/`ALL_SWEEP_KEYS` + `mergeServerDataIntoLocal()`
  (app), not just relying on the generic unknown-key fallback

## 1. Version bump — every one of these, every release

Missing even one causes real bugs (stale service worker cache serving old JS, docker
label mismatches, etc). Grep for the old version string across the whole repo at the
end to confirm none were missed — don't just trust the list below, it has been
incomplete before.

| File | What to change |
|---|---|
| `package.json` | `"version"` |
| `host-server/sync-server/package.json` | `"version"` |
| `host-server/sync-server/server.js` | `APP_SCHEMA_VERSION` const |
| `public/sw.js` | `CACHE_NAME` const |
| `docker-compose.yml` | `com.rsw.version=` label + any `vXX.X` text in header comments/descriptions |
| `host-server/docker-compose.yml` | same as above |
| `Dockerfile` | `LABEL version=` + the `vXX.X` in the header comment block — **found stuck at v73.63 for 12+ releases as of v73.76, missed every time because it's not the OLD version string the standard grep below catches** |
| `README.md` | any `vXX.X` text, **especially the title-line banner (`# RSW Field App vXX.X`) — found stuck at v73.55 for even longer than the Dockerfile, same reason: several releases further behind than what any single-release grep catches** |
| `INSTALL-GUIDE.md` | same as README.md, same title-banner gotcha |
| `RSW-Update-and-Install-Guide.docx` | version string in the title block — see §3, do NOT hand-edit like a text file |
| `guides/README.md`, `guides/INSTALL-GUIDE.md`, `guides/ROAD-DATA-SETUP-README.md`, `guides/OSRM_SETUP_GUIDE.md` | Craig's `guides/` folder holds synced COPIES of the canonical files (`README.md`, `INSTALL-GUIDE.md`, `host-server/road-data-setup/README.md`, `host-server/OSRM_SETUP_GUIDE.md` respectively — see `guides/00-START-HERE.md` for the full mapping). Re-copy after editing any canonical doc, in the same change — don't let the two drift apart. `guides/00-START-HERE.md` and `guides/RSW-Update-and-Install-Guide.docx` only need touching if the guide LIST itself changes (a new guide added/removed), not on every routine doc edit. |

Verify nothing was missed:
```bash
grep -rn "vOLD\.VERSION" --include="*.json" --include="*.js" --include="*.yml" --include="*.md" . | grep -v node_modules
```
**That grep alone is not enough** — it only catches the version you're bumping FROM, not something several releases further behind that every prior release also forgot to touch (exactly how Dockerfile/README/INSTALL-GUIDE went stale for a dozen+ releases without ever showing up as a diff). Also explicitly check the CURRENT top-of-file version banner in `README.md`, `INSTALL-GUIDE.md`, and the header comment + `LABEL version=` in `Dockerfile` against the version you're releasing, every single release, not just when they happen to differ from last time.

## 1a. Build-context hygiene — check before adding any new data directory

v73.76: app rebuilds were taking ~40 minutes because `.dockerignore` never excluded `host-server/`, and `host-server/osrm-data` (the OSRM road graph, ~1-1.5GB) sat inside the same folder tree Docker scans for the app's build context — every app image build was transferring that entire dataset to the Docker daemon for no reason. Any time a new directory is added under the project root that holds real data volume (extracted map data, downloaded assets, build caches, etc.) — check whether it needs to be added to `.dockerignore` (for the relevant image) in the SAME change that adds it, not discovered later via a slow build.


## 2. Mandatory verification before packaging — every release, no exceptions

```bash
npx tsc --noEmit          # must be clean
npx vite build             # must be clean
node --check host-server/sync-server/server.js   # must be clean
```

If the change touches `server.js`'s dashboard HTML (anything inside a `res.send(...)`
template literal containing inline `<script>`), that inline JS is invisible to
`node --check` — it's just a string to Node. Extract it and check separately:
```bash
node -e "
const fs = require('fs');
const src = fs.readFileSync('host-server/sync-server/server.js', 'utf8');
// isolate the relevant res.send template literal manually, then:
"
# or simpler: write the extracted <script>...</script> body to a .js file and run
# `node --check` on that file directly. This has caught real syntax errors before
# (see CHANGELOG.md's v73.1 hotfix entry) that node --check on server.js alone missed.
```

For anything claiming to fix rendering/visual behavior, do a *real* check, not just a
syntax check — install `nginx`/render with `soffice`/use Playwright if network allows,
rather than asserting it works from code review alone. If a real render test genuinely
can't be done (e.g. sandbox network restrictions blocking a browser binary download),
say so explicitly in the changelog rather than implying it was tested. See
`CHANGELOG.md`'s v73.2 entry for the right way to word that kind of honest gap.

## 3. Editing `RSW-Update-and-Install-Guide.docx` — never read+write the same path

**A .docx is a zip file.** `zipfile.ZipFile(path, 'w')` truncates the file the instant
it opens, even before you've read anything from it. Opening the *same path* for read
and write in the same script — even if the read happens first in your code — is a race
that has actually corrupted this file before (empty 22-byte zip, unrecoverable, had to
restore from a prior version's copy). **Always** write to a different path, then move:

```python
import zipfile, shutil

src = zipfile.ZipFile('RSW-Update-and-Install-Guide.docx')   # read from the real file
xml = src.read('word/document.xml').decode('utf-8')
new_xml = xml.replace('RSW Field App vOLD', 'RSW Field App vNEW')
assert new_xml != xml, 'no replacement made — check the exact old string first'

out_path = '/tmp/guide-new.docx'                              # NEVER the same path as src
out = zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED)
for item in src.namelist():
    data = new_xml.encode('utf-8') if item == 'word/document.xml' else src.read(item)
    out.writestr(item, data)
out.close()
src.close()
shutil.move(out_path, 'RSW-Update-and-Install-Guide.docx')    # only overwrite after the new one is complete
```

After any docx edit, always render-verify before packaging:
```bash
python /mnt/skills/public/docx/scripts/office/soffice.py --headless --convert-to pdf RSW-Update-and-Install-Guide.docx --outdir /tmp/docxcheck
pdftotext /tmp/docxcheck/RSW-Update-and-Install-Guide.pdf - | grep "vNEW"   # confirms both render success AND the right text landed
```

If the docx needs more than a version-string swap (real content changes, new sections),
don't try to hand-patch the XML — read `/mnt/skills/public/docx/SKILL.md` and rebuild
it properly (see this project's own `CHANGELOG.md` for the full-rebuild precedent when
the doc was badly out of date).

## 4. Packaging the zip

```bash
cd /path/to/app   # parent dir containing app_pkg/
OUT=/mnt/user-data/outputs/RSW-Field-App_vXX_X_short-description.zip
rm -f "$OUT"
zip -r -q "$OUT" app_pkg -x "app_pkg/node_modules/*" -x "*/node_modules/*" -x "app_pkg/dist/*"
unzip -l "$OUT" | grep -c node_modules   # must print 0
```

**Filename convention:** `RSW-Field-App_vXX_X_short-hyphenated-description.zip` —
underscores between version parts, hyphens in the description, matching the pattern
Craig's own uploads use (e.g. `RSW-Field-App_v73_1_hotfix-dashboard-js-syntax-error.zip`).

**Sanity-check file count** against the zip Craig most recently uploaded (if any is in
context) — should match exactly, or be exactly N higher/lower if you deliberately
added/removed N files. An unexplained file-count delta usually means something got
left out of the `-x` excludes or a stray temp file got swept in.

## 5. Update the paper trail — every release

Three files, every time, even for a version-string-only bump:
- `CHANGELOG.md` (app) — new `## vXX.X — YYYY-MM-DD` entry at the top, above the previous one
- `host-server/CHANGELOG.md` — same, even if it's just "no server changes, version bumped to keep strings in step"
- `CLAUDE_CONTEXT.md` — bump the version table (~5 rows near the top), add one row to the "Recent History" table, and update any "Key Files" rows whose behavior changed this release

Changelog entries in this project are written in full prose explaining root cause and
fix, not one-line bullet points — match the existing entries' depth, they're the
project's institutional memory across sessions that don't share context.
