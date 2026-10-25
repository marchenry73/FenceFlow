// recordClearedPayment: the status may go UP, and a failed read may not pass
// for an empty ledger.
//
// Two defects, both of which recordRefund -- ninety lines further down the
// same file -- already got right:
//
//  1. payment_status was written "DEPOSIT_PAID" unconditionally, so a job
//     already PAID_IN_FULL that received another cleared payment (the balance
//     link, or a second deposit) was stepped BACKWARDS. The office and the
//     quote page then both told a settled customer they still owed money.
//     The comment defending it said the server "does not have" the contract
//     total -- recordRefund reads exactly that column to build a rank ladder.
//
//  2. The ledger read dropped its error. data comes back null, the reduce
//     makes it 0, and amount_paid: 0 is then written through a mustWrite that
//     SUCCEEDS, with the webhook answering 200 so Stripe never retries. A
//     cleared payment left the job reading nothing paid.
//
// This runs the REAL function against a model client rather than reading its
// source, because both defects are about what it DOES with an answer, which
// no amount of source-matching can see.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordClearedPayment } from "../supabase/functions/_shared/record-payment.ts";

const COMPANY = "c0000000-0000-4000-8000-000000000001";
const JOB = "j0000000-0000-4000-8000-000000000001";

/* The smallest supabase-shaped client these two functions actually use:
   .upsert(), a filtered .select() that is awaited directly, .maybeSingle(),
   and .update().eq(). Every builder is thenable so `await` returns
   {data, error} the way the real one does. */
function fakeAdmin({ ledger = [], job = null, ledgerError = null }) {
  const state = { ledger: [...ledger], job: job && { ...job }, updates: [], upserts: [] };
  const thenable = (value) => ({ then: (res) => res(value) });

  const builderFor = (table) => ({
    upsert(row) { state.upserts.push({ table, row }); return thenable({ error: null }); },
    select() {
      const chain = {
        eq: () => chain,
        is: () => chain,
        maybeSingle: () => thenable({ data: table === "jobs" ? state.job : null, error: null }),
        then: (res) => res(
          table === "payment_records"
            ? { data: ledgerError ? null : state.ledger, error: ledgerError }
            : { data: [], error: null },
        ),
      };
      return chain;
    },
    update(patch) {
      const chain = {
        eq: () => { state.updates.push({ table, patch }); return thenable({ error: null }); },
      };
      return chain;
    },
  });

  return { from: (table) => builderFor(table), state };
}

const live = (over = {}) => ({
  companyId: COMPANY, jobSyncId: JOB, amount: 100, externalId: "pi_1",
  processor: "stripe", liveMode: true, ...over,
});

const jobRow = (over = {}) => ({
  id: "row-1", sync_id: JOB, company_id: COMPANY, customer_name: "Pat",
  deposit_amount: 0, contract_total: 0, refunded_amount: 0, payment_status: "UNPAID", ...over,
});

const statusWritten = (admin) => {
  const u = admin.state.updates.find((x) => x.table === "jobs");
  return u ? u.patch.payment_status : undefined;
};

// --------------------------------------------------------------- the bug ---

test("a settled job is NOT stepped backwards by another cleared payment", async () => {
  // The reported defect: PAID_IN_FULL + a balance payment used to become
  // DEPOSIT_PAID, so a job with nothing owing told the customer it did.
  const admin = fakeAdmin({
    ledger: [{ amount: 500 }, { amount: 500 }],
    job: jobRow({ contract_total: 1000, payment_status: "PAID_IN_FULL" }),
  });
  const out = await recordClearedPayment(admin, live({ amount: 500 }));
  assert.equal(out.recorded, true);
  assert.equal(statusWritten(admin), "PAID_IN_FULL",
    "a payment must never lower the status -- PAID_IN_FULL stays PAID_IN_FULL");
});

test("a payment that covers the contract total RAISES the status", async () => {
  const admin = fakeAdmin({
    ledger: [{ amount: 1000 }],
    job: jobRow({ contract_total: 1000, payment_status: "DEPOSIT_PAID" }),
  });
  await recordClearedPayment(admin, live({ amount: 1000 }));
  assert.equal(statusWritten(admin), "PAID_IN_FULL");
});

test("a part payment is DEPOSIT_PAID, as it always was", async () => {
  const admin = fakeAdmin({
    ledger: [{ amount: 250 }],
    job: jobRow({ contract_total: 1000, payment_status: "UNPAID" }),
  });
  await recordClearedPayment(admin, live({ amount: 250 }));
  assert.equal(statusWritten(admin), "DEPOSIT_PAID");
});

test("a job the server has never priced is unchanged: contract_total 0 means DEPOSIT_PAID", async () => {
  // The `total > 0` guard is what preserves today's behaviour for every job
  // with no server price. Without it, netPaid >= 0 would read as PAID_IN_FULL
  // on every job in the database.
  const admin = fakeAdmin({
    ledger: [{ amount: 40 }],
    job: jobRow({ contract_total: 0, payment_status: "UNPAID" }),
  });
  await recordClearedPayment(admin, live({ amount: 40 }));
  assert.equal(statusWritten(admin), "DEPOSIT_PAID");
});

test("refunds count: a job refunded back below its total is not PAID_IN_FULL", async () => {
  const admin = fakeAdmin({
    ledger: [{ amount: 1000 }],
    job: jobRow({ contract_total: 1000, refunded_amount: 400, payment_status: "DEPOSIT_PAID" }),
  });
  await recordClearedPayment(admin, live({ amount: 1000 }));
  assert.equal(statusWritten(admin), "DEPOSIT_PAID",
    "net of refunds is what decides, not the gross ledger");
});

// ------------------------------------------------- the silent-zero defect ---

test("a failed ledger read throws instead of writing amount_paid: 0", async () => {
  const admin = fakeAdmin({
    ledgerError: { message: "connection reset" },
    job: jobRow({ contract_total: 1000, payment_status: "DEPOSIT_PAID" }),
  });
  await assert.rejects(
    () => recordClearedPayment(admin, live({ amount: 500 })),
    /ledger/i,
    "a read failure must be loud -- it used to reduce to 0 and be written as the paid figure",
  );
  assert.equal(admin.state.updates.length, 0,
    "nothing may be written to the job when the total could not be read");
});

// ------------------------------------------------------- unchanged rules ---

test("test money is still never booked", async () => {
  const admin = fakeAdmin({ ledger: [{ amount: 100 }], job: jobRow() });
  const out = await recordClearedPayment(admin, live({ liveMode: false }));
  assert.equal(out.recorded, false);
  assert.match(out.reason, /sandbox/i);
  assert.equal(admin.state.upserts.length, 0, "a sandbox payment writes no ledger row");
  assert.equal(admin.state.updates.length, 0, "and touches no job");
});

test("POSITIVE CONTROL: a live payment really does write both the ledger and the job", async () => {
  // Without this, every assertion above would pass just as happily against a
  // function that had stopped writing anything at all.
  const admin = fakeAdmin({ ledger: [{ amount: 100 }], job: jobRow({ contract_total: 1000 }) });
  const out = await recordClearedPayment(admin, live());
  assert.equal(out.recorded, true);
  assert.equal(admin.state.upserts.length, 1, "the ledger row was written");
  assert.equal(admin.state.updates.length, 1, "the job was updated");
  assert.equal(admin.state.updates[0].patch.amount_paid, 100);
  assert.equal(admin.state.updates[0].patch.payments_from_processor, true);
  assert.equal("updated_at" in admin.state.updates[0].patch, false,
    "the edit clock must not move: money arriving is not an edit");
});
