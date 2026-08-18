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

    /**
     * Release signing, read from local.properties so no key or password ever
     * enters the repository. local.properties is gitignored and stays that way.
     *
     * Absent config is not an error: the build still works for anyone who only
     * wants a debug APK, and `assembleRelease` simply produces an unsigned one.
     * Failing the whole build because a keystore is missing would stop a fresh
     * clone from compiling at all.
     */
    val keystorePath = localProperties.getProperty("keystore.path")
    val hasKeystore = keystorePath != null && file(keystorePath).exists()

    signingConfigs {
        if (hasKeystore) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = localProperties.getProperty("keystore.password")
                keyAlias = localProperties.getProperty("keystore.alias")
                keyPassword = localProperties.getProperty("keystore.keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // Both matter, for different reasons. isDebuggable=false stops
            // anyone with the APK and a cable reading the app's database off a
            // phone; shrinking removes unused code and the names that make it
            // trivial to read what is left.
            isDebuggable = false
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        // Deliberately NO applicationIdSuffix on debug.
        //
        // It would be tidy -- debug and release side by side -- but it changes
        // the application id, so every phone already carrying a debug build
        // would treat the next one as a different app and open with nothing in
        // it. Local drawings, signatures and photos live under the old id. That
        // reads as total data loss, and it is not worth the tidiness.
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
    // Knowing when the app comes back to the foreground: access and money both
    // have to be current the moment someone looks, not whenever a timer fires.
    implementation("androidx.lifecycle:lifecycle-process:2.8.6")
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
    // Signatures, survey images and job photos are files, not rows. Without
    // this they only ever existed on the phone that took them.
    implementation("io.github.jan-tennert.supabase:storage-kt")
    // Money has to land without anyone pressing anything. Sync passes and push
    // notifications both have a gap between the card clearing and the phone
    // showing it; a Postgres change feed does not.
    implementation("io.github.jan-tennert.supabase:realtime-kt")
    // CIO engine (not the Android engine) because it supports websockets, which
    // Supabase Realtime needs.
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

val driveApkFolder = driveProjectFolder.resolve("app/build/outputs/apk/debug")

tasks.register("copyDebugApkToDrive") {
    description = "Copies the debug APK into Google Drive so it syncs to the phone."

    // Never treat this as up to date. A Copy task that decides nothing changed
    // is silently doing nothing, and the only symptom is an APK on the phone
    // that is quietly a build or two behind -- which is worse than a failure.
    outputs.upToDateWhen { false }

    doLast {
        val source = layout.buildDirectory.file("outputs/apk/debug/app-debug.apk").get().asFile
        if (!source.exists()) {
            logger.lifecycle("APK -> Drive: nothing to copy, ${source.name} was not built.")
            return@doLast
        }
        // Missing drive means Drive is paused or this is another machine; say so
        // rather than failing the build over it.
        if (!driveProjectFolder.exists()) {
            logger.lifecycle("APK -> Drive: SKIPPED, ${driveProjectFolder} is not available.")
            return@doLast
        }

        driveApkFolder.mkdirs()
        val target = driveApkFolder.resolve(source.name)
        source.copyTo(target, overwrite = true)

        // Confirm from the destination, not from the copy call, so a partial or
        // blocked write shows up here instead of on someone's phone.
        //
        // Retried, because G: is a streaming virtual drive: copyTo() returns
        // before Drive has finished committing, so an immediate size check can
        // read a short file that is about to be correct. Failing on that was a
        // false alarm that broke otherwise-good builds. A genuinely truncated
        // write still never settles, so it still fails.
        var ok = false
        repeat(10) { attempt ->
            if (!ok) {
                ok = target.exists() && target.length() == source.length()
                if (!ok) Thread.sleep(300L * (attempt + 1))
            }
        }

        logger.lifecycle(
            if (ok) "APK -> Drive: copied ${source.length() / 1_000_000}MB to $target"
            else "APK -> Drive: FAILED, $target is ${target.length()} bytes, expected ${source.length()}"
        )
        if (!ok) throw GradleException("Could not write the APK to Google Drive at $target")
    }
}

// Both build types, so a release APK lands there too once signing is set up.
tasks.matching { it.name == "assembleDebug" || it.name == "assembleRelease" }.configureEach {
    finalizedBy("copyDebugApkToDrive")
}
