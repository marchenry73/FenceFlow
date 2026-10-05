// a101: A COMPANY MUST NEVER END UP PAYING TWO SUBSCRIPTIONS.
//
// create-checkout-session used to decide like this:
//
//   if (company.stripe_subscription_id &&
//       ["active","trialing"].includes(company.subscription_status))
//        ... change the price on the existing subscription
//   ... otherwise fall through and open a NEW Stripe Checkout
//
// with a comment above it correctly warning that sending a live subscriber
// through checkout again "would quietly stack a second monthly charge next to
// the first". It then did exactly that, two ways:
//
//  1. A past_due subscription is still LIVE -- Stripe is retrying the card --
//     and past_due is not in that whitelist, so it fell through.
//
//  2. Wider, and worse. `stripe_subscription_id` is written in exactly ONE
//     place in the codebase: stripe-webhook on checkout.session.completed.
//     `stripe_customer_id` is written by this function BEFORE checkout. So
//     between a customer paying and the webhook landing, the row has a
//     customer and no subscription id -- and a guard that opens with "if the
//     row has a subscription id" skips entirely. Double-clicking the plan
//     button is enough.
//
// The fix asks STRIPE, by customer, and defaults to refusing. This file drives
// the judgement through every status Stripe has, plus one it does not, with no
// network and no Deno.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_PATH = join(ROOT, "supabase/functions/create-checkout-session/index.ts");
const SRC = readFileSync(SRC_PATH, "utf8");

// The module is a Deno edge function: it calls Deno.serve at import time and
// imports the Supabase client from a URL node cannot resolve. So the pure part
// is lifted out by text -- the same technique tests/card-fee.test.mjs already
// uses on priceWithCardFee in this very file -- and compiled on its own.
async function loadDecider() {
  const start = SRC.indexOf("const FINISHED = new Set(");
  assert.ok(start > 0, "FINISHED set is gone -- has the guard been rewritten?");
  const fnAt = SRC.indexOf("export function decideSubscriptionAction(");
  assert.ok(fnAt > 0, "decideSubscriptionAction is gone");
  const end = SRC.indexOf("/** Monthly price in cents", fnAt);
  assert.ok(end > fnAt, "could not find the end of the decision function");

  const sets = SRC.slice(start, SRC.indexOf("\n\n", start));
  // The slice starts at the function, so the SubAction type declared above it
  // is already excluded -- it is a compile-time thing with nothing to run.
  let body = sets + "\n" + SRC.slice(fnAt, end);
  // The only TypeScript left inside the function is its parameter's inline
  // type. Replace the whole signature rather than picking the field
  // annotations off one at a time: a stray `: string` survivor leaves a module
  // that imports as "Unexpected token ':'", which reads like the test being
  // broken rather than the lift.
  body = body
    .replace(/\/\/ deno-lint-ignore[^\n]*\n/g, "")
    .replace(/\(input: \{[\s\S]*?\n\}\): SubAction \{/, "(input) {");
  assert.ok(!/: SubAction|: any\[\]|: string|: boolean/.test(body),
    "type annotations survived the lift, so the module will not import");

  const dir = mkdtempSync(join(tmpdir(), "ccs-"));
  const file = join(dir, "decide.mjs");
  writeFileSync(file, body, "utf8");
  return (await import(pathToFileURL(file).href)).decideSubscriptionAction;
}

const sub = (status, id = "sub_1", priceId = "price_other", base) => ({
  id,
  status,
  items: { data: [{ id: "si_1", price: base ? { id: priceId, metadata: { base_price: base } } : { id: priceId, metadata: {} } }] },
});

const ASK = {
  storedSubId: "sub_1",
  customerGone: false,
  priceId: "price_pro",
  passCardFee: false,
};

let decide;
test("lift the decision out of the edge function", async () => {
  decide = await loadDecider();
  assert.equal(typeof decide, "function");
});

// ---------------------------------------------------------------------------
// The bug in the title.
// ---------------------------------------------------------------------------

test("past_due REFUSES and creates nothing", async () => {
  const a = decide({ ...ASK, live: [sub("past_due")] });
  assert.equal(a.kind, "refuse");
  assert.equal(a.status, 409);
  assert.match(a.error, /did not go through/);
});

test("unpaid REFUSES too -- still live, still billable", async () => {
  assert.equal(decide({ ...ASK, live: [sub("unpaid")] }).kind, "refuse");
});

test("incomplete REFUSES, because its first payment can still succeed", async () => {
  // The subtle one. An `incomplete` subscription looks dead and is not: open a
  // checkout beside it, let the original card finally clear, and the company
  // pays twice from the same afternoon.
  assert.equal(decide({ ...ASK, live: [sub("incomplete")] }).kind, "refuse");
});

test("a status nobody has heard of REFUSES rather than billing twice", async () => {
  // The whole point of defaulting to refusal. Stripe adds statuses.
  const a = decide({ ...ASK, live: [sub("something_stripe_added_in_2027")] });
  assert.equal(a.kind, "refuse");
  assert.equal(a.status, 409);
});

test("paused REFUSES", async () => {
  assert.equal(decide({ ...ASK, live: [sub("paused")] }).kind, "refuse");
});

// ---------------------------------------------------------------------------
// The wider hole: the webhook-lag window.
// ---------------------------------------------------------------------------

test("a live subscription with NO id on the row is still found and swapped", async () => {
  // The row has a customer and no subscription id, because the webhook has not
  // landed. The old guard skipped entirely here and opened a second checkout.
  const a = decide({ ...ASK, storedSubId: null, live: [sub("active", "sub_new")] });
  assert.equal(a.kind, "swap");
  assert.equal(a.subscriptionId, "sub_new");
  assert.equal(a.repairPointer, true, "the row's pointer should be repaired to what Stripe says");
});

test("two open subscriptions REFUSE -- it has already happened, say so", async () => {
  const a = decide({ ...ASK, live: [sub("active", "sub_1"), sub("past_due", "sub_2")] });
  assert.equal(a.kind, "refuse");
  assert.match(a.error, /more than one open subscription/);
});

// ---------------------------------------------------------------------------
// What must keep working.
// ---------------------------------------------------------------------------

test("active swaps in place, as it always did", async () => {
  const a = decide({ ...ASK, live: [sub("active")] });
  assert.equal(a.kind, "swap");
  assert.equal(a.itemId, "si_1");
  assert.equal(a.repairPointer, false, "the pointer already agrees, so leave it alone");
});

test("trialing swaps in place", async () => {
  assert.equal(decide({ ...ASK, live: [sub("trialing")] }).kind, "swap");
});

test("already on the plan does nothing -- no proration, no minted Price", async () => {
  const a = decide({ ...ASK, live: [sub("active", "sub_1", "price_pro")] });
  assert.equal(a.kind, "unchanged");
});

test("with the card-fee switch on, 'already on it' is judged by the BASE price", async () => {
  // The billed price is a generated object, so comparing its id would never
  // match and every click would mint another Price.
  const a = decide({
    ...ASK, passCardFee: true,
    live: [sub("active", "sub_1", "price_generated_123", "price_pro")],
  });
  assert.equal(a.kind, "unchanged");
});

test("a cancelled company resubscribes, and is NOT given a second free trial", async () => {
  const a = decide({ ...ASK, live: [sub("canceled")] });
  assert.equal(a.kind, "checkout");
  assert.equal(a.trial, false, "the trial sells the product, not repeated free months");
});

test("incomplete_expired counts as finished, so they may subscribe again", async () => {
  const a = decide({ ...ASK, live: [sub("incomplete_expired")] });
  assert.equal(a.kind, "checkout");
});

test("POSITIVE CONTROL: a first-timer reaches checkout WITH the trial", async () => {
  // Without this, a decider that refused everything would pass every test
  // above and nobody could ever sign up.
  const a = decide({ live: [], storedSubId: null, customerGone: false, priceId: "price_pro", passCardFee: false });
  assert.equal(a.kind, "checkout");
  assert.equal(a.trial, true);
});

test("a dead customer pointer does not hand out a fresh trial", async () => {
  // customerGone means Stripe said "no such customer", so its silence about
  // subscriptions is an accident of a bad pointer. The stored id is then the
  // only testimony that they have subscribed before, and it is believed.
  const a = decide({ ...ASK, live: [], customerGone: true });
  assert.equal(a.kind, "checkout");
  assert.equal(a.trial, false);
});

// ---------------------------------------------------------------------------
// Properties of the surrounding code that the pure function cannot express.
// ---------------------------------------------------------------------------

test("a Stripe failure that is not 'no such object' is never swallowed", async () => {
  // Falling through to checkout on a 429 or a 500 would create a second
  // subscription because Stripe was briefly busy.
  assert.match(SRC, /class StripeError/, "the typed error is gone");
  assert.match(SRC, /get missing\(\)/, "nothing distinguishes 'missing' from 'broken'");
  assert.match(SRC, /if \(!\(e instanceof StripeError && e\.missing\)\) throw e;/,
    "the stored-id lookup should rethrow anything that is not a missing object");
});

test("a non-JSON Stripe response is reported as Stripe, not as a bad request", async () => {
  assert.match(SRC, /const text = await res\.text\(\)/,
    "res.json() on a gateway's HTML error page throws a SyntaxError");
});

test("the fee Price is created lazily, so a refusal mints nothing", async () => {
  const fnAt = SRC.indexOf("async function billedPrice()");
  const decideAt = SRC.indexOf("decideSubscriptionAction({");
  assert.ok(fnAt > 0 && decideAt > 0);
  assert.match(SRC, /await billedPrice\(\)/, "the price should be resolved on use");
  assert.ok(!/const raised = await stripe\("POST", "\/prices"[\s\S]{0,200}?billedPriceId = raised\.id;\n\s*\}\n\n\s*\/\/ A live subscription/.test(SRC),
    "the Price POST should no longer run before the decision");
});

test("the stale subscription id is NOT cleared", async () => {
  // Clearing it looks like tidy-up and is a repeat-free-trial bug: the next
  // click reads a row that looks first-time.
  assert.ok(!/stripe_subscription_id:\s*null/.test(SRC),
    "clearing the id hands the company another 14-day trial on its next click");
});
