#!/usr/bin/env node
/**
 * Turns a crash report from a release build back into real names.
 *
 * The link build renames every class, so app_errors stores lines like
 *
 *     java.lang.ClassCastException: r4.j cannot be cast to c0.a
 *         at c0.f.b(SourceFile:17)
 *         at I2.Y3.b(SourceFile:1693)
 *
 * and that is unreadable without the mapping.txt R8 wrote during THAT build.
 * publish-release.mjs now keeps one per published version in
 * build-archive/mappings/, which is what this reads.
 *
 * Usage:
 *   node scripts/read-crash.mjs --id 1440               # pull the stack from app_errors
 *   node scripts/read-crash.mjs 704 --stack crash.txt
 *   node scripts/read-crash.mjs 704 < crash.txt
 *   node scripts/read-crash.mjs --mapping path/to/mapping.txt.gz --stack crash.txt
 *
 * With --id and no version, the version is taken from the row itself, which is
 * the whole point: a stack read against the wrong build's mapping produces
 * confident, wrong names. If that version's mapping was never kept, this says
 * so and stops rather than guessing with a mapping that happens to be on disk.
 *
 * WHAT IT DOES NOT DO. This is not full retrace: it resolves class names,
 * method names and line numbers, and prints any inline frames it finds, but it
 * does not reconstruct synthetic lambda nesting or source file names. That is
 * enough to name the file and the function, which is the question being asked.
 */

import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const MAPPING_DIR = join(REPO_ROOT, "build-archive", "mappings");
const PROJECT_REF = "newcrgafcptspmapacrx";

const args = process.argv.slice(2);
// A flag's VALUE is not a bare version number. "--id 1440" read 1440 as the
// version too, and then refused its own request for disagreeing with itself.
const consumed = new Set();
function flag(name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  consumed.add(i + 1);
  return args[i + 1] ?? null;
}

const errorId = flag("--id");
const stackFile = flag("--stack");
let mappingPath = flag("--mapping");
let version = args.find((a, i) => !consumed.has(i) && /^[0-9]+$/.test(a)) ?? null;

// ---------------------------------------------------------------- the stack

let stack = null;

if (errorId !== null) {
  const sql = `select version_code, version_name, where_at, message, stack
                 from public.app_errors where id = ${Number(errorId)};`;
  const f = join(tmpdir(), `ff-crash-${process.pid}.sql`);
  writeFileSync(f, sql);
  let out;
  try {
    out = execFileSync(
      "npx.cmd",
      ["-y", "supabase", "db", "query", "--linked", "--project-ref", PROJECT_REF, "-f", `"${f}"`, "--output", "json"],
      { encoding: "utf8", shell: true });
  } finally {
    rmSync(f, { force: true });
  }
  const body = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  const row = (body.rows ?? [])[0];
  if (!row) {
    console.error(`No app_errors row with id ${errorId}.`);
    process.exit(1);
  }
  stack = row.stack || row.message || "";
  console.log(`Error ${errorId}: ${row.version_name} on the ${row.where_at} screen`);
  console.log(`  ${String(row.message).split("\n")[0]}`);
  console.log("");
  // The row's own version wins. Passing a different one on the command line is
  // how you get names from the wrong build, so it is refused rather than
  // quietly preferred either way.
  if (version !== null && Number(version) !== row.version_code) {
    console.error(`That crash came from version ${row.version_code}, not ${version}.`);
    console.error("Reading it against another build's mapping produces wrong names.");
    process.exit(1);
  }
  version = String(row.version_code);
} else if (stackFile !== null) {
  stack = readFileSync(stackFile, "utf8");
} else if (!process.stdin.isTTY) {
  stack = readFileSync(0, "utf8");
}

if (!stack) {
  console.error("No stack to read. Pass --id <app_errors id>, --stack <file>, or pipe one in.");
  process.exit(1);
}

// -------------------------------------------------------------- the mapping

if (mappingPath === null) {
  if (version === null) {
    console.error("Which version? Pass the version code, or --mapping <file>.");
    console.error(available());
    process.exit(1);
  }
  const gz = join(MAPPING_DIR, `mapping-${version}.txt.gz`);
  const plain = join(MAPPING_DIR, `mapping-${version}.txt`);
  mappingPath = existsSync(gz) ? gz : existsSync(plain) ? plain : null;
  if (mappingPath === null) {
    console.error(`No mapping kept for version ${version}, so this crash cannot be read.`);
    console.error("");
    console.error("Mappings are kept from the build that publishes them onward; anything");
    console.error("released before that is gone, and the mapping from a later build names");
    console.error("different classes -- it would answer confidently and wrongly.");
    console.error(available());
    process.exit(1);
  }
}

function available() {
  if (!existsSync(MAPPING_DIR)) return `\nNo mappings kept yet (${MAPPING_DIR} does not exist).`;
  const have = readdirSync(MAPPING_DIR)
    .map((f) => /^mapping-([0-9]+)[.]txt(?:[.]gz)?$/.exec(f))
    .filter((m) => m !== null)
    .map((m) => m[1])
    .sort((a, b) => Number(b) - Number(a));
  return have.length === 0
    ? `\nNo mappings kept yet in ${MAPPING_DIR}.`
    : `\nKept mappings: ${have.join(", ")}`;
}

// Which obfuscated classes does this stack actually mention? Only those blocks
// are held in memory -- mapping.txt is around 100 MB uncompressed.
const FRAME = /^\s*at\s+([A-Za-z0-9_$.]+)\.([A-Za-z0-9_$<>]+)\((?:[^):]*)(?::(-?[0-9]+))?\)/;
const CAST = /\b([a-zA-Z0-9_$.]+) cannot be cast to ([a-zA-Z0-9_$.]+)/;

const wanted = new Set();
const frames = [];
for (const line of stack.split("\n")) {
  const m = FRAME.exec(line);
  if (m) {
    frames.push({ raw: line, cls: m[1], method: m[2], line: m[3] === undefined ? null : Number(m[3]) });
    wanted.add(m[1]);
    continue;
  }
  const c = CAST.exec(line);
  if (c) { wanted.add(c[1]); wanted.add(c[2]); }
}
// Anything in the message, too: "r4.j cannot be cast to c0.a" is usually the
// most useful line in the whole report.
const castLine = CAST.exec(stack);

const classes = new Map();  // obfuscated name -> { real, members: [...] }
const CLASS_LINE = /^([^\s:][^\n]*?) -> ([A-Za-z0-9_$.]+):\s*$/;
const MEMBER_LINE = /^\s+(?:([0-9]+):([0-9]+):)?(.+?) ([A-Za-z0-9_$<>]+)\((.*?)\)(?::([0-9]+)(?::([0-9]+))?)?\s* -> ([A-Za-z0-9_$<>]+)\s*$/;

let classesSeen = 0;
await new Promise((done, fail) => {
  const raw = createReadStream(mappingPath);
  const text = mappingPath.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  const rl = createInterface({ input: text, crlfDelay: Infinity });
  let current = null;
  rl.on("line", (line) => {
    const cm = CLASS_LINE.exec(line);
    if (cm) {
      classesSeen++;
      current = wanted.has(cm[2]) ? { real: cm[1], members: [] } : null;
      if (current) classes.set(cm[2], current);
      return;
    }
    if (current === null) return;
    if (line.trimStart().startsWith("#")) {
      const k = line.indexOf('"fileName"');
      if (k !== -1) {
        const q1 = line.indexOf('"', line.indexOf(":", k) + 1);
        const q2 = q1 === -1 ? -1 : line.indexOf('"', q1 + 1);
        if (q2 !== -1) current.file = line.slice(q1 + 1, q2);
      }
      return;
    }
    const mm = MEMBER_LINE.exec(line);
    if (mm === null) return;
    current.members.push({
      obfFrom: mm[1] === undefined ? null : Number(mm[1]),
      obfTo: mm[2] === undefined ? null : Number(mm[2]),
      signature: mm[3],
      name: mm[4],
      srcFrom: mm[6] === undefined ? null : Number(mm[6]),
      srcTo: mm[7] === undefined ? null : Number(mm[7]),
      obfName: mm[8],
    });
  });
  rl.on("close", done);
  raw.on("error", fail);
  text.on("error", fail);
});

if (classesSeen === 0) {
  console.error(`${mappingPath} held no class lines at all -- it is not a mapping file.`);
  process.exit(1);
}

// ------------------------------------------------------------- the answer

function resolveClass(obf) {
  const hit = classes.get(obf);
  return hit ? hit.real : null;
}

function resolveFrame(f) {
  const cls = classes.get(f.cls);
  if (!cls) return null;
  const candidates = cls.members.filter((m) => m.obfName === f.method);
  if (candidates.length === 0) return { real: cls.real, file: cls.file ?? null, method: f.method, line: f.line, exact: false };
  // An obfuscated line number lands inside at most one obf range per frame,
  // except where R8 inlined -- then several entries share the range and the
  // list is the inline chain, innermost first.
  const inRange = f.line === null ? [] : candidates.filter(
    (m) => m.obfFrom !== null && f.line >= m.obfFrom && f.line <= m.obfTo);
  const picked = inRange.length > 0 ? inRange : [candidates[0]];
  return {
    real: cls.real,
    file: cls.file ?? null,
    chain: picked.map((m) => {
      let src = m.srcFrom;
      // A range whose two original line numbers are EQUAL maps the whole
      // obfuscated range to that one line -- interpolating across it walks off
      // the end and names the next statement instead. Only a genuinely
      // widening range is interpolated.
      if (src !== null && m.srcTo !== null && m.srcTo !== m.srcFrom && m.obfFrom !== null && f.line !== null) {
        src = m.srcFrom + (f.line - m.obfFrom);
      }
      return { method: m.name, signature: m.signature, line: src, inlined: picked.length > 1 };
    }),
    exact: inRange.length > 0,
  };
}

console.log(`Read against ${mappingPath.replace(REPO_ROOT + "\\", "").replace(REPO_ROOT + "/", "")}`);
console.log("");

if (castLine) {
  const a = resolveClass(castLine[1]);
  const b = resolveClass(castLine[2]);
  console.log("The cast that failed:");
  console.log(`  ${a ?? castLine[1] + "  (not in this mapping)"}`);
  console.log(`  cannot be cast to`);
  console.log(`  ${b ?? castLine[2] + "  (not in this mapping)"}`);
  console.log("");
}

let resolved = 0;
console.log("Stack:");
for (const f of frames) {
  const r = resolveFrame(f);
  if (r === null) {
    console.log(`  ?  ${f.cls}.${f.method}(${f.line ?? "?"})`);
    continue;
  }
  resolved++;
  if (!r.chain) {
    console.log(`     ${r.real}.${r.method}(${r.file ?? "SourceFile"}:${r.line ?? "?"})   [method name not in mapping]`);
    continue;
  }
  for (const [i, c] of r.chain.entries()) {
    const mark = c.inlined ? "  >  " : "     ";
    const at = (r.file ?? "SourceFile") + (c.line === null ? "" : ":" + c.line);
    console.log(`${mark}${r.real}.${c.method}(${at})${r.exact ? "" : "   [line not matched]"}`);
  }
}

// An empty answer must not read as a good one. If barely anything resolved,
// the mapping almost certainly belongs to a different build.
console.log("");
console.log(`${resolved} of ${frames.length} frames resolved.`);
if (frames.length > 0 && resolved / frames.length < 0.5) {
  console.log("");
  console.log("That is too few. This mapping is probably from a different build than");
  console.log("the crash -- the names above, where there are any, should not be trusted.");
  process.exit(2);
}
