/**
 * The IMAP wire format (RFC 3501), with no socket anywhere in it.
 *
 * Three layers, each a plain function:
 *
 *  1. Framing. readRawResponse() pulls one response off anything that can
 *     read a line and read N bytes. A response is text lines joined by
 *     literals: a line ending in {N} is followed by exactly N raw bytes, then
 *     the line carries on. Literal bytes are taken by COUNT and never
 *     scanned, which is the whole point -- a message header that contains
 *     ")" or ends a line with "{5}" is data, not syntax.
 *  2. Tokens. tokenize() turns a framed response into atoms, quoted
 *     strings, literals (Uint8Array), NIL (null) and nested lists.
 *  3. Meaning. parseSelect / parseSearch / parseFetch / parseListEntry read
 *     the handful of responses company email uses.
 *
 * Plus the few encoders a client needs (quoted strings, literals, UID sets,
 * search dates) and the two guards every sync depends on: filterNewUids()
 * for the "*" trap, and findSentFolder().
 *
 * imap-client.ts drives this over a transport; tests/mail-imap-proto.test.mjs
 * drives it over byte arrays under plain Node.
 */

import { MailError } from "./errors.ts";

// ---------------------------------------------------------------------------
// Framing.
// ---------------------------------------------------------------------------

export interface LineReader {
  /** One line without its CRLF. */
  readLine(): Promise<string>;
  /** Exactly n bytes. */
  readBytes(n: number): Promise<Uint8Array>;
}

/**
 * One response as it arrived. Even indexes are text, odd indexes are the
 * literal bytes announced by the {N} that ends the text before them.
 */
export type RawResponse = Array<string | Uint8Array>;

const LITERAL_AT_END = /~?\{(\d{1,10})\+?\}$/;
const LITERAL_TOKEN = /^~?\{\d{1,10}\+?\}$/;
/** No response company email reads carries more than a handful. */
const MAX_LITERALS_PER_RESPONSE = 64;

/** Status responses and continuations, whose text can never carry a literal
 *  (RFC 3501 resp-text). A server ending one with "{9999}" must not make us
 *  swallow 9999 bytes of whatever comes next. */
const NO_LITERALS = /^(?:\+|(?:\*|[A-Za-z0-9.]+) (?:OK|NO|BAD|BYE|PREAUTH)\b)/i;

export async function readRawResponse(reader: LineReader): Promise<RawResponse> {
  const parts: RawResponse = [];
  let line = await reader.readLine();
  if (NO_LITERALS.test(line)) return [line];
  for (;;) {
    const m = LITERAL_AT_END.exec(line);
    parts.push(line);
    if (!m) return parts;
    if (parts.length > MAX_LITERALS_PER_RESPONSE * 2) {
      throw new MailError("protocol_error", "Too many literals in one response.");
    }
    // The transport enforces the literal and session byte caps.
    parts.push(await reader.readBytes(Number(m[1])));
    line = await reader.readLine();
  }
}

// ---------------------------------------------------------------------------
// Tokens.
// ---------------------------------------------------------------------------

/** An atom or quoted string, literal bytes, NIL, or a parenthesised list. */
export type Token = string | Uint8Array | null | Token[];

const bad = (why: string) => new MailError("protocol_error", why);

/**
 * Tokens of a framed response (or of the part of one after its prefix).
 * Atoms may carry a bracketed section with spaces and parentheses inside
 * it -- BODY[HEADER.FIELDS (FROM TO)] is ONE token -- because that is how
 * FETCH names what it returned.
 */
export function tokenize(parts: RawResponse): Token[] {
  const root: Token[] = [];
  const stack: Token[][] = [root];
  const top = () => stack[stack.length - 1];

  for (let i = 0; i < parts.length; i += 2) {
    const s = parts[i];
    if (typeof s !== "string") throw bad("Literal where text was expected.");
    let p = 0;
    while (p < s.length) {
      const ch = s[p];
      if (ch === " ") {
        p++;
      } else if (ch === "(") {
        const list: Token[] = [];
        top().push(list);
        stack.push(list);
        p++;
      } else if (ch === ")") {
        if (stack.length === 1) throw bad("Unbalanced ')'.");
        stack.pop();
        p++;
      } else if (ch === '"') {
        let out = "";
        p++;
        let closed = false;
        while (p < s.length) {
          const c = s[p];
          if (c === "\\") {
            out += s[p + 1] ?? "";
            p += 2;
          } else if (c === '"') {
            closed = true;
            p++;
            break;
          } else {
            out += c;
            p++;
          }
        }
        if (!closed) throw bad("Unterminated quoted string.");
        top().push(out);
      } else if ((ch === "{" || ch === "~") && LITERAL_TOKEN.test(s.slice(p))) {
        // Only a {N} that ENDS the text is a literal; readRawResponse framed
        // it the same way, so the bytes are the next part.
        const lit = parts[i + 1];
        if (!(lit instanceof Uint8Array)) throw bad("Literal announced but missing.");
        top().push(lit);
        p = s.length;
      } else {
        const start = p;
        while (p < s.length) {
          const c = s[p];
          if (c === " " || c === "(" || c === ")") break;
          if (c === "[") {
            const close = s.indexOf("]", p);
            if (close < 0) throw bad("Unterminated '['.");
            p = close + 1;
            continue;
          }
          p++;
        }
        const atom = s.slice(start, p);
        top().push(atom.toUpperCase() === "NIL" ? null : atom);
      }
    }
  }
  if (stack.length !== 1) throw bad("Unbalanced '('.");
  return root;
}

// ---------------------------------------------------------------------------
// Responses.
// ---------------------------------------------------------------------------

export interface ImapResponse {
  kind: "untagged" | "tagged" | "continuation";
  /** The command tag, for a tagged response. */
  tag: string | null;
  /** Uppercased: OK NO BAD BYE PREAUTH, or CAPABILITY LIST SEARCH FLAGS
   *  EXISTS RECENT EXPUNGE FETCH ... */
  type: string;
  /** The message number in "* 12 EXISTS" / "* 12 FETCH". */
  num: number | null;
  /** The bracketed response code of a status response, uppercased. */
  code: string | null;
  codeArgs: Token[];
  /** Human text of a status response, or the text after "+". */
  text: string;
  /** Tokens after the type, for data responses. */
  data: Token[];
}

const STATUS_TYPES = new Set(["OK", "NO", "BAD", "BYE", "PREAUTH"]);

function textOf(parts: RawResponse): string {
  const dec = new TextDecoder();
  return parts.map((p) => (typeof p === "string" ? p : dec.decode(p))).join("");
}

function parseRespText(rest: string): { code: string | null; codeArgs: Token[]; text: string } {
  if (!rest.startsWith("[")) return { code: null, codeArgs: [], text: rest.trim() };
  const close = rest.indexOf("]");
  if (close < 0) return { code: null, codeArgs: [], text: rest.trim() };
  const inner = rest.slice(1, close);
  const sp = inner.indexOf(" ");
  const code = (sp < 0 ? inner : inner.slice(0, sp)).toUpperCase();
  let codeArgs: Token[] = [];
  if (sp >= 0) {
    try {
      codeArgs = tokenize([inner.slice(sp + 1)]);
    } catch {
      codeArgs = [inner.slice(sp + 1)];
    }
  }
  return { code, codeArgs, text: rest.slice(close + 1).trim() };
}

export function parseResponse(parts: RawResponse): ImapResponse {
  const first = parts[0];
  if (typeof first !== "string") throw bad("Response did not start with text.");
  const base = { tag: null, num: null, code: null, codeArgs: [] as Token[], text: "", data: [] as Token[] };

  if (first === "+" || first.startsWith("+ ")) {
    return { ...base, kind: "continuation", type: "+", text: textOf([first.slice(2), ...parts.slice(1)]) };
  }

  const sp = first.indexOf(" ");
  if (sp <= 0) throw bad("Response has no type.");
  const tag = first.slice(0, sp);
  let rest = first.slice(sp + 1);
  let num: number | null = null;

  if (tag === "*") {
    const numbered = /^(\d{1,10}) /.exec(rest);
    if (numbered) {
      num = Number(numbered[1]);
      rest = rest.slice(numbered[0].length);
    }
  }
  const typeMatch = /^([A-Za-z][A-Za-z0-9.-]*)/.exec(rest);
  if (!typeMatch) throw bad("Response has no type.");
  const type = typeMatch[1].toUpperCase();
  rest = rest.slice(typeMatch[0].length).replace(/^ /, "");

  if (tag !== "*" && !STATUS_TYPES.has(type)) throw bad(`Tagged response of type ${type}.`);

  if (STATUS_TYPES.has(type) && num === null) {
    const { code, codeArgs, text } = parseRespText(textOf([rest, ...parts.slice(1)]));
    return { ...base, kind: tag === "*" ? "untagged" : "tagged", tag: tag === "*" ? null : tag, type, code, codeArgs, text };
  }
  return { ...base, kind: "untagged", type, num, data: tokenize([rest, ...parts.slice(1)]) };
}

// ---------------------------------------------------------------------------
// Numbers.
// ---------------------------------------------------------------------------

const MAX_UID = 4294967295;

function toCount(t: Token): number | null {
  if (typeof t !== "string" || !/^\d{1,16}$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/** A UID or UIDVALIDITY: an unsigned 32-bit number above zero. */
function toUid(t: Token): number | null {
  const n = toCount(t);
  return n !== null && n >= 1 && n <= MAX_UID ? n : null;
}

// ---------------------------------------------------------------------------
// Meaning.
// ---------------------------------------------------------------------------

/** Capabilities from a CAPABILITY response or a [CAPABILITY ...] code. */
export function parseCapabilities(resp: ImapResponse): Set<string> {
  const tokens = resp.type === "CAPABILITY" ? resp.data : resp.code === "CAPABILITY" ? resp.codeArgs : [];
  return new Set(tokens.filter((t): t is string => typeof t === "string").map((t) => t.toUpperCase()));
}

export interface ListEntry {
  flags: string[];
  delimiter: string | null;
  /** Exactly as the server named it, to be sent back as-is. */
  path: string;
}

export function parseListEntry(resp: ImapResponse): ListEntry | null {
  if (resp.type !== "LIST" && resp.type !== "XLIST") return null;
  const [flags, delimiter, mailbox] = resp.data;
  if (!Array.isArray(flags)) return null;
  const path = mailbox instanceof Uint8Array ? new TextDecoder().decode(mailbox) : typeof mailbox === "string" ? mailbox : null;
  if (path === null) return null;
  return {
    flags: flags.filter((f): f is string => typeof f === "string"),
    delimiter: typeof delimiter === "string" ? delimiter : null,
    path,
  };
}

/** Where sent mail lives when the server does not say so with \Sent. */
export const SENT_FALLBACK_NAMES: ReadonlyArray<string> = ["Sent", "Sent Items", "Sent Mail", "[Gmail]/Sent Mail", "INBOX.Sent"];

/**
 * The Sent folder: the one flagged \Sent (RFC 6154) if any, otherwise the
 * first of the usual names, never a folder that cannot be selected. A user
 * folder that merely happens to be called "Sent Items" loses to the real
 * special-use folder whatever it is called.
 */
export function findSentFolder(entries: ReadonlyArray<ListEntry>): ListEntry | null {
  const selectable = entries.filter((e) => !e.flags.some((f) => /^\\(noselect|nonexistent)$/i.test(f)));
  const special = selectable.find((e) => e.flags.some((f) => f.toLowerCase() === "\\sent"));
  if (special) return special;
  for (const name of SENT_FALLBACK_NAMES) {
    const hit = selectable.find((e) => e.path.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

export interface SelectInfo {
  uidValidity: number;
  /** Null when the server does not send one. */
  uidNext: number | null;
  exists: number;
  readOnly: boolean;
}

/** The untagged responses to SELECT or EXAMINE, plus its tagged OK. */
export function parseSelect(untagged: ReadonlyArray<ImapResponse>, tagged: ImapResponse): SelectInfo {
  let uidValidity: number | null = null;
  let uidNext: number | null = null;
  let exists = 0;
  for (const r of untagged) {
    if (r.type === "EXISTS" && r.num !== null) exists = r.num;
    if (r.type === "OK" && r.code === "UIDVALIDITY") uidValidity = toUid(r.codeArgs[0] ?? null);
    if (r.type === "OK" && r.code === "UIDNEXT") uidNext = toUid(r.codeArgs[0] ?? null);
  }
  // Without UIDVALIDITY a cached UID means nothing: the same number could be
  // a different message tomorrow. Refuse rather than cache garbage.
  if (uidValidity === null) throw bad("The server sent no UIDVALIDITY.");
  return { uidValidity, uidNext, exists, readOnly: tagged.code === "READ-ONLY" };
}

/** UIDs from every SEARCH response of one command (some servers split). */
export function parseSearch(untagged: ReadonlyArray<ImapResponse>): number[] {
  const out: number[] = [];
  for (const r of untagged) {
    if (r.type !== "SEARCH") continue;
    for (const t of r.data) {
      if (Array.isArray(t)) break; // (MODSEQ n) under CONDSTORE ends the numbers
      const n = toUid(t);
      if (n !== null) out.push(n);
    }
  }
  return out;
}

export interface FetchedMessage {
  /** Message sequence number. */
  seq: number;
  uid: number | null;
  flags: string[] | null;
  /** ISO 8601, from INTERNALDATE. */
  internalDate: string | null;
  size: number | null;
  /** The header block, from BODY[HEADER.FIELDS (...)] or RFC822.HEADER. */
  headers: Uint8Array | null;
  /** The whole message, from BODY[] or RFC822. */
  source: Uint8Array | null;
}

function asBytes(t: Token): Uint8Array {
  if (t instanceof Uint8Array) return t;
  if (typeof t === "string") return new TextEncoder().encode(t);
  return new Uint8Array(0);
}

export function parseFetch(resp: ImapResponse): FetchedMessage | null {
  if (resp.type !== "FETCH" || resp.num === null) return null;
  const list = resp.data[0];
  if (!Array.isArray(list)) throw bad("FETCH without a list.");
  const msg: FetchedMessage = { seq: resp.num, uid: null, flags: null, internalDate: null, size: null, headers: null, source: null };
  for (let i = 0; i + 1 < list.length; i += 2) {
    const keyTok = list[i];
    if (typeof keyTok !== "string") throw bad("FETCH item name is not an atom.");
    const key = keyTok.toUpperCase();
    const val = list[i + 1];
    if (key === "UID") msg.uid = toUid(val);
    else if (key === "FLAGS") msg.flags = Array.isArray(val) ? val.filter((f): f is string => typeof f === "string") : [];
    else if (key === "INTERNALDATE") msg.internalDate = typeof val === "string" ? parseInternalDate(val) : null;
    else if (key === "RFC822.SIZE") msg.size = toCount(val);
    else if (key.startsWith("BODY[HEADER") || key === "RFC822.HEADER") msg.headers = asBytes(val);
    else if (key === "BODY[]" || key.startsWith("BODY[]<") || key === "RFC822") msg.source = asBytes(val);
  }
  return msg;
}

// ---------------------------------------------------------------------------
// UIDs.
// ---------------------------------------------------------------------------

/**
 * UIDs strictly above lastUid, unique, ascending.
 *
 * The trap this exists for: "UID FETCH 101:*" and "UID SEARCH UID 101:*"
 * mean "from 101 to the highest UID", and when nothing is above 100 the
 * range is read backwards as 100:101 -- so the server returns message 100,
 * the one already stored. Without this filter every quiet mailbox reports
 * one new message on every run.
 */
export function filterNewUids(uids: ReadonlyArray<number>, lastUid: number): number[] {
  return [...new Set(uids.filter((u) => Number.isInteger(u) && u > lastUid))].sort((a, b) => a - b);
}

/** The n highest, ascending. */
export function newestUids(uids: ReadonlyArray<number>, n: number): number[] {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  return n <= 0 ? [] : sorted.slice(-n);
}

/** The n lowest, ascending. */
export function oldestUids(uids: ReadonlyArray<number>, n: number): number[] {
  return [...new Set(uids)].sort((a, b) => a - b).slice(0, Math.max(0, n));
}

/** "4101:4103,4107" from [4101, 4102, 4103, 4107]. */
export function compressUidSet(uids: ReadonlyArray<number>): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  if (sorted.length === 0) throw new MailError("bad_request", "Empty UID set.");
  if (!sorted.every((u) => Number.isInteger(u) && u >= 1 && u <= MAX_UID)) {
    throw new MailError("bad_request", "Invalid UID.");
  }
  const out: string[] = [];
  let start = sorted[0];
  let prev = start;
  for (let i = 1; i <= sorted.length; i++) {
    const u = sorted[i];
    if (u === prev + 1) {
      prev = u;
      continue;
    }
    out.push(start === prev ? String(start) : `${start}:${prev}`);
    start = u;
    prev = u;
  }
  return out.join(",");
}

// ---------------------------------------------------------------------------
// Dates.
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** SEARCH SINCE date: "22-Aug-2026". Day granularity, UTC. */
export function imapDate(d: Date): string {
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/** INTERNALDATE "14-Sep-2026 09:12:44 -0400" (day may be space-padded) to ISO. */
export function parseInternalDate(s: string): string | null {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const month = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  if (month < 0) return null;
  const offsetMin = (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  const utc = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - offsetMin * 60_000;
  return Number.isFinite(utc) ? new Date(utc).toISOString() : null;
}

// ---------------------------------------------------------------------------
// Encoding arguments.
// ---------------------------------------------------------------------------

/** Bytes to send as a literal ({N} then the bytes). */
export interface ImapLiteral {
  literal: Uint8Array;
}

/** CR, LF and NUL cannot appear in any IMAP string, quoted or literal. */
const UNSENDABLE = /[\0\r\n]/;

/** A 7-bit quoted string. Throws on anything that needs a literal instead. */
export function quoteString(s: string): string {
  if (UNSENDABLE.test(s)) throw new MailError("bad_request", "Text contains a line break or NUL.");
  // deno-lint-ignore no-control-regex
  if (/[^\x01-\x7f]/.test(s)) throw new MailError("bad_request", "Text needs a literal.");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * An astring argument (user name, password, mailbox): a quoted string when
 * it is plain 7-bit text, otherwise a literal of its UTF-8 bytes. A password
 * with an "é" in it cannot be quoted, and sending it quoted anyway is how a
 * correct password gets reported as a wrong one.
 */
export function encodeAstring(s: string): string | ImapLiteral {
  if (UNSENDABLE.test(s)) throw new MailError("bad_request", "Text contains a line break or NUL.");
  // deno-lint-ignore no-control-regex
  if (/^[\x01-\x7f]*$/.test(s) && s.length <= 1000) return quoteString(s);
  return { literal: new TextEncoder().encode(s) };
}

/** The header fields sync fetches: enough to thread, list and link a
 *  message without downloading its body. */
export const HEADER_FIELDS: ReadonlyArray<string> = [
  "FROM",
  "TO",
  "CC",
  "REPLY-TO",
  "SUBJECT",
  "DATE",
  "MESSAGE-ID",
  "IN-REPLY-TO",
  "REFERENCES",
  "CONTENT-TYPE",
];
