/**
 * Hand-computed cases for the port, checkable with a pencil.
 *
 * These are NOT the parity gate -- parity.ts replays the Kotlin fixtures
 * and is the only thing that proves the two engines agree. This file
 * exists so the port can be exercised before the fixtures land, and so a
 * regression in the arithmetic is caught by numbers a person worked out
 * rather than by numbers the code itself produced. Every expected value
 * below was derived by hand from the rules in EstimateEngine.kt.
 *
 *   npx -y tsx supabase/functions/_shared/pricing/smoke.ts
 *   deno run -A supabase/functions/_shared/pricing/smoke.ts
 */
import { createHash } from "node:crypto";
import process from "node:process";
import { f32 } from "./f32.ts";
import { analyze, decodeGates, decodePoints } from "./geometry.ts";
import { equalsIgnoreCase, kotlinFloatToString, toFloatOrNull } from "./kotlin-text.ts";
import { PRICING_ENGINE_VERSION, priceJob } from "./index.ts";
import type { FenceRunRow, JobRow, LineItemRow, MaterialItemRow, PricingInput } from "./index.ts";
import { md5, nameUUIDFromString } from "./uuid3.ts";

let failures = 0;
let checks = 0;

function describe(v: unknown): string {
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  return JSON.stringify(v) ?? String(v);
}

function check(name: string, actual: unknown, expected: unknown): void {
  checks++;
  const same = typeof actual === "number" && typeof expected === "number"
    ? Object.is(actual, expected)
    : JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) {
    failures++;
    console.log(`FAIL ${name}\n     expected ${describe(expected)}\n     actual   ${describe(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

// java.util.UUID.nameUUIDFromBytes("hello".getBytes()) -- the textbook vector.
check("uuid3 hello", nameUUIDFromString("hello"), "5d41402a-bc4b-3a76-b971-9d911017c592");
for (const text of ["", "a", "fenceflow-line:run:PANEL:4.0", "x".repeat(55), "y".repeat(56), "z".repeat(64), "w".repeat(1000)]) {
  const ours = Array.from(md5(new TextEncoder().encode(text))).map((b) => b.toString(16).padStart(2, "0")).join("");
  check(`md5 ${JSON.stringify(text.slice(0, 12))}(${text.length})`, ours, createHash("md5").update(text, "utf8").digest("hex"));
}

const floatStrings: Array<[number, string]> = [
  [3.5, "3.5"], [4, "4.0"], [5, "5.0"], [10, "10.0"], [12, "12.0"], [0, "0.0"], [-0, "-0.0"],
  [7.99, "7.99"], [0.1, "0.1"], [0.3, "0.3"], [100, "100.0"], [-2.5, "-2.5"], [0.0025, "0.0025"],
  [1e7, "1.0E7"], [9999999, "9999999.0"], [1234567, "1234567.0"], [1e-4, "1.0E-4"], [1e-5, "1.0E-5"],
  [0.001, "0.001"], [0.00123, "0.00123"], [123456789, "1.23456792E8"], [16777216, "1.6777216E7"],
  [3.4028235e38, "3.4028235E38"], [1.4e-45, "1.4E-45"],
];
for (const [value, text] of floatStrings) check(`Float.toString(${describe(value)})`, kotlinFloatToString(value), text);

const floatParses: Array<[string, number | null]> = [
  ["5.0f", 5], [" 5 ", 5], ["\t12.5D\n", 12.5], ["abc", null], ["", null], ["1e2", 100], ["0x1p3", 8],
  ["+.5", 0.5], ["5.", 5], [".", null], ["-0", -0], ["1.5e", null], ["Infinity", Infinity], ["-Infinity", -Infinity],
  ["3662.2285", f32(3662.2285)], ["7.99", f32(7.99)],
  // Exactly the midpoint between 1.0f and the next float: a tie, rounded to even (1.0f).
  ["1.000000059604644775390625", 1],
  // A hair above the midpoint: Java rounds up; a double-then-float round would not.
  ["1.0000000596046447753907", 1.0000001192092896],
  // A hair below: down.
  ["1.0000000596046447753906", 1],
];
for (const [text, expected] of floatParses) {
  const actual = toFloatOrNull(text);
  check(`toFloatOrNull(${JSON.stringify(text)})`, actual, expected);
}
check("toFloatOrNull NaN", Number.isNaN(toFloatOrNull("NaN")), true);

check("equalsIgnoreCase white", equalsIgnoreCase("White", "white"), true);
check("equalsIgnoreCase accents", equalsIgnoreCase("Whité", "WHITÉ"), true);
check("equalsIgnoreCase length", equalsIgnoreCase("White", "Whites"), false);

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

check("decodePoints drops malformed", decodePoints("0:0,10:0,bad,1:2:3,,x:1,5:5").length, 3);
const gates = decodeGates("1:2:3.5,4:5:4:WALL,6:7:5:LINE_TO_WALL:OUT,8:9,junk,10:11:x,12:13:6:SIDEWAYS:UPSIDE");
check("decodeGates count", gates.length, 4);
check("decodeGates 3-part", [gates[0].widthFt, gates[0].mounting, gates[0].swing], [3.5, "LINE", "IN"]);
check("decodeGates 4-part", [gates[1].widthFt, gates[1].mounting, gates[1].swing], [4, "WALL", "IN"]);
check("decodeGates 5-part", [gates[2].widthFt, gates[2].mounting, gates[2].swing], [5, "LINE_TO_WALL", "OUT"]);
check("decodeGates unknown names fall back", [gates[3].mounting, gates[3].swing], ["LINE", "IN"]);

// A 1000 px leg, then a bend: atan(266/1000) = 14.9 degrees is a line post, atan(270/1000) = 15.1 is a corner.
const bendLine = analyze([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 2000, y: 266 }], 20, false);
check("14.9 degree bend is LINE", [bendLine.cornerCount, bendLine.endCount, bendLine.lineVertexCount], [0, 2, 1]);
const bendCorner = analyze([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 2000, y: 270 }], 20, false);
check("15.1 degree bend is CORNER", [bendCorner.cornerCount, bendCorner.endCount, bendCorner.lineVertexCount], [1, 2, 0]);
const square = analyze([{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }], 20, true);
check("closed square: 4 corners, 80 ft", [square.cornerCount, square.endCount, square.totalLinearFeet], [4, 0, 80]);
check("uncalibrated is nothing", analyze([{ x: 0, y: 0 }, { x: 400, y: 0 }], 0, false).totalLinearFeet, 0);

// ---------------------------------------------------------------------------
// Whole-job cases
// ---------------------------------------------------------------------------

function item(sync_id: string, role: string, fence_type: string, unit_price: number, extra: Partial<MaterialItemRow> = {}): MaterialItemRow {
  return {
    sync_id, name: sync_id, category: "MISC", role, fence_type, color_or_finish: "", unit: "EA",
    unit_price, taxable: true, covers_ft: null, is_active: true, manufacturer_sync_id: null, ...extra,
  };
}

const CATALOG: MaterialItemRow[] = [
  item("Panel 6 White", "PANEL", "VINYL", 52.35, { color_or_finish: "White", taxable: false, covers_ft: 6, category: "PANEL" }),
  item("Panel 8 White", "PANEL", "VINYL", 71.40, { color_or_finish: "White", covers_ft: 8, category: "PANEL" }),
  item("Panel 6 Tan", "PANEL", "VINYL", 60.00, { color_or_finish: "Tan", covers_ft: 6, category: "PANEL" }),
  item("Line Post White", "LINE_POST", "VINYL", 16.56, { color_or_finish: "White" }),
  item("Line Post White placeholder", "LINE_POST", "VINYL", 0, { color_or_finish: "White" }),
  item("End Post White", "END_POST", "VINYL", 16.56, { color_or_finish: "White" }),
  item("Corner Post White", "CORNER_POST", "VINYL", 16.56, { color_or_finish: "White" }),
  item("Blank Post White", "BLANK_POST", "VINYL", 16.56, { color_or_finish: "White" }),
  item("Post Cap White", "POST_CAP", "VINYL", 0.74, { color_or_finish: "White" }),
  item("Gate 5 White", "GATE_PANEL", "VINYL", 145.05, { color_or_finish: "White", taxable: false, covers_ft: 5 }),
  item("Gate 10 White", "GATE_PANEL", "VINYL", 290.00, { color_or_finish: "White", covers_ft: 10 }),
  item("Hinge Set", "HINGE_SET", "VINYL", 32.25, { unit: "BOX" }),
  item("Latch", "LATCH", "VINYL", 25.87, { unit: "BOX" }),
  item("Handle", "HANDLE", "VINYL", 5.00),
  item("Brace", "BRACE", "VINYL", 6.50),
  item("Stiffener", "STIFFENER", "VINYL", 52.75),
  item("Trim", "TRIM", "VINYL", 2.00),
  item("Concrete 60lb", "CONCRETE_BAG", "UNIVERSAL", 4.75, { unit: "BAG", category: "CONCRETE" }),
  item("Hole Plug", "HOLE_PLUG", "UNIVERSAL", 0.15),
  item("Picket", "WOOD_PICKET", "WOOD", 3.25),
  item("Rail 2x4x8", "WOOD_RAIL", "WOOD", 6.50),
  item("Wood Line Post", "LINE_POST", "WOOD", 9.50),
  item("Wood End Post", "END_POST", "WOOD", 9.50),
  item("Wood Corner Post", "CORNER_POST", "WOOD", 9.50),
  item("Wood Cap", "POST_CAP", "WOOD", 2.25),
  item("Wood Gate Kit 4", "GATE_FRAME_KIT", "WOOD", 65.00, { covers_ft: 4 }),
  item("Wood Hinge", "HINGE_SET", "WOOD", 14.00),
  item("Wood Latch", "LATCH", "WOOD", 9.00),
];

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    calibration_pixels_per_foot: null,
    tax_rate_percent: 7, markup_percent: 0, discount_percent: 0,
    labor_rate_per_ft: 8, labor_flat_fee: 0, minimum_job_charge: 0,
    waste_percent: 0, gate_rate_per_ft: 20, trash_haul_fee: 0,
    teardown_enabled: false, teardown_flat_fee: 0, teardown_rate_per_ft: 0, teardown_feet: 0,
    preferred_manufacturer_sync_id: null,
    ...overrides,
  };
}

function run(sync_id: string, overrides: Partial<FenceRunRow> = {}): FenceRunRow {
  return {
    sync_id, label: sync_id, fence_type: "VINYL", color_or_finish: "",
    points_encoded: "", gates_encoded: "", closed_loop: false,
    manual_linear_feet: null, manual_corner_count: 0,
    panel_width_ft: 6, panel_height_ft: 6, post_spacing_ft: 6, concrete_bags_per_post: 1,
    aluminum_style: "RACKABLE", wood_style: "PRIVACY", wood_rail_count: 3, picket_width_in: 5.5, picket_gap_in: 0,
    fabric_height_ft: 4, include_top_rail: true, include_tension_wire: false, include_barbed_wire_arms: false,
    include_privacy_slats: false, split_rail_count: 2, suppressed_roles: "", is_teardown: false, sort_order: 0,
    ...overrides,
  };
}

function input(jobRow: JobRow, runs: FenceRunRow[], existing: LineItemRow[] = [], changeOrders: PricingInput["change_orders"] = []): PricingInput {
  return {
    engine_version: PRICING_ENGINE_VERSION, pixels_per_foot: jobRow.calibration_pixels_per_foot ?? 20,
    job: jobRow, runs, catalog: CATALOG, manufacturers: [], change_orders: changeOrders, existing_items: existing,
  };
}

const entriesOf = (out: ReturnType<typeof priceJob>, i = 0) => out.runs[i].entries.map((e) => [e.role, e.quantity, e.prefer_covers_ft, e.covers_linear_ft]);
const itemsOf = (out: ReturnType<typeof priceJob>) => out.items.map((i) => [i.sort_order, i.role, i.quantity, i.unit_price, i.supplier_unit_price, i.auto_generated]);

// Case 1: 100 ft open vinyl run typed in, 6 ft panels on 6 ft spacing, no gates.
//   bays = ceil(100/6) = 17; open run so 18 posts: 16 line + 2 end; 17 panels;
//   18 caps; 18 bags. The $0 line-post placeholder must lose to the priced one.
{
  const out = priceJob(input(job(), [run("run-1", { manual_linear_feet: 100, color_or_finish: "White" })]));
  check("case1 linear_feet", out.linear_feet, 100);
  check("case1 feet", [out.runs[0].gross_feet, out.runs[0].gate_feet, out.runs[0].net_feet], [100, 0, 100]);
  check("case1 geometry", out.runs[0].geometry, { corner_count: 0, end_count: 2, line_vertex_count: 0, segments: [], vertices: [] });
  check("case1 posts", out.runs[0].posts, { line: 16, corner: 0, end: 2, gate: 0, terminal: 2, total: 18 });
  check("case1 entries", entriesOf(out), [
    ["PANEL", 17, 6, 100], ["LINE_POST", 16, null, null], ["CORNER_POST", 0, null, null],
    ["END_POST", 2, null, null], ["POST_CAP", 18, null, null], ["CONCRETE_BAG", 18, null, null],
  ]);
  check("case1 items", itemsOf(out), [
    [0, "PANEL", 17, 52.35, null, true], [1, "LINE_POST", 16, 16.56, null, true], [2, "END_POST", 2, 16.56, null, true],
    [3, "POST_CAP", 18, 0.74, null, true], [4, "CONCRETE_BAG", 18, 4.75, null, true],
  ]);
  check("case1 panel sync id", out.items[0].sync_id, nameUUIDFromString("fenceflow-line:run-1:PANEL"));
  check("case1 unmatched", out.unmatched_roles, []);
  check("case1 zero_priced", out.zero_priced, []);
  const materials = 17 * 52.35 + 16 * 16.56 + 2 * 16.56 + 18 * 0.74 + 18 * 4.75;
  const taxable = 16 * 16.56 + 2 * 16.56 + 18 * 0.74 + 18 * 4.75;
  check("case1 materials", out.totals.materials_subtotal, materials);
  check("case1 taxable", out.totals.taxable_subtotal, taxable);
  check("case1 tax", out.totals.tax, taxable * (7 / 100));
  check("case1 labor", out.totals.labor_cost, 800);
  check("case1 gate charge", out.totals.gate_charge, 0);
  // 1286.85 + 27.783 + 800 = 2114.633, up to the next ten.
  check("case1 grand total", out.totals.grand_total, 2120);
  check("case1 billable", out.billable_linear_feet, 100);
}

// Case 2: 120 ft closed wood loop with 4 corners, 8 ft bays, one 4 ft LINE gate,
//   10% waste, a hand-edited rail price, a supplier-quoted post price, a
//   change order, teardown along the new fence, markup then discount.
//   net = 116; bays = ceil(14.5) = 15; closed so standard = 15 - 1 gate = 14;
//   line = 14 - 4 corners = 10; gate posts 2; total 16; terminal 6.
//   pickets ceil(116*12/5.5 = 253.09) = 254 -> waste ceil(279.4) = 280;
//   rails 15*3 = 45 -> ceil(49.5) = 50; bags 14*1.1 + 2.5*1.1 = 18.15 -> 19.
{
  const existing: LineItemRow[] = [
    { sync_id: "old-rail", fence_run_sync_id: "run-2", role: "WOOD_RAIL", description: "Rail", quantity: 1, unit: "EA", unit_price: 7.00, supplier_unit_price: null, taxable: true, auto_generated: false, sort_order: 0 },
    { sync_id: "old-post", fence_run_sync_id: "run-2", role: "LINE_POST", description: "Post", quantity: 1, unit: "EA", unit_price: 9.50, supplier_unit_price: 8.00, taxable: true, auto_generated: true, sort_order: 1 },
    { sync_id: "other-run", fence_run_sync_id: "run-9", role: "WOOD_PICKET", description: "Picket", quantity: 1, unit: "EA", unit_price: 1.00, supplier_unit_price: 1.00, taxable: true, auto_generated: false, sort_order: 2 },
  ];
  const out = priceJob(input(
    job({ tax_rate_percent: 0, labor_rate_per_ft: 5, gate_rate_per_ft: 25, waste_percent: 10, markup_percent: 10, discount_percent: 5,
      teardown_enabled: true, teardown_flat_fee: 100, teardown_rate_per_ft: 2, trash_haul_fee: 50 }),
    [run("run-2", { fence_type: "WOOD", manual_linear_feet: 120, manual_corner_count: 4, closed_loop: true, post_spacing_ft: 8,
      gates_encoded: "100:100:4.0:LINE:IN" })],
    existing,
    [{ sync_id: "co-1", additional_feet: 10, additional_cost: 200, material_cost: 50 }],
  ));
  check("case2 feet", [out.runs[0].gross_feet, out.runs[0].gate_feet, out.runs[0].net_feet], [120, 4, 116]);
  check("case2 geometry", out.runs[0].geometry, { corner_count: 4, end_count: 0, line_vertex_count: 0, segments: [], vertices: [] });
  check("case2 posts", out.runs[0].posts, { line: 10, corner: 4, end: 0, gate: 2, terminal: 6, total: 16 });
  check("case2 entries", entriesOf(out), [
    ["WOOD_PICKET", 280, null, null], ["WOOD_RAIL", 50, null, null], ["LINE_POST", 10, null, null], ["CORNER_POST", 4, null, null],
    ["END_POST", 0, null, null], ["POST_CAP", 16, null, null], ["GATE_FRAME_KIT", 1, 4, null], ["HINGE_SET", 1, null, null],
    ["LATCH", 1, null, null], ["HANDLE", 1, null, null], ["BRACE", 1, null, null], ["STIFFENER", 1, null, null],
    ["END_POST", 2, null, null], ["CONCRETE_BAG", 19, null, null],
  ]);
  check("case2 items", itemsOf(out), [
    [0, "WOOD_PICKET", 280, 3.25, null, true], [1, "WOOD_RAIL", 50, 7.00, null, false], [2, "LINE_POST", 10, 9.50, 8.00, true],
    [3, "CORNER_POST", 4, 9.50, null, true], [4, "POST_CAP", 16, 2.25, null, true], [5, "GATE_FRAME_KIT", 1, 65, null, true],
    [6, "HINGE_SET", 1, 14, null, true], [7, "LATCH", 1, 9, null, true], [8, "END_POST", 2, 9.50, null, true],
    [9, "CONCRETE_BAG", 19, 4.75, null, true],
  ]);
  check("case2 unmatched", out.unmatched_roles, [
    { run_sync_id: "run-2", role: "HANDLE" }, { run_sync_id: "run-2", role: "BRACE" }, { run_sync_id: "run-2", role: "STIFFENER" },
  ]);
  // The written rows come to 1611.25. The "other-run" row names a run this
  // job does not carry, so it is job-level: a regenerate never touches it,
  // and it stays on the job and in the totals at 1 x its $1.00 supplier
  // price (replaceGeneratedForRun only clears the run's own roled rows).
  // The two rows that DO belong to run-2 were roled, so they were deleted
  // and came back as the freshly built lines above, carrying their prices.
  check("case2 materials", out.totals.materials_subtotal, 1612.25);
  check("case2 totals order", out.totals_items, [
    ...out.items.filter((i) => i.sort_order === 0).map((i) => i.sync_id), ...out.items.filter((i) => i.sort_order === 1).map((i) => i.sync_id),
    ...out.items.filter((i) => i.sort_order === 2).map((i) => i.sync_id), "other-run",
    ...out.items.filter((i) => i.sort_order > 2).map((i) => i.sync_id),
  ]);
  check("case2 change order", [out.totals.change_order_cost, out.totals.change_order_feet], [200, 10]);
  check("case2 billable", out.billable_linear_feet, 130);
  check("case2 gate", [out.totals.gate_feet, out.totals.gate_charge], [4, 100]);
  check("case2 labor", out.totals.labor_cost, 630);
  check("case2 teardown", [out.totals.teardown_cost, out.totals.trash_haul_fee], [410, 50]);
  check("case2 pre-markup", out.totals.pre_markup_total, 2952.25);
  // 2952.25 * 1.10 = 3247.475, less 5% = 3085.10125, up to the next ten.
  check("case2 grand total", out.totals.grand_total, 3090);
}

// Case 3: a drawn L at 20 px/ft (two 1000 px legs = 100 ft, one 90 degree corner)
//   with an 8 ft LINE_TO_WALL gate and a 12 ft WALL gate, lowercase colour.
//   net = 80; bays = ceil(13.33) = 14; open so standard = 14 + 1 - 2 = 13;
//   line = 13 - 1 - 2 = 10; gate posts 4; total 17; 14 panels; 13 fence bags
//   + 3.5 + 1 = 17.5 -> 18. Both gates are wide, so two braces and two hinge
//   sets each; the two widths keep two GATE_PANEL lines with width-qualified ids.
{
  const out = priceJob(input(
    job({ calibration_pixels_per_foot: 20, labor_rate_per_ft: 10 }),
    [run("run-3", { points_encoded: "0:0,1000:0,1000:1000", gates_encoded: "500:0:8.0:LINE_TO_WALL:IN,1000:500:12:WALL", color_or_finish: "white" })],
  ));
  check("case3 linear_feet", out.linear_feet, 100);
  check("case3 feet", [out.runs[0].gross_feet, out.runs[0].gate_feet, out.runs[0].net_feet], [100, 20, 80]);
  check("case3 geometry", out.runs[0].geometry, {
    corner_count: 1, end_count: 2, line_vertex_count: 0,
    segments: [{ from_index: 0, to_index: 1, length_ft: 50 }, { from_index: 1, to_index: 2, length_ft: 50 }],
    vertices: [{ index: 0, kind: "END", turn_degrees: 0 }, { index: 1, kind: "CORNER", turn_degrees: 90 }, { index: 2, kind: "END", turn_degrees: 0 }],
  });
  check("case3 posts", out.runs[0].posts, { line: 10, corner: 1, end: 2, gate: 4, terminal: 7, total: 17 });
  check("case3 entry count", out.runs[0].entries.length, 28);
  check("case3 last entry is the one concrete line", entriesOf(out)[27], ["CONCRETE_BAG", 18, null, null]);
  check("case3 items", itemsOf(out), [
    [0, "PANEL", 14, 52.35, null, true], [1, "LINE_POST", 10, 16.56, null, true], [2, "CORNER_POST", 1, 16.56, null, true],
    [3, "END_POST", 6, 16.56, null, true], [4, "POST_CAP", 17, 0.74, null, true], [5, "GATE_PANEL", 1, 290, null, true],
    [6, "HINGE_SET", 4, 32.25, null, true], [7, "LATCH", 2, 25.87, null, true], [8, "HANDLE", 2, 5, null, true],
    [9, "BRACE", 4, 6.5, null, true], [10, "TRIM", 8, 2, null, true], [11, "STIFFENER", 2, 52.75, null, true],
    [12, "GATE_PANEL", 1, 290, null, true], [13, "BLANK_POST", 1, 16.56, null, true], [14, "HOLE_PLUG", 4, 0.15, null, true],
    [15, "CONCRETE_BAG", 18, 4.75, null, true],
  ]);
  check("case3 colour narrowing picked White", out.items[0].description, "Panel 6 White");
  check("case3 nearest gate width", [out.items[5].description, out.items[12].description], ["Gate 10 White", "Gate 10 White"]);
  check("case3 gate ids qualified by width", [out.items[5].sync_id, out.items[12].sync_id], [
    nameUUIDFromString("fenceflow-line:run-3:GATE_PANEL:8.0"), nameUUIDFromString("fenceflow-line:run-3:GATE_PANEL:12.0"),
  ]);
  check("case3 single-role ids unqualified", out.items[1].sync_id, nameUUIDFromString("fenceflow-line:run-3:LINE_POST"));
  const materials = 14 * 52.35 + 10 * 16.56 + 1 * 16.56 + 6 * 16.56 + 17 * 0.74 + 290 + 4 * 32.25 + 2 * 25.87 + 2 * 5
    + 4 * 6.5 + 8 * 2 + 2 * 52.75 + 290 + 16.56 + 4 * 0.15 + 18 * 4.75;
  check("case3 materials", out.totals.materials_subtotal, materials);
  check("case3 gate", [out.totals.gate_feet, out.totals.gate_charge], [20, 400]);
  check("case3 labor on 80 ft", out.totals.labor_cost, 800);
  // 2047.90 + 92.05 tax + 800 + 400 = 3339.95, up to the next ten.
  check("case3 grand total", out.totals.grand_total, 3340);
}

// Case 3b: the same drawing with the calibration missing. The takeoff still
//   runs at the 20 px/ft grid fallback the ViewModel supplies, but the job's
//   own footage reads as nothing -- the phone's "uncalibrated counts as 0".
{
  const out = priceJob(input(
    job({ labor_rate_per_ft: 10 }),
    [run("run-3", { points_encoded: "0:0,1000:0,1000:1000" })],
  ));
  check("case3b takeoff still measures", out.runs[0].net_feet, 100);
  check("case3b job footage is nothing", [out.linear_feet, out.billable_linear_feet, out.totals.labor_cost], [0, 0, 0]);
}

// Case 4: a suppressed role stays gone, and PANEL is re-derived when the
//   catalog only stocks the colour at a different width (Tan is 6 ft only;
//   the run asks for 8 ft panels over 100 ft: 13 at 8 ft, but 17 at 6 ft).
{
  const out = priceJob(input(
    job(),
    [run("run-4", { manual_linear_feet: 100, color_or_finish: "Tan", panel_width_ft: 8, post_spacing_ft: 8, suppressed_roles: "POST_CAP, BOGUS,CONCRETE_BAG" })],
  ));
  const roles = out.items.map((i) => i.role);
  check("case4 suppressed roles absent", [roles.includes("POST_CAP"), roles.includes("CONCRETE_BAG")], [false, false]);
  check("case4 takeoff asked for 13 x 8 ft", entriesOf(out)[0], ["PANEL", 13, 8, 100]);
  check("case4 priced 17 x 6 ft Tan", [out.items[0].description, out.items[0].quantity], ["Panel 6 Tan", 17]);
}

console.log(`smoke: ${checks - failures} of ${checks} checks passed (engine ${PRICING_ENGINE_VERSION})`);
process.exit(failures === 0 ? 0 : 1);
