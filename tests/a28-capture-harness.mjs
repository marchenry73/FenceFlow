// a28-capture-harness -- compile the REAL Kotlin sources of the crew enquiry capture, and run JUnit, without gradlew.
//
// Not a test (no .test. in the name; tests/a28-capture.test.mjs imports it). It exists because "bracket counting is not
// verification": the capture screen is Compose, the migration is Room and the permission change breaks an exhaustive
// `when` in another file if it is wrong, and none of that is checked by reading. This builds them.
//
// HOW, and what it does not touch. No gradlew, no build, nothing written to the repo (a cache directory under the OS temp
// dir). It uses:
//   * the Kotlin 2.0.21 compiler from the Gradle cache (the same one tests/a26-catalog-no-materials.test.mjs uses),
//   * the Compose compiler plugin for that Kotlin from the same cache,
//   * the app's own DEBUG COMPILE CLASSPATH, read out of app/build/kspCaches/debug/classpath-entries.bin (the jars the
//     last real build compiled against, every path checked to exist), so the libraries are the app's exact versions,
//   * the already-built app classes (app/build/tmp/kotlin-classes/debug) as "the rest of the app", with the edited and new
//     sources compiled over them (source wins over classpath), and -Xfriend-paths so `internal` members resolve as they do
//     in the real module,
//   * a SHADOW R built from the CURRENT values/strings.xml: a string name that is not in it does not exist, so a missing
//     resource fails to compile -- which is exactly how it breaks the real build.
//
// What it cannot do: run Room's annotation processor (KSP), so a @Query that Room would reject is not caught here (the
// a28 test runs every @Query against a real SQLite schema instead); and it does not run on a device.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
const posix = (p) => p.replace(/\\/g, "/");

function cacheJar(group, artifact, version, file) {
  const base = join(homedir(), ".gradle", "caches", "modules-2", "files-2.1", group, artifact, version);
  if (!existsSync(base)) return null;
  for (const h of readdirSync(base)) { const p = join(base, h, file); if (existsSync(p)) return p; }
  return null;
}

/** The jar paths the last debug build compiled against. Null if there has been no build to read. */
export function appClasspath() {
  const bin = join(ROOT, "app/build/kspCaches/debug/classpath-entries.bin");
  if (!existsSync(bin)) return null;
  const text = readFileSync(bin).toString("latin1");
  const found = [...new Set(text.match(/[A-Za-z]:[\\/][ -~]{5,400}?\.(?:jar|aar)/g) || [])];
  const have = found.filter((p) => existsSync(p));
  // The build's own R.jar is dropped: it does not know the strings this work adds, and a shadow R replaces it.
  return have.filter((p) => !/[\\/]R\.jar$/.test(p));
}

export function toolchain() {
  const K = "org.jetbrains.kotlin";
  const need = {
    compiler: cacheJar(K, "kotlin-compiler-embeddable", "2.0.21", "kotlin-compiler-embeddable-2.0.21.jar"),
    stdlib: cacheJar(K, "kotlin-stdlib", "2.0.21", "kotlin-stdlib-2.0.21.jar"),
    script: cacheJar(K, "kotlin-script-runtime", "2.0.21", "kotlin-script-runtime-2.0.21.jar"),
    reflect: cacheJar(K, "kotlin-reflect", "1.6.10", "kotlin-reflect-1.6.10.jar"),
    daemon: cacheJar(K, "kotlin-daemon-embeddable", "2.0.21", "kotlin-daemon-embeddable-2.0.21.jar"),
    trove: cacheJar("org.jetbrains.intellij.deps", "trove4j", "1.0.20200330", "trove4j-1.0.20200330.jar"),
    annotations: cacheJar("org.jetbrains", "annotations", "13.0", "annotations-13.0.jar"),
    coroutines: cacheJar("org.jetbrains.kotlinx", "kotlinx-coroutines-core-jvm", "1.8.0", "kotlinx-coroutines-core-jvm-1.8.0.jar"),
    compose: cacheJar(K, "kotlin-compose-compiler-plugin-embeddable", "2.0.21", "kotlin-compose-compiler-plugin-embeddable-2.0.21.jar"),
    junit: cacheJar("junit", "junit", "4.13.2", "junit-4.13.2.jar"),
    hamcrest: cacheJar("org.hamcrest", "hamcrest-core", "1.3", "hamcrest-core-1.3.jar"),
  };
  need.appClasses = existsSync(join(ROOT, "app/build/tmp/kotlin-classes/debug")) ? join(ROOT, "app/build/tmp/kotlin-classes/debug") : null;
  const cp = appClasspath();
  need.appClasspath = cp && cp.length > 100 ? cp : null;
  const missing = Object.entries(need).filter(([, v]) => !v).map(([k]) => k);
  return { need, missing };
}

/** A shadow R: every string name in the CURRENT values/strings.xml, so a name that is not there does not exist. */
function writeShadowR(work, stringsXml) {
  const names = [...new Set([...stringsXml.matchAll(/<string\s+name="([^"]+)"/g)].map((m) => m[1]))];
  let id = 0x7f100000;
  mkdirSync(join(work, "rsrc"), { recursive: true });
  mkdirSync(join(work, "rcls"), { recursive: true });
  const body = names.map((n) => "  public static final int " + n + " = " + id++ + ";").join("\n");
  writeFileSync(join(work, "rsrc", "R.java"),
    "package com.fenceestimator.app;\npublic final class R {\n public static final class string {\n" + body + "\n }\n}\n");
  const r = spawnSync("javac", ["-d", join(work, "rcls"), join(work, "rsrc", "R.java")], { encoding: "utf8" });
  return r.status === 0 ? { ok: true } : { ok: false, out: r.stderr };
}

function java(work, name, args, opts = {}) {
  // An argfile, because 150 jar paths do not fit a Windows command line.
  const file = join(work, name + ".args");
  writeFileSync(file, args.map((a) => (/\s|"/.test(a) ? '"' + a.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"' : a)).join("\n"));
  return spawnSync("java", ["@" + file], { encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024, ...opts });
}

function kotlinc(work, need, name, out, cp, sources, extra = [], friends = []) {
  const compilerCp = [need.compiler, need.stdlib, need.script, need.reflect, need.daemon, need.trove, need.annotations, need.coroutines].map(posix).join(delimiter);
  return java(work, name, [
    "-cp", compilerCp, "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
    "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-language-version", "2.0", "-nowarn",
    "-Xfriend-paths=" + [need.appClasses, ...friends].map(posix).join(","),
    ...extra,
    "-cp", cp.map(posix).join(delimiter), "-d", out, ...sources.map(posix),
  ]);
}

/**
 * Stage A: compile `mainSources` (Compose plugin on) over the built app classes, ONCE per distinct set of sources and
 * strings. The result is kept in a cache directory under the OS temp dir, so the long compile is not repeated by every
 * test that wants the real classes; change a source or a string and the key changes.
 */
export function compileMain(o) {
  const { need, missing } = toolchain();
  if (missing.length) return { status: -1, stage: "toolchain", out: "toolchain incomplete: " + missing.join(", ") };
  const strings = o.stringsXml ?? readFileSync(join(ROOT, "app/src/main/res/values/strings.xml"), "utf8");
  const h = createHash("sha1").update(strings);
  for (const f of o.mainSources) h.update(f).update(readFileSync(f, "utf8"));
  h.update(need.appClasspath.join("|"));
  const key = h.digest("hex").slice(0, 16);
  const work = join(tmpdir(), "a28-kotlin-cache", key);
  const mainOut = posix(join(work, "main"));
  const rcls = posix(join(work, "rcls"));
  if (existsSync(join(work, "OK"))) return { status: 0, stage: "cached", out: "", work, mainOut, rcls, need };

  mkdirSync(work, { recursive: true });
  const shadow = writeShadowR(work, strings);
  if (!shadow.ok) return { status: 12, stage: "R", out: "javac failed\n" + shadow.out };
  mkdirSync(mainOut, { recursive: true });
  const r = kotlinc(work, need, "main", mainOut, [rcls, ...need.appClasspath.map(posix), need.appClasses], o.mainSources, ["-Xplugin=" + posix(need.compose)]);
  if (r.status !== 0) return { status: 21, stage: "main", out: (r.stdout + r.stderr).slice(-6000) };
  writeFileSync(join(work, "OK"), "ok");
  return { status: 0, stage: "compiled", out: "", work, mainOut, rcls, need };
}

/**
 * Compile the JUnit `testSources` and run `testClasses`, over stage A, with an optional OVERLAY: { absPath: text } of
 * files compiled afresh from different text -- a mutation -- whose classes shadow stage A's. That is how a test is shown to
 * have teeth in seconds instead of minutes: break one file in a scratch copy and run the same tests.
 *
 * @returns {{status:number, stage:string, out:string}} status 0 = compiled and every test passed
 */
export function runTests(o) {
  const a = compileMain({ mainSources: o.mainSources, stringsXml: o.stringsXml });
  if (a.status !== 0) return a;
  const { need, mainOut, rcls } = a;
  const libs = need.appClasspath.map(posix);
  const scratch = mkdtempSync(join(tmpdir(), "a28-run-"));
  let overlayOut = null;
  if (o.overlay && Object.keys(o.overlay).length) {
    overlayOut = posix(join(scratch, "overlay"));
    mkdirSync(overlayOut, { recursive: true });
    const files = [];
    for (const [abs, text] of Object.entries(o.overlay)) {
      const f = join(scratch, "src", abs.split(/[\\/]/).slice(-1)[0]);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
      files.push(f);
    }
    const r = kotlinc(scratch, need, "overlay", overlayOut, [mainOut, rcls, ...libs, need.appClasses], files, ["-Xplugin=" + posix(need.compose)]);
    if (r.status !== 0) return { status: 23, stage: "overlay", out: (r.stdout + r.stderr).slice(-6000) };
  }
  const front = overlayOut ? [overlayOut] : [];
  const testOut = posix(join(scratch, "test"));
  mkdirSync(testOut, { recursive: true });
  let r = kotlinc(scratch, need, "test", testOut, [...front, mainOut, rcls, ...libs, need.junit, need.hamcrest, need.appClasses], o.testSources, [], [mainOut, ...front]);
  if (r.status !== 0) return { status: 22, stage: "tests", out: (r.stdout + r.stderr).slice(-6000) };
  const runCp = [testOut, ...front, mainOut, rcls, ...libs, need.junit, need.hamcrest, need.appClasses];
  r = java(scratch, "run", ["-cp", runCp.map(posix).join(delimiter), "org.junit.runner.JUnitCore", ...o.testClasses],
    { cwd: o.cwd ?? join(ROOT, "app") });
  return { status: r.status ?? 1, stage: "junit", out: r.stdout + r.stderr };
}

/** The Kotlin files this work wrote or changed that must compile together. */
export const MAIN_SOURCES = [
  "app/src/main/java/com/fenceestimator/app/cloud/Permissions.kt",
  "app/src/main/java/com/fenceestimator/app/data/Entities.kt",
  "app/src/main/java/com/fenceestimator/app/data/Daos.kt",
  "app/src/main/java/com/fenceestimator/app/data/AppDatabase.kt",
  "app/src/main/java/com/fenceestimator/app/data/Repository.kt",
  "app/src/main/java/com/fenceestimator/app/ui/components/EnumLabels.kt",
  "app/src/main/java/com/fenceestimator/app/ui/crew/EnquiryCaptureLogic.kt",
  "app/src/main/java/com/fenceestimator/app/ui/crew/EnquiryCaptureSender.kt",
  "app/src/main/java/com/fenceestimator/app/ui/crew/EnquiryCaptureViewModel.kt",
  "app/src/main/java/com/fenceestimator/app/ui/crew/EnquiryCaptureScreen.kt",
].map((p) => join(ROOT, p));

export const TEST_FILE = join(ROOT, "app/src/test/java/com/fenceestimator/app/crew/EnquiryCaptureTest.kt");
export const REST_ERRORS = join(ROOT, "app/src/test/java/com/fenceestimator/app/cloud/RealRestErrors.kt");
export const TEST_CLASS = "com.fenceestimator.app.crew.EnquiryCaptureTest";

/**
 * Compile files of the app that are NOT mine (MainActivity.kt, JobsListScreen.kt, AutoSync.kt) with a hand-over change
 * applied to a scratch copy, over the real compiled capture sources, to show the hand-over text type-checks -- the
 * proof that the three edits findings ask another track to make are exact, not just plausible.
 * @param {Record<string,string>} files absolute path -> the changed text
 */
export function compileOverlay(files) {
  const a = compileMain({ mainSources: MAIN_SOURCES });
  if (a.status !== 0) return a;
  const { need, mainOut, rcls } = a;
  const scratch = mkdtempSync(join(tmpdir(), "a28-overlay-"));
  const out = posix(join(scratch, "overlay"));
  mkdirSync(out, { recursive: true });
  const sources = [];
  for (const [abs, text] of Object.entries(files)) {
    const f = join(scratch, "src", abs.split(/[\/]/).slice(-1)[0]);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
    sources.push(f);
  }
  // The files being checked belong to other tracks and use strings from every values/strings_*.xml, which the shadow R (built
  // from values/strings.xml only) does not know. The last real build's R.jar knows them all, and it goes FIRST here: nothing
  // being compiled in this overlay names a string this work added.
  const realR = join(ROOT, "app/build/intermediates/compile_and_runtime_not_namespaced_r_class_jar/debug/processDebugResources/R.jar");
  const front = existsSync(realR) ? [realR] : [];
  const r = kotlinc(scratch, need, "overlay", out, [...front, mainOut, rcls, ...need.appClasspath.map(posix), need.appClasses], sources, ["-Xplugin=" + posix(need.compose)], [mainOut]);
  return { status: r.status ?? 1, stage: "overlay", out: (r.stdout + r.stderr).slice(-6000) };
}
