#!/usr/bin/env node
/**
 * Builds the site for publishing: the live pages at the root, and a dev copy
 * of them under /dev/.
 *
 *   https://fenceflowapp.com/           live
 *   https://fenceflowapp.com/dev/       dev
 *
 * The dev copy differs from the live one by exactly one file, config.js, and
 * this fails if anything else differs -- a dev site that has drifted tests
 * something the live site does not do.
 *
 * TWO MODES, and the difference matters.
 *
 *   node scripts/build-dev-site.mjs <dev-url> <dev-publishable-key>
 *       A SEPARATE dev project. This is the real thing: its own schema, its
 *       own functions, its own auth. Pass the dev project's URL and its
 *       PUBLISHABLE key.
 *
 *   node scripts/build-dev-site.mjs
 *       No dev project, because a second Supabase project is not free and
 *       March chose not to pause another to make room (5 Nov 2026). The dev
 *       site then points at the SAME database as live, which on its own would
 *       make its red bar -- "nothing here reaches a real customer" -- a lie,
 *       and a live office wearing a warning stripe is more dangerous than no
 *       dev site at all.
 *
 *       So this mode sets REQUIRE_SANDBOX, and dashboard.html refuses to open
 *       under it for any company that is not a sandbox, failing closed if it
 *       cannot tell. The bar then promises what the database enforces: a
 *       sandbox company cannot hold a mailbox or a payment connection
 *       (supabase_r64_sandbox_company.sql) and the transactional mail
 *       functions refuse it.
 *
 *       It is the lesser mode. It stages office and site CODE against
 *       real-shaped data. It cannot stage a schema change (one database) or an
 *       edge function (one project).
 *
 * WHY IT BUILDS INTO dist/ AND NOT website/dev/
 *   The earlier version of this script wrote into website/dev/. That puts a
 *   second dashboard.html inside the source tree, and every repo-wide scan
 *   counts it: tests/a26-doors.test.mjs went red on 5 Nov 2026 with
 *   website/dev/dashboard.html listed as a SIXTH writer of payment_records.
 *   Each such test carries its own walker, so excluding the folder test by
 *   test would only set the same trap for the next one. Generated output
 *   therefore lives outside the source tree, and this refuses to build inside
 *   it.
 *
 * Both values a dev project needs are public by design: the URL is a hostname
 * and the publishable key is meant to sit in a browser. The service_role key
 * has no business here and the check below keeps it out.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROD_REF = "newcrgafcptspmapacrx";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "website");

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const OUT = resolve(outAt >= 0 && args[outAt + 1] ? args[outAt + 1] : join(ROOT, "dist"));
// outAt is -1 when --out is absent, and -1 + 1 is 0, which silently dropped
// the first positional argument. Only skip the value when the flag is there.
const positional = args.filter((a, i) =>
  !a.startsWith("--") && !(outAt >= 0 && i === outAt + 1));
const [devUrl, devKey] = positional;

if (OUT === SITE || OUT.startsWith(SITE + "\\") || OUT.startsWith(SITE + "/")) {
  console.error("Refusing to build into website/: generated files inside the source tree are");
  console.error("counted by every repo-wide scan. Build into dist/ or another directory.");
  process.exit(2);
}
if (!existsSync(join(SITE, "config.js"))) {
  console.error("website/config.js is missing; this script builds from it.");
  process.exit(2);
}

// Kept from the original script, and both still matter.
if (devUrl && devUrl.includes(PROD_REF)) {
  console.error("That is the production URL. A dev site pointed at production is not a dev site.");
  console.error("Run with no arguments for the same-database mode, which refuses any company");
  console.error("that is not a sandbox instead of pretending to be separate.");
  process.exit(1);
}
if (devKey && (/service_role|^eyJ/.test(devKey) || devKey.startsWith("sb_secret"))) {
  console.error("That looks like a secret key, not a publishable one.");
  console.error("It would be written into a file served to every visitor. Use the publishable key.");
  process.exit(1);
}
if (devUrl && !devKey) {
  console.error("Usage: node scripts/build-dev-site.mjs [<dev-supabase-url> <dev-publishable-key>]");
  console.error("  with both   -> a separate dev project");
  console.error("  with neither-> the same database, restricted to sandbox companies");
  process.exit(1);
}

const liveConfig = readFileSync(join(SITE, "config.js"), "utf8");
const liveUrl = (liveConfig.match(/SUPABASE_URL:\s*'([^']+)'/) || [])[1];
const liveKey = (liveConfig.match(/SUPABASE_KEY:\s*'([^']+)'/) || [])[1];
if (!liveUrl || !liveKey) {
  console.error("Could not read SUPABASE_URL / SUPABASE_KEY out of website/config.js.");
  process.exit(2);
}

const separate = Boolean(devUrl && devKey);
const url = separate ? devUrl : liveUrl;
const key = separate ? devKey : liveKey;

// Written from scratch rather than patched, so a change to the live config's
// wording cannot silently carry into it.
const devConfig = `/*
 * GENERATED by scripts/build-dev-site.mjs -- do not edit.
 *
 * The dev copy of the site, served at /dev/. Every other file here is byte for
 * byte the live one; this file is the only difference.
 *${separate ? `
 * It points at a SEPARATE dev project, so nothing here can touch live data.` : `
 * It points at the SAME database as live, because there is one project. What
 * keeps it honest is REQUIRE_SANDBOX: the office refuses to open under this
 * config for any company that is not a sandbox, and fails closed if it cannot
 * tell. A sandbox company cannot hold a mailbox or a payment connection, and
 * the transactional mail functions refuse it, so the red bar below promises
 * something the database actually enforces.`}
 */
window.FENCEFLOW_CONFIG = {
  ENV: 'dev',
  SUPABASE_URL: '${url}',
  SUPABASE_KEY: '${key}',${separate ? "" : `
  REQUIRE_SANDBOX: true,`}
};

${liveConfig.slice(liveConfig.indexOf("if (window.FENCEFLOW_CONFIG.ENV !== 'prod')"))}`;

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const files = walk(SITE);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const src of files) {
  const rel = relative(SITE, src);
  for (const dest of [join(OUT, rel), join(OUT, "dev", rel)]) {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(src));
  }
}
writeFileSync(join(OUT, "dev", "config.js"), devConfig, "utf8");

// Proven, not assumed.
const differing = [];
for (const src of files) {
  const rel = relative(SITE, src);
  if (!readFileSync(join(OUT, rel)).equals(readFileSync(join(OUT, "dev", rel)))) differing.push(rel);
}
if (differing.length !== 1 || differing[0] !== "config.js") {
  console.error(`Expected exactly one difference (config.js), got: ${differing.join(", ") || "none"}`);
  process.exit(1);
}

console.log(`built ${files.length} page(s) into ${relative(ROOT, OUT) || OUT}/ and the same again under /dev/,`);
console.log(`differing in config.js alone.`);
console.log(separate
  ? `/dev/ points at the separate dev project ${url}.`
  : `/dev/ points at the LIVE database ${url} with REQUIRE_SANDBOX, so the office refuses\nany company that is not a sandbox. This is the fallback mode: it cannot stage a\nschema change or an edge function.`);
