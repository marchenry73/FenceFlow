// tests/a47-deposit-truth.test.mjs
//
// 1 Oct 2026. "The deposit is not looking too good on the web quote, it shows
// the wrong deposit price." What was established before this file was written,
// from the live database (SELECT only) and from the live quote-view function
// (GET only, on links that had already been opened so nothing was stamped):
//
//   * quote-view serves the STORED jobs.deposit_amount, capped at the price
//     that stands. It never serves a suggestion. On every job it could be
//     asked about, served deposit == stored deposit, to the cent.
//   * What disagrees is the stored figure against what the phone offers. The
//     phone SUGGESTS the rule figure (materials still to be bought, up to the
//     next $100, plus $100) and stores nothing until a person taps; and the
//     database trigger zz_deposit_follows_price rescales whatever IS stored, in
//     proportion, on every re-price of a draft, without moving updated_at, so a
//     phone never hears of it. A job whose rule figure was $3,000 was being
//     served $1,673.13 on the page.
//
// So this file pins the half that is the page's to get right, and does not
// pretend to pin the half that is not:
//
//   1. THE PAGE SHOWS WHAT WAS STORED AND NOTHING ELSE. The same stored figure
//      is served whatever the materials on the job are; a different stored
//      figure is served as that figure. A stored zero is a page that says
//      nothing about a deposit, never a guess. (If this ever changes to show a
//      suggestion, a customer is asked for a number the contractor never
//      agreed to.)
//   2. THE EXTRA HUNDRED IS NEVER DISCLOSED. One deposit figure: no field, no
//      number, no wording in the response, and none in the page's three
//      languages, that would let a customer work out materials, the rounding or
//      the $100 for scheduling and transport.
//   3. THE TWO LANGUAGES AGREE ON THE SUGGESTION'S SHAPE (the cap, the cents,
//      the net-of-payments subtraction), on top of the shared vectors that
//      tests/a29-deposit-and-rounding.test.mjs and JobMoneyDepositRuleTest.kt
//      both run.
//   4. THE PROPOSED DATABASE FIX only removes a trigger. It cannot touch a row.
//
// Every guard has a planted failure beside it that the same checker must catch,
// so a checker that passes whatever it is shown cannot hide in here.
//
// Run with: node --test tests/a47-deposit-truth.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as quoteDeposit from "../supabase/functions/_shared/quote-deposit.ts";
import * as jobPush from "../supabase/functions/_shared/job-push.ts";
import * as pushRecipients from "../supabase/functions/_shared/push-recipients.ts";

const { ruleDeposit, suggestedDeposit } = quoteDeposit;
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** Source with comments removed, so a check reads the code and not the history written beside it. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");

// ============================================================ harness =====
// The same real-function harness tests/a29-deposit-and-rounding.test.mjs uses:
// quote-view's TypeScript stripped by Node, its imports swapped for a fake
// service-role client and the REAL shared modules. No network, no database.

const COMPANY = "c4700000-0000-4000-8000-000000000001";
const JOB = "a4700000-0000-4000-8000-00000000000a";
const JOB_ID = "14700000-0000-4000-8000-000000000001";
const TOKEN = "b4700000-0000-4000-8000-00000000000b";

const SHARED = {
  "../_shared/quote-deposit.ts": quoteDeposit,
  "../_shared/job-push.ts": jobPush,
  "../_shared/push-recipients.ts": pushRecipients,
};

function load(db) {
  // A47_MUTANT points at a deliberately broken copy of quote-view, so the
  // tests can be shown to FAIL when the function is wrong. Unset, which is
  // every normal run, this reads the real source.
  let js = stripTypeScriptTypes(process.env.A47_MUTANT ? readFileSync(process.env.A47_MUTANT, "utf8") : read("supabase/functions/quote-view/index.ts"));
  const importRe = /^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";?[ \t]*$/gm;
  const provided = {};
  for (const [, list, from] of js.matchAll(importRe)) {
    const names = list.split(",").map((n) => n.trim()).filter(Boolean);
    if (/supabase-js/.test(from)) provided.createClient = () => db;
    else if (Object.hasOwn(SHARED, from)) {
      for (const n of names) { assert.ok(n in SHARED[from], `${from} exports no ${n}`); provided[n] = SHARED[from][n]; }
    } else assert.fail(`an import the harness does not supply: ${from}`);
  }
  js = js.replace(importRe, "").replace(/^export /gm, "");
  let handler = null;
  const Deno = { env: { get: () => undefined }, serve: (h) => { handler = h; } };
  const names = Object.keys(provided);
  new Function("Deno", "fetch", ...names, js)(Deno, async () => new Response("{}", { status: 404 }), ...names.map((n) => provided[n]));
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

function fakeDb(tables) {
  const t = structuredClone(tables);
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.cols = "*"; }
    select(cols) { this.cols = cols ?? "*"; return this; }
    eq(k, v) { this.filters.push((r) => String(r[k]) === String(v)); return this; }
    is(k, v) { this.filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return this; }
    order() { return this; }
    limit() { return this; }
    update() { return this; }
    maybeSingle() { this.mode = "maybe"; return this.run(); }
    single() { this.mode = "one"; return this.run(); }
    then(ok, bad) { return this.run().then(ok, bad); }
    async run() {
      const rows = (t[this.table] ??= []).filter((r) => this.filters.every((f) => f(r)));
      const cols = String(this.cols).split(",").map((c) => c.trim()).filter(Boolean);
      const project = (r) => (cols.includes("*") ? r : Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])));
      const out = rows.map(project);
      if (this.mode === "maybe") return { data: out[0] ?? null, error: null };
      if (this.mode === "one") return { data: out[0] ?? null, error: out[0] ? null : { message: "no row" } };
      return { data: out, error: null };
    }
  }
  return { from: (table) => new Query(table), rpc: async () => ({ data: true, error: null }) };
}

function quoteWorld({ job = {}, lines = [] } = {}) {
  const db = fakeDb({
    jobs: [{
      id: JOB_ID, sync_id: JOB, company_id: COMPANY, customer_name: "Pat Buyer", address: "1 Oak St", phone: "",
      status: "SENT", deleted_at: null, quote_token: TOKEN, contract_total: 0, accepted_total: null, signed_at: null,
      quote_approved_at: null, quote_approved_name: "", reapproval_required_at: null, reapproval_reason: "",
      amount_paid: 0, refunded_amount: 0, deposit_amount: 0, tax_rate_percent: 0, discount_percent: 0,
      quote_viewed_at: "2026-10-01T12:00:00Z", calibration_pixels_per_foot: 20,
      quote_phone_attempts: 0, quote_phone_locked_until: null, ...job,
    }],
    companies: [{ id: COMPANY, name: "Test Fence Co", phone: "", email: "" }],
    estimate_line_items: lines.map((l, i) => ({ company_id: COMPANY, job_sync_id: JOB, deleted_at: null, taxable: false, sort_order: i, ...l })),
    change_orders: [], fence_runs: [], payment_connections: [],
  });
  return load(db);
}

const view = async (handler) => {
  const res = await handler(new Request(`https://fn.test/quote-view?t=${TOKEN}`));
  return { status: res.status, body: await res.json() };
};

const materialsLine = (amount) => [{ description: "Fence materials", quantity: 1, unit_price: amount }];

// ================================================== 1. stored, not suggested ==

test("the page serves the STORED deposit, to the cent -- and the rule's figure for the same materials is a different number", async () => {
  // The live shape that started this: 2,828.48 of materials on a 4,670.46 job.
  // The rule says 3,000. What was stored, after the trigger had rescaled it, was 1,673.13.
  assert.equal(ruleDeposit(2828.48), 3000);
  for (const [stored, why] of [
    [1673.13, "a figure the trigger rescaled into cents"],
    [1690, "a figure stored under the old round-to-ten rule"],
    [3000, "the rule's own figure (the positive control: when it IS stored, it IS served)"],
    [2500, "a figure the owner typed"],
  ]) {
    const { status, body } = await view(quoteWorld({
      job: { contract_total: 4670.46, deposit_amount: stored }, lines: materialsLine(2828.48),
    }));
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.deposit, stored, `${why}: served deposit`);
    assert.equal(body.depositDue, stored, `${why}: served due`);
    assert.equal(body.depositPayable, true, why);
    assert.equal(body.total, 4670.46, why);
  }
});

test("a stored zero is a page that says nothing about a deposit -- never a guess from the materials", async () => {
  const { body } = await view(quoteWorld({
    job: { contract_total: 4670.46, deposit_amount: 0 }, lines: materialsLine(2828.48),
  }));
  assert.equal(body.deposit, 0);
  assert.equal(body.depositDue, 0);
  assert.equal(body.depositPayable, false);
  // PLANTED: a page that DID suggest would have said 3,000 here.
  assert.equal(suggestedDeposit({ materialCost: 2828.48, amountPaid: 0, refundedAmount: 0, billableTotal: 4670.46 }).amount, 3000);
  assert.notEqual(body.deposit, 3000);
});

test("the served deposit does not depend on the materials at all: the same stored figure, three very different material totals", async () => {
  const served = [];
  for (const materials of [100, 2828.48, 90000]) {
    const { body } = await view(quoteWorld({
      job: { contract_total: 6200, deposit_amount: 1800 }, lines: materialsLine(materials),
    }));
    served.push(body.deposit);
  }
  assert.deepEqual(served, [1800, 1800, 1800]);
  // PLANTED: the rule's figure for those same materials is three different numbers.
  assert.deepEqual([100, 2828.48, 90000].map((m) => ruleDeposit(m)), [200, 3000, 90100]);
});

test("a stored deposit above the price that stands is served at the price, never above it (Woody: stored 3,963 against a 3,620 acceptance)", async () => {
  const over = await view(quoteWorld({ job: { contract_total: 5000, deposit_amount: 8000 } }));
  assert.equal(over.body.deposit, 5000);
  const anchored = await view(quoteWorld({
    job: { contract_total: 3963, deposit_amount: 3963, accepted_total: 3620, signed_at: "2026-09-01T00:00:00Z" },
  }));
  assert.equal(anchored.body.total, 3620);
  assert.equal(anchored.body.deposit, 3620);
  // CONTROL: under the cap, the stored figure passes through untouched.
  const under = await view(quoteWorld({ job: { contract_total: 5000, deposit_amount: 1250.5 } }));
  assert.equal(under.body.deposit, 1250.5);
});

test("quote-view never reaches for the rule: it cannot add the extra hundred, only serve what was stored", () => {
  const src = code(read("supabase/functions/quote-view/index.ts"));
  for (const name of ["ruleDeposit", "suggestedDeposit", "DEPOSIT_PLUS", "DEPOSIT_ROUND_UP_TO"]) {
    assert.ok(!src.includes(name), `quote-view reaches for ${name}`);
  }
  assert.match(src, /const deposit = money\.asked;/, "the served deposit is depositFigures().asked");
});

// ============================================== 2. the extra $100 is never told ==

/** Wording that would explain the extra hundred, or the rounding behind the figure. */
const WORDING = [
  /transport/i,
  /surcharge|recargo|suppl[eé]ment/i,
  /mobili[sz]ation/i,
  /scheduling\s+(fee|charge|cost)|(fee|charge|cost)\s+(for|to)\s+schedul/i,
  /\$\s?100(\.00)?\b/,
  /\b(extra|additional)\s+(\$\s?)?(100|hundred)\b/i,
  /\bplus\s+(an?\s+)?(extra\s+)?(\$\s?)?(100|hundred)\b/i,
  /rounded?\s+up/i,
  /next\s+(\$\s?)?hundred/i,
];
const EXTRA_KEY = /^(extra|surcharge|handling|mobili[sz]ation|transport(ation)?|scheduling|schedule|rounded|rounding)$/i;
const DEPOSIT_KEYS_ALLOWED = new Set(["deposit", "depositDue", "depositPayable"]);
const tokens = (key) => key.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s_\-]+/).filter(Boolean);

/**
 * Every way a response could let a customer take the extra hundred apart:
 * a deposit-shaped field beyond the three allowed, a field named for the
 * extra, a number equal to the materials / the rounded materials / the extra
 * itself, or wording about it. Returns the problems found.
 */
function disclosureProblems(body, forbiddenNumbers) {
  const problems = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (/^deposit/i.test(k) && !DEPOSIT_KEYS_ALLOWED.has(k)) problems.push(`field ${path}.${k}: a second deposit-shaped field`);
        if (tokens(k).some((t) => EXTRA_KEY.test(t))) problems.push(`field ${path}.${k}: named for the extra`);
        walk(x, `${path}.${k}`);
      }
      return;
    }
    if (typeof v === "number" && forbiddenNumbers.includes(v)) problems.push(`number ${v} at ${path}`);
    if (typeof v === "string") for (const re of WORDING) if (re.test(v)) problems.push(`wording ${re} in ${path}`);
  };
  walk(body, "$");
  return problems;
}

test("the response carries ONE deposit figure: no field, no number, no wording that exposes materials, the rounding or the extra hundred", async () => {
  // 1,630 of materials: the rule rounds to 1,700 and adds 100 = 1,800 stored.
  assert.equal(ruleDeposit(1630), 1800);
  const { status, body } = await view(quoteWorld({
    job: { contract_total: 6200, deposit_amount: 1800 }, lines: materialsLine(1630),
  }));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.deposit, 1800, "positive control: the deposit IS in the response, so the scan below has something to find");
  assert.deepEqual(disclosureProblems(body, [1630, 1700, 100]), []);
  // The deposit keys are exactly the three the page reads.
  assert.deepEqual(Object.keys(body).filter((k) => /^deposit/i.test(k)).sort(), ["deposit", "depositDue", "depositPayable"]);
});

test("PLANTED: the disclosure scan catches each way a response could give the extra hundred away", () => {
  const base = { total: 6200, deposit: 1800, depositDue: 1800, depositPayable: true };
  assert.deepEqual(disclosureProblems(base, [1630, 1700, 100]), [], "the clean response passes");
  const mutants = {
    "a second deposit field": { ...base, depositBase: 1700 },
    "a field named for the extra": { ...base, extraDeposit: 100 },
    "a field named for transport": { ...base, transport: 100 },
    "the materials figure": { ...base, notes: [1630] },
    "the rounded figure": { ...base, rounded: 1700 },
    "the extra itself": { ...base, add: 100 },
    "wording in a string": { ...base, note: "Includes $100 for scheduling and transport" },
    "wording about the rounding": { ...base, note: "Rounded up to the next hundred" },
  };
  for (const [name, m] of Object.entries(mutants)) {
    assert.ok(disclosureProblems(m, [1630, 1700, 100]).length > 0, `not caught: ${name}`);
  }
});

// The page's own words. The L table is plain strings, so it is read as data
// rather than searched as text: every value in all three languages.
// A47_PAGE: the same hook for the page, to show the wording scan can fail.
const pageHtml = process.env.A47_PAGE ? readFileSync(process.env.A47_PAGE, "utf8") : read("website/quote.html");
const pageScriptStart = pageHtml.indexOf("const L = {");
const pageScriptEnd = pageHtml.indexOf("\n};", pageScriptStart);
assert.ok(pageScriptStart > 0 && pageScriptEnd > pageScriptStart, "could not find the page's translation table");
const L = new Function(`return (${pageHtml.slice(pageScriptStart + "const L = ".length, pageScriptEnd + 2)})`)();

test("the page's words, in English, Spanish and French, never explain the extra hundred", () => {
  assert.deepEqual(Object.keys(L).sort(), ["en", "es", "fr"], "the translation table changed shape");
  let checked = 0;
  for (const [lang, table] of Object.entries(L)) {
    for (const [key, value] of Object.entries(table)) {
      if (typeof value !== "string") continue;
      checked++;
      for (const re of WORDING) assert.doesNotMatch(value, re, `${lang}.${key} says: ${value}`);
    }
  }
  assert.ok(checked > 150, `only ${checked} strings were read -- the scan lost its input`);
  // Positive control: the strings that DO name the deposit are among those read.
  assert.match(L.en.depositToBegin, /deposit/i);
  assert.match(L.es.payDeposit, /dep[oó]sito/i);
  assert.match(L.fr.payDeposit, /acompte/i);
  // PLANTED: the same scan flags a sentence that does disclose it.
  assert.ok(WORDING.some((re) => re.test("Deposit to begin (includes $100 for scheduling and transport)")));
});

test("the page prints q.deposit as the server sent it: no arithmetic on it with a constant, in the render or the pay button", () => {
  const start = pageHtml.indexOf("function render(){");
  const end = pageHtml.indexOf("function showPayButton(){");
  assert.ok(start > 0 && end > start, "could not find render() .. showPayButton()");
  const region = code(pageHtml.slice(start, end));
  // Positive control: this really is the region that draws the deposit row.
  assert.match(region, /money\(q\.deposit\)/);
  assert.match(region, /quote\.depositDue/);
  const arithmeticWithConstant = /(q\.deposit\w*|quote\.deposit\w*|depositDue)\s*[-+*/]\s*\d/;
  assert.doesNotMatch(region, arithmeticWithConstant);
  // PLANTED: the check does bite on the shape it is looking for.
  assert.match("rows.push(money(q.deposit + 100))", arithmeticWithConstant);
  assert.match("const due = depositDue - 100;", arithmeticWithConstant);
});

// ====================================== 3. Kotlin and TypeScript, same shape ==

/** The body of the Kotlin function [name], comments gone, whitespace gone. */
const kotlinBody = (src, name, until) => {
  const from = src.indexOf(`fun ${name}(`);
  assert.ok(from > 0, `Kotlin has no fun ${name}`);
  const to = src.indexOf(until, from);
  assert.ok(to > from, `could not find the end of fun ${name}`);
  return code(src.slice(from, to)).replace(/\s+/g, "");
};
const tsBody = (src, name) => {
  const from = src.indexOf(`export function ${name}(`);
  assert.ok(from > 0, `TypeScript has no function ${name}`);
  const to = src.indexOf("\n}\n", from);
  assert.ok(to > from, `could not find the end of function ${name}`);
  return code(src.slice(from, to + 2)).replace(/\s+/g, "");
};
const kt = read("app/src/main/java/com/fenceestimator/app/estimate/JobMoney.kt");
const ts = read("supabase/functions/_shared/quote-deposit.ts");

// What each language must say, in each language's own words. Both lists are
// the same five facts; the vectors prove the numbers, this proves the shape
// cannot be quietly edited on one side (a different cap, the cents dropped,
// the payments forgotten) without the other.
const SHAPE = [
  ["net of what has been paid before the rule is applied", /ruleDeposit\(materialCost-netPaid\(job\)\)/, /ruleDeposit\(materialCost-netPaid\)/],
  ["the owed figure is taken to cents", /roundToCents\(stillOwed\(job,billableTotal\)\)/, /roundToCents\(Math\.max\(0,total-netPaid\)\)/],
  ["nothing owed means nothing to suggest", /owed<=0\.005/, /owed<=0\.005/],
  ["the cap: the rule is kept only while it fits what is still owed, with a half-cent of slack", /rule<=owed\+0\.005/, /rule<=owed\+0\.005/],
  ["no materials or no price means nothing to suggest", /materialCost<=0\.0\|\|billableTotal<=0\.0/, /materialCost<=0\|\|total<=0/],
];

test("Kotlin depositSuggestion and TypeScript suggestedDeposit have the same shape", () => {
  const k = kotlinBody(kt, "depositSuggestion", "/** [depositSuggestion]'s amount");
  const t = tsBody(ts, "suggestedDeposit");
  for (const [what, kRe, tRe] of SHAPE) {
    assert.match(k, kRe, `Kotlin: ${what}`);
    assert.match(t, tRe, `TypeScript: ${what}`);
  }
});

test("PLANTED: each shape check fails on a body with that fact changed", () => {
  const k = kotlinBody(kt, "depositSuggestion", "/** [depositSuggestion]'s amount");
  const t = tsBody(ts, "suggestedDeposit");
  const breakIt = (s, from, to) => { assert.ok(s.includes(from), `fixture lost ${from}`); return s.replace(from, to); };
  const kMutants = [
    breakIt(k, "ruleDeposit(materialCost-netPaid(job))", "ruleDeposit(materialCost)"),
    breakIt(k, "rule<=owed+0.005", "rule<owed"),
    breakIt(k, "EstimateEngine.roundToCents(stillOwed(job,billableTotal))", "stillOwed(job,billableTotal)"),
  ];
  const tMutants = [
    breakIt(t, "ruleDeposit(materialCost-netPaid)", "ruleDeposit(materialCost)"),
    breakIt(t, "rule<=owed+0.005", "rule<owed"),
    breakIt(t, "roundToCents(Math.max(0,total-netPaid))", "Math.max(0,total-netPaid)"),
  ];
  const caught = (body, which) => SHAPE.some(([, kRe, tRe]) => !(which === "k" ? kRe : tRe).test(body));
  for (const m of kMutants) assert.ok(caught(m, "k"), "a Kotlin mutant was not caught");
  for (const m of tMutants) assert.ok(caught(m, "t"), "a TypeScript mutant was not caught");
});

test("both languages hold the same two constants, and the engine versions are equal (no formula changed, so nothing to regenerate)", () => {
  assert.equal(Number(/private const val DEPOSIT_ROUND_UP_TO = (\d+)L/.exec(kt)?.[1]), quoteDeposit.DEPOSIT_ROUND_UP_TO);
  assert.equal(Number(/private const val DEPOSIT_PLUS = (\d+)L/.exec(kt)?.[1]), quoteDeposit.DEPOSIT_PLUS);
  const ktVersion = /const val PRICING_ENGINE_VERSION = "([^"]+)"/.exec(read("app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt"))?.[1];
  const tsVersion = /export const PRICING_ENGINE_VERSION = "([^"]+)"/.exec(read("supabase/functions/_shared/pricing/index.ts"))?.[1];
  assert.ok(ktVersion && tsVersion, "could not read an engine version");
  assert.equal(ktVersion, tsVersion);
});

// ============================== 4. the proposed database fix cannot touch a row ==

const SQL = "supabase_a47_deposit_stops_following_price.sql";

/** The statements of a SQL file with comments and string literals removed. */
const statements = (sql) => sql.replace(/--[^\n]*/g, "").replace(/'[^']*'/g, "''").split(";").map((s) => s.trim()).filter(Boolean);
const DATA_VERBS = /\b(delete|truncate|insert|update|alter|create|grant|revoke|copy|drop\s+(table|function|column|policy|schema))\b/i;

test("the proposed fix removes one trigger and nothing else: no statement can change a row or a function", () => {
  assert.ok(existsSync(new URL(`../${SQL}`, import.meta.url)), `${SQL} is missing`);
  const all = statements(read(SQL));
  assert.ok(all.length >= 2, "the file lost its statements");
  const [first, ...rest] = all;
  assert.match(first, /^drop trigger if exists zz_deposit_follows_price on public\.jobs$/i);
  for (const s of rest) {
    assert.match(s, /^select\b/i, `not a read: ${s.slice(0, 80)}`);
    assert.doesNotMatch(s, DATA_VERBS, `a proof that could write: ${s.slice(0, 80)}`);
  }
  // The function stays, so putting the trigger back is one statement.
  assert.ok(!all.some((s) => /drop\s+function/i.test(s)));
  // PLANTED: the same scan flags a file that deletes or rewrites.
  for (const bad of ["delete from public.jobs", "update public.jobs set deposit_amount = 0", "drop function public.deposit_follows_price()", "truncate public.jobs"]) {
    assert.match(bad, DATA_VERBS);
  }
});
