import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.gms.google-services")
}

val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.fenceestimator.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.fenceestimator.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        buildConfigField("String", "SUPABASE_URL", "\"${localProperties.getProperty("supabase.url", "")}\"")
        buildConfigField("String", "SUPABASE_KEY", "\"${localProperties.getProperty("supabase.key", "")}\"")

        vectorDrawables {
            useSupportLibrary = true
        }
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

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

// auth-kt pulls androidx.browser for OAuth custom tabs. Recent versions of it require
// AGP 8.9+/compileSdk 36; we only use email/password auth, so hold it at a version that
// builds against this toolchain.
configurations.all {
    resolutionStrategy {
        force("androidx.browser:browser:1.8.0")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
    implementation("androidx.activity:activity-compose:1.9.2")

    // Biometric unlock. Requires the host to be a FragmentActivity, which is
    // why MainActivity extends FragmentActivity rather than ComponentActivity.
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.fragment:fragment-ktx:1.8.5")

    implementation(platform("androidx.compose:compose-bom:2024.09.03"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("androidx.navigation:navigation-compose:2.8.0")

    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    implementation("io.coil-kt:coil-compose:2.6.0")

    implementation("com.tom-roush:pdfbox-android:2.0.27.0")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // Pinned to 3.0.2: newest supabase-kt built against Kotlin 2.0.21, this project's Kotlin
    // version. Later releases ship Kotlin 2.1+ metadata that this compiler rejects outright,
    // and bumping Kotlin would drag KSP, the Compose compiler, and AGP along with it.
    implementation(platform("io.github.jan-tennert.supabase:bom:3.0.2"))
    implementation("io.github.jan-tennert.supabase:auth-kt")
    implementation("io.github.jan-tennert.supabase:postgrest-kt")
    // CIO engine (not the Android engine) because it supports websockets, which
    // Supabase Realtime needs if we add live sync later.
    implementation("io.ktor:ktor-client-cio:3.0.1")

    // Firebase Cloud Messaging only -- no analytics, no other Firebase products.
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging-ktx")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
}

// The project itself stays on the local disk on purpose. Gradle does tens of
// thousands of small reads, writes, and file locks per build, and a synced
// virtual drive can't keep up -- that's what broke builds back when this lived
// in OneDrive. So only the one finished APK travels to Google Drive, where it
// syncs down to the phone for installing.
val driveProjectFolder = file("G:/My Drive/Professional Documents/Projects/FenceEstimator")

tasks.register<Copy>("copyDebugApkToDrive") {
    description = "Copies the debug APK into Google Drive so it syncs to the phone."
    from(layout.buildDirectory.file("outputs/apk/debug/app-debug.apk"))
    into(driveProjectFolder.resolve("app/build/outputs/apk/debug"))
    // Skips quietly when the drive isn't mounted -- Drive paused, or a different
    // machine -- so a missing G: never fails the build.
    onlyIf { driveProjectFolder.exists() }
}

tasks.matching { it.name == "assembleDebug" }.configureEach {
    finalizedBy("copyDebugApkToDrive")
}
