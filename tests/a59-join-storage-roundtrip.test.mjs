// a59-join-storage-roundtrip -- a join is actually RECORDED, and un-joining actually TRAVELS.
//
//   node --test tests/a59-join-storage-roundtrip.test.mjs        (no network, no writes)
//
// WHAT CHANGED. The attach gesture was 1,299 lines of decided behaviour with nowhere to put an
// answer: SurveyViewModel.jointIdsOf returned two blanks and writeJointIds returned false, so
// every confirmation ended in JoinRefusal.NO_STORAGE. The storage now exists:
// FenceRun.startJoint / endJoint (text, NOT NULL, default ''), Room schema 50
// (AppDatabase.SchemaV50), Repository.setRunJointIds, and both EntitySync pull sites.
//
// WHAT THIS FILE PINS
//   1. THE COLUMNS ARE TEXT, NOT NULL, DEFAULT EMPTY -- on the entity and in the migration --
//      and the Room version moved, because a column added to an existing entity without a
//      migration is an app that refuses to open its own database on upgrade.
//   2. NO BACKFILL. Nothing in the migration reads or rewrites a row, so a run whose ends
//      already coincide does NOT become joined and no quote already sent can move.
//   3. UN-JOINING TRAVELS. This is the half that fails silently. '' has to be SENT, not
//      omitted, or the office goes on pricing two runs as one post after he pulled them apart.
//      Modelled against the real encoder settings (encodeDefaults = true,
//      explicitNulls = false), with the opposite settings as the canary.
//   4. VALIDATE ON READ, NOT ON WRITE, and in the safe direction: the columns take any text
//      because one row a constraint refuses fails the WHOLE batched upsert, so the reader
//      blanks anything that is not a uuid -- which is a FREE end, which is MORE posts, which is
//      today's price. Asserted as a number, not as a claim.
//   5. ONE WRITE PATH. The joint is assigned in exactly two places: the sync's pull, and
//      Repository.setRunJointIds. No second write, and no joint table (RunJoin, schema 48,
//      stays inert).
//   6. THE GATES STAY HONEST. supabase_a32_join_runs.sql is unapplied, so
//      EntitySync.JOIN_COLUMNS_LIVE is false and SurveyViewModel.JOIN_STORAGE_READY is false --
//      and they are pinned to each other, because a join made while the column does not exist
//      is stranded on the handset for good (the run pushes once without it and its clock never
//      leads again).
//
// WHAT THIS FILE CANNOT DO: compile Kotlin or run it. Checks 3 and 4 model the one rule each
// (the JSON encoder, the id validator) in JavaScript and ALSO pin the Kotlin source to that same
// rule, so a model that drifts from the code is caught by the source half and a code change that
// drifts from the rule is caught by the model half. Every check carries a canary or a teeth
// mutant, because a probe that cannot fail reports zero failures for a case it never looked at.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const P = {
  entities: "app/src/main/java/com/fenceestimator/app/data/Entities.kt",
  appdb: "app/src/main/java/com/fenceestimator/app/data/AppDatabase.kt",
  repo: "app/src/main/java/com/fenceestimator/app/data/Repository.kt",
  sync: "app/src/main/java/com/fenceestimator/app/cloud/EntitySync.kt",
  vm: "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt",
  module: "app/src/main/java/com/fenceestimator/app/cloud/SupabaseModule.kt",
  scope: "app/src/main/java/com/fenceestimator/app/cloud/SyncScope.kt",
  a32: "supabase_a32_join_runs.sql",
  priceJob: "supabase/functions/price-job/index.ts",
};

const SRC = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, read(v)]));

/** The body of a Kotlin declaration, brace-matched from its signature. */
function bodyOf(text, signature) {
  const at = text.indexOf(signature);
  if (at < 0) return null;
  let i = text.indexOf("{", at);
  if (i < 0) return null;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}" && --depth === 0) return text.slice(i + 1, j);
  }
  return null;
}

// =============================================================================
test("1. the entity carries two NOT NULL text fields defaulted to empty, and nothing else", () => {
  // Non-nullable with a blank default is the whole design: a nullable field would be dropped
  // from the upsert body by explicitNulls = false and could never be CLEARED from the phone.
  assert.match(SRC.entities, /\n    val startJoint: String = "",/,
    "FenceRun.startJoint is not a non-null String defaulted to \"\"");
  assert.match(SRC.entities, /\n    val endJoint: String = "",/,
    "FenceRun.endJoint is not a non-null String defaulted to \"\"");
  assert.doesNotMatch(SRC.entities, /val (startJoint|endJoint): String\?/,
    "a joint field is nullable: a Kotlin null is LEFT OUT of the upsert body, so un-joining would not travel");

  // It landed on FenceRun and not somewhere else that happens to have the word in it.
  const fenceRun = SRC.entities.slice(SRC.entities.indexOf("data class FenceRun("));
  const decl = fenceRun.slice(0, fenceRun.indexOf("\n) {"));
  assert.ok(/val startJoint/.test(decl) && /val endJoint/.test(decl),
    "the fields are not inside FenceRun's own constructor");

  // TEETH: the nullable probe above really can fail.
  assert.match(SRC.entities.replace('val startJoint: String = ""', "val startJoint: String? = null"),
    /val (startJoint|endJoint): String\?/, "the nullable probe cannot see a nullable field");
});

// =============================================================================
test("2. Room: MIGRATION_49_50 is declared AND registered, and the 4 -> declared-version chain has no gap and no repeat", () => {
  // RE-AIMED 5 Oct 2026, following the precedent a40 already set: read the
  // version the database DECLARES rather than one typed in here. This asserted
  // `version = 50,` and went red the moment 51 landed -- the marker size
  // columns, so a house or pool is drawn to its real size -- which is an
  // entirely normal thing to do and not something this file is here to forbid.
  //
  // What it IS here for is unchanged and still checked below: that 49 -> 50
  // exists, is registered with the builder, runs SchemaV50's statements, and
  // that the chain from 4 up to whatever the version is has no gap and no
  // repeat. A phone that meets a missing step cannot open its database.
  const declared = Number((SRC.appdb.match(/version\s*=\s*(\d+),/) || [])[1]);
  assert.ok(Number.isInteger(declared) && declared >= 50,
    `the database version could not be read, or went backwards past 50: ${declared}`);
  assert.match(SRC.appdb, /MIGRATION_49_50 = object : Migration\(49, 50\)/,
    "MIGRATION_49_50 is not declared");
  assert.match(SRC.appdb, /SchemaV50\.MIGRATION_49_50_STATEMENTS/,
    "MIGRATION_49_50 does not run SchemaV50's statements");

  // Declared and NOT added to the builder is the exact shape of "the app refuses to open its
  // own database on upgrade", and it compiles perfectly.
  const builder = bodyOf(SRC.appdb, "fun getInstance(");
  // The anchor was `MIGRATION_49_50)`, which only matched while 49 -> 50 was
  // the LAST migration in the list. The moment 50 -> 51 was appended it read as
  // "declared but never registered" -- an alarming message for a list that is
  // perfectly correct. A word boundary asks the question the message asks.
  assert.ok(builder !== null && /\bMIGRATION_49_50\b/.test(builder),
    "MIGRATION_49_50 is declared but never passed to addMigrations -- a phone at 49 would throw on open");

  const chain = [...SRC.appdb.matchAll(/object : Migration\((\d+), (\d+)\)/g)]
    .map((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(chain.length > 0, "canary: no migrations were found at all");
  const byFrom = new Map(chain.map(([f, t]) => [f, t]));
  assert.equal(byFrom.size, chain.length, "two migrations start from the same version");
  let v = 4;
  while (v < declared) {
    assert.equal(byFrom.get(v), v + 1, `the chain breaks at ${v}: there is no ${v} -> ${v + 1}`);
    v++;
  }

  // 49 shipped, so it must not have changed: a phone that ran one 49 and then met a different
  // 49 refuses to open its database.
  const v49 = bodyOf(SRC.appdb, "internal object SchemaV49");
  assert.ok(v49 !== null && /ALTER TABLE `material_items` ADD COLUMN `heightFt` REAL/.test(v49),
    "SchemaV49 no longer holds exactly the statement it shipped with");
  assert.equal((v49.match(/ALTER TABLE/g) || []).length, 1,
    "a statement was appended to the already-shipped SchemaV49 instead of going into SchemaV50");

  // TEETH: each probe above fails on the mutation built for it.
  assert.doesNotMatch(SRC.appdb.replace("version = 50,", "version = 49,"), /version = 50,/);
  assert.ok(!/MIGRATION_49_50\)/.test(
    bodyOf(SRC.appdb.replace("MIGRATION_48_49, MIGRATION_49_50)", "MIGRATION_48_49)"), "fun getInstance(")),
    "the builder probe cannot see a migration left out of addMigrations");
});

// =============================================================================
test("2b. SchemaV50 adds exactly the two columns Room expects for a non-null String = \"\", and NOTHING is backfilled", () => {
  const v50 = bodyOf(SRC.appdb, "internal object SchemaV50");
  assert.ok(v50 !== null, "canary: SchemaV50 was not found");

  for (const col of ["startJoint", "endJoint"]) {
    assert.ok(
      v50.includes("ALTER TABLE `fence_runs` ADD COLUMN `" + col + "` TEXT NOT NULL DEFAULT ''"),
      `${col} is not added as TEXT NOT NULL DEFAULT '' -- Room validates the schema on open`);
  }
  assert.equal((v50.match(/ALTER TABLE/g) || []).length, 2, "SchemaV50 does more than add the two columns");

  // The column name is the Kotlin property name: this entity declares no @ColumnInfo, so Room
  // expects `startJoint`, not `start_joint` (that is the CLOUD spelling).
  assert.doesNotMatch(v50, /start_joint|end_joint/,
    "SchemaV50 uses the cloud's snake_case column name; Room expects the property name");

  // NO BACKFILL: a join takes a post out of a price. Inferring one from coordinates would change
  // quotes he has already sent.
  assert.doesNotMatch(v50, /\b(UPDATE|INSERT|DELETE|SELECT)\b/i,
    "SchemaV50 reads or rewrites rows: runs whose ends already coincide must NOT become joined");

  // TEETH: both probes can fail.
  assert.ok(!/ADD COLUMN `startJoint` TEXT NOT NULL DEFAULT ''/.test(
    v50.replace("TEXT NOT NULL DEFAULT ''", "TEXT")), "the NOT NULL probe cannot see a bare TEXT column");
  assert.match(v50 + "\n\"UPDATE fence_runs SET startJoint = 'x'\"", /\bUPDATE\b/i,
    "the backfill probe cannot see an UPDATE");
});

// =============================================================================
test("2c. the Postgres half is additive and backfills nothing either, and is still unapplied", () => {
  const part1 = SRC.a32.slice(SRC.a32.indexOf("PART 1. joining"), SRC.a32.indexOf("proof. Every row"));
  assert.ok(part1.length > 100, "canary: PART 1 of the SQL file was not found");
  assert.match(part1, /add column if not exists start_joint text not null default ''/,
    "start_joint is not text NOT NULL default empty in Postgres");
  assert.match(part1, /add column if not exists end_joint\s+text not null default ''/,
    "end_joint is not text NOT NULL default empty in Postgres");
  assert.doesNotMatch(part1.replace(/^\s*--.*$/gm, ""),
    /\b(update|insert into|delete from)\b/i,
    "the SQL backfills: a run whose ends coincide would become joined behind him");

  // Unapplied, and it says so. Whoever applies it has four other steps to take in the same
  // change (they are listed in the file); this test pins the pairing in check 6.
  assert.match(SRC.a32, /STATUS: WRITTEN, NOT APPLIED/,
    "the SQL no longer declares itself unapplied -- if it has been applied, flip EntitySync.JOIN_COLUMNS_LIVE");

  // TEETH.
  assert.match(part1 + "\nupdate public.fence_runs set start_joint = '';", /\bupdate\b/i,
    "the backfill probe cannot see an update");
});

// =============================================================================
test("3. the sync carries the joint in BOTH directions, and the pull distinguishes '' from 'no such column'", () => {
  assert.match(SRC.sync, /@SerialName\("start_joint"\) val startJoint: String\? = null,/,
    "CloudFenceRun.startJoint is not a nullable start_joint field");
  assert.match(SRC.sync, /@SerialName\("end_joint"\) val endJoint: String\? = null,/,
    "CloudFenceRun.endJoint is not a nullable end_joint field");

  // PUSH.
  const toCloud = SRC.sync.slice(SRC.sync.indexOf("private fun FenceRun.toCloud("));
  const body = toCloud.slice(0, toCloud.indexOf("\n)"));
  assert.match(body, /startJoint = if \(JOIN_COLUMNS_LIVE\) startJoint else null/,
    "toCloud does not send startJoint, or does not gate it on JOIN_COLUMNS_LIVE");
  assert.match(body, /endJoint = if \(JOIN_COLUMNS_LIVE\) endJoint else null/,
    "toCloud does not send endJoint, or does not gate it on JOIN_COLUMNS_LIVE");

  // PULL, both copies. A field in the create and not the merge arrives on a new phone and never
  // updates again -- and the reverse never arrives at all.
  const pull = bodyOf(SRC.sync, "private suspend fun pullFenceRuns(");
  assert.ok(pull !== null, "canary: pullFenceRuns was not found");
  assert.match(pull, /startJoint = row\.startJoint\.orEmpty\(\)/,
    "the pull's CREATE copy does not take start_joint");
  assert.match(pull, /endJoint = row\.endJoint\.orEmpty\(\)/,
    "the pull's CREATE copy does not take end_joint");
  assert.match(pull, /startJoint = row\.startJoint \?: existing\.startJoint/,
    "the pull's MERGE copy does not take start_joint, or lets a missing column erase a local joint");
  assert.match(pull, /endJoint = row\.endJoint \?: existing\.endJoint/,
    "the pull's MERGE copy does not take end_joint, or lets a missing column erase a local joint");

  // The merge must NOT fall back on a BLANK -- a blank from the cloud is another phone having
  // un-joined, and honouring it is the whole point of the column being text.
  assert.doesNotMatch(pull, /startJoint = row\.startJoint\.ifBlank|startJoint = row\.startJoint\.orEmpty\(\)\.ifBlank/,
    "the merge treats a cloud '' as 'nothing said', so un-joining would not arrive on this phone");

  // TEETH: the merge probe really is reading for the null-coalesce and not just the name.
  assert.ok(!/startJoint = row\.startJoint \?: existing\.startJoint/.test(
    pull.replace("startJoint = row.startJoint ?: existing.startJoint", "startJoint = row.startJoint.orEmpty()")),
    "the merge probe cannot tell `?: existing` from `.orEmpty()`");
});

// =============================================================================
test("4. UN-JOINING TRAVELS: a cleared joint is PRESENT in the pushed body as '', not absent from it", () => {
  // The two settings this depends on, read from the real files rather than assumed.
  for (const [name, text] of [["cloudJson", SRC.module], ["SyncJson", SRC.scope]]) {
    assert.match(text, /encodeDefaults = true/, `${name} does not encode defaults -- a blank joint would be OMITTED from the body and the column would keep its old value`);
    assert.match(text, /explicitNulls = false/, `${name} no longer drops nulls -- JOIN_COLUMNS_LIVE = false would then send start_joint: null to a table that has no such column`);
  }

  /**
   * kotlinx.serialization's two settings, as the phone sets them: a property equal to its
   * declared default is still written (encodeDefaults = true) and a null property is dropped
   * (explicitNulls = false). Modelled so the CONSEQUENCE can be asserted, not just the setting.
   */
  function encode(fields, { encodeDefaults = true, explicitNulls = false } = {}) {
    const out = {};
    for (const [key, { value, declaredDefault }] of Object.entries(fields)) {
      if (value === null && !explicitNulls) continue;
      if (!encodeDefaults && value === declaredDefault) continue;
      out[key] = value;
    }
    return out;
  }

  // JOIN, then UN-JOIN. The cleared value is "" -- the entity's own declared default, which is
  // exactly the value encodeDefaults = false would have thrown away.
  const joined = encode({ start_joint: { value: "8b1f0c9e-0000-4000-8000-000000000001", declaredDefault: null } });
  const unjoined = encode({ start_joint: { value: "", declaredDefault: null } });

  assert.equal(joined.start_joint, "8b1f0c9e-0000-4000-8000-000000000001");
  assert.ok("start_joint" in unjoined,
    "the cleared joint is ABSENT from the body: PostgREST would leave the column at its old value and the office would price two runs as one post forever");
  assert.equal(unjoined.start_joint, "", "the cleared joint is present but is not ''");

  // CANARY: the model can tell "present as ''" from "absent", proved by making it fail. These
  // are the two mistakes the design exists to prevent.
  const withoutDefaults = encode(
    { start_joint: { value: "", declaredDefault: "" } }, { encodeDefaults: false });
  assert.ok(!("start_joint" in withoutDefaults),
    "canary: the model cannot see a default being dropped, so the assertion above proves nothing");
  const nullable = encode({ start_joint: { value: null, declaredDefault: null } });
  assert.ok(!("start_joint" in nullable),
    "canary: the model cannot see a null being dropped -- which is why the column is text and not a nullable uuid");

  // And the Kotlin half: nothing on the write path may skip a blank. A `if (jointId.isNotBlank())`
  // anywhere in setRunJointIds is un-joining silently doing nothing.
  const write = bodyOf(SRC.repo, "suspend fun setRunJointIds(");
  assert.ok(write !== null, "canary: Repository.setRunJointIds was not found");
  assert.match(write, /if \(atEnd\) run\.copy\(endJoint = jointId\) else run\.copy\(startJoint = jointId\)/,
    "setRunJointIds does not stamp the value it was handed onto the end it was handed");
  assert.doesNotMatch(write, /jointId\.(isNotBlank|isNotEmpty|ifBlank)/,
    "setRunJointIds treats a blank joint specially: detaching would silently do nothing");

  // The detach half of the gesture asks for a blank, rather than for a removal.
  const confirm = bodyOf(SRC.vm, "fun confirmJoinOffer(");
  assert.ok(confirm !== null && /listOf\(end to ""\)/.test(confirm),
    "confirmJoinOffer does not express a detach as writing \"\" to the end");

  // TEETH.
  assert.match(write.replace("if (atEnd) run.copy", "if (jointId.isNotBlank()) run.copy"),
    /jointId\.isNotBlank/, "the blank-skipping probe cannot see a blank-skipping guard");
});

// =============================================================================
test("5. VALIDATE ON READ: unusable text reads as a FREE end, which is MORE posts, not fewer", () => {
  // The reader, as SurveyViewModel.jointIdsOf implements it.
  const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const usable = (stored) => (stored.length === 36 && UUID.test(stored) ? stored : "");

  const good = "8b1f0c9e-1111-4000-8000-000000000001";
  assert.equal(usable(good), good, "a real joint id is thrown away");
  assert.equal(usable(""), "", "a free end is not a free end");
  assert.equal(usable("not-a-uuid"), "", "arbitrary text is taken as a joint id");
  assert.equal(usable("1-1-1-1-1"), "",
    "a short non-canonical uuid form is accepted -- UUID.fromString takes it, which is why the length is checked first");
  assert.equal(usable(good + " "), "", "a padded id is accepted");

  // THE DIRECTION OF THE FAILURE, as a number. Two runs, each a straight line of two points,
  // their inner ends at one spot. liveJointOf's rule: an id is live only when at least two
  // DIFFERENT runs of the job hold it.
  const liveJoint = (runs, runId, atEnd) => {
    const run = runs.find((r) => r.id === runId);
    const id = usable(atEnd ? run.endJoint : run.startJoint);
    if (id === "") return "";
    const holders = new Set(runs.filter((r) => usable(r.startJoint) === id || usable(r.endJoint) === id).map((r) => r.id));
    return holders.size >= 2 ? id : "";
  };
  // Posts, counting only the ends: two free ends each = 4; one shared post = 3.
  const endPosts = (runs) => {
    const shared = new Set();
    let free = 0;
    for (const r of runs) for (const atEnd of [false, true]) {
      const j = liveJoint(runs, r.id, atEnd);
      if (j === "") free++; else shared.add(j);
    }
    return free + shared.size;
  };

  const valid = [
    { id: "A", startJoint: "", endJoint: good },
    { id: "B", startJoint: good, endJoint: "" },
  ];
  const garbage = [
    { id: "A", startJoint: "", endJoint: "JOINED" },
    { id: "B", startJoint: "JOINED", endJoint: "" },
  ];
  const orphaned = [
    { id: "A", startJoint: "", endJoint: good },
    { id: "B", startJoint: "", endJoint: "" },
  ];

  assert.equal(endPosts(valid), 3, "canary: a real join does not save a post, so the comparison below is meaningless");
  assert.equal(endPosts(garbage), 4, "two runs holding the same NON-UUID text are priced as joined");
  assert.equal(endPosts(orphaned), 4, "an id no other run of the job holds is priced as joined");
  assert.ok(endPosts(garbage) > endPosts(valid),
    "bad data fails toward the LOWER post count: it must fail toward today's price, which is the higher one");

  // And the Kotlin source implements that same rule, at the one seam that builds the candidates.
  const reader = bodyOf(SRC.vm, "private fun jointIdsOf(");
  assert.ok(reader !== null, "canary: jointIdsOf was not found");
  assert.match(reader, /stored\.length == 36/,
    "jointIdsOf does not check the length, so UUID.fromString's short forms get through");
  assert.match(reader, /UUID\.fromString\(stored\)/, "jointIdsOf does not check the value is a uuid");
  assert.match(reader, /usable\(run\.startJoint\) to usable\(run\.endJoint\)/,
    "jointIdsOf does not read the two entity fields through its validator");
  assert.doesNotMatch(reader, /"" to ""/, "jointIdsOf is still the stub: every run would reach the gesture with two free ends");

  // TEETH: the length probe is load-bearing, and the model agrees it is.
  assert.equal(usable("1-1-1-1-1".padEnd(36, "0")).length, 0,
    "teeth: a 36-character non-uuid is accepted by the model");
});

// =============================================================================
test("6. the gates are pinned to each other, so a join cannot be offered before it can leave the phone", () => {
  const live = /internal const val JOIN_COLUMNS_LIVE = (true|false)/.exec(SRC.sync);
  const ready = /const val JOIN_STORAGE_READY = (true|false)/.exec(SRC.vm);
  assert.ok(live !== null, "canary: EntitySync.JOIN_COLUMNS_LIVE was not found");
  assert.ok(ready !== null, "canary: SurveyViewModel.JOIN_STORAGE_READY was not found");
  const columnsLive = live[1] === "true";
  const toolOffered = ready[1] === "true";

  // The stranding rule. fence_runs pushes a run only while the phone's clock beats the cloud's,
  // so a join made before the column exists goes up WITHOUT it and that run never pushes again
  // on its own: the join is lost to the office for good, silently.
  assert.ok(!toolOffered || columnsLive,
    "the Attach tool is offered while JOIN_COLUMNS_LIVE is false: any join made now would push without the column and then never push again -- stranded on the handset with nothing to say so");

  // And the office must be able to read it before the tool ships, or the phone and the Edge
  // function price one job two ways -- which is the disagreement this whole project keeps finding.
  const officeReads = /\bstart_joint\b/.test(SRC.priceJob) && /\bend_joint\b/.test(SRC.priceJob);
  assert.ok(!toolOffered || officeReads,
    "the Attach tool is offered while price-job's RUN_COLUMNS does not select start_joint/end_joint: the office would never see a join");
  assert.ok(!officeReads || columnsLive,
    "price-job selects start_joint/end_joint but the column does not exist (JOIN_COLUMNS_LIVE is false): every price-job read would fail");

  // TEETH. The three rules above are IMPLICATIONS, so they pass trivially whenever
  // their antecedent is false. Each one therefore has to be shown to fail against a
  // source that violates it, or it is guarding nothing.
  //
  // REWRITTEN 2026-10-02, when both flags went true in one build. The old teeth built
  // their mutant by flipping JOIN_STORAGE_READY false -> true and asserting the
  // stranding rule then broke. That only worked while JOIN_COLUMNS_LIVE was false: once
  // the column is live, switching the tool on violates nothing -- correctly -- so the
  // teeth failed while every real rule passed. The fix is to mutate the OTHER side.
  //
  // The distinction matters and is why this was not simply deleted: a red gate after a
  // deliberate flip can mean the test now forbids the correct behaviour, and the cure is
  // to move the pin and say why -- never to drop the check and lose the guard with it.
  const mutantColumnsOff = SRC.sync.replace(
    /internal const val JOIN_COLUMNS_LIVE = true/, "internal const val JOIN_COLUMNS_LIVE = false");
  const mutantOfficeBlind = SRC.priceJob
    .replace(/\bstart_joint\b/g, "zz_no_such_column").replace(/\bend_joint\b/g, "zz_no_such_column");
  assert.notEqual(mutantColumnsOff, SRC.sync,
    "teeth: could not build the column-off mutant, so the stranding assertion is unproven");
  assert.notEqual(mutantOfficeBlind, SRC.priceJob,
    "teeth: could not build the office-blind mutant, so the office-reads assertion is unproven");

  const mutantColumnsLive =
    /internal const val JOIN_COLUMNS_LIVE = (true|false)/.exec(mutantColumnsOff)[1] === "true";
  const mutantOfficeReads =
    /\bstart_joint\b/.test(mutantOfficeBlind) && /\bend_joint\b/.test(mutantOfficeBlind);

  // The tool IS offered (toolOffered is true above), so each implication must now break.
  assert.equal(toolOffered, true,
    "teeth below assume the tool is on; if it has been switched back off, flip these to " +
    "mutate JOIN_STORAGE_READY instead and say why in this comment");
  assert.equal(!toolOffered || mutantColumnsLive, false,
    "teeth: the stranding assertion still passes with the tool on and the column off, so it is not checking anything");
  assert.equal(!toolOffered || mutantOfficeReads, false,
    "teeth: the office-reads assertion still passes with the tool on and price-job blind to the joint");
  assert.equal(!mutantOfficeReads || mutantColumnsLive, true,
    "control: with price-job blind AND the column off, the third rule is vacuously true -- " +
    "if this is false the rule is inverted");
});

// =============================================================================
test("7. there is ONE write path, and the retired joint table is not touched", () => {
  const files = [P.entities, P.appdb, P.repo, P.sync, P.vm,
    "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt",
    "app/src/main/java/com/fenceestimator/app/ui/runs/RunEditViewModel.kt",
    "app/src/main/java/com/fenceestimator/app/ui/estimate/EstimateViewModel.kt",
    "app/src/main/java/com/fenceestimator/app/ui/jobs/JobDetailViewModel.kt",
    "app/src/main/java/com/fenceestimator/app/ui/runs/FenceRunListViewModel.kt"];

  // Every place a joint is ASSIGNED, with the file it is in. `copy(startJoint = ...)` and
  // `startJoint = row...` both count; the entity's own declaration does not.
  const assigns = [];
  for (const f of files) {
    const text = read(f).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    for (const m of text.matchAll(/(startJoint|endJoint)\s*=/g)) {
      if (/val (startJoint|endJoint): String = ""/.test(text.slice(Math.max(0, m.index - 30), m.index + 30))) continue;
      assigns.push(f);
    }
  }
  const owners = [...new Set(assigns)].sort();
  assert.deepEqual(owners, [P.repo, P.sync].sort(),
    `a joint is assigned somewhere other than Repository.setRunJointIds and the sync's pull: ${owners.join(", ")}`);

  // TEETH: the probe finds an assignment smuggled into a screen.
  const smuggled = [];
  const planted = read(P.vm).replace("private fun jointIdsOf(", "fun sneak(r: FenceRun) = r.copy(startJoint = \"x\")\n    private fun jointIdsOf(");
  for (const m of planted.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "").matchAll(/(startJoint|endJoint)\s*=/g)) smuggled.push(m.index);
  assert.ok(smuggled.length > 0, "teeth: the one-write-path probe cannot see an assignment added to a view model");

  // SurveyViewModel goes through the repository and nowhere near a dao or the retired table.
  const write = bodyOf(SRC.vm, "private suspend fun writeJointIds(");
  assert.ok(write !== null, "canary: writeJointIds was not found");
  assert.match(write, /repository\.setRunJointIds\(/,
    "writeJointIds does not write through Repository.setRunJointIds");
  // It must refuse in exactly ONE place -- the empty list -- and otherwise report what the
  // write actually did. An extra `return false` anywhere above is the old stub in disguise:
  // the row lands and the screen still says NO_STORAGE.
  assert.match(write, /if \(writes\.isEmpty\(\)\) return false/,
    "writeJointIds' empty-list guard is gone or reworded");
  assert.equal((write.match(/return false/g) || []).length, 1,
    "writeJointIds refuses somewhere other than the empty list: a successful write would still be reported as NO_STORAGE");
  assert.match(write, /\n        return kept\n/,
    "writeJointIds does not end by returning whether the write was actually kept");
  assert.doesNotMatch(write, /runJoinDao|joinRunEnds|unjoinRunEnd|RunJoin\(/,
    "writeJointIds reaches the retired run_joins table (schema 48), which must stay inert");

  // TEETH.
  assert.match(bodyOf(SRC.vm, "private suspend fun writeJointIds(") + "repository.joinRunEnds(1, x, 2, y)",
    /joinRunEnds/, "the retired-table probe cannot see a call to it");
});
