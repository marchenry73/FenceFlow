// The office page is one <script type="module">, and a module is parsed in
// strict mode. A plain-script syntax check passed a stray apostrophe that the
// browser refused, and the office sat on "Loading your office…" for a day and
// a half. This parses every page's inline scripts exactly as the browser will.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = 0, checked = 0;
for (const page of ["dashboard", "admin", "index", "welcome", "quote", "lead"]) {
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
}
console.log(`${checked - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
