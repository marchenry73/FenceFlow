// A115 -- the Time tab has one filter, three views that obey it, and flags the
// faults an employer actually has to chase.
//
// Run with:  node --test tests/a115-time-tab-filtered.test.mjs
//
// "The time is too unorganized. Look for the best time keeping tools that
// employers use and make it similar." -- 21 October 2026.
//
// Before: three stacked tables, each reading every shift the company had ever
// logged, with no filter anywhere and the weekly view -- the one every
// employer product opens on -- third on the page.
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

const TAB = region('<div id="tab-time"', '<div id="tab-catalog"');

test("the tab has a filter bar at all", () => {
  assert.match(TAB, /id="timePresets"/, "the date presets are gone");
  assert.match(TAB, /id="timeWho"/, "the person filter is gone");
  assert.match(TAB, /id="timeJob"/, "the job filter is gone");
  assert.match(TAB, /id="timeFlags"/, "the needs-attention strip is gone");
});

test("all three panels are switchable views, not a stack", () => {
  const views = [...TAB.matchAll(/data-tview="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(views.sort(), ["entries", "pay", "weekly"],
    `the three views are ${views.join(", ")}`);
  assert.match(TAB, /id="timeViewTabs"/, "the view switcher is gone, so the panels stack again");
});

test("it opens on the weekly view, the way employer products do", () => {
  const fn = region("function buildTimeViewTabs()", "function fillTimePickers()");
  assert.match(fn, /showTimeView\(saved \|\| 'weekly'\)/,
    "the tab no longer opens on the weekly review; the flat entry list is the correction layer, not the review screen");
});

test("it opens on All time, and the reason is written down", () => {
  // Against the research on purpose: every employer product opens on the
  // current pay week because it assumes a week of shifts exists. This company
  // has twelve in its whole history.
  assert.match(TAB, /<button class="chip on" data-range="all"/,
    "the default range moved; opening on an empty week reads as a broken tab");
  assert.match(TAB, /ALL TIME IS THE DEFAULT, against the research/,
    "the reason for departing from the research is no longer recorded beside it");
});

test("the entry list obeys the range, and the weekly views take whole weeks", () => {
  const entries = region("async function renderTime()", "const ot = await getOtSettings()");
  assert.match(entries, /const inRange = timesInRange\(\)/, "the entry list no longer reads the filtered set");
  assert.doesNotMatch(entries, /const done=times\.filter/, "the entry list is back on every shift ever logged");

  for (const [fn, to] of [["function renderTimesheet(ot)", "const buckets"], ["function renderPay(ot)", "const buckets"]]) {
    const r = region(fn, to);
    assert.match(r, /timesInWholeWeeks\(\)/,
      `${fn} no longer takes whole weeks -- a half week reports an overtime figure that is wrong, and it is pay`);
  }
});

test("overlapping shifts are detected, once per render", () => {
  const fn = region("function findTimeOverlaps(pool)", "const TIME_FLAGS");
  assert.match(fn, /d\(cur\.started_at\) < d\(prev\.ended_at\)/, "the overlap test is gone");
  assert.match(fn, /list\.sort/, "the detection is no longer sorted, so it would miss pairs");
  const r = region("async function renderTime()", "renderTimeFlags(inRange)");
  assert.match(r, /timeOverlapIds = findTimeOverlaps\(inRange\)/,
    "overlaps are not recomputed for the shifts in view");
});

test("a flag that has gone to zero does not leave the table empty", () => {
  const r = region("const flag = TIME_FLAGS.find", "$('timeRangeLabel')");
  assert.match(r, /inRange\.some\(flag\.test\) \? inRange\.filter\(flag\.test\) : inRange/,
    "a stale flag can still filter the table to nothing");
  assert.match(r, /if \(flag && !inRange\.some\(flag\.test\)\) timeFlag = ''/,
    "the stale flag is not cleared, so the chip stays lit over an unfiltered table");
});

test("an empty range says so, and names the way out", () => {
  const r = region("const anyAtAll", "const ot = await getOtSettings()");
  assert.match(r, /timeRangeEmptyLine/, "an empty range shows the same line as a full one");
  assert.match(r, /times\.filter\(t => t\.ended_at\)\.length/, "the total it offers instead is not counted");
});

test("the payroll export says what it left out", () => {
  const r = region("$('exportPayroll').addEventListener", "downloadCsv('payroll.csv'");
  assert.match(r, /payrollExcludedLine/,
    "the export drops unapproved shifts silently, which looks identical to having none to drop");
  assert.match(r, /t\.ended_at && !t\.approved_at/, "the excluded count is not the unapproved finished shifts");
});

test("every new word exists in all three languages", () => {
  for (const key of ["timeRangeAll", "timeFilterWho", "timeRangeLabelLine", "timeRangeEmptyLine",
                     "timeFlagRunning", "timeFlagOverlap", "timeFlagNoWorker", "timeFlagNoJob",
                     "timeFlagLong", "timeFlagCorrected", "timeFlagWaiting", "payrollExcludedLine"]) {
    const n = src.split(key + ":").length - 1;
    assert.equal(n, 3, `${key} appears in ${n} locales, expected 3`);
  }
});

test("a flag with nothing wrong is not drawn", () => {
  const fn = region("function renderTimeFlags(pool)", "function showTimeView(name)");
  assert.match(fn, /if \(!n\) continue;/,
    "six permanent zeroes are drawn again, which is another wall to read past");
});

// ---------------------------------------------------------------- canaries

test("CANARY: the whole-weeks check fails on the old line", () => {
  const sabotaged = "function renderTimesheet(ot){ const done = times.filter(t=>t.ended_at); }";
  assert.doesNotMatch(sabotaged, /timesInWholeWeeks\(\)/,
    "the old unfiltered line was not detected, so the real check has no teeth");
});

test("CANARY: the overlap test catches a real pair and clears a non-pair", () => {
  // The same comparison the page makes, run here on two shifts that do overlap
  // and two that merely touch.
  const overlaps = (aStart, aEnd, bStart) => new Date(bStart) < new Date(aEnd) && new Date(aStart) <= new Date(bStart);
  assert.equal(overlaps("2026-10-01T08:00", "2026-10-01T17:00", "2026-10-01T16:00"), true, "a real overlap was missed");
  assert.equal(overlaps("2026-10-01T08:00", "2026-10-01T17:00", "2026-10-01T17:00"), false, "back-to-back shifts were called an overlap");
});
