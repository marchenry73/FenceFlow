// a83: A SPEC EDIT ON THE RUN-EDIT SCREEN MUST RE-PRICE THE SIDE.
//
// RunEditViewModel.update wrote the row and stopped. The only re-pricing
// watcher in the app lives on the drawing screen (SurveyViewModel), and the
// run-edit screen is reached from the job screen, where no such view model
// exists -- so panel height, panel width, post spacing, concrete bags per
// post, the rail count and the teardown flag all changed the SPEC while the
// estimate went on billing the previous one. Nothing told anybody. The total
// then moved "on its own" the next time something unrelated touched that run.
//
// setFenceType already had the fix and its own doc comment already described
// the disease in general terms. This pins the cure to every other field.
//
// Source-reading, because a Kotlin view model cannot be constructed off
// device. Every check therefore proves its own grep can fail -- see section 4.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const K = join(ROOT, "app/src/main/java/com/fenceestimator/app");

const VM = readFileSync(join(K, "ui/runs/RunEditViewModel.kt"), "utf8");
const REFRESHER = readFileSync(join(K, "estimate/TakeoffRefresher.kt"), "utf8");

let passed = 0, failed = 0;
const ok = (id, what, cond) => {
  if (cond) { passed++; console.log(`  ok    ${id} ${what}`); }
  else { failed++; console.log(`  FAIL  ${id} ${what}`); }
};

/** The body of a named function, brace-balanced, so a check cannot wander
 *  into a neighbouring function and report its code as this one's. */
function bodyOf(src, decl) {
  const at = src.indexOf(decl);
  if (at < 0) return null;
  const open = src.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

const update = bodyOf(VM, "fun update(transform: (FenceRun) -> FenceRun)");
const del = bodyOf(VM, "fun delete(onDeleted: () -> Unit)");
const setType = bodyOf(VM, "fun setFenceType(");

console.log("\n1. THE REGION EXISTS AND IS THE RIGHT ONE");
ok("1a", "update()'s body was found and is brace-balanced", update !== null && update.endsWith("}"));
ok("1b", "delete()'s body was found", del !== null);
ok("1c", "POSITIVE CONTROL: setFenceType is found too, and it is the function that already re-priced -- so the extractor works on this file",
  setType !== null && /refreshAfterTypeChange/.test(setType));
ok("1d", "and the bodies are genuinely different regions, not one match reused",
  update !== del && update !== setType);

console.log("\n2. A SPEC EDIT RE-PRICES");
ok("2a", "update() re-prices through TakeoffRefresher rather than writing and stopping",
  /TakeoffRefresher\.refreshRun/.test(update));
ok("2b", "and it decides by comparing the pricing signature BEFORE and AFTER, not by a hand-kept list of field names",
  /pricingSignature\([^)]*\)\s*!=\s*[\s\S]{0,80}pricingSignature\(/.test(update));
ok("2c", "it asks mayReprice for the person on this phone rather than assuming a yes",
  /mayReprice\s*=\s*TakeoffRefresher\.mayReprice\(/.test(update));
ok("2d", "it re-reads the row first, so a spec is never written over a stale copy",
  /repository\.getFenceRun\(runId\)/.test(update));
ok("2e", "the guest is still refused before anything is written",
  /isGuestDemo/.test(update) && update.indexOf("isGuestDemo") < update.indexOf("updateFenceRun"));

console.log("\n3. A DELETE RE-PRICES THE SIDES LEFT BEHIND");
ok("3a", "delete() re-prices after removing the run -- the survivor that shared its corner post needs its own end post back",
  /TakeoffRefresher\.refreshRun/.test(del));
ok("3b", "and it walks every remaining run of the JOB, not a guessed partner",
  /getFenceRuns\(/.test(del));
ok("3c", "the re-price happens AFTER the delete, so the freed joints are already written",
  del.indexOf("deleteFenceRun") < del.indexOf("refreshRun"));

console.log("\n4. THE SIGNATURE IS THE RIGHT TEST, AND THESE CHECKS CAN FAIL");
/** pricingSignature is expression-bodied (`= run.copy( ... )`), so the brace
 *  balancer above would wander into the next function. Balance PARENS from the
 *  copy() call instead. 4g proves this extractor finds the real thing. */
function copyArgsOf(src, decl) {
  const at = src.indexOf(decl);
  if (at < 0) return null;
  const open = src.indexOf("run.copy(", at);
  if (open < 0) return null;
  const from = open + "run.copy".length;
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") { depth--; if (depth === 0) return src.slice(from, i + 1); }
  }
  return null;
}
const sig = copyArgsOf(REFRESHER, "fun pricingSignature(run: FenceRun)");
ok("4a", "pricingSignature subtracts the label and the sort order, so renaming or reordering a side re-prices nothing",
  sig !== null && /label = ""/.test(sig) && /sortOrder = 0/.test(sig));
ok("4b", "and it subtracts identity and the sync clock, so a sync alone cannot trigger a re-price",
  /syncId = ""/.test(sig) && /updatedAt = 0L/.test(sig));
ok("4c", "but it does NOT subtract panelHeightFt, postSpacingFt or concreteBagsPerPost -- those are the spec, and they are what must re-price",
  !/panelHeightFt\s*=/.test(sig) && !/postSpacingFt\s*=/.test(sig) && !/concreteBagsPerPost\s*=/.test(sig));
ok("4d", "CANARY: the old update() -- a one-line write with no refresh -- fails check 2a, proving 2a can fail",
  !/TakeoffRefresher\.refreshRun/.test(
    `viewModelScope.launch { repository.updateFenceRun(transform(current)) }`));
ok("4e", "CANARY: an update() that re-priced unconditionally fails check 2b, proving 2b tests the signature and not merely the presence of a refresh",
  !/pricingSignature\([^)]*\)\s*!=\s*[\s\S]{0,80}pricingSignature\(/.test(
    `val updated = transform(fresh)
     repository.updateFenceRun(updated)
     TakeoffRefresher.refreshRun(repository, updated, mayReprice = true)`));
ok("4f", "CANARY: bodyOf returns null for a function that is not there, so a missing region reads as a failure and never as a pass",
  bodyOf(VM, "fun thisFunctionDoesNotExist(") === null);
ok("4g", "POSITIVE CONTROL: the extracted signature region really is pricingSignature's argument list -- it names the run's own id, which nothing else in that file zeroes",
  sig !== null && /id = 0L/.test(sig) && /jobId = 0L/.test(sig));
ok("4h", "CANARY: the brace balancer on an expression-bodied function does NOT return the copy() arguments, which is why 4a-4c use their own extractor",
  !/id = 0L/.test(bodyOf(REFRESHER, "fun pricingSignature(run: FenceRun)") ?? ""));

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
