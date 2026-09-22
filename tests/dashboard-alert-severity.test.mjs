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
// isAlertSeen's own per-key comparison, both grabbed as source text
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
// plain Node) -- the functions under test are isAlertSeen and the snooze
// helpers it is built on, lifted verbatim, and the stored values below are
// built exactly the way dismissAlert() builds them.
const makeSeenLib = (seenAlerts, localCache = new Map()) =>
  new Function(
    "seenAlerts", "loadSeenAlerts",
    [grabConst("ALERT_SNOOZE_MS"), grabConst("ALERT_SNOOZE_SKEW_MS"),
     grab("alertFpToken"), grab("parseSeenStamp"), grab("alertSeenUntil"), grab("isAlertSeen")].join("\n")
    + "\nreturn { isAlertSeen, alertSeenUntil, alertFpToken, parseSeenStamp, ALERT_SNOOZE_MS };"
  )(seenAlerts, () => localCache);
const makeIsAlertSeen = (seenAlerts, localCache) => makeSeenLib(seenAlerts, localCache).isAlertSeen;

// The value dismissAlert() stores: '@' + the moment Seen was pressed + '|' +
// the fingerprint token. Rebuilt here from the page's own alertFpToken so a
// change to the stored shape is a change this test sees.
const DISMISS_SRC = grab("dismissAlert");
const HOUR = 36e5;
const T0 = Date.parse("2026-09-21T12:00:00Z");
const stampAt = (fp, at) => "@" + at + "|" + makeSeenLib(new Map()).alertFpToken(fp);

test("dismissAlert stores the time as well as the fingerprint, through the RPC that already exists", () => {
  assert.match(DISMISS_SRC, /const stamp = '@' \+ Date\.now\(\) \+ '\|' \+ alertFpToken\(fp\)/);
  assert.match(DISMISS_SRC, /db\.rpc\('mark_alert_seen', \{ alert_key: key, fingerprint: stamp \}\)/);
});

test("isAlertSeen is per key -- dismissing one job's alert does not hide the same alert on a different job", () => {
  const seenAlerts = new Map([["stale_quote:job-1", stampAt("2026-09-01T00:00:00Z", T0)]]);
  const isAlertSeen = makeIsAlertSeen(seenAlerts);
  const now = T0 + HOUR;

  // Same key, same job, inside the snooze -> seen.
  assert.equal(isAlertSeen({ key: "stale_quote:job-1", fp: "2026-09-01T00:00:00Z" }, now), true);
  // Same detector, DIFFERENT job -- job-2's stale_quote row has its own key
  // -> not seen. This is the exact bug shape the brief names: dismissing one
  // item must dismiss only that one.
  assert.equal(isAlertSeen({ key: "stale_quote:job-2", fp: "2026-09-01T00:00:00Z" }, now), false);
});

// The owner: "if I dismiss it, don't show it again for at least 3 hrs". Eleven
// detectors fingerprint on the job's updated_at, which any write moves -- a
// save on the job sheet, a phone sync, a payment webhook, the customer
// opening the quote. The snooze used to require the fingerprint to still
// match, so each of those brought a dismissed alert back inside the three
// hours. It no longer reads the fingerprint at all.
test("inside the three hours a changed fingerprint (an updated_at-only write) does NOT bring a dismissed alert back", () => {
  const item = { key: "no_deposit:42", fp: "2026-09-21T11:00:00.000Z" };           // jobs.updated_at when Seen was pressed
  const touched = { ...item, fp: "2026-09-21T12:20:00.000Z" };                       // the same job, saved twenty minutes later
  const lib = makeSeenLib(new Map([[item.key, stampAt(item.fp, T0)]]));
  assert.equal(lib.isAlertSeen(touched, T0 + 20 * 60e3), true, "twenty minutes in, after the job was saved");
  assert.equal(lib.isAlertSeen(touched, T0 + 2.9 * HOUR), true, "still inside three hours");
  assert.equal(lib.alertSeenUntil(touched, T0), T0 + 3 * HOUR, "the snooze runs from the press, not from the fingerprint");
  // After the window it shows again while it is still true, fingerprint
  // changed or not -- a snooze, not a permanent dismissal.
  assert.equal(lib.isAlertSeen(touched, T0 + 3 * HOUR), false);
  assert.equal(lib.isAlertSeen(item, T0 + 3 * HOUR), false);
});

test("PLANTED FAILURE: the old fingerprint-matching snooze resurfaces that alert inside three hours; the real one does not", () => {
  const item = { key: "field_change:7", fp: "2026-09-21T11:00:00.000Z" };
  const touched = { ...item, fp: "2026-09-21T11:45:00.000Z" };
  const lib = makeSeenLib(new Map([[item.key, stampAt(item.fp, T0)]]));
  const stored = new Map([[item.key, stampAt(item.fp, T0)]]);
  // The rule as it was: hidden only while the stored fingerprint still matches.
  const oldRule = (it, now) => {
    const s = lib.parseSeenStamp(stored.get(it.key));
    return !!s && s.fp === lib.alertFpToken(it.fp) && now < s.at + lib.ALERT_SNOOZE_MS;
  };
  const now = T0 + HOUR;
  assert.equal(oldRule(touched, now), false, "the old rule shows it again an hour after Seen, just because the job was saved");
  assert.equal(oldRule(item, now), true, "(and agrees with the real one while nothing changed, so it is the fingerprint talking)");
  assert.equal(lib.isAlertSeen(touched, now), true, "the real function keeps it hidden");
});

test("Seen is a three-hour snooze: hidden until then, back afterwards if the alert still fires", () => {
  const item = { key: "no_deposit:42", fp: "2026-09-20T08:00:00Z" };
  const lib = makeSeenLib(new Map([[item.key, stampAt(item.fp, T0)]]));
  assert.equal(lib.ALERT_SNOOZE_MS, 3 * HOUR);
  assert.equal(lib.isAlertSeen(item, T0), true, "just pressed");
  assert.equal(lib.isAlertSeen(item, T0 + 2.9 * HOUR), true, "still inside three hours");
  assert.equal(lib.isAlertSeen(item, T0 + 3 * HOUR), false, "three hours up -- shows again");
  assert.equal(lib.isAlertSeen(item, T0 + 30 * HOUR), false, "and stays shown");
  assert.equal(lib.alertSeenUntil(item, T0), T0 + 3 * HOUR);
});

test("a dismissal stored in the old shape (bare fingerprint, no time) counts as expired", () => {
  const item = { key: "stale_quote:job-1", fp: "2026-09-01T00:00:00Z" };
  const isAlertSeen = makeIsAlertSeen(new Map([[item.key, item.fp]]), new Map([[item.key, item.fp]]));
  assert.equal(isAlertSeen(item, T0), false);
});

test("the later of the server row and this browser's cache wins", () => {
  const item = { key: "labour_over:7", fp: "x" };
  const server = new Map([[item.key, stampAt("x", T0)]]);
  const local = new Map([[item.key, stampAt("x", T0 + 2 * HOUR)]]);
  const isAlertSeen = makeIsAlertSeen(server, local);
  assert.equal(isAlertSeen(item, T0 + 4 * HOUR), true, "the local dismissal two hours later still holds");
  assert.equal(isAlertSeen(item, T0 + 5 * HOUR), false);
});

test("a dismissal time far in the future (another clock) is not trusted to hide the alert", () => {
  const item = { key: "job_overrun:9", fp: "DONE|2026-09-01" };
  const isAlertSeen = makeIsAlertSeen(new Map([[item.key, stampAt(item.fp, T0 + 24 * HOUR)]]));
  assert.equal(isAlertSeen(item, T0), false);
});

test("a fingerprint longer than the RPC keeps still leaves a stamp that survives the round trip", () => {
  const longFp = "2026-09-25T08:00:00Z|" + Array(20).fill("Prices confirmed with a supplier").join(",");
  const item = { key: "scheduled_but_blocked:3", fp: longFp };
  // mark_alert_seen stores left(fingerprint, 200) -- the stored value must
  // survive that cut intact.
  const stored = stampAt(longFp, T0);
  assert.ok(stored.length <= 200, `stored value is ${stored.length} chars`);
  const isAlertSeen = makeIsAlertSeen(new Map([[item.key, stored.slice(0, 200)]]));
  assert.equal(isAlertSeen(item, T0 + HOUR), true);
});

test("PLANTED FAILURE: matching on the detector name alone (dropping the row id) would wrongly hide a different job's same-named alert", () => {
  const seenAlerts = new Map([["stale_quote:job-1", stampAt("2026-09-01T00:00:00Z", T0)]]);
  // A deliberately wrong stand-in: keyed on the alert NAME only, exactly the
  // regression this test exists to catch if isAlertSeen ever loses the
  // row-id half of the key. (The fingerprint is not part of the identity any
  // more -- see the three-hour tests above -- so the key is all there is.)
  const keyOnlyIsAlertSeen = (item) => seenAlerts.has(String(item.key).split(":")[0] + ":job-1");
  assert.equal(
    keyOnlyIsAlertSeen({ key: "stale_quote:job-2", fp: "2026-09-01T00:00:00Z" }),
    true,
    "the broken key-only version wrongly reports job-2's alert as seen"
  );
  // The real function must NOT make that mistake -- re-asserted here so this
  // planted-failure test fails loudly if the real one is ever weakened to
  // match the broken stand-in above.
  // Inside the snooze, so a false here is the key check talking, not the
  // three hours having run out.
  const isAlertSeen = makeIsAlertSeen(seenAlerts);
  assert.equal(isAlertSeen({ key: "stale_quote:job-1", fp: "2026-09-01T00:00:00Z" }, T0 + HOUR), true);
  assert.equal(isAlertSeen({ key: "stale_quote:job-2", fp: "2026-09-01T00:00:00Z" }, T0 + HOUR), false);
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
