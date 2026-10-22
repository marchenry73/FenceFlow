// A118 -- a week view for the Schedule, and signing off hours from the office.
//
// Run with:  node --test tests/a118-week-view-and-signoff.test.mjs
//
// Source checks: the page is not executed here. Each is paired with a canary.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../website/dashboard.html", import.meta.url), "utf8");

function region(from, to) {
  const i = src.indexOf(from);
  assert.ok(i !== -1, `landmark gone: ${from}`);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j !== -1, `landmark gone: ${to}`);
  return src.slice(i, j);
}

// ===================================================== the week view ======

test("the toggle exists and the view is remembered", () => {
  assert.ok(src.includes('id="calViewToggle"'), "the month/week toggle is gone");
  assert.match(src, /localStorage\.getItem\('ff-cal-view'\)/, "the chosen view is no longer remembered");
});

test("a week draws seven cells, a month forty-two", () => {
  const fn = region("const gridStart = week ?", "for(let cell=0;cell<cells;cell++)");
  assert.match(fn, /const cells = week \? 7 : 42;/, "the cell count no longer follows the view");
  assert.match(src, /for\(let cell=0;cell<cells;cell\+\+\)/, "the loop is back on a fixed 42");
});

test("the grid starts on the week's own Sunday, not the first of a month", () => {
  const fn = region("function calWeekStart(from)", "function renderCal()");
  assert.match(fn, /w\.setDate\(w\.getDate\(\) - w\.getDay\(\)\)/, "the Sunday calculation is gone");
  assert.match(src, /const gridStart = week \? new Date\(weekFrom\)/,
    "a week grid would start from the first of the month, so the wrong seven days are drawn");
});

test("nothing is folded behind '+N more' in a week", () => {
  const fn = region("const hidden = week ?", "const pad2=");
  assert.match(fn, /week \? 0 : Math\.max\(0,evs\.length-3\)/,
    "a week cell hides the fourth job again, which is the one reason to have a week view");
  assert.match(src, /\(\(!week && i>=3\)\?';display:none':''\)/,
    "the chips past the third are hidden again in week mode");
});

test("the arrows step by what is on screen", () => {
  const fn = region("const stepMonth = by =>", "$('calPrev')");
  assert.match(fn, /if \(calView === 'week'\)/, "the arrows no longer branch on the view");
  assert.match(fn, /next\.setDate\(next\.getDate\(\) \+ by \* 7\)/,
    "a week step is not seven days, so the arrows jump four weeks at a time");
});

test("the summary describes the grid under it, not always a month", () => {
  const fn = region("const inMonth = dt => week", "const booked =");
  assert.match(fn, /dt >= weekFrom/, "the summary counts a month while a week is showing");
});

test("a week cell is not marked as outside the month", () => {
  assert.match(src, /const out = week \? false : cur\.getMonth\(\)!==m;/,
    "week days outside the cursor's month are greyed as 'out', which is every day of some weeks");
});

// ================================================ signing off hours ======

test("the office calls the existing RPC, and does not write the columns itself", () => {
  const fn = region("async function decideShift(t, approve, note)", "function shiftState(t)");
  assert.match(fn, /db\.rpc\('approve_time_entry'/, "the sign-off no longer goes through approve_time_entry");
  assert.doesNotMatch(fn, /db\.from\('time_entries'\)/,
    "it writes the approval columns directly, which is a second approval path -- every rule lives in the RPC");
});

test("the screen is patched from what the server saved", () => {
  const fn = region("async function decideShift(t, approve, note)", "function shiftState(t)");
  assert.match(fn, /t\.approved_at = r\.approved_at \|\| null/, "approved_at is not taken from the answer");
  assert.match(fn, /t\.rejected_at = r\.rejected_at \|\| null/, "rejected_at is not taken from the answer");
  assert.doesNotMatch(fn, /t\.approved_at = approve/,
    "the row is patched from what was ASKED for rather than from what was saved");
});

test("a rejection needs a reason before anything is sent", () => {
  const fn = region("async function onDecideShift(syncId, approve)", "function cleanShiftsToSign");
  assert.match(fn, /if \(!note\.trim\(\)\) return;/,
    "an empty reason is sent to the server instead of being stopped here");
});

test("the one-press path never covers a flagged shift", () => {
  const fn = region("function cleanShiftsToSign(pool)", "async function signOffClean");
  assert.match(fn, /!TIME_FLAGS\.some\(f => f\.key !== 'waiting' && f\.test\(t\)\)/,
    "the bulk sign-off would cover shifts something is wrong with -- the whole safety property of it");
  assert.match(fn, /t\.ended_at && shiftState\(t\) === 'waiting'/,
    "it no longer limits itself to ended, undecided shifts");
});

test("a bulk run names every refusal", () => {
  const fn = region("async function signOffClean(pool)", "async function renderTime()");
  assert.match(fn, /refused\.push\(/, "refusals are no longer collected");
  assert.match(fn, /refused\.join\(' \/ '\)/,
    "the reasons are swallowed and only a number is shown, which is how a bulk action gets trusted when it should not be");
});

test("state comes from the same pair of columns the reports read", () => {
  const fn = region("function shiftState(t)", "async function onDecideShift");
  assert.match(fn, /t\.rejected_at && !t\.approved_at/,
    "the rejected test no longer matches the one the reports use, so two screens can disagree");
});

test("every new word exists in all three languages", () => {
  for (const key of ["timeColState", "timeStateApproved", "timeStateRejected", "timeStateWaiting",
                     "timeSignBtn", "timeRejectBtn", "timeSignCleanBtn", "timeRejectAsk",
                     "timeSignAllOk", "timeSignPartial", "timeSignGone",
                     "calWeekBtn", "calMonthBtn"]) {
    const n = src.split(key + ":").length - 1;
    assert.equal(n, 3, `${key} appears in ${n} locales, expected 3`);
  }
});

// ---------------------------------------------------------------- canaries

test("CANARY: the Sunday calculation really lands on a Sunday", () => {
  const weekStart = (from) => {
    const w = new Date(from);
    w.setHours(0, 0, 0, 0);
    w.setDate(w.getDate() - w.getDay());
    return w;
  };
  // A Thursday, a Sunday and a Saturday all fall back to the same Sunday.
  assert.equal(weekStart(new Date(2026, 9, 22)).getDay(), 0, "a Thursday did not land on a Sunday");
  assert.equal(weekStart(new Date(2026, 9, 18)).getDate(), 18, "a Sunday moved");
  assert.equal(weekStart(new Date(2026, 9, 24)).getDate(), 18, "a Saturday did not fall back to the 18th");
});

test("CANARY: the clean-shift filter rejects a flagged shift", () => {
  const flags = [{ key: "overlap", test: (t) => t.over }, { key: "waiting", test: () => true }];
  const clean = (t) => !!t.ended_at && !flags.some((f) => f.key !== "waiting" && f.test(t));
  assert.equal(clean({ ended_at: "x", over: true }), false, "an overlapping shift was called clean");
  assert.equal(clean({ ended_at: "x", over: false }), true, "a clean shift was rejected");
  assert.equal(clean({ ended_at: null, over: false }), false, "a running shift was called clean");
});
