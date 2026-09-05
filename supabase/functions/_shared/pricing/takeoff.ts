/**
 * Port of EstimateEngine.suggestQuantities and everything under it
 * (app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt).
 *
 * Turns a calibrated fence run (drawing + gate placements + type/spec) into
 * suggested material quantities. These are starting numbers meant to be
 * reviewed and adjusted by the contractor before pricing -- not a guarantee
 * of exact takeoff.
 *
 * Function names, order of operations and even the known oddities are the
 * phone's. Nothing here is "fixed": a behaviour change is a versioned change
 * to both engines with regenerated fixtures.
 */
import { ceilRoundToInt, coerceAtLeast, doubleSum, f32 } from "./f32.ts";
import { analyze, decodeGates, decodePoints } from "./geometry.ts";
import type { FenceGeometryResult, GateMarker } from "./geometry.ts";
import type { FenceRun, FenceType, MaterialRole } from "./types.ts";

/** One suggested catalog role + quantity, optionally preferring an item covering a specific width/height. */
export interface QtyEntry {
  role: MaterialRole;
  /** Double. */
  quantity: number;
  /** Float. */
  preferCoversFt: number | null;
  /**
   * The run of fence this entry has to cover, in feet.
   *
   * Carried because quantity has already been rounded up to whole units at
   * one width, and re-deriving feet from it (quantity x width) inherits that
   * rounding -- which buys an extra panel every time the catalog stocks a
   * different width than the run was spec'd for. The true footage does not
   * have that problem. Float.
   */
  coversLinearFt: number | null;
}

function qty(role: MaterialRole, quantity: number, preferCoversFt: number | null = null, coversLinearFt: number | null = null): QtyEntry {
  return { role, quantity, preferCoversFt, coversLinearFt };
}

export interface PostCounts {
  linePosts: number;
  cornerPosts: number;
  endPosts: number;
  gatePosts: number;
  terminalPosts: number;
  totalPosts: number;
}

export interface EstimateSuggestions {
  geometry: FenceGeometryResult;
  /** Float. */
  netLinearFeet: number;
  entries: QtyEntry[];
  // The three below are private intermediates on the phone. They are kept
  // on the result so the fixture can assert them stage by stage.
  gates: GateMarker[];
  /** Float: the gate openings taken out of the gross footage. */
  gateWidthTotal: number;
  postCounts: PostCounts;
}

/** Fence types whose gate uses a built gate-frame kit rather than a matching panel. */
const FRAME_KIT_GATE_TYPES: ReadonlySet<FenceType> = new Set(["WOOD", "CHAIN_LINK", "SPLIT_RAIL", "COMPOSITE"]);

/**
 * Roles bought by length or by the piece, where an extra cut-and-waste
 * allowance makes sense. Posts, caps, and hardware are deliberately absent:
 * you buy those as whole units off an exact count.
 */
const WASTE_ROLES: ReadonlySet<MaterialRole> = new Set([
  "PANEL", "WOOD_PICKET", "WOOD_RAIL",
  "CHAIN_FABRIC", "TOP_RAIL", "TENSION_WIRE",
  "PRIVACY_SLAT", "CONCRETE_BAG", "TRIM",
]);

/** Holes drilled through the stiffener into the blank post, each needing a plug. */
const WALL_MOUNT_HOLES = 4.0;

/**
 * Concrete for the two posts a gate hangs between.
 *
 * Only the hinge post carries the gate's weight and its swing, so only
 * that one is dug deep and wide enough to want the extra half bag. The
 * latch side is holding a catch, not a gate, and takes an ordinary post's
 * bag whether it stands in the fence line or on its own.
 *
 * This was a flat two bags for each, which quietly over-ordered half a bag
 * on every gate. The total is rounded up to whole bags by wholeBags.
 */
const GATE_HINGE_BAGS = 1.5;
const GATE_LATCH_BAGS = 1.0;

/**
 * @param wastePercent extra allowance applied to cut-and-waste roles only.
 */
export function suggestQuantities(run: FenceRun, pixelsPerFoot: number, wastePercent = 0.0): EstimateSuggestions {
  const gates = decodeGates(run.gatesEncoded);
  const geometry = resolveGeometry(run, pixelsPerFoot);
  // sumOf { it.widthFt.toDouble() }.toFloat()
  const gateWidthTotal = f32(doubleSum(gates.map((g) => g.widthFt)));
  const netFt = coerceAtLeast(f32(geometry.totalLinearFeet - gateWidthTotal), 0);

  const postCounts = computePostCounts(geometry, gates, run.postSpacingFt, netFt);

  let entries: QtyEntry[] = [];
  switch (run.fenceType) {
    case "VINYL":
    case "ALUMINUM":
    case "ORNAMENTAL_IRON":
      entries = entries.concat(panelBasedEntries(run, netFt, postCounts));
      break;
    case "WOOD":
    case "COMPOSITE":
      entries = entries.concat(picketAndRailEntries(run, netFt, postCounts));
      break;
    case "CHAIN_LINK":
      entries = entries.concat(chainLinkEntries(run, netFt, postCounts));
      break;
    case "SPLIT_RAIL":
      entries = entries.concat(splitRailEntries(run, netFt, postCounts));
      break;
    case "UNIVERSAL":
      break;
  }

  // Gate posts are left out here and paid for by the gate itself.
  //
  // They were counted in both places: totalPosts includes the two posts
  // per gate, and the gate area then added its own bags for the same two
  // holes. Every gate on every job carried a double charge for concrete.
  const nonGatePosts = coerceAtLeast(postCounts.totalPosts - postCounts.gatePosts, 0);
  entries.push(qty("CONCRETE_BAG", nonGatePosts * run.concreteBagsPerPost));

  for (const gate of gates) entries = entries.concat(gateEntries(run.fenceType, gate));

  const withWaste = applyWaste(entries, wastePercent);
  const kept = wholeBags(withWaste).filter((e) => !run.suppressedRoles.has(e.role));

  return {
    geometry,
    netLinearFeet: netFt,
    entries: kept,
    gates,
    gateWidthTotal,
    postCounts,
  };
}

/**
 * Footage either comes from the drawing or is typed in. Typed-in footage
 * wins outright, which is what lets a run be quoted with no drawing and no
 * calibration -- corners are taken from the run's own count instead of being
 * measured off vertices that don't exist.
 */
export function resolveGeometry(run: FenceRun, pixelsPerFoot: number): FenceGeometryResult {
  const manual = run.manualLinearFeet;
  if (manual !== null && manual > 0) {
    return {
      totalLinearFeet: manual,
      segments: [],
      vertices: [],
      cornerCount: coerceAtLeast(run.manualCornerCount, 0),
      // A closed loop has no loose ends; an open run has two.
      endCount: run.closedLoop ? 0 : 2,
      lineVertexCount: 0,
    };
  }
  return analyze(decodePoints(run.pointsEncoded), pixelsPerFoot, run.closedLoop);
}

/**
 * Concrete, rounded up to bags you can actually buy.
 *
 * The yard sells a 60lb bag whole. A takeoff asking for 2.5 bags cannot be
 * ordered and cannot be priced honestly -- and it happened on every job
 * with no waste allowance set, because applyWaste returns early at 0%
 * and nothing else rounded.
 *
 * Summed BEFORE rounding, deliberately. Rounding each entry on its own
 * turns a 1.2-bag run and a 1.3-bag gate into four bags instead of three,
 * and that error repeats on every gate of every job.
 */
function wholeBags(entries: QtyEntry[]): QtyEntry[] {
  const total = doubleSum(entries.filter((e) => e.role === "CONCRETE_BAG").map((e) => e.quantity));
  if (total <= 0.0) return entries;
  return entries.filter((e) => e.role !== "CONCRETE_BAG").concat([qty("CONCRETE_BAG", Math.ceil(total))]);
}

function applyWaste(entries: QtyEntry[], wastePercent: number): QtyEntry[] {
  if (wastePercent <= 0.0) return entries;
  const factor = 1.0 + wastePercent / 100.0;
  return entries.map((entry) => {
    if (!WASTE_ROLES.has(entry.role)) return entry;
    // Concrete is rounded once, after every entry has been summed
    // -- that is wholeBags' whole point. Rounding it here as
    // well rounded it twice, so a 1.2-bag run and a 1.3-bag gate
    // came to four bags instead of three, on every gated job.
    if (entry.role === "CONCRETE_BAG") return { ...entry, quantity: entry.quantity * factor };
    return { ...entry, quantity: Math.ceil(entry.quantity * factor) };
  });
}

export function computePostCounts(
  geometry: FenceGeometryResult,
  gates: readonly GateMarker[],
  postSpacingFt: number,
  netFt: number,
): PostCounts {
  const gateCount = gates.length;
  const gatePosts = gateCount * 2;
  const cornerPosts = geometry.cornerCount;
  const endPosts = geometry.endCount;

  // A closed loop needs no closing post -- the last bay lands back on the
  // first one -- so only an open run gets the extra post on the end.
  const bays = postSpacingFt > 0 ? ceilRoundToInt(f32(netFt / postSpacingFt)) : 0;
  // Each gate splits the fence, and the two posts either side of the
  // opening ARE posts of that fence line -- they are not extra. Counting
  // the line as unbroken and then adding two posts per gate on top
  // bought one surplus post, one cap and a bag of concrete for every
  // gate on every job, which then rode back to the yard.
  //
  // Take one out of the run-length estimate per gate; gatePosts adds the
  // pair back below.
  const standardPostEstimate =
    bays === 0 ? 0
    : endPosts === 0 ? coerceAtLeast(bays - gateCount, 0)
    : coerceAtLeast(bays + 1 - gateCount, 0);

  // Gate posts are NOT subtracted here: the gate openings were already
  // taken out of netFt, so those posts sit outside this count. Subtracting
  // them was wiping out the line posts on short runs.
  const linePosts = coerceAtLeast(standardPostEstimate - cornerPosts - endPosts, 0);
  const totalPosts = linePosts + cornerPosts + endPosts + gatePosts;

  return {
    linePosts,
    cornerPosts,
    endPosts,
    gatePosts,
    terminalPosts: cornerPosts + endPosts + gatePosts,
    totalPosts,
  };
}

/** Vinyl, aluminum, ornamental iron: fence built from discrete panels. */
function panelBasedEntries(run: FenceRun, netFt: number, posts: PostCounts): QtyEntry[] {
  const panelCount = run.panelWidthFt > 0 ? ceilRoundToInt(f32(netFt / run.panelWidthFt)) : 0;
  return [
    qty("PANEL", panelCount, run.panelWidthFt, netFt),
    qty("LINE_POST", posts.linePosts),
    qty("CORNER_POST", posts.cornerPosts),
    qty("END_POST", posts.endPosts),
    qty("POST_CAP", posts.totalPosts),
  ];
}

/** Wood and composite: picket-and-rail construction between posts. */
function picketAndRailEntries(run: FenceRun, netFt: number, posts: PostCounts): QtyEntry[] {
  const bays = run.postSpacingFt > 0 ? ceilRoundToInt(f32(netFt / run.postSpacingFt)) : 0;
  const railQty = bays * run.woodRailCount;
  const picketPitchIn = coerceAtLeast(f32(run.picketWidthIn + run.picketGapIn), 0.5);
  const picketQty = ceilRoundToInt(f32(f32(netFt * 12) / picketPitchIn));
  return [
    qty("WOOD_PICKET", picketQty),
    qty("WOOD_RAIL", railQty),
    qty("LINE_POST", posts.linePosts),
    qty("CORNER_POST", posts.cornerPosts),
    qty("END_POST", posts.endPosts),
    qty("POST_CAP", posts.totalPosts),
  ];
}

/** Split-rail: just rails between posts, no pickets or caps. */
function splitRailEntries(run: FenceRun, netFt: number, posts: PostCounts): QtyEntry[] {
  const bays = run.postSpacingFt > 0 ? ceilRoundToInt(f32(netFt / run.postSpacingFt)) : 0;
  const railQty = bays * run.splitRailCount;
  return [
    qty("WOOD_RAIL", railQty),
    qty("LINE_POST", posts.linePosts),
    qty("CORNER_POST", posts.cornerPosts),
    qty("END_POST", posts.endPosts),
  ];
}

function chainLinkEntries(run: FenceRun, netFt: number, posts: PostCounts): QtyEntry[] {
  const bandsPerTerminalPost = coerceAtLeast(ceilRoundToInt(run.fabricHeightFt), 1);
  const entries: QtyEntry[] = [
    qty("CHAIN_FABRIC", netFt, run.fabricHeightFt),
    qty("LINE_POST", posts.linePosts),
    qty("CORNER_POST", posts.cornerPosts),
    qty("END_POST", posts.endPosts),
    qty("POST_CAP", posts.totalPosts),
    qty("TENSION_BAND", posts.terminalPosts * bandsPerTerminalPost),
    qty("BRACE_BAND", posts.terminalPosts),
  ];
  if (run.includeTopRail) {
    entries.push(qty("TOP_RAIL", netFt));
    entries.push(qty("RAIL_END", posts.terminalPosts));
  }
  if (run.includeTensionWire) entries.push(qty("TENSION_WIRE", netFt));
  if (run.includeBarbedWireArms) entries.push(qty("BARBED_WIRE_ARM", posts.terminalPosts));
  if (run.includePrivacySlats) entries.push(qty("PRIVACY_SLAT", netFt));
  return entries;
}

/**
 * Every gate gets its hinges, latch, handle, and brace regardless of fence
 * type -- forgetting one of those is what sends a crew back to the supply
 * house mid-install. Anything the contractor doesn't want is removed on the
 * estimate and stays removed (see FenceRun.suppressedRoles).
 */
function gateEntries(fenceType: FenceType, gate: GateMarker): QtyEntry[] {
  const panelRole: MaterialRole = FRAME_KIT_GATE_TYPES.has(fenceType) ? "GATE_FRAME_KIT" : "GATE_PANEL";
  const entries: QtyEntry[] = [qty(panelRole, 1.0, gate.widthFt)];
  entries.push(qty("HINGE_SET", 1.0));
  entries.push(qty("LATCH", 1.0));
  entries.push(qty("HANDLE", 1.0));
  entries.push(qty("BRACE", 1.0));
  // A wide gate sags without a second brace and a heavier hinge set.
  if (gate.widthFt >= 8) {
    entries.push(qty("BRACE", 1.0));
    entries.push(qty("HINGE_SET", 1.0));
  }
  if (fenceType === "VINYL") {
    entries.push(qty("TRIM", 4.0));
  }
  return entries.concat(gateAreaEntries(gate));
}

/**
 * What the gate area itself is built from, which depends on where the gate
 * hangs rather than on the fence type.
 *
 * Every gate takes one econo stiffener. After that the three cases are
 * genuinely different builds, and treating them alike is a truck going back
 * to the yard:
 *
 *  - **On the wall**: the hinge side bolts through a blank post. Four 5/8"
 *    holes are drilled through the stiffener into that post, so it needs
 *    plugs to close them. Nothing is set in the ground, so **no concrete** --
 *    this is the case the old code got most wrong, since it charged concrete
 *    for every gate regardless. Takes a blank post plus an end post.
 *  - **In the line**: an end post, set in concrete -- two bags.
 *  - **In the line with the fence carrying on to a wall**: the run
 *    terminates twice, so two end posts, still in concrete.
 *
 * Gate posts are counted separately by computePostCounts; these are the
 * posts the gate area needs on top of that.
 */
function gateAreaEntries(gate: GateMarker): QtyEntry[] {
  const entries: QtyEntry[] = [qty("STIFFENER", 1.0)];
  switch (gate.mounting) {
    case "WALL":
      entries.push(qty("BLANK_POST", 1.0));
      entries.push(qty("END_POST", 1.0));
      entries.push(qty("HOLE_PLUG", WALL_MOUNT_HOLES));
      // The hinge side is bolted to the wall and set in nothing. The
      // latch side is still a post in a hole and still takes its bag.
      entries.push(qty("CONCRETE_BAG", GATE_LATCH_BAGS));
      break;
    case "LINE":
      // Two end posts: the hinge side wears the stiffener and
      // becomes the post the gate hangs from, the other is where it
      // latches. There is no separate "gate post" part -- the yard
      // sells end posts, and that is what gets set.
      entries.push(qty("END_POST", 2.0));
      entries.push(qty("CONCRETE_BAG", GATE_HINGE_BAGS + GATE_LATCH_BAGS));
      break;
    case "LINE_TO_WALL":
      // The gate's own two end posts, plus the one where the rest of
      // the run terminates at the wall. (The phone counts three end
      // posts and three posts' worth of concrete here; the takeoff's
      // gatePosts still adds only two. Replicated, not corrected.)
      entries.push(qty("END_POST", 3.0));
      entries.push(qty("CONCRETE_BAG", GATE_HINGE_BAGS + GATE_LATCH_BAGS + GATE_LATCH_BAGS));
      break;
  }
  return entries;
}
