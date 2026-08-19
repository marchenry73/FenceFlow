#!/usr/bin/env node
/**
 * Tells every phone there is a new version.
 *
 * The app checks `app_releases` on launch and shows a prompt when it finds a
 * version newer than its own. This is what puts the row there.
 *
 * Usage:
 *   node scripts/publish-release.mjs "What changed, in a sentence"
 *   node scripts/publish-release.mjs "Fixes a wrong total on the invoice" --urgent
 *
 * The version number is taken from the commit count, exactly as the build
 * takes it, so the two cannot disagree. Build first, then publish -- otherwise
 * you announce a version whose APK is not on Drive yet.
 *
 * --urgent marks the update mandatory: the prompt has no "Later" and cannot be
 * dismissed. Reserve it for money and data. An app that insists on updating for
 * a colour change teaches people to ignore the one that matters.
 *
 * There is deliberately no way to publish from the app itself -- app_releases
 * has no write policy, so a compromised phone cannot tell your whole company to
 * install something. This script goes through the Supabase CLI, which uses your
 * own login rather than a key stored anywhere.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const PROJECT_REF = "newcrgafcptspmapacrx";
const REPO_ROOT = resolve(import.meta.dirname, "..");

const args = process.argv.slice(2);
const urgent = args.includes("--urgent");

// Where people actually get the APK. Without it the prompt appears with a
// button that does nothing, which reads as the app being broken -- so this is
// remembered from the last release and reused when omitted. Set it once.
const urlFlag = args.findIndex((a) => a === "--url");
const downloadUrl = urlFlag >= 0 ? (args[urlFlag + 1] || "") : null;

const notes = args
  .filter((a, i) => a !== "--urgent" && a !== "--url" && !(urlFlag >= 0 && i === urlFlag + 1))
  .join(" ").trim();

if (!notes) {
  console.error("Say what changed, so the prompt is worth reading.\n");
  console.error('  node scripts/publish-release.mjs "Fixes the invoice total"');
  console.error('  node scripts/publish-release.mjs "Fixes a payment bug" --urgent');
  process.exit(1);
}

/** The same number the build stamps into the APK. */
function versionCode() {
  const out = execFileSync("git", ["rev-list", "--count", "HEAD"], {
    cwd: REPO_ROOT, encoding: "utf8",
  });
  return parseInt(out.trim(), 10);
}

const code = versionCode();
const name = `1.${code}`;

// Warn rather than refuse: the APK may legitimately live elsewhere.
const apk = join(REPO_ROOT, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
if (!existsSync(apk)) {
  console.warn("Note: no built APK found locally. Did you run assembleDebug first?\n");
}

const esc = (s) => String(s).replace(/'/g, "''");

// An omitted --url inherits the previous release's link rather than blanking
// it, so the URL only has to be typed once ever.
const urlExpr = downloadUrl === null
  ? "coalesce((select download_url from public.app_releases order by version_code desc limit 1), '')"
  : "'" + esc(downloadUrl) + "'";

const sql = `
insert into public.app_releases (version_code, version_name, notes, is_mandatory, download_url)
values (${code}, '${esc(name)}', '${esc(notes)}', ${urgent}, ${urlExpr})
on conflict (version_code) do update
  set version_name  = excluded.version_name,
      notes         = excluded.notes,
      is_mandatory  = excluded.is_mandatory,
      download_url  = excluded.download_url;

select version_code, version_name, is_mandatory, download_url from public.app_releases
order by version_code desc limit 1;
`;

const file = join(tmpdir(), `ff-release-${process.pid}.sql`);
writeFileSync(file, sql);

try {
  const out = execFileSync(
    "npx.cmd",
    ["-y", "supabase", "db", "query", "--linked", "--project-ref", PROJECT_REF, "-f", `"${file}"`],
    { encoding: "utf8", shell: true }
  );
  if (/"error"/.test(out)) {
    console.error("Publish failed:\n" + out);
    process.exit(1);
  }
  console.log(`Published version ${name}${urgent ? "  (mandatory)" : ""}`);
  console.log(`  "${notes}"`);

  // Say so loudly. A release with no link shows a prompt people cannot act on.
  if (/"download_url":\s*""/.test(out)) {
    console.warn("\nWARNING: this release has no download link, so the prompt");
    console.warn("will tell people to look in the shared folder instead of");
    console.warn("opening it for them. Set one once and it is reused after that:");
    console.warn('  node scripts/publish-release.mjs "notes" --url "https://..."');
  }

  console.log("\nEvery phone will prompt next time the app is opened.");
  console.log("Make sure the APK in that folder is this build.");
} finally {
  rmSync(file, { force: true });
}
