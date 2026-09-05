/* The office's two pure decisions around price-job: what the "priced by"
   readout says (jobs.priced_by / priced_at / pricing_engine_version -> one
   sentence) and what a non-200 price-job response says to a contractor. Both
   are pulled straight out of dashboard.html and run standalone -- no DOM, no
   network -- so wording regressions show up here instead of at a live job. */
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

const code = ['pricedByReadout', 'officePricingErrorMessage'].map(grab).join('\n\n');
const M = new Function(code + '\nreturn {pricedByReadout, officePricingErrorMessage};')();

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (got === want) pass++;
  else { fail++; console.log('FAIL  ' + label + '\n      got  ' + JSON.stringify(got)
    + '\n      want ' + JSON.stringify(want)); }
};

/* ---------- pricedByReadout ---------- */

eq('never priced', M.pricedByReadout({}), 'Not priced yet.');
eq('null job', M.pricedByReadout(null), 'Not priced yet.');
eq('empty priced_by string (the DB default)', M.pricedByReadout({ priced_by: '' }), 'Not priced yet.');

eq('priced on the phone', M.pricedByReadout({ priced_by: 'APP' }), 'Priced on the phone.');
// APP does not report a date or engine version today -- the wording must not
// invent one just because the fields happen to be present too.
eq('priced on the phone ignores a stray priced_at',
  M.pricedByReadout({ priced_by: 'APP', priced_at: '2026-09-01T00:00:00Z' }),
  'Priced on the phone.');

{
  const job = { priced_by: 'OFFICE', priced_at: '2026-09-04T15:00:00Z', pricing_engine_version: '2026.09.1' };
  const when = new Date(job.priced_at).toLocaleDateString();
  eq('priced at the office names the date and engine',
    M.pricedByReadout(job),
    'Priced at the office on ' + when + ', engine 2026.09.1.');
}
eq('priced at the office with no engine version recorded falls back rather than saying "undefined"',
  M.pricedByReadout({ priced_by: 'OFFICE', priced_at: '2026-09-04T15:00:00Z' }),
  'Priced at the office on ' + new Date('2026-09-04T15:00:00Z').toLocaleDateString() + ', engine unknown.');
eq('priced at the office with no timestamp does not crash on new Date(null)',
  M.pricedByReadout({ priced_by: 'OFFICE', pricing_engine_version: '2026.09.1' }),
  'Priced at the office on an unknown date, engine 2026.09.1.');

/* ---------- officePricingErrorMessage ---------- */

eq('403 names who is allowed to price',
  M.officePricingErrorMessage(403, {}),
  "This account can't price jobs here — pricing is limited to owners and managers on an active plan.");
eq('409 tells the caller the job moved under them, even if the body carries no error text',
  M.officePricingErrorMessage(409, {}),
  'This job changed since it was priced — reload it and try again.');
eq('409 wins over a same-shaped body.error, so the conflict wording is never masked',
  M.officePricingErrorMessage(409, { error: 'ignored' }),
  'This job changed since it was priced — reload it and try again.');
eq('an ordinary error surfaces the function\'s own sentence',
  M.officePricingErrorMessage(500, { error: 'The pricing engine crashed on run "Back".' }),
  'The pricing engine crashed on run "Back".');
eq('status 0 (fetch threw) reads as unreachable, not as a generic failure',
  M.officePricingErrorMessage(0, { error: 'Failed to fetch' }),
  'Failed to fetch');
eq('status 0 with no parsed body at all falls back to the unreachable sentence',
  M.officePricingErrorMessage(0, {}),
  'Could not reach the pricing service just now.');
eq('an unrecognized status with no body.error gets a generic, still-visible failure',
  M.officePricingErrorMessage(502, null),
  'Could not price this job just now.');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
