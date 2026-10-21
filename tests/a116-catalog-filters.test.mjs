// A116 -- the catalog can be asked a structured question, and says how much of
// itself it is showing.
//
// Run with:  node --test tests/a116-catalog-filters.test.mjs
//
// "Need a better catalog, need it organized and more formatted and filter."
// -- 21 October 2026. It had one free-text box over five accordions.
//
// Source checks: the page is not executed here. Each is paired with a canary.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../website/dashboard.html", import.meta.url), "utf8");

function region(from, to) {
  const i = src.indexOf(from);
  assert.ok(i !== -1, `landmark gone: ${from}`);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j !== -1, `landmark gone: ${to}`);
  return src.slice(i, j);
}

test("the four filters exist beside the search box", () => {
  for (const id of ["catFType", "catFRole", "catFSupplier", "catFStatus"]) {
    assert.ok(src.includes(`id="${id}"`), `${id} is gone`);
  }
  assert.ok(src.includes('id="catFilter"'), "the free-text box was removed; typing is still the fastest route when you know the name");
  assert.ok(src.includes('id="catCount"'), "the showing-x-of-y line is gone");
});

test("retired parts are out of the price list by default", () => {
  const fn = region("const catSel = {", "function catStructuralFilter");
  assert.match(fn, /status: 'active'/,
    "the default status changed; a retired part shown in a price list is a part that gets quoted again");
});

test("the structural filter is a separate layer, not a widened shared helper", () => {
  // catalogFilterItems is shared with the setup wizard's supplier step, which
  // knows nothing about these dropdowns. Widening it would quietly narrow
  // what the wizard answers.
  const shared = region("function catalogFilterItems(items, filterText, supplierNameOf)", "function catalogSeedRowsToAdd");
  for (const key of ["catSel", "is_active", "catFType"]) {
    assert.ok(!shared.includes(key), `catalogFilterItems now mentions ${key}; the wizard calls it too`);
  }
  assert.match(src, /function catStructuralFilter\(items\)/, "the separate layer is gone");
});

test("the dropdowns apply to the catalog tab only", () => {
  const fn = region("function renderCatalogSections(containerId, filterValue)", "el.innerHTML = html");
  assert.match(fn, /const structural = containerId === 'catSections'/,
    "the wizard's copy of this renderer would now be filtered by controls it does not show");
  assert.match(fn, /structural\s*\n?\s*\? catStructuralFilter\(/, "the structural layer is no longer applied");
});

test("a chosen option that no longer exists does not silently become All", () => {
  const fn = region("function fillCatPickers()", "let catPickersWired");
  assert.match(fn, /el\.value = pairs\.some\(p => p\[0\] === was\)/,
    "a rebuilt picker drops the selection without saying so, which reads as parts having gone missing");
});

test("the pickers are built from what the catalog holds", () => {
  const fn = region("function fillCatPickers()", "let catPickersWired");
  assert.match(fn, /new Set\(catalog\.map\(c => c\.fence_type\)/, "fence types are no longer read from the data");
  assert.match(fn, /new Set\(catalog\.map\(c => c\.manufacturer_sync_id\)/, "suppliers are no longer read from the data");
});

test("the export is the view, not the whole table", () => {
  const fn = region("const csv = $('catCsv')", "function renderCatalogSections");
  assert.match(fn, /catStructuralFilter\(catalogFilterItems\(catalog/,
    "the CSV ignores the filters, so it is a different document to the one on screen");
  assert.match(fn, /'In use'/, "the export drops the retired flag, so a retired row is indistinguishable in the file");
});

test("one button opens every section", () => {
  const fn = region("const openAll = $('catExpandAll')", "const csv = $('catCsv')");
  assert.match(fn, /if \(anyClosed\) catCollapsed\.delete/, "the button no longer opens them");
  assert.match(fn, /else catCollapsed\.add/, "it does not toggle, so closing them again is five more clicks");
});

test("every new word exists in all three languages", () => {
  for (const key of ["catFilterType", "catFilterRole", "catFilterSupplier", "catFilterStatus",
                     "catStatusActive", "catStatusRetired", "catStatusBoth",
                     "catClearBtn", "catExpandBtn", "catCsvBtn", "catCountLine"]) {
    const n = src.split(key + ":").length - 1;
    assert.equal(n, 3, `${key} appears in ${n} locales, expected 3`);
  }
});

// ---------------------------------------------------------------- canaries

test("CANARY: the shared-helper check fails if the dropdowns leak into it", () => {
  const sabotaged = "function catalogFilterItems(items){ if (catSel.type) return []; }";
  assert.ok(sabotaged.includes("catSel"), "the canary did not reproduce the leak, so the real check proves nothing");
});

test("CANARY: the status filter really excludes, in both directions", () => {
  const keep = (status, live) =>
    !((status === "active" && !live) || (status === "retired" && live));
  assert.equal(keep("active", false), false, "a retired part survived the In use filter");
  assert.equal(keep("retired", true), false, "a live part survived the Retired filter");
  assert.equal(keep("", false), true, "Both dropped a retired part");
  assert.equal(keep("", true), true, "Both dropped a live part");
});
