/**
 * Who a job push may reach, and what it says. Pure: no Deno, no network, no
 * Supabase client, so tests/notify-job-change.test.mjs imports it under
 * plain Node -- the same split as follow-up-logic.ts / send-follow-ups.
 *
 * push-recipients.ts is the impure half: it reads profiles, employees,
 * job_assignments and device_tokens with the service role and asks these
 * functions who may be told. notify-job-change, quote-view, stripe-webhook,
 * square-webhook and attention-sweep all address their pushes through it.
 *
 * Two audiences, one per kind of push:
 *   - About a job, with no money in it: whoever can open the job
 *     (jobPushAudience, below).
 *   - Carrying an amount of money: whoever holds SEE_MONEY (moneyAudience).
 *     Crew never sees money, so crew is never told an amount -- not even
 *     about the job they are standing on.
 *
 * THE RULE is the database's own (supabase_crew_job_scope.sql): somebody may
 * be told about a job only if they can open it.
 *   - They see every job: SEE_MONEY or EDIT_JOBS or SCHEDULE_AND_ASSIGN
 *     (sees_all_jobs()). Owner, manager, sales, accountant and foreman by
 *     default; per-person overrides move people in and out.
 *   - Or their own active crew record (employees.profile_id) is the job's
 *     lead (jobs.assigned_employee_sync_id) or has an open job_assignments
 *     row on it (my_employee_sync_ids() / my_visible_job_sync_ids()).
 * Before this, every job push went to every device in the company, so a crew
 * phone was told the customer name of every new job and every accepted quote,
 * including the jobs it is not allowed to open.
 *
 * Nobody else is ever added as a fallback. When something cannot be read
 * (job_assignments before supabase_crew_job_scope.sql is applied, or the
 * employees read failing) the audience SHRINKS: a missed push is a
 * notification somebody sees on their next sync; a leaked one is a customer
 * name on a phone that was not meant to have it.
 */

// ---------------------------------------------------------------------------
// Permissions: the SAME answer as public.has_permission(perm), for somebody
// other than the caller.
// ---------------------------------------------------------------------------
// has_permission() reads auth.uid(), which is null under the service role,
// so this function cannot ask it about each recipient. This is therefore a
// copy of its role table -- and a copy drifts. tests/notify-job-change.test.mjs
// holds it to the file that last defines has_permission in
// supabase/dev/apply-order.txt, AND to the live function (whose CASE body it
// evaluates on made-up rows inside a rolled-back transaction), so a role
// change that lands in SQL without landing here fails that test. If
// has_permission ever grows a per-user form (permission_for(uid, perm), as
// the crew-access design suggests), ask that instead and delete this table.

/** has_permission's CASE, role by role. OWNER holds every permission. */
export const ROLE_PERMISSIONS: ReadonlyMap<string, "ALL" | readonly string[]> = new Map<
  string,
  "ALL" | readonly string[]
>([
  ["OWNER", "ALL"],
  ["MANAGER", [
    "SEE_MONEY", "SEE_PAY", "EDIT_JOBS", "EDIT_CATALOG_AND_SETTINGS", "SCHEDULE_AND_ASSIGN",
    "REQUEST_PAYMENT", "RECORD_FIELD_WORK", "SEE_CUSTOMER_CONTACT", "SEE_REPORTS",
    "APPROVE_TIME", "APPROVE_PLAN_CHANGES",
  ]],
  ["SALES", ["SEE_MONEY", "EDIT_JOBS", "SEE_CUSTOMER_CONTACT"]],
  ["ACCOUNTANT", [
    "SEE_MONEY", "SEE_PAY", "REQUEST_PAYMENT", "RECORD_REFUNDS", "SEE_CUSTOMER_CONTACT", "SEE_REPORTS",
  ]],
  ["FOREMAN", [
    "SCHEDULE_AND_ASSIGN", "RECORD_FIELD_WORK", "SEE_CUSTOMER_CONTACT",
    "APPROVE_TIME", "APPROVE_PLAN_CHANGES",
  ]],
  ["CREW", ["RECORD_FIELD_WORK"]],
]);

/**
 * has_permission(perm) for a given role and permission_overrides string.
 *
 * Same order, same test: a `-PERM` anywhere in the overrides wins, then a
 * `+PERM`, then the role. The overrides test is a plain substring search
 * because the SQL's is (`position('-' || perm in overrides) > 0`); parsing
 * the list "properly" here would disagree with the database on a malformed
 * string, and the database is the one that decides what a phone can read.
 * An unknown or missing role holds nothing, as in the SQL's `else false`.
 */
export function permissionFor(
  role: string | null | undefined,
  overrides: string | null | undefined,
  perm: string,
): boolean {
  const ov = overrides ?? "";
  if (ov.includes("-" + perm)) return false;
  if (ov.includes("+" + perm)) return true;
  const granted = role ? ROLE_PERMISSIONS.get(role) : undefined;
  if (granted === "ALL") return true;
  return granted !== undefined && granted.includes(perm);
}

/** sees_all_jobs(): a capability test, never a role name. */
export const SEES_ALL_JOBS_PERMISSIONS: readonly string[] = [
  "SEE_MONEY", "EDIT_JOBS", "SCHEDULE_AND_ASSIGN",
];

/** The columns of a `profiles` row this module reads. */
export interface PushProfile {
  id: string;
  role: string | null;
  permission_overrides: string | null;
}

export function seesAllJobs(p: PushProfile): boolean {
  return SEES_ALL_JOBS_PERMISSIONS.some((perm) => permissionFor(p.role, p.permission_overrides, perm));
}

// ---------------------------------------------------------------------------
// The event
// ---------------------------------------------------------------------------

/**
 * A sync id as text, compared case-blind. jobs.assigned_employee_sync_id is
 * TEXT (written by phones and the office) while employees.sync_id is a UUID
 * PostgREST prints in lower case, and "no lead" arrives as null OR ''.
 */
export function syncIdOf(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

export type JobPushKind = "INSERT" | "ACCEPTED" | "ASSIGNED";

export interface JobPushEvent {
  kind: JobPushKind;
  /** The customer's name, or null when the job has none. */
  customer: string | null;
  /** The job's sync id (lower case), or "" when the row has none. */
  jobSyncId: string;
  /** The job's lead after this change (lower case), or "". */
  leadSyncId: string;
  /**
   * The lead this change put on the job: set on an INSERT that arrives with
   * a lead, or an UPDATE that changed it to someone. "" otherwise --
   * including when the lead was taken off, which tells nobody anything.
   */
  newLeadSyncId: string;
}

/**
 * What a jobs webhook payload means, or null for "no notification needed".
 *
 * The assignee is jobs.assigned_employee_SYNC_id. The uuid column
 * assigned_employee_id has never been written by anything (0 live jobs carry
 * it), so comparing it -- as this function did until 2026-09-22 -- meant
 * "Crew assignment changed" could never fire.
 *
 * ACCEPTED means the customer said yes to the quote (JobStatus.isWon); the
 * crew finishing is COMPLETED. The old copy, "Job marked complete / was
 * finished by the crew", told the office a job was done on the day it was
 * sold.
 *
 * An UPDATE with no old_record cannot say what changed, and treating every
 * column as new would push "assigned" and "accepted" on every save (the
 * trigger fires on any UPDATE that SETs status, which a full-row sync does
 * every time), so it is not a notification.
 */
export function jobPushEvent(payload: {
  type?: string;
  record?: Record<string, unknown> | null;
  old_record?: Record<string, unknown> | null;
}): JobPushEvent | null {
  const rec = payload.record ?? {};
  const insert = payload.type === "INSERT";
  if (!insert && !payload.old_record) return null;
  const old = payload.old_record ?? {};

  const lead = syncIdOf(rec.assigned_employee_sync_id);
  const oldLead = syncIdOf(old.assigned_employee_sync_id);
  const newLead = lead && (insert || lead !== oldLead) ? lead : "";

  let kind: JobPushKind;
  if (insert) kind = "INSERT";
  else if (rec.status === "ACCEPTED" && old.status !== "ACCEPTED") kind = "ACCEPTED";
  else if (newLead) kind = "ASSIGNED";
  else return null;

  const name = typeof rec.customer_name === "string" ? rec.customer_name.trim() : "";
  return {
    kind,
    customer: name || null,
    jobSyncId: syncIdOf(rec.sync_id),
    leadSyncId: lead,
    newLeadSyncId: newLead,
  };
}

/**
 * A job as it stands, for a push about something that happened TO it rather
 * than a jobs-row change -- quote-view's "Quote approved", sent from the
 * approval itself. Only who can open the job matters there, so the audience
 * is the same as jobPushAudience's for the job's current lead. Nobody is its
 * new lead: an approval assigns nobody, so nobody is told "You were assigned".
 */
export function standingJobEvent(rec: Record<string, unknown>, kind: JobPushKind): JobPushEvent {
  const name = typeof rec.customer_name === "string" ? rec.customer_name.trim() : "";
  return {
    kind,
    customer: name || null,
    jobSyncId: syncIdOf(rec.sync_id),
    leadSyncId: syncIdOf(rec.assigned_employee_sync_id),
    newLeadSyncId: "",
  };
}

/**
 * The words. `toNewLead` is true for the person this change put on the job,
 * who is told so in the second person rather than reading "Someone was
 * assigned" about themselves -- whatever else changed in the same save.
 */
export function jobPushMessage(e: JobPushEvent, toNewLead: boolean): { title: string; body: string } {
  const who = e.customer ?? "a job";
  if (toNewLead) {
    return { title: "Job assigned to you", body: `You were assigned to ${who}.` };
  }
  switch (e.kind) {
    case "INSERT":
      return { title: "New job added", body: `${who} was added to the schedule.` };
    case "ACCEPTED":
      return {
        title: "Quote accepted",
        body: e.customer ? `${e.customer} accepted the quote.` : "A customer accepted a quote.",
      };
    case "ASSIGNED":
      return { title: "Crew assignment changed", body: `Someone was assigned to ${who}.` };
  }
}

// ---------------------------------------------------------------------------
// The audience
// ---------------------------------------------------------------------------

/** The columns of an `employees` row this module reads. */
export interface PushEmployee {
  sync_id: string | null;
  profile_id: string | null;
  is_active: boolean | null;
  deleted_at: string | null;
}

/**
 * Every user id in the company who may be told about this job, each with
 * whether this change just made them its lead.
 *
 * `profiles` must already be limited to the job's company. `employees` is
 * that company's crew records (null when they could not be read: crew are
 * then told nothing). `crewSyncIds` is the employee sync ids on open
 * job_assignments rows for this job (null when job_assignments could not be
 * read, which before supabase_crew_job_scope.sql is always: only the lead's
 * login is then added to the see-all users).
 *
 * A crew record counts only while active and not deleted, as in
 * my_employee_sync_ids(): switching somebody off in the office takes their
 * jobs off their phone, and so takes them off the push too.
 */
export function jobPushAudience(input: {
  event: JobPushEvent;
  profiles: readonly PushProfile[];
  employees: readonly PushEmployee[] | null;
  crewSyncIds: readonly string[] | null;
}): Map<string, { newLead: boolean }> {
  const { event, profiles, employees, crewSyncIds } = input;
  const onJob = new Set<string>();
  if (event.leadSyncId) onJob.add(event.leadSyncId);
  for (const s of crewSyncIds ?? []) {
    const id = syncIdOf(s);
    if (id) onJob.add(id);
  }

  // profile id -> their own live crew record ids (unique today; a set anyway)
  const recordsOf = new Map<string, Set<string>>();
  for (const e of employees ?? []) {
    const sid = syncIdOf(e.sync_id);
    if (!sid || !e.profile_id || e.deleted_at || e.is_active !== true) continue;
    const set = recordsOf.get(e.profile_id) ?? new Set<string>();
    set.add(sid);
    recordsOf.set(e.profile_id, set);
  }

  const out = new Map<string, { newLead: boolean }>();
  for (const p of profiles) {
    if (!p.id) continue;
    const mine = recordsOf.get(p.id);
    const newLead = !!event.newLeadSyncId && !!mine?.has(event.newLeadSyncId);
    const onThisJob = !!mine && [...mine].some((s) => onJob.has(s));
    if (seesAllJobs(p) || onThisJob) out.set(p.id, { newLead });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Every user id in the company who may be told an amount of money: the people
 * has_permission('SEE_MONEY') says yes to. Owner, manager, sales and
 * accountant by role; +SEE_MONEY brings anyone in and -SEE_MONEY takes anyone
 * out, by the same permissionFor the job audience uses -- so a phone is told
 * a figure exactly when the database would let it read that figure.
 *
 * Deliberately NOT jobPushAudience. Seeing every job is SEE_MONEY or
 * EDIT_JOBS or SCHEDULE_AND_ASSIGN, so a foreman sees every job and holds no
 * money; and crew on the job can open it without seeing a dollar of it.
 * Before this, "Payment received: $4,200.00", chargebacks and declined cards
 * went to every device in the company, crew included.
 *
 * `profiles` must already be limited to the company. Nobody else is ever
 * added: when profiles cannot be read, the caller tells nobody.
 */
export function moneyAudience(profiles: readonly PushProfile[]): Set<string> {
  const out = new Set<string>();
  for (const p of profiles) {
    if (p.id && permissionFor(p.role, p.permission_overrides, "SEE_MONEY")) out.add(p.id);
  }
  return out;
}
