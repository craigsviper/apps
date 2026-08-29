plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "nz.co.rsw.fieldapp"
    compileSdk = 34

    defaultConfig {
        applicationId = "nz.co.rsw.fieldapp"
        minSdk = 26 // Android 8.0 - required for WebViewAssetLoader's https virtual-origin serving
        targetSdk = 34
        // versionCode/versionName are kept in sync with the web app's own version by hand at
        // release time (see CLAUDE_CONTEXT.md release checklist) - v73.142 -> versionCode 73142.
        versionCode = 73142
        versionName = "73.142"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    // The web app is a single self-contained index.html (Vite singlefile build) plus a handful
    // of static assets (leaflet, icons) - bundled directly into assets/ (the root, NOT a
    // subfolder - see CHANGELOG.md v73.129 for why that matters), no external hosting required.
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    // WebViewAssetLoader - serves assets/ under a real https:// virtual origin instead of
    // file://, so IndexedDB/localStorage behave like a normal web origin (see MainActivity.kt).
    implementation("androidx.webkit:webkit:1.11.0")
}
