/**
 * How one message answers another, and where a reply to FenceFlow mail goes.
 *
 * Two jobs, both pure:
 *
 *  - Threading headers. A stored message keeps its own Message-ID and
 *    parent_ids (built by message-meta.ts: the message it answered FIRST,
 *    then the rest of its References in order). replyThreading() turns that
 *    back into the In-Reply-To and References a reply to it must carry, in
 *    the order other mail programs expect, capped at REFERENCES_OUT_MAX.
 *  - Routing FenceFlow mail replies. Mail sent through Resend carries a
 *    Reply-To of <inbound_token>.<reply_token>@<MAIL_INBOUND_DOMAIN> once
 *    receiving is proven to work; resend-inbound reads it back with
 *    inboundRoutes(). Until then the Reply-To is the company's own email, and
 *    with neither there is no honest place for a reply to go, so FenceFlow
 *    mail is unavailable (fenceflowReplyTo).
 *
 * Tokens are only ever matched in full, lower-case hex, at the exact inbound
 * domain; a token on its own proves nothing (mail_ingest only honours a
 * reply_token inside the company the inbound_token belongs to).
 */

import { MailError } from "./errors.ts";
import { REFERENCES_OUT_MAX } from "./limits.ts";
import { capIds, cleanMessageId, dedupeIds, isValidAddress, normalizeAddress } from "./mime-build.ts";

// ---------------------------------------------------------------------------
// Message-IDs.
// ---------------------------------------------------------------------------

/** Headers longer than this are cut before looking for ids in them. */
const ID_HEADER_SCAN_CHARS = 64 * 1024;

/**
 * The Message-IDs in an In-Reply-To or References value, brackets stripped,
 * de-duplicated, in order. Bracketed ids are taken when there are any;
 * otherwise (some mailers drop the brackets) whitespace- or comma-separated
 * words containing "@". Anything that is not a plausible id is skipped.
 */
export function extractIds(value: unknown): string[] {
  const s = String(value ?? "").slice(0, ID_HEADER_SCAN_CHARS);
  const bracketed = s.match(/<[^<>\s]+>/g);
  const words = bracketed ?? s.split(/[\s,]+/).filter((w) => w.includes("@"));
  return dedupeIds(words.map(cleanMessageId));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Message-ID for a message FenceFlow sends: "<uuid>@<sender's domain>",
 * without brackets. The uuid is the caller's (crypto.randomUUID()), so the
 * id can be written to the claim row before anything is sent.
 */
export function newMessageId(senderAddress: string, uuid: string): string {
  const address = normalizeAddress(senderAddress);
  if (!UUID_RE.test(uuid)) throw new MailError("server_error", "Invalid Message-ID seed.");
  return `${uuid.toLowerCase()}@${address.slice(address.lastIndexOf("@") + 1)}`;
}

/**
 * parent_ids back into References order. message-meta.ts stores the direct
 * parent first (In-Reply-To, or the last References entry when there was no
 * In-Reply-To) followed by the other References in order; moving that first
 * id back to the end restores oldest-to-newest.
 */
export function restoreReferenceOrder(parentIds: ReadonlyArray<string> | null | undefined): string[] {
  const ids = dedupeIds((parentIds ?? []).map(cleanMessageId));
  return ids.length < 2 ? ids : [...ids.slice(1), ids[0]];
}

export interface ReplyParent {
  message_id_header: string | null;
  parent_ids?: ReadonlyArray<string> | null;
}

/**
 * In-Reply-To and References for a reply to (or forward of) `parent`, per
 * RFC 5322 3.6.4: the parent's References followed by the parent's own id,
 * at most REFERENCES_OUT_MAX, keeping the root and the most recent. A parent
 * with no usable Message-ID gets no In-Reply-To but still passes on its
 * ancestors, so the reply stays in the conversation.
 */
export function replyThreading(parent: ReplyParent | null | undefined): { inReplyTo: string | null; references: string[] } {
  if (!parent) return { inReplyTo: null, references: [] };
  const own = cleanMessageId(parent.message_id_header);
  const chain = restoreReferenceOrder(parent.parent_ids).filter((id) => id !== own);
  return { inReplyTo: own, references: capIds(own ? [...chain, own] : chain, REFERENCES_OUT_MAX) };
}

// ---------------------------------------------------------------------------
// FenceFlow mail reply routing.
// ---------------------------------------------------------------------------

/** mail_accounts.inbound_token, as the SQL check constrains it. */
const INBOUND_TOKEN_RE = /^[a-f0-9]{12,32}$/;
/** mail_threads.reply_token: 6 random bytes as hex today; room to grow. */
const REPLY_TOKEN_RE = /^[a-f0-9]{12,32}$/;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Recipients looked at in one inbound message. */
const MAX_INBOUND_RECIPIENTS = 50;

function cleanDomain(domain: unknown): string | null {
  const d = String(domain ?? "").trim().toLowerCase().replace(/\.$/, "");
  return d.length <= 253 && HOST_RE.test(d) ? d : null;
}

/**
 * "<inbound_token>.<reply_token>@<domain>", or without the reply token when
 * there is no thread yet (the Settings preview). Throws server_error on a
 * malformed token or domain: those come from our own database and
 * configuration, so a bad one is our bug, not the caller's.
 */
export function inboundReplyAddress(inboundToken: string, replyToken: string | null | undefined, domain: string): string {
  const d = cleanDomain(domain);
  if (!d || !INBOUND_TOKEN_RE.test(inboundToken)) throw new MailError("server_error", "Invalid inbound routing token.");
  if (replyToken && !REPLY_TOKEN_RE.test(replyToken)) throw new MailError("server_error", "Invalid reply token.");
  return `${inboundToken}${replyToken ? `.${replyToken}` : ""}@${d}`;
}

export interface InboundRoute {
  inboundToken: string;
  replyToken: string | null;
  /** The recipient address it was read from, lower-cased. */
  address: string;
}

/**
 * Every FenceFlow routing address among an inbound message's recipients
 * ("Name <a@b>" or bare), at exactly `domain`. De-duplicated; order kept.
 * The address is lower-cased first (a sender's mail program may change the
 * case of what it replies to, and the tokens are stored lower-case). Anything
 * else -- another domain, a sub-domain, extra dots, non-hex tokens or tokens
 * of the wrong length -- is not a route.
 */
export function inboundRoutes(recipients: ReadonlyArray<unknown>, domain: unknown): InboundRoute[] {
  const d = cleanDomain(domain);
  if (!d || !Array.isArray(recipients)) return [];
  const out: InboundRoute[] = [];
  const seen = new Set<string>();
  for (const raw of recipients.slice(0, MAX_INBOUND_RECIPIENTS)) {
    const s = String(raw ?? "").trim();
    const m = /<([^<>]*)>\s*$/.exec(s);
    const address = (m ? m[1] : s).trim().toLowerCase();
    const at = address.lastIndexOf("@");
    if (at < 1 || address.slice(at + 1) !== d) continue;
    const parts = /^([a-f0-9]{12,32})(?:\.([a-f0-9]{12,32}))?$/.exec(address.slice(0, at));
    if (!parts) continue;
    const key = `${parts[1]}.${parts[2] ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ inboundToken: parts[1], replyToken: parts[2] ?? null, address });
  }
  return out;
}

export type FenceflowReplyMode = "inbound" | "company_email" | "unavailable";

export interface FenceflowReplyInput {
  /** mail_platform_settings.inbound_verified_at is set AND the receiving
   *  secrets are configured. Nothing else may switch replies to inbound. */
  inboundReady: boolean;
  inboundDomain?: string | null;
  /** This company's fenceflow mail_accounts.inbound_token. */
  inboundToken?: string | null;
  /** The thread's reply_token; absent for a preview or a brand-new thread. */
  replyToken?: string | null;
  /** companies.email. */
  companyEmail?: string | null;
}

/**
 * Where a customer's reply to FenceFlow mail lands. Inbound only when
 * receiving is proven; otherwise the company's own email; otherwise nowhere
 * honest -- a reply with no Reply-To would reach MAIL_FROM, FenceFlow's own
 * mailbox, carrying another company's customer -- so mail-send refuses and
 * the office says "Add your business email in Settings first".
 */
export function fenceflowReplyTo(input: FenceflowReplyInput): { mode: FenceflowReplyMode; replyTo: string | null } {
  const domain = cleanDomain(input.inboundDomain);
  const token = String(input.inboundToken ?? "");
  if (input.inboundReady === true && domain && INBOUND_TOKEN_RE.test(token)) {
    const reply = input.replyToken && REPLY_TOKEN_RE.test(input.replyToken) ? input.replyToken : null;
    return { mode: "inbound", replyTo: inboundReplyAddress(token, reply, domain) };
  }
  const company = String(input.companyEmail ?? "").trim();
  if (company && isValidAddress(company)) return { mode: "company_email", replyTo: normalizeAddress(company) };
  return { mode: "unavailable", replyTo: null };
}
