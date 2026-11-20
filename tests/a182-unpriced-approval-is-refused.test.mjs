/**
 * AN APPROVAL ON A JOB THE SERVER HAS NOT PRICED IS REFUSED.
 *
 *     node --test tests/a182-unpriced-approval-is-refused.test.mjs
 *
 * ------------------------------------------------------------------
 * THE DEFECT (A4 finding #6, 20 November 2026)
 * ------------------------------------------------------------------
 * `pageFigures` falls back to the material lines plus tax when the server has
 * no `contract_total`:
 *
 *     const total = money.total > 0 ? money.total : roundToCents(subtotal + tax);
 *
 * That figure has no labour, no gates, no markup and no discount in it.
 * Printing it is one thing. RECORDING it as the price the customer agreed to
 * is another, and nothing stopped that: the "price that collapsed" guard only
 * refuses a figure BELOW one already agreed, so on a FIRST approval it cannot
 * fire at all. Materials and tax at $4,280 against a real price near $8,000
 * became `accepted_total`, and `billableTotal` never looked at the live figure
 * again -- the balance link billed $4,280 for ever.
 *
 * The file's own rule, written a few lines above about the deposit cap, is the
 * one that was missing here: "a job priced at zero is one that has not been
 * priced, not one that is free."
 *
 * MEASURED BEFORE CHOOSING A REFUSAL: of the ten quote links ever sent, none
 * went out on an unpriced job, and of the six jobs ever approved, none was
 * approved unpriced. So this refuses something that has never happened and
 * stops it starting, rather than repairing a state anyone is in.
 *
 * ------------------------------------------------------------------
 * HOW IT TESTS IT
 * ------------------------------------------------------------------
 * The REAL quote-view handler runs here, harness recipe from
 * tests/a69-after-approval.test.mjs: the TypeScript stripped by Node's own
 * stripper, the real shared modules, a fake Supabase client, and the real
 * request handler that `Deno.serve` is handed -- so each case below is a real
 * HTTP request through the real door.
 *
 * The canary plants the guard back off and watches materials-plus-tax land in
 * `accepted_total`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as quoteDeposit from "../supabase/functions/_shared/quote-deposit.ts";
import * as jobPush from "../supabase/functions/_shared/job-push.ts";
import * as pushRecipients from "../supabase/functions/_shared/push-recipients.ts";
import * as paymentsReady from "../supabase/functions/_shared/payments-ready.ts";

const COMPANY = "c1820000-0000-4000-8000-000000000001";
const JOB = "a1820000-0000-4000-8000-00000000000a";
const JOB_ID = "11820000-0000-4000-8000-000000000001";
const TOKEN = "b1820000-0000-4000-8000-00000000000b";

const SHARED = {
  "../_shared/quote-deposit.ts": quoteDeposit,
  "../_shared/job-push.ts": jobPush,
  "../_shared/push-recipients.ts": pushRecipients,
  "../_shared/payments-ready.ts": paymentsReady,
};
const QUOTE_VIEW = new URL("../supabase/functions/quote-view/index.ts", import.meta.url);

/**
 * The guard, switched off -- the file as it behaved before 20 Nov 2026.
 *
 * `serverPriced` is forced true, which is exactly what the absence of this
 * check amounted to: the handler went straight on and recorded `figures.total`,
 * fallback and all.
 *
 * The mutation point is asserted present first. A canary that silently failed
 * to mutate anything would "pass" by testing the fixed code twice, which is
 * the blind spot this project keeps writing rules about.
 */
const NO_GUARD = (js) => {
  const needle = "serverPriced: money.total > 0.005,";
  assert.ok(js.includes(needle),
    "the canary's mutation point has moved; this test is no longer testing the old code");
  return js.replace(needle, "serverPriced: true,");
};

function load(db, mutate = (js) => js) {
  let js = stripTypeScriptTypes(readFileSync(QUOTE_VIEW, "utf8"));
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
  js = mutate(js.replace(importRe, "").replace(/^export /gm, ""));
  assert.doesNotMatch(js, /^import /m, "an import the harness did not strip");
  let handler = null;
  const Deno = { env: { get: () => undefined }, serve: (h) => { handler = h; } };
  const names = Object.keys(provided);
  new Function("Deno", "fetch", ...names, js)(
    Deno,
    async () => new Response("{}", { status: 404 }),
    ...names.map((n) => provided[n]),
  );
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

/** An in-memory service-role client that records every write. */
function fakeDb(tables) {
  const t = structuredClone(tables);
  const writes = [];
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.cols = "*"; this.op = "select"; }
    select(cols) { if (this.op === "update") return this; this.cols = cols ?? "*"; return this; }
    eq(k, v) { this.filters.push((r) => String(r[k]) === String(v)); return this; }
    is(k, v) { this.filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return this; }
    order() { return this; }
    limit() { return this; }
    update(p) { this.op = "update"; this.payload = p; return this; }
    insert(p) { (t[this.table] ??= []).push(p); return Promise.resolve({ data: null, error: null }); }
    maybeSingle() { this.mode = "maybe"; return this.run(); }
    single() { this.mode = "one"; return this.run(); }
    then(ok, bad) { return this.run().then(ok, bad); }
    async run() {
      const rows = (t[this.table] ??= []);
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") {
        writes.push({ table: this.table, fields: this.payload, rows: hit.length });
        hit.forEach((r) => Object.assign(r, this.payload));
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      const cols = String(this.cols).split(",").map((c) => c.trim()).filter(Boolean);
      const project = (r) => (cols.length === 0 || cols.includes("*")
        ? r
        : Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])));
      const out = hit.map(project);
      if (this.mode === "maybe") return { data: out[0] ?? null, error: null };
      if (this.mode === "one") return out[0] ? { data: out[0], error: null } : { data: null, error: { message: "no row" } };
      return { data: out, error: null };
    }
  }
  return {
    tables: t,
    writes,
    from: (table) => new Query(table),
    rpc: async (name) => ({ data: name === "company_allowed" ? true : "OK", error: null }),
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null }), upload: async () => ({ error: null }) }) },
  };
}

const jobRow = (o = {}) => ({
  id: JOB_ID, sync_id: JOB, company_id: COMPANY,
  // Obviously constructed. Nothing in this file comes from his database.
  customer_name: "Test Homeowner", address: "1 Test Lane",
  phone: "", status: "SENT", deleted_at: null, quote_token: TOKEN,
  contract_total: 10000, accepted_total: null, signed_at: null, signed_contract_total: 0,
  quote_approved_at: null, quote_approved_name: "", quote_approved_without_phone_check: false,
  quote_approved_signature_path: null,
  reapproval_required_at: null, reapproval_reason: "",
  amount_paid: 0, refunded_amount: 0, deposit_amount: 0, tax_rate_percent: 0, discount_percent: 0,
  quote_viewed_at: "2026-09-01T00:00:00Z", calibration_pixels_per_foot: 20,
  quote_phone_attempts: 0, quote_phone_locked_until: null,
  assigned_employee_sync_id: null,
  ...o,
});

function world(job = {}, { items = [], orders = [], mutate } = {}) {
  const db = fakeDb({
    jobs: [jobRow(job)],
    companies: [{ id: COMPANY, name: "Test Fence Co", phone: "555-0100", email: "office@example.invalid" }],
    company_settings: [{ company_id: COMPANY, settings: {} }],
    estimate_line_items: items.map((l) => ({ company_id: COMPANY, job_sync_id: JOB, deleted_at: null, ...l })),
    change_orders: orders,
    fence_runs: [],
    payment_connections: [],
    quote_reapprovals: [],
    quote_approval_emails: [],
    devices: [],
  });
  return { db, handler: load(db, mutate) };
}

const view = async (w) => {
  const res = await w.handler(new Request(`https://fn.test/quote-view?t=${TOKEN}`));
  return { status: res.status, body: await res.json() };
};

const approve = async (w, { name = "Test Homeowner", total } = {}) => {
  const res = await w.handler(new Request(`https://fn.test/quote-view?t=${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve", name, ...(total == null ? {} : { total }) }),
  }));
  return { status: res.status, body: await res.json() };
};

/** The accepted price this run wrote to the row, or null if nothing was written. */
const recorded = (w) => {
  const write = w.db.writes.find((x) => x.table === "jobs" && x.fields.quote_approved_at);
  return write ? (write.fields.accepted_total ?? "written-without-a-price") : null;
};

/* THE SHAPE OF AN UNPRICED JOB: a material list exists, so the fallback has
   something to add up, and the server has no contract_total. $4,000 of
   materials at 7% tax is the $4,280 the finding describes. */
const MATERIAL_LINES = [
  { description: "Vinyl panels", quantity: 40, unit_price: 75, total: 3000, taxable: true },
  { description: "Posts", quantity: 25, unit_price: 40, total: 1000, taxable: true },
];
const UNPRICED = { contract_total: null, tax_rate_percent: 7 };
const MATERIALS_PLUS_TAX = 4280;

// ===================================================== the refusal =======

test("the page says Approve would be refused, rather than offering the button", async () => {
  const w = world(UNPRICED, { items: MATERIAL_LINES });
  const page = await view(w);
  assert.equal(page.status, 200, "the page must still load -- a blank quote is not the fix");
  assert.equal(page.body.approvalBlocked, "quote_not_ready",
    "the page would otherwise draw a button whose only possible answer is 409");
});

test("approving an unpriced job is REFUSED, and nothing at all is written", async () => {
  const w = world(UNPRICED, { items: MATERIAL_LINES });
  const r = await approve(w, { total: MATERIALS_PLUS_TAX });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "quote_not_ready");
  assert.equal(recorded(w), null,
    "an approval was recorded on a job with no price; materials and tax would now be " +
    "the agreed total and the balance link would bill it for ever");
  assert.equal(w.db.tables.jobs[0].quote_approved_at, null, "and the row is untouched");
  assert.equal(w.db.tables.jobs[0].accepted_total, null);
});

test("the customer is told something true, and is given no figure", async () => {
  // The number on the page is not a price anybody set. Quoting it at her
  // would make it look like one, which is the same reason the shortfall
  // refusal withholds its two figures.
  const w = world(UNPRICED, { items: MATERIAL_LINES });
  const r = await approve(w, { total: MATERIALS_PLUS_TAX });
  assert.match(r.body.error, /isn't finished/i);
  assert.match(r.body.error, /not been charged|nothing has been agreed/i);
  assert.doesNotMatch(r.body.error, /4,?280|\$\s*\d/,
    "a figure reached the customer in the refusal text");
});

test("a job with no price AND no material list is refused too", async () => {
  // The fallback sums to zero here, so the old code would have recorded an
  // agreed price of $0.00 -- "not priced" and "free" being the same number
  // again, which is the failure this project keeps meeting.
  const w = world(UNPRICED, { items: [] });
  const r = await approve(w);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "quote_not_ready");
  assert.equal(recorded(w), null);
});

// ===================================================== the controls ======

test("POSITIVE CONTROL: an ordinary priced quote still approves, and records the page's figure", async () => {
  const w = world({}, { items: MATERIAL_LINES });
  const page = await view(w);
  assert.equal(page.status, 200);
  assert.equal(page.body.total, 10000, "the server's own price, not the material fallback");
  assert.equal(page.body.approvalBlocked, null, "nothing blocks an ordinary approval");

  const r = await approve(w, { total: 10000 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(recorded(w), 10000, "the figure she saw is the figure recorded");
});

test("CONTROL: a priced job whose total is tiny but real still approves", async () => {
  // The guard asks whether the server HAS a price, not whether the price is
  // big enough. A $200 repair is a real job -- and $200 is the live figure on
  // one of the three jobs in the 1 Oct incident.
  const w = world({ contract_total: 200 }, { items: [] });
  const page = await view(w);
  assert.equal(page.body.approvalBlocked, null);
  const r = await approve(w, { total: 200 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(recorded(w), 200);
});

test("CONTROL: the price-below-agreed refusal still fires, and still says so", async () => {
  /* My change reordered approvalBlocked into a chain. If `quote_not_ready`
     swallowed this case, the 1 Oct guard -- the one that already has real
     damage behind it -- would be silently gone. The job here is priced, so
     the new check must not fire and the old one must. */
  const w = world({
    contract_total: 5853.81, accepted_total: 15540, signed_at: "2026-09-25T15:38:31Z",
    signed_contract_total: 15540, reapproval_required_at: "2026-09-28T16:50:37Z",
    status: "ACCEPTED",
  }, { items: [] });
  const page = await view(w);
  assert.equal(page.body.approvalBlocked, "price_below_agreed",
    "the older guard has been displaced by the new one");
  const r = await approve(w, { total: 5853.81 });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "price_below_agreed");
  assert.equal(recorded(w), null);
});

test("CONTROL: a SIGNED job the server has no price for still approves", async () => {
  /* THE CASE THE EXISTING SUITE CAUGHT, and the reason this guard asks two
     questions instead of one.

     a69 calls this live shape fixture G: a job signed under the
     pre-2026.10.1 engine, whose signature was stamped at $7,740 (the old
     round-up-to-ten) and whose lines come to $7,735.45 exactly, with the
     server's contract_total at 0. "The server has no price" is NOT "nobody
     has agreed a price" -- a signature the contractor physically holds IS
     one, and priceShortfall governs that case properly, exempting the old
     engine's rounding.

     My first version refused this, which would have blocked a real customer
     on a real job. The guard now also asks whether anybody has ever named a
     figure. */
  const w = world({
    contract_total: 0, signed_contract_total: 7740, signed_at: "2026-09-11T02:03:39Z",
  }, { items: [{ description: "x", quantity: 1, unit_price: 7735.45, total: 7735.45, taxable: false }] });

  const page = await view(w);
  assert.equal(page.body.total, 7735.45, "the fallback sums the lines exactly");
  assert.equal(page.body.approvalBlocked, null,
    "a signed price is an agreed price; this must not read as an unpriced job");

  const r = await approve(w, { total: 7735.45 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(recorded(w), 7735.45);
});

test("CONTROL: an ONLINE-only agreement counts too, not just a signature", async () => {
  // accepted_total with no signature is the other half of agreedPrice. A
  // guard that looked only at signed_contract_total would refuse a re-approval
  // on a job whose price the server has since lost.
  const w = world({
    contract_total: 0, accepted_total: 6000, quote_approved_at: null,
    signed_at: null, signed_contract_total: 0,
  }, { items: MATERIAL_LINES });
  const page = await view(w);
  assert.notEqual(page.body.approvalBlocked, "quote_not_ready",
    "an online approval on file is an agreed price, so this is not an unpriced job");
});

test("CONTROL: an already-approved job is not re-judged", async () => {
  // approvalBlocked is about a button that is not drawn at all once the quote
  // is approved. Reporting a block there would put a warning on a settled
  // quote for no reason.
  const w = world({
    contract_total: null, tax_rate_percent: 7,
    quote_approved_at: "2026-10-01T12:00:00Z", quote_approved_name: "Test Homeowner",
    accepted_total: 8000, status: "ACCEPTED",
  }, { items: MATERIAL_LINES });
  const page = await view(w);
  assert.equal(page.body.approvalBlocked, null);
});

// ======================================================== the canary =====

test("CANARY: with the guard off, materials-plus-tax becomes the agreed price", async () => {
  const w = world(UNPRICED, { items: MATERIAL_LINES, mutate: NO_GUARD });
  const r = await approve(w, { total: MATERIALS_PLUS_TAX });

  assert.equal(r.status, 200,
    "CANARY FAILED TO BITE: the old code was supposed to accept this approval");
  assert.equal(recorded(w), MATERIALS_PLUS_TAX,
    "CANARY FAILED TO BITE: the old code was supposed to record materials and tax " +
    `(${MATERIALS_PLUS_TAX}) as the agreed total`);
});

test("CONTROL: the fallback figure itself is what the finding says it is", async () => {
  // Without this, the canary above could be passing on some other number and
  // the whole file would be describing a defect it never reproduced.
  const w = world(UNPRICED, { items: MATERIAL_LINES, mutate: NO_GUARD });
  const page = await view(w);
  assert.equal(page.body.total, MATERIALS_PLUS_TAX,
    "the page's fallback is the material lines plus tax, with no labour, gates, " +
    "markup or discount in it");
  // And the server's own price is nothing at all, which is the point. The
  // response does not carry `money` itself (deliberately -- it sends the
  // derived figures, not the object), so this is asserted where it is
  // decided: the row holds no contract_total, and billableTotal reads it.
  assert.equal(w.db.tables.jobs[0].contract_total, null,
    "the fixture is not actually unpriced, so this file proves nothing");
  assert.equal(quoteDeposit.billableTotal({
    contractTotal: null, acceptedTotal: null, signedAt: null,
    quoteApprovedAt: null, reapprovalRequiredAt: null, changeOrders: [],
  }), 0, "billableTotal on an unpriced job is 0 -- the condition the guard reads");
});
