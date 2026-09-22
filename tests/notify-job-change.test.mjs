/* Who a job push reaches, and what it says (notify-job-change).

   Until 2026-09-22 every job push -- "New job added: <customer>" and the
   accepted-quote push -- went to every device in the company, crew included,
   so a crew phone was told the customer names of jobs it is not allowed to
   open. The assignment push compared jobs.assigned_employee_id, a column
   nothing writes, so it could never fire. And the accepted push said "Job
   marked complete / was finished by the crew" on the day a quote was won.

   Two halves, like crew-job-scope.test.mjs.

   A. STATIC, pure: calls supabase/functions/_shared/job-push.ts the way
      notify-job-change/index.ts calls it, with the payload shape the live
      trigger sends (supabase_functions.http_request: type, table, record,
      old_record), and asserts on what comes back. The role table it copies
      from has_permission() is held to the SQL file that last defines
      has_permission in supabase/dev/apply-order.txt, and "who sees every
      job" to sees_all_jobs() in supabase_crew_job_scope.sql. A light
      structural check of index.ts follows. Each checker is proven by a
      planted failure: a broadcast audience, a drifted role table, and the
      previous index.ts from git must all be caught.

   B. LIVE, rolled back: the live has_permission() body is copied into a
      pg_temp function that reads made-up (role, overrides) pairs instead of
      the caller's profile, evaluated for every role x override x permission
      inside a transaction that is rolled back, and compared with
      permissionFor(). Nothing is read from any real profile and nothing
      survives. A drifted copy of the table must disagree with it.

   node tests/notify-job-change.test.mjs            (both halves)
   node tests/notify-job-change.test.mjs --static   (A only; no network)
   (Node 24 strips the TypeScript types itself.) */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ROLE_PERMISSIONS,
  SEES_ALL_JOBS_PERMISSIONS,
  jobPushAudience,
  jobPushEvent,
  jobPushMessage,
  permissionFor,
  seesAllJobs,
  syncIdOf,
} from '../supabase/functions/_shared/job-push.ts';

const ROOT = process.cwd();
const PROJECT = 'newcrgafcptspmapacrx';
const STATIC_ONLY = process.argv.includes('--static');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++;
  else { fail++; console.log('FAIL  ' + label + (detail ? ' -- ' + detail : '')); }
};

/** Source with // and block comments removed, so prose cannot satisfy a check. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ---------------------------------------------------------------------------
// A1. The role table is has_permission's, not a guess
// ---------------------------------------------------------------------------

/** The has_permission body from the file that defines it LAST in apply order. */
function lastHasPermissionSql() {
  const order = readFileSync(join(ROOT, 'supabase/dev/apply-order.txt'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  let found = null;
  for (const f of order) {
    const path = join(ROOT, f);
    if (!existsSync(path)) continue;
    const sql = readFileSync(path, 'utf8');
    const at = sql.search(/create or replace function public\.has_permission\(perm text\)/i);
    if (at < 0) continue;
    const end = sql.indexOf('$$;', at);
    found = { file: f, body: sql.slice(at, end) };
  }
  return found;
}

/** role -> 'ALL' | sorted permissions, read out of a has_permission CASE. */
function roleTableFromSql(body) {
  const table = new Map();
  for (const m of body.matchAll(/when '([A-Z_]+)' then (true|perm in \(([^)]*)\))/g)) {
    table.set(m[1], m[2] === 'true' ? 'ALL' : [...m[3].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]).sort());
  }
  return table;
}

/** Every way two role tables disagree, as sentences. */
function tableDrift(sqlTable, tsTable) {
  const out = [];
  for (const role of new Set([...sqlTable.keys(), ...tsTable.keys()])) {
    const a = sqlTable.get(role);
    const bRaw = tsTable.get(role);
    const b = bRaw === 'ALL' || bRaw === undefined ? bRaw : [...bRaw].sort();
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push(`${role}: SQL ${JSON.stringify(a)} vs job-push.ts ${JSON.stringify(b)}`);
    }
  }
  return out;
}

{
  const src = lastHasPermissionSql();
  ok('found the file that last defines has_permission', !!src);
  if (src) {
    const sqlTable = roleTableFromSql(src.body);
    ok(`${src.file}: the CASE parsed to six roles`, sqlTable.size === 6, [...sqlTable.keys()].join(','));
    const drift = tableDrift(sqlTable, ROLE_PERMISSIONS);
    ok(`job-push.ts ROLE_PERMISSIONS matches ${src.file}`, drift.length === 0, drift.join(' | '));

    // Same order of tests: revoke, then grant, then the role.
    const minus = src.body.indexOf("position('-' || perm in");
    const plus = src.body.indexOf("position('+' || perm in");
    const role = src.body.indexOf('case (select role_text from me)');
    ok('has_permission still tests -PERM, then +PERM, then the role', minus > 0 && minus < plus && plus < role);

    // PLANTED: a foreman who lost SCHEDULE_AND_ASSIGN in SQL only.
    const plantedSql = roleTableFromSql(src.body.replace(
      /('FOREMAN' then perm in \(\s*)'SCHEDULE_AND_ASSIGN',\s*/, '$1'));
    ok('PLANTED: a role changed in SQL alone is caught', tableDrift(plantedSql, ROLE_PERMISSIONS).length === 1);
    // PLANTED: a role missing from the TypeScript copy.
    const noSales = new Map(ROLE_PERMISSIONS); noSales.delete('SALES');
    ok('PLANTED: a role missing from job-push.ts is caught', tableDrift(sqlTable, noSales).some((s) => s.startsWith('SALES')));
  }
}

// sees_all_jobs() in the crew-scope migration is the rule the phone's scope
// follows; the push must ask the same three permissions.
{
  const sql = readFileSync(join(ROOT, 'supabase_crew_job_scope.sql'), 'utf8');
  const at = sql.indexOf('create or replace function public.sees_all_jobs()');
  const body = at < 0 ? '' : sql.slice(at, sql.indexOf('$$;', sql.indexOf('as $$', at)));
  const perms = [...body.matchAll(/has_permission\('([A-Z_]+)'\)/g)].map((m) => m[1]).sort();
  ok('sees_all_jobs() found in supabase_crew_job_scope.sql', perms.length > 0);
  ok('SEES_ALL_JOBS_PERMISSIONS is exactly what sees_all_jobs() asks',
    JSON.stringify(perms) === JSON.stringify([...SEES_ALL_JOBS_PERMISSIONS].sort()), perms.join(','));
}

// ---------------------------------------------------------------------------
// A2. permissionFor / seesAllJobs
// ---------------------------------------------------------------------------
{
  const sees = (role, ov = '') => seesAllJobs({ id: 'x', role, permission_overrides: ov });
  for (const r of ['OWNER', 'MANAGER', 'SALES', 'ACCOUNTANT', 'FOREMAN']) ok(`${r} sees every job by default`, sees(r));
  ok('CREW does not see every job', !sees('CREW'));
  ok('CREW with +EDIT_JOBS sees every job', sees('CREW', '+EDIT_JOBS'));
  ok('FOREMAN with -SCHEDULE_AND_ASSIGN is scoped', !sees('FOREMAN', '-SCHEDULE_AND_ASSIGN'));
  ok('MANAGER with -SEE_MONEY still sees every job (EDIT_JOBS)', sees('MANAGER', '-SEE_MONEY'));
  ok('a grant and a revoke of the same permission: the revoke wins', !permissionFor('CREW', '+EDIT_JOBS,-EDIT_JOBS', 'EDIT_JOBS'));
  ok('an override with no sign does nothing', !permissionFor('CREW', 'EDIT_JOBS', 'EDIT_JOBS'));
  ok('substring, like position(): +SEE_MONEY_X grants SEE_MONEY', permissionFor('CREW', '+SEE_MONEY_X', 'SEE_MONEY'));
  ok('an unknown role holds nothing', !sees('SUPERVISOR'));
  ok('role names are case-sensitive, like the SQL CASE', !sees('owner'));
  ok('a null role holds nothing', !sees(null));
  ok('an Object.prototype name is not a role', !sees('constructor') && !sees('__proto__'));
  ok('null overrides read as none', permissionFor('OWNER', null, 'DELETE_RECORDS') && !permissionFor('CREW', null, 'SEE_MONEY'));
}

// ---------------------------------------------------------------------------
// A3. jobPushEvent, with the trigger's own payload shape
// ---------------------------------------------------------------------------
const E1 = '11111111-aaaa-4aaa-8aaa-000000000001';
const E2 = '11111111-aaaa-4aaa-8aaa-000000000002';
const JOB = '22222222-bbbb-4bbb-8bbb-000000000001';
const job = (over = {}) => ({
  id: 41, company_id: 'c0', sync_id: JOB, customer_name: 'Dana Smith', status: 'SENT',
  assigned_employee_sync_id: null, assigned_employee_id: null, ...over,
});
const insert = (rec) => ({ type: 'INSERT', table: 'jobs', schema: 'public', record: rec, old_record: null });
const update = (rec, old) => ({ type: 'UPDATE', table: 'jobs', schema: 'public', record: rec, old_record: old });
{
  const e = jobPushEvent(insert(job()));
  ok('INSERT: a new job', e?.kind === 'INSERT' && e.newLeadSyncId === '' && e.jobSyncId === JOB);
  ok('INSERT with a lead: that lead is new', jobPushEvent(insert(job({ assigned_employee_sync_id: E1 })))?.newLeadSyncId === E1);

  const acc = jobPushEvent(update(job({ status: 'ACCEPTED' }), job({ status: 'SENT' })));
  ok('SENT -> ACCEPTED: accepted', acc?.kind === 'ACCEPTED' && acc.customer === 'Dana Smith');
  ok('a full-row save of an accepted job is nothing',
    jobPushEvent(update(job({ status: 'ACCEPTED', assigned_employee_sync_id: E1 }), job({ status: 'ACCEPTED', assigned_employee_sync_id: E1 }))) === null);

  const asg = jobPushEvent(update(job({ assigned_employee_sync_id: E1 }), job({ assigned_employee_sync_id: '' })));
  ok("'' -> E1: assigned, E1 is the new lead", asg?.kind === 'ASSIGNED' && asg.newLeadSyncId === E1 && asg.leadSyncId === E1);
  ok('E1 -> E2: assigned to E2', jobPushEvent(update(job({ assigned_employee_sync_id: E2 }), job({ assigned_employee_sync_id: E1 })))?.newLeadSyncId === E2);
  ok('the same id in another case is not a change',
    jobPushEvent(update(job({ assigned_employee_sync_id: E1.toUpperCase() }), job({ assigned_employee_sync_id: E1 }))) === null);
  ok('taking the lead off tells nobody', jobPushEvent(update(job({ assigned_employee_sync_id: null }), job({ assigned_employee_sync_id: E1 }))) === null);
  ok('the dead uuid column changing is not an assignment',
    jobPushEvent(update(job({ assigned_employee_id: 'aaaaaaaa-0000-4000-8000-000000000009' }), job())) === null);
  ok('an UPDATE with no old_record is nothing (it cannot say what changed)',
    jobPushEvent({ type: 'UPDATE', table: 'jobs', record: job({ status: 'ACCEPTED', assigned_employee_sync_id: E1 }) }) === null);
  const both = jobPushEvent(update(job({ status: 'ACCEPTED', assigned_employee_sync_id: E1 }), job()));
  ok('accepted and assigned in one save: accepted, and E1 still counts as the new lead', both?.kind === 'ACCEPTED' && both.newLeadSyncId === E1);
  ok('syncIdOf trims and lower-cases, and only reads strings', syncIdOf(` ${E1.toUpperCase()} `) === E1 && syncIdOf(7) === '' && syncIdOf(null) === '');
}

// ---------------------------------------------------------------------------
// A4. The words
// ---------------------------------------------------------------------------
{
  const acc = jobPushEvent(update(job({ status: 'ACCEPTED' }), job()));
  const m = jobPushMessage(acc, false);
  ok('ACCEPTED is a won quote, not a finished job', m.title === 'Quote accepted' && m.body === 'Dana Smith accepted the quote.');
  ok('ACCEPTED never says complete or finished', !/complete|finished/i.test(m.title + m.body));
  const noName = jobPushMessage(jobPushEvent(update(job({ status: 'ACCEPTED', customer_name: '  ' }), job())), false);
  ok('ACCEPTED with no customer name still reads as a sentence', noName.body === 'A customer accepted a quote.');

  const asg = jobPushEvent(update(job({ assigned_employee_sync_id: E1 }), job()));
  ok('the office reads who changed', jobPushMessage(asg, false).body === 'Someone was assigned to Dana Smith.');
  ok('the new lead is told in the second person', jobPushMessage(asg, true).body === 'You were assigned to Dana Smith.');
  ok('INSERT keeps its words', jobPushMessage(jobPushEvent(insert(job())), false).title === 'New job added');
}

// ---------------------------------------------------------------------------
// A5. The audience
// ---------------------------------------------------------------------------
const P = (id, role, ov = '') => ({ id, role, permission_overrides: ov });
const profiles = [
  P('owner', 'OWNER'), P('manager', 'MANAGER'), P('sales', 'SALES'), P('accountant', 'ACCOUNTANT'),
  P('foreman', 'FOREMAN'),
  P('crew1', 'CREW'), P('crew2', 'CREW'), P('crewUnlinked', 'CREW'),
  P('crewInactive', 'CREW'), P('crewDeleted', 'CREW'),
  P('crewEditor', 'CREW', '+EDIT_JOBS'),
  P('scopedForeman', 'FOREMAN', '-SCHEDULE_AND_ASSIGN'),
];
const E_INACTIVE = '11111111-aaaa-4aaa-8aaa-000000000004';
const E_DELETED = '11111111-aaaa-4aaa-8aaa-000000000005';
const E_FOREMAN = '11111111-aaaa-4aaa-8aaa-000000000007';
const employees = [
  { sync_id: E1, profile_id: 'crew1', is_active: true, deleted_at: null },
  { sync_id: E2, profile_id: 'crew2', is_active: true, deleted_at: null },
  { sync_id: E_INACTIVE, profile_id: 'crewInactive', is_active: false, deleted_at: null },
  { sync_id: E_DELETED, profile_id: 'crewDeleted', is_active: true, deleted_at: '2026-09-01T00:00:00Z' },
  { sync_id: E_FOREMAN, profile_id: 'scopedForeman', is_active: true, deleted_at: null },
];
const SEE_ALL = ['accountant', 'crewEditor', 'foreman', 'manager', 'owner', 'sales'];
const ids = (m) => [...m.keys()].sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify([...b].sort());

/**
 * Everything wrong with an audience for a job whose people are `onJob`
 * (profile ids). The checker the planted broadcast below must trip.
 */
function audienceProblems(aud, onJob) {
  const out = [];
  const allowed = new Set([...SEE_ALL, ...onJob]);
  for (const id of aud.keys()) if (!allowed.has(id)) out.push(`${id} cannot see this job but would be told`);
  for (const id of SEE_ALL) if (!aud.has(id)) out.push(`${id} sees every job but would not be told`);
  return out;
}

function audienceChecks(audienceFn, label) {
  const results = [];
  const check = (name, cond, detail) => results.push({ name: `${label}: ${name}`, cond, detail });
  const run = (rec, crewSyncIds, emps = employees, payload = null) =>
    audienceFn({ event: jobPushEvent(payload ?? insert(rec)), profiles, employees: emps, crewSyncIds });

  let a = run(job(), null);
  let p = audienceProblems(a, []);
  check('a new unassigned job reaches exactly the see-all users', p.length === 0, p.join(' | '));

  a = run(job({ assigned_employee_sync_id: E1 }), []);
  p = audienceProblems(a, ['crew1']);
  check("the lead's login is told, no other crew", p.length === 0 && a.has('crew1'), p.join(' | '));

  a = run(job({ assigned_employee_sync_id: E1 }), [E2]);
  p = audienceProblems(a, ['crew1', 'crew2']);
  check('extra crew on an open job_assignments row are told', p.length === 0 && a.has('crew2'), p.join(' | '));

  a = run(job({ assigned_employee_sync_id: E1 }), null);
  p = audienceProblems(a, ['crew1']);
  check('job_assignments unreadable: the lead still, no extra crew, nobody else', p.length === 0 && a.has('crew1'), p.join(' | '));

  a = run(job({ assigned_employee_sync_id: E1 }), [E2], null);
  p = audienceProblems(a, []);
  check('employees unreadable: see-all users only', p.length === 0, p.join(' | '));

  a = run(job({ assigned_employee_sync_id: E_INACTIVE }), [E_DELETED]);
  p = audienceProblems(a, []);
  check('a switched-off or deleted crew record is not told', p.length === 0, p.join(' | '));

  a = run(job({ assigned_employee_sync_id: E1.toUpperCase() }), []);
  check('a lead id in another case still finds its login', a.has('crew1'));

  a = run(job(), []);
  check('a foreman with -SCHEDULE_AND_ASSIGN is scoped like crew', !a.has('scopedForeman'));
  a = run(job({ assigned_employee_sync_id: E_FOREMAN }), []);
  check('... and told about the job they lead', a.has('scopedForeman'));

  a = run(null, [], employees, update(job({ assigned_employee_sync_id: E1 }), job({ assigned_employee_sync_id: E2 })));
  check('reassigned E2 -> E1: the new lead is marked, the old one is not told', a.get('crew1')?.newLead === true && !a.has('crew2'));
  check('... and nobody else is marked as the new lead', [...a].filter(([, v]) => v.newLead).length === 1);

  a = run(job({ assigned_employee_sync_id: E1 }), [E2]);
  check('nobody outside profiles is ever added', [...a.keys()].every((id) => profiles.some((x) => x.id === id)));
  return results;
}

for (const r of audienceChecks(jobPushAudience, 'jobPushAudience')) ok(r.name, r.cond, r.detail);

// PLANTED: the old behaviour -- every profile in the company -- must fail.
{
  const broadcast = ({ profiles: ps }) => new Map(ps.map((x) => [x.id, { newLead: false }]));
  const failed = audienceChecks(broadcast, 'broadcast').filter((r) => !r.cond);
  ok('PLANTED: a broadcast audience fails the leak checks', failed.length >= 5, `${failed.length} failed`);
  // PLANTED: an audience that forgets the lead fails too.
  const leadless = (input) => jobPushAudience({ ...input, event: { ...input.event, leadSyncId: '' } });
  ok('PLANTED: an audience that forgets the lead is caught',
    audienceChecks(leadless, 'leadless').some((r) => !r.cond && /lead/.test(r.name)));
}

// ---------------------------------------------------------------------------
// A6. The function: the order and the addressing
// ---------------------------------------------------------------------------

/** Everything wrong with a copy of notify-job-change/index.ts. */
function indexProblems(src) {
  const c = code(src);
  const out = [];
  const secret = c.indexOf('secretMatches(req.headers');
  const body = c.indexOf('req.json()');
  if (!(secret > 0 && secret < body)) out.push('the trigger secret is not checked before the body is read');
  if (/assigned_employee_id\b/.test(c)) out.push('still reads the dead assigned_employee_id column');
  if (/Job marked complete|finished by the crew/.test(c)) out.push('still calls an accepted quote a finished job');
  if (!/from "\.\.\/_shared\/job-push\.ts"/.test(c)) out.push('does not use the shared audience rule');
  const selects = [...c.matchAll(/\.from\("device_tokens"\)\s*\.select\([^;]*;/g)].map((m) => m[0]);
  if (!selects.length) out.push('no device_tokens read found');
  for (const s of selects) {
    if (!/\.in\("user_id"/.test(s)) out.push('a device_tokens read is not limited to chosen users: ' + s.replace(/\s+/g, ' ').slice(0, 90));
  }
  // The audience reads moved to _shared/push-recipients.ts (quote-view shares
  // them), so a file that imports it is judged with that file's reads.
  const reads = /from "\.\.\/_shared\/push-recipients\.ts"/.test(c)
    ? c + code(readFileSync(join(ROOT, 'supabase/functions/_shared/push-recipients.ts'), 'utf8'))
    : c;
  if (!/\.from\("job_assignments"\)[^;]*\.is\("ended_at", null\)/.test(reads)) out.push('job_assignments read does not skip ended rows');
  return out;
}

{
  const now = readFileSync(join(ROOT, 'supabase/functions/notify-job-change/index.ts'), 'utf8');
  const p = indexProblems(now);
  ok('index.ts: secret first, sync-id rule, right words, every device read addressed', p.length === 0, p.join(' | '));

  // PLANTED: the version before this change must be caught on every count
  // this change fixed. Pinned to the last commit that shipped it (not HEAD,
  // which carries this change once it is committed).
  const BEFORE = 'ed16271';
  const git = spawnSync('git', ['show', BEFORE + ':supabase/functions/notify-job-change/index.ts'], { encoding: 'utf8', cwd: ROOT });
  if (git.status === 0 && git.stdout && !git.stdout.includes('_shared/job-push.ts')) {
    const old = indexProblems(git.stdout);
    ok('PLANTED: the previous index.ts is caught broadcasting', old.some((s) => s.startsWith('a device_tokens read is not limited')), old.join(' | '));
    ok('PLANTED: the previous index.ts is caught reading assigned_employee_id', old.some((s) => s.includes('assigned_employee_id')));
    ok('PLANTED: the previous index.ts is caught mislabelling ACCEPTED', old.some((s) => s.includes('finished job')));
  } else {
    console.log('  (skipped the git plant: commit ' + BEFORE + ' is not in this clone)');
  }
  // PLANTED: a broadcast device read added back must be caught.
  const plantedBroadcast = now.replace('.in("user_id", [...notes.keys()])', '');
  ok('PLANTED: dropping the user filter from the device read is caught',
    plantedBroadcast !== now && indexProblems(plantedBroadcast).some((s) => s.startsWith('a device_tokens read')));
}

// ---------------------------------------------------------------------------
// B. Live: the table against the live has_permission, rolled back
// ---------------------------------------------------------------------------
const ROLES = ['OWNER', 'MANAGER', 'SALES', 'ACCOUNTANT', 'FOREMAN', 'CREW', 'SUPERVISOR', 'owner', null];
const OVERRIDES = ['', null, '+EDIT_JOBS', '-SEE_MONEY', '+SEE_MONEY,-SEE_MONEY', '-SCHEDULE_AND_ASSIGN',
  '+SEE_MONEY_TYPO', 'EDIT_JOBS', '+DELETE_RECORDS,-RECORD_FIELD_WORK', '-EDIT_JOBS,-SEE_MONEY,-SCHEDULE_AND_ASSIGN'];
const PERMS = ['SEE_MONEY', 'SEE_PAY', 'EDIT_JOBS', 'EDIT_CATALOG_AND_SETTINGS', 'SCHEDULE_AND_ASSIGN',
  'REQUEST_PAYMENT', 'RECORD_REFUNDS', 'RECORD_FIELD_WORK', 'SEE_CUSTOMER_CONTACT', 'SEE_REPORTS',
  'APPROVE_TIME', 'APPROVE_PLAN_CHANGES', 'DELETE_RECORDS', 'SHARE_INVITE_CODE', 'MANAGE_ACCESS', 'NOT_A_PERMISSION'];

const lit = (v) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

const LIVE_SQL = String.raw`begin;
do $probe$
declare d text; n text;
begin
    d := pg_get_functiondef('public.has_permission(text)'::regprocedure);
    n := regexp_replace(d, 'FUNCTION public\.has_permission\(perm text\)',
                           'FUNCTION pg_temp.s2_has_permission(perm text, r text, ov text)');
    n := regexp_replace(n, 'select role::text as role_text, coalesce\(permission_overrides, ''''\) as overrides\s+from profiles where id = auth\.uid\(\)',
                           'select r as role_text, coalesce(ov, '''') as overrides');
    n := regexp_replace(n, 'SECURITY DEFINER', '');
    if position('pg_temp.s2_has_permission' in n) = 0 or position('auth.uid()' in n) > 0 then
        raise exception 'has_permission no longer has the shape this probe rewrites; not evaluated';
    end if;
    execute n;
end $probe$;
select json_agg(json_build_object('role', r, 'ov', ov, 'perm', perm,
                                  'got', pg_temp.s2_has_permission(perm, r, ov))) as rows
  from unnest(array[${ROLES.map(lit).join(',')}]::text[]) r,
       unnest(array[${OVERRIDES.map(lit).join(',')}]::text[]) ov,
       unnest(array[${PERMS.map(lit).join(',')}]::text[]) perm;
rollback;
`;

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'notify-job-change-'));
  const file = join(dir, 'q.sql');
  writeFileSync(file, sql, 'utf8');
  const r = spawnSync('npx', ['--no-install', 'supabase@2.115.0', 'db', 'query',
    '--linked', '--project-ref', PROJECT, '-f', file, '--output', 'json'],
    { encoding: 'utf8', shell: process.platform === 'win32', timeout: 180_000 });
  if (r.status !== 0) throw new Error(`supabase db query failed: ${r.stderr || r.stdout}`);
  const parsed = JSON.parse(r.stdout);
  return Array.isArray(parsed) ? parsed : (parsed.rows || []);
}

/** Every (role, overrides, perm) where `fn` disagrees with the live rows. */
const liveDisagreements = (rows, fn) =>
  rows.filter((x) => fn(x.role, x.ov, x.perm) !== x.got)
    .map((x) => `${x.role}/${JSON.stringify(x.ov)}/${x.perm}: live ${x.got}`);

if (!STATIC_ONLY) {
  let rows = null;
  try {
    const out = runSql(LIVE_SQL);
    rows = out[0]?.rows ?? null;
  } catch (e) {
    ok('the live has_permission probe ran', false, String(e).slice(0, 400));
  }
  if (rows) {
    const expected = ROLES.length * OVERRIDES.length * PERMS.length;
    ok(`the live probe evaluated every combination (${rows.length}/${expected})`, rows.length === expected);
    ok('the live probe really varied (both answers occur)', rows.some((x) => x.got === true) && rows.some((x) => x.got === false));
    const off = liveDisagreements(rows, permissionFor);
    ok('permissionFor agrees with the live has_permission on every combination', off.length === 0, off.slice(0, 5).join(' | '));

    // PLANTED: a sales role that lost EDIT_JOBS in TypeScript alone.
    const drifted = new Map(ROLE_PERMISSIONS);
    drifted.set('SALES', ['SEE_MONEY', 'SEE_CUSTOMER_CONTACT']);
    const driftedFor = (role, ov, perm) => {
      const o = ov ?? '';
      if (o.includes('-' + perm)) return false;
      if (o.includes('+' + perm)) return true;
      const g = role ? drifted.get(role) : undefined;
      return g === 'ALL' || (g !== undefined && g.includes(perm));
    };
    ok('PLANTED: a drifted table disagrees with the live function', liveDisagreements(rows, driftedFor).length > 0);
  }
}

console.log(`\n${pass} passed, ${fail} failed${STATIC_ONLY ? ' (static only)' : ''}`);
process.exit(fail ? 1 : 0);
