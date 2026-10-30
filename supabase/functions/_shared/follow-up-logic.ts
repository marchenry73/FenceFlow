/**
 * Pure decision logic for sales follow-up automation. Touches nothing
 * Deno-only (no Deno.serve, no Deno.env, no fetch, no clock of its own --
 * every function here takes "now" as a parameter) so tests/follow-ups.test.mjs
 * can import it under plain Node, the same reason invite-crew-email.ts is
 * split out of invite-crew/index.ts.
 *
 * send-follow-ups/index.ts is the impure half: it fetches rows, calls these
 * functions to decide, and does the actual DB writes / Resend calls.
 */

export type FollowUpKind =
  | "new_lead_not_contacted"
  | "quote_sent_no_view"
  | "quote_viewed_not_approved"
  | "approved_no_deposit"
  | "job_done_review";

export const FOLLOW_UP_KINDS: FollowUpKind[] = [
  "new_lead_not_contacted",
  "quote_sent_no_view",
  "quote_viewed_not_approved",
  "approved_no_deposit",
  "job_done_review",
];

/**
 * How long after completion a review request may still go out.
 *
 * NOT a preference -- a blast guard. The setting is off by default, so the
 * day it is switched on, every job finished since r47 shipped would be
 * eligible at once and the night's run would ask all of them (up to the
 * daily cap, then the rest tomorrow). A review request three weeks late is
 * worth little anyway; one that arrives for a fence built four months ago
 * reads as a mistake. Jobs older than this are never chased.
 */
export const REVIEW_MAX_AGE_DAYS = 30;

export interface FollowUpSettings {
  enabled: boolean;
  new_lead_not_contacted_enabled: boolean;
  quote_sent_no_view_enabled: boolean;
  quote_viewed_not_approved_enabled: boolean;
  approved_no_deposit_enabled: boolean;
  job_done_review_enabled: boolean;
  new_lead_not_contacted_hours: number;
  quote_sent_no_view_days: number;
  quote_viewed_not_approved_days: number;
  approved_no_deposit_days: number;
  job_done_review_days: number;
  /** Where the review is left. Blank means no request can be sent. */
  review_url: string;
  quiet_hours_start: number; // 0-23, local
  quiet_hours_end: number; // 0-23, local
  timezone: string;
  daily_cap: number;
}

export const DEFAULT_SETTINGS: FollowUpSettings = {
  enabled: false,
  new_lead_not_contacted_enabled: false,
  quote_sent_no_view_enabled: false,
  quote_viewed_not_approved_enabled: false,
  approved_no_deposit_enabled: false,
  job_done_review_enabled: false,
  new_lead_not_contacted_hours: 4,
  quote_sent_no_view_days: 2,
  quote_viewed_not_approved_days: 3,
  approved_no_deposit_days: 2,
  job_done_review_days: 3,
  review_url: "",
  quiet_hours_start: 21,
  quiet_hours_end: 8,
  timezone: "America/New_York",
  daily_cap: 25,
};

/** The subset of a `jobs` row this module needs to decide anything. */
export interface FollowUpJob {
  sync_id: string;
  status: string;
  customer_name?: string | null;
  email?: string | null;
  first_contact_at?: string | null;
  quote_sent_at?: string | null;
  quote_viewed_at?: string | null;
  quote_approved_at?: string | null;
  deposit_amount?: number | null;
  amount_paid?: number | null;
  opted_out_at?: string | null;
  is_test_fixture?: boolean | null;
  deleted_at?: string | null;
  quote_token?: string | null;
  /** When the status first became COMPLETED (r47's trigger). Null on every
   *  job finished before that shipped -- deliberately not backfilled. */
  completed_at?: string | null;
  /** When the review request went out. The marker on the job screen. */
  review_email_sent_at?: string | null;
  /** A cancelled job is not a job to ask for a review about. */
  cancelled_at?: string | null;
}

export interface DueFollowUp {
  kind: FollowUpKind;
  /** Folds into follow_up_log's uniqueness so a job re-entering the same
   *  condition later (re-quoted, re-approved) is a new occurrence rather
   *  than blocked forever by the first send. Built from the timestamp that
   *  started this occurrence's clock. */
  stageKey: string;
}

const hoursSince = (iso: string, now: Date): number =>
  (now.getTime() - new Date(iso).getTime()) / 3_600_000;
const daysSince = (iso: string, now: Date): number => hoursSince(iso, now) / 24;

/**
 * Which (if any) follow-up kind is due for this job right now, given the
 * company's settings. Returns null when nothing is due -- including when
 * the job is opted out, a test fixture, soft-deleted, or the global switch
 * is off. Quiet hours and the daily cap are NOT checked here (they are
 * cross-job / cross-time concerns); see isQuietHour() and the cap check in
 * the caller.
 */
export function dueFollowUp(job: FollowUpJob, settings: FollowUpSettings, now: Date): DueFollowUp | null {
  if (!settings.enabled) return null;
  if (job.deleted_at) return null;
  if (job.is_test_fixture) return null;
  if (job.opted_out_at) return null;
  if (!job.email) return null;

  // Order matters: a job is checked against exactly one condition, the
  // furthest-along one that applies, so a quote that has been both sent
  // and approved-without-deposit only ever gets the deposit nudge, not
  // also a stale "quote sent" nudge for a quote that is no longer pending.

  /* THE WORK IS FINISHED: ask for a review.
     First, because completion is the furthest-along state there is. A
     finished job that still shows an unpaid deposit therefore gets this
     instead of the deposit nudge -- for one run only: the review is sent
     once and then review_email_sent_at takes it out of the running, so the
     money nudge resumes the next night. Reversing the two would be worse,
     because the deposit nudge repeats forever and would postpone the review
     indefinitely.
     Three separate reasons this returns null, each of which has to be here:
       - review_url blank: there is nothing to ask the customer to click, so
         the letter would have a dead button. Checked here rather than left
         to the sender, so the log row is never claimed for a send that
         cannot happen.
       - review_email_sent_at set: asked once already. The follow_up_log row
         also blocks a resend for this stage_key, but this guard survives a
         log cleanup and is what the job screen reads.
       - cancelled_at set: a job can be completed and then cancelled. Asking
         that customer to review us publicly is the last thing to do. */
  if (
    settings.job_done_review_enabled &&
    (settings.review_url || "").trim() !== "" &&
    job.completed_at &&
    !job.review_email_sent_at &&
    !job.cancelled_at &&
    daysSince(job.completed_at, now) >= settings.job_done_review_days &&
    daysSince(job.completed_at, now) <= REVIEW_MAX_AGE_DAYS
  ) {
    return { kind: "job_done_review", stageKey: job.completed_at };
  }

  if (
    settings.approved_no_deposit_enabled &&
    job.quote_approved_at &&
    (job.deposit_amount ?? 0) > 0.005 &&
    (job.amount_paid ?? 0) < 0.005 &&
    daysSince(job.quote_approved_at, now) >= settings.approved_no_deposit_days
  ) {
    return { kind: "approved_no_deposit", stageKey: job.quote_approved_at };
  }

  if (
    settings.quote_viewed_not_approved_enabled &&
    job.quote_viewed_at &&
    !job.quote_approved_at &&
    daysSince(job.quote_viewed_at, now) >= settings.quote_viewed_not_approved_days
  ) {
    return { kind: "quote_viewed_not_approved", stageKey: job.quote_viewed_at };
  }

  if (
    settings.quote_sent_no_view_enabled &&
    job.quote_sent_at &&
    !job.quote_viewed_at &&
    !job.quote_approved_at &&
    daysSince(job.quote_sent_at, now) >= settings.quote_sent_no_view_days
  ) {
    return { kind: "quote_sent_no_view", stageKey: job.quote_sent_at };
  }

  // first_contact_at absent is the actual signal; created_at (kept optional
  // on FollowUpJob so the other three kinds don't need to supply it) is
  // what measures "how long has this sat uncontacted".
  const createdAt = (job as any).created_at as string | undefined;
  if (
    settings.new_lead_not_contacted_enabled &&
    (job.status === "DRAFT" || job.status === "SENT") &&
    !job.first_contact_at &&
    createdAt &&
    hoursSince(createdAt, now) >= settings.new_lead_not_contacted_hours
  ) {
    return { kind: "new_lead_not_contacted", stageKey: createdAt };
  }

  return null;
}

/**
 * True when `now`, interpreted in `timezoneOffsetHours` (a fixed UTC offset
 * standing in for the company's timezone -- see the caller for why a full
 * IANA conversion is not done here), falls inside [start, end). Handles the
 * wrap-past-midnight case (start=21, end=8).
 */
export function isQuietHour(
  now: Date,
  quietStart: number,
  quietEnd: number,
  timezoneOffsetHours: number,
): boolean {
  const localHour = (((now.getUTCHours() + timezoneOffsetHours) % 24) + 24) % 24;
  if (quietStart === quietEnd) return false; // degenerate config: never quiet
  if (quietStart < quietEnd) {
    return localHour >= quietStart && localHour < quietEnd;
  }
  // wraps midnight, e.g. 21 -> 8
  return localHour >= quietStart || localHour < quietEnd;
}

/** Rough, dependency-free IANA-timezone -> fixed UTC offset lookup for the
 *  handful of US zones this app's companies actually use. Not DST-correct
 *  to the day (it approximates with the current, most-common offset), which
 *  is acceptable here: quiet hours are a courtesy window a few hours wide,
 *  not a legal deadline, and being off by one hour twice a year means a
 *  follow-up sends slightly earlier or later inside a multi-hour quiet
 *  block, never at a wildly wrong time of day. */
export function approximateUtcOffsetHours(timezone: string): number {
  const table: Record<string, number> = {
    "America/New_York": -4,
    "America/Chicago": -5,
    "America/Denver": -6,
    "America/Phoenix": -7,
    "America/Los_Angeles": -7,
    "America/Anchorage": -8,
    "Pacific/Honolulu": -10,
  };
  return table[timezone] ?? -5;
}

/** Given how many follow-ups a company has already sent today (any kind),
 *  is there room for one more under its daily cap? */
export function underDailyCap(sentToday: number, dailyCap: number): boolean {
  return sentToday < dailyCap;
}
