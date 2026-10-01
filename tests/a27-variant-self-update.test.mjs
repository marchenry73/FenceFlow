// a27 -- THE LINK BUILD KEEPS ITS UPDATER, AND THE PLAY BUILD NEVER GETS ONE.
//
// What went wrong: SELF_UPDATE was true in defaultConfig and false on release, and
// there was only one release build type -- so the APK handed out by link WAS the
// Play-shaped build, with no update button and no automatic check. Both symptoms
// from one flag.
//
// This file does not need a build. It reads app/build.gradle.kts, UpdateChecker.kt,
// the release manifest and scripts/publish-release.mjs, and asserts the
// relationship that has to hold between them:
//
//   1. exactly one build type self-updates, and it is `link`; `release` does not
//   2. the flag is set in ONE place (from the map), not scattered over blocks
//   3. link and release carry the same signing config and applicationId, with no
//      suffix anywhere, and link overrides nothing else about release
//   4. the Play build's manifest strips REQUEST_INSTALL_PACKAGES, and nothing that
//      self-updates does
//   5. only the link build is copied to Drive, and only after assembleLink
//   6. UpdateChecker has one gate, a distinct "does not self-update" outcome, and
//      never answers "nothing newer" for a question it did not ask
//   7. publish-release.mjs refuses --release and refuses any APK that is not the
//      link build, judged from the file's bytes
//
// Every assertion is proven by a planted failure: a scratch copy with one value
// flipped must be caught. A check that stays green with the wall knocked down was
// never measuring the wall.
//
//   node --test tests/a27-variant-self-update.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// This repo is checked out with CRLF line endings; every pattern below is written
// against LF, so read it that way.
const read = (rel) => readFileSync(join(ROOT, ...rel.split("/")), "utf8").replace(/\r\n/g, "\n");

const GRADLE = "app/build.gradle.kts";
const CHECKER = "app/src/main/java/com/fenceestimator/app/cloud/UpdateChecker.kt";
const SETTINGS = "app/src/main/java/com/fenceestimator/app/ui/settings/SettingsScreen.kt";
const RELEASE_MANIFEST = "app/src/release/AndroidManifest.xml";
const MAIN_MANIFEST = "app/src/main/AndroidManifest.xml";
const PUBLISH = "scripts/publish-release.mjs";

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Source with comments removed, so a sentence about a rule is never read as the rule. */
function code(raw) {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[ \t])\/\/.*$/gm, "$1");
}

/** The text between the braces that open after `marker` (a regex), or null. */
function blockAfter(text, marker) {
  const m = marker.exec(text);
  if (!m) return null;
  const open = text.indexOf("{", m.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

/** Same rule as stripsInstallPermission() in build.gradle.kts: the element, not the prose. */
function stripsInstallPermission(xml) {
  const bare = xml.replace(/<!--[\s\S]*?-->/g, "");
  return /<uses-permission[^>]*REQUEST_INSTALL_PACKAGES[^>]*tools:node\s*=\s*["']remove["']/.test(bare);
}

// ---------------------------------------------------------------------------
// 1-5. The build file
// ---------------------------------------------------------------------------

/** Returns every way `kts` breaks the contract. Empty means it holds. */
function buildFileProblems(kts, { releaseManifest, mainManifest }) {
  const problems = [];
  const c = code(kts);

  // The map, and what it says.
  const mapText = c.match(/val selfUpdateByBuildType\s*:\s*Map<String,\s*Boolean>\s*=\s*mapOf\(([\s\S]*?)\n\)/);
  if (!mapText) return ["selfUpdateByBuildType is not declared as a Map<String, Boolean> = mapOf(...)"];
  const flags = {};
  for (const m of mapText[1].matchAll(/"([A-Za-z]+)"\s+to\s+(true|false)/g)) flags[m[1]] = m[2] === "true";
  const on = Object.keys(flags).filter((k) => flags[k]);
  if (on.length !== 1 || on[0] !== "link") {
    problems.push(`exactly one build type may self-update and it must be link; the map turns on: [${on}]`);
  }
  if (flags.release !== false) problems.push(`release must be false in the map, found ${flags.release}`);
  for (const must of ["link", "release", "debug"]) {
    if (!(must in flags)) problems.push(`the map has no entry for ${must}`);
  }

  // One place sets the flag, from the map.
  const sets = [...c.matchAll(/buildConfigField\(\s*"boolean"\s*,\s*"SELF_UPDATE"/g)];
  if (sets.length !== 1) problems.push(`SELF_UPDATE must be declared exactly once, found ${sets.length}`);
  if (/"SELF_UPDATE"\s*,\s*"(true|false)"/.test(c)) {
    problems.push('SELF_UPDATE is given a literal value somewhere; it must come from selfUpdateByBuildType');
  }
  if (!/selfUpdateByBuildType\[\s*type\.name\s*\]/.test(c)) {
    problems.push("the SELF_UPDATE loop does not read selfUpdateByBuildType[type.name]");
  }

  // link and release.
  const release = blockAfter(c, /\n\s*release\s*\{/);
  const link = blockAfter(c, /create\(\s*"link"\s*\)\s*\{/);
  if (release === null) problems.push("no release build type block");
  if (link === null) problems.push('no create("link") build type');
  if (release !== null && link !== null) {
    if (!/initWith\(\s*getByName\(\s*"release"\s*\)\s*\)/.test(link)) {
      problems.push("link must be initWith(getByName(\"release\"))");
    }
    const signingOf = (b) => (b.match(/signingConfig\s*=\s*signingConfigs\.getByName\(\s*"([A-Za-z]+)"\s*\)/) || [])[1];
    if (!signingOf(release)) problems.push("release does not set its signingConfig");
    if (!signingOf(link)) problems.push("link does not set its signingConfig: an unsigned or wrongly signed link APK is a different app to Android");
    if (signingOf(release) && signingOf(link) && signingOf(release) !== signingOf(link)) {
      problems.push(`link signs with "${signingOf(link)}" but release signs with "${signingOf(release)}"`);
    }
    // link may only inherit and re-state signing. Anything else it overrides is a
    // difference from release that the contract forbids.
    for (const forbidden of ["isDebuggable", "isMinifyEnabled", "isShrinkResources", "proguardFiles", "applicationId", "versionNameSuffix", "buildConfigField"]) {
      if (new RegExp(`\\b${forbidden}\\b`).test(link)) {
        problems.push(`link sets ${forbidden}; it must be identical to release in everything but SELF_UPDATE`);
      }
    }
    for (const required of [/isDebuggable\s*=\s*false/, /isMinifyEnabled\s*=\s*true/, /isShrinkResources\s*=\s*true/, /proguardFiles\(/]) {
      if (!required.test(release)) problems.push(`release lost ${required}`);
    }
  }

  // One application id, no suffix on anything.
  const ids = [...c.matchAll(/\bapplicationId\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  if (ids.length !== 1 || ids[0] !== "com.fenceestimator.app") {
    problems.push(`applicationId must be set once to com.fenceestimator.app, found [${ids}]`);
  }
  // Assignments only: the drift check in the build file READS both properties to
  // forbid them, so the bare words legitimately appear.
  if (/\bapplicationIdSuffix\s*=[^=]/.test(c)) problems.push("applicationIdSuffix is assigned: a different id is a different app to Android");
  if (/\bversionNameSuffix\s*=[^=]/.test(c)) problems.push("versionNameSuffix is assigned");

  // Manifest vs flag.
  if (!stripsInstallPermission(releaseManifest)) {
    problems.push("the release manifest does not remove REQUEST_INSTALL_PACKAGES, so the Play build would ask for it");
  }
  if (!/uses-permission[^>]*REQUEST_INSTALL_PACKAGES/.test(mainManifest.replace(/<!--[\s\S]*?-->/g, ""))) {
    problems.push("the main manifest does not declare REQUEST_INSTALL_PACKAGES, so the link build could never install an update");
  }

  // Drive copy: link only, after assembleLink, nothing from the other builds.
  if (!/tasks\.matching\s*\{\s*it\.name\s*==\s*"assembleLink"\s*\}\.configureEach\s*\{\s*finalizedBy\(\s*"copyLinkApkToDrive"\s*\)/.test(c)) {
    problems.push("copyLinkApkToDrive is not wired to assembleLink alone");
  }
  if (/assembleDebug|assembleRelease/.test(c)) problems.push("assembleDebug or assembleRelease is still wired to something");
  if (/app-debug\.apk|app-release\.apk|apk\/debug|apk\/release/.test(c)) problems.push("the Drive copy names the debug or release APK");
  if (!/outputs\/apk\/link\/app-link\.apk/.test(c)) problems.push("the Drive copy does not read outputs/apk/link/app-link.apk");
  if (!/driveApkName\s*=\s*"fenceflow\.apk"/.test(c)) problems.push("Drive name is not fenceflow.apk");

  // The build refuses to drift, and refuses an unsigned link build.
  if (!/verifyVariantContract\(\s*buildTypes\s*,\s*selfUpdateByBuildType/.test(c)) {
    problems.push("verifyVariantContract is never called with the build types");
  }
  if (!/linkBuildRequested\s*&&\s*!hasKeystore/.test(c)) problems.push("asking for the link build without a keystore is not refused");

  return problems;
}

const realFiles = () => ({ releaseManifest: read(RELEASE_MANIFEST), mainManifest: read(MAIN_MANIFEST) });

test("the build file holds the variant contract", () => {
  const problems = buildFileProblems(read(GRADLE), realFiles());
  assert.deepEqual(problems, []);
});

// Scratch copies: write the mutated file to disk and check THAT, so the planted
// failure goes through exactly the path the real one does.
const scratch = mkdtempSync(join(tmpdir(), "a27-variant-"));
let n = 0;
function plant(name, mutate, expect, which = "gradle") {
  test(`planted failure is caught: ${name}`, () => {
    const files = realFiles();
    let kts = read(GRADLE);
    if (which === "gradle") {
      const mutated = mutate(kts);
      assert.notEqual(mutated, kts, `the plant "${name}" changed nothing, so it proves nothing`);
      kts = mutated;
    } else if (which === "releaseManifest") {
      const mutated = mutate(files.releaseManifest);
      assert.notEqual(mutated, files.releaseManifest, `the plant "${name}" changed nothing`);
      files.releaseManifest = mutated;
    } else if (which === "mainManifest") {
      const mutated = mutate(files.mainManifest);
      assert.notEqual(mutated, files.mainManifest, `the plant "${name}" changed nothing`);
      files.mainManifest = mutated;
    }
    const file = join(scratch, `build-${++n}.gradle.kts`);
    writeFileSync(file, kts);
    const problems = buildFileProblems(readFileSync(file, "utf8"), files);
    assert.ok(problems.length > 0, `"${name}" was NOT caught`);
    assert.ok(problems.some((p) => expect.test(p)), `caught, but not for the right reason: ${problems.join(" | ")}`);
  });
}

plant("release set to self-update", (s) => s.replace('"release" to false', '"release" to true'), /release/);
plant("link set NOT to self-update", (s) => s.replace('"link" to true', '"link" to false'), /link/);
plant("debug set to self-update as well", (s) => s.replace('"debug" to false', '"debug" to true'), /exactly one/);
plant("link loses its signing config", (s) =>
  s.replace(/(create\("link"\) \{[\s\S]*?)\n\s*if \(hasKeystore\) \{\n\s*signingConfig = signingConfigs\.getByName\("release"\)\n\s*\}/, "$1"),
  /link does not set its signingConfig/);
plant("link signs with a different key", (s) =>
  s.replace(/(create\("link"\) \{[\s\S]*?signingConfigs\.getByName\()"release"/, '$1"debug"'), /link signs with/);
plant("link gets an application id suffix", (s) =>
  s.replace('create("link") {', 'create("link") {\n            applicationIdSuffix = ".link"'), /applicationIdSuffix|suffix/);
plant("link turns shrinking off", (s) =>
  s.replace('create("link") {', 'create("link") {\n            isMinifyEnabled = false'), /link sets isMinifyEnabled/);
plant("a literal SELF_UPDATE comes back in defaultConfig", (s) =>
  s.replace('buildConfigField("boolean", "IS_DEV_BACKEND", isDevBackend.toString())',
    'buildConfigField("boolean", "IS_DEV_BACKEND", isDevBackend.toString())\n        buildConfigField("boolean", "SELF_UPDATE", "true")'),
  /SELF_UPDATE/);
plant("debug is copied to Drive again", (s) =>
  s.replace('it.name == "assembleLink"', 'it.name == "assembleDebug"'), /copyLinkApkToDrive is not wired|assembleDebug/);
plant("the drift check is no longer called", (s) =>
  s.replace(/verifyVariantContract\(buildTypes, selfUpdateByBuildType, projectDir\)/, "// removed"), /verifyVariantContract/);
plant("the unsigned-link refusal is removed", (s) => s.replace("linkBuildRequested && !hasKeystore", "false"), /without a keystore/);
plant("the Play manifest stops stripping the permission", (s) => s.replace(/tools:node="remove"/, 'tools:node="merge"'), /release manifest/, "releaseManifest");
plant("the Play manifest keeps only the PROSE about the permission", (s) =>
  s.replace(/<uses-permission[\s\S]*?\/>/, ""), /release manifest/, "releaseManifest");
plant("the main manifest forgets the permission", (s) =>
  s.replace(/<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" \/>/, ""), /main manifest/, "mainManifest");

test("no other source set quietly strips the permission from a self-updating build", () => {
  const src = join(ROOT, "app", "src");
  for (const dir of readdirSync(src)) {
    const manifest = join(src, dir, "AndroidManifest.xml");
    if (dir === "release" || !existsSync(manifest)) continue;
    assert.ok(!stripsInstallPermission(readFileSync(manifest, "utf8")),
      `app/src/${dir}/AndroidManifest.xml removes REQUEST_INSTALL_PACKAGES; only release (the Play build) may`);
  }
});

// ---------------------------------------------------------------------------
// 6. UpdateChecker
// ---------------------------------------------------------------------------

function checkerProblems(kt, settingsKt) {
  const problems = [];
  const c = code(kt);

  // One read of the flag, and the entry points all come through the one gate.
  const reads = c.match(/BuildConfig\.SELF_UPDATE/g) || [];
  if (reads.length !== 1) problems.push(`BuildConfig.SELF_UPDATE must be read exactly once (in selfUpdates), found ${reads.length}`);
  const outcome = blockAfter(c, /private suspend fun checkOutcome\(\)/);
  if (outcome === null) return [...problems, "no checkOutcome()"];
  if (!/^\s*if \(!selfUpdates\) return Outcome\.NotSelfUpdating/.test(outcome)) {
    problems.push("checkOutcome() does not begin with the self-update gate returning Outcome.NotSelfUpdating");
  }
  const queries = c.match(/postgrest\.from\("app_releases"\)/g) || [];
  if (queries.length !== 1) problems.push(`app_releases must be queried from exactly one place (behind the gate), found ${queries.length}`);

  // The lie this replaced: "I checked and there is nothing" for a question never asked.
  if (/Answered\(null\)/.test(c)) problems.push("Answered(null) is returned somewhere: that claims a check that never happened");
  if (!/data object NotSelfUpdating : Outcome/.test(c)) problems.push("Outcome has no NotSelfUpdating");
  if (!/data object NotSelfUpdating : Attempt/.test(c)) problems.push("there is no public Attempt.NotSelfUpdating");
  if (!/Outcome\.NotSelfUpdating -> Attempt\.NotSelfUpdating/.test(c)) problems.push("attemptNow() does not map the outcome to Attempt.NotSelfUpdating");

  // checkOnce must not spend retries and delays on a build that cannot ask.
  const once = blockAfter(c, /suspend fun checkOnce\(/);
  if (once === null || !/^\s*if \(!selfUpdates\) return null/.test(once)) {
    problems.push("checkOnce() does not return at once when the build does not self-update");
  }
  // check() has no query of its own; it delegates.
  const legacy = c.match(/suspend fun check\(\): AppRelease\? = (.*)/);
  if (!legacy || !/checkOutcome\(\)/.test(legacy[1])) problems.push("check() does not go through checkOutcome()");

  // A real check still says what it said: three members of CheckResult, no more,
  // and every one of them is handled where the settings row renders them.
  const members = [...(blockAfter(c, /sealed interface CheckResult/) || "").matchAll(/(?:data class|data object)\s+(\w+)/g)].map((m) => m[1]).sort();
  if (members.join(",") !== "Available,CouldNotCheck,UpToDate") {
    problems.push(`CheckResult members changed to [${members}]; SettingsScreen's exhaustive when would stop compiling`);
  }
  if (/UpdateChecker\.checkNow\(\)/.test(settingsKt)) {
    const when = blockAfter(settingsKt, /when \(result\)/);
    const handled = when === null ? [] : [...when.matchAll(/CheckResult\.(\w+)/g)].map((m) => m[1]);
    for (const m of members) {
      if (!handled.includes(m)) problems.push(`SettingsScreen renders checkNow() but its when does not handle ${m}`);
    }
  }
  return problems;
}

test("UpdateChecker has one gate and says so when it never asked", () => {
  assert.deepEqual(checkerProblems(read(CHECKER), read(SETTINGS)), []);
});

function plantChecker(name, mutate, expect) {
  test(`planted failure is caught: UpdateChecker, ${name}`, () => {
    const kt = read(CHECKER);
    const mutated = mutate(kt);
    assert.notEqual(mutated, kt, `the plant "${name}" changed nothing`);
    const file = join(scratch, `UpdateChecker-${++n}.kt`);
    writeFileSync(file, mutated);
    const problems = checkerProblems(readFileSync(file, "utf8"), read(SETTINGS));
    assert.ok(problems.some((p) => expect.test(p)), `not caught for the right reason: ${problems.join(" | ") || "(no problems at all)"}`);
  });
}

plantChecker("the old lie comes back", (s) =>
  s.replace("if (!selfUpdates) return Outcome.NotSelfUpdating", "if (!selfUpdates) return Outcome.Answered(null)"), /Answered\(null\)|gate/);
plantChecker("the gate is removed", (s) =>
  s.replace("        if (!selfUpdates) return Outcome.NotSelfUpdating\n", ""), /gate|NotSelfUpdating/);
plantChecker("check() grows its own ungated query again", (s) =>
  s.replace("suspend fun check(): AppRelease? = (checkOutcome() as? Outcome.Answered)?.release",
    'suspend fun check(): AppRelease? = SupabaseModule.client.postgrest.from("app_releases").select {}.decodeSingleOrNull<AppRelease>()'),
  /exactly one place|check\(\)/);
plantChecker("a second read of the flag appears", (s) =>
  s.replace("if (askedThisLaunch) return null", "if (!BuildConfig.SELF_UPDATE) return null\n        if (askedThisLaunch) return null"), /exactly once/);
plantChecker("checkOnce retries on a build that cannot ask", (s) =>
  s.replace("        if (!selfUpdates) return null\n        if (askedThisLaunch)", "        if (askedThisLaunch)"), /checkOnce/);
plantChecker("a fourth CheckResult member breaks the settings row", (s) =>
  s.replace("data object UpToDate : CheckResult", "data object UpToDate : CheckResult\n        data object Elsewhere : CheckResult"), /CheckResult members changed|does not handle/);

// ---------------------------------------------------------------------------
// 7. The publish script
// ---------------------------------------------------------------------------

/** Pulls a top-level function out of the script's source and returns it as a callable. */
function extractFunction(source, name) {
  const m = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(source);
  assert.ok(m, `${name} not found in ${PUBLISH}`);
  return new Function(`${m[0]}\nreturn ${name};`)();
}

const RELEASE_BADGING = `package: name='com.fenceestimator.app' versionCode='557' versionName='1.557'
uses-permission: name='android.permission.INTERNET'
uses-permission: name='android.permission.POST_NOTIFICATIONS'
application-label:'FenceFlow'`;
const LINK_BADGING = RELEASE_BADGING.replace(
  "uses-permission: name='android.permission.INTERNET'",
  "uses-permission: name='android.permission.INTERNET'\nuses-permission: name='android.permission.REQUEST_INSTALL_PACKAGES'");
const REAL_SIGNER = "Signer #1 certificate DN: CN=Marc Henry Beaunissant, OU=Unknown, O=Fencing Flow\nSigner #1 certificate SHA-256 digest: 7b10779546df32d5\n";
const DEBUG_SIGNER = "Signer #1 certificate DN: C=US, O=Android, CN=Android Debug\nSigner #1 certificate SHA-256 digest: 00\n";

function publishJudgement(source) {
  const linkBuildProblems = extractFunction(source, "linkBuildProblems");
  const signerProblems = extractFunction(source, "signerProblems");
  const results = {
    // the Play-shaped build: no install permission
    play: linkBuildProblems(RELEASE_BADGING),
    // the link build
    link: linkBuildProblems(LINK_BADGING),
    debuggable: linkBuildProblems(LINK_BADGING + "\napplication-debuggable"),
    wrongId: linkBuildProblems(LINK_BADGING.replace("com.fenceestimator.app", "com.fenceestimator.app.link")),
    // exit status 1 WITH certificates printed: a damaged signature, which only
    // the exit status catches
    unsigned: signerProblems(1, REAL_SIGNER),
    debugKey: signerProblems(0, DEBUG_SIGNER),
    goodKey: signerProblems(0, REAL_SIGNER),
    noSigner: signerProblems(0, ""),
  };
  return results;
}

test("the publish script tells the link build from every other build", () => {
  const r = publishJudgement(read(PUBLISH));
  assert.deepEqual(r.link, [], "the link build must pass");        // positive control
  assert.deepEqual(r.goodKey, [], "a real signing key must pass");  // positive control
  assert.ok(r.play.some((p) => /REQUEST_INSTALL_PACKAGES/.test(p)), "the Play-shaped build must be refused");
  assert.ok(r.debuggable.some((p) => /debuggable/.test(p)), "a debuggable build must be refused");
  assert.ok(r.wrongId.some((p) => /package/.test(p)), "a different application id must be refused");
  assert.ok(r.unsigned.length > 0, "an unsigned APK must be refused");
  assert.ok(r.debugKey.some((p) => /debug key/.test(p)), "the shared debug key must be refused");
  assert.ok(r.noSigner.length > 0, "no signer certificate at all must be refused");
});

function plantPublish(name, mutate, key) {
  test(`planted failure is caught: publish script, ${name}`, () => {
    const src = read(PUBLISH);
    const mutated = mutate(src);
    assert.notEqual(mutated, src, `the plant "${name}" changed nothing`);
    const file = join(scratch, `publish-${++n}.mjs`);
    writeFileSync(file, mutated);
    const r = publishJudgement(readFileSync(file, "utf8"));
    // With the wall knocked down the case that must be refused comes back clean.
    assert.deepEqual(r[key], [], `"${name}" did not let ${key} through, so the check was not what stopped it`);
  });
}

plantPublish("the permission check is removed", (s) =>
  s.replace(/if \(!\/uses-permission: name='android\\\.permission\\\.REQUEST_INSTALL_PACKAGES'\/\.test\(badging\)\) \{/, "if (false) {"), "play");
plantPublish("the debug-key check is removed", (s) =>
  s.replace(/if \(\/certificate DN:\.\*Android Debug\/i\.test\(output\)\) \{/, "if (false) {"), "debugKey");
plantPublish("the debuggable check is removed", (s) =>
  s.replace(/if \(\/application-debuggable\/\.test\(badging\)\) \{/, "if (false) {"), "debuggable");
plantPublish("an unsigned APK is waved through", (s) =>
  s.replace("if (exitCode !== 0) {", "if (false) {"), "unsigned");
plantPublish("a missing signer certificate is waved through", (s) =>
  s.replace("if (!/Signer #\\d+ certificate DN:/.test(output)) {", "if (false) {"), "noSigner");

function publishStaticProblems(source) {
  const problems = [];
  const c = code(source);
  if (/app-release\.apk|apk\/release|app-debug\.apk|apk\/debug/.test(c)) problems.push("the script names the release or debug APK in code");
  if (!/LINK_APK_REL\s*=\s*"app\/build\/outputs\/apk\/link\/app-link\.apk"/.test(c)) problems.push("LINK_APK_REL is not the link build output");
  if (!/args\.includes\("--release"\)\)\s*\{[\s\S]*?process\.exit\(1\)/.test(c)) problems.push("--release is not refused");
  const check = c.indexOf("if (downloadUrl === null) refuseUnlessLinkBuild()");
  const gates = c.indexOf("const gates = [");
  if (check < 0) problems.push("refuseUnlessLinkBuild() is never called");
  else if (gates >= 0 && check > gates) problems.push("refuseUnlessLinkBuild() runs AFTER the gates; the cheap check must come first");
  if (!/copyFileSync\(apk, target\)/.test(c)) problems.push("the Drive spare copy no longer copies the checked apk");
  if (!/join\(folder, "fenceflow\.apk"\)/.test(c)) problems.push("the Drive copy is not named fenceflow.apk");
  return problems;
}

test("the publish script only ever names the link build", () => {
  assert.deepEqual(publishStaticProblems(read(PUBLISH)), []);
});

function plantPublishStatic(name, mutate, expect) {
  test(`planted failure is caught: publish script, ${name}`, () => {
    const src = read(PUBLISH);
    const mutated = mutate(src);
    assert.notEqual(mutated, src);
    const problems = publishStaticProblems(mutated);
    assert.ok(problems.some((p) => expect.test(p)), `not caught: ${problems.join(" | ") || "(none)"}`);
  });
}
plantPublishStatic("it goes back to publishing the release APK", (s) =>
  s.replace('"app/build/outputs/apk/link/app-link.apk"', '"app/build/outputs/apk/release/app-release.apk"'), /LINK_APK_REL|release or debug/);
plantPublishStatic("the check is skipped", (s) =>
  s.replace("if (downloadUrl === null) refuseUnlessLinkBuild();", ""), /never called/);
plantPublishStatic("the check moves behind the gates", (s) =>
  s.replace("if (downloadUrl === null) refuseUnlessLinkBuild();", "")
    .replace("for (const [name, argv, runner] of gates) {",
      "if (downloadUrl === null) refuseUnlessLinkBuild();\n  for (const [name, argv, runner] of gates) {"), /AFTER the gates/);

// Behaviour of the real script, as far as it can be run without a build or a network:
// the argument-level refusal happens before anything else does.
test("publish-release.mjs refuses --release outright", () => {
  const run = spawnSync(process.execPath, [join(ROOT, "scripts", "publish-release.mjs"), "x", "--release"],
    { encoding: "utf8", timeout: 20000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--release is no longer a thing this script does/);
  assert.match(run.stderr, /assembleLink/);
});

test("publish-release.mjs refuses when there is no link APK, before any gate", () => {
  // A copy of the script in a scratch repo with no build output: REPO_ROOT is
  // derived from the script's own location, so it looks there.
  const repo = mkdtempSync(join(tmpdir(), "a27-repo-"));
  mkdirSync(join(repo, "scripts"));
  copyFileSync(join(ROOT, "scripts", "publish-release.mjs"), join(repo, "scripts", "publish-release.mjs"));
  const run = spawnSync(process.execPath, [join(repo, "scripts", "publish-release.mjs"), "x", "--dry-run"],
    { encoding: "utf8", timeout: 20000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /No link APK at app\/build\/outputs\/apk\/link\/app-link\.apk/);
  assert.doesNotMatch(run.stderr + run.stdout, /gate/, "a gate ran before the APK was checked");
});

// The real Play-shaped APK, if this machine has built one: the file that was
// sitting in Drive as fenceflow.apk when this was written. Put in the link slot of
// a scratch repo, the script must refuse it from its bytes. Skipped (and said so)
// without the SDK build-tools or without that APK.
test("publish-release.mjs refuses a real Play-shaped APK found in the link slot", (t) => {
  const playApk = join(ROOT, "app", "build", "outputs", "apk", "release", "app-release.apk");
  if (!existsSync(playApk)) return t.skip("no app-release.apk built on this machine");
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(process.env.LOCALAPPDATA || "", "Android", "Sdk");
  if (!existsSync(join(sdk, "build-tools"))) return t.skip("no Android SDK build-tools on this machine");

  const repo = mkdtempSync(join(tmpdir(), "a27-play-"));
  mkdirSync(join(repo, "scripts"));
  mkdirSync(join(repo, "app", "build", "outputs", "apk", "link"), { recursive: true });
  copyFileSync(join(ROOT, "scripts", "publish-release.mjs"), join(repo, "scripts", "publish-release.mjs"));
  copyFileSync(playApk, join(repo, "app", "build", "outputs", "apk", "link", "app-link.apk"));
  const run = spawnSync(process.execPath, [join(repo, "scripts", "publish-release.mjs"), "x", "--dry-run"],
    { encoding: "utf8", timeout: 60000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /it is not the link build/);
  assert.match(run.stderr, /REQUEST_INSTALL_PACKAGES/);
  assert.doesNotMatch(run.stderr + run.stdout, /gate/, "a gate ran before the APK was checked");
});

// ---------------------------------------------------------------------------
// The doc he reads at midnight
// ---------------------------------------------------------------------------

test("docs/BUILD_VARIANTS.md names the commands and the reason", () => {
  const doc = read("docs/BUILD_VARIANTS.md");
  for (const needle of ["assembleLink", "assembleRelease", "bundleRelease", "app-link.apk", "fenceflow.apk",
    "REQUEST_INSTALL_PACKAGES", "publish-release.mjs", "selfUpdateByBuildType"]) {
    assert.ok(doc.includes(needle), `BUILD_VARIANTS.md does not mention ${needle}`);
  }
});
