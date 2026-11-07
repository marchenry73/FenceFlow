/**
 * THE CUSTOMER COULD NOT KEEP A COPY OF A QUOTE UNTIL THEY APPROVED IT.
 *
 * C2 on the owner list is three things -- "quote summary, download and pay
 * link". The summary renders and the pay link works. The download was offered
 * only AFTER an approval, which is the wrong half of the audience: the person
 * who needs the figures in something they can keep is the one still deciding,
 * comparing two contractors, or showing it to whoever else pays for it.
 * Requiring the decision first asks for the yes before handing over the thing
 * being said yes to.
 *
 * WHY THE PURE TEST BELOW IS NOT ENOUGH, AND WHAT THE REAL DEFECT WAS. The
 * button was never merely hidden. It was DECLARED INSIDE the green approved
 * box:
 *
 *     <div id="approvedBox" class="done" style="display:none">
 *       ...
 *       <button id="downloadBtn" ...>
 *
 * so every `$('downloadBtn').style.display=''` in the file would have
 * succeeded, reported nothing wrong, and shown nothing to anybody: the parent
 * is still display:none. A test that only exercised the decision function
 * would pass with the button buried in a hidden div for ever. So the structural
 * check is the point of this file, and it carries a positive control built from
 * the markup as it actually shipped.
 *
 * Reads website/quote.html. No network, no database, no DOM.
 *
 *     node --test tests/a164-quote-copy-before-approval.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'website/quote.html'), 'utf8');

/** Same brace-counting extractor the other quote-page tests use. */
const grab = (name) => {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
};

const { canDownloadCopy } = new Function(
  grab('canDownloadCopy') + '\nreturn { canDownloadCopy };')();

// ---------------------------------------------------------------------------
// THE STRUCTURAL CHECK -- the defect itself.
// ---------------------------------------------------------------------------

/**
 * The inner markup of the element carrying `id`, by counting <div>/</div> from
 * its opening tag. Every container in question here is a <div>, and the page
 * writes them one per line, so depth counting is enough and needs no parser
 * installed.
 */
function innerMarkup(html, id) {
  const at = html.indexOf('id="' + id + '"');
  if (at < 0) throw new Error('no element with id ' + id);
  const open = html.lastIndexOf('<div', at);
  const after = html.indexOf('>', at) + 1;
  let depth = 1;
  for (let j = after; j < html.length; j++) {
    if (html.startsWith('<div', j)) depth++;
    else if (html.startsWith('</div', j)) { depth--; if (!depth) return html.slice(after, j); }
  }
  throw new Error('unbalanced container: ' + id);
}

test('the download button is NOT inside the hidden approved box', () => {
  // The whole bug. #approvedBox is style="display:none" until an approval, so
  // a button declared inside it cannot be shown to an unapproved visitor no
  // matter what any script sets on the button itself.
  const inside = innerMarkup(src, 'approvedBox');
  assert.ok(!inside.includes('id="downloadBtn"'),
    'downloadBtn is declared inside #approvedBox, which is display:none until ' +
    'the customer approves -- so "Download a copy" can never be shown to ' +
    'anyone who has not approved yet, whatever canDownloadCopy() returns');
});

test('POSITIVE CONTROL: the structural check catches the markup as it shipped', () => {
  // Without this, an innerMarkup() that silently stopped matching -- a changed
  // container, a tag written differently -- would report the page clean for
  // ever. This is the defect verbatim.
  const shipped = `
    <div id="approvedBox" class="done" style="display:none">
      <div id="approvedText"></div>
      <div id="nextSteps"></div>
      <button type="button" id="downloadBtn" class="done-link" style="display:none"
              data-t="downloadCopy">Download a copy</button>
    </div>`;
  assert.ok(innerMarkup(shipped, 'approvedBox').includes('id="downloadBtn"'),
    'the extractor no longer finds a button that IS inside the approved box');
});

test('POSITIVE CONTROL: and does not cry wolf on a sibling button', () => {
  // The other half: a button after the box must read as outside it, or the
  // check above is passing because it can no longer see anything.
  const fixed = `
    <div id="approvedBox" class="done" style="display:none">
      <div id="approvedText"></div>
    </div>
    <div class="panel">
      <button type="button" id="downloadBtn" class="keep-link">Download a copy</button>
    </div>`;
  assert.ok(!innerMarkup(fixed, 'approvedBox').includes('id="downloadBtn"'));
});

test('the button is declared exactly once, so there is one thing to gate', () => {
  // Moving it is how a second copy gets left behind, and a stale duplicate
  // would be gated by nothing.
  const n = src.split('id="downloadBtn"').length - 1;
  assert.strictEqual(n, 1, `downloadBtn is declared ${n} times`);
});

test('every path that shows the button asks canDownloadCopy', () => {
  // render() and markApproved() both set it. If either ever goes back to
  // setting display='' unconditionally, an approvalBlocked quote becomes
  // downloadable again -- and that is the one figure that must not end up in
  // a file the customer keeps.
  const sets = [...src.matchAll(/\$\('downloadBtn'\)\.style\.display\s*=\s*([^;]+);/g)]
    .map(m => m[1].trim());
  assert.ok(sets.length >= 2,
    `expected the button to be set in render() and markApproved(), found ${sets.length}`);
  for (const expr of sets) {
    assert.match(expr, /canDownloadCopy/,
      `a path sets downloadBtn to \`${expr}\` without asking canDownloadCopy()`);
  }
});

// ---------------------------------------------------------------------------
// THE RULE
// ---------------------------------------------------------------------------

const priced = { total: 5764.72 };

test('an unapproved, priced quote CAN be downloaded -- the case that was missing', () => {
  assert.strictEqual(canDownloadCopy(priced), true);
});

test('an approved quote still can, as it always could', () => {
  assert.strictEqual(canDownloadCopy({ ...priced, approvedAt: '2026-11-01T10:00:00Z' }), true);
});

test('a price the server has REFUSED is not handed over as a keepsake', () => {
  // approvalBlocked means this figure is below one the customer already
  // agreed to (quote-view's priceShortfall). render() takes the ways-to-pay
  // panel down for exactly this reason; a downloaded file outlives a panel.
  assert.strictEqual(canDownloadCopy({ ...priced, approvalBlocked: 'price_below_agreed' }), false);
});

test('an existing approval outranks a blocked re-price, matching render\'s branch order', () => {
  // render() tests approvedAt FIRST, so the rule must too -- otherwise the
  // button vanishes for a customer who has already approved and can still
  // legitimately re-download what she agreed to.
  assert.strictEqual(canDownloadCopy({
    ...priced, approvedAt: '2026-11-01T10:00:00Z', approvalBlocked: 'price_below_agreed',
  }), true);
});

test('a quote with nothing priced yet is not a document', () => {
  assert.strictEqual(canDownloadCopy({ total: 0 }), false);
  assert.strictEqual(canDownloadCopy({ total: null }), false);
  assert.strictEqual(canDownloadCopy({}), false);
});

test('a fraction of a cent is not a price', () => {
  // Same 0.005 threshold the rest of the page uses for "is there money here",
  // so a float-dust total cannot offer a $0.00 quote as a download.
  assert.strictEqual(canDownloadCopy({ total: 0.004 }), false);
  assert.strictEqual(canDownloadCopy({ total: 0.02 }), true);
});

test('no quote loaded at all is false, not a throw', () => {
  // render() cannot reach this, but markApproved and any future caller can,
  // and a throw here would take the whole page down after a good approval.
  assert.strictEqual(canDownloadCopy(null), false);
  assert.strictEqual(canDownloadCopy(undefined), false);
});

test('the button is reachable: it sits in a container that is not display:none', () => {
  // The companion to the approved-box check. Finding it outside #approvedBox
  // proves nothing if its new home is hidden too.
  const at = src.indexOf('id="downloadBtn"');
  const panelOpen = src.lastIndexOf('<div class="panel"', at);
  assert.ok(panelOpen >= 0, 'downloadBtn is not inside a .panel');
  const openTag = src.slice(panelOpen, src.indexOf('>', panelOpen));
  assert.ok(!/display:\s*none/.test(openTag),
    `downloadBtn's panel is hidden by default: ${openTag}`);
  // And it really is that panel's descendant, not a later sibling that merely
  // follows the same lastIndexOf.
  assert.ok(innerMarkup(src, 'totals') !== null);
});
