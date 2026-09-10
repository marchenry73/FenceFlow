// The two money reports Postgres computes for the office -- ar_aging() and
// job_costing(), both in supabase_money_report_guard.sql -- fall back to
// coalesce(jobs.contract_total, materials_sum + change_orders_sum) whenever
// contract_total hasn't synced down from the app. That fallback is missing
// labour, markup, tax, gates, teardown and the minimum charge, so a job stuck
// on it reads LOW. This is documented and deliberate; these checks exist so
// the day it actually happens is a loud one instead of a quiet under-billing.
//
// Read-only against the LIVE database, via the Supabase CLI's authenticated
// project link (`supabase db query --linked`) -- the same technique
// tests/golden-path.test.mjs uses. This is NOT a service_role key: it is the
// CLI's own session, used only to run plain `select`s. Nothing here writes.
//
//   node tests/money-report-guard.test.mjs

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT = "newcrgafcptspmapacrx";

let failed = 0, checked = 0;
const ok = (name, cond, detail = "") => {
  checked++;
  if (cond) { console.log(`  ok    ${name}`); return; }
  failed++;
  console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
};

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "money-guard-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query",
    "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
    { encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) {
    throw new Error(`supabase db query failed: ${r.stderr || r.stdout}`);
  }
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { throw new Error(`could not parse CLI output: ${r.stdout}`); }
  return Array.isArray(parsed) ? parsed : (parsed.rows || []);
}

/** Flip a comparison operator to prove a check can actually fail, and say so
 *  loudly -- this is the planted-failure run the task asks for, done in-line
 *  instead of by editing files on disk (there is nothing to edit: the SQL
 *  lives in this script, not in a guarded file). Each canary block runs the
 *  SAME query shape as the real check but with the condition inverted, so it
 *  is expected -- and required -- to find rows on live data. */

async function main() {
  // ---------------------------------------------------------- check 1 ---
  console.log("\n1. Money-bearing jobs currently on the crude fallback path:");
  console.log("   (a job in ACCEPTED or COMPLETED with jobs.contract_total is null --");
  console.log("    ar_aging/job_costing would then be quoting materials+CO only)");

  const fallbackSql = (statusList) => `
    select j.sync_id, j.status, j.customer_name
    from jobs j
    where j.deleted_at is null
      and j.status in (${statusList})
      and j.contract_total is null;`;

  const fallbackRows = runSql(fallbackSql("'ACCEPTED','COMPLETED'"));
  ok("no money-bearing job is reading the crude fallback today",
    fallbackRows.length === 0,
    `${fallbackRows.length} job(s) found: ${fallbackRows.map(r => r.sync_id).join(", ")}`);

  // CANARY: broaden the status list to every status a job can hold. On live
  // data this is expected to find rows (jobs get created before they are
  // priced, and an unpriced DRAFT/QUOTED job legitimately has no
  // contract_total yet) -- proving the check's machinery really does surface
  // rows when the condition matches, rather than always returning empty by
  // construction (a query typo, a wrong table, RLS silently scoping to
  // nothing).
  const canaryRows = runSql(fallbackSql("'DRAFT','QUOTED','ACCEPTED','COMPLETED','CANCELLED'"));
  ok("CANARY: widening the scope to all statuses finds jobs with no contract_total yet " +
     "(proves the query isn't vacuously empty)",
    canaryRows.length > 0,
    canaryRows.length === 0
      ? "found nothing even with every status included -- this check cannot be trusted, investigate the query"
      : `found ${canaryRows.length}, e.g. unpriced jobs -- as expected, and unrelated to check 1's own result`);

  // ---------------------------------------------------------- check 2 ---
  console.log("\n2. Change orders assumed already baked into contract_total:");
  console.log("   (flag: contract_total set, change orders exist, but contract_total");
  console.log("    equals the materials-only sum to the cent -- the CO clearly isn't in it)");

  const bakedInSql = (op) => `
    with materials as (
      select i.job_sync_id, sum(i.quantity * i.unit_price) as total
      from estimate_line_items i where i.deleted_at is null
      group by i.job_sync_id
    ),
    extras as (
      select c.job_sync_id, sum(c.additional_cost) as total
      from change_orders c where c.deleted_at is null
      group by c.job_sync_id
    )
    select j.sync_id, j.contract_total, m.total as materials_sum, x.total as co_sum
    from jobs j
    join extras x on x.job_sync_id = j.sync_id and x.total > 0.005
    left join materials m on m.job_sync_id = j.sync_id
    where j.deleted_at is null
      and j.contract_total is not null
      and round(j.contract_total::numeric,2) ${op} round(coalesce(m.total,0)::numeric,2);`;

  const notBakedIn = runSql(bakedInSql("="));
  ok("no job with change orders has a contract_total that ignores them",
    notBakedIn.length === 0,
    `${notBakedIn.length} suspicious job(s): ${notBakedIn.map(r => r.sync_id).join(", ")}`);

  // Live data currently has ZERO change orders at all (proved below), so
  // check 2's real query can only ever return empty right now -- not because
  // the logic is right, but because the case it's watching for doesn't exist
  // yet. That is exactly the trap this task warns about: a checker that never
  // sees the case reports zero failures for it, and a green run here would
  // otherwise be indistinguishable from "the query is broken" or "nobody has
  // a change order."
  //
  // The rule is: never write to the database to manufacture a case. So the
  // canary below proves the SAME equality logic on synthetic rows built with
  // a `VALUES` list inside the query -- no table is touched, nothing is
  // written -- covering exactly the "not baked in" and "correctly baked in"
  // shapes side by side.
  const coCountRows = runSql(`select count(*) as n from change_orders where deleted_at is null;`);
  const liveChangeOrders = Number(coCountRows[0]?.n ?? -1);

  const syntheticBakedInSql = `
    with fake_jobs(sync_id, contract_total) as (
      values ('fake-not-baked-in', 150.00::numeric), ('fake-correctly-baked-in', 999.00::numeric)
    ),
    fake_materials(job_sync_id, total) as (
      values ('fake-not-baked-in', 150.00::numeric), ('fake-correctly-baked-in', 150.00::numeric)
    ),
    fake_extras(job_sync_id, total) as (
      values ('fake-not-baked-in', 50.00::numeric), ('fake-correctly-baked-in', 50.00::numeric)
    )
    select j.sync_id
    from fake_jobs j
    join fake_extras x on x.job_sync_id = j.sync_id and x.total > 0.005
    left join fake_materials m on m.job_sync_id = j.sync_id
    where j.contract_total is not null
      and round(j.contract_total::numeric,2) = round(coalesce(m.total,0)::numeric,2);`;
  const synthetic = runSql(syntheticBakedInSql);
  ok("CANARY (synthetic, no table written): the equality logic flags the " +
     "'not baked in' shape and clears the 'correctly baked in' shape",
    synthetic.length === 1 && synthetic[0].sync_id === "fake-not-baked-in",
    `got ${JSON.stringify(synthetic)}`);
  ok("honesty check: live data has zero change orders today, so check 2's real " +
     "query is UNEXERCISED on live data -- 'clean' above means 'nothing to look at', not 'verified clean'",
    liveChangeOrders === 0,
    `expected this note to say 0; live change_orders count is actually ${liveChangeOrders} -- ` +
    `check 2's real result is now meaningful live data and should be trusted accordingly`);

  // ---------------------------------------------------------- check 3 ---
  console.log("\n3. jobs.amount_paid / refunded_amount vs the ledger they came from:");
  console.log("   (recompute_job_totals sums payment_records with no rounding;");
  console.log("    reports round to 2dp -- tolerance is 1 cent, not zero)");

  const ledgerSql = (tolerance) => `
    with ledger as (
      select p.job_sync_id,
             coalesce(sum(p.amount) filter (where p.amount >= 0), 0) as paid,
             coalesce(-sum(p.amount) filter (where p.amount < 0), 0) as refunded
      from payment_records p where p.deleted_at is null
      group by p.job_sync_id
    )
    select j.sync_id, j.amount_paid, j.refunded_amount,
           coalesce(l.paid,0) as ledger_paid, coalesce(l.refunded,0) as ledger_refunded
    from jobs j
    left join ledger l on l.job_sync_id = j.sync_id
    where j.deleted_at is null
      and (abs(coalesce(j.amount_paid,0) - coalesce(l.paid,0)) > ${tolerance}
           or abs(coalesce(j.refunded_amount,0) - coalesce(l.refunded,0)) > ${tolerance});`;

  const mismatches = runSql(ledgerSql("0.01"));
  ok("every job's stored amount_paid/refunded_amount agrees with its payment ledger",
    mismatches.length === 0,
    `${mismatches.length} mismatched job(s): ${JSON.stringify(mismatches)}`);

  // CANARY: drop the tolerance to a negative number, which no real difference
  // (even zero) can satisfy as "not exceeding" -- so on any live jobs.rows at
  // all, this must report every job as a "mismatch". This proves the
  // abs(...) > tolerance comparison actually drives the result, rather than
  // the query returning empty regardless of what's plugged in.
  const canary3 = runSql(ledgerSql("-1"));
  const totalJobs = runSql(`select count(*) as n from jobs where deleted_at is null;`)[0]?.n ?? 0;
  ok("CANARY: an impossible tolerance (-1) flags every live job, proving the " +
     "comparison is load-bearing and not silently always-empty",
    canary3.length > 0 && Number(totalJobs) > 0 && canary3.length === Number(totalJobs),
    `tolerance -1 flagged ${canary3.length} of ${totalJobs} jobs (want: all of them)`);

  // ------------------------------------------------------------- report ---
  console.log(`\n${checked - failed} of ${checked} checks passed`);
  if (failed) process.exit(1);
}

main().catch(e => { console.error("could not run:", e.message); process.exit(2); });
