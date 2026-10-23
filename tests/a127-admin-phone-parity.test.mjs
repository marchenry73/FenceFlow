// A127 -- THE PHONE'S ADMIN AREA KEEPS UP WITH THE CONSOLE'S.
//
// "Do the admin mail chat and phone parity."
//
// WHY A TEST AND NOT A CHECKLIST. The phone's admin area has drifted behind
// the console twice already, quietly, because a view added to admin.html costs
// nothing on the phone until somebody is standing in a yard wanting it. My own
// note of what was missing was itself two thirds stale when I came to do this
// -- it said "Overview tiles, Pricing drift, global audit log" and the first
// two had been built. A list in prose cannot notice that; this can.
//
// WHAT IT PINS:
//   1. every console view has a phone counterpart, or is on a stated list of
//      deliberate exceptions with its reason;
//   2. the two read the SAME SQL for the client mail, so they cannot come to
//      disagree about what was said to whom -- ordering included, which lives
//      in SQL rather than in either client;
//   3. the audit read is PAGED (PostgREST truncates an unpaged read at a
//      thousand rows with no error, and audit_log is the table that meets that
//      cap first);
//   4. the phone's client mail is READ ONLY -- "send this to nine companies"
//      is not a thing to do with a thumb;
//   5. restoring a company from the bin is confirmed before it happens.
//
// Run: node --test tests/a127-admin-phone-parity.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const CONSOLE = read("website/admin.html");
const SCREEN = read("app/src/main/java/com/fenceestimator/app/ui/admin/AdminScreen.kt");
const REPO = read("app/src/main/java/com/fenceestimator/app/cloud/AdminRepository.kt");

/** Comments out. A sentence about a guard is not a guard. */
const code = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1 ");
const SCREEN_CODE = code(SCREEN);
const REPO_CODE = code(REPO);

/**
 * Console views the phone deliberately does NOT have, each with the reason.
 * An entry here is a decision on the record; an absence is a gap.
 */
const PHONE_SKIPS = {
  // The console's Account view is its own sign-in, second factor and mail
  // provider settings. The phone has its own account screen outside Admin,
  // and enrolling an authenticator from a phone that is already signed in
  // would weaken the very factor it is enrolling -- AdminScreen says so to
  // the user in those words.
  account: "the phone has its own account screen, and enrolment must not happen here",
};

test("POSITIVE CONTROL: both files were read and both lists were found", () => {
  assert.ok(CONSOLE.length > 100000, `the console read ${CONSOLE.length} chars`);
  assert.ok(SCREEN_CODE.length > 20000, `the phone screen read ${SCREEN_CODE.length} chars`);
  assert.match(CONSOLE, /const VIEWS = \[/, "the console's view list is gone");
  assert.match(SCREEN_CODE, /val tabs = listOf\(/, "the phone's tab list is gone");
});

/** The console's view names, in order. */
function consoleViews() {
  const m = CONSOLE.match(/const VIEWS = \[([^\]]+)\]/);
  assert.ok(m, "could not read the console's VIEWS");
  return m[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

/** The phone's tab titles, in order. */
function phoneTabs() {
  const at = SCREEN_CODE.indexOf("val tabs = listOf(");
  const close = SCREEN_CODE.indexOf(")", at);
  const body = SCREEN_CODE.slice(at + "val tabs = listOf(".length, close);
  return body.split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

test("1. every console view has a phone counterpart, or a stated reason not to", () => {
  // Names differ on purpose where the phone's word is better in a thumb-sized
  // tab ("Errors" for crashes, "Mail" for email clients), so the match is on
  // meaning, declared here, rather than on spelling.
  const SAME_THING = {
    overview: "Overview",
    companies: "Companies",
    email: "Mail",
    crashes: "Errors",
    releases: "Releases",
    drift: "Drift",
    audit: "Audit",
    bin: "Bin",
  };
  const views = consoleViews();
  const tabs = phoneTabs();
  assert.ok(views.length >= 8, `only ${views.length} console views found`);
  assert.ok(tabs.length >= 8, `only ${tabs.length} phone tabs found`);

  const missing = [];
  for (const v of views) {
    if (v in PHONE_SKIPS) continue;
    const want = SAME_THING[v];
    if (!want) {
      missing.push(`${v} (new console view -- give the phone one, or add it to PHONE_SKIPS with the reason)`);
      continue;
    }
    if (!tabs.includes(want)) missing.push(`${v} -> expected a "${want}" tab on the phone`);
  }
  assert.deepEqual(missing, [],
    "the phone's admin area is behind the console:\n  " + missing.join("\n  "));
});

test("1b. every phone tab is wired to a different composable", () => {
  // A tab that falls through to the wrong body is worse than a missing tab:
  // it looks answered. The `when (tab)` must name one composable per index.
  const at = SCREEN_CODE.indexOf("when (tab) {");
  assert.ok(at > 0, "the phone's tab dispatch is gone");
  const body = SCREEN_CODE.slice(at, SCREEN_CODE.indexOf("\n                }", at));
  const called = [...body.matchAll(/->\s*(\w+Tab)\(\)/g)].map((m) => m[1]);
  assert.equal(called.length, phoneTabs().length,
    `${phoneTabs().length} tabs but ${called.length} bodies: ${called.join(", ")}`);
  assert.equal(new Set(called).size, called.length,
    `two tabs share one body: ${called.join(", ")}`);
  for (const fn of called) {
    assert.ok(SCREEN_CODE.includes(`private fun ${fn}(`), `${fn} is called but not defined`);
  }
});

test("1c. nine tabs scroll rather than being squeezed", () => {
  // TabRow divides the width evenly, so nine labels on a phone are nine
  // unreadable ones. This is the kind of thing that is obvious on a desk and
  // only wrong in a hand.
  assert.match(SCREEN_CODE, /ScrollableTabRow\(selectedTabIndex = tab/,
    "nine admin tabs are in a fixed TabRow; the labels will not be readable");
});

test("2. the phone and the console read the SAME client-mail SQL", () => {
  // Two screens showing "what have I said to this client" that read different
  // sources will eventually disagree, and the one that is wrong will be the
  // one somebody is holding in a yard. Ordering lives in SQL for the same
  // reason.
  for (const fn of ["admin_client_email_threads", "admin_client_email_thread"]) {
    assert.ok(CONSOLE.includes(fn), `the console no longer calls ${fn}`);
    assert.ok(REPO_CODE.includes(fn), `the phone no longer calls ${fn}`);
  }
  // And neither sorts the conversation itself.
  const thread = REPO_CODE.slice(
    REPO_CODE.indexOf("suspend fun clientEmailThread("),
    REPO_CODE.indexOf("suspend fun clientEmailThread(") + 700,
  );
  assert.ok(!/sortedBy|sortedWith|reversed\(\)/.test(thread),
    "the phone re-sorts the conversation, so it can disagree with the console's order");
});

test("3. the audit read is paged, not an unpaged select", () => {
  // PostgREST truncates an unpaged read at a thousand rows with no error of
  // any kind, and audit_log carries a row PER FIELD changed, so it is the
  // table that meets that cap first. A screen that silently stopped would
  // read as "that is all there is".
  const fn = REPO_CODE.slice(
    REPO_CODE.indexOf("suspend fun auditLog("),
    REPO_CODE.indexOf("suspend fun removedCompanies("),
  );
  assert.ok(fn.length > 200, "could not find auditLog");
  assert.match(fn, /range\(offset\.toLong\(\)/, "auditLog no longer pages");
  assert.match(fn, /order\("at"/, "auditLog no longer orders, so paging means nothing");
  // And the screen asks for more rather than pretending the first page is all.
  assert.match(SCREEN_CODE, /reachedEnd = got\.size < page/,
    "the audit tab no longer works out whether there is more to read");
});

test("4. the phone's client mail is read only", () => {
  // The console composes and sends; the phone answers "have I already told
  // them". Sending to a list of companies from a phone is a foot-gun, and the
  // claim in the database protects against a double press, not against a
  // misaimed one.
  assert.ok(!REPO_CODE.includes("admin-mail-send"),
    "the phone can invoke the client-email sender");
  assert.ok(!REPO_CODE.includes("admin_claim_client_email"),
    "the phone can claim a client email, which is a send in all but name");
  const tab = SCREEN_CODE.slice(
    SCREEN_CODE.indexOf("private fun ClientMailTab()"),
    SCREEN_CODE.indexOf("private fun SignInsTab()"),
  );
  assert.ok(tab.length > 500, "could not find ClientMailTab");
  assert.ok(!/TextField|OutlinedTextField/.test(tab),
    "the phone's client mail tab has a text field, so something can be composed there");
  // And it says where sending lives, rather than leaving the reader looking.
  assert.ok(/Sending is on the admin website/.test(SCREEN),
    "the phone no longer says where a client email is actually sent from");
});

test("4b. the one-sided conversation is stated, on both", () => {
  // There is no platform inbox: a client's reply goes to the support address
  // and nothing ingests it. Drawing a chat with a silent other half would
  // imply the replies were being read.
  assert.ok(/support address/.test(SCREEN),
    "the phone no longer says replies are not read here");
  assert.ok(/emOneWay/.test(CONSOLE),
    "the console no longer says replies are not read here");
});

test("5. restoring a company from the bin is confirmed first", () => {
  // Restoring opens their office and lets their people sign in again. Not a
  // thing to do by brushing a list.
  const tab = SCREEN_CODE.slice(
    SCREEN_CODE.indexOf("private fun BinTab()"),
    SCREEN_CODE.indexOf("private fun ClientMailTab()"),
  );
  assert.ok(tab.length > 500, "could not find BinTab");
  assert.match(tab, /AlertDialog\(/, "the restore is no longer confirmed");
  const dialogAt = tab.indexOf("AlertDialog(");
  const callAt = tab.indexOf("AdminRepository.restoreCompany(");
  assert.ok(callAt > dialogAt,
    "restoreCompany is called outside the confirmation dialog");
  // The counts are in the question, because they are what make it a decision.
  assert.match(tab, /\$\{c\.people\} people/, "the confirmation no longer says how many people come back");
});

test("CANARY: a console view with no phone tab is detected", () => {
  // If this cannot be spotted, check 1 is decoration.
  const SAME_THING = { overview: "Overview" };
  const views = ["overview", "newthing"];
  const tabs = ["Overview"];
  const missing = views.filter((v) => !(v in PHONE_SKIPS) && !tabs.includes(SAME_THING[v]));
  assert.deepEqual(missing, ["newthing"],
    "THE CANARY DID NOT FIRE: a console view with no phone counterpart read as covered");
});
