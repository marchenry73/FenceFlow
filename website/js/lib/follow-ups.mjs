/* Pure sales follow-up decision logic, mirrored from
   supabase/functions/_shared/follow-up-logic.ts so the office "what would
   send right now" preview computes off the SAME rules send-follow-ups
   actually fires, without the office page trying to import a .ts file a
   browser cannot execute (Deno-erasable TypeScript, not plain JS -- and this
   page has no build step to strip the types).

   DUPLICATION, NOT A SECOND SOURCE OF TRUTH: every function below must stay
   byte-for-byte equivalent (modulo TS type annotations) to its counterpart
   in supabase/functions/_shared/follow-up-logic.ts. If one changes, change
   both -- tests/follow-ups-office.test.mjs and tests/follow-ups.test.mjs
   each exercise their own copy with the same cases so a drift between the
   two shows up as one file's tests passing and the other's failing.

   No DOM, no Supabase, no clock of its own -- "now" is always passed in. */

export const FOLLOW_UP_KINDS = [
  "new_lead_not_contacted",
  "quote_sent_no_view",
  "quote_viewed_not_approved",
  "approved_no_deposit",
];

export const DEFAULT_SETTINGS = {
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

const hoursSince = (iso, now) => (now.getTime() - new Date(iso).getTime()) / 3_600_000;
const daysSince = (iso, now) => hoursSince(iso, now) / 24;

/** Which (if any) follow-up kind is due for this job right now, given the
    company's settings. Returns null when nothing is due -- including when
    the job is opted out, a test fixture, soft-deleted, or the global switch
    is off. Quiet hours and the daily cap are NOT checked here; see
    isQuietHour() and the caller. Same precedence order as the server copy:
    a job is checked against exactly one condition, the furthest-along one
    that applies. */
export function dueFollowUp(job, settings, now) {
  if (!settings.enabled) return null;
  if (job.deleted_at) return null;
  if (job.is_test_fixture) return null;
  if (job.opted_out_at) return null;
  if (!job.email) return null;

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

  const createdAt = job.created_at;
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

/** True when `now`, interpreted in `timezoneOffsetHours`, falls inside
    [start, end). Handles the wrap-past-midnight case (start=21, end=8). */
export function isQuietHour(now, quietStart, quietEnd, timezoneOffsetHours) {
  const localHour = (((now.getUTCHours() + timezoneOffsetHours) % 24) + 24) % 24;
  if (quietStart === quietEnd) return false;
  if (quietStart < quietEnd) {
    return localHour >= quietStart && localHour < quietEnd;
  }
  return localHour >= quietStart || localHour < quietEnd;
}

/** Rough, dependency-free IANA-timezone -> fixed UTC offset lookup for the
    handful of US zones this app's companies actually use. Not DST-correct
    to the day -- acceptable for a preview list and for quiet hours, a
    courtesy window rather than a legal deadline. */
export function approximateUtcOffsetHours(timezone) {
  const table = {
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
    is there room for one more under its daily cap? */
export function underDailyCap(sentToday, dailyCap) {
  return sentToday < dailyCap;
}

/** Office-preview convenience: which jobs would get a follow-up sent right
    now if the rules were live, in the same order the edge function would
    reach them (jobs array order), honoring quiet hours and the daily cap
    the identical way send-follow-ups does -- a cap that's already reached
    stops the whole preview, not just the jobs past the count. This is
    read-only: it never claims a follow_up_log row and never sends anything.
    `sentToday` is the count already read from follow_up_log for today. */
export function previewDueFollowUps(jobs, settings, now, sentToday) {
  if (!settings.enabled) return [];
  const offset = approximateUtcOffsetHours(settings.timezone);
  if (isQuietHour(now, settings.quiet_hours_start, settings.quiet_hours_end, offset)) {
    return [];
  }
  let remaining = settings.daily_cap - (sentToday || 0);
  if (remaining <= 0) return [];

  const out = [];
  for (const job of jobs || []) {
    if (remaining <= 0) break;
    const due = dueFollowUp(job, settings, now);
    if (!due) continue;
    out.push({ job_sync_id: job.sync_id, kind: due.kind, stageKey: due.stageKey });
    remaining -= 1;
  }
  return out;
}
