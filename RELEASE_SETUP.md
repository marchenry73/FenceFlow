# Making a release build

The debug APK you have been installing is signed with Android's shared debug
key and is marked debuggable. That is fine on your own phone and **not fine to
give to another company** — anyone with the file and a USB cable can read the
app's database off the device.

A release build fixes both. It needs one thing from you that cannot be
automated: a keystore.

## The keystore is your app's identity — do not lose it

Android identifies an app by the key it was signed with, not by its name. The
consequences of losing the keystore are permanent:

- You can never publish an update to anyone who installed it. They would have
  to uninstall and reinstall, losing anything held only on the device.
- On the Play Store, you cannot recover the listing. It becomes a new app with
  no reviews and no installs.

So: **back it up somewhere you will still have it in five years**, and not only
on the machine that made it. A copy in your password manager and a copy on a
drive that is not this laptop.

## 1. Create it

Run this once, from anywhere. Replace nothing except the answers it asks for.

```bash
"C:\Users\march\.jdks\jdk-17.0.20+8\bin\keytool" -genkeypair -v -keystore fenceflow-release.jks -keyalg RSA -keysize 4096 -validity 10000 -alias fenceflow
```

It asks for two passwords — the keystore password and the key password. Use
different ones, and put both in your password manager as you type them. It also
asks for your name and organisation; those appear in the certificate, so use the
business name you actually trade under.

`-validity 10000` is about 27 years. Play Store requires the certificate to
outlast 2033, and a certificate expiring is another way to lose the ability to
update.

## 2. Tell Gradle where it is

Move `fenceflow-release.jks` somewhere outside the project folder — if it sits
inside the repo, one careless `git add -A` publishes your signing key to a
public repository.

Then add four lines to `local.properties` (which is gitignored and stays that
way):

```properties
keystore.path=C:/Users/march/keys/fenceflow-release.jks
keystore.password=THE_KEYSTORE_PASSWORD
keystore.alias=fenceflow
keystore.keyPassword=THE_KEY_PASSWORD
```

Forward slashes even on Windows — Gradle reads this as a properties file, where
a backslash starts an escape sequence.

## 3. Build it

```bash
./gradlew assembleRelease
```

The APK lands in `app/build/outputs/apk/release/app-release.apk`.

Without the keystore configured the build still succeeds and produces an
unsigned APK — a missing keystore does not stop a fresh clone from compiling.
An unsigned APK cannot be installed, which is the intended outcome rather than
a failure.

## 4. Test it before anyone else gets it — this part matters

A release build is not just a signed debug build. It is shrunk and obfuscated
by R8, which removes code it cannot see being used. This app uses reflection in
three places R8 cannot follow: kotlinx-serialization for every cloud read and
write, Room for entity and column names, and Ktor for engine selection.
`proguard-rules.pro` has keep rules for all three, and each block says what
breaks without it.

Those rules are written but **not yet proven on a device**. Unit tests run
against unshrunk code, so they cannot catch this class of failure. Walk the
release build through:

- Sign in, and confirm jobs and payments arrive (serialization).
- Open a job with a drawing and an estimate (Room).
- Record a payment and see it appear (serialization + Room together).
- Create a payment link (Ktor).

If any of those fail on release but work on debug, it is a missing keep rule
rather than a bug in the feature.

## What is still needed before another company installs this

Release signing is one of four. The others are in the task list: live Stripe
keys, an attorney reading the contract template, and a published privacy policy
and terms of service.
