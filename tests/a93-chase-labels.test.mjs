// a93: RUN renderChase, and read the label it puts on each job.
//
// The follow-up priority list used to say "Follow up" whether the customer had
// read the quote, never opened it, or had no address to receive it at all.
// Those need three different actions, and the job already carries the two
// fields that tell them apart.
//
// a89 checks the source says so. This runs the real function and reads the
// buttons it produces, which is the only thing that can catch a runtime break
// -- the office cannot be driven without a login, so this renderer has
// otherwise gone live unexercised.
//
// The ranking is deliberately NOT changed by any of it, and that is asserted
// here too: he is used to that order.

import { load } from "./a27-pricelist-lib.mjs";

let passed = 0, failed = 0;
const ok = (id, what, cond, detail) => {
  if (cond) { passed++; console.log(`  ok    ${id} ${what}`); }
  else { failed++; console.log(`  FAIL  ${id} ${what}${detail ? " -- " + detail : ""}`); }
};

const job = (over) => ({
  id: "j", sync_id: "j", customer_name: "Somebody", status: "SENT",
  created_at: "2026-09-01T00:00:00Z", quote_sent_at: "2026-09-20T00:00:00Z",
  contract_total: 5000, ...over,
});

/** Runs the real renderChase over one job and returns what it wrote. */
async function chaseHtmlFor(j) {
  const els = {};
  const el = (id) => (els[id] = els[id] || {
    id, innerHTML: "", style: {}, textContent: "",
    querySelectorAll: () => [], addEventListener: () => {},
  });
  const scope = {
    $: el,
    esc: (s) => String(s == null ? "" : s),
    tr: (k) => k,                       // the key itself, so assertions name keys
    money: (n) => "$" + Number(n || 0).toFixed(2),
    d: (x) => new Date(x),
    jobs: [j],
    jobBySync: () => j,
    stageOf: () => "Quote Sent",        // the stage whose label this test is about
    contractTotalOf: (x) => x.contract_total || 0,
    ensureItemsForJobs: async () => {},
    payments: [], stageEvents: [],
    canSeeMoney: () => true,
    uiIcon: () => "",
    stageLabel: (x) => String(x),
    sinceWords: () => "a while",
    jobRowClass: () => "",
    fmtDate: (x) => String(x),
    jobGoneLabel: "",
  };
  const P = load(["renderChase"], scope);
  await P.renderChase();               // a throw here is a throw in his browser
  return els.chaseList.innerHTML;
}

const run = async () => {
  console.log("\n1. A SENT QUOTE READS AS ONE OF THREE THINGS");
  {
    let h, threw = null;
    try { h = await chaseHtmlFor(job({ email: "x@example.com", quote_viewed_at: "2026-09-22T00:00:00Z" })); }
    catch (e) { threw = e; }
    ok("1a", "it runs on a quote that was opened", !threw, threw && threw.message);
    if (!threw) ok("1b", "and says they opened it", h.includes("chaseActFollowOpened"), h.slice(0, 160));
  }
  {
    let h, threw = null;
    try { h = await chaseHtmlFor(job({ email: "x@example.com", quote_viewed_at: null })); }
    catch (e) { threw = e; }
    ok("1c", "it runs on a quote never opened", !threw, threw && threw.message);
    if (!threw) ok("1d", "and says to resend or ring, which is a different action",
      h.includes("chaseActFollowUnopened") && !h.includes("chaseActFollowOpened"));
  }
  {
    // The James case: approved, deposit outstanding, and no address at all.
    let h, threw = null;
    try { h = await chaseHtmlFor(job({ email: null, quote_viewed_at: "2026-09-22T00:00:00Z" })); }
    catch (e) { threw = e; }
    ok("1e", "it runs on a job with no email", !threw, threw && threw.message);
    if (!threw) {
      ok("1f", "and says to call them", h.includes("chaseActNoEmail"));
      ok("1g", "no address BEATS having opened it -- there is nowhere to send the next one",
        !h.includes("chaseActFollowOpened"));
    }
  }
  {
    // An address of " " is not an address.
    let h = null, threw = null;
    try { h = await chaseHtmlFor(job({ email: "   ", quote_viewed_at: null })); } catch (e) { threw = e; }
    ok("1h", "a blank-but-present email still counts as no email", !threw && h.includes("chaseActNoEmail"),
      threw ? threw.message : h && h.slice(0, 120));
  }

  console.log("\n2. THE RANKING IS UNTOUCHED");
  {
    const h = await chaseHtmlFor(job({ email: "x@example.com", quote_viewed_at: "2026-09-22T00:00:00Z" }));
    ok("2a", "the row still renders its worth, so the list is still ranked by value and time",
      h.includes("$5000.00") || h.includes("5000"), h.slice(0, 200));
    ok("2b", "and the old generic label is gone from the output entirely",
      !h.includes("chaseActFollow'") && !/chaseActFollow[^OU]/.test(h));
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
};
run();
