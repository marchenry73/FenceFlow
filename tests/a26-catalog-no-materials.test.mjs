// a26-catalog-no-materials -- a fence to build with nothing priced for materials must not look like a quote.
//
// THE DEFECT. A company with an empty catalog gets a total anyway: 100 ft of vinyl at the phone's default rates is $800
// (labor alone; materials $0, tax $0) where the same job on the starting list is $2,120. The estimate screen said
// nothing, because every materials warning is switched off BY materials being zero.
//
// THE FIX (EstimateEngine.kt): estimateWarnings() now says so (R.string.warn_no_materials, all three locales), through
// one predicate, EstimateEngine.hasFenceWithNoMaterials(job, runs, totals), which reuses the "something is drawn" test the
// uncalibrated-photo lock already uses (runHasDrawnWork -- one definition, not two).
//
// WHAT THIS FILE CAN AND CANNOT PROVE.
//   STATIC (always): the string exists in all three locales and points at labels that exist; the engine wires it; the
//     predicate has the exclusions it needs; there is ONE definition of "drawn"; SeedData.kt says what the screen does.
//   BEHAVIOUR (A26_KOTLIN=1): compiles the REAL EstimateEngine.kt with the Kotlin compiler from the Gradle cache (not
//     gradlew: no build, no APK, nothing written to the repo) against the already-built classes in app/build, generates a
//     shadow R from the CURRENT strings.xml (so a missing string resource fails to compile), and runs
//     tests/a26-catalog-NoMaterialsWarningTest.kt plus the repo's own estimate unit tests with JUnit. The same run with
//     the warning call removed from a copy of the engine must FAIL, which is what makes a pass mean anything.
//   NOT PROVEN HERE: that the screen locks Send. It does not (see the pinned GAP and the todo below); that is EstimateScreen
//     .kt, which this change did not own.
//
//   node --test tests/a26-catalog-no-materials.test.mjs
//   A26_KOTLIN=1 node --test tests/a26-catalog-no-materials.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const ENGINE_REL = "app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt";
const SCREEN_REL = "app/src/main/java/com/fenceestimator/app/ui/estimate/EstimateScreen.kt";
const ENGINE = read(ENGINE_REL);
const SCREEN = read(SCREEN_REL);
const SEED_KT = read("app/src/main/java/com/fenceestimator/app/data/SeedData.kt");
const KEY = "warn_no_materials";
const LOCALES = { en: "app/src/main/res/values/strings.xml", es: "app/src/main/res/values-es/strings.xml", fr: "app/src/main/res/values-fr/strings.xml" };

/** Kotlin with comments removed, so prose cannot satisfy a check about code. */
const stripKt = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");
const ENGINE_CODE = stripKt(ENGINE);

const str = (xml, name) => {
  const m = xml.match(new RegExp('<string name="' + name + '"[^>]*>([\\s\\S]*?)</string>'));
  return m ? m[1] : null;
};
const unescapeAndroid = (s) => s.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, "\n");
/** The body of `fun name(...) ... {` or `= expr`, brace/paren balanced, from Kotlin source. */
function funBody(code, name) {
  const at = code.indexOf("fun " + name + "(");
  assert.ok(at >= 0, "fun not found: " + name);
  const open = code.indexOf("(", at);
  let depth = 0, j = open;
  for (; j < code.length; j++) { if (code[j] === "(") depth++; else if (code[j] === ")") { depth--; if (!depth) break; } }
  const after = code.slice(j + 1);
  const brace = after.search(/\{|=/);
  if (after[brace] === "{") {
    let d = 0, k = brace;
    for (; k < after.length; k++) { if (after[k] === "{") d++; else if (after[k] === "}") { d--; if (!d) break; } }
    return after.slice(brace, k + 1);
  }
  // expression body: up to the blank line / next member
  const rest = after.slice(brace + 1);
  return rest.slice(0, rest.search(/\n\s*\n|\n\s*(?:private |internal |fun |\/\*\*)/));
}

// =============================================================== 1. THE STRING ==

test("harness: the readers find the string in the sibling warning and the button labels they will be compared with", () => {
  for (const [loc, rel] of Object.entries(LOCALES)) {
    const xml = read(rel);
    for (const k of ["warn_gate_no_hardware", "est_suggest_quantities", "cat_copy_starting_list"]) assert.ok(str(xml, k), `${loc}: control string ${k} not found`);
  }
});

test("warn_no_materials exists exactly once in each of the three locales, non-empty, with no format arguments", () => {
  for (const [loc, rel] of Object.entries(LOCALES)) {
    const xml = read(rel);
    assert.equal((xml.match(new RegExp('name="' + KEY + '"', "g")) || []).length, 1, loc + ": occurrences");
    const v = str(xml, KEY);
    assert.ok(v && v.trim().length > 60, loc + ": too short or missing");
    assert.ok(!/%\d*\$?[sdf]/.test(v), loc + ": takes no arguments, so it may not contain a format specifier (EstimateWarning passes none)");
    assert.ok(!/(^|[^\\])'/.test(v), loc + ": an unescaped apostrophe breaks the aapt2 build");
  }
  // TEETH: each of those failure modes is visible to the same readers.
  assert.equal(str('<string name="x">hello %1$s</string>', "x"), "hello %1$s");
  assert.ok(/%\d*\$?[sdf]/.test("hello %1$s"));
  assert.ok(/(^|[^\\])'/.test("don't"));
  assert.equal(str("<resources></resources>", KEY), null);
});

test("the three locales still carry the same set of string names (a name in one and not the others is a build warning at best)", () => {
  const names = (rel) => new Set([...read(rel).matchAll(/<string name="([^"]+)"/g)].map((m) => m[1]));
  const en = names(LOCALES.en);
  for (const loc of ["es", "fr"]) {
    const other = names(LOCALES[loc]);
    assert.deepEqual([...en].filter((n) => !other.has(n)), [], loc + " is missing names");
    assert.deepEqual([...other].filter((n) => !en.has(n)), [], loc + " has extra names");
  }
});

test("the warning names the two things to do by the labels the app really shows: the starting-list button and Suggest Quantities", () => {
  // The button's distinctive phrase, per language, must be BOTH in the button's own label and in the warning.
  const phrase = { en: "starting list", es: "lista inicial de FenceFlow", fr: "liste de départ de FenceFlow" };
  const suggest = { en: "Suggest Quantities", es: "Sugerir cantidades", fr: "Suggérer les quantités" };
  const catalog = { en: "Catalog", es: "Catálogo", fr: "Catalogue" };
  for (const [loc, rel] of Object.entries(LOCALES)) {
    const xml = read(rel);
    const w = unescapeAndroid(str(xml, KEY));
    const button = unescapeAndroid(str(xml, "cat_copy_starting_list"));
    const suggestLabel = unescapeAndroid(str(xml, "est_suggest_quantities"));
    assert.ok(button.includes(phrase[loc]), `${loc}: the catalog button no longer says "${phrase[loc]}": ${button}`);
    assert.ok(w.includes(phrase[loc]), `${loc}: the warning does not name the starting-list button`);
    assert.equal(suggestLabel, suggest[loc], `${loc}: the Suggest Quantities button was renamed`);
    assert.ok(w.includes(suggestLabel), `${loc}: the warning does not name "${suggestLabel}"`);
    assert.ok(w.includes(catalog[loc]), `${loc}: the warning does not say where the button is (${catalog[loc]})`);
  }
});

// ============================================================ 2. THE ENGINE WIRING ==

test("estimateWarnings raises warn_no_materials through hasFenceWithNoMaterials, once, and nothing else raises it", () => {
  const body = funBody(ENGINE_CODE, "estimateWarnings");
  assert.equal((body.match(/R\.string\.warn_no_materials/g) || []).length, 1);
  assert.match(body, /if \(hasFenceWithNoMaterials\(job, runs, totals\)\) \{\s*warnings \+= EstimateWarning\(R\.string\.warn_no_materials\)\s*\}/);
  assert.equal((ENGINE_CODE.match(/R\.string\.warn_no_materials/g) || []).length, 1, "the string is referenced in the engine exactly once");
  // it sits beside the calibration warning, before the margin checks that go quiet at zero materials
  assert.ok(body.indexOf("warn_no_materials") > body.indexOf("survey_not_calibrated"));
  assert.ok(body.indexOf("warn_no_materials") < body.indexOf("warn_low_kept"));
});

test("hasFenceWithNoMaterials: zero materials, a run to BUILD, measurable, and with something on it -- each exclusion is in the code", () => {
  const body = funBody(ENGINE_CODE, "hasFenceWithNoMaterials");
  assert.match(body, /totals\.materialsSubtotal <= 0\.005/, "zero materials, read from the totals every other warning reads");
  assert.match(body, /!run\.isTeardown/, "the old fence needs no materials");
  assert.match(body, /!TakeoffRefresher\.blockedByUncalibratedPhoto\(job, run\)/, "an unmeasurable photo is the calibration warning's business");
  assert.match(body, /run\.usesManualFeet \|\| runHasDrawnWork\(run\)/, "typed footage, or something drawn");
  // TEETH: the reader sees a missing exclusion.
  const missing = body.replace("!run.isTeardown &&", "");
  assert.ok(!/!run\.isTeardown/.test(missing));
});

test("there is ONE definition of 'something is drawn', shared with the uncalibrated-photo lock", () => {
  const defs = (ENGINE_CODE.match(/decodePoints\(run\.pointsEncoded\)\.size >= 2/g) || []).length;
  assert.equal(defs, 1, "the two-points-or-a-gate test appears " + defs + " times in the engine");
  assert.match(funBody(ENGINE_CODE, "runHasDrawnWork"), /decodePoints\(run\.pointsEncoded\)\.size >= 2 \|\|\s*FenceCodec\.decodeGates\(run\.gatesEncoded\)\.isNotEmpty\(\)/);
  assert.match(funBody(ENGINE_CODE, "hasUnmeasurablePhotoWork"), /runHasDrawnWork\(run\)/, "the photo lock reads the shared test");
  assert.match(funBody(ENGINE_CODE, "hasFenceWithNoMaterials"), /runHasDrawnWork\(run\)/, "and so does the new predicate");
  // TEETH: a second copy is counted.
  assert.equal((ENGINE_CODE + "\ndecodePoints(run.pointsEncoded).size >= 2").match(/decodePoints\(run\.pointsEncoded\)\.size >= 2/g).length, 2);
});

test("no pricing formula moved: computeTotals and the engine version are untouched by this change", () => {
  assert.match(ENGINE_CODE, /const val PRICING_ENGINE_VERSION = "2026\.09\.3"/);
  const totals = funBody(ENGINE_CODE, "computeTotals");
  assert.match(totals, /val grandTotal = kotlin\.math\.ceil\(maxOf\(afterDiscount, job\.minimumJobCharge\) \/ 10\.0\) \* 10\.0/);
  assert.ok(!/hasFenceWithNoMaterials|warn_no_materials/.test(totals), "the warning is not part of the arithmetic");
});

// ================================================== 3. THE SEND LOCK: DECIDED, NOT WIRED ==
//
// DECISION: it should also block the customer contract (and with it the invoice), the way the photo case does.
//   * A sent quote is the price the customer is held to (JobMoney.anchoredTotal once accepted). This one is $800 for a
//     $2,120 job and reads as a plausible cheap price -- worse than a $0, which is obvious.
//   * The photo lock's own comment gives the reason a card is not enough: "a card above the fold on a long estimate is
//     easy to scroll past entirely".
//   * The cost is jobs where the customer supplies the materials. No field says so, and the exit today is to price
//     something: a hand-entered line with an amount, or the starting list.
// NOT WIRED: the lock lives in EstimateScreen.zeroQuoteBlocked, a file this change did not own. The two tests below record
// that as it is: a pinned gap that passes while it is true, and the behaviour wanted, as a todo.

test("GAP (pinned): the Estimate screen does not consult hasFenceWithNoMaterials, so Send Contract is not locked for a drawn fence with no materials", () => {
  const code = stripKt(SCREEN);
  assert.match(code, /EstimateEngine\.hasUnmeasurablePhotoWork\(job, runs\)/, "control: the reader finds the existing lock's predicate in the screen");
  assert.match(code, /val zeroQuoteBlocked = totals\.grandTotal <= 0\.005 &&/, "control: it finds the existing lock");
  assert.ok(!/hasFenceWithNoMaterials/.test(code), "the screen calls hasFenceWithNoMaterials now -- update this pin, and read the todo below");
  assert.match(code, /EstimateEngine\.estimateWarnings\(currentJob, runs, lineItems, totals, changeOrders\)/, "but the warning card does show the new warning");
});

test("SHOULD (todo): Send Contract and Send Invoice are disabled for a drawn fence with no materials", { todo: "EstimateScreen.zeroQuoteBlocked reads only hasUnmeasurablePhotoWork; wire hasFenceWithNoMaterials(job, runs, totals) into it, with its own caption string in all three locales" }, () => {
  const code = stripKt(SCREEN);
  const at = code.indexOf("val zeroQuoteBlocked");
  const decl = code.slice(at, code.indexOf("\n\n", at) > 0 ? code.indexOf("\n\n", at) : at + 400);
  assert.match(decl, /hasFenceWithNoMaterials\(job, runs, totals\)/);
});

// ============================================================ 4. THE COMMENT (c) ==

test("SeedData.kt no longer claims the screen refuses to send a quote built on unchecked prices, and what it says instead is true of the screen", () => {
  assert.ok(!/refuses to send/i.test(SEED_KT), "the false claim is still there");
  assert.match(SEED_KT, /does\s+\* NOT refuse to send/);
  assert.ok(!/ninety-one|Eighty-one/i.test(SEED_KT), "a stale count");
  assert.match(SEED_KT, /ninety-two/);
  // ...and each thing it now says is what EstimateScreen.kt does:
  const code = stripKt(SCREEN);
  assert.match(code, /if \(unverified\.isNotEmpty\(\)\) add\(SendBlocker\.UNVERIFIED_PRICES\)/, "a banner/dialog is raised for unverified prices");
  assert.match(code, /if \(sendBlockers\.isNotEmpty\(\)\) showPreSendCheck = true\s*\n\s*else shareDocument\(com\.fenceestimator\.app\.estimate\.JobDocument\.CUSTOMER_CONTRACT\)/, "Send Contract opens the dialog instead of sending");
  assert.match(code, /unverified\.take\(6\)/, "up to six named");
  assert.match(code, /showPreSendCheck = false\s*\n\s*shareDocument\(com\.fenceestimator\.app\.estimate\.JobDocument\.CUSTOMER_CONTRACT\)/, "and its confirm button sends");
  assert.match(code, /R\.string\.contract_legal_gap_send/, "labelled Send anyway");
  assert.equal(str(read(LOCALES.en), "contract_legal_gap_send"), "Send anyway");
  // the invoice, the material list and the working copy do not look at the flag
  const invoice = code.slice(code.indexOf("JobDocument.CUSTOMER_INVOICE"), code.indexOf("JobDocument.CUSTOMER_INVOICE") + 200);
  assert.ok(!/unverified/i.test(invoice), "the invoice button reads the unverified flag");
  // TEETH: the old sentence is caught by the same pattern.
  assert.ok(/refuses to send/i.test("the estimate screen refuses to send a quote built on prices nobody has checked"));
});

test("SeedData.kt's item counts match the list: 92 rows, every one stamped SEEDED", () => {
  const n = (SEED_KT.match(/^\s+item\(MaterialCategory\./gm) || []).length;
  assert.equal(n, 92);
  assert.equal((SEED_KT.match(/sourceDoc = SEEDED/g) || []).length, 92);
});

// =============================================== 5. BEHAVIOUR: the real engine, compiled ==

const KOTLIN = process.env.A26_KOTLIN === "1";
const SKIP_KOTLIN = KOTLIN ? false : "set A26_KOTLIN=1 to compile the real EstimateEngine.kt and run the Kotlin tests (no gradlew)";

function newestDir(dir) {
  const names = readdirSync(dir).sort();
  return names.length ? join(dir, names[names.length - 1]) : null;
}
/** ~/.gradle/caches/modules-2/files-2.1/<group>/<artifact>/<version>/<hash>/<file> */
function cacheJar(group, artifact, version, file) {
  const base = join(homedir(), ".gradle", "caches", "modules-2", "files-2.1", group, artifact, version);
  if (!existsSync(base)) return null;
  for (const h of readdirSync(base)) { const p = join(base, h, file); if (existsSync(p)) return p; }
  return null;
}

function toolchain() {
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
    junit: cacheJar("junit", "junit", "4.13.2", "junit-4.13.2.jar"),
    hamcrest: cacheJar("org.hamcrest", "hamcrest-core", "1.3", "hamcrest-core-1.3.jar"),
    room: cacheJar("androidx.room", "room-common", "2.6.1", "room-common-2.6.1.jar"),
  };
  const props = existsSync(join(ROOT, "local.properties")) ? readFileSync(join(ROOT, "local.properties"), "utf8") : "";
  const sdk = (props.match(/^sdk\.dir=(.*)$/m) || [])[1]?.replace(/\\:/g, ":").replace(/\\\\/g, "/").trim();
  need.android = sdk && existsSync(join(sdk, "platforms", "android-35", "android.jar")) ? join(sdk, "platforms", "android-35", "android.jar") : null;
  need.classes = existsSync(join(ROOT, "app/build/tmp/kotlin-classes/debug")) ? join(ROOT, "app/build/tmp/kotlin-classes/debug") : null;
  const missing = Object.entries(need).filter(([, v]) => !v).map(([k]) => k);
  return { need, missing };
}

/** Compile `engineSrc` (default: the real one) and the tests, run them with JUnit. Returns { status, out }. */
function harness(engineSrc, testClasses) {
  const { need, missing } = toolchain();
  if (missing.length) return { status: -1, out: "toolchain incomplete: " + missing.join(", ") };
  const work = mkdtempSync(join(tmpdir(), "a26-kotlin-"));
  const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 280_000, ...opts });
  // a shadow R from the CURRENT strings.xml: a name that is not in it does not exist, and the compile fails
  mkdirSync(join(work, "rsrc"), { recursive: true }); mkdirSync(join(work, "rcls")); mkdirSync(join(work, "main")); mkdirSync(join(work, "test"));
  const names = [...new Set([...read(LOCALES.en).matchAll(/<string\s+name="([^"]+)"/g)].map((m) => m[1]))];
  let id = 0x7f100000;
  writeFileSync(join(work, "rsrc", "R.java"), `package com.fenceestimator.app;\npublic final class R {\n public static final class string {\n${names.map((n) => `  public static final int ${n} = ${id++};`).join("\n")}\n }\n}\n`);
  let r = sh("javac", ["-d", join(work, "rcls"), join(work, "rsrc", "R.java")]);
  if (r.status !== 0) return { status: 12, out: "javac failed\n" + r.stderr };
  const compilerCp = [need.compiler, need.stdlib, need.script, need.reflect, need.daemon, need.trove, need.annotations, need.coroutines].join(delimiter);
  const libs = [need.stdlib, need.room, need.coroutines, need.android].join(delimiter);
  const compile = (dest, cp, sources) => sh("java", ["-cp", compilerCp, "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-language-version", "2.0", "-nowarn", "-cp", cp, "-d", dest, ...sources]);
  r = compile(join(work, "main"), [libs, join(work, "rcls"), need.classes].join(delimiter), [engineSrc]);
  if (r.status !== 0) return { status: 21, out: "engine did not compile\n" + (r.stdout + r.stderr).slice(-1500) };
  const testDir = join(ROOT, "app/src/test/java/com/fenceestimator/app/estimate");
  const sources = [join(ROOT, "tests/a26-catalog-NoMaterialsWarningTest.kt"), ...["EstimateWarningsTest", "ZeroPriceGuardTest", "AcceptedPriceTest", "UncalibratedLabourTest", "PhotoScaleTest", "EstimateEngineTest", "LinearFeetTest", "TypedLengthTakeoffTest", "MinimumChargeTest", "GateAreaTest"].map((n) => join(testDir, n + ".kt"))];
  r = compile(join(work, "test"), [libs, need.junit, need.hamcrest, join(work, "main"), join(work, "rcls"), need.classes].join(delimiter), sources);
  if (r.status !== 0) return { status: 22, out: "tests did not compile\n" + (r.stdout + r.stderr).slice(-1500) };
  const runCp = [join(work, "test"), join(work, "main"), join(work, "rcls"), need.classes, libs, need.junit, need.hamcrest].join(delimiter);
  r = sh("java", ["-cp", runCp, "org.junit.runner.JUnitCore", ...testClasses]);
  return { status: r.status, out: r.stdout + r.stderr };
}
const CLASSES = ["NoMaterialsWarningTest", "EstimateWarningsTest", "ZeroPriceGuardTest", "AcceptedPriceTest", "UncalibratedLabourTest", "PhotoScaleTest", "EstimateEngineTest", "LinearFeetTest", "TypedLengthTakeoffTest", "MinimumChargeTest", "GateAreaTest"].map((n) => "com.fenceestimator.app.estimate." + n);

test("KOTLIN: the real EstimateEngine.kt compiles against the current strings.xml, and the new tests and the repo's estimate tests pass", { skip: SKIP_KOTLIN }, (t) => {
  const { missing } = toolchain();
  assert.deepEqual(missing, [], "toolchain incomplete (needs the Gradle cache and a previous app build): " + missing.join(", "));
  const run = harness(join(ROOT, ENGINE_REL), CLASSES);
  assert.equal(run.status, 0, run.out.slice(-2500));
  const ok = run.out.match(/OK \((\d+) tests?\)/);
  assert.ok(ok, "no OK line:\n" + run.out.slice(-800));
  assert.ok(Number(ok[1]) >= 100, "only " + ok[1] + " tests ran");
  assert.ok(/NoMaterialsWarningTest|\.{5,}/.test(run.out));
  t.diagnostic(`JUnit: OK (${ok[1]} tests), including the 12 in tests/a26-catalog-NoMaterialsWarningTest.kt`);
});

test("KOTLIN TEETH: the same run on a copy of the engine with the warning call removed FAILS on the new tests, and one with a misspelled string resource does not compile", { skip: SKIP_KOTLIN }, () => {
  const dir = mkdtempSync(join(tmpdir(), "a26-kotlin-mut-"));
  const call = "        if (hasFenceWithNoMaterials(job, runs, totals)) {\n            warnings += EstimateWarning(R.string.warn_no_materials)\n        }";
  assert.ok(ENGINE.includes(call), "sabotage anchor");
  const noCall = join(dir, "EstimateEngine.kt");
  writeFileSync(noCall, ENGINE.replace(call, ""));
  const a = harness(noCall, ["com.fenceestimator.app.estimate.NoMaterialsWarningTest"]);
  assert.notEqual(a.status, 0, "the tests did not notice the warning was gone");
  assert.match(a.out, /AssertionError/);
  mkdirSync(join(dir, "b"));
  const typo = join(dir, "b", "EstimateEngine.kt");
  writeFileSync(typo, ENGINE.replace("R.string.warn_no_materials", "R.string.warn_no_materialz"));
  const b = harness(typo, ["com.fenceestimator.app.estimate.NoMaterialsWarningTest"]);
  assert.equal(b.status, 21, "a string that is not in strings.xml must stop the compile: " + b.out.slice(-300));
  assert.match(b.out, /warn_no_materialz/);
});
