/**
 * A NEW COMPANY GETS ITS FIRST MONTH FREE (supabase_r75_first_month_free.sql).
 *
 * The owner, 17 Nov 2026: "Every new company gets its FIRST MONTH FREE. No
 * card, nothing to cancel, no obligation. At the end of the month they just
 * stop and owe nothing." Asked what the free month unlocks, he chose Crew for
 * everyone -- owner + 5 logins -- so a shop with salespeople can try it with
 * all of them.
 *
 * ------------------------------------------------------------------
 * THE BUG UNDER THE FEATURE, which is what makes this file worth running
 * ------------------------------------------------------------------
 * create_company_with_owner -- the function the office's sign-up calls --
 * inserted `(name)` and took the column defaults: status 'pending',
 * trial_ends_at NULL, plan ''. Measured against the live company_allowed, NOT
 * ONE of its arms passes in that state, so a brand-new company was locked out
 * ON ITS FIRST DAY, before the trial it was told to start. The way in was a
 * Stripe Checkout, which takes a card and is what set trial_ends_at. Meanwhile
 * the outreach emails promise the month, so a prospect who believed them
 * signed up and met the locked screen.
 *
 * EVERYTHING HERE RUNS INSIDE BEGIN/ROLLBACK and creates nothing that lasts.
 * The company it makes is made by calling the REAL function as a REAL
 * signed-in user, because the defect lived in the gap between what the
 * function wrote and what the gate accepted -- reading either one alone is
 * what missed it.
 *
 *     node --test tests/a174-first-month-free.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'newcrgafcptspmapacrx';

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'a174-month-'));
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

/**
 * Sign up for real, as a user who has no company, and report what the company
 * can do. The user is chosen BY PROPERTY and that property is asserted inside
 * the transaction -- a fixture pinned to a person has already made a security
 * test here cry breach after a promotion.
 */
const signUpAndMeasure = (extra = '') => runSql(`
  begin;
  create temporary table m (step text, measured text) on commit drop;
  do $$
  declare uid uuid; pool int; cid uuid; had_prof boolean;
  begin
      select count(*) into pool
        from auth.users u left join profiles p on p.id = u.id
       where p.id is null or p.company_id is null;
      insert into m values ('pool', pool::text);
      if pool = 0 then return; end if;

      select u.id, (p.id is not null) into uid, had_prof
        from auth.users u left join profiles p on p.id = u.id
       where p.id is null or p.company_id is null
       order by u.created_at limit 1;
      if exists (select 1 from profiles where id = uid and company_id is not null) then
          raise exception 'fixture drifted: the chosen user already belongs to a company';
      end if;

      perform set_config('request.jwt.claims',
          json_build_object('sub', uid, 'role', 'authenticated')::text, true);
      set local role authenticated;
      cid := public.create_company_with_owner('a174 sign-up', 'Owner Under Test');
      reset role;
      perform set_config('request.jwt.claims', '', true);

      insert into m
        select 'allowed_day1', public.company_allowed(cid)::text;
      insert into m
        select 'seat_cap', coalesce((select case lower(coalesce(subscription_plan,''))
                                              when 'solo' then 1 when 'crew' then 6 else null end
                                       from companies where id = cid)::text, 'NO CAP');
      insert into m
        select 'days', round(extract(epoch from ((select trial_ends_at from companies where id = cid) - now()))/86400.0)::text;
      insert into m select 'status', (select subscription_status from companies where id = cid);
      insert into m select 'plan',   (select lower(coalesce(subscription_plan,'')) from companies where id = cid);
      insert into m select 'stripe', (select case when stripe_subscription_id is null and stripe_customer_id is null
                                                 then 'none' else 'present' end from companies where id = cid);
      ${extra}

      delete from profiles where company_id = cid;
      if not had_prof then delete from profiles where id = uid; end if;
      delete from companies where id = cid;
  end $$;
  select step, measured from m;
  rollback;`);

const val = (rows, step) => rows.find((r) => r.step === step)?.measured;

test('CANARY: there is a user with no company to sign up as', () => {
  // Without this, every measurement below is taken on an empty set and a
  // missing row reads exactly like a pass.
  const rows = signUpAndMeasure();
  assert.ok(Number(val(rows, 'pool')) > 0,
    'no auth user without a company, so this file proves nothing');
  assert.ok(val(rows, 'allowed_day1') !== undefined,
    'the sign-up produced no measurements at all');
});

test('a brand-new company can get in on its FIRST day', () => {
  // THE DEFECT, in one line. This was false before r75.
  const rows = signUpAndMeasure();
  assert.strictEqual(val(rows, 'allowed_day1'), 'true',
    'a company that just signed up is locked out -- company_allowed refuses what create_company_with_owner writes');
});

test('the free month is 30 days, and nothing was created to cancel or charge', () => {
  const rows = signUpAndMeasure();
  assert.strictEqual(Number(val(rows, 'days')), 30, 'the free month is not 30 days');
  assert.strictEqual(val(rows, 'stripe'), 'none',
    'sign-up created a Stripe customer or subscription -- the offer says there is nothing to cancel');
});

test('the free month gives the owner + 5 logins, not one and not unlimited', () => {
  // BOTH failures matter. A blank plan is NO cap (the company adds twenty
  // logins free, then meets a 6-seat wall the day it pays); 'solo' would be
  // one, which is the opposite of what he asked for.
  const rows = signUpAndMeasure();
  assert.strictEqual(val(rows, 'seat_cap'), '6',
    `the free month has a seat cap of ${val(rows, 'seat_cap')}`);
  assert.strictEqual(val(rows, 'plan'), 'crew', 'the stored plan is not crew');
});

test('it does NOT borrow Stripe\'s "trialing", which would never expire', () => {
  // Measured, not argued: with status 'trialing' the gate passes on a NULL
  // trial_ends_at for ever -- that arm exists so a real subscriber is not
  // locked out before Stripe's webhook lands. A free month with no
  // subscription must not sit on it, or clearing the date once would mean
  // silent permanent access. So the status stays 'pending' and the month
  // rests on the date alone.
  const rows = signUpAndMeasure();
  assert.strictEqual(val(rows, 'status'), 'pending',
    'the free month now rides on a Stripe status it has no subscription for');

  const [t] = runSql(`
    begin;
    create temporary table c (allowed text) on commit drop;
    do $$
    declare cid uuid;
    begin
        insert into companies (name, subscription_status) values ('a174 trialing', 'trialing')
          returning id into cid;
        insert into c select public.company_allowed(cid)::text;
        delete from companies where id = cid;
    end $$;
    select allowed from c;
    rollback;`);
  assert.strictEqual(t.allowed, 'true',
    'the reason for choosing pending has gone: trialing with no end date is no longer permanent access. Re-read r75 before changing it.');
});

test('ON DAY 30 IT STOPS BY ITSELF, and the data is left alone', () => {
  const rows = signUpAndMeasure(`
      update companies set trial_ends_at = now() - interval '1 second' where id = cid;
      insert into m select 'allowed_day30', public.company_allowed(cid)::text;
      insert into m select 'row_still_there', (select count(*) from companies where id = cid)::text;`);
  assert.strictEqual(val(rows, 'allowed_day30'), 'false',
    'the free month never ends -- every sign-up would have permanent free access');
  assert.strictEqual(val(rows, 'row_still_there'), '1',
    'the company row was removed when the month ended; the site promises the data stays');
});

test('THE TEETH: the old sign-up really was locked out, so the fix is not a no-op', () => {
  // The whole file could pass on a gate that says yes to everything. This
  // plants the OLD state -- name only, every default -- and requires a no.
  const [r] = runSql(`
    begin;
    create temporary table o (allowed text, cap text) on commit drop;
    do $$
    declare cid uuid;
    begin
        insert into companies (name) values ('a174 old sign-up') returning id into cid;
        insert into o
          select public.company_allowed(cid)::text,
                 coalesce((select case lower(coalesce(subscription_plan,''))
                                    when 'solo' then 1 when 'crew' then 6 else null end
                             from companies where id = cid)::text, 'NO CAP');
        delete from companies where id = cid;
    end $$;
    select allowed, cap from o;
    rollback;`);
  assert.strictEqual(r.allowed, 'false',
    'a company with the old defaults is allowed in, so "the lockout is fixed" measures nothing');
  assert.strictEqual(r.cap, 'NO CAP',
    'a blank plan now has a seat cap, so the logins check above is not about crew');
});

test('the file that did this is recorded as applied', () => {
  // A migration can be applied by hand and never recorded, after which the
  // next environment silently does not have it.
  const [r] = runSql(`select count(*)::int as n from schema_migrations
                       where filename = 'supabase_r75_first_month_free.sql';`);
  assert.strictEqual(Number(r.n), 1, 'r75 is not recorded as applied');
});
