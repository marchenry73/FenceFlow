// Run every tests/*.test.mjs, with a per-test timeout and a line for anything
// that fails or drags.
//
// Why this exists: there are 191 of these files and, until 5 Oct 2026, about a
// dozen ran anywhere automatically -- the Pages workflow runs a handful, and
// the publish gate does not run tests/*.test.mjs at all. So they could be red
// for weeks with nobody looking, and three of them were sitting on real bugs:
//
//   * the Jobs tab's "Blocked" view read a column the page never selected, so
//     it had never matched a single job;
//   * can_see_pay() asks for SEE_MONEY rather than SEE_PAY;
//   * three files pinned the database version and went red when a legitimate
//     migration landed, one of them claiming "a phone at 49 would throw on
//     open" about a migration list that was perfectly correct.
//
// The first plain shell loop over these hung without printing anything for an
// hour and a half, which is why this has a timeout per test and prints as it
// goes: a hang that looks like "still working" is the thing to avoid.
//
//   node scripts/run-website-tests.mjs
//
// Full per-test timings land in the report file named at the end. Exit code is
// the number of files that failed or timed out, capped at 255.
import { readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PER_TEST_MS = Number(process.env.TEST_TIMEOUT_MS || 180_000);
const SLOW_MS = 10_000;

const tests = readdirSync(join(ROOT, "tests"))
  .filter((f) => f.endsWith(".test.mjs")).sort();

const report = [];
let pass = 0, fail = 0, timeout = 0;
for (const t of tests) {
  const started = process.hrtime.bigint();
  let state = "pass";
  try {
    execFileSync(process.execPath, [join("tests", t)],
      { cwd: ROOT, stdio: "ignore", timeout: PER_TEST_MS });
    pass++;
  } catch (e) {
    // A killed process is a hang, not a failing assertion, and the two want
    // very different responses -- so they are counted separately.
    if (e.killed || e.signal) { state = "TIMEOUT"; timeout++; } else { state = "FAIL"; fail++; }
  }
  const ms = Number((process.hrtime.bigint() - started) / 1000000n);
  const line = `${state.padEnd(8)} ${String(ms).padStart(6)}ms  ${t}`;
  if (state !== "pass" || ms > SLOW_MS) console.log(line);
  report.push(line);
}

const out = join(tmpdir(), "website-test-report.txt");
writeFileSync(out, report.join("\n") + "\n");
console.log(`\npass=${pass} fail=${fail} timeout=${timeout} of ${tests.length}`);
console.log(`full timings: ${out}`);
// Two files are red ON PURPOSE -- a32-join-posts and a32-join-transition are
// spec tests for joining work that has not landed, one of them marked as
// needing the owner's decision first. A clean run is 189 of 191, not 191.
process.exit(Math.min(255, fail + timeout));
