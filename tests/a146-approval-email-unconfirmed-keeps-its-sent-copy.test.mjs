// a146 -- quote-approval-email: an UNCONFIRMED send lost the link to the Sent
// copy it had already made.
//
// sendViaFenceflow() records the Sent copy in mail_messages BEFORE a byte goes
// to the provider, and on an unknown outcome stamps that row with
// UNCONFIRMED_NOTE: "FenceFlow could not confirm this email was sent. Check
// Sent before sending it again." Then it throws, and the caller did:
//
//     await settleLedger(db, deps, ledgerId, { state: f.state, reason_code: f.code, reason: f.reason });
//
// -- no mail_message_id. So quote_approval_emails carried a row saying "go and
// look in Sent" with nothing in it pointing at the row in Sent. The push sends
// the owner there and the ledger entry that should take them there was blank.
//
// Only the success branch passed mail_message_id, and `sendViaFenceflow` can
// only reach its DeliveryUnknown throws AFTER mail_ingest has made the row, so
// the row always existed. The fix carries the id out of the send through
// `recorded`, filled the moment mail_ingest answers.
//
// Verified against production 2026-10-26 (read-only): the single
// quote_approval_emails row with state='unconfirmed' is NOT an instance -- its
// reason_code is 'sender_did_not_answer', which only quote-view's recordPending
// writes, and that row deliberately has no mail copy. So this was a real source
// defect with zero rows written through it so far, which is the easiest kind to
// leave in place.
//
// The sender's own index.ts runs for real against models (harness in the shape
// of a55-approval-email-send.test.mjs, trimmed to this one path).
//
//   node tests/a146-approval-email-unconfirmed-keeps-its-sent-copy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { RESEND_SENDS_PER_HOUR } from "../supabase/functions/_shared/mail/limits.ts";

const SUPABASE_JS = "https://esm.sh/@supabase/supabase-js@2.39.0";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === SUPABASE_JS) {
      const src = "export const createClient = (...a) => globalThis.__a146CreateClient(...a);";
      return { url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const sender = await import("../supabase/functions/quote-approval-email/index.ts");

// ------------------------------------------------------- made-up identities --
const SECRET = "a146-FAKE-trigger-secret-00000000000000";
const API_KEY = "re_FAKE_a146_provider_key_Qw9Zx2Vb7Nm4";
const SERVICE_KEY = "a146-FAKE-service-role-key";
const COMPANY = "a1460000-0000-4000-8000-000000000001";
const JOB_ID = "a1460000-0000-4000-8000-0000000000a1";
const JOB_SYNC = "a1460000-0000-4000-8000-0000000000a2";
const TOKEN = "a1460000-0000-4000-8000-0000000000a3";
const CUSTOMER_EMAIL = "pat.buyer@customer.example.test";
const COMPANY_EMAIL = "office@testfence.example.test";
const MAIL_HOST = "https://mail.fake.example.test/emails";
const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const ALLOWED_DOMAIN = /\.example\.test$/;

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const UNIQUE = { quote_approval_emails: ["company_id", "job_sync_id", "contract_key"] };

let world;
const ENV = {};

const approvedJob = (over = {}) => ({
  id: JOB_ID, sync_id: JOB_SYNC, company_id: COMPANY, customer_name: "Pat Buyer", email: CUSTOMER_EMAIL,
  address: "1 Test Street, Testville", phone: "", status: "ACCEPTED", deleted_at: null, is_test_fixture: false,
  quote_token: TOKEN, quote_approved_at: "2026-10-25T22:00:00.000Z", quote_approved_name: "Pat Buyer",
  contract_total: 9710, accepted_total: 9710, signed_at: null, deposit_amount: 1800, amount_paid: 0,
  refunded_amount: 0, tax_rate_percent: 0, discount_percent: 0, calibration_pixels_per_foot: 20,
  reapproval_required_at: null, reapproval_reason: "", quote_viewed_at: "2026-10-25T20:00:00.000Z",
  assigned_employee_sync_id: null, ...over,
});

const RUNS = [{
  company_id: COMPANY, job_sync_id: JOB_SYNC, deleted_at: null, label: "Back yard",
  fence_type: "WOOD_PRIVACY", color_or_finish: "Cedar", points_encoded: "0:0,2800:0", gates_encoded: "a,b",
  closed_loop: false, panel_height_ft: 6, fabric_height_ft: 0, manual_linear_feet: 0, is_teardown: false,
}];

function resetWorld() {
  for (const k of Object.keys(ENV)) delete ENV[k];
  Object.assign(ENV, {
    SUPABASE_URL: "https://project.fake.example.test",
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    NOTIFY_TRIGGER_SECRET: SECRET,
    MAIL_API_KEY: API_KEY,
    MAIL_FROM: "noreply@send.fake.example.test",
    MAIL_API_URL: MAIL_HOST,
    SITE_URL: "https://site.fake.example.test",
  });
  world = {
    created: [], events: [], resend: [], refused: [], resendMode: "ok",
    db: {
      jobs: [approvedJob()],
      companies: [{ id: COMPANY, name: "Test Fence Co", phone: "555-0100", email: COMPANY_EMAIL, suspended: false }],
      fence_runs: clone(RUNS), change_orders: [], company_settings: [], payment_connections: [],
      quote_approval_emails: [], estimate_line_items: [],
      mail_accounts: [], mail_messages: [], mail_threads: [], mail_thread_jobs: [],
      mail_platform_settings: [{ id: 1, inbound_verified_at: null }],
      profiles: [], device_tokens: [],
    },
  };
}

// --------------------------------------------------------------- the model db --

function execute(table, st) {
  const rows = world.db[table];
  if (!rows) return { data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } };
  if (st.op === "insert") {
    const row = {
      id: randomUUID(), attempted_at: new Date(NOW).toISOString(), settled_at: null, reason_code: null,
      reason: null, sent_to: null, mail_message_id: null, provider_message_id: null, lang: null, ...clone(st.payload),
    };
    const key = UNIQUE[table];
    if (key && rows.some((r) => key.every((k) => r[k] === row[k]))) {
      return { data: null, error: { code: "23505", message: "duplicate key" } };
    }
    rows.push(row);
    return st.returning ? finish([row], st) : { data: null, error: null };
  }
  const hit = rows.filter((r) => st.filters.every((f) => f(r)));
  if (st.op === "update") {
    for (const r of hit) Object.assign(r, clone(st.payload));
    return st.returning ? finish(hit, st) : { data: null, error: null };
  }
  return finish(hit, st);
}

function finish(hit, st) {
  const cols = String(st.cols).split(",").map((c) => c.trim()).filter(Boolean);
  const parts = cols.map((c) => /^(\w+):settings->(\w+)$/.exec(c));
  const alias = parts.length > 0 && parts.every(Boolean) ? parts : null;
  const out = hit.map((r) => {
    if (alias) return Object.fromEntries(alias.map((a) => [a[1], clone(r.settings?.[a[2]])]));
    if (!cols.length || cols.includes("*")) return clone(r);
    return Object.fromEntries(cols.map((c) => [c, clone(r[c]) ?? null]));
  });
  if (st.mode === "maybe") return { data: out[0] ?? null, error: null };
  return { data: out, error: null };
}

class Query {
  constructor(table) {
    this.st = { table, op: "select", cols: "*", filters: [], payload: null, returning: false, mode: null };
  }
  select(cols = "*") { if (this.st.op !== "select") this.st.returning = true; this.st.cols = cols; return this; }
  insert(row) { this.st.op = "insert"; this.st.payload = row; return this; }
  update(row) { this.st.op = "update"; this.st.payload = row; return this; }
  eq(k, v) { this.st.filters.push((r) => String(r[k]) === String(v)); return this; }
  is(k, v) { this.st.filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return this; }
  in(k, vs) { this.st.filters.push((r) => vs.map(String).includes(String(r[k]))); return this; }
  not(k, op, v) { if (op === "is" && v === null) this.st.filters.push((r) => r[k] != null); return this; }
  order() { return this; }
  limit() { return this; }
  maybeSingle() { this.st.mode = "maybe"; return this.run(); }
  run() { return Promise.resolve().then(() => execute(this.st.table, this.st)); }
  then(ok, bad) { return this.run().then(ok, bad); }
}

const WINDOWS = { "1 hour": 3_600_000, "1 day": 86_400_000 };
const countEvents = (company, kind, window) =>
  world.events.filter((e) => e.company === company && e.kind === kind && e.at > NOW - WINDOWS[window]).length;

/** mail_ingest to supabase_mail.sql's contract: de-duped on client_send_id
 *  within the account's company, which is what makes `inserted` meaningful. */
function ingest(args) {
  const acct = world.db.mail_accounts.find((a) => a.id === args.p_account);
  if (!acct) return { data: null, error: { code: "P0002", message: "Unknown mail account" } };
  const out = [];
  for (const r of args.p_rows) {
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
    out.push({ message_id: row.id, thread_id: thread.id, inserted: true });
  }
  return { data: out, error: null };
}

function rpc(key, name, args = {}) {
  if (key !== SERVICE_KEY) return { data: null, error: { code: "42501", message: "Service role only" } };
  switch (name) {
    case "note_mail_event":
      world.events.push({ company: args.p_company, kind: args.p_kind, at: NOW });
      return { data: countEvents(args.p_company, args.p_kind, args.p_window), error: null };
    case "mail_event_count":
      return { data: countEvents(args.p_company, args.p_kind, args.p_window), error: null };
    case "mail_ingest":
      return ingest(args);
    case "mail_fenceflow_account": {
      let row = world.db.mail_accounts.find((r) => r.company_id === args.p_company && r.kind === "fenceflow");
      if (!row) {
        row = { id: randomUUID(), company_id: args.p_company, kind: "fenceflow", provider: "resend", email_address: args.p_email, inbound_token: "a1b2c3d4e5f60718", status: "connected" };
        world.db.mail_accounts.push(row);
      }
      return { data: row.id, error: null };
    }
    default: return { data: null, error: { code: "PGRST202", message: `no function ${name}` } };
  }
}

globalThis.__a146CreateClient = (url, key) => {
  world.created.push({ url, key });
  return { rpc: async (name, args) => rpc(key, name, args), from: (table) => new Query(table) };
};

// ---------------------------------------------- the network: a model and a wall --

async function network(url, init = {}) {
  const u = String(url);
  if (u === MAIL_HOST) {
    world.resend.push({ url: u, body: JSON.parse(String(init.body)) });
    switch (world.resendMode) {
      case "ok": return new Response(JSON.stringify({ id: `prov_${world.resend.length}` }), { status: 200 });
      case "throw": throw Object.assign(new Error("socket hang up"), { name: "TypeError" });
      case "timeout": throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      default: return new Response(JSON.stringify({ message: `planted ${world.resendMode}` }), { status: Number(world.resendMode) });
    }
  }
  world.refused.push(u);
  throw new Error(`REFUSED by the a146 harness: a test tried to reach ${u}`);
}

const deps = () => ({
  fetch: (url, init) => network(url, init),
  env: (name) => ENV[name],
  now: () => NOW,
  uuid: () => randomUUID(),
  background: (work) => work,
});

async function send() {
  const res = await sender.handleRequest(new Request("https://fn.test/functions/v1/quote-approval-email", {
    method: "POST",
    headers: { "content-type": "application/json", "x-fenceflow-trigger": SECRET },
    body: JSON.stringify({ job_id: JOB_ID }),
  }), deps());
  return { status: res.status, body: await res.json() };
}

const consoleErrors = [];
const realError = console.error;
console.error = (...a) => { consoleErrors.push(a.map(String).join(" ")); };
test.after(() => { console.error = realError; });

const ledger = () => world.db.quote_approval_emails;

/** Nothing left the models, and no recipient outside the reserved names. */
function wall() {
  assert.deepEqual(world.refused, [], "the harness refused a request that would have left the process");
  for (const c of world.resend) {
    for (const r of c.body.to ?? []) assert.match(r, ALLOWED_DOMAIN, `a recipient outside the reserved test names: ${r}`);
  }
  assert.ok(world.created.every((c) => c.key === SERVICE_KEY), "a client other than the model service client was created");
}

// ========================================================================= ==

test("a provider that never answers: the ledger row still points at the Sent copy it made", async () => {
  // Every way sendViaFenceflow can end up UNCONFIRMED, each one reached only
  // after the mail_messages row exists.
  for (const mode of ["throw", "timeout", "500", "409"]) {
    resetWorld();
    world.resendMode = mode;
    const r = await send();

    assert.equal(r.status, 200, `${mode}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.state, "unconfirmed", `${mode}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.reason_code, "unconfirmed", mode);

    // The Sent copy exists, and carries the note that sends the owner to Sent.
    assert.equal(world.db.mail_messages.length, 1, mode);
    const copy = world.db.mail_messages[0];
    assert.deepEqual([copy.send_state, copy.send_error], ["sending", sender.UNCONFIRMED_NOTE], mode);
    assert.equal(copy.folder_role, "sent", mode);

    // THE POINT: the ledger can be followed to it.
    assert.equal(ledger().length, 1, mode);
    const row = ledger()[0];
    assert.equal(row.state, "unconfirmed", mode);
    assert.equal(row.mail_message_id, copy.id, `${mode}: the ledger cannot reach the Sent copy it is telling the owner to check`);
    assert.ok(row.settled_at, mode);
    // The copy the ledger points at is this contract's copy, not some other row.
    assert.equal(copy.client_send_id, row.id, mode);
    wall();
  }
});

test("a confirmed send is unchanged: still linked, still 'sent'", async () => {
  resetWorld();
  const r = await send();
  assert.equal(r.body.state, "sent", JSON.stringify(r.body));
  assert.equal(world.db.mail_messages.length, 1);
  assert.equal(ledger()[0].mail_message_id, world.db.mail_messages[0].id);
  assert.equal(world.db.mail_messages[0].send_state, "sent");
  assert.equal(ledger()[0].provider_message_id, "prov_1");
  wall();
});

test("a send the provider REFUSED links to the copy too -- that copy is marked failed, which is equally true", async () => {
  resetWorld();
  world.resendMode = "422";
  const r = await send();
  assert.equal(r.body.state, "failed", JSON.stringify(r.body));
  assert.equal(r.body.reason_code, "send_rejected");
  const copy = world.db.mail_messages[0];
  assert.equal(copy.send_state, "failed");
  assert.equal(ledger()[0].mail_message_id, copy.id);
  wall();
});

test("an attempt that never got as far as a Sent copy links to nothing, and says so with NULL", async () => {
  // Refused before mail_ingest: the rate ledger is over the cap, so there is
  // no copy to point at and mail_message_id must stay NULL rather than
  // pointing somewhere plausible.
  resetWorld();
  for (let i = 0; i < RESEND_SENDS_PER_HOUR + 1; i++) world.events.push({ company: COMPANY, kind: "send_resend", at: NOW });
  const r = await send();
  assert.equal(r.body.state, "failed", JSON.stringify(r.body));
  assert.equal(r.body.reason_code, "rate_limited");
  assert.deepEqual(world.db.mail_messages, [], "nothing was recorded, so nothing may be linked");
  assert.equal(ledger()[0].mail_message_id, null);
  assert.deepEqual(world.resend, [], "and the provider was never called");
  wall();
});
