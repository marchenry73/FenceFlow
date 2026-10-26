// The sync card says WHY it stopped when another phone holds the login.
//
// The bail in runSync used to copy phase and lastError only, leaving
// hasUnsyncedWork and unsyncedReason untouched -- so the card kept whatever it
// last said. With work pending that was "it will go up on the next sync", when
// there was no next sync. With nothing pending it was worse: "Everything is
// backed up", while the phone was not syncing at all and could not.
//
// lastError does carry the true sentence, but the card renders lastError only
// for SyncPhase.FAILED and this bail sets IDLE, so the real reason was
// computed and discarded.
//
// Source-slicing, because the thing being checked is which fields one early
// return writes and whether two screens and three locales agree about a new
// enum value -- none of which a unit test of the pure layer can see.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Newlines normalised on read. Without this, bounding a block by "\n}\n"
// silently misses on a CRLF file, indexOf returns -1, and the slice runs to
// the end of the file -- which looked exactly like a product bug.
const read = (p) => readFileSync(resolve(ROOT, p), "utf8").split("\r\n").join("\n");
// String.fromCharCode(10) rather than an escape: this line was written
// through a shell heredoc once and the backslash was eaten, leaving a raw
// newline inside the literal and a syntax error.
const nl = String.fromCharCode(10);

const AUTOSYNC = "app/src/main/java/com/fenceestimator/app/cloud/AutoSync.kt";
const ACCOUNT = "app/src/main/java/com/fenceestimator/app/ui/account/AccountScreen.kt";
const JOBSLIST = "app/src/main/java/com/fenceestimator/app/ui/jobs/JobsListScreen.kt";
const LOCALES = ["values", "values-es", "values-fr"];

// Comments are stripped before anything is matched: a rule named only in prose
// must not satisfy a check. Two canaries in this repo passed on a comment.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the reason exists, and is its own value rather than a borrowed one", () => {
  const src = code(read(AUTOSYNC));
  assert.match(src, /enum class UnsyncedReason \{[\s\S]*?DISPLACED_BY_ANOTHER_PHONE[\s\S]*?\}/,
    "UnsyncedReason has no DISPLACED_BY_ANOTHER_PHONE");
  // The four that describe a QUEUE must still be there: this is an addition,
  // not a rename of one of them.
  for (const existing of ["JOBS_HELD_BACK", "RECORDS_HELD_BACK", "ACCESS_NOT_CONFIRMED"]) {
    assert.match(src, new RegExp(existing), `${existing} was removed, not added beside`);
  }
});

test("the displaced bail sets the reason AND the flag, not just the phase", () => {
  const src = code(read(AUTOSYNC));
  const bail = src.slice(src.indexOf("if (!mineAgain) {"));
  assert.ok(bail.length > 0, "the displaced bail has moved or been renamed");
  const block = bail.slice(0, bail.indexOf("return"));
  assert.match(block, /unsyncedReason\s*=\s*UnsyncedReason\.DISPLACED_BY_ANOTHER_PHONE/,
    "the bail does not name the reason, so the card keeps its previous sentence");
  assert.match(block, /hasUnsyncedWork\s*=\s*true/,
    "without this the card asserts 'Everything is backed up' for a pass that never ran");
});

test("both screens say something for it -- neither falls through", () => {
  // The `when` over UnsyncedReason is exhaustive in both, with no else, so a
  // new value is a compile error until both are updated. That is deliberate:
  // a fifth reason quietly hitting a catch-all would put the card straight
  // back to saying nothing useful.
  for (const screen of [ACCOUNT, JOBSLIST]) {
    const src = code(read(screen));
    assert.match(src, /UnsyncedReason\.DISPLACED_BY_ANOTHER_PHONE\s*->\s*stringResource\(R\.string\.sync_displaced_elsewhere\)/,
      `${screen} does not render the displaced reason`);
    // Bounded to the mapper itself. Slicing to the end of the file caught
    // an `else ->` in an unrelated `when` further down -- a test wrong in
    // the direction that looks like a product bug.
    // The DEFINITION, not the first mention. Anchoring on the bare name found
    // a call site 24k characters earlier, so the slice ran through unrelated
    // code and tripped on an `else ->` belonging to a different `when`.
    const start = src.indexOf("fun unsyncedReasonMessage");
    const body = src.slice(start, src.indexOf(nl + "}" + nl, start));
    assert.ok(body.length > 0, `${screen}: could not bound the mapper`);
    assert.doesNotMatch(body, /^\s*else\s*->/m,
      `${screen} grew an else branch, so a future reason can fall through silently`);
  }
});

test("the sentence exists in every locale, and each is its own", () => {
  const found = LOCALES.map((loc) => {
    const src = read(`app/src/main/res/${loc}/strings.xml`);
    const m = src.match(/<string name="sync_displaced_elsewhere">([\s\S]*?)<\/string>/);
    assert.ok(m, `sync_displaced_elsewhere missing from ${loc}`);
    return m[1].trim();
  });
  assert.equal(new Set(found).size, 3, "three locales carry the same sentence -- one was not translated");
  // It must not promise a queue. The phone could not look: stillMine said no,
  // so whether anything is waiting is exactly what it never found out. The
  // same rule ACCESS_NOT_CONFIRMED sets for itself.
  assert.doesNotMatch(found[0], /next sync|backed up/i,
    "the English sentence claims something about the queue that this pass cannot know");
});

test("POSITIVE CONTROL: this file can actually fail", () => {
  // Every check above reads a file by path and matches text in it. If a path
  // were wrong, read() would throw rather than pass -- but a slice that comes
  // back empty would match nothing and could look like a pass elsewhere, so
  // the anchors are asserted present here too.
  assert.ok(read(AUTOSYNC).includes("enum class UnsyncedReason"), "AutoSync.kt is not the file this test thinks");
  assert.ok(read(ACCOUNT).includes("unsyncedReasonMessage"), "AccountScreen.kt no longer has the mapper");
  assert.ok(read(JOBSLIST).includes("unsyncedReasonMessage"), "JobsListScreen.kt no longer has the mapper");
});
