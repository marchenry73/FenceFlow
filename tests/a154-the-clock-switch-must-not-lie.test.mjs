// a154: TURNING THE CLOCK OFF MUST NOT SAY HE IS OFF THE JOB.
//
// The owner asked for the Clock In button to be hidden for him and kept for
// crew, with a switch so anybody who works from a shared phone can turn it
// back on. I gated the button with the flag that was already there:
//
//     allowClockIn = !kept && offerClock
//
// That flag's false branch is not silent. It prints a REASON:
//
//     "Clock-in is off: you are no longer on this job."
//
// which is true when a crew member has been taken off a job and false when
// the owner has simply switched the button off -- and the switch starts off,
// so the default state of the feature he asked for was to tell him, on every
// job he opened, that he had been removed from his own work. The parameter's
// own doc comment warned about this in writing ("a reason that would be a
// lie here") and I folded the new condition into it anyway.
//
// Two facts, two flags. This test is what stops them being merged again by
// someone who sees one `if` where two would do.
//
// Source-level because the subject is a Compose branch: there is no seam to
// call, and the wrong version compiles, passes every other test, and looks
// right in review. What it got wrong was the WORDS, which only a reader sees.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SCREEN = "app/src/main/java/com/fenceestimator/app/ui/crew/CrewJobScreen.kt";
const SRC = readFileSync(SCREEN, "utf8");
const STRINGS = readFileSync("app/src/main/res/values/strings.xml", "utf8");

/** Kotlin with comments stripped and whitespace collapsed.
 *
 *  Not cosmetic: every "must NOT contain" assertion below would otherwise be
 *  satisfied or broken by the prose ABOVE the code, and this file's comments
 *  quote the very expression being forbidden. */
const code = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\s+/g, " ");

const CODE = code(SRC);

test("a154 the lying string is only reached when the clock is on offer", () => {
  // The branch that prints it must test BOTH facts. Whatever the spacing or
  // the operand order, `offerClockIn` has to appear in the same condition.
  const at = CODE.indexOf("R.string.crew_kept_no_clock_in");
  assert.notEqual(at, -1, "the kept message is gone from the screen -- re-aim this test");
  // Back up to the `if` that guards it. 200 chars is comfortably more than
  // the branch head and comments are already stripped.
  const guard = CODE.slice(Math.max(0, at - 200), at);
  assert.match(
    guard,
    /offerClockIn/,
    "the kept message is printed without checking whether the viewer asked for the clock at all: " +
      "an owner with the switch off is told he is no longer on his own job",
  );
  assert.match(guard, /!allowClockIn/, "the kept message no longer depends on the job being kept");
});

test("a154 the two facts are two flags, at the call site", () => {
  assert.match(
    CODE,
    /allowClockIn = !kept,/,
    "allowClockIn is no longer just 'is this person off the job' -- something else was folded in",
  );
  assert.match(CODE, /offerClockIn = offerClock,/, "the owner's choice is not passed separately");
  assert.ok(
    !/allowClockIn = !kept && /.test(CODE),
    "a second condition has been folded back into allowClockIn, whose false branch prints a reason",
  );
});

test("a154 crew are never the ones refused the clock", () => {
  // The switch is the owner's. The only way crew lose the button is losing
  // the job, which is allowClockIn's business and says so out loud.
  assert.match(
    CODE,
    /val offerClock = viewerIsCrew \|\| ownerClockIn/,
    "the offer no longer starts from 'is this person crew' -- crew may now be refused the clock",
  );
  assert.match(CODE, /UserRole\.CREW/, "the role the switch must never apply to is not named");
});

test("a154 a running shift can always be ended", () => {
  // The clock-out button must not sit behind either flag. An owner who was
  // clocked in before switching the button off, or a crew member taken off
  // the job mid-shift, still has hours running; refusing to stop them is how
  // a shift runs all night.
  // The BUTTON, not the call site's `onClockOut = { ... }` argument -- the
  // first match of the bare name is that argument, and a window measured
  // backwards from it lands in the parameter list, where both flags are
  // passed and nothing is decided. That is this check failing on correct
  // code, which is how it read the first time it was run.
  const at = CODE.indexOf("Button(onClick = onClockOut");
  assert.notEqual(at, -1, "the clock-out button is gone -- re-aim this test");
  const open = CODE.lastIndexOf("if (running != null)", at);
  assert.notEqual(open, -1, "the clock-out button is no longer inside a running-shift branch");
  const branch = CODE.slice(open, at);
  assert.ok(
    !/offerClockIn|allowClockIn/.test(branch),
    "ending a running shift now depends on being offered a NEW one, so a shift can be left running",
  );
});

test("a154 CANARY: this is reading the real screen and the real words", () => {
  // Every assertion above is a regex over source. An empty or wrong file
  // would make the "must not contain" ones pass vacuously.
  assert.ok(SRC.length > 20000, `${SCREEN} came back suspiciously short (${SRC.length} chars)`);
  assert.match(CODE, /private fun TimeClockCard\(/, "TimeClockCard is not in this file at all");
  assert.match(CODE, /offerClockIn: Boolean = true/, "the parameter this test is about does not exist");
  // And the string really does make the claim that must not be shown wrongly.
  // If its wording is ever softened to something true in both cases, this
  // assertion fails and the whole test can be retired on purpose.
  assert.match(
    STRINGS,
    /crew_kept_no_clock_in">Clock-in is off: you[^<]*no longer on this job\.</,
    "the kept message no longer claims the viewer is off the job -- re-read a154 and decide if it still applies",
  );
  // The stripper must strip, or the forbidding assertions read prose as code.
  assert.equal(code("a /* x */ b // y\nc"), "a b c");
});
