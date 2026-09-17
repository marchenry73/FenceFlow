// Card fee pass-through: the fee maths in create-payment-link and the
// refund/dispute share in stripe-webhook, lifted from the real sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function lift(path, name) {
  const src = readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, name + " not found in " + path);
  const end = src.indexOf("\n}\n", start);
  const body = src.slice(start, end + 2)
    .replace(/\(([^)]*)\)\s*:\s*number\s*\{/, "($1) {")
    .replace(/:\s*\{[^}]*\}/g, "")
    .replace(/:\s*number/g, "");
  return new Function(body + "\nreturn " + name + ";")();
}

const cardFeeCents = lift("supabase/functions/create-payment-link/index.ts", "cardFeeCents");
const jobShare = lift("supabase/functions/stripe-webhook/index.ts", "jobShare");

test("fee nets the company the job amount when under the 3% cap", () => {
  // $50.00: gross-up is 180c (3.6%) -> capped at 150c
  assert.equal(cardFeeCents(5000), 150);
  // $100,000.00: gross-up ~2.99% stays under cap and covers Stripe's cut
  const amt = 10_000_000, fee = cardFeeCents(amt);
  assert.ok(fee <= amt * 0.03);
  const stripeTakes = Math.round((amt + fee) * 0.029) + 30;
  assert.ok(amt + fee - stripeTakes >= amt - 1, "company nets the amount");
});

test("fee never exceeds 3% and is zero for nonsense", () => {
  for (const a of [50, 99, 1000, 123456, 5_000_000]) {
    assert.ok(cardFeeCents(a) <= Math.floor(a * 0.03), "cap at " + a);
    assert.ok(cardFeeCents(a) >= 0);
  }
  assert.equal(cardFeeCents(0), 0);
  assert.equal(cardFeeCents(-5), 0);
  assert.equal(cardFeeCents(NaN), 0);
});

test("refund share takes only the job's part off the ledger", () => {
  const row = { amount_cents: 100000, fee_cents: 3000 };
  assert.equal(jobShare(103000, row), 100000);          // full refund
  assert.equal(jobShare(51500, row), 50000);            // half refund
  assert.equal(jobShare(500, { amount_cents: 500, fee_cents: 0 }), 500); // no fee: unchanged
  assert.equal(jobShare(700, {}), 700);                 // old rows: unchanged
  assert.equal(jobShare(999999, row), 100000);          // never more than the job amount
});
