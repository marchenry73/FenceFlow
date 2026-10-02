/* Nothing a stranger typed may become a clickable link in mail sent from HIS
   domain.

   WHY THIS FILE EXISTS. supabase/functions/_shared/email-templates.ts had two
   builders that print the same two job fields. buildQuoteSendEmail sanitised
   them with typedByStranger(); buildJobEmail, 450 lines further down, used
   oneLine(), which strips nothing link-shaped. Found 2026-10-02 and fixed the
   same day.

   WHY IT MATTERS, in one sentence: lead-intake runs with verify_jwt = false, so
   an unauthenticated stranger filling in the public web form writes
   jobs.customer_name and jobs.address; _shared/mail/mime-build.ts linkify()
   turns a bare https:// in the text into a real <a href> in the HTML part; and
   the message leaves from the contractor's own address. That is a phishing link
   with his return address on it, sent to his customer, by his own software.

   WHAT THIS ASSERTS, and the order matters:
     1. the SOURCE routes every stranger-typed field through typedByStranger --
        checked structurally, so a new builder that forgets cannot pass;
     2. the sanitiser actually removes what it claims to;
     3. a POSITIVE CONTROL: the company's own name and phone are NOT stripped,
        because he types those himself and mangling them is its own bug;
     4. a CANARY that must fail against the old code.

   It reads the TypeScript as text rather than importing it: these are Deno edge
   functions and this suite is plain node. That is a real limit -- it cannot
   prove the rendered output, only that the deciding call is the right one. The
   rendering half is covered by a72/a73. Stated rather than glossed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = 'supabase/functions/_shared/email-templates.ts';
const src = readFileSync(new URL('../' + SRC, import.meta.url), 'utf8');

/* ---- the fields a stranger can write ------------------------------------- */
/* From lead-intake's own insert. If that function ever writes another job
   column that a template prints, add it here -- and the test below will tell
   you it is unguarded. */
const STRANGER_FIELDS = ['customerName', 'address'];

/* Fields the OWNER types, which must NOT be stripped. Stripping a link out of
   a business name quietly mangles a company whose name he wants shown as he
   wrote it, and that is a defect in the other direction. */
const OWNER_FIELDS = ['companyName', 'companyPhone'];

test('the source exists and is big enough to be the real file (positive control)', () => {
  assert.ok(src.length > 10000, 'email-templates.ts looks truncated: ' + src.length + ' bytes');
  assert.match(src, /export function typedByStranger\(/, 'typedByStranger is gone from the file');
  assert.match(src, /export function buildQuoteSendEmail\(/);
  assert.match(src, /export function buildJobEmail\(/);
});

test('EVERY stranger-typed field goes through typedByStranger, in every builder', () => {
  for (const field of STRANGER_FIELDS) {
    // Every assignment that reads this field off `facts`.
    const uses = [...src.matchAll(
      new RegExp('(\\w+)\\(facts\\.' + field + '\\b', 'g')
    )].map(m => m[1]);

    assert.ok(uses.length > 0, 'facts.' + field + ' is never read -- has it been renamed?');

    const unguarded = uses.filter(fn => fn !== 'typedByStranger');
    assert.deepEqual(
      unguarded, [],
      'facts.' + field + ' reaches a template through ' + unguarded.join(', ') +
      ' instead of typedByStranger. A stranger writes that column through the ' +
      'public form (lead-intake, verify_jwt = false) and linkify() will turn a ' +
      'bare URL in it into a clickable link in mail from his own domain.'
    );
  }
});

test('POSITIVE CONTROL: the owner’s own fields are NOT stripped', () => {
  for (const field of OWNER_FIELDS) {
    const uses = [...src.matchAll(
      new RegExp('(\\w+)\\(facts\\.' + field + '\\b', 'g')
    )].map(m => m[1]);
    assert.ok(uses.length > 0, 'facts.' + field + ' is never read');
    assert.ok(
      uses.some(fn => fn === 'oneLine'),
      'facts.' + field + ' is no longer read through oneLine anywhere. He types ' +
      'his own business name and number; stripping a link out of them mangles ' +
      'what he asked to be shown. If this was deliberate, change this test and ' +
      'say why.'
    );
  }
});

/* ---- 2. the sanitiser removes what it claims to -------------------------- */
/* Lifted out of the source and run, rather than reimplemented: a copy of the
   pattern in the test could drift from the real one and still pass. */
const liftConst = (name) => {
  const m = src.match(new RegExp('^const ' + name + ' = (.+);$', 'm'));
  if (!m) throw new Error('not found: const ' + name);
  return m[1];
};
const LINKISH = eval(liftConst('LINKISH'));
const stripLinks = (s) => String(s).replace(new RegExp(LINKISH.source, LINKISH.flags), '');

test('the real LINKISH pattern removes every link shape linkify would catch', () => {
  const mustGo = [
    'http://evil.example',
    'https://evil.example/pay',
    'HTTPS://EVIL.EXAMPLE',
    'www.evil.example',
    'WWW.evil.example/x?y=1',
    'javascript:alert(1)',
    'data:text/html,<script>',
    'ftp://evil.example',
  ];
  for (const bad of mustGo) {
    const out = stripLinks('Jane Smith ' + bad + ' call me');
    assert.ok(
      !/:\/\/|www\./i.test(out),
      'LINKISH left a link shape behind in: ' + JSON.stringify(out) + ' (from ' + bad + ')'
    );
  }
});

test('POSITIVE CONTROL: an ordinary name and address survive untouched', () => {
  // If the pattern were greedy enough to eat normal text, every customer's name
  // would arrive mangled and nobody would notice from a passing link test.
  const keep = [
    'Jane Smith',
    "O'Brien-Hughes",
    '1423 W Riverview Dr, Gibsonton FL 33534',
    'Apt 2B, c/o Martinez',
    'Jose Gonzalez',
    'Unit 4 - rear gate',
  ];
  for (const good of keep) {
    assert.equal(stripLinks(good), good, 'LINKISH mangled ordinary text: ' + good);
  }
});

/* ---- 3. the canary ------------------------------------------------------- */
test('CANARY: this file fails against the code as it was before the fix', () => {
  // The exact text the bug had. If someone reintroduces it, the structural test
  // above goes red -- this proves that test can actually see it, rather than
  // passing because its regex never matched anything.
  const asItWas = src
    .replace('const name = typedByStranger(facts.customerName, NAME_MAX);',
             'const name = oneLine(facts.customerName, NAME_MAX);')
    .replace('const address = typedByStranger(facts.address, ADDRESS_MAX);',
             'const address = oneLine(facts.address, ADDRESS_MAX);');

  assert.notEqual(asItWas, src, 'could not reproduce the old code -- this canary is not testing anything');

  const unguarded = STRANGER_FIELDS.flatMap(field =>
    [...asItWas.matchAll(new RegExp('(\\w+)\\(facts\\.' + field + '\\b', 'g'))]
      .map(m => m[1])
      .filter(fn => fn !== 'typedByStranger')
  );
  assert.ok(
    unguarded.length > 0,
    'the structural test would NOT have caught the original bug, so it is guarding nothing'
  );
});

console.log('a75: stranger-typed job fields cannot become links in mail from his own domain');
