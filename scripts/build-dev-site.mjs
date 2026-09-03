#!/usr/bin/env node
/**
 * Generates website/dev/ -- a copy of the site pointed at the dev project.
 *
 * GitHub Pages serves one branch, so the dev copy lives in a folder of the
 * same site rather than on a branch of its own:
 *
 *   https://fenceflowapp.com/           live
 *   https://fenceflowapp.com/dev/       dev
 *
 * The copy differs from the live site by exactly one file, config.js, and that
 * file carries ENV:'dev', which is what makes every dev page wear the red bar.
 * Everything else is copied byte for byte, so the dev site cannot drift into
 * testing something the live site does not do.
 *
 * Regenerate after any website change -- it is a copy, not a link, so an edit
 * to website/dashboard.html does not reach website/dev/ until you re-run this.
 *
 * Usage:
 *   node scripts/build-dev-site.mjs https://<dev-ref>.supabase.co sb_publishable_<dev key>
 *
 * Both values are public by design: the URL is a hostname and the publishable
 * key is meant to sit in a browser. The service_role key has no business here
 * and this script has no place to put one.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PROD_REF = "newcrgafcptspmapacrx";
const REPO_ROOT = resolve(import.meta.dirname, "..");
const SITE = join(REPO_ROOT, "website");
const DEV = join(SITE, "dev");

const [devUrl, devKey] = process.argv.slice(2);
if (!devUrl || !devKey) {
  console.error(
    "Usage: node scripts/build-dev-site.mjs <dev-supabase-url> <dev-publishable-key>\n" +
    "  e.g. node scripts/build-dev-site.mjs https://abcd.supabase.co sb_publishable_xxx"
  );
  process.exit(1);
}
if (devUrl.includes(PROD_REF)) {
  console.error(`That is the production URL. A dev site pointed at production is not a dev site.`);
  process.exit(1);
}
if (/service_role|^eyJ/.test(devKey) || devKey.startsWith("sb_secret")) {
  console.error(
    "That looks like a secret key, not a publishable one.\n" +
    "This file is committed to a public repository. Use the publishable key."
  );
  process.exit(1);
}

rmSync(DEV, { recursive: true, force: true });
mkdirSync(DEV, { recursive: true });

let copied = 0;
function copyInto(from, to) {
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    if (src === DEV) continue;                   // never copy the copy into itself
    const dest = join(to, name);
    if (statSync(src).isDirectory()) {
      mkdirSync(dest, { recursive: true });
      copyInto(src, dest);
    } else {
      copyFileSync(src, dest);
      copied++;
    }
  }
}
copyInto(SITE, DEV);

// The one file that differs.
const config = readFileSync(join(SITE, "config.js"), "utf8")
  .replace("ENV: 'prod'", "ENV: 'dev'")
  .replace(/SUPABASE_URL: '[^']*'/, `SUPABASE_URL: '${devUrl.replace(/\/+$/, "")}'`)
  .replace(/SUPABASE_KEY: '[^']*'/, `SUPABASE_KEY: '${devKey}'`);

if (!config.includes("ENV: 'dev'") || config.includes(PROD_REF)) {
  console.error("The dev config did not come out right. Not writing it.");
  process.exit(1);
}
writeFileSync(join(DEV, "config.js"), config);

console.log(`website/dev/ rebuilt: ${copied} files copied, config.js rewritten.`);
console.log(`  backend : ${devUrl}`);
console.log(`  banner  : on (every dev page shows the red DEV bar)`);
console.log(`\nPreview it first:  node scripts/serve-website.mjs dev 8081`);
console.log(`Then commit and push; Pages publishes it at /dev/.`);
