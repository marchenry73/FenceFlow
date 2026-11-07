/**
 * A CANCELLATION MUST RECORD WHAT IT KEPT.
 *
 * supabase_r45_job_cancellation.sql added jobs.cancellation_retained and said
 * in its own comment exactly what it was for: "What was kept ... AS DECIDED AT
 * THE MOMENT OF CANCELLATION. Stored rather than recomputed: the line items
 * and the footage can change afterwards, and what was retained is a fact about
 * that day, not a figure that should drift."
 *
 * MEASURED 6 Nov 2026: nothing wrote it. Not the office (dashboard.html's
 * cancelJob() sets cancelled_at, cancelled_by, cancellation_reason and stops),
 * not the phone (CancellationApi.cancel(), same three), not a trigger, not an
 * edge function. And the DEPLOYED job_cancellation_terms -- read out of the
 * live database, not out of a file -- mentioned neither cancellation_retained
 * nor cancelled_at, so it answered from today's line items every time it was
 * asked, including months after the job was cancelled.
 *
 * The customer is told "we keep $X, you get $Y back"; $X is stored nowhere;
 * the next person to open the job sees a different number and nobody can say
 * which one was the agreement. Same defect jobs.accepted_total was created to
 * fix on the quote side, on a refund instead.
 *
 * r71 puts the rule in one function (cancellation_retained_raw), has
 * job_cancellation_terms prefer a figure already decided, and freezes that
 * figure with a trigger on the cancelled_at transition -- the one funnel both
 * the office and the phone go through, so neither client needed changing and a
 * third one later cannot forget.
 *
 * WHY THESE ARE LIVE CHECKS. The defect was never in a file. The office's
 * cancel is correct code that simply does not mention the column, and the
 * display function's omission could only be seen in the deployed body. Only
 * the database can answer whether the figure is written, so these read it.
 * The behavioural test runs inside BEGIN/ROLLBACK and writes nothing that
 * survives, and it carries a positive control that removes the trigger inside
 * the same transaction and confirms the figure is then NOT stored.
 *
 *     node --test tests/a165-cancellation-figure-is-frozen.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT = 'newcrgafcptspmapacrx';

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'a165-cancel-'));
  const file = join(dir, 'q.sql');
  writeFileSync(file, sql, 'utf8');
  const r = spawnSync('npx', ['--no-install', 'supabase@2.115.0', 'db', 'query',
    '--linked', '--project-ref', PROJECT, '-f', file, '--output', 'json'],
    { encoding: 'utf8', shell: process.platform === 'win32', timeout: 180_000 });
  // The RAW status before trusting a parse: an error response that still
  // prints a header reads exactly like an empty-but-ok result.
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

const one = (sql) => runSql(sql)[0];

// ---------------------------------------------------------------------------
// THE RULE LIVES IN ONE PLACE
// ---------------------------------------------------------------------------

test('CANARY: the rule function exists and answers at all', () => {
  // Every arithmetic assertion below is about this function's answer. If it
  // were missing, the query would error rather than quietly agree.
  const r = one(`select public.cancellation_retained_raw(100, true, 250.00, false) as v;`);
  assert.ok(r && r.v != null, 'cancellation_retained_raw returned nothing');
});

test('the rule: $1 a foot, plus the material when it was ordered', () => {
  const r = one(`select public.cancellation_retained_raw(100, true, 250.00, false) as v;`);
  assert.strictEqual(Number(r.v), 350,
    '100 ft with $250 of ordered material should retain $350 (r45)');
});

test('the rule: material that was never ordered is not retained', () => {
  const r = one(`select public.cancellation_retained_raw(100, false, 250.00, false) as v;`);
  assert.strictEqual(Number(r.v), 100,
    'material the contractor never bought must not be kept from the customer');
});

test('the rule: inside the cooling-off window nothing is retained', () => {
  // r61, and it is the law rather than a preference: whatever was ordered,
  // the three-business-day window returns everything.
  const r = one(`select public.cancellation_retained_raw(100, true, 9999.00, true) as v;`);
  assert.strictEqual(Number(r.v), 0,
    'inside the three business days the customer keeps nothing back');
});

test('the rule is UNROUNDED, because refund_due rounds a different expression', () => {
  // job_cancellation_terms shows round(base, 2) but computes the refund as
  // round(greatest(collected - base, 0), 2) from the UNROUNDED base. A helper
  // that pre-rounded would move live refunds by up to a cent.
  const r = one(`select public.cancellation_retained_raw(0.333, false, 0, false) as v;`);
  assert.strictEqual(Number(r.v), 0.333,
    'the rule function is rounding internally; refund_due would shift by a cent');
});

// ---------------------------------------------------------------------------
// THE DISPLAY HONOURS A DECISION ALREADY MADE
// ---------------------------------------------------------------------------

const termsSrc = () => one(`
  select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='job_cancellation_terms';`).prosrc;

test('CANARY: job_cancellation_terms exists and has a body to read', () => {
  const src = termsSrc();
  assert.ok(src && src.length > 500,
    'job_cancellation_terms is missing or truncated; every check below would pass vacuously');
});

test('the display reads the stored figure instead of re-pricing a settled cancellation', () => {
  assert.match(termsSrc(), /cancellation_retained/,
    'job_cancellation_terms never looks at jobs.cancellation_retained, so a job ' +
    'cancelled months ago is still quoted from today\'s line items');
});

test('and only when the job is actually cancelled', () => {
  // A stored figure on a live job is not an agreement about anything.
  assert.match(termsSrc(), /cancelled_at is not null/,
    'the frozen figure is read without checking cancelled_at');
});

test('the display and the trigger share one definition of the rule', () => {
  // Two copies of a money expression drift. That is why this file exists.
  assert.match(termsSrc(), /cancellation_retained_raw/,
    'job_cancellation_terms carries its own copy of the retention arithmetic again');
});

// ---------------------------------------------------------------------------
// THE FIGURE IS ACTUALLY WRITTEN
// ---------------------------------------------------------------------------

const triggerDef = () => {
  const rows = runSql(`select pg_get_triggerdef(oid) as def from pg_trigger
     where tgname='jobs_freeze_cancellation_retained';`);
  return rows.length ? rows[0].def : null;
};

test('the freeze trigger is installed', () => {
  assert.ok(triggerDef(),
    'jobs_freeze_cancellation_retained is gone -- cancelling a job records ' +
    'nothing about what it kept, for the office AND the phone at once');
});

test('it fires on the cancelled_at write, before the row lands', () => {
  // BEFORE, so the value rides the same write rather than a second UPDATE
  // that would churn updated_at and push the row to every other phone.
  assert.match(triggerDef(), /BEFORE UPDATE OF cancelled_at/i,
    'the freeze trigger moved off the cancelled_at write');
});

test('and only on the null -> not-null transition, so a later edit cannot re-price it', () => {
  // Without the guard, any subsequent update to a cancelled job would
  // recompute the figure from that day's line items -- reintroducing exactly
  // the drift this is here to stop.
  const def = triggerDef();
  assert.match(def, /cancelled_at IS NULL/i,
    'the transition guard is gone: editing a cancelled job re-prices the cancellation');
  assert.match(def, /cancelled_at IS NOT NULL/i,
    'the trigger no longer requires that the job is being cancelled');
});

test('BEHAVIOUR: cancelling a job stores the figure, and without the trigger it does not', () => {
  // The one test that would have caught the original defect. Everything above
  // passes on a trigger function that returns NEW untouched.
  //
  // Inside BEGIN/ROLLBACK: nothing here survives the statement. The job is
  // chosen by PROPERTY (materials ordered, so both halves of the rule are in
  // play) rather than by sort order -- picking "most feet" chose a NOT_ORDERED
  // job, where the material term drops out and a corrupted material figure
  // went undetected.
  const got = runSql(`
    begin;
    create temporary table a165r (phase text, retained numeric);

    with pick as (
      select jb.id from public.jobs jb
       where jb.deleted_at is null and jb.cancelled_at is null
         and (jb.materials_ordered_at is not null
              or upper(coalesce(jb.materials_status,'NOT_ORDERED')) in ('ORDERED','RECEIVED'))
         and coalesce(jb.signed_linear_feet,0) > 0
       order by jb.signed_linear_feet desc limit 1
    ), done as (
      update public.jobs j set cancelled_at = now()
        from pick where j.id = pick.id
      returning j.id, j.cancellation_retained
    )
    insert into a165r select 'with_trigger', cancellation_retained from done;

    -- POSITIVE CONTROL. Put a second job through the same write with the
    -- trigger disabled: if that ALSO stores a figure, something other than
    -- this trigger is doing it and the test above proves nothing about r71.
    alter table public.jobs disable trigger jobs_freeze_cancellation_retained;
    with pick2 as (
      select jb.id from public.jobs jb
       where jb.deleted_at is null and jb.cancelled_at is null
         and coalesce(jb.signed_linear_feet,0) > 0
       order by jb.signed_linear_feet desc limit 1
    ), done2 as (
      update public.jobs j set cancelled_at = now()
        from pick2 where j.id = pick2.id
      returning j.id, j.cancellation_retained
    )
    insert into a165r select 'no_trigger', cancellation_retained from done2;
    alter table public.jobs enable trigger jobs_freeze_cancellation_retained;

    select phase, retained from a165r;
    rollback;`);

  const byPhase = Object.fromEntries(got.map(r => [r.phase, r.retained]));
  assert.ok('with_trigger' in byPhase,
    'no job was available to rehearse against -- this test proved nothing');
  assert.ok(byPhase.with_trigger != null,
    'cancelling a job left cancellation_retained NULL: the trigger did not fire, ' +
    'so what the cancellation kept is recorded nowhere');
  assert.ok(Number(byPhase.with_trigger) > 0,
    `the stored figure was ${byPhase.with_trigger}; a constant zero would pass a ` +
    'mere not-null check, so the rehearsal needs a job with feet on it');
  assert.strictEqual(byPhase.no_trigger ?? null, null,
    'a cancellation stored a figure with the trigger DISABLED -- something else ' +
    'is writing cancellation_retained and this test is not measuring r71');
});

test('nothing was actually cancelled by running this file', () => {
  // Every write above is inside BEGIN/ROLLBACK. Said out loud and checked,
  // because a test that quietly cancelled a live job would be far worse than
  // the bug it is testing for.
  const r = one(`select count(*)::int as n from public.jobs
                  where cancelled_at is not null and deleted_at is null;`);
  assert.strictEqual(Number(r.n), 0,
    `${r.n} job(s) are cancelled; this suite must leave that count where it found it`);
});
