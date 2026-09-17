/* Phone/office agreement for per-foot pay.
 *
 * per-foot-pay.test.mjs already covers the office's own math (perFootShareFeet,
 * perFootPayForJob, perFootCredits, lifted live from website/dashboard.html)
 * and CrewPayTest.kt covers the phone's own math (CrewPay.perFootShareFeet /
 * CrewPay.perFootPay). Neither file checks that the two AGREE on the same
 * inputs -- and per-foot pay is exactly the kind of split arithmetic where a
 * one-line divergence (e.g. one side flooring workers at 1, the other at 0)
 * would mean the paycheck shown on the phone and the numbers pos ted in the
 * office disagree for the same job, and nobody would notice until a crew
 * member complained.
 *
 * This file cannot execute Kotlin, so the phone side is not re-derived here --
 * it is copied verbatim (formula and guard clauses) from
 * app/src/main/java/com/fenceestimator/app/estimate/CrewPay.kt's
 * perFootShareFeet/perFootPay, and cross-checked against known values already
 * asserted for real in CrewPayTest.kt (perFootShareFeet(240,2)=120 etc.) so
 * this copy is not a fresh guess. The office side is the REAL function,
 * lifted from dashboard.html with the same grab() idiom every other office
 * test in this repo uses -- not a second hand copy.
 *
 *   node tests/perfoot-phone-office-parity.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("website/dashboard.html", "utf8");
const grab = (name) => {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("not found: " + name);
  let i = src.indexOf("{", start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
};
const names = ["perFootShareFeet", "perFootPayForJob"];
const office = new Function(names.map(grab).join("\n") + "\nreturn {" + names.join(",") + "};")();

// Verbatim port of CrewPay.kt's perFootShareFeet/perFootPay (Kotlin source,
// app/src/main/java/com/fenceestimator/app/estimate/CrewPay.kt lines 122-132):
//   fun perFootShareFeet(jobFeet: Double, perFootWorkers: Int): Double {
//       if (jobFeet <= 0.0) return 0.0
//       return jobFeet / perFootWorkers.coerceAtLeast(1)
//   }
//   fun perFootPay(jobFeet, perFootWorkers, rate, jobCompleted): Double =
//       if (!jobCompleted || rate <= 0.0) 0.0 else perFootShareFeet(jobFeet, perFootWorkers) * rate
function phonePerFootShareFeet(jobFeet, perFootWorkers) {
  if (jobFeet <= 0) return 0;
  return jobFeet / Math.max(1, perFootWorkers);
}
function phonePerFootPay(jobFeet, perFootWorkers, rate, jobCompleted) {
  return (!jobCompleted || rate <= 0) ? 0 : phonePerFootShareFeet(jobFeet, perFootWorkers) * rate;
}

// Sanity: the hand-ported phone formula reproduces the exact numbers
// CrewPayTest.kt asserts for real against the compiled Kotlin (see
// `perFootShareFeet basic split cases` and `perFootPay is zero until the
// job is completed` in that file), so this file is checking the office
// against a faithful copy, not a guess.
test("the ported phone formula matches CrewPayTest.kt's own asserted values", () => {
  assert.equal(phonePerFootShareFeet(240, 2), 120);
  assert.equal(phonePerFootShareFeet(240, 3), 80);
  assert.equal(phonePerFootShareFeet(240, 1), 240);
  assert.equal(phonePerFootShareFeet(240, 0), 240);
  assert.equal(phonePerFootShareFeet(240, -4), 240);
  assert.equal(phonePerFootShareFeet(0, 2), 0);
  assert.equal(phonePerFootPay(240, 2, 3, false), 0);
  assert.equal(phonePerFootPay(240, 2, 3, true), 360);
  assert.equal(phonePerFootPay(240, 2, 0, true), 0);
});

test("office and phone agree on the share for a range of feet/worker counts", () => {
  for (const feet of [0, 1, 37.5, 100, 240, 999.9]) {
    for (const workers of [-1, 0, 1, 2, 3, 5]) {
      assert.equal(
        office.perFootShareFeet(feet, workers),
        phonePerFootShareFeet(feet, workers),
        `share mismatch at feet=${feet} workers=${workers}`
      );
    }
  }
});

test("office and phone agree on final pay across completed/incomplete and rate combinations", () => {
  for (const feet of [0, 100, 240]) {
    for (const workers of [0, 1, 2, 3]) {
      for (const rate of [0, 2.5, 5]) {
        for (const completed of [true, false]) {
          assert.equal(
            office.perFootPayForJob(feet, workers, rate, completed),
            phonePerFootPay(feet, workers, rate, completed),
            `pay mismatch at feet=${feet} workers=${workers} rate=${rate} completed=${completed}`
          );
        }
      }
    }
  }
});

test("PLANTED FAILURE: a phone that floored workers at 1 (instead of treating <=0 as 1 worker) would disagree with the office", () => {
  // Reproduce a plausible phone-side bug -- clamping workers up to 1 only
  // when it is exactly 0, not for any non-positive count -- and show it
  // would visibly diverge from the office's own definition for a negative
  // worker count, proving this parity check is not vacuously true.
  const buggyPhoneShare = (jobFeet, perFootWorkers) =>
    perFootWorkers === 0 ? jobFeet : jobFeet / perFootWorkers;
  assert.notEqual(
    office.perFootShareFeet(240, -1),
    buggyPhoneShare(240, -1),
    "planted bug did not diverge -- this test would not catch a real regression"
  );
});
