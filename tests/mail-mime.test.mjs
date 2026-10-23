// Outgoing mail: what mime-build.ts writes, checked byte by byte and then
// read back by the vendored postal-mime -- the same parser mail-message uses
// on mail coming in, so a round trip here is what a recipient's program
// sees. Plus the Resend request for FenceFlow mail and where its replies go.
//
// Run with:  node --test tests/mail-mime.test.mjs
//
// Pure: no network, no clock (every Date and Message-ID is passed in).
import test from "node:test";
import assert from "node:assert/strict";
import PostalMime from "../supabase/functions/_shared/vendor/postal-mime/postal-mime.js";
import {
  bareAddressOf,
  buildMime,
  buildResendEmail,
  cleanFilename,
  composeBody,
  encodeQuotedPrintable,
  encodeWords,
  fenceflowFooter,
  fenceflowFrom,
  normalizeAddress,
  referencesHeaderValue,
  safeContentType,
  textToHtml,
  validateSendFields,
} from "../supabase/functions/_shared/mail/mime-build.ts";
import { fenceflowReplyTo, newMessageId, replyThreading } from "../supabase/functions/_shared/mail/reply.ts";
import { MailError } from "../supabase/functions/_shared/mail/errors.ts";
import { MAX_RECIPIENTS_RESEND, MAX_RECIPIENTS_SMTP, REFERENCES_OUT_MAX } from "../supabase/functions/_shared/mail/limits.ts";

const DATE = new Date("2026-09-21T18:13:00Z");
const MID = "0f8e3a1c-2b4d-4e6f-8a9b-1c2d3e4f5a6b@acmefence.com";
const dec = (u8) => new TextDecoder().decode(u8);

function build(extra = {}) {
  return buildMime({
    from: { name: "Acme Fence", address: "owner@acmefence.com" },
    to: ["dana.whitfield@example.org"],
    subject: "Quote",
    text: "Hi",
    messageId: MID,
    date: DATE,
    ...extra,
  });
}

/** Header block of a built message, unfolded, as [name, value] pairs. */
function headersOf(bytes) {
  const s = dec(bytes);
  const block = s.slice(0, s.indexOf("\r\n\r\n"));
  return block.replace(/\r\n[ \t]/g, " ").split("\r\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]);
}

/** Every rule a line of an outgoing message must keep. */
function assertWireSafe(bytes) {
  const s = dec(bytes);
  assert.ok(!/[^\x00-\x7f]/.test(s), "only 7-bit ASCII");
  assert.ok(!/\r(?!\n)|(?<!\r)\n/.test(s), "CRLF only, never a bare CR or LF");
  for (const line of s.split("\r\n")) assert.ok(line.length <= 998, `line over 998: ${line.slice(0, 60)}...`);
  const head = s.slice(0, s.indexOf("\r\n\r\n")).split("\r\n");
  for (const line of head) assert.ok(line.length <= 78 || !line.slice(1).includes(" "), `unfolded header line: ${line}`);
}

async function rejects(fn) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  assert.fail("expected a rejection");
}

// ---------------------------------------------------------------------------
// Header injection and Bcc.
// ---------------------------------------------------------------------------

test("PLANTED: the subject 'Hi\\r\\nBcc: x@y' produces no Bcc header, just a one-line subject", async () => {
  const built = build({ subject: "Hi\r\nBcc: x@y.example" });
  const text = dec(built.bytes);
  assert.ok(!/^bcc:/im.test(text), "a Bcc header line was written");
  assert.equal(headersOf(built.bytes).filter(([k]) => k.toLowerCase() === "subject").length, 1);
  const parsed = await PostalMime.parse(built.bytes);
  assert.equal(parsed.subject, "Hi Bcc: x@y.example");
  assert.equal(parsed.bcc, undefined);
  assertWireSafe(built.bytes);
});

test("there is no Bcc input: a bcc key on the object is ignored, blind copies live in the envelope only", async () => {
  const built = build({ bcc: ["secret-copy@acmefence.com"] });
  assert.ok(!dec(built.bytes).includes("secret-copy"));
  // validateSendFields keeps bcc for smtp-client's envelope (and Resend's bcc field).
  const fields = validateSendFields(
    { to: ["a@example.org"], cc: ["b@example.org"], bcc: ["secret-copy@acmefence.com"], subject: "x", text: "y" },
    MAX_RECIPIENTS_SMTP,
  );
  assert.deepEqual(fields.bcc, ["secret-copy@acmefence.com"]);
});

test("a display name cannot break out of its header", async () => {
  const built = build({ from: { name: 'Evil"\r\nBcc: x@y.example <x@y.example>', address: "owner@acmefence.com" } });
  const froms = headersOf(built.bytes).filter(([k]) => k.toLowerCase() === "from");
  assert.equal(froms.length, 1);
  assert.ok(!/^bcc:/im.test(dec(built.bytes)));
  const parsed = await PostalMime.parse(built.bytes);
  assert.equal(parsed.from.address, "owner@acmefence.com");
  assert.equal(parsed.bcc, undefined);
  // All printable ASCII, so no encoded word hides it: a quote in the name
  // must not close the phrase and slip a second, spoofed sender in.
  const spoof = build({ from: { name: 'Mallory" <boss@acmefence.com>, "', address: "owner@acmefence.com" } });
  const p2 = await PostalMime.parse(spoof.bytes);
  assert.equal(p2.from.address, "owner@acmefence.com");
  assert.ok(!dec(spoof.bytes).includes("<boss@acmefence.com>"), "a second mailbox was written into From");
});

test("addresses are refused, never repaired: CR/LF, brackets, spaces, names and non-ASCII", () => {
  for (const bad of [
    "a@b.com\r\nBcc: x@y.com",
    "a@b.com>, x@y.com",
    "Bob <a@b.com>",
    "a b@c.com",
    "a@b",
    "@b.com",
    "a@-b.com",
    "jos\u{e9}@example.org",
    "a@b.com\u{0}",
    "",
    null,
  ]) {
    assert.throws(() => normalizeAddress(bad), (e) => e instanceof MailError && e.code === "bad_request", String(bad));
  }
  assert.equal(normalizeAddress("  Dana.Whitfield@Example.ORG "), "Dana.Whitfield@example.org");
  assert.throws(() => build({ to: ["dana@example.org\r\nRCPT TO:<x@y.com>"] }), MailError);
});

// ---------------------------------------------------------------------------
// Encoding.
// ---------------------------------------------------------------------------

test("RFC 2047: non-ASCII subjects and names become encoded words that come back exactly", async () => {
  const subject = "Devis cl\u{f4}ture \u{2013} 14 Oak Lane \u{1f3e1} with a tail long enough to need several encoded words";
  const built = build({ subject, from: { name: "Cl\u{f4}tures Acme", address: "owner@acmefence.com" } });
  const heads = headersOf(built.bytes);
  const subj = heads.find(([k]) => k === "Subject")[1];
  const words = subj.split(" ");
  assert.ok(words.length > 1, "long subject split into several words");
  for (const w of words) {
    assert.match(w, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    assert.ok(w.length <= 75, `encoded word over 75: ${w}`);
  }
  const parsed = await PostalMime.parse(built.bytes);
  assert.equal(parsed.subject, subject);
  assert.equal(parsed.from.name, "Cl\u{f4}tures Acme");
  assertWireSafe(built.bytes);
});

test("an ASCII subject containing '=?' is encoded, so the recipient never decodes words the sender did not write", async () => {
  const subject = "Price =?UTF-8?B?RlJFRQ==?= today";
  const built = build({ subject });
  assert.ok(!headersOf(built.bytes).find(([k]) => k === "Subject")[1].includes("RlJFRQ==?= today"));
  assert.equal((await PostalMime.parse(built.bytes)).subject, subject);
  // One encoded word never splits a character across two words.
  for (const w of encodeWords("\u{e9}".repeat(40))) {
    const b = Buffer.from(w.slice(10, -2), "base64");
    assert.ok(!b.toString("utf8").includes("\u{fffd}"), "a character was cut in half");
  }
});

test("base64 attachments are wrapped at exactly 76 columns and decode to the same bytes", async () => {
  const content = new Uint8Array(1000).map((_, i) => (i * 37 + 11) & 0xff);
  const built = build({ attachments: [{ filename: "photo.jpg", contentType: "image/jpeg", content }] });
  const s = dec(built.bytes);
  const start = s.indexOf("Content-Transfer-Encoding: base64\r\n\r\n") + "Content-Transfer-Encoding: base64\r\n\r\n".length;
  const lines = s.slice(start, s.indexOf("\r\n--", start)).split("\r\n");
  assert.ok(lines.length > 1);
  for (const l of lines.slice(0, -1)) assert.equal(l.length, 76);
  assert.ok(lines.at(-1).length <= 76);
  assert.deepEqual(new Uint8Array(Buffer.from(lines.join(""), "base64")), content);
  const parsed = await PostalMime.parse(built.bytes, { attachmentEncoding: "arraybuffer" });
  assert.deepEqual(new Uint8Array(parsed.attachments[0].content), content);
});

test("quoted-printable: soft breaks at 76, trailing spaces and 'From ' escaped, '=' always encoded", () => {
  const qp = encodeQuotedPrintable(`From the yard\nkeep  \n${"x".repeat(200)}\na=b`);
  const lines = qp.split("\r\n");
  for (const l of lines) assert.ok(l.length <= 76, `QP line over 76: ${l}`);
  assert.equal(lines[0], "=46rom the yard");
  assert.equal(lines[1], "keep =20");
  assert.equal(lines.at(-1), "a=3Db");
});

test("boundaries are random per message and never appear inside a part", async () => {
  const a = build({ attachments: [{ filename: "a.txt", contentType: "text/plain", content: new Uint8Array([97]) }] });
  const b = build({ attachments: [{ filename: "a.txt", contentType: "text/plain", content: new Uint8Array([97]) }] });
  const boundaryOf = (bytes) => /boundary="([^"]+)"/.exec(dec(bytes))[1];
  assert.notEqual(boundaryOf(a.bytes), boundaryOf(b.bytes));
  // Text that looks like a boundary is sent quoted-printable ("=" becomes
  // "=3D"), so it cannot close a part early.
  const tricky = "--=_FenceFlow_000000000000000000000000_a--\nstill the body";
  const built = build({ text: tricky });
  const parsed = await PostalMime.parse(built.bytes);
  assert.equal(parsed.text.replace(/\n+$/, ""), tricky);
  const mixed = boundaryOf(built.bytes);
  const delimiters = dec(built.bytes).split("\r\n").filter((l) => l.startsWith(`--${mixed}`));
  assert.deepEqual(delimiters, [`--${mixed}`, `--${mixed}`, `--${mixed}--`]);
});

// ---------------------------------------------------------------------------
// The round trip.
// ---------------------------------------------------------------------------

test("round trip through postal-mime: subject, addresses, threading, text, HTML and attachments all equal", async () => {
  const body = composeBody({
    text: "Hi Dana,\n\nHere is the quote: https://acmefence.com/q?id=7&v=2.\n.leading dot\nFrom the yard \u{2013} caf\u{e9}\n" +
      `${"long ".repeat(40)}\nindented    by spaces`,
    signature: "Mike Ruiz\nAcme Fence",
  });
  const pdf = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 0, 255, 128]);
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const mail = {
    from: { name: "Acme Fence", address: "owner@acmefence.com" },
    to: ["dana.whitfield@example.org", "Sam@Example.org"],
    cc: ["hoa-board@oaklane-hoa.example"],
    replyTo: "office@acmefence.com",
    subject: "Devis cl\u{f4}ture \u{2013} 14 Oak Lane",
    text: body.text,
    html: body.html,
    messageId: MID,
    inReplyTo: "<CAF7k2+Qx9L0wQ-4102@mail.example.org>",
    references: ["root-quote-1@acmefence.com", "CAF7k2+Qx9L0wQ-4102@mail.example.org"],
    date: DATE,
    attachments: [
      { filename: "Devis d\u{2019}\u{e9}t\u{e9} \u{2013} cl\u{f4}ture tr\u{e8}s longue pour le client.pdf", contentType: "application/pdf", content: pdf },
      { filename: "site.png", contentType: "image/png", content: png },
    ],
  };
  const built = buildMime(mail);
  assertWireSafe(built.bytes);
  assert.equal(built.messageId, MID);

  const p = await PostalMime.parse(built.bytes, { attachmentEncoding: "arraybuffer" });
  assert.equal(p.subject, mail.subject);
  assert.deepEqual(p.from, { address: "owner@acmefence.com", name: "Acme Fence" });
  assert.deepEqual(p.to.map((a) => a.address), ["dana.whitfield@example.org", "Sam@example.org"]);
  assert.deepEqual(p.cc.map((a) => a.address), ["hoa-board@oaklane-hoa.example"]);
  assert.deepEqual(p.replyTo.map((a) => a.address), ["office@acmefence.com"]);
  assert.equal(p.messageId, `<${MID}>`);
  assert.equal(p.inReplyTo, "<CAF7k2+Qx9L0wQ-4102@mail.example.org>");
  assert.equal(p.references, "<root-quote-1@acmefence.com> <CAF7k2+Qx9L0wQ-4102@mail.example.org>");
  assert.equal(p.date, DATE.toISOString());
  assert.equal(p.text.replace(/\n+$/, ""), body.text.replace(/\n+$/, ""));
  assert.equal(p.html.replace(/\n+$/, ""), body.html);
  assert.deepEqual(
    p.attachments.map((a) => [a.filename, a.mimeType, a.disposition, [...new Uint8Array(a.content)]]),
    mail.attachments.map((a) => [a.filename, a.contentType, "attachment", [...a.content]]),
  );
});

test("a reply carries In-Reply-To and References built from the parent row, capped at the root plus the latest", async () => {
  const chain = Array.from({ length: 30 }, (_, i) => `m${i}@example.org`);
  // parent_ids as message-meta stores them: direct parent first, then the rest oldest-first.
  const parent = { message_id_header: "m30@example.org", parent_ids: [chain.at(-1), ...chain.slice(0, -1)] };
  const t = replyThreading(parent);
  assert.equal(t.inReplyTo, "m30@example.org");
  assert.equal(t.references.length, REFERENCES_OUT_MAX);
  assert.equal(t.references[0], "m0@example.org", "the conversation's root is kept");
  assert.deepEqual(t.references.slice(-2), ["m29@example.org", "m30@example.org"]);
  const built = build({ inReplyTo: t.inReplyTo, references: t.references });
  const p = await PostalMime.parse(built.bytes);
  assert.equal(p.inReplyTo, "<m30@example.org>");
  assert.equal(p.references.split(" ").length, REFERENCES_OUT_MAX);
  assertWireSafe(built.bytes);
});

test("newMessageId: <uuid>@<sender's domain>, and nothing else", () => {
  assert.equal(newMessageId("owner@AcmeFence.com", "0F8E3A1C-2B4D-4E6F-8A9B-1C2D3E4F5A6B"), MID);
  assert.throws(() => newMessageId("owner@acmefence.com", "not-a-uuid"), MailError);
  assert.throws(() => newMessageId("owner@acmefence.com\r\nX: y", "0f8e3a1c-2b4d-4e6f-8a9b-1c2d3e4f5a6b"), MailError);
});

// ---------------------------------------------------------------------------
// Bodies, names, types, limits.
// ---------------------------------------------------------------------------

test("composeBody: everything typed is escaped in the HTML, links cannot break their attribute", () => {
  const { text, html } = composeBody({
    text: 'Price <b>$4,200</b> & see https://x.example/a?b="c"&d=<e>',
    signature: "<script>alert(1)</script>",
    footer: fenceflowFooter("Acme <Fence>"),
  });
  assert.ok(!html.includes("<b>") && !html.includes("<script>"));
  assert.ok(html.includes("&lt;b&gt;$4,200&lt;/b&gt; &amp;"));
  // The link ends at the quote, so nothing typed can reach inside the attribute.
  assert.ok(html.includes('<a href="https://x.example/a?b=">https://x.example/a?b=</a>&quot;c&quot;&amp;d=&lt;e&gt;'), html);
  assert.ok(text.includes("\n\n-- \n<script>alert(1)</script>"), "signature under the standard separator");
  assert.ok(text.trimEnd().endsWith("Sent by Acme Fence using FenceFlow"));
  assert.equal(textToHtml("a\nb").includes("a<br>\nb"), true);
});

test("file names: no path, no hidden characters, capped with the extension kept; types sanitised", () => {
  assert.ok(!cleanFilename("../../etc/passwd").includes("/"));
  assert.ok(!cleanFilename("..\\..\\boot.ini").includes("\\"));
  assert.equal(cleanFilename("invoice\u{202e}fdp.exe"), "invoicefdp.exe");
  assert.equal(cleanFilename(""), "attachment");
  const long = cleanFilename(`${"a".repeat(300)}.pdf`);
  assert.equal(Array.from(long).length, 100);
  assert.ok(long.endsWith(".pdf"));
  assert.equal(safeContentType("multipart/mixed"), "application/octet-stream");
  assert.equal(safeContentType("text/plain\r\nX-Evil: 1"), "application/octet-stream");
  assert.equal(safeContentType("Application/PDF"), "application/pdf");
});

test("validateSendFields: de-duplicated across lists, limits refused rather than cut", () => {
  const f = validateSendFields(
    { to: ["a@example.org", "A@EXAMPLE.org"], cc: ["a@example.org", "b@example.org"], bcc: ["b@example.org", "c@example.org"], subject: "  Hello\tthere ", text: "x\r\ny\0z" },
    MAX_RECIPIENTS_SMTP,
  );
  assert.deepEqual([f.to, f.cc, f.bcc], [["a@example.org"], ["b@example.org"], ["c@example.org"]]);
  assert.equal(f.subject, "Hello there");
  assert.equal(f.text, "x\nyz");
  const eleven = Array.from({ length: MAX_RECIPIENTS_RESEND + 1 }, (_, i) => `r${i}@example.org`);
  assert.throws(() => validateSendFields({ to: eleven, text: "" }, MAX_RECIPIENTS_RESEND), (e) => e.code === "bad_request");
  assert.throws(() => validateSendFields({ to: [], text: "" }, MAX_RECIPIENTS_SMTP), (e) => e.code === "bad_request");
  assert.throws(() => validateSendFields({ to: ["a@example.org"], subject: "s".repeat(301), text: "" }, 20), (e) => e.code === "bad_request");
  assert.throws(() => validateSendFields({ to: ["a@example.org"], text: "x".repeat(100 * 1024 + 1) }, 20), (e) => e.code === "too_large");
  assert.throws(() => validateSendFields({ to: ["a@example.org"], text: 42 }, 20), (e) => e.code === "bad_request");
});

test("attachments over the count or the 10 MB total are refused", () => {
  const one = { filename: "a.bin", contentType: "application/octet-stream", content: new Uint8Array(10) };
  assert.throws(() => build({ attachments: Array(6).fill(one) }), (e) => e.code === "bad_request");
  const big = { filename: "big.bin", contentType: "application/octet-stream", content: new Uint8Array(10 * 1024 * 1024 + 1) };
  assert.throws(() => build({ attachments: [big] }), (e) => e.code === "too_large");
});

// ---------------------------------------------------------------------------
// FenceFlow mail through Resend.
// ---------------------------------------------------------------------------

test("fenceflowFrom: the company's name on FenceFlow's own address, even when MAIL_FROM already has a name", () => {
  assert.deepEqual(fenceflowFrom("Acme Fence", "FenceFlow <noreply@send.fenceflowapp.com>"), {
    name: "Acme Fence",
    address: "noreply@send.fenceflowapp.com",
  });
  assert.deepEqual(fenceflowFrom('Evil"\r\nBcc: x', "noreply@send.fenceflowapp.com").name, "Evil Bcc: x");
  assert.equal(fenceflowFrom("", "noreply@send.fenceflowapp.com").name, "FenceFlow");
  assert.throws(() => fenceflowFrom("Acme", "not an address"), (e) => e.code === "not_configured");
  assert.equal(bareAddressOf("FenceFlow <noreply@send.fenceflowapp.com>"), "noreply@send.fenceflowapp.com");
});

test("buildResendEmail: validated, capped at 10 recipients, bcc as Resend's field, threading headers set", () => {
  const from = fenceflowFrom("Acme Fence", "FenceFlow <noreply@send.fenceflowapp.com>");
  const body = composeBody({ text: "Hi", footer: fenceflowFooter("Acme Fence") });
  const req = buildResendEmail({
    from,
    to: ["dana@example.org"],
    cc: ["sam@example.org"],
    bcc: ["copy@acmefence.com"],
    replyTo: "office@acmefence.com",
    subject: "Quote\r\nBcc: x@y.example",
    text: body.text,
    html: body.html,
    messageId: MID,
    inReplyTo: "p@example.org",
    references: ["r@example.org", "p@example.org"],
    attachments: [{ filename: "../quote.pdf", content: new Uint8Array([1, 2, 3]) }],
  });
  assert.equal(req.from, '"Acme Fence" <noreply@send.fenceflowapp.com>');
  assert.deepEqual(req.bcc, ["copy@acmefence.com"]);
  assert.equal(req.reply_to, "office@acmefence.com");
  assert.equal(req.subject, "Quote Bcc: x@y.example");
  assert.deepEqual(req.headers, { "Message-ID": `<${MID}>`, "In-Reply-To": "<p@example.org>", References: "<r@example.org> <p@example.org>" });
  assert.deepEqual(req.attachments, [{ filename: "_quote.pdf", content: "AQID" }]);
  const eleven = Array.from({ length: MAX_RECIPIENTS_RESEND + 1 }, (_, i) => `r${i}@example.org`);
  assert.throws(() => buildResendEmail({ ...req, from, to: eleven, text: "", html: "", messageId: MID }), (e) => e.code === "bad_request");
  // Resend is handed References as one string; it stays well under a line.
  const long = referencesHeaderValue(Array.from({ length: 60 }, (_, i) => `${"x".repeat(40)}${i}@example.org`));
  assert.ok(long.length <= 900 && long.startsWith(`<${"x".repeat(40)}0@example.org>`));
});

test("PLANTED: with receiving unproven and no business email, FenceFlow mail has nowhere honest for replies", () => {
  // Not ready + no company email: unavailable. Never MAIL_FROM, which would
  // put another company's customer in FenceFlow's own mailbox.
  assert.deepEqual(fenceflowReplyTo({ inboundReady: false, inboundDomain: "reply.fenceflowapp.com", inboundToken: "a1b2c3d4e5f6" }), {
    mode: "unavailable",
    replyTo: null,
  });
  assert.deepEqual(fenceflowReplyTo({ inboundReady: false, companyEmail: "Office@AcmeFence.com" }), {
    mode: "company_email",
    replyTo: "Office@acmefence.com",
  });
  // Only a proven inbound path switches replies into FenceFlow; "true-ish" is not true.
  assert.equal(fenceflowReplyTo({ inboundReady: "yes", inboundDomain: "reply.fenceflowapp.com", inboundToken: "a1b2c3d4e5f6", companyEmail: "o@acmefence.com" }).mode, "company_email");
  assert.deepEqual(
    fenceflowReplyTo({ inboundReady: true, inboundDomain: "reply.fenceflowapp.com", inboundToken: "a1b2c3d4e5f6", replyToken: "0a0b0c0d0e0f", companyEmail: "o@acmefence.com" }),
    { mode: "inbound", replyTo: "a1b2c3d4e5f6.0a0b0c0d0e0f@reply.fenceflowapp.com" },
  );
  assert.equal(fenceflowReplyTo({ inboundReady: false, companyEmail: "not an address" }).mode, "unavailable");
});

test("send-side errors are MailErrors with fixed codes, so the office can translate them", async () => {
  const err = await rejects(() => build({ messageId: "no-at-sign" }));
  assert.ok(err instanceof MailError);
  assert.equal(err.code, "bad_request");
});

// ====================================================== how a letter looks =====
//
// The email a customer opens is the one message that decides whether somebody
// buys a fence, and it read as software output: a small logo, the letter as
// <br>-joined lines on a bare white page, a grey footer. These pin the five
// things every branded contractor email shares -- a card, a header with the
// company's NAME as well as its logo, one button, a quiet footer, and nothing
// else -- and, just as hard, that the plain-text part did not move.

test("composeBody: the letter is a card with the company's name in the header", () => {
  const { html } = composeBody({
    text: "Hi Pat,\n\nHere is your quote.",
    logoUrl: "https://example.test/logo.png",
    logoAlt: "Acme Fence",
  });
  assert.match(html, /<img src="https:\/\/example\.test\/logo\.png"/);
  assert.ok(html.includes("Acme Fence"), "the company's name is not in the letter");
  assert.match(html, /max-width:600px/, "the card has no width, so it runs the full width of a desktop screen");
  assert.match(html, /name="viewport"/, "no viewport meta: a phone lays this out at desktop width and shrinks it to a stamp");
});

test("composeBody: the name is there even when the logo is not", () => {
  // Most mail clients block remote images by default, so on first open the
  // logo simply is not there. The name has to carry the header alone.
  const { html } = composeBody({ text: "Hi", logoAlt: "Acme Fence" });
  assert.ok(!html.includes("<img"), "an image appeared with no logo given");
  assert.ok(html.includes("Acme Fence"), "with no logo there is nothing identifying the sender at all");
});

test("composeBody: the one link line becomes a button, and the address is still shown", () => {
  const { html } = composeBody({ text: "Hi Pat,\n\nOpen it here: https://example.test/q/abc\n\nThanks." });
  assert.match(html, /<a href="https:\/\/example\.test\/q\/abc"[^>]*>Open it here<\/a>/,
    "the link line is not a button, or the button lost the words that were beside the link");
  // A button with no visible address is the shape a phishing mail has.
  assert.ok((html.match(/https:\/\/example\.test\/q\/abc/g) || []).length >= 2,
    "the address itself is no longer shown anywhere");
});

test("composeBody: only the FIRST link line is promoted, and never a quoted one", () => {
  const { html } = composeBody({
    text: "One: https://example.test/a\nTwo: https://example.test/b\n> Quoted: https://example.test/c",
  });
  const buttons = html.match(/padding:12px 26px/g) || [];
  assert.equal(buttons.length, 1, "an email turned into a row of buttons");
  assert.ok(!html.includes(">Quoted<"), "a quoted line in a reply was turned into a button");
});

test("composeBody: a link inside a sentence is left as a link", () => {
  // A typed reply must not sprout a button in the middle of a paragraph.
  const long = "I had a look at https://example.test/x and it seems fine to me, so go ahead whenever you like.";
  const { html } = composeBody({ text: long });
  assert.ok(!html.includes("padding:12px 26px"), "a link inside a paragraph became a button");
  assert.match(html, /<a href="https:\/\/example\.test\/x"/);
});

test("composeBody: the PLAIN TEXT part is untouched by any of it", () => {
  // Every sentence a customer reads is written in email-templates.ts. This
  // file decides how the HTML twin looks and never what it says.
  const body = "Hi Pat,\n\nOpen it here: https://example.test/q/abc\n\nThanks.";
  const { text } = composeBody({ text: body, signature: "Marc", footer: "Sent by Acme Fence using FenceFlow" });
  assert.equal(text, body + "\n\n-- \nMarc\n\nSent by Acme Fence using FenceFlow\n");
});

test("composeBody: everything in the header and the footer is still escaped", () => {
  const { html } = composeBody({
    text: "Hi",
    logoAlt: '<script>alert(1)</script>',
    footer: '<b>not bold</b>',
  });
  assert.ok(!html.includes("<script>"), "a company name reached the HTML as markup");
  assert.ok(!html.includes("<b>not bold</b>"), "a footer reached the HTML as markup");
});

// ============================================================ brand colour ==
//
// One colour the company picks, on the things where colour earns its keep:
// the button, a rule under the header, and a light tint behind the card.
// NOT a different colour each time (a letter that looks different on every
// send reads as a different sender, and is a phishing copy's best friend),
// and NOT the page background at full strength (on a phone the card fills
// the screen, so the background is a margin nobody sees).

test("composeBody: with no colour chosen, nothing changes", () => {
  const plain = composeBody({ text: "Open it here: https://example.test/q/a", logoAlt: "Acme" });
  for (const bad of [null, undefined, "", "red", "#abc", "#12345g", "#123456;background:url(x)"]) {
    const got = composeBody({ text: "Open it here: https://example.test/q/a", logoAlt: "Acme", brandColor: bad });
    assert.equal(got.html, plain.html, `"${bad}" was treated as a colour`);
  }
});

test("composeBody: the chosen colour lands on the button and the header rule", () => {
  const { html } = composeBody({
    text: "Open it here: https://example.test/q/a",
    logoAlt: "Acme",
    brandColor: "#8A1C2B",
  });
  assert.match(html, /background:#8a1c2b/, "the button is not in the company's colour");
  assert.match(html, /border-bottom:3px solid #8a1c2b/, "the header rule is not in the company's colour");
});

test("composeBody: the page is a TINT, never the colour at full strength", () => {
  const { html } = composeBody({ text: "Hi", logoAlt: "Acme", brandColor: "#8a1c2b" });
  const body = /<body style="[^"]*background:(#[0-9a-f]{6})/.exec(html);
  assert.ok(body, "the body has no background colour at all");
  assert.notEqual(body[1], "#8a1c2b", "the whole page is the brand colour, which reads as a flyer");
  // Every channel at least as light as the colour itself, and close to white.
  const ch = (h, i) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  for (let i = 0; i < 3; i++) {
    assert.ok(ch(body[1], i) >= ch("#8a1c2b", i), `channel ${i} got darker, not lighter`);
    assert.ok(ch(body[1], i) > 220, `channel ${i} is not a light tint`);
  }
});

test("composeBody: button text is readable on whatever colour was picked", () => {
  // The whole reason this is computed. White on a pale yellow is a button a
  // customer cannot read, on the one email that asks for money.
  const dark = composeBody({ text: "Open it here: https://e.test/a", brandColor: "#10243a" }).html;
  assert.match(dark, /color:#ffffff;text-decoration:none/, "white text was not used on a dark colour");
  const pale = composeBody({ text: "Open it here: https://e.test/a", brandColor: "#ffe14d" }).html;
  assert.match(pale, /color:#111111;text-decoration:none/, "white text on a pale yellow -- unreadable");
});

test("PLANTED FAILURE: always-white really would fail on the pale colour", () => {
  // Proves the check above is discriminating rather than agreeing by luck.
  const pale = composeBody({ text: "Open it here: https://e.test/a", brandColor: "#ffe14d" }).html;
  assert.ok(!/color:#ffffff;text-decoration:none/.test(pale),
    "the pale case still renders white text, so the luminance rule is not running");
});
