// a56-join-decision-fingerprint -- the tripwires behind the joining decision of 1 Oct 2026.
//
// WHAT THIS PROVES, and what it cannot. Everything here is STATIC: it reads the repository's own
// files and holds them to the four decisions in docs/JOINING_RUNS.md section 11. It runs no SQL,
// touches no Supabase project, compiles no Kotlin and starts no Gradle. The arithmetic of a shared
// post is proved elsewhere (tests/a32-join-posts.test.mjs, tests/a33-join-arithmetic-posts.test.mjs);
// the SQL in supabase_a56_join_reapproval_fingerprint.sql was proved against the LIVE database
// read-only before it was written -- the tail expression was computed inline as a SELECT on his 16
// real runs, byte-identical on every unjoined one and moved on all 11 eligible ones once a joint id
// was synthesised, with the canary reading false -- and that cannot be reproduced from here without
// a Postgres. What this file stops is the thing a probe cannot: somebody editing one of these files
// later and quietly undoing a decision.
//
//   1  READABILITY. Every file this test judges exists, is non-empty and holds no NUL byte. A grep
//      over a file with a NUL in it is silently empty, which is how an audit once reported zero
//      failures for a case it never read.
//   2  ONE HOME. The cloud has exactly one home for a join: two columns on fence_runs. No repo-root
//      .sql creates public.run_joins.
//   3  NON-DESTRUCTIVE. The new file writes no row and changes no table, policy or grant.
//   4  APPEND-ONLY. reapp_run_takeoff keeps its seven arguments in order, and the tail is appended
//      to that result -- not substituted for it, and not on the wrong branch of the gate.
//   5  THE GATE. All four disqualifiers are in it, so an unjoined, teardown, closed or empty run
//      gets no tail and its fingerprint stays byte-identical.
//   6  PART B ORDER. The do-not-apply marker is present exactly while either snapshot reader still
//      refuses a seven-part snapshot -- held from BOTH sides.
//   7  NO BACKFILL. Neither .sql joins a run that his own drawing did not join.
//   8  THE DOCS AGREE. The one place this track makes a field material that
//      docs/REAPPROVAL_RULE.md calls immaterial is written down where somebody will find it.
//
// Every claim that could pass by accident is run a second time against a mutated copy that must
// make it fail. A check with no teeth is the thing this repository keeps finding.
//
//   node --test tests/a56-join-decision-fingerprint.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const A56 = "supabase_a56_join_reapproval_fingerprint.sql";
const A32 = "supabase_a32_join_runs.sql";
const DOC = "docs/JOINING_RUNS.md";
const RULE = "docs/REAPPROVAL_RULE.md";
const PHONE = "app/src/main/java/com/fenceestimator/app/ui/jobs/JobDetailViewModel.kt";
const OFFICE = "website/dashboard.html";

const FILES = [A56, A32, DOC, RULE, PHONE, OFFICE];

function read(rel) {
  const raw = readFileSync(join(ROOT, rel), "utf8");
  return raw.replace(/\r\n/g, "\n");
}

/** SQL with `--` comments removed, so prose about a DELETE is never mistaken for one. */
const stripSql = (s) => s.replace(/--[^\n]*/g, "");

/**
 * `needle` replaced once. It must appear exactly once, or the mutation proves nothing: a
 * sabotage that matched nothing would leave a green test looking like a passing check.
 */
function mutate(text, needle, replacement) {
  assert.equal(
    text.split(needle).length, 2,
    "mutation anchor must appear exactly once: " + JSON.stringify(needle.slice(0, 80)),
  );
  return text.replace(needle, () => replacement);
}

// ---------------------------------------------------------------- 1. readability

test("READABILITY: every file this test judges exists, is not empty, and holds no NUL byte", () => {
  for (const rel of FILES) {
    let text;
    assert.doesNotThrow(() => { text = read(rel); }, rel + " could not be read");
    assert.ok(text.length > 0, rel + " is empty");
    assert.equal(text.includes("\u0000"), false,
      rel + " holds a NUL byte: a text search over it can come back silently empty");
  }
});

test("READABILITY TEETH: the NUL check fails on a string that has one", () => {
  const poisoned = "alter table public.fence_runs\u0000 add column";
  assert.equal(poisoned.includes("\u0000"), true);
});

// ---------------------------------------------------------------- 2. one home

test("ONE HOME: supabase_a32_join_runs.sql adds both joint columns to fence_runs", () => {
  const sql = stripSql(read(A32));
  for (const col of ["start_joint", "end_joint"]) {
    const re = new RegExp(
      "alter\\s+table\\s+public\\.fence_runs\\s+add\\s+column\\s+if\\s+not\\s+exists\\s+" +
      col + "\\s+text\\s+not\\s+null\\s+default\\s+''", "i",
    );
    assert.match(sql, re, col + " is not added as text not null default ''");
  }
});

test("ONE HOME: no repo-root .sql creates public.run_joins -- the retired design never reaches the cloud", () => {
  const sqls = readdirSync(ROOT).filter((f) => f.endsWith(".sql"));
  assert.ok(sqls.length > 50, "positive control: the root .sql files were not found (" + sqls.length + ")");
  const offenders = [];
  for (const f of sqls) {
    const body = stripSql(read(f));
    if (/create\s+table\s+(if\s+not\s+exists\s+)?(public\.)?run_joins\b/i.test(body)) offenders.push(f);
  }
  assert.deepEqual(offenders, [],
    "run_joins is created in the cloud by: " + offenders.join(", ") +
    " -- docs/JOINING_RUNS.md 11.1 retired the table design");
});

test("ONE HOME TEETH: the same scan finds a planted CREATE TABLE run_joins", () => {
  const planted = stripSql("-- a comment about run_joins\ncreate table if not exists public.run_joins (id uuid);\n");
  assert.match(planted, /create\s+table\s+(if\s+not\s+exists\s+)?(public\.)?run_joins\b/i);
});

test("ONE HOME TEETH: a mention of run_joins inside a COMMENT does not trip the scan", () => {
  const prose = stripSql("-- create table public.run_joins was the other design; it lost.\nselect 1;\n");
  assert.doesNotMatch(prose, /create\s+table\s+(if\s+not\s+exists\s+)?(public\.)?run_joins\b/i);
});

// ---------------------------------------------------------------- 3. non-destructive

/** Statement shapes that would touch his data or his protections. */
const DESTRUCTIVE = [
  ["a row delete", /\bdelete\s+from\b/i],
  ["a row insert", /\binsert\s+into\b/i],
  ["a row update", /\bupdate\s+(public\.|only\s)?[a-z_]+\s+set\b/i],
  ["a truncate", /\btruncate\b/i],
  ["a drop", /\bdrop\s+(table|column|policy|trigger|function|index|schema)\b/i],
  ["a table change", /\balter\s+table\b/i],
  ["a policy change", /\b(create|alter)\s+policy\b/i],
  ["a grant", /\bgrant\s+[a-z]/i],
  ["a revoke", /\brevoke\s+[a-z]/i],
  ["a trigger change", /\bcreate\s+(or\s+replace\s+)?trigger\b/i],
  ["a role change", /\b(create|alter)\s+role\b/i],
  ["set_config / session tampering", /\bset_config\s*\(/i],
];

test("NON-DESTRUCTIVE: the new file writes no row and changes no table, policy, grant or trigger", () => {
  const sql = stripSql(read(A56));
  assert.ok(sql.length > 500, "positive control: the file body survived comment stripping");
  for (const [what, re] of DESTRUCTIVE) {
    assert.doesNotMatch(sql, re, "the new file contains " + what);
  }
});

test("NON-DESTRUCTIVE: the only things it creates are the two function bodies it is meant to replace", () => {
  const sql = stripSql(read(A56));
  const creates = [...sql.matchAll(/create\s+or\s+replace\s+function\s+public\.([a-z_]+)/gi)]
    .map((m) => m[1]).sort();
  assert.deepEqual(creates, ["reapp_row_takeoff", "reapp_run_snapshot"]);
  // reapp_run_takeoff -- the seven-field base -- must be CALLED and never redefined.
  assert.doesNotMatch(sql, /create\s+or\s+replace\s+function\s+public\.reapp_run_takeoff/i);
  assert.doesNotMatch(sql, /create\s+or\s+replace\s+function\s+public\.reapp_is_empty/i);
  assert.doesNotMatch(sql, /create\s+or\s+replace\s+function\s+public\.reapp_(on_run_change|withdraw_approval|restore_approval|restores_approved_state|job_takeoff)/i);
});

test("NON-DESTRUCTIVE: no money column, no approval column and no signature column is written", () => {
  const sql = stripSql(read(A56));
  for (const col of [
    "deposit_amount", "amount_paid", "payment_status", "contract_total", "refunded_amount",
    "accepted_total", "job_payments", "signature_storage_path", "signed_at",
    "quote_approved_name", "reapproval_required_at", "reapproval_count",
  ]) {
    assert.doesNotMatch(sql, new RegExp("\\b" + col + "\\s*(:?=|,\\s*$)", "m"),
      col + " is assigned in the new file; it must name no money, approval or signature column");
  }
});

test("NON-DESTRUCTIVE TEETH: each destructive shape is caught in a mutated copy", () => {
  const sql = stripSql(read(A56));
  const plants = [
    "delete from public.fence_runs where true;",
    "insert into public.fence_runs (id) values (gen_random_uuid());",
    "update public.fence_runs set start_joint = 'x';",
    "truncate public.fence_runs;",
    "drop table public.quote_reapprovals;",
    "alter table public.fence_runs add column sneaky text;",
    "create policy sneaky on public.fence_runs for select using (true);",
    "grant all on public.fence_runs to anon;",
    "revoke select on public.fence_runs from authenticated;",
    "create trigger sneaky before insert on public.fence_runs execute function f();",
    "create role sneaky;",
    "select set_config('app.reapproval_clear', '1', true);",
  ];
  assert.equal(plants.length, DESTRUCTIVE.length, "one plant per shape");
  plants.forEach((plant, i) => {
    const broken = sql + "\n" + plant + "\n";
    const [what, re] = DESTRUCTIVE[i];
    assert.match(broken, re, "the check for " + what + " did not catch " + plant);
  });
});

// ---------------------------------------------------------------- 4. append-only

/** The body of one `create or replace function public.<name> ... $fn$ ... $fn$;` */
function fnBody(sql, name) {
  const re = new RegExp(
    "create\\s+or\\s+replace\\s+function\\s+public\\." + name + "[\\s\\S]*?\\$fn\\$([\\s\\S]*?)\\$fn\\$",
    "i",
  );
  const m = sql.match(re);
  assert.ok(m, "could not find the body of " + name);
  return m[1];
}

const BASE_ARGS = [
  "r.points_encoded", "r.gates_encoded", "r.closed_loop",
  "r.manual_linear_feet", "r.manual_corner_count", "r.is_teardown", "ppf",
];

test("APPEND-ONLY: the base fingerprint is still reapp_run_takeoff with the same seven arguments in the same order", () => {
  const body = fnBody(stripSql(read(A56)), "reapp_row_takeoff");
  const call = body.match(/public\.reapp_run_takeoff\s*\(([\s\S]*?)\)\s*as\s+fp/i);
  assert.ok(call, "reapp_row_takeoff no longer calls reapp_run_takeoff into `fp`");
  const args = call[1].split(",").map((s) => s.trim());
  assert.deepEqual(args, BASE_ARGS,
    "the seven base arguments changed; a reordered or substituted argument silently redefines " +
    "every fingerprint ever stored");
});

test("APPEND-ONLY: the tail is concatenated AFTER fp, and the EMPTY branch is the `then`", () => {
  const body = fnBody(stripSql(read(A56)), "reapp_row_takeoff");
  // `select fp || case when <gate> then '' else <tail> end` -- the gate selects the empty tail.
  const shape = body.match(/select\s+fp\s*\|\|\s*case([\s\S]*?)end\s+from\s+base/i);
  assert.ok(shape, "the tail is not `fp || case ... end`: either fp was replaced or the order changed");
  const branch = shape[1];
  const thenIdx = branch.search(/\bthen\s*''/);
  const elseIdx = branch.search(/\belse\s*'\|sj='/);
  assert.ok(thenIdx > 0, "the gate's `then` branch is not the empty string -- the gate is inverted");
  assert.ok(elseIdx > thenIdx, "the tail is not on the `else` branch");
});

test("APPEND-ONLY: the tail keys are exactly the six the decision names, in order", () => {
  const body = fnBody(stripSql(read(A56)), "reapp_row_takeoff");
  const keys = [...body.matchAll(/'\|(sj|ej|jf|jph|jfh|jso)='/g)].map((m) => m[1]);
  assert.deepEqual(keys, ["sj", "ej", "jf", "jph", "jfh", "jso"],
    "the tail's keys or their order changed; docs/JOINING_RUNS.md 11.2 names these six");
});

test("APPEND-ONLY TEETH: a reordered base argument, a replaced fp and an inverted gate all fail", () => {
  const sql = stripSql(read(A56));

  const swapped = mutate(sql, "r.manual_linear_feet, r.manual_corner_count, r.is_teardown, ppf",
    "r.manual_corner_count, r.manual_linear_feet, r.is_teardown, ppf");
  const swappedArgs = fnBody(swapped, "reapp_row_takeoff")
    .match(/public\.reapp_run_takeoff\s*\(([\s\S]*?)\)\s*as\s+fp/i)[1]
    .split(",").map((s) => s.trim());
  assert.notDeepEqual(swappedArgs, BASE_ARGS, "a reordered base argument went unnoticed");

  const inverted = mutate(sql, "             then ''\n", "             then '|sj=INVERTED'\n");
  const invBody = fnBody(inverted, "reapp_row_takeoff");
  const invShape = invBody.match(/select\s+fp\s*\|\|\s*case([\s\S]*?)end\s+from\s+base/i);
  assert.ok(invShape, "the inverted copy still parses, as it must for this to be a fair test");
  assert.equal(invShape[1].search(/\bthen\s*''/), -1,
    "an inverted gate -- a tail on every run, including the unjoined ones -- went unnoticed");

  const droppedKey = mutate(sql, "|| '|jph=' ||", "|| '|nope=' ||");
  const droppedKeys = [...fnBody(droppedKey, "reapp_row_takeoff")
    .matchAll(/'\|(sj|ej|jf|jph|jfh|jso)='/g)].map((m) => m[1]);
  assert.notDeepEqual(droppedKeys, ["sj", "ej", "jf", "jph", "jfh", "jso"],
    "a height dropped out of the tail went unnoticed -- which member owns the shared post is a price");
});

// ---------------------------------------------------------------- 5. the gate

/**
 * The four disqualifiers. Each one is a condition under which a joint does NOT take effect
 * (docs/JOINING_RUNS.md 1.4, guards G4/G5/G6), so each one must leave the fingerprint alone.
 */
const GATE = [
  ["no joint id at either end", /\(\s*sj\s*=\s*''\s+and\s+ej\s*=\s*''\s*\)/],
  ["a teardown run bills no materials", /coalesce\s*\(\s*r\.is_teardown\s*,\s*false\s*\)/],
  ["a closed run has no ends", /coalesce\s*\(\s*r\.closed_loop\s*,\s*false\s*\)/],
  ["an empty run prices no footage", /public\.reapp_is_empty\s*\(\s*fp\s*\)/],
];

test("THE GATE: all four disqualifiers are in it", () => {
  const body = fnBody(stripSql(read(A56)), "reapp_row_takeoff");
  const gate = body.match(/case\s*\n?\s*when([\s\S]*?)\bthen\s*''/i);
  assert.ok(gate, "the gate could not be found");
  for (const [why, re] of GATE) {
    assert.match(gate[1], re, "the gate no longer covers: " + why);
  }
  // Joined to the gate by OR, not AND: any one of them is enough to leave the fingerprint alone.
  assert.equal((gate[1].match(/\bor\b/g) || []).length, 3,
    "the four clauses must be joined by three ORs; an AND would mean only a run that is ALL FOUR " +
    "gets no tail, which is every run except the ones that matter");
});

test("THE GATE: the empty-run literal the trigger compares against is not touched", () => {
  const sql = read(A56);
  assert.match(sql, /b=0\.0\|t=0\.0\|c=0\|e=0\|g=0\|gf=0\.0\|gm=/,
    "the exact literal reapp_is_empty compares against must be written down here, because " +
    "appending to an empty run's fingerprint would break that comparison for ever");
  // ... and reapp_is_empty itself must not be redefined (also checked in section 3).
  assert.doesNotMatch(stripSql(sql), /create\s+or\s+replace\s+function\s+public\.reapp_is_empty/i);
});

test("THE GATE: a joint id is normalised to the uuid shape, exactly as the readers do", () => {
  const body = fnBody(stripSql(read(A56)), "reapp_row_takeoff");
  const shape = /\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$/g;
  const hits = body.match(shape) || [];
  assert.equal(hits.length, 2,
    "both start_joint and end_joint must be uuid-checked; junk must read as not-joined in the " +
    "fingerprint exactly as it does in the price, or the two disagree about what the price is");
  assert.match(body, /r\.start_joint/);
  assert.match(body, /r\.end_joint/);
});

test("THE GATE TEETH: removing any one disqualifier is caught", () => {
  const sql = stripSql(read(A56));
  const removals = [
    ["(sj = '' and ej = '')\n               or ", ""],
    ["or coalesce(r.is_teardown, false)\n               ", ""],
    ["or coalesce(r.closed_loop, false)\n               ", ""],
    ["or public.reapp_is_empty(fp)\n             ", ""],
  ];
  assert.equal(removals.length, GATE.length, "one removal per disqualifier");
  removals.forEach(([needle, replacement], i) => {
    const broken = mutate(sql, needle, replacement);
    const gate = fnBody(broken, "reapp_row_takeoff").match(/case\s*\n?\s*when([\s\S]*?)\bthen\s*''/i);
    assert.ok(gate, "the mutated copy must still have a gate for this to be a fair test");
    const [why, re] = GATE[i];
    assert.doesNotMatch(gate[1], re, "removing the clause for '" + why + "' went unnoticed");
  });
});

test("THE GATE TEETH: swapping an OR for an AND is caught", () => {
  const sql = stripSql(read(A56));
  const broken = mutate(sql, "or coalesce(r.closed_loop, false)", "and coalesce(r.closed_loop, false)");
  const gate = fnBody(broken, "reapp_row_takeoff").match(/case\s*\n?\s*when([\s\S]*?)\bthen\s*''/i);
  assert.notEqual((gate[1].match(/\bor\b/g) || []).length, 3, "an AND in the gate went unnoticed");
});

// ---------------------------------------------------------------- 6. PART B order

const PART_B_MARKER = "DO NOT APPLY PART B UNTIL BOTH READERS ACCEPT A SEVEN-PART SNAPSHOT";

/** The snapshot part counts a reader accepts, read from its own refusal line. */
function acceptedCounts(text, guardRe) {
  const m = text.match(guardRe);
  assert.ok(m, "the snapshot reader's length guard could not be found -- it may have been rewritten");
  return new Set([...m[0].matchAll(/!==?\s*(\d+)/g)].map((x) => Number(x[1])));
}

const PHONE_GUARD = /if\s*\(parts\.size\s*!=\s*\d+(?:\s*&&\s*parts\.size\s*!=\s*\d+)*\)/;
const OFFICE_GUARD = /if\s*\(parts\.length\s*!==\s*\d+(?:\s*&&\s*parts\.length\s*!==\s*\d+)*\)/;

test("PART B ORDER: both snapshot readers are found, and today both refuse a seven-part snapshot", () => {
  const phone = acceptedCounts(read(PHONE), PHONE_GUARD);
  const office = acceptedCounts(read(OFFICE), OFFICE_GUARD);
  // Positive control: each reader must accept SOMETHING, or "does not accept 7" is a true about
  // a guard that was never located.
  assert.ok(phone.has(3) && phone.has(6), "phone reader: expected 3 and 6, got " + [...phone]);
  assert.ok(office.has(3) && office.has(6), "office reader: expected 3 and 6, got " + [...office]);
});

test("PART B ORDER: the do-not-apply marker is present exactly while a reader still refuses seven", () => {
  const sql = read(A56);
  const writerCanEmitSeven = /'\|sj='\s*\|\|\s*sj\s*\|\|\s*';ej='\s*\|\|\s*ej/.test(sql);
  assert.equal(writerCanEmitSeven, true,
    "PART B no longer emits a seventh part; if that is deliberate, this test and " +
    "docs/JOINING_RUNS.md 11.3 both need rewriting");

  const bothAcceptSeven =
    acceptedCounts(read(PHONE), PHONE_GUARD).has(7) &&
    acceptedCounts(read(OFFICE), OFFICE_GUARD).has(7);
  const marked = sql.includes(PART_B_MARKER);

  if (!bothAcceptSeven) {
    assert.equal(marked, true,
      "a reader still refuses a seven-part snapshot, so PART B must carry the do-not-apply " +
      "marker. Applying it first makes every joined run's snapshot unreadable on both sides " +
      "and kills the restore button on exactly the rows that need it.");
  } else {
    assert.equal(marked, false,
      "both readers now accept seven parts, so the do-not-apply marker is stale. Remove it, or " +
      "it becomes a warning nobody believes.");
  }
});

test("PART B ORDER TEETH: held from both sides", () => {
  const sql = read(A56);
  const phone = read(PHONE);
  const office = read(OFFICE);

  // Side one: the marker removed while the readers still refuse seven.
  const unmarked = mutate(sql, PART_B_MARKER, "nothing to see here");
  assert.equal(unmarked.includes(PART_B_MARKER), false);
  assert.equal(
    acceptedCounts(phone, PHONE_GUARD).has(7) && acceptedCounts(office, OFFICE_GUARD).has(7),
    false,
    "positive control: the readers must still refuse seven for this half of the test to mean anything",
  );

  // Side two: both readers widened to seven while the marker is still there.
  const phone7 = mutate(phone, "if (parts.size != 3 && parts.size != 6)",
    "if (parts.size != 3 && parts.size != 6 && parts.size != 7)");
  const office7 = mutate(office, "if (parts.length !== 3 && parts.length !== 6)",
    "if (parts.length !== 3 && parts.length !== 6 && parts.length !== 7)");
  assert.equal(acceptedCounts(phone7, PHONE_GUARD).has(7), true);
  assert.equal(acceptedCounts(office7, OFFICE_GUARD).has(7), true);
  assert.equal(sql.includes(PART_B_MARKER), true,
    "with both readers widened, the live file's marker is what the check would now demand be removed");
});

test("PART B: the snapshot's seventh part is gated on there being a joint, so six still means 'no joints'", () => {
  const body = fnBody(stripSql(read(A56)), "reapp_run_snapshot");
  // The six existing parts, unchanged and in order.
  const sixParts = [
    "r.points_encoded", "r.gates_encoded", "r.closed_loop",
    "r.manual_linear_feet", "r.manual_corner_count", "r.is_teardown",
  ];
  let at = -1;
  for (const part of sixParts) {
    const next = body.indexOf(part, at + 1);
    assert.ok(next > at, "the six existing snapshot parts changed or were reordered at: " + part);
    at = next;
  }
  // The seventh is conditional, and both keys are always written when it exists.
  assert.match(body, /case\s+when\s+sj\s*<>\s*''\s+or\s+ej\s*<>\s*''/i,
    "the seventh part is not gated on a joint existing. Six parts must keep meaning 'both joints " +
    "were empty', which is what lets a restore CLEAR a join");
  assert.match(body, /'\|sj='\s*\|\|\s*sj\s*\|\|\s*';ej='\s*\|\|\s*ej/,
    "both keys must always be written when the seventh part exists");
});

test("PART B: the snapshot normalises a joint id exactly as the fingerprint does", () => {
  const body = fnBody(stripSql(read(A56)), "reapp_run_snapshot");
  const shape = /\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$/g;
  assert.equal((body.match(shape) || []).length, 2,
    "the snapshot must uuid-check both joint columns. Writing junk through verbatim produces a " +
    "seventh part the reader contract has to refuse, which leaves that run's withdrawal " +
    "permanently unrestorable over a value the price already ignores");
});

test("PART B TEETH: an ungated seventh part, and a writer that skips normalising, are both caught", () => {
  const sql = stripSql(read(A56));

  const ungated = mutate(sql, "|| case when sj <> '' or ej <> ''", "|| case when true or ej <> ''");
  assert.doesNotMatch(fnBody(ungated, "reapp_run_snapshot"), /case\s+when\s+sj\s*<>\s*''\s+or\s+ej\s*<>\s*''/i,
    "a seventh part written for EVERY run -- which would make every snapshot unreadable on both " +
    "readers -- went unnoticed");

  const raw = mutate(sql,
    "            case when r.end_joint   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'\n" +
    "                 then r.end_joint   else '' end as ej\n    )\n    select coalesce(r.points_encoded, '')",
    "            r.end_joint as ej\n    )\n    select coalesce(r.points_encoded, '')");
  const shape = /\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$/g;
  assert.notEqual((fnBody(raw, "reapp_run_snapshot").match(shape) || []).length, 2,
    "a joint column written through without the uuid check went unnoticed");
});

// ---------------------------------------------------------------- 7. no backfill

test("NO BACKFILL: neither .sql joins a run he did not join", () => {
  for (const rel of [A32, A56]) {
    const sql = stripSql(read(rel));
    assert.doesNotMatch(sql, /\bupdate\s+(public\.)?fence_runs\b/i, rel + " updates fence_runs");
    assert.doesNotMatch(sql, /\binsert\s+into\s+(public\.)?fence_runs\b/i, rel + " inserts into fence_runs");
    assert.doesNotMatch(sql, /set\s+start_joint\s*=/i, rel + " assigns start_joint");
    assert.doesNotMatch(sql, /set\s+end_joint\s*=/i, rel + " assigns end_joint");
  }
});

test("NO BACKFILL: both files prove afterwards that no run is joined", () => {
  for (const rel of [A32, A56]) {
    assert.match(read(rel), /start_joint\s*=\s*''\s+and\s+end_joint\s*=\s*''/,
      rel + " has no proof row asserting that no run came out of it joined");
  }
});

test("NO BACKFILL TEETH: a planted backfill is caught", () => {
  const planted = stripSql(
    "-- no backfill, honest\nupdate public.fence_runs set start_joint = gen_random_uuid()::text where true;\n");
  assert.match(planted, /\bupdate\s+(public\.)?fence_runs\b/i);
  assert.match(planted, /set\s+start_joint\s*=/i);
});

// ---------------------------------------------------------------- 8. the docs agree

test("THE DOCS AGREE: the decision and its files are recorded in docs/JOINING_RUNS.md", () => {
  const doc = read(DOC);
  assert.match(doc, /## 11\. The decision/, "section 11 is missing from the design document");
  assert.match(doc, new RegExp(A56.replace(/[.]/g, "\\.")), "the new .sql is not named in the doc");
  assert.match(doc, /columns on `fence_runs`\. The `run_joins` table is retired/,
    "the storage decision is not stated in 11.1");
  assert.match(doc, /SchemaV50/, "11.1 does not say that retiring run_joins needs a Room migration");
});

test("THE DOCS AGREE: sort_order becoming material for a joined run is written down against the rule that calls it immaterial", () => {
  // docs/REAPPROVAL_RULE.md lists sort_order among the things that never disturb an approval.
  assert.match(read(RULE), /`sort_order`/,
    "positive control: REAPPROVAL_RULE.md no longer mentions sort_order, so this check compares " +
    "the new file against nothing");
  const sqlHasIt = /\|jso='\s*\|\|\s*coalesce\(r\.sort_order/.test(read(A56));
  if (sqlHasIt) {
    assert.match(read(DOC), /explicitly not material/,
      "the fingerprint makes sort_order material for a joined run while REAPPROVAL_RULE.md says " +
      "it never disturbs an approval. One of them is wrong unless the exception is written down " +
      "-- docs/JOINING_RUNS.md 11.2 is where it belongs");
    assert.match(read(DOC), /reordering the run list withdraws the approval/i,
      "the cost of that exception -- what he will actually see -- is not stated");
  }
});

test("THE DOCS AGREE TEETH: the sort_order exception check fails when the doc stops saying it", () => {
  const doc = mutate(read(DOC), "explicitly not material", "quite ordinary, really");
  assert.doesNotMatch(doc, /explicitly not material/);
});

test("THE DOCS AGREE: the stale 6-part proof in the drawing-versions file is flagged where somebody will see it", () => {
  const sql = read(A56);
  assert.match(sql, /supabase_r8_drawing_versions_full_snapshot\.sql/,
    "the new file does not name the already-applied proof row that its PART B turns into a check " +
    "that can only fail");
  assert.match(read(DOC), /supabase_r8_drawing_versions_full_snapshot\.sql/);
});
