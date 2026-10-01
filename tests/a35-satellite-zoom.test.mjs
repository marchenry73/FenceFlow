// The county imagery zoom cap, pinned to what the service actually serves.
//
// WHY THIS EXISTS. The owner said the satellite view "is not too clear, it needs to be
// like Google Earth". The imagery chain was already right and his own county's 3-inch
// January 2025 flight was already live -- the problem was the CAP. HILLSBOROUGH_MAX_ZOOM
// was 20, and clampTile serves a zoom-20 tile stretched over anything asked for above it.
// A stretched tile looks exactly like low-resolution imagery to the person looking at it,
// which is why this read as a provider problem and was not one.
//
// THE NUMBER IS MEASURED, NOT READ OFF THE SERVICE, and that distinction is the point: the
// ImageServer advertises 24 levels down to 0.019 m/px, which would have put the cap at 23.
// Real fetches say otherwise -- 21 is the last level that exists, and 22 and 23 are 404 at
// Riverview, downtown Tampa and Brandon alike. Trusting the metadata would have capped at
// 23 and served two levels of nothing; leaving it at 20 threw away one that works.
//
// Pinned by READING THE SOURCE rather than by fetching tiles, deliberately. A test that
// needs the county's server to answer fails on a plane, in a tunnel, and whenever that
// server is down -- and a network flake that reads as a code failure has already cost this
// project real time. The live probe belongs in a one-off script, and its findings live in
// the constant's own comment where the next person will actually see them.
//
// IF THIS GOES RED because somebody raised the cap: re-measure first. Fetch
//   .../Aerials2025_3_inch_MrSid/ImageServer/tile/{z}/{y}/{x}
// at a few places INSIDE the county and one outside it as a control, and check the tiles
// come back as DIFFERENT images -- three identical byte counts at one level is what a
// placeholder tile looks like, and raising the cap onto blank tiles is worse than leaving
// it alone.
//
//   node --test tests/a35-satellite-zoom.test.mjs        (no network, no writes)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PATH = "supabase/functions/quote-map/index.ts";
const src = readFileSync(new URL("../" + PATH, import.meta.url), "utf8");

/**
 * The integer a top-level `const NAME = <n>;` is set to.
 *
 * Built from a regex LITERAL rather than `new RegExp("...")` on purpose: a string-built
 * pattern needs doubled backslashes, and writing this file through a shell heredoc silently
 * ate them once already, which turned the pattern into one that could never match and made
 * a correct constant look missing. A literal has no such failure mode.
 */
const constOf = (name) => {
  const line = src
    .split(/\r?\n/)
    .find((l) => new RegExp("^const " + name + " *= *[0-9]+;").test(l));
  assert.ok(
    line,
    `could not find a top-level "const ${name} = <number>;" line in ${PATH}. It was ` +
    `renamed or removed, which is a different problem from the one this file checks -- ` +
    `fix the probe before trusting anything below it.`
  );
  return Number(line.match(/[0-9]+/)[0]);
};

test("positive control: the file really is the imagery proxy and defines the chain", () => {
  // Without this, a moved or emptied file would make every check below pass by finding
  // nothing, which is how a guard quietly stops guarding.
  for (const needle of ["hillsboroughTile", "esriTile", "clampTile", "Aerials2025_3_inch_MrSid"]) {
    assert.ok(src.includes(needle), `expected ${PATH} to mention ${needle}`);
  }
  // And prove constOf itself works, on a constant this file does not otherwise assert.
  assert.ok(constOf("GOOGLE_MAX_ZOOM") > 0, "control: constOf can read a known constant");
});

test("the county cap is 21 -- the last level the service actually serves", () => {
  assert.equal(
    constOf("HILLSBOROUGH_MAX_ZOOM"), 21,
    "the Hillsborough zoom cap moved. At 20 the map stretches a zoom-20 tile and the owner " +
    "sees blur; above 21 the service 404s and the chain falls through to Esri, which is " +
    "blurrier still. Re-measure against real tiles before changing this -- read the header."
  );
});

test("the cap is not the level count the service advertises", () => {
  // 23 is what the ImageServer's own tileInfo claims. Picking it serves two dead levels.
  assert.notEqual(
    constOf("HILLSBOROUGH_MAX_ZOOM"), 23,
    "the cap is now 23, which is what the service ADVERTISES and not what it serves. " +
    "Levels 22 and 23 return 404 everywhere tested. Measure; do not trust the metadata."
  );
});

test("the comment records that the number was measured, so the next person re-measures", () => {
  const at = src.indexOf("const HILLSBOROUGH_MAX_ZOOM");
  assert.notEqual(at, -1, "control: found the constant to read the comment above it");
  const above = src.slice(Math.max(0, at - 2000), at);
  assert.match(
    above, /404/,
    "the constant no longer explains that levels 22 and 23 are 404. That evidence is the " +
    "only reason 21 is right rather than 20 or 23; without it the next person re-derives " +
    "the number from the service metadata and gets it wrong."
  );
});

test("an over-zoomed tile is downscaled, not refused", () => {
  const at = src.indexOf("function clampTile");
  assert.notEqual(at, -1, "control: clampTile is still there to check");
  const body = src.slice(at, at + 400);
  assert.ok(
    body.includes("Math.floor") && body.includes("2 ** shift"),
    "clampTile no longer maps an over-zoomed request onto the nearest real tile. If it " +
    "refuses instead, every zoom past the cap shows nothing at all rather than a softer " +
    "picture -- a worse failure than the blur this change was made to fix."
  );
});
