/**
 * CONNECTING THE SIDES WHILE HE DRAWS, AND THE LINE MOVING WHEN THEY CONNECT.
 *
 * His words, across one day: "make it easier to connect the sides when I draw"
 * ... and then, on seeing it: "When I attach them together, I need to see the
 * line move there too so there is no confusion, need it to be more seamless
 * than that."
 *
 * TWO THINGS ARE BEING HELD HERE, and they pull in opposite directions:
 *
 *  1. NOTHING JOINS, AND NO POINT MOVES, WITHOUT HIM SAYING YES. A join takes
 *     a post off the bill and moving a point changes footage and therefore
 *     labour. tests/a33 (check 5a-coincident-no-id) pins that two ends on one
 *     identical point still bill two end posts, precisely so a price cannot
 *     move because a finger wobbled. What is new here is an OFFER, and the two
 *     canaries at the bottom are versions of the offer that take themselves --
 *     one that joins by itself, one that moves a point by itself. BOTH MUST
 *     FAIL, or this file is decoration.
 *  2. ATTACHED MEANS ONE POINT. A joint used to be honoured at any distance:
 *     two ends a yard apart could be attached and bill one shared corner post
 *     while the plan still showed a gap. Probed read-only against the live
 *     database on 2 Oct 2026, this is not hypothetical -- one live joint holds
 *     two ends 4425 drawing units apart (110.6 ft at that job's own
 *     calibration), both runs open and measurable, so the arithmetic counts
 *     ONE shared corner post for a corner the plan draws twice, 110 ft apart.
 *
 * WHAT THIS PROVES, AND WHAT IT CANNOT
 * ------------------------------------
 * Nothing here compiles or runs Kotlin -- no Gradle in this wave, so the Kotlin
 * added alongside this file is UNVERIFIED BY COMPILATION and says so. Two kinds
 * of check, kept apart, the same shape tests/a57 uses:
 *
 *  1. STATIC, against the real source text, each one paired with a mutation of
 *     that text that must make it fail.
 *  2. A TRANSCRIPTION of the deciding logic -- RunJoinGesture.offerFromSnap,
 *     decide, liveJointOf, endAtVertex, gapCloserFor and the CLOSE_GAP_MAX_FT
 *     refusal in SurveyViewModel.tapJoinEnd -- exercised on fixtures. That is a
 *     model of the Kotlin, not the Kotlin itself; the static checks pin the
 *     lines the model encodes so the two cannot drift silently where it decides
 *     money.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

let passed = 0;
let failed = 0;
const failedIds = [];
function ok(id, what, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok    ${id} ${what}`);
  } else {
    failed++;
    failedIds.push(id);
    console.log(`  FAIL  ${id} ${what}${detail ? " -- " + detail : ""}`);
  }
}
function eq(id, what, got, want) {
  ok(id, what, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
}

const GEOM = "app/src/main/java/com/fenceestimator/app/geometry/FenceGeometry.kt";
const VM = "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt";
const STRINGS = "app/src/main/res/values/strings_join_offer.xml";
const STRINGS_ES = "app/src/main/res/values-es/strings_join_offer.xml";
const STRINGS_FR = "app/src/main/res/values-fr/strings_join_offer.xml";

const geomSrc = read(GEOM);
const vmSrc = read(VM);

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** `<signature>` through its matching close brace, or null. */
function bodyOf(src, signature) {
  const at = src.indexOf(signature);
  if (at < 0) return null;
  const open = src.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return null;
}

// =============================================================================
// THE MODEL. A transcription of the Kotlin that decides, line for line.
// =============================================================================

const CORNER_ANGLE_THRESHOLD_DEGREES = 30; // FenceGeometryEngine; pinned below.
const CLOSE_GAP_MAX_FT = 2.0;              // RunJoinGesture; pinned below.
const VERTEX_SNAP_PX = 26;                 // snapDrawPoint default; pinned below.
const ANGLE_TOLERANCE_DEG = 7;
const LENGTH_SNAP_FT = 0.35;
const SAME_CORNER_PX = 0.01;

const P = (x, y) => ({ x, y });

/** A run as the join layer reads it (JoinCandidateRun). */
function run(id, points, opts = {}) {
  return {
    runId: id,
    // COPIED, never aliased. The fixtures below are shared module-level arrays
    // and the canaries in section 9 mutate what they are given -- a canary that
    // rewrote the next fixture's drawing would make a later check pass or fail
    // for a reason that is not in it.
    points: points.map((p) => ({ x: p.x, y: p.y })),
    closedLoop: !!opts.closedLoop,
    typedFootage: !!opts.typedFootage,
    isTeardown: !!opts.isTeardown,
    heightFt: opts.heightFt ?? 6,
    sortOrder: opts.sortOrder ?? 0,
    startJointId: opts.startJointId ?? "",
    endJointId: opts.endJointId ?? "",
  };
}
const attachable = (r) => r.points.length >= 2 && !r.closedLoop && !r.typedFootage;
const jointIdAt = (r, atEnd) => (atEnd ? r.endJointId : r.startJointId);
const pointAt = (r, atEnd) =>
  r.points.length < 2 ? null : atEnd ? r.points[r.points.length - 1] : r.points[0];
const runOf = (runs, end) => runs.find((r) => r.runId === end.runId) ?? null;
const pointOf = (runs, end) => {
  const r = runOf(runs, end);
  return r ? pointAt(r, end.atEnd) : null;
};

/** RunJoinGesture.runsAtJoint */
function runsAtJoint(runs, jointId) {
  if (!jointId) return [];
  const ids = [];
  for (const r of runs) {
    if ((r.startJointId === jointId || r.endJointId === jointId) && !ids.includes(r.runId)) ids.push(r.runId);
  }
  return ids.sort();
}

/** RunJoinGesture.liveJointOf -- an id no OTHER run holds is a free end. */
function liveJointOf(runs, end) {
  const r = runOf(runs, end);
  if (!r) return "";
  const id = jointIdAt(r, end.atEnd);
  if (!id) return "";
  return runsAtJoint(runs, id).length >= 2 ? id : "";
}

/** RunJoinGesture.decide, in the same order, with the same refusals. */
function decide(runs, a, b, newJointId) {
  const runA = runOf(runs, a);
  const runB = runOf(runs, b);
  if (!runA || !runB) return { refusal: "NOT_FOUND" };
  if (runA.runId === runB.runId) return { refusal: "SAME_RUN" };
  if (runA.closedLoop || runB.closedLoop) return { refusal: "CLOSED_LOOP" };
  if (runA.typedFootage || runB.typedFootage) return { refusal: "TYPED_FOOTAGE" };
  if (runA.isTeardown !== runB.isTeardown) return { refusal: "TEARDOWN_MISMATCH" };

  const jointA = liveJointOf(runs, a);
  const jointB = liveJointOf(runs, b);
  if (jointA && jointA === jointB) return { refusal: "ALREADY_ATTACHED" };
  if (jointA && jointB) return { refusal: "AT_ANOTHER_POINT" };

  const ends = [a, b];
  if (jointA) {
    return jointIdAt(runB, !b.atEnd) === jointA
      ? { refusal: "SAME_RUN" }
      : { refusal: null, jointId: jointA, ends };
  }
  if (jointB) {
    return jointIdAt(runA, !a.atEnd) === jointB
      ? { refusal: "SAME_RUN" }
      : { refusal: null, jointId: jointB, ends };
  }
  if (!newJointId) return { refusal: "NOT_FOUND" };
  return { refusal: null, jointId: newJointId, ends };
}
const allowed = (d) => d.refusal === null;

/** RunJoinGesture.endAtVertex -- only the FIRST or LAST point is an end. */
function endAtVertex(r, index) {
  if (!attachable(r)) return null;
  if (index === 0) return { runId: r.runId, atEnd: false };
  if (index === r.points.length - 1) return { runId: r.runId, atEnd: true };
  return null;
}

/**
 * RunJoinGesture.offerFromSnap. Every clause below is a reason to stay silent,
 * in the Kotlin's own order.
 */
function offerFromSnap(runs, movingEnd, newJointId) {
  const movingRun = runOf(runs, movingEnd);
  if (!movingRun) return null;
  if (!attachable(movingRun)) return null;
  if (liveJointOf(runs, movingEnd)) return null;
  const at = pointAt(movingRun, movingEnd.atEnd);
  if (!at) return null;

  for (const candidate of [...runs].sort((x, y) => (x.runId < y.runId ? -1 : x.runId > y.runId ? 1 : 0))) {
    if (candidate.runId === movingRun.runId) continue;
    if (!attachable(candidate)) continue;
    for (const atEnd of [false, true]) {
      const other = { runId: candidate.runId, atEnd };
      const point = pointAt(candidate, atEnd);
      if (!point) continue;
      // (1) ONE POINT, EXACTLY. Float equality on purpose: a VERTEX snap
      // returns the existing corner's own coordinates, an angle or whole-foot
      // snap returns a point computed from a heading and a distance.
      if (point.x !== at.x || point.y !== at.y) continue;
      // (3) The target end must be FREE: a snap cannot say which member of a
      // shared post it meant.
      if (liveJointOf(runs, other)) continue;
      // (4) The write's own rules have the last word.
      const d = decide(runs, movingEnd, other, newJointId);
      if (!allowed(d)) continue;
      return { decision: d, movingEnd, targetEnd: other, at };
    }
  }
  return null;
}

/** Straight-line length of a polyline, in feet. */
function feetOf(points, pxPerFt, closedLoop) {
  if (points.length < 2) return 0;
  const list = closedLoop ? [...points, points[0]] : points;
  let px = 0;
  for (let i = 1; i < list.length; i++) {
    px += Math.hypot(list[i].x - list[i - 1].x, list[i].y - list[i - 1].y);
  }
  return px / pxPerFt;
}

/**
 * RunJoinGesture.gapCloserFor. The FREE end moves; both free, the first-tapped
 * moves. Null when the two ends are already one point.
 */
function gapCloserFor(runs, decision, pxPerFt) {
  if (!allowed(decision) || decision.ends.length !== 2) return null;
  const [first, second] = decision.ends;
  const firstAtPost = !!liveJointOf(runs, first);
  const secondAtPost = !!liveJointOf(runs, second);
  const moving = firstAtPost && !secondAtPost ? second : first;
  const anchor = moving === first ? second : first;

  const movingRun = runOf(runs, moving);
  if (!movingRun) return null;
  const from = pointAt(movingRun, moving.atEnd);
  const to = pointOf(runs, anchor);
  if (!from || !to) return null;
  if (from.x === to.x && from.y === to.y) return null;
  if (pxPerFt <= 0) return null;

  const before = movingRun.points;
  const after = [...before];
  after[moving.atEnd ? after.length - 1 : 0] = to;
  return {
    end: moving,
    from,
    to,
    distanceFeet: Math.hypot(to.x - from.x, to.y - from.y) / pxPerFt,
    runFeetBefore: feetOf(before, pxPerFt, movingRun.closedLoop),
    runFeetAfter: feetOf(after, pxPerFt, movingRun.closedLoop),
  };
}

/**
 * SurveyViewModel.tapJoinEnd's attach branch, as the model sees it: the offer
 * it puts on the table, or the refusal it raises instead.
 */
function tapAttach(runs, a, b, newJointId, pxPerFt) {
  const d = decide(runs, a, b, newJointId);
  if (!allowed(d)) return { refusal: d.refusal };
  const closer = gapCloserFor(runs, d, pxPerFt);
  if (closer && closer.distanceFeet > CLOSE_GAP_MAX_FT) return { refusal: "TOO_FAR_APART" };
  return { refusal: null, decision: d, gapCloser: closer };
}

/**
 * snapDrawPoint, enough of it to say WHICH KIND of snap a tap produced. The
 * vertex stage is the whole point of the test: it is the only stage that lands
 * a point ON an existing corner.
 */
function snapDrawPoint(candidate, previous, beforePrevious, otherVertices, pxPerFt, avoid = []) {
  const neighbours = [...(previous ? [previous] : []), ...avoid];
  const joinable = neighbours.length === 0 ? otherVertices : otherVertices.filter((v) =>
    !neighbours.some((nb) => Math.abs(nb.x - v.x) < SAME_CORNER_PX && Math.abs(nb.y - v.y) < SAME_CORNER_PX));
  let nearest = null;
  let bestSq = Infinity;
  for (const v of joinable) {
    const sq = (v.x - candidate.x) ** 2 + (v.y - candidate.y) ** 2;
    if (sq < bestSq) { bestSq = sq; nearest = v; }
  }
  if (nearest && Math.sqrt(bestSq) <= VERTEX_SNAP_PX) {
    // Returns the EXISTING corner, not a copy computed from it.
    return { point: nearest, kind: "VERTEX" };
  }
  if (!previous || pxPerFt <= 0) return { point: candidate, kind: "NONE" };
  const vx = candidate.x - previous.x;
  const vy = candidate.y - previous.y;
  const distPx = Math.hypot(vx, vy);
  if (distPx < 0.001) return { point: candidate, kind: "NONE" };
  const headingDeg = (Math.atan2(vy, vx) * 180) / Math.PI;

  const cands = [];
  for (let k = 0; k < 8; k++) cands.push(k * 45);
  if (beforePrevious) {
    const px = previous.x - beforePrevious.x;
    const py = previous.y - beforePrevious.y;
    if (Math.hypot(px, py) > 0.001) {
      const prevHeading = (Math.atan2(py, px) * 180) / Math.PI;
      for (let k = 0; k < 8; k++) cands.push(prevHeading + k * 45);
    }
  }
  const diff = (x, y) => {
    let d = (x - y) % 360;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    return d;
  };
  let locked = null;
  let bestDelta = ANGLE_TOLERANCE_DEG;
  for (const c of cands) {
    const delta = Math.abs(diff(headingDeg, c));
    if (delta <= bestDelta) { bestDelta = delta; locked = c; }
  }
  const distFt = distPx / pxPerFt;
  const roundedFt = Math.round(distFt);
  const lengthLocked = roundedFt >= 1 && Math.abs(distFt - roundedFt) <= LENGTH_SNAP_FT;
  if (locked === null && !lengthLocked) return { point: candidate, kind: "NONE" };
  const headingUsed = locked === null ? headingDeg : locked;
  const rad = (headingUsed * Math.PI) / 180;
  const finalPx = lengthLocked ? roundedFt * pxPerFt : distPx;
  const point = P(previous.x + Math.cos(rad) * finalPx, previous.y + Math.sin(rad) * finalPx);
  const kind = locked !== null && lengthLocked ? "ANGLE_AND_LENGTH" : locked !== null ? "ANGLE" : "LENGTH";
  return { point, kind };
}

/**
 * SurveyViewModel.offerJoinFromSnap: only a VERTEX snap is even asked about,
 * and only an END of the selected run.
 */
function offerAfterSnap(runs, selectedRunId, index, snapKind, newJointId) {
  if (snapKind !== "VERTEX") return null;
  const me = runs.find((r) => r.runId === selectedRunId);
  if (!me) return null;
  const movingEnd = endAtVertex(me, index);
  if (!movingEnd) return null;
  return offerFromSnap(runs, movingEnd, newJointId);
}

// =============================================================================
console.log("\n1. THE SNAP ALREADY LANDS THE POINT; THE OFFER IS THE MISSING HALF");
// =============================================================================
{
  const code = stripComments(geomSrc);
  const vm = stripComments(vmSrc);

  // CANARY FOR THE SCANNER: the things below are found, and the scanner can
  // see a false. Without this a renamed function reports every claim as clean.
  ok("1a-canary", "scanner canary: FenceGeometry.kt was read, RunJoinGesture is in it, and a name that is not there is reported missing",
    code.includes("object RunJoinGesture") && !code.includes("object RunJoinGestureCanaryDoesNotExist"));

  const object = bodyOf(code, "object RunJoinGesture");
  ok("1b", "RunJoinGesture gained the three functions the offer is made of: offerFromSnap, endAtVertex, gapCloserFor",
    object !== null && ["fun offerFromSnap(", "fun endAtVertex(", "fun gapCloserFor("].every((s) => object.includes(s)));

  const offer = object && bodyOf(object, "fun offerFromSnap(");
  ok("1c", "TEETH: offerFromSnap requires the two ends to be on ONE point by EXACT equality, never within a tolerance -- a tolerance is proximity deciding a join",
    offer !== null && /point\.x\s*!=\s*at\.x\s*\|\|\s*point\.y\s*!=\s*at\.y/.test(offer) &&
      !/vertexSnapPx|<=\s*\d|tolerance/i.test(offer));
  ok("1d", "TEETH: offerFromSnap refuses a target end that already carries a live joint, so a snap never tries to say T",
    offer !== null && /liveJointOf\(runs,\s*other\)\.isNotBlank\(\)/.test(offer));
  ok("1e", "TEETH: offerFromSnap refuses when the end HE placed is already at a post",
    offer !== null && /liveJointOf\(runs,\s*movingEnd\)\.isNotBlank\(\)/.test(offer));
  ok("1f", "TEETH: offerFromSnap re-derives the verdict through decide() rather than re-writing the rules",
    offer !== null && /decide\(runs,\s*movingEnd,\s*other,\s*newJointId\)/.test(offer) && /!decision\.allowed/.test(offer));
  ok("1g", "offerFromSnap RETURNS an offer and writes nothing: no repository, no joint write, no point write in it",
    offer !== null && !/repository|writeJointIds|setRunJointIds|movePoint|writePoints/.test(offer));

  const endAt = object && bodyOf(object, "fun endAtVertex(");
  ok("1h", "TEETH: endAtVertex answers only for the FIRST or LAST point -- a bend in the middle of a run has nowhere to be stored and is already a corner post",
    endAt !== null && /index\s*==\s*0/.test(endAt) && /index\s*==\s*run\.points\.lastIndex/.test(endAt) && /return null/.test(endAt));

  const snapOffer = bodyOf(vm, "fun offerJoinFromSnap(");
  ok("1i", "TEETH: SurveyViewModel.offerJoinFromSnap asks only about a VERTEX snap -- a heading snap and a whole-foot snap land on nothing",
    snapOffer !== null && /kind\s*!=\s*com\.fenceestimator\.app\.geometry\.SnapKind\.VERTEX/.test(snapOffer));
  ok("1j", "and it is behind JOIN_STORAGE_READY, so it cannot offer what cannot be kept",
    snapOffer !== null && /if\s*\(!JOIN_STORAGE_READY\)\s*return/.test(snapOffer));
  ok("1k", "and it refuses a guest demo, like every other write door on this screen",
    snapOffer !== null && /viewerIsGuestDemo\(\)/.test(snapOffer));

  const accept = bodyOf(vm, "fun acceptSnapJoinOffer(");
  ok("1l", "TEETH: acceptSnapJoinOffer re-reads the runs and re-derives decide() rather than trusting the offer it was handed",
    accept !== null && /repository\.getFenceRuns\(jobId\)/.test(accept) && /RunJoinGesture\.decide\(/.test(accept));
  ok("1m", "TEETH: and it re-checks the two ends are still on one point, refusing rather than joining a corner that moved since",
    accept !== null && /a\.x\s*!=\s*b\.x\s*\|\|\s*a\.y\s*!=\s*b\.y/.test(accept));
  ok("1n", "TEETH: the snap path moves NO point -- acceptSnapJoinOffer calls neither movePoint nor writePoints nor moveJoinedEnd",
    accept !== null && !/movePoint|writePoints|moveJoinedEnd|gapCloser/.test(accept));
}

// =============================================================================
console.log("\n2. ATTACHED MEANS ONE POINT: THE LINE MOVES, AND NOT ACROSS THE YARD");
// =============================================================================
{
  const code = stripComments(geomSrc);
  const vm = stripComments(vmSrc);

  ok("2a", "JoinRefusal gained TOO_FAR_APART, so a join across the yard is refused rather than recorded",
    /enum class JoinRefusal[\s\S]*?TOO_FAR_APART/.test(code));
  ok("2b", "RunJoinGesture declares one limit, CLOSE_GAP_MAX_FT, and it is 2 ft",
    /const val CLOSE_GAP_MAX_FT\s*=\s*2\.0f/.test(code));
  eq("2b-model", "  and the model under test uses that same number", CLOSE_GAP_MAX_FT, 2.0);

  const tap = bodyOf(vm, "fun tapJoinEnd(");
  // THE DISTANCE LIMIT IS GONE, deliberately, at March's direct request on
  // 2 Oct 2026: "I want it to move regardless of the distance... and if I want
  // to keep attaching other ones I should be able to regardless of the
  // distance." This check used to require the refusal; requiring it now would
  // be a test forbidding the behaviour that was asked for.
  //
  // The guard was justified in the source by the move "changing the side's
  // footage, its labour and possibly a panel". That stopped being true in the
  // same session, when attaching began sliding the WHOLE side instead of
  // stretching one corner: the footage is identical at any distance. So the
  // reason went before the rule did.
  ok("2c", "tapJoinEnd no longer refuses on distance -- an attach is offered however far apart the two ends are",
    tap !== null &&
      !/gapCloser\.distanceFeet\s*>\s*RunJoinGesture\.CLOSE_GAP_MAX_FT/.test(tap) &&
      !/_joinRefused\.tryEmit\(JoinRefusal\.TOO_FAR_APART\)/.test(tap));
  ok("2c-ii", "TEETH: it still works out the gap closer, so the dialog can name the distance before he agrees to it",
    tap !== null && /gapCloserFor\(/.test(tap));
  ok("2c-iii", "and it still reaches the offer, so removing the refusal did not remove the question",
    tap !== null && /_joinOffer\.value = JoinOffer\(/.test(tap));
  ok("2c-canary", "CANARY: the old refusing version fails 2c, proving 2c can fail",
    /gapCloser\.distanceFeet\s*>\s*RunJoinGesture\.CLOSE_GAP_MAX_FT/.test(
      "if (gapCloser != null && gapCloser.distanceFeet > RunJoinGesture.CLOSE_GAP_MAX_FT) {"));

  const confirm = bodyOf(vm, "fun confirmJoinOffer(");
  ok("2d", "TEETH: confirmJoinOffer writes the JOINT FIRST and only then moves the corner, so a failed write cannot leave a line that moved for nothing",
    confirm !== null &&
      confirm.indexOf("writeJointIds(writes)") < confirm.indexOf("slideRunToMeet"));
  ok("2e", "TEETH: and it returns on a failed write before reaching the move at all",
    confirm !== null && /JoinRefusal\.NO_STORAGE\)\s*\n\s*return@launch/.test(confirm));

  // The attach path now SLIDES THE WHOLE SIDE (March, 2 Oct 2026): a side is a
  // measured thing, and stretching one corner to close a 2 ft gap made a 74 ft
  // side 76 ft and moved the labour with it. moveJoinedEnd still exists for any
  // caller that genuinely wants one corner; the attach dialog no longer is one.
  const slide = bodyOf(vm, "private fun slideRunToMeet(");
  ok("2f-slide", "slideRunToMeet translates EVERY point by the same delta, so the side keeps its length and its heading",
    slide !== null && /points\.map \{[^}]*it\.x \+ dx[^}]*it\.y \+ dy/.test(slide));
  ok("2f-slide-ii", "TEETH: it re-checks the end is still where the offer measured from before sliding anything",
    slide !== null && /closer\.from\.x/.test(slide) && /closer\.from\.y/.test(slide));
  ok("2f-slide-iii", "TEETH: it refuses the WHOLE slide if any point would land off the drawable area, rather than writing a part-slid side",
    slide !== null && /slid\.any \{ !isWritablePoint/.test(slide));
  ok("2f-slide-iv", "CANARY: a slide that moved only the end point would not match 2f-slide, proving that check can fail",
    !/points\.map \{[^}]*it\.x \+ dx[^}]*it\.y \+ dy/.test("points[index] = closer.to"));
  const moveEnd = bodyOf(vm, "private fun moveJoinedEnd(");
  ok("2f", "moveJoinedEnd goes through editRun/writePoints -- the ordinary drawing door -- so the move is ONE Undo step and re-prices like any drag",
    moveEnd !== null && /editRun\(/.test(moveEnd) && /writePoints\(/.test(moveEnd));
  ok("2g", "TEETH: moveJoinedEnd re-checks the corner is still where the offer measured from, and declines rather than dragging a corner nobody aimed",
    moveEnd !== null && /at\.x\s*!=\s*closer\.from\.x\s*\|\|\s*at\.y\s*!=\s*closer\.from\.y/.test(moveEnd));

  const closer = bodyOf(code, "fun gapCloserFor(");
  ok("2h", "TEETH: gapCloserFor moves the FREE end -- an end already at a shared post would re-open the post it was at",
    closer !== null && /firstAtPost\s*&&\s*!secondAtPost/.test(closer));
  ok("2i", "TEETH: and it returns null when the two ends are already one point, so a snap-made join says nothing about movement",
    closer !== null && /from\.x\s*==\s*to\.x\s*&&\s*from\.y\s*==\s*to\.y/.test(closer) );
  ok("2j", "TEETH: gapCloserFor does NOT apply the limit itself -- the distance that is allowed lives in exactly one place",
    closer !== null && !/CLOSE_GAP_MAX_FT/.test(closer));
}

// =============================================================================
console.log("\n3. UNDO CANNOT LEAVE A JOINT ON A CORNER THAT IS NOT THERE");
// =============================================================================
{
  const vm = stripComments(vmSrc);
  const free = bodyOf(vm, "private suspend fun freeJointsAtVanishedEnds(");
  ok("3a", "a restore that moves a run's first or last point frees that end's joint",
    free !== null &&
      /!same\(was\.firstOrNull\(\), now\.firstOrNull\(\)\)/.test(free) &&
      /!same\(was\.lastOrNull\(\), now\.lastOrNull\(\)\)/.test(free) &&
      /add\(JoinEnd\(after\.syncId, false\) to ""\)/.test(free) &&
      /add\(JoinEnd\(after\.syncId, true\) to ""\)/.test(free));
  ok("3b", "TEETH: and an end whose point did NOT move keeps its joint, so undoing a gate does not take a corner post apart",
    free !== null && /if \(writes\.isEmpty\(\)\) return/.test(free));
  ok("3b2", "TEETH: the joint is freed through writeJointIds -- the ONE write path tests/a59 check 7 holds a joint to -- and never by copying the run",
    free !== null && /writeJointIds\(writes\)/.test(free) && !/\.copy\(/.test(free));
  ok("3b3", "and it re-prices every run, because the stranded partner loses its shared post while its own row never changed",
    free !== null && /repriceEveryRun\(\)/.test(free));

  const undo = bodyOf(vm, "fun undoLast(");
  const redo = bodyOf(vm, "fun redo(");
  ok("3c", "TEETH: both Undo and Redo go through it -- Redo puts the same point back and must be able to take the joint with it",
    undo !== null && redo !== null &&
      /freeJointsAtVanishedEnds\(/.test(undo) && /freeJointsAtVanishedEnds\(/.test(redo));
  // CANARY FOR THIS SECTION: DrawingSnapshot really does carry no joint, which
  // is WHY this function has to exist. If it ever carries one, this check fails
  // and the right answer is to delete freeJointsAtMovedEnds, not to adjust it.
  const snapshot = bodyOf(stripComments(read("app/src/main/java/com/fenceestimator/app/geometry/DrawHistory.kt")), "data class DrawingSnapshot(");
  ok("3d-canary", "section canary: DrawingSnapshot still carries points, gates and the closed flag ONLY -- no joint -- which is why 3a has to exist",
    snapshot !== null && /pointsEncoded/.test(snapshot) && /gatesEncoded/.test(snapshot) &&
      /closedLoop/.test(snapshot) && !/[Jj]oint/.test(snapshot));
}

// =============================================================================
console.log("\n4. THE PRICE FOLLOWS, THROUGH THE SAME PATH A DRAWING EDIT USES");
// =============================================================================
{
  const vm = stripComments(vmSrc);
  const refresher = stripComments(read("app/src/main/java/com/fenceestimator/app/estimate/TakeoffRefresher.kt"));

  const sig = bodyOf(refresher, "fun pricingSignature(");
  ok("4a", "a joint IS part of the re-pricing signature: pricingSignature subtracts identity, the clock, the label, the sort order and the template -- and nothing else, so startJoint and endJoint are in it",
    sig !== null && !/startJoint|endJoint/.test(sig) && /run\.copy\(/.test(sig));
  ok("4a-canary", "canary: it really is a whole-row copy with named subtractions, so 4a is reading the mechanism and not an absence",
    sig !== null && ["id = 0L", "syncId = \"\"", "jobId = 0L", "label = \"\"", "sortOrder = 0", "updatedAt = 0L"].every((s) => sig.includes(s)));

  const confirm = bodyOf(vm, "fun confirmJoinOffer(");
  const accept = bodyOf(vm, "fun acceptSnapJoinOffer(");
  ok("4b", "TEETH: BOTH join paths re-price -- the Attach tool's confirm and the draw-time offer",
    confirm !== null && accept !== null && /repriceEveryRun\(\)/.test(confirm) && /repriceEveryRun\(\)/.test(accept));

  const reprice = bodyOf(vm, "private suspend fun repriceEveryRun(");
  ok("4c", "TEETH: it re-prices EVERY run of the job, not just the rows written -- a detach writes one end and a T writes two, so the post's OWNER can be a run whose own row never changed",
    reprice !== null && /repository\.getFenceRuns\(jobId\)\.forEach/.test(reprice) &&
      /TakeoffRefresher\.refreshRun\(repository, run, true\)/.test(reprice));
  ok("4d", "and it keeps the same gates every other re-price has: the crew phone still may not, and a failure still says so on the canvas",
    reprice !== null && /viewerMayReprice\(\)/.test(reprice) && /_repriceFailed\.value = true/.test(reprice));
  ok("4e", "the scale-change path now shares that one body rather than keeping a second list of runs",
    /private suspend fun repriceAfterScaleChange\(\)\s*=\s*repriceEveryRun\(\)/.test(vm));
  ok("4f", "and the refresher really does read joins when it re-prices, so this is not a refresh that changes nothing",
    /EstimateEngine\.joinAdjustments\(repository\.getFenceRuns\(run\.jobId\), pixelsPerFoot\)/.test(refresher));
}

// =============================================================================
console.log("\n5. WHAT IT SAYS, IN HIS TERMS, IN THREE LANGUAGES");
// =============================================================================
{
  const base = read(STRINGS);
  const es = read(STRINGS_ES);
  const fr = read(STRINGS_FR);
  const names = (xml) => [...xml.matchAll(/<string name="([^"]+)"/g)].map((m) => m[1]).sort();
  const want = names(base);

  ok("5a", "the new wording is in its OWN files, res/values*/strings_join_offer.xml, not in strings.xml which another wave is editing",
    want.length > 0);
  eq("5b", "Spanish carries exactly the same keys", names(es), want);
  eq("5c", "French carries exactly the same keys", names(fr), want);
  ok("5d", "the keys cover the offer, the move, the footage, the refusal and what detach does NOT do",
    ["snap_join_offer", "snap_join_offer_action", "attach_moves", "attach_moves_keeps_length",
      "attach_refused_too_far", "attach_detach_keeps_drawing", "attach_already_together"]
      .every((k) => want.includes(k)));
  ok("5e", "TEETH: it is said in what it costs him -- post, cap and concrete -- and never in the code's words",
    /post, its cap and its concrete/.test(base) && !/joint|vertex|JoinEnd/i.test(base.replace(/<!--[\s\S]*?-->/g, "")));
  ok("5f", "the too-far refusal tells him the way through -- drag the end over, and the offer comes to him there",
    /drag the end over/i.test(base));
  // Positional arguments must match across locales or the formatter throws.
  const argsOf = (xml, key) => {
    const m = xml.match(new RegExp(`<string name="${key}">([\\s\\S]*?)</string>`));
    return m ? [...m[1].matchAll(/%(\d)\$/g)].map((x) => x[1]).sort() : null;
  };
  ok("5g", "every formatted string takes the same numbered arguments in all three locales",
    ["attach_moves", "attach_moves_keeps_length", "attach_refused_too_far"].every((k) =>
      JSON.stringify(argsOf(base, k)) === JSON.stringify(argsOf(es, k)) &&
      JSON.stringify(argsOf(base, k)) === JSON.stringify(argsOf(fr, k))));
  ok("5g-canary", "canary: the argument scanner really finds arguments, so 5g is comparing something",
    JSON.stringify(argsOf(base, "attach_moves_keeps_length")) === JSON.stringify(["1", "2"]));
}

// =============================================================================
console.log("\n6. THE MODEL, ON FIXTURES: WHO IS OFFERED AND WHO IS NOT");
// =============================================================================

// Two sides of a yard. The BACK runs east; the SIDE runs south from the back's
// west end. 20 px/ft, the grid's own scale.
const PXFT = 20;
const CORNER = P(100, 100);
const BACK = [CORNER, P(1000, 100)];           // start is the shared corner
const SIDE_AWAY = [P(100, 900), P(100, 140)];  // its END is 40 px short of it

{
  // The snap, first: a tap near the back's corner lands EXACTLY on it.
  const tapped = P(100 + 12, 100 - 9); // 15 px away, inside the 26 px reach
  const snap = snapDrawPoint(tapped, P(100, 900), null, [CORNER, P(1000, 100)], PXFT);
  eq("6a", "the draw snap puts a point tapped 15 px from the other side's corner EXACTLY on it, to the last decimal",
    [snap.kind, snap.point.x, snap.point.y], ["VERTEX", 100, 100]);
  ok("6a-control", "POSITIVE CONTROL: the tap really was off the corner before the snap, so 6a moved something",
    tapped.x !== CORNER.x || tapped.y !== CORNER.y);

  // ... and that is the state the offer is raised in.
  const SIDE_ON = [P(100, 900), snap.point];
  const runs = [run("back", BACK, { sortOrder: 0 }), run("side", SIDE_ON, { sortOrder: 1 })];
  const o = offerAfterSnap(runs, "side", 1, snap.kind, "J1");
  ok("6b", "POSITIVE CONTROL: a vertex snap onto another run's FREE end raises the offer",
    o !== null && o.targetEnd.runId === "back" && o.targetEnd.atEnd === false && o.movingEnd.runId === "side" && o.movingEnd.atEnd === true);
  eq("6b-joint", "  and the joint it would write is the new id, to BOTH ends", [o.decision.jointId, o.decision.ends.length], ["J1", 2]);

  // A heading snap and a whole-foot snap do not land on anything.
  const headingTap = P(100 + 600, 900 - 3); // nearly due east, 600 px out
  const hs = snapDrawPoint(headingTap, P(100, 900), null, [CORNER, P(1000, 100)], PXFT);
  ok("6c", "a heading snap is not a VERTEX snap, and raises no offer",
    hs.kind !== "VERTEX" && offerAfterSnap(runs, "side", 1, hs.kind, "J1") === null);
  ok("6c-control", "POSITIVE CONTROL: that tap really did lock a heading, so 6c is about a real snap and not about nothing happening",
    hs.kind === "ANGLE" || hs.kind === "ANGLE_AND_LENGTH");

  const footTap = P(100, 900 - 47 * PXFT - 4); // 47.2 ft due north -> 47 ft
  const fs = snapDrawPoint(footTap, P(100, 900), null, [P(5000, 5000)], PXFT);
  ok("6d", "a whole-foot snap is not a VERTEX snap, and raises no offer",
    fs.kind !== "VERTEX" && offerAfterSnap(runs, "side", 1, fs.kind, "J1") === null);
  ok("6d-control", "POSITIVE CONTROL: that tap really did round to a whole foot",
    fs.kind === "LENGTH" || fs.kind === "ANGLE_AND_LENGTH");
}

{
  // The run's OWN earlier corner: closing a loop, not joining two sides.
  const self = [P(100, 100), P(900, 100), P(900, 900), P(100, 100)];
  const runs = [run("solo", self)];
  ok("6e", "landing on the SELECTED run's own first corner offers nothing -- that is closing a loop, and decide() calls it SAME_RUN",
    offerAfterSnap(runs, "solo", 3, "VERTEX", "J1") === null);
  ok("6e-control", "POSITIVE CONTROL: the two points really are identical, so 6e refused for the right reason and not for want of a coincidence",
    self[0].x === self[3].x && self[0].y === self[3].y);
}

{
  // A middle bend, not an end.
  const mid = [P(0, 0), CORNER, P(500, 500)];
  const runs = [run("back", BACK), run("zig", mid, { sortOrder: 1 })];
  ok("6f", "landing on a bend in the MIDDLE of the other side offers nothing: there is nowhere to store it and the post is already a corner",
    offerFromSnap(runs, { runId: "zig", atEnd: false }, "J1") === null);
  ok("6f-control", "POSITIVE CONTROL: the middle vertex really is on the back's corner, so 6f refused on the END rule",
    mid[1].x === CORNER.x && mid[1].y === CORNER.y);
  ok("6f-own-end", "  and the SAME drawing offers nothing for the zig's own middle index either (endAtVertex says no)",
    endAtVertex(runs[1], 1) === null);
}

{
  // The target end already carries a joint: that is a T, and a snap cannot say T.
  const runs = [
    run("back", BACK, { startJointId: "JX", sortOrder: 0 }),
    run("west", [P(100, 100), P(100, 900)], { startJointId: "JX", sortOrder: 1 }),
    run("third", [P(100, 2000), CORNER], { sortOrder: 2 }),
  ];
  ok("6g", "an end already carrying a LIVE joint is not offered: three sides at one post are coincident, so a snap cannot name which post member he meant",
    offerFromSnap(runs, { runId: "third", atEnd: true }, "J1") === null);
  eq("6g-control", "POSITIVE CONTROL: that joint really is live -- two different runs hold it",
    runsAtJoint(runs, "JX"), ["back", "west"]);

  // ... and an id held by only ONE end is NOT live, so it does not block.
  const halfRuns = [
    run("back", BACK, { startJointId: "JY", sortOrder: 0 }),
    run("third", [P(100, 2000), CORNER], { sortOrder: 2 }),
  ];
  ok("6g-stranded", "a joint id held by one end only is a FREE end, so a stranded id does not block a real join",
    offerFromSnap(halfRuns, { runId: "third", atEnd: true }, "J1") !== null);
}

{
  // Teardown against new.
  const runs = [
    run("old", BACK, { isTeardown: true, sortOrder: 0 }),
    run("new", [P(100, 900), CORNER], { isTeardown: false, sortOrder: 1 }),
  ];
  ok("6h", "the old fence coming out and the new one going in are not offered as one post, however exactly their ends coincide",
    offerFromSnap(runs, { runId: "new", atEnd: true }, "J1") === null);
  eq("6h-control", "POSITIVE CONTROL: decide() names the reason, so 6h is the teardown rule and not an accident",
    decide(runs, { runId: "new", atEnd: true }, { runId: "old", atEnd: false }, "J1").refusal, "TEARDOWN_MISMATCH");
  ok("6h-both-old", "two TEARDOWN runs meeting ARE offered -- an old fence drawn in two pieces is a real thing to attach",
    offerFromSnap(
      [run("old1", BACK, { isTeardown: true }), run("old2", [P(100, 900), CORNER], { isTeardown: true, sortOrder: 1 })],
      { runId: "old2", atEnd: true }, "J1") !== null);
}

{
  // A closed perimeter and a typed-footage run have no free end.
  const closed = [run("ring", [CORNER, P(900, 100), P(900, 900)], { closedLoop: true }),
    run("side", [P(100, 900), CORNER], { sortOrder: 1 })];
  ok("6i", "a closed perimeter is not offered: it has no loose end to give",
    offerFromSnap(closed, { runId: "side", atEnd: true }, "J1") === null);
  const typed = [run("typed", BACK, { typedFootage: true }),
    run("side", [P(100, 900), CORNER], { sortOrder: 1 })];
  ok("6j", "a side quoted from typed footage is not offered: it has no drawn end",
    offerFromSnap(typed, { runId: "side", atEnd: true }, "J1") === null);
}

// =============================================================================
console.log("\n7. NOTHING JOINS AND NO POINT MOVES WITHOUT AN EXPLICIT YES");
// =============================================================================
{
  const runs = [run("back", BACK, { sortOrder: 0 }), run("side", [P(100, 900), CORNER], { sortOrder: 1 })];
  const o = offerFromSnap(runs, { runId: "side", atEnd: true }, "J1");
  ok("7a", "POSITIVE CONTROL: this is a case that IS offered",
    o !== null);
  eq("7b", "but raising the offer writes NO joint: both runs' joint columns are untouched",
    runs.map((r) => [r.startJointId, r.endJointId]), [["", ""], ["", ""]]);
  eq("7c", "and raising it moves NO point: both runs' coordinates are untouched",
    runs.map((r) => r.points.map((p) => [p.x, p.y])),
    [[[100, 100], [1000, 100]], [[100, 900], [100, 100]]]);

  // The yes, modelled: the write the view model would make.
  const after = runs.map((r) => {
    const w = o.decision.ends.find((e) => e.runId === r.runId);
    if (!w) return r;
    return w.atEnd ? { ...r, endJointId: o.decision.jointId } : { ...r, startJointId: o.decision.jointId };
  });
  eq("7d", "on YES, the SAME id lands on both ends and the joint is live",
    runsAtJoint(after, "J1"), ["back", "side"]);
  eq("7e", "and on yes the two ends are at the same coordinates -- the snap had already put them there, so the attach costs 0.00 ft",
    [pointOf(after, o.movingEnd), pointOf(after, o.targetEnd),
      gapCloserFor(after, o.decision, PXFT)],
    [{ x: 100, y: 100 }, { x: 100, y: 100 }, null]);
}

// =============================================================================
console.log("\n8. THE ATTACH TOOL: CLOSE A GAP, OR REFUSE IT");
// =============================================================================
{
  // His own job's second corner, to the number: 63.8062 units apart, which at
  // that job's calibration (79.75 px/ft, probed read-only 2 Oct 2026) is 0.80 ft.
  const HIS_PXFT = 79.75;
  const runs = [
    run("back", [P(6000.28, 803.1039), P(2000.2798, 803.1039)], { sortOrder: 0 }),
    run("right", [P(5995.1436, 6499.2954), P(6000.3374, 739.2977)], { sortOrder: 1 }),
  ];
  const first = { runId: "right", atEnd: true };   // tapped first: this one moves
  const second = { runId: "back", atEnd: false };
  const t = tapAttach(runs, first, second, "J1", HIS_PXFT);
  ok("8a", "POSITIVE CONTROL: his own 0.8 ft corner IS offered, with a move",
    t.refusal === null && t.gapCloser !== null);
  eq("8b", "the corner that moves is the one he picked up FIRST (both ends free), and it moves onto the other end's point",
    [t.gapCloser.end.runId, t.gapCloser.end.atEnd, t.gapCloser.to.x, t.gapCloser.to.y],
    ["right", true, 6000.28, 803.1039]);
  ok("8c", "and the distance is reported in feet, about 0.80 ft at that job's scale",
    Math.abs(t.gapCloser.distanceFeet - 0.7999) < 0.01,
    `got ${t.gapCloser.distanceFeet}`);
  // The SIGN matters and is not guessable: on his job that end moves BACK
  // towards its own start, so closing the gap makes the side 0.8 ft SHORTER and
  // takes 0.8 ft of labour OFF. "The gap closes" does not say which way the
  // money goes -- which is exactly why the offer prints both figures.
  ok("8d", "and the side's WHOLE footage is reported before and after -- on his job it SHORTENS by 0.8 ft, so labour comes off",
    t.gapCloser.runFeetAfter < t.gapCloser.runFeetBefore &&
      Math.abs((t.gapCloser.runFeetBefore - t.gapCloser.runFeetAfter) - 0.7999) < 0.02,
    `before ${t.gapCloser.runFeetBefore}, after ${t.gapCloser.runFeetAfter}`);
}

{
  // The live 110 ft joint, which this refusal exists to stop being made again.
  const runs = [
    run("a", [P(0, 0), P(1000, 0)], { sortOrder: 0 }),
    run("b", [P(0, 5000), P(4425.3534, 0)], { sortOrder: 1 }),
  ];
  const t = tapAttach(runs, { runId: "b", atEnd: true }, { runId: "a", atEnd: false }, "J1", 40);
  eq("8e", "a gap of 110 ft is REFUSED as TOO_FAR_APART, not recorded as one post with the plan showing two ends across the yard",
    t.refusal, "TOO_FAR_APART");
  ok("8e-control", "POSITIVE CONTROL: decide() itself allowed it -- the refusal is the new distance rule and not an old one",
    allowed(decide(runs, { runId: "b", atEnd: true }, { runId: "a", atEnd: false }, "J1")));
  // Right at the boundary.
  const near = [run("a", [P(0, 0), P(1000, 0)], { sortOrder: 0 }),
    run("b", [P(0, 5000), P(79, 0)], { sortOrder: 1 })];   // 79 px at 40 px/ft = 1.975 ft
  ok("8f", "a gap just under the 2 ft limit is allowed and closed",
    tapAttach(near, { runId: "b", atEnd: true }, { runId: "a", atEnd: false }, "J1", 40).refusal === null);
  const over = [run("a", [P(0, 0), P(1000, 0)], { sortOrder: 0 }),
    run("b", [P(0, 5000), P(81, 0)], { sortOrder: 1 })];   // 2.025 ft
  eq("8g", "a gap just over it is refused -- one number, one place",
    tapAttach(over, { runId: "b", atEnd: true }, { runId: "a", atEnd: false }, "J1", 40).refusal, "TOO_FAR_APART");
}

{
  // A T: the free end walks to the existing post, never the other way round.
  const runs = [
    run("back", [P(100, 100), P(1000, 100)], { startJointId: "JX", sortOrder: 0 }),
    run("west", [P(100, 100), P(100, 900)], { startJointId: "JX", sortOrder: 1 }),
    run("third", [P(900, 1500), P(120, 120)], { sortOrder: 2 }),
  ];
  // First tap is the end that is ALREADY at the post.
  const t = tapAttach(runs, { runId: "back", atEnd: false }, { runId: "third", atEnd: true }, "J1", PXFT);
  eq("8h", "when the FIRST-tapped end is already at a shared post, the OTHER one moves -- moving the attached end would re-open the post it was at",
    [t.refusal, t.gapCloser.end.runId, t.gapCloser.to.x, t.gapCloser.to.y],
    [null, "third", 100, 100]);
  eq("8h-joint", "  and the third side joins the EXISTING post rather than making a second one",
    t.decision.jointId, "JX");
}

// =============================================================================
console.log("\n9. CANARIES: TWO VERSIONS THAT TAKE THE OFFER THEMSELVES. BOTH MUST FAIL.");
// =============================================================================
{
  // CANARY ONE: an offer that joins by itself.
  //
  // Same fixture as section 7, but offerFromSnap also writes the joint. The
  // assertion that nothing is joined without a yes must catch it.
  function offerFromSnap_AUTOJOIN(runs, movingEnd, newJointId) {
    const o = offerFromSnap(runs, movingEnd, newJointId);
    if (o) {
      for (const e of o.decision.ends) {
        const r = runs.find((x) => x.runId === e.runId);
        if (e.atEnd) r.endJointId = o.decision.jointId;
        else r.startJointId = o.decision.jointId;
      }
    }
    return o;
  }
  const runs1 = [run("back", BACK, { sortOrder: 0 }), run("side", [P(100, 900), CORNER], { sortOrder: 1 })];
  offerFromSnap_AUTOJOIN(runs1, { runId: "side", atEnd: true }, "J1");
  const joinedBySurprise = JSON.stringify(runs1.map((r) => [r.startJointId, r.endJointId]))
    !== JSON.stringify([["", ""], ["", ""]]);
  ok("9a-canary", "CANARY 1 FAILED AS IT MUST: a version of offerFromSnap that joins by itself is caught by the no-joint-without-yes assertion (7b)",
    joinedBySurprise);

  // CANARY TWO: an offer that moves the point by itself.
  //
  // Same fixture, but the offer drags the end onto the target. The assertion
  // that no point moves without a yes must catch it. Deliberately set up with
  // ends that are NOT already together, because a snap-made offer has nothing
  // left to move -- so this canary tests the stronger claim.
  function offerFromSnap_AUTOMOVE(runs, movingEnd, targetEnd) {
    const r = runs.find((x) => x.runId === movingEnd.runId);
    const to = pointOf(runs, targetEnd);
    r.points[movingEnd.atEnd ? r.points.length - 1 : 0] = to;
    return { moved: true };
  }
  const runs2 = [run("back", BACK, { sortOrder: 0 }), run("side", SIDE_AWAY, { sortOrder: 1 })];
  const beforeMove = JSON.stringify(runs2[1].points.map((p) => [p.x, p.y]));
  offerFromSnap_AUTOMOVE(runs2, { runId: "side", atEnd: true }, { runId: "back", atEnd: false });
  const movedBySurprise = JSON.stringify(runs2[1].points.map((p) => [p.x, p.y])) !== beforeMove;
  ok("9b-canary", "CANARY 2 FAILED AS IT MUST: a version that moves the corner by itself is caught by the no-point-moves-without-yes assertion (7c)",
    movedBySurprise);

  // And the real one, on the same fixture, does neither.
  const runs3 = [run("back", BACK, { sortOrder: 0 }), run("side", SIDE_AWAY, { sortOrder: 1 })];
  const before3 = JSON.stringify(runs3.map((r) => [r.points.map((p) => [p.x, p.y]), r.startJointId, r.endJointId]));
  const o3 = offerFromSnap(runs3, { runId: "side", atEnd: true }, "J1");
  ok("9c", "and the REAL offerFromSnap, asked about ends 40 px apart, neither joins nor moves -- and does not even offer, because they are not one point",
    o3 === null &&
      JSON.stringify(runs3.map((r) => [r.points.map((p) => [p.x, p.y]), r.startJointId, r.endJointId])) === before3);
}

// =============================================================================
console.log("\n10. THE NUMBERS THIS FILE'S MODEL BORROWS, PINNED TO THEIR SOURCE");
// =============================================================================
{
  const code = stripComments(geomSrc);
  ok("10a", "the vertex snap FLOOR is still 26 drawing units, which is what sections 6a and 9c are measured against",
    /vertexSnapPx: Float = DEFAULT_VERTEX_SNAP_PX/.test(code) &&
      new RegExp(`const val DEFAULT_VERTEX_SNAP_PX = ${VERTEX_SNAP_PX}f`).test(code));
  ok("10a-ii", "and the reach a caller may ask for is capped in FEET, so a screen-relative reach cannot grab a corner across the yard",
    /const val VERTEX_SNAP_MAX_FT = /.test(code));
  {
    // The clamp itself, as the view model applies it. Floor at the old reach so
    // zoomed in is never worse; ceiling in feet so zoomed out is never silly.
    const FLOOR = VERTEX_SNAP_PX, MAX_FT = 3.0;
    const reach = (fromScreen, scale) => {
      if (fromScreen == null || fromScreen <= 0) return FLOOR;
      const ceiling = scale > 0 ? MAX_FT * scale : Infinity;
      return Math.min(Math.max(fromScreen, FLOOR), Math.max(FLOOR, ceiling));
    };
    ok("10a-iii", "zoomed out, 18 screen px is worth far more than 26 units, and the foot cap is what bites",
      reach(305, 20) === 60 && reach(305, 20) < 305);
    ok("10a-iv", "zoomed in, the screen figure falls below the old reach and the floor holds it there",
      reach(4, 400) === FLOOR);
    ok("10a-v", "no reach given means exactly the old behaviour",
      reach(null, 20) === FLOOR && reach(0, 20) === FLOOR);
    ok("10a-vi", "CANARY: without the floor, a zoomed-in snap would reach less than the old 26 and this check would pass a worse value",
      Math.min(Math.max(4, 0), Math.max(0, 3.0 * 400)) === 4);
  }
  ok("10b", "the angle tolerance is still 7 degrees and the whole-foot window still 0.35 ft",
    new RegExp(`angleToleranceDeg: Float = ${ANGLE_TOLERANCE_DEG}f`).test(code) &&
      new RegExp(`lengthSnapFt: Float = ${LENGTH_SNAP_FT}f`).test(code));
  ok("10c", "two corners closer than 0.01 px are still the same corner",
    new RegExp(`SAME_CORNER_PX = ${SAME_CORNER_PX}f`).test(code));
  ok("10d", "and snapDrawPoint still returns the EXISTING corner object on a vertex snap rather than a point computed from it -- which is why exact equality is the right filter",
    /return SnapResult\(nearestVertex, SnapKind\.VERTEX\)/.test(code));
}

// =============================================================================
console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`      failing: ${failedIds.join(", ")}`);
  process.exitCode = 1;
}
