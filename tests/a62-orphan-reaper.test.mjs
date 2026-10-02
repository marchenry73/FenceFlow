// THE 64 DELETED LINES: the orphan reaper, and the race that fed it.
//
// Run:   node tests/a62-orphan-reaper.test.mjs      (exit 0 = every check passed)
//
// =============================================================================
// WHAT HAPPENED, MEASURED
// =============================================================================
// Read off the live estimate_line_items table on 2026-10-02, read-only, with a
// positive control on every probe:
//
//   tombstoned on 2026-10-01 ........................ 66 rows, 7 jobs
//     of those, in one burst at 21:26:xx UTC ........ 64 rows, 6 jobs, 18.7 s
//   of the 66, how many named a fence run ........... 66
//   of the 66, how many were role-bearing ........... 66
//   of the 66, how many named a run that is STILL
//     LIVE in the cloud today ....................... 66
//   named a tombstoned run .......................... 0
//   named a run that never existed .................. 0
//
// So not one of the 66 was an orphan. Every one of them pointed at a fence run
// that exists right now. They were killed because of what ONE PHONE could not
// find, not because of anything that was actually missing.
//
// The mechanism, in two halves:
//
//   1. EntitySync.pullAll launched pullFenceRuns and pullJobChildren as
//      concurrent async blocks with nothing ordering them, and pullJobChildren
//      builds its run map AFTER its own network read -- so a phone that had the
//      jobs but not yet the runs got an empty map. The INSERT branch resolved
//      the run as `row.fenceRunSyncId?.let { runIdBySyncId[it] }` with no
//      fallback and no guard, and wrote fenceRunId = NULL. (The UPDATE branch
//      a few lines below always had `?: existing.fenceRunId`, which is why a
//      line the phone already held was never hit -- only a line seen for the
//      FIRST time: a fresh install, a reinstall, a phone handed a job before
//      its runs.)
//
//   2. Repository.deleteOrphanedGeneratedLineItems, called at the TOP of that
//      same block, read `fenceRunId IS NULL AND role != 'NONE'` and queued a
//      PendingDeletion for each -- which tombstones the row in Supabase. Pass 1
//      made the orphans, pass 2 killed them in the cloud, for every device and
//      for the office.
//
// A third fact that matters for the fix: the Room foreign key on
// EstimateLineItem.fenceRunId is ON DELETE CASCADE, not SET NULL (Entities.kt,
// and no migration has ever recreated that table). A run that is genuinely
// deleted therefore DELETES its lines locally -- it never leaves them with a
// null run. So the reaper's stated purpose was unreachable by the only route it
// claimed to guard, and every row it ever found was something else.
//
// =============================================================================
// WHAT THIS FILE PROVES
// =============================================================================
// Kotlin cannot be run here (no Gradle, by instruction and by memory -- 16 GB
// and concurrent builds kill each other). So the decision logic of both halves
// is transcribed below, OLD and NEW side by side, in the style the other tests
// in this folder use, and then:
//
//   A. a line naming a run this phone cannot resolve is NOT inserted with a
//      null run,
//   B. the reaper does NOT tombstone a cloud row merely because the run is
//      locally absent,
//   C. POSITIVE CONTROL -- a genuinely orphaned line is still handled: the
//      local row is still cleared, and a run deleted ON THIS DEVICE still
//      takes its cloud line rows with it. A green run cannot therefore mean
//      "the feature was switched off".
//   D. CANARY -- the same checks are run against the transcribed OLD logic and
//      asserted to FAIL there. A test that cannot fail proves nothing.
//
// and then the transcriptions are pinned to the real files, so this goes red if
// the source drifts away from what is modelled here. Comments are stripped
// before any source is matched -- three checks in one day once read a comment
// and called correct code broken.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(REPO, p), "utf8");

let passed = 0;
let failed = 0;
function ok(id, label, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok    ${id} ${label}`); }
  else { failed++; console.log(`  FAIL  ${id} ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const SYNC = "app/src/main/java/com/fenceestimator/app/cloud/EntitySync.kt";
const REPOSITORY = "app/src/main/java/com/fenceestimator/app/data/Repository.kt";
const DAOS = "app/src/main/java/com/fenceestimator/app/data/Daos.kt";
const ENTITIES = "app/src/main/java/com/fenceestimator/app/data/Entities.kt";

// Code only. A claim about behaviour must never be settled by prose that
// happens to sit beside the behaviour.
const codeOnly = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "\n").replace(/^[ \t]*\/\/.*$/gm, "").replace(/[ \t]\/\/.*$/gm, "");

/** The body of a Kotlin function, by brace counting over code-only text. */
function bodyOf(code, signature) {
  const at = code.indexOf(signature);
  if (at < 0) return null;
  const open = code.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") { depth--; if (depth === 0) return code.slice(open, i + 1); }
  }
  return null;
}

// =============================================================================
// PART 1 -- the transcribed pull decision, OLD and NEW
// =============================================================================
// EntitySync.pullJobChildren, line-item block. A cloud row is
//   { syncId, jobSyncId, fenceRunSyncId, role }
// and the phone brings
//   jobIdBySyncId   -- jobs this device has
//   runIdBySyncId   -- runs this device has, sync id -> Room id
//   localBySyncId   -- line items this device already holds
// The answer is what gets written: "skip", or an insert/update carrying the
// fenceRunId that lands in the row.

const NONE = "NONE";

/** What the code did until 2026-10-02. The insert resolved the run with no
 *  fallback and no guard; the update had `?: existing.fenceRunId`. */
function applyCloudLine_OLD(row, { jobIdBySyncId, runIdBySyncId, localBySyncId }) {
  const jobId = jobIdBySyncId[row.jobSyncId];
  if (jobId === undefined) return { action: "skip", why: "job not here" };
  const role = row.role ?? NONE;
  const existing = localBySyncId[row.syncId];
  if (existing === undefined) {
    // fenceRunId = row.fenceRunSyncId?.let { runIdBySyncId[it] }
    const runId = row.fenceRunSyncId == null ? null : (runIdBySyncId[row.fenceRunSyncId] ?? null);
    return { action: "insert", jobId, role, fenceRunId: runId };
  }
  const resolved = row.fenceRunSyncId == null ? null : (runIdBySyncId[row.fenceRunSyncId] ?? null);
  return { action: "update", jobId, role, fenceRunId: resolved ?? existing.fenceRunId };
}

/** What it does now. The insert SKIPS a role-bearing line whose named run this
 *  device cannot resolve -- the same doctrine pullJobChildren's own doc comment
 *  already stated for the job. role == NONE still lands with a null run: a
 *  hand-typed extra belongs to the job, "Other Items" is its home, and no
 *  orphan query in the app ever touches a NONE row. */
function applyCloudLine_NEW(row, { jobIdBySyncId, runIdBySyncId, localBySyncId }) {
  const jobId = jobIdBySyncId[row.jobSyncId];
  if (jobId === undefined) return { action: "skip", why: "job not here" };
  const role = row.role ?? NONE;
  const existing = localBySyncId[row.syncId];
  if (existing === undefined) {
    const namedRun = row.fenceRunSyncId ?? null;
    const resolvedRun = namedRun == null ? null : (runIdBySyncId[namedRun] ?? null);
    if (namedRun != null && resolvedRun == null && role !== NONE) {
      return { action: "skip", why: "run not here yet" };
    }
    return { action: "insert", jobId, role, fenceRunId: resolvedRun };
  }
  const resolved = row.fenceRunSyncId == null ? null : (runIdBySyncId[row.fenceRunSyncId] ?? null);
  return { action: "update", jobId, role, fenceRunId: resolved ?? existing.fenceRunId };
}

// =============================================================================
// PART 2 -- the transcribed reaper, OLD and NEW
// =============================================================================
// Repository.deleteOrphanedGeneratedLineItems over the local table.
// Predicate, unchanged: fenceRunId IS NULL AND role != 'NONE'.

/** Cleared locally AND tombstoned in the cloud. The tombstone is the delete
 *  that destroyed the 66 rows. */
function reap_OLD(localLines) {
  const hit = localLines.filter((l) => l.fenceRunId == null && l.role !== NONE);
  return { clearedLocally: hit.map((l) => l.syncId), tombstoned: hit.map((l) => l.syncId) };
}

/** Cleared locally, and nothing is sent to the cloud. An orphaned local row
 *  does not even record WHICH run it lost (fence_run_sync_id lives on the
 *  cloud row, not on EstimateLineItem), so this function cannot name the run
 *  it would be accusing -- let alone establish that the cloud has lost it. */
function reap_NEW(localLines) {
  const hit = localLines.filter((l) => l.fenceRunId == null && l.role !== NONE);
  return { clearedLocally: hit.map((l) => l.syncId), tombstoned: [] };
}

/** Repository.deleteFenceRun. The ON DELETE CASCADE removes the run's lines
 *  locally with no PendingDeletion for any of them, so the tombstones are
 *  queued here -- on the one device that positively knows they are gone. */
function deleteFenceRun_NEW(runId, localLines) {
  const goingWithIt = localLines.filter((l) => l.fenceRunId === runId);
  return {
    survivingLocal: localLines.filter((l) => l.fenceRunId !== runId),
    tombstoned: goingWithIt.map((l) => l.syncId),
  };
}

/** Before this change, deleting a run tombstoned only the run. */
function deleteFenceRun_OLD(runId, localLines) {
  return { survivingLocal: localLines.filter((l) => l.fenceRunId !== runId), tombstoned: [] };
}

// =============================================================================
// PART 3 -- the incident, replayed at its real size
// =============================================================================
// Six jobs, their runs in the cloud, 64 priced role-bearing lines. The phone
// has the jobs (JobSync ran) and NOT the runs (the concurrent pullFenceRuns has
// not landed). Two passes, because that is what it took: pass 1 inserts, pass 2
// reaps.

function incident(apply, reap) {
  const cloudRuns = [];       // runs live in the cloud
  const cloudLines = [];      // live cloud line rows
  const jobIdBySyncId = {};
  for (let j = 1; j <= 6; j++) {
    jobIdBySyncId[`job-${j}`] = j;
    cloudRuns.push({ syncId: `run-${j}`, jobSyncId: `job-${j}` });
    for (let i = 0; i < 11; i++) {
      if (cloudLines.length >= 64) break;
      cloudLines.push({
        syncId: `line-${j}-${i}`,
        jobSyncId: `job-${j}`,
        fenceRunSyncId: `run-${j}`,   // every one of the 66 named a live run
        role: "POST",                 // every one of the 66 was role-bearing
      });
    }
  }

  let local = [];                       // local estimate_line_items
  const runIdBySyncId = {};             // EMPTY: the runs have not arrived
  const tombstoned = new Set();

  for (let pass = 1; pass <= 2; pass++) {
    // The reaper runs at the TOP of the line-item block, before the pull.
    const reaped = reap(local);
    reaped.clearedLocally.forEach((id) => { local = local.filter((l) => l.syncId !== id); });
    reaped.tombstoned.forEach((id) => tombstoned.add(id));

    const localBySyncId = Object.fromEntries(local.map((l) => [l.syncId, l]));
    for (const row of cloudLines) {
      if (tombstoned.has(row.syncId)) continue;   // the cloud row is gone
      const out = apply(row, { jobIdBySyncId, runIdBySyncId, localBySyncId });
      if (out.action === "insert") {
        local.push({ syncId: row.syncId, jobId: out.jobId, role: out.role, fenceRunId: out.fenceRunId });
      }
    }
  }

  return {
    cloudLinesTotal: cloudLines.length,
    cloudLinesDestroyed: tombstoned.size,
    cloudLinesSurviving: cloudLines.length - tombstoned.size,
    localOrphansMade: local.filter((l) => l.fenceRunId == null && l.role !== NONE).length,
    cloudRunsStillLive: cloudRuns.length,
  };
}

console.log("\nA62 -- orphan reaper and the fence-run race\n");
console.log("  [1] the incident, replayed at its real size (64 lines, 6 jobs)");

const old = incident(applyCloudLine_OLD, reap_OLD);
const neu = incident(applyCloudLine_NEW, reap_NEW);

// Control on the fixture itself. If the replay did not even build 64 cloud
// rows, nothing below means anything -- an empty answer reads as good news.
ok("1.0", "control: the replay really holds 64 cloud lines and 6 live runs",
  old.cloudLinesTotal === 64 && old.cloudRunsStillLive === 6,
  `got ${old.cloudLinesTotal} lines, ${old.cloudRunsStillLive} runs`);

// D -- THE CANARY. This is the assertion that must fail against the old logic.
ok("1.1", "CANARY: against the OLD logic all 64 cloud rows are destroyed (so the canary fails there)",
  old.cloudLinesDestroyed === 64 && old.cloudLinesSurviving === 0,
  `old destroyed ${old.cloudLinesDestroyed} of ${old.cloudLinesTotal}`);

ok("1.2", "the OLD insert really did create the orphans the reaper then killed",
  incident(applyCloudLine_OLD, reap_NEW).localOrphansMade === 64,
  "with the tombstone removed but the old insert kept, 64 local orphans remain");

// A + B -- the fix.
ok("1.3", "NEW: not one cloud row is destroyed",
  neu.cloudLinesDestroyed === 0 && neu.cloudLinesSurviving === 64,
  `new destroyed ${neu.cloudLinesDestroyed}`);

ok("1.4", "NEW: no local orphan is ever created in the first place",
  neu.localOrphansMade === 0, `new made ${neu.localOrphansMade} orphans`);

// The canary, stated as the two-sided claim the brief asks for: the same check
// passes on NEW and fails on OLD. A check that passes on both is decoration.
ok("1.5", "the canary discriminates: identical check, pass on NEW and fail on OLD",
  neu.cloudLinesDestroyed === 0 && old.cloudLinesDestroyed > 0);

console.log("\n  [2] (A) a line naming an unknown run is not inserted with a null run");

const phoneWithoutRuns = { jobIdBySyncId: { "job-1": 1 }, runIdBySyncId: {}, localBySyncId: {} };
const phoneWithRuns = { jobIdBySyncId: { "job-1": 1 }, runIdBySyncId: { "run-1": 77 }, localBySyncId: {} };

const unknownRun = { syncId: "l1", jobSyncId: "job-1", fenceRunSyncId: "run-1", role: "POST" };
const a = applyCloudLine_NEW(unknownRun, phoneWithoutRuns);
ok("2.1", "skipped, not inserted", a.action === "skip", JSON.stringify(a));
ok("2.2", "and it is NOT inserted with fenceRunId = null",
  !(a.action === "insert" && a.fenceRunId == null));

const b = applyCloudLine_NEW(unknownRun, phoneWithRuns);
ok("2.3", "once the run has arrived the same row lands, attached to it",
  b.action === "insert" && b.fenceRunId === 77, JSON.stringify(b));

// Not lost, only deferred: the two-pass replay with the runs arriving between
// passes must end with every line present and attached.
(() => {
  const runIdBySyncId = {};
  let local = [];
  const row = { syncId: "l9", jobSyncId: "job-1", fenceRunSyncId: "run-1", role: "RAIL" };
  let out = applyCloudLine_NEW(row, { jobIdBySyncId: { "job-1": 1 }, runIdBySyncId, localBySyncId: {} });
  const deferred = out.action === "skip";
  runIdBySyncId["run-1"] = 42;                         // pullFenceRuns lands
  out = applyCloudLine_NEW(row, { jobIdBySyncId: { "job-1": 1 }, runIdBySyncId, localBySyncId: {} });
  if (out.action === "insert") local.push({ ...row, fenceRunId: out.fenceRunId });
  ok("2.4", "deferred on pass 1, landed and attached on pass 2",
    deferred && local.length === 1 && local[0].fenceRunId === 42);
})();

// The hand-typed extra is the one row that still lands with a null run, and it
// must, or a line the owner typed would be hidden for ever on the phone that
// lost its run. Nothing reaps it -- every orphan query is role != 'NONE'.
const typed = { syncId: "l2", jobSyncId: "job-1", fenceRunSyncId: "run-gone", role: NONE };
const t = applyCloudLine_NEW(typed, phoneWithoutRuns);
ok("2.5", "a role-NONE extra still lands, under Other Items",
  t.action === "insert" && t.fenceRunId == null, JSON.stringify(t));
ok("2.6", "and the reaper does not touch it",
  reap_NEW([{ syncId: "l2", role: NONE, fenceRunId: null }]).clearedLocally.length === 0);

// The update branch is unchanged and must stay unchanged: a line this phone
// already holds keeps its grouping when the cloud names a run it cannot
// resolve. That fallback is why the bug only ever hit first sightings.
const u = applyCloudLine_NEW(
  { syncId: "l3", jobSyncId: "job-1", fenceRunSyncId: "run-1", role: "POST" },
  { jobIdBySyncId: { "job-1": 1 }, runIdBySyncId: {}, localBySyncId: { l3: { syncId: "l3", fenceRunId: 55 } } }
);
ok("2.7", "an existing line keeps its run when the cloud names one it cannot resolve",
  u.action === "update" && u.fenceRunId === 55, JSON.stringify(u));

console.log("\n  [3] (B) the reaper does not tombstone on a local absence");

const locallyAbsent = [
  { syncId: "x1", role: "POST", fenceRunId: null },
  { syncId: "x2", role: "PANEL", fenceRunId: null },
  { syncId: "x3", role: NONE, fenceRunId: null },
  { syncId: "x4", role: "POST", fenceRunId: 7 },
];
const rNew = reap_NEW(locallyAbsent);
const rOld = reap_OLD(locallyAbsent);

ok("3.1", "nothing is tombstoned", rNew.tombstoned.length === 0, JSON.stringify(rNew.tombstoned));
ok("3.2", "CANARY: the OLD reaper tombstoned two of them", rOld.tombstoned.length === 2);
ok("3.3", "the local rows are still cleared (the feature is not switched off)",
  rNew.clearedLocally.length === 2 && rNew.clearedLocally.includes("x1") && rNew.clearedLocally.includes("x2"));
ok("3.4", "a hand-typed extra and an attached line are left alone",
  !rNew.clearedLocally.includes("x3") && !rNew.clearedLocally.includes("x4"));

console.log("\n  [4] (C) POSITIVE CONTROL -- a genuinely deleted run still cleans up");

// The real orphan case, and the reason it can never be seen as a null run
// locally: ON DELETE CASCADE. Deleting the run removes the lines; the cloud
// copies are what need collecting, and the deleting device collects them.
const beforeDelete = [
  { syncId: "g1", role: "POST", fenceRunId: 3 },
  { syncId: "g2", role: "PANEL", fenceRunId: 3 },
  { syncId: "g3", role: NONE, fenceRunId: 3 },   // the cascade takes this too
  { syncId: "g4", role: "POST", fenceRunId: 4 },
];
ok("4.0", "control: the run really has rows on it before the delete",
  beforeDelete.filter((l) => l.fenceRunId === 3).length === 3);

const del = deleteFenceRun_NEW(3, beforeDelete);
ok("4.1", "the run's lines are gone locally (the FK cascade)",
  del.survivingLocal.length === 1 && del.survivingLocal[0].syncId === "g4");
ok("4.2", "and their cloud copies ARE tombstoned -- by the device that knows",
  del.tombstoned.length === 3 && ["g1", "g2", "g3"].every((s) => del.tombstoned.includes(s)));
ok("4.3", "role is not filtered there: the cascade does not filter either",
  del.tombstoned.includes("g3"));
ok("4.4", "a line on another run is untouched", !del.tombstoned.includes("g4"));
ok("4.5", "CANARY: before this change the delete left all three cloud rows alive",
  deleteFenceRun_OLD(3, beforeDelete).tombstoned.length === 0);
// The cascade is why the reaper could never see this case: afterwards there is
// no local row with a null run at all.
ok("4.6", "after the cascade there is no locally orphaned row for a reaper to find",
  reap_NEW(del.survivingLocal).clearedLocally.length === 0);

console.log("\n  [5] the transcriptions are pinned to the real source");

const syncCode = codeOnly(read(SYNC));
const repoSrc = read(REPOSITORY);
const repoCode = codeOnly(repoSrc);
const daosCode = codeOnly(read(DAOS));
const entitiesCode = codeOnly(read(ENTITIES));

// The no-fallback resolve must survive in exactly ONE place -- the update
// branch, where it is followed by `?: existing.fenceRunId`. Any second
// occurrence is an insert path orphaning rows again.
const resolves = syncCode.match(/row\.fenceRunSyncId\?\.let \{ runIdBySyncId\[it\] \}/g) || [];
ok("5.1", "the bare run resolve appears exactly once in the code",
  resolves.length === 1, `found ${resolves.length}`);
ok("5.2", "and that one is the UPDATE branch, with its fallback",
  /row\.fenceRunSyncId\?\.let \{ runIdBySyncId\[it\] \} \?: existing\.fenceRunId/.test(syncCode));
ok("5.3", "the insert branch writes the guarded value",
  /fenceRunId = resolvedRun/.test(syncCode));
ok("5.4", "the insert branch carries the skip guard this test models",
  /if \(namedRun != null && resolvedRun == null && role != MaterialRole\.NONE\)/.test(syncCode));
ok("5.5", "pullJobChildren waits for the fence-runs pull before it reads",
  /runsPull\.join\(\)/.test(syncCode) && /val runsPull = async/.test(syncCode));

const reaperBody = bodyOf(repoCode, "suspend fun deleteOrphanedGeneratedLineItems(): Int");
ok("5.6", "control: the reaper body was actually found to read",
  reaperBody != null && reaperBody.includes("orphanedGenerated()"));
ok("5.7", "the reaper queues NO deletion of any kind",
  reaperBody != null && !/pendingDeletionDao|queueDeletion|PendingDeletion/.test(reaperBody),
  reaperBody ?? "body not found");
ok("5.8", "the reaper still deletes locally",
  reaperBody != null && /deleteOrphanedGenerated\(\)/.test(reaperBody));

const deleteRunBody = bodyOf(repoCode, "suspend fun deleteFenceRun(run: FenceRun)");
ok("5.9", "control: deleteFenceRun's body was actually found to read",
  deleteRunBody != null && deleteRunBody.includes("fenceRunDao.delete(run)"));
ok("5.10", "deleteFenceRun reads the run's lines and queues their tombstones",
  deleteRunBody != null &&
    /lineItemDao\.allForRun\(run\.id\)/.test(deleteRunBody) &&
    /queueDeletion\(syncId, "estimate_line_items"\)/.test(deleteRunBody));
ok("5.11", "allForRun exists and filters on the run alone, not on role",
  /SELECT \* FROM estimate_line_items WHERE fenceRunId = :runId"\)\s*\n\s*suspend fun allForRun/.test(daosCode));

// The predicate both reapers model, still as the DAO states it.
ok("5.12", "the orphan predicate is still fenceRunId IS NULL AND role != 'NONE'",
  /SELECT \* FROM estimate_line_items WHERE fenceRunId IS NULL AND role != 'NONE'/.test(daosCode) &&
  /DELETE FROM estimate_line_items WHERE fenceRunId IS NULL AND role != 'NONE'/.test(daosCode));

// The premise the positive control rests on. If this ever becomes SET NULL, a
// genuinely deleted run WOULD leave null-run rows behind, the reaper would have
// a real case to answer, and section 4 of this file needs rewriting.
ok("5.13", "the fenceRunId foreign key is still ON DELETE CASCADE",
  /childColumns = \["fenceRunId"\],\s*\n\s*onDelete = ForeignKey\.CASCADE/.test(entitiesCode));

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
