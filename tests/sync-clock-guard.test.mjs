// §37: last-edit-wins is decided by jobs.updated_at, moved only by
// touch_updated_at() (supabase_quiet_touch_patch.sql), which is supposed to
// treat bookkeeping writes as quiet -- see that file's own doc for the bug
// class ("The address a customer had corrected in the yard reverted to the
// wrong one, and nothing said so.").
//
// This checks whether the quiet list is actually complete. It is not: the
// dispute columns added by supabase_disputes.sql (dispute_opened_at,
// dispute_closed_at, dispute_status, dispute_reason, dispute_amount) are
// written by both supabase/functions/stripe-webhook/index.ts and
// square-webhook/index.ts -- a background write with nobody at the keyboard,
// exactly the class of write the quiet list exists to hide from the clock --
// and none of the five names appear in the `quiet` array in
// supabase_quiet_touch_patch.sql. So a chargeback landing on a job a crew
// phone edited offline can make the cloud row look newer and win the race,
// silently discarding the crew's edit -- the same bug the quiet-list patch
// was written to fix, just via a door the patch didn't cover.
//
// Runs the same way tests/live-rules-guard.test.mjs does: read-only CLI
// session (`supabase db query --linked`), everything inside begin/rollback,
// nothing survives. Uses the same real DRAFT job that file already uses
// (93427b69-9552-4114-b25a-8e607adce480, belongs to the real company
// aba5b097-afc4-48dd-9851-b50200d5e8f4), so this adds no new fixture.
//
//   node tests/sync-clock-guard.test.mjs

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT = "newcrgafcptspmapacrx";
const DRAFT_JOB = "93427b69-9552-4114-b25a-8e607adce480"; // status DRAFT, from live-rules-guard.test.mjs

let failed = 0, checked = 0;
const ok = (name, cond, detail = "") => {
  checked++;
  if (cond) { console.log(`  ok    ${name}`); return; }
  failed++;
  console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
};

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "sync-clock-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query",
    "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
    { encoding: "utf8", shell: process.platform === "win32", timeout: 180_000 });
  if (r.status !== 0) {
    throw new Error(`supabase db query failed: ${r.stderr || r.stdout}`);
  }
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { throw new Error(`could not parse CLI output: ${r.stdout}`); }
  return Array.isArray(parsed) ? parsed : (parsed.rows || []);
}

async function main() {
  console.log("\n1. Canary -- prove this check can actually tell quiet from loud:");
  console.log("   (plants nothing in the trigger itself; exercises the REAL trigger against");
  console.log("    one column already known quiet, and one column already known loud)");

  // Each case runs in its OWN begin/rollback. now() is the TRANSACTION
  // timestamp (frozen for the whole transaction, not the statement) -- see
  // live-rules-guard.test.mjs's DRAFT_JOB_2 comment for the exact trap this
  // avoids: chaining three updates to the same row inside one transaction
  // makes the second and third writes stamp the SAME frozen now() the first
  // write already stamped, so before/after look identical even when the
  // trigger genuinely re-fired -- a false "quiet" reading that isn't real.
  // Separate transactions get separate, independently-evaluated now()s.
  const oneCase = (label, setClause) => runSql(`
begin;
create temp table probe(before_ts timestamptz, after_ts timestamptz) on commit drop;
insert into probe select updated_at, null from jobs where sync_id::text = '${DRAFT_JOB}';
update jobs set ${setClause} where sync_id::text = '${DRAFT_JOB}';
update probe set after_ts = (select updated_at from jobs where sync_id::text = '${DRAFT_JOB}');
select * from probe;
rollback;
`)[0] || {};

  const rows = {
    "quiet: amount_paid": oneCase("quiet", "amount_paid = coalesce(amount_paid, 0) + 1"),
    "loud: notes": oneCase("loud", "notes = coalesce(notes, '') || ' '"),
    "undeclared: dispute_status": oneCase("undeclared",
      "dispute_status = 'chargeback_probe', dispute_reason = 'sync-clock-guard test'"),
  };
  const row = (name) => rows[name] || {};
  const moved = (name) => {
    const r = row(name);
    return r.before_ts && r.after_ts && r.before_ts !== r.after_ts;
  };

  ok("CANARY passes: a known-quiet bookkeeping column (amount_paid) does NOT move updated_at",
     !moved("quiet: amount_paid"), `${JSON.stringify(row("quiet: amount_paid"))}`);
  ok("CANARY passes: a real, human-editable column (notes) DOES move updated_at",
     moved("loud: notes"), `${JSON.stringify(row("loud: notes"))}`);

  console.log("\n2. The real question -- dispute_status/dispute_reason, written only by the");
  console.log("   Stripe/Square webhooks (bookkeeping, nobody at the keyboard), are absent");
  console.log("   from touch_updated_at()'s quiet array in supabase_quiet_touch_patch.sql:");
  ok("dispute_status/dispute_reason do NOT move updated_at (webhook write should be quiet)",
     !moved("undeclared: dispute_status"),
     `updated_at moved from ${row("undeclared: dispute_status").before_ts} to ` +
     `${row("undeclared: dispute_status").after_ts} -- a chargeback landing after an offline crew ` +
     `edit will beat that edit and silently discard it, the exact bug ` +
     `supabase_quiet_touch_patch.sql was written to fix, via a door it didn't cover`);

  console.log(`\n${checked - failed} of ${checked} checks passed`);
  if (failed) process.exit(1);
}

main().catch(e => { console.error("could not run:", e.message); process.exit(2); });
