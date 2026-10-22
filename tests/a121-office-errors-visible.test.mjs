// A121 -- an office error is never hidden by a filter it cannot satisfy.
//
// Run with:  node --test tests/a121-office-errors-visible.test.mjs
//
// The office web app files its technical failures to app_errors, the same
// table the phone reports crashes to. Right place, one wrong consequence: an
// office row carries no version_code and 'office' as its name, so the build
// comparison reads 0 for it and "still happening on 1.708" is false for ever.
// With that box ticked -- the useful way to read the screen, and the way
// somebody hunting a live problem would read it -- every office error was
// hidden. The log added so a refusal could be diagnosed was invisible behind
// the filter you would be using when you went looking.
//
// Source checks: the page is not executed here. Each is paired with a canary.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ADMIN = readFileSync(new URL("../website/admin.html", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../website/dashboard.html", import.meta.url), "utf8");

function region(src, from, to) {
  const i = src.indexOf(from);
  assert.ok(i !== -1, `landmark gone: ${from}`);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j !== -1, `landmark gone: ${to}`);
  return src.slice(i, j);
}

test("the office still files its failures under the name this screen looks for", () => {
  // If the office stops writing version_name 'office', every check below is
  // guarding a condition that can no longer occur.
  const fn = region(PAGE, "function reportOfficeError(kind, raw)", "function whoAmI()");
  assert.match(fn, /version_name: 'office'/,
    "the office no longer stamps its rows 'office', so the console cannot tell them apart");
});

test("a group is marked as office only when every row in it is", () => {
  const fn = region(ADMIN, "g.fatal = rows.some(r => r.fatal);", "const count = new Map()");
  assert.match(fn, /g\.office = rows\.every\(r => r\.version_name === 'office'\)/,
    "the office marker is gone, or uses some() -- a signature seen on BOTH the phone and the office is a phone crash that also happens in the browser, and must keep being judged against its build");
});

test("the build filter cannot hide an office error", () => {
  const fn = region(ADMIN, "const shown = cur && crashCurrentOnly", "if (!shown.length)");
  assert.match(fn, /g\.onCurrent \|\| g\.office/,
    "office errors are filtered out again by a build comparison they can never satisfy");
});

test("it says which it is, rather than showing a build nobody can find", () => {
  const fn = region(ADMIN, "const buildPill = c.office", "return `<div class=\"crash-row");
  assert.match(fn, /crashPillOffice/, "the office pill is gone");
  assert.match(ADMIN, /const versions = c\.office \? tr\('crashPillOffice'\)/,
    "the version column still prints 'office' as if it were a build number");
});

test("the new word exists in all three languages", () => {
  const n = ADMIN.split("crashPillOffice:").length - 1;
  assert.equal(n, 3, `crashPillOffice appears in ${n} locales, expected 3`);
});

// ---------------------------------------------------------------- canaries

test("CANARY: the build comparison really does read zero for an office row", () => {
  // The same expression the console uses.
  const codeOf = (name) => { const m = /(\d+)\s*$/.exec(String(name || "")); return m ? Number(m[1]) : 0; };
  assert.equal(codeOf("office"), 0, "'office' no longer reads as 0, so this whole class of bug has moved");
  assert.equal(codeOf("1.708"), 708, "a real version name stopped parsing, which would break the filter for phones");
  assert.ok(!(codeOf("office") >= 708),
    "an office row would now satisfy the current-build filter on its own, and these checks guard nothing");
});

test("CANARY: every() rejects a mixed group, some() would not", () => {
  const rows = [{ version_name: "office" }, { version_name: "1.708" }];
  assert.equal(rows.every((r) => r.version_name === "office"), false, "a mixed group was called office-only");
  assert.equal(rows.some((r) => r.version_name === "office"), true,
    "the canary did not reproduce the difference between every and some");
});
