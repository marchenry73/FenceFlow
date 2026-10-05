#!/usr/bin/env node
/**
 * Tells every phone there is a new version.
 *
 * The app checks `app_releases` on launch and shows a prompt when it finds a
 * version newer than its own. This is what puts the row there.
 *
 * Usage:
 *   node scripts/publish-release.mjs "What changed, in a sentence"
 *   node scripts/publish-release.mjs "Fixes a wrong total on the invoice" --urgent
 *   node scripts/publish-release.mjs "Try the new wizard" --company <uuid> --company <uuid>
 *
 * The version number is taken from the commit count, exactly as the build
 * takes it, so the two cannot disagree. Build first, then publish -- otherwise
 * you announce a version whose APK is not on Drive yet.
 *
 * WHICH APK. Only ever the LINK build:  ./gradlew assembleLink
 *   -> app/build/outputs/apk/link/app-link.apk
 * That is the build handed out by link, the only one that can update itself, and
 * the only one that belongs in Drive as fenceflow.apk. The Play-shaped release
 * build has no updater and no install permission, so publishing it tells every
 * phone to update to an APK that can never update them again. There is no flag
 * to publish it (--release is refused), and the APK about to be uploaded is
 * opened and checked before any gate runs: it must be com.fenceestimator.app,
 * declare REQUEST_INSTALL_PACKAGES, not be debuggable, and be signed with a key
 * that is not Android's shared debug key. See docs/BUILD_VARIANTS.md.
 *
 * --at <date-time> schedules it: phones see it from then on.
 * --urgent marks the update mandatory: the prompt has no "Later" and cannot be
 * dismissed. Reserve it for money and data. An app that insists on updating for
 * a colour change teaches people to ignore the one that matters.
 *
 * --company <uuid> (repeatable) publishes to a LIMITED audience instead of
 * everyone -- specific companies, by id, get offered this build; nobody else
 * does. See supabase_release_audience_patch.sql for why company is the only
 * audience unit this schema can honestly name, and why an anonymous phone
 * (no session yet) never sees a limited release even if its own company is
 * on the list. A limited release does not replace or hide whatever the
 * general population is already on -- everyone else keeps seeing the last
 * 'everyone' release, so nobody is left with no update available at all.
 * Promoting it to everyone once it holds up is a separate, deliberate act --
 * from the staff console's Releases panel, not from this script.
 *
 * If you publish limited and never promote: the audience you named keeps
 * getting exactly that build, forever, and everybody else stays on whatever
 * came before it. That is a stuck rollout, not a stranded fleet -- the fix is
 * to go promote it, not to republish.
 *
 * There is deliberately no way to publish from the app itself -- app_releases
 * has no write policy, so a compromised phone cannot tell your whole company to
 * install something. This script goes through the Supabase CLI, which uses your
 * own login rather than a key stored anywhere.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const PROJECT_REF = "newcrgafcptspmapacrx";
const REPO_ROOT = resolve(import.meta.dirname, "..");

const args = process.argv.slice(2);
const urgent = args.includes("--urgent");

// The ONE APK this script will publish: the link build, the only one that can
// update itself. Not a parameter, deliberately -- a path you can override is a
// path somebody overrides with the wrong file at midnight.
const LINK_APK_REL = "app/build/outputs/apk/link/app-link.apk";
const apk = join(REPO_ROOT, ...LINK_APK_REL.split("/"));

// --release used to mean "publish the signed build instead of the debug one".
// There is no longer a second build to choose, and the one it would now name is
// the Play-shaped build, which must never be published: it has no updater and no
// install permission. Refused rather than ignored, so nobody who types it out of
// habit is left believing it did something.
if (args.includes("--release")) {
  console.error("Refusing: --release is no longer a thing this script does.\n");
  console.error("This script publishes the LINK build only -- the one that can update itself.");
  console.error("The release build is the Play-shaped one: no updater, no install permission.");
  console.error("Publishing it would tell every phone to update to an app that can never");
  console.error("update again, and putting it in Drive as fenceflow.apk is how that happens.\n");
  console.error("  ./gradlew assembleLink");
  console.error('  node scripts/publish-release.mjs "What changed"\n');
  console.error("See docs/BUILD_VARIANTS.md.");
  process.exit(1);
}

// Where people actually get the APK. Without it the prompt appears with a
// button that does nothing, which reads as the app being broken -- so this is
// remembered from the last release and reused when omitted. Set it once.
const urlFlag = args.findIndex((a) => a === "--url");
const downloadUrl = urlFlag >= 0 ? (args[urlFlag + 1] || "") : null;

// Every value that follows a --company flag, in order. Repeatable rather
// than comma-separated so a typo in one id doesn't require re-parsing a list
// -- each is just "the next word after --company".
// --at "2026-09-20T07:00-04:00": phones do not see the release before then.
// app_releases_read already hides rows whose available_from is in the future.
const atFlag = args.findIndex((a) => a === "--at");
const availableFrom = atFlag >= 0 ? (args[atFlag + 1] || "") : null;
if (availableFrom !== null && Number.isNaN(Date.parse(availableFrom))) {
  console.error(`"${availableFrom}" after --at is not a date/time.`);
  process.exit(1);
}

const companyIds = args
  .map((a, i) => (a === "--company" ? args[i + 1] : null))
  .filter((v) => v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
for (const id of companyIds) {
  if (!UUID_RE.test(id)) {
    console.error(`"${id}" after --company doesn't look like a company id (uuid).`);
    process.exit(1);
  }
}

const notes = args
  .filter((a, i) =>
    a !== "--urgent" && a !== "--skip-version-check" && a !== "--dry-run" && a !== "--url" &&
    a !== "--company" && !companyIds.includes(a) &&
    a !== "--at" && !(atFlag >= 0 && i === atFlag + 1) &&
    !(urlFlag >= 0 && i === urlFlag + 1))
  .join(" ").trim();

if (!notes) {
  console.error("Say what changed, so the prompt is worth reading.\n");
  console.error('  node scripts/publish-release.mjs "Fixes the invoice total"');
  console.error('  node scripts/publish-release.mjs "Fixes a payment bug" --urgent');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Is the file about to be published actually the link build?
//
// Before every gate, because the gates take minutes and this takes a second, and
// because shipping the wrong APK is not recoverable the way a red gate is: the
// Play-shaped build has no updater, so a phone that takes it can never be told
// about the fix. That is exactly the bug this guards against, and it reaches
// every phone at once.
//
// Judged from the bytes of the file, not from its name or its folder -- a
// Play-shaped APK copied into the link folder must still be caught.
// ---------------------------------------------------------------------------

/**
 * Judges the output of `aapt2 dump badging`. Returns the reasons it is NOT the
 * link build; an empty list means it is.
 */
function linkBuildProblems(badging) {
  const problems = [];
  // Same applicationId as the build on the phone: a different id is a different
  // app to Android, and the phone would open it with nothing in it.
  if (!/package: name='com\.fenceestimator\.app'/.test(badging)) {
    problems.push("its package is not com.fenceestimator.app, so it would not replace the app on a phone");
  }
  // The Play-shaped build has this permission removed (app/src/release/
  // AndroidManifest.xml). Without it the update prompt cannot install anything.
  if (!/uses-permission: name='android\.permission\.REQUEST_INSTALL_PACKAGES'/.test(badging)) {
    problems.push("it does not declare REQUEST_INSTALL_PACKAGES -- that is the Play-shaped build, which cannot install an update");
  }
  // A debuggable build lets anyone with a cable read the database off the phone.
  if (/application-debuggable/.test(badging)) {
    problems.push("it is debuggable -- that is the debug build");
  }
  return problems;
}

/**
 * Judges the output of `apksigner verify --print-certs`. An unsigned APK will not
 * install at all; one signed with the shared debug key is a different app to
 * Android than the release-signed one on the phone, and will not install over it.
 */
function signerProblems(exitCode, output) {
  const problems = [];
  if (exitCode !== 0) {
    problems.push("its signature does not verify (unsigned, or damaged)");
    return problems;
  }
  if (!/Signer #\d+ certificate DN:/.test(output)) {
    problems.push("apksigner reported no signer certificate");
  }
  if (/certificate DN:.*Android Debug/i.test(output)) {
    problems.push("it is signed with Android's shared debug key, not the release key");
  }
  return problems;
}

/** The newest installed Android build-tools file at this path, or null. */
function buildToolFile(...rel) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT ||
    join(process.env.LOCALAPPDATA || "", "Android", "Sdk");
  const toolDir = join(sdk, "build-tools");
  if (!existsSync(toolDir)) return null;
  for (const v of readdirSync(toolDir).sort().reverse()) {
    const p = join(toolDir, v, ...rel);
    if (existsSync(p)) return p;
  }
  return null;
}

function refuseUnlessLinkBuild() {
  const fail = (lines) => {
    for (const l of lines) console.error(l);
    process.exit(1);
  };

  if (!existsSync(apk)) {
    fail([
      `No link APK at ${LINK_APK_REL}.`,
      "",
      "  ./gradlew assembleLink",
      "",
      "Only the link build is published: it is the one that can update itself.",
      "The release build is the Play-shaped one and is never published from here.",
    ]);
  }

  const aapt = buildToolFile(process.platform === "win32" ? "aapt2.exe" : "aapt2");
  const apksigner = buildToolFile("lib", "apksigner.jar");
  if (!aapt || !apksigner) {
    // No flag to wave this through. Publishing a build nobody could inspect is how
    // the wrong one reaches every phone, and the cost of installing the SDK
    // build-tools is a few minutes.
    fail([
      "Cannot check which build this APK is: the Android SDK build-tools (aapt2 and",
      "lib/apksigner.jar) were not found under ANDROID_HOME, ANDROID_SDK_ROOT or",
      "%LOCALAPPDATA%/Android/Sdk. Install them, or set ANDROID_HOME.",
      "",
      "Refusing to publish an APK that has not been inspected.",
    ]);
  }

  let badging;
  try {
    badging = execFileSync(aapt, ["dump", "badging", apk], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    fail([`Could not read ${LINK_APK_REL} with aapt2: ${String(e.message).split("\n")[0]}`]);
  }

  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : "java";
  const signed = spawnSync(java, ["-jar", apksigner, "verify", "--print-certs", apk], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (signed.error) {
    fail([`Could not run apksigner (needs java on PATH or JAVA_HOME): ${signed.error.message}`]);
  }
  const signerText = String(signed.stdout || "") + String(signed.stderr || "");

  const problems = [...linkBuildProblems(badging), ...signerProblems(signed.status, signerText)];
  if (problems.length > 0) {
    fail([
      `Refusing to publish ${LINK_APK_REL}: it is not the link build.`,
      ...problems.map((p) => "  - " + p),
      "",
      "Only the link build is published: it can update itself, and it is the APK that",
      "belongs in Drive as fenceflow.apk. Rebuild it:",
      "",
      "  ./gradlew assembleLink",
      "",
      "See docs/BUILD_VARIANTS.md.",
    ]);
  }

  // So the owner can see which key it is without opening anything. This script
  // cannot know which key is RIGHT -- only that it is a real one, not the shared
  // debug key -- so it prints the fingerprint instead of claiming more. The same
  // fingerprint as the build on the phone means the update installs over it; a
  // different one means a different app to Android.
  const digest = signerText.match(/certificate SHA-256 digest: ([0-9a-f]+)/i);
  console.log(`link APK checked: com.fenceestimator.app, can self-update, signed, not debuggable` +
    (digest ? ` (key SHA-256 ${digest[1].slice(0, 16)}...)` : ""));
}

// Only when this run would upload the APK. With --url nothing here is uploaded.
if (downloadUrl === null) refuseUnlessLinkBuild();

// The version the APK carries, and the version this run would announce.
//
// Read here rather than further down because the two have to AGREE and the
// comparison costs a git call and an aapt2 call. On 4 October it sat behind the
// gate block instead, and a mismatch that was certain from the first second
// was going to be reported after two hours of parity and unit tests. Nothing
// is uploaded by this check, so the rule that no byte ships before parity
// passes is untouched.
//
// Building before committing stamps the APK with the OLD commit count, so the
// release row says 112 while the file inside says 111. The app then installs
// it, still reads itself as older than the announcement, and prompts to update
// forever -- an update loop that reports success at every step.
const code = versionCode();
const name = `1.${code}`;

if (downloadUrl === null) {
  const stamped = stampedVersion();
  if (stamped !== null && stamped !== code) {
    console.error(`The APK says version ${stamped}, but this would publish ${code}.`);
    console.error("");
    console.error("That mismatch causes an endless update prompt. It happens when the");
    console.error("APK was built before the last commit -- the version comes from the");
    console.error("commit count, so committing after building leaves the APK behind.");
    console.error("");
    console.error("  ./gradlew assembleLink      # rebuild at the current commit");
    console.error("  node scripts/publish-release.mjs \"...\"");
    process.exit(1);
  }
  if (stamped === null) {
    console.error("Could not read the version stamped inside the APK, so it cannot");
    console.error("be checked against the " + code + " this would announce.");
    console.error("");
    console.error("Publishing unverified is how the update loop happens, so this stops");
    console.error("here. Pass --skip-version-check to publish anyway.");
    if (!args.includes("--skip-version-check")) process.exit(1);
  }
}

// The pricing parity gate, before anything else happens -- before the dry
// run, before the version check, before a byte is uploaded. The phone and
// the server each carry a copy of the pricing engine, and a release of one
// that disagrees with the other is the office quoting a different number
// from the phone. There is deliberately no flag to skip this.
{
  // Every gate runs before a byte is uploaded, and none of them has a flag to
  // skip it. A gate you can wave through is a suggestion.
  //
  // These are the checks that have each already caught a real break:
  //
  //   parity       the phone and the server carrying pricing engines that
  //                disagree, so the office quotes a different number
  //   web pages    a stray apostrophe left the office on "Loading your
  //                office…" for a day and a half, and a duplicate element id
  //                made one panel write its rows into another's table
  //   app tests    the crew money boundary is guarded by a test that reads the
  //                source; a refactor slipped past it once already
  //
  // The app tests are the slow one, about ninety seconds. That is the point:
  // it is cheaper than a release that loses a crew's hours.
  const gates = [
    ["pricing parity", [join(REPO_ROOT, "scripts", "check-parity.mjs")]],
    ["web pages", [join(REPO_ROOT, "tests", "dashboard-syntax.test.mjs")]],
    // Against the live system, not the source: what anonymous callers can read,
    // what a quote link gives away, and whether a forged payment lands.
    ["security", [join(REPO_ROOT, "tests", "security-smoke.test.mjs")]],
    // Everything downstream of the price. Pricing parity above proves the app
    // and the server agree on what a fence costs; these prove they agree on
    // what happens to that number afterwards -- posts, concrete, waste, tax,
    // deposit, balance, pay and job cost. Each file carries its own planted
    // failures, so a run that passes has just re-proved it was able to fail.
    // Added because parity guarded the price and nothing guarded the arithmetic
    // sitting on top of it, which is where a wrong number reaches a customer.
    ["posts, concrete, waste and tax", [join(REPO_ROOT, "tests", "downstream-posts-concrete-waste-tax.test.mjs")], "tsx"],
    ["deposit and balance", [join(REPO_ROOT, "tests", "downstream-deposit-balance.test.mjs")], "tsx"],
    // The office's copy of the accepted price, checked against the server's
    // own billableTotal() and depositFigures(): the price every owed figure,
    // report and invoice export on the office site bills against.
    ["accepted price at the office", [join(REPO_ROOT, "tests", "office-accepted-price.test.mjs")], "tsx"],
    ["pay and overtime", [join(REPO_ROOT, "tests", "downstream-pay-overtime.test.mjs")], "tsx"],
    ["job costing", [join(REPO_ROOT, "tests", "downstream-job-costing.test.mjs")]],
  ];
  for (const [name, argv, runner] of gates) {
    // Four of these import TypeScript straight from the edge functions, which
    // is the whole point -- they test the real shared pricing code rather than
    // a copy of it -- so they need a loader node does not have on its own.
    const gate = runner === "tsx"
      ? spawnSync("npx", ["--no-install", "tsx", ...argv],
          { cwd: REPO_ROOT, stdio: "inherit", shell: true })
      : spawnSync(process.execPath, argv, { cwd: REPO_ROOT, stdio: "inherit" });
    if (gate.status !== 0) {
      console.error(`\nRefusing to publish: the ${name} gate is red (see above).`);
      process.exit(1);
    }
  }

  // Gradle, so it needs the wrapper rather than node.
  {
    // An absolute path to the wrapper, not a bare name.
    //
    // This said "gradlew.bat" on Windows and relied on the shell finding it.
    // Git Bash does not put the working directory on PATH, so the spawn failed
    // with "not recognized" and a non-zero status -- which this gate then
    // reported as "the app unit tests are red". They were green. A gate that
    // cannot tell a failed test from a failed launch refuses good releases and
    // teaches everyone to distrust it.
    const wrapper = join(REPO_ROOT, process.platform === "win32" ? "gradlew.bat" : "gradlew");
    const tests = spawnSync(wrapper, ["testDebugUnitTest", "-q"], {
      cwd: REPO_ROOT, stdio: "inherit", shell: process.platform === "win32",
    });
    if (tests.error) {
      // A gate that cannot start is not a gate that failed. Told apart because
      // the fixes are different, and confusing them cost two good releases.
      console.error("Refusing to publish: could not run the app tests at all -- "
        + tests.error.message);
      process.exit(1);
    }
    if (tests.status !== 0) {
      console.error("\nRefusing to publish: the app unit tests are red (see above).");
      process.exit(1);
    }
  }
}

/** The same number the build stamps into the APK. */
function versionCode() {
  const out = execFileSync("git", ["rev-list", "--count", "HEAD"], {
    cwd: REPO_ROOT, encoding: "utf8",
  });
  return parseInt(out.trim(), 10);
}


// `apk` is the link build and nothing else: see the top of this file. A debug APK
// is signed with Android's shared key and is debuggable, so it is not fine in
// another company's hands; the release build is Play-shaped and cannot update
// anybody.

/**
 * Reads the version actually stamped inside the APK.
 *
 * Returns null when it cannot be read, which is treated as "cannot verify"
 * rather than "wrong" -- refusing to publish because a toolchain path moved
 * would be its own kind of broken.
 */
function stampedVersion() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT ||
    join(process.env.LOCALAPPDATA || "", "Android", "Sdk");
  const toolDir = join(sdk, "build-tools");
  if (!existsSync(toolDir) || !existsSync(apk)) return null;
  try {
    const versions = readdirSync(toolDir).sort();
    for (const v of versions.reverse()) {
      const aapt = join(toolDir, v, process.platform === "win32" ? "aapt2.exe" : "aapt2");
      if (!existsSync(aapt)) continue;
      const out = execFileSync(aapt, ["dump", "badging", apk], { encoding: "utf8" });
      const m = out.match(/versionCode=.([0-9]+)./);
      return m ? parseInt(m[1], 10) : null;
    }
  } catch { /* fall through to "cannot verify" */ }
  return null;
}

/**
 * Puts the APK somewhere the app can actually download it, and returns that URL.
 *
 * Google Drive cannot do this job. A restricted file redirects an anonymous
 * download to a sign-in page, and Drive interstitials APKs it cannot
 * virus-scan even when they are shared -- either way the app downloads HTML
 * and Android refuses to install a web page. That is not a setting to get
 * right; it is the wrong host for the file.
 *
 * The releases bucket is public on purpose, and it is the only public one. An
 * APK is not a secret: it is the app, and anybody with it installed already
 * has a copy. No company's jobs, customers or money live in that bucket.
 */
/**
 * A copy on the machine, beside every other project's builds.
 *
 * FenceFlow ships over the air, so this is NOT the distribution path -- phones
 * update from the release row, which points at the file just uploaded. This is
 * the spare: the shared APK folder is where every project on this machine keeps
 * a build that can be sideloaded when something is wrong with the hosted one.
 *
 * Deliberately last, deliberately quiet, and deliberately unable to fail the
 * publish. The drive is a mounted Google Drive folder, so it can be missing,
 * syncing, or read-only, and none of that is a reason to refuse a release that
 * has already reached every phone.
 */
function keepASpareCopy(remote) {
  // Forward slashes on purpose. Node takes them on Windows, and a backslash
  // here is one more place for an escape to be eaten -- which is exactly what
  // happened on the first attempt: the path collapsed to "G:My DriveAPK Builds"
  // and existsSync quietly said no, so the copy would have been skipped for
  // ever without a word.
  const folder = "G:/My Drive/Professional Documents/Projects/APK Builds";
  try {
    // Say so. This used to be a bare `return`, and on 24 September the folder
    // read as absent for the length of one publish -- Drive's mount comes and
    // goes -- so 1.528 shipped with 1.527 still sitting in the folder and not a
    // word about it anywhere in the output. The reminder printed at the end
    // ("Make sure the APK in that folder is this build") is the only thing that
    // stood between that and a stale sideload, and a reminder is not a check.
    if (!existsSync(folder)) {
      console.log("  (no spare copy: " + folder + " is not there right now --");
      console.log("   copy " + LINK_APK_REL + " over");
      console.log("   fenceflow.apk by hand, or that folder keeps the old build.");
      console.log("   The link build ONLY: never the release or the debug APK)");
      return;
    }
    // And verify the bytes landed, rather than trusting copyFileSync's silence:
    // the same mount that can vanish can also accept a write and lose it.
    // One file per app, overwritten every time.
    //
    // The shared folder reached 497 MB of superseded binaries and was eating
    // the Drive quota, so the convention changed on 11 September: no dates, no
    // hashes, no versions in the name. If a specific past build is ever needed
    // it gets rebuilt from the commit it came from, which is what the history
    // is for.
    //
    // The rule warns that this leaves no rollback copy. True for a sideloaded
    // app whose only copy lives here -- and not true for FenceFlow, whose
    // phones update from a release row pointing at storage that keeps every
    // build ever published. This file is a convenience for sideloading, not
    // the distribution path, so the single-file rule costs nothing here.
    //
    // `apk` is the link build, and refuseUnlessLinkBuild() opened it before
    // anything ran. That is what makes this safe: fenceflow.apk is the file that
    // gets sideloaded, so it must only ever hold the build that can update the
    // phone afterwards.
    const target = join(folder, "fenceflow.apk");
    copyFileSync(apk, target);
    const want = statSync(apk).size, got = statSync(target).size;
    if (want !== got) {
      console.log(`  (spare copy is WRONG: ${got} bytes, expected ${want} -- copy it by hand)`);
      return;
    }
    console.log(`  spare copy      ${target} (${got} bytes)`);
  } catch (e) {
    console.log("  (no spare copy: " + String(e.message).slice(0, 80) + ")");
  }
}

function uploadApk(code) {
  if (!existsSync(apk)) {
    console.warn("No link APK found. Run ./gradlew assembleLink first, or pass --url.\n");
    return null;
  }
  // A new name every publish.
  //
  // Storage refuses to overwrite an existing object, so reusing one name means
  // a republish silently keeps the OLD apk and hands people a build that is
  // not the one just made -- the worst possible failure for an update
  // mechanism, because everything reports success.
  //
  // The commit hash makes each upload distinct without needing a delete first,
  // and it also makes the URL say exactly which build it is. Old files can be
  // cleared out of the bucket whenever; nothing points at them once a newer
  // release row exists.
  const stamp = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: REPO_ROOT, encoding: "utf8",
  }).trim();
  const remote = `fenceflow-${code}-${stamp}.apk`;

  try {
    // A RELATIVE path, run from the repo root.
    //
    // shell:true is needed to launch npx.cmd on Windows, and the shell eats the
    // backslashes in an absolute Windows path -- the CLI received
    // "C:UsersmarchAndroidProjects..." and could not parse it. Going relative
    // sidesteps the quoting problem instead of fighting it.
    execFileSync(
      "npx.cmd",
      [
        "-y", "supabase", "storage", "cp", "--experimental",
        LINK_APK_REL,
        `"ss:///releases/${remote}"`,
        "--linked", "--project-ref", PROJECT_REF
      ],
      { encoding: "utf8", shell: true, cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] }
    );
    // Through the apk-proxy on purpose: it streams chunked (no Content-Length),
    // and phones on 1.134-1.136 crash the moment the updater can render a
    // progress percentage. The proxy serves the same bucket file byte-for-byte;
    // newer builds lose only the progress number.
    keepASpareCopy(remote);
    return `https://${PROJECT_REF}.supabase.co/functions/v1/apk-proxy?f=${remote}`;
  } catch (e) {
    // The CLI's own message, not just "command failed" -- which says nothing
    // about why and sent me chasing the wrong cause twice.
    const detail = String(e.stderr || e.stdout || e.message || "").trim();
    console.error("Could not upload the APK.\n  " + detail.slice(0, 400));
    // Stop. Do NOT fall through to the release row.
    //
    // A failed upload used to return null, and null meant "keep whatever URL
    // the last release had". So a publish whose upload failed still wrote a
    // new release row, pointing at the PREVIOUS build, and told every phone to
    // update -- announcing new work while shipping the old bytes, and exiting
    // zero. That happened on 10 September: storage refused the name as a
    // duplicate because nothing had been committed, so the commit hash in the
    // filename had not moved, and 1.416 was re-announced with yesterday's apk
    // behind it.
    //
    // A duplicate name is worth calling out by itself, because the cause is
    // almost always the same one and the CLI's wording does not say it.
    if (/KeyAlreadyExists|Duplicate|already exists/i.test(detail)) {
      console.error(
        "\nThat name is already taken in the bucket, which means the commit " +
        "hash has not moved.\nCommit this work first: the version number and " +
        "the file name both come from the commit count."
      );
    }
    process.exit(1);
  }
}

const esc = (s) => String(s).replace(/'/g, "''");

// An explicit --url wins. Otherwise the APK is uploaded and that URL is used,
// so publishing is one command and the link can never point at a build that
// is not the one just made.

// Checking the checks. Publishing is not something to test against the live
// table -- a "test" publish is a real one, and every phone sees it.
if (args.includes("--dry-run")) {
  console.log(`Would publish ${name}${urgent ? " (mandatory)" : ""}`);
  console.log(`  notes: ${notes}`);
  console.log(`  audience: ${companyIds.length > 0 ? `limited to ${companyIds.length} compan${companyIds.length === 1 ? "y" : "ies"} (${companyIds.join(", ")})` : "everyone"}`);
  console.log(`  APK: ${LINK_APK_REL} (the link build, checked above)`);
  console.log(`  APK version check: ${stampedVersion() === code ? "matches" : "MISMATCH"}`);
  console.log("Nothing was uploaded or written.");
  process.exit(0);
}

const hostedUrl = downloadUrl === null ? uploadApk(code) : null;
const effectiveUrl = downloadUrl !== null ? downloadUrl : hostedUrl;

const urlExpr = effectiveUrl === null
  ? "coalesce((select download_url from public.app_releases order by version_code desc limit 1), '')"
  : "'" + esc(effectiveUrl) + "'";

const audience = companyIds.length > 0 ? "limited" : "everyone";

const sql = `
insert into public.app_releases (version_code, version_name, notes, is_mandatory, download_url, audience, available_from)
values (${code}, '${esc(name)}', '${esc(notes)}', ${urgent}, ${urlExpr}, '${audience}', ${availableFrom ? "'" + new Date(availableFrom).toISOString() + "'" : "null"})
on conflict (version_code) do update
  set version_name  = excluded.version_name,
      notes         = excluded.notes,
      is_mandatory  = excluded.is_mandatory,
      download_url  = excluded.download_url,
      audience      = excluded.audience,
      available_from = excluded.available_from;

-- Republishing the same version_code (the on conflict path above) must not
-- leave a stale audience from a previous attempt lying around next to a new
-- one -- so the membership list for this release is always rebuilt from
-- scratch rather than appended to.
delete from public.app_release_audience
 where release_id = (select id from public.app_releases where version_code = ${code});
${companyIds.map((id) =>
  `insert into public.app_release_audience (release_id, company_id)
   values ((select id from public.app_releases where version_code = ${code}), '${esc(id)}');`
).join("\n")}

select version_code, version_name, is_mandatory, download_url, audience from public.app_releases
order by version_code desc limit 1;
`;

const file = join(tmpdir(), `ff-release-${process.pid}.sql`);
writeFileSync(file, sql);

try {
  const out = execFileSync(
    "npx.cmd",
    ["-y", "supabase", "db", "query", "--linked", "--project-ref", PROJECT_REF, "-f", `"${file}"`],
    { encoding: "utf8", shell: true }
  );
  if (/"error"/.test(out)) {
    console.error("Publish failed:\n" + out);
    process.exit(1);
  }
  console.log(`Published version ${name}${urgent ? "  (mandatory)" : ""}`);
  console.log(`  "${notes}"`);

  if (companyIds.length > 0) {
    console.log(`  LIMITED audience: ${companyIds.length} compan${companyIds.length === 1 ? "y" : "ies"} only.`);
    console.log("  Nobody else will be offered this build until it is promoted from the");
    console.log("  Releases panel in the staff console. Forgetting to promote does not");
    console.log("  strand anyone -- everyone else just keeps seeing whatever came before.");
  }

  if (hostedUrl) console.log(`  hosted at ${hostedUrl}`);

  // Say so loudly. A release with no link shows a prompt people cannot act on.
  if (/"download_url":\s*""/.test(out)) {
    console.warn("\nWARNING: this release has no download link, so the prompt");
    console.warn("will tell people to look in the shared folder instead of");
    console.warn("opening it for them. Set one once and it is reused after that:");
    console.warn('  node scripts/publish-release.mjs "notes" --url "https://..."');
  }

  console.log(companyIds.length > 0
    ? "\nOnly signed-in phones at the named companies will prompt next time the app is opened."
    : "\nEvery phone will prompt next time the app is opened.");
  console.log("Make sure the APK in that folder is this build.");
} finally {
  rmSync(file, { force: true });
}
