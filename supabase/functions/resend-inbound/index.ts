/**
 * resend-inbound -- Resend's email.received webhook. Brings customers'
 * replies to FenceFlow mail back into the company's inbox.
 *
 *   POST <a svix-signed Resend event>   (from Resend; no Supabase JWT)
 *
 * HOW A REPLY FINDS ITS COMPANY. Once receiving is proven, FenceFlow mail
 * goes out with a Reply-To of <inbound_token>.<reply_token>@MAIL_INBOUND_DOMAIN
 * (reply.ts fenceflowReplyTo). The inbound_token names one company's
 * FenceFlow-mail account and is the ONLY thing that picks the company. The
 * reply_token names the thread and is merely passed on to mail_ingest,
 * which honours it inside that account's company alone -- so a reply_token
 * copied out of company B's mail, sent to company A's address, opens a new
 * thread in A and never touches B.
 *
 * ONE DOOR, checked in this order, before anything is believed or written:
 *  1. POST only (405).
 *  2. RESEND_WEBHOOK_SECRET is set and is a whsec_ secret. Unset or
 *     malformed: 503 not_configured naming the setting, and the body is not
 *     even read. Resend retries a non-200 (5 s, 5 min, 30 min, 2 h, 5 h,
 *     10 h), so mail sent while the owner is still setting up arrives once
 *     the settings are in, rather than being acknowledged and lost.
 *  3. The body as raw bytes, at most WEBHOOK_BODY_MAX_BYTES (413).
 *  4. The svix signature over exactly those bytes (svix.ts): 401 for
 *     anything unsigned, signed with another secret, or more than 5 minutes
 *     off. Nothing in the request is read as JSON before this passes.
 *  5. Events other than email.received: 200, ignored.
 *  6. RESEND_RECEIVING_KEY, MAIL_INBOUND_DOMAIN and the Supabase settings
 *     are set: otherwise 503 not_configured naming each missing one (names
 *     only, never a value). Only now is a service-role client created.
 *
 * THEN, for a verified email.received:
 *  - Already handled (its svix-id is in mail_inbound_events): 200.
 *  - The recipients of the SIGNED event (received_for, to, cc, bcc) go
 *    through reply.ts inboundRoutes(): only <hex>[.<hex>]@<exactly
 *    MAIL_INBOUND_DOMAIN>. Each token is looked up among FenceFlow-mail
 *    accounts; one delivery reaches at most MAX_TARGETS companies.
 *  - No known token: dropped with 200 and counted (mail_events
 *    inbound_dropped, no company). Nothing is stored and Resend is asked
 *    nothing -- except to prove the key, below, until receiving is proven.
 *  - A company that already admitted INBOUND_PER_COMPANY_PER_DAY deliveries
 *    in the last 24 hours: dropped with 200 and counted against it. The
 *    delivery is recorded in the ledger BEFORE it is admitted, and the count
 *    includes it, so deliveries arriving together cannot all read the same
 *    count and pass together. A delivery that turns out to be a duplicate,
 *    or fails and is retried, still counts: the cap errs toward storing less.
 *  - Otherwise the message is fetched (GET /emails/receiving/{id} with
 *    RESEND_RECEIVING_KEY) and handed to mail_ingest as source
 *    resend_inbound: headers through message-meta, text and HTML cached and
 *    capped (the HTML is NOT sanitized here; the office sanitizes it and
 *    shows it only in a sandboxed frame), each attachment listed `pending`
 *    with Resend's id. The answer is 200, and the attachments are then
 *    downloaded in the background (EdgeRuntime.waitUntil) into mail-files.
 *    One that fails stays pending; mail-message fetches it when the message
 *    is opened.
 *
 * FAILURES THAT MAY PASS answer 5xx and record nothing but the ledger count:
 * the database, Resend's API, a timeout. Resend's retry then does the whole job again,
 * and mail_ingest de-duplicates on (account, Resend email id), so a retry
 * after a partial success stores nothing twice. That is why the svix-id is
 * written only AFTER a delivery is fully handled: claimed first, a failure
 * would have to be un-claimed, and a failed un-claim would make the retry
 * skip a message that was never stored.
 *
 * PROVING RECEIVING WORKS. mail_platform_settings.inbound_verified_at is
 * what switches every company's FenceFlow-mail Reply-To to the reply domain
 * (mail-send, mail-connect), so it is set only when the whole chain has
 * worked at once: a signed delivery, to an address at exactly
 * MAIL_INBOUND_DOMAIN, whose message Resend then handed over for
 * RESEND_RECEIVING_KEY. The owner's test message to any address at the
 * reply domain (design B.2 step 6) does all three. A signed webhook alone,
 * a delivery for another domain, or a key Resend refuses does not.
 * inbound_domain is recorded with it, so a later change of domain has to be
 * proven again here.
 *
 * THE SENDER IS NOT CHECKED, and cannot be from here. The svix signature
 * proves Resend delivered the message, not who wrote it: the reply address
 * is known to every customer who got FenceFlow mail, and Resend's receiving
 * API documents no SPF/DKIM/DMARC verdict (a message's own
 * Authentication-Results header is text its sender can write). So the From
 * line is stored as written, and the office reader warns on every
 * resend_inbound message -- loudest when its From claims to be one of the
 * company's own addresses (website/js/lib/mail-render.mjs senderWarning).
 *
 * NOTHING SECRET LEAVES. The webhook secret goes to WebCrypto and the
 * receiving key to api.resend.com, and neither goes anywhere else: not into
 * a response, a log line or a row. Attachment links from Resend are fetched
 * only when https on resend.com or a subdomain, without our key and without
 * following redirects. Logs name error codes only -- never an address, a
 * subject or a body.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import type { Email } from "../_shared/vendor/postal-mime/postal-mime.d.ts";
import { errorResponse, json } from "../_shared/mail/caller.ts";
import { classifyNetworkError, MailError } from "../_shared/mail/errors.ts";
import {
  ATTACHMENT_MAX_BYTES,
  INBOUND_PER_COMPANY_PER_DAY,
  INLINE_IMAGE_MAX_BYTES,
  INLINE_IMAGES_TOTAL_MAX_BYTES,
  OP_TIMEOUT_MS,
  SESSION_BYTE_CAP,
} from "../_shared/mail/limits.ts";
import {
  bodyFields,
  headerFields,
  isoDate,
  MESSAGE_PARTS_MAX,
  parseAddressList,
  REPLY_TO_LIST_MAX,
  storageContentType,
  storageObjectName,
  TO_LIST_MAX,
} from "../_shared/mail/message-meta.ts";
import type { HeaderFields, OwnMailboxes } from "../_shared/mail/message-meta.ts";
import { cleanFilename, cleanMessageId } from "../_shared/mail/mime-build.ts";
import { inboundRoutes } from "../_shared/mail/reply.ts";
import type { InboundRoute } from "../_shared/mail/reply.ts";
import { svixHeaders, verifySvix } from "../_shared/mail/svix.ts";

// ---------------------------------------------------------------------------
// Numbers that belong to this function alone. Everything shared is in
// limits.ts.
// ---------------------------------------------------------------------------

const FN = "resend-inbound";
/** A webhook carries metadata only (addresses, subject, attachment names);
 *  a few KB normally. Anything past this is not a Resend event. */
export const WEBHOOK_BODY_MAX_BYTES = 256 * 1024;
/** Companies one delivery may land in (a customer who copied two companies'
 *  reply addresses). Past this the rest are ignored. */
export const MAX_TARGETS = 5;
export const BUCKET = "mail-files";
const RESEND_API = "https://api.resend.com";
/** A received email from Resend's API. Its HTML may carry inline pictures
 *  as data: URIs; only capped text and HTML are kept. Same cap as
 *  mail-message, which fetches the same thing. */
const RESEND_JSON_MAX_BYTES = 12 * 1024 * 1024;
/** Attachment bytes downloaded for one message in the background. */
const DOWNLOAD_TOTAL_MAX_BYTES = SESSION_BYTE_CAP;
const RESEND_LIST_MAX_PAGES = 3;
/** Resend ids are UUIDs; anything not plainly an id never reaches a URL
 *  path or a row. The same pattern mail-message accepts. */
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
/** A header value looked at from Resend's headers object. */
const HEADER_VALUE_MAX_CHARS = 64 * 1024;
/** Recipient strings read from one event, per field. */
const RECIPIENTS_PER_FIELD_MAX = 100;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
/** The only picture types the reader ever inlines. No SVG. */
const INLINE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const NO_SESSION_PERSIST = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

// ---------------------------------------------------------------------------
// What the function needs from the outside world, so tests/mail-resend-inbound
// can give it a fake Resend, a fake clock and fake settings and call the
// real handler exactly as the gateway does.
// ---------------------------------------------------------------------------

export interface InboundDeps {
  /** Resend's receiving API and its attachment links. Nothing else. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  env: (name: string) => string | undefined;
  /** Work allowed to finish after the answer. Returns null when the runtime
   *  keeps it alive by itself (EdgeRuntime.waitUntil); otherwise returns the
   *  work for the handler to await before answering. */
  background: (work: Promise<void>) => Promise<void> | null;
}

// deno-lint-ignore no-explicit-any
const denoGlobal = (): any => (globalThis as any).Deno;

export function productionDeps(): InboundDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    env: (name) => denoGlobal()?.env?.get(name) ?? undefined,
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

function envOf(deps: InboundDeps, name: string): string {
  return String(deps.env(name) ?? "").trim();
}

// ---------------------------------------------------------------------------
// Configuration. Every setting receiving needs, checked by name; a missing
// one refuses the delivery (503, so Resend retries) instead of half-working.
// ---------------------------------------------------------------------------

interface ReceivingConfig {
  key: string;
  domain: string;
  url: string;
  serviceKey: string;
}

function cleanDomain(raw: string): string | null {
  const d = raw.toLowerCase().replace(/\.$/, "");
  return d.length <= 253 && HOST_RE.test(d) ? d : null;
}

/** RESEND_RECEIVING_KEY, MAIL_INBOUND_DOMAIN and the Supabase settings, or
 *  not_configured naming every one that is missing. Names only. */
export function receivingConfig(deps: InboundDeps): ReceivingConfig {
  const key = envOf(deps, "RESEND_RECEIVING_KEY");
  const rawDomain = envOf(deps, "MAIL_INBOUND_DOMAIN");
  const domain = rawDomain ? cleanDomain(rawDomain) : null;
  const url = envOf(deps, "SUPABASE_URL");
  const serviceKey = envOf(deps, "SUPABASE_SERVICE_ROLE_KEY");
  const missing: string[] = [];
  if (!key) missing.push("RESEND_RECEIVING_KEY");
  if (!rawDomain) missing.push("MAIL_INBOUND_DOMAIN");
  if (!url) missing.push("SUPABASE_URL");
  if (!serviceKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length) {
    throw new MailError("not_configured", `Resend receiving is not set up: ${missing.join(", ")} not set. Nothing was stored; Resend will retry.`);
  }
  if (!domain) throw new MailError("not_configured", "MAIL_INBOUND_DOMAIN is not a domain name. Nothing was stored; Resend will retry.");
  return { key, domain, url, serviceKey };
}

// ---------------------------------------------------------------------------
// Bytes in and out, capped without buffering first.
// ---------------------------------------------------------------------------

async function readStream(body: ReadableStream<Uint8Array> | null, max: number, tooBig: () => MailError): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** The webhook body exactly as sent: the signature is over these bytes. */
async function readRawBody(req: Request): Promise<Uint8Array> {
  const tooBig = () => new MailError("too_large", "Webhook body too large.");
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > WEBHOOK_BODY_MAX_BYTES) throw tooBig();
  return await readStream(req.body, WEBHOOK_BODY_MAX_BYTES, tooBig);
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const tooBig = () => new MailError("session_limit", "The download is larger than FenceFlow takes.");
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw tooBig();
  }
  return await readStream(res.body, max, tooBig);
}

// ---------------------------------------------------------------------------
// Resend's receiving API.
// ---------------------------------------------------------------------------

/**
 * The only links an attachment is downloaded from: https, resend.com or a
 * subdomain of it, default port, no credentials in the URL. The link comes
 * from Resend's authenticated API, but it is still a URL this function did
 * not choose, and a function that fetches whatever URL it is handed can be
 * pointed at the cloud's internal addresses. (mail-message applies the same
 * rule to the same links.)
 */
export function isResendDownloadUrl(raw: unknown): boolean {
  let u: URL;
  try {
    u = new URL(String(raw ?? ""));
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port !== "" && u.port !== "443")) return false;
  const h = u.hostname.toLowerCase();
  return h === "resend.com" || h.endsWith(".resend.com");
}

async function resendGet(deps: InboundDeps, key: string, path: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await deps.fetch(`${RESEND_API}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(OP_TIMEOUT_MS),
    });
  } catch (e) {
    throw classifyNetworkError(e);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    if (res.status === 401 || res.status === 403) {
      throw new MailError("not_configured", "Resend refused RESEND_RECEIVING_KEY. Receiving needs a Full access key.");
    }
    if (res.status === 404) throw new MailError("not_found", "Resend has no such received email.");
    throw new MailError("server_busy", `Resend answered ${res.status}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(await readCapped(res, RESEND_JSON_MAX_BYTES)));
  } catch (e) {
    if (e instanceof MailError) throw e;
    throw new MailError("protocol_error", "Resend answered with something that is not JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new MailError("protocol_error", "Unexpected answer from Resend.");
  return parsed as Record<string, unknown>;
}

/** One attachment link. No Authorization header (a signed link carries its
 *  own signature, and our key never goes to a URL the API handed us) and
 *  no redirects (where a redirect goes was not checked). */
async function resendDownload(deps: InboundDeps, url: string, max: number): Promise<Uint8Array> {
  if (!isResendDownloadUrl(url)) throw new MailError("host_not_allowed", "Refused an attachment link outside resend.com.");
  let res: Response;
  try {
    res = await deps.fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(OP_TIMEOUT_MS) });
  } catch (e) {
    throw classifyNetworkError(e);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new MailError("server_busy", `Resend answered ${res.status}.`);
  }
  return await readCapped(res, max);
}

// ---------------------------------------------------------------------------
// Reading an event. Resend's JSON is read defensively: a field of the wrong
// shape is simply absent.
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function countOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** A list of address strings: an array of strings, or one string. */
function stringList(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string").slice(0, RECIPIENTS_PER_FIELD_MAX);
}

/**
 * One header from Resend's `headers`: an object keyed by (lower-case) name,
 * or a list of {name|key, value}. Matched case-insensitively on own keys
 * only; repeated headers are joined with a space. Capped.
 */
export function headerValue(headers: unknown, name: string): string | null {
  const want = name.toLowerCase();
  const values: string[] = [];
  const take = (v: unknown) => {
    if (typeof v === "string") values.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") values.push(x);
  };
  if (Array.isArray(headers)) {
    for (const h of headers.slice(0, 500)) {
      if (isObject(h) && String(h.name ?? h.key ?? "").toLowerCase() === want) take(h.value);
    }
  } else if (isObject(headers)) {
    for (const k of Object.keys(headers)) if (k.toLowerCase() === want) take(headers[k]);
  }
  const s = values.join(" ").slice(0, HEADER_VALUE_MAX_CHARS);
  return s.trim() ? s : null;
}

/** Every recipient of the signed event, the envelope's first. */
export function recipientsOf(data: Record<string, unknown>): string[] {
  return [
    ...stringList(data.received_for),
    ...stringList(data.to),
    ...stringList(data.cc),
    ...stringList(data.bcc),
  ];
}

/** Whether any recipient is at exactly `domain` (a sub-domain is not). */
export function reachesDomain(recipients: ReadonlyArray<string>, domain: string): boolean {
  return recipients.some((raw) => {
    const m = /<([^<>]*)>\s*$/.exec(raw.trim());
    const address = (m ? m[1] : raw).trim().toLowerCase();
    const at = address.lastIndexOf("@");
    return at > 0 && address.slice(at + 1) === domain;
  });
}

// ---------------------------------------------------------------------------
// The row mail_ingest stores.
// ---------------------------------------------------------------------------

/** A mail_messages.attachments entry, in the shape mail-message documents
 *  for every writer. */
export interface PendingPart {
  idx: number;
  filename: string;
  content_type: string;
  size: number;
  content_id: string | null;
  disposition: "inline" | "attachment";
  storage_path: string | null;
  state: "stored" | "pending" | "too_large";
  provider_id: string;
}

function cleanType(raw: unknown): string {
  const t = String(raw ?? "").trim().toLowerCase();
  return TYPE_RE.test(t) ? t : "application/octet-stream";
}

/**
 * Entries for Resend's attachment metadata, all pending until downloaded.
 * Inline by the rule mail-message's partsFromResend() and message-meta's
 * bodyFields() apply: a picture type the reader shows, of KNOWN size within
 * the per-picture and total caps, and the first part with its Content-ID.
 * Everything else is an attachment, so no part is ever neither shown nor
 * downloadable. Keep this in step with mail-message.
 */
export function partsFromResend(list: unknown): PendingPart[] {
  if (!Array.isArray(list)) return [];
  const out: PendingPart[] = [];
  const cids = new Set<string>();
  let inlineTotal = 0;
  for (const item of list.slice(0, 200)) {
    if (out.length >= MESSAGE_PARTS_MAX) break;
    if (!isObject(item) || typeof item.id !== "string" || !PROVIDER_ID_RE.test(item.id)) continue;
    const size = countOf(item.size);
    const contentType = cleanType(item.content_type);
    const contentId = item.content_id ? cleanMessageId(item.content_id) : null;
    const disposition = typeof item.content_disposition === "string" ? item.content_disposition.toLowerCase() : "";
    const inline = disposition === "inline" && contentId !== null && !cids.has(contentId) && INLINE_TYPES.has(contentType) &&
      size !== null && size <= INLINE_IMAGE_MAX_BYTES && inlineTotal + size <= INLINE_IMAGES_TOTAL_MAX_BYTES;
    if (inline) {
      cids.add(contentId as string);
      inlineTotal += size as number;
    }
    out.push({
      idx: out.length,
      filename: cleanFilename(item.filename),
      content_type: contentType,
      size: size ?? 0,
      content_id: contentId,
      disposition: inline ? "inline" : "attachment",
      storage_path: null,
      state: "pending",
      provider_id: item.id,
    });
  }
  return out;
}

export interface InboundContext {
  /** Resend's email id: the row's provider_message_id. */
  emailId: string;
  /** The thread token from the address it was sent to, if any. */
  replyToken: string | null;
  own: OwnMailboxes;
  /** cached: `src` is Resend's full received email. none: Resend no longer
   *  had it, and `src` is the signed event's metadata. too_large: Resend's
   *  answer was over RESEND_JSON_MAX_BYTES. */
  bodyState: "cached" | "none" | "too_large";
  /** The signed event's data.created_at, when `src` lacks its own. */
  receivedAt: unknown;
  now: Date;
}

export interface InboundRow extends HeaderFields {
  folder_role: "inbox";
  source: "resend_inbound";
  provider_message_id: string;
  reply_token?: string;
  received_at: string;
  size_bytes: null;
  has_attachments: boolean;
  is_seen: false;
  snippet: string;
  body_state: "cached" | "none" | "too_large";
  body_text: string | null;
  body_html: string | null;
  body_truncated: boolean;
  attachments: PendingPart[];
}

/**
 * One mail_ingest row for a received message. Addresses come from the real
 * headers when Resend supplies them (they carry display names) and from its
 * top-level fields otherwise; everything then goes through message-meta's
 * headerFields(), the same cleaning, capping and counterpart rules as mail
 * fetched over IMAP. The routing address and the company's own mailboxes
 * are never counterparts (own.domains holds the reply domain). Bcc is never
 * listed.
 */
export function inboundRow(src: Record<string, unknown>, ctx: InboundContext): InboundRow {
  const h = src.headers;
  const addresses = (header: string, field: unknown, max: number) => {
    const fromHeader = headerValue(h, header);
    const parsed = fromHeader ? parseAddressList(fromHeader, max) : [];
    return parsed.length ? parsed : parseAddressList(stringList(field), max);
  };
  const email = {
    headers: [],
    headerLines: [],
    attachments: [],
    from: addresses("from", src.from, 1)[0],
    to: addresses("to", src.to, TO_LIST_MAX),
    cc: addresses("cc", src.cc, TO_LIST_MAX),
    replyTo: addresses("reply-to", src.reply_to, REPLY_TO_LIST_MAX),
    subject: str(src.subject) ?? headerValue(h, "subject") ?? "",
    messageId: str(src.message_id) ?? headerValue(h, "message-id") ?? undefined,
    inReplyTo: headerValue(h, "in-reply-to") ?? undefined,
    references: headerValue(h, "references") ?? undefined,
    date: headerValue(h, "date") ?? undefined,
  } as unknown as Email;
  const head = headerFields(email, ctx.own);
  // Through bodyFields like every other body: the same caps, the same
  // plain-text fallback for HTML-only mail, the same preview.
  const body = ctx.bodyState === "cached"
    ? bodyFields({ html: str(src.html), text: str(src.text), attachments: [] } as unknown as Email).fields
    : null;
  const parts = partsFromResend(src.attachments);
  return {
    folder_role: "inbox",
    source: "resend_inbound",
    provider_message_id: ctx.emailId,
    ...(ctx.replyToken ? { reply_token: ctx.replyToken } : {}),
    ...head,
    received_at: isoDate(src.created_at) ?? isoDate(ctx.receivedAt) ?? ctx.now.toISOString(),
    size_bytes: null,
    has_attachments: parts.some((p) => p.disposition === "attachment"),
    is_seen: false,
    snippet: body?.snippet ?? "",
    body_state: ctx.bodyState,
    body_text: body?.body_text ?? null,
    body_html: body?.body_html ?? null,
    body_truncated: body?.body_truncated ?? false,
    attachments: parts,
  };
}

// ---------------------------------------------------------------------------
// Database steps. Each read checks its error: an ignored error here reads as
// "unknown token" or "under the cap", and would silently drop or admit mail.
// ---------------------------------------------------------------------------

interface Target {
  accountId: string;
  companyId: string;
  replyToken: string | null;
}

async function alreadyHandled(admin: SupabaseClient, svixId: string): Promise<boolean> {
  const { data, error } = await admin.from("mail_inbound_events").select("svix_id").eq("svix_id", svixId).maybeSingle();
  if (error) throw new MailError("server_error", "Could not read the delivery log.");
  return !!data;
}

/** Written last, once the delivery is fully handled. A failure here is not
 *  an error: the mail is stored, and a repeat is de-duplicated by
 *  mail_ingest anyway. */
async function recordHandled(admin: SupabaseClient, svixId: string, emailId: string, companyId: string | null): Promise<void> {
  const { error } = await admin.from("mail_inbound_events").insert({ svix_id: svixId, email_id: emailId, company_id: companyId });
  if (error && (error as { code?: string }).code !== "23505") console.error(`${FN}: could not record a handled delivery`);
}

/**
 * The companies a delivery is for: each route's inbound_token looked up
 * among live FenceFlow-mail accounts. One target per company, at most
 * MAX_TARGETS; a route carrying a thread token is preferred over a bare one
 * to the same account. The reply_token is never used to find anything here.
 */
async function findTargets(admin: SupabaseClient, routes: ReadonlyArray<InboundRoute>): Promise<Target[]> {
  if (routes.length === 0) return [];
  // inboundRoutes() admits lower-case hex only, so nothing else reaches the filter.
  const tokens = [...new Set(routes.map((r) => r.inboundToken))];
  const { data, error } = await admin
    .from("mail_accounts")
    .select("id, company_id, inbound_token, status")
    .eq("kind", "fenceflow")
    .in("inbound_token", tokens);
  if (error) throw new MailError("server_error", "Could not look up the reply address.");
  const byToken = new Map<string, { id: string; company_id: string }>();
  for (const a of (data ?? []) as Array<Record<string, unknown>>) {
    if (a.status === "disconnected" || typeof a.inbound_token !== "string" || !a.id || !a.company_id) continue;
    byToken.set(a.inbound_token, { id: String(a.id), company_id: String(a.company_id) });
  }
  const targets = new Map<string, Target>();
  for (const r of routes) {
    const a = byToken.get(r.inboundToken);
    if (!a) continue;
    const prev = targets.get(a.company_id);
    if (!prev) {
      if (targets.size < MAX_TARGETS) targets.set(a.company_id, { accountId: a.id, companyId: a.company_id, replyToken: r.replyToken });
    } else if (!prev.replyToken && r.replyToken && prev.accountId === a.id) {
      prev.replyToken = r.replyToken;
    }
  }
  return [...targets.values()];
}

interface PlatformSettings {
  verifiedAt: string | null;
  domain: string | null;
}

async function loadSettings(admin: SupabaseClient): Promise<PlatformSettings> {
  const { data, error } = await admin
    .from("mail_platform_settings").select("inbound_verified_at, inbound_domain").eq("id", 1).maybeSingle();
  if (error) throw new MailError("server_error", "Could not read the receiving settings.");
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    verifiedAt: typeof row.inbound_verified_at === "string" ? row.inbound_verified_at : null,
    domain: typeof row.inbound_domain === "string" ? row.inbound_domain.toLowerCase() : null,
  };
}

function isProven(settings: PlatformSettings, domain: string): boolean {
  return settings.verifiedAt !== null && settings.domain === domain;
}

/** last_inbound_at on every delivery that reached the reply domain; and,
 *  when this one proved the whole chain and the domain was not yet proven,
 *  inbound_verified_at with the domain it was proven for. Best effort: a
 *  failure leaves verification to the next delivery. */
async function noteReceived(admin: SupabaseClient, cfg: ReceivingConfig, settings: PlatformSettings, nowMs: number, proved: boolean): Promise<void> {
  const at = new Date(nowMs).toISOString();
  const patch: Record<string, unknown> = { last_inbound_at: at };
  if (proved && !isProven(settings, cfg.domain)) {
    patch.inbound_verified_at = at;
    patch.inbound_domain = cfg.domain;
  }
  const { error } = await admin.from("mail_platform_settings").update(patch).eq("id", 1);
  if (error) console.error(`${FN}: could not update the receiving settings`);
}

/**
 * Whether one more delivery fits the company's daily cap. Recorded first and
 * counted with this one included, by note_mail_event, which serializes
 * calls per company and kind: counting first and recording only after the
 * store let every delivery in flight at once -- each waiting up to
 * OP_TIMEOUT_MS on Resend -- read the same count and pass together. Anything
 * but a number refuses (5xx, Resend retries): an empty answer read as "under
 * the cap" is how caps vanish.
 */
async function admitInbound(admin: SupabaseClient, companyId: string): Promise<boolean> {
  const { data, error } = await admin.rpc("note_mail_event", { p_company: companyId, p_actor: null, p_kind: "inbound", p_window: "1 day" });
  if (error || typeof data !== "number") throw new MailError("server_error", "Could not write the inbound ledger.");
  return data <= INBOUND_PER_COMPANY_PER_DAY;
}

/** One inbound_dropped row. Best effort: by the time this runs the delivery
 *  has already been dropped, and a missed count must not undo that. */
async function noteEvent(admin: SupabaseClient, companyId: string | null, kind: "inbound_dropped"): Promise<void> {
  const { error } = await admin.rpc("note_mail_event", { p_company: companyId, p_actor: null, p_kind: kind, p_window: "1 day" });
  if (error) console.error(`${FN}: could not count an ${kind} event`);
}

/** Every address the company sends from (any kind or status), plus the
 *  reply domain: never counterparts. The same rule as mail-sync. */
async function ownMailboxes(admin: SupabaseClient, companyId: string, domain: string): Promise<OwnMailboxes> {
  const { data, error } = await admin.from("mail_accounts").select("email_address").eq("company_id", companyId);
  if (error) throw new MailError("server_error", "Could not read the company's mailboxes.");
  return {
    addresses: ((data ?? []) as Array<{ email_address?: unknown }>).map((r) => String(r.email_address ?? "")).filter(Boolean),
    domains: [domain],
  };
}

// ---------------------------------------------------------------------------
// Attachments, after the answer.
// ---------------------------------------------------------------------------

interface ListedAttachment {
  id: string;
  size: number | null;
  download_url: string | null;
}

async function listAttachments(deps: InboundDeps, key: string, emailId: string): Promise<ListedAttachment[]> {
  const all: ListedAttachment[] = [];
  let after: string | null = null;
  for (let page = 0; page < RESEND_LIST_MAX_PAGES; page++) {
    const q: string = `?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const body = await resendGet(deps, key, `/emails/receiving/${encodeURIComponent(emailId)}/attachments${q}`);
    const batch: ListedAttachment[] = [];
    for (const item of Array.isArray(body.data) ? body.data.slice(0, 100) : []) {
      if (!isObject(item) || typeof item.id !== "string" || !PROVIDER_ID_RE.test(item.id)) continue;
      batch.push({ id: item.id, size: countOf(item.size), download_url: typeof item.download_url === "string" ? item.download_url : null });
    }
    all.push(...batch);
    if (body.has_more !== true || batch.length === 0) break;
    after = batch[batch.length - 1].id;
  }
  return all;
}

/**
 * Downloads a stored message's pending attachments into mail-files under
 * <company>/<account>/<message>/<idx>-<name> -- the path mail-message uses,
 * so either one can finish what the other started -- typed by
 * storageContentType(), so HTML, SVG and anything unrecognised is stored as
 * application/octet-stream. Then merges the results onto the row as it is
 * NOW (mail-message may have opened it meanwhile): only entries still
 * pending there are replaced. Never throws; whatever did not make it stays
 * pending for mail-message.
 */
async function storeAttachments(
  admin: SupabaseClient,
  deps: InboundDeps,
  key: string,
  target: Target,
  messageId: string,
  emailId: string,
  parts: ReadonlyArray<PendingPart>,
): Promise<void> {
  try {
    const list = await listAttachments(deps, key, emailId);
    const done = new Map<number, PendingPart>();
    let budget = DOWNLOAD_TOTAL_MAX_BYTES;
    for (const p of parts) {
      if (p.state !== "pending") continue;
      const a = list.find((x) => x.id === p.provider_id);
      if (!a || !a.download_url) continue;
      if (a.size !== null && a.size > ATTACHMENT_MAX_BYTES) {
        done.set(p.idx, { ...p, state: "too_large" });
        continue;
      }
      const cap = Math.min(ATTACHMENT_MAX_BYTES, budget);
      if (cap <= 0 || (a.size !== null && a.size > cap)) continue;
      let bytes: Uint8Array;
      try {
        bytes = await resendDownload(deps, a.download_url, cap);
      } catch (e) {
        // Larger than Resend said, and over the per-file cap: it will never fit.
        if (e instanceof MailError && e.code === "session_limit" && cap === ATTACHMENT_MAX_BYTES) done.set(p.idx, { ...p, state: "too_large" });
        continue;
      }
      budget -= bytes.length;
      const path = `${target.companyId}/${target.accountId}/${messageId}/${storageObjectName(p)}`;
      const { error } = await admin.storage
        .from(BUCKET)
        .upload(path, bytes, { contentType: storageContentType(p.content_type), upsert: true });
      if (error) continue;
      // Resend's recorded size was a claim; a picture that came back larger
      // than the reader inlines is a download instead.
      const disposition = p.disposition === "inline" && bytes.length > INLINE_IMAGE_MAX_BYTES ? "attachment" : p.disposition;
      done.set(p.idx, { ...p, storage_path: path, state: "stored", size: bytes.length, disposition });
    }
    if (done.size === 0) return;

    const { data, error } = await admin
      .from("mail_messages").select("attachments").eq("id", messageId).eq("company_id", target.companyId).maybeSingle();
    const current = (data as { attachments?: unknown } | null)?.attachments;
    if (error || !Array.isArray(current)) return;
    const merged = current.map((e) => {
      if (!isObject(e) || typeof e.idx !== "number") return e;
      const d = done.get(e.idx);
      // Only the same part (same Resend id), and only if it is still waiting.
      return d && e.provider_id === d.provider_id && e.state !== "stored" && e.state !== "too_large" ? d : e;
    });
    const { error: saveError } = await admin
      .from("mail_messages").update({ attachments: merged }).eq("id", messageId).eq("company_id", target.companyId);
    if (saveError) console.error(`${FN}: could not record stored attachments`);
  } catch (e) {
    console.error(`${FN}: attachment download stopped (${e instanceof MailError ? e.code : "unexpected"})`);
  }
}

// ---------------------------------------------------------------------------
// One verified email.received.
// ---------------------------------------------------------------------------

async function receive(deps: InboundDeps, cfg: ReceivingConfig, svixId: string, data: Record<string, unknown>): Promise<Response> {
  const emailId = typeof data.email_id === "string" && PROVIDER_ID_RE.test(data.email_id) ? data.email_id : null;
  if (!emailId) throw new MailError("bad_request", "The event has no usable email_id.");
  // The service role exists only from here: after the signature, after the
  // configuration check.
  const admin = createClient(cfg.url, cfg.serviceKey, NO_SESSION_PERSIST) as SupabaseClient;

  if (await alreadyHandled(admin, svixId)) return json({ ok: true, duplicate: true });

  const recipients = recipientsOf(data);
  const targets = await findTargets(admin, inboundRoutes(recipients, cfg.domain));
  const settings = await loadSettings(admin);

  if (targets.length === 0) {
    // Nobody's address. Until receiving is proven, a message at the reply
    // domain is still asked for once, because the owner's test message
    // (to any address there) is how RESEND_RECEIVING_KEY gets proven.
    let proved = false;
    const atDomain = reachesDomain(recipients, cfg.domain);
    if (atDomain && !isProven(settings, cfg.domain)) {
      try {
        await resendGet(deps, cfg.key, `/emails/receiving/${encodeURIComponent(emailId)}`);
        proved = true;
      } catch (e) {
        // Gone already proves nothing either way; anything else is retried.
        if (!(e instanceof MailError && e.code === "not_found")) throw e;
      }
    }
    await noteEvent(admin, null, "inbound_dropped");
    if (atDomain) await noteReceived(admin, cfg, settings, deps.now(), proved);
    await recordHandled(admin, svixId, emailId, null);
    return json({ ok: true, stored: 0, dropped: "unknown_recipient" });
  }

  const open: Target[] = [];
  for (const t of targets) {
    if (await admitInbound(admin, t.companyId)) open.push(t);
    else await noteEvent(admin, t.companyId, "inbound_dropped");
  }
  if (open.length === 0) {
    await recordHandled(admin, svixId, emailId, targets[0].companyId);
    return json({ ok: true, stored: 0, dropped: "daily_limit" });
  }

  let content: Record<string, unknown> | null = null;
  let bodyState: "cached" | "none" | "too_large" = "cached";
  try {
    content = await resendGet(deps, cfg.key, `/emails/receiving/${encodeURIComponent(emailId)}`);
  } catch (e) {
    // Resend no longer has it: store what the signed event says, so the
    // reply is at least seen. Too big to read: say so. Anything else --
    // a refused key, a 5xx, a timeout -- is retried by Resend.
    if (e instanceof MailError && e.code === "not_found") bodyState = "none";
    else if (e instanceof MailError && e.code === "session_limit") bodyState = "too_large";
    else throw e;
  }

  let stored = 0;
  let duplicates = 0;
  const later: Promise<void>[] = [];
  for (const t of open) {
    const row = inboundRow(content ?? data, {
      emailId,
      replyToken: t.replyToken,
      own: await ownMailboxes(admin, t.companyId, cfg.domain),
      bodyState,
      receivedAt: data.created_at,
      now: new Date(deps.now()),
    });
    const { data: result, error } = await admin.rpc("mail_ingest", { p_account: t.accountId, p_rows: [row] });
    const hit = Array.isArray(result) ? (result[0] as Record<string, unknown> | undefined) : undefined;
    if (error || !hit || typeof hit.message_id !== "string") throw new MailError("server_error", "Could not store a received message.");
    const messageId = hit.message_id as string;
    if (hit.inserted !== true) {
      duplicates++;
      continue;
    }
    stored++;
    if (bodyState !== "none" && row.attachments.some((p) => p.state === "pending")) {
      later.push(storeAttachments(admin, deps, cfg.key, t, messageId, emailId, row.attachments));
    }
  }

  // Resend answered for the key (a 404 does not count), at the reply domain.
  await noteReceived(admin, cfg, settings, deps.now(), bodyState !== "none");
  await recordHandled(admin, svixId, emailId, open[0].companyId);
  if (later.length) {
    const work = deps.background(Promise.all(later).then(() => {}));
    if (work) await work;
  }
  return json({ ok: true, stored, duplicates, dropped: targets.length - open.length });
}

// ---------------------------------------------------------------------------
// The door.
// ---------------------------------------------------------------------------

export async function handleRequest(req: Request, deps: InboundDeps = productionDeps()): Promise<Response> {
  if (req.method !== "POST") return json({ error_code: "bad_request", message: "Use POST." }, 405);
  // Redacted out of anything that goes back, though neither is ever put there.
  const secrets = [envOf(deps, "RESEND_WEBHOOK_SECRET"), envOf(deps, "RESEND_RECEIVING_KEY")];
  try {
    const secret = envOf(deps, "RESEND_WEBHOOK_SECRET");
    if (!secret) {
      throw new MailError("not_configured", "Resend receiving is not set up: RESEND_WEBHOOK_SECRET not set, so no delivery can be verified. Nothing was accepted.");
    }
    const raw = await readRawBody(req);
    // Throws not_configured for a secret that is not a whsec_ key.
    const verdict = await verifySvix({ headers: svixHeaders(req.headers), body: raw, secret, nowSeconds: Math.floor(deps.now() / 1000) });
    if (!verdict.ok) {
      return json({ error_code: "bad_signature", message: "The webhook signature was not accepted.", reason: verdict.reason }, 401);
    }

    // From here on the bytes are Resend's.
    let event: unknown;
    try {
      event = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new MailError("bad_request", "The event is not JSON.");
    }
    if (!isObject(event)) throw new MailError("bad_request", "The event is not a JSON object.");
    const type = typeof event.type === "string" ? event.type.slice(0, 60) : "";
    if (type !== "email.received") return json({ ok: true, ignored: type || "unknown" });
    if (!isObject(event.data)) throw new MailError("bad_request", "The event has no data.");

    return await receive(deps, receivingConfig(deps), verdict.id, event.data);
  } catch (e) {
    return errorResponse(FN, e, secrets);
  }
}

// Deno serves; under Node (tests/mail-resend-inbound.test.mjs) there is no
// Deno.serve and the handler is called directly with fake dependencies.
if (typeof denoGlobal()?.serve === "function") denoGlobal().serve((req: Request) => handleRequest(req));
