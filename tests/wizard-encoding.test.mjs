/* The New client wizard's pure logic: the gate/point encoders that must
   match FenceCodec byte-for-byte (app/src/main/java/com/fenceestimator/app/
   geometry/FenceGeometry.kt), the auto-placement rule for a gate with no
   drawn position, the template-to-overrides mapper create_run_from_template
   is called with, and the picker's grouping of my_build_templates() rows.
   No DOM, no network -- pulled straight out of dashboard.html and run
   standalone, same idiom as tests/satellite-measure.test.mjs. */
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

const code = [
  'encodePointsList', 'encodeGateMarkers', 'autoPlaceGateMarkers',
  'buildRunOverrides', 'wizTemplateGroups', 'wizLockedSpacing',
].map(grab).join('\n\n');
const M = new Function(code + `
  return { encodePointsList, encodeGateMarkers, autoPlaceGateMarkers,
           buildRunOverrides, wizTemplateGroups, wizLockedSpacing };
`)();

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log('FAIL  ' + label + '\n      got  ' + JSON.stringify(got)
    + '\n      want ' + JSON.stringify(want)); }
};

/* ---------- encodePointsList: FenceCodec.encodePoints, "x:y,x:y,..." ---------- */

eq('two points', M.encodePointsList([{x:0,y:0},{x:100,y:0}]), '0:0,100:0');
eq('rounds to thousandths', M.encodePointsList([{x:1.23456,y:-0.00001}]), '1.235:0');
eq('empty list', M.encodePointsList([]), '');
eq('null-safe', M.encodePointsList(null), '');

/* ---------- encodeGateMarkers: FenceCodec.encodeGates, the 5-part form ---------- */

eq('one gate', M.encodeGateMarkers([{x:50,y:0,widthFt:4,mounting:'LINE',swing:'IN'}]),
  '50:0:4:LINE:IN');
eq('two gates, comma-joined', M.encodeGateMarkers([
    {x:10,y:20,widthFt:4,mounting:'LINE',swing:'IN'},
    {x:30,y:40,widthFt:8,mounting:'WALL',swing:'OUT'},
  ]), '10:20:4:LINE:IN,30:40:8:WALL:OUT');
eq('LINE_TO_WALL survives intact', M.encodeGateMarkers([{x:0,y:0,widthFt:6,mounting:'LINE_TO_WALL',swing:'IN'}]),
  '0:0:6:LINE_TO_WALL:IN');
eq('missing mounting/swing default to LINE/IN, matching FenceCodec.decodeGates',
  M.encodeGateMarkers([{x:0,y:0,widthFt:4}]), '0:0:4:LINE:IN');
eq('empty gate list encodes empty', M.encodeGateMarkers([]), '');

/* ---------- autoPlaceGateMarkers: segment midpoints (open question 2's default) ---------- */

{
  // A single 100 ft open run, one gate: the midpoint of its only segment.
  const points = [{x:0,y:0},{x:100,y:0}];
  const placed = M.autoPlaceGateMarkers(points, false, [{widthFt:4,mounting:'LINE',swing:'IN'}]);
  eq('one gate on an open run sits at the midpoint', placed, [{x:50,y:0,widthFt:4,mounting:'LINE',swing:'IN'}]);
}
{
  // Three points (two segments), two gates: one per segment, in order.
  const points = [{x:0,y:0},{x:100,y:0},{x:100,y:100}];
  const placed = M.autoPlaceGateMarkers(points, false, [
    {widthFt:4,mounting:'LINE',swing:'IN'}, {widthFt:6,mounting:'WALL',swing:'OUT'},
  ]);
  eq('successive gates land on successive segments', placed, [
    {x:50,y:0,widthFt:4,mounting:'LINE',swing:'IN'},
    {x:100,y:50,widthFt:6,mounting:'WALL',swing:'OUT'},
  ]);
}
{
  // A closed loop's last segment wraps back to point 0.
  const points = [{x:0,y:0},{x:100,y:0},{x:100,y:100}]; // closed => 3 segments, not 2
  const placed = M.autoPlaceGateMarkers(points, true, [
    {widthFt:4,mounting:'LINE',swing:'IN'}, {widthFt:4,mounting:'LINE',swing:'IN'}, {widthFt:4,mounting:'LINE',swing:'IN'},
  ]);
  eq('closed loop wraps the last segment back to point 0', placed[2], {x:50,y:50,widthFt:4,mounting:'LINE',swing:'IN'});
}
{
  // More gates than segments: extras double up on the last segment rather than throwing.
  const points = [{x:0,y:0},{x:100,y:0}]; // one segment, open
  const placed = M.autoPlaceGateMarkers(points, false, [
    {widthFt:4,mounting:'LINE',swing:'IN'}, {widthFt:4,mounting:'LINE',swing:'IN'}, {widthFt:4,mounting:'LINE',swing:'IN'},
  ]);
  eq('extra gates clamp to the last segment', placed.map(g=>[g.x,g.y]), [[50,0],[50,0],[50,0]]);
}
{
  // Typed footage: no points at all. Gates are position-less (0,0), never dropped.
  const placed = M.autoPlaceGateMarkers(null, false, [{widthFt:4,mounting:'LINE',swing:'IN'}]);
  eq('no points => position-less gate, not a dropped one', placed, [{x:0,y:0,widthFt:4,mounting:'LINE',swing:'IN'}]);
}
{
  // A single point (no segment at all yet) behaves the same as no points.
  const placed = M.autoPlaceGateMarkers([{x:5,y:5}], false, [{widthFt:4,mounting:'LINE',swing:'IN'}]);
  eq('a single point has no segment either', placed, [{x:0,y:0,widthFt:4,mounting:'LINE',swing:'IN'}]);
}
eq('no gates at all is fine', M.autoPlaceGateMarkers([{x:0,y:0},{x:10,y:0}], false, []), []);

/* ---- worked example: a 40 ft open run, one gate, end to end ---- */
{
  const points = [{x:0,y:0},{x:800,y:0}]; // 40 ft at 20 px/ft
  const gate = M.autoPlaceGateMarkers(points, false, [{widthFt:4,mounting:'LINE',swing:'IN'}]);
  eq('worked example encodes to "400:0:4:LINE:IN"', M.encodeGateMarkers(gate), '400:0:4:LINE:IN');
}

/* ---------- wizLockedSpacing: the panel types where spacing follows width ---------- */

eq('VINYL locks spacing', M.wizLockedSpacing('VINYL'), true);
eq('ALUMINUM locks spacing', M.wizLockedSpacing('ALUMINUM'), true);
eq('ORNAMENTAL_IRON locks spacing', M.wizLockedSpacing('ORNAMENTAL_IRON'), true);
eq('WOOD does not lock spacing', M.wizLockedSpacing('WOOD'), false);
eq('CHAIN_LINK does not lock spacing', M.wizLockedSpacing('CHAIN_LINK'), false);

/* ---------- buildRunOverrides: the template-to-overrides mapper ---------- */

{
  const spec = { fence_type:'WOOD', color_or_finish:'', panel_width_ft:8, panel_height_ft:6,
    post_spacing_ft:8, concrete_bags_per_post:1, wood_style:'PRIVACY', wood_rail_count:3,
    picket_width_in:5.5, picket_gap_in:0, gate_width_ft:4, gate_mounting:'LINE' };
  const overrides = M.buildRunOverrides(spec, { label:'Back yard', points_encoded:'0:0,100:0',
    gates_encoded:'', closed_loop:false, manual_linear_feet:null, manual_corner_count:0 });
  eq('spec columns pass through', overrides.wood_style, 'PRIVACY');
  eq('spec columns not in RUN_SPEC_FIELDS (gate defaults) are left out -- '
    + 'they are template-picker fields, not fence_runs columns',
    'gate_width_ft' in overrides, false);
  eq('extra (this run\'s own fields) is merged in', overrides.label, 'Back yard');
  eq('extra wins over spec for any key they share', overrides.closed_loop, false);
}
{
  // The panel-locks-spacing rule applies even if the spec object disagrees --
  // the same rule create_run_from_template itself enforces, re-applied here
  // so the wizard's own preview never shows a mismatch before the RPC runs.
  const spec = { fence_type:'VINYL', panel_width_ft:8, post_spacing_ft:6 };
  const overrides = M.buildRunOverrides(spec, {});
  eq('VINYL: spacing is forced to match panel width', overrides.post_spacing_ft, 8);
}
{
  const spec = { fence_type:'WOOD', panel_width_ft:8, post_spacing_ft:6 };
  const overrides = M.buildRunOverrides(spec, {});
  eq('WOOD: spacing is left alone', overrides.post_spacing_ft, 6);
}
eq('undefined and null spec fields are omitted, not written as null '
  + '(coalesce() on the template column must see them absent, not present-and-null)',
  M.buildRunOverrides({ fence_type:'WOOD', wood_style: undefined, picket_gap_in: null }, {}),
  { fence_type:'WOOD' });
eq('a missing spec object still returns the extra fields',
  M.buildRunOverrides(null, { label:'x' }), { label:'x' });

/* ---------- wizTemplateGroups: Recent / Company default / Your templates / FenceFlow ---------- */

{
  const templates = [
    { sync_id:'a', name:'Shipped A', is_shipped:true,  is_default:false, my_last_used_at:null },
    { sync_id:'b', name:'Company default', is_shipped:false, is_default:true, my_last_used_at:'2026-09-01T00:00:00Z' },
    { sync_id:'c', name:'Mine 1', is_shipped:false, is_default:false, my_last_used_at:'2026-09-04T00:00:00Z' },
    { sync_id:'d', name:'Mine 2', is_shipped:false, is_default:false, my_last_used_at:'2026-09-03T00:00:00Z' },
    { sync_id:'e', name:'Mine 3, never used', is_shipped:false, is_default:false, my_last_used_at:null },
    { sync_id:'f', name:'Mine 4', is_shipped:false, is_default:false, my_last_used_at:'2026-09-02T00:00:00Z' },
  ];
  const groups = M.wizTemplateGroups(templates);
  const byLabel = Object.fromEntries(groups);
  eq('groups appear in Recent, Company default, Your templates, FenceFlow order',
    groups.map(([label])=>label), ['Recent','Company default','Your templates','FenceFlow templates']);
  eq('Recent is capped at 3, most recently used first',
    byLabel['Recent'].map(t=>t.sync_id), ['c','d','f']);
  eq('Company default holds every is_default row', byLabel['Company default'].map(t=>t.sync_id), ['b']);
  eq('Your templates excludes both the default and the shipped rows',
    byLabel['Your templates'].map(t=>t.sync_id).sort(), ['c','d','e','f']);
  eq('FenceFlow templates is exactly the shipped rows', byLabel['FenceFlow templates'].map(t=>t.sync_id), ['a']);
}
eq('an empty template list produces no groups at all (not four empty ones)',
  M.wizTemplateGroups([]), []);
{
  // A recently-used company default shows up under both headings -- a
  // feature of a picker (find it either way), not a partition bug.
  const t = { sync_id:'z', name:'Z', is_shipped:false, is_default:true, my_last_used_at:'2026-09-05T00:00:00Z' };
  const groups = M.wizTemplateGroups([t]);
  const inRecent = groups.find(([l])=>l==='Recent')[1][0].sync_id;
  const inDefault = groups.find(([l])=>l==='Company default')[1][0].sync_id;
  eq('a template used recently and marked default appears in both groups', [inRecent, inDefault], ['z','z']);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
