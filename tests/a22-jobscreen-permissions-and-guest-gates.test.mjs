// A22 -- "Mark seen" made to match the live field_changes UPDATE policy
// (owner, manager, foreman only), the two open guest controls on this screen
// ("push another job's dates" and "re-sign the contract") made absent rather
// than inert, and the F2-merge regression on the "re-run Suggest Quantities"
// hint restored.
//
// WHAT THIS FILE IS. Same shape as tests/a21-feeds-merge-permissions.test.mjs:
// a STATIC read of the actual source text of the three files this wave owns
// (JobDetailScreen.kt, FieldChangesSection.kt, JobDetailViewModel.kt), pinning
// the structural claims below. It does not run Gradle, does not compile
// Kotlin, and proves nothing about whether the app builds -- only that the
// source text says what this wave's report claims it says. The real gate
// (gradlew / check-parity.mjs) was explicitly not run here, per this wave's
// instructions, because other tracks may be editing Kotlin concurrently.
//
// Run: node tests/a22-jobscreen-permissions-and-guest-gates.test.mjs

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
const vmPath = new URL(
  "../app/src/main/java/com/fenceestimator/app/ui/jobs/JobDetailViewModel.kt",
  import.meta.url,
);
const stringsPath = new URL(
  "../app/src/main/res/values/strings.xml",
  import.meta.url,
);
const screen = readFileSync(screenPath, "utf8");
const vm = readFileSync(vmPath, "utf8");
const strings = readFileSync(stringsPath, "utf8");

const count = (haystack, needle) => haystack.split(needle).length - 1;

// ===========================================================================
// 0. POSITIVE CONTROLS
// ===========================================================================
console.log("\n0. positive controls:");
{
  ok("sanity: the screen file is non-trivial (a truncated read would false-pass everything below)",
    screen.length > 100_000, `length=${screen.length}`);
  ok("sanity: the view model file is non-trivial",
    vm.length > 10_000, `length=${vm.length}`);
  ok("sanity: strings.xml is non-trivial",
    strings.length > 10_000, `length=${strings.length}`);
  // Canary for section 7 below: prove the exact OLD (regressed) layout string
  // this test looks for the ABSENCE of would actually match today's file if
  // the fix had not been made, by checking a close relative of it is still
  // findable in some form (the string resource itself).
  ok("the rerun-hint string resource this whole section is about still exists in the file",
    count(screen, "jsec_fc_rerun_hint") >= 1);
}

// Slice out JobChangesSection's own body, the same way a21 does, so checks
// below are scoped to it rather than to the whole 4000+ line screen file.
const defStart = screen.indexOf("private fun JobChangesSection(");
const nextDef = screen.indexOf("private fun DrawingChangeCard(", defStart);
ok("could locate JobChangesSection's body to scope the checks below",
  defStart !== -1 && nextDef !== -1 && nextDef > defStart);
const section = screen.slice(defStart, nextDef);

// ===========================================================================
// 1. MARK SEEN MATCHES THE LIVE field_changes UPDATE POLICY (owner, manager,
//    foreman only -- confirmed against pg_policies on the live database,
//    2026-09-29, not this repo's migration file). Before this wave the
//    button carried no gate of its own at all; every role that could open a
//    job could tap it.
// ===========================================================================
console.log("\n1. Mark Seen is gated to match the live server policy:");
{
  // Positive control: prove this slice actually contains the banner and
  // button this section is about, before trusting anything scoped to it.
  ok("positive control: the unseen-count banner is in this slice",
    section.includes("jsec_fc_unseen_one") && section.includes("jsec_fc_unseen_many"));
  ok("positive control: the Mark Seen action itself is still wired to acknowledgeFieldChanges()",
    section.includes("viewModel.acknowledgeFieldChanges()"));

  // The actual gate: the OutlinedButton that calls acknowledgeFieldChanges()
  // is now reached only through a canApprovePlanChanges branch. Pinned as an
  // exact substring (same style as a21's PlanRequestCard pin) rather than a
  // loose regex, so a future edit that quietly moves the gate elsewhere in
  // the same function is still caught.
  ok("the Mark Seen button is wrapped in an `if (canApprovePlanChanges)` branch",
    section.includes("if (canApprovePlanChanges) {\n                            OutlinedButton(onClick = { viewModel.acknowledgeFieldChanges() }) {"));

  // Negative control: the exact OLD (ungated) shape -- the button as a direct
  // child of the Row with no canApprovePlanChanges branch around it -- must
  // not be present. This is what would still be true if the fix had only
  // been made to look right without actually nesting the button.
  ok("the OLD ungated shape (button directly under the Row, no permission branch) is gone",
    !section.includes("OutlinedButton(onClick = { viewModel.acknowledgeFieldChanges() }) {\n                            Text(stringResource(R.string.jsec_fc_mark_seen))\n                        }\n                    }\n                }\n            }"));

  // The class doc above the composable must no longer claim what is no
  // longer true -- "no fake features" cuts both ways: a comment claiming the
  // code does something it doesn't is the same defect as a control the
  // server refuses.
  const classDocStart = screen.lastIndexOf("/**", defStart);
  const classDoc = screen.slice(classDocStart, defStart);
  ok("the class doc no longer claims Mark Seen carries no permission check",
    !classDoc.includes("Marking a change seen carries") || !classDoc.includes("no permission check at all"));
  ok("the class doc documents the new gate instead",
    classDoc.includes("mark one seen") && classDoc.includes("field_changes"));
}

console.log("\n1b. the same gate exists again in the view model (belt-and-suspenders):");
{
  const fnStart = vm.indexOf("fun acknowledgeFieldChanges()");
  ok("positive control: found acknowledgeFieldChanges() in the view model", fnStart !== -1);
  const fnBody = vm.slice(fnStart, vm.indexOf("\n    }", fnStart));
  ok("acknowledgeFieldChanges() refuses unless canApprovePlanChanges is true",
    fnBody.includes("if (!session.state.value.canApprovePlanChanges) return"));
  ok("acknowledgeFieldChanges() still launches the repository write for an approved role",
    fnBody.includes("repository.acknowledgeFieldChanges(jobId)"));
}

// ===========================================================================
// 2. "PUSH ANOTHER JOB'S DATES" (OverrunSection, a file this wave does not
//    own) IS ABSENT FOR THE GUEST DEMO -- hidden at the one call site this
//    wave does own, since the button itself cannot be reached without
//    editing OverrunSection.kt.
// ===========================================================================
console.log("\n2. the overrun reschedule card is absent for the guest demo:");
{
  const callIdx = screen.indexOf("OverrunSection(");
  ok("positive control: found the OverrunSection call site", callIdx !== -1);
  const before = screen.slice(Math.max(0, callIdx - 700), callIdx);
  ok("the call site is reached only through `if (!session.isGuestDemo)`",
    /if\s*\(!session\.isGuestDemo\)\s*\{[\s\S]*item\(key = "overrun"\)/.test(before + screen.slice(callIdx, callIdx + 50)));
  // Negative control: the section must not ALSO be reachable through a bare
  // `if (session.canSeeMoney)` with no guest check -- i.e. canSeeMoney must
  // not be the only gate reaching it any more (canSeeMoney is true for the
  // guest demo, which is exactly the hole this closes).
  const overrunItemIdx = screen.indexOf('item(key = "overrun")');
  ok("positive control: found the overrun LazyColumn item", overrunItemIdx !== -1);
  const guestCheckIdx = screen.lastIndexOf("if (!session.isGuestDemo)", overrunItemIdx);
  const moneyCheckIdx = screen.lastIndexOf("if (session.canSeeMoney)", overrunItemIdx);
  ok("the nearest guard above the overrun item is the guest check, not just the money check",
    guestCheckIdx !== -1 && guestCheckIdx > moneyCheckIdx);
}

console.log("\n2b. rescheduleOtherJob refuses the guest demo in the view model too:");
{
  const fnStart = vm.indexOf("fun rescheduleOtherJob(");
  ok("positive control: found rescheduleOtherJob() in the view model", fnStart !== -1);
  const fnBody = vm.slice(fnStart, vm.indexOf("\n    }", fnStart));
  ok("rescheduleOtherJob() refuses the guest demo",
    fnBody.includes("if (session.state.value.isGuestDemo) return"));
  ok("rescheduleOtherJob() still writes the other job's date for a real user",
    fnBody.includes("repository.updateJob(other.copy(scheduledDate = newDate))"));
}

// ===========================================================================
// 3. "RE-SIGN THE CONTRACT" IS ABSENT FOR THE GUEST DEMO -- StaleSignature-
//    Banner takes a canReSign flag and only renders the action button when
//    it is true; the informational reason stays visible either way, since
//    unlike the button it IS meaningful read-only.
// ===========================================================================
console.log("\n3. re-signing the contract is absent for the guest demo:");
{
  ok("StaleSignatureBanner takes a canReSign: Boolean parameter",
    /private fun StaleSignatureBanner\(\s*job: Job,\s*contractTotal: Double,\s*linearFeet: Float,[\s\S]{0,400}canReSign: Boolean,/.test(screen));
  ok("the Get New Signature button is wrapped in `if (canReSign)`",
    screen.includes("if (canReSign) {\n                Button(onClick = onGetNewSignature, modifier = Modifier.fillMaxWidth()) {"));
  ok("the informational stale-signature text (title + body) is NOT inside the canReSign branch",
    (() => {
      const fnStart = screen.indexOf("private fun StaleSignatureBanner(");
      const fnEnd = screen.indexOf("\n}\n", fnStart);
      const body = screen.slice(fnStart, fnEnd);
      const ifIdx = body.indexOf("if (canReSign)");
      return body.slice(0, ifIdx).includes("jd_stale_sig_title") && body.slice(0, ifIdx).includes("jd_stale_sig_body");
    })());
  ok("the call site wires canReSign to !session.isGuestDemo",
    screen.includes("canReSign = !session.isGuestDemo"));
}

console.log("\n3b. captureSignature refuses the guest demo in the view model too:");
{
  const fnStart = vm.indexOf("fun captureSignature(");
  ok("positive control: found captureSignature() in the view model", fnStart !== -1);
  const fnBody = vm.slice(fnStart, vm.indexOf("\n    }", fnStart + 200) + 6);
  ok("captureSignature() refuses the guest demo before touching job.value",
    /if \(session\.state\.value\.isGuestDemo\) return\s*\n\s*val current = job\.value/.test(fnBody));
}

// ===========================================================================
// 4. THE RE-RUN SUGGEST QUANTITIES HINT: restored to the pre-merge condition
//    (any field change at all), not left narrowed to `settled` only.
// ===========================================================================
console.log("\n4. the rerun hint shows for any field change again, not only settled ones:");
{
  // Positive control: prove the settled block and the hint both still exist
  // before asserting anything about their relationship.
  ok("positive control: the settled block exists",
    section.includes("val settled = fieldChanges.filter { !it.isAwaitingDecision }"));
  ok("positive control: the rerun hint text still exists in this slice",
    section.includes("stringResource(R.string.jsec_fc_rerun_hint)"));

  // The exact regressed shape: the hint's Text(...) call sitting directly
  // inside the `if (settled.isNotEmpty())` block, right after the forEach,
  // with no intervening close-brace. If this ever comes back, the fix has
  // been undone.
  const regressedShape =
    "settled.forEach { change -> FieldChangeCard(change, someone, timeFormat) }\n" +
    "                Text(\n" +
    "                    stringResource(R.string.jsec_fc_rerun_hint),";
  ok("the OLD regressed shape (hint nested inside `if (settled.isNotEmpty())`) is gone",
    !section.includes(regressedShape));

  // The restored shape: settled's block closes right after the forEach, and
  // the hint is a sibling `if (hasFieldChanges)` block after it.
  const restoredShape =
    "settled.forEach { change -> FieldChangeCard(change, someone, timeFormat) }\n" +
    "            }\n";
  ok("settled's own if-block now closes immediately after the forEach (nothing else inside it)",
    section.includes(restoredShape));

  const hintBlockIdx = section.indexOf("if (hasFieldChanges) {");
  const forEachIdx = section.indexOf("settled.forEach { change -> FieldChangeCard(change, someone, timeFormat) }");
  ok("`if (hasFieldChanges)` exists exactly once in this section",
    count(section, "if (hasFieldChanges) {") === 1);
  ok("the hasFieldChanges-gated hint appears after the settled forEach",
    hintBlockIdx !== -1 && forEachIdx !== -1 && hintBlockIdx > forEachIdx);
  const hintBlock = section.slice(hintBlockIdx, section.indexOf("\n            }", hintBlockIdx) + 15);
  ok("the rerun-hint Text call is inside that `if (hasFieldChanges)` block",
    hintBlock.includes("stringResource(R.string.jsec_fc_rerun_hint)"));

  // hasFieldChanges must be the pre-existing whole-list check
  // (fieldChanges.isNotEmpty()), not a new, different condition invented for
  // this fix -- pinning that it is declared exactly where it always was.
  ok("hasFieldChanges is still exactly fieldChanges.isNotEmpty() (unchanged definition)",
    section.includes("val hasFieldChanges = fieldChanges.isNotEmpty()"));
}

// ===========================================================================
// 5. NOTHING SETTLED ON THIS SCREEN WAS TOUCHED: the two OTHER permissions
//    on this same merged card (canEditDrawing / canApprovePlanChanges for
//    restore and approve/reject) are unchanged, and no money or delete term
//    was introduced by this wave's edits.
// ===========================================================================
console.log("\n5. the settled parts of this card are undisturbed:");
{
  ok("the restore button is still gated on canEditDrawing, unchanged",
    section.includes("canEdit = canEditDrawing"));
  ok("approve/reject is still gated on canApprovePlanChanges, unchanged",
    section.includes("PlanRequestCard(request, canApprovePlanChanges, viewModel)"));
  const moneyTerms = ["contractTotal", "grandTotal", "Money.", "acceptedTotal", "priorContractTotal"];
  for (const term of moneyTerms) {
    ok(`still no money term "${term}" inside JobChangesSection's own body`, !section.includes(term));
  }
  ok("still no delete term inside JobChangesSection's own body",
    !section.includes("canDelete") && !section.includes("DELETE_RECORDS"));
}

// ===========================================================================
// 6. NO MISSING STRING RESOURCE: every R.string.* this wave's edited regions
//    reference (Mark Seen gate, overrun call site, StaleSignatureBanner) must
//    already exist in strings.xml -- this wave owns none of the locale files,
//    so it must not have introduced a reference to one that isn't there.
// ===========================================================================
console.log("\n6. no new, missing string resource was introduced:");
{
  const regionsToCheck = [section, screen.slice(Math.max(0, screen.indexOf("private fun StaleSignatureBanner(") - 10), screen.indexOf("private fun StaleSignatureBanner(") + 2000)];
  const declared = new Set([...strings.matchAll(/<string name="([^"]+)"/g)].map(m => m[1]));
  ok("positive control: strings.xml actually parsed some names", declared.size > 50, `count=${declared.size}`);
  let allFound = true;
  const missing = [];
  for (const region of regionsToCheck) {
    for (const m of region.matchAll(/R\.string\.(\w+)/g)) {
      if (!declared.has(m[1])) { allFound = false; missing.push(m[1]); }
    }
  }
  ok("every R.string.* referenced in the edited regions exists in strings.xml",
    allFound, missing.join(", "));
}

console.log(`\n${pass} of ${pass + fail} checks passed`);
if (fail) process.exit(1);
