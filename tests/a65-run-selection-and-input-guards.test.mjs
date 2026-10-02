// A65 -- HIS FENCE LANDED ON THE WRONG SIDE, AND A BAD NUMBER DELETED HIS
// PRICED LINES. Two confirmed findings from the adversarial grid audit, both
// of which cost money.
//
// Run:   node tests/a65-run-selection-and-input-guards.test.mjs
//        (exit 0 = every check passed)
//
// Plain node on purpose. This sandbox cannot run Gradle -- concurrent builds
// on a 16 GB machine kill each other -- so the Kotlin unit tests cannot be run
// tonight at all. That is exactly why every rule under test was written as a
// PURE function in SurveyViewModel's companion object (no repository, no
// Context, no clock): a rule that lives inside a composable or behind a
// suspend call is a rule nothing off-device can check, and both findings below
// survived to reach a real quote because the code that held them was the code
// no test could reach.
//
// =============================================================================
// FINDING 1 -- THE DRAWING OPENED ON THE WRONG RUN
// =============================================================================
// Three separate defects stacked into one symptom.
//
//   (a) RunEditScreen's "Next: Draw This Fence" / "Edit the Drawing" called
//       onDrawRun(currentRun.jobId) -- the JOB id only -- and MainActivity
//       navigated Routes.survey(jobId). A fresh SurveyViewModel starts with
//       selectedRunId = null, and the old ensureSelection took
//       runs.firstOrNull(). So he named side 2, tapped the button ON SIDE 2's
//       OWN SCREEN, and the drawing opened with side 1 selected. His next
//       corners were appended to side 1's polyline: side 1's footage jumped,
//       side 2 stayed empty, and the quote stopped describing the yard.
//
//   (b) createBlankRun (the drawing screen's own Add) never set sortOrder, so
//       it took the entity default of 0 and TIED with run 1. FenceRunDao reads
//       `ORDER BY sortOrder ASC, syncId ASC`, and syncId is a random UUID --
//       so "the first run" meant a different row from one visit to the next,
//       and the list re-shuffled whenever a run was added.
//
//   (c) createBlankRun never set a label either, so the picker showed several
//       rows all reading "Untitled (Vinyl)". Carrying the right run through
//       the route is worth nothing if he cannot see which one is selected.
//
// =============================================================================
// FINDING 2 -- A BAD NUMBER DELETED THE PRICED LINES
// =============================================================================
// A zero, negative or non-finite gate width, panel width, post spacing or
// calibration distance reaches the takeoff, the takeoff produces no usable
// quantity, and the OFFICE commit then deletes the panel, line-post, cap and
// concrete rows and nulls the contract total. The number that caused it is
// three screens away from the damage.
//
// The nastiest part is that NaN and Infinity PARSE. Kotlin's
// String.toFloatOrNull defers to java.lang.Float.parseFloat, whose accepted
// grammar includes the literals "NaN", "Infinity" and "-Infinity" -- so the
// gate dialog's old `text.toFloatOrNull()?.let { onConfirm(it) }` accepted all
// three, while silently doing NOTHING for "5ft", which is how a person
// actually writes a measurement.
//
// Every probe here carries a POSITIVE CONTROL and the canaries re-run the OLD
// logic to prove each assertion could fail. An empty answer is not good news.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(REPO, p), "utf8");

/**
 * The same file as it is in the last commit, i.e. BEFORE this change.
 *
 * This is what makes section 10 a real canary rather than a re-statement of
 * the fix. Every source probe in section 9 is run against the committed copy
 * and asserted to FAIL there -- a probe that passes against the old code and
 * the new code is a probe that is not testing anything, which is how an audit
 * reports zero failures for a case it never looked at.
 *
 * Returns null if git cannot answer (a checkout with no history, a path that
 * did not exist yet). Section 10 then says so out loud and counts a failure
 * rather than quietly skipping, because an unverified canary is not a passed
 * one.
 */
function headSource(path) {
  try {
    return execFileSync("git", ["show", `HEAD:${path}`], {
      cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

let passed = 0;
let failed = 0;
function ok(id, label, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok    ${id} ${label}`); }
  else { failed++; console.log(`  FAIL  ${id} ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const VM = "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt";
const DRAW = "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt";
const RUNEDIT = "app/src/main/java/com/fenceestimator/app/ui/runs/RunEditScreen.kt";
const MAIN = "app/src/main/java/com/fenceestimator/app/MainActivity.kt";
const NAV = "app/src/main/java/com/fenceestimator/app/ui/nav/NavGraph.kt";
const DAOS = "app/src/main/java/com/fenceestimator/app/data/Daos.kt";
const ENTITIES = "app/src/main/java/com/fenceestimator/app/data/Entities.kt";
const GEOM = "app/src/main/java/com/fenceestimator/app/geometry/FenceGeometry.kt";
const LISTVM = "app/src/main/java/com/fenceestimator/app/ui/runs/FenceRunListViewModel.kt";

const SRC = {
  vm: read(VM), draw: read(DRAW), runedit: read(RUNEDIT), main: read(MAIN),
  nav: read(NAV), daos: read(DAOS), entities: read(ENTITIES), geom: read(GEOM),
  listvm: read(LISTVM),
};

/**
 * Kotlin line comments and KDoc blocks stripped out.
 *
 * A claim about what the code DOES may never be satisfied by a sentence about
 * what it does. Three checks in one night read a comment and a label and
 * called correct code broken; the inverse is worse, because it is green.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}
const CODE = Object.fromEntries(
  Object.entries(SRC).map(([k, v]) => [k, stripComments(v)])
);

// =============================================================================
console.log("\n1. THE FILES ARE THERE, READABLE, AND THE ONES I THINK THEY ARE");
console.log("   (a check against an empty string passes everything; NUL bytes make grep silent)");
// =============================================================================
const fileChecks = [
  ["1a", VM, SRC.vm, /class\s+SurveyViewModel/, 50000],
  ["1b", DRAW, SRC.draw, /fun\s+SurveyDrawScreen/, 50000],
  ["1c", RUNEDIT, SRC.runedit, /fun\s+RunEditScreen/, 5000],
  ["1d", MAIN, SRC.main, /Routes\.SURVEY/, 10000],
  ["1e", NAV, SRC.nav, /object\s+Routes/, 500],
  ["1f", DAOS, SRC.daos, /interface\s+FenceRunDao/, 5000],
  ["1g", ENTITIES, SRC.entities, /data\s+class\s+FenceRun/, 5000],
  ["1h", GEOM, SRC.geom, /object\s+FenceGeometryEngine/, 5000],
  ["1i", LISTVM, SRC.listvm, /class\s+FenceRunListViewModel/, 1000],
];
for (const [id, path, src, probe, minBytes] of fileChecks) {
  ok(id, `${path} read, non-trivial, and is the right file`,
    src.length > minBytes && !src.includes("\u0000") && probe.test(stripComments(src)),
    `${src.length} bytes`);
}
ok("1j-canary", "canary: an empty source satisfies NONE of those probes",
  !/class\s+SurveyViewModel/.test(stripComments("")));

// =============================================================================
console.log("\n2. THE PREMISES OF FINDING 1, read off the real files");
console.log("   (if any of these is false the finding is refuted, not fixed)");
// =============================================================================
ok("2a", "FenceRunDao really orders by sortOrder then syncId, so a tie is broken by the UUID",
  /ORDER BY sortOrder ASC, syncId ASC/.test(CODE.daos));
ok("2b", "FenceRun.sortOrder really defaults to 0",
  /val\s+sortOrder:\s*Int\s*=\s*0/.test(CODE.entities));
ok("2c", "FenceRun.label really defaults to blank",
  /val\s+label:\s*String\s*=\s*""/.test(CODE.entities));
ok("2d", "FenceRun.syncId really is a random UUID, which is what makes the tie arbitrary",
  /val\s+syncId:\s*String\s*=\s*java\.util\.UUID\.randomUUID\(\)\.toString\(\)/.test(CODE.entities));
ok("2e", "the list screen has always used max+1, which is the behaviour being copied",
  /maxOfOrNull\s*\{\s*it\.sortOrder\s*\}\s*\?:\s*-1\s*\)\s*\+\s*1/.test(CODE.listvm));
ok("2f", "FenceGeometryEngine.analyze returns an empty result for pixelsPerFoot <= 0",
  /if\s*\(points\.size\s*<\s*2\s*\|\|\s*pixelsPerFoot\s*<=\s*0f\)/.test(CODE.geom));
ok("2g-canary", "canary: premise probes are not satisfied by a comment saying the same thing",
  !/ORDER BY sortOrder ASC, syncId ASC/.test(
    stripComments("// runs come back ORDER BY sortOrder ASC, syncId ASC\n")));

// =============================================================================
console.log("\n3. WHICH RUN A (jobId, runId, run list) RESOLVES TO");
// =============================================================================

/**
 * Faithful transcription of SurveyViewModel.resolveRunSelection.
 *
 * Returns { selectedRunId, requestStillPending }. Rules, in order:
 *   1. asked-for run is in the list                  -> select it, satisfied
 *   2. asked-for run and the list is EMPTY           -> hold, still pending
 *   3. asked-for run, list loaded, run absent        -> request spent, fall through
 *   4. no request: keep current if it still exists, else the first run
 */
function resolveRunSelection(runIds, currentSelection, requestedRunId) {
  const asked = (requestedRunId != null && requestedRunId > 0) ? requestedRunId : null;
  if (asked !== null) {
    if (runIds.includes(asked)) return { selectedRunId: asked, requestStillPending: false };
    if (runIds.length === 0) return { selectedRunId: currentSelection, requestStillPending: true };
  }
  const keepable = (currentSelection != null && runIds.includes(currentSelection))
    ? currentSelection : null;
  const first = runIds.length > 0 ? runIds[0] : null;
  return { selectedRunId: keepable ?? first, requestStillPending: false };
}

/** The OLD ensureSelection, for the canaries. ensureSelection() had no run id at all. */
function oldEnsureSelection(runIds, currentSelection) {
  if (currentSelection == null || !runIds.includes(currentSelection)) {
    return runIds.length > 0 ? runIds[0] : null;
  }
  return currentSelection;
}

// THE BUG, stated as a test. He is on side 2 (id 12) of a job whose runs are
// [11, 12, 13]. He taps "Next: Draw This Fence".
const JOB_RUNS = [11, 12, 13];

ok("3a", "the run he came from is the run that gets selected (side 2, id 12)",
  resolveRunSelection(JOB_RUNS, null, 12).selectedRunId === 12);
ok("3b-canary", "CANARY: the OLD logic selects run 11 for the same tap -- the bug, reproduced",
  oldEnsureSelection(JOB_RUNS, null) === 11);
ok("3c-canary", "CANARY: and 11 !== 12, so check 3a genuinely distinguishes new from old",
  oldEnsureSelection(JOB_RUNS, null) !== resolveRunSelection(JOB_RUNS, null, 12).selectedRunId);

ok("3d", "side 3 likewise (id 13), so it is not 'the second run' hardcoded",
  resolveRunSelection(JOB_RUNS, null, 13).selectedRunId === 13);
ok("3e", "POSITIVE CONTROL: the job-only route (no run asked) still takes the first run",
  resolveRunSelection(JOB_RUNS, null, null).selectedRunId === 11 &&
  resolveRunSelection(JOB_RUNS, null, null).requestStillPending === false);
ok("3f", "POSITIVE CONTROL: job-only route behaves EXACTLY as the old logic did, every case",
  [[JOB_RUNS, null], [JOB_RUNS, 12], [JOB_RUNS, 99], [[], null], [[], 5], [[7], 7]]
    .every(([ids, cur]) =>
      resolveRunSelection(ids, cur, null).selectedRunId === oldEnsureSelection(ids, cur)));

// Rule 2 is the one that would silently reintroduce the bug if it were wrong:
// `runs` is empty on the first frame and only fills when Room answers.
ok("3g", "runs not loaded yet: the request is HELD, not spent",
  resolveRunSelection([], null, 12).requestStillPending === true &&
  resolveRunSelection([], null, 12).selectedRunId === null);
ok("3h", "and once the list arrives, the held request still lands on run 12",
  resolveRunSelection(JOB_RUNS, resolveRunSelection([], null, 12).selectedRunId, 12)
    .selectedRunId === 12);
ok("3i-canary",
  "CANARY: had rule 2 answered 'firstOrNull' instead of holding, the next frame would latch run 11",
  (() => {
    // The wrong implementation: treat an empty list the same as a loaded one.
    const wrong = (ids, cur, asked) =>
      (asked && ids.includes(asked)) ? asked : (cur != null && ids.includes(cur) ? cur : (ids[0] ?? null));
    const firstFrame = wrong([], null, 12);              // null, request forgotten
    const secondFrame = wrong(JOB_RUNS, firstFrame, null); // request gone -> run 11
    return secondFrame === 11;
  })());

ok("3j", "a run deleted on another phone: the dead request is spent, not retried for ever",
  resolveRunSelection(JOB_RUNS, null, 99).requestStillPending === false);
ok("3k", "and it falls through to the first run rather than leaving nothing selected",
  resolveRunSelection(JOB_RUNS, null, 99).selectedRunId === 11,
  "a drawing with no selection takes no taps at all, which is worse than a visibly wrong run");
ok("3l", "a hand-picked side is not dragged back by the next sync emission",
  resolveRunSelection(JOB_RUNS, 13, null).selectedRunId === 13);
ok("3m", "runId 0 (NavType.LongType's default for an absent query parameter) is no request",
  resolveRunSelection(JOB_RUNS, null, 0).selectedRunId === 11);
ok("3n", "and so is a negative id",
  resolveRunSelection(JOB_RUNS, null, -1).selectedRunId === 11);
ok("3o", "an empty job selects nothing and asks for nothing",
  resolveRunSelection([], null, null).selectedRunId === null);

// =============================================================================
console.log("\n4. WHAT sortOrder A DRAWING-SCREEN RUN GETS");
// =============================================================================

/** Faithful transcription of SurveyViewModel.nextSortOrder. */
const nextSortOrder = (existing) =>
  (existing.length > 0 ? Math.max(...existing) : -1) + 1;

/** What createBlankRun used to do: nothing, so the entity default applied. */
const OLD_SORT_ORDER = 0;

ok("4a", "the first run on a job still gets 0, so every drawing already stored is untouched",
  nextSortOrder([]) === 0);
ok("4b", "a second run gets 1, not another 0",
  nextSortOrder([0]) === 1);
ok("4c-canary", "CANARY: the OLD code gave it 0, tying with run 1 -- the bug, reproduced",
  OLD_SORT_ORDER === 0 && OLD_SORT_ORDER !== nextSortOrder([0]));
ok("4d", "a third gets 2",
  nextSortOrder([0, 1]) === 2);
ok("4e", "gaps and out-of-order input: one past the HIGHEST, never a count",
  nextSortOrder([0, 5, 2]) === 6 && nextSortOrder([7, 1]) === 8);
ok("4f", "POSITIVE CONTROL: identical to FenceRunListViewModel.addRun's own nextOrder",
  (() => {
    const listScreenRule = (runs) => (runs.length ? Math.max(...runs.map((r) => r.sortOrder)) : -1) + 1;
    return [[], [0], [0, 1], [0, 5, 2], [7, 1]].every(
      (xs) => nextSortOrder(xs) === listScreenRule(xs.map((s) => ({ sortOrder: s }))));
  })());

// The CONSEQUENCE of the tie, measured rather than asserted: with both runs at
// sortOrder 0 the order is decided by comparing two random UUIDs, so the new
// blank run sorts ahead of the real run 1 half the time -- and "the first run"
// meant a different row on each visit.
const sortLikeTheDao = (runs) =>
  [...runs].sort((a, b) => a.sortOrder - b.sortOrder || (a.syncId < b.syncId ? -1 : a.syncId > b.syncId ? 1 : 0));
const tiedFirstIsTheNewRun = (newSyncId) =>
  sortLikeTheDao([
    { id: 11, sortOrder: 0, syncId: "8f0a1b2c-0000-4000-8000-000000000001" },
    { id: 12, sortOrder: OLD_SORT_ORDER, syncId: newSyncId },
  ])[0].id === 12;
ok("4g", "TIE PROVEN BOTH WAYS: a low UUID puts the NEW run first ...",
  tiedFirstIsTheNewRun("0000ffff-0000-4000-8000-000000000002") === true);
ok("4h", "... and a high UUID puts it second. Same data, different order, nothing else changed",
  tiedFirstIsTheNewRun("ffff0000-0000-4000-8000-000000000002") === false);
ok("4i", "with max+1 the order is fixed no matter what the UUID is",
  [
    "0000ffff-0000-4000-8000-000000000002",
    "ffff0000-0000-4000-8000-000000000002",
  ].every((syncId) => sortLikeTheDao([
    { id: 11, sortOrder: 0, syncId: "8f0a1b2c-0000-4000-8000-000000000001" },
    { id: 12, sortOrder: nextSortOrder([0]), syncId },
  ])[0].id === 11));

// =============================================================================
console.log("\n5. A NAME HE CAN TELL APART");
// =============================================================================

/** Faithful transcription of SurveyViewModel.nextQuickRunLabel. */
function nextQuickRunLabel(existingLabels, isTeardown) {
  const stem = isTeardown ? "Old fence" : "Side";
  const taken = new Set(existingLabels.map((s) => s.trim().toLowerCase()));
  let n = 1;
  while (taken.has(`${stem} ${n}`.toLowerCase())) n++;
  return `${stem} ${n}`;
}

/** What the drawing screen renders a blank label as (SurveyDrawScreen's runTitle). */
const displayed = (label, type) => `${label.trim() === "" ? "Untitled" : label} (${type})`;

ok("5a", "the first quick-added run is named, not blank",
  nextQuickRunLabel([], false) === "Side 1");
ok("5b", "the next one is different from it",
  nextQuickRunLabel(["Side 1"], false) === "Side 2");
ok("5c-canary", "CANARY: the OLD code left the label blank, three times running",
  displayed("", "Vinyl") === "Untitled (Vinyl)" &&
  displayed("", "Vinyl") === displayed("", "Vinyl"));
ok("5d", "so three quick-adds now read as three different rows on screen",
  (() => {
    const labels = [];
    for (let i = 0; i < 3; i++) labels.push(nextQuickRunLabel(labels, false));
    const shown = labels.map((l) => displayed(l, "Vinyl"));
    return new Set(shown).size === 3;
  })(),
  "the old behaviour gave a set of size 1");
ok("5e", "a teardown run is named as the old fence, not as another side",
  nextQuickRunLabel([], true) === "Old fence 1" &&
  nextQuickRunLabel(["Old fence 1"], true) === "Old fence 2");
ok("5f", "the two stems are numbered independently -- a side does not consume an old-fence number",
  nextQuickRunLabel(["Side 1", "Side 2"], true) === "Old fence 1");
ok("5g", "the SMALLEST free number: deleting side 2 of three gives 'Side 2' back",
  nextQuickRunLabel(["Side 1", "Side 3"], false) === "Side 2");
ok("5h", "names he typed himself are respected case-insensitively and trimmed",
  nextQuickRunLabel([" side 1 ", "SIDE 2"], false) === "Side 3");
ok("5i", "POSITIVE CONTROL: an unrelated hand-typed name does not push the number along",
  nextQuickRunLabel(["Back yard", "Pool gate"], false) === "Side 1");

// =============================================================================
console.log("\n6. WHAT COUNTS AS A NUMBER -- Kotlin's own parse grammar, transcribed");
// =============================================================================

/**
 * java.lang.Float.parseFloat's accepted grammar, which is what Kotlin's
 * String.toFloatOrNull screens with before parsing (kotlin.text
 * ScreenFloatValueRegEx). Transcribed because JS's own Number() DISAGREES in
 * exactly the place that matters: Number("5ft") and Number("NaN") are both the
 * JS value NaN, so JS cannot tell "refused" from "parsed as NaN" -- and the
 * whole of finding 2 lives in that distinction.
 */
const KOTLIN_FLOAT_RE = (() => {
  const D = "([0-9]+)";
  const H = "([0-9a-fA-F]+)";
  const E = `[eE][+-]?${D}`;
  return new RegExp(
    "^[\\x00-\\x20]*[+-]?(" +
      "NaN|Infinity|" +
      `(((${D}(\\.)?(${D}?)(${E})?)|` +
      `(\\.(${D})(${E})?)|` +
      "((" +
      `(0[xX]${H}(\\.)?)|` +
      `(0[xX]${H}?(\\.)${H})` +
      `)[pP][+-]?${D}))` +
      "[fFdD]?))" +
      "[\\x00-\\x20]*$"
  );
})();

/** Kotlin's String.toFloatOrNull: null when the grammar refuses it. */
function kotlinToFloatOrNull(s) {
  if (!KOTLIN_FLOAT_RE.test(s)) return null;
  // Suffix stripped so Number() does not choke on "5f". Hex-float literals
  // ("0x1p3") are accepted by the grammar and not converted faithfully here;
  // they are not a case anybody types into a gate width and nothing below
  // depends on them.
  const n = Number(s.trim().replace(/[fFdD]$/, ""));
  return n;
}

ok("6a", "the grammar accepts a plain number", kotlinToFloatOrNull("5") === 5);
ok("6b", "and a decimal", kotlinToFloatOrNull("5.5") === 5.5);
ok("6c", "THE TRAP: it accepts the literal NaN, which is why the old dialog took it",
  Number.isNaN(kotlinToFloatOrNull("NaN")));
ok("6d", "THE TRAP: and Infinity", kotlinToFloatOrNull("Infinity") === Infinity);
ok("6e", "THE TRAP: and -Infinity", kotlinToFloatOrNull("-Infinity") === -Infinity);
ok("6f", "it refuses '5ft' -- which is why that button looked dead",
  kotlinToFloatOrNull("5ft") === null);
ok("6g", "it refuses 5 with a quote mark after it", kotlinToFloatOrNull("5'") === null);
ok("6h", "it refuses the empty string", kotlinToFloatOrNull("") === null);
ok("6i-canary",
  "CANARY: JS's own Number() CANNOT tell 'NaN' from '5ft' -- proving this transcription earns its keep",
  Number.isNaN(Number("NaN")) && Number.isNaN(Number("5ft")));

// =============================================================================
console.log("\n7. EACH BAD INPUT IS REFUSED, AND A GOOD ONE IS ACCEPTED");
// =============================================================================

const REFUSAL = {
  BLANK: "BLANK", NOT_A_NUMBER: "NOT_A_NUMBER",
  NOT_FINITE: "NOT_FINITE", NOT_POSITIVE: "NOT_POSITIVE",
};

/** Faithful transcription of SurveyViewModel.readPositiveMeasure. */
function readPositiveMeasure(raw) {
  const trimmed = raw.trim().replace(/,/g, ".");
  if (trimmed.length === 0) return { value: null, refusal: REFUSAL.BLANK };
  const parsed = kotlinToFloatOrNull(trimmed);
  if (parsed === null) return { value: null, refusal: REFUSAL.NOT_A_NUMBER };
  if (!Number.isFinite(parsed)) return { value: null, refusal: REFUSAL.NOT_FINITE };
  if (parsed <= 0) return { value: null, refusal: REFUSAL.NOT_POSITIVE };
  return { value: parsed, refusal: null };
}

/** Faithful transcription of SurveyViewModel.checkPositive / checkNonNegative. */
const checkPositive = (v) =>
  !Number.isFinite(v) ? REFUSAL.NOT_FINITE : v <= 0 ? REFUSAL.NOT_POSITIVE : null;
const checkNonNegative = (v) =>
  !Number.isFinite(v) ? REFUSAL.NOT_FINITE : v < 0 ? REFUSAL.NOT_POSITIVE : null;

/** The OLD gate-width Add button, for the canaries. */
function oldGateConfirm(text) {
  const parsed = kotlinToFloatOrNull(text.replace(/,/g, "."));
  return parsed === null ? { committed: false, value: null } : { committed: true, value: parsed };
}

// Every input named in the finding, each with its own reason.
const GATE_CASES = [
  ["0",         REFUSAL.NOT_POSITIVE],
  ["-1",        REFUSAL.NOT_POSITIVE],
  ["NaN",       REFUSAL.NOT_FINITE],
  ["Infinity",  REFUSAL.NOT_FINITE],
  ["-Infinity", REFUSAL.NOT_FINITE],
  ["",          REFUSAL.BLANK],
  ["   ",       REFUSAL.BLANK],
  ["5ft",       REFUSAL.NOT_A_NUMBER],
  ["5'",        REFUSAL.NOT_A_NUMBER],
  ["six",       REFUSAL.NOT_A_NUMBER],
];
for (const [input, expected] of GATE_CASES) {
  const got = readPositiveMeasure(input);
  ok(`7-${JSON.stringify(input)}`,
    `refused with ${expected}, and nothing is committed`,
    got.refusal === expected && got.value === null,
    `got refusal=${got.refusal} value=${got.value}`);
}

ok("7p1", "POSITIVE CONTROL: a good gate width is ACCEPTED, with its value intact",
  (() => { const r = readPositiveMeasure("5"); return r.refusal === null && r.value === 5; })());
ok("7p2", "POSITIVE CONTROL: a decimal width too",
  (() => { const r = readPositiveMeasure("3.5"); return r.refusal === null && r.value === 3.5; })());
ok("7p3", "POSITIVE CONTROL: a comma decimal, as a Spanish or French keyboard sends it",
  (() => { const r = readPositiveMeasure("8,5"); return r.refusal === null && r.value === 8.5; })());
ok("7p4", "POSITIVE CONTROL: surrounding spaces do not make a good number bad",
  readPositiveMeasure("  12  ").value === 12);
ok("7p5", "the guard is not simply always-refusing: at least four distinct reasons are reachable",
  new Set(GATE_CASES.map(([i]) => readPositiveMeasure(i).refusal)).size === 4);

ok("7q1-canary", "CANARY: the OLD button COMMITTED 0 -- the bug, reproduced",
  oldGateConfirm("0").committed === true && oldGateConfirm("0").value === 0);
ok("7q2-canary", "CANARY: the OLD button COMMITTED -1",
  oldGateConfirm("-1").committed === true && oldGateConfirm("-1").value === -1);
ok("7q3-canary", "CANARY: the OLD button COMMITTED NaN",
  oldGateConfirm("NaN").committed === true && Number.isNaN(oldGateConfirm("NaN").value));
ok("7q4-canary", "CANARY: the OLD button COMMITTED Infinity",
  oldGateConfirm("Infinity").committed === true && oldGateConfirm("Infinity").value === Infinity);
ok("7q5-canary", "CANARY: and did NOTHING, with no message, for '5ft'",
  oldGateConfirm("5ft").committed === false);
ok("7q6-canary", "CANARY: every one of those five is now refused -- old and new disagree on all of them",
  ["0", "-1", "NaN", "Infinity", "5ft"].every((i) =>
    oldGateConfirm(i).committed !== (readPositiveMeasure(i).refusal === null) ||
    readPositiveMeasure(i).refusal !== null));

// The panel-width field: DraftNumberField hands on an already-parsed Float and
// pushes 0 for a blank box, so BLANK and a typed 0 are the same thing here.
ok("7r1", "panel width: a cleared box (DraftNumberField pushes 0f) is REFUSED, not committed",
  checkPositive(0) === REFUSAL.NOT_POSITIVE);
ok("7r2", "panel width: negative refused", checkPositive(-1) === REFUSAL.NOT_POSITIVE);
ok("7r3", "panel width: NaN refused", checkPositive(NaN) === REFUSAL.NOT_FINITE);
ok("7r4", "panel width: Infinity refused", checkPositive(Infinity) === REFUSAL.NOT_FINITE);
ok("7r5", "POSITIVE CONTROL: a real 6 ft panel width is accepted", checkPositive(6) === null);
ok("7r6", "POSITIVE CONTROL: and a 0.5 in picket width is not refused for being small",
  checkPositive(0.5) === null);
ok("7r7-canary", "CANARY: the OLD call site committed every one of those four",
  (() => {
    // The old lambda: viewModel.update { r -> r.copy(panelWidthFt = it) }, unguarded.
    const oldCommit = (v) => ({ committed: true, stored: v });
    return [0, -1, NaN, Infinity].every((v) => oldCommit(v).committed === true)
      && [0, -1, NaN, Infinity].every((v) => checkPositive(v) !== null);
  })());
ok("7s1", "concrete bags: ZERO IS A REAL ANSWER (a wall-hung gate takes none) and is accepted",
  checkNonNegative(0) === null);
ok("7s2", "concrete bags: negative still refused", checkNonNegative(-1) === REFUSAL.NOT_POSITIVE);
ok("7s3", "concrete bags: NaN still refused", checkNonNegative(NaN) === REFUSAL.NOT_FINITE);
ok("7s4-canary", "CANARY: the two rules genuinely differ on 0, so the split is not decorative",
  checkPositive(0) !== null && checkNonNegative(0) === null);

// Counts stored as Int: the damage is in toInt(), not in the Float.
ok("7t1", "rail count: NaN.toInt() is 0, which coerceAtLeast(1) used to turn into a silent 1",
  (() => {
    const kotlinToInt = (f) => Number.isNaN(f) ? 0
      : f === Infinity ? 2147483647 : f === -Infinity ? -2147483648 : Math.trunc(f);
    const oldStored = Math.max(kotlinToInt(NaN), 1);
    return oldStored === 1 && checkPositive(NaN) !== null;
  })());
ok("7t2", "rail count: Infinity.toInt() is Int.MAX_VALUE, which coerceAtLeast(1) waved straight through",
  (() => {
    const kotlinToInt = (f) => f === Infinity ? 2147483647 : Math.trunc(f);
    const oldStored = Math.max(kotlinToInt(Infinity), 1);
    return oldStored === 2147483647 && checkPositive(Infinity) !== null;
  })(),
  "a rail count of two billion on a quote");
ok("7t3", "POSITIVE CONTROL: a real 3-rail fence is still accepted",
  checkPositive(3) === null && Math.max(Math.trunc(3), 1) === 3);

// =============================================================================
console.log("\n8. A DRAWN POINT, AND A STORED CALIBRATION");
// =============================================================================

/** Faithful transcription of SurveyViewModel.isWritablePoint. */
const isWritablePoint = (x, y) => Number.isFinite(x) && Number.isFinite(y);
/** Faithful transcription of SurveyViewModel.isUsableCalibration. */
const isUsableCalibration = (p) => p !== null && p !== undefined && p > 0 && Number.isFinite(p);

/** FenceCodec.encodePoints / decodePoints, which round-trip NaN happily. */
const encodePoints = (pts) => pts.map(([x, y]) => `${x}:${y}`).join(",");
const decodePoints = (raw) => raw === "" ? [] : raw.split(",").map((p) => {
  const [a, b] = p.split(":");
  const x = kotlinToFloatOrNull(a), y = kotlinToFloatOrNull(b);
  return (x === null || y === null) ? null : [x, y];
}).filter(Boolean);

ok("8a-canary",
  "CANARY: a NaN point SURVIVES the codec round-trip, so it persists and syncs -- the bug, reproduced",
  (() => {
    const encoded = encodePoints([[10, 20], [NaN, 50]]);
    const back = decodePoints(encoded);
    return encoded.includes("NaN") && back.length === 2 && Number.isNaN(back[1][0]);
  })());
ok("8b", "so it is refused before the write: a non-finite coordinate is not writable",
  isWritablePoint(NaN, 50) === false && isWritablePoint(10, Infinity) === false
  && isWritablePoint(-Infinity, -Infinity) === false);
ok("8c", "POSITIVE CONTROL: an ordinary point IS writable, including negative and zero coordinates",
  isWritablePoint(10, 20) === true && isWritablePoint(0, 0) === true
  && isWritablePoint(-5.5, 12.25) === true);
ok("8d-canary", "CANARY: the old path had no such check, so both of 8b's points were written",
  (() => { const oldWritable = () => true; return oldWritable() && !isWritablePoint(NaN, 50); })());

ok("8e-canary",
  "CANARY: the OLD calibration guard (knownFeet <= 0f) lets NaN straight through -- NaN <= 0 is false",
  (() => {
    const oldGuardRefuses = (knownFeet) => knownFeet <= 0;   // the real old line
    return oldGuardRefuses(NaN) === false && oldGuardRefuses(0) === true;
  })());
ok("8f-canary", "CANARY: and an Infinity known-distance stored EXACTLY 0.0 as the scale",
  (() => {
    const distPx = 480;
    const stored = distPx / Infinity;
    return stored === 0 && !isUsableCalibration(stored);
  })());
ok("8g", "the new guard refuses NaN, 0, negative and Infinity known distances",
  [NaN, 0, -1, Infinity].every((f) => checkPositive(f) !== null));
ok("8h", "POSITIVE CONTROL: a real 120 ft known distance over 480 px gives a usable 4 px/ft",
  (() => {
    const knownFeet = 120, distPx = 480;
    if (checkPositive(knownFeet) !== null) return false;
    const pxPerFt = distPx / knownFeet;
    return pxPerFt === 4 && isUsableCalibration(pxPerFt);
  })());
ok("8i", "a stored 0, negative or NaN scale is NOT usable, matching DrawingScale.of's own rule",
  !isUsableCalibration(0) && !isUsableCalibration(-5) && !isUsableCalibration(NaN)
  && !isUsableCalibration(Infinity) && !isUsableCalibration(null));

// THE MONEY. A stored scale of 0 or below prices every side at nothing,
// because analyze() returns an empty result for pixelsPerFoot <= 0.
const analyzeTotalFeet = (pixelLength, pixelsPerFoot) =>
  (pixelsPerFoot <= 0 || !Number.isFinite(pixelsPerFoot)) ? 0 : pixelLength / pixelsPerFoot;
ok("8j", "MEASURED: a 480 px side at a stored scale of 0 measures 0 ft, not 120 ft",
  analyzeTotalFeet(480, 0) === 0 && analyzeTotalFeet(480, 4) === 120);
ok("8k", "MEASURED: and at a stored scale of -4 it is also 0 ft",
  analyzeTotalFeet(480, -4) === 0);

/**
 * The send refusal, transcribed from EstimateScreen's zeroQuoteBlocked.
 * `hasUnmeasurablePhotoWork` tests `calibrationPixelsPerFoot == null`, which a
 * job carrying a stored 0 is NOT -- so the old refusal stayed false on a $0
 * contract.
 */
const oldZeroQuoteBlocked = (grandTotal, calibration, isPhotoJob, hasDrawnWork) =>
  grandTotal <= 0.005 && (calibration === null && isPhotoJob && hasDrawnWork);
const newZeroQuoteBlocked = (grandTotal, calibration, isPhotoJob, hasDrawnWork) =>
  grandTotal <= 0.005 && (
    (calibration === null && isPhotoJob && hasDrawnWork) ||
    (calibration !== null && !isUsableCalibration(calibration))
  );

ok("8l-canary",
  "CANARY: with a stored scale of 0 the OLD refusal was FALSE -- $0 contract, send button live",
  oldZeroQuoteBlocked(0, 0, true, true) === false);
ok("8m", "the new refusal BLOCKS it",
  newZeroQuoteBlocked(0, 0, true, true) === true);
ok("8n", "it blocks a GRID job too, which the photo test could never have caught",
  newZeroQuoteBlocked(0, 0, false, true) === true &&
  oldZeroQuoteBlocked(0, 0, false, true) === false);
ok("8o", "and a stored NaN or negative scale",
  newZeroQuoteBlocked(0, NaN, true, true) === true &&
  newZeroQuoteBlocked(0, -4, false, true) === true);
ok("8p", "POSITIVE CONTROL: the old uncalibrated-photo refusal still fires, unchanged",
  newZeroQuoteBlocked(0, null, true, true) === true &&
  oldZeroQuoteBlocked(0, null, true, true) === true);
ok("8q", "POSITIVE CONTROL: a real priced job with a real scale is NOT blocked",
  newZeroQuoteBlocked(2120, 4, true, true) === false);
ok("8r", "POSITIVE CONTROL: a brand-new empty job at $0 with no scale yet is not blocked either",
  newZeroQuoteBlocked(0, null, true, false) === false,
  "nothing is drawn, so there is nothing to refuse to send");

// =============================================================================
console.log("\n9. THE TRANSCRIPTIONS ABOVE ARE THE RULES THE APP ACTUALLY RUNS");
console.log("   (a faithful transcription of code that is not there is a green test on a live bug)");
// =============================================================================
ok("9a", "SurveyViewModel declares resolveRunSelection and it returns the pending flag",
  /fun\s+resolveRunSelection\s*\(/.test(CODE.vm) &&
  /data\s+class\s+RunSelection\s*\(\s*val\s+selectedRunId:\s*Long\?\s*,\s*val\s+requestStillPending:\s*Boolean\s*\)/.test(CODE.vm));
ok("9b", "ensureSelection USES it rather than keeping its own firstOrNull",
  /fun\s+ensureSelection\(\)[\s\S]{0,400}resolveRunSelection\(/.test(CODE.vm));
ok("9c-canary", "CANARY: the old `runs.value.firstOrNull()?.id` is gone from ensureSelection",
  !/fun\s+ensureSelection\(\)\s*\{[\s\S]{0,300}runs\.value\.firstOrNull\(\)\?\.id/.test(CODE.vm));
ok("9d", "createBlankRun sets sortOrder from nextSortOrder and a label from nextQuickRunLabel",
  /fun\s+createBlankRun\([\s\S]{0,900}sortOrder\s*=\s*nextSortOrder\(/.test(CODE.vm) &&
  /fun\s+createBlankRun\([\s\S]{0,900}label\s*=\s*nextQuickRunLabel\(/.test(CODE.vm));
ok("9e", "the route carries an optional runId query parameter, and the job-only form still exists",
  /const val SURVEY = "job\/\{jobId\}\/survey\?runId=\{runId\}"/.test(CODE.nav) &&
  /fun survey\(jobId: Long, runId: Long\? = null\)/.test(CODE.nav));
ok("9f", "MainActivity declares the runId argument WITH a default, or the job-only route matches nothing",
  /navArgument\("runId"\)\s*\{\s*type\s*=\s*NavType\.LongType;\s*defaultValue\s*=\s*0L\s*\}/.test(CODE.main));
ok("9g", "RunEditScreen's draw button passes the RUN id, not just the job id",
  /onDrawRun\(currentRun\.jobId,\s*currentRun\.id\)/.test(CODE.runedit));
ok("9h-canary", "CANARY: the old job-only call is gone",
  !/onDrawRun\(currentRun\.jobId\)/.test(CODE.runedit));
ok("9i", "the drawing screen takes openRunId and lodges it before any ensureSelection",
  /openRunId:\s*Long\?\s*=\s*null/.test(CODE.draw) &&
  /viewModel\.requestRun\(openRunId\)/.test(CODE.draw));
ok("9j", "the view model is still keyed on the JOB only, so Undo history is not thrown away",
  /key\s*=\s*"survey_\$jobId"/.test(CODE.draw));
ok("9k", "the gate dialog refuses through readPositiveMeasure and disables the button",
  /SurveyViewModel\.readPositiveMeasure\(text\)/.test(CODE.draw) &&
  /enabled\s*=\s*entry\.value\s*!=\s*null/.test(CODE.draw));
ok("9l-canary", "CANARY: the old unguarded gate-width confirm line is gone",
  !/text\.replace\(',',\s*'\.'\)\.toFloatOrNull\(\)\?\.let\s*\{\s*onConfirm/.test(CODE.draw));
ok("9m", "applyCalibration checks the typed distance and reports which refusal it was",
  /checkPositive\(knownFeet\)/.test(CODE.vm) && /_calibrationRefused\.tryEmit/.test(CODE.vm));
ok("9n", "and refuses to store a scale that DrawingScale.of would not measure by",
  /if\s*\(!isUsableCalibration\(pxPerFt\)\)/.test(CODE.vm));
ok("9o", "both point writes are guarded",
  /fun\s+addDrawPoint\([\s\S]{0,200}writablePointOrDropped\(/.test(CODE.vm) &&
  /fun\s+movePoint\([\s\S]{0,200}writablePointOrDropped\(/.test(CODE.vm));
ok("9p", "the spec fields commit through the guarded wrappers, not raw DraftNumberField",
  /PositiveNumberField\(stableKey = run\.id, label = stringResource\(R\.string\.est2_panel_width_ft\)/.test(CODE.runedit));
// EVERY spec field must go through a guard, not just the panel width named in
// the finding. Stated as a count rather than as a list of field names, because
// a list only covers the fields somebody remembered: DraftNumberField may
// appear in this file exactly twice, once inside each wrapper, and any third
// occurrence is a field writing to the run unguarded again.
const draftCallSites = (CODE.runedit.match(/DraftNumberField\(/g) ?? []).length;
ok("9q", "DraftNumberField is called exactly twice in RunEditScreen: once inside each wrapper",
  draftCallSites === 2, `found ${draftCallSites}`);
ok("9q2", "and both of those two sites are inside the guarded wrappers",
  /fun\s+PositiveNumberField\([\s\S]{0,700}DraftNumberField\(/.test(CODE.runedit) &&
  /fun\s+NonNegativeNumberField\([\s\S]{0,700}DraftNumberField\(/.test(CODE.runedit));
ok("9q3-canary", "CANARY: that count probe can fail -- HEAD's own copy of the file had many more",
  (() => {
    const headRunEdit = stripComments(headSource(RUNEDIT));
    const n = (headRunEdit.match(/DraftNumberField\(/g) ?? []).length;
    return n > 2;
  })(), "if this reads 2 the probe proves nothing");
ok("9r", "the zero-quote refusal reads the stored scale as well as the null case",
  /storedScaleUnusable/.test(stripComments(read("app/src/main/java/com/fenceestimator/app/ui/estimate/EstimateScreen.kt"))));
ok("9s", "every refusal reason has a sentence, and they are real resources in all three locales",
  (() => {
    const keys = ["num_blank", "num_not_a_number", "num_not_finite", "num_not_positive"];
    const locales = ["values", "values-es", "values-fr"];
    return locales.every((loc) => {
      const xml = read(`app/src/main/res/${loc}/strings_number_guards.xml`);
      return keys.every((k) => xml.includes(`name="${k}"`));
    });
  })());
ok("9t-canary", "CANARY: that resource probe is not satisfied by a key that does not exist",
  !read("app/src/main/res/values/strings_number_guards.xml").includes('name="num_not_a_fence"'));

// =============================================================================
console.log("\n10. THE CANARY: every section-9 probe run against the PRE-FIX source");
console.log("    (a probe that is green on the old code too is a probe testing nothing)");
// =============================================================================
const HEAD = {
  vm: headSource(VM), draw: headSource(DRAW),
  runedit: headSource(RUNEDIT), main: headSource(MAIN), nav: headSource(NAV),
};
const headReadable = Object.values(HEAD).every((s) => s !== null && s.length > 400);
ok("10a", "the pre-fix copies of all five files were retrievable from the last commit",
  headReadable,
  "without them nothing below can be trusted; this is a FAILURE, not a skip");

const HEADCODE = headReadable
  ? Object.fromEntries(Object.entries(HEAD).map(([k, v]) => [k, stripComments(v)]))
  : null;

/**
 * Each entry: the probe, and which pre-fix file it must NOT match. If any of
 * these DOES match the old source, the corresponding section-9 check was
 * already green before the fix and proves nothing.
 */
const MUST_FAIL_ON_OLD = [
  ["resolveRunSelection exists", "vm", /fun\s+resolveRunSelection\s*\(/],
  ["ensureSelection delegates to it", "vm", /fun\s+ensureSelection\(\)[\s\S]{0,400}resolveRunSelection\(/],
  ["createBlankRun sets sortOrder", "vm", /fun\s+createBlankRun\([\s\S]{0,900}sortOrder\s*=\s*nextSortOrder\(/],
  ["createBlankRun sets a label", "vm", /fun\s+createBlankRun\([\s\S]{0,900}label\s*=\s*nextQuickRunLabel\(/],
  ["applyCalibration checks the distance", "vm", /checkPositive\(knownFeet\)/],
  ["applyCalibration refuses an unusable scale", "vm", /if\s*\(!isUsableCalibration\(pxPerFt\)\)/],
  ["point writes are guarded", "vm", /writablePointOrDropped\(/],
  ["the route carries runId", "nav", /survey\?runId=\{runId\}/],
  ["survey() takes a runId", "nav", /fun survey\(jobId: Long, runId: Long\? = null\)/],
  // NOT a bare /navArgument\("runId"\)/ -- the canary caught that one being
  // green against the pre-fix source, because Routes.RUN_EDIT has always
  // declared a runId argument. The distinguishing part is the DEFAULT, which
  // is what makes the survey route's copy optional; without it the job-only
  // route "job/7/survey" matches nothing at all.
  ["MainActivity declares runId WITH a default", "main",
    /navArgument\("runId"\)\s*\{\s*type\s*=\s*NavType\.LongType;\s*defaultValue\s*=\s*0L\s*\}/],
  ["MainActivity passes openRunId to the drawing", "main", /openRunId\s*=\s*openRunId/],
  ["the draw button passes the run id", "runedit", /onDrawRun\(currentRun\.jobId,\s*currentRun\.id\)/],
  ["the drawing screen takes openRunId", "draw", /openRunId:\s*Long\?\s*=\s*null/],
  ["it lodges the request", "draw", /viewModel\.requestRun\(openRunId\)/],
  ["the gate dialog uses readPositiveMeasure", "draw", /SurveyViewModel\.readPositiveMeasure\(text\)/],
  ["the gate Add button can be disabled", "draw", /enabled\s*=\s*entry\.value\s*!=\s*null/],
];
let oldMatches = 0;
if (HEADCODE) {
  for (const [label, file, probe] of MUST_FAIL_ON_OLD) {
    const matchedOld = probe.test(HEADCODE[file]);
    if (matchedOld) oldMatches++;
    ok(`10-${label}`, `RED on pre-fix ${file} (as it must be), GREEN on current`,
      !matchedOld && probe.test(CODE[file]),
      matchedOld ? "this probe was ALREADY green before the fix -- it proves nothing"
                 : "probe does not match the CURRENT source either");
  }
}
ok("10z", "and the two findings' own bugs ARE present in the pre-fix source",
  HEADCODE !== null &&
  /onDrawRun\(currentRun\.jobId\)/.test(HEADCODE.runedit) &&
  /text\.replace\(',',\s*'\.'\)\.toFloatOrNull\(\)\?\.let\s*\{\s*onConfirm/.test(HEADCODE.draw) &&
  /runs\.value\.firstOrNull\(\)\?\.id/.test(HEADCODE.vm),
  "if the pre-fix source does not contain the bugs, the findings were against a different tree");

// =============================================================================
console.log("\n" + "-".repeat(78));
console.log(`${passed} ok, ${failed} FAIL`);
if (HEADCODE) {
  console.log(`CANARY: ${MUST_FAIL_ON_OLD.length - oldMatches}/${MUST_FAIL_ON_OLD.length} ` +
    "source probes were RED against the pre-fix commit, as required.");
}
if (failed === 0) {
  console.log("Both findings are fixed in the source and the old logic is proven to fail each check.");
  console.log("NOT PROVEN HERE: that the app compiles. No Gradle was run (16 GB machine, concurrent builds).");
}
process.exitCode = failed === 0 ? 0 : 1;
