// A131 -- lead-intake's company gate must fail CLOSED.
//
// THE DEFECT. The public get-a-quote form checked the company's standing like
// this:
//
//     const { data: allowed } = await admin.rpc("company_allowed", ...);
//     if (allowed === false) return json({ error: "..." }, 404);
//
// The error was thrown away, and `=== false` is a much narrower question than
// "did this company say yes". Two answers slipped straight through:
//
//   1. A FAILED rpc. supabase-js does not throw; it returns data: null with
//      the reason in `error`. null !== false, so the gate passed and the
//      stranger's request was written into a lapsed company's pipeline --
//      exactly what this function's own header says it exists to stop ("a
//      lapsed company's public form went on collecting homeowners' requests
//      into an account nobody could open"). EXECUTE on a function being
//      revoked, or a schema-cache miss after a redeploy, is not hypothetical
//      in this project.
//
//   2. A NULL answer with no error at all. company_allowed is, verbatim from
//      the live database on 2026-10-25:
//
//        select c.deleted_at is null and (not c.suspended) and ...
//          from companies c where c.id = cid;
//
//      -- a scalar subquery, so a company id that matches no row answers
//      NULL, not false. Probed live: company_allowed('<unknown uuid>') is
//      NULL and company_allowed('<a real company>') is true.
//
// THE FIX, taken from the three callers that already got this right
// (invite-crew:131-139, price-job:245-248, mail-send:1575): read the error,
// and -- mail-send's shape -- demand a literal true.
//
// This drives the REAL function file through the a128 harness rather than
// grepping it, because the defect is in what the code DOES with an answer.
//
//   node tests/a131-lead-intake-gate-fails-closed.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const FN_PATH = new URL("../supabase/functions/lead-intake/index.ts", import.meta.url);
const SRC = readFileSync(FN_PATH, "utf8");

const TOKEN = "11111111-2222-4333-8444-555555555555";
const COMPANY = "aba5b097-afc4-48dd-9851-b50200d5e8f4";

// ---------------------------------------------------------------- harness --

/** Runs the function's own source with Deno and createClient supplied, the
 *  same recipe tests/a128-stripe-webhook-dual-signing-secret.test.mjs uses. */
function load({ env = {}, db } = {}) {
  let js = stripTypeScriptTypes(SRC);
  const importRe = /^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";?[ \t]*$/gm;
  for (const [, list, from] of js.matchAll(importRe)) {
    assert.match(from, /supabase-js/, `an import the harness does not supply: ${from}`);
    assert.deepEqual(list.split(",").map((n) => n.trim()), ["createClient"]);
  }
  js = js.replace(importRe, "");
  assert.doesNotMatch(js, /^import /m);
  let handler = null;
  const Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
  new Function("Deno", "createClient", js)(Deno, () => db);
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

/** The narrow slice of a service-role client lead-intake actually uses:
 *  one companies read, one rpc, one counted jobs read, one jobs insert. */
function fakeDb({ company, rpc, floodCount = 0 }) {
  const state = { inserted: [], rpcCalls: [] };
  const thenable = (v) => ({ then: (res) => res(v) });
  return {
    state,
    rpc(name, args) { state.rpcCalls.push({ name, args }); return thenable(rpc); },
    from(table) {
      return {
        select(_cols, opts) {
          const chain = {
            eq: () => chain,
            gte: () => chain,
            maybeSingle: () => thenable({ data: table === "companies" ? company : null, error: null }),
            then: (res) => res(opts?.count ? { count: floodCount, error: null } : { data: [], error: null }),
          };
          return chain;
        },
        insert(row) { state.inserted.push(row); return thenable({ data: null, error: null }); },
      };
    },
  };
}

const COMPANY_ROW = { id: COMPANY, name: "Acme Fence", suspended: false };

const LEAD = { name: "Pat Homeowner", phone: "8135550199", email: "pat@example.com", address: "9 Oak St", notes: "6ft wood" };

async function postLead(answer, { env = {}, company = COMPANY_ROW } = {}) {
  const db = fakeDb({ company, rpc: answer });
  const handler = load({ env, db });
  const res = await handler(new Request(`https://fn.test/lead-intake?c=${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(LEAD),
  }));
  return { status: res.status, body: await res.json(), db };
}

// ------------------------------------------------------------- the defect --

test("an rpc that FAILED is not permission to collect the request", async () => {
  const r = await postLead({ data: null, error: { message: "permission denied for function company_allowed" } });
  assert.notEqual(r.status, 200, "a broken gate must not read as an open door");
  assert.equal(r.status, 503, "and the refusal says 'try again', because the company may well be fine");
  assert.equal(r.db.state.inserted.length, 0,
    "NOTHING may be written to jobs when the company's standing is unknown");
});

test("a NULL answer -- what the live function returns for a company id that matches no row -- is not a yes", async () => {
  const r = await postLead({ data: null, error: null });
  assert.notEqual(r.status, 200);
  assert.equal(r.status, 404);
  assert.equal(r.db.state.inserted.length, 0);
});

test("an explicit false still refuses, as it always did", async () => {
  const r = await postLead({ data: false, error: null });
  assert.equal(r.status, 404);
  assert.match(r.body.error, /not taking requests/i);
  assert.equal(r.db.state.inserted.length, 0);
});

test("the gate is actually asked, with this company's id", async () => {
  // Without this, every refusal above would pass just as happily against a
  // function that had stopped calling company_allowed and started refusing
  // everybody.
  const r = await postLead({ data: true, error: null });
  assert.equal(r.db.state.rpcCalls.length, 1, "company_allowed is called exactly once");
  assert.equal(r.db.state.rpcCalls[0].name, "company_allowed");
  assert.deepEqual(r.db.state.rpcCalls[0].args, { cid: COMPANY });
});

test("POSITIVE CONTROL: a literal true really does let the homeowner through", async () => {
  const r = await postLead({ data: true, error: null });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.company, "Acme Fence");
  assert.equal(r.db.state.inserted.length, 1, "the lead is written");
  assert.equal(r.db.state.inserted[0].company_id, COMPANY);
  assert.equal(r.db.state.inserted[0].customer_name, "Pat Homeowner");
  assert.equal(r.db.state.inserted[0].referral_source, "Website");
});

test("the old rule and the new one genuinely disagree", async () => {
  // A guard against someone 'simplifying' this back to `allowed === false`.
  // If these ever agree on every case, the fix has been undone.
  const oldRuleWouldRefuse = (answer) => answer.data === false;
  const cases = [
    { data: null, error: { message: "permission denied" } },
    { data: null, error: null },
  ];
  for (const answer of cases) {
    assert.equal(oldRuleWouldRefuse(answer), false,
      "by construction the old rule let this through: " + JSON.stringify(answer));
    const r = await postLead(answer);
    assert.notEqual(r.status, 200, "the new rule must refuse it: " + JSON.stringify(answer));
  }
  // ...and they must still agree where the old rule was right.
  assert.equal(oldRuleWouldRefuse({ data: false, error: null }), true);
  assert.equal((await postLead({ data: false, error: null })).status, 404);
});

test("nothing else about this door moved: a bad token and a list address are still refused", async () => {
  // Scope guard. The gate is one line in a function whose whole job is
  // refusing strangers politely; these two refusals are the ones with tests
  // of their own elsewhere, re-asserted here so a change to the gate cannot
  // quietly take them with it.
  const db = fakeDb({ company: COMPANY_ROW, rpc: { data: true, error: null } });
  const handler = load({ db });

  const badToken = await handler(new Request("https://fn.test/lead-intake?c=nope", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }));
  assert.equal(badToken.status, 400);

  const listAddress = await handler(new Request(`https://fn.test/lead-intake?c=${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...LEAD, email: "her@example.com, attacker@example.com" }),
  }));
  assert.equal(listAddress.status, 400, "a comma-separated address list is still refused");
  assert.equal(db.state.inserted.length, 0);
});
