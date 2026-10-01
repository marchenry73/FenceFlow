// A 6 ft fence that drops to 4 ft and carries on: the TRANSITION ITEM, as it would be if built.
//
// Spec:  docs/JOINING_RUNS.md section 4 (the middle run) and section 6 (the item).
// Run:   npx tsx tests/a32-join-transition.test.mjs
//
// =============================================================================
// CONTESTED. READ THIS BEFORE ACTING ON A RED LINE.
// =============================================================================
// The request this was written for said to add a transition item. Two other pieces of work
// written the same day say the owner decided AGAINST one: a 6 ft fence that steps down to 4 ft is
// priced as 6 ft, the raked bay being a standard 6 ft panel cut on site (the header of
// a32-panel-choice-ignores-height.test.mjs, and docs/PANEL_HEIGHT_BLINDNESS.md). Which of the two
// is current is not something the code can say. Nothing here may be implemented until it is
// confirmed.
//
//   * If the transition item IS wanted: build it to this file. It is red on purpose, exactly as
//     a32-join-posts.test.mjs is.
//   * If it is NOT: delete this file, section 6 of the document, the TRANSITION_PANEL / is_transition
//     lines of supabase_a32_join_runs.sql (PART 2) and nothing else. Joining does not depend on
//     any of it. a32-join-posts.test.mjs case P10 already pins the 6-to-4 fence priced as ordinary
//     bays, which is what the "priced as 6 ft" decision needs from the engine.
//
// What this file pins, if it is wanted. Two things are missing:
//   * JOINING (the 6 ft run, the transition and the 4 ft run are three runs meeting
//     end to end -- height lives on the run, so a fence cannot change height inside
//     one run);
//   * the TRANSITION ITEM itself: a catalog role and a run flag. The 92-row starting
//     catalog has no transition, rake or step item at any height, so today such a
//     fence cannot be priced as one at all.
//
// One dependency is NOT in this file: a transition could not be SELECTED until height is a
// selection key, and it is not one today. That defect is measured, with a reference fix, by
// a34-height-blindness.test.mjs and a32-panel-choice-ignores-height.test.mjs.
//
// Field names used here (all proposed in docs/JOINING_RUNS.md): run.is_transition,
// run.start_joint / end_joint, catalog role TRANSITION_PANEL. If the implementer names
// one differently, change it HERE and in the document in the same commit -- do not
// weaken the case.

import { priceJob, PRICING_ENGINE_VERSION } from "../supabase/functions/_shared/pricing/index.ts";

const tally = { baselineOk: 0, baselineFail: 0, pendingRed: 0, pendingLanded: 0, guardOk: 0, guardVacuous: 0, guardFail: 0 };

function baseline(id, label, cond, detail = "") {
  if (cond) { tally.baselineOk++; console.log(`  ok        ${id} ${label}`); }
  else { tally.baselineFail++; console.log(`  FAIL      ${id} ${label} -- REGRESSION: ${detail}`); }
}
function pending(id, label, cond, expected, got, tag = "joining + transition item; CONTESTED, see the header") {
  if (cond) { tally.pendingLanded++; console.log(`  ok        ${id} ${label}   (has landed)`); }
  else {
    tally.pendingRed++;
    console.log(`  PENDING   ${id} ${label}`);
    console.log(`            expected ${expected}`);
    console.log(`            got      ${got}`);
    console.log(`            red on purpose (${tag}) -- docs/JOINING_RUNS.md`);
  }
}
function guard(id, label, controlLive, cond, detail = "") {
  if (!controlLive) {
    tally.guardVacuous++;
    console.log(`  vacuous   ${id} ${label}`);
    console.log(`            (control not live: the transition item is not implemented, so this proves nothing yet)`);
  } else if (cond) { tally.guardOk++; console.log(`  ok        ${id} ${label}`); }
  else { tally.guardFail++; console.log(`  FAIL      ${id} ${label} -- ${detail}`); }
}

const JOB = {
  calibration_pixels_per_foot: null,
  tax_rate_percent: 0, markup_percent: 0, discount_percent: 0,
  labor_rate_per_ft: 8, labor_flat_fee: 0, minimum_job_charge: 0, minimum_labor_charge: 0,
  waste_percent: 0, gate_rate_per_ft: 20, trash_haul_fee: 0,
  teardown_enabled: false, teardown_flat_fee: 0, teardown_rate_per_ft: 0, teardown_feet: 0,
  preferred_manufacturer_sync_id: null,
};
function run(sync_id, o = {}) {
  return {
    sync_id, label: sync_id, fence_type: "VINYL", color_or_finish: "White",
    points_encoded: "", gates_encoded: "", closed_loop: false,
    manual_linear_feet: null, manual_corner_count: 0,
    panel_width_ft: 6, panel_height_ft: 6, post_spacing_ft: 6, concrete_bags_per_post: 1,
    aluminum_style: "RACKABLE", wood_style: "PRIVACY", wood_rail_count: 3, picket_width_in: 5.5, picket_gap_in: 0,
    fabric_height_ft: 4, include_top_rail: true, include_tension_wire: false, include_barbed_wire_arms: false,
    include_privacy_slats: false, split_rail_count: 2, suppressed_roles: "",
    is_teardown: false, sort_order: 0,
    start_joint: "", end_joint: "", is_transition: false,
    ...o,
  };
}
let catSeq = 0;
function item(role, name, unit_price, o = {}) {
  catSeq++;
  return {
    sync_id: `a32b0000-0000-4000-8000-${String(catSeq).padStart(12, "0")}`, name, category: role === "PANEL" ? "PANEL" : "MISC",
    role, fence_type: "VINYL", color_or_finish: "White", unit: "EA", unit_price, supplier_unit_price: null,
    taxable: true, covers_ft: 6, is_active: true, manufacturer_sync_id: null, ...o,
  };
}
const price = (runs, catalog = []) => priceJob({
  engine_version: PRICING_ENGINE_VERSION, pixels_per_foot: 20, job: JOB, runs, catalog, manufacturers: [], change_orders: [], existing_items: [],
});
const pts = (...p) => p.map(([x, y]) => `${x}:${y}`).join(",");
const J1 = "a32a0002-0000-4000-8000-000000000001";
const J2 = "a32a0002-0000-4000-8000-000000000002";

// 30 ft of 6 ft fence, ONE bay (6 ft) of transition, 24 ft of 4 ft fence. Three runs end to end.
const stepped = () => [
  run("A", { points_encoded: pts([0, 0], [600, 0]), sort_order: 0, panel_height_ft: 6, end_joint: J1 }),
  run("T", { points_encoded: pts([600, 0], [720, 0]), sort_order: 1, panel_height_ft: 6, is_transition: true, start_joint: J1, end_joint: J2 }),
  run("C", { points_encoded: pts([720, 0], [1200, 0]), sort_order: 2, panel_height_ft: 4, start_joint: J2 }),
];
const lines = (out, runId) => out.items.filter((i) => i.fence_run_sync_id === runId);
const entry = (out, runId, role) => out.runs.find((r) => r.run_sync_id === runId).entries.find((e) => e.role === role);
const total = (out) => out.runs.reduce((s, r) => s + r.posts.total, 0);

// =============================================================================
console.log("\n1. PENDING -- the middle run carries a transition item, not a standard panel");
// =============================================================================
{
  const out = price(stepped());
  const t = entry(out, "T", "TRANSITION_PANEL"), tPanel = entry(out, "T", "PANEL");
  pending("T1a", "the transition run asks for 1 TRANSITION_PANEL (one bay, 6 ft wide) and NO standard PANEL",
    !!t && t.quantity === 1 && t.prefer_covers_ft === 6 && !tPanel,
    "T: TRANSITION_PANEL x1 (prefer 6 ft), no PANEL",
    `T: ${out.runs.find((r) => r.run_sync_id === "T").entries.filter((e) => e.quantity > 0 && /PANEL/.test(e.role)).map((e) => `${e.role} x${e.quantity}`).join(", ") || "no panel entry"}`);
  const a = entry(out, "A", "PANEL"), c = entry(out, "C", "PANEL");
  guard("T1b", "the 6 ft run (5 panels) and the 4 ft run (4 panels) keep ordinary PANEL entries and ask for no transition",
    !!t, a?.quantity === 5 && c?.quantity === 4 && !entry(out, "A", "TRANSITION_PANEL") && !entry(out, "C", "TRANSITION_PANEL"),
    `A ${a?.quantity}, C ${c?.quantity}`);
  pending("T1c", "three runs, 10 bays, joined at both steps: 11 posts, not 13",
    total(out) === 11, "11 posts", `${total(out)} posts`);
  guard("T1d", "the transition bay is billed labour as fence footage like any bay: 60 ft, not 54 ft",
    !!t, out.billable_linear_feet === 60, `billable ${out.billable_linear_feet}`);
}

// =============================================================================
console.log("\n2. PENDING -- priced from the catalog, and honest when the catalog has nothing");
// =============================================================================
{
  const cat = [
    item("PANEL", "Panel 6 ft high x 6 ft wide", 52.35),
    item("TRANSITION_PANEL", "Transition panel 6 ft to 4 ft x 6 ft wide", 90.0),
  ];
  const out = price(stepped(), cat);
  const tl = lines(out, "T").filter((i) => i.role === "TRANSITION_PANEL");
  pending("T2a", "the transition run's panel line is the catalog TRANSITION_PANEL row: qty 1 at $90.00, and there is no PANEL line on that run",
    tl.length === 1 && tl[0].quantity === 1 && tl[0].unit_price === 90 && !lines(out, "T").some((i) => i.role === "PANEL"),
    "T: TRANSITION_PANEL x1 @ $90.00, no PANEL line",
    lines(out, "T").map((i) => `${i.role} x${i.quantity} @ $${i.unit_price}`).join(", ") || "no lines");
  const aPanel = lines(out, "A").find((i) => i.role === "PANEL");
  guard("T2b", "the ordinary runs still price from the ordinary PANEL row ($52.35), never from the transition row",
    tl.length === 1, !!aPanel && aPanel.unit_price === 52.35, `A panel ${aPanel && aPanel.unit_price}`);
}
{
  // NO silent substitute. A rake priced as a flat panel undercharges and says nothing.
  const out = price(stepped(), [item("PANEL", "Panel 6 ft high x 6 ft wide", 52.35)]);
  const unmatched = out.unmatched_roles.some((u) => u.run_sync_id === "T" && u.role === "TRANSITION_PANEL");
  const substituted = lines(out, "T").some((i) => i.role === "PANEL");
  pending("T3", "with no transition row in the catalog the run reports TRANSITION_PANEL as unmatched and is NOT quietly priced as a standard panel",
    unmatched && !substituted, "unmatched_roles has T/TRANSITION_PANEL; no PANEL line on T",
    `unmatched ${JSON.stringify(out.unmatched_roles.filter((u) => u.run_sync_id === "T"))}, T lines ${lines(out, "T").map((i) => i.role).join(",") || "none"}`);
}

// =============================================================================
console.log("\n3. GUARD -- the flag means nothing where there is no discrete panel");
// =============================================================================
{
  // Wood is pickets and rails, chain link is fabric: neither has a transition panel to sell.
  const control = !!entry(price(stepped()), "T", "TRANSITION_PANEL");
  const out = price([run("W", { fence_type: "WOOD", points_encoded: pts([0, 0], [600, 0]), is_transition: true })]);
  const e = out.runs[0].entries;
  guard("T4", "is_transition on a WOOD run is ignored: it is priced from pickets and rails as usual, no TRANSITION_PANEL",
    control, !e.some((x) => x.role === "TRANSITION_PANEL") && e.some((x) => x.role === "WOOD_PICKET" && x.quantity > 0),
    `entries ${e.filter((x) => x.quantity > 0).map((x) => x.role).join(",")}`);
}

// ---------------------------------------------------------------------------
const real = tally.baselineFail + tally.guardFail;
console.log("\n----------------------------------------------------------------------");
console.log(`BASELINE  ${tally.baselineOk} ok, ${tally.baselineFail} FAIL`);
console.log(`PENDING   ${tally.pendingRed} red (expected until the work lands), ${tally.pendingLanded} landed`);
console.log(`GUARDS    ${tally.guardOk} ok, ${tally.guardVacuous} vacuous (control not live), ${tally.guardFail} FAIL`);
if (real > 0) console.log(`\n${real} REGRESSION(S).`);
else if (tally.pendingRed > 0) console.log(`\nRed on purpose: ${tally.pendingRed} case(s) wait for joining and the transition item. CONTESTED: confirm the owner wants the item before building to this (see the header). Spec: docs/JOINING_RUNS.md`);
else if (tally.guardVacuous > 0) console.log(`\n${tally.guardVacuous} guard(s) are still vacuous.`);
else console.log("\nThe transition item has landed and every guard has a live control.");
process.exit(real > 0 || tally.pendingRed > 0 || tally.guardVacuous > 0 ? 1 : 0);
