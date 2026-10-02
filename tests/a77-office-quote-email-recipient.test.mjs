/* The office must not email a quote to an address it never saves.

   WHY THIS FILE EXISTS. jobQuoteMailCompose() takes the recipient from the
   LIVE, UNSAVED j_email input. On a confirmed send, markQuoteSentAfterEmail()
   wrote quote_sent_at and status -- and never jobs.email. So a typo'd address
   fixed in the field and sent would leave the OLD address on the row, with the
   job marked sent. send-follow-ups/index.ts then mails `to: [j.email]`,
   selected on nothing but `email <> ''`, and the follow-up templates carry
   figures. The wrong person receives his customer's money details,
   automatically, with no further tap from him.

   Found and fixed 2026-10-02.

   WHAT THIS ASSERTS
     1. the three edits are structurally present in dashboard.html -- so the
        wiring cannot be half-removed and still pass;
     2. the comparison is a SET comparison, because parseAddressList lowercases,
        trims, de-duplicates and accepts , ; and newlines: "A@x.com, b@x.com"
        and "b@x.com;a@x.com" are the same recipients and must not be written
        back as if something changed;
     3. the rule itself, over the real parseAddressList lifted from
        website/js/lib/mail-render.mjs rather than reimplemented;
     4. a POSITIVE CONTROL that an unchanged recipient writes nothing;
     5. a CANARY that must fail against the code as it was.

   The DOM half is not covered -- this suite has no browser. It proves the rule
   and that the rule is wired in. Stated rather than glossed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAddressList } from '../website/js/lib/mail-render.mjs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const dash = read('website/dashboard.html');

test('positive control: the real file, and the real helper', () => {
  assert.ok(dash.length > 500000, 'dashboard.html looks truncated: ' + dash.length);
  assert.equal(typeof parseAddressList, 'function', 'parseAddressList did not import');
  // The helper must behave as the fix assumes, or every assertion below is moot.
  assert.deepEqual(parseAddressList('A@x.invalid, b@x.invalid').ok, ['a@x.invalid', 'b@x.invalid']);
  assert.deepEqual(parseAddressList('b@x.invalid;a@x.invalid').ok, ['b@x.invalid', 'a@x.invalid']);
  assert.deepEqual(parseAddressList('a@x.invalid, a@x.invalid').ok, ['a@x.invalid']);
});

/* ---- 1. the wiring is all three parts ----------------------------------- */
test('the compose remembers what it actually sent to', () => {
  assert.match(
    dash, /c\.sentTo = to\.ok\.slice\(\);/,
    'sendCompose no longer records the recipients it sent to, so the stamp cannot ' +
    'reconcile jobs.email with them.'
  );
  // It must be set AFTER validation, or a refused attempt leaves a stale list.
  const iNeed = dash.indexOf("tr('mailNeedRecipient')");
  const iSet = dash.indexOf('c.sentTo = to.ok.slice();');
  assert.ok(iNeed > 0 && iSet > iNeed,
    'c.sentTo must be set after the recipient validation, not before it');
});

test('the stamp receives them', () => {
  assert.match(
    dash, /markQuoteSentAfterEmail\(c\.quoteSendFor, c\.sentTo\)/,
    'composeSent no longer passes the recipients through, so the stamp has nothing to save'
  );
  assert.match(
    dash, /async function markQuoteSentAfterEmail\(syncId, sentTo\)\{/,
    'markQuoteSentAfterEmail no longer takes the recipients'
  );
});

test('the stamp writes jobs.email, and only on a real difference', () => {
  const i = dash.indexOf('async function markQuoteSentAfterEmail(');
  const fn = dash.slice(i, dash.indexOf('\n}', i));
  assert.match(fn, /patch\.email = sentTo\.join\(', '\)/,
    'the address the quote went to is not written to jobs.email');
  assert.match(fn, /parseAddressList\(\(j && j\.email\) \|\| ''\)\.ok/,
    'the stored address must be parsed the same way the input was, or a list ' +
    'written with semicolons reads as a change on every send');
  assert.match(fn, /stored\.length === sentTo\.length/,
    'the comparison must be a SET comparison; comparing the raw strings rewrites ' +
    'the column every time the order or casing differs');
  assert.match(fn, /stored\.every\(a => sentTo\.includes\(a\)\)/);
  assert.match(fn, /if \(!same\) patch\.email/,
    'it must write only when the recipients genuinely differ');
  // Guarded, so a non-quote send (sentTo undefined) cannot blank the column.
  assert.match(fn, /Array\.isArray\(sentTo\) && sentTo\.length/,
    'without this guard a caller passing nothing would compare against an empty ' +
    'list and overwrite a good address');
});

/* ---- 3. the rule, over the real helper ---------------------------------- */
/* Transcribed from the patched block. The structural test above is what keeps
   this honest: if the production clauses change, that test goes red first. */
const wouldWriteEmail = (storedRaw, sentTo) => {
  if (!Array.isArray(sentTo) || !sentTo.length) return null;
  const stored = parseAddressList(storedRaw || '').ok;
  const same = stored.length === sentTo.length && stored.every(a => sentTo.includes(a));
  return same ? null : sentTo.join(', ');
};

test('a corrected typo is written back', () => {
  // The real case: the row has the typo, he fixed it in the field and sent.
  assert.equal(
    wouldWriteEmail('jane@exmaple.invalid', ['jane@example.invalid']),
    'jane@example.invalid'
  );
});

test('a blank row gets the address the quote went to', () => {
  assert.equal(wouldWriteEmail('', ['jane@example.invalid']), 'jane@example.invalid');
  assert.equal(wouldWriteEmail(null, ['jane@example.invalid']), 'jane@example.invalid');
});

test('a list he keeps on purpose is preserved, not collapsed', () => {
  assert.equal(
    wouldWriteEmail('jane@example.invalid', ['jane@example.invalid', 'husband@example.invalid']),
    'jane@example.invalid, husband@example.invalid'
  );
});

test('POSITIVE CONTROL: an unchanged recipient writes NOTHING', () => {
  // Without this, a fix that wrote the column on every send would pass
  // everything above while bumping the row's clock on each email -- and a
  // bookkeeping write that moves updated_at is how an offline edit gets lost.
  assert.equal(wouldWriteEmail('jane@example.invalid', ['jane@example.invalid']), null);
  assert.equal(wouldWriteEmail('JANE@example.invalid', ['jane@example.invalid']), null,
    'casing alone must not count as a change');
  assert.equal(wouldWriteEmail('  jane@example.invalid  ', ['jane@example.invalid']), null,
    'whitespace alone must not count as a change');
  assert.equal(
    wouldWriteEmail('a@x.invalid; b@x.invalid', ['b@x.invalid', 'a@x.invalid']), null,
    'the same two people in a different order and separator must not count as a change'
  );
  assert.equal(
    wouldWriteEmail('a@x.invalid, a@x.invalid', ['a@x.invalid']), null,
    'a duplicate in the stored field must not count as a change'
  );
});

test('a non-quote send cannot blank the column', () => {
  assert.equal(wouldWriteEmail('jane@example.invalid', undefined), null);
  assert.equal(wouldWriteEmail('jane@example.invalid', []), null);
});

/* ---- 5. the canary ------------------------------------------------------- */
test('CANARY: these checks fail against the code as it was', () => {
  const asItWas = dash
    .replace('markQuoteSentAfterEmail(c.quoteSendFor, c.sentTo)', 'markQuoteSentAfterEmail(c.quoteSendFor)')
    .replace('async function markQuoteSentAfterEmail(syncId, sentTo){', 'async function markQuoteSentAfterEmail(syncId){');
  assert.notEqual(asItWas, dash, 'could not reproduce the old code -- this canary tests nothing');
  assert.ok(
    !/markQuoteSentAfterEmail\(c\.quoteSendFor, c\.sentTo\)/.test(asItWas) &&
    !/async function markQuoteSentAfterEmail\(syncId, sentTo\)\{/.test(asItWas),
    'the structural tests would NOT have noticed the wiring missing, so they guard nothing'
  );
});

console.log('a77: the office saves the address it actually emailed the quote to');
