// Proves supabase_r10_restore_change_order_latch.sql before it is ever
// applied.
//
//   A. STATIC, pure (always runs): reads the migration text and checks the
//      promises easiest to break in a later edit -- nothing is deleted,
//      nothing is dropped, the only change_orders write is still the same
//      false-to-true mark (now with one extra AND), and the new session
//      setting is both written (by the restore) and read (by the mark) and
//      cleared on every exit path, including the exception handler. Each
//      checker is proven by a planted bad copy that it must catch.
//
//   B. LIVE, rolled back (only with A16_LIVE=1): `begin;` + reads the REAL,
//      unfixed live functions first to reproduce the defect on a synthetic
//      job, THEN applies this file's two functions inside the SAME
//      transaction and re-proves the same class of scenario now comes out
//      right -- plus the states the task asked for explicitly (no orders;
//      signed before the withdrawal; signed during it; two orders
//      straddling; an ordinary fresh approval, untouched). Every subject and
//      row is synthetic, in an obviously-synthetic uuid namespace
//      (a1600000-...), created in here; nothing of the owner's is read or
//      written. The whole thing rolls back. This is the same discipline
//      tests/r6-price-crew.test.mjs uses against supabase_r6_price_stability.sql:
//      begin, work, assert, rollback, and a SUMMARY row that must exist so a
//      lost check cannot pass silently.
//
//   node --test tests/a16-latch-restore-change-order.test.mjs             (A only)
//   A16_LIVE=1 node --test tests/a16-latch-restore-change-order.test.mjs  (A and B, ~1 min)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT = "newcrgafcptspmapacrx";
const ROOT = process.cwd();
const fix = readFileSync(join(ROOT, "supabase_r10_restore_change_order_latch.sql"), "utf8");

// ================================================================ A ======

/** The file with every `--` comment removed, so prose cannot satisfy a check. */
const code = (sql) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

/** The bodies of the functions this file defines ($function$/$fn$ ... $function$/$fn$). */
export function functionBodies(sql) {
  const c = code(sql);
  return [
    ...[...c.matchAll(/\$function\$([\s\S]*?)\$function\$/g)].map((m) => m[1]),
    ...[...c.matchAll(/\$fn\$([\s\S]*?)\$fn\$/g)].map((m) => m[1]),
  ];
}

/** Anything in the file that deletes, truncates, rewrites at large, or drops. */
export function destructive(sql) {
  const src = code(sql).replace(/\$function\$[\s\S]*?\$function\$/g, "").replace(/\$fn\$[\s\S]*?\$fn\$/g, "");
  const problems = [];
  if (/\bdelete\s+from\b/i.test(src)) problems.push("deletes rows");
  if (/\btruncate\b/i.test(src)) problems.push("truncates");
  if (/\balter\s+table\b[^;]*\b(drop|alter\s+column|rename)\b/i.test(src)) problems.push("drops or alters a column");
  if (/\bdrop\s+trigger\b/i.test(src)) problems.push("drops a trigger");
  if (/\bdrop\s+table\b/i.test(src)) problems.push("drops a table");
  return problems;
}

/**
 * Every row-changing statement inside a function body. The only one allowed
 * is marking change orders as inside an accepted price -- same shape r6
 * established, now with the added cutoff clause -- and the two pre-existing
 * audit inserts reapp_restore_approval already made in production (not new
 * writes this file introduces).
 */
export function functionWrites(sql) {
  const problems = [];
  for (const body of functionBodies(sql)) {
    if (/\bdelete\s+from\b/i.test(body)) problems.push("a function deletes rows");
    for (const m of body.matchAll(/\bupdate\s+([\w.]+)(?:\s+\w+)?\s+set\s+([^;]*)/gis)) {
      const table = m[1];
      const clause = m[2].replace(/\s+/g, " ").trim();
      if (table === "public.change_orders") {
        const ok = /^in_accepted_total\s*=\s*true\b/i.test(clause) && /and\s+not\s+co\.in_accepted_total/i.test(clause);
        if (!ok) problems.push(`updates change_orders wrong: ${clause.slice(0, 80)}`);
        continue;
      }
      if (table === "public.jobs" && /quote_approved_at\s*=\s*q\.prior_approved_at/i.test(clause)) continue; // the pre-existing restore write
      if (table === "public.quote_reapprovals" && /resolved_at\s*=\s*now\(\)/i.test(clause)) continue; // the pre-existing resolve write
      problems.push(`updates ${table}: ${clause.slice(0, 80)}`);
    }
    for (const m of body.matchAll(/\binsert\s+into\s+([\w.]+)/gi)) {
      if (!["public.audit_log", "public.field_changes"].includes(m[1])) {
        problems.push(`inserts into ${m[1]}`);
      }
    }
  }
  return problems;
}

test("nothing in the file deletes, truncates, drops, or rewrites at large", () => {
  assert.deepEqual(destructive(fix), []);
});

test("planted: the destructive checker catches a delete, a drop and a column change", () => {
  assert.ok(destructive(fix + "\ndelete from public.change_orders where true;").includes("deletes rows"));
  assert.ok(destructive(fix + "\ndrop trigger \"90_mark_change_orders_accepted\" on public.jobs;").includes("drops a trigger"));
  assert.ok(destructive(fix + "\nalter table public.jobs drop column contract_total;").length > 0);
});

test("the only change_orders write is still false-to-true, now cutoff-guarded", () => {
  assert.deepEqual(functionWrites(fix), []);
  const marks = functionBodies(fix).filter((b) => /update\s+public\.change_orders/i.test(b));
  assert.equal(marks.length, 1, "expected exactly one function touching change_orders");
  assert.match(marks[0], /and\s+not\s+co\.in_accepted_total\s*$/mi.test(marks[0]) ? /not\s+co\.in_accepted_total/ : /not co\.in_accepted_total/);
  assert.match(marks[0], /restore_cutoff is null or co\.signed_at is null or co\.signed_at <= restore_cutoff/);
});

test("planted: an unmarked older order gone, or the latch's own truth widened, is caught", () => {
  // Operate on the comment-stripped file, the same input functionWrites()
  // itself uses -- otherwise this regex could just as easily match one of
  // the header's quoted BEFORE/UNDO bodies (plain prose, no restore_cutoff
  // anywhere near it) and silently mutate nothing real.
  const stripped = code(fix);
  // Drop the "not co.in_accepted_total" guard -- would re-mark rows already
  // latched true, which functionWrites must flag as writing the table wrong.
  const widened = stripped.replace(/and not co\.in_accepted_total[\s\S]*?and \(restore_cutoff/, "and (restore_cutoff");
  assert.notEqual(widened, stripped, "the planted replace did not match anything in the real file");
  assert.notDeepEqual(functionWrites(widened), []);
  // Drop the cutoff condition entirely -- back to today's bug, unguarded.
  const unguarded = stripped.replace(/\s*and \(restore_cutoff is null or co\.signed_at is null or co\.signed_at <= restore_cutoff\)/, "");
  assert.doesNotMatch(unguarded, /restore_cutoff is null or co\.signed_at is null/);
});

test("the cutoff setting is written by the restore and read by the mark, under the same name", () => {
  const restoreBody = functionBodies(fix).find((b) => /update\s+public\.quote_reapprovals/i.test(b));
  const markBody = functionBodies(fix).find((b) => /update\s+public\.change_orders/i.test(b));
  assert.ok(restoreBody, "no reapp_restore_approval body found");
  assert.ok(markBody, "no mark_change_orders_accepted body found");
  assert.match(restoreBody, /perform set_config\('app\.reapproval_restore_signed_cutoff', q\.at::text, true\)/);
  assert.match(markBody, /current_setting\('app\.reapproval_restore_signed_cutoff', true\)/);
});

test("the cutoff setting is cleared on the success path AND in the exception handler", () => {
  const restoreBody = functionBodies(fix).find((b) => /update\s+public\.quote_reapprovals/i.test(b));
  const clears = [...restoreBody.matchAll(/perform set_config\('app\.reapproval_restore_signed_cutoff', ''/g)];
  assert.equal(clears.length, 2, "expected one clear on the normal path and one in the exception handler");
  assert.match(restoreBody, /exception when others then[\s\S]*reapproval_restore_signed_cutoff', ''/);
});

test("planted: a clear removed from the exception handler is caught", () => {
  const oneClearGone = fix.replace(
    /exception when others then\s+perform set_config\('app\.reapproval_clear', '0', true\);\s+perform set_config\('app\.reapproval_restore_signed_cutoff', '', true\);/,
    "exception when others then\n    perform set_config('app.reapproval_clear', '0', true);");
  const restoreBody = functionBodies(oneClearGone).find((b) => /update\s+public\.quote_reapprovals/i.test(b));
  const clears = [...restoreBody.matchAll(/perform set_config\('app\.reapproval_restore_signed_cutoff', ''/g)];
  assert.equal(clears.length, 1, "the planted removal should leave exactly one clear, not two");
});

test("the ACL restatement targets the restore function, service_role only, never anon/authenticated", () => {
  assert.match(code(fix), /revoke all on function public\.reapp_restore_approval\(\s*uuid, uuid, public\.quote_reapprovals\) from public, anon, authenticated;/);
  assert.match(code(fix), /grant execute on function public\.reapp_restore_approval\(\s*uuid, uuid, public\.quote_reapprovals\) to service_role;/);
});

test("the file states plainly that it is unapplied", () => {
  assert.match(fix, /STATUS: UNAPPLIED/);
});

// ================================================================ B ======

const LIVE = process.env.A16_LIVE === "1";

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "a16-latch-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query",
    "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
    { encoding: "utf8", shell: process.platform === "win32", timeout: 240_000 });
  if (r.status !== 0) throw new Error(`supabase db query failed: ${r.stderr || r.stdout}`);
  const out = r.stdout;
  const parsed = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  return Array.isArray(parsed) ? parsed : (parsed.rows || []);
}

// Every id below lives under a1600000-... -- obviously synthetic, and never
// touches a real company, job or change order. The whole script is one
// transaction that ends in rollback; nothing here is ever committed.
const PROBE = `
begin;
set local lock_timeout = '5s';

create temp table r(n serial, k text, got text, want text);

do $body$
declare
  SC uuid := 'a1600000-0000-4000-8000-000000000001';
  T1 constant timestamptz := '2026-01-01 00:00:00+00';  -- original online approval
  T2 constant timestamptz := '2026-02-01 00:00:00+00';  -- withdrawal (quote_reapprovals.at)
  T_BEFORE constant timestamptz := '2026-01-15 00:00:00+00'; -- signed before withdrawal
  T_DURING constant timestamptz := '2026-02-15 00:00:00+00'; -- signed during the withdrawn window (before now())

  jNo   uuid := 'a1600000-0000-4000-8000-0000000000a1'; qNo   uuid := 'a1600000-0000-4000-8000-0000000000b1';
  jBef  uuid := 'a1600000-0000-4000-8000-0000000000a2'; qBef  uuid := 'a1600000-0000-4000-8000-0000000000b2';
  coBef uuid := 'a1600000-0000-4000-8000-0000000000c2';
  jBug  uuid := 'a1600000-0000-4000-8000-0000000000a3'; qBug  uuid := 'a1600000-0000-4000-8000-0000000000b3';
  coBug uuid := 'a1600000-0000-4000-8000-0000000000c3';
  jFix  uuid := 'a1600000-0000-4000-8000-0000000000a4'; qFix  uuid := 'a1600000-0000-4000-8000-0000000000b4';
  coFix uuid := 'a1600000-0000-4000-8000-0000000000c4';
  jStr  uuid := 'a1600000-0000-4000-8000-0000000000a5'; qStr  uuid := 'a1600000-0000-4000-8000-0000000000b5';
  coStrBefore uuid := 'a1600000-0000-4000-8000-0000000000c5'; coStrDuring uuid := 'a1600000-0000-4000-8000-0000000000c6';
  jFresh uuid := 'a1600000-0000-4000-8000-0000000000a6'; coFresh uuid := 'a1600000-0000-4000-8000-0000000000c7';

  qr public.quote_reapprovals%rowtype;
  restored boolean;
begin
  insert into companies(id, name) values (SC, 'PROBE-A16-LATCH');

  -- ====================================================================
  -- 0x  Reproduce the defect against the CURRENT, UNFIXED live functions
  -- ====================================================================
  insert into jobs(id, company_id, sync_id, customer_name, status, contract_total, accepted_total,
                    quote_approved_at, is_test_fixture)
    values (jBug, SC, jBug, 'A16 BUG', 'ACCEPTED', 9710, 9710, T1, true);
  insert into quote_reapprovals(id, company_id, job_id, job_sync_id, at, prior_approved_at,
      prior_contract_total, resolved_at)
    values (qBug, SC, jBug, jBug, T2, T1, 9710, null);
  update jobs set quote_approved_at = null, reapproval_required_at = T2 where id = jBug;
  insert into change_orders(id, company_id, sync_id, job_sync_id, description, additional_cost, signed_at, in_accepted_total)
    values (coBug, SC, coBug, jBug, 'Extra work signed during the withdrawn window', 500, T_DURING, false);

  select * into qr from public.quote_reapprovals where id = qBug;
  select public.reapp_restore_approval(jBug, null, qr) into restored;
  insert into r(k,got,want) values ('00 [BEFORE FIX] restore succeeds (price and job unchanged)', restored::text, 'true');
  insert into r(k,got,want) values ('01 [BEFORE FIX] approval is back', (select quote_approved_at::text from jobs where id=jBug), T1::text);
  insert into r(k,got,want) values ('02 [BEFORE FIX] THE DEFECT: order signed DURING the window gets wrongly marked covered',
    (select in_accepted_total::text from change_orders where id = coBug), 'true');

  -- ====================================================================
  -- Apply supabase_r10_restore_change_order_latch.sql's two functions,
  -- inside this same transaction only. Nothing here survives the rollback
  -- at the end of this script -- production is never touched.
  -- ====================================================================
  __FIX_SQL__

  -- ====================================================================
  -- 1x  No orders at all -- restore is a no-op on change_orders either way
  -- ====================================================================
  insert into jobs(id, company_id, sync_id, customer_name, status, contract_total, accepted_total,
                    quote_approved_at, is_test_fixture)
    values (jNo, SC, jNo, 'A16 NO ORDERS', 'ACCEPTED', 4000, 4000, T1, true);
  insert into quote_reapprovals(id, company_id, job_id, job_sync_id, at, prior_approved_at,
      prior_contract_total, resolved_at)
    values (qNo, SC, jNo, jNo, T2, T1, 4000, null);
  update jobs set quote_approved_at = null, reapproval_required_at = T2 where id = jNo;
  select * into qr from public.quote_reapprovals where id = qNo;
  select public.reapp_restore_approval(jNo, null, qr) into restored;
  insert into r(k,got,want) values ('10 [AFTER FIX] no orders: restore still succeeds', restored::text, 'true');
  insert into r(k,got,want) values ('11 [AFTER FIX] no orders: approval is back', (select quote_approved_at::text from jobs where id=jNo), T1::text);

  -- ====================================================================
  -- 2x  An order signed BEFORE the withdrawal -- still gets marked (it was
  --     already inside the price being restored)
  -- ====================================================================
  insert into jobs(id, company_id, sync_id, customer_name, status, contract_total, accepted_total,
                    quote_approved_at, is_test_fixture)
    values (jBef, SC, jBef, 'A16 SIGNED BEFORE', 'ACCEPTED', 6200, 6200, T1, true);
  insert into quote_reapprovals(id, company_id, job_id, job_sync_id, at, prior_approved_at,
      prior_contract_total, resolved_at)
    values (qBef, SC, jBef, jBef, T2, T1, 6200, null);
  update jobs set quote_approved_at = null, reapproval_required_at = T2 where id = jBef;
  insert into change_orders(id, company_id, sync_id, job_sync_id, description, additional_cost, signed_at, in_accepted_total)
    values (coBef, SC, coBef, jBef, 'Order signed before the withdrawal, never yet marked', 300, T_BEFORE, false);
  select * into qr from public.quote_reapprovals where id = qBef;
  select public.reapp_restore_approval(jBef, null, qr) into restored;
  insert into r(k,got,want) values ('20 [AFTER FIX] signed-before-withdrawal order still gets marked covered',
    (select in_accepted_total::text from change_orders where id = coBef), 'true');

  -- ====================================================================
  -- 3x  THE FIX: an order signed DURING the window now stays billable
  -- ====================================================================
  insert into jobs(id, company_id, sync_id, customer_name, status, contract_total, accepted_total,
                    quote_approved_at, is_test_fixture)
    values (jFix, SC, jFix, 'A16 FIXED', 'ACCEPTED', 9710, 9710, T1, true);
  insert into quote_reapprovals(id, company_id, job_id, job_sync_id, at, prior_approved_at,
      prior_contract_total, resolved_at)
    values (qFix, SC, jFix, jFix, T2, T1, 9710, null);
  update jobs set quote_approved_at = null, reapproval_required_at = T2 where id = jFix;
  insert into change_orders(id, company_id, sync_id, job_sync_id, description, additional_cost, signed_at, in_accepted_total)
    values (coFix, SC, coFix, jFix, 'Extra work signed during the withdrawn window', 500, T_DURING, false);
  select * into qr from public.quote_reapprovals where id = qFix;
  select public.reapp_restore_approval(jFix, null, qr) into restored;
  insert into r(k,got,want) values ('30 [AFTER FIX] restore still succeeds', restored::text, 'true');
  insert into r(k,got,want) values ('31 [AFTER FIX] approval is back', (select quote_approved_at::text from jobs where id=jFix), T1::text);
  insert into r(k,got,want) values ('32 [AFTER FIX] the SAME order signed during the window now stays billable (not marked)',
    (select in_accepted_total::text from change_orders where id = coFix), 'false');
  -- An order added AFTER the restore is untouched either way -- no jobs row
  -- update happens after this point, so the trigger cannot fire again.
  insert into change_orders(company_id, sync_id, job_sync_id, description, additional_cost, signed_at, in_accepted_total)
    values (SC, gen_random_uuid(), jFix, 'Signed after the restore', 250, now(), false);
  insert into r(k,got,want) values ('33 [AFTER FIX] a later order added after the restore stays unmarked, untouched',
    (select in_accepted_total::text from change_orders where job_sync_id = jFix and description = 'Signed after the restore'), 'false');

  -- ====================================================================
  -- 4x  Two orders straddling the withdrawal on the SAME job
  -- ====================================================================
  insert into jobs(id, company_id, sync_id, customer_name, status, contract_total, accepted_total,
                    quote_approved_at, is_test_fixture)
    values (jStr, SC, jStr, 'A16 STRADDLE', 'ACCEPTED', 8000, 8000, T1, true);
  insert into quote_reapprovals(id, company_id, job_id, job_sync_id, at, prior_approved_at,
      prior_contract_total, resolved_at)
    values (qStr, SC, jStr, jStr, T2, T1, 8000, null);
  update jobs set quote_approved_at = null, reapproval_required_at = T2 where id = jStr;
  insert into change_orders(id, company_id, sync_id, job_sync_id, description, additional_cost, signed_at, in_accepted_total)
    values (coStrBefore, SC, coStrBefore, jStr, 'Signed before the withdrawal', 400, T_BEFORE, false),
           (coStrDuring, SC, coStrDuring, jStr, 'Signed during the withdrawn window', 700, T_DURING, false);
  select * into qr from public.quote_reapprovals where id = qStr;
  select public.reapp_restore_approval(jStr, null, qr) into restored;
  insert into r(k,got,want) values ('40 [AFTER FIX] straddle: the pre-withdrawal order is marked covered',
    (select in_accepted_total::text from change_orders where id = coStrBefore), 'true');
  insert into r(k,got,want) values ('41 [AFTER FIX] straddle: the during-window order stays billable',
    (select in_accepted_total::text from change_orders where id = coStrDuring), 'false');

  -- ====================================================================
  -- 5x  Positive control: an ORDINARY fresh approval (no restore involved)
  --     still marks a pre-existing unmarked order -- the fix changes
  --     nothing about the path it was not written for.
  -- ====================================================================
  insert into jobs(id, company_id, sync_id, customer_name, status, contract_total, accepted_total,
                    quote_approved_at, is_test_fixture)
    values (jFresh, SC, jFresh, 'A16 FRESH APPROVAL', 'SENT', 5000, null, null, true);
  insert into change_orders(id, company_id, sync_id, job_sync_id, description, additional_cost, signed_at, in_accepted_total)
    values (coFresh, SC, coFresh, jFresh, 'Existed before the fresh approval', 300, T_BEFORE, false);
  update jobs set quote_approved_at = now(), accepted_total = 5000 where id = jFresh;
  insert into r(k,got,want) values ('50 [AFTER FIX] ordinary fresh approval (not a restore) still marks a pre-existing order',
    (select in_accepted_total::text from change_orders where id = coFresh), 'true');

  insert into r(k,got,want) values ('99 SUMMARY placeholder', 'x', 'x'); -- replaced by the SUMMARY row below
  delete from r where k = '99 SUMMARY placeholder';
end $body$;

select n, case when got = want then 'PASS' else 'FAIL' end as result, k as check_name, got, want
  from r
union all
select 999999, 'SUMMARY', 'passed/total',
  (select count(*) filter (where got = want)::text || '/' || count(*)::text from r),
  (select count(*)::text || '/' || count(*)::text from r)
order by 1;

rollback;
`;

function runProbe() {
  const sql = PROBE.replace("__FIX_SQL__", fix);
  const rows = runSql(sql);
  const failing = rows.filter((r) => r.result === "FAIL").map((r) => r.check_name);
  return { rows, failing, summary: rows.find((r) => r.result === "SUMMARY") };
}

test("LIVE: the defect reproduces against today's live functions, then this file's fix corrects it, in one rolled-back transaction",
  { skip: !LIVE }, () => {
    const res = runProbe();
    assert.ok(res.summary, "no SUMMARY row -- a lost check must not pass silently");
    assert.deepEqual(res.failing, [], JSON.stringify(res.rows.filter((r) => r.result === "FAIL"), null, 1));
    assert.ok(res.rows.length >= 14, `the probe ran fewer checks than it should have (${res.rows.length})`);
  });
