/**
 * What went wrong, in words the office can show, with the password taken out.
 *
 * Every failure in company email ends up as a MailError with a fixed code.
 * The code decides three things, and each of them matters:
 *
 *  - What the office says. `message` is fixed English text per code (the
 *    office translates by code); the server's own words ride along in
 *    `detail` only after redact() has removed the password.
 *  - The HTTP status the function answers with.
 *  - What the account's status becomes (accountStatusFor). `auth_failed`
 *    accounts are skipped by the scheduled sync entirely, because a
 *    schedule that keeps presenting a wrong password every ten minutes is
 *    how Zoho or Google locks the mailbox. So anything that smells like
 *    "your credentials were refused" classifies as auth_failed, and only
 *    clearly temporary refusals are allowed to retry.
 *
 * Nothing here touches Deno, the network or the clock, so
 * tests/mail-errors.test.mjs imports it under plain Node.
 */

import { LAST_ERROR_MAX_CHARS } from "./limits.ts";

export type MailErrorCode =
  // The request itself.
  | "no_session"
  | "mail_forbidden"
  | "owner_only"
  | "bad_request"
  | "too_large"
  | "rate_limited"
  | "not_found"
  | "not_configured"
  | "server_error"
  // The mailbox refused us.
  | "auth_failed"
  | "imap_disabled_or_plan"
  | "smtp_auth_failed"
  | "recipient_rejected"
  | "send_rejected"
  // We could not reach or understand the mail server.
  | "tls_failed"
  | "timeout"
  | "dns_failed"
  | "connect_failed"
  | "smtp_587_only"
  | "host_not_allowed"
  | "microsoft_oauth_only"
  | "server_busy"
  | "protocol_error"
  | "folder_missing"
  | "session_limit";

/** Fixed, safe text per code. Never includes anything the server said. */
export const MESSAGES: Record<MailErrorCode, string> = {
  no_session: "Sign in again to use company email.",
  mail_forbidden: "Your account does not have access to company email.",
  owner_only: "Only the owner can change the company mailbox.",
  bad_request: "That request was not understood.",
  too_large: "That is too large to send through FenceFlowApp.",
  rate_limited: "Too many attempts. Wait a while and try again.",
  not_found: "That email or mailbox was not found.",
  not_configured: "Company email is not set up on the server yet.",
  server_error: "Something went wrong on FenceFlowApp's side. Try again in a moment.",
  auth_failed: "The mail server did not accept that address and app password.",
  imap_disabled_or_plan:
    "The mailbox refused IMAP. Switch on IMAP access in your mail settings, and check that your plan includes it.",
  smtp_auth_failed: "The outgoing mail server did not accept that address and app password.",
  recipient_rejected: "The mail server refused one of the addresses, so nothing was sent.",
  send_rejected: "The mail server refused to send this message.",
  tls_failed: "Could not open a secure (SSL) connection to the mail server.",
  timeout: "The mail server took too long to answer.",
  dns_failed: "That server name was not found. Check the spelling.",
  connect_failed: "Could not reach the mail server.",
  smtp_587_only:
    "Could not connect to the outgoing server on port 465 with SSL. Servers that only accept port 587 cannot send from FenceFlowApp.",
  host_not_allowed: "That server address is not allowed.",
  microsoft_oauth_only:
    "Outlook and Microsoft 365 only allow Microsoft's own sign-in, so they cannot be connected with an app password.",
  server_busy: "The mail server is busy or has paused sign-ins. Try again later.",
  protocol_error: "The mail server answered in a way FenceFlowApp did not understand.",
  folder_missing: "That mail folder no longer exists in the mailbox.",
  session_limit: "The mail server sent more than FenceFlowApp can take in one go.",
};

const HTTP_STATUS: Record<MailErrorCode, number> = {
  no_session: 401,
  mail_forbidden: 403,
  owner_only: 403,
  bad_request: 400,
  too_large: 413,
  rate_limited: 429,
  not_found: 404,
  not_configured: 503,
  server_error: 500,
  // The owner can fix these by typing something different.
  auth_failed: 422,
  imap_disabled_or_plan: 422,
  smtp_auth_failed: 422,
  recipient_rejected: 422,
  send_rejected: 422,
  dns_failed: 422,
  smtp_587_only: 422,
  host_not_allowed: 422,
  microsoft_oauth_only: 422,
  // The far end misbehaved or could not be reached.
  tls_failed: 502,
  timeout: 502,
  connect_failed: 502,
  server_busy: 502,
  protocol_error: 502,
  session_limit: 502,
  folder_missing: 404,
};

export const MAIL_ERROR_CODES = Object.keys(MESSAGES) as MailErrorCode[];

/** Control characters out, whitespace collapsed. Server text is displayed
 *  and stored, so a bare CR or an ANSI escape must not survive. */
function sanitizeText(value: unknown): string {
  // deno-lint-ignore no-control-regex
  return String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export class MailError extends Error {
  code: MailErrorCode;
  /** Already safe to store in last_error and to show: control characters
   *  removed and capped. Creation sites that hold a password run server
   *  text through redact() BEFORE it gets here. */
  detail: string;

  constructor(code: MailErrorCode, detail = "") {
    const clean = truncate(sanitizeText(detail), LAST_ERROR_MAX_CHARS);
    super(clean ? `${code}: ${clean}` : code);
    this.name = "MailError";
    this.code = code;
    this.detail = clean;
  }

  get status(): number {
    return HTTP_STATUS[this.code] ?? 500;
  }
}

// ---------------------------------------------------------------------------
// Redaction.
// ---------------------------------------------------------------------------

const REDACTED = "[redacted]";
/** Shown instead of server text when a secret is too short to cut out safely.
 *  Replacing every "e" in "Invalid credentials" with [redacted] would spell
 *  out a one-letter password; withholding the whole text says nothing. */
export const WITHHELD = "[server message withheld]";
const MIN_REDACTABLE_CHARS = 8;

function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** The forms a secret can take on the wire: as typed, escaped inside an IMAP
 *  quoted string, and base64 (AUTH PLAIN, AUTHENTICATE). Callers that send
 *  a SASL PLAIN blob pass the blob itself as a secret too, because the
 *  password's base64 changes with its alignment inside the blob. */
function variantsOf(secret: string): string[] {
  const out = new Set<string>([secret]);
  out.add(secret.replace(/\\/g, "\\\\").replace(/"/g, '\\"'));
  out.add(base64Utf8(secret));
  out.add(sanitizeText(secret));
  out.delete("");
  // Longest first, so a shorter variant never breaks up a longer match.
  return [...out].sort((a, b) => b.length - a.length);
}

function replaceAllInsensitive(haystack: string, needle: string, repl: string): string {
  if (!needle) return haystack;
  const lowerHay = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let out = "";
  let from = 0;
  for (;;) {
    const at = lowerHay.indexOf(lowerNeedle, from);
    if (at < 0) break;
    out += haystack.slice(from, at) + repl;
    from = at + needle.length;
  }
  return out + haystack.slice(from);
}

/**
 * Server text made safe to store and show. Removes every form of every
 * secret (case-insensitively, before and after control characters are
 * stripped), and caps the result at LAST_ERROR_MAX_CHARS. Truncation comes
 * last, so a secret can never be half-cut and half-kept.
 */
export function redact(text: unknown, secrets: ReadonlyArray<string | null | undefined> = []): string {
  let out = String(text ?? "");
  if (!out.trim()) return "";
  const live = secrets.filter((s): s is string => typeof s === "string" && s.length > 0);
  if (live.some((s) => s.length < MIN_REDACTABLE_CHARS)) return WITHHELD;
  for (const s of live) for (const v of variantsOf(s)) out = replaceAllInsensitive(out, v, REDACTED);
  out = sanitizeText(out);
  for (const s of live) for (const v of variantsOf(s)) out = replaceAllInsensitive(out, v, REDACTED);
  return truncate(out, LAST_ERROR_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// Classification.
// ---------------------------------------------------------------------------

/** "IMAP is switched off" or "your plan does not include IMAP", in the words
 *  Zoho and Google use. Zoho: "You are yet to enable IMAP for your account";
 *  Google: "IMAP access is disabled for your domain" / "Your account is not
 *  enabled for IMAP use". */
const IMAP_OFF_RE =
  /enable imap|imap (access )?(is )?(disabled|not enabled|not available|not allowed|turned off)|not enabled for imap|imap[^.]*\b(plan|upgrade)\b|\b(plan|upgrade)\b[^.]*imap/i;
/** Refusals that name repeated failures or a lock: retrying makes them worse,
 *  so they are credential failures for scheduling purposes. */
const LOCKED_RE = /too many (login|auth|failed|invalid|bad)|locked|blocked|suspended|disabled account/i;
/** Refusals that say "later". Allowed to retry after the backoff. */
const BUSY_RE = /too many|try again later|temporar|busy|maintenance|unavailable|throttl/i;

export interface ImapRefusal {
  /** Tagged status: NO or BAD. */
  status: string;
  /** Response code inside the brackets, e.g. AUTHENTICATIONFAILED. */
  code?: string | null;
  /** Human-readable text after the code. */
  text: string;
}

/**
 * A tagged NO/BAD to LOGIN or AUTHENTICATE. Defaults to auth_failed: a
 * transient refusal mistaken for a bad password costs an owner one click on
 * "Check now"; a bad password mistaken for a transient refusal gets
 * presented every ten minutes until the mailbox is locked.
 */
export function classifyLoginFailure(refusal: ImapRefusal, secrets: ReadonlyArray<string | null | undefined> = []): MailError {
  const detail = redact(refusal.text, secrets);
  const code = String(refusal.code ?? "").toUpperCase();
  const words = `${code} ${refusal.text}`;
  if (String(refusal.status).toUpperCase() === "BAD") return new MailError("protocol_error", detail);
  if (IMAP_OFF_RE.test(words)) return new MailError("imap_disabled_or_plan", detail);
  if (LOCKED_RE.test(words)) return new MailError("auth_failed", detail);
  if (code === "UNAVAILABLE" || code === "INUSE" || BUSY_RE.test(words)) return new MailError("server_busy", detail);
  return new MailError("auth_failed", detail);
}

export type SmtpStage = "greeting" | "ehlo" | "auth" | "mail" | "rcpt" | "data" | "quit";

export interface SmtpRefusal {
  stage: SmtpStage;
  /** Three-digit reply code. */
  code: number;
  text: string;
}

/** An SMTP reply that is not the success the stage expected. */
export function classifySmtpFailure(reply: SmtpRefusal, secrets: ReadonlyArray<string | null | undefined> = []): MailError {
  const detail = redact(`${reply.code} ${reply.text}`, secrets);
  const c = Number(reply.code) || 0;
  if (reply.stage === "auth") {
    // 454 is "temporary authentication failure"; everything else refused at
    // AUTH (530, 534 "application-specific password required", 535) is the
    // credentials, and must not be retried by a schedule.
    if (c === 454 || c === 421) return new MailError("server_busy", detail);
    return new MailError("smtp_auth_failed", detail);
  }
  if (c === 421 || (c >= 400 && c < 500)) return new MailError("server_busy", detail);
  if (c === 552) return new MailError("too_large", detail);
  if (reply.stage === "rcpt") return new MailError("recipient_rejected", detail);
  if (reply.stage === "greeting" || reply.stage === "ehlo") return new MailError("protocol_error", detail);
  return new MailError("send_rejected", detail);
}

/**
 * A thrown socket, TLS or DNS error, from Deno or from our own transport.
 * Deno names its errors (TimedOut, ConnectionRefused, InvalidData for a bad
 * certificate) and puts rustls/hickory wording in the message, so both are
 * read.
 */
export function classifyNetworkError(err: unknown): MailError {
  if (err instanceof MailError) return err;
  const e = err as { name?: unknown; message?: unknown } | null;
  const name = String(e?.name ?? "");
  const msg = String(e?.message ?? err ?? "");
  const words = `${name} ${msg}`;
  if (/TimedOut|timed out|timeout/i.test(words)) return new MailError("timeout", msg);
  if (/certificate|UnknownIssuer|NotValidForName|BadCertificate|CertExpired|handshake|InvalidData|\btls\b|\bssl\b/i.test(words)) {
    return new MailError("tls_failed", msg);
  }
  if (/failed to lookup|lookup address|resolve|\bdns\b|name or service not known|nodename|no such host|getaddrinfo|NXDOMAIN/i.test(words)) {
    return new MailError("dns_failed", msg);
  }
  return new MailError("connect_failed", msg);
}

const REACH_CODES = new Set<MailErrorCode>(["connect_failed", "timeout", "tls_failed"]);

/**
 * The same failure, as told about a host the owner typed in. Refused, timed
 * out and bad certificate all become one answer with no server detail, so
 * the connect form cannot be used to learn which hosts on the internet
 * listen on 993 or 465. DNS failures stay distinct: public DNS already tells
 * anyone whether a name exists. Credential refusals stay distinct too; they
 * come from a server that answered, which the owner needs to know.
 */
export function forCustomHost(err: MailError, stage: "imap" | "smtp"): MailError {
  if (!REACH_CODES.has(err.code)) return err;
  return new MailError(stage === "smtp" ? "smtp_587_only" : "tls_failed");
}

/** What mail_accounts.status becomes after this failure. */
export function accountStatusFor(code: MailErrorCode): "auth_failed" | "error" {
  return code === "auth_failed" || code === "imap_disabled_or_plan" || code === "smtp_auth_failed"
    ? "auth_failed"
    : "error";
}

/** Anything thrown, as a MailError. Unknown exceptions become server_error
 *  with no detail: FenceFlowApp's own internals are not the office's business. */
export function toMailError(e: unknown): MailError {
  return e instanceof MailError ? e : new MailError("server_error");
}

/** The JSON an edge function answers with. `detail` is redacted again here,
 *  so a creation site that forgot to cannot leak through the response. */
export function errorBody(
  e: unknown,
  secrets: ReadonlyArray<string | null | undefined> = [],
): { error_code: MailErrorCode; message: string; detail?: string } {
  const err = toMailError(e);
  const detail = redact(err.detail, secrets);
  return detail
    ? { error_code: err.code, message: MESSAGES[err.code], detail }
    : { error_code: err.code, message: MESSAGES[err.code] };
}
