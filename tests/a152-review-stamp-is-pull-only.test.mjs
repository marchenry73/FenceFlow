// a152: THE PHONE READS THE REVIEW STAMP AND NEVER WRITES IT.
//
// completed_at is stamped by a database trigger wherever a job's status
// becomes COMPLETED (r47); review_email_sent_at is written by
// send-follow-ups at the moment the review email leaves (r48, which also
// keeps that write out of jobs.updated_at).
//
// If toCloud() ever starts sending either of them, two things break at once
// and both are silent:
//
//   1. A handset that was offline while the server stamped the review would
//      push its own stale null back over it -- and dueFollowUp() reads that
//      column as "has this customer been asked yet". The same customer gets
//      asked a second time, which is the one outcome a review request must
//      never produce.
//   2. A job completed on another device would be un-completed by this one,
//      moving the clock the review request counts from.
//
// Checked against the SOURCE because there is no way to assert it from the
// outside: a push that includes the field looks identical to one that does
// not until the day the stamps disagree.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync("app/src/main/java/com/fenceestimator/app/cloud/JobSync.kt", "utf8");

/** The body of `private fun Job.toCloud(...) = CloudJob( ... )`, by brace
 *  depth rather than by a line number, so moving the function does not
 *  silently empty this test. */
function toCloudBody(src) {
  const start = src.indexOf("private fun Job.toCloud(");
  assert.notEqual(start, -1, "Job.toCloud is gone or renamed -- this test is checking nothing");
  const open = src.indexOf("= CloudJob(", start);
  assert.notEqual(open, -1, "Job.toCloud no longer builds a CloudJob -- re-aim this test");
  let i = src.indexOf("(", open + "= CloudJob".length), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.notEqual(end, -1, "unbalanced parentheses in Job.toCloud");
  return src.slice(open, end + 1);
}

test("a152 the push does not carry the completion or review stamps", () => {
  const body = toCloudBody(SRC);

  // THE CANARY FIRST. If this slice were empty or the wrong region, every
  // assertion below would pass by finding nothing -- so require a field the
  // push certainly does send.
  assert.match(body, /syncId\s*=\s*syncId/,
    "the slice taken is not the real toCloud body, so the checks below prove nothing");
  assert.ok(body.length > 500, `toCloud body came out suspiciously short (${body.length} chars)`);

  for (const field of ["completedAt", "reviewEmailSentAt"]) {
    assert.ok(
      !new RegExp(`\\b${field}\\s*=`).test(body),
      `toCloud() now pushes ${field}. It is the server's to write: see the ` +
      `header of this test for the two failures that causes.`,
    );
  }
});

test("a152 but the phone does read both of them down", () => {
  // The other half: pull-only means pull, not ignore. A build that dropped
  // the mapping would show "no review sent" for ever on a job that had one,
  // and the marker on the job screen is the whole point of the column.
  assert.match(SRC, /@SerialName\("completed_at"\)/,
    "the cloud row no longer reads completed_at");
  assert.match(SRC, /@SerialName\("review_email_sent_at"\)/,
    "the cloud row no longer reads review_email_sent_at");
  assert.match(SRC, /completedAt\s*=\s*CloudTime\.parseMillis\(completedAt\)/,
    "completed_at is declared but never mapped onto the local job");
  assert.match(SRC, /reviewEmailSentAt\s*=\s*CloudTime\.parseMillis\(reviewEmailSentAt\)/,
    "review_email_sent_at is declared but never mapped onto the local job");
});

test("a152 the office asks for both columns, or the row arrives blank", () => {
  // A column the select does not name comes back undefined, which the merge
  // reads as "the cloud does not know", so the stamp would never reach the
  // phone however correct the mapping is.
  const office = readFileSync("website/dashboard.html", "utf8");
  for (const col of ["completed_at", "review_email_sent_at"]) {
    assert.ok(office.includes(`'${col}'`) || office.includes(`"${col}"`),
      `the office never asks for ${col}`);
  }
});
