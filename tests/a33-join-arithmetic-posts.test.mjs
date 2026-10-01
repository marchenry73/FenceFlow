// JOINED RUNS -- the post arithmetic, as a pure function, with its numbers pinned.
//
// Run:   node tests/a33-join-arithmetic-posts.test.mjs      (exit code 0 = every check passed)
//
// =============================================================================
// WHAT THIS FILE TESTS, AND WHAT IT DOES NOT. READ BEFORE TRUSTING A GREEN RUN.
// =============================================================================
// The subject is RunJoinArithmetic in
//   app/src/main/java/com/fenceestimator/app/geometry/FenceGeometry.kt
// -- a pure function that, given every run of a job and the joints the owner has
// explicitly made between run ends, says how each run's post counts move.
//
//   * IT IS NOT CALLED BY THE ENGINE. Neither EstimateEngine.kt nor the server
//     takeoff reaches it, and no joint is stored anywhere. A job priced today is
//     priced exactly as before. Section 7 asserts that claim stays true: the day
//     someone wires it in, this file goes red until the Kotlin header is updated.
//   * THIS FILE CANNOT RUN KOTLIN. Node has no Kotlin. Sections 1-6 run
//     adjustJoins() below, which is a LINE-FOR-LINE TRANSCRIPTION of the Kotlin
//     object (and, once the server needs it, the shape of the TypeScript port).
//     The two can drift. Section 7 is what holds them together: the Kotlin was
//     compiled standalone (kotlinc 2.0.21, no Gradle: FenceGeometry.kt plus the
//     two files of its own package it already needs, SideLength.kt and GateSpan.kt)
//     and run over every scenario registered here, and its output is frozen in
//     KOTLIN_GOLDEN. The transcription must reproduce it line for line. The
//     golden is a SNAPSHOT: this test does not re-run the Kotlin, so a later edit
//     to RunJoinArithmetic is only caught here by the source checks (7c-7k) until
//     someone re-runs the harness. To regenerate, see the recipe at KOTLIN_HARNESS.
//   * THE REAL ENGINE IS NOT TRANSCRIBED. Every "posts before" number comes from
//     the real priceJob (supabase/functions/_shared/pricing), one run priced
//     alone, and every cross-check ("joined must equal one polyline through the
//     same points") asks the real engine for the polyline. If the engine's own
//     post rule moves, section 1 fails FIRST and says so.
//
// =============================================================================
// THE EXISTING RULE (computePostCounts, takeoff.ts; the same code in EstimateEngine.kt)
// =============================================================================
//   bays                = ceil(netFt / postSpacingFt)        gaps between posts, gate openings already taken out of netFt
//   standardPostEstimate= bays + 1 - gates   an OPEN run (it has end posts): n bays have n + 1 posts
//                       = bays - gates       a CLOSED loop (endPosts == 0): the last bay lands on the first post
//                       = 0                  when bays == 0.     (each gate takes one out: the two posts either side
//                                            of the opening ARE posts of the line; gatePosts adds the pair back)
//   linePosts           = max(standardPostEstimate - cornerPosts - endPosts, 0)
//   gatePosts           = 2 per gate, 3 for LINE_TO_WALL         (outside the estimate: the opening is already out of netFt)
//   totalPosts          = linePosts + cornerPosts + endPosts + gatePosts
// cornerPosts is geometry.cornerCount (a bend of 15 degrees or more INSIDE one polyline), endPosts is
// geometry.endCount (that run's own free ends). The consequence this whole file turns on: corners and ends
// are CARVED OUT of one fixed pool, never added to it. Change endPosts before this runs and linePosts rises
// by the same amount; the total does not move. (Section 2, 2a-naive, shows it on the real engine.)
//
// =============================================================================
// THE ARITHMETIC PINNED HERE (derived by hand; each case below asserts the number)
// =============================================================================
// Legs alone, vinyl, 6 ft spacing:   30 ft = 4 line + 2 end = 6     17 ft = 2 + 2 = 4     24 ft = 3 + 2 = 5
//   a. two runs joined, straight   10 -> 9    6 line + 4 end            -> 7 line + 0 corner + 2 end
//      the same two at 90 degrees  10 -> 9                              -> 6 line + 1 corner + 2 end
//   b. three runs in a line        15 -> 13   9 line + 6 end            -> 11 line + 2 end
//   c. ring of four open runs      20 -> 16   12 line + 8 end           -> 12 line + 4 corner + 0 end
//      the same chain, one joint short (open)  20 -> 17                 -> 12 line + 3 corner + 2 end
//   d. a T: three ends at a point  15 -> 13   9 line + 6 end            -> 9 line + 1 corner + 3 end
//   e. a gate at the joined end    11 -> 10   gate posts stay 2
//   f. no joints at all            identical, to the post, to today
// A joint where d run ends meet is ONE post in the ground: ends fall by d, one line-or-corner post appears,
// the total falls by d - 1. The owner run keeps the post (its end becomes it); every other member gives its end up.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { priceJob, PRICING_ENGINE_VERSION } from "../supabase/functions/_shared/pricing/index.ts";
import { analyze, decodePoints, CORNER_ANGLE_THRESHOLD_DEGREES } from "../supabase/functions/_shared/pricing/geometry.ts";
import { computePostCounts } from "../supabase/functions/_shared/pricing/takeoff.ts";
import { f32 } from "../supabase/functions/_shared/pricing/f32.ts";

// Output of KOTLIN_HARNESS (bottom of this file): FenceGeometry.kt compiled standalone (kotlinc 2.0.21, with SideLength.kt and GateSpan.kt, which it
// already depends on; JDK 21) and run over every scenario registered below, on 2026-10-01. One line per fact, scenario|kind|...
// To regenerate, see the recipe above KOTLIN_HARNESS. The test fails if the transcription ever disagrees with a single line.
const KOTLIN_GOLDEN = `a-unjoined|SAVED|0
a-straight|ADJ|A|1|0|-1
a-straight|ADJ|B|0|0|-1
a-straight|POST|J1|LINE|A|A,B
a-straight|SAVED|1
a-corner90|ADJ|A|0|1|-1
a-corner90|ADJ|B|0|0|-1
a-corner90|POST|J1|CORNER|A|A,B
a-corner90|SAVED|1
b-unjoined|SAVED|0
b-chain|ADJ|A|1|0|-1
b-chain|ADJ|B|1|0|-2
b-chain|ADJ|C|0|0|-1
b-chain|POST|J1|LINE|A|A,B
b-chain|POST|J2|LINE|B|B,C
b-chain|SAVED|2
c-unjoined|SAVED|0
c-ring|ADJ|A|0|2|-2
c-ring|ADJ|B|0|1|-2
c-ring|ADJ|C|0|1|-2
c-ring|ADJ|D|0|0|-2
c-ring|POST|J1|CORNER|A|A,B
c-ring|POST|J2|CORNER|B|B,C
c-ring|POST|J3|CORNER|C|C,D
c-ring|POST|J4|CORNER|A|A,D
c-ring|SAVED|4
c-chain-open|ADJ|A|0|1|-1
c-chain-open|ADJ|B|0|1|-2
c-chain-open|ADJ|C|0|1|-2
c-chain-open|ADJ|D|0|0|-1
c-chain-open|POST|J1|CORNER|A|A,B
c-chain-open|POST|J2|CORNER|B|B,C
c-chain-open|POST|J3|CORNER|C|C,D
c-chain-open|SAVED|3
d-unjoined|SAVED|0
d-tee|ADJ|A|0|1|-1
d-tee|ADJ|B|0|0|-1
d-tee|ADJ|C|0|0|-1
d-tee|POST|J1|CORNER|A|A,B,C
d-tee|SAVED|2
d-fork|ADJ|A|0|1|-1
d-fork|ADJ|B|0|0|-1
d-fork|ADJ|C|0|0|-1
d-fork|POST|J1|CORNER|A|A,B,C
d-fork|SAVED|2
d-cross|ADJ|A|0|1|-1
d-cross|ADJ|B|0|0|-1
d-cross|ADJ|C|0|0|-1
d-cross|ADJ|D|0|0|-1
d-cross|POST|J1|CORNER|A|A,B,C,D
d-cross|SAVED|3
e-unjoined|SAVED|0
e-gate-at-joint|ADJ|A|1|0|-1
e-gate-at-joint|ADJ|B|0|0|-1
e-gate-at-joint|POST|J1|LINE|A|A,B
e-gate-at-joint|SAVED|1
e-gate-far-end|ADJ|A|1|0|-1
e-gate-far-end|ADJ|B|0|0|-1
e-gate-far-end|POST|J1|LINE|A|A,B
e-gate-far-end|SAVED|1
e-gates-both-sides|ADJ|A|1|0|-1
e-gates-both-sides|ADJ|B|0|0|-1
e-gates-both-sides|POST|J1|LINE|A|A,B
e-gates-both-sides|SAVED|1
e-gate-line-to-wall|ADJ|A|1|0|-1
e-gate-line-to-wall|ADJ|B|0|0|-1
e-gate-line-to-wall|POST|J1|LINE|A|A,B
e-gate-line-to-wall|SAVED|1
e-gate-run-gives-up|ADJ|A|1|0|-1
e-gate-run-gives-up|ADJ|B|0|0|-1
e-gate-run-gives-up|POST|J1|LINE|A|A,B
e-gate-run-gives-up|SAVED|1
f-no-joints|SAVED|0
f-dangling-ids|IGN|J1|FEWER_THAN_TWO_LIVE_RUNS
f-dangling-ids|IGN|J2|FEWER_THAN_TWO_LIVE_RUNS
f-dangling-ids|IGN|J3|FEWER_THAN_TWO_LIVE_RUNS
f-dangling-ids|SAVED|0
4e-typed|ADJ|A|0|1|-1
4e-typed|ADJ|B|0|0|-1
4e-typed|POST|J1|CORNER|A|A,B
4e-typed|SAVED|1
4f-turn-0|ADJ|A|1|0|-1
4f-turn-0|ADJ|B|0|0|-1
4f-turn-0|POST|J1|LINE|A|A,B
4f-turn-0|SAVED|1
4f-turn-10|ADJ|A|1|0|-1
4f-turn-10|ADJ|B|0|0|-1
4f-turn-10|POST|J1|LINE|A|A,B
4f-turn-10|SAVED|1
4f-turn-14.9|ADJ|A|1|0|-1
4f-turn-14.9|ADJ|B|0|0|-1
4f-turn-14.9|POST|J1|LINE|A|A,B
4f-turn-14.9|SAVED|1
4f-turn-15.1|ADJ|A|0|1|-1
4f-turn-15.1|ADJ|B|0|0|-1
4f-turn-15.1|POST|J1|CORNER|A|A,B
4f-turn-15.1|SAVED|1
4f-turn-20|ADJ|A|0|1|-1
4f-turn-20|ADJ|B|0|0|-1
4f-turn-20|POST|J1|CORNER|A|A,B
4f-turn-20|SAVED|1
4f-turn-90|ADJ|A|0|1|-1
4f-turn-90|ADJ|B|0|0|-1
4f-turn-90|POST|J1|CORNER|A|A,B
4f-turn-90|SAVED|1
4f-turn-135|ADJ|A|0|1|-1
4f-turn-135|ADJ|B|0|0|-1
4f-turn-135|POST|J1|CORNER|A|A,B
4f-turn-135|SAVED|1
4j-one-end-only|IGN|J1|FEWER_THAN_TWO_LIVE_RUNS
4j-one-end-only|SAVED|0
4k-self|IGN|J1|SAME_RUN_TWICE
4k-self|SAVED|0
4l-teardown-partner|IGN|J1|FEWER_THAN_TWO_LIVE_RUNS
4l-teardown-partner|SAVED|0
4m-empty-partner|IGN|J1|FEWER_THAN_TWO_LIVE_RUNS
4m-empty-partner|SAVED|0
4n-closed-partner|IGN|J1|FEWER_THAN_TWO_LIVE_RUNS
4n-closed-partner|SAVED|0
4o-teardown-third-member|ADJ|A|1|0|-1
4o-teardown-third-member|ADJ|B|0|0|-1
4o-teardown-third-member|POST|J1|LINE|A|A,B
4o-teardown-third-member|SAVED|1
5a-coincident-no-id|SAVED|0
5b-one-pixel-off|ADJ|A|1|0|-1
5b-one-pixel-off|ADJ|B|0|0|-1
5b-one-pixel-off|POST|J1|LINE|A|A,B
5b-one-pixel-off|SAVED|1
5b-far-apart|ADJ|A|1|0|-1
5b-far-apart|ADJ|B|0|0|-1
5b-far-apart|POST|J1|LINE|A|A,B
5b-far-apart|SAVED|1
5e-two-joints-one-spot|IGN|J1|FEWER_THAN_TWO_LIVE_RUNS
5e-two-joints-one-spot|IGN|J2|FEWER_THAN_TWO_LIVE_RUNS
5e-two-joints-one-spot|SAVED|0
rnd-chain-0|ADJ|c0-0|0|1|-1
rnd-chain-0|ADJ|c0-1|1|0|-2
rnd-chain-0|ADJ|c0-2|1|0|-2
rnd-chain-0|ADJ|c0-3|0|0|-1
rnd-chain-0|POST|c0-j0|CORNER|c0-0|c0-0,c0-1
rnd-chain-0|POST|c0-j1|LINE|c0-1|c0-1,c0-2
rnd-chain-0|POST|c0-j2|LINE|c0-2|c0-2,c0-3
rnd-chain-0|SAVED|3
rnd-chain-0-flipped|ADJ|c0-0|0|1|-1
rnd-chain-0-flipped|ADJ|c0-1|1|0|-2
rnd-chain-0-flipped|ADJ|c0-2|1|0|-2
rnd-chain-0-flipped|ADJ|c0-3|0|0|-1
rnd-chain-0-flipped|POST|c0-j0|CORNER|c0-0|c0-0,c0-1
rnd-chain-0-flipped|POST|c0-j1|LINE|c0-1|c0-1,c0-2
rnd-chain-0-flipped|POST|c0-j2|LINE|c0-2|c0-2,c0-3
rnd-chain-0-flipped|SAVED|3
rnd-chain-1|ADJ|c1-0|0|1|-1
rnd-chain-1|ADJ|c1-1|0|1|-2
rnd-chain-1|ADJ|c1-2|1|0|-2
rnd-chain-1|ADJ|c1-3|0|0|-1
rnd-chain-1|POST|c1-j0|CORNER|c1-0|c1-0,c1-1
rnd-chain-1|POST|c1-j1|CORNER|c1-1|c1-1,c1-2
rnd-chain-1|POST|c1-j2|LINE|c1-2|c1-2,c1-3
rnd-chain-1|SAVED|3
rnd-chain-1-flipped|ADJ|c1-0|0|1|-1
rnd-chain-1-flipped|ADJ|c1-1|0|1|-2
rnd-chain-1-flipped|ADJ|c1-2|1|0|-2
rnd-chain-1-flipped|ADJ|c1-3|0|0|-1
rnd-chain-1-flipped|POST|c1-j0|CORNER|c1-0|c1-0,c1-1
rnd-chain-1-flipped|POST|c1-j1|CORNER|c1-1|c1-1,c1-2
rnd-chain-1-flipped|POST|c1-j2|LINE|c1-2|c1-2,c1-3
rnd-chain-1-flipped|SAVED|3
rnd-chain-2|ADJ|c2-0|1|0|-1
rnd-chain-2|ADJ|c2-1|0|1|-2
rnd-chain-2|ADJ|c2-2|1|0|-2
rnd-chain-2|ADJ|c2-3|0|1|-2
rnd-chain-2|ADJ|c2-4|1|0|-2
rnd-chain-2|ADJ|c2-5|0|0|-1
rnd-chain-2|POST|c2-j0|LINE|c2-0|c2-0,c2-1
rnd-chain-2|POST|c2-j1|CORNER|c2-1|c2-1,c2-2
rnd-chain-2|POST|c2-j2|LINE|c2-2|c2-2,c2-3
rnd-chain-2|POST|c2-j3|CORNER|c2-3|c2-3,c2-4
rnd-chain-2|POST|c2-j4|LINE|c2-4|c2-4,c2-5
rnd-chain-2|SAVED|5
rnd-chain-2-flipped|ADJ|c2-0|1|0|-1
rnd-chain-2-flipped|ADJ|c2-1|0|1|-2
rnd-chain-2-flipped|ADJ|c2-2|1|0|-2
rnd-chain-2-flipped|ADJ|c2-3|0|1|-2
rnd-chain-2-flipped|ADJ|c2-4|1|0|-2
rnd-chain-2-flipped|ADJ|c2-5|0|0|-1
rnd-chain-2-flipped|POST|c2-j0|LINE|c2-0|c2-0,c2-1
rnd-chain-2-flipped|POST|c2-j1|CORNER|c2-1|c2-1,c2-2
rnd-chain-2-flipped|POST|c2-j2|LINE|c2-2|c2-2,c2-3
rnd-chain-2-flipped|POST|c2-j3|CORNER|c2-3|c2-3,c2-4
rnd-chain-2-flipped|POST|c2-j4|LINE|c2-4|c2-4,c2-5
rnd-chain-2-flipped|SAVED|5
rnd-chain-3|ADJ|c3-0|0|1|-1
rnd-chain-3|ADJ|c3-1|1|0|-2
rnd-chain-3|ADJ|c3-2|0|1|-2
rnd-chain-3|ADJ|c3-3|1|0|-2
rnd-chain-3|ADJ|c3-4|0|0|-1
rnd-chain-3|POST|c3-j0|CORNER|c3-0|c3-0,c3-1
rnd-chain-3|POST|c3-j1|LINE|c3-1|c3-1,c3-2
rnd-chain-3|POST|c3-j2|CORNER|c3-2|c3-2,c3-3
rnd-chain-3|POST|c3-j3|LINE|c3-3|c3-3,c3-4
rnd-chain-3|SAVED|4
rnd-chain-3-flipped|ADJ|c3-0|0|1|-1
rnd-chain-3-flipped|ADJ|c3-1|1|0|-2
rnd-chain-3-flipped|ADJ|c3-2|0|1|-2
rnd-chain-3-flipped|ADJ|c3-3|1|0|-2
rnd-chain-3-flipped|ADJ|c3-4|0|0|-1
rnd-chain-3-flipped|POST|c3-j0|CORNER|c3-0|c3-0,c3-1
rnd-chain-3-flipped|POST|c3-j1|LINE|c3-1|c3-1,c3-2
rnd-chain-3-flipped|POST|c3-j2|CORNER|c3-2|c3-2,c3-3
rnd-chain-3-flipped|POST|c3-j3|LINE|c3-3|c3-3,c3-4
rnd-chain-3-flipped|SAVED|4
rnd-chain-4|ADJ|c4-0|0|1|-1
rnd-chain-4|ADJ|c4-1|0|1|-2
rnd-chain-4|ADJ|c4-2|1|0|-2
rnd-chain-4|ADJ|c4-3|0|1|-2
rnd-chain-4|ADJ|c4-4|0|1|-2
rnd-chain-4|ADJ|c4-5|0|0|-1
rnd-chain-4|POST|c4-j0|CORNER|c4-0|c4-0,c4-1
rnd-chain-4|POST|c4-j1|CORNER|c4-1|c4-1,c4-2
rnd-chain-4|POST|c4-j2|LINE|c4-2|c4-2,c4-3
rnd-chain-4|POST|c4-j3|CORNER|c4-3|c4-3,c4-4
rnd-chain-4|POST|c4-j4|CORNER|c4-4|c4-4,c4-5
rnd-chain-4|SAVED|5
rnd-chain-4-flipped|ADJ|c4-0|0|1|-1
rnd-chain-4-flipped|ADJ|c4-1|0|1|-2
rnd-chain-4-flipped|ADJ|c4-2|1|0|-2
rnd-chain-4-flipped|ADJ|c4-3|0|1|-2
rnd-chain-4-flipped|ADJ|c4-4|0|1|-2
rnd-chain-4-flipped|ADJ|c4-5|0|0|-1
rnd-chain-4-flipped|POST|c4-j0|CORNER|c4-0|c4-0,c4-1
rnd-chain-4-flipped|POST|c4-j1|CORNER|c4-1|c4-1,c4-2
rnd-chain-4-flipped|POST|c4-j2|LINE|c4-2|c4-2,c4-3
rnd-chain-4-flipped|POST|c4-j3|CORNER|c4-3|c4-3,c4-4
rnd-chain-4-flipped|POST|c4-j4|CORNER|c4-4|c4-4,c4-5
rnd-chain-4-flipped|SAVED|5
rnd-chain-5|ADJ|c5-0|0|1|-1
rnd-chain-5|ADJ|c5-1|1|0|-2
rnd-chain-5|ADJ|c5-2|0|1|-2
rnd-chain-5|ADJ|c5-3|1|0|-2
rnd-chain-5|ADJ|c5-4|0|1|-2
rnd-chain-5|ADJ|c5-5|0|0|-1
rnd-chain-5|POST|c5-j0|CORNER|c5-0|c5-0,c5-1
rnd-chain-5|POST|c5-j1|LINE|c5-1|c5-1,c5-2
rnd-chain-5|POST|c5-j2|CORNER|c5-2|c5-2,c5-3
rnd-chain-5|POST|c5-j3|LINE|c5-3|c5-3,c5-4
rnd-chain-5|POST|c5-j4|CORNER|c5-4|c5-4,c5-5
rnd-chain-5|SAVED|5
rnd-chain-5-flipped|ADJ|c5-0|0|1|-1
rnd-chain-5-flipped|ADJ|c5-1|1|0|-2
rnd-chain-5-flipped|ADJ|c5-2|0|1|-2
rnd-chain-5-flipped|ADJ|c5-3|1|0|-2
rnd-chain-5-flipped|ADJ|c5-4|0|1|-2
rnd-chain-5-flipped|ADJ|c5-5|0|0|-1
rnd-chain-5-flipped|POST|c5-j0|CORNER|c5-0|c5-0,c5-1
rnd-chain-5-flipped|POST|c5-j1|LINE|c5-1|c5-1,c5-2
rnd-chain-5-flipped|POST|c5-j2|CORNER|c5-2|c5-2,c5-3
rnd-chain-5-flipped|POST|c5-j3|LINE|c5-3|c5-3,c5-4
rnd-chain-5-flipped|POST|c5-j4|CORNER|c5-4|c5-4,c5-5
rnd-chain-5-flipped|SAVED|5
rnd-chain-6|ADJ|c6-0|1|0|-1
rnd-chain-6|ADJ|c6-1|0|1|-2
rnd-chain-6|ADJ|c6-2|0|1|-2
rnd-chain-6|ADJ|c6-3|0|1|-2
rnd-chain-6|ADJ|c6-4|0|0|-1
rnd-chain-6|POST|c6-j0|LINE|c6-0|c6-0,c6-1
rnd-chain-6|POST|c6-j1|CORNER|c6-1|c6-1,c6-2
rnd-chain-6|POST|c6-j2|CORNER|c6-2|c6-2,c6-3
rnd-chain-6|POST|c6-j3|CORNER|c6-3|c6-3,c6-4
rnd-chain-6|SAVED|4
rnd-chain-6-flipped|ADJ|c6-0|1|0|-1
rnd-chain-6-flipped|ADJ|c6-1|0|1|-2
rnd-chain-6-flipped|ADJ|c6-2|0|1|-2
rnd-chain-6-flipped|ADJ|c6-3|0|1|-2
rnd-chain-6-flipped|ADJ|c6-4|0|0|-1
rnd-chain-6-flipped|POST|c6-j0|LINE|c6-0|c6-0,c6-1
rnd-chain-6-flipped|POST|c6-j1|CORNER|c6-1|c6-1,c6-2
rnd-chain-6-flipped|POST|c6-j2|CORNER|c6-2|c6-2,c6-3
rnd-chain-6-flipped|POST|c6-j3|CORNER|c6-3|c6-3,c6-4
rnd-chain-6-flipped|SAVED|4
rnd-chain-7|ADJ|c7-0|1|0|-1
rnd-chain-7|ADJ|c7-1|0|1|-2
rnd-chain-7|ADJ|c7-2|0|1|-2
rnd-chain-7|ADJ|c7-3|0|0|-1
rnd-chain-7|POST|c7-j0|LINE|c7-0|c7-0,c7-1
rnd-chain-7|POST|c7-j1|CORNER|c7-1|c7-1,c7-2
rnd-chain-7|POST|c7-j2|CORNER|c7-2|c7-2,c7-3
rnd-chain-7|SAVED|3
rnd-chain-7-flipped|ADJ|c7-0|1|0|-1
rnd-chain-7-flipped|ADJ|c7-1|0|1|-2
rnd-chain-7-flipped|ADJ|c7-2|0|1|-2
rnd-chain-7-flipped|ADJ|c7-3|0|0|-1
rnd-chain-7-flipped|POST|c7-j0|LINE|c7-0|c7-0,c7-1
rnd-chain-7-flipped|POST|c7-j1|CORNER|c7-1|c7-1,c7-2
rnd-chain-7-flipped|POST|c7-j2|CORNER|c7-2|c7-2,c7-3
rnd-chain-7-flipped|SAVED|3
6g-seven-plus-seven|ADJ|A|1|0|-1
6g-seven-plus-seven|ADJ|B|0|0|-1
6g-seven-plus-seven|POST|J1|LINE|A|A,B
6g-seven-plus-seven|SAVED|1
rnd-ring-0|ADJ|r0-0|0|2|-2
rnd-ring-0|ADJ|r0-1|0|1|-2
rnd-ring-0|ADJ|r0-2|0|1|-2
rnd-ring-0|ADJ|r0-3|0|0|-2
rnd-ring-0|POST|r0-j0|CORNER|r0-0|r0-0,r0-1
rnd-ring-0|POST|r0-j1|CORNER|r0-1|r0-1,r0-2
rnd-ring-0|POST|r0-j2|CORNER|r0-2|r0-2,r0-3
rnd-ring-0|POST|r0-j3|CORNER|r0-0|r0-0,r0-3
rnd-ring-0|SAVED|4
rnd-ring-1|ADJ|r1-0|0|2|-2
rnd-ring-1|ADJ|r1-1|0|1|-2
rnd-ring-1|ADJ|r1-2|0|1|-2
rnd-ring-1|ADJ|r1-3|0|1|-2
rnd-ring-1|ADJ|r1-4|0|1|-2
rnd-ring-1|ADJ|r1-5|0|0|-2
rnd-ring-1|POST|r1-j0|CORNER|r1-0|r1-0,r1-1
rnd-ring-1|POST|r1-j1|CORNER|r1-1|r1-1,r1-2
rnd-ring-1|POST|r1-j2|CORNER|r1-2|r1-2,r1-3
rnd-ring-1|POST|r1-j3|CORNER|r1-3|r1-3,r1-4
rnd-ring-1|POST|r1-j4|CORNER|r1-4|r1-4,r1-5
rnd-ring-1|POST|r1-j5|CORNER|r1-0|r1-0,r1-5
rnd-ring-1|SAVED|6
rnd-ring-2|ADJ|r2-0|0|2|-2
rnd-ring-2|ADJ|r2-1|0|1|-2
rnd-ring-2|ADJ|r2-2|0|1|-2
rnd-ring-2|ADJ|r2-3|0|0|-2
rnd-ring-2|POST|r2-j0|CORNER|r2-0|r2-0,r2-1
rnd-ring-2|POST|r2-j1|CORNER|r2-1|r2-1,r2-2
rnd-ring-2|POST|r2-j2|CORNER|r2-2|r2-2,r2-3
rnd-ring-2|POST|r2-j3|CORNER|r2-0|r2-0,r2-3
rnd-ring-2|SAVED|4
rnd-ring-3|ADJ|r3-0|0|2|-2
rnd-ring-3|ADJ|r3-1|0|1|-2
rnd-ring-3|ADJ|r3-2|0|1|-2
rnd-ring-3|ADJ|r3-3|0|1|-2
rnd-ring-3|ADJ|r3-4|0|1|-2
rnd-ring-3|ADJ|r3-5|0|0|-2
rnd-ring-3|POST|r3-j0|CORNER|r3-0|r3-0,r3-1
rnd-ring-3|POST|r3-j1|CORNER|r3-1|r3-1,r3-2
rnd-ring-3|POST|r3-j2|CORNER|r3-2|r3-2,r3-3
rnd-ring-3|POST|r3-j3|CORNER|r3-3|r3-3,r3-4
rnd-ring-3|POST|r3-j4|CORNER|r3-4|r3-4,r3-5
rnd-ring-3|POST|r3-j5|CORNER|r3-0|r3-0,r3-5
rnd-ring-3|SAVED|6
sweep--179|ADJ|A|0|1|-1
sweep--179|ADJ|B|0|0|-1
sweep--179|POST|J1|CORNER|A|A,B
sweep--179|SAVED|1
sweep--135|ADJ|A|0|1|-1
sweep--135|ADJ|B|0|0|-1
sweep--135|POST|J1|CORNER|A|A,B
sweep--135|SAVED|1
sweep--90|ADJ|A|0|1|-1
sweep--90|ADJ|B|0|0|-1
sweep--90|POST|J1|CORNER|A|A,B
sweep--90|SAVED|1
sweep--45|ADJ|A|0|1|-1
sweep--45|ADJ|B|0|0|-1
sweep--45|POST|J1|CORNER|A|A,B
sweep--45|SAVED|1
sweep--20|ADJ|A|0|1|-1
sweep--20|ADJ|B|0|0|-1
sweep--20|POST|J1|CORNER|A|A,B
sweep--20|SAVED|1
sweep--15.01|ADJ|A|0|1|-1
sweep--15.01|ADJ|B|0|0|-1
sweep--15.01|POST|J1|CORNER|A|A,B
sweep--15.01|SAVED|1
sweep--14.99|ADJ|A|1|0|-1
sweep--14.99|ADJ|B|0|0|-1
sweep--14.99|POST|J1|LINE|A|A,B
sweep--14.99|SAVED|1
sweep--5|ADJ|A|1|0|-1
sweep--5|ADJ|B|0|0|-1
sweep--5|POST|J1|LINE|A|A,B
sweep--5|SAVED|1
sweep-0|ADJ|A|1|0|-1
sweep-0|ADJ|B|0|0|-1
sweep-0|POST|J1|LINE|A|A,B
sweep-0|SAVED|1
sweep-4|ADJ|A|1|0|-1
sweep-4|ADJ|B|0|0|-1
sweep-4|POST|J1|LINE|A|A,B
sweep-4|SAVED|1
sweep-10|ADJ|A|1|0|-1
sweep-10|ADJ|B|0|0|-1
sweep-10|POST|J1|LINE|A|A,B
sweep-10|SAVED|1
sweep-14|ADJ|A|1|0|-1
sweep-14|ADJ|B|0|0|-1
sweep-14|POST|J1|LINE|A|A,B
sweep-14|SAVED|1
sweep-14.5|ADJ|A|1|0|-1
sweep-14.5|ADJ|B|0|0|-1
sweep-14.5|POST|J1|LINE|A|A,B
sweep-14.5|SAVED|1
sweep-14.9|ADJ|A|1|0|-1
sweep-14.9|ADJ|B|0|0|-1
sweep-14.9|POST|J1|LINE|A|A,B
sweep-14.9|SAVED|1
sweep-14.99|ADJ|A|1|0|-1
sweep-14.99|ADJ|B|0|0|-1
sweep-14.99|POST|J1|LINE|A|A,B
sweep-14.99|SAVED|1
sweep-14.999|ADJ|A|1|0|-1
sweep-14.999|ADJ|B|0|0|-1
sweep-14.999|POST|J1|LINE|A|A,B
sweep-14.999|SAVED|1
sweep-15|ADJ|A|1|0|-1
sweep-15|ADJ|B|0|0|-1
sweep-15|POST|J1|LINE|A|A,B
sweep-15|SAVED|1
sweep-15.001|ADJ|A|0|1|-1
sweep-15.001|ADJ|B|0|0|-1
sweep-15.001|POST|J1|CORNER|A|A,B
sweep-15.001|SAVED|1
sweep-15.01|ADJ|A|0|1|-1
sweep-15.01|ADJ|B|0|0|-1
sweep-15.01|POST|J1|CORNER|A|A,B
sweep-15.01|SAVED|1
sweep-15.1|ADJ|A|0|1|-1
sweep-15.1|ADJ|B|0|0|-1
sweep-15.1|POST|J1|CORNER|A|A,B
sweep-15.1|SAVED|1
sweep-16|ADJ|A|0|1|-1
sweep-16|ADJ|B|0|0|-1
sweep-16|POST|J1|CORNER|A|A,B
sweep-16|SAVED|1
sweep-20|ADJ|A|0|1|-1
sweep-20|ADJ|B|0|0|-1
sweep-20|POST|J1|CORNER|A|A,B
sweep-20|SAVED|1
sweep-30|ADJ|A|0|1|-1
sweep-30|ADJ|B|0|0|-1
sweep-30|POST|J1|CORNER|A|A,B
sweep-30|SAVED|1
sweep-45|ADJ|A|0|1|-1
sweep-45|ADJ|B|0|0|-1
sweep-45|POST|J1|CORNER|A|A,B
sweep-45|SAVED|1
sweep-60|ADJ|A|0|1|-1
sweep-60|ADJ|B|0|0|-1
sweep-60|POST|J1|CORNER|A|A,B
sweep-60|SAVED|1
sweep-90|ADJ|A|0|1|-1
sweep-90|ADJ|B|0|0|-1
sweep-90|POST|J1|CORNER|A|A,B
sweep-90|SAVED|1
sweep-120|ADJ|A|0|1|-1
sweep-120|ADJ|B|0|0|-1
sweep-120|POST|J1|CORNER|A|A,B
sweep-120|SAVED|1
sweep-135|ADJ|A|0|1|-1
sweep-135|ADJ|B|0|0|-1
sweep-135|POST|J1|CORNER|A|A,B
sweep-135|SAVED|1
sweep-170|ADJ|A|0|1|-1
sweep-170|ADJ|B|0|0|-1
sweep-170|POST|J1|CORNER|A|A,B
sweep-170|SAVED|1
sweep-179|ADJ|A|0|1|-1
sweep-179|ADJ|B|0|0|-1
sweep-179|POST|J1|CORNER|A|A,B
sweep-179|SAVED|1
`;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failedIds = [];

function ok(id, label, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok    ${id} ${label}`); }
  else { failed++; failedIds.push(id); console.log(`  FAIL  ${id} ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const fmtP = (p) => `${p.line} line + ${p.corner} corner + ${p.end} end = ${p.total} posts`;
/** Compare four post figures. The failure line says what the RIGHT count is, so whoever broke it knows what to fix. */
function expectPosts(id, label, got, want, why = "") {
  const same = got.line === want.line && got.corner === want.corner && got.end === want.end && got.total === want.total;
  ok(id, label, same, `RIGHT COUNT is ${fmtP(want)}; got ${fmtP(got)}.${why ? " " + why : ""}`);
}
function expectEq(id, label, got, want, why = "") {
  ok(id, label, JSON.stringify(got) === JSON.stringify(want), `RIGHT VALUE is ${JSON.stringify(want)}; got ${JSON.stringify(got)}.${why ? " " + why : ""}`);
}
const P = (line, corner, end, total) => ({ line, corner, end, total });

// ---------------------------------------------------------------------------
// The TRANSCRIPTION of RunJoinArithmetic (FenceGeometry.kt). Same structure, same
// order of operations, same Float discipline (f32) as the Kotlin it mirrors.
// ---------------------------------------------------------------------------
const RADIANS_TO_DEGREES = 57.29577951308232; // java.lang.Math.toDegrees since JDK 9; the same constant geometry.ts uses

const isLive = (run) => !run.isTeardown && run.geometry.endCount >= 2;

function endAndNeighbour(member) {
  const v = member.run.geometry.vertices;
  if (v.length < 2) return null;
  return member.atEnd ? [v[v.length - 1].point, v[v.length - 2].point] : [v[0].point, v[1].point];
}

/** How far the fence turns where two runs meet; null when there is nothing to measure. */
function turnDegrees(first, second) {
  const a = endAndNeighbour(first);
  if (a === null) return null;
  const b = endAndNeighbour(second);
  if (b === null) return null;
  const [aEnd, aNext] = a;
  const [bEnd, bNext] = b;
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

const outranks = (a, b) => {
  if (a.heightFt !== b.heightFt) return a.heightFt > b.heightFt;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder < b.sortOrder;
  return a.id < b.id;
};

function kindOf(live) {
  if (live.length >= 3) return "CORNER";
  const firstIsZero = live[0].run.id < live[1].run.id;
  const first = firstIsZero ? live[0] : live[1];
  const second = firstIsZero ? live[1] : live[0];
  const turn = turnDegrees(first, second);
  if (turn === null) return "CORNER";
  return turn >= CORNER_ANGLE_THRESHOLD_DEGREES ? "CORNER" : "LINE";
}

/** runs: [{ id, geometry, heightFt, sortOrder, isTeardown, startJointId, endJointId }]  ->  the whole job's adjustment. */
function adjustJoins(runs) {
  const byJoint = new Map();
  const add = (jointId, run, atEnd) => {
    if (jointId.trim() === "") return;
    if (!byJoint.has(jointId)) byJoint.set(jointId, []);
    byJoint.get(jointId).push({ run, atEnd });
  };
  for (const run of runs) {
    add(run.startJointId, run, false);
    add(run.endJointId, run, true);
  }
  const result = (perRun, posts, ignored) => {
    let saved = 0;
    for (const a of Object.values(perRun)) saved -= a.line + a.corner + a.end;
    return {
      perRun, posts, ignored, postsSaved: saved,
      changesNothing: Object.keys(perRun).length === 0,
      forRun: (id) => perRun[id] ?? { line: 0, corner: 0, end: 0 },
    };
  };
  // Zero joints: nothing to look at, nothing moves.
  if (byJoint.size === 0) return result({}, [], []);

  const deltas = new Map();
  const bump = (runId, line, corner, end) => {
    const cell = deltas.get(runId) ?? [0, 0, 0];
    cell[0] += line; cell[1] += corner; cell[2] += end;
    deltas.set(runId, cell);
  };
  const posts = [];
  const ignored = [];

  for (const jointId of [...byJoint.keys()].sort()) {
    const live = byJoint.get(jointId).filter((m) => isLive(m.run));
    if (live.length < 2) { ignored.push({ jointId, reason: "FEWER_THAN_TWO_LIVE_RUNS" }); continue; }
    let sameRunTwice = false;
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) if (live[i].run.id === live[j].run.id) sameRunTwice = true;
    if (sameRunTwice) { ignored.push({ jointId, reason: "SAME_RUN_TWICE" }); continue; }

    let owner = live[0];
    for (let i = 1; i < live.length; i++) if (outranks(live[i].run, owner.run)) owner = live[i];
    const kind = kindOf(live);
    for (const member of live) {
      if (member === owner) {
        if (kind === "CORNER") bump(member.run.id, 0, 1, -1); else bump(member.run.id, 1, 0, -1);
      } else bump(member.run.id, 0, 0, -1);
    }
    posts.push({ jointId, kind, ownerRunId: owner.run.id, memberRunIds: live.map((m) => m.run.id).sort() });
  }

  const perRun = {};
  for (const runId of [...deltas.keys()].sort()) {
    const [line, corner, end] = deltas.get(runId);
    if (line !== 0 || corner !== 0 || end !== 0) perRun[runId] = { line, corner, end };
  }
  return result(perRun, posts, ignored);
}

/** RunPostTally.adjustedBy: deltas added AFTER computePostCounts, gate posts carried through. */
function applyAdjustment(base, adj) {
  const line = base.line + adj.line, corner = base.corner + adj.corner, end = base.end + adj.end;
  return { line, corner, end, gate: base.gate, total: line + corner + end + base.gate, terminal: corner + end + base.gate };
}

// ---------------------------------------------------------------------------
// Scenarios. One spec per run; the SAME spec feeds the real engine (alone), the
// transcription, and the Kotlin cross-check, so the three cannot be looking at
// different jobs.
// ---------------------------------------------------------------------------
const PPF = 20; // the grid's own scale: 6 ft = 120 px
const pts = (...p) => p.map(([x, y]) => `${x}:${y}`).join(",");

function R(id, points, o = {}) {
  return { id, points, closed: false, manual: null, height: 6, sort: 0, teardown: false, start: "", end: "", gates: "", spacing: 6, bags: 1, type: "VINYL", extra: {}, ...o };
}

export const scenarios = [];
const sc = (name, specs) => {
  if (scenarios.some((s) => s.name === name)) throw new Error(`duplicate scenario name ${name}`);
  scenarios.push({ name, specs });
  return specs;
};

const JOB = {
  calibration_pixels_per_foot: null,
  tax_rate_percent: 0, markup_percent: 0, discount_percent: 0,
  labor_rate_per_ft: 8, labor_flat_fee: 0, minimum_job_charge: 0, minimum_labor_charge: 0,
  waste_percent: 0, gate_rate_per_ft: 20, trash_haul_fee: 0,
  teardown_enabled: false, teardown_flat_fee: 0, teardown_rate_per_ft: 0, teardown_feet: 0,
  preferred_manufacturer_sync_id: null,
};

function runRow(s) {
  return {
    sync_id: s.id, label: s.id, fence_type: s.type, color_or_finish: "",
    points_encoded: s.points, gates_encoded: s.gates, closed_loop: s.closed,
    manual_linear_feet: s.manual, manual_corner_count: 0,
    panel_width_ft: 6, panel_height_ft: s.height, post_spacing_ft: s.spacing, concrete_bags_per_post: s.bags,
    aluminum_style: "RACKABLE", wood_style: "PRIVACY", wood_rail_count: 3, picket_width_in: 5.5, picket_gap_in: 0,
    fabric_height_ft: 4, include_top_rail: true, include_tension_wire: false, include_barbed_wire_arms: false,
    include_privacy_slats: false, split_rail_count: 2, suppressed_roles: "",
    is_teardown: s.teardown, sort_order: s.sort,
    ...s.extra,
  };
}
function priceRows(rows, jobOverrides = {}) {
  return priceJob({
    engine_version: PRICING_ENGINE_VERSION, pixels_per_foot: PPF,
    job: { ...JOB, ...jobOverrides }, runs: rows, catalog: [], manufacturers: [], change_orders: [], existing_items: [],
  });
}
/** The real engine's answer for ONE run priced on its own: what that run bills with no joint anywhere. */
const aloneCache = new Map();
function alone(spec) {
  const key = JSON.stringify({ ...spec, id: "x", sort: 0, teardown: false, start: "", end: "" });
  if (!aloneCache.has(key)) aloneCache.set(key, priceRows([runRow({ ...spec, id: "x", sort: 0, teardown: false })]).runs[0].posts);
  return aloneCache.get(key);
}
/** resolveGeometry, as the engine computes it: typed footage wins, otherwise the drawing. */
function geometryOf(s) {
  if (s.manual !== null && s.manual > 0) {
    return { totalLinearFeet: s.manual, segments: [], vertices: [], cornerCount: 0, endCount: s.closed ? 0 : 2, lineVertexCount: 0 };
  }
  return analyze(decodePoints(s.points), PPF, s.closed);
}
const toJoinable = (s) => ({
  id: s.id, geometry: geometryOf(s), heightFt: f32(s.height), sortOrder: s.sort,
  isTeardown: s.teardown, startJointId: s.start, endJointId: s.end,
});
const sumPosts = (list) => list.reduce((t, p) => ({ line: t.line + p.line, corner: t.corner + p.corner, end: t.end + p.end, gate: t.gate + p.gate, total: t.total + p.total }), { line: 0, corner: 0, end: 0, gate: 0, total: 0 });

/** Real per-run counts + the adjustment on top. `fence` sums only the runs that bill materials. */
function compose(name, specs) {
  if (name !== null) sc(name, specs);
  const base = specs.map(alone);
  const adj = adjustJoins(specs.map(toJoinable));
  const after = specs.map((s, i) => applyAdjustment(base[i], adj.forRun(s.id)));
  const billed = (list) => list.filter((_, i) => !specs[i].teardown);
  return { specs, base, adj, after, fenceBefore: sumPosts(billed(base)), fence: sumPosts(billed(after)), byId: Object.fromEntries(specs.map((s, i) => [s.id, after[i]])) };
}

// Legs: 30 ft, 17 ft and 24 ft, so the per-leg bay counts (5, 3, 4) add up to the polyline's (12 for 71 ft).
const A_PTS = pts([0, 0], [600, 0]);
const B_STRAIGHT = pts([600, 0], [940, 0]);
const C_STRAIGHT = pts([940, 0], [1420, 0]);
const B_UP = pts([600, 0], [600, 340]);

// =============================================================================
console.log("\n1. BASE -- what the REAL engine says for each piece alone. Every number below is derived from these.");
// =============================================================================
{
  const a30 = alone(R("a", A_PTS)), b17 = alone(R("b", B_STRAIGHT)), c24 = alone(R("c", C_STRAIGHT));
  expectPosts("B1", "30 ft alone: bays 5, estimate 6, minus 2 ends = 4 line", a30, P(4, 0, 2, 6), "If this moved, computePostCounts changed: every expected number below must be re-derived.");
  expectPosts("B2", "17 ft alone: bays 3, estimate 4 = 2 line + 2 end", b17, P(2, 0, 2, 4));
  expectPosts("B3", "24 ft alone: bays 4, estimate 5 = 3 line + 2 end", c24, P(3, 0, 2, 5));
  expectPosts("B4", "one 47 ft polyline = 7 line + 2 end = 9 (the figure two joined straight runs must reproduce)", alone(R("p", pts([0, 0], [940, 0]))), P(7, 0, 2, 9));
  expectPosts("B5", "one 71 ft polyline = 11 line + 2 end = 13", alone(R("p", pts([0, 0], [1420, 0]))), P(11, 0, 2, 13));
  expectPosts("B6", "one open L (30 ft then 17 ft up) = 6 line + 1 corner + 2 end = 9", alone(R("p", pts([0, 0], [600, 0], [600, 340]))), P(6, 1, 2, 9));
  expectPosts("B7", "one CLOSED 30x17 loop = 12 line + 4 corner + 0 end = 16 (no +1: the last bay lands on the first post)",
    alone(R("p", pts([0, 0], [600, 0], [600, 340], [0, 340]), { closed: true })), P(12, 4, 0, 16));
  expectPosts("B8", "one OPEN 4-leg chain (30,17,30,17) = 12 line + 3 corner + 2 end = 17", alone(R("p", pts([0, 0], [600, 0], [600, 340], [0, 340], [0, 0]))), P(12, 3, 2, 17));
  const gated = alone(R("g", A_PTS, { gates: "590:0:4:LINE:IN" }));
  expectPosts("B9", "30 ft with one 4 ft LINE gate = 3 line + 2 end + 2 gate = 7 (net 26 ft: bays 5, estimate 5 + 1 - 1 gate = 5)", gated, P(3, 0, 2, 7));
  expectEq("B9g", "...and that gate contributes 2 gate posts", gated.gate, 2);
}

// =============================================================================
console.log("\n2. THE CASES -- posts before and after joining, by type (hand-derived numbers)");
// =============================================================================
// ---- a. two open runs joined at one endpoint each
{
  const straight = (joined) => [
    R("A", A_PTS, { sort: 0, end: joined ? "J1" : "" }),
    R("B", B_STRAIGHT, { sort: 1, start: joined ? "J1" : "" }),
  ];
  const u = compose("a-unjoined", straight(false));
  expectPosts("2a-0", "BEFORE (not joined): 10 posts = 6 line + 4 end -- two runs meeting at a point bill four end posts", u.fence, P(6, 0, 4, 10));
  const j = compose("a-straight", straight(true));
  expectPosts("2a-1", "AFTER joining, straight: 9 posts = 7 line + 0 corner + 2 end (the shared post is a LINE post)", j.fence, P(7, 0, 2, 9),
    "10 - 1: the two end posts at the joint become ONE post.");
  expectPosts("2a-2", "  run A (owner, lower sort order) keeps the post: its end becomes a line post -> 5 line + 1 end = 6", j.byId.A, P(5, 0, 1, 6));
  expectPosts("2a-3", "  run B gives its end post up -> 2 line + 1 end = 3", j.byId.B, P(2, 0, 1, 3));
  expectEq("2a-4", "  the joint is a LINE post owned by A, degree 2", j.adj.posts.map((p) => [p.kind, p.ownerRunId, p.memberRunIds.length]), [["LINE", "A", 2]]);
  expectEq("2a-5", "  one post saved", j.adj.postsSaved, 1);
  expectPosts("2a-6", "  equals what the real engine says for ONE 47 ft run through the same points", j.fence, alone(R("p", pts([0, 0], [940, 0]))));

  const l = compose("a-corner90", [R("A", A_PTS, { sort: 0, end: "J1" }), R("B", B_UP, { sort: 1, start: "J1" })]);
  expectPosts("2a-7", "the same two at 90 degrees: 9 posts = 6 line + 1 corner + 2 end (the shared post is a CORNER post)", l.fence, P(6, 1, 2, 9));
  expectPosts("2a-8", "  equals the real engine's ONE L-shaped run through the same points", l.fence, alone(R("p", pts([0, 0], [600, 0], [600, 340]))));
}

// ---- the trap: why the answer is NOT had by editing endPosts before computePostCounts
{
  const gA = analyze(decodePoints(A_PTS), PPF, false), gB = analyze(decodePoints(B_STRAIGHT), PPF, false);
  const totalOf = (g, corner, end) => computePostCounts({ ...g, cornerCount: corner, endCount: end }, [], 6, g.totalLinearFeet).totalPosts;
  const untouched = totalOf(gA, 0, 2) + totalOf(gB, 0, 2);
  const naiveEndsOnly = totalOf(gA, 0, 1) + totalOf(gB, 0, 1);
  const naiveEndToCorner = totalOf(gA, 1, 1) + totalOf(gB, 1, 1);
  const naiveOwnerOnly = totalOf(gA, 1, 1) + totalOf(gB, 0, 1);
  expectEq("2a-naive-0", "premise (real computePostCounts): the two runs total 10 with no change", untouched, 10);
  ok("2a-naive-1", "feeding computePostCounts one fewer END post per run leaves the TOTAL at 10 (the pool is fixed; the post comes back as a line post)",
    naiveEndsOnly === 10, `RIGHT: 10 (unchanged). got ${naiveEndsOnly}. The saving can only be applied AFTER computePostCounts, as a delta.`);
  ok("2a-naive-2", "...and turning one end of each run into a corner changes it only by label: still 10", naiveEndToCorner === 10, `got ${naiveEndToCorner}`);
  ok("2a-naive-3", "...and doing it for the owner only, still 10", naiveOwnerOnly === 10, `got ${naiveOwnerOnly}`);
  const viaDelta = compose(null, [R("A", A_PTS, { sort: 0, end: "J1" }), R("B", B_STRAIGHT, { sort: 1, start: "J1" })]).fence.total;
  expectEq("2a-naive-4", "the delta applied afterwards gives 9 -- one less than any pre-adjusted count can", viaDelta, 9);
}

// ---- b. three runs joined in a line
{
  const chain = (joined) => [
    R("A", A_PTS, { sort: 0, end: joined ? "J1" : "" }),
    R("B", B_STRAIGHT, { sort: 1, start: joined ? "J1" : "", end: joined ? "J2" : "" }),
    R("C", C_STRAIGHT, { sort: 2, start: joined ? "J2" : "" }),
  ];
  expectPosts("2b-0", "BEFORE: 15 posts = 9 line + 6 end", compose("b-unjoined", chain(false)).fence, P(9, 0, 6, 15));
  const j = compose("b-chain", chain(true));
  expectPosts("2b-1", "AFTER two joints, straight: 13 posts = 11 line + 0 corner + 2 end (two posts saved)", j.fence, P(11, 0, 2, 13));
  expectPosts("2b-2", "  A (owns joint 1) 5 line + 1 end = 6", j.byId.A, P(5, 0, 1, 6));
  expectPosts("2b-3", "  B gives its start end up and owns joint 2: 3 line + 0 end = 3", j.byId.B, P(3, 0, 0, 3));
  expectPosts("2b-4", "  C gives its start end up: 3 line + 1 end = 4", j.byId.C, P(3, 0, 1, 4));
  expectPosts("2b-5", "  equals the real engine's ONE 71 ft run", j.fence, alone(R("p", pts([0, 0], [1420, 0]))));
  expectEq("2b-6", "  two posts saved", j.adj.postsSaved, 2);
}

// ---- c. a chain joined back on itself is NOT a run whose closed_loop flag is set
{
  const A = pts([0, 0], [600, 0]), B = pts([600, 0], [600, 340]), C = pts([600, 340], [0, 340]), D = pts([0, 340], [0, 0]);
  const ring = (closeIt) => [
    R("A", A, { sort: 0, start: closeIt ? "J4" : "", end: "J1" }),
    R("B", B, { sort: 1, start: "J1", end: "J2" }),
    R("C", C, { sort: 2, start: "J2", end: "J3" }),
    R("D", D, { sort: 3, start: "J3", end: closeIt ? "J4" : "" }),
  ];
  const un = compose("c-unjoined", ring(false).map((r) => ({ ...r, start: "", end: "" })));
  expectPosts("2c-0", "BEFORE: four open runs = 20 posts = 12 line + 8 end", un.fence, P(12, 0, 8, 20));
  const j = compose("c-ring", ring(true));
  expectPosts("2c-1", "AFTER four joints, ring closed: 16 posts = 12 line + 4 corner + 0 end", j.fence, P(12, 4, 0, 16),
    "Each of the four joints is a 90 degree corner: ends 8 -> 0, corners 0 -> 4, total 20 - 4.");
  expectPosts("2c-2", "  A owns joints 1 and 4: 4 line + 2 corner = 6", j.byId.A, P(4, 2, 0, 6));
  expectPosts("2c-3", "  B owns joint 2: 2 line + 1 corner = 3", j.byId.B, P(2, 1, 0, 3));
  expectPosts("2c-4", "  C owns joint 3: 4 line + 1 corner = 5", j.byId.C, P(4, 1, 0, 5));
  expectPosts("2c-5", "  D gives both ends up: 2 line = 2", j.byId.D, P(2, 0, 0, 2));
  const loop = alone(R("p", pts([0, 0], [600, 0], [600, 340], [0, 340]), { closed: true }));
  expectPosts("2c-6", "  the same count the real engine gives ONE closed_loop run (16) -- but reached by a different road", j.fence, loop);
  ok("2c-7", "  the different road: every ring run is OPEN (2 free ends each, estimate bays + 1 each); only the joints remove the doubles",
    j.specs.every((s) => geometryOf(s).endCount === 2) && j.fenceBefore.total === 20 && loop.end === 0 && loop.total === 16,
    "A closed_loop run has endCount 0 and an estimate of bays (no +1); four open runs have +1 EACH, and the four joints take the four extras back out.");
  const chain = compose("c-chain-open", ring(false));
  expectPosts("2c-8", "the same four runs with the LAST joint missing: 17 posts = 12 line + 3 corner + 2 end (that joint is what closes the loop)", chain.fence, P(12, 3, 2, 17));
  expectPosts("2c-9", "  equals the real engine's open 4-leg polyline", chain.fence, alone(R("p", pts([0, 0], [600, 0], [600, 340], [0, 340], [0, 0]))));
}

// ---- d. a T: three ends meeting at one point
{
  const tee = (joined) => [
    R("A", pts([-600, 0], [0, 0]), { sort: 0, end: joined ? "J1" : "" }),
    R("B", pts([0, 0], [340, 0]), { sort: 1, start: joined ? "J1" : "" }),
    R("C", pts([0, 0], [0, 480]), { sort: 2, start: joined ? "J1" : "" }),
  ];
  expectPosts("2d-0", "BEFORE: 15 posts = 9 line + 6 end (three runs, six end posts)", compose("d-unjoined", tee(false)).fence, P(9, 0, 6, 15));
  const j = compose("d-tee", tee(true));
  expectPosts("2d-1", "AFTER: 13 posts = 9 line + 1 CORNER + 3 end -- three ends at one point is ONE post in the ground, so TWO posts go", j.fence, P(9, 1, 3, 13));
  expectPosts("2d-2", "  A owns it: 4 line + 1 corner + 1 end = 6", j.byId.A, P(4, 1, 1, 6));
  expectPosts("2d-3", "  B and C each give their end up: 2 line + 1 end = 3, and 3 line + 1 end = 4", { line: j.byId.B.line + j.byId.C.line, corner: j.byId.B.corner + j.byId.C.corner, end: j.byId.B.end + j.byId.C.end, total: j.byId.B.total + j.byId.C.total }, P(5, 0, 2, 7));
  expectEq("2d-4", "  the joint has degree 3 and is a CORNER post", j.adj.posts.map((p) => [p.kind, p.memberRunIds.length]), [["CORNER", 3]]);
  expectEq("2d-5", "  two posts saved (degree - 1)", j.adj.postsSaved, 2);
  // The defence of the type: the two legs A and B are collinear, so a pairwise "is it straight?" rule would call this a LINE post.
  const turnAB = turnDegrees({ run: toJoinable(j.specs[0]), atEnd: true }, { run: toJoinable(j.specs[1]), atEnd: false });
  ok("2d-6", "  TEETH: A and B are collinear (turn 0 degrees), yet the T is a CORNER -- a post three runs leave from is never a pass-through",
    turnAB === 0 && j.adj.posts[0].kind === "CORNER", `RIGHT: CORNER. A to B turns ${turnAB} degrees; a straight-through LINE post here is a light post carrying the heaviest load on the job.`);
  const y = compose("d-fork", [
    R("A", pts([-600, 0], [0, 0]), { sort: 0, end: "J1" }),
    R("B", pts([0, 0], [600, 0]), { sort: 1, start: "J1" }),
    R("C", pts([0, 0], [600, 52]), { sort: 2, start: "J1" }),
  ]);
  expectEq("2d-7", "  a fork where all three legs are within 15 degrees of collinear is STILL a corner", y.adj.posts.map((p) => p.kind), ["CORNER"]);
  const cross = compose("d-cross", [
    R("A", pts([-600, 0], [0, 0]), { sort: 0, end: "J1" }),
    R("B", pts([0, 0], [600, 0]), { sort: 1, start: "J1" }),
    R("C", pts([0, 0], [0, 600]), { sort: 2, start: "J1" }),
    R("D", pts([0, 600], [0, 0]), { sort: 3, end: "J1" }),
  ]);
  expectPosts("2d-8", "  four 30 ft runs meeting at one point (a cross): 24 -> 21 posts = 16 line + 1 corner + 4 end (degree 4 saves 3)", cross.fence, P(16, 1, 4, 21));
}

// ---- e. a join at a point where one side also has a GATE at that end
{
  const mk = (gatesA, gatesB, joined = true) => [
    R("A", A_PTS, { sort: 0, end: joined ? "J1" : "", gates: gatesA }),
    R("B", B_STRAIGHT, { sort: 1, start: joined ? "J1" : "", gates: gatesB }),
  ];
  const un = compose("e-unjoined", mk("590:0:4:LINE:IN", "", false));
  expectPosts("2e-0", "BEFORE: gated 30 ft run (3 line + 2 end + 2 gate = 7) + 17 ft run (4) = 11 posts (5 line + 4 end + 2 gate)", un.fence, P(5, 0, 4, 11));
  const j = compose("e-gate-at-joint", mk("590:0:4:LINE:IN", ""));
  expectEq("2e-1", "AFTER joining: 10 posts, not 11 -- the join still saves exactly ONE", j.fence.total, 10, "A gate's posts are never touched by a join; only the duplicate at the joint goes.");
  expectEq("2e-2", "  gate posts are unchanged: still 2", j.fence.gate, 2);
  expectPosts("2e-3", "  A keeps its 2 gate posts and the shared post: 4 line + 1 end + 2 gate = 7 posts", j.byId.A, P(4, 0, 1, 7));
  expectPosts("2e-4", "  B gives its end up: 2 line + 1 end = 3", j.byId.B, P(2, 0, 1, 3));
  // Why one and not zero or two: the engine's own total for a gated run is already the physical count of posts in it,
  // INCLUDING the post at the end the gate stands against (the estimate drops one position per gate to absorb the overlap).
  // 30 ft with a 4 ft gate: posts at 0, 5.2, 10.4, 15.6, 20.8, 26 (hinge) and 30 (latch) = 7 = the engine's 7. The 17 ft run
  // adds 3 more past the shared post at 30. 7 + 3 = 10.
  const gateAtFar = compose("e-gate-far-end", [R("A", A_PTS, { sort: 0, end: "J1", gates: "10:0:4:LINE:IN" }), R("B", B_STRAIGHT, { sort: 1, start: "J1" })]);
  expectEq("2e-5", "  the gate's position along the run is irrelevant (the count never reads it): a gate at the far end also gives 10", gateAtFar.fence.total, 10);
  const both = compose("e-gates-both-sides", mk("590:0:4:LINE:IN", "10:0:4:LINE:IN"));
  expectEq("2e-6", "  a gate on EACH side of the joint: 12 posts before, 11 after (still one saved), gate posts 4", [both.fenceBefore.total, both.fence.total, both.fence.gate], [12, 11, 4]);
  const toWall = compose("e-gate-line-to-wall", mk("590:0:4:LINE_TO_WALL:IN", ""));
  expectEq("2e-7", "  a LINE_TO_WALL gate (3 gate posts): 12 before, 11 after, gate posts 3", [toWall.fenceBefore.total, toWall.fence.total, toWall.fence.gate], [12, 11, 3]);
  const gatedOwnsNot = compose("e-gate-run-gives-up", [
    R("B", B_STRAIGHT, { sort: 0, height: 4, start: "J1" }),
    R("A", A_PTS, { sort: 1, height: 6, end: "J1", gates: "590:0:4:LINE:IN" }),
  ]);
  expectEq("2e-8", "  who owns the post does not change the total: the taller gated run owns it, 10 again", gatedOwnsNot.fence.total, 10);
}

// ---- f. no joints at all: identical to today, to the post
{
  const job = [
    R("S1", A_PTS, { sort: 0, gates: "100:0:4:LINE:IN" }),
    R("S2", pts([0, 0], [600, 0], [600, 340], [0, 340]), { sort: 1, closed: true }),
    R("S3", "", { sort: 2, manual: 48 }),
    R("S4", B_UP, { sort: 3, teardown: true }),
    R("S5", C_STRAIGHT, { sort: 4, type: "CHAIN_LINK" }),
  ];
  const r = compose("f-no-joints", job);
  const sameCounts = (a, b) => ["line", "corner", "end", "gate", "total", "terminal"].every((k) => a[k] === b[k]);
  ok("2f-0", "a job with NO joint ids: the adjustment is empty (changesNothing), nothing saved", r.adj.changesNothing && r.adj.postsSaved === 0 && r.adj.posts.length === 0 && r.adj.ignored.length === 0,
    "RIGHT: perRun {} / postsSaved 0. This is the guarantee the owner's quoted jobs rest on.");
  ok("2f-1", "...and every run's counts after are IDENTICAL to the real engine's, field for field", job.every((s, i) => sameCounts(r.after[i], r.base[i])),
    "RIGHT: after == base for every run.");
  ok("2f-2", "...for the empty list too", adjustJoins([]).changesNothing && adjustJoins([]).postsSaved === 0);
  ok("2f-3", "...and for blank, empty and whitespace joint ids, which mean 'not joined'", (() => {
    const a = adjustJoins([R("A", A_PTS, { start: "", end: "   " }), R("B", B_STRAIGHT, { start: "  ", end: "" })].map(toJoinable));
    return a.changesNothing && a.ignored.length === 0;
  })());
  // The input that is NOT trivially empty: ids are present but nothing can merge. Zero must still come out.
  const dangling = compose("f-dangling-ids", [
    R("A", A_PTS, { sort: 0, end: "J1" }),
    R("B", B_STRAIGHT, { sort: 1, end: "J2" }),
    R("C", C_STRAIGHT, { sort: 2, start: "J3" }),
  ]);
  ok("2f-4", "joint ids that each sit on ONE end only (partner deleted, not synced yet): three ignored joints, zero change, still 15 posts",
    dangling.adj.changesNothing && dangling.adj.ignored.length === 3 && dangling.fence.total === 15 && dangling.fenceBefore.total === 15, `got ignored ${dangling.adj.ignored.length}, total ${dangling.fence.total}`);
}

// =============================================================================
console.log("\n3. WHAT ELSE FOLLOWS THE POST COUNT -- checked on the real engine, hits and misses both");
// =============================================================================
{
  const entryOf = (out, role) => out.runs[0].entries.find((e) => e.role === role)?.quantity ?? 0;
  const one = (o) => priceRows([runRow(R("r", A_PTS, o))]);
  const post = (out) => out.runs[0].posts;

  // PER POST (a join moves these): found by reading takeoff.ts, confirmed here by pricing real runs.
  for (const type of ["VINYL", "ALUMINUM", "ORNAMENTAL_IRON", "WOOD", "COMPOSITE", "CHAIN_LINK"]) {
    const out = one({ type });
    ok(`3a-${type}`, `${type}: POST_CAP quantity == total posts (a post that no longer exists no longer brings a cap)`, entryOf(out, "POST_CAP") === post(out).total,
      `RIGHT: POST_CAP ${post(out).total}; got ${entryOf(out, "POST_CAP")}.`);
  }
  {
    const out = one({ type: "SPLIT_RAIL" });
    ok("3a-SPLIT_RAIL", "SPLIT_RAIL: no POST_CAP at all -- a join cannot change a cap count there", out.runs[0].entries.every((e) => e.role !== "POST_CAP"));
  }
  {
    const out = one({});
    const p = post(out);
    ok("3b", "LINE_POST / CORNER_POST / END_POST quantities are exactly the line / corner / end counts (separate catalog rows, separate prices)",
      entryOf(out, "LINE_POST") === p.line && entryOf(out, "END_POST") === p.end && entryOf(out, "CORNER_POST") === p.corner);
    ok("3c", "concrete = (total - gate posts) x bags per post, rounded up to whole bags (gate posts carry their own bags via the gate)",
      entryOf(out, "CONCRETE_BAG") === Math.ceil((p.total - p.gate) * 1), `RIGHT: ${(p.total - p.gate)} bags; got ${entryOf(out, "CONCRETE_BAG")}.`);
    const gated = one({ gates: "590:0:4:LINE:IN", bags: 1.5 });
    const g = post(gated);
    ok("3d", "...with a LINE gate at 1.5 bags a post: ceil((total - gate posts) x 1.5 + 2.5 bags the gate itself adds); the gate's two posts never ride on the fence's post count",
      entryOf(gated, "CONCRETE_BAG") === Math.ceil((g.total - g.gate) * 1.5 + 2.5), `got ${entryOf(gated, "CONCRETE_BAG")}`);
  }
  {
    const out = priceRows([runRow(R("r", A_PTS, { type: "CHAIN_LINK", extra: { include_barbed_wire_arms: true } }))]);
    const t = post(out).terminal;
    ok("3e", "CHAIN_LINK: tension bands (x4 for a 4 ft fabric), brace bands, rail ends and barbed-wire arms all follow the TERMINAL count (corner + end + gate)",
      entryOf(out, "TENSION_BAND") === t * 4 && entryOf(out, "BRACE_BAND") === t && entryOf(out, "RAIL_END") === t && entryOf(out, "BARBED_WIRE_ARM") === t,
      `terminal ${t}: bands ${entryOf(out, "TENSION_BAND")}, brace ${entryOf(out, "BRACE_BAND")}, rail ends ${entryOf(out, "RAIL_END")}, arms ${entryOf(out, "BARBED_WIRE_ARM")}`);
    // And the terminal count moves by the right amount: an owner's end becoming a corner is terminal either way; a member's end going is -1.
    const j = compose(null, [R("A", A_PTS, { sort: 0, end: "J1", type: "CHAIN_LINK" }), R("B", B_STRAIGHT, { sort: 1, start: "J1", type: "CHAIN_LINK" })]);
    ok("3f", "CHAIN_LINK joined straight: terminal posts 4 -> 2 (the owner's line post is not terminal, the member's end is gone); caps follow total 10 -> 9",
      j.fenceBefore.total === 10 && j.fence.total === 9 && j.after[0].terminal + j.after[1].terminal === 2 && j.base[0].terminal + j.base[1].terminal === 4,
      `terminal ${j.base[0].terminal + j.base[1].terminal} -> ${j.after[0].terminal + j.after[1].terminal}`);
  }

  // NOT PER POST, and not changed by a join: looked for, found per-JOB or per-FOOT or per-RUN-ROUNDING.
  {
    const bend = one({ points: pts([0, 0], [300, 0], [300, 300]) });
    const straight = one({});
    ok("3g", "PANEL count does not read the post counts: a 30 ft run with a bend (1 corner) and one without both ask for 5 panels",
      entryOf(bend, "PANEL") === 5 && entryOf(straight, "PANEL") === 5 && post(bend).corner === 1 && post(straight).corner === 0);
    ok("3h", "labour is per foot, not per post: the bend changes the corner count and not labor_cost", bend.totals.labor_cost === straight.totals.labor_cost);
  }
  {
    const three = [R("A", A_PTS, { sort: 0 }), R("B", B_STRAIGHT, { sort: 1 }), R("C", C_STRAIGHT, { sort: 2 })].map(runRow);
    const floor = priceRows(three, { labor_rate_per_ft: 1, minimum_labor_charge: 500 });
    ok("3i", "MINIMUM LABOUR CHARGE is per JOB: three runs (71 ft x $1) with a $500 floor read $500, not $1,500 -- joining three runs cannot triple it",
      floor.totals.labor_cost === 500, `RIGHT: 500; got ${floor.totals.labor_cost}`);
    const minJob = priceRows(three, { labor_rate_per_ft: 0, gate_rate_per_ft: 0, minimum_job_charge: 1000 });
    ok("3j", "MINIMUM JOB CHARGE is per JOB: three runs read $1,000, not $3,000", minJob.totals.grand_total === 1000, `got ${minJob.totals.grand_total}`);
    const tear = priceRows(three, { teardown_enabled: true, teardown_flat_fee: 100, trash_haul_fee: 50, teardown_rate_per_ft: 0 });
    ok("3k", "TEARDOWN flat fee and TRASH HAUL are per JOB: three runs bill $150 once", tear.totals.teardown_cost === 150, `got ${tear.totals.teardown_cost}`);
    const oneRunLabour = priceRows([runRow(R("p", pts([0, 0], [1420, 0])))]);
    const threeRunLabour = priceRows(three);
    ok("3l", "labour footage is the sum of the runs' footage: a join has no length, so 3 runs of 71 ft total and one 71 ft run bill the same labour",
      oneRunLabour.totals.labor_cost === threeRunLabour.totals.labor_cost && threeRunLabour.billable_linear_feet === 71, `got ${threeRunLabour.billable_linear_feet} ft`);
  }
  {
    // Per-run ROUNDING that a join leaves exactly as it is: whole bags of concrete, per run.
    const un = compose(null, [R("A", pts([0, 0], [480, 0]), { sort: 0, bags: 1.5 }), R("B", pts([480, 0], [720, 0]), { sort: 1, bags: 1.5 })]);
    const bagsOf = (p) => Math.ceil((p.total - p.gate) * 1.5);
    const bagsUn = un.base.map(bagsOf);
    const j = compose(null, [R("A", pts([0, 0], [480, 0]), { sort: 0, bags: 1.5, end: "J1" }), R("B", pts([480, 0], [720, 0]), { sort: 1, bags: 1.5, start: "J1" })]);
    const bagsJ = j.after.map(bagsOf);
    expectEq("3m", "CONCRETE rounds up per RUN: 24 ft + 12 ft at 1.5 bags a post is 8 + 5 = 13 unjoined; joined, the shared post's bag is counted once: 8 + 3 = 11", [bagsUn, bagsJ], [[8, 5], [8, 3]],
      "The per-run round-up is untouched by joining (one 36 ft run is also 11).");
  }
  // Nothing in the pricing code charges per run or per trip. A scan, with a canary so it cannot pass by being blind.
  {
    const files = ["supabase/functions/_shared/pricing/totals.ts", "supabase/functions/_shared/pricing/line-items.ts", "supabase/functions/_shared/pricing/takeoff.ts", "supabase/functions/_shared/pricing/index.ts", "app/src/main/java/com/fenceestimator/app/estimate/JobMoney.kt"];
    const sources = files.map((f) => ({ f, text: stripComments(readRepo(f)) }));
    ok("3n-canary", "scanner canary: every pricing source is readable, non-trivial, NUL-free, and the scan finds 'minimumLaborCharge' where it IS", sources.every((s) => s.text.length > 1000 && !s.text.includes("\0")) && /minimumLaborCharge/.test(sources.find((s) => s.f.endsWith("totals.ts")).text));
    const hits = sources.filter((s) => /mobili[sz]ation|call-?out|trip charge|per[- ]run (fee|charge|minimum)|setup fee/i.test(s.text)).map((s) => s.f);
    ok("3n", "no mobilisation / call-out / trip / per-run fee exists in any pricing source (so nothing is charged once per run)", hits.length === 0, `found in: ${hits.join(", ")}`);
  }
}

// =============================================================================
console.log("\n4. OWNER, KIND AND IGNORED JOINTS -- the rules, one number each");
// =============================================================================
{
  const pair = (a, b, ids = {}) => compose(null, [R("A", A_PTS, { sort: 0, end: "J1", ...a }), R("B", B_STRAIGHT, { sort: 1, start: "J1", ...b })]);
  const eq = pair({}, {});
  expectEq("4a", "equal heights: the LOWER sort order is billed the shared post (A keeps 6, B drops 4 -> 3)", [eq.byId.A.total, eq.byId.B.total], [6, 3]);
  const tall = pair({ height: 4 }, { height: 6 });
  expectEq("4b", "the TALLER run is billed the post even when it sorts later (B is 6 ft high, A 4 ft high): B keeps 4 posts, A gives its end up and drops 6 -> 5", [tall.byId.A.total, tall.byId.B.total], [5, 4],
    "RIGHT: the post stays with the taller run B (4 posts); A, 6 posts alone, gives its end up (5).");
  expectEq("4c", "...and the post's TYPE is unchanged by who owns it: same fence total either way", [eq.fence.total, tall.fence.total], [9, 9]);
  const idTie = compose(null, [R("Z", A_PTS, { sort: 0, end: "J1" }), R("M", B_STRAIGHT, { sort: 0, start: "J1" })]);
  expectEq("4d", "equal height AND equal sort order: the lower id (M) owns it, so the answer never depends on list order", idTie.adj.posts[0].ownerRunId, "M");
  const typed = compose("4e-typed", [R("A", "", { sort: 0, manual: 30, end: "J1" }), R("B", "", { sort: 1, manual: 17, start: "J1" })]);
  expectPosts("4e", "typed-footage runs carry no drawing, so there is no angle to read: the join is a CORNER (6 line + 1 corner + 2 end = 9)", typed.fence, P(6, 1, 2, 9));

  // kind by angle: the same 15 degree rule a bend inside one run follows
  const kinds = [[0, "LINE"], [10, "LINE"], [14.9, "LINE"], [15.1, "CORNER"], [20, "CORNER"], [90, "CORNER"], [135, "CORNER"]];
  const got = kinds.map(([deg]) => {
    const rad = (deg * Math.PI) / 180;
    const end = [f32(600 + 340 * Math.cos(rad)), f32(340 * Math.sin(rad))];
    return compose(`4f-turn-${deg}`, [R("A", A_PTS, { sort: 0, end: "J1" }), R("B", pts([600, 0], end), { sort: 1, start: "J1" })]).adj.posts[0].kind;
  });
  expectEq("4f", "join kind by turn: 0/10/14.9 degrees LINE, 15.1/20/90/135 CORNER (the engine's own corner threshold is 15)", got, kinds.map(([, k]) => k));
  // ...and it equals what the real engine does with the SAME two legs drawn as one polyline.
  const agree = kinds.every(([deg]) => {
    const rad = (deg * Math.PI) / 180;
    const end = [f32(600 + 340 * Math.cos(rad)), f32(340 * Math.sin(rad))];
    const joined = compose(null, [R("A", A_PTS, { sort: 0, end: "J1" }), R("B", pts([600, 0], end), { sort: 1, start: "J1" })]).fence;
    const polyline = alone(R("p", pts([0, 0], [600, 0], end)));
    return joined.corner === polyline.corner && joined.line + joined.corner === polyline.line + polyline.corner;
  });
  ok("4g", "...and corner-vs-line agrees with the real engine's ONE polyline through the same points at every one of those turns", agree);

  // direction of drawing must not matter
  const l = (a, b) => compose(null, [R("A", a.points, { sort: 0, ...a.j }), R("B", b.points, { sort: 1, ...b.j })]).fence;
  const variants = [
    l({ points: pts([0, 0], [600, 0]), j: { end: "J" } }, { points: pts([600, 0], [600, 340]), j: { start: "J" } }),
    l({ points: pts([0, 0], [600, 0]), j: { end: "J" } }, { points: pts([600, 340], [600, 0]), j: { end: "J" } }),
    l({ points: pts([600, 0], [0, 0]), j: { start: "J" } }, { points: pts([600, 0], [600, 340]), j: { start: "J" } }),
    l({ points: pts([600, 0], [0, 0]), j: { start: "J" } }, { points: pts([600, 340], [600, 0]), j: { end: "J" } }),
  ];
  ok("4h", "which END of each run touches the joint, and which way it was drawn, makes no difference: all four orientations of the same L are 6 line + 1 corner + 2 end = 9",
    variants.every((v) => v.line === 6 && v.corner === 1 && v.end === 2 && v.total === 9), variants.map(fmtP).join(" | "));
  const uturnLike = l({ points: pts([0, 0], [600, 0]), j: { end: "J" } }, { points: pts([940, 0], [600, 0]), j: { end: "J" } });
  expectPosts("4i", "B drawn TOWARD the joint, straight on (end meets end): still a LINE post, 7 line + 2 end = 9, not a U-turn corner", uturnLike, P(7, 0, 2, 9));

  // ignored joints
  const ignoredCase = (name, specs, reason, keepsPosts) => {
    const r = compose(name, specs);
    ok(name, `ignored (${reason}): ${keepsPosts}`, r.adj.changesNothing && r.adj.ignored.length === 1 && r.adj.ignored[0].reason === reason && r.fence.total === r.fenceBefore.total,
      `RIGHT: no change, reason ${reason}; got ignored ${JSON.stringify(r.adj.ignored)}, total ${r.fence.total} vs ${r.fenceBefore.total}`);
    return r;
  };
  ignoredCase("4j-one-end-only", [R("A", A_PTS, { end: "J1" }), R("B", B_STRAIGHT, { sort: 1 })], "FEWER_THAN_TWO_LIVE_RUNS", "a joint id on ONE end only leaves that end free; A still bills its end post");
  ignoredCase("4k-self", [R("A", pts([0, 0], [600, 0], [600, 340], [0, 340]), { start: "J1", end: "J1" })], "SAME_RUN_TWICE", "a run whose two ends carry the same id stays an OPEN run (closing a run on itself is closed_loop's job)");
  ignoredCase("4l-teardown-partner", [R("T", B_STRAIGHT, { sort: 0, teardown: true, start: "J1" }), R("A", A_PTS, { sort: 1, end: "J1" })], "FEWER_THAN_TWO_LIVE_RUNS",
    "a joint to a TEARDOWN run (old fence, bills nothing) is ignored: A keeps both end posts, even though T sorts first and would have owned the post");
  ignoredCase("4m-empty-partner", [R("E", "", { sort: 0, start: "J1" }), R("A", A_PTS, { sort: 1, end: "J1" })], "FEWER_THAN_TWO_LIVE_RUNS", "a run with nothing drawn or typed has no free end to give");
  ignoredCase("4n-closed-partner", [R("L", pts([0, 0], [600, 0], [600, 340], [0, 340]), { sort: 0, closed: true, start: "J1" }), R("B", B_STRAIGHT, { sort: 1, start: "J1" })], "FEWER_THAN_TWO_LIVE_RUNS",
    "joint ids on a CLOSED run are ignored: it has no free end");
  const withTeardownMember = compose("4o-teardown-third-member", [
    R("A", A_PTS, { sort: 0, end: "J1" }), R("B", B_STRAIGHT, { sort: 1, start: "J1" }), R("T", B_UP, { sort: 2, teardown: true, start: "J1" }),
  ]);
  ok("4o", "a teardown run on the same joint does not undo the join for the live runs: A and B still merge (10 -> 9) and the post is a LINE post of degree 2",
    withTeardownMember.fence.total === 9 && withTeardownMember.adj.posts[0].memberRunIds.join() === "A,B" && withTeardownMember.adj.posts[0].kind === "LINE",
    `got ${withTeardownMember.fence.total} posts, members ${withTeardownMember.adj.posts[0]?.memberRunIds}`);
}

// =============================================================================
console.log("\n5. TEETH -- joins are EXPLICIT; coordinates alone must never create one, and moving a point must never destroy one");
// =============================================================================
{
  const coincidentNoId = compose("5a-coincident-no-id", [R("A", A_PTS, { sort: 0 }), R("B", B_STRAIGHT, { sort: 1 })]);
  ok("5a", "TWO RUNS ENDING ON THE SAME PIXEL, no joint recorded: NOT merged. 10 posts, 4 end posts, adjustment empty",
    coincidentNoId.fence.total === 10 && coincidentNoId.fence.end === 4 && coincidentNoId.adj.changesNothing,
    "RIGHT: 10 posts, 4 end. The other fence may be a neighbour's that merely meets his. A join is a fact the owner creates, never a deduction from coordinates.");
  const joinedExact = compose(null, [R("A", A_PTS, { sort: 0, end: "J1" }), R("B", B_STRAIGHT, { sort: 1, start: "J1" })]);
  const joinedOnePixel = compose("5b-one-pixel-off", [R("A", A_PTS, { sort: 0, end: "J1" }), R("B", pts([601, 0], [940, 0]), { sort: 1, start: "J1" })]);
  const joinedFarApart = compose("5b-far-apart", [R("A", A_PTS, { sort: 0, end: "J1" }), R("B", pts([700, 50], [1040, 50]), { sort: 1, start: "J1" })]);
  ok("5b", "an explicit joint whose ends are ONE PIXEL apart is still joined: same 9 posts as when they coincide (a drag cannot destroy a join)",
    joinedOnePixel.fence.total === 9 && joinedExact.fence.total === 9, `RIGHT: 9. got ${joinedOnePixel.fence.total} (exact ${joinedExact.fence.total}). Coordinates must not decide whether runs are joined.`);
  ok("5c", "...and 100+ pixels apart too: the joint, not the geometry, says they meet",
    joinedFarApart.fence.total === 9 && joinedFarApart.adj.posts.length === 1, `RIGHT: 9. got ${joinedFarApart.fence.total}`);
  const nudged = [0, 1, 2, 5].map((dx) => compose(null, [R("A", A_PTS, { sort: 0, end: "J1" }), R("B", pts([600 + dx, 0], [940 + dx, 0]), { sort: 1, start: "J1" })]).fence.total);
  expectEq("5d", "nudging one run's endpoint 0, 1, 2 or 5 px changes nothing about the post count", nudged, [9, 9, 9, 9]);
  const sameCoordsDifferentIds = compose("5e-two-joints-one-spot", [
    R("A", A_PTS, { sort: 0, end: "J1" }), R("B", B_STRAIGHT, { sort: 1, start: "J2" }),
  ]);
  ok("5e", "two ends on one spot carrying DIFFERENT joint ids are not joined to each other (each is a dangling single-ended joint): 10 posts",
    sameCoordsDifferentIds.fence.total === 10 && sameCoordsDifferentIds.adj.ignored.length === 2, `got ${sameCoordsDifferentIds.fence.total}`);
  const aMutation = (() => {
    // What an inferring implementation does: group run ends by rounded coordinate instead of joint id. It must DISAGREE with the
    // real behaviour on the three cases above -- this proves the checks above can tell the two apart.
    const specs = [R("A", A_PTS, { sort: 0 }), R("B", B_STRAIGHT, { sort: 1 })];
    const byPoint = new Map();
    for (const s of specs) { const g = geometryOf(s); for (const [i, v] of [[0, g.vertices[0]], [1, g.vertices[g.vertices.length - 1]]]) { const k = `${Math.round(v.point.x)},${Math.round(v.point.y)}`; byPoint.set(k, (byPoint.get(k) ?? 0) + 1); } }
    return [...byPoint.values()].some((n) => n >= 2);
  })();
  ok("5f", "canary: a coordinate-inferring rule WOULD merge the id-less pair in 5a (so 5a can fail, and does if someone writes that rule)", aMutation === true);
}

// =============================================================================
console.log("\n6. PROPERTIES -- randomised jobs checked against the REAL engine's own answer for one polyline");
// =============================================================================
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const shuffle = (arr, rand) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const reverseSpec = (s) => ({ ...s, points: s.points.split(",").reverse().join(","), start: s.end, end: s.start });
const perRunJson = (adj) => JSON.stringify(Object.keys(adj.perRun).sort().map((k) => [k, adj.perRun[k]]));
{
  const rand = rng(33);
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  let chainsOk = 0, ringsOk = 0, orderOk = 0, reverseOk = 0, ownerOk = 0;
  const bad = { chain: [], order: [], reverse: [], owner: [], ring: [] };
  for (let n = 0; n < 40; n++) {
    // A random rectilinear chain, legs a whole number of 6 ft bays so the per-leg bays add up to the polyline's.
    const legs = 2 + Math.floor(rand() * 5);
    const p = [[0, 0]];
    let prev = -1, x = 0, y = 0;
    for (let i = 0; i < legs; i++) {
      let d;
      do { d = Math.floor(rand() * 4); } while (prev >= 0 && d === (prev + 2) % 4);
      const len = (1 + Math.floor(rand() * 5)) * 6;
      x += dirs[d][0] * len * PPF; y += dirs[d][1] * len * PPF; p.push([x, y]); prev = d;
    }
    const specs = p.slice(0, -1).map((a, i) => R(`c${n}-${i}`, pts(a, p[i + 1]), { sort: i, start: i > 0 ? `c${n}-j${i - 1}` : "", end: i < legs - 1 ? `c${n}-j${i}` : "" }));
    const r = compose(n < 8 ? `rnd-chain-${n}` : null, specs);
    const poly = alone(R("p", pts(...p)));
    if (r.fence.line === poly.line && r.fence.corner === poly.corner && r.fence.end === poly.end && r.fence.total === poly.total && r.adj.postsSaved === legs - 1) chainsOk++;
    else bad.chain.push(`chain ${n}: joined ${fmtP(r.fence)} vs polyline ${fmtP(poly)}`);
    // order of the list must not matter
    if (perRunJson(adjustJoins(shuffle(specs, rand).map(toJoinable))) === perRunJson(r.adj)) orderOk++; else bad.order.push(`chain ${n}: list order changed the answer`);
    // the direction each leg was drawn must not matter
    const flipped = specs.map((s) => (rand() < 0.5 ? reverseSpec(s) : s));
    const rf = compose(n < 8 ? `rnd-chain-${n}-flipped` : null, flipped);
    if (perRunJson(rf.adj) === perRunJson(r.adj) && rf.fence.total === r.fence.total && rf.fence.corner === r.fence.corner) reverseOk++; else bad.reverse.push(`chain ${n}: drawing direction changed the answer`);
    // a random height decides the owner: the tallest member of every joint
    const hs = specs.map((s) => ({ ...s, height: [4, 5, 6][Math.floor(rand() * 3)] }));
    const rh = compose(null, hs);
    const ownersRight = rh.adj.posts.every((jp) => {
      const members = hs.filter((s) => jp.memberRunIds.includes(s.id));
      const top = Math.max(...members.map((m) => m.height));
      const owner = members.find((m) => m.id === jp.ownerRunId);
      return owner.height === top && members.filter((m) => m.height === top).every((m) => m.sort >= owner.sort);
    });
    if (ownersRight && rh.fence.total === r.fence.total) ownerOk++; else bad.owner.push(`chain ${n}: owner is not the tallest / lowest-sorted`);
  }
  expectEq("6a", "40 random rectilinear chains (2-6 legs, mixed turns incl. straight): joined == the real engine's ONE polyline, line/corner/end/total, and saves legs-1 posts", chainsOk, 40, bad.chain.slice(0, 3).join(" ; "));
  expectEq("6b", "...the list order of the runs never changes the answer", orderOk, 40, bad.order.slice(0, 3).join(" ; "));
  expectEq("6c", "...the drawing direction of each run (points reversed, ends swapped) never changes the answer", reverseOk, 40, bad.reverse.slice(0, 3).join(" ; "));
  expectEq("6d", "...the shared post always goes to the tallest member, then the lowest sort order, and the fence total never depends on who owns it", ownerOk, 40, bad.owner.slice(0, 3).join(" ; "));

  // WHERE THE POLYLINE COMPARISON STOPS HOLDING, pinned so nobody "fixes" the join to match it. A polyline rounds its bays up ONCE over
  // the whole length; joined runs round up PER RUN. Two 7 ft legs: 2 bays each (a 7 ft bay will not take a 6 ft panel), so 3 + 3 posts
  // alone and 5 joined -- one 14 ft polyline says 3 bays and 4 posts, which would need a 7 ft span on one of the legs.
  {
    const seven = compose("6g-seven-plus-seven", [R("A", pts([0, 0], [140, 0]), { sort: 0, end: "J1" }), R("B", pts([140, 0], [280, 0]), { sort: 1, start: "J1" })]);
    const polyline = alone(R("p", pts([0, 0], [280, 0])));
    expectEq("6g", "two 7 ft runs joined: 6 posts alone -> 5 joined (one shared post out). One 14 ft polyline says 4: the polyline is the optimistic one, the join is not wrong",
      [seven.fenceBefore.total, seven.fence.total, polyline.total], [6, 5, 4],
      "RIGHT: 6 -> 5. The join removes exactly one post (the duplicate at the joint), whatever the polyline's own rounding says.");
  }

  // rings: rectangle and L, compared with the real engine's CLOSED single run
  for (let n = 0; n < 12; n++) {
    const w = (2 + Math.floor(rand() * 5)) * 6 * PPF, h = (2 + Math.floor(rand() * 5)) * 6 * PPF;
    let ring;
    if (n % 2 === 0) ring = [[0, 0], [w, 0], [w, h], [0, h]];
    else { const c = 6 * PPF, d = 6 * PPF; ring = [[0, 0], [w + c, 0], [w + c, h], [w + c - c, h], [w + c - c, h + d], [0, h + d]]; }
    const k = ring.length;
    const specs = ring.map((a, i) => R(`r${n}-${i}`, pts(a, ring[(i + 1) % k]), { sort: i, start: `r${n}-j${(i + k - 1) % k}`, end: `r${n}-j${i}` }));
    const r = compose(n < 4 ? `rnd-ring-${n}` : null, specs);
    const loop = alone(R("p", pts(...ring), { closed: true }));
    if (r.fence.line === loop.line && r.fence.corner === loop.corner && r.fence.end === 0 && r.fence.total === loop.total && r.adj.postsSaved === k) ringsOk++;
    else bad.ring.push(`ring ${n}: joined ${fmtP(r.fence)} vs closed loop ${fmtP(loop)}`);
  }
  expectEq("6e", "12 random rectangle and L-shaped rings of open runs, every end joined: == the real engine's ONE closed_loop run (no end posts), and saves one post per joint", ringsOk, 12, bad.ring.slice(0, 3).join(" ; "));

  // invariants over arbitrary joined jobs, including ones the engine never prices as a polyline
  let invariantOk = 0, total = 0;
  for (let n = 0; n < 60; n++) {
    const count = 2 + Math.floor(rand() * 5);
    const specs = [];
    for (let i = 0; i < count; i++) {
      const len = (1 + Math.floor(rand() * 40)) * 20 + Math.floor(rand() * 20);
      const ang = rand() * 2 * Math.PI;
      const a = [Math.round(rand() * 500), Math.round(rand() * 500)];
      const b = [Math.round(a[0] + len * Math.cos(ang)), Math.round(a[1] + len * Math.sin(ang))];
      specs.push(R(`v${n}-${i}`, rand() < 0.15 ? "" : pts(a, b), { sort: i, manual: rand() < 0.15 ? 5 + Math.floor(rand() * 40) : null, closed: rand() < 0.1, teardown: rand() < 0.1, gates: rand() < 0.3 ? "10:0:4:LINE:IN" : "", height: [4, 6][Math.floor(rand() * 2)] }));
    }
    // random joints: each run end joins one of up to 3 joint ids, or nothing
    const ids = ["", "", "X", "Y", "Z"];
    for (const s of specs) { s.start = ids[Math.floor(rand() * ids.length)]; s.end = ids[Math.floor(rand() * ids.length)]; }
    const r = compose(null, specs);
    total++;
    const nonNegative = r.after.every((p) => p.line >= 0 && p.corner >= 0 && p.end >= 0 && p.total >= 0 && p.end <= 2);
    const saved = r.adj.posts.reduce((t, jp) => t + jp.memberRunIds.length - 1, 0);
    const conserved = r.adj.postsSaved === saved && sumPosts(r.after).total === sumPosts(r.base).total - saved;
    const gatesUntouched = r.after.every((p, i) => p.gate === r.base[i].gate);
    const teardownUntouched = specs.every((s, i) => !s.teardown || r.adj.forRun(s.id).end === 0);
    if (nonNegative && conserved && gatesUntouched && teardownUntouched) invariantOk++;
  }
  expectEq("6f", "60 random jobs with random joints on random runs (typed, closed, empty, teardown, gated, mixed heights): no negative counts, ends never exceed 2, the total falls by exactly sum(degree-1), gate posts and teardown runs untouched",
    invariantOk, total);
}

// =============================================================================
console.log("\n7. KOTLIN -- the compiled Kotlin must match the transcription, and the header must tell the truth");
// =============================================================================
function readRepo(rel) { return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", rel), "utf8"); }
function stripComments(src) { return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); }
function bodyOf(src, signature) {
  const at = src.indexOf(signature);
  if (at < 0) return null;
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return { start: at, end: i + 1, text: src.slice(at, i + 1) }; }
  }
  return null;
}

/** One line per run, for the Kotlin harness. name|id|points|closed|manual|height|sort|teardown|start|end */
export function toKotlinInput() {
  return scenarios.flatMap((s) => s.specs.map((r) => [s.name, r.id, r.points === "" ? "-" : r.points, r.closed ? 1 : 0, r.manual === null ? "-" : r.manual, r.height, r.sort, r.teardown ? 1 : 0, r.start === "" ? "-" : r.start, r.end === "" ? "-" : r.end].join("|"))).join("\n") + "\n";
}
export function serializeAll() {
  const out = [];
  for (const s of scenarios) {
    const adj = adjustJoins(s.specs.map(toJoinable));
    for (const id of Object.keys(adj.perRun).sort()) { const a = adj.perRun[id]; out.push(`${s.name}|ADJ|${id}|${a.line}|${a.corner}|${a.end}`); }
    for (const p of adj.posts) out.push(`${s.name}|POST|${p.jointId}|${p.kind}|${p.ownerRunId}|${p.memberRunIds.join(",")}`);
    for (const g of adj.ignored) out.push(`${s.name}|IGN|${g.jointId}|${g.reason}`);
    out.push(`${s.name}|SAVED|${adj.postsSaved}`);
  }
  return out;
}

// ---- the turn-angle sweep exists to compare Kotlin and JS trig at the 15 degree line; registered last so the golden covers it
for (const deg of [-179, -135, -90, -45, -20, -15.01, -14.99, -5, 0, 4, 10, 14, 14.5, 14.9, 14.99, 14.999, 15, 15.001, 15.01, 15.1, 16, 20, 30, 45, 60, 90, 120, 135, 170, 179]) {
  const rad = (deg * Math.PI) / 180;
  const end = [f32(600 + 340 * Math.cos(rad)), f32(340 * Math.sin(rad))];
  sc(`sweep-${deg}`, [R("A", A_PTS, { sort: 0, end: "J1" }), R("B", pts([600, 0], end), { sort: 1, start: "J1" })]);
}

{
  const kt = readRepo("app/src/main/java/com/fenceestimator/app/geometry/FenceGeometry.kt");
  const code = stripComments(kt);

  // (i) golden
  const mine = serializeAll();
  if (KOTLIN_GOLDEN === null) {
    ok("7a", "Kotlin golden vectors present", false, "KOTLIN_GOLDEN is null: run the harness (recipe at KOTLIN_HARNESS) and paste its output.");
  } else {
    const golden = KOTLIN_GOLDEN.trim().split("\n");
    let firstDiff = -1;
    for (let i = 0; i < Math.max(golden.length, mine.length); i++) if (golden[i] !== mine[i]) { firstDiff = i; break; }
    ok("7a", `the transcription reproduces the COMPILED Kotlin's output line for line over all ${scenarios.length} scenarios (${golden.length} lines)`, firstDiff < 0,
      `first difference at line ${firstDiff + 1}: Kotlin says "${golden[firstDiff]}", transcription says "${mine[firstDiff]}". One of them is wrong; the Kotlin is the shipped one.`);
    const coveredKinds = new Set(golden.filter((l) => l.includes("|POST|")).map((l) => l.split("|")[3]));
    ok("7b", "the golden is not vacuous: it contains LINE and CORNER posts, ignored joints of both reasons, and multi-run adjustments",
      coveredKinds.has("LINE") && coveredKinds.has("CORNER") && golden.some((l) => l.includes("FEWER_THAN_TWO_LIVE_RUNS")) && golden.some((l) => l.includes("SAME_RUN_TWICE")) && golden.filter((l) => l.includes("|ADJ|")).length > 100,
      `kinds ${[...coveredKinds]}, adj lines ${golden.filter((l) => l.includes("|ADJ|")).length}`);
  }

  // (ii) structure: the Kotlin is what it is documented to be
  ok("7c", "FenceGeometry.kt defines RunJoinArithmetic.adjust, JoinableRun, RunPostAdjustment and RunPostTally", ["object RunJoinArithmetic", "fun adjust(", "data class JoinableRun", "data class RunPostAdjustment", "data class RunPostTally"].every((s) => code.includes(s)));
  const ktThreshold = /const val CORNER_ANGLE_THRESHOLD_DEGREES\s*=\s*([0-9.]+)f/.exec(code);
  ok("7d", "the Kotlin corner threshold is the number the transcription and the TypeScript engine use", ktThreshold !== null && Number(ktThreshold[1]) === CORNER_ANGLE_THRESHOLD_DEGREES, `Kotlin ${ktThreshold && ktThreshold[1]}, TypeScript ${CORNER_ANGLE_THRESHOLD_DEGREES}`);
  ok("7e", "the Kotlin kind rule uses that same constant and sends three-or-more runs to CORNER", /live\.size >= 3\) return JoinPostKind\.CORNER/.test(code) && /FenceGeometryEngine\.CORNER_ANGLE_THRESHOLD_DEGREES/.test(code));

  // (iii) TEETH on the Kotlin: nothing outside the angle code may read a coordinate. Region-scoped (comment-stripped, the object only).
  const obj = bodyOf(code, "object RunJoinArithmetic");
  ok("7f-canary", "scanner canary: the RunJoinArithmetic object was found, and the whole of it DOES read coordinates (in turnDegrees), so the scan below can see them", obj !== null && /\.x\b/.test(obj.text) && /atan2/.test(obj.text));
  if (obj !== null) {
    let rest = obj.text;
    for (const sig of ["private fun turnDegrees(", "private fun endAndNeighbour("]) {
      const b = bodyOf(rest, sig);
      if (b === null) { ok(`7f-find-${sig}`, `found ${sig}`, false); continue; }
      rest = rest.slice(0, b.start) + rest.slice(b.end);
    }
    const reads = /\.(x|y)\b|atan2|sqrt|hypot|roundToInt|abs\(/.exec(rest);
    ok("7f", "TEETH: outside turnDegrees/endAndNeighbour the Kotlin reads NO coordinate, so it cannot infer a join from where points are", reads === null,
      `found "${reads && reads[0]}" in the join arithmetic outside the angle code. A join is explicit (joint ids); coordinates may only decide line-vs-corner.`);
    const adj = bodyOf(obj.text, "fun adjust(");
    ok("7g", "the grouping reads the joint ids (startJointId / endJointId) and nothing else to decide membership", adj !== null && /startJointId/.test(adj.text) && /endJointId/.test(adj.text) && /isNotBlank\(\)/.test(adj.text));
  }

  // (iv) honesty: the header says "not yet reached" exactly while that is true
  const claimsUnreached = /NOT YET REACHED BY THE ENGINE/.test(kt);
  const engineFiles = ["app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt", "supabase/functions/_shared/pricing/takeoff.ts", "supabase/functions/_shared/pricing/index.ts", "app/src/main/java/com/fenceestimator/app/estimate/JobMoney.kt"];
  const reachedBy = engineFiles.filter((f) => /RunJoinArithmetic|JoinableRun|JoinAdjustment|RunPostAdjustment|adjustJoins/.test(stripComments(readRepo(f))));
  ok("7h", "HONESTY: the header says 'NOT YET REACHED BY THE ENGINE' exactly while no engine file references the join arithmetic",
    claimsUnreached === (reachedBy.length === 0),
    reachedBy.length > 0
      ? `${reachedBy.join(", ")} now reference it, but the FenceGeometry.kt header still says it is not reached (or says nothing). Update the header, the call-site list, and add fixtures.`
      : "the header no longer says NOT YET REACHED, yet no engine file references it. Do not leave a comment implying it is live.");
  ok("7i", "the header names both call sites (EstimateEngine.suggestQuantities and the server takeoff / priceJob)", /EstimateEngine\.suggestQuantities/.test(kt) && /priceJob/.test(kt) && /takeoff\.ts/.test(kt));
  // "no joint is stored anywhere a job is read from": true while no Room entity has a joint field and no SQL patch that is marked as
  // applied (i.e. not "WRITTEN, NOT APPLIED") adds a joint column. supabase_a32_join_runs.sql proposes the columns and says it is not applied.
  const sqlFiles = readdirSync(join(dirname(fileURLToPath(import.meta.url)), "..")).filter((f) => /^supabase_.*\.sql$/.test(f));
  const jointRe = /startJoint|start_joint|endJoint|end_joint/;
  const storedIn = ["app/src/main/java/com/fenceestimator/app/data/Entities.kt", ...sqlFiles]
    .filter((f) => { const t = readRepo(f); return jointRe.test(t) && !/WRITTEN, NOT APPLIED/.test(t); });
  const proposedIn = sqlFiles.filter((f) => { const t = readRepo(f); return jointRe.test(t) && /WRITTEN, NOT APPLIED/.test(t); });
  ok("7k", "HONESTY: the header says 'no joint is stored anywhere' exactly while no Room entity has a joint field and no APPLIED SQL patch adds a joint column",
    /no joint is stored[\s*]+anywhere/.test(kt) === (storedIn.length === 0),
    storedIn.length > 0 ? `${storedIn.join(", ")} now carry a joint column or field; the FenceGeometry.kt header still says none is stored. Update it.` : "the header no longer says no joint is stored, yet none is.");
  ok("7k-proposed", "the header names the proposed-but-unapplied schema file it mirrors, while one exists", proposedIn.length === 0 || proposedIn.every((f) => kt.includes(f)),
    `${proposedIn.join(", ")} proposes joint columns but the FenceGeometry.kt header does not mention it.`);
}

// ---------------------------------------------------------------------------
console.log("\n----------------------------------------------------------------------");
console.log(`${passed} ok, ${failed} FAIL`);
if (failed > 0) { console.log(`FAILED: ${failedIds.join(", ")}`); process.exitCode = 1; }
else console.log("Every join-arithmetic check passed. (The engine does not call this yet; see the header of FenceGeometry.kt.)");

// =============================================================================
// The Kotlin cross-check.
//
// KOTLIN_HARNESS is the whole of the program that produced KOTLIN_GOLDEN. To regenerate after changing
// RunJoinArithmetic or this file's scenarios (nothing here needs Gradle, and nothing may touch the Gradle
// build while other waves compile):
//   1. node -e "import('./tests/a33-join-arithmetic-posts.test.mjs').then(m => { require('fs').writeFileSync('input.txt', m.toKotlinInput()); require('fs').writeFileSync('Harness.kt', m.KOTLIN_HARNESS); })"
//   2. java -Xmx1g -cp <kotlin-compiler-embeddable-2.0.21 + kotlin-stdlib + kotlin-script-runtime + kotlin-reflect 1.6.10
//        + kotlin-daemon-embeddable + trove4j + annotations + kotlinx-coroutines-core-jvm jars from ~/.gradle/caches>
//        org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -cp kotlin-stdlib-2.0.21.jar
//        -d out FenceGeometry.kt SideLength.kt GateSpan.kt Harness.kt        (classpath separator is ; on Windows, : elsewhere)
//   3. java -cp out;kotlin-stdlib-2.0.21.jar HarnessKt input.txt   > golden.txt   and paste golden.txt into KOTLIN_GOLDEN.
// It compiles three pure files of one package (kotlin.math and java.lang.Math only; FenceGeometry.kt calls landSide in
// SideLength.kt, which calls GateGeometry in GateSpan.kt), so it never touches the code other waves are editing. Run it
// when the machine has memory to spare: it is one JVM at about 700 MB for half a minute.
// =============================================================================
export const KOTLIN_HARNESS = `import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FenceGeometryEngine
import com.fenceestimator.app.geometry.FenceGeometryResult
import com.fenceestimator.app.geometry.JoinableRun
import com.fenceestimator.app.geometry.RunJoinArithmetic
import java.io.File

fun main(args: Array<String>) {
    val order = ArrayList<String>()
    val byScenario = HashMap<String, MutableList<JoinableRun>>()
    for (line in File(args[0]).readLines()) {
        if (line.isBlank()) continue
        val p = line.split("|")
        val name = p[0]
        val closed = p[3] == "1"
        val manual = if (p[4] == "-") 0f else p[4].toFloat()
        val points = if (p[2] == "-") "" else p[2]
        val geometry: FenceGeometryResult =
            if (manual > 0f) FenceGeometryResult(manual, emptyList(), emptyList(), 0, if (closed) 0 else 2, 0)
            else FenceGeometryEngine.analyze(FenceCodec.decodePoints(points), 20f, closed)
        val run = JoinableRun(
            id = p[1],
            geometry = geometry,
            heightFt = p[5].toFloat(),
            sortOrder = p[6].toInt(),
            isTeardown = p[7] == "1",
            startJointId = if (p[8] == "-") "" else p[8],
            endJointId = if (p[9] == "-") "" else p[9],
        )
        if (!byScenario.containsKey(name)) {
            order.add(name)
            byScenario[name] = ArrayList()
        }
        byScenario.getValue(name).add(run)
    }
    for (name in order) {
        val adj = RunJoinArithmetic.adjust(byScenario.getValue(name))
        for (id in adj.perRun.keys.sorted()) {
            val a = adj.perRun.getValue(id)
            println(name + "|ADJ|" + id + "|" + a.linePostsDelta + "|" + a.cornerPostsDelta + "|" + a.endPostsDelta)
        }
        for (post in adj.posts) {
            println(name + "|POST|" + post.jointId + "|" + post.kind.name + "|" + post.ownerRunId + "|" + post.memberRunIds.joinToString(","))
        }
        for (ig in adj.ignored) println(name + "|IGN|" + ig.jointId + "|" + ig.reason.name)
        println(name + "|SAVED|" + adj.postsSaved)
    }
}
`;
