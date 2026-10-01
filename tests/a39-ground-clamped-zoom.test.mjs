// The 3D quote page's ground: asking for a zoom the PROVIDER DOES NOT HAVE.
//
// WHY THIS EXISTS. Raising the page from zoom 20 to 21 is right inside
// Hillsborough, where the county really serves 21. Everywhere else the proxy's
// chain falls through to Esri, which stops at 20 -- and the proxy does not
// refuse an over-zoomed request, it walks it back to the provider's parent
// tile and serves that (clampTile() in supabase/functions/quote-map/index.ts,
// whose own comment calls the result "the slightly soft one it had before").
// It is not soft. All 25 cells of the grid come back holding the picture of
// their z20 parent, so the page paints each parent four times, each copy
// squashed to a quarter of the ground it covers. Every tile answers 200, so
// the missing-tile rule never fires and the customer is shown a repeated,
// half-scale yard where before the change they were shown a correct z20 one.
//
// MEASURED against the deployed function, not reasoned about:
//   Orlando   (outside the county) z21 children of one parent -> four
//             byte-identical images, identical to the z20 parent itself.
//   Riverview (inside the county)  the same four -> four different images.
// The Riverview half is the control: without it, "they matched" could just as
// easily mean the probe compares a thing to itself.
//
// So the page now checks, from the tiles it already has, whether the level it
// asked for is the level it got, and steps down when it is not. Stepping down
// lands on z20 -- exactly the picture every quote had before -- so the hard
// floor holds: no existing quote gets a worse ground than today.
//
//   node --test tests/a39-ground-clamped-zoom.test.mjs   (no network, no writes)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PAGE = "website/quote.html";
const src = readFileSync(new URL("../" + PAGE, import.meta.url), "utf8");

// Same lift-the-real-function idiom as tests/a36-ground-zoom.test.mjs and
// tests/quote-scene.test.mjs: run the page's own code, never a copy of it.
const grab = (name) => {
  const start = src.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `could not find "function ${name}(" in ${PAGE}`);
  let depth = 0;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
};
const grabConst = (name) => {
  const m = src.match(new RegExp("^const " + name + " *= *([0-9.]+);", "m"));
  assert.ok(m, `could not find a top-level "const ${name}=<number>;" in ${PAGE}`);
  return "const " + name + "=" + m[1] + ";";
};

const FNS = [
  "sceneMercTile", "sceneMercMetersPerTile", "sceneSatelliteGrid",
  "sceneSatelliteSiblingPairs", "sceneBytesEqual", "sceneSatelliteClamped",
];
const CONSTS = ["SAT_TILE_PX", "SAT_GRID_N"];
const M = new Function(
  [...CONSTS.map(grabConst), ...FNS.map(grab)].join("\n\n") +
  "\nreturn {" + [...FNS, ...CONSTS].join(",") + "};",
)();

const LAT = 27.829864, LON = -82.319967;   // Riverview
const gridAt = (z, lat = LAT, lon = LON) => M.sceneSatelliteGrid(lat, lon, z);
const allLoaded = (grid) => Array(grid.N * grid.N).fill(true);

/** A fake "are these two cells the same picture?" built from a cell->image-id map. */
const sameBy = (idOf) => (a, b) => idOf(a) === idOf(b);

test("every pair it offers really is two children of one parent tile", () => {
  // A pair is only evidence if halving both x's lands on the SAME parent.
  // Walk several addresses so both the even-aligned and odd-aligned cases run.
  let checked = 0;
  for (const lon of [-82.319967, -82.3200, -82.3210, -82.3220, -81.4000]) {
    const grid = gridAt(21, LAT, lon);
    const pairs = M.sceneSatelliteSiblingPairs(grid);
    assert.ok(pairs.length >= 2, `only ${pairs.length} sibling pairs at lon ${lon}`);
    for (const [a, b] of pairs) {
      const ax = grid.cxT + (a % grid.N), bx = grid.cxT + (b % grid.N);
      const ay = Math.floor(a / grid.N), by = Math.floor(b / grid.N);
      assert.equal(ay, by, "a pair must be two cells of the same row");
      assert.equal(bx, ax + 1, "a pair must be two cells side by side");
      assert.equal(Math.floor(ax / 2), Math.floor(bx / 2),
        `cells ${a},${b} (tiles x=${ax},${bx}) do NOT share a parent`);
      checked++;
    }
  }
  assert.ok(checked >= 10, "the pair check never actually ran on anything");

  // CONTROL: the same arithmetic applied to a deliberately WRONG pairing --
  // two cells two apart -- must fail the share-a-parent test, or the
  // assertion above proves nothing.
  const grid = gridAt(21);
  const ax = grid.cxT, cx = grid.cxT + 2;
  assert.notEqual(Math.floor(ax / 2), Math.floor(cx / 2),
    "two cells two apart shared a parent -- the parent arithmetic is not discriminating");
});

test("a clamping provider (every child = its parent's image) is caught", () => {
  const grid = gridAt(21);
  // What Esri does outside the county: cell -> the parent it belongs to.
  const parentOf = (i) => {
    const x = grid.cxT + (i % grid.N), y = grid.cyT + Math.floor(i / grid.N);
    return Math.floor(x / 2) + ":" + Math.floor(y / 2);
  };
  assert.equal(M.sceneSatelliteClamped(allLoaded(grid), grid, sameBy(parentOf)), true,
    "the page would have painted a z20 parent four times and called it zoom 21");
});

test("CONTROL: real imagery (every cell its own picture) is NOT called clamped", () => {
  const grid = gridAt(21);
  // What Hillsborough does: 25 distinct images. Without this the test above
  // would pass just as happily on a function that always returns true.
  assert.equal(M.sceneSatelliteClamped(allLoaded(grid), grid, sameBy((i) => "tile" + i)), false,
    "real distinct imagery was mistaken for a clamp -- every quote would lose a zoom level");
});

test("one lake-flat pair is not enough; it takes two places", () => {
  const grid = gridAt(21);
  const pairs = M.sceneSatelliteSiblingPairs(grid);
  const first = pairs[0], last = pairs[pairs.length - 1];
  // A featureless patch -- open water, a car park -- can make ONE pair match
  // at a zoom the provider genuinely has. That must not cost the level.
  const onePairFlat = (i) => (i === first[0] || i === first[1]) ? "flat" : "tile" + i;
  assert.equal(M.sceneSatelliteClamped(allLoaded(grid), grid, sameBy(onePairFlat)), false,
    "a single uniform patch was enough to throw away a zoom level");
  // CONTROL: make the far pair match too and it must flip, or the test above
  // is passing for the wrong reason (e.g. the function never returns true).
  const bothFlat = (i) =>
    (i === first[0] || i === first[1]) ? "flatA" :
    (i === last[0] || i === last[1]) ? "flatB" : "tile" + i;
  assert.equal(M.sceneSatelliteClamped(allLoaded(grid), grid, sameBy(bothFlat)), true,
    "two matching pairs in two places did not read as a clamp");
});

test("a missing tile is the other failure: it does not read as a clamp", () => {
  const grid = gridAt(21);
  const parentOf = (i) => {
    const x = grid.cxT + (i % grid.N), y = grid.cyT + Math.floor(i / grid.N);
    return Math.floor(x / 2) + ":" + Math.floor(y / 2);
  };
  const loaded = allLoaded(grid);
  // Knock out enough that fewer than two complete pairs survive.
  M.sceneSatelliteSiblingPairs(grid).forEach(([a], n) => { if (n < 99) loaded[a] = false; });
  assert.equal(M.sceneSatelliteClamped(loaded, grid, sameBy(parentOf)), false,
    "with no complete pair left it still claimed to know the provider clamped");
  // CONTROL: the same grid with everything loaded DOES read as clamped, so the
  // false above comes from the missing tiles and not from the comparison.
  assert.equal(M.sceneSatelliteClamped(allLoaded(grid), grid, sameBy(parentOf)), true);
});

test("sceneBytesEqual actually compares bytes", () => {
  assert.equal(M.sceneBytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(M.sceneBytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(M.sceneBytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2])), false);
  assert.equal(M.sceneBytesEqual(null, new Uint8Array([1])), false);
  // A last-byte difference is the one a length-only or head-only check misses.
  const a = new Uint8Array(1024).fill(7), b = new Uint8Array(1024).fill(7);
  b[1023] = 8;
  assert.equal(M.sceneBytesEqual(a, b), false, "a difference in the last byte was not seen");
});

test("the page wires the check in, above the missing-tile verdict, and only steps DOWN", () => {
  const at = src.indexOf("window.__fence.attachSatellite=async function");
  assert.notEqual(at, -1, "attachSatellite is gone");
  const body = src.slice(at, at + 4000);

  const clampAt = body.indexOf("sceneSatelliteClamped(");
  const verdictAt = body.indexOf("sceneSatelliteVerdict(");
  assert.ok(clampAt > 0, "attachSatellite does not call sceneSatelliteClamped at all");
  assert.ok(verdictAt > 0, "attachSatellite does not call sceneSatelliteVerdict");
  assert.ok(clampAt < verdictAt,
    "the clamp check must run before the missing-tile verdict: a clamped grid is COMPLETE, " +
    "so the verdict passes it through and the wrong picture is drawn");

  // It must never reach below the chain's existing floor of 19.
  const guarded = /Z>19\s*&&\s*sceneSatelliteClamped\(/.test(body.replace(/\s+/g, " ").replace(/ /g, ""))
    || /Z>19&&sceneSatelliteClamped\(/.test(body.replace(/\s/g, ""));
  assert.ok(guarded, "the clamp step-down is not guarded by Z>19 and could walk past the chain's floor");
  const stepsDown = /attachSatellite\(lat,lon,Z-1\)/.test(body.replace(/\s/g, ""));
  assert.ok(stepsDown, "the clamp branch does not retry one level DOWN");
});
