/* Pure helpers behind three of the five office-page asks: the materials
   catalog editor (organized per fence type, "Start from FenceFlow's
   catalog", what the estimate will flag as missing), the fence run viewer
   in the job drawer, and the satellite tool's gate-placement and precision
   aids. No DOM, no network -- pulled straight out of dashboard.html and run
   standalone, same grab()/new Function() idiom as
   tests/satellite-measure.test.mjs and tests/wizard-encoding.test.mjs. */
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

/* Same idea as grab(), but for a top-level `const NAME = [...]` or
   `const NAME = {...}` -- balanced on whichever bracket opens the value,
   since CATALOG_SEED (an array of plain objects) needs both. */
const grabConst = (name) => {
  const marker = 'const ' + name + ' = ';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('not found: ' + name);
  const i = start + marker.length;
  const open = src[i];
  const close = { '[': ']', '{': '}' }[open];
  if (!close) throw new Error('unexpected const shape: ' + name);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === open) depth++;
    else if (src[j] === close) { depth--; if (!depth) return src.slice(start, j + 1) + ';'; }
  }
  throw new Error('unbalanced const: ' + name);
};

const code = [
  grabConst('CATALOG_FENCE_TYPES'),
  grabConst('MATERIAL_CATEGORIES'),
  grabConst('CATALOG_SEED'),
  ...[
    'wizFenceTypeLabel', 'catFenceTypeLabel',
    'catalogSeedCounts', 'catalogExpectedRoles', 'catalogMissingRoles',
    'catalogGroupByType', 'catalogFilterItems', 'catalogSeedRowsToAdd', 'catalogItemPayload',
    'decodeRunPoints', 'decodeRunGates', 'classifyRunVertices',
    'runLengthFt', 'runBoundsFit', 'runScaleBarFeet', 'runFootageLabel',
    'satWorld', 'satFeetPerPx',
    'nearestPointOnSegment', 'nearestPointOnPolyline', 'snapPointToPrev', 'satGatesToRunSpace',
    'swSupplierFenceTypes',
  ].map(grab),
].join('\n\n');

const M = new Function(code + `
  return { CATALOG_FENCE_TYPES, MATERIAL_CATEGORIES, CATALOG_SEED,
    wizFenceTypeLabel, catFenceTypeLabel,
    catalogSeedCounts, catalogExpectedRoles, catalogMissingRoles,
    catalogGroupByType, catalogFilterItems, catalogSeedRowsToAdd, catalogItemPayload,
    decodeRunPoints, decodeRunGates, classifyRunVertices,
    runLengthFt, runBoundsFit, runScaleBarFeet, runFootageLabel,
    satWorld, satFeetPerPx,
    nearestPointOnSegment, nearestPointOnPolyline, snapPointToPrev, satGatesToRunSpace,
    swSupplierFenceTypes };
`)();

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log('FAIL  ' + label + '\n      got  ' + JSON.stringify(got)
    + '\n      want ' + JSON.stringify(want)); }
};
const ok = (label, cond) => { if (cond) pass++; else { fail++; console.log('FAIL  ' + label); } };
const near = (label, got, want, tol) => {
  if (Math.abs(got - want) <= (tol == null ? 0.5 : tol)) pass++;
  else { fail++; console.log('FAIL  ' + label + '  got ' + got + '  want ' + want); }
};

/* =====================================================================
   CATALOG_SEED against SeedData.kt itself -- not against a number typed
   into this test, but a live re-parse of the Kotlin file, the same
   balanced item(...) counting the array was generated with. If someone
   edits SeedData.kt and forgets to update CATALOG_SEED, this fails. */
{
  const kt = readFileSync(
    'app/src/main/java/com/fenceestimator/app/data/SeedData.kt', 'utf8');
  const grabKtFn = (name) => {
    const exprMarker = `private fun ${name}(): List<MaterialItem> = listOf(`;
    const exprStart = kt.indexOf(exprMarker);
    if (exprStart >= 0) {
      let depth = 0;
      for (let j = exprStart + exprMarker.length - 1; j < kt.length; j++) {
        if (kt[j] === '(') depth++;
        else if (kt[j] === ')') { depth--; if (!depth) return kt.slice(exprStart, j + 1); }
      }
      throw new Error('unbalanced (expr): ' + name);
    }
    const marker = `private fun ${name}(): List<MaterialItem> {`;
    const start = kt.indexOf(marker);
    if (start < 0) throw new Error('not found in SeedData.kt: ' + name);
    let depth = 0;
    for (let j = start + marker.length - 1; j < kt.length; j++) {
      if (kt[j] === '{') depth++;
      else if (kt[j] === '}') { depth--; if (!depth) return kt.slice(start, j + 1); }
    }
    throw new Error('unbalanced: ' + name);
  };
  const countItemCalls = (body) => (body.match(/\bitem\(/g) || []).length;
  // Same key order CATALOG_SEED's own array produces (VINYL through
  // UNIVERSAL) -- eq() compares via JSON.stringify, which is order-
  // sensitive on object keys, and this is a count comparison, not a proof
  // that either side orders its keys the same way for its own reasons.
  const kotlinCounts = {
    VINYL: countItemCalls(grabKtFn('vinylItems')),
    WOOD: countItemCalls(grabKtFn('woodItems')),
    CHAIN_LINK: countItemCalls(grabKtFn('chainLinkItems')),
    ALUMINUM: countItemCalls(grabKtFn('aluminumItems')),
    ORNAMENTAL_IRON: countItemCalls(grabKtFn('ornamentalIronItems')),
    SPLIT_RAIL: countItemCalls(grabKtFn('splitRailItems')),
    COMPOSITE: countItemCalls(grabKtFn('compositeItems')),
    UNIVERSAL: countItemCalls(grabKtFn('universalItems')),
  };
  eq('CATALOG_SEED\'s per-type counts match a live re-parse of SeedData.kt\'s '
    + 'own item(...) calls', M.catalogSeedCounts(), kotlinCounts);
  eq('92 seed items total (19+10+18+14+11+8+10+2)',
    M.CATALOG_SEED.length, Object.values(kotlinCounts).reduce((a,b)=>a+b,0));
  ok('every seed row carries a source_doc flagging REAL vs PLACEHOLDER pricing',
    M.CATALOG_SEED.every(r => r.source_doc && r.source_doc.length>0));
}

/* ---------- catFenceTypeLabel ---------- */

eq('UNIVERSAL gets its own label, not a raw enum string', M.catFenceTypeLabel('UNIVERSAL'), 'Universal');
eq('everything else defers to wizFenceTypeLabel', M.catFenceTypeLabel('CHAIN_LINK'), 'Chain link');

/* ---------- catalogExpectedRoles / catalogMissingRoles ---------- */

eq('UNIVERSAL\'s own expected roles are exactly its two seed roles',
  M.catalogExpectedRoles('UNIVERSAL'), ['CONCRETE_BAG','HOLE_PLUG']);
{
  const splitRail = M.catalogExpectedRoles('SPLIT_RAIL');
  ok('a real fence type\'s expected roles include its own seed roles (LINE_POST)', splitRail.includes('LINE_POST'));
  ok('...and the UNIVERSAL roles too (CONCRETE_BAG), matching the catalog '
    + 'lookup\'s own fenceType==type||UNIVERSAL rule', splitRail.includes('CONCRETE_BAG'));
  ok('...and HOLE_PLUG, the other UNIVERSAL role', splitRail.includes('HOLE_PLUG'));
}
{
  // A company with nothing but a universal concrete row should see every
  // section still missing its OWN roles (there is no vinyl panel here).
  const items = [{ fence_type:'UNIVERSAL', role:'CONCRETE_BAG', is_active:true }];
  const missing = M.catalogMissingRoles(items, 'VINYL');
  ok('CONCRETE_BAG is satisfied by a universal row', !missing.includes('CONCRETE_BAG'));
  ok('but VINYL-specific roles are still reported missing', missing.includes('LINE_POST'));
}
{
  // Deleting/deactivating the universal concrete row should make EVERY
  // section flag it, not just a UNIVERSAL section nobody is looking at.
  const missing = M.catalogMissingRoles([], 'WOOD');
  ok('with no catalog at all, CONCRETE_BAG is missing for WOOD too', missing.includes('CONCRETE_BAG'));
}
{
  // An inactive item does not count as "have this role" -- the estimate
  // will not actually use it.
  const items = [{ fence_type:'UNIVERSAL', role:'CONCRETE_BAG', is_active:false }];
  ok('an inactive item does not clear its role from the missing list',
    M.catalogMissingRoles(items, 'UNIVERSAL').includes('CONCRETE_BAG'));
}

/* ---------- catalogGroupByType ---------- */

{
  const items = [
    { sync_id:'1', fence_type:'VINYL', category:'PANEL', role:'PANEL', is_active:true },
    { sync_id:'2', fence_type:'VINYL', category:'POST', role:'LINE_POST', is_active:true },
    { sync_id:'3', fence_type:'WOOD', category:'PICKET', role:'WOOD_PICKET', is_active:true },
  ];
  const groups = M.catalogGroupByType(items);
  eq('one group per CATALOG_FENCE_TYPES member, in that order',
    groups.map(g=>g.type), M.CATALOG_FENCE_TYPES);
  const vinyl = groups.find(g=>g.type==='VINYL');
  eq('VINYL group holds only its own two rows', vinyl.items.map(i=>i.sync_id).sort(), ['1','2']);
  eq('grouped again by category', Object.keys(vinyl.byCategory).sort(), ['PANEL','POST']);
  const universal = groups.find(g=>g.type==='UNIVERSAL');
  eq('a fence type with nothing in the catalog yet is still an (empty) group', universal.items, []);
  ok('UNIVERSAL group\'s own missing list flags both its seed roles with nothing catalogued',
    universal.missing.includes('CONCRETE_BAG') && universal.missing.includes('HOLE_PLUG'));
}

/* ---------- catalogFilterItems ---------- */

{
  const items = [
    { name:'Panel T&G Vinyl Privacy', fence_type:'VINYL', category:'PANEL', role:'PANEL' },
    { name:'Concrete Mix 60lb Bag', fence_type:'UNIVERSAL', category:'CONCRETE', role:'CONCRETE_BAG' },
  ];
  eq('empty filter returns everything', M.catalogFilterItems(items, ''), items);
  eq('matches by name, case-insensitively',
    M.catalogFilterItems(items, 'vinyl').map(i=>i.name), ['Panel T&G Vinyl Privacy']);
  eq('matches by category', M.catalogFilterItems(items, 'concrete').map(i=>i.role), ['CONCRETE_BAG']);
  eq('matches by role', M.catalogFilterItems(items, 'panel').length, 1);
  eq('matches by fence type', M.catalogFilterItems(items, 'universal').length, 1);
  eq('no match returns nothing', M.catalogFilterItems(items, 'aluminum'), []);
}

/* ---------- catalogSeedRowsToAdd ---------- */

{
  const seed = [
    { fence_type:'WOOD', role:'WOOD_PICKET', name:'6\' Dog-Ear Wood Picket, Pressure-Treated Pine' },
    { fence_type:'WOOD', role:'WOOD_RAIL', name:'2x4x8\' Pressure-Treated Rail' },
  ];
  eq('nothing existing => every seed row is offered',
    M.catalogSeedRowsToAdd([], seed).length, 2);
  eq('an exact (fence_type, role, name) match is excluded', M.catalogSeedRowsToAdd(
    [{ fence_type:'WOOD', role:'WOOD_PICKET', name:'6\' Dog-Ear Wood Picket, Pressure-Treated Pine' }],
    seed
  ).map(r=>r.role), ['WOOD_RAIL']);
  eq('the name match is case-insensitive', M.catalogSeedRowsToAdd(
    [{ fence_type:'WOOD', role:'WOOD_PICKET', name:'6\' DOG-EAR WOOD PICKET, PRESSURE-TREATED PINE' }],
    seed
  ).map(r=>r.role), ['WOOD_RAIL']);
  eq('a different role for the same name is still offered (not the same part)', M.catalogSeedRowsToAdd(
    [{ fence_type:'WOOD', role:'WOOD_RAIL', name:'6\' Dog-Ear Wood Picket, Pressure-Treated Pine' }],
    seed
  ).length, 2);
}

/* ---------- catalogItemPayload ---------- */

{
  const form = { name:'Test Post', fence_type:'WOOD', category:'POST', role:'LINE_POST',
    color_or_finish:'', unit:'EA', unit_price:9.5, covers_ft:null, taxable:true, is_active:true };
  const created = M.catalogItemPayload(null, form, 'new-id');
  eq('a new item takes the caller\'s fresh sync_id', created.sync_id, 'new-id');
  ok('never carries updated_at -- the touch trigger owns that clock',
    !('updated_at' in created));
  const edited = M.catalogItemPayload({ sync_id:'existing-id' }, form, 'new-id');
  eq('editing keeps the existing row\'s own sync_id', edited.sync_id, 'existing-id');
}

/* ---------- decodeRunPoints / decodeRunGates (FenceCodec, reproduced) ---------- */

eq('two points', M.decodeRunPoints('0:0,100:0'), [{x:0,y:0},{x:100,y:0}]);
eq('empty string decodes to nothing', M.decodeRunPoints(''), []);
eq('a malformed pair is dropped, not thrown on', M.decodeRunPoints('0:0,bad,100:50'), [{x:0,y:0},{x:100,y:50}]);

eq('3-part gate (no mounting/swing recorded) defaults to LINE/IN',
  M.decodeRunGates('50:0:4'), [{x:50,y:0,widthFt:4,mounting:'LINE',swing:'IN'}]);
eq('4-part gate (mounting recorded, swing not) defaults swing to IN',
  M.decodeRunGates('50:0:4:WALL'), [{x:50,y:0,widthFt:4,mounting:'WALL',swing:'IN'}]);
eq('full 5-part gate reads intact',
  M.decodeRunGates('10:20:6:LINE_TO_WALL:OUT'), [{x:10,y:20,widthFt:6,mounting:'LINE_TO_WALL',swing:'OUT'}]);
eq('an unrecognised mounting/swing value falls back rather than propagating garbage',
  M.decodeRunGates('0:0:4:SIDEWAYS:MAYBE'), [{x:0,y:0,widthFt:4,mounting:'LINE',swing:'IN'}]);
eq('two gates, comma-joined', M.decodeRunGates('0:0:4:LINE:IN,10:10:6:WALL:OUT').length, 2);

/* ---------- classifyRunVertices (FenceGeometryEngine.analyze) ---------- */

{
  // A 90-degree corner square, open (four points, three segments).
  const square = [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}];
  const v = M.classifyRunVertices(square, false);
  eq('open run: first and last vertex are END', [v[0].kind, v[3].kind], ['END','END']);
  eq('the two interior 90-degree turns are CORNER', [v[1].kind, v[2].kind], ['CORNER','CORNER']);
}
{
  // Same square, closed -- every vertex is now interior and a 90-degree corner.
  const square = [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}];
  const v = M.classifyRunVertices(square, true);
  ok('closed loop: every vertex classifies as CORNER', v.every(x=>x.kind==='CORNER'));
}
{
  // Three colinear points: the middle one is a LINE point, not a corner.
  const line = [{x:0,y:0},{x:50,y:0},{x:100,y:0}];
  eq('a straight run\'s middle point is LINE, not CORNER',
    M.classifyRunVertices(line, false)[1].kind, 'LINE');
}

/* ---------- runLengthFt ---------- */

near('a 200px segment at 20px/ft is 10 ft', M.runLengthFt([{x:0,y:0},{x:200,y:0}], false, 20), 10, 0.01);
eq('fewer than two points measures nothing', M.runLengthFt([{x:0,y:0}], false, 20), 0);
eq('no calibration measures nothing rather than dividing by zero', M.runLengthFt([{x:0,y:0},{x:100,y:0}], false, 0), 0);
{
  const closed = M.runLengthFt([{x:0,y:0},{x:100,y:0},{x:100,y:100}], true, 20);
  const open = M.runLengthFt([{x:0,y:0},{x:100,y:0},{x:100,y:100}], false, 20);
  ok('closing the loop adds the return leg\'s length', closed > open);
}

/* ---------- runBoundsFit ---------- */

{
  // A 100x50 box, no padding, fit into a 200x200 canvas: scale is capped by
  // the wider dimension (100 -> 200 is 2x; 50 -> 200 would be 4x).
  const fit = M.runBoundsFit([{x:0,y:0},{x:100,y:0},{x:100,y:50}], 200, 200, 0);
  near('scale picks the tighter-fitting axis', fit.scale, 2, 0.001);
}
eq('no points at all still returns a usable (centred, unscaled) fit',
  M.runBoundsFit([], 300, 200, 10).scale, 1);

/* ---------- runScaleBarFeet ---------- */

{
  // scale=1 canvas-px-per-survey-px, 20 px/ft => 20 canvas px per foot.
  // Target 70px => closest "nice" length is either 4 (missing) or the
  // nearest option; among [1,2,5,10,20,25,50,...], 5ft*20=100px (30 off),
  // 2ft*20=40px (30 off) -- pick whichever the function actually lands on
  // and just confirm it's one of the tidy options, not an arbitrary number.
  const bar = M.runScaleBarFeet(1, 20, 70);
  ok('picks one of the recognised "nice" survey lengths',
    [1,2,5,10,20,25,50,100,200,250,500,1000].includes(bar));
}

/* ---------- runFootageLabel ---------- */

eq('manual feet with no drawing reads as typed',
  M.runFootageLabel({manual_linear_feet:120}, [], 20), '120 ft (typed)');
eq('a drawn run reads as measured',
  M.runFootageLabel({manual_linear_feet:0}, [{x:0,y:0},{x:200,y:0}], 20), '10 ft measured');
eq('neither typed nor drawn says so honestly',
  M.runFootageLabel({manual_linear_feet:0}, [], 20), 'No geometry yet');

/* ---------- nearestPointOnSegment / nearestPointOnPolyline ---------- */

{
  const np = M.nearestPointOnSegment({x:50,y:10}, {x:0,y:0}, {x:100,y:0});
  eq('perpendicular projection lands on the segment', [np.x,np.y], [50,0]);
}
{
  const np = M.nearestPointOnSegment({x:-20,y:5}, {x:0,y:0}, {x:100,y:0});
  eq('projection is clamped to the segment\'s own start', [np.x,np.y], [0,0]);
}
{
  // Two segments (an L-shape); a click near the second leg should land
  // there, not on the first.
  const pts = [{x:0,y:0},{x:100,y:0},{x:100,y:100}];
  const near1 = M.nearestPointOnPolyline({x:100,y:60}, pts, false);
  eq('picks the segment actually closest to the click', near1.segIndex, 1);
  eq('and lands exactly on it', [near1.x, near1.y], [100,60]);
}
eq('fewer than two points has nothing to click on', M.nearestPointOnPolyline({x:0,y:0}, [{x:0,y:0}], false), null);
{
  // A closed triangle's third segment wraps from the last point back to
  // the first -- same segment numbering autoPlaceGateMarkers already uses.
  const tri = [{x:0,y:0},{x:100,y:0},{x:0,y:100}];
  const n = M.nearestPointOnPolyline({x:-10,y:50}, tri, true);
  eq('the wrap-around segment (2) is reachable when closed', n.segIndex, 2);
}

/* ---------- snapPointToPrev ---------- */

eq('within threshold on x snaps to the previous point\'s column',
  M.snapPointToPrev({x:103,y:80}, {x:100,y:0}, 6), {x:100,y:80});
eq('within threshold on y snaps to the previous point\'s row',
  M.snapPointToPrev({x:80,y:4}, {x:0,y:0}, 6), {x:80,y:0});
eq('outside the threshold on both axes, nothing snaps',
  M.snapPointToPrev({x:50,y:50}, {x:0,y:0}, 6), {x:50,y:50});
eq('no previous point, nothing to snap to',
  M.snapPointToPrev({x:5,y:5}, null, 6), {x:5,y:5});

/* ---------- satGatesToRunSpace ---------- */

{
  // Same worked example as satellite-measure.test.mjs #7: an 80 ft east-west
  // leg comes out to 1600 survey pixels at 20 px/ft. A gate sitting at the
  // SAME point as the second trace point should convert to the same x, with
  // its width/mounting/swing carried through untouched.
  const LAT=27.78, LON=-82.34, Z=20, FT_PER_M=3.280839895, M_PER_DEG=40075016.686/360;
  const side=80;
  const degLon = side / FT_PER_M / (M_PER_DEG * Math.cos(LAT*Math.PI/180));
  const origin = { lat:LAT, lon:LON };
  const gate = { lat:LAT, lon:LON+degLon, widthFt:4, mounting:'WALL', swing:'OUT' };
  const [converted] = M.satGatesToRunSpace([gate], origin, LAT, Z);
  near('gate x matches the same-position trace point (1600 survey px)', converted.x, side*20, 1);
  near('and does not drift off the line', Math.abs(converted.y), 0, 1);
  eq('width/mounting/swing pass through untouched',
    [converted.widthFt, converted.mounting, converted.swing], [4,'WALL','OUT']);
}
eq('no gates converts to nothing', M.satGatesToRunSpace([], {lat:0,lon:0}, 0, 20), []);
eq('no origin (no trace drawn yet) converts to nothing',
  M.satGatesToRunSpace([{lat:1,lon:1,widthFt:4,mounting:'LINE',swing:'IN'}], null, 0, 20), []);

/* ---------- swSupplierFenceTypes ---------- */

{
  const templates = [
    { fence_type:'VINYL', is_shipped:false },
    { fence_type:'WOOD', is_shipped:false },
    { fence_type:'VINYL', is_shipped:false }, // duplicate type, own template
    { fence_type:'ALUMINUM', is_shipped:true },
  ];
  eq('a company with its own templates is checked on those fence types, deduped',
    M.swSupplierFenceTypes(templates).sort(), ['VINYL','WOOD']);
}
{
  // A brand-new company has no templates of its own yet -- falls back to
  // whatever shipped templates it is currently choosing from.
  const templates = [{ fence_type:'VINYL', is_shipped:true }, { fence_type:'WOOD', is_shipped:true }];
  eq('no company templates yet => falls back to the shipped ones on offer',
    M.swSupplierFenceTypes(templates).sort(), ['VINYL','WOOD']);
}
eq('no templates at all => nothing to check', M.swSupplierFenceTypes([]), []);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
