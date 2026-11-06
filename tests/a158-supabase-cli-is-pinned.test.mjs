// EVERY script that shells out to the Supabase CLI must name an exact version.
//
// `npx -y supabase` fetches whatever the latest release happens to be. On
// 31 Oct 2026 that was 2.122.0, whose own binary threw "Error: spawn UNKNOWN"
// from inside the CLI: publish-release's gate passed 9 of 9 and the upload
// then failed twice, and the fallback announced the PREVIOUS APK as the new
// one. publish-release was pinned that day. Six other scripts were not, and
// were found still unpinned on 6 Nov 2026 -- by which time the latest release
// was 3.0.0, a MAJOR version. Among them: backup-cloud.mjs and
// verify-backup.mjs, so the backup and the check that the backup is good were
// both one npx resolution away from breaking quietly.
//
// THIS TEST MUST STRIP COMMENTS, and that is not a detail. publish-release.mjs
// carries a comment that quotes the unpinned form in order to explain why it
// was pinned. A naive search flags that comment -- and a naive REPLACE
// corrupts it, which is exactly what happened while writing this.
//
//   node tests/a158-supabase-cli-is-pinned.test.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "scripts";
const PIN = /^supabase@\d+\.\d+\.\d+$/;

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? ` -- ${extra}` : ""}`); }
};

/** Source with // line comments and block comments removed. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/([^:"'`\\])\/\/[^\n"'`]*$/gm, "$1");
}

/**
 * Every unpinned CLI package name, per file.
 *
 * Matched as THE TOKEN AFTER THE NPX FLAG, not as any quoted "supabase"
 * anywhere. The looser form flagged `join(ROOT, "supabase", "dev", ...)` in
 * apply-migrations.mjs and `join(REPO_ROOT, "supabase", "functions")` in
 * deploy-functions.mjs -- path segments, not arguments. A check that cannot
 * tell a path from a command line is a check that gets switched off.
 */
function unpinned(src) {
  const code = stripComments(src);
  return [...code.matchAll(/"(?:-y|--no-install)",\s*"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((pkg) => pkg.startsWith("supabase") && !PIN.test(pkg));
}

/** Does this file invoke the CLI at all? Same anchor, so the two agree. */
function invokesCli(src) {
  const code = stripComments(src);
  return /"(?:-y|--no-install)",\s*"supabase(?:@[^"]*)?"/.test(code);
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".mjs"));
ok("there are scripts to check", files.length > 10, `${files.length} found`);

const offenders = [];
let invokers = 0;
for (const f of files) {
  const src = readFileSync(join(DIR, f), "utf8");
  if (invokesCli(src)) invokers++;
  const bad = unpinned(src);
  if (bad.length) offenders.push(`${f}: ${bad.join(", ")}`);
}

ok("NO SCRIPT INVOKES AN UNPINNED SUPABASE CLI", offenders.length === 0, offenders.join(" | "));

// Not vacuous: if nothing matched at all, the check above would pass on a
// directory with no CLI calls in it, which is how a guard quietly stops
// guarding.
ok("and the search does find the scripts that DO invoke it", invokers >= 5,
  `only ${invokers} script(s) name the CLI at all, so the check above may be matching nothing`);

// ---------------------------------------------------------------------------
// CANARIES
// ---------------------------------------------------------------------------
ok("CANARY: an unpinned call is caught",
  unpinned('execFileSync("npx.cmd", ["-y", "supabase", "db", "query"]);').length === 1);

ok("CANARY: a pinned call is NOT caught",
  unpinned('execFileSync("npx.cmd", ["-y", "supabase@2.115.0", "db", "query"]);').length === 0);

ok("CANARY: a DIFFERENT pinned version is still accepted, so this does not freeze the version",
  unpinned('["--no-install", "supabase@9.9.9", "functions", "list"]').length === 0);

ok("CANARY: a floating range is caught, not just a bare name",
  unpinned('["-y", "supabase@latest"]').length === 1 &&
  unpinned('["-y", "supabase@^2"]').length === 1);

ok("CANARY: a PATH SEGMENT called supabase is not mistaken for a command",
  unpinned('const p = join(ROOT, "supabase", "dev", "apply-order.txt");').length === 0 &&
  unpinned('const d = join(REPO_ROOT, "supabase", "functions");').length === 0,
  "this is the false positive the first version of this test reported");

// THE ONE THAT ENCODES THE MISTAKE: publish-release.mjs quotes the unpinned
// form inside a comment on purpose. Without the stripping this test flags it,
// so the stripping is load-bearing and this proves it.
{
  const pub = readFileSync(join(DIR, "publish-release.mjs"), "utf8");
  ok("publish-release.mjs really does quote the unpinned form in a comment",
    /\/\/.*"-y", "supabase"/.test(pub),
    "the comment moved, so the check below no longer proves the stripping matters");
  ok("...it is NOT reported, because comments are stripped",
    unpinned(pub).length === 0, unpinned(pub).join(", "));
  ok("CANARY: without stripping, that same comment WOULD be reported",
    [...pub.matchAll(/"(supabase(?:@[^"]*)?)"/g)].map((m) => m[1]).filter((p) => !PIN.test(p)).length > 0,
    "the stripping is not what makes publish-release pass, so this proves nothing");
}

console.log(`\npass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
