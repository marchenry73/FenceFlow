// create-payment-link: open links count against what a job owes, and a new
// link switches the old one off at the processor BEFORE its row is marked.
//
// Run with:  node --test tests/create-payment-link-open-links.test.mjs
//
// This runs the REAL function file, not a copy of its rules. The TypeScript is
// stripped with Node's own stripper, the two imports are swapped for a fake
// Supabase client and the real shared deposit module, and Deno.serve hands the
// real request handler to this file -- so every case below is a real HTTP
// request through both doors, the way the phone and the quote page call it.
// Stripe and Square are a fake fetch that records every call in order. Nothing
// here touches the network, a database, a real key or a real card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { depositFigures } from "../supabase/functions/_shared/quote-deposit.ts";

const FN_PATH = new URL("../supabase/functions/create-payment-link/index.ts", import.meta.url);

const COMPANY = "c0000000-0000-4000-8000-000000000001";
const OTHER_CO = "c0000000-0000-4000-8000-000000000002";
const JOB = "a0000000-0000-4000-8000-00000000000a";
const TOKEN = "b0000000-0000-4000-8000-00000000000b";

// ---------------------------------------------------------------- harness --

/**
 * Loads the real function against the given fakes.
 *
 * `plant` replaces named functions in the loaded file with the given source,
 * to put a known bug back and prove a test can fail. Each name must exist as a
 * function in the file, so a rename cannot turn a plant into a quiet no-op.
 */
function load({ env = {}, db, fetchImpl, plant = {} }) {
  const src = readFileSync(FN_PATH, "utf8");
  let js = stripTypeScriptTypes(src);
  const imports = js.match(/^import .*$/gm) ?? [];
  // Exactly the two this harness supplies. A new import means the harness no
  // longer describes the file, and a quiet pass would be a lie.
  assert.deepEqual(imports.map((l) => l.match(/import \{ (\w+) \}/)?.[1]), ["createClient", "depositFigures"]);
  js = js.replace(/^import .*$/gm, "").replace(/^export /gm, "");
  const planted = Object.entries(plant).map(([name, body]) => {
    assert.match(js, new RegExp(`^(async )?function ${name}\\(`, "m"), `nothing called ${name} to plant over`);
    return `${name} = ${body};`;
  }).join("\n");
  let handler = null;
  const Deno = {
    env: { get: (k) => env[k] },
    serve: (h) => { handler = h; },
  };
  const api = new Function("Deno", "createClient", "depositFigures", "fetch",
    js + "\n" + planted +
    "\nreturn { planOpenLinks, supersedeOpenLinks, stillTakesMoney, sameModeAsKey, pickReusableLink };",
  )(Deno, () => db, depositFigures, fetchImpl);
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return { handler, ...api };
}

/** An in-memory stand-in for the service-role client, recording every write. */
function fakeDb(tables, calls) {
  const t = structuredClone(tables);
  const fail = {};
  let seq = 0;
  class Query {
    constructor(table) {
      this.table = table; this.op = "select"; this.filters = []; this.lim = Infinity; this.returning = false;
    }
    select() { this.returning = true; return this; }
    eq(k, v) { this.filters.push((r) => String(r[k]) === String(v)); return this; }
    or(expr) {
      const alts = expr.split(",").map((p) => {
        const [k, op, ...v] = p.split(".");
        assert.equal(op, "eq", "fake only understands eq inside or()");
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
        const row = { id: `new-${++seq}`, ...this.payload };
        rows.push(row);
        calls.push(["db", "insert", this.table, row.kind, row.amount_cents]);
        return { data: null, error: null };
      }
      if (this.op === "update") {
        hit.forEach((r) => Object.assign(r, this.payload));
        calls.push(["db", "update", this.table, this.payload.status, hit.map((r) => r.id).join(",")]);
        return { data: this.returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
      }
      const out = hit.slice(0, this.lim);
      if (this.mode === "maybe") return { data: out[0] ?? null, error: null };
      if (this.mode === "one") return out[0] ? { data: out[0], error: null } : { data: null, error: { message: "no row" } };
      return { data: out, error: null };
    }
  }
  return {
    tables: t,
    fail,
    from: (table) => new Query(table),
    rpc: async () => ({ data: true, error: null }),
    auth: {
      getUser: async (jwt) => jwt === "office-jwt"
        ? { data: { user: { id: "user-1" } }, error: null }
        : { data: { user: null }, error: { message: "bad jwt" } },
    },
  };
}

/** Stripe and Square, faked, with planted failures on request. */
function fakeProcessors(calls, db, o = {}) {
  let n = 0;
  const switchedOff = new Set();
  const reply = (status, body) => new Response(JSON.stringify(body), { status });
  return async (url, init = {}) => {
    const method = init.method ?? "GET";
    const u = new URL(url);
    calls.push(["fetch", method, u.host.includes("stripe") ? "stripe" : "square", u.pathname]);
    let m;
    if (u.host === "api.stripe.com") {
      const form = Object.fromEntries(new URLSearchParams(init.body ?? ""));
      // Which mode the calling key is in, read from the placeholder's prefix
      // exactly as Stripe reads a real one. Stripe makes objects in the key's
      // own mode and will not show a key an object from the other mode.
      const keyLive = /^Bearer (sk|rk)_live_/.test(String(init.headers?.Authorization ?? ""));
      if (method === "POST" && u.pathname === "/v1/prices") return reply(200, { id: `price_${++n}` });
      if (method === "POST" && u.pathname === "/v1/payment_links") {
        n++;
        return reply(200, {
          id: `plink_new${n}`,
          url: `https://buy.stripe.com/${keyLive ? "" : "test_"}new${n}`,
          livemode: keyLive,
          active: true,
        });
      }
      if (method === "GET" && (m = u.pathname.match(/^\/v1\/payment_links\/([^/]+)$/))) {
        if (o.stripeReadFails) return reply(500, { error: { message: "planted: Stripe is unavailable" } });
        const known = db.tables.job_payments.find((x) => x.stripe_id === m[1]);
        const linkLive = known ? known.livemode === true : keyLive;
        if (linkLive !== keyLive) {
          return reply(404, { error: { message: `No such payment_link: '${m[1]}'; it exists in the other mode` } });
        }
        const active = !switchedOff.has(m[1]) && !(o.inactiveLinks ?? []).includes(m[1]);
        return reply(200, { id: m[1], object: "payment_link", livemode: linkLive, active });
      }
      if (method === "POST" && (m = u.pathname.match(/^\/v1\/payment_links\/([^/]+)$/))) {
        o.onDeactivate?.(m[1], db);
        if (o.stripeDeactivateFails) return reply(500, { error: { message: "planted: Stripe is unavailable" } });
        const active = o.stripeIgnoresDeactivate ? true : form.active !== "false";
        if (!active) switchedOff.add(m[1]);
        return reply(200, { id: m[1], active });
      }
      if (method === "GET" && u.pathname === "/v1/checkout/sessions") {
        return reply(200, { data: o.openSessions?.[u.searchParams.get("payment_link")] ?? [], has_more: false });
      }
      if (method === "POST" && (m = u.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/))) {
        if (o.expireFails) return reply(400, { error: { message: "planted: session is no longer open" } });
        return reply(200, { id: m[1], status: "expired" });
      }
    } else if (u.host.includes("squareup")) {
      if (method === "GET" && u.pathname === "/v2/locations") return reply(200, { locations: [{ id: "LOC1", status: "ACTIVE" }] });
      if (method === "GET" && u.pathname === "/v2/online-checkout/payment-links") {
        return reply(200, { payment_links: o.squareLinks ?? [] });
      }
      if (method === "DELETE" && (m = u.pathname.match(/^\/v2\/online-checkout\/payment-links\/([^/]+)$/))) {
        if (o.squareDeleteFails) return reply(500, { errors: [{ detail: "planted: Square is unavailable" }] });
        return reply(200, { id: m[1], cancelled_order_id: "whatever" });
      }
      if (method === "GET" && (m = u.pathname.match(/^\/v2\/orders\/([^/]+)$/))) {
        const state = o.squareOrders?.[m[1]];
        return state ? reply(200, { order: { id: m[1], state } }) : reply(404, { errors: [{ detail: "not found" }] });
      }
      if (method === "POST" && u.pathname === "/v2/online-checkout/payment-links") {
        const body = JSON.parse(init.body);
        calls.push(["square-idempotency", body.idempotency_key]);
        n++;
        return reply(200, { payment_link: { id: `SQLINK${n}`, order_id: `order_new${n}`, url: `https://sandbox.square.link/u/new${n}` } });
      }
    }
    return reply(404, { error: { message: `unrouted ${method} ${url}` } });
  };
}

function world({ job = {}, links = [], conn = null, env = {}, procs = {}, extraJobs = [], plant = {} } = {}) {
  const calls = [];
  const db = fakeDb({
    companies: [{ id: COMPANY, name: "Test Fence Co", stripe_account_id: null, subscription_plan: "crew" }],
    profiles: [{ id: "user-1", company_id: COMPANY, role: "OWNER" }],
    jobs: [{
      sync_id: JOB, company_id: COMPANY, customer_name: "Pat", deleted_at: null,
      quote_token: TOKEN, quote_approved_at: "2026-09-20T12:00:00Z",
      contract_total: 10000, amount_paid: 0, refunded_amount: 0, deposit_amount: 0, ...job,
    }, ...extraJobs],
    job_payments: links.map((l, i) => ({
      id: `old-${i + 1}`, company_id: COMPANY, job_sync_id: JOB, status: "pending",
      processor: "stripe", livemode: false, fee_cents: 0, external_id: "", payment_url: `https://buy.stripe.com/test_old${i + 1}`,
      stripe_id: `plink_old${i + 1}`, ...l,
    })),
    payment_connections: conn ? [{ company_id: COMPANY, ...conn }] : [],
  }, calls);
  const fetchImpl = fakeProcessors(calls, db, procs);
  const fn = load({ env: { STRIPE_SECRET_KEY: "sk_test_placeholder", ...env }, db, fetchImpl, plant });
  return { ...fn, db, calls };
}

async function office(w, body) {
  const res = await w.handler(new Request("https://fn.test/create-payment-link", {
    method: "POST",
    headers: { Authorization: "Bearer office-jwt", "Content-Type": "application/json" },
    body: JSON.stringify({ jobSyncId: JOB, description: "Fence work", ...body }),
  }));
  return { status: res.status, body: await res.json() };
}

async function homeowner(w, kind = "deposit") {
  const res = await w.handler(new Request("https://fn.test/create-payment-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quoteToken: TOKEN, kind }),
  }));
  return { status: res.status, body: await res.json() };
}

const row = (w, id) => w.db.tables.job_payments.find((r) => r.id === id);
const made = (w) => w.calls.filter((c) => c[0] === "fetch" && c[1] === "POST" &&
  (c[3] === "/v1/payment_links" || c[3] === "/v2/online-checkout/payment-links"));
const inserts = (w) => w.calls.filter((c) => c[0] === "db" && c[1] === "insert");
const at = (w, pred) => w.calls.findIndex(pred);

// ------------------------------------------------ the cap counts open links --

test("the live fault: a $200 job holding a $336.82 balance link refuses a $160 deposit", async () => {
  // 4940d7a0 on 2026-09-21, reproduced. The old cap looked only at settled
  // money ($0), so $160 against $200 passed and both links stood open.
  const w = world({ job: { contract_total: 200 }, links: [{ kind: "balance", amount_cents: 33682 }] });
  const r = await office(w, { amountCents: 16000, kind: "deposit" });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "over_owed_with_open_links");
  assert.match(r.body.error, /already open on this job ask for 336\.82/);
  assert.equal(made(w).length, 0, "no link was made at the processor");
  assert.equal(inserts(w).length, 0, "no row was written");
  assert.equal(row(w, "old-1").status, "pending", "the open link was not touched");
});

test("positive control: the same $160 deposit goes through when nothing else is open", async () => {
  const w = world({ job: { contract_total: 200 } });
  const r = await office(w, { amountCents: 16000, kind: "deposit" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.url, /^https:\/\/buy\.stripe\.com\/test_new/);
  assert.equal(made(w).length, 1);
  assert.equal(inserts(w).length, 1);
});

test("settled + open + requested may reach what is owed plus the $1 slack, and no further", async () => {
  // $10,000 job, $3,000 received, a $2,000 final link open: $5,000 is the room.
  const base = { job: { contract_total: 10000, amount_paid: 3000 }, links: [{ kind: "final", amount_cents: 200000 }] };
  for (const [cents, ok] of [[500000, true], [500100, true], [500101, false]]) {
    const w = world(base);
    const r = await office(w, { amountCents: cents, kind: "deposit" });
    assert.equal(r.status === 200, ok, `${cents}: ${JSON.stringify(r.body)}`);
    if (!ok) {
      assert.equal(r.body.code, "over_owed_with_open_links");
      assert.match(r.body.error, /still owes 7000\.00/);
      assert.match(r.body.error, /at most 5000\.00/);
      assert.equal(made(w).length, 0);
    }
  }
});

test("refunds reduce what counts as settled, exactly as before", async () => {
  // $10,000 job, $5,000 paid, $2,000 refunded -> $7,000 owed. $1,000 final
  // link open -> room $6,000.
  const base = { job: { contract_total: 10000, amount_paid: 5000, refunded_amount: 2000 }, links: [{ kind: "final", amount_cents: 100000 }] };
  assert.equal((await office(world(base), { amountCents: 600000, kind: "deposit" })).status, 200);
  assert.equal((await office(world(base), { amountCents: 600101, kind: "deposit" })).status, 400);
});

test("when open links already cover what is owed, the refusal says there is no room", async () => {
  const w = world({ job: { contract_total: 1000 }, links: [{ kind: "final", amount_cents: 100000 }] });
  const r = await office(w, { amountCents: 5000, kind: "deposit" });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "over_owed_with_open_links");
  assert.match(r.body.error, /covers everything it still owes \(1000\.00\)/);
});

test("the paid-in-full refusal is unchanged, open links or not", async () => {
  for (const links of [[], [{ kind: "final", amount_cents: 5000 }]]) {
    const w = world({ job: { contract_total: 1000, amount_paid: 1000 }, links });
    const r = await office(w, { amountCents: 5000, kind: "final" });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "paid_in_full");
    assert.equal(r.body.error, "This job is already paid in full. Nothing further is owed.");
    assert.equal(made(w).length, 0);
  }
});

test("with nothing open, the over-owed refusal keeps its old wording", async () => {
  const w = world({ job: { contract_total: 1000 } });
  const r = await office(w, { amountCents: 100101, kind: "final" });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "over_owed");
  assert.equal(r.body.error, "That is more than this job still owes (1000.00). Check the amount before asking the customer for it.");
});

test("a job with no contract total is still not capped, but a same-kind link is still replaced", async () => {
  const w = world({ job: { contract_total: 0 }, links: [{ kind: "final", amount_cents: 493793 }, { kind: "deposit", amount_cents: 999999 }] });
  const r = await office(w, { amountCents: 100, kind: "final" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(row(w, "old-1").status, "superseded");
  assert.equal(row(w, "old-2").status, "pending", "another kind is not replaced");
});

test("another company's links on the same job id are neither counted nor touched", async () => {
  const w = world({ job: { contract_total: 1000 } });
  w.db.tables.job_payments.push({
    id: "foreign", company_id: OTHER_CO, job_sync_id: JOB, kind: "final", amount_cents: 100000,
    status: "pending", processor: "stripe", livemode: false, fee_cents: 0, stripe_id: "plink_foreign", payment_url: "x",
  });
  const r = await office(w, { amountCents: 50000, kind: "final" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(row(w, "foreign").status, "pending");
  assert.ok(!w.calls.some((c) => c[3] === "/v1/payment_links/plink_foreign"));
});

test("a failed read of the open links refuses instead of reading as 'none open'", async () => {
  const w = world({ job: { contract_total: 200 }, links: [{ kind: "balance", amount_cents: 33682 }] });
  w.db.fail["job_payments:select"] = "planted: read failed";
  const r = await office(w, { amountCents: 16000, kind: "deposit" });
  assert.equal(r.status, 500);
  assert.equal(r.body.code, "open_links_unreadable");
  assert.equal(w.calls.filter((c) => c[0] === "fetch").length, 0, "no processor call at all");
});

test("a failed read of the job refuses too", async () => {
  const w = world({ job: { contract_total: 200 } });
  w.db.fail["jobs:select"] = "planted: read failed";
  const r = await office(w, { amountCents: 16000, kind: "deposit" });
  assert.equal(r.status, 500);
  assert.equal(made(w).length, 0);
});

// ------------------------------------- replacing a link: processor first --

test("a corrected deposit switches the old link off at Stripe, then marks it, then makes the new one", async () => {
  const w = world({ links: [{ kind: "deposit", amount_cents: 500000 }] });
  const r = await office(w, { amountCents: 600000, kind: "deposit" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const off = at(w, (c) => c[0] === "fetch" && c[3] === "/v1/payment_links/plink_old1");
  const sessions = at(w, (c) => c[0] === "fetch" && c[3] === "/v1/checkout/sessions");
  const mark = at(w, (c) => c[0] === "db" && c[1] === "update" && c[3] === "superseded");
  const create = at(w, (c) => c[0] === "fetch" && c[3] === "/v1/payment_links");
  const insert = at(w, (c) => c[0] === "db" && c[1] === "insert");
  assert.ok(off >= 0 && sessions > off && mark > sessions && create > mark && insert > create,
    `order was ${JSON.stringify(w.calls)}`);
  assert.equal(row(w, "old-1").status, "superseded");
  assert.equal(w.db.tables.job_payments.filter((x) => x.status === "pending").length, 1, "exactly one live link");
});

test("the corrected deposit is judged without the link it replaces", async () => {
  // $5,000 open + $6,000 new would be $11,000 against $10,000 -- but the
  // $5,000 is being switched off, so only the $6,000 counts.
  const w = world({ links: [{ kind: "deposit", amount_cents: 500000 }] });
  assert.equal((await office(w, { amountCents: 600000, kind: "deposit" })).status, 200);
});

test("planted failure: Stripe will not switch the old link off, so no new link and the old row stays pending", async () => {
  const w = world({ links: [{ kind: "deposit", amount_cents: 500000 }], procs: { stripeDeactivateFails: true } });
  const r = await office(w, { amountCents: 600000, kind: "deposit" });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "old_link_still_open");
  assert.match(r.body.error, /could not be switched off/);
  assert.match(r.body.error, /planted: Stripe is unavailable/);
  assert.equal(row(w, "old-1").status, "pending", "never marked superseded while it still takes money");
  assert.equal(made(w).length, 0, "no second link");
  assert.equal(w.calls.filter((c) => c[3] === "/v1/prices").length, 0, "not even a price");
  assert.equal(inserts(w).length, 0);
});

test("planted failure: Stripe answers but the link is still active -- treated as not switched off", async () => {
  const w = world({ links: [{ kind: "deposit", amount_cents: 500000 }], procs: { stripeIgnoresDeactivate: true } });
  const r = await office(w, { amountCents: 600000, kind: "deposit" });
  assert.equal(r.status, 502);
  assert.equal(row(w, "old-1").status, "pending");
  assert.equal(made(w).length, 0);
});

test("a checkout already open on the old link is expired; if it cannot be, nothing is replaced", async () => {
  const sessions = { plink_old1: [{ id: "cs_test_open1" }] };
  const ok = world({ links: [{ kind: "deposit", amount_cents: 500000 }], procs: { openSessions: sessions } });
  assert.equal((await office(ok, { amountCents: 600000, kind: "deposit" })).status, 200);
  assert.ok(ok.calls.some((c) => c[3] === "/v1/checkout/sessions/cs_test_open1/expire"));

  const bad = world({ links: [{ kind: "deposit", amount_cents: 500000 }], procs: { openSessions: sessions, expireFails: true } });
  const r = await office(bad, { amountCents: 600000, kind: "deposit" });
  assert.equal(r.status, 502);
  assert.equal(row(bad, "old-1").status, "pending");
  assert.equal(made(bad).length, 0);
});

test("the old link is paid while being switched off: its row stays paid and no new link is made", async () => {
  const w = world({
    links: [{ kind: "deposit", amount_cents: 500000 }],
    procs: { onDeactivate: (id, db) => { db.tables.job_payments.find((x) => x.stripe_id === id).status = "paid"; } },
  });
  const r = await office(w, { amountCents: 600000, kind: "deposit" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "open_link_changed");
  assert.equal(row(w, "old-1").status, "paid", "the webhook's paid is never overwritten");
  assert.equal(made(w).length, 0);
});

test("switched off but the row could not be marked: refused, and a retry finishes the job", async () => {
  const w = world({ links: [{ kind: "deposit", amount_cents: 500000 }] });
  w.db.fail["job_payments:update"] = "planted: write failed";
  const r = await office(w, { amountCents: 600000, kind: "deposit" });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "old_link_not_recorded");
  assert.equal(made(w).length, 0);
  delete w.db.fail["job_payments:update"];
  const again = await office(w, { amountCents: 600000, kind: "deposit" });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(row(w, "old-1").status, "superseded");
});

test("handing back an identical open link first switches off its duplicates", async () => {
  // c1491dd4 on 2026-09-21: two identical $4,937.93 final links, four
  // minutes apart, plus a $1 one. Asking again used to hand one back and leave
  // all three payable.
  const w = world({ job: { contract_total: 0 }, links: [
    { kind: "final", amount_cents: 493793 },
    { kind: "final", amount_cents: 493793 },
    { kind: "final", amount_cents: 100 },
  ] });
  const r = await office(w, { amountCents: 493793, kind: "final" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.url, "https://buy.stripe.com/test_old1");
  assert.equal(row(w, "old-1").status, "pending", "the one handed back stays open");
  assert.equal(row(w, "old-2").status, "superseded");
  assert.equal(row(w, "old-3").status, "superseded");
  assert.equal(made(w).length, 0, "no new link");

  const bad = world({ job: { contract_total: 0 }, links: [
    { kind: "final", amount_cents: 493793 }, { kind: "final", amount_cents: 493793 },
  ], procs: { stripeDeactivateFails: true } });
  const refused = await office(bad, { amountCents: 493793, kind: "final" });
  assert.equal(refused.status, 502, "a duplicate that cannot be switched off stops the hand-back");
  assert.equal(refused.body.url, undefined);
  assert.equal(row(bad, "old-2").status, "pending");
});

// ------------------------------------------------------------ test vs live --

test("after go-live a test-mode link neither counts nor needs a Stripe call to be replaced", async () => {
  const env = { STRIPE_SECRET_KEY: "sk_live_placeholder" };
  // Other kind, test mode, under a live key: cannot take real money, not counted.
  const a = world({ env, job: { contract_total: 1000 }, links: [{ kind: "final", amount_cents: 90000, livemode: false }] });
  assert.equal((await office(a, { amountCents: 50000, kind: "deposit" })).status, 200);

  // Same kind, test mode, under a live key: marked without calling Stripe --
  // a live key cannot even see it.
  const b = world({ env, links: [{ kind: "deposit", amount_cents: 500000, livemode: false }] });
  assert.equal((await office(b, { amountCents: 600000, kind: "deposit" })).status, 200);
  assert.equal(row(b, "old-1").status, "superseded");
  assert.ok(!b.calls.some((c) => c[3] === "/v1/payment_links/plink_old1"));
});

test("control: under a test key the same test-mode link counts and is switched off at Stripe", async () => {
  const a = world({ job: { contract_total: 1000 }, links: [{ kind: "final", amount_cents: 90000, livemode: false }] });
  assert.equal((await office(a, { amountCents: 50000, kind: "deposit" })).status, 400);
  const b = world({ links: [{ kind: "deposit", amount_cents: 500000, livemode: false }] });
  assert.equal((await office(b, { amountCents: 600000, kind: "deposit" })).status, 200);
  assert.ok(b.calls.some((c) => c[3] === "/v1/payment_links/plink_old1"));
});

test("a live-mode link always counts, whatever the key", async () => {
  const w = world({ job: { contract_total: 1000 }, links: [{ kind: "final", amount_cents: 90000, livemode: true }] });
  assert.equal((await office(w, { amountCents: 50000, kind: "deposit" })).status, 400);
});

// ------------------- handing back an open link: same mode, still active --
//
// The hand-back looked up a pending row by job, kind and amount and returned
// it as it was. It never asked which mode the row was made in, nor whether the
// processor would still take money on it. So the day the key goes live, a
// test-mode deposit link of the same amount was handed to the customer: HTTP
// 200, no processor call, and a test checkout that declines every real card.

const LIVE = { STRIPE_SECRET_KEY: "sk_live_placeholder" };
const liveLink = { kind: "deposit", amount_cents: 50000, livemode: true, payment_url: "https://buy.stripe.com/live_old1" };
const testLink = { kind: "deposit", amount_cents: 50000, livemode: false };

/**
 * The request got a NEW link, made at the processor and recorded, and the
 * given open row was neither handed back nor left payable beside it.
 */
function assertFreshLink(w, r, oldId) {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.notEqual(r.body.url, row(w, oldId).payment_url, "the old link was handed back");
  assert.equal(made(w).length, 1, "exactly one new link was made at the processor");
  assert.equal(inserts(w).length, 1, "and recorded");
  assert.equal(row(w, oldId).status, "superseded", "the old row is not left pending beside the new one");
}

const askedStripeAbout = (w, id) => w.calls.some((c) => c[0] === "fetch" && c[3] === `/v1/payment_links/${id}`);

test("the proved hole: under a live key a pending TEST link of the same kind and amount is not handed back", async () => {
  const w = world({ env: LIVE, links: [testLink] });
  const r = await office(w, { amountCents: 50000, kind: "deposit" });
  assertFreshLink(w, r, "old-1");
  assert.equal(r.body.livemode, true, "the customer gets a live checkout");
  assert.doesNotMatch(r.body.url, /\/test_/);
  assert.ok(!askedStripeAbout(w, "plink_old1"), "a live key is never asked about a test-mode link");
});

test("the proved hole, homeowner door: a stale test deposit link is not handed to the customer", async () => {
  // deposit_amount 400 on a 1000 job -> 40000 cents due, the same amount as the old link.
  const w = world({ env: LIVE, job: { contract_total: 1000, deposit_amount: 400 }, links: [{ ...testLink, amount_cents: 40000 }] });
  const r = await homeowner(w);
  assertFreshLink(w, r, "old-1");
  assert.equal(r.body.livemode, true);
  assert.doesNotMatch(r.body.url, /\/test_/);
});

test("positive control: under a live key a pending LIVE link Stripe confirms active IS handed back", async () => {
  const w = world({ env: LIVE, links: [liveLink] });
  const r = await office(w, { amountCents: 50000, kind: "deposit" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.url, "https://buy.stripe.com/live_old1");
  assert.equal(made(w).length, 0, "no new link");
  assert.equal(inserts(w).length, 0, "no new row");
  assert.equal(row(w, "old-1").status, "pending", "the link handed back stays open");
  assert.ok(w.calls.some((c) => c[1] === "GET" && c[3] === "/v1/payment_links/plink_old1"), "Stripe was asked first");
});

test("a live link Stripe reports inactive is not handed back; it is replaced", async () => {
  const w = world({ env: LIVE, links: [liveLink], procs: { inactiveLinks: ["plink_old1"] } });
  const r = await office(w, { amountCents: 50000, kind: "deposit" });
  assertFreshLink(w, r, "old-1");
});

test("when the liveness check itself fails, the link is not handed back and the normal path runs", async () => {
  const w = world({ env: LIVE, links: [liveLink], procs: { stripeReadFails: true } });
  const r = await office(w, { amountCents: 50000, kind: "deposit" });
  assertFreshLink(w, r, "old-1");
  // The normal path still switched the old one off before making the new one.
  assert.ok(w.calls.some((c) => c[1] === "POST" && c[3] === "/v1/payment_links/plink_old1"));
});

test("a test row listed first does not hide a good live row behind it", async () => {
  const w = world({ env: LIVE, links: [testLink, { ...liveLink, payment_url: "https://buy.stripe.com/live_old2" }] });
  const r = await office(w, { amountCents: 50000, kind: "deposit" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.url, "https://buy.stripe.com/live_old2");
  assert.equal(made(w).length, 0);
  assert.equal(row(w, "old-1").status, "superseded", "the test duplicate is retired beside it");
  assert.equal(row(w, "old-2").status, "pending");
  assert.ok(!askedStripeAbout(w, "plink_old1"));
});

test("Square: a link whose order is still OPEN is handed back; a CANCELED one is replaced", async () => {
  const conn = { processor: "square", external_id: "MERCHANT1", access_token: "sq-placeholder-token" };
  const sq = { kind: "deposit", amount_cents: 500000, processor: "square", stripe_id: null,
    external_id: "order_old1", payment_url: "https://sandbox.square.link/u/old1" };

  const open = world({ conn, links: [sq], procs: { squareOrders: { order_old1: "OPEN" } } });
  const r1 = await office(open, { amountCents: 500000, kind: "deposit" });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.url, "https://sandbox.square.link/u/old1");
  assert.equal(made(open).length, 0);
  assert.ok(open.calls.some((c) => c[1] === "GET" && c[3] === "/v2/orders/order_old1"), "Square was asked first");

  const gone = world({ conn, links: [sq], procs: { squareLinks: [], squareOrders: { order_old1: "CANCELED" } } });
  assertFreshLink(gone, await office(gone, { amountCents: 500000, kind: "deposit" }), "old-1");

  // Square gone to production: a sandbox link is never handed back, nor asked about.
  const prod = world({ conn, env: { SQUARE_ENVIRONMENT: "production" }, links: [sq], procs: { squareOrders: { order_old1: "OPEN" } } });
  assertFreshLink(prod, await office(prod, { amountCents: 500000, kind: "deposit" }), "old-1");
  assert.ok(!prod.calls.some((c) => c[3] === "/v2/orders/order_old1"));
});

test("planted failure: with the old hand-back rule put back, the go-live test catches it", async () => {
  // The rule before this fix: the first pending row of that kind and amount,
  // as it is. The same assertions the real test makes must now fail.
  const oldRule = "async (rows) => (Array.isArray(rows) ? rows[0] : null) ?? null";
  const w = world({ env: LIVE, links: [testLink], plant: { pickReusableLink: oldRule } });
  const r = await office(w, { amountCents: 50000, kind: "deposit" });
  assert.equal(r.status, 200);
  assert.equal(r.body.url, "https://buy.stripe.com/test_old1", "the planted bug hands back the test checkout");
  assert.equal(made(w).length, 0, "without asking Stripe for anything");
  assert.throws(() => assertFreshLink(w, r, "old-1"), assert.AssertionError);
});

test("planted failure: with the processor's answer ignored, the inactive-link test catches it", async () => {
  const w = world({ env: LIVE, links: [liveLink], procs: { inactiveLinks: ["plink_old1"] },
    plant: { stripeLinkStillActive: "async () => true" } });
  const r = await office(w, { amountCents: 50000, kind: "deposit" });
  assert.equal(r.body.url, "https://buy.stripe.com/live_old1", "the planted bug hands back a dead link");
  assert.throws(() => assertFreshLink(w, r, "old-1"), assert.AssertionError);
});

// ------------------------------------------------------------------ Square --

const SQ = { processor: "square", external_id: "MERCHANT1", access_token: "sq-placeholder-token" };
const sqLink = { kind: "deposit", amount_cents: 500000, processor: "square", stripe_id: null, external_id: "order_old1" };

test("Square: the old link is found by its order, deleted, then marked, then the new one is made", async () => {
  const w = world({ conn: SQ, links: [sqLink], procs: { squareLinks: [{ id: "SQOLD", order_id: "order_old1", url: "u" }] } });
  const r = await office(w, { amountCents: 600000, kind: "deposit" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const del = at(w, (c) => c[1] === "DELETE" && c[3] === "/v2/online-checkout/payment-links/SQOLD");
  const mark = at(w, (c) => c[0] === "db" && c[3] === "superseded");
  const create = at(w, (c) => c[1] === "POST" && c[3] === "/v2/online-checkout/payment-links");
  assert.ok(del >= 0 && mark > del && create > mark, JSON.stringify(w.calls));
  assert.equal(row(w, "old-1").status, "superseded");
});

test("Square: replacing moves the idempotency key, and a plain request keeps the old one", async () => {
  const keyOf = (w) => w.calls.find((c) => c[0] === "square-idempotency")?.[1];
  const plain = world({ conn: SQ });
  await office(plain, { amountCents: 600000, kind: "deposit" });
  const replacing = world({ conn: SQ, links: [sqLink], procs: { squareLinks: [{ id: "SQOLD", order_id: "order_old1" }] } });
  await office(replacing, { amountCents: 600000, kind: "deposit" });
  const { createHash } = await import("node:crypto");
  assert.equal(keyOf(plain), createHash("sha256").update(`${JOB}-deposit-600000`).digest("hex").slice(0, 45),
    "unchanged when nothing is replaced");
  assert.notEqual(keyOf(replacing), keyOf(plain));
});

test("planted failure: Square will not delete the old link, so nothing is replaced", async () => {
  const w = world({ conn: SQ, links: [sqLink], procs: { squareLinks: [{ id: "SQOLD", order_id: "order_old1" }], squareDeleteFails: true } });
  const r = await office(w, { amountCents: 600000, kind: "deposit" });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "old_link_still_open");
  assert.equal(row(w, "old-1").status, "pending");
  assert.equal(made(w).length, 0);
});

test("Square: a link missing from the listing counts as gone only if its order reads CANCELED", async () => {
  const gone = world({ conn: SQ, links: [sqLink], procs: { squareLinks: [], squareOrders: { order_old1: "CANCELED" } } });
  assert.equal((await office(gone, { amountCents: 600000, kind: "deposit" })).status, 200);
  assert.equal(row(gone, "old-1").status, "superseded");

  // Missing from the list and the order still OPEN (or unknown to this
  // account -- a different, reconnected Square account): not proven off.
  for (const orders of [{ order_old1: "OPEN" }, {}]) {
    const w = world({ conn: SQ, links: [sqLink], procs: { squareLinks: [], squareOrders: orders } });
    const r = await office(w, { amountCents: 600000, kind: "deposit" });
    assert.equal(r.status, 502, JSON.stringify(orders));
    assert.equal(row(w, "old-1").status, "pending");
    assert.equal(made(w).length, 0);
  }
});

test("an old Square link cannot be replaced once the company has moved to Stripe", async () => {
  const w = world({ links: [sqLink] });
  const r = await office(w, { amountCents: 600000, kind: "deposit" });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Square is no longer connected/);
  assert.equal(row(w, "old-1").status, "pending");
  assert.equal(made(w).length, 0);
});

// ------------------------------------------------------ the homeowner door --

test("homeowner door: a deposit beside an open office balance link is refused, in the page's own language", async () => {
  const w = world({ job: { contract_total: 1000, deposit_amount: 400 }, links: [{ kind: "final", amount_cents: 100000 }] });
  const r = await homeowner(w);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "over_owed_with_open_links");
  // No English sentence: quote.html falls back to its translated
  // paymentPageError when `error` is absent.
  assert.equal(r.body.error, undefined);
  assert.equal(made(w).length, 0);

  const page = readFileSync(new URL("../website/quote.html", import.meta.url), "utf8");
  assert.match(page, /throw new Error\(j\.error\|\|tr\('paymentPageError'\)\)/);
  assert.equal((page.match(/paymentPageError:/g) ?? []).length, 3, "en, es and fr all carry it");
});

test("homeowner door: positive control -- the same deposit goes through with nothing else open", async () => {
  const w = world({ job: { contract_total: 1000, deposit_amount: 400 } });
  const r = await homeowner(w);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(inserts(w).length, 1);
  assert.equal(inserts(w)[0][4], 40000);
});

test("homeowner door: a changed deposit replaces the office's older deposit link", async () => {
  const w = world({ job: { contract_total: 1000, deposit_amount: 400 }, links: [{ kind: "deposit", amount_cents: 30000 }] });
  const r = await homeowner(w);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(row(w, "old-1").status, "superseded");
});

test("homeowner door: a processor failure while replacing gives no English paragraph either", async () => {
  const w = world({ job: { contract_total: 1000, deposit_amount: 400 }, links: [{ kind: "deposit", amount_cents: 30000 }], procs: { stripeDeactivateFails: true } });
  const r = await homeowner(w);
  assert.equal(r.status, 502);
  assert.equal(r.body.error, undefined);
  assert.equal(row(w, "old-1").status, "pending");
});

// ---------------------------------------------------- the pure pieces alone --

test("planOpenLinks and supersedeOpenLinks, lifted and called directly", async () => {
  const { planOpenLinks, supersedeOpenLinks } = world();
  const test_ = { stripe: false, square: false };
  const p = planOpenLinks({ contract_total: 100, amount_paid: 0, refunded_amount: 0 },
    [{ id: "a", kind: "deposit", amount_cents: 4000 }, { id: "b", kind: "final", amount_cents: 5000 }],
    { kind: "deposit", amountCents: 5000 }, test_);
  assert.equal(p.ok, true);
  assert.deepEqual(p.replace.map((r) => r.id), ["a"]);
  const q = planOpenLinks({ contract_total: 100 }, [{ id: "b", kind: "final", amount_cents: 5000 }],
    { kind: "deposit", amountCents: 5101 }, test_);
  assert.equal(q.ok, false);
  assert.equal(q.openCents, 5000);

  const order = [];
  const res = await supersedeOpenLinks([{ id: "x", kind: "deposit" }, { id: "y", kind: "deposit" }], {
    takesMoney: () => true,
    switchOff: async (r) => { order.push("off:" + r.id); if (r.id === "y") throw new Error("planted"); },
    markSuperseded: async (r) => { order.push("mark:" + r.id); return true; },
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, "old_link_still_open");
  assert.deepEqual(order, ["off:x", "mark:x", "off:y"], "y is never marked after its switch-off failed");
});

test("pickReusableLink and sameModeAsKey, lifted and called directly", async () => {
  const { pickReusableLink, sameModeAsKey } = world();
  const liveKey = { stripe: true, square: false };
  const testKey = { stripe: false, square: false };

  assert.equal(sameModeAsKey({ processor: "stripe", livemode: true }, liveKey), true);
  assert.equal(sameModeAsKey({ processor: "stripe", livemode: false }, liveKey), false);
  assert.equal(sameModeAsKey({ processor: "stripe", livemode: null }, liveKey), false, "unknown mode reads as test");
  assert.equal(sameModeAsKey({ processor: "stripe", livemode: true }, testKey), false, "a live link under a test key is no match either");
  assert.equal(sameModeAsKey({ processor: "stripe", livemode: null }, testKey), true);
  assert.equal(sameModeAsKey({ processor: "paypal", livemode: false }, testKey), false);

  const asked = [];
  const t = { id: "t", payment_url: "u-t", processor: "stripe", livemode: false };
  const l = { id: "l", payment_url: "u-l", processor: "stripe", livemode: true };
  const yes = async (r) => { asked.push(r.id); return true; };
  assert.equal((await pickReusableLink([t, l], liveKey, yes))?.id, "l");
  assert.deepEqual(asked, ["l"], "the test row is never sent to the processor");
  assert.equal(await pickReusableLink([t], liveKey, yes), null);
  assert.equal(await pickReusableLink([l], liveKey, async () => false), null, "inactive is a no");
  assert.equal(await pickReusableLink([l], liveKey, async () => { throw new Error("planted"); }), null, "a failed check is a no");
  assert.equal(await pickReusableLink([l], liveKey, async () => "yes"), null, "only a real true is a yes");
  assert.equal(await pickReusableLink([{ ...l, payment_url: "" }], liveKey, yes), null, "no URL, nothing to hand back");
  assert.equal(await pickReusableLink(null, liveKey, yes), null);
});
