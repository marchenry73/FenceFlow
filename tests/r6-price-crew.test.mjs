// Proves supabase_r6_price_stability.sql and supabase_r6_crew_writes.sql
// before they are ever applied.
//
//   A. STATIC, pure (always runs): reads the two migrations and checks the
//      promises easiest to break in a later edit -- no row is deleted or
//      rewritten, nothing is dropped but the two triggers named in the files,
//      the doors crew call stay closed to anonymous callers, and the crew
//      allowlist is the app's CREW_WRITABLE_JOB_KEYS (cloud/SyncScope.kt)
//      letter for letter. Each checker is proven by a planted bad copy that
//      it must catch.
//
//   B. LIVE, rolled back (only with R6_LIVE=1): `begin;` + both migrations +
//      supabase_r6_price_crew_probe.sql against production through
//      `supabase db query --linked`, the technique of
//      tests/crew-job-scope.test.mjs. Every subject and row in the probe is
//      synthetic and the transaction is rolled back. Then again with the
//      migrations applied TWICE (they must be idempotent), then once per
//      sabotage -- each undoing one piece after the migrations run -- and the
//      checks guarding exactly that piece must go red. A probe that stays
//      green under sabotage proves nothing.
//
//   node --test tests/r6-price-crew.test.mjs                 (A only)
//   R6_LIVE=1 node --test tests/r6-price-crew.test.mjs       (A and B, ~10 min)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT = "newcrgafcptspmapacrx";
const ROOT = process.cwd();
const read = (f) => readFileSync(join(ROOT, f), "utf8");
const price = read("supabase_r6_price_stability.sql");
const crew = read("supabase_r6_crew_writes.sql");
const probe = read("supabase_r6_price_crew_probe.sql");
const syncScope = read("app/src/main/java/com/fenceestimator/app/cloud/SyncScope.kt");

// ================================================================ A ======

/** The file with every `--` comment removed, so prose cannot satisfy a check. */
const code = (sql) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

/**
 * The bodies of the functions a migration defines ($function$ ... $function$).
 * They run when their trigger fires, not when the migration is applied, so
 * [destructive] reads around them and [functionWrites] reads inside them.
 */
export function functionBodies(sql) {
  return [...code(sql).matchAll(/\$function\$([\s\S]*?)\$function\$/g)].map((m) => m[1]);
}

/** Everything in a migration that deletes, rewrites or drops, as sentences. */
export function destructive(sql) {
  const src = code(sql).replace(/\$function\$[\s\S]*?\$function\$/g, "");
  const problems = [];
  if (/\bdelete\s+from\b/i.test(src)) problems.push("deletes rows");
  if (/\btruncate\b/i.test(src)) problems.push("truncates");
  if (/\bupdate\s+(public\.)?\w+\s+set\b/i.test(src)) problems.push("rewrites rows");
  if (/\binsert\s+into\b/i.test(src)) problems.push("inserts rows");
  if (/\balter\s+table\b[^;]*\b(drop|alter\s+column|rename)\b/i.test(src)) problems.push("drops or alters a column");
  for (const m of src.matchAll(/\bdrop\s+(\w+)(\s+if\s+exists)?\s+("?[\w]+"?)/gi)) {
    const what = `${m[1].toLowerCase()} ${m[3].replace(/"/g, "")}`;
    // The only drops: re-creating this file's own triggers, and removing a
    // duplicate identity trigger a re-run of an older file put back.
    if ([
      "trigger 12_stamp_accepted_total", "trigger protect_customer_identity",
      "trigger 00_latch_change_order_acceptance", "trigger 90_mark_change_orders_accepted",
      "trigger 00_hold_line_item_takeoff_identity",
    ].includes(what)) continue;
    problems.push(`drops ${what}`);
  }
  return problems;
}

/**
 * Every row-changing statement inside a function body, as sentences. The only
 * one allowed is marking change orders as inside an accepted price, which
 * only ever sets a false flag true.
 */
export function functionWrites(sql) {
  const problems = [];
  for (const body of functionBodies(sql)) {
    if (/\bdelete\s+from\b/i.test(body)) problems.push("a function deletes rows");
    if (/\binsert\s+into\b/i.test(body)) problems.push("a function inserts rows");
    for (const m of body.matchAll(/\bupdate\s+([\w.]+)(?:\s+\w+)?\s+set\s+([^;]*)/gi)) {
      const ok = m[1] === "public.change_orders" && /^in_accepted_total\s*=\s*true\b/i.test(m[2].trim())
        && /and\s+not\s+co\.in_accepted_total/i.test(m[2]);
      if (!ok) problems.push(`a function updates ${m[1]}: ${m[2].trim().slice(0, 60)}`);
    }
  }
  return problems;
}

/** The quoted names in crew_writable_job_columns()' array literal. */
export function sqlAllowlist(sql) {
  const at = code(sql).search(/create\s+or\s+replace\s+function\s+public\.crew_writable_job_columns\s*\(/i);
  assert.ok(at >= 0, "no definition of crew_writable_job_columns()");
  const body = code(sql).slice(at);
  const open = body.indexOf("array[");
  return new Set([...body.slice(open, body.indexOf("]", open)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
}

/** The string members of `val CREW_WRITABLE_JOB_KEYS: Set<String> = setOf(...)`. */
export function kotlinAllowlist(kt) {
  const m = kt.match(/val\s+CREW_WRITABLE_JOB_KEYS\s*:\s*Set<String>\s*=\s*setOf\(([\s\S]*?)\)/);
  assert.ok(m, "no CREW_WRITABLE_JOB_KEYS in SyncScope.kt");
  return new Set([...m[1].replace(/\/\/.*$/gm, "").matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));
}

test("neither migration deletes, rewrites or drops anything but its named triggers", () => {
  assert.deepEqual(destructive(price), []);
  assert.deepEqual(destructive(crew), []);
});

test("the only write inside a function marks change orders, false to true", () => {
  assert.deepEqual(functionWrites(price), []);
  assert.deepEqual(functionWrites(crew), []);
  assert.equal(functionBodies(price).filter((b) => /update\s+public\.change_orders/i.test(b)).length, 1);
});

test("planted: the function-write checker catches a rewrite, an unmark and a delete", () => {
  const withBody = (b) => `create function public.x() returns trigger language plpgsql as $function$ begin ${b} return new; end $function$;`;
  assert.ok(functionWrites(withBody("update public.jobs set contract_total = 0;")).length > 0);
  assert.ok(functionWrites(withBody("update public.change_orders co set in_accepted_total = false where true;")).length > 0);
  assert.ok(functionWrites(withBody("delete from public.change_orders;")).length > 0);
  // ...and the real statement passes.
  assert.deepEqual(functionWrites(withBody(
    "update public.change_orders co set in_accepted_total = true where co.job_sync_id = new.sync_id and not co.in_accepted_total;")), []);
});

test("planted: the destructive checker catches a delete, a rewrite and a stray drop", () => {
  assert.ok(destructive(price + "\ndelete from public.jobs where true;").includes("deletes rows"));
  assert.ok(destructive(price + "\nupdate public.jobs set accepted_total = 0;").includes("rewrites rows"));
  assert.ok(destructive(crew + "\ndrop trigger jobs_touch_updated_at on public.jobs;").some((p) => p.startsWith("drops trigger")));
  assert.ok(destructive(crew + "\nalter table public.jobs drop column notes;").length > 0);
  // The commented-out backfill is prose, and stays prose.
  assert.match(price, /^-- update public\.jobs set accepted_total = signed_contract_total/m);
});

test("the crew allowlist is CREW_WRITABLE_JOB_KEYS, letter for letter", () => {
  const sql = sqlAllowlist(crew);
  assert.ok(sql.size >= 5, "parsed nothing -- the parser is broken, not the lists");
  assert.deepEqual([...sql].sort(), [...kotlinAllowlist(syncScope)].sort());
});

test("planted: a one-name difference between the lists shows", () => {
  const drifted = crew.replace(/'locate_notes',\s*/, "");
  assert.notDeepEqual([...sqlAllowlist(drifted)].sort(), [...kotlinAllowlist(syncScope)].sort());
});

test("the allowlist carries no money, identity or office column", () => {
  const forbidden = [
    "customer_name", "address", "phone", "email", "hoa_email", "notes", "referral_source",
    "hoa_name", "hoa_approval_status", "permit_number", "permit_status", "priced_by",
    "pricing_engine_version", "priced_at", "contract_total", "accepted_total", "deposit_amount",
    "scheduled_date", "assigned_employee_sync_id", "deleted_at", "production_stage",
  ];
  const sql = sqlAllowlist(crew);
  for (const c of forbidden) assert.ok(!sql.has(c), `crew may not write ${c}`);
});

test("the scheduler keys are let through only for SCHEDULE_AND_ASSIGN", () => {
  // Duration, date and assignee: a foreman schedules and assigns. The first
  // version let only the duration through, and foremen could no longer
  // reschedule or reassign anywhere.
  assert.match(code(crew),
    /e\.key in \('estimated_duration_hours', 'duration_manually_set',\s*'scheduled_date', 'assigned_employee_sync_id', 'assigned_employee_id'\)\s+and public\.has_permission\('SCHEDULE_AND_ASSIGN'\)/);
});

test("an older signature never re-stamps over a later approval", () => {
  assert.match(code(price), /new\.quote_approved_at is null or new\.signed_at >= new\.quote_approved_at/);
  // Planted: the condition gone, the check sees it.
  assert.doesNotMatch(code(price).replace(/and \(new\.quote_approved_at is null or new\.signed_at >= new\.quote_approved_at\)/, ""),
    /new\.quote_approved_at is null or new\.signed_at >= new\.quote_approved_at/);
});

test("a crew login cannot insert estimate lines straight into the table", () => {
  const src = code(price);
  assert.match(src, /create policy line_items_insert_needs_money_or_edit on public\.estimate_line_items\s+as restrictive for insert/);
  assert.match(src, /with check \(public\.has_permission\('EDIT_JOBS'\) or public\.has_permission\('SEE_MONEY'\)\)/);
  // Never dropped, so there is no moment without it.
  assert.doesNotMatch(src, /drop\s+policy/i);
});

test("a change order's acceptance mark latches and is SEE_MONEY's alone", () => {
  const latch = functionBodies(price).find((b) => /in_accepted_total/.test(b) && /money_caller_trusted/.test(b));
  assert.ok(latch, "no latch function");
  assert.match(latch, /if tg_op = 'UPDATE' and coalesce\(old\.in_accepted_total, false\) then\s+new\.in_accepted_total := true;/);
});

test("the doors crew call, and the new list, stay closed to anonymous callers", () => {
  for (const [file, fn] of [[crew, "crew_writable_job_columns()"], [crew, "crew_save_job(jsonb)"],
                            [price, "crew_push_line_items(jsonb)"]]) {
    const re = new RegExp(`revoke\\s+execute\\s+on\\s+function\\s+public\\.${fn.replace(/[()]/g, "\\$&")}\\s+from\\s+[^;]*\\banon\\b`, "i");
    assert.match(code(file), re, `${fn} is not revoked from anon`);
  }
});

test("the patched functions keep the anchors supabase_crew_job_scope.sql needs", () => {
  // Their text is patched in at apply time, so the static half can only check
  // that neither inserted block repeats the anchor; the live half counts them
  // in the real function bodies (probe checks 80 and 81).
  const blocks = [...code(price).matchAll(/\$rep\$([\s\S]*?)\$rep\$/g), ...code(crew).matchAll(/\$rep\$([\s\S]*?)\$rep\$/g)]
    .map((m) => m[1]);
  assert.equal(blocks.length, 2);
  for (const b of blocks) {
    assert.ok(!/raise exception 'sync_id required'/.test(b));
    assert.ok(!/j\.deleted_at is null\) then/.test(b));
  }
});

// ================================================================ B ======

const LIVE = process.env.R6_LIVE === "1";

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "r6-price-crew-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query",
    "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
    { encoding: "utf8", shell: process.platform === "win32", timeout: 240_000 });
  if (r.status !== 0) throw new Error(`supabase db query failed: ${r.stderr || r.stdout}`);
  const out = r.stdout;
  const parsed = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  return Array.isArray(parsed) ? parsed : (parsed.rows || []);
}

/**
 * begin; migrations; [sabotage]; probe (which rolls everything back). The
 * lock timeout keeps a migration from queueing production traffic behind it
 * if something else holds jobs: it fails in five seconds instead.
 */
function runProbe({ twice = false, sabotage = "" } = {}) {
  const migrations = `${price}\n${crew}\n`;
  const rows = runSql(`begin;\nset local lock_timeout = '5s';\n${migrations}${twice ? migrations : ""}${sabotage}\n${probe}`);
  const failing = rows.filter((r) => r.result === "FAIL").map((r) => r.check_name);
  return { rows, failing, summary: rows.find((r) => r.result === "SUMMARY") };
}

const failed = (res, prefix) => res.failing.some((n) => n.startsWith(prefix));

test("LIVE: both migrations and the probe, as written -- every check passes", { skip: !LIVE }, () => {
  const res = runProbe();
  assert.ok(res.summary, "no SUMMARY row");
  assert.deepEqual(res.failing, [], JSON.stringify(res.rows.filter((r) => r.result === "FAIL"), null, 1));
  assert.ok(res.rows.length > 50, "the probe ran fewer checks than it has");
});

test("LIVE: the migrations are idempotent -- applied twice, every check still passes", { skip: !LIVE }, () => {
  const res = runProbe({ twice: true });
  assert.deepEqual(res.failing, [], JSON.stringify(res.rows.filter((r) => r.result === "FAIL"), null, 1));
});

const SABOTAGE = {
  "the takeoff-line carve-out removed": {
    sql: `create or replace function public.enforce_delete_permission() returns trigger
            language plpgsql security definer set search_path to 'public' as $f$
          begin
            if new.deleted_at is not null and old.deleted_at is null then
              if auth.uid() is not null and not has_permission('DELETE_RECORDS') then
                raise exception 'Deleting needs the delete permission';
              end if;
            end if;
            return new;
          end $f$;`,
    red: ["50 "],
  },
  "the crew line door reopened": {
    sql: `do $s$ declare d text; begin
            d := pg_get_functiondef('public.crew_push_line_items(jsonb)'::regprocedure);
            d := regexp_replace(d, 'if not public\\.has_permission\\(''EDIT_JOBS''\\) then\\s+return 0;\\s+end if;', '');
            execute d; end $s$;`,
    red: ["40 ", "41 ", "42 ", "43 "],
  },
  "the identity hold back after the clock": {
    sql: `alter trigger "00_protect_customer_identity" on public.jobs rename to protect_customer_identity;`,
    red: ["71 ", "75 "],
  },
  "the crew allowlist removed": {
    sql: `do $s$ declare d text; begin
            d := pg_get_functiondef('public.crew_save_job(jsonb)'::regprocedure);
            d := regexp_replace(d, 'if not public\\.has_permission\\(''EDIT_JOBS''\\) then\\s+select coalesce.*?clean := clean - ''status'';\\s+end if;\\s+end if;', '');
            execute d; end $s$;`,
    red: ["61 "],
  },
  "the signature stamp dropped": {
    sql: `drop trigger "12_stamp_accepted_total" on public.jobs;`,
    red: ["15 ", "17 "],
  },
  "accepted_total taken off the money list": {
    sql: `do $s$ begin execute replace(pg_get_functiondef('public.job_money_columns()'::regprocedure),
            '''accepted_total''', '''accepted_total_x'''); end $s$;`,
    red: ["10 ", "23 "],
  },
  "an older signature allowed to re-stamp": {
    sql: `do $s$ begin execute replace(pg_get_functiondef('public.stamp_accepted_total()'::regprocedure),
            'and (new.quote_approved_at is null or new.signed_at >= new.quote_approved_at)', ''); end $s$;`,
    red: ["1c "],
  },
  "the restrictive line insert policy removed": {
    sql: `drop policy line_items_insert_needs_money_or_edit on public.estimate_line_items;`,
    red: ["46 ", "47 "],
  },
  "the two-statement disguise hold removed": {
    sql: `drop trigger "00_hold_line_item_takeoff_identity" on public.estimate_line_items;`,
    red: ["5b ", "5c "],
  },
  "the change-order latch removed": {
    sql: `drop trigger "00_latch_change_order_acceptance" on public.change_orders;`,
    red: ["3f ", "3h "],
  },
  "the change-order marking removed": {
    sql: `drop trigger "90_mark_change_orders_accepted" on public.jobs;`,
    red: ["3a ", "3c "],
  },
  "a foreman's date and assignee dropped again": {
    sql: `do $s$ begin execute regexp_replace(pg_get_functiondef('public.crew_save_job(jsonb)'::regprocedure),
            ',\\s+''scheduled_date'', ''assigned_employee_sync_id'', ''assigned_employee_id''', ''); end $s$;`,
    red: ["6d "],
  },
  "accepted_total taken off the quiet list": {
    sql: `do $s$ begin execute replace(pg_get_functiondef('public.touch_updated_at()'::regprocedure),
            ' ''accepted_total'',', ''); end $s$;`,
    red: ["30 "],
  },
};

for (const [name, { sql, red }] of Object.entries(SABOTAGE)) {
  test(`LIVE sabotage: ${name} -- the checks guarding it go red`, { skip: !LIVE }, () => {
    const res = runProbe({ sabotage: sql });
    assert.ok(res.summary, "no SUMMARY row");
    // The rest of the probe still ran as designed: a sabotage that broke
    // everything would turn the named checks red too, and prove nothing.
    assert.ok(!failed(res, "00 ") && !failed(res, "01 ") && !failed(res, "02 "), "the subjects drifted");
    assert.ok(res.rows.filter((r) => r.result === "PASS").length > 40,
      `only ${res.rows.filter((r) => r.result === "PASS").length} checks passed -- the probe did not run normally`);
    for (const prefix of red) {
      assert.ok(failed(res, prefix), `check ${prefix.trim()} stayed green under "${name}" -- it guards nothing`);
    }
  });
}
