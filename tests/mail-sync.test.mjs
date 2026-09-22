// mail-sync, called the way the gateway calls it. No network, no Deno, no
// live Supabase, and no real password anywhere.
//
// Run with:  node --test tests/mail-sync.test.mjs
//
// The real handler (supabase/functions/mail-sync/index.ts) runs unmodified
// on top of three fakes:
//
//  - Supabase. caller.ts imports supabase-js from esm.sh, which Node cannot
//    fetch, so a module hook swaps that one URL for a fake client over an
//    in-memory database (the same trick as tests/mail-errors.test.mjs). Its
//    RPCs follow supabase_mail.sql's contract -- including the KEY NAMES
//    mail_ingest and mail_set_flags read, so a payload the real function
//    would silently ignore is ignored here too -- and updating a
//    mail_accounts row bumps updated_at as the table's trigger does. The
//    user-token client applies the read policy (own company AND the gate).
//  - A mailbox. FakeImapServer is a model, not a script: folders with a
//    UIDVALIDITY and messages with UIDs, dates, flags and header blocks,
//    answering the commands imap-client.ts sends -- including the real "*"
//    semantics, where "UID FETCH 105:*" with nothing above 104 returns 104.
//    The real StreamTransport and ImapClient run on top of it.
//  - The clock, the resolver and the reach probe's TCP connect.
//
// Planted cases (each marked PLANTED) are the failures this function exists
// to prevent: a refused password leaking into last_error or being retried by
// the schedule; the scheduled answer (printed in a PUBLIC workflow log)
// naming an account; a custom host re-pointed at a private address getting a
// socket; a crash advancing the folder state past mail it never stored; a
// disconnect undone by a sync that was already running; the workflow passing
// an ok:false answer, or failing when simply not configured.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamTransport } from "../supabase/functions/_shared/mail/tls-transport.ts";
import { MailError } from "../supabase/functions/_shared/mail/errors.ts";
import {
  ERROR_BACKOFF_MINUTES,
  HEADER_BLOCK_MAX_BYTES,
  HEADER_FETCH_BATCH,
  MANUAL_SYNC_LOCK_SECONDS,
  OFFICE_SYNC_BUDGET_MS,
  SESSION_BYTE_CAP,
  TRIGGER_SYNC_MAX_ACCOUNTS,
} from "../supabase/functions/_shared/mail/limits.ts";

// ===========================================================================
// Fake Supabase
// ===========================================================================

const SUPABASE_JS = "https://esm.sh/@supabase/supabase-js@2.39.0";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === SUPABASE_JS) {
      const src = "export const createClient = (...a) => globalThis.__mailSyncCreateClient(...a);";
      return { url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const TRIGGER_SECRET = "trigger-secret-for-tests-only-0123456789abcdef";
const ENV = {
  SUPABASE_URL: "https://project.example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  MAIL_SYNC_TRIGGER_SECRET: TRIGGER_SECRET,
};
globalThis.Deno = { env: { get: (k) => ENV[k] } };

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl";
const UID = "11111111-1111-4111-8111-111111111111";
const C1 = "22222222-2222-4222-8222-222222222222";
const C2 = "22222222-2222-4222-8222-2222222222c2";
// Shaped like a Zoho app password (16 characters), and fake.
const PASSWORD = "k7Qp2mX9vR4tZw8L";
const WRONG = "Wr0ngPassw0rd123";

let world;
let idSeq = 0;
const newId = (prefix = "a") => `${prefix.padEnd(8, "0").slice(0, 8)}-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`;

function newWorld() {
  world = {
    tick: 0,
    created: [],
    rpcLog: [],
    queryLog: [],
    gate: true,
    profiles: [{ id: UID, company_id: C1, role: "OWNER" }],
    companies: [{ id: C1, name: "Acme Fence", email: "office@acmefence.com" }],
    allowed: new Map(),
    mail_accounts: [],
    mail_folder_state: [],
    mail_messages: [],
    secrets: new Map(),
    failRpc: new Set(),
    hooks: {},
  };
}

/** A fresh, unique timestamp: what the mail_accounts trigger puts in updated_at. */
const stamp = () => new Date(Date.now() + ++world.tick).toISOString();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

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
    last_synced_at: null,
    sync_lock_until: null,
    updated_at: null,
    ...over,
  };
  row.updated_at = stamp();
  world.mail_accounts.push(row);
  world.secrets.set(row.id, over.password ?? PASSWORD);
  delete row.password;
  return row;
}

const acct = (id) => world.mail_accounts.find((a) => a.id === id);
const same = (a, b) => String(a) === String(b);

function compare(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function makeQuery(table, key) {
  const st = { op: "select", filters: [], log: [], order: null, limit: null, patch: null, row: null, onConflict: null, returning: false };
  const add = (op, col, val, fn) => {
    st.log.push([op, col, val]);
    st.filters.push(fn);
    return q;
  };
  const q = {
    select(cols) {
      if (st.op !== "select") st.returning = true;
      st.cols = cols;
      return q;
    },
    eq: (c, v) => add("eq", c, v, (r) => r[c] !== null && r[c] !== undefined && same(r[c], v)),
    // SQL: NULL <> x is not true, so NULLs never pass a neq.
    neq: (c, v) => add("neq", c, v, (r) => r[c] !== null && r[c] !== undefined && !same(r[c], v)),
    in: (c, vs) => add("in", c, vs, (r) => vs.some((v) => same(r[c], v))),
    is: (c, v) => add("is", c, v, (r) => (r[c] ?? null) === v),
    not: (c, op, v) => {
      if (op !== "is") throw new Error(`fake: unsupported not(${op})`);
      return add("not.is", c, v, (r) => (r[c] ?? null) !== v);
    },
    lt: (c, v) => add("lt", c, v, (r) => r[c] !== null && r[c] !== undefined && compare(r[c], v) < 0),
    order(c, { ascending = true, nullsFirst = false } = {}) {
      st.order = { c, ascending, nullsFirst };
      return q;
    },
    limit(n) {
      st.limit = n;
      return q;
    },
    update(patch) {
      st.op = "update";
      st.patch = patch;
      return q;
    },
    upsert(row, opts = {}) {
      st.op = "upsert";
      st.row = row;
      st.onConflict = opts.onConflict;
      return q;
    },
    maybeSingle: () => run(true),
    then: (res, rej) => run(false).then(res, rej),
  };

  async function run(single) {
    world.queryLog.push({ table, key, op: st.op, filters: st.log });
    let rows = world[table];
    if (!Array.isArray(rows)) throw new Error(`fake: no table ${table}`);
    if (key === "anon-key") {
      if (st.op !== "select") return { data: null, error: { code: "42501", message: "permission denied" } };
      if (table.startsWith("mail_")) {
        // The read policy: own company AND can_use_company_mail().
        const me = world.profiles.find((p) => p.id === UID);
        rows = world.gate ? rows.filter((r) => r.company_id === me?.company_id) : [];
      }
    }
    if (st.op === "upsert") {
      const keys = String(st.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!keys.length) throw new Error("fake: upsert without onConflict");
      const hit = rows.find((r) => keys.every((k) => same(r[k], st.row[k])));
      if (hit) Object.assign(hit, clone(st.row));
      else rows.push(clone(st.row));
      return { data: null, error: null };
    }
    let matched = rows.filter((r) => st.filters.every((f) => f(r)));
    if (st.op === "update") {
      for (const r of matched) {
        Object.assign(r, clone(st.patch));
        if (table === "mail_accounts") r.updated_at = stamp();
      }
      return { data: st.returning ? matched.map(clone) : null, error: null };
    }
    if (st.order) {
      const { c, ascending, nullsFirst } = st.order;
      matched = [...matched].sort((a, b) => {
        const an = a[c] === null || a[c] === undefined;
        const bn = b[c] === null || b[c] === undefined;
        if (an || bn) return an && bn ? 0 : an === nullsFirst ? -1 : 1;
        return ascending ? compare(a[c], b[c]) : compare(b[c], a[c]);
      });
    }
    if (st.limit !== null) matched = matched.slice(0, st.limit);
    const data = matched.map(clone);
    return single ? { data: data[0] ?? null, error: null } : { data, error: null };
  }
  return q;
}

// --- RPCs, following supabase_mail.sql -----------------------------------

const rpcError = (message, code = "22023") => ({ data: null, error: { code, message } });
const UINT = /^[0-9]{1,18}$/;

function fakeIngest({ p_account, p_rows }) {
  const a = acct(p_account);
  if (!a) return rpcError("Unknown mail account", "P0002");
  if (!Array.isArray(p_rows)) return rpcError("p_rows must be a JSON array");
  if (p_rows.length > 500) return rpcError("At most 500 messages per call");
  // Validate everything first: the real function is one transaction.
  for (const r of p_rows) {
    if (!r || typeof r !== "object") return rpcError("Each message must be a JSON object");
    if (!["inbox", "sent"].includes(r.folder_role)) return rpcError("folder_role must be inbox or sent");
    if (!["imap", "resend_inbound", "fenceflow_send"].includes(r.source)) return rpcError("Unknown source");
    if (r.source === "imap" && a.kind !== "imap") return rpcError("wrong source for account");
    if (r.source === "imap" && !(UINT.test(String(r.uid)) && UINT.test(String(r.uidvalidity)))) {
      return rpcError("An IMAP message needs uid and uidvalidity");
    }
  }
  const own = world.mail_accounts.filter((x) => x.company_id === a.company_id).map((x) => x.email_address);
  const out = [];
  for (const r of p_rows) {
    const uid = Number(r.uid);
    const uidv = Number(r.uidvalidity);
    const mid = r.message_id_header ? String(r.message_id_header).replace(/^[<\s]+|[>\s]+$/g, "") : null;
    let hit = world.mail_messages.find((m) => m.account_id === a.id && m.folder_role === r.folder_role && m.uidvalidity === uidv && m.uid === uid);
    if (hit) {
      out.push({ message_id: hit.id, thread_id: hit.thread_id, inserted: false });
      continue;
    }
    // Re-bind: the same message under an older UIDVALIDITY takes its new UID.
    hit = mid && world.mail_messages.find((m) => m.account_id === a.id && m.folder_role === r.folder_role &&
      m.message_id_header === mid && m.uid !== null && m.uidvalidity !== uidv);
    if (hit) {
      Object.assign(hit, { uidvalidity: uidv, uid, server_gone_at: null });
      out.push({ message_id: hit.id, thread_id: hit.thread_id, inserted: false });
      continue;
    }
    const row = {
      id: newId("msg"),
      thread_id: newId("thr"),
      company_id: a.company_id,
      account_id: a.id,
      folder_role: r.folder_role,
      source: r.source,
      uidvalidity: uidv,
      uid,
      message_id_header: mid,
      subject: String(r.subject ?? ""),
      from_address: r.from_address ?? null,
      counterpart_emails: (Array.isArray(r.counterpart_emails) ? r.counterpart_emails : [])
        .map((c) => String(c).trim().toLowerCase()).filter((c) => !own.includes(c)),
      received_at: r.received_at,
      // The real function reads these keys as booleans and nothing else.
      is_seen: typeof r.is_seen === "boolean" ? r.is_seen : r.folder_role === "sent",
      is_answered: typeof r.is_answered === "boolean" ? r.is_answered : false,
      is_flagged: typeof r.is_flagged === "boolean" ? r.is_flagged : false,
      body_state: r.body_state ?? "none",
      server_gone_at: null,
    };
    world.mail_messages.push(row);
    out.push({ message_id: row.id, thread_id: row.thread_id, inserted: true });
  }
  return { data: out, error: null };
}

function fakeSetFlags({ p_account, p_role, p_uidvalidity, p_flags }) {
  if (!Array.isArray(p_flags)) return rpcError("p_flags must be a JSON array of at most 10000 entries");
  let n = 0;
  for (const e of p_flags) {
    if (!UINT.test(String(e?.uid))) continue;
    const m = world.mail_messages.find((x) => x.account_id === p_account && x.folder_role === p_role &&
      x.uidvalidity === Number(p_uidvalidity) && x.uid === Number(e.uid));
    if (!m) continue;
    // mail_set_flags reads seen / answered / flagged -- not is_seen.
    if (typeof e.seen === "boolean") m.is_seen = e.seen;
    if (typeof e.answered === "boolean") m.is_answered = e.answered;
    if (typeof e.flagged === "boolean") m.is_flagged = e.flagged;
    m.server_gone_at = null;
    n++;
  }
  return { data: n, error: null };
}

function fakeMarkGone({ p_account, p_role, p_uidvalidity, p_uids }) {
  if (!Array.isArray(p_uids)) return rpcError("p_uids");
  let n = 0;
  for (const m of world.mail_messages) {
    if (m.account_id === p_account && m.folder_role === p_role && m.uidvalidity === Number(p_uidvalidity) &&
      p_uids.map(Number).includes(m.uid) && m.server_gone_at === null) {
      m.server_gone_at = new Date().toISOString();
      n++;
    }
  }
  return { data: n, error: null };
}

function fakeClaim({ p_account, p_seconds }) {
  const a = acct(p_account);
  const secs = Math.min(Math.max(Number(p_seconds) || 60, 1), 900);
  if (!a || a.kind !== "imap" || a.status === "disconnected") return { data: false, error: null };
  if (a.sync_lock_until && Date.parse(a.sync_lock_until) >= Date.now()) return { data: false, error: null };
  a.sync_lock_until = new Date(Date.now() + secs * 1000).toISOString();
  a.updated_at = stamp();
  return { data: true, error: null };
}

globalThis.__mailSyncCreateClient = (url, key, options) => {
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
        return name === "can_use_company_mail" ? { data: world.gate, error: null } : rpcError("permission denied", "42501");
      }
      if (world.hooks[name]) world.hooks[name](args);
      if (world.failRpc.has(name)) return rpcError("boom", "XX000");
      switch (name) {
        case "mail_claim_sync":
          return fakeClaim(args);
        case "mail_secret_get":
          return { data: world.secrets.get(args.p_account) ?? null, error: null };
        case "mail_ingest":
          return fakeIngest(args);
        case "mail_set_flags":
          return fakeSetFlags(args);
        case "mail_mark_gone":
          return fakeMarkGone(args);
        case "company_allowed":
          return { data: world.allowed.get(args.cid) ?? true, error: null };
        default:
          return rpcError(`fake: no rpc ${name}`, "PGRST202");
      }
    },
    from: (table) => makeQuery(table, key),
  };
};

const sync = await import("../supabase/functions/mail-sync/index.ts");

// ===========================================================================
// Fake mailbox
// ===========================================================================

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");
const internalDate = (d) =>
  `${pad(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);

function header({ from = "Jane Customer <jane@example.org>", to = "office@acmefence.com", subject, mid, inReplyTo = null, date = new Date() }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${mid}>`,
    ...(inReplyTo ? [`In-Reply-To: <${inReplyTo}>`] : []),
    "",
    "",
  ].join("\r\n");
}

function msg(uid, subject, { days = 1, flags = [], mid = `m${uid}.${subject.replace(/\W+/g, "-")}@example.org`, from } = {}) {
  const date = daysAgo(days);
  return { uid, date, flags: [...flags], header: header({ subject, mid, date, ...(from ? { from } : {}) }), size: 1200 + uid };
}

/** A Zoho-shaped mailbox. Shared by every connection made to it. */
function mailbox(over = {}) {
  return {
    username: "office@acmefence.com",
    password: PASSWORD,
    greetingCaps: true,
    folders: {
      INBOX: {
        uidValidity: 1001,
        messages: [
          msg(100, "Old news from last season", { days: 45 }),
          msg(101, "Fence quote for 12 Oak St", { days: 6 }),
          msg(102, "Re: Gate width", { days: 4 }),
          msg(103, "Deposit sent", { days: 2 }),
          msg(104, "Photos of the old fence", { days: 1, flags: ["\\Flagged"] }),
        ],
      },
      Sent: {
        uidValidity: 2002,
        special: "\\Sent",
        messages: [msg(7, "Your quote from Acme Fence", { days: 5, from: "Acme Fence <office@acmefence.com>" }),
                   msg(8, "Install date confirmed", { days: 3, from: "Acme Fence <office@acmefence.com>" })],
      },
    },
    log: [],
    logins: 0,
    ...over,
  };
}

function parseSet(set, folder) {
  const max = folder.messages.reduce((m, x) => Math.max(m, x.uid), 0);
  const val = (s) => (s === "*" ? max : Number(s));
  return set.split(",").map((part) => {
    const [a, b] = part.split(":");
    const lo = val(a);
    const hi = b === undefined ? lo : val(b);
    return [Math.min(lo, hi), Math.max(lo, hi)];
  });
}
const inSet = (uid, ranges) => ranges.some(([lo, hi]) => uid >= lo && uid <= hi);

function unquote(s) {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s);
  return m ? m[1].replace(/\\(.)/g, "$1") : s;
}

/** A ByteConn playing one IMAP server session over a mailbox model. */
class FakeImapConn {
  constructor(mb) {
    this.mb = mb;
    this.out = [];
    this.waiters = [];
    this.inBuf = "";
    this.closed = false;
    this.eof = false;
    this.selected = null;
    const caps = "IMAP4rev1 SPECIAL-USE UIDPLUS AUTH=PLAIN";
    this.send(mb.greetingCaps ? `* OK [CAPABILITY ${caps}] Fake Zoho IMAP ready` : "* OK Fake IMAP ready");
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
    const [verbRaw] = rest.split(" ");
    const verb = verbRaw.toUpperCase();
    mb.log.push(verb === "LOGIN" ? `${tag} LOGIN [hidden by the fake]` : line);

    if (verb === "CAPABILITY") {
      this.send("* CAPABILITY IMAP4rev1 SPECIAL-USE UIDPLUS AUTH=PLAIN");
      return this.send(`${tag} OK CAPABILITY completed`);
    }
    if (verb === "LOGIN") {
      mb.logins++;
      const m = /^LOGIN ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/i.exec(rest);
      if (!m) return this.send(`${tag} BAD fake: LOGIN arguments`);
      const [user, pass] = [unquote(m[1]), unquote(m[2])];
      if (user === mb.username && pass === mb.password) return this.send(`${tag} OK [CAPABILITY IMAP4rev1 SPECIAL-USE UIDPLUS] LOGIN completed`);
      // A careless server echoing what it was sent: the password must still
      // never reach anything FenceFlow stores or shows.
      return this.send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials for ${user} (${pass})`);
    }
    if (verb === "LIST") {
      for (const [name, f] of Object.entries(mb.folders)) {
        this.send(`* LIST (\\HasNoChildren${f.special ? ` ${f.special}` : ""}) "/" "${name}"`);
      }
      return this.send(`${tag} OK LIST completed`);
    }
    if (mb.hangOn && line.endsWith(mb.hangOn)) return; // a server that stops answering
    if (mb.hangWhen && mb.hangWhen(line)) return;
    if (verb === "EXAMINE" || verb === "SELECT") {
      const name = unquote(rest.slice(verbRaw.length + 1));
      const f = mb.folders[name];
      if (!f) return this.send(`${tag} NO [NONEXISTENT] No such folder`);
      this.selected = f;
      const top = f.messages.reduce((m, x) => Math.max(m, x.uid), 0);
      this.send(`* ${f.messages.length} EXISTS`);
      this.send(`* OK [UIDVALIDITY ${f.uidValidity}] UIDs valid`);
      this.send(`* OK [UIDNEXT ${top + 1}] Predicted next UID`);
      return this.send(`${tag} OK [${verb === "EXAMINE" ? "READ-ONLY" : "READ-WRITE"}] ${verb} completed`);
    }
    if (verb === "UID") {
      const f = this.selected;
      if (!f) return this.send(`${tag} BAD No folder selected`);
      const [, sub, ...args] = rest.split(" ");
      if (sub.toUpperCase() === "SEARCH") {
        let hits = [...f.messages];
        for (let k = 0; k < args.length; k++) {
          const a = args[k].toUpperCase();
          if (a === "SINCE") {
            const [d, mon, y] = args[++k].split("-");
            const since = Date.UTC(Number(y), MONTHS.indexOf(mon), Number(d));
            hits = hits.filter((x) => x.date.getTime() >= since);
          } else if (a === "UID") {
            const ranges = parseSet(args[++k], f);
            hits = hits.filter((x) => inSet(x.uid, ranges));
          } else return this.send(`${tag} BAD fake: search key ${a}`);
        }
        this.send(`* SEARCH${hits.map((x) => ` ${x.uid}`).join("")}`);
        return this.send(`${tag} OK SEARCH completed`);
      }
      if (sub.toUpperCase() === "FETCH") {
        const ranges = parseSet(args[0], f);
        const items = args.slice(1).join(" ").toUpperCase();
        f.messages.forEach((x, idx) => {
          if (!inSet(x.uid, ranges)) return;
          let head = `* ${idx + 1} FETCH (UID ${x.uid} FLAGS (${x.flags.join(" ")})`;
          if (items.includes("INTERNALDATE")) head += ` INTERNALDATE "${internalDate(x.date)}"`;
          if (items.includes("RFC822.SIZE")) head += ` RFC822.SIZE ${x.size}`;
          if (items.includes("BODY.PEEK[HEADER.FIELDS")) {
            // A partial fetch (<0.N>) is answered the way Zoho answers it:
            // the first N bytes, echoed as BODY[...]<0>.
            const partial = /\]<0\.(\d+)>/.exec(items);
            let body = Buffer.from(x.header, "latin1");
            if (partial) body = body.subarray(0, Number(partial[1]));
            mb.headerBytesSent = (mb.headerBytesSent ?? 0) + body.length;
            this.sendRaw(Buffer.concat([
              Buffer.from(`${head} BODY[HEADER.FIELDS (FROM TO CC REPLY-TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES CONTENT-TYPE)]${partial ? "<0>" : ""} {${body.length}}\r\n`, "latin1"),
              body,
              Buffer.from(")\r\n", "latin1"),
            ]));
          } else this.send(`${head})`);
        });
        return this.send(`${tag} OK FETCH completed`);
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

/** A ByteConn playing an SMTP greeting and EHLO, for the reach probe. */
class FakeSmtpConn {
  constructor(log) {
    this.log = log;
    this.out = [];
    this.waiters = [];
    this.inBuf = "";
    this.closed = false;
    this.push("220 smtp.fake.example ESMTP ready");
  }
  push(line) {
    this.out.push(Buffer.from(`${line}\r\n`));
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }
  async read(p) {
    while (this.out.length === 0) {
      if (this.closed) return null;
      await new Promise((r) => this.waiters.push(r));
    }
    const chunk = this.out.shift();
    const n = Math.min(p.length, chunk.length);
    p.set(chunk.subarray(0, n));
    if (n < chunk.length) this.out.unshift(chunk.subarray(n));
    return n;
  }
  async write(p) {
    this.inBuf += Buffer.from(p).toString();
    let i;
    while ((i = this.inBuf.indexOf("\r\n")) >= 0) {
      const line = this.inBuf.slice(0, i);
      this.inBuf = this.inBuf.slice(i + 2);
      this.log.push(line);
      if (/^EHLO /i.test(line)) {
        this.push("250-smtp.fake.example");
        this.push("250-AUTH PLAIN LOGIN");
        this.push("250-SIZE 35882577");
        this.push("250 8BITMIME");
      } else if (/^QUIT/i.test(line)) {
        this.push("221 Bye");
      } else this.push("500 fake: unexpected");
    }
    return p.length;
  }
  close() {
    this.closed = true;
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
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
      if (target instanceof Error) throw target;
      if (typeof target === "function") return new StreamTransport(target(opts), opts.limits ?? {});
      return new StreamTransport(new FakeImapConn(target), opts.limits ?? {});
    },
    resolver: over.resolver ?? (async () => []),
    tcpProbe: over.tcpProbe ?? (async () => {
      throw new MailError("timeout");
    }),
    now: over.now ?? (() => Date.now()),
    env: (k) => ENV[k],
  };
  return { deps, connects };
}

const FN_URL = "https://project.example.supabase.co/functions/v1/mail-sync";
const officeReq = (body = {}, headers = { Authorization: `Bearer ${JWT}` }) =>
  new Request(FN_URL, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const triggerReq = (body = {}, secret = TRIGGER_SECRET) =>
  new Request(FN_URL, {
    method: "POST",
    headers: { "x-fenceflow-trigger": secret, Authorization: "Bearer anon-publishable-key", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function call(req, deps) {
  const res = await sync.handleRequest(req, deps);
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}

const inbox = (accountId) => world.mail_messages.filter((m) => m.account_id === accountId && m.folder_role === "inbox");
const sent = (accountId) => world.mail_messages.filter((m) => m.account_id === accountId && m.folder_role === "sent");
const folderState = (accountId, role) => world.mail_folder_state.find((s) => s.account_id === accountId && s.role === role);
const unlock = (a) => {
  a.sync_lock_until = new Date(Date.now() - 1000).toISOString();
};
const serviceKeyUsed = () => world.created.some((c) => c.key === "service-key");

// ===========================================================================
// The doors
// ===========================================================================

test("PLANTED: the scheduled door refuses a wrong, missing or unconfigured secret before any client exists", async () => {
  const { deps, connects } = makeDeps({});
  for (const [req, status, code] of [
    [triggerReq({}, "wrong-secret"), 401, "no_session"],
    [triggerReq({}, ""), 401, "no_session"],
    [triggerReq({}, `${TRIGGER_SECRET}x`), 401, "no_session"],
  ]) {
    newWorld();
    const r = await call(req, deps);
    assert.equal(r.status, status);
    assert.equal(r.body.error_code, code);
    assert.deepEqual(world.created, [], "a Supabase client was built before the secret matched");
  }
  newWorld();
  const saved = ENV.MAIL_SYNC_TRIGGER_SECRET;
  delete ENV.MAIL_SYNC_TRIGGER_SECRET;
  try {
    // Unset on the server: even the "right" secret opens nothing.
    const r = await call(triggerReq({}, TRIGGER_SECRET), deps);
    assert.equal(r.status, 503);
    assert.equal(r.body.error_code, "not_configured");
    assert.deepEqual(world.created, []);
  } finally {
    ENV.MAIL_SYNC_TRIGGER_SECRET = saved;
  }
  assert.equal(connects.length, 0);
});

test("office door: no token, or a gate that says anything but true, touches no mailbox", async () => {
  newWorld();
  const a = addAccount();
  const mb = mailbox();
  const { deps, connects } = makeDeps({ "imappro.zoho.com": mb });
  let r = await call(officeReq({}, {}), deps);
  assert.equal(r.status, 401);
  world.gate = false;
  r = await call(officeReq(), deps);
  assert.equal(r.status, 403);
  assert.equal(r.body.error_code, "mail_forbidden");
  assert.equal(serviceKeyUsed(), false);
  assert.equal(connects.length, 0);
  assert.equal(mb.logins, 0);
  assert.equal(acct(a.id).sync_lock_until, null);
});

test("office door, first sync: the newest mail of the last 30 days from INBOX and Sent, stored and remembered", async () => {
  newWorld();
  const a = addAccount();
  const mb = mailbox();
  const { deps, connects } = makeDeps({ "imappro.zoho.com": mb });
  const before = Date.now();
  const r = await call(officeReq(), deps);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body, { accounts: [{ id: a.id, status: "connected", new: 4 }] });

  // Exactly the four inside the window; the 45-day-old one never came in.
  assert.deepEqual(inbox(a.id).map((m) => m.subject).sort(),
    ["Deposit sent", "Fence quote for 12 Oak St", "Photos of the old fence", "Re: Gate width"]);
  assert.deepEqual(sent(a.id).map((m) => m.subject).sort(), ["Install date confirmed", "Your quote from Acme Fence"]);
  assert.equal(inbox(a.id).find((m) => m.uid === 104).is_flagged, true);
  assert.ok(sent(a.id).every((m) => m.is_seen), "sent mail is never unread");
  // The company's own address never links mail to a job.
  assert.ok(world.mail_messages.every((m) => !m.counterpart_emails.includes("office@acmefence.com")));
  assert.deepEqual(inbox(a.id).find((m) => m.uid === 101).counterpart_emails, ["jane@example.org"]);

  const fi = folderState(a.id, "inbox");
  assert.deepEqual({ uidvalidity: fi.uidvalidity, last_uid: fi.last_uid, path: fi.path, initial_done: fi.initial_done },
    { uidvalidity: 1001, last_uid: 104, path: "INBOX", initial_done: true });
  assert.equal(folderState(a.id, "sent").last_uid, 8);

  const row = acct(a.id);
  assert.equal(row.status, "connected");
  assert.ok(Date.parse(row.last_synced_at) >= before);
  // The lock is shortened to the manual rate limit, counted from the start.
  const lockLeft = Date.parse(row.sync_lock_until) - before;
  assert.ok(lockLeft > 0 && lockLeft <= MANUAL_SYNC_LOCK_SECONDS * 1000 + 5_000, `lock ${lockLeft} ms`);

  // Read-only all the way: EXAMINE, BODY.PEEK, one login, nothing that changes the mailbox.
  assert.equal(mb.logins, 1);
  assert.ok(mb.log.some((l) => / EXAMINE "INBOX"$/.test(l)));
  assert.ok(!mb.log.some((l) => /\b(SELECT|STORE|EXPUNGE|DELETE|MOVE|COPY|APPEND)\b/i.test(l)), mb.log.join("\n"));
  assert.ok(mb.log.filter((l) => /UID FETCH .*BODY/.test(l)).every((l) => l.includes("BODY.PEEK[")));
  // The session was cut to fit the office's answer budget.
  assert.equal(connects.length, 1);
  assert.equal(connects[0].port, 993);
  assert.ok(connects[0].limits.sessionDeadlineMs <= OFFICE_SYNC_BUDGET_MS);
});

test("PLANTED: a quiet mailbox reports nothing new (the '*' trap); flags and removals are copied in the SQL's key names", async () => {
  newWorld();
  const a = addAccount();
  const mb = mailbox();
  const { deps } = makeDeps({ "imappro.zoho.com": mb });
  await call(officeReq(), deps);
  const rowsBefore = world.mail_messages.length;

  // In the mailbox: 102 read, 104 unflagged, 103 deleted. Nothing new.
  const f = mb.folders.INBOX;
  f.messages.find((m) => m.uid === 102).flags.push("\\Seen");
  f.messages.find((m) => m.uid === 104).flags = [];
  f.messages = f.messages.filter((m) => m.uid !== 103);
  unlock(acct(a.id));
  world.rpcLog = [];

  const r = await call(officeReq(), deps);
  assert.deepEqual(r.body.accounts[0], { id: a.id, status: "connected", new: 0 });
  assert.equal(world.mail_messages.length, rowsBefore, "the trap: message 104 came back as new");
  // "UID SEARCH UID 105:*" answered 104, and nothing was fetched or stored for it.
  assert.ok(mb.log.some((l) => /UID SEARCH UID 105:\*$/.test(l)));
  assert.ok(!world.rpcLog.some((c) => c.name === "mail_ingest"), "mail_ingest called with nothing new");

  const m = (uid) => inbox(a.id).find((x) => x.uid === uid);
  assert.equal(m(102).is_seen, true, "seen did not arrive: wrong key name?");
  assert.equal(m(104).is_flagged, false);
  assert.ok(m(103).server_gone_at, "a removed message was not hidden");
  assert.equal(m(101).server_gone_at, null);
  const flagCall = world.rpcLog.find((c) => c.name === "mail_set_flags" && c.args.p_role === "inbox");
  assert.ok(flagCall.args.p_flags.every((e) => "seen" in e && !("is_seen" in e)));

  // Then one new message: exactly one new row, and last_uid moves to it.
  f.messages.push(msg(105, "Can you start Monday?", { days: 0 }));
  unlock(acct(a.id));
  const r2 = await call(officeReq(), deps);
  assert.equal(r2.body.accounts[0].new, 1);
  assert.equal(folderState(a.id, "inbox").last_uid, 105);
  assert.equal(inbox(a.id).find((x) => x.uid === 105).subject, "Can you start Monday?");
});

test("PLANTED: a refused password becomes auth_failed without the password, and the schedule never tries it again", async () => {
  newWorld();
  const a = addAccount({ password: WRONG });
  const mb = mailbox();
  const { deps } = makeDeps({ "imappro.zoho.com": mb });
  const r = await call(officeReq(), deps);
  assert.equal(r.status, 200);
  assert.equal(r.body.accounts[0].status, "auth_failed");
  assert.equal(r.body.accounts[0].error_code, "auth_failed");
  assert.ok(!r.text.includes(WRONG));

  const row = acct(a.id);
  assert.equal(row.status, "auth_failed");
  assert.equal(row.last_error_code, "auth_failed");
  // The server echoed the password back (the fake always does); it is
  // nowhere in what FenceFlow stored, and "([redacted])" is the positive
  // control that there was something to cut out.
  assert.equal(mb.logins, 1);
  assert.ok(row.last_error && !row.last_error.includes(WRONG), row.last_error);
  assert.match(row.last_error, /\(\[redacted\]\)/);
  assert.equal(folderState(a.id, "inbox"), undefined, "no folder state from a failed login");

  // The schedule skips it: not even listed, so no second login.
  unlock(row);
  row.last_error_at = new Date(Date.now() - 3 * 3600_000).toISOString();
  const t = await call(triggerReq(), deps);
  assert.equal(t.status, 200, t.text);
  assert.equal(t.body.due, 0);
  assert.equal(mb.logins, 1, "the schedule presented a refused password again");
  // And the office does not retry it either: that is mail-connect's job.
  unlock(row);
  const again = await call(officeReq(), deps);
  assert.deepEqual(again.body.accounts[0], { id: a.id, status: "auth_failed", new: 0, skipped: "needs_new_password" });
  assert.equal(mb.logins, 1);
});

test("PLANTED: the scheduled answer holds counts only -- no id, address, host or server text for the public log", async () => {
  newWorld();
  world.companies.push({ id: C2, name: "Bravo Fence", email: "hello@bravo-fence.example" });
  const ok = addAccount();
  const bad = addAccount({ company_id: C2, email_address: "hello@bravo-fence.example", username: "hello@bravo-fence.example" });
  const refused = addAccount({
    company_id: C2,
    email_address: "sales@bravo-fence.example",
    username: "sales@bravo-fence.example",
    password: WRONG,
    last_synced_at: new Date(Date.now() - 3600_000).toISOString(),
  });
  // Bravo's first mailbox answers with a timeout; its second refuses the password.
  const bravo = mailbox({ username: "sales@bravo-fence.example" });
  const { deps } = makeDeps({
    "imappro.zoho.com": (opts) => {
      if (world.rpcLog.filter((c) => c.name === "mail_claim_sync").at(-1)?.args.p_account === bad.id) {
        throw new MailError("timeout", "fake: hello@bravo-fence.example did not answer");
      }
      const last = world.rpcLog.filter((c) => c.name === "mail_claim_sync").at(-1)?.args.p_account;
      return new FakeImapConn(last === refused.id ? bravo : mailbox());
    },
  });
  const t = await call(triggerReq(), deps);
  assert.equal(t.status, 200, t.text);
  // A tenant's broken mailbox is not a scheduler failure.
  assert.equal(t.body.ok, true);
  assert.equal(t.body.due, 3);
  assert.equal(t.body.synced, 1);
  assert.equal(t.body.failed, 2);
  assert.deepEqual(t.body.failure_codes, { timeout: 1, auth_failed: 1 });
  assert.ok(t.text.startsWith('{"ok":true'), "the workflow reads the verdict from the first bytes");

  const forbidden = [ok.id, bad.id, refused.id, C1, C2, "acmefence", "bravo-fence", "zoho", "hello@", WRONG, "Invalid credentials"];
  for (const s of forbidden) assert.ok(!t.text.includes(s), `the public answer contains ${s}`);
  // Positive control: the same ids are findable in the office's answer, so
  // their absence above is the scheduled door's doing, not a broken search.
  unlock(acct(ok.id));
  const o = await call(officeReq(), deps);
  assert.ok(o.text.includes(ok.id));
});

test("PLANTED: FenceFlow's own failure fails the run, and the folder state never passes mail that was not stored", async () => {
  newWorld();
  const a = addAccount();
  const mb = mailbox();
  const { deps } = makeDeps({ "imappro.zoho.com": mb });
  world.failRpc.add("mail_ingest");
  const t = await call(triggerReq(), deps);
  assert.equal(t.status, 200);
  assert.equal(t.body.ok, false, "a database failure on our side must fail the workflow");
  assert.deepEqual(t.body.failure_codes, { server_error: 1 });
  assert.ok(t.text.startsWith('{"ok":false'));
  assert.equal(world.mail_messages.length, 0);
  assert.equal(folderState(a.id, "inbox"), undefined, "state advanced past mail that was never stored");
  assert.equal(acct(a.id).status, "error");
  assert.equal(acct(a.id).last_error_code, "server_error");

  // Fixed, and past the backoff: the same messages come in, none lost.
  world.failRpc.clear();
  const row = acct(a.id);
  unlock(row);
  row.last_error_at = new Date(Date.now() - (ERROR_BACKOFF_MINUTES + 1) * 60_000).toISOString();
  const t2 = await call(triggerReq(), deps);
  assert.equal(t2.body.ok, true, t2.text);
  assert.equal(t2.body.new_messages, 4);
  assert.equal(inbox(a.id).length, 4);
  assert.equal(acct(a.id).status, "connected");
  assert.equal(acct(a.id).last_error, null);
});

test("the schedule's choice: due mailboxes oldest first, errors after their backoff, recent syncs left alone, at most 8", async () => {
  newWorld();
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const never = addAccount({ email_address: "never@acmefence.com" });
  const old = addAccount({ email_address: "old@acmefence.com", last_synced_at: ago(30) });
  const recent = addAccount({ email_address: "recent@acmefence.com", last_synced_at: ago(1) });
  const erroredLong = addAccount({ email_address: "e1@acmefence.com", status: "error", last_synced_at: ago(300), last_error_at: ago(20) });
  const erroredNow = addAccount({ email_address: "e2@acmefence.com", status: "error", last_synced_at: ago(300), last_error_at: ago(5) });
  const refusedAcct = addAccount({ email_address: "af@acmefence.com", status: "auth_failed", last_error_at: ago(600) });
  const gone = addAccount({ email_address: "dc@acmefence.com", status: "disconnected" });
  const locked = addAccount({ email_address: "lk@acmefence.com", sync_lock_until: new Date(Date.now() + 30_000).toISOString() });

  const admin = globalThis.__mailSyncCreateClient(ENV.SUPABASE_URL, "service-key", {});
  const due = await sync.dueAccounts(admin, Date.now());
  // Never synced (0), then synced 30 min ago, then failed 20 min ago (its
  // last attempt, not its last success, is what counts).
  assert.deepEqual(due.map((d) => d.id), [never.id, old.id, erroredLong.id]);
  for (const skipped of [recent, erroredNow, refusedAcct, gone, locked]) assert.ok(!due.some((d) => d.id === skipped.id));

  // The cap: ten due mailboxes, eight started, two deferred to next run.
  newWorld();
  for (let i = 0; i < 10; i++) addAccount({ email_address: `m${i}@acmefence.com` });
  const mb = mailbox();
  const { deps } = makeDeps({ "imappro.zoho.com": mb });
  const t = await call(triggerReq({ action: "sync" }), deps);
  assert.equal(t.body.started, TRIGGER_SYNC_MAX_ACCOUNTS);
  assert.equal(t.body.deferred, 10 - TRIGGER_SYNC_MAX_ACCOUNTS);
  assert.equal(mb.logins, TRIGGER_SYNC_MAX_ACCOUNTS);
});

test("the scheduled door stops starting mailboxes in time to answer inside 150 s, and skips suspended companies", async () => {
  newWorld();
  addAccount();
  addAccount({ email_address: "second@acmefence.com" });
  const mb = mailbox();
  // Every clock read after the first is 95 s later: the start budget is spent.
  const t0 = Date.now();
  let first = true;
  const { deps, connects } = makeDeps({ "imappro.zoho.com": mb }, {
    now: () => {
      if (first) {
        first = false;
        return t0;
      }
      return t0 + 95_000;
    },
  });
  const t = await call(triggerReq(), deps);
  assert.equal(t.body.started, 0);
  assert.equal(t.body.deferred, 2);
  assert.match(t.body.stopped_early, /next run/);
  assert.equal(connects.length, 0);

  newWorld();
  const a = addAccount();
  world.allowed.set(C1, false);
  const { deps: d2, connects: c2 } = makeDeps({ "imappro.zoho.com": mailbox() });
  const t2 = await call(triggerReq(), d2);
  assert.equal(t2.body.company_not_allowed, 1);
  assert.equal(c2.length, 0);
  assert.equal(acct(a.id).sync_lock_until, null);
});

test("every session is cut to fit what is left of the run", async () => {
  newWorld();
  const a = addAccount();
  const { deps, connects } = makeDeps({ "imappro.zoho.com": mailbox() });
  const admin = globalThis.__mailSyncCreateClient(ENV.SUPABASE_URL, "service-key", {});
  const own = { addresses: ["office@acmefence.com"] };
  // Too little left: not even claimed.
  let o = await sync.syncAccount({ admin, companyId: C1, accountId: a.id, own, deps, sessionEnd: Date.now() + 10_000 });
  assert.deepEqual(o, { kind: "skipped", status: "", reason: "no_time" });
  assert.equal(acct(a.id).sync_lock_until, null);
  // Forty seconds left: the transport is told so.
  o = await sync.syncAccount({ admin, companyId: C1, accountId: a.id, own, deps, sessionEnd: Date.now() + 40_000 });
  assert.equal(o.kind, "synced");
  assert.ok(connects[0].limits.sessionDeadlineMs <= 40_000 && connects[0].limits.sessionDeadlineMs > 30_000);
});

test("PLANTED: a UIDVALIDITY reset re-binds what it sees again and hides the rest, without duplicates", async () => {
  newWorld();
  const a = addAccount();
  const mb = mailbox();
  const { deps } = makeDeps({ "imappro.zoho.com": mb });
  await call(officeReq(), deps);
  const ids = new Map(inbox(a.id).map((m) => [m.message_id_header, m.id]));

  // The server renumbered INBOX, and "Deposit sent" is gone for good.
  const f = mb.folders.INBOX;
  f.uidValidity = 7007;
  f.messages = f.messages.filter((m) => m.uid !== 103).map((m, i) => ({ ...m, uid: i + 1 }));
  unlock(acct(a.id));
  const r = await call(officeReq(), deps);
  assert.equal(r.body.accounts[0].new, 0, "renumbered mail counted as new");
  assert.equal(inbox(a.id).length, 4, "renumbered mail was duplicated");
  const live = inbox(a.id).filter((m) => m.server_gone_at === null);
  assert.deepEqual(live.map((m) => m.subject).sort(), ["Fence quote for 12 Oak St", "Photos of the old fence", "Re: Gate width"]);
  assert.ok(live.every((m) => m.uidvalidity === 7007 && ids.get(m.message_id_header) === m.id), "re-bound rows are the same rows");
  const hidden = inbox(a.id).find((m) => m.subject === "Deposit sent");
  assert.ok(hidden.server_gone_at && hidden.uidvalidity === 1001);
  assert.equal(folderState(a.id, "inbox").uidvalidity, 7007);
});

test("PLANTED: a custom host now pointing at a private address never gets a socket, or the password", async () => {
  newWorld();
  const a = addAccount({ provider: "custom", imap_host: "mail.acme-fence-example.com", smtp_host: "mail.acme-fence-example.com" });
  const resolver = async (host, type) => (type === "A" ? ["10.0.0.5"] : []);
  const { deps, connects } = makeDeps({ "mail.acme-fence-example.com": mailbox() }, { resolver });
  const r = await call(officeReq(), deps);
  assert.equal(r.body.accounts[0].error_code, "host_not_allowed");
  assert.equal(connects.length, 0);
  assert.ok(!world.rpcLog.some((c) => c.name === "mail_secret_get"), "the password was read for a host that was refused");
  assert.equal(acct(a.id).status, "error");

  // Positive control: the same row with a public address syncs.
  newWorld();
  const b = addAccount({ provider: "custom", imap_host: "mail.acme-fence-example.com", smtp_host: "mail.acme-fence-example.com" });
  const pub = makeDeps({ "mail.acme-fence-example.com": mailbox() }, { resolver: async (h, t) => (t === "A" ? ["203.0.114.10"] : []) });
  const ok = await call(officeReq(), pub.deps);
  assert.equal(ok.body.accounts[0].status, "connected", ok.text);
  assert.equal(inbox(b.id).length, 4);

  // A preset row whose host was tampered with is refused too.
  newWorld();
  addAccount({ imap_host: "imap.evil.example" });
  const t = makeDeps({ "imap.evil.example": mailbox() });
  const bad = await call(officeReq(), t.deps);
  assert.equal(bad.body.accounts[0].error_code, "host_not_allowed");
  assert.equal(t.connects.length, 0);
});

test("PLANTED: a mailbox disconnected while its sync runs stays disconnected", async () => {
  newWorld();
  const a = addAccount();
  const { deps } = makeDeps({ "imappro.zoho.com": mailbox() });
  // The owner presses Disconnect while the first folder is being stored.
  world.hooks.mail_ingest = () => {
    if (acct(a.id).status !== "disconnected") {
      Object.assign(acct(a.id), { status: "disconnected", updated_at: stamp() });
      world.secrets.delete(a.id);
    }
  };
  await call(officeReq(), deps);
  assert.equal(acct(a.id).status, "disconnected", "a finishing sync resurrected a disconnected mailbox");
  // The lock was let go: back to the one-minute rate limit, not the claim's 90 s.
  assert.ok(Date.parse(acct(a.id).sync_lock_until) - Date.now() <= MANUAL_SYNC_LOCK_SECONDS * 1000, "the lock was not let go");

  // And a new password typed mid-sync is not overwritten by the old one failing.
  newWorld();
  const b = addAccount({ password: WRONG });
  const mb = mailbox();
  const { deps: d2 } = makeDeps({ "imappro.zoho.com": mb });
  world.hooks.mail_secret_get = () => {
    // mail-connect replaced the password and marked the row connected.
    Object.assign(acct(b.id), { status: "connected", updated_at: stamp() });
  };
  await call(officeReq(), d2);
  assert.equal(acct(b.id).status, "connected");
  assert.equal(acct(b.id).last_error_code, null);
});

test("PLANTED: an empty answer from mail_ingest is a failure, not 'nothing new'", async () => {
  newWorld();
  const a = addAccount();
  const { deps } = makeDeps({ "imappro.zoho.com": mailbox() });
  const real = globalThis.__mailSyncCreateClient;
  // The RPC "succeeds" but answers no rows -- a wrong signature, a filter
  // that matched nothing. Four messages went in; zero came back.
  globalThis.__mailSyncCreateClient = (url, key, options) => {
    const c = real(url, key, options);
    const rpc = c.rpc;
    c.rpc = async (name, args) => (name === "mail_ingest" && key === "service-key" ? (world.rpcLog.push({ name, args, key }), { data: [], error: null }) : rpc(name, args));
    return c;
  };
  try {
    const r = await call(officeReq(), deps);
    assert.equal(r.body.accounts[0].error_code, "server_error");
    assert.equal(folderState(a.id, "inbox"), undefined, "state advanced on an empty answer");
    assert.equal(acct(a.id).status, "error");
  } finally {
    globalThis.__mailSyncCreateClient = real;
  }
});

test("a session cut by OUR budget keeps what it finished and is not the mailbox's fault; a slow server within budget is", async () => {
  // The fake connect ignores the requested deadline and cuts every session
  // after 300 ms; the server stops answering when asked for Sent.
  const shortConnect = (mb) => async (opts) => new StreamTransport(new FakeImapConn(mb), { ...opts.limits, sessionDeadlineMs: 300 });

  newWorld();
  const a = addAccount();
  const mb = mailbox({ hangOn: 'EXAMINE "Sent"' });
  let connected = false;
  const { deps } = makeDeps({});
  deps.connect = async (opts) => {
    connected = true;
    return shortConnect(mb)(opts);
  };
  // Once connected, our clock says the run's budget is spent.
  deps.now = () => Date.now() + (connected ? 10 * 60_000 : 0);
  const admin = globalThis.__mailSyncCreateClient(ENV.SUPABASE_URL, "service-key", {});
  const own = { addresses: ["office@acmefence.com"] };
  const o = await sync.syncAccount({ admin, companyId: C1, accountId: a.id, own, deps, sessionEnd: Date.now() + 40_000 });
  assert.equal(o.kind, "synced");
  assert.equal(o.unfinished, true);
  assert.equal(o.newInbox, 4);
  assert.equal(folderState(a.id, "inbox").last_uid, 104, "the finished folder was not kept");
  assert.equal(folderState(a.id, "sent"), undefined);
  assert.equal(acct(a.id).status, "connected");
  assert.equal(acct(a.id).last_error_code, null);
  assert.equal(acct(a.id).last_synced_at, null, "an unfinished run is not a completed sync");

  // Same stall, but with no budget of ours in play: that IS the server.
  newWorld();
  const b = addAccount();
  const mb2 = mailbox({ hangOn: 'EXAMINE "Sent"' });
  const d2 = makeDeps({}).deps;
  d2.connect = shortConnect(mb2);
  const o2 = await sync.syncAccount({ admin, companyId: C1, accountId: b.id, own, deps: d2, sessionEnd: Date.now() + 10 * 60_000 });
  assert.equal(o2.kind, "failed");
  assert.equal(o2.code, "session_limit");
  assert.equal(acct(b.id).status, "error");
  assert.equal(folderState(b.id, "inbox").last_uid, 104, "INBOX finished before the stall and is kept either way");
});

/** An inbox of n messages from the last day, uids 1..n. `refs` bytes of
 *  References each: the header an outside sender controls. */
function bulkInbox(n, refs = 0) {
  const pad = refs ? `References: <${"r".repeat(refs)}@spam.example>\r\n` : "";
  return Array.from({ length: n }, (_, i) => {
    const m = msg(i + 1, `Bulk message ${i + 1}`, { days: 1 });
    // After the fields that matter, as a sender would put it to survive a cut.
    m.header = m.header.replace(/\r\n\r\n$/, `\r\n${pad}\r\n`);
    return m;
  });
}

test("PLANTED: an outside sender's enormous headers cannot stop the inbox syncing", async () => {
  newWorld();
  const a = addAccount();
  const mb = mailbox();
  // 60 messages with 400 KB of References each: 24 MB of header, more than a
  // whole session may read. Uncapped, every run would re-read the same batch
  // and die at the byte cap, and INBOX would never move again.
  mb.folders.INBOX = { uidValidity: 1001, messages: bulkInbox(60, 400 * 1024) };
  const total = mb.folders.INBOX.messages.reduce((n, m) => n + m.header.length, 0);
  assert.ok(total > SESSION_BYTE_CAP, "planted: the mailbox really does outgrow a session");
  const { deps } = makeDeps({ "imappro.zoho.com": mb });
  const r = await call(officeReq(), deps);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.accounts[0], { id: a.id, status: "connected", new: 60 });
  assert.equal(inbox(a.id).length, 60);
  assert.equal(inbox(a.id).find((m) => m.uid === 37).subject, "Bulk message 37", "a capped block still parses");
  assert.equal(folderState(a.id, "inbox").last_uid, 60);
  // Every block capped (Sent's two small ones are counted too).
  assert.ok(mb.headerBytesSent <= (60 + mb.folders.Sent.messages.length) * HEADER_BLOCK_MAX_BYTES, `${mb.headerBytesSent} header bytes read`);
  assert.ok(mb.log.filter((l) => /UID FETCH .*HEADER\.FIELDS/.test(l)).every((l) => l.includes(`]<0.${HEADER_BLOCK_MAX_BYTES}>`)));
});

test("PLANTED: a session cut halfway through a folder keeps every batch it stored, and the next run finishes the rest", async () => {
  newWorld();
  const a = addAccount();
  const mb = mailbox();
  const n = HEADER_FETCH_BATCH * 2 + 20;
  mb.folders.INBOX = { uidValidity: 1001, messages: bulkInbox(n) };
  // The server stops answering at the second batch of headers.
  let fetches = 0;
  mb.hangWhen = (line) => /UID FETCH .*HEADER\.FIELDS/.test(line) && ++fetches === 2;
  const admin = globalThis.__mailSyncCreateClient(ENV.SUPABASE_URL, "service-key", {});
  const own = { addresses: ["office@acmefence.com"] };
  const { deps } = makeDeps({});
  deps.connect = async (opts) => new StreamTransport(new FakeImapConn(mb), { ...opts.limits, sessionDeadlineMs: 300 });
  const o = await sync.syncAccount({ admin, companyId: C1, accountId: a.id, own, deps, sessionEnd: Date.now() + 10 * 60_000 });
  assert.equal(o.kind, "failed");
  assert.equal(o.code, "session_limit");
  // The newest batch is stored and counted, and the state says so: the top
  // of the folder is recorded, and everything below the batch is still owed.
  assert.equal(o.newInbox, HEADER_FETCH_BATCH, "a batch that was stored was not counted");
  assert.equal(inbox(a.id).length, HEADER_FETCH_BATCH);
  assert.equal(Math.min(...inbox(a.id).map((m) => m.uid)), n - HEADER_FETCH_BATCH + 1);
  const st = folderState(a.id, "inbox");
  assert.equal(st.last_uid, n, "the stored batch was not kept: the next run would fetch it all again");
  assert.equal(st.backfill_below_uid, n - HEADER_FETCH_BATCH + 1);

  // The server answers again. The rest comes in, nothing twice.
  mb.hangWhen = null;
  unlock(acct(a.id));
  const r = await call(officeReq(), makeDeps({ "imappro.zoho.com": mb }).deps);
  assert.equal(r.body.accounts[0].status, "connected", r.text);
  assert.equal(r.body.accounts[0].new, n - HEADER_FETCH_BATCH);
  assert.equal(inbox(a.id).length, n);
  assert.equal(new Set(inbox(a.id).map((m) => m.uid)).size, n, "a message was stored twice");
  assert.equal(folderState(a.id, "inbox").backfill_below_uid, null);
  assert.equal(folderState(a.id, "inbox").last_uid, n);
});

test("a mailbox with no stored password is a credentials problem, not a retry loop", async () => {
  newWorld();
  const a = addAccount();
  world.secrets.delete(a.id);
  const mb = mailbox();
  const { deps, connects } = makeDeps({ "imappro.zoho.com": mb });
  const r = await call(officeReq(), deps);
  assert.equal(r.body.accounts[0].status, "auth_failed");
  assert.equal(connects.length, 0);
  assert.match(acct(a.id).last_error, /No app password is stored/);
});

test("a Sent folder is found by LIST when none is recorded, and found again when it moves", async () => {
  newWorld();
  const a = addAccount({ sent_folder: null });
  const mb = mailbox();
  const { deps } = makeDeps({ "imappro.zoho.com": mb });
  await call(officeReq(), deps);
  assert.equal(acct(a.id).sent_folder, "Sent");
  assert.equal(sent(a.id).length, 2);

  // Renamed on the server: the recorded path now answers NO.
  mb.folders["Sent Items"] = mb.folders.Sent;
  delete mb.folders.Sent;
  unlock(acct(a.id));
  const r = await call(officeReq(), deps);
  assert.equal(r.body.accounts[0].status, "connected", r.text);
  assert.equal(acct(a.id).sent_folder, "Sent Items");
  assert.equal(folderState(a.id, "sent").path, "Sent Items");
  assert.equal(sent(a.id).length, 2, "the moved folder's mail was duplicated");
});

test("office door: two people at once -- the second is told the sync is busy, and nothing runs twice", async () => {
  newWorld();
  const a = addAccount();
  const mb = mailbox();
  const { deps } = makeDeps({ "imappro.zoho.com": mb });
  const [r1, r2] = await Promise.all([call(officeReq(), deps), call(officeReq(), deps)]);
  const answers = [r1.body.accounts[0], r2.body.accounts[0]];
  assert.equal(answers.filter((x) => x.busy).length, 1, JSON.stringify(answers));
  assert.equal(mb.logins, 1);
  assert.equal(inbox(a.id).length, 4);
  // Within the minute, a third press is also busy: the manual rate limit.
  const r3 = await call(officeReq(), deps);
  assert.equal(r3.body.accounts[0].busy, true);
});

test("PLANTED: the office door never reaches another company's mailbox, and every service-role read names the company", async () => {
  newWorld();
  const mine = addAccount();
  const theirs = addAccount({ company_id: C2, email_address: "hello@bravo-fence.example", username: "hello@bravo-fence.example" });
  const mb = mailbox();
  const { deps } = makeDeps({ "imappro.zoho.com": mb });
  const r = await call(officeReq(), deps);
  assert.deepEqual(r.body.accounts.map((x) => x.id), [mine.id]);
  assert.equal(acct(theirs.id).sync_lock_until, null);
  assert.ok(!world.rpcLog.some((c) => c.args?.p_account === theirs.id));
  for (const q of world.queryLog.filter((q) => q.key === "service-key" && ["mail_accounts", "mail_messages"].includes(q.table))) {
    assert.ok(q.filters.some(([op, col, val]) => op === "eq" && col === "company_id" && val === C1),
      `service-role ${q.op} on ${q.table} without company_id: ${JSON.stringify(q.filters)}`);
  }
});

// ===========================================================================
// reach
// ===========================================================================

function reachDeps(over = {}) {
  const imapLogs = [];
  const smtpLog = [];
  const byHost = {};
  for (const t of sync.reachTargets()) {
    byHost[t.host] = t.protocol === "imap"
      ? () => {
        const mb = mailbox({ greetingCaps: false });
        imapLogs.push(mb.log);
        return new FakeImapConn(mb);
      }
      : () => new FakeSmtpConn(smtpLog);
  }
  byHost["reach-probe.invalid"] = new MailError("dns_failed");
  Object.assign(byHost, over.byHost ?? {});
  const made = makeDeps(byHost, over);
  return { ...made, imapLogs, smtpLog };
}

test("reach: the preset servers only, no credentials, and a result that proves itself with negative controls", async () => {
  newWorld();
  const { deps, connects, imapLogs, smtpLog } = reachDeps();
  // Anything else in the body is ignored: reach never takes a host from a request.
  const r = await call(triggerReq({ action: "reach", host: "10.0.0.1", port: 25 }), deps);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.ok, true, r.text);
  assert.ok(r.text.startsWith('{"ok":true'));
  assert.deepEqual(r.body.targets.map((t) => `${t.host}:${t.port}`),
    ["imappro.zoho.com:993", "smtppro.zoho.com:465", "imap.zoho.com:993", "smtp.zoho.com:465", "imap.gmail.com:993", "smtp.gmail.com:465"]);
  assert.ok(r.body.targets.every((t) => t.ok && Array.isArray(t.capabilities) && t.capabilities.length > 0));
  assert.ok(r.body.targets.find((t) => t.host === "smtp.gmail.com").capabilities.includes("AUTH PLAIN LOGIN"));
  assert.ok(!connects.some((c) => c.hostname === "10.0.0.1"));
  assert.ok(connects.every((c) => c.port === 993 || c.port === 465));
  // Greeting, CAPABILITY/EHLO, goodbye. Never a login.
  const sentLines = [...imapLogs.flat(), ...smtpLog];
  assert.ok(sentLines.length > 0);
  assert.ok(!sentLines.some((l) => /LOGIN|AUTH(ENTICATE)?\b|MAIL FROM|RCPT/i.test(l.replace(/^A\d+ /, ""))), sentLines.join("\n"));
  assert.deepEqual(r.body.negative_controls.map((n) => [n.host, n.port, n.failed_as_expected]),
    [["reach-probe.invalid", 993, true], ["smtp.zoho.com", 587, true], ["imap.gmail.com", 9, true]]);
  // Never touched the database.
  assert.ok(!world.rpcLog.length && !world.queryLog.length);
});

test("PLANTED: reach fails when a server is unreachable, or when a negative control does not fail for a network reason", async () => {
  newWorld();
  // One preset server down.
  let d = reachDeps({ byHost: { "smtppro.zoho.com": new MailError("timeout") } });
  let r = await call(triggerReq({ action: "reach" }), d.deps);
  assert.equal(r.body.ok, false);
  assert.ok(r.text.startsWith('{"ok":false'));
  assert.equal(r.body.targets.find((t) => t.host === "smtppro.zoho.com").error_code, "timeout");

  // Port 587 suddenly connects: the control no longer proves anything.
  d = reachDeps({ tcpProbe: async () => {} });
  r = await call(triggerReq({ action: "reach" }), d.deps);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.negative_controls.find((n) => n.port === 587).failed_as_expected, false);

  // No socket API at all "fails" too -- and must not count as a network failure.
  d = reachDeps({ tcpProbe: async () => {
    throw new MailError("not_configured");
  } });
  r = await call(triggerReq({ action: "reach" }), d.deps);
  assert.equal(r.body.ok, false);
});

// ===========================================================================
// The workflow
// ===========================================================================

const WORKFLOW = readFileSync(new URL("../.github/workflows/mail-sync.yml", import.meta.url), "utf8");

/** The step's `run: |` block, de-indented: exactly what GitHub hands bash. */
function runScript(yml) {
  const lines = yml.split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s+(?:- )?run: \|\s*$/.test(l));
  assert.ok(at > 0, "no run block");
  const base = lines[at].indexOf("run:");
  const body = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() !== "" && l.search(/\S/) <= base) break;
    body.push(l);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(indent)).join("\n");
}

const bash = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" });
const HAVE_BASH = bash.status === 0 && bash.stdout.trim() === "ok";

function runWorkflow({ secret = "", event = "schedule", schedule = "*/10 * * * *", input = "", status = "200", body = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mail-sync-wf-"));
  const fwd = (p) => p.replace(/\\/g, "/");
  try {
    // curl stand-in: records its arguments, writes the canned body to -o,
    // prints the canned status like -w '%{http_code}' would.
    const fakeCurl = [
      "curl() {",
      '  printf "%s\\n" "$@" > "$FAKE_ARGS"',
      '  local out=""',
      '  while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done',
      '  printf "%s" "$FAKE_BODY" > "$out"',
      '  printf "%s" "$FAKE_STATUS"',
      "}",
    ].join("\n");
    const script = `${fakeCurl}\n${runScript(WORKFLOW)}`;
    const env = {
      ...process.env,
      TRIGGER_SECRET: secret,
      SUPABASE_ANON_KEY: "sb_publishable_test",
      FUNCTION_URL: "https://example.invalid/functions/v1/mail-sync",
      EVENT_NAME: event,
      EVENT_SCHEDULE: schedule,
      INPUT_ACTION: input,
      GITHUB_STEP_SUMMARY: fwd(join(dir, "summary.md")),
      FAKE_ARGS: fwd(join(dir, "args.txt")),
      FAKE_BODY: body,
      FAKE_STATUS: status,
    };
    const r = spawnSync("bash", ["-c", script], { cwd: dir, env, encoding: "utf8" });
    let args = "";
    let summary = "";
    try {
      args = readFileSync(join(dir, "args.txt"), "utf8");
    } catch { /* curl never ran */ }
    try {
      summary = readFileSync(join(dir, "summary.md"), "utf8");
    } catch { /* nothing written */ }
    return { code: r.status, out: `${r.stdout}${r.stderr}`, args, summary };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("workflow: expressions stay in env, never inside the script (no injection through event data)", () => {
  const script = runScript(WORKFLOW);
  assert.ok(!script.includes("${{"), "a ${{ }} expression inside run: is a script-injection hole");
  // Planted: the check finds one when it is there.
  assert.ok(runScript("jobs:\n  x:\n    steps:\n      - run: |\n          echo ${{ github.event.inputs.action }}\n").includes("${{"));
  assert.match(WORKFLOW, /cron: '\*\/10 \* \* \* \*'/);
  assert.match(WORKFLOW, /secrets\.MAIL_SYNC_TRIGGER_SECRET/);
});

test("PLANTED: workflow unconfigured -- a notice and exit 0, on the schedule and by hand, and curl never runs", { skip: !HAVE_BASH && "bash not found" }, () => {
  for (const event of ["schedule", "workflow_dispatch"]) {
    const r = runWorkflow({ secret: "", event });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /::notice::MAIL_SYNC_TRIGGER_SECRET is not set/);
    assert.match(r.summary, /not configured/);
    assert.equal(r.args, "", "curl ran without a secret");
  }
});

test("PLANTED: workflow configured -- passes only on HTTP 200 whose FIRST key is ok:true", { skip: !HAVE_BASH && "bash not found" }, () => {
  const secret = "s3cret-value-never-printed";
  const good = runWorkflow({ secret, body: '{"ok":true,"action":"sync","due":1}' });
  assert.equal(good.code, 0, good.out);
  assert.match(good.args, /x-fenceflow-trigger: s3cret-value-never-printed/);
  assert.match(good.args, /\{"action":"sync"\}/);
  assert.ok(!good.out.includes(secret), "the secret was printed");

  // The trap a grep falls into: ok:true inside a target, ok:false overall.
  const trap = runWorkflow({ secret, body: '{"ok":false,"action":"reach","targets":[{"host":"imap.zoho.com","ok":true}]}' });
  assert.equal(trap.code, 1, trap.out);
  const ours = runWorkflow({ secret, body: '{"ok":false,"action":"sync","failure_codes":{"server_error":1}}' });
  assert.equal(ours.code, 1);
  const http = runWorkflow({ secret, status: "500", body: '{"error_code":"server_error"}' });
  assert.equal(http.code, 1);
  const refused = runWorkflow({ secret, status: "401", body: '{"error_code":"no_session"}' });
  assert.equal(refused.code, 1);

  // The daily schedule and the manual choice both mean reach.
  const daily = runWorkflow({ secret, schedule: "5 6 * * *", body: '{"ok":true,"action":"reach"}' });
  assert.equal(daily.code, 0);
  assert.match(daily.args, /\{"action":"reach"\}/);
  const manual = runWorkflow({ secret, event: "workflow_dispatch", input: "reach", body: '{"ok":true,"action":"reach"}' });
  assert.match(manual.args, /\{"action":"reach"\}/);
  const early = runWorkflow({ secret, body: '{"ok":true,"action":"sync","stopped_early":"x"}' });
  assert.equal(early.code, 0);
  assert.match(early.out, /::notice::mail-sync ran out of time/);
});

// ===========================================================================
// Optional: capture the exact payloads for the rolled-back SQL contract check.
// ===========================================================================

test("capture payloads for the SQL contract check (only when MAIL_SYNC_CAPTURE is set)", { skip: !process.env.MAIL_SYNC_CAPTURE && "MAIL_SYNC_CAPTURE not set" }, async () => {
  newWorld();
  const a = addAccount();
  const mb = mailbox();
  const { deps } = makeDeps({ "imappro.zoho.com": mb });
  await call(officeReq(), deps);
  mb.folders.INBOX.messages.find((m) => m.uid === 102).flags.push("\\Seen");
  mb.folders.INBOX.messages = mb.folders.INBOX.messages.filter((m) => m.uid !== 103);
  unlock(acct(a.id));
  await call(officeReq(), deps);
  const pick = (name) => world.rpcLog.filter((c) => c.name === name && c.key === "service-key").map((c) => c.args);
  writeFileSync(process.env.MAIL_SYNC_CAPTURE, JSON.stringify({
    account: a.id,
    ingest: pick("mail_ingest"),
    set_flags: pick("mail_set_flags"),
    mark_gone: pick("mail_mark_gone"),
    claim: pick("mail_claim_sync"),
    folder_state: world.mail_folder_state,
    account_after: acct(a.id),
  }, null, 1));
});
