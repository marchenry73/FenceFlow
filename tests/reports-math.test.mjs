/* Reports business-math, lifted straight from dashboard.html and run
   standalone -- same grab()/new Function() idiom as
   tests/per-foot-pay.test.mjs and tests/catalog-run-viewer.test.mjs.
   Covers the pure functions behind the office's Reports > Business report
   panel: response time, approval rate, and labour and materials
   estimate-vs-actual.

   productionStats, crewProductivityPerHour, salesValueTotal and
   estVsActualProfitTotals used to be covered here too. They were the first
   report's helpers, left with no caller when 4ef5961 replaced it, and this
   file was the only thing keeping them alive; they were removed on 25 Oct
   2026 and the figures they carried are listed in dashboard.html beside
   quotedLaborOf(). The one figure the rewrite genuinely dropped came back as
   dataHealth()'s completedNoSignoff -- see
   tests/reports-orphans-resolved.test.mjs, which also pins the four
   supersession claims so none of this can be undone by accident. */
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
// labourEstVsActualTotals now reads the $200-labour-floor formula through the
// one shared quotedLaborOf() (the three duplicated copies of "rate*feet+flat"
// were consolidated into it), so it has to be lifted alongside it or
// labourEstVsActualTotals throws "quotedLaborOf is not defined" the moment it
// runs.
const names = ['medianDays', 'medianHours', 'approvalRatePct',
  'quotedLaborOf', 'labourEstVsActualTotals', 'materialEstVsActualTotals',
  'bizMs', 'quoteDeliveredAt', 'stampMs', 'anchoredTotalOf', 'billableTotalOf'];
const lib = new Function(names.map(grab).join('\n') + '\nreturn {' + names.join(',') + '};')();
const { medianDays, medianHours, approvalRatePct,
  labourEstVsActualTotals, materialEstVsActualTotals } = lib;

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

// ---- medianDays sanity (already exists on the page; confirm still liftable
// and consistent with medianHours on the same data) --------------------------
test('medianDays and medianHours agree on the same pairs (one in days, one in hours)', () => {
  const pairs = [['2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z']]; // 2 days = 48h
  assert.equal(medianDays(pairs).value, 2);
  assert.equal(medianHours(pairs).value, 48);
});
