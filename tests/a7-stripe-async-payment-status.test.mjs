// A7 -- stripe-webhook credited an async payment method before the money
// had actually moved.
//
// checkout.session.completed fires the instant Checkout finishes, and that
// is not the same moment for every payment method. A card charges
// synchronously, so payment_status is already "paid" by the time this event
// exists. An asynchronous method -- US bank account / ACH debit, SEPA
// Debit, Cash App Pay, and others Stripe may add -- reaches this SAME event
// the moment the customer submits their bank details, days before the debit
// can actually clear: payment_status is "unpaid" here, and Stripe's own
// docs are explicit that the real result arrives later as
// checkout.session.async_payment_succeeded or ...async_payment_failed:
// https://docs.stripe.com/payments/checkout/fulfill-orders#delayed-notification-payment-methods
//
// The handler never read payment_status. It marked the job_payments row
// "paid" and credited the ledger on ANY checkout.session.completed for a
// known payment link, whether or not money had actually moved -- and
// because the row already read "paid" by the time the failure event
// arrived, the failure handler's own "never overwrite a request that
// already cleared" guard threw the correction away instead of applying it.
//
// This runs the REAL stripe-webhook function file, not a copy of its
// rules -- see load() below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as recordPayment from "../supabase/functions/_shared/record-payment.ts";
import * as pushRecipients from "../supabase/functions/_shared/push-recipients.ts";

const ROOT = new URL("..", import.meta.url);
const FN_PATH = new URL("../supabase/functions/stripe-webhook/index.ts", import.meta.url);
const SECRET = "whsec_test_placeholder";
const COMPANY = "c0000000-0000-4000-8000-000000000001";

const baseEnv = {
  STRIPE_WEBHOOK_SECRET: SECRET,
  SUPABASE_URL: "https://project.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
  // FIREBASE_SERVICE_ACCOUNT deliberately absent: every notify* function
  // reads it first and returns before ever calling fetch. If that stops
  // being true this harness's fetchImpl below throws instead of silently
  // making a real network call.
};

// ---------------------------------------------------------------- harness --
// Same recipe as tests/a4-fees.test.mjs: strip the real TypeScript source,
// swap in the REAL shared modules, and hand Deno.serve's callback back as a
// plain request handler -- so this is a real signed HTTP POST through the
// real signature-verification code, the way Stripe calls it.

function loadSource(src, { env = {}, db, fetchImpl = async (url) => { throw new Error("unexpected fetch: " + url); } } = {}) {
  let js = stripTypeScriptTypes(src);
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

function load(opts) {
  return loadSource(readFileSync(FN_PATH, "utf8"), opts);
}

/** The committed version of the file before this fix, for the historical
 * proof below. Mirrors tests/money-push-audience.test.mjs's gitSrc() --
 * returns null (never throws) if git or that commit is unavailable, so a
 * clone without history skips the historical test instead of failing it. */
function preFixSource() {
  const r = spawnSync("git", ["show", "HEAD:supabase/functions/stripe-webhook/index.ts"],
    { encoding: "utf8", cwd: ROOT.pathname.replace(/^\/([A-Za-z]:)/, "$1") });
  if (r.status !== 0 || !r.stdout) return null;
  // Sanity: the pre-fix source must NOT already contain the fix's own
  // marker, or this "historical" source is actually the fixed one (e.g. the
  // fix was committed) and the proof below would be vacuous.
  if (r.stdout.includes("creditPaymentLink")) return null;
  return r.stdout;
}

/** An in-memory stand-in for the service-role client. Identical to
 * tests/a4-fees.test.mjs's fakeDb(). */
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

function seedDb(id) {
  return fakeDb({
    jobs: [{ id: `job-row-${id}`, sync_id: `JOB-${id}`, company_id: COMPANY, customer_name: "Pat", deposit_amount: 0 }],
    job_payments: [{ id: `jp-${id}`, company_id: COMPANY, job_sync_id: `JOB-${id}`, status: "pending", livemode: true, stripe_id: `plink_${id}`, amount_cents: 50000 }],
    payment_records: [],
  });
}

// ------------------------------------------------- the required test, ----
// -------------------------------------------- with teeth against history --

test("TEETH: an unpaid async-method session must not credit money -- proved to fail against the pre-fix source", async () => {
  const pre = preFixSource();
  if (!pre) {
    console.log("  (skipped the historical half: HEAD is not the pre-fix commit, or git is unavailable in this clone)");
    return;
  }
  const db = seedDb("HIST");
  const handler = loadSource(pre, { env: baseEnv, db });
  const r = await post(handler, mkEvent("checkout.session.completed", {
    mode: "payment", payment_link: "plink_HIST", payment_intent: "pi_HIST", payment_status: "unpaid",
  }));
  assert.equal(r.status, 200, r.text);
  // This is the failing assertion, run against the UNFIXED source, kept
  // here (rather than only in a passing form below) so a future change that
  // reintroduces the bug on the live file is caught the same way: by
  // actually crediting money it should not have.
  const creditedAnyway = row(db, "job_payments", "jp-HIST").status === "paid"
    && jobBySync(db, "JOB-HIST").amount_paid === 500;
  assert.equal(creditedAnyway, true,
    "expected the historical bug to reproduce against HEAD -- if this fails, the pre-fix commit no longer has the bug and this proof is stale");
});

test("fixed: the same unpaid session, against the live source, credits nothing", async () => {
  const db = seedDb("A");
  const handler = load({ env: baseEnv, db });
  const r = await post(handler, mkEvent("checkout.session.completed", {
    mode: "payment", payment_link: "plink_A", payment_intent: "pi_A", payment_status: "unpaid",
  }));
  assert.equal(r.status, 200, r.text);
  assert.equal(row(db, "job_payments", "jp-A").status, "pending",
    "an unpaid async session must not be marked paid");
  assert.equal((jobBySync(db, "JOB-A").amount_paid ?? 0), 0,
    "no money may be credited to the job until Stripe confirms it actually arrived");
  assert.equal(db.tables.payment_records.length, 0, "no ledger row for money that has not moved");
});

// ------------------------------------------ the wait case, resolved both --
// -------------------------------------------------------------- ways -----

test("a pending async payment that later clears is credited exactly once -- not lost, not doubled", async () => {
  const db = seedDb("B");
  const handler = load({ env: baseEnv, db });
  await post(handler, mkEvent("checkout.session.completed", {
    mode: "payment", payment_link: "plink_B", payment_intent: "pi_B", payment_status: "unpaid",
  }));
  assert.equal(row(db, "job_payments", "jp-B").status, "pending");

  const cleared = await post(handler, mkEvent("checkout.session.async_payment_succeeded", {
    mode: "payment", payment_link: "plink_B", payment_intent: "pi_B",
  }));
  assert.equal(cleared.status, 200, cleared.text);
  assert.equal(row(db, "job_payments", "jp-B").status, "paid");
  assert.equal(jobBySync(db, "JOB-B").amount_paid, 500, "a real payment must not go missing while it waits");
  assert.equal(db.tables.payment_records.length, 1);

  // Stripe redelivers the confirmation (its own retry policy, not just an
  // attacker) -- must not double-book.
  const replay = await post(handler, mkEvent("checkout.session.async_payment_succeeded", {
    mode: "payment", payment_link: "plink_B", payment_intent: "pi_B",
  }));
  assert.equal(replay.status, 200, replay.text);
  assert.equal(jobBySync(db, "JOB-B").amount_paid, 500, "replayed confirmation must not double-count");
  assert.equal(db.tables.payment_records.length, 1, "still exactly one ledger row");
});

test("a pending async payment that later bounces is marked failed, and the office is told", async () => {
  const db = seedDb("C");
  const handler = load({ env: baseEnv, db });
  await post(handler, mkEvent("checkout.session.completed", {
    mode: "payment", payment_link: "plink_C", payment_intent: "pi_C", payment_status: "unpaid",
  }));
  assert.equal(row(db, "job_payments", "jp-C").status, "pending");

  const failed = await post(handler, mkEvent("checkout.session.async_payment_failed", {
    mode: "payment", payment_link: "plink_C",
  }));
  assert.equal(failed.status, 200, failed.text);
  assert.equal(row(db, "job_payments", "jp-C").status, "failed",
    "a request that never cleared must not be left silently pending forever, nor silently dropped");
  assert.equal((jobBySync(db, "JOB-C").amount_paid ?? 0), 0, "nothing was ever credited, so nothing to undo");
});

// ---------------------------------- the second half: conservative, not ----
// -------------------------------------------------- automatic, reversal --

test("second half: a row already (wrongly) marked paid is NOT auto-reversed when the async payment is later reported failed", async () => {
  // Seeds the row the way the pre-fix bug could leave one -- job_payments
  // already "paid", ledger already credited -- and delivers the failure
  // Stripe sends when that link's debit never actually arrived. Per the
  // owner's instruction, an automatic reversal firing wrongly is worse than
  // a flag a human clears: the ledger and the job's paid figure must be
  // untouched here. See supabase_stripe_async_reversal_review.sql (not
  // applied) for the schema change and decision an automatic reversal would
  // need from March.
  const db = fakeDb({
    jobs: [{ id: "job-row-D", sync_id: "JOB-D", company_id: COMPANY, customer_name: "Pat", deposit_amount: 0, amount_paid: 500 }],
    job_payments: [{ id: "jp-D", company_id: COMPANY, job_sync_id: "JOB-D", status: "paid", livemode: true, stripe_id: "plink_D", amount_cents: 50000 }],
    payment_records: [{ id: "pr-D", company_id: COMPANY, job_sync_id: "JOB-D", amount: 500, sync_id: "stripe-jp-D" }],
  });
  const handler = load({ env: baseEnv, db });
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  let res;
  try {
    res = await post(handler, mkEvent("checkout.session.async_payment_failed", {
      mode: "payment", payment_link: "plink_D",
    }));
  } finally {
    console.error = realError;
  }
  assert.equal(res.status, 200, res.text);
  assert.equal(row(db, "job_payments", "jp-D").status, "paid", "not silently relabelled failed with no ledger change to match it");
  assert.equal(jobBySync(db, "JOB-D").amount_paid, 500, "no automatic reversal -- a person decides this, not the webhook");
  assert.equal(db.tables.payment_records.length, 1, "the ledger row from the earlier wrongful credit is left exactly as it was");
  assert.ok(errors.some((e) => e.includes("needs manual review")),
    "the contradiction must be logged loudly, not silently swallowed -- nothing today surfaces it to the office otherwise");
});

// --------------------------------------- webhook safety, unchanged: -------
// -------------------------------- signature verification and idempotency --

test("signature verification is unchanged: a tampered event is rejected and nothing is written", async () => {
  const db = seedDb("E");
  const handler = load({ env: baseEnv, db });
  const raw = JSON.stringify(mkEvent("checkout.session.completed", {
    mode: "payment", payment_link: "plink_E", payment_intent: "pi_E", payment_status: "paid",
  }));
  const t = Math.floor(Date.now() / 1000);
  const wrongMac = createHmac("sha256", "not-the-real-secret").update(`${t}.${raw}`).digest("hex");
  const res = await handler(new Request("https://fn.test/stripe-webhook", {
    method: "POST",
    headers: { "stripe-signature": `t=${t},v1=${wrongMac}` },
    body: raw,
  }));
  assert.equal(res.status, 400);
  assert.equal(row(db, "job_payments", "jp-E").status, "pending", "an unsigned event must not touch the ledger");
  assert.equal(db.tables.payment_records.length, 0);
});

test("idempotency is unchanged: a replayed checkout.session.completed (paid) does not double-credit", async () => {
  const db = seedDb("F");
  const handler = load({ env: baseEnv, db });
  const event = mkEvent("checkout.session.completed", {
    mode: "payment", payment_link: "plink_F", payment_intent: "pi_F", payment_status: "paid",
  });
  const first = await post(handler, event);
  assert.equal(first.status, 200, first.text);
  assert.equal(jobBySync(db, "JOB-F").amount_paid, 500);

  const replay = await post(handler, event);
  assert.equal(replay.status, 200, replay.text);
  assert.equal(jobBySync(db, "JOB-F").amount_paid, 500, "a replayed webhook must not double the job's paid figure");
  assert.equal(db.tables.payment_records.length, 1, "still exactly one ledger row");
});
