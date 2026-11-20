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

/**
 * Every OutlinedButton in CompaniesTab, as its own window of source.
 *
 * NOT a slice of the file between two landmarks. Two attempts at that failed
 * here: one ran past the buttons and blamed a dialog's own repository call on
 * a button, the other stopped short and read a region with no buttons in it.
 * Positions move whenever somebody inserts a control; a button does not stop
 * being a button.
 *
 * The per-company controls are OutlinedButton and every dialog's confirm and
 * dismiss are TextButton, so this sees buttons and never a dialog.
 *
 * MEASURED 20 Nov 2026 rather than assumed: CompaniesTab holds 11
 * OutlinedButton and 10 TextButton, and the only TextButton whose window
 * touches one of the three reaching actions is a dialog's confirmButton.
 * THE LIMIT THAT LEAVES: a per-company action added later as a TextButton
 * OUTSIDE a dialog would not be seen here. If that ever happens, this helper
 * is where to widen it -- and the floor below is what should make somebody
 * look.
 */
function companyButtons(tab) {
  const out = [];
  const re = /OutlinedButton\(/g;
  let m;
  while ((m = re.exec(tab)) !== null) {
    // The window ends at whichever comes first: the next button, the first
    // dialog after this one, or 700 characters. The dialog bound matters for
    // the LAST button in the tab -- without it that window runs on into the
    // dialogs below and the dialog's own (correct) repository call is read as
    // this button's.
    const ends = [
      tab.indexOf("OutlinedButton(", m.index + 1),
      tab.indexOf("AlertDialog(", m.index + 1),
      m.index + 700,
    ].filter((i) => i > m.index);
    out.push(tab.slice(m.index, Math.min(...ends)));
  }
  return out;
}

/**
 * The three actions that reach into a company somebody is already working in.
 * Creating a company is deliberately NOT one of them: the add-company button
 * calls the repository straight from its onClick, correctly.
 */
const ACTS_ON_A_COMPANY = ["extendTrial(", "suspendCompany(", "unsuspendCompany("];

test("every one of them asks before it does anything", () => {
  // These decide whether another company can work tomorrow, from a phone,
  // with a thumb. The console asks before each; so does this.
  const at = SCREEN_SRC.indexOf("private fun CompaniesTab");
  assert.ok(at > 0, "CompaniesTab is gone");
  const tab = SCREEN_SRC.slice(at, SCREEN_SRC.indexOf("private enum class AdminAction", at));

  // No button that acts on an existing company calls the repository; each
  // opens a dialog first.
  const buttons = companyButtons(tab);
  // FLOOR, so this cannot pass by finding nothing: Manage, +1 day, +14 days,
  // Give time and the add-company button are all OutlinedButtons here.
  assert.ok(buttons.length >= 5,
    `only ${buttons.length} buttons found in CompaniesTab -- this is reading the wrong thing`);
  assert.ok(buttons.every((b) => !/AlertDialog\(/.test(b)),
    "a button window reaches into a dialog, so a dialog's own calls would be blamed on a button");
  for (const call of ACTS_ON_A_COMPANY) {
    assert.ok(!buttons.some((b) => b.includes(call)),
      `a company button calls ${call} straight out, with nothing asked`);
  }
  assert.ok(/AlertDialog\(/.test(SCREEN_SRC), "nothing asks before the action runs");
  // Each reaching action still goes through a confirm step of some kind: the
  // suspend/reinstate pair through `pending`, the extension through its own
  // dialog state. Named both ways so neither can quietly stop confirming.
  assert.ok(/pending = c to AdminAction\./.test(tab),
    "the suspend and reinstate buttons no longer go through the confirm step");
  assert.ok(/extendFor = c/.test(tab),
    "the trial buttons no longer open the confirm dialog");
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
  // ANCHORED ON THE CALL, NOT ON ITS ARGUMENTS. This named
  // "AdminRepository.extendTrial(company.id, 1)", which vanished when the two
  // fixed buttons became one dialog taking any number of days. What matters is
  // that wherever the extension happens, the list is re-read from the server
  // and a refusal is shown.
  const at = SCREEN_SRC.search(/AdminRepository\.extendTrial\(/);
  assert.ok(at > 0, "nothing calls extendTrial any more");
  const after = SCREEN_SRC.slice(at, at + 1400);
  assert.ok(/load\(\)/.test(after), "the list is not re-read after an action");
  assert.ok(/onFailure/.test(after), "a refusal is swallowed instead of being shown");
  // CONTROL: the window really holds the extension's own handler, so the two
  // assertions above are not reading a neighbouring dialog's.
  assert.ok(/extendFor = null|pending = null/.test(after),
    "the window after the call closes no dialog -- it is the wrong region");
});

test("CANARY: a direct column write, and a silent action, each turn those red", () => {
  // Teeth for the first and third checks.
  const sabotagedRepo = REPO_SRC.replace('"admin_extend_trial"', '"companies_update_hack"');
  assert.notEqual(sabotagedRepo, REPO_SRC, "the canary did not change the source");
  assert.ok(!sabotagedRepo.includes('"admin_extend_trial"'),
    "THE CANARY DID NOT FAIL: the RPC name could be changed unnoticed");

  const at = SCREEN_SRC.indexOf("private fun CompaniesTab");
  const tab = SCREEN_SRC.slice(at, SCREEN_SRC.indexOf("private enum class AdminAction", at));
  // Sabotage by PATTERN rather than by one button's exact text: naming the
  // ExtendOneDay click verbatim is what made this canary stop sabotaging
  // anything the day that button was replaced.
  const clickPattern = /onClick = \{ actionError = null;[^}]*\},/;
  assert.ok(clickPattern.test(tab), "no confirming button left to sabotage -- re-aim this canary");
  const sabotagedTab = tab.replace(clickPattern,
    "onClick = { scope.launch { AdminRepository.extendTrial(c.id, 1) } },");
  assert.notEqual(sabotagedTab, tab, "the canary did not change the source");
  assert.ok(
    companyButtons(sabotagedTab).some((b) => ACTS_ON_A_COMPANY.some((c) => b.includes(c))),
    "THE CANARY DID NOT FAIL: a button wired straight to the repository went unnoticed");
});
