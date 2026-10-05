// a90: ACTUALLY RUN renderAttention, rather than grepping at it.
//
// a86 checks the panel is wired to the right RPCs and tables. It cannot tell
// whether the function RUNS -- and that is the real risk, because the office
// cannot be driven headlessly without a login, so every change to this panel
// has so far gone live unexercised.
//
// So this lifts the real function out of the page with a27's loader (the same
// mechanism the price-list tests use), hands it a small fake DOM, and asserts
// on the HTML it produces in each of the three states it has to distinguish.
// A thrown exception here is a thrown exception in his browser.

import { load } from "./a27-pricelist-lib.mjs";
// The REAL quiet-hours logic, not a stub: whether an empty list is meaningful
// overnight depends on it, so a stub that agreed with me would prove nothing.
import { isQuietHour, approximateUtcOffsetHours } from "../website/js/lib/follow-ups.mjs";

let passed = 0, failed = 0;
const ok = (id, what, cond, detail) => {
  if (cond) { passed++; console.log(`  ok    ${id} ${what}`); }
  else { failed++; console.log(`  FAIL  ${id} ${what}${detail ? " -- " + detail : ""}`); }
};

/** The few page globals renderAttention reaches for. */
function makeScope({ canEditValue = true, canSeeMoneyValue = true } = {}) {
  const els = {};
  const el = (id) => (els[id] = els[id] || {
    id, innerHTML: "", style: {}, className: "", textContent: "",
    querySelectorAll: () => [],
  });
  return {
    els,
    scope: {
      $: el,
      canEdit: () => canEditValue,
      esc: (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
      // Returns the key itself, so an assertion can name the key rather than
      // its English wording -- the wording is office-language-parity's job.
      tr: (k) => k,
      ALERT_DEFS: [{ key: "no_deposit", labelKey: "alertNoDeposit" }],
      jobBySync: (sid) => (sid === "job-1" ? { customer_name: "Makayla" } : null),
      d: (x) => new Date(x),
      canSeeMoney: () => canSeeMoneyValue,
      isQuietHour,
      approximateUtcOffsetHours,
      setAttentionEnabled: () => {},
      clearAttentionFinding: () => {},
    },
  };
}

function render({ settings, findings, canEditValue = true, canSeeMoneyValue = true, readFailed = false }) {
  const { els, scope } = makeScope({ canEditValue, canSeeMoneyValue });
  const prelude =
    `let attentionSettings = ${JSON.stringify(settings)};\n` +
    `let attentionFindings = ${JSON.stringify(findings)};\n` +
    // Whether the findings read ANSWERED. An empty array looks identical
    // whether the company is clear or the request failed.
    `let attentionReadFailed = ${JSON.stringify(readFailed)};\n`;
  const P = load(["renderAttention"], scope, prelude);
  P.renderAttention();           // throws here = throws in his browser
  return els;
}

console.log("\n1. SWITCHED OFF");
{
  let els, threw = null;
  try { els = render({ settings: null, findings: [] }); } catch (e) { threw = e; }
  ok("1a", "it runs with no settings row at all (null means off)", !threw, threw && threw.message);
  if (!threw) {
    ok("1b", "the switch offers to turn it ON", els.attnSwitch.innerHTML.includes("attnTurnOn"));
    ok("1c", "and says nothing is being checked", els.attnSwitch.innerHTML.includes("attnOffNow"));
    ok("1d", "the list does NOT render as empty -- it explains that nothing is watching",
      els.attnRows.innerHTML.includes("attnOffMeansBlind"));
    ok("1e", "and it is marked urgent, so off does not look calm",
      els.attnSwitch.innerHTML.includes("brief-row urgent"));
  }
}

console.log("\n2. SWITCHED ON, NOTHING OPEN");
{
  let els, threw = null;
  try { els = render({ settings: { enabled: true }, findings: [] }); } catch (e) { threw = e; }
  ok("2a", "it runs", !threw, threw && threw.message);
  if (!threw) {
    ok("2b", "the switch offers to turn it off", els.attnSwitch.innerHTML.includes("attnTurnOff"));
    ok("2c", "the list says nothing needs him, AND when it last looked",
      els.attnRows.innerHTML.includes("attnNoneOpen"));
    ok("2d", "this is a DIFFERENT message from the switched-off one, which is the whole point",
      !els.attnRows.innerHTML.includes("attnOffMeansBlind"));
    ok("2e", "and the row is not urgent when it is on",
      !els.attnSwitch.innerHTML.includes("brief-row urgent"));
  }
}

console.log("\n3. SWITCHED ON, SOMETHING OPEN");
{
  const findings = [
    { id: "f1", job_sync_id: "job-1", detector: "no_deposit", severity: "critical",
      message: "Approved with no deposit collected: Makayla", created_at: "2026-10-04T12:00:00Z" },
    { id: "f2", job_sync_id: "job-gone", detector: "made_up_detector", severity: "warn",
      message: "Something else", created_at: "2026-10-04T13:00:00Z" },
  ];
  let els, threw = null;
  try { els = render({ settings: { enabled: true }, findings }); } catch (e) { threw = e; }
  ok("3a", "it runs with findings", !threw, threw && threw.message);
  if (!threw) {
    const h = els.attnRows.innerHTML;
    ok("3b", "a known detector shows its human label, not its key", h.includes("alertNoDeposit"));
    ok("3c", "an UNKNOWN detector falls back to its key rather than rendering undefined",
      h.includes("made_up_detector") && !h.includes("undefined"));
    ok("3d", "the job's customer name is shown", h.includes("Makayla"));
    ok("3e", "a finding whose job is gone does not break the row -- it says so",
      h.includes("jobGoneLabel"));
    ok("3f", "critical is marked urgent and warn is not, so severity is not colour alone",
      (h.match(/brief-row urgent/g) || []).length === 1);
    ok("3g", "each finding carries a Clear button bound to its own id",
      h.includes('data-id="f1"') && h.includes('data-id="f2"'));
    ok("3h", "the message itself is rendered", h.includes("Approved with no deposit collected"));
  }
}

console.log("\n4. SOMEBODY WHO CANNOT CHANGE IT");
{
  let els, threw = null;
  try { els = render({ settings: null, findings: [], canEditValue: false }); } catch (e) { threw = e; }
  ok("4a", "it runs", !threw, threw && threw.message);
  if (!threw) {
    ok("4b", "the toggle is disabled rather than offered and then refused",
      els.attnSwitch.innerHTML.includes("disabled"));
    ok("4c", "and it says who can change it, instead of going quietly dead",
      els.attnSwitch.innerHTML.includes("attnCannotFlip"));
  }
}

console.log("\n6. AN EMPTY LIST MEANS THREE DIFFERENT THINGS");
{
  // The panel exists to stop an empty list reading as good news, and it was
  // doing exactly that in two cases it could detect and did not.

  // (a) attention_findings carries a RESTRICTIVE select policy requiring
  //     SEE_MONEY, which returns zero rows with no error. The Automation tab
  //     is gated by plan, not by role, so a foreman can be standing here.
  let els = render({ settings: { enabled: true }, findings: [], canSeeMoneyValue: false });
  ok("6a", "somebody who may not READ the findings is told so, not told there are none",
    els.attnRows.innerHTML.includes("attnHiddenFromYou"), els.attnRows.innerHTML.slice(0, 140));
  ok("6b", "and NOT shown the all-clear wording",
    !els.attnRows.innerHTML.includes("attnNoneOpen"));

  // (b) attention-sweep checks isQuietHour and `continue`s BEFORE the insert,
  //     so in the quiet window nothing is RECORDED -- the push is not merely
  //     held back. Build a window that certainly contains now, in UTC so the
  //     offset is zero and the test does not depend on where it runs.
  // The window has to be built in the SAME local hour the panel will compute,
  // which means going through approximateUtcOffsetHours rather than assuming.
  // The first version of this used timezone "UTC" and an offset of 0 -- but
  // that function does not recognise "UTC" and falls back to Eastern (-5), so
  // the window missed the current hour by five and the test failed against
  // perfectly good code.
  const TZ = "America/New_York";
  const localH = (new Date().getUTCHours() + approximateUtcOffsetHours(TZ) + 24) % 24;
  const quiet = { enabled: true, timezone: TZ, quiet_hours_start: localH, quiet_hours_end: (localH + 2) % 24 };
  els = render({ settings: quiet, findings: [] });
  ok("6c", "inside quiet hours it says nothing is being recorded, rather than nothing is open",
    els.attnRows.innerHTML.includes("attnQuietHours"), els.attnRows.innerHTML.slice(0, 140));

  // (c) Outside the window, for somebody allowed to see them, empty finally
  //     does mean empty.
  const awake = { enabled: true, timezone: TZ, quiet_hours_start: (localH + 2) % 24, quiet_hours_end: (localH + 3) % 24 };
  els = render({ settings: awake, findings: [] });
  ok("6d", "outside quiet hours, and allowed to see them, empty really is all clear",
    els.attnRows.innerHTML.includes("attnNoneOpen") &&
    !els.attnRows.innerHTML.includes("attnQuietHours"), els.attnRows.innerHTML.slice(0, 140));

  // The order matters: a foreman inside quiet hours must get the permission
  // message, because that one is true of them all night and all day.
  els = render({ settings: quiet, findings: [], canSeeMoneyValue: false });
  ok("6e", "permission beats quiet hours -- the one that is true around the clock wins",
    els.attnRows.innerHTML.includes("attnHiddenFromYou"));

  // (d) And the fourth: the read did not answer at all. loadAttentionState
  //     swallows an error and leaves the array empty, which is identical to a
  //     company with nothing wrong.
  els = render({ settings: awake, findings: [], readFailed: true });
  ok("6f", "a FAILED read says the question failed, rather than reporting all clear",
    els.attnRows.innerHTML.includes("attnCouldNotAsk") &&
    !els.attnRows.innerHTML.includes("attnNoneOpen"), els.attnRows.innerHTML.slice(0, 140));
}

console.log("\n7. THE CLEAR BUTTON IS ONLY OFFERED TO SOMEBODY WHO MAY USE IT");
{
  const findings = [{ id: "f1", job_sync_id: "job-1", detector: "no_deposit", severity: "warn",
    message: "x", created_at: "2026-10-04T12:00:00Z" }];
  // Findings are readable by anyone with SEE_MONEY, which includes SALES, but
  // clearAttentionFinding() starts `if (!canEdit()) return;`. A live-looking
  // button that silently does nothing is the thing this panel is against.
  const canEdit = render({ settings: { enabled: true }, findings, canEditValue: true });
  const cannot = render({ settings: { enabled: true }, findings, canEditValue: false });
  ok("7a", "an owner or manager gets the Clear button", canEdit.attnRows.innerHTML.includes("attn-clear"));
  ok("7b", "somebody the server would refuse is not offered it at all",
    !cannot.attnRows.innerHTML.includes("attn-clear"));
  ok("7c", "and still sees the finding itself -- they may read these, just not clear them",
    cannot.attnRows.innerHTML.includes("alertNoDeposit"));
}

console.log("\n5. ESCAPING");
{
  // A finding's message comes from the server, and the job name from the
  // customer. Neither is trusted input for innerHTML.
  const findings = [{ id: "x", job_sync_id: "job-1", detector: "no_deposit", severity: "warn",
    message: '<img src=x onerror="alert(1)">', created_at: "2026-10-04T12:00:00Z" }];
  let els, threw = null;
  try { els = render({ settings: { enabled: true }, findings }); } catch (e) { threw = e; }
  ok("5a", "it runs", !threw, threw && threw.message);
  if (!threw) {
    ok("5b", "a message containing markup is escaped, not injected",
      els.attnRows.innerHTML.includes("&lt;img") && !els.attnRows.innerHTML.includes("<img"));
  }
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
