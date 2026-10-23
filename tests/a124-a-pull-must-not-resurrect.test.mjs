// A124 -- A PULL MUST NOT PUT BACK WHAT THIS PHONE JUST DELETED.
//
// HIS WORDS: "I also saw past line show up after I had deleted a side, things
// like that is still happening, I don't want it to at all."
//
// THE SHAPE OF IT. Deleting something here does two things: it hard-removes
// the local row, and it queues a tombstone for the cloud
// (Repository.deleteSynced). Until that tombstone is accepted, the CLOUD ROW
// IS STILL LIVE -- deleted_at is null -- so a pull asking for every live row
// gets it back, finds no local copy, and re-creates it:
//
//     val existing = localBySyncId[row.syncId]
//     if (existing == null) { ...FromCloud(...) }        // <- puts it back
//
// "I cannot find it locally" is indistinguishable from "I deleted it a second
// ago". So every create branch has to consult the queue first. The line-items
// pull always did; fence_runs, site_markers and change_orders did not, which
// is why a deleted side reappeared on the drawing.
//
// WHY A SOURCE CHECK. Exercising the real pull needs a Supabase client, a
// cloud and a clock. What can be checked cheaply and exactly is the thing that
// was actually missing: a create branch that never asks. This is the same kind
// of check as tests/sync-unpaged-reads.
//
// Run: node --test tests/a124-a-pull-must-not-resurrect.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const SYNC = read("app/src/main/java/com/fenceestimator/app/cloud/EntitySync.kt");
const REPO = read("app/src/main/java/com/fenceestimator/app/data/Repository.kt");

/** Comments out: a sentence about a guard is not a guard. */
const code = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1 ");

/** Every table whose deletes are queued as a tombstone. Only these can be
 *  resurrected -- a table nothing queues a delete for has nothing to guard. */
function tombstonedTables() {
  return new Set(
    [...code(REPO).matchAll(/(?:queueDeletion|deleteSynced)\s*\(\s*[^,]+,\s*"(\w+)"/g)]
      .map((m) => m[1])
  );
}

/** Each pull function's body, from its declaration to the next one. */
function pulls(src) {
  const starts = [...src.matchAll(/private suspend fun (pull\w+)\s*\(/g)]
    .map((m) => ({ name: m[1], at: m.index }));
  return starts.map((s, i) => ({
    name: s.name,
    body: code(src.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : src.length)),
  }));
}

test("POSITIVE CONTROL: the readers find the pulls and the tombstoned tables", () => {
  // Without this, every assertion below passes when a regex stops matching.
  const found = pulls(SYNC);
  assert.ok(found.length >= 5, `only ${found.length} pull functions found`);
  const tables = tombstonedTables();
  assert.ok(tables.size >= 8, `only ${tables.size} tombstoned tables found`);
  for (const must of ["fence_runs", "site_markers", "change_orders", "estimate_line_items"]) {
    assert.ok(tables.has(must), `${must} is no longer tombstoned -- re-read this file`);
  }
});

test("the three pulls that put rows back now ask the queue first", () => {
  const byName = Object.fromEntries(pulls(SYNC).map((p) => [p.name, p.body]));

  // fence_runs -- the one he reported.
  assert.match(byName.pullFenceRuns, /pendingDeletionsForSync\(\)/,
    "pullFenceRuns no longer reads the pending-delete queue: a deleted side will come back");
  assert.match(byName.pullFenceRuns, /tableName == "fence_runs"/,
    "pullFenceRuns reads the queue but not for its own table");
  assert.match(byName.pullFenceRuns, /in queuedRunDeletes\) return@forEach/,
    "pullFenceRuns never uses what it read");

  // site_markers and change_orders -- the same hole, one table over.
  assert.match(byName.pullJobChildren, /tableName == "site_markers"/,
    "pullJobChildren does not check the queue for site markers");
  assert.match(byName.pullJobChildren, /tableName == "change_orders"/,
    "pullJobChildren does not check the queue for change orders");
  assert.match(byName.pullJobChildren, /in queuedMarkerDeletes\) return@forEach/,
    "a deleted site marker can be re-created by a pull");
  assert.match(byName.pullJobChildren, /in queuedOrderDeletes\) return@forEach/,
    "a deleted change order can be re-created by a pull");
});

test("the queue is read ONCE per pull, so the sets describe one moment", () => {
  // pendingDeletionsForSync() clears stale line-item entries as a side effect,
  // so reading it per table would be several different answers as well as
  // several times the work.
  for (const p of pulls(SYNC)) {
    const reads = (p.body.match(/pendingDeletionsForSync\(\)/g) || []).length;
    assert.ok(reads <= 1, `${p.name} reads the queue ${reads} times`);
  }
});

test("the guard withholds CREATION only, never an update", () => {
  // Refusing an update would freeze a row that is alive again -- the stale
  // case the queue itself already clears. Each refusal must therefore sit
  // inside the `existing == null` branch.
  const body = pulls(SYNC).find((p) => p.name === "pullFenceRuns").body;
  const createAt = body.indexOf("existing == null");
  const guardAt = body.indexOf("in queuedRunDeletes");
  assert.ok(createAt > 0 && guardAt > createAt,
    "the fence-run refusal is not inside the create branch, so it can block an update");
});

test("CANARY: a create branch with no queue check is detected", () => {
  // The exact shape that shipped. If this cannot be spotted, the checks above
  // are decoration.
  const prefix = `
    private suspend fun pullThings(repository: Repository, companyId: String): Int {
        val cloud = pagedList<CloudThing>("things") { eq("company_id", companyId); notDeleted() }
        cloud.forEach { row ->
            val existing = localBySyncId[row.syncId]
            if (existing == null) { repository.createThingFromCloud(row) }
        }
        return 0
    }`;
  const found = pulls(prefix)[0];
  assert.ok(found, "the canary's own pull was not parsed");
  assert.ok(!/pendingDeletionsForSync/.test(found.body),
    "THE CANARY DID NOT FIRE: an unguarded create branch was judged guarded");
});

test("the catalog pull is guarded too -- on the create branch ONLY", () => {
  // THE GAP THIS CLOSES, and why it was left open for a day. pullCatalog
  // creates material_items, whose deletes are queued, so the same
  // resurrection was possible there. The worry was that a queue check could
  // stop catalog items syncing altogether -- and it would have, had it gone
  // where the other three went. Reading the branches settles it: only ONE of
  // them creates a row.
  //
  //   existing != null         -> updates; never a resurrection
  //   sameThing != null        -> re-keys a local row that is still here, so a
  //                               deleted item is not in localByIdentity and
  //                               cannot come back this way
  //   ident in knownIdentities -> already skipped
  //   otherwise                -> saveMaterialItemFromCloud, the one way back
  //
  // So the guard sits on that last branch alone, and the identity re-keying
  // that keeps every phone quoting one price is untouched. This test pins
  // BOTH halves, because the dangerous mistake is not forgetting the guard --
  // it is putting it one branch too early.
  const byName = Object.fromEntries(pulls(SYNC).map((p) => [p.name, p.body]));
  const body = byName.pullCatalog;
  assert.ok(body, "pullCatalog is gone -- revisit this check");
  assert.ok(tombstonedTables().has("material_items"),
    "material_items is no longer tombstoned, so this guard may no longer be needed");

  assert.match(body, /tableName == "material_items"/,
    "pullCatalog does not read the queue for its own table: a deleted catalog item will come back");
  assert.match(body, /in queuedCatalogDeletes\) return@forEach/,
    "pullCatalog reads the queue but never uses what it read");

  // THE GUARD MUST COME AFTER the update and the re-key, or it blocks them.
  const guardAt = body.indexOf("in queuedCatalogDeletes");
  const createAt = body.indexOf("saveMaterialItemFromCloud");
  const reKeyAt = body.indexOf("adoptedIdentities += ident");
  const updateAt = body.indexOf("updateMaterialItemFromCloud");
  assert.ok(guardAt > 0 && createAt > 0 && reKeyAt > 0 && updateAt > 0,
    `could not find all four points: guard ${guardAt}, create ${createAt}, re-key ${reKeyAt}, update ${updateAt}`);
  assert.ok(guardAt < createAt,
    "the guard is after the create, so it guards nothing");
  assert.ok(guardAt > reKeyAt,
    "the guard sits BEFORE the identity re-key: a catalog item whose local copy is being " +
    "adopted onto the cloud's id would be refused, which stops catalog items syncing -- " +
    "a worse failure than the one this fixes");
  assert.ok(guardAt > updateAt,
    "the guard sits before the update branch, so a price correction would stop reaching this phone");
});
