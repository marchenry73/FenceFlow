// A4 audit -- card fees and the money that actually moves.
//
// Domain: create-payment-link, create-checkout-session, stripe-webhook,
// stripe-connect, square-webhook. Read-only review; this file is the only
// thing it may create.
//
// This runs the REAL stripe-webhook function file, not a copy of its rules.
// The TypeScript is stripped with Node's own stripper, its two shared
// imports are swapped for the REAL _shared/record-payment.ts and
// _shared/push-recipients.ts modules, and Deno.serve hands the real request
// handler to this file -- so every case below is a real signed HTTP POST
// through the real signature-verification code, the way Stripe calls it.
// Nothing here touches the network, a database, or a real key: FIREBASE_
// SERVICE_ACCOUNT is left unset, so every push notification branch returns
// before it would ever call fetch, and any OTHER fetch is a test failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createHmac } from "node:crypto";
import * as recordPayment from "../supabase/functions/_shared/record-payment.ts";
import * as pushRecipients from "../supabase/functions/_shared/push-recipients.ts";

const FN_PATH = new URL("../supabase/functions/stripe-webhook/index.ts", import.meta.url);
const SECRET = "whsec_test_placeholder";
const COMPANY = "c0000000-0000-4000-8000-000000000001";

const baseEnv = {
  STRIPE_WEBHOOK_SECRET: SECRET,
  SUPABASE_URL: "https://project.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
  // FIREBASE_SERVICE_ACCOUNT deliberately absent: every notify* function
  // reads it first and returns immediately when it is unset, before ever
  // calling fetch. If that stops being true this harness's fetchImpl below
  // throws instead of silently doing a real network call.
};

// ---------------------------------------------------------------- harness --

/**
 * Loads the real function against the given fakes.
 *
 * `patch` does a plain string replacement on the stripped source before it
 * runs, to put a proposed fix in place and prove an assertion below actually
 * depends on the bug being present (see the canary test). It asserts the
 * target text still exists first, so a rewrite of the file makes the canary
 * fail loudly instead of silently passing on text that is no longer there.
 */
function load({ env = {}, db, fetchImpl = async (url) => { throw new Error("unexpected fetch: " + url); }, patch } = {}) {
  const src = readFileSync(FN_PATH, "utf8");
  let js = stripTypeScriptTypes(src);
  if (patch) {
    assert.ok(js.includes(patch.from), "nothing to plant over -- the source text this canary targets is gone");
    js = js.replace(patch.from, patch.to);
  }
  // Only createClient from supabase-js, and names from the REAL shared
  // modules -- nothing else. An import from anywhere else means the harness
  // no longer describes the file, and a quiet pass would be a lie.
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
  const sharedNames = Object.keys(shared);
  let handler = null;
  const Deno = {
    env: { get: (k) => env[k] },
    serve: (h) => { handler = h; },
  };
  new Function("Deno", "createClient", "fetch", ...sharedNames, js)(
    Deno, () => db, fetchImpl, ...sharedNames.map((n) => shared[n]),
  );
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

/** An in-memory stand-in for the service-role client. */
function fakeDb(tables) {
  const t = structuredClone(tables);
  let seq = 0;
  class Query {
    constructor(table) { this.table = table; this.op = "select"; this.filters = []; this.lim = Infinity; }
    select() { return this; }
    eq(k, v) { this.filters.push((r) => String(r[k]) === String(v)); return this; }
    is(k, v) { this.filters.push((r) => (v === null ? (r[k] === null || r[k] === undefined) : r[k] === v)); return this; }
    order() { return this; }
    limit(n) { this.lim = n; return this; }
    insert(row) { this.op = "insert"; this.payload = row; return this; }
    update(patch) { this.op = "update"; this.payload = patch; return this; }
    upsert(row, opts) { this.op = "upsert"; this.payload = row; this.conflict = String(opts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean); return this; }
    maybeSingle() { this.mode = "maybe"; return this.run(); }
    single() { this.mode = "one"; return this.run(); }
    then(ok, bad) { return this.run().then(ok, bad); }
    async run() {
      const rows = (t[this.table] ??= []);
      if (this.op === "upsert") {
        const key = this.conflict.length ? this.conflict : Object.keys(this.payload);
        const existing = rows.find((r) => key.every((k) => String(r[k]) === String(this.payload[k])));
        if (existing) Object.assign(existing, this.payload);
        else rows.push({ id: `new-${++seq}`, ...this.payload });
        return { data: null, error: null };
      }
      if (this.op === "insert") {
        rows.push({ id: `new-${++seq}`, ...this.payload });
        return { data: null, error: null };
      }
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") {
        hit.forEach((r) => Object.assign(r, this.payload));
        return { data: null, error: null };
      }
      const out = hit.slice(0, this.lim);
      if (this.mode === "maybe") return { data: out[0] ?? null, error: null };
      if (this.mode === "one") return out[0] ? { data: out[0], error: null } : { data: null, error: { message: "no row" } };
      return { data: out, error: null };
    }
  }
  return { tables: t, from: (table) => new Query(table), rpc: async () => ({ data: true, error: null }) };
}

const row = (db, table, id) => db.tables[table]?.find((r) => r.id === id);
const jobBySync = (db, syncId) => db.tables.jobs?.find((r) => r.sync_id === syncId);

function mkEvent(type, obj) {
  return { id: "evt_" + Math.random().toString(36).slice(2), type, livemode: true, data: { object: obj } };
}

/** Signs and POSTs a Stripe event body exactly as verify() checks it. */
async function post(handler, body) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex");
  const res = await handler(new Request("https://fn.test/stripe-webhook", {
    method: "POST",
    headers: { "stripe-signature": `t=${t},v1=${mac}` },
    body: raw,
  }));
  return { status: res.status, text: await res.text() };
}

// --------------------------------------------------- the proved hole ------
//
// checkout.session.completed fires for BOTH synchronous card payments AND
// asynchronous methods (ACH/US bank debit, SEPA, Cash App Pay, "pay by
// bank", ...) that Stripe will accept on a Payment Link whenever the
// connected account has them turned on -- create-payment-link's POST to
// /v1/payment_links sets no payment_method_types, so it inherits whatever
// the Stripe Dashboard's Payment Methods settings allow. For those methods
// Stripe's own documentation is explicit: the session's payment_status is
// "unpaid" at the moment checkout.session.completed fires, and the actual
// result arrives later as checkout.session.async_payment_succeeded or
// checkout.session.async_payment_failed.
//
// FIXED below (2026-09-28): the handler used to never read
// session.payment_status. It marked the job_payments row "paid" and
// credited the ledger on ANY checkout.session.completed for a known
// payment link, whether or not money had actually moved. It now credits
// only when payment_status is "paid" or "no_payment_required", waits on
// "unpaid" rather than dropping the request, and completes the credit from
// checkout.session.async_payment_succeeded once Stripe confirms the debit
// actually cleared -- see tests/a7-stripe-async-payment-status.test.mjs for
// the full before/after proof (failing against the pre-fix source, passing
// against this one) and the conservative handling of a row this bug had
// already credited wrongly before the fix shipped.

test("positive control: a synchronous card payment (payment_status: paid) is credited once, correctly", async () => {
  const db = fakeDb({
    jobs: [{ id: "job-row-A", sync_id: "JOB-A", company_id: COMPANY, customer_name: "Pat", deposit_amount: 0 }],
    job_payments: [{ id: "jp-A", company_id: COMPANY, job_sync_id: "JOB-A", status: "pending", livemode: true, stripe_id: "plink_A", amount_cents: 50000 }],
    payment_records: [],
  });
  const handler = load({ env: baseEnv, db });
  const r = await post(handler, mkEvent("checkout.session.completed", {
    mode: "payment", payment_link: "plink_A", payment_intent: "pi_A", payment_status: "paid",
  }));
  assert.equal(r.status, 200, r.text);
  assert.equal(row(db, "job_payments", "jp-A").status, "paid");
  assert.equal(jobBySync(db, "JOB-A").amount_paid, 500, "a $500.00 card payment credits exactly $500.00");
  assert.equal(db.tables.payment_records.length, 1);

  // Stripe retries a webhook it is unsure was received. The exact same event
  // delivered a second time must not double the job's paid figure.
  const replay = await post(handler, mkEvent("checkout.session.completed", {
    mode: "payment", payment_link: "plink_A", payment_intent: "pi_A", payment_status: "paid",
  }));
  assert.equal(replay.status, 200, replay.text);
  assert.equal(jobBySync(db, "JOB-A").amount_paid, 500, "a replayed webhook must not double-count: still $500.00, not $1000.00");
  assert.equal(db.tables.payment_records.length, 1, "still exactly one ledger row, not two");
});

test("fixed: an UNPAID async-method session is left pending, not credited -- and a later failure can still mark it failed", async () => {
  // $500.00 deposit link, exactly as above, but this session reports
  // payment_status "unpaid" -- the shape Stripe sends for a delayed method
  // (e.g. ACH) whose result has not arrived yet.
  const db = fakeDb({
    jobs: [{ id: "job-row-B", sync_id: "JOB-B", company_id: COMPANY, customer_name: "Pat", deposit_amount: 0 }],
    job_payments: [{ id: "jp-B", company_id: COMPANY, job_sync_id: "JOB-B", status: "pending", livemode: true, stripe_id: "plink_B", amount_cents: 50000 }],
    payment_records: [],
  });
  const handler = load({ env: baseEnv, db });
  const r = await post(handler, mkEvent("checkout.session.completed", {
    mode: "payment", payment_link: "plink_B", payment_intent: "pi_B", payment_status: "unpaid",
  }));
  assert.equal(r.status, 200, r.text);
  assert.equal(row(db, "job_payments", "jp-B").status, "pending",
    "an unpaid async session must not be marked paid");
  assert.equal((jobBySync(db, "JOB-B").amount_paid ?? 0), 0,
    "nothing is credited to the job until Stripe actually confirms the money moved");
  assert.equal(db.tables.payment_records.length, 0, "no ledger row for money that has not arrived");

  // The debit bounces. Because nothing was wrongly credited, the failure
  // handler's existing guard now protects the RIGHT state: the request is
  // marked failed and the office is told, exactly as a synchronous decline
  // already worked.
  const fail = await post(handler, mkEvent("checkout.session.async_payment_failed", {
    mode: "payment", payment_link: "plink_B",
  }));
  assert.equal(fail.status, 200, fail.text);
  assert.equal(row(db, "job_payments", "jp-B").status, "failed",
    "the pending request is correctly marked failed once Stripe confirms it");
  assert.equal((jobBySync(db, "JOB-B").amount_paid ?? 0), 0, "still nothing collected -- correctly");
});

test("fixed: an UNPAID async-method session that later succeeds is credited exactly once, replay-safe", async () => {
  // Same shape, but this time Stripe confirms the debit cleared --
  // checkout.session.async_payment_succeeded, the event the pre-fix code
  // never handled at all because it credited everything up front.
  const db = fakeDb({
    jobs: [{ id: "job-row-D", sync_id: "JOB-D", company_id: COMPANY, customer_name: "Pat", deposit_amount: 0 }],
    job_payments: [{ id: "jp-D", company_id: COMPANY, job_sync_id: "JOB-D", status: "pending", livemode: true, stripe_id: "plink_D", amount_cents: 50000 }],
    payment_records: [],
  });
  const handler = load({ env: baseEnv, db });
  const unpaid = await post(handler, mkEvent("checkout.session.completed", {
    mode: "payment", payment_link: "plink_D", payment_intent: "pi_D", payment_status: "unpaid",
  }));
  assert.equal(unpaid.status, 200, unpaid.text);
  assert.equal(row(db, "job_payments", "jp-D").status, "pending", "still waiting, nothing lost");

  const cleared = await post(handler, mkEvent("checkout.session.async_payment_succeeded", {
    mode: "payment", payment_link: "plink_D", payment_intent: "pi_D",
  }));
  assert.equal(cleared.status, 200, cleared.text);
  assert.equal(row(db, "job_payments", "jp-D").status, "paid", "now credited -- Stripe confirmed the money arrived");
  assert.equal(jobBySync(db, "JOB-D").amount_paid, 500, "a real payment must not go missing while it waits");
  assert.equal(db.tables.payment_records.length, 1);

  // Stripe redelivers the same confirmation. Must not double-count.
  const replay = await post(handler, mkEvent("checkout.session.async_payment_succeeded", {
    mode: "payment", payment_link: "plink_D", payment_intent: "pi_D",
  }));
  assert.equal(replay.status, 200, replay.text);
  assert.equal(jobBySync(db, "JOB-D").amount_paid, 500, "replayed confirmation: still $500.00, not $1000.00");
  assert.equal(db.tables.payment_records.length, 1, "still exactly one ledger row");
});

test("second half, conservative: a row this bug already credited wrongly is NOT auto-reversed on the later failure", async () => {
  // Seeds a job_payments row already "paid" the way the pre-fix code could
  // produce one (or the way a race could still, in principle) -- and then
  // delivers the async failure Stripe sends when that same link's debit
  // never actually arrives. The owner's instruction: an automatic reversal
  // that fires wrongly is worse than a flag a human clears, so the ledger
  // and the job's paid figure must be untouched -- see
  // supabase_stripe_async_reversal_review.sql for the schema change and
  // decision a real fix for this half would need.
  const db = fakeDb({
    jobs: [{ id: "job-row-E", sync_id: "JOB-E", company_id: COMPANY, customer_name: "Pat", deposit_amount: 0, amount_paid: 500 }],
    job_payments: [{ id: "jp-E", company_id: COMPANY, job_sync_id: "JOB-E", status: "paid", livemode: true, stripe_id: "plink_E", amount_cents: 50000 }],
    payment_records: [{ id: "pr-E", company_id: COMPANY, job_sync_id: "JOB-E", amount: 500, sync_id: "stripe-jp-E" }],
  });
  const handler = load({ env: baseEnv, db });
  const fail = await post(handler, mkEvent("checkout.session.async_payment_failed", {
    mode: "payment", payment_link: "plink_E",
  }));
  assert.equal(fail.status, 200, fail.text);
  assert.equal(row(db, "job_payments", "jp-E").status, "paid",
    "not silently relabelled -- a status flip with no ledger entry to match it would be worse than leaving it");
  assert.equal(jobBySync(db, "JOB-E").amount_paid, 500,
    "no automatic reversal: the ledger is a call for a person, not this handler, per the owner's rule");
  assert.equal(db.tables.payment_records.length, 1, "the ledger row from the wrongful credit is left exactly as it was");
});

test("canary: with the payment_status guard removed, the same unpaid session is credited again", async () => {
  // Plants the ORIGINAL bug back into the current, fixed source and proves
  // the "fixed" tests above are not vacuous -- they really do depend on
  // this guard, not on some other accident of the fake db.
  const FROM =
    'if (paymentStatus === "paid" || paymentStatus === "no_payment_required") {\n' +
    '              await creditPaymentLink(admin, session);\n' +
    '            } else if (paymentStatus !== "unpaid") {';
  const TO =
    'if (true) {\n' +
    '              await creditPaymentLink(admin, session);\n' +
    '            } else if (paymentStatus !== "unpaid") {';
  const db = fakeDb({
    jobs: [{ id: "job-row-C", sync_id: "JOB-C", company_id: COMPANY, customer_name: "Pat", deposit_amount: 0 }],
    job_payments: [{ id: "jp-C", company_id: COMPANY, job_sync_id: "JOB-C", status: "pending", livemode: true, stripe_id: "plink_C", amount_cents: 50000 }],
    payment_records: [],
  });
  const handler = load({ env: baseEnv, db, patch: { from: FROM, to: TO } });
  const assertCorrectlyLeftPending = async () => {
    const r = await post(handler, mkEvent("checkout.session.completed", {
      mode: "payment", payment_link: "plink_C", payment_intent: "pi_C", payment_status: "unpaid",
    }));
    assert.equal(r.status, 200, r.text);
    assert.equal(row(db, "job_payments", "jp-C").status, "pending", "planted-bug version wrongly credits it");
  };
  await assert.rejects(assertCorrectlyLeftPending, assert.AssertionError);
  // And confirm directly what the planted bug actually does: credits it,
  // exactly like the pre-fix code did.
  assert.equal(row(db, "job_payments", "jp-C").status, "paid", "the bug, replanted, reproduces exactly");
  assert.equal(jobBySync(db, "JOB-C").amount_paid, 500, "and wrongly credits the job again");
});

// ------------------------------------------------ everything else, clean --
//
// Every OTHER money path this domain covers was checked and found
// consistent, not just left alone:
//
//  * cents/currency conversion: create-payment-link, create-checkout-session
//    and the Stripe side of stripe-webhook work in cents throughout with no
//    conversion step to get backwards; Square's webhook and both refund/
//    dispute paths route through minorToMajor(), which is exercised by the
//    existing card-fee.test.mjs and by this file's positive control.
//  * replayed/duplicate webhooks: refund.created/refund.updated and every
//    dispute event key their ledger upsert on the processor's OWN id
//    (`${processor}-refund-${refundId}`, `dispute-${dispute.id}`, or, for a
//    cleared job payment, "stripe-" + the job_payments row's own stable id)
//    with onConflict on (company_id, sync_id) -- a retry overwrites the same
//    row with the same numbers rather than adding a second one. Proved above:
//    the positive-control test posts once and gets exactly one ledger row;
//    the same event replayed would upsert onto that same row again.
//  * the fee itself: create-payment-link hardcodes `stripeFee = 0` for every
//    job payment link (line ~684) -- grep confirms cardFeeCents() has no
//    caller anywhere in the codebase, so "added consistently or not at all"
//    resolves to "not at all", consistently, for every link. (The dead
//    function is still covered by tests/card-fee.test.mjs, which is honest
//    about testing arithmetic that no live code path invokes -- worth
//    knowing, not itself a money bug.)
test("card-fee note: cardFeeCents has no caller -- the 3%-capped fee is dead code, not a live inconsistency", () => {
  const src = readFileSync(new URL("../supabase/functions/create-payment-link/index.ts", import.meta.url), "utf8");
  const calls = [...src.matchAll(/\bcardFeeCents\s*\(/g)];
  // Exactly one occurrence: `export function cardFeeCents(amountCents...` --
  // its own definition, never called.
  assert.equal(calls.length, 1, "cardFeeCents is called somewhere outside its own definition");
  assert.match(src, /const stripeFee = 0;/, "the fee sent to Stripe for a job payment link is hardcoded to zero");
});
