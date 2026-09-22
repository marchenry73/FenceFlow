/**
 * What the deposit on a quote IS, and what is left to pay on it.
 *
 * One rule, in one place, because there were two and they disagreed.
 *
 * `quote-view` showed the homeowner a deposit figure. `create-payment-link`
 * worked out what to charge. Neither called the other, and they diverged in
 * a way that only shows up in front of a customer:
 *
 *  - When the contractor had not set a deposit, `quote-view` invented one
 *    from the material cost, rounded up to the next hundred, and printed it
 *    on the page under "Deposit to begin". `create-payment-link` used the
 *    stored deposit -- zero -- so pressing the button produced "There is
 *    nothing to pay on this quote yet." A number the page asked for and the
 *    product refused to take.
 *  - `quote-view` never subtracted money already received, so a part-paid
 *    deposit still displayed in full while the payment link correctly asked
 *    for the remainder.
 *
 * The invented figure is gone. A deposit is a thing the contractor asks
 * for; if they have not asked for one, the page says nothing about a
 * deposit rather than guessing on their behalf and putting a number they
 * never approved in front of their customer. Both functions now read this.
 *
 * The job total everything here is measured against is [billableTotal]: the
 * price the customer ACCEPTED (plus extra work they signed for since) while
 * an acceptance stands, and contract_total only until then. contract_total
 * kept moving after acceptance -- the phones pushed their live recompute --
 * and the deposit cap, the balance and the quote page all followed it: Woody
 * was signed at $3,620 and showed $200, job 4598 was signed at $9,710 and
 * asked against $13,410. Both functions pass the same acceptance fields, so
 * the page and the card machine still cannot disagree.
 */

/** One change order, as the acceptance rule needs it. */
export interface ChangeOrderInput {
  /** `change_orders.additional_cost`. */
  additionalCost: number | null | undefined;
  /** `change_orders.signed_at` (ISO). Unsigned extra work does not move the price. */
  signedAt?: string | null;
  /** `change_orders.deleted_at` (ISO). A tombstoned order counts for nothing. */
  deletedAt?: string | null;
  /**
   * `change_orders.in_accepted_total`: an acceptance already covered this
   * order -- it existed, signed or not, when the price was accepted, so the
   * accepted figure contains it. Absent (a database without the column)
   * reads as false, which is the rule as it was.
   */
  inAcceptedTotal?: boolean | null;
}

export interface DepositInput {
  /** `jobs.deposit_amount`. Zero or absent means the contractor asked for none. */
  depositAmount: number | null | undefined;
  /** `jobs.contract_total`. A deposit can never exceed the whole job. */
  contractTotal: number | null | undefined;
  /** `jobs.amount_paid`, the server-derived cache of the payment ledger. */
  amountPaid: number | null | undefined;
  /** `jobs.refunded_amount`. */
  refundedAmount: number | null | undefined;
  /**
   * `jobs.accepted_total`: the price the customer accepted -- the quote page's
   * total on an online approval, signed_contract_total on a drawn signature.
   * Null or absent (every job accepted before the column existed, or a
   * database without it) means nothing anchors the price: contract_total.
   */
  acceptedTotal?: number | null;
  /** `jobs.signed_at` (ISO). */
  signedAt?: string | null;
  /** `jobs.quote_approved_at` (ISO). */
  quoteApprovedAt?: string | null;
  /**
   * `jobs.reapproval_required_at` (ISO). Set when a drawing change withdrew
   * the approval: the live price is then what the customer is being asked to
   * approve again, so the old accepted figure does not stand.
   */
  reapprovalRequiredAt?: string | null;
  /** The job's change orders. Absent reads as none. */
  changeOrders?: ChangeOrderInput[] | null;
}

export interface DepositFigures {
  /** What the contractor asked for, capped at the job total. Zero if none. */
  asked: number;
  /** What is still owed on it once payments and refunds are counted. */
  due: number;
  /** Whether [due] can actually go through a card processor. */
  payable: boolean;
  /**
   * The job total the cap was measured against: [billableTotal]. Zero means
   * the job has not been priced. create-payment-link bills the balance and
   * caps every link against this same figure.
   */
  total: number;
}

/** Processors refuse amounts under fifty cents; below that there is nothing to collect. */
const MIN_CHARGEABLE = 0.5;

/**
 * The figure the job is billed against. The server's copy of the app's
 * JobMoney.anchoredTotal / billableTotal -- same rule, so the phone, the
 * quote page and the payment link agree:
 *
 *  - accepted (signed_at or quote_approved_at set), an accepted_total above
 *    zero recorded, and no re-approval pending: accepted_total plus the
 *    change orders whose own signature came AFTER the acceptance and that the
 *    acceptance did not already cover (in_accepted_total). An order that
 *    existed at acceptance is already inside the accepted figure -- the
 *    engine counts unsigned orders too -- so adding it again bills it twice:
 *    an order added while the quote was out and signed the day after the
 *    contract turned $9,710 into $10,610. An unsigned order does not move
 *    the price until the customer signs it.
 *  - otherwise: contract_total, exactly as before.
 *
 * Never below zero.
 */
export function billableTotal(input: DepositInput) {
  const num = (v: number | null | undefined) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const live = Math.max(0, num(input.contractTotal));
  const accepted = num(input.acceptedTotal);
  const acceptedAt = Math.max(
    Date.parse(String(input.signedAt ?? "")) || 0,
    Date.parse(String(input.quoteApprovedAt ?? "")) || 0,
  );
  if (input.acceptedTotal == null || accepted <= 0.005 || acceptedAt <= 0 || input.reapprovalRequiredAt) {
    return live;
  }
  let extra = 0;
  for (const order of input.changeOrders ?? []) {
    if (!order || order.deletedAt || order.inAcceptedTotal === true) continue;
    const signed = Date.parse(String(order.signedAt ?? "")) || 0;
    if (signed > acceptedAt) extra += num(order.additionalCost);
  }
  return Math.max(0, accepted + extra);
}

export function depositFigures(input: DepositInput): DepositFigures {
  const num = (v: number | null | undefined) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const total = billableTotal(input);
  const requested = Math.max(0, num(input.depositAmount));
  // Capped at the job itself, and only when there IS a total to cap against:
  // a job priced at zero is one that has not been priced, not one that is free.
  const asked = total > 0 ? Math.min(requested, total) : requested;

  const netPaid = num(input.amountPaid) - num(input.refundedAmount);
  const due = Math.max(0, asked - Math.max(0, netPaid));

  return { asked, due, payable: due >= MIN_CHARGEABLE, total };
}

/**
 * The change_orders columns [billableTotal] reads, and the same list without
 * in_accepted_total for a database that does not have it yet
 * (supabase_r6_price_stability.sql PART 4b). A function deployed before the
 * migration reads the old list and bills exactly as it did before.
 */
export const CHANGE_ORDER_COLUMNS = "additional_cost, signed_at, deleted_at, in_accepted_total";
export const CHANGE_ORDER_COLUMNS_BEFORE_ACCEPTANCE_FLAG = "additional_cost, signed_at, deleted_at";

/** Whether a change_orders read failed only because in_accepted_total is not there yet. */
export function missingAcceptanceFlag(error: { message?: string } | null | undefined): boolean {
  return /in_accepted_total/.test(String(error?.message ?? ""));
}

/** change_orders rows, as read with either column list, as [billableTotal] takes them. */
export function changeOrderInputs(
  rows: Array<{
    additional_cost?: number | string | null;
    signed_at?: string | null;
    deleted_at?: string | null;
    in_accepted_total?: boolean | null;
  }> | null | undefined,
): ChangeOrderInput[] {
  return (rows ?? []).map((c) => ({
    additionalCost: Number(c.additional_cost) || 0,
    signedAt: c.signed_at ?? null,
    deletedAt: c.deleted_at ?? null,
    inAcceptedTotal: c.in_accepted_total === true,
  }));
}
