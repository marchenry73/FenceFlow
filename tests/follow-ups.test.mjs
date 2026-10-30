// Pure-logic tests for sales follow-up automation. Imports only
// supabase/functions/_shared/follow-up-logic.ts -- no Deno, no network, no
// live Supabase project, and NO real email is ever sent by this file.
//
// Run with:  node --test tests/follow-ups.test.mjs
// (Node 24 strips the .ts file's type annotations natively; the module
// itself is plain, erasable-syntax TypeScript for exactly this reason --
// same convention as _shared/invite-crew-email.ts / quote-deposit.ts.)
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  dueFollowUp,
  isQuietHour,
  approximateUtcOffsetHours,
  underDailyCap,
  FOLLOW_UP_KINDS,
  REVIEW_MAX_AGE_DAYS,
} from "../supabase/functions/_shared/follow-up-logic.ts";

const NOW = new Date("2026-09-17T18:00:00Z"); // 18:00 UTC = 14:00 America/New_York (offset -4)
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const daysAgo = (d) => hoursAgo(d * 24);

const settings = (overrides = {}) => ({ ...DEFAULT_SETTINGS, enabled: true, ...overrides });

const baseJob = (overrides = {}) => ({
  sync_id: "job-1",
  status: "SENT",
  customer_name: "Pat Homeowner",
  email: "pat@example.com",
  is_test_fixture: false,
  deleted_at: null,
  opted_out_at: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// due / not-due timing
// ---------------------------------------------------------------------------

test("quote_sent_no_view fires once the delay has elapsed", () => {
  const s = settings({ quote_sent_no_view_enabled: true, quote_sent_no_view_days: 2 });
  const job = baseJob({ quote_sent_at: daysAgo(3) });
  const due = dueFollowUp(job, s, NOW);
  assert.equal(due?.kind, "quote_sent_no_view");
});

test("quote_sent_no_view does NOT fire before the delay has elapsed", () => {
  const s = settings({ quote_sent_no_view_enabled: true, quote_sent_no_view_days: 2 });
  const job = baseJob({ quote_sent_at: daysAgo(1) });
  assert.equal(dueFollowUp(job, s, NOW), null);
});

test("quote_sent_no_view does not fire once the quote has been viewed", () => {
  const s = settings({ quote_sent_no_view_enabled: true, quote_sent_no_view_days: 2 });
  const job = baseJob({ quote_sent_at: daysAgo(5), quote_viewed_at: daysAgo(1) });
  // viewed-not-approved is off, so nothing should fire at all
  assert.equal(dueFollowUp(job, s, NOW), null);
});

test("quote_viewed_not_approved fires after its own delay, distinct from quote_sent_no_view", () => {
  const s = settings({
    quote_sent_no_view_enabled: true, quote_sent_no_view_days: 2,
    quote_viewed_not_approved_enabled: true, quote_viewed_not_approved_days: 3,
  });
  const job = baseJob({ quote_sent_at: daysAgo(10), quote_viewed_at: daysAgo(4) });
  const due = dueFollowUp(job, s, NOW);
  assert.equal(due?.kind, "quote_viewed_not_approved");
});

test("approved_no_deposit fires only once deposit is owed and unpaid past the delay", () => {
  const s = settings({ approved_no_deposit_enabled: true, approved_no_deposit_days: 2 });
  const job = baseJob({ quote_approved_at: daysAgo(3), deposit_amount: 500, amount_paid: 0 });
  assert.equal(dueFollowUp(job, s, NOW)?.kind, "approved_no_deposit");
});

test("approved_no_deposit does not fire once the deposit is paid", () => {
  const s = settings({ approved_no_deposit_enabled: true, approved_no_deposit_days: 2 });
  const job = baseJob({ quote_approved_at: daysAgo(3), deposit_amount: 500, amount_paid: 500 });
  assert.equal(dueFollowUp(job, s, NOW), null);
});

test("new_lead_not_contacted fires after the hour threshold, not before", () => {
  const s = settings({ new_lead_not_contacted_enabled: true, new_lead_not_contacted_hours: 4 });
  const notYet = baseJob({ status: "DRAFT", created_at: hoursAgo(2) });
  const due = baseJob({ status: "DRAFT", created_at: hoursAgo(5) });
  assert.equal(dueFollowUp(notYet, s, NOW), null);
  assert.equal(dueFollowUp(due, s, NOW)?.kind, "new_lead_not_contacted");
});

test("later-stage condition takes priority over an earlier one that also technically matches", () => {
  const s = settings({
    quote_sent_no_view_enabled: true, quote_sent_no_view_days: 2,
    approved_no_deposit_enabled: true, approved_no_deposit_days: 2,
  });
  // Sent long ago AND approved long ago with no deposit -- should fire the
  // deposit nudge, not resurrect a stale "quote sent, never viewed" nudge.
  const job = baseJob({
    quote_sent_at: daysAgo(20), quote_approved_at: daysAgo(5),
    deposit_amount: 500, amount_paid: 0,
  });
  assert.equal(dueFollowUp(job, s, NOW)?.kind, "approved_no_deposit");
});

// ---------------------------------------------------------------------------
// no-double-send (the log's uniqueness key)
// ---------------------------------------------------------------------------

test("dueFollowUp returns a stable stageKey so a second identical evaluation matches the log's unique key", () => {
  const s = settings({ quote_sent_no_view_enabled: true, quote_sent_no_view_days: 2 });
  const sentAt = daysAgo(3);
  const job = baseJob({ quote_sent_at: sentAt });
  const first = dueFollowUp(job, s, NOW);
  const second = dueFollowUp(job, s, new Date(NOW.getTime() + 3_600_000)); // an hour later, same run cadence
  assert.equal(first.stageKey, sentAt);
  assert.equal(first.stageKey, second.stageKey);
});

test("a later, distinct occurrence (re-sent quote) produces a different stageKey", () => {
  const s = settings({ quote_sent_no_view_enabled: true, quote_sent_no_view_days: 2 });
  const first = dueFollowUp(baseJob({ quote_sent_at: daysAgo(5) }), s, NOW);
  const second = dueFollowUp(baseJob({ quote_sent_at: daysAgo(3) }), s, NOW);
  assert.notEqual(first.stageKey, second.stageKey);
});

// ---------------------------------------------------------------------------
// opt-out
// ---------------------------------------------------------------------------

test("an opted-out job never has anything due, no matter how overdue", () => {
  const s = settings({
    quote_sent_no_view_enabled: true, quote_sent_no_view_days: 1,
    quote_viewed_not_approved_enabled: true, quote_viewed_not_approved_days: 1,
    approved_no_deposit_enabled: true, approved_no_deposit_days: 1,
    new_lead_not_contacted_enabled: true, new_lead_not_contacted_hours: 1,
  });
  const job = baseJob({
    opted_out_at: daysAgo(1),
    quote_sent_at: daysAgo(30), quote_approved_at: daysAgo(30),
    deposit_amount: 500, amount_paid: 0,
  });
  assert.equal(dueFollowUp(job, s, NOW), null);
});

// ---------------------------------------------------------------------------
// quiet hours
// ---------------------------------------------------------------------------

test("isQuietHour is true inside a same-day window", () => {
  // 18:00 UTC with offset -4 = 14:00 local; window 13-16 should be quiet
  assert.equal(isQuietHour(NOW, 13, 16, -4), true);
  assert.equal(isQuietHour(NOW, 15, 16, -4), false);
});

test("isQuietHour handles a window that wraps midnight", () => {
  // local hour 14:00 with a 21:00-08:00 quiet window should NOT be quiet
  assert.equal(isQuietHour(NOW, 21, 8, -4), false);
  // shift settings so local hour falls at 22:00 -> should be quiet
  const lateNow = new Date("2026-09-18T02:00:00Z"); // 22:00 local at offset -4
  assert.equal(isQuietHour(lateNow, 21, 8, -4), true);
});

test("approximateUtcOffsetHours has an entry for every timezone this app actually offers", () => {
  for (const tz of ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"]) {
    assert.equal(typeof approximateUtcOffsetHours(tz), "number");
  }
});

// ---------------------------------------------------------------------------
// daily cap
// ---------------------------------------------------------------------------

test("underDailyCap allows sends below the cap and refuses at/above it", () => {
  assert.equal(underDailyCap(0, 25), true);
  assert.equal(underDailyCap(24, 25), true);
  assert.equal(underDailyCap(25, 25), false);
  assert.equal(underDailyCap(26, 25), false);
});

// ---------------------------------------------------------------------------
// test-fixture exclusion
// ---------------------------------------------------------------------------

test("a test-fixture job never has anything due", () => {
  const s = settings({ quote_sent_no_view_enabled: true, quote_sent_no_view_days: 1 });
  const job = baseJob({ is_test_fixture: true, quote_sent_at: daysAgo(30) });
  assert.equal(dueFollowUp(job, s, NOW), null);
});

test("a soft-deleted job never has anything due", () => {
  const s = settings({ quote_sent_no_view_enabled: true, quote_sent_no_view_days: 1 });
  const job = baseJob({ deleted_at: daysAgo(1), quote_sent_at: daysAgo(30) });
  assert.equal(dueFollowUp(job, s, NOW), null);
});

// ---------------------------------------------------------------------------
// global off switch
// ---------------------------------------------------------------------------

test("settings.enabled=false silences every kind even if individually turned on", () => {
  const s = { ...DEFAULT_SETTINGS, enabled: false, quote_sent_no_view_enabled: true, quote_sent_no_view_days: 1 };
  const job = baseJob({ quote_sent_at: daysAgo(30) });
  assert.equal(dueFollowUp(job, s, NOW), null);
});

test("a job with no email never has anything due (nowhere to send it)", () => {
  const s = settings({ quote_sent_no_view_enabled: true, quote_sent_no_view_days: 1 });
  const job = baseJob({ email: "", quote_sent_at: daysAgo(30) });
  assert.equal(dueFollowUp(job, s, NOW), null);
});

// ---------------------------------------------------------------------------
// a150: THE REVIEW REQUEST after the job is done.
//
// "When the job is done, I want an automatic email to be sent in 2 or 3 days
//  afterwards." Every guard below exists because without it the feature
//  emails somebody it should not.
// ---------------------------------------------------------------------------

const reviewSettings = (overrides = {}) => settings({
  job_done_review_enabled: true,
  job_done_review_days: 3,
  review_url: "https://g.page/r/EXAMPLE/review",
  ...overrides,
});

const doneJob = (overrides = {}) => baseJob({
  status: "COMPLETED",
  completed_at: daysAgo(4),
  review_email_sent_at: null,
  cancelled_at: null,
  ...overrides,
});

test("a150 the review request fires once the wait has elapsed", () => {
  const due = dueFollowUp(doneJob(), reviewSettings(), NOW);
  assert.equal(due?.kind, "job_done_review");
  // The stage key is the completion, so the log row is unique per completion.
  assert.equal(due?.stageKey, doneJob().completed_at);
});

test("a150 nothing is due before the wait has elapsed", () => {
  const job = doneJob({ completed_at: daysAgo(2) });
  assert.equal(dueFollowUp(job, reviewSettings(), NOW), null);
});

test("a150 two days is honoured when that is what he set", () => {
  const job = doneJob({ completed_at: daysAgo(2) });
  const due = dueFollowUp(job, reviewSettings({ job_done_review_days: 2 }), NOW);
  assert.equal(due?.kind, "job_done_review");
});

test("a150 asked once, never again -- the stamp takes it out of the running", () => {
  const job = doneJob({ review_email_sent_at: daysAgo(1) });
  assert.equal(dueFollowUp(job, reviewSettings(), NOW), null);
});

test("a150 a job finished before the feature existed is never chased", () => {
  // r47 deliberately did not backfill completed_at. Null must mean "never",
  // not "epoch", or switching this on would have emailed every past customer.
  const job = doneJob({ completed_at: null });
  assert.equal(dueFollowUp(job, reviewSettings(), NOW), null);
});

test("a150 a cancelled job is never asked for a review", () => {
  // A job CAN be completed and then cancelled. Asking that customer to
  // review the company publicly is the worst possible automatic email.
  const job = doneJob({ cancelled_at: daysAgo(1) });
  assert.equal(dueFollowUp(job, reviewSettings(), NOW), null);
});

test("a150 no review link means no request -- not a letter with a dead button", () => {
  assert.equal(dueFollowUp(doneJob(), reviewSettings({ review_url: "" }), NOW), null);
  assert.equal(dueFollowUp(doneJob(), reviewSettings({ review_url: "   " }), NOW), null);
});

test("a150 off by default: a company that never asked for this sends nothing", () => {
  assert.equal(DEFAULT_SETTINGS.job_done_review_enabled, false);
  const s = settings({ review_url: "https://g.page/r/EXAMPLE/review" });
  assert.equal(dueFollowUp(doneJob(), s, NOW), null);
});

test("a150 a long-finished job is not chased when the switch is first turned on", () => {
  // THE BLAST GUARD. Without the age window, the night he enables this every
  // job completed since r47 shipped would be eligible at once.
  const old = doneJob({ completed_at: daysAgo(45) });
  assert.equal(dueFollowUp(old, reviewSettings(), NOW), null);
  // ...but one inside the window still goes.
  const recent = doneJob({ completed_at: daysAgo(20) });
  assert.equal(dueFollowUp(recent, reviewSettings(), NOW)?.kind, "job_done_review");
});

test("a150 the review wins over the deposit nudge on a finished job, once", () => {
  // Completion is the furthest-along state, so it is checked first. The
  // review is sent once; after that the money nudge resumes -- it must not
  // be lost, only deferred by a run.
  const s = reviewSettings({ approved_no_deposit_enabled: true, approved_no_deposit_days: 2 });
  const job = doneJob({
    quote_approved_at: daysAgo(10),
    deposit_amount: 500,
    amount_paid: 0,
  });
  assert.equal(dueFollowUp(job, s, NOW)?.kind, "job_done_review");

  const afterSending = { ...job, review_email_sent_at: daysAgo(0) };
  assert.equal(dueFollowUp(afterSending, s, NOW)?.kind, "approved_no_deposit");
});

test("a150 opting out silences the review request too", () => {
  const job = doneJob({ opted_out_at: daysAgo(1) });
  assert.equal(dueFollowUp(job, reviewSettings(), NOW), null);
});

// ---------------------------------------------------------------------------
// a151: THE OFFICE MIRROR MUST AGREE WITH THE SENDER.
//
// website/js/lib/follow-ups.mjs is a hand-written copy of the rules, used by
// the office's "What would send right now" preview. Nothing until now
// compared them, so the day one gained a rule the other did not, the office
// would quietly describe a different system from the one sending the email --
// and the direction that bites is the reassuring one: a preview that shows
// nothing due on the night five emails go out.
// ---------------------------------------------------------------------------
import * as office from "../website/js/lib/follow-ups.mjs";

test("a151 both copies of the rules know the same kinds", () => {
  assert.deepEqual(office.FOLLOW_UP_KINDS, FOLLOW_UP_KINDS);
  assert.equal(office.REVIEW_MAX_AGE_DAYS, REVIEW_MAX_AGE_DAYS);
  // Every setting the sender reads must exist in the office's defaults too,
  // or the preview computes with `undefined` and silently answers "not due".
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    assert.ok(k in office.DEFAULT_SETTINGS, `office defaults are missing ${k}`);
  }
});

test("a151 both copies decide every case identically", () => {
  const allOn = settings({
    new_lead_not_contacted_enabled: true,
    quote_sent_no_view_enabled: true,
    quote_viewed_not_approved_enabled: true,
    approved_no_deposit_enabled: true,
    job_done_review_enabled: true,
    review_url: "https://g.page/r/EXAMPLE/review",
  });

  const cases = [
    ["fresh lead", baseJob({ status: "DRAFT", created_at: hoursAgo(9) })],
    ["sent, unseen", baseJob({ quote_sent_at: daysAgo(4) })],
    ["seen, unapproved", baseJob({ quote_viewed_at: daysAgo(5) })],
    ["approved, unpaid", baseJob({ quote_approved_at: daysAgo(6), deposit_amount: 400, amount_paid: 0 })],
    ["done, review due", doneJob()],
    ["done, too soon", doneJob({ completed_at: daysAgo(1) })],
    ["done, already asked", doneJob({ review_email_sent_at: daysAgo(1) })],
    ["done then cancelled", doneJob({ cancelled_at: daysAgo(1) })],
    ["done long ago", doneJob({ completed_at: daysAgo(90) })],
    ["done AND owing a deposit", doneJob({
      quote_approved_at: daysAgo(9), deposit_amount: 400, amount_paid: 0,
    })],
    ["opted out", doneJob({ opted_out_at: daysAgo(1) })],
    ["no email", doneJob({ email: "" })],
  ];

  let agreedOnSomething = false;
  for (const [what, job] of cases) {
    const mine = dueFollowUp(job, allOn, NOW);
    const theirs = office.dueFollowUp(job, allOn, NOW);
    assert.equal(theirs?.kind ?? null, mine?.kind ?? null, `disagreed on: ${what}`);
    assert.equal(theirs?.stageKey ?? null, mine?.stageKey ?? null, `stage key differs on: ${what}`);
    if (mine) agreedOnSomething = true;
  }

  // THE CANARY. Without it, two implementations that both returned null for
  // everything -- a broken import, a settings key renamed on both sides --
  // would pass every assertion above and prove nothing at all.
  assert.ok(agreedOnSomething, "no case produced a follow-up, so agreement is meaningless");
});
