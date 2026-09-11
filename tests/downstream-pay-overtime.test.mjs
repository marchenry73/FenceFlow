// SS36 "Data integrity across every calculation": estimated pay, including
// the overtime split.
//
// This one is NOT a parity check between the app and the office, because
// there is no app-side equivalent to check against: overtime exists only in
// website/dashboard.html's renderPay(). Grepping the whole repo for
// "overtime" turns up nothing under app/src or supabase/functions -- CrewPay.kt
// (the app's pay engine) computes straight hours * rate with no weekly
// threshold or multiplier at all. That is reported as a finding below, not
// fixed here (out of scope: this file only adds tests).
//
// So what this file guards is the ONE calculation that exists: the office's
// own weekly overtime split, run for real (not hand-copied) by pulling the
// actual renderPay() function out of dashboard.html and driving it with a
// stub DOM, exactly the way tests/office-pricing.test.mjs pulls out
// pricedByReadout/officePricingErrorMessage. This is the same code a
// contractor's browser runs -- not a reimplementation that could quietly
// drift from it.
//
// Units: hours are plain float hours, rate is dollars/hour, gross is
// dollars (rendered through money(), which formats plain numbers -- no
// cents scaling anywhere in this file's chain of functions).
//
//   npx tsx tests/downstream-pay-overtime.test.mjs
import { readFileSync } from "node:fs";

const src = readFileSync("website/dashboard.html", "utf8");

const grabFn = (name) => {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("not found: " + name);
  let i = src.indexOf("{", start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
};

const grabConst = (name) => {
  const m = src.match(new RegExp("const " + name + "\\s*=\\s*([0-9.]+);"));
  if (!m) throw new Error("not found: const " + name);
  return m[0];
};

/**
 * Builds a runnable renderPay() bound to a fake DOM and a fake `times`/
 * `employees` array, so the REAL function body (not a copy) can be driven
 * from a plain array of shifts and its actual output rows read back.
 *
 * withRenderPay(shifts, employees) -> array of {who, weekOf, reg, ot, rate, gross}
 */
function withRenderPay(shifts, employees, ot = { otAfter: 40, otMult: 1.5 }) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, { id, style: {}, textContent: "", innerHTML: "" });
    return elements.get(id);
  };
  const code = [
    grabConst("OT_AFTER_HOURS"),
    grabConst("OT_MULTIPLIER"),
    grabFn("weekStart"),
    grabFn("hoursOf"),
    grabFn("shiftWhoName"),
    grabFn("renderPay"),
  ].join("\n\n");
  const fn = new Function(
    "times", "employees", "d", "$", "esc", "money", "ot",
    code + "\nrenderPay(ot);\nreturn {rowsHtml: $('payWeekRows').innerHTML};"
  );
  const d = (s) => (s ? new Date(s) : null);
  const esc = (s) => String(s ?? "");
  const money = (n) => "$" + Number(n).toFixed(2);
  const $ = el;
  const result = fn(shifts, employees, d, $, esc, money, ot);
  return { rowsHtml: result.rowsHtml };
}

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
};

const EMP = [{ sync_id: "e1", name: "Alex" }];
// A single week (Sun-Sat), one employee, 46 hours worked at $20/hr across
// two shifts so the rate-weighting logic also runs.
const shift = (startIso, hours, rate) => ({
  employee_sync_id: "e1",
  started_at: startIso,
  ended_at: new Date(new Date(startIso).getTime() + hours * 3600000).toISOString(),
  hourly_rate: rate,
});

console.log("\n1. The 40-hour weekly threshold and 1.5x multiplier, run for real:");
{
  // Monday 2026-09-07 (a Monday; week start is Sunday 2026-09-06).
  // 30 hrs at $20/hr, then 16 hrs at $20/hr -> 46 total.
  // reg = min(46,40) = 40, ot = 46-40 = 6.
  // gross = 40*20 + 6*20*1.5 = 800 + 180 = 980.
  const shifts = [
    shift("2026-09-07T08:00:00.000Z", 30, 20),
    shift("2026-09-10T08:00:00.000Z", 16, 20),
  ];
  const { rowsHtml } = withRenderPay(shifts, EMP);
  ok("46 hours at $20/hr splits into 40 regular + 6 overtime",
    rowsHtml.includes(">40.00<") && rowsHtml.includes(">6.00<"),
    `rows: ${rowsHtml}`);
  ok("gross pay includes the 1.5x overtime premium ($980.00, not $920.00 straight-time)",
    rowsHtml.includes("$980.00"),
    `rows: ${rowsHtml}`);
}

console.log("\n2. Under the 40-hour threshold: no overtime at all:");
{
  const shifts = [shift("2026-09-07T08:00:00.000Z", 35, 25)];
  const { rowsHtml } = withRenderPay(shifts, EMP);
  // reg=35, ot=0 -> shown as an em dash, not "0.00".
  ok("35 hours shows all-regular, overtime column reads as an em dash (no phantom OT)",
    rowsHtml.includes(">35.00<") && rowsHtml.includes(">—<"),
    `rows: ${rowsHtml}`);
  ok("gross is plain straight time: 35 * $25 = $875.00",
    rowsHtml.includes("$875.00"), `rows: ${rowsHtml}`);
}

console.log("\n3. Exactly 40 hours is the boundary, not the first overtime hour:");
{
  const shifts = [shift("2026-09-07T08:00:00.000Z", 40, 10)];
  const { rowsHtml } = withRenderPay(shifts, EMP);
  ok("exactly 40 hours is entirely regular (reg=40.00, no OT) -- the threshold is > 40, not >= 40",
    rowsHtml.includes(">40.00<") && rowsHtml.includes(">—<") && rowsHtml.includes("$400.00"),
    `rows: ${rowsHtml}`);
}

// ---------------------------------------------------------------------------
// CANARIES: plant the wrong rule in the SAME source string this file grabs
// from, one substitution at a time, and prove the resulting number is
// visibly wrong before trusting the passing checks above.
console.log("\n4. Canaries -- plant a wrong OT rule and watch it misfire:");

{
  // PLANTED FAILURE 1: multiplier of 1.0 (i.e. no overtime premium at all --
  // the bug this feature exists to prevent, silently paying straight time
  // for overtime hours). renderPay(ot) takes the multiplier as data (so a
  // company setting can override the federal default), so planting the bug
  // means passing the broken ot object through the REAL, unmodified
  // renderPay body -- exactly how a bad company_settings row would misfire
  // in production.
  const shifts = [shift("2026-09-07T08:00:00.000Z", 30, 20), shift("2026-09-10T08:00:00.000Z", 16, 20)];
  const { rowsHtml } = withRenderPay(shifts, EMP, { otAfter: 40, otMult: 1.0 });
  ok("PLANTED FAILURE: otMult=1.0 pays $920.00 straight time instead of the " +
     "correct $980.00 with the 1.5x premium (proves this check can fail)",
    rowsHtml.includes("$920.00") && !rowsHtml.includes("$980.00"),
    `rows: ${rowsHtml}`);
}
{
  // PLANTED FAILURE 2: threshold moved to 30 hours instead of 40 -- proves
  // the "exactly 40 hours has no OT" check above is load-bearing, not
  // accidentally true for any threshold.
  const shifts = [shift("2026-09-07T08:00:00.000Z", 40, 10)];
  const { rowsHtml } = withRenderPay(shifts, EMP, { otAfter: 30, otMult: 1.5 });
  ok("PLANTED FAILURE: a 30-hour threshold wrongly finds 10 hours of overtime on a " +
     "40-hour week that should be all-regular (proves the boundary check can fail)",
    rowsHtml.includes(">10.00<"),
    `rows: ${rowsHtml}`);
}

console.log(`\n${pass} of ${pass + fail} checks passed`);
console.log(
  "\nFINDING (not fixed here, per scope): there is no overtime concept anywhere in the " +
  "app -- CrewPay.kt pays hours * rate with no weekly threshold or multiplier. The " +
  "office's 'estimated pay' card can show overtime the phone's own pay screen never " +
  "will for the same shift. This may be intentional (the office card is explicitly " +
  "labelled an estimate the app makes no claim about), but it means 'pay' is not a " +
  "figure with one true answer across the two halves the way price, tax and deposit " +
  "are -- worth confirming with the person who owns crew pay before treating any " +
  "future app-side payroll feature as a two-line port."
);
if (fail) process.exit(1);
