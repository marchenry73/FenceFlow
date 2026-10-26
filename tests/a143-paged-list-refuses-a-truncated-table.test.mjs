/* The runaway stop had put back the bug pagedList exists to fix.
 *
 * pagedList was written because PostgREST answers at most 1000 rows and
 * reports the total as unknown, so a caller that asks once -- in its own words
 * -- "cannot tell a complete answer from a truncated one". Its loop fixed that.
 *
 * Then the loop ended with `if (all.size >= page * 50) break` and RETURNED the
 * list. At fifty thousand rows the caller got a truncated answer it could not
 * tell from a complete one: exactly the condition the function was built to
 * remove, reintroduced two lines from the end.
 *
 * The stakes are the ones its own comment names. On a sync, "the cloud does
 * not have this row" is not a harmless gap -- "it decides what gets pushed,
 * and in places what gets tombstoned". A company past the cap would have had
 * live rows re-pushed and live rows tombstoned on the strength of an answer
 * that was never complete, with nothing saying so.
 *
 * Source-slicing, because pagedList is an inline suspend function that builds
 * its request through SupabaseModule's client: what is being checked is which
 * way one branch exits and whether the sync card has a sentence for it, and
 * neither is reachable from a unit test of the pure layer.
 *
 *   node --test tests/a143-paged-list-refuses-a-truncated-table.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Newlines normalised on read: bounding a block by "\n}\n" silently misses on
// a CRLF file, indexOf returns -1, and the slice runs to the end of the file --
// which looks exactly like a product bug.
const read = (p) => readFileSync(resolve(ROOT, p), "utf8").split("\r\n").join("\n");
const nl = String.fromCharCode(10);

const ENTITY_SYNC = "app/src/main/java/com/fenceestimator/app/cloud/EntitySync.kt";
const AUTO_SYNC = "app/src/main/java/com/fenceestimator/app/cloud/AutoSync.kt";
const LOCALES = ["values", "values-es", "values-fr"];

// Comments stripped before anything is matched: a rule named only in prose
// must not satisfy a check. Two canaries in this repo passed on a comment.
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The body of pagedList, bounded to the function so a `break` elsewhere cannot satisfy it. */
function pagedListBody() {
  const src = code(read(ENTITY_SYNC));
  const start = src.indexOf("internal suspend inline fun <reified T : Any> pagedList");
  assert.ok(start > 0, "pagedList has moved or been renamed; this test no longer checks it");
  const end = src.indexOf(nl + "}" + nl, start);
  assert.ok(end > start, "could not bound pagedList");
  return src.slice(start, end);
}

test("the cap throws; it does not hand back a truncated list", () => {
  const body = pagedListBody();
  assert.match(
    body,
    /throw TableTooLarge\(/,
    "the cap does not throw, so a company past it gets a short answer it cannot tell from a complete one",
  );
  // The loop still has ONE legitimate break: a short page, which is a complete
  // answer. Any second break is the cap quietly returning again.
  const breaks = body.match(/\bbreak\b/g) ?? [];
  assert.equal(
    breaks.length,
    1,
    `pagedList has ${breaks.length} breaks; the only one that may end this loop is a short page`,
  );
  assert.match(body, /if \(batch\.size < page\) break/, "the short-page exit has changed shape");
});

test("the refusal names the table, because that is the only actionable part", () => {
  const src = code(read(ENTITY_SYNC));
  assert.match(
    src,
    /class TableTooLarge\(val table: String, val rows: Int\)/,
    "TableTooLarge no longer carries the table and the row count",
  );
  // The cap is a named constant, so the sentence and the loop cannot come to
  // disagree about what the cap is.
  assert.match(src, /const val MAX_PAGES = \d+/, "the cap is back to a literal in the loop");
  assert.match(pagedListBody(), /page \* MAX_PAGES/, "the loop does not use the named cap");
});

test("the SECOND copy of the loop refuses too -- the one that reaps deletions", () => {
  // Found by this file, not by the note that asked for the fix: the tombstone
  // sweep repeats pagedList's loop on purpose (pagedList selects every column,
  // and this sweep runs over time_entries and material_items, so routing it
  // through pagedList would pull hourly_rate and unit_price onto a crew
  // phone). The silent cap came with the copy.
  //
  // It is the worse of the two. Its own comment says what a tombstone it never
  // reads costs: the local row survives the reap, the push straight afterwards
  // sends it back up, and a deleted line item reappears on every device and
  // back into the job total. And tombstones are never cleaned up, so the count
  // only grows.
  const src = code(read(ENTITY_SYNC));
  const start = src.indexOf("private suspend fun tombstonedSyncIds");
  assert.ok(start > 0, "tombstonedSyncIds has moved; the reap's paging is no longer checked");
  const body = src.slice(start, src.indexOf(nl + "    }" + nl, start));
  assert.ok(body.length > 0, "could not bound tombstonedSyncIds");
  assert.match(body, /throw TableTooLarge\(/, "the reap still returns a short tombstone list");
  assert.match(body, /MAX_PAGES/, "the reap has its own literal cap again");
  const breaks = body.match(/\bbreak\b/g) ?? [];
  assert.equal(breaks.length, 1, `the reap has ${breaks.length} breaks; only a short page may end it`);
});

test("the sync card has a sentence for it, chosen by TYPE and down the cause chain", () => {
  const src = code(read(AUTO_SYNC));
  const start = src.indexOf("private fun plainWords");
  assert.ok(start > 0, "plainWords has moved; the card's wording is no longer checked here");
  const body = src.slice(start, src.indexOf(nl + "    }" + nl, start));
  assert.ok(body.length > 0, "could not bound plainWords");
  // By type, not by matching the exception's words. The rest of plainWords
  // matches text because a library exception gives it nothing else; this one
  // is ours, and an exact check cannot be fooled by a URL or a server's
  // phrasing -- the very confusion the function's own comments record.
  assert.match(
    body,
    /filterIsInstance<TableTooLarge>/,
    "the card picks this case by matching words rather than by type",
  );
  // A pull runs inside a coroutineScope, so what arrives may be wrapping it.
  assert.match(
    body,
    /generateSequence\(error\) \{ it\.cause \}[\s\S]*?filterIsInstance<TableTooLarge>/,
    "only the outermost throwable is examined, so a wrapped one falls through to the generic sentence",
  );
  assert.match(body, /R\.string\.sync_plain_table_too_large/, "no sentence is used for it");
});

test("the sentence exists in every locale, takes the table name, and is its own", () => {
  const found = LOCALES.map((loc) => {
    const src = read(`app/src/main/res/${loc}/strings.xml`);
    const m = src.match(
      /<string name="sync_plain_table_too_large">([\s\S]*?)<\/string>/,
    );
    assert.ok(m, `sync_plain_table_too_large missing from ${loc}`);
    return m[1].trim();
  });
  assert.equal(
    new Set(found).size,
    3,
    "two locales carry the same sentence -- one was not translated",
  );
  for (const [i, body] of found.entries()) {
    assert.match(body, /%1\$s/, `${LOCALES[i]} does not name the table`);
  }
  // It must not claim the phone lost anything: the pass stopped before writing.
  assert.match(found[0], /Nothing on this phone was changed/i);
});

test("POSITIVE CONTROL: the anchors are really there, and the old shape is really gone", () => {
  // Every check above matches text in a file read by path. A wrong path throws
  // rather than passes, but a slice that came back empty would match nothing
  // and could read as a pass, so the anchors are asserted present here too.
  const es = read(ENTITY_SYNC);
  assert.ok(es.includes("fun <reified T : Any> pagedList"), "EntitySync.kt is not the file this test thinks");
  assert.ok(read(AUTO_SYNC).includes("plainWords"), "AutoSync.kt no longer has plainWords");
  // And the exact line that was wrong is gone, named literally so nobody can
  // reintroduce it and still pass.
  assert.ok(
    !code(es).includes("if (all.size >= page * 50) break"),
    "the old silent cap is back verbatim",
  );
});
