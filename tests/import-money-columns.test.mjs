/* The money columns, which the pre-launch audit caught getting mixed up.
   These are the worst mistakes the importer can make, because nothing looks
   wrong afterwards: the preview shows a number, the job shows a number, and
   only the contractor's bank account knows they disagree with reality. */
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
const code = ['parseCsv','impMoney','impStatus','impMaterial','impDetectKind','mapImportColumns']
  .map(grab).join('\n\n');
const M = new Function(code + '\nreturn {parseCsv,mapImportColumns};')();

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log('FAIL  ' + label + '\n      got  ' + JSON.stringify(got)
    + '\n      want ' + JSON.stringify(want)); }
};
const read = (csv) => M.mapImportColumns(M.parseCsv(csv)).records[0];

/* ---- 1. The audit's case. "Amount Paid" sits before "Total" and contains
          the word amount, and used to steal the contract total. -------- */
{
  const r = read([
    'Customer,Invoice Date,Amount Paid,Total,Balance',
    'Rosa Delgado,08/01/2026,"$3,000.00","$12,000.00","$9,000.00"'
  ].join('\n'));
  eq('total is the Total column',  r.total, 12000);
  eq('paid is the Amount Paid',    r.paid,  3000);
  eq('owed is the Balance',        r.owed,  9000);
}

/* ---- 2. The mirror. "Unpaid Balance" contains the word paid and must never
          be read as money collected. ----------------------------------- */
{
  const r = read([
    'Client,Contract Total,Unpaid Balance',
    'Ken Boyd,"$8,400.00","$2,100.00"'
  ].join('\n'));
  eq('contract total found',           r.total, 8400);
  eq('unpaid balance is NOT paid',     r.paid,  0);
  eq('unpaid balance is owed',         r.owed,  2100);
}

/* ---- 3. "Balance Due" must not become the total either ---------------- */
{
  const r = read([
    'Customer,Balance Due,Job Total',
    'Marta Reyes,"$500.00","$6,750.00"'
  ].join('\n'));
  eq('job total wins over balance due', r.total, 6750);
  eq('balance due is owed',             r.owed,  500);
}

/* ---- 4. Jobber's quotes report, which was already working ------------- */
{
  const r = read([
    'Quote #,Client name,Status,Subtotal,Total,Required deposit',
    '1042,Rosa Delgado,Approved,"$8,400.00","$8,988.00","$2,000.00"'
  ].join('\n'));
  eq('subtotal claimed as the total', r.total,   8400);
  eq('required deposit found',        r.deposit, 2000);
}

/* ---- 5. A total that only says "Amount" still works ------------------- */
{
  const r = read([
    'Customer,Job Amount,Deposit',
    'Dana Whitfield,"$4,200.00","$1,000.00"'
  ].join('\n'));
  eq('job amount is the total', r.total,   4200);
  eq('deposit found',           r.deposit, 1000);
}

/* ---- 6. Nothing money-ish at all: every figure is zero, not a guess --- */
{
  const r = read(['Name,Phone,Email', 'Bill Ortega,813-555-0100,b@example.com'].join('\n'));
  eq('no total invented',   r.total, 0);
  eq('no payment invented', r.paid,  0);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
