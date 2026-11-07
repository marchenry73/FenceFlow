/**
 * THE CUSTOMER-FACING EMAIL WAS THE LAST IDENTITY FIELD STORED TWICE WITHOUT
 * A MIRROR.
 *
 * r62 mirrored the business name and phone both ways; r69 added the licence
 * and corrected r62's false reason for leaving it out. Email was left out too,
 * for a reason that had also stopped being true:
 *
 *     -- Their current disagreement -- the settings copy is a personal gmail,
 *     -- and it is what PdfExporter prints in the contract header a customer
 *     -- reads -- is reported to the owner rather than decided here.
 *
 * MEASURED 7 Nov 2026: there is no disagreement. Every company holding both
 * values has the same one in each, and the personal gmail is gone. And F3's
 * distinction -- the one r62 cited -- is a DIFFERENT pair: companies.email
 * against the owner's LOGIN address out of `profiles`. The blob's `email` is
 * BusinessProfile.email, declared in SettingsStore.kt between businessName /
 * phone and licenseNumber, printed by PdfExporter in the contract header. One
 * concept, two stores, agreeing only by luck.
 *
 * r72 mirrors it like the other three, with one difference: a shape check. A
 * wrong name is merely wrong on a page; a wrong EMAIL silently breaks customer
 * mail, because fenceflowReplyTo() rejects an unparseable address and
 * mail-send then refuses to send at all. So "n/a" or a phone number typed in
 * the wrong box is never mirrored into a company's reply-to.
 *
 * WHY LIVE. The defect was never in a file: the mirror function was correct
 * code that simply did not mention the column, and the companies-side trigger
 * would not have fired for an email-only write even if it had. Only the
 * deployed trigger definition can answer whether it fires. The behaviour is
 * proved inside BEGIN/ROLLBACK and writes nothing that survives.
 *
 *     node --test tests/a167-email-follows-the-identity.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT = 'newcrgafcptspmapacrx';

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'a167-email-'));
  const file = join(dir, 'q.sql');
  writeFileSync(file, sql, 'utf8');
  const r = spawnSync('npx', ['--no-install', 'supabase@2.115.0', 'db', 'query',
    '--linked', '--project-ref', PROJECT, '-f', file, '--output', 'json'],
    { encoding: 'utf8', shell: process.platform === 'win32', timeout: 180_000 });
  if (r.status !== 0) {
    throw new Error(`supabase db query failed (exit ${r.status}): ${r.stderr || r.stdout}`);
  }
  let parsed;
  try {
    const t = r.stdout, i = t.indexOf('{');
    parsed = JSON.parse(i >= 0 ? t.slice(i, t.lastIndexOf('}') + 1) : t);
  } catch { throw new Error(`could not parse CLI output: ${r.stdout.slice(0, 300)}`); }
  const rows = Array.isArray(parsed) ? parsed : parsed.rows;
  if (!Array.isArray(rows)) {
    throw new Error(`unexpected CLI shape, not a rows-bearing result: ${r.stdout.slice(0, 300)}`);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// THE SHAPE CHECK
// ---------------------------------------------------------------------------

test('CANARY: looks_like_email exists and answers', () => {
  const [r] = runSql(`select public.looks_like_email('a@b.co') as v;`);
  assert.ok(r && r.v != null, 'looks_like_email returned nothing');
});

test('a real address passes, and a non-address does not', () => {
  // One query, so a single round trip covers the whole table of cases.
  const [r] = runSql(`
    select public.looks_like_email('marc@fenceflowapp.com') as real_addr,
           public.looks_like_email('summitlandscapesky@gmail.com') as gmail,
           public.looks_like_email('n/a') as na,
           public.looks_like_email('8135779330') as phone,
           public.looks_like_email('Fence Solutions') as a_name,
           public.looks_like_email('two words@x.com') as spaced,
           public.looks_like_email('no-at-sign.com') as no_at,
           public.looks_like_email('a@b') as no_dot,
           public.looks_like_email('') as blank,
           public.looks_like_email(null) as nul;`);
  const t = (v) => v === true || v === 't';
  assert.ok(t(r.real_addr), 'a real address was rejected');
  assert.ok(t(r.gmail), 'a real gmail address was rejected');
  for (const [k, why] of [
    ['na', '"n/a"'], ['phone', 'a phone number'], ['a_name', 'a company name'],
    ['spaced', 'an address with a space in it'], ['no_at', 'a value with no @'],
    ['no_dot', 'a value with no dot in the domain'],
    ['blank', 'a blank'], ['nul', 'a null'],
  ]) {
    assert.ok(!t(r[k]), `${why} is accepted as an address and would become a company's reply-to`);
  }
});

// ---------------------------------------------------------------------------
// THE TRIGGER FIRES AT ALL
// ---------------------------------------------------------------------------

const triggers = () => {
  const rows = runSql(`select tgname, pg_get_triggerdef(oid) as def from pg_trigger
     where tgname in ('companies_mirror_identity','company_settings_mirror_identity');`);
  return Object.fromEntries(rows.map(r => [r.tgname, r.def]));
};

test('CANARY: both identity triggers still exist', () => {
  const t = triggers();
  assert.ok(t.companies_mirror_identity, 'companies_mirror_identity is gone');
  assert.ok(t.company_settings_mirror_identity, 'company_settings_mirror_identity is gone');
});

test('an email-only write on companies fires the mirror', () => {
  // The trap r69 was written about: a correct function body is INERT when the
  // trigger's column list does not name the column being written.
  assert.match(triggers().companies_mirror_identity, /UPDATE OF name, phone, license_no, email/i,
    'companies_mirror_identity does not list `email`, so changing only the ' +
    'address never reaches the settings blob and the contract header keeps ' +
    'the old one');
});

test('and the other three are still in that list', () => {
  // Adding a column by rewriting the list is how one of the existing three
  // gets dropped.
  const def = triggers().companies_mirror_identity;
  for (const col of ['name', 'phone', 'license_no']) {
    assert.match(def, new RegExp(`\\b${col}\\b`), `the trigger lost ${col}`);
  }
});

test('the settings side still fires on INSERT as well as UPDATE (r70)', () => {
  // r72 recreates this trigger. If it ever recreates it from a pre-r70 copy,
  // the first settings save silently stops mirroring again.
  const def = triggers().company_settings_mirror_identity;
  assert.match(def, /INSERT/i, 'the settings mirror is UPDATE-only again: r70 was undone');
  assert.match(def, /UPDATE OF settings/i, 'the settings mirror no longer fires on UPDATE');
});

// ---------------------------------------------------------------------------
// IT ACTUALLY MIRRORS
// ---------------------------------------------------------------------------

test('BEHAVIOUR: the email moves both ways, and a non-address does not move at all', () => {
  // Everything above passes on a function that never touches the email.
  // Inside BEGIN/ROLLBACK; nothing here survives.
  //
  // The company is chosen by PROPERTY -- it must already HAVE a settings row,
  // because the companies-side mirror deliberately returns early when there is
  // none (r62's choice, kept by r70 and r72). Picking an arbitrary company
  // would rehearse that early return and prove nothing.
  // EACH WRITE AND ITS READ-BACK ARE SEPARATE STATEMENTS, and that is not
  // style. The first draft did the update in a data-modifying CTE and read
  // the blob in the same statement's SELECT. Every part of one statement
  // sees the snapshot taken at statement start, so the AFTER trigger had
  // fired and the reading side still saw the OLD value -- the test reported
  // "the email did not reach the settings blob" against a mirror that works.
  // A statement boundary between the write and the read is what makes the
  // trigger's effect visible.
  const rows = runSql(`
    begin;
    create temporary table a167 (phase text, blob text, col text);
    create temporary table a167pick as
      select c.id from companies c join company_settings cs on cs.company_id = c.id limit 1;

    update companies set email = 'a167probe@example.com'
     where id = (select id from a167pick);
    insert into a167
      select 'companies_to_blob', cs.settings ->> 'email', c.email
        from companies c join company_settings cs on cs.company_id = c.id
       where c.id = (select id from a167pick);

    -- The other direction.
    update company_settings
       set settings = coalesce(settings,'{}'::jsonb) || jsonb_build_object('email','a167back@example.com')
     where company_id = (select id from a167pick);
    insert into a167
      select 'blob_to_companies', cs.settings ->> 'email', c.email
        from companies c join company_settings cs on cs.company_id = c.id
       where c.id = (select id from a167pick);

    -- POSITIVE CONTROL for the shape check: a value that is not an address
    -- must NOT propagate. Without this, a mirror that copied everything
    -- unconditionally would pass both checks above.
    update company_settings
       set settings = coalesce(settings,'{}'::jsonb) || jsonb_build_object('email','n/a')
     where company_id = (select id from a167pick);
    insert into a167
      select 'junk_blocked', cs.settings ->> 'email', c.email
        from companies c join company_settings cs on cs.company_id = c.id
       where c.id = (select id from a167pick);

    select phase, blob, col from a167;
    rollback;`);

  const by = Object.fromEntries(rows.map(r => [r.phase, r]));

  assert.ok(by.companies_to_blob, 'no company with a settings row -- this test proved nothing');
  assert.strictEqual(by.companies_to_blob.blob, 'a167probe@example.com',
    'writing companies.email did not reach the settings blob, so the contract ' +
    'header a customer reads keeps the old address');

  assert.strictEqual(by.blob_to_companies.col, 'a167back@example.com',
    'writing the settings blob did not reach companies.email, so the reply-to ' +
    'on customer mail keeps the old address');

  // The junk write lands in the blob (nothing stops a bad value being stored
  // there) but must NOT be copied onto the company's customer-facing address.
  assert.strictEqual(by.junk_blocked.blob, 'n/a', 'the control did not write what it meant to');
  assert.notStrictEqual(by.junk_blocked.col, 'n/a',
    '"n/a" was mirrored into companies.email -- that is the reply-to on every ' +
    'customer email, and mail-send refuses to send at all with an unparseable one');
});

test('nothing outside the rolled-back transaction changed', () => {
  // Said out loud and checked: a test that quietly rewrote a company's
  // customer-facing address would be worse than the bug.
  const [r] = runSql(`select count(*)::int as n from companies
                       where email like '%example.com';`);
  assert.strictEqual(Number(r.n), 0,
    `${r.n} company has a probe address as its customer-facing email`);
});
