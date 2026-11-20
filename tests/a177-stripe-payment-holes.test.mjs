/**
 * FOUR WAYS STRIPE MONEY COULD ARRIVE AND NOT BE BOOKED.
 *
 *     node --test tests/a177-stripe-payment-holes.test.mjs
 *
 * ------------------------------------------------------------------
 * WHAT THIS IS
 * ------------------------------------------------------------------
 * The A4 money audit (19/20 Nov 2026, written up in OVERNIGHT_2026-11-19.md)
 * found four holes in the Stripe path. None of them had ever fired, because
 * no live card payment had ever completed through this system -- every `paid`
 * row in job_payments was livemode=false. They were latent, and the campaign
 * that starts 24 Nov exists to produce customers who pay by card.
 *
 *   #1 A SECOND PAYMENT ON THE SAME LINK. Payment Links were reusable and
 *      nothing deactivated one after it was paid, so a customer could reopen
 *      the emailed link and pay again. The webhook's idempotency guard read
 *      the second checkout as a duplicate delivery and answered 200 in
 *      silence: Stripe held $4,000, the books said $2,000, nobody was told.
 *
 *   #2 A WRITE FAILURE MADE STRIPE'S RETRY SKIP THE MONEY. creditPaymentLink
 *      set status="paid" FIRST, did not check that write, and only then
 *      booked. The handler answers 500 on a throw and Stripe retries a 500 --
 *      but the retry met `status !== "paid"` and fell through. Taken, never
 *      booked. The file's own comment called retrying safe; it is safe only
 *      if the flip comes last.
 *
 *   #3 THE OFF-SESSION CHARGE COULD LOSE A RACE WITH ITS OWN WEBHOOK.
 *      create-payment-link confirms the PaymentIntent and only THEN inserts
 *      the pending row, so payment_intent.succeeded can genuinely arrive
 *      first. It filtered on status="pending", so "already banked" and "no
 *      row at all" came back identically as null -- and both broke with 200.
 *
 *   #5 PAYMENT STATUS WALKED BACKWARDS. This file's applyPaymentToJob wrote a
 *      flat "DEPOSIT_PAID", so a $50 payment on a job already PAID_IN_FULL
 *      stepped it back, and a final balance payment left a settled job
 *      reading DEPOSIT_PAID.
 *
 * ------------------------------------------------------------------
 * HOW IT TESTS THEM
 * ------------------------------------------------------------------
 * By running the REAL function file, not a model of its rules: the harness
 * (recipe from a128) strips the TypeScript with Node's own stripper, swaps
 * the two imports for a fake Supabase client and the REAL shared
 * record-payment module, and takes the handler Deno.serve is given. Every
 * case below is a real signed HTTP request through the real door.
 *
 * Each defect has its canary: `plant` puts the old code back and the test
 * asserts it goes red. A fix with no canary is a fix nobody has watched fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createHmac } from "node:crypto";
import * as recordPayment from "../supabase/functions/_shared/record-payment.ts";
import * as pushRecipients from "../supabase/functions/_shared/push-recipients.ts";

const FN_PATH = new URL("../supabase/functions/stripe-webhook/index.ts", import.meta.url);
const SRC = readFileSync(FN_PATH, "utf8");

const SECRET = "whsec_live_endpoint_placeholder";
const COMPANY = "c0000000-0000-4000-8000-000000000001";
const JOB = "JOB-1";

const ENV = {
  STRIPE_WEBHOOK_SECRET: SECRET,
  SUPABASE_URL: "https://project.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
  // FIREBASE_SERVICE_ACCOUNT and NOTIFY_TRIGGER_SECRET deliberately absent:
  // every notify* helper and askForReceipt read them first and return before
  // reaching fetch, so the throwing fetch below is never called. If that stops
  // being true this file fails loudly rather than touching the network.
};

// ---------------------------------------------------------------- harness --

function load({ db, plant = {} } = {}) {
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

  /* A plant must land on a function that really exists, so a rename can never
     turn a canary into a quiet no-op -- the GREEN-canary trap. */
  const planted = Object.entries(plant).map(([name, body]) => {
    assert.match(js, new RegExp(`^(async )?function ${name}\\(`, "m"),
      `nothing called ${name} to plant over -- the canary would prove nothing`);
    return `${name} = ${body};`;
  }).join("\n");

  const names = Object.keys(shared);
  let handler = null;
  const Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
  new Function("Deno", "createClient", "fetch", ...names, js + "\n" + planted)(
    Deno, () => db,
    async (u) => { throw new Error("unexpected fetch: " + u); },
    ...names.map((n) => shared[n]),
  );
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

/**
 * In-memory service-role client. a128's fakeDb, plus the two things these
 * cases need: an insert that can return the row it wrote (`.select()` after
 * `.insert()`), and `fail` so one named write can be made to fail the way an
 * outage or a constraint would.
 */
function fakeDb(tables) {
  const t = structuredClone(tables);
  const fail = {};
  const log = [];
  let seq = 0;
  class Query {
    constructor(table) {
      this.table = table; this.op = "select"; this.filters = []; this.lim = Infinity; this.returning = false;
    }
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
      if (planted) { log.push([this.table, this.op, "FAILED"]); return { data: null, error: { message: planted } }; }
      const rows = (t[this.table] ??= []);
      if (this.op === "upsert") {
        const key = this.conflict.length ? this.conflict : Object.keys(this.payload);
        const existing = rows.find((r) => key.every((k) => String(r[k]) === String(this.payload[k])));
        if (existing) Object.assign(existing, this.payload);
        else rows.push({ id: `new-${++seq}`, ...this.payload });
        log.push([this.table, "upsert", this.payload.sync_id ?? ""]);
        return { data: null, error: null };
      }
      if (this.op === "insert") {
        /* The partial unique index on (processor, external_id) -- modelled,
           because one of these cases turns on a collision really happening. */
        if (this.table === "job_payments" && this.payload.external_id) {
          const clash = rows.find((r) => r.processor === this.payload.processor &&
            String(r.external_id ?? "") === String(this.payload.external_id));
          if (clash) return { data: null, error: { message: "duplicate key value violates unique constraint \"job_payments_processor_external_uidx\"", code: "23505" } };
        }
        const made = { id: `new-${++seq}`, ...this.payload };
        rows.push(made);
        log.push([this.table, "insert", made.id]);
        return { data: this.returning ? (this.mode === "maybe" ? made : [made]) : null, error: null };
      }
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") {
        hit.forEach((r) => Object.assign(r, this.payload));
        log.push([this.table, "update", JSON.stringify(this.payload)]);
        return { data: this.returning ? hit : null, error: null };
      }
      const out = hit.slice(0, this.lim);
      if (this.mode === "maybe") return { data: out[0] ?? null, error: null };
      if (this.mode === "one") return out[0] ? { data: out[0], error: null } : { data: null, error: { message: "no row" } };
      return { data: out, error: null };
    }
  }
  return {
    tables: t, fail, log,
    from: (table) => new Query(table),
    rpc: async () => ({ data: true, error: null }),
  };
}

function seed({ job = {}, payments = [] } = {}) {
  return fakeDb({
    jobs: [{
      id: "job-row-1", sync_id: JOB, company_id: COMPANY, customer_name: "Pat",
      deposit_amount: 0, contract_total: 1000, refunded_amount: 0,
      payment_status: "UNPAID", amount_paid: 0, ...job,
    }],
    job_payments: payments,
    payment_records: [],
    devices: [],
    profiles: [],
  });
}

const pending = (over = {}) => ({
  id: "jp-1", company_id: COMPANY, job_sync_id: JOB, status: "pending",
  livemode: true, stripe_id: "plink_1", external_id: "", processor: "stripe",
  amount_cents: 50000, kind: "deposit", currency: "usd", ...over,
});

async function post(handler, event) {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex");
  const res = await handler(new Request("https://fn.test/stripe-webhook", {
    method: "POST", headers: { "stripe-signature": `t=${t},v1=${sig}` }, body: raw,
  }));
  return { status: res.status, text: await res.text() };
}

const sessionPaid = (over = {}) => ({
  id: "cs_1", object: "checkout.session", mode: "payment", payment_status: "paid",
  payment_link: "plink_1", payment_intent: "pi_first", amount_total: 50000,
  livemode: true, currency: "usd", metadata: { company_id: COMPANY }, ...over,
});

const completed = (session) => ({
  id: "evt_" + Math.random().toString(36).slice(2),
  type: "checkout.session.completed", livemode: true, data: { object: session },
});

const intentSucceeded = (over = {}) => ({
  id: "evt_" + Math.random().toString(36).slice(2),
  type: "payment_intent.succeeded", livemode: true,
  data: {
    object: {
      id: "pi_offsession", amount: 80000, amount_received: 80000, currency: "usd",
      livemode: true,
      metadata: { off_session: "true", job_sync_id: JOB, company_id: COMPANY, kind: "balance" },
      ...over,
    },
  },
});

const ledger = (db) => db.tables.payment_records ?? [];
const ledgerTotal = (db) => ledger(db).reduce((s, r) => s + Number(r.amount || 0), 0);
const theJob = (db) => db.tables.jobs.find((r) => r.sync_id === JOB);

// ------------------------------------------------------------------ #2 ----
// A WRITE FAILURE ON "MARK PAID" MUST NOT MAKE THE RETRY SKIP THE MONEY.

test("#2 a failed booking leaves the request UNPAID, so Stripe's retry books it", async () => {
  const db = seed({ payments: [pending()] });

  // First delivery: the ledger write fails the way an outage would.
  db.fail["payment_records:upsert"] = "planted: the ledger is unavailable";
  const first = await post(load({ db }), completed(sessionPaid()));

  assert.equal(first.status, 500,
    "a booking that could not be written must answer 500, because Stripe retries a 500");
  assert.equal(db.tables.job_payments[0].status, "pending",
    "THE WHOLE DEFECT: the request was flipped to paid although nothing was booked, " +
    "so the retry below would find it already paid and skip the money");
  assert.equal(ledger(db).length, 0, "nothing should be in the ledger yet");

  // Stripe retries. This time the write works.
  delete db.fail["payment_records:upsert"];
  const retry = await post(load({ db }), completed(sessionPaid()));

  assert.equal(retry.status, 200);
  assert.equal(ledger(db).length, 1, "the retry must book the money");
  assert.equal(ledgerTotal(db), 500, "$500, once");
  assert.equal(db.tables.job_payments[0].status, "paid");
  assert.equal(theJob(db).amount_paid, 500);
});

test("#2 CANARY: the old order (flip first) loses the money on the retry", async () => {
  const db = seed({ payments: [pending()] });
  /* The function as it stood before 20 Nov 2026: status flipped first, the
     update's result ignored, booking second. */
  const old = `async function (admin, session) {
    const linkId = session.payment_link;
    if (!linkId) return;
    const { data: p } = await admin.from("job_payments")
      .select("id, job_sync_id, amount_cents, company_id, status, livemode, stripe_id")
      .eq("stripe_id", linkId).maybeSingle();
    if (p && p.status !== "paid") {
      await admin.from("job_payments").update({
        status: "paid", paid_at: new Date().toISOString(),
        external_id: String(session.payment_intent ?? ""),
      }).eq("id", p.id);
      await applyPaymentToJob(admin, p);
    }
  }`;

  db.fail["payment_records:upsert"] = "planted: the ledger is unavailable";
  await post(load({ db, plant: { creditPaymentLink: old } }), completed(sessionPaid()));
  delete db.fail["payment_records:upsert"];
  await post(load({ db, plant: { creditPaymentLink: old } }), completed(sessionPaid()));

  assert.equal(db.tables.job_payments[0].status, "paid");
  assert.equal(ledger(db).length, 0,
    "CANARY FAILED TO BITE: the old order was supposed to lose the payment, and did not. " +
    "Either the harness is not reaching the planted function or the model db is too kind.");
});

test("#2 the off-session branch books before it flips, for the same reason", async () => {
  const db = seed({
    payments: [pending({ id: "jp-2", external_id: "pi_offsession", stripe_id: null, amount_cents: 80000 })],
  });

  db.fail["payment_records:upsert"] = "planted: the ledger is unavailable";
  const first = await post(load({ db }), intentSucceeded());
  assert.equal(first.status, 500);
  assert.equal(db.tables.job_payments[0].status, "pending",
    "flipped to paid on a booking that failed -- the retry filters on it and would skip");

  delete db.fail["payment_records:upsert"];
  await post(load({ db }), intentSucceeded());
  assert.equal(ledgerTotal(db), 800, "$800, booked once");
  assert.equal(db.tables.job_payments[0].status, "paid");
});

// ------------------------------------------------------------------ #1 ----
// A SECOND PAYMENT ON A LINK ALREADY PAID IS RECORDED, NOT SWALLOWED.

test("#1 a second checkout on a paid link is recorded and booked", async () => {
  const db = seed({ payments: [pending({ status: "paid", external_id: "pi_first" })] });

  const r = await post(load({ db }), completed(sessionPaid({
    id: "cs_2", payment_intent: "pi_second", amount_total: 50000,
  })));

  assert.equal(r.status, 200);
  const extra = db.tables.job_payments.find((p) => p.external_id === "pi_second");
  assert.ok(extra, "the second payment must exist as its own request row, not vanish");
  assert.equal(extra.status, "paid");
  assert.equal(ledger(db).length, 1, "the second payment is in the ledger");
  assert.equal(ledgerTotal(db), 500);
  assert.equal(theJob(db).amount_paid, 500,
    "the job must show the money, so somebody can see the overpayment and refund it");
});

test("#1 a REDELIVERY of the same session is still silent -- the intent is the discriminator", async () => {
  const db = seed({ payments: [pending({ status: "paid", external_id: "pi_first" })] });

  await post(load({ db }), completed(sessionPaid({ payment_intent: "pi_first" })));

  assert.equal(db.tables.job_payments.length, 1, "no second row for the same payment");
  assert.equal(ledger(db).length, 0, "nothing booked twice");
});

test("#1 a redelivery of the SECOND payment books it once, not twice", async () => {
  const db = seed({ payments: [pending({ status: "paid", external_id: "pi_first" })] });
  const second = completed(sessionPaid({ id: "cs_2", payment_intent: "pi_second" }));

  await post(load({ db }), second);
  await post(load({ db }), second);

  assert.equal(db.tables.job_payments.filter((p) => p.external_id === "pi_second").length, 1);
  assert.equal(ledger(db).length, 1);
  assert.equal(ledgerTotal(db), 500, "$500 once, however many times Stripe delivers it");
});

test("#1 CANARY: the old guard swallowed the second payment", async () => {
  const db = seed({ payments: [pending({ status: "paid", external_id: "pi_first" })] });
  const old = `async function (admin, session) {
    const linkId = session.payment_link;
    if (!linkId) return;
    const { data: p } = await admin.from("job_payments")
      .select("id, job_sync_id, amount_cents, company_id, status, livemode, stripe_id")
      .eq("stripe_id", linkId).maybeSingle();
    if (p && p.status !== "paid") { await applyPaymentToJob(admin, p); }
  }`;

  const r = await post(load({ db, plant: { creditPaymentLink: old } }),
    completed(sessionPaid({ id: "cs_2", payment_intent: "pi_second" })));

  assert.equal(r.status, 200, "and that 200 was the problem");
  assert.equal(ledger(db).length, 0,
    "CANARY FAILED TO BITE: the old guard was supposed to swallow the second payment");
});

// ------------------------------------------------------------------ #3 ----
// THE OFF-SESSION CHARGE THAT BEAT ITS OWN PENDING ROW.

test("#3 payment_intent.succeeded with no pending row books from the intent's metadata", async () => {
  const db = seed({ payments: [] });  // create-payment-link has not inserted yet

  const r = await post(load({ db }), intentSucceeded());

  assert.equal(r.status, 200);
  const made = db.tables.job_payments.find((p) => p.external_id === "pi_offsession");
  assert.ok(made, "the charge must be recorded from the event rather than dropped");
  assert.equal(made.status, "paid");
  assert.equal(ledgerTotal(db), 800, "$800 booked");
  assert.equal(theJob(db).amount_paid, 800);
});

test("#3 an intent that is NOT ours is still left alone", async () => {
  const db = seed({ payments: [] });
  // No off_session flag: somebody else's PaymentIntent on the same account.
  await post(load({ db }), intentSucceeded({ metadata: { job_sync_id: JOB, company_id: COMPANY } }));
  assert.equal(db.tables.job_payments.length, 0, "nothing invented for a charge that is not ours");
  assert.equal(ledger(db).length, 0);
});

test("#3 ours but with no ids in the metadata is left alone rather than guessed at", async () => {
  const db = seed({ payments: [] });
  await post(load({ db }), intentSucceeded({ metadata: { off_session: "true" } }));
  assert.equal(db.tables.job_payments.length, 0);
  assert.equal(ledger(db).length, 0);
});

test("#3 a row that is already paid is still a redelivery, and does nothing", async () => {
  const db = seed({
    payments: [pending({ id: "jp-3", status: "paid", external_id: "pi_offsession", stripe_id: null, amount_cents: 80000 })],
  });
  await post(load({ db }), intentSucceeded());
  assert.equal(db.tables.job_payments.length, 1);
  assert.equal(ledger(db).length, 0, "an already-banked charge must not be booked again");
});

test("#3 CANARY: with the metadata fallback gone, the raced charge is dropped again", async () => {
  const db = seed({ payments: [] });
  /* The old branch's whole effect on this case was to find nothing and break.
     Planted by making the new recorder answer the way "no row" used to --
     null -- which sends the handler straight back down the old path. */
  const r = await post(load({
    db,
    plant: { recordUnexpectedStripePayment: "async function () { return null; }" },
  }), intentSucceeded());

  assert.equal(r.status, 200, "and the 200 is what stopped Stripe retrying");
  assert.equal(db.tables.job_payments.length, 0,
    "CANARY FAILED TO BITE: the raced charge was supposed to be dropped");
  assert.equal(ledger(db).length, 0,
    "CANARY FAILED TO BITE: nothing should have been booked without the fallback");
});

// ------------------------------------------------------------------ #5 ----
// THE STATUS LADDER: UP, OR NOT AT ALL.

test("#5 a small payment on a PAID_IN_FULL job does not step it backwards", async () => {
  const db = seed({
    job: { contract_total: 1000, payment_status: "PAID_IN_FULL", amount_paid: 1000 },
    payments: [pending({ amount_cents: 5000 })],
  });

  await post(load({ db }), completed(sessionPaid({ amount_total: 5000 })));

  assert.equal(theJob(db).payment_status, "PAID_IN_FULL",
    "a $50 payment stepped a settled job back to DEPOSIT_PAID, and the office and " +
    "the quote page then told a settled customer she still owed money");
});

test("#5 a balance payment that covers the total reaches PAID_IN_FULL", async () => {
  const db = seed({
    job: { contract_total: 500, payment_status: "DEPOSIT_PAID", amount_paid: 0 },
    payments: [pending({ amount_cents: 50000 })],
  });

  await post(load({ db }), completed(sessionPaid()));

  assert.equal(theJob(db).amount_paid, 500);
  assert.equal(theJob(db).payment_status, "PAID_IN_FULL",
    "the server has the contract total and may say so; it used to write DEPOSIT_PAID flat");
});

test("#5 a job this server has never priced still lands on DEPOSIT_PAID", async () => {
  const db = seed({
    job: { contract_total: null, payment_status: "UNPAID", amount_paid: 0 },
    payments: [pending()],
  });

  await post(load({ db }), completed(sessionPaid()));

  assert.equal(theJob(db).payment_status, "DEPOSIT_PAID",
    "nothing changes for a job with no contract_total -- the phone still promotes it");
});

test("#5 CANARY: the flat DEPOSIT_PAID walked a settled job backwards", async () => {
  const db = seed({
    job: { contract_total: 1000, payment_status: "PAID_IN_FULL", amount_paid: 1000 },
    payments: [pending({ amount_cents: 5000 })],
  });
  /* applyPaymentToJob as it stood, reduced to the write that matters. */
  const old = `async function (admin, payment) {
    const { data: job } = await admin.from("jobs")
      .select("id, sync_id, company_id, customer_name, deposit_amount")
      .eq("company_id", payment.company_id).eq("sync_id", payment.job_sync_id).maybeSingle();
    if (payment.livemode !== true) return;
    await admin.from("payment_records").upsert({
      sync_id: "stripe-" + payment.id, company_id: payment.company_id,
      job_sync_id: payment.job_sync_id, amount: Number(payment.amount_cents || 0) / 100,
      method: "CARD", received_at: new Date().toISOString(),
      reference: String(payment.stripe_id ?? ""), note: "", recorded_by: "Stripe",
    }, { onConflict: "company_id,sync_id" });
    if (!job) return;
    await admin.from("jobs").update({
      amount_paid: 1050, payment_status: "DEPOSIT_PAID", payments_from_processor: true,
    }).eq("id", job.id);
  }`;

  await post(load({ db, plant: { applyPaymentToJob: old } }), completed(sessionPaid({ amount_total: 5000 })));

  assert.equal(theJob(db).payment_status, "DEPOSIT_PAID",
    "CANARY FAILED TO BITE: the flat write was supposed to walk the status backwards");
});

// --------------------------------------------------------------- ladder ----
// The decision itself, now that all three callers share one copy of it.

test("nextPaymentStatus: one ladder, and the direction is the only difference", () => {
  const { nextPaymentStatus } = recordPayment;
  assert.equal(typeof nextPaymentStatus, "function",
    "the shared ladder is gone; the three callers have drifted apart again");

  const up = (netPaid, contractTotal, current) =>
    nextPaymentStatus({ netPaid, contractTotal, current, direction: "up" });
  const down = (netPaid, contractTotal, current) =>
    nextPaymentStatus({ netPaid, contractTotal, current, direction: "down" });

  // Up may raise and must never lower.
  assert.equal(up(50, 1000, "UNPAID"), "DEPOSIT_PAID");
  assert.equal(up(1000, 1000, "DEPOSIT_PAID"), "PAID_IN_FULL");
  assert.equal(up(50, 1000, "PAID_IN_FULL"), "PAID_IN_FULL", "a payment may not un-settle a job");
  assert.equal(up(0, 1000, "DEPOSIT_PAID"), "DEPOSIT_PAID", "nor un-deposit one");

  // Down may lower and must never raise.
  assert.equal(down(0, 1000, "PAID_IN_FULL"), "UNPAID");
  assert.equal(down(500, 1000, "PAID_IN_FULL"), "DEPOSIT_PAID");
  assert.equal(down(1000, 1000, "DEPOSIT_PAID"), "DEPOSIT_PAID", "a refund may not settle a job");

  // No contract total: DEPOSIT_PAID is as far as it goes, in both directions.
  assert.equal(up(9999, 0, "UNPAID"), "DEPOSIT_PAID");
  assert.equal(down(9999, 0, "PAID_IN_FULL"), "DEPOSIT_PAID");

  // The half-cent tolerance both callers carried, kept.
  assert.equal(up(999.9999, 1000, "DEPOSIT_PAID"), "PAID_IN_FULL");
  assert.equal(up(0.001, 1000, "UNPAID"), "UNPAID", "a rounding crumb is not a deposit");

  // CONTROL: the ladder is a real comparison, not a function that answers the
  // same thing however it is asked.
  assert.notEqual(up(50, 1000, "UNPAID"), up(1000, 1000, "UNPAID"));
  assert.notEqual(up(0, 1000, "PAID_IN_FULL"), down(0, 1000, "PAID_IN_FULL"));
});
