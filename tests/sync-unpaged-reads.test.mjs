// §37: PostgREST returns at most 1000 rows per request and does not say so --
// see website/dashboard.html's own comment on this exact trap ("a throwaway
// view of three thousand rows answered one plain request with exactly a
// thousand, and the header read Content-Range: 0-999/* -- the star meaning
// the total is unknown"). dashboard.html was fixed: every read there goes
// through its `q()` helper, which pages with `.range()` in a loop until a
// short page comes back.
//
// The phone's own cloud reads were never given the same fix. This is a static
// check, not a database probe: it greps the files that read whole tables out
// of the cloud for `.select` calls, and checks each one is followed (before
// the read is decoded) by a `.range(` call the way dashboard.html's `q()`
// always is.
//
// WHAT CHANGED, AND WHY IT MATTERED
//
// The first version of this file matched only `\.select\s*\{` -- the
// brace-lambda form. postgrest-kt has a second, equally common form:
//
//     .select(Columns.list("sync_id", "deleted_at")) { filter { ... } }
//
// A read written that way was not merely unchecked, it was INVISIBLE: the
// detector found no `.select {` in it, reported "0 unpaged reads", and the
// file printed ok. An empty answer read as good news. Two real call sites use
// that form -- EntitySync.tombstonedSyncIds and TrashBin.list -- and one of
// them is unpaged, so the blind spot was hiding a live bug, not a hypothetical
// one. Canary 3 below plants that exact shape and asserts the OLD pattern
// cannot see it, so the reason this widening exists cannot quietly rot away.
//
// The chunk boundary was tightened at the same time. The comment always said
// "before the next `.select {`/`.decodeList` boundary" but the code only ever
// cut at the next `.select`, so a `range(` belonging to some later, unrelated
// statement could vouch for an unpaged read above it. Canary 5 plants that.
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

// Both call shapes postgrest-kt offers:
//   .select { filter { ... } }                       -- whole row
//   .select(Columns.list("a","b")) { filter { ... } } -- named columns
// A narrower pattern does not make the second kind safe, it makes it silent.
const SELECT_ANY = /\.select\s*[({]/g;
// The pattern this file used to carry, kept only so canary 3 can prove the
// widening was load-bearing rather than cosmetic.
const SELECT_BRACE_ONLY = /\.select\s*\{/g;

/**
 * Every `.select` call that has no `.range(` before the read is decoded.
 *
 * The window examined for each call starts at the `.select` and ends at
 * whichever comes FIRST: the next `.select`, or the `.decodeList`/`.decode*`
 * that consumes this one. Ending at the decode matters -- the row limit is
 * applied by the request, so a `range(` appearing after the rows have already
 * come back belongs to some other statement and vouches for nothing.
 */
function findUnpagedSelects(src, selectRe = SELECT_ANY) {
  const marks = [...src.matchAll(new RegExp(selectRe.source, "g"))].map(m => m.index);
  const unpaged = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i];
    const nextSelect = i + 1 < marks.length ? marks[i + 1] : src.length;
    // `.decodeList<T>()`, `.decodeSingle<T>()`, `.decodeAs<T>()` -- the point
    // at which this request has already been sent and answered.
    const decodeAt = src.slice(start, nextSelect).search(/\.decode[A-Za-z]*\s*[<(]/);
    const end = decodeAt >= 0 ? start + decodeAt : nextSelect;
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

console.log("\n1. Canaries -- prove the detector catches what it claims to, and that");
console.log("   the widened pattern sees a shape the old one could not");
console.log("   (planted in throwaway snippets, never in a real file):");

const pagedBrace = `
val cloud = client.postgrest.from("widgets")
    .select { filter { eq("company_id", companyId) } }
    .order("id")
    .range(from, from + 999)
    .decodeList<CloudWidget>()
`;
const unpagedBrace = `
val cloud = client.postgrest.from("widgets")
    .select { filter { eq("company_id", companyId) } }
    .decodeList<CloudWidget>()
`;
// The shape the old pattern was blind to, both ways round.
const pagedColumns = `
val cloud = client.postgrest.from("widgets")
    .select(Columns.list("sync_id", "deleted_at")) {
        filter { eq("company_id", companyId) }
        order("sync_id", Order.ASCENDING)
        range(from, from + 999)
    }
    .decodeList<TombstonedRow>()
`;
const unpagedColumns = `
val cloud = client.postgrest.from("widgets")
    .select(Columns.list("sync_id", "deleted_at")) {
        filter { eq("company_id", companyId) }
    }
    .decodeList<TombstonedRow>()
`;
// An unpaged read whose only `range(` sits in a LATER, unrelated statement --
// the case the old chunk boundary (cut at the next `.select`, not at the
// decode) would have waved through.
const rangeArrivesTooLate = `
val cloud = client.postgrest.from("widgets")
    .select(Columns.list("sync_id")) { filter { eq("company_id", companyId) } }
    .decodeList<TombstonedRow>()

fun trim(all: List<CloudWidget>) = all.subList(0, 10).range(0, 9)
`;

ok("CANARY 1  planted paged .select { } read is recognized as paged (0 flagged)",
   findUnpagedSelects(pagedBrace).length === 0,
   `got ${JSON.stringify(findUnpagedSelects(pagedBrace))}`);
ok("CANARY 2  planted unpaged .select { } read is flagged (1) -- this check can fail",
   findUnpagedSelects(unpagedBrace).length === 1,
   `got ${JSON.stringify(findUnpagedSelects(unpagedBrace))}`);
ok("CANARY 3  planted paged .select(Columns.list(...)) { } read is recognized as paged (0 flagged)",
   findUnpagedSelects(pagedColumns).length === 0,
   `got ${JSON.stringify(findUnpagedSelects(pagedColumns))}`);
ok("CANARY 4  planted UNPAGED .select(Columns.list(...)) { } read is flagged (1) -- " +
   "the shape this file was widened to see",
   findUnpagedSelects(unpagedColumns).length === 1,
   `got ${JSON.stringify(findUnpagedSelects(unpagedColumns))}`);
// The point of the exercise: the old pattern must come back CLEAN on canary 4.
// If this ever starts failing, the widening stopped being the thing that
// bought the coverage and this file's whole premise needs re-reading.
ok("CANARY 5  the OLD `.select {`-only pattern reports canary 4 as clean (0 flagged) -- " +
   "proves the blind spot was real and that widening it is what closed it",
   findUnpagedSelects(unpagedColumns, SELECT_BRACE_ONLY).length === 0 &&
   [...unpagedColumns.matchAll(SELECT_BRACE_ONLY)].length === 0,
   `old pattern flagged ${JSON.stringify(findUnpagedSelects(unpagedColumns, SELECT_BRACE_ONLY))}`);
ok("CANARY 6  a `range(` that only appears AFTER the rows were decoded does not " +
   "vouch for the read above it (1 flagged)",
   findUnpagedSelects(rangeArrivesTooLate).length === 1,
   `got ${JSON.stringify(findUnpagedSelects(rangeArrivesTooLate))}`);

console.log("\n2. The real files -- every `.select` in the cloud readers that pull whole");
console.log("   tables down onto a phone:");

// TrashBin.kt is here because it does exactly what EntitySync and JobSync do
// -- one request per table for every row of a company matching a filter, with
// no date window at all ("a device that has been off for a month must still
// learn about everything deleted while it was away" applies just as much to a
// recovery list). It was outside this guard's reach for two reasons at once:
// it was not in the list, and it uses the column-list form the old pattern
// could not see.
const FILES = [
  "app/src/main/java/com/fenceestimator/app/cloud/EntitySync.kt",
  "app/src/main/java/com/fenceestimator/app/cloud/JobSync.kt",
  "app/src/main/java/com/fenceestimator/app/cloud/TrashBin.kt",
];

for (const path of FILES) {
  const src = readFileSync(path, "utf8");
  const unpaged = findUnpagedSelects(src);
  const total = [...src.matchAll(SELECT_ANY)].length;
  // A file with no direct `.select` at all is not a pass this check earned --
  // JobSync.kt reads everything through pagedList(), which lives in
  // EntitySync.kt and is checked there. Say the number out loud either way, so
  // "0 unpaged" can never be mistaken for "0 reads, nothing looked at".
  const note = total === 0
    ? " (no direct reads -- everything here goes through pagedList(), checked in EntitySync.kt)"
    : "";
  ok(`${path}: no unpaged read (found ${total} direct .select call${total === 1 ? "" : "s"})${note}`,
     unpaged.length === 0,
     `${unpaged.length} of ${total} reads have no .range( before the rows are decoded -- ` +
     `line${unpaged.length === 1 ? "" : "s"} ${unpaged.join(", ")} -- any one of these silently ` +
     `truncates at 1000 rows per company per table with no error, the exact trap ` +
     `dashboard.html's own comment describes and was fixed for`);
}

console.log(`\n${checked - failed} of ${checked} checks passed`);
if (failed) process.exit(1);
