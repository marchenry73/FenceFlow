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
  /** Net of refunds, floored at zero. */
  netPaid: number;
  /** What is left on the whole job: [total] less [netPaid], floored at zero. */
  balance: number;
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

  const netPaid = Math.max(0, num(input.amountPaid) - num(input.refundedAmount));
  const due = Math.max(0, asked - netPaid);
  // What is left on the WHOLE job, not just on the deposit.
  //
  // It is computed here rather than by whoever shows it because the customer's
  // quote page was working it out for itself as total minus the deposit ASKED,
  // while every other surface -- JobMoney, the PDF, the office, this function's
  // own payable cap -- works it out as total minus what has actually been PAID.
  // On a job paid in full that produced a page reading "Paid in full -- thank
  // you" directly above "Balance due $15,364.00". Proved on the live link, not
  // reasoned about.
  const balance = Math.max(0, total - netPaid);

  return { asked, due, payable: due >= MIN_CHARGEABLE, total, netPaid, balance };
}

// ---------------------------------------------------------------------------
// Money to the cent, and the deposit rule.
//
// Both live in this file because it is the one the quote page and the payment
// link already share. Kotlin carries the same two definitions
// (EstimateEngine.roundToCents, JobMoney.ruleDeposit / depositSuggestion), and
// tests/a29-deposit-and-rounding.test.mjs plus JobMoneyDepositRuleTest.kt both
// run tests/a29-deposit-rule-vectors.json, so the two cannot drift apart
// without a test going red.
//
// roundToCents has a THIRD copy, in pricing/totals.ts, because the engine's
// directory is self-contained and may not import from here (a test copies it
// to a scratch folder). The a29 test runs the same vectors through both.
// ---------------------------------------------------------------------------

/**
 * Money, to the cent: the ONE place a total is rounded.
 *
 * The engine's total is a chain of float multiplications (tax, markup, then
 * discount), so a job worth exactly $2,200 can come out as 2200.0000000000005.
 * That is float dust, not a price, and it must never be stored or shown. Two
 * decimal places, because a cent is the smallest thing money has -- rounding
 * to whole dollars would be a different decision than the one the owner made.
 *
 * Math.round(x * 100) / 100 and nothing cleverer, because it is also exactly
 * what Kotlin writes (java.lang.Math.round(x * 100.0) / 100.0): the same IEEE
 * multiply and divide, and both round halves toward +infinity, so the two
 * engines return the same double for the same input. A non-finite value passes
 * through untouched: Java's Math.round turns NaN into 0, and a NaN total
 * must stay visibly broken rather than quietly become a $0.00 quote.
 */
export function roundToCents(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
}

/** The deposit is rounded UP to the next multiple of this many dollars... */
export const DEPOSIT_ROUND_UP_TO = 100;
/** ...and then this many dollars are added. */
export const DEPOSIT_PLUS = 100;

/**
 * THE DEPOSIT RULE, in one sentence: the deposit is the materials still to be
 * bought, rounded up to the next $100, plus another $100 -- and never more than
 * is still owed on the job ([suggestedDeposit] applies that cap).
 *
 * The extra $100 pays for scheduling and transport. It is the contractor's
 * business and is deliberately NOT disclosed to the customer: it is folded
 * into the one deposit figure and never itemised, noted or explained anywhere
 * a customer reads. Nothing in this file, the quote page's response or the
 * contract carries it as a separate number.
 *
 * Returns whole dollars, or 0 when no materials are outstanding.
 *
 *  - Rounded UP means a figure that is already a whole hundred stays where it
 *    is before the $100 is added: $1,000 of materials is a $1,100 deposit.
 *  - The amount is taken to cents FIRST. $1,000 of materials that arrives as
 *    1000.0000000000001 is $1,000, not a cent over -- float dust must not
 *    push a deposit into the next hundred.
 */
export function ruleDeposit(outstandingMaterials: number): number {
  const cents = Math.round(Number(outstandingMaterials) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return 0;
  return Math.ceil(cents / (DEPOSIT_ROUND_UP_TO * 100)) * DEPOSIT_ROUND_UP_TO + DEPOSIT_PLUS;
}

export interface DepositSuggestionInput {
  /**
   * What has to be bought for the job: the estimate's materials plus the
   * materials on any change order. The app's materialCost, and the same
   * figure its "Set deposit" button works from.
   */
  materialCost: number | null | undefined;
  /** `jobs.amount_paid`. */
  amountPaid: number | null | undefined;
  /** `jobs.refunded_amount`. */
  refundedAmount: number | null | undefined;
  /** [billableTotal]: the figure the job is billed against. */
  billableTotal: number | null | undefined;
}

export interface DepositSuggestion {
  /** Dollars. 0 when there is nothing to suggest. */
  amount: number;
  /**
   * True when the cap bit: [amount] is all that is still owed on the job and
   * the rule's own figure was higher. The customer sees a deposit equal to
   * what they still owe -- never one larger.
   */
  capped: boolean;
}

/**
 * The deposit to offer: [ruleDeposit] of the materials still to be bought
 * (net of money already in), capped at what is still owed on [billableTotal].
 *
 * The server's copy of the app's JobMoney.depositSuggestion -- same inputs,
 * same answer, pinned by tests/a29-deposit-rule-vectors.json. It only OFFERS a
 * figure. Nothing here writes jobs.deposit_amount, and the quote page and the
 * payment link still read the STORED deposit (depositFigures above): "a deposit
 * is a thing the contractor asks for". Today the phone's one-tap "Set deposit"
 * button is what turns this figure into a stored one; no server code calls this
 * yet.
 *
 * The cap is the existing one, for the existing reason: a deposit above the job
 * is a bill for money the customer never agreed to (a $3,963 deposit was once
 * stored against a $3,620 job). It bites on a small job -- materials of $120
 * on a $150 job rule to $300, which is more than the job, so the suggestion is
 * the $150 owed, i.e. the customer is asked for the whole job up front.
 * Nothing is added or invented on top of the price; the extra $100 is simply
 * not there to add when there is no room for it.
 */
export function suggestedDeposit(input: DepositSuggestionInput): DepositSuggestion {
  const num = (v: number | null | undefined) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const none: DepositSuggestion = { amount: 0, capped: false };

  const materialCost = num(input.materialCost);
  const total = Math.max(0, num(input.billableTotal));
  if (materialCost <= 0 || total <= 0) return none;

  const netPaid = Math.max(0, num(input.amountPaid) - num(input.refundedAmount));
  const rule = ruleDeposit(materialCost - netPaid);
  if (rule <= 0) return none;

  // Cents, so the capped figure is the balance to the cent, not float dust.
  const owed = roundToCents(Math.max(0, total - netPaid));
  if (owed <= 0.005) return none;

  return rule <= owed + 0.005 ? { amount: rule, capped: false } : { amount: owed, capped: true };
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
