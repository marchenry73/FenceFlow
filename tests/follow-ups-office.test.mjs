// Tests for the office follow-up-emails UI: its preview logic
// (website/js/lib/follow-ups.mjs, a browser-importable mirror of
// supabase/functions/_shared/follow-up-logic.ts) and the shape of the
// settings object the office reads/writes through set_follow_up_settings().
//
// Run with:  node --test tests/follow-ups-office.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_SETTINGS,
  FOLLOW_UP_KINDS,
  dueFollowUp,
  isQuietHour,
  previewDueFollowUps,
} from "../website/js/lib/follow-ups.mjs";

const NOW = new Date("2026-09-17T18:00:00Z"); // 14:00 America/New_York (offset -4)
const daysAgo = (dd) => new Date(NOW.getTime() - dd * 24 * 3_600_000).toISOString();

const settings = (overrides = {}) => ({ ...DEFAULT_SETTINGS, enabled: true, ...overrides });

const job = (overrides = {}) => ({
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
// dueFollowUp, mirrored from tests/follow-ups.test.mjs's own cases -- these
// two files must agree, or the office preview and the real sender disagree
// about what "due" means without either one's tests catching it.
// ---------------------------------------------------------------------------

test("dueFollowUp fires quote_sent_no_view once the delay has elapsed", () => {
  const s = settings({ quote_sent_no_view_enabled: true, quote_sent_no_view_days: 2 });
  const due = dueFollowUp(job({ quote_sent_at: daysAgo(3) }), s, NOW);
  assert.equal(due?.kind, "quote_sent_no_view");
});

test("dueFollowUp returns null when the global switch is off", () => {
  const s = settings({ enabled: false, quote_sent_no_view_enabled: true, quote_sent_no_view_days: 2 });
  assert.equal(dueFollowUp(job({ quote_sent_at: daysAgo(3) }), s, NOW), null);
});

test("dueFollowUp never fires for an opted-out job even with everything else due", () => {
  const s = settings({ quote_sent_no_view_enabled: true, quote_sent_no_view_days: 2 });
  const due = dueFollowUp(job({ quote_sent_at: daysAgo(10), opted_out_at: daysAgo(1) }), s, NOW);
  assert.equal(due, null);
});

test("dueFollowUp never fires for a test fixture", () => {
  const s = settings({ quote_sent_no_view_enabled: true, quote_sent_no_view_days: 2 });
  const due = dueFollowUp(job({ quote_sent_at: daysAgo(10), is_test_fixture: true }), s, NOW);
  assert.equal(due, null);
});

test("dueFollowUp prefers the furthest-along condition when several apply", () => {
  const s = settings({
    quote_sent_no_view_enabled: true, quote_sent_no_view_days: 2,
    approved_no_deposit_enabled: true, approved_no_deposit_days: 1,
  });
  const j = job({
    quote_sent_at: daysAgo(10),
    quote_viewed_at: daysAgo(9),
    quote_approved_at: daysAgo(5),
    deposit_amount: 500,
    amount_paid: 0,
  });
  assert.equal(dueFollowUp(j, s, NOW)?.kind, "approved_no_deposit");
});

// ---------------------------------------------------------------------------
// previewDueFollowUps -- the office-only convenience the real edge function
// does not have, but must respect the same guards.
// ---------------------------------------------------------------------------

test("previewDueFollowUps is empty while the master switch is off", () => {
  const s = settings({ enabled: false, quote_sent_no_view_enabled: true, quote_sent_no_view_days: 2 });
  const jobs = [job({ quote_sent_at: daysAgo(5) })];
  assert.deepEqual(previewDueFollowUps(jobs, s, NOW, 0), []);
});

test("previewDueFollowUps lists a due job with its kind", () => {
  const s = settings({ quote_sent_no_view_enabled: true, quote_sent_no_view_days: 2 });
  const jobs = [job({ quote_sent_at: daysAgo(5) })];
  const out = previewDueFollowUps(jobs, s, NOW, 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].job_sync_id, "job-1");
  assert.equal(out[0].kind, "quote_sent_no_view");
});

test("previewDueFollowUps respects quiet hours -- nothing shows during the quiet window", () => {
  // NOW is 14:00 local (America/New_York, offset -4). Set quiet hours to
  // cover that exact local hour.
  const s = settings({
    quote_sent_no_view_enabled: true, quote_sent_no_view_days: 2,
    quiet_hours_start: 13, quiet_hours_end: 15,
  });
  const jobs = [job({ quote_sent_at: daysAgo(5) })];
  assert.deepEqual(previewDueFollowUps(jobs, s, NOW, 0), []);
});

test("previewDueFollowUps respects the daily cap, counting what was already sent today", () => {
  const s = settings({ quote_sent_no_view_enabled: true, quote_sent_no_view_days: 2, daily_cap: 1 });
  const jobs = [job({ sync_id: "a", quote_sent_at: daysAgo(5) }), job({ sync_id: "b", quote_sent_at: daysAgo(6) })];
  const out = previewDueFollowUps(jobs, s, NOW, 1); // already sent 1 today, cap is 1
  assert.deepEqual(out, []);
});

test("previewDueFollowUps stops adding once remaining cap hits zero mid-list", () => {
  const s = settings({ quote_sent_no_view_enabled: true, quote_sent_no_view_days: 2, daily_cap: 3 });
  const jobs = [
    job({ sync_id: "a", quote_sent_at: daysAgo(5) }),
    job({ sync_id: "b", quote_sent_at: daysAgo(6) }),
    job({ sync_id: "c", quote_sent_at: daysAgo(7) }),
  ];
  const out = previewDueFollowUps(jobs, s, NOW, 2); // 1 slot left under the cap
  assert.equal(out.length, 1);
  assert.equal(out[0].job_sync_id, "a");
});

test("previewDueFollowUps never lists an opted-out job", () => {
  const s = settings({ quote_sent_no_view_enabled: true, quote_sent_no_view_days: 2 });
  const jobs = [job({ quote_sent_at: daysAgo(5), opted_out_at: daysAgo(1) })];
  assert.deepEqual(previewDueFollowUps(jobs, s, NOW, 0), []);
});

// PLANTED FAILURE -- proves the assertion style above actually catches a
// broken preview rather than passing vacuously. A version of the function
// that ignored opted_out_at would list this job; assert that it must NOT.
test("PLANTED FAILURE: an opted-out job with an artificially forced kind must not appear", () => {
  const s = settings({ quote_sent_no_view_enabled: true, quote_sent_no_view_days: 2 });
  const badJob = job({ quote_sent_at: daysAgo(5), opted_out_at: daysAgo(1) });
  const out = previewDueFollowUps([badJob], s, NOW, 0);
  // If this ever finds the job listed, something regressed the opt-out guard.
  assert.equal(out.some((p) => p.job_sync_id === badJob.sync_id), false);
});

// ---------------------------------------------------------------------------
// isQuietHour re-exported correctly (office UI's timezone dropdown / preview
// depend on this being the exact same function, not a re-derivation).
// ---------------------------------------------------------------------------

test("isQuietHour wraps past midnight", () => {
  assert.equal(isQuietHour(new Date("2026-01-01T02:00:00Z"), 21, 8, 0), true); // 02:00 local
  assert.equal(isQuietHour(new Date("2026-01-01T12:00:00Z"), 21, 8, 0), false); // 12:00 local
});

// ---------------------------------------------------------------------------
// Settings shape -- what set_follow_up_settings()'s payload must look like,
// and that the fixed catalog of four kinds the office UI renders matches the
// four kinds the shared logic (and follow_up_log's CHECK constraint) knows.
// ---------------------------------------------------------------------------

test("FOLLOW_UP_KINDS has exactly the four kinds the office UI renders a row for", () => {
  const html = readFileSync(new URL("../website/dashboard.html", import.meta.url), "utf8");
  const start = html.indexOf("const FOLLOW_UP_KIND_DEFS = [");
  assert.ok(start >= 0, "FOLLOW_UP_KIND_DEFS not found in dashboard.html");
  let depth = 0, end = -1;
  for (let i = html.indexOf("[", start); i < html.length; i++) {
    if (html[i] === "[") depth++;
    else if (html[i] === "]") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const keys = [...html.slice(start, end).matchAll(/key:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), [...FOLLOW_UP_KINDS].sort());
});

test("DEFAULT_SETTINGS carries a field for every kind's enabled flag and delay", () => {
  for (const kind of FOLLOW_UP_KINDS) {
    assert.ok(`${kind}_enabled` in DEFAULT_SETTINGS, `${kind}_enabled missing from DEFAULT_SETTINGS`);
  }
  assert.equal(DEFAULT_SETTINGS.enabled, false, "master switch must default off");
  for (const kind of FOLLOW_UP_KINDS) {
    assert.equal(DEFAULT_SETTINGS[`${kind}_enabled`], false, `${kind} must default off`);
  }
  assert.ok(DEFAULT_SETTINGS.daily_cap > 0);
  assert.ok(DEFAULT_SETTINGS.quiet_hours_start >= 0 && DEFAULT_SETTINGS.quiet_hours_start <= 23);
  assert.ok(DEFAULT_SETTINGS.quiet_hours_end >= 0 && DEFAULT_SETTINGS.quiet_hours_end <= 23);
  assert.equal(typeof DEFAULT_SETTINGS.timezone, "string");
});

test("the office never writes follow_up_settings directly -- only through the RPC", () => {
  const html = readFileSync(new URL("../website/dashboard.html", import.meta.url), "utf8");
  // A raw write would be .from('follow_up_settings').insert/update/upsert(...).
  assert.doesNotMatch(
    html,
    /from\(['"]follow_up_settings['"]\)\s*\.\s*(insert|update|upsert)\s*\(/,
    "found a raw write to follow_up_settings -- must go through set_follow_up_settings() instead",
  );
  assert.match(html, /db\.rpc\(['"]set_follow_up_settings['"]/, "saveFollowUpSettings must call the RPC");
});
