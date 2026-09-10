#!/usr/bin/env node
/**
 * Is anything wrong right now, across the whole system, in one command.
 *
 * Nothing today watches on its own. tests/health-check.mjs, the
 * live-rules-guard, and the money-report-guard each answer one slice of
 * "is this broken" -- but only when a person remembers to run them. This
 * script is the thing that would have caught today's real failures without
 * anyone going looking first:
 *
 *   - a release announced pointing at the previous build
 *       -> tests/health-check.mjs's "update service" check (the release row
 *          resolves to a real, current APK, not just a row that exists)
 *   - a permission change that would have blanked every salesperson's phone
 *       -> tests/live-rules-guard.test.mjs check 1 (payroll vs. job money)
 *   - a backup missing thirteen tables
 *       -> scripts/verify-backup.mjs, run here against the newest backup folder
 *   - money quietly disagreeing with itself
 *       -> tests/money-report-guard.test.mjs
 *
 * Plus five checks that were genuinely dark before this file existed --
 * nothing on this system watched for them at all (see the comment above each
 * one, and the report from the session that added this script for how each
 * was proven able to fail):
 *
 *   - payments recorded against a job that does not exist
 *   - a company whose subscription lapsed but still has jobs being created
 *   - quotes sent and never opened
 *   - a payment link asking for more than the signed contract
 *   - a shift that clocked in and never clocked out
 *
 * Everything here is read-only. The new DB checks run plain `select`s
 * through the Supabase CLI's own authenticated project link (the same
 * `supabase db query --linked` technique as the other live-* tests) -- never
 * a service_role key, never a write.
 *
 * Usage:
 *   node scripts/whats-wrong.mjs
 *
 * Exit code 0: nothing found wrong. Non-zero: read the lines above it. Wire
 * this to anything -- a scheduled task, a cron job, a pre-flight check --
 * that can act on a plain exit code; it takes no arguments and asks nothing
 * of the environment beyond what the CLI already needs.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const PROJECT = "newcrgafcptspmapacrx";
const REPO_ROOT = resolve(import.meta.dirname, "..");
// backup-db.mjs's own usage comment says "D:/FenceFlowBackups", but this
// machine has no D: drive -- the folders actually land in the user profile.
// Checked both so this does not silently skip the backup section on a
// machine that still has the drive the docs describe.
const BACKUP_ROOTS = ["D:/FenceFlowBackups", "C:/Users/march/FenceFlowBackups"];

let bad = 0;
const sections = [];

function runNode(label, meaning, relPath) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [join(REPO_ROOT, relPath)], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: 240_000,
  });
  const ms = Date.now() - started;
  const ok = r.status === 0 && !r.error;
  if (!ok) bad++;
  sections.push({
    ok, label, ms,
    meaning: ok ? null : meaning,
    detail: ok
      ? "healthy"
      : (r.error ? r.error.message : `exit ${r.status}`) +
        "\n" + tailLines((r.stdout || "") + (r.stderr || ""), 15),
  });
}

function tailLines(text, n) {
  const lines = text.split("\n").filter((l) => l.trim());
  return lines.slice(-n).map((l) => "        " + l).join("\n");
}

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "whats-wrong-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query",
    "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
    { encoding: "utf8", shell: process.platform === "win32", timeout: 180_000 });
  if (r.status !== 0) {
    throw new Error(`supabase db query failed: ${(r.stderr || r.stdout || "").slice(0, 400)}`);
  }
  const start = r.stdout.indexOf("{");
  if (start < 0) throw new Error(`no JSON in CLI output: ${r.stdout.slice(0, 200)}`);
  const parsed = JSON.parse(r.stdout.slice(start));
  return Array.isArray(parsed) ? parsed : (parsed.rows || []);
}

/** A new, previously-dark DB check. `probeSql` must return one row with
 *  column `n` (a count). `canarySql`, if given, is a synthetic, no-table-
 *  written query that proves the SAME logic can find a bad row -- required
 *  whenever the live probe currently finds nothing, so a check that is
 *  quietly vacuous cannot pass as "healthy". */
function darkCheck(label, meaning, probeSql, canarySql) {
  const started = Date.now();
  try {
    const rows = runSql(probeSql);
    const n = Number(rows[0]?.n ?? -1);
    if (n < 0) throw new Error("query returned no count");
    if (canarySql) {
      const canaryRows = runSql(canarySql);
      const cn = Number(canaryRows[0]?.n ?? -1);
      if (cn <= 0) {
        bad++;
        sections.push({
          ok: false, label, ms: Date.now() - started,
          meaning: `this check's own canary found nothing -- the check cannot be trusted, not "healthy"`,
          detail: `live count ${n}, but the synthetic canary that must always find a planted bad row found ${cn}`,
        });
        return;
      }
    }
    if (n > 0) {
      bad++;
      sections.push({ ok: false, label, ms: Date.now() - started, meaning, detail: `${n} found` });
    } else {
      sections.push({ ok: true, label, ms: Date.now() - started, detail: canarySql ? "0 live (canary proven able to fail)" : "0 live" });
    }
  } catch (e) {
    bad++;
    sections.push({ ok: false, label, ms: Date.now() - started, meaning: "could not even ask -- treat as unknown, not healthy", detail: e.message });
  }
}

async function main() {
  // ---- reused, not duplicated ------------------------------------------
  runNode("health-check", "the pages, the update, the quote/lead functions, or mail are down", "tests/health-check.mjs");
  runNode("live-rules-guard", "a live database rule (payroll split, shift ownership, production stage, quote-approval phone gate, or shift disputes) is silently broken", "tests/live-rules-guard.test.mjs");
  runNode("money-report-guard", "ar_aging() or job_costing() is quietly wrong for at least one job", "tests/money-report-guard.test.mjs");
  runNode("golden-path", "the core quote-to-payment flow no longer works end to end against the live function", "tests/golden-path.test.mjs");
  runNode("security-smoke", "an anonymous caller can read or write something they shouldn't", "tests/security-smoke.test.mjs");

  // ---- backup: verify the newest folder actually on disk ----------------
  {
    const started = Date.now();
    try {
      const root = BACKUP_ROOTS.find((r) => existsSync(r));
      if (!root) throw new Error(`no backup root found (tried ${BACKUP_ROOTS.join(", ")})`);
      const folders = readdirSync(root)
        .filter((f) => f.startsWith("fenceflow-"))
        .map((f) => join(root, f))
        .filter((p) => statSync(p).isDirectory())
        .sort();
      const newest = folders[folders.length - 1];
      if (!newest) throw new Error(`no fenceflow-* backup folder in ${root}`);
      const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "verify-backup.mjs"), newest], {
        cwd: REPO_ROOT, encoding: "utf8", timeout: 240_000,
      });
      const ok = r.status === 0 && !r.error;
      if (!ok) bad++;
      sections.push({
        ok, label: "backup (newest folder verified against live tables)", ms: Date.now() - started,
        meaning: ok ? null : "the newest backup is missing tables, short, or unreadable",
        detail: ok ? newest : (r.error ? r.error.message : `exit ${r.status}`) + "\n" + tailLines((r.stdout || "") + (r.stderr || ""), 15),
      });
    } catch (e) {
      bad++;
      sections.push({ ok: false, label: "backup (newest folder verified against live tables)", ms: Date.now() - started, meaning: "could not find or check a backup at all", detail: e.message });
    }
  }

  // ---- previously dark, now watched --------------------------------------

  // 1. Payments recorded against no job. job_payments/payment_records are
  // written independently of the job row; nothing enforces the foreign key
  // at the database level, and nothing ever asked whether it held.
  darkCheck(
    "payments with no matching job",
    "money is recorded that cannot be attributed to any job -- it will not show up in that job's history, in ar_aging(), or in job_costing(), because there is no job to attach it to",
    `select count(*) as n from payment_records p
     where p.deleted_at is null
       and not exists (select 1 from jobs j where j.sync_id = p.job_sync_id);`,
    null // no canary needed -- see report: this already finds real rows on live data
  );

  // 2. A company whose subscription lapsed but still has jobs being created.
  // The access gate (supabase_access_gate_patch.sql) is enforced on sign-in
  // and page load; a job created through some other path (import, a stale
  // session, a service credential) would not trip it, and nothing counts
  // this after the fact.
  darkCheck(
    "lapsed subscription still creating jobs",
    "a company whose access should be blocked is still producing live jobs -- either the gate has a hole or someone is using this company's data without a subscription behind it",
    `select count(*) as n from companies c
     where c.subscription_status in ('canceled','past_due')
       and exists (select 1 from jobs j where j.company_id = c.id and j.created_at > now() - interval '7 days');`,
    `with fake_companies(id, subscription_status) as (
       values ('11111111-1111-4111-8111-000000000001'::uuid, 'canceled')
     ),
     fake_jobs(company_id, created_at) as (
       values ('11111111-1111-4111-8111-000000000001'::uuid, now())
     )
     select count(*) as n from fake_companies c
     where c.subscription_status in ('canceled','past_due')
       and exists (select 1 from fake_jobs j where j.company_id = c.id and j.created_at > now() - interval '7 days');`
  );

  // 3. Quotes sent and never opened. quote_sent_at / quote_viewed_at are
  // stamped by the app and the quote-view function respectively; nobody
  // ever compares them. A customer who never got the text, a link that
  // 404s, or a quote nobody follows up on all look identical to "fine" --
  // silence reads as good news.
  darkCheck(
    "quotes sent 7+ days ago, never opened",
    "customers are sitting on quote links that were never opened -- could be a dead link, a bounced text, or a lead nobody followed up on, and there is no other place this would surface",
    `select count(*) as n from jobs
     where deleted_at is null and quote_sent_at is not null
       and quote_sent_at < now() - interval '7 days' and quote_viewed_at is null;`,
    null // already finds real rows on live data -- see report
  );

  // 4. A payment link asking for more than the signed contract. The link
  // amount is set by whoever generates it; nothing checks it against the
  // number the customer actually signed for.
  darkCheck(
    "payment link amount exceeds the signed contract total",
    "a customer could be asked to pay more than they agreed to -- an overcharge that would not be caught by anything else, since the link and the contract total are set independently",
    `select count(*) as n from jobs
     where deleted_at is null and payment_link_amount is not null and contract_total is not null
       and payment_link_amount > contract_total + 0.005;`,
    `with fake_jobs(contract_total, payment_link_amount) as (
       values (500.00::numeric, 750.00::numeric)
     )
     select count(*) as n from fake_jobs
     where payment_link_amount > contract_total + 0.005;`
  );

  // 5. A shift that clocked in and never clocked out. Crew pay is computed
  // from started_at/ended_at; a shift stuck open for days either pays
  // nothing (excluded from totals) or pays for a shift that never ended,
  // and nothing currently flags either.
  darkCheck(
    "shifts open more than 24 hours",
    "a crew member's time is either missing from payroll entirely (an open shift with no end) or about to be paid for a shift that ran all night by accident -- either way nobody would know until pay day",
    `select count(*) as n from time_entries
     where deleted_at is null and ended_at is null and started_at < now() - interval '24 hours';`,
    `with fake_shifts(started_at, ended_at) as (
       values (now() - interval '30 hours', null::timestamptz)
     )
     select count(*) as n from fake_shifts where ended_at is null and started_at < now() - interval '24 hours';`
  );

  // ------------------------------------------------------------- report ---
  console.log("");
  for (const s of sections) {
    console.log(s.ok
      ? `  ok    ${s.label.padEnd(46)} ${String(s.ms).padStart(6)}ms  ${s.detail}`
      : `  WRONG ${s.label.padEnd(46)} ${String(s.ms).padStart(6)}ms\n        → ${s.meaning}\n${s.detail}`);
  }
  console.log(bad ? `\n${bad} of ${sections.length} sections found something wrong` : `\nall ${sections.length} sections clean`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error("whats-wrong could not run at all:", e.message); process.exit(2); });
