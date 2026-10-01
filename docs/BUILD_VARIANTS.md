# Build variants: which APK is which

There are two builds that matter and a third for your own phone on a cable.
Only one of them can update itself, and only that one belongs on phones.

## The short version (read this at midnight)

**To get a fix onto phones:**

```bash
export JAVA_HOME=/c/Users/march/.jdks/jdk-17.0.20+8
git commit ...                       # version number = commit count, so commit FIRST
./gradlew assembleLink > build.log 2>&1
node scripts/publish-release.mjs "What changed, in a sentence"
```

Run `gradlew` as the last thing on its line and read `build.log`. Do not pipe it
into `tail` or `grep`: the pipeline reports the last command's exit code, so a
failed build looks like a success.

**To build for the Play Store:** `./gradlew bundleRelease`. Never publish that
build with `publish-release.mjs`, never put it in Drive.

**If the "Check for updates" button is missing or nothing updates by itself:**
the phone is running the Play-shaped build. See [Phones that are on the wrong
build](#phones-that-are-on-the-wrong-build).

## The three builds

| Build type | Task | APK lands in | Self-updates | Signed with | Install permission |
|---|---|---|---|---|---|
| **link** | `assembleLink` | `app/build/outputs/apk/link/app-link.apk` | **yes** | release key | kept |
| **release** | `assembleRelease` | `app/build/outputs/apk/release/app-release.apk` | **no** | release key | removed |
| release (Play upload) | `bundleRelease` | `app/build/outputs/bundle/release/app-release.aab` | **no** | release key | removed |
| debug | `assembleDebug` | `app/build/outputs/apk/debug/app-debug.apk` | no | Android's shared debug key | kept |

All three have the **same application id**, `com.fenceestimator.app`. There is no
suffix on any of them and there never may be: a different id is a different app to
Android, so the phone would open it with nothing in it, and an update could never
install over the old one.

- **link** is the APK you hand out by link. It is the only build that reaches a
  phone without Play, so it is the only one that can update itself. It is the one
  `scripts/publish-release.mjs` publishes, and the one that is copied to Google
  Drive as `fenceflow.apk`. It is `release` in every other respect: same key, same
  application id, same shrinking, not debuggable.
- **release** is the Play-shaped build. It never updates itself and does not ask
  for the permission that would let it.
- **debug** is for your own phone on a cable (Android Studio's Run button, or
  `adb install -r`). It is signed with Android's shared debug key, so it can never
  replace the link build on a phone, and an update it was offered could not
  install. It is not copied to Drive.

## Why the Play build must never self-update

Google Play forbids an app distributing its own updates outside Play, and the
permission that does it, `REQUEST_INSTALL_PACKAGES`, gets an app refused at
review.

## What each build does about self-update and signing

**Self-update** is the build constant `BuildConfig.SELF_UPDATE`. It is set in one
place: the `selfUpdateByBuildType` map near the top of `app/build.gradle.kts`.

```kotlin
"link" to true, "release" to false, "debug" to false
```

The app reads it through `UpdateChecker` (`cloud/UpdateChecker.kt`), which is the
only code that acts on it. When it is true the app shows the **Check for updates**
button in Settings, checks for a newer release at launch and whenever the app
comes back to the front, and installs what it finds. When it is false none of
that exists: no button, no check, and `UpdateChecker` says "this build does not
self-update" rather than "you are up to date".

**The install permission** is separate from the constant but moves with it.
`app/src/main/AndroidManifest.xml` declares `REQUEST_INSTALL_PACKAGES`;
`app/src/release/AndroidManifest.xml` removes it, and Android only reads that file
for the build type named `release`. That is why `link` is a build type of its own:
it does not read the release manifest, so it keeps the permission, and the Play
build cannot pick it up by accident.

**Signing.** `link` and `release` are signed with the same key, from
`keystore.path`, `keystore.alias`, `keystore.password` and `keystore.keyPassword`
in `local.properties`. The signing key is the app's identity. A link APK that is
unsigned, or signed with any other key, is a different app to Android: it will
not install over the one on the phone, and the only way round that is to
uninstall first, which deletes the data on it.

## What stops the wrong build shipping

You do not have to remember any of this. Each of these fails loudly:

1. **The build file checks itself** on every Gradle run, including an Android
   Studio sync. It fails, naming the problem, if more than one build type
   self-updates or the one that does is not `link`; `release` self-updates; a
   build type has no entry in the map (so adding one forces a decision); link
   differs from release in signing, shrinking, debuggability or proguard files;
   anything sets an application id suffix; the release manifest stops removing
   the install permission; or a build type that self-updates has it removed.
2. **`assembleLink` refuses to run without the release keystore**, in seconds,
   rather than produce an unsigned APK. (A plain `assemble` on a fresh clone with
   no keystore still compiles; only asking for the link build by name refuses.)
3. **Drive only ever receives the link build**, and only after `assembleLink`
   succeeded. `assembleDebug` and `assembleRelease` copy nothing. A failed
   `assembleLink` copies nothing, and does not leave an older APK looking current.
4. **`publish-release.mjs` publishes the link build or nothing.** `--release` is
   refused. Before any gate runs it opens `app-link.apk` and refuses unless it is
   `com.fenceestimator.app`, declares `REQUEST_INSTALL_PACKAGES`, is not
   debuggable, and is signed with a key that is not Android's debug key. It judges
   the file's contents, so a Play-shaped APK copied into the link folder is still
   caught. It cannot tell you which signing key is the right one; it prints the
   key's fingerprint so you can compare it with the build on the phone.
5. **A test** (`tests/a27-variant-self-update.test.mjs`) asserts the relationships
   above from the source, without a build, and proves each check by planting the
   failure it guards against.

## Checking an APK yourself

```bash
BT="$LOCALAPPDATA/Android/Sdk/build-tools/35.0.0"
"$BT/aapt2.exe" dump badging app/build/outputs/apk/link/app-link.apk > badging.txt
```

In `badging.txt`: the link build has a line
`uses-permission: name='android.permission.REQUEST_INSTALL_PACKAGES'`; the
release build does not. Neither has an `application-debuggable` line.

```bash
java -jar "$BT/lib/apksigner.jar" verify --print-certs app/build/outputs/apk/link/app-link.apk
```

The SHA-256 digest it prints is the key. It must match what the phone already has;
the debug key's subject reads `CN=Android Debug`.

## The one-file-in-Drive rule

Drive holds exactly one FenceFlow APK, `fenceflow.apk`, overwritten every time and
never a second copy. It is always the link build. Two things write it: the
`copyLinkApkToDrive` task (after `assembleLink`) and the spare copy at the end of
`publish-release.mjs`. Both copy the same file.

Before this was fixed, `assembleDebug` and `assembleRelease` both copied
`app-debug.apk` into `fenceflow.apk`, so a release build could leave an older
debug APK in Drive, and a debug build put a debug-signed one there. Install either
and it fails or replaces the updater with nothing.

## Phones that are on the wrong build

A phone running the Play-shaped build has no update button and no updater, so it
cannot fetch the link build itself. Install the link APK on it once by hand.

Because link and release share the application id and the signing key, that
installs **over** the existing app and keeps its data (`adb install -r`, or open
`fenceflow.apk` from Drive on the phone). From then on the button is there and the
app updates itself.

A phone running a debug build cannot take this over-the-top: the signing key
differs, so Android refuses. That is the one case that needs an uninstall.

## Adding a build type

If you add one (staging, say), the build fails until you add it to
`selfUpdateByBuildType` and say whether it updates itself. Only `link` may answer
yes. Do not give any build type an `applicationIdSuffix`.

## Not covered here

- A link build made with `fenceflow.env=dev` in `local.properties` talks to the dev
  database and carries the DEV badge. Nothing stops that being published; check the
  badge before you publish.
- `RELEASE_SETUP.md` step 3 describes `assembleRelease` only. That is the Play
  build; for phones, build `assembleLink`.
