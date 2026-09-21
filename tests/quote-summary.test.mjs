/* The homeowner quote page's project-summary maths: run length/gate count
   aggregation and the "what happens next" copy selection. Pure functions,
   pulled straight out of website/quote.html and run standalone, same idiom
   as tests/quote-scene.test.mjs.

   Planted-failure case: nextStepsKey must tell "deposit still owed" apart
   from "deposit received" using depositDue, not just whether a deposit was
   ever asked for -- a version that only checked `q.deposit > 0` would say
   "next, we'll be in touch to schedule" to a customer who has approved but
   not yet paid, which is the wrong message at the moment it matters most. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('website/quote.html', 'utf8');

const grab = (name) => {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
};

const code = [grab('runFeet'), grab('runGateCount'), grab('installTotals'), grab('nextStepsKey')].join('\n')
  + '\nreturn { runFeet, runGateCount, installTotals, nextStepsKey };';
const { runFeet, runGateCount, installTotals, nextStepsKey } = new Function(code)();

// A job that replaces 120 ft of old fence with 120 ft of new: the customer is
// getting 120 ft, not 240. The teardown run stays in the breakdown as "Remove
// old ..."; it must not be added to the install length or the gate count.
const replaceJob = [
  { type: 'VINYL', manualFeet: 120, gates: '4:SINGLE' },
  { type: 'WOOD', manualFeet: 120, gates: '3:SINGLE', teardown: true },
];

test('installTotals: a teardown run is not counted as fence being installed', () => {
  assert.deepEqual(installTotals(replaceJob, 20), { ft: 120, gates: 1 });
});

test('installTotals: install-only job counts every run', () => {
  const job = [{ type: 'VINYL', manualFeet: 80, gates: '' }, { type: 'VINYL', manualFeet: 40, gates: '4:SINGLE,4:SINGLE' }];
  assert.deepEqual(installTotals(job, 20), { ft: 120, gates: 2 });
});

test('installTotals: no runs is zero, not NaN', () => {
  assert.deepEqual(installTotals(undefined, 20), { ft: 0, gates: 0 });
});

test('PLANTED FAILURE: summing every run, teardown included, doubles a replacement job', () => {
  // The shape of the shipped bug. If installTotals ever regresses to this,
  // the first test above fails with 240 ft / 2 gates.
  const buggy = (runs, px) => runs.reduce((a, r) => ({ ft: a.ft + runFeet(r, px), gates: a.gates + runGateCount(r) }), { ft: 0, gates: 0 });
  assert.deepEqual(buggy(replaceJob, 20), { ft: 240, gates: 2 });
  assert.notDeepEqual(buggy(replaceJob, 20), installTotals(replaceJob, 20));
});

test('runFeet: typed measurement wins over the drawing', () => {
  assert.equal(runFeet({ manualFeet: 120, points: '0:0,100:0' }, 20), 120);
});

test('runFeet: falls back to the drawing at the job calibration', () => {
  // 100px at 20px/ft = 5ft
  assert.equal(runFeet({ manualFeet: 0, points: '0:0,100:0' }, 20), 5);
});

test('runFeet: a run with neither a measurement nor a drawing is zero, not NaN', () => {
  assert.equal(runFeet({}, 20), 0);
});

test('runGateCount: counts comma-separated gate entries', () => {
  assert.equal(runGateCount({ gates: '10:20:4,50:20:4' }), 2);
});

test('runGateCount: no gates field is zero gates, not one', () => {
  assert.equal(runGateCount({ gates: '' }), 0);
});

test('nextStepsKey: no deposit ever asked for -> ready to schedule', () => {
  assert.equal(nextStepsKey({ deposit: 0 }), 'nextStepsReady');
});

test('nextStepsKey: deposit asked, still owed -> pending, not ready', () => {
  // Planted-failure case: a version keyed only on whether a deposit exists
  // (q.deposit > 0) would return 'nextStepsPaid' or 'nextStepsReady' here,
  // telling an unpaid customer the contractor is already on the way.
  assert.equal(nextStepsKey({ deposit: 500, depositDue: 500 }), 'nextStepsPending');
});

test('nextStepsKey: deposit asked, fully paid -> paid, not pending', () => {
  assert.equal(nextStepsKey({ deposit: 500, depositDue: 0 }), 'nextStepsPaid');
});

test('nextStepsKey: a fractional cent of "due" left over still reads as paid', () => {
  assert.equal(nextStepsKey({ deposit: 500, depositDue: 0.001 }), 'nextStepsPaid');
});
