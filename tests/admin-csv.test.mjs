/* csvSafeCell is the admin export's OWASP CSV-injection guard: a cell that
   opens with =, +, -, @ or a tab/CR reads as a formula (or worse) to the
   spreadsheet app that opens the file, not as the plain text it looks like
   here. Pulled straight out of admin.html and run standalone -- no DOM, no
   network -- so a regression here shows up before it ships in a real export. */
import { readFileSync } from 'node:fs';
const src = readFileSync('website/admin.html', 'utf8');

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

const code = ['csvSafeCell'].map(grab).join('\n\n');
const M = new Function(code + '\nreturn {csvSafeCell};')();

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (got === want) pass++;
  else { fail++; console.log('FAIL  ' + label + '\n      got  ' + JSON.stringify(got)
    + '\n      want ' + JSON.stringify(want)); }
};

/* ---------- ordinary cells pass through untouched ---------- */

eq('plain text', M.csvSafeCell('Acme Fencing'), 'Acme Fencing');
eq('number', M.csvSafeCell(1200), '1200');
eq('null becomes empty string', M.csvSafeCell(null), '');
eq('undefined becomes empty string', M.csvSafeCell(undefined), '');
eq('a dash in the middle is not a formula opener', M.csvSafeCell('Smith-Jones'), 'Smith-Jones');
eq('an @ in the middle is fine', M.csvSafeCell('call me@noon'), 'call me@noon');

/* ---------- the five OWASP-listed formula openers get neutralised ---------- */

eq('leading = is neutralised', M.csvSafeCell('=1+1'), "'=1+1");
eq('leading + is neutralised', M.csvSafeCell('+1234567890'), "'+1234567890");
eq('leading - is neutralised', M.csvSafeCell('-2+3'), "'-2+3");
eq('leading @ is neutralised', M.csvSafeCell('@SUM(A1:A9)'), "'@SUM(A1:A9)");
eq('a formula-shaped injection payload is neutralised',
  M.csvSafeCell('=cmd|\'/C calc\'!A0'), "'=cmd|'/C calc'!A0");

/* ---------- a leading tab or CR can smuggle a formula past a naive check ---------- */

eq('leading tab is neutralised', M.csvSafeCell('\t=1+1'), "'\t=1+1");
eq('leading CR is neutralised', M.csvSafeCell('\r=1+1'), "'\r=1+1");

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
