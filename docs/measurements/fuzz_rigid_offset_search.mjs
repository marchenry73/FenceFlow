// CAN A NEARBY OFFSET ALWAYS BE FOUND THAT MOVES THE DRAWING RIGIDLY?
//
// The plain offset is not rigid in float32: 12.5% of grid-like drawings come
// out a ten-thousandth of a foot different, and on a side whose length is an
// exact multiple of the post spacing that is enough to add a bay -- a post and
// a panel of real money.
//
// A finger drag's exact sub-pixel offset means nothing to the user, so the
// offset is free to be adjusted by a hair. The question this answers is
// whether a hair is always enough: try the requested offset, then a small set
// of neighbours, and keep the first for which EVERY side's length in float32
// is bit-identical to what it was. If one can always be found, the tool is
// rigid by construction and the claim in the code is true.

const f = Math.fround;
const hypot32 = (dx, dy) => f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));

/** Every side's length, the way the engine measures them. */
function sideLengths(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    out.push(hypot32(f(points[i].x - points[i - 1].x), f(points[i].y - points[i - 1].y)));
  }
  return out;
}
const shift = (points, dx, dy) => points.map((p) => ({ x: f(p.x + dx), y: f(p.y + dy) }));

/** One ULP step on a float32, up or down. */
const buf = new DataView(new ArrayBuffer(4));
function ulpStep(v, steps) {
  buf.setFloat32(0, v);
  let bits = buf.getUint32(0);
  // Move away from zero for positive steps on positive values, etc. Treating
  // the bit pattern as an ordered integer is exact for same-sign floats.
  bits = (bits + steps) >>> 0;
  buf.setUint32(0, bits);
  return buf.getFloat32(0);
}

/** The candidates, in the order they are tried. */
function candidates(dx, dy) {
  const out = [[dx, dy]];
  out.push([f(Math.round(dx)), f(Math.round(dy))]);          // whole drawing pixels
  out.push([f(Math.round(dx * 2) / 2), f(Math.round(dy * 2) / 2)]);
  for (let s = 1; s <= 6; s++) {
    out.push([ulpStep(dx, s), dy]);
    out.push([dx, ulpStep(dy, s)]);
    out.push([ulpStep(dx, -s), dy]);
    out.push([dx, ulpStep(dy, -s)]);
    out.push([ulpStep(dx, s), ulpStep(dy, s)]);
  }
  return out;
}

function rngFactory(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const rnd = rngFactory(20261023);
const PX_PER_FT = 20;

let found = 0;
let notFound = 0;
const triesHistogram = new Map();

function runTrials(label, makePoints, trials) {
  found = 0; notFound = 0; triesHistogram.clear();
  for (let t = 0; t < trials; t++) {
    const points = makePoints();
    const want = sideLengths(points);
    const dx = f((rnd() - 0.5) * 4000);
    const dy = f((rnd() - 0.5) * 4000);
    let hit = -1;
    const cands = candidates(dx, dy);
    for (let i = 0; i < cands.length; i++) {
      const [cx, cy] = cands[i];
      if (cx === 0 && cy === 0) continue;
      const got = sideLengths(shift(points, cx, cy));
      if (got.every((v, k) => v === want[k])) { hit = i; break; }
    }
    if (hit < 0) notFound++;
    else {
      found++;
      triesHistogram.set(hit, (triesHistogram.get(hit) || 0) + 1);
    }
  }
  console.log(`\n${label}: rigid offset found ${found}/${trials}, NOT found ${notFound}`);
  const top = [...triesHistogram.entries()].sort((a, b) => a[0] - b[0]).slice(0, 6);
  console.log(`  first success at candidate index: ${top.map(([i, n]) => `${i}:${n}`).join("  ")}`);
}

// Grid-like: whole and half feet across a 400 ft yard.
runTrials("grid-like drawings (2-5 corners)", () => {
  const n = 2 + Math.floor(rnd() * 4);
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push({
      x: f(Math.round(rnd() * 800) / 2 * PX_PER_FT),
      y: f(Math.round(rnd() * 800) / 2 * PX_PER_FT),
    });
  }
  return pts;
}, 20000);

// Arbitrary taps: coordinates with full mantissas, which is what a finger on
// a satellite tile actually produces.
runTrials("arbitrary tapped coordinates", () => {
  const n = 2 + Math.floor(rnd() * 4);
  const pts = [];
  for (let i = 0; i < n; i++) pts.push({ x: f(rnd() * 8000), y: f(rnd() * 8000) });
  return pts;
}, 20000);

// A long run with many corners -- the hardest case, since every side must
// match at once.
runTrials("a 20-corner run", () => {
  const pts = [];
  for (let i = 0; i < 20; i++) pts.push({ x: f(rnd() * 8000), y: f(rnd() * 8000) });
  return pts;
}, 5000);
