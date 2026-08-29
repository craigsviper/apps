# RSW Field App — Android

A thin native Android shell (Kotlin) around the exact same web app built in the rest of this
repo. The app is bundled directly into the APK — no server hosting required for the app itself,
though it still needs the host-server (or a network reachable one) for sync/backup.

## What this is (and isn't)

- **Is:** a `WebView`-based wrapper. All the actual functionality — inspections, sweeping,
  maps, reports, IndexedDB storage — is the same React/TS code as the browser version, built
  once with `npm run build` and copied directly into `app/src/main/assets/` (NOT a subfolder —
  see the note in "Updating the app" below for why that matters).
- **Isn't:** a Play Store app. It's built as a debug-signed APK for direct install/sideloading
  via GitHub Releases, per your own request. If you want it on the Play Store later, that needs
  a proper release keystore and a separate signing setup — ask if you want that added.

## One-time device setup after installing

1. **Install the APK** (see "Getting the APK" below), then open it once. Android will ask for
   camera and location permission the first time each is used — allow both.
2. **Trust the sync server's certificate.** The host-server uses a self-signed HTTPS cert (see
   root `CLAUDE_CONTEXT.md`). Android's WebView won't trust it by default. On the phone:
   Settings → Security → Encryption & credentials → Install a certificate → CA certificate →
   pick the `.pem`/`.crt` file (get it from the server's `/cert` page, same as the desktop
   setup flow already described inside the app's own Backup & Sync page).
   Until you do this, sync/backup calls to the host server will fail with a certificate error
   (the app will show a toast explaining this) even though the app itself works fine offline.
3. **Enter your sync server URL** the same way you would in the browser version — Backup & Sync
   → Sync Settings → paste `https://<office-computer-ip>:8055`.

## Getting the APK

**Recommended going forward: build directly in Android Studio with your phone on USB
(see below) rather than GitHub Actions.** GitHub Actions is still useful for keeping a backup
of the source and its build history, but the direct-USB route is faster and has been far more
reliable in practice.

### Option A — Android Studio + USB (recommended)

1. On your phone: Settings -> About phone -> tap "Build number" 7 times to enable Developer
   Options, then Settings -> Developer Options -> turn on "USB debugging".
2. Plug the phone into the computer with a USB cable. Allow the "Allow USB debugging?" prompt
   on the phone if it appears.
3. Open the `android/` folder in Android Studio (File -> Open).
4. Wait for Gradle sync to finish (bottom status bar). If it shows errors, see the
   troubleshooting list under Option C below.
5. Your phone's name should appear in the device dropdown near the Run (green triangle) button
   at the top. Select it, then click Run.
6. Android Studio builds and installs the app directly onto the phone - no APK download, no
   GitHub, no waiting on CI. This is the fastest way to test every change.

Every time you get a new fix from Claude: replace the relevant folder(s) in your existing
project directory (see "Updating the app" below), let Android Studio re-sync, then just click
Run again with the phone connected.

### Option B — GitHub Releases (still available, mainly for backup/history)

1. Push this repo to your own GitHub account (if you haven't already) - `./update-github.sh`
   handles this, or see the manual git commands further down.
2. Tag a version and push the tag:
   ```bash
   git tag v73.142
   git push origin v73.142
   ```
3. Check the repo's **Releases** page for the attached `app-debug.apk`.

### Option C — Build locally with Android Studio (no phone/USB, just producing an APK file)

1. Install [Android Studio](https://developer.android.com/studio) on any computer (doesn't need
   to be the field-app host machine).
2. File → Open → select the `android/` folder in this repo.
3. The Gradle wrapper (`gradlew`, `gradlew.bat`, `gradle/wrapper/gradle-wrapper.jar`) is
   committed, so Android Studio should sync immediately without needing to generate anything —
   it downloads Gradle 8.9 itself on first sync if it isn't already cached locally.
4. Build → Build APK(s), or just click Run with a phone connected via USB (enable Developer
   Options → USB debugging on the phone first).

**If Android Studio still reports a wall of errors on first open**, it's almost always one of
these, in order of likelihood — check the "Build" panel at the bottom of the window for the
actual message rather than going by the red squiggles in the editor, since a failed/incomplete
Gradle sync makes every single file show unresolved-reference errors, which looks like "lots of
errors" but is really one root cause:
- **Gradle sync didn't finish/failed.** Click "Try Again" / "Sync Project with Gradle Files" and
  read the Build panel's actual error message.
- **Missing SDK components** — Android Studio will normally prompt "Install missing platform(s)
  and sync" when it needs compileSdk 34/API 34; let it install them.
- **JDK mismatch** — this project needs JDK 17. Check File → Project Structure → SDK Location →
  Gradle JDK; if it's pointed at something older, sync will fail. Set it to "Embedded JDK" (the
  one bundled with Android Studio) or any JDK 17+.
- **No internet access on first sync** — the very first sync needs to download Gradle 8.9
  itself plus all the `androidx`/Kotlin dependencies from Google's and Maven Central's servers;
  it can't build offline until those are cached once.

## Updating the app

Claude delivers each fix as a full project zip (`RSW-Field-App-vXX.XXX.zip`) — everything
(web app source, `android/` project, assets already refreshed and version bumped) is already
done for you inside that zip. Updating is just replacing files in your existing project folder:

```bash
cd ~/Downloads && unzip RSW-Field-App-vXX.XXX.zip     # use the actual filename Claude gave you
rm -rf ~/RSW-Field-App-v73.127/android                 # use your actual project folder name
cp -r ~/Downloads/RSW-Field-App-vXX.XXX/android ~/RSW-Field-App-v73.127/
```

**Always fully delete and replace the `android/` folder (`rm -rf` then `cp`), never just copy
files on top of the existing folder.** Overlaying can leave old, stale files behind alongside
the new ones (this caused real bugs before — a leftover `assets/www/` subfolder sitting next to
the new `assets/` root files, from an old release, confusing which files the app actually used).

Then, with the project already open in Android Studio (see "Getting the APK" -> Option A above):
Android Studio will detect the files changed and may prompt to re-sync Gradle — let it, then
click Run with your phone connected. No GitHub round-trip needed at all for this.

If you'd rather push to GitHub as well (recommended occasionally, as a backup — not required for
building), run `./update-github.sh` from the repo root afterward.

### Why the build output goes into `assets/`, not `assets/www/`

Some of the app's own asset references (Leaflet's marker icons, notably) are root-absolute paths
like `/leaflet/marker-icon.png`, which `WebViewAssetLoader` resolves against the domain root
(`https://appassets.androidplatform.net/...`) — if the files were nested inside a subfolder,
those absolute paths wouldn't line up with where the files actually are, and the app would fail
to load at all (`net::ERR_INVALID_RESPONSE` on `index.html`). This was a real bug in an earlier
release (see `CHANGELOG.md` v73.129) — Claude's delivered zips already handle this correctly;
just don't manually nest anything under a subfolder when updating by hand.

## Architecture notes (for future changes)

- **`MainActivity.kt`** is the entire native layer. It uses `androidx.webkit.WebViewAssetLoader`
  to serve `assets/` under a virtual `https://appassets.androidplatform.net/` origin rather
  than `file://` — this matters because `file://` origins can break or fail to persist
  IndexedDB in some WebView versions, which would be a serious problem for an app whose entire
  offline-first design depends on IndexedDB actually persisting.
- Camera/photo capture goes through `WebChromeClient.onShowFileChooser` — the web app's
  `capture="environment"` file inputs get routed to a real camera intent (with a gallery
  fallback baked into the same chooser); the plain multi-select "Add Photos" button goes
  straight to the system gallery/document picker (which itself still offers "Camera" as an
  option) — see `MainActivity.kt`'s `launchImageChooser()` vs `launchGalleryChooser()`.
- GPS permission is requested lazily the first time the web app calls
  `navigator.geolocation.*`, via `WebChromeClient.onGeolocationPermissionsShowPrompt`.
- The Android back button navigates the WebView's own history first (e.g. out of an
  inspection form back to the list) before falling back to closing the app.
- `sw.js` (the browser PWA's service worker) is deliberately excluded from the bundled assets —
  it has nothing to do inside a WebView shell where every asset is already local, and the app's
  own registration call is already wrapped in `.catch()` so this fails silently and harmlessly
  (verified against `index.html`/`Backup.tsx`, same pattern as normal browser dev mode).
