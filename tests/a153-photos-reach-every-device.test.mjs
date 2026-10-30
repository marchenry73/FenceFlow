// a153: PHOTOS REACH EVERY DEVICE, AND A REMOVED ONE STAYS REMOVED.
//
// The files were never the problem: JobFileUploader already uploaded every
// photo, compressed it, and downloadMissing() already fetched any whose local
// file was gone. What was missing was the ROW -- job_photos existed only in
// Room, so a second phone had nothing to point at the picture in the bucket.
//
// Now that the rows travel, four things can go wrong, and every one is silent:
//
//   1. A hard local delete. The cloud row survives, the next pull cannot
//      match it to anything local, and the photo reappears on the job.
//   2. The mirror image: a pull that treats "not in the cloud" as "delete it
//      here". That is how 64 priced line items were tombstoned company-wide
//      by one half-loaded client.
//   3. A push whose cloud read HIDES tombstones: a photo removed on another
//      device reads as "no cloud copy", so this phone's older live row goes
//      back up and un-removes it.
//   4. The storage path never propagating, so every device holds the row and
//      none of them can find the picture.
//
// Source-level, because the sync is the impure half and there is no way to
// assert this from outside: a wrong branch looks identical to a right one
// until two phones disagree.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8");
const SYNC = read("app/src/main/java/com/fenceestimator/app/cloud/EntitySync.kt");
const REPO = read("app/src/main/java/com/fenceestimator/app/data/Repository.kt");
const DAO = read("app/src/main/java/com/fenceestimator/app/data/Daos.kt");
const ENT = read("app/src/main/java/com/fenceestimator/app/data/Entities.kt");
const UPLOADER = read("app/src/main/java/com/fenceestimator/app/cloud/JobFileUploader.kt");
const DB = read("app/src/main/java/com/fenceestimator/app/data/AppDatabase.kt");

/**
 * Kotlin source with comments removed.
 *
 * Three of these assertions first failed against perfectly correct code,
 * because the COMMENT above the statement contained the very word being
 * looked for, and a fixed character window landed inside that comment and
 * never reached the statement at all. Comments are prose, not behaviour, so
 * they are stripped before anything is asserted.
 */
const code = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    // Whitespace collapsed as well. Stripping a six-line comment leaves six
    // blank lines behind, and a window measured in characters then contains
    // nothing but indentation -- which is how two of these checks failed
    // while looking at the right place.
    .replace(/\s+/g, " ");

/** The body of a named Kotlin function, by brace depth, so moving it does not
 *  quietly empty a test. */
function fnBody(src, signature) {
  const at = src.indexOf(signature);
  assert.notEqual(at, -1, `${signature} is gone or renamed -- re-aim this test`);
  const open = src.indexOf("{", at + signature.length);
  assert.notEqual(open, -1, `no body found for ${signature}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  assert.fail(`unbalanced braces in ${signature}`);
}

test("a153 removing a photo stamps the row -- it does not delete it", () => {
  const body = code(fnBody(REPO, "suspend fun deletePhoto("));
  assert.match(body, /deletedAt = now/,
    "deletePhoto no longer stamps; a hard delete is undone by the next pull");
  assert.ok(!/jobPhotoDao\.delete\(/.test(body),
    "deletePhoto still hard-deletes, so the cloud copy will put the photo back");
  // CANARY: the slice really is that function's body.
  assert.match(body, /jobPhotoDao\.update\(/, "the slice taken is not deletePhoto's body");
  assert.match(REPO, /suspend fun deletePhoto\(photo: JobPhoto\) = guardWrite\("deletePhoto"\)/,
    "deletePhoto no longer goes through guardWrite");
});

test("a153 the entity carries a tombstone and a clock", () => {
  assert.match(ENT, /val deletedAt: Long\? = null,/, "JobPhoto has no deletedAt");
  assert.match(ENT, /val updatedAt: Long = System\.currentTimeMillis\(\)/, "JobPhoto has no updatedAt");
});

test("a153 the screen's photo list hides removed photos, the sync's does not", () => {
  // Two different questions, and answering both with one query is the bug: the
  // UI must not show a removed photo, and the sync MUST see it or it cannot
  // tell a removal from a photo it has never heard of.
  const d = code(DAO);
  assert.match(d, /WHERE jobId = :jobId AND deletedAt IS NULL ORDER BY takenAt DESC/,
    "observeForJob still shows removed photos");
  assert.match(d, /WHERE jobId = :jobId AND deletedAt IS NULL"\) suspend fun getForJob/,
    "getForJob still shows removed photos");
  assert.match(d, /SELECT \* FROM job_photos"\) suspend fun getAllForSync/,
    "getAllForSync filters tombstones, so the sync cannot see a removal");
});

test("a153 the push sees tombstones and only sends what is newer here", () => {
  const body = code(fnBody(SYNC, "private suspend fun pushJobPhotos("));
  assert.match(body, /pagedList<CloudJobPhoto>\("job_photos"\)/, "the push does not read the cloud");
  assert.ok(!/notDeleted\(\)/.test(body),
    "the push's cloud read hides tombstones, so a photo removed elsewhere is pushed back");
  assert.match(body, /photo\.updatedAt > claimed\.updatedAtMillis\(\)/,
    "the push does not compare clocks, so it overwrites edits made elsewhere");
  assert.match(body, /claimed == null \|\|/, "a photo the cloud has never seen is not pushed");
});

test("a153 both directions are paged", () => {
  // An unpaged read stops at PostgREST's thousandth row with no error, and a
  // company past a thousand photos would re-push the remainder as brand new
  // on every sync.
  const push = code(fnBody(SYNC, "private suspend fun pushJobPhotos("));
  const pull = code(fnBody(SYNC, "private suspend fun pullJobPhotos("));
  assert.match(push, /pagedList</, "the push is not paged");
  assert.match(pull, /pagedList<CloudJobPhoto>/, "the pull is not paged");
});

test("a153 the pull never re-creates a photo that was removed", () => {
  const body = code(fnBody(SYNC, "private suspend fun pullJobPhotos("));
  assert.match(body, /if \(row\.deletedAt != null\) return@forEach/,
    "a row stamped deleted is created as a new photo when this phone has not seen it");
  assert.match(body, /if \(existing == null\)/, "the pull does not branch on a local row existing");
});

test("a153 the pull never deletes a local photo for being absent from the cloud", () => {
  // The function iterates the CLOUD rows; nothing in it may remove a local
  // one, which is the only shape "absent means delete" can take here.
  const body = code(fnBody(SYNC, "private suspend fun pullJobPhotos("));
  assert.ok(!/deletePhoto|jobPhotoDao\.delete/.test(body),
    "the pull deletes local photos -- absence is not deletion (see the header)");
});

test("a153 the pull keeps this phone's own file path", () => {
  const body = code(fnBody(SYNC, "private suspend fun pullJobPhotos("));
  assert.match(body, /storagePath = existing\.storagePath \?: row\.storagePath/,
    "the pull overwrites a local storage path with the cloud's");
  assert.ok(!/filePath = row\./.test(body),
    "the pull writes a file path from the cloud -- that path is another device's disk");
});

test("a153 the uploader skips a row whose file has not arrived", () => {
  assert.match(code(UPLOADER), /photo\.storagePath == null && photo\.filePath\.isNotBlank\(\)/,
    "a pulled row with a blank file path is handed to ImageCompressor");
});

test("a153 a newly uploaded photo's path propagates", () => {
  // The push only sends rows whose local clock beats the cloud's, so setting
  // storagePath without moving updatedAt leaves the path on this phone and
  // every other device holding a row it cannot resolve.
  const body = code(UPLOADER);
  const at = body.indexOf('FileSync.upload(companyId, job.syncId, "photo"');
  assert.notEqual(at, -1, "the photo upload call is gone -- re-aim this test");
  const near = body.slice(at, at + 300);
  assert.match(near, /storagePath = remote, updatedAt = System\.currentTimeMillis\(\)/,
    "the storage path is stored without moving the clock, so it never goes up");
});

test("a153 a downloaded file does NOT move the clock", () => {
  // The opposite rule, and it matters: where a file landed on this handset is
  // not an edit, and pushing it would send a row whose only change is a path
  // no other device can use.
  const body = code(fnBody(UPLOADER, "suspend fun downloadMissing("));
  const at = body.indexOf('ensureLocal(context, remote, "photos")');
  assert.notEqual(at, -1, "the photo download call is gone -- re-aim this test");
  const near = body.slice(at, at + 150);
  assert.match(near, /photo\.copy\(filePath = local\)/);
  assert.ok(!/updatedAt/.test(near),
    "a download bumps updatedAt, which pushes a pointless row every sync");
});

test("a153 a removed photo is not counted as work waiting to sync", () => {
  const body = code(REPO);
  const at = body.indexOf("jobPhotoDao.getAll().forEach");
  assert.notEqual(at, -1, "the unsynced-work sweep over photos is gone -- re-aim this test");
  const near = body.slice(at, at + 260);
  assert.match(near, /photo\.deletedAt == null && photo\.storagePath == null/,
    "a removed photo with no storage path counts as an unsynced file for ever");
});

test("a153 Room has a migration for the two new columns, and seeds the clock", () => {
  assert.match(DB, /version = 57,/, "the database version was not raised");
  assert.match(DB, /ADD COLUMN `deletedAt` INTEGER/, "no migration for deletedAt");
  assert.match(DB, /ADD COLUMN `updatedAt` INTEGER NOT NULL DEFAULT 0/, "no migration for updatedAt");
  // A photo taken before this build is not "changed in 1970": left at zero,
  // any cloud copy would win over a local caption nobody has touched.
  assert.match(DB, /UPDATE `job_photos` SET `updatedAt` = `takenAt`/,
    "existing photos keep updatedAt = 0, so the cloud overwrites them all");
  assert.match(DB, /MIGRATION_56_57/, "the migration is not in the list Room is given");
});

test("a153 CANARY: these checks are reading the real files", () => {
  // Every assertion above is a regex over source. A path that was wrong would
  // have thrown on read -- but a file that silently became empty would turn
  // every one of them into a vacuous pass.
  for (const [name, src] of Object.entries({ SYNC, REPO, DAO, ENT, UPLOADER, DB })) {
    assert.ok(src.length > 2000, `${name} came back suspiciously short (${src.length} chars)`);
  }
  assert.match(SYNC, /data class CloudJobPhoto\(/, "CloudJobPhoto is not in EntitySync at all");
  assert.match(SYNC, /step\("photos"\)/, "the push step is not wired into pushAll");
  assert.match(SYNC, /pullJobPhotos\(repository, companyId\)/, "the pull is not wired into pullAll");
  // And the stripper must actually strip, or every "must NOT contain" check
  // above is reading comments as if they were code.
  assert.equal(code("a /* x */ b // y\nc"), "a b c");
});
