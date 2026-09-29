// A4 audit -- "what is still owed": quote-deposit.ts's asked/due/payable/
// total/netPaid/balance, and every surface that displays or charges some of
// it (quote-view, create-payment-link, the office dashboard).
//
// This file is READ-ONLY evidence. It does not patch any source file; it
// calls the real edge functions and the real dashboard.html helpers the same
// way the app/quote page/office call them, and asserts on what comes back.
//
// FINDING: supabase/functions/create-payment-link/index.ts, the homeowner
// "pay the balance" branch (quoteToken door, kind:"balance", around line 589)
// computes
//     const netPaid = (Number(qjob.amount_paid) || 0) - (Number(qjob.refunded_amount) || 0);
//     const dollars = kindWanted === "deposit" ? deposit.due : Math.max(0, total - netPaid);
// instead of using `deposit.balance`, the figure depositFigures() -- computed
// one line above from the SAME inputs -- already produced. depositFigures()
// floors netPaid at zero before subtracting:
//     netPaid: Math.max(0, num(input.amountPaid) - num(input.refundedAmount))
//     balance: Math.max(0, total - netPaid)
// The inline copy at line 589 does not floor. Whenever refunded_amount is
// larger than amount_paid on a job's cached totals -- which the ledger
// trigger (supabase_job_totals_authority_patch.sql: v_paid and v_refunded are
// two independent sums with no constraint tying them together) does not
// forbid -- the two diverge: the inline copy asks makeLink() for MORE than
// the job's real balance.
//
// It does NOT reach the customer as an overcharge -- makeLink() re-reads the
// job itself and caps every request through planOpenLinks(), which floors
// netPaid correctly (line ~329, Math.max(0, ...)) and refuses anything over
// the real balance. So the inflated request is bounced with 400 "over_owed".
// What actually happens is worse for the contractor than a silently wrong
// number: a customer who legitimately owes the whole accepted total, and
// whose "balance" request the SERVER ITSELF computed (no client input is
// wrong here), gets refused payment outright with "That is more than this
// job still owes" -- on a job that is not paid in full and should be
// payable. A control that does not do the thing.
//
// Every other place in this codebase that subtracts refunded_amount from
// amount_paid floors the result at zero first: quote-deposit.ts's own
// netPaid, website/dashboard.html's netPaid() (line ~9167), the cap in this
// same file's planOpenLinks() (line ~329, Math.max(0, ...)), and
// supabase_p4_attention_candidates_fn.sql (greatest(...,0)). Line 589 is the
// one place in the whole codebase that does not.
//
// This is reachable: kind:"balance" against the quoteToken door is a real,
// tested code path (tests/accepted-price-functions.test.mjs's "homeowner
// balance" tests all use it) that only requires POSTing
// {quoteToken, kind:"balance"} to the public endpoint -- no session, no
// office login. website/quote.html's own JS currently only ever sends
// kind:'deposit' (grep the file: the only body literal is
// `{quoteToken:token,kind:'deposit'}`), so nothing in the shipped page draws
// a button for it today, but the server accepts and prices the request
// exactly the same regardless of what drew the POST, and the app's own
// JobDetailScreen.kt maps a "balance" request to PaymentsApi.Kind.FINAL --
// whether that reaches this same quoteToken door or the office door was out
// of scope to trace fully here (JobDetailScreen.kt is one of the files this
// audit was told not to open), but the office door's `kind:"final"` path
// shares the same makeLink() cap, so it is not exposed to this specific bug
// (its amount comes from the client, not from this file's own dollars/netPaid
// line).
//
// Run with:  node --test tests/a4-balance.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as quoteDeposit from "../supabase/functions/_shared/quote-deposit.ts";
import * as jobPush from "../supabase/functions/_shared/job-push.ts";
import * as pushRecipients from "../supabase/functions/_shared/push-recipients.ts";
const { depositFigures } = quoteDeposit;

const COMPANY = "c0000000-0000-4000-8000-000000000001";
const JOB = "a0000000-0000-4000-8000-00000000000a";
const JOB_ID = "10000000-0000-4000-8000-000000000001";
const TOKEN = "b0000000-0000-4000-8000-00000000000b";
const SIGNED = "2026-09-10T12:00:00Z";
const APPROVED = "2026-09-20T12:00:00Z";

// ============================================================ harness =====
// Same technique tests/accepted-price-functions.test.mjs uses: strip the TS,
// supply the real _shared modules and a fake createClient, hand Deno.serve's
// callback back as the handler. Duplicated here rather than imported --
// nothing in the neighbour file is exported, and this task may not edit it.

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

function fakeDb(tables) {
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
    rpc: async (fn) => ({ data: fn === "quote_phone_try" ? "OK" : true, error: null }),
    auth: { getUser: async () => ({ data: { user: null }, error: { message: "bad jwt" } }) },
  };
}

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

function paymentWorld({ job = {}, orders = [] } = {}) {
  const calls = [];
  const db = fakeDb({
    companies: [{ id: COMPANY, name: "Test Fence Co", stripe_account_id: null, subscription_plan: "crew" }],
    profiles: [{ id: "user-1", company_id: COMPANY, role: "OWNER" }],
    jobs: [acceptedJob(job)],
    change_orders: orders.map((o) => ({ company_id: COMPANY, job_sync_id: JOB, deleted_at: null, ...o })),
    job_payments: [],
    payment_connections: [],
  });
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

// ======================================================== canary =========
// Confirms this harness can actually tell a wrong balance from a right one,
// before trusting it to clear the real case below. A job with no over-refund
// (refunded_amount <= amount_paid) must bill exactly depositFigures().balance
// -- assert something that MUST be false first, see it fail, then assert the
// truth.

test("canary: the harness fails a deliberately wrong expectation", async () => {
  const w = paymentWorld({ job: { amount_paid: 1000, refunded_amount: 0 } });
  const r = await post(w.handler, "https://fn.test/create-payment-link", { quoteToken: TOKEN, kind: "balance" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // 9710 accepted total - 1000 paid = 8710.00 -> 871000 cents.
  assert.throws(() => assert.deepEqual(linkCents(w), [999999]),
    /Expected values to be strictly deep-equal/,
    "canary did not fail -- the harness cannot be trusted to catch a wrong balance");
  assert.deepEqual(linkCents(w), [871000]);
});

// =============================================== the actual finding ======

test("FIXED: an over-refunded job now pays its real $9,710 balance (netPaid floored to match depositFigures())", async () => {
  // amount_paid 1000, refunded_amount 1600: refunded MORE than was ever
  // recorded paid on this job's cached totals. The ledger trigger
  // (supabase_job_totals_authority_patch.sql) sums paid and refunded rows
  // independently with nothing tying them together, so this is a reachable
  // state, not a contradiction the database rejects.
  const w = paymentWorld({ job: { amount_paid: 1000, refunded_amount: 1600 } });

  // What depositFigures() -- the single source of truth this file's header
  // points at -- says is owed. This is the number every other surface
  // (quote-view's balanceDue, dashboard.html's balanceOf) shows for this
  // exact job: a real, payable $9,710 balance.
  const correct = depositFigures({
    depositAmount: 0, contractTotal: 13410, amountPaid: 1000, refundedAmount: 1600,
    acceptedTotal: 9710, signedAt: SIGNED, quoteApprovedAt: APPROVED, reapprovalRequiredAt: null,
    changeOrders: [],
  });
  assert.equal(correct.netPaid, 0, "depositFigures floors netPaid at zero");
  assert.equal(correct.balance, 9710, "so the balance is the whole accepted total, not more");

  const r = await post(w.handler, "https://fn.test/create-payment-link", { quoteToken: TOKEN, kind: "balance" });

  // VERIFIED FIXED: create-payment-link/index.ts's "balance" branch now
  // bills `deposit.balance` directly (depositFigures()'s own floored
  // figure) instead of re-deriving `total - netPaid` from an unfloored
  // amount_paid - refunded_amount. Confirmed against the live source at
  // supabase/functions/create-payment-link/index.ts (the comment right
  // above the `const dollars = ... : deposit.balance;` line names this
  // exact fix). Reverting that line in a scratch copy and re-running this
  // exact assertion reproduces the old 400/over_owed refusal -- see the
  // task report for that output.
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(linkCents(w), [971000],
    "bills the real $9,710 balance (971000 cents), not the old inflated $10,310 request that " +
    "used to get bounced as 'over_owed' by makeLink()'s own (correctly floored) cap");
});

test("control: the same over-refund does NOT break the deposit kind (deposit.due is already floored)", async () => {
  // Same over-refunded job, but kind:"deposit" -- the branch that uses
  // `deposit.due` (from depositFigures(), correctly floored) rather than the
  // local `total - netPaid`. This isolates the bug to the "balance" branch
  // specifically, not to depositFigures() or to over-refunded jobs in
  // general.
  const w = paymentWorld({ job: { amount_paid: 1000, refunded_amount: 1600, deposit_amount: 2000 } });
  const r = await post(w.handler, "https://fn.test/create-payment-link", { quoteToken: TOKEN, kind: "deposit" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // asked = min(2000, 9710) = 2000; due = max(0, 2000 - netPaid(floored 0)) = 2000.
  assert.deepEqual(linkCents(w), [200000]);
});

test("control: without an over-refund, 'balance' already matches depositFigures().balance", async () => {
  // amount_paid <= refunded_amount never occurs here, so netPaid cannot go
  // negative and the missing floor never bites -- this is exactly the
  // "homeowner balance" case tests/accepted-price-functions.test.mjs already
  // covers, repeated here to show the bug is specific to the over-refund
  // state, not present on every job.
  const w = paymentWorld({ job: { amount_paid: 1000, refunded_amount: 0 } });
  const correct = depositFigures({
    depositAmount: 0, contractTotal: 13410, amountPaid: 1000, refundedAmount: 0,
    acceptedTotal: 9710, signedAt: SIGNED, quoteApprovedAt: APPROVED, reapprovalRequiredAt: null,
    changeOrders: [],
  });
  const r = await post(w.handler, "https://fn.test/create-payment-link", { quoteToken: TOKEN, kind: "balance" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(linkCents(w), [Math.round(correct.balance * 100)]);
});

// =================================================== second finding ======
// website/dashboard.html's job-detail "Estimate breakdown" panel (showJob(),
// the block building #jobEstDepositBalance around line 20504) USED TO print
// `money(openJob.deposit_amount)` -- the RAW, uncapped field -- for the
// deposit row, while every other deposit readout on the same page
// (jobReadiness's checklist row, the readiness-panel "why") goes through
// `depositAskedOf(j, price)`, which caps the figure at the job's own
// billable total:
//     function depositAskedOf(j, price){
//       const dep = Math.max(0, Number(j && j.deposit_amount) || 0), p = Number(price) || 0;
//       return p > 0 ? Math.min(dep, p) : dep;
//     }
// VERIFIED FIXED: the call site now reads
// `const deposit = depositAskedOf(openJob, contract);` immediately before
// the #jobEstDepositBalance render, so the deposit row is capped the same
// way as every other deposit readout on the page. This does not touch
// quote-deposit.ts's `balance` (the line right next to it,
// `balanceOf(openJob, contract)`, was already correct and is unchanged) --
// only the "asked" figure, quote-deposit.ts's own name for this same capped
// value.
//
// This is pulled out and run the same way tests/office-money-parity.test.mjs
// extracts dashboard.html's pure functions (balanced-brace grab, eval
// standalone) rather than driving the DOM-heavy showJob() itself.

// BEHAVIOUR, not spelling: the old version of this test asserted the SOURCE
// TEXT of dashboard.html -- that some call site contains the substring
// "depositAskedOf(openJob, contract)". That goes red on a harmless rename and
// (worse) stays GREEN if depositAskedOf() itself is ever edited to stop
// capping, because the call site would still read exactly the same. It pinned
// the spelling, not the behaviour it exists to protect.
//
// This version actually RUNS the real render block -- the literal
// `const contract = ...` / `const deposit = ...` /
// `$('jobEstDepositBalance').innerHTML = ...` statements, lifted out of
// dashboard.html with the same balanced-brace `grab()` technique
// tests/office-money-parity.test.mjs uses for functions, extended here to
// pull out a plain statement block by its start and end anchors -- and feeds
// it a job whose stored deposit ($5,000) exceeds its current billable total
// ($3,000, e.g. after a re-price), then asserts the HTML actually produced
// shows the CAPPED figure. If depositAskedOf() -- or anything upstream of it
// -- ever stops capping, the rendered number itself changes and this test
// fails, regardless of what the call site is spelled like.
test("FIXED: dashboard.html's estimate-breakdown deposit row renders the CAPPED figure, not the raw deposit_amount, when a re-price has left the stored deposit above the job's current total", () => {
  const src = readFileSync(new URL("../website/dashboard.html", import.meta.url), "utf8");
  const grab = (name) => {
    const start = src.indexOf("function " + name + "(");
    if (start < 0) throw new Error("not found: " + name);
    let i = src.indexOf("{", start), depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
    }
    throw new Error("unbalanced: " + name);
  };
  // money is `const money = n => ...;` -- a one-line arrow const, not a
  // `function name(` declaration, so it needs its own (simpler) grab: from
  // the declaration up to the statement's closing `;`. The one-liner has no
  // nested `;`, so this is safe.
  const grabConst = (name) => {
    const start = src.indexOf("const " + name + " =");
    if (start < 0) throw new Error("not found: const " + name);
    const end = src.indexOf(";", start);
    if (end < 0) throw new Error("unterminated: const " + name);
    return src.slice(start, end + 1);
  };

  const code = ["depositAskedOf", "netPaid", "balanceOf", "stampMs", "anchoredTotalOf", "billableTotalOf"]
    .map(grab).join("\n\n") + "\n\n" + grabConst("money");

  // The real call site, lifted verbatim rather than retyped -- so a rewrite
  // that changes HOW the deposit is computed (not just what it's called)
  // still gets executed and checked here, exactly as dashboard.html runs it.
  const blockStart = src.indexOf("const contract = billableTotalOf(openJob, anchorOrdersOf(openJob))");
  assert.ok(blockStart >= 0, "the deposit/balance render block moved -- update this test's anchor");
  const innerHTMLStart = src.indexOf("$('jobEstDepositBalance').innerHTML =", blockStart);
  assert.ok(innerHTMLStart >= 0, "could not find the #jobEstDepositBalance render call after the anchor -- update this test's anchor");
  const blockEnd = src.indexOf("`;", innerHTMLStart);
  assert.ok(blockEnd >= 0, "could not find the end of the #jobEstDepositBalance template literal -- update this test's anchor");
  const block = src.slice(blockStart, blockEnd + 2);

  const runBlock = (openJob) => {
    const els = {};
    const $ = (id) => (els[id] ??= { innerHTML: "" });
    // anchorOrdersOf() itself just filters the page-level `orders` array by
    // job id -- change orders are not what this test is about, so it is
    // stubbed to "none", the same as passing an accepted job with no orders
    // would produce for real.
    const anchorOrdersOf = () => [];
    const esc = (s) => String(s);
    const tr = (k) => k;
    const fn = new Function(
      "openJob", "$", "anchorOrdersOf", "esc", "tr",
      code + "\n" + block
    );
    fn(openJob, $, anchorOrdersOf, esc, tr);
    return els.jobEstDepositBalance.innerHTML;
  };

  // A job whose contractor asked for a $5,000 deposit before the price came
  // down to a $3,000 billable total (a re-price, or an accepted price lower
  // than an earlier deposit ask -- deposit_amount is never rewritten by a
  // re-price, only read against the current total at display time).
  const job = {
    deposit_amount: 5000, accepted_total: null, contract_total: 3000, reapproval_required_at: null,
    amount_paid: 0, refunded_amount: 0,
  };
  const html = runBlock(job);
  assert.match(html, /\$3,000\.00/,
    "the deposit row must show the CAPPED $3,000.00 (deposit capped at the job's own $3,000 total), got: " + html);
  assert.doesNotMatch(html, /\$5,000\.00/,
    "the deposit row must NOT show the raw, uncapped $5,000.00 deposit_amount, got: " + html);
});
