// A call to a function that does not exist anywhere on the page.
//
// Parsing catches a typo in the syntax. It cannot catch a name. The QuickBooks
// export called netTotal(), a name that was renamed at some point and left
// behind here, so all three export buttons threw a ReferenceError before
// writing a single line and did nothing at all, with no message. The page
// parsed cleanly the whole time.
//
// This is deliberately conservative. It looks only at plain calls, never at a
// method call on an object, and it forgives everything the browser or a loaded
// library provides. A name that survives all of that is a real one.
import { readFileSync } from "node:fs";

const PAGES = ["dashboard", "admin", "index", "welcome", "quote", "lead"];

// Everything the browser hands the page, plus the two libraries these pages
// load from a tag. Anything not here has to be declared in the page itself.
const PROVIDED = new Set([
  // keywords that are followed by a parenthesis and so look like calls
  "if", "for", "while", "switch", "catch", "return", "typeof", "new", "await",
  "function", "else", "do", "throw", "case", "void", "delete", "in", "of",
  "yield", "import", "super", "this", "async",
  // language
  "Object", "Array", "String", "Number", "Boolean", "Math", "JSON", "Date",
  "Map", "Set", "WeakMap", "WeakSet", "Promise", "Error", "TypeError",
  "RangeError", "RegExp", "Intl", "BigInt", "Symbol", "Proxy", "Reflect",
  "parseInt", "parseFloat", "isNaN", "isFinite", "structuredClone",
  "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
  "Uint8Array", "Int8Array", "Float32Array", "Float64Array", "ArrayBuffer", "DataView",
  // browser
  "setTimeout", "setInterval", "clearTimeout", "clearInterval", "queueMicrotask",
  "requestAnimationFrame", "cancelAnimationFrame", "fetch", "alert", "confirm",
  "prompt", "console", "document", "window", "localStorage", "sessionStorage",
  "navigator", "location", "history", "URL", "URLSearchParams", "Blob", "File",
  "FileReader", "FormData", "Image", "Audio", "Notification", "Option",
  "atob", "btoa", "crypto", "AbortController", "TextEncoder", "TextDecoder",
  "MutationObserver", "IntersectionObserver", "ResizeObserver", "Event",
  "CustomEvent", "getComputedStyle", "matchMedia", "print", "open", "close",
  "addEventListener", "removeEventListener", "scrollTo", "postMessage",
  // libraries loaded by a script tag on these pages
  "supabase", "createClient", "google", "mermaid", "Chart",
]);

let failed = 0, checked = 0;

for (const page of PAGES) {
  const html = readFileSync(`website/${page}.html`, "utf8");
  const code = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .join("\n");

  // Strings and comments carry prose that looks like code. Blank them first,
  // or a sentence naming a function reads as a call to it.
  const bare = code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

  const declared = new Set();
  for (const m of bare.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of bare.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of bare.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  // Destructuring, imports and parameter lists all put a name in a binding
  // position. One sweep covers every one of them: a name is treated as known
  // if it is ever bound anywhere in the page, which is why this errs towards
  // silence rather than towards noise.
  for (const m of bare.matchAll(/[{,(]\s*([A-Za-z_$][\w$]*)\s*(?=[,}=):])/g)) declared.add(m[1]);
  // A method shorthand or an object key holding a function: `save(){...}`.
  for (const m of bare.matchAll(/([A-Za-z_$][\w$]*)\s*(?::\s*(?:async\s*)?(?:function|\())/g)) declared.add(m[1]);
  // Method shorthand inside an object or class: `tile(lat, lon, z) { ... }`.
  // This also matches `if (x) {`, which costs nothing: adding a keyword to the
  // declared set changes no answer, since keywords are forgiven anyway.
  for (const m of bare.matchAll(/([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g)) declared.add(m[1]);

  const unknown = new Set();
  for (const m of bare.matchAll(/(^|[^\w$.?])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (!declared.has(name) && !PROVIDED.has(name)) unknown.add(name);
  }

  checked++;
  if (unknown.size) {
    failed++;
    console.log(`FAIL ${page}.html calls something never defined: ${[...unknown].join(", ")}`);
  }
}

console.log(`${checked - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
