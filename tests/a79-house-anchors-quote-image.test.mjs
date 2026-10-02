// Where the fence is drawn on the customer's aerial photo.
//
// WHY THIS EXISTS. The owner: "the quote image is showing the fence crossing
// the front of the house, not the back." That was not a drawing error. The page
// centred the imagery so the geocoded address sat exactly under the fence's
// MIDDLE, and the geocoded address is the HOUSE -- so every fence was drawn
// straddling the house, wherever it really stood. A back-yard fence therefore
// read as a fence across the front of the property.
//
// On the one live job that carries a HOUSE marker, measured here, that mistake
// is 60.23 ft: the old arithmetic puts the address 60 ft from the real house.
// The CANARY test below runs the old arithmetic against the same assertion the
// new code passes, and fails it -- so these tests cannot pass by accident
// against a page that never changed.
//
// WHAT IS ANCHORED AND WHAT IS NOT. A HOUSE marker fixes the OFFSET: the fence
// falls at its true distance and true relative shape from the house. It cannot
// fix the BEARING, because a drawing has no compass -- "up" on the survey
// canvas is not north. That is why the fence hangs from a pivot AT THE HOUSE:
// the turn slider then sweeps it around the house at the correct radius, so the
// single remaining unknown is the single thing the control adjusts. The page
// says which of the two pictures the customer is looking at (posFromHouse /
// posApprox) and these tests pin that it never stays silent.
//
// THE NUMBERS come from the live job read read-only through the Supabase CLI:
// drawing scale 40 px/ft, a 74 ft side and a 55 ft side, house at
// (3972.89, 4025) drawing pixels. No customer, address or contact appears here
// -- only geometry.
//
//   node --test tests/a79-house-anchors-quote-image.test.mjs   (no network, no writes)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PAGE = "website/quote.html";
const VIEW = "supabase/functions/quote-view/index.ts";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const src = read(PAGE);
const view = read(VIEW);

/* ---- lifting the real functions out of the page -------------------------
   Same brace-matching idiom as tests/a36-ground-zoom.test.mjs and
   tests/a38-quote-pay-section.test.mjs: what runs below IS the shipped
   source, not a copy of it that can drift. */
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
  return `const ${name}=${m[1]};`;
};

const FNS = [
  "sceneMercTile", "sceneMercMetersPerTile", "sceneSatelliteNeedFt",
  "sceneSatelliteGrid", "sceneSatelliteZoom",
  "sceneHouseAnchor", "sceneAnchorRadiusFt", "sceneGroundCentre",
];
const CONSTS = ["SAT_TILE_PX", "SAT_GRID_N", "SAT_ZOOM_CAP", "SAT_ZOOM_FLOOR",
                "SAT_MARGIN_FT", "SAT_MARGIN_FRAC"];
const M = new Function(
  [...CONSTS.map(grabConst), ...FNS.map(grab)].join("\n\n") +
  `\nreturn { ${[...FNS, ...CONSTS].join(", ")} };`
)();

/* ---- the live job, as geometry ------------------------------------------ */
const PPF = 40;                       // its calibration_pixels_per_foot
const HOUSE_PX = { x: 3972.89, y: 4025 };
const RUN_PX = [                      // two runs, as points_encoded decodes
  [1890.2112, 4202.142], [1890.2112, 1242.1421],   // the 74 ft side
  [2222.1519, 1359.9054], [4422.152, 1359.9054],   // the 55 ft side
];
const all = RUN_PX.map(([x, y]) => ({ x: x / PPF, z: y / PPF }));
const centroid = {
  x: all.reduce((s, p) => s + p.x, 0) / all.length,
  z: all.reduce((s, p) => s + p.z, 0) / all.length,
};
const fenceR = Math.max(...all.map((p) => Math.hypot(p.x - centroid.x, p.z - centroid.z)));
const HOUSE_MARKER = { kind: "HOUSE", x: HOUSE_PX.x, y: HOUSE_PX.y };

// Riverview, the latitude the tile sizes in a35/a36 were measured at.
const LAT = 27.829864, LON = -82.319967;

// Where the address pixel actually lands in scene feet, given a ground centre.
// This is the inverse of sceneGroundCentre and the thing the whole change is
// about: the address must come out ON the anchor.
const addressOf = (grid, groundCentre) => ({
  x: groundCentre.x + (grid.ox / grid.N - 0.5) * groundCentre.sideFt,
  z: groundCentre.z + (grid.oy / grid.N - 0.5) * groundCentre.sideFt,
});

/* ======================================================================== */
/* POSITIVE CONTROLS -- prove the lifting worked and the page really wires  */
/* these functions in. Every assertion below is worthless without these.    */
/* ======================================================================== */

test("positive control: the lifted functions exist and compute real numbers", () => {
  for (const n of FNS) assert.equal(typeof M[n], "function", `${n} did not lift out of ${PAGE}`);
  // A z21 tile really is ~55ft here; if this is wrong the grid maths is not
  // the page's maths and nothing below means anything.
  const g = M.sceneSatelliteGrid(LAT, LON, 21);
  assert.ok(Math.abs(g.ftPerTile - 55.4) < 0.5, `z21 tile is ${g.ftPerTile}ft, expected ~55.4`);
  assert.equal(g.N * g.N, 25, "the grid is no longer 25 tiles");
  // And the fixture is the job it claims to be: a 74ft side and a 55ft side.
  const len = (a, b) => Math.hypot(RUN_PX[b][0] - RUN_PX[a][0], RUN_PX[b][1] - RUN_PX[a][1]) / PPF;
  assert.ok(Math.abs(len(0, 1) - 74) < 0.01, `first side is ${len(0, 1)}ft, expected 74`);
  assert.ok(Math.abs(len(2, 3) - 55) < 0.01, `second side is ${len(2, 3)}ft, expected 55`);
});

test("positive control: the page anchors the photo, the pivot and the zoom on the anchor", () => {
  for (const needle of [
    "const houseAnchor=sceneHouseAnchor(quote.markers, quote.pxPerFoot||20)",
    "const anchor=houseAnchor||{x:cx,z:cz}",
    "const anchorR=sceneAnchorRadiusFt(all,anchor)",
    "const ground=sceneGroundCentre(grid, anchor)",
    "plane.position.set(ground.x, 0.02, ground.z)",
    "shade.position.set(ground.x, 0.1, ground.z)",
    "pivot.position.set(anchor.x,0,anchor.z)",
    "fence.position.set(-anchor.x,0,-anchor.z)",
    "oldFence.position.set(-anchor.x,0,-anchor.z)",
    "sceneSatelliteZoom(lat,lon,anchorR)",
    "sceneSatelliteVerdict(loaded,grid,anchorR)",
  ]) assert.ok(src.includes(needle), `expected ${PAGE} to contain: ${needle}`);

  // The old centre-on-the-fence arithmetic must be GONE, not merely bypassed.
  assert.ok(!src.includes("plane.position.set(cx-px"),
    "the photo is still being placed on the fence centroid");
  assert.ok(!/sceneSatelliteZoom\(lat,lon,fenceR\)/.test(src),
    "the zoom is still chosen from the fence radius alone");

  // The walk-it path and the fence group must be offset by the SAME centre, or
  // the tour peels away from the fence it is touring.
  assert.ok(src.includes("const lx=p.x-anchor.x, lz=p.z-anchor.z"),
    "toWorld still un-offsets by cx/cz while the group was offset by the anchor");
});

test("positive control: the quote payload actually carries the house", () => {
  assert.ok(/admin\.from\("site_markers"\)/.test(view), `${VIEW} never reads site_markers`);
  assert.ok(/\{ data: houseMarkers \}/.test(view), "the site_markers result is not destructured");
  assert.ok(/markers: \(houseMarkers \?\? \[\]\)/.test(view), "markers never reach the payload");
  // Scoped exactly like the fence_runs read beside it.
  for (const needle of [`.eq("kind", "HOUSE")`, `.is("deleted_at", null)`,
                        `.eq("job_sync_id", job.sync_id)`, `.eq("company_id", job.company_id)`]) {
    assert.ok(view.includes(needle), `${VIEW} is missing ${needle} on the marker read`);
  }
});

/* ======================================================================== */
/* THE CANARY -- the same assertion, run against the OLD behaviour.         */
/* It must FAIL, or these tests could pass on an unchanged page.            */
/* ======================================================================== */

test("CANARY: centring on the fence puts the address 60ft from the house, and fails the test", () => {
  const z = M.sceneSatelliteZoom(LAT, LON, M.sceneAnchorRadiusFt(all, { x: centroid.x, z: centroid.z }));
  const grid = M.sceneSatelliteGrid(LAT, LON, z);

  // The page as it shipped: ground centred so the address sits on the fence's
  // middle. sceneGroundCentre is the shipped function; handing it the CENTROID
  // instead of the house reproduces the old behaviour exactly.
  const oldAddress = addressOf(grid, M.sceneGroundCentre(grid, { x: centroid.x, z: centroid.z }));
  const house = M.sceneHouseAnchor([HOUSE_MARKER], PPF);
  const off = Math.hypot(oldAddress.x - house.x, oldAddress.z - house.z);

  // This is the bug, as a number.
  assert.ok(Math.abs(off - 60.23) < 0.05,
    `expected the old centring to miss the house by 60.23ft, measured ${off.toFixed(2)}ft`);

  // And it genuinely fails the assertion the new behaviour passes.
  assert.throws(
    () => assert.ok(off < 0.01, "address must land on the house"),
    "the canary did NOT fail against the old behaviour -- this suite proves nothing",
  );
});

/* ======================================================================== */
/* WITH A HOUSE MARKER                                                      */
/* ======================================================================== */

test("the geocoded address lands exactly under the house marker", () => {
  const house = M.sceneHouseAnchor([HOUSE_MARKER], PPF);
  const anchorR = M.sceneAnchorRadiusFt(all, house);
  const grid = M.sceneSatelliteGrid(LAT, LON, M.sceneSatelliteZoom(LAT, LON, anchorR));
  const address = addressOf(grid, M.sceneGroundCentre(grid, house));
  assert.ok(Math.hypot(address.x - house.x, address.z - house.z) < 1e-9,
    `address landed ${address.x},${address.z}; house is at ${house.x},${house.z}`);
});

test("the fence is offset from the address by exactly the drawn house-to-fence vector in feet", () => {
  const house = M.sceneHouseAnchor([HOUSE_MARKER], PPF);
  const anchorR = M.sceneAnchorRadiusFt(all, house);
  const grid = M.sceneSatelliteGrid(LAT, LON, M.sceneSatelliteZoom(LAT, LON, anchorR));
  const address = addressOf(grid, M.sceneGroundCentre(grid, house));

  RUN_PX.forEach(([px, py], i) => {
    // What the DRAWING says, converted to feet, with no scene maths involved.
    const wantX = (px - HOUSE_PX.x) / PPF;
    const wantZ = (py - HOUSE_PX.y) / PPF;
    // What the scene does: the fence point relative to where the address landed.
    const gotX = all[i].x - address.x;
    const gotZ = all[i].z - address.z;
    assert.ok(Math.abs(gotX - wantX) < 1e-9 && Math.abs(gotZ - wantZ) < 1e-9,
      `point ${i}: drawing says (${wantX}, ${wantZ}) ft from the house, scene gives (${gotX}, ${gotZ})`);
  });

  // And that vector is the 60.23ft the old code was throwing away.
  assert.ok(Math.abs(Math.hypot(house.x - centroid.x, house.z - centroid.z) - 60.23) < 0.05,
    "the fixture no longer has the house 60.23ft from the fence centroid");
});

test("the frame holds BOTH the house and every fence post, with margin to spare", () => {
  const house = M.sceneHouseAnchor([HOUSE_MARKER], PPF);
  const anchorR = M.sceneAnchorRadiusFt(all, house);
  const grid = M.sceneSatelliteGrid(LAT, LON, M.sceneSatelliteZoom(LAT, LON, anchorR));
  const g = M.sceneGroundCentre(grid, house);
  const half = g.sideFt / 2;

  for (const [label, p] of [["the house", house], ...all.map((p, i) => [`post ${i}`, p])]) {
    assert.ok(Math.abs(p.x - g.x) <= half && Math.abs(p.z - g.z) <= half,
      `${label} falls outside the photo`);
  }
  // Not merely inside -- inside by the margin the page promises, so nothing
  // sits hard against the edge looking like a mistake.
  const worst = Math.min(...[house, ...all].flatMap((p) =>
    [half - Math.abs(p.x - g.x), half - Math.abs(p.z - g.z)]));
  assert.ok(worst >= M.SAT_MARGIN_FT, `closest thing is ${worst.toFixed(1)}ft from the edge, want >= ${M.SAT_MARGIN_FT}`);
});

test("the needed reach grows from the fence radius to the house-to-fence extent", () => {
  const house = M.sceneHouseAnchor([HOUSE_MARKER], PPF);
  const anchorR = M.sceneAnchorRadiusFt(all, house);
  // 56.9ft measured from the fence's own middle; 86.9ft measured from the house.
  assert.ok(Math.abs(fenceR - 56.92) < 0.05, `fenceR is ${fenceR.toFixed(2)}, expected 56.92`);
  assert.ok(Math.abs(anchorR - 86.90) < 0.05, `anchorR is ${anchorR.toFixed(2)}, expected 86.90`);
  assert.ok(anchorR > fenceR, "anchoring did not widen what the photo must cover");
  // Which is what the zoom chooser is then asked for.
  assert.ok(M.sceneSatelliteNeedFt(anchorR) > M.sceneSatelliteNeedFt(fenceR));
});

test("the zoom stays inside the measured cap and never below the floor", () => {
  const house = M.sceneHouseAnchor([HOUSE_MARKER], PPF);
  const anchorR = M.sceneAnchorRadiusFt(all, house);
  const z = M.sceneSatelliteZoom(LAT, LON, anchorR);
  assert.ok(z <= M.SAT_ZOOM_CAP, `chose z${z}, above the cap of ${M.SAT_ZOOM_CAP} (22+ is 404 everywhere)`);
  assert.ok(z >= M.SAT_ZOOM_FLOOR, `chose z${z}, below the floor of ${M.SAT_ZOOM_FLOOR}`);
  // This job still gets the sharpest level: anchoring cost it no imagery.
  assert.equal(z, 21, "this job no longer gets z21; anchoring made its photo softer");

  // A house far from a big fence must step DOWN rather than run off the photo.
  const farR = M.sceneAnchorRadiusFt(all, { x: centroid.x - 400, z: centroid.z });
  const zFar = M.sceneSatelliteZoom(LAT, LON, farR);
  assert.ok(zFar <= M.SAT_ZOOM_CAP && zFar >= M.SAT_ZOOM_FLOOR,
    `a 400ft offset chose z${zFar}, outside [${M.SAT_ZOOM_FLOOR}, ${M.SAT_ZOOM_CAP}]`);
  assert.ok(zFar < 21, "a house 400ft from the fence still asks for z21, which cannot hold both");
});

/* ======================================================================== */
/* WITHOUT A HOUSE MARKER -- the fallback, and the page saying so            */
/* ======================================================================== */

test("no marker: the anchor refuses to guess, and the framing is unchanged from today", () => {
  assert.equal(M.sceneHouseAnchor([], PPF), null, "an empty marker list produced an anchor");
  assert.equal(M.sceneHouseAnchor(undefined, PPF), null, "a missing payload field produced an anchor");
  // An old deploy that does not send `markers` at all must land here too.
  assert.equal(M.sceneHouseAnchor(null, PPF), null);

  // The fallback anchor is the centroid, and measured from the centroid the
  // reach is EXACTLY the old fenceR -- no existing quote's photo changes.
  const anchorR = M.sceneAnchorRadiusFt(all, { x: centroid.x, z: centroid.z });
  assert.ok(Math.abs(anchorR - fenceR) < 1e-12,
    `fallback reach ${anchorR} differs from the old fenceR ${fenceR}`);
  assert.equal(M.sceneSatelliteZoom(LAT, LON, anchorR), M.sceneSatelliteZoom(LAT, LON, fenceR));

  // And the photo lands in EXACTLY the old place. The page shipped
  //    px=(grid.ox/N-.5)*sideFt;  pz=(grid.oy/N-.5)*sideFt;
  //    plane.position.set(cx-px, 0.02, cz-pz)
  // so a quote already open must come out bit-for-bit where it is today.
  // Without this, "no regression" is an argument rather than a measurement.
  const grid = M.sceneSatelliteGrid(LAT, LON, M.sceneSatelliteZoom(LAT, LON, anchorR));
  const oldPx = (grid.ox / grid.N - 0.5) * grid.sideFt;
  const oldPz = (grid.oy / grid.N - 0.5) * grid.sideFt;
  const got = M.sceneGroundCentre(grid, { x: centroid.x, z: centroid.z });
  assert.equal(got.x, centroid.x - oldPx, "the photo moved east/west for a job with no house");
  assert.equal(got.z, centroid.z - oldPz, "the photo moved north/south for a job with no house");
  assert.equal(got.sideFt, grid.sideFt);

  // Control: the same comparison against the HOUSE anchor must NOT match, or
  // the two assertions above would pass no matter what the anchor did.
  const house = M.sceneHouseAnchor([HOUSE_MARKER], PPF);
  assert.notEqual(M.sceneGroundCentre(grid, house).x, centroid.x - oldPx);
});

test("no marker: other marker kinds never stand in for a house", () => {
  for (const kind of ["TREE", "UTILITY", "EASEMENT", "POOL", "DRIVEWAY", "EXISTING_FENCE", "SLOPE", "OBSTACLE"]) {
    assert.equal(M.sceneHouseAnchor([{ kind, x: 1000, y: 1000 }], PPF), null,
      `a ${kind} marker was treated as the house`);
  }
  // Control: the very same call with HOUSE does produce one, so the filter is
  // discriminating and not just returning null for everything.
  assert.notEqual(M.sceneHouseAnchor([{ kind: "HOUSE", x: 1000, y: 1000 }], PPF), null);
});

test("two houses: refuse rather than pick one", () => {
  const two = [HOUSE_MARKER, { kind: "HOUSE", x: 100, y: 100 }];
  assert.equal(M.sceneHouseAnchor(two, PPF), null,
    "two HOUSE markers silently picked one -- exactly the guess this replaces");
  // Control: drop one and it resolves again.
  assert.notEqual(M.sceneHouseAnchor([two[0]], PPF), null);
});

test("junk coordinates and a junk scale refuse rather than place the yard at infinity", () => {
  assert.equal(M.sceneHouseAnchor([{ kind: "HOUSE", x: NaN, y: 10 }], PPF), null);
  assert.equal(M.sceneHouseAnchor([{ kind: "HOUSE", x: 10, y: Infinity }], PPF), null);
  assert.equal(M.sceneHouseAnchor([{ kind: "HOUSE", x: "no", y: "no" }], PPF), null);
  // A missing pxPerFoot falls back to the page's documented 20, never to 0.
  const h = M.sceneHouseAnchor([{ kind: "HOUSE", x: 400, y: 200 }], 0);
  assert.deepEqual(h, { x: 20, z: 10 });
});

test("the page SAYS which picture it is, in all three languages, by key", () => {
  // The fallback must never be silent: that silence is the reported bug.
  assert.ok(src.includes("note.textContent=tr(houseAnchor?'posFromHouse':'posApprox')"),
    "the page no longer states whether the position is anchored or approximate");
  assert.ok(src.includes('<div id="mapNote"'), "the note has no element to render into");

  // Compared by KEY, never by looking for a particular word -- translating a
  // label must not be able to fail this.
  // How many language tables there are, counted off a key that has always been
  // in all of them. `turnFence:` is the table entry; the markup spells it
  // data-t="turnFence" and is deliberately not counted here.
  const tables = src.split("turnFence:").length - 1;
  assert.equal(tables, 3, `expected 3 language tables, found ${tables}`);
  for (const key of ["posFromHouse", "posApprox"]) {
    const n = src.split(key + ":").length - 1;
    assert.equal(n, 3, `${key} is defined in ${n} language tables, expected 3`);
  }
  // Each definition must be non-empty.
  for (const m of src.matchAll(/pos(?:FromHouse|Approx): '([^']*)'/g)) {
    assert.ok(m[1].trim().length > 10, `an empty or stub translation: "${m[1]}"`);
  }
});

/* ======================================================================== */
/* NOTHING HERE MAY MOVE A PRICE                                            */
/* ======================================================================== */

test("the house is a reference point, not a fence: no quantity or money touches it", () => {
  // The anchor must not reach the totals. runFeet/installTotals are what the
  // page bills from; neither may learn about markers or the anchor.
  const slice = (name) => grab(name);
  for (const fn of ["runFeet", "installTotals"]) {
    const body = slice(fn);
    for (const word of ["marker", "anchor", "house", "House", "HOUSE"]) {
      assert.ok(!body.includes(word), `${fn}() now mentions "${word}" -- a reference point is affecting a quantity`);
    }
  }
  // And the new functions must not compute feet of fence, a count or a price.
  for (const fn of ["sceneHouseAnchor", "sceneAnchorRadiusFt", "sceneGroundCentre"]) {
    const body = slice(fn);
    for (const word of ["price", "Price", "total", "Total", "manualFeet", "gates", "deposit"]) {
      assert.ok(!body.includes(word), `${fn}() mentions "${word}"`);
    }
  }
  // `markers` is read in exactly one place on the page: the anchor.
  const uses = src.split("quote.markers").length - 1;
  assert.equal(uses, 1, `quote.markers is read ${uses} times; it must only feed the anchor`);

  // The payload exposes HOUSE markers only -- the other kinds are the
  // contractor's own site notes and a customer's link is not where they go.
  assert.ok(!/select\("kind, x, y, label"\)/.test(view), "the marker read now leaks the label");
  const sel = view.match(/from\("site_markers"\)\s*\n?\s*\.select\("([^"]+)"\)/);
  assert.ok(sel, "could not find the site_markers select");
  assert.deepEqual(sel[1].split(",").map((s) => s.trim()).sort(), ["kind", "x", "y"],
    `the marker read selects ${sel[1]}; it must select only kind, x and y`);
});
