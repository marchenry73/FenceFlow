// A132 -- square-webhook: what counts as live money, and a "mark it paid"
// write that is allowed to fail silently.
//
// DEFECT B -- a term that was always true, defended by a reason that was
// false. The payment path decided liveMode like this:
//
//     // Square marks sandbox activity on the payment itself. Anything not
//     // explicitly production is treated as a test and never reaches the books.
//     liveMode: event?.data?.object?.payment?.location_id !== undefined
//       && String(Deno.env.get("SQUARE_ENVIRONMENT") ?? "sandbox") === "production",
//
// Square does NOT mark sandbox activity on the payment: location_id is the
// seller location and every Square payment carries one, sandbox and
// production alike. So the first term was always true and proved nothing --
// and the direction of the only failure it could cause is the expensive one.
// A production payment that ever arrived without that field would be handed
// liveMode: false, which recordClearedPayment answers with "sandbox payment,
// deliberately not booked", and the webhook returns that with a 200. Square
// does not retry a 200. Real money, recorded nowhere, silently.
//
// The refund path (same file) and the dispute path (same file) both decide it
// from SQUARE_ENVIRONMENT alone. The fix is to make the third path agree with
// those two, and to say in the comment what is actually true.
//
// DEFECT C -- the request row was marked paid with no company scope and no
// check of either the error or how many rows it matched:
//
//     await admin.from("job_payments")
//       .update({ status: "paid", paid_at: ... })
//       .eq("processor", "square").eq("external_id", orderId);
//
// supabase-js returns { error } rather than throwing, so a refused or failed
// write left the office's Payments list reading "pending" while the webhook
// answered 200 and Square never retried. And an update that matches NOTHING
// returns [] with error null, which reads exactly like success -- the trap
// stripe-webhook's keeps_card() already names in a comment of its own.
//
// On the scope: in the live database today (checked 2026-10-25)
// job_payments.company_id is NOT NULL and a partial unique index
// job_payments_processor_external_uidx covers (processor, external_id) where
// external_id is non-empty, so there cannot presently be two rows for one
// Square order id and this is defence in depth rather than a live leak. It is
// still wrong to let a tenant boundary depend on an index somewhere else
// staying exactly as it is, and the test below proves the scope is really in
// the query by handing the function a database where that index does not
// exist.
//
// Drives the REAL function file (harness recipe from a128), with signatures
// computed independently by node:crypto.
//
//   node tests/a132-square-webhook-live-mode-and-paid-row.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createHmac } from "node:crypto";
import * as recordPayment from "../supabase/functions/_shared/record-payment.ts";
import * as pushRecipients from "../supabase/functions/_shared/push-recipients.ts";

const FN_PATH = new URL("../supabase/functions/square-webhook/index.ts", import.meta.url);
const SRC = readFileSync(FN_PATH, "utf8");

const SIG_KEY = "square_signature_key_placeholder";
const HOOK_URL = "https://project.test/functions/v1/square-webhook";
const MERCHANT = "MLFENCE000001";
const COMPANY = "c0000000-0000-4000-8000-000000000001";
const OTHER = "c0000000-0000-4000-8000-00000000000b";
const JOB = "j0000000-0000-4000-8000-000000000001";
const ORDER = "sq_order_7KQ";

const baseEnv = {
  SQUARE_WEBHOOK_SIGNATURE_KEY: SIG_KEY,
  SQUARE_WEBHOOK_URL: HOOK_URL,
  SUPABASE_URL: "https://project.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
  // FIREBASE_SERVICE_ACCOUNT deliberately absent: every push helper reads it
  // first and returns, so fetchImpl below never fires. If that stops being
  // true the harness throws instead of making a real network call.
};

// ---------------------------------------------------------------- harness --

function load({ env = {}, db, fetchImpl = async (u) => { throw new Error("unexpected fetch: " + u); } } = {}) {
  let js = stripTypeScriptTypes(SRC);
  const importRe = /^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";?[ \t]*$/gm;
  const shared = {};
  for (const [, list, from] of js.matchAll(importRe)) {
    const names = list.split(",").map((n) => n.trim()).filter(Boolean);
    if (/supabase-js/.test(from)) assert.deepEqual(names, ["createClient"]);
    else if (from === "../_shared/record-payment.ts") {
      for (const n of names) { assert.ok(n in recordPayment, `no ${n} in record-payment.ts`); shared[n] = recordPayment[n]; }
    } else if (from === "../_shared/push-recipients.ts") {
      for (const n of names) { assert.ok(n in pushRecipients, `no ${n} in push-recipients.ts`); shared[n] = pushRecipients[n]; }
    } else assert.fail(`an import the harness does not supply: ${from}`);
  }
  js = js.replace(importRe, "").replace(/^export /gm, "");
  assert.doesNotMatch(js, /^import /m);
  const names = Object.keys(shared);
  let handler = null;
  const Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
  new Function("Deno", "createClient", "fetch", ...names, js)(
    Deno, () => db, fetchImpl, ...names.map((n) => shared[n]),
  );
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

/** In-memory service-role client. Same shape as a128's fakeDb, with two
 *  additions this file needs: `.select()` after an `.update()` returns the
 *  rows that matched (which is how the fix learns it matched none), and
 *  `failUpdate` / `vanishBeforeUpdate` let a write fail or find nothing. */
function fakeDb(tables, { failUpdate = null, vanishBeforeUpdate = null } = {}) {
  const t = structuredClone(tables);
  const log = { updates: [] };
  let seq = 0;
  class Query {
    constructor(table) { this.table = table; this.op = "select"; this.filters = []; this.lim = Infinity; this.returning = false; }
    select() { if (this.op === "update") this.returning = true; return this; }
    eq(k, v) { this.filters.push([k, (r) => String(r[k]) === String(v)]); return this; }
    is(k, v) { this.filters.push([k, (r) => (v === null ? (r[k] === null || r[k] === undefined) : r[k] === v)]); return this; }
    order() { return this; }
    limit(n) { this.lim = n; return this; }
    insert(row) { this.op = "insert"; this.payload = row; return this; }
    update(patch) { this.op = "update"; this.payload = patch; return this; }
    upsert(row, opts) {
      this.op = "upsert"; this.payload = row;
      this.conflict = String(opts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      return this;
    }
    maybeSingle() { this.mode = "maybe"; return this.run(); }
    single() { this.mode = "one"; return this.run(); }
    then(ok, bad) { return this.run().then(ok, bad); }
    async run() {
      const rows = (t[this.table] ??= []);
      if (this.op === "upsert") {
        const key = this.conflict.length ? this.conflict : Object.keys(this.payload);
        const hit = rows.find((r) => key.every((k) => String(r[k]) === String(this.payload[k])));
        if (hit) Object.assign(hit, this.payload); else rows.push({ id: `new-${++seq}`, ...this.payload });
        return { data: null, error: null };
      }
      if (this.op === "insert") { rows.push({ id: `new-${++seq}`, ...this.payload }); return { data: null, error: null }; }
      if (this.op === "update") {
        if (failUpdate && failUpdate.table === this.table) {
          log.updates.push({ table: this.table, failed: true, filters: this.filters.map(([k]) => k) });
          return { data: null, error: { message: failUpdate.message } };
        }
        if (vanishBeforeUpdate && vanishBeforeUpdate.table === this.table) {
          // The row changed underneath us between the read and the write --
          // a concurrent cancel, a correction by hand. The ONLY signal is an
          // empty match with error null.
          t[this.table] = rows.filter((r) => r.id !== vanishBeforeUpdate.id);
        }
        const hit = (t[this.table] ??= []).filter((r) => this.filters.every(([, f]) => f(r)));
        hit.forEach((r) => Object.assign(r, this.payload));
        log.updates.push({ table: this.table, matched: hit.length, filters: this.filters.map(([k]) => k) });
        return { data: this.returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
      }
      const hit = rows.filter((r) => this.filters.every(([, f]) => f(r)));
      const out = hit.slice(0, this.lim);
      if (this.mode === "maybe") return { data: out[0] ?? null, error: null };
      if (this.mode === "one") return out[0] ? { data: out[0], error: null } : { data: null, error: { message: "no row" } };
      return { data: out, error: null };
    }
  }
  return { tables: t, log, from: (table) => new Query(table), rpc: async () => ({ data: true, error: null }) };
}

/** One company, one Square connection, one pending request, one job. */
function seed(extraRequests = []) {
  return fakeDb({
    payment_connections: [{ id: "pc-1", processor: "square", external_id: MERCHANT, company_id: COMPANY, access_token: "tok" }],
    job_payments: [
      { id: "jp-1", company_id: COMPANY, job_sync_id: JOB, status: "pending", processor: "square", external_id: ORDER, amount_cents: 50000, livemode: true, created_at: "2026-10-01T00:00:00Z" },
      ...extraRequests,
    ],
    jobs: [{ id: "job-row-1", sync_id: JOB, company_id: COMPANY, customer_name: "Pat", deposit_amount: 0, contract_total: 1000, refunded_amount: 0, payment_status: "UNPAID" }],
    payment_records: [],
  });
}

const paymentEvent = ({ withLocation = true, orderId = ORDER, amount = 50000 } = {}) => ({
  merchant_id: MERCHANT,
  type: "payment.updated",
  data: {
    object: {
      payment: {
        id: "sqpay_1",
        status: "COMPLETED",
        order_id: orderId,
        amount_money: { amount, currency: "USD" },
        ...(withLocation ? { location_id: "L8NYC" } : {}),
      },
    },
  },
});

/** Square's signature: base64 HMAC-SHA256 over notificationUrl + rawBody,
 *  computed here and by nothing in the function under test. */
const sign = (raw) => createHmac("sha256", SIG_KEY).update(HOOK_URL + raw).digest("base64");

async function post(handler, event) {
  const raw = JSON.stringify(event);
  const res = await handler(new Request(HOOK_URL, {
    method: "POST",
    headers: { "x-square-hmacsha256-signature": sign(raw) },
    body: raw,
  }));
  return { status: res.status, text: await res.text() };
}

const ledger = (db) => db.tables.payment_records ?? [];
const request1 = (db) => db.tables.job_payments.find((r) => r.id === "jp-1");
const job = (db) => db.tables.jobs.find((r) => r.sync_id === JOB);

// ============================================================= DEFECT B ====

test("a PRODUCTION payment with no location_id on it is still real money", async () => {
  // The whole defect, as one case. Square changing the payment shape, a
  // Terminal payment, an API version that omits the field -- any of them used
  // to be answered "sandbox payment, deliberately not booked" with a 200.
  const db = seed();
  const r = await post(load({ env: { ...baseEnv, SQUARE_ENVIRONMENT: "production" }, db }),
    paymentEvent({ withLocation: false }));
  assert.equal(r.status, 200, r.text);
  assert.doesNotMatch(r.text, /sandbox/i, "a production payment must never be called sandbox");
  assert.equal(ledger(db).length, 1, "the money reaches the ledger");
  assert.equal(ledger(db)[0].amount, 500);
  assert.equal(job(db).amount_paid, 500, "and the job stops showing a balance already settled");
});

test("a production payment WITH location_id is booked exactly as before", async () => {
  const db = seed();
  const r = await post(load({ env: { ...baseEnv, SQUARE_ENVIRONMENT: "production" }, db }), paymentEvent());
  assert.equal(r.status, 200, r.text);
  assert.equal(ledger(db).length, 1);
  assert.equal(job(db).amount_paid, 500);
});

test("sandbox money is still never booked -- the rule the fix must not weaken", async () => {
  for (const env of ["sandbox", "", undefined]) {
    const db = seed();
    const r = await post(load({ env: { ...baseEnv, SQUARE_ENVIRONMENT: env }, db }), paymentEvent());
    assert.equal(r.status, 200, r.text);
    assert.match(r.text, /sandbox payment, deliberately not booked/i, `SQUARE_ENVIRONMENT=${env}`);
    assert.equal(ledger(db).length, 0, "no ledger row");
    assert.equal(job(db).amount_paid, undefined, "and the job is untouched");
  }
});

test("the three paths in this file decide liveMode by the same expression", async () => {
  // Read from the CODE with comments stripped, so the prose above cannot
  // stand in for the decision -- the old comment is exactly how this defect
  // survived a reading.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const decisions = [...code.matchAll(/liveMode:\s*([^\n,]+(?:\n[^\n,]+)*?),?\s*\n/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
  const inline = [...code.matchAll(/const liveMode = ([^\n;]+);/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
  const all = [...decisions, ...inline];
  assert.equal(all.length, 3, `expected three liveMode decisions, found ${all.length}: ${JSON.stringify(all)}`);
  assert.equal(new Set(all).size, 1, `the three paths disagree: ${JSON.stringify(all)}`);
  assert.equal(all[0], 'String(Deno.env.get("SQUARE_ENVIRONMENT") ?? "sandbox") === "production"');
  assert.doesNotMatch(code, /location_id/,
    "no live-money decision may rest on location_id, which every Square payment carries");
});

test("the old rule and the new one genuinely disagree", async () => {
  // A guard against the extra term coming back. If these ever agree on every
  // case, the fix has been undone.
  const newRule = (env) => String(env ?? "sandbox") === "production";
  const oldRule = (env, locationId) => locationId !== undefined && newRule(env);
  assert.equal(oldRule("production", undefined), false, "by construction, the old rule discarded this");
  assert.equal(newRule("production"), true, "and the new one books it");
  // Everywhere else they must still agree, or something more than the dead
  // term has changed.
  for (const env of ["production", "sandbox", undefined]) {
    assert.equal(oldRule(env, "L8NYC"), newRule(env), `with a location_id, ${env} must be unchanged`);
  }
});

// ============================================================= DEFECT C ====

test("the paid write is scoped to the company, so another tenant's row with the same order id is untouched", async () => {
  // Defence in depth, proved against a database where the partial unique
  // index that today prevents this does not exist.
  const db = seed([{
    id: "jp-other", company_id: OTHER, job_sync_id: "j0000000-0000-4000-8000-0000000000ff",
    status: "pending", processor: "square", external_id: ORDER, amount_cents: 9900,
    livemode: true, created_at: "2026-10-02T00:00:00Z",
  }]);
  const r = await post(load({ env: { ...baseEnv, SQUARE_ENVIRONMENT: "production" }, db }), paymentEvent());
  assert.equal(r.status, 200, r.text);
  assert.equal(request1(db).status, "paid", "the right request is marked paid");
  assert.equal(db.tables.job_payments.find((x) => x.id === "jp-other").status, "pending",
    "the other company's request must not be touched by a Square order id");
  const marks = db.log.updates.filter((u) => u.table === "job_payments");
  assert.equal(marks.length, 1);
  assert.ok(marks[0].filters.includes("company_id"),
    "the update must carry a company_id filter, not just Square's own ids");
});

test("a paid write that FAILED answers 500 so Square retries, and books nothing", async () => {
  const db = fakeDb({
    payment_connections: [{ id: "pc-1", processor: "square", external_id: MERCHANT, company_id: COMPANY }],
    job_payments: [{ id: "jp-1", company_id: COMPANY, job_sync_id: JOB, status: "pending", processor: "square", external_id: ORDER, created_at: "2026-10-01T00:00:00Z" }],
    jobs: [{ id: "job-row-1", sync_id: JOB, company_id: COMPANY, customer_name: "Pat", deposit_amount: 0, contract_total: 1000, refunded_amount: 0, payment_status: "UNPAID" }],
    payment_records: [],
  }, { failUpdate: { table: "job_payments", message: "deadlock detected" } });

  const r = await post(load({ env: { ...baseEnv, SQUARE_ENVIRONMENT: "production" }, db }), paymentEvent());
  assert.equal(r.status, 500, "a failed money write must not be answered 200: " + r.text);
  assert.match(r.text, /mark the Square payment request paid/,
    "and it must say which write failed");
  assert.equal(request1(db).status, "pending");
});

test("a paid write that matched NOTHING is not reported as success", async () => {
  // The row is read, then changes underneath us before the update -- a
  // concurrent cancel, or a correction by hand. supabase-js answers [] with
  // error null, which is indistinguishable from a successful write unless
  // somebody looks.
  const db = seed();
  db.log.updates.length = 0;
  const vanishing = fakeDb(db.tables, { vanishBeforeUpdate: { table: "job_payments", id: "jp-1" } });
  const r = await post(load({ env: { ...baseEnv, SQUARE_ENVIRONMENT: "production" }, db: vanishing }), paymentEvent());
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /warning/i, "the answer must say that nothing was marked paid");
  assert.match(r.text, new RegExp(ORDER), "and name the order, so it can be put right by hand");
  // The money still books: the job's own figures matter more than this row.
  assert.equal(ledger(vanishing).length, 1, "the payment itself is still recorded");
});

test("POSITIVE CONTROL: the ordinary case marks the request paid and says nothing else", async () => {
  // Without this, every assertion above would pass against a function that
  // had stopped marking anything paid, or that warned on every payment.
  const db = seed();
  const r = await post(load({ env: { ...baseEnv, SQUARE_ENVIRONMENT: "production" }, db }), paymentEvent());
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /warning/i, "a clean run carries no warning");
  assert.equal(request1(db).status, "paid");
  assert.ok(request1(db).paid_at, "and is stamped");
  assert.equal(ledger(db).length, 1);
  assert.equal(job(db).payment_status, "DEPOSIT_PAID");
});

test("an event for a Square account we do not know is still answered 200 and written nowhere", async () => {
  // Scope guard: the early returns around the fix must still work.
  const db = seed();
  db.tables.payment_connections = [];
  const r = await post(load({ env: { ...baseEnv, SQUARE_ENVIRONMENT: "production" }, db }), paymentEvent());
  assert.equal(r.status, 200);
  assert.match(r.text, /no company for that merchant/);
  assert.equal(ledger(db).length, 0);
  assert.equal(request1(db).status, "pending");
});

test("a bad signature is still refused before anything is read", async () => {
  const db = seed();
  const handler = load({ env: { ...baseEnv, SQUARE_ENVIRONMENT: "production" }, db });
  const raw = JSON.stringify(paymentEvent());
  const res = await handler(new Request(HOOK_URL, {
    method: "POST", headers: { "x-square-hmacsha256-signature": "not-the-signature" }, body: raw,
  }));
  assert.equal(res.status, 400);
  assert.equal(await res.text(), "Bad signature");
  assert.equal(request1(db).status, "pending");
});
