// resend-inbound, called the way Resend calls it. No network, no Deno, no
// live Supabase, no real Resend, and no real secret anywhere.
//
// Run with:  node --test tests/mail-resend-inbound.test.mjs
//
// The real handler (supabase/functions/resend-inbound/index.ts) runs
// unmodified on top of three fakes:
//
//  - Supabase. caller.ts and the function import supabase-js from esm.sh,
//    which Node cannot fetch, so a module hook swaps that one URL for a fake
//    client over an in-memory database and bucket (the trick
//    tests/mail-message.test.mjs uses). Only the service-role key can do
//    anything. mail_ingest is modelled on supabase_mail.sql: it refuses a
//    resend_inbound row for anything but a FenceFlow-mail account, de-dupes
//    on (account, provider id), honours a reply_token only inside the
//    account's company, and strips the company's own addresses. A read or
//    write of mail_accounts or mail_messages with no filter at all is
//    refused (the service role would see every company). A row key
//    mail_messages does not have is an error here (the SQL would silently
//    drop it), so a misspelt column cannot pass.
//  - Resend: the receiving API and its attachment links, as a fetch.
//  - The clock.
//
// Signatures are computed here with node:crypto, independently of svix.ts.
//
// Planted cases (each marked PLANTED) are the failures this function exists
// to prevent: an unsigned, re-signed, tampered or replayed delivery being
// acted on; a delivery accepted and lost while receiving is not set up; a
// reply_token steering mail into another company's thread; a token at the
// wrong domain being routed; receiving marked proven without the whole
// chain; a failed delivery recorded as handled so Resend's retry is skipped;
// the daily cap not holding; an attachment link outside resend.com being
// fetched or sent our key; an attachment stored with a type that renders as
// a page; a secret reaching a response or a log.
//
// Teeth: set MAIL_RESEND_INBOUND_FN to the absolute path of a copy of the
// function (inside a copy of supabase/functions, so its relative imports
// resolve). A planted defect in the copy must make a test here fail.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FN_URL = process.env.MAIL_RESEND_INBOUND_FN
  ? pathToFileURL(process.env.MAIL_RESEND_INBOUND_FN).href
  : new URL("../supabase/functions/resend-inbound/index.ts", import.meta.url).href;
const shared = (name) => new URL(`../_shared/mail/${name}`, FN_URL).href;

// Everything printed and answered while this file runs, for the "no secret
// in a log or a response" check.
const LOGS = [];
const RESPONSES = [];
for (const k of ["log", "info", "warn", "error"]) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
    LOGS.push(a.map(String).join(" "));
    if (process.env.MAIL_TEST_VERBOSE) orig(...a);
  };
}

// ===========================================================================
// Fake Supabase
// ===========================================================================

const SUPABASE_JS = "https://esm.sh/@supabase/supabase-js@2.39.0";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === SUPABASE_JS) {
      const src = "export const createClient = (...a) => globalThis.__resendInboundCreateClient(...a);";
      return { url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

// A made-up signing secret in Resend's whsec_ format, and a made-up key.
const SIGNING_KEY = Buffer.from("resend-inbound-test-key-32-bytes", "utf8");
const WHSEC = `whsec_${SIGNING_KEY.toString("base64")}`;
const RKEY = "re_fake_receiving_key_ABCDEFGHIJKLMNOP0123";
const DOMAIN = "reply.fenceflowapp.com";
const NOW = Date.parse("2026-09-22T12:00:00.000Z");

const C1 = "22222222-2222-4222-8222-222222222222";
const C2 = "22222222-2222-4222-8222-2222222222c2";
const ACC_A = "aaaaaaaa-0000-4000-8000-000000000001";
const IMAP_A = "aaaaaaaa-0000-4000-8000-000000000002";
const ACC_B = "bbbbbbbb-0000-4000-8000-000000000001";
const ACC_GONE = "cccccccc-0000-4000-8000-000000000001";
const TOKEN_A = "a1b2c3d4e5f60718";
const TOKEN_B = "b1b2c3d4e5f60718";
const TOKEN_GONE = "c1b2c3d4e5f60718";
const RT_A = "0a0b0c0d0e0f";
const RT_B = "1a1b1c1d1e1f";
const THREAD_A = "aaaaaaaa-1111-4000-8000-000000000001";
const THREAD_B = "bbbbbbbb-1111-4000-8000-000000000001";
const EMAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const ATT_PNG = "2a0c9ce0-3112-4728-976e-47ddcd16a318";
const ATT_PDF = "3b1d0df1-4223-5839-087f-54eedd27b419";
const ATT_HTML = "4c2e1ef2-5334-4940-898a-65ffee38c520";
const CDN = "https://inbound-cdn.resend.com";

const MESSAGE_COLUMNS = new Set([
  "id", "company_id", "account_id", "thread_id", "folder_role", "source", "uidvalidity", "uid", "provider_message_id",
  "message_id_header", "parent_ids", "from_address", "from_name", "to_list", "cc_list", "reply_to_list", "to_text",
  "counterpart_emails", "subject", "sent_at", "received_at", "size_bytes", "has_attachments", "is_seen", "is_answered",
  "is_flagged", "snippet", "body_state", "body_text", "body_html", "body_truncated", "attachments", "send_state",
  "send_error", "client_send_id", "sent_by", "job_sync_id", "server_gone_at", "created_at",
]);
const INGEST_KEYS = new Set([...MESSAGE_COLUMNS, "reply_token"]);

let world;
let seq = 0;
const newId = () => `dddddddd-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function newWorld(over = {}) {
  world = {
    now: NOW,
    env: {
      SUPABASE_URL: "https://project.example.supabase.co",
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-key",
      RESEND_WEBHOOK_SECRET: WHSEC,
      RESEND_RECEIVING_KEY: RKEY,
      MAIL_INBOUND_DOMAIN: DOMAIN,
    },
    created: [],
    rpcLog: [],
    queryLog: [],
    fetchLog: [],
    storage: new Map(),
    bg: [],
    failRpc: new Set(),
    mail_accounts: [
      { id: ACC_A, company_id: C1, kind: "fenceflow", provider: "resend", email_address: "noreply@send.fenceflowapp.com", inbound_token: TOKEN_A, status: "connected" },
      { id: IMAP_A, company_id: C1, kind: "imap", provider: "zoho", email_address: "office@acmefence.com", inbound_token: null, status: "connected" },
      { id: ACC_B, company_id: C2, kind: "fenceflow", provider: "resend", email_address: "noreply@send.fenceflowapp.com", inbound_token: TOKEN_B, status: "connected" },
      { id: ACC_GONE, company_id: "99999999-2222-4222-8222-222222222222", kind: "fenceflow", provider: "resend", email_address: "noreply@send.fenceflowapp.com", inbound_token: TOKEN_GONE, status: "disconnected" },
    ],
    mail_threads: [
      { id: THREAD_A, company_id: C1, reply_token: RT_A },
      { id: THREAD_B, company_id: C2, reply_token: RT_B },
    ],
    mail_messages: [],
    mail_inbound_events: [],
    mail_events: [],
    mail_platform_settings: [{ id: 1, inbound_domain: DOMAIN, inbound_verified_at: "2026-09-01T00:00:00.000Z", last_inbound_at: null }],
    resend: { emails: new Map(), status: new Map(), lists: new Map(), files: new Map() },
    ...over,
  };
  world.resend.emails.set(EMAIL_ID, receivedEmail());
  world.resend.lists.set(EMAIL_ID, attachmentList());
}

const unverified = () => {
  world.mail_platform_settings[0].inbound_verified_at = null;
  world.mail_platform_settings[0].inbound_domain = null;
};

function makeQuery(table, key) {
  const st = { op: "select", filters: [], patch: null, row: null };
  const q = {
    select() {
      return q;
    },
    eq(c, v) {
      st.filters.push((r) => r[c] !== null && r[c] !== undefined && String(r[c]) === String(v));
      return q;
    },
    in(c, vs) {
      st.filters.push((r) => vs.map(String).includes(String(r[c])));
      return q;
    },
    insert(row) {
      st.op = "insert";
      st.row = row;
      return q;
    },
    update(patch) {
      st.op = "update";
      st.patch = patch;
      return q;
    },
    maybeSingle: () => run(true),
    then: (res, rej) => run(false).then(res, rej),
  };
  async function run(single) {
    world.queryLog.push({ table, key, op: st.op, patch: clone(st.patch), row: clone(st.row) });
    if (key !== "service-key") return { data: null, error: { code: "42501", message: "permission denied" } };
    const rows = world[table];
    if (!Array.isArray(rows)) throw new Error(`fake: no table ${table}`);
    if (st.op === "insert") {
      if (table === "mail_inbound_events" && rows.some((r) => r.svix_id === st.row.svix_id)) {
        return { data: null, error: { code: "23505", message: "duplicate key" } };
      }
      rows.push({ ...clone(st.row), received_at: new Date(world.now).toISOString() });
      return { data: null, error: null };
    }
    // The service role bypasses RLS, so a read or write of company data with
    // no filter at all would reach every company's rows: refused here.
    if (["mail_accounts", "mail_messages"].includes(table) && st.filters.length === 0) {
      return { data: null, error: { code: "FAKE", message: `fake: unscoped ${st.op} of ${table}` } };
    }
    const matched = rows.filter((r) => st.filters.every((f) => f(r)));
    if (st.op === "update") {
      if (table === "mail_messages" && Object.keys(st.patch).some((k) => !MESSAGE_COLUMNS.has(k))) {
        return { data: null, error: { code: "PGRST204", message: "no such column" } };
      }
      for (const r of matched) Object.assign(r, clone(st.patch));
      return { data: null, error: null };
    }
    const data = matched.map(clone);
    return single ? { data: data[0] ?? null, error: null } : { data, error: null };
  }
  return q;
}

/** supabase_mail.sql's mail_ingest, reduced to what this function relies on. */
function fakeIngest(accountId, rows) {
  const acct = world.mail_accounts.find((a) => a.id === accountId);
  if (!acct) return { data: null, error: { code: "P0002", message: "Unknown mail account" } };
  const own = world.mail_accounts.filter((a) => a.company_id === acct.company_id).map((a) => a.email_address);
  const out = [];
  for (const r of rows) {
    const bad = Object.keys(r).filter((k) => !INGEST_KEYS.has(k));
    if (bad.length) return { data: null, error: { code: "22023", message: `fake: unknown keys ${bad.join(",")}` } };
    if (r.source !== "resend_inbound" || acct.kind !== "fenceflow") return { data: null, error: { code: "22023", message: "source/kind" } };
    if (r.folder_role !== "inbox" || !r.provider_message_id) return { data: null, error: { code: "22023", message: "shape" } };
    if (!["none", "cached", "too_large", "error"].includes(r.body_state)) return { data: null, error: { code: "23514", message: "body_state" } };
    const hit = world.mail_messages.find((m) => m.account_id === acct.id && m.provider_message_id === r.provider_message_id);
    if (hit) {
      out.push({ message_id: hit.id, thread_id: hit.thread_id, inserted: false });
      continue;
    }
    let thread = r.reply_token ? world.mail_threads.find((t) => t.company_id === acct.company_id && t.reply_token === r.reply_token) : null;
    if (!thread && r.message_id_header) {
      const m = world.mail_messages.find((x) => x.company_id === acct.company_id && x.message_id_header === r.message_id_header);
      if (m) thread = { id: m.thread_id };
    }
    if (!thread) {
      thread = { id: newId(), company_id: acct.company_id, reply_token: `f${seq}`.padEnd(12, "0") };
      world.mail_threads.push(thread);
    }
    const id = newId();
    world.mail_messages.push({
      ...clone(r),
      id,
      company_id: acct.company_id,
      account_id: acct.id,
      thread_id: thread.id,
      counterpart_emails: (r.counterpart_emails ?? []).filter((c) => !own.includes(c)),
      reply_token: undefined,
    });
    out.push({ message_id: id, thread_id: thread.id, inserted: true });
  }
  return { data: out, error: null };
}

function countEvents(company, kind, windowMs) {
  return world.mail_events.filter((e) => (e.company_id ?? null) === (company ?? null) && e.kind === kind && e.at > world.now - windowMs).length;
}

globalThis.__resendInboundCreateClient = (url, key) => {
  world.created.push(key);
  return {
    rpc: async (name, args) => {
      world.rpcLog.push({ name, args: clone(args), key });
      if (key !== "service-key") return { data: null, error: { code: "42501", message: "permission denied" } };
      if (world.failRpc.has(name)) return { data: null, error: { code: "XX000", message: "fake failure" } };
      if (name === "mail_ingest") return fakeIngest(args.p_account, args.p_rows);
      if (name === "note_mail_event") {
        assert.equal(args.p_window, "1 day");
        world.mail_events.push({ company_id: args.p_company, kind: args.p_kind, at: world.now });
        return { data: countEvents(args.p_company, args.p_kind, 86_400_000), error: null };
      }
      if (name === "mail_event_count") {
        assert.equal(args.p_window, "1 day");
        return { data: countEvents(args.p_company, args.p_kind, 86_400_000), error: null };
      }
      return { data: null, error: { code: "PGRST202", message: `fake: no rpc ${name}` } };
    },
    from: (table) => makeQuery(table, key),
    storage: {
      from: (bucket) => ({
        upload: async (path, body, opts = {}) => {
          if (key !== "service-key") return { data: null, error: { message: "denied" } };
          world.storage.set(`${bucket}/${path}`, { bytes: Buffer.from(body), contentType: opts.contentType, upsert: opts.upsert });
          return { data: { path }, error: null };
        },
      }),
    },
  };
};

const fn = await import(FN_URL);
const { WEBHOOK_BODY_MAX_BYTES } = fn;
const { INBOUND_PER_COMPANY_PER_DAY } = await import(shared("limits.ts"));

// ===========================================================================
// Fake Resend
// ===========================================================================

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fe0dd8b0a50000000049454e44ae426082", "hex");
const PDF = Buffer.from("%PDF-1.4 plan\n");
const HTML_ATT = Buffer.from("<script>alert(1)</script>");

function receivedEmail(over = {}) {
  return {
    object: "email",
    id: EMAIL_ID,
    to: [`${TOKEN_A}.${RT_A}@${DOMAIN}`],
    from: "pat@example.org",
    created_at: "2026-09-22T11:59:30.000Z",
    subject: "Re: Your fence quote",
    html: '<p>Yes please, go ahead.</p><img src="cid:img001">',
    html_format: "data_uri",
    text: "Yes please, go ahead.\n\nOn Mon, Sep 21, 2026 Acme Fence wrote:\n> Here is your quote",
    headers: {
      from: "Pat Customer <pat@example.org>",
      to: `Acme Fence <${TOKEN_A}.${RT_A}@${DOMAIN}>`,
      cc: "Office <office@acmefence.com>, Sam Neighbour <sam@example.net>",
      "in-reply-to": "<quote-1@send.fenceflowapp.com>",
      references: "<root-1@send.fenceflowapp.com> <quote-1@send.fenceflowapp.com>",
      "message-id": "<reply-1@example.org>",
      date: "Tue, 22 Sep 2026 11:59:00 +0000",
    },
    bcc: [],
    cc: ["office@acmefence.com", "sam@example.net"],
    reply_to: [],
    received_for: [],
    message_id: "<reply-1@example.org>",
    raw: { download_url: `${CDN}/raw/${EMAIL_ID}?Signature=x`, expires_at: "2026-09-22T13:00:00.000Z" },
    attachments: [
      { id: ATT_PNG, filename: "photo.png", content_type: "image/png", content_disposition: "inline", content_id: "img001", size: PNG.length },
      { id: ATT_PDF, filename: "site plan.pdf", content_type: "application/pdf", content_disposition: null, content_id: null, size: PDF.length },
      { id: ATT_HTML, filename: "invoice.html", content_type: "text/html", content_disposition: "attachment", content_id: null, size: HTML_ATT.length },
    ],
    ...over,
  };
}

function attachmentList(files = [[ATT_PNG, PNG], [ATT_PDF, PDF], [ATT_HTML, HTML_ATT]], urlOf = (id) => `${CDN}/${EMAIL_ID}/attachments/${id}?signature=sig`) {
  return files.map(([id, bytes, size]) => {
    const url = urlOf(id);
    world.resend.files.set(url, bytes);
    return { id, size: size ?? bytes.length, download_url: url, expires_at: "2026-10-17T14:29:41.521Z" };
  });
}

async function fakeFetch(url, init = {}) {
  const auth = new Headers(init.headers ?? {}).get("authorization");
  world.fetchLog.push({ url, auth, redirect: init.redirect, method: init.method });
  const api = "https://api.resend.com/emails/receiving/";
  if (url.startsWith(api)) {
    if (auth !== `Bearer ${RKEY}`) return new Response("{}", { status: 401 });
    const rest = url.slice(api.length);
    const m = /^([^/?]+)(\/attachments)?(\?.*)?$/.exec(rest);
    const id = decodeURIComponent(m?.[1] ?? "");
    const status = world.resend.status.get(m?.[2] ? `${id}/attachments` : id);
    if (status) return new Response("{}", { status });
    if (m?.[2]) {
      const list = world.resend.lists.get(id);
      return list ? Response.json({ object: "list", has_more: false, data: list }) : new Response("{}", { status: 404 });
    }
    const email = world.resend.emails.get(id);
    return email ? Response.json(email) : new Response("{}", { status: 404 });
  }
  const bytes = world.resend.files.get(url);
  if (bytes) return new Response(bytes, { status: 200 });
  return new Response("not found", { status: 404 });
}

function deps(over = {}) {
  return {
    fetch: fakeFetch,
    now: () => world.now,
    env: (k) => world.env[k],
    background: (work) => {
      world.bg.push(work);
      return work;
    },
    ...over,
  };
}

// ===========================================================================
// Deliveries
// ===========================================================================

function sign(id, ts, body, key = SIGNING_KEY) {
  return `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
}

function eventData(over = {}) {
  return {
    email_id: EMAIL_ID,
    created_at: "2026-09-22T11:59:30.000Z",
    from: "pat@example.org",
    to: [`${TOKEN_A}.${RT_A}@${DOMAIN}`],
    bcc: [],
    cc: ["office@acmefence.com", "sam@example.net"],
    received_for: [],
    message_id: "<reply-1@example.org>",
    subject: "Re: Your fence quote",
    attachments: [
      { id: ATT_PNG, filename: "photo.png", content_type: "image/png", content_disposition: "inline", content_id: "img001" },
      { id: ATT_PDF, filename: "site plan.pdf", content_type: "application/pdf", content_disposition: null, content_id: null },
      { id: ATT_HTML, filename: "invoice.html", content_type: "text/html", content_disposition: "attachment", content_id: null },
    ],
    ...over,
  };
}

let svixSeq = 0;
function delivery({ data = eventData(), type = "email.received", id = `msg_test${++svixSeq}`, ts = Math.floor(world.now / 1000), body, signBody, key, headers, method = "POST" } = {}) {
  const raw = body ?? JSON.stringify({ type, created_at: "2026-09-22T11:59:31.000Z", data });
  const h = headers ?? {
    "svix-id": id,
    "svix-timestamp": String(ts),
    "svix-signature": sign(id, ts, signBody ?? raw, key),
    "content-type": "application/json",
  };
  return new Request("https://project.example.supabase.co/functions/v1/resend-inbound", method === "GET" ? { method, headers: h } : { method, headers: h, body: raw });
}

async function call(req, d = deps()) {
  const res = await fn.handleRequest(req, d);
  const text = await res.text();
  RESPONSES.push(text);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, text };
}

const apiCalls = () => world.fetchLog.filter((f) => f.url.startsWith("https://api.resend.com/"));
const emailGets = () => apiCalls().filter((f) => !f.url.includes("/attachments"));
const downloads = () => world.fetchLog.filter((f) => !f.url.startsWith("https://api.resend.com/"));
const nothingTouched = () => {
  assert.deepEqual(world.created, [], "no Supabase client may exist before the door has passed");
  assert.deepEqual(world.fetchLog, [], "Resend must not be asked anything");
  assert.equal(world.mail_messages.length, 0);
  assert.equal(world.mail_inbound_events.length, 0);
};

// ===========================================================================
// The door
// ===========================================================================

test("only POST is answered", async () => {
  newWorld();
  const r = await call(delivery({ method: "GET" }));
  assert.equal(r.status, 405);
  nothingTouched();
});

test("PLANTED: with RESEND_WEBHOOK_SECRET unset, even a properly signed delivery is refused with 503 and a clear reason", async () => {
  newWorld();
  delete world.env.RESEND_WEBHOOK_SECRET;
  const r = await call(delivery());
  assert.equal(r.status, 503);
  assert.equal(r.body.error_code, "not_configured");
  assert.match(r.body.detail, /RESEND_WEBHOOK_SECRET/);
  assert.match(r.body.detail, /Nothing was accepted/);
  nothingTouched();
});

test("a RESEND_WEBHOOK_SECRET that is not a whsec_ key refuses everything (503), not 'bad signature'", async () => {
  newWorld();
  world.env.RESEND_WEBHOOK_SECRET = "paste-error";
  const r = await call(delivery());
  assert.equal(r.status, 503);
  assert.equal(r.body.error_code, "not_configured");
  assert.doesNotMatch(r.text, /paste-error/);
  nothingTouched();
});

test("PLANTED: unsigned, re-signed, tampered, replayed and future-dated deliveries get 401 and touch nothing", async () => {
  newWorld();
  const cases = [
    ["no svix headers", delivery({ headers: { "content-type": "application/json" } }), "missing_headers"],
    ["signed with another secret", delivery({ key: Buffer.from("another-secret-another-secret-00", "utf8") }), "bad_signature"],
    ["body changed after signing", delivery({ signBody: JSON.stringify({ type: "email.received", data: eventData({ to: [`${TOKEN_B}@${DOMAIN}`] }) }) }), "bad_signature"],
    ["6 minutes old", delivery({ ts: Math.floor(world.now / 1000) - 360 }), "stale"],
    ["6 minutes ahead", delivery({ ts: Math.floor(world.now / 1000) + 360 }), "stale"],
    ["a v2 signature only", delivery({ headers: { "svix-id": "msg_x", "svix-timestamp": String(Math.floor(world.now / 1000)), "svix-signature": "v2,AAAA" } }), "bad_signature"],
  ];
  for (const [what, req, reason] of cases) {
    const r = await call(req);
    assert.equal(r.status, 401, what);
    assert.equal(r.body.reason, reason, what);
  }
  nothingTouched();
});

test("a delivery just inside the 5-minute window is accepted (positive control for the window)", async () => {
  newWorld();
  const r = await call(delivery({ ts: Math.floor(world.now / 1000) - 290 }));
  assert.equal(r.status, 200);
  assert.equal(world.mail_messages.length, 1);
});

test("a body over the cap is refused before anything is verified or created", async () => {
  newWorld();
  const big = JSON.stringify({ type: "email.received", data: eventData({ subject: "x".repeat(WEBHOOK_BODY_MAX_BYTES) }) });
  const r = await call(delivery({ body: big }));
  assert.equal(r.status, 413);
  nothingTouched();
});

test("PLANTED: secret set but receiving half set up -- unsigned gets 401 first; signed gets 503 naming what is missing, and nothing is stored", async () => {
  newWorld();
  delete world.env.RESEND_RECEIVING_KEY;
  delete world.env.MAIL_INBOUND_DOMAIN;
  const forged = await call(delivery({ headers: {} }));
  assert.equal(forged.status, 401, "an unsigned caller learns nothing about the configuration");
  const r = await call(delivery());
  assert.equal(r.status, 503);
  assert.equal(r.body.error_code, "not_configured");
  assert.match(r.body.detail, /RESEND_RECEIVING_KEY/);
  assert.match(r.body.detail, /MAIL_INBOUND_DOMAIN/);
  assert.match(r.body.detail, /Resend will retry/);
  nothingTouched();

  world.env.RESEND_RECEIVING_KEY = RKEY;
  world.env.MAIL_INBOUND_DOMAIN = "not a domain";
  const r2 = await call(delivery());
  assert.equal(r2.status, 503);
  assert.match(r2.body.detail, /MAIL_INBOUND_DOMAIN is not a domain/);
  nothingTouched();
});

test("once the settings are in, Resend's retry of a refused delivery is stored (nothing was recorded the first time)", async () => {
  newWorld();
  delete world.env.RESEND_RECEIVING_KEY;
  const req = () => delivery({ id: "msg_retry_after_setup", ts: Math.floor(world.now / 1000) });
  assert.equal((await call(req())).status, 503);
  world.env.RESEND_RECEIVING_KEY = RKEY;
  world.now += 5 * 60_000 - 1000; // Resend's second retry comes 5 minutes later, signed afresh
  const r = await call(req());
  assert.equal(r.status, 200);
  assert.equal(world.mail_messages.length, 1);
});

test("signed events other than email.received are acknowledged and ignored, even while receiving is not set up", async () => {
  newWorld();
  delete world.env.RESEND_RECEIVING_KEY;
  const r = await call(delivery({ type: "email.sent" }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, ignored: "email.sent" });
  nothingTouched();
});

test("a signed body that is not JSON is a 400, and nothing is created", async () => {
  newWorld();
  const r = await call(delivery({ body: "not json at all" }));
  assert.equal(r.status, 400);
  nothingTouched();
});

// ===========================================================================
// A reply comes home
// ===========================================================================

test("a reply to <token>.<thread>@reply domain lands in that company's thread, with its text, and nothing personal in the answer", async () => {
  newWorld();
  const r = await call(delivery({ id: "msg_happy" }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, stored: 1, duplicates: 0, dropped: 0 });
  assert.doesNotMatch(r.text, /pat@|example\.org|fence quote|a1b2c3/i, "the answer carries counts only");

  assert.equal(world.mail_messages.length, 1);
  const m = world.mail_messages[0];
  assert.equal(m.company_id, C1);
  assert.equal(m.account_id, ACC_A);
  assert.equal(m.thread_id, THREAD_A, "the reply_token picked the thread");
  assert.equal(m.source, "resend_inbound");
  assert.equal(m.folder_role, "inbox");
  assert.equal(m.provider_message_id, EMAIL_ID);
  assert.equal(m.message_id_header, "reply-1@example.org");
  assert.equal(m.parent_ids[0], "quote-1@send.fenceflowapp.com", "the message it answered comes first");
  assert.ok(m.parent_ids.includes("root-1@send.fenceflowapp.com"));
  assert.equal(m.from_address, "pat@example.org");
  assert.equal(m.from_name, "Pat Customer", "the display name comes from the real From header");
  assert.equal(m.subject, "Re: Your fence quote");
  assert.equal(m.received_at, "2026-09-22T11:59:30.000Z");
  assert.equal(m.is_seen, false);
  assert.equal(m.body_state, "cached");
  assert.match(m.body_text, /^Yes please, go ahead\./);
  assert.match(m.body_html, /<p>Yes please/);
  assert.equal(m.snippet, "Yes please, go ahead.", "the preview leaves out the quoted history");
  // The customer and the neighbour; never the routing address, never the company's own mailbox.
  assert.deepEqual([...m.counterpart_emails].sort(), ["pat@example.org", "sam@example.net"]);
  assert.ok(m.to_list.some((a) => a.address.toLowerCase() === `${TOKEN_A}.${RT_A}@${DOMAIN}`));
  assert.equal(m.has_attachments, true);

  // Resend's API was asked with the key; nothing ever followed a redirect.
  assert.ok(apiCalls().length >= 1);
  for (const c of apiCalls()) assert.equal(c.auth, `Bearer ${RKEY}`);
  for (const c of world.fetchLog) assert.equal(c.redirect, "error", c.url);

  // Counted once, recorded as handled, and receiving is (still) proven.
  assert.equal(countEvents(C1, "inbound", 86_400_000), 1);
  assert.deepEqual(world.mail_inbound_events.map((e) => [e.svix_id, e.email_id, e.company_id]), [["msg_happy", EMAIL_ID, C1]]);
  assert.equal(world.mail_platform_settings[0].last_inbound_at, new Date(NOW).toISOString());
});

test("attachments are pending on arrival, then stored in mail-files under the company's own path, typed so nothing renders", async () => {
  newWorld();
  let rowAtIngest = null;
  const r = await call(delivery(), deps({
    background: (work) => {
      rowAtIngest = clone(world.mail_messages[0]);
      world.bg.push(work);
      return work;
    },
  }));
  assert.equal(r.status, 200);
  assert.ok(rowAtIngest, "the background download was handed to the runtime");
  assert.deepEqual(rowAtIngest.attachments.map((a) => a.state), ["pending", "pending", "pending"]);
  assert.deepEqual(rowAtIngest.attachments.map((a) => a.provider_id), [ATT_PNG, ATT_PDF, ATT_HTML]);
  assert.deepEqual(rowAtIngest.attachments.map((a) => a.disposition), ["inline", "attachment", "attachment"]);

  const m = world.mail_messages[0];
  const prefix = `${C1}/${ACC_A}/${m.id}/`;
  assert.deepEqual(m.attachments.map((a) => a.state), ["stored", "stored", "stored"]);
  assert.deepEqual(m.attachments.map((a) => a.storage_path), [`${prefix}0-photo.png`, `${prefix}1-site_plan.pdf`, `${prefix}2-invoice.html`]);
  assert.equal(world.storage.get(`mail-files/${prefix}0-photo.png`).contentType, "image/png");
  assert.equal(world.storage.get(`mail-files/${prefix}1-site_plan.pdf`).contentType, "application/pdf");
  // PLANTED: an HTML attachment must never be stored as something a browser renders.
  assert.equal(world.storage.get(`mail-files/${prefix}2-invoice.html`).contentType, "application/octet-stream");
  assert.deepEqual(world.storage.get(`mail-files/${prefix}1-site_plan.pdf`).bytes, PDF);
  // PLANTED: our key never goes to a download link.
  assert.equal(downloads().length, 3);
  for (const d of downloads()) assert.equal(d.auth, null, d.url);
});

test("with the runtime keeping the downloads alive (EdgeRuntime.waitUntil), the answer does not wait for them", async () => {
  newWorld();
  let release;
  const gate = new Promise((r) => (release = r));
  const slowFetch = async (url, init) => {
    if (!url.startsWith("https://api.resend.com/")) await gate;
    return fakeFetch(url, init);
  };
  const r = await call(delivery(), deps({
    fetch: slowFetch,
    background: (work) => {
      world.bg.push(work);
      return null;
    },
  }));
  assert.equal(r.status, 200);
  assert.deepEqual(world.mail_messages[0].attachments.map((a) => a.state), ["pending", "pending", "pending"]);
  release();
  await Promise.all(world.bg);
  assert.deepEqual(world.mail_messages[0].attachments.map((a) => a.state), ["stored", "stored", "stored"]);
});

test("the same svix-id delivered twice is handled once: no second fetch, no second row", async () => {
  newWorld();
  const req = () => delivery({ id: "msg_twice" });
  assert.equal((await call(req())).status, 200);
  const before = world.fetchLog.length;
  const r = await call(req());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, duplicate: true });
  assert.equal(world.fetchLog.length, before, "Resend is not asked again");
  assert.equal(world.mail_messages.length, 1);
});

test("the same email under a new svix-id (at-least-once) is stored once; the cap's ledger counts both deliveries", async () => {
  newWorld();
  assert.equal((await call(delivery({ id: "msg_first" }))).status, 200);
  const downloadsBefore = downloads().length;
  const r = await call(delivery({ id: "msg_second" }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, stored: 0, duplicates: 1, dropped: 0 });
  assert.equal(world.mail_messages.length, 1);
  // Admission is recorded before anyone knows it is a duplicate: the cap
  // errs toward storing less, never toward letting a burst through.
  assert.equal(countEvents(C1, "inbound", 86_400_000), 2);
  assert.equal(downloads().length, downloadsBefore, "no second download of the same attachments");
});

test("PLANTED: company B's thread token behind company A's address goes to A, and never into B's thread", async () => {
  newWorld();
  const to = [`${TOKEN_A}.${RT_B}@${DOMAIN}`];
  world.resend.emails.set(EMAIL_ID, receivedEmail({ to, headers: { from: "Mallory <m@example.org>", to: to[0] } }));
  const r = await call(delivery({ data: eventData({ to }) }));
  assert.equal(r.status, 200);
  const ingests = world.rpcLog.filter((c) => c.name === "mail_ingest");
  assert.deepEqual(ingests.map((c) => c.args.p_account), [ACC_A], "the account comes from the inbound token alone");
  const m = world.mail_messages[0];
  assert.equal(m.company_id, C1);
  assert.notEqual(m.thread_id, THREAD_B);
  assert.equal(world.mail_messages.filter((x) => x.company_id === C2).length, 0);
});

test("a bare <token>@ address (no thread) still reaches its company, in a thread of its own", async () => {
  newWorld();
  const to = [`Bravo <${TOKEN_B}@${DOMAIN}>`];
  world.resend.emails.set(EMAIL_ID, receivedEmail({ to, headers: { from: "Pat <pat@example.org>", to: to[0] }, message_id: "<fresh-1@example.org>" }));
  const r = await call(delivery({ data: eventData({ to }) }));
  assert.equal(r.status, 200);
  const m = world.mail_messages[0];
  assert.equal(m.account_id, ACC_B);
  assert.equal(m.company_id, C2);
  assert.notEqual(m.thread_id, THREAD_B);
});

test("a delivery copied to two companies' addresses is stored once in each, and the thread token is kept when one route has it", async () => {
  newWorld();
  const to = [`${TOKEN_A}@${DOMAIN}`, `${TOKEN_B}@${DOMAIN}`];
  const r = await call(delivery({ data: eventData({ to, cc: [`${TOKEN_A}.${RT_A}@${DOMAIN}`] }) }));
  assert.equal(r.status, 200);
  assert.equal(r.body.stored, 2);
  const a = world.mail_messages.find((m) => m.company_id === C1);
  const b = world.mail_messages.find((m) => m.company_id === C2);
  assert.equal(a.account_id, ACC_A);
  assert.equal(a.thread_id, THREAD_A, "the route with a thread token wins over the bare one");
  assert.equal(b.account_id, ACC_B);
  assert.equal(world.mail_inbound_events.length, 1);
});

test("PLANTED: an unknown token is dropped with 200 and counted, nothing stored, Resend not asked (receiving already proven)", async () => {
  newWorld();
  const r = await call(delivery({ data: eventData({ to: [`ffffffffffffffff.${RT_A}@${DOMAIN}`] }) }));
  assert.equal(r.status, 200);
  assert.equal(r.body.dropped, "unknown_recipient");
  assert.equal(world.mail_messages.length, 0);
  assert.deepEqual(world.fetchLog, []);
  assert.equal(countEvents(null, "inbound_dropped", 86_400_000), 1);
  assert.equal(world.mail_inbound_events.length, 1);
});

test("a disconnected FenceFlow-mail account's token is treated as unknown", async () => {
  newWorld();
  const r = await call(delivery({ data: eventData({ to: [`${TOKEN_GONE}@${DOMAIN}`] }) }));
  assert.equal(r.status, 200);
  assert.equal(r.body.dropped, "unknown_recipient");
  assert.equal(world.mail_messages.length, 0);
});

test("PLANTED: a real token at the wrong domain is never routed, proves nothing, and Resend is not asked", async () => {
  newWorld();
  unverified();
  for (const addr of [`${TOKEN_A}.${RT_A}@${DOMAIN}.evil.example`, `${TOKEN_A}.${RT_A}@sub.${DOMAIN}`, `${TOKEN_A}.${RT_A}@fenceflowapp.com`]) {
    const r = await call(delivery({ data: eventData({ to: [addr], cc: [] }) }));
    assert.equal(r.status, 200, addr);
    assert.equal(r.body.dropped, "unknown_recipient", addr);
  }
  assert.equal(world.mail_messages.length, 0);
  assert.equal(world.rpcLog.filter((c) => c.name === "mail_ingest").length, 0);
  assert.deepEqual(world.fetchLog, []);
  assert.equal(world.mail_platform_settings[0].inbound_verified_at, null);
});

test("a malformed local part at the right domain is not a route (extra label, upper case, junk)", async () => {
  newWorld();
  for (const addr of [`${TOKEN_A}.${RT_A}.x@${DOMAIN}`, `${TOKEN_A.toUpperCase()}Z@${DOMAIN}`, `${TOKEN_A}.@${DOMAIN}`, `${TOKEN_A.slice(0, 11)}@${DOMAIN}`]) {
    const r = await call(delivery({ data: eventData({ to: [addr], cc: [] }) }));
    assert.equal(r.status, 200, addr);
    assert.equal(r.body.dropped, "unknown_recipient", addr);
  }
  assert.equal(world.rpcLog.filter((c) => c.name === "mail_ingest").length, 0);
});

test("PLANTED: receiving is proven only by the whole chain -- a signed test message at the reply domain whose content Resend hands over", async () => {
  newWorld();
  unverified();
  // Not at the domain: signed, but proves nothing, and Resend is not asked.
  await call(delivery({ data: eventData({ to: ["someone@abc123.resend.app"], cc: [] }) }));
  assert.equal(world.mail_platform_settings[0].inbound_verified_at, null);
  assert.deepEqual(world.fetchLog, []);

  // At the domain, but Resend refuses the key: 503, not proven, not recorded (so it is retried).
  world.resend.status.set(EMAIL_ID, 401);
  const refused = await call(delivery({ id: "msg_test_at_domain", data: eventData({ to: [`test@${DOMAIN}`], cc: [] }) }));
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error_code, "not_configured");
  assert.match(refused.body.detail, /Full access/);
  assert.equal(world.mail_platform_settings[0].inbound_verified_at, null);
  assert.ok(!world.mail_inbound_events.some((e) => e.svix_id === "msg_test_at_domain"), "a refused delivery is not recorded as handled");

  // The key fixed: the retry proves it.
  world.resend.status.delete(EMAIL_ID);
  const ok = await call(delivery({ id: "msg_test_at_domain", data: eventData({ to: [`test@${DOMAIN}`], cc: [] }) }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.dropped, "unknown_recipient");
  assert.equal(world.mail_messages.length, 0, "the test message itself is not stored anywhere");
  assert.equal(world.mail_platform_settings[0].inbound_verified_at, new Date(NOW).toISOString());
  assert.equal(world.mail_platform_settings[0].inbound_domain, DOMAIN);
  assert.equal(emailGets().length, 2);
});

test("a proof for another domain does not count: a changed MAIL_INBOUND_DOMAIN has to be proven again", async () => {
  newWorld();
  world.mail_platform_settings[0].inbound_domain = "reply.old-domain.example";
  const r = await call(delivery());
  assert.equal(r.status, 200);
  assert.equal(world.mail_platform_settings[0].inbound_domain, DOMAIN);
  assert.equal(world.mail_platform_settings[0].inbound_verified_at, new Date(NOW).toISOString());
});

test("a stored reply also proves receiving the first time", async () => {
  newWorld();
  unverified();
  const r = await call(delivery());
  assert.equal(r.status, 200);
  assert.equal(world.mail_platform_settings[0].inbound_verified_at, new Date(NOW).toISOString());
});

test("PLANTED: the daily cap holds at exactly INBOUND_PER_COMPANY_PER_DAY, and only the last 24 hours count", async () => {
  newWorld();
  const seed = (n, at) => {
    for (let i = 0; i < n; i++) world.mail_events.push({ company_id: C1, kind: "inbound", at });
  };
  seed(INBOUND_PER_COMPANY_PER_DAY, NOW - 60_000);
  const r = await call(delivery({ id: "msg_over_cap" }));
  assert.equal(r.status, 200);
  assert.equal(r.body.dropped, "daily_limit");
  assert.equal(world.mail_messages.length, 0);
  assert.deepEqual(world.fetchLog, [], "a capped message is not even fetched");
  assert.equal(countEvents(C1, "inbound_dropped", 86_400_000), 1);

  newWorld();
  seed(INBOUND_PER_COMPANY_PER_DAY - 1, NOW - 60_000);
  seed(50, NOW - 25 * 3_600_000);
  const ok = await call(delivery({ id: "msg_under_cap" }));
  assert.equal(ok.status, 200);
  assert.equal(world.mail_messages.length, 1);
});

test("a ledger that cannot be written refuses (500, retried) rather than admitting mail uncounted", async () => {
  newWorld();
  world.failRpc.add("note_mail_event");
  const r = await call(delivery());
  assert.equal(r.status, 500);
  assert.equal(world.mail_messages.length, 0);
  assert.equal(world.mail_inbound_events.length, 0);
});

test("PLANTED: Resend failing (500) answers 502 and records nothing, so the retry is processed, not skipped", async () => {
  newWorld();
  world.resend.status.set(EMAIL_ID, 500);
  const req = () => delivery({ id: "msg_flaky" });
  const r = await call(req());
  assert.equal(r.status, 502);
  assert.equal(world.mail_messages.length, 0);
  assert.equal(world.mail_inbound_events.length, 0, "a failure is never recorded as handled");
  world.resend.status.delete(EMAIL_ID);
  const retry = await call(req());
  assert.equal(retry.status, 200);
  assert.equal(retry.body.stored, 1);
  assert.equal(world.mail_messages.length, 1);
});

test("mail_ingest failing answers 500 and records nothing; the retry stores the message once", async () => {
  newWorld();
  world.failRpc.add("mail_ingest");
  const req = () => delivery({ id: "msg_db_down" });
  assert.equal((await call(req())).status, 500);
  assert.equal(world.mail_inbound_events.length, 0);
  world.failRpc.delete("mail_ingest");
  assert.equal((await call(req())).status, 200);
  assert.equal(world.mail_messages.length, 1);
  // Both attempts were admitted, so both count; the message is stored once.
  assert.equal(countEvents(C1, "inbound", 86_400_000), 2);
});

test("PLANTED: deliveries arriving together cannot pass the daily cap together", async () => {
  newWorld();
  const room = 3;
  for (let i = 0; i < INBOUND_PER_COMPANY_PER_DAY - room; i++) world.mail_events.push({ company_id: C1, kind: "inbound", at: NOW - 60_000 });
  // Six different replies, all in flight at once: Resend answers none of
  // them until every delivery has either reached it or been turned away.
  const n = room * 2;
  const ids = Array.from({ length: n }, (_, i) => `5ab0c1d2-0000-4000-8000-00000000000${i}`);
  for (const [i, id] of ids.entries()) {
    world.resend.emails.set(id, receivedEmail({ id, message_id: `<burst-${i}@example.org>`, attachments: [],
      headers: { from: "Pat Customer <pat@example.org>", "message-id": `<burst-${i}@example.org>` } }));
  }
  let arrived = 0;
  let settled = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const d = deps({
    fetch: async (url, init) => {
      if (url.startsWith("https://api.resend.com/")) {
        arrived++;
        await gate;
      }
      return fakeFetch(url, init);
    },
  });
  const calls = ids.map((id) => call(delivery({ data: eventData({ email_id: id, attachments: [] }) }), d).finally(() => settled++));
  while (arrived + settled < n) await new Promise((r) => setImmediate(r));
  // Positive control: the deliveries really were concurrent -- the ones
  // admitted were all waiting on Resend at the same moment.
  assert.equal(arrived, room, `${arrived} deliveries reached Resend at once`);
  release();
  const answers = await Promise.all(calls);
  assert.ok(answers.every((a) => a.status === 200), JSON.stringify(answers.map((a) => a.status)));
  assert.equal(world.mail_messages.length, room, "the burst stored past the cap");
  assert.equal(answers.filter((a) => a.body.dropped === "daily_limit").length, n - room);
  assert.equal(countEvents(C1, "inbound_dropped", 86_400_000), n - room);
});

test("a message Resend no longer has is still stored from the signed event, uncached, and proves nothing", async () => {
  newWorld();
  unverified();
  world.resend.emails.delete(EMAIL_ID);
  const r = await call(delivery());
  assert.equal(r.status, 200);
  const m = world.mail_messages[0];
  assert.equal(m.body_state, "none");
  assert.equal(m.body_text, null);
  assert.equal(m.subject, "Re: Your fence quote");
  assert.equal(m.from_address, "pat@example.org");
  assert.equal(m.message_id_header, "reply-1@example.org");
  assert.deepEqual(m.attachments.map((a) => [a.state, a.disposition]), [["pending", "attachment"], ["pending", "attachment"], ["pending", "attachment"]],
    "no size known, so nothing is claimed inline");
  assert.equal(downloads().length, 0, "nothing to download from");
  assert.equal(world.mail_platform_settings[0].inbound_verified_at, null);
});

test("PLANTED: an attachment link outside resend.com is never fetched; the part stays pending", async () => {
  newWorld();
  const evil = ["https://169.254.169.254/latest/meta-data", "http://inbound-cdn.resend.com/x", "https://resend.com.evil.example/x"];
  world.resend.lists.set(EMAIL_ID, attachmentList([[ATT_PNG, PNG], [ATT_PDF, PDF], [ATT_HTML, HTML_ATT]], (id) =>
    id === ATT_PNG ? evil[0] : id === ATT_PDF ? evil[1] : evil[2]));
  const r = await call(delivery());
  assert.equal(r.status, 200);
  assert.deepEqual(downloads(), [], "not one request left api.resend.com");
  assert.deepEqual(world.mail_messages[0].attachments.map((a) => a.state), ["pending", "pending", "pending"]);
  assert.equal(world.storage.size, 0);
});

test("an attachment Resend says is over 10 MB is marked too_large and never downloaded", async () => {
  newWorld();
  world.resend.lists.set(EMAIL_ID, attachmentList([[ATT_PNG, PNG], [ATT_PDF, PDF, 11 * 1024 * 1024], [ATT_HTML, HTML_ATT]]));
  const r = await call(delivery());
  assert.equal(r.status, 200);
  const states = world.mail_messages[0].attachments.map((a) => a.state);
  assert.deepEqual(states, ["stored", "too_large", "stored"]);
  assert.ok(!downloads().some((d) => d.url.includes(ATT_PDF)));
});

test("a download that fails leaves only that part pending; the rest are stored", async () => {
  newWorld();
  world.resend.lists.set(EMAIL_ID, attachmentList());
  world.resend.files.delete(`${CDN}/${EMAIL_ID}/attachments/${ATT_PDF}?signature=sig`);
  const r = await call(delivery());
  assert.equal(r.status, 200);
  assert.deepEqual(world.mail_messages[0].attachments.map((a) => a.state), ["stored", "pending", "stored"]);
});

test("the background merge never overwrites a part mail-message stored meanwhile", async () => {
  newWorld();
  let release;
  const gate = new Promise((r) => (release = r));
  const slowFetch = async (url, init) => {
    if (url.includes("/attachments")) await gate;
    return fakeFetch(url, init);
  };
  const r = await call(delivery(), deps({ fetch: slowFetch, background: (w) => (world.bg.push(w), null) }));
  assert.equal(r.status, 200);
  // mail-message opened it first and stored part 1 under its own record.
  const m = world.mail_messages[0];
  m.attachments[1] = { ...m.attachments[1], state: "stored", storage_path: `${C1}/${ACC_A}/${m.id}/1-by-mail-message.pdf` };
  // ...and idx 2 now names a different part: not ours to fill in.
  m.attachments[2] = { ...m.attachments[2], provider_id: "some-other-part" };
  release();
  await Promise.all(world.bg);
  assert.equal(m.attachments[1].storage_path, `${C1}/${ACC_A}/${m.id}/1-by-mail-message.pdf`);
  assert.deepEqual(m.attachments.map((a) => a.state), ["stored", "stored", "pending"]);
  assert.equal(m.attachments[2].provider_id, "some-other-part");
});

// ===========================================================================
// The pure parts
// ===========================================================================

test("headerValue reads Resend's object or list form, case-insensitively, own keys only", () => {
  assert.equal(fn.headerValue({ "In-Reply-To": "<a@b>" }, "in-reply-to"), "<a@b>");
  assert.equal(fn.headerValue([{ name: "References", value: "<a@b>" }, { key: "references", value: ["<c@d>"] }], "references"), "<a@b> <c@d>");
  assert.equal(fn.headerValue(Object.create({ subject: "inherited" }), "subject"), null);
  assert.equal(fn.headerValue(null, "subject"), null);
  assert.equal(fn.headerValue({ subject: "   " }, "subject"), null);
});

test("partsFromResend: inline only for a shown picture type of known size; SVG, unknown size and a repeated Content-ID are attachments", () => {
  const parts = fn.partsFromResend([
    { id: "a1", filename: "logo.svg", content_type: "image/svg+xml", content_disposition: "inline", content_id: "c1", size: 100 },
    { id: "a2", filename: "pic.png", content_type: "image/png", content_disposition: "inline", content_id: "c2" },
    { id: "a3", filename: "pic.png", content_type: "image/png", content_disposition: "inline", content_id: "c3", size: 100 },
    { id: "a4", filename: "again.png", content_type: "image/png", content_disposition: "inline", content_id: "c3", size: 100 },
    { id: "../bad id", filename: "x", content_type: "text/plain" },
    { id: "a5", filename: "../../etc/passwd", content_type: "Not A Type" },
  ]);
  assert.deepEqual(parts.map((p) => p.disposition), ["attachment", "attachment", "inline", "attachment", "attachment"]);
  assert.deepEqual(parts.map((p) => p.idx), [0, 1, 2, 3, 4]);
  assert.deepEqual(parts.map((p) => p.provider_id), ["a1", "a2", "a3", "a4", "a5"]);
  assert.equal(parts[4].content_type, "application/octet-stream");
  assert.doesNotMatch(parts[4].filename, /\//);
  assert.ok(parts.every((p) => p.state === "pending" && p.storage_path === null));
});

test("inboundRow without headers falls back to the top-level fields, and never lists Bcc", () => {
  const row = fn.inboundRow(
    { from: "Pat <pat@example.org>", to: [`${TOKEN_A}@${DOMAIN}`], cc: [], bcc: ["hidden@example.com"], subject: "Hello\r\nBcc: x@y", message_id: "<m1@x>", created_at: "2026-09-22T10:00:00Z" },
    { emailId: EMAIL_ID, replyToken: null, own: { addresses: [], domains: [DOMAIN] }, bodyState: "none", receivedAt: null, now: new Date(NOW) },
  );
  assert.equal(row.from_address, "pat@example.org");
  assert.equal(row.from_name, "Pat");
  assert.equal(row.subject, "Hello Bcc: x@y", "a line break in a subject cannot start a new header line");
  assert.deepEqual(row.counterpart_emails, ["pat@example.org"]);
  assert.ok(!JSON.stringify(row).includes("hidden@example.com"));
  assert.equal(row.reply_token, undefined);
  assert.equal(row.received_at, "2026-09-22T10:00:00.000Z");
});

test("reachesDomain is exact: a sub-domain or a look-alike is not the reply domain", () => {
  assert.equal(fn.reachesDomain([`Test <test@${DOMAIN}>`], DOMAIN), true);
  assert.equal(fn.reachesDomain([`test@sub.${DOMAIN}`, `test@${DOMAIN}.evil.example`, "test@xreply.fenceflowapp.com"], DOMAIN), false);
});

// ===========================================================================
// The SQL contract
// ===========================================================================

// Writes, as JSON, every payload this function sends to the database, taken
// from the real handler: the rows it hands mail_ingest, the attachment
// merge, the delivery log row, the settings patches and the ledger calls.
// A separate script replays them against supabase_mail.sql inside one
// rolled-back transaction, so a key, a type or a constraint the fake above
// gets wrong is caught against the real schema.
test("capture payloads for the SQL contract check (only when MAIL_RESEND_INBOUND_CAPTURE is set)", { skip: !process.env.MAIL_RESEND_INBOUND_CAPTURE && "MAIL_RESEND_INBOUND_CAPTURE not set" }, async () => {
  const ingestRows = () => world.rpcLog.filter((c) => c.name === "mail_ingest").map((c) => c.args.p_rows);
  const out = {};

  newWorld();
  unverified();
  await call(delivery({ id: "msg_capture_happy" }));
  out.happy = ingestRows()[0];
  out.merge = world.queryLog.find((q) => q.table === "mail_messages" && q.op === "update").patch;
  out.handled = world.queryLog.find((q) => q.table === "mail_inbound_events" && q.op === "insert").row;
  out.verify = world.queryLog.find((q) => q.table === "mail_platform_settings" && q.op === "update").patch;
  out.ledger = world.rpcLog.filter((c) => c.name === "note_mail_event" || c.name === "mail_event_count").map((c) => ({ name: c.name, args: c.args }));

  newWorld();
  const crossId = "6a7b8c9d-2222-4333-8444-555566667777";
  const to = [`${TOKEN_A}.${RT_B}@${DOMAIN}`];
  world.resend.emails.set(crossId, receivedEmail({ id: crossId, to, headers: { from: "Mallory <m@example.org>", to: to[0] }, message_id: "<cross-1@example.org>", attachments: [] }));
  world.resend.lists.set(crossId, []);
  await call(delivery({ data: eventData({ email_id: crossId, to, attachments: [] }) }));
  out.cross = ingestRows()[0];

  newWorld();
  world.resend.emails.delete(EMAIL_ID);
  await call(delivery({ data: eventData({ email_id: "5f0a2b3c-1111-4222-8333-444455556666", message_id: "<gone-1@example.org>", to: [`${TOKEN_A}@${DOMAIN}`] }) }));
  out.none = ingestRows()[0];

  newWorld();
  await call(delivery({ data: eventData({ to: [`ffffffffffffffff@${DOMAIN}`] }) }));
  out.dropped = world.rpcLog.filter((c) => c.name === "note_mail_event").map((c) => c.args);
  out.seen = world.queryLog.find((q) => q.table === "mail_platform_settings" && q.op === "update")?.patch ?? null;

  for (const k of ["happy", "merge", "handled", "verify", "cross", "none", "dropped"]) assert.ok(out[k], `captured ${k}`);
  writeFileSync(process.env.MAIL_RESEND_INBOUND_CAPTURE, JSON.stringify(out, null, 1));
});

// Last: everything printed and answered in this file.
test("PLANTED: neither the webhook secret nor the receiving key ever reached a log line or a response", () => {
  assert.ok(LOGS.length > 0, "positive control: the failure tests above did log something");
  assert.ok(RESPONSES.some((r) => r.includes("not_configured")), "positive control: responses were captured");
  const secretB64 = SIGNING_KEY.toString("base64");
  for (const text of RESPONSES) {
    assert.ok(!text.includes(RKEY), `receiving key in a response: ${text}`);
    assert.ok(!text.includes(secretB64), `webhook secret in a response: ${text}`);
  }
  for (const line of LOGS) {
    assert.ok(!line.includes(RKEY), `receiving key in a log: ${line}`);
    assert.ok(!line.includes(secretB64), `webhook secret in a log: ${line}`);
    assert.ok(!/pat@example\.org|Yes please/.test(line), `mail content in a log: ${line}`);
  }
});
