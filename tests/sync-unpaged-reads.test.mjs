// §37: PostgREST returns at most 1000 rows per request and does not say so --
// see website/dashboard.html's own comment on this exact trap ("a throwaway
// view of three thousand rows answered one plain request with exactly a
// thousand, and the header read Content-Range: 0-999/* -- the star meaning
// the total is unknown"). dashboard.html was fixed: every read there goes
// through its `q()` helper, which pages with `.range()` in a loop until a
// short page comes back.
//
// The phone's own sync code was never given the same fix. This is a static
// check, not a database probe: it greps the two files that do every pull for
// every synced table -- EntitySync.kt and JobSync.kt -- for `.select {` calls,
// and checks each one is followed (before the next `.select {`/`.decodeList`
// boundary) by a `.range(` call the way dashboard.html's `q()` always is.
//
// Read-only, no network, no CLI needed -- this is a source check.
//
//   node tests/sync-unpaged-reads.test.mjs

import { readFileSync } from "node:fs";

let failed = 0, checked = 0;
const ok = (name, cond, detail = "") => {
  checked++;
  if (cond) { console.log(`  ok    ${name}`); return; }
  failed++;
  console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
};

// Finds every `.select {` call and reports whether a `.range(` appears
// between it and the next occurrence of `.select {` (or end of file) --
// mirroring how a real postgrest-kt chain reads: `.from(t).select{...}.order
// {...}.range(a,b)` before `.decodeList<...>()`.
function findUnpagedSelects(src) {
  const selectRe = /\.select\s*\{/g;
  const marks = [...src.matchAll(selectRe)].map(m => m.index);
  const unpaged = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i];
    const end = i + 1 < marks.length ? marks[i + 1] : src.length;
    const chunk = src.slice(start, end);
    const line = src.slice(0, start).split("\n").length;
    // `range(` inside the postgrest filter-builder lambda is a bare call on
    // the implicit receiver (no leading dot) -- pagedList's own definition
    // writes it that way. Match the word, not the dot, or that one correct
    // call gets misreported as unpaged.
    if (!/\brange\s*\(/.test(chunk)) unpaged.push(line);
  }
  return unpaged;
}

console.log("\n1. Canary -- prove the detector actually catches a paged call as paged,");
console.log("   and an unpaged one as unpaged (planted in a throwaway snippet, not a real file):");

const pagedSnippet = `
val cloud = client.postgrest.from("widgets")
    .select { filter { eq("company_id", companyId) } }
    .order("id")
    .range(from, from + 999)
    .decodeList<CloudWidget>()
`;
const unpagedSnippet = `
val cloud = client.postgrest.from("widgets")
    .select { filter { eq("company_id", companyId) } }
    .decodeList<CloudWidget>()
`;
ok("PLANTED paged call is recognized as paged (0 flagged)",
   findUnpagedSelects(pagedSnippet).length === 0);
ok("PLANTED unpaged call is recognized as unpaged (1 flagged) -- proves this check can fail",
   findUnpagedSelects(unpagedSnippet).length === 1,
   `got ${JSON.stringify(findUnpagedSelects(unpagedSnippet))}`);

console.log("\n2. The real files -- every `.select {` in EntitySync.kt and JobSync.kt,");
console.log("   the two files that pull every synced table onto a phone:");

for (const path of [
  "app/src/main/java/com/fenceestimator/app/cloud/EntitySync.kt",
  "app/src/main/java/com/fenceestimator/app/cloud/JobSync.kt",
]) {
  const src = readFileSync(path, "utf8");
  const unpaged = findUnpagedSelects(src);
  const total = [...src.matchAll(/\.select\s*\{/g)].length;
  ok(`${path}: no unpaged .select { read (found ${total} total reads)`,
     unpaged.length === 0,
     `${unpaged.length} of ${total} reads have no .range( anywhere before the next .select { -- ` +
     `lines ${unpaged.join(", ")} -- any one of these silently truncates at 1000 rows per company ` +
     `per table with no error, the exact trap dashboard.html's own comment describes and was fixed for`);
}

console.log(`\n${checked - failed} of ${checked} checks passed`);
if (failed) process.exit(1);
