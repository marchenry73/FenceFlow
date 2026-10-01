// No panel or gate in the starting catalog may be untaxed.
//
// WHY THIS EXISTS. The live catalog was corrected on 25 September: four of ninety-two
// items were flagged untaxed, all of them panels or a gate, and tax was being charged
// on part of the materials instead of all of them. On one real job that was 2,955.59
// taxed out of a 9,475.34 base. The fix went into the DATABASE ROWS. It did not go into
// the SEED, so the starting catalog every new client receives still shipped the bug for
// another six days, and nothing in the suite noticed -- because nothing was looking.
//
// That is the shape worth guarding: a data fix that leaves the thing which GENERATES the
// data untouched. The rows were right and the factory was wrong.
//
// The tell was visible in the file: a 6'H x 6'W panel said taxable = false while the
// 6'H x 8'W panel beside it said taxable = true. Same product line, opposite treatment
// -- a toggle left flipped, not a decision. The parameter also defaults to true, so
// every one of those four was an explicit override of a sensible default.
//
// Run: node --test tests/a31-seed-panels-are-taxable.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PATH = "app/src/main/java/com/fenceestimator/app/data/SeedData.kt";
const src = readFileSync(new URL("../" + PATH, import.meta.url), "utf8");
const lines = src.split(/\r?\n/);

const nameOf = (line) => (line.match(/"([^"]{5,70})"/) || [])[1] || "(unnamed)";
const isGoods = (line) => /MaterialRole\.(PANEL|GATE_PANEL)/.test(line);

test("positive control: the seed really does define panels and gates", () => {
  // Without this, an empty or renamed file would make every check below pass by
  // finding nothing -- which is how a guard quietly stops guarding. This project has
  // been bitten by exactly that often enough to write it down.
  const goods = lines.filter(isGoods);
  assert.ok(
    goods.length >= 10,
    `expected the starting catalog to define at least 10 panel or gate rows, found ` +
    `${goods.length} in ${PATH}. Either the file moved, the role names changed, or this ` +
    `probe is reading the wrong thing -- fix the probe before trusting the checks below.`
  );
});

test("no panel or gate in the starting catalog is untaxed", () => {
  const offenders = lines
    .filter((L) => isGoods(L) && /taxable\s*=\s*false/.test(L))
    .map(nameOf);

  assert.deepEqual(
    offenders, [],
    `these panel or gate rows ship untaxed in the starting catalog, so every new client ` +
    `would undercharge sales tax on their highest-value items:\n  ` +
    offenders.join("\n  ") +
    `\n\nThe taxable parameter already defaults to true, so each of these is an explicit ` +
    `override. If one is genuinely not taxable in some state, do not just flip this test -- ` +
    `say so in the row's own comment and narrow the check, because silently untaxed ` +
    `panels is the bug this file was written to stop coming back.`
  );
});

test("the panels that are explicitly taxable stay that way", () => {
  // The other half of the pair. If somebody "simplifies" by deleting the explicit
  // taxable = true from the 8'W panels, that is fine (the default is true) -- but if
  // somebody sets them to false, this catches it alongside the check above.
  const explicitlyTrue = lines.filter(
    (L) => isGoods(L) && /taxable\s*=\s*true/.test(L)
  ).length;
  assert.ok(
    explicitlyTrue >= 1,
    "no panel or gate row states taxable = true any more. That is not wrong on its own, " +
    "since the parameter defaults to true -- but combined with the check above it means " +
    "this probe can no longer tell a considered choice from an accident, so read the file."
  );
});
