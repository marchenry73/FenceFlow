/* a186: the sync pass actually USES the reason, it does not merely accept one.
 *
 * SyncScopeTest proves askScopeWith hands the throwable to whoever asks for
 * it. That is a capability. This file is the other half: that AutoSync, the
 * one caller whose pass is crippled by an UNKNOWN answer, passes a reporter
 * rather than taking the do-nothing default.
 *
 * Why it needs its own check: a default of {} makes "nobody kept the reason"
 * compile, pass every unit test, and look exactly like keeping it. That is
 * the shape of today's other finding -- a flag written for a reader who did
 * not exist (memory/flag-written-for-no-reader.md) -- turned around.
 *
 * WHY THIS MATTERS (B2, reported twice): can_see_pay() refuses to guess when
 * auth.uid() is null or no profiles row exists for it, and raises instead. A
 * pass whose money scope is UNKNOWN does NO job work at all -- not the jobs,
 * not the catalog, not the line items -- then retries at 4s, 8s and 12s and
 * falls back to a heartbeat of 60s on screen, fifteen minutes in a pocket. So
 * the commonest moment to be unable to ask is the first sync after signing in
 * on a new phone, which is exactly the moment somebody is looking at an empty
 * job list deciding whether the app works. Which of the three causes it is
 * decides whether the fix is a wait, a retry or a repair, and the message
 * naming it was being thrown away.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const AUTOSYNC = "app/src/main/java/com/fenceestimator/app/cloud/AutoSync.kt";
const SYNCSCOPE = "app/src/main/java/com/fenceestimator/app/cloud/SyncScope.kt";

const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const autoSync = stripComments(readFileSync(AUTOSYNC, "utf8"));
const syncScope = stripComments(readFileSync(SYNCSCOPE, "utf8"));

test("the sync pass asks for the reason and files it", () => {
  const call = autoSync.match(/val scope = askMoneyScope[^\n]*\n/);
  assert.ok(call, "AutoSync no longer asks the money scope the way this file expects");
  assert.match(call[0], /askMoneyScope\s*\{/,
    "AutoSync takes the do-nothing default, so the reason is kept by nobody");
  assert.match(call[0], /CrashReporter\.report\(context, "money-scope",/,
    "the reason must reach somewhere a person can read it afterwards");
});

test("it is the MONEY scope that is instrumented -- the one that stops the job pass", () => {
  // askEmployeePayScope answers a different door and does not gate the jobs,
  // so it is deliberately left alone. If that ever changes, this says so.
  assert.equal(/askEmployeePayScope\s*\{/.test(autoSync), false,
    "the employee-pay door was instrumented too; decide whether that is wanted and say so here");
});

test("only one caller is expected to care, and the rest still compile unchanged", () => {
  // AccountViewModel asks the same question to show a screen; it has no
  // business filing a report for it, and the default keeps it unchanged.
  const vm = stripComments(readFileSync("app/src/main/java/com/fenceestimator/app/ui/account/AccountViewModel.kt", "utf8"));
  assert.match(vm, /askMoneyScope\(\)/, "AccountViewModel should still use the plain form");
});

test("the reason is handed over whole, never rebuilt from words", () => {
  const fn = syncScope.slice(syncScope.indexOf("internal suspend fun askScopeWith"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  assert.match(body, /answer\.exceptionOrNull\(\)\?\.let\(onCouldNotAsk\)/,
    "the server's own three messages are the only thing telling the three causes apart");
  assert.match(body, /return foldPayAnswer\(answer\)/,
    "the fold must stay the one place UNKNOWN is decided");
  assert.equal(/catch|message\s*\?:|toString\(\)/.test(body), false,
    "no rewording here -- see memory/friendly-error-text-erased-the-truth.md");
});

test("PLANTED: with the reporter dropped, the sync pass check goes red", () => {
  const mutated = autoSync.replace(
    /val scope = askMoneyScope[^\n]*\n/,
    "            val scope = askMoneyScope()\n",
  );
  assert.notEqual(mutated, autoSync, "the planted edit did not apply");
  const call = mutated.match(/val scope = askMoneyScope[^\n]*\n/)[0];
  assert.equal(/askMoneyScope\s*\{/.test(call), false,
    "the check above would pass on a pass that keeps nothing");
});
