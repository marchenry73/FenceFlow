// a99: THE RETRY MUST FIRE ON THE FLAKE AND NOTHING ELSE.
//
// `supabase db query` creates a temporary postgres role to run as, and about
// one run in four loses that handshake:
//
//   failed to connect as temp role: ... password authentication failed for
//   user "cli_login_postgres" (SQLSTATE 28P01)
//
// On 5 Oct 2026 that cost two publish runs, roughly an hour, each reported as
// "the job costing gate is red" when every check in it was fine.
//
// So downstream-job-costing retries -- but a retry is a loaded gun pointed at
// the gate. If it ever swallowed a real failure, a file whose whole purpose is
// proving the office's money arithmetic would start passing while the
// arithmetic was wrong, and nobody would know because the output would look
// identical.
//
// This pins the one property that keeps the retry honest: it fires on the
// connection flake and on nothing else. The regex is read out of the real file
// rather than copied, so the two cannot drift apart.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "tests/downstream-job-costing.test.mjs"), "utf8");

// Pull the literal out of the file under test, so this cannot pass against a
// copy that no longer matches what actually runs.
function connectFlakeRegex() {
  const m = SRC.match(/const CONNECT_FLAKE\s*=\s*\n?\s*(\/.*\/[a-z]*);/);
  assert.ok(m, "could not find CONNECT_FLAKE in downstream-job-costing.test.mjs");
  const body = m[1].slice(1, m[1].lastIndexOf("/"));
  const flags = m[1].slice(m[1].lastIndexOf("/") + 1);
  return new RegExp(body, flags);
}

// Verbatim from the failed publish run of 5 Oct 2026.
const REAL_FLAKE =
  'Initialising login role...\n' +
  'failed to connect as temp role: failed to connect to postgres: failed to connect to ' +
  '`host=aws-0-ca-central-1.pooler.supabase.com user=cli_login_postgres.newcrgafcptspmapacrx ' +
  'database=postgres`: server error (FATAL: password authentication failed for user ' +
  '"cli_login_postgres" (SQLSTATE 28P01))';

// Things that must NEVER be retried. Each is a real failure the gate exists to
// report, and retrying one would hide it behind an identical-looking pass.
const MUST_NOT_RETRY = [
  ['a column that does not exist',
   'ERROR:  42703: column "created_at" does not exist'],
  ['a syntax error',
   'ERROR:  42601: syntax error at or near "slect"'],
  ['a permission refusal -- the gate proving a guard works',
   'ERROR:  42501: permission denied for table jobs'],
  ['a raised assertion from inside the check itself',
   'ERROR:  P0001: margin_percent disagreed with the recomputation'],
  ['a function that is not there',
   'ERROR:  42883: function job_costing() does not exist'],
  ['a failed uniqueness constraint',
   'ERROR:  23505: duplicate key value violates unique constraint'],
  ['an ordinary empty result',
   '{"rows":[]}'],
  ['a successful run',
   '{"rows":[{"positive_control":1}]}'],
];

test("the real connection flake is recognised", () => {
  assert.ok(connectFlakeRegex().test(REAL_FLAKE),
    "the retry would not fire on the exact error that cost two publish runs");
});

test("no real failure is ever retried", () => {
  const re = connectFlakeRegex();
  const wronglyRetried = MUST_NOT_RETRY
    .filter(([, text]) => re.test(text))
    .map(([what]) => what);
  assert.deepEqual(wronglyRetried, [],
    "these would be retried instead of reported:\n  " + wronglyRetried.join("\n  "));
});

test("the retry is bounded, and still throws when it gives up", () => {
  assert.match(SRC, /ATTEMPTS\s*=\s*[2-5]\b/, "the retry should be bounded to a few attempts");
  assert.match(SRC, /could not connect after \$\{ATTEMPTS\} attempts/,
    "giving up must throw, so the caller still reports the gate as red");
});

test("the output text is judged before the exit code", () => {
  // This CLI has been seen to report the login failure while still exiting 0,
  // so a retry keyed only on a non-zero status would miss half of them.
  const flakeAt = SRC.indexOf("CONNECT_FLAKE.test(out)");
  const statusAt = SRC.indexOf("if (r.status !== 0) throw");
  assert.ok(flakeAt > 0 && statusAt > 0, "could not find both checks");
  assert.ok(flakeAt < statusAt,
    "the flake check must come first -- the CLI can report this failure and exit 0");
});

test("retrying is only safe because nothing here writes", () => {
  assert.match(SRC, /reads or rolls back|read-only|rolls back/i,
    "the retry should record why repeating a statement is safe");
});
