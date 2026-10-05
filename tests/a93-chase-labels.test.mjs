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

/** Runs the real renderChase over one job (or several) and returns what it wrote. */
async function chaseHtmlFor(j) {
  const list = Array.isArray(j) ? j : [j];
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
    jobs: list,
    jobBySync: (sid) => list.find((x) => x.sync_id === sid) || list[0],
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
    ok("2a", "the row still renders its worth", h.includes("$5000.00") || h.includes("5000"), h.slice(0, 200));
  }
  {
    // THE ORDER ITSELF. The first version of this rendered ONE job and checked
    // its value appeared, which says nothing about ranking -- reversing the
    // sort would have passed it. The score is value x days waiting, so build
    // three jobs whose order is unambiguous and read the names back in the
    // order they were written.
    const mk = (id, name, total, sentAt) => job({
      id, sync_id: id, customer_name: name, contract_total: total,
      quote_sent_at: sentAt, quote_viewed_at: sentAt, email: "x@example.com",
    });
    const h = await chaseHtmlFor([
      mk("small", "SmallRecent", 1000, "2026-10-01T00:00:00Z"),   // low value, newest
      mk("big", "BigOld", 20000, "2026-08-01T00:00:00Z"),         // high value, oldest -> first
      mk("mid", "MidMiddle", 5000, "2026-09-01T00:00:00Z"),
    ]);
    const order = ["BigOld", "MidMiddle", "SmallRecent"].map((n) => h.indexOf(n));
    ok("2c", "the list is ranked by value times time waiting, biggest and oldest first",
      order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2],
      "positions " + JSON.stringify(order));
    ok("2d", "CANARY: all three really were rendered, so the order above is not two of them",
      order.filter((i) => i >= 0).length === 3);
    ok("2b", "and the old generic label is gone from the output entirely",
      !h.includes("chaseActFollow'") && !/chaseActFollow[^OU]/.test(h));
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
};
run();
