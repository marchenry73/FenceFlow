/**
 * The one place a function asks "may this company reach a real person?".
 *
 * WHY THIS EXISTS
 *   supabase_r64_sandbox_company.sql closes two of the six transports that
 *   reach real people by taking the capability away: a sandbox company can
 *   never hold a row in mail_accounts or payment_connections, so it has no
 *   mailbox and no card credential, and no future code can forget that.
 *
 *   Transactional mail through Resend and Brevo needs neither. Twelve functions
 *   call those hosts directly, so for them the check has to be in the code --
 *   which is the weaker kind of guard, because the thirteenth function will
 *   forget it. Everything below is shaped to make forgetting LOUD.
 *
 * WHY IT TAKES A ROW AND NOT A COMPANY ID
 *   The obvious version is an rpc to company_is_sandbox(). That adds a network
 *   call with its own failure mode, and then the guard has to choose between
 *   two bad answers when the call fails: refuse, and a transient error stops
 *   real customer mail for the live business; allow, and "cannot tell" has been
 *   coalesced into "not a sandbox", which is how a careful three-state check
 *   becomes a confident false.
 *
 *   So the caller selects `is_sandbox` alongside the company columns it already
 *   reads, and passes the row. No new call, no new failure mode: if that select
 *   fails the function was already broken.
 *
 * WHY A MISSING COLUMN THROWS
 *   `company.is_sandbox === true` reads false for a row whose select forgot the
 *   column, and the mail goes out. That is the silent-failure shape this
 *   codebase keeps getting bitten by, so an absent property is treated as a
 *   programming error and throws by name. A forgotten select then fails the
 *   first time it is exercised, instead of quietly sending.
 */

/** The one wording, so twelve functions do not invent twelve. */
export function sandboxMessage(what: string): string {
  return (
    `This is a sandbox company, so ${what} was not sent. A sandbox exists to be ` +
    `demonstrated and must not reach a real person. Do this from the live company.`
  );
}

export class SandboxRefusal extends Error {
  readonly code = "sandbox_company";
  constructor(what: string) {
    super(sandboxMessage(what));
    this.name = "SandboxRefusal";
  }
}

/** A company row that was selected with `is_sandbox` among its columns. */
export type CompanySandboxFlag = { is_sandbox?: boolean | null } | null | undefined;

/**
 * Throws when `company` is a sandbox. `what` names the thing that would have
 * been sent, and reaches the caller's error body, so "the approval email" reads
 * better than "mail".
 *
 * A null/undefined company is NOT a refusal: several of these functions run
 * before any company exists (a signup invitation, for one), and there is
 * nothing to judge. The functions that do have a company must pass it.
 */
export function refuseIfSandbox(company: CompanySandboxFlag, what: string): void {
  if (isSandbox(company, what)) throw new SandboxRefusal(what);
}

/**
 * The same question for a function whose style is to RETURN a response rather
 * than throw -- most of these answer `json({ error }, status)`, and a thrown
 * error there becomes a 500 about nothing in particular. Use:
 *
 *     if (isSandbox(company, "the HOA letter")) {
 *       return json({ error: sandboxMessage("the HOA letter") }, 403);
 *     }
 *
 * It keeps the missing-column protection: a row selected without `is_sandbox`
 * throws by name instead of answering false.
 */
export function isSandbox(company: CompanySandboxFlag, what = "this"): boolean {
  if (company === null || company === undefined) return false;
  if (!("is_sandbox" in (company as Record<string, unknown>))) {
    throw new Error(
      `sandbox guard: is_sandbox was not selected on this company row, so ${what} ` +
        `cannot be judged. Add is_sandbox to the select -- a missing column would ` +
        `otherwise read as "not a sandbox" and send it.`,
    );
  }
  return (company as { is_sandbox?: boolean | null }).is_sandbox === true;
}

/**
 * For a caller that holds only an id. It reads the flag itself, and a failed
 * read REFUSES rather than guessing -- the opposite trade from the row form
 * above, and the right one here, because a caller on this path has not already
 * depended on the company row loading.
 *
 * `db` is any client with the supabase-js `.from().select()` shape.
 */
export async function refuseIfSandboxId(
  // deno-lint-ignore no-explicit-any
  db: any,
  companyId: string | null | undefined,
  what: string,
): Promise<void> {
  if (!companyId) return;
  const { data, error } = await db
    .from("companies")
    .select("is_sandbox")
    .eq("id", companyId)
    .maybeSingle();
  if (error) {
    throw new Error(
      `sandbox guard: could not read is_sandbox for company ${companyId}, so ${what} ` +
        `was not sent (${error.message ?? error}). Refusing rather than guessing.`,
    );
  }
  // A company that is not there is not a sandbox, and whatever else is wrong
  // with sending to it is not this guard's to report.
  refuseIfSandbox(data ?? null, what);
}
