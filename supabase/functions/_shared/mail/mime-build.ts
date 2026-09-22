/**
 * Outgoing mail as bytes a mail server will take unchanged, and the Resend
 * request for FenceFlow mail.
 *
 * mail-send hands this file what the office typed. Everything that decides
 * whether the result can be abused is here, in one pure file:
 *
 *  - Header injection. An address must match a strict pattern with no CR,
 *    LF or space anywhere, and is refused rather than repaired. The subject
 *    and display names have every control character turned into a space, so
 *    "Hi\r\nBcc: x@y" becomes one harmless subject line. Non-ASCII names and
 *    subjects go out as RFC 2047 encoded words.
 *  - Bcc. There is no Bcc input to buildMime() at all. Blind copies exist
 *    only in the SMTP envelope (smtp-client.ts) or in Resend's own bcc field,
 *    never as a header another recipient could read.
 *  - Line limits. Every header is folded at spaces to 78 columns where it
 *    can be, text parts that are not short plain ASCII go quoted-printable,
 *    and attachments go base64 at 76 columns. Nothing emitted is longer than
 *    998 characters or contains a byte above 0x7F.
 *  - Size. Recipients, attachments and text are capped by limits.ts.
 *
 * No Deno, no network, no clock: callers pass the Date and the Message-ID,
 * so tests/mail-mime.test.mjs checks exact output under plain Node and
 * parses it back with the vendored postal-mime.
 */

import { MailError } from "./errors.ts";
import {
  ATTACHMENTS_TOTAL_MAX_BYTES,
  DISPLAY_NAME_MAX_CHARS,
  MAX_ATTACHMENTS,
  MAX_RECIPIENTS_RESEND,
  MAX_RECIPIENTS_SMTP,
  REFERENCES_OUT_MAX,
  SEND_TEXT_MAX_BYTES,
  SIGNATURE_MAX_CHARS,
  SUBJECT_MAX_CHARS,
} from "./limits.ts";

const encoder = new TextEncoder();
const CRLF = "\r\n";
/** Header lines are folded to this where a space allows it (RFC 5322 2.1.1). */
const FOLD_AT = 78;
/** No line may be longer than this, ever (RFC 5322 2.1.1, RFC 5321 4.5.3.1.6). */
const HARD_LINE_LIMIT = 998;
/** Attachment names are cut to this many characters, extension kept. */
export const FILENAME_MAX_CHARS = 100;
/** Longest Message-ID accepted, ours or a parent's. Real ones are under 100;
 *  a longer one could not be folded onto one References line. */
export const MESSAGE_ID_MAX_CHARS = 250;
/** The References value on the Resend path. Resend is handed one unfolded
 *  string, so it has to stay well under the 998-character line limit. */
const RESEND_REFERENCES_MAX_CHARS = 900;
/** Entries looked at in one recipient list before validating any. */
const MAX_LIST_INPUT = 50;

// ---------------------------------------------------------------------------
// Addresses.
// ---------------------------------------------------------------------------

/** RFC 5322 dot-atom local part. No quoted local parts: nobody FenceFlow
 *  emails needs one, and they are where parser disagreements live. */
const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * One recipient address, domain lowercased, or bad_request. Refused, never
 * repaired: an address with a line break, a space, an angle bracket or any
 * non-ASCII character in it is an attempt to write a second header or a
 * second envelope command, not a typo.
 */
export function normalizeAddress(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  const refuse = () => new MailError("bad_request", "One of the email addresses is not valid.");
  // deno-lint-ignore no-control-regex
  if (!s || s.length > 254 || /[\u0000-\u0020\u007f-\uffff<>]/.test(s)) throw refuse();
  const at = s.lastIndexOf("@");
  if (at < 1) throw refuse();
  const local = s.slice(0, at);
  const domain = s.slice(at + 1).toLowerCase();
  if (local.length > 64 || domain.length > 253 || !LOCAL_RE.test(local) || !DOMAIN_RE.test(domain)) throw refuse();
  return `${local}@${domain}`;
}

export function isValidAddress(raw: unknown): boolean {
  try {
    normalizeAddress(raw);
    return true;
  } catch {
    return false;
  }
}

/** The bare address inside "FenceFlow <noreply@send.example.com>", or the
 *  value itself when it is already bare. Null when neither is valid. */
export function bareAddressOf(value: unknown): string | null {
  const s = String(value ?? "").trim();
  const m = /<([^<>]*)>\s*$/.exec(s);
  try {
    return normalizeAddress(m ? m[1] : s);
  } catch {
    return null;
  }
}

function addressList(raw: unknown, label: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new MailError("bad_request", `${label} must be a list of addresses.`);
  if (raw.length > MAX_LIST_INPUT) throw new MailError("bad_request", `Too many addresses in ${label}.`);
  return raw.map(normalizeAddress);
}

function dedupeAgainst(list: string[], seen: Set<string>): string[] {
  const out: string[] = [];
  for (const a of list) {
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text cleaning.
// ---------------------------------------------------------------------------

/** Bidirectional overrides and zero-width characters. In a name or a file
 *  name they make "exe.pdf" read as "fdp.exe" or hide part of a sender. */
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

function capChars(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join("");
}

/**
 * A display name: the same rule as invite-crew's senderWithName (no line
 * breaks, angle brackets or quotes, 70 characters), plus every other control
 * character and the invisible ones. Empty when nothing is left.
 */
export function cleanDisplayName(raw: unknown): string {
  const s = String(raw ?? "")
    .replace(INVISIBLE_RE, "")
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u001f\u007f<>"\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return capChars(s, DISPLAY_NAME_MAX_CHARS).trim();
}

/** A subject on one line: every control character (CR and LF included)
 *  becomes a space, runs of whitespace collapse. Length is checked by the
 *  callers, which refuse rather than cut. */
export function cleanSubject(raw: unknown): string {
  return String(raw ?? "")
    .replace(INVISIBLE_RE, "")
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function checkedSubject(raw: unknown): string {
  const s = cleanSubject(raw);
  if (Array.from(s).length > SUBJECT_MAX_CHARS) {
    throw new MailError("bad_request", `The subject is longer than ${SUBJECT_MAX_CHARS} characters.`);
  }
  return s;
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

/** A file name safe to put in a header and to show: no path, no control or
 *  invisible characters, nothing that closes a quoted string, at most
 *  FILENAME_MAX_CHARS with the extension kept. */
export function cleanFilename(raw: unknown): string {
  let s = String(raw ?? "")
    .replace(INVISIBLE_RE, "")
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/"]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  if (!s) return "attachment";
  if (Array.from(s).length > FILENAME_MAX_CHARS) {
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : "";
    s = capChars(s.slice(0, s.length - ext.length), FILENAME_MAX_CHARS - ext.length) + ext;
  }
  return s;
}

const TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * A MIME type fit to label an outgoing attachment. Anything malformed, and
 * any multipart/* or message/* (which may not be base64-encoded and would
 * change the message's structure), becomes application/octet-stream.
 */
export function safeContentType(raw: unknown): string {
  const t = String(raw ?? "").trim().toLowerCase();
  if (!TYPE_RE.test(t) || t.startsWith("multipart/") || t.startsWith("message/")) return "application/octet-stream";
  return t;
}

// ---------------------------------------------------------------------------
// Message-IDs.
// ---------------------------------------------------------------------------

/** Printable ASCII without space, "<" or ">". */
const ID_CHARS_RE = /^[\x21-\x3b\x3d\x3f-\x7e]+$/;

/** A Message-ID with its brackets stripped, or null if it is not one. */
export function cleanMessageId(raw: unknown): string | null {
  const s = String(raw ?? "").trim().replace(/^<+/, "").replace(/>+$/, "");
  if (!s || s.length > MESSAGE_ID_MAX_CHARS || !ID_CHARS_RE.test(s)) return null;
  return s;
}

/**
 * At most `max` ids, keeping the first (the root of the conversation) and
 * the most recent. RFC 5322 3.6.4 suggests exactly this when References
 * grows too long: the root still groups the thread, the tail still names
 * the parent.
 */
export function capIds(ids: ReadonlyArray<string>, max: number): string[] {
  if (max <= 0) return [];
  if (ids.length <= max) return [...ids];
  return max === 1 ? [ids[0]] : [ids[0], ...ids.slice(ids.length - (max - 1))];
}

/** First occurrence of each id kept, in order. */
export function dedupeIds(ids: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Encoding.
// ---------------------------------------------------------------------------

/** Base64 of any size. Input is taken 24 KB at a time (a multiple of 3, so
 *  the pieces join without padding in the middle). */
export function base64(bytes: Uint8Array): string {
  const STEP = 3 * 8192;
  let out = "";
  for (let i = 0; i < bytes.length; i += STEP) {
    out += btoa(String.fromCharCode(...bytes.subarray(i, i + STEP)));
  }
  return out;
}

function wrap76(s: string): string {
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += 76) lines.push(s.slice(i, i + 76));
  return lines.join(CRLF);
}

function needsEncoding(s: string): boolean {
  // "=?" is encoded too, so text the sender typed can never be read by the
  // recipient's client as an encoded word it did not write.
  return /[^\x20-\x7e]/.test(s) || s.includes("=?");
}

/**
 * RFC 2047 "B" encoded words of at most 36 bytes of UTF-8 each (60
 * characters with the wrapper), split between code points so a character
 * is never cut across two words. Decoders join adjacent encoded words and
 * ignore the whitespace between them, so the text comes back exactly.
 */
export function encodeWords(s: string): string[] {
  const MAX_BYTES = 36;
  const words: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of s) {
    const n = encoder.encode(ch).length;
    if (cur && curBytes + n > MAX_BYTES) {
      words.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += n;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${base64(encoder.encode(w))}?=`);
}

const HEX = "0123456789ABCDEF";

/**
 * Quoted-printable (RFC 2045 6.7) of UTF-8 text. Hard line breaks become
 * CRLF; soft breaks keep every line at 76 characters or fewer; "=", bytes
 * outside printable ASCII, and a space or tab that would end a line are
 * escaped. A line starting "From " has its F escaped, so a relay that
 * writes mbox files cannot turn it into ">From ".
 */
export function encodeQuotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of normalizeNewlines(text).split("\n")) {
    const bytes = encoder.encode(line);
    const fromLine = line.startsWith("From ");
    let cur = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      let tok: string;
      if (i === 0 && fromLine) tok = "=46";
      else if (b === 0x20 || b === 0x09) tok = i === bytes.length - 1 ? `=${HEX[b >> 4]}${HEX[b & 15]}` : String.fromCharCode(b);
      else if (b >= 0x21 && b <= 0x7e && b !== 0x3d) tok = String.fromCharCode(b);
      else tok = `=${HEX[b >> 4]}${HEX[b & 15]}`;
      if (cur.length + tok.length > 75) {
        out.push(`${cur}=`);
        cur = "";
      }
      cur += tok;
    }
    out.push(cur);
  }
  return out.join(CRLF);
}

/** RFC 2231 attr-char: what may appear unescaped in an extended parameter. */
const ATTR_CHAR_RE = /[A-Za-z0-9!#$&+\-.^_`|~]/;

function percentTokens(s: string): string[] {
  const toks: string[] = [];
  for (const b of encoder.encode(s)) {
    const ch = String.fromCharCode(b);
    toks.push(b < 0x80 && ATTR_CHAR_RE.test(ch) ? ch : `%${HEX[b >> 4]}${HEX[b & 15]}`);
  }
  return toks;
}

// ---------------------------------------------------------------------------
// Headers.
// ---------------------------------------------------------------------------

/**
 * "Name: tok tok tok", folded before a token whenever the line would pass 78
 * columns. Folding only ever inserts CRLF in front of an existing space, so
 * unfolding gives back exactly the value that was meant.
 */
function foldHeader(name: string, tokens: ReadonlyArray<string>): string {
  const lines: string[] = [];
  let line = `${name}:`;
  let onLine = 0;
  for (const tok of tokens) {
    if (onLine > 0 && line.length + 1 + tok.length > FOLD_AT) {
      lines.push(line);
      line = ` ${tok}`;
    } else {
      line += ` ${tok}`;
    }
    onLine++;
  }
  lines.push(line);
  for (const l of lines) {
    if (l.length > HARD_LINE_LIMIT) throw new MailError("bad_request", `The ${name} header is too long.`);
  }
  return lines.join(CRLF);
}

function phraseTokens(name: string): string[] {
  if (!name) return [];
  // cleanDisplayName has already removed quotes and backslashes, so an ASCII
  // name needs no escaping inside its quoted string.
  return needsEncoding(name) ? encodeWords(name) : [`"${name}"`];
}

function mailboxTokens(name: string, address: string): string[] {
  const phrase = phraseTokens(cleanDisplayName(name));
  return phrase.length ? [...phrase, `<${address}>`] : [address];
}

function listTokens(addresses: ReadonlyArray<string>): string[] {
  const toks: string[] = [];
  addresses.forEach((a, i) => toks.push(i < addresses.length - 1 ? `${a},` : a));
  return toks;
}

function unstructuredTokens(value: string): string[] {
  if (!value) return [];
  return needsEncoding(value) ? encodeWords(value) : value.split(" ");
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mon, 21 Sep 2026 18:13:00 +0000". Always UTC. */
export function rfc5322Date(d: Date): string {
  if (!(d instanceof Date) || !Number.isFinite(d.getTime())) throw new MailError("bad_request", "Invalid date.");
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`;
}

// ---------------------------------------------------------------------------
// Bodies.
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

function linkify(line: string): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(URL_RE)) {
    let url = m[0];
    // Sentence punctuation after a link is not part of it.
    const trail = /[.,;:!?)\]}]+$/.exec(url);
    if (trail) url = url.slice(0, url.length - trail[0].length);
    const at = m.index ?? 0;
    out += escapeHtml(line.slice(last, at));
    const safe = escapeHtml(url);
    out += `<a href="${safe}">${safe}</a>`;
    last = at + url.length;
  }
  return out + escapeHtml(line.slice(last));
}

function htmlInner(text: string): string {
  return normalizeNewlines(String(text ?? "")).split("\n")
    .map((l) => linkify(l).replace(/\t/g, "    ").replace(/ {2}/g, " &nbsp;"))
    .join("<br>\n");
}

function htmlDocument(inner: string): string {
  return `<!doctype html><html><body><div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;` +
    `line-height:1.5;color:#1a1a1a">${inner}</div></body></html>`;
}

/**
 * The HTML twin of a plain-text body. Everything is escaped; the only markup
 * added is <br>, non-breaking spaces to keep indentation, and links around
 * http(s) URLs (found in the raw text, escaped as a whole, so a link can
 * never close its own attribute).
 */
export function textToHtml(text: string): string {
  return htmlDocument(htmlInner(text));
}

/** The footer on FenceFlow mail, so a customer can tell who used what. */
export function fenceflowFooter(companyName: unknown): string {
  const name = cleanDisplayName(companyName);
  return name ? `Sent by ${name} using FenceFlow` : "Sent using FenceFlow";
}

/**
 * The text and HTML that go out: what was typed, then the signature under
 * the standard "-- " separator, then the footer (FenceFlow mail only).
 */
export function composeBody(input: { text: string; signature?: string | null; footer?: string | null }): {
  text: string;
  html: string;
} {
  const body = normalizeNewlines(String(input.text ?? "")).replace(/\s+$/, "");
  const sig = capChars(normalizeNewlines(String(input.signature ?? "")).trim(), SIGNATURE_MAX_CHARS);
  const footer = cleanSubject(input.footer ?? "");
  let text = body;
  let html = htmlInner(body);
  if (sig) {
    text += `\n\n-- \n${sig}`;
    html += `<br>\n<br>\n-- <br>\n${htmlInner(sig)}`;
  }
  if (footer) {
    text += `\n\n${footer}`;
    html += `<br>\n<br>\n<span style="font-size:12px;color:#8a93a0">${escapeHtml(footer)}</span>`;
  }
  return { text: `${text}\n`, html: htmlDocument(html) };
}

function textPart(subtype: "plain" | "html", content: string, boundaries: ReadonlyArray<string>): string {
  const text = normalizeNewlines(content);
  const lines = text.split("\n");
  // Short plain ASCII goes as it is; anything else quoted-printable, which
  // also guarantees the boundary (it contains "=_") cannot appear in it.
  const plain = /^[\t\x20-\x7e\n]*$/.test(text) &&
    lines.every((l) => l.length <= FOLD_AT && !l.startsWith("From ")) &&
    !boundaries.some((b) => text.includes(b));
  return [
    `Content-Type: text/${subtype}; charset=utf-8`,
    `Content-Transfer-Encoding: ${plain ? "7bit" : "quoted-printable"}`,
    "",
    plain ? lines.join(CRLF) : encodeQuotedPrintable(text),
  ].join(CRLF);
}

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

function checkedAttachments(list: ReadonlyArray<OutgoingAttachment> | undefined): OutgoingAttachment[] {
  const atts = [...(list ?? [])];
  if (atts.length > MAX_ATTACHMENTS) throw new MailError("bad_request", `At most ${MAX_ATTACHMENTS} attachments.`);
  let total = 0;
  for (const a of atts) {
    if (!a || !(a.content instanceof Uint8Array)) throw new MailError("bad_request", "Invalid attachment.");
    total += a.content.length;
  }
  if (total > ATTACHMENTS_TOTAL_MAX_BYTES) throw new MailError("too_large", "Attachments are larger than 10 MB in total.");
  return atts;
}

function nameParamTokens(name: string): string[] {
  if (!needsEncoding(name)) return [`name="${name}"`];
  // Encoded words inside a quoted parameter break RFC 2047 but are what
  // older clients read; filename* below is what current ones prefer.
  const words = encodeWords(name);
  if (words.length === 1) return [`name="${words[0]}"`];
  return [`name="${words[0]}`, ...words.slice(1, -1), `${words[words.length - 1]}"`];
}

function filenameParamTokens(name: string): string[] {
  if (!needsEncoding(name)) return [`filename="${name}"`];
  // RFC 2231: utf-8'' percent-encoding, cut into numbered continuations so
  // no line passes the fold width. A %XX is never split.
  const chunks: string[] = [];
  let cur = "";
  for (const tok of percentTokens(name)) {
    if (cur.length + tok.length > 60) {
      chunks.push(cur);
      cur = "";
    }
    cur += tok;
  }
  if (cur) chunks.push(cur);
  if (chunks.length === 1) return [`filename*=utf-8''${chunks[0]}`];
  return chunks.map((c, i) => `filename*${i}*=${i === 0 ? "utf-8''" : ""}${c}${i < chunks.length - 1 ? ";" : ""}`);
}

function attachmentPart(a: OutgoingAttachment): string {
  const name = cleanFilename(a.filename);
  return [
    foldHeader("Content-Type", [`${safeContentType(a.contentType)};`, ...nameParamTokens(name)]),
    foldHeader("Content-Disposition", ["attachment;", ...filenameParamTokens(name)]),
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(base64(a.content)),
  ].join(CRLF);
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// The whole message.
// ---------------------------------------------------------------------------

export interface OutgoingMail {
  /** Always the account's own address; the name defaults to the company. */
  from: { name?: string | null; address: string };
  to: ReadonlyArray<string>;
  cc?: ReadonlyArray<string>;
  replyTo?: string | null;
  subject: string;
  text: string;
  /** Defaults to textToHtml(text). */
  html?: string | null;
  /** Without brackets, e.g. from reply.newMessageId(). */
  messageId: string;
  inReplyTo?: string | null;
  references?: ReadonlyArray<string>;
  date: Date;
  attachments?: ReadonlyArray<OutgoingAttachment>;
}

export interface BuiltMail {
  bytes: Uint8Array;
  messageId: string;
}

/**
 * The complete RFC 5322 message: headers, then multipart/alternative (text
 * and HTML), inside multipart/mixed when there are attachments. The result
 * is 7-bit ASCII with CRLF line ends, ready for SMTP DATA (smtp-client
 * dot-stuffs it) or IMAP APPEND. There is no Bcc parameter; a `bcc` key on
 * the object is ignored.
 */
export function buildMime(mail: OutgoingMail): BuiltMail {
  const fromAddress = normalizeAddress(mail?.from?.address);
  const seen = new Set<string>();
  const to = dedupeAgainst(addressList(mail.to, "To"), seen);
  const cc = dedupeAgainst(addressList(mail.cc ?? [], "Cc"), seen);
  if (to.length === 0) throw new MailError("bad_request", "Add at least one recipient.");
  if (to.length + cc.length > MAX_RECIPIENTS_SMTP) {
    throw new MailError("bad_request", `At most ${MAX_RECIPIENTS_SMTP} recipients.`);
  }
  const replyTo = mail.replyTo ? normalizeAddress(mail.replyTo) : null;
  const subject = checkedSubject(mail.subject);
  const messageId = cleanMessageId(mail.messageId);
  if (!messageId || !messageId.includes("@")) throw new MailError("bad_request", "Invalid Message-ID.");
  const inReplyTo = mail.inReplyTo ? cleanMessageId(mail.inReplyTo) : null;
  const references = capIds(dedupeIds((mail.references ?? []).map(cleanMessageId)), REFERENCES_OUT_MAX);
  const attachments = checkedAttachments(mail.attachments);
  const text = String(mail.text ?? "");
  const html = mail.html ? String(mail.html) : textToHtml(text);

  const base = `=_FenceFlow_${randomHex(12)}`;
  const alt = `${base}_a`;
  const mixed = `${base}_m`;

  const headers = [
    foldHeader("From", mailboxTokens(String(mail.from.name ?? ""), fromAddress)),
    foldHeader("To", listTokens(to)),
    ...(cc.length ? [foldHeader("Cc", listTokens(cc))] : []),
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    foldHeader("Subject", unstructuredTokens(subject)),
    `Date: ${rfc5322Date(mail.date)}`,
    `Message-ID: <${messageId}>`,
    ...(inReplyTo ? [`In-Reply-To: <${inReplyTo}>`] : []),
    ...(references.length ? [foldHeader("References", references.map((r) => `<${r}>`))] : []),
    "MIME-Version: 1.0",
  ];

  const bounds = [alt, mixed];
  const alternative = [
    `--${alt}`,
    textPart("plain", text, bounds),
    `--${alt}`,
    textPart("html", html, bounds),
    `--${alt}--`,
  ].join(CRLF);

  // Folded like every other header: with the boundary on one line the
  // Content-Type runs past 78 columns.
  const altType = foldHeader("Content-Type", ["multipart/alternative;", `boundary="${alt}"`]);
  let top: string[];
  if (attachments.length === 0) {
    top = [altType, "", alternative];
  } else {
    const parts = [`--${mixed}`, altType, "", alternative];
    for (const a of attachments) parts.push(`--${mixed}`, attachmentPart(a));
    parts.push(`--${mixed}--`);
    top = [foldHeader("Content-Type", ["multipart/mixed;", `boundary="${mixed}"`]), "", parts.join(CRLF)];
  }

  const message = [...headers, ...top].join(CRLF) + CRLF;
  // Invariant, not validation: everything above only ever produces ASCII.
  // deno-lint-ignore no-control-regex
  if (/[^\x00-\x7f]/.test(message)) throw new MailError("server_error", "Non-ASCII byte in a built message.");
  return { bytes: encoder.encode(message), messageId };
}

// ---------------------------------------------------------------------------
// What the office sent, checked once for both paths.
// ---------------------------------------------------------------------------

export interface SendFields {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
}

/**
 * The recipient lists, subject and text of a mail-send request, normalised
 * or refused. Addresses are de-duplicated across the lists (To wins, then
 * Cc), `maxRecipients` counts all three (MAX_RECIPIENTS_SMTP or
 * MAX_RECIPIENTS_RESEND), the subject is one line of at most 300
 * characters, and the text at most 100 KB of UTF-8.
 */
export function validateSendFields(
  input: { to?: unknown; cc?: unknown; bcc?: unknown; subject?: unknown; text?: unknown },
  maxRecipients: number,
): SendFields {
  const seen = new Set<string>();
  const to = dedupeAgainst(addressList(input.to ?? [], "To"), seen);
  const cc = dedupeAgainst(addressList(input.cc, "Cc"), seen);
  const bcc = dedupeAgainst(addressList(input.bcc, "Bcc"), seen);
  if (to.length === 0) throw new MailError("bad_request", "Add at least one recipient.");
  if (to.length + cc.length + bcc.length > maxRecipients) {
    throw new MailError("bad_request", `At most ${maxRecipients} recipients.`);
  }
  if (input.subject !== undefined && input.subject !== null && typeof input.subject !== "string") {
    throw new MailError("bad_request", "Invalid subject.");
  }
  if (typeof input.text !== "string") throw new MailError("bad_request", "Invalid message text.");
  const text = normalizeNewlines(input.text.replace(/\u0000/g, ""));
  if (encoder.encode(text).length > SEND_TEXT_MAX_BYTES) throw new MailError("too_large", "The message text is too long.");
  return { to, cc, bcc, subject: checkedSubject(input.subject), text };
}

// ---------------------------------------------------------------------------
// FenceFlow mail (Resend).
// ---------------------------------------------------------------------------

/**
 * The sender of FenceFlow mail: the company's name on FenceFlow's own
 * verified address. The bare address is taken out of MAIL_FROM, so the
 * company name still shows when MAIL_FROM is "FenceFlow <noreply@...>" (the
 * older senderWithName returns such a MAIL_FROM unchanged and the company
 * name is lost). not_configured when MAIL_FROM holds no valid address.
 */
export function fenceflowFrom(companyName: unknown, mailFrom: unknown, fallbackName = "FenceFlow"): {
  name: string;
  address: string;
} {
  const address = bareAddressOf(mailFrom);
  if (!address) throw new MailError("not_configured", "MAIL_FROM is not a valid address.");
  return { name: cleanDisplayName(companyName) || cleanDisplayName(fallbackName), address };
}

/** References for a provider that takes the header as one unfolded string:
 *  the root and the most recent ids that fit in RESEND_REFERENCES_MAX_CHARS. */
export function referencesHeaderValue(ids: ReadonlyArray<string>): string {
  const clean = dedupeIds(ids.map(cleanMessageId));
  if (clean.length === 0) return "";
  const kept: string[] = [];
  let len = clean[0].length + 2;
  for (let i = clean.length - 1; i >= 1; i--) {
    const add = clean[i].length + 3;
    if (len + add > RESEND_REFERENCES_MAX_CHARS) break;
    kept.unshift(clean[i]);
    len += add;
  }
  return [clean[0], ...kept].map((id) => `<${id}>`).join(" ");
}

export interface ResendMailInput {
  /** From fenceflowFrom(). */
  from: { name: string; address: string };
  to: ReadonlyArray<string>;
  cc?: ReadonlyArray<string>;
  /** Resend's own bcc field: an envelope recipient, never a header. */
  bcc?: ReadonlyArray<string>;
  replyTo?: string | null;
  subject: string;
  /** From composeBody() with the FenceFlow footer. */
  text: string;
  html: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: ReadonlyArray<string>;
  attachments?: ReadonlyArray<{ filename: string; content: Uint8Array }>;
}

/**
 * The JSON body for POST {MAIL_API_URL} (Resend's /emails), with the same
 * checks buildMime applies: every address validated, at most
 * MAX_RECIPIENTS_RESEND in total, one-line subject, threading headers, and
 * attachments as base64 within the same caps.
 */
export function buildResendEmail(input: ResendMailInput): Record<string, unknown> {
  const fromAddress = normalizeAddress(input?.from?.address);
  const fromName = cleanDisplayName(input.from.name);
  const seen = new Set<string>();
  const to = dedupeAgainst(addressList(input.to, "To"), seen);
  const cc = dedupeAgainst(addressList(input.cc ?? [], "Cc"), seen);
  const bcc = dedupeAgainst(addressList(input.bcc ?? [], "Bcc"), seen);
  if (to.length === 0) throw new MailError("bad_request", "Add at least one recipient.");
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS_RESEND) {
    throw new MailError("bad_request", `At most ${MAX_RECIPIENTS_RESEND} recipients with FenceFlow mail.`);
  }
  const messageId = cleanMessageId(input.messageId);
  if (!messageId || !messageId.includes("@")) throw new MailError("bad_request", "Invalid Message-ID.");
  const inReplyTo = input.inReplyTo ? cleanMessageId(input.inReplyTo) : null;
  const references = referencesHeaderValue(capIds(dedupeIds((input.references ?? []).map(cleanMessageId)), REFERENCES_OUT_MAX));
  const attachments = checkedAttachments(
    (input.attachments ?? []).map((a) => ({ filename: a.filename, contentType: "application/octet-stream", content: a.content })),
  );

  const headers: Record<string, string> = { "Message-ID": `<${messageId}>` };
  if (inReplyTo) headers["In-Reply-To"] = `<${inReplyTo}>`;
  if (references) headers["References"] = references;

  return {
    from: fromName ? `"${fromName}" <${fromAddress}>` : fromAddress,
    to,
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    ...(input.replyTo ? { reply_to: normalizeAddress(input.replyTo) } : {}),
    subject: checkedSubject(input.subject),
    text: String(input.text ?? ""),
    html: String(input.html ?? ""),
    headers,
    ...(attachments.length
      ? { attachments: attachments.map((a) => ({ filename: cleanFilename(a.filename), content: base64(a.content) })) }
      : {}),
  };
}
