/**
 * quote-approval-email -- emails the customer their contract the moment they
 * approve their quote: the agreement, the total price, the deposit required to
 * start, and how to pay it.
 *
 *   POST  x-fenceflow-trigger: <NOTIFY_TRIGGER_SECRET>
 *         { job_id: uuid, lang?: "en"|"es"|"fr", accept_language?: string }
 *
 *   200 { state: "sent",        to: "j***@gmail.com" }   the provider took it
 *   200 { state: "unconfirmed", to }                      it may have gone out; NOT retried
 *   200 { state: "sending",     duplicate: true }         another call is, or was, mid-send
 *   200 { state: "failed" | "no_address" | "not_priced", reason_code }
 *                                                         certainly NOT sent; the office was pushed
 *   200 { state: "skipped", reason }                      a test fixture, a deleted job, a test company
 *   200 { ...the state of the earlier attempt, duplicate: true }
 *   401 / 503 / 400 / 404 / 409 / 500                     the door, the body, the job, a bug
 *
 * WHO CALLS IT: quote-view, once, after the customer's approval has landed
 * (jobs.quote_approved_at written). Nothing else. A database trigger on
 * quote_approved_at was considered and rejected: it would also fire for an
 * office-recorded approval, a backfill or an import, and there are real
 * customers' real addresses in that table.
 *
 * THE DOOR: the same one send-follow-ups, notify-job-change and attention-sweep
 * use -- a shared secret (NOTIFY_TRIGGER_SECRET, already set for them) compared
 * in constant time BEFORE the body is read, and an unset secret refuses
 * everything. verify_jwt is off in config.toml because the caller is another
 * function, not a person. Even a caller holding the secret can only cause the
 * one email for an approval that really happened: the recipient, the figures and
 * every word come from the database, never from the request, and the job must
 * be approved.
 *
 * HOW IT SENDS -- ONE WAY, THE EXISTING ONE. This is mail-send's "FenceFlow
 * mail" path (viaFenceflow) with no signed-in person on the end of it, and it
 * uses the same pieces for the same jobs: fenceflowFrom() (the company's name on
 * FenceFlow's verified address), fenceflowReplyTo() (replies go to the company --
 * into its FenceFlow inbox once receiving is proven, else to companies.email --
 * and the send is REFUSED when neither exists, because a reply would otherwise
 * reach FenceFlow's own mailbox carrying another company's customer),
 * buildResendEmail() and composeBody() (the HTML twin is made from the text and
 * escaped), mail_ingest() (the message appears in the office's Sent view and on
 * the job's mail panel, de-duplicated by client_send_id), the note_mail_event()
 * rate ledger (20 an hour and 100 a day per company, SHARED with what the
 * office sends by hand), and the same Resend call with the same
 * Idempotency-Key. The orchestration around those pieces is repeated here
 * because mail-send's own is welded to a signed-in caller (mailCaller) and its
 * module starts a server on import; extracting it into _shared/mail is the
 * proper fix and is described in the hand-off, not done here.
 *
 * NOT USED: a company's own connected SMTP mailbox. Sending from it headlessly
 * would mean presenting its stored app password on a customer's click, and a
 * refused password locks mailboxes. No company has one connected today. When
 * one does, the place to change is the call to sendViaFenceflow() in
 * handleRequest(); the office's own sends still go through mail-send from the
 * mailbox as before.
 *
 * ONCE, NOT EVERY TIME: every attempt is first CLAIMED as a row in
 * quote_approval_emails, unique on (company, job, contract_key), and the email
 * goes only to the call that got the row. contract_key is a fingerprint of what
 * the email states (property, scope, total, deposit) -- not of the approval's
 * timestamp or name. So re-opening the link, a second tab, a retry, or approving
 * again after a withdrawal at the same price never sends it twice; and
 * approving a CHANGED contract (the drawing changed, the price moved) is a new
 * key and sends the new one. A claimed row is never sent again, whatever state
 * it ended in: "maybe sent" beats "sent twice", the rule send-follow-ups
 * and mail-send both follow. mail_messages.client_send_id (= the row's id) is a
 * second lock on the same thing.
 *
 * THE OWNER IS TOLD: every outcome that is not "sent" is written on the row
 * (state, reason_code, a sentence in reason) AND pushed to the office's
 * SEE_MONEY phones (office-push.ts). Nothing here ends in silence: no address
 * on the job, a malformed address, no price, mail not configured, no reply
 * address, a rate limit, a refusal, an unconfirmed send, a database that
 * cannot take the claim -- each is recorded and pushed.
 *
 * NEVER FROM A TEST: not sent for a job marked is_test_fixture, nor for a
 * company whose name starts "ZZ TEST" (the convention send-welcome-email and the
 * fixtures use). The tests hand this function a model of Resend and of the
 * database; nothing in them can reach a real mailbox.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { isUuid, readJsonBody, triggerSecretMatches } from "../_shared/mail/caller.ts";
import { MailError, MESSAGES } from "../_shared/mail/errors.ts";
import type { MailErrorCode } from "../_shared/mail/errors.ts";
import {
  RESEND_SENDS_PER_DAY,
  RESEND_SENDS_PER_HOUR,
  STORED_HTML_MAX_BYTES,
  STORED_TEXT_MAX_BYTES,
} from "../_shared/mail/limits.ts";
import { addressText, capUtf8, counterpartEmails, snippetOf } from "../_shared/mail/message-meta.ts";
import type { MailAddress } from "../_shared/mail/message-meta.ts";
import {
  buildResendEmail,
  composeBody,
  fenceflowFooter,
  fenceflowFrom,
  isValidAddress,
  normalizeAddress,
} from "../_shared/mail/mime-build.ts";
import { fenceflowReplyTo, newMessageId } from "../_shared/mail/reply.ts";
import {
  CHANGE_ORDER_COLUMNS,
  CHANGE_ORDER_COLUMNS_BEFORE_ACCEPTANCE_FLAG,
  changeOrderInputs,
  depositFigures,
  missingAcceptanceFlag,
} from "../_shared/quote-deposit.ts";
import { buildApprovalEmail, contractKey, maskEmail, pickLang, sha256Hex } from "./email.ts";
import type { ContractFacts, Lang, RunFact } from "./email.ts";
import { pushToOffice } from "./office-push.ts";
import { publicPaymentMethods } from "./payment-methods.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
// deno-lint-ignore no-explicit-any
type Db = any;

const FN = "quote-approval-email";
const DEFAULT_MAIL_API_URL = "https://api.resend.com/emails";
const DEFAULT_SITE = "https://fenceflowapp.com";
/** Longest wait for Resend's answer; no answer by then is "unconfirmed", never "failed". */
export const RESEND_TIMEOUT_MS = 30_000;
/** Written on a send whose outcome is unknown; mail-send's own sentence, so the office reads one wording. */
export const UNCONFIRMED_NOTE = "FenceFlow could not confirm this email was sent. Check Sent before sending it again.";

const JOB_COLUMNS = "id, sync_id, company_id, customer_name, email, address, deleted_at, is_test_fixture, " +
  "quote_token, quote_approved_at, quote_approved_name, contract_total, deposit_amount, amount_paid, " +
  "refunded_amount, calibration_pixels_per_foot, reapproval_required_at";
const ACCEPTANCE_COLUMNS = "accepted_total, signed_at";

export type LedgerState = "sending" | "sent" | "failed" | "unconfirmed" | "no_address" | "not_priced";

// ---------------------------------------------------------------------------
// What the function needs from the outside world, so the Node tests can hand it
// a model of Resend, a model of Google, a fixed clock -- and nothing real.
// ---------------------------------------------------------------------------

export interface Deps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  env: (name: string) => string | undefined;
  now: () => number;
  uuid: () => string;
  /** Work allowed to finish after the answer; null when the runtime keeps it alive by itself. */
  background: (work: Promise<void>) => Promise<void> | null;
}

// deno-lint-ignore no-explicit-any
const denoGlobal = (): any => (globalThis as any).Deno;

export function productionDeps(): Deps {
  return {
    fetch: (url, init) => fetch(url, init),
    env: (name) => denoGlobal()?.env?.get(name) ?? undefined,
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
    background: (work) => {
      // deno-lint-ignore no-explicit-any
      const rt = (globalThis as any).EdgeRuntime;
      if (rt && typeof rt.waitUntil === "function") {
        rt.waitUntil(work);
        return null;
      }
      return work;
    },
  };
}

const envOf = (deps: Deps, name: string) => String(deps.env(name) ?? "").trim();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ---------------------------------------------------------------------------
// What each outcome says, to the office. Fixed sentences: nothing a server said
// is ever copied in, so a provider's error text cannot leak into a notification
// or a database row.
// ---------------------------------------------------------------------------

interface Outcome {
  state: Exclude<LedgerState, "sending" | "sent">;
  code: string;
  /** A sentence for the row (the office shows it). */
  reason: string;
  /** What the push says after "...but the contract email was not sent:". */
  short: string;
}

const NO_ADDRESS: Outcome = {
  state: "no_address",
  code: "no_address",
  reason: "There is no email address on this job, so no contract email could be sent.",
  short: "there is no email address on the job",
};
const BAD_ADDRESS: Outcome = {
  state: "no_address",
  code: "bad_address",
  reason: "The email address on this job is not a valid single address, so no contract email was sent.",
  short: "the email address on the job is not valid",
};
const NOT_PRICED: Outcome = {
  state: "not_priced",
  code: "not_priced",
  reason: "The quote has no price yet, so no contract email was sent.",
  short: "the quote has no price",
};
const LEDGER_UNAVAILABLE: Outcome = {
  state: "failed",
  code: "ledger_unavailable",
  reason: "Contract emails are not set up on the server yet (the send record could not be written), so nothing was sent.",
  short: "contract emails are not set up on the server yet",
};
const COULD_NOT_READ: Outcome = {
  state: "failed",
  code: "could_not_read",
  reason: "FenceFlow could not read this job's details just now, so no contract email was sent.",
  short: "FenceFlow could not read the job just now",
};
const UNEXPECTED: Outcome = {
  state: "failed",
  code: "server_error",
  reason: "Something went wrong on FenceFlow's side, so no contract email was sent.",
  short: "something went wrong on FenceFlow's side",
};
const UNCONFIRMED: Outcome = {
  state: "unconfirmed",
  code: "unconfirmed",
  reason: UNCONFIRMED_NOTE,
  short: "FenceFlow could not confirm it went out - check Sent in company email before sending it again",
};

/** The one sentence mail-send uses when a company has nowhere for customer replies to go. */
const NO_REPLY_ADDRESS = "Add your business email in Settings first, so replies to FenceFlow mail have somewhere to go.";

const REASON_BY_CODE: Partial<Record<MailErrorCode, string>> = {
  not_configured: "Company email is not set up on the server yet, so no contract email was sent.",
  rate_limited: `Company email has reached its sending limit (${RESEND_SENDS_PER_HOUR} an hour, ${RESEND_SENDS_PER_DAY} a day), so no contract email was sent.`,
  send_rejected: "The mail service refused to send it, so no contract email was sent.",
  too_large: "The contract email was too large to send, so nothing was sent.",
  server_error: "Something went wrong on FenceFlow's side, so no contract email was sent.",
};

const SHORT_BY_CODE: Partial<Record<MailErrorCode, string>> = {
  not_configured: "company email is not set up on the server yet",
  rate_limited: "company email has reached its sending limit",
  send_rejected: "the mail service refused it",
  too_large: "the email was too large",
  server_error: "something went wrong on FenceFlow's side",
};

/** A MailError as an outcome: the CODE decides the words. Nothing a server said is ever copied in. */
function outcomeFromMailError(e: MailError): Outcome {
  if (e.code === "bad_request" && e.detail === NO_REPLY_ADDRESS) {
    return {
      state: "failed",
      code: "no_reply_address",
      reason: "This company has no business email set, so customer replies would have nowhere to go. Add one in Settings; no contract email was sent.",
      short: "the company has no business email set, so customer replies would have nowhere to go",
    };
  }
  return {
    state: "failed",
    code: e.code,
    reason: REASON_BY_CODE[e.code] ?? `The mail service could not send it (${e.code}), so no contract email was sent.`,
    short: SHORT_BY_CODE[e.code] ?? "the mail service could not send it",
  };
}

/** Thrown when Resend may have accepted the message. */
class DeliveryUnknown extends MailError {
  constructor(code: MailErrorCode, detail = "") {
    super(code, detail);
    this.name = "DeliveryUnknown";
  }
}

// ---------------------------------------------------------------------------
// The ledger: one row per contract the customer approved.
// ---------------------------------------------------------------------------

interface LedgerClaim {
  id: string | null;
  /** True when this call got the row, and so owns the outcome. */
  mine: boolean;
  /** The earlier attempt's state, when someone else has the row. */
  existing: { state: string; reason_code: string | null } | null;
  /** The table or the write is unavailable: nothing can be recorded, so nothing may be sent. */
  unavailable: boolean;
}

async function claimLedger(db: Db, row: Row): Promise<LedgerClaim> {
  const { data, error } = await db.from("quote_approval_emails").insert(row).select("id").maybeSingle();
  if (!error && data?.id) return { id: String(data.id), mine: true, existing: null, unavailable: false };
  if (error && error.code === "23505") {
    const { data: prior, error: priorError } = await db.from("quote_approval_emails")
      .select("id, state, reason_code")
      .eq("company_id", row.company_id).eq("job_sync_id", row.job_sync_id).eq("contract_key", row.contract_key)
      .maybeSingle();
    if (priorError || !prior) return { id: null, mine: false, existing: { state: "sending", reason_code: null }, unavailable: false };
    return { id: String(prior.id), mine: false, existing: { state: String(prior.state), reason_code: prior.reason_code ?? null }, unavailable: false };
  }
  console.error(`${FN}: could not claim the send record (${String(error?.code ?? "no row back")})`);
  return { id: null, mine: false, existing: null, unavailable: true };
}

async function settleLedger(db: Db, deps: Deps, id: string, patch: Row): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { error } = await db.from("quote_approval_emails")
        .update({ ...patch, settled_at: new Date(deps.now()).toISOString() }).eq("id", id);
      if (!error) return;
    } catch {
      // tried again below
    }
  }
  console.error(`${FN}: could not record how a send ended`);
}

// ---------------------------------------------------------------------------
// The job's facts.
// ---------------------------------------------------------------------------

/** Whether an error is only "this database has no accepted_total yet". */
const lacksAcceptanceColumns = (error: { message?: string } | null | undefined) =>
  /accepted_total|signed_at/.test(String(error?.message ?? ""));

/** A read that failed is a failure, never an empty answer. */
function must<T>(result: { data: T; error: { message?: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}: ${String(result.error.message ?? "failed")}`);
  return result.data;
}

interface Loaded {
  facts: ContractFacts;
  suspended: boolean;
  recipient: string;
  companyEmail: string | null;
  companyName: string;
}

async function loadFacts(db: Db, deps: Deps, job: Row): Promise<Loaded> {
  const [company, runs, settings, connection, followUps] = await Promise.all([
    db.from("companies").select("name, phone, email, suspended").eq("id", job.company_id).maybeSingle(),
    db.from("fence_runs")
      .select("label, fence_type, color_or_finish, points_encoded, gates_encoded, closed_loop, panel_height_ft, " +
        "manual_linear_feet, fabric_height_ft, is_teardown")
      .eq("company_id", job.company_id).eq("job_sync_id", job.sync_id).is("deleted_at", null),
    db.from("company_settings").select("payment_methods:settings->payment_methods").eq("company_id", job.company_id).maybeSingle(),
    db.from("payment_connections").select("processor, external_id, access_token").eq("company_id", job.company_id).maybeSingle(),
    db.from("follow_up_settings").select("timezone").eq("company_id", job.company_id).maybeSingle(),
  ]);
  const co = must(company, "company");
  if (!co) throw new Error("company: not found");
  const runRows: Row[] = must(runs, "runs") ?? [];
  const paymentMethods = publicPaymentMethods(must(settings, "payment methods")?.payment_methods);
  const conn = must(connection, "payment connection");
  // The same test quote-view's paymentsReady uses: a real checkout exists.
  const cardOnline = !!(conn && (
    (conn.processor === "square" && conn.access_token && conn.external_id) ||
    (conn.processor === "stripe" && conn.external_id)
  ));
  // The company's own zone, when it has set one; the app's default otherwise.
  // A failure here only means the date is written in the default zone.
  const timeZone = String((followUps.error ? null : followUps.data?.timezone) || "America/New_York");

  let orders: Row[] = [];
  if (job.accepted_total != null) {
    const read = (columns: string) => db.from("change_orders").select(columns)
      .eq("company_id", job.company_id).eq("job_sync_id", job.sync_id);
    let res = await read(CHANGE_ORDER_COLUMNS);
    if (res.error && missingAcceptanceFlag(res.error)) res = await read(CHANGE_ORDER_COLUMNS_BEFORE_ACCEPTANCE_FLAG);
    orders = must(res, "change orders") ?? [];
  }
  // The very figures the quote page shows and create-payment-link charges
  // from: the accepted price (plus extra work signed since) and the STORED
  // deposit, capped at the job. Not recomputed, not "improved".
  const money = depositFigures({
    depositAmount: job.deposit_amount,
    contractTotal: job.contract_total,
    amountPaid: job.amount_paid,
    refundedAmount: job.refunded_amount,
    acceptedTotal: job.accepted_total == null ? null : Number(job.accepted_total),
    signedAt: job.signed_at ?? null,
    quoteApprovedAt: job.quote_approved_at,
    reapprovalRequiredAt: job.reapproval_required_at,
    changeOrders: changeOrderInputs(orders as Parameters<typeof changeOrderInputs>[0]),
  });

  const site = (envOf(deps, "SITE_URL") || DEFAULT_SITE).replace(/\/+$/, "");
  const facts: ContractFacts = {
    companyName: String(co.name ?? ""),
    companyPhone: String(co.phone ?? ""),
    customerName: String(job.customer_name ?? ""),
    address: String(job.address ?? ""),
    approvedBy: String(job.quote_approved_name ?? ""),
    approvedAt: String(job.quote_approved_at ?? ""),
    timeZone,
    runs: runRows.map((r): RunFact => ({
      teardown: !!r.is_teardown,
      label: String(r.label ?? ""),
      type: String(r.fence_type ?? ""),
      finish: String(r.color_or_finish ?? ""),
      points: String(r.points_encoded ?? ""),
      gates: String(r.gates_encoded ?? ""),
      closed: !!r.closed_loop,
      heightFt: Number(r.panel_height_ft) || Number(r.fabric_height_ft) || 6,
      manualFeet: Number(r.manual_linear_feet) || 0,
    })),
    pxPerFoot: Number(job.calibration_pixels_per_foot) || 20,
    total: money.total,
    deposit: money.asked,
    depositDue: money.due,
    // The same depositFigures().balance the quote page prints as "Balance
    // due". The email used to carry the total and the deposit and stop there,
    // so a customer reading the email beside the page saw a figure on one and
    // not the other -- and the one missing was the one that answers "what do
    // I owe after the deposit".
    balance: money.balance,
    payments: paymentMethods,
    cardOnline,
    quoteUrl: job.quote_token ? `${site}/quote.html?t=${job.quote_token}` : "",
  };
  return {
    facts,
    suspended: co.suspended === true,
    recipient: String(job.email ?? "").trim(),
    companyEmail: String(co.email ?? "").trim() || null,
    companyName: facts.companyName,
  };
}

// ---------------------------------------------------------------------------
// Sending: FenceFlow mail, as mail-send's viaFenceflow does it.
// ---------------------------------------------------------------------------

const PROVIDER_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const TOKEN_RE = /^[a-f0-9]{12,32}$/;
const bare = (address: string): MailAddress => ({ name: "", address });

/** POSTs one email to Resend. Same call, same Idempotency-Key, same classification of the answer as mail-send. */
async function postToResend(deps: Deps, url: string, key: string, payload: Row, idempotencyKey: string): Promise<string | null> {
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
  } catch (e) {
    const name = String((e as { name?: unknown })?.name ?? "");
    throw new DeliveryUnknown(/timeout|abort/i.test(name) ? "timeout" : "connect_failed", "No answer from FenceFlow mail.");
  }
  let answer: Row | null = null;
  try {
    answer = JSON.parse((await res.text()).slice(0, 4000));
  } catch {
    // The status is what decides.
  }
  if (res.ok) {
    const id = answer?.id;
    return typeof id === "string" && PROVIDER_ID_RE.test(id) ? id : null;
  }
  if (res.status >= 500 || res.status === 409) {
    console.error(`${FN}: FenceFlow mail answered ${res.status}`);
    throw new DeliveryUnknown("server_busy");
  }
  if (res.status === 401 || res.status === 403) {
    console.error(`${FN}: FenceFlow mail refused the server's key (${res.status})`);
    throw new MailError("not_configured", "FenceFlow mail refused the server's key.");
  }
  if (res.status === 429) throw new MailError("rate_limited", "FenceFlow mail is busy.");
  if (res.status === 413) throw new MailError("too_large");
  throw new MailError("send_rejected");
}

/** One send from the ledger: the hour recorded and counted, the day counted. An answer that is not a number refuses. */
async function spendSend(db: Db, companyId: string): Promise<void> {
  const { data: hour, error } = await db.rpc("note_mail_event", {
    p_company: companyId, p_actor: null, p_kind: "send_resend", p_window: "1 hour",
  });
  if (error || typeof hour !== "number") throw new MailError("server_error");
  if (hour > RESEND_SENDS_PER_HOUR) {
    throw new MailError("rate_limited", `Company email sends at most ${RESEND_SENDS_PER_HOUR} emails an hour and ${RESEND_SENDS_PER_DAY} a day this way.`);
  }
  const { data: day, error: dayError } = await db.rpc("mail_event_count", {
    p_company: companyId, p_kind: "send_resend", p_window: "1 day",
  });
  if (dayError || typeof day !== "number") throw new MailError("server_error");
  if (day > RESEND_SENDS_PER_DAY) {
    throw new MailError("rate_limited", `Company email sends at most ${RESEND_SENDS_PER_HOUR} emails an hour and ${RESEND_SENDS_PER_DAY} a day this way.`);
  }
}

interface SendResult {
  state: "sent" | "unconfirmed";
  mailMessageId: string;
  providerId: string | null;
}

/**
 * Everything between "this call owns the ledger row" and "the provider has
 * answered". Throws MailError for anything that certainly did not send and
 * DeliveryUnknown for anything that may have.
 */
async function sendViaFenceflow(
  db: Db, deps: Deps, job: Row, loaded: Loaded, lang: Lang, ledgerId: string, to: string,
): Promise<SendResult> {
  const key = envOf(deps, "MAIL_API_KEY");
  const mailFrom = envOf(deps, "MAIL_FROM");
  if (!key || !mailFrom) throw new MailError("not_configured", "FenceFlow mail is not set up on the server.");
  const from = fenceflowFrom(loaded.companyName, mailFrom, envOf(deps, "MAIL_FROM_NAME") || "FenceFlow");

  // Where replies go is settled before anything is recorded or spent.
  const inboundDomain = envOf(deps, "MAIL_INBOUND_DOMAIN").toLowerCase();
  let inboundReady = false;
  if (inboundDomain && envOf(deps, "RESEND_WEBHOOK_SECRET") && envOf(deps, "RESEND_RECEIVING_KEY")) {
    const { data, error } = await db.from("mail_platform_settings").select("inbound_verified_at").eq("id", 1).maybeSingle();
    if (error) throw new MailError("server_error");
    inboundReady = Boolean(data?.inbound_verified_at);
  }
  const accountFor = async (): Promise<string> => {
    const { data, error } = await db.rpc("mail_fenceflow_account", { p_company: job.company_id, p_email: from.address });
    if (error || !isUuid(data)) throw new MailError("server_error");
    return data;
  };
  let accountId: string | null = inboundReady ? await accountFor() : null;
  let inboundToken: string | null = null;
  if (accountId) {
    const { data, error } = await db.from("mail_accounts").select("inbound_token")
      .eq("id", accountId).eq("company_id", job.company_id).maybeSingle();
    if (error) throw new MailError("server_error");
    inboundToken = typeof data?.inbound_token === "string" ? data.inbound_token : null;
  }
  const replyInput = { inboundReady, inboundDomain, inboundToken, replyToken: null as string | null, companyEmail: loaded.companyEmail };
  const reply = fenceflowReplyTo(replyInput);
  if (reply.mode === "unavailable") {
    throw new MailError("bad_request", NO_REPLY_ADDRESS);
  }
  accountId ??= await accountFor();

  await spendSend(db, String(job.company_id));

  const email = buildApprovalEmail(loaded.facts, lang);
  const composed = composeBody({ text: email.text, footer: fenceflowFooter(loaded.companyName) });
  const messageId = newMessageId(from.address, deps.uuid());
  const payload = buildResendEmail({
    from, to: [to], replyTo: reply.replyTo, subject: email.subject, text: composed.text, html: composed.html, messageId,
  });

  // The Sent view's copy, recorded BEFORE a byte goes to the provider. client_send_id is the ledger row's id,
  // so this can exist at most once for the contract. A brand-new thread has no reply token until this call
  // makes it, so an inbound Reply-To is completed after the claim (the same as mail-send).
  const finalReplyLater = reply.mode === "inbound";
  const nowIso = new Date(deps.now()).toISOString();
  const text = capUtf8(composed.text, STORED_TEXT_MAX_BYTES);
  const html = capUtf8(composed.html, STORED_HTML_MAX_BYTES);
  const toList = [bare(to)];
  const { data: ingested, error: ingestError } = await db.rpc("mail_ingest", {
    p_account: accountId,
    p_rows: [{
      folder_role: "sent",
      source: "fenceflow_send",
      client_send_id: ledgerId,
      send_state: "sending",
      message_id_header: messageId,
      parent_ids: [],
      from_address: from.address.toLowerCase(),
      from_name: from.name || null,
      to_list: toList,
      cc_list: [],
      reply_to_list: reply.replyTo && !finalReplyLater ? [bare(reply.replyTo)] : [],
      to_text: addressText(toList),
      counterpart_emails: counterpartEmails([toList], { addresses: [from.address], domains: inboundDomain ? [inboundDomain] : [] }),
      subject: email.subject,
      sent_at: nowIso,
      received_at: nowIso,
      size_bytes: new TextEncoder().encode(composed.text + composed.html).length,
      has_attachments: false,
      is_seen: true,
      snippet: snippetOf(email.text),
      body_state: "cached",
      body_text: text.text,
      body_html: html.text,
      body_truncated: text.truncated || html.truncated,
      attachments: [],
      job_sync_id: job.sync_id,
    }],
  });
  const hit = !ingestError && Array.isArray(ingested) && ingested.length === 1 ? (ingested[0] as Row) : null;
  if (!hit || !isUuid(hit.message_id) || !isUuid(hit.thread_id) || typeof hit.inserted !== "boolean") {
    throw new MailError("server_error", "Could not record the email before sending it.");
  }
  const mailMessageId = String(hit.message_id);
  if (!hit.inserted) {
    // This contract's mail row already exists: an earlier call sent, or began to. Never send a second copy.
    const { data: prior } = await db.from("mail_messages").select("send_state")
      .eq("id", mailMessageId).eq("company_id", job.company_id).maybeSingle();
    if (prior?.send_state === "sent") return { state: "sent", mailMessageId, providerId: null };
    throw new DeliveryUnknown("server_busy");
  }

  const settleMail = async (patch: Row) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { error } = await db.from("mail_messages").update(patch)
          .eq("id", mailMessageId).eq("company_id", job.company_id).eq("send_state", "sending");
        if (!error) return;
      } catch {
        // tried again
      }
    }
    console.error(`${FN}: could not record how a send ended`);
  };

  try {
    if (finalReplyLater) {
      const { data, error } = await db.from("mail_threads").select("reply_token")
        .eq("id", hit.thread_id).eq("company_id", job.company_id).maybeSingle();
      if (error) throw new MailError("server_error");
      const token = typeof data?.reply_token === "string" && TOKEN_RE.test(data.reply_token) ? data.reply_token : null;
      const completed = fenceflowReplyTo({ ...replyInput, replyToken: token }).replyTo;
      if (!completed) throw new MailError("server_error", "No address for replies.");
      payload.reply_to = normalizeAddress(completed);
    }
  } catch (e) {
    const err = e instanceof MailError ? e : new MailError("server_error");
    await settleMail({ send_state: "failed", send_error: String(MESSAGES[err.code]).slice(0, 300) });
    throw err;
  }

  let providerId: string | null;
  try {
    providerId = await postToResend(deps, envOf(deps, "MAIL_API_URL") || DEFAULT_MAIL_API_URL, key, payload, `fenceflow-mail-${mailMessageId}`);
  } catch (e) {
    if (e instanceof DeliveryUnknown) {
      await settleMail({ send_error: UNCONFIRMED_NOTE });
      throw e;
    }
    const err = e instanceof MailError ? e : new MailError("server_error");
    await settleMail({ send_state: "failed", send_error: String(MESSAGES[err.code]).slice(0, 300) });
    throw err;
  }
  await settleMail({
    send_state: "sent",
    send_error: null,
    ...(providerId ? { provider_message_id: providerId } : {}),
    ...(finalReplyLater && payload.reply_to ? { reply_to_list: [bare(String(payload.reply_to))] } : {}),
  });
  return { state: "sent", mailMessageId, providerId };
}

// ---------------------------------------------------------------------------
// The door.
// ---------------------------------------------------------------------------

/** What the office is told when it is told. No amount, no address. */
function failureNotice(customerName: string, outcome: Outcome): { title: string; body: string } {
  const who = String(customerName ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || "A customer";
  if (outcome.state === "unconfirmed") {
    return {
      title: "Contract email: could not confirm",
      body: `${who} approved the quote. The contract email may or may not have gone out: ${outcome.short}.`,
    };
  }
  return {
    title: "Contract email NOT sent",
    body: `${who} approved the quote, but the contract email was not sent: ${outcome.short}. ` +
      `Send it yourself, or ask them to download a copy from their quote link.`,
  };
}

export async function handleRequest(req: Request, deps: Deps = productionDeps()): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // The door, before the body is read. An unset secret opens nothing.
  const expected = envOf(deps, "NOTIFY_TRIGGER_SECRET");
  if (!expected) {
    console.error(`${FN}: NOTIFY_TRIGGER_SECRET is not set; refusing to run.`);
    return json({ error: "not configured" }, 503);
  }
  if (!(await triggerSecretMatches(req.headers.get("x-fenceflow-trigger"), expected))) {
    return json({ error: "unauthorized" }, 401);
  }

  try {
    let body: Row;
    try {
      body = await readJsonBody(req, 4096);
    } catch {
      return json({ error: "bad request" }, 400);
    }
    if (!isUuid(body.job_id)) return json({ error: "bad request" }, 400);
    const jobId = String(body.job_id).toLowerCase();
    const lang = pickLang(body.lang, body.accept_language);

    const url = envOf(deps, "SUPABASE_URL");
    const serviceKey = envOf(deps, "SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) return json({ error: "not configured" }, 503);
    const db: Db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    // ----- the job, and whether anything may be sent for it at all -----------
    let jobRead = await db.from("jobs").select(`${JOB_COLUMNS}, ${ACCEPTANCE_COLUMNS}`).eq("id", jobId).maybeSingle();
    if (jobRead.error && lacksAcceptanceColumns(jobRead.error)) {
      jobRead = await db.from("jobs").select(JOB_COLUMNS).eq("id", jobId).maybeSingle();
    }
    if (jobRead.error) {
      console.error(`${FN}: could not read the job`);
      return json({ error: "could not read the job" }, 500);
    }
    const job: Row | null = jobRead.data;
    if (!job) return json({ state: "not_found" }, 404);
    if (job.deleted_at) return json({ state: "skipped", reason: "deleted" });
    // Never email a fixture, and never email for a test company: both hold addresses that may be real
    // ones a person reused. send-follow-ups and send-welcome-email draw the same lines.
    if (job.is_test_fixture === true) return json({ state: "skipped", reason: "test fixture" });
    if (!job.quote_approved_at) return json({ state: "not_approved" }, 409);

    // ----- everything the email will state -----------------------------------
    let loaded: Loaded | null = null;
    let key: string;
    let outcome: Outcome | null = null;
    try {
      loaded = await loadFacts(db, deps, job);
      key = await contractKey(loaded.facts);
    } catch (e) {
      console.error(`${FN}: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      key = await sha256Hex(`unread:${job.sync_id}:${job.quote_approved_at}`);
      outcome = COULD_NOT_READ;
    }
    if (loaded && /^\s*zz test/i.test(loaded.companyName)) return json({ state: "skipped", reason: "test company" });
    // A company that has been switched off sends nothing. (quote-view has already judged the company's whole
    // standing -- trial, billing, grace -- before an approval can land; this is only the hard stop.)
    if (loaded?.suspended) return json({ state: "skipped", reason: "company suspended" });

    // ----- is there anything to send, and anywhere to send it ----------------
    let to = "";
    if (!outcome && loaded) {
      if (!loaded.recipient) outcome = NO_ADDRESS;
      else if (!isValidAddress(loaded.recipient)) outcome = BAD_ADDRESS;
      else to = normalizeAddress(loaded.recipient);
    }
    if (!outcome && loaded && !(loaded.facts.total > 0.005)) outcome = NOT_PRICED;

    // ----- claim: the email goes only to the call that gets this row ---------
    const claim = await claimLedger(db, {
      company_id: job.company_id,
      job_sync_id: job.sync_id,
      contract_key: key,
      state: outcome ? outcome.state : "sending",
      reason_code: outcome ? outcome.code : null,
      reason: outcome ? outcome.reason : null,
      sent_to: to || null,
      lang,
      ...(outcome ? { settled_at: new Date(deps.now()).toISOString() } : {}),
    });
    if (claim.unavailable) {
      // Nothing can be recorded, so nothing may be sent: "sent twice" has no guard. Say so, loudly.
      await tell(db, deps, job, LEDGER_UNAVAILABLE);
      return json({ state: "failed", reason_code: LEDGER_UNAVAILABLE.code });
    }
    if (!claim.mine) {
      return json({ state: claim.existing?.state ?? "sending", duplicate: true, ...(claim.existing?.reason_code ? { reason_code: claim.existing.reason_code } : {}) });
    }
    const ledgerId = claim.id as string;
    if (outcome) {
      await tell(db, deps, job, outcome);
      return json({ state: outcome.state, reason_code: outcome.code });
    }

    // ----- send ---------------------------------------------------------------
    let result: SendResult | null = null;
    let failure: Outcome | null = null;
    try {
      result = await sendViaFenceflow(db, deps, job, loaded as Loaded, lang, ledgerId, to);
    } catch (e) {
      failure = e instanceof DeliveryUnknown ? UNCONFIRMED : e instanceof MailError ? outcomeFromMailError(e) : UNEXPECTED;
      if (!(e instanceof MailError)) console.error(`${FN}: unexpected ${(e as { name?: string })?.name ?? typeof e}`);
    }
    if (result) {
      await settleLedger(db, deps, ledgerId, {
        state: result.state,
        mail_message_id: result.mailMessageId,
        provider_message_id: result.providerId,
        reason_code: null,
        reason: null,
      });
      return json({ state: result.state, to: maskEmail(to) });
    }
    const f = failure as Outcome;
    await settleLedger(db, deps, ledgerId, { state: f.state, reason_code: f.code, reason: f.reason });
    await tell(db, deps, job, f);
    return json({
      state: f.state,
      reason_code: f.code,
      ...(f.state === "unconfirmed" ? { to: maskEmail(to) } : {}),
    });
  } catch (e) {
    console.error(`${FN}: unexpected ${(e as { name?: string })?.name ?? typeof e}`);
    return json({ error: "unexpected error" }, 500);
  }
}

/** Push the office about an outcome that is not "sent". After the answer where the runtime allows. */
async function tell(db: Db, deps: Deps, job: Row, outcome: Outcome): Promise<void> {
  const notice = failureNotice(String(job.customer_name ?? ""), outcome);
  const work = pushToOffice(db, deps, String(job.company_id), notice.title, notice.body).then((told) => {
    if (told === 0) console.error(`${FN}: nobody was pushed about a contract email that was not sent (${outcome.code})`);
  });
  const pending = deps.background(work);
  if (pending) await pending;
}

// Deno serves; under Node (tests/a55-approval-email-send.test.mjs) there is no
// Deno.serve and the handler is called directly with fake dependencies.
if (typeof denoGlobal()?.serve === "function") denoGlobal().serve((req: Request) => handleRequest(req));
