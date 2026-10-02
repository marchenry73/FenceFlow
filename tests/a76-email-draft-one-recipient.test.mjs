/* An email draft opened by the app carries exactly ONE recipient, or it does
   not open.

   WHY. `lead-intake` runs with verify_jwt = false (supabase/config.toml), so a
   stranger filling in the public website form writes jobs.email through the
   service-role client, and the only check there is email.includes("@"). So
   "her@example.com, attacker@example.com" is a value this app can be holding
   through no fault of the owner's. Android's EXTRA_EMAIL takes an array, so
   that string reaches the mail app as TWO recipients -- and the quote email's
   body carries the quote link, which is a bearer token that can approve and
   sign on her behalf.

   THE GATE IS AT THE FUNNEL. IntentHelpers.openEmailDraft has five callers and
   gating them one at a time never converges: the sixth, written next month,
   arrives unguarded. Refusing inside openEmailDraft makes new code refused by
   default. This file asserts that, structurally, so moving the check back out
   to the callers goes red.

   The predicate is transcribed from the Kotlin because this suite is plain node
   and cannot run Kotlin. That is a real limit: it proves the RULE, and the
   structural test below proves the rule is wired into the one place every
   caller passes through. Stated rather than glossed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const SRC = 'app/src/main/java/com/fenceestimator/app/ui/components/IntentHelpers.kt';
const src = read(SRC);

/* ---- the rule, transcribed from looksLikeOneAddress ---------------------- */
const looksLikeOneAddress = (raw) => {
  const to = String(raw).trim();
  if (to.length === 0 || to.length > 320) return false;
  for (const ch of to) {
    if (ch === ',' || ch === ';' || /\s/.test(ch) || ch.charCodeAt(0) < 0x20) return false;
  }
  const at = to.indexOf('@');
  if (at <= 0 || at !== to.lastIndexOf('@') || at === to.length - 1) return false;
  const domain = to.slice(at + 1);
  const dot = domain.indexOf('.');
  return dot > 0 && dot < domain.length - 1 && !domain.includes('..');
};

test('the transcription matches the Kotlin, clause for clause (positive control)', () => {
  // Not a word match on a comment -- the actual clauses that decide the answer.
  const body = src.slice(src.indexOf('internal fun looksLikeOneAddress'));
  const fn = body.slice(0, body.indexOf('\n    }') + 6);
  assert.ok(fn.length > 200, 'could not lift looksLikeOneAddress; has it been renamed?');
  for (const clause of [
    "it == ','",
    "it == ';'",
    'it.isWhitespace()',
    'it.code < 0x20',
    'to.length > 320',
    "to.indexOf('@')",
    "to.lastIndexOf('@')",
    'domain.contains("..")',
  ]) {
    assert.ok(fn.includes(clause), 'the Kotlin no longer has the clause ' + clause +
      ' -- this transcription is stale and every assertion below is now lying');
  }
});

/* ---- the gate is at the funnel, not at the callers ---------------------- */
test('openEmailDraft itself refuses, so every caller is covered', () => {
  const i = src.indexOf('fun openEmailDraft(');
  assert.ok(i > 0, 'openEmailDraft is gone');
  const fn = src.slice(i, src.indexOf('\n    }', i));
  assert.match(
    fn, /if \(!looksLikeOneAddress\(to\)\) return false/,
    'openEmailDraft no longer refuses a bad address itself. Moving this check out ' +
    'to the callers means the next caller written arrives unguarded -- that is the ' +
    'control-by-control gating that never converges.'
  );
  // And it must refuse BEFORE building the intent, not after.
  assert.ok(
    fn.indexOf('looksLikeOneAddress') < fn.indexOf('EXTRA_EMAIL'),
    'the check must come before the intent is built'
  );
});

test('POSITIVE CONTROL: there really are several callers to protect', () => {
  // If this drops to one, the funnel argument weakens and someone should revisit.
  const callers = ['app/src/main/java/com/fenceestimator/app/ui/feedback/FeedbackScreen.kt',
                   'app/src/main/java/com/fenceestimator/app/ui/jobs/JobBlockedSection.kt',
                   'app/src/main/java/com/fenceestimator/app/ui/jobs/JobDetailScreen.kt']
    .filter(p => { try { return read(p).includes('openEmailDraft'); } catch { return false; } });
  assert.ok(callers.length >= 2, 'expected at least 2 callers, found ' + callers.length);
});

/* ---- what must be refused ----------------------------------------------- */
test('a list, or anything that can become one, is REFUSED', () => {
  const refuse = [
    'her@example.invalid, attacker@example.invalid',
    'her@example.invalid,attacker@example.invalid',
    'her@example.invalid; attacker@example.invalid',
    'her@example.invalid attacker@example.invalid',
    '"a,b"@example.invalid',            // RFC-legal, carries a comma: refused on purpose
    'her@example.invalid\nBcc: x@y.invalid',
    'her@example.invalid\r\nattacker@example.invalid',
    'her@example.invalid\tattacker@example.invalid',
    '',
    '   ',
    'notanaddress',
    'her@',
    '@example.invalid',
    'her@@example.invalid',
    'her@example',                      // no dot in the domain
    'her@example.',
    'her@.invalid',
    'her@exa..mple.invalid',
    'a'.repeat(400) + '@example.invalid',
  ];
  for (const bad of refuse) {
    assert.equal(looksLikeOneAddress(bad), false,
      'accepted something it must refuse: ' + JSON.stringify(bad));
  }
});

test('POSITIVE CONTROL: an ordinary customer address is ACCEPTED', () => {
  // Without this, a predicate that returned false for everything would pass the
  // whole file above and silently stop him emailing anybody.
  const accept = [
    'jane@example.invalid',
    'jane.smith@example.invalid',
    "o'brien@example.invalid",
    'jane+fence@example.invalid',
    'jane_smith99@mail.example.invalid',
    'j@e.co',
    'JANE@EXAMPLE.INVALID',
  ];
  for (const good of accept) {
    assert.equal(looksLikeOneAddress(good), true,
      'refused an ordinary address: ' + JSON.stringify(good));
  }
});

/* ---- the same rule at the OTHER end, and the two must not drift ---------- */
/* The phone refuses a list when it opens a draft; lead-intake refuses one when
   it writes the column. Both are needed and for different reasons: the door
   stops the value existing, the funnel stops a value that got in another way
   (the office, a restore, a row written before the door was fixed) from
   reaching a mail app. If one is relaxed without the other, that is worth
   knowing, so this asserts both exist with the same clauses. */
const LEAD = 'supabase/functions/lead-intake/index.ts';
const lead = read(LEAD);

test('lead-intake refuses a list at the door, with the same clauses', () => {
  const i = lead.indexOf('const emailLooksSingle');
  assert.ok(i > 0,
    'lead-intake no longer screens the address. It runs with verify_jwt = false and ' +
    'writes jobs.email through the service-role client, so without this a stranger ' +
    'can put a second recipient on the row -- and send-follow-ups mails it ' +
    'automatically, with figures in it.');
  const fn = lead.slice(i, lead.indexOf('})();', i) + 5);
  for (const clause of [
    'ch === ","',
    'ch === ";"',
    '/\\s/.test(ch)',
    'ch.charCodeAt(0) < 0x20',
    'rawEmail.indexOf("@")',
    'rawEmail.lastIndexOf("@")',
    'domain.includes("..")',
  ]) {
    assert.ok(fn.includes(clause),
      'lead-intake has drifted from the phone rule: missing ' + clause +
      '. The two ends must refuse the same shapes, or a row the door accepts ' +
      'gets refused later with no explanation (or worse, the other way round).');
  }
});

test('a half-valid address is DROPPED rather than stored by lead-intake', () => {
  // An unusable string in jobs.email is worse than an empty column, because
  // send-follow-ups selects on `email <> ''` and would mail it.
  assert.match(
    lead, /const email = emailLooksSingle \? rawEmail : "";/,
    'lead-intake must store "" rather than a string it has judged unusable'
  );
  assert.match(
    lead, /insert\(\{[\s\S]{0,200}?phone, email, address,/,
    'the insert must use the screened `email`, not the raw one'
  );
  assert.ok(
    !/phone, rawEmail, address/.test(lead),
    'the insert is writing rawEmail -- the screening is bypassed'
  );
});

test('CANARY: the structural test would have caught the code as it was', () => {
  const asItWas = src.replace('        if (!looksLikeOneAddress(to)) return false\n', '');
  assert.notEqual(asItWas, src, 'could not reproduce the old code -- this canary tests nothing');
  const i = asItWas.indexOf('fun openEmailDraft(');
  const fn = asItWas.slice(i, asItWas.indexOf('\n    }', i));
  assert.ok(
    !/if \(!looksLikeOneAddress\(to\)\) return false/.test(fn),
    'the structural test would NOT have noticed the guard missing, so it guards nothing'
  );
});

console.log('a76: an email draft carries one recipient or it does not open');
