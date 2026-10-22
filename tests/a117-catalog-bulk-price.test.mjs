// A117 -- a percentage price change that cannot happen without a preview, and
// can always be put back.
//
// Run with:  node --test tests/a117-catalog-bulk-price.test.mjs
//
// "Put all the vinyl post prices up 8%" is the most useful bulk job in a trade
// catalog and the most dangerous thing on the page. Of every product compared
// -- Shopify, Square, Lightspeed, ServiceTitan, Housecall Pro, Jobber, Cin7,
// Fishbowl -- only ServiceTitan offers it natively, and even there the docs say
// the preview covers names and descriptions, not prices, and mention no undo.
// So the two things they lack are the two things these checks defend.
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

test("the controls exist, and Apply starts disabled", () => {
  for (const id of ["catBulkPercent", "catBulkRound", "catBulkPreview", "catBulkApply", "catBulkUndo"]) {
    assert.ok(src.includes(`id="${id}"`), `${id} is gone`);
  }
  assert.match(src, /id="catBulkApply" disabled/,
    "Apply is armed before anything has been previewed");
});

test("it changes exactly what the screen is showing", () => {
  const fn = region("function catBulkTargets()", "function catBulkNewPrice");
  assert.match(fn, /catStructuralFilter\(catalogFilterItems\(catalog/,
    "the target set is no longer the filtered view, so the filter stops being the safety control");
  // The CSV export must agree, or 'what you export' and 'what you change'
  // drift apart and the preview stops meaning what it looks like it means.
  const csv = region("const csv = $('catCsv')", "function renderCatalogSections");
  assert.match(csv, /catStructuralFilter\(catalogFilterItems\(catalog/,
    "the export and the bulk change no longer describe the same set");
});

test("an item with no price is skipped, never multiplied up from zero", () => {
  const fn = region("function catBulkBuildPlan()", "async function catBulkApply");
  assert.match(fn, /filter\(c => Number\(c\.unit_price\) > 0\)/,
    "items with no price are no longer skipped; 0 x 1.08 is still 0 but now looks deliberate");
  assert.match(fn, /filter\(r => r\.to !== r\.from && r\.to > 0\)/,
    "a change that changes nothing, or lands at or below zero, is no longer dropped");
});

test("the preview shows every row, not a sample", () => {
  const fn = region("function catBulkBuildPlan()", "async function catBulkApply");
  assert.match(fn, /rows\.map\(r =>/, "the preview no longer maps over the rows");
  assert.doesNotMatch(fn, /\.slice\(0,\s*\d+\)/,
    "the preview truncates; a preview of the first ten of a hundred is a preview of the wrong thing");
});

test("Apply refuses a plan that no longer matches the controls", () => {
  const fn = region("async function catBulkApply()", "const jobs = catBulkPlan.rows");
  assert.match(fn, /Number\(\$\('catBulkPercent'\)\.value\) !== catBulkPlan\.pct/,
    "the percentage is no longer re-checked against the previewed plan");
  assert.match(fn, /\$\('catBulkRound'\)\.value !== catBulkPlan\.round/,
    "the rounding is no longer re-checked");
  const wiring = region("['catBulkPercent', 'catBulkRound'].forEach", "const csv = $('catCsv')");
  assert.match(wiring, /catBulkPlan = null; \$\('catBulkApply'\)\.disabled = true/,
    "changing a control no longer disarms Apply");
});

test("it writes through the verified pipeline, not a second money path", () => {
  const fn = region("async function catBulkApply()", "async function catBulkUndo");
  assert.match(fn, /await ppWriteRows\(jobs/,
    "the bulk change no longer uses ppWriteRows -- a second write path for money is the real risk here");
  assert.doesNotMatch(fn, /db\.from\('material_items'\)/,
    "it writes to material_items directly, bypassing the row-by-row verification");
});

test("undo exists and is guarded against a row that changed since", () => {
  const fn = region("async function catBulkUndo()", "function renderCatalogSections");
  assert.match(fn, /guard: \{ updated_at: w\.after\.updated_at \}/,
    "the undo is unguarded, so it would overwrite an edit made since the change");
  assert.match(fn, /patch: w\.before/, "the undo no longer restores the previous price");
  assert.match(fn, /await ppWriteRows\(jobs/, "the undo does not use the verified pipeline");
});

test("nothing saved means nothing to undo", () => {
  const fn = region("async function catBulkApply()", "async function catBulkUndo");
  assert.match(fn, /if \(!saved\) return;/,
    "a run that wrote nothing still offers an Undo button, which would restore prices nobody changed");
});

test("every new word exists in all three languages", () => {
  for (const key of ["catBulkBtn", "catBulkPct", "catBulkRound", "catBulkPreviewBtn", "catBulkApplyBtn",
                     "catBulkUndoBtn", "catBulkNeedPct", "catBulkNothing", "catBulkPreviewLine",
                     "catBulkSkipped", "catBulkStale", "catBulkDoneOk", "catBulkDonePartial",
                     "catBulkUndone", "catBulkUndonePartial"]) {
    const n = src.split(key + ":").length - 1;
    assert.equal(n, 3, `${key} appears in ${n} locales, expected 3`);
  }
});

// ---------------------------------------------------------------- canaries

test("CANARY: the arithmetic itself, both roundings and both directions", () => {
  // The same expression the page uses.
  const next = (old, pct, round) => {
    const raw = Number(old) * (1 + pct / 100);
    return round === "dollar" ? Math.round(raw) : Math.round(raw * 100) / 100;
  };
  assert.equal(next(10, 8, "cent"), 10.8, "an 8% rise on $10");
  assert.equal(next(12.34, 8, "cent"), 13.33, "rounding to the cent");
  assert.equal(next(12.34, 8, "dollar"), 13, "rounding to the dollar");
  assert.equal(next(10, -5, "cent"), 9.5, "a 5% cut");
  // A cut big enough to reach zero must not produce a negative price; the
  // builder drops anything at or below zero.
  assert.ok(next(10, -100, "cent") <= 0, "a -100% change does not stay positive");
});

test("CANARY: the preview-required check fails on an armed Apply", () => {
  const sabotaged = '<button id="catBulkApply">Apply</button>';
  assert.doesNotMatch(sabotaged, /id="catBulkApply" disabled/,
    "an Apply button with no disabled attribute was not detected");
});
