import com.android.build.api.dsl.ApplicationBuildType
import java.io.File
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

/**
 * The build number, counted from the commit history.
 *
 * It used to be hard-coded to 1, which quietly broke the in-app update prompt:
 * the app compares its own version against the newest published one, so with
 * every build numbered 1, installing an update did nothing to stop the prompt.
 * It would have asked forever, which teaches people to dismiss it -- including
 * the time it matters.
 *
 * Commit count is monotonic and needs no remembering. Android also refuses to
 * install an APK whose version is lower than the one already on the phone, so a
 * number that never moves would eventually have blocked updates outright.
 *
 * Falls back to 1 outside a git checkout so a source download still builds.
 */
// ProcessBuilder rather than Gradle's exec {}: inside a build script, `java`
// resolves to the Java plugin extension, so java.io.* does not name the package.
val gitVersionCode: Int = runCatching {
    val process = ProcessBuilder("git", "rev-list", "--count", "HEAD")
        .directory(rootProject.projectDir)
        .redirectErrorStream(true)
        .start()
    val text = process.inputStream.bufferedReader().readText().trim()
    process.waitFor()
    text.toInt()
}.getOrDefault(1).coerceAtLeast(1)

/**
 * Which backend this build talks to.
 *
 * Until there was a dev project, every build pointed at the live database and
 * every test ran against real customers' jobs and money. The switch is one line
 * in local.properties, which is gitignored, so it never travels with the repo:
 *
 *     fenceflow.env=dev      # or prod, or leave it out entirely for prod
 *
 * A build flavor would have been the tidier Gradle answer and is deliberately
 * not what this is. Flavors rename every task -- assembleDebug becomes
 * assembleProdDebug -- which breaks copyLinkApkToDrive below, the publish
 * script, and the Android Studio run configuration; and giving the dev flavor
 * an applicationIdSuffix would change the application id, which is the one
 * thing the buildTypes comment further down says never to do, because every
 * phone carrying the old id opens the new build with nothing in it.
 */
val fenceFlowEnv = (localProperties.getProperty("fenceflow.env") ?: "prod").trim().lowercase()
if (fenceFlowEnv != "prod" && fenceFlowEnv != "dev") {
    throw GradleException("fenceflow.env in local.properties must be 'dev' or 'prod', not '$fenceFlowEnv'.")
}
val isDevBackend = fenceFlowEnv == "dev"

val supabaseUrl: String = localProperties.getProperty(
    if (isDevBackend) "supabase.dev.url" else "supabase.url", ""
)
val supabaseKey: String = localProperties.getProperty(
    if (isDevBackend) "supabase.dev.key" else "supabase.key", ""
)

// Failing here rather than falling back. A dev build that quietly reverts to
// the live database because two properties were missing is precisely the
// accident this whole arrangement exists to prevent, and it would look
// exactly like a working dev build until it charged somebody.
if (isDevBackend && (supabaseUrl.isBlank() || supabaseKey.isBlank())) {
    throw GradleException(
        "fenceflow.env=dev but supabase.dev.url / supabase.dev.key are missing from local.properties."
    )
}

// Printed on every build, so which database this APK talks to is never a guess.
logger.lifecycle(
    "FenceFlow backend: " + (if (isDevBackend) "DEV  " else "PRODUCTION  ") + supabaseUrl
)

// ===========================================================================
// BUILD VARIANTS -- which APK is which. The long version: docs/BUILD_VARIANTS.md
//
//   task                 lands in                                     self-update
//   -------------------  -------------------------------------------  -----------
//   assembleLink         app/build/outputs/apk/link/app-link.apk        ON
//   assembleRelease      app/build/outputs/apk/release/app-release.apk  off
//   bundleRelease        app/build/outputs/bundle/release/app-release.aab  off
//   assembleDebug        app/build/outputs/apk/debug/app-debug.apk      off
//
//   link     The APK handed out by link. It is the only build that reaches a
//            phone without Play, so it is the only one that can update itself.
//            This is the one that belongs in Drive as fenceflow.apk and the one
//            scripts/publish-release.mjs publishes.
//   release  The Play-shaped build. It must NEVER self-update: distributing
//            updates outside Play is against Play policy, and the permission
//            that does it (REQUEST_INSTALL_PACKAGES) gets an app refused at
//            review. app/src/release/AndroidManifest.xml removes that permission
//            from this build type only, which is why it is a build type of its
//            own and not a flag on a build type.
//   debug    Signed with Android's shared debug key, so it can never replace the
//            link build on a phone; an update it was offered could not install.
//
// link and release are identical in everything but that one flag: same
// application id (no suffix, ever -- a different id is a different app to
// Android and a phone opens it with nothing in it), same signing key, same
// shrinking. They differ in nothing else, and the checks further down fail the
// build rather than let them.
// ===========================================================================

/**
 * WHICH BUILD TYPE SELF-UPDATES. This map is the only place that says so.
 *
 * It feeds BuildConfig.SELF_UPDATE for every build type (the loop inside the
 * android block below); nothing else in this file sets that flag. The app reads
 * the flag through UpdateChecker, which is the one place that acts on it.
 *
 * Exactly one entry may be true, and it is "link". If a build type is added and
 * missing from here, the build fails and says so, so the question "does this one
 * update itself?" always gets a deliberate answer.
 */
val selfUpdateByBuildType: Map<String, Boolean> = mapOf(
    // Handed out by link. Has to update itself: nothing else can reach those phones.
    "link" to true,
    // The Play-shaped build. Must never update itself; see the table above.
    "release" to false,
    // Developer builds on a cable. Debug-signed, so a release-signed update could
    // not install over it anyway.
    "debug" to false,
)

// The release keystore, read from local.properties so no key or password ever
// enters the repository. Absent config is not an error for a build that only
// needs to compile (see the signing comment inside the android block), but it IS
// one for the link build, below: an unsigned or wrongly signed link APK is a
// different app to Android and will not install over what is on the phone.
val keystorePath: String? = localProperties.getProperty("keystore.path")
val hasKeystore: Boolean = keystorePath?.let { file(it).exists() } ?: false

// Asked for by name, not merely part of `assemble`, so a fresh clone with no
// keystore can still compile everything. Failing here costs seconds; finding out
// from a phone that will not take the update costs the data on it.
val linkBuildRequested: Boolean = gradle.startParameter.taskNames.any { requested ->
    requested.substringAfterLast(':') in setOf("assembleLink", "packageLink", "bundleLink")
}
if (linkBuildRequested && !hasKeystore) {
    throw GradleException(
        "The link build is what reaches phones, and it must be signed with the release key: an " +
            "unsigned APK, or one signed with any other key, is a different app to Android and will " +
            "not install over the one already on the phone. keystore.path in local.properties is " +
            "missing, or names a file that does not exist. See RELEASE_SETUP.md."
    )
}

/** Whether a manifest removes the permission that lets an app install updates. */
fun stripsInstallPermission(manifest: File): Boolean {
    if (!manifest.exists()) return false
    // Comments out first. The release manifest explains itself at length and
    // names the permission in prose; only the element counts.
    val text = manifest.readText().replace(Regex("<!--.*?-->", RegexOption.DOT_MATCHES_ALL), "")
    return Regex(
        """<uses-permission[^>]*REQUEST_INSTALL_PACKAGES[^>]*tools:node\s*=\s*["']remove["']""",
        RegexOption.DOT_MATCHES_ALL
    ).containsMatchIn(text)
}

/**
 * Fails the build when the variants stop being what docs/BUILD_VARIANTS.md says.
 * Every problem is collected, so one run names all of them.
 */
fun verifyVariantContract(
    buildTypes: Collection<ApplicationBuildType>,
    selfUpdate: Map<String, Boolean>,
    appDir: File
) {
    val problems = mutableListOf<String>()
    val byName = buildTypes.associateBy { it.name }

    // 1. Every build type has a decision, and no decision names a stranger.
    for (name in byName.keys - selfUpdate.keys) {
        problems += "Build type '$name' has no entry in selfUpdateByBuildType. Decide, in writing, whether it updates itself."
    }
    for (name in selfUpdate.keys - byName.keys) {
        problems += "selfUpdateByBuildType names '$name', which is not a build type."
    }

    // 2. One self-updating build type, and it is the one handed out by link.
    val updating = selfUpdate.filterValues { it }.keys
    if (updating != setOf("link")) {
        problems += "Only the link build may self-update, but selfUpdateByBuildType turns it on for: $updating."
    }

    // 3. The Play-shaped build never does. Said on its own because it is the one
    // that gets an app refused at review.
    if (selfUpdate["release"] != false) {
        problems += "release is the Play-shaped build and must never self-update, but selfUpdateByBuildType says ${selfUpdate["release"]}."
    }

    // 4. The flag and the manifest agree. The Play build drops the install
    // permission (app/src/release/AndroidManifest.xml); a build that self-updates
    // must keep it, or the button is drawn and the install is then refused.
    for ((name, flag) in selfUpdate) {
        val strips = stripsInstallPermission(File(appDir, "src/$name/AndroidManifest.xml"))
        if (flag && strips) {
            problems += "'$name' self-updates but app/src/$name/AndroidManifest.xml removes REQUEST_INSTALL_PACKAGES, so the update could never install."
        }
    }
    if (!stripsInstallPermission(File(appDir, "src/release/AndroidManifest.xml"))) {
        problems += "app/src/release/AndroidManifest.xml no longer removes REQUEST_INSTALL_PACKAGES, so the Play build would ask for the permission that gets an app refused."
    }

    // 5. link and release are the same build apart from the flag. Not left to
    // initWith: it copies at the moment it is called, so what it carried
    // depended on the order of the blocks.
    val release = byName["release"]
    val link = byName["link"]
    if (release != null && link != null) {
        fun mustMatch(what: String, inRelease: Any?, inLink: Any?) {
            if (inRelease != inLink) {
                problems += "link and release differ in $what (release: $inRelease, link: $inLink). They must be identical but for SELF_UPDATE."
            }
        }
        mustMatch("isDebuggable", release.isDebuggable, link.isDebuggable)
        mustMatch("isMinifyEnabled", release.isMinifyEnabled, link.isMinifyEnabled)
        mustMatch("isShrinkResources", release.isShrinkResources, link.isShrinkResources)
        mustMatch("signingConfig", release.signingConfig?.name, link.signingConfig?.name)
        mustMatch("proguardFiles", release.proguardFiles.map { it.name }, link.proguardFiles.map { it.name })
        mustMatch("versionNameSuffix", release.versionNameSuffix, link.versionNameSuffix)
    }

    // 6. One application id. A suffix on any build type is a different app.
    for (type in buildTypes) {
        if (!type.applicationIdSuffix.isNullOrEmpty()) {
            problems += "Build type '${type.name}' sets applicationIdSuffix '${type.applicationIdSuffix}'. A different application id is a different app to Android: the phone opens it with nothing in it, and an update cannot install over the old one."
        }
    }

    if (problems.isNotEmpty()) {
        throw GradleException(
            "The build variants no longer match docs/BUILD_VARIANTS.md:\n" +
                problems.joinToString("\n") { "  - $it" }
        )
    }
}

android {
    namespace = "com.fenceestimator.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.fenceestimator.app"
        minSdk = 26
        targetSdk = 34
        versionCode = gitVersionCode
        versionName = "1.$gitVersionCode"

        buildConfigField("String", "SUPABASE_URL", "\"$supabaseUrl\"")
        buildConfigField("String", "SUPABASE_KEY", "\"$supabaseKey\"")

        // Read by the DEV badge painted over every screen. A phone must never
        // be able to look like the live app while talking to dev.
        buildConfigField("boolean", "IS_DEV_BACKEND", isDevBackend.toString())

        // SELF_UPDATE is NOT declared here. There used to be a default of true
        // in this block and an override to false on release, which is two
        // places to keep in step and a default that any new build type inherited
        // without anybody choosing it. It is now set once per build type from
        // selfUpdateByBuildType, below the buildTypes block.

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
     * clone from compiling at all. The one exception is asking for the link
     * build by name; see linkBuildRequested above.
     */
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

        // The build handed out by link: release in every respect but one.
        //
        // A build type rather than a product flavour, because:
        //   - app/src/release/AndroidManifest.xml (which strips the install
        //     permission) belongs to the build type named release. A new build
        //     type does not read it, so this one keeps the permission it needs
        //     and the Play build cannot pick it up by accident.
        //   - a flavour renames every task (assembleProdLink...) and drags in a
        //     flavour dimension, which breaks the publish script, the Drive copy
        //     and the run configuration. See the fenceFlowEnv comment.
        //   - the cost of a build type is that it inherits only what is copied
        //     into it. initWith copies signing, shrinking, proguard files and
        //     debuggability in this AGP, but as a snapshot taken at the moment of
        //     the call -- so the signing config is stated again below rather than
        //     trusted to block order, and verifyVariantContract compares them all.
        //
        // No applicationIdSuffix: it would be a different app to Android, and the
        // phone would open it with nothing in it.
        create("link") {
            initWith(getByName("release"))
            matchingFallbacks += listOf("release")
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

    // Whether each build type updates itself, from the one map at the top of the
    // file. After the blocks above rather than inside them: initWith copies the
    // build config fields as they are when it is called, so a flag set inside
    // release before link was created would be copied into link.
    buildTypes.forEach { type ->
        val flag = selfUpdateByBuildType[type.name]
            ?: throw GradleException(
                "Build type '${type.name}' has no entry in selfUpdateByBuildType. " +
                    "Decide, in writing, whether it updates itself."
            )
        type.buildConfigField("boolean", "SELF_UPDATE", flag.toString())
    }

    // Fails the build, on every Gradle run including a sync, if the variants have
    // drifted from the contract at the top of the file.
    verifyVariantContract(buildTypes, selfUpdateByBuildType, projectDir)

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

    // Reading a photo's rotation. A portrait photo stores its orientation in
    // EXIF rather than in the pixels, and re-encoding drops that -- so without
    // this a compressed photo arrives on the other phone lying on its side.
    implementation("androidx.exifinterface:exifinterface:1.3.7")

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
// One APK per app, overwritten in place. This used to copy into a replica of
// the project tree inside Drive -- G:/.../FenceEstimator/app/build/outputs/... --
// which meant every debug build recreated a folder that looks exactly like
// build output nobody should be syncing. It grew to 200 MB and was cleaned out
// by hand on 11 September. Drive holds finished APKs and documents, nothing
// else, and the name carries no date or hash so there is only ever one file.
val driveApkFolder = file("G:/My Drive/Professional Documents/Projects/APK Builds")
val driveApkName = "fenceflow.apk"

// The LINK build goes to Drive, and only the link build.
//
// This used to copy app-debug.apk after assembleDebug AND after assembleRelease.
// So a release build (Play-shaped: no updater, no install permission) left the
// debug APK from some earlier build sitting in fenceflow.apk, and a debug build
// put a debug-signed one there -- which cannot install over a phone carrying the
// release-signed app, and carries no updater if it could. fenceflow.apk is the
// file that gets sideloaded onto phones, so it must only ever be the build that
// can update them afterwards. The debug build is installed by Android Studio or
// adb, not through Drive.
tasks.register("copyLinkApkToDrive") {
    description = "Copies the link APK (the one that self-updates) into Google Drive as fenceflow.apk."

    // Never treat this as up to date. A Copy task that decides nothing changed
    // is silently doing nothing, and the only symptom is an APK on the phone
    // that is quietly a build or two behind -- which is worse than a failure.
    outputs.upToDateWhen { false }

    doLast {
        // A finalizer runs even when the task it finalizes failed. Without this
        // a broken build copied whatever link APK an earlier build had left
        // behind and announced it as current. So: copy only if assembleLink
        // actually ran in THIS build and did not fail.
        val assemble = tasks.findByName("assembleLink")
        if (assemble == null || !assemble.state.executed || assemble.state.failure != null) {
            logger.lifecycle("APK -> Drive: SKIPPED, assembleLink did not complete in this build, so there is nothing new to copy.")
            return@doLast
        }
        val source = layout.buildDirectory.file("outputs/apk/link/app-link.apk").get().asFile
        if (!source.exists()) {
            logger.lifecycle("APK -> Drive: nothing to copy, ${source.name} was not built.")
            return@doLast
        }
        // Missing drive means Drive is paused or this is another machine; say so
        // rather than failing the build over it.
        if (!driveApkFolder.exists()) {
            logger.lifecycle("APK -> Drive: SKIPPED, ${driveApkFolder} is not available.")
            return@doLast
        }

        val target = driveApkFolder.resolve(driveApkName)
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

// Only assembleLink. Not assembleDebug, not assembleRelease: see above.
tasks.matching { it.name == "assembleLink" }.configureEach {
    finalizedBy("copyLinkApkToDrive")
}
