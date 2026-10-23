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
// 4. And a page must not call a function that is defined on a DIFFERENT page.
//    admin.html called plainError(), which lives in dashboard.html: it parses,
//    it asks for no element, and it only fails when somebody triggers the
//    handler -- so two deployments went out with it. The check below asks only
//    whether a name called here, and not defined here, is defined on another
//    page; a name that exists in this project but on the wrong page is never a
//    browser API and never a parameter, it is the mistake itself.
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

const PAGES = ["dashboard", "admin", "index", "welcome", "quote", "lead", "fence-solutions/index"];
let failed = 0, checked = 0;

for (const page of PAGES) {
  const html = readFileSync(`website/${page}.html`, "utf8");
  // External module source for THIS page, concatenated onto the inline
  // id/lookup sweeps below so a split (website/js/...) does not silently drop
  // out of what this harness scans. See docs/OFFICE_SPLIT_PLAN.md -- step 1 of
  // the split was exactly this: extend the harness BEFORE any code moves.
  let externalModuleSrc = "";

  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
    // A data block (search-engine JSON-LD) is never executed by a browser, so
    // parsing it as a script would fail a page that is perfectly fine.
    if (/type\s*=\s*["']application\/(ld\+)?json["']/i.test(m[1])) continue;
    const isModule = /type\s*=\s*["']module["']/.test(m[1]);
    const f = join(tmpdir(), `ff-syntax-${page.replaceAll("/", "-")}-${checked}.${isModule ? "mjs" : "js"}`);
    writeFileSync(f, m[2]);
    checked++;
    try { execFileSync("node", ["--check", f], { stdio: "pipe" }); }
    catch (e) {
      failed++;
      const msg = e.stderr.toString().split("\n").slice(0, 4).join("\n");
      console.log(`FAIL ${page}.html (${isModule ? "module" : "script"}): ${msg}`);
    }
  }

  // <script type="module" src="js/...."></script> -- externalized code.
  // node --check it on its own (it is a standalone module file) and fold its
  // source into the id/lookup sweeps below.
  for (const m of html.matchAll(/<script[^>]*\btype\s*=\s*["']module["'][^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/g)) {
    const relPath = m[1];
    if (/^https?:|^\/\//.test(relPath)) continue; // CDN import, not ours
    const abs = join("website", relPath);
    let modSrc;
    try { modSrc = readFileSync(abs, "utf8"); }
    catch { failed++; checked++; console.log(`FAIL ${page}.html: script src="${relPath}" does not exist on disk`); continue; }
    externalModuleSrc += "\n" + modSrc;
    const f = join(tmpdir(), `ff-syntax-ext-${checked}.mjs`);
    writeFileSync(f, modSrc);
    checked++;
    try { execFileSync("node", ["--check", f], { stdio: "pipe" }); }
    catch (e) {
      failed++;
      const msg = e.stderr.toString().split("\n").slice(0, 4).join("\n");
      console.log(`FAIL ${relPath} (module, referenced from ${page}.html): ${msg}`);
    }
  }

  // Ids the markup defines, against ids the script looks up. Only literal
  // lookups are checked: anything built from a variable is the page's own
  // business and cannot be resolved from here.
  const defined = new Set([...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map(x => x[1]));
  const combinedSrc = html + externalModuleSrc;
  const asked = new Set([
    ...[...combinedSrc.matchAll(/\$\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)].map(x => x[1]),
    ...[...combinedSrc.matchAll(/getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)].map(x => x[1]),
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

// ===========================================================================
// 4. A FUNCTION CALLED ON THE WRONG PAGE.
//
// Collected per page: what it DEFINES (function f, const f = (..) =>, class f)
// and what it CALLS. Then, for each page, any name it calls but does not
// define, which some OTHER page defines, is reported. See the header for why
// the question is asked this narrowly.
// ===========================================================================
{
  const sourceOf = (page) => {
    const html = readFileSync(`website/${page}.html`, "utf8");
    let src = "";
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/type\s*=\s*["']application\/(ld\+)?json["']/i.test(m[1])) continue;
      src += "\n" + m[2];
    }
    for (const m of html.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/g)) {
      const rel = m[1];
      if (/^https?:|^\/\//.test(rel)) continue;
      try { src += "\n" + readFileSync(join("website", rel), "utf8"); } catch { /* reported elsewhere */ }
    }
    return src;
  };

  // MINIFIED BUNDLES OUT FIRST. quote.html and dashboard.html embed minified
  // third-party code, where every local is one or two letters -- At, It, c, i,
  // w, x, y, z -- and "defined on another page" is true of dozens of them by
  // coincidence. Hand-written source in this project is wrapped; a minified
  // bundle is one enormous line, so dropping lines over 400 characters removes
  // the bundles and keeps everything anybody typed.
  const unminified = (src) => src.split("\n").filter((l) => l.length <= 400).join("\n");

  // Comments and strings out before anything is counted: a function name
  // mentioned in a sentence is not a call, and this file's own history is
  // full of checks that read a comment as code.
  const bare = (src) => unminified(src)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

  const defines = (src) => {
    const out = new Set();
    for (const re of [
      /\bfunction\s+([A-Za-z_$][\w$]*)/g,
      /\bclass\s+([A-Za-z_$][\w$]*)/g,
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\()/g,
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/g,
      // PARAMETERS. say() is the fifth parameter of
      // accessRequestAttention(requests, jobFor, whoFor, jobName, say, goneName)
      // -- a callback, which welcome.html happens to have a function of the
      // same name for. Counting parameters over-collects a little (a parameter
      // named plainError would mask the real thing) and that is the right way
      // round: a gate that cries wolf is a gate nobody reads.
      /\bfunction\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g,
      /\(([^)]*)\)\s*=>/g,
      // A SINGLE parameter with no parentheses: new Promise(res=>{...}) binds
      // res the same way, and quote.html does exactly that for its tile loads.
      /\b([A-Za-z_$][\w$]*)\s*=>/g,
      // imported, or destructured out of an import
      /\bimport\s*\{([^}]*)\}/g,
    ]) {
      for (const m of src.matchAll(re)) {
        for (const part of m[1].split(",")) {
          // THE LAST IDENTIFIER IN THE PART, which handles every shape a
          // parameter list throws at this: "(resolve" (the opening paren of
          // new Promise((resolve, reject)=>) is swept into the first part),
          // "a = 1" (a default), "...rest", "{ x" and "y }"
          // (destructuring), and "x as y" (an import alias).
          const name = ((part.split("=")[0] || "").match(/([A-Za-z_$][\w$]*)\s*$/) || [])[1];
          if (name) out.add(name);
        }
      }
    }
    return out;
  };

  // A call: `name(` not preceded by a dot (that is a method) and not the
  // declaration itself.
  const calls = (src) => {
    const out = new Set();
    for (const m of src.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const before = src.slice(Math.max(0, m.index - 12), m.index + m[1].length);
      if (/\b(function|class|new|typeof|return|catch|if|for|while|switch)\s*$/.test(before)) continue;
      out.add(m[2]);
    }
    return out;
  };

  const srcs = {}, defs = {}, uses = {};
  for (const page of PAGES) {
    const b = bare(sourceOf(page));
    srcs[page] = b;
    defs[page] = defines(b);
    uses[page] = calls(b);
  }

  // CONTROL FIRST: the collectors found something on the page this check was
  // written for. An empty set would make every page pass for nothing.
  checked++;
  if (defs.dashboard.size > 50 && uses.admin.size > 50) {
    console.log(`  ok    the collectors read the pages (dashboard defines ${defs.dashboard.size}, admin calls ${uses.admin.size})`);
  } else {
    failed++;
    console.log(`FAIL the collectors found almost nothing (dashboard defines ${defs.dashboard.size}, admin calls ${uses.admin.size}) -- the check below would pass vacuously`);
  }

  for (const page of PAGES) {
    const strays = [...uses[page]]
      .filter((n) => !defs[page].has(n))
      .filter((n) => PAGES.some((other) => other !== page && defs[other].has(n)))
      .sort();
    checked++;
    if (!strays.length) {
      console.log(`  ok    ${page}.html calls nothing that lives on another page`);
    } else {
      failed++;
      console.log(`FAIL ${page}.html calls ${strays.length} function(s) defined on another page, not on it: ` +
        strays.map((n) => `${n}() [${PAGES.filter((o) => o !== page && defs[o].has(n)).join(", ")}]`).join("; "));
    }
  }

  // CANARY: the check must be able to fail. plainError in admin.html is the
  // real incident, replayed against the collectors rather than against the
  // file, so the canary cannot rot when the file is fixed.
  checked++;
  const fakeAdmin = calls(bare("function onlyHere(){ plainError('x'); }"));
  const fakeDash = defines(bare("function plainError(t){ return t; }"));
  const caught = [...fakeAdmin].filter((n) => !defines(bare("function onlyHere(){}")).has(n) && fakeDash.has(n));
  if (caught.length === 1 && caught[0] === "plainError") {
    console.log("  ok    CANARY: a call to a function defined only on another page is detected");
  } else {
    failed++;
    console.log(`FAIL CANARY: the cross-page check did not detect the real incident (caught ${JSON.stringify(caught)})`);
  }
}

console.log(`${checked - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
