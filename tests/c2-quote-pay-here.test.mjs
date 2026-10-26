// "PAY HERE" ON A SENT QUOTE -- owner list item C2.
//
// Run with:  node tests/c2-quote-pay-here.test.mjs
//
// quote-view sends `paymentsReady`, and website/quote.html's dueNow() returns 0
// whenever it is false -- which hides the "Approve & pay $X" button before an
// approval and the "Pay deposit $X" button after one. So that single boolean
// decides whether a homeowner is offered a card at all, and it is worth exactly
// as much as its agreement with what create-payment-link will really do when the
// button is pressed.
//
// It did not agree. It read:
//
//     (conn.processor === "stripe" && conn.external_id)
//
// i.e. "this company has connected its own Stripe account". That is the one
// Stripe configuration create-payment-link REFUSES (501: a link made on a
// connected account raises its webhook on that account, which stripe-webhook
// never hears, so the payment is never recorded against the job). And a company
// with no connection row at all -- which is every real company; that same 501
// says "no company has connected an account yet" -- came out FALSE, although it
// is the only configuration that mints. Both halves wrong in the same
// direction, so the card button has never appeared on a real quote while the
// checkout behind it worked the whole time.
//
// WHAT THIS GUARDS
//   1. One case per branch of create-payment-link's card decision, each driven
//      through the REAL quote-view handler, asserting paymentsReady equals
//      "that door would mint". Every true sits beside a false built from the
//      same fixture, so a function answering one constant could not pass.
//   2. The reasons the predicate is allowed to ignore companies.stripe_account_id
//      -- that nothing writes it and its own migration carries it across -- are
//      pinned, because they are what makes the shortcut safe rather than lucky.
//   3. The one case it knowingly gets wrong (a Solo company, refused 403 for the
//      plan) is written down IN THE FUNCTION, and the sentence saying so is
//      under test, so the gap cannot be lost by someone tidying a comment.
//   4. Nothing was widened to do it: the customer still gets no line items, no
//      subtotal, no tax, and `companies` is still read once for four columns.
//   5. The money rules the pay path rests on are still refusals, not prose: the
//      public door needs an approval, takes its amount from the job, cannot
//      charge a saved card, saves one only on a deposit, and the re-approval
//      billing cap is still wired in.
//
// Nothing touches the network or a database. Every invented value says TESTONLY.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as quoteDeposit from "../supabase/functions/_shared/quote-deposit.ts";
import * as jobPush from "../supabase/functions/_shared/job-push.ts";
import * as pushRecipients from "../supabase/functions/_shared/push-recipients.ts";
// The one predicate the quote page and the contract email now share.
import * as paymentsReady from "../supabase/functions/_shared/payments-ready.ts";

const COMPANY = "c2000000-0000-4000-8000-000000000001";
const JOB = "c2000000-0000-4000-8000-00000000000a";
const JOB_ID = "c2000000-0000-4000-8000-000000000011";
const TOKEN = "c2000000-0000-4000-8000-00000000000b";

const QUOTE_VIEW = new URL("../supabase/functions/quote-view/index.ts", import.meta.url);
const CREATE_LINK = new URL("../supabase/functions/create-payment-link/index.ts", import.meta.url);
const STRIPE_CONNECT = new URL("../supabase/functions/stripe-connect/index.ts", import.meta.url);
const CONN_MIGRATION = new URL("../supabase_payment_connections_patch.sql", import.meta.url);

// ============================================================ harness =====
// The same shape tests/a38-payment-methods-quote-view.test.mjs uses: the real
// TypeScript, type-stripped, its imports swapped for a fake service-role client
// and the real shared modules, Deno.serve handing over the real handler.
const SHARED = {
  "../_shared/quote-deposit.ts": quoteDeposit,
  "../_shared/job-push.ts": jobPush,
  "../_shared/push-recipients.ts": pushRecipients,
  "../_shared/payments-ready.ts": paymentsReady,
};

function load(db) {
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
  js = js.replace(importRe, "").replace(/^export /gm, "");
  assert.doesNotMatch(js, /^import /m, "an import the harness did not strip");
  let handler = null;
  const Deno = { env: { get: () => undefined }, serve: (h) => { handler = h; } };
  const names = Object.keys(provided);
  new Function("Deno", "fetch", ...names, js)(
    Deno, async () => new Response("{}", { status: 404 }), ...names.map((n) => provided[n]));
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

/** An in-memory service-role client. `planError` plants a failed read of the
 *  plan WITHOUT breaking the name read, which is a different select. */
function fakeDb(tables, { planError = null } = {}) {
  const t = structuredClone(tables);
  const log = [];
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.cols = "*"; this.op = "select"; }
    select(cols) { this.cols = cols ?? "*"; return this; }
    eq(k, v) { this.filters.push((r) => String(r[k]) === String(v)); return this; }
    is(k, v) { this.filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return this; }
    order() { return this; }
    limit() { return this; }
    update(p) { this.op = "update"; this.payload = p; return this; }
    maybeSingle() { this.mode = "maybe"; return this.run(); }
    single() { this.mode = "one"; return this.run(); }
    then(ok, bad) { return this.run().then(ok, bad); }
    async run() {
      log.push({ op: this.op, table: this.table, cols: String(this.cols) });
      if (this.table === "companies" && planError && /subscription_plan/.test(String(this.cols))) {
        return { data: null, error: { message: planError } };
      }
      const rows = (t[this.table] ??= []);
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") { hit.forEach((r) => Object.assign(r, this.payload)); return { data: null, error: null }; }
      const parts = String(this.cols).split(",").map((c) => c.trim()).filter(Boolean);
      const aliases = this.table === "company_settings"
        ? parts.map((c) => /^(\w+):settings->(\w+)$/.exec(c))
        : [];
      const alias = aliases.length > 0 && aliases.every(Boolean) ? aliases : null;
      const project = (r) => alias
        ? Object.fromEntries(alias.map((a) => [a[1], r.settings?.[a[2]]]))
        : (parts.length === 0 || parts.includes("*")
          ? r
          : Object.fromEntries(parts.filter((c) => c in r).map((c) => [c, r[c]])));
      const out = hit.map(project);
      if (this.mode === "maybe") return { data: out[0] ?? null, error: null };
      if (this.mode === "one") return out[0] ? { data: out[0], error: null } : { data: null, error: { message: "no row" } };
      return { data: out, error: null };
    }
  }
  return {
    tables: t,
    log,
    from: (table) => new Query(table),
    rpc: async () => ({ data: true, error: null }),
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null }) }) },
  };
}

/** A SENT quote, $1,000 deposit asked for on a $5,000 job, nothing paid -- so
 *  money.due is 1000 and the only open question is the processor. */
const sentJob = (o = {}) => ({
  id: JOB_ID, sync_id: JOB, company_id: COMPANY, customer_name: "Pat TESTONLY", address: "1 Oak St",
  phone: "", status: "SENT", deleted_at: null, quote_token: TOKEN,
  contract_total: 5000, accepted_total: null, signed_at: null, signed_contract_total: null,
  quote_approved_at: null, quote_approved_name: "", quote_approved_signature_path: null,
  reapproval_required_at: null, reapproval_reason: "",
  amount_paid: 0, refunded_amount: 0, deposit_amount: 1000,
  tax_rate_percent: 0, discount_percent: 0,
  quote_viewed_at: "2026-09-01T00:00:00Z", calibration_pixels_per_foot: 20,
  quote_phone_attempts: 0, quote_phone_locked_until: null,
  ...o,
});

function world({ conn = null, job = {}, plan = "crew", opts = {} } = {}) {
  const db = fakeDb({
    jobs: [sentJob(job)],
    companies: [{
      id: COMPANY, name: "TESTONLY Fence Co", phone: "555-0100",
      email: "office@example.invalid", logo_path: null,
      stripe_account_id: null, subscription_plan: plan,
    }],
    company_settings: [], estimate_line_items: [], change_orders: [],
    fence_runs: [], site_markers: [], quote_reapprovals: [],
    payment_connections: conn ? [{ company_id: COMPANY, ...conn }] : [],
  }, opts);
  return { db, handler: load(db) };
}

const view = async (w, token = TOKEN) => {
  const res = await w.handler(new Request(`https://fn.test/quote-view?t=${token}`));
  return { status: res.status, body: await res.json() };
};

/** website/quote.html's dueNow(), which is what actually draws the button. One
 *  copy here so a test says "a homeowner is offered a card", not "a boolean". */
function cardOffered(q) {
  if (!q || !q.paymentsReady) return 0;
  if (q.depositPayable === false) return 0;
  const due = (q.depositDue != null) ? q.depositDue : q.deposit;
  return (due > 0.005) ? due : 0;
}

// ==================================== one case per create-payment-link branch
//
// `mints` is what create-payment-link's quoteToken door does with the same
// connection row and plan, read off that file and pinned by text further down:
//   plan "solo"        -> 403. Card payments are sold with the Crew plan, and
//                         the check sits ABOVE the processor branch, so it
//                         catches Square too.
//   processor "square" -> access_token AND external_id, else 409
//   anything else      -> account = conn.external_id || companies.stripe_account_id;
//                         a non-empty account is 501, an empty one is the
//                         platform account and mints.
const CASES = [
  {
    name: "no payment_connections row at all -- the platform Stripe account, which is every real company",
    conn: null, mints: true,
  },
  {
    name: "a row saying processor 'none'",
    conn: { processor: "none", external_id: "", access_token: null }, mints: true,
  },
  {
    name: "Stripe chosen in the Billing tab but the OAuth round trip never finished (external_id '')",
    conn: { processor: "stripe", external_id: "", access_token: null }, mints: true,
  },
  {
    name: "Stripe FULLY connected -- the 501 case, so no button",
    conn: { processor: "stripe", external_id: "acct_TESTONLY", access_token: null }, mints: false,
  },
  {
    name: "Square connected, token and merchant id both there",
    conn: { processor: "square", external_id: "MERCHTESTONLY", access_token: "tokTESTONLY" }, mints: true,
  },
  {
    name: "Square chosen but not connected -- the 409 case",
    conn: { processor: "square", external_id: "", access_token: null }, mints: false,
  },
  {
    name: "Square with a merchant id but no token -- still the 409 case, the token is what charges",
    conn: { processor: "square", external_id: "MERCHTESTONLY", access_token: null }, mints: false,
  },
  {
    name: "a processor nobody has built yet falls down the Stripe path, which is where an unknown one goes",
    conn: { processor: "future_processor", external_id: "", access_token: null }, mints: true,
  },
  // The plan, which is checked above the processor and so applies to both.
  {
    name: "a Solo company on the platform account -- card payments are part of the Crew plan, so 403",
    conn: null, plan: "Solo", mints: false,
  },
  {
    name: "a Solo company with Square connected -- the plan check sits above the processor branch",
    conn: { processor: "square", external_id: "MERCHTESTONLY", access_token: "tokTESTONLY" },
    plan: "solo", mints: false,
  },
  {
    name: "Pro, which buys everything Crew does",
    conn: null, plan: "pro", mints: true,
  },
  {
    name: "a blank plan -- hand-granted from before plans existed, and not capped",
    conn: null, plan: "", mints: true,
  },
];

for (const c of CASES) {
  test(`paymentsReady matches the checkout: ${c.name}`, async () => {
    const { status, body } = await view(world({ conn: c.conn, plan: c.plan ?? "crew" }));
    assert.equal(status, 200);
    assert.equal(body.paymentsReady, c.mints,
      `paymentsReady should be ${c.mints} for: ${c.name}`);
    // And the button the page would actually draw from it.
    assert.equal(cardOffered(body) > 0, c.mints, "dueNow() disagrees with paymentsReady");
    // Unchanged either way: the quote itself.
    assert.equal(body.company.name, "TESTONLY Fence Co");
    assert.equal(body.total, 5000);
    assert.equal(body.depositDue, 1000);
  });
}

test("the set is not one constant: both answers really occur in it", () => {
  assert.ok(CASES.some((c) => c.mints), "no case expects a button");
  assert.ok(CASES.some((c) => !c.mints), "no case expects no button");
});

// =============== why companies.stripe_account_id may be left out of the above
//
// create-payment-link's `account` also falls back to companies.stripe_account_id,
// and the predicate does not read it: a customer's quote page is forbidden to
// touch billing columns (a38-payment-methods-quote-view.test.mjs names that one
// explicitly). The shortcut is safe for three reasons, so the three reasons are
// what get tested -- not the shortcut.

test("companies.stripe_account_id is the superseded column, and its migration carries any value into payment_connections", () => {
  const sql = readFileSync(CONN_MIGRATION, "utf8");
  assert.match(sql, /companies\.stripe_account_id was a single column for a single processor/,
    "the migration no longer says what it replaces");
  assert.match(sql, /insert into payment_connections \(company_id, processor, external_id/,
    "the backfill into payment_connections is gone, so a legacy value could sit unmirrored");
  assert.match(sql, /where coalesce\(c\.stripe_account_id, ''\) <> ''/,
    "the backfill no longer selects the companies rows that have one");
});

test("stripe-connect writes payment_connections.external_id, not companies.stripe_account_id", () => {
  const src = readFileSync(STRIPE_CONNECT, "utf8");
  assert.match(src, /\.from\("payment_connections"\)/,
    "the one thing that connects a Stripe account no longer writes payment_connections");
  assert.match(src, /external_id: account,/,
    "stripe-connect no longer records the account id as payment_connections.external_id");
  assert.doesNotMatch(src, /stripe_account_id/,
    "stripe-connect now writes companies.stripe_account_id too, so conn.external_id is no longer the whole signal -- paymentsReadyFrom must read the companies column after all");
});

test("no edge function writes companies.stripe_account_id", () => {
  // Cheap and blunt on purpose: the claim is "nothing sets it", so the proof is
  // that the string does not appear as an assignment anywhere that writes.
  for (const f of ["stripe-connect", "stripe-webhook", "square-oauth", "square-webhook"]) {
    const src = readFileSync(new URL(`../supabase/functions/${f}/index.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /stripe_account_id\s*:/,
      `${f} now writes companies.stripe_account_id`);
  }
});

// ===================================================== the plan read itself ==

test("a failed read of the plan offers no card -- and does not blank the quote", async () => {
  const w = world({ opts: { planError: "planted: column does not exist" } });
  const { status, body } = await view(w);
  assert.equal(status, 200);
  assert.equal(body.paymentsReady, false, "a read that failed is not permission to offer a button");
  assert.equal(cardOffered(body), 0);
  // The positive control: the SAME fixture without the planted error offers one,
  // so the false above is the error and not the fixture.
  const ok = await view(world());
  assert.equal(ok.body.paymentsReady, true);
  // The name comes from a different select and must survive it.
  assert.equal(body.company.name, "TESTONLY Fence Co");
  assert.equal(body.company.phone, "555-0100");
  assert.equal(body.total, 5000);
  assert.equal(body.balanceDue, 5000);
});

test("the plan is read on its own, never bolted onto the company name select", async () => {
  const w = world();
  await view(w);
  const companyReads = w.db.log.filter((l) => l.table === "companies" && l.op === "select");
  const nameSelect = companyReads.find((r) => /\bname\b/.test(r.cols));
  assert.ok(nameSelect, "the company name is never read");
  assert.doesNotMatch(nameSelect.cols, /subscription_plan|stripe_account_id/,
    "the name select is a .single(): one column it could not see would blank every quote header");
  const planSelect = companyReads.find((r) => /subscription_plan/.test(r.cols));
  assert.ok(planSelect, "the plan is never read, so a Solo company would be offered a card");
  assert.equal(planSelect.cols.trim(), "subscription_plan",
    "the plan read must ask for the one column and nothing else");
});

test("the plan never reaches the customer, whatever it is", async () => {
  // Distinctive values on purpose: "pro" is a substring of "approvedAt" and
  // "approvalBlocked", so a search for the bare plan names would fail on the
  // page's own field names and say nothing about a leak.
  for (const plan of ["solo-TESTONLY", "crew-TESTONLY", "pro-TESTONLY", "ZZTESTONLYPLAN"]) {
    const { body } = await view(world({ plan }));
    // CASE-INSENSITIVE, because readPlan lowercases what it reads: a search for
    // the fixture's own capitals missed a planted leak of exactly this field
    // while looking like it was checking for one.
    const wire = JSON.stringify(body).toUpperCase();
    assert.ok(!wire.includes("TESTONLYPLAN") && !wire.includes("-TESTONLY"),
      `the plan "${plan}" reached the customer`);
    assert.ok(!wire.includes("SUBSCRIPTION_PLAN"), "the plan KEY reached the customer");
    // Not just absent from the company object -- absent from the response. The
    // page is built field by field, so a leak would be a new top-level key.
    assert.equal("plan" in body, false, "the response grew a plan field");
    assert.deepEqual(Object.keys(body.company).sort(), ["email", "logoUrl", "name", "phone"],
      "the company object grew a field");
  }
});

// ================================================== nothing else was widened ==

test("still no line items, subtotal, tax or margin on a customer's quote", async () => {
  const { body } = await view(world());
  for (const k of ["lines", "lineItems", "items", "subtotal", "tax", "taxRate",
    "taxRatePercent", "discountPercent", "supplierUnitPrice", "laborRate", "markup"]) {
    assert.equal(k in body, false, `${k} must not reach a customer`);
  }
});

test("companies is read exactly twice, each for its own list and nothing else", async () => {
  const w = world();
  await view(w);
  const companyReads = w.db.log.filter((l) => l.table === "companies");
  const selects = companyReads.map((r) => r.cols.split(",").map((c) => c.trim()).sort().join(",")).sort();
  assert.deepEqual(selects, ["email,logo_path,name,phone", "subscription_plan"].sort(),
    `the companies selects are ${JSON.stringify(companyReads.map((r) => r.cols))}; answering paymentsReady must not have widened either one`);
  // Said again from the other side: a billing column is none of a customer's
  // business even when the value is discarded, because a column read is a
  // column that can be spread into a response by accident.
  const cols = companyReads.map((r) => r.cols.split(",").map((c) => c.trim())).flat();
  for (const forbidden of ["suspended", "monthly_price", "stripe_customer_id", "stripe_account_id",
    "leads_token", "admin_notes", "billing_email", "subscription_status", "pass_card_fee"]) {
    assert.ok(!cols.includes(forbidden),
      `the quote page now reads companies.${forbidden}, which is none of the customer's business`);
  }
});

test("a deposit already paid in full still offers no card, whatever the processor says", async () => {
  // money.due is 0, so there is nothing for a checkout to collect.
  const { body } = await view(world({ job: { amount_paid: 1000 } }));
  assert.equal(body.paymentsReady, true, "the processor is fine");
  assert.equal(body.depositDue, 0);
  assert.equal(cardOffered(body), 0, "nothing due means no button");
});

// ======================================== the source of the transcription ====
//
// paymentsReadyFrom mirrors decisions made in another file. A mirror cannot
// notice the thing it reflects moving, so the expressions it was read off are
// pinned by text. IF ONE OF THESE FAILS nothing is necessarily broken -- but go
// and read paymentsReadyFrom against the new create-payment-link and make them
// agree again before changing the string here.

test("create-payment-link still refuses a company's own Stripe account", () => {
  const src = readFileSync(CREATE_LINK, "utf8");
  assert.match(src,
    /const account = conn\?\.external_id \|\| company\?\.stripe_account_id \|\| undefined;/,
    "the `account` expression moved: paymentsReadyFrom's Stripe arm is read off it");
  assert.match(src, /if \(account\) \{\s*\n\s*return json\(\{/,
    "the refusal of a connected account moved");
  assert.match(src, /\}, 501\);/, "the 501 that makes a connected account unpayable is gone");
});

test("create-payment-link still needs a token AND a merchant id for Square", () => {
  assert.match(readFileSync(CREATE_LINK, "utf8"),
    /if \(!conn\?\.access_token \|\| !conn\?\.external_id\) \{/,
    "the Square connection check moved");
});

test("create-payment-link still refuses a Solo company, above the processor branch", () => {
  const src = readFileSync(CREATE_LINK, "utf8");
  assert.match(src,
    /\(company\?\.subscription_plan \?\? ""\)\.toLowerCase\(\) === "solo"/,
    "the Crew-plan gate moved: paymentsReadyFrom's plan arm is read off it");
  // Above the processor branch, which is why one plan check covers Square too.
  assert.ok(src.indexOf('=== "solo"') < src.indexOf('if (processor === "square")'),
    "the plan gate has moved BELOW the processor branch, so Square no longer shares it");
});

// =================================== the money rules the pay path rests on ====

test("the public door still needs an approval before it will mint anything", () => {
  const src = readFileSync(CREATE_LINK, "utf8");
  assert.match(src, /if \(!qjob\.quote_approved_at\) \{/,
    "the quoteToken door must not mint for a quote nobody approved");
  assert.match(src, /const dollars = kindWanted === "deposit"\s*\n?\s*\? deposit\.due\s*\n?\s*: deposit\.balance;/,
    "the public door's amount must come from depositFigures, not from the body");
  const publicDoor = src.slice(src.indexOf("if (body?.quoteToken)"), src.indexOf("door one"));
  assert.ok(publicDoor.length > 500, "the public-door slice did not find the branch");
  assert.doesNotMatch(publicDoor, /body\.amountCents|body\?\.amountCents/,
    "the public door must never read an amount out of the request");
});

test("a homeowner's own door can never charge a saved card, and only a deposit saves one", () => {
  const src = readFileSync(CREATE_LINK, "utf8");
  assert.match(src, /const chargeSavedCard = a\.chargeSavedCard === true && !publicDoor;/,
    "the public door must be unable to trigger an off-session charge");
  assert.match(src,
    /const keepCardForBalance = company\?\.auto_charge_balance === true && kind === "deposit";/,
    "card-saving must stay opt-in and deposit-only");
});

test("the billing cap still measures against the price last agreed while a re-approval is pending", () => {
  const src = readFileSync(CREATE_LINK, "utf8");
  assert.match(src, /export function reapprovalBillingCap\(/);
  assert.match(src, /if \(!acceptance\?\.reapprovalRequiredAt\) return null;/);
  assert.match(src, /const reapprovalCap = reapprovalBillingCap\(acceptance\);/,
    "the cap is computed but no longer used, or it moved");
});

test("quote-view still withholds a payment link whose amount has drifted from what is due", () => {
  assert.match(readFileSync(QUOTE_VIEW, "utf8"),
    /if \(amount > 0\.005 && Math\.abs\(amount - due\) > 0\.005\) return null;/,
    "the stale-link rule moved: a link bills the figure it was minted for for ever");
});
