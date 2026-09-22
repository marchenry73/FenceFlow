// mail-send, the whole function, run under Node the way the office calls
// it. No network, no Deno, no live Supabase, no real mailbox, no real Resend,
// and no real password or key anywhere: every secret here is made up, every
// server is a model this file wrote.
//
// Run with:  node --test tests/mail-send.test.mjs
//
// What is real and what is fake:
//
//  - REAL: supabase/functions/mail-send/index.ts, unmodified, and every
//    shared module under it -- caller.ts (the gate), hosts.ts (the SSRF
//    rules), mime-build.ts, reply.ts, the SMTP and IMAP clients,
//    StreamTransport, errors.redact(). The sent message is parsed back with
//    the vendored postal-mime.
//  - FAKE: supabase-js (esm.sh), swapped by a module hook for an in-memory
//    database that plays RLS for the caller's client (own company, and only
//    while the gate says true), refuses every service-only call from it, and
//    runs mail_ingest to supabase_mail.sql's contract -- including its KEY
//    NAMES, so a row key the SQL would silently ignore is caught here -- and
//    storage (service role only: mail-files has no client SELECT policy).
//    The SMTP server, the IMAP mailbox, Resend, DNS and the clock are models
//    handed in through the function's deps.
//
// Tests marked PLANTED are the ones whose failure would mean a security or
// never-twice property is gone: a sender or Bcc header smuggled in, the gate
// or RLS bypassed, a second copy sent for one client_send_id, a send past the
// rate limit, a refused recipient getting a half-addressed message, "maybe
// sent" reported as "failed", a password or key leaking, another person's
// file attached, a private address dialed, a duplicate APPENDed into Sent.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { registerHooks } from "node:module";
import { StreamTransport } from "../supabase/functions/_shared/mail/tls-transport.ts";
import { MailError } from "../supabase/functions/_shared/mail/errors.ts";
import { parseMail } from "../supabase/functions/_shared/mail/message-meta.ts";

// ---------------------------------------------------------------------------
// Made-up identities and secrets.
// ---------------------------------------------------------------------------

const PASSWORD = "k7Qp2mX9vR4tZw8L";
const API_KEY = "re_FAKE_4f9Qz7Lm2Xv8Rt5Wp1Ks";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

const USER = "office@acmefence.com";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJl";
const UID = "11111111-1111-4111-8111-111111111111";
const COLLEAGUE = "33333333-3333-4333-8333-333333333333";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY = "99999999-9999-4999-8999-999999999999";
const JOB = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-09-21T18:00:00.000Z");
const MAIL_FROM_BARE = "noreply@send.fenceflowapp.com";
const INBOUND_TOKEN = "a1b2c3d4e5f60718";

// ---------------------------------------------------------------------------
// The fake supabase-js.
// ---------------------------------------------------------------------------

const SUPABASE_JS = "https://esm.sh/@supabase/supabase-js@2.39.0";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === SUPABASE_JS) {
      const src = "export const createClient = (...a) => globalThis.__mailSendCreateClient(...a);";
      return { url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const ENV = {};
const BASE_ENV = {
  SUPABASE_URL: "https://project.example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
};

/** Every key supabase_mail.sql's mail_ingest reads from a row. */
const INGEST_KEYS = new Set([
  "folder_role", "source", "uidvalidity", "uid", "provider_message_id", "message_id_header", "parent_ids",
  "from_address", "from_name", "to_list", "cc_list", "reply_to_list", "to_text", "counterpart_emails", "subject",
  "sent_at", "received_at", "size_bytes", "has_attachments", "is_seen", "is_answered", "is_flagged", "snippet",
  "body_state", "body_text", "body_html", "body_truncated", "attachments", "send_state", "send_error",
  "client_send_id", "sent_by", "job_sync_id", "reply_token",
]);
const SERVICE_ONLY_TABLES = new Set(["mail_folder_state", "mail_platform_settings", "mail_account_secrets", "mail_events"]);
const RLS_TABLES = new Set(["mail_accounts", "mail_messages", "mail_threads", "mail_thread_jobs"]);

let world;

function resetWorld(over = {}) {
  for (const k of Object.keys(ENV)) delete ENV[k];
  Object.assign(ENV, BASE_ENV);
  world = {
    created: [],
    rpcCalls: [],
    timeline: [],
    events: [],
    downloads: [],
    noteAnswer: undefined,
    dayAnswer: undefined,
    beforeIngest: null,
    unknownIngestKeys: new Set(),
    secrets: new Map(),
    storage: new Map(),
    user: { data: { user: { id: UID } }, error: null },
    gate: { data: true, error: null },
    profile: { data: { company_id: COMPANY, role: "OWNER" }, error: null },
    company: { data: { name: " Acme Fence Co ", email: " office@acmefence.com " }, error: null },
    db: {
      mail_accounts: [],
      mail_messages: [],
      mail_threads: [],
      mail_thread_jobs: [],
      mail_folder_state: [],
      mail_platform_settings: [{ id: 1, inbound_verified_at: null }],
      jobs: [{ company_id: COMPANY, sync_id: JOB, deleted_at: null }],
    },
    ...over,
  };
}

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const matches = (row, filters) => filters.every(([op, col, val]) => (op === "eq" ? row[col] === val : row[col] !== val));
const randomHex = (n) => randomBytes(n).toString("hex");

/** Every table query of every test, never reset: which client asked, and
 *  with which filters. The final sweep checks the company filter on all. */
const queryLog = [];

function execute(key, table, st) {
  world.timeline.push(`${st.op}:${table}`);
  queryLog.push({ key, table, op: st.op, cols: st.cols, filters: clone(st.filters), payload: clone(st.payload) });
  const asUser = key === "anon-key";
  const denied = { data: null, error: { code: "42501", message: "permission denied" } };
  if (table === "profiles" || table === "companies") {
    if (!asUser) return denied;
    return table === "profiles" ? world.profile : world.company;
  }
  if (asUser && (st.op !== "select" || SERVICE_ONLY_TABLES.has(table))) return denied;
  const rows = world.db[table];
  if (!rows) return { data: null, error: { code: "42P01", message: `no table ${table}` } };
  const visible = (r) =>
    !asUser || (RLS_TABLES.has(table) && r.company_id === world.profile.data?.company_id && world.gate.data === true);

  let out;
  if (st.op === "select") {
    out = rows.filter(visible).filter((r) => matches(r, st.filters));
  } else {
    out = [];
    for (const r of rows.filter((x) => matches(x, st.filters))) {
      Object.assign(r, clone(st.payload));
      if (table === "mail_accounts") r.updated_at = new Date().toISOString();
      out.push(r);
    }
  }
  if (st.cols && st.cols !== "*") {
    const cols = st.cols.split(",").map((c) => c.trim());
    out = out.map((r) => Object.fromEntries(cols.map((c) => [c, clone(r[c]) ?? null])));
  } else {
    out = out.map((r) => clone(r));
  }
  if (st.single) {
    if (out.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
    return { data: out[0] ?? null, error: null };
  }
  return { data: st.op === "select" || st.returning ? out : null, error: null };
}

function query(key, table) {
  const st = { op: "select", cols: "*", filters: [], payload: null, returning: false, single: false };
  const run = () => Promise.resolve().then(() => execute(key, table, st));
  const q = {
    select(cols = "*") {
      if (st.op !== "select") st.returning = true;
      st.cols = cols;
      return q;
    },
    update(obj) {
      st.op = "update";
      st.payload = obj;
      return q;
    },
    eq(col, val) {
      st.filters.push(["eq", col, val]);
      return q;
    },
    neq(col, val) {
      st.filters.push(["neq", col, val]);
      return q;
    },
    maybeSingle() {
      st.single = true;
      return run();
    },
    then(resolve, reject) {
      return run().then(resolve, reject);
    },
  };
  return q;
}

const WINDOWS = { "1 hour": 3_600_000, "1 day": 86_400_000 };

function countEvents(company, kind, window) {
  return world.events.filter((e) => e.company === company && e.kind === kind && e.at > NOW - WINDOWS[window]).length;
}

/** mail_ingest, to the contract in supabase_mail.sql, as far as a send uses it. */
function ingest(args) {
  const acct = world.db.mail_accounts.find((a) => a.id === args.p_account);
  if (!acct) return { data: null, error: { code: "P0002", message: "Unknown mail account" } };
  if (!Array.isArray(args.p_rows)) return { data: null, error: { code: "22023", message: "p_rows must be a JSON array" } };
  if (world.beforeIngest) world.beforeIngest(acct);
  const out = [];
  for (const r of args.p_rows) {
    for (const k of Object.keys(r)) if (!INGEST_KEYS.has(k)) world.unknownIngestKeys.add(k);
    if (r.source === "fenceflow_send" && (!r.client_send_id || r.folder_role !== "sent")) {
      return { data: null, error: { code: "22023", message: "A FenceFlow send needs client_send_id" } };
    }
    // 1. De-duplicate on client_send_id, company-wide.
    const hit = world.db.mail_messages.find((m) => m.company_id === acct.company_id && r.client_send_id && m.client_send_id === r.client_send_id);
    if (hit) {
      out.push({ message_id: hit.id, thread_id: hit.thread_id, inserted: false });
      continue;
    }
    // 3. Thread: reply_token (this company's only) -> a parent -> new.
    let thread = null;
    if (r.reply_token) thread = world.db.mail_threads.find((t) => t.company_id === acct.company_id && t.reply_token === r.reply_token) ?? null;
    if (!thread && Array.isArray(r.parent_ids) && r.parent_ids.length) {
      const p = world.db.mail_messages.find((m) => m.company_id === acct.company_id && r.parent_ids.includes(m.message_id_header));
      if (p) thread = world.db.mail_threads.find((t) => t.id === p.thread_id) ?? null;
    }
    if (!thread) {
      thread = { id: randomUUID(), company_id: acct.company_id, reply_token: randomHex(6), subject: r.subject ?? "" };
      world.db.mail_threads.push(thread);
    }
    const { reply_token: _token, ...cols } = r;
    const row = {
      is_answered: false,
      is_flagged: false,
      ...clone(cols),
      id: randomUUID(),
      company_id: acct.company_id,
      account_id: acct.id,
      thread_id: thread.id,
      uid: null,
      uidvalidity: null,
      provider_message_id: null,
      server_gone_at: null,
    };
    world.db.mail_messages.push(row);
    if (r.job_sync_id && world.db.jobs.some((j) => j.company_id === acct.company_id && j.sync_id === r.job_sync_id && !j.deleted_at)) {
      world.db.mail_thread_jobs.push({ thread_id: thread.id, company_id: acct.company_id, job_sync_id: r.job_sync_id, linked_by: r.sent_by });
    }
    out.push({ message_id: row.id, thread_id: thread.id, inserted: true });
  }
  return { data: out, error: null };
}

function rpc(key, name, args = {}) {
  world.rpcCalls.push({ name, key, args: clone(args) });
  world.timeline.push(`rpc:${name}`);
  if (name === "can_use_company_mail") return key === "anon-key" ? world.gate : { data: false, error: null };
  if (key !== "service-key") return { data: null, error: { code: "42501", message: "Service role only" } };
  switch (name) {
    case "note_mail_event":
      world.events.push({ company: args.p_company, actor: args.p_actor, kind: args.p_kind, at: NOW });
      return { data: world.noteAnswer ?? countEvents(args.p_company, args.p_kind, args.p_window), error: null };
    case "mail_event_count":
      return { data: world.dayAnswer ?? countEvents(args.p_company, args.p_kind, args.p_window), error: null };
    case "mail_secret_get":
      return { data: world.secrets.get(args.p_account) ?? null, error: null };
    case "mail_ingest":
      return ingest(args);
    case "mail_fenceflow_account": {
      let row = world.db.mail_accounts.find((r) => r.company_id === args.p_company && r.kind === "fenceflow");
      if (!row) {
        row = account({
          company_id: args.p_company, kind: "fenceflow", provider: "resend", email_address: args.p_email, username: null,
          imap_host: null, smtp_host: null, imap_port: null, smtp_port: null, sent_folder: null, inbound_token: INBOUND_TOKEN,
        });
        world.db.mail_accounts.push(row);
      }
      return { data: row.id, error: null };
    }
    default:
      return { data: null, error: { code: "PGRST202", message: `no function ${name}` } };
  }
}

globalThis.__mailSendCreateClient = (url, key, options) => {
  world.created.push({ key, auth: options?.global?.headers?.Authorization ?? null });
  return {
    auth: {
      getUser: async (jwt) =>
        jwt === JWT && key === "anon-key" ? world.user : { data: { user: null }, error: { message: "invalid JWT" } },
    },
    rpc: async (name, args) => rpc(key, name, args),
    from: (table) => query(key, table),
    storage: {
      from: (bucket) => ({
        download: async (path) => {
          world.timeline.push(`download:${path}`);
          world.downloads.push({ key, bucket, path });
          // mail-files has no client SELECT policy at all.
          if (key !== "service-key") return { data: null, error: { message: "new row violates row-level security policy" } };
          const obj = bucket === "mail-files" ? world.storage.get(path) : null;
          if (!obj) return { data: null, error: { message: "Object not found" } };
          return { data: new Blob([obj.bytes], { type: obj.type }), error: null };
        },
      }),
    },
  };
};

// ---------------------------------------------------------------------------
// Rows.
// ---------------------------------------------------------------------------

function account(over = {}) {
  return {
    id: randomUUID(),
    company_id: COMPANY,
    kind: "imap",
    provider: "zoho",
    email_address: USER,
    display_name: null,
    signature: null,
    username: USER,
    imap_host: "imappro.zoho.com",
    smtp_host: "smtppro.zoho.com",
    imap_port: 993,
    smtp_port: 465,
    sent_folder: "Sent",
    smtp_saves_sent: true,
    inbound_token: null,
    status: "connected",
    last_error_code: null,
    last_error: null,
    last_error_at: null,
    updated_at: "2026-09-01T12:00:00.000Z",
    ...over,
  };
}

function seedAccount(over = {}) {
  const a = account(over);
  world.db.mail_accounts.push(a);
  world.secrets.set(a.id, PASSWORD);
  return a;
}

function seedThread(over = {}) {
  const t = { id: randomUUID(), company_id: COMPANY, reply_token: "aaaabbbbcccc", subject: "Fence quote", ...over };
  world.db.mail_threads.push(t);
  return t;
}

function seedMessage(over = {}) {
  const m = {
    id: randomUUID(),
    company_id: COMPANY,
    account_id: null,
    thread_id: null,
    folder_role: "inbox",
    source: "imap",
    uidvalidity: 1001,
    uid: 104,
    message_id_header: "m104@example.org",
    parent_ids: ["root@example.org"],
    attachments: [],
    is_answered: false,
    client_send_id: null,
    ...over,
  };
  world.db.mail_messages.push(m);
  return m;
}

function upload(name, bytes, type = "application/pdf", uid = UID, company = COMPANY) {
  const path = `${company}/outgoing/${uid}/${randomUUID()}/${name}`;
  world.storage.set(path, { bytes, type });
  return path;
}

// ---------------------------------------------------------------------------
// A port-465 submission server. It records the envelope and the message as
// it arrived on the wire (dot-stuffed) and as meant (stuffing removed).
// `authFail` answers 535 with the password echoed in the text -- the planted
// leak redaction must catch.
// ---------------------------------------------------------------------------

function smtpServer(over = {}) {
  return {
    host: "smtppro.zoho.com", user: USER, password: PASSWORD, authFail: false, rejectRcpt: null, dropAfterData: false,
    sessions: [], accepted: [], onAccept: null,
    // Runs once the whole message has arrived, before the server answers
    // (or drops the line): what else happens in the world meanwhile.
    onData: null,
    ...over,
  };
}

class ByteQueue {
  constructor() {
    this.out = [];
    this.waiters = [];
    this.closed = false;
    this.eof = false;
  }
  wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }
  push(line) {
    this.out.push(Buffer.from(`${line}\r\n`, "latin1"));
    this.wake();
  }
  async read(p) {
    while (this.out.length === 0) {
      if (this.closed || this.eof) return null;
      await new Promise((r) => this.waiters.push(r));
    }
    const chunk = this.out[0];
    const n = Math.min(p.length, chunk.length);
    p.set(chunk.subarray(0, n));
    if (n === chunk.length) this.out.shift();
    else this.out[0] = chunk.subarray(n);
    return n;
  }
  close() {
    this.closed = true;
    this.wake();
  }
  handshake() {
    return Promise.resolve();
  }
}

class FakeSmtpConn extends ByteQueue {
  constructor(srv) {
    super();
    this.srv = srv;
    this.buf = "";
    this.mode = "cmd";
    this.session = { mailFrom: null, rcpts: [], wire: null, data: null, rset: false, commands: [] };
    srv.sessions.push(this.session);
    this.push(`220 ${srv.host} ESMTP ready`);
  }

  async write(p) {
    if (this.closed) throw new Error("write on closed socket");
    this.buf += Buffer.from(p).toString("latin1");
    for (;;) {
      if (this.mode === "data") {
        const end = this.buf.indexOf("\r\n.\r\n");
        if (end < 0) break;
        const wire = this.buf.slice(0, end + 2);
        this.buf = this.buf.slice(end + 5);
        this.mode = "cmd";
        this.session.wire = wire;
        this.session.data = wire.split("\r\n").map((l) => (l.startsWith("..") ? l.slice(1) : l)).join("\r\n");
        if (this.srv.onData) this.srv.onData(this.session);
        if (this.srv.dropAfterData) {
          this.close();
          break;
        }
        this.srv.accepted.push(this.session);
        if (this.srv.onAccept) this.srv.onAccept(this.session);
        this.push("250 2.0.0 Ok: queued as 4ZQ1");
        continue;
      }
      const i = this.buf.indexOf("\r\n");
      if (i < 0) break;
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      this.command(line);
    }
    return p.length;
  }

  command(line) {
    const srv = this.srv;
    this.session.commands.push(/^AUTH/i.test(line) ? "AUTH [hidden by the fake]" : line);
    world.timeline.push(`smtp:${line.split(" ")[0].toUpperCase()}`);
    if (/^EHLO /i.test(line)) {
      for (const l of [`250-${srv.host} Hello`, "250-AUTH PLAIN LOGIN", "250-SIZE 35882577", "250 8BITMIME"]) this.push(l);
      return;
    }
    if (/^AUTH PLAIN /i.test(line)) {
      const blob = line.slice(11);
      if (!srv.authFail && blob === b64(`\0${srv.user}\0${srv.password}`)) return this.push("235 2.7.0 Authentication successful");
      const [, u, pw] = Buffer.from(blob, "base64").toString("utf8").split("\0");
      return this.push(`535 5.7.8 Authentication failed for ${u} using ${pw}`);
    }
    const mf = /^MAIL FROM:<([^>]*)>/i.exec(line);
    if (mf) {
      this.session.mailFrom = mf[1];
      return this.push("250 2.1.0 Ok");
    }
    const rt = /^RCPT TO:<([^>]*)>/i.exec(line);
    if (rt) {
      if (srv.rejectRcpt === rt[1]) return this.push(`550 5.1.1 <${rt[1]}>: Recipient address rejected: User unknown`);
      this.session.rcpts.push(rt[1]);
      return this.push("250 2.1.5 Ok");
    }
    if (/^RSET$/i.test(line)) {
      this.session.rset = true;
      this.session.rcpts = [];
      return this.push("250 2.0.0 Ok");
    }
    if (/^DATA$/i.test(line)) {
      this.mode = "data";
      return this.push("354 End data with <CR><LF>.<CR><LF>");
    }
    if (/^QUIT$/i.test(line)) {
      this.push("221 2.0.0 Bye");
      this.eof = true;
      return this.wake();
    }
    return this.push("500 5.5.2 fake: unexpected command");
  }
}

// ---------------------------------------------------------------------------
// An IMAP mailbox model, for what happens after an SMTP send: \Answered on
// the message answered, and the Sent copy. `keepsCopies`: true files what its
// SMTP sends in Sent at once, "late" only by the Nth EXAMINE of Sent
// (lateCopyOnExamine), false never. No LITERAL+, so APPEND goes the slow way
// (wait for "+", then the literal).
// ---------------------------------------------------------------------------

function mailbox(over = {}) {
  return {
    username: USER,
    password: PASSWORD,
    keepsCopies: false,
    lateCopyOnExamine: 0,
    examinesOfSent: 0,
    pendingCopies: [],
    sessions: 0,
    log: [],
    folders: {
      INBOX: { uidValidity: 1001, messages: [{ uid: 104, flags: [], raw: "Message-ID: <m104@example.org>\r\n\r\nhi\r\n" }] },
      Sent: { uidValidity: 2002, messages: [] },
    },
    ...over,
  };
}

function fileInSent(mb, raw) {
  const f = mb.folders.Sent;
  const uid = f.messages.reduce((m, x) => Math.max(m, x.uid), 0) + 1;
  f.messages.push({ uid, flags: ["\\Seen"], raw });
  return uid;
}

function unquote(s) {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s);
  return m ? m[1].replace(/\\(.)/g, "$1") : s;
}

class FakeImapConn extends ByteQueue {
  constructor(mb) {
    super();
    this.mb = mb;
    mb.sessions++;
    this.buf = "";
    this.literal = null;
    this.pending = null;
    this.selected = null;
    this.push("* OK [CAPABILITY IMAP4rev1 UIDPLUS AUTH=PLAIN] Fake Zoho IMAP ready");
  }

  async write(p) {
    this.buf += Buffer.from(p).toString("latin1");
    for (;;) {
      if (this.literal) {
        if (this.buf.length < this.literal.n) break;
        this.pending = { prefix: this.literal.prefix, data: this.buf.slice(0, this.literal.n) };
        this.buf = this.buf.slice(this.literal.n);
        this.literal = null;
        continue;
      }
      const i = this.buf.indexOf("\r\n");
      if (i < 0) break;
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      if (this.pending) {
        const { prefix, data } = this.pending;
        this.pending = null;
        this.command(prefix + line, data);
        continue;
      }
      const lit = /\{(\d+)(\+?)\}$/.exec(line);
      if (lit) {
        this.literal = { n: Number(lit[1]), prefix: line.slice(0, lit.index).trimEnd() };
        if (!lit[2]) this.push("+ Ready for literal data");
        continue;
      }
      this.command(line, null);
    }
    return p.length;
  }

  command(line, literal) {
    const mb = this.mb;
    const sp = line.indexOf(" ");
    const tag = line.slice(0, sp);
    const rest = line.slice(sp + 1);
    const verb = rest.split(" ")[0].toUpperCase();
    mb.log.push(verb === "LOGIN" ? "LOGIN [hidden by the fake]" : rest);
    world.timeline.push(`imap:${verb}`);

    if (verb === "CAPABILITY") {
      this.push("* CAPABILITY IMAP4rev1 UIDPLUS AUTH=PLAIN");
      return this.push(`${tag} OK CAPABILITY completed`);
    }
    if (verb === "LOGIN") {
      const m = /^LOGIN ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/i.exec(rest);
      if (m && unquote(m[1]) === mb.username && unquote(m[2]) === mb.password) return this.push(`${tag} OK LOGIN completed`);
      return this.push(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
    }
    if (verb === "SELECT" || verb === "EXAMINE") {
      const name = unquote(rest.slice(verb.length + 1));
      const f = mb.folders[name];
      if (!f) return this.push(`${tag} NO [NONEXISTENT] No such folder`);
      if (name === "Sent" && verb === "EXAMINE") {
        mb.examinesOfSent++;
        if (mb.lateCopyOnExamine && mb.examinesOfSent >= mb.lateCopyOnExamine) {
          for (const raw of mb.pendingCopies.splice(0)) fileInSent(mb, raw);
        }
      }
      this.selected = f;
      const top = f.messages.reduce((m, x) => Math.max(m, x.uid), 0);
      this.push(`* ${f.messages.length} EXISTS`);
      this.push(`* OK [UIDVALIDITY ${f.uidValidity}] UIDs valid`);
      this.push(`* OK [UIDNEXT ${top + 1}] Predicted next UID`);
      return this.push(`${tag} OK [${verb === "EXAMINE" ? "READ-ONLY" : "READ-WRITE"}] ${verb} completed`);
    }
    if (verb === "UID") {
      const f = this.selected;
      if (!f) return this.push(`${tag} BAD No folder selected`);
      const search = /^UID SEARCH HEADER Message-ID ("(?:[^"\\]|\\.)*")$/i.exec(rest);
      if (search) {
        const id = unquote(search[1]).toLowerCase();
        const hits = f.messages.filter((x) => x.raw.toLowerCase().includes(`message-id: <${id}>`));
        this.push(`* SEARCH${hits.map((x) => ` ${x.uid}`).join("")}`);
        return this.push(`${tag} OK SEARCH completed`);
      }
      const store = /^UID STORE (\d+) ([+-])FLAGS\.SILENT \(([^)]*)\)$/i.exec(rest);
      if (store) {
        const msg = f.messages.find((x) => x.uid === Number(store[1]));
        if (msg) for (const fl of store[3].split(" ")) if (store[2] === "+" && !msg.flags.includes(fl)) msg.flags.push(fl);
        return this.push(`${tag} OK STORE completed`);
      }
      return this.push(`${tag} BAD fake: ${rest}`);
    }
    if (verb === "APPEND") {
      const m = /^APPEND ("(?:[^"\\]|\\.)*") \(([^)]*)\)$/i.exec(rest);
      const f = m ? mb.folders[unquote(m[1])] : null;
      if (!f || literal === null) return this.push(`${tag} NO [TRYCREATE] No such folder`);
      const uid = f.messages.reduce((mx, x) => Math.max(mx, x.uid), 0) + 1;
      f.messages.push({ uid, flags: m[2].split(" ").filter(Boolean), raw: literal, appended: true });
      return this.push(`${tag} OK [APPENDUID ${f.uidValidity} ${uid}] APPEND completed`);
    }
    if (verb === "LOGOUT") {
      this.push("* BYE Logging out");
      this.push(`${tag} OK LOGOUT completed`);
      this.eof = true;
      return this.wake();
    }
    return this.push(`${tag} BAD fake: unknown command ${verb}`);
  }
}

// ---------------------------------------------------------------------------
// Deps and the handler.
// ---------------------------------------------------------------------------

function makeDeps({ smtp = {}, imap = {}, dns = {}, fetchImpl = null } = {}) {
  const log = { dials: [], sleeps: [], background: [], fetches: [], lookups: [] };
  const deps = {
    connect: async (opts) => {
      const key = `${opts.hostname}:${opts.port}`;
      log.dials.push({ key, limits: opts.limits });
      world.timeline.push(`dial:${key}`);
      if (opts.port === 465 && smtp[opts.hostname]) return new StreamTransport(new FakeSmtpConn(smtp[opts.hostname]), opts.limits ?? {});
      if (opts.port === 993 && imap[opts.hostname]) return new StreamTransport(new FakeImapConn(imap[opts.hostname]), opts.limits ?? {});
      throw new MailError("connect_failed", "fake: nothing listens there");
    },
    resolver: async (host, type) => {
      log.lookups.push(`${host}/${type}`);
      return dns[host]?.[type] ?? [];
    },
    fetch: async (url, init) => {
      log.fetches.push({ url, headers: { ...init.headers }, body: JSON.parse(init.body) });
      world.timeline.push("fetch");
      if (fetchImpl) return await fetchImpl(url, init);
      return new Response(JSON.stringify({ id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }), { status: 200 });
    },
    now: () => NOW,
    sleep: async (ms) => {
      log.sleeps.push(ms);
    },
    env: (k) => ENV[k],
    uuid: () => randomUUID(),
    background: (work) => {
      log.background.push(work);
      return null;
    },
  };
  return { deps, log };
}

/** A Zoho mailbox and its SMTP server, wired so accepted mail lands in Sent
 *  the way `keepsCopies` says. */
function zoho({ mb = {}, srv = {}, deps = {} } = {}) {
  const box = mailbox(mb);
  const server = smtpServer({
    onAccept: (s) => {
      if (box.keepsCopies === true) fileInSent(box, s.data);
      else if (box.keepsCopies === "late") box.pendingCopies.push(s.data);
    },
    ...srv,
  });
  const made = makeDeps({ smtp: { "smtppro.zoho.com": server }, imap: { "imappro.zoho.com": box }, ...deps });
  return { box, server, ...made };
}

globalThis.Deno = { env: { get: (k) => ENV[k] } };
resetWorld();
const mod = await import("../supabase/functions/mail-send/index.ts");

const everything = [];
const logs = [];
console.error = (...a) => logs.push(a.map(String).join(" "));
console.warn = (...a) => logs.push(a.map(String).join(" "));

async function call(body, deps, { token = JWT, method = "POST", raw } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await mod.handleRequest(
    new Request("https://project.example.supabase.co/functions/v1/mail-send", {
      method,
      headers,
      body: method === "POST" ? (raw ?? JSON.stringify(body)) : undefined,
    }),
    deps,
  );
  const text = await res.text();
  everything.push(text);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // OPTIONS answers plain text.
  }
  return { status: res.status, json, text };
}

const sendBody = (from, over = {}) => ({
  client_send_id: randomUUID(),
  from_account_id: typeof from === "string" ? from : from.id,
  to: ["jane@example.org"],
  subject: "Your fence quote",
  text: "Hi Jane,\nThe quote is attached.",
  ...over,
});

const sends = () => world.db.mail_messages.filter((m) => m.source === "fenceflow_send");
const serviceKeyUsed = () => world.created.some((c) => c.key === "service-key");
const rpcsNamed = (name) => world.rpcCalls.filter((c) => c.name === name);
const settleBackground = (log) => Promise.all(log.background);
const headerOf = (raw, name) => {
  const unfolded = raw.split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ");
  const m = new RegExp(`^${name}: (.*)$`, "im").exec(unfolded);
  return m ? m[1] : null;
};

/** Nothing stored, logged or answered holds the password or the API key in
 *  any form. The Vault stand-in (world.secrets) is the one place one lives. */
function assertNothingLeaked() {
  const haystack = JSON.stringify([world.db, logs, everything]);
  for (const s of [PASSWORD, b64(PASSWORD), b64(`\0${USER}\0${PASSWORD}`), API_KEY]) {
    assert.ok(!haystack.includes(s), "a password, its base64 or the API key leaked into rows, logs or an answer");
  }
}

// ===========================================================================
// The door.
// ===========================================================================

test("door: OPTIONS answers the preflight with no token; GET is 405; no token is 401 before any client exists", async () => {
  resetWorld();
  const { deps } = makeDeps();
  const pre = await call(null, deps, { method: "OPTIONS", token: null });
  assert.equal(pre.status, 200);
  const get = await call(null, deps, { method: "GET" });
  assert.equal(get.status, 405);
  const anon = await call({ client_send_id: randomUUID(), from_account_id: "fenceflow" }, deps, { token: null });
  assert.equal(anon.status, 401);
  assert.equal(anon.json.error_code, "no_session");
  assert.deepEqual(world.created, []);
});

test("door: under Deno the module serves handleRequest itself", async () => {
  let served = null;
  globalThis.Deno.serve = (h) => {
    served = h;
  };
  try {
    await import("../supabase/functions/mail-send/index.ts?served");
  } finally {
    delete globalThis.Deno.serve;
  }
  assert.equal(typeof served, "function");
});

test("PLANTED: the gate refusing (crew, no money, suspended) is 403: no service key, nothing recorded, dialed or fetched", async () => {
  for (const gate of [{ data: false, error: null }, { data: null, error: null }, { data: "true", error: null }]) {
    resetWorld({ gate });
    ENV.MAIL_API_KEY = API_KEY;
    ENV.MAIL_FROM = MAIL_FROM_BARE;
    const acc = seedAccount();
    const { deps, log } = zoho();
    for (const from of [acc.id, "fenceflow"]) {
      const res = await call(sendBody(from), deps);
      assert.equal(res.status, 403, JSON.stringify(gate));
      assert.equal(res.json.error_code, "mail_forbidden");
    }
    assert.equal(serviceKeyUsed(), false);
    assert.deepEqual(log.dials, []);
    assert.deepEqual(log.fetches, []);
    assert.deepEqual(world.events, []);
    assert.deepEqual(sends(), []);
  }
});

// ===========================================================================
// Sending from a company mailbox.
// ===========================================================================

test("mailbox: sends as the mailbox, Bcc only in the envelope, claimed before the socket opens, recorded as sent and linked to the job", async () => {
  resetWorld();
  const acc = seedAccount();
  const { server, deps, log } = zoho();
  const body = sendBody(acc, {
    cc: ["Bob@Example.org"],
    bcc: ["partner@supplier.example.com"],
    text: "Hi Jane,\n.\nThe quote is attached.",
    job_sync_id: JOB,
  });
  const res = await call(body, deps);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual({ ok: res.json.ok, state: res.json.state }, { ok: true, state: "sent" });

  assert.equal(server.accepted.length, 1);
  const s = server.accepted[0];
  assert.equal(s.mailFrom, USER);
  assert.deepEqual(s.rcpts, ["jane@example.org", "Bob@example.org", "partner@supplier.example.com"]);
  assert.equal(headerOf(s.data, "From"), `"Acme Fence Co" <${USER}>`);
  assert.equal(headerOf(s.data, "Bcc"), null, "a Bcc header went out");
  assert.ok(!s.data.includes("partner@supplier.example.com"), "the blind copy is named inside the message");
  assert.match(headerOf(s.data, "Message-ID"), /^<[0-9a-f-]{36}@acmefence\.com>$/);
  // The lone "." line was doubled on the wire and restored by the server.
  assert.ok(s.wire.includes("\r\n..\r\n"));
  assert.ok(s.data.includes("\r\n.\r\n"));

  // The claim came before the connection, the outcome after the send.
  const t = world.timeline;
  assert.ok(t.indexOf("rpc:mail_ingest") < t.indexOf("dial:smtppro.zoho.com:465"));
  assert.ok(t.lastIndexOf("update:mail_messages") > t.indexOf("smtp:DATA"));
  assert.equal(log.dials[0].limits.sessionDeadlineMs, mod.SMTP_SEND_SESSION_MS);

  const [row] = sends();
  assert.equal(res.json.message_id, row.id);
  assert.equal(res.json.thread_id, row.thread_id);
  assert.equal(row.account_id, acc.id);
  assert.equal(row.folder_role, "sent");
  assert.equal(row.send_state, "sent");
  assert.equal(row.send_error, null);
  assert.equal(row.client_send_id, body.client_send_id);
  assert.equal(row.sent_by, UID);
  assert.equal(`<${row.message_id_header}>`, headerOf(s.data, "Message-ID"));
  assert.equal(row.body_state, "cached");
  assert.match(row.body_text, /The quote is attached/);
  assert.deepEqual(row.to_list, [{ name: "", address: "jane@example.org" }]);
  assert.ok(!row.to_text.includes("partner@"), "the blind copy is shown as a recipient");
  assert.ok(row.counterpart_emails.includes("partner@supplier.example.com"), "a blind copy to a customer would not link the job");
  assert.ok(!row.counterpart_emails.includes(USER));
  assert.deepEqual(world.db.mail_thread_jobs.map((l) => l.job_sync_id), [JOB]);
  assert.deepEqual([...world.unknownIngestKeys], [], "the claim row carries keys mail_ingest does not read");

  // One send recorded, the day counted without recording a second.
  assert.deepEqual(world.events.map((e) => e.kind), ["send_smtp"]);
  assert.equal(rpcsNamed("mail_event_count")[0].args.p_window, "1 day");
  // smtp_saves_sent is true: no IMAP session after the send.
  await settleBackground(log);
  assert.ok(!log.dials.some((d) => d.key.endsWith(":993")));
  assertNothingLeaked();
});

test("PLANTED: a sender, headers or envelope commands smuggled through the request never reach the wire", async () => {
  resetWorld();
  const acc = seedAccount({ display_name: 'Acme "Sales" <x>' });
  const { server, deps, log } = zoho();
  const res = await call(sendBody(acc, {
    from: "ceo@bank.example.com",
    headers: { "Reply-To": "thief@evil.example.com" },
    subject: "Hi\r\nBcc: spy@evil.example.com",
  }), deps);
  assert.equal(res.status, 200, res.text);
  const s = server.accepted[0];
  assert.equal(s.mailFrom, USER);
  assert.deepEqual(s.rcpts, ["jane@example.org"]);
  assert.equal(headerOf(s.data, "Bcc"), null);
  assert.equal(headerOf(s.data, "Reply-To"), null);
  assert.equal(headerOf(s.data, "Subject"), "Hi Bcc: spy@evil.example.com");
  assert.match(headerOf(s.data, "From"), /<office@acmefence\.com>$/);
  assert.ok(!/ceo@bank/.test(s.data));

  // An address carrying a line break is refused outright: nothing claimed,
  // nothing spent, nothing dialed.
  const before = log.dials.length;
  for (const to of [["jane@example.org\r\nRCPT TO:<spy@evil.example.com>"], ["Jane <jane@example.org>"], ["jane@example.org, spy@evil.example.com"]]) {
    const bad = await call(sendBody(acc, { to }), deps);
    assert.equal(bad.status, 400, JSON.stringify(to));
    assert.equal(bad.json.error_code, "bad_request");
  }
  assert.equal(log.dials.length, before);
  assert.equal(sends().length, 1);
  assert.equal(world.events.length, 1);
});

test("mailbox: a manager (not only the owner) can send; the signature goes under the text", async () => {
  resetWorld({ profile: { data: { company_id: COMPANY, role: "MANAGER" }, error: null } });
  const acc = seedAccount({ signature: "Pat at Acme\n555-0100" });
  const { server, deps } = zoho();
  const res = await call(sendBody(acc), deps);
  assert.equal(res.status, 200, res.text);
  const email = await parseMail(server.accepted[0].data);
  assert.match(email.text, /The quote is attached\.\n\n-- \nPat at Acme\n555-0100/);
  assert.match(email.html, /Pat at Acme/);
});

test("PLANTED: another company's mailbox is not found through RLS; its password is never read, nothing is spent or dialed", async () => {
  resetWorld();
  const theirs = seedAccount({ company_id: OTHER_COMPANY, email_address: "boss@rival.example.com", username: "boss@rival.example.com" });
  const { deps, log } = zoho();
  const res = await call(sendBody(theirs), deps);
  assert.equal(res.status, 404);
  assert.equal(res.json.error_code, "not_found");
  assert.deepEqual(rpcsNamed("mail_secret_get"), []);
  assert.deepEqual(log.dials, []);
  assert.deepEqual(world.events, []);
  assert.deepEqual(sends(), []);
});

test("PLANTED: answering or forwarding another company's message is 404 and sends nothing", async () => {
  resetWorld();
  const acc = seedAccount();
  const theirThread = seedThread({ company_id: OTHER_COMPANY, reply_token: "ddddeeeeffff" });
  const theirs = seedMessage({ company_id: OTHER_COMPANY, thread_id: theirThread.id, account_id: randomUUID() });
  const { server, deps } = zoho();
  for (const key of ["reply_to_message_id", "forward_of_message_id"]) {
    const res = await call(sendBody(acc, { [key]: theirs.id }), deps);
    assert.equal(res.status, 404, key);
  }
  assert.equal(server.sessions.length, 0);
  assert.deepEqual(sends(), []);
  // RLS decided, not a filter the function chose to add: the message was
  // looked up through the caller's own client and never by the service role.
  const byId = queryLog.filter((q) =>
    q.table === "mail_messages" && q.filters.some(([op, col, val]) => op === "eq" && col === "id" && val === theirs.id));
  assert.ok(byId.length >= 2, "the positive control: the lookups were logged");
  assert.deepEqual([...new Set(byId.map((q) => q.key))], ["anon-key"], "the message being answered was read with the service role");
});

test("PLANTED: one client_send_id sends at most once -- a retry, and a request that loses the race to the claim, send nothing", async () => {
  resetWorld();
  const acc = seedAccount();
  const { server, deps } = zoho();
  const body = sendBody(acc);
  const first = await call(body, deps);
  assert.equal(first.json.state, "sent");
  const again = await call(body, deps);
  assert.equal(again.status, 200);
  assert.deepEqual(
    { duplicate: again.json.duplicate, state: again.json.state, ok: again.json.ok, message_id: again.json.message_id },
    { duplicate: true, state: "sent", ok: true, message_id: first.json.message_id },
  );
  assert.equal(server.sessions.length, 1, "a second copy went to the server");
  assert.equal(world.events.length, 1, "a retry spent the rate budget");

  // Another request claims the same id between our check and our claim:
  // mail_ingest answers inserted=false, and nothing is sent.
  const racing = sendBody(acc);
  world.beforeIngest = (acct) => {
    world.beforeIngest = null;
    const t = seedThread({ reply_token: randomHex(6) });
    seedMessage({
      account_id: acct.id, thread_id: t.id, source: "fenceflow_send", folder_role: "sent", uid: null, uidvalidity: null,
      message_id_header: "other@acmefence.com", client_send_id: racing.client_send_id, send_state: "sending", send_error: null,
    });
  };
  const lost = await call(racing, deps);
  assert.equal(lost.status, 200);
  assert.equal(lost.json.duplicate, true);
  assert.equal(lost.json.state, "sending");
  assert.equal(server.sessions.length, 1);
});

test("PLANTED: past 20 an hour or 200 a day nothing is claimed or sent; a ledger answer that is not a number refuses", async () => {
  for (const [over, status, code] of [
    [{ noteAnswer: 21 }, 429, "rate_limited"],
    [{ dayAnswer: 201 }, 429, "rate_limited"],
    [{ noteAnswer: "5" }, 500, "server_error"],
    [{ noteAnswer: { not: "a number" } }, 500, "server_error"],
    [{ dayAnswer: "7" }, 500, "server_error"],
  ]) {
    resetWorld(over);
    const acc = seedAccount();
    const { deps, log } = zoho();
    const res = await call(sendBody(acc), deps);
    assert.equal(res.status, status, JSON.stringify(over));
    assert.equal(res.json.error_code, code);
    assert.deepEqual(log.dials, []);
    assert.deepEqual(sends(), []);
    assert.deepEqual(rpcsNamed("mail_secret_get"), [], "the password was read for a refused send");
  }
  // At exactly the cap the send goes through.
  resetWorld({ noteAnswer: 20, dayAnswer: 200 });
  const acc = seedAccount();
  const { deps } = zoho();
  assert.equal((await call(sendBody(acc), deps)).json.state, "sent");
});

test("PLANTED: a refused recipient means RSET, no DATA, nothing half-addressed: the row is failed and names the address", async () => {
  resetWorld();
  const acc = seedAccount();
  const { server, deps } = zoho({ srv: { rejectRcpt: "bob@example.org" } });
  const res = await call(sendBody(acc, { to: ["jane@example.org", "bob@example.org"] }), deps);
  assert.equal(res.status, 422);
  assert.equal(res.json.error_code, "recipient_rejected");
  assert.equal(res.json.state, "failed");
  const s = server.sessions[0];
  assert.equal(s.rset, true);
  assert.equal(s.data, null, "DATA was sent after a refused recipient");
  assert.ok(!s.commands.includes("DATA"));
  const [row] = sends();
  assert.equal(row.send_state, "failed");
  assert.match(row.send_error, /bob@example\.org/);
  assert.equal(world.db.mail_accounts[0].status, "connected", "a refused recipient is not the mailbox's fault");
});

test("PLANTED: a connection lost after the message went out is 'could not confirm', never 'failed', and a retry sends nothing", async () => {
  resetWorld();
  const acc = seedAccount();
  const { server, deps } = zoho({ srv: { dropAfterData: true } });
  const body = sendBody(acc);
  const res = await call(body, deps);
  assert.equal(res.status, 502);
  assert.equal(res.json.state, "sending");
  assert.equal(res.json.unconfirmed, true);
  const [row] = sends();
  assert.equal(row.send_state, "sending");
  assert.equal(row.send_error, mod.UNCONFIRMED_NOTE);
  assert.ok(server.sessions[0].data, "the message did reach the server");

  const retry = await call(body, deps);
  assert.equal(retry.json.duplicate, true);
  assert.equal(retry.json.state, "sending");
  assert.equal(retry.json.send_error, mod.UNCONFIRMED_NOTE);
  assert.equal(server.sessions.length, 1);
});

test("PLANTED: 'could not confirm' never overwrites what a sync proved meanwhile: a row already re-bound as sent stays sent, with no note", async () => {
  resetWorld();
  const acc = seedAccount();
  // While mail-send waits on a line that went quiet after the message, the
  // office's poll runs mail-sync, which finds the server's Sent copy and
  // re-binds the row as sent (mail_ingest step 2).
  const { deps } = zoho({
    srv: {
      dropAfterData: true,
      onData: () => {
        const [row] = sends();
        assert.equal(row.send_state, "sending", "the positive control: the claim was there first");
        Object.assign(row, { send_state: "sent", uidvalidity: 2002, uid: 7 });
      },
    },
  });
  const res = await call(sendBody(acc), deps);
  assert.equal(res.status, 502);
  assert.equal(res.json.unconfirmed, true);
  const [row] = sends();
  assert.equal(row.send_state, "sent", "the server's proof was overwritten");
  assert.equal(row.send_error ?? null, null, "a sent email was labelled 'could not confirm'");
});

test("PLANTED: a refused password (echoed by the server) never leaks, marks the mailbox auth_failed, and the next send is refused without dialing", async () => {
  resetWorld();
  const acc = seedAccount();
  const { deps, log } = zoho({ srv: { authFail: true } });
  const res = await call(sendBody(acc), deps);
  assert.equal(res.status, 422);
  assert.equal(res.json.error_code, "smtp_auth_failed");
  assert.equal(res.json.state, "failed");
  assert.ok(!res.text.includes(PASSWORD));
  const a = world.db.mail_accounts[0];
  assert.equal(a.status, "auth_failed");
  assert.equal(a.last_error_code, "smtp_auth_failed");
  assert.match(a.last_error, /\[redacted\]/);

  const dials = log.dials.length;
  const next = await call(sendBody(acc), deps);
  assert.equal(next.status, 422);
  assert.equal(next.json.error_code, "auth_failed");
  assert.equal(log.dials.length, dials, "a refused password was presented again");
  assert.equal(sends().length, 1);
  assertNothingLeaked();
});

test("mailbox: no stored password is auth_failed before anything is claimed; a disconnected mailbox is 404", async () => {
  resetWorld();
  const acc = seedAccount();
  world.secrets.delete(acc.id);
  const { deps, log } = zoho();
  const res = await call(sendBody(acc), deps);
  assert.equal(res.status, 422);
  assert.equal(res.json.error_code, "auth_failed");
  assert.equal(res.json.state, undefined);
  assert.deepEqual(sends(), []);
  assert.deepEqual(log.dials, []);
  assert.equal(world.db.mail_accounts[0].status, "auth_failed");

  resetWorld();
  const gone = seedAccount({ status: "disconnected" });
  const r2 = await call(sendBody(gone), zoho().deps);
  assert.equal(r2.status, 404);
});

test("PLANTED: a custom host re-pointed at a private address is refused before any socket; a public one that will not answer on 465 says so without detail", async () => {
  resetWorld();
  const acc = seedAccount({ provider: "custom", imap_host: "imap.acme-fence-mail.com", smtp_host: "smtp.acme-fence-mail.com" });
  const priv = makeDeps({ dns: { "imap.acme-fence-mail.com": { A: ["52.10.20.30"] }, "smtp.acme-fence-mail.com": { A: ["10.0.0.5"] } } });
  const res = await call(sendBody(acc), priv.deps);
  assert.equal(res.status, 422);
  assert.equal(res.json.error_code, "host_not_allowed");
  assert.deepEqual(priv.log.dials, []);
  assert.deepEqual(sends(), []);
  assert.deepEqual(rpcsNamed("mail_secret_get"), [], "the password was read for a host that is refused");

  // A preset row whose host was tampered with is refused the same way.
  resetWorld();
  const tampered = seedAccount({ smtp_host: "smtp.evil.example.com" });
  const t = zoho();
  const r2 = await call(sendBody(tampered), t.deps);
  assert.equal(r2.json.error_code, "host_not_allowed");
  assert.deepEqual(t.log.dials, []);
  assert.deepEqual(rpcsNamed("mail_secret_get"), [], "the password was read for a host that is refused");

  // Positive control: public addresses pass the check and the socket is tried.
  resetWorld();
  const pubAcc = seedAccount({ provider: "custom", imap_host: "imap.acme-fence-mail.com", smtp_host: "smtp.acme-fence-mail.com" });
  const pub = makeDeps({ dns: { "imap.acme-fence-mail.com": { A: ["52.10.20.30"] }, "smtp.acme-fence-mail.com": { A: ["52.10.20.31"] } } });
  const r3 = await call(sendBody(pubAcc), pub.deps);
  assert.deepEqual(pub.log.dials.map((d) => d.key), ["smtp.acme-fence-mail.com:465"]);
  assert.equal(r3.json.error_code, "smtp_587_only");
  assert.equal(r3.json.detail, undefined, "a custom host's reachability leaked detail");
  assert.equal(r3.json.state, "failed");
});

// ===========================================================================
// Attachments.
// ===========================================================================

test("attachments: an upload of the caller's own goes out and the sent row points at the same object", async () => {
  resetWorld();
  const acc = seedAccount();
  const pdf = new Uint8Array(Buffer.from("%PDF-1.4 quote for 12 Oak St\n"));
  const path = upload("Quote 12 Oak St.pdf", pdf);
  const { server, deps } = zoho();
  const res = await call(sendBody(acc, { attachment_paths: [path] }), deps);
  assert.equal(res.status, 200, res.text);
  const email = await parseMail(server.accepted[0].data);
  assert.equal(email.attachments.length, 1);
  assert.equal(email.attachments[0].filename, "Quote 12 Oak St.pdf");
  assert.deepEqual(new Uint8Array(email.attachments[0].content), pdf);
  const [row] = sends();
  assert.equal(row.has_attachments, true);
  assert.deepEqual(row.attachments, [{
    idx: 0, filename: "Quote 12 Oak St.pdf", content_type: "application/pdf", size: pdf.length, content_id: null,
    disposition: "attachment", storage_path: path, state: "stored",
  }]);
  assert.ok(world.downloads.every((d) => d.key === "service-key" && d.bucket === "mail-files"));
});

test("PLANTED: a colleague's upload, another company's file, an inbox file or a crafted path is refused before any download", async () => {
  resetWorld();
  const acc = seedAccount();
  const folder = randomUUID();
  const bytes = new Uint8Array([1, 2, 3]);
  const candidates = [
    upload("theirs.pdf", bytes, "application/pdf", COLLEAGUE),
    upload("rival.pdf", bytes, "application/pdf", UID, OTHER_COMPANY),
    `${COMPANY}/${acc.id}/${randomUUID()}/0-invoice.pdf`,
    `${COMPANY}/outgoing/${UID}/${folder}`,
    `${COMPANY}/outgoing/${UID}/${folder}/../../x.pdf`,
    `${COMPANY}/outgoing/${UID}/${folder}/..`,
    `${COMPANY}/outgoing/${UID}/not-a-uuid/x.pdf`,
    `${COMPANY}/outgoing/${UID}/${folder}/a\\b.pdf`,
    `/${COMPANY}/outgoing/${UID}/${folder}/x.pdf`,
    `${COMPANY}//outgoing/${UID}/${folder}/x.pdf`,
    `${COMPANY}/outgoing/${UID}/${folder}/x.pdf/more`,
    `${COMPANY}/inbox/${UID}/${folder}/x.pdf`,
  ];
  const { deps, log } = zoho();
  for (const p of candidates) {
    const res = await call(sendBody(acc, { attachment_paths: [p] }), deps);
    assert.equal(res.status, 400, p);
    assert.equal(res.json.error_code, "bad_request", p);
  }
  assert.deepEqual(world.downloads, []);
  assert.deepEqual(sends(), []);
  assert.deepEqual(world.events, []);
  assert.deepEqual(log.dials, []);
});

test("attachments: more than 5, the same file twice, over 10 MB together, or a missing object are refused before the claim", async () => {
  resetWorld();
  const acc = seedAccount();
  const { deps, log } = zoho();
  const small = () => upload(`f${randomHex(2)}.pdf`, new Uint8Array(10));
  let res = await call(sendBody(acc, { attachment_paths: [small(), small(), small(), small(), small(), small()] }), deps);
  assert.equal(res.status, 400);
  const one = small();
  res = await call(sendBody(acc, { attachment_paths: [one, one] }), deps);
  assert.equal(res.status, 400);
  const big = () => upload(`big${randomHex(2)}.bin`, new Uint8Array(6 * 1024 * 1024), "application/octet-stream");
  res = await call(sendBody(acc, { attachment_paths: [big(), big()] }), deps);
  assert.equal(res.status, 413);
  assert.equal(res.json.error_code, "too_large");
  res = await call(sendBody(acc, { attachment_paths: [`${COMPANY}/outgoing/${UID}/${randomUUID()}/never-uploaded.pdf`] }), deps);
  assert.equal(res.status, 400);
  assert.deepEqual(sends(), []);
  assert.deepEqual(log.dials, []);
});

test("forward: a stored attachment of the forwarded message goes along; References but no In-Reply-To; a tampered or unstored one is refused", async () => {
  resetWorld();
  const acc = seedAccount();
  const thread = seedThread();
  const storedPath = `${COMPANY}/${acc.id}/${randomUUID()}/0-quote.pdf`;
  world.storage.set(storedPath, { bytes: new Uint8Array(Buffer.from("%PDF quote")), type: "application/pdf" });
  const parent = seedMessage({
    account_id: acc.id,
    thread_id: thread.id,
    attachments: [
      { idx: 0, filename: "quote.pdf", content_type: "application/pdf", size: 10, storage_path: storedPath, state: "stored" },
      { idx: 1, filename: "huge.mov", content_type: "video/quicktime", size: 50e6, storage_path: null, state: "too_large" },
      { idx: 2, filename: "rival.pdf", content_type: "application/pdf", size: 3, storage_path: `${OTHER_COMPANY}/x/y/0-rival.pdf`, state: "stored" },
    ],
  });
  world.storage.set(`${OTHER_COMPANY}/x/y/0-rival.pdf`, { bytes: new Uint8Array([9]), type: "application/pdf" });
  const { server, deps } = zoho();
  const res = await call(sendBody(acc, { forward_of_message_id: parent.id, forward_attachment_idx: [0], subject: "Fwd: Fence quote" }), deps);
  assert.equal(res.status, 200, res.text);
  const s = server.accepted[0];
  assert.equal(headerOf(s.data, "In-Reply-To"), null);
  assert.equal(headerOf(s.data, "References"), "<root@example.org> <m104@example.org>");
  const email = await parseMail(s.data);
  assert.equal(email.attachments[0].filename, "quote.pdf");
  const [row] = sends();
  assert.equal(row.thread_id, thread.id, "the forward left the conversation it came from");
  assert.equal(row.attachments[0].storage_path, storedPath);

  for (const idx of [1, 2, 7]) {
    const bad = await call(sendBody(acc, { forward_of_message_id: parent.id, forward_attachment_idx: [idx] }), deps);
    assert.equal(bad.status, 400, String(idx));
  }
  assert.ok(!world.downloads.some((d) => d.path.startsWith(OTHER_COMPANY)), "another company's object was read");
  const orphan = await call(sendBody(acc, { forward_attachment_idx: [0] }), deps);
  assert.equal(orphan.status, 400);
});

// ===========================================================================
// Replies, \Answered and the Sent copy.
// ===========================================================================

test("reply: threads under the parent, marks it answered on the server, and APPENDs a Sent copy only after a second look", async () => {
  resetWorld();
  const acc = seedAccount({ smtp_saves_sent: null });
  world.db.mail_folder_state.push({ account_id: acc.id, role: "inbox", path: "INBOX" });
  const thread = seedThread();
  const parent = seedMessage({ account_id: acc.id, thread_id: thread.id });
  const { box, server, deps, log } = zoho();
  const res = await call(sendBody(acc, { reply_to_message_id: parent.id, subject: "Re: Fence quote", job_sync_id: JOB }), deps);
  assert.equal(res.status, 200, res.text);
  const s = server.accepted[0];
  assert.equal(headerOf(s.data, "In-Reply-To"), "<m104@example.org>");
  assert.equal(headerOf(s.data, "References"), "<root@example.org> <m104@example.org>");
  const [row] = sends();
  assert.equal(row.thread_id, thread.id);
  assert.equal(row.parent_ids[0], "m104@example.org");

  await settleBackground(log);
  assert.deepEqual(log.sleeps, [mod.SENT_COPY_FIRST_WAIT_MS, mod.SENT_COPY_SECOND_WAIT_MS]);
  const mid = row.message_id_header;
  assert.deepEqual(box.log, [
    "LOGIN [hidden by the fake]",
    'SELECT "INBOX"',
    "UID STORE 104 +FLAGS.SILENT (\\Answered)",
    'EXAMINE "Sent"',
    `UID SEARCH HEADER Message-ID "${mid}"`,
    'EXAMINE "Sent"',
    `UID SEARCH HEADER Message-ID "${mid}"`,
    'APPEND "Sent" (\\Seen)',
    "LOGOUT",
  ]);
  assert.deepEqual(box.folders.INBOX.messages[0].flags, ["\\Answered"]);
  assert.equal(world.db.mail_messages.find((m) => m.id === parent.id).is_answered, true);
  assert.equal(box.folders.Sent.messages.length, 1);
  assert.equal(box.folders.Sent.messages[0].raw, s.data, "the Sent copy is not the message that was sent");
  assert.equal(world.db.mail_accounts[0].smtp_saves_sent, false);
  assert.equal(log.dials.find((d) => d.key === "imappro.zoho.com:993").limits.sessionDeadlineMs, mod.SENT_COPY_SESSION_MS);
  assertNothingLeaked();
});

test("reply: a message that lives in a different mailbox is not flagged through this one", async () => {
  resetWorld();
  const acc = seedAccount();
  const other = seedAccount({ email_address: "sales@acmefence.com", username: "sales@acmefence.com" });
  const thread = seedThread();
  const parent = seedMessage({ account_id: other.id, thread_id: thread.id });
  const { box, deps, log } = zoho();
  const res = await call(sendBody(acc, { reply_to_message_id: parent.id }), deps);
  assert.equal(res.json.state, "sent", res.text);
  await settleBackground(log);
  assert.ok(!log.dials.some((d) => d.key.endsWith(":993")), "signed in to IMAP for another mailbox's flag");
  assert.deepEqual(box.folders.INBOX.messages[0].flags, []);
  assert.equal(world.db.mail_messages.find((m) => m.id === parent.id).is_answered, false);

  // A customer's reply that came in as FenceFlow mail lives only in
  // FenceFlow, so answering it from a mailbox marks it there.
  const ff = account({ kind: "fenceflow", provider: "resend", email_address: MAIL_FROM_BARE, username: null, imap_host: null, smtp_host: null, imap_port: null, smtp_port: null, inbound_token: INBOUND_TOKEN });
  world.db.mail_accounts.push(ff);
  const inbound = seedMessage({ account_id: ff.id, thread_id: thread.id, source: "resend_inbound", uid: null, uidvalidity: null, message_id_header: "cust2@example.org", parent_ids: [] });
  const r2 = await call(sendBody(acc, { reply_to_message_id: inbound.id }), deps);
  assert.equal(r2.json.state, "sent", r2.text);
  await settleBackground(log);
  assert.equal(world.db.mail_messages.find((m) => m.id === inbound.id).is_answered, true);
  assert.ok(!log.dials.some((d) => d.key.endsWith(":993")), "signed in to IMAP for a message that is not in the mailbox");
});

test("PLANTED: a server that keeps its own copy never gets a second one APPENDed -- found at once, or on the second look", async () => {
  for (const [keepsCopies, lateCopyOnExamine, sleeps] of [
    [true, 0, [mod.SENT_COPY_FIRST_WAIT_MS]],
    ["late", 2, [mod.SENT_COPY_FIRST_WAIT_MS, mod.SENT_COPY_SECOND_WAIT_MS]],
  ]) {
    resetWorld();
    const acc = seedAccount({ smtp_saves_sent: null });
    const { box, deps, log } = zoho({ mb: { keepsCopies, lateCopyOnExamine } });
    const res = await call(sendBody(acc), deps);
    assert.equal(res.json.state, "sent");
    await settleBackground(log);
    assert.deepEqual(log.sleeps, sleeps, String(keepsCopies));
    assert.equal(box.folders.Sent.messages.length, 1, `${keepsCopies}: a duplicate landed in Sent`);
    assert.ok(!box.folders.Sent.messages.some((m) => m.appended), `${keepsCopies}: FenceFlow appended a copy`);
    assert.equal(world.db.mail_accounts[0].smtp_saves_sent, true);
  }
});

test("sent copy: a server known not to keep copies is appended to without waiting, and corrected if it turns out it does", async () => {
  resetWorld();
  const acc = seedAccount({ smtp_saves_sent: false });
  const { box, deps, log } = zoho();
  await call(sendBody(acc), deps);
  await settleBackground(log);
  assert.deepEqual(log.sleeps, []);
  assert.equal(box.folders.Sent.messages.filter((m) => m.appended).length, 1);
  assert.equal(world.db.mail_accounts[0].smtp_saves_sent, false);

  resetWorld();
  const acc2 = seedAccount({ smtp_saves_sent: false });
  const z = zoho({ mb: { keepsCopies: true } });
  await call(sendBody(acc2), z.deps);
  await settleBackground(z.log);
  assert.equal(z.box.folders.Sent.messages.length, 1);
  assert.equal(world.db.mail_accounts[0].smtp_saves_sent, true);

  // The owner disconnects the mailbox while the step after sending runs, and
  // Vault has already forgotten the password the IMAP sign-in presents: the
  // refusal is logged by code, and never revives the mailbox as auth_failed.
  resetWorld();
  const acc3 = seedAccount({ smtp_saves_sent: null });
  const z3 = zoho({
    mb: { password: "rotated-by-the-owner" },
    srv: { onData: () => Object.assign(world.db.mail_accounts[0], { status: "disconnected" }) },
  });
  const r3 = await call(sendBody(acc3), z3.deps);
  assert.equal(r3.json.state, "sent", r3.text);
  await settleBackground(z3.log);
  assert.ok(z3.box.log.includes("LOGIN [hidden by the fake]"), "the positive control: the IMAP sign-in was tried and refused");
  assert.equal(world.db.mail_accounts[0].status, "disconnected", "a disconnected mailbox came back as auth_failed");
  assert.equal(world.db.mail_accounts[0].last_error_code, null);

  // Gmail files its own copies: no IMAP session at all.
  resetWorld();
  const gmail = seedAccount({ provider: "gmail", email_address: "acme.fence@gmail.com", username: "acme.fence@gmail.com", imap_host: "imap.gmail.com", smtp_host: "smtp.gmail.com", smtp_saves_sent: null });
  const g = makeDeps({ smtp: { "smtp.gmail.com": smtpServer({ host: "smtp.gmail.com", user: "acme.fence@gmail.com" }) } });
  const r = await call(sendBody(gmail), g.deps);
  assert.equal(r.json.state, "sent", r.text);
  await settleBackground(g.log);
  assert.deepEqual(g.log.dials.map((d) => d.key), ["smtp.gmail.com:465"]);
});

// ===========================================================================
// FenceFlow mail (Resend).
// ===========================================================================

function fenceflowEnv(over = {}) {
  Object.assign(ENV, { MAIL_API_KEY: API_KEY, MAIL_FROM: `FenceFlow <${MAIL_FROM_BARE}>`, ...over });
}

test("fenceflow: not configured, or nowhere for replies to go, is refused before anything is recorded, spent or fetched", async () => {
  resetWorld();
  const { deps, log } = makeDeps();
  let res = await call(sendBody("fenceflow"), deps);
  assert.equal(res.status, 503);
  assert.equal(res.json.error_code, "not_configured");

  resetWorld({ company: { data: { name: "Acme Fence Co", email: "  " }, error: null } });
  fenceflowEnv();
  res = await call(sendBody("fenceflow"), deps);
  assert.equal(res.status, 400);
  assert.match(res.json.detail, /business email/);
  assert.deepEqual(log.fetches, []);
  assert.deepEqual(world.events, []);
  assert.deepEqual(sends(), []);
  assert.deepEqual(world.db.mail_accounts, [], "a FenceFlow-mail account was created for a refused send");
});

test("fenceflow: sends as the company's name on MAIL_FROM's address, replies to the company email, Bcc in Resend's field, keyed for idempotency", async () => {
  resetWorld();
  fenceflowEnv();
  const { deps, log } = makeDeps();
  const body = sendBody("fenceflow", { cc: ["bob@example.org"], bcc: ["partner@supplier.example.com"], job_sync_id: JOB });
  const res = await call(body, deps);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.state, "sent");
  assert.equal(log.fetches.length, 1);
  const f = log.fetches[0];
  assert.equal(f.url, "https://api.resend.com/emails");
  assert.equal(f.headers.Authorization, `Bearer ${API_KEY}`);
  const [row] = sends();
  assert.equal(f.headers["Idempotency-Key"], `fenceflow-mail-${row.id}`);
  assert.equal(f.body.from, `"Acme Fence Co" <${MAIL_FROM_BARE}>`);
  assert.deepEqual(f.body.to, ["jane@example.org"]);
  assert.deepEqual(f.body.cc, ["bob@example.org"]);
  assert.deepEqual(f.body.bcc, ["partner@supplier.example.com"]);
  assert.equal(f.body.reply_to, "office@acmefence.com");
  assert.match(f.body.headers["Message-ID"], /^<[0-9a-f-]{36}@send\.fenceflowapp\.com>$/);
  assert.ok(!Object.keys(f.body.headers).some((h) => /bcc/i.test(h)));
  assert.match(f.body.text, /Sent by Acme Fence Co using FenceFlow/);

  const ff = world.db.mail_accounts.find((a) => a.kind === "fenceflow");
  assert.equal(row.account_id, ff.id);
  assert.equal(ff.email_address, MAIL_FROM_BARE);
  assert.equal(row.send_state, "sent");
  assert.equal(row.provider_message_id, "4ef9a417-02e9-4d39-ad75-9611e0fcc33c");
  assert.deepEqual(row.reply_to_list, [{ name: "", address: "office@acmefence.com" }]);
  assert.equal(`<${row.message_id_header}>`, f.body.headers["Message-ID"]);
  assert.deepEqual(world.events.map((e) => e.kind), ["send_resend"]);
  assert.deepEqual(world.db.mail_thread_jobs.map((l) => l.job_sync_id), [JOB]);
  assert.deepEqual([...world.unknownIngestKeys], []);

  // At most 10 recipients this way (20 through a mailbox), refused before
  // anything is recorded or spent.
  const many = Array.from({ length: 11 }, (_, i) => `c${i}@example.org`);
  const over = await call(sendBody("fenceflow", { to: many }), deps);
  assert.equal(over.status, 400);
  assert.match(over.json.detail, /At most 10 recipients/);
  assert.equal(log.fetches.length, 1);
  assert.equal(sends().length, 1);
  assert.equal(world.events.length, 1, "a send refused for its recipients spent the rate budget");
  assertNothingLeaked();
});

test("PLANTED: FenceFlow mail sends one client_send_id at most once -- a retry, and a request that loses the race to the claim, fetch nothing", async () => {
  resetWorld();
  fenceflowEnv();
  const { deps, log } = makeDeps();
  const body = sendBody("fenceflow");
  const first = await call(body, deps);
  assert.equal(first.json.state, "sent", first.text);
  const again = await call(body, deps);
  assert.equal(again.status, 200);
  assert.deepEqual(
    { duplicate: again.json.duplicate, state: again.json.state, ok: again.json.ok, message_id: again.json.message_id },
    { duplicate: true, state: "sent", ok: true, message_id: first.json.message_id },
  );
  assert.equal(log.fetches.length, 1, "a second copy went to Resend");
  assert.equal(world.events.length, 1, "a retry spent the rate budget");

  // Another request claims the same id between our check and our claim.
  const racing = sendBody("fenceflow");
  world.beforeIngest = (acct) => {
    world.beforeIngest = null;
    const t = seedThread({ reply_token: randomHex(6) });
    seedMessage({
      account_id: acct.id, thread_id: t.id, source: "fenceflow_send", folder_role: "sent", uid: null, uidvalidity: null,
      message_id_header: "other@send.fenceflowapp.com", client_send_id: racing.client_send_id, send_state: "sending", send_error: null,
    });
  };
  const lost = await call(racing, deps);
  assert.equal(lost.status, 200, lost.text);
  assert.equal(lost.json.duplicate, true);
  assert.equal(lost.json.state, "sending");
  assert.equal(log.fetches.length, 1, "the request that lost the race still called Resend");
});

test("fenceflow: once receiving is proven, replies route back through the new thread's own token", async () => {
  resetWorld();
  fenceflowEnv({ MAIL_INBOUND_DOMAIN: "reply.fenceflowapp.com", RESEND_WEBHOOK_SECRET: "whsec_fake", RESEND_RECEIVING_KEY: "re_fake_receiving" });
  world.db.mail_platform_settings[0].inbound_verified_at = "2026-09-20T10:00:00.000Z";
  const { deps, log } = makeDeps();
  const res = await call(sendBody("fenceflow"), deps);
  assert.equal(res.status, 200, res.text);
  const [row] = sends();
  const thread = world.db.mail_threads.find((t) => t.id === row.thread_id);
  const expected = `${INBOUND_TOKEN}.${thread.reply_token}@reply.fenceflowapp.com`;
  assert.equal(log.fetches[0].body.reply_to, expected);
  assert.deepEqual(row.reply_to_list, [{ name: "", address: expected }]);
  assert.ok(!row.counterpart_emails.some((c) => c.endsWith("@reply.fenceflowapp.com")));

  // Verified but a receiving secret missing: back to the company email.
  resetWorld();
  fenceflowEnv({ MAIL_INBOUND_DOMAIN: "reply.fenceflowapp.com", RESEND_WEBHOOK_SECRET: "whsec_fake" });
  world.db.mail_platform_settings[0].inbound_verified_at = "2026-09-20T10:00:00.000Z";
  const d2 = makeDeps();
  await call(sendBody("fenceflow"), d2.deps);
  assert.equal(d2.log.fetches[0].body.reply_to, "office@acmefence.com");

  // Everything configured but no signed webhook has proven it yet: the
  // company email, never an address nothing is listening on.
  resetWorld();
  fenceflowEnv({ MAIL_INBOUND_DOMAIN: "reply.fenceflowapp.com", RESEND_WEBHOOK_SECRET: "whsec_fake", RESEND_RECEIVING_KEY: "re_fake_receiving" });
  const d3 = makeDeps();
  await call(sendBody("fenceflow"), d3.deps);
  assert.equal(d3.log.fetches[0].body.reply_to, "office@acmefence.com");
});

test("fenceflow: a reply keeps the parent's thread and marks an inbound parent answered", async () => {
  resetWorld();
  fenceflowEnv();
  const ff = account({ kind: "fenceflow", provider: "resend", email_address: MAIL_FROM_BARE, username: null, imap_host: null, smtp_host: null, imap_port: null, smtp_port: null, inbound_token: INBOUND_TOKEN });
  world.db.mail_accounts.push(ff);
  const thread = seedThread();
  const parent = seedMessage({ account_id: ff.id, thread_id: thread.id, source: "resend_inbound", uid: null, uidvalidity: null, message_id_header: "cust1@example.org", parent_ids: [] });
  const { deps, log } = makeDeps();
  const res = await call(sendBody("fenceflow", { reply_to_message_id: parent.id, subject: "Re: Fence quote" }), deps);
  assert.equal(res.status, 200, res.text);
  assert.equal(log.fetches[0].body.headers["In-Reply-To"], "<cust1@example.org>");
  const [row] = sends();
  assert.equal(row.thread_id, thread.id);
  assert.equal(world.db.mail_messages.find((m) => m.id === parent.id).is_answered, true);

  // A parent with no Message-ID at all still keeps the reply in its thread:
  // the claim names the thread's reply_token.
  const bare = seedThread({ reply_token: "0123456789ab" });
  const noId = seedMessage({ account_id: ff.id, thread_id: bare.id, source: "resend_inbound", uid: null, uidvalidity: null, message_id_header: null, parent_ids: [] });
  const r2 = await call(sendBody("fenceflow", { reply_to_message_id: noId.id }), deps);
  assert.equal(r2.status, 200, r2.text);
  assert.equal(log.fetches[1].body.headers["In-Reply-To"], undefined);
  assert.equal(sends().find((m) => m.id === r2.json.message_id).thread_id, bare.id);
});

test("PLANTED: Resend's 5xx, a timeout or a 409 are 'could not confirm'; a 4xx is 'failed'; the key is never in an answer or a log", async () => {
  const cases = [
    [() => new Response(JSON.stringify({ message: "Internal error" }), { status: 500 }), 502, "sending"],
    [() => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    }, 502, "sending"],
    [() => new Response(JSON.stringify({ message: "concurrent idempotent requests" }), { status: 409 }), 502, "sending"],
    [() => new Response(JSON.stringify({ message: "The to field must contain valid addresses." }), { status: 422 }), 422, "failed"],
    // A refusal whose text echoes the key: shown to the sender and stored on
    // the row, so it must come out redacted.
    [() => new Response(JSON.stringify({ message: `Invalid request for key ${API_KEY}` }), { status: 422 }), 422, "failed"],
    [() => new Response(JSON.stringify({ message: `API key ${API_KEY} is invalid` }), { status: 401 }), 503, "failed"],
    [() => new Response("rate limited", { status: 429 }), 429, "failed"],
  ];
  for (const [fetchImpl, status, state] of cases) {
    resetWorld();
    fenceflowEnv();
    const { deps } = makeDeps({ fetchImpl });
    const body = sendBody("fenceflow");
    const res = await call(body, deps);
    assert.equal(res.status, status, res.text);
    assert.equal(res.json.state, state, res.text);
    const [row] = sends();
    assert.equal(row.send_state, state);
    if (state === "sending") {
      assert.equal(res.json.unconfirmed, true);
      assert.equal(row.send_error, mod.UNCONFIRMED_NOTE);
    }
    // Whatever happened, the same client_send_id never sends again.
    const again = await call(body, deps);
    assert.equal(again.json.duplicate, true);
    // Checked per case: the next resetWorld() drops this case's rows.
    assertNothingLeaked();
  }
  assertNothingLeaked();
});

// ===========================================================================
// What the real handler writes, for replaying against supabase_mail.sql in a
// rolled-back transaction (the fake above plays mail_ingest's contract; this
// checks the real one takes the same rows and patches).
// ===========================================================================

test("capture writes for the SQL contract check (only when MAIL_SEND_CAPTURE is set)", { skip: !process.env.MAIL_SEND_CAPTURE && "MAIL_SEND_CAPTURE not set" }, async () => {
  const { writeFileSync } = await import("node:fs");
  const cases = [];
  const record = (name, mark, extra = {}) => {
    const log = queryLog.slice(mark);
    cases.push({
      name,
      rpcCalls: clone(world.rpcCalls),
      writes: log.filter((q) => q.key === "service-key" && q.op === "update"),
      reads: log.filter((q) => q.op === "select" && q.table.startsWith("mail_")),
      // The fake's row ids, so the replay can find the real row by the
      // client_send_id the claim carried.
      messages: world.db.mail_messages.map((m) => ({ id: m.id, client_send_id: m.client_send_id ?? null })),
      accounts: world.db.mail_accounts.map((a) => ({ id: a.id, kind: a.kind })),
      ...extra,
    });
  };

  // A mailbox reply with Cc, Bcc, an upload and a job, from a mailbox whose
  // server has not yet shown whether it keeps copies (and does not).
  resetWorld();
  let mark = queryLog.length;
  const acc = seedAccount({ smtp_saves_sent: null });
  world.db.mail_folder_state.push({ account_id: acc.id, role: "inbox", path: "INBOX" });
  const thread = seedThread();
  const parent = seedMessage({ account_id: acc.id, thread_id: thread.id });
  const path = upload("Quote 12 Oak St.pdf", new Uint8Array(Buffer.from("%PDF-1.4 quote")));
  const z = zoho();
  const r1 = await call(sendBody(acc, {
    reply_to_message_id: parent.id, cc: ["Bob@Example.org"], bcc: ["partner@supplier.example.com"],
    attachment_paths: [path], job_sync_id: JOB, subject: "Re: Fence quote",
  }), z.deps);
  assert.equal(r1.json.state, "sent", r1.text);
  await settleBackground(z.log);
  record("mailbox_reply", mark, { parent: { id: parent.id, message_id_header: parent.message_id_header, reply_token: thread.reply_token } });

  // Refused recipient: failed.
  resetWorld();
  mark = queryLog.length;
  const acc2 = seedAccount();
  const r2 = await call(sendBody(acc2, { to: ["jane@example.org", "bob@example.org"] }), zoho({ srv: { rejectRcpt: "bob@example.org" } }).deps);
  assert.equal(r2.json.state, "failed", r2.text);
  record("refused_recipient", mark);

  // Line lost after the message: could not confirm.
  resetWorld();
  mark = queryLog.length;
  const acc3 = seedAccount();
  const r3 = await call(sendBody(acc3), zoho({ srv: { dropAfterData: true } }).deps);
  assert.equal(r3.json.state, "sending", r3.text);
  record("unconfirmed", mark);

  // Refused password: the account patch.
  resetWorld();
  mark = queryLog.length;
  const acc4 = seedAccount();
  const r4 = await call(sendBody(acc4), zoho({ srv: { authFail: true } }).deps);
  assert.equal(r4.json.error_code, "smtp_auth_failed", r4.text);
  record("auth_failed", mark);

  // FenceFlow mail with receiving proven, a brand-new thread.
  resetWorld();
  mark = queryLog.length;
  fenceflowEnv({ MAIL_INBOUND_DOMAIN: "reply.fenceflowapp.com", RESEND_WEBHOOK_SECRET: "whsec_fake", RESEND_RECEIVING_KEY: "re_fake_receiving" });
  world.db.mail_platform_settings[0].inbound_verified_at = "2026-09-20T10:00:00.000Z";
  const r5 = await call(sendBody("fenceflow", { cc: ["bob@example.org"], job_sync_id: JOB }), makeDeps().deps);
  assert.equal(r5.json.state, "sent", r5.text);
  record("fenceflow_inbound", mark);

  writeFileSync(process.env.MAIL_SEND_CAPTURE, JSON.stringify({
    ids: { company: COMPANY, uid: UID, job: JOB, inbound_token: INBOUND_TOKEN, mail_from: MAIL_FROM_BARE },
    unconfirmed_note: mod.UNCONFIRMED_NOTE,
    cases,
  }, null, 1));
});

test("final sweep: across every test, no password, SASL blob or API key reached a row, a log line or an answer", () => {
  assertNothingLeaked();
  assert.ok(everything.length > 50, "the sweep saw too little to mean anything");
});

test("PLANTED final sweep: every query on a company table, by either client, named the caller's own company", () => {
  // The service role bypasses RLS, so its filter is the only wall; the
  // caller's client keeps one too, so a loosened policy is not a leak.
  const scoped = queryLog.filter((q) => ["mail_messages", "mail_accounts", "mail_threads"].includes(q.table));
  const keys = new Set(scoped.map((q) => q.key));
  assert.ok(scoped.length > 100 && keys.has("anon-key") && keys.has("service-key"), "the sweep saw too little to mean anything");
  const unscoped = scoped.filter((q) => !q.filters.some(([op, col, val]) => op === "eq" && col === "company_id" && val === COMPANY));
  assert.deepEqual(unscoped, [], "a query ran without the caller's company");

  // The check itself has teeth: a query without the filter is caught.
  const planted = [...scoped, { key: "service-key", table: "mail_messages", op: "select", filters: [["eq", "id", randomUUID()]] }];
  assert.equal(planted.filter((q) => !q.filters.some(([op, col, val]) => op === "eq" && col === "company_id" && val === COMPANY)).length, 1);
});
