/**
 * THE FIRST SETTINGS SAVE MUST REACH THE COMPANY RECORD.
 *
 * save_company_settings() is an upsert, so for a company with no
 * company_settings row the first save is an INSERT. Both identity mirrors
 * were AFTER UPDATE only, so that first save never reached companies.name /
 * .phone / .license_no -- the office said "Saved", the blob was right, and
 * every reader outside the phone kept whatever onboarding had left. The
 * SECOND save is an UPDATE and did mirror, so the symptom was "it worked the
 * time after", which is about the worst shape a bug can have for anyone
 * trying to report it.
 *
 * MEASURED 6 Nov 2026, which is why this was worth a migration: 10 of 12
 * companies had no company_settings row at all, so ten first-saves were
 * waiting to be lost. supabase_r70_first_settings_save_mirrors_too.sql adds
 * INSERT to the settings-side trigger and touches nothing else.
 *
 * WHY THIS IS A LIVE CHECK AND NOT A FILE CHECK. The defect was never in a
 * function body -- the mirror's settings branch always worked on INSERT, it
 * was simply never called. Only the deployed trigger definition can answer
 * whether it is called, so reading the .sql file would prove nothing about
 * the database. The behaviour itself was proved against the live project
 * inside BEGIN/ROLLBACK, with a positive control that put the trigger back to
 * UPDATE-only and confirmed the same save then did NOT propagate.
 *
 * Reads the database, writes nothing.
 *
 *     node --test tests/a163-first-settings-save-mirrors.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT = 'newcrgafcptspmapacrx';

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'a163-mirror-'));
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

const triggers = () => {
  const rows = runSql(`
    select tgname, pg_get_triggerdef(oid) as def from pg_trigger
     where tgname in ('company_settings_mirror_identity','companies_mirror_identity');`);
  return Object.fromEntries(rows.map(r => [r.tgname, r.def]));
};

test('CANARY: both identity triggers exist at all', () => {
  // Every assertion below is about the TEXT of a definition. If a name
  // changed, `undefined` would fail the regex tests for the right-looking
  // reason and hide the fact that the mirror is simply gone.
  const t = triggers();
  assert.ok(t.company_settings_mirror_identity,
    'company_settings_mirror_identity is missing -- the settings side does not mirror at all');
  assert.ok(t.companies_mirror_identity,
    'companies_mirror_identity is missing -- the companies side does not mirror at all');
});

test('the settings mirror fires on INSERT, so the FIRST save counts', () => {
  const def = triggers().company_settings_mirror_identity;
  assert.match(def, /INSERT/i,
    'the settings mirror is UPDATE-only again: a company saving Settings for ' +
    'the first time silently leaves companies.name/.phone/.license_no stale, ' +
    'and the second save hides it by working');
});

test('and still fires on UPDATE, so every save after the first counts too', () => {
  // The obvious way to break this while fixing it: swap UPDATE for INSERT
  // instead of adding it.
  const def = triggers().company_settings_mirror_identity;
  assert.match(def, /UPDATE OF settings/i,
    'the settings mirror no longer fires on UPDATE -- now every save after ' +
    'the first is the one that is lost');
});

test('r69 is still in place underneath: the companies side carries the licence', () => {
  // r70 recreates this trigger. If it ever recreates it from a pre-r69 copy,
  // the licence silently stops mirroring and nothing else here would notice.
  const def = triggers().companies_mirror_identity;
  assert.match(def, /UPDATE OF name, phone, license_no/i,
    'companies_mirror_identity lost license_no -- a licence-only write no ' +
    'longer reaches the settings blob');
});

test('the mirror function itself still carries the licence both ways', () => {
  // A trigger pointing at a mirror that no longer moves the licence would
  // satisfy every check above.
  const [row] = runSql(`
    select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.proname='mirror_company_identity';`);
  assert.ok(row && row.prosrc, 'mirror_company_identity is gone');
  assert.match(row.prosrc, /update companies set license_no = btrim\(s_license\)/,
    'the mirror no longer pushes the blob licence into companies.license_no');
  assert.match(row.prosrc, /jsonb_build_object\('license_number', btrim\(new\.license_no\)\)/,
    'the mirror no longer pushes companies.license_no into the blob');
});
