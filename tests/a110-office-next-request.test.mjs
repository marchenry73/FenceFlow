// WHAT THE OFFICE ASKS FOR NEXT MUST BE WHAT THE PHONE ASKS FOR NEXT.
//
// The quote email's Pay here button bills nextRequestAmount. The phone takes
// that figure from JobMoney; the office now has its own transcription, because
// the office had no notion of "what do I ask for next" before anything in it
// asked for money. A transcription is a copy, and a copy goes stale in
// silence -- so this runs the REAL office functions, lifted out of
// dashboard.html, against the rule as JobMoney.kt states it, over the shapes
// of job that actually differ.
//
// The deposit-first rule is the part that matters and the part a careless
// simplification would drop: while any of the deposit is outstanding the
// customer is asked for the REST OF THE DEPOSIT, not the whole balance. Ask
// for the balance instead and a customer who has paid nothing is billed the
// entire job before a post is in the ground.
//
// Run:  node tests/a110-office-next-request.test.mjs
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const dashboardSrc = readFileSync("website/dashboard.html", "utf8");
const grabFn = (src, name) => {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("not found: " + name);
  let i = src.indexOf("{", start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
};

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
};

// The office's own code, run for real -- not a paraphrase of it.
const office = new Function(
  [
    grabFn(dashboardSrc, "netPaid"),
    // stillOwed delegates to balanceOf, so the real dependency comes too:
    // lifting a paraphrase of it would be testing this file, not the office.
    grabFn(dashboardSrc, "balanceOf"),
    grabFn(dashboardSrc, "stillOwed"),
    grabFn(dashboardSrc, "depositAskedOf"),
    grabFn(dashboardSrc, "depositStillDueOf"),
    grabFn(dashboardSrc, "nextRequestAmountOf"),
    grabFn(dashboardSrc, "nextRequestLabelOf"),
    "return { netPaid, stillOwed, depositAskedOf, depositStillDueOf," +
      " nextRequestAmountOf, nextRequestLabelOf };",
  ].join("\n"),
)();

// ---------------------------------------------------------------------------
// THIS FILE COMPARED THE OFFICE AGAINST A FROZEN COPY OF THE APP.
//
// Everything below transcribes JobMoney.kt by hand, and until now this file
// never read JobMoney.kt at all -- it opened dashboard.html and nothing else.
// So the check it performs was "the office agrees with what the app's rule
// said when somebody last typed it out here", which is not the same claim as
// "the office agrees with the app". Change nextRequestAmount on the phone and
// every assertion in this file stays green while the two halves diverge.
//
// That matters here more than almost anywhere: nextRequestAmountOf is the
// figure offerCardCharge() bills to a customer's saved card, and
// nextRequestLabelOf is the word the customer sees on the charge. The rule
// also moved once already, on 2 Oct 2026 -- the phone offered to bill
// $4,154.47 while the customer's own page asked for $2,500.00, both
// deliberate and both tested at the time.
//
// Its four siblings all guard against this (a4-deposit, a47-deposit-truth,
// a66-deposit-one-meaning, downstream-deposit-balance each fingerprint
// JobMoney.kt); this file was the one that did not. The fingerprint is the
// same convention and the same CR-stripped hash, so a Kotlin change fails
// here loudly and asks for a re-read instead of passing quietly.
//
// Before setting it, all six transcribed helpers below were re-read against
// the live Kotlin function by function -- netPaid, stillOwed, depositAsked,
// depositStillDue, nextRequestAmount, nextRequestLabel, and cents against
// EstimateEngine.roundToCents. They match, so what is pinned is a correct
// copy and not a stale one made permanent.
// ---------------------------------------------------------------------------
const JOB_MONEY_FINGERPRINT = "43f6fa9bc04acede";
const jobMoneyNow = createHash("sha256")
  .update(readFileSync("app/src/main/java/com/fenceestimator/app/estimate/JobMoney.kt", "utf8")
    .split(String.fromCharCode(13)).join(""))
  .digest("hex").slice(0, 16);
ok(
  "JobMoney.kt is the version this file was transcribed from",
  jobMoneyNow === JOB_MONEY_FINGERPRINT,
  "JobMoney.kt changed (" + jobMoneyNow + "). Re-read it against the transcription below -- "
    + "especially nextRequestAmount and nextRequestLabel, which decide what a saved card is "
    + "charged and what the customer is told it is for -- then update JOB_MONEY_FINGERPRINT."
);

// JobMoney.kt's rule, written out independently of the office's wording.
const cents = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
const ktNetPaid = (j) => Math.max(0, (Number(j.amount_paid) || 0) - (Number(j.refunded_amount) || 0));
const ktStillOwed = (j, total) => Math.max(0, total - ktNetPaid(j));
const ktDepositAsked = (j, billable) => {
  const requested = Math.max(0, Number(j.deposit_amount) || 0);
  return billable > 0 ? Math.min(requested, billable) : requested;
};
const ktDepositStillDue = (j, billable) => cents(Math.max(0, ktDepositAsked(j, billable) - ktNetPaid(j)));
const ktNextRequestAmount = (j, total) => {
  const owed = ktStillOwed(j, total);
  if (owed <= 0.005) return 0;
  const depositLeft = ktDepositStillDue(j, total);
  if (depositLeft > 0.005) return Math.min(depositLeft, owed);
  return owed;
};
const ktNextRequestLabel = (j, total) => (ktDepositStillDue(j, total) > 0.005 ? "deposit" : "balance");

// The shapes of job that make these rules differ from one another.
const CASES = [
  ["nothing paid, deposit set", { amount_paid: 0, refunded_amount: 0, deposit_amount: 1000 }, 5000],
  ["deposit part paid", { amount_paid: 400, refunded_amount: 0, deposit_amount: 1000 }, 5000],
  ["deposit paid exactly", { amount_paid: 1000, refunded_amount: 0, deposit_amount: 1000 }, 5000],
  ["deposit paid, balance left", { amount_paid: 1000, refunded_amount: 0, deposit_amount: 1000 }, 8000],
  ["paid in full", { amount_paid: 5000, refunded_amount: 0, deposit_amount: 1000 }, 5000],
  ["overpaid", { amount_paid: 5400, refunded_amount: 0, deposit_amount: 1000 }, 5000],
  ["paid then refunded", { amount_paid: 2000, refunded_amount: 2000, deposit_amount: 1000 }, 5000],
  ["refund exceeds paid", { amount_paid: 500, refunded_amount: 900, deposit_amount: 1000 }, 5000],
  ["no deposit set", { amount_paid: 0, refunded_amount: 0, deposit_amount: 0 }, 5000],
  ["deposit larger than the job", { amount_paid: 0, refunded_amount: 0, deposit_amount: 9000 }, 5000],
  // The cents case the rounding exists for: 2,119.99 less 500.01.
  ["cents that do not subtract cleanly", { amount_paid: 500.01, refunded_amount: 0, deposit_amount: 2119.99 }, 5000],
  ["a few cents left on the deposit", { amount_paid: 999.99, refunded_amount: 0, deposit_amount: 1000 }, 5000],
];

console.log("\n1. The office asks for the same amount as the app, on every shape of job:");
for (const [label, job, total] of CASES) {
  const got = office.nextRequestAmountOf(job, total);
  const want = ktNextRequestAmount(job, total);
  ok(`${label}: amount agrees ($${got} vs $${want})`, Math.abs(got - want) < 0.000001,
    `office ${got}, app ${want}`);
  const gotLabel = office.nextRequestLabelOf(job, total);
  const wantLabel = ktNextRequestLabel(job, total);
  ok(`${label}: and calls it the same thing (${gotLabel})`, gotLabel === wantLabel,
    `office ${gotLabel}, app ${wantLabel}`);
}

console.log("\n2. The deposit-first rule is real, not an accident of these numbers:");
{
  // Nothing paid on a $5,000 job with a $1,000 deposit: the customer is asked
  // for the deposit, NOT the whole job.
  const job = { amount_paid: 0, refunded_amount: 0, deposit_amount: 1000 };
  ok("an unpaid job asks for the deposit, not the balance",
    office.nextRequestAmountOf(job, 5000) === 1000,
    `asked ${office.nextRequestAmountOf(job, 5000)}`);
  ok("PLANTED FAILURE: billing the balance instead would ask for $5000, five times the deposit",
    ktStillOwed(job, 5000) === 5000 && ktStillOwed(job, 5000) !== 1000);
}

console.log("\n3. Nothing is ever asked for when nothing is owed:");
for (const [label, job, total] of [
  ["paid in full", { amount_paid: 5000, refunded_amount: 0, deposit_amount: 1000 }, 5000],
  ["overpaid", { amount_paid: 5400, refunded_amount: 0, deposit_amount: 1000 }, 5000],
]) {
  ok(`${label}: asks for nothing`, office.nextRequestAmountOf(job, total) === 0);
}

console.log("\n4. Canary -- a transcription that drops the cents rounding is caught:");
{
  const job = { amount_paid: 500.01, refunded_amount: 0, deposit_amount: 2119.99 };
  const unrounded = Math.max(0, ktDepositAsked(job, 5000) - ktNetPaid(job));
  ok("THE CANARY FIRES: the unrounded subtraction really is not cents-exact",
    unrounded !== cents(unrounded), `unrounded ${unrounded}`);
  ok("and the office's figure IS cents-exact",
    office.depositStillDueOf(job, 5000) === cents(unrounded));
}

console.log(`\n${pass} of ${pass + fail} checks passed`);
if (fail) process.exit(1);
