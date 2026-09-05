/* The homeowner quote page's 3D fence, pure half only: everything from
   colour/shape decisions down to scenePlanRun()'s fully-resolved post and
   board list is plain numbers and strings, no THREE, no DOM -- pulled
   straight out of website/quote.html and run standalone, same idiom as
   tests/wizard-encoding.test.mjs and tests/satellite-measure.test.mjs.
   Everything past that point (buildRunMeshes, build3D itself) is a
   mechanical THREE.js translation of the plan and is not unit-tested here,
   the same reason build3D() never was before this change: there is no
   WebGL in the test runner. */
import { readFileSync } from 'node:fs';
const src = readFileSync('website/quote.html', 'utf8');

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
const grabConst = (name) => {
  const start = src.indexOf('const ' + name);
  if (start < 0) throw new Error('not found: ' + name);
  const end = src.indexOf(';', start);
  return src.slice(start, end + 1);
};

const code = [
  grabConst('SCENE_CORNER_ANGLE_THRESHOLD_DEGREES'),
  ...[
    'sceneMulberry32', 'sceneHexToRgb', 'sceneShade', 'sceneHexCss',
    'sceneFinishColor', 'sceneClassifyVertices', 'sceneParsePoints', 'sceneParseGates',
    'scenePanelKind', 'sceneMaterialKind', 'sceneBoardLayout', 'scenePicketLayout',
    'scenePlanRun', 'scenePathLengths', 'scenePointAtDistance', 'sceneFlatPlanSVG',
  ].map(grab),
].join('\n\n');
const M = new Function(code + `
  return { sceneMulberry32, sceneHexToRgb, sceneShade, sceneHexCss,
    sceneFinishColor, sceneClassifyVertices, sceneParsePoints, sceneParseGates,
    scenePanelKind, sceneMaterialKind, sceneBoardLayout, scenePicketLayout,
    scenePlanRun, scenePathLengths, scenePointAtDistance, sceneFlatPlanSVG };
`)();

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log('FAIL  ' + label + '\n      got  ' + JSON.stringify(got)
    + '\n      want ' + JSON.stringify(want)); }
};
const ok = (label, cond) => { if (cond) pass++; else { fail++; console.log('FAIL  ' + label); } };
const near = (label, got, want, tol) => {
  if (Math.abs(got - want) <= tol) pass++;
  else { fail++; console.log('FAIL  ' + label + '  got ' + got + '  want ' + want); }
};

/* ---------- sceneMulberry32: deterministic PRNG ---------- */

{
  const a = M.sceneMulberry32(42), b = M.sceneMulberry32(42);
  const seqA = [a(), a(), a()], seqB = [b(), b(), b()];
  eq('same seed produces the same sequence', seqA, seqB);
  ok('values land in [0,1)', seqA.every(v => v >= 0 && v < 1));
  const c = M.sceneMulberry32(43);
  ok('a different seed produces a different first value', c() !== M.sceneMulberry32(42)());
}

/* ---------- sceneHexToRgb / sceneShade / sceneHexCss ---------- */

eq('decomposes a hex colour', M.sceneHexToRgb(0xFF8020), [0xFF, 0x80, 0x20]);
eq('shade lightens', M.sceneShade([100, 100, 100], 0.2), [151, 151, 151]);
eq('shade clamps at 255', M.sceneShade([250, 250, 250], 0.5), [255, 255, 255]);
eq('shade clamps at 0', M.sceneShade([10, 10, 10], -0.5), [0, 0, 0]);
eq('css hex is zero-padded', M.sceneHexCss(0x00FF00), '#00ff00');
eq('css hex ignores anything above 24 bits', M.sceneHexCss(0x1FFFFFF), '#ffffff');

/* ---------- sceneFinishColor: keyword match, then per-type fallback ---------- */

eq('White vinyl', M.sceneFinishColor('VINYL', 'White'), 0xF2F1EA);
eq('Black ornamental iron', M.sceneFinishColor('ORNAMENTAL_IRON', 'Black'), 0x24262B);
eq('lowercase finish still matches', M.sceneFinishColor('ALUMINUM', 'black'), 0x24262B);
eq('an actual catalog value on file', M.sceneFinishColor('VINYL', 'Purple'), 0x5B4A73);
eq('Galvanized reads as the grey family', M.sceneFinishColor('CHAIN_LINK', 'Galvanized'), 0x9AA3AA);
eq('blank finish falls back to WOOD\'s own colour', M.sceneFinishColor('WOOD', ''), 0xA9744A);
eq('blank finish falls back to VINYL\'s own colour', M.sceneFinishColor('VINYL', ''), 0xF2F1EA);
eq('an unrecognised type with no finish still returns something', M.sceneFinishColor('UNIVERSAL', ''), 0xB9B2A4);

/* ---------- sceneClassifyVertices: parity with FenceGeometryEngine ---------- */
/* Reuses the exact bend angles from fixtures/pricing/corner-15-1-degrees.json
   and corner-14-9-degrees.json (atan(540/2000) and atan(532/2000)) so this
   view's corner posts land exactly where the estimate already put one. */

{
  const bendCorner = [{x:0,y:0},{x:2000,y:0},{x:4000,y:540}];
  eq('a 15.1-degree bend is a CORNER', M.sceneClassifyVertices(bendCorner, false), ['END','CORNER','END']);
  const bendLine = [{x:0,y:0},{x:2000,y:0},{x:4000,y:532}];
  eq('a 14.9-degree bend is a LINE vertex', M.sceneClassifyVertices(bendLine, false), ['END','LINE','END']);
}
{
  // A closed square: every vertex is an interior vertex (no END at all),
  // and a 90-degree turn is well past the corner threshold.
  const square = [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}];
  eq('a closed square is all corners', M.sceneClassifyVertices(square, true), ['CORNER','CORNER','CORNER','CORNER']);
}
{
  // The same four points, open: first and last are END, and the vertex
  // that would have closed the loop is no longer classified at all.
  const openSquare = [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}];
  eq('the same points open: two ENDs, two CORNERs', M.sceneClassifyVertices(openSquare, false), ['END','CORNER','CORNER','END']);
}
eq('fewer than two points is all END (degenerate, never a real run)', M.sceneClassifyVertices([{x:0,y:0}], false), ['END']);

/* ---------- sceneParsePoints / sceneParseGates ---------- */

eq('parses a simple run', M.sceneParsePoints('0:0,100:0,100:50'), [{x:0,y:0},{x:100,y:0},{x:100,y:50}]);
eq('empty string parses to nothing', M.sceneParsePoints(''), []);
eq('null-safe', M.sceneParsePoints(null), []);
eq('drops a pair that fails to parse', M.sceneParsePoints('0:0,not-a-point,100:0'), [{x:0,y:0},{x:100,y:0}]);

eq('5-part gate keeps mounting and swing', M.sceneParseGates('50:0:4:WALL:OUT'), [{x:50,y:0,w:4,mounting:'WALL',swing:'OUT'}]);
eq('3-part legacy gate defaults to LINE/IN', M.sceneParseGates('50:0:4'), [{x:50,y:0,w:4,mounting:'LINE',swing:'IN'}]);
eq('missing width defaults to 4ft', M.sceneParseGates('50:0'), [{x:50,y:0,w:4,mounting:'LINE',swing:'IN'}]);
eq('empty gate string parses to no gates', M.sceneParseGates(''), []);

/* ---------- scenePanelKind / sceneMaterialKind ---------- */

eq('wood privacy is a board layout', M.scenePanelKind('WOOD','PRIVACY'), 'board');
eq('wood spaced picket is a picket layout', M.scenePanelKind('WOOD','SPACED_PICKET'), 'picket');
eq('composite is a board layout too', M.scenePanelKind('COMPOSITE',''), 'board');
eq('chain link is its own layout', M.scenePanelKind('CHAIN_LINK',''), 'chain');
eq('aluminum is a picket layout', M.scenePanelKind('ALUMINUM','FLAT_TOP'), 'picket');
eq('ornamental iron is a picket layout', M.scenePanelKind('ORNAMENTAL_IRON',''), 'picket');
eq('split rail is its own layout', M.scenePanelKind('SPLIT_RAIL',''), 'split');
eq('vinyl (and anything unknown) is a solid panel', M.scenePanelKind('VINYL',''), 'panel');
eq('an unrecognised type falls back to panel', M.scenePanelKind('UNIVERSAL',''), 'panel');

eq('aluminum material', M.sceneMaterialKind('ALUMINUM'), 'aluminum');
eq('ornamental iron material', M.sceneMaterialKind('ORNAMENTAL_IRON'), 'iron');
eq('split rail material is rough-cut rail', M.sceneMaterialKind('SPLIT_RAIL'), 'rail');
eq('composite gets its own flatter texture, distinct from wood', M.sceneMaterialKind('COMPOSITE'), 'composite');
eq('wood material', M.sceneMaterialKind('WOOD'), 'wood');
eq('chain link material', M.sceneMaterialKind('CHAIN_LINK'), 'chain');
eq('vinyl (default) material', M.sceneMaterialKind('VINYL'), 'vinyl');

/* ---------- sceneBoardLayout / scenePicketLayout ---------- */

{
  const { count, width } = M.sceneBoardLayout(8, 40);
  ok('a normal 8ft bay gets a handful of ~6in boards', count >= 12 && count <= 18);
  near('board widths tile the bay (minus the .5ft trim margin)', count * width, 8 - 0.5, 0.02);
}
{
  // A very long straight run (>200ft in one segment) widens the boards so a
  // 1200ft fence isn't asking a phone to build thousands of individual meshes.
  const short = M.sceneBoardLayout(8, 40);
  const long = M.sceneBoardLayout(8, 300);
  ok('boards widen (fewer of them) on a long straight segment', long.count < short.count);
}
eq('picket count scales with bay width', M.scenePicketLayout(8).count, Math.max(2, Math.round(8/0.35)));
ok('a picket bay always has at least 2 pickets', M.scenePicketLayout(0.1).count >= 2);

/* ---------- scenePlanRun: the full geometry plan ---------- */

{
  // No drawing at all, just a typed length: still gets a straight run with
  // an END post at both ends, not a blank lawn.
  const plan = M.scenePlanRun({ type:'VINYL', finish:'White', points:'', gates:'', closed:false,
    heightFt:6, postSpacingFt:8, manualFeet:32 }, 20, 1);
  eq('typed footage produces a straight run of that length', Math.hypot(
    plan.worldPts[1].x - plan.worldPts[0].x, plan.worldPts[1].z - plan.worldPts[0].z), 32);
  ok('both ends of a typed run get a heavy (END) post', plan.posts[0].thick && plan.posts[plan.posts.length-1].thick);
  eq('vinyl is the panel layout', plan.geomKind, 'panel');
  eq('vinyl material follows the finish colour', plan.color, 0xF2F1EA);
}
{
  // The exact 15.1-degree bend from fixtures/pricing/corner-15-1-degrees.json,
  // scaled to real feet at 20px/ft: the bend sits at (100ft, 0ft).
  const plan = M.scenePlanRun({ type:'WOOD', woodStyle:'PRIVACY', finish:'', points:'0:0,2000:0,4000:540',
    gates:'', closed:false, heightFt:6, postSpacingFt:8, manualFeet:0 }, 20, 1);
  const bend = plan.posts.find(p => Math.abs(p.x-100) < 0.5 && Math.abs(p.z-0) < 0.5);
  ok('the corner post lands exactly at the bend, and is heavy', !!bend && bend.thick === true);
  eq('a wood privacy run has three rails', plan.railYs.length, 3);
  eq('a privacy run gets the cap trim (no independent cap flag in the data)', plan.capBoard, true);
}
{
  // Composite shares wood's board layout but must never get wood's cap or
  // wood's texture -- it is its own material family.
  const plan = M.scenePlanRun({ type:'COMPOSITE', finish:'', points:'0:0,100:0', gates:'',
    closed:false, heightFt:6, postSpacingFt:8, manualFeet:0 }, 20, 1);
  eq('composite is a board layout', plan.geomKind, 'board');
  eq('composite material is its own, not wood', plan.materialKind, 'composite');
  eq('composite never gets the wood cap', plan.capBoard, false);
}
{
  // A gate mid-run: the two posts flanking its bay must both be heavy, even
  // though neither is a drawn corner or an end.
  const plan = M.scenePlanRun({ type:'ALUMINUM', aluminumStyle:'FLAT_TOP', finish:'Black',
    points:'0:0,400:0', gates:'190:0:4:LINE:IN', closed:false, heightFt:5,
    postSpacingFt:40, manualFeet:0 }, 20, 1);
  const gateBay = plan.bays.find(b => b.gate);
  ok('the gate is placed and matched to a bay', !!gateBay);
  const flankers = plan.posts.filter(p =>
    Math.abs(p.x-gateBay.sx) < 0.1 || Math.abs(p.x-(gateBay.sx+gateBay.bayLen)) < 0.1);
  ok('both posts flanking the gate bay are heavy', flankers.length===2 && flankers.every(p=>p.thick));
  eq('ornamental iron gets finials, aluminum does not', plan.finials, false);
}
{
  const ironPlan = M.scenePlanRun({ type:'ORNAMENTAL_IRON', finish:'Black', points:'0:0,100:0',
    gates:'', closed:false, heightFt:6, postSpacingFt:8, manualFeet:0 }, 20, 1);
  eq('ornamental iron gets finials', ironPlan.finials, true);
}
{
  // A closed loop must not double up a post at the seam where the last
  // segment's end is the first segment's start.
  const plan = M.scenePlanRun({ type:'VINYL', finish:'White', points:'0:0,100:0,100:100,0:100',
    gates:'', closed:true, heightFt:6, postSpacingFt:100, manualFeet:0 }, 20, 1);
  const keys = plan.posts.map(p => Math.round(p.x*20)+'_'+Math.round(p.z*20));
  eq('no duplicate posts at the closed loop\'s seam', new Set(keys).size, keys.length);
  eq('all four corners of a closed square are heavy posts', plan.posts.filter(p=>p.thick).length, 4);
}
{
  // The old fence always renders as weathered wood, no matter what type of
  // fence it actually was -- the drawing doesn't record that.
  const plan = M.scenePlanRun({ type:'CHAIN_LINK', finish:'Galvanized', points:'0:0,60:0',
    gates:'', closed:false, heightFt:4, postSpacingFt:10, teardown:true, manualFeet:0 }, 20, 1);
  eq('a teardown run is always the board layout', plan.geomKind, 'board');
  eq('a teardown run is always the weathered material', plan.materialKind, 'weathered');
  eq('a teardown run never gets a fresh cap board', plan.capBoard, false);
  ok('a teardown run has at least one leaning post or a sagging/skipped board',
    plan.posts.some(p=>p.lean!==0) || plan.bays.some(b=>(b.boards||[]).some(bd=>bd.sag!==0||bd.skip)));
}
{
  // Same seed in, same plan out -- the old fence must not reshuffle itself
  // on every render of the same job.
  const args = [{ type:'WOOD', woodStyle:'PRIVACY', finish:'', points:'0:0,200:0', gates:'',
    closed:false, heightFt:6, postSpacingFt:8, teardown:true, manualFeet:0 }, 20, 7];
  const a = M.scenePlanRun(...args), b = M.scenePlanRun(...args);
  eq('the same seed produces the exact same board skip/sag pattern', a.bays, b.bays);
  eq('the same seed produces the exact same post lean', a.posts, b.posts);
  eq('nextSeed is itself deterministic', a.nextSeed, b.nextSeed);
}
{
  // manualFeet overrides the drawing's own scale, same rule the pricing
  // engine and the app's own FenceGeometryEngine use.
  const plan = M.scenePlanRun({ type:'VINYL', finish:'', points:'0:0,1000:0', gates:'',
    closed:false, heightFt:6, postSpacingFt:8, manualFeet:80 }, 20, 1);
  near('the typed 80ft measurement wins over the 1000px drawing at 20px/ft (50ft)',
    Math.hypot(plan.worldPts[1].x-plan.worldPts[0].x, plan.worldPts[1].z-plan.worldPts[0].z), 80, 0.01);
}

/* ---------- scenePathLengths / scenePointAtDistance: the walk-it path ---------- */

{
  const pts=[{x:0,z:0},{x:100,z:0},{x:100,z:100}];
  const cum=M.scenePathLengths(pts);
  eq('cumulative distance at each vertex', cum, [0,100,200]);
  eq('a point halfway along the first leg', M.scenePointAtDistance(pts,cum,50), {x:50,z:0});
  eq('a point exactly at the second vertex', M.scenePointAtDistance(pts,cum,100), {x:100,z:0});
  eq('a point partway along the second leg', M.scenePointAtDistance(pts,cum,150), {x:100,z:50});
  eq('distance past the end wraps around to the start', M.scenePointAtDistance(pts,cum,250), {x:50,z:0});
}
eq('a single point never divides by zero', M.scenePointAtDistance([{x:5,z:5}], [0], 40), {x:5,z:5});
eq('no points at all is still safe', M.scenePointAtDistance([], [], 10), {x:0,z:0});

/* ---------- sceneFlatPlanSVG: the WebGL-unavailable fallback ---------- */

{
  const runs=[
    { type:'WOOD', finish:'', points:'0:0,100:0', closed:false, teardown:false },
    { type:'VINYL', finish:'White', points:'0:0,50:50,100:0', closed:true, teardown:false },
  ];
  const svg=M.sceneFlatPlanSVG(runs, 700, 400);
  ok('produces one <svg> root', svg.startsWith('<svg'));
  eq('one polyline per run', (svg.match(/<polyline/g)||[]).length, 2);
}
{
  const svg=M.sceneFlatPlanSVG([{ type:'WOOD', points:'', closed:false }], 700, 400);
  ok('a run with no usable points draws no polyline, not a crash', (svg.match(/<polyline/g)||[]) .length===0);
}
eq('no runs at all still returns a valid (empty) svg', M.sceneFlatPlanSVG([], 700, 400).startsWith('<svg'), true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
