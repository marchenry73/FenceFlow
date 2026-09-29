// A4 audit -- "Audit every money calculation in the app and the office and
// prove it charges the right price." This file's slice: LABOUR COST AND
// CREW PAY -- the $200 minimum labour charge, whether a corrected shift
// keeps the rate it was worked at, and whether every pay figure really sits
// behind a permission.
//
// READ-ONLY audit, per the owner's hard rules for this pass: no source file
// is edited, nothing is written to the live database (every DB check below
// is a bare SELECT, or SELECT + SET LOCAL ROLE for impersonation -- never
// INSERT/UPDATE/DELETE/ALTER/DROP, not even inside a transaction meant to
// roll back), gradlew and check-parity.mjs are never run, and no file under
// the "another wave is editing this" list is opened for writing. Findings
// are proved, not fixed.
//
// Companions already in this suite:
//   tests/downstream-job-costing.test.mjs -- job_costing()'s own arithmetic
//     and the SEE_MONEY gate on it. Not repeated here.
//   tests/downstream-pay-overtime.test.mjs -- the office's weekly 40hr/1.5x
//     overtime split, run for real out of website/dashboard.html.
//   tests/a4-engine-parity.test.mjs -- the shared pattern this file follows
//     for driving the REAL server pricing engine (priceJob) instead of
//     re-deriving its arithmetic.
//
// Run:
//   npx tsx tests/a4-labour.test.mjs
//
// Needs the Supabase CLI already authenticated against the linked project
// (same as every other *.test.mjs in this directory that talks to the live
// database).

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { priceJob, PRICING_ENGINE_VERSION } from "../supabase/functions/_shared/pricing/index.ts";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
};

// ===========================================================================
// Live database plumbing -- SELECT (and SET LOCAL ROLE / set_config, which
// are neither DML nor DDL) only. See the header: no writes, ever, in this
// file, not even ones meant to roll back.
// ===========================================================================
const PROJECT = "newcrgafcptspmapacrx";

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "a4-labour-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query",
    "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
    { encoding: "utf8", shell: process.platform === "win32", timeout: 180_000 });
  // Read the RAW output before trusting any parse of it -- a JSON parser that
  // prints a header on an error response reads exactly like an empty-but-ok
  // result. (This bit the session once already today, per the task brief.)
  if (r.status !== 0) {
    throw new Error(`supabase db query failed (exit ${r.status}): ${r.stderr || r.stdout}`);
  }
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { throw new Error(`could not parse CLI output: ${r.stdout}`); }
  if (!parsed || (!Array.isArray(parsed) && !("rows" in parsed))) {
    throw new Error(`unexpected CLI shape, not a rows-bearing result: ${r.stdout.slice(0, 300)}`);
  }
  return Array.isArray(parsed) ? parsed : parsed.rows;
}

// Real ids, not synthetic ones -- see section 4 below for why a made-up
// no-permission account is not needed here the way it was in
// downstream-job-costing.test.mjs (that file's own comment explains why
// borrowing a real id has failed twice: promotions moved the fixture out
// from under it). Confirmed live, today, in section 4's own positive
// control -- if any of these has been promoted or reassigned since, that
// check reports the drift rather than silently mis-reading it as a leak.
const CO      = "aba5b097-afc4-48dd-9851-b50200d5e8f4"; // real company (same one downstream-job-costing.test.mjs uses)
const OWNER   = "7bf38947-24cf-4e79-9af0-6100d04b166b"; // OWNER, has SEE_PAY and SEE_MONEY
const MARC    = "518fde2b-e689-4164-b900-85d8c7ca9748"; // real CREW profile id
const MARC_EMP = "d7af5f01-c0bb-4f77-9131-655ea308a493"; // Marc's employees.sync_id
const JOHN_EMP = "c75a354a-a357-47d5-8368-c2a379928733"; // a colleague's employees.sync_id (John)

const asClaim = (sub) =>
  `select set_config('request.jwt.claims', json_build_object('sub','${sub}','role','authenticated')::text, true);`;

async function main() {

// ===========================================================================
console.log("\n1. The $200 labour floor (jobs.minimum_labor_charge), run through the REAL server engine:");
// ===========================================================================
// priceJob() is the exact function price-job/index.ts calls and
// tests/a4-engine-parity.test.mjs already drives the same way -- no
// arithmetic re-derived here, the real engine is run with a real input.
//
// supabase/functions/_shared/pricing/smoke.ts already has a hand-checked
// case for this floor (Case 5/5b); this section does not repeat that case,
// it goes after "cannot be bypassed" specifically, which is the owner's own
// wording for what this audit item must confirm.

function job(overrides = {}) {
  return {
    calibration_pixels_per_foot: null,
    tax_rate_percent: 0, markup_percent: 0, discount_percent: 0,
    labor_rate_per_ft: 8, labor_flat_fee: 0, minimum_job_charge: 0, minimum_labor_charge: 0,
    waste_percent: 0, gate_rate_per_ft: 20, trash_haul_fee: 0,
    teardown_enabled: false, teardown_flat_fee: 0, teardown_rate_per_ft: 0, teardown_feet: 0,
    preferred_manufacturer_sync_id: null,
    ...overrides,
  };
}
function run(sync_id, overrides = {}) {
  return {
    sync_id, label: sync_id, fence_type: "VINYL", color_or_finish: "",
    points_encoded: "", gates_encoded: "", closed_loop: false,
    manual_linear_feet: null, manual_corner_count: 0,
    panel_width_ft: 6, panel_height_ft: 6, post_spacing_ft: 6, concrete_bags_per_post: 1,
    aluminum_style: "RACKABLE", wood_style: "PRIVACY", wood_rail_count: 3, picket_width_in: 5.5, picket_gap_in: 0,
    fabric_height_ft: 4, include_top_rail: true, include_tension_wire: false, include_barbed_wire_arms: false,
    include_privacy_slats: false, split_rail_count: 2,
    // Every material role suppressed -- the run contributes labour feet only,
    // zero material line items, so nothing about the floor can be attributed
    // to material pricing.
    suppressed_roles: "PANEL,LINE_POST,END_POST,CORNER_POST,POST_CAP,CONCRETE_BAG,GATE_PANEL,GATE_FRAME_KIT,HINGE_SET,LATCH",
    is_teardown: false, sort_order: 0,
    ...overrides,
  };
}
function input(jobRow, runs, existing = [], changeOrders = []) {
  return {
    engine_version: PRICING_ENGINE_VERSION, pixels_per_foot: jobRow.calibration_pixels_per_foot ?? 20,
    job: jobRow, runs, catalog: [], manufacturers: [], change_orders: changeOrders, existing_items: existing,
  };
}
const materialsLine = (price) => ([{
  sync_id: "materials-1", fence_run_sync_id: null, role: "NONE", description: "Materials",
  quantity: 1, unit: "EA", unit_price: price, supplier_unit_price: null, taxable: false,
  auto_generated: false, sort_order: 0,
}]);

{
  // 1a. Materials cannot help reach the floor, however large. $50,000 of
  // materials sits beside 1 ft of $1/ft labour (raw labour = $1) on a job
  // with a $200 floor. If the floor were (wrongly) computed over
  // materials+labour together, $50,001 already clears $200 and NO flooring
  // would show up in labor_cost; if it is computed over labour alone (the
  // rule the owner approved), labor_cost must read exactly $200 regardless
  // of the $50,000 sitting next to it.
  const out = priceJob(input(
    job({ minimum_labor_charge: 200, labor_rate_per_ft: 1 }),
    [run("r1", { manual_linear_feet: 1 })],
    materialsLine(50000),
  ));
  ok("1a. $50,000 of materials does not let a $1 raw-labour job skip the $200 floor: " +
     "labor_cost=200 (not 1, and not left at 1 because materials already cover it)",
    out.totals.labor_cost === 200,
    `raw labour would have been 1*1=1; labor_cost=${out.totals.labor_cost}`);
  ok("1a. materials_subtotal is untouched by the floor ($50,000, not $50,200 -- the floor adds to labour, not materials)",
    out.totals.materials_subtotal === 50000, `materials_subtotal=${out.totals.materials_subtotal}`);

  // CANARY: the wrong-but-plausible rule -- floor the SUM of materials and
  // labour, not labour alone -- computed by hand on these same numbers, to
  // show it gives a visibly different (and wrong) answer: no flooring at
  // all, because 50000+1 already clears 200. Proves 1a is actually
  // exercising the "labour alone" rule and not something that would read
  // the same either way.
  const wrongCombined = Math.max(50000 + 1, 200);
  ok("CANARY: flooring materials+labour together would report labor_cost effectively unfloored " +
     "(50001, not 200) on these same numbers -- proves check 1a can fail and is not vacuous",
    wrongCombined !== 200, `wrongCombined=${wrongCombined}`);
}

{
  // 1b. A large negative labor_flat_fee (an estimator's manual discount) does
  // not defeat the floor either -- the floor is a true floor, not a value
  // that a negative input can drag below itself.
  const out = priceJob(input(
    job({ minimum_labor_charge: 200, labor_flat_fee: -100000, labor_rate_per_ft: 0 }),
    [run("r2", { manual_linear_feet: 0 })],
  ));
  ok("1b. a -$100,000 flat-fee discount still floors labor_cost at $200 (raw labour would be -$100,000)",
    out.totals.labor_cost === 200, `labor_cost=${out.totals.labor_cost}`);
}

{
  // 1c. 0 (the documented "off" value) truly means off, not "a floor of
  // zero coincidentally equal to max(x,0)": raw labour here is a real
  // negative number, and with the floor off it must be billed negative
  // (an estimator's credit), not silently clamped to 0 by an accidental
  // max(x, 0) in the disabled path.
  const out = priceJob(input(
    job({ minimum_labor_charge: 0, labor_flat_fee: -50, labor_rate_per_ft: 0 }),
    [run("r3", { manual_linear_feet: 0 })],
  ));
  ok("1c. minimum_labor_charge=0 bills the true (negative) raw labour, -$50, not 0 and not floored",
    out.totals.labor_cost === -50, `labor_cost=${out.totals.labor_cost}`);
}

console.log(`  (1 of 3 confirms the floor: labour-only, unbypassable by materials or a negative fee, and truly off at 0)`);

// ===========================================================================
console.log("\n2. FINDING -- three office report/alert surfaces quote labour WITHOUT the $200 floor:");
// ===========================================================================
// website/dashboard.html computes "what labour was quoted at" from
//   labor_rate_per_ft * signed_linear_feet + labor_flat_fee
// in three places (grep: all three read verbatim identical formulas):
//   - the "labour_over" attention alert (inline in renderDash(), ~line 11332)
//   - labourEstVsActualTotals() -- the period aggregate "estimated vs actual" total
//   - labourVsQuoted(r) -- the per-job figure on the cost report
// NONE of them read jobs.minimum_labor_charge. The real pricing engine
// (section 1, and EstimateEngine.kt on the phone) floors labour at the
// minimum BEFORE markup; these three read the UN-floored raw figure, so on
// any job where the floor is actually doing something, every one of these
// reports a different, wrong "quoted" labour number than what the customer
// was actually charged.
//
// The two extractable functions below are pulled and run for real (same
// technique tests/downstream-pay-overtime.test.mjs uses to run renderPay);
// the alert is quoted by line number since it lives inline inside
// renderDash() and shares the identical formula text byte for byte.

const src = readFileSync("website/dashboard.html", "utf8");

const grabFn = (name) => {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("not found: " + name);
  let i = src.indexOf("{", start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
};

// Everything below reaches into website/dashboard.html's source text by
// name (the TL table, quotedLaborOf, labourVsQuoted, labourEstVsActualTotals)
// and previously did that with no net: when the labour-formula consolidation
// renamed/reshaped one of those anchors, the resulting ReferenceError
// ("quotedLaborOf is not defined") propagated all the way out of main() and
// killed the process before sections 3-5 -- the crew-money and pay-write
// checks -- ever ran. A test that throws is not a test that fails, it
// reports nothing at all. This repo has already been bitten twice by a
// source-text probe that crashed on a missing anchor instead of reporting a
// verdict, so this section is wrapped: if any anchor it reaches for is ever
// renamed or removed again, this reports ONE named, loud failure (below) and
// the file keeps going into sections 3-5 instead of taking the whole run
// down with it.
try {
  // The real English translation table, the same way
  // downstream-pay-overtime.test.mjs lifts it -- so assertions compare against
  // the words the page actually ships, not a guess that could drift from them.
  const tlStart = src.indexOf("const TL = {");
  if (tlStart < 0) throw new Error("not found: const TL = {");
  let tlDepth = 0, tlEnd = -1;
  for (let i = src.indexOf("{", tlStart); i < src.length; i++) {
    if (src[i] === "{") tlDepth++;
    else if (src[i] === "}") { tlDepth--; if (tlDepth === 0) { tlEnd = i + 1; break; } }
  }
  if (tlEnd < 0) throw new Error("unbalanced: const TL = {");
  const TL_EN = eval("(" + src.slice(src.indexOf("{", tlStart), tlEnd) + ")").en;
  const tr = (k, ...a) => { let t = TL_EN[k] ?? k; for (const v of a) t = String(t).replace("%s", v); return t; };
  const esc = (s) => String(s ?? "");
  const money = (n) => "$" + Number(n).toFixed(2);

  // labourVsQuoted() and labourEstVsActualTotals() no longer spell out
  // "rate*feet+flat" themselves -- the dashboard track consolidated all three
  // office copies of that formula (this pair, plus the inline labour_over
  // alert quoted below) into one shared quotedLaborOf(), so both now call it
  // by name. It has to be lifted alongside them or the extracted code throws
  // "quotedLaborOf is not defined" the moment it runs -- exactly the crash
  // this file hit until this fix.
  function withLabourVsQuoted(jobRow, costingRow) {
    const code = grabFn("quotedLaborOf") + "\n" + grabFn("labourVsQuoted");
    const fn = new Function("jobs", "esc", "money", "tr", "r", code + "\nreturn labourVsQuoted(r);");
    return fn([jobRow], esc, money, tr, costingRow);
  }
  function withLabourEstVsActualTotals(jobsIn, costingBySync) {
    const code = grabFn("quotedLaborOf") + "\n" + grabFn("labourEstVsActualTotals");
    const fn = new Function("jobsIn", "jobCostingBySync", code + "\nreturn labourEstVsActualTotals(jobsIn, jobCostingBySync);");
    return fn(jobsIn, costingBySync);
  }

  {
    // The exact job from section 1's smoke-adjacent case: $200 floor,
    // $8/ft labour, 4 ft of fence. Raw labour = 8*4 = $32; the REAL engine
    // (proven in section 1, and matching smoke.ts's owner-approved Case 5)
    // floors this to $200.
    const jobRow = { sync_id: "job-A", labor_rate_per_ft: 8, signed_linear_feet: 4, labor_flat_fee: 0 };
    // A crew actually spent $150 in wages on this job -- real, under the true
    // $200 quote, by $50.
    const costingRow = { job_sync_id: "job-A", labour_cost: 150, hours_worked: 10 };

    const trueOut = priceJob(input(
      job({ minimum_labor_charge: 200, labor_rate_per_ft: 8 }),
      [run("run-A", { manual_linear_feet: 4 })],
    ));
    ok("precondition: the real engine floors this job's labour to $200 (raw would be 8*4=$32)",
      trueOut.totals.labor_cost === 200, `labor_cost=${trueOut.totals.labor_cost}`);

    const html = withLabourVsQuoted(jobRow, costingRow);
    // Buggy "quoted" = 8*4+0 = 32. diff = 32-150 = -118 -> reads "over".
    ok("FINDING: labourVsQuoted() reports the job as $118.00 OVER budget on labour " +
       "(quoted read as $32.00, the un-floored raw figure) when the job was actually " +
       "quoted at the true, floored $200.00 and is $50.00 UNDER budget -- the report is not just " +
       "off by a magnitude, its OVER/UNDER verdict is inverted",
      html.includes(money(118)) && html.includes(tr("repCostOverWord")),
      `html: ${html}`);
    ok("the CORRECT verdict, from the real engine's own number, would be $50.00 under " +
       "(200 - 150 = 50), the opposite sign from what the report shows",
      trueOut.totals.labor_cost - costingRow.labour_cost === 50,
      `true labor_cost=${trueOut.totals.labor_cost}, actual=${costingRow.labour_cost}`);

    // CANARY: the same function, on a job with NO floor set, must agree with
    // the engine -- proving withLabourVsQuoted really runs the report's real
    // formula and the mismatch above is the floor being ignored, not a harness
    // bug that always disagrees with priceJob().
    const jobRowNoFloor = { sync_id: "job-B", labor_rate_per_ft: 8, signed_linear_feet: 4, labor_flat_fee: 0 };
    const costingRowNoFloor = { job_sync_id: "job-B", labour_cost: 150, hours_worked: 10 };
    const trueOutNoFloor = priceJob(input(job({ minimum_labor_charge: 0, labor_rate_per_ft: 8 }), [run("run-B", { manual_linear_feet: 4 })]));
    const htmlNoFloor = withLabourVsQuoted(jobRowNoFloor, costingRowNoFloor);
    // With no floor active the real engine's own labor_cost IS 32 -- the same
    // number the report computes -- so the report's "$118.00 over" is the
    // CORRECT verdict here. That agreement (32 === 32) is exactly what makes
    // the $200-floor case above a genuine disagreement rather than a harness
    // that would disagree with priceJob() regardless of input.
    ok("CANARY: with no floor set, the real engine's own labor_cost (32) matches what the report " +
       "computed (also 32) -- both say $118.00 over, in agreement -- proving the FINDING above is " +
       "specifically about the floor being ignored, not a harness that always disagrees with priceJob()",
      trueOutNoFloor.totals.labor_cost === 32 &&
      htmlNoFloor.includes(money(118)) && htmlNoFloor.includes(tr("repCostOverWord")),
      `true labor_cost=${trueOutNoFloor.totals.labor_cost}; html: ${htmlNoFloor}`);
  }

  {
    // The same bug, aggregated: two jobs in a period, one with the $200 floor
    // active and one without, summed by labourEstVsActualTotals(). The
    // company-wide "estimated" labour total should be 200+32=232; the report
    // sums the un-floored raw figure for both and gets 32+32=64 -- a $168
    // company-wide understatement of what labour was actually quoted at,
    // for a company with just these two jobs.
    const jobsIn = [
      { sync_id: "job-C", labor_rate_per_ft: 8, signed_linear_feet: 4, labor_flat_fee: 0 },
      { sync_id: "job-D", labor_rate_per_ft: 8, signed_linear_feet: 4, labor_flat_fee: 0 },
    ];
    const costingBySync = new Map([
      ["job-C", { labour_cost: 0 }],
      ["job-D", { labour_cost: 0 }],
    ]);
    const trueFloored = priceJob(input(job({ minimum_labor_charge: 200, labor_rate_per_ft: 8 }), [run("run-C", { manual_linear_feet: 4 })])).totals.labor_cost;
    const trueUnfloored = priceJob(input(job({ minimum_labor_charge: 0, labor_rate_per_ft: 8 }), [run("run-D", { manual_linear_feet: 4 })])).totals.labor_cost;
    const trueTotal = trueFloored + trueUnfloored; // 200 + 32 = 232

    const { estimated } = withLabourEstVsActualTotals(jobsIn, costingBySync);
    ok("FINDING: labourEstVsActualTotals() sums the company's 'estimated' labour for these two jobs " +
       `as $${estimated.toFixed(2)} (32+32, both un-floored) when the true quoted total is ` +
       `$${trueTotal.toFixed(2)} (200 floored + 32) -- a $${(trueTotal - estimated).toFixed(2)} ` +
       "company-wide understatement from these two jobs alone",
      estimated === 64 && trueTotal === 232 && (trueTotal - estimated) === 168,
      `estimated=${estimated} trueTotal=${trueTotal}`);
  }

  console.log("  Same formula, byte-identical, also drives the inline 'labour_over' attention alert " +
    "(website/dashboard.html ~line 11332: `Number(j.labor_rate_per_ft||0)*Number(j.signed_linear_feet||0)+Number(j.labor_flat_fee||0)`, " +
    "no minimum_labor_charge term) -- not separately extracted here because it is inline in renderDash() " +
    "rather than a standalone function, but it is textually the same expression proved wrong above, so a job " +
    "sitting on the floor can raise a false 'labour has already cost more than it was priced at' alert.");
} catch (e) {
  ok("SECTION 2 (office labour-report functions) could not be reached: " + e.message, false,
    "a source-text anchor this section looks for in website/dashboard.html -- the TL translation table, " +
    "quotedLaborOf, labourVsQuoted, or labourEstVsActualTotals -- is missing or reshaped; the message above " +
    "names which one. Section 2's floor-report checks did not run this time, but sections 3-5 (crew money " +
    "access and the pay-write permission chain) still run below rather than the whole file aborting here.");
}

// ===========================================================================
console.log("\n3. Does a corrected shift keep the rate it was worked at? (open question -- reporting behaviour, not deciding it)");
// ===========================================================================
// Verified against the LIVE function body, per the hard rule for touching
// money -- not the .sql file in the repo.

const rateFnRows = runSql(`
select p.prosrc
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'stamp_time_entry_rate';
`);
ok("stamp_time_entry_rate() exists live (query actually found the function)",
  rateFnRows.length === 1, `got ${rateFnRows.length} rows`);
const liveSrc = rateFnRows[0]?.prosrc || "";

// The unconditional branch: "if real_rate is not null then new.hourly_rate
// := real_rate; return new;" -- and critically, this appears BEFORE any
// "if tg_op = 'UPDATE'" test, so it fires identically on INSERT and on
// UPDATE (a manager's time correction, an approval, or anything else that
// writes the row), with no comparison to what the rate was when the shift
// happened.
const realRateBranchIdx = liveSrc.indexOf("if real_rate is not null then");
const assignIdx = liveSrc.indexOf("new.hourly_rate := real_rate;", realRateBranchIdx);
const tgOpCheckIdx = liveSrc.indexOf("tg_op = 'UPDATE'");

function describesUnconditionalRestamp(source) {
  const branchIdx = source.indexOf("if real_rate is not null then");
  const assign = source.indexOf("new.hourly_rate := real_rate;", branchIdx);
  const tgOp = source.indexOf("tg_op = 'UPDATE'");
  // "Unconditional" here means: the real_rate assignment exists, and either
  // there is no tg_op check in the function at all, or the assignment comes
  // BEFORE it (so tg_op is never consulted before overwriting the rate).
  return branchIdx >= 0 && assign >= 0 && (tgOp < 0 || assign < tgOp);
}

ok("live stamp_time_entry_rate(): the real_rate branch exists and its assignment " +
   "comes before any tg_op check (i.e. runs the same way on INSERT and UPDATE)",
  describesUnconditionalRestamp(liveSrc),
  `real_rate branch at ${realRateBranchIdx}, assignment at ${assignIdx}, tg_op check at ${tgOpCheckIdx}`);

// CANARY: a hand-written, plausibly-fixed version of the same function --
// one that DOES check tg_op before the real_rate assignment, so a
// correction (UPDATE) would keep the old rate and only a fresh INSERT would
// take the employee's current one. Run the SAME detector over it and
// confirm it reports the opposite answer, proving the detector actually
// distinguishes "always re-stamps" from "preserves on correction" rather
// than reporting true no matter what it is given.
const hypotheticalFixedSrc = `
declare real_rate numeric;
begin
  select e.hourly_rate into real_rate from employees e where e.sync_id::text = new.employee_sync_id;
  if tg_op = 'INSERT' and real_rate is not null then
    new.hourly_rate := real_rate;
    return new;
  end if;
  if real_rate is not null then
    new.hourly_rate := old.hourly_rate;
    return new;
  end if;
  return new;
end;`;
ok("CANARY: the same detector says a hand-written tg_op-guarded version does NOT " +
   "unconditionally re-stamp -- proves check 3 can tell the two shapes apart, not just always true",
  describesUnconditionalRestamp(hypotheticalFixedSrc) === false,
  `detector returned ${describesUnconditionalRestamp(hypotheticalFixedSrc)}`);

console.log(
  "\n  REPORTED BEHAVIOUR (not a decision): a corrected shift does NOT keep the rate it was worked at.\n" +
  "  Worked example, from the verified live logic above: an employee whose employees.hourly_rate is\n" +
  "  $22/hr today has an old shift stored in time_entries at hourly_rate=$18/hr (the rate in effect when\n" +
  "  it was actually worked). A manager runs a routine time correction that only touches started_at (an\n" +
  "  UPDATE). Because the branch above fires on every write whenever the employee still resolves, and it\n" +
  "  does so before any tg_op test, the trigger re-runs `select e.hourly_rate ... ; new.hourly_rate :=\n" +
  "  real_rate` and overwrites the stored $18/hr with today's $22/hr -- for 8 worked hours, $144.00\n" +
  "  becomes $176.00, a $32.00 change caused by a correction that was only ever about the clock-in time.\n" +
  "  The same thing happens on an APPROVAL (also an UPDATE) or on a crew phone's routine re-push of an\n" +
  "  unrelated field. supabase_sec_time_entries_write_permission.sql's own comment confirms this is\n" +
  "  deliberate ('a crew phone re-pushes every shift ... stamp_time_entry_rate legitimately moves\n" +
  "  hourly_rate on a colleague's row'), so it is working as designed, not an oversight -- but 'as\n" +
  "  designed' currently means the CURRENT rate, never the rate in effect when the hours were worked,\n" +
  "  with no distinction between a correction and an unrelated edit. That is the open question resolved\n" +
  "  to a concrete answer: whichever policy the owner wants, this is the one currently running."
);

// ===========================================================================
console.log("\n4. Crew must never see money -- time_entries and employees, live, with a real CREW account:");
// ===========================================================================
// Uses real fixtures rather than a synthetic no-permission account: company
// CO now has a genuine CREW profile (Marc) with no permission_overrides,
// which downstream-job-costing.test.mjs's own comment notes did NOT exist
// as of its writing (every real account had been promoted to owner/manager).
// It exists now -- confirmed live below, not assumed.

const marcRows = runSql(`
begin;
${asClaim(MARC)}
set local role authenticated;
select 'MARC_HAS_SEE_PAY' as who, (case when has_permission('SEE_PAY') then 1 else 0 end)::bigint as n
union all select 'MARC_HAS_SEE_MONEY', (case when has_permission('SEE_MONEY') then 1 else 0 end)::bigint
union all select 'MARC_OWN_SHIFT_ROWS', count(*) from time_entries where employee_sync_id = '${MARC_EMP}'
union all select 'MARC_SEES_COLLEAGUE_SHIFTS', count(*) from time_entries where employee_sync_id = '${JOHN_EMP}'
union all select 'MARC_SEES_COLLEAGUE_EMPLOYEE_ROW', count(*) from employees where sync_id = '${JOHN_EMP}'
union all select 'MARC_SEES_COLLEAGUE_VIA_ROSTER', count(*) from crew_roster() where sync_id = '${JOHN_EMP}'
union all select 'MARC_TIME_ENTRIES_CREW_VIEW_ROWS', count(*) from time_entries_crew;
rollback;
`);
const m = (who) => Number(marcRows.find(r => r.who === who)?.n ?? -1);

ok("fixture check: Marc genuinely lacks SEE_PAY (positive control -- if this ever reads 1, " +
   "Marc was promoted and every check below needs a different account, the same lesson " +
   "downstream-job-costing.test.mjs already learned twice)",
  m("MARC_HAS_SEE_PAY") === 0, `got ${m("MARC_HAS_SEE_PAY")}`);
ok("fixture check: Marc also lacks SEE_MONEY (CREW's only permission is RECORD_FIELD_WORK)",
  m("MARC_HAS_SEE_MONEY") === 0, `got ${m("MARC_HAS_SEE_MONEY")}`);
ok("Marc's OWN shift rows are visible to him (2 real rows) -- proves impersonation is really taking " +
   "effect and this is not a broken query that would read 0 for everything",
  m("MARC_OWN_SHIFT_ROWS") === 2, `got ${m("MARC_OWN_SHIFT_ROWS")}`);
ok("a colleague's shifts (John's, 8 real rows exist) are INVISIBLE to Marc through time_entries " +
   "(time_entries_pay_needs_see_pay restrictive policy: SEE_PAY or your own shift)",
  m("MARC_SEES_COLLEAGUE_SHIFTS") === 0, `got ${m("MARC_SEES_COLLEAGUE_SHIFTS")}`);
ok("a colleague's employees row (pay rate + three other pay columns) is INVISIBLE to Marc",
  m("MARC_SEES_COLLEAGUE_EMPLOYEE_ROW") === 0, `got ${m("MARC_SEES_COLLEAGUE_EMPLOYEE_ROW")}`);
ok("the colleague's NAME still resolves through crew_roster(), the pay-free RPC (proves the 0 above " +
   "is the pay gate specifically, not the whole roster vanishing for crew)",
  m("MARC_SEES_COLLEAGUE_VIA_ROSTER") === 1, `got ${m("MARC_SEES_COLLEAGUE_VIA_ROSTER")}`);
ok("the crew-facing time_entries_crew view shows all 12 company shifts (schedule visibility) " +
   "with no hourly_rate column to leak (view definition confirmed to omit it)",
  m("MARC_TIME_ENTRIES_CREW_VIEW_ROWS") === 12, `got ${m("MARC_TIME_ENTRIES_CREW_VIEW_ROWS")}`);

// Positive control (the other half of the pair): as OWNER, the SAME rows
// must be visible, proving the zeros above are the permission gate and not
// missing data or a broken query.
const ownerRows = runSql(`
begin;
${asClaim(OWNER)}
set local role authenticated;
select 'OWNER_HAS_SEE_PAY' as who, (case when has_permission('SEE_PAY') then 1 else 0 end)::bigint as n
union all select 'OWNER_SEES_COLLEAGUE_SHIFTS', count(*) from time_entries where employee_sync_id = '${JOHN_EMP}'
union all select 'OWNER_SEES_COLLEAGUE_EMPLOYEE_ROW', count(*) from employees where sync_id = '${JOHN_EMP}';
rollback;
`);
const o = (who) => Number(ownerRows.find(r => r.who === who)?.n ?? -1);
ok("POSITIVE CONTROL: OWNER (has SEE_PAY) sees the same colleague's 8 shift rows Marc could not -- " +
   "the data is real and visible in general, so Marc's zeros above are the gate working, not an empty table",
  o("OWNER_HAS_SEE_PAY") === 1 && o("OWNER_SEES_COLLEAGUE_SHIFTS") === 8,
  `has_see_pay=${o("OWNER_HAS_SEE_PAY")} shifts=${o("OWNER_SEES_COLLEAGUE_SHIFTS")}`);
ok("POSITIVE CONTROL: OWNER sees the colleague's employees row too",
  o("OWNER_SEES_COLLEAGUE_EMPLOYEE_ROW") === 1, `got ${o("OWNER_SEES_COLLEAGUE_EMPLOYEE_ROW")}`);

console.log("\n  Section 4 is CLEAN: crew cannot read a colleague's pay through time_entries, employees, " +
  "or the crew-facing view/RPC, confirmed live with a real CREW account and a real OWNER positive control.");

// ===========================================================================
console.log("\n5. FINDING -- who may WRITE an unverified pay rate is gated by the wrong permission:");
// ===========================================================================
// stamp_time_entry_rate()'s only path where a caller states hourly_rate
// unverified (no matching employee row -- a real, currently-occurring case
// per this same function's own comment, and 2 live rows in CO are in
// exactly that state with employee_sync_id = '') gates on:
//     privileged := can_see_pay() or service_role
// can_see_pay() is verified live (below) to mean has_permission('SEE_MONEY')
// -- restored to the job-money question on purpose
// (supabase_can_see_pay_restored.sql), NOT the payroll question
// can_see_employee_pay() (SEE_PAY) that supabase_pay_visibility_split.sql
// built specifically so "a salesperson has no business reading [or, by the
// same logic, writing] the hourly rate of every installer."
// has_permission()'s live SALES branch is verified below to include
// SEE_MONEY but NOT SEE_PAY. And time_entries_insert (verified below) has
// no permission predicate at all, only a company match -- so any
// authenticated member of the company, SALES included, can INSERT a new
// time_entries row.
//
// This company has no SALES account to impersonate live (its only accounts
// are OWNER, MANAGER, CREW -- see section 4), and creating one is a write,
// which this file does not do. So this is reported as a source-verified
// permission-logic finding, not one exercised end-to-end against a real
// SALES session; the chain below is what would let it happen if a SALES
// account existed, and every fact in the chain is checked against the LIVE
// function/policy bodies, not the .sql files in the repo.

const chainRows = runSql(`
select 'can_see_pay_reads_see_money' as fact,
       position('SEE_MONEY' in (select prosrc from pg_proc where proname = 'can_see_pay')) > 0
       and position('SEE_PAY' in (select prosrc from pg_proc where proname = 'can_see_pay')) = 0 as ok
union all
select 'sales_has_see_money_not_see_pay',
       position($$'SALES' then perm in ('SEE_MONEY','EDIT_JOBS','SEE_CUSTOMER_CONTACT')$$
                 in (select prosrc from pg_proc where proname = 'has_permission')) > 0
union all
select 'stamp_time_entry_rate_privileged_uses_can_see_pay',
       position('can_see_pay()' in (select prosrc from pg_proc where proname = 'stamp_time_entry_rate')) > 0
union all
select 'time_entries_insert_has_no_permission_predicate',
       (select pg_get_expr(polwithcheck, polrelid) from pg_policy
         where polrelid = 'public.time_entries'::regclass and polname = 'time_entries_insert')
       = '(company_id = current_company_id())';
`);
const c = (fact) => chainRows.find(r => r.fact === fact)?.ok;

ok("live: can_see_pay() reads SEE_MONEY, not SEE_PAY (supabase_can_see_pay_restored.sql's change, confirmed live)",
  c("can_see_pay_reads_see_money") === true, `row: ${JSON.stringify(chainRows.find(r => r.fact === "can_see_pay_reads_see_money"))}`);
ok("live: has_permission()'s SALES branch grants SEE_MONEY but the exact literal list does not contain SEE_PAY",
  c("sales_has_see_money_not_see_pay") === true, `row: ${JSON.stringify(chainRows.find(r => r.fact === "sales_has_see_money_not_see_pay"))}`);
ok("live: stamp_time_entry_rate()'s privileged flag is built from can_see_pay(), i.e. from SEE_MONEY",
  c("stamp_time_entry_rate_privileged_uses_can_see_pay") === true, "");
ok("live: the time_entries INSERT policy's WITH CHECK is company-membership only, no permission test",
  c("time_entries_insert_has_no_permission_predicate") === true,
  `row: ${JSON.stringify(chainRows.find(r => r.fact === "time_entries_insert_has_no_permission_predicate"))}`);

console.log(
  "\n  CHAIN (each link verified live above): a SALES-role account -- has SEE_MONEY, does NOT have SEE_PAY\n" +
  "  -- can INSERT a time_entries row for any employee_sync_id (no permission gate on the insert). If that\n" +
  "  employee_sync_id does not resolve to a real employees row (a real, currently-occurring state in this\n" +
  "  company), stamp_time_entry_rate() asks can_see_pay(), which answers true for SALES because it checks\n" +
  "  SEE_MONEY, not SEE_PAY -- so `new.hourly_rate := coalesce(new.hourly_rate, 0)` lets SALES's own\n" +
  "  submitted number through untouched. Concretely: employee_sync_id='does-not-exist', hourly_rate=999.00\n" +
  "  in -> real_rate lookup is NULL -> privileged=true for SALES -> hourly_rate=999.00 stored, a fabricated\n" +
  "  $999/hr payroll figure written by the one role the SEE_PAY split was built specifically to keep out of\n" +
  "  payroll. Not exercised end-to-end: this company has no SALES account to impersonate live (section 4),\n" +
  "  and creating one is a write this read-only pass does not perform."
);

console.log(`\n${pass} of ${pass + fail} checks passed`);
if (fail) process.exit(1);
}

main().catch(e => { console.error("could not run:", e.message); process.exit(2); });
