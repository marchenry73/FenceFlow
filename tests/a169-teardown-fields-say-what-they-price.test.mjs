/**
 * THE FIVE TEARDOWN CONTROLS NOW SAY WHAT THEY CHARGE (owner list D5).
 *
 * D5 asked for the teardown section to be removed from the job page now that
 * it lives on the grid. That was verified as DO NOT BUILD AS ASKED: these five
 * controls are the only place the teardown charge can be switched on or
 * priced, and the engine forces the cost to zero when the switch is off, so
 * removing them makes the charge permanently uncollectable -- D3's complaint
 * one screen over. The agreed replacement is to keep every field and show what
 * each one does to the price.
 *
 * THE THING WORTH SAYING OUT LOUD, straight from the engine:
 *
 *     teardownFt = teardownFeet > 0 ? teardownFeet
 *                : drawnTeardownFt > 0 ? drawnTeardownFt
 *                : billableFeet            <-- the NEW fence's full length
 *     teardownCost = enabled ? flat + ratePerFt * teardownFt + haul : 0
 *
 * Leaving "Teardown feet" at 0 with no old fence drawn charges the per-foot
 * rate along the WHOLE NEW FENCE. Nothing on the panel hinted at it, and it is
 * the one control here that can quietly multiply a bill.
 *
 * WHY THE NOTE SOMETIMES REFUSES TO SHOW A TOTAL, and why that is the correct
 * behaviour rather than a gap: the fallback length is not knowable on that
 * panel. `jobs` carries no live linear-feet column -- only
 * signed_linear_feet, which is frozen at signing -- and the wizard loads no
 * runs. So it prints an exact figure when the feet are typed and names the
 * length that will be used when they are not. A figure the panel cannot stand
 * behind would be worse than the silence it replaced.
 *
 *     node --test tests/a169-teardown-fields-say-what-they-price.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'website/dashboard.html'), 'utf8');

/** Same brace-counting extractor the other dashboard tests use. */
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

const { teardownPricing, teardownNote } = new Function(
  grab('teardownPricing') + '\n' + grab('teardownNote') +
  '\nreturn { teardownPricing, teardownNote };')();

const vals = (o = {}) => ({ enabled: true, feet: 0, flat: 0, ratePerFt: 0, haul: 0, ...o });

// ---------------------------------------------------------------------------
// THE ARITHMETIC -- the same expression the engine uses
// ---------------------------------------------------------------------------

test('the switch off charges nothing, whatever the other four say', () => {
  // The engine does exactly this (teardownCost = enabled ? ... : 0.0), and it
  // is the whole reason the controls cannot simply be deleted.
  const p = teardownPricing(vals({ enabled: false, feet: 500, flat: 900, ratePerFt: 12, haul: 400 }));
  assert.strictEqual(p.total, 0, 'the teardown switch no longer zeroes the charge');
});

test('typed feet price exactly: flat + rate x feet + haul', () => {
  const p = teardownPricing(vals({ feet: 120, flat: 250, ratePerFt: 4.5, haul: 300 }));
  assert.strictEqual(p.known, true);
  assert.strictEqual(p.total, 250 + 4.5 * 120 + 300); // 1090
  assert.strictEqual(p.fixed, 550, 'flat and haul are the length-independent part');
});

test('a rate with no typed feet refuses to invent a total', () => {
  // The office cannot see the drawn old fence or the new fence's length, so
  // the honest answer is "I cannot price this here", not a number.
  const p = teardownPricing(vals({ feet: 0, ratePerFt: 6, flat: 100, haul: 50 }));
  assert.strictEqual(p.known, false);
  assert.strictEqual(p.total, null,
    'the panel is guessing a total from a length it cannot see');
  assert.strictEqual(p.fixed, 150, 'the part it CAN price is still offered');
});

test('no per-foot rate means the unknown length cannot matter', () => {
  // flat + haul only: the fallback length multiplies nothing, so this case is
  // fully priceable even with feet at 0.
  const p = teardownPricing(vals({ feet: 0, ratePerFt: 0, flat: 400, haul: 125 }));
  assert.strictEqual(p.fixed, 525);
  assert.strictEqual(p.rate, 0);
});

test('junk in the boxes is read as zero, not NaN', () => {
  // These are free-typed number inputs; '' and '-' arrive mid-keystroke.
  for (const bad of ['', '-', 'abc', null, undefined]) {
    const p = teardownPricing(vals({ feet: 100, ratePerFt: 2, flat: bad, haul: bad }));
    assert.ok(Number.isFinite(p.total), `flat/haul of ${JSON.stringify(bad)} produced ${p.total}`);
    assert.strictEqual(p.total, 200);
  }
});

// ---------------------------------------------------------------------------
// WHAT IT SAYS
// ---------------------------------------------------------------------------

test('the sentence warns that 0 feet prices along the whole new fence', () => {
  // The defect this whole item is about. If this wording ever stops saying
  // it, the panel is back to hiding the one thing that can multiply a bill.
  const note = teardownNote(vals({ feet: 0, ratePerFt: 6, flat: 100 }));
  assert.match(note, /WHOLE NEW FENCE/,
    'the note no longer warns that an untyped length is charged along the new fence');
  assert.match(note, /drew/, 'the note no longer mentions the drawn old fence');
});

test('and does not cry wolf when there is no per-foot rate', () => {
  // With rate 0 the fallback is harmless, and a warning there would be noise
  // -- and a noisy note is one people stop reading.
  const note = teardownNote(vals({ feet: 0, ratePerFt: 0, flat: 400, haul: 125 }));
  assert.doesNotMatch(note, /WHOLE NEW FENCE/);
  assert.match(note, /\$525\.00/, 'the fully-priceable case does not show its figure');
});

test('the priced case shows the figure the engine will charge', () => {
  const note = teardownNote(vals({ feet: 120, flat: 250, ratePerFt: 4.5, haul: 300 }));
  assert.match(note, /\$1,090\.00/, `the note does not carry the computed total: ${note}`);
});

test('the switched-off case says so instead of showing $0.00 as a price', () => {
  const note = teardownNote(vals({ enabled: false, feet: 120, ratePerFt: 9 }));
  assert.match(note, /off/i);
  assert.doesNotMatch(note, /WHOLE NEW FENCE/);
});

// ---------------------------------------------------------------------------
// IT CANNOT DRIFT FROM THE ENGINE, OR FROM THE PANEL
// ---------------------------------------------------------------------------

test('the engine still prices teardown the way this note says it does', () => {
  // The note is a SECOND statement of a money rule, which is how two copies
  // drift. This reads the engine and fails when its expression changes, so
  // the note is corrected rather than quietly becoming a lie.
  const totals = readFileSync(
    path.join(ROOT, 'supabase/functions/_shared/pricing/totals.ts'), 'utf8');
  assert.match(totals,
    /teardownCost = job\.teardownEnabled[\s\S]{0,120}teardownFlatFee \+ job\.teardownRatePerFt \* teardownFt \+ trashHaul/,
    'totals.ts no longer prices teardown as flat + rate x feet + haul; the ' +
    'office note now describes a rule the engine does not follow');
  assert.match(totals,
    /job\.teardownFeet > 0\.0 \? job\.teardownFeet[\s\S]{0,160}: billableFeet/,
    'the engine no longer falls back to the new fence\'s length, so the note\'s ' +
    'warning about the WHOLE NEW FENCE may now be wrong');
});

test('the panel actually mounts the note', () => {
  // teardownNote() being correct is worth nothing if step 4 never calls it.
  // Step 4 had NO wiring function at all before this change.
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /case 4: body\.innerHTML = wizStepPricingHtml\(\); wizWirePricing\(\);/,
    'step 4 renders the pricing panel without wiring the teardown note');
  assert.match(code, /id="wz_teardown_note"/, 'the note element is gone from the panel');
  assert.match(code, /const paint = \(\) => \{ note\.textContent = teardownNote\(read\(\)\); \};/,
    'the note is no longer painted from teardownNote()');
});

test('every one of the five controls repaints the note', () => {
  // Miss one and that field silently changes the price with the sentence
  // underneath still describing the old one.
  //
  // SCOPED TO THE LIST, not the file. The first version searched the whole
  // page for 'wz_trash_haul', which also appears where that field is SAVED
  // ($('wz_trash_haul').value) -- so a canary that removed it from the
  // repaint list passed anyway. Read the array out of wizWirePricing itself.
  const wire = grab('wizWirePricing');
  const m = wire.match(/\[([^\]]*)\]\s*\n?\s*\.forEach/);
  assert.ok(m, 'could not find the list of controls wizWirePricing repaints from');
  for (const id of ['wz_teardown_on', 'wz_teardown_feet', 'wz_teardown_flat',
                    'wz_teardown_ft', 'wz_trash_haul']) {
    assert.ok(m[1].includes(`'${id}'`),
      `${id} is not in the list of controls that repaint the note, so changing ` +
      'it leaves the sentence underneath describing the old price');
  }
});

test('CANARY: the extractor really pulled the functions out', () => {
  // Without this, a renamed or missing function would throw at import and
  // every assertion above would never run -- or, worse, a stub would pass.
  assert.strictEqual(typeof teardownPricing, 'function');
  assert.strictEqual(typeof teardownNote, 'function');
  assert.ok(grab('teardownPricing').length > 200, 'teardownPricing extracted as a stub');
});
