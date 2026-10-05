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

let passed = 0, failed = 0;
const ok = (id, what, cond, detail) => {
  if (cond) { passed++; console.log(`  ok    ${id} ${what}`); }
  else { failed++; console.log(`  FAIL  ${id} ${what}${detail ? " -- " + detail : ""}`); }
};

/** The few page globals renderAttention reaches for. */
function makeScope({ canEditValue = true } = {}) {
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
      setAttentionEnabled: () => {},
      clearAttentionFinding: () => {},
    },
  };
}

function render({ settings, findings, canEditValue = true }) {
  const { els, scope } = makeScope({ canEditValue });
  const prelude =
    `let attentionSettings = ${JSON.stringify(settings)};\n` +
    `let attentionFindings = ${JSON.stringify(findings)};\n`;
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
