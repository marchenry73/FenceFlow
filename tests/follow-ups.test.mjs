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
