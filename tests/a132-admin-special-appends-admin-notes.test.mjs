// A132 -- admin-special must APPEND to companies.admin_notes, never assign it.
//
// WHAT WAS WRONG. After applying a Stripe discount the function wrote:
//
//   await admin.from("companies").update({
//     admin_notes: `${stamp}: special $...`,
//   }).eq("id", companyId);
//
// A bare assignment. Every other writer of that column preserves what is
// there: admin_grant_access and admin_suspend (read out of pg_proc live) use
// `admin_notes = coalesce(note, admin_notes)`, and the r17 trial-lockout
// audit lines use `coalesce(nullif(c.admin_notes, '') || E'\n', '') || ...`.
//
// It is reachable today. Live: eleven companies, four with a Stripe
// subscription, one with a non-empty admin_notes -- "Owner company.
// Permanent access." -- and that one company is BOTH. One special on it and
// the note is gone, along with any r17 audit line underneath it.
//
// The table's own trigger does not save it. protect_billing_columns holds
// admin_notes back (`new.admin_notes := old.admin_notes`) only after
// `if auth.uid() is null then return new`, and this write has no login behind
// it -- it is the service-role client. The trigger waves it through.
//
// This runs the REAL admin-special function file. Same harness recipe as
// tests/a128-stripe-webhook-dual-signing-secret.test.mjs.
//
// CANARY RESULTS are at the foot of this file.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const FN_PATH = new URL("../supabase/functions/admin-special/index.ts", import.meta.url);
const SRC = readFileSync(FN_PATH, "utf8");

const COMPANY = "11111111-2222-4333-8444-555555555555";
const SUB = "sub_live_placeholder";
// The live note, verbatim, on the one company that carries one.
const OWNER_NOTE = "Owner company. Permanent access.";
// What an r17 decision leaves behind, in r17's own shape.
const R17_LINE = "r17 2026-09-14: trial extended 14 days by SQL. The 14-day trial had ended " +
  "and no word from Stripe had moved the company off trialing.";

const env = {
  SUPABASE_URL: "https://project.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
  SUPABASE_ANON_KEY: "anon-placeholder",
  STRIPE_SECRET_KEY: "sk_live_placeholder",
};

const TODAY = new Date().toISOString().slice(0, 10);
const specialLine = (price, months, revertTo) =>
  `${TODAY}: special $${price.toFixed(2)}/mo for ${months} month${months === 1 ? "" : "s"}, ` +
  `then back to $${revertTo.toFixed(2)}.`;

// ---------------------------------------------------------------- the world --

/**
 * One company row and the Stripe state behind it. `notes` is what
 * admin_notes holds BEFORE the special -- null for most live rows, a real
 * sentence for the owner's.
 */
function world({ notes = null, subId = SUB, unitAmount = 19900, interval = "month", isAdmin = true } = {}) {
  return {
    isAdmin,
    stripe: { subId, unitAmount, interval, coupons: [], applied: [] },
    companies: {
      [COMPANY]: {
        id: COMPANY,
        name: "Acme Fencing",
        stripe_subscription_id: subId,
        admin_notes: notes,
      },
    },
    updates: [],
  };
}

function makeCreateClient(w) {
  return function createClient(url, key, opts) {
    const asCaller = Boolean(opts?.global?.headers?.Authorization);
    return {
      async rpc(name) {
        if (name !== "is_platform_admin") throw new Error("unexpected rpc: " + name);
        // auth.uid() is null for the service role, so the gate is false for it.
        return { data: asCaller ? w.isAdmin : false, error: null };
      },
      from(table) {
        assert.equal(table, "companies", "unexpected table: " + table);
        const q = {
          _cols: null, _patch: null, _id: null, _op: "select",
          select(cols) { this._cols = String(cols); return this; },
          update(patch) { this._op = "update"; this._patch = patch; return this; },
          eq(k, v) { assert.equal(k, "id"); this._id = v; return this; },
          then(ok, bad) { return this._run().then(ok, bad); },
          maybeSingle() { return this._run(); },
          async _run() {
            const row = w.companies[this._id];
            if (this._op === "update") {
              assert.ok(row, "an update aimed at a company that is not there");
              // What the trigger does for a request with no login: nothing.
              Object.assign(row, this._patch);
              w.updates.push({ id: this._id, patch: { ...this._patch } });
              return { data: null, error: null };
            }
            if (!row) return { data: null, error: null };
            const out = {};
            for (const c of this._cols.split(",").map((s) => s.trim())) out[c] = row[c];
            return { data: out, error: null };
          },
        };
        return q;
      },
    };
  };
}

// ---------------------------------------------------------------- harness --

function load(w) {
  let js = stripTypeScriptTypes(SRC);
  const importRe = /^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";?[ \t]*$/gm;
  for (const [, list, from] of js.matchAll(importRe)) {
    const names = list.split(",").map((n) => n.trim()).filter(Boolean);
    assert.match(from, /supabase-js/, `an import the harness does not supply: ${from}`);
    assert.deepEqual(names, ["createClient"]);
  }
  js = js.replace(importRe, "").replace(/^export /gm, "");
  assert.doesNotMatch(js, /^import /m);

  let handler = null;
  const Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };

  const fetchImpl = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const form = () => Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    if (method === "GET" && u.includes("/v1/subscriptions/")) {
      return new Response(JSON.stringify({
        id: w.stripe.subId,
        items: {
          data: [{
            quantity: 1,
            price: { unit_amount: w.stripe.unitAmount, recurring: { interval: w.stripe.interval, interval_count: 1 } },
          }],
        },
      }), { status: 200 });
    }
    if (method === "POST" && u.endsWith("/v1/coupons")) {
      const f = form();
      w.stripe.coupons.push(f);
      if (w.onCoupon) w.onCoupon();
      return new Response(JSON.stringify({ id: "coupon_" + w.stripe.coupons.length }), { status: 200 });
    }
    if (method === "POST" && u.includes("/v1/subscriptions/")) {
      w.stripe.applied.push(form());
      return new Response(JSON.stringify({ id: w.stripe.subId }), { status: 200 });
    }
    throw new Error("unexpected fetch: " + method + " " + u);
  };

  new Function("Deno", "createClient", "fetch", js)(Deno, makeCreateClient(w), fetchImpl);
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

async function special(w, body = { company_id: COMPANY, special_price: 50, months: 1 }) {
  const handler = load(w);
  const res = await handler(new Request("https://fn.test/admin-special", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer owner-jwt" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json(), notes: w.companies[COMPANY].admin_notes };
}

// ================================================= 1. it still does the job ==

test("POSITIVE CONTROL -- a special on a company with no note writes the line and nothing else", async () => {
  const w = world({ notes: null });
  const r = await special(w);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, "applied");
  assert.equal(r.body.was, 199);
  assert.equal(r.body.now, 50);
  // The discount really was made, for the difference, in Stripe.
  assert.equal(w.stripe.coupons.length, 1);
  assert.equal(w.stripe.coupons[0].amount_off, "14900");
  assert.equal(w.stripe.coupons[0].duration, "once");
  assert.equal(w.stripe.applied.length, 1);
  // No leading newline, no "null" in the text.
  assert.equal(r.notes, specialLine(50, 1, 199));
});

// ============================================== 2. the defect, head on =====

test("THE DEFECT -- the live owner note survives a special, with the new line after it", async () => {
  const w = world({ notes: OWNER_NOTE });
  const r = await special(w);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(
    r.notes.includes(OWNER_NOTE),
    `the existing note was lost. admin_notes is now:\n${r.notes}`,
  );
  // r17's shape: what was there, a newline, then the new line.
  assert.equal(r.notes, `${OWNER_NOTE}\n${specialLine(50, 1, 199)}`);
});

test("an r17 audit trail of several lines survives whole, in order", async () => {
  const prior = `${OWNER_NOTE}\n${R17_LINE}`;
  const w = world({ notes: prior });
  const r = await special(w, { company_id: COMPANY, special_price: 99, months: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.notes, `${prior}\n${specialLine(99, 3, 199)}`);
  const lines = r.notes.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], OWNER_NOTE, "the oldest line stays oldest");
  assert.equal(lines[1], R17_LINE);
  assert.equal(w.stripe.coupons[0].amount_off, "10000");
  assert.equal(w.stripe.coupons[0].duration, "repeating");
  assert.equal(w.stripe.coupons[0].duration_in_months, "3");
});

test("two specials accumulate -- it appends every time, it does not merely preserve once", async () => {
  // A fix that saved the prior note by reading the row fetched at the top
  // would pass the test above and still lose a line on the second special.
  const w = world({ notes: OWNER_NOTE });
  const first = await special(w, { company_id: COMPANY, special_price: 50, months: 1 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await special(w, { company_id: COMPANY, special_price: 25, months: 2 });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const lines = second.notes.split("\n");
  assert.equal(lines.length, 3, `expected three lines, got:\n${second.notes}`);
  assert.equal(lines[0], OWNER_NOTE);
  assert.equal(lines[1], specialLine(50, 1, 199));
  assert.equal(lines[2], specialLine(25, 2, 199));
});

test("a note written while the Stripe calls are in flight is not clobbered", async () => {
  // The read has to happen immediately before the write, not from the company
  // row fetched at the top of the handler: three Stripe round-trips sit in
  // between, and admin_suspend, admin_grant_access, an r17 line or another
  // console action can all land in that window. A fix that reuses the early
  // row looks correct in every test above and still loses whatever arrived.
  const w = world({ notes: OWNER_NOTE });
  const meanwhile = "2026-10-25: suspended for non-payment by the console.";
  const handler = load(w);
  // Another writer, landing between the top-of-handler read and the write.
  const original = w.companies[COMPANY].admin_notes;
  w.onCoupon = () => {
    w.companies[COMPANY].admin_notes = `${original}\n${meanwhile}`;
  };
  const res = await handler(new Request("https://fn.test/admin-special", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer owner-jwt" },
    body: JSON.stringify({ company_id: COMPANY, special_price: 50, months: 1 }),
  }));
  assert.equal(res.status, 200, await res.text());
  const notes = w.companies[COMPANY].admin_notes;
  assert.ok(
    notes.includes(meanwhile),
    `a note written during the Stripe calls was overwritten by a stale read. admin_notes is now:\n${notes}`,
  );
  assert.equal(notes, `${OWNER_NOTE}\n${meanwhile}\n${specialLine(50, 1, 199)}`);
});

test("an empty or whitespace-only note is treated as nothing, like nullif() -- no blank first line", async () => {
  for (const prior of ["", "   ", "\n"]) {
    const w = world({ notes: prior });
    const r = await special(w);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.notes, specialLine(50, 1, 199), `prior ${JSON.stringify(prior)} must not be prefixed`);
  }
});

test("the note is written exactly once, and admin_notes is the only column touched", async () => {
  const w = world({ notes: OWNER_NOTE });
  await special(w);
  assert.equal(w.updates.length, 1, "one update, so no read-modify-write loop");
  assert.deepEqual(Object.keys(w.updates[0].patch), ["admin_notes"],
    "monthly_price is a mirror of Stripe and must not be written here");
});

// ======================================== 3. the refusals write nothing ====

test("a price that is not a reduction is refused and the note is left alone", async () => {
  const w = world({ notes: OWNER_NOTE });
  const r = await special(w, { company_id: COMPANY, special_price: 250, months: 1 });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, "not_a_discount");
  assert.equal(r.notes, OWNER_NOTE, "a refused special must not edit admin_notes at all");
  assert.equal(w.updates.length, 0);
});

test("a company with no Stripe subscription is refused and the note is left alone", async () => {
  const w = world({ notes: OWNER_NOTE, subId: "" });
  const r = await special(w);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, "no_subscription");
  assert.equal(r.notes, OWNER_NOTE);
  assert.equal(w.updates.length, 0);
});

test("a caller the gate refuses never reaches the note", async () => {
  const w = world({ notes: OWNER_NOTE, isAdmin: false });
  const r = await special(w);
  assert.equal(r.status, 401, JSON.stringify(r.body));
  assert.equal(r.notes, OWNER_NOTE);
  assert.equal(w.updates.length, 0);
  assert.equal(w.stripe.coupons.length, 0, "and no coupon was made in Stripe either");
});

// ============================================ 4. the shape, not the prose ==

const codeOnly = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

test("the code never assigns admin_notes from the stamp alone", async () => {
  // The exact old shape: an update whose admin_notes value starts at the
  // template literal. If this matches again, the append was undone.
  assert.doesNotMatch(
    codeOnly,
    /admin_notes:\s*`\$\{stamp\}/,
    "admin_notes must be built from what is already in the column, not from the stamp alone",
  );
  // And what is written must mention the prior value.
  const at = codeOnly.indexOf("admin_notes:");
  assert.notEqual(at, -1, "admin-special no longer writes admin_notes -- this test is pinned to that write");
  const value = codeOnly.slice(at, codeOnly.indexOf("\n", at));
  assert.match(value, /prior/, `the written value must carry the prior note: ${value.trim()}`);
});

// ------------------------------------------------------------- CANARIES ----
//
// Applied to supabase/functions/admin-special/index.ts, this file run, then
// the file restored from a copy taken before the canary and the restore
// verified byte for byte by sha256
// (5c6d0658784a4fadd07b2f78fa505a84b6447226d4c67f12121410b1d6c845cc).
//
// CANARY 1 -- the overwrite restored: the read of the prior value deleted and
//     admin_notes: `${stamp}: special $${specialPrice.toFixed(2)}/mo for ...`
// put back. RED, as it must be -- 6 pass, 5 fail:
//   not ok 2 - THE DEFECT -- the live owner note survives a special, with the new line after it
//     the existing note was lost. admin_notes is now:
//     2026-10-25: special $50.00/mo for 1 month, then back to $199.00.
//   not ok 3 - an r17 audit trail of several lines survives whole, in order
//   not ok 4 - two specials accumulate -- it appends every time, it does not merely preserve once
//   not ok 5 - a note written while the Stripe calls are in flight is not clobbered
//   not ok 11 - the code never assigns admin_notes from the stamp alone
//
// CANARY 2 -- a HALF fix, and the reason test 5 exists. The prior note read
// from the company row fetched at the top of the handler
// (`select("name, stripe_subscription_id, admin_notes")`) instead of
// immediately before the write, so it is stale across the three Stripe
// round-trips. On the first run of this canary EVERY test passed -- including
// test 4, which cannot see it, because each request re-reads the row. Test 5
// was written for it and then the canary was red -- 10 pass, 1 fail:
//   not ok 5 - a note written while the Stripe calls are in flight is not clobbered
//     a note written during the Stripe calls was overwritten by a stale read.
//     admin_notes is now:
//     Owner company. Permanent access.
//     2026-10-25: special $50.00/mo for 1 month, then back to $199.00.
