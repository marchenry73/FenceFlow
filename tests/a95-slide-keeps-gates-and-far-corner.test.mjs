// a95: ATTACHING A SIDE MUST NOT LOSE ITS GATES OR OPEN ANOTHER CORNER.
//
// Two defects shipped in app 1.602, both in slideRunToMeet, both found by a
// review of that release rather than by any test -- nothing covered
// slideRunToMeet or JoinGapCloser at all.
//
// (1) THE GATES STAYED BEHIND. slideRunToMeet called writePoints(run, slid)
//     and let gatesEncoded default to the run's existing value. A GateMarker
//     is a loose plan point matched to its side at READ time by projecting
//     onto the nearest segment, so leaving them does not visibly orphan them:
//     it slides each gate ALONG the fence by the part of the move parallel to
//     that side, clamps one near a corner onto the corner, and on a
//     multi-segment run can re-match it to a different side. The drawing, the
//     crew plan and the PDF all read gatesEncoded.
//
// (2) IT DRAGGED AN ALREADY-JOINED FAR CORNER OFF ITS POST. gapCloserFor only
//     guarantees the end being MOVED is free. A side in the middle of a chain
//     has both ends joined, and translating the whole run pulls the far corner
//     away from the post it shares. The joint id is untouched, so the takeoff
//     goes on deducting one shared post while the plan shows a gap -- a post,
//     a cap and a bag of concrete short, and with the distance cap removed the
//     gap can be many feet.
//
// Source-level, like a41 and a33, because slideRunToMeet is a private method
// on a ViewModel that needs a repository and a coroutine scope to call.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VM = process.env.A95_VM ||
  join(ROOT, "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt");
const src = readFileSync(VM, "utf8");

let passed = 0, failed = 0;
const ok = (id, what, cond, detail) => {
  if (cond) { passed++; console.log(`  ok    ${id} ${what}`); }
  else { failed++; console.log(`  FAIL  ${id} ${what}${detail ? " -- " + detail : ""}`); }
};

/** The body of a named function, by brace matching. */
function bodyOf(name) {
  const i = src.indexOf(`fun ${name}(`);
  if (i < 0) return "";
  const open = src.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(i, j + 1); }
  }
  return "";
}

const slide = bodyOf("slideRunToMeet");
const farEnd = bodyOf("farEndIsJoined");

console.log("\n1. THE FUNCTIONS ARE STILL THERE TO CHECK");
ok("1a", "slideRunToMeet was found", slide.length > 100, `${slide.length} chars`);
ok("1b", "farEndIsJoined was found", farEnd.length > 80, `${farEnd.length} chars`);

console.log("\n2. THE GATES MOVE WITH THE SIDE");
ok("2a", "it reads the run's gates", /FenceCodec\.decodeGates\(run\.gatesEncoded\)/.test(slide));
ok("2b", "it shifts every gate by the SAME offset the points moved by",
  /\.map \{ it\.copy\(x = it\.x \+ dx, y = it\.y \+ dy\) \}/.test(slide));
ok("2c", "and writePoints is handed the new gates, not left to default to the old ones",
  /writePoints\(run, slid\.toMutableList\(\), FenceCodec\.encodeGates\(/.test(slide),
  (slide.match(/writePoints\([^)]*\)/) || [])[0]);
// The defect was precisely the two-argument call, which silently keeps the old
// gatesEncoded through its default parameter.
ok("2d", "there is no two-argument writePoints left in the slide",
  !/writePoints\(run, slid\.toMutableList\(\)\)/.test(slide));

console.log("\n3. A SIDE WHOSE FAR END IS JOINED IS STRETCHED, NOT SLID");
ok("3a", "the caller asks farEndIsJoined before choosing",
  /if \(farEndIsJoined\(closer\)\) moveJoinedEnd\(closer\) else slideRunToMeet\(closer\)/.test(src));
ok("3b", "farEndIsJoined reads the OPPOSITE end's joint from the run itself",
  /if \(closer\.end\.atEnd\) target\.startJoint else target\.endJoint/.test(farEnd),
  farEnd.slice(0, 200));
ok("3c", "a blank joint means free, so an unjoined far end still slides",
  /isNotBlank\(\)/.test(farEnd));
// moveJoinedEnd became unreachable when the slide replaced it, which is how
// this case was lost. It must stay reachable.
ok("3d", "moveJoinedEnd is reached from somewhere other than its own declaration",
  (src.match(/moveJoinedEnd\(/g) || []).length >= 2,
  `${(src.match(/moveJoinedEnd\(/g) || []).length} mentions`);

console.log("\n4. CANARIES");
ok("4a", "CANARY: bodyOf really extracts a body rather than returning the whole file",
  slide.length < src.length / 4);
ok("4b", "CANARY: 2b is anchored to the offset names, so translating by something else fails it",
  !/\.map \{ it\.copy\(x = it\.x \+ dx, y = it\.y \+ dy\) \}/.test("gates.map { it.copy(x = it.x, y = it.y) }"));

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
