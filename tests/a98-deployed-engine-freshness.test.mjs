// a98: THE CHECK THAT WOULD HAVE CAUGHT THE TWO-DAY DIVERGENCE.
//
// On 3-5 Oct 2026 the office priced with engine 2026.10.8 while the phone
// shipped 2026.10.9. Every gate was green the whole time and none of them was
// wrong: parity compares the two SOURCE engines, and a94 is a source-only
// check that says so in its own header. Nothing looked at the deployment.
//
// scripts/check-deployed-engine.mjs looks. It cannot read a version out of the
// running function -- that needs a job and a login -- so it asks the question
// it CAN answer and that is false in exactly the case that matters: was
// price-job deployed AFTER the engine it bundles last changed?
//
// This file exists because that script is otherwise only ever run against a
// tree that happens to be fresh, and a check nobody has watched go red is a
// check nobody should trust. The judgement is a pure function so it can be
// driven to all three answers with no network at all -- including the real
// timestamps from the day it was missed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verdict } from "../scripts/check-deployed-engine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = readFileSync(join(ROOT, "scripts/check-deployed-engine.mjs"), "utf8");

const at = (s) => Math.floor(Date.parse(s) / 1000);

test("the real 3-5 Oct 2026 divergence is reported STALE", () => {
  // price-job was last deployed on 2 October; the engine moved on the 4th when
  // 1.602 shipped carrying 2026.10.9. This is the case that went unnoticed for
  // two days, and it must not be reported as anything but stale.
  const deployed = at("2026-10-02T14:00:00Z");
  const engineChanged = at("2026-10-04T22:00:00Z");
  assert.equal(verdict(engineChanged, deployed), "stale");
});

test("a deployment after the engine changed is FRESH", () => {
  assert.equal(verdict(at("2026-10-05T19:44:06Z"), at("2026-10-05T20:28:15Z")), "fresh");
});

test("deploying in the same second counts as fresh, not stale", () => {
  // A deploy that lands on the very second of the commit is fine. Getting this
  // boundary backwards would cry stale on every correctly-deployed tree, and a
  // check that is always red is turned off within a week.
  const t = at("2026-10-05T12:00:00Z");
  assert.equal(verdict(t, t), "fresh");
});

test("a missing timestamp is UNKNOWN, never fresh", () => {
  // The whole point. "Could not find out" must not be able to read as "fine" --
  // that is the shape of every bug this office has been bitten by.
  assert.equal(verdict(NaN, at("2026-10-05T12:00:00Z")), "unknown");
  assert.equal(verdict(at("2026-10-05T12:00:00Z"), undefined), "unknown");
  assert.equal(verdict(null, null), "unknown");
});

test("the script exits 2 for unknown, distinct from 0 and 1", () => {
  // Three outcomes need three exit codes, or a caller cannot tell "the office
  // is stale" from "I could not ask". Both are bad; only one is actionable by
  // deploying.
  assert.match(SCRIPT, /process\.exit\(2\)/, "no unknown exit");
  assert.match(SCRIPT, /process\.exit\(1\)/, "no stale exit");
  assert.match(SCRIPT, /process\.exit\(0\)/, "no fresh exit");
  // And it must say so, because the number alone teaches nobody.
  assert.match(SCRIPT, /is not a pass|NOT a pass/i,
    "the script should state that unknown is not a pass");
});

test("uncommitted engine changes are UNKNOWN, because nothing deployed can match them", () => {
  assert.match(SCRIPT, /uncommittedEngineFiles/,
    "the script should refuse to judge a dirty engine tree");
  assert.match(SCRIPT, /ENGINE_PATHS/, "it should name the paths that count as the engine");
  // price-job bundles the whole shared pricing directory, so a change anywhere
  // under it makes the deployed bundle out of date.
  assert.match(SCRIPT, /_shared\/pricing/);
  assert.match(SCRIPT, /price-job/);
});
