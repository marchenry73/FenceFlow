#!/usr/bin/env node
/**
 * Deploys every Edge Function to a named project.
 *
 * deploy-functions.cmd, which this does not replace, deploys three of them to
 * production by a hardcoded ref. That was fine when three was all there was;
 * there are twelve now, and a dev project needs all twelve or it is not a copy
 * of anything.
 *
 * The verify_jwt flags come from supabase/config.toml and are NOT repeated
 * here. That file is the single source of truth for which functions the API
 * gateway may check a JWT on, and getting one wrong is silent: deploy
 * stripe-webhook with verification on and Stripe's events are rejected with a
 * 401 before the function runs, so payments simply stop being marked paid.
 * Passing --project-ref overrides the project_id pinned in that file while
 * leaving every per-function flag intact, which is exactly what is wanted.
 *
 * Usage:
 *   node scripts/deploy-functions.mjs <project-ref>
 *
 * Afterwards the project needs its own secrets. They are per-project: the dev
 * project starts with none, and a function whose secret is missing fails at
 * runtime rather than at deploy time.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const PROD_REF = "newcrgafcptspmapacrx";
const REPO_ROOT = resolve(import.meta.dirname, "..");
const FUNCTIONS_DIR = join(REPO_ROOT, "supabase", "functions");

const ref = process.argv[2];
if (!ref) {
  console.error(
    "Usage: node scripts/deploy-functions.mjs <project-ref>\n" +
    "  dev  : the ref of the fenceflow-dev project\n" +
    `  prod : ${PROD_REF}`
  );
  process.exit(1);
}

// The pricing parity gate, before a single function is deployed -- to dev
// as much as to production, because the dev project is where the office
// first prices a job against the phone. price-job carries the server copy
// of the pricing engine, and deploying a copy that disagrees with the phone
// is the failure this whole arrangement exists to prevent. There is
// deliberately no flag to skip this.
{
  const gate = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "check-parity.mjs")], {
    cwd: REPO_ROOT, stdio: "inherit",
  });
  if (gate.status !== 0) {
    console.error("\nRefusing to deploy: the pricing parity gate is red (see above).");
    process.exit(1);
  }
}

const functions = readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith("_"))
  .filter(d => existsSync(join(FUNCTIONS_DIR, d.name, "index.ts")))
  .map(d => d.name)
  .sort();

console.log(
  ref === PROD_REF
    ? "\n  *** TARGET: PRODUCTION ***\n"
    : `\n  Target: ${ref} (not production)\n`
);
console.log(`Deploying ${functions.length} functions: ${functions.join(", ")}\n`);

const failed = [];
for (const [i, name] of functions.entries()) {
  process.stdout.write(`  ${String(i + 1).padStart(2)}/${functions.length}  ${name.padEnd(24)}`);
  try {
    // shell:true because npx is a .cmd on Windows and Node will not exec one
    // directly. --workdir keeps the CLI reading this repo's config.toml no
    // matter where the script was invoked from.
    execFileSync(
      "npx.cmd",
      ["-y", "supabase", "functions", "deploy", name,
       "--project-ref", ref, "--workdir", `"${REPO_ROOT}"`],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, shell: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    console.log("ok");
  } catch (e) {
    console.log("FAILED");
    failed.push([name, `${e.stdout ?? ""}${e.stderr ?? ""}`.trim().slice(0, 400)]);
  }
}

if (failed.length) {
  console.log(`\n${failed.length} failed:\n`);
  for (const [name, error] of failed) console.log(`--- ${name}\n${error}\n`);
  process.exit(2);
}

console.log(`\nAll ${functions.length} deployed to ${ref}.`);
if (ref !== PROD_REF) {
  console.log(
    "\nThe dev project needs its own secrets -- nothing carries over from\n" +
    "production. In the dashboard, Edge Functions -> Secrets:\n" +
    "\n" +
    "  STRIPE_SECRET_KEY      the same sk_test_... production already uses\n" +
    "  STRIPE_WEBHOOK_SECRET  a NEW whsec_... from a second Stripe test\n" +
    "                         endpoint pointed at this project\n" +
    "  SITE_URL               the dev site, e.g.\n" +
    "                         https://fenceflowapp.com/dev\n" +
    "\n" +
    "Test keys can be shared with production; the webhook secret cannot --\n" +
    "it is issued per endpoint, and reusing production's means every dev\n" +
    "event fails its signature check.\n" +
    "\n" +
    "Stripe test webhook endpoint:\n" +
    `  https://${ref}.supabase.co/functions/v1/stripe-webhook`
  );
}
