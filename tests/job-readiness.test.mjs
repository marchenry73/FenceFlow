/* jobReadiness(): whether a scheduled job is actually safe to send a crew
   to. Lifted from dashboard.html and run standalone (same grab()/new
   Function() idiom as tests/per-foot-pay.test.mjs), so this is the real
   function the job sheet and the scheduled_but_blocked alert both call --
   not a re-implementation that could silently drift from it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('website/dashboard.html', 'utf8');
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

// jobReadiness's real dependencies, standing in for the ones dashboard.html
// defines at top level (money(), d(), netPaid()) -- same behaviour, not
// re-derived logic, so a bug in the real netPaid()/money() would still show
// up here rather than being masked by a simplified stand-in.
const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);
const d = s => s ? new Date(s) : null;
const netPaid = j => Math.max(0, (j.amount_paid || 0) - (j.refunded_amount || 0));

// depositAskedOf() comes with it: the deposit cap is the page's one copy.
const lib = new Function('money', 'd', 'netPaid',
  grab('depositAskedOf') + '\n' + grab('jobReadiness') + '\nreturn { jobReadiness };')(money, d, netPaid);
const { jobReadiness } = lib;

const run = (jobSyncId, overrides = {}) => ({ job_sync_id: jobSyncId, deleted_at: null, ...overrides });

// A job with every box ticked -- the baseline every "planted failure" test
// below mutates exactly one field away from.
const readyJob = () => ({
  sync_id: 'j1',
  quote_approved_at: '2026-09-01T00:00:00Z',
  signed_at: '2026-09-01T00:00:00Z',
  deposit_amount: 500,
  amount_paid: 500,
  refunded_amount: 0,
  material_prices_confirmed_at: '2026-09-01T00:00:00Z',
  assigned_employee_sync_id: 'emp1',
  scheduled_date: '2026-09-20T00:00:00Z',
  permit_status: 'NOT_REQUIRED',
  hoa_approval_status: 'NOT_REQUIRED',
  materials_status: 'RECEIVED',
  locate_called_at: null,
  locate_expires_at: null,
});

test('a fully-ready job reads READY with every item ok', () => {
  const r = jobReadiness(readyJob(), [run('j1')]);
  assert.equal(r.ready, true);
  assert.ok(r.items.every(i => i.ok), 'every checklist item should be ok');
  assert.ok(r.items.length >= 10, 'expect the full checklist, not a partial one');
});

test('missing signature blocks even though everything else is ready', () => {
  const j = { ...readyJob(), signed_at: null };
  const r = jobReadiness(j, [run('j1')]);
  assert.equal(r.ready, false);
  const sig = r.items.find(i => i.label === 'Contract signed');
  assert.equal(sig.ok, false);
  assert.match(sig.why, /No signature/);
});

test('no fence runs for this job blocks on "Measured", runs for another job do not count', () => {
  const j = readyJob();
  const r = jobReadiness(j, [run('some-other-job')]);
  assert.equal(r.ready, false);
  const measured = r.items.find(i => i.label === 'Measured');
  assert.equal(measured.ok, false);
});

test('a soft-deleted run does not count toward "Measured"', () => {
  const j = readyJob();
  const r = jobReadiness(j, [run('j1', { deleted_at: '2026-09-02T00:00:00Z' })]);
  assert.equal(r.items.find(i => i.label === 'Measured').ok, false);
});

test('deposit: asked and not (fully) paid blocks; asking nothing never blocks', () => {
  const shortPaid = jobReadiness({ ...readyJob(), amount_paid: 100 }, [run('j1')]);
  assert.equal(shortPaid.items.find(i => i.label === 'Deposit collected').ok, false);

  const noDepositAsked = jobReadiness({ ...readyJob(), deposit_amount: 0, amount_paid: 0 }, [run('j1')]);
  assert.equal(noDepositAsked.ready, true);
});

test('deposit: measured against the job\'s price -- a deposit stored above it cannot hold a fully paid job back', () => {
  // An old build wrote the materials figure ($5,730) as the deposit on a job
  // accepted at $3,620, and the customer has paid the whole $3,620. The quote
  // page and the card machine cap the deposit at the price (depositFigures),
  // so there is nothing left to collect on it.
  const job = { ...readyJob(), deposit_amount: 5730, amount_paid: 3620 };
  const capped = jobReadiness(job, [run('j1')], 3620);
  assert.equal(capped.items.find(i => i.label === 'Deposit collected').ok, true);
  assert.equal(capped.ready, true);
  // Still short of the capped figure -> still blocked.
  const short = jobReadiness({ ...job, amount_paid: 3000 }, [run('j1')], 3620);
  assert.equal(short.items.find(i => i.label === 'Deposit collected').ok, false);
  // PLANTED FAILURE: the uncapped rule (no price passed -- what every caller
  // did before) calls the same fully paid job blocked.
  const uncapped = jobReadiness(job, [run('j1')]);
  assert.equal(uncapped.items.find(i => i.label === 'Deposit collected').ok, false);
  // An unpriced job (price zero) is not a cap of zero.
  assert.equal(jobReadiness({ ...readyJob(), amount_paid: 0 }, [run('j1')], 0)
    .items.find(i => i.label === 'Deposit collected').ok, false);
});

test('HOA/permit PENDING blocks; NOT_REQUIRED and APPROVED both pass', () => {
  for (const status of ['NOT_REQUIRED', 'APPROVED']) {
    const r = jobReadiness({ ...readyJob(), hoa_approval_status: status, permit_status: status }, [run('j1')]);
    assert.equal(r.ready, true, status + ' should not block');
  }
  const pending = jobReadiness({ ...readyJob(), hoa_approval_status: 'PENDING' }, [run('j1')]);
  assert.equal(pending.items.find(i => i.label === 'HOA approval').ok, false);
});

test('materials: NOT_NEEDED passes like RECEIVED, ORDERED and NOT_ORDERED both block', () => {
  const notNeeded = jobReadiness({ ...readyJob(), materials_status: 'NOT_NEEDED' }, [run('j1')]);
  assert.equal(notNeeded.ready, true);

  const ordered = jobReadiness({ ...readyJob(), materials_status: 'ORDERED' }, [run('j1')]);
  assert.equal(ordered.items.find(i => i.label === 'Materials on hand').ok, false);

  const notOrdered = jobReadiness({ ...readyJob(), materials_status: null }, [run('j1')]);
  assert.equal(notOrdered.items.find(i => i.label === 'Materials on hand').ok, false);
});

test('811 locate: never called passes (not required by default), expired blocks, waiting-but-not-expired passes', () => {
  const neverCalled = jobReadiness({ ...readyJob(), locate_called_at: null }, [run('j1')]);
  assert.equal(neverCalled.items.find(i => i.label === '811 locate valid').ok, true);

  const expired = jobReadiness({
    ...readyJob(), locate_called_at: '2026-08-01T00:00:00Z', locate_expires_at: '2026-09-01T00:00:00Z'
  }, [run('j1')]);
  assert.equal(expired.items.find(i => i.label === '811 locate valid').ok, false);

  const stillValid = jobReadiness({
    ...readyJob(), locate_called_at: '2026-09-01T00:00:00Z', locate_expires_at: '2099-01-01T00:00:00Z'
  }, [run('j1')]);
  assert.equal(stillValid.items.find(i => i.label === '811 locate valid').ok, true);
});

test('a null job is handled rather than thrown on', () => {
  const r = jobReadiness(null, []);
  assert.equal(r.ready, false);
  assert.deepEqual(r.items, []);
});

// Planted-failure canary: proves the suite's own machinery can actually
// fail, rather than every assertion above passing vacuously (a `grab()`
// that silently matched nothing, or a lib that returned `undefined` for
// every field, would make every `assert.equal(x.ok, false)` above pass by
// coincidence). Runs the SAME check as the signature test but asserts the
// wrong answer through a throwing wrapper, so THIS test only passes if that
// assertion genuinely threw.
test('PLANTED FAILURE CANARY: asserting an unsigned job reads ready must throw', () => {
  const j = { ...readyJob(), signed_at: null };
  const r = jobReadiness(j, [run('j1')]);
  assert.throws(() => assert.equal(r.ready, true),
    /Expected values to be strictly equal/,
    'jobReadiness silently stopped blocking on a missing signature -- the check that should catch this passed instead of failing');
});
