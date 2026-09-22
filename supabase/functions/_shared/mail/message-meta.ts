/**
 * Mail FenceFlow did not write, turned into mail_ingest rows and cached
 * bodies.
 *
 * Everything that arrives here came from a stranger: a customer's mail
 * program, a spammer, or someone who knows FenceFlow parses what they send.
 * So this file decides, in one pure place, what of it is believed:
 *
 *  - Parsing is postal-mime (vendored in ../vendor/postal-mime, with its
 *    one local patch that keeps html-to-text linear), under tighter nesting
 *    and header limits than its defaults.
 *  - Addresses are kept only when they look like addresses. postal-mime
 *    hands back "not an address" as the address of `Bad <not an address>`;
 *    that never reaches to_list or counterpart_emails.
 *  - counterpart_emails, which is what links mail to jobs, never contains
 *    one of the company's own mailboxes (mail_ingest strips them again).
 *  - Every displayed string has control and invisible characters removed and
 *    is capped, so a subject cannot render as two lines or hide the real
 *    sender behind a bidirectional override.
 *  - parent_ids is stored in the order reply.ts reads back: the message it
 *    answered first, then the rest of References oldest-first, capped at
 *    PARENT_IDS_MAX keeping the conversation's root.
 *
 * mail-sync calls headerFields()/toRow() on the header blocks it fetched;
 * mail-message calls bodyFields() on the whole message when it is opened.
 * No Deno, no network, no clock: callers pass `now`, so
 * tests/mail-meta.test.mjs runs the same calls under plain Node against the
 * .eml fixtures.
 */

// @deno-types="../vendor/postal-mime/postal-mime.d.ts"
import PostalMime, { addressParser } from "../vendor/postal-mime/postal-mime.js";
import type { Address, Email, PostalMimeOptions } from "../vendor/postal-mime/postal-mime.d.ts";
import { htmlToText } from "../vendor/postal-mime/text-format.js";
import { MailError } from "./errors.ts";
import {
  INLINE_IMAGE_MAX_BYTES,
  INLINE_IMAGES_TOTAL_MAX_BYTES,
  PARENT_IDS_MAX,
  SNIPPET_MAX_CHARS,
  STORED_HTML_MAX_BYTES,
  STORED_TEXT_MAX_BYTES,
} from "./limits.ts";
import { base64, capIds, cleanFilename, cleanMessageId, cleanSubject } from "./mime-build.ts";
import { extractIds } from "./reply.ts";

/** What mail_messages and mail_ingest cap these at; cutting here first means
 *  the database trigger never has to. */
export const SUBJECT_STORE_MAX_CHARS = 998;
export const NAME_MAX_CHARS = 300;
export const TO_TEXT_MAX_CHARS = 4000;
export const TO_LIST_MAX = 100;
export const REPLY_TO_LIST_MAX = 20;
export const COUNTERPARTS_MAX = 200;
/** mail_messages.attachments holds at most this many entries. */
export const MESSAGE_PARTS_MAX = 50;
const ADDRESS_MAX_CHARS = 320;
const MAX_UID = 4294967295;
/** Longest address header handed to addressParser from outside postal-mime. */
const ADDRESS_INPUT_MAX_CHARS = 64 * 1024;

/**
 * postal-mime's defaults are 256 levels of nesting and 2 MB of headers; a
 * real message needs a handful of levels and a few KB. Forwarded messages
 * (message/rfc822) are parsed inline three deep, and deeper ones become
 * plain attachments.
 */
export const PARSE_OPTIONS: PostalMimeOptions = {
  attachmentEncoding: "arraybuffer",
  maxNestingDepth: 32,
  maxHeadersSize: 512 * 1024,
  maxRfc822NestingDepth: 3,
};

/** A whole message, or just a header block (sync fetches only the fields
 *  it needs; postal-mime parses a block ending in a blank line as a message
 *  with no body). */
export function parseMail(source: Uint8Array | string): Promise<Email> {
  return PostalMime.parse(source, PARSE_OPTIONS);
}

// ---------------------------------------------------------------------------
// Text.
// ---------------------------------------------------------------------------

// deno-lint-ignore no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f\u{2028}\u{2029}]/gu;
/** Zero-width and bidirectional-override characters. */
const INVISIBLE_RE = /[\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}]/gu;

function capChars(s: string, max: number): string {
  // Code points, so a cut never leaves half of a surrogate pair behind.
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join("");
}

/** One displayable line: control characters become spaces, invisible ones
 *  go, whitespace collapses, at most `max` characters. */
export function cleanHeaderText(raw: unknown, max: number): string {
  const s = String(raw ?? "")
    .slice(0, max * 4)
    .replace(INVISIBLE_RE, "")
    .replace(CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return capChars(s, max).trim();
}

/** Re:, RE:, Fwd:, FW:, TR:, RV:, AW: and counters like "Re[2]:", any number
 *  of them. Each repetition has to consume a prefix and a colon, so the
 *  pattern cannot backtrack badly. */
const REPLY_PREFIX_RE = /^(?:(?:re|fwd?|tr|rv|aw)\s*(?:\[\d{1,4}\]|\(\d{1,4}\))?\s*[:\u{ff1a}]\s*)+/iu;

/**
 * The subject with reply and forward prefixes removed, for display only.
 * Threads are never merged by subject: two customers' "Re: Quote" are two
 * conversations.
 */
export function normalizeSubject(raw: unknown): string {
  const s = cleanHeaderText(raw, SUBJECT_STORE_MAX_CHARS);
  return s.replace(REPLY_PREFIX_RE, "").trim();
}

/**
 * A date as ISO 8601, or null. postal-mime already converts a valid Date
 * header and leaves anything else as the raw text ("not a date"), so both
 * are checked again here. Years outside 1970-2999 are treated as broken.
 */
export function isoDate(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const t = raw instanceof Date ? raw.getTime() : Date.parse(String(raw).slice(0, 200));
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const y = d.getUTCFullYear();
  return y >= 1970 && y <= 2999 ? d.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Addresses.
// ---------------------------------------------------------------------------

export interface MailAddress {
  name: string;
  address: string;
}

/**
 * The address if it plausibly is one, else null. Deliberately looser than
 * mime-build's normalizeAddress (which decides what FenceFlow will SEND to):
 * incoming mail may carry internationalised addresses. But it must be one
 * token with exactly one "@", something on each side, and a dot in the
 * domain; quoted local parts, comments and anything with whitespace or
 * brackets are not kept.
 */
export function plausibleAddress(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  // deno-lint-ignore no-control-regex
  if (!s || s.length > ADDRESS_MAX_CHARS || /[\s\x00-\x1f\x7f<>()[\]\\,;:"]/.test(s)) return null;
  const at = s.indexOf("@");
  if (at < 1 || at !== s.lastIndexOf("@") || at === s.length - 1) return null;
  const domain = s.slice(at + 1);
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return null;
  return s;
}

/**
 * postal-mime's address list, flattened (groups opened up), with names
 * cleaned, implausible addresses dropped and duplicates (case-insensitive)
 * removed. At most `max`.
 */
export function mailboxes(value: Address | ReadonlyArray<Address> | null | undefined, max: number): MailAddress[] {
  const list: ReadonlyArray<Address> = value === null || value === undefined ? [] : Array.isArray(value) ? value : [value as Address];
  const out: MailAddress[] = [];
  const seen = new Set<string>();
  const push = (m: { name?: unknown; address?: unknown } | null | undefined) => {
    const address = plausibleAddress(m?.address);
    if (!address || seen.has(address.toLowerCase())) return;
    seen.add(address.toLowerCase());
    out.push({ name: cleanHeaderText(m?.name, NAME_MAX_CHARS), address });
  };
  for (const a of list) {
    if (out.length >= max) break;
    if (a && Array.isArray(a.group)) {
      for (const g of a.group) {
        if (out.length >= max) break;
        push(g);
      }
    } else {
      push(a as { name?: unknown; address?: unknown });
    }
  }
  return out;
}

/** An address header (or a list of them) as text, e.g. from a provider's
 *  JSON rather than from a parsed message. */
export function parseAddressList(raw: string | ReadonlyArray<string> | null | undefined, max: number = TO_LIST_MAX): MailAddress[] {
  const text = (Array.isArray(raw) ? raw.map((r) => String(r ?? "")).join(", ") : String(raw ?? "")).slice(0, ADDRESS_INPUT_MAX_CHARS);
  if (!text.trim()) return [];
  return mailboxes(addressParser(text), max);
}

export interface OwnMailboxes {
  /** Every mail_accounts.email_address of the company. */
  addresses: ReadonlyArray<string>;
  /** Whole domains that are the company's or FenceFlow's own, e.g. the
   *  inbound reply domain. */
  domains?: ReadonlyArray<string>;
}

/**
 * The lower-cased outside addresses a message involves: what links it to a
 * job whose customer has one of them. The company's own mailboxes and
 * domains never count, or every message would "involve" every job the
 * company ever emailed from that mailbox.
 */
export function counterpartEmails(lists: ReadonlyArray<ReadonlyArray<MailAddress>>, own: OwnMailboxes): string[] {
  const ownAddresses = new Set(own.addresses.map((a) => String(a ?? "").trim().toLowerCase()).filter(Boolean));
  const ownDomains = new Set((own.domains ?? []).map((d) => String(d ?? "").trim().toLowerCase().replace(/\.$/, "")).filter(Boolean));
  const out = new Set<string>();
  for (const list of lists) {
    for (const m of list) {
      const a = m.address.trim().toLowerCase();
      if (ownAddresses.has(a) || ownDomains.has(a.slice(a.lastIndexOf("@") + 1))) continue;
      out.add(a);
      if (out.size >= COUNTERPARTS_MAX) return [...out];
    }
  }
  return [...out];
}

/** "Name <a@b>, c@d" for the search index and the list view. */
export function addressText(list: ReadonlyArray<MailAddress>): string {
  const s = list.map((m) => (m.name ? `${m.name} <${m.address}>` : m.address)).join(", ");
  return capChars(s, TO_TEXT_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// Threading.
// ---------------------------------------------------------------------------

/**
 * parent_ids for a message: the message it answered (In-Reply-To, or the
 * last References entry when there is none), then the rest of References
 * oldest-first. reply.restoreReferenceOrder() moves that first id back to
 * the end. The message's own id never appears, duplicates go, and past
 * PARENT_IDS_MAX the direct parent, the root and the most recent ancestors
 * are kept.
 */
export function parentIdsOf(inReplyTo: unknown, references: unknown, ownId: string | null): string[] {
  const refs = extractIds(references).filter((id) => id !== ownId);
  const answered = extractIds(inReplyTo).filter((id) => id !== ownId);
  const parent = answered[0] ?? refs[refs.length - 1] ?? null;
  if (!parent) return [];
  const rest: string[] = [];
  const seen = new Set<string>([parent]);
  for (const id of [...refs, ...answered.slice(1)]) {
    if (seen.has(id)) continue;
    seen.add(id);
    rest.push(id);
  }
  return [parent, ...capIds(rest, PARENT_IDS_MAX - 1)];
}

// ---------------------------------------------------------------------------
// Rows for mail_ingest.
// ---------------------------------------------------------------------------

export interface HeaderFields {
  message_id_header: string | null;
  parent_ids: string[];
  from_address: string | null;
  from_name: string | null;
  to_list: MailAddress[];
  cc_list: MailAddress[];
  reply_to_list: MailAddress[];
  to_text: string;
  counterpart_emails: string[];
  subject: string;
  sent_at: string | null;
}

/** The parts of a mail_ingest row that come from a message's headers,
 *  whichever way it arrived (IMAP header block, whole message, provider). */
export function headerFields(email: Email, own: OwnMailboxes): HeaderFields {
  const from = mailboxes(email.from ?? null, 1)[0] ?? null;
  const to = mailboxes(email.to ?? null, TO_LIST_MAX);
  const cc = mailboxes(email.cc ?? null, TO_LIST_MAX);
  const replyTo = mailboxes(email.replyTo ?? null, REPLY_TO_LIST_MAX);
  const messageId = cleanMessageId(email.messageId);
  return {
    message_id_header: messageId,
    parent_ids: parentIdsOf(email.inReplyTo, email.references, messageId),
    from_address: from ? from.address.toLowerCase() : null,
    from_name: from && from.name ? from.name : null,
    to_list: to,
    cc_list: cc,
    reply_to_list: replyTo,
    to_text: addressText([...to, ...cc]),
    counterpart_emails: counterpartEmails([from ? [from] : [], replyTo, to, cc], own),
    subject: cleanHeaderText(cleanSubject(email.subject ?? ""), SUBJECT_STORE_MAX_CHARS),
    sent_at: isoDate(email.date),
  };
}

/**
 * Whether a message probably has attachments, from its top-level
 * Content-Type alone: sync fetches headers, not bodies. multipart/mixed is
 * the structure attachments come in (it is also what Thunderbird's paperclip
 * goes by). mail-message replaces the guess with the truth when the message
 * is opened.
 */
export function attachmentHint(email: Email): boolean {
  const ct = email.headers?.find((h) => h.key === "content-type")?.value ?? "";
  return /^\s*multipart\/mixed\b/i.test(ct);
}

export interface FlagColumns {
  is_seen?: boolean;
  is_answered?: boolean;
  is_flagged?: boolean;
}

/**
 * IMAP flags as mail_messages columns. Null (the server sent no FLAGS) gives
 * no keys at all, which mail_ingest and mail_set_flags read as "leave as it
 * is". Mail in Sent is always seen: an unread badge on your own sent mail
 * is noise, whatever the server recorded.
 */
export function flagsToColumns(flags: ReadonlyArray<string> | null | undefined, role: "inbox" | "sent"): FlagColumns {
  if (!Array.isArray(flags)) return role === "sent" ? { is_seen: true } : {};
  const set = new Set(flags.map((f) => String(f).toLowerCase()));
  return {
    is_seen: role === "sent" || set.has("\\seen"),
    is_answered: set.has("\\answered"),
    is_flagged: set.has("\\flagged"),
  };
}

export interface ImapRowContext {
  folderRole: "inbox" | "sent";
  uidValidity: number;
  own: OwnMailboxes;
  /** received_at when the server gave no INTERNALDATE and the message no
   *  usable Date. mail-sync passes the time of the run. */
  now: Date;
}

export interface ImapFetchedMeta {
  uid: number | null;
  flags: string[] | null;
  internalDate: string | null;
  size: number | null;
}

export interface IngestRow extends HeaderFields, FlagColumns {
  folder_role: "inbox" | "sent";
  source: "imap";
  uidvalidity: number;
  uid: number;
  received_at: string;
  size_bytes: number | null;
  has_attachments: boolean;
  snippet: string;
  body_state: "none";
}

function validUid(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n <= MAX_UID;
}

/**
 * One mail_ingest row for a message mail-sync fetched headers for. Bodies
 * are not fetched during sync, so body_state is 'none' and the snippet
 * empty until the message is opened.
 */
export function toRow(email: Email, fetched: ImapFetchedMeta, ctx: ImapRowContext): IngestRow {
  if (!validUid(fetched?.uid) || !validUid(ctx?.uidValidity)) {
    throw new MailError("protocol_error", "A message came back without a usable UID.");
  }
  if (ctx.folderRole !== "inbox" && ctx.folderRole !== "sent") throw new MailError("server_error", "Unknown folder role.");
  const head = headerFields(email, ctx.own);
  const size = typeof fetched.size === "number" && Number.isSafeInteger(fetched.size) && fetched.size >= 0 ? fetched.size : null;
  return {
    folder_role: ctx.folderRole,
    source: "imap",
    uidvalidity: ctx.uidValidity,
    uid: fetched.uid,
    ...head,
    received_at: isoDate(fetched.internalDate) ?? head.sent_at ?? ctx.now.toISOString(),
    size_bytes: size,
    has_attachments: attachmentHint(email),
    ...flagsToColumns(fetched.flags, ctx.folderRole),
    snippet: "",
    body_state: "none",
  };
}

// ---------------------------------------------------------------------------
// Bodies, for mail-message.
// ---------------------------------------------------------------------------

/** At most `maxBytes` of UTF-8, cut between characters. */
export function capUtf8(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= maxBytes) return { text: s, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

/** "On Fri, Sep 11, 2026 at 4:02 PM Acme Fence <...> wrote:" and its French
 *  and Spanish forms, as the line above a quoted reply. */
const ATTRIBUTION_RE = /(?:wrote|a\s+\u{e9}crit|escribi\u{f3})\s*:\s*$/iu;
const QUOTED_RE = /^\s*>/;

/**
 * The list-view preview: the new words of a message, not the quoted history
 * under them. Quoted lines (">") and the "... wrote:" line introducing them
 * are skipped unless nothing else is left; whitespace collapses;
 * SNIPPET_MAX_CHARS at most.
 */
export function snippetOf(text: string | null | undefined): string {
  const s = String(text ?? "").slice(0, 16 * 1024);
  const lines = s.split(/\r?\n/);
  const nextNonBlank = (i: number) => lines.slice(i + 1).find((l) => l.trim() !== "") ?? "";
  const fresh = lines
    .filter((l, i) => !QUOTED_RE.test(l) && !(ATTRIBUTION_RE.test(l) && QUOTED_RE.test(nextNonBlank(i))))
    .join(" ");
  return cleanHeaderText(fresh.trim() ? fresh : lines.join(" "), SNIPPET_MAX_CHARS);
}

export interface AttachmentMeta {
  /** Position among this message's parts; stable, used in storage paths
   *  and by mail-message {action:'attachment', idx}. */
  idx: number;
  filename: string;
  content_type: string;
  size: number;
  content_id: string | null;
  /** 'inline' only for an image the HTML shows through cid:; everything
   *  else, whatever the sender labelled it, is an attachment. */
  disposition: "attachment" | "inline";
}

export interface MessagePart {
  meta: AttachmentMeta;
  content: Uint8Array;
}

export interface BodyFields {
  body_text: string | null;
  body_html: string | null;
  body_truncated: boolean;
  snippet: string;
  has_attachments: boolean;
  attachments: AttachmentMeta[];
}

const TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** The only image types ever shown inline (as data: URLs) in the reader. No
 *  SVG: it is a document that can carry script, not a picture. */
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function cleanType(raw: unknown): string {
  const t = String(raw ?? "").trim().toLowerCase();
  return TYPE_RE.test(t) ? t : "application/octet-stream";
}

function asBytes(content: unknown): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (typeof content === "string") return new TextEncoder().encode(content);
  return new Uint8Array(0);
}

/**
 * The text, HTML, preview and parts of an opened message, capped to what
 * mail_messages stores. body_text falls back to the HTML as text (through
 * the patched, linear htmlToText) so "Show as plain text" and the preview
 * work for HTML-only mail. The HTML is NOT sanitized here: it is stored as
 * sent and only ever shown sanitized, inside a sandboxed frame, by the
 * office. At most MESSAGE_PARTS_MAX parts are kept.
 */
export function bodyFields(email: Email): { fields: BodyFields; parts: MessagePart[] } {
  const html = typeof email.html === "string" && email.html.trim() ? capUtf8(email.html, STORED_HTML_MAX_BYTES) : null;
  const rawText = typeof email.text === "string" && email.text.trim()
    ? email.text
    : html
    ? htmlToText(html.text)
    : "";
  const text = rawText.trim() ? capUtf8(rawText.replace(/^\s*\n/, ""), STORED_TEXT_MAX_BYTES) : null;

  const parts: MessagePart[] = [];
  const cids = new Set<string>();
  let inlineTotal = 0;
  for (const a of email.attachments ?? []) {
    if (parts.length >= MESSAGE_PARTS_MAX) break;
    const content = asBytes(a.content);
    const contentType = cleanType(a.mimeType);
    const contentId = a.contentId ? cleanMessageId(a.contentId) : null;
    // Inline only if the reader will actually show it: one of the picture
    // types inlineImages() turns into data: URLs, within its size caps, and
    // the first part with that Content-ID. Anything else -- an SVG, a
    // 3 MB photo -- is listed as an attachment, so no part is ever neither
    // shown nor downloadable.
    const inline = contentId !== null &&
      INLINE_IMAGE_TYPES.has(contentType) &&
      (a.related === true || a.disposition === "inline") &&
      !cids.has(contentId) &&
      content.length <= INLINE_IMAGE_MAX_BYTES &&
      inlineTotal + content.length <= INLINE_IMAGES_TOTAL_MAX_BYTES;
    if (inline) {
      cids.add(contentId);
      inlineTotal += content.length;
    }
    parts.push({
      meta: {
        idx: parts.length,
        filename: cleanFilename(a.filename ?? ""),
        content_type: contentType,
        size: content.length,
        content_id: contentId,
        disposition: inline ? "inline" : "attachment",
      },
      content,
    });
  }

  return {
    fields: {
      body_text: text ? text.text : null,
      body_html: html ? html.text : null,
      body_truncated: (text?.truncated ?? false) || (html?.truncated ?? false),
      snippet: snippetOf(text?.text ?? ""),
      has_attachments: parts.some((p) => p.meta.disposition === "attachment"),
      attachments: parts.map((p) => p.meta),
    },
    parts,
  };
}

/**
 * Types an attachment keeps when it is stored in mail-files. Everything else
 * -- HTML, SVG, XML, scripts, and anything unrecognised -- is stored as
 * application/octet-stream, so even a storage URL opened without its
 * download parameter can never render as a page on the storage origin.
 */
const PASSIVE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/bmp",
  "image/tiff",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/calendar",
  "application/zip",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
]);

export function storageContentType(raw: unknown): string {
  const t = cleanType(raw);
  if (PASSIVE_TYPES.has(t)) return t;
  if ((t.startsWith("audio/") || t.startsWith("video/")) && !/xml|html|script/.test(t)) return t;
  return "application/octet-stream";
}

/**
 * The last path segment for a stored part: "<idx>-<name>" in plain ASCII
 * (Supabase Storage refuses many characters in keys), extension kept, at
 * most 100 characters. The real file name travels in the signed URL's
 * download parameter, not in the key.
 */
export function storageObjectName(meta: Pick<AttachmentMeta, "idx" | "filename">): string {
  const idx = Number.isInteger(meta.idx) && meta.idx >= 0 ? meta.idx : 0;
  // NFKD splits "ô" into "o" and a combining accent; the accent is dropped
  // so "Devis clôture.pdf" becomes "Devis_cloture.pdf", not "clo_ture".
  const name = cleanFilename(meta.filename)
    .normalize("NFKD")
    .replace(/[\u{300}-\u{36f}]/gu, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "");
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
  const stem = (ext ? name.slice(0, dot) : name).slice(0, 80 - ext.length).replace(/[._]+$/, "");
  return `${idx}-${stem || "attachment"}${ext}`;
}

/**
 * cid -> data: URL for the parts bodyFields() marked inline (which already
 * applied the type allowlist and the INLINE_IMAGE_MAX_BYTES and
 * INLINE_IMAGES_TOTAL_MAX_BYTES caps). The checks are repeated, so parts
 * built some other way cannot smuggle an SVG or a 50 MB image through.
 */
export function inlineImages(parts: ReadonlyArray<MessagePart>): Record<string, string> {
  // No prototype: a part whose Content-ID is "__proto__" is just a key.
  const images: Record<string, string> = Object.create(null);
  let total = 0;
  for (const p of parts) {
    const cid = p.meta.content_id;
    if (p.meta.disposition !== "inline" || !cid || !INLINE_IMAGE_TYPES.has(p.meta.content_type) || Object.hasOwn(images, cid)) continue;
    if (p.content.length > INLINE_IMAGE_MAX_BYTES || total + p.content.length > INLINE_IMAGES_TOTAL_MAX_BYTES) continue;
    total += p.content.length;
    images[cid] = `data:${p.meta.content_type};base64,${base64(p.content)}`;
  }
  return images;
}
