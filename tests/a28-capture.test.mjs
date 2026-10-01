// a28-capture -- crew enquiry capture: a nominated crew member takes down a neighbour's enquiry on the spot, it reaches the
// office, the OFFICE prices it, and no price ever reaches a crew phone.
//
// THE OWNER'S ANSWER, which is the whole brief: asked whether crew should be able to price work, he chose CAPTURE ONLY,
// granted PER PERSON. So this proves what that means, and for each claim the file also shows the check can fail:
//
//   A. STATIC (always, ~2 s). Pure checks over the real source text, each one a function so the same check can be run on a
//      BROKEN copy and must fail:
//        1  the permission is in no role's defaults; the Team access screen can show it (EnumLabels names it)
//        2  the three locales carry every string, with matching arguments, no stray apostrophe, no double hyphen in a comment
//        3  the Room schema: the migration's statements, run in a real SQLite, give exactly the tables the entities describe
//        4  every @Query of the capture DAO PREPARES against that schema, and the queries do what the rules say: one claim,
//           a correction only on an unsent capture nobody is sending, a sent capture frozen, NO delete query at all, and an
//           unsent capture is still there after the database is closed and reopened (the garden with no signal)
//        5  the SQL file: unapplied, additive, no money column named, no assignee, permission-gated, the jsonb keys it reads
//           are exactly the keys the phone sends, it calls only functions the live database has, nothing destructive
//   B. KOTLIN (A28_KOTLIN=1, ~10 min the first time). Compiles the REAL changed sources -- the Compose screen included --
//      with the Kotlin compiler from the Gradle cache (no gradlew), runs EnquiryCaptureTest and the repo's neighbouring tests,
//      then BREAKS six things in scratch copies and demands each one turns the suite red or stops the build.
//   C. LIVE (A28_LIVE=1, SELECTs only, with a positive control on every probe): what production has today that the design
//      leans on -- has_permission() needs no change, the crew view carries no money column, nothing creator-based lets a
//      capturer see the lead, and the functions the SQL calls exist.
//
//   node --test tests/a28-capture.test.mjs
//   A28_KOTLIN=1 node --test tests/a28-capture.test.mjs
//   A28_LIVE=1 node --test tests/a28-capture.test.mjs
//
// THIS FILE NEVER WRITES TO ANY DATABASE: section C is SELECTs only. It is NOT true of its neighbours -- a10, a16, a23, a24, a4-labour,
// notify-job-change, crew-job-scope and company-crew-golden-path each run PLANTS inside a rolled-back transaction against PRODUCTION by
// default, with no env gate, and take 1 to 10 minutes. Running them to "check nothing broke" is not a read-only act.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAIN_SOURCES, REST_ERRORS, ROOT, TEST_CLASS, TEST_FILE, runTests, toolchain } from "./a28-capture-harness.mjs";

const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const KT = "app/src/main/java/com/fenceestimator/app/";
const SQL_REL = "supabase_a28_crew_enquiry_capture.sql";
const LOCALES = { en: "app/src/main/res/values/strings.xml", es: "app/src/main/res/values-es/strings.xml", fr: "app/src/main/res/values-fr/strings.xml" };
const CAPTURE_FILES = ["ui/crew/EnquiryCaptureLogic.kt", "ui/crew/EnquiryCaptureSender.kt", "ui/crew/EnquiryCaptureViewModel.kt", "ui/crew/EnquiryCaptureScreen.kt"];

/** Kotlin with comments removed, so prose cannot satisfy a check about code. */
const stripKt = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

/** SQL with comments removed: line comments and block comments, never touching a quoted string. */
function stripSql(text) {
  let out = "", i = 0;
  while (i < text.length) {
    const c = text[i], d = text[i + 1];
    if (c === "-" && d === "-") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 2; continue; }
    if (c === "'") {
      let j = i + 1;
      while (j < text.length) { if (text[j] === "'" && text[j + 1] === "'") j += 2; else if (text[j] === "'") break; else j++; }
      out += text.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

/** The text of `needle`, replaced once -- a mutation. It must exist exactly once or the sabotage proves nothing. */
function mutate(text, needle, replacement) {
  assert.equal(text.split(needle).length, 2, "sabotage anchor must appear exactly once: " + needle.slice(0, 70));
  return text.replace(needle, replacement);
}

// =============================================================== 1. THE PERMISSION ==

/** Violations of "off by default, shown on the Team access screen". Empty is good. */
function permissionViolations(permissionsKt, enumLabelsKt) {
  const bad = [];
  const code = stripKt(permissionsKt);
  const enumBody = code.slice(code.indexOf("enum class Permission("), code.indexOf("companion object"));
  if ((enumBody.match(/\bCAPTURE_ENQUIRY\(/g) || []).length !== 1) bad.push("CAPTURE_ENQUIRY must be declared exactly once in the enum");
  const defaults = code.slice(code.indexOf("val UserRole.defaultPermissions"));
  const roleBlock = defaults.slice(0, defaults.indexOf("object PermissionOverrides"));
  if (/CAPTURE_ENQUIRY/.test(roleBlock)) bad.push("a role's default permissions mention CAPTURE_ENQUIRY: it must be granted per person");
  if (!/UserRole\.OWNER -> Permission\.ALL/.test(roleBlock)) bad.push("OWNER must still be every permission");
  // The enum entry itself must not be "sensitive" (a warning row) nor carry a role list.
  const entry = enumBody.slice(enumBody.indexOf("CAPTURE_ENQUIRY("), enumBody.indexOf("SEE_REPORTS("));
  if (/sensitive\s*=\s*true/.test(entry)) bad.push("CAPTURE_ENQUIRY is not a sensitive permission");
  const labels = stripKt(enumLabelsKt);
  if (!/Permission\.CAPTURE_ENQUIRY -> R\.string\.enum_perm_capture_enquiry\b(?!_)/.test(labels)) bad.push("EnumLabels.labelRes has no branch for it (the build breaks)");
  if (!/Permission\.CAPTURE_ENQUIRY -> R\.string\.enum_perm_capture_enquiry_desc\b/.test(labels)) bad.push("EnumLabels.descriptionRes has no branch for it (the build breaks)");
  return bad;
}

/**
 * Whether the way in to the capture screen actually exists.
 *
 * A permission is only worth offering on the Team screen once granting it does
 * something. All four of these have to be true, and they live in files this
 * track does not own, so they are read rather than assumed.
 */
function captureIsReachable() {
  const missing = [];
  const main = read(KT + "MainActivity.kt");
  if (!/ENQUIRY_CAPTURE_ROUTE/.test(main)) missing.push("MainActivity.kt has no route to the capture screen");
  const jobs = read(KT + "ui/jobs/JobsListScreen.kt");
  if (!/EnquiryEntryCard/.test(jobs)) missing.push("JobsListScreen.kt draws no entry card");
  const autoSync = read(KT + "cloud/AutoSync.kt");
  if (!/EnquiryOutboxRunner/.test(autoSync)) missing.push("AutoSync never flushes the outbox");
  const sql = readFileSync(join(ROOT, "supabase_a28_crew_enquiry_capture.sql"), "utf8");
  if (/STATUS: NOT APPLIED/.test(sql)) missing.push("the SQL is not applied, so the server has no door");
  return missing;
}

test("the permission is in no role's defaults, OWNER is still everything, and the Team access screen offers it only once it does something", () => {
  const p = read(KT + "cloud/Permissions.kt"), e = read(KT + "ui/components/EnumLabels.kt");
  assert.deepEqual(permissionViolations(p, e), []);
  // The Team access list is every permission by construction, so there is no
  // second list to forget.
  const access = read(KT + "ui/account/AccessScreen.kt");
  assert.match(access, /Permission\.values\(\)\.filter \{[^}]*!it\.sensitive/);
  assert.match(access, /Permission\.values\(\)\.filter \{[^}]*\bit\.sensitive/);

  // The invariant, which cannot rot into a lie either way round: the toggle is
  // offered exactly when granting it reaches something. A toggle that changes
  // nothing reads as a feature, gets granted, and then nothing happens on the
  // crew member's phone -- that mismatch has produced a fake button here before.
  const withheld = /private val Permission\.grantableToday: Boolean[\s\S]*?this != Permission\.CAPTURE_ENQUIRY/.test(access) &&
    /!it\.sensitive && it\.grantableToday/.test(access) &&
    /\bit\.sensitive && it\.grantableToday/.test(access);
  const missing = captureIsReachable();
  if (missing.length > 0) {
    assert.ok(
      withheld,
      "CAPTURE_ENQUIRY is offered on the Team access screen but granting it does nothing:\n  " +
        missing.join("\n  ") +
        "\nEither wire those up or withhold the toggle (AccessScreen.grantableToday)."
    );
  } else {
    assert.ok(
      !withheld,
      "the capture path is wired up and the SQL is applied, so AccessScreen must stop withholding " +
        "the toggle: delete grantableToday and its two filters."
    );
  }
});

test("TEETH: the reachability check notices each missing piece, and the withholding check reads both filters", () => {
  const missing = captureIsReachable();
  // Today all four are missing. If that ever changes this still has teeth: the
  // list must name whatever is absent and nothing that is not.
  assert.ok(Array.isArray(missing));
  const access = read(KT + "ui/account/AccessScreen.kt");
  // Dropping the filter from either list, or the property, must stop counting as withheld.
  for (const needle of ["!it.sensitive && it.grantableToday", "it.sensitive && it.grantableToday", "this != Permission.CAPTURE_ENQUIRY"]) {
    const broken = access.replace(needle, "REMOVED");
    const stillWithheld = /private val Permission\.grantableToday: Boolean[\s\S]*?this != Permission\.CAPTURE_ENQUIRY/.test(broken) &&
      /!it\.sensitive && it\.grantableToday/.test(broken) &&
      /\bit\.sensitive && it\.grantableToday/.test(broken);
    assert.ok(!stillWithheld, `removing "${needle}" still read as withheld`);
  }
});

test("TEETH: the same check turns red if the permission is given to crew, or the label branch is missing", () => {
  const p = read(KT + "cloud/Permissions.kt"), e = read(KT + "ui/components/EnumLabels.kt");
  const toCrew = mutate(p, "UserRole.CREW -> setOf(Permission.RECORD_FIELD_WORK)", "UserRole.CREW -> setOf(Permission.RECORD_FIELD_WORK, Permission.CAPTURE_ENQUIRY)");
  assert.ok(permissionViolations(toCrew, e).some((v) => /default permissions mention/.test(v)));
  const noLabel = mutate(e, "    Permission.CAPTURE_ENQUIRY -> R.string.enum_perm_capture_enquiry_desc\n", "");
  assert.ok(permissionViolations(p, noLabel).some((v) => /descriptionRes/.test(v)));
  const sensitive = mutate(p, '"person capturing it never sees a price."\n    ),', '"person capturing it never sees a price.",\n        sensitive = true\n    ),');
  assert.ok(permissionViolations(sensitive, e).some((v) => /sensitive/.test(v)));
});

// =============================================================== 2. THE STRINGS ==

const str = (xml, name) => { const m = xml.match(new RegExp('<string name="' + name + '"[^>]*>([\\s\\S]*?)</string>')); return m ? m[1] : null; };
const keysOf = (xml) => [...xml.matchAll(/<string name="((?:enq_|enum_perm_capture_enquiry)[^"]*)"/g)].map((m) => m[1]);

/** The R.string.* names the four capture files use, and EnumLabels' two. */
function usedStringKeys() {
  const used = new Set();
  for (const f of CAPTURE_FILES) for (const m of stripKt(read(KT + f)).matchAll(/R\.string\.([a-z0-9_]+)/g)) used.add(m[1]);
  return used;
}

test("every string the capture uses exists in all three locales, none is dead, and none breaks the aapt2 build", () => {
  const en = read(LOCALES.en);
  const defined = new Set(keysOf(en));
  assert.ok(defined.size >= 55, "found only " + defined.size + " keys");
  for (const [loc, rel] of Object.entries(LOCALES)) {
    const xml = read(rel);
    assert.deepEqual([...defined].filter((k) => str(xml, k) === null), [], loc + ": missing keys");
    assert.deepEqual(keysOf(xml).filter((k) => !defined.has(k)), [], loc + ": extra keys");
    for (const k of defined) {
      const v = str(xml, k);
      assert.ok(v.trim().length > 0, `${loc}/${k} is empty`);
      assert.ok(!/(^|[^\\])'/.test(v), `${loc}/${k}: an unescaped ASCII apostrophe breaks aapt2`);
      assert.ok(!/%(?!\d\$[sd]|%)/.test(v), `${loc}/${k}: a bare % breaks String.format`);
    }
    // XML comments may not contain a double hyphen: check every comment in the file.
    for (const c of xml.matchAll(/<!--([\s\S]*?)-->/g)) assert.ok(!c[1].includes("--"), loc + ": a double hyphen inside an XML comment");
  }
  // Same format arguments in every language: a dropped %1$d throws in that language only, on a customer's phone.
  const args = (v) => [...new Set(v.match(/%\d\$[sd]/g) || [])].sort().join(",");
  for (const k of defined) for (const loc of ["es", "fr"]) assert.equal(args(str(read(LOCALES[loc]), k)), args(str(en, k)), `${loc}/${k}: format arguments differ`);
  // Every R.string the code asks for is there (a missing one breaks the WHOLE build), and every enq_ string is used.
  const used = usedStringKeys();
  assert.deepEqual([...used].filter((k) => !defined.has(k) && !str(en, k)), [], "the code names a string that does not exist");
  assert.deepEqual([...defined].filter((k) => k.startsWith("enq_") && !used.has(k)), [], "dead strings");
});

test("TEETH: a missing key, a mismatched argument and an unescaped apostrophe are each visible to the same readers", () => {
  const en = read(LOCALES.en);
  assert.equal(str(en.replace('name="enq_save"', 'name="enq_savX"'), "enq_save"), null);
  const args = (v) => [...new Set(v.match(/%\d\$[sd]/g) || [])].sort().join(",");
  assert.notEqual(args("%1$d of %2$d"), args("%1$d"));
  assert.ok(/(^|[^\\])'/.test("can't"));
  assert.ok("a -- b".includes("--"));
});

// ============================================================ 3. THE ROOM SCHEMA ==

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

/** What Room expects of one entity: columns, indices and foreign keys, from the Kotlin text. */
function entityOf(entitiesKt, className) {
  const code = stripKt(entitiesKt);
  const at = code.indexOf("data class " + className + "(");
  assert.ok(at >= 0, "entity not found: " + className);
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
  const fks = [...header.matchAll(/ForeignKey\(([\s\S]*?)\)\s*,?\s*\n?\s*\]/g)].map((m) => ({
    parent: m[1].match(/entity\s*=\s*(\w+)::class/)[1],
    from: m[1].match(/childColumns\s*=\s*\["([^"]+)"\]/)[1],
    to: m[1].match(/parentColumns\s*=\s*\["([^"]+)"\]/)[1],
    onDelete: (m[1].match(/onDelete\s*=\s*ForeignKey\.(\w+)/) || [])[1] || "NO_ACTION",
  }));
  return { table, columns, indices, fks };
}

/** The Kotlin string list `val <name>: List<String> = listOf(...)` as real strings (pieces joined). */
function kotlinStringList(kt, name) {
  const code = stripKt(kt);
  const at = code.indexOf("val " + name);
  assert.ok(at >= 0, "list not found: " + name);
  const open = code.indexOf("listOf(", at) + "listOf".length;
  return splitTop(code.slice(open + 1, matching(code, open))).map((el) =>
    [...el.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1")).join(""));
}

/** Differences between the entities and a SQLite built from the migration's statements. Empty is good. */
function schemaViolations(entitiesKt, appDatabaseKt) {
  const bad = [];
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE `jobs` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL)"); // the parent the older tables hang on; ours do not need it
  for (const stmt of kotlinStringList(appDatabaseKt, "MIGRATION_46_47_STATEMENTS")) db.exec(stmt);
  for (const cls of ["EnquiryCapture", "EnquiryCapturePhoto"]) {
    const want = entityOf(entitiesKt, cls);
    const have = db.prepare(`PRAGMA table_info(\`${want.table}\`)`).all();
    if (!have.length) { bad.push(`${want.table}: not created by the migration`); continue; }
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
    const parentTable = (cl) => entityOf(entitiesKt, cl).table;
    const wantFk = want.fks.map((f) => `${parentTable(f.parent)}|${f.from}->${f.to}|${f.onDelete.replace("_", " ")}|NO ACTION`).sort();
    const haveFk = fk.map((f) => `${f.table}|${f.from}->${f.to}|${f.on_delete}|${f.on_update}`).sort();
    if (JSON.stringify(wantFk) !== JSON.stringify(haveFk)) bad.push(`${want.table}: foreign keys differ\n  entity:    ${wantFk}\n  migration: ${haveFk}`);
  }
  // Wired in: the database is at 47 or past it, both entities registered, the
  // dao exposed, the migration in the builder's chain.
  //
  // "at least 47", not "is 47", and "in the chain", not "last in the chain:
  // another track chaining 47 -> 48 on top of this one is correct and must not
  // turn this red. What matters is that 46 -> 47 exists, is registered, and
  // that nothing is left on a version below it. Pinned the other way, this
  // check could only fail the next time somebody added a table.
  const code = stripKt(appDatabaseKt);
  const version = Number((code.match(/version\s*=\s*(\d+)\b/) || [])[1]);
  if (!(version >= 47)) bad.push(`the database version is below 47 (it is ${version || "unreadable"})`);
  if (!/EnquiryCapture::class,\s*EnquiryCapturePhoto::class/.test(code)) bad.push("the entities are not registered in @Database");
  if (!/abstract fun enquiryCaptureDao\(\): EnquiryCaptureDao/.test(code)) bad.push("the dao is not exposed");
  if (!/MIGRATION_45_46,\s*MIGRATION_46_47\b/.test(code)) bad.push("MIGRATION_46_47 is not added to the builder");
  if (!/MIGRATION_46_47 = object : Migration\(46, 47\)/.test(code)) bad.push("MIGRATION_46_47 is not a Migration(46, 47)");
  return bad;
}

test("the migration builds exactly the tables the two entities describe, and 47 is wired in", () => {
  assert.deepEqual(schemaViolations(read(KT + "data/Entities.kt"), read(KT + "data/AppDatabase.kt")), []);
});

test("nothing from a shipped migration is repeated in the new one (a repeated ADD COLUMN is a crash loop)", () => {
  const db = read(KT + "data/AppDatabase.kt");
  const v47 = kotlinStringList(db, "MIGRATION_46_47_STATEMENTS");
  const shipped = [...kotlinStringList(db, "MIGRATION_43_44_STATEMENTS"), ...kotlinStringList(db, "MIGRATION_44_45_STATEMENTS"), ...kotlinStringList(db, "MIGRATION_45_46_STATEMENTS")];
  assert.deepEqual(v47.filter((s) => shipped.includes(s)), []);
  assert.ok(v47.length === 5 && v47.every((s) => /^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS/.test(s)), "every statement is an idempotent CREATE ... IF NOT EXISTS");
  assert.ok(!v47.some((s) => /\b(DROP|DELETE|UPDATE|ALTER)\b/i.test(s.replace(/ON (UPDATE|DELETE) (NO ACTION|CASCADE)/g, ""))), "purely additive");
});

test("TEETH: a column missing from the migration, an extra entity field and a wrong index are each caught", () => {
  const ent = read(KT + "data/Entities.kt"), db = read(KT + "data/AppDatabase.kt");
  assert.ok(schemaViolations(ent, mutate(db, '"`rejectedWhy` TEXT NOT NULL)"', '"`rejectedWhyX` TEXT NOT NULL)"')).some((v) => /columns differ/.test(v)));
  assert.ok(schemaViolations(mutate(ent, "    val rejectedWhy: String = \"\"\n) {", "    val rejectedWhy: String = \"\",\n    val extra: String = \"\"\n) {"), db).some((v) => /columns differ/.test(v)));
  assert.ok(schemaViolations(ent, mutate(db, '"CREATE UNIQUE INDEX IF NOT EXISTS `index_enquiry_captures_syncId` ON `enquiry_captures` (`syncId`)"', '"CREATE INDEX IF NOT EXISTS `index_enquiry_captures_syncId` ON `enquiry_captures` (`syncId`)"')).some((v) => /indices differ/.test(v)));
  // Anchored on the parent table, not on the CASCADE clause alone: another
  // track's migration has cascading foreign keys of its own, and a sabotage
  // anchor that matches more than one place stops being a sabotage.
  assert.ok(schemaViolations(ent, mutate(db, "REFERENCES `enquiry_captures`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )\",", "REFERENCES `enquiry_captures`(`id`) ON UPDATE NO ACTION ON DELETE NO ACTION )\",")).some((v) => /foreign keys differ/.test(v)));
  const vLine = (db.match(/ {4}version = \d+,/) || [])[0];
  assert.ok(vLine, "cannot find the version line to sabotage");
  assert.ok(schemaViolations(ent, mutate(db, vLine, "    version = 46,")).some((v) => /version is below 47/.test(v)));
});

// ================================================================== 4. THE DAO ==

/** Every @Query of the capture DAO, by function name: string pieces joined, in the order Room reads them. */
function daoQueries(daosKt) {
  const code = stripKt(daosKt);
  const at = code.indexOf("interface EnquiryCaptureDao");
  assert.ok(at >= 0, "EnquiryCaptureDao not found");
  const body = code.slice(at);
  const out = {};
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
    const fn = body.slice(i).match(/fun\s+(\w+)\(/)[1];
    out[fn] = sql;
  }
  return { queries: out, body };
}

function freshDb(dbPath = ":memory:") {
  const db = new DatabaseSync(dbPath);
  for (const stmt of kotlinStringList(read(KT + "data/AppDatabase.kt"), "MIGRATION_46_47_STATEMENTS")) db.exec(stmt);
  return db;
}
const NOW = 10_000_000, STALE = NOW - 120_000;
const addCapture = (db, o = {}) => db.prepare(
  "INSERT INTO enquiry_captures (syncId, companyId, customerName, phone, email, address, fenceType, approxFeet, notes, capturedAt, sentAt, sendingSince, rejectedAt, rejectedWhy) " +
  "VALUES (:syncId, :companyId, :customerName, :phone, :email, :address, :fenceType, :approxFeet, :notes, :capturedAt, :sentAt, :sendingSince, :rejectedAt, :rejectedWhy)"
).run({ syncId: "s-" + Math.random(), companyId: "co", customerName: "Mrs Next-Door", phone: "5551234567", email: "", address: "12 Elm Street", fenceType: "VINYL", approxFeet: 120, notes: "gate left", capturedAt: 1000, sentAt: null, sendingSince: null, rejectedAt: null, rejectedWhy: "", ...o }).lastInsertRowid;
const addPhoto = (db, captureId, storagePath = null) => db.prepare("INSERT INTO enquiry_capture_photos (captureId, syncId, filePath, storagePath) VALUES (?, ?, ?, ?)").run(captureId, "p-" + Math.random(), "/f.jpg", storagePath).lastInsertRowid;
const row = (db, id) => db.prepare("SELECT * FROM enquiry_captures WHERE id = ?").get(id);
const scalar = (stmt, params = {}) => Object.values(stmt.get(params))[0];

/** The rules the queries must keep. Returns violations; empty is good. */
function daoViolations(daosKt) {
  try {
    return daoViolationsUnguarded(daosKt);
  } catch (e) {
    return ["a query behaved in a way the rules do not allow: " + e.message];
  }
}

function daoViolationsUnguarded(daosKt) {
  const bad = [];
  const { queries, body } = daoQueries(daosKt);
  const db = freshDb();
  for (const [fn, sql] of Object.entries(queries)) { try { db.prepare(sql); } catch (e) { bad.push(`${fn} does not prepare: ${e.message}`); } }
  if (bad.length) return bad;
  const q = (fn) => { assert.ok(queries[fn], "no query named " + fn); return db.prepare(queries[fn]); };
  // no delete, in any spelling
  if (/@Delete\b/.test(body) || /\bDELETE\s+FROM\b/i.test(body) || /\bDROP\b/i.test(body) || /\bTRUNCATE\b/i.test(body)) bad.push("the capture DAO can delete");
  // one claim
  const a = addCapture(db);
  if (q("claim").run({ id: a, now: NOW, staleBefore: STALE }).changes !== 1) bad.push("claim: an unsent capture cannot be claimed");
  if (q("claim").run({ id: a, now: NOW + 1, staleBefore: STALE }).changes !== 0) bad.push("claim: a fresh claim was taken a second time");
  if (q("claim").run({ id: a, now: NOW + 500_000, staleBefore: NOW + 500_000 - 120_000 }).changes !== 1) bad.push("claim: a stale claim cannot be taken (a dead process would hold it for ever)");
  // a correction only while unsent and not being sent
  const edit = (id, extra = {}) => q("editUnsent").run({ id, name: "Fixed", phone: "5550000000", email: "", address: "99 Oak Ave", fenceType: "WOOD", approxFeet: null, notes: "", staleBefore: STALE, ...extra }).changes;
  if (edit(a) !== 0) bad.push("editUnsent: a capture mid-send was changed under the sender");
  q("release").run({ id: a });
  if (edit(a) !== 1) bad.push("editUnsent: an unsent capture could not be corrected");
  if (row(db, a).customerName !== "Fixed" || row(db, a).approxFeet !== null) bad.push("editUnsent: the correction did not land");
  if (q("markSent").run({ id: a, at: 5 }).changes !== 1 || q("markSent").run({ id: a, at: 9 }).changes !== 0 || row(db, a).sentAt !== 5) bad.push("markSent: not stamped exactly once");
  if (edit(a) !== 0) bad.push("editUnsent: a capture the office has was changed (they would hold something else)");
  if (q("claim").run({ id: a, now: NOW + 600_000, staleBefore: NOW }).changes !== 0) bad.push("claim: a sent capture was claimed again");
  // a refusal is kept, never retried by itself, and a correction or "send again" reopens it
  const r = addCapture(db);
  q("markRejected").run({ id: r, at: 7, why: "NOT_ALLOWED" });
  if (q("getUnsent").all().some((x) => x.id === Number(r))) bad.push("getUnsent: a refused capture is queued again by itself");
  if (q("claim").run({ id: r, now: NOW, staleBefore: STALE }).changes !== 0) bad.push("claim: a refused capture was claimed");
  if (scalar(q("countUnsent")) < 1) bad.push("countUnsent: a refused capture is not counted, so a wipe would silently destroy it");
  if (scalar(q("observeWaitingCount"), { companyId: "co" }) !== 0) bad.push("observeWaitingCount: counts a refused or a sent capture as waiting");
  // a capture is waiting under its OWN company only
  const other = addCapture(db, { companyId: "other-company" });
  if (scalar(q("observeWaitingCount"), { companyId: "co" }) !== 0) bad.push("observeWaitingCount: counts another company's capture");
  if (scalar(q("observeWaitingCount"), { companyId: "other-company" }) !== 1) bad.push("observeWaitingCount: does not count a company's own unsent capture");
  void other;
  if (q("clearRejection").run({ id: r }).changes !== 1 || row(db, r).rejectedAt !== null) bad.push("clearRejection: Send again does not reopen it");
  if (q("clearRejection").run({ id: a }).changes !== 0) bad.push("clearRejection: touched a sent capture");
  // photos: owed only after the lead is sent; each stamped once
  const p1 = addPhoto(db, a), p2 = addPhoto(db, a, "co/x/photo/2.jpg");
  if (!q("getSentOwingPhotos").all().some((x) => x.id === Number(a))) bad.push("getSentOwingPhotos: a sent capture with an unsent photo is not listed");
  if (q("setPhotoStoragePath").run({ id: p1, path: "co/x/photo/1.jpg" }).changes !== 1 || q("setPhotoStoragePath").run({ id: p1, path: "other" }).changes !== 0) bad.push("setPhotoStoragePath: not stamped exactly once");
  if (q("getSentOwingPhotos").all().some((x) => x.id === Number(a))) bad.push("getSentOwingPhotos: still owed after every photo is up");
  void p2;
  const owed = addCapture(db), pending = addPhoto(db, owed);
  if (q("getSentOwingPhotos").all().some((x) => x.id === Number(owed))) bad.push("getSentOwingPhotos: an UNSENT capture's photos are uploaded before the lead exists");
  if (scalar(q("countPhotosNotUploaded")) < 1) bad.push("countPhotosNotUploaded: an unsent photo is not counted by the sign-out guard");
  void pending;
  return bad;
}

test("every query of the capture DAO prepares against the real schema, and does what the rules say", () => {
  assert.deepEqual(daoViolations(read(KT + "data/Daos.kt")), []);
});

test("TEETH: a DAO whose correction ignores the send state, whose claim ignores the stale cutoff, or that can delete, is caught", () => {
  const dao = read(KT + "data/Daos.kt");
  // a correction that forgets the capture may already be with the office
  assert.ok(daoViolations(mutate(dao, '"WHERE id = :id AND sentAt IS NULL AND (sendingSince IS NULL OR sendingSince < :staleBefore)"', '"WHERE id = :id AND (sendingSince IS NULL OR sendingSince < :staleBefore)"')).some((v) => /editUnsent: a capture the office has/.test(v)));
  // ...or that is being sent this moment (the query no longer takes the cutoff, which is itself the finding)
  assert.ok(daoViolations(mutate(dao, '"WHERE id = :id AND sentAt IS NULL AND (sendingSince IS NULL OR sendingSince < :staleBefore)"', '"WHERE id = :id AND sentAt IS NULL"')).some((v) => /staleBefore|behaved/.test(v)));
  // a claim that hands a fresh claim to a second sender
  assert.ok(daoViolations(mutate(dao, '"AND rejectedAt IS NULL AND (sendingSince IS NULL OR sendingSince < :staleBefore)"', '"AND rejectedAt IS NULL AND (sendingSince IS NULL OR sendingSince < :staleBefore + 1000000000)"')).some((v) => /claim: a fresh claim was taken a second time/.test(v)));
  assert.ok(daoViolations(mutate(dao, "    @Query(\"UPDATE enquiry_capture_photos SET storagePath", "    @Query(\"DELETE FROM enquiry_captures WHERE id = :id\")\n    suspend fun gone(id: Long): Int\n\n    @Query(\"UPDATE enquiry_capture_photos SET storagePath")).some((v) => /can delete/.test(v)));
  assert.ok(daoViolations(mutate(dao, '"SELECT COUNT(*) FROM enquiry_captures WHERE sentAt IS NULL"', '"SELECT COUNT(*) FROM enquiry_captures WHERE sentAt IS NULL AND rejectedAt IS NULL"')).some((v) => /countUnsent/.test(v)));
  assert.ok(daoViolations(mutate(dao, "fun markSent(id: Long, at: Long): Int", "fun markSent(id: Long, at: Long): Int /**/").replace('WHERE id = :id AND sentAt IS NULL")\n    suspend fun markSent', 'WHERE id = :id")\n    suspend fun markSent')).some((v) => /markSent/.test(v)));
});

test("an unsent capture, its fields and its photos are still there after the database is closed and reopened", () => {
  // The garden with no signal: the phone is locked, the app is killed, the battery dies. What was typed must be on disk.
  const dir = mkdtempSync(join(tmpdir(), "a28-persist-"));
  try {
    const file = join(dir, "fence_estimator.db");
    let db = freshDb(file);
    const id = Number(addCapture(db, { customerName: "Mr Over-The-Fence", phone: "5557654321", email: "o@example.com", address: "3 Birch Lane", fenceType: "CHAIN_LINK", approxFeet: 85, notes: "dog loose, call after 5" }));
    addPhoto(db, id); addPhoto(db, id);
    db.close();
    db = new DatabaseSync(file);
    const back = row(db, id);
    assert.equal(back.customerName, "Mr Over-The-Fence");
    assert.equal(back.phone, "5557654321");
    assert.equal(back.email, "o@example.com");
    assert.equal(back.address, "3 Birch Lane");
    assert.equal(back.fenceType, "CHAIN_LINK");
    assert.equal(back.approxFeet, 85);
    assert.equal(back.notes, "dog loose, call after 5");
    assert.equal(back.sentAt, null, "not marked delivered by being saved");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM enquiry_capture_photos WHERE captureId = ?").get(id).n, 2);
    assert.equal(db.prepare(daoQueries(read(KT + "data/Daos.kt")).queries.getUnsent).all().length, 1, "it is in the send queue");
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ================================================================ 5. THE SQL FILE ==

/** Money columns of jobs, read from the live job_money_columns() on 2026-10-01 (section C re-reads them). */
const JOB_MONEY_COLUMNS = ["tax_rate_percent", "markup_percent", "discount_percent", "labor_rate_per_ft", "labor_flat_fee", "minimum_job_charge", "teardown_flat_fee",
  "teardown_rate_per_ft", "gate_rate_per_ft", "trash_haul_fee", "deposit_amount", "amount_paid", "refunded_amount", "refunded_at", "refund_reason", "payment_status",
  "is_invoiced", "payments_from_processor", "contract_total", "signed_contract_total", "tip_amount", "payment_link_url", "payment_link_amount", "pricing_tier_name",
  "supplier_quote_reference", "quote_token", "quote_sent_at", "quote_viewed_at", "accepted_total", "minimum_labor_charge"];
const LIVE_FUNCTIONS = ["current_company_id", "company_is_suspended", "has_permission", "job_money_columns", "pg_advisory_xact_lock", "auth.uid"];

function functionBody(sqlCode) {
  const at = sqlCode.indexOf("create or replace function public.crew_capture_enquiry");
  assert.ok(at >= 0, "the function is not in the file");
  const end = sqlCode.indexOf("$fn$;", sqlCode.indexOf("$fn$", at) + 4);
  return sqlCode.slice(at, end + 5);
}
const sqlKeys = (body) => [...body.matchAll(/p_capture\s*->>\s*'([a-z_]+)'/g)].map((m) => m[1]);
const kotlinKeys = () => {
  const code = stripKt(read(KT + "ui/crew/EnquiryCaptureLogic.kt"));
  const at = code.indexOf("val KEYS");
  return [...code.slice(at, matching(code, code.indexOf("(", at))).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
};

/** Violations of the SQL file's promises. Empty is good. */
function sqlViolations(sqlText) {
  const bad = [];
  const head = sqlText.split("\n").slice(0, 14).join("\n");
  if (!/STATUS: NOT APPLIED/.test(head)) bad.push("the header does not say NOT APPLIED");
  const code = stripSql(sqlText);
  const body = functionBody(code);
  // Additive: nothing is dropped, deleted, truncated or updated, bar re-creating its own policy.
  const destructive = code.replace(/drop policy if exists crew_enquiries_read on public\.crew_enquiries;/gi, "").match(/\b(delete\s+from|truncate|drop\s+(table|function|trigger|policy|column|index)|alter\s+table[^;]*\bdrop\b|update\s+public\.|insert\s+into\s+public\.(?!jobs\b|crew_enquiries\b))/gi);
  if (destructive) bad.push("destructive or unexpected statements: " + destructive.join(" | "));
  // The lead is not assigned to anyone, and no job_assignments row is written.
  if (/assigned_employee|job_assignments/i.test(body)) bad.push("the file assigns the lead (the capturer would then be able to see it, and what it is priced at)");
  // What goes into jobs: named, real, and not money.
  const ins = body.match(/insert\s+into\s+public\.jobs\s*\(([^)]*)\)/i);
  if (!ins) bad.push("no insert into jobs");
  else {
    const cols = ins[1].split(",").map((c) => c.trim());
    const money = cols.filter((c) => JOB_MONEY_COLUMNS.includes(c));
    if (money.length) bad.push("the insert names money columns: " + money);
    const allowed = ["company_id", "sync_id", "customer_name", "phone", "email", "address", "notes", "referral_source", "status", "created_at"];
    if (cols.some((c) => !allowed.includes(c)) || allowed.some((c) => !cols.includes(c))) bad.push("the insert's columns are not exactly the lead's: " + cols);
  }
  if (!/'DRAFT'/.test(body) || !/'Crew on site'/.test(body)) bad.push("the lead must be a DRAFT job with a referral_source of 'Crew on site'");
  // Gated: per person, before any write.
  const gate = body.search(/has_permission\('CAPTURE_ENQUIRY'\)/);
  const firstWrite = body.search(/insert\s+into/i);
  if (gate < 0) bad.push("no has_permission('CAPTURE_ENQUIRY') check");
  else if (firstWrite >= 0 && gate > firstWrite) bad.push("the permission is checked after the first write");
  if (!/auth\.uid\(\)/.test(body) || !/company_is_suspended\(\)/.test(body) || !/current_company_id\(\)/.test(body)) bad.push("the sign-in, suspension and company checks are not all there");
  if (!/security\s+definer/i.test(body) || !/set\s+search_path\s*=\s*public/i.test(body)) bad.push("not a SECURITY DEFINER function with a pinned search_path");
  if (!/revoke all on function public\.crew_capture_enquiry\(jsonb\) from public, anon;/i.test(code) || !/grant execute on function public\.crew_capture_enquiry\(jsonb\) to authenticated, service_role;/i.test(code)) bad.push("grants are not revoke-from-public/anon, grant-to-authenticated");
  // The answer reveals nothing about the job.
  const returns = [...body.matchAll(/return\s+(.*?);/gis)].map((m) => m[1].replace(/\s+/g, " "));
  if (!returns.length || returns.some((r) => !/^jsonb_build_object\('job_sync_id', sid, 'created', (true|false)\)$/.test(r))) bad.push("the function returns something other than {job_sync_id, created}: " + returns.join(" || "));
  // It reads exactly the keys the phone sends.
  const mine = [...new Set(sqlKeys(body))].sort(), theirs = [...new Set(kotlinKeys())].sort();
  if (JSON.stringify(mine) !== JSON.stringify(theirs)) bad.push(`jsonb keys differ -- SQL reads ${mine}; the phone sends ${theirs}`);
  // The provenance table: closed to every login but the office's read.
  if (!/alter table public\.crew_enquiries enable row level security;/i.test(code)) bad.push("crew_enquiries has no row level security");
  if (!/revoke all on public\.crew_enquiries from anon, authenticated;/i.test(code) || !/grant select on public\.crew_enquiries to authenticated;/i.test(code)) bad.push("crew_enquiries grants are not select-only");
  if (/grant\s+(insert|update|delete|all)[^;]*public\.crew_enquiries[^;]*to\s+(authenticated|anon)/i.test(code)) bad.push("a login can write crew_enquiries");
  const policy = code.match(/create policy crew_enquiries_read[\s\S]*?;/i);
  if (!policy) bad.push("no read policy");
  else {
    if (/captured_by\s*=\s*auth\.uid\(\)|auth\.uid\(\)\s*=\s*captured_by/i.test(policy[0])) bad.push("the capturer can read their own provenance row");
    for (const p of ["SEE_MONEY", "EDIT_JOBS", "SCHEDULE_AND_ASSIGN"]) if (!policy[0].includes(`has_permission('${p}')`)) bad.push("the read policy does not require " + p);
  }
  // It stands alone: only functions the live database has, and none from the unapplied crew-scope file.
  if (/\b(sees_all_jobs|can_see_job|my_visible_job_sync_ids|my_job_scope|my_employee_sync_ids)\b/.test(code)) bad.push("depends on supabase_crew_job_scope.sql, which is not applied");
  const called = [...new Set([...code.matchAll(/\bpublic\.([a-z_]+)\(/g)].map((m) => m[1]))].filter((n) => n !== "crew_capture_enquiry");
  const unknown = called.filter((n) => !LIVE_FUNCTIONS.includes(n) && !["companies", "profiles", "jobs", "crew_enquiries"].includes(n));
  if (unknown.length) bad.push("calls functions not known to be live: " + unknown);
  // The sentences and SQLSTATEs are the ones the phone classifies.
  const codes = [...body.matchAll(/errcode\s*=\s*'(\w+)'/g)].map((m) => m[1]);
  if (codes.some((c) => !["42501", "22023", "54000"].includes(c))) bad.push("raises an SQLSTATE the phone has no answer for: " + codes);
  if (!/do \$check\$/i.test(code)) bad.push("no self-check block");
  return bad;
}

test("the SQL file is unapplied and additive, names no money and no assignee, is gated per person, and answers only {job_sync_id, created}", () => {
  assert.deepEqual(sqlViolations(read(SQL_REL)), []);
});

test("the SQL reads exactly the nine keys the phone sends, and not one is money", () => {
  const body = functionBody(stripSql(read(SQL_REL)));
  assert.deepEqual([...new Set(sqlKeys(body))].sort(), ["address", "approx_feet", "captured_at_ms", "customer_name", "email", "fence_type", "notes", "phone", "sync_id"]);
  assert.deepEqual([...new Set(kotlinKeys())].sort(), [...new Set(sqlKeys(body))].sort());
});

test("TEETH: the SQL checks turn red for an assigned lead, a money column, a missing permission check, a readable provenance row, a crew-scope dependency and a leaky answer", () => {
  const sql = read(SQL_REL);
  const names = (m) => sqlViolations(m).join(" | ");
  assert.match(names(mutate(sql, "values (co, sid, nm, ph, em, ad, body, 'Crew on site', 'DRAFT', cap)", "values (co, sid, nm, ph, em, ad, body, 'Crew on site', 'DRAFT', cap)\n    on conflict do nothing;\n    update public.jobs set assigned_employee_sync_id = uid::text where sync_id = sid")), /assigns the lead|destructive/);
  assert.match(names(mutate(sql, "notes, referral_source, status, created_at)\n    values", "notes, referral_source, status, created_at, contract_total)\n    values")), /money columns/);
  assert.match(names(mutate(sql, "if not coalesce(public.has_permission('CAPTURE_ENQUIRY'), false) then", "if false then")), /no has_permission/);
  assert.match(names(mutate(sql, "and (select coalesce(public.has_permission('SEE_MONEY'), false)", "and (captured_by = auth.uid() or (select coalesce(public.has_permission('SEE_MONEY'), false)")), /capturer can read/);
  assert.match(names(mutate(sql, "and (select coalesce(public.has_permission('SEE_MONEY'), false)", "and (select coalesce(public.sees_all_jobs(), false) or coalesce(public.has_permission('SEE_MONEY'), false)")), /crew-scope|not applied/);
  assert.match(names(mutate(sql, "return jsonb_build_object('job_sync_id', sid, 'created', true);", "return jsonb_build_object('job_sync_id', sid, 'created', true, 'status', 'DRAFT');")), /returns something other/);
  assert.match(names(mutate(sql, "fk := left(btrim(coalesce(p_capture->>'fence_type', '')), 30);", "fk := left(btrim(coalesce(p_capture->>'fence_type', '')), 30);\n    nt := coalesce(p_capture->>'quoted_price', '');")), /jsonb keys differ/);
  assert.match(names(mutate(sql, "STATUS: NOT APPLIED.  Written", "STATUS: APPLIED.  Written")), /NOT APPLIED/);
  assert.match(names(sql.replace("revoke all on function public.crew_capture_enquiry(jsonb) from public, anon;", "")), /grants/);
});

test("the premises the SQL header states about the office are true of the code: DRAFT with no first contact is a New Lead and is chased", () => {
  const dash = readFileSync(join(ROOT, "website/dashboard.html"), "utf8");
  assert.match(dash, /function stageOf\(j\)\{[\s\S]*?return 'New Lead';\s*\}/);
  assert.match(dash, /alertOn\('uncontacted_lead'\)\) jobs\.filter\(j => !j\.first_contact_at\s*&& \['DRAFT','SENT'\]\.includes\(j\.status\)\s*&& \(nowMs - d\(j\.created_at\)\.getTime\(\)\) > 4 \* 36e5/);
  // ...and the public form makes the same record, so there is one lead shape, not two.
  const intake = readFileSync(join(ROOT, "supabase/functions/lead-intake/index.ts"), "utf8");
  assert.match(intake, /from\("jobs"\)\.insert\(\{[\s\S]*?customer_name: name,[\s\S]*?referral_source: "Website"/);
  // Photos: the office lists {company}/{job}/photo/ -- the folder the app uploads capture photos into.
  assert.match(dash, /const kinds=\['photo','signature','survey','change-order'\]/);
  assert.match(dash, /root=profile\.company_id\+'\/'\+sid/);
  assert.match(stripKt(read(KT + "cloud/FileSync.kt")), /val remotePath = "\$companyId\/\$jobSyncId\/\$kind\/\$\{file\.name\}"/);
  assert.match(stripKt(read(KT + "ui/crew/EnquiryCaptureSender.kt")), /FileSync\.upload\(companyId, capture\.syncId, "photo", toUpload\)/);
});

test("the capture adds no permission to the server's tables: the app, has_permission's copy in job-push.ts and the SQL header agree", () => {
  const push = readFileSync(join(ROOT, "supabase/functions/_shared/job-push.ts"), "utf8");
  assert.ok(!/CAPTURE_ENQUIRY/.test(push), "job-push.ts's role table needs no entry (the permission is in no role)");
  assert.ok(!/CAPTURE_ENQUIRY/.test(stripSql(read(SQL_REL)).replace(/has_permission\('CAPTURE_ENQUIRY'\)/g, "")), "the SQL has no role list naming it");
  assert.match(read(SQL_REL), /THE SERVER NEEDS NO has_permission\(\) CHANGE/);
});

// ================================================ 6. NO MONEY, NO DELETE, NO READ-BACK ==

test("nothing on the capture path (Kotlin, strings, SQL) is money, and nothing reads a lead back", () => {
  const moneyWords = /\b(price|prices|priced|pricing|cost|costs|rate|rates|total|totals|deposit|tax|amount|fee|fees|margin|markup|discount|paid|payment|balance|quote|estimate|invoice|money|dollar|refund)\b/i;
  const tokens = (code) => [...code.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].flatMap((m) => m[0].split("_").flatMap((p) => p.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) || [])).map((w) => w.toLowerCase());
  for (const f of CAPTURE_FILES) assert.deepEqual(tokens(stripKt(read(KT + f))).filter((w) => moneyWords.test(w)), [], f + " carries a money word");
  // the SQL function: no money column and no money word in the executable part
  const body = functionBody(stripSql(read(SQL_REL)));
  assert.deepEqual(tokens(body).filter((w) => moneyWords.test(w)), [], "the SQL function names money");
  // TEETH
  assert.deepEqual(tokens("val grandTotal = depositDue").filter((w) => moneyWords.test(w)), ["total", "deposit"]);
  // the only network reads: one RPC and the photo upload
  const sender = stripKt(read(KT + "ui/crew/EnquiryCaptureSender.kt"));
  assert.deepEqual([...sender.matchAll(/rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1]), ["crew_capture_enquiry"]);
  for (const bad of [".from(", "jobs_crew", ".select", "estimate_line_items", "change_orders", "list_requestable_jobs"]) assert.ok(!sender.includes(bad), "the sender reads: " + bad);
  // no delete anywhere on the path
  for (const f of CAPTURE_FILES.filter((f) => !f.includes("Sender"))) assert.ok(!/delete|remove|trash/i.test(stripKt(read(KT + f))), f + " mentions deleting");
  const repo = read(KT + "data/Repository.kt");
  const block = stripKt(repo.slice(repo.indexOf("// ---- Enquiry capture"), repo.indexOf("// ---- Build templates")));
  assert.ok(block.length > 500 && !/delete|remove|queueDeletion|pendingDeletion|trash/i.test(block), "the repository's capture block deletes");
  assert.ok(!/jobDao|createJob|updateJob|observeJobs|getJob\(/.test(block), "the capture block touches jobs");
});

test("the screen's gate, the guest guard first, and the sign-out count are in the code the build compiles", () => {
  const vm = stripKt(read(KT + "ui/crew/EnquiryCaptureViewModel.kt"));
  assert.match(vm, /fun save\([^)]*\) -> Unit\) \{\s*if \(session\.state\.value\.isGuestDemo\) \{/);
  assert.match(vm, /fun sendAgain\(captureId: Long\) \{\s*if \(session\.state\.value\.isGuestDemo\) return/);
  const repo = stripKt(read(KT + "data/Repository.kt"));
  for (const fn of ["saveEnquiryCapture", "editEnquiryCapture", "retryEnquiryCapture"]) assert.match(repo, new RegExp(`suspend fun ${fn}\\([\\s\\S]{0,400}?guardWrite\\("${fn}"\\)`));
  assert.match(repo, /jobs = unsyncedJobIds\.size \+ enquiryCaptureDao\.countUnsent\(\)/);
  assert.match(repo, /suspend fun hasEnquiriesWaiting\(\): Boolean =\s*enquiryCaptureDao\.countUnsent\(\) > 0 \|\| enquiryCaptureDao\.countPhotosNotUploaded\(\) > 0/);
  // a capture is only ever sent or listed under the company it was taken under
  const logic = stripKt(read(KT + "ui/crew/EnquiryCaptureLogic.kt"));
  assert.match(logic, /if \(queued\.companyId != companyId\) continue/);
  assert.match(logic, /if \(capture\.companyId != companyId\) continue/);
  assert.match(logic, /captures\.filter \{ it\.companyId == companyId \}/);
  assert.match(stripKt(read(KT + "ui/crew/EnquiryCaptureViewModel.kt")), /draft\.toCapture\(now, company\)/);
  const screen = stripKt(read(KT + "ui/crew/EnquiryCaptureScreen.kt"));
  assert.match(screen, /if \(!EnquiryCaptureAccess\.mayCapture\(session\)\) return/);
  assert.match(screen, /const val ENQUIRY_CAPTURE_ROUTE = "capture_enquiry"/);
});

// ================================================================== B. KOTLIN ==

const KOTLIN = process.env.A28_KOTLIN === "1";
const SKIP_KOTLIN = KOTLIN ? false : "set A28_KOTLIN=1 to compile the real sources (Compose included) and run JUnit, with no gradlew";
const NEIGHBOURS = ["cloud/PermissionsTest.kt", "StringResourceSanityTest.kt", "data/UnsyncedSummaryTest.kt", "guest/GuestReadOnlyTest.kt", "data/HomeCardAudienceTest.kt", "ui/jobs/HomeAttentionAudienceTest.kt"];
const NEIGHBOUR_CLASSES = ["cloud.PermissionsTest", "StringResourceSanityTest", "data.UnsyncedSummaryTest", "guest.GuestReadOnlyTest", "data.HomeCardAudienceTest", "ui.jobs.HomeAttentionAudienceTest"].map((c) => "com.fenceestimator.app." + c);
const junit = (extra = {}) => runTests({ mainSources: MAIN_SOURCES, testSources: [TEST_FILE, REST_ERRORS], testClasses: [TEST_CLASS], ...extra });
const mainFile = (rel) => join(ROOT, KT + rel);

test("KOTLIN: the toolchain is there (the Gradle cache, a previous app build, the Compose plugin)", { skip: SKIP_KOTLIN }, () => {
  const { missing } = toolchain();
  assert.deepEqual(missing, [], "toolchain incomplete: " + missing.join(", "));
});

test("KOTLIN: every changed source compiles together -- the Compose screen, the Room entities and dao, the repository, the exhaustive `when` -- and EnquiryCaptureTest passes", { skip: SKIP_KOTLIN, timeout: 1_500_000 }, (t) => {
  const r = junit();
  assert.equal(r.status, 0, `stage ${r.stage}\n` + r.out.slice(-4000));
  const ok = r.out.match(/OK \((\d+) tests?\)/);
  assert.ok(ok, "no OK line:\n" + r.out.slice(-1500));
  assert.ok(Number(ok[1]) >= 35, "only " + ok[1] + " tests ran");
  t.diagnostic(`JUnit: OK (${ok[1]} tests) in EnquiryCaptureTest, over the real compiled sources`);
});

test("KOTLIN: the repo's neighbouring tests still pass against the changed Permissions, Repository and strings", { skip: SKIP_KOTLIN, timeout: 1_500_000 }, (t) => {
  const base = join(ROOT, "app/src/test/java/com/fenceestimator/app/");
  const r = runTests({ mainSources: MAIN_SOURCES, testSources: [...NEIGHBOURS.map((n) => base + n), REST_ERRORS], testClasses: NEIGHBOUR_CLASSES });
  assert.equal(r.status, 0, `stage ${r.stage}\n` + r.out.slice(-4000));
  const ok = r.out.match(/OK \((\d+) tests?\)/);
  assert.ok(ok, "no OK line:\n" + r.out.slice(-1500));
  t.diagnostic(`neighbours: OK (${ok[1]} tests)`);
});

/**
 * A scratch copy of the files the SOURCE-TEXT checks in EnquiryCaptureTest read, laid out the way Gradle runs unit tests
 * (the working directory is the app module; the repo root is its parent), with some of them changed. Those checks read the
 * text on disk, not the compiled classes, so a mutation of THEM has to be made in the text they read -- an overlay of
 * compiled classes (used by the behavioural teeth above) would leave them looking at the real files and stay green.
 */
function scratchApp(changes) {
  const root = mkdtempSync(join(tmpdir(), "a28-scratch-"));
  const app = join(root, "app");
  const srcRoot = join(ROOT, KT);
  const dstRoot = join(app, "src/main/java/com/fenceestimator/app/");
  for (const rel of [...CAPTURE_FILES, "data/Daos.kt", "data/Repository.kt", "ui/components/EnumLabels.kt"]) {
    mkdirSync(join(dstRoot, rel, ".."), { recursive: true });
    cpSync(join(srcRoot, rel), join(dstRoot, rel));
  }
  for (const loc of ["values", "values-es", "values-fr"]) {
    mkdirSync(join(app, "src/main/res", loc), { recursive: true });
    cpSync(join(ROOT, "app/src/main/res", loc, "strings.xml"), join(app, "src/main/res", loc, "strings.xml"));
  }
  cpSync(join(ROOT, SQL_REL), join(root, SQL_REL));
  for (const [rel, text] of Object.entries(changes)) writeFileSync(join(dstRoot, rel), text);
  return { root, app };
}

/** The same JUnit suite over a scratch tree whose TEXT was sabotaged: it must go red, naming the rule. */
function mustFailOnText(label, changes, pattern) {
  const scratch = scratchApp(changes);
  try {
    const r = runTests({ mainSources: MAIN_SOURCES, testSources: [TEST_FILE, REST_ERRORS], testClasses: [TEST_CLASS], cwd: scratch.app });
    assert.notEqual(r.status, 0, `${label}: the suite stayed green with the rule broken`);
    assert.equal(r.stage, "junit", `${label}: it did not reach the tests (${r.stage})\n` + r.out.slice(-1500));
    assert.match(r.out, pattern, `${label}: failed, but not for the reason it should have:\n` + r.out.slice(-1800));
  } finally { rmSync(scratch.root, { recursive: true, force: true }); }
}

/** A sabotaged copy must NOT pass: red JUnit naming the broken rule, or a build that stops. */
function mustFail(label, overlay, pattern, stage) {
  const r = junit({ overlay });
  assert.notEqual(r.status, 0, `${label}: the suite stayed green with the rule broken`);
  if (stage) assert.equal(r.stage, stage, `${label}: failed at ${r.stage}, wanted ${stage}\n` + r.out.slice(-1500));
  assert.match(r.out, pattern, `${label}: failed, but not for the reason it should have:\n` + r.out.slice(-1800));
}

test("KOTLIN TEETH 1: a role that is given the permission by default turns the suite red", { skip: SKIP_KOTLIN, timeout: 1_500_000 }, () => {
  const f = mainFile("cloud/Permissions.kt");
  mustFail("permission to crew", { [f]: mutate(readFileSync(f, "utf8"), "UserRole.CREW -> setOf(Permission.RECORD_FIELD_WORK)", "UserRole.CREW -> setOf(Permission.RECORD_FIELD_WORK, Permission.CAPTURE_ENQUIRY)") }, /no role holds the permission by default|must not inherit it|crew member without it/);
});

test("KOTLIN TEETH 2: a price field on the capture turns the suite red", { skip: SKIP_KOTLIN, timeout: 1_500_000 }, () => {
  const f = mainFile("data/Entities.kt");
  mustFail("price on the entity", { [f]: mutate(readFileSync(f, "utf8").replace(/\r\n/g, "\n"), '    val rejectedWhy: String = ""\n) {\n    val isSent', '    val rejectedWhy: String = "",\n    val quotedPrice: Double = 0.0\n) {\n    val isSent') }, /no type on the capture path has a money field|quotedPrice/);
});

test("KOTLIN TEETH 3: a pass that throws away a capture it could not send turns the suite red", { skip: SKIP_KOTLIN, timeout: 1_500_000 }, () => {
  const f = mainFile("ui/crew/EnquiryCaptureLogic.kt");
  const src = readFileSync(f, "utf8");
  mustFail("no signal marks it refused", { [f]: mutate(src, "                is SendOutcome.TryLater -> {\n                    store.release(capture.id)\n                    waiting = outcome.why\n                }", "                is SendOutcome.TryLater -> {\n                    store.markRejected(capture.id, now(), outcome.why.name)\n                    waiting = outcome.why\n                }") }, /with no signal the capture stays|signed out is reported|not refused/);
  mustFail("sent on the server's say-so alone", { [f]: mutate(src, "        val id = (answer as? JsonObject)?.get(\"job_sync_id\") as? JsonPrimitive ?: return false\n        return id.isString && id.content.equals(syncId, ignoreCase = true)", "        return true") }, /good news|holds a different capture/);
});

test("KOTLIN TEETH 4: a delete query on the capture DAO turns the suite red", { skip: SKIP_KOTLIN, timeout: 1_500_000 }, () => {
  const f = mainFile("data/Daos.kt");
  const withDelete = mutate(readFileSync(f, "utf8"), "    @Query(\"UPDATE enquiry_capture_photos SET storagePath", "    @Query(\"DELETE FROM enquiry_captures WHERE id = :id\")\n    suspend fun gone(id: Long): Int\n\n    @Query(\"UPDATE enquiry_capture_photos SET storagePath");
  mustFailOnText("a delete query", { "data/Daos.kt": withDelete }, /there is no delete anywhere on the capture path|no @Delete|no DELETE FROM/);
});

test("KOTLIN TEETH 5: a sender that reads the job back turns the suite red", { skip: SKIP_KOTLIN, timeout: 1_500_000 }, () => {
  const f = mainFile("ui/crew/EnquiryCaptureSender.kt");
  const reads = mutate(readFileSync(f, "utf8"), "            // Only the server saying it holds THIS capture counts. A 200 with\n", "            SupabaseModule.client.postgrest.from(\"jobs_crew\").select()\n            // Only the server saying it holds THIS capture counts. A 200 with\n");
  mustFailOnText("a sender that reads jobs_crew", { "ui/crew/EnquiryCaptureSender.kt": reads }, /never reads a lead back|must not read/);
});

test("KOTLIN TEETH 6: a string that is not in strings.xml stops the build", { skip: SKIP_KOTLIN, timeout: 1_500_000 }, () => {
  const f = mainFile("ui/crew/EnquiryCaptureScreen.kt");
  mustFail("a missing resource", { [f]: mutate(readFileSync(f, "utf8"), "R.string.enq_save_changes", "R.string.enq_save_changez") }, /enq_save_changez/, "overlay");
});

// ==================================================================== C. LIVE ==

const LIVE = process.env.A28_LIVE === "1";
const SKIP_LIVE = LIVE ? false : "set A28_LIVE=1 to read the live database (SELECTs only, positive control on every probe)";
const PROJECT = "newcrgafcptspmapacrx";

/** One SELECT file through the CLI, retried; ERROR in the raw output is a failure, never an empty answer. */
function liveRows(sql) {
  const dir = mkdtempSync(join(tmpdir(), "a28-live-"));
  const f = join(dir, "q.sql");
  writeFileSync(f, sql);
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query", "--linked", "--project-ref", PROJECT, "-f", f, "--output", "json"], { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32", timeout: 280_000, maxBuffer: 32 * 1024 * 1024 });
    last = (r.stdout || "") + (r.stderr || "");
    if (r.status === 0 && !/ERROR/.test(r.stdout || "")) { rmSync(dir, { recursive: true, force: true }); return JSON.parse(r.stdout).rows; }
  }
  rmSync(dir, { recursive: true, force: true });
  assert.fail("the live read failed three times (never read as 'nothing there'):\n" + last.slice(-800));
}

test("LIVE: has_permission() needs no change (generic override, in no role's list), and the crew view carries no money column", { skip: SKIP_LIVE, timeout: 900_000 }, () => {
  const rows = liveRows(`
    select 'fn' as k, pg_get_functiondef('public.has_permission(text)'::regprocedure) as v
    union all select 'jobs_cols', string_agg(column_name::text, ',' order by column_name::text) from information_schema.columns where table_schema='public' and table_name='jobs'
    union all select 'crew_cols', string_agg(column_name::text, ',' order by column_name::text) from information_schema.columns where table_schema='public' and table_name='jobs_crew'
    union all select 'money', array_to_string(public.job_money_columns(), ',')
    union all select 'created_by_cols', count(*)::text from information_schema.columns where table_schema='public' and table_name='jobs' and column_name in ('created_by','captured_by','creator_id')
    union all select 'control_by_cols', count(*)::text from information_schema.columns where table_schema='public' and table_name='jobs' and column_name in ('first_contact_by')
    union all select 'ours_already_there', count(*)::text from pg_proc where pronamespace='public'::regnamespace and proname='crew_capture_enquiry'
    union all select 'ours_table', count(*)::text from pg_class where relnamespace='public'::regnamespace and relname='crew_enquiries'
    union all select 'insert_policy', coalesce(with_check,'-') from pg_policies where schemaname='public' and tablename='jobs' and policyname='jobs_insert'
    union all select 'insert_priv', has_table_privilege('authenticated','public.jobs','INSERT')::text
    union all select 'money_policy', coalesce(qual,'-') from pg_policies where schemaname='public' and tablename='jobs' and policyname='jobs_money_hidden_from_crew'
    union all select 'fns_present', string_agg(proname, ',' order by proname) from pg_proc where pronamespace='public'::regnamespace and proname in ('current_company_id','company_is_suspended','has_permission','job_money_columns')
  `);
  const v = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  // POSITIVE CONTROLS: the probes can see what they claim to see.
  assert.match(v.fn, /APPROVE_PLAN_CHANGES/, "control: the has_permission body read back is the real one");
  assert.ok(v.jobs_cols.split(",").length > 100, "control: the base jobs table has its columns");
  const money = v.money.split(",");
  assert.deepEqual(money.slice().sort(), JOB_MONEY_COLUMNS.slice().sort(), "the money list in this test is stale -- job_money_columns() changed");
  const jobsCols = new Set(v.jobs_cols.split(","));
  assert.ok(money.every((m) => jobsCols.has(m)), "control: every money column IS on the base table, so an absent one in the crew view means something");
  assert.equal(v.control_by_cols, "1", "control: the by-column probe can see a column that exists (first_contact_by)");
  assert.match(v.money_policy, /has_permission\('SEE_MONEY'/, "control: the base table is closed to a caller without SEE_MONEY");
  // THE CLAIMS.
  assert.ok(/position\('\+' \|\| perm in/.test(v.fn) && /position\('-' \|\| perm in/.test(v.fn), "has_permission answers +/- overrides generically");
  assert.ok(!/CAPTURE_ENQUIRY/.test(v.fn), "no role lists the permission");
  assert.match(v.fn, /when 'OWNER' then true/, "OWNER holds every permission, as in Permissions.kt");
  const crewCols = new Set(v.crew_cols.split(","));
  assert.deepEqual(money.filter((m) => crewCols.has(m)), [], "the crew view carries no money column");
  assert.ok(crewCols.size > 40, "control: the crew view has its columns");
  assert.equal(v.created_by_cols, "0", "nothing on jobs records who created it, so nothing creator-based can show it to them");
  // Nothing of ours is live: this file is unapplied, and the dependencies are real.
  assert.equal(v.ours_already_there, "0");
  assert.equal(v.ours_table, "0");
  assert.equal(v.fns_present, "company_is_suspended,current_company_id,has_permission,job_money_columns");
  // The pre-existing gap the SQL header describes, held true so the header cannot go stale.
  assert.equal(v.insert_policy, "(company_id = current_company_id())");
  assert.equal(v.insert_priv, "true");
});

test("LIVE: the crew-scope SQL is NOT applied, so today every crew login reads every job through a money-free view -- and the view has no scope clause", { skip: SKIP_LIVE, timeout: 900_000 }, () => {
  const rows = liveRows(`
    select 'present' as k, string_agg(proname, ',' order by proname) as v from pg_proc where pronamespace='public'::regnamespace and proname in ('current_company_id','sees_all_jobs','can_see_job','my_visible_job_sync_ids','my_job_scope')
    union all select 'tables', count(*)::text from pg_class where relnamespace='public'::regnamespace and relname in ('job_assignments','job_access_requests')
    union all select 'view', pg_get_viewdef('public.jobs_crew'::regclass, true)
  `);
  const v = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  assert.match(v.present, /current_company_id/, "control: the probe sees a function that exists");
  assert.ok(!/sees_all_jobs|my_visible_job_sync_ids/.test(v.present), "crew scope became live: re-read the header's claim about what a crew login can see, and add the capturer-invisible proof");
  assert.equal(v.tables, "0");
  assert.match(v.view, /WHERE company_id = current_company_id\(\)/, "control: the view definition is the real one");
  assert.ok(!/my_visible_job_sync_ids|crew_enquiries|captured/.test(v.view), "nothing in the view ties it to who captured a job");
});
