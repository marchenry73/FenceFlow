/**
 * Every language in the office console carries the same keys.
 *
 * The app's translation work was verified by counting rather than by trusting,
 * because this failure is silent: a key present in English and missing in
 * Spanish does not throw, it falls back, and that one label quietly reverts to
 * English. A Spanish-speaking manager sees a page mostly in their language with
 * English scattered through it, and nobody who reads English will ever notice.
 *
 * The fallback itself is deliberate and stays -- a blank label on a money
 * screen is worse than an English one. This guard is about knowing when that
 * fallback is carrying weight it was never meant to carry.
 */
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " -- " + detail : ""}`); }
};

const src = readFileSync("website/dashboard.html", "utf8");

// The table is extracted and evaluated rather than counted with a regex. A
// regex would miscount any key whose value contains a brace or an apostrophe,
// and French is full of apostrophes.
const start = src.indexOf("const TL = {");
if (start < 0) {
  console.log("  FAIL  the TL translation table is missing from dashboard.html");
  process.exit(1);
}
let depth = 0, end = -1;
for (let i = src.indexOf("{", start); i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
}
const TL = eval("(" + src.slice(src.indexOf("{", start), end) + ")");

const langs = Object.keys(TL);
console.log(`\nLanguages found: ${langs.join(", ")}`);

ok("English is present, so there is something to compare against",
   !!TL.en && Object.keys(TL.en).length > 0,
   `en has ${TL.en ? Object.keys(TL.en).length : 0} keys`);

const enKeys = Object.keys(TL.en).sort();

// PLANTED FAILURE: prove the comparison is load-bearing rather than vacuously
// true. Delete a key from a copy and it must be noticed.
{
  const broken = { ...TL.es };
  delete broken[enKeys[0]];
  const missing = enKeys.filter((k) => !(k in broken));
  ok("PLANTED FAILURE: deleting one Spanish key is detected (proves this check can fail)",
     missing.length === 1 && missing[0] === enKeys[0],
     `saw ${JSON.stringify(missing)}`);
}

for (const lang of langs) {
  if (lang === "en") continue;
  const keys = Object.keys(TL[lang]).sort();
  const missing = enKeys.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !enKeys.includes(k));
  ok(`${lang} has every English key`, missing.length === 0, `missing ${JSON.stringify(missing)}`);
  ok(`${lang} has no key English lacks`, extra.length === 0, `extra ${JSON.stringify(extra)}`);
  // A key that exists but was never actually translated is a different failure
  // from a missing one, and it reads as finished work when it is not.
  const same = enKeys.filter((k) => TL[lang][k] === TL.en[k] && String(TL.en[k]).length > 3);
  ok(`${lang} is not simply a copy of the English`, same.length < enKeys.length / 2,
     `${same.length} of ${enKeys.length} identical to English`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
