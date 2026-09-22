/**
 * Who a push may reach, read from the database: the impure half of
 * job-push.ts, shared by every function that sends one.
 *
 * Every push is addressed to chosen PEOPLE, never to a company. Until
 * 2026-09-22 stripe-webhook, square-webhook and quote-view read every
 * device_tokens row in the company and sent to all of them, so a crew phone
 * was told "Payment received: $4,200.00 -- Dana Smith paid ...", every
 * chargeback and every declined card, with the amount in the headline --
 * money the crew app is built never to show. (Live on the day: one crew login
 * with three phones registered.)
 *
 *   - moneyDevices: a push carrying an amount goes only to people who hold
 *     SEE_MONEY (moneyAudience).
 *   - jobAudience / jobDevices: a push about a job with no money in it goes
 *     only to people who can open that job (jobPushAudience).
 *
 * Reads that fail make the audience SMALLER, never larger. There is no
 * fallback to "everyone in the company" anywhere in here: a missed push is
 * something the office sees on its next look; a leaked one is a figure on a
 * phone that was not meant to have it.
 *
 * No Deno and no supabase-js import: the service-role client is handed in,
 * as record-payment.ts takes it, so this runs under plain Node against a fake
 * client (tests/money-push-audience.test.mjs).
 */
import {
  type JobPushEvent,
  jobPushAudience,
  moneyAudience,
  type PushEmployee,
  type PushProfile,
} from "./job-push.ts";

/** A device row, with whose it is so each person can get their own words. */
export interface PushDevice {
  token: string;
  user_id: string;
}

/**
 * PostgREST's answer for a table that is not there: PGRST205 from current
 * PostgREST, 42P01 from older ones. job_assignments is created by
 * supabase_crew_job_scope.sql, so until that file is applied this is the
 * expected answer rather than a fault worth a log line on every push.
 */
function isMissingTable(error: { code?: string } | null): boolean {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

/**
 * Everyone in the job's company who may be told about it (see
 * jobPushAudience). Reads that fail make the audience smaller, never larger:
 *   - profiles unreadable: throws, and nobody is told.
 *   - employees unreadable: crew are told nothing; the see-all users still are.
 *   - job_assignments unreadable (always, before supabase_crew_job_scope.sql):
 *     extra crew and approved-access crew are not told; the lead's own login
 *     still is, because the lead lives on the jobs row and exists either way.
 */
export async function jobAudience(
  db: any,
  companyId: string,
  event: JobPushEvent,
): Promise<Map<string, { newLead: boolean }>> {
  const { data: profiles, error: profilesError } = await db
    .from("profiles").select("id, role, permission_overrides")
    .eq("company_id", companyId);
  if (profilesError) throw new Error(`profiles: ${profilesError.message}`);

  let employees: PushEmployee[] | null = null;
  const { data: emps, error: empsError } = await db
    .from("employees").select("sync_id, profile_id, is_active, deleted_at")
    .eq("company_id", companyId).not("profile_id", "is", null);
  if (empsError) console.warn(`employees unreadable; crew get no job push: ${empsError.message}`);
  else employees = (emps ?? []) as PushEmployee[];

  let crewSyncIds: string[] | null = null;
  if (event.jobSyncId) {
    const { data: rows, error } = await db
      .from("job_assignments").select("employee_sync_id")
      .eq("company_id", companyId).eq("job_sync_id", event.jobSyncId).is("ended_at", null);
    if (error) {
      if (!isMissingTable(error)) console.warn(`job_assignments unreadable; lead only: ${error.message}`);
    } else {
      crewSyncIds = (rows ?? []).map((r: { employee_sync_id: string }) => r.employee_sync_id);
    }
  }

  return jobPushAudience({
    event,
    profiles: (profiles ?? []) as PushProfile[],
    employees,
    crewSyncIds,
  });
}

/**
 * Everyone in the company who holds SEE_MONEY (see moneyAudience). Throws
 * when profiles cannot be read, so the caller tells nobody.
 */
export async function moneyRecipients(db: any, companyId: string): Promise<string[]> {
  const { data: profiles, error } = await db
    .from("profiles").select("id, role, permission_overrides")
    .eq("company_id", companyId);
  if (error) throw new Error(`profiles: ${error.message}`);
  return [...moneyAudience((profiles ?? []) as PushProfile[])];
}

/**
 * The phones of exactly these people, in this company. Both filters, always:
 * the user ids say who, and the company id says which of their phones. A
 * phone is one row (token is the key), stamped with the company it last
 * registered under, so a phone its owner last used at a company they have
 * since left -- a work phone handed back there, say -- still says that
 * company and does not hear this one's money. No ids is no read and no
 * phones -- never "no filter".
 */
export async function devicesOf(
  db: any,
  companyId: string,
  userIds: readonly string[],
): Promise<PushDevice[]> {
  if (!companyId || !userIds.length) return [];
  const { data, error } = await db
    .from("device_tokens").select("token, user_id")
    .eq("company_id", companyId).in("user_id", [...userIds]);
  if (error) throw new Error(`device_tokens: ${error.message}`);
  return (data ?? []) as PushDevice[];
}

/**
 * The phones a push carrying an amount of money may reach. Never throws: the
 * payment webhooks must not fail for want of a push (a failure would have the
 * processor retry the whole event), so any read that fails means nobody is
 * told -- the same answer the old company-wide read gave when device_tokens
 * failed, now for profiles too.
 */
export async function moneyDevices(db: any, companyId: string): Promise<PushDevice[]> {
  try {
    return await devicesOf(db, companyId, await moneyRecipients(db, companyId));
  } catch (e) {
    console.warn(`money push not sent; recipients unreadable: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

/**
 * The phones a push about this job (with no money in it) may reach. Never
 * throws, for the same reason as moneyDevices.
 */
export async function jobDevices(db: any, companyId: string, event: JobPushEvent): Promise<PushDevice[]> {
  try {
    return await devicesOf(db, companyId, [...(await jobAudience(db, companyId, event)).keys()]);
  } catch (e) {
    console.warn(`job push not sent; recipients unreadable: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}
