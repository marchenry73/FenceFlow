/* Phase C's pure logic: the Settings build-templates panel's grouping and
   spec-summary helpers, the legacy build-default inputs' merge onto the
   company's default VINYL template, the starter-tiers preset and tier-form
   payload builder, the Business setup wizard's own step list, and the
   type-specific spec-fields HTML block shared by the wizard, the setup
   wizard and the Settings template dialog. No DOM, no network -- pulled
   straight out of dashboard.html and run standalone, same idiom as
   tests/wizard-encoding.test.mjs. */
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
  'tplGroups', 'tplSpecSummary', 'setupWizardSteps', 'vinylDefaultTemplatePayload',
  'starterTierRows', 'tierFormPayload', 'fenceTypeBlockHtml',
].map(grab).join('\n\n');
const M = new Function(code + `
  return { tplGroups, tplSpecSummary, setupWizardSteps, vinylDefaultTemplatePayload,
           starterTierRows, tierFormPayload, fenceTypeBlockHtml };
`)();

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log('FAIL  ' + label + '\n      got  ' + JSON.stringify(got)
    + '\n      want ' + JSON.stringify(want)); }
};
const ok = (label, cond) => { if (cond) pass++; else { fail++; console.log('FAIL  ' + label); } };

/* ---------- tplGroups: the Settings panel's Your/FenceFlow split ---------- */

{
  const templates = [
    { sync_id:'a', name:'Shipped A', is_shipped:true,  is_default:false },
    { sync_id:'b', name:'Mine, default', is_shipped:false, is_default:true },
    { sync_id:'c', name:'Mine, not default', is_shipped:false, is_default:false },
    { sync_id:'d', name:'Shipped B', is_shipped:true,  is_default:false },
  ];
  const g = M.tplGroups(templates);
  eq('mine holds every non-shipped row, default or not', g.mine.map(t=>t.sync_id).sort(), ['b','c']);
  eq('shipped holds every shipped row', g.shipped.map(t=>t.sync_id).sort(), ['a','d']);
}
{
  // Unlike the wizard's own picker (wizTemplateGroups), an empty "mine" group
  // is still returned as an empty array -- never hidden -- so the panel can
  // show its own "you have none yet" text instead of a vanished heading.
  const g = M.tplGroups([]);
  eq('an empty template list still produces both (empty) groups', g, { mine:[], shipped:[] });
}
ok('a missing template list does not throw', Array.isArray(M.tplGroups(undefined).mine));

/* ---------- tplSpecSummary: one line per row in the templates table ---------- */

eq('the full shape', M.tplSpecSummary({
    panel_height_ft:6, panel_width_ft:8, post_spacing_ft:8, concrete_bags_per_post:1, color_or_finish:'White',
  }), '6 ft tall · 8 ft panels · posts every 8 ft · 1 bag · White');
eq('bags pluralise past one', M.tplSpecSummary({
    panel_height_ft:6, panel_width_ft:6, post_spacing_ft:6, concrete_bags_per_post:2, color_or_finish:'',
  }), '6 ft tall · 6 ft panels · posts every 6 ft · 2 bags');
eq('zero bags and no colour are both left out, not printed as "0 bags" or an empty tail', M.tplSpecSummary({
    panel_height_ft:4, panel_width_ft:8, post_spacing_ft:10, concrete_bags_per_post:0, color_or_finish:'',
  }), '4 ft tall · 8 ft panels · posts every 10 ft');

/* ---------- setupWizardSteps: Crew skipped on Solo, Done always last ---------- */

eq('crew plan sees every step', M.setupWizardSteps('crew'),
  ['business','rates','build','supplier','tiers','crew','done']);
eq('pro plan sees every step', M.setupWizardSteps('pro'),
  ['business','rates','build','supplier','tiers','crew','done']);
eq('solo skips crew -- the owner IS the crew there', M.setupWizardSteps('solo'),
  ['business','rates','build','supplier','tiers','done']);
eq('an unrecognised/blank plan is treated as NOT solo (hand-granted companies keep everything)',
  M.setupWizardSteps(''), ['business','rates','build','supplier','tiers','crew','done']);

/* ---------- vinylDefaultTemplatePayload: the legacy Settings inputs' new job ---------- */

const shippedVinyl = {
  sync_id:'00000000-0000-4000-8000-000000000001', name:'Vinyl privacy 6 ft',
  description:'6 ft white privacy panels on 6 ft centres',
  fence_type:'VINYL', color_or_finish:'White', panel_width_ft:6, panel_height_ft:6, post_spacing_ft:6,
  concrete_bags_per_post:1, aluminum_style:'RACKABLE', wood_style:'PRIVACY', wood_rail_count:3,
  picket_width_in:5.5, picket_gap_in:0, fabric_height_ft:4, include_top_rail:true,
  include_tension_wire:false, include_barbed_wire_arms:false, include_privacy_slats:false,
  split_rail_count:2, gate_width_ft:4, gate_mounting:'LINE',
};

eq('all four boxes blank: nothing to write',
  M.vinylDefaultTemplatePayload(null, shippedVinyl, { spacing:'', pw:'', ph:'', bags:'' }), null);
eq('whitespace-only counts as blank too',
  M.vinylDefaultTemplatePayload(null, shippedVinyl, { spacing:' ', pw:'', ph:undefined, bags:null }), null);

{
  // No company default yet: starts from the shipped row, derived_from_sync_id
  // points at it, and no sync_id is sent so save_build_template mints one.
  const p = M.vinylDefaultTemplatePayload(null, shippedVinyl, { spacing:'', pw:'8', ph:'', bags:'' });
  ok('a brand-new row carries no sync_id (server mints one)', p.sync_id === undefined);
  eq('derived_from_sync_id points at the shipped row', p.derived_from_sync_id, shippedVinyl.sync_id);
  eq('is_default is always true -- this IS the default VINYL template', p.is_default, true);
  eq('typed panel width wins', p.panel_width_ft, 8);
  eq('post spacing is forced to match panel width (VINYL locks it)', p.post_spacing_ft, 8);
  eq('untouched fields fall back to the shipped row', [p.panel_height_ft, p.concrete_bags_per_post, p.color_or_finish],
    [shippedVinyl.panel_height_ft, shippedVinyl.concrete_bags_per_post, shippedVinyl.color_or_finish]);
  eq('name and description are carried over from the shipped row', [p.name, p.description],
    [shippedVinyl.name, shippedVinyl.description]);
}
{
  // A company already has its own default VINYL template: edit that row in
  // place (its own sync_id survives) rather than starting over from shipped.
  const existing = Object.assign({}, shippedVinyl, {
    sync_id:'11111111-1111-4111-8111-111111111111', name:'Our vinyl', description:'',
    color_or_finish:'Tan', panel_width_ft:8, panel_height_ft:6, post_spacing_ft:8, concrete_bags_per_post:2,
    derived_from_sync_id: shippedVinyl.sync_id,
  });
  const p = M.vinylDefaultTemplatePayload(existing, shippedVinyl, { spacing:'', pw:'', ph:'', bags:'3' });
  eq('the existing row\'s own sync_id is kept (an update, not a new row)', p.sync_id, existing.sync_id);
  eq('derived_from_sync_id carries over from the existing row', p.derived_from_sync_id, shippedVinyl.sync_id);
  eq('only the typed field (bags) changes', p.concrete_bags_per_post, 3);
  eq('untouched fields keep the EXISTING row\'s values, not the shipped fallback\'s',
    [p.panel_width_ft, p.color_or_finish], [8, 'Tan']);
  eq('post spacing still tracks panel width', p.post_spacing_ft, p.panel_width_ft);
}
eq('fence_type is always forced to VINYL regardless of what existing/fallback carry',
  M.vinylDefaultTemplatePayload(null, shippedVinyl, { spacing:'6', pw:'', ph:'', bags:'' }).fence_type, 'VINYL');

/* ---------- starterTierRows: the "Add starter tiers" preset ---------- */

{
  const rows = M.starterTierRows(10, 20);
  eq('five tiers, in the Good/Better/Best convention', rows.map(r=>r.name),
    ['Repair / small job','Good','Better','Best','Commercial / bid']);
  eq('Good matches the company\'s own current rate/markup exactly', [rows[1].labor_rate_per_ft, rows[1].markup_percent], [10, 20]);
  eq('Better and Best step up from there, never down', rows[2].markup_percent > rows[1].markup_percent
    && rows[3].markup_percent > rows[2].markup_percent, true);
  eq('sort_order is 0..4 in the order shown', rows.map(r=>r.sort_order), [0,1,2,3,4]);
  eq('nobody gets a starter discount except the commercial/bid row', rows.filter(r=>r.discount_percent>0).map(r=>r.name), ['Commercial / bid']);
}
eq('no rate/markup set yet (new company): every number is 0, not NaN',
  M.starterTierRows(undefined, undefined).every(r => Number.isFinite(r.labor_rate_per_ft) && Number.isFinite(r.markup_percent)), true);

/* ---------- tierFormPayload: existing keeps its identity, new gets the fresh one ---------- */

{
  const form = { name:'Good', labor_rate_per_ft:9, labor_flat_fee:0, markup_percent:15, discount_percent:0, sort_order:1 };
  const created = M.tierFormPayload(null, form, 'fresh-id');
  eq('a brand-new tier takes the caller\'s fresh sync_id', created.sync_id, 'fresh-id');
  ok('never carries updated_at -- the touch trigger stamps it', !('updated_at' in created));

  const edited = M.tierFormPayload({ sync_id:'existing-id', name:'Old name' }, form, 'fresh-id');
  eq('editing keeps the EXISTING row\'s sync_id, ignoring the fresh one', edited.sync_id, 'existing-id');
  eq('every field comes from the form, not the old row', edited.name, 'Good');
}

/* ---------- fenceTypeBlockHtml: the shared type-specific fields, namespaced by prefix ---------- */

{
  const html = M.fenceTypeBlockHtml({ fence_type:'WOOD', wood_style:'SPACED_PICKET', wood_rail_count:2,
    picket_width_in:3.5, picket_gap_in:2.5 }, 'tpl');
  ok('ids carry the given prefix', html.includes('id="tpl_wood_style"') && html.includes('id="tpl_wood_rails"'));
  ok('the wizard\'s own prefix is never hardcoded in', !html.includes('id="wz_'));
  ok('the selected style is marked selected', /value="SPACED_PICKET"\s+selected/.test(html));
}
{
  const html = M.fenceTypeBlockHtml({ fence_type:'CHAIN_LINK', include_top_rail:true, include_tension_wire:false,
    include_barbed_wire_arms:false, include_privacy_slats:true }, 'sw');
  ok('checked checkboxes reflect true flags', /id="sw_top_rail"[^>]*checked/.test(html)
    && /id="sw_slats"[^>]*checked/.test(html));
  ok('false flags are not checked', !/id="sw_tension_wire"[^>]*checked/.test(html));
}
eq('a fence type with no type-specific block (VINYL) returns empty',
  M.fenceTypeBlockHtml({ fence_type:'VINYL' }, 'tpl'), '');
eq('a missing spec object does not throw, and returns empty (no fence_type matches)',
  M.fenceTypeBlockHtml(null, 'tpl'), '');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
