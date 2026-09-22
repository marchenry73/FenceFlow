// The IMAP wire format, as pure functions over bytes. No socket, no Deno.
//
// Run with:  node --test tests/mail-imap-proto.test.mjs
//
// Framing is tested through the real StreamTransport over a fake socket that
// hands out THREE bytes per read, so every line and literal crosses read
// boundaries the way a slow TLS stream delivers them.
import test from "node:test";
import assert from "node:assert/strict";
import { StreamTransport } from "../supabase/functions/_shared/mail/tls-transport.ts";
import {
  compressUidSet,
  encodeAstring,
  filterNewUids,
  findSentFolder,
  imapDate,
  newestUids,
  oldestUids,
  parseCapabilities,
  parseFetch,
  parseInternalDate,
  parseListEntry,
  parseResponse,
  parseSearch,
  parseSelect,
  quoteString,
  readRawResponse,
  tokenize,
} from "../supabase/functions/_shared/mail/imap-proto.ts";
import { MailError } from "../supabase/functions/_shared/mail/errors.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A ByteConn that serves fixed bytes, `chunk` at a time, then EOF. */
function byteConn(bytes, chunk = 3) {
  let off = 0;
  return {
    async read(p) {
      if (off >= bytes.length) return null;
      const n = Math.min(chunk, p.length, bytes.length - off);
      p.set(bytes.subarray(off, off + n));
      off += n;
      return n;
    },
    async write(p) {
      return p.length;
    },
    close() {},
  };
}

function transportOver(text, chunk = 3, limits = {}) {
  const bytes = typeof text === "string" ? enc.encode(text) : text;
  return new StreamTransport(byteConn(bytes, chunk), { opTimeoutMs: 1000, ...limits });
}

/** Builds a server byte stream, computing {N} for each literal. */
function wire(...pieces) {
  let s = "";
  for (const p of pieces) s += typeof p === "string" ? p : `{${enc.encode(p.lit).length}}\r\n${p.lit}`;
  return s;
}

async function readAll(t, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(parseResponse(await readRawResponse(t)));
  return out;
}

function throwsCode(fn, code) {
  assert.throws(fn, (e) => e instanceof MailError && e.code === code);
}

// ---------------------------------------------------------------------------
// Tokens.
// ---------------------------------------------------------------------------

test("tokenize: atoms, quoted strings with escapes, NIL, nested lists", () => {
  const t = tokenize(['A "b \\"c\\" \\\\d" NIL "NIL" (x (y z) ()) \\Seen']);
  assert.deepEqual(t, ["A", 'b "c" \\d', null, "NIL", ["x", ["y", "z"], []], "\\Seen"]);
});

test("tokenize: a FETCH section name is one token, parentheses and all", () => {
  const t = tokenize(["(BODY[HEADER.FIELDS (FROM TO)] NIL BODY[]<0> NIL)"]);
  assert.deepEqual(t, [["BODY[HEADER.FIELDS (FROM TO)]", null, "BODY[]<0>", null]]);
});

test("tokenize: unbalanced input is a protocol error, not a guess", () => {
  throwsCode(() => tokenize(["(a (b)"]), "protocol_error");
  throwsCode(() => tokenize(["a)"]), "protocol_error");
  throwsCode(() => tokenize(['"never closed']), "protocol_error");
});

// ---------------------------------------------------------------------------
// Responses.
// ---------------------------------------------------------------------------

test("status responses: codes, arguments and text", () => {
  const ok = parseResponse(["* OK [UIDVALIDITY 1729000001] UIDs valid"]);
  assert.equal(ok.kind, "untagged");
  assert.equal(ok.type, "OK");
  assert.equal(ok.code, "UIDVALIDITY");
  assert.deepEqual(ok.codeArgs, ["1729000001"]);
  assert.equal(ok.text, "UIDs valid");

  const pf = parseResponse(["* OK [PERMANENTFLAGS (\\Seen \\*)] Limited"]);
  assert.deepEqual(pf.codeArgs, [["\\Seen", "\\*"]]);

  const no = parseResponse(["A5 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)"]);
  assert.equal(no.kind, "tagged");
  assert.equal(no.tag, "A5");
  assert.equal(no.type, "NO");
  assert.equal(no.code, "AUTHENTICATIONFAILED");
  assert.equal(no.text, "Invalid credentials (Failure)");

  const cont = parseResponse(["+ Ready for literal data"]);
  assert.equal(cont.kind, "continuation");
  assert.equal(cont.text, "Ready for literal data");
  assert.equal(parseResponse(["+"]).kind, "continuation");
});

test("capabilities from a CAPABILITY response and from a [CAPABILITY] code", () => {
  assert.ok(parseCapabilities(parseResponse(["* CAPABILITY IMAP4rev1 AUTH=PLAIN literal+"])).has("LITERAL+"));
  const tagged = parseResponse(["A2 OK [CAPABILITY IMAP4rev1 UIDPLUS] Logged in"]);
  assert.deepEqual([...parseCapabilities(tagged)], ["IMAP4REV1", "UIDPLUS"]);
});

test("a tagged response that is not OK/NO/BAD is refused", () => {
  throwsCode(() => parseResponse(["A1 FETCH (UID 1)"]), "protocol_error");
});

test("EXAMINE: UIDVALIDITY, UIDNEXT, EXISTS, READ-ONLY", () => {
  const untagged = [
    "* FLAGS (\\Answered \\Seen)",
    "* 172 EXISTS",
    "* 0 RECENT",
    "* OK [UIDVALIDITY 3857529045] UIDs valid",
    "* OK [UIDNEXT 4392] Predicted next UID",
  ].map((l) => parseResponse([l]));
  const info = parseSelect(untagged, parseResponse(["A4 OK [READ-ONLY] EXAMINE completed"]));
  assert.deepEqual(info, { uidValidity: 3857529045, uidNext: 4392, exists: 172, readOnly: true });
});

test("PLANTED: EXAMINE without UIDVALIDITY is refused rather than cached", () => {
  throwsCode(() => parseSelect([parseResponse(["* 3 EXISTS"])], parseResponse(["A1 OK done"])), "protocol_error");
});

test("SEARCH: UIDs, empty, split across responses, trailing MODSEQ ignored", () => {
  assert.deepEqual(parseSearch([parseResponse(["* SEARCH 4101 4102 4103"])]), [4101, 4102, 4103]);
  assert.deepEqual(parseSearch([parseResponse(["* SEARCH"])]), []);
  assert.deepEqual(parseSearch([parseResponse(["* SEARCH 1 2"]), parseResponse(["* SEARCH 3"])]), [1, 2, 3]);
  assert.deepEqual(parseSearch([parseResponse(["* SEARCH 7 9 (MODSEQ 917162500)"])]), [7, 9]);
  // Not a UID: zero, and above 2^32-1.
  assert.deepEqual(parseSearch([parseResponse(["* SEARCH 0 4294967296 5"])]), [5]);
});

// ---------------------------------------------------------------------------
// FETCH and the planted literal.
// ---------------------------------------------------------------------------

const TRAP_HEADERS =
  'From: "Pat Rivera (Homeowner)" <pat@example.com>\r\n' +
  "Subject: Re: Gate options (A) or {5}\r\n" +
  "X-Note: ) ) ((\r\n" +
  "\r\n";

test("PLANTED: a header literal containing ')' and ending a line with '{5}' parses exactly", async () => {
  const stream = wire(
    '* 2 FETCH (UID 4102 FLAGS (\\Seen $Forwarded) INTERNALDATE "16-Sep-2026 17:03:15 -0400" RFC822.SIZE 2210 BODY[HEADER.FIELDS (FROM SUBJECT)] ',
    { lit: TRAP_HEADERS },
    ")\r\n",
    "A6 OK FETCH completed\r\n",
  );
  const t = transportOver(stream, 3);
  const [fetch, done] = await readAll(t, 2);
  const msg = parseFetch(fetch);
  assert.equal(msg.seq, 2);
  assert.equal(msg.uid, 4102);
  assert.deepEqual(msg.flags, ["\\Seen", "$Forwarded"]);
  assert.equal(msg.internalDate, "2026-09-16T21:03:15.000Z");
  assert.equal(msg.size, 2210);
  assert.equal(dec.decode(msg.headers), TRAP_HEADERS);
  // Framing stayed in step: the very next response is the tagged OK.
  assert.equal(done.kind, "tagged");
  assert.equal(done.tag, "A6");
});

test("teeth: the same stream with the literal count one short fails loudly", async () => {
  const good = wire("* 2 FETCH (UID 4102 BODY[HEADER] ", { lit: TRAP_HEADERS }, ")\r\n");
  const n = enc.encode(TRAP_HEADERS).length;
  const shortBy1 = good.replace(`{${n}}`, `{${n - 1}}`);
  const t = transportOver(shortBy1, 3);
  await assert.rejects(
    (async () => parseResponse(await readRawResponse(t)))(),
    (e) => e instanceof MailError && e.code === "protocol_error",
  );
});

test("PLANTED: a status line ending in {N} is text, not a literal that swallows the next response", async () => {
  const t = transportOver("A1 NO Refused {5}\r\n* 3 EXISTS\r\n+ go on {2}\r\n* BYE bye {1}\r\n", 3);
  const [no, exists, cont, bye] = await readAll(t, 4);
  assert.equal(no.type, "NO");
  assert.equal(no.text, "Refused {5}");
  assert.equal(exists.type, "EXISTS");
  assert.equal(exists.num, 3);
  assert.equal(cont.kind, "continuation");
  assert.equal(bye.type, "BYE");
});

test("FETCH: NIL body is empty, BODY[]<0> counts as the source, unknown items ignored", () => {
  const r = parseResponse(["* 9 FETCH (UID 70 MODSEQ (12345) BODY[]<0> NIL X-GM-LABELS (\\Inbox))"]);
  const m = parseFetch(r);
  assert.equal(m.uid, 70);
  assert.equal(m.source.length, 0);
  assert.equal(m.headers, null);
});

test("FETCH answered with a quoted string instead of a literal still yields bytes", () => {
  // A quoted string cannot hold CRLF, and a backslash only escapes the next
  // character, so "\r" arrives as "r". Servers use literals for real headers.
  const m = parseFetch(parseResponse(['* 1 FETCH (UID 5 BODY[HEADER.FIELDS (SUBJECT)] "Subject: \\"hi\\"")']));
  assert.equal(dec.decode(m.headers), 'Subject: "hi"');
});

// ---------------------------------------------------------------------------
// LIST and the Sent folder.
// ---------------------------------------------------------------------------

test("LIST: quoted, atom, literal and NIL-delimiter forms", async () => {
  const stream = wire(
    '* LIST (\\HasNoChildren \\Sent) "/" "Sent"\r\n',
    "* LIST (\\HasNoChildren) NIL INBOX\r\n",
    '* LIST (\\HasNoChildren) "/" ',
    { lit: 'Jobs "Riverview"' },
    "\r\n",
  );
  const t = transportOver(stream, 3);
  const entries = (await readAll(t, 3)).map(parseListEntry);
  assert.deepEqual(entries[0], { flags: ["\\HasNoChildren", "\\Sent"], delimiter: "/", path: "Sent" });
  assert.deepEqual(entries[1], { flags: ["\\HasNoChildren"], delimiter: null, path: "INBOX" });
  assert.equal(entries[2].path, 'Jobs "Riverview"');
});

const entry = (path, ...flags) => ({ flags, delimiter: "/", path });

test("findSentFolder: \\Sent wins over a folder merely named like one", () => {
  const found = findSentFolder([entry("Sent Items"), entry("Sent"), entry("Envoyés", "\\HasNoChildren", "\\Sent")]);
  assert.equal(found.path, "Envoyés");
});

test("findSentFolder: falls back to the usual names in order, never a \\Noselect folder", () => {
  assert.equal(findSentFolder([entry("INBOX"), entry("Sent Mail"), entry("Sent Items")]).path, "Sent Items");
  assert.equal(findSentFolder([entry("INBOX"), entry("inbox.sent")]).path, "inbox.sent");
  assert.equal(findSentFolder([entry("Sent", "\\Noselect"), entry("[Gmail]/Sent Mail")]).path, "[Gmail]/Sent Mail");
  assert.equal(findSentFolder([entry("Old", "\\Sent", "\\NonExistent"), entry("INBOX")]), null);
});

// ---------------------------------------------------------------------------
// UIDs.
// ---------------------------------------------------------------------------

test("PLANTED: filterNewUids([100], last=100) is [] -- the '*' trap", () => {
  assert.deepEqual(filterNewUids([100], 100), []);
  assert.deepEqual(filterNewUids([87], 87), []);
});

test("filterNewUids: strictly above, unique, ascending", () => {
  assert.deepEqual(filterNewUids([102, 99, 101, 101, 100], 100), [101, 102]);
  assert.deepEqual(filterNewUids([], 0), []);
});

test("newestUids / oldestUids", () => {
  assert.deepEqual(newestUids([5, 1, 3, 2, 4, 4], 2), [4, 5]);
  assert.deepEqual(oldestUids([5, 1, 3, 2, 4], 2), [1, 2]);
  assert.deepEqual(newestUids([1, 2], 0), []);
});

test("compressUidSet: ranges, singles, and refusal of junk", () => {
  assert.equal(compressUidSet([4103, 4101, 4102, 4107, 4109, 4110]), "4101:4103,4107,4109:4110");
  assert.equal(compressUidSet([7]), "7");
  throwsCode(() => compressUidSet([]), "bad_request");
  throwsCode(() => compressUidSet([0]), "bad_request");
  throwsCode(() => compressUidSet([1.5]), "bad_request");
  throwsCode(() => compressUidSet([4294967296]), "bad_request");
});

// ---------------------------------------------------------------------------
// Dates and argument encoding.
// ---------------------------------------------------------------------------

test("imapDate and parseInternalDate", () => {
  assert.equal(imapDate(new Date("2026-08-22T12:00:00Z")), "22-Aug-2026");
  assert.equal(imapDate(new Date("2026-09-01T00:00:00Z")), "1-Sep-2026");
  assert.equal(parseInternalDate("14-Sep-2026 09:12:44 -0400"), "2026-09-14T13:12:44.000Z");
  assert.equal(parseInternalDate(" 9-Sep-2026 08:00:04 +0000"), "2026-09-09T08:00:04.000Z");
  assert.equal(parseInternalDate("31-Dec-2026 23:30:00 -0100"), "2027-01-01T00:30:00.000Z");
  assert.equal(parseInternalDate("yesterday"), null);
  assert.equal(parseInternalDate("14-Foo-2026 09:12:44 -0400"), null);
});

test("encodeAstring: quoted for plain text (escaped), literal for anything 8-bit", () => {
  assert.equal(encodeAstring('pa"ss\\word'), '"pa\\"ss\\\\word"');
  const lit = encodeAstring("pässwörd");
  assert.ok(lit.literal instanceof Uint8Array);
  assert.equal(dec.decode(lit.literal), "pässwörd");
});

test("PLANTED: CR, LF and NUL can never reach the command stream", () => {
  for (const bad of ["a\r\nA2 DELETE INBOX", "a\nb", "a\0b"]) {
    throwsCode(() => encodeAstring(bad), "bad_request");
    throwsCode(() => quoteString(bad), "bad_request");
  }
  throwsCode(() => quoteString("ümlaut"), "bad_request");
});
