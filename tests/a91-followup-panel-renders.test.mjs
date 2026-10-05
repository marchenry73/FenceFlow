// a91: RUN renderFollowUps, in the state his company was actually in.
//
// a89 checks the honesty note is wired into the source. This runs the real
// function and asserts the note is what comes out -- specifically in the state
// that prompted the whole fix: master switch ON, every rule OFF, due-list
// empty. That combination sent no email for the life of the feature while
// looking exactly like it was working.

import { load } from "./a27-pricelist-lib.mjs";

let passed = 0, failed = 0;
const ok = (id, what, cond, detail) => {
  if (cond) { passed++; console.log(`  ok    ${id} ${what}`); }
  else { failed++; console.log(`  FAIL  ${id} ${what}${detail ? " -- " + detail : ""}`); }
};

// renderFollowUps builds the quiet-hours dropdowns with `new Option(...)`,
// which is a DOM constructor. Node has no DOM, so stand one up -- the test is
// about the state note, not about the selects.
globalThis.Option = function (label, value) { return { label, value }; };

const KIND_FIELDS = ["new_lead_not_contacted_enabled", "quote_sent_no_view_enabled",
  "quote_viewed_not_approved_enabled", "approved_no_deposit_enabled"];

function render(settings, { duePreview = [] } = {}) {
  const els = {};
  const el = (id) => (els[id] = els[id] || {
    id, innerHTML: "", textContent: "", className: "", value: "", checked: false,
    disabled: false, style: {}, options: { length: 1 }, appendChild: () => {},
  });
  const scope = {
    $: el,
    canEdit: () => true,
    esc: (s) => String(s == null ? "" : s),
    tr: (k) => k,
    d: (x) => new Date(x),
    jobs: [],
    jobBySync: () => null,
    followUpLog: [],
    fuKindLabel: (k) => k,
    previewDueFollowUps: () => duePreview,
    FOLLOW_UP_KIND_DEFS: KIND_FIELDS.map((f, i) => ({
      key: "k" + i, enabledField: f, delayField: f.replace("_enabled", "_days"),
      labelKey: "lbl" + i, delayLabelKey: "dly" + i,
    })),
    FOLLOW_UP_DEFAULT_SETTINGS: { enabled: false, quiet_hours_start: 21, quiet_hours_end: 8,
      timezone: "America/New_York", daily_cap: 25 },
  };
  const prelude = `let followUpSettings = ${JSON.stringify(settings)};\n`;
  const P = load(["renderFollowUps"], scope, prelude);
  P.renderFollowUps();
  return els;
}

const BASE = { quiet_hours_start: 21, quiet_hours_end: 8, timezone: "America/New_York", daily_cap: 25 };
const allOff = Object.fromEntries(KIND_FIELDS.map((f) => [f, false]));
const oneOn = { ...allOff, quote_viewed_not_approved_enabled: true,
  quote_viewed_not_approved_days: 3 };

console.log("\n1. THE STATE HIS COMPANY WAS ACTUALLY IN: on at the top, every rule off");
{
  let els, threw = null;
  try { els = render({ ...BASE, ...allOff, enabled: true }); } catch (e) { threw = e; }
  ok("1a", "it runs", !threw, threw && threw.message);
  if (!threw) {
    ok("1b", "the note says switched on but nothing will ever send",
      els.fuStateNote.textContent === "fuStateOnButNoRules", els.fuStateNote.textContent);
    ok("1c", "and it is shown, not left hidden", els.fuStateNote.style.display === "");
    ok("1d", "styled as a warning rather than ordinary help text",
      els.fuStateNote.className === "sub bad", els.fuStateNote.className);
    ok("1e", "the empty due-list explains WHY it is empty, instead of implying nobody is waiting",
      els.fuPreviewEmpty.textContent === "fuPreviewEmptyNoRules", els.fuPreviewEmpty.textContent);
  }
}

console.log("\n2. SWITCHED OFF ENTIRELY");
{
  let els, threw = null;
  try { els = render({ ...BASE, ...allOff, enabled: false }); } catch (e) { threw = e; }
  ok("2a", "it runs", !threw, threw && threw.message);
  if (!threw) {
    ok("2b", "the note says follow-ups are off", els.fuStateNote.textContent === "fuStateOff",
      els.fuStateNote.textContent);
    ok("2c", "the due-list still explains itself", els.fuPreviewEmpty.textContent === "fuPreviewEmptyNoRules");
  }
}

console.log("\n3. ON, WITH A RULE ACTUALLY SWITCHED ON");
{
  let els, threw = null;
  try { els = render({ ...BASE, ...oneOn, enabled: true }); } catch (e) { threw = e; }
  ok("3a", "it runs", !threw, threw && threw.message);
  if (!threw) {
    ok("3b", "no warning -- this one really will send", els.fuStateNote.textContent === "",
      els.fuStateNote.textContent);
    ok("3c", "and the note is hidden rather than left as an empty box",
      els.fuStateNote.style.display === "none");
    ok("3d", "an empty due-list now means what it says: nothing due",
      els.fuPreviewEmpty.textContent === "fuPreviewEmptyMsg", els.fuPreviewEmpty.textContent);
  }
}

console.log("\n4. NO SETTINGS ROW AT ALL");
{
  let els, threw = null;
  try { els = render(null); } catch (e) { threw = e; }
  ok("4a", "it runs on a company that has never saved settings", !threw, threw && threw.message);
  if (!threw) ok("4b", "and reads as off", els.fuStateNote.textContent === "fuStateOff");
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
