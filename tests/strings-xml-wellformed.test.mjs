/**
 * Guards every file under every app/src/main/res/values(-xx) directory
 * against the two ways a strings file has actually broken the build or the
 * translated app.
 *
 * The first is silent to a human eye but fatal to the build: an XML comment
 * containing a double hyphen. XML forbids "--" inside a comment, and the
 * last wave shipped exactly that twice. mergeReleaseResources died, the R
 * class never regenerated, and every string reference in the app failed
 * with "unresolved reference" -- a hundred-plus errors that read like broken
 * Kotlin but were one bad comment. The strings track had "verified" its own
 * work by counting <string> tags, which cannot see a comment at all. This
 * file parses every resource file as real XML instead of counting tags, so
 * a malformed document -- an unterminated comment, a mismatched tag, a bad
 * entity, and specifically a double hyphen inside a comment -- is caught
 * before Gradle ever runs.
 *
 * The second is silent to the BUILD but not to a user: a resource name
 * present in one locale directory and missing from another. That compiles
 * cleanly -- nothing here depends on every locale carrying every key -- but
 * it is exactly how a screen ends up mixing English into an otherwise
 * translated sentence, which is the bug this whole wave exists to finish
 * fixing on the jobs list. The check compares the string/plurals resource
 * names collected from every file in one locale directory against every
 * other locale directory, not file-by-file: Android merges every XML file
 * within one such directory into a single flat resource namespace, so that
 * is the granularity that actually matters, not which physical file a key
 * happens to live in.
 *
 * Two more checks ride along because they are cheap once the file is
 * already being parsed and they are real ways this app has failed to build:
 * an unescaped apostrophe in a string's text (aapt refuses the build on
 * this for ANY string resource, not only ones with a %1$s placeholder in
 * them -- narrowing this check to "formatted" strings would wave through an
 * unescaped apostrophe in a plain string, which breaks the build exactly
 * the same way), and two resources of the same type sharing a name inside
 * one file (aapt's "resource already defined" error).
 *
 * Every one of the four checks is proven able to fail before it is trusted:
 * each has a case below that mutates a real, currently-passing file in a
 * throwaway scratch copy and asserts the checker turns red on it. A check
 * that has never been seen to fail has not been tested, only run.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " -- " + detail : ""}`); }
};

const RES_ROOT = "app/src/main/res";

// ---------------------------------------------------------------------
// A real (small, hand-written) XML parser. No dependency exists in this
// repo to reach for, and a regex cannot see the well-formedness rule that
// actually broke the build: that "--" may never appear inside a comment's
// content. This walks the document construct by construct -- comments,
// CDATA, tags, entities, text -- keeping a tag stack, and stops at the
// first construct that is not well-formed. That is enough to answer "is
// this a legal XML document", which is all this file needs; it is not a
// general-purpose XML library and does not try to be one.
// ---------------------------------------------------------------------
function lineOf(text, pos) {
  return text.slice(0, pos).split("\n").length;
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1]] = m[3] !== undefined ? m[3] : m[4];
  return attrs;
}

function parseValuesXml(text) {
  const errors = [];
  const entries = []; // { tag, name, raw, parent } for string/item/plurals
  const stack = [];
  let i = 0;
  const n = text.length;

  const fail = (msg, pos) => errors.push(`${msg} (line ${lineOf(text, pos)})`);

  while (i < n) {
    if (text.startsWith("<?", i)) {
      const end = text.indexOf("?>", i);
      if (end < 0) { fail("unterminated processing instruction", i); break; }
      i = end + 2;
      continue;
    }
    if (text.startsWith("<!--", i)) {
      const contentStart = i + 4;
      const end = text.indexOf("-->", contentStart);
      if (end < 0) { fail("unterminated XML comment", i); break; }
      const content = text.slice(contentStart, end);
      if (content.includes("--")) {
        fail(
          'XML comment contains "--", which XML forbids inside a comment ' +
            "and which is exactly what killed mergeReleaseResources last wave",
          i
        );
        break;
      }
      i = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", i)) {
      const end = text.indexOf("]]>", i);
      if (end < 0) { fail("unterminated CDATA section", i); break; }
      i = end + 3;
      continue;
    }
    if (/^<!DOCTYPE/i.test(text.slice(i, i + 9))) {
      const end = text.indexOf(">", i);
      if (end < 0) { fail("unterminated DOCTYPE declaration", i); break; }
      i = end + 1;
      continue;
    }
    if (text[i] === "<") {
      if (text[i + 1] === "/") {
        const end = text.indexOf(">", i);
        if (end < 0) { fail("unterminated closing tag", i); break; }
        const name = text.slice(i + 2, end).trim();
        if (stack.length === 0) { fail(`closing tag </${name}> with nothing open`, i); break; }
        const opened = stack[stack.length - 1];
        if (opened.name !== name) {
          fail(`closing tag </${name}> does not match the open <${opened.name}>`, i);
          break;
        }
        stack.pop();
        const parent = stack.length ? stack[stack.length - 1].name : null;
        if (opened.name === "string" || opened.name === "item") {
          entries.push({ tag: opened.name, name: opened.attrs.name, raw: text.slice(opened.contentStart, i), parent });
        } else if (opened.name === "plurals" && opened.attrs.name) {
          entries.push({ tag: "plurals", name: opened.attrs.name, raw: "", parent });
        }
        i = end + 1;
        continue;
      }
      const end = text.indexOf(">", i);
      if (end < 0) { fail("unterminated opening tag", i); break; }
      let body = text.slice(i + 1, end);
      let selfClosing = false;
      if (body.endsWith("/")) { selfClosing = true; body = body.slice(0, -1); }
      const nameMatch = body.match(/^[a-zA-Z_:][-a-zA-Z0-9_:.]*/);
      if (!nameMatch) { fail("malformed start tag", i); break; }
      const tagName = nameMatch[0];
      const attrs = parseAttrs(body.slice(tagName.length));
      if (selfClosing) {
        const parent = stack.length ? stack[stack.length - 1].name : null;
        if (tagName === "string" && attrs.name) entries.push({ tag: "string", name: attrs.name, raw: "", parent });
        else if (tagName === "plurals" && attrs.name) entries.push({ tag: "plurals", name: attrs.name, raw: "", parent });
      } else {
        stack.push({ name: tagName, attrs, contentStart: end + 1 });
      }
      i = end + 1;
      continue;
    }
    if (text[i] === "&") {
      const m = /^&(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/.exec(text.slice(i));
      if (!m) { fail('"&" is not part of a valid XML entity or character reference', i); break; }
    }
    i++;
  }
  if (!errors.length && stack.length) {
    fail(`<${stack[stack.length - 1].name}> is never closed`, i);
  }
  return { errors, entries };
}

// Only <string> and the quantity <item>s of a <plurals> carry translatable
// user-facing text. <style>/<color>/<dimen>/etc. are not translated content
// -- a locale directory missing them is normal (Android falls back to the
// default values/ directory for those automatically) -- so they are left
// out of both the apostrophe check and the cross-locale key comparison on
// purpose, rather than by omission.
function checkApostrophes(raw) {
  // An apostrophe in an Android string resource must be escaped with \' or
  // the whole (or part of the) value wrapped in double quotes -- aapt
  // refuses the build otherwise, for every string, not only ones carrying a
  // %1$s placeholder. A curly quote (U+2019, used throughout these files in
  // ordinary prose) is a different character and needs no escaping; this
  // only flags the literal ASCII apostrophe.
  let inQuote = false;
  const bad = [];
  for (let k = 0; k < raw.length; k++) {
    const c = raw[k];
    if (c === '"' && raw[k - 1] !== "\\") { inQuote = !inQuote; continue; }
    if (c === "'" && raw[k - 1] !== "\\" && !inQuote) bad.push(k);
  }
  return bad;
}

/**
 * Runs every check this file makes against one resource file's text and
 * returns a structured result. Used both on the real files below and on
 * the throwaway scratch copies the planted-failure cases mutate, so the
 * planted cases exercise the exact code path the real sweep does.
 */
function analyze(path, text) {
  const { errors, entries } = parseValuesXml(text);
  const apostropheProblems = [];
  const duplicates = [];
  const keys = [];
  if (!errors.length) {
    const seen = new Map();
    for (const e of entries) {
      if (e.name) {
        const k = `${e.tag}:${e.name}`;
        seen.set(k, (seen.get(k) ?? 0) + 1);
        keys.push(k);
      }
      if (e.tag === "string" || (e.tag === "item" && e.parent === "plurals")) {
        if (checkApostrophes(e.raw).length) {
          apostropheProblems.push(`${path}: <${e.tag} name="${e.name ?? ""}"> has an unescaped apostrophe`);
        }
      }
    }
    for (const [k, count] of seen) {
      if (count > 1) duplicates.push(`${path}: ${k} is defined ${count} times`);
    }
  }
  return { path, errors, keys, apostropheProblems, duplicates };
}

function readValuesXmlFiles() {
  const dirs = readdirSync(RES_ROOT).filter(
    (d) => d.startsWith("values") && statSync(join(RES_ROOT, d)).isDirectory()
  );
  const byLocale = {};
  for (const d of dirs) {
    byLocale[d] = readdirSync(join(RES_ROOT, d))
      .filter((f) => f.endsWith(".xml"))
      .map((f) => join(RES_ROOT, d, f));
  }
  return byLocale;
}

// ===========================================================================
// The real sweep
// ===========================================================================

const filesByLocale = readValuesXmlFiles();
console.log(`\nLocale directories found: ${Object.keys(filesByLocale).join(", ")}`);

ok("app/src/main/res has a base values/ directory to compare translations against",
   Array.isArray(filesByLocale["values"]) && filesByLocale["values"].length > 0);

const keysByLocale = {}; // locale -> Set("tag:name")
const keySourceFile = {}; // locale -> "tag:name" -> first file it was found in
let malformedCount = 0;
let apostropheFailCount = 0;
let duplicateFailCount = 0;

for (const [locale, files] of Object.entries(filesByLocale)) {
  keysByLocale[locale] = new Set();
  keySourceFile[locale] = {};
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    const result = analyze(path, text);
    ok(`${path} is well-formed XML`, result.errors.length === 0, result.errors.join("; "));
    if (result.errors.length) { malformedCount++; continue; }
    for (const k of result.keys) {
      keysByLocale[locale].add(k);
      keySourceFile[locale][k] ??= path;
    }
    for (const msg of result.duplicates) { console.log(`  FAIL  ${msg}`); fail++; duplicateFailCount++; }
    ok(`${path} defines no resource name twice`, result.duplicates.length === 0);
    for (const msg of result.apostropheProblems) { console.log(`  FAIL  ${msg}`); fail++; apostropheFailCount++; }
    ok(`${path} has every apostrophe escaped`, result.apostropheProblems.length === 0);
  }
}

// ---------------------------------------------------------------------------
// Known, pre-existing exception, named explicitly rather than skipped
// silently. strings_crew_scope.xml was added for the CREW/FOREMAN money-free
// sync door and has never had an es/fr counterpart -- its one key,
// access_manage_access_permission_name, is not user-facing prose (it is a
// permission's internal display name behind a screen those roles cannot
// reach) and was never translated on purpose. Naming the file here, instead
// of writing a comparison that only looks at files present in every locale,
// means the NEXT string that goes missing from a translation -- in this file
// or any other -- still gets caught, rather than silently joining this one
// under a blanket exemption.
// ---------------------------------------------------------------------------
const KNOWN_UNTRANSLATED_FILES = new Set(["strings_crew_scope.xml"]);

function baseName(path) {
  return path.split(/[\\/]/).pop();
}

const baseLocale = "values";
const baseKeys = keysByLocale[baseLocale] ?? new Set();

/**
 * Every base key missing from `localeKeys`, minus the ones whose only
 * source is a file named in KNOWN_UNTRANSLATED_FILES. Shared by the real
 * sweep below and by the planted-failure case that proves this exact
 * function actually notices a missing key, so the two can never quietly
 * drift apart.
 */
function unexplainedMissing(localeKeys) {
  return [...baseKeys]
    .filter((k) => !localeKeys.has(k))
    .filter((k) => !KNOWN_UNTRANSLATED_FILES.has(baseName(keySourceFile[baseLocale][k])));
}

for (const [locale, keys] of Object.entries(keysByLocale)) {
  if (locale === baseLocale) continue;
  const missing = [...baseKeys].filter((k) => !keys.has(k));
  const missingUnexplained = unexplainedMissing(keys);
  const missingKnown = missing.filter((k) => !missingUnexplained.includes(k));
  if (missingKnown.length) {
    console.log(`  ..   ${locale} is missing ${missingKnown.join(", ")}, allowed (source: ${[...new Set(missingKnown.map(k => keySourceFile[baseLocale][k]))].join(", ")})`);
  }
  ok(`${locale} has every ${baseLocale} key except the named exception`,
     missingUnexplained.length === 0,
     `missing: ${missingUnexplained.join(", ")}`);

  const extra = [...keys].filter((k) => !baseKeys.has(k));
  ok(`${locale} has no key that ${baseLocale} lacks`, extra.length === 0, `extra: ${extra.join(", ")}`);
}

// ===========================================================================
// Planted failures. Each proves the check above is load-bearing by mutating
// a real, currently-passing resource file in a throwaway scratch copy and
// showing the checker turns red on exactly that mutation. Nothing here
// touches the real repo files.
// ===========================================================================

console.log("\nPlanted failures (proving each check can fail):");

const scratchDir = mkdtempSync(join(tmpdir(), "strings-xml-wellformed-"));
try {
  // ---- 1. double hyphen inside an XML comment ----
  {
    const realPath = filesByLocale[baseLocale][0];
    const realText = readFileSync(realPath, "utf8");
    const brokenText = realText.replace(
      "<resources>",
      "<resources>\n    <!-- planted failure -- this comment illegally contains a double hyphen -->"
    );
    ok("PLANTED: a real base file was chosen to mutate for the comment case", brokenText !== realText);
    const scratchPath = join(scratchDir, "planted-double-hyphen.xml");
    writeFileSync(scratchPath, brokenText);
    const result = analyze(scratchPath, readFileSync(scratchPath, "utf8"));
    ok("PLANTED: a double hyphen inside a comment is caught",
       result.errors.length > 0 && result.errors.some((e) => e.includes("--")),
       `errors seen: ${JSON.stringify(result.errors)}`);
  }

  // ---- 2. an unterminated / mismatched tag (general malformed-XML case) ----
  {
    const brokenText = '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="x">Hello</strong>\n</resources>\n';
    const scratchPath = join(scratchDir, "planted-mismatched-tag.xml");
    writeFileSync(scratchPath, brokenText);
    const result = analyze(scratchPath, readFileSync(scratchPath, "utf8"));
    ok("PLANTED: a mismatched closing tag is caught", result.errors.length > 0,
       `errors seen: ${JSON.stringify(result.errors)}`);
  }

  // ---- 3. a key removed from a real locale file, in an actual scratch copy ----
  {
    // Pick an ordinary key: not the one key already excused by
    // KNOWN_UNTRANSLATED_FILES, or this planted removal would silently be
    // excused too and prove nothing.
    const candidateKey = [...baseKeys].find(
      (k) => k.startsWith("string:") &&
        !KNOWN_UNTRANSLATED_FILES.has(baseName(keySourceFile[baseLocale][k]))
    );
    const name = candidateKey.split(":")[1];
    const esFiles = filesByLocale["values-es"] ?? [];
    let targetFile = null;
    let targetText = null;
    const nameTagRe = new RegExp(`<string\\s+name="${name}"[^>]*>`);
    for (const f of esFiles) {
      const t = readFileSync(f, "utf8");
      if (nameTagRe.test(t)) { targetFile = f; targetText = t; break; }
    }
    ok("PLANTED: found the real values-es file that defines the chosen key",
       !!targetFile, `looked for ${name}`);

    const elementRe = new RegExp(`\\s*<string\\s+name="${name}"[^>]*>[\\s\\S]*?</string>`);
    const mutated = targetText.replace(elementRe, "");
    ok("PLANTED: the scratch mutation actually removed the <string> element",
       mutated !== targetText && !nameTagRe.test(mutated));
    writeFileSync(join(scratchDir, "planted-missing-key.xml"), mutated);

    // Recompute the values-es key set exactly as the real sweep does,
    // swapping in the mutated scratch copy for the one file it came from --
    // every other real es file is read unchanged.
    const mutatedEsKeys = new Set();
    for (const f of esFiles) {
      const text = f === targetFile ? mutated : readFileSync(f, "utf8");
      const { errors, entries } = parseValuesXml(text);
      if (errors.length) continue;
      for (const e of entries) if (e.name) mutatedEsKeys.add(`${e.tag}:${e.name}`);
    }
    const missingUnexplained = unexplainedMissing(mutatedEsKeys);
    ok("PLANTED: removing one key from a real values-es file's scratch copy is detected, and named",
       missingUnexplained.length === 1 && missingUnexplained[0] === candidateKey,
       `saw ${JSON.stringify(missingUnexplained)}`);
  }

  // ---- 4. an unescaped apostrophe in a string value ----
  {
    const brokenText = "It's fine";
    const fixedEscaped = "It\\'s fine";
    const fixedCurly = "It’s fine";
    const fixedQuoted = '"It\'s fine"';
    ok("PLANTED: an unescaped ASCII apostrophe is caught", checkApostrophes(brokenText).length > 0);
    ok("a backslash-escaped apostrophe passes", checkApostrophes(fixedEscaped).length === 0);
    ok("a curly apostrophe (different character) passes", checkApostrophes(fixedCurly).length === 0);
    ok("a double-quoted value passes without individual escaping", checkApostrophes(fixedQuoted).length === 0);
  }

  // ---- 5. a duplicate resource name within one file ----
  {
    const brokenText =
      '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n' +
      '    <string name="dup_test">First</string>\n' +
      '    <string name="dup_test">Second</string>\n</resources>\n';
    const scratchPath = join(scratchDir, "planted-duplicate.xml");
    writeFileSync(scratchPath, brokenText);
    const result = analyze(scratchPath, readFileSync(scratchPath, "utf8"));
    ok("PLANTED: a duplicate resource name in one file is caught",
       result.duplicates.length === 1 && result.duplicates[0].includes("dup_test"),
       `saw ${JSON.stringify(result.duplicates)}`);
  }
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`(${malformedCount} malformed file(s), ${apostropheFailCount} unescaped apostrophe(s), ${duplicateFailCount} in-file duplicate(s) found in the real tree)`);
if (fail) process.exit(1);
