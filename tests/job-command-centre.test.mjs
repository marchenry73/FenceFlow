/* jobHeaderModel(): the pure decision layer behind the office job header
   ("command centre") -- path, parallel checks, blocked reasons + fix
   targets, next action + owner. Lifted straight from dashboard.html (same
   grab()/new Function() idiom as tests/job-readiness.test.mjs) so this is
   the real function the header renders, not a re-implementation that could
   silently drift from it. jobHeaderModel() is built on top of the real
   jobReadiness() -- both are lifted together so a change to one that breaks
   the other is caught here, not just in job-readiness.test.mjs alone. */
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

const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);
const d = s => s ? new Date(s) : null;
const netPaid = j => Math.max(0, (j.amount_paid || 0) - (j.refunded_amount || 0));

const lib = new Function('money', 'd', 'netPaid',
  grab('depositAskedOf') + '\n' + grab('jobReadiness') + '\n' + grab('jobHeaderModel') +
  '\nreturn { jobReadiness, jobHeaderModel };')(money, d, netPaid);
const { jobHeaderModel } = lib;

const run = (jobSyncId, overrides = {}) => ({ job_sync_id: jobSyncId, deleted_at: null, ...overrides });

const readyJob = () => ({
  sync_id: 'j1',
  status: 'ACCEPTED',
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
  production_stage: null,
  payment_status: 'DEPOSIT_PAID',
  contract_total: 5000,
});

const runs = [run('j1')];
const employees = [{ sync_id: 'emp1', name: 'Dana Ruiz' }];

test('a fully-ready job: every step ok, every parallel check ok, ready true, next action is Install owned by the assigned crew', () => {
  const m = jobHeaderModel(readyJob(), runs, employees);
  assert.equal(m.ready, true);
  assert.ok(m.steps.filter(s => s.key !== 'production' && s.key !== 'paid').every(s => s.ok),
    'every non-production, non-payment step should be ok on a fully ready job');
  assert.ok(m.parallel.every(p => p.item.ok), 'every parallel check should be ok');
  assert.equal(m.blocked.length, 0);
  assert.equal(m.next.action, 'install');
  assert.equal(m.next.ownerName, 'Dana Ruiz');
});

// Planted failure: if jobHeaderModel ever stops deriving "ready" from the
// real jobReadiness() output (e.g. someone hardcodes true, or recomputes a
// narrower check), this is the test that catches it -- a real, unambiguous
// blocker (no signature) must show up as blocked with the right reason and
// the right jump target, not silently disappear.
test('planted failure -- missing signature blocks, with jobReadiness\'s own reason and a jump to the quote panel', () => {
  const j = { ...readyJob(), signed_at: null };
  const m = jobHeaderModel(j, runs, employees);
  assert.equal(m.ready, false);
  const signedStep = m.steps.find(s => s.key === 'signed');
  assert.equal(signedStep.ok, false);
  const blockedEntry = m.blocked.find(b => b.label === 'Contract signed');
  assert.ok(blockedEntry, 'blocked list should include the unsigned contract');
  assert.match(blockedEntry.why, /No signature/);
  assert.equal(blockedEntry.fix, '#panelQuotePage');
  assert.equal(m.next.action, 'blocked');
  assert.equal(m.next.blockedLabel, 'Contract signed',
    'the quote was approved (still true here) -- the FIRST real blocker in jobReadiness\'s order is the missing signature');
  assert.equal(m.next.ownerName, null);
});

test('unassigned crew on a blocked job reads unassigned, never invents a name', () => {
  const j = { ...readyJob(), signed_at: null, assigned_employee_sync_id: null };
  const m = jobHeaderModel(j, runs, employees);
  assert.equal(m.next.ownerName, null);
});

test('crew assignment is required for readiness -- a job cannot be ready with nobody assigned, so it never reaches the invented-owner case', () => {
  const j = { ...readyJob(), assigned_employee_sync_id: null };
  const m = jobHeaderModel(j, runs, employees);
  assert.equal(m.ready, false);
  assert.equal(m.steps.find(s => s.key === 'crew').ok, false);
  assert.equal(m.next.action, 'blocked');
  assert.equal(m.next.ownerName, null);
});

test('assigned_employee_sync_id pointing at someone off the crew list still reads unassigned, not a crash', () => {
  const j = { ...readyJob(), assigned_employee_sync_id: 'someone-gone' };
  const m = jobHeaderModel(j, runs, employees);
  assert.equal(m.next.ownerName, null);
});

test('HOA, permit, materials and 811 are independent parallel checks, not steps -- none of them appear in the linear path', () => {
  const j = { ...readyJob(), hoa_approval_status: 'PENDING', permit_status: 'PENDING', materials_status: 'ORDERED' };
  const m = jobHeaderModel(j, runs, employees);
  const stepKeys = m.steps.map(s => s.key);
  assert.ok(!stepKeys.includes('hoa') && !stepKeys.includes('permit') && !stepKeys.includes('materials'),
    'HOA/permit/materials must not be forced into the linear path');
  // But a job otherwise fully ready is still blocked by them, and the path's
  // own linear steps (signed, deposit, scheduled, etc.) still read ok --
  // parallel failures do not fake a linear-path failure.
  assert.equal(m.ready, false);
  assert.ok(m.steps.find(s => s.key === 'signed').ok);
  assert.ok(m.steps.find(s => s.key === 'deposit').ok);
  const hoa = m.parallel.find(p => p.key === 'hoa');
  const permit = m.parallel.find(p => p.key === 'permit');
  const materials = m.parallel.find(p => p.key === 'materials');
  assert.equal(hoa.item.ok, false);
  assert.equal(permit.item.ok, false);
  assert.equal(materials.item.ok, false);
  assert.equal(hoa.fix, '#panelHoa');
  assert.equal(permit.fix, '#panelHoa');
  assert.equal(materials.fix, '#panelMaterials');
});

test('811 locate has no fix target -- the office has no field for it', () => {
  const j = { ...readyJob(), locate_called_at: '2026-08-01T00:00:00Z', locate_expires_at: '2026-09-01T00:00:00Z' };
  const m = jobHeaderModel(j, runs, employees);
  const locate = m.parallel.find(p => p.key === 'locate811');
  assert.equal(locate.item.ok, false);
  assert.equal(locate.fix, null);
  const blockedLocate = m.blocked.find(b => b.label === '811 locate valid');
  assert.equal(blockedLocate.fix, null);
});

test('production step tracks production_stage only once the job is sold (ACCEPTED/COMPLETED), and reads not-started before a stage is set', () => {
  const notSold = jobHeaderModel({ ...readyJob(), status: 'SENT', quote_approved_at: null }, runs, employees);
  const prodNotSold = notSold.steps.find(s => s.key === 'production');
  assert.equal(prodNotSold.stage, null, 'a quote, however far along, is not in production');
  assert.equal(prodNotSold.ok, false);

  const soldNotStarted = jobHeaderModel(readyJob(), runs, employees);
  const prodStarted = soldNotStarted.steps.find(s => s.key === 'production');
  assert.equal(prodStarted.stage, null, 'sold but production_stage is still null (not started)');
  assert.equal(prodStarted.ok, false);

  const inDig = jobHeaderModel({ ...readyJob(), production_stage: 'DIG' }, runs, employees);
  assert.equal(inDig.steps.find(s => s.key === 'production').stage, 'DIG');
  assert.equal(inDig.steps.find(s => s.key === 'production').ok, false);

  const done = jobHeaderModel({ ...readyJob(), production_stage: 'DONE', payment_status: 'PAID_IN_FULL' }, runs, employees);
  assert.equal(done.steps.find(s => s.key === 'production').ok, true);
  assert.equal(done.ready, true);
});

test('estimate step folds Measured and Prices confirmed together, and blocks if either is missing', () => {
  const noRuns = jobHeaderModel(readyJob(), [], employees);
  assert.equal(noRuns.steps.find(s => s.key === 'estimate').ok, false);

  const noPrices = jobHeaderModel({ ...readyJob(), material_prices_confirmed_at: null }, runs, employees);
  assert.equal(noPrices.steps.find(s => s.key === 'estimate').ok, false);

  const both = jobHeaderModel(readyJob(), runs, employees);
  assert.equal(both.steps.find(s => s.key === 'estimate').ok, true);
});

test('paid step reads off payment_status directly, not off netPaid alone', () => {
  const depositOnly = jobHeaderModel({ ...readyJob(), payment_status: 'DEPOSIT_PAID' }, runs, employees);
  assert.equal(depositOnly.steps.find(s => s.key === 'paid').ok, false);

  const paidFull = jobHeaderModel({ ...readyJob(), payment_status: 'PAID_IN_FULL' }, runs, employees);
  assert.equal(paidFull.steps.find(s => s.key === 'paid').ok, true);
});
