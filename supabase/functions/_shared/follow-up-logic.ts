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
  | "approved_no_deposit";

export const FOLLOW_UP_KINDS: FollowUpKind[] = [
  "new_lead_not_contacted",
  "quote_sent_no_view",
  "quote_viewed_not_approved",
  "approved_no_deposit",
];

export interface FollowUpSettings {
  enabled: boolean;
  new_lead_not_contacted_enabled: boolean;
  quote_sent_no_view_enabled: boolean;
  quote_viewed_not_approved_enabled: boolean;
  approved_no_deposit_enabled: boolean;
  new_lead_not_contacted_hours: number;
  quote_sent_no_view_days: number;
  quote_viewed_not_approved_days: number;
  approved_no_deposit_days: number;
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
  new_lead_not_contacted_hours: 4,
  quote_sent_no_view_days: 2,
  quote_viewed_not_approved_days: 3,
  approved_no_deposit_days: 2,
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
