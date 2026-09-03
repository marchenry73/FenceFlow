#!/usr/bin/env node
/**
 * Rebuilds the FenceFlow schema on a NON-PRODUCTION Supabase project by
 * replaying every .sql file in this repository, in the order they were applied
 * to production.
 *
 * Why replay rather than restore a dump: `supabase db dump` runs pg_dump inside
 * Docker, and Docker is not installed on this machine. It also wants the
 * database password. `db query` goes through the Management API and needs
 * neither -- only the CLI login that is already here.
 *
 * The order comes from supabase/dev/apply-order.txt, which is the git history
 * order with two corrections: the base schema first, and every *_fix file
 * behind the *_patch it repairs (git lists a commit's files alphabetically, so
 * a fix committed beside its patch sorts ahead of it).
 *
 * Ordering is still a guess in places, so a failure is not fatal on the first
 * pass. Failed files are retried while any of them is still succeeding, which
 * resolves the ordinary case of "B needed A and A came later". Whatever is
 * still failing when progress stops is printed in full -- and the real proof
 * is the fingerprint diff afterwards, not this script's exit code.
 *
 * Usage:
 *   node scripts/apply-schema.mjs <dev-project-ref>
 *
 * It refuses to run against production. This script only ever builds a copy.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const PROD_REF = "newcrgafcptspmapacrx";
const REPO_ROOT = resolve(import.meta.dirname, "..");

const ref = process.argv[2];
if (!ref) {
  console.error("Usage: node scripts/apply-schema.mjs <dev-project-ref>");
  process.exit(1);
}

// The whole point of a dev environment is that this can never be the live one.
// Checked here rather than trusted to the person typing at 11pm.
if (ref === PROD_REF) {
  console.error(
    `Refusing to run against ${PROD_REF} -- that is production.\n` +
    "This script rebuilds a schema from scratch and is for the dev project only."
  );
  process.exit(1);
}

const order = readFileSync(join(REPO_ROOT, "supabase/dev/apply-order.txt"), "utf8")
  .trim().split(/\r?\n/).filter(Boolean);

/** Runs one .sql file against the target project. Returns null, or the error. */
function apply(file) {
  const path = join(REPO_ROOT, file);
  try {
    // --linked AND --project-ref together: --project-ref alone is rejected as
    // mutually exclusive, and --linked alone cannot resolve the ref from this
    // repo's link file. shell:true because npx is a .cmd and Node will not
    // exec one directly.
    execFileSync(
      "npx.cmd",
      ["-y", "supabase", "db", "query", "--linked", "--project-ref", ref, "-f", `"${path}"`],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    return null;
  } catch (e) {
    const text = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message;
    return text.slice(0, 600);
  }
}

console.log(`Replaying ${order.length} SQL files onto ${ref}\n`);

let pending = order.slice();
const errors = new Map();
let pass = 0;

while (pending.length > 0) {
  pass++;
  const failed = [];
  let succeededThisPass = 0;

  for (const file of pending) {
    const error = apply(file);
    if (error) {
      failed.push(file);
      errors.set(file, error);
      process.stdout.write("x");
    } else {
      succeededThisPass++;
      errors.delete(file);
      process.stdout.write(".");
    }
  }
  console.log(`\npass ${pass}: ${succeededThisPass} applied, ${failed.length} failed`);

  // No progress means the rest are genuinely broken, not merely out of order.
  if (succeededThisPass === 0 || failed.length === 0) { pending = failed; break; }
  pending = failed;
}

console.log("");
if (pending.length === 0) {
  console.log(`All ${order.length} files applied to ${ref}.`);
} else {
  console.log(`${pending.length} file(s) still failing on ${ref}:\n`);
  for (const file of pending) console.log(`--- ${file}\n${errors.get(file)}\n`);
  console.log(
    "Some of these are expected: files that backfill or clean up data have\n" +
    "nothing to act on in an empty database. Read each one before worrying.\n"
  );
}

console.log(
  "\nNext, prove it matches production:\n" +
  `  node scripts/schema-fingerprint.mjs ${ref} supabase/dev/fingerprint-dev.txt\n` +
  "  node scripts/schema-diff.mjs supabase/dev/fingerprint-prod.txt supabase/dev/fingerprint-dev.txt"
);
process.exit(pending.length === 0 ? 0 : 2);
