/**
 * Money arrived. Write it down, once, the same way for every processor.
 *
 * Stripe and Square tell us about a cleared payment in completely different
 * shapes, but what has to happen afterwards is identical: put a row in the
 * ledger, rebuild the job's paid figure from that ledger, and tell the phones.
 *
 * This exists as one module because the alternative is two implementations of
 * "how much has this customer paid", and this product has already been through
 * that once -- the app and the website worked the same figure out differently
 * and a job read $42,301 paid against $10,755 of records. One place, or it
 * happens again with a third processor.
 *
 * Everything here runs as the service role, so Row Level Security is not
 * watching. That is deliberate and it is why the callers must verify their
 * webhook signature BEFORE calling in.
 */

export interface ClearedPayment {
  /** Which company the money belongs to. */
  companyId: string;
  /** The job it pays for, by the app's own sync id. */
  jobSyncId: string;
  /** Whole currency units, not cents. */
  amount: number;
  /** A stable id from the processor, so a replayed webhook cannot double-count. */
  externalId: string;
  /** 'stripe' | 'square' -- only used to make the ledger row readable. */
  processor: string;
  /** False for a test/sandbox payment. Test money never touches the books. */
  liveMode: boolean;
}

export interface RecordOutcome {
  recorded: boolean;
  reason: string;
  /** The company's paid total for that job afterwards, when there was one. */
  paidAfter?: number;
}

export async function recordClearedPayment(
  admin: any,
  p: ClearedPayment,
): Promise<RecordOutcome> {
  if (!p.companyId || !p.jobSyncId) {
    return { recorded: false, reason: "no company or job on the payment" };
  }

  // A test payment is a test.
  //
  // Test and live money live in the same tables, and summing across both once
  // left a real job reading $57,240 paid against a $10,595 contract. The
  // direction of that error is what makes it dangerous: after go-live a
  // sandbox payment would credit a real customer as having paid, and the job
  // would show settled with no money moved.
  if (!p.liveMode) {
    return { recorded: false, reason: "sandbox payment, deliberately not booked" };
  }

  // The ledger row first, and it does not depend on the job existing.
  //
  // The app creates a job on the phone and uploads it on its next sync, so a
  // payment link sent from the office can easily be paid before the job row
  // reaches the cloud. Writing the ledger first means the money is recorded
  // either way, and the app rebuilds the paid figure from the ledger when the
  // job finally arrives.
  await admin.from("payment_records").upsert({
    sync_id: `${p.processor}-${p.externalId}`,
    company_id: p.companyId,
    job_sync_id: p.jobSyncId,
    amount: p.amount,
    method: "CARD",
    received_at: new Date().toISOString(),
    reference: p.externalId,
    note: "",
    recorded_by: p.processor === "square" ? "Square" : "Stripe",
  }, { onConflict: "company_id,sync_id" });

  // Summed from the ledger rather than incremented, so a replayed webhook or a
  // manual correction cannot drift the total -- and so cash and cheque count
  // alongside the card, which is the same rule the app uses.
  const { data: ledger } = await admin.from("payment_records")
    .select("amount")
    .eq("company_id", p.companyId)
    .eq("job_sync_id", p.jobSyncId)
    .is("deleted_at", null);
  const paid = (ledger ?? []).reduce(
    (sum: number, r: any) => sum + Math.max(0, Number(r.amount || 0)), 0);

  const { data: job } = await admin.from("jobs")
    .select("id, sync_id, company_id, customer_name, deposit_amount")
    .eq("company_id", p.companyId)
    .eq("sync_id", p.jobSyncId)
    .maybeSingle();

  if (!job) {
    return {
      recorded: true,
      reason: "ledger written; the job has not synced from the phone yet",
      paidAfter: paid,
    };
  }

  // Records that money arrived, and no more than that. Whether the job is paid
  // in full depends on the contract total, which the app computes from line
  // items, change orders and gate charges -- the server does not have it and
  // should not guess.
  await admin.from("jobs").update({
    amount_paid: paid,
    payment_status: "DEPOSIT_PAID",
    // Latches the figure read-only in the app: what the processor reports is
    // the record, and typing over it is a discrepancy, not a correction.
    payments_from_processor: true,
    updated_at: new Date().toISOString(),
  }).eq("id", job.id);

  return { recorded: true, reason: "recorded against the job", paidAfter: paid };
}
