// Proves the staged-release audience guard in supabase_release_audience_patch.sql
// before it is ever applied for real -- the whole migration plus every check
// below runs inside one `begin; ... rollback;` against the LIVE database, via
// the same `supabase db query --linked` technique tests/live-rules-guard.test.mjs
// uses. Nothing here is written with a service_role key, and nothing survives
// the transaction: not the new column, not the new table, not the fixture rows.
//
// What has to be proved, in one run, on the real schema:
//   1. the fixture actually has the property the checks depend on (two real,
//      DIFFERENT companies, and a real platform admin) -- asserted before any
//      security conclusion is drawn, because a fixture that quietly isn't what
//      it claims to be has invalidated checks in this project before;
//   2. PLANTED FAILURE: with release_visible_to_caller() replaced by a stub
//      that always says yes, an outside company wrongly sees a limited
//      release -- proving this test can actually fail;
//   3. the REAL rule: the outside company is refused (negative) and the
//      audience company receives it (positive), IN THE SAME transaction;
//   4. an anonymous caller (no auth.uid() at all) is refused too, since it
//      carries no identity to be a member of anything;
//   5. promotion is the one thing that turns 'limited' into 'everyone' -- the
//      outside company sees nothing before promotion and the release after
//      it, and a non-admin cannot call admin_promote_release() at all.
//
//   node tests/release-audience-guard.test.mjs

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";

const PROJECT = "newcrgafcptspmapacrx";

// Real, live identifiers, discovered read-only beforehand -- not invented.
// Two DIFFERENT real companies, each with a real profile row, plus a real
// platform admin. Verified as real and distinct by check 0 below, not just
// asserted in this comment.
const CO_IN       = "aba5b097-afc4-48dd-9851-b50200d5e8f4"; // "Fence solutions" -- the audience
const IN_AUDIENCE = "518fde2b-e689-4164-b900-85d8c7ca9748"; // a profile that belongs to CO_IN
const ADMIN       = "7bf38947-24cf-4e79-9af0-6100d04b166b"; // platform admin, also in CO_IN
const CO_OUT      = "20f62301-6737-4385-ad95-3610a115b4b7"; // "Horizon fence llc" -- NOT the audience
const OUTSIDER    = "cac76dcd-d078-470f-b1e6-cc8c201255a6"; // a profile that belongs to CO_OUT

let failed = 0, checked = 0;
const ok = (name, cond, detail = "") => {
  checked++;
  if (cond) { console.log(`  ok    ${name}`); return; }
  failed++;
  console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
};

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "release-audience-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query",
    "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
    { encoding: "utf8", shell: process.platform === "win32", timeout: 180_000 });
  if (r.status !== 0) {
    throw new Error(`supabase db query failed: ${r.stderr || r.stdout}`);
  }
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { throw new Error(`could not parse CLI output: ${r.stdout}`); }
  return Array.isArray(parsed) ? parsed : (parsed.rows || []);
}

const asClaim = (sub) => sub === null
  ? `select set_config('request.jwt.claims', '', true); set local role anon;`
  : `select set_config('request.jwt.claims', json_build_object('sub','${sub}','role','authenticated')::text, true);
     set local role authenticated;`;

// The migration itself, run inline so this test proves the design against the
// live schema before March ever runs the real file. Copied at read time
// rather than retyped, so the test can never silently drift from what will
// actually be applied.
const migration = readFileSync(
  join(process.cwd(), "supabase_release_audience_patch.sql"), "utf8"
);

async function main() {
  console.log("\n0. The fixture actually has the property every check below depends on:");
  const fixture = runSql(`
begin;
select
  (select company_id from profiles where id = '${IN_AUDIENCE}') as in_company,
  (select company_id from profiles where id = '${OUTSIDER}') as out_company,
  (select is_platform_admin from profiles where id = '${ADMIN}') as admin_is_admin,
  (select company_id from profiles where id = '${ADMIN}') as admin_company;
rollback;
`);
  const f = fixture[0] || {};
  ok("IN_AUDIENCE and OUTSIDER belong to DIFFERENT companies",
     f.in_company && f.out_company && f.in_company !== f.out_company,
     `in=${f.in_company} out=${f.out_company}`);
  ok("IN_AUDIENCE really belongs to CO_IN", f.in_company === CO_IN, `got ${f.in_company}`);
  ok("OUTSIDER really belongs to CO_OUT", f.out_company === CO_OUT, `got ${f.out_company}`);
  ok("ADMIN really is a platform admin", f.admin_is_admin === true, `got ${f.admin_is_admin}`);
  ok("ADMIN belongs to CO_IN, not some third company (irrelevant to the guard, but keeps the fixture honest)",
     f.admin_company === CO_IN, `got ${f.admin_company}`);
  if (failed) {
    console.log(`\n${checked - failed} passed, ${failed} failed -- stopping before running the security checks`);
    console.log("on a fixture that isn't what it claims to be.");
    process.exit(1);
  }

  console.log("\n1-4. The audience guard, planted failure, real rule, and anonymous refusal:");
  const check = runSql(`
begin;

${migration}

create temp table probe(who text, ok_result boolean, detail text) on commit drop;
grant all on probe to authenticated, anon;

-- A throwaway release at a fixed, made-up id -- avoids depending on \\gset
-- (a psql meta-command the CLI's query runner may not support) to carry a
-- generated id between statements.
insert into app_releases (id, version_code, version_name, notes, audience)
values ('99999999-0000-4000-8000-000000000001', 999999999, 'test-only',
        'release-audience-guard.test.mjs fixture', 'limited');

insert into app_release_audience (release_id, company_id)
values ('99999999-0000-4000-8000-000000000001', '${CO_IN}');

-- ---- PLANTED FAILURE: stub release_visible_to_caller() to always say yes,
-- reproducing the exact bug this guard exists to prevent -- a limited
-- release leaking to a company that was never added to it.
create or replace function public.release_visible_to_caller(rid uuid)
returns boolean language sql stable as $inner$ select true; $inner$;

${asClaim(OUTSIDER)}
insert into probe select 'PLANTED-BUG: outsider wrongly sees it',
  exists (select 1 from app_releases where id = '99999999-0000-4000-8000-000000000001'), 'stub always returns true';
reset role;

-- undo the plant: restore the real, security-definer membership check.
create or replace function public.release_visible_to_caller(rid uuid)
returns boolean
language sql stable security definer set search_path to 'public'
as $inner$
    select exists (
        select 1
          from public.app_release_audience a
          join public.profiles p on p.company_id = a.company_id
         where a.release_id = rid
           and p.id = auth.uid()
    );
$inner$;

-- ---- REAL rule ----
${asClaim(OUTSIDER)}
insert into probe select 'outsider (real rule) is refused',
  not exists (select 1 from app_releases where id = '99999999-0000-4000-8000-000000000001'), 'row was visible, should not be';
reset role;

${asClaim(IN_AUDIENCE)}
insert into probe select 'audience member receives it',
  exists (select 1 from app_releases where id = '99999999-0000-4000-8000-000000000001'), 'row was NOT visible, should be';
reset role;

select set_config('request.jwt.claims', '', true);
set local role anon;
insert into probe select 'anonymous caller is refused (no identity to be a member with)',
  not exists (select 1 from app_releases where id = '99999999-0000-4000-8000-000000000001'), 'row was visible to anon';
reset role;

select * from probe order by who;
rollback;
`);
  const row = (name) => check.find(r => r.who === name) || {};
  ok("PLANTED FAILURE: the stub wrongly lets the outsider see it (proves this test can fail)",
     row("PLANTED-BUG: outsider wrongly sees it").ok_result === true,
     `got ${JSON.stringify(row("PLANTED-BUG: outsider wrongly sees it"))}`);
  ok("outsider (real rule) is refused", row("outsider (real rule) is refused").ok_result === true,
     row("outsider (real rule) is refused").detail);
  ok("audience member receives it", row("audience member receives it").ok_result === true,
     row("audience member receives it").detail);
  ok("anonymous caller is refused", row("anonymous caller is refused (no identity to be a member with)").ok_result === true,
     row("anonymous caller is refused (no identity to be a member with)").detail);

  console.log("\n5. Promotion is the only thing that turns 'limited' into 'everyone':");
  const promo = runSql(`
begin;

${migration}

create temp table probe(who text, ok_result boolean, detail text) on commit drop;
grant all on probe to authenticated, anon;

insert into app_releases (id, version_code, version_name, notes, audience)
values ('99999999-0000-4000-8000-000000000002', 999999998, 'test-only-promo',
        'release-audience-guard.test.mjs fixture', 'limited');

insert into app_release_audience (release_id, company_id)
values ('99999999-0000-4000-8000-000000000002', '${CO_IN}');

${asClaim(OUTSIDER)}
insert into probe select 'before promotion: outsider cannot see it',
  not exists (select 1 from app_releases where id = '99999999-0000-4000-8000-000000000002'), 'visible before promotion';
reset role;

-- A non-admin trying to promote must be refused, not merely ignored. Tried
-- against the SAME release this check is about to legitimately promote, so
-- a false "no exception" here cannot be explained away as "wrong target id".
${asClaim(IN_AUDIENCE)}
do $inner$
begin
  begin
    perform admin_promote_release('99999999-0000-4000-8000-000000000002'::uuid);
    insert into probe values ('non-admin cannot call admin_promote_release', false, 'no exception raised');
  exception when others then
    insert into probe values ('non-admin cannot call admin_promote_release', true, sqlerrm);
  end;
end $inner$;
reset role;

${asClaim(ADMIN)}
select admin_promote_release('99999999-0000-4000-8000-000000000002');
reset role;

${asClaim(OUTSIDER)}
insert into probe select 'after promotion: outsider now sees it',
  exists (select 1 from app_releases where id = '99999999-0000-4000-8000-000000000002'), 'still not visible after promotion';
reset role;

insert into probe select 'after promotion: membership rows are cleared',
  not exists (select 1 from app_release_audience where release_id = '99999999-0000-4000-8000-000000000002'), 'membership row survived';

select * from probe order by who;
rollback;
`);
  const p = (name) => promo.find(r => r.who === name) || {};
  ok("before promotion: outsider cannot see it", p("before promotion: outsider cannot see it").ok_result === true,
     p("before promotion: outsider cannot see it").detail);
  ok("non-admin cannot call admin_promote_release", p("non-admin cannot call admin_promote_release").ok_result === true,
     p("non-admin cannot call admin_promote_release").detail);
  ok("after promotion: outsider now sees it", p("after promotion: outsider now sees it").ok_result === true,
     p("after promotion: outsider now sees it").detail);
  ok("after promotion: membership rows are cleared", p("after promotion: membership rows are cleared").ok_result === true,
     p("after promotion: membership rows are cleared").detail);

  console.log(`\n${checked - failed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch(e => { console.error("release-audience-guard test could not run:", e.message); process.exit(1); });
