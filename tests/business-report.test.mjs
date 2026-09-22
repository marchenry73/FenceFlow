/* Reports > Business report, the maths -- lifted straight out of
   website/dashboard.html by name and run standalone, the same grab() /
   new Function() idiom as tests/reports-math.test.mjs.

   Every tricky figure gets a PLANTED FAILURE beside it: the plausible wrong
   version is computed on the same rows and must give a different answer, so a
   regression to it cannot pass quietly. Several of the wrong versions are what
   the page actually did before this report was rebuilt (a lead counted by
   updated_at, an approval rate over sent dates alone, labour hours with the
   breaks left in, outstanding netted across jobs). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runBuiltFeet } from '../website/js/lib/pay.mjs';

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

const names = [
  // the Business report's own pure layer
  'bizMs', 'inWindow', 'isWonJob', 'wonAt', 'quoteDeliveredAt', 'comparisonWindow', 'periodDelta',
  'sourceKey', 'bizPretty', 'ledgerByJob', 'paidInFullAt', 'outstandingFromLedger', 'depositAskedOf', 'bizHeadline',
  'pipelineFunnel', 'bizSpeed', 'bizBySource', 'jobTypeShares', 'bizByFenceType', 'backlogBuckets',
  'stageDurations', 'materialsWaiting', 'hoursVsEstimate', 'labourByWorker', 'moneyBreakdown',
  'dataHealth', 'onlyVisibleRows', 'trendPairRows', 'bizReportCsv', 'approvalRatePct',
  // page helpers it leans on, lifted rather than re-typed so the test runs the real ones
  'medianDays', 'medianHours', 'hoursOf', 'breakRecorded', 'breakHoursOf', 'paidHoursOf',
  'weekStart', 'visibleJobs'
];
// `d` is a one-line arrow on the page (const d = s => ...), not a function
// declaration, so grab() cannot lift it; this is the same expression.
const lib = new Function('const d = s => s ? new Date(s) : null;\n'
  + names.map(grab).join('\n') + '\nreturn {' + names.join(',') + '};')();
const L = lib;

const DAY = 864e5;
const ms = s => new Date(s).getTime();
const feetOf = (r, j) => runBuiltFeet(r, Number(j && j.calibration_pixels_per_foot) || 20);
const baseCtx = (from, to, extra) => Object.assign({
  from: ms(from), to: ms(to), runs: [], shifts: [], payments: [], contractOf: j => Number(j.contract_total || 0),
  feetOf, hoursOf: L.paidHoursOf, seeMoney: true }, extra || {});

// ---- 1. dating: a lead is its created_at, never a sync stamp -------------
test('a job created last year but touched (updated) today is not a new lead this period', () => {
  const jobs = [
    { sync_id: 'old', status: 'DRAFT', created_at: '2025-06-01T12:00:00Z', updated_at: '2026-09-20T12:00:00Z' },
    { sync_id: 'new', status: 'DRAFT', created_at: '2026-09-10T12:00:00Z', updated_at: '2026-09-10T12:00:00Z' }
  ];
  const h = L.bizHeadline(jobs, baseCtx('2026-08-22T00:00:00Z', '2026-09-21T23:59:59Z'));
  assert.deepEqual(h.leads.map(j => j.sync_id), ['new']);
  // PLANTED FAILURE: the old window rule (updated_at, else created_at) counts both.
  const touched = jobs.filter(j => L.inWindow(j.updated_at || j.created_at, ms('2026-08-22T00:00:00Z'), ms('2026-09-21T23:59:59Z')));
  assert.equal(touched.length, 2);
  assert.notEqual(h.leads.length, touched.length);
});

// ---- 2. quotes delivered: viewed or signed counts, so delivered >= won ----
test('quotes only viewed, or only signed, still count as delivered -- delivered is never below won', () => {
  const W = ['2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z'];
  const jobs = [
    { sync_id: 'viewed', status: 'SENT', created_at: '2026-09-01', quote_viewed_at: '2026-09-03T10:00:00Z' },
    { sync_id: 'signed', status: 'ACCEPTED', created_at: '2026-09-01', signed_at: '2026-09-05T10:00:00Z' },
    { sync_id: 'appr',   status: 'ACCEPTED', created_at: '2026-09-01', quote_approved_at: '2026-09-06T10:00:00Z' },
    { sync_id: 'sent',   status: 'SENT', created_at: '2026-09-01', quote_sent_at: '2026-09-02T10:00:00Z' }
  ];
  const h = L.bizHeadline(jobs, baseCtx(W[0], W[1]));
  assert.equal(h.delivered.length, 4);
  assert.equal(h.won.length, 2);
  assert.ok(h.delivered.length >= h.won.length);
  // earliest of the four stamps
  assert.equal(L.quoteDeliveredAt({ quote_sent_at: '2026-09-04', quote_viewed_at: '2026-09-02T00:00:00Z', signed_at: '2026-09-09' }),
    '2026-09-02T00:00:00Z');
  // PLANTED FAILURE: counting quote_sent_at alone (what the old "Quotes sent" did)
  // gives 1 delivered against 2 won -- a funnel that widens.
  const sentOnly = jobs.filter(j => L.inWindow(j.quote_sent_at, ms(W[0]), ms(W[1]))).length;
  assert.equal(sentOnly, 1);
  assert.ok(sentOnly < h.won.length);
});

test('won is Accepted/Completed dated by signed_at, else approval; a signed Draft is not won', () => {
  assert.equal(L.wonAt({ status: 'DRAFT', signed_at: '2026-09-01' }), null);
  assert.equal(L.wonAt({ status: 'ACCEPTED', signed_at: '2026-09-02', quote_approved_at: '2026-09-01' }), '2026-09-02');
  assert.equal(L.wonAt({ status: 'COMPLETED', quote_approved_at: '2026-09-01' }), '2026-09-01');
  assert.equal(L.wonAt({ status: 'ACCEPTED' }), null);
  assert.equal(L.isWonJob({ status: 'DECLINED' }), false);
});

// ---- 3. approval rate ------------------------------------------------------
test('PLANTED FAILURE: approval rate is 50%, not 100%, when the sent quote was not approved and the approved one was never marked sent', () => {
  const jobs = [
    { quote_sent_at: '2026-09-01T10:00:00Z', quote_approved_at: null },
    { quote_viewed_at: '2026-09-02T10:00:00Z', quote_approved_at: '2026-09-03T10:00:00Z' }
  ];
  assert.equal(L.approvalRatePct(jobs), 50);
  const old = jobs.filter(j => j.quote_approved_at).length / jobs.filter(j => j.quote_sent_at).length * 100;
  assert.equal(old, 100);
});

test('win rate: delivered quotes now won, and the "decided" rate that leaves open quotes out', () => {
  const W = ['2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z'];
  const jobs = [
    { sync_id: 'a', status: 'ACCEPTED', signed_at: '2026-09-05T00:00:00Z' },
    { sync_id: 'b', status: 'DECLINED', quote_sent_at: '2026-09-05T00:00:00Z' },
    { sync_id: 'c', status: 'SENT', quote_viewed_at: '2026-09-06T00:00:00Z' },
    { sync_id: 'd', status: 'SENT', quote_viewed_at: '2026-09-07T00:00:00Z' }
  ];
  const h = L.bizHeadline(jobs, baseCtx(W[0], W[1]));
  assert.equal(h.winRate, 25);
  assert.equal(h.decidedRate, 50);
  assert.equal(L.bizHeadline([], baseCtx(W[0], W[1])).winRate, null, 'no quotes: no rate, not 0%');
});

// ---- 4. funnel -------------------------------------------------------------
test('each funnel step is never larger than the step above it', () => {
  const W = ['2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z'];
  const jobs = [
    { sync_id: 'lead', status: 'DRAFT', created_at: '2026-09-02' },
    { sync_id: 'quoted', status: 'SENT', created_at: '2026-09-02', quote_viewed_at: '2026-09-03' },
    // won with no quote stamp at all (status set by hand in the office)
    { sync_id: 'won', status: 'ACCEPTED', created_at: '2026-09-02' },
    { sync_id: 'won2', status: 'ACCEPTED', created_at: '2026-09-03' },
    // signed off but never marked won -- one of the live inconsistencies
    { sync_id: 'off', status: 'DRAFT', created_at: '2026-09-02', final_sign_off_at: '2026-09-20' },
    { sync_id: 'paid', status: 'COMPLETED', created_at: '2026-09-02', signed_at: '2026-09-04', final_sign_off_at: '2026-09-10', contract_total: 1000 },
    { sync_id: 'before', status: 'ACCEPTED', created_at: '2026-08-01', signed_at: '2026-09-04' } // not in the cohort
  ];
  const payments = [{ job_sync_id: 'paid', amount: 1000, received_at: '2026-09-12T00:00:00Z' }];
  const ledger = L.ledgerByJob(payments);
  const paidAt = new Map(jobs.map(j => [j.sync_id, L.paidInFullAt(j.contract_total, (ledger.get(j.sync_id) || {}).rows)]));
  const steps = L.pipelineFunnel(jobs, ms(W[0]), ms(W[1]), { seeMoney: true, paidAt });
  assert.deepEqual(steps.map(s => s.key), ['lead', 'delivered', 'won', 'installed', 'paid']);
  assert.deepEqual(steps.map(s => s.value), [6, 5, 4, 2, 1]);
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i].value <= steps[i - 1].value, steps[i].key);
  // no money: no Paid step at all
  assert.deepEqual(L.pipelineFunnel(jobs, ms(W[0]), ms(W[1]), { seeMoney: false }).map(s => s.key),
    ['lead', 'delivered', 'won', 'installed']);
  // PLANTED FAILURE: counting each step on its own field widens the funnel --
  // two won jobs have no quote stamp, so independent "delivered" (2) is below
  // independent "won" (3).
  const cohort = jobs.filter(j => L.inWindow(j.created_at, ms(W[0]), ms(W[1])));
  const indepDelivered = cohort.filter(j => L.quoteDeliveredAt(j)).length;
  const indepWon = cohort.filter(L.isWonJob).length;
  assert.ok(indepDelivered < indepWon);
});

// ---- 5. fence types --------------------------------------------------------
test('the fence-type split adds back to the original totals, by footage, and tear-out runs are ignored', () => {
  const W = ['2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z'];
  const jobs = [
    { sync_id: 'j1', status: 'ACCEPTED', signed_at: '2026-09-10', contract_total: 10000 },
    { sync_id: 'j2', status: 'ACCEPTED', signed_at: '2026-09-11', contract_total: 3000 },
    { sync_id: 'j3', status: 'ACCEPTED', signed_at: '2026-09-12', contract_total: 500 } // no runs at all
  ];
  const runs = [
    { job_sync_id: 'j1', fence_type: 'VINYL', manual_linear_feet: 150 },
    { job_sync_id: 'j1', fence_type: 'WOOD', manual_linear_feet: 50 },
    { job_sync_id: 'j1', fence_type: 'CHAIN_LINK', manual_linear_feet: 400, is_teardown: true },
    { job_sync_id: 'j2', fence_type: 'WOOD', manual_linear_feet: 0 },   // nothing measurable: even split
    { job_sync_id: 'j2', fence_type: 'VINYL', manual_linear_feet: 0 }
  ];
  const runsByJob = new Map();
  runs.forEach(r => { if (!runsByJob.has(r.job_sync_id)) runsByJob.set(r.job_sync_id, []); runsByJob.get(r.job_sync_id).push(r); });
  const ft = L.bizByFenceType(jobs, { from: ms(W[0]), to: ms(W[1]), runsByJob, feetOf, seeMoney: true,
    contractOf: j => j.contract_total, costing: null });
  const by = Object.fromEntries(ft.map(r => [r.type, r]));
  assert.equal(by.VINYL.value, 10000 * 0.75 + 3000 * 0.5);
  assert.equal(by.WOOD.value, 10000 * 0.25 + 3000 * 0.5);
  assert.equal(by[''].value, 500, 'a job with no fence drawn keeps its value under "no fence drawn"');
  assert.ok(!by.CHAIN_LINK, 'tear-out is not fence being sold');
  const sum = ft.reduce((s, r) => s + r.value, 0);
  assert.equal(sum, 13500, 'the split adds back to the signed value');
  assert.equal(by.VINYL.feet, 150);
  assert.equal(by.WOOD.evenJobs, 1);
  // PLANTED FAILURE: letting the 400 ft tear-out run into the shares moves the money.
  const withTear = L.jobTypeShares(jobs[0], runs.filter(r => r.job_sync_id === 'j1').map(r => ({ ...r, is_teardown: false })), feetOf);
  const vinylWrong = withTear.shares.find(s => s.type === 'VINYL').share * 10000;
  assert.notEqual(vinylWrong, 10000 * 0.75);
  // shares always sum to 1
  const sh = L.jobTypeShares(jobs[0], runsByJob.get('j1'), feetOf).shares;
  assert.equal(sh.reduce((s, x) => s + x.share, 0), 1);
});

test('without SEE_MONEY the fence-type table carries no money fields at all', () => {
  const jobs = [{ sync_id: 'j1', status: 'ACCEPTED', signed_at: '2026-09-10', contract_total: 10000 }];
  const runsByJob = new Map([['j1', [{ job_sync_id: 'j1', fence_type: 'VINYL', manual_linear_feet: 100 }]]]);
  const ft = L.bizByFenceType(jobs, { from: ms('2026-09-01'), to: ms('2026-09-30T23:59:59Z'), runsByJob, feetOf, seeMoney: false,
    contractOf: j => j.contract_total, costing: null });
  assert.equal(ft[0].feet, 100);
  assert.equal('value' in ft[0], false);
  assert.equal('perFoot' in ft[0], false);
});

// ---- 6. outstanding --------------------------------------------------------
test('outstanding is floored per job: an overpaid job cannot cancel another customer\'s debt', () => {
  const won = [
    { sync_id: 'owes', status: 'ACCEPTED', contract_total: 5000 },
    { sync_id: 'over', status: 'COMPLETED', contract_total: 1000 }
  ];
  const ledger = L.ledgerByJob([
    { job_sync_id: 'owes', amount: 1000, received_at: '2026-09-01' },
    { job_sync_id: 'over', amount: 1500, received_at: '2026-09-01' }
  ]);
  const out = L.outstandingFromLedger(won, j => j.contract_total, ledger);
  assert.equal(out.total, 4000);
  assert.equal(out.rows.length, 1);
  // PLANTED FAILURE: netting the whole book reads 3500.
  const netted = won.reduce((s, j) => s + j.contract_total, 0) - 2500;
  assert.equal(netted, 3500);
  assert.notEqual(out.total, netted);
});

test('paid in full: the day the ledger reached the contract, and not any more after a refund', () => {
  const rows = [
    { amount: 400, received_at: '2026-09-01' },
    { amount: 600, received_at: '2026-09-05' },
    { amount: -200, received_at: '2026-09-07' },
    { amount: 200, received_at: '2026-09-09' }
  ];
  assert.equal(L.paidInFullAt(1000, rows.slice(0, 2)), '2026-09-05');
  assert.equal(L.paidInFullAt(1000, rows.slice(0, 3)), null, 'a refund took it back under');
  assert.equal(L.paidInFullAt(1000, rows), '2026-09-09', 'paid in full again, dated by when it got back there');
  assert.equal(L.paidInFullAt(0, rows), null, 'no contract, nothing to be paid in full of');
});

// ---- 7. overtime and breaks -------------------------------------------------
const shift = (start, hours, extra) => Object.assign({ job_sync_id: 'j', employee_sync_id: 'e1', started_at: start,
  ended_at: new Date(ms(start) + hours * 36e5).toISOString(), approved_at: start }, extra || {});
const labCtx = extra => Object.assign({ ownerOf: t => ({ key: t.employee_sync_id, name: t.employee_sync_id }),
  hoursOf: L.paidHoursOf, weekKey: iso => L.weekStart(iso).toISOString().slice(0, 10), otAfter: 40,
  seePay: true, isPerFoot: () => false, credits: [] }, extra || {});

test('overtime is weekly: 45 h in one week gives 5 h; 25 h in each of two weeks gives 0', () => {
  // Mon 2026-09-07 .. Fri: 9 h x 5 = 45 h, all in the week starting Sun 09-06
  const oneWeek = [0, 1, 2, 3, 4].map(i => shift(new Date(ms('2026-09-07T12:00:00Z') + i * DAY).toISOString(), 9));
  assert.equal(L.labourByWorker(oneWeek, labCtx())[0].overtimeH, 5);
  const twoWeeks = [0, 1, 2, 3, 4].map(i => shift(new Date(ms('2026-09-07T12:00:00Z') + i * DAY).toISOString(), 5))
    .concat([0, 1, 2, 3, 4].map(i => shift(new Date(ms('2026-09-14T12:00:00Z') + i * DAY).toISOString(), 5)));
  const r = L.labourByWorker(twoWeeks, labCtx())[0];
  assert.equal(r.hours, 50);
  assert.equal(r.overtimeH, 0);
  // PLANTED FAILURE: overtime off the period total would say 10 h.
  assert.notEqual(r.overtimeH, Math.max(0, r.hours - 40));
});

test('PLANTED FAILURE: labour hours deduct recorded breaks (raw clock time does not)', () => {
  const s = [shift('2026-09-08T12:00:00Z', 8, { break_minutes: 30 }), shift('2026-09-09T12:00:00Z', 8, { break_minutes: null })];
  const r = L.labourByWorker(s, labCtx())[0];
  assert.equal(r.hours, 15.5, 'a null break is "not recorded", not zero minutes, and deducts nothing');
  const raw = s.reduce((t, x) => t + L.hoursOf(x), 0);
  assert.equal(raw, 16);
  assert.notEqual(r.hours, raw);
  const h = L.bizHeadline([{ sync_id: 'j' }], baseCtx('2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z', { shifts: s }));
  assert.equal(h.hours, 15.5);
});

test('labour cost: unrated hours are counted as unrated, never folded in as $0; no cost without SEE_PAY', () => {
  const s = [shift('2026-09-08T12:00:00Z', 4, { hourly_rate: 25 }), shift('2026-09-09T12:00:00Z', 6, { hourly_rate: null }),
             shift('2026-09-10T12:00:00Z', 3, { rejected_at: '2026-09-11', approved_at: null, hourly_rate: 25 })];
  const r = L.labourByWorker(s, labCtx())[0];
  assert.equal(r.cost, 100);
  assert.equal(r.unratedH, 6);
  assert.equal(r.rejectedH, 3);
  assert.equal(r.hours, 10, 'rejected hours are kept apart');
  const hidden = L.labourByWorker(s, labCtx({ seePay: false }))[0];
  assert.equal('cost' in hidden, false);
  assert.equal('unratedH' in hidden, false);
});

// ---- 8. money is absent without SEE_MONEY ----------------------------------
test('without SEE_MONEY the money figures are absent, not zero', () => {
  const jobs = [{ sync_id: 'a', status: 'ACCEPTED', created_at: '2026-09-02', signed_at: '2026-09-03', contract_total: 9000, referral_source: 'Google' }];
  const W = baseCtx('2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z', { seeMoney: false,
    payments: [{ job_sync_id: 'a', amount: 1000, received_at: '2026-09-04' }] });
  const h = L.bizHeadline(jobs, W);
  for (const k of ['signedValue', 'collected', 'avgJob', 'paymentsIn', 'depositsRequested', 'depositsAsked']) assert.equal(k in h, false, k);
  assert.equal(h.won.length, 1, 'counts still work');
  const src = L.bizBySource(jobs, { from: W.from, to: W.to, seeMoney: false, contractOf: j => j.contract_total, payments: W.payments });
  assert.equal('value' in src.rows[0], false);
  assert.equal('collected' in src.rows[0], false);
  // and with it, they are there
  const hm = L.bizHeadline(jobs, Object.assign({}, W, { seeMoney: true }));
  assert.equal(hm.signedValue, 9000);
  assert.equal(hm.collected, 1000);
});

test('"Deposits requested": the rows under the tile add up to the tile, a deposit above the price counted at the price', () => {
  // Woody's shape: accepted at $3,620 with $5,730 stored as the deposit by an
  // old build, beside an ordinary job and one that asked for none.
  const won = (id, dep) => ({ sync_id: id, status: 'ACCEPTED', created_at: '2026-09-02', signed_at: '2026-09-03', deposit_amount: dep });
  const jobs = [won('w', 5730), won('a', 500), won('none', 0), won('neg', -40)];
  const price = { w: 3620, a: 4000, none: 2000, neg: 1000 };
  const W = baseCtx('2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z', { contractOf: j => price[j.sync_id] });
  const h = L.bizHeadline(jobs, W);
  assert.equal(h.depositsRequested, 3620 + 500);
  assert.deepEqual(h.depositsAsked.map(r => [r.job.sync_id, r.asked]), [['w', 3620], ['a', 500]],
    'no row for a job that asked for nothing');
  assert.equal(h.depositsAsked.reduce((s, r) => s + r.asked, 0), h.depositsRequested);
  // PLANTED FAILURE: the rows as the drill-down listed them before -- won jobs
  // with a deposit, each at its raw deposit_amount -- came to $6,230 under a
  // $4,120 tile.
  const rawRows = h.won.filter(j => Number(j.deposit_amount) > 0).map(j => Number(j.deposit_amount));
  assert.notEqual(rawRows.reduce((s, v) => s + v, 0), h.depositsRequested);
  // An unpriced job is not capped to nothing.
  assert.equal(L.depositAskedOf({ deposit_amount: 500 }, 0), 500);
  assert.equal(L.depositAskedOf({ deposit_amount: 500 }, null), 500);
});

// ---- 9. test fixtures ------------------------------------------------------
test('onlyVisibleRows drops a test fixture\'s job_costing / ar_aging row unless the owner shows test data', () => {
  const all = [{ sync_id: 'real' }, { sync_id: 'fx', is_test_fixture: true }];
  const rows = [{ job_sync_id: 'real', owed: 100 }, { job_sync_id: 'fx', owed: 4200 }, { job_sync_id: 'gone', owed: 7 }];
  const shown = L.visibleJobs(all, 'OWNER', false);
  assert.deepEqual(L.onlyVisibleRows(rows, shown).map(r => r.job_sync_id), ['real']);
  assert.deepEqual(L.onlyVisibleRows(rows, L.visibleJobs(all, 'MANAGER', true)).map(r => r.job_sync_id), ['real']);
  assert.deepEqual(L.onlyVisibleRows(rows, L.visibleJobs(all, 'OWNER', true)).map(r => r.job_sync_id), ['real', 'fx']);
  // PLANTED FAILURE: the unfiltered total is the live $65,850-vs-$61,650 shape.
  const leak = rows.reduce((s, r) => s + r.owed, 0);
  assert.notEqual(L.onlyVisibleRows(rows, shown).reduce((s, r) => s + r.owed, 0), leak);
});

// ---- 10. comparison windows ------------------------------------------------
test('comparison windows: previous period is adjacent and the same length; last year; none; all time', () => {
  const f = ms('2026-06-23T00:00:00Z'), t = ms('2026-09-21T23:59:59.999Z');
  const p = L.comparisonWindow(f, t, 'prev');
  assert.equal(p.to, f - 1);
  assert.equal(p.to - p.from, t - f);
  const y = L.comparisonWindow(f, t, 'yoy');
  assert.equal(new Date(y.from).getFullYear(), 2025);
  assert.equal(new Date(y.to).getMonth(), new Date(t).getMonth());
  assert.equal(L.comparisonWindow(f, t, 'none'), null);
  assert.equal(L.comparisonWindow(new Date(2000, 0, 1).getTime(), t, 'prev'), null, 'All time has no before');
  assert.equal(L.comparisonWindow(new Date(2000, 0, 1).getTime(), t, 'yoy'), null);
});

test('period deltas: a previous period of zero is "new", both zero is nothing, rates move in points', () => {
  assert.deepEqual(L.periodDelta(5, 0), { kind: 'new', dir: 'up' });
  assert.equal(L.periodDelta(0, 0), null);
  assert.equal(L.periodDelta(null, 3), null);
  const d = L.periodDelta(15, 10);
  assert.equal(d.kind, 'pct'); assert.equal(d.pct, 50); assert.equal(d.dir, 'up');
  assert.equal(L.periodDelta(10.1, 10).dir, 'flat');
  const pts = L.periodDelta(30, 20, true);
  assert.equal(pts.kind, 'pts'); assert.equal(pts.diff, 10);
  // PLANTED FAILURE: the same rate change as a percentage reads +50%.
  assert.notEqual(pts.diff, L.periodDelta(30, 20).pct);
});

// ---- 11. lead sources ------------------------------------------------------
test('sourceKey treats "Website" and " website " as one source, and blank as not recorded', () => {
  assert.equal(L.sourceKey(' Website '), L.sourceKey('website'));
  assert.equal(L.sourceKey('Home  Show'), 'home show');
  assert.equal(L.sourceKey(null), '');
  const W = ['2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z'];
  const jobs = [
    { sync_id: 'a', status: 'ACCEPTED', created_at: '2026-09-02', signed_at: '2026-09-05', contract_total: 1000, referral_source: 'Website' },
    { sync_id: 'b', status: 'SENT', created_at: '2026-09-03', quote_viewed_at: '2026-09-04', referral_source: ' website ' },
    { sync_id: 'c', status: 'DRAFT', created_at: '2026-09-03', referral_source: '' }
  ];
  const src = L.bizBySource(jobs, { from: ms(W[0]), to: ms(W[1]), seeMoney: true, contractOf: j => j.contract_total, payments: [] });
  const web = src.rows.find(r => r.key === 'website');
  assert.equal(web.leads, 2);
  assert.equal(web.won, 1);
  assert.equal(web.winRate, 50);
  assert.equal(src.leadsNoSource, 1);
  assert.equal(src.rows[src.rows.length - 1].key, '', '"Not recorded" sorts last');
  // PLANTED FAILURE: trim-only grouping (what the old chart did) splits it in two.
  assert.equal(new Set(jobs.map(j => (j.referral_source || '').trim()).filter(Boolean)).size, 2);
});

// ---- 12. stages and backlog ------------------------------------------------
test('stage medians count finished stays only, ended inside the window', () => {
  const ev = [
    { job_sync_id: 'a', stage: 'DIG', entered_at: '2026-09-01T00:00:00Z' },
    { job_sync_id: 'a', stage: 'SET', entered_at: '2026-09-03T00:00:00Z' },  // DIG 2 d
    { job_sync_id: 'a', stage: 'BUILD', entered_at: '2026-09-04T00:00:00Z' }, // SET 1 d; BUILD still open
    { job_sync_id: 'b', stage: 'DIG', entered_at: '2026-09-10T00:00:00Z' },
    { job_sync_id: 'b', stage: 'SET', entered_at: '2026-09-14T00:00:00Z' },  // DIG 4 d
    { job_sync_id: 'c', stage: 'DIG', entered_at: '2026-07-01T00:00:00Z' },
    { job_sync_id: 'c', stage: 'SET', entered_at: '2026-07-20T00:00:00Z' }   // ended before the window
  ];
  const out = L.stageDurations(ev, { jobIds: null, from: ms('2026-08-01T00:00:00Z'), to: ms('2026-09-30T23:59:59Z'),
    stages: ['DIG', 'SET', 'BUILD'] });
  const by = Object.fromEntries(out.map(s => [s.stage, s.m]));
  assert.equal(by.DIG.value, 3); assert.equal(by.DIG.n, 2);
  assert.equal(by.SET.value, 1);
  assert.equal(by.BUILD, null, 'the stage a job is in now is not a finished stay');
  // PLANTED FAILURE: without the window, July's 19-day stay joins the median.
  const all = L.stageDurations(ev, { jobIds: null, from: null, stages: ['DIG'] });
  assert.notEqual(all[0].m.value, by.DIG.value);
});

test('backlog buckets: overdue, 0-30, 31-60, 61-90, later, unscheduled -- boundaries in calendar days', () => {
  const now = new Date(2026, 8, 21, 15, 0, 0).getTime(); // 21 Sep 2026, 3 pm local
  const day = n => { const x = new Date(2026, 8, 21 + n); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
  const jobs = [-1, 0, 30, 31, 60, 61, 90, 91].map(n => ({ sync_id: 'd' + n, status: 'ACCEPTED', scheduled_date: day(n), contract_total: 100 }))
    .concat([{ sync_id: 'none', status: 'ACCEPTED', scheduled_date: null, contract_total: 100 },
             { sync_id: 'done', status: 'COMPLETED', scheduled_date: day(5), contract_total: 100 }]);
  const b = Object.fromEntries(L.backlogBuckets(jobs, now, j => j.contract_total).map(x => [x.key, x.jobs.map(j => j.sync_id)]));
  assert.deepEqual(b.overdue, ['d-1']);
  assert.deepEqual(b.d30, ['d0', 'd30']);
  assert.deepEqual(b.d60, ['d31', 'd60']);
  assert.deepEqual(b.d90, ['d61', 'd90']);
  assert.deepEqual(b.later, ['d91']);
  assert.deepEqual(b.unscheduled, ['none']);
  const counts = L.backlogBuckets(jobs, now, null);
  assert.equal(counts.reduce((s, x) => s + x.n, 0), 9, 'completed work is not backlog');
  assert.equal(counts[0].value, undefined, 'no value without money');
  // today's own date, parsed as UTC midnight, would land yesterday west of Greenwich
  assert.equal(new Date(L.bizMs('2026-09-21')).getDate(), 21);
});

// ---- 13. cycle times ignore jobs missing a stamp ---------------------------
test('PLANTED FAILURE: cycle times use only jobs that have both dates', () => {
  const W = { from: ms('2026-09-01T00:00:00Z'), to: ms('2026-09-30T23:59:59Z'), paidAt: null };
  const jobs = [
    { created_at: '2026-09-01T00:00:00Z', quote_viewed_at: '2026-09-03T00:00:00Z' }, // 2 d
    { created_at: '2026-09-01T00:00:00Z', quote_sent_at: '2026-09-05T00:00:00Z' },   // 4 d
    { created_at: '2026-09-01T00:00:00Z' }                                         // no quote yet
  ];
  const q = L.bizSpeed(jobs, W).find(s => s.key === 'quote').m;
  assert.equal(q.n, 2);
  assert.equal(q.value, 3);
  // Wrong: treating the missing stamp as "now" (21 Sep) drags the median to 4.
  const now = ms('2026-09-21T00:00:00Z');
  const wrong = L.medianDays(jobs.map(j => [j.created_at, L.quoteDeliveredAt(j) || new Date(now).toISOString()]));
  assert.notEqual(wrong.value, q.value);
  // money steps only exist when paidAt is passed (SEE_MONEY)
  assert.equal(L.bizSpeed(jobs, W).some(s => s.key === 'paid'), false);
});

test('hours vs estimate totals only jobs that have both an estimate and clocked hours', () => {
  const jobs = [
    { sync_id: 'a', estimated_duration_hours: 10 },
    { sync_id: 'b', estimated_duration_hours: 20 },  // no hours clocked
    { sync_id: 'c', estimated_duration_hours: 0 }
  ];
  const shiftsByJob = new Map([['a', [shift('2026-09-08T12:00:00Z', 12)]], ['c', [shift('2026-09-08T12:00:00Z', 3)]]]);
  const r = L.hoursVsEstimate(jobs, { shiftsByJob, hoursOf: L.paidHoursOf, feetOfJob: j => j.sync_id === 'a' ? 120 : 0 });
  assert.equal(r.n, 1);
  assert.equal(r.estimated, 10);
  assert.equal(r.actual, 12);
  assert.equal(r.noHours, 1);
  assert.equal(r.feetPerHour, 10);
  // PLANTED FAILURE: summing every estimate against every hour reads "15 h against 30 h: under budget".
  assert.notEqual(jobs.reduce((s, j) => s + j.estimated_duration_hours, 0), r.estimated);
});

test('PLANTED FAILURE: a job with five minutes on the clock is left out of per-hour figures, not read as 11,000 ft/h', () => {
  // The live shape: one installed job, 995 ft, 0.09 h clocked.
  const jobs = [{ sync_id: 'thin', estimated_duration_hours: 64.56 }];
  const shiftsByJob = new Map([['thin', [shift('2026-09-08T12:00:00Z', 0.09)]]]);
  const ctx = { shiftsByJob, hoursOf: L.paidHoursOf, feetOfJob: () => 995, valueOf: () => 13410 };
  const r = L.hoursVsEstimate(jobs, Object.assign({ minHours: 1 }, ctx));
  assert.equal(r.feetPerHour, null);
  assert.equal(r.valuePerHour, null);
  assert.equal(r.n, 0, 'no hours-vs-estimate comparison off an incomplete record');
  assert.equal(r.thin, 1);
  const naive = L.hoursVsEstimate(jobs, ctx); // no floor
  assert.ok(naive.feetPerHour > 10000, 'without the floor it reads ' + Math.round(naive.feetPerHour) + ' ft per crew hour');
});

// ---- money breakdown, data health, trend, CSV ------------------------------
test('money breakdown: before/after install is a split by date, refunds stay apart, expenses by spent_at', () => {
  const jobs = [{ sync_id: 'a', final_sign_off_at: '2026-09-10T00:00:00Z' }, { sync_id: 'b' }];
  const m = L.moneyBreakdown({ from: ms('2026-09-01T00:00:00Z'), to: ms('2026-09-30T23:59:59Z'), jobs,
    payments: [
      { job_sync_id: 'a', amount: 500, received_at: '2026-09-05', method: 'check' },
      { job_sync_id: 'a', amount: 1500, received_at: '2026-09-12', method: 'CHECK' },
      { job_sync_id: 'b', amount: 300, received_at: '2026-09-06', method: 'cash' },
      { job_sync_id: 'a', amount: -100, received_at: '2026-09-15', method: 'check' },
      { job_sync_id: 'a', amount: 999, received_at: '2026-08-15', method: 'check' }
    ],
    orders: [{ job_sync_id: 'a', created_at: '2026-09-11', additional_cost: 250, additional_feet: 10, signed_at: null }],
    expenses: [{ job_sync_id: 'a', category: 'FUEL', amount: 40, spent_at: '2026-09-02' },
               { job_sync_id: 'a', category: 'FUEL', amount: 60, spent_at: '2026-07-02' }] });
  assert.equal(m.before, 800);
  assert.equal(m.after, 1500);
  assert.equal(m.refunds, 100);
  assert.deepEqual(m.methods.map(x => x.key), ['CHECK', 'CASH'], 'methods fold case');
  assert.equal(m.changeOrders.n, 1); assert.equal(m.changeOrders.signed, 0);
  assert.equal(m.expenseTotal, 40);
});

test('data health lists the live inconsistencies, and money/pay items only for those who may see them', () => {
  const jobs = [
    { sync_id: 'd', status: 'DRAFT', signed_at: '2026-09-01', quote_viewed_at: '2026-08-30', referral_source: 'x' },
    { sync_id: 'p', status: 'ACCEPTED', signed_at: '2026-09-01', payment_status: 'DEPOSIT_PAID', contract_total: 100, signed_contract_total: 90 },
    { sync_id: 'o', status: 'ACCEPTED', final_sign_off_at: '2026-09-09', quote_approved_at: '2026-09-01' }
  ];
  const ctx = { seePay: false, seeMoney: false, shifts: [], items: [], orders: [], ledger: new Map(), hoursOf: L.paidHoursOf };
  const by = x => Object.fromEntries(x.map(i => [i.key, i.n]));
  const plain = by(L.dataHealth(jobs, ctx));
  assert.equal(plain.signedDraft, 1);
  assert.equal(plain.viewedNoSent, 2);
  assert.equal(plain.signoffNotDone, 1);
  assert.equal(plain.noSource, 2);
  assert.equal('paidNoLedger' in plain, false);
  assert.equal('noRate' in plain, false);
  const money = by(L.dataHealth(jobs, Object.assign({}, ctx, { seeMoney: true,
    items: [{ job_sync_id: 'p', supplier_unit_price: null }, { job_sync_id: 'p', supplier_unit_price: 3 }] })));
  assert.equal(money.paidNoLedger, 1, 'status says deposit paid, ledger has nothing');
  assert.equal(money.contractDrift, 1);
  assert.equal(money.noSupplier, 1);
});

test('trend rows start at the first month with data, stay inside the window and add up', () => {
  const rows = L.trendPairRows(ms('2026-01-01T00:00:00Z'), ms('2026-09-30T23:59:59Z'),
    [{ at: '2026-07-10', value: 100 }, { at: '2026-09-02', value: 50 }, { at: '2025-12-31', value: 999 }],
    [{ at: '2026-08-15', value: 20 }]);
  assert.deepEqual(rows.map(r => r.key), ['2026-07', '2026-08', '2026-09']);
  assert.deepEqual(rows.map(r => [r.a, r.b]), [[100, 0], [0, 20], [50, 0]]);
  assert.deepEqual(L.trendPairRows(0, 1, [], []), []);
});

test('the summary CSV carries the definition beside each figure', () => {
  const c = L.bizReportCsv([{ section: 'Headline', label: 'Win rate', value: 42.9, prev: null, how: 'share of delivered quotes now won' }]);
  assert.deepEqual(c.header, ['Section', 'Figure', 'This period', 'Comparison period', 'Definition']);
  assert.deepEqual(c.rows[0], ['Headline', 'Win rate', '42.9', '', 'share of delivered quotes now won']);
});

test('the page wires the report through hasPerm, not the role-only canSeeMoney', () => {
  const body = grab('bizRender');
  assert.ok(body.includes("hasPerm('SEE_MONEY')"));
  assert.ok(!body.includes('canSeeMoney('));
  assert.ok(body.includes("timesTable === 'time_entries'"), 'pay is gated on SEE_PAY via the table the server chose');
});

test('"How long things take" runs on bizSpeed, so it cannot disagree with the Business report', () => {
  const body = grab('renderCycles').replace(/\/\/.*$/gm, '');   // code, not its comments
  assert.ok(body.includes('bizSpeed('), 'same steps and same rule as "How fast jobs move"');
  assert.ok(body.includes("hasPerm('SEE_MONEY')"), 'paid-in-full steps only for money viewers');
  // PLANTED FAILURE shape: the old panel timed quotes off quote_sent_at, which
  // only the office stamps (1 of 6 real quotes), and "paid" off the last payment.
  assert.ok(!body.includes('quote_sent_at'));
  assert.ok(!body.includes('lastPaymentFor'));
});

test('the hero band dates and compares the way the report does, and shows no money without SEE_MONEY', () => {
  const body = grab('renderReports');
  assert.ok(body.includes('bizHeadline('), 'won and win rate come from bizHeadline, not jobs "touched" by a sync');
  assert.ok(body.includes('periodDelta('), 'one delta rule on the page');
  assert.ok(body.includes('deltaChip(heroH.winRate, heroP.winRate, true)'), 'win rate moves in points');
  assert.ok(body.includes("hasPerm('SEE_MONEY')"));
  assert.ok(/proTiles = !\(hasAdvancedReports\(\) && heroMoney\)/.test(body), 'profit/margin tiles need money AND the plan');
  assert.ok(body.includes("$('repHeroBand').style.display = heroMoney ? '' : 'none'"), 'no $0.00 Collected for crew');
  assert.ok(!body.includes('canSeeMoney('));
  // Built through the gated helper, never assembled inline and then hidden.
  assert.ok(body.includes("$('repHeroBand').innerHTML = repHeroBandHtml(heroMoney,"), 'the band is built by the gate');
  assert.ok(!body.includes(`'<div class="big">'+money(collected)`), 'no inline copy of the band markup');
  assert.ok(body.includes("$('repHeroBand').onclick = heroMoney ?"), 'no Collected breakdown opens without SEE_MONEY');
});

test('PLANTED FAILURE: without SEE_MONEY the Collected band holds no amount, not a hidden one', () => {
  const repHeroBandHtml = new Function(grab('repHeroBandHtml') + '\nreturn repHeroBandHtml;')();
  let formatted = 0;
  const fx = { esc: s => s, tr: k => k, chip: () => '<span class="chip">+5%</span>',
    money: v => { formatted++; return '$' + Number(v).toFixed(2); } };
  const v = { collected: 1234.5, prevCollected: 1000, spark: '<svg></svg>' };
  assert.equal(repHeroBandHtml(false, v, fx), '');
  assert.equal(formatted, 0, 'not one figure is formatted for a viewer who may not see it');
  const shown = repHeroBandHtml(true, v, fx);
  assert.ok(shown.includes('$1234.50') && shown.includes('+5%') && shown.includes('<svg>'));
  // The old shape: markup assembled unconditionally, then display:none. The
  // amount is in the page for anyone who opens the inspector.
  const old = seeMoney => ({ html: '<div class="big">' + fx.money(v.collected) + '</div>', display: seeMoney ? '' : 'none' });
  assert.ok(old(false).html.includes('$1234.50'), 'the hidden version still carries the figure');
});

test('PLANTED FAILURE: the report period boxes show the local day, not the UTC day', () => {
  const localDayStr = new Function(grab('localDayStr') + '\nreturn localDayStr;')();
  const setPreset = grab('setPreset');
  assert.ok(setPreset.includes('localDayStr(from)') && setPreset.includes('localDayStr(to)'));
  assert.ok(!setPreset.includes('toISOString'), 'toISOString is the UTC day');
  const tz = process.env.TZ;
  try {
    // Florida: the end of today is already tomorrow in UTC.
    process.env.TZ = 'America/New_York';
    const endOfDay = new Date(2026, 8, 21, 23, 59, 59, 999);
    assert.equal(localDayStr(endOfDay), '2026-09-21');
    assert.equal(endOfDay.toISOString().slice(0, 10), '2026-09-22', 'the old box read tomorrow');
    // East of Greenwich: local midnight is still yesterday in UTC.
    process.env.TZ = 'Europe/Paris';
    const midnight = new Date(2026, 8, 21, 0, 0, 0, 0);
    assert.equal(localDayStr(midnight), '2026-09-21');
    assert.equal(midnight.toISOString().slice(0, 10), '2026-09-20', 'the old box read yesterday');
    // And Apply reading a box back gives the same instant setPreset chose.
    assert.equal(new Date(localDayStr(midnight) + 'T00:00:00').getTime(), midnight.getTime());
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
  assert.ok(src.includes("repTo=new Date(t+'T23:59:59.999')"), 'Apply ends the day where setPreset does');
});

test('PLANTED FAILURE: minutes read as "under an hour", never "0 hours"', () => {
  const bizDur = new Function('tr', grab('bizDur') + '\nreturn bizDur;')((k, v) => v == null ? k : k + ':' + v);
  assert.equal(bizDur({ value: 0.004, n: 5 }, 'd'), 'bizUnderHour');       // ~6 minutes
  assert.equal(bizDur({ value: 0.2, n: 1 }, 'h'), 'bizUnderHour');         // 12 minutes, in hours
  assert.equal(bizDur({ value: 0.5, n: 2 }, 'd'), 'repCycleHours:12');
  assert.equal(bizDur({ value: 3.25, n: 2 }, 'd'), 'repCycleDays:3.3');
  assert.equal(bizDur(null, 'd'), null, 'no median is "not enough data", decided by the caller');
  // The old formatter printed the same six minutes as a zero.
  const old = m => m.value < 1 ? 'repCycleHours:' + Math.round(m.value * 24) : 'repCycleDays:' + m.value.toFixed(1);
  assert.equal(old({ value: 0.004 }), 'repCycleHours:0');
});

test('the SQL files: guarded, signed-in only, and no payload field the page never reads', () => {
  const br = readFileSync('supabase_r6_business_report.sql', 'utf8');
  const code = br.replace(/--.*$/gm, '');                       // statements, not commentary
  assert.ok(/security definer\s+set search_path = public/i.test(code));
  assert.ok(code.includes('money_scope_company_id()') && code.includes("in ('solo', 'crew')"));
  assert.ok(/revoke all on function public\.business_report\([^)]*\) from anon/.test(code));
  // job_costing() had PUBLIC and anon EXECUTE back after a drop + create (live 2026-09-21).
  assert.ok(code.includes('revoke execute on function public.job_costing(timestamptz, timestamptz) from public, anon;'));
  assert.ok(code.includes('revoke execute on function public.ar_aging() from public, anon;'));
  // Every key the reply carries is one the page reads: the windowed ledger
  // figures sat in the payload beside a LIFETIME "collected", read by nothing.
  assert.ok(!code.includes('collected_window') && !code.includes('refunds_window'));
  const keys = [...code.matchAll(/'([a-z_]+)',\s*(?:round|coalesce|jc\.|x\.|u\.|f\.)/g)].map(m => m[1]);
  assert.ok(keys.length > 10, 'found the reply keys');
  // Read by the Business report itself -- job_costing() rows elsewhere on the
  // page share several of these names, so the whole page would prove nothing.
  const reader = grab('bizRender').replace(/\/\/.*$/gm, '');
  for (const k of keys) assert.ok(reader.includes(k), 'business_report returns ' + k + ' but bizRender never reads it');
  // PLANTED FAILURE: the four keys this reply used to carry that nothing read.
  for (const k of ['unapproved_hours', 'total_cost', 'change_order_feet', 'change_orders_signed'])
    assert.ok(!reader.includes(k) && !code.includes("'" + k + "'"), k + ' is neither read nor sent');

  const gate = readFileSync('supabase_r6_money_rpc_plan_gate.sql', 'utf8').replace(/--.*$/gm, '');
  const body = name => {
    const at = gate.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(');
    assert.ok(at >= 0, name + ' is replaced, not dropped and re-created (a fresh CREATE resets its grants)');
    return gate.slice(at, gate.indexOf('$function$', gate.indexOf('$function$', at) + 1));
  };
  for (const [name, driver] of [['job_costing', 'with scope as ('], ['ar_aging', 'with jobs_in_scope as (']]) {
    const b = body(name);
    // The gate sits in the CTE every other one joins onto: inside the first
    // CTE, before the second one opens. Anywhere later filters nothing.
    const cteStart = b.indexOf(driver), cteEnd = b.indexOf('),', cteStart);
    const gateAt = b.indexOf('advanced_reports_company_id() is not null');
    assert.ok(cteStart >= 0 && gateAt > cteStart && gateAt < cteEnd, name + ' gates its driving CTE');
    // The money scope stays: the golden-path teardown checks look for it in prosrc.
    assert.ok(b.includes('money_scope_company_id()'), name + ' is still scoped by money_scope_company_id()');
  }
  assert.ok(!/drop function/i.test(gate));
  assert.ok(gate.includes("not in ('solo', 'crew')"), 'the same plans hasAdvancedReports() refuses');
});
