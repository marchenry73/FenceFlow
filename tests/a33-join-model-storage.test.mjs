// a33-join-model-storage -- joined run ends: the table, the migration, the queries and the repository's rules.
//
// WHAT THIS PROVES, and what it does not. Joining is STORAGE ONLY in this wave (app/.../data/RunJoin.kt): nothing prices
// from it, no screen calls it, nothing syncs it. Every claim below is about the storage, and each one is run against the
// REAL SQL, in SQLite with foreign keys on, built from the Kotlin sources' own statements. For each claim the file also
// shows the check can fail: the same check is run on a copy with the protection removed and must report the leak.
//
//   1  the migration (SchemaV48) builds exactly the table the RunJoin entity describes -- columns, types, nullability, the
//      three unique indexes, the cascade -- and version 48 is wired in, with no gap in the 4 -> 48 chain
//   2  the schema REFUSES nonsense: the same end twice, both ends of one run at one point, one row recorded twice, a row for a
//      run that does not exist -- and deleting a run (by id, by the reaper's raw delete on sync id, or through its job)
//      takes its rows with it. Positive controls first, so a refusal cannot be a broken fixture.
//   3  every @Query of RunJoinDao prepares against that schema and does what the header of RunJoin.kt says: a joint is live
//      only with two or more ends, a lone end reads as free, setJoint refuses (returns 0, does not throw) a second end of
//      one run at one point, IGNORE never resets a joined end
//   4  the rules of the repository's join, replayed against that SQL: three and four runs at one point, the same pair twice,
//      a join to oneself, merging two points, other jobs, closed loops, typed footage, teardown, unjoin, a deleted run
//   5  the conflicts the header describes (two phones joining the same sides, a join against a deleted run, both ends of one
//      run at one point) cannot corrupt the table
//   6  the claims of the header are true of the code: nothing outside the data layer calls this API, the table is not in
//      SyncTables.ALL, every write goes through guardWrite, no row is ever deleted by the DAO
//   7  (A33_KOTLIN=1 only) the REAL Kotlin: RunJoin.kt, AppDatabase.kt and Repository.kt are compiled with the Kotlin compiler
//      from the Gradle cache (no gradlew), and planJoin and syncIdFor are run under JUnit against the same golden table the
//      JS replay uses -- and the uuid3.ts twin the server would use -- then planJoin is broken in a scratch copy and the
//      suite must go red
//
//   node --test tests/a33-join-model-storage.test.mjs
//   A33_KOTLIN=1 node --test tests/a33-join-model-storage.test.mjs
//
// WHAT IS NOT PROVEN HERE. The Repository's own sequence (joinRunEnds / unjoinRunEnd calling the DAO inside a transaction) is
// Kotlin that only section 7 compiles, and no section runs it against a database: section 4 replays the same sequence in JS
// against the same SQL, which shows the SQL and the rules compose, not that the Kotlin transcription is right. Room's own
// annotation processor is not run (section 3 prepares every query in real SQLite instead). Nothing here touches a phone, a
// Supabase project or any other file: the database is in memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { nameUUIDFromString } from "../supabase/functions/_shared/pricing/uuid3.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KT = "app/src/main/java/com/fenceestimator/app/";
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** Kotlin with comments removed, so prose cannot satisfy a check about code. */
const stripKt = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

/** The text of `needle`, replaced once -- a mutation. It must exist exactly once or the sabotage proves nothing. */
function mutate(text, needle, replacement) {
  assert.equal(text.split(needle).length, 2, "sabotage anchor must appear exactly once: " + needle.slice(0, 70));
  return text.replace(needle, () => replacement);
}

/** Split `s` at top-level commas (not inside parens, brackets, braces or quotes). */
function splitTop(s) {
  const out = []; let depth = 0, cur = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === "\\") { cur += s[++i]; } else if (c === '"') q = false; continue; }
    if (c === '"') { q = true; cur += c; continue; }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
const matching = (s, open) => { let d = 0; for (let i = open; i < s.length; i++) { if (s[i] === "(") d++; else if (s[i] === ")") { d--; if (!d) return i; } } return -1; };

/** The Kotlin string list `val <name>: List<String> = listOf(...)` as real strings (pieces joined). */
function kotlinStringList(kt, name) {
  const code = stripKt(kt);
  const at = code.indexOf("val " + name);
  assert.ok(at >= 0, "list not found: " + name);
  const open = code.indexOf("listOf(", at) + "listOf".length;
  return splitTop(code.slice(open + 1, matching(code, open))).map((el) =>
    [...el.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1")).join(""));
}

// ====================================================================== 1. THE SCHEMA ==

/** What Room expects of the RunJoin entity: columns, indices and foreign keys, from the Kotlin text. */
function entityOf(runJoinKt) {
  const code = stripKt(runJoinKt);
  const at = code.indexOf("data class RunJoin(");
  assert.ok(at >= 0, "entity not found: RunJoin");
  const header = code.slice(code.lastIndexOf("@Entity(", at), at);
  const table = header.match(/tableName\s*=\s*"([^"]+)"/)[1];
  const open = code.indexOf("(", at);
  const params = splitTop(code.slice(open + 1, matching(code, open)));
  const TYPES = { String: "TEXT", Long: "INTEGER", Int: "INTEGER", Boolean: "INTEGER", Double: "REAL", Float: "REAL" };
  const columns = params.map((p) => {
    const m = p.trim().match(/^(@PrimaryKey\([^)]*\)\s*)?val\s+(\w+)\s*:\s*(\w+)(\?)?/);
    assert.ok(m, "unparsed entity parameter: " + p.trim().slice(0, 60));
    assert.ok(TYPES[m[3]], "unmapped Kotlin type " + m[3]);
    return { name: m[2], type: TYPES[m[3]], notnull: m[4] ? 0 : 1, pk: m[1] ? 1 : 0, auto: !!(m[1] && /autoGenerate\s*=\s*true/.test(m[1])) };
  });
  const indices = [...header.matchAll(/Index\(([^)]*)\)/g)].map((m) => {
    const cols = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    return { name: `index_${table}_${cols.join("_")}`, cols, unique: /unique\s*=\s*true/.test(m[1]) };
  });
  const fks = [...header.matchAll(/ForeignKey\(/g)].map((m) => {
    const open2 = m.index + m[0].length - 1;
    const body = header.slice(open2 + 1, matching(header, open2));
    return {
      parent: body.match(/entity\s*=\s*(\w+)::class/)[1],
      from: body.match(/childColumns\s*=\s*\["([^"]+)"\]/)[1],
      to: body.match(/parentColumns\s*=\s*\["([^"]+)"\]/)[1],
      onDelete: (body.match(/onDelete\s*=\s*ForeignKey\.(\w+)/) || [])[1] || "NO_ACTION",
    };
  });
  return { table, columns, indices, fks };
}

/**
 * The two tables RunJoin hangs on, as the real entities describe them. Only the columns this storage and its queries read
 * are created, and pinCheck() holds each of them to Entities.kt so the parent cannot drift from the real one unnoticed.
 */
const PARENTS = [
  "CREATE TABLE `jobs` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL)",
  "CREATE TABLE `fence_runs` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `syncId` TEXT NOT NULL, `jobId` INTEGER NOT NULL, " +
    "`sortOrder` INTEGER NOT NULL, `closedLoop` INTEGER NOT NULL, `isTeardown` INTEGER NOT NULL, `manualLinearFeet` REAL, " +
    "FOREIGN KEY(`jobId`) REFERENCES `jobs`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )",
];

/** Violations of "the parent tables in this file are what Entities.kt says". Empty is good. */
function parentViolations(entitiesKt) {
  const code = stripKt(entitiesKt);
  const bad = [];
  const at = code.indexOf("data class FenceRun(");
  if (at < 0) return ["FenceRun not found in Entities.kt"];
  const header = code.slice(code.lastIndexOf("@Entity(", at), at);
  if (!/tableName\s*=\s*"fence_runs"/.test(header)) bad.push("FenceRun is no longer the fence_runs table");
  if (!/ForeignKey\(\s*entity\s*=\s*Job::class,\s*parentColumns\s*=\s*\["id"\],\s*childColumns\s*=\s*\["jobId"\],\s*onDelete\s*=\s*ForeignKey\.CASCADE\s*\)/.test(header)) bad.push("fence_runs no longer cascades from jobs");
  const open = code.indexOf("(", at);
  const params = splitTop(code.slice(open + 1, matching(code, open))).map((p) => p.trim());
  const has = (re, what) => { if (!params.some((p) => re.test(p))) bad.push("FenceRun has no longer " + what); };
  has(/^@PrimaryKey\(autoGenerate = true\) val id: Long\b/, "an autogenerated Long id");
  has(/^val syncId: String\b/, "val syncId: String");
  has(/^val jobId: Long\b/, "val jobId: Long");
  has(/^val sortOrder: Int\b/, "val sortOrder: Int");
  has(/^val closedLoop: Boolean\b/, "val closedLoop: Boolean");
  has(/^val isTeardown: Boolean\b/, "val isTeardown: Boolean");
  has(/^val manualLinearFeet: Float\?/, "val manualLinearFeet: Float?");
  const jobAt = code.indexOf("data class Job(");
  const jobHeader = code.slice(code.lastIndexOf("@Entity(", jobAt), jobAt);
  if (!/tableName\s*=\s*"jobs"/.test(jobHeader)) bad.push("Job is no longer the jobs table");
  return bad;
}

test("the parent tables used here are what Entities.kt says (FenceRun's columns and its cascade from jobs)", () => {
  assert.deepEqual(parentViolations(read(KT + "data/Entities.kt")), []);
});

test("TEETH: the parent check turns red if FenceRun stops cascading from jobs or loses a column the queries read", () => {
  const ent = read(KT + "data/Entities.kt");
  assert.ok(parentViolations(mutate(ent, "    val isTeardown: Boolean = false,", "    val isTeardownX: Boolean = false,")).some((v) => /isTeardown/.test(v)));
  // The sabotage lands inside FenceRun's own annotation: an earlier entity has the same foreign key written on one line.
  const at = ent.indexOf('tableName = "fence_runs"');
  assert.ok(at > 0);
  const tail = ent.slice(at).replace("onDelete = ForeignKey.CASCADE", "onDelete = ForeignKey.NO_ACTION");   // the first one after the table name: FenceRun's
  assert.notEqual(tail, ent.slice(at), "the sabotage must change something");
  assert.ok(parentViolations(ent.slice(0, at) + tail).some((v) => /cascades/.test(v)));
});

const stmtsOf = (appDatabaseKt) => kotlinStringList(appDatabaseKt, "MIGRATION_47_48_STATEMENTS");

/** A SQLite built the way an upgraded phone's is: the parents, then the migration's statements. Foreign keys ON, as Room has them. */
function freshDb(statements) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const p of PARENTS) db.exec(p);
  for (const s of statements ?? stmtsOf(read(KT + "data/AppDatabase.kt"))) db.exec(s);
  return db;
}

/**
 * Room's CURRENT @Database version. A PIN, deliberately hardcoded rather than read out of
 * AppDatabase.kt: read from the source it could never disagree with the source, and the whole
 * point of the chain check below is that the version and the list of migrations must agree.
 *
 * MOVED 48 -> 50 on 2 Oct 2026. Not a loosening -- SchemaV48 and the run_joins table it builds are
 * BYTE-FOR-BYTE UNCHANGED (the check above still compares them to the entity field by field, and
 * "the new migration is additive..." still pins SchemaV48 at its four statements). Two later
 * migrations landed on top of it:
 *   49  material_items.heightFt -- how tall a catalog panel is, so a 6 ft run stops being priced
 *       with the 4 ft panel (engine 2026.10.2, posts and panels matched to fence height).
 *   50  fence_runs.startJoint / endJoint -- the shared post two run ends stand at, which is how
 *       two sides joined at a corner bill ONE corner post instead of two end posts.
 *   51  site_markers.widthFt / heightFt / rotationDeg -- a house, pool or driveway drawn to its
 *       real size on the plan instead of as a dot. Shipped in 1.602.
 * Bump this line, and nothing else here, when a 52 lands.
 *
 * NOTE for whoever lands the owed DROP TABLE mentioned below: it was written expecting to be
 * SchemaV51. 51 was taken by the marker sizes above, so that drop is now a 52.
 *
 * WHY THIS FILE IS STILL LOAD-BEARING even though the run_joins TABLE lost the design argument
 * (docs/JOINING_RUNS.md 11.1 chose the two columns on fence_runs; a59-join-storage-roundtrip check 7
 * pins that the table stays inert and that there is one write path). The table has NOT been dropped:
 * `RunJoin::class` is still in the @Database entity list, and Room validates EVERY registered entity
 * against the real schema when it opens the database. So an inert run_joins that stops matching its
 * entity is still an app that cannot open on upgrade. The day the owed SchemaV51 DROP TABLE lands and
 * RunJoin::class leaves that list, THIS file is replaced by a59-join-storage-roundtrip.test.mjs -- do
 * not retire it before then.
 */
const DB_VERSION = 51;

/** Differences between the RunJoin entity and a SQLite built from the migration's statements, plus the wiring. Empty is good. */
function schemaViolations(runJoinKt, appDatabaseKt) {
  const bad = [];
  const want = entityOf(runJoinKt);
  let db;
  try { db = freshDb(stmtsOf(appDatabaseKt)); } catch (e) { return ["the migration does not run in SQLite: " + e.message]; }
  const have = db.prepare(`PRAGMA table_info(\`${want.table}\`)`).all();
  if (!have.length) return [`${want.table}: not created by the migration`];
  const norm = (c) => `${c.name}|${c.type}|notnull=${c.notnull}|pk=${c.pk}`;
  const a = want.columns.map(norm).sort(), b = have.map((c) => norm({ name: c.name, type: c.type, notnull: c.notnull, pk: c.pk ? 1 : 0 })).sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) bad.push(`${want.table}: columns differ\n  entity:    ${a.join(", ")}\n  migration: ${b.join(", ")}`);
  const create = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(want.table).sql;
  for (const c of want.columns.filter((c) => c.auto)) if (!new RegExp("`" + c.name + "` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL").test(create)) bad.push(`${want.table}.${c.name}: not AUTOINCREMENT as Room generates`);
  const idx = db.prepare(`PRAGMA index_list(\`${want.table}\`)`).all().filter((i) => !i.name.startsWith("sqlite_autoindex"));
  const haveIdx = idx.map((i) => `${i.name}|${i.unique ? "unique" : "plain"}|${db.prepare(`PRAGMA index_info(\`${i.name}\`)`).all().map((x) => x.name).join(",")}`).sort();
  const wantIdx = want.indices.map((i) => `${i.name}|${i.unique ? "unique" : "plain"}|${i.cols.join(",")}`).sort();
  if (JSON.stringify(haveIdx) !== JSON.stringify(wantIdx)) bad.push(`${want.table}: indices differ\n  entity:    ${wantIdx}\n  migration: ${haveIdx}`);
  const fk = db.prepare(`PRAGMA foreign_key_list(\`${want.table}\`)`).all();
  const wantFk = want.fks.map((f) => `${f.parent === "FenceRun" ? "fence_runs" : f.parent}|${f.from}->${f.to}|${f.onDelete.replace("_", " ")}|NO ACTION`).sort();
  const haveFk = fk.map((f) => `${f.table}|${f.from}->${f.to}|${f.on_delete}|${f.on_update}`).sort();
  if (JSON.stringify(wantFk) !== JSON.stringify(haveFk)) bad.push(`${want.table}: foreign keys differ\n  entity:    ${wantFk}\n  migration: ${haveFk}`);

  // Wired in: the current version, the entity registered, the dao exposed, the migration declared and added to the builder.
  const code = stripKt(appDatabaseKt);
  if (!new RegExp(`version\\s*=\\s*${DB_VERSION}\\b`).test(code)) bad.push(`the database version is not ${DB_VERSION}`);
  if (!/EnquiryCapturePhoto::class,\s*RunJoin::class\s*\]/.test(code)) bad.push("RunJoin is not registered in @Database");
  if (!/abstract fun runJoinDao\(\): RunJoinDao/.test(code)) bad.push("the dao is not exposed");
  if (!/private val MIGRATION_47_48 = object : Migration\(47, 48\)/.test(code)) bad.push("MIGRATION_47_48 is not a Migration(47, 48)");
  if (!/SchemaV48\.MIGRATION_47_48_STATEMENTS\.forEach\s*\{\s*db\.execSQL\(it\)\s*\}/.test(code)) bad.push("MIGRATION_47_48 does not run SchemaV48's statements");
  // The chain: every step 4 -> DB_VERSION declared exactly once, named for what it does, and handed to the builder exactly once.
  const added = (code.match(/addMigrations\(([^)]*)\)/) || [])[1];
  if (!added) bad.push("no addMigrations( call found");
  else {
    const listed = [...added.matchAll(/MIGRATION_(\d+)_(\d+)/g)].map((m) => `${m[1]}_${m[2]}`);
    for (let n = 4; n < DB_VERSION; n++) {
      const name = `${n}_${n + 1}`;
      if (listed.filter((x) => x === name).length !== 1) bad.push(`MIGRATION_${name} is not handed to the builder exactly once`);
      if (!new RegExp(`private val MIGRATION_${name} = object : Migration\\(${n}, ${n + 1}\\)`).test(code)) bad.push(`MIGRATION_${name} is not declared as Migration(${n}, ${n + 1})`);
    }
    if (listed.length !== DB_VERSION - 4) bad.push(`the builder lists ${listed.length} migrations, expected the ${DB_VERSION - 4} steps from 4 to ${DB_VERSION}`);
  }
  return bad;
}

test(`the migration builds exactly the table the RunJoin entity describes, and 48 is wired into the 4 -> ${DB_VERSION} chain with no gap`, () => {
  assert.deepEqual(schemaViolations(read(KT + "data/RunJoin.kt"), read(KT + "data/AppDatabase.kt")), []);
});

test("the new migration is additive, idempotent, touches only run_joins, and repeats nothing from a shipped one", () => {
  const db = read(KT + "data/AppDatabase.kt");
  const v48 = stmtsOf(db);
  const shipped = ["MIGRATION_43_44_STATEMENTS", "MIGRATION_44_45_STATEMENTS", "MIGRATION_45_46_STATEMENTS", "MIGRATION_46_47_STATEMENTS"].flatMap((n) => kotlinStringList(db, n));
  assert.deepEqual(v48.filter((s) => shipped.includes(s)), [], "a repeated statement is a crash loop");
  assert.equal(v48.length, 4, "one table and its three indexes");
  assert.ok(v48.every((s) => /^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS/.test(s)), "every statement is an idempotent CREATE ... IF NOT EXISTS");
  assert.ok(!v48.some((s) => /\b(DROP|DELETE|UPDATE|ALTER|INSERT)\b/i.test(s.replace(/ON (UPDATE|DELETE) (NO ACTION|CASCADE)/g, ""))), "purely additive");
  const touched = new Set(v48.flatMap((s) => [...s.matchAll(/(?:TABLE IF NOT EXISTS|ON) `(\w+)`/g)].map((m) => m[1])));
  assert.deepEqual([...touched], ["run_joins"], "fence_runs, jobs and every other table are left alone");
  // Running the list twice is harmless (a phone killed half way and migrated again).
  const twice = freshDb(v48);
  for (const s of v48) twice.exec(s);
  // And an existing job with runs but no joins is untouched by it: the new table starts empty.
  const upgrade = new DatabaseSync(":memory:");
  upgrade.exec("PRAGMA foreign_keys = ON");
  for (const p of PARENTS) upgrade.exec(p);
  upgrade.exec("INSERT INTO jobs (id) VALUES (1)");
  upgrade.exec("INSERT INTO fence_runs (syncId, jobId, sortOrder, closedLoop, isTeardown) VALUES ('r1', 1, 0, 0, 0), ('r2', 1, 1, 0, 0)");
  const before = JSON.stringify(upgrade.prepare("SELECT * FROM fence_runs ORDER BY id").all());
  for (const s of v48) upgrade.exec(s);
  assert.equal(JSON.stringify(upgrade.prepare("SELECT * FROM fence_runs ORDER BY id").all()), before, "no existing run row changed");
  assert.equal(upgrade.prepare("SELECT COUNT(*) AS n FROM run_joins").get().n, 0, "no job starts with a join");
});

test("TEETH: a column missing from the migration, an extra entity field, a lost index, a lost cascade and a wrong version are each caught", () => {
  const rj = read(KT + "data/RunJoin.kt"), db = read(KT + "data/AppDatabase.kt");
  assert.ok(schemaViolations(rj, mutate(db, '"`jointId` TEXT, "', '"`jointIdX` TEXT, "')).some((v) => /columns differ|does not run/.test(v)));
  assert.ok(schemaViolations(mutate(rj, "    val jointId: String? = null,", "    val jointId: String? = null,\n    val extra: String = \"\","), db).some((v) => /columns differ/.test(v)));
  assert.ok(schemaViolations(rj, mutate(db, '"CREATE UNIQUE INDEX IF NOT EXISTS `index_run_joins_jointId_runId` ON `run_joins` (`jointId`, `runId`)"', '"CREATE INDEX IF NOT EXISTS `index_run_joins_jointId_runId` ON `run_joins` (`jointId`, `runId`)"')).some((v) => /indices differ/.test(v)));
  assert.ok(schemaViolations(rj, mutate(db, "`fence_runs`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )", "`fence_runs`(`id`) ON UPDATE NO ACTION ON DELETE NO ACTION )")).some((v) => /foreign keys differ/.test(v)));
  // The version anchor and the builder's tail both follow DB_VERSION; see the note on it for why 48 -> 50.
  assert.ok(schemaViolations(rj, mutate(db, `    version = ${DB_VERSION},`, `    version = ${DB_VERSION - 1},`)).some((v) => new RegExp(`version is not ${DB_VERSION}`).test(v)));
  // Drop 47_48 out of the builder while leaving it declared: a gap in the middle of the chain, which is
  // the case the chain check exists for (a new table left off a list is this repository's oldest bug).
  assert.ok(schemaViolations(rj, mutate(db, "MIGRATION_47_48, MIGRATION_48_49", "MIGRATION_48_49")).some((v) => new RegExp(`MIGRATION_47_48 is not handed|builder lists ${DB_VERSION - 5}`).test(v)));
  assert.ok(schemaViolations(rj, mutate(db, "EnquiryCapturePhoto::class, RunJoin::class", "EnquiryCapturePhoto::class")).some((v) => /not registered/.test(v)));
});

// ======================================================== 2. THE SCHEMA REFUSES NONSENSE ==

let seq = 0;
const addJob = (db) => Number(db.prepare("INSERT INTO jobs DEFAULT VALUES").run().lastInsertRowid);
const addRun = (db, jobId, o = {}) => Number(db.prepare(
  "INSERT INTO fence_runs (syncId, jobId, sortOrder, closedLoop, isTeardown, manualLinearFeet) VALUES (:syncId, :jobId, :sortOrder, :closedLoop, :isTeardown, :manualLinearFeet)"
).run({ syncId: "run-" + ++seq, jobId, sortOrder: seq, closedLoop: 0, isTeardown: 0, manualLinearFeet: null, ...o }).lastInsertRowid);
/** What Room's plain @Insert does: INSERT OR ABORT, so a clash throws. */
const addEnd = (db, runId, atEnd, jointId = null, o = {}) => db.prepare(
  "INSERT INTO run_joins (syncId, runId, atEnd, jointId, updatedAt) VALUES (:syncId, :runId, :atEnd, :jointId, :updatedAt)"
).run({ syncId: "end-" + ++seq, runId, atEnd, jointId, updatedAt: 1, ...o });
const countEnds = (db, runId) => db.prepare("SELECT COUNT(*) AS n FROM run_joins WHERE runId = ?").get(runId).n;
const total = (db) => db.prepare("SELECT COUNT(*) AS n FROM run_joins").get().n;

/** Each nonsense case: a valid setup, then the one write that the schema must refuse. */
const NONSENSE = {
  "the same end of a run recorded twice": (db, j) => { const r = addRun(db, j); addEnd(db, r, 0, "J1"); addEnd(db, r, 0, "J2"); },
  "the same end recorded twice, free the second time": (db, j) => { const r = addRun(db, j); addEnd(db, r, 1, null); addEnd(db, r, 1, null); },
  "both ends of one run at one point (a join to itself)": (db, j) => { const r = addRun(db, j); addEnd(db, r, 0, "J1"); addEnd(db, r, 1, "J1"); },
  "both ends of one run at one point, with other runs there too": (db, j) => {
    const a = addRun(db, j), b = addRun(db, j), c = addRun(db, j);
    addEnd(db, a, 1, "J1"); addEnd(db, b, 0, "J1"); addEnd(db, c, 0, "J1"); addEnd(db, c, 1, "J1");
  },
  "one row recorded twice under one sync id": (db, j) => { const a = addRun(db, j), b = addRun(db, j); addEnd(db, a, 0, null, { syncId: "dup" }); addEnd(db, b, 0, null, { syncId: "dup" }); },
  "an end of a run that does not exist": (db) => { addEnd(db, 987654, 0, "J1"); },
};

/** The names of the nonsense cases the schema did NOT refuse (an empty list is good), after the positive controls. */
function nonsenseAccepted(statements) {
  const accepted = [];
  for (const [name, attempt] of Object.entries(NONSENSE)) {
    const db = freshDb(statements);
    const j = addJob(db);
    // Positive control: this fixture accepts ordinary, valid joins, so a refusal below is the schema's and not the fixture's.
    const a = addRun(db, j), b = addRun(db, j);
    addEnd(db, a, 1, "CONTROL"); addEnd(db, b, 0, "CONTROL");
    addEnd(db, a, 0, null); addEnd(db, b, 1, null);
    assert.equal(total(db), 4, "control: valid rows are accepted, free ends included");
    try { attempt(db, j); accepted.push(name); } catch (e) {
      assert.match(String(e.message), /UNIQUE constraint failed|FOREIGN KEY constraint failed/, name + ": refused for the wrong reason: " + e.message);
    }
  }
  return accepted;
}

/** The deletion paths that leave a row behind, or are themselves refused (an empty list is good). */
function cascadeLeaks(statements) {
  const leaks = [];
  const world = () => {
    const db = freshDb(statements);
    const j = addJob(db), other = addJob(db);
    const a = addRun(db, j), b = addRun(db, j), c = addRun(db, other), d = addRun(db, other);
    addEnd(db, a, 1, "T1"); addEnd(db, b, 0, "T1");        // a joint of two in job 1
    addEnd(db, c, 1, "T2"); addEnd(db, d, 0, "T2");        // a joint of two in job 2, which must survive everything done to job 1
    assert.equal(total(db), 4, "control: four rows before any delete");
    return { db, j, a, b, c, d };
  };
  const survivorIntact = (w) => w.db.prepare("SELECT COUNT(*) AS n FROM run_joins WHERE runId IN (?, ?)").get(w.c, w.d).n === 2;
  const tryPath = (name, fn) => {
    const w = world();
    try { fn(w); } catch (e) { leaks.push(name + " (refused: " + e.message + ")"); return; }
    if (countEnds(w.db, w.a) !== 0) leaks.push(name + " (the deleted run's row is still there)");
    if (!survivorIntact(w)) leaks.push(name + " (it took another job's rows with it)");
  };
  tryPath("delete a run by id (Room's @Delete)", (w) => w.db.prepare("DELETE FROM fence_runs WHERE id = ?").run(w.a));
  tryPath("delete a run by sync id (the deletion reaper's raw statement)", (w) => {
    const sync = w.db.prepare("SELECT syncId FROM fence_runs WHERE id = ?").get(w.a).syncId;
    w.db.prepare("DELETE FROM fence_runs WHERE syncId IN (?)").run(sync);
  });
  tryPath("delete the job, which deletes its runs (jobDao.delete)", (w) => w.db.prepare("DELETE FROM jobs WHERE id = ?").run(w.j));
  return leaks;
}

test("the schema refuses the same end twice, both ends of one run at one point, one row twice, and a row for a run that is gone", () => {
  assert.deepEqual(nonsenseAccepted(), []);
});

test("deleting a run takes its rows with it by every path the app deletes a run, and touches nobody else's", () => {
  assert.deepEqual(cascadeLeaks(), []);
});

test("a free end, and a join of two runs, are accepted -- the schema is not just refusing everything", () => {
  const db = freshDb();
  const j = addJob(db), a = addRun(db, j), b = addRun(db, j);
  addEnd(db, a, 0, null); addEnd(db, a, 1, null);                          // both ends of one run free: NULL is not a label
  addEnd(db, b, 0, null); addEnd(db, b, 1, null);
  assert.equal(total(db), 4);
  const db2 = freshDb();
  const j2 = addJob(db2), x = addRun(db2, j2), y = addRun(db2, j2), z = addRun(db2, j2), w = addRun(db2, j2);
  addEnd(db2, x, 1, "P"); addEnd(db2, y, 0, "P"); addEnd(db2, z, 0, "P"); addEnd(db2, w, 1, "P");   // four runs at one point
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM run_joins WHERE jointId = 'P'").get().n, 4, "no cap at two (or three)");
});

test("TEETH: with an index or the cascade taken out of the migration, the same checks report exactly the leak", () => {
  const good = stmtsOf(read(KT + "data/AppDatabase.kt"));
  const without = (needle) => { const out = good.filter((s) => !s.includes(needle)); assert.equal(out.length, good.length - 1); return out; };
  assert.deepEqual(nonsenseAccepted(without("`index_run_joins_runId_atEnd`")), ["the same end of a run recorded twice", "the same end recorded twice, free the second time"]);
  assert.deepEqual(nonsenseAccepted(without("`index_run_joins_jointId_runId`")), ["both ends of one run at one point (a join to itself)", "both ends of one run at one point, with other runs there too"]);
  assert.deepEqual(nonsenseAccepted(without("`index_run_joins_syncId`")), ["one row recorded twice under one sync id"]);
  const noFk = good.map((s) => s.replace(/, FOREIGN KEY\(`runId`\)[^)]*\)[^)]*\)/, ")"));
  assert.notEqual(noFk[0], good[0], "the sabotage must change the CREATE TABLE");
  assert.deepEqual(nonsenseAccepted(noFk), ["an end of a run that does not exist"]);
  assert.equal(cascadeLeaks(noFk).length, 3, "no foreign key: all three delete paths leave the rows behind");
  const noCascade = good.map((s) => s.replace("ON DELETE CASCADE", "ON DELETE NO ACTION"));
  assert.equal(cascadeLeaks(noCascade).length, 3, "no cascade: all three delete paths are refused or leak");
});

// ================================================================== 3. THE QUERIES ==

/** Every @Query of RunJoinDao by function name: string pieces joined, in the order Room reads them. */
function daoOf(runJoinKt) {
  const code = stripKt(runJoinKt);
  const at = code.indexOf("interface RunJoinDao");
  assert.ok(at >= 0, "RunJoinDao not found");
  const end = code.indexOf("internal data class JoinPlan");
  assert.ok(end > at, "the end of RunJoinDao not found");
  const body = code.slice(at, end);
  const queries = {};
  for (const m of body.matchAll(/@Query\(/g)) {
    let i = m.index + m[0].length, sql = "";
    for (;;) {
      while (/\s/.test(body[i])) i++;
      assert.equal(body[i], '"', "a @Query is not a string literal at " + body.slice(i, i + 30));
      let j = i + 1; while (body[j] !== '"') { if (body[j] === "\\") j++; j++; }
      sql += body.slice(i + 1, j); i = j + 1;
      while (/\s/.test(body[i])) i++;
      if (body[i] === "+") { i++; continue; }
      assert.equal(body[i], ")");
      break;
    }
    queries[body.slice(i).match(/fun\s+(\w+)\(/)[1]] = sql;
  }
  return { queries, body };
}

/** What Room generates for `@Insert(onConflict = OnConflictStrategy.IGNORE)` on RunJoin. */
const ROOM_INSERT_IGNORE = "INSERT OR IGNORE INTO run_joins (syncId, runId, atEnd, jointId, updatedAt) VALUES (:syncId, :runId, :atEnd, :jointId, :updatedAt)";

function prepared(db, runJoinKt) {
  const { queries, body } = daoOf(runJoinKt);
  const q = {};
  for (const [fn, sql] of Object.entries(queries)) q[fn] = db.prepare(sql);   // throws if Room's SQLite would refuse it
  q.insertEndIfAbsent = db.prepare(ROOM_INSERT_IGNORE);
  return { q, queries, body };
}

/** Violations of the queries' rules, run in a real SQLite. Empty is good. */
function daoViolations(runJoinKt) {
  const bad = [];
  let p;
  const db = freshDb();
  try { p = prepared(db, runJoinKt); } catch (e) { return ["a query does not prepare: " + e.message]; }
  const { q, queries, body } = p;
  const expectFns = ["observeLiveForJob", "getLiveForJob", "liveJointOf", "countRunAtJoint", "setJoint"];
  for (const fn of expectFns) if (!queries[fn]) bad.push("no query named " + fn);
  if (bad.length) return bad;
  try {
    const j1 = addJob(db), j2 = addJob(db);
    const a = addRun(db, j1, { sortOrder: 2 }), b = addRun(db, j1, { sortOrder: 1 }), c = addRun(db, j1, { sortOrder: 3 }), lone = addRun(db, j1, { sortOrder: 4 });
    const x = addRun(db, j2), y = addRun(db, j2);
    // job 1: a three-way point (the T), a lone label, and a free end. Job 2: a two-way point.
    addEnd(db, a, 1, "T"); addEnd(db, b, 0, "T"); addEnd(db, c, 0, "T");
    addEnd(db, lone, 0, "L");
    addEnd(db, a, 0, null);
    addEnd(db, x, 1, "U"); addEnd(db, y, 0, "U");
    const live1 = q.getLiveForJob.all({ jobId: j1 });
    if (live1.length !== 3 || !live1.every((r) => r.jointId === "T")) bad.push("getLiveForJob: a three-way point is not returned whole, or something else came with it: " + JSON.stringify(live1.map((r) => r.jointId)));
    if (live1.some((r) => r.runId === lone)) bad.push("getLiveForJob: a lone end is read as a join (one end alone is not a post)");
    if (JSON.stringify(live1.map((r) => r.runId)) !== JSON.stringify([b, a, c])) bad.push("getLiveForJob: not in run order (sortOrder): " + JSON.stringify(live1.map((r) => r.runId)));
    if (q.getLiveForJob.all({ jobId: j2 }).length !== 2) bad.push("getLiveForJob: another job's join is missing or mixed in");
    if (JSON.stringify(q.observeLiveForJob.all({ jobId: j1 })) !== JSON.stringify(live1)) bad.push("observeLiveForJob and getLiveForJob disagree");
    const norm = (s) => s.replace(/\s+/g, " ").trim();
    if (norm(queries.observeLiveForJob) !== norm(queries.getLiveForJob)) bad.push("observeLiveForJob and getLiveForJob are not the same query");
    // The live-ness subquery must be the same everywhere it appears, or a read and a write disagree about what a join is.
    const sub = (s) => (s.match(/jointId IN \(SELECT jointId FROM run_joins WHERE jointId IS NOT NULL GROUP BY jointId HAVING COUNT\(\*\) >= 2\)/) || [])[0];
    if (!sub(queries.getLiveForJob) || sub(queries.getLiveForJob) !== sub(queries.liveJointOf)) bad.push("liveJointOf does not use the same liveness rule as the job read");
    // liveJointOf
    if (q.liveJointOf.get({ runId: a, atEnd: 1 })?.jointId !== "T") bad.push("liveJointOf: an end at a live point does not say which");
    if (q.liveJointOf.get({ runId: lone, atEnd: 0 }) !== undefined) bad.push("liveJointOf: a lone end is reported as at a point");
    if (q.liveJointOf.get({ runId: a, atEnd: 0 }) !== undefined) bad.push("liveJointOf: a free end is reported as at a point");
    if (q.liveJointOf.get({ runId: b, atEnd: 1 }) !== undefined) bad.push("liveJointOf: an end with no row is reported as at a point");
    // countRunAtJoint
    const atJoint = (jointId, runId) => Object.values(q.countRunAtJoint.get({ jointId, runId }))[0];
    if (atJoint("T", a) !== 1) bad.push("countRunAtJoint: a run at a point is not counted once");
    if (atJoint("T", lone) !== 0) bad.push("countRunAtJoint: counts a run that is not there");
    // setJoint: the guarded update
    const stampOf = (runId, atEnd) => db.prepare("SELECT updatedAt FROM run_joins WHERE runId = ? AND atEnd = ?").get(runId, atEnd).updatedAt;
    if (q.setJoint.run({ runId: b, atEnd: 0, jointId: "T2", at: 55 }).changes !== 1 || stampOf(b, 0) !== 55) bad.push("setJoint: a plain move of an end did not land and stamp");
    if (q.setJoint.run({ runId: b, atEnd: 0, jointId: null, at: 56 }).changes !== 1 || db.prepare("SELECT jointId FROM run_joins WHERE runId = ? AND atEnd = 0").get(b).jointId !== null || stampOf(b, 0) !== 56) bad.push("setJoint: freeing an end (null) did not land and stamp");
    if (countEnds(db, b) !== 1) bad.push("setJoint: freeing an end removed its row");
    if (q.setJoint.run({ runId: 987654, atEnd: 0, jointId: "T", at: 57 }).changes !== 0) bad.push("setJoint: reports a change for a run with no row");
    // both ends of one run at one point: refused with 0, nothing thrown, nothing changed
    const before = JSON.stringify(db.prepare("SELECT * FROM run_joins ORDER BY id").all());
    let refused;
    try { refused = q.setJoint.run({ runId: a, atEnd: 0, jointId: "T", at: 58 }).changes; } catch (e) { bad.push("setJoint: THROWS for both ends of a run at one point instead of answering 0: " + e.message); }
    if (refused !== undefined && refused !== 0) bad.push("setJoint: allowed both ends of one run at one point");
    if (JSON.stringify(db.prepare("SELECT * FROM run_joins ORDER BY id").all()) !== before) bad.push("setJoint: a refused change still changed a row");
    // ...and the control: the SAME change without the guard is exactly what the unique index refuses
    let threw = false;
    try { db.prepare("UPDATE run_joins SET jointId = 'T' WHERE runId = ? AND atEnd = 0").run(a); } catch { threw = true; }
    if (!threw) bad.push("control: the unguarded update was not refused by the index, so the guard above proved nothing");
    // insertEndIfAbsent: IGNORE must never reset a joined end to free
    const ign = q.insertEndIfAbsent.run({ syncId: "other-sync", runId: a, atEnd: 1, jointId: null, updatedAt: 99 });
    if (ign.changes !== 0) bad.push("insertEndIfAbsent: wrote a second row for an end that has one");
    if (q.liveJointOf.get({ runId: a, atEnd: 1 })?.jointId !== "T") bad.push("insertEndIfAbsent: reset a joined end to free");
    if (q.insertEndIfAbsent.run({ syncId: "fresh", runId: c, atEnd: 1, jointId: null, updatedAt: 99 }).changes !== 1) bad.push("insertEndIfAbsent: did not create a missing end");
  } catch (e) {
    bad.push("a query behaved in a way the rules do not allow: " + e.message);
  }
  // no removal in any spelling: an unjoin is a null, and rows go only with their run
  if (/@Delete\b/.test(body) || /\bDELETE\s+FROM\b/i.test(body) || /\bDROP\b/i.test(body) || /\bTRUNCATE\b/i.test(body)) bad.push("the join DAO can delete");
  if (!/@Insert\(onConflict = OnConflictStrategy\.IGNORE\)\s+suspend fun insertEndIfAbsent\(row: RunJoin\): Long/.test(body)) bad.push("insertEndIfAbsent is no longer @Insert(onConflict = IGNORE) returning Long");
  return bad;
}

test("every query of RunJoinDao prepares against the real schema and does what the header says", () => {
  assert.deepEqual(daoViolations(read(KT + "data/RunJoin.kt")), []);
});

test("TEETH: a read that shows a lone end as a join, a guard that is gone, a dropped order and a delete are each caught", () => {
  const rj = read(KT + "data/RunJoin.kt");
  const live = '"GROUP BY jointId HAVING COUNT(*) >= 2) " +\n            "ORDER BY r.sortOrder ASC, r.syncId ASC, rj.atEnd ASC"\n    )\n    suspend fun getLiveForJob';
  assert.ok(daoViolations(mutate(rj, live, live.replace("COUNT(*) >= 2", "COUNT(*) >= 1"))).some((v) => /lone end is read as a join|disagree|not the same query/.test(v)));
  assert.ok(daoViolations(mutate(rj, '"AND (:jointId IS NULL OR NOT EXISTS (SELECT 1 FROM run_joins o " +', '"AND (1 = 1 OR NOT EXISTS (SELECT 1 FROM run_joins o " +')).some((v) => /setJoint|behaved/.test(v)));
  assert.ok(daoViolations(mutate(rj, '"ORDER BY r.sortOrder ASC, r.syncId ASC, rj.atEnd ASC"\n    )\n    fun observeLiveForJob', '"ORDER BY rj.atEnd DESC"\n    )\n    fun observeLiveForJob')).some((v) => /disagree|not the same/.test(v)));
  assert.ok(daoViolations(mutate(rj, "    suspend fun countRunAtJoint(jointId: String, runId: Long): Int\n", "    suspend fun countRunAtJoint(jointId: String, runId: Long): Int\n\n    @Query(\"DELETE FROM run_joins WHERE runId = :runId\")\n    suspend fun gone(runId: Long): Int\n")).some((v) => /can delete/.test(v)));
  assert.ok(daoViolations(mutate(rj, "@Insert(onConflict = OnConflictStrategy.IGNORE)", "@Insert(onConflict = OnConflictStrategy.REPLACE)")).some((v) => /insertEndIfAbsent/.test(v)));
  assert.ok(daoViolations(mutate(rj, '"SELECT jointId FROM run_joins WHERE runId = :runId AND atEnd = :atEnd AND jointId IS NOT NULL " +\n            "AND jointId IN (SELECT jointId FROM run_joins WHERE jointId IS NOT NULL " +\n            "GROUP BY jointId HAVING COUNT(*) >= 2)"', '"SELECT jointId FROM run_joins WHERE runId = :runId AND atEnd = :atEnd AND jointId IS NOT NULL"')).some((v) => /liveJointOf/.test(v)));
});

// ======================================================= 4. THE REPOSITORY'S RULES, REPLAYED ==

/** planJoin of RunJoin.kt, line for line. The golden table below holds it to the real Kotlin when A33_KOTLIN=1. */
function planJoinJs(runA, runB, jointA, jointB, runBAlreadyAtA, runAAlreadyAtB, newJointId) {
  const R = (result, jointId = null) => ({ result, jointId });
  if (!runA || !runB) return R("RUN_NOT_FOUND");
  if (runA.id === runB.id) return R("SAME_RUN");
  if (runA.jobId !== runB.jobId) return R("DIFFERENT_JOBS");
  if (runA.closedLoop || runB.closedLoop) return R("CLOSED_LOOP");
  if ((runA.manualLinearFeet ?? 0) > 0 || (runB.manualLinearFeet ?? 0) > 0) return R("TYPED_FOOTAGE");
  if (runA.isTeardown !== runB.isTeardown) return R("TEARDOWN_MISMATCH");
  if (jointA != null && jointA === jointB) return R("ALREADY_JOINED");
  if (jointA != null && jointB != null) return R("AT_ANOTHER_POINT");
  if (jointA != null) return runBAlreadyAtA ? R("SAME_RUN") : R("JOINED", jointA);
  if (jointB != null) return runAAlreadyAtB ? R("SAME_RUN") : R("JOINED", jointB);
  return R("JOINED", newJointId);
}

const r = (id, o = {}) => ({ id, jobId: 1, closedLoop: false, manualLinearFeet: null, isTeardown: false, ...o });
/** [name, runA, runB, jointA, jointB, runBAlreadyAtA, runAAlreadyAtB, expected result, expected jointId] -- newJointId is always "NEW". */
const PLAN_CASES = [
  ["two free ends of two runs join at a new point", r(1), r(2), null, null, false, false, "JOINED", "NEW"],
  ["the third run takes the point two are at (A free, B at P)", r(3), r(2), null, "P", false, false, "JOINED", "P"],
  ["the third run takes the point two are at (A at P, B free)", r(2), r(3), "P", null, false, false, "JOINED", "P"],
  ["both already at the same point: nothing to do", r(1), r(2), "P", "P", false, false, "ALREADY_JOINED", null],
  ["both at different points: refused, never merged", r(1), r(2), "P", "Q", false, false, "AT_ANOTHER_POINT", null],
  ["two ends of one run", r(1), r(1), null, null, false, false, "SAME_RUN", null],
  ["B's other end is already at A's point", r(1), r(2), "P", null, true, false, "SAME_RUN", null],
  ["A's other end is already at B's point", r(1), r(2), null, "P", false, true, "SAME_RUN", null],
  ["a run that is not there (A)", null, r(2), null, null, false, false, "RUN_NOT_FOUND", null],
  ["a run that is not there (B)", r(1), null, null, null, false, false, "RUN_NOT_FOUND", null],
  ["runs of different jobs", r(1), r(2, { jobId: 9 }), null, null, false, false, "DIFFERENT_JOBS", null],
  ["a closed loop (A)", r(1, { closedLoop: true }), r(2), null, null, false, false, "CLOSED_LOOP", null],
  ["a closed loop (B)", r(1), r(2, { closedLoop: true }), null, null, false, false, "CLOSED_LOOP", null],
  ["typed footage (A)", r(1, { manualLinearFeet: 120 }), r(2), null, null, false, false, "TYPED_FOOTAGE", null],
  ["typed footage of nought is not typed footage", r(1, { manualLinearFeet: 0 }), r(2), null, null, false, false, "JOINED", "NEW"],
  ["the old fence to the new fence", r(1, { isTeardown: true }), r(2), null, null, false, false, "TEARDOWN_MISMATCH", null],
  ["old fence to old fence is fine", r(1, { isTeardown: true }), r(2, { isTeardown: true }), null, null, false, false, "JOINED", "NEW"],
  ["not found beats every other reason", null, null, "P", "Q", true, true, "RUN_NOT_FOUND", null],
  ["same run beats different points", r(1), r(1), "P", "Q", false, false, "SAME_RUN", null],
  ["a closed loop beats already joined", r(1, { closedLoop: true }), r(2), "P", "P", false, false, "CLOSED_LOOP", null],
];

test("the golden table of join decisions, against the JS replay of planJoin", () => {
  for (const [name, a, b, ja, jb, bAtA, aAtB, result, jointId] of PLAN_CASES) {
    const got = planJoinJs(a, b, ja, jb, bAtA, aAtB, "NEW");
    assert.deepEqual(got, { result, jointId }, name);
  }
  assert.ok(PLAN_CASES.length >= 19);
});

const ENDS = { START: 0, END: 1 };

/** The Repository's joinRunEnds / unjoinRunEnd, as the SQL they call, in order. Not the Kotlin: see the header of this file. */
function repoOn(db, clock = { t: 1000 }) {
  const { q } = prepared(db, read(KT + "data/RunJoin.kt"));
  const runRow = (id) => {
    const row = db.prepare("SELECT * FROM fence_runs WHERE id = ?").get(id);
    return row ? { id: Number(row.id), jobId: Number(row.jobId), syncId: row.syncId, closedLoop: !!row.closedLoop, manualLinearFeet: row.manualLinearFeet, isTeardown: !!row.isTeardown } : null;
  };
  const jointOf = (runId, atEnd) => q.liveJointOf.get({ runId, atEnd })?.jointId ?? null;
  const countAt = (jointId, runId) => Object.values(q.countRunAtJoint.get({ jointId, runId }))[0];
  const writeEnd = (run, atEnd, jointId, at) => {
    q.insertEndIfAbsent.run({ syncId: "sync:" + run.syncId + ":" + atEnd, runId: run.id, atEnd, jointId: null, updatedAt: at });
    if (q.setJoint.run({ runId: run.id, atEnd, jointId, at }).changes !== 1) throw new Error("run end could not be put at its point");
  };
  const tx = (fn) => { db.exec("BEGIN"); try { const out = fn(); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } };
  return {
    join(runIdA, endA, runIdB, endB, label = "L-" + randomUUID()) {
      return tx(() => {
        const A = ENDS[endA], B = ENDS[endB];
        const runA = runRow(runIdA), runB = runRow(runIdB);
        const jointA = jointOf(runIdA, A), jointB = jointOf(runIdB, B);
        const plan = planJoinJs(runA, runB, jointA, jointB, jointA != null && countAt(jointA, runIdB) > 0, jointB != null && countAt(jointB, runIdA) > 0, label);
        if (plan.result === "JOINED" && plan.jointId && runA && runB) {
          const now = ++clock.t;
          if (jointA !== plan.jointId) writeEnd(runA, A, plan.jointId, now);
          if (jointB !== plan.jointId) writeEnd(runB, B, plan.jointId, now);
        }
        return plan.result;
      });
    },
    unjoin(runId, end) {
      return tx(() => { const joined = jointOf(runId, ENDS[end]) != null; return joined && q.setJoint.run({ runId, atEnd: ENDS[end], jointId: null, at: ++clock.t }).changes === 1; });
    },
    live: (jobId) => q.getLiveForJob.all({ jobId }).map((row) => ({ runId: Number(row.runId), atEnd: Number(row.atEnd), jointId: row.jointId })),
    /** The points of a job as sets of "runId.START/END", the way a screen would group them. */
    points(jobId) {
      const by = new Map();
      for (const row of this.live(jobId)) { if (!by.has(row.jointId)) by.set(row.jointId, []); by.get(row.jointId).push(`${row.runId}.${row.atEnd ? "END" : "START"}`); }
      return [...by.values()].map((v) => v.sort()).sort((x, y) => x[0].localeCompare(y[0]));
    },
    q, runRow,
  };
}

test("two runs joined end to start become one point; the same pair again, either way round, writes nothing", () => {
  const db = freshDb(); const repo = repoOn(db);
  const j = addJob(db), a = addRun(db, j), b = addRun(db, j);
  assert.deepEqual(repo.points(j), [], "a job with no joins reads no points");
  assert.equal(total(db), 0);
  assert.equal(repo.join(a, "END", b, "START"), "JOINED");
  assert.deepEqual(repo.points(j), [[`${a}.END`, `${b}.START`]]);
  assert.equal(total(db), 2);
  const rows = JSON.stringify(db.prepare("SELECT * FROM run_joins ORDER BY id").all());
  assert.equal(repo.join(a, "END", b, "START"), "ALREADY_JOINED");
  assert.equal(repo.join(b, "START", a, "END"), "ALREADY_JOINED", "the pair the other way round is the same pair");
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM run_joins ORDER BY id").all()), rows, "not one byte of the table changed, stamps included");
  assert.equal(total(db), 2, "the same pair is never recorded twice");
});

test("THREE and FOUR runs at one point: the third and fourth simply take the point; nothing caps it at two", () => {
  const db = freshDb(); const repo = repoOn(db);
  const j = addJob(db), a = addRun(db, j), b = addRun(db, j), c = addRun(db, j), d = addRun(db, j), e = addRun(db, j);
  assert.equal(repo.join(a, "END", b, "START"), "JOINED");
  assert.equal(repo.join(c, "START", a, "END"), "JOINED", "the side run into the back fence: the third end");
  assert.deepEqual(repo.points(j), [[`${a}.END`, `${b}.START`, `${c}.START`]]);
  assert.equal(repo.join(b, "START", d, "END"), "JOINED", "and a fourth");
  assert.equal(repo.points(j).length, 1, "still one point");
  assert.equal(repo.points(j)[0].length, 4);
  assert.equal(new Set(repo.live(j).map((x) => x.jointId)).size, 1, "one label for all four");
  assert.equal(repo.join(e, "START", a, "END"), "JOINED", "and a fifth: the schema has no cap");
  assert.equal(repo.points(j)[0].length, 5);
});

test("what the third end may NOT do: a run at a point it is already at, and a join that would merge two points", () => {
  const db = freshDb(); const repo = repoOn(db);
  const j = addJob(db), a = addRun(db, j), b = addRun(db, j), c = addRun(db, j), d = addRun(db, j);
  const snapshot = () => JSON.stringify(db.prepare("SELECT * FROM run_joins ORDER BY id").all());
  const grouped = (points) => points.map((p) => [...p].sort()).sort((x, y) => x.join().localeCompare(y.join()));
  repo.join(a, "END", b, "START");
  const before = snapshot();
  assert.equal(repo.join(b, "END", a, "END"), "SAME_RUN", "B's other end joining the point B is already at: a run is at a point once");
  assert.equal(repo.join(a, "START", b, "START"), "SAME_RUN", "A's free end joining B's point, where A is already");
  assert.equal(repo.join(a, "START", a, "END"), "SAME_RUN", "an end of a run joined to the other end of the same run");
  assert.equal(snapshot(), before, "refusals write nothing");
  repo.join(c, "END", d, "START");
  const two = snapshot();
  assert.equal(repo.join(a, "END", c, "END"), "AT_ANOTHER_POINT", "two points are not merged by accident");
  assert.equal(snapshot(), two, "the refusal wrote nothing");
  assert.deepEqual(grouped(repo.points(j)), grouped([[`${a}.END`, `${b}.START`], [`${c}.END`, `${d}.START`]]));
  // the deliberate way: unjoin one end, then join it to the other point
  assert.equal(repo.unjoin(c, "END"), true);
  assert.equal(repo.join(c, "END", a, "END"), "JOINED");
  assert.deepEqual(grouped(repo.points(j)), grouped([[`${a}.END`, `${b}.START`, `${c}.END`]]), "the other point's last end is alone, so it reads as free");
});

test("a run that is not joinable is refused, and nothing is written: other jobs, closed loops, typed footage, teardown, a run that is gone", () => {
  const db = freshDb(); const repo = repoOn(db);
  const j = addJob(db), k = addJob(db);
  const a = addRun(db, j), other = addRun(db, k), closed = addRun(db, j, { closedLoop: 1 }), typed = addRun(db, j, { manualLinearFeet: 80 }), old = addRun(db, j, { isTeardown: 1 });
  assert.equal(repo.join(a, "END", other, "START"), "DIFFERENT_JOBS");
  assert.equal(repo.join(a, "END", closed, "START"), "CLOSED_LOOP");
  assert.equal(repo.join(a, "END", typed, "START"), "TYPED_FOOTAGE");
  assert.equal(repo.join(a, "END", old, "START"), "TEARDOWN_MISMATCH");
  assert.equal(repo.join(a, "END", 987654, "START"), "RUN_NOT_FOUND");
  assert.equal(total(db), 0, "none of the refusals wrote a row");
  const old2 = addRun(db, j, { isTeardown: 1 });
  assert.equal(repo.join(old, "END", old2, "START"), "JOINED", "positive control: the same fixture joins when it is allowed to");
});

test("unjoining frees an end without deleting anything; a point that falls to one end reads as free; it can be joined again", () => {
  const db = freshDb(); const repo = repoOn(db);
  const j = addJob(db), a = addRun(db, j), b = addRun(db, j), c = addRun(db, j);
  repo.join(a, "END", b, "START"); repo.join(c, "START", a, "END");
  assert.equal(total(db), 3);
  assert.equal(repo.unjoin(c, "START"), true);
  assert.deepEqual(repo.points(j), [[`${a}.END`, `${b}.START`]], "the other two are still joined");
  assert.equal(repo.unjoin(c, "START"), false, "unjoining an end that is free says so and writes nothing");
  assert.equal(repo.unjoin(a, "END"), true);
  assert.deepEqual(repo.points(j), [], "one end alone at a label is not a point");
  assert.equal(total(db), 3, "no row was deleted by any of it");
  assert.equal(repo.join(a, "END", b, "START"), "JOINED", "and the same two can be joined again");
  assert.deepEqual(repo.points(j), [[`${a}.END`, `${b}.START`]]);
});

test("deleting a run takes its rows; the rest of its point stays a point if two or more remain, and reads as free if not", () => {
  const db = freshDb(); const repo = repoOn(db);
  const j = addJob(db), a = addRun(db, j), b = addRun(db, j), c = addRun(db, j), d = addRun(db, j);
  repo.join(a, "END", b, "START"); repo.join(c, "START", a, "END");
  db.prepare("DELETE FROM fence_runs WHERE id = ?").run(c);
  assert.deepEqual(repo.points(j), [[`${a}.END`, `${b}.START`]], "a point of three that loses a run is a point of two");
  db.prepare("DELETE FROM fence_runs WHERE id = ?").run(b);
  assert.deepEqual(repo.points(j), [], "a point of two that loses a run reads as free, with no dangling reference to read");
  assert.equal(total(db), 1, "the survivor's row is still there, alone");
  assert.equal(repo.join(a, "END", d, "START"), "JOINED", "the lone end can be joined to a new run (its stale label is simply replaced)");
  assert.deepEqual(repo.points(j), [[`${a}.END`, `${d}.START`]]);
});

// ========================================================================== 5. CONFLICTS ==

/** Two phones that start from the same job: same runs, same local ids, same sync ids. */
function twoPhones() {
  const mk = () => { const db = freshDb(); const j = addJob(db); return { db, j, repo: repoOn(db, { t: 0 }) }; };
  const p1 = mk(), p2 = mk();
  seq += 100;
  const ids = [];
  for (const n of ["A", "B", "C", "D"]) {
    const o = { syncId: "shared-run-" + n };
    ids.push([addRun(p1.db, p1.j, o), addRun(p2.db, p2.j, o)]);
  }
  for (const [x, y] of ids) assert.equal(x, y, "the phones must hold the same local ids for the same runs");
  return { p1, p2, run: Object.fromEntries(["A", "B", "C", "D"].map((n, i) => [n, ids[i][0]])) };
}
/** The pull, as the header says it must work: take a row only where the run exists and the other phone's stamp is newer; use setJoint. */
function pull(into, from) {
  const mine = prepared(into.db, read(KT + "data/RunJoin.kt")).q;
  const results = [];
  for (const row of from.db.prepare("SELECT rj.*, r.syncId AS runSyncId FROM run_joins rj JOIN fence_runs r ON r.id = rj.runId").all()) {
    const local = into.db.prepare("SELECT id FROM fence_runs WHERE syncId = ?").get(row.runSyncId);
    if (!local) { results.push("skipped (no such run here)"); continue; }
    const mineRow = into.db.prepare("SELECT * FROM run_joins WHERE runId = ? AND atEnd = ?").get(local.id, row.atEnd);
    if (mineRow && mineRow.updatedAt >= row.updatedAt) { results.push("kept mine"); continue; }
    mine.insertEndIfAbsent.run({ syncId: row.syncId, runId: local.id, atEnd: row.atEnd, jointId: null, updatedAt: 0 });
    results.push(mine.setJoint.run({ runId: local.id, atEnd: row.atEnd, jointId: row.jointId, at: row.updatedAt }).changes === 1 ? "took" : "refused");
  }
  return results;
}

test("CONFLICT: both phones join the same two sides offline -- the merge is one join, and a split read as free, never as a post that is not there", () => {
  const { p1, p2, run } = twoPhones();
  assert.equal(p1.repo.join(run.A, "END", run.B, "START", "LABEL-FROM-PHONE-1"), "JOINED");
  // phone 2 joins later by the clock, so its two rows are the newer ones
  const repo2 = repoOn(p2.db, { t: 5000 });
  assert.equal(repo2.join(run.A, "END", run.B, "START", "LABEL-FROM-PHONE-2"), "JOINED");
  // a sync that carries both rows of the join together: phone 1 takes phone 2's two rows
  assert.deepEqual(pull(p1, p2), ["took", "took"]);
  assert.deepEqual(p1.repo.points(p1.j), [[`${run.A}.END`, `${run.B}.START`]], "one join, not two and not none");
  assert.equal(new Set(p1.repo.live(p1.j).map((x) => x.jointId)).size, 1);
  assert.equal(total(p1.db), 2, "still one row per end");
  // the adversarial interleaving: only one of the two rows crossed. Both ends then hold different labels.
  const q = twoPhones();
  q.p1.repo.join(q.run.A, "END", q.run.B, "START", "L1");
  repoOn(q.p2.db, { t: 5000 }).join(q.run.A, "END", q.run.B, "START", "L2");
  const only = q.p2.db.prepare("SELECT rj.*, r.syncId AS runSyncId FROM run_joins rj JOIN fence_runs r ON r.id = rj.runId WHERE rj.atEnd = 1").all();   // A's END row only
  assert.equal(only.length, 1);
  const mine = prepared(q.p1.db, read(KT + "data/RunJoin.kt")).q;
  assert.equal(mine.setJoint.run({ runId: q.run.A, atEnd: 1, jointId: only[0].jointId, at: only[0].updatedAt }).changes, 1);
  assert.deepEqual(q.p1.repo.points(q.p1.j), [], "split labels read as no join: the old, higher bill, and nothing crashed or half joined");
  assert.equal(total(q.p1.db), 2);
});

test("CONFLICT: one phone joins while another deletes a run -- a row for a run that is gone cannot be stored, and skipping it leaves a consistent table", () => {
  const { p1, p2, run } = twoPhones();
  p1.repo.join(run.A, "END", run.B, "START", "J1");
  p2.db.prepare("DELETE FROM fence_runs WHERE id = ?").run(run.B);
  // phone 2 pulls phone 1's rows: B's run is gone here, so B's row is skipped as every other child of a run is; A's row lands alone
  assert.deepEqual(pull(p2, p1).sort(), ["skipped (no such run here)", "took"]);
  assert.deepEqual(p2.repo.points(p2.j), [], "A's end is alone at the label: free");
  assert.equal(total(p2.db), 1);
  // the control: NOT skipping is loud, never silent -- the schema refuses a row for a run that is gone
  assert.throws(() => addEnd(p2.db, run.B, 0, "J1"), /FOREIGN KEY constraint failed/);
  // and the other direction: phone 1 pulls a deletion by deleting the run, which takes its rows
  p1.db.prepare("DELETE FROM fence_runs WHERE syncId = ?").run("shared-run-B");
  assert.equal(total(p1.db), 1);
  assert.deepEqual(p1.repo.points(p1.j), []);
});

test("CONFLICT: two phones put the two ends of one run at one point -- the pull is refused by setJoint (0), not thrown, and the table stays valid", () => {
  const { p1, p2, run } = twoPhones();
  // both phones start with the point {A.END, B.START}
  p1.repo.join(run.A, "END", run.B, "START", "SHARED");
  assert.deepEqual(pull(p2, p1), ["took", "took"]);
  assert.deepEqual(p2.repo.points(p2.j), [[`${run.A}.END`, `${run.B}.START`]]);
  // phone 1 puts C's start there; phone 2 puts C's END there
  assert.equal(p1.repo.join(run.C, "START", run.A, "END"), "JOINED");
  const repo2 = repoOn(p2.db, { t: 9000 });
  assert.equal(repo2.join(run.C, "END", run.A, "END"), "JOINED");
  const results = pull(p2, p1);   // phone 2 now meets phone 1's C.START at SHARED, while its own C.END is already at SHARED
  assert.ok(results.includes("refused"), "the second end of the run is refused: " + results.join(", "));
  const points = p2.repo.points(p2.j);
  assert.equal(points.length, 1);
  assert.equal(points[0].filter((x) => x.startsWith(run.C + ".")).length, 1, "run C is at the point once, never twice");
  // the control: the unguarded form of that same pull throws, which is what would wedge a sync
  assert.throws(() => p2.db.prepare("UPDATE run_joins SET jointId = (SELECT jointId FROM run_joins WHERE runId = ? AND atEnd = 1) WHERE runId = ? AND atEnd = 0").run(run.C, run.C), /UNIQUE constraint failed/);
});

// ========================================================== 6. THE HEADER'S CLAIMS ARE TRUE ==

const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const OWN = new Set(["data/RunJoin.kt", "data/AppDatabase.kt", "data/Repository.kt"]);
const API = /\b(RunJoin|RunJoinDao|runJoinDao|RunEnd|JoinResult|JoinPlan|planJoin|joinRunEnds|unjoinRunEnd|getRunJoins|observeRunJoins|run_joins|SchemaV48)\b/;

/** Files that use the join API without being its three owners. The header of RunJoin.kt says there are none. */
function reachViolations(files) {
  return files.filter(({ rel, text }) => !OWN.has(rel) && API.test(stripKt(text))).map(({ rel }) => rel);
}
const mainKotlin = () => walk(join(ROOT, KT)).filter((p) => p.endsWith(".kt")).map((p) => ({ rel: relative(join(ROOT, KT), p).split(sep).join("/"), text: readFileSync(p, "utf8") }));

test("NOT YET REACHED: no other file calls the join API, so the price, the screens and sync cannot have changed because of it", () => {
  assert.deepEqual(reachViolations(mainKotlin()), [],
    "a file outside RunJoin.kt, AppDatabase.kt and Repository.kt now uses the join API. If that is the engine, a screen or sync landing on purpose: update the STATUS paragraph at the top of RunJoin.kt and this test in the same change.");
  // The server side: the pricing takeoff and the office must not read a table that does not exist in the cloud.
  const fnDir = join(ROOT, "supabase/functions");
  const server = existsSync(fnDir) ? walk(fnDir).filter((p) => /\.(ts|js|mjs)$/.test(p)) : [];
  assert.ok(server.length > 20, "the server sources were not found, so this check would pass for the wrong reason");
  assert.deepEqual(server.filter((p) => /\brun_joins\b/.test(readFileSync(p, "utf8"))).map((p) => relative(ROOT, p)), [], "the server reads run_joins, but nothing creates it");
});

test("TEETH: the reach check finds a call from an engine file, from a screen and from sync, and ignores a mention in a comment", () => {
  const calls = [
    { rel: "estimate/EstimateEngine.kt", text: "val joins = repository.getRunJoins(job.id)" },
    { rel: "ui/survey/SurveyViewModel.kt", text: "repository.joinRunEnds(a, RunEnd.END, b, RunEnd.START)" },
    { rel: "cloud/EntitySync.kt", text: 'upsert("run_joins", rows)' },
  ];
  assert.deepEqual(reachViolations(calls), calls.map((c) => c.rel));
  assert.deepEqual(reachViolations([{ rel: "estimate/EstimateEngine.kt", text: "// not yet reading RunJoin\n/* planJoin */ val x = 1" }]), []);
  assert.deepEqual(reachViolations([{ rel: "data/Repository.kt", text: "joinRunEnds(a, b)" }]), [], "its three owners are allowed");
});

test("NOT SYNCED: run_joins is not in SyncTables.ALL, which would send the deletion reaper to a cloud table that does not exist", () => {
  const dao = stripKt(read(KT + "data/Daos.kt"));
  const list = dao.slice(dao.indexOf("object SyncTables"), dao.indexOf("}", dao.indexOf("object SyncTables")));
  assert.ok(list.includes('"fence_runs"'), "the list was found");
  assert.ok(!list.includes("run_joins"), "run_joins is in SyncTables.ALL: land the cloud table and the sync first, then update RunJoin.kt's STATUS and this test");
});

test("the STATUS paragraph that says all of this is still at the top of RunJoin.kt", () => {
  const rj = read(KT + "data/RunJoin.kt");
  for (const claim of ["NOT YET REACHED BY THE PRICE", "NOT YET REACHED BY ANY SCREEN", "NOT SYNCED"]) assert.ok(rj.includes(claim), "the header no longer says: " + claim);
  assert.ok(rj.indexOf("NOT YET REACHED BY THE PRICE") < rj.indexOf("@Entity"), "the status comes before the code");
});

/** The Repository's join block, by its own marker, comments removed. */
function joinBlock(repositoryKt) {
  const from = repositoryKt.indexOf("// ---- Joined run ends");
  const to = repositoryKt.indexOf("// ---- Per-foot pay split");
  assert.ok(from >= 0 && to > from, "the join block's bounds moved");
  return repositoryKt.slice(from, to);
}

/** Violations of "every write passes the guest gate and one transaction, and nothing prices or deletes". Empty is good. */
function repositoryViolations(repositoryKt) {
  const bad = [];
  const block = stripKt(joinBlock(repositoryKt));
  for (const fn of ["joinRunEnds", "unjoinRunEnd"]) {
    const at = block.indexOf("suspend fun " + fn + "(");
    if (at < 0) { bad.push(fn + " is gone"); continue; }
    const rest = block.slice(at, at + 400);
    if (!rest.includes(`guardWrite("${fn}")`)) bad.push(fn + " does not pass the guest gate first");
    if (!rest.includes("db.withTransaction")) bad.push(fn + " does not run in one transaction");
  }
  const writes = [...block.matchAll(/runJoinDao\.(insertEndIfAbsent|setJoint)\(/g)];
  const inGuarded = block.slice(block.indexOf("suspend fun joinRunEnds("));
  if (writes.length !== 3) bad.push(`expected 3 write call sites (insert + set in writeJoinEnd, set in unjoin), found ${writes.length}`);
  if (!/val plan = planJoin\(/.test(inGuarded)) bad.push("joinRunEnds does not decide through planJoin");
  if (!/if \(jointA != target\) writeJoinEnd\(runA, endA, target, now\)/.test(inGuarded) || !/if \(jointB != target\) writeJoinEnd\(runB, endB, target, now\)/.test(inGuarded)) bad.push("joinRunEnds does not skip an end already at the target");
  if (!/plan\.result == JoinResult\.JOINED/.test(inGuarded)) bad.push("joinRunEnds writes for a result other than JOINED");
  if (!/check\(runJoinDao\.setJoint\(run\.id, end\.atEnd, jointId, at\) == 1\)/.test(block)) bad.push("writeJoinEnd does not fail loudly when setJoint refuses");
  if (/\bdelete|queueDeletion|pendingDeletion|deleteSynced/i.test(block)) bad.push("the join block deletes or queues a deletion");
  if (/EstimateEngine|Takeoff|totalCost|contractTotal|price/i.test(block)) bad.push("the join block touches pricing");
  // Its reads must be the live ones.
  if (!/observeRunJoins\(jobId: Long\): Flow<List<RunJoin>> = runJoinDao\.observeLiveForJob\(jobId\)/.test(block)) bad.push("observeRunJoins is not the live read");
  if (!/getRunJoins\(jobId: Long\): List<RunJoin> = runJoinDao\.getLiveForJob\(jobId\)/.test(block)) bad.push("getRunJoins is not the live read");
  if (!/private val runJoinDao = db\.runJoinDao\(\)/.test(stripKt(repositoryKt))) bad.push("the repository does not hold the dao");
  return bad;
}

test("the repository's join functions pass the guest gate and one transaction, decide through planJoin, and neither delete nor price", () => {
  assert.deepEqual(repositoryViolations(read(KT + "data/Repository.kt")), []);
});

test("TEETH: an ungated write, a lost transaction, a skipped plan and a deletion are each caught", () => {
  const repo = read(KT + "data/Repository.kt");
  assert.ok(repositoryViolations(mutate(repo, 'guardWrite("joinRunEnds") {', "run {")).some((v) => /guest gate/.test(v)));
  assert.ok(repositoryViolations(mutate(repo, 'guardWrite("unjoinRunEnd") {\n        db.withTransaction {', 'guardWrite("unjoinRunEnd") {\n        run {')).some((v) => /transaction/.test(v)));
  assert.ok(repositoryViolations(mutate(repo, "                val plan = planJoin(", "                val plan = otherPlan(")).some((v) => /planJoin/.test(v)));
  assert.ok(repositoryViolations(mutate(repo, "                    if (jointA != target) writeJoinEnd(runA, endA, target, now)\n", "                    writeJoinEnd(runA, endA, target, now)\n")).some((v) => /already at the target/.test(v)));
  assert.ok(repositoryViolations(mutate(repo, "    private suspend fun writeJoinEnd(", "    suspend fun deleteJoinRows(runId: Long) = queueDeletion(\"x\", \"run_joins\")\n    private suspend fun writeJoinEnd(")).some((v) => /deletes/.test(v)));
});

test("the enquiry block's bounds, which another test slices Repository.kt by, are untouched by the join block", () => {
  const repo = read(KT + "data/Repository.kt");
  const enquiry = repo.indexOf("// ---- Enquiry capture"), builds = repo.indexOf("// ---- Build templates"), joins = repo.indexOf("// ---- Joined run ends");
  assert.ok(enquiry > 0 && builds > enquiry, "the enquiry block is findable");
  assert.ok(joins >= 0 && (joins < enquiry || joins > builds), "the join block must sit outside the enquiry block, whose test forbids the words delete and remove inside it");
});

test("the syncId for an end is the name-based UUID the server's uuid3.ts twin computes, one per run and end", () => {
  const rj = stripKt(read(KT + "data/RunJoin.kt"));
  assert.match(rj, /java\.util\.UUID\.nameUUIDFromBytes\(\s*\("fenceflow-run-join:" \+ runSyncId \+ ":" \+ \(if \(atEnd\) "end" else "start"\)\)\.toByteArray\(\)\s*\)\.toString\(\)/);
  const id = (run, end) => nameUUIDFromString(`fenceflow-run-join:${run}:${end}`);
  const set = new Set([id("r1", "start"), id("r1", "end"), id("r2", "start"), id("r2", "end")]);
  assert.equal(set.size, 4, "an id per run per end, so two ends of one run never share a sync id");
  assert.equal(id("r1", "end"), id("r1", "end"), "stable");
  assert.match(id("r1", "end"), /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "version 3, IETF variant, as nameUUIDFromBytes writes");
});

// ====================================================================== 7. THE REAL KOTLIN ==

const RUN_KOTLIN = process.env.A33_KOTLIN === "1";
const SKIP_KOTLIN = RUN_KOTLIN ? false : "set A33_KOTLIN=1 to compile RunJoin.kt, AppDatabase.kt and Repository.kt with the Kotlin compiler from the Gradle cache (no gradlew) and run planJoin under JUnit";
const harness = RUN_KOTLIN ? await import("./a28-capture-harness.mjs") : null;
const MAIN = ["data/RunJoin.kt", "data/AppDatabase.kt", "data/Repository.kt"].map((p) => join(ROOT, KT, p));

/** A JUnit class that runs the golden table and the sync-id parity through the real Kotlin. Generated into the OS temp dir. */
function junitSource() {
  const kt = (v) => (v === null ? "null" : typeof v === "string" ? JSON.stringify(v).replace(/\$/g, "\\$") : String(v));
  const run = (o) => o === null ? "null" : `FenceRun(id = ${o.id}L, jobId = ${o.jobId}L, closedLoop = ${o.closedLoop}, isTeardown = ${o.isTeardown}, manualLinearFeet = ${o.manualLinearFeet === null ? "null" : o.manualLinearFeet + "f"})`;
  const cases = PLAN_CASES.map(([name, a, b, ja, jb, bAtA, aAtB, result, jointId]) =>
    `        check(${kt(name)}, ${run(a)}, ${run(b)}, ${kt(ja)}, ${kt(jb)}, ${bAtA}, ${aAtB}, JoinResult.${result}, ${kt(jointId)})`).join("\n");
  const ids = [["r1", false], ["r1", true], ["r2", false], ["shared-run-A", true], ["0b4e7a50-3c1d-4f6e-9a77-2d5f8e1c9b30", false]]
    .map(([run, end]) => `        assertEquals(${kt(nameUUIDFromString(`fenceflow-run-join:${run}:${end ? "end" : "start"}`))}, RunJoin.syncIdFor(${kt(run)}, ${end}))`).join("\n");
  return `package com.fenceestimator.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RunJoinPlanTest {
    private fun check(name: String, a: FenceRun?, b: FenceRun?, ja: String?, jb: String?, bAtA: Boolean, aAtB: Boolean, result: JoinResult, jointId: String?) {
        val plan = planJoin(a, b, ja, jb, bAtA, aAtB, "NEW")
        assertEquals(name, result, plan.result)
        assertEquals(name + " (point)", jointId, plan.jointId)
    }

    @Test
    fun goldenTable() {
${cases}
    }

    @Test
    fun syncIdsAreTheServersTwin() {
${ids}
        assertTrue(RunJoin.syncIdFor("r1", true) != RunJoin.syncIdFor("r1", false))
    }

    @Test
    fun endsAndEnumeration() {
        assertFalse(RunEnd.START.atEnd)
        assertTrue(RunEnd.END.atEnd)
        assertEquals(9, JoinResult.values().size)
    }

    @Test
    fun theMigrationIsFourCreateStatements() {
        assertEquals(4, SchemaV48.MIGRATION_47_48_STATEMENTS.size)
        assertTrue(SchemaV48.MIGRATION_47_48_STATEMENTS.all { it.startsWith("CREATE ") })
    }
}
`;
}

function kotlinRun(overlay) {
  const dir = mkdtempSync(join(tmpdir(), "a33-junit-"));
  try {
    const file = join(dir, "RunJoinPlanTest.kt");
    writeFileSync(file, junitSource());
    return harness.runTests({ mainSources: MAIN, testSources: [file], testClasses: ["com.fenceestimator.app.data.RunJoinPlanTest"], overlay });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("KOTLIN: the real RunJoin.kt, AppDatabase.kt and Repository.kt compile together, and planJoin and syncIdFor pass the golden table under JUnit", { skip: SKIP_KOTLIN, timeout: 1_500_000 }, () => {
  const out = kotlinRun();
  assert.equal(out.status, 0, `stage ${out.stage}:\n${out.out}`);
  assert.match(out.out, /OK \(4 tests\)/, out.out);
});

test("KOTLIN TEETH: with the same-run guard taken out of planJoin, in a scratch copy, the suite goes red", { skip: SKIP_KOTLIN, timeout: 1_500_000 }, () => {
  const src = read(KT + "data/RunJoin.kt");
  const broken = mutate(src, "    if (runA.id == runB.id) return JoinPlan(JoinResult.SAME_RUN)\n", "");
  const out = kotlinRun({ [join(ROOT, KT, "data/RunJoin.kt")]: broken });
  assert.notEqual(out.status, 0, "a planJoin that joins a run to itself passed the golden table");
  assert.match(out.out, /two ends of one run|SAME_RUN|Failures: 1|FAILURES/, out.out);
});

test("KOTLIN TEETH: with the sync id built from the run alone, the parity with the server twin fails", { skip: SKIP_KOTLIN, timeout: 1_500_000 }, () => {
  const src = read(KT + "data/RunJoin.kt");
  const broken = mutate(src, '(if (atEnd) "end" else "start")', '"start"');
  const out = kotlinRun({ [join(ROOT, KT, "data/RunJoin.kt")]: broken });
  assert.notEqual(out.status, 0);
});
