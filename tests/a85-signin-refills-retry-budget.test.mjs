// a85 -- B2: "signing in on another phone does not sync immediately and keeps
// saying it has not reached the cloud."
//
// THE PATH. Signing in fires AutoSync.runSync() when the company id arrives.
// That pass asks askMoneyScope() first, and on MoneyScope.UNKNOWN it does no
// job work at all -- JobSync returns before its first read, and the catalog and
// line items are skipped with it -- then sets couldNotAskMoneyScope, which is
// the banner the owner was reading. Recovery is askAgainShortly(scopeRetries):
// three attempts, lengthening, 4s then 8s then 12s.
//
// WHAT WAS WRONG. The counter was only ever reset by a pass that DID get an
// answer:
//
//     if (couldNotAskMoneyScope) askAgainShortly(scopeRetries) else scopeRetries.set(0)
//
// so three spent attempts disabled askAgainShortly for the rest of the
// process. Every later unanswerable pass then waited for a heartbeat instead of
// retrying -- 60s with the app open, FIFTEEN MINUTES in a pocket. Sign in on a
// slow first connection, burn the three, and that is the report, a quarter of
// an hour at a time.
//
// WHY IT MATTERS MORE SINCE r59. r59 changed the answer a fresh sign-in gets.
// Before it, a session whose token had not attached yet produced a confident
// DENIED from can_see_pay -- the pass RAN, through the crew door, and scrubbed
// the phone's money (that is the $0-sides bug, tests/a82). It now correctly
// produces UNKNOWN, so a first sign-in comes through this retry path every time
// rather than through a wrong answer. A path that recovers once is not enough
// for the path every sign-in now takes.
//
// THE FIX, pinned here: the budget is per ATTEMPT CONTEXT. The company id
// arriving -- the trigger that fires the first pass after signing in -- refills
// it. Still three per sign-in, still bounded, still quiet afterwards.
//
// WHAT THIS FILE IS NOT. It does not run the app. The decision it models is
// read out of AutoSync.kt and pinned to that text, in the same shape as
// tests/a82 and tests/a48 -- so an edit to the Kotlin either changes what runs
// here or fails loudly, rather than leaving a model describing code nobody
// runs.
//
//     node --test tests/a85-signin-refills-retry-budget.test.mjs   (no network, no writes)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = readFileSync(
  join(ROOT, "app/src/main/java/com/fenceestimator/app/cloud/AutoSync.kt"), "utf8"
).replace(/\r\n/g, "\n");

/** Kotlin with comments blanked, so a "must contain" cannot match prose. */
function stripKt(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '"') { let j = i + 1; while (j < src.length && src[j] !== '"') { if (src[j] === "\\") j++; j++; } out += src.slice(i, j + 1); i = j + 1; continue; }
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; out += " "; continue; }
    out += c; i++;
  }
  return out;
}
const CODE = stripKt(SRC);

test("0. the comment stripper has teeth", () => {
  assert.doesNotMatch(stripKt("val a = 1 // scopeRetries.set(0)\nval b = 2"), /scopeRetries/,
    "the stripper leaves line comments, so the probes below could match prose");
  assert.match(CODE, /private fun askAgainShortly/, "control: the real code is still readable");
  assert.ok(CODE.length > SRC.length * 0.2, "the stripper removed nearly everything");
});

// ===================================================== the bound, as it stands
test("1. the retry bound and its delays are unchanged -- this is about refilling it", () => {
  // The fix is NOT to retry more or sooner. The lengthening 4/8/12 suits a
  // connection still coming up, and askAgainShortly's own doc argues the bound:
  // a company whose database has no can_see_pay would otherwise retry for as
  // long as the app is open. The defect was that the bound never reset.
  assert.match(CODE, /const val RETRY_ATTEMPTS = 3/, "the retry bound moved");
  assert.match(CODE, /const val RETRY_DELAY_MS = 4_000L/, "the retry delay moved");
  assert.match(CODE, /if \(attemptsUsed\.get\(\) >= RETRY_ATTEMPTS\) return/,
    "askAgainShortly no longer bounds itself");
});

// ============================================== the model, and what it answers
/**
 * askAgainShortly's decision, ported from its Kotlin: a retry happens only
 * while the context's budget has attempts left.
 */
function makeBudget() {
  let used = 0;
  return {
    retry() {
      if (used >= 3) return false;   // RETRY_ATTEMPTS
      used += 1;
      return true;
    },
    delayFor() { return 4000 * used; },  // RETRY_DELAY_MS * attempt
    refill() { used = 0; },
    used: () => used,
  };
}

test("2. a sign-in whose first three asks fail still retries on the NEXT sign-in", () => {
  const b = makeBudget();
  // One bad minute: all three attempts spent.
  assert.deepEqual([b.retry(), b.retry(), b.retry()], [true, true, true]);
  assert.equal(b.retry(), false, "control: the budget really is bounded at three");

  // WITHOUT the refill this is where the report came from -- every later pass
  // falls through to a heartbeat, 60s open or 15 minutes in a pocket.
  assert.equal(b.retry(), false, "control: still spent");

  // The fix: a new sign-in is a new context.
  b.refill();
  assert.equal(b.retry(), true,
    "a second sign-in got no retry at all -- it waits for a heartbeat, which is the reported behaviour");
});

test("3. the delays still lengthen within one sign-in, and the total is bounded", () => {
  const b = makeBudget();
  const delays = [];
  while (b.retry()) delays.push(b.delayFor());
  assert.deepEqual(delays, [4000, 8000, 12000],
    "the retry schedule changed -- three asks over 24s is what the banner's wording assumes");
  assert.equal(delays.reduce((a, c) => a + c, 0), 24000,
    "one sign-in may spend at most 24 seconds of retries");
});

// ====================================================== and the Kotlin says so
test("4. the sign-in trigger refills BOTH counters before it syncs", () => {
  // The company id arriving is the trigger that fires the first pass after
  // signing in, so it is where a new attempt context begins. Both counters,
  // because the token guard above the scope question has the same shape and the
  // same per-process exhaustion.
  const at = CODE.indexOf(".map { it.companyId }");
  assert.ok(at > 0, "the sign-in collector is no longer keyed on the company id arriving");
  const block = CODE.slice(at, at + 700);
  assert.match(block, /scopeRetries\.set\(0\)/,
    "the sign-in trigger does not refill scopeRetries -- three failed asks disable the retry for the life of the process");
  assert.match(block, /tokenRetries\.set\(0\)/,
    "the sign-in trigger does not refill tokenRetries");
  // And it must still actually sync, or the fix has replaced the behaviour it
  // was meant to protect.
  assert.match(block, /runSync\(\)/, "the sign-in trigger no longer starts a sync at all");
  // Order matters: refilling AFTER the pass would be spent by that same pass.
  assert.ok(block.indexOf("scopeRetries.set(0)") < block.indexOf("runSync()"),
    "the refill happens after runSync(), so the pass it is meant to help has already been refused");
});

test("5. the success reset is still there -- the refill is an addition, not a replacement", () => {
  assert.match(CODE, /if \(couldNotAskMoneyScope\) askAgainShortly\(scopeRetries\) else scopeRetries\.set\(0\)/,
    "the pass that DOES get an answer no longer resets the budget");
});

test("6. an UNKNOWN scope still does no job work -- the premise of all of the above", () => {
  // If this ever stops being true the retry path matters less, and this file
  // should be re-read rather than trimmed. Pinned on JobSync, which is where
  // the early return lives.
  const js = stripKt(readFileSync(
    join(ROOT, "app/src/main/java/com/fenceestimator/app/cloud/JobSync.kt"), "utf8").replace(/\r\n/g, "\n"));
  assert.match(js, /MoneyScope\.UNKNOWN/,
    "JobSync no longer mentions UNKNOWN -- check whether an unanswerable pass still skips every job");
  assert.match(CODE, /couldNotAskMoneyScope = scope == MoneyScope\.UNKNOWN/,
    "the banner is no longer driven by an unanswerable scope question");
});
