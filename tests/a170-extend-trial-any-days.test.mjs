/**
 * THE EXTEND-TRIAL BUTTON SAID "+14 days" WHILE THE HANDLER ASKED FOR A NUMBER.
 *
 * The owner asked to extend a trial "by however many days I want, not just one
 * or 14". MEASURED 7 Nov 2026: the admin portal already does exactly that --
 * it prompts for a number, validates 1 to 365, and dates the extension from
 * where the trial actually ends rather than from today. Its own comment says
 * so: "HOW LONG IS TYPED, NOT ASSUMED. Fourteen days was the only answer this
 * button had."
 *
 * What nobody updated was the BUTTON. It read "+14 days" in all three
 * languages, so the one thing the owner ever sees said the feature he was
 * asking for did not exist. Nothing was broken; the label was, and a label
 * that contradicts its own handler is indistinguishable from a missing
 * feature.
 *
 * This file pins both halves: no extend label may name a number again, and
 * the handler must keep accepting a typed range rather than a fixed figure.
 *
 *     node --test tests/a170-extend-trial-any-days.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'website/admin.html'), 'utf8');

/**
 * Every translation of the extend button's label.
 *
 * The character class has to allow an ESCAPED quote. The first version used
 * /'([^']*(?:\\'[^']*)*)'/, where [^']* swallows the backslash and then stops
 * at the quote it was escaping -- so the French label came back truncated to
 * "Prolonger l\" and the escape check failed on a correctly escaped file.
 * "either a plain character, or a backslash and whatever follows it" is the
 * form that survives an escape.
 */
const labels = () =>
  [...src.matchAll(/extendBtn:'((?:[^'\\]|\\.)*)'/g)].map(m => m[1]);

test('CANARY: the label exists in all three languages', () => {
  // Without this, a renamed key makes every assertion below pass on an empty
  // list -- the shape that has cost this project the most.
  const l = labels();
  assert.strictEqual(l.length, 3, `expected en, es and fr; found ${l.length}`);
  assert.strictEqual(new Set(l).size, 3, 'two languages carry the same string');
});

test('no extend label names a number of days', () => {
  // The defect. A button that promises 14 days, on a handler that asks how
  // many, reads as "this only does 14".
  for (const l of labels()) {
    assert.doesNotMatch(l, /\d/,
      `the extend button says "${l}" -- it names a fixed number again, while ` +
      'the handler it opens asks for any number from 1 to 365');
  }
});

test('the French label escapes its apostrophe', () => {
  // Not hypothetical: an unescaped apostrophe inside a single-quoted JS string
  // ends the string early and takes the whole page down. That is how this
  // project lost the office for a day and a half, and I reintroduced it in
  // dashboard.html earlier today.
  const fr = labels().find(l => /Prolonger|essai/.test(l));
  assert.ok(fr, 'the French extend label is gone');
  assert.match(fr, /\\'/, `the French label has a bare apostrophe: ${fr}`);
});

test('the handler still takes a typed number, not a constant', () => {
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /fields: \[\{ id: 'ex_days'/,
    'the extend button no longer asks how many days');
  assert.match(code, /days < 1 \|\| days > 365/,
    'the 1-365 range check is gone, so an empty or absurd value reaches admin_extend_trial');
});

test('the extension is dated from where the trial ends, not from today', () => {
  // Extending a trial that still has a week left must add to that week, or
  // every extension quietly shortens the trial it was meant to lengthen.
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.match(code,
    /c\.trial_ends_at && new Date\(c\.trial_ends_at\) > new Date\(\)\s*\n?\s*\? new Date\(c\.trial_ends_at\) : new Date\(\)/,
    'the extension no longer starts from the existing trial end, so extending ' +
    'a live trial would throw away the days still left on it');
});

test('the company is named before any number is typed', () => {
  // These rows look alike and several share a contact address; the one thing
  // worth being certain of is which business this is about.
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /body: tr\('extendAskBody', c\.name \|\| named\(id\)\)/,
    'the extend prompt no longer names the company it is about');
});
