// a37-price-label-importer -- a price the office's importer filed by guesswork must raise the unverified-price warning on the phone.
//
// THE DEFECT. The phone warns before a contract goes out if a line on it rests on a catalog row nobody at the company has
// checked. It decides by the row's source_doc, and SeedData.isPlaceholderPrice recognised three labels. The office's
// price-list importer (website/dashboard.html, runImport) stamps a fourth, "Imported <U+2014> check this one", so every row it
// wrote passed the check in silence.
//
// THE FIX (SeedData.kt only). One new constant, IMPORTED_CHECK_FILING, built from a named dash constant LABEL_DASH, and one new
// clause in isPlaceholderPrice. It is a second constant and NOT a second spelling of IMPORTED_UNVERIFIED, because the office
// treats them as different kinds of thing: "verify before quoting" is a PRICE nobody checked (a supplier's price list does check
// it, so the office's price-list update confirms it), "check this one" is how an item was FILED (fence type, role, unit, guessed
// from the name; a price list says nothing about that, so the office's update leaves the label alone). Section 3 pins that.
//
// THE DASH IS THE TRAP. The stored label has an EM DASH, U+2014. A hyphen (U+002D) or an en dash (U+2013) looks the same in an
// editor and compares unequal, so a fix typed with the wrong one matches nothing, and a test typed with the same wrong one passes.
// So nothing here types a dash: every string is built from code points, and the authority is the importer's own source text.
//
// WHAT THIS FILE CAN AND CANNOT PROVE.
//   STATIC (always): the importer's literal is exactly the expected code points; the Kotlin constant, evaluated from SeedData.kt
//     with its template and \u escape resolved, equals the importer's literal; isPlaceholderPrice's body names the constant; the
//     office keeps the two imported kinds apart. Each has a mutated twin that must FAIL, so a pass means something.
//   BEHAVIOUR (A37_KOTLIN=1): compiles the constants and predicate sliced out of the REAL SeedData.kt, with the REAL
//     IsPlaceholderPriceTest.kt, using the Kotlin compiler from the Gradle cache (NOT gradlew: no build, no APK, nothing written
//     to the repo), and runs it with JUnit. A copy without the new clause, and a copy with a hyphen for the dash, must FAIL.
//   NOT PROVEN HERE: that the estimate screen shows the banner for such a row. EstimateViewModel.unverifiedPriceNames feeds it
//     from isPlaceholderPrice alone, and that wiring is read, not run.
//
//   node --test tests/a37-price-label-importer.test.mjs
//   A37_KOTLIN=1 node --test tests/a37-price-label-importer.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const SEED_REL = "app/src/main/java/com/fenceestimator/app/data/SeedData.kt";
const TEST_REL = "app/src/test/java/com/fenceestimator/app/data/IsPlaceholderPriceTest.kt";
const SEED = read(SEED_REL);
const DASH_HTML = read("website/dashboard.html");

// ---- the characters, by code point, never by glyph --------------------------------------------------------------------------
const EM = String.fromCodePoint(0x2014);
const HYPHEN = String.fromCodePoint(0x2d);
const EN = String.fromCodePoint(0x2013);
const EXPECTED_CHECK = "Imported " + EM + " check this one";
const EXPECTED_VERIFY = "Imported " + EM + " verify before quoting";
const points = (s) => [...s].map((c) => c.codePointAt(0));
const nonAscii = (s) => points(s).filter((p) => p > 0x7e);

/** Kotlin with comments removed, so prose cannot satisfy a check about code. */
const stripKt = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

/** Every `const val NAME = "..."` in `code`, with \uXXXX escapes and ${OTHER} / $OTHER templates resolved, as Kotlin does. */
function ktConsts(code) {
  const raw = {};
  for (const m of code.matchAll(/const val ([A-Za-z_]\w*)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) raw[m[1]] = m[2];
  const memo = {};
  const value = (name, trail = []) => {
    if (name in memo) return memo[name];
    assert.ok(name in raw, "a template names a constant this reader did not find: " + name);
    assert.ok(!trail.includes(name), "constants refer to each other in a circle: " + [...trail, name].join(" -> "));
    const out = raw[name].replace(/\\(u[0-9a-fA-F]{4}|.)|\$\{(\w+)\}|\$([A-Za-z_]\w*)/g, (m, esc, a, b) => {
      if (esc !== undefined) {
        if (esc[0] === "u" && esc.length === 5) return String.fromCharCode(parseInt(esc.slice(1), 16));
        return { n: "\n", t: "\t", r: "\r", b: "\b" }[esc] ?? esc;
      }
      return value(a ?? b, [...trail, name]);
    });
    return (memo[name] = out);
  };
  return Object.fromEntries(Object.keys(raw).map((k) => [k, value(k)]));
}

/** The source text of `fun name(...) ... =` expression body, up to the blank line that ends it. */
function exprBody(code, name) {
  const at = code.indexOf("fun " + name + "(");
  assert.ok(at >= 0, "fun not found: " + name);
  const eq = code.indexOf("=", code.indexOf(")", at));
  const end = code.indexOf("\n\n", eq);
  return code.slice(eq + 1, end < 0 ? code.length : end);
}

// ======================================================================= 1. THE IMPORTER'S LABEL, AS STORED ==

/** Every literal the office writes to source_doc that begins with "Imported". */
const importerLiterals = [...DASH_HTML.matchAll(/source_doc:'(Imported[^']*)'/g)].map((m) => ({ text: m[1], at: m.index }));

test("1a. the office importer writes exactly one imported label, and it is Imported, U+2014, check this one -- bare, with no suffix", () => {
  assert.equal(importerLiterals.length, 1, "expected one writer of an 'Imported' source_doc in website/dashboard.html; found " + importerLiterals.length);
  const lit = importerLiterals[0].text;
  assert.deepEqual(points(lit), points(EXPECTED_CHECK), "code points differ: " + JSON.stringify(points(lit)));
  assert.deepEqual(nonAscii(lit), [0x2014], "the one non-ASCII character is the em dash");
  assert.equal(lit, EXPECTED_CHECK, "the stored value carries nothing after the label (this is why an exact comparison would have matched it)");
});

test("1b. that literal is inside runImport's price-list branch, the only path that writes catalog rows", () => {
  const fnAt = DASH_HTML.indexOf("async function runImport(");
  assert.ok(fnAt > 0, "control: runImport was found");
  const branchAt = DASH_HTML.indexOf("if(kind==='pricelist')", fnAt);
  assert.ok(branchAt > fnAt, "control: the price-list branch was found");
  const branchEnd = DASH_HTML.indexOf("return;\n  }", branchAt);
  assert.ok(branchEnd > branchAt, "control: the branch ends");
  assert.ok(importerLiterals[0].at > branchAt && importerLiterals[0].at < branchEnd, "the label is written in the price-list branch");
  assert.match(DASH_HTML.slice(branchAt, branchEnd), /from\('material_items'\)\.insert\(chunk\)|db\.from\('material_items'\)/, "and that branch inserts into material_items");
});

test("1c. TEETH: the same extraction on a copy with a hyphen for the dash does not equal the expected label", () => {
  // At the literal's own offset: the same words appear earlier in the page, in a regex and in a comment, and a plain replace hits those.
  const { at, text } = importerLiterals[0];
  const start = at + "source_doc:'".length;
  assert.equal(DASH_HTML.slice(start, start + text.length), text, "control: the offset points at the literal");
  const mutated = DASH_HTML.slice(0, start) + "Imported " + HYPHEN + " check this one" + DASH_HTML.slice(start + text.length);
  const m = [...mutated.matchAll(/source_doc:'(Imported[^']*)'/g)].map((x) => x[1]);
  assert.equal(m.length, 1, "control: the mutated copy still has one literal");
  assert.notEqual(m[0], EXPECTED_CHECK);
  assert.deepEqual(nonAscii(m[0]), [], "and it has no non-ASCII character at all, which is what a hyphen looks like to the test above");
});

// ============================================================ 2. THE PHONE'S CONSTANT, EVALUATED FROM SOURCE ==

const KT = ktConsts(stripKt(SEED));

test("2a. LABEL_DASH is U+2014 and IMPORTED_CHECK_FILING, with its template resolved, equals the importer's own literal", () => {
  assert.ok(KT.LABEL_DASH !== undefined, "LABEL_DASH exists in SeedData.kt");
  assert.deepEqual(points(KT.LABEL_DASH), [0x2014]);
  assert.ok(KT.IMPORTED_CHECK_FILING !== undefined, "IMPORTED_CHECK_FILING exists in SeedData.kt");
  assert.deepEqual(points(KT.IMPORTED_CHECK_FILING), points(importerLiterals[0].text), "same code points as what the office stores");
  assert.equal(KT.IMPORTED_CHECK_FILING, importerLiterals[0].text);
});

test("2b. the data is the authority: IMPORTED_CHECK_FILING is built from LABEL_DASH, not typed", () => {
  const decl = stripKt(SEED).match(/const val IMPORTED_CHECK_FILING\s*=\s*"([^"]*)"/);
  assert.ok(decl, "declaration found");
  assert.match(decl[1], /\$\{?LABEL_DASH\}?/, "it refers to the named dash constant");
  assert.deepEqual(nonAscii(decl[1]), [], "and its source text has no dash glyph of its own to drift");
});

test("2c. the three older labels each carry the same em dash, so one dash constant describes all four", () => {
  for (const k of ["SEEDED", "PLACEHOLDER", "IMPORTED_UNVERIFIED", "IMPORTED_CHECK_FILING"]) {
    assert.ok(KT[k] !== undefined, "control: " + k + " was read");
    assert.deepEqual(nonAscii(KT[k]), [0x2014], k + " carries exactly one non-ASCII character and it is U+2014");
    assert.ok(!KT[k].includes(HYPHEN) && !KT[k].includes(EN), k + " has no hyphen or en dash");
  }
  assert.equal(KT.IMPORTED_UNVERIFIED, EXPECTED_VERIFY);
});

test("2d. TEETH: with LABEL_DASH changed to a hyphen the evaluated constant no longer equals the importer's literal", () => {
  const mutated = stripKt(SEED).replace(/(const val LABEL_DASH\s*=\s*)"[^"]*"/, '$1"\\u002D"');
  assert.notEqual(mutated, stripKt(SEED), "control: the mutation changed the source");
  const K = ktConsts(mutated);
  assert.deepEqual(points(K.LABEL_DASH), [0x2d]);
  assert.notEqual(K.IMPORTED_CHECK_FILING, importerLiterals[0].text, "the comparison is able to see a wrong dash");
});

test("2e. IMPORTED_CHECK_FILING and IMPORTED_UNVERIFIED are two constants with two values, neither a prefix of the other", () => {
  assert.notEqual(KT.IMPORTED_CHECK_FILING, KT.IMPORTED_UNVERIFIED);
  assert.ok(!KT.IMPORTED_CHECK_FILING.startsWith(KT.IMPORTED_UNVERIFIED));
  assert.ok(!KT.IMPORTED_UNVERIFIED.startsWith(KT.IMPORTED_CHECK_FILING));
});

// =============================================================================== 3. THE PREDICATE, AND THE OFFICE ==

const predicateBody = (src) => exprBody(stripKt(src), "isPlaceholderPrice");

test("3a. isPlaceholderPrice names all four labels, matches the new one by prefix, and does not name the bare word", () => {
  const body = predicateBody(SEED);
  for (const k of ["SEEDED", "PLACEHOLDER", "IMPORTED_UNVERIFIED"]) assert.match(body, new RegExp("== " + k + "\\b"), k + " is still compared");
  assert.match(body, /sourceDoc\.startsWith\(IMPORTED_CHECK_FILING\)/, "the new label is matched, by prefix, as the office's own readers match it");
  assert.ok(!/"Imported"/.test(body), "the bare word is not matched");
  assert.ok(!/CONFIRMED/.test(body), "and a confirmed row is not");
});

test("3b. TEETH: the same check on a copy without the new clause fails", () => {
  const mutated = SEED.replace(/\s*\|\|\s*sourceDoc\.startsWith\(IMPORTED_CHECK_FILING\)/, "");
  assert.notEqual(mutated, SEED, "control: the mutation changed the source");
  assert.ok(!/startsWith\(IMPORTED_CHECK_FILING\)/.test(predicateBody(mutated)), "the clause is gone from the mutated copy");
  assert.ok(/startsWith\(IMPORTED_CHECK_FILING\)/.test(predicateBody(SEED)), "and is present in the real one");
});

test("3c. the office treats the two imported kinds differently: a supplier list confirms 'verify before quoting' and leaves 'check this one' alone", () => {
  const confirmLine = DASH_HTML.split("\n").find((l) => /const confirm = /.test(l));
  const keepLine = DASH_HTML.split("\n").find((l) => /const keepDoc = /.test(l));
  assert.ok(confirmLine && keepLine, "control: both lines found in ppBuildPlan");
  assert.ok(confirmLine.includes("Imported " + EM + " verify before quoting"), "confirm covers the PRICE label");
  assert.ok(!confirmLine.includes("check this one"), "and does not cover the FILING label");
  assert.ok(keepLine.includes("Imported " + EM + " check this one"), "the FILING label is the one kept in place");
  assert.ok(!keepLine.includes("verify before quoting"), "and the price label is not");
  assert.match(DASH_HTML, /where the item was filed, which a price list says nothing about/, "the office says why, in its own comment");
});

test("3d. the phone's confirm action clears every label, so a row flagged by the new clause has a way back to unflagged", () => {
  const vm = stripKt(read("app/src/main/java/com/fenceestimator/app/ui/catalog/CatalogViewModel.kt"));
  assert.match(vm, /fun confirmPrice\([^)]*\)[\s\S]{0,200}sourceDoc = com\.fenceestimator\.app\.data\.CONFIRMED/, "confirmPrice stamps CONFIRMED");
  const screen = stripKt(read("app/src/main/java/com/fenceestimator/app/ui/catalog/CatalogScreen.kt"));
  assert.match(screen, /val startedUnverified = com\.fenceestimator\.app\.data\.isPlaceholderPrice\(item\.sourceDoc\)/, "the editor offers the switch off isPlaceholderPrice");
  assert.match(screen, /if \(startedUnverified\)[\s\S]{0,400}cat_confirm_price/, "and shows it only for a flagged row");
  assert.match(screen, /EnumDropdown\(stringResource\(R\.string\.cat_role_in_engine\)/, "the same dialog edits the role the importer guessed");
});

test("3e. the warning on the estimate is fed by isPlaceholderPrice alone, so recognising the label is what makes it fire", () => {
  const vm = stripKt(read("app/src/main/java/com/fenceestimator/app/ui/estimate/EstimateViewModel.kt"));
  assert.match(vm, /val unverifiedPriceNames[\s\S]{0,400}\.filter \{ com\.fenceestimator\.app\.data\.isPlaceholderPrice\(it\.sourceDoc\) \}/);
});

// ==================================================================== 4. BEHAVIOUR: the real Kotlin, compiled ==

const KOTLIN = process.env.A37_KOTLIN === "1";
const SKIP_KOTLIN = KOTLIN ? false : "set A37_KOTLIN=1 to compile the real constants + predicate and run the real IsPlaceholderPriceTest.kt (no gradlew)";

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
  };
  return { need, missing: Object.entries(need).filter(([, v]) => !v).map(([k]) => k) };
}

/** The constants and the predicate, cut out of a SeedData.kt text. They need no app class, so they compile alone. */
function slice(src) {
  const start = src.indexOf("internal const val SEEDED");
  const fn = src.indexOf("fun isPlaceholderPrice(");
  assert.ok(start >= 0 && fn > start, "control: the slice markers were found");
  const end = src.indexOf("\n/**", fn);
  assert.ok(end > fn, "control: the predicate ends before the next doc comment");
  return "package com.fenceestimator.app.data\n\n" + src.slice(start, end) + "\n";
}

/** Compile `seedSlice` with the real IsPlaceholderPriceTest.kt and run it. Returns { status, out }. */
function harness(seedSlice) {
  const { need, missing } = toolchain();
  if (missing.length) return { status: -1, out: "toolchain incomplete: " + missing.join(", ") };
  const work = mkdtempSync(join(tmpdir(), "a37-kotlin-"));
  mkdirSync(join(work, "out"));
  writeFileSync(join(work, "Slice.kt"), seedSlice, "utf8");
  const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", timeout: 280_000 });
  const compilerCp = [need.compiler, need.stdlib, need.script, need.reflect, need.daemon, need.trove, need.annotations, need.coroutines].join(delimiter);
  const cp = [need.stdlib, need.junit, need.hamcrest].join(delimiter);
  let r = sh("java", ["-Xmx768m", "-cp", compilerCp, "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect", "-jvm-target", "17",
    "-language-version", "2.0", "-nowarn", "-cp", cp, "-d", join(work, "out"), join(work, "Slice.kt"), join(ROOT, TEST_REL)]);
  if (r.status !== 0) return { status: 21, out: "did not compile\n" + (r.stdout + r.stderr).slice(-1800) };
  r = sh("java", ["-Xmx256m", "-cp", [join(work, "out"), cp].join(delimiter), "org.junit.runner.JUnitCore", "com.fenceestimator.app.data.IsPlaceholderPriceTest"]);
  return { status: r.status, out: r.stdout + r.stderr };
}
const TEST_COUNT = (read(TEST_REL).match(/^\s*@Test\b/gm) || []).length;

test("KOTLIN: the real constants and predicate compile (template const and all) and every test in the real IsPlaceholderPriceTest.kt passes", { skip: SKIP_KOTLIN }, (t) => {
  assert.deepEqual(toolchain().missing, [], "toolchain incomplete (needs the Gradle cache)");
  assert.ok(TEST_COUNT >= 13, "control: the test file's @Test count was read (" + TEST_COUNT + ")");
  const run = harness(slice(SEED));
  assert.equal(run.status, 0, run.out.slice(-2500));
  const ok = run.out.match(/OK \((\d+) tests?\)/);
  assert.ok(ok, "no OK line:\n" + run.out.slice(-800));
  assert.equal(Number(ok[1]), TEST_COUNT, "every @Test ran");
  t.diagnostic(`JUnit: OK (${ok[1]} tests)`);
});

test("KOTLIN TEETH: without the new clause the real tests FAIL, and with a hyphen for the dash they FAIL", { skip: SKIP_KOTLIN }, () => {
  const noClause = SEED.replace(/\s*\|\|\s*sourceDoc\.startsWith\(IMPORTED_CHECK_FILING\)/, "");
  assert.notEqual(noClause, SEED, "control: the mutation changed the source");
  const a = harness(slice(noClause));
  assert.notEqual(a.status, 0, "a predicate that ignores the new label passed the real tests");
  assert.match(a.out, /a row the office price-list importer wrote is unverified/, "and it is that test that caught it:\n" + a.out.slice(-800));

  const hyphen = SEED.replace(/(const val LABEL_DASH\s*=\s*)"\\u2014"/, '$1"\\u002D"');
  assert.notEqual(hyphen, SEED, "control: the dash mutation changed the source");
  const b = harness(slice(hyphen));
  assert.notEqual(b.status, 0, "a hyphen for the dash passed the real tests");
  assert.match(b.out, /the shared dash is exactly one em dash/, "and the code-point test is what caught it:\n" + b.out.slice(-800));
});
