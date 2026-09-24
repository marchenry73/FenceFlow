/* The office's copy of the accepted-price rule -- website/dashboard.html's
   anchoredTotalOf / billableTotalOf / contractTotalOf, and the re-basing of
   the server's ar_aging() and job_costing() rows onto it -- lifted out by name
   and run standalone, the same grab() / new Function() idiom as
   tests/office-money-parity.test.mjs.

   The rule has three copies: JobMoney.kt on the phone, billableTotal() in
   supabase/functions/_shared/quote-deposit.ts behind the quote page and the
   payment link, and this one. The server's copy is TypeScript that Node 24
   imports as it stands, so the office's answer is checked against the real
   function case by case, not against a transcription of it. Every tricky
   figure carries a PLANTED FAILURE: the plausible wrong version, run on the
   same rows, must give a different answer.

   node --test tests/office-accepted-price.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { billableTotal, depositFigures } from '../supabase/functions/_shared/quote-deposit.ts';

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

// repricedNote() also calls the page's tr() and money(). This tr() reads the
// page's own English table, so the wording under test is the page's.
const enString = (key) => {
  const m = new RegExp('\\b' + key + ":'((?:[^'\\\\]|\\\\.)*)'").exec(src);
  if (!m) throw new Error('no English string: ' + key);
  return m[1].replace(/\\'/g, "'");
};
const tr = (key, ...args) => args.reduce((s, a) => s.replace('%s', a), enString(key));
const money = n => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

// contractTotalOf and anchorOrdersOf close over the page's `items` and
// `orders`; each page below is built with its own.
const names = ['netPaid', 'balanceOf', 'stillOwed', 'stampMs', 'anchoredTotalOf', 'billableTotalOf',
  'anchorOrdersOf', 'contractTotalOf', 'anchorCostingRow', 'anchorArRows', 'anchorAgingBuckets',
  'depositAskedOf', 'repricedNote'];
const pageWith = (items, orders) => new Function('items', 'orders', 'tr', 'money',
  names.map(grab).join('\n') + '\nreturn {' + names.join(',') + '};')(items, orders, tr, money);
const P = pageWith([], []);

// Job 4598's shape: signed at $9,710 with a $900 order that was unsigned at
// the signature (so inside the $9,710, marked in_accepted_total) and signed the
// day after, a $455 order signed for since, $2,000 paid, and a live recompute
// that drifted to $13,410.
const SIGNED = '2026-09-01T12:00:00Z', LATER = '2026-09-02T12:00:00Z', EARLIER = '2026-08-30T12:00:00Z';
const job = (over = {}) => ({
  sync_id: 'j1', status: 'ACCEPTED', contract_total: 13410, accepted_total: 9710,
  signed_at: SIGNED, quote_approved_at: null, reapproval_required_at: null,
  amount_paid: 2000, refunded_amount: 0, deposit_amount: 0, ...over,
});
const co = (cost, signedAt, covered, over = {}) => ({
  job_sync_id: 'j1', additional_cost: cost, signed_at: signedAt, in_accepted_total: covered, deleted_at: null, ...over,
});
const ORDERS = [co(455, LATER, false), co(900, LATER, true)];

// The same job and orders as quote-view / create-payment-link hand them to
// billableTotal() and depositFigures().
const serverInput = (j, orders) => ({
  depositAmount: j.deposit_amount, contractTotal: j.contract_total,
  amountPaid: j.amount_paid, refundedAmount: j.refunded_amount,
  acceptedTotal: j.accepted_total, signedAt: j.signed_at, quoteApprovedAt: j.quote_approved_at,
  reapprovalRequiredAt: j.reapproval_required_at,
  changeOrders: orders.map(o => ({ additionalCost: o.additional_cost, signedAt: o.signed_at,
    deletedAt: o.deleted_at, inAcceptedTotal: o.in_accepted_total })),
});

// ---- 1. the rule ----------------------------------------------------------
test('an accepted job bills the accepted price plus the orders signed since that it did not cover -- not the drifted contract_total', () => {
  assert.equal(P.billableTotalOf(job(), ORDERS), 9710 + 455);
  assert.equal(P.anchoredTotalOf(job(), ORDERS), 10165);
});

test('PLANTED FAILURE: counting a change order already inside the accepted total bills it twice', () => {
  // The rule before change_orders.in_accepted_total: every order signed after
  // the acceptance goes on top -- the $900 inside the $9,710 included.
  const since = Date.parse(SIGNED);
  const doubleCounted = (j, orders) => Number(j.accepted_total)
    + orders.filter(o => Date.parse(o.signed_at) > since).reduce((s, o) => s + o.additional_cost, 0);
  assert.equal(doubleCounted(job(), ORDERS), 11065);
  assert.notEqual(P.billableTotalOf(job(), ORDERS), doubleCounted(job(), ORDERS));
});

test('nothing anchors the price -> contract_total, exactly as before', () => {
  assert.equal(P.billableTotalOf(job({ signed_at: null }), ORDERS), 13410, 'not accepted');
  assert.equal(P.billableTotalOf(job({ accepted_total: null }), ORDERS), 13410, 'accepted before the column existed');
  assert.equal(P.billableTotalOf(job({ accepted_total: 0 }), ORDERS), 13410, 'a zero is not a price');
  assert.equal(P.billableTotalOf(job({ reapproval_required_at: LATER }), ORDERS), 13410,
    'a drawing change withdrew the approval: the live figure is what they are asked to approve again');
  assert.equal(P.billableTotalOf(job({ accepted_total: null, contract_total: null }), ORDERS), null,
    'no figure at all is null, so contractTotalOf can fall back to the line items');
});

test('the office agrees with the server\'s billableTotal() on every shape of job', () => {
  const cases = [
    ['signed, drifted up', job(), ORDERS],
    ['signed, drifted below the price (Woody)', job({ contract_total: 200, accepted_total: 3620 }), []],
    ['approved online only', job({ signed_at: null, quote_approved_at: SIGNED }), ORDERS],
    ['both, the LATER acceptance is the one that counts', job({ signed_at: EARLIER, quote_approved_at: LATER }),
      [co(300, SIGNED, false), co(125, '2026-09-03T12:00:00Z', false)]],
    ['an order signed before the acceptance and not flagged', job(), [co(700, EARLIER, false)]],
    ['an unsigned order does not move the price', job(), [co(700, null, false)]],
    ['a deleted order counts for nothing', job(), [co(700, LATER, false, { deleted_at: LATER })]],
    ['not accepted', job({ signed_at: null }), ORDERS],
    ['no accepted figure', job({ accepted_total: null }), ORDERS],
    ['re-approval pending', job({ reapproval_required_at: LATER }), ORDERS],
    ['unpriced and unanchored', job({ accepted_total: null, contract_total: null }), []],
  ];
  for (const [label, j, orders] of cases) {
    assert.equal(P.billableTotalOf(j, orders) ?? 0, billableTotal(serverInput(j, orders)), label);
  }
});

test('the deposit the office measures is the one the quote page asks for: capped at the same price', () => {
  // depositAskedOf() is what readiness, the job header and the "Deposits
  // requested" tile and rows all measure; depositFigures() is what the quote
  // page shows and the payment link charges.
  const woody = job({ contract_total: 200, accepted_total: 3620, deposit_amount: 5730, amount_paid: 0 });
  const shapes = [
    ['stored above the accepted price (Woody)', woody],
    ['below the price', job({ deposit_amount: 500 })],
    ['none asked', job({ deposit_amount: 0 })],
    ['a negative figure', job({ deposit_amount: -40 })],
    ['unanchored, above contract_total', job({ accepted_total: null, deposit_amount: 20000 })],
    ['priced at zero: not capped to nothing', job({ accepted_total: null, contract_total: 0, deposit_amount: 500 })],
    ['no price at all', job({ accepted_total: null, contract_total: null, deposit_amount: 500 })],
  ];
  for (const [label, j] of shapes) {
    assert.equal(P.depositAskedOf(j, P.billableTotalOf(j, ORDERS)), depositFigures(serverInput(j, ORDERS)).asked, label);
  }
  assert.equal(depositFigures(serverInput(woody, [])).asked, 3620);
  // PLANTED FAILURE: the raw deposit_amount, which the Deposits requested
  // rows listed under a tile that summed the capped one.
  assert.notEqual(woody.deposit_amount, depositFigures(serverInput(woody, [])).asked);
});

// ---- 1b. the note after a re-price -----------------------------------------
// repricedNote() finds the job's orders on the page, as the job sheet does.
const R = pageWith([], ORDERS);

test('after a re-price, an accepted job\'s note names the new estimate AND the price they are still billed', () => {
  const note = R.repricedNote(job(), 13410, 'opPricedMsg', 'opPricedAnchoredMsg');
  assert.equal(note, tr('opPricedAnchoredMsg', '$13,410', '$10,165'));
  assert.match(note, /\$13,410/);
  assert.match(note, /\$10,165/);
  const saved = R.repricedNote(job(), 13410, 'jobSavedRepricedNote', 'jobSavedRepricedAnchoredNote');
  assert.equal(saved, tr('jobSavedRepricedAnchoredNote', '$13,410', '$10,165'));
  // PLANTED FAILURE: the note as it was -- "Saved. Re-priced at the office --
  // $13,410." -- shows the moved estimate as the new price and never names
  // the $10,165 the customer is billed.
  const before = tr('jobSavedRepricedNote', money(13410));
  assert.doesNotMatch(before, /\$10,165/);
  assert.notEqual(before, saved);
});

test('before acceptance, or with a re-approval pending, the estimate IS the price and the note says only that', () => {
  assert.equal(R.repricedNote(job({ signed_at: null }), 13410, 'opPricedMsg', 'opPricedAnchoredMsg'),
    tr('opPricedMsg', '$13,410'));
  assert.equal(R.repricedNote(job({ reapproval_required_at: LATER }), 13410, 'jobSavedRepricedNote', 'jobSavedRepricedAnchoredNote'),
    tr('jobSavedRepricedNote', '$13,410'));
  assert.equal(R.repricedNote(job({ accepted_total: null }), 13410, 'opPricedMsg', 'opPricedAnchoredMsg'),
    tr('opPricedMsg', '$13,410'), 'accepted before the column existed: nothing anchors it');
  assert.equal(R.repricedNote(null, 13410, 'opPricedMsg', 'opPricedAnchoredMsg'), tr('opPricedMsg', '$13,410'));
});

test('both office re-price paths report through repricedNote(), never the bare re-priced wording', () => {
  for (const fn of ['saveJob', 'keepOfficePrice']) {
    const body = grab(fn);
    assert.match(body, /repricedNote\(/, fn);
    assert.doesNotMatch(body, /tr\('(?:jobSavedRepricedNote|opPricedMsg)'/, fn + ' prints the estimate as the price');
  }
  // PLANTED FAILURE: the lines they had are caught by the same pattern.
  for (const old of ["savedNote(tr('jobSavedRepricedNote',", "msg('jobMsg', tr('opPricedMsg', money(grand)), 'ok');"]) {
    assert.match(old, /tr\('(?:jobSavedRepricedNote|opPricedMsg)'/);
  }
});

// ---- 2. contractTotalOf reads the page's own orders -----------------------
test('contractTotalOf takes only that job\'s orders from the page, and keeps the line-item fallback for an unpriced job', () => {
  const page = pageWith(
    [{ job_sync_id: 'j2', quantity: 4, unit_price: 25 }],
    [...ORDERS, co(5000, LATER, false, { job_sync_id: 'someone-else' }), co(50, null, false, { job_sync_id: 'j2' })]);
  assert.equal(page.contractTotalOf(job()), 10165);
  assert.equal(page.contractTotalOf({ sync_id: 'j2', contract_total: null, accepted_total: null }), 150);
  assert.deepEqual(page.anchorOrdersOf({ sync_id: 'j2', accepted_total: null }), [],
    'an unanchored job does not even scan the orders');
  // What the job sheet's balance becomes.
  assert.equal(page.balanceOf(job(), page.contractTotalOf(job())), 8165);
});

// ---- 3. job_costing() rows ------------------------------------------------
test('a job_costing() row is re-based on the accepted price: quoted, profit and margin move, costs and cash do not', () => {
  const row = { job_sync_id: 'j1', quoted: 13410, material_cost: 4000, labour_cost: 2500, other_cost: 500,
    total_cost: 7000, projected_profit: 6410, margin_percent: 47.8, cash_position: -5000, collected: 2000 };
  const out = P.anchorCostingRow(row, job(), ORDERS);
  assert.equal(out.quoted, 10165);
  assert.equal(out.projected_profit, 3165);
  assert.equal(out.margin_percent, 31.1);
  assert.equal(out.cash_position, -5000);
  assert.equal(out.material_cost, 4000);
  assert.equal(row.quoted, 13410, 'the server row itself is not mutated');
  // PLANTED FAILURE: moving quoted and leaving the server's profit behind.
  assert.notEqual(Object.assign({}, row, { quoted: 10165 }).projected_profit, out.projected_profit);
  // Unanchored: the very same object back.
  const plain = P.anchorCostingRow(row, job({ accepted_total: null }), ORDERS);
  assert.equal(plain, row);
});

// ---- 4. ar_aging() rows ---------------------------------------------------
const NOW = Date.parse('2026-12-15T12:00:00Z');
const serverRow = (over) => ({ job_sync_id: 'j1', customer_name: 'Dana', phone: null, email: null,
  status: 'ACCEPTED', contract_total: 13410, paid: 2000, owed: 11410,
  since: '2026-09-20T12:00:00Z', days_out: 86, bucket: '60', ...over });

test('an ar_aging() row takes the accepted price; owed follows it and keeps the ledger\'s paid figure', () => {
  const [r] = P.anchorArRows([serverRow()], [job()], ORDERS, NOW);
  assert.equal(r.contract_total, 10165);
  assert.equal(r.owed, 8165);
  assert.equal(r.paid, 2000);
  assert.equal(r.bucket, '60');
});

test('a row the accepted price settles drops out, as the function\'s own where-clause would drop it', () => {
  const rows = P.anchorArRows([serverRow({ paid: 10165, owed: 3245 })], [job({ amount_paid: 10165 })], ORDERS, NOW);
  assert.deepEqual(rows, []);
});

/* This page does NOT add jobs ar_aging() did not return -- and that is the
   change, not an omission.

   It used to. Woody: accepted at $3,620, contract_total drifted to $200, $200
   paid, so an ar_aging() that worked owed out from contract_total never listed
   him and $3,420 genuinely owed vanished from the report. The page added him
   back. Since supabase_r7_reports_accepted_price.sql, ar_aging() takes
   job_anchored_total(j) for BOTH contract_total and owed and keeps every row
   with owed > 0.005 -- so Woody is in the server's own answer and adding him
   again is adding him twice.

   Two things also made the add-back wrong in a way it could not be fixed,
   which is why it is gone rather than guarded:
     * it read the page's `jobs` array, which arrives in stages -- a bounded
       slice on the first paint, topped up after -- so the owed total grew
       while the page loaded. Reported as "Still owed kept changing from
       $86,860 to $73,000". A figure that moves under you is worse than one
       that is merely stale, because there is no moment you can trust it.
     * it worked owed out from netPaid(j), the job row's cached paid figure,
       while the server works it out from the payment_records ledger. So it
       could add a job at a balance the ledger disagreed with.

   Re-basing a row the server DID send stays (the test above): that uses the
   server's own r.paid, so it cannot disagree with the ledger, and it is what
   keeps this page right against a rolled-back function or a tab left open
   through a deploy. Inventing a row is the part that could not be made
   trustworthy. */
test('a job ar_aging() did not return is NOT added -- the server anchors the price itself now', () => {
  // The exact case the old add-back existed for.
  const woody = job({ sync_id: 'w', contract_total: 200, accepted_total: 3620, amount_paid: 200,
    customer_name: 'Woody', scheduled_date: '2026-10-01T12:00:00Z', final_sign_off_at: null,
    created_at: '2026-08-01T12:00:00Z' });
  const other = serverRow({ job_sync_id: 'j9', since: '2026-11-20T12:00:00Z', days_out: 25, bucket: 'current' });
  const rows = P.anchorArRows([other], [woody, job({ sync_id: 'j9', accepted_total: null })], [], NOW);
  assert.equal(rows.length, 1, 'only the row ar_aging() actually returned');
  assert.equal(rows[0], other, 'an unanchored row passes through as the same object');
  assert.equal(rows.some(r => r.job_sync_id === 'w'), false, 'Woody is the server’s to report, not the page’s to invent');
  // PLANTED FAILURE: the old behaviour, spelled out, so this check is not
  // passing merely because anchorArRows returned nothing useful.
  const asItUsedTo = [other].concat([{ job_sync_id: 'w', owed: 3420 }]);
  assert.equal(asItUsedTo.length, 2);
  assert.notEqual(rows.length, asItUsedTo.length);
});

test('the server DOES return that job, so nothing is lost by not adding it', () => {
  // ar_aging() as it now stands: contract_total and owed both come from
  // job_anchored_total(j), and the where-clause is owed > 0.005. Modelled here
  // rather than asserted against the database, because this file is the
  // office's own arithmetic -- tests/downstream-*.test.mjs run the real
  // function. If this model and the function ever part, THAT is the bug.
  const anchored = 3620, paid = 200;
  const owed = anchored - paid;
  assert.ok(owed > 0.005, 'the anchored price leaves Woody owing, so ar_aging() lists him');
  // And with the OLD rule he was invisible, which is what the page was patching.
  const driftedContract = 200;
  assert.ok(driftedContract - paid <= 0.005, 'the old rule settled him at zero');
});

// Nothing comes out that did not go in: given no server rows, a declined job
// and a deleted one -- each carrying an accepted figure -- produce nothing. The
// test's old name said "only won jobs are ADDED", from when the page added its
// own; it adds none now, and this is what still has to hold.
test('an empty ar_aging() answer stays empty, whatever accepted figures the page holds', () => {
  const declined = job({ sync_id: 'd', status: 'DECLINED', contract_total: 0 });
  const deleted = job({ sync_id: 'x', contract_total: 0, deleted_at: LATER });
  assert.deepEqual(P.anchorArRows([], [declined, deleted], [], NOW), []);
});

// ---- 5. business_report() aging buckets -----------------------------------
test('business_report()\'s aging moves by exactly what the re-based rows moved, and not at all when nothing is anchored', () => {
  const server = [serverRow(), serverRow({ job_sync_id: 'j2', owed: 500, bucket: 'current' })];
  const aging = { '60': { owed: 11410, n: 1 }, current: { owed: 500, n: 1 } };
  const untouched = P.anchorAgingBuckets(aging, server, server);
  assert.deepEqual(untouched, aging);
  const anchored = P.anchorArRows(server, [job(), job({ sync_id: 'j2', accepted_total: null })], ORDERS, NOW);
  const out = P.anchorAgingBuckets(aging, server, anchored);
  assert.equal(out['60'].owed, 8165);
  assert.equal(out['60'].n, 1);
  assert.equal(out.current.owed, 500);
  assert.equal(aging['60'].owed, 11410, 'the server object is not mutated');
});

// ---- 6. who reads accepted_total ------------------------------------------
// A money column. The database is the guard -- a role without SEE_MONEY reads
// no jobs rows at all (the RESTRICTIVE jobs_money_hidden_from_crew policy) --
// and on this page it is only ever turned into "the price" by the money layer,
// never printed by a screen of its own.
const READERS = new Set(['anchoredTotalOf', 'anchorOrdersOf', 'anchorArRows', 'salesValueTotal']);
// Comments are skipped the way this file writes them: a block comment opens at
// the start of a line and runs to the first line holding its close; a line
// comment follows whitespace (so a URL's // inside a string is left alone).
const readersOf = (source) => {
  const out = new Set();
  const lines = source.split('\n');
  let inBlock = false;
  lines.forEach((line, n) => {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; return; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; return; }
    const code = line.replace(/(^|\s)\/\/.*$/, '');
    if (!/\.accepted_total\b/.test(code)) return;
    for (let k = n; k >= 0; k--) {
      const m = /^\s*(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/.exec(lines[k]);
      if (m) { out.add(m[1]); return; }
    }
    out.add('<top level>');
  });
  return out;
};

test('accepted_total is selected with the job row, and read only by the money layer', () => {
  const cols = src.match(/const JOB_COLUMNS = \[([\s\S]*?)\]\.join/)[1];
  assert.match(cols, /'accepted_total'/);
  const found = readersOf(src);
  assert.ok(found.size > 0, 'the scan found no reader at all');
  assert.deepEqual([...found].filter(f => !READERS.has(f)), []);
});

test('PLANTED FAILURE: a render function printing accepted_total itself is caught', () => {
  const planted = src + '\nfunction renderSomethingNew(j){\n  return money(j.accepted_total);\n}\n';
  assert.deepEqual([...readersOf(planted)].filter(f => !READERS.has(f)), ['renderSomethingNew']);
});
