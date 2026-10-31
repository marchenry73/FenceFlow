// a86 -- "the phone and the office cannot disagree about which rows are
// checked". They did, and the comment saying they could not is the one this
// file now enforces.
//
// WHAT WAS WRONG. Two predicates decide whether a catalog row still carries a
// price nobody at the company has checked:
//
//   phone   SeedData.isPlaceholderPrice(sourceDoc)
//             == SEEDED || == PLACEHOLDER || == IMPORTED_UNVERIFIED
//             || startsWith(IMPORTED_CHECK_FILING)                 4 labels
//
//   office  isSeededUnverifiedPrice(sourceDoc)
//             /^(Starting price|Placeholder)/                       2 labels
//
// The office's own comment claimed they were the same rule, and justified the
// narrowness by saying anything else is "a company's own wording ... left
// alone". Both halves were wrong: the two missing labels are written by
// FenceFlow's own importers -- "Imported {dash} check this one" by the
// price-list importer in dashboard.html itself, and "Imported {dash} verify
// before quoting" by the phone's PDF importer.
//
// WHAT IT COST. isSeededUnverifiedPrice feeds two things:
//
//   * unverifiedPricesOn(job), the office's SEND GATE, whose own comment is
//     "The phone refuses to send a quote priced off catalog rows nobody has
//     checked. The office did not, so the same job could be sent from a desk
//     with the guard skipped -- a gate on one door only." So the gate written
//     to close that door was still open for both import labels.
//   * the flag on the catalog table, so the office showed such a row as clean
//     while the phone warned about it.
//
// One row on the live database carried "Imported {dash} verify before quoting"
// when this was found.
//
// WHAT THIS FILE DOES. Reads the labels out of SeedData.kt and the predicate
// out of dashboard.html, runs both rules over every label and a set of near
// misses, and asserts they agree. The canary re-runs the comparison with the
// OLD narrow regex and requires it to DISAGREE -- so this test is shown to
// catch the bug that existed, rather than merely passing now.
//
//     node --test tests/a86-unverified-price-one-rule.test.mjs   (no network)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const KT = read("app/src/main/java/com/fenceestimator/app/data/SeedData.kt");
const DASH_HTML = read("website/dashboard.html");

/** A `const val NAME = "..."` out of the Kotlin. */
function ktConst(name) {
  const m = new RegExp('const val ' + name + '\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(KT);
  assert.ok(m, `could not read ${name} from SeedData.kt`);
  return m[1];
}

const EM = ktConst("LABEL_DASH");
const LABELS = {
  seeded: ktConst("SEEDED"),
  placeholder: ktConst("PLACEHOLDER"),
  importedUnverified: ktConst("IMPORTED_UNVERIFIED"),
  importedCheckFiling: ktConst("IMPORTED_CHECK_FILING").replace("${LABEL_DASH}", EM),
};

test("0. the labels were read, interpolated, and are not placeholders", () => {
  // Control: if this extraction silently produced empty strings, every
  // comparison below would pass on nothing.
  assert.equal(EM, "—", "LABEL_DASH is not an em dash any more");
  for (const [k, v] of Object.entries(LABELS)) {
    assert.ok(v.length > 8, `${k} came out as ${JSON.stringify(v)}`);
    assert.ok(!v.includes("${"), `${k} still carries an uninterpolated template: ${v}`);
    assert.ok(v.includes(EM), `${k} does not contain the em dash, so a hand-typed hyphen has crept in: ${v}`);
  }
});

// ================================================== the phone's rule, as text
test("1. the phone's rule is still the four-label one this file assumes", () => {
  const fn = KT.slice(KT.indexOf("fun isPlaceholderPrice"));
  assert.ok(fn.length > 80, "isPlaceholderPrice not found in SeedData.kt");
  const body = fn.slice(0, fn.indexOf("\n\n"));
  for (const name of ["SEEDED", "PLACEHOLDER", "IMPORTED_UNVERIFIED", "IMPORTED_CHECK_FILING"]) {
    assert.ok(body.includes(name),
      `isPlaceholderPrice no longer mentions ${name} -- the phone's rule moved and the office must move with it`);
  }
  assert.match(body, /startsWith\(IMPORTED_CHECK_FILING\)/,
    "the filing label is no longer a PREFIX test on the phone, so the office's prefix test is now wrong");
});

/** The phone's rule, ported from that body. */
const phoneSaysUnverified = (s) =>
  s === LABELS.seeded || s === LABELS.placeholder || s === LABELS.importedUnverified ||
  s.startsWith(LABELS.importedCheckFiling);

// ================================================= the office's rule, as text
/** The office's rule body, as it stands in the page. */
function officeBody() {
  const m = /function isSeededUnverifiedPrice\(sourceDoc\)\{([\s\S]*?)\n\}/.exec(DASH_HTML);
  assert.ok(m, "isSeededUnverifiedPrice not found in dashboard.html");
  return m[1];
}

test("2. the office carries the Kotlin's labels, inside the function and not retyped", () => {
  const body = officeBody();
  for (const [k, v] of Object.entries(LABELS)) {
    assert.ok(body.includes(`"${v}"`),
      `the office's ${k} label does not match SeedData.kt's: expected ${JSON.stringify(v)}`);
  }
  // SELF-CONTAINED, which is a requirement and not a style choice. Several
  // files pull this function out of the page and run it alone -- a27-pricelist-lib,
  // a45-pdf-*, a46-catalog-height-office-editor, a25 -- so any free variable in
  // its body makes all of them throw. A first version of this fix held the
  // labels in a `const` beside the function and turned five files red for
  // exactly that reason, with nothing wrong in the product.
  // COMMENTS STRIPPED FIRST, block spans before line comments. Without this
  // the scan matched the word "PREFIX" out of the function's own explanatory
  // comment and reported a free variable that does not exist -- the same
  // mistake, in the same session, as four other checks that read their own
  // prose. A detector that cannot tell code from commentary detects nothing.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");
  const free = code.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) || [];
  assert.deepEqual(free, [],
    `isSeededUnverifiedPrice references outer-scope name(s) ${free.join(", ")} -- every test that evaluates it in isolation will throw`);
});

/** The office's rule, read out of dashboard.html and run for real. */
const officeFn = new Function("sourceDoc", officeBody());
const officeSaysUnverified = (s) => officeFn(s);

// ============================================================ they must agree
const NEAR_MISSES = [
  "",
  "Confirmed",
  "Price confirmed by owner 2026-10-06",
  "FloriFence Invoice 36499 / Estimate 17407 (real prices)",
  "Imported",                                   // the bare word: deliberately NOT unverified
  "Starting point for my own list",             // a company's own wording that starts similarly
  "Placeholders I wrote myself",
];

test("3. the two rules agree on every label FenceFlow writes", () => {
  for (const [k, v] of Object.entries(LABELS)) {
    assert.equal(officeSaysUnverified(v), true, `the office does not flag ${k}: ${v}`);
    assert.equal(phoneSaysUnverified(v), true, `the phone does not flag ${k}: ${v}`);
  }
  // The filing label is a prefix, so it must still match with an item appended.
  const appended = LABELS.importedCheckFiling + ": 5x5 post";
  assert.equal(officeSaysUnverified(appended), true, "the office missed an appended filing label");
  assert.equal(phoneSaysUnverified(appended), true, "the phone missed an appended filing label");
});

test("4. and they agree on what is NOT unverified -- a company's own wording is its business", () => {
  for (const s of NEAR_MISSES) {
    assert.equal(officeSaysUnverified(s), phoneSaysUnverified(s),
      `the two rules disagree about ${JSON.stringify(s)}: office=${officeSaysUnverified(s)} phone=${phoneSaysUnverified(s)}`);
  }
  // Named explicitly, because the bare word "Imported" is deliberately excluded
  // by the phone and it would be easy to "fix" that by widening a prefix test.
  assert.equal(phoneSaysUnverified("Imported"), false,
    "the bare word Imported is now unverified -- SeedData's doc says it is deliberately not matched");
  assert.equal(officeSaysUnverified("Imported"), false,
    "the office now flags the bare word Imported, which the phone does not");
});

test("5. CANARY: the rule the office USED TO have disagrees, so this test has teeth", () => {
  const old = (s) => /^(Starting price|Placeholder)/.test(String(s || ""));
  const missed = Object.entries(LABELS).filter(([, v]) => phoneSaysUnverified(v) && !old(v));
  assert.deepEqual(
    missed.map(([k]) => k).sort(),
    ["importedCheckFiling", "importedUnverified"],
    "the old narrow rule no longer disagrees with the phone, so checks 3 and 4 prove nothing");
  // And the old rule was LOOSER on the two seed labels -- a PREFIX, not an
  // equality -- which is the other half of "same rule" being untrue. It is
  // wrong in both directions at once: too narrow on the import labels and too
  // wide on anything merely beginning with the seed wording.
  //
  // The example has to actually share the prefix. My first attempt here used
  // "Starting point for my own list", which does not begin with "Starting
  // price" at all, so the assertion failed and was right to.
  const ownWording = "Starting price I negotiated myself, do not touch";
  assert.equal(old(ownWording), true,
    "canary: the old rule did not over-match a company's own wording, so the prefix half of the complaint is wrong");
  assert.equal(phoneSaysUnverified(ownWording), false,
    "the phone flags a company's own wording, which it must not");
  assert.equal(officeSaysUnverified(ownWording), false,
    "the office still over-matches a company's own wording -- the fix kept the prefix test");
});

test("6. the send gate and the table flag both go through the one rule", () => {
  // A fix to the predicate is only a fix if nothing bypasses it. Both callers
  // named here are the ones whose behaviour the owner actually sees.
  const gate = DASH_HTML.slice(DASH_HTML.indexOf("function unverifiedPricesOn"));
  assert.ok(gate.length > 200, "unverifiedPricesOn not found");
  assert.match(gate.slice(0, 700), /isSeededUnverifiedPrice\(/,
    "the office's send gate no longer uses the shared rule");
  const row = DASH_HTML.slice(DASH_HTML.indexOf("function catItemRowHtml"));
  assert.match(row.slice(0, 400), /isSeededUnverifiedPrice\(/,
    "the catalog table's flag no longer uses the shared rule");
  // And nothing else invents its own test for these labels.
  const strays = [...DASH_HTML.matchAll(/\/\^\(Starting price/g)].length;
  assert.equal(strays, 0, "a second, hand-rolled unverified-price regex has appeared in dashboard.html");
});
