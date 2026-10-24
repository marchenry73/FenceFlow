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

/**
 * An https URL, or null. No repair, no other scheme: the one thing this guards
 * is an src attribute, and a scheme that is not https there has no business in
 * an email this product sends.
 */
function httpsOnly(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function htmlDocument(inner: string): string {
  return `<!doctype html><html><body><div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;` +
    `line-height:1.5;color:#1a1a1a">${inner}</div></body></html>`;
}

// ---------------------------------------------------------------------------
// The look of a letter a customer opens.
//
// Tables, not flexbox or grid. Not nostalgia: Outlook on Windows renders mail
// through Word, which supports neither, and a layout that collapses there
// collapses for a large share of the people being quoted. Inline styles for
// the same reason -- Gmail strips <style> blocks.
// ---------------------------------------------------------------------------

/** The page behind the card, and the card itself. */
const MAIL_PAGE_BG = "#eef1f5";
const MAIL_CARD_BG = "#ffffff";
const MAIL_BORDER = "#dfe4ea";
const MAIL_INK = "#1a1a1a";
const MAIL_MUTED = "#6b7280";
/** The one colour on the page when the company has not chosen one. */
const MAIL_ACCENT = "#1f3b57";

/**
 * A #rrggbb the company chose, or null.
 *
 * Strict on purpose. This value is interpolated into a style attribute, so
 * anything that is not exactly six hex digits is dropped rather than repaired
 * -- a "colour" like `red;background:url(...)` is not a colour, and a
 * near-miss silently becoming black is worse than falling back to the default
 * the whole product already looks like.
 */
function brandColor(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
}

/**
 * Black or white, whichever can actually be read on [hex].
 *
 * WCAG relative luminance, not a guess at "is it dark". A mid yellow and a
 * mid blue have wildly different luminance at the same apparent brightness,
 * and white text on a pale brand colour is a button a customer cannot read --
 * which on the one email that asks for money is not a cosmetic problem.
 */
function readableOn(hex: string): string {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lum = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  // 0.179 is where white and black contrast equally against a colour; above
  // it black wins, below it white does.
  return lum > 0.179 ? "#111111" : "#ffffff";
}

/**
 * The page behind the card, as a very light wash of the brand colour.
 *
 * Mixed with white at 92%, so it reads as a tint rather than as the colour
 * itself -- a full-strength brand colour across a whole page is the thing
 * that makes an email look like a flyer. Computed rather than asked for,
 * because one colour to pick is a setting somebody fills in and two is a
 * setting somebody gets wrong.
 */
function tintOf(hex: string): string {
  const mix = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
    return Math.round(v + (255 - v) * 0.92).toString(16).padStart(2, "0");
  };
  return "#" + mix(0) + mix(1) + mix(2);
}

/** At most one URL, and not much else: the line that becomes the button. */
const CTA_LINE_RE = /^\s*(.{0,40}?)\s*(https?:\/\/[^\s<>"'`]+)\s*$/;

/**
 * The letter's lines, with the first link line turned into a button.
 *
 * Returns the HTML for the body and nothing else; the caller owns the shell.
 *
 * AT MOST TWO lines are promoted; the rest stay ordinary links, so an email
 * still cannot turn into a row of buttons. Two rather than one because a
 * quote has two things to do -- look at the fence, pay the deposit -- and
 * making the customer hunt for the second in a paragraph is how a deposit
 * goes unpaid. A third button is where a letter stops being a letter.
 *
 * [hideCtaUrl] drops the address printed under each button. The default is
 * false and should stay false: a button with no visible URL is the shape a
 * phishing mail has. Only a letter whose recipient is expecting it, by name,
 * from a company they have spoken to, should opt out.
 */
function htmlLetter(
  text: string,
  accent: string,
  onAccent: string,
  hideCtaUrl = false,
): string {
  const lines = normalizeNewlines(String(text ?? "")).split("\n");
  const MAX_CTA_BUTTONS = 2;
  let used = 0;
  const out: string[] = [];
  for (const line of lines) {
    const m = used >= MAX_CTA_BUTTONS || line.trimStart().startsWith(">")
      ? null
      : CTA_LINE_RE.exec(line);
    if (m && m[2]) {
      used++;
      // The words already beside the link, in the letter's own language.
      // Trailing punctuation is the sentence's, not the label's.
      const label = m[1].replace(/[\s:：-]+$/, "").trim();
      const href = escapeHtml(m[2]);
      out.push(
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0">` +
          `<tr><td style="border-radius:6px;background:${accent}">` +
          `<a href="${href}" style="display:inline-block;padding:12px 26px;font-family:Arial,Helvetica,sans-serif;` +
          `font-size:15px;font-weight:bold;color:${onAccent};text-decoration:none;border-radius:6px">` +
          `${escapeHtml(label || "Open")}</a></td></tr></table>`,
      );
      // The address in full underneath, small and grey. A button with no
      // visible URL is the shape a phishing mail has; a customer who wants to
      // see where it goes before pressing it can. Dropped only where the
      // caller has asked -- see hideCtaUrl.
      if (!hideCtaUrl) {
        out.push(
          `<div style="font-size:12px;color:${MAIL_MUTED};margin:-8px 0 4px;word-break:break-all">` +
            `<a href="${href}" style="color:${MAIL_MUTED}">${href}</a></div>`,
        );
      }
      continue;
    }
    out.push(linkify(line).replace(/\t/g, "    ").replace(/ {2}/g, " &nbsp;") + "<br>");
  }
  return out.join("\n");
}

/** The header: the logo if it arrives, and the company's name whether it does or not. */
function htmlHeader(logo: string | null, company: string, accent: string): string {
  const name = company
    ? `<div style="font-size:17px;font-weight:bold;color:${MAIL_INK};letter-spacing:.2px">${escapeHtml(company)}</div>`
    : "";
  const img = logo
    ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(company)}" ` +
      `style="display:block;max-height:52px;max-width:220px;width:auto;border:0;margin:0 0 8px">`
    : "";
  if (!img && !name) return "";
  // A 3px rule in the company's own colour, under its own name. One line,
  // and it is the thing that makes the letter look like theirs rather than
  // like a template with their name typed into it.
  return `<tr><td style="padding:22px 28px 14px 28px;border-bottom:3px solid ${accent}">${img}${name}</td></tr>`;
}

/** The whole card: header, letter, footer. */
function htmlCard(header: string, letter: string, footer: string, page: string): string {
  const foot = footer
    ? `<tr><td style="padding:14px 28px 22px 28px;border-top:1px solid ${MAIL_BORDER};` +
      `font-size:12px;line-height:1.5;color:${MAIL_MUTED}">${footer}</td></tr>`
    : "";
  // THE VIEWPORT META IS NOT OPTIONAL ON A PHONE. Without it a mail client's
  // web view lays the message out at a desktop width (980px here, measured)
  // and then shrinks the whole thing to fit, so the card renders as a stamp
  // with the text too small to read. text-size-adjust stops iOS inflating the
  // type afterwards and undoing the spacing.
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0;padding:0;background:${page};` +
    `-webkit-text-size-adjust:100%;text-size-adjust:100%">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="background:${page};padding:24px 12px">` +
    `<tr><td align="center">` +
    // NO width="600" ATTRIBUTE. It was there for Outlook on Windows, and on a
    // phone it forced the whole page to 600px: the card rendered a third of
    // the width of the screen with the rest of the page scrolling off to the
    // right. Caught by looking at it at 375px, which is the width almost every
    // customer reads this on. max-width does the same job everywhere that is
    // not Word-rendered Outlook, and a slightly wide card there beats an
    // unreadable one on every phone.
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ` +
    `style="max-width:600px;width:100%;background:${MAIL_CARD_BG};border:1px solid ${MAIL_BORDER};border-radius:10px">` +
    header +
    `<tr><td style="padding:20px 28px 6px 28px;font-family:Arial,Helvetica,sans-serif;font-size:14px;` +
    `line-height:1.6;color:${MAIL_INK}">${letter}</td></tr>` +
    foot +
    `</table></td></tr></table></body></html>`;
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
 *
 * logoUrl, when given, becomes the letterhead at the top of the HTML part and
 * NOTHING in the plain-text part. That asymmetry is the point: a plain-text
 * reader gets the letter, unchanged, with no line of URL where a picture would
 * have been. The alt text is the company name, so the many mail clients that
 * block remote images by default show the name rather than a broken frame --
 * and the letter below it never depended on the picture arriving.
 *
 * It must be an https URL. Anything else is dropped rather than repaired: the
 * only caller signs one from storage, and a data: or javascript: URI reaching
 * an src attribute here is a bug worth refusing instead of escaping.
 */
export function composeBody(input: {
  text: string;
  signature?: string | null;
  footer?: string | null;
  logoUrl?: string | null;
  logoAlt?: string | null;
  /**
   * The company's own colour, as #rrggbb. Anything else -- absent, blank,
   * three-digit, a named colour, something with a semicolon in it -- falls
   * back to the product's own steel blue rather than being repaired.
   */
  brandColor?: string | null;
  /**
   * Drop the grey address printed under each button.
   *
   * Default false, and it should stay false for anything a stranger might
   * receive: a button with no visible URL is the shape a phishing mail has.
   * The quote email sets it because its recipient asked for the quote, knows
   * the company, and is being shown two buttons where the addresses are long
   * enough to bury the letter.
   */
  hideCtaUrl?: boolean;
}): {
  text: string;
  html: string;
} {
  const body = normalizeNewlines(String(input.text ?? "")).replace(/\s+$/, "");
  const sig = capChars(normalizeNewlines(String(input.signature ?? "")).trim(), SIGNATURE_MAX_CHARS);
  const footer = cleanSubject(input.footer ?? "");
  const logo = httpsOnly(input.logoUrl);
  const company = cleanDisplayName(input.logoAlt) || "";
  const accent = brandColor(input.brandColor) ?? MAIL_ACCENT;
  const onAccent = readableOn(accent);
  const page = brandColor(input.brandColor) ? tintOf(accent) : MAIL_PAGE_BG;
  let text = body;
  // The letter, and the one link in it as a button. The plain-text part below
  // is assembled exactly as it always was -- same sentences, same order, same
  // separator before the signature -- because a reader on plain text must get
  // the letter they got yesterday.
  let html = htmlLetter(body, accent, onAccent, input.hideCtaUrl === true);
  if (sig) {
    text += `\n\n-- \n${sig}`;
    html += `\n<div style="margin-top:18px;padding-top:14px;border-top:1px solid ${MAIL_BORDER}">` +
      `${htmlInner(sig)}</div>`;
  }
  let foot = "";
  if (footer) {
    text += `\n\n${footer}`;
    foot = escapeHtml(footer);
  }
  return {
    text: `${text}\n`,
    html: htmlCard(htmlHeader(logo, company, accent), html, foot, page),
  };
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
/**
 * The same message, shaped for Brevo's transactional API.
 *
 * WHY A SECOND BUILDER AND NOT A TRANSLATION of the Resend one: the two differ
 * in more than field names. Brevo takes sender and recipients as objects
 * rather than strings, its attachments key is singular (`attachment`, with
 * `name` not `filename`), and its reply-to is an object. Translating one
 * payload into the other at the last moment is where a field quietly stops
 * being sent -- a missing Message-ID header does not fail, it just breaks
 * threading for every reply afterwards.
 *
 * WHAT IS DELIBERATELY IDENTICAL: every check. The address parsing, the
 * de-duplication across To/Cc/Bcc, the recipient cap, the Message-ID and
 * References handling and the attachment limits are the SAME functions
 * buildResendEmail calls, so a message that one provider would refuse is
 * refused by the other for the same reason. Which service carries the mail is
 * not an invitation to validate it differently.
 *
 * The recipient cap is Resend's deliberately. Brevo allows more, but a cap
 * that moved when the platform admin flipped a setting would mean a message
 * accepted yesterday is refused today with nothing on screen explaining it.
 */
export function buildBrevoEmail(input: ResendMailInput): Record<string, unknown> {
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

  const box = (address: string) => ({ email: address });

  return {
    sender: fromName ? { email: fromAddress, name: fromName } : { email: fromAddress },
    to: to.map(box),
    ...(cc.length ? { cc: cc.map(box) } : {}),
    ...(bcc.length ? { bcc: bcc.map(box) } : {}),
    ...(input.replyTo ? { replyTo: box(normalizeAddress(input.replyTo)) } : {}),
    subject: checkedSubject(input.subject),
    textContent: String(input.text ?? ""),
    htmlContent: String(input.html ?? ""),
    headers,
    ...(attachments.length
      ? { attachment: attachments.map((a) => ({ name: cleanFilename(a.filename), content: base64(a.content) })) }
      : {}),
  };
}

/**
 * Put the final Reply-To on a payload whichever provider built it.
 *
 * A brand-new thread has no reply token until the message has been claimed, so
 * the address is completed after the claim -- and the two providers spell that
 * field differently. Said once, here, because the alternative is an `if` at
 * the call site that is easy to update for one provider and forget for the
 * other, and a missing Reply-To sends the customer's answer to an address
 * nobody reads.
 */
export function setPayloadReplyTo(
  payload: Record<string, unknown>,
  provider: "resend" | "brevo",
  address: string,
): void {
  const clean = normalizeAddress(address);
  if (provider === "brevo") payload.replyTo = { email: clean };
  else payload.reply_to = clean;
}

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
