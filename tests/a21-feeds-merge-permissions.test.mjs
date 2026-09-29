// A21 -- F2, "merge 'Drawing changes since approval' with 'Changes from the
// field' into one section that looks good and saves space."
//
// WHAT THIS FILE IS. Not a compiled or run Kotlin test -- there is no Gradle
// invocation here and none of this executes JobChangesSection, DrawingChangeCard,
// PlanRequestCard or FieldChangeCard. It is a STATIC read of the actual source
// text of the two owned files after the merge, pinning the structural claims
// the merge makes: one section, not two; both feeds' rows and actions
// survived; the two permissions that gate those actions were kept distinct
// rather than collapsed into one; nothing money-shaped or delete-shaped leaked
// into either file. A green run here is evidence about the SOURCE TEXT, not
// proof the Kotlin compiles -- that still needs the real gate (gradlew / the
// project's own check-parity.mjs), which this task was explicitly told not to
// run while other tracks edit Kotlin.
//
// Run: node tests/a21-feeds-merge-permissions.test.mjs

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
};

const screenPath = new URL(
  "../app/src/main/java/com/fenceestimator/app/ui/jobs/JobDetailScreen.kt",
  import.meta.url,
);
const fieldCardPath = new URL(
  "../app/src/main/java/com/fenceestimator/app/ui/jobs/FieldChangesSection.kt",
  import.meta.url,
);
const screen = readFileSync(screenPath, "utf8");
const fieldCard = readFileSync(fieldCardPath, "utf8");

const count = (haystack, needle) => haystack.split(needle).length - 1;

// ===========================================================================
// 0. POSITIVE CONTROLS -- prove the mechanisms below can actually fail, before
//    trusting any of them to pass. An assertion that can only ever pass is not
//    a check.
// ===========================================================================
console.log("\n0. positive controls:");
{
  ok("sanity: the screen file is non-trivial (a truncated read would false-pass everything below)",
    screen.length > 100_000, `length=${screen.length}`);
  ok("sanity: the field-card file is non-trivial",
    fieldCard.length > 1_000, `length=${fieldCard.length}`);
  // The blacklist mechanism in section 4 only means something if it can find
  // a real hit. jobTotals.grandTotal is known to appear elsewhere in this
  // same file (the signature/payment flow), well outside the merged section.
  ok("the money term used as a canary below genuinely appears somewhere in this file " +
    "(otherwise section 4's absence-inside-the-slice check would be vacuous)",
    count(screen, "jobTotals.grandTotal") >= 1);
}

// ===========================================================================
// 1. ONE SECTION, NOT TWO -- the old per-feed cards are gone as their own
//    SectionCard titles, the new merged composable exists exactly once as a
//    definition and exactly once as a call, and the old wrapper composables
//    are not still sitting there unused pretending to be wired in.
// ===========================================================================
console.log("\n1. one section replaced two:");
{
  ok("DrawingChangesSection (the old drawing-only composable) no longer exists",
    !screen.includes("DrawingChangesSection"));
  ok("the old drawing card's own SectionCard title is gone (no standalone drawing card)",
    !screen.includes("SectionCard(title = stringResource(R.string.jd_drawhist_title)"));
  ok("the old field-changes card's own SectionCard title is gone (no standalone field card)",
    !screen.includes("SectionCard(title = stringResource(R.string.jd_section_field_changes)"));
  ok("JobChangesSection is defined exactly once",
    count(screen, "private fun JobChangesSection(") === 1);
  ok("JobChangesSection is called exactly once (definition + one call site = 2 total occurrences)",
    count(screen, "JobChangesSection(") === 2);
  ok("the old top-level FieldChangesSection wrapper composable is gone from its file",
    !fieldCard.includes("fun FieldChangesSection("));
}

// Slice out the merged composable's own body so the checks below are scoped
// to it specifically, not to the whole 4000+ line screen file.
const defStart = screen.indexOf("private fun JobChangesSection(");
const nextDef = screen.indexOf("private fun DrawingChangeCard(", defStart);
ok("could locate the merged composable's body to scope the rest of this file's checks",
  defStart !== -1 && nextDef !== -1 && nextDef > defStart);
const section = screen.slice(defStart, nextDef);

// ===========================================================================
// 2. BOTH KINDS OF ROW SURVIVED, each with the action it always had.
// ===========================================================================
console.log("\n2. both feeds' rows and actions are still there:");
{
  ok("drawing-change rows still render via DrawingChangeCard",
    section.includes("DrawingChangeCard("));
  ok("a restorable drawing row's restore button is still reachable (restoreThatWouldWork still computed)",
    section.includes("restoreThatWouldWork(drawingRows)"));
  ok("crew requests still render via PlanRequestCard (the approve/reject card)",
    section.includes("PlanRequestCard("));
  ok("settled field changes still render via FieldChangeCard (the extracted report/decided card)",
    section.includes("FieldChangeCard("));
  ok("the unseen field-changes banner's Mark Seen action is still wired to acknowledgeFieldChanges()",
    section.includes("viewModel.acknowledgeFieldChanges()"));
}

// ===========================================================================
// 3. PROVENANCE -- every row still says where it came from. Both group
//    headings reuse the two OLD section titles verbatim (so the existing
//    ES/FR translations keep working with zero new translation work), rather
//    than inventing new copy this track cannot add to strings.xml.
// ===========================================================================
console.log("\n3. every row still says where it came from:");
{
  ok("the drawing-change group is headed by the old drawing section's own title string",
    section.includes("stringResource(R.string.jd_drawhist_title)"));
  ok("the field-change group is headed by the old field section's own title string",
    section.includes("stringResource(R.string.jd_section_field_changes)"));
  // The merged card needs its own (new) outer title -- flagged in the
  // handover as the one new string resource this change actually needs.
  ok("the merged card has its own outer title, a NEW string key (see handover notes)",
    section.includes("stringResource(R.string.jd_section_changes)"));
}

// ===========================================================================
// 4. PERMISSIONS KEPT DISTINCT -- the trap named in the brief. A restorable
//    drawing row must stay gated on canEditDrawing (EDIT_JOBS) and a crew
//    request's approve/reject must stay gated on canApprovePlanChanges
//    (APPROVE_PLAN_CHANGES). Neither may be wired to the other's gate, and
//    the merge must not have invented a third, looser gate that covers both.
// ===========================================================================
console.log("\n4. the two actions kept their own, different permissions:");
{
  ok("JobChangesSection takes canEditDrawing and canApprovePlanChanges as two separate parameters",
    /canEditDrawing:\s*Boolean/.test(section) && /canApprovePlanChanges:\s*Boolean/.test(section));
  ok("the restore button's gate (DrawingChangeCard's canEdit) is wired to canEditDrawing",
    /DrawingChangeCard\(\s*row = row,\s*runs = runs,\s*canEdit = canEditDrawing,/.test(section));
  ok("the approve/reject card is wired to canApprovePlanChanges, not canEditDrawing",
    section.includes("PlanRequestCard(request, canApprovePlanChanges, viewModel)"));
  ok("canEditDrawing is never assigned from canApprovePlanChanges (no collapsed gate)",
    !section.includes("canEditDrawing = canApprovePlanChanges"));
  ok("canApprovePlanChanges is never assigned from canEditDrawing (no collapsed gate)",
    !section.includes("canApprovePlanChanges = canEditDrawing"));

  // The call site: confirm the two gates are still fed from the two distinct
  // SessionState getters the server actually keys its own enforcement off of
  // (EDIT_JOBS for fence_runs writes being offered at all; APPROVE_PLAN_CHANGES
  // being the one the field_changes UPDATE RLS policy checks).
  const callSite = screen.slice(screen.indexOf("JobChangesSection(", screen.indexOf("item {", screen.indexOf("val jobNeedsReapproval"))));
  ok("the call site wires the restore gate to session.canEditJobs",
    callSite.slice(0, 400).includes("canEditDrawing = session.canEditJobs"));
  ok("the call site wires the approve/reject gate to session.canApprovePlanChanges",
    callSite.slice(0, 400).includes("canApprovePlanChanges = session.canApprovePlanChanges"));
}

// ===========================================================================
// 5. CREW MUST NOT GAIN SIGHT OF ANYTHING -- no money, no delete anywhere in
//    the merged composable or in the field-card file. Both feeds were already
//    money-free and delete-free before this merge (drawing rows carry no
//    price column by query design; field changes are footage text only); the
//    merge must not have introduced either.
// ===========================================================================
console.log("\n5. no money, no delete leaked into the merged section or the field cards:");
{
  const moneyTerms = ["contractTotal", "grandTotal", "Money.", "acceptedTotal", "jobTotals", "priorContractTotal"];
  const deleteTerms = ["canDelete", "Icons.Filled.Delete", ".delete(", "DELETE_RECORDS"];
  for (const term of moneyTerms) {
    ok(`no money term "${term}" inside the merged JobChangesSection body`, !section.includes(term));
    ok(`no money term "${term}" inside FieldChangesSection.kt`, !fieldCard.includes(term));
  }
  for (const term of deleteTerms) {
    ok(`no delete term "${term}" inside the merged JobChangesSection body`, !section.includes(term));
    ok(`no delete term "${term}" inside FieldChangesSection.kt`, !fieldCard.includes(term));
  }
}

// ===========================================================================
// 6. CREW REQUESTS STAY FIRST -- the ordering invariant carried over from the
//    original field-changes section: whatever is waiting on a decision must
//    render before settled history from either feed.
// ===========================================================================
console.log("\n6. crew requests waiting on a decision still render before settled history:");
{
  const iWaiting = section.indexOf("val waiting = fieldChanges.filter");
  const iDrawingRows = section.indexOf("if (hasDrawingRows)");
  const iSettled = section.indexOf("val settled = fieldChanges.filter");
  ok("all three markers were found", iWaiting !== -1 && iDrawingRows !== -1 && iSettled !== -1);
  ok("the waiting-request block appears before the drawing-rows block",
    iWaiting < iDrawingRows, `waiting@${iWaiting} drawingRows@${iDrawingRows}`);
  ok("the waiting-request block appears before the settled field-changes block",
    iWaiting < iSettled, `waiting@${iWaiting} settled@${iSettled}`);
}

// ===========================================================================
// 7. GUEST DEMO STAYS READ-ONLY -- both gates the guest demo relies on
//    (canEditDrawing / canApprovePlanChanges both false for the guest) are
//    still the only things standing between this card and a write, exactly
//    as before the merge. No isGuestDemo check existed in either original
//    section and none was added here -- this just confirms the two booleans
//    that already did the job are still doing it, unconditionally, for both
//    actions.
// ===========================================================================
console.log("\n7. guest read-only rests on the same two booleans as before:");
{
  ok("the restore button is still wrapped in a canEditDrawing-gated branch (via DrawingChangeCard's own canEdit/restorable logic, unchanged)",
    section.includes("canEdit = canEditDrawing"));
  ok("the approve/reject controls are still wrapped in a canApprovePlanChanges-gated branch (PlanRequestCard's own canApprove logic, unchanged)",
    section.includes("PlanRequestCard(request, canApprovePlanChanges, viewModel)"));
}

console.log(`\n${pass} of ${pass + fail} checks passed`);
if (fail) process.exit(1);
