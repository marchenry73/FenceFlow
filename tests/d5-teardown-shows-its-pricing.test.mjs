// D5 verifier: the teardown section keeps all five controls AND shows what
// each one is pricing. Source-slicing, in the house style of tests/.
//
// Every check carries a positive control, because a checker that cannot find
// its region reports zero failures for every case in it.
import { readFileSync } from "node:fs";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
// Relative, so this runs wherever the repo is checked out -- the
// scratchpad copy it grew up in had an absolute path.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCREEN_PATH = ROOT + "/app/src/main/java/com/fenceestimator/app/ui/jobs/JobDetailScreen.kt";
const ENGINE_PATH = ROOT + "/app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt";
const TOTALS_PATH = ROOT + "/supabase/functions/_shared/pricing/totals.ts";
const LOCALES = ["values", "values-es", "values-fr"];

let pass = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { pass++; console.log("  ok    " + name); }
  else { fails.push(name); console.log("  FAIL  " + name); }
}

const screen = readFileSync(SCREEN_PATH, "utf8");
const engine = readFileSync(ENGINE_PATH, "utf8");
const totalsTs = readFileSync(TOTALS_PATH, "utf8").replace(/\r\n/g, "\n");

// ---- slice TeardownFields out of the file, not the file out of the repo ----
const defStart = screen.indexOf("private fun TeardownFields(");
const nextDef = screen.indexOf("\nprivate fun ", defStart + 10);
const region = screen.slice(defStart, nextDef);

console.log("\n0. the slicer isolated the one function:");
ok("positive control: the region contains TeardownFields' own switch", region.includes("jd_include_teardown"));
ok("positive control: the region stops before the next top-level fun",
  defStart > 0 && nextDef > defStart && region.indexOf("\nprivate fun ", 5) === -1);
ok("negative control: the region does not run on into a neighbouring composable",
  !region.includes("private fun ConfirmDeleteJobDialog(") && !region.includes("private fun MoneyLine("));

// ---- D5's absolute: none of the five controls may be removed ----
console.log("\n1. all five teardown controls are still present and still write their own job field:");
const controls = [
  ["teardown_enabled  (switch)", "j.copy(teardownEnabled = it)"],
  ["teardown_flat_fee (field)", "j.copy(teardownFlatFee = it.toDouble())"],
  ["teardown_rate_per_ft (field)", "j.copy(teardownRatePerFt = it.toDouble())"],
  ["trash_haul_fee (field)", "j.copy(trashHaulFee = it.toDouble())"],
  ["teardown_feet (field)", "j.copy(teardownFeet = it.toDouble())"],
];
for (const [label, needle] of controls) {
  ok(label + " still writes its field", region.includes(needle));
}
ok("positive control: a control spelling that was never there is NOT found",
  !region.includes("j.copy(teardownNonsense = it.toDouble())"));

// ---- each control now shows what it is pricing ----
console.log("\n2. each control shows its own money:");
ok("the switch, when off, says what the charge is instead of hiding it",
  /if \(!job\.teardownEnabled\) \{[\s\S]{0,600}?R\.string\.jd_teardown_off_note/.test(region));
ok("the flat fee has its own money line", region.includes("R.string.jd_teardown_line_flat"));
ok("the rate has a money line that names the rate AND the feet it multiplies",
  region.includes("R.string.jd_teardown_line_per_ft") &&
  region.includes("Money.format(job.teardownRatePerFt).removePrefix(\"$\")") &&
  /jd_teardown_line_per_ft[\s\S]{0,400}?"%\.0f"\.format\(resolvedTeardownFt\)/.test(region));
ok("the rate line's amount is rate x the resolved feet",
  region.includes("job.teardownRatePerFt * resolvedTeardownFt"));
ok("the haul fee has its own money line", region.includes("R.string.jd_teardown_line_haul"));
ok("the resulting teardown charge is shown, bold, as its own line",
  /jd_teardown_line_total\),\s*\n\s*totals\.teardownCost,\s*\n\s*bold = true/.test(region));

// ---- which of the THREE fallbacks is in play ----
console.log("\n3. the three-step footage fallback is named, in the engine's own order:");
const resolved = region.slice(region.indexOf("val resolvedTeardownFt = when {"),
  region.indexOf("val feetSource = when {"));
ok("positive control: the resolved-footage when was found", resolved.includes("job.teardownFeet > 0.0"));
ok("step 1 is the typed override", /job\.teardownFeet > 0\.0 -> job\.teardownFeet/.test(resolved));
ok("step 2 is the drawn old fence", /drawnTeardownFt > 0f -> drawnTeardownFt\.toDouble\(\)/.test(resolved));
ok("step 3 is the new fence's own billable footage",
  /else -> totals\.billableLinearFeet\.toDouble\(\)/.test(resolved));
ok("exactly three branches -- a fourth would be a pricing rule this file invented",
  (resolved.match(/->/g) || []).length === 3);
ok("the three branches are in the engine's order: typed, then drawn, then the new fence",
  resolved.indexOf("job.teardownFeet > 0.0") < resolved.indexOf("drawnTeardownFt > 0f") &&
  resolved.indexOf("drawnTeardownFt > 0f") < resolved.indexOf("else ->"));

const srcWhen = region.slice(region.indexOf("val feetSource = when {"),
  region.indexOf("Spacer(Modifier.height(8.dp))", region.indexOf("val feetSource = when {")));
ok("positive control: the source-naming when was found", srcWhen.includes("jd_teardown_feet_from_typed"));
ok("the typed case is named as the typed length",
  /job\.teardownFeet > 0\.0 -> stringResource\(R\.string\.jd_teardown_feet_from_typed\)/.test(srcWhen));
ok("the drawn case is named as the old fence on the drawing",
  /drawnTeardownFt > 0f -> stringResource\(R\.string\.jd_teardown_feet_from_drawn\)/.test(srcWhen));
ok("the fallback case is named as the new fence's own length",
  /else -> stringResource\(R\.string\.jd_teardown_feet_from_new_fence\)/.test(srcWhen));
ok("the three source phrases are three DIFFERENT strings",
  new Set(["jd_teardown_feet_from_typed", "jd_teardown_feet_from_drawn", "jd_teardown_feet_from_new_fence"]
    .filter(k => srcWhen.includes(k))).size === 3);
ok("the source branches are in the SAME order as the footage branches",
  srcWhen.indexOf("job.teardownFeet > 0.0") < srcWhen.indexOf("drawnTeardownFt > 0f") &&
  srcWhen.indexOf("drawnTeardownFt > 0f") < srcWhen.indexOf("else ->"));
ok("a resolved footage of zero says the rate adds nothing, instead of printing 'x 0 ft'",
  /resolvedTeardownFt <= 0\.0\) stringResource\(R\.string\.jd_teardown_no_feet_note\)/.test(region));

// ---- display only: no pricing arithmetic decided here ----
console.log("\n4. display only -- the engines still own the arithmetic:");
ok("the charge shown is the engine's teardownCost, not a sum worked out here",
  region.includes("totals.teardownCost") && !/val\s+teardownCost\s*=/.test(region));
const writes = [...region.matchAll(/j\.copy\((\w+) =/g)].map(m => m[1]).sort();
ok("the region writes exactly the five teardown fields plus the gate rate it also hosts: " +
  writes.join(","),
  writes.join(",") === ["teardownEnabled", "teardownFlatFee", "teardownRatePerFt",
    "trashHaulFee", "teardownFeet", "gateRatePerFt"].sort().join(","));
ok("the drawn footage is the engine's own function, not re-measured here",
  region.includes("EstimateEngine.teardownLinearFeet(job, runs)"));

console.log("\n5. the two engines' teardown arithmetic is untouched (mirror pin):");
const KOTLIN_PIN = `        val teardownFt = when {
            job.teardownFeet > 0.0 -> job.teardownFeet
            drawnTeardownFt > 0.0 -> drawnTeardownFt
            else -> billableFeet.toDouble()
        }
        val teardownCost =
            if (job.teardownEnabled) job.teardownFlatFee + job.teardownRatePerFt * teardownFt + trashHaul
            else 0.0`;
const TS_PIN = `  const teardownFt =
    job.teardownFeet > 0.0 ? job.teardownFeet
    : drawnTeardownFt > 0.0 ? drawnTeardownFt
    : billableFeet;
  const teardownCost = job.teardownEnabled
    ? job.teardownFlatFee + job.teardownRatePerFt * teardownFt + trashHaul
    : 0.0;`;
ok("EstimateEngine.kt's teardown block is byte-identical to the pin", engine.includes(KOTLIN_PIN));
ok("totals.ts's teardown block is byte-identical to the pin", totalsTs.includes(TS_PIN));
ok("positive control: a deliberately wrong pin is NOT found",
  !engine.includes(KOTLIN_PIN.replace("teardownRatePerFt", "teardownRatePerFoot")));

// ---- every string the region names exists in all three locales ----
console.log("\n6. every string the region names exists in all three locales, with matching placeholders:");
const xml = {};
for (const loc of LOCALES) {
  xml[loc] = readFileSync(`${ROOT}/app/src/main/res/${loc}/strings.xml`, "utf8");
}
function body(loc, key) {
  const m = xml[loc].match(new RegExp(`<string name="${key}"[^>]*>([\\s\\S]*?)</string>`));
  if (m) return m[1];
  const p = xml[loc].match(new RegExp(`<plurals name="${key}">([\\s\\S]*?)</plurals>`));
  return p ? p[1] : null;
}
const named = [...new Set([...region.matchAll(/R\.(?:string|plurals)\.(\w+)/g)].map(m => m[1]))];
ok("positive control: the region actually names some strings", named.length >= 15);
let missing = [];
let mismatched = [];
for (const key of named) {
  const bodies = LOCALES.map(loc => body(loc, key));
  bodies.forEach((b, i) => { if (b === null) missing.push(`${key}@${LOCALES[i]}`); });
  const counts = bodies.filter(b => b !== null)
    .map(b => (b.match(/%\d+\$[sd]/g) || []).length);
  if (new Set(counts).size > 1) mismatched.push(`${key}=${counts.join("/")}`);
}
ok("no string named by the region is missing from any locale: " + (missing.join(", ") || "none"),
  missing.length === 0);
ok("placeholder counts agree across the three locales: " + (mismatched.join(", ") || "none"),
  mismatched.length === 0);
ok("positive control: a name that does not exist IS reported missing",
  body("values", "jd_teardown_nonexistent_key_xyz") === null);

// French apostrophes must be escaped or aapt drops the rest of the string.
const frNew = named.map(k => body("values-fr", k)).filter(Boolean).join("\n");
const badApostrophe = /(^|[^\\])'/.test(frNew);
ok("every apostrophe in the French strings this region uses is escaped", !badApostrophe);

console.log(`\n${pass} of ${pass + fails.length} checks passed`);
if (fails.length) {
  console.log("FAILED:\n  " + fails.join("\n  "));
  process.exit(1);
}
