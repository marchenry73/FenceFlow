// a90 -- offerCardCharge: the one place this office takes money from a card
//        without the customer present. Nothing tested it.
//
// WHY THIS EXISTS. A4 on the owner's list asks for every money calculation to
// be audited and proved. Working through it, the shared money CONSTANTS turned
// out to be fully covered (a38/a68 pin the payment limits against quote-view's
// own source, a88 pins overtime, the downstream suites pin deposit and
// balance), so the gap was not arithmetic. It was this: of the office's 49
// money-bearing functions, ten are named by no test, and one of those ten
// charges a saved card.
//
// offerCardCharge() is careful code -- consent gate, permission gate, an
// idempotency key minted per button press, and a deliberate refusal to retry
// after `charge_unrecorded`. Every one of those is a decision somebody could
// remove in a hurry without a single test going red, and each removal costs
// real money or real trust:
//
//   * the consent gate         -> billing a card the customer never agreed to
//   * the permission gate      -> a crew phone's login taking a payment
//   * the amount               -> charging a figure that is not what is owed
//   * the kind                 -> charging the deposit, calling it the balance
//   * charge_unrecorded = true -> the money may already have moved, and the
//                                 caller would fall through and ask AGAIN
//
// This runs the REAL function out of dashboard.html against stubs, rather than
// grepping its source for the guards: a comment that mentions consent and an
// `if` that enforces it are indistinguishable to grep, and this session has
// already produced several checks that read their own prose.
//
//   node tests/a90-charge-a-saved-card.test.mjs      (no network, no writes)
import { readFileSync } from "node:fs";

const dashboardSrc = readFileSync("website/dashboard.html", "utf8");

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? " — " + detail : "")); }
};

/** Grab a function by name, `async` or not, by brace matching. */
function grabFn(src, name) {
  let start = src.indexOf("async function " + name + "(");
  if (start < 0) start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("not found: " + name);
  let depth = 0;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
}

const CHARGE_SRC = grabFn(dashboardSrc, "offerCardCharge");

/**
 * Build a callable offerCardCharge over a stub world, and record everything
 * it tried to do. `mutate` lets a canary damage the real source first.
 */
function build({ perms = ["REQUEST_PAYMENT"], role = "OWNER", confirm = true,
                 response = { ok: true, body: { charged: true } },
                 label = "balance", throwOnFetch = false, mutate = null } = {}) {
  const calls = { fetches: [], asked: 0, messages: [] };
  let src = CHARGE_SRC;
  if (mutate) {
    src = mutate(src);
    if (src === CHARGE_SRC) throw new Error("the canary mutation did not apply");
  }
  const deps = {
    hasPerm: (p) => perms.includes(p),
    profile: { role },
    ask: async () => { calls.asked++; return confirm; },
    tr: (k, ...a) => k + (a.length ? "(" + a.join(",") + ")" : ""),
    money: (v) => "$" + Number(v).toFixed(2),
    cardLabelOf: () => "Visa 4242",
    nextRequestLabelOf: () => label,
    msg: (_id, text, kind) => calls.messages.push({ text, kind }),
    SUPA_URL: "https://stub.invalid",
    db: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } },
    fetch: async (url, init) => {
      calls.fetches.push({ url, body: JSON.parse(init.body) });
      if (throwOnFetch) throw new Error("network down");
      return { ok: response.ok, json: async () => response.body };
    },
    self: { crypto: { randomUUID: () => "11111111-2222-3333-4444-555555555555" } },
  };
  const names = Object.keys(deps);
  const fn = new Function(...names, src + "; return " + "offerCardCharge" + ";")(
    ...names.map((n) => deps[n]));
  return { fn, calls };
}

const CARD = { sync_id: "job-1", card_consent_at: "2026-10-01T00:00:00Z", card_last4: "4242",
               customer_name: "A Customer", address: "1 Road" };

console.log("\n0. The real function was extracted, so every check below runs shipped code:");
ok("offerCardCharge found in dashboard.html", CHARGE_SRC.startsWith("async function offerCardCharge("));
ok("and it is the whole function, not a fragment", CHARGE_SRC.trim().endsWith("}")
  && CHARGE_SRC.includes("create-payment-link"));

console.log("\n1. It refuses without the customer's agreement, and never calls out:");
for (const [why, job] of [
  ["no consent recorded", { ...CARD, card_consent_at: null }],
  ["no card on file", { ...CARD, card_last4: null }],
  ["neither", { ...CARD, card_consent_at: null, card_last4: null }],
]) {
  const { fn, calls } = build();
  const got = await fn(job, 5000, 1000);
  ok(`${why}: returns false`, got === false, `got ${got}`);
  ok(`${why}: and sent no request`, calls.fetches.length === 0,
    `${calls.fetches.length} request(s) went out`);
  ok(`${why}: and did not even ask the operator`, calls.asked === 0);
}

console.log("\n2. It refuses without the permission AND the role:");
for (const [why, opts] of [
  ["no REQUEST_PAYMENT", { perms: [] }],
  ["CREW with the permission", { role: "CREW" }],
  ["SALES with the permission", { role: "SALES" }],
  ["ACCOUNTANT with the permission", { role: "ACCOUNTANT" }],
]) {
  const { fn, calls } = build(opts);
  const got = await fn(CARD, 5000, 1000);
  ok(`${why}: returns false`, got === false, `got ${got}`);
  ok(`${why}: and sent no request`, calls.fetches.length === 0);
}
{
  // The positive control: the same call DOES go out for an owner who may bill.
  // Without this, every check above would pass on a function that refuses
  // everybody -- which is how a money door gets silently welded shut.
  const { fn, calls } = build();
  const got = await fn(CARD, 5000, 1000);
  ok("CONTROL: an OWNER with REQUEST_PAYMENT does charge", got === true, `got ${got}`);
  ok("CONTROL: and exactly one request went out", calls.fetches.length === 1);
}
{
  const { fn, calls } = build({ role: "MANAGER" });
  ok("a MANAGER may also bill", (await fn(CARD, 5000, 1000)) === true);
  ok("and it was one request", calls.fetches.length === 1);
}

console.log("\n3. Declining the confirmation stops it dead:");
{
  const { fn, calls } = build({ confirm: false });
  ok("returns false", (await fn(CARD, 5000, 1000)) === false);
  ok("and nothing was sent", calls.fetches.length === 0);
  ok("but it did ask", calls.asked === 1);
}

console.log("\n4. The amount charged is the amount owed, to the cent:");
for (const owed of [1000, 1234.56, 0.01, 2119.99, 1619.98]) {
  const { fn, calls } = build();
  await fn(CARD, 5000, owed);
  const sent = calls.fetches[0].body.amountCents;
  ok(`$${owed} is sent as ${Math.round(owed * 100)} cents`, sent === Math.round(owed * 100),
    `sent ${sent}`);
}
{
  // Cents, not dollars: a server reading cents and a page sending dollars is a
  // charge 100x too small -- or, the other way, 100x too large.
  const { fn, calls } = build();
  await fn(CARD, 5000, 1000);
  ok("the field is cents and not dollars", calls.fetches[0].body.amountCents === 100000,
    `sent ${calls.fetches[0].body.amountCents}`);
}

console.log("\n5. The word the customer sees matches what is being collected:");
for (const label of ["deposit", "balance"]) {
  const { fn, calls } = build({ label });
  await fn(CARD, 5000, 1000);
  ok(`nextRequestLabelOf '${label}' is sent as kind '${label}'`,
    calls.fetches[0].body.kind === label, `sent ${calls.fetches[0].body.kind}`);
}
{
  // Anything that is not 'balance' must bill as a deposit, never as a third
  // thing the server does not know.
  const { fn, calls } = build({ label: "something-else" });
  await fn(CARD, 5000, 1000);
  ok("an unknown label falls back to 'deposit', not to itself",
    calls.fetches[0].body.kind === "deposit", `sent ${calls.fetches[0].body.kind}`);
}

console.log("\n6. One press is one charge:");
{
  const { fn, calls } = build();
  await fn(CARD, 5000, 1000);
  const id = calls.fetches[0].body.clientChargeId;
  ok("an idempotency key is sent", typeof id === "string" && id.length >= 16, `got ${id}`);
  ok("and the saved card is the one being charged",
    calls.fetches[0].body.chargeSavedCard === true);
  ok("and the job is identified by sync_id",
    calls.fetches[0].body.jobSyncId === "job-1");
}

console.log("\n7. charge_unrecorded must NOT be answered by charging again:");
{
  // The caller treats true as "the money has been asked for" and stops. For
  // this one failure that is the right answer: the charge may have gone
  // through, and the alternative is billing the customer twice.
  const { fn } = build({ response: { ok: false, body: { error: "we could not record it",
                                                        code: "charge_unrecorded" } } });
  ok("returns true, so no second attempt and no letter follows",
    (await fn(CARD, 5000, 1000)) === true);
}
{
  const { fn } = build({ response: { ok: false, body: { error: "card declined",
                                                        code: "card_declined" } } });
  ok("an ordinary decline returns false, so the letter still goes",
    (await fn(CARD, 5000, 1000)) === false);
}
{
  const { fn, calls } = build({ throwOnFetch: true });
  ok("a request that never arrived returns false", (await fn(CARD, 5000, 1000)) === false);
  ok("and it was attempted exactly once", calls.fetches.length === 1);
}
{
  // ok:true with charged missing is NOT a charge. A truthy response body is
  // the easiest thing in the world to mistake for success.
  const { fn } = build({ response: { ok: true, body: {} } });
  ok("a 200 with no `charged` is not treated as paid",
    (await fn(CARD, 5000, 1000)) === false);
}

console.log("\n8. CANARIES -- each guard removed, and the check that catches it:");
{
  // Consent gate deleted.
  const { fn, calls } = build({
    mutate: (s) => s.replace("if (!j.card_consent_at || !j.card_last4) return false;", ""),
  });
  const got = await fn({ ...CARD, card_consent_at: null }, 5000, 1000);
  ok("THE CANARY FIRES: without the consent gate, a card with no agreement IS charged",
    got === true && calls.fetches.length === 1,
    `returned ${got} after ${calls.fetches.length} request(s)`);
}
{
  // Permission gate neutered.
  const { fn, calls } = build({
    role: "CREW",
    mutate: (s) => s.replace("if (!mayBill) return false;", ""),
  });
  await fn(CARD, 5000, 1000);
  ok("THE CANARY FIRES: without the permission gate, CREW reaches the charge",
    calls.fetches.length === 1, `${calls.fetches.length} request(s)`);
}
{
  // Dollars sent where cents are expected.
  const { fn, calls } = build({
    mutate: (s) => s.replace("Math.round(owed * 100)", "owed"),
  });
  await fn(CARD, 5000, 1000);
  ok("THE CANARY FIRES: sending dollars bills 1,000 cents instead of 100,000",
    calls.fetches[0].body.amountCents === 1000, `sent ${calls.fetches[0].body.amountCents}`);
}
{
  // charge_unrecorded treated like any other failure.
  const { fn } = build({
    response: { ok: false, body: { error: "x", code: "charge_unrecorded" } },
    mutate: (s) => s.replace("if (body && body.code === 'charge_unrecorded') return true;", ""),
  });
  ok("THE CANARY FIRES: without that branch the caller would ask the customer again",
    (await fn(CARD, 5000, 1000)) === false);
}

console.log(`\n${pass} of ${pass + fail} checks passed`);
if (fail) process.exit(1);
