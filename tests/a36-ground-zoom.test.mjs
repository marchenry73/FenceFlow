// The 3D quote survey's ground imagery: which zoom a fence gets, and what a
// missing tile does to it. The server side (which levels the county serves)
// is pinned by tests/a35-satellite-zoom.test.mjs; this file pins the page.
//
// WHY THIS EXISTS. The owner said the satellite view "is not too clear, it needs to be
// like Google Earth". website/quote.html had `const Z=zoom||20` -- every quote got
// zoom 20 whatever its size -- and threw the whole 25-tile grid away, two levels down,
// when one tile failed. Hardcoding 21 instead would move the failure to the first
// large lot, where the fence runs off a 277ft photo. So the zoom is now chosen from
// the fence's own radius, the way a map app zooms to fit, and that choice is plain
// arithmetic pulled straight out of quote.html and run here with no browser.
//
// THE ARITHMETIC. A Web-Mercator tile halves with every zoom level. At Riverview's
// latitude a tile is about 111ft across at z20 and 55ft at z21, so the 5x5 grid spans
// about 554ft or 277ft for the same twenty-five downloads -- a quarter of the area at
// double the linear sharpness. A residential lot is 60-120ft wide, so 277ft is ample.
//
// THREE NUMBERS ARE LOAD-BEARING, and each test below has a control that proves the
// comparison is not blind:
//   cap 21    -- 22 and 23 are 404 at the county (a35 measured it); asking is pointless.
//   floor 20  -- what this page shipped with. Customers have quotes open now, and no
//                existing quote may get a WORSE picture than it has today.
//   margin    -- 20ft or a quarter of the radius, whichever is larger: a fence hard
//                against the photo's edge looks like a mistake even when it is right.
//
//   node --test tests/a36-ground-zoom.test.mjs        (no network, no writes)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PAGE = "website/quote.html";
const PROXY = "supabase/functions/quote-map/index.ts";
const src = readFileSync(new URL("../" + PAGE, import.meta.url), "utf8");
const proxy = readFileSync(new URL("../" + PROXY, import.meta.url), "utf8");

// Same idiom as tests/quote-scene.test.mjs: lift a top-level function out of the
// page by brace matching and run it standalone.
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
  "sceneMercTile", "sceneMercMetersPerTile", "sceneSatelliteNeedFt", "sceneSatelliteGrid",
  "sceneSatelliteZoom", "sceneSatelliteNeededCells", "sceneSatelliteVerdict", "sceneMeanColour",
];
const CONSTS = ["SAT_TILE_PX", "SAT_GRID_N", "SAT_ZOOM_CAP", "SAT_ZOOM_FLOOR", "SAT_MARGIN_FT", "SAT_MARGIN_FRAC"];
const M = new Function(
  [...CONSTS.map(grabConst), ...FNS.map(grab)].join("\n\n") +
  `\nreturn { ${[...FNS, ...CONSTS].join(", ")} };`
)();

// A house in a Riverview subdivision (the one the tiles were measured on).
const LAT = 27.829864, LON = -82.319967;
const N = M.SAT_GRID_N;

// Fence radii in feet: the farthest post from the fence's centre, which is
// what build3D hands attachSatellite as fenceR.
const SMALL = Math.hypot(30, 50);   // a 60 x 100ft lot fenced all round -> 58ft
const TYPICAL = Math.hypot(60, 50); // a 120 x 100ft lot -> 78ft
const MID = 150;                    // fits a z20 photo, not a z21 one
const ACREAGE = Math.hypot(150, 150); // a 300 x 300ft parcel -> 212ft

test("positive control: the page really defines the chain, and the caller lets it choose", () => {
  // anchorR, not fenceR, since the photo stopped being centred on the fence:
  // it is pinned to the HOUSE when the drawing says where that is, so the
  // radius the imagery must cover is measured from that anchor and not from
  // the fence's own middle (tests/a79-house-anchors-quote-image.test.mjs).
  // With no house marker anchorR is exactly the old fenceR, so every number
  // this file pins is unchanged -- only the variable's name moved.
  for (const needle of ["attachSatellite", "sceneSatelliteZoom(lat,lon,anchorR)", "sceneSatelliteVerdict(loaded,grid,anchorR)"]) {
    assert.ok(src.includes(needle), `expected ${PAGE} to contain ${needle}`);
  }
  // And the anchor really does collapse to the fence centroid when there is
  // no house -- otherwise the equivalence claimed just above is only a story.
  assert.ok(src.includes("const anchor=houseAnchor||{x:cx,z:cz}"),
    "the no-house fallback is no longer the fence centroid; this file's numbers may be stale");
  // The geocode callback must NOT pass a zoom, or the chooser never runs.
  assert.match(src, /attachSatellite\(g\.lat,g\.lon\)/, "the geocode call site passes a zoom; the fence-size rule is bypassed");
  // And the hardcoded number this whole change exists to remove is gone.
  assert.doesNotMatch(src, /zoom\|\|2[01]\b/, "a hardcoded `zoom||20` or `zoom||21` is back");
});

test("the arithmetic: a tile halves per level, so 5 tiles span ~554ft at z20 and ~277ft at z21 here", () => {
  const g20 = M.sceneSatelliteGrid(LAT, LON, 20), g21 = M.sceneSatelliteGrid(LAT, LON, 21);
  assert.ok(Math.abs(g20.ftPerTile - 110.9) < 0.5, `z20 tile is ${g20.ftPerTile}ft, expected ~110.9`);
  assert.ok(Math.abs(g21.ftPerTile - 55.4) < 0.5, `z21 tile is ${g21.ftPerTile}ft, expected ~55.4`);
  assert.ok(Math.abs(g20.sideFt - 554) < 3 && Math.abs(g21.sideFt - 277) < 2, "grid span is not 5 tiles");
  assert.equal(g20.N * g20.N, 25, "the grid is no longer 25 tiles; the cost numbers in the report are stale");
  // Control: the address lands inside the centre tile, so clearance is 2..2.5 tiles.
  for (const g of [g20, g21]) {
    assert.ok(g.clearanceFt >= 2 * g.ftPerTile - 1e-9 && g.clearanceFt <= 2.5 * g.ftPerTile + 1e-9,
      `clearance ${g.clearanceFt}ft is outside [2,2.5] tiles at z${g.z}`);
  }
});

test("a small lot and a typical 120ft lot get z21; a mid-size one gets z20", () => {
  assert.equal(M.sceneSatelliteZoom(LAT, LON, SMALL), 21);
  assert.equal(M.sceneSatelliteZoom(LAT, LON, TYPICAL), 21);
  assert.equal(M.sceneSatelliteZoom(LAT, LON, MID), 20);
  // Control that the choice is the fence's size and not the address: the same
  // mid fence with a tighter margin would have fitted at 21.
  const need = M.sceneSatelliteNeedFt(MID);
  assert.ok(need > M.sceneSatelliteGrid(LAT, LON, 21).clearanceFt, "control: MID really does not fit a z21 grid");
  assert.ok(need <= M.sceneSatelliteGrid(LAT, LON, 20).clearanceFt, "control: MID really does fit a z20 grid");
});

test("the margin: 20ft or a quarter of the radius, whichever is larger", () => {
  assert.equal(M.sceneSatelliteNeedFt(0), 20);
  assert.equal(M.sceneSatelliteNeedFt(40), 60);      // 40 + max(20, 10)
  assert.equal(M.sceneSatelliteNeedFt(200), 250);    // 200 + max(20, 50)
  assert.equal(M.SAT_MARGIN_FT, 20);
  assert.equal(M.SAT_MARGIN_FRAC, 0.25);
});

test("the cap: nothing above 21 is asked for, however small the fence", () => {
  assert.equal(M.SAT_ZOOM_CAP, 21);
  assert.equal(M.sceneSatelliteZoom(LAT, LON, 1), 21);
  // Control: with the cap lifted the same fence would get 22, so 21 is the cap
  // binding and not the fit.
  assert.equal(M.sceneSatelliteZoom(LAT, LON, 1, { cap: 22 }), 22);
});

test("the cap matches the number the proxy serves (a35 pins why it is 21)", () => {
  const m = proxy.match(/^const HILLSBOROUGH_MAX_ZOOM *= *([0-9]+);/m);
  assert.ok(m, `control: could not read HILLSBOROUGH_MAX_ZOOM from ${PROXY}`);
  assert.equal(M.SAT_ZOOM_CAP, Number(m[1]),
    "the page asks for a zoom the proxy clamps away (or stops short of one it serves)");
});

test("the floor: no fence, however large, gets a softer photo than the z20 it has today", () => {
  assert.equal(M.SAT_ZOOM_FLOOR, 20);
  assert.equal(M.sceneSatelliteZoom(LAT, LON, ACREAGE), 20);
  assert.equal(M.sceneSatelliteZoom(LAT, LON, 5000), 20);
  for (let rft = 0; rft <= 2000; rft += 37) {
    assert.ok(M.sceneSatelliteZoom(LAT, LON, rft) >= 20, `radius ${rft}ft chose a zoom below 20`);
  }
  // Control: the acreage does NOT fit at 20, so 20 is the floor binding and
  // not the fit -- and with the floor lowered the same fence would get 19.
  assert.ok(M.sceneSatelliteNeedFt(ACREAGE) > M.sceneSatelliteGrid(LAT, LON, 20).clearanceFt, "control: ACREAGE fits z20, so this is not testing the floor");
  assert.equal(M.sceneSatelliteZoom(LAT, LON, ACREAGE, { floor: 19 }), 19);
});

test("the choice is rotation-proof: it is made from a radius, not a bounding box", () => {
  // build3D hands over the farthest post from the centroid; pin that it does.
  assert.match(src, /fenceR=Math\.max\(\.\.\.all\.map\(p=>Math\.hypot\(p\.x-cx,p\.z-cz\)\)\)/,
    "fenceR is no longer the farthest post from the fence's centre");
});

test("missing-tile rule: a corner the fence never touches is painted over, not thrown away", () => {
  const grid = M.sceneSatelliteGrid(LAT, LON, 21);
  const all = Array(N * N).fill(true);
  assert.equal(M.sceneSatelliteVerdict(all, grid, SMALL), "complete");

  const cornerOut = all.slice(); cornerOut[0] = false;          // top-left tile
  assert.equal(M.sceneSatelliteVerdict(cornerOut, grid, SMALL), "fill");

  const centreOut = all.slice(); centreOut[2 * N + 2] = false;  // the address's own tile
  assert.equal(M.sceneSatelliteVerdict(centreOut, grid, SMALL), "stepdown");

  // Control: the SAME corner missing under a fence big enough to reach it is a
  // hole under the fence, and steps down.
  assert.equal(M.sceneSatelliteVerdict(cornerOut, grid, 500), "stepdown");
});

test("missing-tile rule: more than half the grid gone is an outage and steps down", () => {
  const grid = M.sceneSatelliteGrid(LAT, LON, 21);
  const needed = new Set(M.sceneSatelliteNeededCells(grid, SMALL));
  // Lose only tiles the fence does not need, as many as there are of them.
  const unneeded = Array.from({ length: N * N }, (_, i) => i).filter((i) => !needed.has(i));
  assert.ok(unneeded.length >= 13, `control: expected at least 13 unneeded cells for a small fence, got ${unneeded.length}`);
  const loaded = Array(N * N).fill(true);
  for (const i of unneeded.slice(0, 12)) loaded[i] = false;  // 13 of 25 left: still a majority
  assert.equal(M.sceneSatelliteVerdict(loaded, grid, SMALL), "fill");
  loaded[unneeded[12]] = false;                               // 12 of 25 left: not any more
  assert.equal(M.sceneSatelliteVerdict(loaded, grid, SMALL), "stepdown");
});

test("needed cells are the ones the fence's disc overlaps, in fetch order dy*N+dx", () => {
  const grid = M.sceneSatelliteGrid(LAT, LON, 21);
  // need = 20ft. This address sits 0.312 tiles (17ft) from the bottom edge of
  // its own tile and more than 20ft from the other three edges, so the disc
  // reaches exactly one neighbour: the cell below. The premise is asserted
  // first so a moved address fails here and not on the answer.
  const ft = grid.ftPerTile;
  assert.ok((3 - grid.oy) * ft < 20, "control: the address is no longer within 20ft of its tile's bottom edge");
  assert.ok((grid.oy - 2) * ft > 20 && (grid.ox - 2) * ft > 20 && (3 - grid.ox) * ft > 20,
    "control: the address is within 20ft of another edge; the expected cell list below is stale");
  const cells = M.sceneSatelliteNeededCells(grid, 0);
  assert.deepEqual(cells, [2 * N + 2, 3 * N + 2], "a 20ft disc here should need the address's tile and the one below it");
  const big = M.sceneSatelliteNeededCells(grid, 500);
  assert.equal(big.length, N * N, "a 500ft disc should need every tile of a 277ft grid");
  // Pin the fetch loop's order, which the cell index assumes.
  const at = src.indexOf("window.__fence.attachSatellite=");
  const body = src.slice(at, at + 2500);
  assert.ok(body.includes("for(let dy=0;dy<N;dy++) for(let dx=0;dx<N;dx++)"), "the fetch loop is no longer dy-outer, dx-inner; cell indexes are wrong");
  assert.ok(body.includes("(i%N)*SAT_TILE_PX, Math.floor(i/N)*SAT_TILE_PX"), "the hole fill no longer maps index i back to (dx,dy) the same way");
});

test("hole colour: the mean of what loaded; transparent (undrawn) pixels do not vote", () => {
  const px = (r, g, b, a) => [r, g, b, a];
  const data = Uint8ClampedArray.from([
    ...px(100, 150, 200, 255), ...px(200, 50, 0, 255), ...px(255, 255, 255, 0),
  ]);
  assert.deepEqual(M.sceneMeanColour(data), [150, 100, 100]);
  // Control: the same white pixel made opaque moves the answer.
  data[11] = 255;
  assert.deepEqual(M.sceneMeanColour(data), [185, 152, 152]);
});

test("the ground is drawn as photographed: sRGB, unlit, untone-mapped, with a shadow catcher", () => {
  const at = src.indexOf("window.__fence.attachSatellite=");
  assert.notEqual(at, -1, "control");
  const body = src.slice(at, src.indexOf("window.__fence.renderOnce", at));
  assert.ok(body.includes("tex.encoding=THREE.sRGBEncoding"), "the photo texture lost its sRGB encoding; mid-tones wash out again");
  assert.ok(body.includes("MeshBasicMaterial({map:tex, toneMapped:false})"), "the photo is lit or tone-mapped again; measured, that lifted sRGB 102 to 218");
  assert.ok(body.includes("THREE.ShadowMaterial"), "an unlit plane cannot receive a shadow; without the catcher the fence floats");
  assert.ok(body.includes("tex.anisotropy=maxAniso"), "anisotropy is no longer applied to the photo texture");
  // Control: the lit material must not be on the photo any more.
  assert.ok(!/MeshStandardMaterial\(\{map:tex/.test(body), "the photo is back on a lit MeshStandardMaterial");
});

test("the step-down chain still ends at 19, one level at a time", () => {
  const at = src.indexOf("window.__fence.attachSatellite=");
  const body = src.slice(at, at + 3000);
  assert.ok(body.includes("Z>19 ? window.__fence.attachSatellite(lat,lon,Z-1) : false"),
    "the step-down no longer walks one level at a time to 19");
});
