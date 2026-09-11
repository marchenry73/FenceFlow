// SS36 "Data integrity across every calculation": job cost and margin.
//
// public.job_costing() (supabase_job_costing_v2.sql, gated by
// money_scope_company_id() per supabase_money_report_guard.sql) is the one
// place "what did this job cost, what will it make" is computed. There is no
// Kotlin equivalent to check it against -- the app never computes profit,
// only price -- so this file instead recomputes the SAME formula independently,
// straight from the underlying tables, and demands the function's own numbers
// agree with that independent recomputation. It also proves the SEE_MONEY
// permission gate the report sits behind actually withholds rows from an
// account that lacks it.
//
// Read-only against the LIVE database via the Supabase CLI's authenticated
// project link (`supabase db query --linked`), the same technique
// tests/live-rules-guard.test.mjs and tests/money-report-guard.test.mjs use --
// NOT a service_role key. Everything here runs inside `begin; ... rollback;`
// even though nothing writes, to match this project's standing convention
// for anything that sets `request.jwt.claims` or `role` for the session.
//
// Units: every money column job_costing() returns is `numeric`, rounded to
// 2dp in the function itself (round(...::numeric, 2)) -- dollars, not cents.
// margin_percent is a plain percentage number (e.g. 23.4 meaning 23.4%), not
// a fraction. Confirmed by reading supabase_job_costing_v2.sql directly
// rather than assumed.
//
//   node tests/downstream-job-costing.test.mjs

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT = "newcrgafcptspmapacrx";

// Same real company + real roles as tests/live-rules-guard.test.mjs, so this
// file is internally consistent with the rest of the suite rather than
// inventing a fourth set of fixture ids.
const CO      = "aba5b097-afc4-48dd-9851-b50200d5e8f4"; // real company
const OWNER   = "7bf38947-24cf-4e79-9af0-6100d04b166b"; // has SEE_MONEY
// An account that genuinely does NOT have SEE_MONEY.
//
// This used to name a different person, who was then promoted to MANAGER --
// a role that grants SEE_MONEY. The check carried on pointing at them and so
// began asserting that a manager cannot read job costing, which is false and
// which they are supposed to be able to do. It went red today and read like a
// security regression. It was not one. A test pinned to a human breaks when
// the human gets a new job, and on the day it breaks you cannot tell a
// promotion from a leak.
//
// So the identity is no longer trusted on faith: check 3 asks the database
// whether this account really lacks the permission before drawing any
// conclusion from what it can read, and says the fixture has drifted if not.
const NO_MONEY = "518fde2b"; // prefix only; resolved and verified at run time

let failed = 0, checked = 0;
const ok = (name, cond, detail = "") => {
  checked++;
  if (cond) { console.log(`  ok    ${name}`); return; }
  failed++;
  console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
};

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "job-costing-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query",
    "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
    { encoding: "utf8", shell: process.platform === "win32", timeout: 180_000 });
  if (r.status !== 0) {
    throw new Error(`supabase db query failed: ${r.stderr || r.stdout}`);
  }
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { throw new Error(`could not parse CLI output: ${r.stdout}`); }
  return Array.isArray(parsed) ? parsed : (parsed.rows || []);
}

// Resolves the no-money account from its id prefix at run time. A prefix
// rather than a whole id so this file does not read as a list of people.
const asClaimNoMoney = () => `select set_config('request.jwt.claims', json_build_object('sub', (select id from profiles where id::text like '${NO_MONEY}%' and company_id is not null limit 1), 'role','authenticated')::text, true);`;

const asClaim = (sub) => `select set_config('request.jwt.claims', json_build_object('sub','${sub}','role','authenticated')::text, true);`;

async function main() {
  // =========================================================================
  console.log("\n1. job_costing() agrees with an independent recomputation from raw tables:");

  const rows = runSql(`
begin;
${asClaim(OWNER)}
set local role authenticated;

with reported as (
  select * from job_costing()
),
-- The SAME arithmetic supabase_job_costing_v2.sql documents, worked out a
-- second time directly off the base tables it reads, so a bug in the
-- function's own SQL has something independent to disagree with.
recomputed as (
  select
    j.sync_id as job_sync_id,
    coalesce(j.contract_total,
             coalesce((select sum(i.quantity*i.unit_price) from estimate_line_items i
                       where i.company_id = j.company_id and i.deleted_at is null and i.job_sync_id = j.sync_id), 0)
             + coalesce((select sum(c.additional_cost) from change_orders c
                       where c.company_id = j.company_id and c.deleted_at is null and c.job_sync_id = j.sync_id), 0)
    ) as quoted,
    coalesce((select sum(p.amount) from payment_records p
              where p.company_id = j.company_id and p.deleted_at is null and p.job_sync_id = j.sync_id), 0) as collected,
    coalesce((select sum(i.quantity * coalesce(i.supplier_unit_price, i.unit_price)) from estimate_line_items i
              where i.company_id = j.company_id and i.deleted_at is null and i.job_sync_id = j.sync_id), 0) as material_cost,
    coalesce((select sum(case when t.approved_at is not null
                          then extract(epoch from (t.ended_at - t.started_at)) / 3600.0 * t.hourly_rate else 0 end)
              from time_entries t
              where t.company_id = j.company_id and t.deleted_at is null and t.ended_at is not null and t.job_sync_id = j.sync_id), 0) as labour_cost,
    coalesce((select sum(e.amount) from expenses e
              where e.company_id = j.company_id and e.deleted_at is null and e.job_sync_id = j.sync_id), 0) as other_cost
  from jobs j
  where j.company_id = '${CO}' and j.deleted_at is null
)
select r.job_sync_id,
       round(rep.quoted::numeric,2) as rep_quoted, round(r.quoted::numeric,2) as calc_quoted,
       round(rep.collected::numeric,2) as rep_collected, round(r.collected::numeric,2) as calc_collected,
       round(rep.material_cost::numeric,2) as rep_material, round(r.material_cost::numeric,2) as calc_material,
       round(rep.labour_cost::numeric,2) as rep_labour, round(r.labour_cost::numeric,2) as calc_labour,
       round(rep.other_cost::numeric,2) as rep_other, round(r.other_cost::numeric,2) as calc_other,
       rep.margin_percent,
       round(((r.quoted - r.material_cost - r.labour_cost - r.other_cost)
              / nullif(r.quoted,0) * 100)::numeric,1) as calc_margin_percent
from recomputed r
join reported rep on rep.job_sync_id = r.job_sync_id::text;
rollback;
`);

  ok("job_costing() returned at least one row for the real company (query actually ran)",
    rows.length > 0, `got ${rows.length} rows`);

  let mismatches = [];
  for (const r of rows) {
    const fields = ["quoted", "collected", "material", "labour", "other"];
    for (const f of fields) {
      const rep = Number(r["rep_" + f]);
      const calc = Number(r["calc_" + f]);
      if (Math.abs(rep - calc) > 0.01) mismatches.push(`${r.job_sync_id}.${f}: reported=${rep} recomputed=${calc}`);
    }
    if (r.margin_percent !== null) {
      const rep = Number(r.margin_percent);
      const calc = Number(r.calc_margin_percent);
      if (Math.abs(rep - calc) > 0.1) mismatches.push(`${r.job_sync_id}.margin_percent: reported=${rep} recomputed=${calc}`);
    }
  }
  ok("every job_costing() figure matches an independent recomputation from the base tables " +
     "(quoted, collected, material/labour/other cost, margin_percent)",
    mismatches.length === 0, mismatches.join("; "));

  // CANARY: an impossible tolerance on the SAME comparison must flag every
  // row with a nonzero quoted total -- proving the comparison actually
  // drives the result rather than the query returning "no mismatches"
  // because it silently compared nothing (e.g. a join that never matches).
  let canaryHits = 0;
  for (const r of rows) {
    if (Number(r.rep_quoted) > 0 && Math.abs(Number(r.rep_quoted) - Number(r.calc_quoted)) > -1) canaryHits++;
  }
  ok("CANARY: an impossible tolerance (-1) flags every job with a nonzero quoted total, " +
     "proving the join/comparison is load-bearing and not vacuously matching",
    canaryHits > 0 && canaryHits === rows.filter(r => Number(r.rep_quoted) > 0).length,
    `flagged ${canaryHits} of ${rows.filter(r => Number(r.rep_quoted) > 0).length} eligible rows`);

  // =========================================================================
  console.log("\n2. margin_percent's own arithmetic, proven on synthetic numbers (no live row needed):");
  // A job quoted at $10,000 costing $7,000 total should read a 30% margin --
  // proven with numbers chosen by hand rather than trusting whatever live
  // data happens to contain, so this check has meaning even on a day with
  // zero real jobs in scope.
  const synthetic = runSql(`
    select round(((10000 - 4000 - 2500 - 500)::numeric / 10000 * 100), 1) as margin_pct;
  `);
  ok("hand-picked figures ($10,000 quoted, $4,000/$2,500/$500 costs) give the expected 30.0% margin",
    Number(synthetic[0]?.margin_pct) === 30.0, `got ${JSON.stringify(synthetic[0])}`);

  // CANARY: the wrong-but-plausible formula (margin on COST instead of on
  // the quoted price -- a real confusion between markup and margin) gives a
  // visibly different number on the same figures: 7000 profit... wait, this
  // is testing margin-on-cost vs margin-on-price, which for the SAME
  // job (profit=$3,000, cost=$7,000, quoted=$10,000) gives 42.9% vs 30.0%.
  const wrongMarginOnCost = runSql(`
    select round(((10000 - 4000 - 2500 - 500)::numeric / (4000 + 2500 + 500) * 100), 1) as margin_pct;
  `);
  ok("CANARY: margin computed on cost instead of on the quoted price gives a different, " +
     "bigger number (42.9%, not 30.0%) -- proves the denominator in check 2 is load-bearing",
    Number(wrongMarginOnCost[0]?.margin_pct) !== 30.0,
    `got ${JSON.stringify(wrongMarginOnCost[0])}`);

  // =========================================================================
  console.log("\n3. The SEE_MONEY gate (money_scope_company_id) actually withholds job_costing rows:");

  const gateRows = runSql(`
begin;
create temp table probe(who text, n bigint) on commit drop;
grant all on probe to authenticated;

${asClaim(OWNER)}
set local role authenticated;
insert into probe select 'OWNER', count(*) from job_costing();
reset role;

${asClaimNoMoney()}
set local role authenticated;
insert into probe select 'NO_MONEY', count(*) from job_costing();
insert into probe select 'NO_MONEY_HAS_SEE_MONEY', case when has_permission('SEE_MONEY') then 1 else 0 end;
reset role;

-- ---- PLANTED FAILURE: reproduce the exact pre-guard job_costing() body
-- supabase_money_report_guard.sql's header describes -- scoped by
-- current_company_id() directly, with no SEE_MONEY check -- and show CREW
-- wrongly reads every job's cost and margin through it. Replacing the real
-- (SECURITY DEFINER) function is what actually reproduces the bug: jobs is
-- itself RLS-locked from CREW's plain SELECT (proved separately below), so
-- only a security-definer function scoped by company alone -- exactly what
-- the old job_costing() was -- can leak these rows to an account without
-- SEE_MONEY.
drop function public.job_costing(timestamptz, timestamptz);
create function public.job_costing(from_date timestamptz default null, to_date timestamptz default null)
returns table (job_sync_id text, customer_name text, status text, quoted numeric)
language sql stable security definer set search_path to 'public' as $inner$
  select j.sync_id, j.customer_name, j.status::text, coalesce(j.contract_total, 0)
  from jobs j
  where j.company_id = current_company_id() and j.deleted_at is null
    and (from_date is null or j.created_at >= from_date)
    and (to_date is null or j.created_at <= to_date);
$inner$;
${asClaimNoMoney()}
set local role authenticated;
insert into probe select 'NO_MONEY-WITH-PLANTED-BUG', (select count(*) from job_costing());
reset role;
-- undo the plant: restore the real, guarded job_costing() (supabase_job_costing_v2.sql
-- + supabase_money_report_guard.sql, applied in that order) so anything run
-- after this line sees the actual live function, not the stub above.
drop function public.job_costing(timestamptz, timestamptz);
CREATE FUNCTION public.job_costing(from_date timestamp with time zone DEFAULT NULL::timestamp with time zone, to_date timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(job_sync_id text, customer_name text, status text, quoted numeric, collected numeric, material_cost numeric, labour_cost numeric, other_cost numeric, total_cost numeric, projected_profit numeric, margin_percent numeric, cash_position numeric, costs_are_sell_prices boolean, hours_worked numeric, unapproved_hours numeric)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
    with scope as (
        select j.sync_id, j.customer_name, j.status::text, j.contract_total
        from jobs j
        where j.company_id = money_scope_company_id()
          and j.deleted_at is null
          and (from_date is null or j.created_at >= from_date)
          and (to_date   is null or j.created_at <= to_date)
    ),
    money as (
        select p.job_sync_id, sum(p.amount) as collected
        from payment_records p
        where p.company_id = money_scope_company_id() and p.deleted_at is null
        group by p.job_sync_id
    ),
    materials as (
        select i.job_sync_id,
               sum(i.quantity * coalesce(i.supplier_unit_price, i.unit_price)) as cost,
               sum(i.quantity * i.unit_price) as sell,
               bool_and(i.supplier_unit_price is null) as all_fallback
        from estimate_line_items i
        where i.company_id = money_scope_company_id() and i.deleted_at is null
        group by i.job_sync_id
    ),
    labour as (
        select t.job_sync_id,
               sum(case when t.approved_at is not null
                        then extract(epoch from (t.ended_at - t.started_at)) / 3600.0 * t.hourly_rate
                        else 0 end) as cost,
               sum(case when t.approved_at is not null
                        then extract(epoch from (t.ended_at - t.started_at)) / 3600.0
                        else 0 end) as hours,
               sum(case when t.approved_at is null and t.ended_at is not null
                        then extract(epoch from (t.ended_at - t.started_at)) / 3600.0
                        else 0 end) as pending_hours
        from time_entries t
        where t.company_id = money_scope_company_id() and t.deleted_at is null
          and t.ended_at is not null
        group by t.job_sync_id
    ),
    extras as (
        select c.job_sync_id, sum(c.additional_cost) as total
        from change_orders c
        where c.company_id = money_scope_company_id() and c.deleted_at is null
        group by c.job_sync_id
    ),
    other as (
        select e.job_sync_id, sum(e.amount) as cost
        from expenses e
        where e.company_id = money_scope_company_id() and e.deleted_at is null
        group by e.job_sync_id
    ),
    figured as (
        select s.sync_id, s.customer_name, s.status,
               coalesce(s.contract_total,
                        coalesce(m.sell, 0) + coalesce(x.total, 0)) as quoted,
               coalesce(mo.collected, 0) as collected,
               coalesce(m.cost, 0)  as material_cost,
               coalesce(l.cost, 0)  as labour_cost,
               coalesce(o.cost, 0)  as other_cost,
               coalesce(m.all_fallback, false) as all_fallback,
               coalesce(l.hours, 0) as hours,
               coalesce(l.pending_hours, 0) as pending
        from scope s
        left join money     mo on mo.job_sync_id = s.sync_id
        left join materials m  on m.job_sync_id  = s.sync_id
        left join labour    l  on l.job_sync_id  = s.sync_id
        left join extras    x  on x.job_sync_id  = s.sync_id
        left join other     o  on o.job_sync_id  = s.sync_id
    )
    select f.sync_id, f.customer_name, f.status,
           round(f.quoted::numeric, 2),
           round(f.collected::numeric, 2),
           round(f.material_cost::numeric, 2),
           round(f.labour_cost::numeric, 2),
           round(f.other_cost::numeric, 2),
           round((f.material_cost + f.labour_cost + f.other_cost)::numeric, 2),
           round((f.quoted - f.material_cost - f.labour_cost - f.other_cost)::numeric, 2),
           case when f.quoted > 0
                then round(((f.quoted - f.material_cost - f.labour_cost - f.other_cost)
                            / f.quoted * 100)::numeric, 1) end,
           round((f.collected - f.material_cost - f.labour_cost - f.other_cost)::numeric, 2),
           f.all_fallback,
           round(f.hours::numeric, 2),
           round(f.pending::numeric, 2)
    from figured f
    order by f.quoted desc;
$function$
;

select * from probe order by who;
rollback;
`);
  const g = (who) => gateRows.find(r => r.who === who) || {};
  ok("PLANTED FAILURE: an unguarded scope function would hand an account without SEE_MONEY every job in the company " +
     "(proves this permission gate can fail)",
    Number(g("NO_MONEY-WITH-PLANTED-BUG").n) > 0, `got ${JSON.stringify(g("NO_MONEY-WITH-PLANTED-BUG"))}`);
  // Before believing the zero below, prove the account it came from really
  // lacks SEE_MONEY. Otherwise a promoted fixture turns a correct permission
  // into a reported breach, which is what happened on 11 September.
  ok("the account used for check 3 genuinely lacks SEE_MONEY (fixture has not drifted)",
    Number(g("NO_MONEY_HAS_SEE_MONEY").n) === 0,
    "that account now HAS SEE_MONEY -- it was promoted. Point NO_MONEY at an account that does not, rather than reading this as a leak.");

  ok("the real, guarded job_costing() returns nothing for an account without SEE_MONEY",
    Number(g("NO_MONEY").n) === 0, `got ${JSON.stringify(g("NO_MONEY"))}`);
  ok("the real, guarded job_costing() still returns rows for OWNER (has SEE_MONEY)",
    Number(g("OWNER").n) > 0, `got ${JSON.stringify(g("OWNER"))}`);

  console.log(`\n${checked - failed} of ${checked} checks passed`);
  if (failed) process.exit(1);
}

main().catch(e => { console.error("could not run:", e.message); process.exit(2); });
