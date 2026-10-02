// a55 -- THE MIGRATION (supabase_a55_approval_emails.sql), read, not run.
//
// Run with:  node --test tests/a55-approval-email-migration.test.mjs
//
// The file is written UNAPPLIED: this project's database is the owner's and
// nothing here may touch it. So this test reads the SQL and holds it to what
// the functions rely on and to the rules the schema is built on:
//
//   - it adds ONE table and alters nothing that exists (no jobs column: jobs is
//     the offline-sync table, and a bookkeeping column there moves the sync
//     clock -- the file says why in its header);
//   - the claim is a database guarantee: unique on (company, job, contract key);
//   - the states, languages and value limits the functions write are the ones
//     the CHECK constraints accept -- a state the table refuses would turn every
//     "could not send" into "could not even say so";
//   - nobody but the backend can write it, nobody can read it without being a
//     member of the company who may see customer contact, and it carries no
//     money -- crew never see money;
//   - the public schema's default grants (everything, to anon and
//     authenticated, on every new table) are revoked, not left to row security
//     alone.
//
// Each rule is checked by a function that is then run on deliberately broken
// copies of the file (PLANTED), so a check that could never fail would be seen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LANGS } from "../supabase/functions/quote-approval-email/email.ts";

const SQL_PATH = new URL("../supabase_a55_approval_emails.sql", import.meta.url);
const SQL = readFileSync(SQL_PATH, "utf8");
const INDEX = readFileSync(new URL("../supabase/functions/quote-approval-email/index.ts", import.meta.url), "utf8");

/** The SQL without comments, one statement per element, whitespace collapsed. */
const statements = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")
    .split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);

const TABLE = "public.quote_approval_emails";

/** Everything the migration must satisfy; returns the list of problems (empty = clean). */
function problems(sql) {
  const out = [];
  const stmts = statements(sql);
  const lower = stmts.map((s) => s.toLowerCase());
  const find = (re) => lower.filter((s) => re.test(s));

  // 1. One table, nothing else altered or removed.
  const creates = find(/^create table/);
  if (creates.length !== 1 || !creates[0].startsWith(`create table if not exists ${TABLE} `)) out.push("must create exactly one table, public.quote_approval_emails, with if not exists");
  for (const s of lower) {
    if (/^(drop table|drop column|truncate|delete from|update |insert into)/.test(s)) out.push(`destructive or data-changing statement: ${s.slice(0, 60)}`);
    if (/^alter table/.test(s) && !new RegExp(`^alter table ${TABLE.replace(".", "\\.")} enable row level security$`).test(s)) out.push(`alters something: ${s.slice(0, 80)}`);
    if (/\bjobs\b/.test(s) && !/job_sync_id/.test(s)) out.push(`touches jobs: ${s.slice(0, 80)}`);
  }
  const allowed = /^(create table if not exists|create index if not exists|alter table public\.quote_approval_emails enable row level security|revoke all on public\.quote_approval_emails|grant (select, insert, update, delete|select) on public\.quote_approval_emails|drop policy if exists quote_approval_emails_read|create policy quote_approval_emails_read|comment on table public\.quote_approval_emails|select 'quote_approval_emails installed')/;
  for (const s of lower) if (!allowed.test(s)) out.push(`a statement this migration is not meant to contain: ${s.slice(0, 80)}`);

  const table = creates[0] ?? "";
  // 2. The claim.
  if (!/unique \(company_id, job_sync_id, contract_key\)/.test(table)) out.push("no unique (company_id, job_sync_id, contract_key): the once-guard is gone");
  if (!/company_id uuid not null references public\.companies\(id\) on delete cascade/.test(table)) out.push("company_id must reference companies and be not null");
  if (/job_sync_id uuid not null references/.test(table)) out.push("job_sync_id must not be a foreign key: the record of an email must outlive the job");
  if (!/contract_key text not null check \(contract_key ~ '\^\[0-9a-f\]\{64\}\$'\)/.test(table)) out.push("contract_key must be a sha256 hex string, not null");
  // 3. No money in it.
  for (const col of ["total", "deposit", "amount", "price", "cost", "balance", "materials"]) {
    if (new RegExp(`\\b${col}\\w*\\s+(numeric|integer|bigint|double|real|money|text)`).test(table.replace(/contract_key/g, ""))) out.push(`a ${col} column: this table must carry no money`);
  }
  // 4. Access.
  if (!find(/^alter table public\.quote_approval_emails enable row level security$/).length) out.push("row level security is not enabled");
  const revoke = find(/^revoke all on public\.quote_approval_emails from/);
  if (revoke.length !== 1 || !/from public, anon, authenticated$/.test(revoke[0])) out.push("must revoke all from public, anon, authenticated (the schema's default grants hand them everything)");
  const grants = find(/^grant /);
  for (const g of grants) {
    if (/ to (anon|public)\b/.test(g)) out.push(`grants to anon/public: ${g}`);
    if (/ to authenticated$/.test(g) && !/^grant select on /.test(g)) out.push(`grants more than select to authenticated: ${g}`);
  }
  if (!grants.some((g) => /^grant select, insert, update, delete on .* to service_role$/.test(g))) out.push("the backend (service_role) is not granted the table");
  if (!grants.some((g) => /^grant select on .* to authenticated$/.test(g))) out.push("signed-in members cannot read it");
  const policies = find(/^create policy/);
  if (policies.length !== 1) out.push(`expected exactly one policy, found ${policies.length}`);
  for (const p of policies) {
    if (!/ for select to authenticated /.test(p)) out.push("the policy must be select-only, to authenticated");
    if (!/company_id = \(select public\.current_company_id\(\)\)/.test(p)) out.push("the policy must be scoped to the caller's own company");
    if (!/\(select public\.has_permission\('see_customer_contact'\)\)/.test(p)) out.push("the policy must require SEE_CUSTOMER_CONTACT");
    if (/using \(\s*true\s*\)/.test(p) || /\bor true\b/.test(p)) out.push("a wide-open policy");
  }
  if (find(/^create policy .* for (insert|update|delete|all)/).length) out.push("a write policy: only the backend writes this table");
  return out;
}

test("the migration is clean: one table, a real once-guard, no money, read by members who may see customer contact, written only by the backend", () => {
  assert.deepEqual(problems(SQL), []);
  // The file says plainly, at the top, that it is not applied and why it is not a jobs column.
  assert.match(SQL, /NOT APPLIED/);
  assert.match(SQL, /NO COLUMN IS ADDED TO jobs/);
  assert.match(SQL, /ORDER \(nothing here is applied by the code/);
});

test("PLANTED: each rule above fails on a copy of the file that breaks it", () => {
  const mutants = {
    "no unique key": SQL.replace("unique (company_id, job_sync_id, contract_key)", "unique (id)"),
    "no revoke": SQL.replace("revoke all on public.quote_approval_emails from public, anon, authenticated;", ""),
    "revoke leaves anon": SQL.replace("from public, anon, authenticated;", "from public, authenticated;"),
    "authenticated may write": SQL.replace("grant select on public.quote_approval_emails to authenticated;", "grant select, insert, update, delete on public.quote_approval_emails to authenticated;"),
    "anon may read": SQL.replace("grant select on public.quote_approval_emails to authenticated;", "grant select on public.quote_approval_emails to authenticated;\ngrant select on public.quote_approval_emails to anon;"),
    "no row level security": SQL.replace("alter table public.quote_approval_emails enable row level security;", ""),
    "a write policy": SQL + "\ncreate policy quote_approval_emails_write on public.quote_approval_emails for update to authenticated using (true);\n",
    "an open read policy": SQL.replace("company_id = (select public.current_company_id())\n        and (select public.has_permission('SEE_CUSTOMER_CONTACT'))", "true"),
    "any member reads it": SQL.replace("(select public.has_permission('SEE_CUSTOMER_CONTACT'))", "true"),
    "a jobs column": SQL + "\nalter table public.jobs add column approval_email_sent_at timestamptz;\n",
    "a money column": SQL.replace("    lang                 text", "    deposit_amount       numeric,\n    lang                 text"),
    "job_sync_id is a foreign key": SQL.replace("job_sync_id          uuid not null,", "job_sync_id          uuid not null references public.jobs(sync_id),"),
    "destructive": SQL + "\ndelete from public.jobs where true;\n",
    "a second table": SQL + "\ncreate table if not exists public.other_thing (id uuid);\n",
  };
  for (const [name, sql] of Object.entries(mutants)) {
    assert.notEqual(sql, SQL, `the mutant "${name}" did not change the file`);
    assert.ok(problems(sql).length > 0, `not caught: ${name}`);
  }
});

test("the table accepts every state, language and value the functions write -- and the states are the same set", () => {
  const table = statements(SQL).find((s) => /^create table/i.test(s)) ?? "";
  const listOf = (re) => (re.exec(table)?.[1] ?? "").split(",").map((x) => x.trim().replace(/^'|'$/g, "")).filter(Boolean);
  const sqlStates = listOf(/state text not null check \(state in \(([^)]*)\)\)/).sort();
  // The TypeScript union the sender writes.
  const union = /export type LedgerState = ([^;]+);/.exec(INDEX)?.[1] ?? "";
  const tsStates = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(sqlStates, ["failed", "no_address", "not_priced", "sending", "sent", "unconfirmed"]);
  assert.deepEqual(tsStates, sqlStates, "the sender's states and the table's CHECK have drifted");
  // Every state a TypeScript outcome constant uses is one of them.
  const outcomes = [...INDEX.matchAll(/const [A-Z_]+: Outcome = \{\s*state: "([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(outcomes.length >= 7, "found the sender's outcome constants");
  for (const s of outcomes) assert.ok(sqlStates.includes(s), `the sender writes state "${s}", which the table refuses`);
  // Languages.
  assert.deepEqual(listOf(/lang text check \(lang is null or lang in \(([^)]*)\)\)/).sort(), [...LANGS].sort());
  // The limits: a reason is a sentence of at most 300 characters; a code is a short slug; an address at most 254.
  assert.match(table, /reason text check \(reason is null or length\(reason\) <= 300\)/);
  assert.match(table, /reason_code text check \(reason_code is null or reason_code ~ '\^\[a-z0-9_\]\{1,60\}\$'\)/);
  assert.match(table, /sent_to text check \(sent_to is null or length\(sent_to\) <= 254\)/);
  // Every reason_code the sender writes fits the slug pattern, and every fixed sentence fits 300.
  for (const m of INDEX.matchAll(/\bcode: "([^"]+)"/g)) assert.match(m[1], /^[a-z0-9_]{1,60}$/, m[1]);
  for (const m of INDEX.matchAll(/^\s+reason: ((?:\n\s+)?"[^"]+"),?$/gm)) assert.ok(JSON.parse(m[1].trim()).length <= 300, m[1]);
});

test("the columns the functions write are columns of the table", () => {
  const table = statements(SQL).find((s) => /^create table/i.test(s)) ?? "";
  const cols = new Set([...table.matchAll(/(?:\(|,)\s*([a-z_]+) (?:uuid|text|timestamptz)\b/g)].map((m) => m[1]));
  for (const c of ["id", "company_id", "job_sync_id", "contract_key", "state", "reason_code", "reason", "sent_to", "mail_message_id", "provider_message_id", "lang", "attempted_at", "settled_at"]) {
    assert.ok(cols.has(c), `the table has no column ${c}`);
  }
  // The sender's claim row and its settle patches name nothing else.
  const claimKeys = [...(/claimLedger\(db, \{([\s\S]*?)\n\s*\}\);/.exec(INDEX)?.[1] ?? "").matchAll(/^\s+(\w+)[:,]/gm)].map((m) => m[1]);
  assert.ok(claimKeys.length >= 8, "found the claim row in index.ts");
  for (const k of claimKeys) assert.ok(cols.has(k), `the claim writes ${k}, which the table does not have`);
  const settleKeys = [...INDEX.matchAll(/settleLedger\(db, deps, ledgerId, \{([^}]*)\}\)/g)].flatMap((m) => [...m[1].matchAll(/(\w+):/g)].map((x) => x[1]));
  assert.ok(settleKeys.length >= 4, "found the settle patches in index.ts");
  for (const k of settleKeys) assert.ok(cols.has(k), `a settle writes ${k}, which the table does not have`);
  const qv = readFileSync(new URL("../supabase/functions/quote-view/index.ts", import.meta.url), "utf8");
  const qvInsert = /from\("quote_approval_emails"\)\.insert\(\{([\s\S]*?)\}\);/.exec(qv)?.[1] ?? "";
  const qvKeys = [...qvInsert.matchAll(/(\w+):/g)].map((m) => m[1]);
  assert.ok(qvKeys.length >= 6, "found quote-view's insert");
  for (const k of qvKeys) assert.ok(cols.has(k), `quote-view writes ${k}, which the table does not have`);
});

test("the readers: the claim's unique key is what the functions rely on, and the table is the only new object", () => {
  assert.equal(statements(SQL).filter((s) => /^create (table|function|trigger|view)/i.test(s)).length, 1);
  assert.ok(!/create or replace function|create trigger|create view/i.test(statements(SQL).join(";")), "no function, trigger or view: nothing else can change behaviour");
  assert.match(INDEX, /error\.code === "23505"/, "the sender reads a unique violation as 'someone else has this contract'");
});
