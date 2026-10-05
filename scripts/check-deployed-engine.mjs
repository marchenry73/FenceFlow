// IS THE OFFICE RUNNING THE ENGINE THIS SOURCE TREE DESCRIBES?
//
// The parity gate proves the Kotlin and TypeScript engines agree. a94 proves
// the version constant exists in both and that exactly one edge function
// bundles the engine. Neither can see what is actually DEPLOYED, and on
// 3-5 Oct 2026 that gap was open and live for two days:
//
//   phone, shipped in 1.602 ............. engine 2026.10.9
//   supabase/functions/_shared/pricing ... engine 2026.10.9   (parity green)
//   price-job, as DEPLOYED .............. engine 2026.10.8   (deployed 2 Oct)
//
// The office quoted a gate with two gate posts and gave a shared corner post
// to the TALLER side, while the phone in the owner's hand did neither. Every
// gate was green throughout, and correctly so -- none of them looked.
//
// This looks. It cannot read the version out of the running function (nothing
// can without a job and a login), so it asks a question it CAN answer and that
// is false in exactly the case that matters:
//
//   was price-job deployed AFTER the last change to the engine it bundles?
//
// A deployment older than the source is stale by definition. That is precisely
// the two-day divergence, and it is detectable from a timestamp.
//
// Exit codes, kept distinct because the three cases need different responses:
//   0  fresh      -- deployed at or after the newest engine commit
//   1  STALE      -- redeploy: npx supabase functions deploy price-job --project-ref <ref>
//   2  unknown    -- could not find out. NOT a pass. A caller that treats 2 as
//                    success recreates the bug this file exists to catch.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "newcrgafcptspmapacrx";

// The paths whose change means the deployed bundle is out of date. price-job
// bundles _shared/pricing wholesale, so a change anywhere under it counts.
const ENGINE_PATHS = [
  "supabase/functions/_shared/pricing",
  "supabase/functions/price-job",
];

const say = (s) => console.log(s);

function sourceVersion() {
  const ts = readFileSync(join(ROOT, "supabase/functions/_shared/pricing/index.ts"), "utf8");
  return (ts.match(/PRICING_ENGINE_VERSION\s*=\s*"([^"]+)"/) || [])[1] ?? null;
}

// Newest commit touching the engine, as unix seconds.
function newestEngineCommit() {
  const r = spawnSync("git", ["log", "-1", "--format=%ct", "--", ...ENGINE_PATHS],
    { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) return null;
  const secs = Number(String(r.stdout).trim());
  return Number.isFinite(secs) && secs > 0 ? secs : null;
}

// Anything uncommitted under the engine means the deployed bundle cannot match
// this tree whatever the timestamps say -- there is nothing to have deployed.
function uncommittedEngineFiles() {
  const r = spawnSync("git", ["status", "--porcelain", "--", ...ENGINE_PATHS],
    { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) return [];
  return String(r.stdout).split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
}

// price-job's deployment time, as unix seconds. Two attempts: this is a
// network call and a blip must not read as "stale" any more than as "fresh".
function deployedAt() {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "functions", "list",
      "--project-ref", PROJECT, "--output", "json"],
      { encoding: "utf8", shell: process.platform === "win32", timeout: 120_000 });
    if (r.status === 0) {
      try {
        const body = JSON.parse(r.stdout);
        const fns = Array.isArray(body) ? body : (body.functions || []);
        const pj = fns.find((f) => f.slug === "price-job" || f.name === "price-job");
        if (!pj) return { error: "price-job is not deployed at all" };
        // The CLI reports milliseconds.
        return { at: Math.floor(Number(pj.updated_at) / 1000), version: pj.version };
      } catch (e) {
        return { error: `could not read the function list: ${e.message}` };
      }
    }
    if (attempt === 1) continue;
    return { error: String(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ") };
  }
  return { error: "unreachable" };
}

const iso = (secs) => new Date(secs * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z";

/** The whole judgement, as a pure function, so it can be proved to fail.
 *  A check nobody has watched go red is a check nobody should trust, and this
 *  one is otherwise only exercised against a tree that happens to be fresh. */
export function verdict(engineCommitSecs, deployedSecs) {
  if (!Number.isFinite(engineCommitSecs) || !Number.isFinite(deployedSecs)) return "unknown";
  return deployedSecs >= engineCommitSecs ? "fresh" : "stale";
}

// Everything below runs only when this file is executed, so a test can import
// verdict() without the module asking Supabase anything.
const RUN_DIRECTLY = process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (!RUN_DIRECTLY) { /* imported: stop here, exports above are what was wanted */ }
else main();

function main() {
const version = sourceVersion();
say(`source engine version .......... ${version ?? "NOT FOUND"}`);
if (!version) {
  say("\nCould not read PRICING_ENGINE_VERSION from the TypeScript engine.");
  process.exit(2);
}

const dirty = uncommittedEngineFiles();
if (dirty.length) {
  say(`\nUNKNOWN: the engine has uncommitted changes, so nothing deployed can match it:`);
  for (const f of dirty) say(`  ${f}`);
  say("\nCommit them, then deploy, then run this again.");
  process.exit(2);
}

const commitAt = newestEngineCommit();
if (!commitAt) {
  say("\nCould not read the engine's last commit time from git.");
  process.exit(2);
}
say(`engine last changed ............ ${iso(commitAt)}`);

const dep = deployedAt();
if (dep.error) {
  say(`\nUNKNOWN: could not ask Supabase when price-job was deployed.`);
  say(`  ${dep.error}`);
  say("\nThis is not a pass. Until it answers, nobody knows which engine the");
  say("office is quoting with.");
  process.exit(2);
}
say(`price-job deployed ............. ${iso(dep.at)}  (function version ${dep.version})`);

if (dep.at >= commitAt) {
  say(`\nFRESH. price-job was deployed after the engine last changed.`);
  process.exit(0);
}

const hours = Math.round((commitAt - dep.at) / 360) / 10;
say(`\nSTALE by ${hours} hours. The office is pricing with an older engine than this tree.`);
say(`That is the 3-5 Oct 2026 bug exactly: parity green, phone updated, office behind.`);
say(`\n  npx supabase functions deploy price-job --project-ref ${PROJECT}`);
process.exit(1);
}
