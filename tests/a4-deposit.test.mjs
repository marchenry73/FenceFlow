// tests/a4-deposit.test.mjs
//
// Owner's list, item A4 ("Audit every money calculation in the app and the
// office and prove it charges the right price") -- DEPOSITS domain only:
//   - app/src/main/java/com/fenceestimator/app/estimate/JobMoney.kt
//   - supabase/functions/_shared/quote-deposit.ts
//   - the deposit_follows_price database trigger
//     (supabase_r8_deposit_follows_price.sql)
//
// READ-ONLY throughout. No source file was edited. Nothing here writes to
// the live database -- this file only imports and calls the real exported
// functions in quote-deposit.ts, and hand-transcribes the SQL trigger (it
// is plpgsql; there is no JS/TS module to import, and this audit's hard
// rules forbid writing to the live database even inside a transaction meant
// to be rolled back, which is how this repo's other live-database tests,
// e.g. tests/live-rules-guard.test.mjs, normally prove a trigger).
//
// The live database WAS read (SELECT only, via
// `npx supabase db query --linked --project-ref newcrgafcptspmapacrx`,
// 2026-09-28) to ground this file in fact rather than assumption:
//
//   1. `select prosrc from pg_proc where proname in
//      ('deposit_follows_price','touch_updated_at','job_money_columns')`
//      -- confirmed the deployed function bodies are byte-identical to the
//      CREATE OR REPLACE FUNCTION bodies in supabase_r8_deposit_follows_price.sql
//      (fingerprinted below) and to what supabase_r8's own header describes
//      for touch_updated_at's quiet list and job_money_columns().
//   2. `select tgname, tgtype from pg_trigger where tgrelid =
//      'public.jobs'::regclass ...` -- confirmed zz_deposit_follows_price
//      still sorts after every other BEFORE UPDATE ROW trigger on jobs,
//      including jobs_touch_updated_at, exactly as supabase_r8's header and
//      its own PART 3 claim.
//   3. Searched for a real (non-"ZZ TEST") job with deposit_amount above its
//      contract_total, and separately above its accepted_total: zero rows
//      either way. The historical $3,963-on-a-$3,620-job shape does not
//      currently exist among real jobs, and the cap-on-the-way-in trigger
//      plus the readers' own caps (depositFigures().asked, JobMoney's
//      depositOverContract flag) are jointly holding that line.
//   4. Read the one real row quoted in the finding below.
//
// Run with: node --test tests/a4-deposit.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { billableTotal, depositFigures } from "../supabase/functions/_shared/quote-deposit.ts";

// ============================================================================
// Part 1 -- a faithful transcription of deposit_follows_price(), pinned to
// the file it was read from so a later edit to the trigger cannot leave this
// file quietly checking a rule that no longer exists.
// ============================================================================

const TRIGGER_FINGERPRINT = "7c5070c79bcbbad4";
const triggerSrcNow = createHash("sha256")
  .update(readFileSync("supabase_r8_deposit_follows_price.sql", "utf8").split(String.fromCharCode(13)).join(""))
  .digest("hex").slice(0, 16);

test("supabase_r8_deposit_follows_price.sql is the version this file was transcribed from", () => {
  assert.equal(triggerSrcNow, TRIGGER_FINGERPRINT,
    "the trigger file changed -- re-read it against the transcription below, then move the pin");
});

/**
 * deposit_follows_price(), transcribed line for line from the live function
 * body (select prosrc from pg_proc where proname = 'deposit_follows_price',
 * read 2026-09-28 against project newcrgafcptspmapacrx -- confirmed
 * byte-identical to the CREATE OR REPLACE FUNCTION body in the .sql file
 * fingerprinted above).
 *
 * `old` is the row before the UPDATE (snake_case, as Postgres holds it).
 * `patch` is only the columns the UPDATE's SET clause actually touches --
 * Postgres' NEW.<col> is the patched value for a touched column and OLD's
 * value for an untouched one, which `field()` reproduces. Returns the
 * deposit_amount the row would hold after the trigger runs.
 */
function field(patch, old, name) {
  return Object.prototype.hasOwnProperty.call(patch, name) ? patch[name] : old[name];
}

function triggerNewDeposit(old, patch) {
  const oldTotal = Number(old.contract_total) || 0;
  const newTotal = Number(field(patch, old, "contract_total")) || 0;
  const oldDep = Number(old.deposit_amount) || 0;
  const newDepIn = Number(field(patch, old, "deposit_amount")) || 0;
  const netPaid = Math.max(0, (Number(old.amount_paid) || 0) - (Number(old.refunded_amount) || 0));
  const customerIsInIt =
    ((old.quote_approved_at != null || old.signed_at != null) && old.reapproval_required_at == null)
    || netPaid > 0.005;

  if (oldTotal <= 0.005 || oldDep <= 0.005) return newDepIn;     // nothing to scale from, or to
  if (Math.abs(newTotal - oldTotal) <= 0.005) return newDepIn;   // the price did not move
  if (Math.abs(newDepIn - oldDep) > 0.005) return newDepIn;      // typed in this same statement: it wins
  if (customerIsInIt) return newDepIn;                            // frozen
  if (newTotal <= 0.005) return newDepIn;                         // priced back to nothing

  const scaled = Math.round((oldDep / oldTotal) * newTotal * 100) / 100;
  return Math.min(scaled, newTotal); // never above the new price
}

/** DepositInput shape (camelCase) from a DB row (snake_case), the way every
 * real caller (quote-view, create-payment-link) builds it. `contractTotal`
 * can be overridden to simulate a later re-price without a second row. */
function asInput(row, contractTotal) {
  return {
    depositAmount: row.deposit_amount,
    contractTotal: contractTotal === undefined ? row.contract_total : contractTotal,
    amountPaid: row.amount_paid,
    refundedAmount: row.refunded_amount,
    acceptedTotal: row.accepted_total,
    signedAt: row.signed_at,
    quoteApprovedAt: row.quote_approved_at,
    reapprovalRequiredAt: row.reapproval_required_at,
  };
}

// ============================================================================
// Part 2 -- the transcription is held to the NINE cases
// supabase_r8_deposit_follows_price.sql's own PART 4 already commits to in
// writing (a temp-table probe run against the real function, doubling every
// row's price from 10000 to 20000 except row 9, which is priced down to
// 5000). If the transcription disagreed with the file it was copied from,
// everything below it would be proving something about the wrong function.
// ============================================================================

test("probe 1: a plain draft follows the price", () => {
  const old = { contract_total: 10000, deposit_amount: 2000, amount_paid: 0, refunded_amount: 0,
    quote_approved_at: null, signed_at: null, reapproval_required_at: null };
  assert.equal(triggerNewDeposit(old, { contract_total: 20000 }), 4000);
});

test("probe 2: an approved job is frozen", () => {
  const old = { contract_total: 10000, deposit_amount: 2000, amount_paid: 0, refunded_amount: 0,
    quote_approved_at: "2026-01-01T00:00:00Z", signed_at: null, reapproval_required_at: null };
  assert.equal(triggerNewDeposit(old, { contract_total: 20000 }), 2000);
});

test("probe 3: a signed job is frozen", () => {
  const old = { contract_total: 10000, deposit_amount: 2000, amount_paid: 0, refunded_amount: 0,
    quote_approved_at: null, signed_at: "2026-01-01T00:00:00Z", reapproval_required_at: null };
  assert.equal(triggerNewDeposit(old, { contract_total: 20000 }), 2000);
});

test("probe 4: a withdrawn approval follows again", () => {
  const old = { contract_total: 10000, deposit_amount: 2000, amount_paid: 0, refunded_amount: 0,
    quote_approved_at: "2026-01-01T00:00:00Z", signed_at: null, reapproval_required_at: "2026-01-02T00:00:00Z" };
  assert.equal(triggerNewDeposit(old, { contract_total: 20000 }), 4000);
});

test("probe 5: money paid freezes it even without an approval", () => {
  const old = { contract_total: 10000, deposit_amount: 2000, amount_paid: 250, refunded_amount: 0,
    quote_approved_at: null, signed_at: null, reapproval_required_at: null };
  assert.equal(triggerNewDeposit(old, { contract_total: 20000 }), 2000);
});

test("probe 6: money fully refunded does not freeze it", () => {
  // The .sql PART 4 sets refunded_amount = 250 on this row BEFORE the reprice
  // statement, so OLD already carries the full refund when the trigger runs.
  const old = { contract_total: 10000, deposit_amount: 2000, amount_paid: 250, refunded_amount: 250,
    quote_approved_at: null, signed_at: null, reapproval_required_at: null };
  assert.equal(triggerNewDeposit(old, { contract_total: 20000 }), 4000);
});

test("probe 7: no deposit set stays no deposit", () => {
  const old = { contract_total: 10000, deposit_amount: 0, amount_paid: 0, refunded_amount: 0,
    quote_approved_at: null, signed_at: null, reapproval_required_at: null };
  assert.equal(triggerNewDeposit(old, { contract_total: 20000 }), 0);
});

test("probe 8: a deposit typed in the same statement is not re-scaled", () => {
  const old = { contract_total: 10000, deposit_amount: 2000, amount_paid: 0, refunded_amount: 0,
    quote_approved_at: null, signed_at: null, reapproval_required_at: null };
  assert.equal(triggerNewDeposit(old, { contract_total: 20000, deposit_amount: 3500 }), 3500);
});

test("probe 9: the scaled deposit is capped at the new price, even a falling one", () => {
  // A deposit already above its own price (this has happened for real: a
  // $3,963 deposit on a $3,620 job), and the price falls further.
  const old = { contract_total: 10000, deposit_amount: 12000, amount_paid: 0, refunded_amount: 0,
    quote_approved_at: null, signed_at: null, reapproval_required_at: null };
  assert.equal(triggerNewDeposit(old, { contract_total: 5000 }), 5000);
});

test("CANARY: a transcription that always scales (ignores customer_is_in_it) disagrees on the frozen cases", () => {
  // Proves the nine checks above can actually fail, rather than passing
  // whichever rule ran.
  function brokenAlwaysScales(old, patch) {
    const oldTotal = Number(old.contract_total) || 0;
    const newTotal = Number(field(patch, old, "contract_total")) || 0;
    const oldDep = Number(old.deposit_amount) || 0;
    if (oldTotal <= 0.005 || oldDep <= 0.005) return oldDep;
    return Math.min(Math.round((oldDep / oldTotal) * newTotal * 100) / 100, newTotal);
  }
  const approved = { contract_total: 10000, deposit_amount: 2000, amount_paid: 0, refunded_amount: 0,
    quote_approved_at: "2026-01-01T00:00:00Z", signed_at: null, reapproval_required_at: null };
  const real = triggerNewDeposit(approved, { contract_total: 20000 });
  const broken = brokenAlwaysScales(approved, { contract_total: 20000 });
  assert.equal(real, 2000);
  assert.equal(broken, 4000);
  assert.notEqual(real, broken, "PLANTED FAILURE: proves the frozen-vs-follows comparison has teeth");
});

// ============================================================================
// Part 3 -- THE FINDING.
//
// deposit_follows_price's customer_is_in_it treats a job as having a FIXED
// price the instant quote_approved_at or signed_at is set (and no
// reapproval is pending) -- full stop. But the figure everything actually
// BILLS against -- JobMoney.anchoredTotal/billableTotal in the app, and its
// server-side copy billableTotal() in quote-deposit.ts, imported for real
// above -- only calls the price fixed once accepted_total is ALSO recorded
// and positive ("input.acceptedTotal == null || accepted <= 0.005 || ...
// return live"). A job that is approved or signed but never had
// accepted_total stamped is, by the app's OWN rule, exactly as unanchored as
// a quote nobody has looked at: its bill is still the live, moving
// contract_total (and price-job's jobPatch writes contract_total
// unconditionally on every reprice, accepted or not -- supabase/functions/
// price-job/index.ts). The trigger does not know that; it freezes the
// deposit anyway, on a premise the app's own function says is false.
//
// This precondition is not invented for this test. Read-only against the
// live database, 2026-09-28, project newcrgafcptspmapacrx:
//
//   select id, customer_name, contract_total, deposit_amount, accepted_total,
//          quote_approved_at, signed_at, reapproval_required_at,
//          amount_paid, refunded_amount
//   from public.jobs where id = 'dadfc07b-fe88-43f8-8a21-1c152f630d4e';
//
// customer_name reads "ZZ TEST Approved, no deposit" -- a deliberate fixture
// for another suite, not an organic customer row (a matching search found
// ZERO real, non-"ZZ TEST" jobs in this exact state: approved or signed,
// reapproval not pending, accepted_total null). So nothing is known to be
// mis-billing a real customer today. What is real is the code: the
// precondition is the documented, previously-true "every job accepted
// before the accepted_total column existed" case (JobMoney.kt,
// quote-deposit.ts headers), and nothing stops a future write path -- a bulk
// approval, an admin correction, a data migration -- from producing it
// again. A drawn signature has a database-level backstop for this
// (stamp_accepted_total's signed_at branch stamps accepted_total even if the
// app forgets); an online approval has none in the database -- only
// quote-view's own JS, which happens to write accepted_total in the same
// UPDATE as quote_approved_at today.
// ============================================================================

const LIVE_ROW = Object.freeze({
  contract_total: 8600,
  deposit_amount: 1720,
  accepted_total: null,
  amount_paid: 0,
  refunded_amount: 0,
  signed_at: null,
  quote_approved_at: "2026-08-30T20:37:52.466Z",
  reapproval_required_at: null,
});

test("FINDING 1: billableTotal (the real function every biller calls) says this job's price is still live", () => {
  assert.equal(billableTotal(asInput(LIVE_ROW)), 8600);
  // And it moves with a later reprice -- proving 8600 is the live figure,
  // not a coincidentally-matching frozen one.
  assert.equal(billableTotal(asInput(LIVE_ROW, 10320)), 10320);
});

test("FINDING 2: the deposit trigger freezes this job's deposit anyway", () => {
  const after = triggerNewDeposit(LIVE_ROW, { contract_total: 10320 });
  assert.equal(after, 1720, "unchanged -- customer_is_in_it read true from quote_approved_at alone");
});

test("FINDING 3: arithmetic -- what was approved vs. what the two real payment functions would collect", () => {
  // The customer approved $8,600 (the only figure billableTotal can produce
  // for this row -- FINDING 1). The office then reprices the job (ordinary:
  // a catalog update, a corrected takeoff) to $10,320. Nothing here writes
  // to the database; this calls the real depositFigures() -- the exact
  // function quote-view and create-payment-link both call -- on the job's
  // real starting numbers plus that one hypothetical reprice.
  const repriced = { ...LIVE_ROW, contract_total: 10320 };

  // 1) The deposit link shown/charged first.
  const beforePay = depositFigures(asInput(repriced));
  assert.equal(beforePay.total, 10320, "billed against the drifted total, not the $8,600 approved");
  assert.equal(beforePay.due, 1720);

  // 2) Deposit paid. create-payment-link's own "balance" branch next asks
  // for Math.max(0, total - netPaid) -- read directly from
  // supabase/functions/create-payment-link/index.ts.
  const afterDeposit = depositFigures({ ...asInput(repriced), amountPaid: 1720 });
  const finalBalanceRequested = afterDeposit.balance;
  assert.equal(finalBalanceRequested, 8600);

  const totalCollected = 1720 + finalBalanceRequested;
  assert.equal(totalCollected, 10320);
  const excess = totalCollected - LIVE_ROW.contract_total;
  assert.equal(excess, 1720,
    `customer approved $${LIVE_ROW.contract_total}; the deposit link plus the balance link the app's own ` +
    `functions would generate for this job collect $${totalCollected} -- a $${excess} excess the customer ` +
    `never separately approved, and deposit_follows_price gave no signal of it because it only asks whether ` +
    `the customer is "in it", never whether accepted_total says what price they are in FOR.`);
});

test("CANARY 4: a trigger condition that also required accepted_total (matching the app's own rule) would not have frozen this deposit", () => {
  const correctedCustomerIsInIt =
    ((LIVE_ROW.quote_approved_at != null || LIVE_ROW.signed_at != null) && LIVE_ROW.reapproval_required_at == null
      && Number(LIVE_ROW.accepted_total) > 0.005)
    || Math.max(0, LIVE_ROW.amount_paid - LIVE_ROW.refunded_amount) > 0.005;
  const realCustomerIsInIt =
    ((LIVE_ROW.quote_approved_at != null || LIVE_ROW.signed_at != null) && LIVE_ROW.reapproval_required_at == null)
    || Math.max(0, LIVE_ROW.amount_paid - LIVE_ROW.refunded_amount) > 0.005;
  assert.equal(correctedCustomerIsInIt, false, "the app's own anchoring rule says this price was never fixed");
  assert.equal(realCustomerIsInIt, true, "the deployed trigger's rule disagrees -- that disagreement is the finding");
  assert.notEqual(correctedCustomerIsInIt, realCustomerIsInIt);
});

// ============================================================================
// Part 4 -- positive control. The bug above is specific to a job missing
// accepted_total, not a general breakdown: a properly-anchored accepted job
// (the ordinary, currently-universal case among real jobs -- see the header)
// has the trigger and billableTotal agreeing it is frozen, correctly.
// ============================================================================

test("positive control: a properly-anchored accepted job -- trigger and billableTotal agree it is frozen", () => {
  const wellFormed = {
    contract_total: 9710, deposit_amount: 1942, accepted_total: 9710,
    amount_paid: 0, refunded_amount: 0, signed_at: "2026-09-10T12:00:00Z",
    quote_approved_at: null, reapproval_required_at: null,
  };
  assert.equal(triggerNewDeposit(wellFormed, { contract_total: 13410 }), 1942, "the trigger freezes it");
  assert.equal(billableTotal(asInput(wellFormed, 13410)), 9710, "and billableTotal agrees the price really is fixed");
});
