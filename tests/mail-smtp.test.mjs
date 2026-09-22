// The SMTP client against a scripted fake server. No network, no Deno, no
// live mailbox, and no real password anywhere: every "server" here is a
// script the test wrote, in the shape Zoho's and Gmail's port-465 servers
// answer in (not captured sessions).
//
// Run with:  node --test tests/mail-smtp.test.mjs
//
// The client runs exactly as mail-connect and mail-send drive it: the real
// StreamTransport (timeouts, line framing) over a fake socket, the real
// SmtpClient on top, and the real verifySmtp / sendMessage sequences, with
// messages built by the real mime-build.buildMime.
import test from "node:test";
import assert from "node:assert/strict";
import { StreamTransport } from "../supabase/functions/_shared/mail/tls-transport.ts";
import {
  dotStuff,
  EHLO_NAME,
  isUnconfirmed,
  sendMessage,
  SmtpClient,
  SmtpUnconfirmed,
  verifySmtp,
} from "../supabase/functions/_shared/mail/smtp-client.ts";
import { buildMime, composeBody, validateSendFields } from "../supabase/functions/_shared/mail/mime-build.ts";
import { accountStatusFor, errorBody, MailError } from "../supabase/functions/_shared/mail/errors.ts";
import { MAX_RECIPIENTS_SMTP } from "../supabase/functions/_shared/mail/limits.ts";

// Shaped like a Zoho app password (16 characters), and fake.
const PASSWORD = "k7Qp2mX9vR4tZw8L";
const USER = "owner@acmefence.com";
const CREDS = { username: USER, password: PASSWORD };
const BLOB = Buffer.from(`\0${USER}\0${PASSWORD}`, "utf8").toString("base64");

// ---------------------------------------------------------------------------
// The fake server: a ByteConn (read/write/close) that plays a script.
//   { s: "250 ok" } or { s: ["250-a", "250 b"] }  server sends line(s)
//   { c: "EHLO x" } or { c: /regex/ }              client must send this line
//   { data: true }                                 client sends a DATA payload,
//                                                  captured up to CRLF.CRLF
//   { hang: true }                                 server stops answering
// ---------------------------------------------------------------------------

class FakeSmtpServer {
  constructor(steps) {
    this.steps = steps;
    this.pos = 0;
    this.out = [];
    this.inBuf = Buffer.alloc(0);
    this.raw = [];
    this.lines = [];
    this.data = null;
    this.mismatches = [];
    this.closed = false;
    this.waiters = [];
    this.pump();
  }

  wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }

  pump() {
    while (this.pos < this.steps.length && this.steps[this.pos].s !== undefined) {
      const s = this.steps[this.pos++].s;
      for (const line of Array.isArray(s) ? s : [s]) this.out.push(Buffer.from(`${line}\r\n`, "utf8"));
      this.wake();
    }
  }

  mismatch(expected, got) {
    this.mismatches.push({ expected: String(expected), got });
    this.pos = this.steps.length;
    this.out.push(Buffer.from(`500 fake server expected ${String(expected)}\r\n`));
    this.wake();
  }

  consume() {
    for (;;) {
      const step = this.steps[this.pos];
      if (!step || step.s !== undefined || step.hang) {
        if (this.inBuf.length && this.pos >= this.steps.length && this.mismatches.length === 0) {
          this.mismatches.push({ expected: "(end of script)", got: this.inBuf.toString("latin1") });
        }
        return;
      }
      if (step.data) {
        const end = this.inBuf.indexOf("\r\n.\r\n");
        if (end < 0) return;
        this.data = Buffer.from(this.inBuf.subarray(0, end + 5));
        this.inBuf = this.inBuf.subarray(end + 5);
        this.pos++;
        this.pump();
        continue;
      }
      const idx = this.inBuf.indexOf("\r\n");
      if (idx < 0) return;
      const line = this.inBuf.subarray(0, idx).toString("latin1");
      this.inBuf = this.inBuf.subarray(idx + 2);
      const ok = step.c instanceof RegExp ? step.c.test(line) : line === step.c;
      if (!ok) return this.mismatch(step.c, line);
      this.lines.push(line);
      this.pos++;
      this.pump();
    }
  }

  async read(p) {
    while (this.out.length === 0) {
      if (this.closed) return null;
      await new Promise((r) => this.waiters.push(r));
    }
    const chunk = this.out[0];
    const n = Math.min(p.length, chunk.length);
    p.set(chunk.subarray(0, n));
    if (n === chunk.length) this.out.shift();
    else this.out[0] = chunk.subarray(n);
    return n;
  }

  async write(p) {
    if (this.closed) throw new Error("write on closed socket");
    const b = Buffer.from(p);
    this.raw.push(b);
    this.inBuf = Buffer.concat([this.inBuf, b]);
    this.consume();
    return p.length;
  }

  close() {
    this.closed = true;
    this.wake();
  }

  /** Everything the client wrote, as one string. */
  wire() {
    return Buffer.concat(this.raw).toString("latin1");
  }
}

function session(steps, limits = {}) {
  const server = new FakeSmtpServer(steps);
  const client = new SmtpClient(new StreamTransport(server, { opTimeoutMs: 2000, ...limits }));
  return { server, client };
}

async function rejects(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  assert.fail("expected a rejection");
}

/** A DATA payload back into the message it carries: terminator off, one
 *  leading dot removed from every line that has one (RFC 5321 4.5.2). */
function unstuff(payload) {
  const s = payload.toString("latin1");
  assert.ok(s.endsWith("\r\n.\r\n"), "payload ends with the terminator");
  return s.slice(0, -3).split("\r\n").map((l) => (l.startsWith(".") ? l.slice(1) : l)).join("\r\n");
}

const ZOHO_HELLO = [
  { s: "220 smtp.zoho.com ESMTP ready" },
  { c: `EHLO ${EHLO_NAME}` },
  { s: ["250-smtp.zoho.com Hello fenceflowapp.com (203.0.113.9)", "250-AUTH LOGIN PLAIN", "250 SIZE 53477376"] },
];
const AUTH_OK = [{ c: `AUTH PLAIN ${BLOB}` }, { s: "235 Authentication Successful" }];

function quote(extra = {}) {
  const body = composeBody({ text: "Hi Dana,\n\nThe quote is attached.\n\nMike", signature: "Mike Ruiz\nAcme Fence" });
  return buildMime({
    from: { name: "Acme Fence", address: USER },
    to: ["dana.whitfield@example.org"],
    cc: ["sam@example.org"],
    subject: "Quote for 14 Oak Lane",
    text: body.text,
    html: body.html,
    messageId: "0f8e3a1c-2b4d-4e6f-8a9b-1c2d3e4f5a6b@acmefence.com",
    date: new Date("2026-09-21T18:13:00Z"),
    attachments: [{ filename: "quote.pdf", contentType: "application/pdf", content: new Uint8Array([37, 80, 68, 70, 45, 49]) }],
    ...extra,
  });
}

// ---------------------------------------------------------------------------

test("multi-line EHLO: every extension line is read, old AUTH= spelling included", async () => {
  const { server, client } = session([
    { s: "220 smtp.gmail.com ESMTP a1-20020a17 - gsmtp" },
    { c: `EHLO ${EHLO_NAME}` },
    {
      s: [
        "250-smtp.gmail.com at your service, [203.0.113.9]",
        "250-SIZE 35882577",
        "250-8BITMIME",
        "250-AUTH LOGIN PLAIN XOAUTH2 PLAIN-CLIENTTOKEN OAUTHBEARER XOAUTH",
        "250-AUTH=LOGIN",
        "250-ENHANCEDSTATUSCODES",
        "250-PIPELINING",
        "250-CHUNKING",
        "250 SMTPUTF8",
      ],
    },
    ...AUTH_OK,
    { c: "QUIT" },
    { s: "221 2.0.0 closing connection" },
  ]);
  const out = await verifySmtp(client, CREDS);
  assert.deepEqual(server.mismatches, []);
  assert.equal(out.sizeLimit, 35882577);
  assert.ok(out.authMechanisms.includes("PLAIN") && out.authMechanisms.includes("XOAUTH2"));
  assert.ok(client.extensions.has("SMTPUTF8") && client.extensions.has("PIPELINING"));
  // mail-connect proves the password can send, and sends nothing.
  assert.ok(!server.lines.some((l) => /^(MAIL|RCPT|DATA)/.test(l)));
  assert.equal(server.lines.at(-1), "QUIT");
});

test("sendMessage: the whole exchange, called the way mail-send calls it", async () => {
  const fields = validateSendFields(
    { to: ["dana.whitfield@example.org"], cc: ["sam@example.org"], bcc: ["office-copy@acmefence.com"], subject: "Quote for 14 Oak Lane", text: "Hi" },
    MAX_RECIPIENTS_SMTP,
  );
  const built = quote({ to: fields.to, cc: fields.cc });
  const { server, client } = session([
    ...ZOHO_HELLO,
    ...AUTH_OK,
    { c: `MAIL FROM:<${USER}> SIZE=${built.bytes.length}` },
    { s: "250 Sender <owner@acmefence.com> OK" },
    { c: "RCPT TO:<dana.whitfield@example.org>" },
    { s: "250 Recipient <dana.whitfield@example.org> OK" },
    { c: "RCPT TO:<sam@example.org>" },
    { s: "250 Recipient <sam@example.org> OK" },
    { c: "RCPT TO:<office-copy@acmefence.com>" },
    { s: "250 Recipient <office-copy@acmefence.com> OK" },
    { c: "DATA" },
    { s: "354 Ok Send data ending with <CRLF>.<CRLF>" },
    { data: true },
    { s: "250 Message received 1726942380.123" },
    { c: "QUIT" },
    { s: "221 Service closing" },
  ]);
  const res = await sendMessage(client, CREDS, { from: USER, recipients: [...fields.to, ...fields.cc, ...fields.bcc] }, built.bytes);
  assert.deepEqual(server.mismatches, []);
  assert.equal(res.recipients, 3);
  assert.equal(res.response, "250 Message received 1726942380.123");
  // What the server got is exactly the message that was built...
  assert.equal(unstuff(server.data), Buffer.from(built.bytes).toString("latin1"));
  // ...and the blind copy is in the envelope only, never in the message.
  assert.ok(!server.data.toString("latin1").includes("office-copy@acmefence.com"));
  assert.ok(!/^bcc:/im.test(server.data.toString("latin1")));
});

test("PLANTED: a body line starting with '.' is doubled, so only the real terminator ends the message", async () => {
  const text = "Line one\r\n.hidden line\r\n.\r\n..\r\nMAIL FROM:<evil@example.net>\r\nlast line";
  const message = new TextEncoder().encode(`Subject: dots\r\n\r\n${text}`);
  const { server, client } = session([
    ...ZOHO_HELLO,
    ...AUTH_OK,
    { c: `MAIL FROM:<${USER}> SIZE=${message.length}` },
    { s: "250 OK" },
    { c: "RCPT TO:<dana.whitfield@example.org>" },
    { s: "250 OK" },
    { c: "DATA" },
    { s: "354 go ahead" },
    { data: true },
    { s: "250 queued" },
    { c: "QUIT" },
    { s: "221 bye" },
  ]);
  await sendMessage(client, CREDS, { from: USER, recipients: ["dana.whitfield@example.org"] }, message);
  // Unstuffed, the whole body arrived -- the lone "." did not end it early
  // and "MAIL FROM" was data, not a second transaction.
  assert.deepEqual(server.mismatches, []);
  const wire = server.data.toString("latin1");
  assert.ok(wire.includes("\r\n..hidden line\r\n..\r\n...\r\n"), "each leading dot doubled");
  assert.equal(wire.indexOf("\r\n.\r\n"), wire.length - 5, "the terminator appears once, at the end");
  // No trailing CRLF on the input, so the payload gains one before the dot.
  assert.equal(unstuff(server.data), `Subject: dots\r\n\r\n${text}\r\n`);
});

test("PLANTED: a bare LF (the SMTP smuggling shape) is refused before a byte is sent", async () => {
  const smuggle = new TextEncoder().encode("Subject: hi\r\n\r\nhello\n.\nMAIL FROM:<evil@example.net>\r\n");
  const { server, client } = session([...ZOHO_HELLO]);
  const err = await rejects(sendMessage(client, CREDS, { from: USER, recipients: ["dana.whitfield@example.org"] }, smuggle));
  assert.ok(err instanceof MailError);
  assert.equal(err.code, "server_error");
  assert.equal(server.wire(), "", "not even EHLO was sent");
  assert.throws(() => dotStuff(new TextEncoder().encode("a\rb\r\n")), /bare CR/);
  assert.throws(() => dotStuff(new Uint8Array([72, 0xc3, 0xa9, 13, 10])), /7-bit/);
});

test("535 at AUTH: smtp_auth_failed, account stops being retried, password never echoed", async () => {
  const { server, client } = session([
    ...ZOHO_HELLO,
    { c: `AUTH PLAIN ${BLOB}` },
    // A server that echoes what it was sent: the worst case for leaking.
    { s: `535 Authentication Failed for ${PASSWORD} (${BLOB})` },
  ]);
  const err = await rejects(verifySmtp(client, CREDS));
  assert.equal(err.code, "smtp_auth_failed");
  assert.equal(accountStatusFor(err.code), "auth_failed");
  // The password really was on the wire (inside the blob)...
  assert.ok(server.wire().includes(BLOB));
  // ...and appears nowhere a person or a log could see it.
  for (const text of [err.message, err.detail, JSON.stringify(errorBody(err, [PASSWORD])), client.transcript().join("\n")]) {
    assert.ok(!text.includes(PASSWORD), `password leaked into: ${text}`);
    assert.ok(!text.includes(BLOB), `blob leaked into: ${text}`);
  }
  assert.ok(client.transcript().includes("C: AUTH PLAIN [credentials hidden]"));
});

test("Gmail's 534 'application-specific password required' is a credential failure; 454 is temporary", async () => {
  const gmail = session([...ZOHO_HELLO, { c: `AUTH PLAIN ${BLOB}` }, { s: "534-5.7.9 Application-specific password required." }, { s: "534 5.7.9 Learn more at https://support.google.com/mail - gsmtp" }]);
  assert.equal((await rejects(verifySmtp(gmail.client, CREDS))).code, "smtp_auth_failed");
  const busy = session([...ZOHO_HELLO, { c: `AUTH PLAIN ${BLOB}` }, { s: "454 4.7.0 Temporary authentication failure" }]);
  const err = await rejects(verifySmtp(busy.client, CREDS));
  assert.equal(err.code, "server_busy");
  assert.equal(accountStatusFor(err.code), "error");
});

test("PLANTED: one refused recipient means RSET, and DATA is never sent", async () => {
  const message = quote().bytes;
  const { server, client } = session([
    ...ZOHO_HELLO,
    ...AUTH_OK,
    { c: /^MAIL FROM:<owner@acmefence\.com> SIZE=\d+$/ },
    { s: "250 OK" },
    { c: "RCPT TO:<dana.whitfield@example.org>" },
    { s: "250 OK" },
    { c: "RCPT TO:<typo@exmaple.org>" },
    { s: "550 5.1.1 <typo@exmaple.org>: Recipient address rejected: User unknown" },
    { c: "RSET" },
    { s: "250 Reset OK" },
    { c: "QUIT" },
    { s: "221 bye" },
  ]);
  const err = await rejects(
    sendMessage(client, CREDS, { from: USER, recipients: ["dana.whitfield@example.org", "typo@exmaple.org", "sam@example.org"] }, message),
  );
  assert.deepEqual(server.mismatches, []);
  assert.equal(err.code, "recipient_rejected");
  assert.match(err.detail, /typo@exmaple\.org/);
  assert.ok(!server.lines.includes("DATA"), "DATA was sent after a refusal");
  assert.ok(!server.lines.includes("RCPT TO:<sam@example.org>"), "kept offering recipients after a refusal");
  assert.equal(server.data, null);
  assert.ok(!server.wire().includes("Quote for 14 Oak Lane"), "message content reached the wire");
});

test("a temporary refusal of a recipient (452) also aborts, as server_busy", async () => {
  const { server, client } = session([
    ...ZOHO_HELLO,
    ...AUTH_OK,
    { c: /^MAIL FROM:/ },
    { s: "250 OK" },
    { c: "RCPT TO:<dana.whitfield@example.org>" },
    { s: "452 4.5.3 Too many recipients" },
    { c: "RSET" },
    { s: "250 OK" },
    { c: "QUIT" },
    { s: "221 bye" },
  ]);
  const err = await rejects(sendMessage(client, CREDS, { from: USER, recipients: ["dana.whitfield@example.org"] }, quote().bytes));
  assert.equal(err.code, "server_busy");
  assert.equal(server.data, null);
});

test("a refused sender (553, relaying from another address) is send_rejected, with no RCPT or DATA", async () => {
  const { server, client } = session([
    ...ZOHO_HELLO,
    ...AUTH_OK,
    { c: /^MAIL FROM:/ },
    { s: "553 Sender is not allowed to relay emails" },
  ]);
  const err = await rejects(sendMessage(client, CREDS, { from: USER, recipients: ["dana.whitfield@example.org"] }, quote().bytes));
  assert.equal(err.code, "send_rejected");
  assert.ok(!server.lines.some((l) => l.startsWith("RCPT") || l === "DATA"));
});

test("a message larger than the server's SIZE is refused before MAIL FROM", async () => {
  const { server, client } = session([
    { s: "220 small.example ESMTP" },
    { c: `EHLO ${EHLO_NAME}` },
    { s: ["250-small.example", "250-AUTH PLAIN", "250 SIZE 100"] },
    ...AUTH_OK,
    { c: "QUIT" },
    { s: "221 bye" },
  ]);
  const err = await rejects(sendMessage(client, CREDS, { from: USER, recipients: ["dana.whitfield@example.org"] }, quote().bytes));
  assert.equal(err.code, "too_large");
  assert.ok(!server.lines.some((l) => l.startsWith("MAIL")));
});

test("no verdict after the body: SmtpUnconfirmed, so mail-send leaves it 'sending' rather than 'failed'", async () => {
  const { client } = session(
    [
      ...ZOHO_HELLO,
      ...AUTH_OK,
      { c: /^MAIL FROM:/ },
      { s: "250 OK" },
      { c: "RCPT TO:<dana.whitfield@example.org>" },
      { s: "250 OK" },
      { c: "DATA" },
      { s: "354 go ahead" },
      { data: true },
      { hang: true },
    ],
    { opTimeoutMs: 60 },
  );
  const err = await rejects(sendMessage(client, CREDS, { from: USER, recipients: ["dana.whitfield@example.org"] }, quote().bytes));
  assert.ok(err instanceof SmtpUnconfirmed);
  assert.ok(isUnconfirmed(err));
  assert.ok(err instanceof MailError, "still a MailError, so errorBody() handles it");
  assert.equal(err.code, "timeout");
});

test("a refusal after the body (554) is definite: failed, not unconfirmed", async () => {
  const { client } = session([
    ...ZOHO_HELLO,
    ...AUTH_OK,
    { c: /^MAIL FROM:/ },
    { s: "250 OK" },
    { c: "RCPT TO:<dana.whitfield@example.org>" },
    { s: "250 OK" },
    { c: "DATA" },
    { s: "354 go ahead" },
    { data: true },
    { s: "554 5.7.1 Message rejected as spam" },
  ]);
  const err = await rejects(sendMessage(client, CREDS, { from: USER, recipients: ["dana.whitfield@example.org"] }, quote().bytes));
  assert.equal(err.code, "send_rejected");
  assert.ok(!isUnconfirmed(err));
});

test("a timeout BEFORE the body is definite too: nothing was sent", async () => {
  const { client } = session([...ZOHO_HELLO, ...AUTH_OK, { c: /^MAIL FROM:/ }, { hang: true }], { opTimeoutMs: 60 });
  const err = await rejects(sendMessage(client, CREDS, { from: USER, recipients: ["dana.whitfield@example.org"] }, quote().bytes));
  assert.equal(err.code, "timeout");
  assert.ok(!isUnconfirmed(err));
});

test("AUTH LOGIN when PLAIN is not offered; both answers hidden from the transcript", async () => {
  const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
  const { server, client } = session([
    { s: "220 mail.example.net ESMTP" },
    { c: `EHLO ${EHLO_NAME}` },
    { s: ["250-mail.example.net", "250 AUTH LOGIN"] },
    { c: "AUTH LOGIN" },
    { s: "334 VXNlcm5hbWU6" },
    { c: b64(USER) },
    { s: "334 UGFzc3dvcmQ6" },
    { c: b64(PASSWORD) },
    { s: "235 2.7.0 Authentication successful" },
    { c: "QUIT" },
    { s: "221 bye" },
  ]);
  await verifySmtp(client, CREDS);
  assert.deepEqual(server.mismatches, []);
  const t = client.transcript().join("\n");
  assert.ok(!t.includes(b64(PASSWORD)) && !t.includes(PASSWORD));
  assert.equal(client.transcript().filter((l) => l === "C: [credentials hidden]").length, 2);
});

test("a 334 after the PLAIN blob is cancelled with '*', never answered with the password again", async () => {
  const { server, client } = session([...ZOHO_HELLO, { c: `AUTH PLAIN ${BLOB}` }, { s: "334 " }, { c: "*" }, { s: "501 cancelled" }]);
  const err = await rejects(verifySmtp(client, CREDS));
  assert.equal(err.code, "protocol_error");
  assert.equal(server.wire().split(BLOB).length - 1, 1, "the blob was sent exactly once");
});

test("a 421 greeting is server_busy; a server with no AUTH is refused before any password is sent", async () => {
  const busy = session([{ s: "421 4.3.2 Too many connections, try again later" }]);
  assert.equal((await rejects(verifySmtp(busy.client, CREDS))).code, "server_busy");
  const noAuth = session([{ s: "220 relay.example ESMTP" }, { c: `EHLO ${EHLO_NAME}` }, { s: ["250-relay.example", "250 8BITMIME"] }]);
  const err = await rejects(verifySmtp(noAuth.client, CREDS));
  assert.equal(err.code, "protocol_error");
  assert.ok(!noAuth.server.wire().includes(BLOB));
});

test("a reply whose code changes mid-reply is a protocol error, not a success", async () => {
  // Ends in "250": read by its last line alone, this EHLO would pass and
  // the password would go next.
  const { server, client } = session([{ s: "220 x.example ESMTP" }, { c: `EHLO ${EHLO_NAME}` }, { s: ["554-x.example refuses you", "250 AUTH PLAIN"] }]);
  const err = await rejects(verifySmtp(client, CREDS));
  assert.equal(err.code, "protocol_error");
  assert.match(err.detail, /codes changed/);
  assert.ok(!server.wire().includes("AUTH"), "went on to authenticate");
});

test("PLANTED: a line break in an envelope address never reaches the wire", async () => {
  const { server, client } = session([...ZOHO_HELLO]);
  const err = await rejects(
    sendMessage(client, CREDS, { from: USER, recipients: ["dana@example.org>\r\nRCPT TO:<evil@example.net"] }, quote().bytes),
  );
  assert.equal(err.code, "bad_request");
  assert.equal(server.wire(), "");
  const second = session([...ZOHO_HELLO]);
  const err2 = await rejects(sendMessage(second.client, CREDS, { from: `${USER}\r\nRSET`, recipients: ["a@example.org"] }, quote().bytes));
  assert.equal(err2.code, "bad_request");
  assert.equal(second.server.wire(), "");
});

test("recipient limits are checked before connecting; duplicates collapse", async () => {
  const many = Array.from({ length: MAX_RECIPIENTS_SMTP + 1 }, (_, i) => `r${i}@example.org`);
  const { server, client } = session([...ZOHO_HELLO]);
  assert.equal((await rejects(sendMessage(client, CREDS, { from: USER, recipients: many }, quote().bytes))).code, "bad_request");
  assert.equal(server.wire(), "");
  const dup = session([
    ...ZOHO_HELLO,
    ...AUTH_OK,
    { c: /^MAIL FROM:/ },
    { s: "250 OK" },
    { c: "RCPT TO:<dana@example.org>" },
    { s: "250 OK" },
    { c: "DATA" },
    { s: "354 go" },
    { data: true },
    { s: "250 ok" },
    { c: "QUIT" },
    { s: "221 bye" },
  ]);
  const res = await sendMessage(dup.client, CREDS, { from: USER, recipients: ["dana@example.org", "Dana@EXAMPLE.org"] }, quote().bytes);
  assert.equal(res.recipients, 1);
  assert.deepEqual(dup.server.mismatches, []);
});

test("dotStuff: a dot at the very start is doubled and the terminator always follows a CRLF", () => {
  const dec = (u8) => new TextDecoder().decode(u8);
  assert.equal(dec(dotStuff(new TextEncoder().encode(".a\r\nb\r\n"))), "..a\r\nb\r\n.\r\n");
  assert.equal(dec(dotStuff(new TextEncoder().encode("a"))), "a\r\n.\r\n");
  assert.throws(() => dotStuff(new Uint8Array(0)), MailError);
});
