// a88 -- the overtime rule is written down twice, and nothing compared the two.
//
// WHY THIS EXISTS. The publish gate reported, and it was passed on to the owner
// as a finding worth his attention:
//
//     "there is no overtime concept anywhere in the app -- CrewPay.kt pays
//      hours * rate with no weekly threshold or multiplier. So pay is not a
//      figure with one true answer across the two halves the way price, tax and
//      deposit are."
//
// It is false. CrewPay.kt holds AFTER_HOURS = 40.0 and MULTIPLIER = 1.5 and
// APPLIES them -- `regular * weightedRate + overtime * weightedRate *
// multiplier` -- and its own header says it "Mirrors website/dashboard.html's
// OT_AFTER_HOURS / OT_MULTIPLIER". Both halves read the same
// company_settings keys (ot_after_hours / ot_multiplier) with the same
// disclosed federal default.
//
// The wrong claim came from a stale comment in dashboard.html, three lines
// above the constants, which said overtime was "not a setting" and that one
// "does not exist yet". That comment is corrected; this file is the part that
// stops the underlying risk, which is real even though the reported bug was
// not: 40 and 1.5 are written down in TWO files, read through two settings
// paths, and nothing compared them. That is the exact shape of both of the
// night's expensive bugs -- the business name in two stores, and the
// unverified-price rule in two predicates.
//
// WHAT THIS DOES NOT CLAIM. It does not say the pay figure is correct, or that
// FenceFlow should be anyone's payroll. The office calls it ESTIMATED
// everywhere on purpose. This only holds the two halves to the same rule.
//
//     node --test tests/a88-overtime-one-rule.test.mjs   (no network, no writes)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const PAY = read("app/src/main/java/com/fenceestimator/app/estimate/CrewPay.kt");
const SYNC = read("app/src/main/java/com/fenceestimator/app/cloud/SettingsSync.kt");
const DASH = read("website/dashboard.html");

/**
 * Source with comments gone, so a number quoted in prose is never read as
 * code. STRING-AWARE, and that is not fussiness: a line-start-only strip
 * leaves `val x = 1 // AFTER_HOURS = 99.0` intact, and a naive strip of every
 * `//` destroys `https://`. This is the same scanner tests/a82 and a86 use.
 */
function stripCode(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      let j = i + 1;
      while (j < src.length && src[j] !== q) { if (src[j] === "\\") j++; j++; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; out += " "; continue; }
    out += c; i++;
  }
  return out;
}
const stripKt = stripCode;
const stripJs = stripCode;
const PAY_CODE = stripKt(PAY);
const DASH_CODE = stripJs(DASH);

test("0. the strippers work, so every check below reads code and not prose", () => {
  assert.doesNotMatch(stripKt("val a = 1 // AFTER_HOURS = 99.0"), /99\.0/,
    "the Kotlin stripper leaves line comments");
  assert.doesNotMatch(stripJs("const a = 1; /* OT_AFTER_HOURS = 99 */"), /99/,
    "the JS stripper leaves block comments");
  assert.match(PAY_CODE, /object CrewOvertime/, "control: CrewPay's code is still readable");
  assert.match(DASH_CODE, /const OT_AFTER_HOURS/, "control: the office's code is still readable");
});

const ktNum = (name) => {
  const m = new RegExp("const val " + name + "\\s*(?::\\s*\\w+\\s*)?=\\s*([0-9.]+)").exec(PAY_CODE);
  assert.ok(m, `could not read ${name} from CrewPay.kt`);
  return Number(m[1]);
};
const jsNum = (name) => {
  const m = new RegExp("const " + name + "\\s*=\\s*([0-9.]+)\\s*;").exec(DASH_CODE);
  assert.ok(m, `could not read ${name} from dashboard.html`);
  return Number(m[1]);
};

test("1. the defaults agree, and are the federal rule they are disclosed as", () => {
  const phoneAfter = ktNum("AFTER_HOURS"), phoneMult = ktNum("MULTIPLIER");
  const officeAfter = jsNum("OT_AFTER_HOURS"), officeMult = jsNum("OT_MULTIPLIER");
  assert.equal(officeAfter, phoneAfter,
    `the office splits the week at ${officeAfter}h and the phone at ${phoneAfter}h -- the same shift would be paid two different figures`);
  assert.equal(officeMult, phoneMult,
    `the office pays overtime at ${officeMult}x and the phone at ${phoneMult}x`);
  // Named, because the page tells the owner on screen that this is the federal
  // default. If the number moves, that sentence becomes a lie.
  assert.equal(phoneAfter, 40, "the disclosed default is no longer 40 hours, but the page still says it is federal");
  assert.equal(phoneMult, 1.5, "the disclosed default is no longer 1.5x");
});

test("2. both halves read the SAME company_settings keys", () => {
  for (const key of ["ot_after_hours", "ot_multiplier"]) {
    assert.ok(stripKt(SYNC).includes(key),
      `SettingsSync.kt no longer carries ${key}, so a company's own rule cannot reach the phone`);
    assert.ok(DASH_CODE.includes(key),
      `the office no longer reads ${key}, so a company's own rule cannot reach the office`);
  }
  assert.match(DASH_CODE, /companySetting\('ot_after_hours',\s*OT_AFTER_HOURS\)/,
    "the office no longer falls back to its disclosed default for the threshold");
  assert.match(DASH_CODE, /companySetting\('ot_multiplier',\s*OT_MULTIPLIER\)/,
    "the office no longer falls back to its disclosed default for the multiplier");
});

test("3. the phone APPLIES it -- the claim that it does not is what started this", () => {
  assert.match(PAY_CODE, /fun split\(totalHours: Double, afterHours: Double = AFTER_HOURS\)/,
    "CrewOvertime.split is gone");
  assert.match(PAY_CODE, /val overtime = maxOf\(0\.0, totalHours - afterHours\)/,
    "the week is no longer split at the threshold");
  assert.match(PAY_CODE, /regular \* weightedRate \+ overtime \* weightedRate \* multiplier/,
    "CrewPay no longer multiplies the overtime hours -- THIS is the line whose absence was reported, and it is here");
  // And the override is honoured, not just the default.
  assert.match(PAY_CODE, /companyAfterHours\?\.takeIf \{ it > 0\.0 && it\.isFinite\(\) \} \?: AFTER_HOURS/,
    "the phone no longer prefers a company's own threshold over the default");
  assert.match(PAY_CODE, /companyMultiplier\?\.takeIf \{ it > 0\.0 && it\.isFinite\(\) \} \?: MULTIPLIER/,
    "the phone no longer prefers a company's own multiplier");
});

test("4. CANARY: a drift in either half is caught", () => {
  // The whole point is that these live in two files. Prove the comparison in
  // check 1 fails when they disagree, rather than trusting that it would.
  const driftedOffice = DASH_CODE.replace("const OT_AFTER_HOURS = 40;", "const OT_AFTER_HOURS = 45;");
  const got = Number(/const OT_AFTER_HOURS\s*=\s*([0-9.]+)\s*;/.exec(driftedOffice)[1]);
  assert.equal(got, 45, "canary: the replacement did not take, so this proves nothing");
  assert.notEqual(got, ktNum("AFTER_HOURS"),
    "canary: a 45-hour office week still matches the phone's threshold, so check 1 cannot see a drift");
  const driftedPhone = PAY_CODE.replace("const val MULTIPLIER = 1.5", "const val MULTIPLIER = 2.0");
  const gotM = Number(/const val MULTIPLIER\s*=\s*([0-9.]+)/.exec(driftedPhone)[1]);
  assert.equal(gotM, 2, "canary: the phone replacement did not take");
  assert.notEqual(gotM, jsNum("OT_MULTIPLIER"),
    "canary: a 2x phone multiplier still matches the office's, so check 1 cannot see a drift");
});

test("5. the comment above the office's constants no longer contradicts them", () => {
  // The stale wording ("not a setting", "does not exist yet") is what the
  // publish gate read before reporting that the app had no overtime at all. A
  // comment that contradicts the code twenty lines up is a defect with a real
  // cost, and this is the cheapest place to stop it coming back.
  const at = DASH.indexOf("---- estimated pay ---");
  assert.ok(at > 0, "the estimated-pay section comment is gone");
  const block = DASH.slice(at, DASH.indexOf("const OT_AFTER_HOURS"));
  assert.doesNotMatch(block, /not a setting/i,
    "the comment says overtime is not a setting; company_settings' ot_after_hours / ot_multiplier are exactly that");
  assert.doesNotMatch(block, /does not exist yet/i,
    "the comment says the setting does not exist; getOtSettings() reads it");
  assert.match(block, /ot_after_hours/,
    "the comment no longer names the keys, which is what makes it checkable");
  // Still says the honest part: there is no field to set it in.
  assert.match(block, /FIELD|field/,
    "the comment no longer records that what is missing is a field, not the setting");
});
