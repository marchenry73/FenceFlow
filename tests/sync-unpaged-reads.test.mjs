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

/* THE OFFICE, which this file's own header has always made a claim about.

   dashboard.html does not use postgrest-kt, so the Kotlin patterns above
   cannot see it. Its reads look like

       db.from('estimate_line_items').select('*').is('deleted_at', null).in(...)

   and a paged one carries a .range( before the statement ends. Checked
   statement by statement: from each `db.from('table')` to the end of that
   statement, a read must either page, or be one of the shapes that cannot
   truncate -- a single row (.single/.maybeSingle), a count-only head request,
   or a write.

   WHY THIS WAS WORTH ADDING RATHER THAN TRUSTING THE COMMENT: when it was
   first run it found three live unpaged reads -- ensureItemsForJobs,
   ensureExpensesForJobs and ensureStageEventsForJobs -- each asking for a
   chunk of 150 job sync_ids in one request and taking whatever came back.
   None of them errors when truncated, so ensureItemsForJobs' failedIds set
   never fired and the Materials buy list would have understated what to order
   with nothing anywhere saying so. */
const OFFICE = "website/dashboard.html";

/** Every `db.from('x')...;` statement in the office, with its line number. */
function officeStatements(src) {
  const out = [];
  const re = /db\.from\('([a-z_]+)'\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    // To the end of the statement. The office writes one statement per
    // `;`, and a template literal or a nested call cannot contain a bare
    // `;` here -- checked by the control below, which asserts the slices
    // are of a sane length rather than the whole file.
    const rest = src.slice(m.index, m.index + 900);
    const semi = rest.indexOf(";");
    // Is this read handed to a pager? pagedRows(() => db.from(...)) and
    // loadAll's q() both add the .range() themselves, so the giveaway is in
    // the characters BEFORE the read, not after it.
    const before = src.slice(Math.max(0, m.index - 160), m.index);
    out.push({
      table: m[1],
      line: src.slice(0, m.index).split("\n").length,
      text: semi > 0 ? rest.slice(0, semi) : rest,
      wrapped: /pagedRows\(\s*\(\s*\)\s*=>\s*$|pagedRows\(\(\) =>\s*$/.test(before.trimEnd() + ""),
      // `let qb = db.from(...)` -- a builder held for a later await, which is
      // where its .range() goes. An actual read has an await or a .then here.
      assigned: /(?:^|\n)\s*(?:let|const|var)\s+\w+\s*=\s*$/.test(before)
        && !/await|\.then\(/.test(semi > 0 ? rest.slice(0, semi) : rest),
    });
  }
  return out;
}

/* TABLES THAT GROW WITHOUT BOUND for a single company -- one row per line
   item, per shift, per payment, per stage move, per email. These are the ones
   where a thousand rows is a date rather than a hypothetical, so an unpaged
   multi-row read of one of them is a failure.

   Everything else is printed as a note instead: a company's settings row, one
   job's punch list, one thread's labels, a handful of automation rules. The
   distinction is a judgement about the schema, so it is written down here
   where it can be argued with rather than guessed at by a regex. */
const GROWS_FOREVER = new Set([
  "estimate_line_items", "expenses", "job_stage_events", "time_entries",
  "payment_records", "job_payments", "mail_messages", "material_items",
  "jobs", "audit_log", "attention_findings", "automation_runs",
  "follow_up_log", "quote_reapprovals", "punch_list_items", "fence_runs",
  "change_orders", "employees",
]);

/** A statement that could silently truncate: a multi-row read with no paging. */
function officeUnpaged(src) {
  return officeStatements(src).filter((st) => {
    if (!/\.select\(/.test(st.text)) return false;                 // not a read
    // A WRITE that asks for the changed rows back. `.select('id')` after an
    // update cannot truncate anything.
    if (/\.(update|insert|upsert|delete)\(/.test(st.text)) return false;
    if (/\.range\(/.test(st.text)) return false;                   // paged here
    if (/\.single\(|\.maybeSingle\(/.test(st.text)) return false;     // one row
    if (/head:\s*true/.test(st.text)) return false;                 // count only
    // PAGED BY A WRAPPER. pagedRows() and loadAll's q() add the .range()
    // themselves, so the statement carries none -- the same second-shape
    // blind spot this file's header describes for the Kotlin reads.
    if (st.wrapped) return false;
    // A DELIBERATE BOUND. `.order('at', desc).limit(200)` is an audit log
    // showing the last two hundred on purpose; the thousand-row cap only
    // matters to a read that meant to get everything. A limit ABOVE the cap
    // is still a truncation waiting to happen, so it is not excused.
    const lim = /\.limit\(\s*(\d+)\s*\)/.exec(st.text);
    if (lim && Number(lim[1]) <= 1000) return false;
    // BOUNDED TO ONE PARENT. One job's punch list, one job's change orders,
    // one thread's messages -- none of which reaches a thousand on this
    // schema. Note this is the parent key, not any .eq at all: .eq on a
    // status or a flag bounds nothing.
    if (/\.eq\('(job_sync_id|job_id|thread_id|sync_id|rule_key)'/.test(st.text)) return false;
    // A BUILDER BEING ASSIGNED, whose .range() lands on a later statement --
    // loadStageEvents is written that way and is paged. Recognised by there
    // being no await and no .then on the statement itself.
    if (st.assigned) return false;
    return true;
  });
}

{
  const src = readFileSync(OFFICE, "utf8");
  const all = officeStatements(src);
  // CONTROL FIRST. A regex that stops matching would report "0 unpaged" and
  // print ok -- an empty answer reading as good news, which is the exact
  // failure this file's own header describes for the Kotlin side.
  ok(`${OFFICE}: the statement scanner found reads at all`,
     all.length > 40, `found only ${all.length} db.from() statements`);
  ok(`${OFFICE}: the scanner cut statements, not the whole file`,
     all.every((st) => st.text.length < 900),
     `${all.filter((st) => st.text.length >= 900).length} statements hit the 900-char slice limit`);

  const unpaged = officeUnpaged(src);
  const serious = unpaged.filter((u) => GROWS_FOREVER.has(u.table));
  const minor = unpaged.filter((u) => !GROWS_FOREVER.has(u.table));

  ok(`${OFFICE}: no unpaged read of a table that grows without bound ` +
     `(scanned ${all.length} statements, ${unpaged.length} unpaged, ${minor.length} of them bounded)`,
     serious.length === 0,
     `${serious.length} unpaged read${serious.length === 1 ? "" : "s"} of a growing table -- ` +
     serious.map((u) => `${u.table}:${u.line}`).join(", ") +
     ` -- each truncates at 1000 rows per company with no error`);

  if (minor.length) {
    console.log(`        note: ${minor.length} unpaged reads of tables that cannot reach a ` +
      `thousand rows for one company (${[...new Set(minor.map((m) => m.table))].sort().join(", ")})`);
  }

  // CANARIES FOR THE EXCLUSIONS. Each one excuses a shape; each has to be
  // shown to excuse ONLY that shape, or it is a hole rather than a rule.
  ok("CANARY: a .limit() ABOVE the cap is still reported",
     officeUnpaged("const a = await db.from('audit_log').select('*').limit(5000);").length === 1,
     "a limit of 5000 was excused, but the server stops at 1000");
  ok("CANARY: .eq on a status bounds nothing and is still reported",
     officeUnpaged("const b = await db.from('job_payments').select('*').eq('status','paid');").length === 1,
     "an .eq on a non-parent column was treated as a bound");
  ok("CANARY: a real await is not mistaken for a builder assignment",
     officeUnpaged("const c = await db.from('mail_messages').select('*');").length === 1,
     "an awaited read was excused as a held builder");

  // CANARY: the office pattern must be able to fail, or the check above is
  // decoration. This is the exact shape the three top-ups had.
  const planted = officeUnpaged(
    "const x = await db.from('estimate_line_items').select('*').in('job_sync_id', c);"
  );
  ok("CANARY: an unpaged office read is detected",
     planted.length === 1, `detected ${planted.length}`);
  // And a paged one must pass, or the check would fail on correct code.
  const good = officeUnpaged(
    "const y = await db.from('expenses').select('*').in('job_sync_id', c).range(0, 999);"
  );
  ok("CANARY: a paged office read is accepted",
     good.length === 0, `flagged ${good.length} correct reads`);
}

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
