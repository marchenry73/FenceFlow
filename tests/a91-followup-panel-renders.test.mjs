// a91: RUN renderFollowUps, in the state his company was actually in.
//
// a89 checks the honesty note is wired into the source. This runs the real
// function and asserts the note is what comes out -- specifically in the state
// that prompted the whole fix: master switch ON, every rule OFF, due-list
// empty. That combination sent no email for the life of the feature while
// looking exactly like it was working.

import { load } from "./a27-pricelist-lib.mjs";
import { dueFollowUp } from "../website/js/lib/follow-ups.mjs";

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

// Two real shapes, close to his actual data: somebody who opened a quote and
// went quiet, and somebody who approved without paying the deposit. Both have
// an email, because dueFollowUp refuses a job without one and a count that
// included them would be a count of emails that cannot be sent.
const WAITING_JOBS = [
  { sync_id: "a", email: "a@example.com", status: "SENT",
    quote_sent_at: "2026-09-01T00:00:00Z", quote_viewed_at: "2026-09-01T00:00:00Z",
    first_contact_at: "2026-09-01T00:00:00Z" },
  { sync_id: "b", email: "b@example.com", status: "SENT",
    quote_approved_at: "2026-09-01T00:00:00Z", deposit_amount: 500, amount_paid: 0,
    first_contact_at: "2026-09-01T00:00:00Z" },
  // No email: must NOT be counted, because it could never be sent one.
  { sync_id: "c", email: "", status: "SENT",
    quote_sent_at: "2026-09-01T00:00:00Z", quote_viewed_at: "2026-09-01T00:00:00Z",
    first_contact_at: "2026-09-01T00:00:00Z" },
];

function render(settings, { duePreview = [], jobs = WAITING_JOBS, sentLog = [] } = {}) {
  const els = {};
  const el = (id) => (els[id] = els[id] || {
    id, innerHTML: "", textContent: "", className: "", value: "", checked: false,
    disabled: false, style: {}, options: { length: 1 }, appendChild: () => {},
  });
  const scope = {
    $: el,
    canEdit: () => true,
    esc: (s) => String(s == null ? "" : s),
    // The key, plus any arguments appended, so a count passed through tr() is
    // visible in the rendered output and can be asserted on. Returning the
    // bare key swallowed it, which is how the counter went untested at first.
    tr: (k, ...a) => (a.length ? k + ":" + a.join(",") : k),
    d: (x) => new Date(x),
    jobs,
    dueFollowUp,            // the real one, not a stub that would agree with me
    jobBySync: () => null,
    followUpLog: sentLog,
    fuKindLabel: (k) => k,
    previewDueFollowUps: () => duePreview,
    FOLLOW_UP_KIND_DEFS: KIND_FIELDS.map((f, i) => ({
      // The REAL rule key, not a made-up one. follow_up_log rows carry this
      // exact string in their `kind` column, so a stub of "k0" made the
      // already-sent lookup miss every time and the test failed against
      // working code.
      key: f.replace("_enabled", ""), enabledField: f, delayField: f.replace("_enabled", "_days"),
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

// The delay fields are part of BASE, not optional. dueFollowUp compares
// `daysSince(...) >= settings.<rule>_days`, and `n >= undefined` is false --
// so a fixture without them answers "nobody is waiting" for every rule, for
// a reason that has nothing to do with the code under test. A real row always
// carries them (the live values are 4h / 2d / 3d / 2d).
const BASE = {
  quiet_hours_start: 21, quiet_hours_end: 8, timezone: "America/New_York", daily_cap: 25,
  new_lead_not_contacted_hours: 4,
  quote_sent_no_view_days: 2,
  quote_viewed_not_approved_days: 3,
  approved_no_deposit_days: 2,
};
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
    // Its OWN message, not the no-rule-ticked one. Saying "no rule is switched
    // on" to somebody whose master switch is off is both wrong and points them
    // at the wrong control.
    ok("2c", "the due-list says follow-ups are OFF, which is a different thing from no rule being ticked",
      els.fuPreviewEmpty.textContent === "fuPreviewEmptyOff", els.fuPreviewEmpty.textContent);
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

console.log("\n4. HOW MANY ARE WAITING BEHIND EACH CHECKBOX");
{
  // The point of the counter: with every rule OFF the due-list is empty and
  // the four checkboxes are abstractions. These counts turn "tick it and find
  // out" into "tick it and one email goes to this person".
  let els, threw = null;
  try { els = render({ ...BASE, ...allOff, enabled: true }); } catch (e) { threw = e; }
  ok("4a", "the counter runs -- with jobs: [] its loop never executed, so this was untested",
    !threw, threw && threw.message);
  if (!threw) {
    const rows = els.fuRulesRows.innerHTML;
    ok("4b", "a rule with somebody waiting says how many", /fuRuleWaiting:1/.test(rows), rows.slice(0, 300));
    ok("4c", "exactly two rules have one person waiting each",
      (rows.match(/fuRuleWaiting:1/g) || []).length === 2,
      "found " + (rows.match(/fuRuleWaiting:\d+/g) || []).join(" "));
    ok("4d", "the other two say none waiting, rather than showing nothing at all",
      (rows.match(/fuRuleWaitingNone/g) || []).length === 2);
    // The third fixture job has no email, and dueFollowUp refuses those. A
    // count that included it would be a count of emails that cannot be sent.
    ok("4e", "a job with no email is NOT counted", !/fuRuleWaiting:2/.test(rows));
  }
}

{
  // The count must not depend on the rule being ticked -- that is the entire
  // point of it. Turning one on must not change what any of them report.
  const off = render({ ...BASE, ...allOff, enabled: true }).fuRulesRows.innerHTML;
  const on = render({ ...BASE, ...oneOn, enabled: true }).fuRulesRows.innerHTML;
  const nums = (h) => (h.match(/fuRuleWaiting:\d+/g) || []).join();
  ok("4f", "the counts are the same ticked or not -- it answers 'what would this do'",
    nums(off) === nums(on), nums(off) + " vs " + nums(on));
}

{
  // Already sent is not waiting. Without this the number sticks at its opening
  // value for ever once a rule is on: "2 waiting" that never falls as the two
  // go out, because the sender will not send the same (job, kind) twice.
  const els = render({ ...BASE, ...allOff, enabled: true },
    { sentLog: [{ job_sync_id: "a", kind: "quote_viewed_not_approved", sent_at: "2026-10-01T00:00:00Z" }] });
  const rows = els.fuRulesRows.innerHTML;
  ok("4g", "a job already emailed for that rule stops being counted as waiting",
    (rows.match(/fuRuleWaiting:1/g) || []).length === 1,
    "found " + (rows.match(/fuRuleWaiting:\d+/g) || []).join(" "));
  ok("4h", "and the rule it was sent for now says none waiting, not one",
    (rows.match(/fuRuleWaitingNone/g) || []).length === 3);
  // The log is keyed on job AND kind: the same job still counts for a
  // different rule, which is a separate email the sender would still send.
  const other = render({ ...BASE, ...allOff, enabled: true },
    { sentLog: [{ job_sync_id: "a", kind: "approved_no_deposit", sent_at: "2026-10-01T00:00:00Z" }] });
  ok("4i", "a send of a DIFFERENT rule does not suppress this one",
    (other.fuRulesRows.innerHTML.match(/fuRuleWaiting:1/g) || []).length === 2);
}

console.log("\n5. NO SETTINGS ROW AT ALL");
{
  let els, threw = null;
  try { els = render(null); } catch (e) { threw = e; }
  ok("5a", "it runs on a company that has never saved settings", !threw, threw && threw.message);
  if (!threw) ok("5b", "and reads as off", els.fuStateNote.textContent === "fuStateOff");
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
