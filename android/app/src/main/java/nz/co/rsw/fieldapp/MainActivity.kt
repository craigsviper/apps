package nz.co.rsw.fieldapp

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.StatFs
import android.util.Log
import android.view.KeyEvent
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.webkit.WebViewAssetLoader
import java.io.File

/**
 * RSW Field App - native Android shell.
 *
 * This is deliberately thin: the whole app (React/TS/Tailwind, IndexedDB storage, the sync
 * client, etc.) lives in assets/index.html exactly as built by `vite build` on the web
 * side - see CLAUDE_CONTEXT.md for that half of the project. This Activity's only job is to
 * host it in a WebView and wire up the handful of things a web page can't do for itself on
 * Android: camera/gallery photo capture, GPS permission plumbing, and the back button.
 *
 * WHY WebViewAssetLoader INSTEAD OF file:// - loading index.html directly via file:// gives
 * the page an "opaque"/unique origin in Chromium's storage model, and IndexedDB/localStorage
 * either fail outright or don't reliably persist across app restarts on some WebView versions.
 * WebViewAssetLoader serves the SAME bundled files under a stable virtual
 * https://appassets.androidplatform.net/... origin instead, so storage behaves exactly like it
 * does in a real browser tab - which matters a lot here since the whole offline-first design
 * depends on IndexedDB actually persisting.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader

    // -- file chooser (camera / gallery) state --
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var cameraPhotoUri: Uri? = null

    // -- geolocation permission state --
    private var pendingGeoOrigin: String? = null
    private var pendingGeoCallback: GeolocationPermissions.Callback? = null

    private val requestLocationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        requestedPermissions.add(Manifest.permission.ACCESS_FINE_LOCATION)
        val origin = pendingGeoOrigin
        val callback = pendingGeoCallback
        pendingGeoOrigin = null
        pendingGeoCallback = null
        if (origin != null && callback != null) {
            callback.invoke(origin, granted, false)
        }
    }

    private val requestCameraPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        requestedPermissions.add(Manifest.permission.CAMERA)
        if (granted) launchImageChooser() else cancelFileChooser()
    }

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback
        filePathCallback = null
        if (callback == null) return@registerForActivityResult

        if (result.resultCode != RESULT_OK) {
            callback.onReceiveValue(null)
            return@registerForActivityResult
        }

        val data = result.data
        val resultUris: Array<Uri>? = when {
            // Gallery/document picker returned one or more images.
            data?.clipData != null -> {
                val clip = data.clipData!!
                Array(clip.itemCount) { i -> clip.getItemAt(i).uri }
            }
            data?.data != null -> arrayOf(data.data!!)
            // No data at all - the camera intent writes straight to cameraPhotoUri, no
            // result data is returned for that path.
            cameraPhotoUri != null -> arrayOf(cameraPhotoUri!!)
            else -> null
        }
        callback.onReceiveValue(resultUris)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        assetLoader = WebViewAssetLoader.Builder()
            .setDomain("appassets.androidplatform.net")
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // localStorage - IndexedDB itself needs no explicit flag
            databaseEnabled = true
            setGeolocationEnabled(true)
            allowFileAccess = false // not needed - everything is served via assetLoader
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
        }

        // v73.142 - Craig: Backup & Sync's "Available to app" figure is
        // navigator.storage.estimate()'s own quota heuristic, which is NOT
        // a live reading of the device's actual free space and can diverge
        // significantly from it (confirmed by Craig's own screenshots: the
        // browser reported 112.5GB "available" while the phone's own file
        // manager showed only ~50GB genuinely free). No web page can query
        // real OS-level free space directly (deliberately, for privacy) -
        // but native Android code can, via StatFs. This bridge exposes that
        // real number to the web app ONLY when it's running inside this
        // wrapper; the web app falls back to the browser estimate anywhere
        // else (desktop/Firefox mobile), where this bridge doesn't exist.
        webView.addJavascriptInterface(object {
            @JavascriptInterface
            fun getRealFreeSpaceBytes(): Long {
                return try {
                    StatFs(filesDir.path).availableBytes
                } catch (e: Exception) {
                    -1L // web side treats a negative value as "unavailable, fall back to estimate"
                }
            }
        }, "AndroidNative")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            // Only ever matters for the host-server API calls made from JS (fetch), not for
            // loading the app itself (which is served from the trusted local asset loader).
            // Default to NOT trusting an unrecognised cert - see network_security_config.xml
            // for the supported path (installing the host server's cert on the device).
            override fun onReceivedSslError(
                view: WebView,
                handler: SslErrorHandler,
                error: android.net.http.SslError
            ) {
                Log.w("RSW", "SSL error talking to host server: ${error.primaryError}")
                handler.cancel()
                Toast.makeText(
                    this@MainActivity,
                    "Couldn't verify the sync server's certificate. Install its certificate on this device first (see the install guide), or check the server address.",
                    Toast.LENGTH_LONG
                ).show()
            }
        }

        webView.webChromeClient = object : WebChromeClient() {

            override fun onGeolocationPermissionsShowPrompt(
                origin: String,
                callback: GeolocationPermissions.Callback
            ) {
                if (ContextCompat.checkSelfPermission(
                        this@MainActivity, Manifest.permission.ACCESS_FINE_LOCATION
                    ) == PackageManager.PERMISSION_GRANTED
                ) {
                    callback.invoke(origin, true, false)
                } else if (!ActivityCompat.shouldShowRequestPermissionRationale(
                        this@MainActivity, Manifest.permission.ACCESS_FINE_LOCATION
                    ) && permissionEverRequested(Manifest.permission.ACCESS_FINE_LOCATION)
                ) {
                    // v73.131 - Craig: "not releasing location to take next set of GPS photos."
                    // If the user denies once WITHOUT "don't ask again," Android happily shows
                    // the system dialog again next time and this branch is skipped entirely  -
                    // that case already worked. This branch only catches the case where a
                    // permission is permanently denied (either explicit "don't ask again," or
                    // some OEMs auto-permanent-deny after one refusal): requesting again would
                    // silently return denied with NO dialog at all, forever, which from the
                    // user's side looks exactly like "the app won't let me take GPS photos
                    // anymore" with no obvious way to fix it. Send them straight to Settings.
                    callback.invoke(origin, false, false)
                    showPermissionSettingsPrompt("Location")
                } else {
                    pendingGeoOrigin = origin
                    pendingGeoCallback = callback
                    requestLocationPermission.launch(Manifest.permission.ACCESS_FINE_LOCATION)
                }
            }

            override fun onShowFileChooser(
                view: WebView,
                filePathCallbackParam: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                filePathCallback?.onReceiveValue(null) // clear out any stale pending request
                filePathCallback = filePathCallbackParam

                val wantsCameraOnly = fileChooserParams.isCaptureEnabled
                if (wantsCameraOnly) {
                    if (ContextCompat.checkSelfPermission(
                            this@MainActivity, Manifest.permission.CAMERA
                        ) == PackageManager.PERMISSION_GRANTED
                    ) {
                        launchImageChooser()
                    } else if (!ActivityCompat.shouldShowRequestPermissionRationale(
                            this@MainActivity, Manifest.permission.CAMERA
                        ) && permissionEverRequested(Manifest.permission.CAMERA)
                    ) {
                        cancelFileChooser()
                        showPermissionSettingsPrompt("Camera")
                    } else {
                        requestCameraPermission.launch(Manifest.permission.CAMERA)
                    }
                } else {
                    // Any non-camera file input - "Add Photos" (image/*), Backup & Sync's
                    // JSON restore inputs (.json/application/json), etc. Must respect the
                    // input's actual `accept` attribute - see launchGalleryChooser().
                    launchGalleryChooser(fileChooserParams.acceptTypes)
                }
                return true
            }
        }

        // v73.131 - Craig: "app restarts / doesn't save state when taking GPS photos, can't
        // take more than one photo." Root cause: returning from the camera Activity very
        // commonly triggers Android to RECREATE this Activity (not just pause it) - especially
        // likely on lower-RAM field phones under memory pressure while a second (camera) app
        // was in the foreground. Without this, onCreate always called loadUrl() unconditionally
        // on every recreation, forcing a full hard reload of the entire single-page app and
        // wiping every bit of in-memory/unsaved state - exactly matching "one photo works, the
        // next one restarts the app and loses everything." webView.restoreState() reuses the
        // WebView's existing navigation/content state instead of re-navigating from scratch
        // when Android only recreated the Activity (not the whole process) - the common case.
        // This can't help if the OS killed the entire process (rare, and also mitigated
        // separately by the IndexedDB auto-save work in store.tsx), but it fixes the much more
        // common Activity-recreation case outright.
        val restored = savedInstanceState?.let { webView.restoreState(it) }
        if (restored == null) {
            webView.loadUrl("https://appassets.androidplatform.net/index.html")
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    // v73.131 - pausing/resuming the WebView with the Activity's own lifecycle is standard
    // practice (stops JS timers/animations from burning battery in the background) and was
    // simply missing before. Doesn't by itself prevent process death, but it's a real gap that
    // was there regardless.
    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    /** Tracks which dangerous permissions have been explicitly requested at least once via our own launchers this app-install - lets us tell "never asked yet" apart from "permanently denied" without needing a persisted flag, since SharedPreferences would be overkill here. */
    private val requestedPermissions = mutableSetOf<String>()
    private fun permissionEverRequested(permission: String): Boolean = permission in requestedPermissions

    private fun showPermissionSettingsPrompt(label: String) {
        Toast.makeText(
            this,
            "$label permission was denied. Enable it in Settings > Apps > RSW Field App > Permissions to use this feature.",
            Toast.LENGTH_LONG
        ).show()
    }

    /** Launches an Intent chooser combining a direct camera capture with the gallery picker - used for capture="environment" inputs, which still fall back to the chooser if the camera app itself is unavailable. */
    private fun launchImageChooser() {
        val picturesDir = getExternalFilesDir(Environment.DIRECTORY_PICTURES) ?: filesDir
        val photoFile = File(
            picturesDir,
            "rsw_${System.currentTimeMillis()}.jpg"
        ).also { it.parentFile?.mkdirs() }

        val photoUri = FileProvider.getUriForFile(
            this, "nz.co.rsw.fieldapp.fileprovider", photoFile
        )
        cameraPhotoUri = photoUri

        val cameraIntent = Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE).apply {
            putExtra(android.provider.MediaStore.EXTRA_OUTPUT, photoUri)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }

        val galleryIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
            type = "image/*"
        }

        val chooser = Intent.createChooser(cameraIntent, "Take photo").apply {
            putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(galleryIntent))
        }
        fileChooserLauncher.launch(chooser)
    }

    /**
     * System file/gallery picker for any non-camera file input. v73.130 fix - this used to
     * hardcode type = "image/*" for every non-camera file chooser request, which meant Backup
     * & Sync's JSON restore inputs (accept=".json,application/json", no `capture` attribute  -
     * same code path as the image "Add Photos" button) opened a picker that only showed image
     * files, hiding every .json backup on the phone entirely. Now resolves the actual `accept`
     * types the HTML input asked for instead of assuming images.
     */
    private fun launchGalleryChooser(acceptTypes: Array<String>) {
        cameraPhotoUri = null
        // WebChromeClient.FileChooserParams.getAcceptTypes() passes through the input's raw
        // `accept` attribute values. Real MIME types (e.g. "image/*") are used as-is; bare file
        // extensions (e.g. ".json", ".csv", ".pdf", ".png", ".jpg") are mapped dynamically
        // via MimeTypeMap with explicit fallback for common formats like .json.
        val mimeTypes = acceptTypes
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .mapNotNull { raw ->
                when {
                    raw.contains('/') -> raw // already a real MIME type, e.g. "image/*"
                    raw.startsWith(".") -> {
                        val ext = raw.substring(1).lowercase()
                        val mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
                        if (mime != null) mime else if (ext == "json") "application/json" else null
                    }
                    else -> null
                }
            }
            .distinct()

        val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
            type = if (mimeTypes.size == 1) mimeTypes[0] else "*/*"
            if (mimeTypes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            addCategory(Intent.CATEGORY_OPENABLE)
        }
        fileChooserLauncher.launch(Intent.createChooser(intent, "Select file"))
    }

    private fun cancelFileChooser() {
        filePathCallback?.onReceiveValue(null)
        filePathCallback = null
        Toast.makeText(this, "Camera permission is needed to take photos.", Toast.LENGTH_SHORT).show()
    }

    // Back button navigates the WebView's own history (e.g. out of an inspection form back to
    // the list) before falling back to the normal Activity back behaviour (exiting the app).
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // Handled via the ActivityResultContracts launchers above; nothing extra needed here,
        // this override exists only because some OEM WebViews still route through it too.
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
