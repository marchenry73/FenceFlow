#!/usr/bin/env node
/**
 * Compares two schema fingerprints and prints what differs.
 *
 * This is the step that turns "I applied the patches to dev" into "dev is
 * actually the same shape as production". Applying 106 files in a guessed order
 * and assuming it worked is how a dev environment quietly stops representing
 * the thing it is supposed to represent -- and a test that passes on a schema
 * production does not have is worse than no test.
 *
 * Usage:
 *   node scripts/schema-diff.mjs <expected-file> <actual-file>
 *
 * Exit code 0 when identical, 1 when they differ.
 */
import { readFileSync } from "node:fs";

const [expectedFile, actualFile] = process.argv.slice(2);
if (!expectedFile || !actualFile) {
  console.error("Usage: node scripts/schema-diff.mjs <expected-file> <actual-file>");
  process.exit(1);
}

const read = f => new Set(readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean));
const expected = read(expectedFile);
const actual = read(actualFile);

const missing = [...expected].filter(l => !actual.has(l)).sort();
const extra = [...actual].filter(l => !expected.has(l)).sort();

const kind = l => l.split(/\s+/)[0];

function report(title, lines) {
  if (lines.length === 0) return;
  console.log(`\n${title} (${lines.length})`);
  let current = null;
  for (const l of lines) {
    if (kind(l) !== current) { current = kind(l); console.log(`  --- ${current}`); }
    console.log(`    ${l}`);
  }
}

console.log(`expected: ${expectedFile} (${expected.size} lines)`);
console.log(`actual:   ${actualFile} (${actual.size} lines)`);

report("MISSING from actual", missing);
report("EXTRA in actual", extra);

if (missing.length === 0 && extra.length === 0) {
  console.log("\nIdentical. Every table, column, constraint, index, policy, function,");
  console.log("trigger, view, bucket, grant and realtime subscription matches.");
  process.exit(0);
}

console.log(
  "\nNot identical. A few differences are normal and harmless:\n" +
  "  - GRANT lines, if the projects were created at different times\n" +
  "  - EXTENSION version numbers\n" +
  "  - anything seeded by data rather than by schema\n" +
  "Everything else is a real gap: fix it in dev with the patch it came from,\n" +
  "then run this again."
);
process.exit(1);
