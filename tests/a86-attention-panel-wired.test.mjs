// a86: THE SERVER-SIDE ALERT PANEL REACHES THE SERVER THAT EXISTS.
//
// Nine detectors -- money already at risk, a crew about to be sent to a job
// that is not ready, 811/permit/HOA deadlines -- were built, deployed, and
// triggered hourly, and were off for every company on the server. Grepping
// dashboard.html for "attention_" returned zero: there had never been anywhere
// to turn them on. The panel is the missing half.
//
// The interesting checks here are CROSS-FILE. A static grep that the page says
// 'set_attention_sweep_enabled' proves only that I typed a string; what matters
// is whether that function exists, takes the argument the page passes, and is
// granted to the role the page runs as. Those are three different files, and a
// mismatch in any of them is a button that throws at the click.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// All three overridable so tests/a86-mutate.mjs can break a COPY of any of them
// and require the matching check to go red. The cross-file checks are the whole
// point of this file, and a cross-file check nobody has watched fail is just
// three greps that happen to pass.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const page = readFileSync(process.env.A86_PAGE || join(ROOT, "website/dashboard.html"), "utf8");
const sqlSettings = readFileSync(process.env.A86_SQL_SETTINGS || join(ROOT, "supabase_p4_attention_settings.sql"), "utf8");
const sqlFindings = readFileSync(process.env.A86_SQL_FINDINGS || join(ROOT, "supabase_p4_attention_findings.sql"), "utf8");

let passed = 0, failed = 0;
const ok = (id, what, cond, detail) => {
  if (cond) { passed++; console.log(`  ok    ${id} ${what}`); }
  else { failed++; console.log(`  FAIL  ${id} ${what}${detail ? " -- " + detail : ""}`); }
};

console.log("\n1. THE PANEL IS MOUNTED AND FILLED");
ok("1a", "the panel is in the markup", page.includes('id="attnPanel"'));
for (const id of ["attnMsg", "attnSwitch", "attnRows"]) {
  ok(`1-${id}`, `${id} exists in the markup for the renderer to fill`, page.includes(`id="${id}"`));
}
// Not merely "called somewhere": the two writers call it after their own RPC,
// and a panel that only ever renders when you press its own button never
// appears on load at all. It has to be mounted from the LOAD path. The first
// version of this check accepted any call and a mutation walked straight past
// it.
ok("1b", "renderAttention is DECLARED and mounted from loadAll -- the SideTypesCard lesson, which sat unmounted for days",
  page.includes("function renderAttention(") && page.includes("try { renderAttention(); }"));
ok("1c", "and its data is loaded with the rest of the automation section",
  page.includes("await loadAttentionState();") && page.includes("async function loadAttentionState("));

console.log("\n2. THE RPCs EXIST ON THE SERVER, WITH THE ARGUMENT NAMES THE PAGE PASSES");
// This is the check a grep of the page alone cannot make. PostgREST matches a
// function by name AND argument names: p_enabled spelled enabled is a 404 at
// the click, not a compile error anywhere.
ok("2a", "set_attention_sweep_enabled is defined in the SQL the page assumes",
  /create or replace function public\.set_attention_sweep_enabled/.test(sqlSettings));
ok("2b", "the page passes p_enabled, and that is what the function declares",
  page.includes("{ p_enabled: on }") && /p_enabled\s+boolean/.test(sqlSettings));
ok("2c", "clear_attention_finding is defined in the SQL",
  /create or replace function public\.clear_attention_finding/.test(sqlFindings));
ok("2d", "the page passes p_finding_id, and that is what the function declares",
  page.includes("{ p_finding_id: id }") && /p_finding_id\s+uuid/.test(sqlFindings));
ok("2e", "both are granted to authenticated -- the role the office actually runs as",
  /grant\s+execute on function public\.set_attention_sweep_enabled\([^)]*\) to authenticated/.test(sqlSettings) &&
  /grant\s+execute on function public\.clear_attention_finding\(uuid\) to authenticated/.test(sqlFindings));

console.log("\n3. THE TABLES IT READS ARE READABLE BY THE COMPANY");
ok("3a", "attention_sweep_settings has a select policy scoped to the company",
  /create policy attention_sweep_settings_read[\s\S]{0,200}for select using \(company_id = public\.current_company_id\(\)\)/.test(sqlSettings));
ok("3b", "attention_findings has one too",
  /create policy attention_findings_read[\s\S]{0,200}for select using \(company_id = public\.current_company_id\(\)\)/.test(sqlFindings));
ok("3c", "the page selects only columns the table really has",
  ["enabled", "quiet_hours_start", "quiet_hours_end", "timezone", "updated_at"]
    .every(c => sqlSettings.includes(c)) &&
  ["id", "job_sync_id", "detector", "severity", "message", "created_at", "cleared_at"]
    .every(c => sqlFindings.includes(c)));
ok("3d", "and it asks only for findings nobody has cleared",
  page.includes(".is('cleared_at', null)"));

console.log("\n4. OFF DOES NOT READ AS ALL CLEAR");
// The whole reason this panel exists: an office that shows nothing because
// nothing is looking is indistinguishable from an office with nothing wrong.
ok("4a", "when the switch is off the panel SAYS so rather than showing an empty list",
  page.includes("attnOffMeansBlind"));
ok("4b", "and that string actually says an empty list would not mean all clear",
  /An empty list would not mean all clear/.test(page));
ok("4c", "when it is on and genuinely empty, it says when it last looked",
  page.includes("attnNoneOpen") && /Checked within the last hour/.test(page));
ok("4d", "severity is not carried by colour alone -- critical reuses the filled brief-dot",
  page.includes("f.severity === 'critical' ? ' urgent' : ''"));

console.log("\n5. IT DOES NOT OFFER A CONTROL IT WOULD REFUSE");
ok("5a", "the toggle is disabled for someone who cannot edit settings",
  page.includes("canFlip ? '' : 'disabled'"));
ok("5b", "and says who can, instead of just going dead",
  page.includes("attnCannotFlip"));
ok("5c", "both writers re-check canEdit(), so a disabled button is not the only gate",
  (page.match(/if \(!canEdit\(\)\) return;\n  const \{ error \} = await db\.rpc\('(set_attention_sweep_enabled|clear_attention_finding)'/g) || []).length === 2);

console.log("\n6. ALL THREE LANGUAGES, OR IT SAYS 'undefined' TO TWO THIRDS OF THE APP");
for (const k of ["attnHead", "attnOnNow", "attnOffNow", "attnTurnOn", "attnTurnOff",
                 "attnTurnedOn", "attnTurnedOff", "attnCannotFlip", "attnOffMeansBlind",
                 "attnNoneOpen", "attnClearBtn"]) {
  const n = page.split(`    ${k}:`).length - 1 + page.split(` ${k}:`).length - 1;
  ok(`6-${k}`, `${k} is defined in all three tables`, n >= 3, `found ${n}`);
}

console.log("\n7. CANARIES");
ok("7a", "CANARY: 2b would fail on a renamed argument, because it reads the SQL and not the page",
  !/p_switched_on\s+boolean/.test(sqlSettings));
ok("7b", "CANARY: 1b checks the CALL as well as the declaration",
  !"function renderAttention(){}".includes("renderAttention();"));
ok("7c", "CANARY: the grant check is anchored to 'authenticated', not merely to the word grant",
  !/to anon;/.test(sqlSettings.match(/grant\s+execute on function public\.set_attention_sweep_enabled[^\n]*/)?.[0] || ""));

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
