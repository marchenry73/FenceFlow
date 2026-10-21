// A114 -- "Your alerts" is a wrapped grid in its own scroll box, not a column
// of twenty-six full-width rows.
//
// Run with:  node --test tests/a114-alerts-compact.test.mjs
//
// "The box, they are so far apart, it need to be more congested, maybe make
// them horizontal and we can scroll on just this part to be able to check or
// uncheck the boxes." -- 21 October 2026.
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

const DEFS = [...src.matchAll(/\{ key:'[a-z_]+',\s*labelKey:'alert[A-Za-z]+' \}/g)];

test("there really are enough alerts for this to matter", () => {
  assert.ok(DEFS.length >= 20, `only ${DEFS.length} alert definitions found; the panel may have been cut instead of compacted`);
});

test("the grid scrolls on its own instead of growing the page", () => {
  const css = region(".alertgrid{", "}");
  assert.match(css, /flex-wrap:wrap/, "the pills no longer wrap, so they are a column again");
  assert.match(css, /max-height:\d+px/, "the box has no height, so it grows down the page as before");
  assert.match(css, /overflow-y:auto/, "the box does not scroll on its own -- the whole page scrolls instead");
});

test("an alert that is off is visibly off, not just an empty box", () => {
  assert.match(src, /\.alertgrid label\.off\{opacity:/, "the dimmed state for a switched-off alert is gone");
});

test("the renderer emits the grid, and the old full-width rows are gone", () => {
  const fn = region("function renderAlertPrefs(){", "const dEl = $('desktopAlertsRow');");
  assert.match(fn, /class=\\?"alertgrid\\?"/, "renderAlertPrefs no longer builds the grid");
  assert.doesNotMatch(fn, /padding:4px 0/, "the old full-width row styling is still being emitted");
});

test("ticking one box does not re-render the grid under your finger", () => {
  const fn = region("el.querySelectorAll('input[data-alert-key]')", "const allOn =");
  assert.match(fn, /row\.classList\.toggle\('off', !cb\.checked\)/,
    "the pill no longer follows the checkbox");
  assert.doesNotMatch(fn, /renderAlertPrefs\(\)/,
    "the change handler re-renders the whole grid, which throws away the scroll position in a box this size");
  assert.match(fn, /alertCount/, "the count no longer follows the toggle");
});

test("All on / All off is one write, not one per alert", () => {
  const fn = region("async function setAllAlerts(on)", "function renderAlertPrefs()");
  const upserts = (fn.match(/\.upsert\(/g) || []).length;
  assert.equal(upserts, 1, `setAllAlerts does ${upserts} upserts; twenty-six round trips send the same column twenty-six times`);
  assert.match(fn, /mutedAlerts = next/, "setAllAlerts does not change the live state, so the screen would lie until reload");
  assert.match(fn, /renderDash\(\)/, "the Home attention list is not refreshed, so it keeps showing what was just switched off");
});

test("the new words exist in all three languages", () => {
  for (const key of ["alertsOnCount", "alertsAllOn", "alertsAllOff"]) {
    const n = src.split(key + ":").length - 1;
    assert.equal(n, 3, `${key} appears in ${n} locales, expected 3`);
  }
});

test("the count names both numbers, so 'on' is never ambiguous", () => {
  assert.match(src, /alertsOnCount:'%s of %s on'/, "the English count no longer carries both figures");
});

// ---------------------------------------------------------------- canaries

test("CANARY: the scroll check fails on a box with no height", () => {
  const sabotaged = ".alertgrid{display:flex;flex-wrap:wrap;gap:6px}";
  assert.doesNotMatch(sabotaged, /max-height:\d+px/,
    "a grid with no max-height was not detected, so the real check has no teeth");
});

test("CANARY: the one-write check fails on a per-alert loop", () => {
  const sabotaged = "async function setAllAlerts(on){ for (const a of ALERT_DEFS) await db.upsert({}); await db.upsert({}); }";
  assert.equal((sabotaged.match(/\.upsert\(/g) || []).length, 2,
    "the canary did not reproduce a multi-write version, so the real check proves nothing");
});
