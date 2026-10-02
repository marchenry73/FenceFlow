// a55 -- EMAILING THE CUSTOMER THEIR CONTRACT WHEN THEY APPROVE: the sender
// (supabase/functions/quote-approval-email) and the approval that calls it
// (supabase/functions/quote-view), run for real, in-process, against models.
//
// Run with:  node --test tests/a55-approval-email-send.test.mjs
//
// NOTHING IN THIS FILE CAN REACH A REAL MAILBOX -- the owner's hardest rule,
// because real customers' real addresses are in that database. How it is kept:
//
//   - The mail provider, Google and the database are MODELS handed in through
//     the function's own dependency seam. There is no network call anywhere
//     below them: the one `fetch` the functions see is `network()`, which
//     answers only for the model Resend host, the model Google hosts, and the
//     in-process sender, and THROWS for anything else (and records it).
//   - A CANARY proves that guard bites: the real Resend endpoint is refused
//     (see "the harness refuses ..."), and a run with MAIL_API_URL unset shows
//     the function aims at Resend's real address by default -- which the model
//     refuses, so that run ends "unconfirmed" and nothing leaves the process.
//   - Every address in every fixture ends in .example.test (a reserved name
//     that cannot be registered); a final check demands that every recipient
//     the model Resend ever saw is one of them.
//   - Every secret is made up ("FAKE"); the Firebase key is generated here.
//
// What is real: index.ts, email.ts, payment-methods.ts, office-push.ts of the
// sender; every shared mail module under it (mime-build, reply, errors, limits,
// message-meta, caller's door), _shared/quote-deposit.ts and push-recipients.ts;
// and quote-view's own index.ts, unmodified apart from the one wait constant
// the pending test shortens.
//
// What is a model: supabase-js (in-memory tables, unique constraints,
// mail_ingest to supabase_mail.sql's contract including its KEY NAMES, so a
// row key the SQL would silently ignore is caught here), Resend, Google's
// OAuth and FCM.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import * as quoteDeposit from "../supabase/functions/_shared/quote-deposit.ts";
import * as jobPush from "../supabase/functions/_shared/job-push.ts";
import * as pushRecipients from "../supabase/functions/_shared/push-recipients.ts";

const SUPABASE_JS = "https://esm.sh/@supabase/supabase-js@2.39.0";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === SUPABASE_JS) {
      const src = "export const createClient = (...a) => globalThis.__a55CreateClient(...a);";
      return { url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const sender = await import("../supabase/functions/quote-approval-email/index.ts");

// ------------------------------------------------------------- made-up identities
const SECRET = "a55-FAKE-trigger-secret-0000000000000000";
const API_KEY = "re_FAKE_a55_provider_key_Zq7Lm2Xv8Rt5";
const SERVICE_KEY = "a55-FAKE-service-role-key";
const COMPANY = "55550000-0000-4000-8000-000000000001";
const OTHER_COMPANY = "55550000-0000-4000-8000-000000000002";
const JOB_ID = "55550000-0000-4000-8000-0000000000a1";
const JOB_SYNC = "55550000-0000-4000-8000-0000000000a2";
const TOKEN = "55550000-0000-4000-8000-0000000000a3";
const CUSTOMER_EMAIL = "pat.buyer@customer.example.test";
const COMPANY_EMAIL = "office@testfence.example.test";
const MAIL_HOST = "https://mail.fake.example.test/emails";
const INBOUND_DOMAIN = "reply.fake.example.test";
const INBOUND_TOKEN = "a1b2c3d4e5f60718";
const NOW = Date.parse("2026-10-02T02:00:00.000Z");
const { privateKey: FCM_KEY } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const FIREBASE = JSON.stringify({ client_email: "fake@p-test.iam.example.test", private_key: FCM_KEY, project_id: "p-test" });
const ALLOWED_DOMAIN = /\.example\.test$/;

// The table the functions write to, as the (unapplied) migration defines it: a row the CHECK constraints or the
// column list would refuse is a "could not even record that it failed" in production, so every test ends by
// holding each row the functions wrote to the migration's own text.
const MIGRATION = readFileSync(new URL("../supabase_a55_approval_emails.sql", import.meta.url), "utf8").replace(/--.*$/gm, "").replace(/\s+/g, " ");
const TABLE_DEF = /create table if not exists public\.quote_approval_emails \((.*?)\); create index/.exec(MIGRATION)?.[1] ?? "";
const COLUMNS = new Set([...TABLE_DEF.matchAll(/(?:^|,)\s*([a-z_]+) (?:uuid|text|timestamptz)\b/g)].map((m) => m[1]));
const LEDGER_STATES = new Set(["sending", "sent", "failed", "unconfirmed", "no_address", "not_priced"]);
function ledgerRowProblems(row) {
  const out = [];
  for (const k of Object.keys(row)) if (!COLUMNS.has(k)) out.push(`column ${k} is not in the table`);
  if (!LEDGER_STATES.has(row.state)) out.push(`state ${row.state}`);
  if (!/^[0-9a-f]{64}$/.test(String(row.contract_key))) out.push("contract_key");
  if (row.reason_code != null && !/^[a-z0-9_]{1,60}$/.test(row.reason_code)) out.push(`reason_code ${row.reason_code}`);
  if (row.reason != null && String(row.reason).length > 300) out.push("reason over 300");
  if (row.sent_to != null && String(row.sent_to).length > 254) out.push("sent_to over 254");
  if (row.lang != null && !["en", "es", "fr"].includes(row.lang)) out.push(`lang ${row.lang}`);
  if (!row.company_id || !/^[0-9a-f-]{36}$/.test(String(row.job_sync_id))) out.push("company_id / job_sync_id");
  return out;
}

// ------------------------------------------------------------------ the world
const INGEST_KEYS = new Set([
  "folder_role", "source", "uidvalidity", "uid", "provider_message_id", "message_id_header", "parent_ids",
  "from_address", "from_name", "to_list", "cc_list", "reply_to_list", "to_text", "counterpart_emails", "subject",
  "sent_at", "received_at", "size_bytes", "has_attachments", "is_seen", "is_answered", "is_flagged", "snippet",
  "body_state", "body_text", "body_html", "body_truncated", "attachments", "send_state", "send_error",
  "client_send_id", "sent_by", "job_sync_id", "reply_token",
]);
const UNIQUE = { quote_approval_emails: ["company_id", "job_sync_id", "contract_key"] };
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

let world;
const ENV = {};

const approvedJob = (over = {}) => ({
  id: JOB_ID, sync_id: JOB_SYNC, company_id: COMPANY, customer_name: "Pat Buyer", email: CUSTOMER_EMAIL,
  address: "1 Test Street, Testville", phone: "", status: "ACCEPTED", deleted_at: null, is_test_fixture: false,
  quote_token: TOKEN, quote_approved_at: "2026-10-01T22:00:00.000Z", quote_approved_name: "Pat Buyer",
  contract_total: 9710, accepted_total: 9710, signed_at: null, deposit_amount: 1800, amount_paid: 0, refunded_amount: 0,
  tax_rate_percent: 0, discount_percent: 0, calibration_pixels_per_foot: 20, reapproval_required_at: null,
  reapproval_reason: "", quote_viewed_at: "2026-10-01T20:00:00.000Z", quote_phone_attempts: 0, quote_phone_locked_until: null,
  assigned_employee_sync_id: null,
  ...over,
});
const unapprovedJob = (over = {}) =>
  approvedJob({ status: "SENT", quote_approved_at: null, quote_approved_name: "", accepted_total: null, ...over });

const RUNS = [
  { company_id: COMPANY, job_sync_id: JOB_SYNC, deleted_at: null, label: "Back yard", fence_type: "WOOD_PRIVACY", color_or_finish: "Cedar", points_encoded: "0:0,2800:0", gates_encoded: "a,b", closed_loop: false, panel_height_ft: 6, fabric_height_ft: 0, manual_linear_feet: 0, is_teardown: false },
  { company_id: COMPANY, job_sync_id: JOB_SYNC, deleted_at: null, label: "", fence_type: "CHAIN_LINK", color_or_finish: "", points_encoded: "", gates_encoded: "", closed_loop: false, panel_height_ft: 4, fabric_height_ft: 0, manual_linear_feet: 90, is_teardown: true },
];

function resetWorld(over = {}) {
  for (const k of Object.keys(ENV)) delete ENV[k];
  Object.assign(ENV, {
    SUPABASE_URL: "https://project.fake.example.test", SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, NOTIFY_TRIGGER_SECRET: SECRET,
    MAIL_API_KEY: API_KEY, MAIL_FROM: "noreply@send.fake.example.test", MAIL_API_URL: MAIL_HOST, SITE_URL: "https://site.fake.example.test",
    FIREBASE_SERVICE_ACCOUNT: FIREBASE,
  });
  world = {
    created: [], queries: [], rpcLog: [], events: [], resend: [], fcm: [], refused: [], logs: [],
    resendMode: "ok", failing: {}, onResend: null, unknownIngestKeys: new Set(),
    db: {
      jobs: [approvedJob()],
      companies: [
        { id: COMPANY, name: "Test Fence Co", phone: "555-0100", email: COMPANY_EMAIL, suspended: false },
        { id: OTHER_COMPANY, name: "Other Fence Co", phone: "", email: "other@other.example.test", suspended: false },
      ],
      fence_runs: clone(RUNS), change_orders: [], company_settings: [], payment_connections: [], follow_up_settings: [],
      quote_approval_emails: [], estimate_line_items: [],
      mail_accounts: [], mail_messages: [], mail_threads: [], mail_thread_jobs: [],
      mail_platform_settings: [{ id: 1, inbound_verified_at: null }],
      profiles: [
        { id: "u-owner", company_id: COMPANY, role: "OWNER", permission_overrides: "" },
        { id: "u-manager", company_id: COMPANY, role: "MANAGER", permission_overrides: "" },
        { id: "u-sales", company_id: COMPANY, role: "SALES", permission_overrides: "" },
        { id: "u-foreman", company_id: COMPANY, role: "FOREMAN", permission_overrides: "" },
        { id: "u-crew", company_id: COMPANY, role: "CREW", permission_overrides: "" },
        { id: "u-other", company_id: OTHER_COMPANY, role: "OWNER", permission_overrides: "" },
      ],
      device_tokens: [
        { token: "tok-owner", user_id: "u-owner", company_id: COMPANY }, { token: "tok-manager", user_id: "u-manager", company_id: COMPANY },
        { token: "tok-sales", user_id: "u-sales", company_id: COMPANY }, { token: "tok-foreman", user_id: "u-foreman", company_id: COMPANY },
        { token: "tok-crew", user_id: "u-crew", company_id: COMPANY }, { token: "tok-other", user_id: "u-other", company_id: OTHER_COMPANY },
      ],
    },
    ...over,
  };
}

const matches = (row, filters) => filters.every((f) => f(row));

function execute(table, st) {
  world.queries.push({ table, op: st.op, cols: st.cols, filters: st.filterText.slice() });
  const failing = world.failing[table];
  const injected = typeof failing === "function" ? failing(st) : failing === st.op || failing === "*" ? { code: "XX000", message: `planted: ${table} ${st.op} failed` } : null;
  if (injected) return { data: null, error: injected };
  const rows = world.db[table];
  if (!rows) return { data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } };

  if (st.op === "insert") {
    const row = { id: randomUUID(), attempted_at: new Date(NOW).toISOString(), settled_at: null, reason_code: null, reason: null, sent_to: null, mail_message_id: null, provider_message_id: null, lang: null, ...clone(st.payload) };
    const key = UNIQUE[table];
    if (key && rows.some((r) => key.every((k) => r[k] === row[k]))) {
      return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${table}_company_id_job_sync_id_contract_key_key"` } };
    }
    rows.push(row);
    return st.returning ? finish([row], st) : { data: null, error: null };
  }
  const hit = rows.filter((r) => matches(r, st.filters));
  if (st.op === "update") {
    for (const r of hit) Object.assign(r, clone(st.payload));
    return st.returning ? finish(hit, st) : { data: null, error: null };
  }
  return finish(hit, st);
}

function finish(hit, st) {
  const alias = /^(\w+):settings->(\w+)$/.exec(String(st.cols).trim());
  const cols = String(st.cols).split(",").map((c) => c.trim()).filter(Boolean);
  const out = hit.map((r) => {
    if (alias) return { [alias[1]]: clone(r.settings?.[alias[2]]) };
    if (!cols.length || cols.includes("*")) return clone(r);
    return Object.fromEntries(cols.map((c) => [c, clone(r[c]) ?? null]));
  });
  if (st.mode === "maybe") return { data: out[0] ?? null, error: null };
  return { data: out, error: null };
}

class Query {
  constructor(table) {
    this.st = { table, op: "select", cols: "*", filters: [], filterText: [], payload: null, returning: false, mode: null };
  }
  select(cols = "*") { if (this.st.op !== "select") this.st.returning = true; this.st.cols = cols; return this; }
  insert(row) { this.st.op = "insert"; this.st.payload = row; return this; }
  update(row) { this.st.op = "update"; this.st.payload = row; return this; }
  eq(k, v) { this.st.filters.push((r) => String(r[k]) === String(v)); this.st.filterText.push(`eq:${k}`); return this; }
  is(k, v) { this.st.filters.push((r) => (v === null ? r[k] == null : r[k] === v)); this.st.filterText.push(`is:${k}`); return this; }
  in(k, vs) { this.st.filters.push((r) => vs.map(String).includes(String(r[k]))); this.st.filterText.push(`in:${k}`); return this; }
  not(k, op, v) { if (op === "is" && v === null) this.st.filters.push((r) => r[k] != null); this.st.filterText.push(`not:${k}`); return this; }
  order() { return this; }
  limit() { return this; }
  maybeSingle() { this.st.mode = "maybe"; return this.run(); }
  run() { return Promise.resolve().then(() => execute(this.st.table, this.st)); }
  then(ok, bad) { return this.run().then(ok, bad); }
}

const WINDOWS = { "1 hour": 3_600_000, "1 day": 86_400_000 };
const countEvents = (company, kind, window) => world.events.filter((e) => e.company === company && e.kind === kind && e.at > NOW - WINDOWS[window]).length;

function ingest(args) {
  const acct = world.db.mail_accounts.find((a) => a.id === args.p_account);
  if (!acct) return { data: null, error: { code: "P0002", message: "Unknown mail account" } };
  const out = [];
  for (const r of args.p_rows) {
    for (const k of Object.keys(r)) if (!INGEST_KEYS.has(k)) world.unknownIngestKeys.add(k);
    if (r.source === "fenceflow_send" && (!r.client_send_id || r.folder_role !== "sent")) {
      return { data: null, error: { code: "22023", message: "A FenceFlow send needs client_send_id" } };
    }
    const dup = world.db.mail_messages.find((m) => m.company_id === acct.company_id && r.client_send_id && m.client_send_id === r.client_send_id);
    if (dup) { out.push({ message_id: dup.id, thread_id: dup.thread_id, inserted: false }); continue; }
    const thread = { id: randomUUID(), company_id: acct.company_id, reply_token: randomBytes(6).toString("hex"), subject: r.subject ?? "" };
    world.db.mail_threads.push(thread);
    const { reply_token: _t, ...cols } = r;
    const row = { ...clone(cols), id: randomUUID(), company_id: acct.company_id, account_id: acct.id, thread_id: thread.id };
    world.db.mail_messages.push(row);
    if (r.job_sync_id && world.db.jobs.some((j) => j.company_id === acct.company_id && j.sync_id === r.job_sync_id && !j.deleted_at)) {
      world.db.mail_thread_jobs.push({ thread_id: thread.id, company_id: acct.company_id, job_sync_id: r.job_sync_id });
    }
    out.push({ message_id: row.id, thread_id: thread.id, inserted: true });
  }
  return { data: out, error: null };
}

function rpc(key, name, args = {}) {
  world.rpcLog.push({ name, key, args: clone(args) });
  if (key !== SERVICE_KEY && !["company_allowed", "quote_phone_try", "quote_phone_clear"].includes(name)) {
    return { data: null, error: { code: "42501", message: "Service role only" } };
  }
  switch (name) {
    case "note_mail_event":
      world.events.push({ company: args.p_company, actor: args.p_actor, kind: args.p_kind, at: NOW });
      return { data: world.noteAnswer ?? countEvents(args.p_company, args.p_kind, args.p_window), error: null };
    case "mail_event_count":
      return { data: world.dayAnswer ?? countEvents(args.p_company, args.p_kind, args.p_window), error: null };
    case "mail_ingest":
      if (world.failing.mail_ingest) return { data: null, error: { code: "XX000", message: "planted" } };
      return ingest(args);
    case "mail_fenceflow_account": {
      let row = world.db.mail_accounts.find((r) => r.company_id === args.p_company && r.kind === "fenceflow");
      if (!row) {
        row = { id: randomUUID(), company_id: args.p_company, kind: "fenceflow", provider: "resend", email_address: args.p_email, inbound_token: INBOUND_TOKEN, status: "connected" };
        world.db.mail_accounts.push(row);
      }
      return { data: row.id, error: null };
    }
    case "company_allowed": return { data: true, error: null };
    case "quote_phone_try": return { data: "OK", error: null };
    case "quote_phone_clear": return { data: null, error: null };
    default: return { data: null, error: { code: "PGRST202", message: `no function ${name}` } };
  }
}

globalThis.__a55CreateClient = (url, key) => {
  world.created.push({ url, key });
  return { rpc: async (name, args) => rpc(key, name, args), from: (table) => new Query(table) };
};

// ------------------------------------------------- the network: models, and a wall
async function network(url, init = {}) {
  const u = String(url);
  if (u === MAIL_HOST) {
    const body = JSON.parse(String(init.body));
    const call = { url: u, headers: Object.fromEntries(Object.entries(init.headers ?? {})), body };
    world.resend.push(call);
    if (world.onResend) await world.onResend(call);
    switch (world.resendMode) {
      case "ok": return new Response(JSON.stringify({ id: `prov_${world.resend.length}` }), { status: 200 });
      case "throw": throw Object.assign(new Error("socket hang up"), { name: "TypeError" });
      case "timeout": throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      default: return new Response(JSON.stringify({ message: `planted ${world.resendMode}` }), { status: Number(world.resendMode) });
    }
  }
  if (u === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "fake-fcm-bearer" }), { status: 200 });
  if (u === "https://fcm.googleapis.com/v1/projects/p-test/messages:send") {
    const m = JSON.parse(String(init.body)).message;
    world.fcm.push({ token: m.token, title: m.notification.title, body: m.notification.body });
    return new Response("{}", { status: 200 });
  }
  if (u.endsWith("/functions/v1/quote-approval-email")) return await world.senderRoute(u, init);
  world.refused.push(u);
  throw new Error(`REFUSED by the a55 harness: a test tried to reach ${u}`);
}

const deps = (over = {}) => ({
  fetch: (url, init) => network(url, init),
  env: (name) => ENV[name],
  now: () => NOW,
  uuid: () => randomUUID(),
  background: (work) => work,
  ...over,
});

async function send(body = { job_id: JOB_ID }, { secret = SECRET, method = "POST", headers = {}, d = deps() } = {}) {
  const res = await sender.handleRequest(new Request("https://fn.test/functions/v1/quote-approval-email", {
    method,
    headers: { "content-type": "application/json", ...(secret === null ? {} : { "x-fenceflow-trigger": secret }), ...headers },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  }), d);
  return { status: res.status, body: await res.json() };
}

const consoleErrors = [];
const realError = console.error;
console.error = (...a) => { consoleErrors.push(a.map(String).join(" ")); };
test.after(() => { console.error = realError; });

/** Every test ends here: nothing reached outside the models, and every recipient is a reserved example name. */
function wall() {
  assert.deepEqual(world.refused, [], "the harness refused a request that would have left the process");
  for (const c of world.resend) {
    for (const r of [...(c.body.to ?? []), ...(c.body.cc ?? []), ...(c.body.bcc ?? [])]) {
      assert.match(r, ALLOWED_DOMAIN, `a recipient outside the reserved test names: ${r}`);
    }
  }
  assert.deepEqual([...world.unknownIngestKeys], [], "a mail_ingest row key the SQL would silently ignore");
  assert.ok(COLUMNS.size >= 12 && COLUMNS.has("contract_key"), "the migration's column list was not read");
  for (const row of world.db.quote_approval_emails ?? []) assert.deepEqual(ledgerRowProblems(row), [], `a ledger row the migration would refuse: ${JSON.stringify(row)}`);
  assert.ok(world.created.every((c) => c.key === SERVICE_KEY), "a client other than the model service client was created");
}

const ledger = () => world.db.quote_approval_emails;
const sentTo = (c) => c.body.to;
const text = (c) => c.body.text;
/** The failure notices this feature sends (quote-view's own "Quote approved" push is a different message, asserted separately). */
const notices = () => world.fcm.filter((m) => /^Contract email/.test(m.title));
const tokensTold = () => notices().map((m) => m.token).sort();
/** Waits for something that happens after an answer has gone out. */
async function until(check, what, ms = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ============================================================ 0. the wall itself =====

test("the harness refuses the real Resend endpoint and any other host -- the guard every other test leans on has teeth", async () => {
  resetWorld();
  for (const url of ["https://api.resend.com/emails", "https://example.com/", "http://localhost:9/"]) {
    await assert.rejects(() => network(url, { method: "POST", body: "{}" }), /REFUSED by the a55 harness/, url);
  }
  assert.deepEqual(world.refused, ["https://api.resend.com/emails", "https://example.com/", "http://localhost:9/"]);
  world.refused.length = 0; // expected here; the point was to prove it throws
  wall();
});

test("PLANTED: the check every test ends with refuses a ledger row the migration would refuse, and accepts a real one", async () => {
  resetWorld();
  await send();
  const good = ledger()[0];
  assert.deepEqual(ledgerRowProblems(good), [], "a row the function really wrote passes");
  for (const [name, bad] of Object.entries({
    "an unknown column": { ...good, approval_email_sent_at: "x" }, "an unknown state": { ...good, state: "queued" },
    "a short key": { ...good, contract_key: "abc" }, "a long reason": { ...good, reason: "x".repeat(301) },
    "a bad code": { ...good, reason_code: "Not A Slug" }, "a bad language": { ...good, lang: "de" }, "no company": { ...good, company_id: null },
  })) assert.ok(ledgerRowProblems(bad).length > 0, `not caught: ${name}`);
  wall();
});

test("with no MAIL_API_URL set the function aims at Resend's real endpoint -- and the harness stops it, so the send ends unconfirmed", async () => {
  resetWorld();
  delete ENV.MAIL_API_URL;
  const r = await send();
  assert.equal(r.body.state, "unconfirmed", JSON.stringify(r.body));
  assert.deepEqual(world.refused, ["https://api.resend.com/emails"], "the default target is Resend's real address");
  assert.equal(world.resend.length, 0, "nothing was delivered to the model provider either");
  world.refused.length = 0; // expected: this test exists to show the default URL and that the wall holds
  wall();
});

// ============================================================ 1. the door =====

test("the door: no secret set, no header, a wrong header, a near-miss, the wrong method -- every one refused before anything is read", async () => {
  resetWorld();
  const before = () => world.queries.length + world.created.length;
  // Control: the right secret gets through (and sends).
  assert.equal((await send()).status, 200);
  assert.equal(world.resend.length, 1);
  resetWorld();
  delete ENV.NOTIFY_TRIGGER_SECRET;
  assert.equal((await send()).status, 503, "an unset secret opens nothing");
  assert.equal((await send(undefined, { secret: "" })).status, 503, "an empty header against an unset secret");
  resetWorld();
  for (const [secret, status] of [[null, 401], ["", 401], ["wrong", 401], [SECRET.slice(0, -1), 401], [SECRET + "x", 401], [SECRET.toUpperCase(), 401]]) {
    const r = await send(undefined, { secret });
    assert.equal(r.status, status, JSON.stringify(secret));
  }
  assert.equal(before(), 0, "no client, no query: the body was never read");
  assert.equal((await send(undefined, { method: "GET" })).status, 405);
  assert.equal(world.resend.length, 0);
  wall();
});

test("a bad body is refused: not JSON, not an object, no job, a job that is not a uuid, an oversize body", async () => {
  resetWorld();
  for (const body of ["not json", "[]", "{}", JSON.stringify({ job_id: "nope" }), JSON.stringify({ job_id: JOB_ID + "x" }), JSON.stringify({ job_id: JOB_ID, pad: "x".repeat(5000) })]) {
    assert.equal((await send(body)).status, 400, body.slice(0, 40));
  }
  assert.equal((await send({ job_id: "55550000-0000-4000-8000-0000000000ff" })).status, 404, "a uuid that is no job");
  assert.equal(world.resend.length, 0);
  wall();
});

// ====================================================== 2. the happy path =====

test("an approved job is emailed once: one message, to the customer, from the company's name, replies to the company, with the contract in it", async () => {
  resetWorld();
  world.db.company_settings.push({ company_id: COMPANY, settings: { payment_methods: { cash_app: { on: true, tag: "TestOnlyTag" }, zelle: { on: true, to: "zelle@example.test" }, wire: { on: true, details: "Bank: TEST ONLY BANK" }, cash: { on: true } } } });
  world.db.payment_connections.push({ company_id: COMPANY, processor: "stripe", external_id: "acct_fake", access_token: null });
  const r = await send({ job_id: JOB_ID, lang: "en" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { state: "sent", to: "p***@customer.example.test" }, "the answer carries the address masked, never whole");
  assert.equal(world.resend.length, 1);
  const c = world.resend[0];
  assert.deepEqual(sentTo(c), [CUSTOMER_EMAIL]);
  assert.equal(c.body.from, '"Test Fence Co" <noreply@send.fake.example.test>', "the company's name on FenceFlow's verified address");
  assert.equal(c.body.reply_to, COMPANY_EMAIL, "replies go to the company, not to FenceFlow's own mailbox");
  assert.equal(c.body.subject, "Your approved fence quote from Test Fence Co");
  const t = text(c);
  for (const must of ["$9,710.00", "Deposit required to start: $1,800.00", "Pat Buyer", "1 Test Street, Testville", "about 140 ft", "$TestOnly", "zelle@example.test", "TEST ONLY BANK",
    "Cash is accepted", `https://site.fake.example.test/quote.html?t=${TOKEN}`, "pay the deposit by card", "Sent by Test Fence Co using FenceFlow"]) {
    assert.ok(t.includes(must), `the email is missing: ${must}`);
  }
  assert.ok(c.body.html.includes("Deposit required to start") && c.body.html.startsWith("<!doctype html>"), "the HTML twin is made from the text");
  assert.equal(c.headers.Authorization, `Bearer ${API_KEY}`);
  assert.match(c.headers["Idempotency-Key"], /^fenceflow-mail-[0-9a-f-]{36}$/);
  assert.match(c.body.headers["Message-ID"], /^<[0-9a-f-]{36}@send\.fake\.example\.test>$/);

  // The record: the claim row, settled; the Sent-view copy, linked to the job.
  assert.equal(ledger().length, 1);
  const row = ledger()[0];
  assert.deepEqual([row.state, row.sent_to, row.lang, row.company_id, row.job_sync_id], ["sent", CUSTOMER_EMAIL, "en", COMPANY, JOB_SYNC]);
  assert.match(row.contract_key, /^[0-9a-f]{64}$/);
  assert.ok(row.settled_at && row.provider_message_id === "prov_1" && row.mail_message_id);
  const m = world.db.mail_messages[0];
  assert.deepEqual([m.send_state, m.send_error, m.job_sync_id, m.client_send_id, m.source, m.folder_role], ["sent", null, JOB_SYNC, row.id, "fenceflow_send", "sent"]);
  assert.equal(m.id, row.mail_message_id);
  assert.equal(m.sent_by, undefined, "sent by the system, not by a person");
  assert.equal(world.db.mail_thread_jobs.length, 1, "the thread is linked to the job, so it shows on the job's mail panel");
  // The rate ledger counted it, as a FenceFlow-mail send.
  assert.deepEqual(world.events.map((e) => [e.company, e.kind, e.actor]), [[COMPANY, "send_resend", null]]);
  // A success pushes nobody: the office is told about failures, not about every success.
  assert.deepEqual(world.fcm, []);
  wall();
});

test("the email goes out in the customer's language: the page's choice, else the browser's, else English", async () => {
  for (const [body, expected] of [
    [{ lang: "es" }, "Su presupuesto de cerca aprobado con Test Fence Co"],
    [{ lang: "fr" }, "Votre devis de clôture validé avec Test Fence Co"],
    [{ accept_language: "fr-CA,fr;q=0.9,en;q=0.5" }, "Votre devis de clôture validé avec Test Fence Co"],
    [{ lang: "en", accept_language: "es" }, "Your approved fence quote from Test Fence Co"],
    [{}, "Your approved fence quote from Test Fence Co"],
    [{ lang: "zz", accept_language: "de" }, "Your approved fence quote from Test Fence Co"],
  ]) {
    resetWorld();
    const r = await send({ job_id: JOB_ID, ...body });
    assert.equal(r.body.state, "sent", JSON.stringify(body));
    assert.equal(world.resend[0].body.subject, expected, JSON.stringify(body));
    wall();
  }
});

test("the deposit in the email is the STORED deposit, capped at the job: one figure, never reworked", async () => {
  resetWorld();
  world.db.jobs[0] = approvedJob({ deposit_amount: 1800, accepted_total: 9710, contract_total: 12000 });
  await send();
  const t = text(world.resend[0]);
  assert.ok(t.includes("Total price: $9,710.00"), "the ACCEPTED price, not the live contract_total that moved since");
  assert.ok(t.includes("Deposit required to start: $1,800.00"));
  const figures = [...t.matchAll(/\$(\d{1,3}(?:,\d{3})*(?:\.\d\d)?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
  assert.deepEqual([...new Set(figures)].sort((a, b) => a - b), [1800, 9710]);
  // Over the job: capped, exactly as the page and the payment link cap it.
  resetWorld();
  world.db.jobs[0] = approvedJob({ deposit_amount: 20000 });
  await send();
  assert.ok(text(world.resend[0]).includes("Deposit required to start: $9,710.00"));
  // Part already paid: said once, in one sentence.
  resetWorld();
  world.db.jobs[0] = approvedJob({ amount_paid: 500 });
  await send();
  assert.ok(text(world.resend[0]).includes("$500.00 of the deposit has already been received; $1,300.00 is still due."));
  wall();
});

test("extra work signed since the approval moves the total the email states, the same way it moves the page", async () => {
  resetWorld();
  world.db.change_orders.push({ company_id: COMPANY, job_sync_id: JOB_SYNC, additional_cost: 455, signed_at: "2026-10-02T00:00:00.000Z", deleted_at: null, in_accepted_total: false });
  await send();
  assert.ok(text(world.resend[0]).includes("Total price: $10,165.00"));
  wall();
});

test("a database without accepted_total yet is read the old way: the email still goes, from contract_total", async () => {
  resetWorld();
  world.failing.jobs = (st) => (String(st.cols).includes("accepted_total") ? { code: "42703", message: "column jobs.accepted_total does not exist" } : null);
  const { accepted_total: _a, ...legacy } = approvedJob({ contract_total: 8000 });
  world.db.jobs[0] = legacy;
  const r = await send();
  assert.equal(r.body.state, "sent", JSON.stringify(r.body));
  assert.ok(text(world.resend[0]).includes("Total price: $8,000.00"));
  wall();
});

// ============================================================ 3. once, not every time =====

test("ONCE: calling again for the same approved contract sends nothing and answers with what happened the first time", async () => {
  resetWorld();
  assert.equal((await send()).body.state, "sent");
  for (let i = 0; i < 4; i++) {
    const again = await send();
    assert.deepEqual(again.body, { state: "sent", duplicate: true });
  }
  assert.equal(world.resend.length, 1, "one message, however many times it is asked");
  assert.equal(ledger().length, 1);
  assert.equal(world.events.length, 1, "and only one send is charged to the rate ledger");
  wall();
});

test("ONCE under a race: five calls at the same instant send exactly one email", async () => {
  resetWorld();
  const gate = Promise.withResolvers();
  world.onResend = () => gate.promise; // hold the first send open while the others arrive
  const calls = Array.from({ length: 5 }, () => send());
  await new Promise((r) => setTimeout(r, 30));
  gate.resolve();
  const answers = await Promise.all(calls);
  assert.equal(world.resend.length, 1, `${world.resend.length} messages went out`);
  assert.equal(answers.filter((a) => a.body.state === "sent" && !a.body.duplicate).length, 1);
  assert.equal(answers.filter((a) => a.body.duplicate === true).length, 4);
  assert.ok(answers.filter((a) => a.body.duplicate).every((a) => ["sending", "sent"].includes(a.body.state)), "a call that lost the race says the send is in hand, never that it failed");
  assert.equal(ledger().length, 1);
  assert.equal(world.db.mail_messages.length, 1);
  wall();
});

test("approving again after a withdrawal at the same price sends nothing: the key is what the email states, not when or by whom", async () => {
  resetWorld();
  await send();
  // The approval is cleared and given again later, by a different typed name.
  world.db.jobs[0] = approvedJob({ quote_approved_at: "2026-10-09T10:00:00.000Z", quote_approved_name: "Pat B. Buyer" });
  const again = await send({ job_id: JOB_ID, lang: "es" });
  assert.deepEqual(again.body, { state: "sent", duplicate: true });
  assert.equal(world.resend.length, 1);
  wall();
});

test("a CHANGED contract is a new contract: approving at a new price, a new scope or a new deposit sends the new copy, once", async () => {
  resetWorld();
  await send();
  const first = world.resend.length;
  world.db.jobs[0] = approvedJob({ quote_approved_at: "2026-10-09T10:00:00.000Z", accepted_total: 10450, contract_total: 10450 });
  const r = await send();
  assert.equal(r.body.state, "sent");
  assert.equal(world.resend.length, first + 1);
  assert.ok(text(world.resend[1]).includes("Total price: $10,450.00"), "the new price, not the old one");
  assert.equal((await send()).body.duplicate, true, "and that one is once too");
  // A drawing change at the SAME price is also a new contract: the scope the email states moved.
  world.db.fence_runs[0].points_encoded = "0:0,3200:0";
  assert.equal((await send()).body.state, "sent");
  assert.ok(text(world.resend[2]).includes("about 160 ft"));
  assert.equal(world.resend.length, 3);
  assert.equal(ledger().length, 3);
  wall();
});

test("a claimed row is never sent again, whatever state it ended in -- 'maybe sent' beats 'sent twice'", async () => {
  for (const mode of ["500", "throw", "422", "429", "401"]) {
    resetWorld();
    world.resendMode = mode;
    const first = await send();
    assert.notEqual(first.body.state, "sent", mode);
    world.resendMode = "ok";
    const again = await send();
    assert.equal(again.body.duplicate, true, `${mode}: a second call must not try again`);
    assert.equal(world.resend.length, 1, `${mode}: the provider was called once`);
    wall();
  }
});

// ========================================= 4. nothing silent: no address, bad address =====

test("NO ADDRESS on the job: nothing is sent, the row says so, and the office's SEE_MONEY phones are pushed -- never silence", async () => {
  for (const blank of ["", "   ", null, undefined]) {
    resetWorld();
    world.db.jobs[0] = approvedJob({ email: blank });
    const r = await send();
    assert.deepEqual(r.body, { state: "no_address", reason_code: "no_address" }, JSON.stringify(blank));
    assert.equal(world.resend.length, 0);
    const row = ledger()[0];
    assert.deepEqual([row.state, row.reason_code, row.sent_to], ["no_address", "no_address", null]);
    assert.match(row.reason, /no email address on this job/i);
    assert.ok(row.settled_at);
    // Pushed: the owner, the manager and sales hold SEE_MONEY; the foreman, the crew and another company's owner do not.
    assert.deepEqual(tokensTold(), ["tok-manager", "tok-owner", "tok-sales"]);
    assert.ok(world.fcm.every((m) => m.title === "Contract email NOT sent"));
    assert.match(world.fcm[0].body, /^Pat Buyer approved the quote, but the contract email was not sent: there is no email address on the job\./);
    assert.match(world.fcm[0].body, /Send it yourself, or ask them to download a copy/);
    // The push carries no amount and no address.
    for (const m of world.fcm) assert.ok(!/\$|\d|@/.test(`${m.title} ${m.body}`), `${m.title} / ${m.body}`);
    wall();
  }
});

test("a MALFORMED address is not repaired and not sent: two addresses, a space, a bracket, a header injection, no domain", async () => {
  for (const bad of ["a@b.example.test, c@d.example.test", "a@b.example.test; c@d.example.test", "pat buyer@customer.example.test", "<pat@customer.example.test>",
    "pat@customer.example.test\r\nBcc: victim@other.example.test", "pat@", "@customer.example.test", "pat", "pat@localhost", "pat@@customer.example.test", "\"pat\"@customer.example.test"]) {
    resetWorld();
    world.db.jobs[0] = approvedJob({ email: bad });
    const r = await send();
    assert.deepEqual(r.body, { state: "no_address", reason_code: "bad_address" }, JSON.stringify(bad));
    assert.equal(world.resend.length, 0, `something was sent to ${JSON.stringify(bad)}`);
    assert.equal(ledger()[0].reason_code, "bad_address");
    assert.equal(world.fcm.length, 3, `the office was not told about ${JSON.stringify(bad)}`);
    wall();
  }
  // CONTROL: a plain address, and one with a plus tag and upper-case domain, go through as the SAME fixture.
  for (const good of [CUSTOMER_EMAIL, "pat+fence@Customer.Example.Test", "  pat@customer.example.test  "]) {
    resetWorld();
    world.db.jobs[0] = approvedJob({ email: good });
    assert.equal((await send()).body.state, "sent", good);
    assert.match(world.resend[0].body.to[0], /^pat[.a-z]*(\+fence)?@customer\.example\.test$/);
    wall();
  }
});

test("a quote with no price is not emailed as a contract: not_priced, recorded, pushed", async () => {
  resetWorld();
  world.db.jobs[0] = approvedJob({ accepted_total: null, contract_total: 0 });
  const r = await send();
  assert.deepEqual(r.body, { state: "not_priced", reason_code: "not_priced" });
  assert.equal(world.resend.length, 0);
  assert.equal(world.fcm.length, 3);
  assert.equal(ledger()[0].state, "not_priced");
  wall();
});

// ======================================= 5. nothing silent: every other way it can fail =====

test("FAILURES are recorded and pushed, and say what is true: not configured, no reply address, rate limit, refusal, unconfirmed", async () => {
  const cases = [
    ["mail not configured (no key)", () => { delete ENV.MAIL_API_KEY; }, "failed", "not_configured", /not set up on the server/, 0],
    ["mail not configured (no sender address)", () => { delete ENV.MAIL_FROM; }, "failed", "not_configured", /not set up/, 0],
    ["a sender address that is not an address", () => { ENV.MAIL_FROM = "not an address"; }, "failed", "not_configured", /not set up/, 0],
    ["no business email and no inbound routing: replies would reach FenceFlow itself", () => { world.db.companies[0].email = ""; }, "failed", "no_reply_address", /no business email/i, 0],
    ["a business email that is not an address", () => { world.db.companies[0].email = "nope"; }, "failed", "no_reply_address", /no business email/i, 0],
    ["the hourly rate limit", () => { world.noteAnswer = 21; }, "failed", "rate_limited", /sending limit/, 0],
    ["the daily rate limit", () => { world.dayAnswer = 101; }, "failed", "rate_limited", /sending limit/, 0],
    ["the rate ledger answering with something that is not a number", () => { world.noteAnswer = "lots"; }, "failed", "server_error", /FenceFlow's side/, 0],
    ["the provider refusing the message (422)", () => { world.resendMode = "422"; }, "failed", "send_rejected", /refused/, 1],
    ["the provider refusing our key (401)", () => { world.resendMode = "401"; }, "failed", "not_configured", /not set up/, 1],
    ["the provider's rate limit (429)", () => { world.resendMode = "429"; }, "failed", "rate_limited", /sending limit/, 1],
    ["the provider answering 500: it may have gone out", () => { world.resendMode = "500"; }, "unconfirmed", "unconfirmed", /could not confirm/, 1],
    ["the provider answering 409 (the idempotency key was seen)", () => { world.resendMode = "409"; }, "unconfirmed", "unconfirmed", /could not confirm/, 1],
    ["no answer at all", () => { world.resendMode = "throw"; }, "unconfirmed", "unconfirmed", /could not confirm/, 1],
    ["a timeout", () => { world.resendMode = "timeout"; }, "unconfirmed", "unconfirmed", /could not confirm/, 1],
  ];
  for (const [name, plant, state, code, wording, providerCalls] of cases) {
    resetWorld();
    plant();
    const r = await send();
    assert.equal(r.status, 200, name);
    assert.equal(r.body.state, state, `${name}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.reason_code, code, name);
    assert.equal(world.resend.length, providerCalls, `${name}: provider calls`);
    const row = ledger()[0];
    assert.deepEqual([row.state, row.reason_code], [state, code], name);
    assert.match(row.reason, wording, name);
    assert.ok(row.reason.length <= 300);
    assert.ok(row.settled_at, `${name}: settled`);
    // Told: the three SEE_MONEY phones, with words that match the truth.
    assert.deepEqual(tokensTold(), ["tok-manager", "tok-owner", "tok-sales"], name);
    const title = world.fcm[0].title;
    assert.equal(title, state === "unconfirmed" ? "Contract email: could not confirm" : "Contract email NOT sent", name);
    for (const m of world.fcm) assert.ok(!/\$|\d|@/.test(`${m.title} ${m.body}`), `${name}: a figure or address in the push`);
    // A refused or failed provider call leaves the Sent copy FAILED; an unknown one leaves it 'sending' with the standing note.
    if (providerCalls) {
      const m = world.db.mail_messages[0];
      if (state === "unconfirmed") assert.deepEqual([m.send_state, m.send_error], ["sending", sender.UNCONFIRMED_NOTE], name);
      else assert.equal(m.send_state, "failed", name);
    }
    wall();
  }
});

test("nothing a mail provider SAYS is copied into the row, the push or the answer", async () => {
  resetWorld();
  world.onResend = () => { world.resendMode = "422"; };
  const real = network;
  // Make the provider's refusal carry an address, a key and a sentence.
  const poisoned = async (url, init) => {
    if (url === MAIL_HOST) {
      world.resend.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return new Response(JSON.stringify({ message: `Recipient pat@customer.example.test rejected; key ${API_KEY}; sk_live_SECRET_VALUE` }), { status: 422 });
    }
    return real(url, init);
  };
  const r = await send(undefined, { d: deps({ fetch: poisoned }) });
  const everything = JSON.stringify([r.body, ledger(), world.fcm, world.db.mail_messages.map((m) => [m.send_error, m.send_state])]);
  for (const leak of [API_KEY, "sk_live_SECRET_VALUE", "rejected;"]) assert.ok(!everything.includes(leak), `${leak} leaked`);
  assert.ok(!consoleErrors.join("\n").includes(API_KEY), "the key reached the log");
  assert.equal(r.body.reason_code, "send_rejected");
  wall();
});

test("secrets the function can read to decide something never leave it: the card processor's token, the provider key, the trigger secret, the service key", async () => {
  resetWorld();
  world.db.payment_connections.push({ company_id: COMPANY, processor: "square", external_id: "loc_fake", access_token: "SQUARE_ACCESS_TOKEN_DO_NOT_LEAK" });
  const r = await send();
  assert.equal(r.body.state, "sent");
  assert.ok(text(world.resend[0]).includes("pay the deposit by card"), "CONTROL: the token's only effect is that a card checkout exists");
  const everything = JSON.stringify([r.body, ledger(), world.fcm, world.db.mail_messages, world.resend.map((c) => c.body), consoleErrors]);
  for (const secret of ["SQUARE_ACCESS_TOKEN_DO_NOT_LEAK", SECRET, SERVICE_KEY, FCM_KEY.slice(40, 80)]) assert.ok(!everything.includes(secret), `${secret.slice(0, 12)}... leaked`);
  // The provider key travels only in the Authorization header of the one call to the provider.
  assert.ok(!JSON.stringify(world.resend[0].body).includes(API_KEY));
  wall();
});

test("if the send record cannot be written, NOTHING is sent (sent-twice would have no guard) and the office is told the feature is not set up", async () => {
  for (const planted of ["insert", (st) => (st.op === "insert" ? { code: "42P01", message: 'relation "public.quote_approval_emails" does not exist' } : null)]) {
    resetWorld();
    world.failing.quote_approval_emails = planted;
    const r = await send();
    assert.deepEqual(r.body, { state: "failed", reason_code: "ledger_unavailable" });
    assert.equal(world.resend.length, 0, "an email went out with no record of it");
    assert.equal(world.db.mail_messages.length, 0);
    assert.deepEqual(tokensTold(), ["tok-manager", "tok-owner", "tok-sales"]);
    assert.match(world.fcm[0].body, /not set up on the server yet/);
    wall();
  }
  // The table not being there at all (the migration unapplied) is the same.
  resetWorld();
  delete world.db.quote_approval_emails;
  assert.equal((await send()).body.reason_code, "ledger_unavailable");
  assert.equal(world.resend.length, 0);
  wall();
});

test("a read that fails is a failure, never an empty answer: the email is not sent half-built, and the office is told", async () => {
  for (const table of ["companies", "fence_runs", "company_settings", "payment_connections"]) {
    resetWorld();
    world.failing[table] = "select";
    const r = await send();
    assert.equal(r.body.state, "failed", `${table}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.reason_code, "could_not_read", table);
    assert.equal(world.resend.length, 0, `${table}: an email went out built from a failed read`);
    assert.equal(ledger()[0].state, "failed");
    assert.equal(world.fcm.length, 3, `${table}: the office was not told`);
    wall();
  }
  // The one read that may fail quietly is the company's time zone: the date is written in the default zone, the email still goes.
  resetWorld();
  world.failing.follow_up_settings = "select";
  assert.equal((await send()).body.state, "sent");
  wall();
});

test("the office push reaches ONLY the people who hold SEE_MONEY, in this company, and a failure to read who they are tells nobody", async () => {
  resetWorld();
  world.db.jobs[0] = approvedJob({ email: "" });
  world.db.profiles.push({ id: "u-acct", company_id: COMPANY, role: "ACCOUNTANT", permission_overrides: "" });
  world.db.profiles.find((p) => p.id === "u-crew").permission_overrides = "+SEE_MONEY"; // a crew member granted money by hand
  world.db.profiles.find((p) => p.id === "u-manager").permission_overrides = "-SEE_MONEY"; // a manager with it taken away
  world.db.device_tokens.push({ token: "tok-acct", user_id: "u-acct", company_id: COMPANY }, { token: "tok-owner-elsewhere", user_id: "u-owner", company_id: OTHER_COMPANY });
  await send();
  assert.deepEqual(tokensTold(), ["tok-acct", "tok-crew", "tok-owner", "tok-sales"], "per-person overrides decide, in both directions; a phone last registered under another company is not told");
  resetWorld();
  world.db.jobs[0] = approvedJob({ email: "" });
  world.failing.profiles = "select";
  const r = await send();
  assert.equal(r.body.state, "no_address");
  assert.deepEqual(world.fcm, [], "profiles unreadable: the audience shrinks to nobody, never to everybody");
  assert.ok(consoleErrors.some((l) => /nobody was pushed/.test(l)), "and the log says nobody was told");
  wall();
});

// ============================================================ 6. where replies go =====

test("replies: once receiving is proven the Reply-To is this thread's own FenceFlow address; until then it is the company's email", async () => {
  resetWorld();
  Object.assign(ENV, { MAIL_INBOUND_DOMAIN: INBOUND_DOMAIN, RESEND_WEBHOOK_SECRET: "whsec_FAKE", RESEND_RECEIVING_KEY: "re_FAKE_recv" });
  world.db.mail_platform_settings[0].inbound_verified_at = "2026-09-22T16:03:35Z";
  assert.equal((await send()).body.state, "sent");
  const thread = world.db.mail_threads[0];
  assert.equal(world.resend[0].body.reply_to, `${INBOUND_TOKEN}.${thread.reply_token}@${INBOUND_DOMAIN}`, "the thread the claim made, completed after the claim");
  assert.deepEqual(world.db.mail_messages[0].reply_to_list, [{ name: "", address: `${INBOUND_TOKEN}.${thread.reply_token}@${INBOUND_DOMAIN}` }], "and the Sent copy says the same");
  wall();
  // Configured but NOT proven: the company's own email.
  resetWorld();
  Object.assign(ENV, { MAIL_INBOUND_DOMAIN: INBOUND_DOMAIN, RESEND_WEBHOOK_SECRET: "whsec_FAKE", RESEND_RECEIVING_KEY: "re_FAKE_recv" });
  assert.equal((await send()).body.state, "sent");
  assert.equal(world.resend[0].body.reply_to, COMPANY_EMAIL);
  wall();
  // Proven but a secret missing: also the company's own email (all three must be present).
  resetWorld();
  Object.assign(ENV, { MAIL_INBOUND_DOMAIN: INBOUND_DOMAIN, RESEND_WEBHOOK_SECRET: "whsec_FAKE" });
  world.db.mail_platform_settings[0].inbound_verified_at = "2026-09-22T16:03:35Z";
  assert.equal((await send()).body.state, "sent");
  assert.equal(world.resend[0].body.reply_to, COMPANY_EMAIL);
  wall();
});

// ===================================================== 7. who is never emailed =====

test("never for a test fixture, a test company, a deleted job, a suspended company, or an approval that has not happened -- each paired with a control from the same fixture", async () => {
  const cases = [
    ["a test fixture job", () => { world.db.jobs[0] = approvedJob({ is_test_fixture: true }); }, 200, "test fixture"],
    ["a company named ZZ TEST", () => { world.db.companies[0].name = "ZZ TEST Fence Co"; }, 200, "test company"],
    ["a company named ' zz test ...' (case and leading space)", () => { world.db.companies[0].name = "  zz test fence"; }, 200, "test company"],
    ["a deleted job", () => { world.db.jobs[0] = approvedJob({ deleted_at: "2026-10-01T00:00:00Z" }); }, 200, "deleted"],
    ["a suspended company", () => { world.db.companies[0].suspended = true; }, 200, "company suspended"],
  ];
  for (const [name, plant, status, reason] of cases) {
    resetWorld();
    plant();
    const r = await send();
    assert.equal(r.status, status, name);
    assert.deepEqual(r.body, { state: "skipped", reason }, name);
    assert.equal(world.resend.length, 0, `${name}: an email was sent`);
    assert.equal(ledger().length, 0, `${name}: a row was written for something that was never going to be sent`);
    assert.deepEqual(world.fcm, [], `${name}: the office was pushed about a job that is not real`);
    wall();
  }
  // Not approved: refused with a conflict, never sent.
  resetWorld();
  world.db.jobs[0] = unapprovedJob();
  const r = await send();
  assert.deepEqual([r.status, r.body], [409, { state: "not_approved" }]);
  assert.equal(world.resend.length, 0);
  // CONTROL: the same fixture, with none of those flags, sends.
  resetWorld();
  assert.equal((await send()).body.state, "sent");
  assert.equal(world.resend.length, 1);
  wall();
});

test("the recipient, the figures and every word come from the database, never from the request", async () => {
  resetWorld();
  const r = await send({
    job_id: JOB_ID, to: "attacker@evil.example.test", email: "attacker@evil.example.test", cc: ["attacker@evil.example.test"], bcc: ["attacker@evil.example.test"],
    total: 1, deposit: 1, subject: "pwned", text: "pwned", name: "pwned", from: "ceo@evil.example.test", reply_to: "attacker@evil.example.test", company_id: OTHER_COMPANY,
  });
  assert.equal(r.body.state, "sent");
  const c = world.resend[0];
  assert.deepEqual(c.body.to, [CUSTOMER_EMAIL]);
  assert.ok(!c.body.cc && !c.body.bcc);
  assert.ok(!JSON.stringify(c).includes("evil.example.test") && !JSON.stringify(c).includes("pwned"));
  assert.ok(c.body.text.includes("$9,710.00") && !/Total price: \$1\.00/.test(c.body.text));
  assert.equal(c.body.reply_to, COMPANY_EMAIL);
  assert.equal(ledger()[0].company_id, COMPANY, "the company is the job's, not the request's");
  wall();
});

test("what the customer typed cannot change the email's shape: markup stays text in the HTML twin, links are dropped, line breaks cannot add headers", async () => {
  resetWorld();
  world.db.jobs[0] = approvedJob({
    quote_approved_name: "<img src=x onerror=alert(1)> https://evil.example.test/login",
    customer_name: "Pat <b>Buyer</b>", address: "1 Test St\r\nBcc: attacker@evil.example.test",
  });
  await send();
  const c = world.resend[0];
  assert.ok(!c.body.html.includes("<img"), "no tag typed by anybody survives into the HTML");
  assert.ok(c.body.html.includes("&lt;img src=x onerror=alert(1)&gt;"), "it is shown as text");
  const approvedLine = c.body.text.split("\n").find((l) => l.startsWith("Approved by")) ?? "";
  assert.ok(approvedLine && !approvedLine.includes("evil"), `the customer-typed name kept a link: ${approvedLine}`);
  assert.ok(!/https?:\/\/evil/.test(c.body.text + c.body.html) && !/href="[^"]*evil/.test(c.body.html), "no link of the customer's choosing, in the text or as a clickable link in the HTML");
  assert.ok(!/\n\s*Bcc:/i.test(c.body.text) && !c.body.bcc && !c.body.cc);
  assert.ok(!/[\r\n]/.test(c.body.subject));
  assert.deepEqual(Object.keys(c.body.headers).sort(), ["Message-ID"], "no header beyond the Message-ID");
  wall();
});

// ================================================== 8. one way of sending mail =====

test("it uses the existing mail machinery, not a second way: the shared sender, reply rule, builder and ledger -- and no credential of its own", () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const src = strip(readFileSync(new URL("../supabase/functions/quote-approval-email/index.ts", import.meta.url), "utf8"));
  for (const must of ["fenceflowFrom(", "fenceflowReplyTo(", "buildResendEmail(", "composeBody(", "fenceflowFooter(", "newMessageId(", "isValidAddress(", "normalizeAddress(",
    '"mail_ingest"', '"note_mail_event"', '"mail_event_count"', '"mail_fenceflow_account"', "Idempotency-Key"]) {
    assert.ok(src.includes(must), `index.ts no longer uses ${must}`);
  }
  // No hand-built From or Reply-To, no second mail host, no SMTP.
  assert.ok(!/\bfrom:\s*["'`]/.test(src.replace(/from: from,/g, "")), "a hand-written From");
  assert.ok(!/reply_to\s*:\s*["'`]/.test(src), "a hand-written Reply-To");
  assert.equal((src.match(/api\.resend\.com/g) ?? []).length, 1, "exactly one mention of the provider's address: the default");
  assert.ok(!/smtp|imap|mail_secret_get|createTransport|nodemailer/i.test(src), "this function holds no mailbox credential and opens no mailbox");
  assert.ok(!/MAIL_FROM_NAME|SUPPORT_EMAIL/.test(src.replace(/envOf\(deps, "MAIL_FROM_NAME"\)/, "")), "no second sender identity");
  // quote-view sends nothing itself.
  const qv = strip(readFileSync(new URL("../supabase/functions/quote-view/index.ts", import.meta.url), "utf8"));
  for (const never of ["MAIL_API_KEY", "api.resend.com", "MAIL_FROM", "smtp", "fenceflowFrom", "buildResendEmail"]) assert.ok(!qv.includes(never), `quote-view reaches for ${never}`);
});

test("the sender touches the company's own rows only: every company-scoped read and write is filtered by company, and no query names another company's data", async () => {
  resetWorld();
  world.db.fence_runs.push({ ...clone(RUNS[0]), company_id: OTHER_COMPANY, points_encoded: "0:0,99999:0" });
  world.db.company_settings.push({ company_id: OTHER_COMPANY, settings: { payment_methods: { cash_app: { on: true, tag: "OtherCompanyTag" } } } });
  await send();
  const t = text(world.resend[0]);
  assert.ok(!t.includes("OtherCompanyTag") && !t.includes("4,995 ft"), "another company's runs or payment details reached this email");
  const scoped = ["fence_runs", "company_settings", "payment_connections", "follow_up_settings", "change_orders", "mail_accounts", "mail_threads", "mail_messages"];
  for (const q of world.queries.filter((x) => scoped.includes(x.table) && x.op !== "insert")) {
    assert.ok(q.filters.some((f) => f === "eq:company_id") || q.filters.includes("eq:id") && q.table === "mail_accounts" && q.filters.includes("eq:company_id"), `${q.op} ${q.table} (${q.filters.join(", ")}) is not filtered by company`);
  }
  // The payment-methods read asks for the one key, not the blob.
  const settings = world.queries.filter((q) => q.table === "company_settings");
  assert.deepEqual(settings.map((q) => q.cols), ["payment_methods:settings->payment_methods"]);
  wall();
});

// ================================================== 9. the approval that calls it =====

const QV_SRC = readFileSync(new URL("../supabase/functions/quote-view/index.ts", import.meta.url), "utf8");

function loadQuoteView({ waitMs } = {}) {
  let js = stripTypeScriptTypes(QV_SRC);
  const shared = { "../_shared/quote-deposit.ts": quoteDeposit, "../_shared/job-push.ts": jobPush, "../_shared/push-recipients.ts": pushRecipients };
  const importRe = /^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";?[ \t]*$/gm;
  const provided = {};
  for (const [, list, from] of js.matchAll(importRe)) {
    const names = list.split(",").map((n) => n.trim()).filter(Boolean);
    if (/supabase-js/.test(from)) provided.createClient = (url, key) => globalThis.__a55CreateClient(url, key);
    else if (Object.hasOwn(shared, from)) for (const n of names) { assert.ok(n in shared[from], `${from} has no ${n}`); provided[n] = shared[from][n]; }
    else assert.fail(`an import the harness does not supply: ${from}`);
  }
  js = js.replace(importRe, "").replace(/^export /gm, "");
  if (waitMs !== undefined) {
    assert.ok(/const CONTRACT_EMAIL_WAIT_MS = 8000;/.test(js), "the wait constant moved");
    js = js.replace("const CONTRACT_EMAIL_WAIT_MS = 8000;", `const CONTRACT_EMAIL_WAIT_MS = ${waitMs};`);
  }
  let handler = null;
  const Deno = { env: { get: (n) => ENV[n] }, serve: (h) => { handler = h; } };
  const names = Object.keys(provided);
  new Function("Deno", "fetch", ...names, js)(Deno, (url, init) => network(url, init), ...names.map((n) => provided[n]));
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

/** The sender, reached the way quote-view reaches it: over the (model) network, with the trigger header. */
function routeToSender(over = {}) {
  world.senderCalls = [];
  world.senderRoute = async (url, init) => {
    world.senderCalls.push({ url, headers: Object.fromEntries(Object.entries(init.headers ?? {})), body: JSON.parse(String(init.body)) });
    if (over.respond) return await over.respond(url, init);
    return await sender.handleRequest(new Request(url, { method: init.method, headers: init.headers, body: init.body }), deps());
  };
}

async function approve(handler, { body = {}, headers = {} } = {}) {
  const res = await handler(new Request(`https://fn.test/quote-view?t=${TOKEN}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ action: "approve", name: "Pat Buyer", ...body }),
  }));
  return { status: res.status, body: await res.json() };
}

function approvalWorld(jobOver = {}) {
  resetWorld();
  world.db.jobs[0] = unapprovedJob(jobOver);
  routeToSender();
}

test("APPROVE: the customer approves and is emailed their contract; the page is told it was sent, to a masked address", async () => {
  approvalWorld();
  const qv = loadQuoteView();
  const r = await approve(qv, { body: { lang: "es" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, approvedBy: "Pat Buyer", contractEmail: { state: "sent", to: "p***@customer.example.test" } });
  const job = world.db.jobs[0];
  assert.ok(job.quote_approved_at && job.status === "ACCEPTED" && job.accepted_total === 9710, "the approval landed and recorded the price");
  assert.equal(world.resend.length, 1);
  assert.equal(world.resend[0].body.subject, "Su presupuesto de cerca aprobado con Test Fence Co", "the page's language choice");
  assert.ok(world.resend[0].body.text.includes("$9,710.00") && world.resend[0].body.text.includes("$1,800.00"));
  assert.equal(ledger()[0].state, "sent");
  // What quote-view passed: the job and the language -- nothing the recipient, the figures or the words depend on.
  assert.equal(world.senderCalls.length, 1);
  assert.deepEqual(Object.keys(world.senderCalls[0].body).sort(), ["accept_language", "job_id", "lang"]);
  assert.equal(world.senderCalls[0].body.job_id, JOB_ID);
  assert.equal(world.senderCalls[0].headers["x-fenceflow-trigger"], SECRET);
  assert.ok(!JSON.stringify(world.senderCalls[0].body).match(/\$|9710|1800|@/), "no figure and no address in what quote-view sends");
  wall();
});

test("APPROVE: the existing 'Quote approved' push is untouched by the email, and a failed email is a SEPARATE push with its own words", async () => {
  approvalWorld();
  const ok = await approve(loadQuoteView());
  assert.equal(ok.body.contractEmail.state, "sent");
  const approvedPush = world.fcm.filter((m) => m.title === "Quote approved 🎉");
  assert.ok(approvedPush.length > 0, "the approval push still goes out");
  assert.ok(approvedPush.every((m) => m.body === "Pat Buyer approved the quote for Pat Buyer."), JSON.stringify(approvedPush));
  assert.ok(!world.fcm.some((m) => /Contract email/.test(m.title)), "a successful email adds no notification");
  // Now the same approval with the email failing: the approval push is word-for-word the same, and the failure rides in its own message.
  approvalWorld({ email: "" });
  await approve(loadQuoteView());
  assert.ok(world.fcm.filter((m) => m.title === "Quote approved 🎉").every((m) => m.body === "Pat Buyer approved the quote for Pat Buyer."));
  assert.deepEqual([...new Set(world.fcm.filter((m) => /Contract email/.test(m.title)).map((m) => m.token))].sort(), ["tok-manager", "tok-owner", "tok-sales"]);
  wall();
});

test("APPROVE: the browser's language is used when the page does not say one", async () => {
  approvalWorld();
  const r = await approve(loadQuoteView(), { headers: { "Accept-Language": "fr-FR,fr;q=0.9" } });
  assert.equal(r.body.contractEmail.state, "sent");
  assert.equal(world.resend[0].body.subject, "Votre devis de clôture validé avec Test Fence Co");
  wall();
});

test("APPROVE: pressing approve again, in this tab or another, sends nothing more -- and says nothing about an email", async () => {
  approvalWorld();
  const qv = loadQuoteView();
  assert.equal((await approve(qv)).body.contractEmail.state, "sent");
  const calls = world.senderCalls.length;
  const second = await approve(qv, { body: { name: "Somebody Else" } });
  assert.deepEqual(second.body, { ok: true, approvedBy: "Pat Buyer" }, "first signature wins and no email claim is made for a request that approved nothing");
  assert.equal(world.senderCalls.length, calls, "the sender was not even called");
  assert.equal(world.resend.length, 1);
  wall();
});

test("APPROVE: two approvals in flight at once land one approval and send one email", async () => {
  approvalWorld();
  const qv = loadQuoteView();
  const [a, b] = await Promise.all([approve(qv), approve(qv, { body: { name: "Pat Buyer" } })]);
  assert.equal(world.resend.length, 1, "one contract, one email");
  assert.equal(ledger().length, 1);
  assert.equal([a, b].filter((r) => r.body.contractEmail).length, 1, "only the request whose approval landed speaks for the email");
  wall();
});

test("APPROVE: whatever happens to the email, the approval STANDS and the answer is still ok -- the page never has a reason to make her approve twice", async () => {
  const outcomes = {
    "sender not deployed (404)": { respond: async () => new Response("{}", { status: 404 }), state: "not_sent", row: "sender_unavailable", title: "Contract email NOT sent" },
    "sender secret does not match (401)": { respond: async () => new Response("{}", { status: 401 }), state: "not_sent", row: "sender_unavailable", title: "Contract email NOT sent" },
    "sender not configured (503)": { respond: async () => new Response("{}", { status: 503 }), state: "not_sent", row: "sender_unavailable", title: "Contract email NOT sent" },
    "sender crashing (500, twice)": { respond: async () => new Response("{}", { status: 500 }), state: "not_sent", row: null, title: "Contract email: could not confirm" },
    "sender unreachable (network error, twice)": { respond: async () => { throw new TypeError("fetch failed"); }, state: "not_sent", row: null, title: "Contract email: could not confirm" },
    "sender answering with something that is not JSON": { respond: async () => new Response("<html>", { status: 200 }), state: "not_sent", row: null, title: "Contract email: could not confirm" },
    "sender answering 400 (it did not run)": { respond: async () => new Response("{}", { status: 400 }), state: "not_sent", row: "sender_unavailable", title: "Contract email NOT sent" },
  };
  for (const [name, o] of Object.entries(outcomes)) {
    approvalWorld();
    routeToSender({ respond: o.respond });
    const r = await approve(loadQuoteView());
    assert.equal(r.status, 200, name);
    assert.equal(r.body.ok, true, name);
    assert.equal(r.body.contractEmail.state, o.state, name);
    assert.ok(world.db.jobs[0].quote_approved_at && world.db.jobs[0].status === "ACCEPTED", `${name}: the approval was lost`);
    assert.equal(world.resend.length, 0, name);
    if (o.row) assert.deepEqual([ledger().length, ledger()[0]?.state, ledger()[0]?.reason_code], [1, "failed", o.row], `${name}: the row`);
    else assert.equal(ledger().length, 0, `${name}: a 5xx or a dropped connection may have reached the sender, so quote-view must not write a verdict for it`);
    // One repeat after a server error or a dropped connection (safe: the sender claims first); none after a refusal or an answer.
    assert.equal(world.senderCalls.length, /404|401|not JSON|400/.test(name) ? 1 : 2, `${name}: calls`);
    // NOBODY ELSE WILL SAY SO, so quote-view does: the office's SEE_MONEY phones (and only them) are told, in words that match what is known.
    assert.deepEqual(tokensTold(), ["tok-manager", "tok-owner", "tok-sales"], `${name}: the office was not told`);
    assert.ok(notices().every((m) => m.title === o.title), `${name}: ${JSON.stringify(notices().map((m) => m.title))}`);
    for (const m of notices()) assert.ok(!/\$|\d|@/.test(`${m.title} ${m.body}`), `${name}: a figure or address in the push`);
    wall();
  }
});

test("APPROVE: the alarm needs a Firebase account to push through; without one the approval still stands and the failure is still on the record", async () => {
  approvalWorld();
  delete ENV.FIREBASE_SERVICE_ACCOUNT;
  routeToSender({ respond: async () => new Response("{}", { status: 404 }) });
  const r = await approve(loadQuoteView());
  assert.deepEqual(r.body, { ok: true, approvedBy: "Pat Buyer", contractEmail: { state: "not_sent" } });
  assert.deepEqual(world.fcm, []);
  assert.equal(ledger()[0].reason_code, "sender_unavailable");
  wall();
});

test("APPROVE: with the trigger secret unset, the approval stands, nothing is sent, and the reason is written down for the office", async () => {
  approvalWorld();
  delete ENV.NOTIFY_TRIGGER_SECRET;
  const r = await approve(loadQuoteView());
  assert.deepEqual(r.body, { ok: true, approvedBy: "Pat Buyer", contractEmail: { state: "not_sent" } });
  assert.ok(world.db.jobs[0].quote_approved_at);
  assert.equal(world.senderCalls.length, 0);
  assert.deepEqual([ledger()[0].state, ledger()[0].reason_code], ["failed", "sender_not_configured"]);
  assert.match(ledger()[0].reason, /nothing was sent/);
  assert.ok(consoleErrors.some((l) => /contract email was NOT sent/.test(l)), "and it is in the log");
  wall();
});

test("APPROVE: a database without the new table still approves -- the note about the failed email is best-effort, the approval is not", async () => {
  approvalWorld();
  delete ENV.NOTIFY_TRIGGER_SECRET;
  delete world.db.quote_approval_emails;
  const r = await approve(loadQuoteView());
  assert.equal(r.status, 200);
  assert.ok(r.body.ok && world.db.jobs[0].quote_approved_at);
  assert.equal(r.body.contractEmail.state, "not_sent");
  wall();
});

test("APPROVE: no email address on the job -- the approval stands, the page is told there is no address (so it never claims a copy is coming), the office is pushed", async () => {
  approvalWorld({ email: "" });
  const r = await approve(loadQuoteView());
  assert.deepEqual(r.body, { ok: true, approvedBy: "Pat Buyer", contractEmail: { state: "no_address" } });
  assert.ok(world.db.jobs[0].quote_approved_at);
  assert.equal(world.resend.length, 0);
  assert.equal(ledger()[0].state, "no_address");
  assert.deepEqual(tokensTold(), ["tok-manager", "tok-owner", "tok-sales"]);
  wall();
});

test("APPROVE: a send that fails after the approval tells the page 'not sent' -- and the office, by push -- while the approval stands", async () => {
  approvalWorld();
  world.resendMode = "422";
  const r = await approve(loadQuoteView());
  assert.equal(r.body.ok, true);
  assert.equal(r.body.contractEmail.state, "not_sent");
  assert.ok(world.db.jobs[0].quote_approved_at);
  assert.equal(notices().length, 3);
  assert.equal(ledger()[0].state, "failed");
  wall();
});

test("APPROVE: a slow send does not hold the customer up: past the wait the page hears 'pending' (neither sent nor failed), and the email carries on and is recorded", async () => {
  approvalWorld();
  const gate = Promise.withResolvers();
  world.onResend = () => gate.promise;
  const qv = loadQuoteView({ waitMs: 40 });
  const r = await approve(qv);
  assert.deepEqual(r.body, { ok: true, approvedBy: "Pat Buyer", contractEmail: { state: "pending" } });
  await until(() => ledger()[0]?.state === "sending", "the claim");
  assert.deepEqual(notices(), [], "a slow send is not a failed one: nobody is alarmed while it is still going");
  assert.equal(ledger()[0].state, "sending", "claimed, not yet settled");
  gate.resolve();
  await until(() => ledger()[0].state === "sent", "the email to finish after the answer went out");
  assert.equal(ledger()[0].state, "sent", "the email carried on after the answer");
  assert.equal(world.resend.length, 1);
  wall();
});

test("APPROVE: an unconfirmed send is 'pending' to the page, never 'sent' and never 'failed'", async () => {
  approvalWorld();
  world.resendMode = "500";
  const r = await approve(loadQuoteView());
  assert.deepEqual(r.body.contractEmail, { state: "pending" });
  // The sender pushes before it answers; waiting here only guards against a machine so loaded that the page's
  // own wait ran out first (the answer would still be "pending", and the push still comes).
  await until(() => notices().length === 3, "the office to be told it could not be confirmed");
  assert.equal(notices().length, 3, "and the office is told it could not be confirmed");
  assert.equal(notices()[0].title, "Contract email: could not confirm");
  wall();
});

test("APPROVE: after a drawing change the customer approves again -- the changed contract is emailed, the unchanged one is not", async () => {
  approvalWorld();
  const qv = loadQuoteView();
  assert.equal((await approve(qv)).body.contractEmail.state, "sent");
  // The drawing changed (the trigger withdrew the approval); the footage and the price moved.
  world.db.jobs[0] = { ...world.db.jobs[0], quote_approved_at: null, status: "SENT", accepted_total: null, contract_total: 10450, reapproval_required_at: "2026-10-03T00:00:00Z" };
  world.db.fence_runs[0].points_encoded = "0:0,3200:0";
  const second = await approve(qv);
  assert.equal(second.body.contractEmail.state, "sent");
  assert.equal(world.resend.length, 2);
  assert.ok(world.resend[1].body.text.includes("$10,450.00") && world.resend[1].body.text.includes("about 160 ft"));
  // Withdrawn and approved again with NOTHING changed: no third email.
  world.db.jobs[0] = { ...world.db.jobs[0], quote_approved_at: null, status: "SENT", accepted_total: null, reapproval_required_at: "2026-10-04T00:00:00Z" };
  const third = await approve(qv);
  assert.equal(third.body.contractEmail.state, "sent", "the earlier copy of this very contract went out");
  assert.equal(world.resend.length, 2, "no third email for a contract she already has");
  wall();
});

test("APPROVE: the customer's approval is unchanged by all of this -- the same errors, the same codes", async () => {
  approvalWorld();
  const qv = loadQuoteView();
  assert.equal((await approve(qv, { body: { name: "P" } })).status, 400, "a name is still required");
  assert.equal((await approve(qv, { body: { action: "nope" } })).status, 400);
  assert.equal(world.senderCalls.length, 0, "a refused approval never reaches the email");
  assert.equal(world.db.jobs[0].quote_approved_at, null);
  // A page that saw an older total is still told to reload, and nothing is emailed.
  const stale = await approve(qv, { body: { total: 1234 } });
  assert.deepEqual([stale.status, stale.body.code], [409, "quote_changed"]);
  assert.equal(world.senderCalls.length, 0);
  assert.equal(world.resend.length, 0);
  wall();
});
