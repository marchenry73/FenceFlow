// What the customer's quote link says about HOW TO PAY (Cash App, Zelle, wire,
// cash) -- supabase/functions/quote-view/index.ts, the `paymentMethods` block.
//
// Run with:  node --test tests/a38-payment-methods-quote-view.test.mjs
//
// The function runs for real: its TypeScript stripped by Node, its imports
// swapped for a fake service-role client and the REAL shared modules, and
// Deno.serve handing over the real request handler. The same harness
// tests/a15-signature-approval.test.mjs uses. Nothing touches the network or a
// database. Every value typed in here is obviously fake ("TestOnly...") -- the
// real app holds no company's payment details and this file invents none.
//
// WHAT THIS GUARDS
//   1. A payment method reaches a customer ONLY when the owner switched it on
//      (=== true) AND filled it in. Off, empty, malformed, over-long: nothing.
//      A payment destination that is wrong or invented is the worst bug this
//      endpoint could have, so every doubtful input fails CLOSED.
//   2. Nothing else leaks alongside it. company_settings also holds the labour
//      rate, markup and minimum charge; the response must carry none of it, and
//      the read must ask for the one key, not the blob.
//   3. A failed read of the payment settings never takes the quote down, never
//      blanks the company name, and is told apart from "nothing set up".
//   4. One company's settings are never served on another company's quote.
//   5. The page can never be told about a card fee, because there is none:
//      create-payment-link adds nothing to a customer's payment.
//
// Every "it is served" test sits beside a "it is not served" test built from
// the same fixture, so a function that served nothing -- or everything -- could
// not pass by accident.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import * as quoteDeposit from "../supabase/functions/_shared/quote-deposit.ts";
import * as jobPush from "../supabase/functions/_shared/job-push.ts";
import * as pushRecipients from "../supabase/functions/_shared/push-recipients.ts";

const COMPANY = "c3800000-0000-4000-8000-000000000001";
const OTHER_COMPANY = "c3800000-0000-4000-8000-000000000002";
const JOB = "a3800000-0000-4000-8000-00000000000a";
const JOB_ID = "13800000-0000-4000-8000-000000000001";
const TOKEN = "b3800000-0000-4000-8000-00000000000b";
const NO_TAG = { cashApp: "", zelle: "", wire: "", cash: false };

// ============================================================ harness =====
const SHARED = {
  "../_shared/quote-deposit.ts": quoteDeposit,
  "../_shared/job-push.ts": jobPush,
  "../_shared/push-recipients.ts": pushRecipients,
};

// A38_MUTANT points at a deliberately broken copy of quote-view, so the tests
// can be shown to FAIL when the function is wrong (see the mutation run in the
// hand-off). Unset, which is every normal run, this reads the real source.
const QUOTE_VIEW_SRC = process.env.A38_MUTANT
  ? pathToFileURL(process.env.A38_MUTANT)
  : new URL("../supabase/functions/quote-view/index.ts", import.meta.url);

function load(path, db) {
  let js = stripTypeScriptTypes(readFileSync(QUOTE_VIEW_SRC, "utf8"));
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
  new Function("Deno", "fetch", ...names, js)(Deno, async () => new Response("{}", { status: 404 }), ...names.map((n) => provided[n]));
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

/**
 * An in-memory service-role client. company_settings honours PostgREST's
 * `alias:column->key` select, which is how the function asks for one key of the
 * blob: the stand-in returns ONLY that key under that alias, the way PostgREST
 * does, and a plain select of `settings` or `*` returns the whole blob -- so a
 * function that read more than it needed would be handed more, and the leak
 * test below would catch what it did with it.
 */
function fakeDb(tables, { settingsError = null, settingsThrows = false } = {}) {
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
      if (this.table === "company_settings") {
        if (settingsThrows) throw new Error("planted: network down");
        if (settingsError) return { data: null, error: { message: settingsError } };
      }
      const rows = (t[this.table] ??= []);
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") { hit.forEach((r) => Object.assign(r, this.payload)); return { data: null, error: null }; }
      const alias = this.table === "company_settings"
        ? /^(\w+):settings->(\w+)$/.exec(String(this.cols).trim()) : null;
      const cols = String(this.cols).split(",").map((c) => c.trim()).filter(Boolean);
      const project = (r) => {
        if (alias) return { [alias[1]]: r.settings?.[alias[2]] };
        return (cols.length === 0 || cols.includes("*")) ? r : Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]]));
      };
      const out = hit.map(project);
      if (this.mode === "maybe") return { data: out[0] ?? null, error: null };
      if (this.mode === "one") return out[0] ? { data: out[0], error: null } : { data: null, error: { message: "no row" } };
      return { data: out, error: null };
    }
  }
  return { tables: t, log, from: (table) => new Query(table), rpc: async () => ({ data: true, error: null }) };
}

const sentJob = (o = {}) => ({
  id: JOB_ID, sync_id: JOB, company_id: COMPANY, customer_name: "Pat Buyer", address: "1 Oak St",
  phone: "", status: "SENT", deleted_at: null, quote_token: TOKEN,
  contract_total: 5000, accepted_total: null, signed_at: null,
  quote_approved_at: null, quote_approved_name: "", quote_approved_signature_path: null,
  reapproval_required_at: null, reapproval_reason: "",
  amount_paid: 0, refunded_amount: 0, deposit_amount: 0, tax_rate_percent: 0, discount_percent: 0,
  quote_viewed_at: "2026-09-01T00:00:00Z", calibration_pixels_per_foot: 20,
  quote_phone_attempts: 0, quote_phone_locked_until: null,
  ...o,
});

/** `settings` is the company_settings blob for COMPANY, or undefined for "no row at all". */
function world({ settings, extraSettingsRows = [], opts = {}, job = {} } = {}) {
  const db = fakeDb({
    jobs: [sentJob(job)],
    companies: [
      { id: COMPANY, name: "Test Fence Co", phone: "555-0100", email: "office@example.invalid" },
      { id: OTHER_COMPANY, name: "Other Fence Co", phone: "", email: "" },
    ],
    company_settings: [
      ...(settings === undefined ? [] : [{ company_id: COMPANY, settings }]),
      ...extraSettingsRows,
    ],
    estimate_line_items: [], change_orders: [], fence_runs: [], payment_connections: [],
  }, opts);
  return { db, handler: load("../supabase/functions/quote-view/index.ts", db) };
}

const view = async (w, token = TOKEN) => {
  const res = await w.handler(new Request(`https://fn.test/quote-view?t=${token}`));
  return { status: res.status, body: await res.json() };
};

const full = {
  cash_app: { on: true, tag: "TestOnlyTag" },
  zelle: { on: true, to: "test-only@example.invalid" },
  wire: { on: true, details: "Bank: TEST ONLY BANK\nAccount name: TEST ONLY LLC\nRouting: 000000000\nAccount: 000000000" },
  cash: { on: true },
};
/** One method on its own, so a test can say exactly what it is about. */
const only = (key, value) => ({ payment_methods: { [key]: value } });

// ===================================================== served, and not =====

test("a company that has set nothing up gets an all-empty block -- nothing is invented", async () => {
  // Both ways "nothing" can look: no settings row at all, and a row with no key.
  for (const settings of [undefined, {}, { labor_rate: 8 }]) {
    const { status, body } = await view(world({ settings }));
    assert.equal(status, 200);
    assert.deepEqual(body.paymentMethods, NO_TAG, `settings ${JSON.stringify(settings)}`);
  }
});

test("a fully set up company is served exactly its four methods (the positive control for every 'not served' test below)", async () => {
  const { status, body } = await view(world({ settings: { payment_methods: full } }));
  assert.equal(status, 200);
  assert.deepEqual(body.paymentMethods, {
    cashApp: "$TestOnlyTag",
    zelle: "test-only@example.invalid",
    wire: "Bank: TEST ONLY BANK\nAccount name: TEST ONLY LLC\nRouting: 000000000\nAccount: 000000000",
    cash: true,
  });
  // The existing quote is untouched alongside it.
  assert.equal(body.company.name, "Test Fence Co");
  assert.equal(body.total, 5000);
});

test("a method switched OFF is never sent, even with its details still typed in", async () => {
  const off = Object.fromEntries(Object.entries(full).map(([k, v]) => [k, { ...v, on: false }]));
  const { body } = await view(world({ settings: { payment_methods: off } }));
  assert.deepEqual(body.paymentMethods, NO_TAG);
});

test("switching on is strict: only the boolean true counts, not a truthy lookalike", async () => {
  for (const on of ["true", 1, "yes", "on", {}, []]) {
    const pm = Object.fromEntries(Object.entries(full).map(([k, v]) => [k, { ...v, on }]));
    const { body } = await view(world({ settings: { payment_methods: pm } }));
    assert.deepEqual(body.paymentMethods, NO_TAG, `on = ${JSON.stringify(on)}`);
  }
});

test("each method is independent: only the ones switched on appear", async () => {
  const pm = { ...full, zelle: { ...full.zelle, on: false }, cash: { on: false } };
  const { body } = await view(world({ settings: { payment_methods: pm } }));
  assert.equal(body.paymentMethods.cashApp, "$TestOnlyTag");
  assert.equal(body.paymentMethods.zelle, "");
  assert.ok(body.paymentMethods.wire.startsWith("Bank: TEST ONLY BANK"));
  assert.equal(body.paymentMethods.cash, false);
});

test("switched on but EMPTY shows nothing -- never an empty 'Zelle:' line", async () => {
  for (const blank of ["", "   ", "\n\n", "\u200e\u200f", null, undefined, 42]) {
    const pm = {
      cash_app: { on: true, tag: blank }, zelle: { on: true, to: blank }, wire: { on: true, details: blank },
      cash: { on: false },
    };
    const { body } = await view(world({ settings: { payment_methods: pm } }));
    assert.deepEqual(body.paymentMethods, NO_TAG, `blank = ${JSON.stringify(blank)}`);
  }
});

test("cash is a plain on/off: on means true, and needs nothing typed", async () => {
  assert.equal((await view(world({ settings: only("cash", { on: true }) }))).body.paymentMethods.cash, true);
  assert.equal((await view(world({ settings: only("cash", { on: false }) }))).body.paymentMethods.cash, false);
  assert.equal((await view(world({ settings: only("cash", {}) }))).body.paymentMethods.cash, false);
});

// ============================================================= Cash App =====

test("Cash App: the tag is served with exactly one leading $, however it was stored", async () => {
  for (const stored of ["TestOnlyTag", "$TestOnlyTag", "$$TestOnlyTag", "  $TestOnlyTag  ", "Test_Only.Tag-1"]) {
    const { body } = await view(world({ settings: only("cash_app", { on: true, tag: stored }) }));
    assert.equal(body.paymentMethods.cashApp, "$" + stored.trim().replace(/^\$+/, ""), JSON.stringify(stored));
  }
});

test("Cash App: invisible characters pasted in from a text message are removed, not left to break the tag", async () => {
  const { body } = await view(world({ settings: only("cash_app", { on: true, tag: "\u200e$Test\u200bOnly\u202eTag\ufeff" }) }));
  assert.equal(body.paymentMethods.cashApp, "$TestOnlyTag");
});

test("Cash App: anything that is not a plain tag FAILS CLOSED -- the page is never handed something that could break a link", async () => {
  for (const bad of ["Test Only", "a/b", "<script>alert(1)</script>", "tag\"onmouseover=\"x", "https://cash.app/$TestOnlyTag",
    "x".repeat(31), "ünï", "tag?x=1", "$", ""]) {
    const { body } = await view(world({ settings: only("cash_app", { on: true, tag: bad }) }));
    assert.equal(body.paymentMethods.cashApp, "", JSON.stringify(bad));
  }
  // The boundary itself: 30 characters is fine, 31 is not.
  assert.equal((await view(world({ settings: only("cash_app", { on: true, tag: "x".repeat(30) }) }))).body.paymentMethods.cashApp, "$" + "x".repeat(30));
});

// ================================================================ Zelle =====

test("Zelle: one line, exactly as typed -- a phone, an email, or both -- never classified or reshaped", async () => {
  for (const to of ["813-555-0100", "test-only@example.invalid", "813-555-0100 or test-only@example.invalid", "+1 (813) 555 0100"]) {
    const { body } = await view(world({ settings: only("zelle", { on: true, to }) }));
    assert.equal(body.paymentMethods.zelle, to);
  }
});

test("Zelle: stray whitespace and line breaks collapse to a single line", async () => {
  const { body } = await view(world({ settings: only("zelle", { on: true, to: "  test-only@example.invalid \n\t " }) }));
  assert.equal(body.paymentMethods.zelle, "test-only@example.invalid");
  const two = await view(world({ settings: only("zelle", { on: true, to: "813-555-0100\n\n  test-only@example.invalid" }) }));
  assert.equal(two.body.paymentMethods.zelle, "813-555-0100 test-only@example.invalid");
});

test("Zelle: too long is DROPPED, not cut short (200 characters is the limit)", async () => {
  assert.equal((await view(world({ settings: only("zelle", { on: true, to: "a".repeat(201) }) }))).body.paymentMethods.zelle, "");
  assert.equal((await view(world({ settings: only("zelle", { on: true, to: "a".repeat(200) }) }))).body.paymentMethods.zelle, "a".repeat(200));
});

// ================================================================= wire =====

test("Wire: the owner's own lines are kept, one per line, in order", async () => {
  const { body } = await view(world({ settings: only("wire", { on: true, details: "Line one\nLine two\nLine three" }) }));
  assert.equal(body.paymentMethods.wire, "Line one\nLine two\nLine three");
});

test("Wire: line endings, stray spaces and runs of blank lines are tidied, nothing else is touched", async () => {
  const { body } = await view(world({ settings: only("wire", { on: true, details: "\r\n  Bank: X  \r\n\r\n\r\n\r\nAccount: 1 2 3\r\n\r\n" }) }));
  assert.equal(body.paymentMethods.wire, "Bank: X\n\nAccount: 1 2 3");
});

test("Wire: markup is passed through as plain text for the page to ESCAPE -- the server neither trusts nor rewrites it", async () => {
  const text = "<b>Bank</b> & Co <img src=x onerror=alert(1)>";
  const { body } = await view(world({ settings: only("wire", { on: true, details: text }) }));
  assert.equal(body.paymentMethods.wire, text);
  assert.equal(typeof body.paymentMethods.wire, "string");
});

test("Wire: too long is DROPPED, not cut short -- half an account number is a payment sent nowhere (1500 is the limit)", async () => {
  const over = await view(world({ settings: only("wire", { on: true, details: "9".repeat(1501) }) }));
  assert.equal(over.body.paymentMethods.wire, "");
  const at = await view(world({ settings: only("wire", { on: true, details: "9".repeat(1500) }) }));
  assert.equal(at.body.paymentMethods.wire, "9".repeat(1500));
});

// ============================================================ hostile input =====

test("a malformed block is read as nothing, never an error and never a guess", async () => {
  for (const pm of ["cash app please", 42, true, [], [full], { cash_app: "TestOnlyTag" }, { cash_app: [] }, { cash_app: null },
    { cash_app: { on: true } }, { wire: { on: true, details: { not: "text" } } }]) {
    const { status, body } = await view(world({ settings: { payment_methods: pm } }));
    assert.equal(status, 200, JSON.stringify(pm));
    assert.deepEqual(body.paymentMethods, NO_TAG, JSON.stringify(pm));
  }
});

// ================================================================ no leak =====

test("NOTHING else from the settings blob reaches the response, and the read asks for the one key, not the blob", async () => {
  const canaries = {
    labor_rate: 7777.11, markup: 8888.22, min_job_charge: 9999.33, tax_rate: 6.66, gate_rate: 4321.5,
    order_template: "CANARY-order-template", hoa_template: "CANARY-hoa-template", owner_name: "CANARY Owner",
    business_name: "CANARY Biz", deposit_percent: 4242.4,
  };
  const pm = { ...full, cash_app: { ...full.cash_app, pin: "CANARY-PIN" }, secret: "CANARY-SECRET", internal_note: { x: "CANARY-NOTE" } };
  const w = world({ settings: { ...canaries, payment_methods: pm } });
  const { body } = await view(w);

  // Positive control: the block IS served, so the absence below means something.
  assert.equal(body.paymentMethods.cashApp, "$TestOnlyTag");

  const wire = JSON.stringify(body);
  for (const [k, v] of Object.entries(canaries)) {
    assert.ok(!wire.includes(String(v)), `the value of settings.${k} reached the customer`);
  }
  for (const c of ["CANARY-PIN", "CANARY-SECRET", "CANARY-NOTE"]) assert.ok(!wire.includes(c), `${c} reached the customer`);
  assert.ok(!wire.includes("labor_rate") && !wire.includes("markup"), "a settings KEY name reached the customer");
  assert.deepEqual(Object.keys(body.paymentMethods).sort(), ["cash", "cashApp", "wire", "zelle"], "the block carries exactly four fields");

  // The one read of company_settings asked for the one key.
  const reads = w.db.log.filter((l) => l.table === "company_settings");
  assert.equal(reads.length, 1, "company_settings is read once");
  assert.equal(reads[0].cols, "payment_methods:settings->payment_methods");
  // And the companies select did not grow: it still names only what the page shows.
  const companyReads = w.db.log.filter((l) => l.table === "companies");
  assert.deepEqual(companyReads.map((l) => l.cols), ["name, phone, email"]);
});

test("the response gained exactly one top-level key, paymentMethods", async () => {
  const before = Object.keys((await view(world({ settings: undefined }))).body).filter((k) => k !== "paymentMethods");
  // approvalBlocked added 2 Oct 2026 with the price-collapse guard
  // (tests/a69-after-approval.test.mjs): null here, a code when approving
  // would be refused.
  const expected = ["address", "approvalBlocked", "approvedAt", "approvedBy", "approvedSignatureUrl", "balanceDue",
    "company", "customerName",
    "deposit", "depositDue", "depositPayable", "phoneGateRequired", "paymentsReady", "pxPerFoot", "reapprovalRequiredAt",
    "reapprovalRunLabel", "runs", "signatureCaptureReady", "total"];
  assert.deepEqual([...before].sort(), [...expected].sort(), "an unrelated field appeared or vanished");
  const after = Object.keys((await view(world({ settings: { payment_methods: full } }))).body);
  assert.deepEqual(after.filter((k) => !before.includes(k)), ["paymentMethods"]);
});

test("one company's payment details are never served on another company's quote", async () => {
  const w = world({
    settings: undefined, // COMPANY (the quote's company) has nothing of its own...
    extraSettingsRows: [{ company_id: OTHER_COMPANY, settings: { payment_methods: full } }], // ...the other one has everything
  });
  const { body } = await view(w);
  assert.deepEqual(body.paymentMethods, NO_TAG);
  assert.ok(!JSON.stringify(body).includes("TestOnlyTag"));

  // Control: give the quote's own company a DIFFERENT tag; it is that one served.
  const mine = world({
    settings: only("cash_app", { on: true, tag: "MineNotTheirs" }),
    extraSettingsRows: [{ company_id: OTHER_COMPANY, settings: { payment_methods: full } }],
  });
  const own = await view(mine);
  assert.equal(own.body.paymentMethods.cashApp, "$MineNotTheirs");
  assert.equal(own.body.paymentMethods.zelle, "", "the other company's Zelle leaked in");
});

test("a token that finds no quote reads no settings at all", async () => {
  const w = world({ settings: { payment_methods: full } });
  const none = await view(w, "00000000-0000-4000-8000-000000000000");
  assert.equal(none.status, 404);
  assert.equal(none.body.paymentMethods, undefined);
  assert.equal(w.db.log.filter((l) => l.table === "company_settings").length, 0);
  const bad = await view(w, "not-a-token");
  assert.equal(bad.status, 400);
  assert.equal(w.db.log.filter((l) => l.table === "company_settings").length, 0);
  // A deleted quote answers the same way and reads nothing either.
  const gone = world({ settings: { payment_methods: full }, job: { deleted_at: "2026-09-02T00:00:00Z" } });
  assert.equal((await view(gone)).status, 404);
  assert.equal(gone.db.log.filter((l) => l.table === "company_settings").length, 0);
});

// ============================================================== failures =====

test("a failed read of the settings leaves the quote working, the name intact, and the block ABSENT -- not 'nothing set up'", async () => {
  const seen = [];
  const orig = console.error;
  console.error = (...a) => seen.push(a.join(" "));
  try {
    for (const opts of [{ settingsError: "planted: relation does not exist" }, { settingsThrows: true }]) {
      const { status, body } = await view(world({ settings: { payment_methods: full }, opts }));
      assert.equal(status, 200);
      assert.equal(body.company.name, "Test Fence Co", "the company name was blanked by the payment read");
      assert.equal(body.total, 5000);
      assert.equal(Object.hasOwn(body, "paymentMethods"), false, "a failed read must not look like an empty one");
    }
  } finally {
    console.error = orig;
  }
  assert.equal(seen.filter((s) => s.includes("quote-view payment methods")).length, 2, "both failures were logged");
});

// =========================================================== no card fee =====

test("there is no card-fee field on the response, and the code that charges a customer adds none", async () => {
  const { body } = await view(world({ settings: { payment_methods: full } }));
  const keys = [];
  const walk = (o, path = "") => {
    if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { keys.push(path + k); walk(v, path + k + "."); }
  };
  walk(body);
  assert.deepEqual(keys.filter((k) => /fee|surcharge|processing/i.test(k)), [], "a fee-shaped field appeared on the quote response");

  // The truth the page copy depends on: nothing is added to a customer's payment.
  const pay = readFileSync(new URL("../supabase/functions/create-payment-link/index.ts", import.meta.url), "utf8");
  assert.match(pay, /^\s*const stripeFee = 0;/m, "create-payment-link no longer pins the customer card fee to 0 -- the dashboard note and the quote page may no longer say there is none");
  assert.equal([...pay.matchAll(/\bstripeFee\s*=[^=]/g)].length, 1, "stripeFee is assigned in more than one place");
  assert.match(pay, /price_money:\s*\{\s*amount,\s*currency:\s*"USD"\s*\}/, "the Square link no longer charges exactly the amount");
});

test("quote-view's source says deliberately what goes out (the bank-details decision is on the page, not by accident)", () => {
  const src = readFileSync(new URL("../supabase/functions/quote-view/index.ts", import.meta.url), "utf8");
  assert.match(src, /BANK DETAILS ARE SENT TO ANY HOLDER OF THE LINK, KNOWINGLY/);
  assert.match(src, /\.select\("payment_methods:settings->payment_methods"\)/);
  // Not a spread of the settings: a whitelist, so a key added tomorrow stays out.
  assert.doesNotMatch(src, /\.\.\.\s*\(?\s*(data|settings|stored)\b/);
});
