/**
 * WHERE A CUSTOMER'S REPLY GOES, for the two letters this product sends on a
 * company's behalf with nobody signed in: the payment receipt
 * (payment-receipt) and the sales follow-up (send-follow-ups).
 *
 * THE PROBLEM THIS SOLVES. Both letters go out FROM FenceFlow's own verified
 * sending address -- they have to, deliverability lives on that domain -- with
 * the company's name on it. So the Reply-To header is the ONLY thing deciding
 * whether the customer's answer reaches the company at all. Without one, her
 * reply goes to MAIL_FROM: FenceFlow's own mailbox, carrying another company's
 * customer. Both functions used to write `companies.email` straight into that
 * header, unvalidated, and simply left the header off when the column was
 * blank -- which four companies in the live database are. Nothing said so.
 *
 * THE ORDER, which is reply.ts's order deliberately, so a reply to a receipt
 * lands in the same place as a reply to the same company's quote email and
 * its FenceFlow mail:
 *
 *   1. The company's own FenceFlow routing address,
 *      <inbound_token>@<MAIL_INBOUND_DOMAIN>, once receiving is proven
 *      (mail_platform_settings.inbound_verified_at plus the receiving secrets)
 *      AND the company already has a FenceFlow mail account. resend-inbound
 *      reads the token back and files the reply in that company's own mailbox,
 *      beside the job. This is the COMPANY's address by construction: it does
 *      not name a person, and it keeps working when one leaves.
 *   2. Otherwise companies.email -- the company's own customer-facing address,
 *      the one the office types into Settings -- and only if it is shaped like
 *      a real address.
 *   3. Otherwise nothing, and the caller decides what to do about it. There is
 *      no honest third option: an unanswerable letter is the caller's problem
 *      to weigh, not something to paper over with FenceFlow's own address.
 *
 * THE CHOOSING IS NOT COPIED. fenceflowReplyTo() makes it, the same function
 * mail-send, mail-connect and quote-approval-email call. This module only
 * gathers what that function needs from the environment and two rows, because
 * a second copy of "where replies go" is how one sender quietly stops agreeing
 * with the others (see mail-send's comment on its mailbox path, which
 * deliberately has no Reply-To at all and must stay that way).
 *
 * NO SIDE EFFECTS. The account is READ, never created: quote-approval-email
 * calls mail_fenceflow_account() because it also files a Sent copy and needs
 * an account id, but a receipt and a follow-up file nothing, and a cron run
 * that provisioned a mailbox for every company it looked at would be making
 * rows nobody asked for. A company with no FenceFlow mail account therefore
 * falls to its own email, which is exactly right: routing a reply into a
 * mailbox that does not exist would lose it.
 *
 * A READ THAT FAILS IS NOT AN ANSWER. Either query failing leaves inbound
 * routing off and falls through to the company's own address, with the failure
 * logged -- never silently treated as "this company has no routing", and never
 * allowed to stop a receipt for money that has already moved.
 */
import { fenceflowReplyTo, type FenceflowReplyMode } from "./reply.ts";

/** Only what this module calls. Narrow on purpose: the callers hand in their
 *  service-role client, and nothing here may reach for anything wider. */
export interface ReplyDb {
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
}

export interface CustomerReplyInput {
  /** The company the letter is sent on behalf of. */
  companyId: string;
  /** companies.email as read by the caller; anything, including blank. */
  companyEmail: unknown;
  /** Deno.env.get by default; a seam so this is testable without an env. */
  env?: (name: string) => string | undefined;
}

export interface CustomerReplyResult {
  mode: FenceflowReplyMode;
  replyTo: string | null;
}

function envReader(given?: (name: string) => string | undefined): (name: string) => string {
  if (given) return (name) => String(given(name) ?? "");
  // deno-lint-ignore no-explicit-any
  const env = (globalThis as any).Deno?.env;
  return (name) => String(env?.get(name) ?? "");
}

/**
 * The Reply-To for one customer-facing letter. Never throws: every failure
 * ends as a less specific answer, not as a refused send.
 */
export async function customerReplyTo(db: ReplyDb, input: CustomerReplyInput): Promise<CustomerReplyResult> {
  const env = envReader(input.env);
  const companyEmail = String(input.companyEmail ?? "").trim() || null;
  const companyId = String(input.companyId ?? "").trim();
  const inboundDomain = env("MAIL_INBOUND_DOMAIN").toLowerCase();

  // The same three-part test quote-approval-email makes before it trusts
  // inbound: the domain, both receiving secrets, and a row that says a signed
  // webhook actually arrived. A domain on its own proves nothing.
  let inboundReady = false;
  if (inboundDomain && env("RESEND_WEBHOOK_SECRET") && env("RESEND_RECEIVING_KEY")) {
    try {
      const { data, error } = await db
        .from("mail_platform_settings").select("inbound_verified_at").eq("id", 1).maybeSingle();
      if (error) console.error("customer reply-to: could not read mail_platform_settings", error.message ?? "");
      else inboundReady = Boolean(data?.inbound_verified_at);
    } catch (e) {
      console.error("customer reply-to: mail_platform_settings", String((e as Error)?.message ?? e));
    }
  }

  let inboundToken: string | null = null;
  if (inboundReady && companyId) {
    try {
      const { data, error } = await db
        .from("mail_accounts").select("inbound_token")
        .eq("company_id", companyId).eq("kind", "fenceflow").maybeSingle();
      if (error) console.error("customer reply-to: could not read the company's mail account", error.message ?? "");
      else if (typeof data?.inbound_token === "string") inboundToken = data.inbound_token;
    } catch (e) {
      console.error("customer reply-to: mail_accounts", String((e as Error)?.message ?? e));
    }
  }

  return fenceflowReplyTo({
    inboundReady,
    inboundDomain,
    inboundToken,
    // A receipt and a follow-up are not answers to a thread, so there is no
    // thread token to carry. resend-inbound accepts the bare inbound token and
    // files the reply as a new conversation in that company's mailbox.
    replyToken: null,
    companyEmail,
  });
}
