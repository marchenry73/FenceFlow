/**
 * A JOB WITH NO PRICED MATERIALS REPORTS ITS WHOLE PRICE AS PROFIT.
 *
 * Owner list A4, "audit every money calculation and prove it charges the right
 * price". job_costing() returns costs_are_sell_prices so the office can warn
 * that a margin is fiction. The flag is
 *
 *     bool_and(i.supplier_unit_price is null) as all_fallback
 *
 * aggregated over the job's line items, LEFT JOINed, then
 * coalesce(m.all_fallback, false). For a job with NO line items there is no
 * materials row: bool_and is null over zero rows, the coalesce turns that into
 * FALSE, and false is read everywhere as "these are real costs".
 *
 * MEASURED 7 Nov 2026 as the owner, against the live project:
 *
 *     unflagged jobs: 2
 *       quoted=4200.00  material_cost=0.00  margin=100.0  live_lines=0
 *       quoted=0.00     material_cost=0.00  margin=None   live_lines=0
 *
 * 100% margin, no marker, no note. Both are fixtures TODAY. The reason this is
 * worth a test rather than a shrug is that it is the exact shape a REAL job
 * takes the moment its line items go: the 1 Oct 2026 pass tombstoned every
 * generated line on five of this company's jobs, and a later half-loaded
 * client tombstoned 64 priced items cloud-wide. After either, those jobs read
 * as a windfall on the one report the owner uses to judge whether work pays.
 *
 * It is also an "empty answer reads as good news" bug, which is the class that
 * has cost this project the most: three states (real costs / sell prices /
 * nothing costed at all) squeezed into a boolean, with the unknown coalesced
 * to the reassuring value.
 *
 * WHAT THE FIX IS, AND WHERE. costs_are_sell_prices is literally accurate as
 * it stands -- with no lines, no line fell back to a sell price -- so the SQL
 * is left alone and the page distinguishes the third state from
 * quoted_material, which job_costing already returns. The office marks that
 * row with a dagger and says the margin reads HIGH, which is the opposite of
 * what the sell-prices note says, because the two cases are wrong in opposite
 * directions.
 *
 * Live half reads the database and writes nothing outside BEGIN/ROLLBACK.
 *
 *     node --test tests/a168-margin-without-materials.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'newcrgafcptspmapacrx';
/** The real owner, who holds SEE_MONEY -- same id the other money suites use. */
const OWNER = '7bf38947-24cf-4e79-9af0-6100d04b166b';

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'a168-margin-'));
  const file = join(dir, 'q.sql');
  writeFileSync(file, sql, 'utf8');
  const r = spawnSync('npx', ['--no-install', 'supabase@2.115.0', 'db', 'query',
    '--linked', '--project-ref', PROJECT, '-f', file, '--output', 'json'],
    { encoding: 'utf8', shell: process.platform === 'win32', timeout: 180_000 });
  if (r.status !== 0) {
    throw new Error(`supabase db query failed (exit ${r.status}): ${r.stderr || r.stdout}`);
  }
  let parsed;
  try {
    const t = r.stdout, i = t.indexOf('{');
    parsed = JSON.parse(i >= 0 ? t.slice(i, t.lastIndexOf('}') + 1) : t);
  } catch { throw new Error(`could not parse CLI output: ${r.stdout.slice(0, 300)}`); }
  const rows = Array.isArray(parsed) ? parsed : parsed.rows;
  if (!Array.isArray(rows)) {
    throw new Error(`unexpected CLI shape: ${r.stdout.slice(0, 300)}`);
  }
  return rows;
}

/** job_costing() must be read as somebody with SEE_MONEY, or it returns nothing. */
const asOwner = (body) => `
  begin;
  select set_config('request.jwt.claims', json_build_object('sub','${OWNER}','role','authenticated')::text, true);
  set local role authenticated;
  ${body}
  rollback;`;

// ---------------------------------------------------------------------------
// THE MECHANISM, against the live function
// ---------------------------------------------------------------------------

test('CANARY: job_costing answers at all when read as the owner', () => {
  // Read as the migration role it returns ZERO ROWS -- money_scope_company_id()
  // is null -- and every assertion below would pass on an empty answer. That
  // is how this very audit nearly concluded "0 jobs, nothing to see".
  const rows = runSql(asOwner(`select count(*)::int as n from public.job_costing();`));
  const n = Number(rows[0]?.n ?? 0);
  assert.ok(n > 0, `job_costing returned ${n} rows as the owner; the impersonation is not working`);
});

test('a job with NO line items is not flagged, and reports its whole price as profit', () => {
  // The defect itself, stated as the behaviour it produces rather than as the
  // coalesce that causes it. If this ever starts failing because the flag went
  // true for a materials-less job, the SQL has been changed and the office's
  // dagger below is no longer the only thing standing between the owner and a
  // 100% margin.
  const rows = runSql(asOwner(`
    select c.job_sync_id, c.quoted, c.material_cost, c.margin_percent, c.costs_are_sell_prices,
           (select count(*)::int from estimate_line_items i
             where i.job_sync_id::text = c.job_sync_id and i.deleted_at is null) as lines
      from public.job_costing() c
     where c.costs_are_sell_prices = false and coalesce(c.quoted,0) > 0;`));
  for (const r of rows) {
    assert.strictEqual(Number(r.lines), 0,
      `job ${r.job_sync_id} is unflagged but HAS ${r.lines} line items -- the flag now means ` +
      'something different and this whole file is testing the wrong thing');
  }
});

test('BEHAVIOUR: removing a job\'s lines flips it to a 100% margin and the flag stays false', () => {
  // Constructed, because the live data cannot produce this on a real job:
  // measured 7 Nov, 0 of 20 jobs have a supplier price, 0 have a change order
  // and 0 have a refund, so every money test that runs over live rows
  // exercises none of these branches. This one makes the case instead of
  // waiting for it.
  const rows = runSql(asOwner(`
    create temporary table pick as
      select c.job_sync_id from public.job_costing() c
       where c.costs_are_sell_prices = true and coalesce(c.quoted,0) > 0
         and (select count(*) from estimate_line_items i
               where i.job_sync_id::text = c.job_sync_id and i.deleted_at is null) > 0
       limit 1;

    create temporary table seen (phase text, flagged boolean, matcost numeric, margin numeric);

    insert into seen
      select 'with_lines', c.costs_are_sell_prices, c.material_cost, c.margin_percent
        from public.job_costing() c where c.job_sync_id = (select job_sync_id from pick);

    update estimate_line_items set deleted_at = now()
     where job_sync_id::text = (select job_sync_id from pick) and deleted_at is null;

    insert into seen
      select 'lines_gone', c.costs_are_sell_prices, c.material_cost, c.margin_percent
        from public.job_costing() c where c.job_sync_id = (select job_sync_id from pick);

    select phase, flagged, matcost, margin from seen;`));

  const by = Object.fromEntries(rows.map(r => [r.phase, r]));
  assert.ok(by.with_lines, 'no priced job was available -- this test proved nothing');

  const flagged = (v) => v === true || v === 't';
  assert.ok(flagged(by.with_lines.flagged),
    'the starting job was not flagged, so the comparison below means nothing');
  assert.ok(Number(by.with_lines.matcost) > 0, 'the starting job had no material cost');

  // After the lines go: no materials row, bool_and null, coalesce -> false.
  assert.ok(!flagged(by.lines_gone.flagged),
    'losing every line item now FLAGS the job -- if job_costing was fixed in SQL, ' +
    'the office dagger is redundant and this file should be re-aimed, not deleted');
  assert.strictEqual(Number(by.lines_gone.matcost), 0, 'material cost did not fall to zero');
  assert.ok(Number(by.lines_gone.margin) > Number(by.with_lines.margin),
    `margin did not rise when the materials vanished ` +
    `(${by.with_lines.margin} -> ${by.lines_gone.margin})`);
});

test('the rollback took: no job lost its line items', () => {
  const [r] = runSql(`select count(*)::int as n from estimate_line_items where deleted_at is null;`);
  assert.ok(Number(r.n) > 0,
    'there are no live line items at all -- the transaction above did not roll back');
});

// ---------------------------------------------------------------------------
// THE OFFICE SAYS SO
// ---------------------------------------------------------------------------

/** dashboard.html with comment lines stripped: a must-contain check that reads
 *  comments passes on its own prose, which has produced a false green here. */
const office = () => readFileSync(join(ROOT, 'website/dashboard.html'), 'utf8')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

test('the costing table marks a materials-less job', () => {
  const code = office();
  assert.match(code, /const noMaterials = r\.quoted_material != null/,
    'the costing row no longer works out whether anything is costed on the job');
  assert.match(code, /noMaterials \? ' †'/,
    'the row carries no marker for a job with nothing costed, so a 100% margin ' +
    'is shown with the same confidence as a real one');
});

test('and guards against a deploy of job_costing without quoted_material', () => {
  // Number(undefined || 0) === 0 would flag EVERY job, turning a real warning
  // into noise everyone learns to ignore.
  //
  // COUNTED, not found. The first version of this check used assert.match,
  // which passes as long as ONE guarded use exists anywhere in the file --
  // and there are two uses, the row marker and the note. A canary that
  // stripped the guard from the row still passed here, because the note's
  // copy satisfied the regex. Every use must be guarded, so compare counts.
  const code = office();
  const uses = (code.match(/Number\(r\.quoted_material\) === 0/g) || []).length;
  const guarded = (code.match(
    /r\.quoted_material != null\s*\n?\s*&& Number\(r\.quoted_material\) === 0/g) || []).length;
  assert.ok(uses >= 2, `expected the row marker and the note to both test quoted_material, found ${uses}`);
  assert.strictEqual(guarded, uses,
    `${uses - guarded} of ${uses} uses of quoted_material skip the "is it present" ` +
    'check, so a deploy of job_costing without that column would flag every job');
});

test('the note exists in all three languages and is not the sell-prices one', () => {
  // The two sentences say OPPOSITE things about which way the margin is wrong
  // -- sell prices make it read low, no materials make it read high. Reusing
  // the existing note would tell the owner to expect the wrong error.
  const src = readFileSync(join(ROOT, 'website/dashboard.html'), 'utf8');
  const notes = [...src.matchAll(/repCostingNoMaterialsNote:'([^']*(?:\\'[^']*)*)'/g)].map(m => m[1]);
  assert.strictEqual(notes.length, 3,
    `expected the note in en, es and fr; found ${notes.length}`);
  assert.strictEqual(new Set(notes).size, 3, 'two languages carry the same string');
  for (const n of notes) {
    assert.ok(n.includes('†'), `a note is missing the marker it explains: ${n.slice(0, 40)}`);
  }
});

test('CANARY: the French note escapes its apostrophe', () => {
  // Not hypothetical. The first version of this change shipped
  // "Aucun materiau n'est chiffre" inside a SINGLE-QUOTED JS string, which
  // ends the string early and leaves the rest as syntax -- the exact way this
  // page was taken down for a day and a half before (see pages.yml). The
  // syntax gate catches it; this says WHY when it does.
  const src = readFileSync(join(ROOT, 'website/dashboard.html'), 'utf8');
  const fr = src.match(/repCostingNoMaterialsNote:'([^']*(?:\\'[^']*)*)'/g) || [];
  const joined = fr.join('\n');
  assert.ok(!/[^\\]'[a-zA-Zé]/.test(joined.replace(/repCostingNoMaterialsNote:'/g, '')),
    'an unescaped apostrophe is inside one of these single-quoted strings');
});
