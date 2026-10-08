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

/* THIS USED TO ASSERT THE OPPOSITE, and the reason it gave was wrong.
   It said "APP does not report a date or engine version today -- the wording
   must not invent one just because the fields happen to be present too", and
   pinned "Priced on the phone." with nothing after it.

   They do not happen to be present. Every one of the nine app-priced jobs on
   the live database carries both priced_at and pricing_engine_version, and
   they span five engine versions (2026.09.1 through 2026.10.13). Withholding
   the date was withholding the one fact that explains a real complaint: where
   no accepted price stands, the office shows the stored contract_total -- the
   last figure a phone pushed -- while the phone recomputes live. Three real
   jobs sit in that state with gaps of $2,795, $9,686 and $16,506. */

{
  const job = { priced_by: 'APP', priced_at: '2026-10-05T12:00:00Z', pricing_engine_version: '2026.10.11' };
  const when = new Date(job.priced_at).toLocaleDateString();
  eq('priced on the phone names the date and engine, exactly as the office branch does',
    M.pricedByReadout(job),
    'Priced on the phone on ' + when + ', engine 2026.10.11.');
}
eq('an app-priced job with no engine recorded falls back rather than saying "undefined"',
  M.pricedByReadout({ priced_by: 'APP', priced_at: '2026-10-05T12:00:00Z' }),
  'Priced on the phone on ' + new Date('2026-10-05T12:00:00Z').toLocaleDateString() + ', engine unknown.');
// new Date(null) is 1 January 1970, which reads as a real date and a very old
// one. A job with no stamp has to say it has no stamp.
eq('an app-priced job with no timestamp says so instead of reading as 1970',
  M.pricedByReadout({ priced_by: 'APP', pricing_engine_version: '2026.10.11' }),
  'Priced on the phone on an unknown date, engine 2026.10.11.');
// CONTROL: the two halves differ ONLY in where. A rewrite that collapsed them
// into one sentence for both would pass every assertion above.
{
  const at = '2026-10-05T12:00:00Z', v = '2026.10.11';
  const app = M.pricedByReadout({ priced_by: 'APP', priced_at: at, pricing_engine_version: v });
  const office = M.pricedByReadout({ priced_by: 'OFFICE', priced_at: at, pricing_engine_version: v });
  eq('the phone and the office are still told apart', app === office, false);
  eq('the phone says on the phone', /on the phone/.test(app), true);
  eq('the office says at the office', /at the office/.test(office), true);
}

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
