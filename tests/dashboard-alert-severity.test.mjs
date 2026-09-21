// The office audit ("make the office show what matters") found the Needs
// Attention list and the daily briefing's Risks section had no severity
// ordering -- a critical alert (money already gone, a crew headed to an
// unready job, a legal deadline) could render many rows below routine
// housekeeping, distinguished only by a 3px border colour. This tests the
// real ordering/dismissal functions lifted out of dashboard.html (same
// grab()/new Function() idiom as tests/job-readiness.test.mjs and
// tests/per-foot-pay.test.mjs), not a re-implementation that could silently
// drift from what actually ships.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("website/dashboard.html", "utf8");

const grab = (name) => {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("not found: " + name);
  let i = src.indexOf("{", start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
};

const grabConst = (name) => {
  const marker = "const " + name + " =";
  const start = src.indexOf(marker);
  if (start < 0) throw new Error("not found: " + name);
  const end = src.indexOf(";\n", start);
  if (end < 0) throw new Error("no terminator for: " + name);
  return src.slice(start, end + 1);
};

// SEV_RANK is a plain object literal (grabConst's `;\n` terminator works on
// it directly); sortBySeverityThenAge/sortAttentionItems/sortBriefingLines
// are built on top of it, in the same order they appear in the real file.
const lib = new Function(`
  ${grabConst("SEV_RANK")}
  ${grab("sortBySeverityThenAge")}
  ${grabConst("sortAttentionItems")}
  ${grabConst("sortBriefingLines")}
  return { sortAttentionItems, sortBriefingLines };
`)();
const { sortAttentionItems, sortBriefingLines } = lib;

// ---------------------------------------------------------------- ordering

test("critical sorts before warn sorts before info, regardless of source order", () => {
  const items = [
    { key: "a", severity: "info" },
    { key: "b", severity: "critical" },
    { key: "c", severity: "warn" },
  ];
  const out = sortAttentionItems(items).map((it) => it.key);
  assert.deepEqual(out, ["b", "c", "a"]);
});

test("within one severity tier, older (by fp as a date) sorts first", () => {
  const items = [
    { key: "newer", severity: "critical", fp: "2026-09-20T00:00:00Z" },
    { key: "older", severity: "critical", fp: "2026-09-10T00:00:00Z" },
  ];
  const out = sortAttentionItems(items).map((it) => it.key);
  assert.deepEqual(out, ["older", "newer"]);
});

test("an fp that is not a parseable date falls back to original (stable) order, never throws", () => {
  const items = [
    { key: "first", severity: "info", fp: "3" },   // a plain count, e.g. pending_shifts
    { key: "second", severity: "info", fp: "7" },
  ];
  const out = sortAttentionItems(items).map((it) => it.key);
  assert.deepEqual(out, ["first", "second"]);
});

test("severity beats age -- a fresh critical item still sorts above an old warn item", () => {
  const items = [
    { key: "old-warn", severity: "warn", fp: "2020-01-01T00:00:00Z" },
    { key: "new-critical", severity: "critical", fp: "2026-09-20T00:00:00Z" },
  ];
  const out = sortAttentionItems(items).map((it) => it.key);
  assert.deepEqual(out, ["new-critical", "old-warn"]);
});

test("an item with no severity at all (should not happen, but must not throw) sorts as the lowest tier", () => {
  const items = [
    { key: "unknown" },
    { key: "critical", severity: "critical" },
  ];
  const out = sortAttentionItems(items).map((it) => it.key);
  assert.deepEqual(out, ["critical", "unknown"]);
});

test("PLANTED FAILURE: a comparator that ignores severity (age-only) fails this ordering", () => {
  const items = [
    { key: "old-info", severity: "info", fp: "2020-01-01T00:00:00Z" },
    { key: "new-critical", severity: "critical", fp: "2026-09-20T00:00:00Z" },
  ];
  const ageOnly = (list) =>
    [...list].sort((a, b) => new Date(a.fp) - new Date(b.fp));
  const wrong = ageOnly(items).map((it) => it.key);
  const right = sortAttentionItems(items).map((it) => it.key);
  assert.notDeepEqual(wrong, right, "an age-only sort should disagree with the real severity-first one");
  assert.deepEqual(right, ["new-critical", "old-info"]);
});

test("sortBriefingLines reads severity/fp off l.item, not off the line itself", () => {
  const lines = [
    { section: "risks", text: "quiet housekeeping", item: { severity: "info", fp: "2026-09-01T00:00:00Z" } },
    { section: "risks", text: "permit missing", item: { severity: "critical", fp: "2026-09-19T00:00:00Z" } },
    { section: "risks", text: "no item at all (a plain activity line)" },
  ];
  const out = sortBriefingLines(lines).map((l) => l.text);
  assert.deepEqual(out, ["permit missing", "quiet housekeeping", "no item at all (a plain activity line)"]);
});

test("sortBriefingLines returns the SAME objects, not clones -- allLines.indexOf(l) still works after sorting", () => {
  const lines = [
    { section: "risks", text: "a", item: { severity: "info", fp: "" } },
    { section: "risks", text: "b", item: { severity: "critical", fp: "" } },
  ];
  const sorted = sortBriefingLines(lines);
  for (const l of sorted) {
    assert.ok(lines.includes(l), `sorted line ${JSON.stringify(l)} must be identity-equal to one of the originals`);
  }
});

// ------------------------------------------------------- per-item dismissal

// dismissAlert/isAlertSeen touch localStorage, a `seenAlerts` module-level Map
// and a Supabase RPC -- rather than stub all three out of the real function
// (which would mostly be re-testing the stub), the identity rule itself is
// pulled directly off the file: `key:'<name>:'+id` at every push site, plus
// isAlertSeen's own key+fingerprint comparison, both grabbed as source text
// so a change to either is what this test actually watches.
test("every attention-item key in renderDash is built from a stable detector name and the row's own id/sync-id, never a shared constant", () => {
  const renderDashSrc = grab("renderDash");
  // Every `items.push({...})` call site that sets `key:`.
  const keyLiterals = [...renderDashSrc.matchAll(/key\s*:\s*'([a-z_]+):'\s*\+/g)].map((m) => m[1]);
  assert.ok(keyLiterals.length > 15, `expected many per-item keys, found ${keyLiterals.length}`);
  // No two detectors should share the same literal prefix -- that would mean
  // two different kinds of alert could collide on the same dismiss identity
  // for two different jobs that happen to share a sync id/employee id, which
  // is exactly the "dismissing one item dismisses a different one" failure
  // mode the brief is worried about.
  const dupes = keyLiterals.filter((k, i) => keyLiterals.indexOf(k) !== i);
  assert.deepEqual([...new Set(dupes)], [], `duplicate key prefixes: ${JSON.stringify([...new Set(dupes)])}`);
});

// isAlertSeen's own two dependencies (seenAlerts, loadSeenAlerts) are passed
// in as real-shaped stand-ins rather than pulling loadSeenAlerts's own source
// (which reaches into localStorage and profile.id, neither available under
// plain Node) -- the function under test is isAlertSeen itself, and its
// actual key+fingerprint comparison is exactly what this test watches.
const makeIsAlertSeen = (seenAlerts, localCache = new Map()) =>
  new Function(
    "seenAlerts", "loadSeenAlerts",
    grab("isAlertSeen") + "\nreturn isAlertSeen;"
  )(seenAlerts, () => localCache);

test("isAlertSeen compares BOTH key and fingerprint -- dismissing one job's alert does not hide the same alert re-appearing for a different job, or the same job after the fact changes", () => {
  const seenAlerts = new Map([["stale_quote:job-1", "2026-09-01T00:00:00Z"]]);
  const isAlertSeen = makeIsAlertSeen(seenAlerts);

  // Same key, same job, same fingerprint -> seen.
  assert.equal(isAlertSeen({ key: "stale_quote:job-1", fp: "2026-09-01T00:00:00Z" }), true);
  // Same key, DIFFERENT job (different fingerprint carried in the key string
  // itself -- job-2's stale_quote row has its own key) -> not seen. This is
  // the exact bug shape the brief names: dismissing one item must dismiss
  // only that one.
  assert.equal(isAlertSeen({ key: "stale_quote:job-2", fp: "2026-09-01T00:00:00Z" }), false);
  // Same job, same key, but the underlying fact changed (a new fingerprint,
  // e.g. the quote was re-sent) -> not seen, even though it was dismissed
  // once before.
  assert.equal(isAlertSeen({ key: "stale_quote:job-1", fp: "2026-09-15T00:00:00Z" }), false);
});

test("PLANTED FAILURE: comparing by key alone (dropping the fingerprint) would wrongly hide a different job's same-named alert", () => {
  const seenAlerts = new Map([["stale_quote:job-1", "2026-09-01T00:00:00Z"]]);
  // A deliberately wrong stand-in: keyed on the alert NAME only, exactly the
  // regression this test exists to catch if isAlertSeen ever loses the
  // fingerprint half of its comparison.
  const keyOnlyIsAlertSeen = (item) => seenAlerts.has(String(item.key).split(":")[0] + ":job-1");
  assert.equal(
    keyOnlyIsAlertSeen({ key: "stale_quote:job-2", fp: "2026-09-01T00:00:00Z" }),
    true,
    "the broken key-only version wrongly reports job-2's alert as seen"
  );
  // The real function must NOT make that mistake -- re-asserted here so this
  // planted-failure test fails loudly if the real one is ever weakened to
  // match the broken stand-in above.
  const isAlertSeen = makeIsAlertSeen(seenAlerts);
  assert.equal(isAlertSeen({ key: "stale_quote:job-2", fp: "2026-09-01T00:00:00Z" }), false);
});

// --------------------------------------------------- ALERT_SEVERITY doc map

test("ALERT_SEVERITY documents a value for every key in ALERT_DEFS, and only real severities", () => {
  const defsSrc = grabConst("ALERT_DEFS");
  const defs = new Function(defsSrc + "\nreturn ALERT_DEFS;")();
  const sevSrc = grabConst("ALERT_SEVERITY");
  const sev = new Function(sevSrc + "\nreturn ALERT_SEVERITY;")();
  const missing = defs.map((d) => d.key).filter((k) => !(k in sev));
  assert.deepEqual(missing, [], `ALERT_SEVERITY is missing: ${JSON.stringify(missing)}`);
  const bad = Object.entries(sev).filter(([, v]) => !["critical", "warn", "info"].includes(v));
  assert.deepEqual(bad, [], `not a real severity tier: ${JSON.stringify(bad)}`);
});
