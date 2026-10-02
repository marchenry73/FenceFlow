// a71-pull-sheet -- the page the person at the supply counter works from.
//
//   node --test tests/a71-pull-sheet.test.mjs        (no network, no writes, no Gradle)
//
// WHAT THIS IS FOR, in the owner's words: "when picking up materials, I want to have the
// whole process too for the person picking up. I want them to have a whole page to check if
// we have everything according to the job. It would show the grid and the drawing and how
// many post there needs and what type of post."
//
// WHAT IT PINS
//   1. THE POST BREAKDOWN IS THE ENGINE'S, NOT A RECOUNT. Line, corner, end and gate posts
//      on the sheet equal the real engine port's own posts for the run. Asserted against
//      priceJob (supabase/functions/_shared/pricing), the same code the office prices with,
//      never against literals I chose.
//   2. THE JOINED CORNER. Two runs whose ends meet share ONE post. The sheet must report the
//      engine's answer, which is one post FEWER than a per-run sum. Block 2 proves the
//      difference is real by pricing the same two runs unjoined, and the canary in block 7
//      proves a naive per-run implementation fails this assertion.
//   3. A TEARDOWN RUN CONTRIBUTES NOTHING. You do not buy material for a fence you are
//      taking out. Planted lines on a teardown run with the identical lines on a build run
//      as the positive control.
//   4. NO TAKEOFF IS AN EXPLICIT STATE, NOT AN EMPTY LIST. An empty pull sheet that reads as
//      a short shopping list is the worst thing this page could do at a counter.
//   5. NO MONEY ANYWHERE IN THE MODEL. The whole returned object graph is walked by key
//      name. The walker's teeth are proven on the engine's own line item, which DOES carry
//      unit_price -- and the Kotlin source is read as well, so a future field added there
//      and not here still fails.
//   6. TICKS SURVIVE A ROUND TRIP, and drop when the quantity moves. A tick inherited by a
//      different number is worse at a counter than a tick that has to be made again.
//
// EVERY NEGATIVE HAS A POSITIVE CONTROL, and block 7 runs a deliberately wrong
// implementation through blocks 1, 2 and 4 and requires every one of them to fail.
//
// THE KOTLIN IS NOT RUN HERE. Block 8 reads PullSheetLogic.kt and fails if the deciding
// tables in it have drifted from the transcription below -- which is the only thing that can
// make this file pass while the app misbehaves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPricingInput } from "../supabase/functions/_shared/pricing/load.ts";
import { PRICING_ENGINE_VERSION, priceJob } from "../supabase/functions/_shared/pricing/index.ts";

const KOTLIN_LOGIC = "app/src/main/java/com/fenceestimator/app/ui/crew/PullSheetLogic.kt";
const KOTLIN_ENTITIES = "app/src/main/java/com/fenceestimator/app/data/Entities.kt";

// ==================================================================================
// THE TRANSCRIPTION. A faithful mirror of PullSheetLogic.kt's buildPullSheet.
// Kept deliberately dumb and literal so a reader can diff it against the Kotlin.
// ==================================================================================

const SECTION_OF_ROLE = {
  LINE_POST: "POSTS", END_POST: "POSTS", CORNER_POST: "POSTS", GATE_POST: "POSTS", BLANK_POST: "POSTS",
  PANEL: "PANELS", GATE_PANEL: "PANELS", WOOD_PICKET: "PANELS", WOOD_RAIL: "PANELS",
  CHAIN_FABRIC: "PANELS", TOP_RAIL: "PANELS", PRIVACY_SLAT: "PANELS", GATE_FRAME_KIT: "PANELS",
  POST_CAP: "CAPS_AND_TRIM", TRIM: "CAPS_AND_TRIM",
  CONCRETE_BAG: "CONCRETE",
  HINGE_SET: "GATE_HARDWARE", LATCH: "GATE_HARDWARE", HANDLE: "GATE_HARDWARE",
  BRACE: "GATE_HARDWARE", STIFFENER: "GATE_HARDWARE", HOLE_PLUG: "GATE_HARDWARE",
  TENSION_WIRE: "OTHER", TENSION_BAND: "OTHER", BRACE_BAND: "OTHER", RAIL_END: "OTHER",
  BARBED_WIRE_ARM: "OTHER", NONE: "OTHER",
};
const SECTION_ORDER = ["POSTS", "PANELS", "CAPS_AND_TRIM", "CONCRETE", "GATE_HARDWARE", "OTHER"];
const POST_ROLES = ["LINE_POST", "END_POST", "CORNER_POST", "GATE_POST", "BLANK_POST"];
const IMPORTED_CHECK_FILING = "Imported — check this one";

// Fixed two decimals, matching PullSheetLogic.kt's String.format(Locale.ROOT, "%.2f").
// A bare toString disagrees across the two languages (Kotlin "22.0" vs JS "22"), and a
// locale-sensitive format writes "6,00" on a French phone and loses every tick.
const heightToken = (h) => (h === null || h === undefined ? "-" : h.toFixed(2));
const quantityToken = (q) => q.toFixed(2);
const tickKey = (k, quantity) => [
  k.section, k.role, k.product, k.unit, heightToken(k.fenceHeightFt),
  k.handAdded ? "hand" : "auto", quantityToken(quantity),
].join("|");

const matchCatalog = (catalog, product, role) =>
  catalog.find((c) => c.name === product && c.role === role) ?? null;

function doubtsFor(key, row) {
  if (key.handAdded) return [];
  if (row === null) return ["NOT_IN_CATALOG"];
  const out = [];
  if (String(row.sourceDoc ?? "").startsWith(IMPORTED_CHECK_FILING)) out.push("FILING_UNCHECKED");
  const ch = row.heightFt ?? null;
  const rh = key.fenceHeightFt ?? null;
  if (ch !== null && rh !== null && ch !== rh) out.push("WRONG_HEIGHT");
  return out;
}

function buildPullSheet(runs, lines, catalog) {
  const real = runs.filter((r) => r.hasWork);
  if (real.length === 0) return { kind: "NoRuns" };

  const toBuild = real.filter((r) => !r.isTeardown);
  if (toBuild.length === 0) return { kind: "OnlyTeardown" };

  const buildableIds = new Set(toBuild.filter((r) => r.measurable).map((r) => r.id));
  const runById = new Map(toBuild.map((r) => [r.id, r]));

  const usable = lines.filter((l) =>
    l.quantity > 0 && (l.runId === null || l.runId === undefined || buildableIds.has(l.runId)));

  const runsWithTakeoff = new Set(usable.map((l) => l.runId).filter((id) => id !== null && id !== undefined));
  const missing = toBuild.filter((r) => r.measurable && !runsWithTakeoff.has(r.id)).map((r) => r.label);
  const unmeasurable = toBuild.filter((r) => !r.measurable).map((r) => r.label);

  if (usable.length === 0) {
    if (unmeasurable.length > 0 && missing.length === 0) {
      return { kind: "NotMeasurable", runLabels: unmeasurable };
    }
    return { kind: "NoTakeoff", runLabels: toBuild.map((r) => r.label) };
  }

  const groupsByKey = new Map();
  for (const line of usable) {
    const run = (line.runId === null || line.runId === undefined) ? null : runById.get(line.runId) ?? null;
    const key = {
      section: SECTION_OF_ROLE[line.role] ?? "OTHER",
      role: line.role,
      product: line.product,
      unit: line.unit,
      fenceHeightFt: run === null ? null : run.fenceHeightFt,
      handAdded: !line.isAutoGenerated,
    };
    const id = JSON.stringify([key.section, key.role, key.product, key.unit, key.fenceHeightFt, key.handAdded]);
    if (!groupsByKey.has(id)) groupsByKey.set(id, { key, members: [] });
    groupsByKey.get(id).members.push(line);
  }

  const built = [...groupsByKey.values()].map(({ key, members }) => {
    const quantity = members.reduce((s, m) => s + m.quantity, 0);
    const runLabels = [...new Set(members
      .filter((m) => m.runId !== null && m.runId !== undefined)
      .map((m) => runById.get(m.runId)?.label)
      .filter((l) => l !== undefined))].sort();
    const row = matchCatalog(catalog, key.product, key.role);
    return {
      key: tickKey(key, quantity),
      section: key.section,
      role: key.role,
      product: key.product,
      quantity,
      unit: key.unit,
      runLabels,
      fenceHeightFt: key.fenceHeightFt,
      catalogHeightFt: row === null ? null : row.heightFt ?? null,
      doubts: doubtsFor(key, row),
      heightNotDeclared: row !== null && (row.heightFt === null || row.heightFt === undefined),
      handAdded: key.handAdded,
    };
  });

  const groups = [];
  for (const section of SECTION_ORDER) {
    const inSection = built.filter((l) => l.section === section).sort((a, b) =>
      (b.doubts.length > 0) - (a.doubts.length > 0) ||
      a.role.localeCompare(b.role) ||
      (a.fenceHeightFt ?? Infinity) - (b.fenceHeightFt ?? Infinity) ||
      a.product.localeCompare(b.product));
    if (inSection.length > 0) groups.push({ section, lines: inSection });
  }

  return {
    kind: "Ready",
    groups,
    runsWithoutTakeoff: missing,
    runsNotMeasurable: unmeasurable,
    totalPosts: built.filter((l) => POST_ROLES.includes(l.role)).reduce((s, l) => s + l.quantity, 0),
    hadTeardownRuns: real.some((r) => r.isTeardown),
  };
}

// ==================================================================================
// A DELIBERATELY WRONG IMPLEMENTATION, for the canary in block 7.
// Three mistakes, each one a real temptation:
//   a) it recounts posts per run from the geometry instead of reading the takeoff,
//      so a shared corner post is counted twice;
//   b) it merges post lines by role alone, so a 4 ft run's posts collapse into a 6 ft
//      run's and the distinction the page exists to make disappears;
//   c) it answers "no takeoff" with an empty sheet.
// ==================================================================================
function buildPullSheetWRONG(runs, lines, catalog, naivePostsByRun) {
  const toBuild = runs.filter((r) => r.hasWork && !r.isTeardown);
  const usable = lines.filter((l) => l.quantity > 0);
  if (usable.length === 0) return { kind: "Ready", groups: [], runsWithoutTakeoff: [], runsNotMeasurable: [], totalPosts: 0, hadTeardownRuns: false };

  const byRole = new Map();
  for (const line of usable) {
    const section = SECTION_OF_ROLE[line.role] ?? "OTHER";
    // (b) role alone -- no height in the key.
    const id = section + "|" + line.role + "|" + line.product;
    if (!byRole.has(id)) byRole.set(id, { section, role: line.role, product: line.product, unit: line.unit, quantity: 0, runLabels: [], fenceHeightFt: null, catalogHeightFt: null, doubts: [], heightNotDeclared: false, handAdded: false, key: id });
    byRole.get(id).quantity += line.quantity;
  }
  // (a) overwrite the post counts with a per-run recount that ignores joints.
  if (naivePostsByRun) {
    for (const entry of byRole.values()) {
      if (!POST_ROLES.includes(entry.role)) continue;
      entry.quantity = toBuild.reduce((s, r) => s + (naivePostsByRun.get(r.id)?.[entry.role] ?? 0), 0);
    }
  }
  const built = [...byRole.values()];
  const groups = [];
  for (const section of SECTION_ORDER) {
    const inSection = built.filter((l) => l.section === section);
    if (inSection.length > 0) groups.push({ section, lines: inSection });
  }
  return {
    kind: "Ready", groups, runsWithoutTakeoff: [], runsNotMeasurable: [],
    totalPosts: built.filter((l) => POST_ROLES.includes(l.role)).reduce((s, l) => s + l.quantity, 0),
    hadTeardownRuns: false,
  };
}

// ==================================================================================
// THE TICK STORE, transcribed from PullSheetTickStore.kt.
// ==================================================================================
function makeTickStore() {
  const ticks = new Map();   // jobId -> Set of line keys
  const notes = new Map();   // jobId + hash -> note
  return {
    tickedKeys: (jobId) => new Set(ticks.get(jobId) ?? []),
    setTicked(jobId, lineKey, isTicked) {
      const set = new Set(ticks.get(jobId) ?? []);
      if (isTicked) set.add(lineKey); else set.delete(lineKey);
      ticks.set(jobId, set);
    },
    clearTicks(jobId) { ticks.delete(jobId); },
    substitution: (jobId, lineKey) => notes.get(jobId + "|" + lineKey) ?? "",
    setSubstitution(jobId, lineKey, note) {
      const trimmed = String(note).trim().slice(0, 200);
      if (trimmed === "") notes.delete(jobId + "|" + lineKey);
      else notes.set(jobId + "|" + lineKey, trimmed);
    },
  };
}

// ==================================================================================
// THE REAL ENGINE. Rows shaped the way price-job reads them, same harness as
// tests/a53-gate-post-role.test.mjs.
// ==================================================================================
const JOB_SYNC = "a7100000-0000-4000-8000-000000000001";
// A joint id must be a UUID: joins.ts readJointId rejects anything else and reads it as a
// FREE end, which is the dearer answer. "J1" silently did nothing here until the positive
// control in block 2 caught it.
const JOINT = "a7100000-0000-4000-8000-0000000000aa";
const jobRow = (o = {}) => ({
  sync_id: JOB_SYNC, updated_at: "2026-10-02T12:00:00Z", calibration_pixels_per_foot: null,
  tax_rate_percent: 7, markup_percent: 0, discount_percent: 0, labor_rate_per_ft: 8, labor_flat_fee: 0,
  minimum_job_charge: 200, minimum_labor_charge: 0, waste_percent: 0, gate_rate_per_ft: 20, trash_haul_fee: 0,
  teardown_enabled: false, teardown_flat_fee: 0, teardown_rate_per_ft: 0, teardown_feet: 0,
  preferred_manufacturer_sync_id: null, survey_storage_path: null, ...o,
});
const runRow = (o = {}) => ({
  sync_id: "a7100000-0000-4000-8000-000000000010", label: "Back", fence_type: "VINYL",
  color_or_finish: "White", points_encoded: "", gates_encoded: "", closed_loop: false,
  manual_linear_feet: null, manual_corner_count: 0, panel_width_ft: 6, panel_height_ft: 6,
  post_spacing_ft: 6, concrete_bags_per_post: 1, aluminum_style: "RACKABLE", wood_style: "PRIVACY",
  wood_rail_count: 3, picket_width_in: 5.5, picket_gap_in: 0, fabric_height_ft: 4,
  include_top_rail: true, include_tension_wire: false, include_barbed_wire_arms: false,
  include_privacy_slats: false, split_rail_count: 2, is_teardown: false, sort_order: 0,
  suppressed_roles: "", start_joint: "", end_joint: "", ...o,
});
const dbRows = (rows) => rows.map((r, i) => ({
  sync_id: "a7100000-0000-4000-8000-" + String(100 + i).padStart(12, "0"),
  name: r.name, category: r.category ?? "MISC", role: r.role, fence_type: r.fence_type ?? "VINYL",
  color_or_finish: r.color_or_finish ?? "White", unit: r.unit ?? "EA", unit_price: r.unit_price,
  taxable: true, covers_ft: r.covers_ft ?? null, height_ft: r.height_ft ?? null,
  manufacturer_sync_id: null, is_active: true,
}));

// A complete vinyl catalog at two heights, so a 4 ft run and a 6 ft run can each be
// priced to a post that really suits them. The post prices and heights are the owner's
// own shape (read-only SELECT, 1 Oct 2026): every post row declares a height_ft.
const CATALOG = [
  { name: "Vinyl Privacy Panel 6'H x 6'W, White", category: "PANEL", role: "PANEL", unit_price: 120, covers_ft: 6, height_ft: 6 },
  { name: "Vinyl Privacy Panel 4'H x 6'W, White", category: "PANEL", role: "PANEL", unit_price: 95, covers_ft: 6, height_ft: 4 },
  { name: "Vinyl Privacy Gate 4'W, White", category: "GATE", role: "GATE_PANEL", unit_price: 290, covers_ft: 4, height_ft: 6 },
  { name: '5"x5" Co-Ex Line Post White 8.5 ft (6 ft fence)', category: "POST", role: "LINE_POST", unit_price: 16.56, height_ft: 6 },
  { name: '5"x5" Utility Post White 6 ft (4 ft fence)', category: "POST", role: "LINE_POST", unit_price: 13.18, height_ft: 4 },
  { name: '5"x5" Co-Ex Corner Post White 8.5 ft (6 ft fence)', category: "POST", role: "CORNER_POST", unit_price: 17.1, height_ft: 6 },
  { name: '5"x5" Corner Post White 6 ft (4 ft fence)', category: "POST", role: "CORNER_POST", unit_price: 14, height_ft: 4 },
  { name: '5"x5" Co-Ex End Post White 8.5 ft (6 ft fence)', category: "POST", role: "END_POST", unit_price: 16.56, height_ft: 6 },
  { name: '5"x5" End Post White 6 ft (4 ft fence)', category: "POST", role: "END_POST", unit_price: 13.5, height_ft: 4 },
  { name: '5"x5" Co-Ex Gate Post White 8.5 ft (6 ft fence)', category: "POST", role: "GATE_POST", unit_price: 16.56, height_ft: 6 },
  { name: '5"x5" Post Cap, White', category: "POST", role: "POST_CAP", unit_price: 3.5 },
  { name: "Concrete Mix 60 lb", category: "CONCRETE", role: "CONCRETE_BAG", fence_type: "UNIVERSAL", unit_price: 6.25 },
  { name: "Gate Hinge Set, White", category: "HARDWARE", role: "HINGE_SET", unit_price: 24 },
  { name: "Gate Latch, White", category: "HARDWARE", role: "LATCH", unit_price: 18 },
  { name: "Gate Handle, White", category: "HARDWARE", role: "HANDLE", unit_price: 12 },
  { name: "Gate Brace Kit", category: "HARDWARE", role: "BRACE", fence_type: "UNIVERSAL", unit_price: 9 },
  { name: "Econo Gate Stiffener", category: "HARDWARE", role: "STIFFENER", fence_type: "UNIVERSAL", unit_price: 15 },
  { name: '5/8" Hole Plug, White', category: "HARDWARE", role: "HOLE_PLUG", unit_price: 0.15 },
];

const price = (runs, catalog = CATALOG, job = {}) => priceJob(buildPricingInput({
  job: jobRow(job), runs, catalog: dbRows(catalog), manufacturers: [], changeOrders: [],
  existingItems: [], engineVersion: PRICING_ENGINE_VERSION,
}));

/** The catalog, in the shape the pull sheet reads it: a name, a role, a height, a label. */
const pullSheetCatalog = (rows = CATALOG) => rows.map((r) => ({
  name: r.name, role: r.role, heightFt: r.height_ft ?? null, sourceDoc: r.source_doc ?? "Confirmed",
}));

/**
 * Engine output turned into the sheet's inputs.
 *
 * THIS IS THE JOIN THE WHOLE FILE TURNS ON. Line items are taken from the engine's
 * `items`, which is what the phone stores in `estimate_line_items` -- so the post counts
 * on the sheet are the engine's, already adjusted for shared posts at a joint, and NOT a
 * recount. Prices are not copied, because PullSheetSourceLine has no field for one.
 */
function fromEngine(out, runRows, overrides = {}) {
  const idOf = new Map(runRows.map((r, i) => [r.sync_id, i + 1]));
  const runs = runRows.map((r) => ({
    id: idOf.get(r.sync_id),
    label: r.label,
    isTeardown: r.is_teardown,
    fenceHeightFt: r.panel_height_ft,
    hasWork: true,
    measurable: true,
    ...(overrides[r.sync_id] ?? {}),
  }));
  const lines = out.items.map((item) => ({
    runId: idOf.get(item.fence_run_sync_id) ?? null,
    role: item.role,
    product: item.description,
    quantity: item.quantity,
    unit: item.unit,
    isAutoGenerated: item.auto_generated,
  }));
  return { runs, lines };
}

const lineFor = (sheet, role, product = null) => sheet.groups
  .flatMap((g) => g.lines)
  .filter((l) => l.role === role && (product === null || l.product === product));
const qtyFor = (sheet, role) => lineFor(sheet, role).reduce((s, l) => s + l.quantity, 0);

// ==================================================================================
// harness check: the engine prices this catalog cleanly, or no number below means anything
// ==================================================================================
test("harness: the real engine prices the test catalog with nothing unmatched", () => {
  const run = runRow({ points_encoded: "0:0,0:1200,1200:1200" });
  const out = price([run]);
  assert.equal(out.engine_version, PRICING_ENGINE_VERSION);
  assert.deepEqual(out.unmatched_roles.map((u) => u.role).sort(), [],
    "something is unmatched -- fix CATALOG before reading any count in this file");
  assert.ok(out.items.length >= 6, "the engine produced almost no lines: " + out.items.length);
  assert.ok(out.runs[0].posts.total > 0, "POSITIVE CONTROL FAILED: the engine counted no posts");
});

// ============================== 1. THE POST BREAKDOWN IS THE ENGINE'S ==============

test("POSTS BY TYPE: every post role on the sheet equals the engine's own count for the run", () => {
  // An L: 60 ft up, 60 ft across, one corner, two open ends.
  const run = runRow({ points_encoded: "0:0,0:1200,1200:1200" });
  const out = price([run]);
  const posts = out.runs[0].posts;

  // POSITIVE CONTROL: the engine must have counted a line post, a corner and two ends, or
  // the assertions below are all comparisons of zero against zero.
  assert.ok(posts.line > 0, "POSITIVE CONTROL FAILED: engine counted no line posts");
  assert.equal(posts.corner, 1, "POSITIVE CONTROL FAILED: an L has one corner");
  assert.equal(posts.end, 2, "POSITIVE CONTROL FAILED: an open run has two ends");

  const { runs, lines } = fromEngine(out, [run]);
  const sheet = buildPullSheet(runs, lines, pullSheetCatalog());
  assert.equal(sheet.kind, "Ready");

  assert.equal(qtyFor(sheet, "LINE_POST"), posts.line, "line posts disagree with the engine");
  assert.equal(qtyFor(sheet, "CORNER_POST"), posts.corner, "corner posts disagree with the engine");
  assert.equal(qtyFor(sheet, "END_POST"), posts.end, "end posts disagree with the engine");
  assert.equal(sheet.totalPosts, posts.total, "the sheet's post total is not the engine's");

  // Each post line says which fence height it is for, and the product it names is the
  // product the engine chose at that height. This is the distinction that cost real money.
  for (const line of sheet.groups.find((g) => g.section === "POSTS").lines) {
    assert.equal(line.fenceHeightFt, 6, line.role + ": lost the fence height");
    assert.equal(line.catalogHeightFt, 6, line.role + ": wrong height product chosen");
    assert.deepEqual(line.doubts, [], line.role + ": a correct line was doubted");
  }
});

test("POSTS BY TYPE: two heights on one job stay two lines, never one", () => {
  const tall = runRow({ sync_id: "a7100000-0000-4000-8000-000000000010", label: "Back", points_encoded: "0:0,2400:0", panel_height_ft: 6 });
  const short = runRow({ sync_id: "a7100000-0000-4000-8000-000000000011", label: "Side", points_encoded: "0:400,2400:400", panel_height_ft: 4, sort_order: 1 });
  const out = price([tall, short]);
  const { runs, lines } = fromEngine(out, [tall, short]);
  const sheet = buildPullSheet(runs, lines, pullSheetCatalog());

  const linePosts = lineFor(sheet, "LINE_POST");
  assert.equal(linePosts.length, 2, "a 6 ft run and a 4 ft run collapsed into one post line");
  assert.deepEqual(linePosts.map((l) => l.fenceHeightFt).sort(), [4, 6]);
  // POSITIVE CONTROL that the split is real and not two lines of the same thing.
  assert.notEqual(linePosts[0].product, linePosts[1].product,
    "POSITIVE CONTROL FAILED: both heights chose the same product, so this job cannot test the split");
  for (const l of linePosts) assert.equal(l.catalogHeightFt, l.fenceHeightFt);
  // And the sum still matches the engine, run for run.
  assert.equal(qtyFor(sheet, "LINE_POST"), out.runs[0].posts.line + out.runs[1].posts.line);
});

test("ASK, DO NOT GUESS: a post sold for the wrong fence height is flagged, and the count is not touched", () => {
  // The owner's live case, reproduced: a 6 ft run whose only LINE_POST row is the 4 ft one.
  const catalog = CATALOG.filter((r) => !(r.role === "LINE_POST" && r.height_ft === 6));
  const run = runRow({ points_encoded: "0:0,2400:0" });
  const out = price([run], catalog);
  const { runs, lines } = fromEngine(out, [run]);
  const sheet = buildPullSheet(runs, lines, pullSheetCatalog(catalog));

  const post = lineFor(sheet, "LINE_POST")[0];
  assert.ok(post, "no line post at all -- this case cannot be tested");
  assert.deepEqual(post.doubts, ["WRONG_HEIGHT"], "a 4 ft post on a 6 ft run was not flagged");
  assert.equal(post.catalogHeightFt, 4);
  assert.equal(post.fenceHeightFt, 6);
  // THE COUNT IS UNTOUCHED. A doubt says the PRODUCT may be wrong, never the quantity.
  assert.equal(post.quantity, out.runs[0].posts.line,
    "flagging a line changed its quantity, which is exactly what it must not do");

  // POSITIVE CONTROL: with the 6 ft row present, the same job is not flagged.
  const clean = price([run], CATALOG);
  const c = fromEngine(clean, [run]);
  const cleanSheet = buildPullSheet(c.runs, c.lines, pullSheetCatalog());
  assert.deepEqual(lineFor(cleanSheet, "LINE_POST")[0].doubts, [],
    "POSITIVE CONTROL FAILED: the correct-height case is flagged too, so the flag means nothing");
});

test("ASK, DO NOT GUESS: an unchecked FILING is flagged; an unchecked PRICE is not", () => {
  const run = runRow({ points_encoded: "0:0,2400:0" });
  const out = price([run]);
  const { runs, lines } = fromEngine(out, [run]);

  const filing = pullSheetCatalog().map((c) =>
    c.role === "LINE_POST" ? { ...c, sourceDoc: IMPORTED_CHECK_FILING + " (vinyl?)" } : c);
  const flagged = buildPullSheet(runs, lines, filing);
  assert.ok(lineFor(flagged, "LINE_POST")[0].doubts.includes("FILING_UNCHECKED"),
    "an item whose filing was guessed from its name was not flagged");

  // A SEEDED or imported-but-unverified PRICE is deliberately NOT a doubt here. This page
  // shows no prices, so an unchecked price cannot mislead anybody holding it, and flagging
  // every seeded row would put a warning on every line of a new company's first job --
  // which is how a flag that does matter gets ignored.
  for (const label of ["Starting price — verify with your supplier",
                       "Placeholder — verify with your supplier",
                       "Imported — verify before quoting"]) {
    const priced = pullSheetCatalog().map((c) => ({ ...c, sourceDoc: label }));
    const sheet = buildPullSheet(runs, lines, priced);
    for (const l of sheet.groups.flatMap((g) => g.lines)) {
      assert.ok(!l.doubts.includes("FILING_UNCHECKED"),
        label + ": an unchecked PRICE was reported as an unchecked PRODUCT");
    }
  }
  // POSITIVE CONTROL for the loop above: it really can produce FILING_UNCHECKED.
  assert.ok(lineFor(flagged, "LINE_POST")[0].doubts.includes("FILING_UNCHECKED"));
});

// ============================== 2. THE JOINED CORNER ==============================

test("JOINED RUNS: two ends that meet share ONE post, and the sheet reports the engine's answer", () => {
  const a = runRow({ sync_id: "a7100000-0000-4000-8000-000000000020", label: "Back", points_encoded: "0:0,0:1200", end_joint: JOINT });
  const b = runRow({ sync_id: "a7100000-0000-4000-8000-000000000021", label: "Side", points_encoded: "0:1200,1200:1200", start_joint: JOINT, sort_order: 1 });

  const joined = price([a, b]);
  const apart = price([{ ...a, end_joint: "" }, { ...b, start_joint: "" }]);

  const joinedTotal = joined.runs.reduce((s, r) => s + r.posts.total, 0);
  const apartTotal = apart.runs.reduce((s, r) => s + r.posts.total, 0);
  // POSITIVE CONTROL that the joint is doing something at all. Without this the assertion
  // below passes on an engine that ignores joints entirely.
  assert.equal(apartTotal - joinedTotal, 1,
    "POSITIVE CONTROL FAILED: joining two ends did not remove exactly one post (" +
    apartTotal + " apart vs " + joinedTotal + " joined) -- the joint is not reaching the engine");

  const { runs, lines } = fromEngine(joined, [a, b]);
  const sheet = buildPullSheet(runs, lines, pullSheetCatalog());
  assert.equal(sheet.totalPosts, joinedTotal,
    "the sheet did not take the engine's joined answer");
  assert.equal(sheet.totalPosts, apartTotal - 1,
    "the sheet is buying the post the two runs share");

  // And per role, so "the total happens to match" cannot carry it.
  for (const [role, field] of [["LINE_POST", "line"], ["CORNER_POST", "corner"], ["END_POST", "end"]]) {
    assert.equal(qtyFor(sheet, role),
      joined.runs.reduce((s, r) => s + r.posts[field], 0), role + " disagrees with the engine");
  }
});

// ============================== 3. A TEARDOWN RUN BUYS NOTHING ====================

test("TEARDOWN: a line on a teardown run never reaches the sheet", () => {
  const build = { id: 1, label: "New back", isTeardown: false, fenceHeightFt: 6, hasWork: true, measurable: true };
  const tear = { id: 2, label: "Old chain link", isTeardown: true, fenceHeightFt: 4, hasWork: true, measurable: true };
  const planted = (runId) => ({
    runId, role: "LINE_POST", product: '5"x5" Co-Ex Line Post White 8.5 ft (6 ft fence)',
    quantity: 11, unit: "EA", isAutoGenerated: true,
  });

  // POSITIVE CONTROL: the identical line on the BUILD run does reach the sheet, so an
  // absence below is the teardown rule and not a broken harness.
  const control = buildPullSheet([build, tear], [planted(1)], pullSheetCatalog());
  assert.equal(control.kind, "Ready");
  assert.equal(qtyFor(control, "LINE_POST"), 11, "POSITIVE CONTROL FAILED: a build run's line vanished");
  assert.equal(control.hadTeardownRuns, true, "the sheet did not notice there was a teardown to explain");

  const sheet = buildPullSheet([build, tear], [planted(2)], pullSheetCatalog());
  assert.equal(sheet.kind, "NoTakeoff",
    "a teardown run's materials were treated as a real sheet");
  assert.ok(!JSON.stringify(sheet).includes("Co-Ex Line Post"),
    "a teardown run's product reached the sheet");

  // A job that is ONLY a teardown says so in its own words, rather than looking unpriced.
  assert.equal(buildPullSheet([tear], [planted(2)], pullSheetCatalog()).kind, "OnlyTeardown");
});

test("TEARDOWN: the engine agrees -- a teardown run is not priced for material", () => {
  const build = runRow({ sync_id: "a7100000-0000-4000-8000-000000000030", label: "New", points_encoded: "0:0,2400:0" });
  const tear = runRow({ sync_id: "a7100000-0000-4000-8000-000000000031", label: "Old", points_encoded: "0:600,2400:600", is_teardown: true, sort_order: 1 });
  const out = price([build, tear], CATALOG, { teardown_enabled: true, teardown_rate_per_ft: 3 });
  const forTear = out.items.filter((i) => i.fence_run_sync_id === tear.sync_id);
  assert.equal(forTear.length, 0, "the engine priced material for a fence being removed");
  // POSITIVE CONTROL: the build run DID get lines, so "zero" above is a rule not an outage.
  assert.ok(out.items.filter((i) => i.fence_run_sync_id === build.sync_id).length > 0,
    "POSITIVE CONTROL FAILED: the engine priced nothing at all");
});

// ============================== 4. NO TAKEOFF IS A STATE =========================

test("EMPTY: a job with no takeoff says so, and is NOT an empty sheet", () => {
  const runs = [
    { id: 1, label: "Back", isTeardown: false, fenceHeightFt: 6, hasWork: true, measurable: true },
    { id: 2, label: "Side", isTeardown: false, fenceHeightFt: 6, hasWork: true, measurable: true },
  ];
  const sheet = buildPullSheet(runs, [], pullSheetCatalog());
  assert.equal(sheet.kind, "NoTakeoff", "an un-priced job produced something other than NoTakeoff");
  assert.deepEqual(sheet.runLabels, ["Back", "Side"], "the state does not name the runs waiting");
  assert.equal(sheet.groups, undefined, "a NoTakeoff state is carrying a list of things to buy");

  // POSITIVE CONTROL: the same runs WITH a takeoff are Ready, so NoTakeoff is not just
  // what this function always says.
  const withTakeoff = buildPullSheet(runs, [{
    runId: 1, role: "LINE_POST", product: '5"x5" Co-Ex Line Post White 8.5 ft (6 ft fence)',
    quantity: 9, unit: "EA", isAutoGenerated: true,
  }], pullSheetCatalog());
  assert.equal(withTakeoff.kind, "Ready");
});

test("EMPTY: nothing drawn, and an uncalibrated photo, are different answers", () => {
  assert.equal(buildPullSheet(
    [{ id: 1, label: "Back", isTeardown: false, fenceHeightFt: 6, hasWork: false, measurable: true }],
    [], pullSheetCatalog()).kind, "NoRuns");

  assert.equal(buildPullSheet(
    [{ id: 1, label: "Back", isTeardown: false, fenceHeightFt: 6, hasWork: true, measurable: false }],
    [], pullSheetCatalog()).kind, "NotMeasurable");
});

test("PARTIAL: a sheet that covers some runs says which it does not", () => {
  const runs = [
    { id: 1, label: "Back", isTeardown: false, fenceHeightFt: 6, hasWork: true, measurable: true },
    { id: 2, label: "Side", isTeardown: false, fenceHeightFt: 6, hasWork: true, measurable: true },
    { id: 3, label: "Front", isTeardown: false, fenceHeightFt: 6, hasWork: true, measurable: false },
  ];
  const sheet = buildPullSheet(runs, [{
    runId: 1, role: "LINE_POST", product: '5"x5" Co-Ex Line Post White 8.5 ft (6 ft fence)',
    quantity: 9, unit: "EA", isAutoGenerated: true,
  }], pullSheetCatalog());
  assert.equal(sheet.kind, "Ready");
  assert.deepEqual(sheet.runsWithoutTakeoff, ["Side"], "a run with no takeoff was not reported");
  assert.deepEqual(sheet.runsNotMeasurable, ["Front"], "an unmeasurable run was not reported");
});

// ============================== 5. NO MONEY ANYWHERE =============================

const MONEY_KEY = /price|cost|total|amount|subtotal|tax|money|dollar|fee|deposit|markup|discount/i;
function moneyKeysIn(value, path = "$", found = []) {
  if (value === null || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((v, i) => moneyKeysIn(v, path + "[" + i + "]", found));
    return found;
  }
  for (const [key, v] of Object.entries(value)) {
    // totalPosts is a COUNT of posts. Allowed by name, and the value is asserted
    // to be an integer count below so the exception cannot hide a sum of money.
    if (MONEY_KEY.test(key) && key !== "totalPosts") found.push(path + "." + key);
    moneyKeysIn(v, path + "." + key, found);
  }
  return found;
}

test("NO MONEY: the whole sheet object graph carries no money-shaped key", () => {
  const run = runRow({ points_encoded: "0:0,0:1200,1200:1200", gates_encoded: "600.0:1200.0:4.0:LINE:IN" });
  const out = price([run]);
  const { runs, lines } = fromEngine(out, [run]);
  const sheet = buildPullSheet(runs, lines, pullSheetCatalog());

  // POSITIVE CONTROL: the walker has teeth. The engine's own line item, which this sheet
  // was built from, DOES carry money, and the walker must find it.
  const control = moneyKeysIn(out.items[0]);
  assert.ok(control.includes("$.unit_price"),
    "POSITIVE CONTROL FAILED: the walker cannot see unit_price, so finding nothing below proves nothing. Saw: " +
    JSON.stringify(control));

  assert.deepEqual(moneyKeysIn(sheet), [], "money reached the pull sheet model");
  assert.ok(Number.isInteger(sheet.totalPosts), "totalPosts is not a whole count: " + sheet.totalPosts);
  assert.ok(sheet.totalPosts > 0, "POSITIVE CONTROL FAILED: no posts on the sheet to check");
  // Nothing in the rendered text can be a currency figure either.
  assert.ok(!/[$£€]/.test(JSON.stringify(sheet)), "a currency symbol is on the sheet");
});

test("NO MONEY: the Kotlin model has no money field either", () => {
  const src = readFileSync(KOTLIN_LOGIC, "utf8");
  for (const name of ["PullSheetLine", "PullSheetSourceLine", "PullSheetCatalogRow", "PullSheetRun"]) {
    const start = src.indexOf("data class " + name + "(");
    assert.ok(start > 0, name + " is not a data class in " + KOTLIN_LOGIC + " any more");
    // The constructor body: to the line that closes it at column 0.
    const body = src.slice(start, src.indexOf("\n)", start));
    const fields = [...body.matchAll(/^\s{4}val\s+([A-Za-z0-9_]+)\s*:/gm)].map((m) => m[1]);
    assert.ok(fields.length > 0, name + ": read no fields, so this check is vacuous");
    for (const field of fields) {
      if (MONEY_KEY.test(field)) {
        assert.fail(name + "." + field + " looks like money. The pull sheet must carry none.");
      }
    }
  }
  // POSITIVE CONTROL: the same reader, pointed at EstimateLineItem, DOES find money.
  const entities = readFileSync(KOTLIN_ENTITIES, "utf8");
  const start = entities.indexOf("data class EstimateLineItem(");
  const body = entities.slice(start, entities.indexOf("\n) {", start));
  const fields = [...body.matchAll(/^\s{4}val\s+([A-Za-z0-9_]+)\s*:/gm)].map((m) => m[1]);
  assert.ok(fields.some((f) => MONEY_KEY.test(f)),
    "POSITIVE CONTROL FAILED: the field reader cannot see unitPrice on EstimateLineItem, so the check above is vacuous. Saw: " +
    JSON.stringify(fields));
});

// ============================== 6. TICKS SURVIVE A ROUND TRIP ====================

test("TICKS: a tick survives the screen being left and the phone sleeping", () => {
  const store = makeTickStore();
  const runs = [{ id: 1, label: "Back", isTeardown: false, fenceHeightFt: 6, hasWork: true, measurable: true }];
  const line = { runId: 1, role: "LINE_POST", product: '5"x5" Co-Ex Line Post White 8.5 ft (6 ft fence)', quantity: 9, unit: "EA", isAutoGenerated: true };
  const first = buildPullSheet(runs, [line], pullSheetCatalog());
  const key = first.groups[0].lines[0].key;

  assert.equal(store.tickedKeys(1).has(key), false, "a fresh store already thinks this is loaded");
  store.setTicked(1, key, true);
  assert.equal(store.tickedKeys(1).has(key), true, "the tick did not stick");

  // The screen is left and rebuilt: the sheet is computed again from scratch and the key
  // must come out identical, or the tick is lost even though the store kept it.
  const again = buildPullSheet(runs, [line], pullSheetCatalog());
  assert.equal(again.groups[0].lines[0].key, key, "the same line produced a different key");
  assert.equal(store.tickedKeys(1).has(again.groups[0].lines[0].key), true,
    "the tick did not survive the round trip");

  // Untick, and a different job's ticks are untouched.
  store.setTicked(2, key, true);
  store.setTicked(1, key, false);
  assert.equal(store.tickedKeys(1).has(key), false);
  assert.equal(store.tickedKeys(2).has(key), true, "unticking one job cleared another");
});

test("TICKS: a changed quantity drops the tick; an unchanged one keeps it", () => {
  const store = makeTickStore();
  const runs = [{ id: 1, label: "Back", isTeardown: false, fenceHeightFt: 6, hasWork: true, measurable: true }];
  const at = (q) => buildPullSheet(runs, [{
    runId: 1, role: "LINE_POST", product: '5"x5" Co-Ex Line Post White 8.5 ft (6 ft fence)',
    quantity: q, unit: "EA", isAutoGenerated: true,
  }], pullSheetCatalog()).groups[0].lines[0].key;

  store.setTicked(1, at(9), true);
  // POSITIVE CONTROL: recomputing at the SAME quantity keeps the tick.
  assert.equal(store.tickedKeys(1).has(at(9)), true,
    "POSITIVE CONTROL FAILED: the key is not stable at a fixed quantity, so the test below is meaningless");
  assert.equal(store.tickedKeys(1).has(at(12)), false,
    "the takeoff changed from 9 to 12 and the line still read as loaded");
});

test("SUBSTITUTIONS: a note round trips, and changes no quantity", () => {
  const store = makeTickStore();
  const runs = [{ id: 1, label: "Back", isTeardown: false, fenceHeightFt: 6, hasWork: true, measurable: true }];
  const line = { runId: 1, role: "LINE_POST", product: '5"x5" Co-Ex Line Post White 8.5 ft (6 ft fence)', quantity: 9, unit: "EA", isAutoGenerated: true };
  const sheet = buildPullSheet(runs, [line], pullSheetCatalog());
  const key = sheet.groups[0].lines[0].key;

  assert.equal(store.substitution(1, key), "", "a fresh store invented a note");
  store.setSubstitution(1, key, "  took the 8.5 ft Co-Ex, out of the 6 ft  ");
  assert.equal(store.substitution(1, key), "took the 8.5 ft Co-Ex, out of the 6 ft", "the note did not round trip");

  // The sheet is unchanged by a note: same quantity, same product, same key.
  const after = buildPullSheet(runs, [line], pullSheetCatalog());
  assert.equal(after.groups[0].lines[0].quantity, 9, "a note moved a quantity");
  assert.equal(after.groups[0].lines[0].product, line.product, "a note changed the product");
  assert.equal(after.groups[0].lines[0].key, key);
  // The note is still FOUND after the sheet is rebuilt from scratch. This is the
  // regression that was real: the view model seeded its note map in init, against a sheet
  // that had not been computed yet, so every note already on the phone read as absent and
  // only notes typed in that same session ever showed. The map is derived from the sheet
  // now, which is what this asserts.
  assert.equal(store.substitution(1, after.groups[0].lines[0].key),
    "took the 8.5 ft Co-Ex, out of the 6 ft",
    "a note did not survive the sheet being rebuilt");

  store.setSubstitution(1, key, "   ");
  assert.equal(store.substitution(1, key), "", "clearing a note left it behind");
});

// ============================== 7. THE CANARY ====================================

test("CANARY: a deliberately wrong implementation fails every assertion that matters", () => {
  const failures = [];
  const checked = [];
  const expectFail = (name, fn) => {
    checked.push(name);
    let threw = false;
    try { fn(); } catch { threw = true; }
    if (!threw) failures.push(name);
  };

  const a = runRow({ sync_id: "a7100000-0000-4000-8000-000000000040", label: "Back", points_encoded: "0:0,0:1200", end_joint: JOINT });
  const b = runRow({ sync_id: "a7100000-0000-4000-8000-000000000041", label: "Side", points_encoded: "0:1200,1200:1200", start_joint: JOINT, sort_order: 1 });
  const joined = price([a, b]);
  const apart = price([{ ...a, end_joint: "" }, { ...b, start_joint: "" }]);
  const { runs, lines } = fromEngine(joined, [a, b]);

  // A per-run recount that ignores joints, which is what the wrong implementation uses.
  const naive = new Map(apart.runs.map((r, i) => [i + 1, {
    LINE_POST: r.posts.line, CORNER_POST: r.posts.corner, END_POST: r.posts.end,
    GATE_POST: r.posts.gate, BLANK_POST: 0,
  }]));

  // (a) the joined corner
  expectFail("joined corner", () => {
    const wrong = buildPullSheetWRONG(runs, lines, pullSheetCatalog(), naive);
    assert.equal(wrong.totalPosts, joined.runs.reduce((s, r) => s + r.posts.total, 0));
  });

  // (b) two heights merged into one line
  const tall = runRow({ sync_id: "a7100000-0000-4000-8000-000000000050", label: "Back", points_encoded: "0:0,2400:0", panel_height_ft: 6 });
  const short = runRow({ sync_id: "a7100000-0000-4000-8000-000000000051", label: "Side", points_encoded: "0:400,2400:400", panel_height_ft: 4, sort_order: 1 });
  const twoHeights = price([tall, short]);
  const th = fromEngine(twoHeights, [tall, short]);
  expectFail("two heights stay two lines", () => {
    const wrong = buildPullSheetWRONG(th.runs, th.lines, pullSheetCatalog(), null);
    const posts = wrong.groups.find((g) => g.section === "POSTS").lines.filter((l) => l.role === "LINE_POST");
    assert.equal(posts.length, 2);
    assert.deepEqual(posts.map((l) => l.fenceHeightFt).sort(), [4, 6]);
  });

  // (c) no takeoff answered with an empty sheet
  expectFail("no takeoff is a state", () => {
    const wrong = buildPullSheetWRONG(
      [{ id: 1, label: "Back", isTeardown: false, fenceHeightFt: 6, hasWork: true, measurable: true }],
      [], pullSheetCatalog(), null);
    assert.equal(wrong.kind, "NoTakeoff");
  });

  // (d) a teardown run's materials reaching the truck
  expectFail("teardown buys nothing", () => {
    const wrong = buildPullSheetWRONG(
      [{ id: 2, label: "Old", isTeardown: true, fenceHeightFt: 4, hasWork: true, measurable: true }],
      [{ runId: 2, role: "LINE_POST", product: "whatever", quantity: 11, unit: "EA", isAutoGenerated: true }],
      pullSheetCatalog(), null);
    assert.ok(!JSON.stringify(wrong).includes("whatever"));
  });

  // A canary block that checked nothing would report no failures and read as success --
  // the exact shape of memory/audit-blind-spots.md. So the count is asserted too.
  assert.deepEqual(checked,
    ["joined corner", "two heights stay two lines", "no takeoff is a state", "teardown buys nothing"],
    "the canary did not run all four cases, so 'no failures' below means nothing");
  assert.deepEqual(failures, [],
    "THE CANARY DID NOT FAIL for: " + failures.join(", ") +
    " -- those assertions would pass against a wrong implementation and prove nothing");

  // And the REAL implementation passes every one of the four, so the canary is testing the
  // difference between the two rather than something both get wrong.
  const right = buildPullSheet(runs, lines, pullSheetCatalog());
  assert.equal(right.totalPosts, joined.runs.reduce((s, r) => s + r.posts.total, 0));
  const rightTwo = buildPullSheet(th.runs, th.lines, pullSheetCatalog());
  assert.equal(rightTwo.groups.find((g) => g.section === "POSTS").lines.filter((l) => l.role === "LINE_POST").length, 2);
  assert.equal(buildPullSheet(
    [{ id: 1, label: "Back", isTeardown: false, fenceHeightFt: 6, hasWork: true, measurable: true }],
    [], pullSheetCatalog()).kind, "NoTakeoff");
});

// ============================== 8. THE TRANSCRIPTION IS NOT STALE ================

test("TRANSCRIPTION: the Kotlin's role table, order and post set match the mirror above", () => {
  const src = readFileSync(KOTLIN_LOGIC, "utf8");

  // Every (role -> section) pair in the Kotlin map, read from the source.
  const mapStart = src.indexOf("SECTION_OF_ROLE: Map<MaterialRole, PullSheetSection> = mapOf(");
  assert.ok(mapStart > 0, "SECTION_OF_ROLE is gone from " + KOTLIN_LOGIC);
  const mapBody = src.slice(mapStart, src.indexOf("\n)", mapStart));
  const pairs = [...mapBody.matchAll(/MaterialRole\.([A-Z_]+)\s+to\s+PullSheetSection\.([A-Z_]+)/g)];
  assert.ok(pairs.length > 20, "read only " + pairs.length + " role mappings, so this check is vacuous");
  const kotlinMap = Object.fromEntries(pairs.map((m) => [m[1], m[2]]));
  assert.deepEqual(kotlinMap, SECTION_OF_ROLE,
    "the Kotlin role table and the transcription above have drifted apart");

  // EVERY MaterialRole is filed. A role the map has not heard of falls to OTHER rather
  // than being dropped, but a NEW role nobody considered should be noticed here.
  const entities = readFileSync(KOTLIN_ENTITIES, "utf8");
  const enumStart = entities.indexOf("enum class MaterialRole {");
  const enumBody = entities.slice(enumStart, entities.indexOf("}", enumStart));
  const roles = [...enumBody.matchAll(/\b([A-Z][A-Z_]{2,})\b/g)].map((m) => m[1])
    .filter((r) => r !== "MaterialRole");
  assert.ok(roles.length > 25, "read only " + roles.length + " roles, so this check is vacuous");
  const unfiled = [...new Set(roles)].filter((r) => !(r in SECTION_OF_ROLE));
  assert.deepEqual(unfiled, [],
    "these MaterialRoles have no section on the pull sheet: " + unfiled.join(", "));

  const orderBody = src.slice(src.indexOf("SECTION_ORDER: List<PullSheetSection> = listOf("));
  const order = [...orderBody.slice(0, orderBody.indexOf("\n)")).matchAll(/PullSheetSection\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual(order, SECTION_ORDER, "the reading order of the sections has drifted");

  const postBody = src.slice(src.indexOf("POST_ROLES: Set<MaterialRole> = setOf("));
  const postRoles = [...postBody.slice(0, postBody.indexOf("\n)")).matchAll(/MaterialRole\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual(postRoles.sort(), [...POST_ROLES].sort(), "the set of post roles has drifted");
});

test("TRANSCRIPTION: the filing label the doubt reads is the one SeedData defines", () => {
  const seed = readFileSync("app/src/main/java/com/fenceestimator/app/data/SeedData.kt", "utf8");
  // IMPORTED_CHECK_FILING is built from LABEL_DASH rather than typed, so read both and
  // rebuild it the way the Kotlin does. A hyphen where the em dash belongs matches nothing
  // and silences the doubt with no error anywhere -- see memory/never-compare-against-display-text.md.
  const dash = seed.match(/LABEL_DASH\s*=\s*"(.+?)"/);
  assert.ok(dash, "LABEL_DASH is gone from SeedData.kt");
  assert.equal(dash[1], "—", "LABEL_DASH is no longer an em dash, so every label built from it moved");
  const tmpl = seed.match(/IMPORTED_CHECK_FILING\s*=\s*"(.+?)"/);
  assert.ok(tmpl, "IMPORTED_CHECK_FILING is gone from SeedData.kt");
  const rebuilt = tmpl[1].replace("${LABEL_DASH}", dash[1]);
  assert.equal(rebuilt, IMPORTED_CHECK_FILING,
    "the label this test flags on has drifted from the one SeedData writes");
});

test("TRANSCRIPTION: the strings the screen needs exist in all three locales", () => {
  const screen = readFileSync("app/src/main/java/com/fenceestimator/app/ui/crew/PullSheetScreen.kt", "utf8");
  const used = [...new Set([...screen.matchAll(/R\.string\.(pull_sheet_[a-z0-9_]+)/g)].map((m) => m[1]))];
  assert.ok(used.length > 20, "read only " + used.length + " string keys off the screen, so this check is vacuous");
  for (const dir of ["values", "values-es", "values-fr"]) {
    const xml = readFileSync("app/src/main/res/" + dir + "/strings_pullsheet.xml", "utf8");
    const defined = new Set([...xml.matchAll(/<string name="([^"]+)"/g)].map((m) => m[1]));
    const missing = used.filter((k) => !defined.has(k));
    assert.deepEqual(missing, [], dir + " is missing: " + missing.join(", "));
  }
});
