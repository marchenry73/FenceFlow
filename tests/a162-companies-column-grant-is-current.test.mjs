/**
 * THE PER-COLUMN GRANT ON `companies` GOES STALE, SILENTLY, AND TAKES ALL
 * COMPANY EMAIL WITH IT.
 *
 * supabase_sec_company_reads.sql took the TABLE-level SELECT grant off
 * `authenticated` and put a per-column grant back, built from
 * information_schema at the moment it ran, minus five admin/billing columns.
 * Its own comment says the list is built live "so a column added to companies
 * tomorrow is included automatically". That is true of the FILE and not of the
 * DATABASE: the grant is computed once, when the file runs, and every column
 * added afterwards is ungranted for ever unless somebody re-runs it.
 *
 * Three had accumulated by 19 Oct -- logo_path, signup_sent_at,
 * welcome_sent_at -- and logo_path is the one that bit. mailCaller(), the gate
 * EVERY company-email call goes through, reads the company row as the caller:
 *
 *     userClient.from("companies").select("name, email, logo_path")
 *
 * Postgres refuses the WHOLE statement for one ungranted column, and
 * caller.ts turns any failure of that read into "Something went wrong on
 * FenceFlow's side" -- with no mention of a column, a grant or a permission.
 * Blast radius: every company email. The phone's "Email the quote", the
 * office's compose window, every reply. And because mail_ingest never ran,
 * there was no mail_messages row either, so the Sent list was EMPTY -- which
 * reads as "nothing was attempted" rather than as a failure.
 *
 * supabase_r19_company_column_grants.sql repaired it on 19 Oct and says, in
 * its own header, that it will happen again: it is the same one-shot snapshot
 * it was written to fix. THIS FILE IS THE PART THAT DOES NOT GO STALE. It
 * compares the live column list against the live grant list on every run, so
 * the next column added to `companies` turns a silent, total email outage into
 * a red test naming the column.
 *
 * It reads the database and writes nothing.
 *
 *     node --test tests/a162-companies-column-grant-is-current.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT = 'newcrgafcptspmapacrx';

/** The five columns deliberately withheld from `authenticated`. */
const EXCLUDED = ['admin_notes', 'leads_token', 'stripe_customer_id',
                  'stripe_subscription_id', 'stripe_account_id'];

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'a162-grant-'));
  const file = join(dir, 'q.sql');
  writeFileSync(file, sql, 'utf8');
  const r = spawnSync('npx', ['--no-install', 'supabase@2.115.0', 'db', 'query',
    '--linked', '--project-ref', PROJECT, '-f', file, '--output', 'json'],
    { encoding: 'utf8', shell: process.platform === 'win32', timeout: 180_000 });
  // The RAW status before trusting a parse: an error response that still
  // prints a header reads exactly like an empty-but-ok result, and that has
  // cost this project a wrong conclusion more than once.
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

/** Column names of `companies`, and which of them `authenticated` may SELECT. */
function columnsAndGrants() {
  const rows = runSql(`
    select c.column_name,
           exists (select 1 from information_schema.column_privileges g
                    where g.table_schema='public' and g.table_name='companies'
                      and g.privilege_type='SELECT' and g.grantee='authenticated'
                      and g.column_name = c.column_name) as granted
      from information_schema.columns c
     where c.table_schema='public' and c.table_name='companies'
     order by c.column_name;`);
  return rows.map(r => ({ name: r.column_name, granted: r.granted === true || r.granted === 't' }));
}

test('CANARY: the column list came back at all, and is a real table', () => {
  // Without this, every assertion below passes on an empty answer -- which is
  // exactly the shape a failed query takes here.
  const cols = columnsAndGrants();
  assert.ok(cols.length >= 10,
    `companies reports only ${cols.length} columns; the query did not really run`);
  for (const must of ['id', 'name', 'phone', 'license_no', 'email']) {
    assert.ok(cols.some(c => c.name === must), `companies has no ${must} column -- wrong table?`);
  }
});

test('every column authenticated is meant to read is actually granted', () => {
  const cols = columnsAndGrants();
  const missing = cols.filter(c => !EXCLUDED.includes(c.name) && !c.granted).map(c => c.name);
  assert.deepStrictEqual(missing, [],
    'these columns of `companies` exist but are NOT granted to authenticated:\n  ' +
    missing.join(', ') + '\n' +
    'Postgres refuses the WHOLE select for one ungranted column, so any read ' +
    'naming one of these fails entirely -- and mailCaller() names three of ' +
    'them on every company email. Re-run supabase_r19_company_column_grants.sql.');
});

test('CANARY: the grant check can fail -- the five withheld columns are withheld', () => {
  // The same comparison, run against a list that MUST come back non-empty. If
  // this ever reads empty, `granted` is true for everything and the test above
  // is passing because it cannot distinguish, not because the grant is right.
  const cols = columnsAndGrants();
  const present = cols.filter(c => EXCLUDED.includes(c.name)).map(c => c.name);
  assert.ok(present.length >= 3,
    `expected the withheld columns to exist on companies, found ${present.length}`);
  const leaked = cols.filter(c => EXCLUDED.includes(c.name) && c.granted).map(c => c.name);
  assert.deepStrictEqual(leaked, [],
    'admin/billing columns are readable by every signed-in user: ' + leaked.join(', '));
});

test('the columns mailCaller() names are readable, because it reads all three at once', () => {
  // Named individually rather than left to the sweep above: these three are
  // the ones whose absence takes every company email down, and saying so here
  // means the failure message points at the outage rather than at a column.
  const cols = columnsAndGrants();
  for (const need of ['name', 'email', 'logo_path']) {
    const col = cols.find(c => c.name === need);
    assert.ok(col, `companies.${need} is gone -- mailCaller() selects it by name`);
    assert.ok(col.granted,
      `companies.${need} is not granted to authenticated, so EVERY company ` +
      'email fails with "Something went wrong on FenceFlow\'s side"');
  }
});
