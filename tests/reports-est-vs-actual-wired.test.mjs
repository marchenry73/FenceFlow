/* The estimate-vs-actual aggregates are RENDERED, and the empty case is
   honest.

   Why this file exists: labourEstVsActualTotals() and
   materialEstVsActualTotals() were rendered as tiles in the first business
   report (commit 55944cc, "business report added", #repBizLabour /
   #repBizMaterials). The rewrite five days later (commit 4ef5961, "richer
   report") deleted those containers and their call sites and left the two
   functions and their TL labels behind. Both kept passing
   tests/reports-math.test.mjs the whole time, because arithmetic tested on
   hand-built rows cannot tell whether anything on the page ever asks for it.
   So the maths tests stay where they are, and this one asks the second
   question: does a person ever see the answer.

   It is deliberately not a grep for the function names alone -- that is the
   check that would have passed on the broken page too, since the names were
   still there in the definitions. It asserts a CALL outside the definition,
   the label beside it, and then lifts the display rule and runs it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('website/dashboard.html', 'utf8');

const grab = (name) => {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
};

/* Every mention of `name(` in CODE, with the definition itself cut out: a
   function that is defined and never called scores zero here, however many
   times its own body mentions it.

   Comments are stripped first, and that is not tidiness. The canary for this
   file took the one real caller away and the check still passed, because the
   helper beside the aggregate names `labourEstVsActualTotals()` in its
   comment -- a prose mention with brackets on it. A check that a comment can
   satisfy is a check that has stopped checking. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const callsTo = (name) => {
  const withoutDef = code.split(grab(name).replace(/\/\*[\s\S]*?\*\//g, '')).join('');
  return (withoutDef.match(new RegExp('\\b' + name + '\\s*\\(', 'g')) || []).length;
};

for (const fn of ['labourEstVsActualTotals', 'materialEstVsActualTotals']) {
  test(`${fn}() is called by the page, not only defined and tested`, () => {
    const n = callsTo(fn);
    assert.ok(n > 0, `${fn} has no caller outside its own definition -- the figure it computes reaches nobody`);
  });
}

test('the two aggregates are called over the SAME rows, so the panel cannot show two scopes', () => {
  // One Map, one job list, both aggregates. If a later edit gives one of them
  // its own source, these stop being the figures for the same set of jobs and
  // the tiles beside each other start answering different questions.
  assert.match(src, /labourEstVsActualTotals\(scopeJobs, costingByJob\)/,
    'the labour aggregate no longer reads the panel rows');
  assert.match(src, /materialEstVsActualTotals\(scopeJobs, costingByJob\)/,
    'the material aggregate no longer reads the panel rows');
});

test('the materials tile reads the shared aggregate instead of re-summing the columns', () => {
  // The inline sum this replaced was a second copy of the same money formula.
  // quotedLaborOf's own comment is about exactly this: copies drift.
  assert.ok(!/money\(sum\('quoted_material'\)\)/.test(src),
    "the materials tile is summing quoted_material inline again, beside the shared aggregate that already does it");
});

test('every language carries the three strings the restored tile needs', () => {
  const start = src.indexOf('const TL = {');
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const TL = eval('(' + src.slice(src.indexOf('{', start), end) + ')');
  for (const lang of Object.keys(TL)) {
    for (const k of ['bizLabourCharged', 'bizLabourChargedHow', 'bizLabourNoEngine']) {
      assert.ok(TL[lang][k] && TL[lang][k].length > 3, `${lang}.${k} is missing`);
    }
  }
  // tr() substitutes %s positionally and understands nothing else. A %1$s
  // here would print the digits at the reader.
  for (const lang of Object.keys(TL)) {
    assert.equal((TL[lang].bizLabourNoEngine.match(/%s/g) || []).length, 2,
      `${lang}.bizLabourNoEngine must take exactly two %s (how many jobs, out of how many)`);
    assert.ok(!/%\d\$s/.test(TL[lang].bizLabourNoEngine), `${lang}.bizLabourNoEngine uses %1$s, which tr() does not understand`);
  }
  // The two labels the rewrite orphaned are gone, in every language, rather
  // than left behind to look alive.
  for (const lang of Object.keys(TL)) {
    assert.equal(TL[lang].reportsLabourEstVsActual, undefined,
      `${lang} still carries reportsLabourEstVsActual, which nothing renders`);
    assert.equal(TL[lang].reportsMaterialsEstVsActual, undefined,
      `${lang} still carries reportsMaterialsEstVsActual, which nothing renders`);
  }
});

// ---- the display rule, run rather than read -------------------------------
const lib = new Function(grab('estVsActualDisplay') + '\nreturn estVsActualDisplay;')();
const money = (n) => '$' + Number(n).toFixed(2);

test('estVsActualDisplay: with jobs priced, both sides are shown', () => {
  assert.equal(lib({ estimated: 2500, actual: 2730.5 }, 4, money), '$2500.00 / $2730.50');
});

test('estVsActualDisplay: NO priced job shows nothing, never a pair of zeroes', () => {
  // This is the whole point. labourEstVsActualTotals() skips every job the
  // server has never priced, so a freshly migrated database hands this
  // {0, 0} -- and "$0.00 / $0.00" on a labour tile says the crew worked for
  // free. The office must say it has no figure instead.
  const out = lib({ estimated: 0, actual: 0 }, 0, money);
  assert.equal(out, '—');
  assert.ok(!/0/.test(out), 'an unpriced period must not print a zero figure');
  assert.ok(!/\$/.test(out), 'an unpriced period must not print a money figure');
});

test('estVsActualDisplay: a real zero on a priced job is still a figure, not a dash', () => {
  // Priced at nothing is an answer. Never priced is not. The two must not
  // collapse into each other.
  assert.equal(lib({ estimated: 0, actual: 0 }, 1, money), '$0.00 / $0.00');
});

test('PLANTED FAILURE: a display that just formatted the totals would pass the first test and fail here', () => {
  const naive = (t, _priced, fmt) => fmt(t.estimated) + ' / ' + fmt(t.actual);
  assert.equal(naive({ estimated: 2500, actual: 2730.5 }, 4, money), '$2500.00 / $2730.50');
  assert.notEqual(naive({ estimated: 0, actual: 0 }, 0, money), '—');
});

test('the restored tile counts the unpriced jobs and says so', () => {
  // The count that feeds bizLabourNoEngine must come from the SAME rule the
  // aggregate skips on -- quotedLaborOf returning null -- or the tile would
  // claim a different number of jobs than it actually left out.
  assert.match(src, /quotedLaborOf\(r\.job\) === null\)\.length/,
    'the unpriced-job count no longer uses quotedLaborOf, so it can disagree with what the aggregate skipped');
  assert.match(src, /tr\('bizLabourNoEngine', noLabPrice, prow\.length\)/,
    'the tile no longer tells the reader how many jobs are missing from the figure');
});
