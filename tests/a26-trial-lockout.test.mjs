// A26 -- a trial that runs out locked the company out, and nothing in the
// system moved it on.
//
// What is pinned here, and how it was learned (2026-09-30, live database,
// read-only except rolled-back probes):
//
//   * company_allowed() refuses a company that still reads 'trialing' once its
//     trial date has passed. That gate is shared by my_service_status (phone
//     and web) and the 21 restrictive policies on the data tables.
//   * Nothing in the database moves a company off 'trialing' when the date
//     passes (no scheduler; the only writers are stripe-webhook and three admin
//     functions). The move depends on Stripe's customer.subscription.updated or
//     invoice.payment_succeeded reaching stripe-webhook. The STATIC half runs
//     the REAL webhook source against realistic trial-end events and shows the
//     handler does move a company when those events arrive. The LIVE half
//     shows that, for the two trials that have ended with a subscription
//     behind them (Legacy, Marc), no write followed the trial end. Why the
//     events did not land is NOT provable from here -- see the last test.
//   * supabase_r17_trial_lockout.sql gives a subscriber whose trial has run out
//     72 hours of grace, says the true thing afterwards, and holds the data
//     decisions behind an arming switch. It was written but NOT applied; the
//     LIVE half runs it inside transactions it rolls back.
//
// Nothing here writes to the database for keeps. No service_role key is named
// or read. The real third-party companies (Legacy, Horizon fence llc,
// PeterLLC) are only SELECTed, or changed inside a transaction that is rolled
// back and then checked. No email address, phone number or street address is
// selected, printed or asserted on. Marc (an internal test company on the
// product's own domain) is the one login used for the authenticated-role
// probe, for the same reason: it is not a third party.
//
//   node --test tests/a26-trial-lockout.test.mjs                   STATIC (no network)
//   A26_TRIAL_LIVE=1 node --test tests/a26-trial-lockout.test.mjs  + LIVE (~2 min)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as recordPayment from "../supabase/functions/_shared/record-payment.ts";
import * as pushRecipients from "../supabase/functions/_shared/push-recipients.ts";

const PROJECT = "newcrgafcptspmapacrx";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIVE = process.env.A26_TRIAL_LIVE === "1";
const SKIP_LIVE = LIVE ? false : "set A26_TRIAL_LIVE=1 to run against production (read-only + rolled-back probes)";
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const R17 = read("supabase_r17_trial_lockout.sql");

// ============================================================ webhook harness ==
// Same recipe as tests/a7-stripe-async-payment-status.test.mjs: the REAL
// function file, with Deno.serve's callback handed back as a request handler,
// so this is a signed HTTP POST through the real signature check.
const SECRET = "whsec_test_placeholder";
const CO = "c0000000-0000-4000-8000-0000000000a6";
const baseEnv = {
  STRIPE_WEBHOOK_SECRET: SECRET,
  SUPABASE_URL: "https://project.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
};

function loadWebhook({ env = baseEnv, db, mutate = (s) => s }) {
  let js = mutate(stripTypeScriptTypes(readFileSync(join(ROOT, "supabase/functions/stripe-webhook/index.ts"), "utf8")));
  const importRe = /^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";?[ \t]*$/gm;
  const shared = {};
  for (const [, list, from] of js.matchAll(importRe)) {
    const names = list.split(",").map((n) => n.trim()).filter(Boolean);
    if (/supabase-js/.test(from)) assert.deepEqual(names, ["createClient"]);
    else if (from === "../_shared/record-payment.ts") for (const n of names) shared[n] = recordPayment[n];
    else if (from === "../_shared/push-recipients.ts") for (const n of names) shared[n] = pushRecipients[n];
    else assert.fail(`an import the harness does not supply: ${from}`);
  }
  js = js.replace(importRe, "").replace(/^export /gm, "");
  let handler = null;
  const Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
  const sharedNames = Object.keys(shared);
  new Function("Deno", "createClient", "fetch", ...sharedNames, js)(
    Deno, () => db, async (u) => { throw new Error("unexpected fetch: " + u); }, ...sharedNames.map((n) => shared[n]),
  );
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

/** An in-memory stand-in for the service-role client. `failUpdates` makes writes
 * to those tables come back { error } the way supabase-js does -- it never throws. */
function fakeDb(tables, { failUpdates = [] } = {}) {
  const t = structuredClone(tables);
  const rpcCalls = [];
  class Query {
    constructor(table) { this.table = table; this.op = "select"; this.filters = []; }
    select() { return this; }
    eq(k, v) { this.filters.push((r) => String(r[k]) === String(v)); return this; }
    is(k, v) { this.filters.push((r) => (v === null ? (r[k] === null || r[k] === undefined) : r[k] === v)); return this; }
    order() { return this; }
    limit() { return this; }
    insert(row) { this.op = "insert"; this.payload = row; return this; }
    update(patch) { this.op = "update"; this.payload = patch; return this; }
    upsert(row) { this.op = "insert"; this.payload = row; return this; }
    maybeSingle() { this.mode = "maybe"; return this.run(); }
    single() { this.mode = "one"; return this.run(); }
    then(ok, bad) { return this.run().then(ok, bad); }
    async run() {
      const rows = (t[this.table] ??= []);
      if (this.op === "insert") { rows.push({ ...this.payload }); return { data: null, error: null }; }
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") {
        if (failUpdates.includes(this.table)) return { data: null, error: { message: "simulated: a trigger raised" } };
        hit.forEach((r) => Object.assign(r, this.payload));
        return { data: null, error: null };
      }
      if (this.mode === "maybe") return { data: hit[0] ?? null, error: null };
      if (this.mode === "one") return hit[0] ? { data: hit[0], error: null } : { data: null, error: { message: "no row" } };
      return { data: hit, error: null };
    }
  }
  return { tables: t, rpcCalls, from: (n) => new Query(n), rpc: async (name, args) => { rpcCalls.push([name, args]); return { data: true, error: null }; } };
}

const mkEvent = (type, obj) => ({ id: "evt_" + Math.random().toString(36).slice(2), type, livemode: false, data: { object: obj } });
async function post(handler, body) {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex");
  const res = await handler(new Request("https://fn.test/stripe-webhook", {
    method: "POST", headers: { "stripe-signature": `t=${ts},v1=${mac}` }, body: raw,
  }));
  return { status: res.status, text: await res.text() };
}

const DAY = 86400;
const nowS = () => Math.floor(Date.now() / 1000);
/** A company as Legacy is today: trialing, holds a subscription, trial date passed,
 * carrying only what the trial-START event wrote. */
const lapsedRow = () => ({
  id: CO, name: "probe", stripe_subscription_id: "sub_T1", subscription_status: "trialing", subscription_plan: "Solo",
  trial_ends_at: new Date((nowS() - 20 * DAY) * 1000).toISOString(),
  subscription_ends_at: new Date((nowS() - 20 * DAY) * 1000).toISOString(), monthly_price: 99, suspended: false,
});
/** What Stripe sends when a trial converts, in the API shape this account uses
 * (current_period_end lives on the items since 2025-03-31). */
const convertedSub = (over = {}) => ({
  id: "sub_T1", object: "subscription", status: "active",
  metadata: { company_id: CO, plan: "Solo" },
  trial_end: nowS() - 20 * DAY,
  items: { data: [{ id: "si_1", quantity: 1, current_period_end: nowS() + 30 * DAY,
                    price: { unit_amount: 9900, recurring: { interval: "month", interval_count: 1 } } }] },
  ...over,
});
const company = (db) => db.tables.companies.find((r) => r.id === CO);

// ================================================================= STATIC ==

test("control: the harness runs the real webhook and can tell a converted company from an unconverted one", async () => {
  const db = fakeDb({ companies: [lapsedRow()] });
  const h = loadWebhook({ db });
  // A subscription event that is STILL trialing must leave the company trialing.
  const ev = convertedSub({ status: "trialing", trial_end: nowS() + 3 * DAY });
  const r = await post(h, mkEvent("customer.subscription.updated", ev));
  assert.equal(r.status, 200, r.text);
  assert.equal(company(db).subscription_status, "trialing", "a still-trialing event must not flip the company");
  // ...and the handler DID run and write: the trial date moved to the event's. That is what makes the line above mean something.
  assert.equal(company(db).trial_ends_at, new Date(ev.trial_end * 1000).toISOString(), "control: the handler wrote the event's trial end");
});

test("the handover works when the event arrives: customer.subscription.updated (active) moves a lapsed trial to active", async () => {
  const db = fakeDb({ companies: [lapsedRow()] });
  const h = loadWebhook({ db });
  const sub = convertedSub();
  const r = await post(h, mkEvent("customer.subscription.updated", sub));
  assert.equal(r.status, 200, r.text);
  const c = company(db);
  assert.equal(c.subscription_status, "active");
  assert.equal(c.monthly_price, 99);
  assert.equal(c.stripe_subscription_id, "sub_T1");
  assert.equal(c.subscription_ends_at, new Date(sub.items.data[0].current_period_end * 1000).toISOString(),
    "the renewal date moves on from the trial date -- the column Legacy and Marc still hold at the trial date");
  assert.ok(db.rpcCalls.some(([n, a]) => n === "release_for_payment" && a.cid === CO), "and a suspension for non-payment is released");
});

test("the handover works when the event arrives: invoice.payment_succeeded (current API shape) moves a lapsed trial to active", async () => {
  const db = fakeDb({ companies: [lapsedRow()] });
  const h = loadWebhook({ db });
  const r = await post(h, mkEvent("invoice.payment_succeeded", {
    id: "in_1", amount_paid: 9900, parent: { type: "subscription_details", subscription_details: { subscription: "sub_T1" } },
  }));
  assert.equal(r.status, 200, r.text);
  assert.equal(company(db).subscription_status, "active");
});

test("the other outcome is handled too: invoice.payment_failed at conversion leaves a bounded 7-day grace, not a wall", async () => {
  const db = fakeDb({ companies: [lapsedRow()] });
  const h = loadWebhook({ db });
  const r = await post(h, mkEvent("invoice.payment_failed", {
    id: "in_2", parent: { type: "subscription_details", subscription_details: { subscription: "sub_T1" } },
  }));
  assert.equal(r.status, 200, r.text);
  const c = company(db);
  assert.equal(c.subscription_status, "past_due");
  const days = (new Date(c.grace_ends_at).getTime() - Date.now()) / 86400000;
  assert.ok(days > 6.9 && days < 7.1, `grace should be about 7 days, got ${days}`);
});

test("an event that does not belong to this company's subscription changes nothing", async () => {
  const db = fakeDb({ companies: [lapsedRow()] });
  const h = loadWebhook({ db });
  await post(h, mkEvent("customer.subscription.updated", convertedSub({ id: "sub_SOMEONE_ELSE" })));
  await post(h, mkEvent("customer.subscription.updated", convertedSub({ metadata: {} })));
  await post(h, mkEvent("invoice.payment_succeeded", {
    id: "in_3", parent: { type: "subscription_details", subscription_details: { subscription: "sub_SOMEONE_ELSE" } } }));
  assert.equal(company(db).subscription_status, "trialing");
});

test("TEETH: the two conversion tests above fail against a handler that stops writing the status", async () => {
  // Same events, same starting row, a webhook with the status write removed. If these still
  // came out 'active' the tests above would be proving nothing.
  const sub = new Map([
    ["customer.subscription.updated", ['subscription_status: status,', 'subscription_status: "trialing",']],
    ["invoice.payment_succeeded", ['.update({ subscription_status: "active" }).eq("id", co.id);', '.update({}).eq("id", co.id);']],
  ]);
  for (const [type, [from, to]] of sub) {
    const db = fakeDb({ companies: [lapsedRow()] });
    const h = loadWebhook({ db, mutate: (s) => { assert.ok(s.includes(from), `the source no longer contains the line this mutation removes: ${from}`); return s.replace(from, to); } });
    const body = type === "invoice.payment_succeeded"
      ? mkEvent(type, { id: "in_9", parent: { type: "subscription_details", subscription_details: { subscription: "sub_T1" } } })
      : mkEvent(type, convertedSub());
    const r = await post(h, body);
    assert.equal(r.status, 200, r.text);
    assert.equal(company(db).subscription_status, "trialing", `${type}: the broken handler leaves the company on trialing`);
  }
});

test("GAP (pinned, webhook not touched by r17): a failed company write is answered 200, so Stripe never retries and the loss is silent", async () => {
  // supabase-js returns { error } rather than throwing, and the subscription and
  // invoice handlers never read it. Stripe retries a 5xx for days and a 2xx never,
  // so ANY failure to write the conversion -- a trigger that raises, a lock, a
  // constraint -- leaves the company on 'trialing' with nothing anywhere saying so.
  // When the handler starts checking the write, this becomes a 500 and should flip.
  const db = fakeDb({ companies: [lapsedRow()] }, { failUpdates: ["companies"] });
  const h = loadWebhook({ db });
  const r = await post(h, mkEvent("customer.subscription.updated", convertedSub()));
  assert.equal(r.status, 200, "GAP: answered 200 although the write failed");
  assert.equal(company(db).subscription_status, "trialing", "and the company is still on trialing");
  const r2 = await post(h, mkEvent("invoice.payment_succeeded", {
    id: "in_4", parent: { type: "subscription_details", subscription_details: { subscription: "sub_T1" } } }));
  assert.equal(r2.status, 200, "GAP: the invoice handler does the same");
});

test("GAP (pinned, webhook not touched by r17): invoice.payment_succeeded marks a company active whatever was paid, including a 0-dollar trial-start invoice", async () => {
  // Whether Stripe sends invoice.payment_succeeded for the 0-dollar invoice that opens a
  // trial is NOT verified here (no Stripe access). If it does, a company would read
  // 'active' from day one -- counted as paying in the admin page -- until a later
  // subscription event put 'trialing' back. The code does not look at the amount.
  const db = fakeDb({ companies: [{ ...lapsedRow(), trial_ends_at: new Date((nowS() + 14 * DAY) * 1000).toISOString() }] });
  const h = loadWebhook({ db });
  await post(h, mkEvent("invoice.payment_succeeded", {
    id: "in_0", amount_paid: 0, parent: { type: "subscription_details", subscription_details: { subscription: "sub_T1" } } }));
  assert.equal(company(db).subscription_status, "active", "GAP: a 0-dollar invoice activates a company that has paid nothing");
});

test("the events a Stripe endpoint must be SENT for a trial to convert are events this handler actually handles", () => {
  // The checklist for the Stripe dashboard (Developers > Webhooks > the endpoint > events),
  // kept as data so it cannot drift from the code. If the endpoint lists fewer than these,
  // the handover cannot happen no matter how correct the handler is.
  const src = read("supabase/functions/stripe-webhook/index.ts");
  const handled = new Set([...src.matchAll(/^\s*case "([a-z_.]+)":/gm)].map((m) => m[1]));
  const NEEDED = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated",
                  "customer.subscription.deleted", "invoice.payment_succeeded", "invoice.payment_failed"];
  for (const e of NEEDED) assert.ok(handled.has(e), `the webhook no longer handles ${e}`);
  assert.ok(handled.size >= NEEDED.length, "control: the extraction found the handled events at all");
});

// ------------------------------------------------- the r17 file, statically --
// Each check is a function of the text it is given, so the TEETH test below can hand it a
// deliberately broken copy and require it to complain.

const nonComment = (sql) => sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

function checkInert(sql) {
  const code = nonComment(sql);
  const dataStart = code.indexOf("do $r17_data$");
  const guard = code.indexOf("if armed <> 'yes-i-have-decided' then");
  const firstUpdate = code.indexOf("update public.companies");
  assert.ok(dataStart > 0 && guard > dataStart, "the arming guard is inside the data block");
  assert.ok(firstUpdate > guard, "the first company UPDATE comes after the guard's early return");
  assert.match(code.slice(guard, firstUpdate), /return;/, "and the guard returns before it");
  // Outside the data block, no statement may change data.
  const outside = code.slice(0, dataStart) + code.slice(code.indexOf("$r17_data$;") + "$r17_data$;".length);
  for (const bad of [/\bupdate\s+public\.companies\b/i, /\bdelete\s+from\b/i, /\btruncate\b/i, /\bdrop\s+(table|function|policy|trigger|schema)\b/i,
                     /\binsert\s+into\b/i, /service_role/i]) {
    assert.doesNotMatch(outside, bad, `outside the armed block the file must not contain ${bad}`);
  }
  assert.doesNotMatch(code, /\bdelete\s+from\b|\btruncate\b|\bdrop\s+table\b/i, "no destructive statement anywhere");
}

function checkDecisions(sql) {
  const block = sql.slice(sql.indexOf("do $r17_data$"));
  const updates = [...block.matchAll(/update public\.companies c[\s\S]*?get diagnostics n = row_count;\s*if n <> 1 then/g)];
  assert.equal(updates.length, 2, "two decisions: Legacy and Horizon");
  for (const u of updates) {
    assert.match(u[0], /where c\.id = '[0-9a-f-]{36}'\s+and c\.name = '/);
    assert.match(u[0], /and c\.subscription_status = '/);
  }
  assert.match(block, /Legacy[\s\S]*ccb9b8cd-0925-45cd-a04d-c2c106c370bd/);
  assert.match(block, /Horizon fence llc[\s\S]*20f62301-6737-4385-ad95-3610a115b4b7/);
  // The decision that keeps Legacy 'trialing': no path in the data block writes 'active'.
  assert.doesNotMatch(block.replace(/^\s*--.*$/gm, ""), /subscription_status\s*=\s*'active'/, "the data block never says anybody paid");
}

function checkGateShape(sql) {
  assert.equal((sql.match(/interval '72 hours'/g) ?? []).length, 1, "one definition of the window");
  assert.match(sql, /revoke all on function public\.trial_conversion_grace_ends\(uuid\) from public, anon, authenticated;/);
  const anchors = [...sql.matchAll(/anchor := \$re\$([\s\S]*?)\$re\$;/g)].map((m) => m[1]);
  assert.equal(anchors.length, 4);
  const literalWhitespace = anchors.filter((a) => /\s/.test(a.replace(/\\s\+/g, "").replace(/ /g, "")));
  assert.deepEqual(literalWhitespace, [], "no anchor depends on a literal newline or tab (the live bodies may carry CRLF)");
  assert.ok(anchors.some((a) => a.includes("\\s+")), "and the multi-token ones use \\s+");
}

test("r17 SQL: the data decisions are inert unless armed, and nothing else in the file writes a company", () => checkInert(R17));
test("r17 SQL: every company update names the id AND the name AND the state it was decided in, and must hit exactly one row", () => checkDecisions(R17));
test("r17 SQL: the grace window is defined once, the helper is closed to signed-in users, and the patch anchors tolerate CRLF", () => checkGateShape(R17));

test("TEETH: each r17 file check fails against a copy that has the fault it exists to catch", () => {
  const guard = "if armed <> 'yes-i-have-decided' then";
  assert.ok(R17.includes(guard));
  // 1. the guard removed -> the data block would act unarmed
  assert.throws(() => checkInert(R17.replace(guard, "if false then")), "an unguarded data block must be caught");
  // 2. a stray update outside the block
  assert.throws(() => checkInert(R17.replace("-- PART 1a", "update public.companies set suspended = false;\n-- PART 1a")), "a company update outside the block must be caught");
  // 3. a destructive statement anywhere
  assert.throws(() => checkInert(R17 + "\ndelete from public.companies where false;\n"), "delete must be caught");
  // 4. a decision that marks a company paid
  assert.throws(() => checkDecisions(R17.replace("set trial_ends_at = now() + make_interval(days => grant_days),",
                                                  "set subscription_status = 'active', trial_ends_at = now() + make_interval(days => grant_days),")),
                "a decision that says 'active' must be caught");
  // 5. a decision that names no state
  assert.throws(() => checkDecisions(R17.replace("and c.subscription_status = 'trialing'\n       and c.stripe_subscription_id is not null\n       and c.trial_ends_at <= now()", "")),
                "a decision with no state guard must be caught");
  // 6. the window defined twice, and the helper left open to signed-in users
  assert.throws(() => checkGateShape(R17 + "\n-- interval '72 hours'\n"), "a second definition of the window must be caught");
  assert.throws(() => checkGateShape(R17.replace("from public, anon, authenticated;", "from public;")), "an oracle left open to signed-in users must be caught");
  // 7. an anchor that depends on a literal newline
  assert.throws(() => checkGateShape(R17.replace("(or \\(c\\.subscription_status = 'trialing'\\s+and", "(or \\(c\\.subscription_status = 'trialing'\n and")),
                "a newline-dependent anchor must be caught");
});

// ----------------------------------------------- the phone's side, statically --

function stripComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"); }
function fnBody(src, header) {
  const at = src.indexOf(header);
  assert.ok(at >= 0, `cannot find ${header}`);
  let i = src.indexOf("{", at), depth = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === "{") depth++; else if (src[j] === "}" && --depth === 0) break; }
  return src.slice(i, j + 1);
}

function checkGateContract(raw) {
  const src = stripComments(raw);
  // The judgement about trials lives in the database. The client has no rule of its own.
  assert.doesNotMatch(src, /trialing|trial_ends|isBefore|isAfter/, "no client-side trial rule");
  // refresh(): a failed or empty answer is null ("could not ask"), never a blocked status.
  const refresh = fnBody(src, "suspend fun refresh(");
  assert.match(refresh, /\.getOrNull\(\) \?: return@withContext null/, "a failed RPC is 'unknown'");
  assert.doesNotMatch(refresh, /ServiceStatus\(\s*allowed\s*=\s*false/, "refresh never invents a block");
  // remembered(): never having been told is open; a stored answer keeps its own allowed flag.
  const remembered = fnBody(src, "suspend fun remembered(");
  assert.match(remembered, /val checkedAt = prefs\[CHECKED_AT\] \?: return null/, "never asked -> no verdict");
  assert.match(remembered, /val allowed = prefs\[ALLOWED\] \?: true/, "an unreadable stored flag is open");
  // The status type defaults open, so a field the server omits cannot read as 'blocked'.
  assert.match(src, /data class ServiceStatus\(\s*val allowed: Boolean = true/);
}

const GATE_KT = read("app/src/main/java/com/fenceestimator/app/cloud/ServiceGate.kt");

test("the phone does not decide trial expiry itself, blocks only on a definite server answer, and opens when it cannot tell", () => checkGateContract(GATE_KT));

test("TEETH: the phone-side contract check fails against a gate that fails closed or judges trials itself", () => {
  const ok = "?: return@withContext null";
  assert.ok(GATE_KT.includes(ok));
  assert.throws(() => checkGateContract(GATE_KT.replace(ok, "?: return@withContext ServiceStatus(allowed = false)")), "a refresh that invents a block must be caught");
  assert.throws(() => checkGateContract(GATE_KT.replace("val allowed = prefs[ALLOWED] ?: true", "val allowed = prefs[ALLOWED] ?: false")), "an unreadable stored flag read as blocked must be caught");
  assert.throws(() => checkGateContract(GATE_KT.replace("val checkedAt = prefs[CHECKED_AT] ?: return null", "val checkedAt = prefs[CHECKED_AT] ?: 0L")), "a phone that has never asked must not hold a verdict");
  assert.throws(() => checkGateContract(GATE_KT.replace("suspend fun refresh(", 'suspend fun refresh_x(context: Context, trialing: Boolean = "trialing" == "x") = Unit\n    suspend fun refresh(')),
                "a client-side trial rule must be caught");
});

// ================================================================== LIVE ==

function runSql(sql, label) {
  const dir = mkdtempSync(join(tmpdir(), "a26-trial-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  let last = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query", "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
      { encoding: "utf8", shell: process.platform === "win32", timeout: 240_000 });
    const out = r.stdout || "";
    if (r.status === 0 && out.trim()) {
      const parsed = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
      return Array.isArray(parsed) ? parsed : (parsed.rows || []);
    }
    last = `status ${r.status}: ${(r.stderr || out).slice(0, 500)}`;
    // The CLI's login is flaky. A real SQL error is not: thrown at once. A failed call is NEVER an empty answer.
    if (!/28P01|failed to connect|timeout|EOF|reset|ECONN|ETIMEDOUT/i.test(last)) break;
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},3000)"]);
  }
  throw new Error(`${label}: supabase db query failed -- ${last}`);
}

/** The whole r17 file, run inside a transaction that is rolled back, with a before/after comparison of every company. */
function dryRun({ armed }) {
  const snap = (t) => `create temp table ${t} as select c.id, c.name, c.subscription_status, c.subscription_plan, c.trial_ends_at, c.grace_ends_at,
      c.subscription_ends_at, c.suspended, c.suspended_reason, c.monthly_price, c.stripe_subscription_id, c.admin_notes, public.company_allowed(c.id) as allowed
      from public.companies c;`;
  return runSql(`begin;
${snap("r17_before")}
${armed ? "select set_config('fenceflow.r17_apply_decisions', 'yes-i-have-decided', true);" : ""}
${R17}
${snap("r17_after")}
create temp table r17_out as
select b.name, b.subscription_status as status_before, a.subscription_status as status_after,
       round((extract(epoch from (a.trial_ends_at - now())) / 86400.0)::numeric, 1) as trial_after_days_from_now,
       (b.trial_ends_at is distinct from a.trial_ends_at) as trial_changed,
       b.allowed as allowed_before, a.allowed as allowed_after,
       (b.admin_notes is distinct from a.admin_notes) as notes_changed,
       a.admin_notes as notes_after,
       (to_jsonb(b) - 'admin_notes' - 'allowed' - 'trial_ends_at' - 'subscription_status')
         is distinct from (to_jsonb(a) - 'admin_notes' - 'allowed' - 'trial_ends_at' - 'subscription_status') as other_columns_changed
  from r17_before b join r17_after a using (id);
select * from r17_out order by name;
rollback;`, armed ? "dry run (armed)" : "dry run (unarmed)");
}

const FINGERPRINT_SQL = `select
  (select md5(coalesce(string_agg(to_jsonb(c)::text, '|' order by c.id), '')) from public.companies c) as companies,
  (select md5(pg_get_functiondef('public.company_allowed(uuid)'::regprocedure)) from (select 1) x) as gate,
  (select md5(pg_get_functiondef('public.my_service_status()'::regprocedure)) from (select 1) x) as status_fn,
  (to_regprocedure('public.trial_conversion_grace_ends(uuid)') is not null) as helper_exists,
  (select count(*)::int from public.companies) as n;`;
let fingerprintBefore = null;

test("LIVE control: the reader sees the companies, the gate function and the trial columns", { skip: SKIP_LIVE }, () => {
  const [f] = runSql(FINGERPRINT_SQL, "fingerprint");
  fingerprintBefore = f;
  assert.ok(f.n >= 6, `expected at least the six real companies, saw ${f.n}`);
  assert.match(f.gate, /^[0-9a-f]{32}$/);
});

test("LIVE REPORT: the six real companies and why each is or is not allowed in (printed, not asserted; no email or address)", { skip: SKIP_LIVE }, (t) => {
  const rows = runSql(`select c.name, c.subscription_status as status, c.subscription_plan as plan,
      c.trial_ends_at::date as trial_end, (c.stripe_subscription_id is not null) as holds_sub,
      public.company_allowed(c.id) as allowed, c.suspended,
      (select count(*)::int from public.profiles p where p.company_id = c.id) as people,
      (select count(*)::int from public.jobs j where j.company_id = c.id) as jobs
    from public.companies c where c.name !~ '^ZZ' order by c.created_at;`, "report");
  for (const r of rows) t.diagnostic(`${r.name}: ${r.status}/${r.plan || "-"} trial_end ${r.trial_end ?? "-"} sub ${r.holds_sub} allowed ${r.allowed} people ${r.people} jobs ${r.jobs}`);
  const stuck = rows.filter((r) => r.status === "trialing" && r.holds_sub && r.trial_end && new Date(r.trial_end) < new Date());
  t.diagnostic("trialing + subscription + trial date passed: " + (stuck.map((r) => r.name).join("; ") || "none"));
  assert.ok(rows.some((r) => r.name === "Fence solutions" && r.allowed === true), "control: the owner's own company is allowed");
});

test("LIVE: no company row carries a write that followed its trial end (Legacy, Marc) -- the handover event never landed", { skip: SKIP_LIVE }, (t) => {
  // At trial START the webhook writes trial_end, the renewal date (= the trial end while trialing), the
  // price, and the plan. After a conversion it would write a LATER renewal date and a status. A company
  // still holding renewal date == trial date, with the status unchanged, has had no such write.
  const rows = runSql(`select c.name, c.subscription_status as status, (c.subscription_ends_at = c.trial_ends_at) as renewal_is_trial_date,
      (c.trial_ends_at < now()) as trial_over, (c.stripe_subscription_id is not null) as holds_sub
    from public.companies c where c.name in ('Legacy', 'Marc', 'PeterLLC') order by c.name;`, "no write after trial end");
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by.PeterLLC?.trial_over, false, "control: PeterLLC's trial has not ended yet, so it is not expected to have converted");
  for (const n of ["Legacy", "Marc"]) {
    if (!by[n]) { t.diagnostic(`${n}: not found`); continue; }
    if (by[n].status !== "trialing") { t.diagnostic(`${n} is now '${by[n].status}' -- the state this test describes has moved on`); continue; }
    if (!by[n].trial_over) { t.diagnostic(`${n}: its trial date is in the future again (a decision was applied) -- nothing to check`); continue; }
    assert.equal(by[n].holds_sub, true, n);
    assert.equal(by[n].renewal_is_trial_date, true, `${n}: nothing was written after the trial ended`);
  }
});

test("LIVE: the payment ledger says Stripe is in test mode, and Legacy's deposit is a typed number, not money received", { skip: SKIP_LIVE }, () => {
  // (Observed by hand on 2026-09-30, not asserted: `supabase secrets list` shows STRIPE_SECRET_KEY last set
  // 2026-08-15 and STRIPE_WEBHOOK_SECRET 2026-08-16, before every signup here, so the checkout that made
  // Legacy's subscription used the same key that made these ledger rows. livemode is Stripe's own field.)
  const [m] = runSql(`select count(*)::int as n, count(*) filter (where livemode is true)::int as live_rows from public.job_payments;`, "livemode");
  assert.ok(m.n >= 10, `control: the ledger has rows (${m.n})`);
  assert.equal(m.live_rows, 0, "every Stripe object is test-mode: no ledger row is livemode");
  const [l] = runSql(`select j.status, j.payment_status, j.deposit_amount, j.amount_paid, coalesce(j.payments_from_processor, false) as via_processor,
      (select count(*)::int from public.job_payments p where p.company_id = j.company_id) as link_rows,
      (select count(*)::int from public.payment_records p where p.company_id = j.company_id) as record_rows
    from public.jobs j join public.companies c on c.id = j.company_id where c.name = 'Legacy';`, "legacy deposit");
  if (!l) return; // the company was removed; nothing to say
  assert.equal(Number(l.amount_paid), 0, "no money reached the job");
  assert.equal(l.via_processor, false);
  assert.equal(l.link_rows + l.record_rows, 0, "no payment link and no ledger row: the deposit was typed, not received");
});

test("LIVE DRY RUN (unarmed): the whole r17 file runs, PART 2 does nothing, and no company row changes", { skip: SKIP_LIVE }, () => {
  const rows = dryRun({ armed: false });
  assert.ok(rows.length >= 6, "control: the comparison covers every company");
  const moved = rows.filter((r) => r.status_before !== r.status_after || r.trial_changed || r.notes_changed || r.other_columns_changed);
  assert.deepEqual(moved.map((r) => r.name), [], "an unarmed run must change no company");
});

test("LIVE DRY RUN (armed): exactly Legacy and Horizon change, Legacy stays 'trialing', and the other four are untouched", { skip: SKIP_LIVE }, (t) => {
  const [pre] = runSql(`select
      (select subscription_status = 'trialing' and trial_ends_at <= now() and stripe_subscription_id is not null from public.companies where name = 'Legacy') as legacy_lapsed,
      (select subscription_status = 'pending' and stripe_subscription_id is null from public.companies where name = 'Horizon fence llc') as horizon_pending;`, "state check");
  if (!pre.legacy_lapsed || !pre.horizon_pending) {
    t.diagnostic("Legacy or Horizon is no longer in the state the decisions were written for: the decisions have been made or overtaken");
    return;
  }
  const rows = dryRun({ armed: true });
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  const moved = rows.filter((r) => r.status_before !== r.status_after || r.trial_changed || r.notes_changed || r.other_columns_changed).map((r) => r.name).sort();
  assert.deepEqual(moved, ["Horizon fence llc", "Legacy"]);
  const L = by.Legacy, H = by["Horizon fence llc"];
  assert.equal(L.status_before, "trialing"); assert.equal(L.status_after, "trialing", "Legacy is NOT marked active: nothing was paid");
  assert.equal(L.allowed_before, false); assert.equal(L.allowed_after, true);
  assert.equal(Number(L.trial_after_days_from_now), 14);
  assert.equal(L.other_columns_changed, false, "only the trial date and the note");
  assert.match(L.notes_after, /r17 \d{4}-\d{2}-\d{2}: trial extended 14 days by SQL/);
  assert.equal(H.status_before, "pending"); assert.equal(H.status_after, "trialing");
  assert.equal(H.allowed_before, false); assert.equal(H.allowed_after, true);
  assert.equal(Number(H.trial_after_days_from_now), 14);
  for (const n of ["Marc", "Marco", "PeterLLC", "Fence solutions"]) assert.equal(by[n].allowed_before, by[n].allowed_after, `${n} untouched`);
});

test("LIVE: the gate after PART 1, every edge (synthetic companies, rolled back) -- grace for silence only, then the wall, with the true message", { skip: SKIP_LIVE }, () => {
  const cases = [
    // label, status, trial_ends_at, holds subscription, suspended, has explicit grace
    ["lapsed_1d_sub", "trialing", "now() - interval '1 day'", true, false, false],
    ["lapsed_71h_sub", "trialing", "now() - interval '71 hours'", true, false, false],
    ["lapsed_73h_sub", "trialing", "now() - interval '73 hours'", true, false, false],
    ["lapsed_1d_nosub", "trialing", "now() - interval '1 day'", false, false, false],
    ["live_trial_sub", "trialing", "now() + interval '5 days'", true, false, false],
    ["suspended_in_window", "trialing", "now() - interval '1 day'", true, true, false],
    ["canceled_in_window", "canceled", "now() - interval '1 day'", true, false, false],
    ["past_due_no_grace", "past_due", "now() - interval '1 day'", true, false, false],
    ["past_due_with_grace", "past_due", "now() - interval '30 days'", true, false, true],
    ["active_old_trial", "active", "now() - interval '30 days'", true, false, false],
    ["pending_plain", "pending", "null", false, false, false],
    ["trialing_null_end_sub", "trialing", "null", true, false, false],
  ];
  const ins = cases.map(([label, st, tr, sub, susp, grace], i) => {
    const cols = ["id", "name", "subscription_status", "trial_ends_at", "stripe_subscription_id", "suspended"];
    const vals = [`'a2600000-0000-4000-8000-0000000000${String(i + 1).padStart(2, "0")}'`, `'PROBE-A26-${label}'`, `'${st}'`, tr, sub ? `'sub_probe_${i}'` : "null", String(susp)];
    if (grace) { cols.push("grace_ends_at"); vals.push("now() + interval '2 days'"); }
    return `insert into public.companies (${cols.join(", ")}) values (${vals.join(", ")});`;
  }).join("\n");
  // my_service_status() reads auth.uid(); to ask it about a synthetic company without creating a login,
  // its LIVE (patched) body is copied to a temp function with only that one WHERE clause swapped.
  const rewrite = String.raw`do $mk$
declare d text; d0 text;
begin
  d0 := pg_get_functiondef('public.my_service_status()'::regprocedure);
  d := replace(d0, 'public.my_service_status()', 'pg_temp.mss_probe(probe_cid uuid)');
  d := regexp_replace(d, 'where c\.id = \(select company_id from profiles where id = auth\.uid\(\)\)', 'where c.id = probe_cid');
  if d = d0 or position('auth.uid' in d) > 0 then raise exception 'probe rewrite did not take'; end if;
  execute d;
end
$mk$;`;
  const sql = `begin;
${ins}
create temp table a26_before as select regexp_replace(c.name, '^PROBE-A26-', '') as label, public.company_allowed(c.id) as allowed from public.companies c where c.name like 'PROBE-A26-%';
${R17}
${rewrite}
create temp table a26_probe as
select regexp_replace(c.name, '^PROBE-A26-', '') as label, public.company_allowed(c.id) as allowed,
       (public.trial_conversion_grace_ends(c.id) is not null) as in_state,
       round((extract(epoch from (public.trial_conversion_grace_ends(c.id) - now())) / 3600.0)::numeric) as window_closes_in_h,
       s.allowed as mss_allowed, s.reason as mss_reason,
       round((extract(epoch from (s.grace_ends_at - now())) / 3600.0)::numeric) as mss_grace_in_h,
       s.can_self_serve as mss_self_serve, s.trial_days_left as mss_days_left, s.subscribed as mss_subscribed
  from public.companies c, lateral pg_temp.mss_probe(c.id) s where c.name like 'PROBE-A26-%';
select p.*, b.allowed as allowed_before_r17 from a26_probe p join a26_before b using (label) order by p.label;
rollback;`;
  const rows = runSql(sql, "gate truth table");
  const by = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.equal(rows.length, cases.length, "control: every synthetic company answered");
  const CONFIRM = /not yet had confirmation of your first payment/;
  // grace for silence: subscriber, trial over, still 'trialing'
  for (const l of ["lapsed_1d_sub", "lapsed_71h_sub"]) { assert.equal(by[l].allowed, true, l); assert.equal(by[l].mss_allowed, true, l); assert.equal(by[l].in_state, true, l); assert.match(by[l].mss_reason, CONFIRM); assert.equal(by[l].mss_self_serve, false, l); }
  assert.equal(Number(by.lapsed_1d_sub.window_closes_in_h), 48);
  assert.equal(Number(by.lapsed_1d_sub.mss_grace_in_h), 48, "the deadline is reported while the window is open");
  assert.equal(Number(by.lapsed_71h_sub.window_closes_in_h), 1);
  // then the wall, with the true message and no plan buttons that would only change the Stripe subscription
  assert.equal(by.lapsed_73h_sub.allowed, false); assert.equal(by.lapsed_73h_sub.mss_allowed, false);
  assert.match(by.lapsed_73h_sub.mss_reason, CONFIRM); assert.doesNotMatch(by.lapsed_73h_sub.mss_reason, /Pick a plan/);
  assert.equal(by.lapsed_73h_sub.mss_self_serve, false); assert.equal(by.lapsed_73h_sub.mss_grace_in_h, null, "no deadline once it has passed");
  // no grace without a subscription behind the trial: it ends when it ends, and says so as it always did
  assert.equal(by.lapsed_1d_nosub.allowed, false); assert.match(by.lapsed_1d_nosub.mss_reason, /Pick a plan below/); assert.equal(by.lapsed_1d_nosub.mss_self_serve, true);
  // suspension and cancellation are not softened
  assert.equal(by.suspended_in_window.allowed, false); assert.equal(by.suspended_in_window.mss_grace_in_h, null, "a suspension has no grace");
  assert.equal(by.suspended_in_window.mss_self_serve, true, "and keeps the self-serve answer it always had");
  assert.equal(by.canceled_in_window.allowed, false); assert.equal(by.canceled_in_window.mss_reason, "Your subscription has ended.");
  // untouched arms
  assert.equal(by.live_trial_sub.allowed, true); assert.equal(Number(by.live_trial_sub.mss_days_left), 5); assert.equal(by.live_trial_sub.in_state, false);
  assert.equal(by.past_due_no_grace.allowed, false); assert.equal(by.past_due_with_grace.allowed, true);
  assert.equal(by.active_old_trial.allowed, true); assert.equal(by.pending_plain.allowed, false);
  assert.equal(by.trialing_null_end_sub.allowed, true, "a NULL trial end still passes, as the gate always documented");
  // Positive control that the file is what changed the answer (only decidable while r17 is not live yet).
  const [{ helper_exists }] = runSql(`select (to_regprocedure('public.trial_conversion_grace_ends(uuid)') is not null) as helper_exists;`, "helper");
  if (!helper_exists) {
    assert.equal(by.lapsed_1d_sub.allowed_before_r17, false, "TEETH: before r17 the same company was refused");
    assert.equal(by.lapsed_71h_sub.allowed_before_r17, false);
  }
  // Every other case is decided identically before and after: r17 widens exactly one arm.
  for (const c of cases.map((x) => x[0]).filter((l) => !/^lapsed_(1d|71h)_sub$/.test(l))) {
    assert.equal(by[c].allowed, by[c].allowed_before_r17, `${c}: r17 must not change this answer`);
  }
});

test("LIVE: as the AUTHENTICATED role with a real login, the whole chain holds -- open inside the window, closed outside it, helper refused", { skip: SKIP_LIVE }, (t) => {
  const rows = runSql(`begin;
${R17}
create temp table a26_auth(k text, v text);
grant all on a26_auth to authenticated;
do $t$
declare uid uuid; r record; cnt int;
begin
  select p.id into uid from public.profiles p join public.companies c on c.id = p.company_id where c.name = 'Marc';
  if uid is null then
    insert into a26_auth values ('no_marc_login', 'true');
    return;
  end if;
  -- The trial date is moved as the SUPERUSER with NO login claims, then checked to have really moved.
  -- (Set the claims first and protect_billing_columns sees a signed-in non-admin and quietly restores
  -- the old value -- which is the trigger doing its job, and which once made this probe vacuous.)
  -- Inside the window: the trial ended 1 day ago. The row change lives only inside this transaction.
  perform set_config('request.jwt.claims', '', true);
  update public.companies set trial_ends_at = now() - interval '1 day' where name = 'Marc';
  insert into a26_auth select 'in_window_date_moved', (trial_ends_at between now() - interval '25 hours' and now() - interval '23 hours')::text
    from public.companies where name = 'Marc';
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select * into r from public.my_service_status();
  insert into a26_auth values ('in_window_mss_allowed', r.allowed::text), ('in_window_self_serve', r.can_self_serve::text),
                              ('in_window_reason', left(r.reason, 70)),
                              ('in_window_grace_h', round(extract(epoch from (r.grace_ends_at - now())) / 3600.0)::text),
                              ('in_window_suspended_fn', public.company_is_suspended()::text);
  select count(*) into cnt from public.jobs;
  insert into a26_auth values ('in_window_jobs_read_ok', 'true');
  begin
    perform public.trial_conversion_grace_ends((select company_id from public.profiles where id = uid));
    insert into a26_auth values ('helper_callable', 'true');
  exception when insufficient_privilege then
    insert into a26_auth values ('helper_callable', 'false');
  end;

  -- Outside the window: the same trial ended 4 days ago, the SAME login. The wall.
  reset role;
  perform set_config('request.jwt.claims', '', true);
  update public.companies set trial_ends_at = now() - interval '4 days' where name = 'Marc';
  insert into a26_auth select 'out_window_date_moved', (trial_ends_at between now() - interval '97 hours' and now() - interval '95 hours')::text
    from public.companies where name = 'Marc';
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select * into r from public.my_service_status();
  insert into a26_auth values ('out_window_mss_allowed', r.allowed::text), ('out_window_suspended_fn', public.company_is_suspended()::text);
  reset role;
end
$t$;
select * from a26_auth order by k;
rollback;`, "authenticated chain");
  const m = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  if (m.no_marc_login) { t.diagnostic("no Marc login found: authenticated probe skipped"); return; }
  assert.equal(m.in_window_date_moved, "true", "control: the trial date really was moved back one day (a signed-in write would have been reverted)");
  assert.equal(m.out_window_date_moved, "true", "control: and then four days");
  assert.equal(m.in_window_mss_allowed, "true", "inside the window the real function, called as a signed-in user, says allowed");
  assert.equal(m.in_window_suspended_fn, "false", "and the function behind the 21 restrictive policies agrees");
  assert.equal(m.in_window_jobs_read_ok, "true", "a table read under RLS does not raise");
  assert.equal(m.in_window_self_serve, "false");
  assert.match(m.in_window_reason, /not yet had confirmation/);
  assert.equal(m.in_window_grace_h, "48");
  assert.equal(m.helper_callable, "false", "the helper is closed to signed-in users (no billing-state oracle by company id)");
  assert.equal(m.out_window_mss_allowed, "false", "CONTROL: four days after the trial the same login is refused");
  assert.equal(m.out_window_suspended_fn, "true", "and the restrictive-policy function agrees");
});

test("LIVE: none of that changed anything -- the companies, the gate and the status function are exactly as they were", { skip: SKIP_LIVE }, () => {
  assert.ok(fingerprintBefore, "the control test ran first");
  const [after] = runSql(FINGERPRINT_SQL, "fingerprint after");
  assert.deepEqual(after, fingerprintBefore, "every dry run and probe was rolled back");
});

test("LIVE REPORT: what is NOT established from here, and the two places that would establish it (printed, not asserted)", { skip: SKIP_LIVE }, (t) => {
  t.diagnostic("WHY the conversion event did not land is not provable without Stripe. Two places answer it:");
  t.diagnostic("  1. Stripe dashboard (TEST mode) > Developers > Webhooks > the endpoint: is it enabled, and does its event list include " +
               "customer.subscription.updated and invoice.payment_succeeded? Then its delivery log around 2026-09-10 18:02 UTC (Legacy) and 2026-09-14 17:55 UTC (Marc): 2xx, 4xx or 5xx, or nothing sent.");
  t.diagnostic("  2. PeterLLC's trial ends 2026-10-05 20:29 UTC. If its row moves off 'trialing' within a few hours of that, the handover works in general " +
               "and Legacy/Marc were an endpoint problem that has since been fixed; if it does not, r17's 72 hours of grace is what stands between it and the wall.");
  assert.ok(true);
});
