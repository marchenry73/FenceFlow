// A74 -- DELETED ITEMS: the phone's list and the office's list are the same list.
//
// "I also do not see the permanent delete on the deleted items on the app. I
//  also want to be able to see the deleted items in the websites too"
//
// The phone has TrashBin.kt's RECOVERABLE; the office now has dashboard.html's
// TRASH_TABLES. They are two hand-written lists of the same thing, and a table
// added to one and not the other produces the worst possible failure for a
// recovery screen: a kind of deletion that one surface lists and the other
// silently does not, which reads as "nothing was deleted" rather than as a
// missing feature. That is this project's own recorded mistake --
// [[backup-list-drift]], where a hardcoded table list ran thirteen tables
// behind.
//
// So this file reads BOTH sources and compares them: the table names, their
// order, and the column each one takes a row's name from. It also pins the
// things that make the pair safe:
//
//   - Delete forever is offered on JOBS ONLY, on both surfaces, because
//     purge_job takes a job's sync id and there is nothing equivalent for a
//     catalog item. A button that fails on six kinds out of seven is worse
//     than no button.
//   - Neither surface re-implements purge_job's rules. The money refusal, the
//     DELETE_RECORDS check and the "must already be deleted" check live in
//     the function; a copy on either client is a copy that will one day
//     disagree.
//   - Neither surface rewords the server's refusal. "That job has 2 payment
//     record(s) against it" is the sentence that answers "why can I not
//     delete this one", and rewriting refusals by code is what once replaced
//     42 deliberate server messages with one wrong one.
//   - The office's read is PAGED. An unpaged read is capped at a thousand rows
//     with no error, and an item you cannot see in Deleted Items is
//     indistinguishable from an item that is gone.
//
// NOTHING IS DELETED. Every assertion is against source text.
//
// Run: node --test tests/a74-deleted-items.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const BIN = "app/src/main/java/com/fenceestimator/app/cloud/TrashBin.kt";
const VM = "app/src/main/java/com/fenceestimator/app/ui/account/TrashViewModel.kt";
const SCREEN = "app/src/main/java/com/fenceestimator/app/ui/account/TrashScreen.kt";
const DASH = "website/dashboard.html";
const SQL = "supabase_r33_purge_job_never_money.sql";

const bin = read(BIN);
const vm = read(VM);
const screen = read(SCREEN);
const dash = read(DASH);
const sql = read(SQL);

/** Comments stripped, so a sentence ABOUT a thing is never read as the thing.
 *  Three checks in one day once failed by reading a comment as code. */
/** Comments stripped. Works for both the Kotlin and the office's
 *  JavaScript: a line EXPLAINING a rule is not a line enforcing it, and the
 *  first version of the purge check below failed on its own explanatory
 *  comment. */
const codeOnly = (s) =>
  s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

// ---------------------------------------------------------------------------
// The two lists.
// ---------------------------------------------------------------------------

/** TrashBin.kt: TrashTable("jobs", "customer_name", "Job", R.string...) */
function phoneTables() {
  const block = bin.slice(bin.indexOf("private val RECOVERABLE"));
  const end = block.indexOf("\n    )");
  assert.ok(end > 0, "could not find the end of RECOVERABLE");
  return [...block.slice(0, end).matchAll(
    /TrashTable\(\s*"([a-z_]+)"\s*,\s*"([a-z_]+)"/g
  )].map((m) => ({ table: m[1], label: m[2] }));
}

/** dashboard.html: { table:'jobs', label:'customer_name', kind:'...' } */
function officeTables() {
  const i = dash.indexOf("const TRASH_TABLES = [");
  assert.ok(i > 0, "TRASH_TABLES is not in dashboard.html");
  const end = dash.indexOf("];", i);
  return [...dash.slice(i, end).matchAll(
    /table:\s*'([a-z_]+)'\s*,\s*label:\s*'([a-z_]+)'/g
  )].map((m) => ({ table: m[1], label: m[2] }));
}

test("POSITIVE CONTROL: both lists were actually read", () => {
  // Without this, every comparison below passes when a regex stops matching.
  assert.ok(phoneTables().length >= 7, "the phone list parsed as " + phoneTables().length + " tables");
  assert.ok(officeTables().length >= 7, "the office list parsed as " + officeTables().length + " tables");
});

test("the phone and the office list the same tables, in the same order", () => {
  assert.deepEqual(officeTables(), phoneTables(),
    "the two Deleted-items lists have drifted: a kind of deletion is listed on one surface and not the other");
});

test("jobs is in the list, and is the only table purge_job is offered for", () => {
  assert.ok(phoneTables().some((t) => t.table === "jobs"), "jobs is not recoverable at all");

  // The phone decides this in one place, named for what it answers.
  assert.match(codeOnly(vm), /fun canPurge\(record: TrashedRecord\): Boolean = record\.table == "jobs"/,
    "the phone no longer restricts Delete forever to jobs");
  assert.match(codeOnly(screen), /if \(viewModel\.canPurge\(record\)\)/,
    "the phone's Delete forever button does not ask canPurge");

  // And the office, on its own row renderer.
  assert.match(dash, /r\.table === 'jobs'\s*\n?\s*\?\s*'<button class="btn btn-sm" data-purge=/,
    "the office offers Delete forever on rows that are not jobs");
  assert.match(dash, /if\(!row \|\| row\.table !== 'jobs'\) return;/,
    "the office's purge handler does not refuse a non-job row");
});

test("Delete forever goes through the RPC, never a DELETE", () => {
  const code = codeOnly(bin);
  assert.match(code, /rpc\(\s*\n?\s*"purge_job"/, "the phone does not call purge_job");
  assert.match(dash, /db\.rpc\('purge_job', \{ p_job_sync_id: row\.syncId \}\)/,
    "the office does not call purge_job");

  // THE OLD BUG, pinned so it cannot come back: a plain DELETE on these tables
  // is refused for every role -- there is no DELETE policy for anybody, owner
  // included -- so it returned success and destroyed nothing, and whoever
  // pressed the button watched the item come back on the next load.
  assert.ok(!/\.delete\s*\{/.test(code),
    "TrashBin issues a raw DELETE again; the database refuses those silently");
  assert.ok(!/from\('jobs'\)[\s\S]{0,80}\.delete\(/.test(dash),
    "the office issues a raw DELETE on jobs");
});

test("neither client re-implements purge_job's rules", () => {
  // The three refusals live in the function. A copy on a client is a copy that
  // will one day answer differently -- and the one that matters is about money.
  // SCOPED TO THE TWO PURGE FUNCTIONS, not to the files. dashboard.html is
  // thirty thousand lines with a payments view in it, so "does the file
  // mention payment_records" is true for reasons that have nothing to do with
  // this feature -- the first version of this check read almost the whole file
  // and failed on the office payments screen.
  const phonePurge = (() => {
    const i = codeOnly(vm).indexOf("fun purge(record");
    assert.ok(i > 0, "the phone has no purge() to scope to");
    return codeOnly(vm).slice(i, i + 2000);
  })();
  const officePurge = (() => {
    const i = dash.indexOf("async function purgeTrashRow");
    assert.ok(i > 0, "the office has no purgeTrashRow to scope to");
    return codeOnly(dash.slice(i, dash.indexOf("async function loadBilling", i)));
  })();
  for (const [name, src] of [["the phone", phonePurge], ["the office", officePurge]]) {
    for (const rule of [/payment_records/, /job_payments/, /DELETE_RECORDS/, /deleted_at/]) {
      assert.ok(!rule.test(src),
        name + " checks " + rule + " for itself instead of letting purge_job refuse");
    }
  }
  // CONTROL: the scoping found real code, not an empty slice -- which would
  // make the four assertions above pass for nothing.
  // The phone calls the Kotlin wrapper; purge_job, the RPC name, lives in
  // TrashBin.kt and is asserted there instead. Looking for the RPC name here
  // made this control fail -- which is the control working.
  assert.ok(/TrashBin\.purgeJob\(/.test(phonePurge), "the phone slice does not contain the purge call");
  assert.ok(/purge_job/.test(officePurge), "the office slice does not contain the purge call");
  // And the function really does carry all three, read from the SQL itself.
  assert.match(sql, /has_permission\('DELETE_RECORDS'\)/);
  assert.match(sql, /payment record\(s\) against it/);
  assert.match(sql, /That job is not deleted/);
});

test("the server's refusal is shown in the server's own words", () => {
  // The phone hands the throwable to shownError with the raw message as the
  // fallback, so nothing of ours replaces the sentence.
  assert.match(codeOnly(vm), /shownError\(/, "the phone does not use shownError for the refusal");
  // The office shows error.message, not a sentence of its own keyed off a code.
  assert.match(dash, /msg\('trashMsg', error\.message \|\| tr\('trashPurgeFailed'\), 'err'\)/,
    "the office replaces the server's refusal with wording of its own");
});

test("the office's read is paged", () => {
  const i = dash.indexOf("async function loadTrash()");
  assert.ok(i > 0, "loadTrash is missing");
  const fn = dash.slice(i, dash.indexOf("function renderTrash()", i));
  assert.match(fn, /\.range\(from, from \+ 499\)/, "loadTrash does not page");
  assert.match(fn, /if\(!data \|\| data\.length < 500\) break;/, "loadTrash has no page-exit test");
  assert.match(fn, /from \+= 500;/, "loadTrash never advances the page");
  // CANARY: an unpaged read would have neither, and the two assertions above
  // are the only thing standing between this and the silent 1000-row cap.
  assert.ok(!/\.limit\(\s*\d+\s*\)/.test(fn), "loadTrash uses a bare limit instead of paging");
});

test("one broken table does not empty the whole list", () => {
  const i = dash.indexOf("async function loadTrash()");
  const fn = dash.slice(i, dash.indexOf("function renderTrash()", i));
  // Per-table try/catch: a recovery screen that shows nothing because one
  // query broke is indistinguishable from having nothing to recover.
  assert.match(fn, /for\(const spec of TRASH_TABLES\)\{\s*\n\s*try\{/,
    "a failing table takes the whole office list down with it");
  assert.match(fn, /console\.error\('loadTrash ' \+ spec\.table/,
    "a failing table fails silently with no trace at all");
});

test("deleted_by is escaped, not trusted", () => {
  const i = dash.indexOf("function renderTrash()");
  const fn = dash.slice(i, dash.indexOf("async function purgeTrashRow", i));
  // It is an address the app wrote into the row; it is stored text like any
  // other, and one of his own jobs carries an empty-string deleted_by.
  assert.match(fn, /esc\(r\.deletedBy\)/, "deleted_by reaches the page unescaped");
  assert.match(fn, /esc\(r\.label\)/, "the record's name reaches the page unescaped");
});

test("the office asks before destroying, and the dialog says what goes", () => {
  assert.match(dash, /trashPurgeTitle/, "there is no confirmation title");
  const i = dash.indexOf("trashPurgeBody:'");
  const body = dash.slice(i, dash.indexOf("',", i));
  // It must name what is destroyed AND the money rule, before the refusal is
  // ever hit -- "why can I not delete this one" answered in advance.
  for (const word of ["drawing", "estimate", "photos", "payment"]) {
    assert.ok(body.toLowerCase().includes(word), "the confirmation does not mention " + word);
  }
  assert.ok(/cannot be undone/i.test(body), "the confirmation does not say it is irreversible");
});

test("the office tab is wired to a loader, and the panel exists", () => {
  assert.match(dash, /<button class="tab" data-tab="trash" data-t="tabTrash">/, "no nav button");
  assert.match(dash, /<div id="tab-trash" style="display:none">/, "no panel");
  // In the display list, or the panel never shows.
  const i = dash.indexOf("'reports','automation','settings','billing'");
  assert.ok(i > 0 && dash.slice(i, i + 80).includes("'trash'"),
    "tab-trash is not in switchTab's display list, so the panel can never appear");
  assert.match(dash, /if\(name==='trash'\) loadTrash\(\)/, "opening the tab loads nothing");
});
