// A110 -- the app's admin screen can change whether somebody else's business
// opens tomorrow, so what it does must match the console exactly.
//
// Run with:  node --test tests/a110-admin-company-actions.test.mjs
//
// Source checks: Kotlin is not compiled here. Each is paired with a canary that
// sabotages a copy and asserts the check would have gone red.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const REPO = "app/src/main/java/com/fenceestimator/app/cloud/AdminRepository.kt";
const SCREEN = "app/src/main/java/com/fenceestimator/app/ui/admin/AdminScreen.kt";
const CONSOLE = "website/admin.html";

/** Source with comments blanked, string literals left alone. */
function stripComments(src) {
  let out = "";
  let i = 0;
  const blank = (ch) => (ch === "\n" ? "\n" : " ");
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c; i++;
      while (i < src.length) {
        if (src[i] === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        if (src[i] === "\n" && q !== "`") { i++; break; }
        i++;
      }
      continue;
    }
    if (two === "//") { while (i < src.length && src[i] !== "\n") { out += " "; i++; } }
    else if (two === "/*") {
      while (i < src.length && src.slice(i, i + 2) !== "*/") { out += blank(src[i]); i++; }
      out += "  "; i += 2;
    } else if (src.slice(i, i + 4) === "<!--") {
      while (i < src.length && src.slice(i, i + 3) !== "-->") { out += blank(src[i]); i++; }
      out += "   "; i += 3;
    } else { out += c; i++; }
  }
  return out;
}

const REPO_SRC = stripComments(read(REPO));
const SCREEN_SRC = stripComments(read(SCREEN));

test("the app calls the SAME audited functions the console does", () => {
  // Not an UPDATE on companies. updateCompany in this very file can write
  // those columns and, for a platform admin, protect_billing_columns lets it
  // through -- so the wrong version would appear to work. The RPCs record a
  // reason and a HOLD flag a column write cannot express, and they RAISE for a
  // non-admin where a filtered UPDATE is zero rows and no error at all.
  for (const fn of ["admin_extend_trial", "admin_suspend", "admin_unsuspend"]) {
    assert.ok(REPO_SRC.includes(`rpc(\n            "${fn}"`) || REPO_SRC.includes(`"${fn}"`),
      `the app does not call ${fn}`);
    assert.ok(stripComments(read(CONSOLE)).includes(`'${fn}'`),
      `${fn} is not what the console calls -- the two halves have drifted`);
  }
});

test("the argument names match the functions' own", () => {
  // A misspelled argument is not a compile error on either side; PostgREST
  // answers "function not found" at the moment somebody taps the button.
  const extend = REPO_SRC.slice(REPO_SRC.indexOf("suspend fun extendTrial"));
  assert.ok(/put\("target", companyId\)/.test(extend), "extendTrial does not pass `target`");
  assert.ok(/put\("days", days\)/.test(extend), "extendTrial does not pass `days`");

  const susp = REPO_SRC.slice(REPO_SRC.indexOf("suspend fun suspendCompany"));
  assert.ok(/put\("target", companyId\)/.test(susp), "suspendCompany does not pass `target`");
  assert.ok(/put\("note",/.test(susp), "suspendCompany does not pass `note`");
  assert.ok(/put\("hold", hold\)/.test(susp), "suspendCompany does not pass `hold`");

  const un = REPO_SRC.slice(REPO_SRC.indexOf("suspend fun unsuspendCompany"));
  assert.ok(/put\("target", companyId\)/.test(un), "unsuspendCompany does not pass `target`");
});

test("every one of them asks before it does anything", () => {
  // These decide whether another company can work tomorrow, from a phone,
  // with a thumb. The console asks before each; so does this.
  const at = SCREEN_SRC.indexOf("private fun CompaniesTab");
  assert.ok(at > 0, "CompaniesTab is gone");
  const tab = SCREEN_SRC.slice(at, SCREEN_SRC.indexOf("private enum class AdminAction", at));

  // No button calls the repository directly; they all set `pending`.
  for (const call of ["extendTrial(", "suspendCompany(", "unsuspendCompany("]) {
    const inButtons = tab.slice(tab.indexOf("OutlinedButton"), tab.indexOf("pending?.let"));
    assert.ok(!inButtons.includes(call),
      `a company button calls ${call} straight out, with nothing asked`);
  }
  assert.ok(/AlertDialog\(/.test(SCREEN_SRC), "nothing asks before the action runs");
  assert.ok(/pending = c to AdminAction\./.test(tab),
    "the buttons no longer go through the confirm step");
});

test("a suspension from the phone is never a HOLD", () => {
  // A HOLD says paying will NOT lift it -- my_service_status answers
  // can_self_serve = false and the office stops offering a plan. Choosing that
  // belongs at a keyboard with the reason typed out, not on a phone.
  // Bounded by the NEXT branch, not by a character count. Comments are blanked
  // to spaces by stripComments, so a fixed 400-character window landed in the
  // middle of this branch's own explanation and missed the line underneath it
  // -- the check failed on correct code, which is the failure mode this file
  // exists to avoid in the app.
  const at = SCREEN_SRC.indexOf("AdminAction.Suspend ->");
  assert.ok(at > 0, "the suspend branch is gone");
  const end = SCREEN_SRC.indexOf("AdminAction.Reinstate ->", at);
  assert.ok(end > at, "the branch after it is gone, so this cannot be bounded");
  const branch = SCREEN_SRC.slice(at, end);
  assert.ok(/hold = false/.test(branch), "the phone can set a HOLD");
  assert.ok(!/hold = true/.test(branch), "the phone sets a HOLD outright");

  // CONTROL: the slice really contains the call, so the assertion above is
  // reading the branch and not an empty string.
  assert.ok(/suspendCompany\(/.test(branch),
    "the suspend branch does not call suspendCompany -- this check is reading the wrong region");
});

test("the list is re-read from the server, not patched in place", () => {
  // The server decides. Patching the row locally would show an outcome nobody
  // confirmed -- the exact shape of every "it said saved" bug in this repo.
  const at = SCREEN_SRC.indexOf("AdminRepository.extendTrial(company.id, 1)");
  assert.ok(at > 0, "the one-day action is gone");
  const after = SCREEN_SRC.slice(at, at + 1400);
  assert.ok(/load\(\)/.test(after), "the list is not re-read after an action");
  assert.ok(/onFailure/.test(after), "a refusal is swallowed instead of being shown");
});

test("CANARY: a direct column write, and a silent action, each turn those red", () => {
  // Teeth for the first and third checks.
  const sabotagedRepo = REPO_SRC.replace('"admin_extend_trial"', '"companies_update_hack"');
  assert.notEqual(sabotagedRepo, REPO_SRC, "the canary did not change the source");
  assert.ok(!sabotagedRepo.includes('"admin_extend_trial"'),
    "THE CANARY DID NOT FAIL: the RPC name could be changed unnoticed");

  const at = SCREEN_SRC.indexOf("private fun CompaniesTab");
  const tab = SCREEN_SRC.slice(at, SCREEN_SRC.indexOf("private enum class AdminAction", at));
  const sabotagedTab = tab.replace(
    "onClick = { actionError = null; pending = c to AdminAction.ExtendOneDay },",
    "onClick = { scope.launch { AdminRepository.extendTrial(c.id, 1) } },");
  assert.notEqual(sabotagedTab, tab, "the canary did not change the source");
  const inButtons = sabotagedTab.slice(sabotagedTab.indexOf("OutlinedButton"),
                                       sabotagedTab.indexOf("pending?.let"));
  assert.ok(inButtons.includes("extendTrial("),
    "THE CANARY DID NOT FAIL: a button wired straight to the repository went unnoticed");
});
