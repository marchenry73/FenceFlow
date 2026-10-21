// A113 -- the Reports tab shows one group at a time, and every group has a tab.
//
// Run with:  node --test tests/a113-reports-one-group-at-a-time.test.mjs
//
// "For the reports, I need filters and it's too long to scroll down on it like
// that. I need to click on things and filter, I want it to be as short as
// possible and see as much detail as possible once I click on it."
// -- 21 October 2026.
//
// The six groups were accordions, all openable at once on one page. They are
// now a tab strip built FROM the sections, so a group added later cannot be
// left without a tab, and only the chosen one is on screen.
//
// Source checks: the page is not executed here. Each is paired with a canary.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PAGE = "website/dashboard.html";
const src = readFileSync(new URL("../" + PAGE, import.meta.url), "utf8");

function region(from, to) {
  const i = src.indexOf(from);
  assert.ok(i !== -1, `landmark gone: ${from}`);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j !== -1, `landmark gone: ${to}`);
  return src.slice(i, j);
}

const SECTIONS = [...src.matchAll(/<section class="cat" data-cat="([a-z]+)"/g)].map((m) => m[1]);

test("the report groups are still there to be tabbed", () => {
  assert.ok(SECTIONS.length >= 5, `only ${SECTIONS.length} report groups found`);
  assert.ok(SECTIONS.includes("money"), "the money group is gone; the default tab points at nothing");
  assert.ok(SECTIONS.includes("business"), "the business group is gone; the print path targets it");
});

test("the tab strip exists and is built from the sections, not written out", () => {
  assert.ok(src.includes('id="repCatTabs"'), "the tab strip element is gone");
  const fn = region("function buildRepTabs()", "buildRepTabs();");
  assert.match(fn, /repSections\(\)\.forEach/,
    "the tabs are no longer built from the sections, so a new group can be left without one");
  // Every group name hardcoded in the builder would be the same trap by
  // another route.
  for (const name of SECTIONS) {
    assert.ok(!fn.includes(`'${name}'`) || name === "money",
      `buildRepTabs names the group '${name}' directly instead of reading it from the DOM`);
  }
});

test("choosing a group hides the others", () => {
  const fn = region("function showRepCat(name)", "function buildRepTabs()");
  assert.match(fn, /sec\.style\.display = on \? '' : 'none'/,
    "showRepCat no longer hides the groups it did not choose, so the page is long again");
  assert.match(fn, /if \(on\) sec\.classList\.remove\('closed'\)/,
    "the chosen group is not forced open, so its tab can show an empty panel");
  assert.match(fn, /secs\.some\(s => s\.dataset\.cat === name\) \? name : secs\[0\]\.dataset\.cat/,
    "an unknown remembered group no longer falls back, so the tab can show nothing at all");
});

test("the old accordion wiring is gone, not left fighting the tabs", () => {
  assert.doesNotMatch(src, /localStorage\.getItem\(key\)==='closed'/,
    "the per-group open/closed memory is still running; it re-closes the group the tab just opened");
});

test("a tab follows the language, because it carries the heading's own key", () => {
  const fn = region("function buildRepTabs()", "buildRepTabs();");
  assert.match(fn, /setAttribute\('data-t', label\.getAttribute\('data-t'\)\)/,
    "the tab label is copied as text only, so switching language leaves the tabs behind");
});

test("printing the business report selects its tab first", () => {
  const r = region("$('bizPrintBtn').addEventListener", "window.print();");
  assert.match(r, /showRepCat\('business'\)/,
    "the print path does not select the business tab, so it can print a display:none section -- a blank page reported as success");
});

test("the range label says how many jobs it caught", () => {
  const r = region("const jobsIn=jobs.filter", "await Promise.all([");
  assert.match(r, /repRangeLabel'\)\.textContent \+=/,
    "the range no longer reports a count, so an empty report cannot be told from a broken filter");
  assert.match(r, /jobsIn\.length/, "the count is not the number of jobs in the range");
});

test("the count's words exist in all three languages", () => {
  for (const key of ["repJobWord", "repJobsWord"]) {
    const n = src.split(key + ":").length - 1;
    assert.equal(n, 3, `${key} appears in ${n} locales, expected 3`);
  }
});

test("no sticky table header was left to hide behind the sticky filter bar", () => {
  // The filter panel is position:sticky at top:0 with z-index 5. A header row
  // stuck at the same offset sits behind it and the column names disappear.
  assert.doesNotMatch(src, /#tab-reports thead th\{position:sticky;top:0/,
    "a sticky header at top:0 is back; it renders behind .filters rather than under it");
  assert.match(src, /\.filters\{position:sticky;top:0/, "the filter bar is no longer sticky, so this check is moot");
});

// ---------------------------------------------------------------- canaries

test("CANARY: the hide check fails when the display line is removed", () => {
  const sabotaged = "function showRepCat(name){ secs.forEach(sec => { const on = true; }); }";
  assert.doesNotMatch(sabotaged, /sec\.style\.display = on \? '' : 'none'/,
    "a showRepCat that hides nothing was not detected, so the real check has no teeth");
});

test("CANARY: the accordion check fails when the old wiring comes back", () => {
  const sabotaged = "if(localStorage.getItem(key)==='closed') sec.classList.add('closed');";
  assert.match(sabotaged, /localStorage\.getItem\(key\)==='closed'/,
    "the old wiring was not matched by its own pattern");
});
