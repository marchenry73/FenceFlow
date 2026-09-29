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
// esc() is a one-liner whose own body contains both a `;` inside a string
// (the HTML entities -- '&amp;' ends in a real semicolon) and a `"` used as
// a regex pattern character rather than a quote delimiter (/"/g). Both would
// defeat a naive scan for the declaration's own terminating `;` (it would
// stop at the entity's semicolon, or hang mid-regex treating `"` as a quote),
// so esc is pulled out by line instead -- its definition never wraps a line.
const grabConstLine = (name) => {
  const start = src.indexOf('const ' + name + '=');
  if (start < 0) throw new Error('not found: ' + name);
  const end = src.indexOf('\n', start);
  return src.slice(start, end < 0 ? src.length : end);
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

/* buildQuoteDocument: the "download a copy" file (item C3b). It takes the
   page's already-rendered scope/totals HTML verbatim and only ever escapes
   the plain-text fields it assembles itself, so these tests plant an
   XSS-shaped customer name/address to prove the escape actually runs, and
   plant literal HTML in scopeHtml/totalsHtml to prove those are trusted
   through unmodified (double-escaping them would mangle the money symbols
   and the already-escaped run labels render() already produced). */
const { buildQuoteDocument, esc } = new Function(
  grab('buildQuoteDocument') + '\n' + grabConstLine('esc')
  + '\nreturn { buildQuoteDocument, esc };'
)();

const sampleDoc = () => buildQuoteDocument({
  lang: 'en',
  title: 'Fence quote for Pat <script>',
  companyName: 'Acme Fence & Co',
  companyContact: '(555) 123-4567 · office@acme.test',
  customerHeading: 'Quote for Pat <script>',
  customerName: 'Pat "Buyer" <script>alert(1)</script>',
  address: '123 Main St & 5th',
  scopeHeading: 'Scope of work',
  scopeHtml: '<div><strong>Vinyl fence</strong> — 120 ft</div>',
  totalsHeading: 'Pricing',
  totalsHtml: '<div class="grand"><span>Total</span><span>$12,340.00</span></div>',
  approvalText: 'Approved by Pat "Buyer" on 9/28/2026. Acme Fence & Co has been told — thank you!',
});

test('buildQuoteDocument: escapes every plain-text field it assembles', () => {
  const doc = sampleDoc();
  assert.ok(!doc.includes('<script>alert(1)</script>'),
    'a literal <script> from the customer name must not reach the output unescaped');
  assert.ok(doc.includes(esc('Pat "Buyer" <script>alert(1)</script>')));
  assert.ok(doc.includes(esc('123 Main St & 5th')));
  assert.ok(doc.includes(esc('Fence quote for Pat <script>')));
});

test('buildQuoteDocument: scopeHtml and totalsHtml pass through verbatim, not re-escaped', () => {
  const doc = sampleDoc();
  // Already-escaped/trusted markup built by render() -- re-escaping it here
  // would turn the money sign's HTML into visible entities on the page.
  assert.ok(doc.includes('<div><strong>Vinyl fence</strong> — 120 ft</div>'));
  assert.ok(doc.includes('<div class="grand"><span>Total</span><span>$12,340.00</span></div>'));
});

test('buildQuoteDocument: is a complete standalone document', () => {
  const doc = sampleDoc();
  assert.match(doc, /^<!doctype html>/i);
  assert.match(doc, /<html lang="en">/);
  assert.match(doc, /<\/html>$/);
});

/* The download carries none of the live page's <link rel="stylesheet"> --
   nothing external loads for a file the customer may open months later with
   no network. So the totals rows' own layout (a flex row, label left/figure
   right) and the grand total's emphasis have to travel WITH the document, in
   its own <head>. Checking that the markup for "Total" and "$13,410.00" is
   merely present (the five tests that shipped this bug all did exactly that)
   proves nothing about whether they land on one line or two: a <div> with no
   layout rule for it collapses to "Total$13,410.00" and still contains both
   strings. These tests instead read the actual CSS rule bodies out of the
   document and assert on the declarations that do the job, the same way the
   defect report described the live page's fix: ".totals div" a flex row with
   justify-content:space-between, so the label and the figure are pushed to
   opposite ends instead of running together. */
function styleBlockCss(doc) {
  const m = doc.match(/<head>[\s\S]*?<style>([\s\S]*?)<\/style>[\s\S]*?<\/head>/);
  return m ? m[1] : null;
}
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css && css.match(new RegExp(escaped + '\\{([^}]*)\\}'));
  return m ? m[1] : null;
}

test('buildQuoteDocument: <head> carries a <style> block, so the file needs no network to render correctly', () => {
  const doc = sampleDoc();
  assert.ok(styleBlockCss(doc), 'no <style> block in <head> -- the totals rows have nothing to lay them out with');
});

test('buildQuoteDocument: a totals row is a flex row with the label and figure pushed apart', () => {
  const css = styleBlockCss(sampleDoc());
  const rowRule = ruleBody(css, '.totals div');
  assert.ok(rowRule, '.totals div has no rule of its own -- every row (deposit, balance, grand total) falls back to block layout and the label runs straight into the figure');
  assert.match(rowRule, /display:\s*flex/,
    'without display:flex a totals row is a block, and "Deposit to begin" and "$4,000.00" stack as plain text with nothing between them');
  assert.match(rowRule, /justify-content:\s*space-between/,
    'without justify-content:space-between the label and the figure sit side by side with no gap -- "Total$13,410.00"');
});

test('buildQuoteDocument: the grand total is set as the big emphasised figure, not plain body text', () => {
  const css = styleBlockCss(sampleDoc());
  const grandRule = ruleBody(css, '.totals .grand');
  assert.ok(grandRule, '.totals .grand has no rule of its own -- the grand total renders at the same size and weight as every other line');
  assert.match(grandRule, /font:\s*700\s*40px/,
    'the grand total must come out bold and at the large display size the customer approved, not indistinguishable body text');
});

test('buildQuoteDocument: the scope breakdown\'s figures still line up on the right', () => {
  const css = styleBlockCss(sampleDoc());
  const numRule = ruleBody(css, '.num');
  assert.ok(numRule, '.num has no rule of its own -- the per-run foot counts lose their right alignment');
  assert.match(numRule, /text-align:\s*right/);
});

test('buildQuoteDocument: the totals wrapper actually carries the class those rules key off of', () => {
  const doc = sampleDoc();
  // A <style> block with the right rules is not enough on its own -- .totals
  // div only matches an element that is a div AND a descendant of something
  // carrying class="totals". If the wrapper around totalsHtml is ever a bare
  // <div> again, every rule above stays present in the document and still
  // matches nothing, and the earlier CSS-content assertions would pass while
  // the actual customer-visible layout stayed broken. This is the check that
  // would have caught that.
  assert.match(doc, /<div class="totals">\s*<div class="grand">/,
    'the totals rows are not wrapped in class="totals" -- the CSS rules above never apply to them');
});

test('buildQuoteDocument: everything the page showed is present -- company, customer, scope, totals, approval', () => {
  const doc = sampleDoc();
  assert.ok(doc.includes(esc('Acme Fence & Co')));
  assert.ok(doc.includes(esc('(555) 123-4567 · office@acme.test')));
  assert.ok(doc.includes(esc('Scope of work')));
  assert.ok(doc.includes(esc('Pricing')));
  assert.ok(doc.includes(esc('Approved by Pat "Buyer" on 9/28/2026. Acme Fence & Co has been told — thank you!')));
});

test('buildQuoteDocument: no approval yet -- omits the approval block rather than an empty one', () => {
  const doc = buildQuoteDocument({ ...sampleDocArgs(), approvalText: '' });
  assert.ok(!doc.includes('background:#F1F9F6'), 'the approved-strip styling must not render for an unapproved quote');
});

function sampleDocArgs() {
  return {
    lang: 'en', title: 't', companyName: 'c', companyContact: '', customerHeading: 'q',
    customerName: 'n', address: '', scopeHeading: 's', scopeHtml: '<div></div>',
    totalsHeading: 'p', totalsHtml: '<div></div>', approvalText: '',
  };
}
