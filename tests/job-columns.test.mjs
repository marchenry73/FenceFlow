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
