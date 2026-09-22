// The IMAP client against a scripted fake server. No network, no Deno, no
// live mailbox, and no real password anywhere: every "server" here is a
// script the test wrote.
//
// Run with:  node --test tests/mail-imap-client.test.mjs
//
// The client is exercised exactly as the edge functions drive it: the real
// StreamTransport (timeouts, byte caps, line and literal framing) over a
// fake socket, the real ImapClient on top, and the real openSession /
// syncFolder / verifyMailbox / fetchMessage sequences called with the same
// arguments mail-connect, mail-sync and mail-message pass. The main session
// is tests/fixtures/mail/zoho-session.imap.txt; the rest are short inline
// scripts in the same format (documented at the top of that file).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { StreamTransport } from "../supabase/functions/_shared/mail/tls-transport.ts";
import {
  fetchMessage,
  ImapClient,
  openSession,
  setFlag,
  syncFolder,
  verifyMailbox,
} from "../supabase/functions/_shared/mail/imap-client.ts";
import { findSentFolder } from "../supabase/functions/_shared/mail/imap-proto.ts";
import { accountStatusFor, MailError } from "../supabase/functions/_shared/mail/errors.ts";
import {
  HEADER_BLOCK_MAX_BYTES,
  HEADER_FETCH_BATCH,
  HEADERS_PER_FOLDER_PER_RUN,
  SESSION_BYTE_CAP,
} from "../supabase/functions/_shared/mail/limits.ts";

const FIXTURE = readFileSync(new URL("./fixtures/mail/zoho-session.imap.txt", import.meta.url), "utf8");
// Shaped like a Zoho app password (16 characters), and fake.
const PASSWORD = "k7Qp2mX9vR4tZw8L";
const USER = "owner@acmefence.com";
// mail-sync passes new Date(); a fixed one makes SINCE deterministic.
const NOW = new Date("2026-09-21T12:00:00Z");
const SINCE = "22-Aug-2026"; // NOW minus FIRST_SYNC_DAYS (30)

// ---------------------------------------------------------------------------
// The fake server: a ByteConn (read/write/close) that plays a script.
// ---------------------------------------------------------------------------

function parseScript(text, vars = {}) {
  const fill = (s) => Object.entries(vars).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(String(v)), s);
  const steps = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("#") || raw.trim() === "") continue;
    if (raw.trim() === "HANG") {
      steps.push({ kind: "HANG" });
      continue;
    }
    const m = /^(S|L|C|C\+|CL):(?: ?)(.*)$/.exec(raw);
    if (!m) throw new Error(`bad script line: ${raw}`);
    const kind = m[1];
    let text = kind === "C" || kind === "C+" || kind === "CL" ? fill(m[2]) : m[2];
    // CL: "<json string>" lets a literal carry CRLFs, which one script line cannot.
    if (kind === "CL" && text.startsWith('"')) text = JSON.parse(text);
    steps.push({ kind, text });
  }
  return steps;
}

class FakeImapServer {
  constructor(script, vars = {}, { chunk = 0 } = {}) {
    this.steps = parseScript(script, vars);
    this.pos = 0;
    this.out = [];
    this.inBuf = Buffer.alloc(0);
    this.raw = [];
    this.mismatches = [];
    this.closed = false;
    this.hung = false;
    this.waiters = [];
    this.lastTag = "*";
    this.chunk = chunk;
    this.pump();
  }

  wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }

  push(bytes) {
    this.out.push(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes);
    this.wake();
  }

  pump() {
    while (this.pos < this.steps.length) {
      const step = this.steps[this.pos];
      if (step.kind === "HANG") {
        this.hung = true;
        return;
      }
      if (step.kind !== "S") return;
      this.pos++;
      let line = step.text.split("<tag>").join(this.lastTag);
      if (line.endsWith("{LITERAL}")) {
        const lits = [];
        while (this.pos < this.steps.length && this.steps[this.pos].kind === "L") lits.push(this.steps[this.pos++].text);
        const body = Buffer.from(lits.map((l) => `${l}\r\n`).join(""), "utf8");
        line = line.slice(0, -"{LITERAL}".length) + `{${body.length}}`;
        this.push(Buffer.concat([Buffer.from(`${line}\r\n`, "utf8"), body]));
      } else {
        this.push(`${line}\r\n`);
      }
    }
  }

  mismatch(expected, got) {
    this.mismatches.push({ expected, got });
    this.pos = this.steps.length;
    this.push(`${this.lastTag} BAD fake server expected ${JSON.stringify(expected)}\r\n`);
  }

  consume() {
    for (;;) {
      const step = this.steps[this.pos];
      if (!step || step.kind === "S" || step.kind === "HANG") {
        if (this.inBuf.length && !this.hung && this.pos >= this.steps.length && this.mismatches.length === 0) {
          this.mismatches.push({ expected: "(end of script)", got: this.inBuf.toString("utf8") });
          this.inBuf = Buffer.alloc(0);
        }
        return;
      }
      if (step.kind === "CL") {
        const want = Buffer.from(step.text, "utf8");
        if (this.inBuf.length < want.length) return;
        const got = this.inBuf.subarray(0, want.length);
        this.inBuf = this.inBuf.subarray(want.length);
        if (!got.equals(want)) return this.mismatch(`literal ${step.text}`, got.toString("utf8"));
        this.pos++;
        this.pump();
        continue;
      }
      const idx = this.inBuf.indexOf("\r\n");
      if (idx < 0) return;
      const line = this.inBuf.subarray(0, idx).toString("utf8");
      this.inBuf = this.inBuf.subarray(idx + 2);
      if (step.kind === "C") {
        const sp = line.indexOf(" ");
        this.lastTag = sp > 0 ? line.slice(0, sp) : line;
        const rest = sp > 0 ? line.slice(sp + 1) : "";
        if (rest !== step.text) return this.mismatch(step.text, rest);
      } else if (line !== step.text) {
        return this.mismatch(step.text, line);
      }
      this.pos++;
      this.pump();
    }
  }

  // --- ByteConn ---
  async read(p) {
    while (this.out.length === 0) {
      if (this.closed) return null;
      if (this.pos >= this.steps.length && !this.hung) return null; // script over: server hangs up
      await new Promise((r) => this.waiters.push(r));
    }
    const head = this.out[0];
    const n = Math.min(p.length, head.length, this.chunk || Infinity);
    p.set(head.subarray(0, n));
    if (n === head.length) this.out.shift();
    else this.out[0] = head.subarray(n);
    return n;
  }

  async write(p) {
    if (this.closed) throw Object.assign(new Error("closed"), { name: "BadResource" });
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

  rawText() {
    return Buffer.concat(this.raw).toString("utf8");
  }
}

function session(script, vars = {}, limits = {}, opts = {}) {
  const server = new FakeImapServer(script, vars, opts);
  const transport = new StreamTransport(server, { opTimeoutMs: 2000, ...limits });
  const client = new ImapClient(transport);
  return { server, transport, client };
}

function header(bytes, name) {
  const text = new TextDecoder().decode(bytes).replace(/\r\n[ \t]+/g, " ");
  const m = new RegExp(`^${name}:[ \\t]*(.*)$`, "mi").exec(text);
  return m ? m[1].trim() : null;
}

async function rejectsWith(promise, code) {
  let caught = null;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof MailError, `expected MailError(${code}), got ${caught}`);
  assert.equal(caught.code, code, `expected ${code}, got ${caught.code}: ${caught.message}`);
  return caught;
}

const GREETING = "S: * OK [CAPABILITY IMAP4rev1 UIDPLUS AUTH=PLAIN] ready";
// What mail-sync asks for per message: the header fields, capped.
const FIELDS = "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC REPLY-TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES CONTENT-TYPE)]<0.32768>)";
const LOGIN_OK = [
  GREETING,
  `C: LOGIN "${USER}" "{password}"`,
  "S: <tag> OK LOGIN completed",
].join("\n");

// ---------------------------------------------------------------------------
// The Zoho-shaped session, called the way mail-connect + mail-sync call it.
// ---------------------------------------------------------------------------

test("Zoho session: login, find Sent, first sync of INBOX, later sync of Sent", async () => {
  // chunk: 5 delivers the stream five bytes at a time, so every line and
  // every literal straddles read boundaries.
  const { server, client } = session(FIXTURE, { password: PASSWORD, since: SINCE }, {}, { chunk: 5 });

  await openSession(client, { username: USER, password: PASSWORD });
  const sent = findSentFolder(await client.list());
  const inbox = await syncFolder(
    client,
    { path: "INBOX", uidValidity: null, lastUid: 0, backfillBelowUid: null, initialDone: false },
    NOW,
  );
  const sentDelta = await syncFolder(
    client,
    {
      path: sent.path,
      uidValidity: 1729000002,
      lastUid: 87,
      backfillBelowUid: null,
      initialDone: true,
      knownUids: [80, 81, 82, 83, 84, 85, 86, 87],
    },
    NOW,
  );
  await client.logout();

  assert.deepEqual(server.mismatches, [], "client sent something the script did not expect");

  // The real special-use folder, not the user folder called "Sent Items".
  assert.equal(sent.path, "Sent");

  assert.equal(inbox.uidValidity, 1729000001);
  assert.equal(inbox.reset, false);
  assert.deepEqual(inbox.messages.map((m) => m.uid), [4101, 4102, 4103]);
  assert.deepEqual(inbox.messages.map((m) => header(m.headers, "Subject")), [
    "Fence quote for 14 Oak Lane",
    "Re: Gate options (A) or {5}",
    "Deposit received - thank you",
  ]);
  assert.deepEqual(inbox.messages.map((m) => m.flags), [["\\Seen"], [], ["\\Flagged"]]);
  assert.equal(inbox.messages[0].internalDate, "2026-09-14T13:12:44.000Z");
  assert.equal(inbox.messages[2].internalDate, "2026-09-09T08:00:04.000Z");
  assert.equal(inbox.messages[1].size, 2210);
  // The planted literal came through byte for byte, folded References and all.
  assert.equal(header(inbox.messages[1].headers, "References"),
    "<b1c2d3e4-0000-4000-8000-000000000001@acmefence.com> <a7f3c1d2-5b6e-4f80-9a1b-2c3d4e5f6a7b@acmefence.com>");
  assert.equal(inbox.lastUid, 4103);
  assert.equal(inbox.backfillBelowUid, null);
  assert.equal(inbox.initialDone, true);

  // The "*" trap: the server answered 87 to "88:*". Nothing is new.
  assert.equal(sentDelta.uidValidity, 1729000002);
  assert.deepEqual(sentDelta.messages, []);
  assert.equal(sentDelta.lastUid, 87);
  assert.deepEqual(sentDelta.goneUids, [83]);
  assert.deepEqual(sentDelta.flags.find((f) => f.uid === 81).flags, ["\\Seen", "\\Answered"]);
  assert.equal(sentDelta.flags.length, 7);
});

test("PLANTED: the password is on the wire but never in transcript()", async () => {
  const { server, client } = session(FIXTURE, { password: PASSWORD, since: SINCE });
  await openSession(client, { username: USER, password: PASSWORD });
  await client.list();
  // Positive control: the raw write stream really did carry it, so the
  // absence below is the transcript's doing, not a test that cannot see.
  assert.ok(server.rawText().includes(PASSWORD), "fixture should have sent the password");
  const transcript = client.transcript().join("\n");
  assert.ok(!transcript.includes(PASSWORD), "password leaked into transcript");
  assert.match(transcript, /C: A2 LOGIN \[credentials hidden\]/);
  assert.match(transcript, /S: \* LIST \(\\HasNoChildren \\Sent\) "\/" "Sent"/);
  client.close();
});

// ---------------------------------------------------------------------------
// Login refusals and how they classify.
// ---------------------------------------------------------------------------

test("wrong app password: auth_failed, the account stops being retried, and nothing echoes the password", async () => {
  const script = [
    GREETING,
    `C: LOGIN "${USER}" "{password}"`,
    // A hostile or buggy server that echoes what it was sent.
    "S: <tag> NO [AUTHENTICATIONFAILED] Invalid credentials for {password} (Failure)",
  ].join("\n").split("{password}").join(PASSWORD);
  const { client } = session(script, { password: PASSWORD });
  const err = await rejectsWith(openSession(client, { username: USER, password: PASSWORD }), "auth_failed");
  assert.equal(accountStatusFor(err.code), "auth_failed");
  assert.ok(!err.message.includes(PASSWORD), `password in error: ${err.message}`);
  assert.ok(!err.detail.includes(PASSWORD));
  assert.match(err.detail, /Invalid credentials for \[redacted\]/);
  assert.ok(!client.transcript().join("\n").includes(PASSWORD));
});

test("IMAP switched off in Zoho: imap_disabled_or_plan, not 'wrong password'", async () => {
  const script = [
    GREETING,
    `C: LOGIN "${USER}" "{password}"`,
    "S: <tag> NO [ALERT] You are yet to enable IMAP for your account. Please contact your administrator (Failure)",
  ].join("\n");
  const { client } = session(script, { password: PASSWORD });
  const err = await rejectsWith(openSession(client, { username: USER, password: PASSWORD }), "imap_disabled_or_plan");
  assert.equal(accountStatusFor(err.code), "auth_failed", "a login-level refusal must not be retried by the schedule");
});

test("a password that is not 7-bit goes as a literal, waiting for the server's go-ahead", async () => {
  const pw = "Zäun-Passwört-9ß";
  const len = Buffer.byteLength(pw, "utf8");
  const script = [
    GREETING,
    `C: LOGIN "${USER}" {${len}}`,
    "S: + Ready for literal data",
    "CL: {password}",
    "C+: ",
    "S: <tag> OK LOGIN completed",
  ].join("\n");
  const { server, client } = session(script, { password: pw });
  await openSession(client, { username: USER, password: pw });
  assert.deepEqual(server.mismatches, []);
  assert.ok(!client.transcript().join("\n").includes(pw));
});

test("LITERAL+ sends the literal without waiting", async () => {
  const pw = "Zäun-Passwört-9ß";
  const len = Buffer.byteLength(pw, "utf8");
  const script = [
    "S: * OK [CAPABILITY IMAP4rev1 LITERAL+ AUTH=PLAIN] ready",
    `C: LOGIN "${USER}" {${len}+}`,
    "CL: {password}",
    "C+: ",
    "S: <tag> OK LOGIN completed",
  ].join("\n");
  const { server, client } = session(script, { password: pw });
  await openSession(client, { username: USER, password: pw });
  assert.deepEqual(server.mismatches, []);
});

test("LOGINDISABLED: AUTHENTICATE PLAIN through a continuation, blob hidden too", async () => {
  const blob = Buffer.from(`\0${USER}\0${PASSWORD}`, "utf8").toString("base64");
  const script = [
    "S: * OK [CAPABILITY IMAP4rev1 LOGINDISABLED AUTH=PLAIN] ready",
    "C: AUTHENTICATE PLAIN",
    "S: + ",
    "C+: {blob}",
    "S: <tag> OK AUTHENTICATE completed",
  ].join("\n");
  const { server, client } = session(script, { blob });
  await openSession(client, { username: USER, password: PASSWORD });
  assert.deepEqual(server.mismatches, []);
  assert.ok(server.rawText().includes(blob), "positive control: the blob was sent");
  const t = client.transcript().join("\n");
  assert.ok(!t.includes(blob) && !t.includes(PASSWORD), `secret in transcript:\n${t}`);
});

test("LOGINDISABLED with SASL-IR sends the blob on the command line", async () => {
  const blob = Buffer.from(`\0${USER}\0${PASSWORD}`, "utf8").toString("base64");
  const script = [
    "S: * OK [CAPABILITY IMAP4rev1 LOGINDISABLED AUTH=PLAIN SASL-IR] ready",
    "C: AUTHENTICATE PLAIN {blob}",
    "S: <tag> OK AUTHENTICATE completed",
  ].join("\n");
  const { server, client } = session(script, { blob });
  await openSession(client, { username: USER, password: PASSWORD });
  assert.deepEqual(server.mismatches, []);
  assert.ok(!client.transcript().join("\n").includes(blob));
});

test("PLANTED: a PREAUTH server is refused before any password is sent", async () => {
  const { server, client } = session("S: * PREAUTH [CAPABILITY IMAP4rev1] logged in already\nHANG");
  await rejectsWith(openSession(client, { username: USER, password: PASSWORD }), "protocol_error");
  assert.ok(!server.rawText().includes(PASSWORD));
});

test("a BYE greeting (too many connections) is server_busy, which the schedule may retry", async () => {
  const { client } = session("S: * BYE Too many connections, try again later");
  const err = await rejectsWith(openSession(client, { username: USER, password: PASSWORD }), "server_busy");
  assert.equal(accountStatusFor(err.code), "error");
});

// ---------------------------------------------------------------------------
// Transport limits, seen through the client.
// ---------------------------------------------------------------------------

test("a server that stops answering is a timeout, not a hang", async () => {
  const script = [GREETING, `C: LOGIN "${USER}" "{password}"`, "HANG"].join("\n");
  const { client } = session(script, { password: PASSWORD }, { opTimeoutMs: 60 });
  const started = Date.now();
  await rejectsWith(openSession(client, { username: USER, password: PASSWORD }), "timeout");
  assert.ok(Date.now() - started < 1500);
});

test("the session deadline ends a session that keeps answering slowly", async () => {
  const script = [GREETING, `C: LOGIN "${USER}" "{password}"`, "HANG"].join("\n");
  const { client } = session(script, { password: PASSWORD }, { opTimeoutMs: 5000, sessionDeadlineMs: 80 });
  await rejectsWith(openSession(client, { username: USER, password: PASSWORD }), "session_limit");
});

test("a flood past the byte cap is cut off", async () => {
  const flood = Array.from({ length: 50 }, (_, i) => `S: * ${i + 1} EXISTS`).join("\n");
  const script = [LOGIN_OK, "C: EXAMINE \"INBOX\"", flood, "HANG"].join("\n");
  const { client } = session(script, { password: PASSWORD }, { byteCap: 600 });
  await openSession(client, { username: USER, password: PASSWORD });
  await rejectsWith(client.examine("INBOX"), "session_limit");
});

test("a literal larger than allowed is refused before it is read", async () => {
  const script = [
    LOGIN_OK,
    "C: UID FETCH 7 (UID BODY.PEEK[])",
    "S: * 1 FETCH (UID 7 BODY[] {99999999}",
    "HANG",
  ].join("\n");
  const { client, transport } = session(script, { password: PASSWORD }, { maxLiteralBytes: 1024 });
  await openSession(client, { username: USER, password: PASSWORD });
  await rejectsWith(client.uidFetchSource(7), "session_limit");
  assert.ok(transport.bytesRead < 1024);
});

// ---------------------------------------------------------------------------
// mail-connect's check, and the other sequences.
// ---------------------------------------------------------------------------

test("verifyMailbox: what mail-connect learns, then a clean LOGOUT", async () => {
  const script = [
    LOGIN_OK,
    'C: LIST "" "*"',
    'S: * LIST (\\HasNoChildren) "/" "INBOX"',
    'S: * LIST (\\HasChildren \\Noselect) "/" "[Gmail]"',
    'S: * LIST (\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"',
    "S: <tag> OK LIST done",
    'C: EXAMINE "INBOX"',
    "S: * 0 EXISTS",
    "S: * OK [UIDVALIDITY 42] ok",
    "S: <tag> OK [READ-ONLY] done",
    "C: LOGOUT",
    "S: * BYE bye",
    "S: <tag> OK done",
  ].join("\n");
  const { server, client } = session(script, { password: PASSWORD });
  const check = await verifyMailbox(client, { username: USER, password: PASSWORD });
  assert.deepEqual(server.mismatches, []);
  assert.equal(check.sentFolder, "[Gmail]/Sent Mail");
  assert.equal(check.inbox.uidValidity, 42);
  assert.equal(check.inbox.uidNext, null);
});

test("syncFolder after a UIDVALIDITY reset starts over and marks nothing gone", async () => {
  const script = [
    LOGIN_OK,
    'C: EXAMINE "INBOX"',
    "S: * OK [UIDVALIDITY 999] new world",
    "S: * OK [UIDNEXT 3] next",
    "S: <tag> OK [READ-ONLY] done",
    `C: UID SEARCH SINCE ${SINCE}`,
    "S: * SEARCH 1 2",
    "S: <tag> OK done",
    `C: UID FETCH 1:2 ${FIELDS}`,
    "S: * 1 FETCH (UID 1 FLAGS () BODY[HEADER.FIELDS (SUBJECT)] {LITERAL}",
    "L: Subject: one",
    "L:",
    "S: )",
    "S: * 2 FETCH (UID 2 FLAGS () BODY[HEADER.FIELDS (SUBJECT)] {LITERAL}",
    "L: Subject: two",
    "L:",
    "S: )",
    "S: <tag> OK done",
  ].join("\n");
  const { server, client } = session(script, { password: PASSWORD });
  await openSession(client, { username: USER, password: PASSWORD });
  const delta = await syncFolder(
    client,
    { path: "INBOX", uidValidity: 111, lastUid: 500, backfillBelowUid: null, initialDone: true, knownUids: [498, 499, 500] },
    NOW,
  );
  assert.deepEqual(server.mismatches, []);
  assert.equal(delta.reset, true);
  assert.equal(delta.uidValidity, 999);
  assert.deepEqual(delta.messages.map((m) => header(m.headers, "Subject")), ["one", "two"]);
  assert.equal(delta.lastUid, 2);
  assert.deepEqual(delta.goneUids, [], "old-validity UIDs must not be marked gone under the new validity");
});

test("syncFolder: an empty folder with no UIDNEXT is not asked for its highest UID", async () => {
  const script = [
    LOGIN_OK,
    'C: EXAMINE "Sent"',
    "S: * 0 EXISTS",
    "S: * OK [UIDVALIDITY 3] ok",
    "S: <tag> OK [READ-ONLY] done",
    `C: UID SEARCH SINCE ${SINCE}`,
    "S: * SEARCH",
    "S: <tag> OK done",
    // No "UID SEARCH UID *" step: some servers answer it with BAD here.
  ].join("\n");
  const { server, client } = session(script, { password: PASSWORD });
  await openSession(client, { username: USER, password: PASSWORD });
  const d = await syncFolder(client, { path: "Sent", uidValidity: null, lastUid: 0, backfillBelowUid: null, initialDone: false }, NOW);
  assert.deepEqual(server.mismatches, []);
  assert.deepEqual(d.messages, []);
  assert.equal(d.lastUid, 0);
  assert.equal(d.initialDone, true);
});

test("syncFolder: a first run with no UIDNEXT asks for the top UID, so old mail is never 'new' later", async () => {
  const script = [
    LOGIN_OK,
    'C: EXAMINE "INBOX"',
    "S: * 900 EXISTS",
    "S: * OK [UIDVALIDITY 3] ok",
    "S: <tag> OK [READ-ONLY] done",
    `C: UID SEARCH SINCE ${SINCE}`,
    "S: * SEARCH",
    "S: <tag> OK done",
    "C: UID SEARCH UID *",
    "S: * SEARCH 8812",
    "S: <tag> OK done",
  ].join("\n");
  const { server, client } = session(script, { password: PASSWORD });
  await openSession(client, { username: USER, password: PASSWORD });
  const d = await syncFolder(client, { path: "INBOX", uidValidity: null, lastUid: 0, backfillBelowUid: null, initialDone: false }, NOW);
  assert.deepEqual(server.mismatches, []);
  assert.equal(d.lastUid, 8812, "900 messages older than the window must not be pulled in by the next run");
});

test("syncFolder works through a burst oldest-first, then spends what is left on backfill", async () => {
  const fields = FIELDS;
  const script = [
    LOGIN_OK,
    // Run 1: three new above 10, cap 2 -> the OLDEST two (11, 12).
    'C: EXAMINE "INBOX"',
    "S: * OK [UIDVALIDITY 7] ok",
    "S: <tag> OK [READ-ONLY] done",
    "C: UID SEARCH UID 11:*",
    "S: * SEARCH 11 12 13",
    "S: <tag> OK done",
    `C: UID FETCH 11:12 ${fields}`,
    "S: * 1 FETCH (UID 11 FLAGS ())",
    "S: * 2 FETCH (UID 12 FLAGS ())",
    "S: <tag> OK done",
    // Run 2: one new (13), one slot left for backfill below 5.
    'C: EXAMINE "INBOX"',
    "S: * OK [UIDVALIDITY 7] ok",
    "S: <tag> OK [READ-ONLY] done",
    "C: UID SEARCH UID 13:*",
    "S: * SEARCH 13",
    "S: <tag> OK done",
    `C: UID SEARCH SINCE ${SINCE} UID 1:4`,
    "S: * SEARCH 2 3 4",
    "S: <tag> OK done",
    // New mail first, then backfill: each fetch is a batch whose state can
    // be saved on its own.
    `C: UID FETCH 13 ${fields}`,
    "S: * 3 FETCH (UID 13 FLAGS ())",
    "S: <tag> OK done",
    `C: UID FETCH 4 ${fields}`,
    "S: * 1 FETCH (UID 4 FLAGS ())",
    "S: <tag> OK done",
  ].join("\n");
  const { server, client } = session(script, { password: PASSWORD });
  await openSession(client, { username: USER, password: PASSWORD });
  const run1 = await syncFolder(client, { path: "INBOX", uidValidity: 7, lastUid: 10, backfillBelowUid: null, initialDone: true }, NOW, 2);
  assert.deepEqual(run1.messages.map((m) => m.uid), [11, 12]);
  assert.equal(run1.lastUid, 12, "must not skip past 13, which has not been fetched");
  const run2 = await syncFolder(client, { path: "INBOX", uidValidity: 7, lastUid: 12, backfillBelowUid: 5, initialDone: true }, NOW, 2);
  assert.deepEqual(server.mismatches, []);
  assert.deepEqual(run2.messages.map((m) => m.uid), [4, 13]);
  assert.equal(run2.lastUid, 13);
  assert.equal(run2.backfillBelowUid, 4, "2 and 3 are still waiting");
});

test("PLANTED: every header block is capped, so no sender can make a folder's fetch outgrow the session", async () => {
  // The cap is on the wire, in the command production sends...
  assert.ok(FIELDS.endsWith(`]<0.${HEADER_BLOCK_MAX_BYTES}>)`));
  // ...and what it buys: INBOX and Sent at the full per-run count still fit
  // the session's byte cap with room for everything else. Uncapped, one
  // outside sender's 200 messages with 100 KB of Cc each would not.
  assert.ok(2 * HEADERS_PER_FOLDER_PER_RUN * HEADER_BLOCK_MAX_BYTES < SESSION_BYTE_CAP * 0.7);
  assert.ok(!(2 * HEADERS_PER_FOLDER_PER_RUN * 100 * 1024 < SESSION_BYTE_CAP), "planted: the uncapped case really would not fit");
  assert.ok(HEADER_FETCH_BATCH < HEADERS_PER_FOLDER_PER_RUN, "a run must be more than one batch, or a cut run keeps nothing");

  // A server that answers the partial fetch as asked (Zoho echoes "<0>").
  const big = "x".repeat(HEADER_BLOCK_MAX_BYTES - 40);
  const script = [
    LOGIN_OK,
    'C: EXAMINE "INBOX"',
    "S: * OK [UIDVALIDITY 7] ok",
    "S: <tag> OK [READ-ONLY] done",
    "C: UID SEARCH UID 11:*",
    "S: * SEARCH 11",
    "S: <tag> OK done",
    `C: UID FETCH 11 ${FIELDS}`,
    "S: * 1 FETCH (UID 11 FLAGS () BODY[HEADER.FIELDS (FROM TO CC REPLY-TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES CONTENT-TYPE)]<0> {LITERAL}",
    "L: Subject: capped",
    `L: References: <${big}`,
    "S: )",
    "S: <tag> OK done",
  ].join("\n");
  const { server, client } = session(script, { password: PASSWORD });
  await openSession(client, { username: USER, password: PASSWORD });
  const d = await syncFolder(client, { path: "INBOX", uidValidity: 7, lastUid: 10, backfillBelowUid: null, initialDone: true }, NOW);
  assert.deepEqual(server.mismatches, [], "the header fetch was not capped");
  assert.equal(header(d.messages[0].headers, "Subject"), "capped");
  assert.ok(d.messages[0].headers.length <= HEADER_BLOCK_MAX_BYTES);
});

test("syncFolder hands over each batch with the state it makes safe; a run cut short resumes where it stopped", async () => {
  // Five in the window, batches of two: newest first, so the backfill mark
  // follows each batch down and the folder's top is recorded at once.
  const batch = (uids) => [
    `C: UID FETCH ${uids} ${FIELDS}`,
    ...expand(uids).map((u) => `S: * ${u} FETCH (UID ${u} FLAGS ())`),
    "S: <tag> OK done",
  ];
  const expand = (set) => set.split(",").flatMap((p) => {
    const [a, b = a] = p.split(":").map(Number);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });
  const first = [
    LOGIN_OK,
    'C: EXAMINE "INBOX"',
    "S: * 5 EXISTS",
    "S: * OK [UIDVALIDITY 7] ok",
    "S: * OK [UIDNEXT 6] next",
    "S: <tag> OK [READ-ONLY] done",
    `C: UID SEARCH SINCE ${SINCE}`,
    "S: * SEARCH 1 2 3 4 5",
    "S: <tag> OK done",
    ...batch("4:5"),
    // The second batch never comes: a slow server, or the office's budget.
    `C: UID FETCH 2:3 ${FIELDS}`,
    "HANG",
  ].join("\n");
  const saved = [];
  const onBatch = async (b) => saved.push({ uids: b.messages.map((m) => m.uid), lastUid: b.lastUid, backfill: b.backfillBelowUid });
  const s1 = session(first, { password: PASSWORD }, { opTimeoutMs: 150 });
  await openSession(s1.client, { username: USER, password: PASSWORD });
  await rejectsWith(syncFolder(s1.client, { path: "INBOX", uidValidity: null, lastUid: 0, backfillBelowUid: null, initialDone: false }, NOW, 200,
    { batchSize: 2, onBatch }), "timeout");
  assert.deepEqual(s1.server.mismatches, []);
  // What mail-sync would have stored: the first batch, and a state that
  // leaves 1-3 for later rather than skipping them.
  assert.deepEqual(saved, [{ uids: [4, 5], lastUid: 5, backfill: 4 }]);

  // The next run starts from that state: nothing new above 5 (the "*" trap
  // answers 5), and the rest of the window comes in as backfill.
  const second = [
    LOGIN_OK,
    'C: EXAMINE "INBOX"',
    "S: * OK [UIDVALIDITY 7] ok",
    "S: <tag> OK [READ-ONLY] done",
    "C: UID SEARCH UID 6:*",
    "S: * SEARCH 5",
    "S: <tag> OK done",
    `C: UID SEARCH SINCE ${SINCE} UID 1:3`,
    "S: * SEARCH 1 2 3",
    "S: <tag> OK done",
    ...batch("2:3"),
    ...batch("1"),
  ].join("\n");
  saved.length = 0;
  const s2 = session(second, { password: PASSWORD });
  await openSession(s2.client, { username: USER, password: PASSWORD });
  const d = await syncFolder(s2.client, { path: "INBOX", uidValidity: 7, lastUid: 5, backfillBelowUid: 4, initialDone: true }, NOW, 200,
    { batchSize: 2, onBatch });
  assert.deepEqual(s2.server.mismatches, []);
  assert.deepEqual(saved, [{ uids: [2, 3], lastUid: 5, backfill: 2 }, { uids: [1], lastUid: 5, backfill: null }]);
  assert.deepEqual(d.messages.map((m) => m.uid), [1, 2, 3]);
  assert.equal(d.lastUid, 5);
  assert.equal(d.backfillBelowUid, null, "the window is complete");
});

test("fetchMessage refuses an oversized message before downloading any of it", async () => {
  const script = [
    LOGIN_OK,
    'C: EXAMINE "INBOX"',
    "S: * OK [UIDVALIDITY 5] ok",
    "S: <tag> OK [READ-ONLY] done",
    "C: UID FETCH 9 (UID FLAGS RFC822.SIZE)",
    "S: * 1 FETCH (UID 9 FLAGS () RFC822.SIZE 14680064)",
    "S: <tag> OK done",
    // No step for "UID FETCH 9 (UID BODY.PEEK[])": sending it is a mismatch.
  ].join("\n");
  const { server, client } = session(script, { password: PASSWORD });
  await openSession(client, { username: USER, password: PASSWORD });
  const r = await fetchMessage(client, { path: "INBOX", uidValidity: 5, uid: 9, markSeen: false });
  assert.deepEqual(r, { state: "too_large", size: 14680064 });
  assert.deepEqual(server.mismatches, []);
});

test("fetchMessage downloads with BODY.PEEK and marks \\Seen only when asked", async () => {
  const script = [
    LOGIN_OK,
    'C: SELECT "INBOX"',
    "S: * OK [UIDVALIDITY 5] ok",
    "S: <tag> OK [READ-WRITE] done",
    "C: UID FETCH 9 (UID FLAGS RFC822.SIZE)",
    "S: * 1 FETCH (UID 9 FLAGS () RFC822.SIZE 20)",
    "S: <tag> OK done",
    "C: UID FETCH 9 (UID BODY.PEEK[])",
    "S: * 1 FETCH (UID 9 BODY[] {LITERAL}",
    "L: Subject: hi",
    "L:",
    "L: body",
    "S: )",
    "S: <tag> OK done",
    "C: UID STORE 9 +FLAGS.SILENT (\\Seen)",
    "S: <tag> OK done",
  ].join("\n");
  const { server, client } = session(script, { password: PASSWORD });
  await openSession(client, { username: USER, password: PASSWORD });
  const r = await fetchMessage(client, { path: "INBOX", uidValidity: 5, uid: 9, markSeen: true });
  assert.deepEqual(server.mismatches, []);
  assert.equal(r.state, "ok");
  assert.equal(new TextDecoder().decode(r.source), "Subject: hi\r\n\r\nbody\r\n");
  assert.deepEqual(r.flags, ["\\Seen"]);
});

test("fetchMessage notices a UIDVALIDITY change instead of opening a different message", async () => {
  const script = [
    LOGIN_OK,
    'C: EXAMINE "INBOX"',
    "S: * OK [UIDVALIDITY 6] ok",
    "S: <tag> OK [READ-ONLY] done",
  ].join("\n");
  const { client } = session(script, { password: PASSWORD });
  await openSession(client, { username: USER, password: PASSWORD });
  assert.deepEqual(await fetchMessage(client, { path: "INBOX", uidValidity: 5, uid: 9, markSeen: false }), { state: "uidvalidity_changed" });
});

test("a folder that no longer exists is folder_missing", async () => {
  const script = [LOGIN_OK, 'C: EXAMINE "Old Sent"', "S: <tag> NO [NONEXISTENT] Mailbox doesn't exist"].join("\n");
  const { client } = session(script, { password: PASSWORD });
  await openSession(client, { username: USER, password: PASSWORD });
  await rejectsWith(client.examine("Old Sent"), "folder_missing");
});

test("PLANTED: FenceFlow never deletes -- \\Deleted is refused and nothing is sent", async () => {
  const script = [LOGIN_OK, 'C: SELECT "INBOX"', "S: * OK [UIDVALIDITY 5] ok", "S: <tag> OK done", "HANG"].join("\n");
  const { server, client } = session(script, { password: PASSWORD }, { opTimeoutMs: 200 });
  await openSession(client, { username: USER, password: PASSWORD });
  await client.select("INBOX");
  const before = server.rawText().length;
  await rejectsWith(client.uidStore([9], "+", ["\\Deleted"]), "bad_request");
  await rejectsWith(setFlag(client, { path: "INBOX", uidValidity: 5, uid: 9, flag: "\\Deleted", on: true }), "bad_request");
  assert.equal(server.rawText().length, before, "nothing at all was written for either refusal");
  assert.equal(typeof client.expunge, "undefined");
  assert.equal(typeof client.move, "undefined");
});

test("APPEND of a Sent copy goes as a literal and returns the APPENDUID", async () => {
  const msg = "Subject: copy\r\n\r\nhello\r\n";
  const script = [
    LOGIN_OK,
    `C: APPEND "Sent" (\\Seen) {${Buffer.byteLength(msg)}}`,
    "S: + go ahead",
    `CL: ${JSON.stringify(msg)}`,
    "C+: ",
    "S: <tag> OK [APPENDUID 1729000002 88] APPEND completed",
  ].join("\n");
  const { server, client } = session(script, { password: PASSWORD });
  await openSession(client, { username: USER, password: PASSWORD });
  const uid = await client.append("Sent", new TextEncoder().encode(msg));
  assert.deepEqual(server.mismatches, []);
  assert.equal(uid, 88);
});
