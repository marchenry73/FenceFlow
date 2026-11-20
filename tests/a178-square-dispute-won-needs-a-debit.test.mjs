/**
 * A SQUARE DISPUTE WON MAY ONLY REINSTATE MONEY THAT WAS ACTUALLY TAKEN.
 *
 *     node --test tests/a178-square-dispute-won-needs-a-debit.test.mjs
 *
 * ------------------------------------------------------------------
 * THE DEFECT, from the A4 money audit (20 Nov 2026)
 * ------------------------------------------------------------------
 * The dispute handler has three money moments:
 *
 *   OPEN            -- deliberately does NOT touch amount_paid, because
 *                      "most of these states haven't moved any money yet".
 *   LOST / ACCEPTED -- recordRefund writes a NEGATIVE ledger row: the debit.
 *   WON             -- upserted `+Math.abs(amount)` as a "chargeback reversed
 *                      in your favour" credit, with NO CHECK that a debit was
 *                      ever recorded.
 *
 * So OPEN -> WON -- the good outcome, the one where he keeps the money --
 * wrote a credit against a debit that never happened. A $5,000 payment
 * disputed and won read as $10,000 collected. The customer is not harmed
 * (their balance floors at zero); his own collected-cash and profit figures
 * were overstated by the full amount of every dispute he won.
 *
 * Stripe's side already does this correctly for comparison: it reinstates
 * only after it has seen funds_withdrawn.
 *
 * ------------------------------------------------------------------
 * HOW IT TESTS IT
 * ------------------------------------------------------------------
 * By driving the REAL square-webhook file (harness recipe from a135 and
 * a128), signed with a signature node:crypto computes independently, against
 * an in-memory database and the REAL shared record-payment module -- so the
 * refund rows the LOST path writes are written by the same code that writes
 * them in production, and the WON path's lookup has to find the real key.
 *
 * The canary plants the old unconditional credit back and watches it bite.
 */
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
const JOB = "j0000000-0000-4000-8000-000000000001";
const ORDER = "sq_order_7KQ";
const PAYMENT = "sqpay_1";
const DISPUTE = "disp_9F2";

const ENV = {
  SQUARE_WEBHOOK_SIGNATURE_KEY: SIG_KEY,
  SQUARE_WEBHOOK_URL: HOOK_URL,
  SQUARE_ENVIRONMENT: "production",
  SUPABASE_URL: "https://project.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
  // FIREBASE_SERVICE_ACCOUNT absent on purpose: every push helper reads it
  // first and returns, so the only fetch this file ever makes is Square's own
  // payment lookup, which the fake below answers.
};

// ---------------------------------------------------------------- harness --

function load({ db, plant = {}, env = {} } = {}) {
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

  /* Plants must land on something real, or a rename turns the canary into a
     quiet no-op that proves nothing. The dispute credit is not its own
     function, so this one is a source substitution -- and the marker it
     replaces is asserted present first, for the same reason. */
  let planted = js;
  for (const [marker, replacement] of Object.entries(plant)) {
    assert.ok(planted.includes(marker), `the canary's marker is not in the file:\n${marker}`);
    planted = planted.replace(marker, replacement);
    assert.ok(!planted.includes(marker), "the marker survived the substitution");
  }

  const names = Object.keys(shared);
  let handler = null;
  const vars = { ...ENV, ...env };
  const Deno = { env: { get: (k) => vars[k] }, serve: (h) => { handler = h; } };
  new Function("Deno", "createClient", "fetch", ...names, planted)(
    Deno, () => db, squareApi, ...names.map((n) => shared[n]),
  );
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

/** Square's own API: one call, payment id -> order id. */
async function squareApi(url) {
  const u = new URL(url);
  if (u.pathname === `/v2/payments/${PAYMENT}`) {
    return new Response(JSON.stringify({ payment: { id: PAYMENT, order_id: ORDER } }), { status: 200 });
  }
  throw new Error("unexpected fetch: " + url);
}

function fakeDb(tables) {
  const t = structuredClone(tables);
  const fail = {};
  let seq = 0;
  class Query {
    constructor(table) { this.table = table; this.op = "select"; this.filters = []; this.lim = Infinity; this.returning = false; }
    select() { if (this.op !== "select") this.returning = true; return this; }
    eq(k, v) { this.filters.push((r) => String(r[k]) === String(v)); return this; }
    is(k, v) { this.filters.push((r) => (v === null ? (r[k] === null || r[k] === undefined) : r[k] === v)); return this; }
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
      const planted = fail[`${this.table}:${this.op}`];
      if (planted) return { data: null, error: { message: planted } };
      const rows = (t[this.table] ??= []);
      if (this.op === "upsert") {
        const key = this.conflict.length ? this.conflict : Object.keys(this.payload);
        const hit = rows.find((r) => key.every((k) => String(r[k]) === String(this.payload[k])));
        if (hit) Object.assign(hit, this.payload); else rows.push({ id: `new-${++seq}`, ...this.payload });
        return { data: null, error: null };
      }
      if (this.op === "insert") { rows.push({ id: `new-${++seq}`, ...this.payload }); return { data: null, error: null }; }
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") {
        hit.forEach((r) => Object.assign(r, this.payload));
        return { data: this.returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
      }
      const out = hit.slice(0, this.lim);
      if (this.mode === "maybe") return { data: out[0] ?? null, error: null };
      if (this.mode === "one") return out[0] ? { data: out[0], error: null } : { data: null, error: { message: "no row" } };
      return { data: out, error: null };
    }
  }
  return { tables: t, fail, from: (table) => new Query(table), rpc: async () => ({ data: true, error: null }) };
}

/** A job that has been paid $5,000 by card through a Square link. */
function seed() {
  return fakeDb({
    payment_connections: [{ id: "pc-1", processor: "square", external_id: MERCHANT, company_id: COMPANY, access_token: "tok" }],
    job_payments: [{
      id: "jp-1", company_id: COMPANY, job_sync_id: JOB, status: "paid", processor: "square",
      external_id: ORDER, amount_cents: 500000, livemode: true, created_at: "2026-10-01T00:00:00Z",
    }],
    jobs: [{
      id: "job-row-1", sync_id: JOB, company_id: COMPANY, customer_name: "Pat", deposit_amount: 0,
      contract_total: 5000, amount_paid: 5000, refunded_amount: 0, payment_status: "PAID_IN_FULL",
    }],
    payment_records: [{
      id: "pr-1", sync_id: "square-" + ORDER, company_id: COMPANY, job_sync_id: JOB,
      amount: 5000, method: "CARD", deleted_at: null,
    }],
  });
}

const disputeEvent = (state) => ({
  merchant_id: MERCHANT,
  type: "dispute.state.updated",
  data: {
    object: {
      dispute: {
        dispute_id: DISPUTE,
        state,
        reason: "NO_KNOWLEDGE",
        created_at: "2026-11-01T00:00:00Z",
        amount_money: { amount: 500000, currency: "USD" },
        disputed_payment: { payment_id: PAYMENT },
      },
    },
  },
});

const sign = (raw) => createHmac("sha256", SIG_KEY).update(HOOK_URL + raw).digest("base64");

async function post(handler, event) {
  const raw = JSON.stringify(event);
  const res = await handler(new Request(HOOK_URL, {
    method: "POST", headers: { "x-square-hmacsha256-signature": sign(raw) }, body: raw,
  }));
  return { status: res.status, text: await res.text() };
}

const ledger = (db) => db.tables.payment_records ?? [];
/** Everything the dispute put in the ledger, ignoring the original payment. */
const disputeRows = (db) => ledger(db).filter((r) => String(r.sync_id).includes("dispute"));
const net = (db) => ledger(db).reduce((s, r) => s + Number(r.amount || 0), 0);
const job = (db) => db.tables.jobs.find((r) => r.sync_id === JOB);

/* The marker the canary replaces: the condition the fix added. Kept in one
   constant so a reword of the code is a loud failure in load(), not a canary
   that silently stops testing anything. */
const GUARD = 'if (state === "WON" && disputeDebit) {';

// ======================================================================= //

test("OPEN -> WON writes NOTHING: there was no debit to reverse", async () => {
  const db = seed();

  await post(load({ db }), disputeEvent("OPEN"));
  const afterOpen = net(db);
  await post(load({ db }), disputeEvent("WON"));

  assert.equal(disputeRows(db).length, 0,
    "a credit was booked against a debit that never happened -- $5,000 won read as " +
    "$10,000 collected");
  assert.equal(net(db), afterOpen, "the books are exactly where OPEN left them");
  assert.equal(net(db), 5000, "still the one real $5,000 payment, and no more");
});

test("OPEN -> LOST -> WON nets to zero: the debit is reversed, once", async () => {
  const db = seed();

  await post(load({ db }), disputeEvent("OPEN"));
  await post(load({ db }), disputeEvent("LOST"));
  assert.equal(net(db), 0, "LOST takes the money back off the books");

  await post(load({ db }), disputeEvent("WON"));

  assert.equal(net(db), 5000, "WON puts back exactly what LOST took");
  assert.equal(disputeRows(db).length, 2, "one debit, one credit, and nothing else");
});

test("a redelivered WON does not credit twice", async () => {
  const db = seed();
  await post(load({ db }), disputeEvent("LOST"));
  await post(load({ db }), disputeEvent("WON"));
  await post(load({ db }), disputeEvent("WON"));

  assert.equal(net(db), 5000);
  assert.equal(disputeRows(db).filter((r) => Number(r.amount) > 0).length, 1,
    "the credit is keyed on the dispute id, so a replay is one row");
});

test("the dispute is still RECORDED on the job even when nothing is booked", async () => {
  // The fix must not make an un-debited WON invisible. The dispute columns are
  // written before any of this, and they stay written.
  const db = seed();
  await post(load({ db }), disputeEvent("WON"));

  assert.equal(job(db).dispute_status, "WON");
  assert.equal(job(db).dispute_amount, 5000);
  assert.ok(job(db).dispute_closed_at, "a terminal state closes it");
  assert.equal(disputeRows(db).length, 0, "recorded, but not booked");
});

test("a failed lookup is not an absent debit", async () => {
  // The failure this project keeps meeting: an empty answer reading as good
  // news. If the check for the debit cannot be run, the handler must not
  // conclude there was none -- it must fail and let Square retry.
  const db = seed();
  await post(load({ db }), disputeEvent("LOST"));
  const before = net(db);

  db.fail["payment_records:select"] = "planted: the database is unavailable";
  const r = await post(load({ db }), disputeEvent("WON"));

  assert.equal(r.status, 500,
    "an outage must answer 500 so Square retries, not 200 with the money left off");
  assert.equal(net(db), before, "and nothing was written on the way out");
});

test("CANARY: the old unconditional credit books money that was never taken", async () => {
  const db = seed();
  const r = await post(load({
    db,
    // The guard removed -- the branch exactly as it stood before 20 Nov 2026.
    plant: { [GUARD]: 'if (state === "WON") {' },
  }), disputeEvent("WON"));

  assert.equal(r.status, 200, r.text);
  assert.equal(disputeRows(db).length, 1,
    "CANARY FAILED TO BITE: the old branch was supposed to write a phantom credit");
  assert.equal(net(db), 10000,
    "CANARY FAILED TO BITE: $5,000 collected should have read as $10,000");
});

test("CONTROL: the harness really reaches the dispute path", async () => {
  // Without this, every assertion above could be passing because the event
  // never got past the signature check or the merchant lookup, and an
  // un-booked credit would be indistinguishable from an un-run handler.
  const db = seed();
  const r = await post(load({ db }), disputeEvent("LOST"));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.text, "dispute recorded", "the handler answered from the dispute branch");
  assert.equal(disputeRows(db).length, 1, "and it really wrote the debit");
  assert.equal(job(db).dispute_status, "LOST");
});
