// a94: THE DEPLOYED PRICING FUNCTION MUST CARRY THE ENGINE THE SOURCE DOES.
//
// The parity gate compares the two SOURCE engines -- Kotlin and TypeScript --
// and proves they agree on 85 fixtures. It says nothing about what is actually
// RUNNING, and on 5 Oct 2026 that gap was open and live:
//
//   phone, shipped in 1.602 ............ engine 2026.10.9
//   supabase/functions/_shared/pricing .. engine 2026.10.9  (parity green)
//   price-job, as DEPLOYED .............. engine 2026.10.8  (deployed 2 Oct)
//
// Two days of the office pricing a job by the old rules -- two gate posts, and
// the TALLER side owning a shared corner post -- while the phone used the new
// ones. The whole point of carrying two engines is that they agree, and the
// gate that enforces it could not see the deployment.
//
// This is a SOURCE-ONLY check: it cannot reach Supabase. What it pins is the
// thing that makes the divergence detectable -- that price-job is the only
// function bundling the engine, and that the version constant exists in both
// engines and matches. Whoever bumps it then knows exactly one function needs
// deploying, and the comment below says so.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

let passed = 0, failed = 0;
const ok = (id, what, cond, detail) => {
  if (cond) { passed++; console.log(`  ok    ${id} ${what}`); }
  else { failed++; console.log(`  FAIL  ${id} ${what}${detail ? " -- " + detail : ""}`); }
};

const kt = read("app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt");
const ts = read("supabase/functions/_shared/pricing/index.ts");

const ktVer = (kt.match(/PRICING_ENGINE_VERSION\s*=\s*"([^"]+)"/) || [])[1];
const tsVer = (ts.match(/PRICING_ENGINE_VERSION\s*=\s*"([^"]+)"/) || [])[1];

console.log("\n1. BOTH ENGINES DECLARE A VERSION, AND IT IS THE SAME ONE");
ok("1a", "the Kotlin engine declares a version", !!ktVer, String(ktVer));
ok("1b", "the TypeScript engine declares a version", !!tsVer, String(tsVer));
ok("1c", "and they are identical -- a mismatch here is the office quoting a different number from the phone",
  !!ktVer && ktVer === tsVer, `kotlin ${ktVer} vs typescript ${tsVer}`);

console.log("\n2. EXACTLY ONE EDGE FUNCTION BUNDLES THE ENGINE");
// If this ever becomes two, bumping the version means deploying both, and
// forgetting the second reopens exactly the gap this file is named for.
{
  const dir = join(ROOT, "supabase/functions");
  const fns = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .filter((e) => {
      try { return read(`supabase/functions/${e.name}/index.ts`).includes("_shared/pricing"); }
      catch { return false; }
    })
    .map((e) => e.name).sort();
  ok("2a", "price-job is the one that bundles it",
    JSON.stringify(fns) === JSON.stringify(["price-job"]),
    `bundling the engine: ${JSON.stringify(fns)}`);
  ok("2b", "CANARY: the scan really looked -- it found at least one function at all", fns.length >= 1);
}

console.log("\n3. THE DEPLOY STEP IS WRITTEN DOWN WHERE THE VERSION LIVES");
// A version constant with no note about deploying is how two days of
// divergence happened without anyone noticing.
ok("3a", "the TypeScript engine says price-job must be redeployed when the version moves",
  /redeploy|deploy/i.test(ts.slice(0, 4000)) && /price-job/.test(ts.slice(0, 4000)),
  "no deploy note near the top of _shared/pricing/index.ts");

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
