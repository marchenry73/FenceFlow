/* Pulls the real import functions out of dashboard.html and runs them against
   the header rows the research turned up, so the mapping is proved rather than
   eyeballed. */
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
const mod = new Function(code + '\nreturn {parseCsv,impMoney,impStatus,impMaterial,impDetectKind,mapImportColumns};')();

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL  ' + label + '\n      got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want)); }
};

/* ---------- 1. Jobber client export: split name, split address ---------- */
const jobber = [
  'First name,Last name,Company name,Email,Main Phone,Mobile Phone,Street,City,Province/State,Postal Code,Note',
  'Jane,Halloran,,jane@example.com,561-555-0142,561-555-9911,812 Palm Ridge Dr,Riverview,FL,33578,Wants cedar'
].join('\n');
let r = mod.mapImportColumns(mod.parseCsv(jobber));
check('jobber kind', r.kind, 'customers');
check('jobber name joined', r.records[0].name, 'Jane Halloran');
check('jobber prefers mobile', r.records[0].phone, '561-555-9911');
check('jobber address joined', r.records[0].address, '812 Palm Ridge Dr, Riverview, FL 33578');
check('jobber email', r.records[0].email, 'jane@example.com');
check('jobber note', r.records[0].notes, 'Wants cedar');

/* ---------- 2. JobNimbus contacts: Address Line 1/2, State Text -------- */
const nimbus = [
  'First Name,Last Name,Email,Home Phone,Mobile Phone,Address Line 1,Address Line 2,City,State Text,Zip,Status Name',
  'Bill,Ortega,bill@example.com,813-555-0100,,4402 Ash Ln,Apt 3,Gibsonton,FL,33534,Lead'
].join('\n');
r = mod.mapImportColumns(mod.parseCsv(nimbus));
check('nimbus name', r.records[0].name, 'Bill Ortega');
check('nimbus address', r.records[0].address, '4402 Ash Ln, Apt 3, Gibsonton, FL 33534');
check('nimbus falls back to home phone', r.records[0].phone, '813-555-0100');
check('nimbus status alone is NOT a job file', r.kind, 'customers');

/* ---------- 3. Jobber quotes report: money, service address, status ---- */
const quotes = [
  'Quote #,Client name,Client email,Client phone,Service street,Service city,Service state/province,Service zip/postal code,Status,Subtotal,Total,Required deposit',
  '1042,"Delgado, Rosa",rosa@example.com,813-555-7788,90 Oak Bend,Apollo Beach,FL,33572,Approved,"$8,400.00","$8,988.00","$2,000.00"'
].join('\n');
r = mod.mapImportColumns(mod.parseCsv(quotes));
check('quotes detected as jobs', r.kind, 'jobs');
check('quotes customer', r.records[0].name, 'Delgado, Rosa');
check('quotes address', r.records[0].address, '90 Oak Bend, Apollo Beach, FL 33572');
check('quotes total parsed', r.records[0].total, 8400);       // Subtotal claimed first
check('quotes deposit parsed', r.records[0].deposit, 2000);
check('Approved maps to ACCEPTED', mod.impStatus(r.records[0].statusRaw), 'ACCEPTED');

/* ---------- 4. Status vocabulary from both products ------------------- */
check('Awaiting Response', mod.impStatus('Awaiting Response'), 'SENT');
check('Changes Requested', mod.impStatus('Changes Requested'), 'SENT');
check('Converted',         mod.impStatus('Converted'),         'ACCEPTED');
check('Signed Contract',   mod.impStatus('Signed Contract'),   'ACCEPTED');
check('Paid & Closed',     mod.impStatus('Paid & Closed'),     'COMPLETED');
check('Job Completed',     mod.impStatus('Job Completed'),     'COMPLETED');
check('Lost',              mod.impStatus('Lost'),              'DECLINED');
check('Dead',              mod.impStatus('Dead'),              'DECLINED');
check('blank is draft',    mod.impStatus(''),                  'DRAFT');

/* ---------- 5. Money edge cases --------------------------------------- */
check('money plain',      mod.impMoney('1234.5'),      1234.5);
check('money currency',   mod.impMoney('$8,988.00'),   8988);
check('money accounting', mod.impMoney('($250.00)'),   -250);
check('money blank',      mod.impMoney(''),            0);
check('money junk',       mod.impMoney('n/a'),         0);

/* ---------- 6. Price list: Jobber Products & Services ----------------- */
const price = [
  'Name,Description,Unit Price,Unit Cost,Taxable,Category,Active',
  '6ft Cedar Picket,Rough sawn,4.85,3.10,TRUE,Product,TRUE',
  '4x4x8 Pressure Treated Post,,18.40,12.00,TRUE,Product,TRUE',
  'Gate Hinge Set,Heavy duty,32.00,21.00,TRUE,Product,TRUE',
  'Chain Link Fabric 4ft,,6.25,4.10,TRUE,Product,TRUE'
].join('\n');
r = mod.mapImportColumns(mod.parseCsv(price));
check('price list detected', r.kind, 'pricelist');
check('price parsed', r.records[0].price, 4.85);
const g0 = mod.impMaterial('6ft Cedar Picket','');
check('cedar picket → WOOD/PICKET', [g0.fence_type,g0.category,g0.role], ['WOOD','PICKET','WOOD_PICKET']);
const g1 = mod.impMaterial('4x4x8 Pressure Treated Post','');
check('treated post → WOOD/POST/LINE', [g1.fence_type,g1.category,g1.role], ['WOOD','POST','LINE_POST']);
const g2 = mod.impMaterial('Gate Hinge Set','');
check('hinge → HARDWARE/HINGE_SET/SET', [g2.category,g2.role,g2.unit], ['HARDWARE','HINGE_SET','SET']);
const g3 = mod.impMaterial('Chain Link Fabric 4ft','');
check('chain fabric → CHAIN_LINK/FABRIC/LF', [g3.fence_type,g3.category,g3.unit], ['CHAIN_LINK','FABRIC','LF']);
const g4 = mod.impMaterial('Corner Post Aluminum','');
check('corner post → ALUMINUM/POST/CORNER', [g4.fence_type,g4.role], ['ALUMINUM','CORNER_POST']);
const g5 = mod.impMaterial('Vinyl Post Cap','');
check('post cap → VINYL/CAP', [g5.fence_type,g5.category,g5.role], ['VINYL','CAP','POST_CAP']);
const g6 = mod.impMaterial('Concrete Bag 50lb','EA');
check('concrete → CONCRETE/BAG', [g6.category,g6.role], ['CONCRETE','CONCRETE_BAG']);
const g7 = mod.impMaterial('Top Rail','feet');
check('stated unit wins', g7.unit, 'LF');

/* ---------- 7. Homemade spreadsheet, no header ------------------------ */
const homemade = [
  'Marta Reyes,813-555-0177,marta@example.com,15 Willow Ct Ruskin FL,called Tuesday'
].join('\n');
r = mod.mapImportColumns(mod.parseCsv(homemade));
check('headerless falls back to position', r.records[0].name, 'Marta Reyes');
check('headerless phone', r.records[0].phone, '813-555-0177');
check('headerless treated as customers', r.kind, 'customers');

/* ---------- 8. The old bug: e-mail must not steal the address --------- */
const tricky = [
  'Customer Name,E-mail Address,Street Address,Phone Number',
  'Ken Boyd,ken@example.com,700 Cypress Way,813-555-2211'
].join('\n');
r = mod.mapImportColumns(mod.parseCsv(tricky));
check('email did not steal address', r.records[0].address, '700 Cypress Way');
check('email still found', r.records[0].email, 'ken@example.com');
check('name found', r.records[0].name, 'Ken Boyd');
check('phone found', r.records[0].phone, '813-555-2211');

/* ---------- 9. QuickBooks customer contact list ----------------------- */
const qbo = [
  'Customer,Phone Numbers,Email,Full Name,Billing Address',
  'Ortiz Landscaping,813-555-3030,ap@ortiz.com,Hector Ortiz,"55 Bay St, Tampa, FL 33602"'
].join('\n');
r = mod.mapImportColumns(mod.parseCsv(qbo));
check('qbo kind', r.kind, 'customers');
check('qbo phone', r.records[0].phone, '813-555-3030');
check('qbo email', r.records[0].email, 'ap@ortiz.com');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
