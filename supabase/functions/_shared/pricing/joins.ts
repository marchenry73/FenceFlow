/**
 * JOINED RUNS: the post arithmetic where the owner has attached one side of a
 * fence to another, and the reader that decides a stored joint id is usable.
 *
 * This is the server port of `RunJoinArithmetic` in
 * app/src/main/java/com/fenceestimator/app/geometry/FenceGeometry.kt. The
 * Kotlin is the shipped original and this file is a LINE-FOR-LINE
 * transcription of it: same order of operations, same sort order, same
 * Float discipline (`f32`), same early return when no run carries a joint.
 * tests/a33-join-arithmetic-posts.test.mjs holds a third copy of the same
 * arithmetic against a frozen snapshot of the COMPILED Kotlin's output, and
 * tests/a61-corner-post-pricing.test.mjs runs THIS file against that same
 * transcription over every scenario the a33 file registers -- so the two
 * ports cannot drift without a test going red.
 *
 * WHAT A JOINT IS. An explicit fact the owner creates by tapping the end of
 * one side onto the end of another. It is never inferred from coordinates:
 * two points on identical coordinates are not evidence, because the other
 * fence may be a neighbour's. `fence_runs.start_joint` and
 * `fence_runs.end_joint` hold the joint's uuid (text, NOT NULL, '' for a free
 * end -- supabase_a32_join_runs.sql). Coordinates are read for exactly one
 * thing, in `turnDegrees`: how sharply a two-run join turns, which decides
 * line post or corner post.
 *
 * WHAT COMES OFF AT A JOINT. Every open run's post estimate is bays + 1
 * positions, one at each end, so two runs that meet count the shared position
 * twice. A joint where `degree` run ends meet is ONE post in the ground:
 *
 *     before   degree end posts, one per member
 *     after    1 post, of the joint's kind (CORNER or LINE)
 *     owner    its end post becomes that post:  end -1, corner (or line) +1
 *     others   each gives its end post up:      end -1
 *
 * so the job's end posts fall by `degree`, its corner (or line) posts rise by
 * one, and its TOTAL post count falls by `degree - 1`. Because
 * `computePostCounts` prices POST_CAP off `totalPosts` and CONCRETE_BAG off
 * `totalPosts - gatePosts`, the cap and the concrete for the post that is no
 * longer in the ground come off with it, in one place, automatically. Gate
 * posts are never touched: a join does not move a gate.
 *
 * ZERO JOINTS IS TODAY'S PRICE, TO THE CENT. No run carries a joint id:
 * `adjustJoins` finds no joint and returns `NO_JOIN_ADJUSTMENT` before any
 * geometry is read, every run gets a zero delta, and `applyJoinAdjustment` is
 * never reached. That is the additivity guarantee every quote already sent
 * depends on, and a61 asserts it rather than implying it.
 */
import { f32 } from "./f32.ts";
import { CORNER_ANGLE_THRESHOLD_DEGREES } from "./geometry.ts";
import type { FenceGeometryResult, FencePoint } from "./geometry.ts";
import type { PostCounts } from "./takeoff.ts";
import type { FenceRun } from "./types.ts";

/**
 * java.lang.Math.toDegrees since JDK 9: `angrad * RADIANS_TO_DEGREES`, not
 * `angrad * 180 / PI`. The two can differ by an ulp. geometry.ts pins the
 * same constant for the same reason.
 */
const RADIANS_TO_DEGREES = 57.29577951308232;

/**
 * What stands in the ground where runs meet. CORNER takes a pull from more
 * than one direction, LINE is a post the fence passes straight through. They
 * are separate catalog rows at separate prices, which is the whole reason the
 * kind matters: the COUNT is the same either way.
 */
export type JoinPostKind = "LINE" | "CORNER";

/** Why a joint was left out. An ignored joint changes nothing: today's price stands. */
export type JoinIgnoredReason = "FEWER_THAN_TWO_LIVE_RUNS" | "SAME_RUN_TWICE";

/**
 * One run, reduced to exactly what the arithmetic reads. The Kotlin's
 * `JoinableRun`.
 *
 * `geometry` must be the SAME geometry the run's posts are counted from
 * (`resolveGeometry`): a typed-footage run arrives with no vertices, a closed
 * run with no ends. The arithmetic trusts it and does not re-measure.
 * `heightFt` is the run's fence height (`panel_height_ft`); the taller run is
 * billed the shared post, because that is the post that has to be built.
 */
export interface JoinableRun {
  id: string;
  geometry: FenceGeometryResult;
  /** Float. */
  heightFt: number;
  sortOrder: number;
  isTeardown: boolean;
  /** The joint at this run's FIRST point, or '' for a free end. Already validated by `readJointId`. */
  startJointId: string;
  /** The joint at this run's LAST point, or '' for a free end. */
  endJointId: string;
}

/**
 * How one run's own post counts move because of the joints it takes part in.
 *
 * DELTAS, added to the counts the run already has AFTER `computePostCounts`
 * has finished, never fed into it: `computePostCounts` carves its corner and
 * end posts out of one fixed estimate and gives whatever is left to line
 * posts, so moving the end count BEFORE it runs hands the same number
 * straight back as line posts and the total does not move at all.
 */
export interface RunPostAdjustment {
  linePostsDelta: number;
  cornerPostsDelta: number;
  endPostsDelta: number;
}

/** One shared post: where it is, what kind it is, and which run is billed for it. */
export interface JoinedPost {
  jointId: string;
  kind: JoinPostKind;
  /** The run whose own end post BECOMES the shared post. Every other member gives its end post up. */
  ownerRunId: string;
  /** Every run that meets here, owner included, sorted by run id. */
  memberRunIds: string[];
}

export interface IgnoredJoint {
  jointId: string;
  reason: JoinIgnoredReason;
}

/** The whole job's answer. The Kotlin's `JoinAdjustment`. */
export interface JoinAdjustment {
  /** ONLY the runs whose counts move. Empty means nothing moves anywhere. */
  perRun: ReadonlyMap<string, RunPostAdjustment>;
  posts: readonly JoinedPost[];
  ignored: readonly IgnoredJoint[];
}

const ZERO: RunPostAdjustment = { linePostsDelta: 0, cornerPostsDelta: 0, endPostsDelta: 0 };

/** The answer for a job with no joint anywhere: the Kotlin's `JoinAdjustment.NONE`. */
export const NO_JOIN_ADJUSTMENT: JoinAdjustment = { perRun: new Map(), posts: [], ignored: [] };

/** The adjustment for one run; a run no joint touches gets a zero one. */
export function adjustmentForRun(adjustment: JoinAdjustment, runId: string): RunPostAdjustment {
  return adjustment.perRun.get(runId) ?? ZERO;
}

/** True when no run's posts move at all. */
export function changesNothing(adjustment: JoinAdjustment): boolean {
  return adjustment.perRun.size === 0;
}

/** Posts the job no longer builds, summed over every run. Zero when nothing is joined. */
export function postsSaved(adjustment: JoinAdjustment): number {
  let saved = 0;
  for (const a of adjustment.perRun.values()) saved -= a.linePostsDelta + a.cornerPostsDelta + a.endPostsDelta;
  return saved;
}

// ---------------------------------------------------------------------------
// VALIDATE ON READ. Bad data falls back to today's HIGHER post count, never
// to a cheaper one.
// ---------------------------------------------------------------------------

/**
 * The 8-4-4-4-12 hex form `UUID.randomUUID().toString()` produces, which is
 * what SurveyViewModel writes into the column. Case-insensitive, because
 * Postgres stores the text exactly as it arrives and a hand-written row may
 * be upper case.
 */
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A stored joint id as the engine should read it: the id itself, or '' for
 * "not joined".
 *
 * `fence_runs.start_joint` / `end_joint` carry no CHECK constraint, on
 * purpose -- upserts to fence_runs are batched and one row the table refuses
 * fails the whole batch, so no run of that company would sync at all
 * (supabase_a32_join_runs.sql, "WHY NO CHECK CONSTRAINT"). The readers
 * validate instead. Anything that is not a uuid reads as not joined, which
 * is today's price: two free ends, two end posts, two caps, two bags.
 *
 * Absent and null are also '': the column is missing from the select until
 * `JOIN_COLUMNS_LIVE` is flipped in price-job/index.ts, and the quiet failure
 * mode of that has to be the old, dearer answer.
 */
export function readJointId(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  return UUID_TEXT.test(trimmed) ? trimmed : "";
}

/**
 * The height that decides WHICH RUN IS BILLED the shared post: the taller
 * post is the one that has to be built, and a taller post can carry a shorter
 * panel but not the reverse (docs/JOINING_RUNS.md 2.4, Q1).
 *
 * NOT simply `panelHeightFt`: chain link keeps its height in `fabricHeightFt`
 * and split rail declares none. A different question from the one
 * `buildLineItems` asks when it picks a catalog row -- that reads
 * panelHeightFt even on a chain-link run, deliberately, because no chain-link
 * post row declares a height. This one is "which post is taller in the
 * ground".
 *
 * THE SAME RULE IS WRITTEN IN THREE PLACES and must stay identical, or the
 * attach gesture, the phone's price and the office's price can name three
 * different owners for one post: here, `EstimateEngine.joinHeightOf` (the
 * phone's engine) and `SurveyViewModel.joinHeightOf` (the gesture).
 * tests/a61-corner-post-pricing.test.mjs reads all three and fails if any one
 * of them drops a branch.
 */
export function joinHeightFt(run: FenceRun): number {
  if (run.fenceType === "CHAIN_LINK") return run.fabricHeightFt;
  if (run.fenceType === "SPLIT_RAIL") return 0;
  return run.panelHeightFt;
}

// ---------------------------------------------------------------------------
// The arithmetic. A transcription of RunJoinArithmetic; see the header.
// ---------------------------------------------------------------------------

/** One end of one run that carries a joint id. The Kotlin's private `JoinMember`. */
interface JoinMember {
  run: JoinableRun;
  atEnd: boolean;
}

/**
 * A run can give up an end post only if it has free ends to give: not the old
 * fence, and open with something measurable. An open run's geometry always
 * has exactly two ends; a closed run, an unmeasurable run and a run with no
 * drawing and no typed footage have none.
 */
function isLive(run: JoinableRun): boolean {
  return !run.isTeardown && run.geometry.endCount >= 2;
}

/** The point at this end of the run and the point next to it, or null when there is no drawing. */
function endAndNeighbour(member: JoinMember): [FencePoint, FencePoint] | null {
  const v = member.run.geometry.vertices;
  if (v.length < 2) return null;
  return member.atEnd ? [v[v.length - 1].point, v[v.length - 2].point] : [v[0].point, v[1].point];
}

/**
 * How far the fence turns where two runs meet: 0 is straight on, 90 a square
 * corner. Measured exactly as `analyze` measures a bend inside one run, using
 * the direction INTO the joint along the first run and OUT of it along the
 * second, so it does not matter which end of either run was drawn first. Null
 * when there is nothing to measure.
 */
function turnDegrees(first: JoinMember, second: JoinMember): number | null {
  const a = endAndNeighbour(first);
  if (a === null) return null;
  const b = endAndNeighbour(second);
  if (b === null) return null;
  const [aEnd, aNext] = a;
  const [bEnd, bNext] = b;
  // A side with no length has no heading.
  if (aEnd.x === aNext.x && aEnd.y === aNext.y) return null;
  if (bEnd.x === bNext.x && bEnd.y === bNext.y) return null;

  const angleIn = Math.atan2(f32(aEnd.y - aNext.y), f32(aEnd.x - aNext.x));
  const angleOut = Math.atan2(f32(bNext.y - bEnd.y), f32(bNext.x - bEnd.x));
  let turnRad = angleOut - angleIn;
  while (turnRad > Math.PI) turnRad -= 2 * Math.PI;
  while (turnRad < -Math.PI) turnRad += 2 * Math.PI;
  const turnDeg = f32(Math.abs(turnRad) * RADIANS_TO_DEGREES);
  if (!Number.isFinite(turnDeg)) return null;
  return turnDeg;
}

/** Taller first, then lower sort order, then lower id. */
/**
 * Who owns the post where runs meet: the SHORTER side owns the shared post where the heights differ.
 * A post has to be tall enough for the tallest panel on it, so "shorter
 * wins" is only ever reached at a height CHANGE -- and there the fence
 * steps DOWN onto the short post rather than leaving a tall one standing
 * proud of the low side. Equal heights never reach it, and fall through to
 * sort order and then id, which is what keeps the answer independent of
 * list order.
 *
 * The twin of outranks() in FenceGeometry.kt. Both or neither: a difference
 * here is the office and the phone billing a different post for one hole.
 */
function outranks(a: JoinableRun, b: JoinableRun): boolean {
  if (a.heightFt !== b.heightFt) return a.heightFt < b.heightFt;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder < b.sortOrder;
  return a.id < b.id;
}

function ownerOf(live: readonly JoinMember[]): JoinMember {
  let best = live[0];
  for (let i = 1; i < live.length; i++) {
    if (outranks(live[i].run, best.run)) best = live[i];
  }
  return best;
}

/**
 * Two runs: the same rule a bend inside one run already follows, so joining
 * two runs prices exactly as drawing them as one polyline does. A run with no
 * drawing (typed footage) has no angle to read and counts as a corner.
 *
 * Three or more runs: ALWAYS a corner. A post that several runs leave from is
 * not a pass-through however the angles fall, and calling a T a line post
 * because two of its legs happen to be collinear would put the lightest post
 * on the job under the heaviest load.
 */
function kindOf(live: readonly JoinMember[]): JoinPostKind {
  if (live.length >= 3) return "CORNER";
  // The two ends in a fixed order, so the answer cannot depend on list order.
  const firstIsZero = live[0].run.id < live[1].run.id;
  const first = firstIsZero ? live[0] : live[1];
  const second = firstIsZero ? live[1] : live[0];
  const turn = turnDegrees(first, second);
  if (turn === null) return "CORNER";
  return turn >= CORNER_ANGLE_THRESHOLD_DEGREES ? "CORNER" : "LINE";
}

function hasSameRunTwice(live: readonly JoinMember[]): boolean {
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      if (live[i].run.id === live[j].run.id) return true;
    }
  }
  return false;
}

/**
 * @param runs EVERY run of the job. The owner of a shared post is chosen
 *   ACROSS runs, so a caller that passes a subset gets a different owner and
 *   bills the post to the wrong run's catalog.
 */
export function adjustJoins(runs: readonly JoinableRun[]): JoinAdjustment {
  const byJoint = new Map<string, JoinMember[]>();
  const add = (jointId: string, run: JoinableRun, atEnd: boolean): void => {
    // Kotlin: isNotBlank(). Null and undefined cannot occur in the Kotlin
    // (the field is a non-null String) but can arrive here from a hand-built
    // object in a test or an older caller, and "no id" is the right reading
    // of them -- it is the dearer one.
    if (jointId === null || jointId === undefined || jointId.trim() === "") return;
    const list = byJoint.get(jointId);
    if (list === undefined) byJoint.set(jointId, [{ run, atEnd }]);
    else list.push({ run, atEnd });
  };
  for (const run of runs) {
    add(run.startJointId, run, false);
    add(run.endJointId, run, true);
  }
  // Zero joints: nothing to look at, nothing moves.
  if (byJoint.size === 0) return NO_JOIN_ADJUSTMENT;

  const deltas = new Map<string, [number, number, number]>();
  const bump = (runId: string, line: number, corner: number, end: number): void => {
    const cell = deltas.get(runId) ?? [0, 0, 0];
    cell[0] += line;
    cell[1] += corner;
    cell[2] += end;
    deltas.set(runId, cell);
  };
  const posts: JoinedPost[] = [];
  const ignored: IgnoredJoint[] = [];

  for (const jointId of [...byJoint.keys()].sort()) {
    const members = byJoint.get(jointId) as JoinMember[];
    const live = members.filter((m) => isLive(m.run));

    if (live.length < 2) {
      ignored.push({ jointId, reason: "FEWER_THAN_TWO_LIVE_RUNS" });
      continue;
    }
    if (hasSameRunTwice(live)) {
      ignored.push({ jointId, reason: "SAME_RUN_TWICE" });
      continue;
    }

    const owner = ownerOf(live);
    const kind = kindOf(live);
    for (const member of live) {
      if (member === owner) {
        if (kind === "CORNER") bump(member.run.id, 0, 1, -1);
        else bump(member.run.id, 1, 0, -1);
      } else {
        bump(member.run.id, 0, 0, -1);
      }
    }
    posts.push({ jointId, kind, ownerRunId: owner.run.id, memberRunIds: live.map((m) => m.run.id).sort() });
  }

  const perRun = new Map<string, RunPostAdjustment>();
  for (const runId of [...deltas.keys()].sort()) {
    const [line, corner, end] = deltas.get(runId) as [number, number, number];
    if (line !== 0 || corner !== 0 || end !== 0) {
      perRun.set(runId, { linePostsDelta: line, cornerPostsDelta: corner, endPostsDelta: end });
    }
  }
  return { perRun, posts, ignored };
}

/**
 * The Kotlin's `RunPostTally.adjustedBy`: the deltas added to the counts
 * `computePostCounts` has already finished working out.
 *
 * `gatePosts` is carried through untouched, and `terminalPosts` and
 * `totalPosts` are re-derived from the moved figures -- which is what takes
 * the shared post's CAP (priced off `totalPosts`), its CONCRETE (priced off
 * `totalPosts - gatePosts`) and, on chain link, its tension bands, brace
 * band and rail end (priced off `terminalPosts`) off with it.
 *
 * DELIBERATELY NOT CLAMPED AT ZERO, because the Kotlin `adjustedBy` is not
 * either and a clamp that fires on one engine and not the other is a price
 * disagreement. It cannot fire: a run only ever appears at a joint when
 * `isLive` says `geometry.endCount >= 2`, `endPosts` IS that end count, and a
 * run has two ends, so the most any run can give up is the two it has.
 * tests/a61-corner-post-pricing.test.mjs asserts no count goes negative over
 * every scenario, and a33's 6f does the same over 60 random jobs.
 */
export function applyJoinAdjustment(base: PostCounts, adjustment: RunPostAdjustment): PostCounts {
  const linePosts = base.linePosts + adjustment.linePostsDelta;
  const cornerPosts = base.cornerPosts + adjustment.cornerPostsDelta;
  const endPosts = base.endPosts + adjustment.endPostsDelta;
  return {
    linePosts,
    cornerPosts,
    endPosts,
    gatePosts: base.gatePosts,
    terminalPosts: cornerPosts + endPosts + base.gatePosts,
    totalPosts: linePosts + cornerPosts + endPosts + base.gatePosts,
  };
}
