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

/**
 * Processors report the smallest unit, and which unit depends on the
 * currency. A yen amount divided by a hundred is simply wrong.
 */
export function minorToMajor(amountMinor: number, currency: string): number {
  const zeroDecimal = ["JPY", "KRW", "VND", "CLP", "ISK"];
  return zeroDecimal.includes(String(currency ?? "").toUpperCase()) ? amountMinor : amountMinor / 100;
}

export interface ProcessorRefund {
  companyId: string;
  jobSyncId: string;
  /** Whole currency units, POSITIVE. The ledger row is written negative. */
  amount: number;
  /** The processor's own refund id -- stable across webhook retries. */
  refundId: string;
  processor: string;
  liveMode: boolean;
  reason?: string;
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
    // No updated_at. That column is the edit clock last-edit-wins compares,
    // and money arriving is not an edit: bumping it here made the cloud row
    // "newer" than whatever a crew phone had changed offline, so that change
    // lost the race and was overwritten. Phones learn about the money from
    // the amount itself and from the ledger, never from the clock.
  }).eq("id", job.id);

  return { recorded: true, reason: "recorded against the job", paidAfter: paid };
}

/**
 * Money went back. Write it down the way the app already does.
 *
 * A refund issued in the Square or Stripe dashboard used to reach FenceFlow
 * only if somebody remembered to press "Record refund" on the phone; until
 * then the job went on showing the pre-refund balance, the office showed
 * Paid in Full, and the next reminder asked the customer for money they had
 * just been given back. The app's own refund is a payment_records row with a
 * NEGATIVE amount and nothing else special (PaymentRecord.isRefund is
 * amount < 0), and the ledger trigger already derives amount_paid and
 * refunded_amount from every row -- so the whole job here is one row, keyed
 * on the processor's refund id so a retried webhook cannot book it twice.
 *
 * What the trigger does not touch is payment_status. The phones move it
 * forward when money arrives; nothing moved it back when money left, and a
 * job read Paid in Full on the website after a full refund until a phone
 * happened to open it. This settles it downward -- never upward: a refund
 * can only ever make a job less paid.
 */
export async function recordRefund(
  admin: any,
  r: ProcessorRefund,
): Promise<RecordOutcome> {
  if (!r.companyId || !r.jobSyncId) {
    return { recorded: false, reason: "no company or job on the refund" };
  }
  if (!r.liveMode) {
    return { recorded: false, reason: "sandbox refund, deliberately not booked" };
  }
  if (!(Number(r.amount) > 0)) {
    return { recorded: false, reason: "no amount on the refund" };
  }

  await admin.from("payment_records").upsert({
    sync_id: `${r.processor}-refund-${r.refundId}`,
    company_id: r.companyId,
    job_sync_id: r.jobSyncId,
    amount: -Math.abs(Number(r.amount)),
    method: "CARD",
    received_at: new Date().toISOString(),
    reference: r.refundId,
    note: String(r.reason ?? ""),
    recorded_by: r.processor === "square" ? "Square" : "Stripe",
  }, { onConflict: "company_id,sync_id" });

  // The trigger has already rebuilt the cached figures from the ledger by the
  // time the upsert returns, so these are post-refund numbers.
  const { data: job } = await admin.from("jobs")
    .select("id, amount_paid, refunded_amount, contract_total, payment_status")
    .eq("company_id", r.companyId)
    .eq("sync_id", r.jobSyncId)
    .maybeSingle();
  if (!job) {
    return { recorded: true, reason: "refund in the ledger; the job has not synced from the phone yet" };
  }

  const net = Number(job.amount_paid || 0) - Number(job.refunded_amount || 0);
  const total = Number(job.contract_total || 0);
  const rank: Record<string, number> = { UNPAID: 0, DEPOSIT_PAID: 1, PAID_IN_FULL: 2 };
  const should = net <= 0.005 ? "UNPAID"
    : (total > 0 && net >= total - 0.005) ? "PAID_IN_FULL"
    : "DEPOSIT_PAID";
  const current = String(job.payment_status ?? "UNPAID");
  if ((rank[should] ?? 0) < (rank[current] ?? 0)) {
    // payment_status is on the trigger's quiet list: this does not move the
    // edit clock, so it cannot overwrite an offline edit on a phone.
    await admin.from("jobs").update({ payment_status: should }).eq("id", job.id);
    return { recorded: true, reason: `refund recorded; ${current} -> ${should}`, paidAfter: net };
  }
  return { recorded: true, reason: "refund recorded", paidAfter: net };
}
