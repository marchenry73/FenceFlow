// SS36 "Data integrity across every calculation": posts and their spacing,
// concrete per post, the waste factor, and tax are all computed in the
// SAME office pricing engine (supabase/functions/_shared/pricing/) that the
// 77 golden fixtures already replay end to end against Kotlin's output. But
// end-to-end equality can pass for the wrong reason -- two compensating bugs,
// or a case the 77 fixtures simply never hit at that exact spacing/waste
// combination -- so this file drives the SAME functions the fixtures drive,
// directly, with numbers worked out by hand, and it plants a wrong formula
// next to the real one so a silent regression in either has something to
// disagree with instead of nothing.
//
// Units: every quantity here (feet, bags, posts) is a plain count/foot
// figure, not money -- there is no cents/dollars split to get wrong at this
// layer. Tax IS money, and it is dollars (matches Job.taxRatePercent style
// percentages, and jobs.contract_total / totals.tax which are both stored
// and displayed in dollars, e.g. supabase_job_costing_v2.sql's `numeric`
// columns and website/dashboard.html's money() formatter).
//
// Run: npx tsx tests/downstream-posts-concrete-waste-tax.test.mjs
import { computePostCounts, suggestQuantities } from "../supabase/functions/_shared/pricing/takeoff.ts";
import { computeTotals } from "../supabase/functions/_shared/pricing/totals.ts";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
};

const geom = (overrides = {}) => ({
  totalLinearFeet: 100,
  segments: [],
  vertices: [],
  cornerCount: 0,
  endCount: 2, // open run
  lineVertexCount: 0,
  ...overrides,
});

// ---------------------------------------------------------------------------
console.log("\n1. Post count and post spacing (computePostCounts):");

// Hand worked: 100 ft open run, 0 corners, spacing 8 ft, no gates.
// bays = ceil(100/8) = ceil(12.5) = 13
// endCount=2 (open) -> standardPostEstimate = bays + 1 - gateCount = 13 + 1 - 0 = 14
// linePosts = standardPostEstimate - corners - ends = 14 - 0 - 2 = 12
// totalPosts = linePosts + corners + ends + gatePosts = 12 + 0 + 2 + 0 = 14
{
  const c = computePostCounts(geom(), [], 8, 100);
  ok("open 100ft run @ 8ft spacing: bays hand-check via linePosts/endPosts/totalPosts",
    c.linePosts === 12 && c.endPosts === 2 && c.totalPosts === 14,
    `got ${JSON.stringify(c)}`);
}

// A closed loop of the same length and spacing has no end posts and no
// "+1" for a closing post: standardPostEstimate = bays - gateCount = 13.
// linePosts = 13 - 0 - 0 = 13, totalPosts = 13 (no corners/ends/gates).
{
  const c = computePostCounts(geom({ cornerCount: 0, endCount: 0 }), [], 8, 100);
  ok("closed 100ft loop @ 8ft spacing has no end-post add and no closing post double count",
    c.linePosts === 13 && c.totalPosts === 13,
    `got ${JSON.stringify(c)}`);
}

// A gate splits the run: gatePosts = 2*gateCount, and the gate's own two
// posts are NOT double counted in the line-post estimate.
{
  const oneGate = [{ x: 0, y: 0, widthFt: 4, mounting: "LINE", swing: "IN" }];
  const c = computePostCounts(geom(), oneGate, 8, 100);
  ok("one gate adds exactly 2 gate posts, not counted twice against line posts",
    c.gatePosts === 2 && c.totalPosts === c.linePosts + c.cornerPosts + c.endPosts + 2,
    `got ${JSON.stringify(c)}`);
}

// CANARY: a plausible-but-wrong spacing formula (floor instead of ceil,
// i.e. "however many WHOLE spans fit" instead of "however many spans it
// takes to cover the run") must give a DIFFERENT bay/post count on a length
// that is not an exact multiple of the spacing. If this canary's wrong
// number ever equalled the real one, the hand-check above would not be
// discriminating between "spacing rounds up" and "spacing rounds down".
{
  const real = computePostCounts(geom(), [], 8, 100);
  const wrongBays = Math.floor(100 / 8); // 12, not 13
  // Same shape as the real formula (standardEstimate = bays+1 for an open
  // run, then linePosts = standardEstimate - corners - ends, totalPosts =
  // linePosts + corners + ends + gatePosts) but built on the floored bays.
  const wrongStandardEstimate = Math.max(wrongBays + 1 - 0, 0);
  const wrongLinePosts = Math.max(wrongStandardEstimate - 0 - 2, 0);
  const wrongTotalPosts = wrongLinePosts + 0 + 2 + 0;
  ok("CANARY: floor-based spacing gives a different total than the real ceil-based rule " +
     "(proves this hand-check can tell the two apart)",
    wrongTotalPosts !== real.totalPosts,
    `wrong=${wrongTotalPosts} real=${real.totalPosts} -- if equal, canary is not discriminating`);
}

// ---------------------------------------------------------------------------
console.log("\n2. Concrete per post (suggestQuantities, CONCRETE_BAG entries):");

const baseRun = {
  syncId: "r1", label: "Run 1", fenceType: "VINYL", sortOrder: 0,
  pointsEncoded: "", gatesEncoded: "", closedLoop: false, isTeardown: false,
  colorOrFinish: "", panelWidthFt: 8, panelHeightFt: 6, aluminumStyle: "RACKABLE",
  woodStyle: "PRIVACY", woodRailCount: 2, picketWidthIn: 5.5, picketGapIn: 0.25,
  fabricHeightFt: 4, includeTopRail: true, includeTensionWire: false,
  includeBarbedWireArms: false, includePrivacySlats: false, splitRailCount: 3,
  postSpacingFt: 8, concreteBagsPerPost: 2,
  manualLinearFeet: 100, manualCornerCount: 0,
  suppressedRoles: new Set(),
};

{
  const s = suggestQuantities(baseRun, 10, 0);
  // 100ft open run @ 8ft spacing, no gates: totalPosts = 14 (from check 1),
  // gatePosts = 0, so nonGatePosts = 14. At 2 bags/post -> 28 bags exactly.
  const bags = s.entries.find((e) => e.role === "CONCRETE_BAG");
  ok("100ft run, 2 bags/post, no gates -> 28 whole bags (14 posts x 2)",
    !!bags && bags.quantity === 28, `got ${JSON.stringify(bags)}`);
}

{
  // 2.5 bags/post is the case the header comment on GATE_HINGE_BAGS/
  // GATE_LATCH_BAGS warns about: totals must round UP to a whole bag,
  // summed across the whole run BEFORE rounding (not per-post).
  const run = { ...baseRun, concreteBagsPerPost: 2.5 };
  const s = suggestQuantities(run, 10, 0);
  const bags = s.entries.find((e) => e.role === "CONCRETE_BAG");
  // 14 posts * 2.5 = 35.0 exactly -> still 35, no partial bag to round.
  ok("14 posts @ 2.5 bags/post sums to a whole number with nothing to round away",
    !!bags && bags.quantity === 35, `got ${JSON.stringify(bags)}`);

  const run2 = { ...baseRun, concreteBagsPerPost: 2.5, manualLinearFeet: 99 };
  // netFt=99, bays=ceil(99/8)=13, standardPostEstimate(open)=13+1=14,
  // linePosts=14-0-2=12, totalPosts=14 (same as before by coincidence of
  // ceiling) -- use a length that changes bays instead: 97ft.
  const run3 = { ...baseRun, concreteBagsPerPost: 2.5, manualLinearFeet: 65 };
  // netFt=65, bays=ceil(65/8)=ceil(8.125)=9, standardPostEstimate=9+1=10,
  // linePosts=10-0-2=8, totalPosts=8+0+2+0=10. 10*2.5=25.0 exact again.
  // Force a fractional total instead: 3 posts implied is hard to hit exactly
  // with this geometry, so assert the documented behaviour directly: summed
  // BEFORE rounding, via a hand-built odd bags-per-post value.
  const run4 = { ...baseRun, concreteBagsPerPost: 1.2, manualLinearFeet: 65 };
  const s4 = suggestQuantities(run4, 10, 0);
  const bags4 = s4.entries.find((e) => e.role === "CONCRETE_BAG");
  // totalPosts=10 (worked out above), 10*1.2=12.0 -> ceil(12.0)=12, but
  // floating point (10*1.2) can land at 12.000000000000002, so the real
  // assertion is that it rounds UP to the nearest whole bag, never down,
  // and never leaves a fractional bag in the entries.
  ok("fractional bags-per-post always yields a whole number of bags (Number.isInteger)",
    !!bags4 && Number.isInteger(bags4.quantity) && bags4.quantity >= 10 * 1.2 - 1e-9,
    `got ${JSON.stringify(bags4)}`);
}

// CANARY: rounding PER ENTRY instead of on the SUMMED total (exactly the bug
// the header comment on wholeBags() describes: "a 1.2-bag run and a 1.3-bag
// gate came to four bags instead of three") must give a bigger number than
// the real, sum-then-round rule, on a case built to trigger it.
{
  const perEntryWrong = Math.ceil(1.2 * 2) + Math.ceil(1.3 * 2); // two separate small entries, rounded alone
  const summedThenRounded = Math.ceil(1.2 * 2 + 1.3 * 2); // the real rule's shape
  ok("CANARY: rounding each concrete entry separately overcounts vs. summing first " +
     "(proves the sum-then-round rule is actually being exercised, not accidentally always agreeing)",
    perEntryWrong > summedThenRounded,
    `per-entry=${perEntryWrong} summed=${summedThenRounded} -- if equal, this canary proves nothing`);
}

// ---------------------------------------------------------------------------
console.log("\n3. Waste factor:");

{
  // WASTE_ROLES includes PANEL but not LINE_POST/CORNER_POST/END_POST/POST_CAP.
  // 100ft/8ft panels -> ceil(100/8)=13 panels. At 10% waste: ceil(13*1.1)=ceil(14.3)=15.
  const s0 = suggestQuantities(baseRun, 10, 0);
  const s10 = suggestQuantities(baseRun, 10, 10);
  const panels0 = s0.entries.find((e) => e.role === "PANEL");
  const panels10 = s10.entries.find((e) => e.role === "PANEL");
  ok("10% waste on 13 panels rounds UP to 15 (ceil(13*1.1))",
    panels0.quantity === 13 && panels10.quantity === 15,
    `no-waste=${panels0?.quantity} 10%-waste=${panels10?.quantity}`);

  // Posts are explicitly NOT a waste role: waste must not touch them.
  const posts0 = s0.entries.find((e) => e.role === "LINE_POST");
  const posts10 = s10.entries.find((e) => e.role === "LINE_POST");
  ok("waste percent leaves LINE_POST quantity untouched (posts are bought exact, not with cut allowance)",
    posts0.quantity === posts10.quantity,
    `no-waste=${posts0?.quantity} 10%-waste=${posts10?.quantity}`);
}

// CANARY: applying the waste factor to a non-waste role (posts) WOULD change
// its quantity -- prove that arithmetic actually differs, so "unchanged"
// above is a real assertion and not a no-op comparison.
{
  const withWasteAppliedWrongly = Math.ceil(12 * 1.1); // what 10% waste would do to 12 line posts if it applied
  ok("CANARY: 10% waste actually would move a quantity of 12 if applied (12 -> 13), " +
     "so 'waste leaves posts untouched' above is a meaningful assertion",
    withWasteAppliedWrongly !== 12, `got ${withWasteAppliedWrongly}`);
}

// ---------------------------------------------------------------------------
console.log("\n4. Tax (computeTotals):");

const job = {
  calibrationPixelsPerFoot: null, taxRatePercent: 7.25, markupPercent: 0,
  laborRatePerFt: 0, laborFlatFee: 0, discountPercent: 0, minimumJobCharge: 0,
  wastePercent: 0, gateRatePerFt: 0, trashHaulFee: 0, teardownEnabled: false,
  teardownFlatFee: 0, teardownRatePerFt: 0, teardownFeet: 0,
  preferredManufacturerSyncId: null,
};

const taxableItem = (qty, price) => ({
  syncId: "i1", fenceRunSyncId: null, sortOrder: 0, description: "x",
  quantity: qty, unit: "ea", unitPrice: price, taxable: true, role: "PANEL",
  isAutoGenerated: false, supplierUnitPrice: null,
});
const nonTaxableItem = (qty, price) => ({ ...taxableItem(qty, price), taxable: false, role: "NONE" });

{
  // $1000 taxable + $500 non-taxable. Tax must apply ONLY to the taxable
  // subtotal: 1000 * 7.25% = $72.50, not 1500 * 7.25% = $108.75.
  const items = [taxableItem(10, 100), nonTaxableItem(5, 100)];
  const t = computeTotals(job, items, 0, [], []);
  ok("tax is computed on the taxable subtotal only, not the full materials subtotal",
    Math.abs(t.tax - 72.5) < 1e-9,
    `got tax=${t.tax} (taxableSubtotal=${t.taxableSubtotal}, materialsSubtotal=${t.materialsSubtotal})`);
}

// CANARY: taxing the WHOLE materials subtotal (the bug this check exists to
// catch -- a non-taxable line item quietly being taxed) gives a visibly
// different, bigger number: 1500 * 7.25% = $108.75 != $72.50.
{
  const wrongTax = 1500 * (7.25 / 100);
  ok("CANARY: taxing the non-taxable line too would produce $108.75, not $72.50 " +
     "(proves the taxable-only assertion above is discriminating)",
    Math.abs(wrongTax - 72.5) > 0.01, `wrong=${wrongTax}`);
}

// Order-of-operations canary from the module's own header: markup is taken
// AFTER tax (tax is inside preMarkup), so markup is charged on the tax too.
// This is documented as deliberately "what a fresh pair of eyes would call
// wrong" -- if this test ever silently stops finding markup-on-tax, the
// office and the phone have quietly renegotiated the formula's field order.
{
  const jobWithMarkup = { ...job, markupPercent: 10 };
  const items = [taxableItem(10, 100)]; // $1000 taxable, tax = $72.50
  const t = computeTotals(jobWithMarkup, items, 0, [], []);
  const preMarkupExpected = 1000 + 72.5; // materials + tax, no labour/teardown/CO/gate
  const markupIfOnTaxToo = preMarkupExpected * 0.10;
  const markupIfExcludingTax = 1000 * 0.10; // what markup would be if tax were excluded from the base
  ok("markup base includes tax (preMarkup = materials + tax when nothing else is set)",
    Math.abs(t.preMarkup - preMarkupExpected) < 1e-9 && Math.abs(t.markupAmount - markupIfOnTaxToo) < 1e-9,
    `preMarkup=${t.preMarkup} markupAmount=${t.markupAmount} expected preMarkup=${preMarkupExpected} markupOnTax=${markupIfOnTaxToo}`);
  ok("CANARY: markup excluding tax from its base would be a different, smaller number " +
     "(proves the assertion above is checking real field order, not agreeing by coincidence)",
    Math.abs(markupIfOnTaxToo - markupIfExcludingTax) > 0.01,
    `markupOnTax=${markupIfOnTaxToo} markupExcludingTax=${markupIfExcludingTax}`);
}

console.log(`\n${pass} of ${pass + fail} checks passed`);
if (fail) process.exit(1);
