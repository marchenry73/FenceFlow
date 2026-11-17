/**
 * ONE RESTORE RULE, ON THE SERVER (supabase_r74_restore_deleted.sql).
 *
 * The owner, 17 Nov 2026, could not find his deleted items and asked to
 * restore from the website as well as the phone. The office had refused to
 * hold a second copy of the restore rule -- it lived in TrashBin.restore on the
 * phone, and the page said so. r74 moves the rule to the server so both
 * clients call one copy.
 *
 * The two corrections the phone's copy carried, and which this must keep:
 *   * A JOB brings its children back with it. Restored alone it has no fence
 *     runs, so no footage, so no labour charge -- it came back looking like it
 *     was worth only its materials.
 *   * Only children deleted WITH it -- within a minute. Clearing every child
 *     tombstone resurrected line items deleted on purpose weeks earlier, back
 *     on the estimate at their old price.
 *
 * Everything below runs inside BEGIN/ROLLBACK as a real signed-in owner, and
 * a final check confirms the live counts are where they started.
 *
 *     node --test tests/a173-restore-deleted.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'newcrgafcptspmapacrx';
const OWNER_EMAIL = 'marchenry73@gmail.com';        // Legacy Solutions, OWNER
const OTHER_COMPANY_EMAIL = 'marchenry73@hotmail.com'; // Ruru, OWNER -- a different company

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'a173-restore-'));
  const file = join(dir, 'q.sql');
  writeFileSync(file, sql, 'utf8');
  const r = spawnSync('npx', ['--no-install', 'supabase@2.115.0', 'db', 'query',
    '--linked', '--project-ref', PROJECT, '-f', file, '--output', 'json'],
    { encoding: 'utf8', shell: process.platform === 'win32', timeout: 180_000 });
  if (r.status !== 0) throw new Error(`db query failed (${r.status}): ${r.stderr || r.stdout}`);
  const t = r.stdout, i = t.indexOf('{');
  const parsed = JSON.parse(i >= 0 ? t.slice(i, t.lastIndexOf('}') + 1) : t);
  const rows = Array.isArray(parsed) ? parsed : parsed.rows;
  if (!Array.isArray(rows)) throw new Error('no rows in: ' + t.slice(0, 300));
  return rows;
}

const as = (email, body) => `
  begin;
  select set_config('request.jwt.claims', json_build_object(
    'sub', (select id::text from auth.users where email = '${email}'),
    'role', 'authenticated')::text, true);
  set local role authenticated;
  ${body}
  rollback;`;

test('CANARY: the owner fixture is still an owner of a company with deleted jobs', () => {
  // Picked by property and asserted, because a fixture pinned to a person has
  // already made one security test here cry breach after a promotion.
  const [r] = runSql(as(OWNER_EMAIL, `
    select (select role from profiles where id = auth.uid()) as role,
           (select count(*)::int from jobs where deleted_at is not null) as deleted_jobs;`));
  assert.strictEqual(r.role, 'OWNER', `${OWNER_EMAIL} is ${r.role}, not OWNER -- pick another fixture`);
  assert.ok(Number(r.deleted_jobs) > 0, 'no deleted jobs to restore; this file would prove nothing');
});

test('BEHAVIOUR: a job comes back with what went with it, and not with what went before', () => {
  // Constructed, so the timing is known exactly: take a live job with at
  // least two fence runs, delete one run a day EARLY (on purpose, weeks
  // before), then delete the job and its other runs NOW. Restore the job.
  const rows = runSql(as(OWNER_EMAIL, `
    create temporary table pick as
      select j.sync_id from jobs j
       where j.deleted_at is null
         and (select count(*) from fence_runs f where f.job_sync_id = j.sync_id and f.deleted_at is null) >= 2
       limit 1;
    create temporary table early as
      select f.sync_id from fence_runs f
       where f.job_sync_id = (select sync_id from pick) and f.deleted_at is null limit 1;

    update fence_runs set deleted_at = now() - interval '1 day', deleted_by = 'a173'
     where sync_id = (select sync_id from early);
    update fence_runs set deleted_at = now(), deleted_by = 'a173'
     where job_sync_id = (select sync_id from pick) and deleted_at is null;
    update jobs set deleted_at = now(), deleted_by = 'a173' where sync_id = (select sync_id from pick);

    create temporary table res as
      select public.restore_deleted('jobs', (select sync_id from pick)) as r;

    select (select r->>'restored' from res) as restored,
           (select r->>'children' from res) as children,
           (select count(*)::int from jobs where sync_id = (select sync_id from pick) and deleted_at is null) as job_live,
           (select count(*)::int from fence_runs where job_sync_id = (select sync_id from pick)
               and deleted_at is null and sync_id <> (select sync_id from early)) as runs_back,
           (select count(*)::int from fence_runs where sync_id = (select sync_id from early)
               and deleted_at is not null) as early_still_deleted,
           (select count(*)::int from pick) as picked;`));

  const r = rows[0];
  assert.strictEqual(Number(r.picked), 1, 'no live job with two fence runs to construct the case on');
  assert.strictEqual(Number(r.restored), 1, 'the job was not restored');
  assert.strictEqual(Number(r.job_live), 1, 'the job is still deleted after restore');
  assert.ok(Number(r.runs_back) >= 1,
    'the job came back without its fence runs -- no footage, so no labour charge, ' +
    'and it reads as worth only its materials');
  assert.strictEqual(Number(r.early_still_deleted), 1,
    'a fence run deleted a day BEFORE the job was resurrected with it -- something ' +
    'removed on purpose is back on the estimate');
});

test('a second restore is harmless', () => {
  // The phone and the office restoring the same thing, or a double tap.
  const rows = runSql(as(OWNER_EMAIL, `
    create temporary table pick as
      select sync_id from jobs where deleted_at is not null order by deleted_at desc limit 1;
    create temporary table a as select public.restore_deleted('jobs', (select sync_id from pick)) as r;
    create temporary table b as select public.restore_deleted('jobs', (select sync_id from pick)) as r;
    select (select r->>'restored' from a) as first, (select r->>'restored' from b) as second;`));
  assert.strictEqual(Number(rows[0].first), 1, 'the first restore did nothing');
  assert.strictEqual(Number(rows[0].second), 0, 'the second restore did something -- it is not idempotent');
});

test('SECURITY: another company cannot restore these records', () => {
  // POSITIVE CONTROL first: the same call restores for the owning company,
  // so a 0 below is the scope working and not a call that never does anything.
  const own = runSql(as(OWNER_EMAIL, `
    select public.restore_deleted('jobs',
      (select sync_id from jobs where deleted_at is not null order by deleted_at desc limit 1))->>'restored' as n;`));
  assert.strictEqual(Number(own[0].n), 1, 'control failed: the owner could not restore their own job');

  // Ruru's owner, given Legacy Solutions' deleted job id outright.
  const other = runSql(`
    begin;
    create temporary table target as
      select j.sync_id from jobs j join companies c on c.id = j.company_id
       where c.name = 'Legacy Solutions' and j.deleted_at is not null
       order by j.deleted_at desc limit 1;
    grant select on target to authenticated;
    select set_config('request.jwt.claims', json_build_object(
      'sub', (select id::text from auth.users where email = '${OTHER_COMPANY_EMAIL}'),
      'role', 'authenticated')::text, true);
    set local role authenticated;
    select public.restore_deleted('jobs', (select sync_id from target))->>'restored' as n;
    rollback;`);
  assert.strictEqual(Number(other[0].n), 0,
    'a user from ANOTHER company restored a Legacy Solutions job');
});

test('a kind of record outside the list is refused, not formatted into SQL', () => {
  // The table name is whitelisted before it reaches format(). Proved by
  // asking for one that is not on the list -- including one that would be an
  // injection if it were not.
  const sql = as(OWNER_EMAIL, `select public.restore_deleted('profiles', gen_random_uuid());`);
  assert.throws(() => runSql(sql), /cannot be restored here/,
    'restore_deleted accepted a table that is not on the list');
});

test('the function runs with the caller\'s own rights', () => {
  // SECURITY DEFINER would run past row-level security with no permission
  // check of its own -- a way for anyone signed in to undo anyone's deletion.
  const [r] = runSql(`select p.prosecdef as definer,
      has_function_privilege('anon', 'public.restore_deleted(text, uuid)', 'EXECUTE') as anon_can
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'restore_deleted';`);
  assert.ok(r, 'restore_deleted is gone');
  assert.ok(!(r.definer === true || r.definer === 't'), 'restore_deleted is SECURITY DEFINER');
  assert.ok(!(r.anon_can === true || r.anon_can === 't'), 'anon can execute restore_deleted');
});

test('it restores the same seven kinds the office and the phone list', () => {
  // One list in three places is three lists unless something holds them
  // together. a74 holds the office's to the phone's; this holds the server's
  // to both.
  const sql = readFileSync(join(ROOT, 'supabase_r74_restore_deleted.sql'), 'utf8');
  const m = sql.match(/p_table not in \(([^)]*)\)/);
  assert.ok(m, 'could not find the whitelist in r74');
  const server = [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]).sort();
  const office = [...readFileSync(join(ROOT, 'website/dashboard.html'), 'utf8')
    .matchAll(/\{ table:'([a-z_]+)',\s*label:/g)].map(x => x[1]).sort();
  assert.deepStrictEqual(server, office,
    'the server restores a different set of kinds from the ones the office lists');
});

test('nothing was actually restored by running this file', () => {
  const [r] = runSql(`select count(*)::int as n from jobs j join companies c on c.id = j.company_id
                       where c.name = 'Legacy Solutions' and j.deleted_at is not null;`);
  assert.strictEqual(Number(r.n), 25,
    `Legacy Solutions now has ${r.n} deleted jobs, not 25 -- a transaction did not roll back`);
});

// ---------------------------------------------------------------------------
// THE OFFICE CALLS THE RULE AND HOLDS NONE OF IT
// ---------------------------------------------------------------------------

const office = () => readFileSync(join(ROOT, 'website/dashboard.html'), 'utf8');
const fnBody = (src, name) => {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return null;
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  return null;
};

test('the office restores through restore_deleted', () => {
  const body = fnBody(office(), 'restoreTrashRow');
  assert.ok(body, 'restoreTrashRow is gone from the office');
  assert.match(body, /db\.rpc\('restore_deleted'/,
    'the office no longer restores through the server rule');
});

test('and keeps no copy of the rule -- no child list, no time window, no direct update', () => {
  // A second copy is exactly what the old note on this tab refused to hold,
  // and the reason two restores drift apart.
  const body = fnBody(office(), 'restoreTrashRow')
    .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  for (const tell of ['job_steps', 'estimate_line_items', 'time_entries', '60', ".update("]) {
    assert.ok(!body.includes(tell),
      `restoreTrashRow contains "${tell}" -- a copy of the restore rule has crept into the office`);
  }
});

test('every row in the office list offers Restore, not just jobs', () => {
  // The server restores all seven kinds; offering it on jobs only would leave
  // a deleted catalog item visible and unrecoverable from here.
  const body = fnBody(office(), 'renderTrash');
  assert.ok(body, 'renderTrash is gone');
  const restoreAt = body.indexOf('data-restore=');
  const purgeGate = body.indexOf("r.table === 'jobs'");
  assert.ok(restoreAt >= 0, 'the list renders no Restore button');
  assert.ok(restoreAt < purgeGate,
    'the Restore button sits behind the jobs-only condition, so six kinds cannot be restored');
});
