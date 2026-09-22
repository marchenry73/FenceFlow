// mail-connect, the whole function, run under Node the way the office calls
// it. No network, no Deno, no live Supabase, no real mailbox, and no real
// password anywhere: every password here is made up, every server is a
// script this file wrote.
//
// Run with:  node --test tests/mail-connect.test.mjs
//
// What is real and what is fake:
//
//  - REAL: supabase/functions/mail-connect/index.ts, unmodified, and every
//    shared module under it -- caller.ts (the gate), hosts.ts (the SSRF
//    rules), the IMAP and SMTP clients, StreamTransport, errors.redact().
//  - FAKE: the three things Node does not have. `Deno` is a global whose
//    serve() captures the handler, whose connectTls() hands out scripted
//    mail servers by host:port, and whose resolveDns() answers from a table.
//    supabase-js (esm.sh) is swapped by a module hook for an in-memory
//    database that plays RLS for the caller's client (own company, and only
//    while the gate says true), refuses every service-only call from it, and
//    enforces the partial unique index and the three-mailbox cap the way the
//    SQL trigger does.
//
// Tests marked PLANTED are the ones whose failure would mean a security
// property is gone: a manager connecting a mailbox, a wrong password
// reaching the SMTP server as a second strike, a server's echo of the
// password reaching the office, a custom host pointing inside, another
// company's mailbox having its password read.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";

// ---------------------------------------------------------------------------
// Made-up credentials. Each is 16 characters, shaped like an app password.
// ---------------------------------------------------------------------------

const PASSWORD = "k7Qp2mX9vR4tZw8L";
const WRONG = "Wr0ngPassw0rdXyZ";
const STORED = "Zq8vN3pL5tR2wX7c";
const NEWPW = "N3wAppPassw0rdQq";
const ALL_SECRETS = [PASSWORD, WRONG, STORED, NEWPW];
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

const USER = "owner@acmefence.com";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJl";
const UID = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY = "99999999-9999-4999-8999-999999999999";

// ---------------------------------------------------------------------------
// The fake supabase-js.
// ---------------------------------------------------------------------------

const SUPABASE_JS = "https://esm.sh/@supabase/supabase-js@2.39.0";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === SUPABASE_JS) {
      const src = "export const createClient = (...a) => globalThis.__mailTestCreateClient(...a);";
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

// Same column check as mail_accounts.email_address and the host columns.
const SQL_EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SQL_HOST_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SERVICE_ONLY_TABLES = new Set(["mail_folder_state", "mail_platform_settings", "audit_log", "mail_account_secrets"]);

let world;

function resetWorld(over = {}) {
  for (const k of Object.keys(ENV)) delete ENV[k];
  Object.assign(ENV, BASE_ENV);
  world = {
    created: [],
    rpcCalls: [],
    seq: [],
    dials: [],
    lookups: [],
    conns: [],
    servers: {},
    dns: {},
    attempts: 0,
    noteAnswer: undefined,
    failSecretPut: false,
    secrets: new Map(),
    user: { data: { user: { id: UID } }, error: null },
    gate: { data: true, error: null },
    profile: { data: { company_id: COMPANY, role: "OWNER" }, error: null },
    company: { data: { name: " Acme Fence Co ", email: " office@acmefence.com " }, error: null },
    db: {
      mail_accounts: [],
      mail_folder_state: [],
      audit_log: [],
      mail_platform_settings: [{ id: 1, inbound_verified_at: null }],
    },
    ...over,
  };
}

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
    smtp_saves_sent: null,
    inbound_token: null,
    status: "connected",
    last_error_code: null,
    last_error: null,
    last_error_at: null,
    last_synced_at: null,
    sync_lock_until: null,
    connected_by: UID,
    connected_at: "2026-09-01T12:00:00.000Z",
    disconnected_by: null,
    disconnected_at: null,
    updated_at: "2026-09-01T12:00:00.000Z",
    ...over,
  };
}

function seed(row) {
  world.db.mail_accounts.push(row);
  return row;
}

const matches = (row, filters) =>
  filters.every(([op, col, val]) => (op === "eq" ? row[col] === val : row[col] !== val));

/** The mail_accounts trigger and indexes, as far as this function can hit them. */
function accountConflict(row, old) {
  if (!SQL_EMAIL_RE.test(row.email_address ?? "")) return "23514";
  for (const h of [row.imap_host, row.smtp_host]) if (h != null && !SQL_HOST_RE.test(h)) return "23514";
  if (row.kind !== "imap" || row.status === "disconnected") return null;
  const others = world.db.mail_accounts.filter((r) =>
    r.id !== row.id && r.company_id === row.company_id && r.kind === "imap" && r.status !== "disconnected"
  );
  if (others.some((r) => r.email_address === row.email_address)) return "23505";
  if ((!old || old.status === "disconnected") && others.length >= 3) return "23514";
  return null;
}

function execute(key, table, st) {
  world.seq.push(`${st.op}:${table}`);
  const asUser = key === "anon-key";
  const denied = { data: null, error: { code: "42501", message: "permission denied" } };

  if (table === "profiles" || table === "companies") {
    if (!asUser) return denied;
    return table === "profiles" ? world.profile : world.company;
  }
  if (asUser && (st.op !== "select" || SERVICE_ONLY_TABLES.has(table))) return denied;
  const rows = world.db[table];
  if (!rows) return { data: null, error: { code: "42P01", message: `no table ${table}` } };

  // RLS on mail_accounts for the caller's own client: own company, and only
  // while the gate says exactly true.
  const visible = (r) =>
    !asUser || (table === "mail_accounts" && r.company_id === world.profile.data?.company_id && world.gate.data === true);

  let out;
  if (st.op === "select") {
    out = rows.filter(visible).filter((r) => matches(r, st.filters));
    if (st.order) {
      const [col, asc] = st.order;
      out = [...out].sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * (asc ? 1 : -1));
    }
  } else if (st.op === "insert") {
    const row = {
      id: randomUUID(),
      status: "connected",
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...st.payload,
    };
    if (table === "mail_accounts") {
      row.email_address = String(row.email_address).toLowerCase();
      const c = accountConflict(row, null);
      if (c) return { data: null, error: { code: c, message: "violates" } };
    }
    rows.push(row);
    out = [row];
  } else if (st.op === "update") {
    out = [];
    for (const r of rows.filter((x) => matches(x, st.filters))) {
      const next = { ...r, ...st.payload, updated_at: new Date().toISOString() };
      if (table === "mail_accounts") {
        const c = accountConflict(next, r);
        if (c) return { data: null, error: { code: c, message: "violates" } };
      }
      Object.assign(r, next);
      out.push(r);
    }
  } else if (st.op === "delete") {
    out = rows.filter((x) => matches(x, st.filters));
    world.db[table] = rows.filter((x) => !out.includes(x));
    if (table === "mail_accounts") for (const r of out) world.secrets.delete(r.id);
  }

  if (st.cols && st.cols !== "*") {
    const cols = st.cols.split(",").map((c) => c.trim());
    out = out.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
  } else {
    out = out.map((r) => ({ ...r }));
  }
  if (st.single === "maybe") {
    if (out.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
    return { data: out[0] ?? null, error: null };
  }
  if (st.single === "one") {
    if (out.length !== 1) return { data: null, error: { code: "PGRST116", message: "not one row" } };
    return { data: out[0], error: null };
  }
  return { data: st.op === "select" || st.returning ? out : null, error: null };
}

function query(key, table) {
  const st = { op: "select", cols: "*", filters: [], order: null, payload: null, returning: false, single: null };
  const run = () => Promise.resolve().then(() => execute(key, table, st));
  const q = {
    select(cols = "*") {
      if (st.op !== "select") st.returning = true;
      st.cols = cols;
      return q;
    },
    insert(obj) {
      st.op = "insert";
      st.payload = obj;
      return q;
    },
    update(obj) {
      st.op = "update";
      st.payload = obj;
      return q;
    },
    delete() {
      st.op = "delete";
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
    order(col, opts) {
      st.order = [col, opts?.ascending !== false];
      return q;
    },
    maybeSingle() {
      st.single = "maybe";
      return run();
    },
    single() {
      st.single = "one";
      return run();
    },
    then(resolve, reject) {
      return run().then(resolve, reject);
    },
  };
  return q;
}

function rpc(key, name, args = {}) {
  world.rpcCalls.push({ name, key, args });
  world.seq.push(`rpc:${name}`);
  if (name === "can_use_company_mail") return key === "anon-key" ? world.gate : { data: false, error: null };
  if (key !== "service-key") return { data: null, error: { code: "42501", message: "Service role only" } };
  switch (name) {
    case "note_mail_event":
      world.attempts++;
      return { data: world.noteAnswer ?? world.attempts, error: null };
    case "mail_secret_put":
      if (world.failSecretPut) return { data: null, error: { code: "XX000", message: "Could not store the app password (XX000)" } };
      if (!world.db.mail_accounts.some((r) => r.id === args.p_account && r.kind === "imap")) {
        return { data: null, error: { code: "P0002", message: "Unknown mail account" } };
      }
      world.secrets.set(args.p_account, args.p_secret);
      return { data: null, error: null };
    case "mail_secret_get":
      return { data: world.secrets.get(args.p_account) ?? null, error: null };
    case "mail_secret_forget":
      return { data: world.secrets.delete(args.p_account), error: null };
    case "mail_fenceflow_account": {
      let row = world.db.mail_accounts.find((r) => r.company_id === args.p_company && r.kind === "fenceflow");
      if (!row) {
        row = account({
          company_id: args.p_company,
          kind: "fenceflow",
          provider: "resend",
          email_address: args.p_email,
          username: null,
          imap_host: null,
          smtp_host: null,
          imap_port: null,
          smtp_port: null,
          sent_folder: null,
          inbound_token: "a1b2c3d4e5f60718",
        });
        world.db.mail_accounts.push(row);
      }
      return { data: row.id, error: null };
    }
    default:
      return { data: null, error: { code: "PGRST202", message: `no function ${name}` } };
  }
}

globalThis.__mailTestCreateClient = (url, key, options) => {
  const auth = options?.global?.headers?.Authorization ?? null;
  world.created.push({ key, auth });
  return {
    auth: {
      getUser: async (jwt) =>
        jwt === JWT && key === "anon-key" ? world.user : { data: { user: null }, error: { message: "invalid JWT" } },
      admin: {
        getUserById: async (id) =>
          key === "service-key" && id === UID
            ? { data: { user: { id, email: USER } }, error: null }
            : { data: { user: null }, error: { message: "not allowed" } },
      },
    },
    rpc: async (name, args) => rpc(key, name, args),
    from: (table) => query(key, table),
  };
};

// ---------------------------------------------------------------------------
// Scripted mail servers. A ByteConn (read/write/close/handshake) that plays:
//   { s: "line" } or { s: ["a", "b"] }  server sends line(s); "<tag>" is the
//                                        tag of the last IMAP command
//   { c: "text" } or { c: /regex/ }      client must send this line (IMAP:
//                                        compared without its tag)
//   { run: fn }                          something else happens meanwhile
//                                        (the owner disconnects, say)
// Anything unexpected gets a BYE / 421 and a closed socket, so a broken
// script fails fast instead of waiting out a timeout.
// ---------------------------------------------------------------------------

class ScriptConn {
  constructor(steps, { imap = false } = {}) {
    this.steps = steps;
    this.pos = 0;
    this.imap = imap;
    this.tag = "*";
    this.out = [];
    this.inBuf = Buffer.alloc(0);
    this.lines = [];
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
    while (this.pos < this.steps.length && (this.steps[this.pos].s !== undefined || this.steps[this.pos].run)) {
      const step = this.steps[this.pos++];
      if (step.run) {
        step.run();
        continue;
      }
      const s = step.s;
      for (const line of Array.isArray(s) ? s : [s]) {
        this.out.push(Buffer.from(`${line.replaceAll("<tag>", this.tag)}\r\n`, "utf8"));
      }
      this.wake();
    }
  }

  fail(expected, got) {
    this.mismatches.push({ expected: String(expected), got });
    this.pos = this.steps.length;
    this.out.push(Buffer.from(this.imap ? "* BYE fake server: unexpected command\r\n" : "421 fake server: unexpected command\r\n"));
    this.wake();
  }

  consume() {
    for (;;) {
      const idx = this.inBuf.indexOf("\r\n");
      if (idx < 0) return;
      const line = this.inBuf.subarray(0, idx).toString("latin1");
      this.inBuf = this.inBuf.subarray(idx + 2);
      this.lines.push(line);
      const step = this.steps[this.pos];
      if (!step || step.c === undefined) return this.fail("(end of script)", line);
      let body = line;
      if (this.imap) {
        const m = /^(\S+) (.*)$/.exec(line);
        if (m) {
          this.tag = m[1];
          body = m[2];
        }
      }
      const ok = step.c instanceof RegExp ? step.c.test(body) : body === step.c;
      if (!ok) return this.fail(step.c, line);
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
    this.inBuf = Buffer.concat([this.inBuf, Buffer.from(p)]);
    this.consume();
    return p.length;
  }

  close() {
    this.closed = true;
    this.wake();
  }

  handshake() {
    return Promise.resolve();
  }
}

/** A Zoho-shaped IMAP server. `login: "fail"` refuses, echoing the password
 *  back in its text -- the planted leak redaction must catch. */
function imapServer({ user = USER, password = PASSWORD, login = "ok", sent = "Sent", onLogin = null } = {}) {
  const steps = [
    { s: "* OK Zoho Mail IMAP4rev1 Server Ready" },
    { c: "CAPABILITY" },
    { s: ["* CAPABILITY IMAP4rev1 IDLE NAMESPACE UIDPLUS CHILDREN SPECIAL-USE ID AUTH=PLAIN", "<tag> OK CAPABILITY completed"] },
    { c: `LOGIN "${user}" "${password}"` },
  ];
  if (login === "fail") {
    steps.push({ s: `<tag> NO [AUTHENTICATIONFAILED] Invalid credentials for ${user} with ${password}` });
    return () => new ScriptConn(steps, { imap: true });
  }
  steps.push(
    { s: "<tag> OK LOGIN completed" },
    ...(onLogin ? [{ run: onLogin }] : []),
    { c: 'LIST "" "*"' },
    {
      s: [
        '* LIST (\\HasNoChildren) "/" "INBOX"',
        '* LIST (\\HasNoChildren \\Drafts) "/" "Drafts"',
        ...(sent ? [`* LIST (\\HasNoChildren \\Sent) "/" "${sent}"`] : []),
        '* LIST (\\HasNoChildren \\Trash) "/" "Trash"',
        "<tag> OK LIST completed",
      ],
    },
    { c: 'EXAMINE "INBOX"' },
    {
      s: [
        "* 3 EXISTS",
        "* 0 RECENT",
        "* OK [UIDVALIDITY 1729000001] UIDs valid",
        "* OK [UIDNEXT 4104] Predicted next UID",
        "<tag> OK [READ-ONLY] EXAMINE completed",
      ],
    },
    { c: "LOGOUT" },
    { s: ["* BYE Zoho Mail IMAP server logging out", "<tag> OK LOGOUT completed"] },
  );
  return () => new ScriptConn(steps, { imap: true });
}

/** A port-465 submission server. `auth: "fail"` answers 535 with the
 *  password echoed in the text. */
function smtpServer({ host = "smtppro.zoho.com", user = USER, password = PASSWORD, auth = "ok" } = {}) {
  const steps = [
    { s: `220 ${host} ESMTP ready` },
    { c: "EHLO fenceflowapp.com" },
    { s: [`250-${host} Hello fenceflowapp.com`, "250-AUTH LOGIN PLAIN", "250 SIZE 53477376"] },
    { c: `AUTH PLAIN ${b64(`\0${user}\0${password}`)}` },
  ];
  if (auth === "fail") steps.push({ s: `535 Authentication Failed: ${password} is not valid` });
  else steps.push({ s: "235 Authentication Successful" }, { c: "QUIT" }, { s: "221 bye" });
  return () => new ScriptConn(steps);
}

function zohoServers(opts = {}) {
  world.servers["imappro.zoho.com:993"] = imapServer(opts);
  world.servers["smtppro.zoho.com:465"] = smtpServer(opts);
}

// ---------------------------------------------------------------------------
// Deno, and the handler.
// ---------------------------------------------------------------------------

let served = null;
globalThis.Deno = {
  env: { get: (k) => ENV[k] },
  serve: (h) => {
    served = h;
  },
  connectTls: async ({ hostname, port }) => {
    world.dials.push(`${hostname}:${port}`);
    const make = world.servers[`${hostname}:${port}`];
    if (!make) {
      const e = new Error("Connection refused (os error 111)");
      e.name = "ConnectionRefused";
      throw e;
    }
    const conn = make();
    world.conns.push(conn);
    return conn;
  },
  resolveDns: async (host, type) => {
    world.lookups.push(`${host}/${type}`);
    const rec = world.dns[host];
    if (!rec || !rec[type]) {
      const e = new Error(`no ${type} record`);
      e.name = "NotFound";
      throw e;
    }
    return rec[type];
  },
};

resetWorld();
const mod = await import("../supabase/functions/mail-connect/index.ts");

// Everything any response or log line ever said, for the final sweep.
const everything = [];
const logs = [];
console.error = (...a) => logs.push(a.map(String).join(" "));
console.warn = (...a) => logs.push(a.map(String).join(" "));

async function call(body, { token = JWT, method = "POST", raw } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await served(
    new Request("https://project.example.supabase.co/functions/v1/mail-connect", {
      method,
      headers,
      body: method === "POST" ? (raw ?? JSON.stringify(body)) : undefined,
    }),
  );
  const text = await res.text();
  everything.push(text);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // OPTIONS answers plain text.
  }
  return { status: res.status, json, text, headers: res.headers };
}

const serviceKeyUsed = () => world.created.some((c) => c.key === "service-key");
const rpcNames = () => world.rpcCalls.map((c) => c.name);
const rpcsNamed = (name) => world.rpcCalls.filter((c) => c.name === name);
const myAccounts = () => world.db.mail_accounts.filter((r) => r.company_id === COMPANY && r.kind === "imap");

/** No stored row, audit entry or log line holds any password. The Vault
 *  stand-in (world.secrets) is the one place one may live. */
function assertNothingLeaked(extra = []) {
  const haystack = JSON.stringify([world.db, logs, ...extra]);
  for (const s of ALL_SECRETS) {
    for (const form of [s, b64(s)]) assert.ok(!haystack.includes(form), `a password (or its base64) leaked into stored rows or logs`);
  }
}

function assertScriptsClean() {
  for (const c of world.conns) assert.deepEqual(c.mismatches, [], "a fake server saw a command it did not expect");
}

const PUBLIC_KEYS = [
  "id", "kind", "provider", "email_address", "display_name", "signature", "imap_host", "smtp_host", "imap_port",
  "smtp_port", "sent_folder", "status", "last_error_code", "last_error", "last_error_at", "last_synced_at",
  "connected_at", "updated_at",
].sort();

// ===========================================================================
// The door.
// ===========================================================================

test("door: Deno.serve is wired to the exported handler", () => {
  assert.equal(typeof served, "function");
  assert.equal(served, mod.handle);
});

test("door: OPTIONS answers the CORS preflight with no token; GET is 405; no token is 401 before any client", async () => {
  resetWorld();
  const pre = await call(null, { method: "OPTIONS", token: null });
  assert.equal(pre.status, 200);
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /authorization/);
  const get = await call(null, { method: "GET" });
  assert.equal(get.status, 405);
  const anon = await call({ action: "status" }, { token: null });
  assert.equal(anon.status, 401);
  assert.equal(anon.json.error_code, "no_session");
  assert.deepEqual(world.created, [], "a client was built for a request with no token");
});

test("PLANTED: the gate refusing (crew, no money, suspended) is 403 and the service key is never used", async () => {
  for (const gate of [{ data: false, error: null }, { data: null, error: null }, { data: "true", error: null }]) {
    resetWorld({ gate });
    zohoServers();
    const res = await call({ action: "connect", provider: "zoho", email: USER, password: PASSWORD });
    assert.equal(res.status, 403, JSON.stringify(gate));
    assert.equal(res.json.error_code, "mail_forbidden");
    assert.equal(serviceKeyUsed(), false);
    assert.deepEqual(world.dials, []);
    assert.equal(world.secrets.size, 0);
  }
});

test("PLANTED: a manager cannot connect, check, replace, disconnect or rename -- owner_only, nothing spent, nothing dialed", async () => {
  resetWorld({ profile: { data: { company_id: COMPANY, role: "MANAGER" }, error: null } });
  const row = seed(account());
  world.secrets.set(row.id, STORED);
  zohoServers();
  for (const body of [
    { action: "connect", provider: "zoho", email: USER, password: PASSWORD },
    { action: "check", account_id: row.id },
    { action: "replace_password", account_id: row.id, password: NEWPW },
    { action: "disconnect", account_id: row.id },
    { action: "set_display", account_id: row.id, display_name: "Hijack" },
  ]) {
    const res = await call(body);
    assert.equal(res.status, 403, body.action);
    assert.equal(res.json.error_code, "owner_only", body.action);
  }
  assert.deepEqual(world.dials, []);
  assert.equal(world.attempts, 0);
  assert.equal(world.secrets.get(row.id), STORED);
  assert.equal(myAccounts()[0].status, "connected");
  assert.equal(myAccounts()[0].display_name, null);
  assert.deepEqual(rpcsNamed("mail_secret_get"), []);
});

// ===========================================================================
// status
// ===========================================================================

test("status: a manager sees the company's live mailboxes, nothing secret, and cannot manage", async () => {
  resetWorld({ profile: { data: { company_id: COMPANY, role: "MANAGER" }, error: null } });
  const live = seed(account({ status: "auth_failed", last_error_code: "auth_failed", last_error: "Invalid credentials" }));
  seed(account({ email_address: "old@acmefence.com", username: "old@acmefence.com", status: "disconnected" }));
  seed(account({ company_id: OTHER_COMPANY, email_address: "boss@rival.example.com", username: "boss@rival.example.com" }));
  const ff = seed(account({
    kind: "fenceflow", provider: "resend", email_address: "noreply@send.fenceflowapp.com", username: null,
    imap_host: null, smtp_host: null, imap_port: null, smtp_port: null, sent_folder: null, inbound_token: "0123456789abcdef",
  }));
  const res = await call({ action: "status" });
  assert.equal(res.status, 200);
  assert.equal(res.json.can_manage, false);
  assert.equal(res.json.max_accounts, 3);
  assert.deepEqual(res.json.accounts.map((a) => a.id), [live.id]);
  assert.deepEqual(Object.keys(res.json.accounts[0]).sort(), PUBLIC_KEYS);
  assert.equal(res.json.accounts[0].status, "auth_failed");
  assert.ok(!res.text.includes("0123456789abcdef"), "inbound_token handed to the office");
  assert.ok(!res.text.includes("boss@rival"), "another company's mailbox listed");
  assert.equal(res.json.fenceflow.account_id, ff.id);
  // No MAIL_API_KEY: FenceFlow mail is not offered at all.
  assert.equal(res.json.fenceflow.send_available, false);
  assert.equal(res.json.fenceflow.reply_to_preview, null);
  assert.equal(res.json.fenceflow.needs_company_email, false);
  assert.deepEqual(res.json.providers.zoho_regions, ["us"]);
  assert.equal(res.json.providers.custom, true);
  assert.deepEqual(world.dials, []);
  assert.equal(world.attempts, 0, "a status read spent a connect attempt");
});

test("status: FenceFlow mail sends as the company, replies go to the company email, or nowhere when it is blank", async () => {
  resetWorld();
  Object.assign(ENV, { MAIL_API_KEY: "re_test_key", MAIL_FROM: "FenceFlow <noreply@send.fenceflowapp.com>" });
  let res = await call({ action: "status" });
  assert.equal(res.json.can_manage, true);
  assert.equal(res.json.fenceflow.send_available, true);
  assert.equal(res.json.fenceflow.from_name, "Acme Fence Co");
  assert.equal(res.json.fenceflow.from_address, "noreply@send.fenceflowapp.com");
  assert.equal(res.json.fenceflow.reply_mode, "company_email");
  assert.equal(res.json.fenceflow.reply_to_preview, "office@acmefence.com");
  assert.equal(res.json.fenceflow.needs_company_email, false);

  resetWorld({ company: { data: { name: "Acme Fence Co", email: "" }, error: null } });
  Object.assign(ENV, { MAIL_API_KEY: "re_test_key", MAIL_FROM: "noreply@send.fenceflowapp.com" });
  res = await call({ action: "status" });
  assert.equal(res.json.fenceflow.reply_mode, "unavailable");
  assert.equal(res.json.fenceflow.reply_to_preview, null);
  assert.equal(res.json.fenceflow.needs_company_email, true);

  // A MAIL_FROM with no real address in it is not "configured".
  resetWorld();
  Object.assign(ENV, { MAIL_API_KEY: "re_test_key", MAIL_FROM: "FenceFlow" });
  res = await call({ action: "status" });
  assert.equal(res.json.fenceflow.send_available, false);
});

test("PLANTED: replies switch to the inbound address only once a signed webhook has proven it -- env alone is not enough", async () => {
  const inboundEnv = {
    MAIL_API_KEY: "re_test_key",
    MAIL_FROM: "FenceFlow <noreply@send.fenceflowapp.com>",
    MAIL_INBOUND_DOMAIN: "reply.fenceflowapp.com",
    RESEND_WEBHOOK_SECRET: "whsec_dGVzdA==",
    RESEND_RECEIVING_KEY: "re_receiving",
  };
  resetWorld();
  Object.assign(ENV, inboundEnv);
  let res = await call({ action: "status" });
  assert.equal(res.json.fenceflow.inbound_ready, false);
  assert.equal(res.json.fenceflow.reply_mode, "company_email");
  assert.deepEqual(rpcsNamed("mail_fenceflow_account"), [], "a row was made for a preview that does not need one");

  resetWorld();
  Object.assign(ENV, inboundEnv);
  world.db.mail_platform_settings[0].inbound_verified_at = "2026-09-20T10:00:00Z";
  res = await call({ action: "status" });
  assert.equal(res.json.fenceflow.inbound_ready, true);
  assert.equal(res.json.fenceflow.reply_mode, "inbound");
  assert.equal(res.json.fenceflow.reply_to_preview, "a1b2c3d4e5f60718@reply.fenceflowapp.com");
  const made = rpcsNamed("mail_fenceflow_account");
  assert.equal(made.length, 1);
  assert.equal(made[0].key, "service-key");
  assert.deepEqual(made[0].args, { p_company: COMPANY, p_email: "noreply@send.fenceflowapp.com" });
  assert.equal(res.json.fenceflow.account_id, world.db.mail_accounts.find((r) => r.kind === "fenceflow").id);

  // Verified once, but the receiving key has since been removed: not ready.
  delete ENV.RESEND_RECEIVING_KEY;
  res = await call({ action: "status" });
  assert.equal(res.json.fenceflow.inbound_ready, false);
  assert.equal(res.json.fenceflow.reply_mode, "company_email");
});

// ===========================================================================
// connect
// ===========================================================================

test("connect: Zoho, the way the office calls it -- verified on both servers, stored once in Vault, audited", async () => {
  resetWorld();
  zohoServers();
  const res = await call({ action: "connect", provider: "zoho", zoho_region: "us", email: " Owner@AcmeFence.com ", password: ` ${PASSWORD}\n`, display_name: "Acme Fence" });
  assert.equal(res.status, 200, res.text);
  assertScriptsClean();
  assert.deepEqual(world.dials, ["imappro.zoho.com:993", "smtppro.zoho.com:465"]);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.sent_folder_found, true);
  assert.deepEqual(Object.keys(res.json.account).sort(), PUBLIC_KEYS);
  assert.equal(res.json.account.email_address, USER);
  assert.equal(res.json.account.status, "connected");

  const rows = myAccounts();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.id, res.json.account.id);
  assert.equal(row.provider, "zoho");
  assert.equal(row.username, USER);
  assert.equal(row.imap_host, "imappro.zoho.com");
  assert.equal(row.smtp_host, "smtppro.zoho.com");
  assert.equal(row.imap_port, 993);
  assert.equal(row.smtp_port, 465);
  assert.equal(row.sent_folder, "Sent");
  assert.equal(row.display_name, "Acme Fence");
  assert.equal(row.smtp_saves_sent, null);
  assert.equal(row.connected_by, UID);

  // Stored exactly once, by the service role, trimmed of the paste's space and newline.
  const puts = rpcsNamed("mail_secret_put");
  assert.equal(puts.length, 1);
  assert.equal(puts[0].key, "service-key");
  assert.deepEqual(puts[0].args, { p_account: row.id, p_secret: PASSWORD });
  assert.equal(world.secrets.get(row.id), PASSWORD);
  // One attempt from the ledger, spent before the first connection.
  assert.equal(world.attempts, 1);
  assert.deepEqual(rpcsNamed("note_mail_event")[0].args, { p_company: COMPANY, p_actor: UID, p_kind: "connect_attempt", p_window: "1 hour" });
  // The row went live only after the password was in Vault.
  const s = world.seq;
  assert.ok(s.indexOf("insert:mail_accounts") < s.indexOf("rpc:mail_secret_put"));
  assert.ok(s.indexOf("rpc:mail_secret_put") < s.lastIndexOf("update:mail_accounts"));
  // Audited, in set_mail_access's shape, without the password.
  assert.equal(world.db.audit_log.length, 1);
  assert.deepEqual(
    (({ company_id, actor, actor_email, table_name, record_id, action, field, old_value, new_value, label }) =>
      ({ company_id, actor, actor_email, table_name, record_id, action, field, old_value, new_value, label }))(world.db.audit_log[0]),
    {
      company_id: COMPANY, actor: UID, actor_email: USER, table_name: "mail_accounts", record_id: row.id,
      action: "insert", field: "status", old_value: null, new_value: "connected", label: USER,
    },
  );
  assertNothingLeaked();
});

test("connect: Gmail uses Google's fixed hosts, and is known to keep its own Sent copies", async () => {
  resetWorld();
  const gmail = "owner@gmail.com";
  world.servers["imap.gmail.com:993"] = imapServer({ user: gmail, sent: "[Gmail]/Sent Mail" });
  world.servers["smtp.gmail.com:465"] = smtpServer({ host: "smtp.gmail.com", user: gmail });
  // Hosts in the request are ignored for a preset.
  const res = await call({ action: "connect", provider: "gmail", email: gmail, password: PASSWORD, imap_host: "evil.example.net", smtp_host: "evil.example.net" });
  assert.equal(res.status, 200, res.text);
  assertScriptsClean();
  assert.deepEqual(world.dials, ["imap.gmail.com:993", "smtp.gmail.com:465"]);
  assert.deepEqual(world.lookups, [], "a preset cost a DNS lookup");
  const row = myAccounts()[0];
  assert.equal(row.sent_folder, "[Gmail]/Sent Mail");
  assert.equal(row.smtp_saves_sent, true);
});

test("PLANTED: a wrong app password is presented once -- IMAP refuses, SMTP never sees it, the echo is redacted, nothing is stored", async () => {
  resetWorld();
  world.servers["imappro.zoho.com:993"] = imapServer({ password: WRONG, login: "fail" });
  world.servers["smtppro.zoho.com:465"] = smtpServer({ password: WRONG });
  const res = await call({ action: "connect", provider: "zoho", email: USER, password: WRONG });
  assert.equal(res.status, 422);
  assert.equal(res.json.error_code, "auth_failed");
  assert.ok(!res.text.includes(WRONG), "the server's echo of the password reached the office");
  assert.ok(!res.text.includes(b64(WRONG)));
  assert.match(res.json.detail ?? "", /\[redacted\]/);
  assert.deepEqual(world.dials, ["imappro.zoho.com:993"], "SMTP was handed a password IMAP had refused");
  assert.equal(myAccounts().length, 0);
  assert.deepEqual(rpcsNamed("mail_secret_put"), []);
  assert.equal(world.db.audit_log.length, 0);
  assertNothingLeaked();
});

test("connect: IMAP accepts but SMTP refuses -- smtp_auth_failed, redacted, nothing stored", async () => {
  resetWorld();
  world.servers["imappro.zoho.com:993"] = imapServer();
  world.servers["smtppro.zoho.com:465"] = smtpServer({ auth: "fail" });
  const res = await call({ action: "connect", provider: "zoho", email: USER, password: PASSWORD });
  assert.equal(res.status, 422);
  assert.equal(res.json.error_code, "smtp_auth_failed");
  assert.ok(!res.text.includes(PASSWORD));
  assert.equal(myAccounts().length, 0);
  assert.equal(world.secrets.size, 0);
  assertNothingLeaked();
});

test("connect: over the hourly budget is 429 before any DNS lookup or connection", async () => {
  resetWorld({ noteAnswer: 11 });
  zohoServers();
  const res = await call({ action: "connect", provider: "zoho", email: USER, password: PASSWORD });
  assert.equal(res.status, 429);
  assert.equal(res.json.error_code, "rate_limited");
  assert.deepEqual(world.dials, []);
  // Exactly at the limit is still allowed.
  resetWorld({ noteAnswer: 10 });
  zohoServers();
  assert.equal((await call({ action: "connect", provider: "zoho", email: USER, password: PASSWORD })).status, 200);
  // A ledger that answers nothing refuses: an empty answer is not "under the limit".
  resetWorld({ noteAnswer: null });
  world.noteAnswer = null;
  zohoServers();
  const origRpc = globalThis.__mailTestCreateClient;
  globalThis.__mailTestCreateClient = (url, key, options) => {
    const c = origRpc(url, key, options);
    const inner = c.rpc;
    c.rpc = async (name, args) => (name === "note_mail_event" ? { data: null, error: null } : inner(name, args));
    return c;
  };
  try {
    const res2 = await call({ action: "connect", provider: "zoho", email: USER, password: PASSWORD });
    assert.equal(res2.status, 500);
    assert.deepEqual(world.dials, []);
  } finally {
    globalThis.__mailTestCreateClient = origRpc;
  }
});

test("connect: a fourth mailbox is refused before an attempt is spent; the same address again is a reconnect", async () => {
  resetWorld();
  const mine = seed(account());
  world.secrets.set(mine.id, STORED);
  seed(account({ email_address: "sales@acmefence.com", username: "sales@acmefence.com" }));
  seed(account({ email_address: "billing@acmefence.com", username: "billing@acmefence.com" }));
  zohoServers({ user: "new@acmefence.com" });
  const res = await call({ action: "connect", provider: "zoho", email: "new@acmefence.com", password: PASSWORD });
  assert.equal(res.status, 400);
  assert.match(res.json.detail, /at most 3 mailboxes/);
  assert.equal(world.attempts, 0);
  assert.deepEqual(world.dials, []);

  // The owner's own address, already one of the three, with a new password.
  zohoServers();
  const again = await call({ action: "connect", provider: "zoho", email: USER, password: PASSWORD });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.account.id, mine.id);
  assert.equal(myAccounts().length, 3);
  assert.equal(world.secrets.get(mine.id), PASSWORD);
  assert.equal(world.db.audit_log[0].action, "update");
});

test("PLANTED: custom hosts that point inside, or at Microsoft, are refused before any connection", async () => {
  const cases = [
    { dns: { "imap.acme-hosting.net": { A: ["10.0.0.5"] } }, code: "host_not_allowed" },
    { dns: { "imap.acme-hosting.net": { A: ["93.184.216.34"], AAAA: ["::1"] } }, code: "host_not_allowed" },
    { dns: { "imap.acme-hosting.net": { AAAA: ["::ffff:169.254.169.254"] } }, code: "host_not_allowed" },
    { imap: "169.254.169.254", code: "host_not_allowed" },
    { imap: "mail.internal", code: "host_not_allowed" },
    { imap: "imap.acme-hosting.net:25", code: "host_not_allowed" },
    { imap: "outlook.office365.com", code: "microsoft_oauth_only" },
    { email: "owner@hotmail.com", code: "microsoft_oauth_only" },
  ];
  for (const c of cases) {
    resetWorld();
    world.dns = { "smtp.acme-hosting.net": { A: ["93.184.216.35"] }, ...(c.dns ?? {}) };
    world.servers["imap.acme-hosting.net:993"] = imapServer();
    world.servers["smtp.acme-hosting.net:465"] = smtpServer();
    const res = await call({
      action: "connect",
      provider: "custom",
      email: c.email ?? USER,
      password: PASSWORD,
      imap_host: c.imap ?? "imap.acme-hosting.net",
      smtp_host: "smtp.acme-hosting.net",
    });
    assert.equal(res.status, 422, JSON.stringify(c));
    assert.equal(res.json.error_code, c.code, JSON.stringify(c));
    assert.deepEqual(world.dials, [], `connected for ${JSON.stringify(c)}`);
    assert.equal(myAccounts().length, 0);
  }
});

test("connect: an unreachable custom host is one detail-free answer, so the form cannot map open ports", async () => {
  resetWorld();
  world.dns = { "imap.acme-hosting.net": { A: ["93.184.216.34"] }, "smtp.acme-hosting.net": { A: ["93.184.216.35"] } };
  // No server at all: connection refused.
  let res = await call({ action: "connect", provider: "custom", email: USER, password: PASSWORD, imap_host: "imap.acme-hosting.net", smtp_host: "smtp.acme-hosting.net" });
  assert.equal(res.status, 502);
  assert.equal(res.json.error_code, "tls_failed");
  assert.equal(res.json.detail, undefined, "server detail about an owner-typed host was returned");

  // IMAP answers, SMTP is not there: the 465-only message, still no detail.
  resetWorld();
  world.dns = { "imap.acme-hosting.net": { A: ["93.184.216.34"] }, "smtp.acme-hosting.net": { A: ["93.184.216.35"] } };
  world.servers["imap.acme-hosting.net:993"] = imapServer();
  res = await call({ action: "connect", provider: "custom", email: USER, password: PASSWORD, imap_host: "imap.acme-hosting.net", smtp_host: "smtp.acme-hosting.net" });
  assert.equal(res.json.error_code, "smtp_587_only");
  assert.equal(res.json.detail, undefined);
  assert.equal(myAccounts().length, 0);

  // Reachable and working: saved as custom, with the typed names.
  resetWorld();
  world.dns = { "imap.acme-hosting.net": { A: ["93.184.216.34"] }, "smtp.acme-hosting.net": { A: ["93.184.216.35"] } };
  world.servers["imap.acme-hosting.net:993"] = imapServer();
  world.servers["smtp.acme-hosting.net:465"] = smtpServer({ host: "smtp.acme-hosting.net" });
  res = await call({ action: "connect", provider: "custom", email: USER, password: PASSWORD, imap_host: "IMAP.Acme-Hosting.net.", smtp_host: "smtp.acme-hosting.net" });
  assert.equal(res.status, 200, res.text);
  assert.equal(myAccounts()[0].provider, "custom");
  assert.equal(myAccounts()[0].imap_host, "imap.acme-hosting.net");
});

test("PLANTED: Vault refusing the password leaves nothing behind -- no live row, no row at all, no password", async () => {
  resetWorld({ failSecretPut: true });
  zohoServers();
  const res = await call({ action: "connect", provider: "zoho", email: USER, password: PASSWORD });
  assert.equal(res.status, 500);
  assert.equal(res.json.error_code, "server_error");
  assert.ok(!res.text.includes("XX000"), "the database's own error text reached the office");
  assert.equal(myAccounts().length, 0, "a half-made mailbox row was left behind");
  assert.equal(world.secrets.size, 0);
  assert.equal(world.db.audit_log.length, 0);

  // The trigger's cap firing as the row goes live (a connect racing another)
  // also cleans up, and says why.
  resetWorld();
  zohoServers();
  const racing = globalThis.__mailTestCreateClient;
  globalThis.__mailTestCreateClient = (url, key, options) => {
    const c = racing(url, key, options);
    const from = c.from;
    c.from = (table) => {
      const q = from(table);
      if (table !== "mail_accounts" || key !== "service-key") return q;
      const update = q.update;
      q.update = (patch) => {
        // Three other mailboxes go live between our check and our flip.
        if (patch.status === "connected" && myAccounts().length === 1) {
          for (const e of ["a@acmefence.com", "b@acmefence.com", "c@acmefence.com"]) seed(account({ email_address: e, username: e }));
        }
        return update(patch);
      };
      return q;
    };
    return c;
  };
  try {
    const raced = await call({ action: "connect", provider: "zoho", email: USER, password: PASSWORD });
    assert.equal(raced.status, 400);
    assert.match(raced.json.detail, /at most 3 mailboxes/);
    assert.equal(myAccounts().filter((r) => r.email_address === USER).length, 0);
    assert.equal(world.secrets.size, 0);

    // The same race when an old, disconnected row is being brought back: the
    // row stays (it holds the mail already fetched), so no cascade removes the
    // password -- it has to be forgotten explicitly.
    resetWorld();
    zohoServers();
    const old = seed(account({ status: "disconnected" }));
    const again = await call({ action: "connect", provider: "zoho", email: USER, password: PASSWORD });
    assert.equal(again.status, 400);
    assert.equal(old.status, "disconnected");
    assert.ok(world.db.mail_accounts.includes(old), "the old row and its mail were thrown away");
    assert.equal(world.secrets.has(old.id), false, "a password was left in Vault for a mailbox that never went live");
  } finally {
    globalThis.__mailTestCreateClient = racing;
  }
});

test("connect: a disconnected address comes back as the same row; its sync state survives unless the server moved", async () => {
  resetWorld();
  const old = seed(account({ status: "disconnected", disconnected_by: UID, disconnected_at: "2026-09-10T00:00:00Z" }));
  world.db.mail_folder_state.push({ account_id: old.id, role: "inbox", path: "INBOX", last_uid: 4000 }, { account_id: old.id, role: "sent", path: "Sent", last_uid: 90 });
  zohoServers();
  let res = await call({ action: "connect", provider: "zoho", email: USER, password: PASSWORD });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.account.id, old.id);
  const row = myAccounts()[0];
  assert.equal(row.status, "connected");
  assert.equal(row.disconnected_at, null);
  assert.equal(world.db.mail_folder_state.length, 2, "sync state thrown away for the same server");
  assert.equal(world.db.audit_log[0].old_value, "disconnected");

  // Same address, previously on Gmail: every stored UID is meaningless on Zoho.
  resetWorld();
  const moved = seed(account({ provider: "gmail", imap_host: "imap.gmail.com", smtp_host: "smtp.gmail.com", smtp_saves_sent: true, status: "disconnected" }));
  world.db.mail_folder_state.push({ account_id: moved.id, role: "inbox", path: "INBOX", last_uid: 4000 });
  zohoServers();
  res = await call({ action: "connect", provider: "zoho", email: USER, password: PASSWORD });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.account.id, moved.id);
  assert.equal(world.db.mail_folder_state.length, 0);
  assert.equal(myAccounts()[0].smtp_saves_sent, null);
});

// ===========================================================================
// check
// ===========================================================================

test("check: the stored password is used; a refusal marks the account auth_failed, without the password", async () => {
  resetWorld();
  const row = seed(account());
  world.secrets.set(row.id, STORED);
  world.servers["imappro.zoho.com:993"] = imapServer({ password: STORED, login: "fail" });
  const res = await call({ action: "check", account_id: row.id });
  assert.equal(res.status, 422);
  assert.equal(res.json.error_code, "auth_failed");
  assert.ok(!res.text.includes(STORED));
  const after = myAccounts()[0];
  assert.equal(after.status, "auth_failed");
  assert.equal(after.last_error_code, "auth_failed");
  assert.ok(after.last_error && !after.last_error.includes(STORED));
  assert.equal(world.secrets.get(row.id), STORED, "a failed check must not touch the stored password");
  assertNothingLeaked();
});

test("check: success clears the error and follows a moved Sent folder", async () => {
  resetWorld();
  const row = seed(account({ status: "error", last_error_code: "timeout", last_error: "The mail server took too long", sent_folder: "Sent Items" }));
  world.db.mail_folder_state.push({ account_id: row.id, role: "inbox", path: "INBOX" }, { account_id: row.id, role: "sent", path: "Sent Items" });
  world.secrets.set(row.id, STORED);
  world.servers["imappro.zoho.com:993"] = imapServer({ password: STORED });
  world.servers["smtppro.zoho.com:465"] = smtpServer({ password: STORED });
  const res = await call({ action: "check", account_id: row.id });
  assert.equal(res.status, 200, res.text);
  assertScriptsClean();
  const after = myAccounts()[0];
  assert.equal(after.status, "connected");
  assert.equal(after.last_error, null);
  assert.equal(after.sent_folder, "Sent");
  assert.deepEqual(world.db.mail_folder_state.map((f) => f.role), ["inbox"]);
  assert.equal(world.attempts, 1);
});

test("PLANTED: check on another company's mailbox is not_found, and its password is never read", async () => {
  resetWorld();
  const theirs = seed(account({ company_id: OTHER_COMPANY, email_address: "boss@rival.example.com", username: "boss@rival.example.com" }));
  world.secrets.set(theirs.id, STORED);
  for (const action of ["check", "replace_password", "disconnect", "set_display"]) {
    const res = await call({ action, account_id: theirs.id, password: NEWPW, display_name: "x" });
    assert.equal(res.status, 404, action);
    assert.equal(res.json.error_code, "not_found", action);
  }
  assert.deepEqual(rpcsNamed("mail_secret_get"), []);
  assert.deepEqual(rpcsNamed("mail_secret_put"), []);
  assert.deepEqual(rpcsNamed("mail_secret_forget"), []);
  assert.equal(world.secrets.get(theirs.id), STORED);
  assert.equal(theirs.status, "connected");
  assert.deepEqual(world.dials, []);
  // A malformed id never reaches a query at all.
  const bad = await call({ action: "check", account_id: "1; drop table mail_accounts" });
  assert.equal(bad.status, 400);
});

test("PLANTED: a custom host re-pointed inside since connect is refused at check, and the account marked error", async () => {
  resetWorld();
  const row = seed(account({ provider: "custom", imap_host: "imap.acme-hosting.net", smtp_host: "smtp.acme-hosting.net" }));
  world.secrets.set(row.id, STORED);
  world.dns = { "imap.acme-hosting.net": { A: ["10.1.2.3"] }, "smtp.acme-hosting.net": { A: ["93.184.216.35"] } };
  world.servers["imap.acme-hosting.net:993"] = imapServer({ password: STORED });
  const res = await call({ action: "check", account_id: row.id });
  assert.equal(res.json.error_code, "host_not_allowed");
  assert.deepEqual(world.dials, []);
  assert.equal(myAccounts()[0].status, "error");

  // A preset row whose hosts no longer match the preset is refused too.
  resetWorld();
  const tampered = seed(account({ imap_host: "imap.evil.example.net" }));
  world.secrets.set(tampered.id, STORED);
  const res2 = await call({ action: "check", account_id: tampered.id });
  assert.equal(res2.json.error_code, "host_not_allowed");
  assert.deepEqual(world.dials, []);
});

test("PLANTED: the owner disconnecting mid-check wins -- nothing revives the mailbox or leaves a password behind", async () => {
  const disconnectNow = (row) => () => {
    row.status = "disconnected";
    row.disconnected_at = new Date().toISOString();
    world.secrets.delete(row.id);
  };

  // check
  resetWorld();
  let row = seed(account());
  world.secrets.set(row.id, STORED);
  world.servers["imappro.zoho.com:993"] = imapServer({ password: STORED, onLogin: disconnectNow(row) });
  world.servers["smtppro.zoho.com:465"] = smtpServer({ password: STORED });
  let res = await call({ action: "check", account_id: row.id });
  assert.equal(res.status, 404, res.text);
  assert.equal(row.status, "disconnected");
  assert.equal(world.secrets.has(row.id), false);

  // replace_password: the new password was stored before the race was seen,
  // so it must be forgotten again.
  resetWorld();
  row = seed(account());
  world.secrets.set(row.id, STORED);
  world.servers["imappro.zoho.com:993"] = imapServer({ password: NEWPW, onLogin: disconnectNow(row) });
  world.servers["smtppro.zoho.com:465"] = smtpServer({ password: NEWPW });
  res = await call({ action: "replace_password", account_id: row.id, password: NEWPW });
  assert.equal(res.status, 404, res.text);
  assert.equal(row.status, "disconnected");
  assert.equal(world.secrets.has(row.id), false, "a password was left in Vault for a disconnected mailbox");

  // connect again to the same live address, same race.
  resetWorld();
  row = seed(account());
  world.secrets.set(row.id, STORED);
  world.servers["imappro.zoho.com:993"] = imapServer({ onLogin: disconnectNow(row) });
  world.servers["smtppro.zoho.com:465"] = smtpServer();
  res = await call({ action: "connect", provider: "zoho", email: USER, password: PASSWORD });
  assert.equal(res.status, 404, res.text);
  assert.equal(row.status, "disconnected");
  assert.equal(world.secrets.has(row.id), false);
});

test("check: a mailbox with no stored password is auth_failed, so the schedule stops and the owner is asked for one", async () => {
  resetWorld();
  const row = seed(account());
  const res = await call({ action: "check", account_id: row.id });
  assert.equal(res.json.error_code, "auth_failed");
  assert.equal(myAccounts()[0].status, "auth_failed");
  assert.deepEqual(world.dials, []);
});

// ===========================================================================
// replace_password, disconnect, set_display
// ===========================================================================

test("replace_password: verified before it is stored; a bad one changes nothing at all", async () => {
  resetWorld();
  const row = seed(account({ status: "auth_failed", last_error_code: "auth_failed" }));
  world.secrets.set(row.id, STORED);
  world.servers["imappro.zoho.com:993"] = imapServer({ password: NEWPW, login: "fail" });
  let res = await call({ action: "replace_password", account_id: row.id, password: NEWPW });
  assert.equal(res.status, 422);
  assert.ok(!res.text.includes(NEWPW));
  assert.deepEqual(rpcsNamed("mail_secret_put"), [], "an unverified password was stored");
  assert.equal(world.secrets.get(row.id), STORED);
  assert.equal(myAccounts()[0].status, "auth_failed");

  world.servers["imappro.zoho.com:993"] = imapServer({ password: NEWPW });
  world.servers["smtppro.zoho.com:465"] = smtpServer({ password: NEWPW });
  res = await call({ action: "replace_password", account_id: row.id, password: NEWPW });
  assert.equal(res.status, 200, res.text);
  assert.equal(world.secrets.get(row.id), NEWPW);
  assert.equal(myAccounts()[0].status, "connected");
  assert.equal(myAccounts()[0].last_error_code, null);
  const entry = world.db.audit_log.at(-1);
  assert.equal(entry.field, "app_password");
  assert.equal(entry.old_value, null);
  assert.equal(entry.new_value, "replaced");
  assertNothingLeaked();
});

test("disconnect: the password is forgotten first, then the mailbox is marked disconnected; mail already fetched stays", async () => {
  resetWorld();
  const row = seed(account());
  world.secrets.set(row.id, STORED);
  world.db.mail_folder_state.push({ account_id: row.id, role: "inbox", path: "INBOX" });
  const res = await call({ action: "disconnect", account_id: row.id });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.password_forgotten, true);
  assert.equal(world.secrets.has(row.id), false);
  const after = myAccounts()[0];
  assert.equal(after.status, "disconnected");
  assert.equal(after.disconnected_by, UID);
  assert.ok(after.disconnected_at);
  assert.equal(world.db.mail_folder_state.length, 1);
  assert.ok(world.seq.indexOf("rpc:mail_secret_forget") < world.seq.lastIndexOf("update:mail_accounts"));
  assert.equal(world.db.audit_log.at(-1).new_value, "disconnected");
  assert.deepEqual(world.dials, []);

  // Again: harmless, and not audited twice.
  const again = await call({ action: "disconnect", account_id: row.id });
  assert.equal(again.status, 200);
  assert.equal(again.json.password_forgotten, false);
  assert.equal(world.db.audit_log.length, 1);

  // A disconnected mailbox cannot be checked or given a password.
  assert.equal((await call({ action: "check", account_id: row.id })).status, 404);
  assert.equal((await call({ action: "replace_password", account_id: row.id, password: NEWPW })).status, 404);
});

test("disconnect: FenceFlow mail is not a mailbox and cannot be disconnected", async () => {
  resetWorld();
  const ff = seed(account({
    kind: "fenceflow", provider: "resend", email_address: "noreply@send.fenceflowapp.com", username: null,
    imap_host: null, smtp_host: null, imap_port: null, smtp_port: null, inbound_token: "0123456789abcdef",
  }));
  const res = await call({ action: "disconnect", account_id: ff.id });
  assert.equal(res.status, 400);
  assert.equal(ff.status, "connected");
  assert.deepEqual(rpcsNamed("mail_secret_forget"), []);
});

test("set_display: the name is cleaned, the signature keeps its lines, an over-long signature is refused", async () => {
  resetWorld();
  const row = seed(account());
  let res = await call({
    action: "set_display",
    account_id: row.id,
    display_name: '  Mike\r\nBcc: x@y.com <"Ruiz"> \u202e ',
    signature: "Mike Ruiz  \r\nAcme Fence\u0007\r\n\u202e(813) 555-0100",
  });
  assert.equal(res.status, 200, res.text);
  const after = myAccounts()[0];
  assert.ok(!/[\r\n<>"\u202e]/.test(after.display_name), "a header could be written through the sender name");
  assert.equal(after.signature, "Mike Ruiz\nAcme Fence\n(813) 555-0100");
  assert.deepEqual(world.dials, []);
  assert.equal(world.attempts, 0);

  res = await call({ action: "set_display", account_id: row.id, signature: "x".repeat(2001) });
  assert.equal(res.status, 400);
  assert.equal(myAccounts()[0].signature, "Mike Ruiz\nAcme Fence\n(813) 555-0100");

  res = await call({ action: "set_display", account_id: row.id, display_name: null });
  assert.equal(res.status, 200);
  assert.equal(myAccounts()[0].display_name, null);
  assert.equal(myAccounts()[0].signature, "Mike Ruiz\nAcme Fence\n(813) 555-0100", "an absent field was cleared");

  assert.equal((await call({ action: "set_display", account_id: row.id })).status, 400);
});

// ===========================================================================
// Bad input.
// ===========================================================================

test("bad input is refused before a socket opens or an attempt is spent", async () => {
  resetWorld();
  zohoServers();
  const cases = [
    { action: "nope" },
    { action: "connect", provider: "outlook", email: USER, password: PASSWORD },
    { action: "connect", provider: "zoho", email: "not an address", password: PASSWORD },
    { action: "connect", provider: "zoho", email: 'o"wner@acmefence.com', password: PASSWORD },
    { action: "connect", provider: "zoho", email: USER },
    { action: "connect", provider: "zoho", email: USER, password: "   " },
    { action: "connect", provider: "zoho", email: USER, password: "x".repeat(257) },
    { action: "connect", provider: "zoho", email: USER, password: "abc\u0000def12345678" },
    { action: "connect", provider: "zoho", email: USER, password: "abc\r\nA2 LOGOUT" },
    { action: "connect", provider: "zoho", email: USER, password: { toString: () => PASSWORD } },
  ];
  for (const body of cases) {
    const res = await call(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.json.error_code, "bad_request");
  }
  // An unproven Zoho region is refused -- after the attempt, but before any socket.
  const eu = await call({ action: "connect", provider: "zoho", zoho_region: "eu", email: USER, password: PASSWORD });
  assert.equal(eu.status, 400);
  assert.deepEqual(world.dials, []);
  assert.equal(world.attempts, 1);

  const notJson = await call(null, { raw: "{not json" });
  assert.equal(notJson.status, 400);
  const huge = await call(null, { raw: JSON.stringify({ action: "status", pad: "x".repeat(210 * 1024) }) });
  assert.equal(huge.status, 413);
  assert.equal(myAccounts().length, 0);
});

// ===========================================================================
// The sweep.
// ===========================================================================

test("PLANTED: no password -- as typed or base64 -- appears in any response or log line from this whole file", () => {
  assert.ok(everything.length > 40, "the sweep saw too few responses to mean anything");
  const all = JSON.stringify([everything, logs]);
  for (const s of ALL_SECRETS) {
    assert.ok(!all.includes(s), "a password reached a response or a log line");
    assert.ok(!all.includes(b64(s)), "a password's base64 reached a response or a log line");
  }
  // The planted echoes were really there to be caught: the servers did send them.
  assert.ok(everything.some((t) => t.includes("[redacted]")), "no redaction ever happened, so the echo test proved nothing");
});
