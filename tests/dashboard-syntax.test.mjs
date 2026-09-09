// Two ways this page has actually broken, both checked here.
//
// 1. The office page is one <script type="module">, and a module is parsed in
//    strict mode. A plain-script syntax check passed a stray apostrophe that
//    the browser refused, and the office sat on "Loading your office…" for a
//    day and a half. This parses every page's inline scripts exactly as the
//    browser will.
//
// 2. The scripts reach for elements by id at the top level, so a single
//    `$('typo')` returning null throws before anything renders and leaves the
//    same blank page -- with no syntax error to find. Every id the script
//    asks for has to exist in the markup of the page that asks for it.
//
// 3. And it has to exist exactly once. A second element with the same id is
//    legal HTML that no browser complains about: getElementById simply returns
//    the first one, so a panel writes its rows into a different panel's table
//    and both look plausible. That is precisely what happened when a new pay
//    table reused `payRows`, already taken by the payments table -- the check
//    above passed, because the id did exist.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAGES = ["dashboard", "admin", "index", "welcome", "quote", "lead"];
let failed = 0, checked = 0;

for (const page of PAGES) {
  const html = readFileSync(`website/${page}.html`, "utf8");

  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
    const isModule = /type\s*=\s*["']module["']/.test(m[1]);
    const f = join(tmpdir(), `ff-syntax-${page}-${checked}.${isModule ? "mjs" : "js"}`);
    writeFileSync(f, m[2]);
    checked++;
    try { execFileSync("node", ["--check", f], { stdio: "pipe" }); }
    catch (e) {
      failed++;
      const msg = e.stderr.toString().split("\n").slice(0, 4).join("\n");
      console.log(`FAIL ${page}.html (${isModule ? "module" : "script"}): ${msg}`);
    }
  }

  // Ids the markup defines, against ids the script looks up. Only literal
  // lookups are checked: anything built from a variable is the page's own
  // business and cannot be resolved from here.
  const defined = new Set([...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map(x => x[1]));
  const asked = new Set([
    ...[...html.matchAll(/\$\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)].map(x => x[1]),
    ...[...html.matchAll(/getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)].map(x => x[1]),
  ]);
  const missing = [...asked].filter(id => !defined.has(id));
  checked++;
  if (missing.length) {
    failed++;
    console.log(`FAIL ${page}.html: script looks up ids the markup never defines: ${missing.join(", ")}`);
  }

  // Duplicates, counted in the static markup only. Ids written inside a
  // <script> belong to templates that replace whole screens, so two of them
  // never exist at once and flagging them would train everyone to ignore this.
  const markupOnly = html.replace(/<script[\s\S]*?<\/script>/g, "");
  const seen = new Map();
  for (const m of markupOnly.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)) {
    seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  const dupes = [...seen].filter(([, n]) => n > 1).map(([id, n]) => `${id} (${n})`);
  checked++;
  if (dupes.length) {
    failed++;
    console.log(`FAIL ${page}.html: the same id used more than once: ${dupes.join(", ")}`);
  }
}

console.log(`${checked - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
