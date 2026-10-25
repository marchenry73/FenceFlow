/* Reports business-math, lifted straight from dashboard.html and run
   standalone -- same grab()/new Function() idiom as
   tests/per-foot-pay.test.mjs and tests/catalog-run-viewer.test.mjs.
   Covers the pure functions behind the office's Reports > Business report
   panel: sales (response time, approval rate, sales value), production
   (completed/delayed/backlog), labour and materials estimate-vs-actual, crew
   productivity, and estimated-vs-actual profit. */
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

// approvalRatePct counts quotes that reached the customer, which is
// quoteDeliveredAt() -- and that reads dates through bizMs(). Lifted with it.
// salesValueTotal asks billableTotalOf() for a won job's price, so the
// accepted-price helpers come too. labourEstVsActualTotals now reads the
// $200-labour-floor formula through the one shared quotedLaborOf() (the
// three duplicated copies of "rate*feet+flat" were consolidated into it),
// so it has to be lifted alongside it or labourEstVsActualTotals throws
// "quotedLaborOf is not defined" the moment it runs.
const names = ['medianDays', 'medianHours', 'approvalRatePct', 'productionStats',
  'crewProductivityPerHour', 'quotedLaborOf', 'labourEstVsActualTotals', 'materialEstVsActualTotals',
  'salesValueTotal', 'estVsActualProfitTotals', 'bizMs', 'quoteDeliveredAt',
  'stampMs', 'anchoredTotalOf', 'billableTotalOf'];
const lib = new Function(names.map(grab).join('\n') + '\nreturn {' + names.join(',') + '};')();
const { medianDays, medianHours, approvalRatePct, productionStats, crewProductivityPerHour,
  labourEstVsActualTotals, materialEstVsActualTotals, salesValueTotal,
  estVsActualProfitTotals } = lib;

// ---- medianHours --------------------------------------------------------
test('medianHours: response time between enquiry and first contact', () => {
  const pairs = [
    ['2026-09-01T08:00:00Z', '2026-09-01T10:00:00Z'], // 2h
    ['2026-09-01T08:00:00Z', '2026-09-01T12:00:00Z'], // 4h
    ['2026-09-01T08:00:00Z', '2026-09-02T08:00:00Z'], // 24h
  ];
  const m = medianHours(pairs);
  assert.equal(m.value, 4);
  assert.equal(m.n, 3);
});

test('medianHours: no data, and negative spans are dropped', () => {
  assert.equal(medianHours([]), null);
  assert.equal(medianHours([[null, '2026-09-01T00:00:00Z']]), null);
  // second pair goes backwards in time -- excluded, only one real sample left
  const m = medianHours([
    ['2026-09-01T08:00:00Z', '2026-09-01T10:00:00Z'],
    ['2026-09-01T10:00:00Z', '2026-09-01T08:00:00Z'],
  ]);
  assert.equal(m.n, 1);
  assert.equal(m.value, 2);
});

// ---- approvalRatePct -----------------------------------------------------
test('approvalRatePct: approved over sent, never divides by zero', () => {
  const jobs = [
    { quote_sent_at: '2026-01-01', quote_approved_at: '2026-01-02' },
    { quote_sent_at: '2026-01-01', quote_approved_at: null },
    { quote_sent_at: null, quote_approved_at: null }, // never sent, excluded from denominator
  ];
  assert.equal(approvalRatePct(jobs), 50);
  assert.equal(approvalRatePct([]), 0);
  assert.equal(approvalRatePct([{ quote_sent_at: null }]), 0);
});

test('PLANTED FAILURE: counting every job (not just sent ones) as the denominator would understate the rate', () => {
  const jobs = [
    { quote_sent_at: '2026-01-01', quote_approved_at: '2026-01-02' },
    { quote_sent_at: null, quote_approved_at: null },
    { quote_sent_at: null, quote_approved_at: null },
  ];
  // Correct: 1 of 1 sent quotes approved = 100%.
  assert.equal(approvalRatePct(jobs), 100);
  // A buggy version dividing by ALL jobs (3) would read 33% -- prove the two
  // disagree so this canary would fail if approvalRatePct regressed to that.
  const buggy = jobs.filter(j => j.quote_approved_at).length / jobs.length * 100;
  assert.notEqual(approvalRatePct(jobs), buggy);
});

test('PLANTED FAILURE: approvals of never-sent quotes must not inflate the rate (the live 100%)', () => {
  // The owner's real shape: the one quote the office stamped as sent was not
  // approved, and the one quote the customer approved online was shared from
  // the phone, so it has no sent date. Both reached the customer.
  const jobs = [
    { quote_sent_at: '2026-09-01T10:00:00Z', quote_approved_at: null },
    { quote_sent_at: null, quote_viewed_at: '2026-09-02T10:00:00Z', quote_approved_at: '2026-09-03T10:00:00Z' },
  ];
  assert.equal(approvalRatePct(jobs), 50);
  // The old formula -- every approval over the office-stamped sent dates --
  // read 100% on exactly these rows. Prove it would.
  const old = jobs.filter(j => j.quote_approved_at).length / jobs.filter(j => j.quote_sent_at).length * 100;
  assert.equal(old, 100);
  assert.notEqual(approvalRatePct(jobs), old);
});

// ---- productionStats ------------------------------------------------------
test('productionStats: completed, delayed (scheduled in the past, not finished), backlog (sold, not completed)', () => {
  const now = new Date('2026-09-17T12:00:00Z').getTime();
  const jobs = [
    { status: 'COMPLETED', scheduled_date: '2026-09-01' },
    { status: 'ACCEPTED', scheduled_date: '2026-09-10' },      // past due, not completed -> delayed AND backlog
    { status: 'ACCEPTED', scheduled_date: '2026-09-25' },      // future, not delayed, but backlog
    { status: 'DECLINED', scheduled_date: '2026-09-01' },      // declined never counts as delayed
    { status: 'DRAFT', scheduled_date: null },
  ];
  const s = productionStats(jobs, now);
  assert.equal(s.completed, 1);
  assert.equal(s.delayed, 1);
  assert.equal(s.backlog, 2);
});

// ---- crewProductivityPerHour ----------------------------------------------
test('crewProductivityPerHour: revenue per clocked hour, zero hours guarded', () => {
  assert.equal(crewProductivityPerHour(1000, 20), 50);
  assert.equal(crewProductivityPerHour(1000, 0), 0);
  assert.equal(crewProductivityPerHour(0, 20), 0);
});

// ---- labourEstVsActualTotals -----------------------------------------------
test('labourEstVsActualTotals: sums the ENGINE labour vs job_costing.labour_cost, skipping what it has not got', () => {
  // labor_cost is what price-job recorded -- the figure the engine actually
  // charged, already floored and already measured over billable feet MINUS
  // gate feet. The rate/feet/flat columns are left on the rows deliberately:
  // they are the numbers the office used to multiply together for itself, and
  // leaving them here means a regression to that arithmetic produces a
  // DIFFERENT total rather than the same one.
  const jobs = [
    { sync_id: 'a', labor_cost: 250, labor_rate_per_ft: 2, signed_linear_feet: 100, labor_flat_fee: 50 },
    { sync_id: 'b', labor_cost: 100, labor_rate_per_ft: 1, signed_linear_feet: 100, labor_flat_fee: 0 }, // no costing row
    { sync_id: 'c', labor_cost: 0,   labor_rate_per_ft: 0, signed_linear_feet: 0,   labor_flat_fee: 0 },
    // Never priced on the server: inputs only, no figure. The state the old
    // fixtures could not express, and the one that must be SKIPPED rather than
    // counted as zero -- otherwise the estimate shrinks while its actual stays,
    // and the aggregate reads as a saving nobody made.
    { sync_id: 'd', labor_rate_per_ft: 9, signed_linear_feet: 100, labor_flat_fee: 0 },
  ];
  const bySync = new Map([
    ['a', { job_sync_id: 'a', labour_cost: 300 }],
    ['c', { job_sync_id: 'c', labour_cost: 20 }],
    ['d', { job_sync_id: 'd', labour_cost: 400 }],
  ]);
  const t = labourEstVsActualTotals(jobs, bySync);
  assert.equal(t.estimated, 250 + 0); // b skipped: no costing row. d skipped: no engine figure.
  assert.equal(t.actual, 300 + 20);   // and d's actual is skipped WITH it, not left behind
  // Said from the other side: the office must not have multiplied anything.
  // Job d's inputs come to 900, and job a's to 250 only by coincidence of the
  // fixture -- 900 appearing anywhere here means the old arithmetic is back.
  assert.ok(t.estimated !== 250 + 900 && t.actual !== 300 + 20 + 400,
    'the aggregate counted a job the server has never priced');
});

// ---- materialEstVsActualTotals ---------------------------------------------
test('materialEstVsActualTotals: sums job_costing.quoted_material vs .material_cost', () => {
  const jobs = [{ sync_id: 'a' }, { sync_id: 'b' }];
  const bySync = new Map([
    ['a', { quoted_material: 500, material_cost: 620 }],
    ['b', { quoted_material: 200, material_cost: 180 }],
  ]);
  const t = materialEstVsActualTotals(jobs, bySync);
  assert.equal(t.estimated, 700);
  assert.equal(t.actual, 800);
});

// ---- salesValueTotal --------------------------------------------------------
test('salesValueTotal: contract_total wins; falls back to items + change orders, same as contractTotalOf', () => {
  const jobs = [
    { sync_id: 'a', contract_total: 5000 },
    { sync_id: 'b', contract_total: null },
  ];
  const items = [
    { job_sync_id: 'b', quantity: 10, unit_price: 20 },  // 200
    { job_sync_id: 'other', quantity: 999, unit_price: 999 },
  ];
  const orders = [{ job_sync_id: 'b', additional_cost: 75 }];
  assert.equal(salesValueTotal(jobs, items, orders), 5000 + 275);
});

test('PLANTED FAILURE: ignoring the contract_total fallback would undercount sales value', () => {
  const jobs = [{ sync_id: 'b', contract_total: null }];
  const items = [{ job_sync_id: 'b', quantity: 10, unit_price: 20 }];
  const naive = jobs.reduce((s, j) => s + Number(j.contract_total || 0), 0); // 0, wrong
  assert.equal(salesValueTotal(jobs, items, []), 200);
  assert.notEqual(salesValueTotal(jobs, items, []), naive);
});

test('salesValueTotal: an accepted job counts at the price the customer accepted, not a drifted contract_total', () => {
  const jobs = [{ sync_id: 'w', contract_total: 13410, accepted_total: 9710,
    signed_at: '2026-09-01T12:00:00Z', quote_approved_at: null, reapproval_required_at: null }];
  const orders = [
    { job_sync_id: 'w', additional_cost: 900, signed_at: '2026-09-02T12:00:00Z', in_accepted_total: true },   // inside the $9,710
    { job_sync_id: 'w', additional_cost: 455, signed_at: '2026-09-02T12:00:00Z', in_accepted_total: false },  // signed for since
  ];
  assert.equal(salesValueTotal(jobs, [], orders), 9710 + 455);
  // PLANTED FAILURE: the order already inside the accepted price, billed again.
  assert.notEqual(salesValueTotal(jobs, [], orders), 9710 + 455 + 900);
});

// ---- estVsActualProfitTotals ------------------------------------------------
test('estVsActualProfitTotals: actual is collected minus the same three cost buckets', () => {
  const t = estVsActualProfitTotals(1000, 4000, 1500, 1200, 300);
  assert.equal(t.estimated, 1000);
  assert.equal(t.actual, 4000 - 1500 - 1200 - 300);
});

// ---- medianDays sanity (already exists on the page; confirm still liftable
// and consistent with medianHours on the same data) --------------------------
test('medianDays and medianHours agree on the same pairs (one in days, one in hours)', () => {
  const pairs = [['2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z']]; // 2 days = 48h
  assert.equal(medianDays(pairs).value, 2);
  assert.equal(medianHours(pairs).value, 48);
});
