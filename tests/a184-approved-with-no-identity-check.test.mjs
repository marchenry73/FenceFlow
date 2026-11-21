/* a184: the office can finally see an approval that nobody was checked for.
 *
 * quote-view asks the customer for the last four digits of the phone on the
 * job before it records an approval. When the job carries no phone there is
 * nothing to check against, and it lets the approval through on purpose --
 * refusing would strand a real customer over a field their contractor left
 * empty -- but it writes `quote_approved_without_phone_check` so the office
 * can see the gate did not run.
 *
 * MEASURED on the live database, 20 Nov 2026: nine jobs have ever been
 * approved online and FOUR of them carry that flag. Nothing read the column.
 * Not this page, not the app, not an email, not a report -- a flag written
 * for a reader who did not exist, which is the same as no flag at all. Of
 * the four, two are deleted and one was later signed on paper; the one that
 * remains is live, unsigned, and worth $11,442.36.
 *
 * The detector is lifted out of dashboard.html by exact source markers and
 * RUN (a7's grabBetween idiom), not grepped at: the enclosing renderDash()
 * is not something a standalone test can call, and a test that only matched
 * the source text would pass on a detector that throws.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("website/dashboard.html", "utf8");

const grabBetween = (startMarker, endMarkerInclusive) => {
  const s = src.indexOf(startMarker);
  if (s < 0) throw new Error("start not found: " + startMarker);
  const e = src.indexOf(endMarkerInclusive, s);
  if (e < 0) throw new Error("end not found: " + endMarkerInclusive);
  return src.slice(s, e + endMarkerInclusive.length);
};

const DETECTOR_SOURCE = grabBetween(
  "  if (alertOn('approved_unverified')) jobs.filter(j => j.quote_approved_without_phone_check",
  "key:'approved_unverified:'+j.id, fp:j.quote_approved_at }));",
);

/** Runs the SHIPPED detector against one job and returns what it pushed. */
function detect(job, { source = DETECTOR_SOURCE, muted = false } = {}) {
  const items = [];
  new Function("alertOn", "jobs", "items", "tr", "name", source)(
    () => !muted,
    [job],
    items,
    (k, ...a) => k + "|" + a.join("|"),
    (j) => j.customer_name || "a job",
  );
  return items;
}

/** The live shape: approved online, no phone to check, never signed. */
const bethelBuilt = () => ({
  id: "job-bethel",
  customer_name: "bethel built",
  status: "ACCEPTED",
  quote_approved_at: "2026-10-02T15:04:00Z",
  quote_approved_without_phone_check: true,
  signed_at: null,
  updated_at: "2026-11-20T09:00:00Z",
});

// ------------------------------------------------------------ it fires

test("the live shape raises the alert, and names the job", () => {
  const items = detect(bethelBuilt());
  assert.equal(items.length, 1, "an unverified, unsigned approval must be shown");
  assert.equal(items[0].key, "approved_unverified:job-bethel");
  assert.equal(items[0].severity, "warn");
  assert.equal(items[0].urgent, false);
  assert.match(items[0].text, /^alertTxtApprovedUnverified\|bethel built$/,
    "the sentence is built from the translation key, not from English in the detector");
});

test("the fingerprint is the approval stamp, so marking it seen keeps it seen", () => {
  // fp:j.updated_at would resurrect the alert on every later edit to the
  // job -- a note, a schedule, a price. The moment this became true is
  // fixed, so the fingerprint is too.
  const j = bethelBuilt();
  assert.equal(detect(j)[0].fp, j.quote_approved_at);
  assert.notEqual(detect(j)[0].fp, j.updated_at);
});

// ------------------------------------------------- and it stays quiet

test("a paper signature settles it: no alert once signed_at is on the job", () => {
  const j = { ...bethelBuilt(), signed_at: "2026-10-09T18:20:00Z" };
  assert.deepEqual(detect(j), [],
    "a contract the contractor physically holds answers the question the phone check was asking");
});

test("PLANTED: drop the signed_at term and that same job falsely alerts", () => {
  // Proof the term has teeth. Without this the test above would pass on a
  // detector that never fires at all.
  const widened = DETECTOR_SOURCE.replace("&& j.quote_approved_at && !j.signed_at", "&& j.quote_approved_at");
  assert.notEqual(widened, DETECTOR_SOURCE, "the planted edit did not apply");
  const j = { ...bethelBuilt(), signed_at: "2026-10-09T18:20:00Z" };
  assert.equal(detect(j, { source: widened }).length, 1,
    "a too-wide detector nags about jobs that have a signature on file");
});

test("a checked approval raises nothing", () => {
  assert.deepEqual(detect({ ...bethelBuilt(), quote_approved_without_phone_check: false }), []);
});

test("an approval the drawing-change trigger has withdrawn raises nothing", () => {
  // supabase_reapproval_on_drawing_change.sql clears quote_approved_at when
  // the drawing moves. There is no approval standing, so there is nothing to
  // say about how it was checked; needs_reapproval covers that job instead.
  assert.deepEqual(detect({ ...bethelBuilt(), quote_approved_at: null }), []);
});

test("a finished or lost job raises nothing", () => {
  for (const status of ["COMPLETED", "DECLINED"]) {
    assert.deepEqual(detect({ ...bethelBuilt(), status }), [], status + " must stay quiet");
  }
});

test("muting the alert silences it, like every other alert in the list", () => {
  assert.deepEqual(detect(bethelBuilt(), { muted: true }), []);
});

// --------------------------------------------- wired into the page, once

test("the key is in ALERT_DEFS and in ALERT_SEVERITY, and in exactly one detector", () => {
  assert.match(src, /\{ key:'approved_unverified', labelKey:'alertApprovedUnverified' \}/,
    "Settings cannot offer a switch for an alert the registry does not list");
  assert.match(src, /approved_unverified: *'warn'/,
    "an alert with no severity sorts below housekeeping");
  const detectors = src.match(/alertOn\('approved_unverified'\)/g) ?? [];
  assert.equal(detectors.length, 1, "two detectors for one key means two rows for one job");
});

test("JOB_COLUMNS selects the column the detector reads", () => {
  // Left off the select it arrives undefined on every job, the filter is
  // false every time, and the alert quietly never fires -- an empty answer
  // that reads as good news.
  const defs = src.slice(src.indexOf("const JOB_COLUMNS = ["), src.indexOf("];", src.indexOf("const JOB_COLUMNS = [")));
  assert.match(defs, /'quote_approved_without_phone_check'/);
});

test("both new keys exist in all three language dictionaries", () => {
  // A key missing from one dictionary is a blank row in the alert list for a
  // reader in that language. Counted, not eyeballed, and never compared
  // against the English words.
  for (const key of ["alertApprovedUnverified", "alertTxtApprovedUnverified"]) {
    const n = (src.match(new RegExp("^\\s*" + key + ":", "gm")) ?? []).length;
    assert.equal(n, 3, key + " appears in " + n + " of the 3 dictionaries");
  }
});

test("the sentence carries exactly one placeholder, in every language", () => {
  const lines = src.match(/^\s*alertTxtApprovedUnverified:.*$/gm) ?? [];
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.equal((line.match(/%s/g) ?? []).length, 1,
      "tr() fills one argument here: " + line.trim());
  }
});
