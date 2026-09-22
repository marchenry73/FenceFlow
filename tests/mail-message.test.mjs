// mail-message, called the way the gateway calls it. No network, no Deno,
// no live Supabase, no real Resend, and no real password anywhere.
//
// Run with:  node --test tests/mail-message.test.mjs
//
// The real handler (supabase/functions/mail-message/index.ts) runs unmodified
// on top of four fakes:
//
//  - Supabase. caller.ts imports supabase-js from esm.sh, which Node cannot
//    fetch, so a module hook swaps that one URL for a fake client over an
//    in-memory database and bucket (the same trick as tests/mail-sync.test.mjs).
//    The user-token client applies the read policy (own company AND the gate)
//    and cannot write or touch storage at all; the service-role client can.
//    A write naming a column mail_messages or mail_accounts does not have is
//    an error here, as it is in PostgREST, so a misspelt column cannot pass
//    as "saved". mail_folder_state is refused to the user client, as the SQL
//    grants refuse it.
//  - A mailbox. FakeImapConn is a model: folders with a UIDVALIDITY and
//    messages with UIDs, flags and whole sources (the .eml fixtures), and a
//    read-only EXAMINE that refuses STORE as a real server does. The real
//    StreamTransport and ImapClient run on top of it.
//  - Resend's receiving API and its download links, as a fetch function.
//  - The clock and the DNS resolver.
//
// Planted cases (each marked PLANTED) are the failures this function exists
// to prevent: crew, a closed gate or another company reaching a message or a
// file; a refused password leaking, or being presented again; a different
// message at the same UID being shown, cached or marked read; a custom host
// re-pointed at a private address getting a socket; a link minted into
// another company's folder; an attachment stored with a type that renders
// as a page; a download fetched from outside resend.com or sent our key; a
// part the reader neither shows nor offers as a download; anything but
// \Seen ever being changed in a tenant's mailbox.
//
// Teeth: set MAIL_MESSAGE_FN to the absolute path of a copy of the function
// (inside a copy of supabase/functions, so its relative imports resolve) and
// every shared module below is loaded from that copy's tree too. A planted
// defect in the copy must make at least one test here fail.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FN_URL = process.env.MAIL_MESSAGE_FN
  ? pathToFileURL(process.env.MAIL_MESSAGE_FN).href
  : new URL("../supabase/functions/mail-message/index.ts", import.meta.url).href;
const shared = (name) => new URL(`../_shared/mail/${name}`, FN_URL).href;

// ===========================================================================
// Fake Supabase
// ===========================================================================

const SUPABASE_JS = "https://esm.sh/@supabase/supabase-js@2.39.0";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === SUPABASE_JS) {
      const src = "export const createClient = (...a) => globalThis.__mailMessageCreateClient(...a);";
      return { url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const RESEND_KEY = "re_fake_receiving_key_for_tests_0123456789";
const ENV = {
  SUPABASE_URL: "https://project.example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  RESEND_RECEIVING_KEY: RESEND_KEY,
};
globalThis.Deno = { env: { get: (k) => ENV[k] } };

const { StreamTransport } = await import(shared("tls-transport.ts"));
const { MailError } = await import(shared("errors.ts"));
const { MESSAGE_SESSIONS_PER_HOUR, MESSAGE_SESSIONS_PER_MINUTE, OPEN_MESSAGE_MAX_BYTES, SIGNED_URL_SECONDS } = await import(shared("limits.ts"));

// The ledger kinds the table accepts, read from supabase_mail.sql itself: a
// kind the function spends that the check constraint refuses would fail
// every call in production, so the fake refuses it too.
const LEDGER_KINDS = (() => {
  const sql = readFileSync(new URL("../supabase_mail.sql", import.meta.url), "utf8");
  const m = /mail_events_kind_check\s+check \(kind in \(([^)]*)\)\)/.exec(sql);
  if (!m) throw new Error("mail_events kind check not found in supabase_mail.sql");
  return new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
})();
const WINDOW_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
const windowMs = (w) => {
  const m = /^(\d+) (minute|hour|day)s?$/.exec(String(w));
  if (!m) throw new Error(`fake: unsupported window ${w}`);
  return Number(m[1]) * WINDOW_MS[m[2]];
};
const ledgerCount = (company, kind, win) =>
  world.mail_events.filter((e) => e.company_id === company && e.kind === kind && e.at > Date.now() - windowMs(win)).length;

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl";
const UID = "11111111-1111-4111-8111-111111111111";
const C1 = "22222222-2222-4222-8222-222222222222";
const C2 = "22222222-2222-4222-8222-2222222222c2";
// Shaped like a Zoho app password (16 characters), and fake.
const PASSWORD = "k7Qp2mX9vR4tZw8L";
const WRONG = "Wr0ngPassw0rd123";
const QUOTE_MID = "0f8e3a1c-2b4d-4e6f-8a9b-1c2d3e4f5a6b@acmefence.com";
const REPLY_MID = "CAF7k2+Qx9L0wQ-4102@mail.example.org";

let world;
let idSeq = 0;
// A real UUID shape (the function refuses anything else), with the prefix
// spelled in hex so ids stay recognisable in a failure: "msg" -> 6d736700-...
const newId = (prefix = "a") => `${Buffer.from(prefix).toString("hex").padEnd(8, "0").slice(0, 8)}-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const same = (a, b) => String(a) === String(b);
/** A fresh, unique timestamp: what the mail_accounts trigger puts in updated_at. */
const stamp = () => new Date(Date.now() + ++world.tick).toISOString();

/** Every column of supabase_mail.sql's two tables this function writes. */
const COLUMNS = {
  mail_messages: new Set([
    "id", "company_id", "account_id", "thread_id", "folder_role", "source", "uidvalidity", "uid", "provider_message_id",
    "message_id_header", "parent_ids", "from_address", "from_name", "to_list", "cc_list", "reply_to_list", "to_text",
    "counterpart_emails", "subject", "sent_at", "received_at", "size_bytes", "has_attachments", "is_seen", "is_answered",
    "is_flagged", "snippet", "body_state", "body_text", "body_html", "body_truncated", "attachments", "send_state",
    "send_error", "client_send_id", "sent_by", "job_sync_id", "server_gone_at", "created_at",
  ]),
  mail_accounts: new Set([
    "id", "company_id", "kind", "provider", "email_address", "display_name", "signature", "username", "imap_host",
    "smtp_host", "imap_port", "smtp_port", "sent_folder", "smtp_saves_sent", "inbound_token", "status",
    "last_error_code", "last_error", "last_error_at", "last_synced_at", "sync_lock_until", "connected_by",
    "connected_at", "disconnected_by", "disconnected_at", "updated_at",
  ]),
};
const BODY_STATES = new Set(["none", "cached", "too_large", "error"]);

function newWorld() {
  world = {
    tick: 0,
    created: [],
    rpcLog: [],
    queryLog: [],
    storageLog: [],
    fetchLog: [],
    gate: true,
    profiles: [{ id: UID, company_id: C1, role: "OWNER" }],
    companies: [
      { id: C1, name: "Acme Fence", email: "office@acmefence.com" },
      { id: C2, name: "Bravo Fence", email: "hello@bravo-fence.example" },
    ],
    mail_accounts: [],
    mail_folder_state: [],
    mail_messages: [],
    mail_events: [],
    secrets: new Map(),
    storage: new Map(),
    failUpload: new Set(),
  };
}

function addAccount(over = {}) {
  const row = {
    id: newId("acc"),
    company_id: C1,
    kind: "imap",
    provider: "zoho",
    email_address: "office@acmefence.com",
    username: "office@acmefence.com",
    imap_host: "imappro.zoho.com",
    imap_port: 993,
    smtp_host: "smtppro.zoho.com",
    smtp_port: 465,
    sent_folder: "Sent",
    status: "connected",
    last_error_code: null,
    last_error: null,
    last_error_at: null,
    updated_at: null,
    ...over,
  };
  delete row.password;
  row.updated_at = stamp();
  world.mail_accounts.push(row);
  if (row.kind === "imap") world.secrets.set(row.id, over.password ?? PASSWORD);
  if (row.kind === "imap" && !over.noFolderState) {
    world.mail_folder_state.push({ account_id: row.id, role: "inbox", path: "INBOX", uidvalidity: 1001 });
    world.mail_folder_state.push({ account_id: row.id, role: "sent", path: "Sent", uidvalidity: 2002 });
  }
  delete row.noFolderState;
  return row;
}

function addMessage(account, over = {}) {
  const row = {
    id: newId("msg"),
    company_id: account.company_id,
    account_id: account.id,
    thread_id: newId("thr"),
    folder_role: "inbox",
    source: "imap",
    uidvalidity: 1001,
    uid: 101,
    provider_message_id: null,
    message_id_header: QUOTE_MID,
    size_bytes: 2600,
    body_state: "none",
    body_text: null,
    body_html: null,
    body_truncated: false,
    snippet: "",
    has_attachments: true,
    attachments: [],
    is_seen: false,
    is_answered: false,
    is_flagged: false,
    server_gone_at: null,
    ...over,
  };
  world.mail_messages.push(row);
  return row;
}

const msgRow = (id) => world.mail_messages.find((m) => m.id === id);
const acctRow = (id) => world.mail_accounts.find((a) => a.id === id);

function makeQuery(table, key) {
  const st = { op: "select", filters: [], log: [], patch: null, returning: false };
  const add = (op, col, val, fn) => {
    st.log.push([op, col, val]);
    st.filters.push(fn);
    return q;
  };
  const q = {
    select() {
      if (st.op !== "select") st.returning = true;
      return q;
    },
    eq: (c, v) => add("eq", c, v, (r) => r[c] !== null && r[c] !== undefined && same(r[c], v)),
    neq: (c, v) => add("neq", c, v, (r) => r[c] !== null && r[c] !== undefined && !same(r[c], v)),
    is: (c, v) => add("is", c, v, (r) => (r[c] ?? null) === v),
    update(patch) {
      st.op = "update";
      st.patch = patch;
      return q;
    },
    maybeSingle: () => run(true),
    then: (res, rej) => run(false).then(res, rej),
  };

  async function run(single) {
    world.queryLog.push({ table, key, op: st.op, filters: st.log, patch: clone(st.patch) });
    let rows = world[table];
    if (!Array.isArray(rows)) throw new Error(`fake: no table ${table}`);
    if (key === "anon-key") {
      // The SQL grants: the office reads four mail tables and writes none.
      if (st.op !== "select" || ["mail_folder_state", "mail_account_secrets"].includes(table)) {
        return { data: null, error: { code: "42501", message: "permission denied" } };
      }
      if (table.startsWith("mail_")) {
        const me = world.profiles.find((p) => p.id === UID);
        rows = world.gate ? rows.filter((r) => r.company_id === me?.company_id) : [];
      }
    }
    const matched = rows.filter((r) => st.filters.every((f) => f(r)));
    if (st.op === "update") {
      const cols = COLUMNS[table];
      if (cols) {
        const bad = Object.keys(st.patch).filter((k) => !cols.has(k));
        if (bad.length) return { data: null, error: { code: "PGRST204", message: `no column ${bad.join(",")}` } };
      }
      if (table === "mail_messages") {
        if ("body_state" in st.patch && !BODY_STATES.has(st.patch.body_state)) return { data: null, error: { code: "23514", message: "body_state" } };
        if ("attachments" in st.patch && !Array.isArray(st.patch.attachments)) return { data: null, error: { code: "23514", message: "attachments" } };
      }
      for (const r of matched) {
        Object.assign(r, clone(st.patch));
        if (table === "mail_accounts") r.updated_at = stamp();
      }
      return { data: st.returning ? matched.map(clone) : null, error: null };
    }
    const data = matched.map(clone);
    return single ? { data: data[0] ?? null, error: null } : { data, error: null };
  }
  return q;
}

function makeBucket(bucket, key) {
  const deny = { data: null, error: { message: "new row violates row-level security policy" } };
  return {
    upload: async (path, body, opts = {}) => {
      world.storageLog.push({ op: "upload", key, bucket, path, contentType: opts.contentType, upsert: opts.upsert });
      if (key !== "service-key") return deny;
      if (world.failUpload.has(path)) return { data: null, error: { message: "fake: upload failed" } };
      world.storage.set(`${bucket}/${path}`, { bytes: Buffer.from(body), contentType: opts.contentType });
      return { data: { path }, error: null };
    },
    download: async (path) => {
      world.storageLog.push({ op: "download", key, bucket, path });
      if (key !== "service-key") return deny;
      const o = world.storage.get(`${bucket}/${path}`);
      return o ? { data: new Blob([o.bytes]), error: null } : { data: null, error: { message: "Object not found" } };
    },
    createSignedUrl: async (path, expiresIn, opts = {}) => {
      world.storageLog.push({ op: "sign", key, bucket, path, expiresIn, download: opts.download });
      if (key !== "service-key") return deny;
      if (!world.storage.has(`${bucket}/${path}`)) return { data: null, error: { message: "Object not found" } };
      const dl = typeof opts.download === "string" ? `&download=${encodeURIComponent(opts.download)}` : "";
      return { data: { signedUrl: `${ENV.SUPABASE_URL}/storage/v1/object/sign/${bucket}/${path}?token=fake${dl}` }, error: null };
    },
  };
}

globalThis.__mailMessageCreateClient = (url, key, options) => {
  const auth = options?.global?.headers?.Authorization ?? null;
  world.created.push({ key, auth });
  return {
    auth: {
      getUser: async (jwt) => (jwt === JWT && key === "anon-key"
        ? { data: { user: { id: UID } }, error: null }
        : { data: { user: null }, error: { message: "bad jwt" } }),
    },
    rpc: async (name, args) => {
      world.rpcLog.push({ name, args: clone(args), key });
      if (key === "anon-key") {
        return name === "can_use_company_mail"
          ? { data: world.gate, error: null }
          : { data: null, error: { code: "42501", message: "permission denied" } };
      }
      if (name === "mail_secret_get") return { data: world.secrets.get(args.p_account) ?? null, error: null };
      // The rate ledger, as supabase_mail.sql defines it: note records then
      // counts (this one included); count only counts.
      if (name === "note_mail_event") {
        if (!LEDGER_KINDS.has(args.p_kind)) return { data: null, error: { code: "23514", message: "mail_events_kind_check" } };
        world.mail_events.push({ company_id: args.p_company, actor: args.p_actor, kind: args.p_kind, at: Date.now() });
        return { data: ledgerCount(args.p_company, args.p_kind, args.p_window), error: null };
      }
      if (name === "mail_event_count") return { data: ledgerCount(args.p_company, args.p_kind, args.p_window), error: null };
      if (name === "mail_mark_gone") {
        let n = 0;
        for (const m of world.mail_messages) {
          if (m.account_id === args.p_account && m.folder_role === args.p_role && m.uidvalidity === Number(args.p_uidvalidity) &&
            args.p_uids.map(Number).includes(m.uid) && m.server_gone_at === null) {
            m.server_gone_at = new Date().toISOString();
            n++;
          }
        }
        return { data: n, error: null };
      }
      return { data: null, error: { code: "PGRST202", message: `fake: no rpc ${name}` } };
    },
    from: (table) => makeQuery(table, key),
    storage: { from: (bucket) => makeBucket(bucket, key) },
  };
};

const fn = await import(FN_URL);

// ===========================================================================
// Fake mailbox
// ===========================================================================

function fixture(name) {
  return Buffer.from(readFileSync(new URL(`./fixtures/mail/${name}`, import.meta.url), "utf8").replace(/\r?\n/g, "\r\n"), "utf8");
}
const QUOTE = fixture("sent-quote-attachments.eml");
const REPLY = fixture("customer-reply.eml");

/** Every command line any fake server received in this file, for the final
 *  "nothing but these commands, ever" check. LOGIN lines are not kept. */
const ALL_COMMANDS = [];

function mailbox(over = {}) {
  return {
    username: "office@acmefence.com",
    password: PASSWORD,
    folders: {
      INBOX: { uidValidity: 1001, messages: [{ uid: 101, flags: [], source: QUOTE }, { uid: 102, flags: ["\\Seen"], source: REPLY }] },
      Sent: { uidValidity: 2002, messages: [] },
    },
    log: [],
    logins: 0,
    ...over,
  };
}

function unquote(s) {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s);
  return m ? m[1].replace(/\\(.)/g, "$1") : s;
}

class FakeImapConn {
  constructor(mb) {
    this.mb = mb;
    this.out = [];
    this.waiters = [];
    this.inBuf = "";
    this.closed = false;
    this.eof = false;
    this.selected = null;
    this.readOnly = true;
    this.send("* OK [CAPABILITY IMAP4rev1 UIDPLUS AUTH=PLAIN] Fake Zoho IMAP ready");
  }
  send(line) {
    this.out.push(Buffer.from(`${line}\r\n`, "latin1"));
    this.wake();
  }
  sendRaw(buf) {
    this.out.push(buf);
    this.wake();
  }
  wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
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
  async write(p) {
    this.inBuf += Buffer.from(p).toString("latin1");
    let i;
    while ((i = this.inBuf.indexOf("\r\n")) >= 0) {
      const line = this.inBuf.slice(0, i);
      this.inBuf = this.inBuf.slice(i + 2);
      this.command(line);
    }
    return p.length;
  }
  close() {
    this.closed = true;
    this.wake();
  }
  command(line) {
    const mb = this.mb;
    const sp = line.indexOf(" ");
    const tag = line.slice(0, sp);
    const rest = line.slice(sp + 1);
    const verbRaw = rest.split(" ")[0];
    const verb = verbRaw.toUpperCase();
    const logged = verb === "LOGIN" ? `${tag} LOGIN [hidden by the fake]` : line;
    mb.log.push(logged);
    ALL_COMMANDS.push(logged);

    if (verb === "CAPABILITY") {
      this.send("* CAPABILITY IMAP4rev1 UIDPLUS AUTH=PLAIN");
      return this.send(`${tag} OK CAPABILITY completed`);
    }
    if (verb === "LOGIN") {
      mb.logins++;
      const m = /^LOGIN ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/i.exec(rest);
      if (!m) return this.send(`${tag} BAD fake: LOGIN arguments`);
      const [user, pass] = [unquote(m[1]), unquote(m[2])];
      if (user === mb.username && pass === mb.password) return this.send(`${tag} OK LOGIN completed`);
      // A careless server echoing what it was sent: the password must still
      // never reach anything FenceFlow stores or shows.
      return this.send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials for ${user} (${pass})`);
    }
    if (verb === "SELECT" || verb === "EXAMINE") {
      const name = unquote(rest.slice(verbRaw.length + 1));
      const f = mb.folders[name];
      if (!f) return this.send(`${tag} NO [NONEXISTENT] No such folder`);
      this.selected = f;
      this.readOnly = verb === "EXAMINE";
      const top = f.messages.reduce((m, x) => Math.max(m, x.uid), 0);
      this.send(`* ${f.messages.length} EXISTS`);
      this.send(`* OK [UIDVALIDITY ${f.uidValidity}] UIDs valid`);
      this.send(`* OK [UIDNEXT ${top + 1}] Predicted next UID`);
      return this.send(`${tag} OK [${this.readOnly ? "READ-ONLY" : "READ-WRITE"}] ${verb} completed`);
    }
    if (verb === "UID") {
      const f = this.selected;
      if (!f) return this.send(`${tag} BAD No folder selected`);
      const [, sub, set, ...more] = rest.split(" ");
      const uids = new Set(set.split(",").flatMap((p) => {
        const [a, b] = p.split(":").map(Number);
        return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, k) => a + k);
      }));
      if (sub.toUpperCase() === "FETCH") {
        const items = more.join(" ").toUpperCase();
        f.messages.forEach((x, idx) => {
          if (!uids.has(x.uid)) return;
          if (items.includes("BODY.PEEK[]")) {
            this.sendRaw(Buffer.concat([
              Buffer.from(`* ${idx + 1} FETCH (UID ${x.uid} BODY[] {${x.source.length}}\r\n`, "latin1"),
              x.source,
              Buffer.from(")\r\n", "latin1"),
            ]));
          } else {
            this.send(`* ${idx + 1} FETCH (UID ${x.uid} FLAGS (${x.flags.join(" ")}) RFC822.SIZE ${x.size ?? x.source.length})`);
          }
        });
        return this.send(`${tag} OK FETCH completed`);
      }
      if (sub.toUpperCase() === "STORE") {
        if (this.readOnly) return this.send(`${tag} NO [READ-ONLY] Mailbox is read-only`);
        const [op, list] = [more[0], more.slice(1).join(" ")];
        const flags = list.replace(/^\(|\)$/g, "").split(" ").filter(Boolean);
        for (const x of f.messages) {
          if (!uids.has(x.uid)) continue;
          if (op.startsWith("+")) x.flags = [...new Set([...x.flags, ...flags])];
          else x.flags = x.flags.filter((g) => !flags.includes(g));
        }
        return this.send(`${tag} OK STORE completed`);
      }
      return this.send(`${tag} BAD fake: UID ${sub}`);
    }
    if (verb === "LOGOUT") {
      this.send("* BYE Logging out");
      this.send(`${tag} OK LOGOUT completed`);
      this.eof = true;
      return this.wake();
    }
    return this.send(`${tag} BAD fake: unknown command ${verb}`);
  }
}

// ===========================================================================
// Calling the handler
// ===========================================================================

function makeDeps(byHost, over = {}) {
  const connects = [];
  const deps = {
    connect: async (opts) => {
      connects.push(clone(opts));
      const target = byHost[opts.hostname];
      if (!target) throw new MailError("connect_failed", "fake: nothing listens there");
      return new StreamTransport(new FakeImapConn(target), opts.limits ?? {});
    },
    resolver: over.resolver ?? (async () => []),
    fetch: over.fetch ?? (async (url) => {
      world.fetchLog.push({ url });
      throw new TypeError("fake: no network");
    }),
    now: () => Date.now(),
    env: (k) => ENV[k],
  };
  return { deps, connects };
}

const FN_ENDPOINT = "https://project.example.supabase.co/functions/v1/mail-message";
const req = (body, headers = { Authorization: `Bearer ${JWT}` }, method = "POST") =>
  new Request(FN_ENDPOINT, {
    method,
    headers: { ...headers, "Content-Type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });

async function call(body, deps, headers) {
  const res = await fn.handleRequest(req(body, headers), deps);
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text), type: res.headers.get("content-type") };
}

const serviceKeyUsed = () => world.created.some((c) => c.key === "service-key");
const uploads = () => world.storageLog.filter((s) => s.op === "upload");
const signs = () => world.storageLog.filter((s) => s.op === "sign");
const flagsOf = (mb, uid, folder = "INBOX") => mb.folders[folder].messages.find((m) => m.uid === uid).flags;
const verbs = (mb) => mb.log.map((l) => l.replace(/^A\d+ /, "").replace(/^(UID \w+|\w+).*$/, "$1"));

// ===========================================================================
// The door
// ===========================================================================

test("PLANTED: no token, a closed gate, or another company's message reaches no mailbox, no password and no file", async () => {
  newWorld();
  const a = addAccount();
  const m = addMessage(a);
  const b = addAccount({ company_id: C2, email_address: "hello@bravo-fence.example", username: "hello@bravo-fence.example" });
  const theirs = addMessage(b);
  const mb = mailbox();
  const { deps, connects } = makeDeps({ "imappro.zoho.com": mb });

  let r = await call({ action: "open", message_id: m.id }, deps, {});
  assert.equal(r.status, 401);
  assert.equal(r.body.error_code, "no_session");

  world.gate = false; // crew, a suspended company, no "See prices and money"
  for (const body of [{ action: "open", message_id: m.id }, { action: "mark", message_id: m.id, seen: true }, { action: "attachment", message_id: m.id, idx: 0 }]) {
    r = await call(body, deps);
    assert.equal(r.status, 403, body.action);
    assert.equal(r.body.error_code, "mail_forbidden");
  }
  assert.equal(serviceKeyUsed(), false, "a service-role client was built for a caller the gate refused");

  world.gate = true;
  for (const body of [{ action: "open", message_id: theirs.id }, { action: "mark", message_id: theirs.id, seen: true }, { action: "attachment", message_id: theirs.id, idx: 0 }]) {
    r = await call(body, deps);
    assert.equal(r.status, 404, body.action);
    assert.equal(r.body.error_code, "not_found");
  }
  // Positive control: the same request for our own message does reach it.
  r = await call({ action: "open", message_id: m.id, peek: true }, deps);
  assert.equal(r.body.state, "ok");
  assert.equal(connects.length, 1, "only our own message's mailbox was ever connected to");
  assert.ok(!world.rpcLog.some((c) => c.name === "mail_secret_get" && c.args.p_account === b.id), "another company's password was read");
  assert.ok(uploads().every((u) => u.path.startsWith(`${C1}/${a.id}/${m.id}/`)));
  assert.equal(msgRow(theirs.id).body_state, "none");
  // RLS decides: every read of a message or a mailbox is made with the
  // caller's own token, never the service role (which would see every
  // company's mail and skip the gate).
  const reads = world.queryLog.filter((q) => ["mail_messages", "mail_accounts"].includes(q.table) && q.op === "select");
  assert.ok(reads.some((q) => q.table === "mail_messages") && reads.some((q) => q.table === "mail_accounts"), "positive control");
  assert.deepEqual(reads.filter((q) => q.key !== "anon-key"), [], "a message or mailbox was read with the service role");
});

test("bad requests are refused before anything is read", async () => {
  newWorld();
  const a = addAccount();
  const m = addMessage(a);
  const { deps, connects } = makeDeps({ "imappro.zoho.com": mailbox() });
  for (const [body, code] of [
    [{ action: "delete", message_id: m.id }, "bad_request"],
    [{ action: "open", message_id: "not-a-uuid" }, "bad_request"],
    [{ action: "open", message_id: m.id, peek: "yes" }, "bad_request"],
    [{ action: "mark", message_id: m.id, seen: "yes" }, "bad_request"],
    [{ action: "attachment", message_id: m.id, idx: "1" }, "bad_request"],
    [{ action: "attachment", message_id: m.id, idx: -1 }, "bad_request"],
  ]) {
    const r = await call(body, deps);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error_code, code);
  }
  assert.equal(connects.length, 0);
  const pre = await fn.handleRequest(new Request(FN_ENDPOINT, { method: "OPTIONS" }), deps);
  assert.equal(pre.status, 200);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  const get = await fn.handleRequest(req(null, { Authorization: `Bearer ${JWT}` }, "GET"), deps);
  assert.equal(get.status, 400);
});

// ===========================================================================
// Opening IMAP mail
// ===========================================================================

test("first open: the body, the parts and the pictures, stored, cached, and marked read in the mailbox", async () => {
  newWorld();
  const a = addAccount();
  const m = addMessage(a);
  const mb = mailbox();
  const { deps, connects } = makeDeps({ "imappro.zoho.com": mb });

  const r = await call({ action: "open", message_id: m.id }, deps);
  assert.equal(r.status, 200, r.text);
  assert.match(r.type, /application\/json/);
  assert.equal(r.body.state, "ok");
  assert.ok(r.body.text.includes("The quote is attached.\n.This line starts with a dot."), r.body.text);
  // The HTML comes back as sent -- the office sanitizes and sandboxes it.
  assert.ok(r.body.html.includes('src="cid:logo@acmefence.com"'));
  assert.equal(r.body.truncated, false);
  assert.equal(r.body.is_seen, true);
  assert.equal(r.body.server_gone, false);
  assert.equal(r.body.mark_error, undefined);
  assert.deepEqual(r.body.attachments.map((p) => [p.idx, p.filename, p.disposition, p.state]), [
    [0, "logo.png", "inline", "stored"],
    [1, "Devis cl\u{f4}ture.pdf", "attachment", "stored"],
    [2, "_.._invoice.html", "attachment", "stored"],
    [3, "diagram.svg", "attachment", "stored"],
  ]);
  // Only the PNG is a picture the frame may show; the SVG never is.
  assert.deepEqual(Object.keys(r.body.inline_images), ["logo@acmefence.com"]);
  assert.match(r.body.inline_images["logo@acmefence.com"], /^data:image\/png;base64,iVBORw0KGgo/);

  // One session: read-only fetch first, the mark only after.
  assert.equal(connects.length, 1);
  assert.deepEqual(connects[0], { hostname: "imappro.zoho.com", port: 993, limits: { sessionDeadlineMs: fn.OPEN_SESSION_MS } });
  assert.deepEqual(verbs(mb), ["LOGIN", "EXAMINE", "UID FETCH", "UID FETCH", "SELECT", "UID STORE", "LOGOUT"]);
  assert.ok(mb.log.some((l) => /UID FETCH 101 \(UID BODY\.PEEK\[\]\)$/.test(l)), "the body must be fetched with PEEK");
  assert.ok(mb.log.some((l) => /UID STORE 101 \+FLAGS\.SILENT \(\\Seen\)$/.test(l)));
  assert.ok(flagsOf(mb, 101).includes("\\Seen"));

  // Stored under the company's own folder, typed so nothing renders.
  assert.deepEqual(uploads().map((u) => [u.path.slice(`${C1}/${a.id}/${m.id}/`.length), u.contentType, u.key]), [
    ["0-logo.png", "image/png", "service-key"],
    ["1-Devis_cloture.pdf", "application/pdf", "service-key"],
    ["2-invoice.html", "application/octet-stream", "service-key"],
    ["3-diagram.svg", "application/octet-stream", "service-key"],
  ]);
  assert.ok(uploads().every((u) => u.bucket === "mail-files" && u.path.startsWith(`${C1}/${a.id}/${m.id}/`)));

  const row = msgRow(m.id);
  assert.equal(row.body_state, "cached");
  assert.equal(row.is_seen, true);
  assert.equal(row.has_attachments, true);
  assert.ok(row.snippet.startsWith("Hi Dana,"), row.snippet);
  assert.equal(row.size_bytes, QUOTE.length);
  assert.ok(row.attachments.every((p) => p.state === "stored" && p.storage_path.startsWith(`${C1}/${a.id}/${m.id}/`)));
  assert.equal(row.body_text, r.body.text);

  // Every service-role write names the company, and the password never
  // appears anywhere FenceFlow keeps or says anything.
  const writes = world.queryLog.filter((q) => q.key === "service-key" && q.op === "update");
  assert.ok(writes.length > 0);
  for (const w of writes) assert.ok(w.filters.some(([op, c, v]) => op === "eq" && c === "company_id" && v === C1), JSON.stringify(w.filters));
  // (world.secrets is a Map, which JSON.stringify writes as {}: the one place
  // the password is meant to be is left out of this search.)
  assert.ok(!JSON.stringify(world).includes(PASSWORD), "the password reached a row, a log or a payload");
  assert.ok(!r.text.includes(PASSWORD));
});

test("PLANTED: what the office is told never includes a storage path", async () => {
  newWorld();
  const a = addAccount();
  const m = addMessage(a);
  const { deps } = makeDeps({ "imappro.zoho.com": mailbox() });
  const first = await call({ action: "open", message_id: m.id }, deps);
  const again = await call({ action: "open", message_id: m.id }, deps);
  for (const r of [first, again]) {
    assert.equal(r.body.state, "ok");
    assert.ok(!r.text.includes("storage_path"), r.text.slice(0, 200));
    assert.ok(!r.text.includes(`${C1}/${a.id}`), "a storage key reached the office");
  }
  // Positive control: the paths do exist, on the row.
  assert.ok(msgRow(m.id).attachments.every((p) => p.storage_path));
});

test("peek reads without marking; later opens come from FenceFlow's copy, signing in only to mark an unread one", async () => {
  newWorld();
  const a = addAccount();
  const m = addMessage(a);
  const mb = mailbox();
  const { deps, connects } = makeDeps({ "imappro.zoho.com": mb });

  let r = await call({ action: "open", message_id: m.id, peek: true }, deps);
  assert.equal(r.body.state, "ok");
  assert.equal(r.body.is_seen, false);
  assert.deepEqual(verbs(mb), ["LOGIN", "EXAMINE", "UID FETCH", "UID FETCH", "LOGOUT"], "peek must never SELECT or STORE");
  assert.deepEqual(flagsOf(mb, 101), []);
  assert.equal(msgRow(m.id).is_seen, false);
  assert.equal(msgRow(m.id).body_state, "cached");

  // Cached, peeked again: no session at all, and the picture comes back
  // from storage.
  r = await call({ action: "open", message_id: m.id, peek: true }, deps);
  assert.equal(connects.length, 1);
  assert.match(r.body.inline_images["logo@acmefence.com"], /^data:image\/png;base64,iVBORw0KGgo/);
  assert.equal(r.body.text, msgRow(m.id).body_text);
  assert.ok(world.storageLog.some((s) => s.op === "download" && s.path.endsWith("/0-logo.png")));
  assert.ok(!world.storageLog.some((s) => s.op === "download" && s.path.endsWith(".svg")), "an SVG was read back to be shown");

  // Opened for real: one short session that only marks.
  mb.log.length = 0;
  r = await call({ action: "open", message_id: m.id }, deps);
  assert.equal(r.body.is_seen, true);
  assert.equal(connects.length, 2);
  assert.deepEqual(connects[1].limits, { sessionDeadlineMs: fn.MARK_SESSION_MS });
  assert.deepEqual(verbs(mb), ["LOGIN", "SELECT", "UID STORE", "LOGOUT"]);
  assert.ok(flagsOf(mb, 101).includes("\\Seen"));
  assert.equal(msgRow(m.id).is_seen, true);

  // Read now: nothing left to do in the mailbox.
  r = await call({ action: "open", message_id: m.id }, deps);
  assert.equal(r.body.state, "ok");
  assert.equal(connects.length, 2);
});

test("PLANTED: a refused password comes back without the password, marks the mailbox auth_failed, and is never presented again", async () => {
  newWorld();
  const a = addAccount({ password: WRONG });
  const m = addMessage(a);
  const cached = addMessage(a, { uid: 102, message_id_header: REPLY_MID, body_state: "cached", body_text: "Thanks Mike", is_seen: false });
  const mb = mailbox();
  const { deps, connects } = makeDeps({ "imappro.zoho.com": mb });

  const r = await call({ action: "open", message_id: m.id }, deps);
  assert.equal(r.status, 422, r.text);
  assert.equal(r.body.error_code, "auth_failed");
  assert.ok(!r.text.includes(WRONG), r.text);
  assert.equal(mb.logins, 1);
  const row = acctRow(a.id);
  assert.equal(row.status, "auth_failed");
  assert.equal(row.last_error_code, "auth_failed");
  // The server echoed the password (the fake always does). "([redacted])" is
  // the positive control that there was something to cut out.
  assert.ok(row.last_error && !row.last_error.includes(WRONG), row.last_error);
  assert.match(row.last_error, /\(\[redacted\]\)/);
  assert.equal(msgRow(m.id).body_state, "none");

  // Never again from here: not to open, not to mark, not for a cached one.
  const again = await call({ action: "open", message_id: m.id }, deps);
  assert.equal(again.status, 422);
  assert.equal(again.body.error_code, "auth_failed");
  const mark = await call({ action: "mark", message_id: cached.id, seen: true }, deps);
  assert.equal(mark.body.error_code, "auth_failed");
  // A cached message still opens; the read mark could not be made in the
  // mailbox, so it is not faked in FenceFlow either.
  const open = await call({ action: "open", message_id: cached.id }, deps);
  assert.equal(open.body.state, "ok");
  assert.equal(open.body.text, "Thanks Mike");
  assert.equal(open.body.is_seen, false);
  assert.equal(open.body.mark_error, "auth_failed");
  assert.equal(msgRow(cached.id).is_seen, false);
  assert.equal(mb.logins, 1, "a refused password was presented again");
  assert.equal(connects.length, 1);
});

test("a refused sign-in never overwrites a mailbox the owner changed in the meantime", async () => {
  newWorld();
  const a = addAccount({ password: WRONG });
  const m = addMessage(a);
  const mb = mailbox();
  const { deps } = makeDeps({ "imappro.zoho.com": mb });
  // The owner types a new password while this open is signing in: the row
  // changes between the moment it was read and the refusal.
  const origGet = world.secrets.get.bind(world.secrets);
  world.secrets.get = (id) => {
    const v = origGet(id);
    acctRow(a.id).updated_at = stamp();
    acctRow(a.id).status = "connected";
    return v;
  };
  const r = await call({ action: "open", message_id: m.id }, deps);
  assert.equal(r.body.error_code, "auth_failed");
  assert.equal(acctRow(a.id).status, "connected", "a stale refusal clobbered the owner's change");
});

test("too large: refused from the recorded size without a sign-in, and from the server's size before any of the body", async () => {
  newWorld();
  const a = addAccount();
  const big = addMessage(a, { size_bytes: OPEN_MESSAGE_MAX_BYTES + 1 });
  const mb = mailbox();
  const { deps, connects } = makeDeps({ "imappro.zoho.com": mb });
  let r = await call({ action: "open", message_id: big.id }, deps);
  assert.deepEqual(r.body, { state: "too_large", message_id: big.id, size: OPEN_MESSAGE_MAX_BYTES + 1 });
  assert.equal(connects.length, 0);
  assert.equal(msgRow(big.id).body_state, "too_large");

  // The row said small; the server says otherwise.
  const liar = addMessage(a, { uid: 102, message_id_header: REPLY_MID, size_bytes: 1500 });
  mb.folders.INBOX.messages.find((x) => x.uid === 102).size = 12 * 1024 * 1024;
  r = await call({ action: "open", message_id: liar.id }, deps);
  assert.equal(r.body.state, "too_large");
  assert.equal(r.body.size, 12 * 1024 * 1024);
  assert.ok(!mb.log.some((l) => /BODY\.PEEK\[\]/.test(l)), "the body of an oversized message was downloaded");
  assert.equal(msgRow(liar.id).body_state, "too_large");
  assert.equal(msgRow(liar.id).size_bytes, 12 * 1024 * 1024);

  // And from then on without a session.
  r = await call({ action: "open", message_id: liar.id }, deps);
  assert.equal(r.body.state, "too_large");
  assert.equal(connects.length, 1);
});

test("gone and changed: a removed message is hidden, a renumbered mailbox is never guessed at", async () => {
  newWorld();
  const a = addAccount();
  const mb = mailbox();
  const { deps, connects } = makeDeps({ "imappro.zoho.com": mb });

  const removed = addMessage(a, { uid: 150 });
  let r = await call({ action: "open", message_id: removed.id }, deps);
  assert.deepEqual(r.body, { state: "gone", message_id: removed.id });
  const gone = world.rpcLog.find((c) => c.name === "mail_mark_gone");
  assert.deepEqual(gone.args, { p_account: a.id, p_role: "inbox", p_uidvalidity: 1001, p_uids: [150] });
  assert.ok(msgRow(removed.id).server_gone_at);
  r = await call({ action: "open", message_id: removed.id }, deps);
  assert.equal(r.body.state, "gone");
  assert.equal(connects.length, 1, "a message known to be gone cost another sign-in");

  // The server's UIDVALIDITY moved on since the last sync.
  mb.folders.INBOX.uidValidity = 5005;
  const m = addMessage(a);
  r = await call({ action: "open", message_id: m.id }, deps);
  assert.deepEqual(r.body, { state: "changed", message_id: m.id });
  assert.equal(msgRow(m.id).body_state, "none");
  assert.ok(!mb.log.some((l) => /BODY\.PEEK\[\]/.test(l)));

  // Sync has already recorded the new numbering: answered without a sign-in.
  world.mail_folder_state.find((s) => s.account_id === a.id && s.role === "inbox").uidvalidity = 5005;
  const before = connects.length;
  r = await call({ action: "open", message_id: m.id }, deps);
  assert.equal(r.body.state, "changed");
  assert.equal(connects.length, before);
});

test("PLANTED: a different message at the same UID is not shown, not cached and not marked read", async () => {
  newWorld();
  const a = addAccount();
  // Sync recorded someone else's message at UID 101.
  const m = addMessage(a, { message_id_header: "someone-else-entirely@example.net" });
  const mb = mailbox();
  const { deps } = makeDeps({ "imappro.zoho.com": mb });
  const r = await call({ action: "open", message_id: m.id }, deps);
  assert.deepEqual(r.body, { state: "changed", message_id: m.id });
  assert.ok(!r.text.includes("Dana"), "the other message's content reached the office");
  assert.equal(uploads().length, 0);
  assert.equal(msgRow(m.id).body_state, "none");
  assert.deepEqual(flagsOf(mb, 101), [], "the wrong message was marked read");
  assert.ok(!verbs(mb).includes("UID STORE"));
});

test("PLANTED: a stored host that is not the provider's, or a custom one now pointing inside, never gets a socket or the password", async () => {
  newWorld();
  const tampered = addAccount({ imap_host: "imap.evil.example" }); // provider zoho
  const custom = addAccount({ provider: "custom", email_address: "info@tenant-example.com", username: "info@tenant-example.com", imap_host: "mail.tenant-example.com", smtp_host: "mail.tenant-example.com" });
  const m1 = addMessage(tampered);
  const m2 = addMessage(custom);
  let resolved = ["10.0.0.5"];
  const { deps, connects } = makeDeps(
    { "imap.evil.example": mailbox(), "mail.tenant-example.com": mailbox({ username: "info@tenant-example.com" }) },
    { resolver: async (host, type) => (type === "A" ? resolved : []) },
  );
  for (const m of [m1, m2]) {
    const r = await call({ action: "open", message_id: m.id }, deps);
    assert.equal(r.status, 422, r.text);
    assert.equal(r.body.error_code, "host_not_allowed");
  }
  assert.equal(connects.length, 0);
  assert.ok(!world.rpcLog.some((c) => c.name === "mail_secret_get"), "the password was read for a host that was refused");
  // Positive control: the same custom mailbox on a public address connects.
  resolved = ["93.184.216.34"];
  const ok = await call({ action: "open", message_id: m2.id, peek: true }, deps);
  assert.equal(ok.body.state, "ok", ok.text);
  assert.deepEqual(connects.map((c) => c.hostname), ["mail.tenant-example.com"]);
});

// ===========================================================================
// Read and unread
// ===========================================================================

test("mark: unread and read again, in the mailbox first; only a change costs a sign-in", async () => {
  newWorld();
  const a = addAccount();
  const m = addMessage(a, { uid: 102, message_id_header: REPLY_MID, body_state: "cached", body_text: "x", is_seen: true });
  const mb = mailbox();
  const { deps, connects } = makeDeps({ "imappro.zoho.com": mb });

  let r = await call({ action: "mark", message_id: m.id, seen: false }, deps);
  assert.deepEqual(r.body, { state: "ok", message_id: m.id, is_seen: false });
  assert.deepEqual(verbs(mb), ["LOGIN", "SELECT", "UID STORE", "LOGOUT"]);
  assert.ok(mb.log.some((l) => /UID STORE 102 -FLAGS\.SILENT \(\\Seen\)$/.test(l)));
  assert.deepEqual(flagsOf(mb, 102), []);
  assert.equal(msgRow(m.id).is_seen, false);

  r = await call({ action: "mark", message_id: m.id, seen: false }, deps);
  assert.equal(r.body.is_seen, false);
  assert.equal(connects.length, 1, "a mark that changes nothing signed in anyway");

  r = await call({ action: "mark", message_id: m.id, seen: true }, deps);
  assert.equal(r.body.is_seen, true);
  assert.deepEqual(flagsOf(mb, 102), ["\\Seen"]);
  assert.equal(msgRow(m.id).is_seen, true);

  // Sent mail is always read; saying otherwise would be undone by sync.
  const sentRow = addMessage(a, { folder_role: "sent", uidvalidity: 2002, uid: 7, is_seen: true });
  r = await call({ action: "mark", message_id: sentRow.id, seen: false }, deps);
  assert.equal(r.status, 400);
});

test("PLANTED: a loop of read/unread marks cannot become a stream of sign-ins that gets the mailbox locked", async () => {
  newWorld();
  const a = addAccount();
  const m = addMessage(a, { uid: 102, message_id_header: REPLY_MID, body_state: "cached", body_text: "x", is_seen: true });
  const mb = mailbox();
  const { deps, connects } = makeDeps({ "imappro.zoho.com": mb });
  const answers = [];
  for (let i = 0; i < MESSAGE_SESSIONS_PER_MINUTE + 5; i++) {
    // Always the opposite of what the row says, so every call is a real change.
    answers.push(await call({ action: "mark", message_id: m.id, seen: !msgRow(m.id).is_seen }, deps));
  }
  // Positive control: the first ones really did sign in and mark.
  assert.equal(answers[0].status, 200, answers[0].text);
  assert.equal(mb.logins, MESSAGE_SESSIONS_PER_MINUTE, "sign-ins went past the per-minute budget");
  assert.equal(connects.length, MESSAGE_SESSIONS_PER_MINUTE);
  const refused = answers.slice(MESSAGE_SESSIONS_PER_MINUTE);
  assert.ok(refused.every((r) => r.status === 429 && r.body.error_code === "rate_limited"), JSON.stringify(refused.map((r) => r.status)));
  // Refused before the password was read, and the mailbox is still fine.
  assert.equal(world.rpcLog.filter((c) => c.name === "mail_secret_get").length, MESSAGE_SESSIONS_PER_MINUTE);
  assert.equal(acctRow(a.id).status, "connected");
  assert.ok(world.mail_events.every((e) => e.company_id === C1 && e.kind === "message_session" && e.actor === UID));

  // A message FenceFlow already holds still opens; only the mark waits.
  const unread = addMessage(a, { uid: 101, body_state: "cached", body_text: "Quote attached", is_seen: false });
  const r = await call({ action: "open", message_id: unread.id }, deps);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.text, "Quote attached");
  assert.equal(r.body.mark_error, "rate_limited");
  assert.equal(r.body.is_seen, false);
  // One FenceFlow has no copy of cannot be fetched until the budget recovers.
  const fresh = addMessage(a, { uid: 101 });
  const f = await call({ action: "open", message_id: fresh.id }, deps);
  assert.equal(f.status, 429);
  assert.equal(mb.logins, MESSAGE_SESSIONS_PER_MINUTE);
});

test("the hour's budget holds even when every minute is quiet, and another company's spending is not ours", async () => {
  newWorld();
  const a = addAccount();
  const m = addMessage(a, { uid: 102, message_id_header: REPLY_MID, body_state: "cached", body_text: "x", is_seen: true });
  const mb = mailbox();
  const { deps } = makeDeps({ "imappro.zoho.com": mb });
  const earlier = Date.now() - 30 * 60_000;
  // Bravo spent a whole hour's worth: it does not count against Acme.
  for (let i = 0; i < MESSAGE_SESSIONS_PER_HOUR + 10; i++) world.mail_events.push({ company_id: C2, actor: null, kind: "message_session", at: earlier });
  let r = await call({ action: "mark", message_id: m.id, seen: false }, deps);
  assert.equal(r.status, 200, r.text);
  // Acme itself spent the hour half an hour ago, none of it this minute.
  for (let i = 0; i < MESSAGE_SESSIONS_PER_HOUR; i++) world.mail_events.push({ company_id: C1, actor: UID, kind: "message_session", at: earlier });
  r = await call({ action: "mark", message_id: m.id, seen: true }, deps);
  assert.equal(r.status, 429);
  assert.equal(r.body.error_code, "rate_limited");
  assert.equal(mb.logins, 1);
});

test("a disconnected mailbox: FenceFlow's copy still opens, an unopened message says why, and the read mark is FenceFlow's own", async () => {
  newWorld();
  const a = addAccount({ status: "disconnected" });
  world.secrets.delete(a.id);
  const never = addMessage(a);
  const kept = addMessage(a, { uid: 102, message_id_header: REPLY_MID, body_state: "cached", body_text: "Thanks Mike", is_seen: false });
  const { deps, connects } = makeDeps({ "imappro.zoho.com": mailbox() });
  let r = await call({ action: "open", message_id: never.id }, deps);
  assert.deepEqual(r.body, { state: "unavailable", message_id: never.id, reason: "disconnected" });
  r = await call({ action: "open", message_id: kept.id }, deps);
  assert.equal(r.body.state, "ok");
  assert.equal(r.body.is_seen, true);
  assert.equal(msgRow(kept.id).is_seen, true);
  r = await call({ action: "mark", message_id: kept.id, seen: false }, deps);
  assert.equal(r.body.is_seen, false);
  assert.equal(connects.length, 0);
  assert.ok(!world.rpcLog.some((c) => c.name === "mail_secret_get"));
});

// ===========================================================================
// Attachments
// ===========================================================================

test("attachment: a 60-second link that saves under the file's own name", async () => {
  newWorld();
  const a = addAccount();
  const m = addMessage(a);
  const { deps } = makeDeps({ "imappro.zoho.com": mailbox() });
  await call({ action: "open", message_id: m.id }, deps);
  const r = await call({ action: "attachment", message_id: m.id, idx: 1 }, deps);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.state, "ok");
  assert.equal(r.body.filename, "Devis cl\u{f4}ture.pdf");
  assert.equal(r.body.expires_in, SIGNED_URL_SECONDS);
  assert.equal(SIGNED_URL_SECONDS, 60);
  const s = signs();
  assert.equal(s.length, 1);
  assert.deepEqual(s[0], {
    op: "sign",
    key: "service-key",
    bucket: "mail-files",
    path: `${C1}/${a.id}/${m.id}/1-Devis_cloture.pdf`,
    expiresIn: 60,
    download: "Devis cl\u{f4}ture.pdf",
  });
  assert.ok(r.body.url.includes("download=Devis%20cl%C3%B4ture.pdf"), r.body.url);

  // "stored" with no path is not stored: it is fetched again, not refused.
  msgRow(m.id).attachments[0] = { ...msgRow(m.id).attachments[0], storage_path: null };
  const healed = await call({ action: "attachment", message_id: m.id, idx: 0 }, deps);
  assert.equal(healed.status, 200, healed.text);
  assert.equal(signs().at(-1).path, `${C1}/${a.id}/${m.id}/0-logo.png`);
  assert.equal(msgRow(m.id).attachments[0].storage_path, `${C1}/${a.id}/${m.id}/0-logo.png`);

  // An entry that does not exist, or was too large to keep.
  let bad = await call({ action: "attachment", message_id: m.id, idx: 9 }, deps);
  assert.equal(bad.status, 404);
  msgRow(m.id).attachments[3] = { ...msgRow(m.id).attachments[3], state: "too_large", storage_path: null };
  bad = await call({ action: "attachment", message_id: m.id, idx: 3 }, deps);
  assert.equal(bad.status, 413);
  assert.equal(bad.body.error_code, "too_large");
});

test("PLANTED: a row pointing outside the company's own folder never gets a link", async () => {
  newWorld();
  const a = addAccount();
  const m = addMessage(a);
  const { deps } = makeDeps({ "imappro.zoho.com": mailbox() });
  await call({ action: "open", message_id: m.id }, deps);
  // Files that exist, in another company's folder -- and a path that climbs
  // out of ours.
  world.storage.set(`mail-files/${C2}/acc/msg/0-secret.pdf`, { bytes: Buffer.from("%PDF"), contentType: "application/pdf" });
  world.storage.set(`mail-files/${C1}/../${C2}/acc/msg/0-secret.pdf`, { bytes: Buffer.from("%PDF"), contentType: "application/pdf" });
  const row = msgRow(m.id);
  row.attachments[1] = { ...row.attachments[1], storage_path: `${C2}/acc/msg/0-secret.pdf` };
  row.attachments[2] = { ...row.attachments[2], storage_path: `${C1}/../${C2}/acc/msg/0-secret.pdf` };
  for (const idx of [1, 2]) {
    const r = await call({ action: "attachment", message_id: m.id, idx }, deps);
    assert.equal(r.status, 404, r.text);
    assert.ok(!r.text.includes(C2));
  }
  assert.equal(signs().length, 0, "a link was minted outside the company's folder");
  // Positive control: an untouched entry of the same message still signs.
  const ok = await call({ action: "attachment", message_id: m.id, idx: 0 }, deps);
  assert.equal(ok.body.state, "ok");
  assert.equal(signs().length, 1);
});

test("a part whose upload failed stays pending, and asking for it fetches it again without marking anything read", async () => {
  newWorld();
  const a = addAccount();
  const m = addMessage(a);
  const mb = mailbox();
  const { deps, connects } = makeDeps({ "imappro.zoho.com": mb });
  world.failUpload.add(`${C1}/${a.id}/${m.id}/1-Devis_cloture.pdf`);
  let r = await call({ action: "open", message_id: m.id, peek: true }, deps);
  assert.equal(r.body.state, "ok");
  assert.deepEqual(r.body.attachments.map((p) => p.state), ["stored", "pending", "stored", "stored"]);
  assert.equal(msgRow(m.id).body_state, "cached", "one failed upload must not throw the body away");

  // Opening again does not refetch for it (only a click on it does).
  r = await call({ action: "open", message_id: m.id, peek: true }, deps);
  assert.equal(connects.length, 1);

  world.failUpload.clear();
  mb.log.length = 0;
  const before = uploads().length;
  r = await call({ action: "attachment", message_id: m.id, idx: 1 }, deps);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.filename, "Devis cl\u{f4}ture.pdf");
  assert.deepEqual(verbs(mb), ["LOGIN", "EXAMINE", "UID FETCH", "UID FETCH", "LOGOUT"], "fetching an attachment marked the message read");
  assert.deepEqual(uploads().slice(before).map((u) => u.path.split("/").pop()), ["1-Devis_cloture.pdf"], "parts already stored were uploaded again");
  assert.deepEqual(msgRow(m.id).attachments.map((p) => p.state), ["stored", "stored", "stored", "stored"]);
  assert.equal(msgRow(m.id).is_seen, false);
});

test("a re-fetch for an attachment never throws away the body FenceFlow already has", async () => {
  newWorld();
  const a = addAccount();
  const m = addMessage(a);
  const mb = mailbox();
  const { deps } = makeDeps({ "imappro.zoho.com": mb });
  world.failUpload.add(`${C1}/${a.id}/${m.id}/1-Devis_cloture.pdf`);
  await call({ action: "open", message_id: m.id, peek: true }, deps);
  const text = msgRow(m.id).body_text;
  assert.ok(text);
  // The server now reports the message as larger than FenceFlow opens.
  mb.folders.INBOX.messages.find((x) => x.uid === 101).size = OPEN_MESSAGE_MAX_BYTES + 5;
  world.failUpload.clear();
  const r = await call({ action: "attachment", message_id: m.id, idx: 1 }, deps);
  assert.equal(r.status, 413, r.text);
  const row = msgRow(m.id);
  assert.equal(row.body_state, "cached", "a cached body was downgraded to too_large");
  assert.equal(row.body_text, text);
  // And it still opens from FenceFlow's copy.
  const again = await call({ action: "open", message_id: m.id, peek: true }, deps);
  assert.equal(again.body.state, "ok");
  assert.equal(again.body.text, text);
});

// ===========================================================================
// FenceFlow mail replies (Resend)
// ===========================================================================

function resendAccount() {
  return addAccount({ kind: "fenceflow", provider: "resend", email_address: "mail@send.fenceflowapp.com", username: null, imap_host: null, smtp_host: null, imap_port: null, smtp_port: null, sent_folder: null, inbound_token: "a1b2c3d4e5f60718" });
}

/** A fake Resend: JSON for its API, bytes for its download links. */
function fakeResend(routes) {
  return async (url, init = {}) => {
    world.fetchLog.push({ url, method: init.method, auth: init.headers?.Authorization ?? null, redirect: init.redirect, signal: !!init.signal });
    const r = routes[url];
    if (!r) throw new TypeError(`fake: nothing at ${url}`);
    if (r.bytes) return new Response(r.bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
}

const EMAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const LIST_URL = `https://api.resend.com/emails/receiving/${EMAIL_ID}/attachments`;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);

test("PLANTED: Resend attachments come only from resend.com links, without our key and without redirects", async () => {
  newWorld();
  const acc = resendAccount();
  const m = addMessage(acc, {
    source: "resend_inbound", uid: null, uidvalidity: null, provider_message_id: EMAIL_ID, message_id_header: REPLY_MID,
    body_state: "cached", body_text: "Photos attached.", body_html: "<p>Photos attached.</p>", is_seen: false,
    attachments: [
      { idx: 0, filename: "gate.jpg", content_type: "image/jpeg", size: 10, content_id: null, disposition: "attachment", storage_path: null, state: "pending", provider_id: "att-1" },
      { idx: 1, filename: "creds.txt", content_type: "text/plain", size: 20, content_id: null, disposition: "attachment", storage_path: null, state: "pending", provider_id: "att-2" },
      { idx: 2, filename: "lookalike.pdf", content_type: "application/pdf", size: 30, content_id: null, disposition: "attachment", storage_path: null, state: "pending", provider_id: "att-3" },
    ],
  });
  const fetch = fakeResend({
    [LIST_URL]: { json: { object: "list", has_more: false, data: [
      { id: "att-1", filename: "gate.jpg", size: 10, content_type: "image/jpeg", download_url: `https://inbound-cdn.resend.com/${EMAIL_ID}/attachments/att-1?signature=s1` },
      { id: "att-2", filename: "creds.txt", size: 20, content_type: "text/plain", download_url: "http://169.254.169.254/latest/meta-data/iam" },
      { id: "att-3", filename: "lookalike.pdf", size: 30, content_type: "application/pdf", download_url: "https://resend.com.evil.example/x.pdf" },
    ] } },
    [`https://inbound-cdn.resend.com/${EMAIL_ID}/attachments/att-1?signature=s1`]: { bytes: JPEG },
    "http://169.254.169.254/latest/meta-data/iam": { bytes: Buffer.from("SECRET") },
    "https://resend.com.evil.example/x.pdf": { bytes: Buffer.from("%PDF") },
  });
  const { deps, connects } = makeDeps({}, { fetch });
  const r = await call({ action: "open", message_id: m.id }, deps);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.text, "Photos attached.");
  assert.deepEqual(r.body.attachments.map((p) => p.state), ["stored", "pending", "pending"]);
  assert.equal(r.body.is_seen, true);

  const urls = world.fetchLog.map((f) => f.url);
  assert.ok(!urls.some((u) => u.includes("169.254") || u.includes("evil.example")), `fetched: ${urls.join(" ")}`);
  const list = world.fetchLog.find((f) => f.url === LIST_URL);
  assert.equal(list.auth, `Bearer ${RESEND_KEY}`);
  const dl = world.fetchLog.find((f) => f.url.startsWith("https://inbound-cdn.resend.com/"));
  assert.equal(dl.auth, null, "our Resend key was sent to a download link");
  for (const f of world.fetchLog) {
    assert.equal(f.redirect, "error");
    assert.equal(f.signal, true, "a request without a timeout");
  }
  const up = uploads();
  assert.deepEqual(up.map((u) => [u.path, u.contentType]), [[`${C1}/${acc.id}/${m.id}/0-gate.jpg`, "image/jpeg"]]);
  assert.deepEqual(world.storage.get(`mail-files/${C1}/${acc.id}/${m.id}/0-gate.jpg`).bytes, JPEG);
  const row = msgRow(m.id);
  assert.deepEqual(row.attachments.map((p) => p.state), ["stored", "pending", "pending"]);
  assert.equal(row.is_seen, true);
  assert.equal(connects.length, 0);
  assert.ok(!r.text.includes(RESEND_KEY));
});

test("PLANTED: opening a reply with a stuck attachment over and over does not spend Resend without limit", async () => {
  newWorld();
  const acc = resendAccount();
  const m = addMessage(acc, {
    source: "resend_inbound", uid: null, uidvalidity: null, provider_message_id: EMAIL_ID, message_id_header: REPLY_MID,
    body_state: "cached", body_text: "Photos attached.", is_seen: true,
    attachments: [{ idx: 0, filename: "gate.jpg", content_type: "image/jpeg", size: 10, content_id: null, disposition: "attachment", storage_path: null, state: "pending", provider_id: "att-1" }],
  });
  // Resend lists the attachment but its link never works: it stays pending.
  const fetch = fakeResend({
    [LIST_URL]: { json: { object: "list", has_more: false, data: [
      { id: "att-1", filename: "gate.jpg", size: 10, content_type: "image/jpeg", download_url: "https://inbound-cdn.resend.com/a/att-1?sig=gone" },
    ] } },
  });
  const { deps } = makeDeps({}, { fetch });
  for (let i = 0; i < MESSAGE_SESSIONS_PER_MINUTE + 10; i++) {
    const r = await call({ action: "open", message_id: m.id }, deps);
    // The text always opens, budget or not.
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.text, "Photos attached.");
    assert.equal(r.body.attachments[0].state, "pending");
  }
  const lists = world.fetchLog.filter((f) => f.url === LIST_URL).length;
  assert.equal(lists, MESSAGE_SESSIONS_PER_MINUTE, `Resend was asked ${lists} times`);
  // Asking for the file itself says to wait, rather than asking Resend again.
  const att = await call({ action: "attachment", message_id: m.id, idx: 0 }, deps);
  assert.equal(att.status, 429);
  assert.equal(world.fetchLog.filter((f) => f.url === LIST_URL).length, lists);
});

test("a FenceFlow mail reply with no cached text is fetched again from Resend; with no receiving key it says so", async () => {
  newWorld();
  const acc = resendAccount();
  const m = addMessage(acc, {
    source: "resend_inbound", uid: null, uidvalidity: null, provider_message_id: EMAIL_ID, message_id_header: REPLY_MID,
    body_state: "none", attachments: [],
  });
  const fetch = fakeResend({
    [`https://api.resend.com/emails/receiving/${EMAIL_ID}`]: { json: {
      object: "email", id: EMAIL_ID, html: "<p>Can you start the <b>28th</b>?</p><script>x()</script>", text: null,
      attachments: [{ id: "att-9", filename: "site.jpg", content_type: "image/jpeg", content_disposition: "inline", content_id: "img001", size: 10 }],
    } },
    [LIST_URL]: { json: { object: "list", has_more: false, data: [
      { id: "att-9", filename: "site.jpg", size: 10, content_type: "image/jpeg", content_disposition: "inline", content_id: "img001", download_url: "https://inbound-cdn.resend.com/a/att-9?sig=1" },
    ] } },
    "https://inbound-cdn.resend.com/a/att-9?sig=1": { bytes: JPEG },
  });
  const saved = ENV.RESEND_RECEIVING_KEY;
  delete ENV.RESEND_RECEIVING_KEY;
  try {
    const off = await call({ action: "open", message_id: m.id }, makeDeps({}, { fetch }).deps);
    assert.equal(off.status, 503);
    assert.equal(off.body.error_code, "not_configured");
    assert.equal(world.fetchLog.length, 0);
  } finally {
    ENV.RESEND_RECEIVING_KEY = saved;
  }

  const r = await call({ action: "open", message_id: m.id }, makeDeps({}, { fetch }).deps);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.state, "ok");
  assert.ok(r.body.html.includes("<b>28th</b>"));
  // HTML-only mail still gets plain text and a preview, and neither carries
  // the script.
  assert.match(r.body.text, /Can you start the 28th\?/);
  assert.ok(!r.body.text.includes("x()"));
  assert.deepEqual(r.body.attachments.map((p) => [p.idx, p.filename, p.disposition, p.state]), [[0, "site.jpg", "inline", "stored"]]);
  assert.match(r.body.inline_images.img001, /^data:image\/jpeg;base64,/);
  const row = msgRow(m.id);
  assert.equal(row.body_state, "cached");
  assert.equal(row.attachments[0].provider_id, "att-9");
  assert.equal(row.snippet, "Can you start the 28th?");
});

// ===========================================================================
// Inline pictures versus downloads
// ===========================================================================

const PNG_1 = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

test("PLANTED: every part is either a picture in inline_images or listed as a download, never neither", async () => {
  newWorld();
  const a = addAccount();
  const m = addMessage(a, { body_state: "cached", body_text: "See the pictures.", body_html: '<img src="cid:a@x"><img src="cid:b@x"><img src="cid:c@x">', is_seen: true });
  const dir = `${C1}/${a.id}/${m.id}`;
  const big = Buffer.alloc(600 * 1024, 1);
  world.storage.set(`mail-files/${dir}/0-a.png`, { bytes: PNG_1, contentType: "image/png" });
  world.storage.set(`mail-files/${dir}/2-c.png`, { bytes: big, contentType: "image/png" });
  msgRow(m.id).attachments = [
    // Stored and small: shown.
    { idx: 0, filename: "a.png", content_type: "image/png", size: PNG_1.length, content_id: "a@x", disposition: "inline", storage_path: `${dir}/0-a.png`, state: "stored" },
    // Its upload failed: nothing to show, so it must be a (pending) download.
    { idx: 1, filename: "b.png", content_type: "image/png", size: 12, content_id: "b@x", disposition: "inline", storage_path: null, state: "pending" },
    // Written by a looser writer: over the per-picture cap, never inlined.
    { idx: 2, filename: "c.png", content_type: "image/png", size: big.length, content_id: "c@x", disposition: "inline", storage_path: `${dir}/2-c.png`, state: "stored" },
  ];
  const { deps, connects } = makeDeps({});
  const r = await call({ action: "open", message_id: m.id }, deps);
  assert.equal(r.status, 200, r.text);
  assert.equal(connects.length, 0);
  assert.deepEqual(Object.keys(r.body.inline_images), ["a@x"], "positive control: the one picture that can be shown is");
  assert.deepEqual(r.body.attachments.map((p) => [p.idx, p.disposition, p.state]), [[0, "inline", "stored"], [1, "attachment", "pending"], [2, "attachment", "stored"]]);
  // The rule itself: "inline" in the list means "in inline_images".
  const inlineIds = r.body.attachments.filter((p) => p.disposition === "inline").map((p) => p.content_id);
  assert.deepEqual(inlineIds, Object.keys(r.body.inline_images));
  // The oversized picture was never downloaded to be shown.
  assert.ok(!world.storageLog.some((s) => s.op === "download" && s.path.endsWith("/2-c.png")));
});

test("Resend parts: inline by the same rule as IMAP mail, and a picture larger than claimed becomes a download", async () => {
  const pic = (id, cid, size, type = "image/png") => ({ id, filename: `${id}.png`, content_type: type, content_disposition: "inline", content_id: cid, size });
  const list = [
    pic("r1", "a", 100),
    pic("r2", "a", 100), // the same Content-ID again
    pic("r3", "s", 10, "image/svg+xml"), // a document, not a picture
    pic("r4", "n", null), // size unknown
    ...[5, 6, 7, 8, 9].map((n) => pic(`r${n}`, `p${n}`, 520_000)), // the fifth passes the 2 MB total
  ];
  const parts = fn.partsFromResend(list);
  assert.deepEqual(parts.map((p) => [p.provider_id, p.disposition]), [
    ["r1", "inline"], ["r2", "attachment"], ["r3", "attachment"], ["r4", "attachment"],
    ["r5", "inline"], ["r6", "inline"], ["r7", "inline"], ["r8", "inline"], ["r9", "attachment"],
  ]);
  assert.ok(parts.every((p) => p.state === "pending" && p.storage_path === null));

  newWorld();
  const acc = resendAccount();
  const m = addMessage(acc, {
    source: "resend_inbound", uid: null, uidvalidity: null, provider_message_id: EMAIL_ID, message_id_header: REPLY_MID,
    body_state: "cached", body_text: "Site photo.", body_html: '<img src="cid:img002">', is_seen: true,
    attachments: [{ idx: 0, filename: "site.png", content_type: "image/png", size: 10, content_id: "img002", disposition: "inline", storage_path: null, state: "pending", provider_id: "att-7" }],
  });
  const huge = Buffer.alloc(600 * 1024, 7);
  const fetch = fakeResend({
    [LIST_URL]: { json: { object: "list", has_more: false, data: [
      { id: "att-7", filename: "site.png", size: 10, content_type: "image/png", content_disposition: "inline", content_id: "img002", download_url: "https://inbound-cdn.resend.com/a/att-7?sig=1" },
    ] } },
    "https://inbound-cdn.resend.com/a/att-7?sig=1": { bytes: huge },
  });
  const r = await call({ action: "open", message_id: m.id }, makeDeps({}, { fetch }).deps);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.attachments.map((p) => [p.disposition, p.state, p.size]), [["attachment", "stored", huge.length]]);
  assert.deepEqual(Object.keys(r.body.inline_images), []);
  assert.equal(msgRow(m.id).attachments[0].disposition, "attachment", "the row still claims it is an inline picture");
});

test("a message with nowhere to fetch it from says so rather than showing an empty body", async () => {
  newWorld();
  const acc = resendAccount();
  const m = addMessage(acc, { folder_role: "sent", source: "fenceflow_send", uid: null, uidvalidity: null, body_state: "none", is_seen: true });
  const r = await call({ action: "open", message_id: m.id }, makeDeps({}).deps);
  assert.deepEqual(r.body, { state: "unavailable", message_id: m.id, reason: "no_copy" });
});

// ===========================================================================
// Last: what FenceFlow ever said to a mailbox, across every test above.
// ===========================================================================

test("PLANTED: across every session in this file, nothing but reading and \\Seen was ever sent to a mailbox", () => {
  assert.ok(ALL_COMMANDS.length > 40, "the earlier tests did not run");
  const allowed = [
    /^A\d+ LOGIN \[hidden by the fake\]$/,
    /^A\d+ CAPABILITY$/,
    /^A\d+ (SELECT|EXAMINE) "[^"]+"$/,
    /^A\d+ UID FETCH \d+ \(UID FLAGS RFC822\.SIZE\)$/,
    /^A\d+ UID FETCH \d+ \(UID BODY\.PEEK\[\]\)$/,
    /^A\d+ UID STORE \d+ [+-]FLAGS\.SILENT \(\\Seen\)$/,
    /^A\d+ LOGOUT$/,
  ];
  const odd = ALL_COMMANDS.filter((c) => !allowed.some((re) => re.test(c)));
  assert.deepEqual(odd, []);
  // Positive control: the check does catch a destructive command.
  for (const bad of ["A9 UID STORE 5 +FLAGS.SILENT (\\Deleted)", "A9 EXPUNGE", "A9 UID MOVE 5 Trash", "A9 UID FETCH 5 (BODY[])"]) {
    assert.ok(!allowed.some((re) => re.test(bad)), bad);
  }
});

// ===========================================================================
// Optional: capture the exact writes for the rolled-back SQL contract check.
// ===========================================================================

test("capture payloads for the SQL contract check (only when MAIL_MESSAGE_CAPTURE is set)", { skip: !process.env.MAIL_MESSAGE_CAPTURE && "MAIL_MESSAGE_CAPTURE not set" }, async () => {
  newWorld();
  const a = addAccount();
  const m = addMessage(a);
  const mb = mailbox();
  const { deps } = makeDeps({ "imappro.zoho.com": mb });
  await call({ action: "open", message_id: m.id }, deps);
  await call({ action: "mark", message_id: m.id, seen: false }, deps);
  const big = addMessage(a, { uid: 150, size_bytes: OPEN_MESSAGE_MAX_BYTES + 1 });
  await call({ action: "open", message_id: big.id }, deps);
  const liar = addMessage(a, { uid: 102, message_id_header: REPLY_MID });
  mb.folders.INBOX.messages.find((x) => x.uid === 102).size = 12 * 1024 * 1024;
  await call({ action: "open", message_id: liar.id }, deps);
  const removed = addMessage(a, { uid: 777 });
  await call({ action: "open", message_id: removed.id }, deps);
  const bad = addAccount({ password: WRONG, email_address: "sales@acmefence.com", username: "sales@acmefence.com" });
  const locked = addMessage(bad);
  mb.username = "sales@acmefence.com";
  await call({ action: "open", message_id: locked.id }, deps);

  const acc = resendAccount();
  const rm = addMessage(acc, { source: "resend_inbound", uid: null, uidvalidity: null, provider_message_id: EMAIL_ID, message_id_header: REPLY_MID, body_state: "none", attachments: [] });
  const fetch = fakeResend({
    [`https://api.resend.com/emails/receiving/${EMAIL_ID}`]: { json: { object: "email", id: EMAIL_ID, html: "<p>Start the 28th?</p>", text: null,
      attachments: [{ id: "att-9", filename: "site.jpg", content_type: "image/jpeg", content_disposition: "inline", content_id: "img001", size: 10 }] } },
    [LIST_URL]: { json: { object: "list", has_more: false, data: [{ id: "att-9", filename: "site.jpg", size: 10, content_type: "image/jpeg", download_url: "https://inbound-cdn.resend.com/a/att-9?sig=1" }] } },
    "https://inbound-cdn.resend.com/a/att-9?sig=1": { bytes: JPEG },
  });
  await call({ action: "open", message_id: rm.id }, makeDeps({}, { fetch }).deps);

  const writes = world.queryLog.filter((q) => q.key === "service-key" && q.op === "update");
  const pick = (table, pred) => writes.filter((w) => w.table === table && pred(w.patch)).map((w) => w.patch);
  writeFileSync(process.env.MAIL_MESSAGE_CAPTURE, JSON.stringify({
    cached: pick("mail_messages", (x) => x.body_state === "cached" && Array.isArray(x.attachments) && x.attachments.length === 4)[0],
    seen: pick("mail_messages", (x) => Object.keys(x).join() === "is_seen")[0],
    too_large_size: pick("mail_messages", (x) => x.body_state === "too_large" && !("size_bytes" in x))[0],
    too_large_server: pick("mail_messages", (x) => x.body_state === "too_large" && "size_bytes" in x)[0],
    resend: pick("mail_messages", (x) => x.body_state === "cached" && Array.isArray(x.attachments) && x.attachments.length === 1)[0],
    refusal: pick("mail_accounts", (x) => x.status === "auth_failed")[0],
    refusal_filters: writes.find((w) => w.table === "mail_accounts" && w.patch.status === "auth_failed").filters,
    mark_gone: world.rpcLog.find((c) => c.name === "mail_mark_gone").args,
    // The function's own column list, so a column it starts reading is
    // checked against the real table too.
    message_columns: fn.MESSAGE_COLUMNS,
  }, null, 1));
});
