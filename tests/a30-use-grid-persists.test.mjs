// "Use Grid" must stick, and must not leave the job unpriceable.
//
// He reported: "I said use grid only, and when I got out and I came back to the
// page, it brought back the survey picture."
//
// WHY THIS FILE EXISTED, AND WHAT IT NOW CHECKS INSTEAD (RE-AIMED 2 Oct 2026).
//
// It was written red on purpose against a diagnosis: clearSurveyImage() wrote
// surveyImagePath = null and left surveyStoragePath alone; only the second field
// travels, so the next sync pass brought the photo back and "Use Grid" came back
// undone. The fix it demanded was "clear the travelling field in the same write".
//
// THAT FIX WAS TRIED AND IS REFUTED. It cannot work from an owner's phone:
// EntitySync pushes with explicitNulls = false, so a null key is DROPPED from the
// body, and the row the server hands back is merged over the phone's -- the path
// returns on the next push. app/src/test/.../survey/SurveyNullsDoNotTravelTest.kt
// runs both halves of that (the null is left out of the body; the server's row puts
// its photo and its scale back over the phone's nulls). The crew door does send an
// explicit null, but a choice that only holds on one kind of phone is not a choice.
// And the owner asked for the survey to be SAVED, not discarded.
//
// SO THE DESIGN CHANGED, deliberately, and the doc comment on clearSurveyImage
// records it: "Use Grid" clears the BACKGROUND, never the survey. The choice is now
// persisted where it CAN be kept -- a device-local display setting (surveyPhotoShown,
// backed by SharedPreferences) that survives leaving the screen, which is exactly the
// symptom he reported. The photo stays saved on the phone and in the cloud, and
// showSurveyPhoto() brings it back.
//
// The checks below are therefore re-aimed, NOT removed, and they keep their teeth.
// The three things that must stay true of "Use Grid":
//   1. the choice is PERSISTED (not only held in memory), and the photo is NOT
//      destroyed to achieve it -- nulling either path is the discarded-survey bug;
//   2. it never leaves the job unpriceable, and never gives drawn photo-pixel lines
//      a made-up scale -- those are the two opposite ways to be wrong about scale;
//   3. the scale it seeds is derived from the job's OWN grid extent, not a constant.
//      That derivation MOVED out of this function into DrawingScale.gridBackdropPlan,
//      so check 3 now follows it there and reads both halves.
//
// Run: node --test tests/a30-use-grid-persists.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PATH = "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt";
const src = readFileSync(new URL("../" + PATH, import.meta.url), "utf8");

// The scale half of "Use Grid" moved here (DrawingScale.gridBackdropPlan), so check 3
// has to read this file too or it would be grading prose in the view model.
const SCALE_PATH = "app/src/main/java/com/fenceestimator/app/estimate/DrawingScale.kt";
const scaleSrc = readFileSync(new URL("../" + SCALE_PATH, import.meta.url), "utf8");

// Kotlin with comments stripped. Every check below reads code, so a sentence in a doc
// comment -- and clearSurveyImage now has a long one, naming every field and null this
// file used to look for -- cannot satisfy a check about what the function DOES.
const stripKt = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

// Pull the body of a named function by brace balance, so the checks below are
// about THAT function and not about the word appearing anywhere in a 1300-line
// file. Reports what it could not find rather than throwing on a bad index --
// this repo has been bitten three times by a probe that crashed on indexOf
// returning -1 instead of giving a verdict.
function bodyOf(name, from = src, where = PATH) {
  const text = stripKt(from);
  const at = text.indexOf(`fun ${name}(`);
  assert.notEqual(
    at, -1,
    `could not find "fun ${name}(" in ${where}. It was renamed or removed; this ` +
    `probe needs updating, and that is a different problem from the bug it checks.`
  );
  const open = text.indexOf("{", at);
  assert.notEqual(open, -1, `found fun ${name} but no opening brace after it`);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  assert.fail(`braces never balanced for fun ${name} -- the file may be mid-edit`);
}

// RE-AIMED. Was: "Use Grid clears the field that TRAVELS, not only the device-local one."
// Clearing the travelling field is refuted (see the header), and the survey must be KEPT, so
// the same symptom -- "I said use grid only... it brought back the survey picture" -- is now
// pinned by the two things that actually prevent it: the choice is written down, and the photo
// is left alone. Both halves have teeth: delete either and this goes red.
test("Use Grid PERSISTS the choice, and does not destroy the survey to do it", () => {
  const body = bodyOf("clearSurveyImage");

  // Canary: the probe is reading a real body and not an empty string. clearSurveyImage is
  // guest-gated like every write in this view model, so this line is in every version of it.
  assert.match(
    body, /viewerIsGuestDemo\(\)/,
    "clearSurveyImage has no guest gate -- read the function before trusting anything below"
  );

  // 1a. The choice is recorded, not just held for this screen. rememberSurveyShown(false) is
  //     the one call that writes it; without it the photo is back on the next screen load,
  //     which is the bug he reported.
  assert.match(
    body, /rememberSurveyShown\(\s*false\s*\)/,
    "clearSurveyImage does not call rememberSurveyShown(false), so choosing the grid is not " +
    "written down anywhere. The photo is back the next time the screen loads: 'I said use grid " +
    "only, and when I got out and I came back to the page, it brought back the survey picture.'"
  );

  // 1b. ...and that call must actually reach storage rather than only a StateFlow. This is the
  //     check that stops 1a being satisfied by an in-memory flag.
  const remember = bodyOf("rememberSurveyShown");
  assert.match(
    remember, /backdropPrefs\s*\.\s*edit\(\)[\s\S]*putBoolean\(/,
    "rememberSurveyShown no longer writes to SharedPreferences, so the choice lives only in " +
    "memory and dies with the view model -- which is the original bug by another route."
  );

  // 1c. The survey is KEPT. Nulling either path is the discarded-survey bug: the owner asked for
  //     the survey to be saved, and the travelling null does not travel anyway.
  assert.doesNotMatch(
    body, /survey(Image|Storage)Path\s*=\s*null/,
    "clearSurveyImage nulls a survey path again. 'Use Grid' clears the BACKGROUND, never the " +
    "survey: the photo must stay saved on the phone and in the cloud so showSurveyPhoto() can " +
    "bring it back. A travelling null is also dropped by explicitNulls = false and comes " +
    "straight back (SurveyNullsDoNotTravelTest), so this would not even hold."
  );
});

test("after choosing the grid, the job is left measurable rather than unpriceable", () => {
  const body = bodyOf("clearSurveyImage");

  // The original shape of the bug: a conditional that writes a null calibration on the branch
  // taken when a travelling photo path exists -- the normal state of a synced photo -- leaving
  // the job with no scale, and an uncalibrated photo job prices NOTHING. Kept as-is: it can no
  // longer arise the same way, but it is the cheapest possible guard against it coming back.
  const writesNullCalibration =
    /calibrationPixelsPerFoot\s*=\s*if\s*\([^)]*surveyStoragePath[^)]*\)/.test(body) &&
    /\bnull\b/.test(body.slice(body.indexOf("calibrationPixelsPerFoot")));

  assert.equal(
    writesNullCalibration, false,
    "clearSurveyImage decides the calibration by asking whether a travelling photo path " +
    "exists, and writes null when it does. That branch is the normal case for a photo that " +
    "has synced, so choosing the grid leaves the job with NO calibration -- and an " +
    "uncalibrated photo job prices nothing: the picture back and a quote of zero."
  );

  // RE-AIMED, same subject. The scale decision moved to DrawingScale.gridBackdropPlan, so the
  // way to be left unpriceable moved with it: the Allowed(seed) a job with no scale gets must
  // actually be WRITTEN, or "Use Grid" still ends on the grid with nothing to measure with.
  assert.match(
    body, /calibrationPixelsPerFoot\s*=\s*seed\b/,
    "clearSurveyImage no longer writes the seed gridBackdropPlan handed it, so a job with no " +
    "scale is switched to the grid and left unable to measure anything drawn on it -- a quote " +
    "of zero, by a new route."
  );

  // And the OPPOSITE error, which is the expensive one: lines already drawn on an uncalibrated
  // photo are photo-pixel lengths. Handing them the grid's scale would price a made-up length,
  // so that case must be refused, not seeded.
  assert.match(
    body, /GridBackdropPlan\.NeedsScale\s*->/,
    "clearSurveyImage no longer handles GridBackdropPlan.NeedsScale, so a job with lines " +
    "already drawn on an uncalibrated photo is no longer refused. Giving those photo-pixel " +
    "lines the grid's scale prices a length nobody measured."
  );
});

// RE-AIMED: the derivation MOVED, it was not abandoned. clearSurveyImage used to compute the seed
// itself; DrawingScale.gridBackdropPlan computes it now and clearSurveyImage writes what it is
// handed. So this reads both halves -- the hand-off here, and the arithmetic there. Checking only
// the view model would call correct code broken; checking only DrawingScale would miss a view
// model that ignored it.
test("the grid calibration seeded for Use Grid comes from the job's own extent, not a constant", () => {
  const body = bodyOf("clearSurveyImage");
  assert.match(
    body, /DrawingScale\.gridBackdropPlan\(/,
    "clearSurveyImage does not ask DrawingScale.gridBackdropPlan for the scale. If it computes " +
    "one itself again, the derivation below is no longer the one that runs -- re-aim this check " +
    "at wherever it went, and keep both halves."
  );

  const plan = bodyOf("gridBackdropPlan", scaleSrc, SCALE_PATH);
  assert.match(
    plan, /unitsPerFoot\s*\(\s*[^)]*gridExtentFt/,
    "the calibration seeded by Use Grid must be derived from the job's own grid extent. " +
    "A hardcoded 20 is only correct at the default 400ft extent, and a job on any other " +
    "size would then measure wrongly -- that exact mismatch was found on a live job and " +
    "had to be corrected by hand."
  );

  // The teeth of "not a constant": a literal seed, or PIXELS_PER_FOOT_GRID used as the seed,
  // is the live-job mismatch coming back. unitsPerFoot may fall back to it for extent <= 0;
  // what must not happen is the plan handing back a constant INSTEAD of the derivation.
  assert.doesNotMatch(
    plan, /Allowed\(\s*seed\s*=\s*(\d|PIXELS_PER_FOOT_GRID)/,
    "gridBackdropPlan hands back a constant seed. A fixed 20 measures correctly only on a " +
    "400 ft grid; the live job with a 25 ft grid and a stored 20 was sixteen times too long " +
    "and had to be corrected by hand."
  );
});

// ---------------------------------------------------------------------------
// ADDED BY REVIEW, 2 Oct 2026. The re-aim above stopped one step short.
//
// The owner's symptom is "it brought back the survey picture" -- a RENDER, not a write.
// Under the new design the chain has three links: clearSurveyImage writes the choice,
// the view model reads it back on construction, and the SCREEN must honour it. The
// checks above pin the first two. Nothing pinned the third, here or anywhere else
// (`grep -rl surveyPhotoShown tests/ app/src/test/` returned this file alone), so
// deleting the gate in SurveyDrawScreen would bring his exact bug back with the suite
// still green. That is the hole this closes.
// ---------------------------------------------------------------------------

const SCREEN_PATH = "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt";
const screenSrc = readFileSync(new URL("../" + SCREEN_PATH, import.meta.url), "utf8");

test("the SCREEN honours the remembered choice -- the photo is not loaded while it is hidden", () => {
  const code = stripKt(screenSrc);

  // Canary: the screen must still be collecting the flag at all. Without this, a screen
  // that never heard of surveyPhotoShown would sail through the check below on a regex
  // that found nothing to object to.
  assert.match(
    code, /viewModel\.surveyPhotoShown\s*\.\s*collectAsState\(\)/,
    "SurveyDrawScreen no longer collects surveyPhotoShown, so the remembered choice reaches " +
    "nothing that draws. 'Use Grid' is written down and then ignored -- the photo is back on " +
    "the next screen load, which is the bug this file exists for."
  );

  // The gate itself: the path handed to the decoder is conditional on the flag. Written as
  // the shape rather than the exact line so a rename of the local does not fail this, but a
  // LOST condition does.
  assert.match(
    code, /if\s*\(\s*surveyShown\s*\)\s*job\?\.surveyImagePath\s+else\s+null/,
    "the survey photo is loaded without asking whether it is meant to be shown. 'Use Grid' " +
    "then hides nothing: 'I said use grid only, and when I got out and I came back to the " +
    "page, it brought back the survey picture.' If the gate moved, re-aim this at where it " +
    "went -- do not drop it, it is the only check on the render half."
  );

  // ...and the load must re-run when the flag changes, or pressing Use Grid leaves the
  // already-decoded bitmap on screen until the job itself changes.
  assert.match(
    code, /LaunchedEffect\(\s*job\?\.surveyImagePath\s*,\s*surveyShown\s*\)/,
    "the photo load no longer keys on surveyShown, so the choice only takes effect the next " +
    "time the image path changes -- pressing Use Grid would leave the picture on screen."
  );
});
