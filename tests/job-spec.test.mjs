// The HOA letter and the words it puts in front of an association board.
//
// Pure: imports only supabase/functions/_shared/job-spec.ts, which measures
// nothing and decodes nothing -- every figure is handed in, from the one
// pricing engine, via price-job's dry run. It imports no engine code at all,
// because only ONE edge function may bundle the engine (tests/a94), and an
// earlier version of it reached for the engine's gate decoder and so put a
// second copy of engine code in a second function while still passing that
// check. No Deno, no network, no clock. No email is sent by this file.
//
// Run with:  node --test tests/job-spec.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  describeJob,
  hoaLetter,
  fenceTypeWords,
  feet,
} from "../supabase/functions/_shared/job-spec.ts";

const run = (over = {}) => ({
  sync_id: "r1",
  label: "Back",
  fence_type: "VINYL_PRIVACY",
  color_or_finish: "White",
  panel_height_ft: 6,
  post_spacing_ft: 8,
  concrete_bags_per_post: 1,
  is_teardown: false,
  sort_order: 0,
  ...over,
});

const job = (over = {}) => ({
  customer_name: "Pat Homeowner",
  address: "123 Palm Row, Riverview FL",
  hoa_name: "Palm Row Association",
  teardown_feet: 0,
  ...over,
});

/** One run's measurements, as price-job reports them. */
const m = (feet, gateCount = 0, gateFeet = 0) => ({ feet, gateCount, gateFeet });

const company = {
  name: "Fence solutions",
  license_no: "CGC123456",
  phone: "813-555-0100",
  email: "marc@fenceflowapp.com",
};

// ---------------------------------------------------------------------------
// It describes; it does not measure.
// ---------------------------------------------------------------------------

test("every length comes from the engine, never from this module", () => {
  const spec = describeJob(job(), [run()], { r1: m(61.5) });
  assert.equal(spec.totalFeet, 61.5);
  assert.equal(spec.sides[0].feet, 61.5);
});

test("a run with no measurement shows a gap, it does not invent a length", () => {
  // An HOA letter that makes up a figure is worse than one with an obvious
  // hole in it: the hole gets a phone call, the invention gets approved.
  const spec = describeJob(job(), [run()], {});
  assert.equal(spec.sides[0].feet, 0);
  assert.equal(spec.totalFeet, 0);
});

test("teardown is reported as a removal, never added to the new fence", () => {
  const spec = describeJob(job(), [
    run({ sync_id: "a" }),
    run({ sync_id: "b", is_teardown: true }),
  ], { a: m(100), b: m(40) });

  assert.equal(spec.totalFeet, 100, "the fence coming out was billed as fence going up");
  assert.equal(spec.teardownFeet, 40);
  assert.equal(spec.sides.length, 1, "the teardown run was listed as a section being built");
});

test("an explicit teardown figure on the job wins over summing the runs", () => {
  const spec = describeJob(job({ teardown_feet: 55 }), [
    run({ sync_id: "a" }),
    run({ sync_id: "b", is_teardown: true }),
  ], { a: m(100), b: m(40) });
  assert.equal(spec.teardownFeet, 55);
});

// ---------------------------------------------------------------------------
// The mixed-height job -- the thing an HOA actually asks about.
// ---------------------------------------------------------------------------

test("a 4ft and 6ft job states both heights, and never an average", () => {
  const spec = describeJob(job(), [
    run({ sync_id: "a", panel_height_ft: 6 }),
    run({ sync_id: "b", panel_height_ft: 4, label: "Front" }),
  ], { a: m(80), b: m(40) });

  assert.deepEqual(spec.heights, [4, 6]);

  const { text } = hoaLetter(spec, company);
  assert.match(text, /Heights: 4 ft and 6 ft, by section\./);
  assert.ok(!/5 ft/.test(text), "an averaged height appeared in the letter");
});

test("one height reads as one height", () => {
  const spec = describeJob(job(), [run()], { r1: m(61.5) });
  assert.match(hoaLetter(spec, company).text, /Height: 6 ft\./);
});

// ---------------------------------------------------------------------------
// Gates, decoded by the engine's own parser.
// ---------------------------------------------------------------------------

test("one gate reads as its exact width", () => {
  // With a single gate the engine's total IS that gate's width.
  const spec = describeJob(job(), [run()], { r1: m(61.5, 1, 4) });
  assert.equal(spec.gates.count, 1);
  assert.match(hoaLetter(spec, company).text, /One gate, 4 ft\./);
});

test("two gates give a count and the total opening, not an invented pair", () => {
  // Individual widths would mean decoding the gate list here, which is engine
  // code. The count and the total are figures the engine itself produced.
  const spec = describeJob(job(), [run()], { r1: m(61.5, 2, 14) });
  const { text } = hoaLetter(spec, company);
  assert.match(text, /2 gates, 14 ft of opening\./);
  assert.ok(!/7 ft/.test(text), "the total was split into an average width");
});

test("gates add up across sides", () => {
  const spec = describeJob(job(), [
    run({ sync_id: "a" }),
    run({ sync_id: "b", label: "Front" }),
  ], { a: m(80, 1, 4), b: m(40, 1, 10) });
  assert.equal(spec.gates.count, 2);
  assert.equal(spec.gates.feetTotal, 14);
});

test("no gates says so, rather than leaving the question open", () => {
  const spec = describeJob(job(), [run()], { r1: m(61.5) });
  assert.match(hoaLetter(spec, company).text, /No gates\./);
});

// ---------------------------------------------------------------------------
// Words a board can read.
// ---------------------------------------------------------------------------

test("database constants are turned into English", () => {
  assert.equal(fenceTypeWords("VINYL_PRIVACY"), "Vinyl privacy");
  assert.equal(fenceTypeWords("CHAIN_LINK"), "Chain link");
  assert.equal(fenceTypeWords("ALUMINUM_ORNAMENTAL"), "Ornamental aluminum");
});

test("an unknown fence type is still shown, never dropped or guessed", () => {
  // A type nobody has taught this function must appear in the letter: the
  // alternative is a specification with a section missing.
  assert.equal(fenceTypeWords("COMPOSITE_HORIZONTAL"), "Composite horizontal");
  const spec = describeJob(job(), [run({ fence_type: "COMPOSITE_HORIZONTAL" })], { r1: m(50) });
  assert.match(hoaLetter(spec, company).text, /Composite horizontal/);
});

test("feet print without a pointless decimal", () => {
  assert.equal(feet(120), "120 ft");
  assert.equal(feet(61.5), "61.5 ft");
  assert.equal(feet(61.46), "61.5 ft");
});

// ---------------------------------------------------------------------------
// The letter as a whole.
// ---------------------------------------------------------------------------

test("the letter carries the facts an HOA asks for", () => {
  const spec = describeJob(job(), [
    run({ sync_id: "a" }),
    run({ sync_id: "b", label: "Front", panel_height_ft: 4 }),
  ], { a: m(120), b: m(36, 1, 10) });

  const { subject, text, html } = hoaLetter(spec, company);

  assert.match(subject, /123 Palm Row/);
  for (const must of [
    "123 Palm Row, Riverview FL",
    "Pat Homeowner",
    "Palm Row Association",
    "156 ft",            // the total, summed from what the engine gave
    "CGC123456",         // the contractor's license
    "Fence solutions",
    "posts at 8 ft on center",
    "posts set in concrete",
  ]) {
    assert.ok(text.includes(must), `the letter is missing: ${must}`);
  }
  // Both sections appear by name.
  assert.match(text, /Back: 120 ft/);
  assert.match(text, /Front: 36 ft/);
  // And the HTML carries the same block, escaped.
  assert.match(html, /123 Palm Row/);
});

test("a missing license or phone leaves the line out instead of printing blank", () => {
  const spec = describeJob(job(), [run()], { r1: m(61.5) });
  const { text } = hoaLetter(spec, { name: "Fence solutions" });
  assert.ok(!/License:/.test(text), "an empty license line was printed");
  assert.ok(!/Phone:/.test(text), "an empty phone line was printed");
  assert.match(text, /Fence solutions/);
});

test("html is escaped, so a company name with a bracket cannot break the letter", () => {
  const spec = describeJob(job({ customer_name: "A <b>Name</b>" }), [run()], { r1: m(10) });
  const { html } = hoaLetter(spec, company);
  assert.ok(html.includes("&lt;b&gt;Name&lt;/b&gt;"), "the name was not escaped");
  assert.ok(!html.includes("<b>Name</b>"), "raw markup from a customer name reached the html");
});

test("nothing in the letter is addressed to the HOA by the contractor", () => {
  // It goes to the CUSTOMER to forward. An approval request has to come from
  // the homeowner who owns the lot, not from the company building the fence.
  const spec = describeJob(job(), [run()], { r1: m(61.5) });
  const { text } = hoaLetter(spec, company);
  assert.match(text, /ready to forward/);
  assert.ok(!/Dear (Board|Association)/i.test(text));
});
