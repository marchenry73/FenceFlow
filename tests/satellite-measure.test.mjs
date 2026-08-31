/* The arithmetic behind "measure a fence off a satellite photo".
   A scale factor that is quietly wrong here does not look wrong -- it looks
   like a fence, and the error only surfaces when the materials arrive short.
   So the distances are checked against figures worked out independently.

   Everything below is spherical Web Mercator, because that is the projection
   the satellite tiles themselves are drawn in. Against the real (slightly
   squashed) earth a north-south distance is out by about 0.4%; matching the
   imagery matters more than matching the ellipsoid, and 0.4% of a 200 ft fence
   is ten inches. */
import { readFileSync } from 'node:fs';
const src = readFileSync('website/dashboard.html', 'utf8');

const grab = (name) => {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
};
const code = ['satWorld','satUnworld','satFeetPerPx','satLength'].map(grab).join('\n\n');
const M = new Function(code + '\nreturn {satWorld,satUnworld,satFeetPerPx,satLength};')();

let pass = 0, fail = 0;
const near = (label, got, want, tolPct) => {
  const off = Math.abs(got - want) / want * 100;
  if (off <= tolPct) pass++;
  else { fail++; console.log('FAIL  ' + label + '\n      got ' + got.toFixed(3)
    + '  want ' + want.toFixed(3) + '  (off by ' + off.toFixed(2) + '%)'); }
};
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log('FAIL  ' + label + '\n      got  ' + JSON.stringify(got)
    + '\n      want ' + JSON.stringify(want)); }
};

/* Riverview, Florida — where the first real measurements will happen. */
const LAT = 27.78, LON = -82.34, Z = 20;
const FT_PER_M = 3.280839895;
const M_PER_DEG = 40075016.686 / 360;          // spherical earth, one degree at the equator

/* ---- 1. East to west, a tenth of a milli-degree at a time -------------- */
{
  const d = 0.001;
  const expectM = M_PER_DEG * Math.cos(LAT * Math.PI / 180) * d;
  const pts = [{ lat: LAT, lon: LON }, { lat: LAT, lon: LON + d }];
  near('east-west 0.001 deg', M.satLength(pts, false, LAT, Z), expectM * FT_PER_M, 0.5);
}

/* ---- 2. North to south. Mercator stretches this, and the feet-per-pixel
          factor has to unstretch it. If those two ever disagree, this fails. */
{
  const d = 0.001;
  const expectM = M_PER_DEG * d;
  const pts = [{ lat: LAT, lon: LON }, { lat: LAT + d, lon: LON }];
  near('north-south 0.001 deg', M.satLength(pts, false, LAT, Z), expectM * FT_PER_M, 0.5);
}

/* ---- 3. A 100 ft leg should measure 100 ft ----------------------------- */
{
  const ft = 100;
  const degLon = ft / FT_PER_M / (M_PER_DEG * Math.cos(LAT * Math.PI / 180));
  const pts = [{ lat: LAT, lon: LON }, { lat: LAT, lon: LON + degLon }];
  near('a 100 ft run measures 100 ft', M.satLength(pts, false, LAT, Z), 100, 0.5);
}

/* ---- 4. Four sides of a square, and the same square closed ------------- */
{
  const side = 80;
  const degLon = side / FT_PER_M / (M_PER_DEG * Math.cos(LAT * Math.PI / 180));
  const degLat = side / FT_PER_M / M_PER_DEG;
  const sq = [
    { lat: LAT,          lon: LON },
    { lat: LAT,          lon: LON + degLon },
    { lat: LAT + degLat, lon: LON + degLon },
    { lat: LAT + degLat, lon: LON },
  ];
  near('three sides open',  M.satLength(sq, false, LAT, Z), side * 3, 0.5);
  near('four sides closed', M.satLength(sq, true,  LAT, Z), side * 4, 0.5);
}

/* ---- 5. Zoom must not change the length of a fence --------------------- */
{
  const pts = [{ lat: LAT, lon: LON }, { lat: LAT + 0.0004, lon: LON + 0.0006 }];
  const at20 = M.satLength(pts, false, LAT, 20);
  const at18 = M.satLength(pts, false, LAT, 18);
  const at16 = M.satLength(pts, false, LAT, 16);
  near('zoom 18 agrees with 20', at18, at20, 0.001);
  near('zoom 16 agrees with 20', at16, at20, 0.001);
}

/* ---- 6. Projecting there and back lands where it started --------------- */
{
  const w = M.satWorld(LAT, LON, Z);
  const back = M.satUnworld(w.x, w.y, Z);
  near('round trip latitude',  back.lat, LAT, 0.0001);
  near('round trip longitude', Math.abs(back.lon), Math.abs(LON), 0.0001);
}

/* ---- 7. What gets written to the fence run.
          The app draws at 20 pixels to the foot, so an 80 ft leg must come out
          1600 pixels long, and the first corner must sit at the origin. ---- */
{
  const side = 80, PX_PER_FT = 20;
  const degLon = side / FT_PER_M / (M_PER_DEG * Math.cos(LAT * Math.PI / 180));
  const pts = [{ lat: LAT, lon: LON }, { lat: LAT, lon: LON + degLon }];
  const f = M.satFeetPerPx(LAT, Z);
  const o = M.satWorld(pts[0].lat, pts[0].lon, Z);
  const enc = pts.map(p => {
    const w = M.satWorld(p.lat, p.lon, Z);
    return [ (w.x - o.x) * f * PX_PER_FT, (w.y - o.y) * f * PX_PER_FT ];
  });
  eq('first corner sits at the origin', enc[0].map(n => Math.round(n)), [0, 0]);
  near('80 ft becomes 1600 survey pixels', enc[1][0], side * PX_PER_FT, 0.5);
  near('and does not drift sideways', Math.abs(enc[1][1]) + 1, 1, 0.5);
}

/* ---- 8. Guards ---------------------------------------------------------- */
eq('no points measures nothing',  M.satLength([], false, LAT, Z), 0);
eq('one point measures nothing',  M.satLength([{ lat: LAT, lon: LON }], false, LAT, Z), 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
