// IS A WHOLE-DRAWING MOVE REALLY RIGID IN FLOAT32?
//
// The claim in the code and in his check list is that a move cannot change a
// price, because every length is a difference of coordinates and a constant
// added to both ends cancels. ALGEBRAICALLY that is true. In float32 it is
// not obviously true: (x1 + d) and (x2 + d) are each ROUNDED, so their
// difference can come out a rounding step away from (x1 - x2).
//
// That matters for one reason only: a bay count is ceil(lengthFt / spacing).
// A side whose length sits EXACTLY on a bay boundary -- 96 ft at 8 ft
// spacing, which is an ordinary yard -- gains a whole post and a whole panel
// if its length comes back a hair over.
//
// Math.fround gives exactly the float32 rounding the app does, so this
// measures the real thing rather than arguing about it.

const f = Math.fround;
const hypot32 = (dx, dy) => f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));

/** Total length of a polyline, the way FenceGeometryEngine.analyze does it. */
function totalPx(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    // analyze accumulates in Float (totalPixels += distPx).
    total = f(total + hypot32(f(points[i].x - points[i - 1].x), f(points[i].y - points[i - 1].y)));
  }
  return total;
}

const shift = (points, dx, dy) => points.map((p) => ({ x: f(p.x + dx), y: f(p.y + dy) }));

// ---- 1. Realistic grid drawings: round feet, round offsets ---------------
// The grid is 20 px/ft. A yard traced on it lands on whole or half feet.
const PX_PER_FT = 20;
let worstFeet = 0;
let changed = 0;
let trials = 0;

function rngFactory(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rnd = rngFactory(20261023);

for (let t = 0; t < 200000; t++) {
  const n = 2 + Math.floor(rnd() * 4);
  const points = [];
  for (let i = 0; i < n; i++) {
    // Whole and half feet, within a 400 ft yard, as the grid produces.
    points.push({
      x: f(Math.round(rnd() * 800) / 2 * PX_PER_FT),
      y: f(Math.round(rnd() * 800) / 2 * PX_PER_FT),
    });
  }
  // Offsets a finger produces: anything, including large ones.
  const dx = f((rnd() - 0.5) * 4000);
  const dy = f((rnd() - 0.5) * 4000);
  const before = f(totalPx(points) / PX_PER_FT);
  const after = f(totalPx(shift(points, dx, dy)) / PX_PER_FT);
  trials++;
  if (before !== after) {
    changed++;
    worstFeet = Math.max(worstFeet, Math.abs(before - after));
  }
}
console.log(`grid-like drawings: ${changed}/${trials} changed total footage`);
console.log(`worst change: ${worstFeet} ft (${worstFeet * 12} inches)`);

// ---- 2. Does any of it ever flip a BAY COUNT? ---------------------------
// The only way a rounding step becomes money. Aimed deliberately at the
// boundary: sides whose length is an exact multiple of the spacing.
const SPACINGS = [6, 8, 10];
let flips = 0;
let boundaryTrials = 0;
for (const spacing of SPACINGS) {
  for (let bays = 1; bays <= 60; bays++) {
    const lengthFt = bays * spacing;           // exactly on the boundary
    for (let t = 0; t < 4000; t++) {
      // A horizontal, vertical, and diagonal side of exactly that length.
      const variants = [
        [{ x: 0, y: 0 }, { x: f(lengthFt * PX_PER_FT), y: 0 }],
        [{ x: 0, y: 0 }, { x: 0, y: f(lengthFt * PX_PER_FT) }],
      ];
      const dx = f((rnd() - 0.5) * 8000);
      const dy = f((rnd() - 0.5) * 8000);
      for (const pts of variants) {
        const before = Math.ceil(f(totalPx(pts) / PX_PER_FT) / spacing);
        const after = Math.ceil(f(totalPx(shift(pts, dx, dy)) / PX_PER_FT) / spacing);
        boundaryTrials++;
        if (before !== after) {
          flips++;
          if (flips <= 5) {
            console.log(
              `  BAY FLIP: ${lengthFt} ft at ${spacing} ft spacing, offset (${dx}, ${dy}): ` +
              `${before} -> ${after} bays`
            );
          }
        }
      }
    }
  }
}
console.log(`bay-boundary sides: ${flips}/${boundaryTrials} flipped a bay count`);
