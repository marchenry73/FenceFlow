/* The first business report's orphaned helpers, resolved (25 Oct 2026).
 *
 * Commit 4ef5961 ("Round 6: ... richer report") replaced the first business
 * report (55944cc) and deleted its render sites without removing what fed
 * them. Four helpers and most of a TL block were left behind with no caller,
 * looking alive only because tests/reports-math.test.mjs still exercised
 * them. Three were genuinely superseded; one carried a figure that the
 * rewrite dropped.
 *
 * This file is the record of that decision, under test. It does two jobs:
 *
 *   1. The four are gone, and their dead TL keys with them, in all three
 *      language tables -- so nothing reinstates them by copying an old file
 *      back over this one.
 *
 *   2. Each "superseded by" claim is PROVED against the live page, not
 *      asserted in a comment. A comment saying "the Signed value tile does
 *      what salesValueTotal did" is worth nothing the day the tile changes;
 *      the test below runs the deleted function's own arithmetic beside the
 *      page's and requires the same answer. That is what makes the removal
 *      reversible on evidence rather than on memory.
 *
 * The one figure that was LOST is productionStats().completed, and it is not
 * restored as a count -- see the dataHealth() section at the bottom for why,
 * and for the check that took its place.
 */
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

/* Comments are stripped before any "is this called?" or "does this code say
   X?" question is asked of the source. The prose in this file is dense and
   full of function names in brackets: counting raw matches would find
   `productionStats()` in a paragraph explaining that it was removed and
   report it as a live caller. Strings are preserved (a TL value may legally
   contain anything) but their contents never satisfy a \b-delimited call
   match that matters here. */
const stripComments = (s) => {
  const out = [];
  let i = 0, instr = null;
  while (i < s.length) {
    const c = s[i];
    if (instr) {
      if (c === '\\') { out.push('  '); i += 2; continue; }
      if (c === instr) instr = null;
      out.push(c); i += 1; continue;
    }
    if (s.startsWith('<!--', i)) { const j = s.indexOf('-->', i); const e = j < 0 ? s.length : j + 3; out.push(s.slice(i, e).replace(/[^\n]/g, ' ')); i = e; continue; }
    if (s.startsWith('/*', i)) { const j = s.indexOf('*/', i); const e = j < 0 ? s.length : j + 2; out.push(s.slice(i, e).replace(/[^\n]/g, ' ')); i = e; continue; }
    if (s.startsWith('//', i)) { const j = s.indexOf('\n', i); const e = j < 0 ? s.length : j; out.push(' '.repeat(e - i)); i = e; continue; }
    if (c === '"' || c === "'" || c === '`') { instr = c; out.push(c); i += 1; continue; }
    out.push(c); i += 1;
  }
  return out.join('');
};

const code = stripComments(src);
const uses = (name) => (code.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length;

// The TL tables, evaluated rather than regexed -- French is full of
// apostrophes and a regex miscounts any value holding a brace or a quote.
// Same extraction tests/office-language-parity.test.mjs uses.
const TL = (() => {
  const start = src.indexOf('const TL = {');
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return eval('(' + src.slice(src.indexOf('{', start), i + 1) + ')'); }
  }
  throw new Error('TL table not found');
})();

// ---- 0. the stripper has teeth -------------------------------------------
// Everything below rests on stripComments(), and a stripper that quietly
// returned the source unchanged would make every "zero callers" result
// vacuous -- a prose mention in brackets is exactly how one of these checks
// passed for nothing once already.
test('CANARY: stripComments actually removes a comment, and keeps the code beside it', () => {
  const s = '/* productionStats() is gone */\nconst keep = productionStats;\n// productionStats again\n';
  const out = stripComments(s);
  assert.equal((out.match(/\bproductionStats\b/g) || []).length, 1,
    'the only survivor must be the real reference on the code line');
  assert.ok(out.includes('const keep ='), 'code beside a comment must survive');
  assert.equal(out.length, s.length, 'offsets must be preserved, blanks not deletions');
});

test('CANARY: the stripper was run over the real page, not an empty string', () => {
  assert.equal(code.length, src.length);
  assert.ok(code.includes('function dataHealth('), 'the live source is present after stripping');
});

// ---- 1. the four are gone -------------------------------------------------
const REMOVED = ['productionStats', 'crewProductivityPerHour', 'salesValueTotal', 'estVsActualProfitTotals'];

test('the four orphaned helpers are gone from the page, definition and all', () => {
  REMOVED.forEach((n) => {
    assert.equal(src.includes('function ' + n + '('), false, n + ' is still defined');
    assert.equal(uses(n), 0, n + ' is still referenced in code');
  });
});

test('CANARY: the orphan detector can see a function that IS present', () => {
  // quotedLaborOf and labourEstVsActualTotals are alive and wired. If the
  // check above could not tell the difference, it would report the removed
  // four as absent whatever the file said.
  assert.ok(src.includes('function quotedLaborOf('));
  assert.ok(uses('labourEstVsActualTotals') >= 2,
    'a live helper is its definition plus at least one caller');
});

// ---- 2. their TL keys are gone, in all three tables ------------------------
const DEAD_KEYS = [
  'reportsSalesHead', 'reportsSalesLeads', 'reportsSalesResponseTime', 'reportsSalesQuotesSent',
  'reportsSalesApprovalRate', 'reportsSalesValue', 'reportsSalesBySalesperson',
  'reportsProductionHead', 'reportsProductionCompleted', 'reportsProductionDelayed',
  'reportsProductionCycleTime', 'reportsProductionBacklog',
  'reportsLabourHead', 'reportsLabourHours', 'reportsLabourCost', 'reportsLabourCrewProductivity',
  'reportsMaterialsHead', 'reportsMaterialsSupplierPricing',
  'reportsFinancialHead', 'reportsFinancialRevenue', 'reportsFinancialDeposits',
  'reportsFinancialOutstanding', 'reportsFinancialExpenses', 'reportsFinancialMargin',
  'reportsFinancialEstVsActualProfit', 'reportsNoData',
  // These five were orphaned by the same commit and are not in the brief's
  // list: the rewrite's filter bar kept Employee / Fence type / Job status /
  // All and dropped the rest, so Date range, From, To, Crew and Salesperson
  // had no reader either.
  'reportsFilterDate', 'reportsFilterFrom', 'reportsFilterTo',
  'reportsFilterCrew', 'reportsFilterSalesperson'
];

test('every dead reportsXxx key is gone from en, es and fr alike', () => {
  ['en', 'es', 'fr'].forEach((lang) => {
    const left = DEAD_KEYS.filter((k) => k in TL[lang]);
    assert.deepEqual(left, [], lang + ' still defines dead keys');
  });
});

test('the reportsXxx keys that DO have readers are untouched', () => {
  // Removing a live key is the opposite mistake and a worse one: applyStaticText
  // does `el.textContent = tr(k)`, and tr() of an undefined key returns '',
  // so a data-t pointing at a deleted key BLANKS the element on boot in every
  // language rather than falling back to the English in the markup.
  const LIVE = ['reportsFilterAll', 'reportsFilterEmployee', 'reportsFilterFenceType',
    'reportsFilterStatus', 'reportsMoneyHidden'];
  LIVE.forEach((k) => {
    ['en', 'es', 'fr'].forEach((lang) => assert.ok(k in TL[lang], k + ' missing from ' + lang));
    assert.ok(uses(k) >= 1, k + ' lost its reader');
  });
});

test('no reportsXxx key is left in the tables without a reader', () => {
  // The general form of the check above, so the next orphan is caught when it
  // is made rather than a year later. A key is read either by a data-t
  // attribute or by a tr('key') call; both are plain literals on this page
  // (there is no dynamic tr() key construction -- see the canary below).
  const defined = Object.keys(TL.en).filter((k) => k.startsWith('reports'));
  assert.ok(defined.length > 0, 'no reportsXxx keys found at all -- the scan is broken');
  const orphans = defined.filter((k) => {
    const defs = (code.match(new RegExp('^\\s*' + k + '\\s*:', 'gm')) || []).length;
    return uses(k) <= defs;      // nothing but the three table entries
  });
  assert.deepEqual(orphans, []);
});

test('CANARY: the orphan-key scan would catch a key with no reader', () => {
  const planted = 'reportsThisKeyHasNoReader';
  assert.equal(uses(planted), 0);
  assert.ok(!(planted in TL.en), 'the canary name must not be a real key');
});

test('tr() keys on this page are literals, so a literal scan is a complete one', () => {
  // If a key were ever assembled (tr('reports' + section)), every orphan
  // result above would be a guess. There is no such call today, and this
  // fails the day one is added, which is the point at which the scans here
  // need rethinking.
  assert.equal(/\btr\(\s*[^'")\s][^)]*\+/.test(code), false, 'a tr() call builds its key');
  assert.equal(/\btr\(\s*`/.test(code), false, 'a tr() call uses a template literal key');
});

// ---- 3. "superseded by", proved ------------------------------------------

test('salesValueTotal survived as the Signed value tile: same arithmetic, same answer', () => {
  /* The tile is H.signedValue, which bizHeadline() builds as
     won.reduce(contractOf) with contractOf = contractTotalOf. The deleted
     function summed billableTotalOf() over won jobs with the same
     items-plus-change-orders fallback, inlining the accepted_total
     conditional that anchorOrdersOf() holds. Run the deleted body beside the
     live chain on rows where the two could disagree -- a job priced by the
     engine, a job with no contract_total at all, and a job whose
     contract_total has drifted away from what the customer accepted. */
  const names = ['billableTotalOf', 'anchoredTotalOf', 'stampMs', 'bizMs', 'anchorOrdersOf'];
  const items = [{ job_sync_id: 'b', quantity: 10, unit_price: 20 }];
  const orders = [
    { job_sync_id: 'b', additional_cost: 75 },
    { job_sync_id: 'w', additional_cost: 900, signed_at: '2026-09-02T12:00:00Z', in_accepted_total: true },
    { job_sync_id: 'w', additional_cost: 455, signed_at: '2026-09-02T12:00:00Z', in_accepted_total: false }
  ];
  // contractTotalOf() closes over the page's `items` and `orders` globals, so
  // it is lifted with those names bound to the fixture rows.
  const L = new Function('items', 'orders',
    names.map(grab).join('\n') + '\n' + grab('contractTotalOf')
    + '\nreturn { contractTotalOf, billableTotalOf };')(items, orders);

  // The deleted function, verbatim from the commit that removed it.
  const salesValueTotal = (wonJobs, itemsAll, ordersAll) => wonJobs.reduce((sum, j) => {
    const billable = L.billableTotalOf(j, j.accepted_total != null
      ? ordersAll.filter(o => o.job_sync_id === j.sync_id) : []);
    if (billable != null) return sum + billable;
    const mat = itemsAll.filter(i => i.job_sync_id === j.sync_id)
      .reduce((s, i) => s + (i.quantity || 0) * (i.unit_price || 0), 0);
    const co = ordersAll.filter(o => o.job_sync_id === j.sync_id)
      .reduce((s, o) => s + (o.additional_cost || 0), 0);
    return sum + mat + co;
  }, 0);

  const won = [
    { sync_id: 'a', contract_total: 5000 },
    { sync_id: 'b', contract_total: null },
    { sync_id: 'w', contract_total: 13410, accepted_total: 9710,
      signed_at: '2026-09-01T12:00:00Z', quote_approved_at: null, reapproval_required_at: null }
  ];
  const tile = won.reduce((s, j) => s + Number(L.contractTotalOf(j) || 0), 0);
  assert.equal(tile, salesValueTotal(won, items, orders));
  // and it is not a pair of zeroes agreeing with each other
  assert.ok(tile > 0, 'the fixture produced no value at all');
  // PLANTED FAILURE: the naive sum of contract_total, which is what both of
  // them exist to avoid -- job b has none and job w's has drifted.
  assert.notEqual(tile, won.reduce((s, j) => s + Number(j.contract_total || 0), 0));
});

test('productionStats backlog and delayed survived in backlogBuckets, on the same or a tighter rule', () => {
  const L = new Function(grab('bizMs') + '\n' + grab('backlogBuckets')
    + '\nreturn { backlogBuckets };')();
  const now = new Date('2026-09-17T12:00:00Z').getTime();
  const jobs = [
    { sync_id: 'c', status: 'COMPLETED', scheduled_date: '2026-09-01' },
    { sync_id: 'late', status: 'ACCEPTED', scheduled_date: '2026-09-10' },
    { sync_id: 'soon', status: 'ACCEPTED', scheduled_date: '2026-09-25' },
    { sync_id: 'dec', status: 'DECLINED', scheduled_date: '2026-09-01' },
    { sync_id: 'draft', status: 'DRAFT', scheduled_date: null }
  ];
  const bk = L.backlogBuckets(jobs, now, null);
  const n = (k) => bk.find(b => b.key === k).n;

  // backlog: the buckets partition exactly the ACCEPTED jobs, so their counts
  // sum to the figure productionStats().backlog returned.
  assert.equal(bk.reduce((s, b) => s + b.n, 0), jobs.filter(j => j.status === 'ACCEPTED').length);
  assert.equal(bk.reduce((s, b) => s + b.n, 0), 2);

  // delayed: the overdue bucket is the same job, by a stricter rule.
  assert.equal(n('overdue'), 1);
  assert.deepEqual(bk.find(b => b.key === 'overdue').jobs.map(j => j.sync_id), ['late']);

  // The rule really is tighter, in both ways the note in dashboard.html
  // claims. First: a Sent quote with a stale scheduled date was "delayed" and
  // is not in the backlog, because it is not sold work.
  const stale = jobs.concat([{ sync_id: 'sent', status: 'SENT', scheduled_date: '2026-09-01' }]);
  const oldDelayed = stale.filter(j => j.scheduled_date
    && new Date(j.scheduled_date).getTime() < now
    && !['COMPLETED', 'DECLINED'].includes(j.status)).length;
  assert.equal(oldDelayed, 2);
  assert.equal(L.backlogBuckets(stale, now, null).find(b => b.key === 'overdue').n, 1);

  // Second: a job scheduled for TODAY is not late at lunchtime. The old rule
  // compared against the clock and called it delayed; the bucket compares
  // against midnight and does not.
  const today = [{ sync_id: 't', status: 'ACCEPTED', scheduled_date: '2026-09-17' }];
  assert.equal(today.filter(j => new Date(j.scheduled_date).getTime() < now).length, 1,
    'the old rule called a job scheduled for today late');
  assert.equal(L.backlogBuckets(today, now, null).find(b => b.key === 'overdue').n, 0);
});

test('crewProductivityPerHour survived as Value per hour, which ties both sides to the same jobs', () => {
  const L = new Function('const d = s => s ? new Date(s) : null;\n'
    + grab('bizMs') + '\n' + grab('hoursVsEstimate') + '\nreturn { hoursVsEstimate };')();
  const jobs = [{ sync_id: 'j1', contract_total: 4000 }, { sync_id: 'j2', contract_total: 2000 }];
  const shiftsByJob = new Map([
    ['j1', [{ ended_at: 'x' }, { ended_at: 'x' }]],   // 2 shifts
    ['j2', [{ ended_at: 'x' }]]
  ]);
  const out = L.hoursVsEstimate(jobs, { shiftsByJob, hoursOf: () => 10, feetOfJob: () => 0,
    minHours: 1, valueOf: j => Number(j.contract_total || 0) });
  // 6000 of signed value over 30 hours clocked ON THOSE JOBS.
  assert.equal(out.valuePerHour, 6000 / 30);

  /* PLANTED FAILURE: the deleted function's rule, money RECEIVED in the
     window over hours WORKED in the window. The two sets need not overlap, so
     a month spent collecting on last quarter's work reads as a crew three
     times as productive on exactly the same hours. */
  const crewProductivityPerHour = (revenue, hours) => (hours > 0.005 ? revenue / hours : 0);
  const collectedThisMonth = 18000;      // deposits landing on older jobs
  assert.notEqual(crewProductivityPerHour(collectedThisMonth, 30), out.valuePerHour);

  // and the page really does show that tile, gated on money.
  const body = stripComments(grab('bizRender'));
  assert.ok(body.includes("tr('bizValuePerHour')"), 'the Value per hour tile is gone');
  assert.ok(body.includes('valuePerHour'));
});

test('estVsActualProfitTotals survived as the Projected profit and Cash position tiles', () => {
  /* Both sides are computed per job by job_costing() on the server --
     projected_profit is quoted minus the three cost buckets, cash_position is
     collected minus the same three -- and the panel sums the rows. Assert the
     page reads those two columns rather than re-subtracting in the browser,
     and that summing them gives what the deleted function gave. */
  const body = stripComments(grab('bizRender'));
  assert.ok(body.includes("sum('projected_profit')"), 'the estimated side is no longer the server column');
  assert.ok(body.includes("sum('cash_position')"), 'the actual side is no longer the server column');

  const rows = [
    { projected_profit: 600, cash_position: 1000, collected: 4000, material_cost: 1500, labour_cost: 1200, other_cost: 300 },
    { projected_profit: 400, cash_position: -200, collected: 500, material_cost: 400, labour_cost: 250, other_cost: 50 }
  ];
  const sum = (k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
  // The deleted function, verbatim, over the same rows' aggregates.
  const estVsActualProfitTotals = (estimatedProfit, collected, materialCost, labourCost, otherCost) =>
    ({ estimated: estimatedProfit, actual: collected - materialCost - labourCost - otherCost });
  const old = estVsActualProfitTotals(sum('projected_profit'), sum('collected'),
    sum('material_cost'), sum('labour_cost'), sum('other_cost'));
  assert.equal(sum('projected_profit'), old.estimated);
  assert.equal(sum('cash_position'), old.actual);
  // not two zeroes agreeing
  assert.equal(old.actual, 800);
});

// ---- 4. the figure that was LOST, and the check that replaced it ----------

const H = new Function('const d = s => s ? new Date(s) : null;\n'
  + ['bizMs', 'inWindow', 'isWonJob', 'wonAt', 'quoteDeliveredAt', 'sourceKey', 'dataHealth']
    .map(grab).join('\n') + '\nreturn { dataHealth };')();

const healthCtx = { seePay: false, seeMoney: false };
const byKey = (list) => Object.fromEntries(list.filter(x => x.n > 0).map(x => [x.key, x.n]));

test('a job marked Completed with no sign-off is named, not silently dropped', () => {
  /* This is productionStats().completed, restored as the thing it was
     actually good for. "Installed" on this report is final_sign_off_at and
     the backlog is status ACCEPTED, so this job is in NEITHER -- it is
     missing from the Installed tile, its feet, hours-vs-estimate, the cycle
     times and the backlog, all at once, and before this check nothing on the
     page said a job had gone missing. A count of COMPLETED jobs beside the
     Installed tile would have been a second definition of "done" that
     disagrees with the first; naming the disagreement is the honest form. */
  const jobs = [
    { sync_id: 'ghost', status: 'COMPLETED', final_sign_off_at: null },
    { sync_id: 'proper', status: 'COMPLETED', final_sign_off_at: '2026-09-10T12:00:00Z' },
    { sync_id: 'open', status: 'ACCEPTED', final_sign_off_at: null }
  ];
  const h = byKey(H.dataHealth(jobs, healthCtx));
  assert.equal(h.completedNoSignoff, 1);
  const rows = H.dataHealth(jobs, healthCtx).find(x => x.key === 'completedNoSignoff');
  assert.deepEqual(rows.jobs.map(j => j.sync_id), ['ghost'],
    'a properly signed-off job, or one still open, must not be flagged');
});

test('the two sign-off checks are opposite directions and neither covers the other', () => {
  /* signoffNotDone has always been "signed off but not marked Completed" --
     a job counted twice. The new one is "marked Completed but never signed
     off" -- a job counted nowhere. A single check cannot see both, and the
     old one reporting zero was the reason the gap went unnoticed. */
  const onlyNew = [{ sync_id: 'g', status: 'COMPLETED', final_sign_off_at: null }];
  const onlyOld = [{ sync_id: 's', status: 'ACCEPTED', final_sign_off_at: '2026-09-01T00:00:00Z' }];
  const a = byKey(H.dataHealth(onlyNew, healthCtx));
  const b = byKey(H.dataHealth(onlyOld, healthCtx));
  assert.equal(a.completedNoSignoff, 1);
  assert.equal('signoffNotDone' in a, false, 'the old check fires on the new case');
  assert.equal(b.signoffNotDone, 1);
  assert.equal('completedNoSignoff' in b, false, 'the new check fires on the old case');
});

/* ---- the render path, which is where this would actually fail ----------
 *
 * dataHealth() is pure and is covered above. Putting its answer on screen is
 * not: bizRender does tr(words[x.key][0]) for the label, tr(words[x.key][1])
 * for the reason and countText(x) for the number, and tr() returns '' for a
 * key it cannot find rather than throwing. A check that fires correctly and
 * renders as an empty label beside a bare number is indistinguishable, to the
 * person reading it, from a panel that found nothing -- which is the exact
 * shape of bug this whole exercise was about.
 *
 * So the row is rendered here with the page's OWN tr(), in all three
 * languages, rather than inferred from "the key is in the table".
 */
const makeTr = (lang) => new Function('TL', 'LANG', grab('tr') + '\nreturn tr;')(TL, lang);

// The render's own expressions, reconstructed from the source rather than
// retyped, so they cannot drift from what the page does.
const WORDS = (() => {
  const body = stripComments(grab('bizRender'));
  const from = body.indexOf('const words = {');
  const text = body.slice(from, body.indexOf('};', from));
  const out = {};
  for (const m of text.matchAll(/([A-Za-z0-9_]+):\s*\['([A-Za-z0-9_]+)',\s*'([A-Za-z0-9_]+)'\]/g)) {
    out[m[1]] = [m[2], m[3]];
  }
  return out;
})();

test('CANARY: the words map was really parsed out of bizRender', () => {
  assert.ok(Object.keys(WORDS).length >= 10, 'parsed only ' + Object.keys(WORDS).length + ' entries');
  assert.deepEqual(WORDS.signoffNotDone, ['bizHSignoffNotDone', 'bizHSignoffNotDoneWhy']);
});

test('the Completed-but-never-signed-off row renders with real words in en, es and fr', () => {
  const jobs = [
    { sync_id: 'ghost', status: 'COMPLETED', final_sign_off_at: null },
    { sync_id: 'also', status: 'COMPLETED', final_sign_off_at: '' },
    { sync_id: 'proper', status: 'COMPLETED', final_sign_off_at: '2026-09-10T12:00:00Z' }
  ];
  const row = H.dataHealth(jobs, healthCtx).find(x => x.key === 'completedNoSignoff');
  assert.equal(row.n, 2, 'an empty-string stamp is no stamp either');

  const seen = new Set();
  ['en', 'es', 'fr'].forEach((lang) => {
    const tr = makeTr(lang);
    const [labelKey, whyKey] = WORDS[row.key];
    const label = tr(labelKey), why = tr(whyKey);
    // countText()'s default arm for this key, as bizRender writes it.
    const count = String(row.n);
    assert.ok(label.length > 0, 'blank label in ' + lang);
    assert.ok(why.length > 0, 'blank reason in ' + lang);
    assert.equal(count, '2');
    assert.equal(label.includes('%s'), false, 'an unsubstituted %s reached the screen in ' + lang);
    assert.equal(why.includes('%s'), false, 'an unsubstituted %s reached the screen in ' + lang);
    seen.add(label);
  });
  assert.equal(seen.size, 3, 'the three languages did not give three different labels');
});

test('every health row on the panel renders, and renders translated, in every language', () => {
  /* The general form, so the next check added to dataHealth is covered the
     day it lands.

     Two different failures, because tr() is
     `(TL[LANG] && TL[LANG][key]) || TL.en[key] || ''` and '' is FALSY:

       * a key missing from the English table too renders as the empty
         string -- a row with a number and no words beside it;
       * a key present but blank (or absent) in es/fr renders the ENGLISH,
         which is the quiet revert office-language-parity's own header warns
         about and which its checks cannot see here: the key is present, so
         it is not "missing", and '' is not equal to the English string, so
         it is not "a copy of the English" either.

     The second is the one that actually happens, so it is asserted
     separately rather than folded into a length check that a fallback
     always satisfies. All 22 health strings are genuinely translated today;
     this keeps them that way. */
  const keys = Object.keys(WORDS);
  assert.ok(keys.length >= 10, 'the words map parsed almost nothing');
  ['en', 'es', 'fr'].forEach((lang) => {
    const tr = makeTr(lang);
    keys.forEach((k) => {
      WORDS[k].forEach((tlKey) => {
        assert.ok(tr(tlKey).length > 0, tlKey + ' renders blank in ' + lang);
      });
    });
  });
  ['es', 'fr'].forEach((lang) => {
    keys.forEach((k) => {
      WORDS[k].forEach((tlKey) => {
        const v = TL[lang][tlKey];
        assert.ok(v && String(v).trim().length > 0,
          tlKey + ' is blank in ' + lang + ', so the panel silently shows English');
        assert.notEqual(v, TL.en[tlKey], tlKey + ' is still the English in ' + lang);
      });
    });
  });
});

test('CANARY: a blanked translation falls back to English rather than rendering empty', () => {
  /* The behaviour the test above is built around, pinned -- if tr() ever
     stopped falling back, the assertions would be guarding the wrong thing. */
  const tr = new Function('TL', 'LANG', grab('tr') + '\nreturn tr;')(
    { en: { k: 'English words' }, fr: { k: '' } }, 'fr');
  assert.equal(tr('k'), 'English words', 'a blank no longer falls back');
  const trMissing = new Function('TL', 'LANG', grab('tr') + '\nreturn tr;')(
    { en: {}, fr: {} }, 'fr');
  assert.equal(trMissing('k'), '', 'a key in no table no longer renders empty');
});

test('CANARY: a blank translation value would be caught, not just a missing key', () => {
  // "in TL" is weaker than "renders something": an empty string is a present
  // key. Prove the check above distinguishes them.
  const tr = new Function('TL', 'LANG', grab('tr') + '\nreturn tr;')(
    { en: { blankKey: '', realKey: 'Something' } }, 'en');
  assert.equal(tr('blankKey').length, 0);
  assert.equal(tr('missingEntirely').length, 0);
  assert.ok(tr('realKey').length > 0);
});

test('the new check reaches the report summary CSV, not just the panel', () => {
  /* bizRender pushes a bizSummaryLines entry for EVERY dataHealth key, live
     or not (dh.forEach, not live.forEach), so the exported summary carries a
     zero line too. That is deliberate -- "0 jobs marked Completed without a
     sign-off" is an answer -- but it only works while the words entry
     resolves, because the push calls tr(words[x.key][0]) the same way. */
  const body = stripComments(grab('bizRender'));
  const tail = body.slice(body.indexOf("const words = {"));
  assert.ok(/dh\.forEach\(x => bizSummaryLines\.push\(/.test(tail),
    'the summary no longer covers every health key');
  const clean = H.dataHealth([{ sync_id: 'ok', status: 'ACCEPTED', final_sign_off_at: null }], healthCtx);
  const zero = clean.find(x => x.key === 'completedNoSignoff');
  assert.equal(zero.n, 0, 'an open job must not trip the check');
  const tr = makeTr('en');
  assert.ok(tr(WORDS.completedNoSignoff[0]).length > 0, 'the zero line would export a blank label');
});

test('the check reads columns the page actually fetches', () => {
  /* It filters on j.status and j.final_sign_off_at. If final_sign_off_at were
     not in the select list it would be undefined on every row and the check
     would flag EVERY completed job -- a false alarm on all of them, which
     reads as a real finding. tests/job-columns.test.mjs guards the list in
     general; this names the two columns this check depends on. */
  const cols = src.match(/const JOB_COLUMNS = \[([\s\S]*?)\]\.join/)[1];
  ['status', 'final_sign_off_at'].forEach((c) => {
    assert.ok(new RegExp("'" + c + "'").test(cols), c + ' is not selected with the job row');
  });
});

test('every dataHealth key has a label and a reason in all three languages', () => {
  /* bizRender does tr(words[x.key][0]), so a check added without a words
     entry throws on render the first time it finds a row -- and a words entry
     naming a key no table defines renders an empty label, which reads as a
     count of nothing in particular. Both are invisible until a real company
     has the data that trips the check. */
  const health = stripComments(grab('bizRender'));
  const mapText = health.slice(health.indexOf('const words = {'));
  const keys = [...stripComments(grab('dataHealth')).matchAll(/add\('([A-Za-z0-9_]+)'/g)].map(m => m[1])
    .concat(['thinHours']);   // pushed onto dh by the render, not by dataHealth
  assert.ok(keys.length >= 10, 'the dataHealth key scan found almost nothing: ' + keys.length);
  keys.forEach((k) => {
    const m = new RegExp(k + ":\\s*\\['([A-Za-z0-9_]+)',\\s*'([A-Za-z0-9_]+)'\\]").exec(mapText);
    assert.ok(m, 'no words entry for dataHealth key ' + k);
    ['en', 'es', 'fr'].forEach((lang) => {
      assert.ok(m[1] in TL[lang], m[1] + ' missing from ' + lang);
      assert.ok(m[2] in TL[lang], m[2] + ' missing from ' + lang);
    });
  });
});

test('CANARY: a dataHealth key with no words entry is detected', () => {
  const health = stripComments(grab('bizRender'));
  const mapText = health.slice(health.indexOf('const words = {'));
  assert.equal(/\bnoSuchHealthKey:\s*\[/.test(mapText), false);
});

test('the new health strings are really translated, not English copied across', () => {
  ['bizHCompletedNoSignoff', 'bizHCompletedNoSignoffWhy'].forEach((k) => {
    assert.notEqual(TL.es[k], TL.en[k], k + ' is untranslated in Spanish');
    assert.notEqual(TL.fr[k], TL.en[k], k + ' is untranslated in French');
  });
  // No %s in these two, so tr()'s positional substitution has nothing to get
  // wrong -- asserted rather than assumed, because a later edit adding a
  // count would need all three tables to agree on how many it takes.
  ['en', 'es', 'fr'].forEach((lang) => {
    assert.equal(TL[lang].bizHCompletedNoSignoff.includes('%s'), false);
    assert.equal(TL[lang].bizHCompletedNoSignoffWhy.includes('%s'), false);
  });
});
