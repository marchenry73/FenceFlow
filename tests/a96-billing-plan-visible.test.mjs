// THE OWNER COULD NOT SEE WHICH PLAN HE WAS ON.
//
// Reported 5 Oct 2026, in these words: "I am not able to see what plan I am on
// the website or to change it."
//
// He was on Pro, active, with a Stripe subscription. The office knew. It just
// could not keep the fact on the screen, for three reasons that stacked:
//
//   1. #billState carried data-t="billCheckingPlan" -- the placeholder
//      "Checking your plan...". applyStaticText() rewrites EVERY [data-t]
//      element, so each language change put the placeholder back.
//   2. setLang's redraw list was [renderFollowUps, renderAttention]. Billing
//      was not in it, so nothing repainted the line afterwards.
//   3. loadBilling() had exactly one caller, the tail of loadAll() at first
//      page load. switchTab() never called it, so reopening the tab did not
//      refresh it either.
//
// Together: once that line had been reset it never came back without a full
// reload, and the plan is named NOWHERE else on the page. An owner could not
// find out what he was paying for.
//
// Each check below is paired with a mutation that puts the old behaviour back
// and must turn it red. A check that cannot fail is not a check -- the office
// has been bitten by that more than once.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DASH = readFileSync(join(ROOT, "website/dashboard.html"), "utf8");

// A region, not the whole file: a comment elsewhere that merely DISCUSSES
// billing must not be able to satisfy any of these.
const billStateLine = (s) =>
  (s.match(/<p id="billState"[^>]*>/) || [""])[0];

const setLangRedrawList = (s) =>
  (s.match(/for \(const redraw of \[([^\]]*)\]/) || [, ""])[1];

const switchTabBody = (s) => {
  const i = s.indexOf("function switchTab(name){");
  if (i < 0) return "";
  return s.slice(i, s.indexOf("\n}", i));
};

const CHECKS = [
  [
    "#billState carries no data-t, so applyStaticText cannot erase the plan",
    (s) => !/data-t=/.test(billStateLine(s)),
    // Put the data-t back exactly as it was.
    (s) => s.replace(
      '<p id="billState" style="font-size:15px;margin:6px 0 16px">',
      '<p id="billState" style="font-size:15px;margin:6px 0 16px" data-t="billCheckingPlan">'),
  ],
  [
    "setLang repaints billing after a language change",
    (s) => /renderBilling/.test(setLangRedrawList(s)),
    (s) => s.replace(
      "for (const redraw of [renderFollowUps, renderAttention, renderBilling]) {",
      "for (const redraw of [renderFollowUps, renderAttention]) {"),
  ],
  [
    "opening the Billing tab asks the server again",
    (s) => /name===.billing.\)\s*loadBilling\(\)/.test(switchTabBody(s)),
    (s) => s.replace(
      "if(name==='billing') loadBilling().catch(e=>console.error('loadBilling threw:', e));",
      ""),
  ],
  [
    "renderBilling paints from a cache, so the redraw costs no network call",
    (s) => /function renderBilling\(\)\s*\{[\s\S]{0,200}?billingAnswer/.test(s),
    // Make it fetch instead -- which is what setLang's own comment forbids,
    // and which would also escape that loop's try/catch, being async.
    (s) => s.replace(
      "function renderBilling(){\n  if (!billingAnswer) return;\n  const { data, error } = billingAnswer;",
      "async function renderBilling(){\n  const { data, error } = await db.rpc('my_billing_status');"),
  ],
  [
    "renderBilling is synchronous, so setLang's try/catch can actually catch it",
    (s) => /\n function renderBilling\(\)|\nfunction renderBilling\(\)/.test(s),
    (s) => s.replace("\nfunction renderBilling(){", "\nasync function renderBilling(){"),
  ],
  [
    "loadBilling still does the three follow-on loads it owns",
    (s) => /async function loadBilling\(\)\{[\s\S]{0,400}?loadJobPayments\(\)[\s\S]{0,200}?loadSeats\(\)[\s\S]{0,200}?loadDeviceKeys\(\)/.test(s),
    // Dropping them is the obvious way to break this while the plan line
    // still looks right: seats and device keys would quietly stop loading.
    (s) => s.replace("  await loadJobPayments();\n  await loadSeats();\n  await loadDeviceKeys();\n}", "}"),
  ],
];

test("the plan stays on the screen", () => {
  const broken = CHECKS.filter(([, holds]) => !holds(DASH)).map(([name]) => name);
  assert.deepEqual(broken, [], "these no longer hold:\n  " + broken.join("\n  "));
});

test("TEETH: each check turns red when the old behaviour is put back", () => {
  const toothless = [];
  for (const [name, holds, mutate] of CHECKS) {
    const mutated = mutate(DASH);
    if (mutated === DASH) { toothless.push(`${name} -- the mutation changed nothing`); continue; }
    if (holds(mutated)) toothless.push(`${name} -- survived its own mutation`);
  }
  assert.deepEqual(toothless, [], "checks that cannot fail:\n  " + toothless.join("\n  "));
});

// The plan is still named in exactly one place on the page. That is the reason
// all of the above mattered so much: there is no second place to read it off.
// Not asserted as a requirement -- a header chip would be a fine thing to add
// -- but recorded so that whoever adds one knows this test exists.
test("the Billing panel is still the only place the plan is named", () => {
  const mentions = (DASH.match(/billState/g) || []).length;
  assert.ok(mentions >= 2, "expected #billState to be declared and written to");
});
