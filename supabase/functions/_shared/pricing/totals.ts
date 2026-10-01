/**
 * Port of EstimateEngine.linearFeet, teardownLinearFeet and computeTotals
 * (app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt).
 *
 * Money is Double on the phone and stays a plain double here; only the
 * footage that Kotlin holds in a Float goes through f32. The term order in
 * computeTotals is the phone's, including the parts a fresh pair of eyes
 * would call wrong -- markup on top of tax, discount after markup. They are
 * what every quote in the field says. (The always-up $10 rounding that used to
 * be on this list is gone: the total is exact to the cent, see roundToCents.)
 */
import { coerceAtLeast, doubleSum, f32 } from "./f32.ts";
import { decodeGates } from "./geometry.ts";
import { resolveGeometry } from "./takeoff.ts";
import { lineTotal } from "./types.ts";
import type { ChangeOrder, EstimateLineItem, FenceRun, Job } from "./types.ts";

/**
 * The survey grid's own scale, in pixels per foot, used to measure a drawn
 * run when the job has no calibration.
 *
 * Mirrors DrawingScale.PIXELS_PER_FOOT_GRID (EstimateEngine.kt /
 * DrawingScale.kt) and the identical fallback load.ts's buildPricingInput
 * already applies when it works out PricingInput.pixels_per_foot -- the
 * value suggestQuantities() measures MATERIALS at for exactly this run. Kept
 * as its own constant, rather than a bare 20 next to the one read site
 * below, so the two are visibly the same number to change together.
 */
const GRID_PIXELS_PER_FOOT = 20.0;

/**
 * Total footage across a job's runs.
 *
 * The one place this is worked out. It used to be copied by hand into the
 * home screen, the job screen and the estimate screen, and three copies of
 * a rule is three chances for the home total to stop matching the job it
 * came from -- the sort of disagreement that reads as the app inventing
 * numbers. Calling this from all of them means they cannot drift apart.
 *
 * A drawn run with no calibration measures at the grid's own scale, same as
 * suggestQuantities() already measures materials for it -- so a run priced
 * off the drawing bills the same footage on both halves of the estimate.
 * This used to read the job's calibration directly and treat "none set" as
 * zero feet, which billed full materials and zero labour for the same run
 * (fixtures/pricing/drawn-uncalibrated.json). Only a run with neither typed
 * footage nor any drawing at all still contributes nothing -- there is no
 * length anywhere to measure.
 *
 * That grid fallback is only correct for a job with no survey photo. A grid
 * square is a known size, so guessing 20 px/ft for it is a fact, not a
 * guess; a photo has no scale at all until somebody calibrates it against
 * something of known length, and pricing labour off a made-up scale is worse
 * than the zero this used to bill. The phone knows the difference --
 * EstimateEngine.linearFeet refuses (0 ft) for an uncalibrated run on a
 * photo, via DrawingScale.isPhotoJob -- and THIS function does not have to
 * follow it separately, because it never sees the photo case at all: `job`
 * and `runs` here are already whatever load.ts's buildPricingInput decided
 * to hand the engine, and for an uncalibrated photo job that is every run
 * with its drawing and gates blanked (neutralizeUnscaledRun) -- the shape of
 * a run nobody has drawn on, which the "no typed footage and no drawing"
 * case just above already prices at zero. `JobRow` / `PricingInput` (index.ts)
 * still carry no survey-photo field of their own; the signal
 * (`survey_storage_path`, verified against the live schema) is read and
 * spent entirely at that boundary, one file this change does own, rather
 * than by widening a contract this file does not.
 *
 * Only fence being BUILT. The old fence's footage is the teardown
 * charge's business, not the labour rate's -- counting it here billed
 * installation labour for a fence that is leaving the property.
 */
export function linearFeet(job: Job, runs: readonly FenceRun[]): number {
  return f32(doubleSum(runs.filter((r) => !r.isTeardown).map((run) => footageOf(job, run))));
}

/** The old fence's own footage, for the teardown charge. Same grid fallback, and the same photo handling upstream, as [linearFeet]. */
export function teardownLinearFeet(job: Job, runs: readonly FenceRun[]): number {
  return f32(doubleSum(runs.filter((r) => r.isTeardown).map((run) => footageOf(job, run))));
}

/**
 * The body both sums share: typed footage, else the drawing measured at the
 * job's calibration or the grid's own scale when there is none, else
 * nothing (no typed footage and no drawing to measure). See [linearFeet] for
 * where the photo case is actually decided -- not here, and not by reading
 * anything photo-related off `job`.
 */
function footageOf(job: Job, run: FenceRun): number {
  const manual = run.manualLinearFeet;
  if (manual !== null && manual > 0) return manual;
  const pixelsPerFoot = job.calibrationPixelsPerFoot ?? GRID_PIXELS_PER_FOOT;
  return resolveGeometry(run, pixelsPerFoot).totalLinearFeet;
}

/**
 * Money, to the cent: the ONE place the engine rounds a total.
 *
 * The total is a chain of float multiplications (tax, markup, then discount),
 * so a job worth exactly $2,200 can come out as 2200.0000000000005 -- float
 * dust, not a price, which must never be stored or shown. Two decimal places
 * because a cent is the smallest thing money has.
 *
 * Math.round(x * 100) / 100 and nothing cleverer, because it is exactly what
 * Kotlin writes (EstimateEngine.roundToCents: java.lang.Math.round(x * 100.0) /
 * 100.0): the same IEEE multiply and divide, and both round halves toward
 * +infinity, so the two engines return the same double for the same input. A
 * non-finite value passes through untouched: Java's Math.round turns NaN into
 * 0, and a NaN total must stay visibly broken rather than become a $0.00 quote.
 *
 * Defined here, not imported from _shared/quote-deposit.ts, which carries an
 * identical copy for the quote page: this directory is deliberately
 * self-contained (a test copies it to a scratch folder to revert one rule at a
 * time), so it may not reach outside itself. tests/a29-deposit-and-rounding
 * runs the same vectors through both copies.
 */
export function roundToCents(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
}

export interface Totals {
  materialsSubtotal: number;
  taxableSubtotal: number;
  tax: number;
  laborCost: number;
  teardownCost: number;
  markupAmount: number;
  discountAmount: number;
  grandTotal: number;
  /** Approved extra work, already included in grandTotal. */
  changeOrderCost: number;
  changeOrderFeet: number;
  /** Gate openings charged by the foot, already included in grandTotal. */
  gateCharge: number;
  gateFeet: number;
  /** Hauling the old fence away, already included in grandTotal. */
  trashHaulFee: number;
  /**
   * Fence billed, including change-order feet. Carried on the totals so
   * that "what the customer signed for" can be recorded as one thing --
   * a price and a length -- rather than re-derived from the geometry
   * somewhere else and drifting from what the estimate actually said.
   * Float.
   */
  billableLinearFeet: number;
  /** The base the markup is taken on. A local on the phone; the contract reports it. */
  preMarkup: number;
}

/**
 * @param changeOrders extra work agreed after the original quote. Their feet
 *   are billed at the same labor rate as the rest of the job, and their cost
 *   is added on top -- a change order that doesn't move the total is just a
 *   note, and the whole point of one is that the customer owes more.
 * @param runs used to price gate openings. A gate is charged by the foot of
 *   opening, not at the fence rate -- hanging and squaring one is the
 *   slowest work on the job per foot, and pricing it like fence line loses
 *   money on every gate.
 */
export function computeTotals(
  job: Job,
  lineItems: readonly EstimateLineItem[],
  totalLinearFeet: number,
  changeOrders: readonly ChangeOrder[] = [],
  runs: readonly FenceRun[] = [],
): Totals {
  const materialsSubtotal = doubleSum(lineItems.map(lineTotal));
  const taxableSubtotal = doubleSum(lineItems.filter((i) => i.taxable).map(lineTotal));
  const tax = taxableSubtotal * (job.taxRatePercent / 100.0);

  const changeOrderCost = doubleSum(changeOrders.map((c) => c.additionalCost));
  const changeOrderFeet = doubleSum(changeOrders.map((c) => c.additionalFeet));
  // Float + Double is a Double.
  const billableFeet = totalLinearFeet + changeOrderFeet;

  // Gate openings, charged by the foot of opening. The gate width was
  // already removed from the fence footage by the takeoff, so this adds
  // rather than double-charges.
  const gateFeet = doubleSum(runs.map((run) => doubleSum(decodeGates(run.gatesEncoded).map((g) => g.widthFt))));
  const gateCharge = gateFeet * job.gateRatePerFt;

  // Labour is charged on the fence that is built. The gate openings are
  // charged by the gate rate below, so they come out of the labour
  // footage here -- otherwise a 4 ft gate was billed twice: once as
  // fence labour, once as a gate.
  const laborFeet = coerceAtLeast(billableFeet - gateFeet, 0.0);
  // The floor sits on labour alone, not on the grand total below: the owner
  // charges a minimum for turning up to a job, and materials must not count
  // toward reaching it. 0 is off, so every company without this setting still
  // computes the same laborCost it always did.
  //
  // Guarded on > 0 rather than relying on max(x, 0) being a no-op, because it is
  // not one: laborFeet is clamped at zero but laborFlatFee is NOT, and a
  // negative flat fee is how an estimator knocks money off a quote. max(-150, 0)
  // is 0, so an untouched company's credit would silently vanish and its quote
  // would go UP by the size of it. Kotlin is guarded the same way; a difference
  // of a cent between the two is a phone and a server quoting one job twice.
  const rawLabor = job.laborFlatFee + job.laborRatePerFt * laborFeet;
  const laborCost = job.minimumLaborCharge > 0 ? Math.max(rawLabor, job.minimumLaborCharge) : rawLabor;
  const trashHaul = job.teardownEnabled ? job.trashHaulFee : 0.0;
  // The typed teardown length when there is one, because the old fence
  // does not always match the new one. Zero means what every job meant
  // before the field existed: priced along the new fence.
  // Typed footage first; then the drawn old fence itself, which is the
  // whole point of drawing it; the new fence's footage only as the last
  // guess when nothing better exists.
  const drawnTeardownFt = teardownLinearFeet(job, runs);
  const teardownFt =
    job.teardownFeet > 0.0 ? job.teardownFeet
    : drawnTeardownFt > 0.0 ? drawnTeardownFt
    : billableFeet;
  const teardownCost = job.teardownEnabled
    ? job.teardownFlatFee + job.teardownRatePerFt * teardownFt + trashHaul
    : 0.0;

  const preMarkup = materialsSubtotal + tax + laborCost + teardownCost + changeOrderCost + gateCharge;
  const markupAmount = preMarkup * (job.markupPercent / 100.0);
  const afterMarkup = preMarkup + markupAmount;

  const discountAmount = afterMarkup * (job.discountPercent / 100.0);
  const afterDiscount = afterMarkup - discountAmount;

  // EXACT, to the cent -- not rounded up. This was ceil(.. / 10) * 10 until
  // PRICING_ENGINE_VERSION 2026.10.1 (the owner's decision, 1 Oct 2026, taken
  // knowing the cost: a quote of $15,991.06 kept coming in "less than needed"
  // once material prices moved a cent, and rounding up was the cushion for it).
  //
  // This is the ONE place a total is rounded, and it rounds to two places,
  // not zero: the sum above is a chain of float multiplications, so a job that
  // is exactly $2,200 can arrive as 2200.0000000000005, and without the cents
  // rounding that dust would be stored, signed, billed and shown. The old
  // ceil to ten used to hide it; this replaces the hiding with a real fix.
  // Only the final figure is rounded -- tax, markup and the other parts stay
  // unrounded so the sum is not rounded twice.
  //
  // The minimum job charge is applied BEFORE the rounding, as it always was,
  // so a job that falls to the minimum reads exactly the minimum: max picks the
  // charge itself and rounding a number already on cents leaves it alone.
  // Kotlin does the same in EstimateEngine.computeTotals (roundToCents).
  const grandTotal = roundToCents(Math.max(afterDiscount, job.minimumJobCharge));

  return {
    materialsSubtotal,
    taxableSubtotal,
    tax,
    laborCost,
    teardownCost,
    markupAmount,
    discountAmount,
    grandTotal,
    changeOrderCost,
    changeOrderFeet,
    gateCharge,
    gateFeet,
    trashHaulFee: trashHaul,
    billableLinearFeet: f32(billableFeet),
    preMarkup,
  };
}
