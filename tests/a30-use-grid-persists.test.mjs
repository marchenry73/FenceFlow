// "Use Grid" must stick, and must not leave the job unpriceable.
//
// He reported: "I said use grid only, and when I got out and I came back to the
// page, it brought back the survey picture."
//
// WHY THIS FILE EXISTS AND IS CURRENTLY RED ON PURPOSE.
// The fix belongs in SurveyViewModel.clearSurveyImage(), and at the moment this
// test was written that file was being edited by another agent. Editing it
// concurrently is how two agents lose each other's work in this repo, so the bug
// is pinned here first and the source fix follows. A deliberate red with a clear
// message is the precedent this project already uses (see GuestReadOnlyTest's own
// red flag). If you are reading this because the suite is red: either apply the
// two changes named below, or delete this file -- but do not "fix" it by
// weakening the assertions, because then the bug ships silently.
//
// THE BUG, read from the source rather than inferred.
// clearSurveyImage() is what the "Use Grid" control calls. It writes
// surveyImagePath = null and never touches surveyStoragePath. Those are two
// different fields and only the SECOND one travels: it syncs to the office and to
// any other phone. So the device-local path is cleared, the travelling one
// survives, and the next load of the screen sees a photo still attached and draws
// it. The choice was never persisted in the field that decides.
//
// AND THE EXPENSIVE HALF. The same write sets the calibration to NULL whenever a
// travelling photo path is present -- which is the normal state of a photo that
// has synced. An uncalibrated photo job now prices NOTHING, deliberately, because
// guessing a scale for a photo was judged worse than refusing. So pressing a
// button meant to simplify things can leave the picture back AND the quote at
// zero. The null branch is right in general (do not invent a scale for a photo)
// and wrong here (after this action there is no photo to invent one for).
//
// Run: node --test tests/a30-use-grid-persists.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PATH = "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt";
const src = readFileSync(new URL("../" + PATH, import.meta.url), "utf8");

// Pull the body of a named function by brace balance, so the checks below are
// about THAT function and not about the word appearing anywhere in a 1300-line
// file. Reports what it could not find rather than throwing on a bad index --
// this repo has been bitten three times by a probe that crashed on indexOf
// returning -1 instead of giving a verdict.
function bodyOf(name) {
  const at = src.indexOf(`fun ${name}(`);
  assert.notEqual(
    at, -1,
    `could not find "fun ${name}(" in ${PATH}. It was renamed or removed; this ` +
    `probe needs updating, and that is a different problem from the bug it checks.`
  );
  const open = src.indexOf("{", at);
  assert.notEqual(open, -1, `found fun ${name} but no opening brace after it`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  assert.fail(`braces never balanced for fun ${name} -- the file may be mid-edit`);
}

test("Use Grid clears the field that TRAVELS, not only the device-local one", () => {
  const body = bodyOf("clearSurveyImage");

  // Guard the guard: if this function stopped clearing the local path we would
  // want to know that too, and its presence proves the probe is reading the
  // right function rather than an empty string.
  assert.match(
    body, /surveyImagePath\s*=\s*null/,
    "clearSurveyImage no longer clears surveyImagePath at all -- read it before trusting this file"
  );

  assert.match(
    body,
    /surveyStoragePath\s*=\s*null/,
    "clearSurveyImage does not clear surveyStoragePath. That is the field that syncs " +
    "to the office and to other phones, so the photo comes back the next time the " +
    "screen loads: 'I said use grid only... it brought back the survey picture.' " +
    "Clear it in the SAME write, or the choice is not persisted where it counts."
  );
});

test("after choosing the grid, the job is left measurable rather than unpriceable", () => {
  const body = bodyOf("clearSurveyImage");

  // The specific shape of the bug: a conditional that writes a null calibration
  // on the branch taken when a travelling photo path exists. After this action
  // there is no photo, so that branch should not be reachable from here.
  const writesNullCalibration =
    /calibrationPixelsPerFoot\s*=\s*if\s*\([^)]*surveyStoragePath[^)]*\)/.test(body) &&
    /\bnull\b/.test(body.slice(body.indexOf("calibrationPixelsPerFoot")));

  assert.equal(
    writesNullCalibration, false,
    "clearSurveyImage still decides the calibration by asking whether a travelling " +
    "photo path exists, and writes null when it does. That branch is the normal case " +
    "for a photo that has synced, so choosing the grid leaves the job with NO " +
    "calibration -- and an uncalibrated photo job prices nothing. The result is the " +
    "picture back and a quote of zero. Once the travelling path is cleared in the " +
    "same write there is no photo left to protect, so seed the grid calibration " +
    "unconditionally here."
  );
});

test("the grid calibration seeded here comes from the job's own extent, not a constant", () => {
  const body = bodyOf("clearSurveyImage");
  assert.match(
    body, /unitsPerFoot\s*\(\s*[^)]*gridExtentFt/,
    "the calibration seeded by Use Grid must be derived from the job's own grid extent. " +
    "A hardcoded 20 is only correct at the default 400ft extent, and a job on any other " +
    "size would then measure wrongly -- that exact mismatch was found on a live job and " +
    "had to be corrected by hand."
  );
});
