/* Deleting a side must free the end it shared a post with.

   HIS REPORT, 2 Oct 2026: "I deleted a side and it was not completely deleted,
   and I added a new one and the residue of it still stayed."

   WHAT WAS LEFT BEHIND. Repository.deleteFenceRun cleaned up the run's own line
   items (and the Room foreign key cascades them locally), but nothing anywhere
   cleared a JOINT when its partner was deleted. So a side that shared a corner
   post with the deleted one kept an id naming a run that no longer exists.

   WHY IT IS RESIDUE AND NOT A WRONG BILL. adjustJoins groups ends by joint id
   and an id only one run holds reads as a FREE end -- the dearer answer, a post
   too many rather than a post too few. So the money was safe. What was not safe
   was the picture and the next gesture: a drawing still showing a shared post
   where only one side remains, and a stale id on an end he may later attach to
   something else.

   WHAT THIS ASSERTS
     1. the source really does free the partner, BEFORE the delete, through the
        ordinary update path (so it syncs like any other edit);
     2. the rule itself, over a transcription of the Kotlin;
     3. a POSITIVE CONTROL that an UNRELATED joint on the same job is left alone;
     4. a canary that must fail against the code as it was.

   The Kotlin is transcribed because this suite is plain node and cannot compile
   or run Kotlin. The structural test is what keeps the transcription honest: if
   the production clauses change, that goes red first. Stated as the limit it is. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = 'app/src/main/java/com/fenceestimator/app/data/Repository.kt';
const src = readFileSync(new URL('../' + SRC, import.meta.url), 'utf8');

const deleteFn = (() => {
  const i = src.indexOf('suspend fun deleteFenceRun(');
  assert.ok(i > 0, 'deleteFenceRun is gone from Repository.kt');
  // To the line that deletes the run itself, plus the queued line-item tail.
  const end = src.indexOf('queueDeletion(syncId, "estimate_line_items")', i);
  assert.ok(end > i, 'could not bound deleteFenceRun');
  return src.slice(i, end + 60);
})();

/* ---- 1. the source frees the partner, and does it in the right order ----- */
test('deleting a side clears the joint on whatever shared a post with it', () => {
  assert.match(deleteFn, /val orphaned = setOf\(run\.startJoint, run\.endJoint\)/,
    'deleteFenceRun no longer collects the joints the deleted side was holding');
  assert.match(deleteFn, /fenceRunDao\.getForJob\(run\.jobId\)/,
    'it no longer looks at the other sides of the job');
  assert.match(deleteFn, /copy\(startJoint = ""\)/);
  assert.match(deleteFn, /copy\(endJoint = ""\)/);
});

test('the partner is freed BEFORE the run is deleted, not after', () => {
  const freeAt = deleteFn.indexOf('val orphaned =');
  const deleteAt = deleteFn.indexOf('deleteSynced(run.syncId, "fence_runs")');
  assert.ok(freeAt > 0 && deleteAt > 0, 'could not find both steps');
  assert.ok(freeAt < deleteAt,
    'the partner must be freed while this row is still readable; after the delete ' +
    'its joint ids are gone and there is nothing left to match on');
});

test('it goes through the ordinary update path, so the partner syncs', () => {
  assert.match(deleteFn, /updateFenceRun\(freed\)/,
    'freeing a partner must use updateFenceRun -- a direct dao write would not mark ' +
    'the row to push and the office would never learn the joint was released');
  assert.ok(!/fenceRunDao\.update\(/.test(deleteFn),
    'a raw dao update bypasses the push marking');
});

test('POSITIVE CONTROL: it still cleans up the line items it always did', () => {
  // Without this, a change that freed joints and quietly dropped the line-item
  // cleanup would pass everything above while leaving priced rows behind.
  assert.match(deleteFn, /lineItemDao\.allForRun\(run\.id\)/);
  assert.match(deleteFn, /queueDeletion\(syncId, "estimate_line_items"\)/);
});

/* ---- 2. the rule, transcribed ------------------------------------------- */
const freePartners = (deleted, others) => {
  const orphaned = new Set([deleted.startJoint, deleted.endJoint].filter(j => j && j.trim() !== ''));
  if (orphaned.size === 0) return others.map(o => ({ ...o }));
  return others.map(o => {
    if (o.id === deleted.id) return { ...o };
    const freed = { ...o };
    if (freed.startJoint && orphaned.has(freed.startJoint)) freed.startJoint = '';
    if (freed.endJoint && orphaned.has(freed.endJoint)) freed.endJoint = '';
    return freed;
  });
};

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

test('the side that shared the corner is freed', () => {
  const back = { id: 1, startJoint: '', endJoint: A };
  const left = { id: 2, startJoint: A, endJoint: '' };
  const [freedLeft] = freePartners(back, [left]);
  assert.equal(freedLeft.startJoint, '', 'the surviving side still names a run that is gone');
});

test('both of a deleted side’s corners are freed', () => {
  const back = { id: 1, startJoint: B, endJoint: A };
  const left = { id: 2, startJoint: A, endJoint: '' };
  const right = { id: 3, startJoint: '', endJoint: B };
  const out = freePartners(back, [left, right]);
  assert.equal(out[0].startJoint, '');
  assert.equal(out[1].endJoint, '');
});

test('POSITIVE CONTROL: a joint this side never held is left alone', () => {
  // The failure this guards against is a delete that clears every joint on the
  // job, silently turning two good corners into four end posts.
  const back = { id: 1, startJoint: '', endJoint: A };
  const left = { id: 2, startJoint: A, endJoint: B };
  const right = { id: 3, startJoint: B, endJoint: '' };
  const out = freePartners(back, [left, right]);
  assert.equal(out[0].startJoint, '', 'the shared corner should be freed');
  assert.equal(out[0].endJoint, B, 'the OTHER corner must survive');
  assert.equal(out[1].startJoint, B, 'and so must its partner');
});

test('a side holding no joints frees nothing', () => {
  const back = { id: 1, startJoint: '', endJoint: '' };
  const left = { id: 2, startJoint: A, endJoint: B };
  const [out] = freePartners(back, [left]);
  assert.equal(out.startJoint, A);
  assert.equal(out.endJoint, B);
});

/* ---- 3. the canary ------------------------------------------------------ */
test('CANARY: these checks fail against the code as it was', () => {
  const asItWas = src.replace(
    /\n        val orphaned = setOf[\s\S]*?\n        \}\n/,
    '\n'
  );
  assert.notEqual(asItWas, src, 'could not reproduce the old deleteFenceRun -- this canary tests nothing');
  const i = asItWas.indexOf('suspend fun deleteFenceRun(');
  const end = asItWas.indexOf('queueDeletion(syncId, "estimate_line_items")', i);
  const old = asItWas.slice(i, end + 60);
  assert.ok(!/val orphaned = setOf/.test(old),
    'the structural test would not have noticed the freeing missing, so it guards nothing');
});

console.log('a82: deleting a side frees the end it shared a post with');
