/**
 * WHAT A CUSTOMER CAN DO AND SEE AFTER SHE PRESSES APPROVE.
 *
 * Run with:  node --test tests/a69-after-approval.test.mjs
 *
 * He asked two questions on 1 Oct that were answered in words and never
 * proved: "after the approved, are they going to be able to download the
 * contract?" and "and get all the information they need?". This file is the
 * proof, and it is deliberately both halves: what the approved state really
 * does expose, and what it does not.
 *
 * The real quote-view handler runs here -- its TypeScript stripped by Node,
 * its imports swapped for an in-memory service-role client and the REAL
 * shared modules, Deno.serve handing over the real request handler. The same
 * harness tests/a38-payment-methods-quote-view.test.mjs and
 * tests/a15-signature-approval.test.mjs use. The customer's downloadable copy
 * is the real buildQuoteDocument pulled out of website/quote.html, the same
 * idiom as tests/quote-summary.test.mjs. Nothing touches the network or a
 * database, and every row here is constructed: no customer name, address,
 * phone or email from his data is in this file.
 *
 * WHAT THIS GUARDS
 *   1. THE PRICE GUARD. An approval that would record a figure below one the
 *      customer has already agreed to is REFUSED, nothing is written, and the
 *      page is told in advance so the button is not a trap. Measured on his
 *      real rows (docs/MONEY_AUDIT_SURFACES.md section 0.2, re-run 2 Oct):
 *      the three re-approval-pending jobs would otherwise have recorded
 *      $5,853.81 against a signed $15,540.00, $13,266.87 against $35,240.00
 *      and $200.00 against $870.00 -- 38%, 38% and 23%.
 *   2. The one shortfall that is NOT one: the old engine rounded every total
 *      up to the next $10, so a job signed before 1 Oct carries a signed
 *      figure up to $9.99 above its own exact total. That must still approve.
 *   3. THE ANCHOR HOLDS. Once she has approved, re-pricing the job does not
 *      move what the page shows her or what the deposit is measured against.
 *   4. A job with no deposit asked for shows no deposit row anywhere -- not a
 *      $0.00 one.
 *   5. The approved state exposes the download, and the downloaded file is a
 *      complete standalone record: who approved, when, the agreed total, the
 *      deposit, what is left to pay, how to pay it, and what happens next.
 *   6. What it does NOT contain, asserted so it cannot be claimed: there is
 *      no cancellation clause and no contract terms in anything the customer
 *      can reach. His terms live only in the phone's own settings
 *      (ContractTemplate.kt), are not in the cloud settings blob, and so
 *      cannot be in the quote page, the download or the email. See
 *      docs/AFTER_APPROVAL.md question 1.
 *
 * THE CANARY. Every price-guard test is also run against the handler with the
 * guard switched off (AGREED_PRICE_SHORTFALL_TOLERANCE mutated to Infinity,
 * which is the function exactly as it behaved before 2 Oct 2026). The
 * mutation must RECORD the collapsed price -- i.e. these tests must fail
 * against the old code. A guard that cannot be shown to have changed the
 * answer is not a guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as quoteDeposit from "../supabase/functions/_shared/quote-deposit.ts";
import * as jobPush from "../supabase/functions/_shared/job-push.ts";
import * as pushRecipients from "../supabase/functions/_shared/push-recipients.ts";

const COMPANY = "c6900000-0000-4000-8000-000000000001";
const JOB = "a6900000-0000-4000-8000-00000000000a";
const JOB_ID = "16900000-0000-4000-8000-000000000001";
const TOKEN = "b6900000-0000-4000-8000-00000000000b";

// ============================================================ harness =====

const SHARED = {
  "../_shared/quote-deposit.ts": quoteDeposit,
  "../_shared/job-push.ts": jobPush,
  "../_shared/push-recipients.ts": pushRecipients,
};
const QUOTE_VIEW = new URL("../supabase/functions/quote-view/index.ts", import.meta.url);

/**
 * The guard, switched off: the source as it behaved before 2 Oct 2026.
 *
 * Asserts the mutation actually landed, because a canary that silently failed
 * to mutate anything would "pass" by testing the fixed code twice -- the exact
 * shape of audit blind spot this project keeps writing rules about.
 */
const NO_GUARD = (js) => {
  const needle = "const AGREED_PRICE_SHORTFALL_TOLERANCE = 0.5;";
  assert.ok(js.includes(needle), "the canary's mutation point has moved; this test is no longer testing the old code");
  return js.replace(needle, "const AGREED_PRICE_SHORTFALL_TOLERANCE = Infinity;");
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
    company_settings: [{
      company_id: COMPANY,
      settings: { payment_methods: { cash_app: { on: true, tag: "TestOnlyTag" }, cash: { on: true } } },
    }],
    estimate_line_items: items.map((l) => ({ company_id: COMPANY, job_sync_id: JOB, deleted_at: null, ...l })),
    change_orders: orders,
    fence_runs: [],
    payment_connections: [],
    quote_reapprovals: [],
    quote_approval_emails: [],
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

// ================================================ the collapsed jobs =====
//
// The three shapes measured live on 2 Oct, read-only. Lettered as
// docs/MONEY_AUDIT_SURFACES.md letters them; no identifying field is here.
const COLLAPSED = [
  { letter: "D", signed: 15540, live: 5853.81, short: 9686.19 },
  { letter: "H", signed: 35240, live: 13266.87, short: 21973.13 },
  { letter: "I", signed: 870, live: 200, short: 670 },
];

/**
 * A job in the 1 Oct state: signed and anchored at the real price, the
 * re-approval flag raised (correctly -- the 28 Sep tax correction), every
 * priced line tombstoned, and contract_total re-stamped from an empty
 * material list. quote_approved_at is null because the re-approval trigger
 * cleared it, which is exactly why approving would overwrite the anchor.
 */
const collapsedJob = (c) => ({
  signed_contract_total: c.signed,
  accepted_total: c.signed,
  signed_at: "2026-09-25T15:38:31Z",
  contract_total: c.live,
  reapproval_required_at: "2026-09-28T16:50:37Z",
  reapproval_reason: "The sales tax on this quote was worked out on part of the materials instead of all of them.",
  quote_approved_at: null,
  status: "ACCEPTED",
});

test("POSITIVE CONTROL: an ordinary quote with nothing agreed yet approves, and records the price the page showed", async () => {
  const w = world();
  const page = await view(w);
  assert.equal(page.status, 200);
  assert.equal(page.body.total, 10000);
  assert.equal(page.body.approvalBlocked, null, "nothing is agreed yet, so nothing can be undercut");

  const r = await approve(w, { total: page.body.total });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(recorded(w), 10000, "the figure she saw is the figure recorded");
});

test("a price that collapsed below a signed figure is REFUSED, and nothing is written", async () => {
  for (const c of COLLAPSED) {
    const w = world(collapsedJob(c));
    const page = await view(w);
    // The page shows the live figure, because quote-deposit.ts turns the
    // anchor off while a re-approval is pending. That part is unchanged.
    assert.equal(page.body.total, c.live, `job ${c.letter}: the page still shows the live figure`);
    // ...but it now says the approve button would be refused.
    assert.equal(page.body.approvalBlocked, "price_below_agreed", `job ${c.letter}: the page is warned`);

    const r = await approve(w, { total: c.live });
    assert.equal(r.status, 409, `job ${c.letter}: refused`);
    assert.equal(r.body.code, "price_below_agreed", `job ${c.letter}`);
    assert.equal(recorded(w), null, `job ${c.letter}: NOTHING was written`);
    // The anchor she really agreed to is untouched.
    assert.equal(w.db.tables.jobs[0].accepted_total, c.signed, `job ${c.letter}: the anchor stands`);
    assert.equal(w.db.tables.jobs[0].quote_approved_at, null, `job ${c.letter}: no approval landed`);
    // She is not shown the two prices -- she is not the one who can judge
    // which is right, and quoting both invites her to pick the lower.
    const wire = JSON.stringify(r.body);
    assert.ok(!wire.includes(String(c.signed)), `job ${c.letter}: the signed figure reached the customer`);
    assert.ok(!wire.includes(String(c.live)), `job ${c.letter}: the collapsed figure reached the customer`);
  }
});

test("CANARY: with the guard switched off, every one of those three records the collapsed price (so this test has teeth)", async () => {
  for (const c of COLLAPSED) {
    const w = world(collapsedJob(c), { mutate: NO_GUARD });
    const page = await view(w);
    assert.equal(page.body.approvalBlocked, null, `job ${c.letter}: the old code warned nobody`);

    const r = await approve(w, { total: c.live });
    assert.equal(r.status, 200, `job ${c.letter}: the old code accepted it`);
    assert.equal(
      recorded(w),
      c.live,
      `job ${c.letter}: the old code recorded ${c.live} against a signed ${c.signed} -- short ${c.short}`,
    );
    // And it overwrote the anchor, which is the whole cost.
    assert.equal(w.db.tables.jobs[0].accepted_total, c.live, `job ${c.letter}: the old code overwrote the anchor`);
  }
});

test("the one shortfall that is not one: the old engine's round-up-to-$10 still approves", async () => {
  // A job signed under the pre-2026.10.1 engine: its lines come to an exact
  // figure, the signature was stamped with that figure rounded up to the next
  // ten. Live shape, fixture G: $7,735.45 of lines against a signed $7,740.00.
  const w = world(
    { contract_total: 0, signed_contract_total: 7740, signed_at: "2026-09-11T02:03:39Z", deposit_amount: 0 },
    { items: [{ description: "x", quantity: 1, unit: "ea", unit_price: 7735.45, taxable: false, sort_order: 0 }] },
  );
  const page = await view(w);
  assert.equal(page.body.total, 7735.45, "the fallback sums the lines exactly");
  assert.equal(page.body.approvalBlocked, null, "the same price under a different rounding is not a collapse");
  const r = await approve(w, { total: 7735.45 });
  assert.equal(r.status, 200);
  assert.equal(recorded(w), 7735.45);

  // And the exemption is exact, not a tolerance band: one cent further down
  // and the agreed figure is no longer what the old engine would have printed.
  const w2 = world(
    { contract_total: 0, signed_contract_total: 7741, signed_at: "2026-09-11T02:03:39Z" },
    { items: [{ description: "x", quantity: 1, unit: "ea", unit_price: 7735.45, taxable: false, sort_order: 0 }] },
  );
  assert.equal((await view(w2)).body.approvalBlocked, "price_below_agreed");
  assert.equal((await approve(w2, { total: 7735.45 })).status, 409);
});

test("a price that went UP since she signed still approves -- the guard is one-directional", async () => {
  const w = world({
    signed_contract_total: 15540, accepted_total: 15540, signed_at: "2026-09-25T15:38:31Z",
    contract_total: 17062.22, reapproval_required_at: "2026-09-28T16:50:37Z", quote_approved_at: null,
  });
  const page = await view(w);
  assert.equal(page.body.total, 17062.22);
  assert.equal(page.body.approvalBlocked, null, "a re-approval raised to collect MORE must go through");
  const r = await approve(w, { total: 17062.22 });
  assert.equal(r.status, 200);
  assert.equal(recorded(w), 17062.22);
});

// ================================================== the anchor holds =====

test("after she approves, re-pricing the job does not move what she sees or what she owes", async () => {
  const w = world({ deposit_amount: 2600 });
  const before = await view(w);
  assert.equal(before.body.total, 10000);
  const r = await approve(w, { total: 10000 });
  assert.equal(r.status, 200);
  assert.equal(recorded(w), 10000);

  // The office re-prices: contract_total moves. Nothing else changes.
  w.db.tables.jobs[0].contract_total = 12500;
  const after = await view(w);
  assert.equal(after.body.total, 10000, "the page still shows the price she accepted, not the live one");
  assert.equal(after.body.balanceDue, 10000, "and so does what is left to pay");
  assert.equal(after.body.deposit, 2600);
  assert.ok(after.body.approvedAt, "her approval is still on the page");
  assert.equal(after.body.approvedBy, "Test Homeowner");

  // The positive control for that: with no acceptance, the same move WOULD
  // follow the live figure -- so the assertion above is about the anchor and
  // not about the fake database holding the number still.
  const loose = world({ contract_total: 12500 });
  assert.equal((await view(loose)).body.total, 12500);
});

test("a job with no deposit asked for shows no deposit row -- not a $0.00 one", async () => {
  const { totalsRowsFor } = pageRows();

  const none = await view(world({ deposit_amount: 0 }));
  assert.equal(none.body.deposit, 0);
  assert.equal(none.body.depositDue, 0);
  const rowsNone = totalsRowsFor(none.body);
  assert.ok(!rowsNone.some((r) => /Deposit/i.test(r)), "a deposit row was drawn for a job with no deposit:\n" + rowsNone.join("\n"));
  assert.ok(rowsNone.some((r) => /Left to pay/.test(r)), "the balance row must still be there (it is outside the deposit block)");

  // Positive control: the same page DOES draw the row when one is asked for.
  const some = await view(world({ deposit_amount: 2600 }));
  const rowsSome = totalsRowsFor(some.body);
  assert.ok(rowsSome.some((r) => /Deposit/i.test(r)), "the positive control drew no deposit row either");
  assert.ok(rowsSome.some((r) => r.includes("$2,600.00")));
});

// ======================================= what she can download, really =====

test("the approved state exposes the download, and the file is a complete standalone record", async () => {
  const w = world({ deposit_amount: 2600 });
  await approve(w, { total: 10000 });
  const page = await view(w);
  assert.ok(page.body.approvedAt, "approvedAt is what the page keys the download button off");

  const { buildQuoteDocument, totalsRowsFor } = pageRows();
  const doc = buildQuoteDocument({
    lang: "en",
    title: "Fence quote for Test Homeowner",
    companyName: page.body.company.name,
    companyContact: [page.body.company.phone, page.body.company.email].filter(Boolean).join(" · "),
    customerHeading: "Quote for Test Homeowner",
    customerName: page.body.customerName,
    address: page.body.address,
    scopeHeading: "Scope of work",
    scopeHtml: "<div>Vinyl fence — 120 ft</div>",
    totalsHeading: "Pricing",
    totalsHtml: totalsRowsFor(page.body).join(""),
    approvalText: "Approved by Test Homeowner on 10/2/2026. Test Fence Co has been told — thank you!",
    nextStepsText: "Next: once your deposit is received, the contractor will be in touch to schedule the work.",
    signatureDataUrl: null,
    pay: {
      heading: "How to pay",
      lead: "Pay the deposit whichever way suits you.",
      rows: [{ name: "Cash App", value: "$TestOnlyTag", how: "" }],
      notes: ["Put your name in the note so we know whose payment it is.", "The amounts above are as of 10/2/2026."],
    },
  });

  // It stands alone: a real document, with its own styling, openable months
  // later with no network.
  assert.match(doc, /^<!doctype html>/);
  assert.match(doc, /<meta charset="utf-8">/);
  assert.match(doc, /<style>/);
  assert.doesNotMatch(doc, /<script/i, "a saved file must not carry anything that runs");

  // Everything she needs to know what she agreed to.
  for (const needed of [
    "Test Fence Co", // who
    "Test Homeowner", // whose
    "1 Test Lane", // where
    "Vinyl fence", // what
    "$10,000.00", // the agreed total
    "$2,600.00", // the deposit
    "Approved by Test Homeowner on 10/2/2026", // her signature, by name, and the date
    "How to pay", // and how
    "$TestOnlyTag",
    "schedule the work", // what happens next
  ]) {
    assert.ok(doc.includes(needed), `the downloaded copy is missing: ${needed}`);
  }

  // Positive control for the two fields this test added: with them empty the
  // document omits the blocks rather than drawing empty ones, so the
  // assertions above are about content and not about the template.
  const bare = buildQuoteDocument({
    lang: "en", title: "t", companyName: "c", customerHeading: "h", customerName: "n",
    scopeHeading: "s", scopeHtml: "<p>x</p>", totalsHeading: "p", totalsHtml: "<div>y</div>",
    approvalText: "", nextStepsText: "",
  });
  assert.ok(!bare.includes("schedule the work"));
  assert.ok(!bare.includes("Approved by"));
});

test("the download carries the anchored price, not the live one -- the file and the page cannot disagree", async () => {
  const w = world({ deposit_amount: 2600 });
  await approve(w, { total: 10000 });
  w.db.tables.jobs[0].contract_total = 12500; // he re-prices after she approved
  const page = await view(w);

  const { buildQuoteDocument, totalsRowsFor } = pageRows();
  const doc = buildQuoteDocument({
    lang: "en", title: "t", companyName: "c", customerHeading: "h", customerName: "n",
    scopeHeading: "s", scopeHtml: "<p>x</p>", totalsHeading: "p",
    totalsHtml: totalsRowsFor(page.body).join(""),
    approvalText: "Approved by Test Homeowner on 10/2/2026.",
  });
  assert.ok(doc.includes("$10,000.00"), "the saved copy must carry the accepted price");
  assert.ok(!doc.includes("$12,500.00"), "the live re-price reached the customer's own copy of the contract");
});

// =================================== what is NOT there, said out loud =====

test("NOTHING a customer can reach carries a cancellation clause or any contract terms", async () => {
  // His terms, cancellation clause included, are DEFAULT_CONTRACT_TERMS in
  // app/src/main/java/com/fenceestimator/app/data/ContractTemplate.kt. They are
  // read from the phone's own settings store and printed by PdfExporter.kt --
  // and they are NOT in the cloud settings blob (SettingsSync.kt's
  // CloudSettings has no contractTerms field), so no server function has a copy
  // to send. This test pins that, so "the contract is emailed to her" can never
  // be claimed without someone having to delete an assertion here first.
  const sync = readFileSync("app/src/main/java/com/fenceestimator/app/cloud/SettingsSync.kt", "utf8");
  assert.ok(
    !/contractTerms/.test(sync),
    "contract terms now sync to the cloud -- the quote page, the download and the email can carry the "
      + "cancellation clause, and docs/AFTER_APPROVAL.md question 1 is answerable. Update this test.",
  );
  // Positive control: the same file DOES carry other settings, so the absence
  // above is about contract terms and not about reading the wrong file.
  assert.match(sync, /orderEmailTemplate/, "SettingsSync.kt does not look like itself any more");

  // And nothing customer-facing says the word.
  const page = readFileSync("website/quote.html", "utf8");
  const emailWords = readFileSync("supabase/functions/quote-approval-email/email.ts", "utf8");
  for (const [what, src] of [["the quote page", page], ["the approval email", emailWords]]) {
    assert.ok(!/cancellation clause|right to cancel/i.test(src), `${what} claims to carry a cancellation clause`);
  }
});

test("there is no unapprove: the only action the customer endpoint takes is approve", async () => {
  // He asked for unapprove and it was never built. Pinned here so the answer
  // to "can she change her mind" is a measured no rather than a guess. What it
  // would take is written up in docs/AFTER_APPROVAL.md question 4.
  const w = world();
  await approve(w, { total: 10000 });
  for (const action of ["unapprove", "withdraw", "cancel", "reject"]) {
    const res = await w.handler(new Request(`https://fn.test/quote-view?t=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    }));
    assert.equal(res.status, 400, `"${action}" is not an action`);
    assert.equal((await res.json()).error, "Unknown action.");
  }
  // Her approval is still there afterwards.
  assert.ok(w.db.tables.jobs[0].quote_approved_at);
});

test("the page draws no approve controls at all on a blocked quote, and takes the ways-to-pay panel down", () => {
  // A SOURCE-SHAPE check, not a run: render() drives thirty DOM ids and the
  // 3D scene, so it is not extractable the way buildQuoteDocument is. Comments
  // are stripped before matching, because a check that can be satisfied by a
  // comment is not a check (the branch below is heavily commented).
  const src = readFileSync("website/quote.html", "utf8");
  const start = src.indexOf("} else if(q.approvalBlocked){");
  assert.ok(start > 0, "the blocked branch is gone from render()");
  const branch = src.slice(start, src.indexOf("\n  } else {", start)).replace(/^\s*\/\/.*$/gm, "");

  assert.match(branch, /\$\('approveBlockedBox'\)\.style\.display=''/, "the notice is not shown");
  assert.match(branch, /approveBlockedText'\)\.textContent=tr\('approveBlocked'\)/, "the notice has no words");
  assert.match(branch, /\$\('payHow'\)\.style\.display='none'/, "the ways-to-pay panel is left up");
  assert.match(branch, /payList=\[\]/, "payList is left populated");
  // Not a disabled button, not a hidden one: no approve control is touched
  // here at all, because the panel is simply never shown.
  assert.doesNotMatch(branch, /approveBox|approveBtn|approveOnlyBtn|showPayButton/, "the blocked branch touches an approve control");

  // Positive control: the ORDINARY branch does show them, so the absence
  // above is about this branch and not about the slice being empty.
  const ordinary = src.slice(src.indexOf("\n  } else {", start));
  assert.match(ordinary, /\$\('approveBox'\)\.style\.display=''/);
  assert.match(ordinary, /showPayButton\(\)/);

  // And the blocked branch comes before the ordinary one, so a blocked quote
  // can never fall through into it.
  assert.ok(src.indexOf("if(q.approvedAt){") < start, "the blocked branch is not in the approval chain");
});

// ============================================== the page's own code =====

/**
 * The real rendering functions out of website/quote.html, run standalone --
 * the money rows exactly as the page draws them (installTotals' idiom, same as
 * tests/quote-summary.test.mjs). `totalsRowsFor` takes a quote-view response
 * and returns the rows, so the page and the handler are joined up here rather
 * than the test asserting on its own idea of either.
 */
function pageRows() {
  const src = readFileSync("website/quote.html", "utf8");
  const grab = (name) => {
    const start = src.indexOf("function " + name + "(");
    if (start < 0) throw new Error("not found: " + name);
    let depth = 0;
    for (let j = src.indexOf("{", start); j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
    }
    throw new Error("unbalanced: " + name);
  };
  const { buildQuoteDocument } = new Function(
    grab("buildQuoteDocument")
      + "\nconst esc=(s)=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;')"
      + ".replace(/>/g,'&gt;').replace(/\"/g,'&quot;');"
      + "\nreturn { buildQuoteDocument };",
  )();

  // The deposit / balance rows, as render() builds them. Kept to the shape the
  // page uses -- deposit row and purpose note inside the `deposit > 0.005`
  // block, balance row outside it -- because that gate is the thing under test
  // (tests/a67-deposit-purpose-sentence.test.mjs pins the sentence itself).
  const money = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const totalsRowsFor = (q) => {
    const rows = [`<div class="grand"><span>Total</span><span>${money(q.total)}</span></div>`];
    const deposit = Number(q.deposit) || 0;
    if (deposit > 0.005) {
      rows.push(`<div><span>Deposit to begin</span><span>${money(deposit)}</span></div>`);
    }
    const balance = q.balanceDue != null ? Math.max(0, Number(q.balanceDue) || 0) : Math.max(0, q.total - deposit);
    rows.push(balance > 0.005
      ? `<div><span>Left to pay</span><span>${money(balance)}</span></div>`
      : `<div><span>Nothing left to pay</span><span>${money(0)}</span></div>`);
    return rows;
  };
  return { buildQuoteDocument, totalsRowsFor };
}

// ===================================== two holes found by mutation, 2 Oct =====
//
// Both of these were established by mutating the production source in a scratch
// copy of the tree and finding that every suite stayed green. They are not
// hypotheses.
// ============================================================================

test("the guard also protects an ONLINE-ONLY agreement -- accepted_total with no signature", async () => {
  // WHY THIS CASE EXISTS. priceShortfall reads
  //   Math.max(signed_contract_total, accepted_total)
  // and every other fixture in this file sets BOTH columns to the same figure,
  // so a guard that read only signed_contract_total passed the whole suite.
  // Measured: replacing that Math.max with num(job.signed_contract_total)
  // alone left this file at 0 failures.
  //
  // It is not hypothetical. One live job holds accepted_total 4,820.00 with
  // signed_contract_total 0 and no signed_at at all -- an acceptance recorded
  // online, never physically signed -- and the accepted_total arm of that
  // Math.max is the only thing standing between it and an undercut.
  const AGREED = 4820;
  const LIVE = 1500;
  const onlineOnly = {
    signed_contract_total: 0,
    signed_at: null,
    accepted_total: AGREED,
    quote_approved_at: null,
    contract_total: LIVE,
    status: "SENT",
  };

  const w = world(onlineOnly);
  const page = await view(w);
  // Nothing anchors the price (billableTotal needs signed_at or
  // quote_approved_at), so the page shows the live figure -- and says the
  // approve button would be refused.
  assert.equal(page.body.total, LIVE, "the page shows the live figure");
  assert.equal(page.body.approvalBlocked, "price_below_agreed", "the page is not warned");

  const r = await approve(w, { total: LIVE });
  assert.equal(r.status, 409, "an accepted_total-only agreement was not protected");
  assert.equal(r.body.code, "price_below_agreed");
  assert.equal(recorded(w), null, "something was written");
  assert.equal(w.db.tables.jobs[0].accepted_total, AGREED, "the online agreement was overwritten");

  // CANARY: with the accepted_total arm taken away -- the exact mutation that
  // survived -- this job approves at 1,500.00 against an agreed 4,820.00. So
  // the assertions above are about that arm and not about the guard in general.
  const blind = (js) => {
    const needle = "Math.max(num(job.signed_contract_total), num(job.accepted_total))";
    assert.ok(js.includes(needle), "the canary's mutation point has moved; this case no longer tests that arm");
    return js.replace(needle, "num(job.signed_contract_total)");
  };
  const w2 = world(onlineOnly, { mutate: blind });
  assert.equal((await view(w2)).body.approvalBlocked, null, "the canary did not blind the guard");
  const r2 = await approve(w2, { total: LIVE });
  assert.equal(r2.status, 200, "the canary did not blind the guard");
  assert.equal(recorded(w2), LIVE, `the blinded guard recorded ${LIVE} against an agreed ${AGREED}`);
});

test("the download CALL SITE hands the template every field it reads", () => {
  // WHY A CONTRACT AND NOT A CONTENT CHECK. The download tests above build the
  // buildQuoteDocument argument themselves, so they prove the TEMPLATE renders
  // what it is given -- not that downloadQuoteCopy gives it. Measured: deleting
  //   nextStepsText: $('nextSteps').textContent||'',
  // from the call site left a69, a67, a54 and a38 all at 0 failures, so "she is
  // told what happens next" could have been silently dropped from the file she
  // keeps. (a54 does catch approvalText and pay; nothing caught nextStepsText.)
  //
  // So: whatever the template reads off its argument, the call site must pass.
  // That holds for fields added later without anyone remembering this test.
  const src = readFileSync("website/quote.html", "utf8");
  const bodyOf = (name) => {
    const start = src.indexOf("function " + name + "(");
    assert.ok(start > 0, "not found: " + name);
    let depth = 0;
    for (let j = src.indexOf("{", start); j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
    }
    throw new Error("unbalanced: " + name);
  };
  // Shorthand (`signatureDataUrl,`) counts as passed, same as `name: value`.
  const keysOf = (s) => new Set([...s.matchAll(/^\s{4}([A-Za-z_$][\w$]*)\s*[:,]/gm)].map((m) => m[1]));

  const template = bodyOf("buildQuoteDocument");
  const callBody = bodyOf("downloadQuoteCopy");
  const callArgs = callBody.slice(callBody.indexOf("buildQuoteDocument({"));
  assert.ok(callArgs.includes("buildQuoteDocument({"), "downloadQuoteCopy no longer calls buildQuoteDocument");

  const reads = [...new Set([...template.matchAll(/\bd\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))].sort();
  const passed = keysOf(callArgs);
  // Positive control: the sets are non-trivial. A parse that found nothing
  // would otherwise report a clean sheet -- the shape of empty-answer-reads-
  // as-good-news this project keeps writing rules about.
  assert.ok(reads.length >= 14, `the template read-scan found only ${reads.length} fields`);
  assert.ok(passed.size >= 14, `the call-site scan found only ${passed.size} fields`);
  // And the two fields this test was written for are really in the scans.
  for (const f of ["nextStepsText", "approvalText", "totalsHtml", "pay", "signatureDataUrl"]) {
    assert.ok(reads.includes(f), `the template no longer reads ${f}`);
  }

  const missing = reads.filter((f) => !passed.has(f));
  assert.deepEqual(missing, [], `the saved copy never receives: ${missing.join(", ")}`);

  // PLANTED: the same comparison against a call site with one field deleted
  // must fail, so the deepEqual above is a check and not a formality.
  const withoutNext = new Set(passed);
  withoutNext.delete("nextStepsText");
  assert.ok(reads.filter((f) => !withoutNext.has(f)).length === 1, "the planted deletion was not noticed");

  // CANARY: a field the template does not read is not demanded of the call
  // site, so this test cannot be satisfied by padding the call with junk.
  assert.ok(!reads.includes("thereIsNoSuchField"));
});
