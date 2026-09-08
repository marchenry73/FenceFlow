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
 */

export interface DepositInput {
  /** `jobs.deposit_amount`. Zero or absent means the contractor asked for none. */
  depositAmount: number | null | undefined;
  /** `jobs.contract_total`. A deposit can never exceed the whole job. */
  contractTotal: number | null | undefined;
  /** `jobs.amount_paid`, the server-derived cache of the payment ledger. */
  amountPaid: number | null | undefined;
  /** `jobs.refunded_amount`. */
  refundedAmount: number | null | undefined;
}

export interface DepositFigures {
  /** What the contractor asked for, capped at the job total. Zero if none. */
  asked: number;
  /** What is still owed on it once payments and refunds are counted. */
  due: number;
  /** Whether [due] can actually go through a card processor. */
  payable: boolean;
}

/** Processors refuse amounts under fifty cents; below that there is nothing to collect. */
const MIN_CHARGEABLE = 0.5;

export function depositFigures(input: DepositInput): DepositFigures {
  const num = (v: number | null | undefined) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const total = Math.max(0, num(input.contractTotal));
  const requested = Math.max(0, num(input.depositAmount));
  // Capped at the job itself, and only when there IS a total to cap against:
  // a job priced at zero is one that has not been priced, not one that is free.
  const asked = total > 0 ? Math.min(requested, total) : requested;

  const netPaid = num(input.amountPaid) - num(input.refundedAmount);
  const due = Math.max(0, asked - Math.max(0, netPaid));

  return { asked, due, payable: due >= MIN_CHARGEABLE };
}
