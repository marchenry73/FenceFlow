/* Housecall Pro's export is the odd one out: it says "Home number" rather than
   "Home phone", and "Street line 2" rather than "Address line 2". Both patterns
   were missing and both are silent failures -- a customer imports looking fine,
   just with no phone number and half an address. */
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
const mod = new Function(code + '\nreturn {parseCsv,mapImportColumns};')();

let pass = 0, fail = 0;
const check = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log('FAIL  ' + label + '\n      got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want)); }
};

const hcp = [
  'First name,Last name,Email,Mobile number,Home number,Street,Street line 2,City,State,Zip',
  'Dana,Whitfield,dana@example.com,,813-555-4141,66 Heron Dr,Unit B,Apollo Beach,FL,33572'
].join('\n');
const r = mod.mapImportColumns(mod.parseCsv(hcp));
check('hcp name joined',      r.records[0].name,    'Dana Whitfield');
check('hcp home number found', r.records[0].phone,  '813-555-4141');
check('hcp street line 2 kept', r.records[0].address, '66 Heron Dr, Unit B, Apollo Beach, FL 33572');
check('hcp is a customer list', r.kind,             'customers');

/* A mobile, when they have one, still wins over the landline. */
const hcp2 = [
  'First name,Last name,Mobile number,Home number',
  'Ray,Nunez,813-555-2020,813-555-4141'
].join('\n');
check('mobile beats home', mod.mapImportColumns(mod.parseCsv(hcp2)).records[0].phone, '813-555-2020');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
