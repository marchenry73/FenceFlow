// The COMPANY half of lead-to-cash: signup -> setup -> quote -> schedule ->
// build -> invoice -> paid -> books agree. golden-path.test.mjs already
// covers the customer half end to end; this is the other side of the same
// transaction, and until now nothing has ever run it start to finish.
//
// Everything here runs inside `begin; ... rollback;` via the Supabase CLI's
// own authenticated project link (`supabase db query --linked`) -- the same
// technique tests/live-rules-guard.test.mjs and tests/money-report-guard.test.mjs
// use. This is NOT a service_role key: it is the CLI's own session, used only
// to run plain SQL, which is why a `create or replace function` or an insert
// into auth.users works here the same way it does in live-rules-guard.
//
// Every check in this file follows the one rule that outranks the others:
// plant the exact failure the check exists to catch, watch it fail, undo the
// plant, then run the real rule and watch it pass. A check that has never
// failed has never been tested.
//
// Safety, which matters more than any bug this is looking for:
//   - Every statement is scoped to one of the three fixture companies from
//     supabase_test_companies.sql, all named "ZZ TEST", ids fixed and
//     obviously synthetic. Nothing here ever touches a company whose name
//     does not begin "ZZ TEST".
//   - No real person's profile or auth user is ever read, written, or
//     impersonated. Where a check needs a signed-in OWNER of a ZZ TEST
//     company, this file creates its own throwaway auth.users + profiles
//     rows scoped to that company, inside the same transaction that rolls
//     them back -- it never repurposes a real account the way
//     live-rules-guard.test.mjs (a file this task does not own or edit)
//     temporarily reassigns a real profile's company_id.
//   - Impersonation is `set local role authenticated` PLUS the `role` claim
//     in `request.jwt.claims` -- without the claim every RLS-scoped count
//     comes back zero and every check passes for the wrong reason.
//   - No service_role key anywhere.
//
//   node tests/company-golden-path.test.mjs

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = "newcrgafcptspmapacrx";

// The three fixture companies -- see supabase_test_companies.sql.
const ZZ_NEW    = "22222222-2222-4222-8222-222222222001"; // brand new, nothing set up
const ZZ_LAPSED = "22222222-2222-4222-8222-222222222002"; // past_due, suspended
const ZZ_BUSY   = "22222222-2222-4222-8222-222222222003"; // Pro, active, jobs in every state

// Jobs on the busy company, one per state -- from supabase_test_companies.sql.
const JOB_NO_PRICE  = "33333333-0000-4000-8000-000000000001"; // DRAFT, no contract_total
const JOB_ACCEPTED  = "33333333-0000-4000-8000-000000000003"; // ACCEPTED, contract_total 8600, amount_paid 0

// Throwaway identities this file creates and rolls back itself. Fixed ids so
// a failed run's leftovers (there should never be any -- everything is
// inside ROLLBACK) are easy to recognise and are never mistaken for a real
// account.
const OWNER_NEW = "99999999-0000-4000-8000-0000000000a1"; // synthetic OWNER of ZZ_NEW
const OWNER_BUSY = "99999999-0000-4000-8000-0000000000a3"; // synthetic OWNER of ZZ_BUSY

// A fixed pricing fixture -- a job, one fence run, one catalog item -- for the
// PRICING check. Mirrors the hand-built rows in
// supabase/functions/_shared/pricing/load_test.ts (same shapes price-job
// itself selects), so the numbers here are known-good engine inputs, not
// invented ones.
const PRICE_JOB_SYNC   = "99999999-1000-4000-8000-000000000001";
const PRICE_RUN_SYNC   = "99999999-1000-4000-8000-000000000002";
const PRICE_ITEM_SYNC  = "99999999-1000-4000-8000-000000000003";

let failed = 0, checked = 0;
const ok = (name, cond, detail = "") => {
  checked++;
  if (cond) { console.log(`  ok    ${name}`); return; }
  failed++;
  console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
};

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "company-golden-"));
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

const asClaim = (sub) =>
  `select set_config('request.jwt.claims', json_build_object('sub','${sub}','role','authenticated')::text, true);`;

/** Runs the real server pricing engine (never a re-implementation of it) on
 *  the given Db*Row-shaped payload, via tests/company-golden-path.pricing-runner.mts.
 *  Returns { output, engineVersion }. */
function priceViaRealEngine(payload) {
  const r = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["-y", "tsx", resolve(__dirname, "company-golden-path.pricing-runner.mts")],
    { input: JSON.stringify(payload), encoding: "utf8", shell: process.platform === "win32", timeout: 60_000 },
  );
  if (r.status !== 0) {
    throw new Error(`pricing runner failed: ${r.stderr || r.stdout}`);
  }
  return JSON.parse(r.stdout);
}

async function main() {
  // =========================================================================
  console.log("\n1. SETUP -- a brand new company, taken to able-to-quote:");
  console.log("   (my_setup_progress() on ZZ_NEW: nothing set, then each blocker filled");
  console.log("    in turn, then the payment step -- which must tell a chosen processor");
  console.log("    apart from a finished connection)");

  const check1 = runSql(`
begin;
create temp table probe1(case_name text, step text, done boolean) on commit drop;
grant all on probe1 to authenticated;

-- A throwaway OWNER of ZZ_NEW, scoped to this transaction only. Never a real
-- auth user or profile -- both rows are new, both are gone on rollback.
insert into auth.users(id) values ('${OWNER_NEW}');
insert into profiles(id, company_id, role, full_name)
  values ('${OWNER_NEW}', '${ZZ_NEW}', 'OWNER', 'ZZ TEST Setup Owner');

${asClaim(OWNER_NEW)}
set local role authenticated;
insert into probe1 select 'baseline (nothing set up)', step, done from my_setup_progress();
reset role;

-- Fill in every blocker my_setup_progress can see from the website: the four
-- pricing numbers, one catalog item, one pricing tier, and a processor that
-- has been CHOSEN but never finished (external_id blank) -- the state the
-- task calls out specifically.
insert into company_settings(company_id, settings) values ('${ZZ_NEW}',
  jsonb_build_object('labor_rate', 8.5, 'markup', 20, 'tax_rate', 7, 'min_job_charge', 250))
  on conflict (company_id) do update set settings = excluded.settings;
insert into material_items(company_id, sync_id, name, unit_price)
  values ('${ZZ_NEW}', gen_random_uuid(), 'ZZ TEST Panel', 52.35);
insert into pricing_tiers(company_id, sync_id, name)
  values ('${ZZ_NEW}', gen_random_uuid(), 'ZZ TEST Standard');
insert into payment_connections(company_id, processor, external_id)
  values ('${ZZ_NEW}', 'stripe', '')
  on conflict (company_id) do update set processor = excluded.processor, external_id = excluded.external_id;

${asClaim(OWNER_NEW)}
set local role authenticated;
insert into probe1
  select 'after filling numbers/catalog/tier, processor CHOSEN but not finished', step, done
  from my_setup_progress();
reset role;

-- Finish the connection for real.
update payment_connections set external_id = 'acct_ZZTEST123' where company_id = '${ZZ_NEW}';

${asClaim(OWNER_NEW)}
set local role authenticated;
insert into probe1 select 'after the connection actually finishes', step, done from my_setup_progress();
reset role;

-- ---- PLANTED FAILURE: recreate the bug the payment step exists to catch --
-- a version that calls the connection done because a processor was CHOSEN,
-- never checking whether it finished (external_id blank again here).
update payment_connections set external_id = '' where company_id = '${ZZ_NEW}';
create or replace function public.my_setup_progress()
 returns table(step text, label text, detail text, done boolean, essential boolean, where_to_go text)
 language sql stable security definer set search_path to 'public'
as $inner$
with me as (select c.id, c.subscription_plan from companies c
            where c.id = (select company_id from profiles where id = auth.uid()))
select 'card_payments'::text, 'Taking card payments'::text, ''::text,
       exists (select 1 from payment_connections pc, me
                where pc.company_id = me.id and coalesce(pc.processor,'none') <> 'none'),
       false, 'settings'::text;
$inner$;

${asClaim(OWNER_NEW)}
set local role authenticated;
insert into probe1
  select 'PLANTED-BUG: chosen-but-unfinished processor wrongly reads done', step, done
  from my_setup_progress() where step = 'card_payments';
reset role;

-- undo the plant: restore the real, live definition (supabase_setup_step_card_payments.sql)
CREATE OR REPLACE FUNCTION public.my_setup_progress()
 RETURNS TABLE(step text, label text, detail text, done boolean, essential boolean, where_to_go text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
with me as (
    select c.id, c.subscription_plan
      from companies c
     where c.id = (select company_id from profiles where id = auth.uid())
),
s as (
    select cs.settings from company_settings cs, me where cs.company_id = me.id
),
num as (
    select
      (select case when (select settings->>'labor_rate' from s) ~ '^-?[0-9]+([.][0-9]+)?$'
                   then ((select settings->>'labor_rate' from s))::numeric end)     as labour,
      (select case when (select settings->>'markup' from s) ~ '^-?[0-9]+([.][0-9]+)?$'
                   then ((select settings->>'markup' from s))::numeric end)         as markup,
      (select case when (select settings->>'tax_rate' from s) ~ '^-?[0-9]+([.][0-9]+)?$'
                   then ((select settings->>'tax_rate' from s))::numeric end)       as tax,
      (select case when (select settings->>'min_job_charge' from s) ~ '^-?[0-9]+([.][0-9]+)?$'
                   then ((select settings->>'min_job_charge' from s))::numeric end) as min_charge
),
counts as (
    select
      (select count(*) from material_items m, me where m.company_id = me.id and m.deleted_at is null) as catalog,
      (select count(*) from pricing_tiers t, me  where t.company_id = me.id and t.deleted_at is null) as tiers,
      (select count(*) from employees e, me      where e.company_id = me.id and e.deleted_at is null) as crew
)
select * from (values
  ('labour_rate', 'What you charge for labour', ''::text,
   (select labour from num) is not null and (select labour from num) > 0, true, 'settings'),
  ('markup', 'Your markup', ''::text,
   (select markup from num) is not null, true, 'settings'),
  ('min_charge', 'Your minimum job charge', ''::text,
   (select min_charge from num) is not null and (select min_charge from num) > 0, true, 'settings'),
  ('tax_rate', 'Your sales tax rate', ''::text,
   (select tax from num) is not null, true, 'settings'),
  ('catalog', 'Your supplier prices', ''::text,
   (select catalog from counts) > 0, false, 'catalog'),
  ('tiers', 'Your pricing tiers', ''::text,
   (select tiers from counts) > 0, false, 'catalog'),
  ('card_payments', 'Taking card payments', ''::text,
   exists (select 1 from payment_connections pc, me
            where pc.company_id = me.id
              and coalesce(pc.processor, 'none') <> 'none'
              and coalesce(pc.external_id, '') <> ''),
   false, 'settings'),
  ('crew', 'Your crew', ''::text,
   (select lower(coalesce(subscription_plan,'')) from me) = 'solo'
     or (select crew from counts) > 0,
   false, 'crew')
) as t(step, label, detail, done, essential, where_to_go);
$function$;

-- prove the fix landed AND that a real re-finish flips card_payments back
update payment_connections set external_id = 'acct_ZZTEST123' where company_id = '${ZZ_NEW}';
${asClaim(OWNER_NEW)}
set local role authenticated;
insert into probe1 select 'after restoring the real rule and re-finishing', step, done from my_setup_progress();
reset role;

select * from probe1 order by case_name, step;
rollback;
`);
  const rowsFor = (label) => check1.filter(r => r.case_name === label);
  const stepDone = (label, step) => rowsFor(label).find(r => r.step === step)?.done;

  const baseline = rowsFor("baseline (nothing set up)");
  ok("baseline: essential steps (labour, markup, min_charge, tax_rate) all read as not done",
     ["labour_rate", "markup", "min_charge", "tax_rate"].every(s => stepDone("baseline (nothing set up)", s) === false),
     JSON.stringify(baseline));
  ok("baseline: catalog and tiers read as not done", stepDone("baseline (nothing set up)", "catalog") === false
     && stepDone("baseline (nothing set up)", "tiers") === false);
  ok("baseline: crew reads DONE anyway -- ZZ_NEW is on Solo, where the owner IS the crew",
     stepDone("baseline (nothing set up)", "crew") === true, JSON.stringify(baseline));
  ok("baseline: card_payments reads as not done (no processor at all)",
     stepDone("baseline (nothing set up)", "card_payments") === false);

  const filled = "after filling numbers/catalog/tier, processor CHOSEN but not finished";
  ok("filling the four numbers flips them all to done",
     ["labour_rate", "markup", "min_charge", "tax_rate"].every(s => stepDone(filled, s) === true),
     JSON.stringify(rowsFor(filled)));
  ok("adding a catalog item flips catalog to done", stepDone(filled, "catalog") === true);
  ok("adding a pricing tier flips tiers to done", stepDone(filled, "tiers") === true);
  ok("REAL RULE: a processor merely CHOSEN (blank external_id) still reads card_payments = not done",
     stepDone(filled, "card_payments") === false, JSON.stringify(rowsFor(filled)));

  const finished = "after the connection actually finishes";
  ok("REAL RULE: once the connection actually finishes, card_payments flips to done",
     stepDone(finished, "card_payments") === true, JSON.stringify(rowsFor(finished)));

  ok("PLANTED FAILURE: a chosen-but-unfinished processor wrongly reads card_payments = done " +
     "(proves this check can fail)",
     stepDone("PLANTED-BUG: chosen-but-unfinished processor wrongly reads done", "card_payments") === true,
     JSON.stringify(rowsFor("PLANTED-BUG: chosen-but-unfinished processor wrongly reads done")));

  const restored = "after restoring the real rule and re-finishing";
  ok("after restoring the real function, a genuinely finished connection reads done again",
     stepDone(restored, "card_payments") === true, JSON.stringify(rowsFor(restored)));

  // =========================================================================
  console.log("\n2. PRICING -- create a job, price it through the server, read the total back:");
  console.log("   (uses the REAL server engine -- supabase/functions/_shared/pricing --");
  console.log("    the same code price-job/index.ts calls, via");
  console.log("    tests/company-golden-path.pricing-runner.mts. The parity gate between");
  console.log("    the phone and server engines is scripts/check-parity.mjs and is not");
  console.log("    duplicated here. What IS untested elsewhere: create -> price -> read back.");
  console.log("    price-job itself is an edge function gated on a real signed-in OWNER/");
  console.log("    MANAGER session; no such login exists for a synthetic ZZ TEST company and");
  console.log("    creating one would need the Admin API (service_role), which is off limits");
  console.log("    here -- see the report for what that leaves untested.)");

  // A known-good engine input, matching the fixtures in
  // supabase/functions/_shared/pricing/load_test.ts.
  const jobRow = {
    sync_id: PRICE_JOB_SYNC, updated_at: "2026-09-04T12:00:00Z",
    calibration_pixels_per_foot: null, tax_rate_percent: 7, markup_percent: 15,
    discount_percent: 0, labor_rate_per_ft: 8, labor_flat_fee: 0, minimum_job_charge: 200,
    waste_percent: 0, gate_rate_per_ft: 20, trash_haul_fee: 0, teardown_enabled: false,
    teardown_flat_fee: 0, teardown_rate_per_ft: 0, teardown_feet: 0, preferred_manufacturer_sync_id: null,
  };
  const runRow = {
    sync_id: PRICE_RUN_SYNC, label: "ZZ TEST Back", fence_type: "VINYL", color_or_finish: "White",
    points_encoded: "", gates_encoded: "", closed_loop: false, manual_linear_feet: 100,
    manual_corner_count: 0, panel_width_ft: 6, panel_height_ft: 6, post_spacing_ft: 6,
    concrete_bags_per_post: 1, aluminum_style: "RACKABLE", wood_style: "PRIVACY", wood_rail_count: 3,
    picket_width_in: 5.5, picket_gap_in: 0, fabric_height_ft: 4, include_top_rail: true,
    include_tension_wire: false, include_barbed_wire_arms: false, include_privacy_slats: false,
    split_rail_count: 2, suppressed_roles: "", is_teardown: false, sort_order: 0,
  };
  const catalogRow = {
    sync_id: PRICE_ITEM_SYNC, name: "ZZ TEST Panel", category: "MISC", role: "PANEL",
    fence_type: "VINYL", color_or_finish: "White", unit: "EA", unit_price: 52.35, taxable: true,
    covers_ft: 6, manufacturer_sync_id: null, is_active: true,
  };

  // Step A -- create the job for real, in the database, scoped to ZZ_NEW, and
  // read the exact rows back out with the exact column list price-job itself
  // selects (JOB_COLUMNS / RUN_COLUMNS / CATALOG_COLUMNS in
  // supabase/functions/price-job/index.ts) to prove the write really landed.
  const created = runSql(`
begin;
insert into jobs(company_id, sync_id, customer_name, status,
                  tax_rate_percent, markup_percent, discount_percent, labor_rate_per_ft,
                  labor_flat_fee, minimum_job_charge, waste_percent, gate_rate_per_ft, trash_haul_fee,
                  teardown_enabled, teardown_flat_fee, teardown_rate_per_ft, teardown_feet)
values ('${ZZ_NEW}', '${PRICE_JOB_SYNC}', 'ZZ TEST Pricing Job', 'DRAFT',
        ${jobRow.tax_rate_percent}, ${jobRow.markup_percent}, ${jobRow.discount_percent}, ${jobRow.labor_rate_per_ft},
        ${jobRow.labor_flat_fee}, ${jobRow.minimum_job_charge}, ${jobRow.waste_percent}, ${jobRow.gate_rate_per_ft},
        ${jobRow.trash_haul_fee}, ${jobRow.teardown_enabled}, ${jobRow.teardown_flat_fee}, ${jobRow.teardown_rate_per_ft},
        ${jobRow.teardown_feet});
insert into fence_runs(company_id, sync_id, job_sync_id, label, fence_type, color_or_finish,
                        manual_linear_feet, panel_width_ft, panel_height_ft, post_spacing_ft,
                        concrete_bags_per_post, include_top_rail, sort_order)
values ('${ZZ_NEW}', '${PRICE_RUN_SYNC}', '${PRICE_JOB_SYNC}', '${runRow.label}', '${runRow.fence_type}',
        '${runRow.color_or_finish}', ${runRow.manual_linear_feet}, ${runRow.panel_width_ft},
        ${runRow.panel_height_ft}, ${runRow.post_spacing_ft}, ${runRow.concrete_bags_per_post},
        ${runRow.include_top_rail}, ${runRow.sort_order});
insert into material_items(company_id, sync_id, name, category, role, fence_type, color_or_finish,
                            unit, unit_price, taxable, covers_ft, is_active)
values ('${ZZ_NEW}', '${PRICE_ITEM_SYNC}', '${catalogRow.name}', '${catalogRow.category}', '${catalogRow.role}',
        '${catalogRow.fence_type}', '${catalogRow.color_or_finish}', '${catalogRow.unit}', ${catalogRow.unit_price},
        ${catalogRow.taxable}, ${catalogRow.covers_ft}, ${catalogRow.is_active});

select
  (select count(*) from jobs where company_id='${ZZ_NEW}' and sync_id='${PRICE_JOB_SYNC}'
    and labor_rate_per_ft = ${jobRow.labor_rate_per_ft} and minimum_job_charge = ${jobRow.minimum_job_charge}) as job_landed,
  (select count(*) from fence_runs where company_id='${ZZ_NEW}' and sync_id='${PRICE_RUN_SYNC}'
    and manual_linear_feet = ${runRow.manual_linear_feet}) as run_landed,
  (select count(*) from material_items where company_id='${ZZ_NEW}' and sync_id='${PRICE_ITEM_SYNC}'
    and unit_price = ${catalogRow.unit_price}) as item_landed;
rollback;
`);
  const landing = created[0] || {};
  ok("the job really landed in the database with the rates it was created with (read back, not assumed)",
     Number(landing.job_landed) === 1, `got ${JSON.stringify(landing)}`);
  ok("the fence run really landed", Number(landing.run_landed) === 1, `got ${JSON.stringify(landing)}`);
  ok("the catalog item really landed", Number(landing.item_landed) === 1, `got ${JSON.stringify(landing)}`);

  // Step B -- price it through the REAL server engine (never a copy of it).
  const priced = priceViaRealEngine({
    job: jobRow, runs: [runRow], catalog: [catalogRow], manufacturers: [], changeOrders: [], existingItems: [],
  });
  const engineTotal = Math.round(priced.output.totals.grand_total * 100) / 100;
  ok("CANARY: the real engine returns a real, positive total for a job actually built from a run",
     typeof engineTotal === "number" && engineTotal > 0, `got ${JSON.stringify(priced.output?.totals)}`);

  // Step C -- write the price back the way price-job's commit step does
  // (jobs.contract_total = output.totals.grand_total), then read it back
  // through the SAME report the office trusts (job_costing), as the owner,
  // under RLS. Plant a wrong figure first to prove the comparison can fail.
  const wrongTotal = Math.round((engineTotal + 37.5) * 100) / 100;
  const written = runSql(`
begin;
insert into auth.users(id) values ('${OWNER_NEW}');
insert into profiles(id, company_id, role, full_name)
  values ('${OWNER_NEW}', '${ZZ_NEW}', 'OWNER', 'ZZ TEST Pricing Owner');

insert into jobs(company_id, sync_id, customer_name, status,
                  tax_rate_percent, markup_percent, discount_percent, labor_rate_per_ft,
                  labor_flat_fee, minimum_job_charge, waste_percent, gate_rate_per_ft, trash_haul_fee,
                  teardown_enabled, teardown_flat_fee, teardown_rate_per_ft, teardown_feet)
values ('${ZZ_NEW}', '${PRICE_JOB_SYNC}', 'ZZ TEST Pricing Job', 'ACCEPTED',
        ${jobRow.tax_rate_percent}, ${jobRow.markup_percent}, ${jobRow.discount_percent}, ${jobRow.labor_rate_per_ft},
        ${jobRow.labor_flat_fee}, ${jobRow.minimum_job_charge}, ${jobRow.waste_percent}, ${jobRow.gate_rate_per_ft},
        ${jobRow.trash_haul_fee}, ${jobRow.teardown_enabled}, ${jobRow.teardown_flat_fee}, ${jobRow.teardown_rate_per_ft},
        ${jobRow.teardown_feet});

-- ---- PLANTED FAILURE: write a total $37.50 off from what the real engine
-- computed -- exactly what a bug in the commit step (a stale read, a dropped
-- markup term) would produce -- and show the office's own report catches it.
update jobs set contract_total = ${wrongTotal}, priced_by = 'OFFICE', priced_at = now(),
                pricing_engine_version = '${priced.engineVersion}'
  where company_id = '${ZZ_NEW}' and sync_id = '${PRICE_JOB_SYNC}';

${asClaim(OWNER_NEW)}
set local role authenticated;
create temp table probe2(case_name text, quoted numeric) on commit drop;
grant all on probe2 to authenticated;
insert into probe2 select 'PLANTED-BUG: wrong total', quoted from job_costing() where job_sync_id = '${PRICE_JOB_SYNC}';
reset role;

-- undo the plant: write the number the real engine actually computed.
update jobs set contract_total = ${engineTotal}
  where company_id = '${ZZ_NEW}' and sync_id = '${PRICE_JOB_SYNC}';

${asClaim(OWNER_NEW)}
set local role authenticated;
insert into probe2 select 'real total, read back via job_costing()', quoted from job_costing() where job_sync_id = '${PRICE_JOB_SYNC}';
reset role;

select case_name, quoted from probe2 order by case_name;
rollback;
`);
  const probe2 = (name) => written.find(r => r.case_name === name)?.quoted;
  ok("PLANTED FAILURE: a total $37.50 off from the real engine shows up as a mismatch " +
     "against job_costing()'s own read of the job (proves this check can fail)",
     Number(probe2("PLANTED-BUG: wrong total")) !== engineTotal,
     `engine said ${engineTotal}, job_costing() said ${probe2("PLANTED-BUG: wrong total")}`);
  ok("REAL RULE: the office's own price for the job, read back through job_costing(), " +
     "matches exactly what the real pricing engine computed",
     Number(probe2("real total, read back via job_costing()")) === engineTotal,
     `engine said ${engineTotal}, job_costing() said ${probe2("real total, read back via job_costing()")}`);

  // =========================================================================
  console.log("\n3. THE BUILD -- production stages (set_production_stage), on ZZ_BUSY:");

  const check3 = runSql(`
begin;
create temp table probe3(case_name text, ok_result boolean, detail text) on commit drop;
grant all on probe3 to authenticated;

insert into auth.users(id) values ('${OWNER_BUSY}');
insert into profiles(id, company_id, role, full_name)
  values ('${OWNER_BUSY}', '${ZZ_BUSY}', 'OWNER', 'ZZ TEST Build Owner');

-- ---- PLANTED FAILURE: the approved-status gate removed entirely -- a job
-- nobody ever sold starts production.
create or replace function public.set_production_stage(job_sid text, next_stage text)
returns boolean language plpgsql security definer set search_path to 'public' as $inner$
declare
    co uuid := public.current_company_id();
    current_stage production_stage;
    wanted production_stage;
begin
    if not (coalesce(public.has_permission('RECORD_FIELD_WORK'), false)
            or coalesce(public.has_permission('SCHEDULE_AND_ASSIGN'), false)) then
        raise exception 'You cannot move jobs through the build.' using errcode = '42501';
    end if;
    wanted := next_stage::production_stage;
    select j.production_stage into current_stage
      from jobs j where j.company_id = co and j.sync_id::text = job_sid and j.deleted_at is null;
    -- THE APPROVED-STATUS CHECK IS DELIBERATELY MISSING HERE.
    if current_stage is not distinct from wanted then return false; end if;
    update jobs set production_stage = wanted where company_id = co and sync_id::text = job_sid;
    insert into job_stage_events (company_id, job_sync_id, stage, entered_by, left_stage)
    values (co, job_sid::uuid, wanted, auth.uid(), current_stage);
    return true;
end;
$inner$;

${asClaim(OWNER_BUSY)}
set local role authenticated;
do $inner$
begin
  begin
    perform set_production_stage('${JOB_NO_PRICE}', 'DIG');
    insert into probe3 values ('PLANTED-BUG: an unpriced, never-approved DRAFT job starts production',
      true, 'wrongly succeeded, no exception');
  exception when others then
    insert into probe3 values ('PLANTED-BUG: an unpriced, never-approved DRAFT job starts production',
      false, sqlerrm);
  end;
end $inner$;
reset role;

-- undo the plant: revert whatever the plant did to the DRAFT job's stage/events
-- (it should have been refused, but clean up regardless of how the plant behaved)
update jobs set production_stage = null where company_id = '${ZZ_BUSY}' and sync_id = '${JOB_NO_PRICE}';
delete from job_stage_events where company_id = '${ZZ_BUSY}' and job_sync_id = '${JOB_NO_PRICE}';

-- restore the real function (supabase_production_stages.sql, the live definition)
create or replace function public.set_production_stage(job_sid text, next_stage text)
returns boolean language plpgsql security definer set search_path to 'public' as $inner$
declare
    co uuid := public.current_company_id();
    current_stage production_stage;
    wanted production_stage;
    job_status text;
begin
    if co is null then
        raise exception 'Sign in first.' using errcode = '42501';
    end if;
    if not (coalesce(public.has_permission('RECORD_FIELD_WORK'), false)
            or coalesce(public.has_permission('SCHEDULE_AND_ASSIGN'), false)) then
        raise exception 'You cannot move jobs through the build.' using errcode = '42501';
    end if;
    begin
        wanted := next_stage::production_stage;
    exception when others then
        raise exception 'There is no build stage called %.', next_stage using errcode = '22023';
    end;
    select j.production_stage, j.status::text into current_stage, job_status
      from jobs j where j.company_id = co and j.sync_id::text = job_sid and j.deleted_at is null;
    if job_status is null then
        raise exception 'That job is not on this company.' using errcode = '23503';
    end if;
    if job_status not in ('ACCEPTED', 'COMPLETED') then
        raise exception 'This job has not been approved yet, so the build cannot start.'
            using errcode = '23514';
    end if;
    if current_stage is not distinct from wanted then
        return false;
    end if;
    update jobs set production_stage = wanted where company_id = co and sync_id::text = job_sid;
    insert into job_stage_events (company_id, job_sync_id, stage, entered_by, left_stage)
    values (co, job_sid::uuid, wanted, auth.uid(), current_stage);
    return true;
end;
$inner$;

-- ---- REAL rule ----
${asClaim(OWNER_BUSY)}
set local role authenticated;
do $inner$
declare moved boolean; again boolean; events_before int; events_after int;
begin
  begin
    perform set_production_stage('${JOB_NO_PRICE}', 'DIG');
    insert into probe3 values ('an unapproved (DRAFT, never sold) job is refused', false, 'wrongly succeeded, no exception');
  exception when others then
    insert into probe3 values ('an unapproved (DRAFT, never sold) job is refused', true, sqlerrm);
  end;

  select count(*) into events_before from job_stage_events where job_sync_id = '${JOB_ACCEPTED}';

  begin
    moved := set_production_stage('${JOB_ACCEPTED}', 'DIG');
    insert into probe3 values ('the sold (ACCEPTED) job moves into the build', moved is true, 'returned ' || moved);
  exception when others then
    insert into probe3 values ('the sold (ACCEPTED) job moves into the build', false, sqlerrm);
  end;

  begin
    again := set_production_stage('${JOB_ACCEPTED}', 'DIG');
    select count(*) into events_after from job_stage_events where job_sync_id = '${JOB_ACCEPTED}';
    insert into probe3 values ('moving to the SAME stage again returns false and records no 2nd event',
      again is false and events_after = events_before + 1,
      format('again=%s events_before=%s events_after=%s', again, events_before, events_after));
  exception when others then
    insert into probe3 values ('moving to the SAME stage again returns false and records no 2nd event', false, sqlerrm);
  end;
end $inner$;
reset role;

select case_name,
       (select production_stage::text from jobs where sync_id = '${JOB_ACCEPTED}') as stage_now,
       (select count(*) from job_stage_events where job_sync_id = '${JOB_ACCEPTED}') as events_now,
       ok_result, detail
from probe3 order by case_name;
rollback;
`);
  const row3 = (name) => check3.find(r => r.case_name === name) || {};
  ok("PLANTED FAILURE: with the approved-status gate removed, an unsold DRAFT job wrongly " +
     "starts production (proves this check can fail)",
     row3("PLANTED-BUG: an unpriced, never-approved DRAFT job starts production").ok_result === true,
     JSON.stringify(row3("PLANTED-BUG: an unpriced, never-approved DRAFT job starts production")));
  ok("REAL RULE: the build refuses to start on a job that was never approved",
     row3("an unapproved (DRAFT, never sold) job is refused").ok_result === true,
     row3("an unapproved (DRAFT, never sold) job is refused").detail);
  ok("REAL RULE: a sold (ACCEPTED) job moves into the build and the move is recorded",
     row3("the sold (ACCEPTED) job moves into the build").ok_result === true,
     row3("the sold (ACCEPTED) job moves into the build").detail);
  ok("REAL RULE: moving to the same stage twice records the move exactly once",
     row3("moving to the SAME stage again returns false and records no 2nd event").ok_result === true,
     row3("moving to the SAME stage again returns false and records no 2nd event").detail);

  // =========================================================================
  console.log("\n4. THE MONEY -- a payment moves what the job says it has been paid:");
  console.log("   (recompute_job_totals, fired by payment_records; ar_aging() must agree)");

  const check4 = runSql(`
begin;
create temp table probe4(case_name text, amount_paid numeric, owed numeric, detail text) on commit drop;
grant all on probe4 to authenticated;

insert into auth.users(id) values ('${OWNER_BUSY}');
insert into profiles(id, company_id, role, full_name)
  values ('${OWNER_BUSY}', '${ZZ_BUSY}', 'OWNER', 'ZZ TEST Money Owner');

-- baseline: the ACCEPTED job starts this file with amount_paid = 0
-- (supabase_test_companies.sql).
insert into probe4 select 'baseline', amount_paid, null, ''
  from jobs where company_id = '${ZZ_BUSY}' and sync_id = '${JOB_ACCEPTED}';

-- ---- PLANTED FAILURE: drop the trigger that keeps jobs.amount_paid in sync
-- with the payment ledger, then record a real payment, and show the job
-- STILL reads as unpaid -- exactly the bug that once made the home screen's
-- total flicker (supabase_job_totals_authority_patch.sql tells that story).
drop trigger if exists payment_records_totals on public.payment_records;
insert into payment_records(sync_id, company_id, job_sync_id, amount, method)
values ('zz-test-planted-1', '${ZZ_BUSY}', '${JOB_ACCEPTED}', 1720, 'CASH');
insert into probe4 select 'PLANTED-BUG: payment recorded but trigger disabled', amount_paid, null, ''
  from jobs where company_id = '${ZZ_BUSY}' and sync_id = '${JOB_ACCEPTED}';

-- undo the plant: restore the real trigger (supabase_job_totals_authority_patch.sql)
create trigger payment_records_totals
after insert or update or delete on public.payment_records
for each row execute function public.payment_records_recompute();

-- ---- REAL rule: a second, real payment, made with the trigger back in place.
insert into payment_records(sync_id, company_id, job_sync_id, amount, method)
values ('zz-test-real-1', '${ZZ_BUSY}', '${JOB_ACCEPTED}', 500, 'CHECK');
insert into probe4 select 'after a real payment lands (trigger enabled)', amount_paid, null, ''
  from jobs where company_id = '${ZZ_BUSY}' and sync_id = '${JOB_ACCEPTED}';

-- The planted payment above never went through recompute_job_totals (the
-- trigger that would have fired it was down), so it is still sitting,
-- uncounted, in the ledger. recalculate_my_job_totals() -- the button the app
-- exposes for exactly this -- must find it too.
${asClaim(OWNER_BUSY)}
set local role authenticated;
do $inner$ begin perform recalculate_my_job_totals(); end $inner$;
reset role;
insert into probe4 select 'after recalculate_my_job_totals() catches the earlier planted payment too', amount_paid, null, ''
  from jobs where company_id = '${ZZ_BUSY}' and sync_id = '${JOB_ACCEPTED}';

-- ar_aging() must agree with the job it is describing.
${asClaim(OWNER_BUSY)}
set local role authenticated;
insert into probe4
  select 'ar_aging() for this job', paid, owed, ''
  from ar_aging() where job_sync_id = '${JOB_ACCEPTED}';
reset role;

select case_name, amount_paid, owed, detail from probe4 order by case_name;
rollback;
`);
  const row4 = (name) => check4.find(r => r.case_name === name) || {};
  ok("baseline: the ACCEPTED fixture job starts unpaid", Number(row4("baseline").amount_paid) === 0,
     JSON.stringify(row4("baseline")));
  ok("PLANTED FAILURE: with the ledger trigger disabled, a real payment leaves jobs.amount_paid " +
     "unmoved (proves this check can fail)",
     Number(row4("PLANTED-BUG: payment recorded but trigger disabled").amount_paid) === 0,
     JSON.stringify(row4("PLANTED-BUG: payment recorded but trigger disabled")));
  // recompute_job_totals recomputes from the WHOLE ledger, not just the row
  // that fired it -- so the moment the trigger is back and ANY payment lands,
  // it also catches up the earlier payment the disabled trigger missed
  // (1720 + 500 = 2220), in the same statement. That is a stronger property
  // than "the new payment counts", so assert the stronger one directly.
  ok("REAL RULE: once the trigger is back, a new payment recomputes the WHOLE ledger -- " +
     "including the payment the disabled trigger missed (1720 + 500 = 2220)",
     Number(row4("after a real payment lands (trigger enabled)").amount_paid) === 2220,
     JSON.stringify(row4("after a real payment lands (trigger enabled)")));
  ok("recalculate_my_job_totals() (the app's own catch-up button) leaves the already-correct " +
     "figure unchanged -- it is idempotent, not just corrective",
     Number(row4("after recalculate_my_job_totals() catches the earlier planted payment too").amount_paid) === 2220,
     JSON.stringify(row4("after recalculate_my_job_totals() catches the earlier planted payment too")));
  ok("ar_aging() agrees with the job's own paid figure", Number(row4("ar_aging() for this job").amount_paid ?? row4("ar_aging() for this job").paid) === 2220
     || Number(row4("ar_aging() for this job").amount_paid) === 2220,
     JSON.stringify(row4("ar_aging() for this job")));
  ok("ar_aging() reports what is still owed (contract_total 8600 - paid 2220 = 6380)",
     Number(row4("ar_aging() for this job").owed) === 6380, JSON.stringify(row4("ar_aging() for this job")));

  // =========================================================================
  console.log("\n5. THE BOOKS AGREE -- job_costing() must not disagree with the job it describes:");

  const check5 = runSql(`
begin;
create temp table probe5(case_name text, collected numeric) on commit drop;
grant all on probe5 to authenticated;

insert into auth.users(id) values ('${OWNER_BUSY}');
insert into profiles(id, company_id, role, full_name)
  values ('${OWNER_BUSY}', '${ZZ_BUSY}', 'OWNER', 'ZZ TEST Books Owner');

insert into payment_records(sync_id, company_id, job_sync_id, amount, method)
values ('zz-test-books-1', '${ZZ_BUSY}', '${JOB_ACCEPTED}', 1000, 'CASH');

-- ---- PLANTED FAILURE: a job_costing() that double-counts a soft-deleted
-- payment (forgets the "deleted_at is null" filter recompute_job_totals
-- always applies) -- the exact way a report and the job it describes can
-- quietly stop agreeing.
create or replace function public.job_costing(from_date timestamptz default null, to_date timestamptz default null)
 returns table(job_sync_id text, customer_name text, status text, quoted numeric, collected numeric,
               material_cost numeric, labour_cost numeric, other_cost numeric, total_cost numeric,
               projected_profit numeric, margin_percent numeric, cash_position numeric,
               costs_are_sell_prices boolean, hours_worked numeric, unapproved_hours numeric)
 language sql stable security definer set search_path to 'public'
as $inner$
    with scope as (
        select j.sync_id, j.customer_name, j.status::text, j.contract_total
        from jobs j where j.company_id = money_scope_company_id() and j.deleted_at is null
    ),
    money as (
        select p.job_sync_id, sum(p.amount) as collected  -- BUG: no deleted_at filter
        from payment_records p where p.company_id = money_scope_company_id()
        group by p.job_sync_id
    )
    select s.sync_id, s.customer_name, s.status, round(coalesce(s.contract_total,0)::numeric,2),
           round(coalesce(mo.collected,0)::numeric,2),
           0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, null::numeric, 0::numeric,
           false, 0::numeric, 0::numeric
    from scope s left join money mo on mo.job_sync_id = s.sync_id;
$inner$;

-- a soft-deleted duplicate of the same payment -- recompute_job_totals
-- correctly ignores it (deleted_at is null), so jobs.amount_paid does NOT
-- include it, but the buggy job_costing() above will.
insert into payment_records(sync_id, company_id, job_sync_id, amount, method, deleted_at)
values ('zz-test-books-dup', '${ZZ_BUSY}', '${JOB_ACCEPTED}', 999999, 'CASH', now());

${asClaim(OWNER_BUSY)}
set local role authenticated;
insert into probe5 select 'PLANTED-BUG: job_costing() double-counts the soft-deleted duplicate', collected
  from job_costing() where job_sync_id = '${JOB_ACCEPTED}';
reset role;

-- undo the plant: restore the real, live definition (supabase_money_report_guard.sql)
CREATE OR REPLACE FUNCTION public.job_costing(from_date timestamp with time zone DEFAULT NULL::timestamp with time zone, to_date timestamp with time zone DEFAULT NULL::timestamp with time zone)
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
$function$;

-- ---- REAL rule ----
${asClaim(OWNER_BUSY)}
set local role authenticated;
insert into probe5 select 'job_costing() agrees with jobs.amount_paid', collected
  from job_costing() where job_sync_id = '${JOB_ACCEPTED}';
reset role;

select case_name, collected,
       (select amount_paid from jobs where sync_id = '${JOB_ACCEPTED}') as jobs_amount_paid
from probe5 order by case_name;
rollback;
`);
  const row5 = (name) => check5.find(r => r.case_name === name) || {};
  const jobsAmountPaid5 = Number(row5("job_costing() agrees with jobs.amount_paid").jobs_amount_paid ?? 1000);
  ok("PLANTED FAILURE: a job_costing() that forgets the deleted_at filter disagrees with " +
     "the job's own amount_paid (proves this check can fail)",
     Number(row5("PLANTED-BUG: job_costing() double-counts the soft-deleted duplicate").collected) !== jobsAmountPaid5,
     JSON.stringify(row5("PLANTED-BUG: job_costing() double-counts the soft-deleted duplicate")));
  ok("REAL RULE: job_costing()'s collected figure agrees exactly with jobs.amount_paid for the same job",
     Number(row5("job_costing() agrees with jobs.amount_paid").collected) === jobsAmountPaid5,
     `job_costing said ${row5("job_costing() agrees with jobs.amount_paid").collected}, jobs.amount_paid is ${jobsAmountPaid5}`);

  // =========================================================================
  console.log("\nFinally: prove nothing survived.");
  const after = runSql(`
    select
      (select count(*) from auth.users where id in ('${OWNER_NEW}','${OWNER_BUSY}')) as synthetic_users,
      (select count(*) from profiles where id in ('${OWNER_NEW}','${OWNER_BUSY}')) as synthetic_profiles,
      (select count(*) from company_settings where company_id = '${ZZ_NEW}') as zz_new_settings,
      (select count(*) from payment_connections where company_id = '${ZZ_NEW}') as zz_new_payment_connections,
      (select count(*) from material_items where company_id = '${ZZ_NEW}') as zz_new_catalog,
      (select count(*) from pricing_tiers where company_id = '${ZZ_NEW}') as zz_new_tiers,
      (select count(*) from jobs where company_id = '${ZZ_NEW}' and sync_id = '${PRICE_JOB_SYNC}') as zz_new_pricing_job,
      (select count(*) from fence_runs where company_id = '${ZZ_NEW}' and sync_id = '${PRICE_RUN_SYNC}') as zz_new_pricing_run,
      (select production_stage::text from jobs where sync_id = '${JOB_NO_PRICE}') as job_no_price_stage,
      (select status::text from jobs where sync_id = '${JOB_NO_PRICE}') as job_no_price_status,
      (select production_stage::text from jobs where sync_id = '${JOB_ACCEPTED}') as job_accepted_stage,
      (select count(*) from job_stage_events where job_sync_id in ('${JOB_NO_PRICE}','${JOB_ACCEPTED}')) as stage_events,
      (select amount_paid from jobs where sync_id = '${JOB_ACCEPTED}') as job_accepted_amount_paid,
      (select count(*) from payment_records where company_id = '${ZZ_BUSY}' and job_sync_id = '${JOB_ACCEPTED}') as zz_busy_payment_rows,
      (select count(*) from companies where id in ('${ZZ_NEW}','${ZZ_LAPSED}','${ZZ_BUSY}')) as zz_companies_still_present,
      (select proname from pg_proc where pronamespace='public'::regnamespace and proname='job_costing'
         and position('money_scope_company_id' in prosrc) > 0) as job_costing_still_guarded;
  `);
  const a = after[0] || {};
  ok("no synthetic auth user survived", Number(a.synthetic_users) === 0, `got ${a.synthetic_users}`);
  ok("no synthetic profile survived", Number(a.synthetic_profiles) === 0, `got ${a.synthetic_profiles}`);
  ok("ZZ_NEW's company_settings row is gone again", Number(a.zz_new_settings) === 0, `got ${a.zz_new_settings}`);
  ok("ZZ_NEW's payment_connections row is gone again", Number(a.zz_new_payment_connections) === 0, `got ${a.zz_new_payment_connections}`);
  ok("ZZ_NEW's test catalog item is gone", Number(a.zz_new_catalog) === 0, `got ${a.zz_new_catalog}`);
  ok("ZZ_NEW's test pricing tier is gone", Number(a.zz_new_tiers) === 0, `got ${a.zz_new_tiers}`);
  ok("the pricing test's job never persisted", Number(a.zz_new_pricing_job) === 0, `got ${a.zz_new_pricing_job}`);
  ok("the pricing test's fence run never persisted", Number(a.zz_new_pricing_run) === 0, `got ${a.zz_new_pricing_run}`);
  ok("the never-approved job is still DRAFT with no production_stage",
     a.job_no_price_status === "DRAFT" && a.job_no_price_stage === null,
     `status=${a.job_no_price_status} stage=${a.job_no_price_stage}`);
  ok("the ACCEPTED job's production_stage move rolled back to null", a.job_accepted_stage === null,
     `got ${a.job_accepted_stage}`);
  ok("no job_stage_events row survived for either job", Number(a.stage_events) === 0, `got ${a.stage_events}`);
  ok("the ACCEPTED job's amount_paid rolled back to 0, exactly as the fixture defines it",
     Number(a.job_accepted_amount_paid) === 0, `got ${a.job_accepted_amount_paid}`);
  ok("no payment_records row survived for the ACCEPTED job", Number(a.zz_busy_payment_rows) === 0,
     `got ${a.zz_busy_payment_rows}`);
  ok("all three ZZ TEST fixture companies are still exactly present (untouched, not deleted)",
     Number(a.zz_companies_still_present) === 3, `got ${a.zz_companies_still_present}`);
  ok("job_costing() is back to its real, guarded definition, not the planted one",
     a.job_costing_still_guarded === "job_costing", `got ${JSON.stringify(a.job_costing_still_guarded)}`);

  console.log(`\n${checked - failed} of ${checked} checks passed`);
  if (failed) process.exit(1);
}

main().catch(e => { console.error("company-golden-path test could not run:", e.message); process.exit(2); });
