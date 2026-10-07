// a107: THE OPT-OUT THE EMAIL PROMISES MUST BE SETTABLE.
//
// Every follow-up email ends:
//
//     "If you'd rather not receive these, just reply and let us know."
//
// send-follow-ups honours jobs.opted_out_at and never emails an opted-out job
// (it filters `.is("opted_out_at", null)`), and follow-up-logic returns null
// for one. The waiting counts on Automation exclude them too.
//
// And NOTHING IN THE CODEBASE EVER WROTE THAT COLUMN. Not the inbound mail
// handler, not the office, not the app. It was declared, read, respected --
// and unreachable. So a customer who replied asking to stop was not opted out,
// and the next follow-up went anyway.
//
// That is the "no fake features" rule broken in the worst available place: an
// automated email to a stranger, promising something the product cannot do.
// The owner chose to fix this BEFORE switching any rule on.
//
// This pins the control and, more importantly, the two things about it that
// are easy to get subtly wrong.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DASH = readFileSync(join(ROOT, "website/dashboard.html"), "utf8");
const SENDER = readFileSync(
  join(ROOT, "supabase/functions/send-follow-ups/index.ts"), "utf8");

test("the sender still promises it, so the office must still deliver it", () => {
  // If this line is ever removed, the control below stops being load-bearing
  // -- but while the promise is made, it has to be keepable.
  assert.match(SENDER, /rather not receive these/,
    "the email no longer offers an opt-out; this test's premise has changed");
  assert.match(SENDER, /\.is\("opted_out_at", null\)/,
    "the sender must still skip opted-out jobs");
});

test("there is a control that sets it", () => {
  assert.match(DASH, /id="j_opted_out"/, "no opt-out control on the job sheet");
  assert.match(DASH, /patch\.opted_out_at = box\.checked/,
    "the control must actually be sent on save");
});

test("unticking it clears the column, so somebody can be put back on the list", () => {
  // An opt-out that cannot be undone is a different kind of broken: a customer
  // who says "actually, do email me" could never be re-added.
  assert.match(DASH, /: null;/);
  const i = DASH.indexOf("patch.opted_out_at = box.checked");
  const branch = DASH.slice(i, i + 220);
  assert.match(branch, /\? \(openJob\.opted_out_at \|\| new Date\(\)\.toISOString\(\)\)/);
  assert.match(branch, /: null/);
});

test("saving an unrelated field does NOT rewrite the date they asked", () => {
  // The column is a timestamp, and WHEN somebody asked to stop being emailed is
  // worth keeping. Writing new Date() on every save would quietly reset it each
  // time the sheet was touched for any other reason -- the record would always
  // say "today".
  const i = DASH.indexOf("patch.opted_out_at = box.checked");
  const branch = DASH.slice(i, i + 220);
  assert.match(branch, /openJob\.opted_out_at \|\| new Date/,
    "an existing opt-out date must be kept, not replaced");
});

test("the sheet shows the state it is about to save", () => {
  // A checkbox that does not reflect the stored value is worse than none: it
  // would read as "not opted out" for someone who is, and the next save would
  // make that true.
  assert.match(DASH, /box\.checked = !!openJob\.opted_out_at/);
  assert.match(DASH, /jobOptedOutSince/, "it should say when they asked");
});

test("the column is actually selected, or the checkbox reads undefined", () => {
  // A column that is read without being SELECTED is undefined on every row --
  // the exact bug that made the Blocked job filter match nothing for months.
  assert.match(DASH, /'opted_out_at'/,
    "opted_out_at must be in JOB_COLUMNS or openJob.opted_out_at is always undefined");
});

test("the label exists in all three languages", () => {
  // A data-t naming a key that does not exist renders the element BLANK, which
  // has shipped on this page twice.
  for (const key of ["jobOptedOut:", "jobOptedOutSince:"]) {
    const n = DASH.split(key).length - 1;
    assert.equal(n, 3, `${key} appears ${n} times, expected one per language table`);
  }
  assert.match(DASH, /data-t="jobOptedOut"/);
});
