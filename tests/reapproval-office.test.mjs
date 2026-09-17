// Pure-logic tests for the office half of the reapproval rule
// (docs/REAPPROVAL_RULE.md, section "1. Office -- website/dashboard.html").
//
// Two small pieces of real logic sit inside the needs_reapproval detector in
// dashboard.html's renderDash(): the jobs are sorted oldest-first by
// reapproval_required_at, and the "days waiting" figure in the alert text is
// computed from that same timestamp. Both are reimplemented here as
// standalone pure functions (no DOM, no Supabase) so they can be checked
// without loading the page, mirroring the shape of the detector:
//
//   jobs.filter(j => j.reapproval_required_at)
//     .sort((a,b) => d(a.reapproval_required_at) - d(b.reapproval_required_at))
//     ... days = Math.floor((nowMs - d(j.reapproval_required_at).getTime()) / 864e5)
//
// A change to the real detector that silently drops the sort, or that swaps
// which timestamp the day-count reads from, would not be caught by any other
// test in this repo -- job-columns only checks the column is selected at
// all, not that it is used correctly.
import { test } from "node:test";
import assert from "node:assert/strict";

function jobsNeedingReapproval(jobs) {
  return jobs
    .filter((j) => j.reapproval_required_at)
    .sort((a, b) => new Date(a.reapproval_required_at) - new Date(b.reapproval_required_at));
}

function daysWaitingForReapproval(job, nowMs) {
  return Math.floor((nowMs - new Date(job.reapproval_required_at).getTime()) / 864e5);
}

test("jobs needing reapproval are sorted oldest-first", () => {
  const jobs = [
    { id: 1, reapproval_required_at: "2026-09-15T00:00:00Z" },
    { id: 2, reapproval_required_at: "2026-09-10T00:00:00Z" },
    { id: 3, reapproval_required_at: null }, // not flagged, must be excluded
    { id: 4, reapproval_required_at: "2026-09-12T00:00:00Z" },
  ];
  const out = jobsNeedingReapproval(jobs).map((j) => j.id);
  assert.deepEqual(out, [2, 4, 1]);
});

test("a job whose approval was never withdrawn never appears", () => {
  const jobs = [
    { id: 1, reapproval_required_at: null },
    { id: 2 }, // column simply absent/undefined, same as null
  ];
  assert.deepEqual(jobsNeedingReapproval(jobs), []);
});

test("days waiting is computed from reapproval_required_at, not from today naively", () => {
  const now = new Date("2026-09-17T12:00:00Z").getTime();
  const job = { reapproval_required_at: "2026-09-10T00:00:00Z" };
  assert.equal(daysWaitingForReapproval(job, now), 7);
});

test("PLANTED FAILURE: sorting by the wrong field (e.g. quote_sent_at) breaks the order", () => {
  // Proves the sort test above has teeth: re-run it with a detector that
  // mistakenly sorts by quote_sent_at (a plausible copy-paste from the
  // stale_quote alert just above it in the real file) instead of
  // reapproval_required_at, and confirm the assertion catches it.
  const wrongSort = (jobs) =>
    jobs
      .filter((j) => j.reapproval_required_at)
      .sort((a, b) => new Date(a.quote_sent_at) - new Date(b.quote_sent_at));

  const jobs = [
    { id: 1, reapproval_required_at: "2026-09-15T00:00:00Z", quote_sent_at: "2026-01-01T00:00:00Z" },
    { id: 2, reapproval_required_at: "2026-09-10T00:00:00Z", quote_sent_at: "2026-06-01T00:00:00Z" },
  ];
  const out = wrongSort(jobs).map((j) => j.id);
  assert.notDeepEqual(out, jobsNeedingReapproval(jobs).map((j) => j.id));
});
