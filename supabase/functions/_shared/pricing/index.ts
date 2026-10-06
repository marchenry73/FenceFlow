/**
 * The server copy of the phone's pricing engine.
 *
 * `priceJob` takes one PricingInput -- the snake_case rows exactly as
 * CloudJob, CloudFenceRun, CloudMaterialItem and CloudLineItem serialise
 * them (docs/PRICING_CONTRACT.md) -- and returns one PricingOutput. It is
 * used ONLY by the `price-job` edge function and by the fixture replay in
 * parity.ts. The office dashboard never gains a formula: two formulas is how
 * the office and the phone once disagreed about the same job.
 *
 * This file mirrors app/src/test/.../parity/PricingAdapters.kt
 * (PricingRunner.price), which is the one place every rule AROUND the engine
 * is written down: which scale the takeoff measures by, which runs get line
 * items, what a regenerate does to the lines already on a run (the phone's
 * TakeoffLineMerge, which PricingRunner calls and line-items.ts mergeTakeoff
 * ports), which rows no regenerate touches, and the order the totals sum
 * in. The engine itself is the other files.
 *
 * Nothing here performs I/O. Every stage is a pure function so the Kotlin
 * fixtures can be replayed against it and the first divergent stage named.
 */
import { compareString, f32, sortedWith } from "./f32.ts";
import { trim } from "./kotlin-text.ts";
import { buildLineItems, claimedByEdits, mergeTakeoff, withQuotedPrices } from "./line-items.ts";
import { adjustJoins, adjustmentForRun, joinHeightFt, readJointId } from "./joins.ts";
import type { JoinableRun } from "./joins.ts";
import { resolveGeometry, suggestQuantities } from "./takeoff.ts";
import type { EstimateSuggestions, TakeoffGroup } from "./takeoff.ts";
import { computeTotals, linearFeet, teardownLinearFeet } from "./totals.ts";
import { ALUMINUM_STYLES, FENCE_TYPES, MATERIAL_ROLES, WOOD_STYLES, enumValueOf } from "./types.ts";
import type { ChangeOrder, EstimateLineItem, FenceRun, Job, MaterialItem, MaterialRole } from "./types.ts";

export {
  buildLineItems, claimedByEdits, computeTotals, linearFeet, mergeTakeoff, suggestQuantities, teardownLinearFeet,
  withQuotedPrices,
};

/**
 * Bumped, on BOTH engines and in the regenerated fixture manifest, whenever
 * a pricing rule changes. A mismatch between the two engines, or between an
 * engine and the fixtures, is a red parity gate; at runtime it is what lets
 * a phone tell that the office priced a job with newer rules.
 *
 * Bumped 2026.09.2 -> 2026.09.3 for the LINE_TO_WALL post-cap fix
 * (takeoff.ts's gatePosts, ported from EstimateEngine.kt's
 * computePostCounts): the formula moved and this stayed 2026.09.2 on BOTH
 * engines through that whole change, which is exactly the failure mode this
 * constant exists to make impossible -- see
 * tests/a18-gate-post-cap-parity-fix.test.mjs and
 * tests/a4-engine-parity.test.mjs FINDING 2.
 *
 * ###########################################################################
 * BUMPING THIS CONSTANT IS NOT THE LAST STEP. REDEPLOY price-job.
 *
 *     npx supabase functions deploy price-job --project-ref <ref>
 *
 * price-job is the only edge function that bundles this engine, and nothing
 * redeploys it automatically -- not the app's publish gate, not the website
 * workflow. The parity gate compares the two SOURCE engines and proves they
 * agree on the fixtures; it cannot see what is actually running.
 *
 * That gap was open and live for two days on 5 Oct 2026. The phone shipped
 * 2026.10.9 in app 1.602 on 4 October while the DEPLOYED price-job was still
 * the 2 October build carrying 2026.10.8 -- so the office priced a gate with
 * two GATE_POSTs and gave a shared corner post to the TALLER side, while the
 * phone in the owner's hand did neither. Parity was green the whole time, and
 * correctly so. tests/a94-deployed-engine-matches-source.test.mjs pins this
 * note and the one-function assumption behind it.
 * ###########################################################################
 *
 * See the matching comment on
 * EstimateEngine.PRICING_ENGINE_VERSION for what this bump means for a
 * `jobs.pricing_engine_version` row already carrying the old value -- in
 * short, nothing migrates: an anchored (signed/sent) total never moves
 * regardless of this number, and JobSync's own version comparison already
 * treats a stale stored value as exactly that, not as a crash.
 *
 * Bumped 2026.09.3 -> 2026.10.1 (1 Oct 2026) for the total's rounding: grand
 * total is now EXACT to the cent instead of rounded up to the next ten
 * (totals.ts computeTotals / EstimateEngine.computeTotals, both through
 * roundToCents). A formula change, so a version change -- on BOTH engines, and
 * in the regenerated fixtures, where nearly every grand_total moves (82 of the
 * 85 when this was written; by up to $10, always downward, since the old
 * figure was rounded up -- and nothing else in any fixture moves).
 * A phone still on 2026.09.3 rounds up to ten until it updates. On a job the
 * OFFICE priced under 2026.10.1, JobSync's version comparison sees the office
 * as newer and the phone backs off, filing a pricing_parity report instead of
 * overwriting; a job that phone prices itself keeps getting the ten-rounded
 * total until the phone updates. See the matching comment on
 * EstimateEngine.PRICING_ENGINE_VERSION.
 *
 * Bumped 2026.10.1 -> 2026.10.2 (1 Oct 2026) for panel height: between PANEL
 * (or GATE_PANEL) rows of one width, the row whose height_ft equals the run's
 * panel height now beats a row that does not (line-items.ts buildLineItems /
 * EstimateEngine.buildLineItems). A formula change, so a version change on BOTH
 * engines, and the 85 fixtures regenerate in the same commit. It moves a quote
 * only where a company has filled a height in: a catalog that declares none is
 * priced exactly as under 2026.10.1. Where it does move one it is the starting
 * catalog's 6 ft ornamental iron, which was priced with the 4 ft high panel
 * (an UNDERCHARGE of $40 a panel before tax and markup). Anchored totals do not
 * move, as above.
 *
 * Bumped 2026.10.2 -> 2026.10.3 (1 Oct 2026) to extend that same height rule to
 * the POST roles -- LINE_POST, END_POST, CORNER_POST, GATE_POST, BLANK_POST
 * (line-items.ts buildLineItems / EstimateEngine.buildLineItems). A formula
 * change, so a version change on BOTH engines, and the 85 fixtures regenerate in
 * the same commit. This one is not a price: a post has no width, so it was
 * chosen by price alone, and on the owner's own catalog a 72 ft run six feet
 * high was quoted "5x5 Utility Post White 6' (Flori, 4ft run)" at $13.18 -- the
 * post the supplier sells for a FOUR foot fence, six feet long, so nothing of it
 * is in the ground. A fence built on it falls over. On a post, height_ft is the
 * FENCE height the post is for, not the post's own length. Additive exactly as
 * 2026.10.2 was: a catalog where no post declares a height prices identically,
 * and it moves a quote only where a height has been filled in. Anchored totals
 * do not move, as above.
 *
 * Bumped 2026.10.3 -> 2026.10.4 (1 Oct 2026) because a gate now asks for a
 * GATE_POST (takeoff.ts gateAreaEntries / EstimateEngine.gateAreaEntries).
 * WALL is BLANK_POST + GATE_POST, LINE is GATE_POST 2, LINE_TO_WALL is
 * GATE_POST 2 + END_POST 1 -- that third post is where the run terminates at
 * the wall, which is a genuine end post. Every COUNT is unchanged: gatePosts,
 * totalPosts, POST_CAP and CONCRETE_BAG all come out exactly as under
 * 2026.10.3, and the takeoff summary lines do not move. What changes is WHICH
 * CATALOG ROW IS BILLED for those posts, so it is a formula change, so a
 * version change on both engines and the 85 fixtures regenerate in the same
 * commit. Before this, nothing in either engine ever asked for GATE_POST: the
 * role existed, the editor offered it, the seed shipped one per fence type,
 * and a gate quietly bought END_POST rows instead. The owner's catalog has ten
 * GATE_POST rows priced by hand that no estimate could reach.
 * This is additive ONLY once the line-item matcher prefers END_POST for a
 * GATE_POST entry with no candidates; without that, a catalog holding no
 * GATE_POST row loses its gate posts from the estimate entirely. That
 * fallback belongs in buildLineItems on both sides and MUST land in the same
 * commit as this bump. Anchored totals do not move, as above.
 *
 * Bumped 2026.10.4 -> 2026.10.5 (1 Oct 2026) because a BLANK_POST entry with no
 * BLANK_POST row is now priced off the company's GATE_POST rows -- the owner's
 * decision, taken knowing the cost (PRICING_FALLBACK_ROLE in line-items.ts /
 * EstimateEngine.PRICING_FALLBACK_ROLE). BLANK_POST has never existed in any
 * catalog anywhere -- not SeedData.kt, not supabase_r20's seed, not the office
 * page's starting list, and zero rows across every company (read-only SELECT,
 * 1 Oct 2026) -- while the takeoff asks for one on every WALL-mounted gate. So
 * that post has been silently dropped from every wall-gate estimate ever
 * written: the role went into unmatched_roles and no line appeared.
 *
 * THIS ONE IS NOT ADDITIVE, unlike 2026.10.2 and 2026.10.3, and it is the first
 * bump here that is not. Every wall-gate quote in every company that has a
 * GATE_POST row goes UP by one post plus tax -- on the owner's own catalog
 * $17.72 for a 6 ft white vinyl gate ($16.56 + 7%), before markup; $17.93 at 4 ft
 * ($16.75), and $10.16 wood, $21.14 chain link, $23.54 aluminum, $29.96 composite,
 * $34.24 ornamental iron, $14.98 split rail on his rows for those types -- all
 * measured with the real engine rather than multiplied out by hand, which is why
 * three of them sit a cent off the row times 1.07: tax is taken on the whole
 * taxable subtotal and each grand total is rounded to the cent, so the DIFFERENCE
 * of two totals can land either side. Nothing
 * else moves: a quote with no WALL gate is priced identically, and so is one in a
 * catalog with no GATE_POST row (the fallback does NOT chain to END_POST).
 * The 85 fixtures regenerate in the same commit; the wall-gate ones among them
 * move upward by one post and the rest do not move at all.
 *
 * The LINE keeps role BLANK_POST and takes the chosen row's name, so a quote
 * names the gate post it really billed rather than claiming a product he does
 * not stock. unmatched_roles keeps its meaning -- nothing was billed for this
 * role -- so BLANK_POST leaves it where a GATE_POST row carries the line and
 * stays in it where neither row exists. Anchored totals do not move, as above.
 *
 * Bumped 2026.10.6 -> 2026.10.7 (1 Oct 2026) for the gate hardware a fence
 * type actually uses: the takeoff no longer asks for a BRACE or a STIFFENER on
 * a gate that does not take one (takeoff.ts BRACED_GATE_TYPES,
 * STIFFENED_GATE_TYPES -- vinyl alone), and the starting catalog's gate HANDLE
 * moves from VINYL to UNIVERSAL so the six other types can reach it
 * (SeedData.universalItems, supabase_r20's list, dashboard.html's CATALOG_SEED
 * -- all three, or two new companies get different catalogs depending which
 * door they came through).
 *
 * NOBODY'S PRICE MOVES who has a catalog today. Those two roles were unmatched
 * on all six non-vinyl types in every catalog in production (read-only SELECT,
 * 1 Oct 2026), so they billed nothing and a takeoff that stops asking
 * subtracts nothing; what goes is the unmatched-role noise. A vinyl gate is
 * priced to the cent as before, including the entry ORDER that line sort order
 * follows. The owner's own company is vinyl with one UNGATED wood run: all
 * eleven of his live jobs reprice BYTE-IDENTICALLY, measured by replaying his
 * own cloud rows through this engine and through a copy of this same tree with
 * only these gate edits undone -- not argued, and not read off the totals
 * alone (the whole output was compared).
 *
 * WHAT DOES MOVE is a NEW company's first non-vinyl gated quote, by the one
 * handle: +$5.00 of material (plus that company's tax and markup) per gate on
 * wood, chain link, aluminum, ornamental iron, split rail and composite. An
 * existing company's catalog is its own and is never rewritten.
 *
 * Bumped 2026.10.7 -> 2026.10.9 (1 Oct 2026) because TWO SIDES THE OWNER HAS
 * JOINED NOW SHARE ONE POST. `fence_runs.start_joint` / `end_joint` reach the
 * engine (index.ts FenceRunRow + runFromRow, load.ts fenceRunRowToInput), and
 * `adjustJoins` (joins.ts, the port of the phone's RunJoinArithmetic) is
 * called once over every run of the job and its per-run answer handed to
 * suggestQuantities, which applies it at the end of computePostCounts. At a
 * joint where `degree` run ends meet: end posts fall by `degree`, ONE corner
 * (or line) post appears, so the job builds `degree - 1` fewer posts -- and
 * `degree - 1` fewer CAPS (priced off totalPosts) and bags of CONCRETE
 * (priced off totalPosts - gatePosts), and on chain link fewer tension bands,
 * brace bands and rail ends (priced off terminalPosts). Two ends that met
 * become ONE CORNER POST, a different catalog row at a different price, so
 * getting the count right while leaving both as end posts would have been
 * only half of it.
 *
 * A formula change, so a version change on BOTH engines, and the 85 fixtures
 * regenerate in the same commit.
 *
 * ADDITIVE TO THE CENT where nothing is joined, which is everywhere today: no
 * run carries a joint id (the columns are new and unapplied, nothing is
 * backfilled, and the phone does not send one), `adjustJoins` returns
 * NO_JOIN_ADJUSTMENT before it reads any geometry, and computePostCounts
 * never reaches applyJoinAdjustment. No recorded fixture carries a joint and
 * not one of them moves -- tests/a61-corner-post-pricing.test.mjs asserts
 * that against the real engine rather than reasoning about it. Anchored
 * (signed/sent) totals do not move regardless, as above.
 *
 * INVALID DATA FAILS DEARER, never cheaper: a joint id that is not a uuid is
 * read as '' (joins.ts readJointId), and a joint only one live run reaches,
 * or one holding both ends of a single run, is ignored. Each of those prices
 * exactly as an unjoined job does -- two free ends, two end posts.
 *
 * Bumped 2026.10.9 -> 2026.10.10 (5 Oct 2026) because A STANDALONE GATE
 * STANDS ON TWO BLANK POSTS, whatever its mounting says. The owner's rule, in
 * his words: "if a gate is a stand alone and nothing else, it should be 2
 * blank post and the gate, and the hardwares."
 *
 * A gate with no fence line drawn used to get three different answers:
 *
 *   WALL          BLANK_POST 1 + END_POST 1, plus WALL_MOUNT_HOLES hole plugs
 *   LINE          GATE_POST 1 + BLANK_POST 1
 *   LINE_TO_WALL  GATE_POST 1 + END_POST 2   -- THREE posts, and three caps
 *
 * All three now build BLANK_POST 2 and nothing else structural
 * (takeoff.ts gateAreaEntries / EstimateEngine.gateAreaEntries), and
 * computePostCounts counts two posts for every mounting rather than three for
 * LINE_TO_WALL. With no fence drawn no post can be the END of a line, neither
 * post carries one, and there is no wall to bolt to -- the mounting describes
 * how a gate meets a FENCE, and there is no fence for it to describe.
 *
 * The hole plugs go with it. They are the holes drilled through the stiffener
 * into the post that a gate is BOLTED TO A WALL by; a gate standing on its own
 * two posts is not bolted to anything, so a standalone WALL gate used to cost
 * MORE than an identical standalone LINE gate for a wall that is not there.
 *
 * Concrete does not move: it is keyed on the hinge/latch split rather than on
 * the post role, and a standalone gate still has a hinge side and a latch side.
 *
 * MEASURED, NOT ASSUMED: of 87 fixtures exactly one changes content
 * (gate-only-run), and two new ones -- gate-only-run-wall-mount and
 * gate-only-run-line-to-wall-mount -- cover the two mountings that had no
 * fixture at all, which is precisely how the half-applied rule survived. All
 * three price identically at $426.97. Anchored (signed/sent) totals do not
 * move, as above.
 *
 * Bumped 2026.10.10 -> 2026.10.11 (5 Oct 2026) to CORRECT the rule above,
 * which was applied too widely. 2026.10.10 never reached a phone or a server:
 * its release failed on an unrelated gate and the mistake was caught before it
 * shipped, so no job was ever priced under it.
 *
 * "A stand alone and nothing else" excludes a gate hung off a WALL, because a
 * wall is something else and is still there when no fence is. 2026.10.10 gave
 * every mounting two blank posts in the ground whenever no fence was drawn,
 * which for a wall gate billed a second bag of CONCRETE for a post that is
 * bolted up rather than set in the ground, and dropped the four HOLE_PLUGs
 * that actually hold the gate on -- an overcharge and a missing part at once,
 * the opposite of the bug it was fixing. See the GateMounting.WALL doc: "the
 * hinge side bolts through a blank post ... and no concrete, since nothing is
 * set in the ground."
 *
 * So the standalone branch now excludes WALL, and the WALL branch's hardcoded
 * END_POST becomes `latchPost` instead -- END_POST while a fence exists to
 * end, BLANK_POST when none does. A wall gate with no fence therefore still
 * reaches the owner's two blank posts, by the correct route, and keeps its one
 * bag and its four plugs.
 *
 * WORTH KNOWING HOW THIS GOT THROUGH: a fixture DID cover it
 * (gate-only-run-wall-mount) and parity was green at 87 of 87 the whole time.
 * Parity proves the two engines AGREE; both were wrong in the same way,
 * because the same mistake was written into both. A fixture recorded from the
 * engine can only pin what the engine already does. What caught it was
 * ConcreteBagsTest -- a hand-written assertion about what the answer OUGHT to
 * be. GateAreaTest now carries the wall case explicitly for the same reason.
 *
 * Bumped 2026.10.11 -> 2026.10.12 (5 Oct 2026) because A RUN CAN HAVE POINTS
 * AND NO LENGTH, and the two halves of the engine disagreed about it.
 *
 * `hasFenceLine` is judged on LENGTH (totalLinearFeet > 0). `endCount` is
 * judged on POINTS -- it counts vertices classified END. A run whose two
 * points sit on the same spot has two ends and zero feet, so a gate on it took
 * the standalone branch (BLANK_POST 2) while computePostCounts added END_POST
 * 2 beside it. Four posts, four caps and their concrete for a gate that stands
 * on two.
 *
 * That run is not contrived. A double-tap on the drawing screen drops a point
 * BEFORE the dialog opens, so one made that way has exactly two coincident
 * points. Reported from the field: "I put a gate on there and it showed 2 end
 * posts and 2 blank ones."
 *
 * endPosts and cornerPosts now both follow hasFenceLine, which is the same
 * sentence the gate code already uses -- no post can be the END of a line that
 * is not there -- applied to the count beside it.
 *
 * NARROW BY CONSTRUCTION: it can only move a run whose length is zero, and a
 * run with any length at all prices exactly as it did. New case 85,
 * gate-only-run-two-coincident-points, pins it; every other gate-only case has
 * NO points, which is why none of them caught this -- they agreed with each
 * other about a run that does not exist and said nothing about one that half
 * does.
 */
export const PRICING_ENGINE_VERSION = "2026.10.12";

// ---------------------------------------------------------------------------
// Contract shapes (docs/PRICING_CONTRACT.md). Column names, never invented.
// ---------------------------------------------------------------------------

export interface JobRow {
  calibration_pixels_per_foot: number | null;
  tax_rate_percent: number;
  markup_percent: number;
  discount_percent: number;
  labor_rate_per_ft: number;
  labor_flat_fee: number;
  minimum_job_charge: number | null;
  // NOT nullable, unlike its three neighbours: the Postgres column is NOT NULL
  // DEFAULT 0 and CloudJob sends a non-null Double. Declared `number`, a row
  // shape that forgets the column is a type error here instead of a silent 0 --
  // which is exactly how price-job came to quote this job $160 lower than the
  // phone.
  minimum_labor_charge: number;
  waste_percent: number;
  gate_rate_per_ft: number | null;
  trash_haul_fee: number | null;
  teardown_enabled: boolean;
  teardown_flat_fee: number;
  teardown_rate_per_ft: number;
  teardown_feet: number;
  preferred_manufacturer_sync_id: string | null;
}

export interface FenceRunRow {
  sync_id: string;
  label: string;
  fence_type: string;
  color_or_finish: string;
  points_encoded: string;
  gates_encoded: string;
  closed_loop: boolean;
  manual_linear_feet: number | null;
  manual_corner_count: number;
  panel_width_ft: number;
  panel_height_ft: number;
  post_spacing_ft: number;
  concrete_bags_per_post: number;
  aluminum_style: string;
  wood_style: string;
  wood_rail_count: number;
  picket_width_in: number;
  picket_gap_in: number;
  fabric_height_ft: number;
  include_top_rail: boolean;
  include_tension_wire: boolean;
  include_barbed_wire_arms: boolean;
  include_privacy_slats: boolean;
  split_rail_count: number;
  suppressed_roles: string;
  is_teardown: boolean;
  sort_order: number;
  /**
   * `fence_runs.start_joint` / `end_joint`: the joint each end of this run
   * stands at, or '' for a free end (supabase_a32_join_runs.sql).
   *
   * OPTIONAL, like `MaterialItemRow.height_ft` and for the same reason: the
   * 85 recorded fixtures carry no such key, and a caller need not select
   * every column (`buildSampleRun` invents a run with no joints at all).
   * Absent, null and '' all read as NOT JOINED, which is the old, DEARER
   * answer: two free ends, two end posts, two caps, two bags of concrete.
   * Invalid or missing join data must never make a job cheaper.
   */
  start_joint?: string | null;
  end_joint?: string | null;
}

export interface MaterialItemRow {
  sync_id: string;
  name: string;
  category: string;
  role: string;
  fence_type: string;
  color_or_finish: string;
  unit: string;
  unit_price: number;
  /** Not a Kotlin field; accepted because the contract lists it, never read. */
  supplier_unit_price?: number | null;
  taxable: boolean;
  covers_ft: number | null;
  /**
   * `material_items.height_ft`: how tall a PANEL or GATE_PANEL row is. A real
   * column, not something read out of `name`, and not `covers_ft` (width for
   * those roles). Float.
   *
   * OPTIONAL, unlike every other field here: absent, null and undefined all read
   * as "the row does not say" (the 85 recorded fixtures carry no such key, and
   * the phone's test-side decoder, ParityJson, refuses a key it does not
   * know). A row that does not say is priced exactly as before the column
   * existed. See [MaterialItem.heightFt].
   */
  height_ft?: number | null;
  is_active: boolean;
  manufacturer_sync_id: string | null;
}

export interface ManufacturerRow {
  sync_id: string;
  name: string;
}

export interface ChangeOrderRow {
  sync_id: string;
  additional_feet: number;
  additional_cost: number;
  material_cost: number;
}

export interface LineItemRow {
  sync_id: string;
  fence_run_sync_id: string | null;
  role: string | null;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  supplier_unit_price: number | null;
  taxable: boolean;
  auto_generated: boolean;
  sort_order: number;
}

export interface PricingInput {
  engine_version: string;
  /** job.calibration_pixels_per_foot ?? 20 (the EstimateViewModel / TakeoffRefresher fallback). Float. */
  pixels_per_foot: number;
  job: JobRow;
  /** fence_runs rows, non-deleted, in sort order. */
  runs: FenceRunRow[];
  /** material_items rows, active and inactive both (the engine filters). */
  catalog: MaterialItemRow[];
  /** The phone narrows on manufacturer ids; a sync id absent from this list resolves to "no manufacturer". */
  manufacturers: ManufacturerRow[];
  change_orders: ChangeOrderRow[];
  /** estimate_line_items rows already on the job: what each run's regenerate merges with, and the rows it never touches. */
  existing_items: LineItemRow[];
}

export interface SegmentOutput {
  from_index: number;
  to_index: number;
  /** Float. */
  length_ft: number;
}

export interface VertexOutput {
  index: number;
  kind: string;
  /** Float. */
  turn_degrees: number;
}

export interface GeometryOutput {
  corner_count: number;
  end_count: number;
  line_vertex_count: number;
  segments: SegmentOutput[];
  vertices: VertexOutput[];
}

export interface PostsOutput {
  line: number;
  corner: number;
  end: number;
  gate: number;
  terminal: number;
  total: number;
}

export interface EntryOutput {
  role: MaterialRole;
  quantity: number;
  prefer_covers_ft: number | null;
  covers_linear_ft: number | null;
}

export interface TakeoffLineOutput {
  label: string;
  quantity: number;
  unit: string;
  group: TakeoffGroup;
}

export interface RunOutput {
  run_sync_id: string;
  is_teardown: boolean;
  gate_count: number;
  /** Float. */
  gross_feet: number;
  /** Float. */
  gate_feet: number;
  /** Float. */
  net_feet: number;
  geometry: GeometryOutput;
  posts: PostsOutput;
  entries: EntryOutput[];
  takeoff: TakeoffLineOutput[];
}

export interface ItemOutput {
  sync_id: string;
  fence_run_sync_id: string;
  sort_order: number;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  supplier_unit_price: number | null;
  taxable: boolean;
  role: MaterialRole;
  auto_generated: boolean;
  /** Always null: EstimateLineItem carries no category. Kept so the column has a home. */
  category: null;
}

export interface RunRole {
  run_sync_id: string;
  role: MaterialRole;
}

export interface RunName {
  run_sync_id: string;
  name: string;
}

export interface TotalsOutput {
  materials_subtotal: number;
  taxable_subtotal: number;
  tax: number;
  labor_cost: number;
  teardown_cost: number;
  trash_haul_fee: number;
  gate_feet: number;
  gate_charge: number;
  change_order_cost: number;
  change_order_feet: number;
  markup_amount: number;
  discount_amount: number;
  pre_markup_total: number;
  grand_total: number;
  /** Float. */
  billable_linear_feet: number;
}

export interface PricingOutput {
  engine_version: string;
  /** Float. */
  linear_feet: number;
  /** Float. */
  teardown_linear_feet: number;
  /** Float. */
  billable_linear_feet: number;
  /** Every run in runs[] order, teardown runs included. */
  runs: RunOutput[];
  /**
   * Every run's takeoff lines after the regenerate, in run order: for each
   * run the freshly built lines (supplier quotes carried), then the lines
   * somebody edited by hand, exactly as they are. An edited line is never
   * written by a commit (load.ts buildCommitPlan); it is here so the office
   * sees the estimate the totals were summed from. A teardown run has only
   * the latter.
   */
  items: ItemOutput[];
  unmatched_roles: RunRole[];
  /** Sync ids of freshly built rows (never an edited one) whose catalog price is <= 0. */
  zero_priced: string[];
  zero_priced_names: RunName[];
  /** Line-item sync ids in the order computeTotals summed them. */
  totals_items: string[];
  totals: TotalsOutput;
}

// ---------------------------------------------------------------------------
// Adapters: cloud rows -> the Kotlin shapes, exactly as PricingRunner builds
// them. Null fallbacks for the nullable money columns are the ones the
// phone's own pull (JobSync / EntitySync) applies to the same rows.
// ---------------------------------------------------------------------------

const num = (x: number | null | undefined, fallback: number): number => (x === null || x === undefined ? fallback : x);
const int = (x: number | null | undefined, fallback: number): number => Math.trunc(num(x, fallback));
const str = (x: string | null | undefined, fallback: string): string => (x === null || x === undefined ? fallback : x);
const bool = (x: boolean | null | undefined, fallback: boolean): boolean => (x === null || x === undefined ? fallback : x);

/**
 * A JSON number that is not exactly a float cannot have come from the
 * phone, and would price differently there. Refuse it rather than round --
 * PricingRunner.f32 does the same, so a value one engine rejects the other
 * rejects too. (NaN fails the equality, as it does on the JVM.)
 */
export function floatExact(value: number, field: string): number {
  const f = f32(value);
  if (f !== value) throw new Error(`${field} = ${value} is not representable as a Float (write it after fround)`);
  return f;
}

const flt = (x: number | null | undefined, fallback: number, field: string): number => floatExact(num(x, fallback), field);

/**
 * The phone narrows on manufacturer ids it has, and JobSync resolves a sync
 * id it has never seen to null. Here the ids ARE the sync ids, so "never
 * seen" is "not in manufacturers[]".
 */
function resolveManufacturer(syncId: string | null | undefined, known: ReadonlySet<string>): string | null {
  if (syncId === null || syncId === undefined) return null;
  return known.has(syncId) ? syncId : null;
}

export function jobFromRow(row: JobRow, manufacturerSyncIds: ReadonlySet<string>): Job {
  return {
    calibrationPixelsPerFoot: row.calibration_pixels_per_foot === null || row.calibration_pixels_per_foot === undefined
      ? null
      : floatExact(row.calibration_pixels_per_foot, "job.calibration_pixels_per_foot"),
    taxRatePercent: num(row.tax_rate_percent, 0.0),
    markupPercent: num(row.markup_percent, 0.0),
    laborRatePerFt: num(row.labor_rate_per_ft, 0.0),
    laborFlatFee: num(row.labor_flat_fee, 0.0),
    discountPercent: num(row.discount_percent, 0.0),
    // JobSync's fresh-pull defaults for the three nullable money columns.
    minimumJobCharge: num(row.minimum_job_charge, 0.0),
    minimumLaborCharge: num(row.minimum_labor_charge, 0.0),
    wastePercent: num(row.waste_percent, 0.0),
    gateRatePerFt: num(row.gate_rate_per_ft, 20.0),
    trashHaulFee: num(row.trash_haul_fee, 0.0),
    teardownEnabled: bool(row.teardown_enabled, false),
    teardownFlatFee: num(row.teardown_flat_fee, 0.0),
    teardownRatePerFt: num(row.teardown_rate_per_ft, 0.0),
    teardownFeet: num(row.teardown_feet, 0.0),
    preferredManufacturerSyncId: resolveManufacturer(row.preferred_manufacturer_sync_id, manufacturerSyncIds),
  };
}

/**
 * FenceRun.suppressedRoles: the CSV split on commas, each name trimmed and
 * looked up; anything that is not a role is dropped, as runCatching drops it.
 */
export function parseSuppressedRoles(csv: string): Set<MaterialRole> {
  const roles = new Set<MaterialRole>();
  for (const name of csv.split(",")) {
    const role = enumValueOf(MATERIAL_ROLES, trim(name));
    if (role !== null) roles.add(role);
  }
  return roles;
}

export function runFromRow(row: FenceRunRow, index: number): FenceRun {
  const at = `runs[${index}]`;
  // Strict on purpose: a run row with a fence type the phone does not know
  // is not something either engine should price (FenceType.valueOf throws).
  const fenceType = enumValueOf(FENCE_TYPES, str(row.fence_type, ""));
  if (fenceType === null) throw new Error(`${at}.fence_type ${JSON.stringify(row.fence_type)} is not a FenceType`);
  return {
    syncId: row.sync_id,
    label: str(row.label, ""),
    fenceType,
    sortOrder: int(row.sort_order, 0),
    pointsEncoded: str(row.points_encoded, ""),
    gatesEncoded: str(row.gates_encoded, ""),
    closedLoop: bool(row.closed_loop, false),
    isTeardown: bool(row.is_teardown, false),
    colorOrFinish: str(row.color_or_finish, ""),
    panelWidthFt: flt(row.panel_width_ft, 6, `${at}.panel_width_ft`),
    panelHeightFt: flt(row.panel_height_ft, 6, `${at}.panel_height_ft`),
    // Not read by the engine; mapped the way the pull does (EntitySync) for completeness.
    aluminumStyle: enumValueOf(ALUMINUM_STYLES, str(row.aluminum_style, "RACKABLE")) ?? "RACKABLE",
    woodStyle: enumValueOf(WOOD_STYLES, str(row.wood_style, "PRIVACY")) ?? "PRIVACY",
    woodRailCount: int(row.wood_rail_count, 3),
    picketWidthIn: flt(row.picket_width_in, 5.5, `${at}.picket_width_in`),
    picketGapIn: flt(row.picket_gap_in, 0, `${at}.picket_gap_in`),
    fabricHeightFt: flt(row.fabric_height_ft, 4, `${at}.fabric_height_ft`),
    includeTopRail: bool(row.include_top_rail, true),
    includeTensionWire: bool(row.include_tension_wire, false),
    includeBarbedWireArms: bool(row.include_barbed_wire_arms, false),
    includePrivacySlats: bool(row.include_privacy_slats, false),
    splitRailCount: int(row.split_rail_count, 2),
    postSpacingFt: flt(row.post_spacing_ft, 6, `${at}.post_spacing_ft`),
    concreteBagsPerPost: flt(row.concrete_bags_per_post, 1, `${at}.concrete_bags_per_post`),
    manualLinearFeet: row.manual_linear_feet === null || row.manual_linear_feet === undefined
      ? null
      : floatExact(row.manual_linear_feet, `${at}.manual_linear_feet`),
    manualCornerCount: int(row.manual_corner_count, 0),
    suppressedRoles: parseSuppressedRoles(str(row.suppressed_roles, "")),
    // VALIDATE ON READ. The column has no CHECK constraint on purpose (one
    // bad row would fail the whole batched upsert and stop every run of that
    // company syncing), so anything that is not a uuid becomes '' here and
    // the run prices with two free ends -- today's answer. joins.ts
    // readJointId.
    startJointId: readJointId(row.start_joint),
    endJointId: readJointId(row.end_joint),
  };
}

/**
 * Catalog enums fall back exactly as the phone's pull does (EntitySync
 * material_items): an unknown role is NONE, category MISC, fence type
 * UNIVERSAL.
 */
export function materialItemFromRow(row: MaterialItemRow, index: number, manufacturerSyncIds: ReadonlySet<string>): MaterialItem {
  return {
    syncId: row.sync_id,
    category: str(row.category, "MISC"),
    role: enumValueOf(MATERIAL_ROLES, str(row.role, "NONE")) ?? "NONE",
    fenceType: enumValueOf(FENCE_TYPES, str(row.fence_type, "UNIVERSAL")) ?? "UNIVERSAL",
    name: str(row.name, ""),
    unit: str(row.unit, "EA"),
    unitPrice: num(row.unit_price, 0.0),
    taxable: bool(row.taxable, true),
    coversFt: row.covers_ft === null || row.covers_ft === undefined
      ? null
      : floatExact(row.covers_ft, `catalog[${index}].covers_ft`),
    heightFt: row.height_ft === null || row.height_ft === undefined
      ? null
      : floatExact(row.height_ft, `catalog[${index}].height_ft`),
    colorOrFinish: str(row.color_or_finish, ""),
    manufacturerSyncId: resolveManufacturer(row.manufacturer_sync_id, manufacturerSyncIds),
    isActive: bool(row.is_active, true),
  };
}

export function changeOrderFromRow(row: ChangeOrderRow): ChangeOrder {
  return {
    syncId: row.sync_id,
    additionalFeet: num(row.additional_feet, 0.0),
    additionalCost: num(row.additional_cost, 0.0),
    materialCost: num(row.material_cost, 0.0),
  };
}

/**
 * A row on a run this input does not carry is job-level as far as pricing
 * goes: nothing regenerates it and nothing removes it. So the run reference
 * survives only when it names one of runs[].
 */
export function lineItemFromRow(row: LineItemRow, runSyncIds: ReadonlySet<string>): EstimateLineItem {
  const runSyncId = row.fence_run_sync_id;
  return {
    syncId: row.sync_id,
    fenceRunSyncId: runSyncId !== null && runSyncId !== undefined && runSyncIds.has(runSyncId) ? runSyncId : null,
    sortOrder: int(row.sort_order, 0),
    description: str(row.description, ""),
    quantity: num(row.quantity, 0.0),
    unit: str(row.unit, "EA"),
    unitPrice: num(row.unit_price, 0.0),
    taxable: bool(row.taxable, true),
    // Same fallback as the pull: an unknown or missing role is NONE.
    role: (row.role === null || row.role === undefined ? null : enumValueOf(MATERIAL_ROLES, row.role)) ?? "NONE",
    isAutoGenerated: bool(row.auto_generated, false),
    supplierUnitPrice: row.supplier_unit_price === null || row.supplier_unit_price === undefined ? null : row.supplier_unit_price,
  };
}

/** `compareBy { it.sortOrder }` on an Int. */
function compareInt(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The order the phone reads an estimate in: ORDER BY sortOrder ASC, syncId
 * ASC (EstimateLineItemDao.observeForJob and getGeneratedForRun).
 */
function byEstimateOrder(a: EstimateLineItem, b: EstimateLineItem): number {
  return compareInt(a.sortOrder, b.sortOrder) || compareString(a.syncId, b.syncId);
}

// ---------------------------------------------------------------------------
// The job, priced the way the phone prices it: every run's takeoff, the
// lines for the runs that get any, then the totals over what is left on the
// job afterwards.
// ---------------------------------------------------------------------------

export function priceJob(input: PricingInput): PricingOutput {
  if (input.engine_version !== PRICING_ENGINE_VERSION) {
    throw new Error(`input engine_version ${input.engine_version} != ${PRICING_ENGINE_VERSION}`);
  }

  const manufacturerSyncIds: ReadonlySet<string> = new Set(input.manufacturers.map((m) => m.sync_id));
  const job = jobFromRow(input.job, manufacturerSyncIds);
  const runs = input.runs.map(runFromRow);
  const catalog = input.catalog.map((row, i) => materialItemFromRow(row, i, manufacturerSyncIds));
  const changeOrders = input.change_orders.map(changeOrderFromRow);
  const runSyncIds: ReadonlySet<string> = new Set(runs.map((r) => r.syncId));
  const existing = input.existing_items.map((row) => lineItemFromRow(row, runSyncIds));

  // The scale the takeoff measures by. Typed footage ignores it; a drawn run
  // uses the job's calibration, or the grid's 20 px/ft when there is none
  // (EstimateViewModel.regenerateInternal, TakeoffRefresher). linearFeet()
  // below does NOT share this fallback -- an uncalibrated drawn run bills
  // zero labour feet while still getting materials -- and that asymmetry is
  // the phone's, so it is reproduced, not repaired.
  const pixelsPerFoot = floatExact(input.pixels_per_foot, "pixels_per_foot");

  // THE JOINS, worked out ONCE over every run of the job, before the per-run
  // loop below. Once, and over all of them, because a shared post has to be
  // billed to exactly one run and which one is decided ACROSS runs (the
  // taller fence, then sort order, then id): a per-run call would see only
  // one candidate and every member would keep the post.
  //
  // The geometry handed over is the SAME resolveGeometry the run's posts are
  // counted from, so a typed-footage run arrives with no vertices and a
  // closed run with no ends -- exactly the two cases the arithmetic refuses
  // to take a post off. Reusing it rather than re-measuring is what stops
  // this and computePostCounts disagreeing about whether a run has ends.
  //
  // A job where no run carries a joint id returns NO_JOIN_ADJUSTMENT before
  // any geometry is read, every run below gets a zero delta, and the price
  // is identical to the cent. That is what protects every quote already
  // sent.
  const joinables: JoinableRun[] = runs.map((run) => ({
    id: run.syncId,
    geometry: resolveGeometry(run, pixelsPerFoot),
    // NOT panelHeightFt: chain link keeps its height in fabricHeightFt and
    // split rail declares none. joins.ts joinHeightFt, which is the same rule
    // EstimateEngine.joinHeightOf and SurveyViewModel.joinHeightOf apply.
    heightFt: joinHeightFt(run),
    sortOrder: run.sortOrder,
    isTeardown: run.isTeardown,
    startJointId: run.startJointId,
    endJointId: run.endJointId,
  }));
  const joins = adjustJoins(joinables);

  const runOutputs: RunOutput[] = [];
  const takeoffItems: EstimateLineItem[] = [];
  const unmatched: RunRole[] = [];
  const zeroPricedIds: string[] = [];
  const zeroPricedNames: RunName[] = [];

  for (const run of runs) {
    const suggestions = suggestQuantities(run, pixelsPerFoot, job.wastePercent, adjustmentForRun(joins, run.syncId));
    runOutputs.push(runOutput(run, suggestions));

    // This run's lines in the order the phone reads them for a regenerate
    // (getGeneratedForRun: sort_order, then sync_id). The order decides which
    // of two quotes on one role carries and the order kept lines are listed
    // in, and rows read from the database come in no order at all.
    const existingForRun = sortedWith(existing.filter((e) => e.fenceRunSyncId === run.syncId), byEstimateOrder);

    // A teardown run is the old fence: no bill of materials, so its
    // generated lines go. A line somebody typed a number into is theirs and
    // stays (TakeoffRefresher.refreshRun merges a teardown run with nothing).
    if (run.isTeardown) {
      for (const item of mergeTakeoff(existingForRun, []).keptEdited) takeoffItems.push(item);
      continue;
    }

    const built = buildLineItems(run, suggestions, catalog, job.preferredManufacturerSyncId);
    for (const role of built.unmatchedRoles) unmatched.push({ run_sync_id: run.syncId, role });
    for (const name of built.zeroPricedNames) zeroPricedNames.push({ run_sync_id: run.syncId, name });

    // Edited lines stay and stand in for the built line they correct, the
    // generated ones give way to the rebuild, supplier quotes carry
    // (line-items.ts mergeTakeoff, the phone's TakeoffLineMerge.plan).
    const merge = mergeTakeoff(existingForRun, built.items);
    for (const item of merge.insert) if (item.unitPrice <= 0.0) zeroPricedIds.push(item.syncId);
    for (const item of merge.insert) takeoffItems.push(item);
    for (const item of merge.keptEdited) takeoffItems.push(item);
  }

  // What is on the job after the regenerate, and therefore what the totals
  // see: every run's takeoff lines above, plus the rows no regenerate
  // touches -- hand-typed extras (role NONE) and rows with no run.
  const survivors = existing.filter((e) => e.role === "NONE" || e.fenceRunSyncId === null);

  // The phone sums whatever observeLineItems hands it, and that is
  // ORDER BY sortOrder ASC, syncId ASC. Floating-point sums depend on order,
  // so the office has to add the same rows in the same order.
  const itemsForTotals = sortedWith(takeoffItems.concat(survivors), byEstimateOrder);

  const totalFeet = linearFeet(job, runs);
  const totals = computeTotals(job, itemsForTotals, totalFeet, changeOrders, runs);

  return {
    engine_version: PRICING_ENGINE_VERSION,
    linear_feet: totalFeet,
    teardown_linear_feet: teardownLinearFeet(job, runs),
    billable_linear_feet: totals.billableLinearFeet,
    runs: runOutputs,
    items: takeoffItems.map((item) => ({
      sync_id: item.syncId,
      fence_run_sync_id: item.fenceRunSyncId as string,
      sort_order: item.sortOrder,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unitPrice,
      supplier_unit_price: item.supplierUnitPrice,
      taxable: item.taxable,
      role: item.role,
      auto_generated: item.isAutoGenerated,
      category: null,
    })),
    unmatched_roles: unmatched,
    zero_priced: zeroPricedIds,
    zero_priced_names: zeroPricedNames,
    totals_items: itemsForTotals.map((i) => i.syncId),
    totals: {
      materials_subtotal: totals.materialsSubtotal,
      taxable_subtotal: totals.taxableSubtotal,
      tax: totals.tax,
      labor_cost: totals.laborCost,
      teardown_cost: totals.teardownCost,
      trash_haul_fee: totals.trashHaulFee,
      gate_feet: totals.gateFeet,
      gate_charge: totals.gateCharge,
      change_order_cost: totals.changeOrderCost,
      change_order_feet: totals.changeOrderFeet,
      markup_amount: totals.markupAmount,
      discount_amount: totals.discountAmount,
      // Not on Totals; rebuilt from the six components it IS built from, in
      // the engine's own order (computeTotals, preMarkup).
      pre_markup_total: totals.materialsSubtotal + totals.tax + totals.laborCost +
        totals.teardownCost + totals.changeOrderCost + totals.gateCharge,
      grand_total: totals.grandTotal,
      billable_linear_feet: totals.billableLinearFeet,
    },
  };
}

function runOutput(run: FenceRun, s: EstimateSuggestions): RunOutput {
  // PostCounts is private to the engine on the phone; PricingRunner reads
  // every one of its figures back off the takeoff lines (zero lines are
  // dropped there, hence the 0), and so does this, so that a renamed label
  // fails the posts stage on both sides rather than one.
  const takeoffInt = (label: string): number => {
    const line = s.takeoff.find((t) => t.label === label);
    return line === undefined ? 0 : Math.trunc(line.quantity);
  };
  const line = takeoffInt("Line posts");
  const corner = takeoffInt("Corner posts");
  const end = takeoffInt("End posts");
  const gate = takeoffInt("Gate posts (end posts + stiffener)");

  return {
    run_sync_id: run.syncId,
    is_teardown: run.isTeardown,
    gate_count: s.gates.length,
    gross_feet: s.geometry.totalLinearFeet,
    gate_feet: s.gateWidthTotal,
    net_feet: s.netLinearFeet,
    geometry: {
      corner_count: s.geometry.cornerCount,
      end_count: s.geometry.endCount,
      line_vertex_count: s.geometry.lineVertexCount,
      segments: s.geometry.segments.map((seg) => ({ from_index: seg.fromIndex, to_index: seg.toIndex, length_ft: seg.lengthFt })),
      vertices: s.geometry.vertices.map((v) => ({ index: v.index, kind: v.kind, turn_degrees: v.turnDegrees })),
    },
    posts: {
      line,
      corner,
      end,
      gate,
      terminal: corner + end + gate,
      total: takeoffInt("Total posts"),
    },
    entries: s.entries.map((e) => ({
      role: e.role,
      quantity: e.quantity,
      prefer_covers_ft: e.preferCoversFt,
      covers_linear_ft: e.coversLinearFt,
    })),
    takeoff: s.takeoff.map((t) => ({ label: t.label, quantity: t.quantity, unit: t.unit, group: t.group })),
  };
}
