// Guards the JOB_COLUMNS select-list in website/dashboard.html against a
// forgotten column.
//
// loadAll() used to fetch `jobs` with select('*'). At 1,500 jobs that is
// roughly half of a ~7 MB first-paint payload (see PERFORMANCE_AT_VOLUME.md),
// so it was trimmed to an explicit column list. The risk with that trim is
// exactly the failure mode PERFORMANCE_AT_VOLUME.md calls out: a column
// somebody forgets shows up as a blank field or a wrong total, silently,
// possibly months later.
//
// This test re-derives, from the page's own source, every property the page
// reads off a job object (jobs.map(j=>...), function f(job), openJob.x,
// target.x, etc.) and fails if JOB_COLUMNS is missing any of them.
//
// It is deliberately narrow about which variables it treats as "a job": only
// the documented job-binding sites (the loop/param names actually used for
// jobs in dashboard.html, confirmed by hand against the code). Generic
// single-letter names like j2/x/e/t are reused in this file for other
// entities (query results, employees, time entries, ...) and are excluded on
// purpose -- including them would pull in properties like `.data`/`.error`
// (Supabase response fields, not job columns) and make the test fail forever
// for the wrong reason.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const SRC_PATH = new URL("../website/dashboard.html", import.meta.url);
const src = readFileSync(SRC_PATH, "utf8");

// Property accesses that are real Supabase/JS plumbing, not job columns, but
// that slip through a naive scan of these variable names because the same
// short name is reused for other things elsewhere in the file (e.g. `j.data`
// on a query-result object, or `x2` walking an unrelated array in one spot).
// `lat` (no `job_sync_id`/`site_` prefix): `j` is reused for a geocoder JSON
// response a few lines away from the real job loop (`const j = await
// r.json(); if (r.ok && j.lat)`) -- the job's own coordinates are
// site_lat/site_lon, already in JOB_COLUMNS.
const KNOWN_NON_COLUMNS = new Set(["data", "error", "matched", "job_sync_id", "lat"]);

function extractJobColumns(source) {
  const found = new Set();
  // jobs.map(j=>...), jobs.filter(j=>...), jobs.find(j=>...), jobs.forEach(j=>...),
  // then any j.<prop> / job.<prop> / openJob.<prop> access anywhere in the
  // file (these three names are used exclusively for job rows here --
  // verified by hand, see the audit this test was written alongside).
  // Deliberately excludes `target`, which elsewhere in this file means
  // `e.target` (an event target, e.g. target.checked/target.value/
  // target.closest(...)), not a job -- including it pulled in DOM
  // properties that will never be job columns.
  const re = /\b(?:j|job|openJob)\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m;
  while ((m = re.exec(source))) {
    const prop = m[1];
    if (KNOWN_NON_COLUMNS.has(prop)) continue;
    found.add(prop);
  }
  return found;
}

function extractJobColumnsList(source) {
  const m = source.match(/const JOB_COLUMNS = \[([\s\S]*?)\]\.join/);
  assert.ok(m, "JOB_COLUMNS array not found in source");
  const body = m[1];
  const cols = [...body.matchAll(/'([a-zA-Z_][a-zA-Z0-9_]*)'/g)].map((x) => x[1]);
  return new Set(cols);
}

test("every property the page reads off a job is in JOB_COLUMNS", () => {
  const accessed = extractJobColumns(src);
  const declared = extractJobColumnsList(src);
  assert.ok(declared.size > 10, "JOB_COLUMNS parsed suspiciously short");
  const missing = [...accessed].filter((p) => !declared.has(p)).sort();
  assert.deepEqual(
    missing,
    [],
    `dashboard.html reads job.${missing.join(", job.")} but JOB_COLUMNS does not select ` +
      `${missing.length === 1 ? "it" : "them"} -- add to JOB_COLUMNS in dashboard.html`
  );
});

/* THE MODULES READ JOB ROWS TOO, and scanning only dashboard.html missed one.
 *
 * follow-ups.mjs is handed job rows straight out of the page's own `jobs`
 * array -- dueFollowUp(job, settings, now) and previewDueFollowUps(jobs, ...).
 * Every property IT reads has to be in JOB_COLUMNS just as much as one the
 * page reads itself, because it is the same object.
 *
 * opted_out_at got through exactly here on 5 Oct 2026. dueFollowUp refuses a
 * job carrying it -- `if (job.opted_out_at) return null` -- but the office
 * never selected the column, so the property was undefined, the refusal never
 * fired, and both the due-list and the per-rule "N waiting" counts offered to
 * email people who had asked not to be. Nobody had opted out yet, so nothing
 * wrong was ever shown; it would have gone wrong the first time somebody did.
 */
test("every job property the follow-up module reads is in JOB_COLUMNS too", () => {
  const modSrc = readFileSync(new URL("../website/js/lib/follow-ups.mjs", import.meta.url), "utf8");
  // This module names its parameter `job` throughout, so the scan is exact
  // rather than heuristic -- no reuse of the name for anything else.
  const read = new Set([...modSrc.matchAll(/\bjob\.([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]));
  assert.ok(read.size > 3, `canary: only ${read.size} job.<prop> reads found -- the scan is broken`);
  assert.ok(read.has("opted_out_at"),
    "canary: the module no longer reads opted_out_at, so this check is pinned to the wrong file");

  const declared = extractJobColumnsList(src);
  const missing = [...read].filter((p) => !declared.has(p) && !KNOWN_NON_COLUMNS.has(p)).sort();
  assert.deepEqual(
    missing,
    [],
    `follow-ups.mjs reads job.${missing.join(", job.")} off a row the page selected without ` +
      `${missing.length === 1 ? "it" : "them"} -- undefined at runtime, so the rule silently ` +
      `never fires. Add to JOB_COLUMNS in dashboard.html`
  );
});

test("planted failure: the scan has teeth", () => {
  // Prove the regex+diff actually catches a missing column, rather than
  // trivially passing because it scans nothing. Simulate a page that reads
  // job.totally_made_up_field but never selects it.
  const fakeSource =
    "const JOB_COLUMNS = ['id','sync_id'].join(',');\n" +
    "jobs.map(j => j.totally_made_up_field);\n";
  const accessed = extractJobColumns(fakeSource);
  const declared = extractJobColumnsList(fakeSource);
  const missing = [...accessed].filter((p) => !declared.has(p));
  assert.deepEqual(missing, ["totally_made_up_field"]);
});
