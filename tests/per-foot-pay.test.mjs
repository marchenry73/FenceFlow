/* Pay by the foot: the office's split maths, lifted from dashboard.html and
   run standalone (same grab()/new Function() idiom as
   tests/catalog-run-viewer.test.mjs). Mirrors CrewPayTest.kt on the phone. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('website/dashboard.html', 'utf8');
// Some of these (decodeRunPoints, runLengthFt, runBuiltFeet, jobBuiltFeet,
// shiftCountsForPay, perFootShareFeet, perFootPayForJob, perFootCredits) now
// live in website/js/lib/pay.mjs, the first slice of the split described in
// docs/OFFICE_SPLIT_PLAN.md -- exported there instead of declared as a bare
// `function name(...)`, so both sources are searched.
const moduleSrc = readFileSync('website/js/lib/pay.mjs', 'utf8');
const grab = (name) => {
  for (const [text, prefix] of [[src, 'function '], [moduleSrc, 'export function ']]) {
    const start = text.indexOf(prefix + name + '(');
    if (start < 0) continue;
    let i = text.indexOf('{', start), depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') { depth--; if (!depth) return text.slice(start + (prefix.length - 'function '.length), j + 1); }
    }
    throw new Error('unbalanced: ' + name);
  }
  throw new Error('not found: ' + name);
};

const names = ['decodeRunPoints', 'runLengthFt', 'runBuiltFeet', 'jobBuiltFeet',
  'shiftCountsForPay', 'perFootShareFeet', 'perFootPayForJob', 'perFootCredits'];
const lib = new Function(names.map(grab).join('\n') + '\nreturn {' + names.join(',') + '};')();
const { perFootShareFeet, perFootPayForJob, perFootCredits, jobBuiltFeet } = lib;

const emp = (sid, pay_type, per_foot_rate = 0) => ({ sync_id: sid, name: sid, pay_type, per_foot_rate });
const shift = (emp, job, extra = {}) => ({ employee_sync_id: emp, job_sync_id: job,
  started_at: '2026-09-01T08:00:00Z', ended_at: '2026-09-01T16:00:00Z', ...extra });
const typed = (job, feet) => ({ job_sync_id: job, manual_linear_feet: feet });

test('share splits evenly and never divides by zero', () => {
  assert.equal(perFootShareFeet(240, 2), 120);
  assert.equal(perFootShareFeet(240, 3), 80);
  assert.equal(perFootShareFeet(240, 0), 240);
  assert.equal(perFootShareFeet(240, -1), 240);
  assert.equal(perFootShareFeet(0, 2), 0);
  assert.equal(perFootShareFeet(NaN, 2), 0);
});

test('pay only on a completed job with a real rate', () => {
  assert.equal(perFootPayForJob(240, 2, 3, true), 360);
  assert.equal(perFootPayForJob(240, 2, 3, false), 0);
  assert.equal(perFootPayForJob(240, 2, 0, true), 0);
});

test('footage: typed length wins, else the drawing at the job calibration', () => {
  const job = { sync_id: 'j', calibration_pixels_per_foot: 10 };
  const drawn = { job_sync_id: 'j', points_encoded: '0:0,100:0' };           // 10 ft at 10 px/ft
  assert.equal(jobBuiltFeet(job, [drawn, typed('j', 50), typed('other', 999)]), 60);
  assert.equal(jobBuiltFeet({ sync_id: 'j' }, [drawn]), 5);                 // 20 px/ft fallback
});

test('two per-foot workers on a completed job each get half; hourly workers do not count', () => {
  const jobs = [{ sync_id: 'j', status: 'COMPLETED' }];
  const emps = [emp('a', 'PER_FOOT', 2), emp('b', 'PER_FOOT', 3), emp('h', 'HOURLY')];
  const times = [shift('a', 'j'), shift('b', 'j'), shift('h', 'j'), shift('a', 'j')];
  const credits = perFootCredits(jobs, times, emps, [typed('j', 200)]);
  assert.equal(credits.length, 2);
  const a = credits.find(c => c.empSyncId === 'a'), b = credits.find(c => c.empSyncId === 'b');
  assert.equal(a.workers, 2);
  assert.equal(a.share, 100);
  assert.equal(a.pay, 200);
  assert.equal(b.pay, 300);
});

test('PLANTED FAILURE: an unsplit share would double-pay the job', () => {
  const jobs = [{ sync_id: 'j', status: 'COMPLETED' }];
  const emps = [emp('a', 'PER_FOOT', 1), emp('b', 'PER_FOOT', 1)];
  const credits = perFootCredits(jobs, [shift('a', 'j'), shift('b', 'j')], emps, [typed('j', 200)]);
  const total = credits.reduce((s, c) => s + c.pay, 0);
  assert.ok(total <= 200 + 1e-9, 'combined pay must not exceed footage x rate, got ' + total);
});

test('only COMPLETED jobs pay', () => {
  const emps = [emp('a', 'PER_FOOT', 2)];
  for (const status of ['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED']) {
    const c = perFootCredits([{ sync_id: 'j', status }], [shift('a', 'j')], emps, [typed('j', 100)]);
    assert.equal(c.length, 0, status + ' must not pay');
  }
});

test('rejected, open and deleted shifts do not make someone a worker on the job', () => {
  const jobs = [{ sync_id: 'j', status: 'COMPLETED' }];
  const emps = [emp('a', 'PER_FOOT', 1), emp('r', 'PER_FOOT', 1), emp('o', 'PER_FOOT', 1), emp('d', 'PER_FOOT', 1)];
  const times = [
    shift('a', 'j'),
    shift('r', 'j', { rejected_at: '2026-09-02T00:00:00Z' }),
    shift('o', 'j', { ended_at: null }),
    shift('d', 'j', { deleted_at: '2026-09-02T00:00:00Z' }),
  ];
  const c = perFootCredits(jobs, times, emps, [typed('j', 90)]);
  assert.deepEqual(c.map(x => x.empSyncId), ['a']);
  assert.equal(c[0].pay, 90);
});

test('a job nobody clocked on falls back to its assigned per-foot worker', () => {
  const jobs = [{ sync_id: 'j', status: 'COMPLETED', assigned_employee_sync_id: 'a', updated_at: '2026-09-03T00:00:00Z' }];
  const c = perFootCredits(jobs, [], [emp('a', 'PER_FOOT', 4)], [typed('j', 25)]);
  assert.equal(c.length, 1);
  assert.equal(c[0].pay, 100);
  assert.equal(c[0].finishedAt, '2026-09-03T00:00:00Z');
});

test('the dashboard wires the credits into all three office tables', () => {
  for (const fn of ['renderPay', 'renderTimesheet', 'renderCrewProductivity']) {
    assert.match(grab(fn), /perFootCredits\(/, fn + ' does not use perFootCredits');
  }
});
