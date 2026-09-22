// Mail coming in: what message-meta.ts makes of it for mail_ingest (rows)
// and for mail-message (bodies and parts).
//
// Run with:  node --test tests/mail-meta.test.mjs
//
// Two sources, both run the way production runs them:
//   - the FETCH responses in tests/fixtures/mail/zoho-session.imap.txt,
//     read by the real StreamTransport and imap-proto parser into the same
//     FetchedMessage objects syncFolder() returns, then handed to toRow();
//   - three hand-written .eml fixtures in tests/fixtures/mail/ (documented
//     in their own X-Fixture-Note headers): a customer's reply, the
//     company's sent quote with attachments, and a hostile HTML-only
//     message. Their header blocks are cut down to exactly the fields
//     mail-sync asks the server for (imap-proto HEADER_FIELDS).
// The fixture files are stored with LF line ends; mail arrives with CRLF,
// so every fixture is converted before use.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  bodyFields,
  capUtf8,
  counterpartEmails,
  flagsToColumns,
  headerFields,
  inlineImages,
  isoDate,
  mailboxes,
  MESSAGE_PARTS_MAX,
  normalizeSubject,
  parentIdsOf,
  parseAddressList,
  parseMail,
  snippetOf,
  storageContentType,
  storageObjectName,
  toRow,
} from "../supabase/functions/_shared/mail/message-meta.ts";
import { buildMime } from "../supabase/functions/_shared/mail/mime-build.ts";
import { replyThreading, restoreReferenceOrder } from "../supabase/functions/_shared/mail/reply.ts";
import { HEADER_FIELDS, parseFetch, parseResponse, readRawResponse } from "../supabase/functions/_shared/mail/imap-proto.ts";
import { StreamTransport } from "../supabase/functions/_shared/mail/tls-transport.ts";
import { MailError } from "../supabase/functions/_shared/mail/errors.ts";
import { PARENT_IDS_MAX, STORED_HTML_MAX_BYTES, STORED_TEXT_MAX_BYTES } from "../supabase/functions/_shared/mail/limits.ts";

const OWN = { addresses: ["owner@acmefence.com"], domains: ["reply.fenceflowapp.com"] };
const NOW = new Date("2026-09-21T12:00:00Z");
const enc = (s) => new TextEncoder().encode(s);

function fixture(name) {
  return readFileSync(new URL(`./fixtures/mail/${name}`, import.meta.url), "utf8").replace(/\r?\n/g, "\r\n");
}

/** What BODY.PEEK[HEADER.FIELDS (...)] returns for this message: the listed
 *  fields with their original folding, then a blank line. */
function headerBlock(eml) {
  const head = eml.slice(0, eml.indexOf("\r\n\r\n"));
  const fields = [];
  for (const line of head.split("\r\n")) {
    if (/^[ \t]/.test(line) && fields.length) fields[fields.length - 1].push(line);
    else fields.push([line]);
  }
  const wanted = new Set(HEADER_FIELDS);
  const kept = fields.filter((f) => wanted.has(f[0].slice(0, f[0].indexOf(":")).toUpperCase()));
  return enc(`${kept.map((f) => f.join("\r\n")).join("\r\n")}\r\n\r\n`);
}

/** The FETCH responses of the Zoho fixture, replayed byte for byte (the
 *  fake server's framing: {LITERAL} becomes {N} and the L: lines follow)
 *  through StreamTransport and readRawResponse/parseFetch. */
async function zohoFetches() {
  const lines = readFileSync(new URL("./fixtures/mail/zoho-session.imap.txt", import.meta.url), "utf8").split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^S: (\* \d+ FETCH .*)\{LITERAL\}$/.exec(lines[i]);
    if (!m) continue;
    const lits = [];
    let j = i + 1;
    while (lines[j].startsWith("L:")) lits.push(lines[j++].replace(/^L: ?/, ""));
    const body = Buffer.from(lits.map((l) => `${l}\r\n`).join(""), "utf8");
    const bytes = Buffer.concat([Buffer.from(`${m[1]}{${body.length}}\r\n`), body, Buffer.from(`${lines[j].replace(/^S: /, "")}\r\n`)]);
    let served = false;
    const conn = {
      read: async (p) => {
        if (served) return null;
        served = true;
        p.set(bytes);
        return bytes.length;
      },
      write: async (p) => p.length,
      close() {},
    };
    out.push(parseFetch(parseResponse(await readRawResponse(new StreamTransport(conn)))));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rows for mail_ingest.
// ---------------------------------------------------------------------------

test("the Zoho session's three header blocks become the rows mail_ingest expects", async () => {
  const fetched = await zohoFetches();
  assert.deepEqual(fetched.map((f) => f.uid), [4101, 4102, 4103]);
  const rows = [];
  for (const f of fetched) rows.push(toRow(await parseMail(f.headers), f, { folderRole: "inbox", uidValidity: 1729000001, own: OWN, now: NOW }));

  assert.deepEqual(rows.map((r) => r.subject), ["Fence quote for 14 Oak Lane", "Re: Gate options (A) or {5}", "Deposit received - thank you"]);
  assert.deepEqual(rows.map((r) => r.from_address), ["pat.rivera@example.com", "pat.rivera@example.com", "receipts@payments.example.com"]);
  assert.equal(rows[0].from_name, "Pat Rivera (Homeowner)");
  assert.deepEqual(rows.map((r) => [r.is_seen, r.is_flagged]), [[true, false], [false, false], [false, true]]);
  assert.deepEqual(rows.map((r) => r.received_at), ["2026-09-14T13:12:44.000Z", "2026-09-16T21:03:15.000Z", "2026-09-09T08:00:04.000Z"]);
  assert.deepEqual(rows.map((r) => r.sent_at), ["2026-09-14T13:12:40.000Z", "2026-09-16T21:03:11.000Z", "2026-09-09T08:00:02.000Z"]);
  assert.deepEqual(rows.map((r) => r.size_bytes), [4821, 2210, 9730]);
  // The reply names what it answered first, then the rest of the chain.
  assert.deepEqual(rows[1].parent_ids, ["a7f3c1d2-5b6e-4f80-9a1b-2c3d4e5f6a7b@acmefence.com", "b1c2d3e4-0000-4000-8000-000000000001@acmefence.com"]);
  assert.equal(rows[1].message_id_header, "CAF9z8y7x6w5@mail.example.com");
  assert.deepEqual(rows[1].counterpart_emails, ["pat.rivera@example.com", "board@oaklane-hoa.example.org"]);
  assert.deepEqual(rows[2].counterpart_emails, ["receipts@payments.example.com", "support@payments.example.com"]);
  for (const r of rows) {
    assert.equal(r.source, "imap");
    assert.equal(r.uidvalidity, 1729000001);
    assert.equal(r.body_state, "none");
    assert.equal(r.snippet, "");
    assert.equal(r.has_attachments, false, "none of these is multipart/mixed");
    assert.ok(!r.counterpart_emails.includes("owner@acmefence.com"));
  }
});

test("a customer's reply: folded encoded words, a quoted comma, junk dropped, headers-only equals the whole message", async () => {
  const eml = fixture("customer-reply.eml");
  const fromHeaders = await parseMail(headerBlock(eml));
  const row = toRow(fromHeaders, { uid: 77, flags: ["\\Answered"], internalDate: null, size: 1640 }, { folderRole: "inbox", uidValidity: 9, own: OWN, now: NOW });
  assert.equal(row.subject, "Re: Quote for 14 Oak Lane \u{2013} cl\u{f4}ture en c\u{e8}dre");
  assert.equal(row.from_address, "dana.whitfield@example.org");
  assert.equal(row.from_name, "Dana Whitfield");
  assert.deepEqual(row.to_list, [{ name: "Acme Fence", address: "OWNER@acmefence.com" }]);
  // "Bad <not an address>" is dropped; the name with a comma survives whole.
  assert.deepEqual(row.cc_list, [
    { name: "Whitfield, Sam", address: "sam@example.org" },
    { name: "", address: "hoa-board@oaklane-hoa.example" },
  ]);
  assert.deepEqual(row.reply_to_list, [{ name: "Dana Whitfield", address: "dana.whitfield@example.org" }]);
  assert.equal(row.to_text, "Acme Fence <OWNER@acmefence.com>, Whitfield, Sam <sam@example.org>, hoa-board@oaklane-hoa.example");
  assert.deepEqual(row.parent_ids, [
    "0f8e3a1c-2b4d-4e6f-8a9b-1c2d3e4f5a6b@acmefence.com",
    "root-quote-1@acmefence.com",
    "CAF7k2+first-answer@mail.example.org",
  ]);
  assert.equal(row.sent_at, "2026-09-14T13:12:44.000Z");
  assert.equal(row.received_at, row.sent_at, "no INTERNALDATE: the Date header is next best");
  assert.deepEqual([row.is_seen, row.is_answered, row.is_flagged], [false, true, false]);
  // Sync reads only the listed fields; the answer must not depend on that.
  assert.deepEqual(headerFields(fromHeaders, OWN), headerFields(await parseMail(enc(eml)), OWN));
});

test("PLANTED: the company's own address in To never appears in counterpart_emails", async () => {
  const email = await parseMail(headerBlock(fixture("customer-reply.eml")));
  // To is "OWNER@acmefence.com" -- upper case -- and still excluded.
  assert.ok(!headerFields(email, OWN).counterpart_emails.some((a) => a.includes("owner@")));
  // Teeth: with no own mailboxes the same message does list it, so the
  // exclusion above is what removed it.
  assert.ok(headerFields(email, { addresses: [] }).counterpart_emails.includes("owner@acmefence.com"));
  // Whole domains too: FenceFlow's reply addresses are never a customer.
  const routed = [{ name: "", address: "a1b2c3d4e5f6.0a0b0c0d0e0f@Reply.FenceFlowApp.com" }, { name: "", address: "dana@example.org" }];
  assert.deepEqual(counterpartEmails([routed], OWN), ["dana@example.org"]);
});

test("the company's sent quote: counterparts are the customer only, Sent is always seen, multipart/mixed hints a paperclip", async () => {
  const eml = fixture("sent-quote-attachments.eml");
  const row = toRow(await parseMail(headerBlock(eml)), { uid: 88, flags: null, internalDate: null, size: null }, {
    folderRole: "sent",
    uidValidity: 1729000002,
    own: OWN,
    now: NOW,
  });
  assert.equal(row.folder_role, "sent");
  assert.equal(row.from_address, "owner@acmefence.com");
  assert.deepEqual(row.counterpart_emails, ["dana.whitfield@example.org"], "Cc to the company's own mailbox is not a counterpart");
  assert.equal(row.is_seen, true);
  assert.equal(row.has_attachments, true);
  assert.equal(row.message_id_header, "0f8e3a1c-2b4d-4e6f-8a9b-1c2d3e4f5a6b@acmefence.com");
  assert.equal(row.subject, "Quote for 14 Oak Lane \u{2013} cl\u{f4}ture");
});

test("a hostile sender: Latin-1 prefixes, a right-to-left override, no real date, no recipients", async () => {
  const email = await parseMail(enc(fixture("hostile-html-only.eml")));
  const row = toRow(email, { uid: 5, flags: [], internalDate: "2026-09-20T10:00:00.000Z", size: 692 }, { folderRole: "inbox", uidValidity: 9, own: OWN, now: NOW });
  assert.equal(row.subject, "RE: FW: TR: RV: AW: R\u{e9}union chantier");
  assert.equal(normalizeSubject(row.subject), "R\u{e9}union chantier");
  assert.equal(row.from_name, "Acme Billing gpj.exe", "the override that reversed the text is gone");
  assert.ok(!/[\u{202a}-\u{202e}]/u.test(row.from_name));
  assert.equal(row.sent_at, null, "'sometime last week' is not a date");
  assert.equal(row.received_at, "2026-09-20T10:00:00.000Z");
  assert.equal(row.message_id_header, "bare-id-77@spam.example");
  assert.deepEqual([row.to_list, row.to_text, row.parent_ids], [[], "", []]);
  const noDates = toRow(email, { uid: 6, flags: null, internalDate: null, size: null }, { folderRole: "inbox", uidValidity: 9, own: OWN, now: NOW });
  assert.equal(noDates.received_at, NOW.toISOString());
});

test("toRow refuses a message without a usable UID or UIDVALIDITY", async () => {
  const email = await parseMail(enc("Subject: x\r\n\r\n"));
  const ctx = { folderRole: "inbox", uidValidity: 9, own: OWN, now: NOW };
  for (const uid of [null, 0, -1, 1.5, 4294967296, "7"]) {
    assert.throws(() => toRow(email, { uid, flags: null, internalDate: null, size: null }, ctx), (e) => e instanceof MailError && e.code === "protocol_error");
  }
  assert.throws(() => toRow(email, { uid: 1, flags: null, internalDate: null, size: null }, { ...ctx, uidValidity: null }), MailError);
});

// ---------------------------------------------------------------------------
// Threading.
// ---------------------------------------------------------------------------

test("parent_ids: direct parent first, root kept, duplicates and its own id gone, capped at 50", () => {
  const refs = Array.from({ length: 80 }, (_, i) => `<r${i}@example.org>`);
  const ids = parentIdsOf("<r79@example.org> (comment)", `${refs.join(" ")} ${refs.slice(0, 10).join(" ")} <self@example.org>`, "self@example.org");
  assert.equal(ids.length, PARENT_IDS_MAX);
  assert.equal(ids[0], "r79@example.org", "the message it answered");
  assert.equal(ids[1], "r0@example.org", "the conversation's root");
  assert.equal(ids.at(-1), "r78@example.org", "the most recent ancestor");
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!ids.includes("self@example.org"));
  // No In-Reply-To: the last reference is the parent.
  assert.deepEqual(parentIdsOf(null, "<a@x.example> <b@x.example>", null), ["b@x.example", "a@x.example"]);
  // Mailers that drop the brackets are still read.
  assert.deepEqual(parentIdsOf("p@x.example", "", null), ["p@x.example"]);
  assert.deepEqual(parentIdsOf("", "", null), []);
});

test("reply.ts reads parent_ids back into References order", () => {
  const chain = ["root@x.example", "a@x.example", "b@x.example", "parent@x.example"];
  const stored = parentIdsOf("<parent@x.example>", chain.map((c) => `<${c}>`).join(" "), "me@x.example");
  assert.deepEqual(restoreReferenceOrder(stored), chain);
});

test("a reply FenceFlow sends threads onto the message it answers", async () => {
  // The customer's reply, as stored...
  const customer = headerFields(await parseMail(headerBlock(fixture("customer-reply.eml"))), OWN);
  // ...answered through mail-send: threading from the row, then buildMime...
  const t = replyThreading(customer);
  const built = buildMime({
    from: { name: "Acme Fence", address: "owner@acmefence.com" },
    to: ["dana.whitfield@example.org"],
    subject: "Re: Quote",
    text: "Monday the 28th works.",
    messageId: "11111111-2222-4333-8444-555555555555@acmefence.com",
    inReplyTo: t.inReplyTo,
    references: t.references,
    date: NOW,
  });
  // ...and read back when the Sent copy syncs. mail_ingest threads a message
  // whose parent_ids contain a stored Message-ID onto that message's thread.
  const sent = headerFields(await parseMail(built.bytes), OWN);
  assert.equal(sent.parent_ids[0], customer.message_id_header);
  assert.ok(sent.parent_ids.includes("root-quote-1@acmefence.com"), "the root still groups the conversation");
  assert.equal(sent.message_id_header, "11111111-2222-4333-8444-555555555555@acmefence.com");
});

test("normalizeSubject strips reply and forward prefixes and counters, and nothing else", () => {
  const cases = [
    ["Re: RE[2]: Fwd: Quote", "Quote"],
    ["FW: fw: Fwd:Quote", "Quote"],
    ["TR: RV: AW: R\u{e9}union", "R\u{e9}union"],
    ["Re(3): Gate", "Gate"],
    ["Re\u{ff1a} Gate", "Gate"],
    ["Re: Re: ", ""],
    ["Regarding: the fence", "Regarding: the fence"],
    ["Fwd fence posts", "Fwd fence posts"],
    ["Reunion: Re: x", "Reunion: Re: x"],
    ["  Re:\tQuote\r\nBcc: x", "Quote Bcc: x"],
  ];
  for (const [input, want] of cases) assert.equal(normalizeSubject(input), want, input);
});

// ---------------------------------------------------------------------------
// Bodies and parts, for mail-message.
// ---------------------------------------------------------------------------

test("the sent quote opened: text, HTML, parts, and which part is shown inline", async () => {
  const { fields, parts } = bodyFields(await parseMail(enc(fixture("sent-quote-attachments.eml"))));
  assert.deepEqual(fields.attachments, [
    { idx: 0, filename: "logo.png", content_type: "image/png", size: 70, content_id: "logo@acmefence.com", disposition: "inline" },
    { idx: 1, filename: "Devis cl\u{f4}ture.pdf", content_type: "application/pdf", size: 82, content_id: null, disposition: "attachment" },
    { idx: 2, filename: "_.._invoice.html", content_type: "text/html", size: 66, content_id: null, disposition: "attachment" },
    // Labelled inline, but an SVG is never shown inline -- so it is listed
    // as an attachment rather than being neither shown nor downloadable.
    { idx: 3, filename: "diagram.svg", content_type: "image/svg+xml", size: 92, content_id: "diagram@acmefence.com", disposition: "attachment" },
  ]);
  assert.equal(fields.has_attachments, true);
  assert.ok(fields.body_text.includes("\n.This line starts with a dot.\nFrom here the price holds"));
  assert.ok(fields.body_html.includes('src="cid:logo@acmefence.com"'));
  assert.equal(fields.body_truncated, false);
  assert.ok(fields.snippet.startsWith("Hi Dana, The quote is attached."));
  assert.deepEqual(Object.keys(inlineImages(parts)), ["logo@acmefence.com"]);
  assert.match(inlineImages(parts)["logo@acmefence.com"], /^data:image\/png;base64,iVBORw0KGgo/);
  // Stored as passive types only; keys are plain ASCII.
  assert.deepEqual(parts.map((p) => storageContentType(p.meta.content_type)), ["image/png", "application/pdf", "application/octet-stream", "application/octet-stream"]);
  assert.deepEqual(parts.map((p) => storageObjectName(p.meta)), ["0-logo.png", "1-Devis_cloture.pdf", "2-invoice.html", "3-diagram.svg"]);
  assert.deepEqual([...parts[1].content.slice(0, 5)], [37, 80, 68, 70, 45], "the PDF bytes came through");
});

test("HTML-only mail: plain text and preview come from the HTML, never its script or style", async () => {
  const email = await parseMail(enc(fixture("hostile-html-only.eml")));
  const { fields } = bodyFields(email);
  assert.equal(fields.body_text, "Your invoice is overdue.\n");
  assert.equal(fields.snippet, "Your invoice is overdue.");
  for (const bad of ["steal", "background", "tracker", "never closed"]) {
    assert.ok(!fields.body_text.includes(bad) && !fields.snippet.includes(bad), bad);
  }
  // The HTML is stored as sent. It is only ever shown after the office
  // sanitizes it, inside a sandboxed frame without scripts.
  assert.equal(fields.body_html, email.html);
});

test("PLANTED: hostile HTML parses in linear time (the vendored htmlToText patch)", async () => {
  // A text/plain part beside a text/html part: postal-mime runs htmlToText
  // on the HTML itself. Unpatched, each of these took seconds (quadratic in
  // the number of unclosed constructs); patched, milliseconds.
  const hostile = {
    "unclosed <script>": "<script>".repeat(16000),
    "unclosed comments": "<!--".repeat(12000),
    "bare '<'": "<".repeat(40000),
    "CR before </body>": "</body>\r".repeat(12000),
  };
  for (const [name, html] of Object.entries(hostile)) {
    const msg = `Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhello\r\n--b\r\nContent-Type: text/html\r\n\r\n${html}\r\n--b--\r\n`;
    const t = performance.now();
    const { fields } = bodyFields(await parseMail(enc(msg)));
    const ms = performance.now() - t;
    assert.ok(ms < 1000, `${name}: ${Math.round(ms)} ms`);
    assert.ok(fields.body_text.startsWith("hello"));
  }
});

test("bodies over the stored caps are cut between characters and flagged", async () => {
  const big = "\u{e9}".repeat(STORED_TEXT_MAX_BYTES); // two bytes each: twice the cap
  const { fields } = bodyFields(await parseMail(enc(`Content-Type: text/plain; charset=utf-8\r\n\r\n${big}`)));
  assert.equal(fields.body_truncated, true);
  assert.ok(Buffer.byteLength(fields.body_text, "utf8") <= STORED_TEXT_MAX_BYTES);
  assert.ok(!fields.body_text.includes("\u{fffd}"), "a character was cut in half");
  const cut = capUtf8("a\u{1f3e1}b", 3);
  assert.deepEqual(cut, { text: "a", truncated: true });
  const html = bodyFields(await parseMail(enc(`Content-Type: text/html\r\n\r\n${"<p>x</p>".repeat(STORED_HTML_MAX_BYTES / 8 + 10)}`))).fields;
  assert.equal(html.body_truncated, true);
  assert.ok(Buffer.byteLength(html.body_html, "utf8") <= STORED_HTML_MAX_BYTES);
});

test("snippets skip quoted history and the line introducing it", () => {
  assert.equal(snippetOf("Sounds good.\n\nOn Mon, Dana <d@x.example> wrote:\n> the quote\n> more"), "Sounds good.");
  assert.equal(snippetOf("D'accord.\nLe lun. 14 sept., Dana a \u{e9}crit :\n> le devis"), "D'accord.");
  assert.equal(snippetOf("> only quoted text"), "> only quoted text", "nothing else left: keep it");
  assert.equal(snippetOf("I wrote: the gate is fine"), "I wrote: the gate is fine", "not followed by a quote");
  assert.ok(snippetOf("x ".repeat(500)).length <= 200);
});

test("no more than MESSAGE_PARTS_MAX parts are kept", async () => {
  const parts = Array.from({ length: MESSAGE_PARTS_MAX + 5 }, (_, i) =>
    `--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=f${i}.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAQID\r\n`).join("");
  const { fields } = bodyFields(await parseMail(enc(`Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n${parts}--b--\r\n`)));
  assert.equal(fields.attachments.length, MESSAGE_PARTS_MAX);
  assert.deepEqual(fields.attachments.map((a) => a.idx), Array.from({ length: MESSAGE_PARTS_MAX }, (_, i) => i));
});

test("inlineImages re-checks everything: no SVG, nothing oversized, nothing not marked inline", () => {
  const part = (cid, type, size, disposition = "inline") => ({
    meta: { idx: 0, filename: "x", content_type: type, size, content_id: cid, disposition },
    content: new Uint8Array(size),
  });
  const images = inlineImages([
    part("svg@x", "image/svg+xml", 10),
    part("big@x", "image/png", 512 * 1024 + 1),
    part("att@x", "image/png", 10, "attachment"),
    part("__proto__", "image/gif", 3),
    part("ok@x", "image/jpeg", 3),
  ]);
  assert.deepEqual(Object.keys(images).sort(), ["__proto__", "ok@x"]);
  assert.equal(Object.getPrototypeOf(images), null);
});

// ---------------------------------------------------------------------------
// Small pieces.
// ---------------------------------------------------------------------------

test("addresses: implausible ones dropped, groups opened, duplicates removed, names cleaned", () => {
  const list = parseAddressList([
    '"Smith, J" <J.Smith@Example.com>, Team: a@b.example, c@d.example;',
    "Bad <not an address>, <angle@f.example>, j.smith@example.com",
    '"q uoted"@x.example, j\u{fc}rgen@b\u{fc}cher.example, Evil \u{202e}name <e@x.example>',
  ]);
  assert.deepEqual(list, [
    { name: "Smith, J", address: "J.Smith@Example.com" },
    { name: "", address: "a@b.example" },
    { name: "", address: "c@d.example" },
    { name: "", address: "angle@f.example" },
    { name: "", address: "j\u{fc}rgen@b\u{fc}cher.example" },
    { name: "Evil name", address: "e@x.example" },
  ]);
  assert.deepEqual(mailboxes(undefined, 5), []);
  assert.equal(parseAddressList(Array(300).fill("x@y.example").map((a, i) => `${i}${a}`)).length, 100);
});

test("flagsToColumns: no FLAGS means leave the row alone; Sent is always seen", () => {
  assert.deepEqual(flagsToColumns(null, "inbox"), {});
  assert.deepEqual(flagsToColumns(null, "sent"), { is_seen: true });
  assert.deepEqual(flagsToColumns(["\\SEEN", "\\Flagged", "$Forwarded"], "inbox"), { is_seen: true, is_answered: false, is_flagged: true });
  assert.deepEqual(flagsToColumns([], "sent"), { is_seen: true, is_answered: false, is_flagged: false });
});

test("isoDate: real dates only, and none from before 1970 or after 2999", () => {
  assert.equal(isoDate("Mon, 14 Sep 2026 09:12:44 -0400"), "2026-09-14T13:12:44.000Z");
  assert.equal(isoDate(new Date("2026-01-01T00:00:00Z")), "2026-01-01T00:00:00.000Z");
  for (const bad of ["sometime last week", "", null, undefined, "Thu, 01 Jan 1900 00:00:00 +0000", "9999-01-01T00:00:00Z"]) assert.equal(isoDate(bad), null, String(bad));
});

test("storageContentType: only passive types keep their own type", () => {
  for (const risky of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/javascript", "text/javascript", "application/x-msdownload", "video/x-html", "nonsense", ""]) {
    assert.equal(storageContentType(risky), "application/octet-stream", risky);
  }
  for (const ok of ["image/png", "application/pdf", "text/plain", "video/mp4", "audio/mpeg"]) assert.equal(storageContentType(ok), ok);
});
