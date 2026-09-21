#!/usr/bin/env node
/**
 * Watch a release after it ships.
 *
 * Phase 1 audit, release §13: `app_errors` is written by the phone
 * (`cloud/CrashReporter.kt`) and read by a human who happens to open
 * `website/admin.html`. No script and no schedule has ever read it. 1.501 is
 * the worked example -- published at 02:24 UTC, five FATAL crashes at 02:35, and
 * 1.502 and 1.503 went out on top of it without a single step in publishing
 * asking how the last one was doing. Nobody was hiding anything; nothing was
 * looking.
 *
 * This is the thing that looks. Give it a version code (or nothing, and it
 * takes the newest release), and it reads app_errors for that build over a
 * window after its release, prints any fatal, and compares the error count
 * against the PREVIOUS release measured over exactly the same number of
 * minutes from its own release. Non-zero exit on a fatal or a clear
 * regression, so a scheduled task, a cron job or a publish script can act on
 * it without parsing anything.
 *
 * Why "the same number of minutes from its own release" and not errors-per-
 * hour: a build that has been out for ninety seconds and one that has been out
 * for a day are not comparable, and dividing by hours pretends they are. Two
 * equal-length windows measured from each build's own release is the closest
 * thing to a fair comparison this data supports. It also means the answer is
 * honest before the window is over -- at minute 12 it compares twelve minutes
 * against twelve minutes -- which is what makes polling worth doing at all
 * rather than sleeping for an hour and asking once.
 *
 * What it deliberately does NOT do:
 *
 *   - normalise by how many phones are out there. `reported_by` is null on
 *     every row in this table today (checked, not assumed: 0 distinct
 *     reporters across all 336 rows), so "errors per device" cannot be
 *     computed, and inventing a denominator would be inventing a number.
 *   - decide anything from a handful of rows. Under MIN_SIGNAL errors in the
 *     window is weather, not a regression, and a checker that cries wolf stops
 *     being read.
 *   - print an email address, a token, or anything else from a crash payload
 *     that could carry one. The `email` column of app_errors is never
 *     selected, and every free-text field that IS printed goes through
 *     redact() first. See --self-test.
 *
 * Usage:
 *   node scripts/post-release-watch.mjs                     # newest release, 60 min, polling
 *   node scripts/post-release-watch.mjs --version-code 501   # a specific build
 *   node scripts/post-release-watch.mjs --minutes 120        # a longer window
 *   node scripts/post-release-watch.mjs --once               # one pass, no polling
 *   node scripts/post-release-watch.mjs --self-test          # prove the logic has teeth
 *
 * Exit 0: nothing wrong. Exit 1: a fatal or a regression. Exit 2: could not
 * run at all (the repo's shared "unknown, not healthy" code -- health-check,
 * live-rules-guard, money-report-guard and whats-wrong all use it).
 *
 * Read-only throughout: plain selects through the Supabase CLI's own
 * authenticated project link, the same technique as whats-wrong.mjs and the
 * live-* tests. Never a service_role key, never a write.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PROJECT = "newcrgafcptspmapacrx";

/** Fewer than this many errors in the window is not evidence of anything.
 *  1.501's real number was 52 in its first hours and 1.502's was 33, so a
 *  floor of five is nowhere near either of the cases this exists to catch --
 *  it only stops a lone crash on a lone phone being announced as a regression
 *  because the previous build happened to have zero. */
export const MIN_SIGNAL = 5;
/** And it has to be clearly worse, not marginally worse. Doubling is the
 *  threshold: 1.501 against 1.499 is 52 against 0, and 1.502 against 1.501 is
 *  33 against 52 -- an improvement, which this must NOT call a regression. */
export const REGRESSION_FACTOR = 2;

// ---------------------------------------------------------------- redaction

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A JWT: three dot-separated base64url chunks whose first one starts `eyJ`,
// which is base64 for the `{"` that opens every JWT header. An access token
// pasted into a crash message by a failing network call is the realistic way
// a secret reaches this table.
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g;
// Supabase's own key shapes, and anything that announces itself as a key.
const KEYISH = /\b(sb_secret_[A-Za-z0-9_-]+|sbp_[A-Za-z0-9]{20,}|service_role[^\s"']*)/g;

/** Everything printed from a crash row goes through this. It is not a
 *  substitute for not selecting the `email` column -- that is done too -- it
 *  is the second lock, for the free-text fields whose contents nobody
 *  controls. */
export function redact(text) {
  if (text == null) return "";
  return String(text)
    .replace(EMAIL, "[email redacted]")
    .replace(JWT, "[token redacted]")
    .replace(KEYISH, "[key redacted]");
}

// ----------------------------------------------------------------- verdict

/**
 * The whole decision, as a pure function of six numbers, so it can be tested
 * without a database (--self-test) instead of being trusted because it looks
 * right. `reasons` is what makes the exit code non-zero; `notes` is context
 * that never changes the answer.
 */
export function verdict({ errors, fatals, prevErrors, prevCode, elapsedMinutes, windowComplete }) {
  const reasons = [];
  const notes = [];

  if (fatals > 0) {
    reasons.push(`${fatals} FATAL crash${fatals === 1 ? "" : "es"} in the first ${elapsedMinutes} minutes`);
  }

  if (prevCode == null) {
    notes.push("no previous release to compare against -- fatal count is the only signal here");
  } else if (errors < MIN_SIGNAL) {
    notes.push(`${errors} errors is below the ${MIN_SIGNAL}-error floor; too few to call a regression either way`);
  } else if (prevErrors === 0) {
    reasons.push(`${errors} errors against 0 for ${prevCode} over the same ${elapsedMinutes} minutes`);
  } else if (errors >= REGRESSION_FACTOR * prevErrors) {
    reasons.push(`${errors} errors against ${prevErrors} for ${prevCode} over the same ${elapsedMinutes} minutes ` +
      `(${(errors / prevErrors).toFixed(1)}x, threshold ${REGRESSION_FACTOR}x)`);
  } else {
    notes.push(`${errors} errors against ${prevErrors} for ${prevCode} over the same ${elapsedMinutes} minutes -- not a regression`);
  }

  if (!windowComplete) notes.push("window not finished yet; this is an interim reading");

  return { bad: reasons.length > 0, reasons, notes };
}

// --------------------------------------------------------------------- sql

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "post-release-watch-"));
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

/** The target release and the one before it, with both error counts measured
 *  over the SAME elapsed time from each one's own released_at.
 *
 *  `versionCode` is either null (newest release) or a number this module has
 *  already put through Number.isInteger -- nothing else is ever interpolated
 *  into this SQL. */
export function summarySql(versionCode, windowMinutes) {
  const pick = versionCode == null
    ? "select version_code, version_name, released_at from public.app_releases order by released_at desc limit 1"
    : `select version_code, version_name, released_at from public.app_releases where version_code = ${versionCode} order by released_at desc limit 1`;
  return `
with target as (${pick}),
prev as (
  select r.version_code, r.version_name, r.released_at
    from public.app_releases r cross join target t
   where r.released_at < t.released_at
   order by r.released_at desc
   limit 1
),
span as (
  select t.version_code, t.version_name, t.released_at,
         p.version_code as prev_code, p.version_name as prev_name, p.released_at as prev_released_at,
         least(interval '${windowMinutes} minutes',
               greatest(now() - t.released_at, interval '0')) as elapsed
    from target t left join prev p on true
)
select s.version_code, s.version_name, s.released_at::text as released_at,
       s.prev_code, s.prev_name,
       floor(extract(epoch from s.elapsed) / 60.0)::int as elapsed_minutes,
       (extract(epoch from s.elapsed) >= ${windowMinutes} * 60 - 1) as window_complete,
       (select count(*) from public.app_errors e
         where e.version_code = s.version_code
           and e.at >= s.released_at and e.at < s.released_at + s.elapsed) as errors,
       (select count(*) from public.app_errors e
         where e.version_code = s.version_code and e.fatal
           and e.at >= s.released_at and e.at < s.released_at + s.elapsed) as fatals,
       (select count(*) from public.app_errors e
         where s.prev_code is not null and e.version_code = s.prev_code
           and e.at >= s.prev_released_at and e.at < s.prev_released_at + s.elapsed) as prev_errors,
       (select count(*) from public.app_errors e
         where s.prev_code is not null and e.version_code = s.prev_code and e.fatal
           and e.at >= s.prev_released_at and e.at < s.prev_released_at + s.elapsed) as prev_fatals,
       (select count(*) from public.app_errors e where e.version_code = s.version_code) as errors_all_time
  from span s;`;
}

/** The fatals themselves, and the non-fatals grouped by message so twenty
 *  copies of one sync failure read as one problem rather than twenty.
 *  `email` and `reported_by` are not in either select list, on purpose. */
function detailSql(versionCode, windowMinutes, fatalsOnly) {
  return `
with target as (
  select version_code, released_at from public.app_releases
   where version_code = ${versionCode} order by released_at desc limit 1
),
span as (
  select t.version_code, t.released_at,
         least(interval '${windowMinutes} minutes', greatest(now() - t.released_at, interval '0')) as elapsed
    from target t
)
select e.id, e.at::text as at, e.where_at, e.android,
       left(e.message, 240) as message, count(*) over () as total
  from public.app_errors e cross join span s
 where e.version_code = s.version_code
   and e.fatal ${fatalsOnly ? "" : "is false"}
   and e.at >= s.released_at and e.at < s.released_at + s.elapsed
 order by e.at
 limit 20;`;
}

// -------------------------------------------------------------- self-test

/** Planted cases, each of which must come out the way it is labelled. This is
 *  the part that proves the checker can fail: a redaction that blanks
 *  everything and a verdict that always says "clean" would both look perfect
 *  in production and catch nothing. Cases 3 and 7 are the positive controls --
 *  ordinary text must survive redaction, and a genuinely worse build must be
 *  called a regression. */
function selfTest() {
  const cases = [];
  const check = (name, got, want) => cases.push({ name, ok: got === want, got, want });

  // redaction
  check("an email in a crash message is removed",
    redact("upload failed for march@example.com at offset 12"),
    "upload failed for [email redacted] at offset 12");
  check("a JWT in a crash message is removed",
    redact("401 Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.c2lnbmF0dXJl"),
    "401 Bearer [token redacted]");
  check("POSITIVE CONTROL: ordinary text is left alone",
    redact("Unexpected JSON token at offset 1636 at path $[1].correction_reason"),
    "Unexpected JSON token at offset 1636 at path $[1].correction_reason");
  check("null message does not throw and prints as empty", redact(null), "");

  // verdict
  const v = (o) => verdict({ elapsedMinutes: 60, windowComplete: true, prevCode: 500, ...o });
  check("a single fatal is enough on its own", v({ errors: 1, fatals: 1, prevErrors: 40 }).bad, true);
  check("a handful of errors against zero is NOT a regression",
    v({ errors: 3, fatals: 0, prevErrors: 0 }).bad, false);
  check("POSITIVE CONTROL: a real jump against zero IS a regression",
    v({ errors: 6, fatals: 0, prevErrors: 0 }).bad, true);
  check("twice the previous build is a regression",
    v({ errors: 20, fatals: 0, prevErrors: 10 }).bad, true);
  check("slightly worse than the previous build is not",
    v({ errors: 10, fatals: 0, prevErrors: 8 }).bad, false);
  check("a quieter build than the last one is clean",
    v({ errors: 0, fatals: 0, prevErrors: 50 }).bad, false);
  check("the real 1.502-vs-1.501 shape is an improvement, not a regression",
    v({ errors: 33, fatals: 0, prevErrors: 52 }).bad, false);
  check("no previous release: only fatals can fail it",
    verdict({ errors: 99, fatals: 0, prevErrors: 0, prevCode: null, elapsedMinutes: 60, windowComplete: true }).bad, false);

  let failed = 0;
  for (const c of cases) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? "  ok  " : "  FAIL"} ${c.name}` + (c.ok ? "" : `\n        wanted ${JSON.stringify(c.want)}, got ${JSON.stringify(c.got)}`));
  }
  console.log(`${cases.length - failed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

// ------------------------------------------------------------------- main

function parseArgs(argv) {
  const opts = { versionCode: null, minutes: 60, intervalSeconds: 300, once: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") opts.once = true;
    else if (a === "--self-test") opts.selfTest = true;
    else if (a === "--version-code") opts.versionCode = Number(argv[++i]);
    else if (a === "--minutes") opts.minutes = Number(argv[++i]);
    else if (a === "--interval") opts.intervalSeconds = Number(argv[++i]);
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown argument ${a} (try --help)`);
  }
  // Validated rather than trusted: these are the only values that reach the
  // SQL, and an integer check is what keeps that interpolation honest.
  if (opts.versionCode != null && !Number.isInteger(opts.versionCode)) throw new Error("--version-code must be an integer");
  if (!Number.isInteger(opts.minutes) || opts.minutes <= 0) throw new Error("--minutes must be a positive integer");
  if (!Number.isInteger(opts.intervalSeconds) || opts.intervalSeconds <= 0) throw new Error("--interval must be a positive integer (seconds)");
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function printPass(row, opts) {
  const v = verdict({
    errors: Number(row.errors), fatals: Number(row.fatals),
    prevErrors: Number(row.prev_errors), prevCode: row.prev_code ?? null,
    elapsedMinutes: Number(row.elapsed_minutes), windowComplete: row.window_complete === true,
  });

  console.log(`\n${row.version_name} (code ${row.version_code}), released ${row.released_at}`);
  console.log(`  ${row.elapsed_minutes} of ${opts.minutes} minutes watched` +
    `  |  errors ${row.errors} (${row.fatals} fatal)` +
    (row.prev_code != null
      ? `  |  ${row.prev_name} over its own first ${row.elapsed_minutes} min: ${row.prev_errors} (${row.prev_fatals} fatal)`
      : "  |  no previous release") +
    `  |  ${row.errors_all_time} errors for this build all time`);

  if (Number(row.fatals) > 0) {
    let rows = [];
    try { rows = runSql(detailSql(Number(row.version_code), opts.minutes, true)); }
    catch (e) { console.log(`  (could not read the fatal rows: ${e.message})`); }
    for (const f of rows) {
      console.log(`  FATAL  #${f.id}  ${f.at}  ${redact(f.where_at)}  [${redact(f.android)}]`);
      console.log(`         ${redact(f.message)}`);
    }
  }

  for (const r of v.reasons) console.log(`  WRONG  ${r}`);
  for (const n of v.notes) console.log(`  note   ${n}`);
  return v;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("node scripts/post-release-watch.mjs [--version-code N] [--minutes 60] [--interval 300] [--once] [--self-test]");
    return 0;
  }
  if (opts.selfTest) return selfTest();

  let last = null;
  for (;;) {
    const rows = runSql(summarySql(opts.versionCode, opts.minutes));
    if (!rows.length) {
      console.error(opts.versionCode == null
        ? "No releases at all in app_releases -- nothing to watch."
        : `No release with version_code ${opts.versionCode}.`);
      return 2;
    }
    const row = rows[0];
    last = printPass(row, opts);

    if (opts.once || row.window_complete === true) break;
    const waited = Number(row.elapsed_minutes);
    console.log(`  ...${opts.minutes - waited} minutes to go; next look in ${opts.intervalSeconds}s`);
    await sleep(opts.intervalSeconds * 1000);
  }

  if (last.bad) {
    console.log(`\nThis release needs a look. ${last.reasons.join("; ")}`);
    console.log("Withdrawing it: admin_demote_release(<release id>) stops any further phone being offered it");
    console.log("(supabase_p2_release_rollback.sql). A phone that already updated keeps the build -- the fix rolls forward.");
    return 1;
  }
  console.log("\nNothing wrong with this release in the window watched.");
  return 0;
}

// Only when run directly, so importing this file for its pure functions does
// not start talking to the database.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => { console.error("post-release-watch could not run at all:", e.message); process.exit(2); });
}
