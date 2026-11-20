/**
 * A PAYMENT LINK MAY BE PAID ONCE, AND A CHARGE THE WEBHOOK BOOKED FIRST IS
 * NOT A FAILURE.
 *
 *     node --test tests/a179-payment-link-is-single-use.test.mjs
 *
 * ------------------------------------------------------------------
 * TWO FIXES FROM THE A4 MONEY AUDIT (20 Nov 2026)
 * ------------------------------------------------------------------
 * #1, the reusable link. Stripe Payment Links are reusable by default. This
 * file never set a restriction, and nothing deactivated a link after it was
 * paid -- the only deactivation here is on the REPLACEMENT path, and the
 * webhook never calls it. So a customer who paid a $2,000 deposit could
 * reopen the emailed link and pay again. Stripe would hold $4,000, the books
 * would say $2,000, and nobody would be told, because the webhook read the
 * second completed session as a duplicate delivery.
 *
 * `restrictions[completed_sessions][limit]=1` is the half that stops the
 * money moving at all. (The other half -- recording a second payment loudly
 * instead of silently -- is in the webhook and tested in a177. Both exist
 * because links already in customers' inboxes carry no restriction.)
 *
 * #3b, the charge the webhook got to first. The off-session charge confirms
 * the PaymentIntent and only THEN inserts its pending row, so Stripe's
 * payment_intent.succeeded can arrive in between. The webhook now writes that
 * row itself from the intent's metadata -- which then collides with this
 * insert on the partial unique index over (processor, external_id). The money
 * is charged AND recorded in that case, so answering the office "charged but
 * not recorded, do not charge again" would be alarming and wrong.
 *
 * Runs the REAL function file: TypeScript stripped with Node's own stripper,
 * the Supabase client and Stripe both faked, Deno.serve's handler driven by a
 * real HTTP request. Nothing here touches the network or a real key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as quoteDeposit from "../supabase/functions/_shared/quote-deposit.ts";

const FN_PATH = new URL("../supabase/functions/create-payment-link/index.ts", import.meta.url);
const SRC = readFileSync(FN_PATH, "utf8");

const COMPANY = "c0000000-0000-4000-8000-000000000001";
const JOB = "a0000000-0000-4000-8000-00000000000a";

// ---------------------------------------------------------------- harness --

function load({ db, fetchImpl, env = {} }) {
  let js = stripTypeScriptTypes(SRC);
  const importRe = /^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";?[ \t]*$/gm;
  const shared = {};
  for (const [, list, from] of js.matchAll(importRe)) {
    const names = list.split(",").map((n) => n.trim()).filter(Boolean);
    if (/supabase-js/.test(from)) assert.deepEqual(names, ["createClient"]);
    else if (from === "../_shared/quote-deposit.ts") {
      for (const n of names) { assert.ok(n in quoteDeposit, `no ${n} in the shared module`); shared[n] = quoteDeposit[n]; }
    } else assert.fail(`an import the harness does not supply: ${from}`);
  }
  js = js.replace(importRe, "").replace(/^export /gm, "");
  assert.doesNotMatch(js, /^import /m);
  const names = Object.keys(shared);
  let handler = null;
  const vars = { STRIPE_SECRET_KEY: "sk_test_placeholder", ...env };
  const Deno = { env: { get: (k) => vars[k] }, serve: (h) => { handler = h; } };
  new Function("Deno", "createClient", "fetch", ...names, js)(
    Deno, () => db, fetchImpl, ...names.map((n) => shared[n]),
  );
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

function fakeDb(tables) {
  const t = structuredClone(tables);
  const fail = {};
  let seq = 0;
  class Query {
    constructor(table) { this.table = table; this.op = "select"; this.filters = []; this.lim = Infinity; this.returning = false; }
    select() { this.returning = true; return this; }
    eq(k, v) { this.filters.push((r) => String(r[k]) === String(v)); return this; }
    or(expr) {
      const alts = expr.split(",").map((p) => {
        const [k, op, ...v] = p.split(".");
        assert.equal(op, "eq", "the fake only understands eq inside or()");
        return { k, v: v.join(".") };
      });
      this.filters.push((r) => alts.some((a) => String(r[a.k]) === a.v));
      return this;
    }
    order() { return this; }
    limit(n) { this.lim = n; return this; }
    insert(row) { this.op = "insert"; this.payload = row; return this; }
    update(patch) { this.op = "update"; this.payload = patch; return this; }
    maybeSingle() { this.mode = "maybe"; return this.run(); }
    single() { this.mode = "one"; return this.run(); }
    then(ok, bad) { return this.run().then(ok, bad); }
    async run() {
      const planted = fail[`${this.table}:${this.op}`];
      if (planted) return { data: null, error: { message: planted } };
      const rows = (t[this.table] ??= []);
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "insert") {
        /* The partial unique index over (processor, external_id), modelled,
           because the whole of #3b turns on this collision really happening. */
        if (this.table === "job_payments" && this.payload.external_id) {
          const clash = rows.find((r) => String(r.processor) === String(this.payload.processor) &&
            String(r.external_id ?? "") === String(this.payload.external_id));
          if (clash) {
            return { data: null, error: { code: "23505",
              message: 'duplicate key value violates unique constraint "job_payments_processor_external_uidx"' } };
          }
        }
        rows.push({ id: `new-${++seq}`, ...this.payload });
        return { data: null, error: null };
      }
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
  const api = {
    tables: t, fail,
    from: (table) => new Query(table),
    rpc: async () => ({ data: true, error: null }),
    auth: {
      getUser: async (jwt) => jwt === "office-jwt"
        ? { data: { user: { id: "user-1" } }, error: null }
        : { data: { user: null }, error: { message: "bad jwt" } },
    },
  };
  return api;
}

/** Stripe, faked, recording the form body of every POST. */
function fakeStripe(posts) {
  let n = 0;
  const reply = (status, body) => new Response(JSON.stringify(body), { status });
  return async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    if (u.host !== "api.stripe.com") throw new Error("unexpected host: " + url);
    const form = Object.fromEntries(new URLSearchParams(init.body ?? ""));
    if (method === "POST") posts.push({ path: u.pathname, form });
    if (method === "POST" && u.pathname === "/v1/prices") return reply(200, { id: `price_${++n}` });
    if (method === "POST" && u.pathname === "/v1/payment_links") {
      n++;
      return reply(200, { id: `plink_new${n}`, url: `https://buy.stripe.com/test_new${n}`, livemode: false, active: true });
    }
    if (method === "POST" && u.pathname === "/v1/payment_intents") {
      n++;
      return reply(200, { id: "pi_offsession", status: "succeeded", livemode: false });
    }
    if (method === "GET" && u.pathname === "/v1/checkout/sessions") return reply(200, { data: [], has_more: false });
    return reply(404, { error: { message: `unrouted ${method} ${url}` } });
  };
}

function world({ job = {}, payments = [] } = {}) {
  const posts = [];
  const db = fakeDb({
    companies: [{ id: COMPANY, name: "Test Fence Co", stripe_account_id: null, subscription_plan: "crew" }],
    profiles: [{ id: "user-1", company_id: COMPANY, role: "OWNER" }],
    jobs: [{
      sync_id: JOB, company_id: COMPANY, customer_name: "Pat", deleted_at: null,
      quote_approved_at: "2026-09-20T12:00:00Z", contract_total: 10000,
      amount_paid: 0, refunded_amount: 0, deposit_amount: 0, ...job,
    }],
    job_payments: payments,
    payment_connections: [],
  });
  return { handler: load({ db, fetchImpl: fakeStripe(posts) }), db, posts };
}

async function office(w, body) {
  const res = await w.handler(new Request("https://fn.test/create-payment-link", {
    method: "POST",
    headers: { Authorization: "Bearer office-jwt", "Content-Type": "application/json" },
    body: JSON.stringify({ jobSyncId: JOB, description: "Fence work", ...body }),
  }));
  return { status: res.status, body: await res.json() };
}

const linkPost = (w) => w.posts.find((p) => p.path === "/v1/payment_links");

// ------------------------------------------------------------------ #1 ----

test("a new Payment Link is restricted to ONE completed session", async () => {
  const w = world();
  const r = await office(w, { amountCents: 200000, kind: "deposit" });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const made = linkPost(w);
  assert.ok(made, "no Payment Link was created, so this test proves nothing");
  assert.equal(made.form["restrictions[completed_sessions][limit]"], "1",
    "the link is reusable: the customer can reopen the emailed link and pay a second time, " +
    "and the webhook's idempotency guard reads that as a duplicate delivery and says nothing");
});

test("CONTROL: the restriction is really read off the request, not assumed", async () => {
  // Without this, the assertion above would also pass against a fake that
  // echoed any key it was asked for.
  const w = world();
  await office(w, { amountCents: 200000, kind: "deposit" });
  const made = linkPost(w);
  assert.equal(made.form["restrictions[completed_sessions][limit_that_is_not_real]"], undefined);
  assert.equal(made.form["line_items[0][quantity]"], "1", "and the form really is the link's form");
});

test("the restriction does not disturb what was already on the link", async () => {
  const w = world();
  await office(w, { amountCents: 200000, kind: "deposit" });
  const f = linkPost(w).form;
  assert.equal(f["metadata[job_sync_id]"], JOB);
  assert.equal(f["metadata[company_id]"], COMPANY);
  assert.equal(f["metadata[kind]"], "deposit");
  assert.ok(f["line_items[0][price]"], "the price is still attached");
});

// ----------------------------------------------------------------- #3b ----

test("a charge the webhook already recorded is not reported as unrecorded", async () => {
  /* The race, staged: the webhook has written the row for this intent from
     the intent's own metadata before create-payment-link gets to its insert.
     The money is charged AND on the books, so the office must not be told to
     stop and call for help. */
  const w = world({
    job: { stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_1", card_consent_at: "2026-10-01T00:00:00Z" },
    payments: [{
      id: "jp-webhook", company_id: COMPANY, job_sync_id: JOB, status: "paid",
      processor: "stripe", external_id: "pi_offsession", amount_cents: 300000, livemode: false,
    }],
  });

  const r = await office(w, {
    amountCents: 300000, kind: "balance", chargeSavedCard: true, clientChargeId: "cc-1",
  });

  assert.equal(r.status, 200, "the charge went through and is recorded: " + JSON.stringify(r.body));
  assert.notEqual(r.body.code, "charge_unrecorded");
  assert.equal(r.body.charged, true);
  assert.equal(w.db.tables.job_payments.filter((p) => p.external_id === "pi_offsession").length, 1,
    "and there is still exactly one row for the intent, not two");
});

test("a REAL insert failure is still reported as unrecorded", async () => {
  // The fix must not turn every write failure into a shrug. Only the
  // collision with a row that already holds this intent is forgiven, and it
  // is forgiven by reading the row back, not by parsing the error text.
  const w = world({
    job: { stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_1", card_consent_at: "2026-10-01T00:00:00Z" },
  });
  w.db.fail["job_payments:insert"] = "planted: the database is unavailable";

  const r = await office(w, {
    amountCents: 300000, kind: "balance", chargeSavedCard: true, clientChargeId: "cc-2",
  });

  assert.equal(r.status, 500);
  assert.equal(r.body.code, "charge_unrecorded",
    "a charge that really is unrecorded must still say so -- the books and Stripe disagree");
  assert.match(r.body.error, /Do not charge again/);
});
