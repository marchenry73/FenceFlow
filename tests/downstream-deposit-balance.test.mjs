// SS36 "Data integrity across every calculation": deposit and balance.
//
// Money is computed twice, deliberately, in two different places that must
// still agree on the *shared* piece of arithmetic:
//   - JobMoney.kt (the app)              -- netPaid / balance / stillOwed /
//                                            nextRequestAmount
//   - dashboard.html (the office)        -- netPaid / balanceOf / stillOwed
//     (its own header comment says "These mirror JobMoney in the app
//      deliberately")
//   - quote-deposit.ts (the office, shared -- quote-view + create-payment-
//     link) -- depositFigures(), the customer-facing "what do you still owe
//     on the deposit" figure
//
// Units: money in this whole cluster is DOLLARS everywhere -- jobs.amount_paid,
// jobs.refunded_amount, jobs.deposit_amount and jobs.contract_total are all
// plain numeric dollar columns (confirmed by reading JobMoney.kt, quote-
// deposit.ts and dashboard.html: none of them multiply by 100 or divide by
// 100 before comparing to MONEY_TOLERANCE=1.0 / MIN_CHARGEABLE=0.5). The one
// place cents show up at all is create-payment-link's own
// `Math.round(dollars * 100)` immediately before calling Stripe, which is
// outside what this file guards.
//
// This file pulls the office's JS functions out of their real source files
// (same technique as tests/office-pricing.test.mjs's `grab`), computes the
// SAME inputs through a hand-transcription of JobMoney's rule, and demands
// they agree -- then plants a wrong version of each rule inline and proves
// the check would have caught it.
//
//   npx tsx tests/downstream-deposit-balance.test.mjs
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

// A hand transcription is a copy, and a copy goes stale in silence. If
// JobMoney.kt changes and nobody revisits the lines below, every check in
// this file keeps passing while it compares the office against an app that
// no longer exists -- the whole point of the test gone, with a green result
// on top of it. So the Kotlin file is fingerprinted. Change it and this
// fails on purpose, telling you to read the transcription again and then
// move the pin. That is an annoyance exactly once per real change, and the
// alternative is a guard that quietly stops guarding.
const JOB_MONEY_FINGERPRINT = "5ea8a174a96dd355";
const jobMoneyNow = createHash("sha256")
  .update(readFileSync("app/src/main/java/com/fenceestimator/app/estimate/JobMoney.kt", "utf8").split(String.fromCharCode(13)).join(""))
  .digest("hex").slice(0, 16);
ok(
  "JobMoney.kt is the version this file was transcribed from",
  jobMoneyNow === JOB_MONEY_FINGERPRINT,
  "JobMoney.kt changed (" + jobMoneyNow + "). Re-read it against the transcription below, then update JOB_MONEY_FINGERPRINT."
);

// -- Kotlin JobMoney, transcribed by hand for comparison (not imported --
// there is no JVM here). Each line below is a direct read of
// app/src/main/java/com/fenceestimator/app/estimate/JobMoney.kt.
const kotlinJobMoney = {
  netPaid: (j) => Math.max(0, j.amount_paid - j.refunded_amount),
  balance: (j, contractTotal) => contractTotal - kotlinJobMoney.netPaid(j),
  stillOwed: (j, contractTotal) => Math.max(0, kotlinJobMoney.balance(j, contractTotal)),
};

function loadOfficeMoney(src) {
  const code = ["netPaid", "balanceOf", "stillOwed"].map((n) => grabFn(src, n)).join("\n\n");
  return new Function(code + "\nreturn {netPaid, balanceOf, stillOwed};")();
}

const cases = [
  { name: "nothing paid", amount_paid: 0, refunded_amount: 0, contractTotal: 5000 },
  { name: "partially paid", amount_paid: 2000, refunded_amount: 0, contractTotal: 5000 },
  { name: "paid in full", amount_paid: 5000, refunded_amount: 0, contractTotal: 5000 },
  { name: "overpaid", amount_paid: 5400, refunded_amount: 0, contractTotal: 5000 },
  { name: "paid then fully refunded", amount_paid: 5000, refunded_amount: 5000, contractTotal: 5000 },
  { name: "paid then partially refunded", amount_paid: 5000, refunded_amount: 1200, contractTotal: 5000 },
  // refunded_amount alone exceeding amount_paid should never happen in
  // practice (both only grow, sync keeps the larger of each) but the
  // coerceAtLeast(0.0)/Math.max(0,...) floor exists specifically so a data
  // glitch here reads as $0 collected, not a negative "collected" figure.
  { name: "refund exceeds paid (data glitch floor)", amount_paid: 100, refunded_amount: 300, contractTotal: 5000 },
];

console.log("\n1. Office (dashboard.html) agrees with the app (JobMoney.kt) on every case:");
const office = loadOfficeMoney(dashboardSrc);
for (const c of cases) {
  const j = { amount_paid: c.amount_paid, refunded_amount: c.refunded_amount };
  const kNet = kotlinJobMoney.netPaid(j);
  const kBal = kotlinJobMoney.balance(j, c.contractTotal);
  const kOwed = kotlinJobMoney.stillOwed(j, c.contractTotal);
  const oNet = office.netPaid(j);
  const oBal = office.balanceOf(j, c.contractTotal);
  const oOwed = office.stillOwed(j, c.contractTotal);
  ok(`${c.name}: netPaid agrees ($${kNet} vs $${oNet})`, kNet === oNet);
  ok(`${c.name}: balance agrees ($${kBal} vs $${oBal})`, kBal === oBal);
  ok(`${c.name}: stillOwed agrees ($${kOwed} vs $${oOwed})`, kOwed === oOwed);
}

// CANARY: plant the office's PRE-FIX bug back (the header comment on
// stillOwed/balance in JobMoney.kt says the screen used to floor balance at
// zero -- "Still owed $0.00" on a $400 overpayment) by re-flooring balanceOf
// at zero here, and prove that now DISAGREES with the real (never-floored)
// Kotlin rule on the overpaid case.
console.log("\n2. Canary: the historical 'balance floored at zero' bug is detectable:");
{
  const brokenBalanceOf = (j, contractTotal) => Math.max(0, contractTotal - office.netPaid(j));
  const overpaid = { amount_paid: 5400, refunded_amount: 0 };
  const realBalance = kotlinJobMoney.balance(overpaid, 5000); // -400
  const brokenBalance = brokenBalanceOf(overpaid, 5000); // 0, the old bug
  ok("PLANTED FAILURE: re-flooring balance at zero silently hides a $400 overpayment " +
     "(proves this comparison can fail)",
    brokenBalance !== realBalance,
    `real=${realBalance} broken=${brokenBalance}`);
  ok("the office's actual balanceOf (unbroken) reports the negative balance, matching the app",
    office.balanceOf(overpaid, 5000) === realBalance,
    `got ${office.balanceOf(overpaid, 5000)}`);
}

// ---------------------------------------------------------------------------
// depositFigures() -- the customer-facing "what's left on the deposit"
// figure quote-view and create-payment-link both call (supabase/functions/
// _shared/quote-deposit.ts). Its own header names the exact bug this guards:
// quote-view used to invent a deposit and never subtract payments already
// made; create-payment-link used the real, capped, payment-aware figure; the
// two disagreed in front of a customer.
console.log("\n3. depositFigures(): asked is capped at the job total, due subtracts net payments:");
const { depositFigures } = await import("../supabase/functions/_shared/quote-deposit.ts");

{
  // Deposit requested ($8,000) bigger than the whole job ($5,000): asked
  // must cap at the job total, not the requested figure -- a deposit can
  // never exceed what the job is worth.
  const f = depositFigures({ depositAmount: 8000, contractTotal: 5000, amountPaid: 0, refundedAmount: 0 });
  ok("a deposit larger than the contract is capped at the contract total",
    f.asked === 5000, `got asked=${f.asked}`);
}
{
  // $1,000 deposit, $400 already paid toward it: due = 600, still payable
  // (>= 50 cents).
  const f = depositFigures({ depositAmount: 1000, contractTotal: 5000, amountPaid: 400, refundedAmount: 0 });
  ok("due subtracts what has already been paid toward the deposit",
    f.asked === 1000 && f.due === 600 && f.payable === true,
    `got ${JSON.stringify(f)}`);
}
{
  // Paid past the deposit already: due floors at zero rather than going
  // negative, and reports not payable (nothing left to charge).
  const f = depositFigures({ depositAmount: 1000, contractTotal: 5000, amountPaid: 1200, refundedAmount: 0 });
  ok("due never goes negative once more than the deposit has been paid",
    f.due === 0 && f.payable === false, `got ${JSON.stringify(f)}`);
}
{
  // Under the 50-cent processor minimum: payable must be false even though
  // due is technically positive.
  const f = depositFigures({ depositAmount: 1000, contractTotal: 5000, amountPaid: 999.7, refundedAmount: 0 });
  ok("a few cents left on the deposit is reported as not payable (below the 50-cent processor floor)",
    Math.abs(f.due - 0.3) < 1e-9 && f.payable === false, `got ${JSON.stringify(f)}`);
}

// CANARY: the bug the module's header describes -- quote-view inventing a
// deposit from material cost with no payment awareness at all. Reproduce
// that shape (ignore amountPaid/refundedAmount entirely) and show it
// disagrees with the real, payment-aware `due` on a partially-paid job.
console.log("\n4. Canary: the historical 'invented deposit, ignores payments' bug is detectable:");
{
  const brokenDue = (input) => Math.max(0, Math.min(input.depositAmount, input.contractTotal)); // no payment subtracted
  const input = { depositAmount: 1000, contractTotal: 5000, amountPaid: 400, refundedAmount: 0 };
  const real = depositFigures(input);
  const broken = brokenDue(input);
  ok("PLANTED FAILURE: ignoring payments already made would ask the customer for the " +
     "full $1,000 again instead of the true $600 remaining (proves this check can fail)",
    broken !== real.due, `broken=${broken} real=${real.due}`);
}

console.log(`\n${pass} of ${pass + fail} checks passed`);
if (fail) process.exit(1);
