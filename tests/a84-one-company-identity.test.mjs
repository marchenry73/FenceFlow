// a84 -- the business name and phone live in two places, and must not drift.
//
// WHAT HAPPENED, 30 October 2026, read off the live database:
//
//     companies.name                     'Fence solutions'
//     company_settings -> business_name  'Legacy solutions'
//     companies.phone                    ''            (empty)
//     company_settings -> phone          '8135779310'
//
// Both are read, by different halves of the product, for the same sentence to
// the same customer:
//
//   * the PHONE sends a quote with profile.businessName -- the settings blob
//     (JobDetailScreen's quote_email_subject) -- so three customers on 24 and
//     26 October received "Your fence quote from Legacy solutions";
//   * the SERVER sends the approval confirmation with co.name -- the column
//     (quote-approval-email) -- so the same customer then received "Your
//     approved fence quote from Fence solutions".
//
// Two emails, two business names, one job. The phone number split the other
// way: the column was empty, so every reader of the company record (HOA
// letters, Stripe payment-link descriptions, crew invitations) had no number
// for a business that has one.
//
// Neither stored value was actually right. Asked which was, the owner answered
// one and then corrected it to 'Legacy Solutions' -- note the capital S, which
// neither store had. supabase_r62_one_company_identity.sql writes that name to
// both sides and installs a mirror so the two cannot drift again, whichever is
// written.
//
// WHAT THIS FILE GUARDS, and why each check is here rather than only in r62's
// own self-check (which runs once, at apply time, and then never again):
//
//   1. No company anywhere disagrees with its own settings blob. This is the
//      symptom, checked directly against live data, so a future drift from any
//      cause at all is caught -- not just one the mirror could have prevented.
//   2. Both mirror triggers are installed. A fix that is only data is a fix
//      that lasts until the next edit.
//   3. The mirror actually FIRES, both ways, proven on a real row inside a
//      transaction that is rolled back. A trigger that exists and does nothing
//      is precisely the failure this whole change exists to prevent, so it is
//      not taken on trust.
//   4. A BLANK does not overwrite a real value. That is the rule which filled
//      the empty phone from the blob instead of letting the empty column wipe
//      the number, and it is the one a careless rewrite of the mirror breaks.
//   5. EMAIL IS NOT MIRRORED, deliberately. companies.email is the
//      customer-facing address and the settings copy is a separate field (item
//      F3 records that separation as intentional), so a mirror that "helpfully"
//      included it would quietly replace one with the other.
//
// THIS FILE WRITES, inside BEGIN/ROLLBACK, which a4-labour's header forbids for
// itself. It is unavoidable here: checks 3 and 4 are about what happens WHEN
// something is written, and there is no read that answers them. Every write is
// to one company's own name field, inside a transaction with no commit, and
// check 6 reads the row back afterwards to prove the rollback took.
//
//     node --test tests/a84-one-company-identity.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT = "newcrgafcptspmapacrx";

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "a84-identity-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query",
    "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
    { encoding: "utf8", shell: process.platform === "win32", timeout: 180_000 });
  // Read the RAW status before trusting a parse: a JSON parser that prints a
  // header on an error response reads exactly like an empty-but-ok result, and
  // that has already cost this project a wrong conclusion more than once.
  if (r.status !== 0) {
    throw new Error(`supabase db query failed (exit ${r.status}): ${r.stderr || r.stdout}`);
  }
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { throw new Error(`could not parse CLI output: ${r.stdout}`); }
  if (!parsed || (!Array.isArray(parsed) && !("rows" in parsed))) {
    throw new Error(`unexpected CLI shape, not a rows-bearing result: ${r.stdout.slice(0, 300)}`);
  }
  return Array.isArray(parsed) ? parsed : parsed.rows;
}

const one = (sql) => {
  const rows = runSql(sql);
  assert.equal(rows.length, 1, `expected exactly one row from:\n${sql}`);
  return rows[0];
};

// ======================================================= 1. nothing disagrees
test("1. no company's name or phone disagrees with its own settings blob", () => {
  const r = one(`
    select
      (select count(*) from public.companies c
         join public.company_settings s on s.company_id = c.id
        where coalesce(btrim(c.name), '') <> ''
          and coalesce(btrim(s.settings ->> 'business_name'), '')
              is distinct from coalesce(btrim(c.name), ''))::int as names,
      (select count(*) from public.companies c
         join public.company_settings s on s.company_id = c.id
        where coalesce(btrim(s.settings ->> 'phone'), '') <> ''
          and coalesce(btrim(c.phone), '')
              is distinct from coalesce(btrim(s.settings ->> 'phone'), ''))::int as phones,
      (select count(*) from public.companies c
         join public.company_settings s on s.company_id = c.id)::int as pairs;`);
  // CONTROL FIRST: a zero out of an empty join proves nothing at all.
  assert.ok(Number(r.pairs) > 0,
    "control: no company has a settings row, so the two counts below are vacuous");
  assert.equal(Number(r.names), 0,
    "a company's name disagrees with its settings blob -- the phone and the server will name different businesses to the same customer");
  assert.equal(Number(r.phones), 0,
    "a company's phone disagrees with its settings blob");
});

// ==================================================== 2. the mirror is installed
test("2. both mirror triggers are installed, on the columns that matter", () => {
  const r = one(`
    select
      (select count(*) from pg_trigger t
         join pg_class k on k.oid = t.tgrelid
         join pg_namespace n on n.oid = k.relnamespace
        where n.nspname = 'public' and not t.tgisinternal
          and k.relname = 'companies' and t.tgname = 'companies_mirror_identity')::int as on_companies,
      (select count(*) from pg_trigger t
         join pg_class k on k.oid = t.tgrelid
         join pg_namespace n on n.oid = k.relnamespace
        where n.nspname = 'public' and not t.tgisinternal
          and k.relname = 'company_settings' and t.tgname = 'company_settings_mirror_identity')::int as on_settings,
      (select count(*) from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname = 'mirror_company_identity')::int as fn;`);
  assert.equal(Number(r.fn), 1, "mirror_company_identity() is not on this database");
  assert.equal(Number(r.on_companies), 1, "companies has no identity mirror trigger");
  assert.equal(Number(r.on_settings), 1, "company_settings has no identity mirror trigger");
});

// ========================================= 3 & 4. it fires, and a blank cannot win
test("3. the mirror fires both ways, and a blank never overwrites a real name", () => {
  // One company, picked by the property the test needs (it has a name and a
  // settings row) rather than by id -- a fixture pinned to one company rots the
  // moment that company is renamed, which is the very thing being tested.
  const rows = runSql(`
    begin;
    create temp table p(ord int, what text, got text);

    do $x$
    declare co uuid; had_name text; had_blob text;
    begin
      select c.id, c.name, s.settings ->> 'business_name'
        into co, had_name, had_blob
        from public.companies c join public.company_settings s on s.company_id = c.id
       where coalesce(btrim(c.name), '') <> '' limit 1;
      if co is null then
        insert into p values (0, 'SKIPPED', 'no company with a name and a settings row');
        return;
      end if;

      -- CONTROL: the two start in step, or the checks below measure a drift
      -- that was already there rather than the mirror doing its job.
      insert into p values (1, 'control: the two start in step',
        case when coalesce(btrim(had_name),'') = coalesce(btrim(had_blob),'') then 'yes' else
             'NO (' || coalesce(had_name,'null') || ' vs ' || coalesce(had_blob,'null') || ')' end);

      -- column -> blob
      update public.companies set name = 'A84 PROBE ONE' where id = co;
      insert into p values (2, 'writing companies.name reaches the blob',
        coalesce((select s.settings ->> 'business_name' from public.company_settings s
                   where s.company_id = co), 'NULL'));

      -- blob -> column
      update public.company_settings
         set settings = coalesce(settings,'{}'::jsonb) || '{"business_name":"A84 PROBE TWO"}'::jsonb
       where company_id = co;
      insert into p values (3, 'writing the blob reaches companies.name',
        coalesce((select name from public.companies where id = co), 'NULL'));

      -- a blank must NOT win
      update public.company_settings
         set settings = coalesce(settings,'{}'::jsonb) || '{"business_name":""}'::jsonb
       where company_id = co;
      insert into p values (4, 'a blank blob name did NOT overwrite the column',
        coalesce((select name from public.companies where id = co), 'NULL'));

      insert into p values (9, 'the company this ran against', co::text);
    end $x$;

    select ord, what, got from p order by ord;
    rollback;`);

  const get = (ord) => rows.find((r) => Number(r.ord) === ord)?.got;
  if (get(0)) { assert.fail(`cannot run: ${get(0)}`); }

  assert.equal(get(1), "yes",
    `control: the chosen company's two stores already disagree (${get(1)}) -- check 1 should have caught that first`);
  assert.equal(get(2), "A84 PROBE ONE",
    "writing companies.name did NOT reach the settings blob -- the mirror is installed and inert");
  assert.equal(get(3), "A84 PROBE TWO",
    "writing the settings blob did NOT reach companies.name");
  assert.equal(get(4), "A84 PROBE TWO",
    "a BLANK settings name overwrote a real company name -- absence is not an instruction to delete, and this is the rule that filled the empty phone instead of wiping the number");
});

test("4. the rollback took: nothing named A84 PROBE survives", () => {
  // The other half of a test that writes. Without this, a probe that
  // accidentally committed would leave a company called "A84 PROBE TWO" and
  // this file would still be green.
  const r = one(`
    select (select count(*) from public.companies where name like 'A84 PROBE%')::int as cols,
           (select count(*) from public.company_settings
             where settings ->> 'business_name' like 'A84 PROBE%')::int as blobs;`);
  assert.equal(Number(r.cols), 0, "a probe name was committed to companies.name");
  assert.equal(Number(r.blobs), 0, "a probe name was committed to a settings blob");
});

// ============================================== 5. email is deliberately apart
test("5. email is NOT mirrored, and the mirror says so", () => {
  const r = one(`
    select (select prosrc from pg_proc
             where pronamespace = 'public'::regnamespace
               and proname = 'mirror_company_identity') as body;`);
  const body = String(r.body ?? "");
  assert.ok(body.length > 100, "mirror_company_identity has no body to read");
  // Comments stripped, so the prose explaining the exclusion cannot satisfy a
  // check about the code.
  const code = body.replace(/^\s*--.*$/gm, "");
  assert.doesNotMatch(code, /'email'/,
    "the mirror now copies email -- companies.email is the customer-facing address and the settings copy is a separate field (F3); mirroring them replaces one with the other");
  assert.doesNotMatch(code, /license_number/,
    "the mirror now touches license_number, which exists only in the settings blob -- there is no column to keep it in step with");
  // And the two it SHOULD carry are both there, or check 3 is passing on a
  // mirror that only handles one of them.
  assert.match(code, /business_name/, "the mirror no longer carries the business name");
  assert.match(code, /phone/, "the mirror no longer carries the phone");
});
