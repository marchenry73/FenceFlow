// Owner's list, item 3: "suggested quantities still moved the price after a
// while". The phone keeps a line somebody edited (TakeoffLineMerge); the
// office's price-job used to replace it and carry only its typed PRICE by
// role. The job sheet calls price-job commit on its own whenever a tax,
// markup, discount or labour rate is saved, so a quantity typed on the phone
// went back to the engine's number the next time the office saved a rate.
//
// This drives the server the way price-job/index.ts drives it -- load the
// job's live line rows, buildPricingInput, priceJob, buildCommitPlan, then
// tombstone and upsert -- against a small in-memory estimate_line_items
// table that keeps tombstoned rows, the way the real one does. Then it looks
// at the table, not at the plan: the plan is only right if the rows are.
//
// The parity fixtures prove priceJob's merge agrees with the phone's engine.
// They do not reach buildCommitPlan, which is where the typed quantity was
// actually lost, so the write side is proved here.
//
// Planted failures: every scenario also runs against the rule price-job had
// before this change (oldRule below, reproduced from the code it replaced)
// and must FAIL there. A scenario the old rule also passes proves nothing,
// so that is reported as a failure too.
//
//   npx tsx tests/price-job-takeoff-merge.test.mjs
import { PRICING_ENGINE_VERSION, priceJob } from "../supabase/functions/_shared/pricing/index.ts";
import { buildCommitPlan, buildPricingInput, commitLineItemWrite } from "../supabase/functions/_shared/pricing/load.ts";
import { deterministicSyncId } from "../supabase/functions/_shared/pricing/line-items.ts";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " -- " + detail : ""}`); }
};

// ---------------------------------------------------------------- fixtures --

const item = (name, role, fence_type, unit_price, extra = {}) => ({
  sync_id: `cat-${name}`, name, category: "MISC", role, fence_type, color_or_finish: "White", unit: "EA",
  unit_price, taxable: true, covers_ft: null, is_active: true, manufacturer_sync_id: null, ...extra,
});
const CATALOG = [
  item("Panel 6 White", "PANEL", "VINYL", 52.35, { taxable: false, covers_ft: 6 }),
  item("Line Post White", "LINE_POST", "VINYL", 16.56),
  item("End Post White", "END_POST", "VINYL", 16.56),
  item("Post Cap White", "POST_CAP", "VINYL", 0.74),
  item("Gate 4 White", "GATE_PANEL", "VINYL", 170.0, { covers_ft: 4 }),
  item("Gate 6 White", "GATE_PANEL", "VINYL", 230.0, { covers_ft: 6 }),
  item("Hinge Set", "HINGE_SET", "VINYL", 32.25),
  item("Latch", "LATCH", "VINYL", 25.87),
  item("Concrete 60lb", "CONCRETE_BAG", "UNIVERSAL", 4.75, { color_or_finish: "" }),
];

const JOB = {
  sync_id: "job-1", updated_at: "2026-09-22T12:00:00Z", calibration_pixels_per_foot: 20,
  tax_rate_percent: 7, markup_percent: 0, discount_percent: 0, labor_rate_per_ft: 8, labor_flat_fee: 0,
  minimum_job_charge: 0, waste_percent: 0, gate_rate_per_ft: 20, trash_haul_fee: 0,
  teardown_enabled: false, teardown_flat_fee: 0, teardown_rate_per_ft: 0, teardown_feet: 0,
  preferred_manufacturer_sync_id: null,
};

const RUN_ID = "5b0c1f7e-0000-4000-8000-000000000001";
const run = (overrides = {}) => ({
  sync_id: RUN_ID, label: "Back", fence_type: "VINYL", color_or_finish: "White",
  points_encoded: "", gates_encoded: "", closed_loop: false, manual_linear_feet: 100, manual_corner_count: 0,
  panel_width_ft: 6, panel_height_ft: 6, post_spacing_ft: 6, concrete_bags_per_post: 1,
  aluminum_style: "RACKABLE", wood_style: "PRIVACY", wood_rail_count: 3, picket_width_in: 5.5, picket_gap_in: 0,
  fabric_height_ft: 4, include_top_rail: true, include_tension_wire: false, include_barbed_wire_arms: false,
  include_privacy_slats: false, split_rail_count: 2, suppressed_roles: "", is_teardown: false, sort_order: 0,
  ...overrides,
});
const FOUR = "400:0:4.0:LINE:IN";
const FOUR_AND_SIX = "400:0:4.0:LINE:IN,1200:0:6.0:LINE:IN";

// ------------------------------------------------ the table and the commit --

/** estimate_line_items for one job: sync_id -> row, tombstoned rows kept. */
const table = () => new Map();
const liveRows = (t) => [...t.values()].filter((r) => r.deleted_at === null);
const liveOf = (t, pred) => liveRows(t).filter(pred);

/**
 * The rule price-job had before this change, reproduced from the code it
 * replaced: every roled line of a priced run replaced (edited ones too), the
 * typed price carried by role onto the rebuilt line (flipping it to edited),
 * supplier quotes carried by role, every rebuilt line upserted, every other
 * roled line of the run tombstoned.
 */
function oldRule(input, existingItems, runIds) {
  const onPricedRun = (e) => e.fence_run_sync_id !== null && runIds.includes(e.fence_run_sync_id);
  const roled = (e) => e.role !== null && e.role !== "NONE";
  const bare = priceJob({ ...input, existing_items: input.existing_items.filter((e) => !(onPricedRun(e) && roled(e))) });
  const items = bare.items.map((i) => {
    let edited, quoted;
    for (const e of existingItems) {
      if (e.fence_run_sync_id !== i.fence_run_sync_id || e.role !== i.role) continue;
      if (!e.auto_generated) edited = e.unit_price;
      if (e.supplier_unit_price !== null) quoted = e.supplier_unit_price;
    }
    let out = quoted !== undefined ? { ...i, supplier_unit_price: quoted } : i;
    if (edited !== undefined && edited !== out.unit_price) out = { ...out, unit_price: edited, auto_generated: false };
    return out;
  });
  const written = new Set(items.map((i) => i.sync_id));
  return {
    output: { ...bare, items },
    plan: {
      upsertItems: items.map((i) => commitLineItemWrite(i, "co", "job-1")),
      tombstoneSyncIds: existingItems.filter((e) => onPricedRun(e) && roled(e) && !written.has(e.sync_id)).map((e) => e.sync_id),
    },
  };
}

/** One office commit, in price-job/index.ts's order: read, price, plan, tombstone, upsert. */
function commit(t, { job = JOB, runs }, rule) {
  const existingItems = liveRows(t).map(({ deleted_at, ...row }) => row);
  const input = buildPricingInput({
    job, runs, catalog: CATALOG, manufacturers: [], changeOrders: [], existingItems, engineVersion: PRICING_ENGINE_VERSION,
  });
  const runIds = runs.map((r) => r.sync_id);
  const { output, plan } = rule === "old"
    ? oldRule(input, existingItems, runIds)
    : (() => {
      const out = priceJob(input);
      return {
        output: out,
        plan: buildCommitPlan({ output: out, companyId: "co", jobSyncId: "job-1", pricedRunSyncIds: runIds, existingItems, nowIso: "t" }),
      };
    })();
  for (const id of plan.tombstoneSyncIds) {
    const row = t.get(id);
    tombstoned.push({ ...row });
    row.deleted_at = "t";
  }
  for (const w of plan.upsertItems) {
    const { company_id, job_sync_id, deleted_by, ...row } = w;
    t.set(w.sync_id, { ...row, deleted_at: null });
  }
  return { output, plan };
}
/** Every row any commit in this file tombstoned, as it was just before. */
const tombstoned = [];

/** What EditLineItemDialog saves and the push sends: the typed values, auto_generated = false. */
function phoneEdits(t, syncId, fields) {
  Object.assign(t.get(syncId), fields, { auto_generated: false });
}

// --------------------------------------------------------------- scenarios --
// Each returns [label, passed] pairs. `planted` names the checks the old rule
// must fail -- the reason the scenario exists.

const scenarios = [
  {
    name: "a quantity typed on the phone survives the office saving a rate",
    planted: ["the typed 18 panels stand", "the edited line is still marked edited"],
    run(rule) {
      const t = table();
      commit(t, { runs: [run()] }, rule);
      const panelId = deterministicSyncId(RUN_ID, "PANEL");
      const built = t.get(panelId).quantity;
      phoneEdits(t, panelId, { quantity: 18 });
      // The office saves a new labour rate; the job sheet re-prices on its own.
      const { output, plan } = commit(t, { job: { ...JOB, labor_rate_per_ft: 9 }, runs: [run()] }, rule);
      const panels = liveOf(t, (r) => r.role === "PANEL");
      return [
        ["the engine had built 17", built === 17],
        ["exactly one panel line", panels.length === 1],
        ["the typed 18 panels stand", panels[0]?.quantity === 18],
        ["the edited line is still marked edited", panels[0]?.auto_generated === false],
        ["the total the office stamps is summed with the 18", output.totals_items.includes(panelId) &&
          output.items.find((i) => i.sync_id === panelId)?.quantity === 18],
        ["the edited line is not in the writes", !plan.upsertItems.some((w) => w.sync_id === panelId)],
        ["no two live lines share a sync id", new Set(liveRows(t).map((r) => r.sync_id)).size === liveRows(t).length],
      ];
    },
  },
  {
    name: "a rebuild that matches what is there writes nothing",
    planted: [
      "a second commit with nothing changed writes nothing", "the same with an edited line on the run",
      "lines that differ only in their order are not rewritten",
    ],
    run(rule) {
      const t = table();
      commit(t, { runs: [run()] }, rule);
      const again = commit(t, { runs: [run()] }, rule).plan;
      phoneEdits(t, deterministicSyncId(RUN_ID, "LINE_POST"), { quantity: 20 });
      const withEdit = commit(t, { job: { ...JOB, tax_rate_percent: 8 }, runs: [run()] }, rule).plan;
      // Rows an older build numbered differently: the same lines in another
      // order are not a change (the phone's takeoffFingerprint has no sort
      // order in it), so the whole run is left alone.
      for (const r of liveRows(t)) r.sort_order += 100;
      const renumbered = commit(t, { runs: [run()] }, rule).plan;
      return [
        ["a second commit with nothing changed writes nothing", again.upsertItems.length === 0 && again.tombstoneSyncIds.length === 0],
        ["the same with an edited line on the run", withEdit.upsertItems.length === 0 && withEdit.tombstoneSyncIds.length === 0],
        ["lines that differ only in their order are not rewritten",
          renumbered.upsertItems.length === 0 && renumbered.tombstoneSyncIds.length === 0],
      ];
    },
  },
  {
    name: "an edited line for a role the run no longer builds is kept, never tombstoned",
    planted: ["the edited gate line is still live", "it still counts in the totals"],
    run(rule) {
      const t = table();
      commit(t, { runs: [run({ gates_encoded: FOUR })] }, rule);
      const gateId = deterministicSyncId(RUN_ID, "GATE_PANEL");
      phoneEdits(t, gateId, { unit_price: 199 });
      // The gate comes off the drawing.
      const { output } = commit(t, { runs: [run()] }, rule);
      const hinge = t.get(deterministicSyncId(RUN_ID, "HINGE_SET"));
      return [
        ["the edited gate line is still live", t.get(gateId).deleted_at === null && t.get(gateId).unit_price === 199],
        ["it still counts in the totals", output.totals_items.includes(gateId)],
        ["the generated hinge line did go", hinge.deleted_at !== null],
      ];
    },
  },
  {
    name: "a typed price is not copied onto the other gate width",
    planted: ["the 6 ft gate is at its catalog price", "the 6 ft gate still follows the drawing"],
    run(rule) {
      const t = table();
      commit(t, { runs: [run({ gates_encoded: FOUR })] }, rule);
      const oldGateId = deterministicSyncId(RUN_ID, "GATE_PANEL");
      phoneEdits(t, oldGateId, { unit_price: 185 });
      // A 6 ft gate is added: GATE_PANEL now repeats, so both built panels
      // get width ids and neither is the edited line's.
      commit(t, { runs: [run({ gates_encoded: FOUR_AND_SIX })] }, rule);
      const gates = liveOf(t, (r) => r.role === "GATE_PANEL");
      const six = gates.find((r) => r.description === "Gate 6 White");
      const fours = gates.filter((r) => r.description === "Gate 4 White");
      return [
        ["two gate panel lines: the edited 4 ft and a new 6 ft", gates.length === 2 && fours.length === 1],
        ["the edited 4 ft keeps its typed $185", fours[0]?.sync_id === oldGateId && fours[0]?.unit_price === 185],
        ["the 6 ft gate is at its catalog price", six?.unit_price === 230],
        ["the 6 ft gate still follows the drawing", six?.auto_generated === true],
      ];
    },
  },
  {
    name: "a teardown run keeps the line somebody typed and drops the generated ones",
    planted: ["the typed concrete line is still live"],
    run(rule) {
      const t = table();
      commit(t, { runs: [run()] }, rule);
      const bagId = deterministicSyncId(RUN_ID, "CONCRETE_BAG");
      phoneEdits(t, bagId, { quantity: 4 });
      commit(t, { runs: [run({ is_teardown: true })] }, rule);
      return [
        ["the typed concrete line is still live", t.get(bagId).deleted_at === null && t.get(bagId).quantity === 4],
        ["every generated line of the run went", liveOf(t, (r) => r.auto_generated).length === 0],
      ];
    },
  },
];

for (const s of scenarios) {
  console.log(`\n${s.name}`);
  for (const [label, passed] of s.run("new")) ok(label, passed);
  const old = new Map(s.run("old"));
  const caught = s.planted.filter((label) => old.get(label) === false);
  ok(`planted: the old rule fails "${s.planted.join('", "')}"`, caught.length === s.planted.length,
    `old rule passed ${s.planted.filter((l) => !caught.includes(l)).join(", ")}`);
}

// ----------------------------------------------- resurrection, kept as is --

console.log("\na role that comes back lands on its own tombstoned row, alive again");
{
  const t = table();
  commit(t, { runs: [run({ gates_encoded: FOUR })] }, "new");
  const gateIds = liveOf(t, (r) => ["GATE_PANEL", "HINGE_SET", "LATCH"].includes(r.role)).map((r) => r.sync_id);
  commit(t, { runs: [run()] }, "new");
  ok("taking the gate off tombstones its three lines", gateIds.length === 3 && gateIds.every((id) => t.get(id).deleted_at !== null));

  const knownBefore = new Set(t.keys());
  const back = commit(t, { runs: [run({ gates_encoded: FOUR })] }, "new").plan;
  ok("putting it back writes the same three sync ids", gateIds.every((id) => back.upsertItems.some((w) => w.sync_id === id)));
  ok("each written with deleted_at cleared", back.upsertItems.every((w) => w.deleted_at === null && w.deleted_by === ""));
  ok("and they are live again", gateIds.every((id) => t.get(id).deleted_at === null));

  // Planted: a plan that left out any id the table already holds, live or
  // tombstoned -- "it exists, so skip it" -- would leave the gate invisible
  // for good. Same writes, filtered that way, must miss the gate lines.
  const skipsKnown = back.upsertItems.filter((w) => !knownBefore.has(w.sync_id));
  ok("planted: skipping ids the table already holds would not bring the gate back",
    gateIds.every((id) => !skipsKnown.some((w) => w.sync_id === id)));
}

// ------------------------------------------ an edit between read and write --

console.log("\na line the phone edits between price-job's read and its write is not tombstoned");
{
  // buildCommitPlan picks tombstones from the rows it READ as generated. The
  // write happens later, so index.ts's UPDATE asks the row itself as well:
  // still generated, still live. Read from the source, so the filter the
  // table below applies is the one that ships.
  const indexSrc = readFileSync(new URL("../supabase/functions/price-job/index.ts", import.meta.url), "utf8");
  const at = indexSrc.indexOf(".update({ deleted_at: nowIso, deleted_by: uid })");
  const chain = at < 0 ? "" : indexSrc.slice(at, indexSrc.indexOf(";", at));
  const guarded = (c) => c.includes('.eq("auto_generated", true)') && c.includes('.is("deleted_at", null)');
  ok("index.ts's tombstone update was found", chain.includes(".in(\"sync_id\", plan.tombstoneSyncIds)"));
  ok("it asks the row itself to be generated and live", guarded(chain));
  ok("planted: the update by sync id alone is caught", !guarded(chain.replace(/\s*\.eq\("auto_generated", true\)/, "")));

  const race = (filtered) => {
    const t = table();
    commit(t, { runs: [run({ gates_encoded: FOUR })] }, "new");
    // price-job reads the job and plans the gate coming off the drawing...
    const existingItems = liveRows(t).map(({ deleted_at, ...row }) => row);
    const input = buildPricingInput({
      job: JOB, runs: [run()], catalog: CATALOG, manufacturers: [], changeOrders: [], existingItems,
      engineVersion: PRICING_ENGINE_VERSION,
    });
    const plan = buildCommitPlan({
      output: priceJob(input), companyId: "co", jobSyncId: "job-1", pricedRunSyncIds: [RUN_ID], existingItems, nowIso: "t",
    });
    // ...a phone's edit to the hinge line lands before the write does...
    const hingeId = deterministicSyncId(RUN_ID, "HINGE_SET");
    phoneEdits(t, hingeId, { unit_price: 40 });
    // ...and the tombstone UPDATE runs, with index.ts's filters or by id alone.
    for (const id of plan.tombstoneSyncIds) {
      const row = t.get(id);
      if (!filtered || (row.auto_generated === true && row.deleted_at === null)) row.deleted_at = "t";
    }
    return { t, plan, hingeId };
  };
  const { t, plan, hingeId } = race(true);
  ok("the plan did pick the hinge line", plan.tombstoneSyncIds.includes(hingeId));
  ok("the edited hinge line is still live, as typed", t.get(hingeId).deleted_at === null && t.get(hingeId).unit_price === 40);
  ok("the gate's generated lines still went", ["GATE_PANEL", "LATCH"]
    .every((role) => t.get(deterministicSyncId(RUN_ID, role)).deleted_at !== null));
  const byId = race(false);
  ok("planted: by sync id alone the edited hinge line is tombstoned", byId.t.get(byId.hingeId).deleted_at !== null);
}

// ------------------------------------- what the permission check relies on --

console.log("\nevery tombstone is one the takeoff carve-out lets an EDIT_JOBS caller make");
{
  // enforce_delete_permission lets a caller with EDIT_JOBS (and without
  // DELETE_RECORDS) tombstone an estimate line that WAS auto-generated, has a
  // material role and sits on a run. price-job now accepts either
  // permission, which is only safe if every tombstone it makes is one of
  // those.
  const carveOut = (r) => r.auto_generated === true && r.role !== null && r.role !== "NONE" && r.fence_run_sync_id !== null;
  const madeBy = (rule) => {
    tombstoned.length = 0;
    for (const s of scenarios) s.run(rule);
    return tombstoned.slice();
  };
  const fromNew = madeBy("new");
  ok("the scenarios above made tombstones at all", fromNew.length > 0);
  ok("the new rule never tombstoned an edited, role-NONE or runless line", fromNew.every(carveOut),
    fromNew.filter((r) => !carveOut(r)).map((r) => `${r.role} ${r.sync_id}`).join(", "));
  // Planted: the old rule tombstoned edited lines, which the carve-out
  // refuses -- so the same predicate over its tombstones must find some.
  ok("planted: the old rule's tombstones include lines outside the carve-out", !madeBy("old").every(carveOut));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
