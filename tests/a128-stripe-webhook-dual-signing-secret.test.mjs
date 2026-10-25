// A128 -- stripe-webhook must verify EITHER the live or the test signing
// secret, without letting a test-mode event touch real money.
//
// The day the Stripe secrets were switched from test to live,
// STRIPE_WEBHOOK_SECRET started holding the LIVE endpoint's secret. Stripe
// signs a test-mode event with the TEST endpoint's secret, which is a
// different string, so from that moment every test-mode delivery failed its
// signature check and answered 400: the deposit link, the card a deposit
// saves and the office's off-session charge all became untestable end to end
// without moving real money.
//
// The fix adds an OPTIONAL second secret, STRIPE_WEBHOOK_SECRET_TEST. When it
// is unset -- the default -- the function behaves exactly as it did. When it
// is set, a request that fails against the live secret is retried against it.
//
// Three things have to be true at once, and each of them has been proved by
// breaking it (see the canary notes at the foot of this file):
//   (a) a test-secret event is accepted ONLY because the fallback exists;
//   (b) the comparison is still constant-time, for both secrets, because
//       both arms call the one verify() and nothing else;
//   (c) a MISSING PRIMARY secret still refuses everything, loudly, even with
//       a test secret present -- an undefined secret once became the literal
//       string "undefined" as an HMAC key.
//
// And the money rule, which is the whole reason a test secret is tolerable:
// a test-mode event must not credit a live job. That is NOT enforced by the
// signature layer; it is enforced per payment row, from the livemode column
// recorded when the link was created. This file proves it where it holds and
// names, in the last test, the two places where it does NOT.
//
// This runs the REAL stripe-webhook function file, not a copy of its rules --
// same harness recipe as tests/a7-stripe-async-payment-status.test.mjs and
// tests/a4-fees.test.mjs. Signatures are computed here with node:crypto,
// independently of the function, so a mistake shared by signer and verifier
// cannot hide.
//
// Run with:  node tests/a128-stripe-webhook-dual-signing-secret.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createHmac } from "node:crypto";
import * as recordPayment from "../supabase/functions/_shared/record-payment.ts";
import * as pushRecipients from "../supabase/functions/_shared/push-recipients.ts";

const FN_PATH = new URL("../supabase/functions/stripe-webhook/index.ts", import.meta.url);
const SRC = readFileSync(FN_PATH, "utf8");

const LIVE = "whsec_live_endpoint_placeholder";
const TEST = "whsec_test_endpoint_placeholder";
const COMPANY = "c0000000-0000-4000-8000-000000000001";

const liveOnlyEnv = {
  STRIPE_WEBHOOK_SECRET: LIVE,
  SUPABASE_URL: "https://project.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
  // FIREBASE_SERVICE_ACCOUNT and NOTIFY_TRIGGER_SECRET deliberately absent:
  // every notify* helper and askForReceipt read them first and return before
  // ever calling fetch. If that stops being true, fetchImpl below throws
  // instead of silently making a real network call.
};
const bothEnv = { ...liveOnlyEnv, STRIPE_WEBHOOK_SECRET_TEST: TEST };
const noPrimaryEnv = { ...bothEnv, STRIPE_WEBHOOK_SECRET: "" };

// ---------------------------------------------------------------- harness --

function loadSource(src, { env = {}, db, fetchImpl = async (url) => { throw new Error("unexpected fetch: " + url); } } = {}) {
  let js = stripTypeScriptTypes(src);
  const importRe = /^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";?[ \t]*$/gm;
  const shared = {};
  for (const [, list, from] of js.matchAll(importRe)) {
    const names = list.split(",").map((n) => n.trim()).filter(Boolean);
    if (/supabase-js/.test(from)) assert.deepEqual(names, ["createClient"]);
    else if (from === "../_shared/record-payment.ts") {
      for (const n of names) { assert.ok(n in recordPayment, `no ${n} in record-payment.ts`); shared[n] = recordPayment[n]; }
    } else if (from === "../_shared/push-recipients.ts") {
      for (const n of names) { assert.ok(n in pushRecipients, `no ${n} in push-recipients.ts`); shared[n] = pushRecipients[n]; }
    } else assert.fail(`an import the harness does not supply: ${from}`);
  }
  js = js.replace(importRe, "").replace(/^export /gm, "");
  assert.doesNotMatch(js, /^import /m);
  const sharedNames = Object.keys(shared);
  let handler = null;
  const Deno = {
    env: { get: (k) => env[k] },
    serve: (h) => { handler = h; },
  };
  new Function("Deno", "createClient", "fetch", ...sharedNames, js)(
    Deno, () => db, fetchImpl, ...sharedNames.map((n) => shared[n]),
  );
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

const load = (opts) => loadSource(SRC, opts);

/** In-memory stand-in for the service-role client. Same shape as
 * tests/a7-stripe-async-payment-status.test.mjs's fakeDb(). */
function fakeDb(tables) {
  const t = structuredClone(tables);
  let seq = 0;
  class Query {
    constructor(table) { this.table = table; this.op = "select"; this.filters = []; this.lim = Infinity; }
    select() { return this; }
    eq(k, v) { this.filters.push((r) => String(r[k]) === String(v)); return this; }
    is(k, v) { this.filters.push((r) => (v === null ? (r[k] === null || r[k] === undefined) : r[k] === v)); return this; }
    order() { return this; }
    limit(n) { this.lim = n; return this; }
    insert(row) { this.op = "insert"; this.payload = row; return this; }
    update(patch) { this.op = "update"; this.payload = patch; return this; }
    upsert(row, opts) { this.op = "upsert"; this.payload = row; this.conflict = String(opts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean); return this; }
    maybeSingle() { this.mode = "maybe"; return this.run(); }
    single() { this.mode = "one"; return this.run(); }
    then(ok, bad) { return this.run().then(ok, bad); }
    async run() {
      const rows = (t[this.table] ??= []);
      if (this.op === "upsert") {
        const key = this.conflict.length ? this.conflict : Object.keys(this.payload);
        const existing = rows.find((r) => key.every((k) => String(r[k]) === String(this.payload[k])));
        if (existing) Object.assign(existing, this.payload);
        else rows.push({ id: `new-${++seq}`, ...this.payload });
        return { data: null, error: null };
      }
      if (this.op === "insert") { rows.push({ id: `new-${++seq}`, ...this.payload }); return { data: null, error: null }; }
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") { hit.forEach((r) => Object.assign(r, this.payload)); return { data: null, error: null }; }
      const out = hit.slice(0, this.lim);
      if (this.mode === "maybe") return { data: out[0] ?? null, error: null };
      if (this.mode === "one") return out[0] ? { data: out[0], error: null } : { data: null, error: { message: "no row" } };
      return { data: out, error: null };
    }
  }
  return { tables: t, from: (table) => new Query(table), rpc: async () => ({ data: true, error: null }) };
}

const row = (db, table, id) => db.tables[table]?.find((r) => r.id === id);
const jobBySync = (db, syncId) => db.tables.jobs?.find((r) => r.sync_id === syncId);

const mkEvent = (type, obj, livemode = true) =>
  ({ id: "evt_" + Math.random().toString(36).slice(2), type, livemode, data: { object: obj } });

/** The signature Stripe would send: HMAC-SHA256 hex over `${t}.${rawBody}`,
 * computed here by node:crypto and by nothing in the function under test. */
function sign(raw, secret, t) {
  return createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
}

/** POSTs a body with a stripe-signature header built from `secret`. Pass
 * `header` to send a hand-made header instead. */
async function post(handler, body, { secret = LIVE, header = null, skew = 0 } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000) + skew;
  const h = header !== null ? header : `t=${t},v1=${sign(raw, secret, t)}`;
  const res = await handler(new Request("https://fn.test/stripe-webhook", {
    method: "POST", headers: { "stripe-signature": h }, body: raw,
  }));
  return { status: res.status, text: await res.text(), t, raw };
}

/** A job with one pending Stripe payment request against it. `livemode` is
 * the column create-payment-link stamps on the row at creation -- the ONLY
 * thing that decides whether cleared money is booked. */
function seedDb(id, livemode) {
  return fakeDb({
    jobs: [{ id: `job-row-${id}`, sync_id: `JOB-${id}`, company_id: COMPANY, customer_name: "Pat", deposit_amount: 0 }],
    job_payments: [{
      id: `jp-${id}`, company_id: COMPANY, job_sync_id: `JOB-${id}`, status: "pending",
      livemode, stripe_id: `plink_${id}`, amount_cents: 50000, processor: "stripe",
    }],
    payment_records: [],
  });
}

const paidSession = (id) => mkEvent("checkout.session.completed", {
  mode: "payment", payment_link: `plink_${id}`, payment_intent: `pi_${id}`, payment_status: "paid",
});

/** The body of a top-level function in the source, by brace matching from its
 * signature -- so these assertions read the CODE and never a comment that
 * happens to contain the same words. */
function bodyOf(signature) {
  const at = SRC.indexOf(signature);
  assert.notEqual(at, -1, `the source no longer contains ${signature} -- this test is pinned to it`);
  assert.equal(SRC.indexOf(signature, at + 1), -1, `${signature} appears more than once`);
  let i = SRC.indexOf("{", at), depth = 0, inLine = false, inBlock = false;
  const start = i;
  for (; i < SRC.length; i++) {
    const c = SRC[i], n = SRC[i + 1];
    if (inLine) { if (c === "\n") inLine = false; continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  assert.fail(`could not find the end of ${signature}`);
}

/** The same slice with every comment removed, so "constant time" in prose can
 * never stand in for a constant-time comparison in code. */
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

// =============================================== 1. resolution order, ======
// ================================================== proved both ways =======

test("live secret alone (today's deployment): a live-signed event is accepted, a test-signed one is refused", async () => {
  const db = seedDb("L1", true);
  const handler = load({ env: liveOnlyEnv, db });

  const good = await post(handler, paidSession("L1"), { secret: LIVE });
  assert.equal(good.status, 200, good.text);
  assert.equal(good.text, "ok");

  // The exact failure that the live switchover caused, reproduced.
  const db2 = seedDb("L2", false);
  const handler2 = load({ env: liveOnlyEnv, db: db2 });
  const bad = await post(handler2, paidSession("L2"), { secret: TEST });
  assert.equal(bad.status, 400, "with no test secret set, a test-signed event must be refused");
  assert.equal(bad.text, "Bad signature");
  assert.equal(row(db2, "job_payments", "jp-L2").status, "pending", "a refused event must write nothing");
});

test("both secrets set: the SAME body verifies under either one, and the answer is identical", async () => {
  const dbLive = seedDb("B1", true);
  const live = await post(load({ env: bothEnv, db: dbLive }), paidSession("B1"), { secret: LIVE });
  assert.equal(live.status, 200, live.text);

  const dbTest = seedDb("B2", false);
  const test1 = await post(load({ env: bothEnv, db: dbTest }), paidSession("B2"), { secret: TEST });
  assert.equal(test1.status, 200, "a test-signed event must be accepted once the test secret is set");

  // Byte-identical response. Which secret verified the request is not
  // something a caller may learn from the answer.
  assert.equal(live.status, test1.status);
  assert.equal(live.text, test1.text);
  assert.equal(test1.text, "ok");
});

test("setting the test secret changes nothing about a live event: order is live first, test only on failure", async () => {
  // Same live-signed request, once with the test secret absent and once with
  // it present. Same status, same body, same effect on the books.
  const a = seedDb("O1", true), b = seedDb("O2", true);
  const ra = await post(load({ env: liveOnlyEnv, db: a }), paidSession("O1"), { secret: LIVE });
  const rb = await post(load({ env: bothEnv, db: b }), paidSession("O2"), { secret: LIVE });
  assert.equal(ra.status, 200, ra.text);
  assert.deepEqual([rb.status, rb.text], [ra.status, ra.text]);
  assert.equal(row(a, "job_payments", "jp-O1").status, "paid");
  assert.equal(row(b, "job_payments", "jp-O2").status, "paid");
  assert.equal(jobBySync(a, "JOB-O1").amount_paid, 500);
  assert.equal(jobBySync(b, "JOB-O2").amount_paid, 500);

  // And the code says so too: the live secret is the first argument to the
  // first verify() call, with the test secret reached only in the else arm.
  const handlerSrc = codeOnly(SRC.slice(SRC.indexOf("Deno.serve(async (req)"), SRC.indexOf("const event = JSON.parse(raw)")));
  const calls = [...handlerSrc.matchAll(/verify\(\s*raw\s*,\s*signature\s*,\s*(\w+)\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(calls, ["signingSecret", "testSecret"],
    "exactly two verifications, live secret first, test secret second");
  assert.match(handlerSrc, /else if\s*\(\s*testSecret\s*&&\s*await verify\(/,
    "the test secret must only be consulted when the live one has already failed, and only when it is non-empty");
});

test("a wrong, truncated, or stale signature is refused under BOTH secrets", async () => {
  const handler = load({ env: bothEnv, db: seedDb("W", true) });
  const raw = JSON.stringify(paidSession("W"));
  const t = Math.floor(Date.now() / 1000);

  // Right shape, wrong key.
  const other = `t=${t},v1=${sign(raw, "whsec_not_either_of_them", t)}`;
  assert.equal((await post(handler, raw, { header: other })).status, 400);

  for (const secret of [LIVE, TEST]) {
    const full = sign(raw, secret, t);
    // A correct PREFIX of the right digest. Refused -- this is what a
    // startsWith/substring comparison would wave through.
    assert.equal((await post(handler, raw, { header: `t=${t},v1=${full.slice(0, 32)}` })).status, 400,
      "a prefix of the right signature is not the right signature");
    // Right length, one nibble different.
    const flipped = full.slice(0, -1) + (full.at(-1) === "0" ? "1" : "0");
    assert.equal((await post(handler, raw, { header: `t=${t},v1=${flipped}` })).status, 400);
    // The right signature for a DIFFERENT body.
    assert.equal((await post(handler, raw, { header: `t=${t},v1=${sign(raw + " ", secret, t)}` })).status, 400);
    // Correctly signed, but replayed from outside the five-minute window --
    // the test secret must not buy an event a longer life than a live one.
    assert.equal((await post(handler, paidSession("W"), { secret, skew: -400 })).status, 400,
      "the replay window applies to the test secret too");
    // And the same request inside the window is accepted, so the three
    // refusals above are refusals and not a dead handler.
    assert.equal((await post(load({ env: bothEnv, db: seedDb("W2", true) }), paidSession("W2"), { secret })).status, 200);
  }
});

test("a rotating test secret: every v1 in the header is tried, not just the last", async () => {
  // The live secret's rotation behaviour, which verify() already has, must
  // apply to the test secret as well -- it is the same function.
  const handler = load({ env: bothEnv, db: seedDb("R", true) });
  const raw = JSON.stringify(paidSession("R"));
  const t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=${sign(raw, "whsec_an_older_test_secret", t)},v1=${sign(raw, TEST, t)}`;
  assert.equal((await post(handler, raw, { header })).status, 200,
    "a header carrying an old and a current signature must still verify");
});

// ===================================== 2. the comparison is still one ======
// ======================================== constant-time comparison =========

test("CONSTANT TIME: both secrets go through the one verify(), whose compare has no early exit", () => {
  const verifyBody = codeOnly(bodyOf("async function verify(rawBody: string, header: string | null, secret: string)"));

  // The whole-digest XOR accumulator, still there.
  assert.match(verifyBody, /diff\s*\|=\s*expected\.charCodeAt\(i\)\s*\^\s*signature\.charCodeAt\(i\)/,
    "the per-byte XOR accumulator is gone -- the compare is no longer constant-time");
  assert.match(verifyBody, /if\s*\(diff\s*===\s*0\)/,
    "the result must be decided by the accumulator after the full loop");

  // No short-circuit anywhere inside the comparison loop: a break, a return or
  // a direct equality/prefix test on the digest all leak where the first
  // mismatch is.
  const loop = verifyBody.slice(verifyBody.indexOf("for (let i = 0"));
  const loopBody = loop.slice(loop.indexOf("{"), loop.indexOf("}") + 1);
  assert.doesNotMatch(loopBody, /\b(break|return|continue)\b/,
    "the byte loop must run to the end for every candidate");
  assert.doesNotMatch(verifyBody, /expected\s*(===|==|!==|!=)\s*signature/,
    "a direct string comparison of the digests is not constant-time");
  assert.doesNotMatch(verifyBody, /\.(startsWith|endsWith|includes|indexOf|localeCompare)\(/,
    "a prefix/substring comparison of the digests is not constant-time");
  assert.doesNotMatch(verifyBody, /timingSafeEqual/,
    "node:crypto is not available in the Deno runtime this function runs in");

  // And the handler reuses it rather than growing a second comparison of its
  // own that could drift away from this one.
  const handlerSrc = codeOnly(SRC.slice(SRC.indexOf("Deno.serve(async (req)"), SRC.indexOf("const event = JSON.parse(raw)")));
  assert.equal((handlerSrc.match(/\bverify\(/g) ?? []).length, 2,
    "exactly two calls to verify() and no other comparison");
  assert.doesNotMatch(handlerSrc, /crypto\.subtle|createHmac|charCodeAt/,
    "the handler must not compute or compare an HMAC itself");
});

// ======================================= 3. a missing PRIMARY secret =======
// ============================================= still refuses, loudly =======

test("no primary secret: everything is refused with 500, even with a test secret set", async () => {
  for (const env of [
    { ...liveOnlyEnv, STRIPE_WEBHOOK_SECRET: "" },      // nothing at all
    noPrimaryEnv,                                        // test secret present
  ]) {
    const db = seedDb("N", true);
    const handler = load({ env, db });
    for (const secret of [LIVE, TEST, "undefined"]) {
      const r = await post(handler, paidSession("N"), { secret });
      assert.equal(r.status, 500, "a deployment with no live secret must refuse, not fall back");
      assert.equal(r.text, "Webhook not configured");
    }
    assert.equal(row(db, "job_payments", "jp-N").status, "pending", "nothing may be written");
    assert.equal(db.tables.payment_records.length, 0);
  }

  // The specific historical attack: an unset secret reaching verify() as the
  // literal text "undefined" and becoming the HMAC key. Signing with that
  // string must not get in.
  const db = seedDb("U", true);
  const r = await post(load({ env: { ...noPrimaryEnv }, db }), paidSession("U"), { secret: "undefined" });
  assert.equal(r.status, 500, r.text);
  assert.equal(jobBySync(db, "JOB-U").amount_paid, undefined);

  // The guard is still an env read of the primary name, not of the test name.
  const handlerSrc = codeOnly(SRC.slice(SRC.indexOf("Deno.serve(async (req)"), SRC.indexOf("const raw = await req.text()")));
  assert.match(handlerSrc, /if\s*\(!signingSecret\)\s*\{[\s\S]{0,400}?status:\s*500/,
    "the 500 refusal on a missing primary secret must still be the first thing the handler does");
  // signingSecret must be the primary name and nothing else -- no `||`, no
  // `??`, no second env read folded into its declaration. This is where a
  // well-meant "fall back to the test secret" would be written.
  assert.match(handlerSrc, /const signingSecret = Deno\.env\.get\("STRIPE_WEBHOOK_SECRET"\) \?\? "";\s*$/m,
    "the primary secret must be read on its own, with no fallback folded into it");
  assert.equal((handlerSrc.match(/STRIPE_WEBHOOK_SECRET_TEST/g) ?? []).length, 1,
    "the test secret name may appear exactly once before the refusal, as its own read");
  assert.doesNotMatch(handlerSrc, /signingSecret\s*(\|\||\?\?)\s*testSecret|testSecret\s*(\|\||\?\?)\s*signingSecret/,
    "the test secret must never stand in for a missing primary secret");
});

// ======================================== 4. the money rule: a test ========
// ============================== event must not credit a live job ==========

test("MONEY: a test-signed payment on a test row is acknowledged but books NOTHING", async () => {
  // livemode:false is what create-payment-link stamps on a row made with the
  // test keys (create-payment-link/index.ts:1319, :1340).
  const db = seedDb("T", false);
  const handler = load({ env: bothEnv, db });
  const r = await post(handler, paidSession("T"), { secret: TEST });
  assert.equal(r.status, 200, r.text);

  // The request row is marked paid -- the owner can see his test went through.
  assert.equal(row(db, "job_payments", "jp-T").status, "paid");
  // And not one penny reaches the job or the ledger.
  assert.equal(jobBySync(db, "JOB-T").amount_paid, undefined,
    "a test payment must not move the job's paid figure");
  assert.equal(jobBySync(db, "JOB-T").payment_status, undefined);
  assert.equal(db.tables.payment_records.length, 0,
    "a test payment must not write a ledger row -- payment_records has no mode column");
});

test("POSITIVE CONTROL: the same request on a LIVE row does book the money", async () => {
  // Without this, the test above could pass because the handler is broken.
  const db = seedDb("P", true);
  const handler = load({ env: bothEnv, db });
  const r = await post(handler, paidSession("P"), { secret: LIVE });
  assert.equal(r.status, 200, r.text);
  assert.equal(row(db, "job_payments", "jp-P").status, "paid");
  assert.equal(jobBySync(db, "JOB-P").amount_paid, 500, "a live payment must still be booked");
  assert.equal(db.tables.payment_records.length, 1);
});

test("MONEY: the mode comes from the payment ROW, not from the event or the secret", async () => {
  // The dangerous direction. An event that CLAIMS livemode:true, verified by
  // the TEST secret, against a row the database says is a test row: still not
  // booked, because applyPaymentToJob reads payment.livemode.
  const db = seedDb("X1", false);
  const r1 = await post(load({ env: bothEnv, db }), mkEvent("checkout.session.completed", {
    mode: "payment", payment_link: "plink_X1", payment_intent: "pi_X1", payment_status: "paid",
  }, true), { secret: TEST });
  assert.equal(r1.status, 200, r1.text);
  assert.equal(jobBySync(db, "JOB-X1").amount_paid, undefined,
    "event.livemode must not be able to promote a test row's payment");
  assert.equal(db.tables.payment_records.length, 0);

  // The off-session charge path (payment_intent.succeeded) reads the same
  // column and must refuse the same way.
  const db2 = fakeDb({
    jobs: [{ id: "job-X2", sync_id: "JOB-X2", company_id: COMPANY, customer_name: "Pat", deposit_amount: 0 }],
    job_payments: [{
      id: "jp-X2", company_id: COMPANY, job_sync_id: "JOB-X2", status: "pending",
      livemode: false, processor: "stripe", external_id: "pi_X2", amount_cents: 25000,
    }],
    payment_records: [],
  });
  const r2 = await post(load({ env: bothEnv, db: db2 }), mkEvent("payment_intent.succeeded", {
    id: "pi_X2", metadata: { off_session: "true" },
  }, true), { secret: TEST });
  assert.equal(r2.status, 200, r2.text);
  assert.equal(row(db2, "job_payments", "jp-X2").status, "paid");
  assert.equal(jobBySync(db2, "JOB-X2").amount_paid, undefined,
    "the office's off-session charge must not book a test payment either");
  assert.equal(db2.tables.payment_records.length, 0);

  // Said in the code, not inferred: the single livemode gate both callers
  // reach, with no other reading of the flag in between.
  const applyBody = codeOnly(bodyOf("async function applyPaymentToJob(admin: any, payment: any)"));
  assert.match(applyBody, /const livemode = payment\.livemode === true;/,
    "the mode must be read from the payment row");
  assert.match(applyBody, /if\s*\(!livemode\)\s*\{[\s\S]*?return;\s*\}/,
    "a non-live payment must return before any booking");
  assert.doesNotMatch(applyBody, /event\.livemode|verifiedMode/,
    "the booking decision must not depend on the event or on which secret verified it");
});

test("MONEY: a refund or chargeback withdrawal in test mode is not booked either", async () => {
  // recordRefund refuses a non-live refund outright
  // (supabase/functions/_shared/record-payment.ts:201-202), and the webhook
  // passes event.livemode to it -- so a test-signed refund writes nothing.
  const db = fakeDb({
    jobs: [{ id: "job-F", sync_id: "JOB-F", company_id: COMPANY, customer_name: "Pat", deposit_amount: 0, amount_paid: 500 }],
    job_payments: [{
      id: "jp-F", company_id: COMPANY, job_sync_id: "JOB-F", status: "paid",
      livemode: false, processor: "stripe", external_id: "pi_F", amount_cents: 50000, fee_cents: 0,
    }],
    payment_records: [],
  });
  const r = await post(load({ env: bothEnv, db }), mkEvent("refund.created", {
    id: "re_F", status: "succeeded", payment_intent: "pi_F", amount: 50000, currency: "usd", reason: "requested_by_customer",
  }, false), { secret: TEST });
  assert.equal(r.status, 200, r.text);
  assert.equal(db.tables.payment_records.length, 0,
    "a test-mode refund must not write a negative ledger row against a real job");
  assert.equal(jobBySync(db, "JOB-F").amount_paid, 500, "and must not move the paid figure");
});

// ================================================ 5. the KNOWN GAPS ========
// ================= reported, deliberately not papered over here ============

test("CLOSED: a test-mode dispute and a test-mode subscription touch nothing real", async () => {
  // These recorded three wrong behaviours, reproduced on a real job and a
  // real company, and said to turn the assertions round once they were fixed.
  // They are fixed. The fixtures below are unchanged -- same ids, same
  // amounts, same events, same test-mode signature -- so these are the very
  // probes that produced the damage, now proving it does not.
  //
  // Each one also checks the positive half: a LIVE event on the same path
  // still writes. A gate that refused everything, or a handler that had
  // stopped running, looks identical to a gate that works if you only ever
  // assert that nothing happened.

  // (i) charge.dispute.funds_reinstated upserts a POSITIVE payment_records
  //     row with no livemode check -- stripe-webhook/index.ts:1114 (the
  //     upsert) inside the dispute branch that starts at :1061. It is placed
  //     only by the job_payments row's external_id, and a test payment row
  //     carries a REAL job's sync_id, so a test-mode dispute credits a real
  //     job's ledger.
  const db = fakeDb({
    jobs: [{ id: "job-D", sync_id: "JOB-D", company_id: COMPANY, customer_name: "Pat", deposit_amount: 0 }],
    job_payments: [{
      id: "jp-D", company_id: COMPANY, job_sync_id: "JOB-D", status: "paid",
      livemode: false, processor: "stripe", external_id: "pi_D", amount_cents: 50000, fee_cents: 0,
    }],
    payment_records: [],
  });
  const r = await post(load({ env: bothEnv, db }), mkEvent("charge.dispute.funds_reinstated", {
    id: "dp_D", payment_intent: "pi_D", amount: 50000, currency: "usd", status: "won", reason: "fraudulent", created: 1790000000,
  }, false), { secret: TEST });
  assert.equal(r.status, 200, r.text);
  assert.equal(db.tables.payment_records.length, 0,
    "a test-mode funds_reinstated must not write a row into a real job's ledger");
  assert.equal(jobBySync(db, "JOB-D").dispute_status, undefined,
    "a test-mode dispute must not stamp dispute fields on a real job");

  // POSITIVE CONTROL: the same dispute, on a LIVE payment row, still books.
  // Without this, a gate that refused every dispute -- or a branch that had
  // stopped running -- would pass the two assertions above.
  const dbLive = fakeDb({
    jobs: [{ id: "job-L", sync_id: "JOB-L", company_id: COMPANY, customer_name: "Pat", deposit_amount: 0 }],
    job_payments: [{
      id: "jp-L", company_id: COMPANY, job_sync_id: "JOB-L", status: "paid",
      livemode: true, processor: "stripe", external_id: "pi_L", amount_cents: 50000, fee_cents: 0,
    }],
    payment_records: [],
  });
  const rLive = await post(load({ env: bothEnv, db: dbLive }), mkEvent("charge.dispute.funds_reinstated", {
    id: "dp_L", payment_intent: "pi_L", amount: 50000, currency: "usd", status: "won", reason: "fraudulent", created: 1790000000,
  }, true), { secret: LIVE });
  assert.equal(rLive.status, 200, rLive.text);
  assert.equal(dbLive.tables.payment_records.length, 1,
    "POSITIVE CONTROL: a LIVE funds_reinstated must still write its ledger row");
  assert.equal(jobBySync(dbLive, "JOB-L").dispute_status, "won",
    "POSITIVE CONTROL: a LIVE dispute must still stamp the job");

  // (ii) The subscription branch (index.ts:1134-1223) reads no mode at all. A
  //      test-mode customer.subscription.* event whose metadata names a real
  //      company overwrites companies.stripe_subscription_id with a TEST
  //      subscription id -- after which the LIVE renewal events
  //      (invoice.payment_succeeded / _failed, matched on that column) stop
  //      matching the company at all.
  const db2 = fakeDb({
    companies: [{ id: COMPANY, stripe_subscription_id: "sub_LIVE_real", subscription_status: "active" }],
  });
  const r2 = await post(load({ env: bothEnv, db: db2 }), mkEvent("customer.subscription.updated", {
    id: "sub_TEST_sandbox", status: "active", metadata: { company_id: COMPANY, plan: "pro" },
    items: { data: [{ price: { unit_amount: 100, recurring: { interval: "month", interval_count: 1 } }, quantity: 1, current_period_end: 1800000000 }] },
  }, false), { secret: TEST });
  assert.equal(r2.status, 200, r2.text);
  assert.equal(db2.tables.companies[0].stripe_subscription_id, "sub_LIVE_real",
    "a test subscription must not take over a company that already points at a live one");

  // The "different sub owns this company" guard at :1149 is what saved it
  // above -- NOT a mode check. A company with no stored subscription has no
  // such guard, and the test event lands:
  const db3 = fakeDb({ companies: [{ id: COMPANY, stripe_subscription_id: null, subscription_status: "none" }] });
  const r3 = await post(load({ env: bothEnv, db: db3 }), mkEvent("customer.subscription.created", {
    id: "sub_TEST_sandbox", status: "active", metadata: { company_id: COMPANY, plan: "pro" },
    items: { data: [{ price: { unit_amount: 100, recurring: { interval: "month", interval_count: 1 } }, quantity: 1, current_period_end: 1800000000 }] },
  }, false), { secret: TEST });
  assert.equal(r3.status, 200, r3.text);
  assert.equal(db3.tables.companies[0].subscription_status, "none",
    "a test-mode subscription must not activate a real company");
  assert.equal(db3.tables.companies[0].stripe_subscription_id, null,
    "a test subscription id must never be stored -- the LIVE renewal events match a company on " +
    "this column, so a sandbox id here makes a real renewal failure stop matching the company");

  // POSITIVE CONTROL: the same event, LIVE, still activates the company.
  const db4 = fakeDb({ companies: [{ id: COMPANY, stripe_subscription_id: null, subscription_status: "none" }] });
  const r4 = await post(load({ env: bothEnv, db: db4 }), mkEvent("customer.subscription.created", {
    id: "sub_LIVE_new", status: "active", metadata: { company_id: COMPANY, plan: "pro" },
    items: { data: [{ price: { unit_amount: 100, recurring: { interval: "month", interval_count: 1 } }, quantity: 1, current_period_end: 1800000000 }] },
  }, true), { secret: LIVE });
  assert.equal(r4.status, 200, r4.text);
  assert.equal(db4.tables.companies[0].stripe_subscription_id, "sub_LIVE_new",
    "POSITIVE CONTROL: a LIVE subscription must still take effect");
});

// ------------------------------------------------------------ canaries -----
//
// Each applied to supabase/functions/stripe-webhook/index.ts, run, shown red,
// then restored byte-identical (sha256 re-checked):
//
// (a) FALLBACK REMOVED -- the `else if (testSecret && await verify(...))` arm
//     deleted, leaving only the live comparison. RED:
//       "both secrets set: the SAME body verifies under either one" --
//       "a test-signed event must be accepted once the test secret is set"
//       expected 200, got 400. Plus the two MONEY tests and the KNOWN GAP
//       test, all 400 instead of 200.
//
// (b) COMPARISON MADE NAIVE -- verify()'s byte loop replaced with
//     `if (expected === signature) matched = true;`. 11 pass, 1 fail:
//       "CONSTANT TIME: both secrets go through the one verify()" --
//       "the per-byte XOR accumulator is gone -- the compare is no longer
//       constant-time". The functional tests stay GREEN under this canary,
//       because a naive `===` is still CORRECT, only leaky -- which is exactly
//       why the structural assertion has to exist as well.
//
// (b2) COMPARISON MADE A PREFIX TEST -- the same loop replaced with
//     `if (signature.length >= 16 && expected.startsWith(signature))`.
//     10 pass, 2 fail: the structural assertion above, AND functionally --
//       "a wrong, truncated, or stale signature is refused under BOTH
//       secrets" -- "a prefix of the right signature is not the right
//       signature". So the leaky-compare family is caught by behaviour too,
//       not only by reading the source.
//
// (c) PRIMARY SECRET ALLOWED TO FALL BACK -- the declaration changed to
//     `Deno.env.get("STRIPE_WEBHOOK_SECRET") || Deno.env.get("STRIPE_WEBHOOK_SECRET_TEST") || ""`,
//     so a deployment with only the test secret no longer hits the 500.
//     11 pass, 1 fail:
//       "no primary secret: everything is refused with 500, even with a test
//       secret set" -- "a deployment with no live secret must refuse, not
//       fall back", expected 500, actual 400.
