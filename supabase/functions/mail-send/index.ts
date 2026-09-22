/**
 * mail-send -- sends one email from the office: through a company mailbox's
 * own SMTP server (port 465, implicit TLS), or as "FenceFlow mail" through
 * Resend under the company's name.
 *
 *   POST {
 *     client_send_id: uuid,                  one per compose window
 *     from_account_id: uuid | "fenceflow",   a live mailbox of the company
 *     to: string[], cc?: string[], bcc?: string[],
 *     subject: string, text: string,         plain text; the HTML is made from it
 *     reply_to_message_id?: uuid,            the mail_messages row being answered
 *     forward_of_message_id?: uuid,          ...or forwarded (not both)
 *     forward_attachment_idx?: number[],     that message's STORED attachments to include
 *     attachment_paths?: string[],           <company>/outgoing/<you>/<uuid>/<name> in mail-files
 *     job_sync_id?: uuid                     also links the thread to this job
 *   }
 *
 * THE ANSWER. Once the send has been recorded (the claim, below) every answer
 * carries `state`, and `state` is what the office must go by. message_id is
 * the mail_messages row, not the Message-ID header.
 *
 *   200 {ok:true, state:"sent", message_id, thread_id}
 *   200 {ok:<state=="sent">, duplicate:true, state, message_id, thread_id, send_error?}
 *         this client_send_id was used before; NOTHING was sent this time
 *   4xx/5xx {error_code, message, detail?, state:"failed", message_id, thread_id}
 *         certainly not sent. To try again, use a NEW client_send_id: the old
 *         one answers "duplicate" from now on.
 *   502 {error_code, message, state:"sending", unconfirmed:true, message_id, thread_id}
 *         it may have gone out. Say "could not confirm; check Sent before
 *         sending again", never "failed".
 *   4xx/5xx {error_code, message, detail?}   (no state)
 *         refused before anything was recorded or sent.
 *
 * WHO. mailCaller() is the whole gate (getUser on the bearer, then
 * can_use_company_mail() asked with the caller's own token, exactly true).
 * Anyone who passes may send from any live mailbox of their own company: the
 * account, the message being answered and the thread are all read through
 * the CALLER's client first, so RLS proves they are that company's before the
 * service role goes near a password or a file.
 *
 * FROM IS NEVER THE REQUEST'S. A mailbox sends as its own address, MAIL FROM
 * included, with its display name (or the company's name). FenceFlow mail
 * sends as the company's name on the bare address inside MAIL_FROM. Nothing
 * in the request can name a sender, add a header or reach the SMTP envelope:
 * addresses are refused, never repaired, if they carry a line break, space or
 * bracket (mime-build.ts), and Bcc exists only in the envelope (SMTP) or in
 * Resend's own bcc field, never as a header.
 *
 * CLAIM BEFORE SENDING. The message is written to mail_messages through
 * mail_ingest with send_state 'sending' BEFORE a byte goes to a mail server.
 * mail_ingest de-duplicates on (company, client_send_id) under the company's
 * advisory lock, so a double click, a retried request or two tabs can send a
 * message at most once. Then:
 *  - accepted -> 'sent';
 *  - refused, or failed before any of the message went out -> 'failed';
 *  - no verdict once the message was on its way (the connection dropped
 *    after DATA began, Resend timed out or answered 5xx) -> left 'sending'.
 *    That fails toward not sending twice: the office says "check Sent".
 *
 * RATE. note_mail_event records the attempt and counts the hour; the day is
 * counted without recording (mail_event_count), so a send is never counted
 * twice. SMTP: 20 an hour and 200 a day per company; FenceFlow mail: 20 and
 * 100. Refused attempts count, so hammering the button burns the budget. An
 * answer that is not a number refuses the send.
 *
 * ATTACHMENTS go through storage, never the request: the office uploads to
 * its own <company>/outgoing/<uid>/<uuid>/ folder (the one INSERT policy on
 * mail-files) and names the paths here. Each path must be exactly that shape
 * with the caller's own company and user id; a forwarded attachment must be
 * one the forwarded message has stored under the caller's company. At most 5,
 * 10 MB together. They are read with the service role only after those
 * checks, and the sent message's row points at the same objects so it can be
 * opened later from Sent.
 *
 * THE PASSWORD is read from Vault (mail_secret_get, service role only) after
 * the gate, handed to the SMTP (and, after sending, IMAP) sign-in and to
 * redact(), and to nothing else. It is never logged, stored or returned;
 * both clients hide their AUTH/LOGIN lines and redact every server line, and
 * anything written to send_error or last_error is redacted again here. A
 * refused password marks the mailbox auth_failed, which stops the schedule
 * presenting it again (the lockout rule) and refuses further sends until the
 * owner enters a new one.
 *
 * STORED HOSTS ARE CHECKED AGAIN, not trusted from the row: a preset mailbox
 * must still name its provider's own servers, and a custom one is
 * re-validated and re-resolved -- any private address refuses it -- before
 * any socket opens (hosts.ts). Failures to reach a custom host are collapsed
 * the way mail-connect collapses them (errors.forCustomHost).
 *
 * AFTER AN SMTP SEND, in the background (EdgeRuntime.waitUntil), one IMAP
 * session: \Answered on the message being answered when it lives in this
 * same mailbox's inbox, and the Sent copy. Zoho files what its SMTP sends
 * unless told not to, Gmail always does; for anyone else the first send
 * waits, looks for the copy by its Message-ID, and APPENDs one only if it is
 * still missing after a second look, remembering the answer in
 * smtp_saves_sent. A copy that turns up later re-binds FenceFlow's row
 * through mail_ingest (by Message-ID) instead of duplicating it.
 *
 * FENCEFLOW MAIL replies go to the company's email, or -- once receiving is
 * configured AND proven by a signed webhook -- back into FenceFlow through
 * <inbound_token>.<thread reply_token>@MAIL_INBOUND_DOMAIN. With neither
 * there is nowhere honest for a reply to land (it would reach FenceFlow's own
 * mailbox carrying another company's customer), so the send is refused. The
 * Resend call carries the row id as its Idempotency-Key.
 */

import { corsHeaders, errorResponse, isUuid, json, loadAccountAsCaller, mailCaller, readJsonBody } from "../_shared/mail/caller.ts";
import type { MailCaller } from "../_shared/mail/caller.ts";
import { accountStatusFor, errorBody, forCustomHost, MailError, MESSAGES, redact } from "../_shared/mail/errors.ts";
import type { MailErrorCode } from "../_shared/mail/errors.ts";
import { denoResolver, resolveAndCheck, resolvePreset, validateCustomHost, ZOHO_REGIONS } from "../_shared/mail/hosts.ts";
import type { MailHosts, Resolver } from "../_shared/mail/hosts.ts";
import { ImapClient, openSession, setFlag } from "../_shared/mail/imap-client.ts";
import {
  ATTACHMENTS_TOTAL_MAX_BYTES,
  IMAP_PORT,
  MAX_ATTACHMENTS,
  MAX_RECIPIENTS_RESEND,
  MAX_RECIPIENTS_SMTP,
  RESEND_SENDS_PER_DAY,
  RESEND_SENDS_PER_HOUR,
  SMTP_PORT,
  SMTP_SENDS_PER_DAY,
  SMTP_SENDS_PER_HOUR,
  STORED_HTML_MAX_BYTES,
  STORED_TEXT_MAX_BYTES,
} from "../_shared/mail/limits.ts";
import { addressText, capUtf8, counterpartEmails, parentIdsOf, snippetOf, storageContentType } from "../_shared/mail/message-meta.ts";
import type { MailAddress } from "../_shared/mail/message-meta.ts";
import {
  buildMime,
  buildResendEmail,
  cleanDisplayName,
  cleanFilename,
  composeBody,
  fenceflowFooter,
  fenceflowFrom,
  normalizeAddress,
  safeContentType,
  validateSendFields,
} from "../_shared/mail/mime-build.ts";
import type { SendFields } from "../_shared/mail/mime-build.ts";
import { fenceflowReplyTo, newMessageId, replyThreading } from "../_shared/mail/reply.ts";
import { isUnconfirmed, sendMessage, SmtpClient } from "../_shared/mail/smtp-client.ts";
import { connectTls } from "../_shared/mail/tls-transport.ts";
import type { ConnectOptions, MailTransport } from "../_shared/mail/tls-transport.ts";

type Row = Record<string, unknown>;

const FN = "mail-send";
const BUCKET = "mail-files";
const DEFAULT_MAIL_API_URL = "https://api.resend.com/emails";

// ---------------------------------------------------------------------------
// Numbers that belong to this function alone. Everything shared is in
// limits.ts.
// ---------------------------------------------------------------------------

/** One SMTP send, connect to QUIT. A 10 MB message takes seconds; this
 *  leaves the rest of the gateway's 150 s for the database work around it. */
export const SMTP_SEND_SESSION_MS = 60_000;
/** Longest wait for Resend's answer. No answer by then is "could not
 *  confirm", never "failed": it may have been accepted. */
export const RESEND_TIMEOUT_MS = 30_000;
/** The after-send IMAP session (\Answered, the Sent copy). */
export const SENT_COPY_SESSION_MS = 40_000;
/** The first send from a mailbox waits this long before looking for the copy
 *  its server may have filed in Sent... */
export const SENT_COPY_FIRST_WAIT_MS = 3_000;
/** ...and, when it is not there yet, this much longer before concluding the
 *  server does not keep one. Appending too early means a duplicate in Sent
 *  on every send from then on. */
export const SENT_COPY_SECOND_WAIT_MS = 4_000;
/** Characters of Resend's answer read. It is a small JSON object. */
const RESEND_ANSWER_MAX_CHARS = 4_000;
/** Stored for a send whose outcome is unknown; the office shows it on the row. */
export const UNCONFIRMED_NOTE = "FenceFlow could not confirm this email was sent. Check Sent before sending it again.";

/** Codes that mean the mailbox refused its password: the account becomes
 *  auth_failed so neither the schedule nor the next send presents it again. */
const CREDENTIAL_CODES: ReadonlySet<MailErrorCode> = new Set<MailErrorCode>(["auth_failed", "smtp_auth_failed", "imap_disabled_or_plan"]);

// ---------------------------------------------------------------------------
// What the function needs from the outside world, so the Node tests can give
// it fake mail servers, a fake Resend, a fake clock and call the real handler
// exactly as the gateway does.
// ---------------------------------------------------------------------------

export interface SendDeps {
  connect: (opts: ConnectOptions) => Promise<MailTransport>;
  resolver: Resolver | null;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  env: (name: string) => string | undefined;
  uuid: () => string;
  /** Work allowed to finish after the answer. Returns null when the runtime
   *  keeps it alive by itself (EdgeRuntime.waitUntil); otherwise returns the
   *  work for the handler to await before answering. */
  background: (work: Promise<void>) => Promise<void> | null;
}

// deno-lint-ignore no-explicit-any
const denoGlobal = (): any => (globalThis as any).Deno;

export function productionDeps(): SendDeps {
  return {
    connect: connectTls,
    resolver: denoResolver(),
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    env: (name) => denoGlobal()?.env?.get(name) ?? undefined,
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

function envOf(deps: SendDeps, name: string): string {
  return String(deps.env(name) ?? "").trim();
}

// ---------------------------------------------------------------------------
// The request.
// ---------------------------------------------------------------------------

export interface SendRequest {
  clientSendId: string;
  /** A mailbox id, or "fenceflow". */
  fromAccount: string;
  replyToMessageId: string | null;
  forwardOfMessageId: string | null;
  forwardIdx: number[];
  attachmentPaths: string[];
  jobSyncId: string | null;
}

function optionalUuid(v: unknown, what: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (!isUuid(v)) throw new MailError("bad_request", `Invalid ${what}.`);
  return v.toLowerCase();
}

function optionalList(v: unknown, what: string): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new MailError("bad_request", `${what} must be a list.`);
  if (v.length > MAX_ATTACHMENTS) throw new MailError("bad_request", `At most ${MAX_ATTACHMENTS} attachments.`);
  return v;
}

/**
 * An uploaded attachment's path, or bad_request. Exactly
 * <company>/outgoing/<uid>/<uuid>/<name>, with the caller's own company and
 * user id -- the shape the storage INSERT policy allowed them to write, so
 * nobody can send a colleague's upload, another company's file or anything
 * mail-message stored for an inbox.
 */
export function outgoingPath(raw: unknown, companyId: string, uid: string): string {
  const refuse = () => new MailError("bad_request", "An attachment is not one you uploaded. Attach it again.");
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024) throw refuse();
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1f\x7f\\]/.test(raw)) throw refuse();
  const parts = raw.split("/");
  if (parts.length !== 5) throw refuse();
  const [company, outgoing, owner, folder, name] = parts;
  if (company !== companyId || outgoing !== "outgoing" || owner !== uid || !isUuid(folder)) throw refuse();
  if (!name || name === "." || name === ".." || name.length > 255) throw refuse();
  return raw;
}

/** A stored attachment's path from a message row: inside the caller's
 *  company, no empty, "." or ".." segment, nothing odd in it. The row was
 *  written by our own service role; this is the second lock on the door. */
export function storedPathInCompany(raw: unknown, companyId: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024) return null;
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1f\x7f\\]/.test(raw)) return null;
  const parts = raw.split("/");
  if (parts.length < 3 || parts[0] !== companyId) return null;
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return raw;
}

/** Everything in the request except the recipients, subject and text, which
 *  are checked once the sending path (and so the recipient cap) is known. */
export function parseRequest(body: Row, caller: { companyId: string; uid: string }): SendRequest {
  if (!isUuid(body.client_send_id)) throw new MailError("bad_request", "Missing client_send_id.");
  const from = body.from_account_id;
  let fromAccount: string;
  if (from === "fenceflow") fromAccount = "fenceflow";
  else if (isUuid(from)) fromAccount = from.toLowerCase();
  else throw new MailError("bad_request", "Choose the mailbox to send from.");

  const replyToMessageId = optionalUuid(body.reply_to_message_id, "message to reply to");
  const forwardOfMessageId = optionalUuid(body.forward_of_message_id, "message to forward");
  if (replyToMessageId && forwardOfMessageId) throw new MailError("bad_request", "Reply or forward, not both.");

  const idx = optionalList(body.forward_attachment_idx, "forward_attachment_idx");
  if (idx.length && !forwardOfMessageId) throw new MailError("bad_request", "Attachments can only be forwarded from a forwarded email.");
  const forwardIdx: number[] = [];
  for (const i of idx) {
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= 50 || forwardIdx.includes(i)) {
      throw new MailError("bad_request", "Invalid attachment to forward.");
    }
    forwardIdx.push(i);
  }

  const attachmentPaths: string[] = [];
  for (const p of optionalList(body.attachment_paths, "attachment_paths")) {
    const path = outgoingPath(p, caller.companyId, caller.uid);
    if (attachmentPaths.includes(path)) throw new MailError("bad_request", "The same file is attached twice.");
    attachmentPaths.push(path);
  }
  if (forwardIdx.length + attachmentPaths.length > MAX_ATTACHMENTS) {
    throw new MailError("bad_request", `At most ${MAX_ATTACHMENTS} attachments.`);
  }

  return {
    clientSendId: String(body.client_send_id).toLowerCase(),
    fromAccount,
    replyToMessageId,
    forwardOfMessageId,
    forwardIdx,
    attachmentPaths,
    jobSyncId: optionalUuid(body.job_sync_id, "job"),
  };
}

// ---------------------------------------------------------------------------
// Which servers a stored mailbox may be reached at.
// ---------------------------------------------------------------------------

/**
 * The SMTP and IMAP hosts of a stored mailbox, re-vetted now. A preset row
 * must name exactly what hosts.ts would pick for its address today (in any
 * offered Zoho region); a custom row is validated and resolved again, so a
 * name re-pointed at a private address since it was connected is refused
 * before any socket opens. Ports are 993 and 465 or nothing.
 */
export async function hostsFor(row: Row, resolver: Resolver | null): Promise<MailHosts> {
  const provider = String(row.provider ?? "");
  const imapHost = String(row.imap_host ?? "").trim().toLowerCase();
  const smtpHost = String(row.smtp_host ?? "").trim().toLowerCase();
  if (Number(row.imap_port) !== IMAP_PORT || Number(row.smtp_port) !== SMTP_PORT) {
    throw new MailError("host_not_allowed", "Only ports 993 and 465 are used.");
  }
  if (provider === "zoho" || provider === "gmail") {
    const regions = provider === "zoho" ? Object.keys(ZOHO_REGIONS) : ["us"];
    const matches = regions.some((region) => {
      try {
        const h = resolvePreset(provider, String(row.email_address ?? ""), region);
        return h.imapHost === imapHost && h.smtpHost === smtpHost;
      } catch {
        return false;
      }
    });
    if (!matches) throw new MailError("host_not_allowed", "The stored server is not the provider's own.");
    return { provider, imapHost, smtpHost, imapPort: IMAP_PORT, smtpPort: SMTP_PORT, custom: false };
  }
  if (provider !== "custom") throw new MailError("host_not_allowed");
  const imap = validateCustomHost(imapHost);
  const smtp = validateCustomHost(smtpHost);
  await Promise.all([resolveAndCheck(imap, resolver), resolveAndCheck(smtp, resolver)]);
  return { provider: "custom", imapHost: imap, smtpHost: smtp, imapPort: IMAP_PORT, smtpPort: SMTP_PORT, custom: true };
}

// ---------------------------------------------------------------------------
// Database. Reads that decide what the caller may touch go through their own
// client (RLS); every service-role query filters company_id itself.
// ---------------------------------------------------------------------------

const PARENT_COLUMNS =
  "id, company_id, account_id, thread_id, folder_role, source, uidvalidity, uid, message_id_header, parent_ids, attachments, is_answered";

/** The message being answered or forwarded, read under the caller's RLS. */
async function loadParent(caller: MailCaller, id: string): Promise<Row> {
  const { data, error } = await caller.userClient
    .from("mail_messages").select(PARENT_COLUMNS).eq("id", id).eq("company_id", caller.companyId).maybeSingle();
  if (error) throw new MailError("server_error");
  if (!data) throw new MailError("not_found", "The email you are answering was not found.");
  return data as Row;
}

const TOKEN_RE = /^[a-f0-9]{12,32}$/;

/** A thread's reply_token, through whichever client is given (the caller's
 *  for a parent's thread; the service role for the thread the claim made). */
async function threadToken(
  client: MailCaller["userClient"],
  companyId: string,
  threadId: unknown,
): Promise<string | null> {
  if (!isUuid(threadId)) return null;
  const { data, error } = await client
    .from("mail_threads").select("reply_token").eq("id", threadId).eq("company_id", companyId).maybeSingle();
  if (error) throw new MailError("server_error");
  const token = (data as Row | null)?.reply_token;
  return typeof token === "string" && TOKEN_RE.test(token) ? token : null;
}

interface PriorSend {
  id: string;
  thread_id: string;
  send_state: string | null;
  send_error: string | null;
}

/** A send already recorded under this client_send_id, if any. */
async function priorSend(caller: MailCaller, clientSendId: string): Promise<PriorSend | null> {
  const { data, error } = await caller.userClient
    .from("mail_messages").select("id, thread_id, send_state, send_error")
    .eq("company_id", caller.companyId).eq("client_send_id", clientSendId).maybeSingle();
  if (error) throw new MailError("server_error");
  return (data as PriorSend | null) ?? null;
}

/** One send from the ledger: the hour recorded and counted, the day counted.
 *  Anything but a number refuses: an empty answer read as "under the limit"
 *  is how limits vanish. */
async function spendSend(caller: MailCaller, kind: "send_smtp" | "send_resend"): Promise<void> {
  const perHour = kind === "send_smtp" ? SMTP_SENDS_PER_HOUR : RESEND_SENDS_PER_HOUR;
  const perDay = kind === "send_smtp" ? SMTP_SENDS_PER_DAY : RESEND_SENDS_PER_DAY;
  const { data: hour, error } = await caller.admin.rpc("note_mail_event", {
    p_company: caller.companyId,
    p_actor: caller.uid,
    p_kind: kind,
    p_window: "1 hour",
  });
  if (error || typeof hour !== "number") throw new MailError("server_error");
  if (hour > perHour) {
    throw new MailError("rate_limited", `Company email sends at most ${perHour} emails an hour and ${perDay} a day this way.`);
  }
  const { data: day, error: dayError } = await caller.admin.rpc("mail_event_count", {
    p_company: caller.companyId,
    p_kind: kind,
    p_window: "1 day",
  });
  if (dayError || typeof day !== "number") throw new MailError("server_error");
  if (day > perDay) {
    throw new MailError("rate_limited", `Company email sends at most ${perHour} emails an hour and ${perDay} a day this way.`);
  }
}

/** The mailbox's app password, or auth_failed (recorded on the account) when
 *  none is stored. */
async function readSecret(caller: MailCaller, account: Row): Promise<string> {
  const { data, error } = await caller.admin.rpc("mail_secret_get", { p_account: String(account.id) });
  if (error) throw new MailError("server_error");
  if (typeof data !== "string" || !data) {
    const missing = new MailError("auth_failed", "No app password is stored for this mailbox. The owner can enter a new one in Settings.");
    await recordCredentialFailure(caller, account, missing, []);
    throw missing;
  }
  return data;
}

/** A refused password, written to the account so the office shows it and the
 *  schedule stops presenting it. Best effort: the refusal itself is what the
 *  sender is told. Never revives a disconnected mailbox. */
async function recordCredentialFailure(caller: MailCaller, account: Row, err: MailError, secrets: ReadonlyArray<string>): Promise<void> {
  if (!CREDENTIAL_CODES.has(err.code)) return;
  try {
    const { error } = await caller.admin.from("mail_accounts").update({
      status: accountStatusFor(err.code),
      last_error_code: err.code,
      last_error: redact(err.detail, secrets) || MESSAGES[err.code],
      last_error_at: new Date().toISOString(),
    }).eq("id", String(account.id)).eq("company_id", caller.companyId).neq("status", "disconnected");
    if (error) console.error(`${FN}: could not record a refused password`);
  } catch {
    console.error(`${FN}: could not record a refused password`);
  }
}

interface Claimed {
  messageId: string;
  threadId: string;
  inserted: boolean;
}

/** Records the send ('sending') before anything goes out. inserted=false
 *  means this client_send_id was already there: send nothing. */
async function claim(caller: MailCaller, accountId: string, row: Row): Promise<Claimed> {
  const { data, error } = await caller.admin.rpc("mail_ingest", { p_account: accountId, p_rows: [row] });
  if (error) throw new MailError("server_error", "Could not record the email before sending it.");
  const hit = Array.isArray(data) && data.length === 1 ? (data[0] as Row) : null;
  if (!hit || !isUuid(hit.message_id) || !isUuid(hit.thread_id) || typeof hit.inserted !== "boolean") {
    throw new MailError("server_error", "Recording the email gave an unexpected answer.");
  }
  return { messageId: String(hit.message_id), threadId: String(hit.thread_id), inserted: hit.inserted };
}

/** The outcome, written only while the row is still 'sending' (a sync that
 *  found the server's Sent copy may already have marked it sent). Tried twice;
 *  a failure is logged, not thrown: what happened to the email is what the
 *  sender must be told. */
async function settle(caller: MailCaller, claimed: Claimed, patch: Row): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { error } = await caller.admin.from("mail_messages").update(patch)
        .eq("id", claimed.messageId).eq("company_id", caller.companyId).eq("send_state", "sending");
      if (!error) return;
    } catch {
      // Tried again below.
    }
  }
  console.error(`${FN}: could not record how a send ended`);
}

async function markAnswered(caller: MailCaller, messageId: string): Promise<void> {
  const { error } = await caller.admin.from("mail_messages").update({ is_answered: true })
    .eq("id", messageId).eq("company_id", caller.companyId);
  if (error) console.error(`${FN}: could not mark the answered email`);
}

// ---------------------------------------------------------------------------
// Attachments.
// ---------------------------------------------------------------------------

interface Gathered {
  filename: string;
  /** As labelled by whoever stored it; cleaned again for each use. */
  type: string;
  content: Uint8Array;
  storagePath: string;
}

async function download(caller: MailCaller, path: string): Promise<{ content: Uint8Array; type: string }> {
  const missing = () => new MailError("bad_request", "An attachment could not be found. Attach it again.");
  let blob: Blob | null;
  try {
    const { data, error } = await caller.admin.storage.from(BUCKET).download(path);
    if (error) throw missing();
    blob = data;
  } catch {
    throw missing();
  }
  if (!blob) throw missing();
  if (blob.size > ATTACHMENTS_TOTAL_MAX_BYTES) throw new MailError("too_large", "Attachments are larger than 10 MB in total.");
  return { content: new Uint8Array(await blob.arrayBuffer()), type: blob.type };
}

/** Forwarded attachments first (in the order asked for), then uploads. The
 *  10 MB total is checked after every file, so a batch stops at the first
 *  one that crosses it. */
async function gatherAttachments(caller: MailCaller, req: SendRequest, parent: Row | null): Promise<Gathered[]> {
  const out: Gathered[] = [];
  let total = 0;
  const add = (g: Gathered) => {
    total += g.content.length;
    if (total > ATTACHMENTS_TOTAL_MAX_BYTES) throw new MailError("too_large", "Attachments are larger than 10 MB in total.");
    out.push(g);
  };

  if (req.forwardIdx.length) {
    const stored = parent && Array.isArray(parent.attachments) ? (parent.attachments as Row[]) : [];
    for (const idx of req.forwardIdx) {
      const a = stored.find((x) => x && typeof x === "object" && x.idx === idx);
      const path = a && a.state === "stored" ? storedPathInCompany(a.storage_path, caller.companyId) : null;
      if (!a || !path) {
        throw new MailError("bad_request", "That attachment is not available to forward. Open the email first, or attach the file again.");
      }
      const file = await download(caller, path);
      add({ filename: cleanFilename(a.filename), type: String(a.content_type ?? file.type ?? ""), content: file.content, storagePath: path });
    }
  }
  for (const path of req.attachmentPaths) {
    const file = await download(caller, path);
    add({ filename: cleanFilename(path.slice(path.lastIndexOf("/") + 1)), type: file.type, content: file.content, storagePath: path });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The message and its row.
// ---------------------------------------------------------------------------

/**
 * In-Reply-To and References. A reply carries both (RFC 5322 3.6.4). A
 * forward carries References only: the recipient's mail program starts a new
 * conversation, while FenceFlow keeps it in the thread it came from (the
 * claim names that thread's reply_token).
 */
function threadingFor(req: SendRequest, parent: Row | null): { inReplyTo: string | null; references: string[] } {
  if (!parent) return { inReplyTo: null, references: [] };
  const t = replyThreading({
    message_id_header: typeof parent.message_id_header === "string" ? parent.message_id_header : null,
    parent_ids: Array.isArray(parent.parent_ids) ? (parent.parent_ids as string[]) : [],
  });
  return req.forwardOfMessageId ? { inReplyTo: null, references: t.references } : t;
}

interface ClaimInput {
  req: SendRequest;
  uid: string;
  fields: SendFields;
  from: { name: string; address: string };
  replyTo: string | null;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  body: { text: string; html: string };
  attachments: Gathered[];
  sizeBytes: number;
  now: Date;
  /** Domains that are FenceFlow's own (the inbound reply domain). */
  ownDomains: string[];
  replyToken: string | null;
}

const bare = (address: string): MailAddress => ({ name: "", address });

/**
 * The mail_ingest row for a send, in the key names supabase_mail.sql reads.
 * The row is the Sent view's copy of the message: the body is cached (so it
 * opens without a server round trip), the attachments point at the objects
 * that were sent. Bcc recipients are not shown as a header anywhere, but do
 * count as counterparts, so a blind copy to a customer still links the
 * thread to their job.
 */
export function claimRow(i: ClaimInput): Row {
  const to = i.fields.to.map(bare);
  const cc = i.fields.cc.map(bare);
  const bcc = i.fields.bcc.map(bare);
  const text = capUtf8(i.body.text, STORED_TEXT_MAX_BYTES);
  const html = capUtf8(i.body.html, STORED_HTML_MAX_BYTES);
  const nowIso = i.now.toISOString();
  const refs = i.references.map((r) => `<${r}>`).join(" ");
  return {
    folder_role: "sent",
    source: "fenceflow_send",
    client_send_id: i.req.clientSendId,
    send_state: "sending",
    message_id_header: i.messageId,
    parent_ids: parentIdsOf(i.inReplyTo ? `<${i.inReplyTo}>` : null, refs, i.messageId),
    from_address: i.from.address.toLowerCase(),
    from_name: i.from.name || null,
    to_list: to,
    cc_list: cc,
    reply_to_list: i.replyTo ? [bare(i.replyTo)] : [],
    to_text: addressText([...to, ...cc]),
    counterpart_emails: counterpartEmails([to, cc, bcc], { addresses: [i.from.address], domains: i.ownDomains }),
    subject: i.fields.subject,
    sent_at: nowIso,
    received_at: nowIso,
    size_bytes: i.sizeBytes,
    has_attachments: i.attachments.length > 0,
    is_seen: true,
    snippet: snippetOf(i.fields.text),
    body_state: "cached",
    body_text: text.text,
    body_html: html.text,
    body_truncated: text.truncated || html.truncated,
    attachments: i.attachments.map((a, idx) => ({
      idx,
      filename: a.filename,
      content_type: storageContentType(a.type),
      size: a.content.length,
      content_id: null,
      disposition: "attachment",
      storage_path: a.storagePath,
      state: "stored",
    })),
    sent_by: i.uid,
    job_sync_id: i.req.jobSyncId,
    ...(i.replyToken ? { reply_token: i.replyToken } : {}),
  };
}

// ---------------------------------------------------------------------------
// Answers.
// ---------------------------------------------------------------------------

function duplicateAnswer(prior: PriorSend | null, claimed: Claimed | null): Response {
  const state = prior?.send_state ?? "sending";
  return json({
    ok: state === "sent",
    duplicate: true,
    state,
    message_id: prior?.id ?? claimed?.messageId ?? null,
    thread_id: prior?.thread_id ?? claimed?.threadId ?? null,
    ...(prior?.send_error && state !== "sent" ? { send_error: prior.send_error } : {}),
  });
}

/** Certainly not sent. The row says why, redacted. */
async function failed(caller: MailCaller, claimed: Claimed, err: MailError, secrets: ReadonlyArray<string>): Promise<Response> {
  const body = errorBody(err, secrets);
  await settle(caller, claimed, {
    send_state: "failed",
    send_error: redact(`${MESSAGES[err.code]}${body.detail ? ` ${body.detail}` : ""}`, secrets),
  });
  if (err.status >= 500) console.error(`${FN}: send failed (${err.code})`);
  return json({ ...body, state: "failed", message_id: claimed.messageId, thread_id: claimed.threadId }, err.status);
}

/** Maybe sent. The row stays 'sending', with a note saying so. */
async function unconfirmed(caller: MailCaller, claimed: Claimed, e: unknown, secrets: ReadonlyArray<string>): Promise<Response> {
  const err = e instanceof MailError ? e : new MailError("connect_failed");
  await settle(caller, claimed, { send_error: UNCONFIRMED_NOTE });
  console.error(`${FN}: send outcome unknown (${err.code})`);
  return json(
    { ...errorBody(err, secrets), state: "sending", unconfirmed: true, message_id: claimed.messageId, thread_id: claimed.threadId },
    502,
  );
}

function sentAnswer(claimed: Claimed): Response {
  return json({ ok: true, state: "sent", message_id: claimed.messageId, thread_id: claimed.threadId });
}

// ---------------------------------------------------------------------------
// After an SMTP send: \Answered and the Sent copy.
// ---------------------------------------------------------------------------

/** A folder path fit for the columns that hold one. */
function usablePath(v: unknown): string | null {
  const s = typeof v === "string" ? v : "";
  // deno-lint-ignore no-control-regex
  return s && s.length <= 300 && !/[\x00-\x1f\x7f]/.test(s) ? s : null;
}

function uidOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,10}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 4294967295 ? n : null;
}

/** Where the answered message lives on the server, when FenceFlow can mark
 *  it: an inbox message of the SAME mailbox that sent the reply, not yet
 *  answered. Another mailbox's message is left alone (it would mean a second
 *  sign-in for a cosmetic flag), and a DB-only mark would be undone by that
 *  mailbox's next sync. */
function answerTarget(parent: Row | null, account: Row): { uidValidity: number; uid: number } | null {
  if (!parent || parent.source !== "imap" || parent.folder_role !== "inbox" || parent.is_answered === true) return null;
  if (String(parent.account_id ?? "") !== String(account.id)) return null;
  const uidValidity = uidOf(parent.uidvalidity);
  const uid = uidOf(parent.uid);
  return uidValidity !== null && uid !== null ? { uidValidity, uid } : null;
}

async function inboxPath(caller: MailCaller, accountId: string): Promise<string> {
  const { data, error } = await caller.admin
    .from("mail_folder_state").select("path").eq("account_id", accountId).eq("role", "inbox").maybeSingle();
  if (error) throw new MailError("server_error");
  return usablePath((data as Row | null)?.path) ?? "INBOX";
}

/**
 * Makes sure the Sent folder holds a copy of what was just sent: looks for
 * it by Message-ID and APPENDs one only if it is missing. When it is not yet
 * known whether this server files its own copies (`patient`), it looks a
 * second time after SENT_COPY_SECOND_WAIT_MS before deciding it does not;
 * the caller has already waited SENT_COPY_FIRST_WAIT_MS before connecting.
 */
export async function ensureSentCopy(
  imap: ImapClient,
  path: string,
  messageId: string,
  message: Uint8Array,
  patient: boolean,
  sleep: (ms: number) => Promise<void>,
): Promise<"found" | "appended"> {
  await imap.examine(path);
  if ((await imap.uidSearchMessageId(messageId)).length) return "found";
  if (patient) {
    await sleep(SENT_COPY_SECOND_WAIT_MS);
    // A fresh EXAMINE, so a copy filed meanwhile is certainly seen.
    await imap.examine(path);
    if ((await imap.uidSearchMessageId(messageId)).length) return "found";
  }
  await imap.append(path, message, ["\\Seen"]);
  return "appended";
}

interface FollowUp {
  caller: MailCaller;
  deps: SendDeps;
  account: Row;
  hosts: MailHosts;
  password: string;
  messageId: string;
  message: Uint8Array;
  parent: Row | null;
}

/** Never throws, never logs more than a code: it runs after the answer. */
async function afterSmtpSend(f: FollowUp): Promise<void> {
  const { account, caller } = f;
  const savesSent = account.smtp_saves_sent === true ? true : account.smtp_saves_sent === false ? false : null;
  const sentFolder = usablePath(account.sent_folder);
  const needCopy = account.provider !== "gmail" && savesSent !== true && sentFolder !== null;
  const answer = answerTarget(f.parent, account);
  if (!needCopy && !answer) return;

  let imap: ImapClient | null = null;
  try {
    if (needCopy && savesSent === null) await f.deps.sleep(SENT_COPY_FIRST_WAIT_MS);
    imap = new ImapClient(await f.deps.connect({
      hostname: f.hosts.imapHost,
      port: f.hosts.imapPort,
      limits: { sessionDeadlineMs: SENT_COPY_SESSION_MS },
    }));
    await openSession(imap, { username: String(account.username ?? ""), password: f.password });

    if (answer && f.parent) {
      try {
        const path = await inboxPath(caller, String(account.id));
        const done = await setFlag(imap, { path, uidValidity: answer.uidValidity, uid: answer.uid, flag: "\\Answered", on: true });
        if (done === "ok") await markAnswered(caller, String(f.parent.id));
      } catch (e) {
        console.error(`${FN}: could not mark the answered email (${e instanceof MailError ? e.code : "unexpected"})`);
      }
    }

    if (needCopy && sentFolder) {
      const outcome = await ensureSentCopy(imap, sentFolder, f.messageId, f.message, savesSent === null, f.deps.sleep);
      const learned = outcome === "found";
      if (savesSent !== learned) {
        const { error } = await caller.admin.from("mail_accounts").update({ smtp_saves_sent: learned })
          .eq("id", String(account.id)).eq("company_id", caller.companyId).neq("status", "disconnected");
        if (error) console.error(`${FN}: could not remember whether the server keeps sent mail`);
      }
    }
    await imap.logout();
  } catch (e) {
    const err = e instanceof MailError ? e : new MailError("server_error");
    await recordCredentialFailure(caller, account, err, [f.password]);
    console.error(`${FN}: the step after sending failed (${err.code})`);
  } finally {
    imap?.close();
  }
}

// ---------------------------------------------------------------------------
// Sending from a company mailbox.
// ---------------------------------------------------------------------------

async function viaMailbox(caller: MailCaller, deps: SendDeps, req: SendRequest, body: Row, account: Row, secrets: string[]): Promise<Response> {
  if (account.status === "disconnected") throw new MailError("not_found", "That mailbox is disconnected. The owner can connect it again in Settings.");
  if (account.status === "auth_failed") {
    // Presenting a password the server already refused is how mailboxes get
    // locked; nothing is tried until the owner enters a new one.
    throw new MailError("auth_failed", "This mailbox's app password stopped working. The owner can enter a new one in Settings.");
  }
  const fields = validateSendFields(body, MAX_RECIPIENTS_SMTP);
  const parentId = req.replyToMessageId ?? req.forwardOfMessageId;
  const parent = parentId ? await loadParent(caller, parentId) : null;
  const replyToken = parent ? await threadToken(caller.userClient, caller.companyId, parent.thread_id) : null;

  const prior = await priorSend(caller, req.clientSendId);
  if (prior) return duplicateAnswer(prior, null);

  await spendSend(caller, "send_smtp");
  const hosts = await hostsFor(account, deps.resolver);
  const password = await readSecret(caller, account);
  secrets.push(password);
  const attachments = await gatherAttachments(caller, req, parent);

  const from = {
    name: cleanDisplayName(account.display_name) || cleanDisplayName(caller.companyName),
    address: normalizeAddress(account.email_address),
  };
  const now = new Date(deps.now());
  const messageId = newMessageId(from.address, deps.uuid());
  const threading = threadingFor(req, parent);
  const composed = composeBody({ text: fields.text, signature: typeof account.signature === "string" ? account.signature : null });
  const built = buildMime({
    from,
    to: fields.to,
    cc: fields.cc,
    subject: fields.subject,
    text: composed.text,
    html: composed.html,
    messageId,
    inReplyTo: threading.inReplyTo,
    references: threading.references,
    date: now,
    attachments: attachments.map((a) => ({ filename: a.filename, contentType: safeContentType(a.type), content: a.content })),
  });

  const claimed = await claim(caller, String(account.id), claimRow({
    req,
    uid: caller.uid,
    fields,
    from,
    replyTo: null,
    messageId,
    inReplyTo: threading.inReplyTo,
    references: threading.references,
    body: composed,
    attachments,
    sizeBytes: built.bytes.length,
    now,
    ownDomains: [],
    replyToken,
  }));
  if (!claimed.inserted) return duplicateAnswer(await priorSend(caller, req.clientSendId), claimed);

  try {
    const client = new SmtpClient(await deps.connect({
      hostname: hosts.smtpHost,
      port: hosts.smtpPort,
      limits: { sessionDeadlineMs: SMTP_SEND_SESSION_MS },
    }));
    await sendMessage(
      client,
      { username: String(account.username ?? ""), password },
      { from: from.address, recipients: [...fields.to, ...fields.cc, ...fields.bcc] },
      built.bytes,
    );
  } catch (e) {
    // Once DATA began, only the server knows; and an exception that is not
    // one of ours cannot say where it happened. Both fail toward "maybe".
    if (isUnconfirmed(e) || !(e instanceof MailError)) return await unconfirmed(caller, claimed, e, secrets);
    const err = hosts.custom ? forCustomHost(e, "smtp") : e;
    await recordCredentialFailure(caller, account, err, secrets);
    return await failed(caller, claimed, err, secrets);
  }

  await settle(caller, claimed, { send_state: "sent", send_error: null });
  if (parent?.source === "resend_inbound") await markAnswered(caller, String(parent.id));
  const pending = deps.background(afterSmtpSend({
    caller,
    deps,
    account,
    hosts,
    password,
    messageId,
    message: built.bytes,
    parent,
  }));
  if (pending) await pending;
  return sentAnswer(claimed);
}

// ---------------------------------------------------------------------------
// Sending as FenceFlow mail (Resend).
// ---------------------------------------------------------------------------

/** Thrown when Resend may have accepted the message: no answer, a timeout, a
 *  5xx, or a 409 about the idempotency key. */
class DeliveryUnknown extends MailError {
  constructor(code: MailErrorCode, detail = "") {
    super(code, detail);
    this.name = "DeliveryUnknown";
  }
}

const PROVIDER_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/** What Resend said, as one short clean line, for the sender to read. */
function resendSaid(answer: unknown): string {
  const m = (answer as Row | null)?.message;
  return typeof m === "string" ? m.slice(0, 200) : "";
}

/**
 * POSTs one email to Resend. Returns its id (null if the answer had none).
 * A 4xx other than 409 is a definite refusal; anything that may have been
 * accepted throws DeliveryUnknown. Logs the status only: the answer may name
 * recipients, and the key is never in anything logged or returned.
 */
async function postToResend(deps: SendDeps, url: string, key: string, payload: Row, idempotencyKey: string): Promise<string | null> {
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
  } catch (e) {
    const name = String((e as { name?: unknown })?.name ?? "");
    throw new DeliveryUnknown(/timeout|abort/i.test(name) ? "timeout" : "connect_failed", "No answer from FenceFlow mail.");
  }
  let answer: unknown = null;
  try {
    answer = JSON.parse((await res.text()).slice(0, RESEND_ANSWER_MAX_CHARS));
  } catch {
    // The status is what decides; the body only adds detail.
  }
  if (res.ok) {
    const id = (answer as Row | null)?.id;
    return typeof id === "string" && PROVIDER_ID_RE.test(id) ? id : null;
  }
  const said = resendSaid(answer);
  if (res.status >= 500 || res.status === 409) {
    console.error(`${FN}: FenceFlow mail answered ${res.status}`);
    throw new DeliveryUnknown("server_busy", said);
  }
  if (res.status === 401 || res.status === 403) {
    console.error(`${FN}: FenceFlow mail refused the server's key (${res.status})`);
    throw new MailError("not_configured", "FenceFlow mail refused the server's key.");
  }
  if (res.status === 429) throw new MailError("rate_limited", "FenceFlow mail is busy. Try again in a minute.");
  if (res.status === 413) throw new MailError("too_large", said);
  throw new MailError("send_rejected", said);
}

/** The company's FenceFlow-mail account, created on first use by the RPC
 *  (race-safe; PostgREST cannot upsert against a partial unique index). */
async function fenceflowAccount(caller: MailCaller, address: string): Promise<string> {
  const { data, error } = await caller.admin.rpc("mail_fenceflow_account", { p_company: caller.companyId, p_email: address });
  if (error || !isUuid(data)) throw new MailError("server_error");
  return data;
}

/** Replies come back into FenceFlow only once receiving is configured AND a
 *  signed webhook has proven it -- the same test mail-connect's status uses. */
async function inboundState(caller: MailCaller, deps: SendDeps): Promise<{ ready: boolean; domain: string }> {
  const domain = envOf(deps, "MAIL_INBOUND_DOMAIN").toLowerCase();
  if (!domain || !envOf(deps, "RESEND_WEBHOOK_SECRET") || !envOf(deps, "RESEND_RECEIVING_KEY")) return { ready: false, domain };
  const { data, error } = await caller.admin
    .from("mail_platform_settings").select("inbound_verified_at").eq("id", 1).maybeSingle();
  if (error) throw new MailError("server_error");
  return { ready: Boolean((data as Row | null)?.inbound_verified_at), domain };
}

async function viaFenceflow(caller: MailCaller, deps: SendDeps, req: SendRequest, body: Row, secrets: string[]): Promise<Response> {
  const key = envOf(deps, "MAIL_API_KEY");
  const mailFrom = envOf(deps, "MAIL_FROM");
  if (!key || !mailFrom) throw new MailError("not_configured", "FenceFlow mail is not set up on the server.");
  secrets.push(key);
  const from = fenceflowFrom(caller.companyName, mailFrom, envOf(deps, "MAIL_FROM_NAME") || "FenceFlow");
  const fields = validateSendFields(body, MAX_RECIPIENTS_RESEND);
  const parentId = req.replyToMessageId ?? req.forwardOfMessageId;
  const parent = parentId ? await loadParent(caller, parentId) : null;
  const parentToken = parent ? await threadToken(caller.userClient, caller.companyId, parent.thread_id) : null;

  // Where replies go is settled before anything is recorded or spent: with
  // nowhere honest for them to land, the send is refused outright.
  const inbound = await inboundState(caller, deps);
  let accountId: string | null = inbound.ready ? await fenceflowAccount(caller, from.address) : null;
  let inboundToken: string | null = null;
  if (accountId) {
    const { data, error } = await caller.admin
      .from("mail_accounts").select("inbound_token").eq("id", accountId).eq("company_id", caller.companyId).maybeSingle();
    if (error) throw new MailError("server_error");
    const t = (data as Row | null)?.inbound_token;
    inboundToken = typeof t === "string" ? t : null;
  }
  const replyInput = {
    inboundReady: inbound.ready,
    inboundDomain: inbound.domain,
    inboundToken,
    replyToken: parentToken,
    companyEmail: caller.companyEmail,
  };
  const reply = fenceflowReplyTo(replyInput);
  if (reply.mode === "unavailable") {
    throw new MailError("bad_request", "Add your business email in Settings first, so replies to FenceFlow mail have somewhere to go.");
  }

  const prior = await priorSend(caller, req.clientSendId);
  if (prior) return duplicateAnswer(prior, null);
  accountId ??= await fenceflowAccount(caller, from.address);

  await spendSend(caller, "send_resend");
  const attachments = await gatherAttachments(caller, req, parent);

  const now = new Date(deps.now());
  const messageId = newMessageId(from.address, deps.uuid());
  const threading = threadingFor(req, parent);
  const composed = composeBody({ text: fields.text, footer: fenceflowFooter(caller.companyName) });
  const payload = buildResendEmail({
    from,
    to: fields.to,
    cc: fields.cc,
    bcc: fields.bcc,
    replyTo: reply.replyTo,
    subject: fields.subject,
    text: composed.text,
    html: composed.html,
    messageId,
    inReplyTo: threading.inReplyTo,
    references: threading.references,
    attachments: attachments.map((a) => ({ filename: a.filename, content: a.content })),
  });
  // A brand-new thread has no reply_token until the claim makes it, so an
  // inbound Reply-To is completed after the claim.
  const finalReplyLater = reply.mode === "inbound" && !parentToken;

  const claimed = await claim(caller, accountId, claimRow({
    req,
    uid: caller.uid,
    fields,
    from,
    replyTo: finalReplyLater ? null : reply.replyTo,
    messageId,
    inReplyTo: threading.inReplyTo,
    references: threading.references,
    body: composed,
    attachments,
    sizeBytes: attachments.reduce((n, a) => n + a.content.length, 0) + new TextEncoder().encode(composed.text + composed.html).length,
    now,
    ownDomains: inbound.domain ? [inbound.domain] : [],
    replyToken: parentToken,
  }));
  if (!claimed.inserted) return duplicateAnswer(await priorSend(caller, req.clientSendId), claimed);

  let replyTo = reply.replyTo;
  try {
    if (finalReplyLater) {
      const token = await threadToken(caller.admin, caller.companyId, claimed.threadId);
      replyTo = fenceflowReplyTo({ ...replyInput, replyToken: token }).replyTo;
      if (!replyTo) throw new MailError("server_error", "No address for replies.");
      payload.reply_to = normalizeAddress(replyTo);
    }
  } catch (e) {
    return await failed(caller, claimed, e instanceof MailError ? e : new MailError("server_error"), secrets);
  }

  let providerId: string | null;
  try {
    providerId = await postToResend(deps, envOf(deps, "MAIL_API_URL") || DEFAULT_MAIL_API_URL, key, payload, `fenceflow-mail-${claimed.messageId}`);
  } catch (e) {
    if (e instanceof DeliveryUnknown) return await unconfirmed(caller, claimed, e, secrets);
    return await failed(caller, claimed, e instanceof MailError ? e : new MailError("server_error"), secrets);
  }

  await settle(caller, claimed, {
    send_state: "sent",
    send_error: null,
    ...(providerId ? { provider_message_id: providerId } : {}),
    ...(finalReplyLater && replyTo ? { reply_to_list: [bare(replyTo)] } : {}),
  });
  if (parent?.source === "resend_inbound") await markAnswered(caller, String(parent.id));
  return sentAnswer(claimed);
}

// ---------------------------------------------------------------------------
// The door.
// ---------------------------------------------------------------------------

export async function handleRequest(req: Request, deps: SendDeps = productionDeps()): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error_code: "bad_request", message: MESSAGES.bad_request }, 405);

  // Every secret this request comes to hold, for redacting whatever goes back.
  const secrets: string[] = [];
  try {
    // Who is asking comes first: nobody's body is read before the gate.
    const caller = await mailCaller(req);
    const body = await readJsonBody(req);
    const parsed = parseRequest(body, caller);
    if (parsed.fromAccount === "fenceflow") return await viaFenceflow(caller, deps, parsed, body, secrets);
    const account = await loadAccountAsCaller(caller, parsed.fromAccount);
    if (account.kind === "fenceflow") return await viaFenceflow(caller, deps, parsed, body, secrets);
    if (account.kind !== "imap") throw new MailError("bad_request", "Choose the mailbox to send from.");
    return await viaMailbox(caller, deps, parsed, body, account, secrets);
  } catch (e) {
    return errorResponse(FN, e, secrets);
  }
}

// Deno serves; under Node (tests/mail-send.test.mjs) there is no Deno.serve
// and the handler is called directly with fake dependencies.
if (typeof denoGlobal()?.serve === "function") denoGlobal().serve((req: Request) => handleRequest(req));
