// The price a customer accepted is the price they are shown and billed:
// _shared/quote-deposit.ts (billableTotal, depositFigures().total),
// quote-view (records the page total on approval, shows the accepted price
// after) and create-payment-link (bills the balance and caps every link
// against it).
//
// Run with:  node --test tests/accepted-price-functions.test.mjs
//
// The live fault (diag 2026-09-21): after acceptance the phones kept pushing
// their recompute as contract_total, and every customer-facing figure
// followed it. Job 4598 was signed at $9,710 and asked against $13,410;
// Woody was signed at $3,620 and showed $200. jobs.accepted_total
// (supabase_r6_price_stability.sql) is the fix; these tests hold the two
// functions to it.
//
// The functions run for real: TypeScript stripped by Node's own stripper,
// their imports swapped for a fake Supabase client and the REAL shared
// deposit module, Deno.serve handing over the real request handler. Stripe is
// a fake fetch. Nothing touches the network, a database or a card.
//
// Every rule has a planted failure beside it: the figure the OLD behaviour
// produces for the same job, asserted to differ -- so a test that would pass
// whichever rule ran cannot hide here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as quoteDeposit from "../supabase/functions/_shared/quote-deposit.ts";
import * as jobPush from "../supabase/functions/_shared/job-push.ts";
import * as pushRecipients from "../supabase/functions/_shared/push-recipients.ts";
const { billableTotal, depositFigures } = quoteDeposit;

const COMPANY = "c0000000-0000-4000-8000-000000000001";
const JOB = "a0000000-0000-4000-8000-00000000000a";
const JOB_ID = "10000000-0000-4000-8000-000000000001";
const TOKEN = "b0000000-0000-4000-8000-00000000000b";

const SIGNED = "2026-09-10T12:00:00Z";     // drawn signature at $9,710
const APPROVED = "2026-09-20T12:00:00Z";   // approved online later
const BEFORE = "2026-09-01T12:00:00Z";
const AFTER = "2026-09-21T12:00:00Z";

// ============================================================ the rule ====

const job = (o = {}) => ({
  depositAmount: 0, contractTotal: 13410, amountPaid: 0, refundedAmount: 0,
  acceptedTotal: 9710, signedAt: SIGNED, quoteApprovedAt: null, reapprovalRequiredAt: null,
  changeOrders: [], ...o,
});

test("an accepted job is billed at the accepted price, not the drifted contract_total", () => {
  assert.equal(billableTotal(job()), 9710);
  assert.equal(depositFigures(job()).total, 9710);
  // Planted failure: the old rule read contract_total, which is job 4598's
  // $13,410. The two must differ or this test proves nothing.
  assert.equal(billableTotal(job({ acceptedTotal: null })), 13410);
  assert.notEqual(billableTotal(job()), billableTotal(job({ acceptedTotal: null })));
});

test("extra work signed AFTER acceptance adds; work inside the accepted figure does not", () => {
  const orders = [
    { additionalCost: 500, signedAt: AFTER },                      // signed since: adds
    { additionalCost: 300, signedAt: BEFORE },                     // already in the $9,710
    { additionalCost: 700, signedAt: null },                       // not signed: not yet
    { additionalCost: 1000, signedAt: AFTER, deletedAt: AFTER },   // tombstoned
  ];
  assert.equal(billableTotal(job({ changeOrders: orders })), 10210);
  // Planted failure: adding every order bills the $300 twice (and the rest).
  const naive = 9710 + orders.reduce((s, o) => s + o.additionalCost, 0);
  assert.notEqual(billableTotal(job({ changeOrders: orders })), naive);
});

test("the later acceptance is the one measured from", () => {
  // Signed on the phone, approved online later: an order signed between the
  // two is inside the approved figure already.
  const between = { additionalCost: 400, signedAt: "2026-09-15T12:00:00Z" };
  const j = job({ quoteApprovedAt: APPROVED, changeOrders: [between] });
  assert.equal(billableTotal(j), 9710);
  // Planted failure: measuring from the signature alone would add it again.
  assert.equal(billableTotal({ ...j, quoteApprovedAt: null }), 10110);
});

test("a pending re-approval, no acceptance, or no recorded figure: contract_total, as before", () => {
  assert.equal(billableTotal(job({ reapprovalRequiredAt: AFTER })), 13410);
  assert.equal(billableTotal(job({ signedAt: null, quoteApprovedAt: null })), 13410);
  assert.equal(billableTotal(job({ acceptedTotal: 0 })), 13410);
  assert.equal(billableTotal(job({ acceptedTotal: undefined })), 13410);
  // An input from before the fields existed is exactly the old rule.
  assert.equal(billableTotal({ depositAmount: 0, contractTotal: 8425, amountPaid: 0, refundedAmount: 0 }), 8425);
});

test("an order the acceptance already covered is never added again", () => {
  // Added while the quote was out, unsigned when the contract was signed at
  // $9,710 (which the engine had already counted it into), signed the next
  // day. in_accepted_total says the acceptance covered it.
  const covered = { additionalCost: 900, signedAt: AFTER, inAcceptedTotal: true };
  assert.equal(billableTotal(job({ changeOrders: [covered] })), 9710);
  // Planted failure: the rule before the flag billed it twice.
  assert.equal(billableTotal(job({ changeOrders: [{ ...covered, inAcceptedTotal: false }] })), 10610);
  // A row read without the column (a database the migration has not reached)
  // is the rule as it was.
  assert.equal(billableTotal(job({ changeOrders: [{ additionalCost: 900, signedAt: AFTER }] })), 10610);
});

test("change_orders rows map onto the rule with or without the new column", () => {
  const withFlag = quoteDeposit.changeOrderInputs([{ additional_cost: "900", signed_at: AFTER, deleted_at: null, in_accepted_total: true }]);
  assert.deepEqual(withFlag, [{ additionalCost: 900, signedAt: AFTER, deletedAt: null, inAcceptedTotal: true }]);
  const without = quoteDeposit.changeOrderInputs([{ additional_cost: 900, signed_at: AFTER, deleted_at: null }]);
  assert.equal(without[0].inAcceptedTotal, false);
  assert.ok(quoteDeposit.missingAcceptanceFlag({ message: "column change_orders.in_accepted_total does not exist" }));
  assert.ok(!quoteDeposit.missingAcceptanceFlag({ message: "column jobs.accepted_total does not exist" }));
});

test("the deposit cap follows the accepted price", () => {
  // Job 4598's deposit of $9,910 against a $9,710 acceptance: capped at what
  // was agreed, not at the $13,410 recompute.
  const f = depositFigures(job({ depositAmount: 9910 }));
  assert.equal(f.asked, 9710);
  assert.equal(depositFigures(job({ depositAmount: 9910, acceptedTotal: null })).asked, 9910);
});

// ============================================================ harness =====

/**
 * Loads a real edge function against the given fake client and fetch. Its
 * imports are supplied here: createClient (the fake) from supabase-js, and
 * every name it takes from a shared module below from the REAL module
 * (quote-view addresses its approval push through job-push.ts and
 * push-recipients.ts). An import from anywhere else, or a name the shared
 * module does not export, fails loudly -- the harness would no longer
 * describe the file.
 */
const SHARED = {
  "../_shared/quote-deposit.ts": quoteDeposit,
  "../_shared/job-push.ts": jobPush,
  "../_shared/push-recipients.ts": pushRecipients,
};

function load(path, { env = {}, db, fetchImpl = async () => new Response("{}", { status: 404 }) }) {
  let js = stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), "utf8"));
  const importRe = /^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";?[ \t]*$/gm;
  const provided = {};
  for (const [, list, from] of js.matchAll(importRe)) {
    const names = list.split(",").map((n) => n.trim()).filter(Boolean);
    if (/supabase-js/.test(from)) {
      assert.deepEqual(names, ["createClient"], "supabase-js import changed");
      provided.createClient = () => db;
    } else if (Object.hasOwn(SHARED, from)) {
      for (const n of names) {
        assert.ok(n in SHARED[from], `${from} exports no ${n}`);
        provided[n] = SHARED[from][n];
      }
    } else {
      assert.fail(`an import the harness does not supply: ${from}`);
    }
  }
  assert.ok(provided.createClient && provided.depositFigures, "the file no longer imports what the harness expects");
  js = js.replace(importRe, "").replace(/^export /gm, "");
  assert.doesNotMatch(js, /^import /m, "an import the harness did not strip");
  let handler = null;
  const Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
  const names = Object.keys(provided);
  new Function("Deno", "fetch", ...names, js)(Deno, fetchImpl, ...names.map((n) => provided[n]));
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

/**
 * An in-memory service-role client. Records every read and write. With
 * `withoutAcceptance`, any jobs read or write naming accepted_total fails the
 * way PostgREST does on a database the migration has not reached.
 */
function fakeDb(tables, { withoutAcceptance = false, withoutOrderFlag = false, failWrites = false } = {}) {
  const t = structuredClone(tables);
  const log = [];
  class Query {
    constructor(table) { this.table = table; this.op = "select"; this.cols = "*"; this.filters = []; this.returning = false; this.lim = Infinity; }
    select(cols) { if (this.op === "select") this.cols = cols ?? "*"; else this.returning = true; return this; }
    eq(k, v) { this.filters.push((r) => String(r[k]) === String(v)); return this; }
    is(k, v) { this.filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return this; }
    in(k, vs) { this.filters.push((r) => vs.map(String).includes(String(r[k]))); return this; }
    not(k, op, v) {
      assert.ok(op === "is" && v === null, `fake client: not(${op}, ${v}) is not modelled`);
      this.filters.push((r) => r[k] != null); return this;
    }
    or() { return this; }
    order() { return this; }
    limit(n) { this.lim = n; return this; }
    update(p) { this.op = "update"; this.payload = p; return this; }
    insert(p) { this.op = "insert"; this.payload = p; return this; }
    maybeSingle() { this.mode = "maybe"; return this.run(); }
    single() { this.mode = "one"; return this.run(); }
    then(ok, bad) { return this.run().then(ok, bad); }
    async run() {
      const named = this.op === "select" ? String(this.cols) : Object.keys(this.payload ?? {}).join(",");
      log.push({ op: this.op, table: this.table, cols: named, payload: this.payload });
      if (withoutAcceptance && this.table === "jobs" && /accepted_total/.test(named)) {
        return { data: null, error: { message: "column jobs.accepted_total does not exist" } };
      }
      if (withoutOrderFlag && this.table === "change_orders" && /in_accepted_total/.test(named)) {
        return { data: null, error: { message: "column change_orders.in_accepted_total does not exist" } };
      }
      if (failWrites && this.op === "update" && this.table === "jobs") {
        return { data: null, error: { message: "planted: the write failed" } };
      }
      const rows = (t[this.table] ??= []);
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") {
        hit.forEach((r) => Object.assign(r, this.payload));
        return { data: this.returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
      }
      if (this.op === "insert") {
        rows.push({ id: `new-${rows.length + 1}`, ...this.payload });
        return { data: null, error: null };
      }
      // Only the columns asked for, as PostgREST answers: a read that does
      // not name accepted_total must not see it.
      const cols = String(this.cols).split(",").map((c) => c.trim()).filter(Boolean);
      const project = (r) => (cols.length === 0 || cols.includes("*"))
        ? r : Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]]));
      const out = hit.slice(0, this.lim).map(project);
      if (this.mode === "maybe") return { data: out[0] ?? null, error: null };
      if (this.mode === "one") return out[0] ? { data: out[0], error: null } : { data: null, error: { message: "no row" } };
      return { data: out, error: null };
    }
  }
  return {
    tables: t,
    log,
    from: (table) => new Query(table),
    rpc: async (fn) => {
      log.push({ op: "rpc", table: fn });
      return { data: fn === "quote_phone_try" ? "OK" : true, error: null };
    },
    auth: {
      getUser: async (jwt) => jwt === "office-jwt"
        ? { data: { user: { id: "user-1" } }, error: null }
        : { data: { user: null }, error: { message: "bad jwt" } },
    },
  };
}

/** Stripe, as far as making one new payment link goes. */
function fakeStripe(calls) {
  let n = 0;
  return async (url, init = {}) => {
    const u = new URL(url);
    const form = Object.fromEntries(new URLSearchParams(init.body ?? ""));
    calls.push([init.method ?? "GET", u.pathname, form.unit_amount]);
    if (u.pathname === "/v1/prices") return new Response(JSON.stringify({ id: `price_${++n}` }), { status: 200 });
    if (u.pathname === "/v1/payment_links") {
      return new Response(JSON.stringify({ id: `plink_${++n}`, url: `https://buy.stripe.com/test_${n}`, livemode: false, active: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: `unrouted ${u.pathname}` } }), { status: 404 });
  };
}

const acceptedJob = (o = {}) => ({
  id: JOB_ID, sync_id: JOB, company_id: COMPANY, customer_name: "Pat", address: "1 Oak St", phone: "",
  status: "ACCEPTED", deleted_at: null, quote_token: TOKEN,
  contract_total: 13410, accepted_total: 9710, signed_at: SIGNED, quote_approved_at: APPROVED,
  quote_approved_name: "Pat", reapproval_required_at: null, reapproval_reason: "",
  amount_paid: 0, refunded_amount: 0, deposit_amount: 0, tax_rate_percent: 0, discount_percent: 0,
  quote_viewed_at: APPROVED, calibration_pixels_per_foot: 20,
  quote_phone_attempts: 0, quote_phone_locked_until: null, ...o,
});

function paymentWorld({ job = {}, orders = [], opts = {} } = {}) {
  const calls = [];
  const db = fakeDb({
    companies: [{ id: COMPANY, name: "Test Fence Co", stripe_account_id: null, subscription_plan: "crew" }],
    profiles: [{ id: "user-1", company_id: COMPANY, role: "OWNER" }],
    jobs: [acceptedJob(job)],
    change_orders: orders.map((o) => ({ company_id: COMPANY, job_sync_id: JOB, deleted_at: null, ...o })),
    job_payments: [],
    payment_connections: [],
  }, opts);
  const handler = load("../supabase/functions/create-payment-link/index.ts", {
    env: { STRIPE_SECRET_KEY: "sk_test_placeholder" }, db, fetchImpl: fakeStripe(calls),
  });
  return { handler, db, calls };
}

async function post(handler, url, body, headers = {}) {
  const res = await handler(new Request(url, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

const linkCents = (w) => w.db.tables.job_payments.map((r) => r.amount_cents);

// ================================================= create-payment-link ====

test("homeowner balance: bills the accepted $9,710, not the drifted $13,410", async () => {
  const w = paymentWorld();
  const r = await post(w.handler, "https://fn.test/create-payment-link", { quoteToken: TOKEN, kind: "balance" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(linkCents(w), [971000]);
  // Planted failure: the same job with nothing accepted is the old figure.
  const old = paymentWorld({ job: { accepted_total: null } });
  await post(old.handler, "https://fn.test/create-payment-link", { quoteToken: TOKEN, kind: "balance" });
  assert.deepEqual(linkCents(old), [1341000]);
});

test("homeowner balance: extra work signed since acceptance is billed, earlier work is not billed twice", async () => {
  const w = paymentWorld({
    job: { amount_paid: 1000 },
    orders: [
      { additional_cost: 500, signed_at: AFTER },
      { additional_cost: 300, signed_at: BEFORE },
      { additional_cost: 900, signed_at: AFTER, deleted_at: AFTER },
    ],
  });
  const r = await post(w.handler, "https://fn.test/create-payment-link", { quoteToken: TOKEN, kind: "balance" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // 9710 + 500 - 1000 paid.
  assert.deepEqual(linkCents(w), [921000]);
});

test("homeowner deposit: capped at the accepted price", async () => {
  const w = paymentWorld({ job: { deposit_amount: 9910 } });
  const r = await post(w.handler, "https://fn.test/create-payment-link", { quoteToken: TOKEN, kind: "deposit" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(linkCents(w), [971000]);
});

test("homeowner balance: an order the acceptance covered is not billed on top of it", async () => {
  const w = paymentWorld({ orders: [{ additional_cost: 900, signed_at: AFTER, in_accepted_total: true }] });
  const r = await post(w.handler, "https://fn.test/create-payment-link", { quoteToken: TOKEN, kind: "balance" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(linkCents(w), [971000]);
  // Planted failure: the same order unmarked is billed twice.
  const old = paymentWorld({ orders: [{ additional_cost: 900, signed_at: AFTER, in_accepted_total: false }] });
  await post(old.handler, "https://fn.test/create-payment-link", { quoteToken: TOKEN, kind: "balance" });
  assert.deepEqual(linkCents(old), [1061000]);
});

test("a database without in_accepted_total yet: the balance reads the old columns", async () => {
  const w = paymentWorld({
    orders: [{ additional_cost: 500, signed_at: AFTER }],
    opts: { withoutOrderFlag: true },
  });
  const r = await post(w.handler, "https://fn.test/create-payment-link", { quoteToken: TOKEN, kind: "balance" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(linkCents(w), [1021000]);
  const reads = w.db.log.filter((e) => e.table === "change_orders");
  assert.ok(reads.some((e) => /in_accepted_total/.test(e.cols)) && reads.some((e) => !/in_accepted_total/.test(e.cols)));
});

test("a pending re-approval bills the live contract_total, as before", async () => {
  const w = paymentWorld({ job: { reapproval_required_at: AFTER } });
  await post(w.handler, "https://fn.test/create-payment-link", { quoteToken: TOKEN, kind: "balance" });
  assert.deepEqual(linkCents(w), [1341000]);
});

test("office cap: measured against the accepted price", async () => {
  const over = paymentWorld();
  const r = await post(over.handler, "https://fn.test/create-payment-link",
    { jobSyncId: JOB, description: "Fence work", amountCents: 1000000, kind: "final" },
    { Authorization: "Bearer office-jwt" });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "over_owed");
  assert.match(r.body.error, /still owes \(9710\.00\)/);
  // Positive control: the accepted figure itself goes through.
  const ok = paymentWorld();
  const r2 = await post(ok.handler, "https://fn.test/create-payment-link",
    { jobSyncId: JOB, description: "Fence work", amountCents: 971000, kind: "final" },
    { Authorization: "Bearer office-jwt" });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  // Planted failure: the old cap (contract_total) let $10,000 through.
  const old = paymentWorld({ job: { accepted_total: null } });
  const r3 = await post(old.handler, "https://fn.test/create-payment-link",
    { jobSyncId: JOB, description: "Fence work", amountCents: 1000000, kind: "final" },
    { Authorization: "Bearer office-jwt" });
  assert.equal(r3.status, 200, JSON.stringify(r3.body));
});

test("a database without accepted_total yet: both doors bill contract_total exactly as before", async () => {
  const w = paymentWorld({ opts: { withoutAcceptance: true } });
  const r = await post(w.handler, "https://fn.test/create-payment-link", { quoteToken: TOKEN, kind: "balance" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(linkCents(w), [1341000]);
  // It did try the new columns first, then fell back.
  const jobReads = w.db.log.filter((e) => e.table === "jobs" && e.op === "select");
  assert.ok(jobReads.some((e) => /accepted_total/.test(e.cols)));
  assert.ok(jobReads.some((e) => !/accepted_total/.test(e.cols)));
});

test("change orders are read only for a job with an accepted figure", async () => {
  const w = paymentWorld({ job: { accepted_total: null } });
  await post(w.handler, "https://fn.test/create-payment-link", { quoteToken: TOKEN, kind: "balance" });
  assert.equal(w.db.log.filter((e) => e.table === "change_orders").length, 0);
  const a = paymentWorld();
  await post(a.handler, "https://fn.test/create-payment-link", { quoteToken: TOKEN, kind: "balance" });
  assert.ok(a.db.log.filter((e) => e.table === "change_orders").length > 0);
});

// ========================================================== quote-view ====

function quoteWorld({ job = {}, orders = [], lines = [], opts = {} } = {}) {
  const db = fakeDb({
    jobs: [acceptedJob({ quote_approved_at: null, quote_approved_name: "", status: "SENT", ...job })],
    companies: [{ id: COMPANY, name: "Test Fence Co", phone: "", email: "" }],
    estimate_line_items: lines.map((l) => ({ company_id: COMPANY, job_sync_id: JOB, deleted_at: null, taxable: false, ...l })),
    change_orders: orders.map((o) => ({ company_id: COMPANY, job_sync_id: JOB, deleted_at: null, ...o })),
    fence_runs: [],
    payment_connections: [],
    // An owner, so a landed approval has somebody to address and visibly
    // reaches for their device tokens.
    profiles: [{ id: "owner-1", company_id: COMPANY, role: "OWNER", permission_overrides: "" }],
    employees: [],
    device_tokens: [],
  }, opts);
  // A service account is configured so a landed approval visibly reaches for
  // the device tokens (the last step before the push); there are none, so no
  // key is ever used.
  const handler = load("../supabase/functions/quote-view/index.ts", {
    env: { FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: "x", private_key: "x", project_id: "p" }) },
    db,
  });
  return { handler, db };
}

const view = async (w) => {
  const res = await w.handler(new Request(`https://fn.test/quote-view?t=${TOKEN}`));
  return { status: res.status, body: await res.json() };
};
const approve = (w, extra = {}) =>
  post(w.handler, `https://fn.test/quote-view?t=${TOKEN}`, { action: "approve", name: "Pat Buyer", ...extra });
const jobRow = (w) => w.db.tables.jobs[0];
const pushed = (w) => w.db.log.some((e) => e.table === "device_tokens");

test("approving records the total the page showed, in the same update as the approval", async () => {
  // Not signed, not approved: the page shows contract_total as stored -- the
  // figure the payment link charges from. (The engine always writes a
  // multiple of ten; an odd figure is an import, and rounding it up on the
  // page alone put $7 between the page and the card machine.)
  const w = quoteWorld({ job: { accepted_total: null, signed_at: null, contract_total: 13403 } });
  const shown = (await view(w)).body.total;
  assert.equal(shown, 13403);
  const r = await approve(w);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(jobRow(w).accepted_total, shown);
  const write = w.db.log.find((e) => e.op === "update" && e.table === "jobs" && e.payload?.quote_approved_at);
  assert.ok(write, "the approval was written");
  assert.equal(write.payload.accepted_total, shown, "the price travels in the same update as the approval");
  assert.ok(pushed(w), "the approval that landed tells the phones");
});

test("a job signed on the phone and approved online keeps the signed price", async () => {
  // Job 4598: signed at $9,710, contract_total drifted to $13,410, then the
  // customer approves online. The page shows -- and the approval records --
  // what they signed for.
  const w = quoteWorld();
  assert.equal((await view(w)).body.total, 9710);
  await approve(w);
  assert.equal(jobRow(w).accepted_total, 9710);
  // Planted failure: the old page showed the drifted figure.
  const old = quoteWorld({ job: { accepted_total: null } });
  assert.equal((await view(old)).body.total, 13410);
});

test("after approval the page shows the accepted price plus extra work signed since", async () => {
  const w = quoteWorld({
    job: { quote_approved_at: APPROVED, quote_approved_name: "Pat", status: "ACCEPTED", accepted_total: 9710 },
    orders: [{ additional_cost: 495, signed_at: AFTER }, { additional_cost: 300, signed_at: BEFORE }],
  });
  const r = await view(w);
  // 9710 + 495, as it stands -- the figure create-payment-link charges from.
  assert.equal(r.body.total, 10205);
  // Planted failure: rounding every source up to ten showed $10,210 over a
  // balance link that charged from $10,205.
  assert.notEqual(r.body.total, Math.ceil((9710 + 495) / 10) * 10);
});

test("the page and the payment link show one figure for an accepted job with extra work", async () => {
  const orders = [{ additional_cost: 455, signed_at: AFTER }];
  const q = quoteWorld({
    job: { quote_approved_at: APPROVED, quote_approved_name: "Pat", status: "ACCEPTED", accepted_total: 9710 },
    orders,
  });
  const shown = (await view(q)).body.total;
  const w = paymentWorld({ orders });
  await post(w.handler, "https://fn.test/create-payment-link", { quoteToken: TOKEN, kind: "balance" });
  assert.deepEqual(linkCents(w), [Math.round(shown * 100)]);
  assert.equal(shown, 10165);
});

test("the page does not add an order the acceptance covered", async () => {
  const w = quoteWorld({
    job: { quote_approved_at: APPROVED, quote_approved_name: "Pat", status: "ACCEPTED", accepted_total: 9710 },
    orders: [{ additional_cost: 900, signed_at: AFTER, in_accepted_total: true }],
  });
  assert.equal((await view(w)).body.total, 9710);
});

test("with nothing priced the page still falls back to the lines", async () => {
  const w = quoteWorld({
    job: { accepted_total: null, signed_at: null, contract_total: null, tax_rate_percent: 10 },
    lines: [{ quantity: 10, unit_price: 20, taxable: true }, { quantity: 1, unit_price: 55 }],
  });
  // 200 + 55 + 20 tax = 275 -> 280.
  assert.equal((await view(w)).body.total, 280);
  await approve(w);
  assert.equal(jobRow(w).accepted_total, 280);
});

test("a page that saw an older total is told to reload, and nothing is recorded", async () => {
  const w = quoteWorld({ job: { accepted_total: null, signed_at: null, contract_total: 5000 } });
  const r = await approve(w, { total: 4800 });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "quote_changed");
  assert.equal(jobRow(w).quote_approved_at, null);
  assert.equal(jobRow(w).accepted_total, null);
  // Positive control: the figure the page really shows goes through.
  const ok = await approve(w, { total: 5000 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(jobRow(w).accepted_total, 5000);
});

test("a failed approval write is an error, not a thank-you", async () => {
  const w = quoteWorld({ job: { accepted_total: null, signed_at: null }, opts: { failWrites: true } });
  const r = await approve(w);
  assert.equal(r.status, 500);
  assert.equal(r.body.ok, undefined);
  assert.equal(pushed(w), false);
});

test("an approval that lost the race keeps the first name, and nobody is pushed twice", async () => {
  const w = quoteWorld({ job: { accepted_total: null, signed_at: null } });
  // Somebody else's approval lands between this request's read and its write.
  const realFrom = w.db.from;
  let raced = false;
  w.db.from = (table) => {
    const q = realFrom(table);
    if (table === "jobs" && !raced) {
      const realUpdate = q.update.bind(q);
      q.update = (p) => {
        if (p.quote_approved_at && !raced) {
          raced = true;
          Object.assign(jobRow(w), { quote_approved_at: APPROVED, quote_approved_name: "First Person", accepted_total: 13410 });
        }
        return realUpdate(p);
      };
    }
    return q;
  };
  const r = await approve(w);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.approvedBy, "First Person");
  assert.equal(jobRow(w).quote_approved_name, "First Person");
  assert.equal(pushed(w), false);
});

test("a database without accepted_total yet: quotes open and approve exactly as before", async () => {
  const w = quoteWorld({ job: { accepted_total: undefined, signed_at: undefined, contract_total: 5000 }, opts: { withoutAcceptance: true } });
  assert.equal((await view(w)).status, 200);
  const r = await approve(w);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(jobRow(w).quote_approved_at);
  const write = w.db.log.filter((e) => e.op === "update" && e.table === "jobs" && e.payload?.quote_approved_at);
  assert.equal(write.at(-1).payload.accepted_total, undefined, "the fallback write does not name the missing column");
});
