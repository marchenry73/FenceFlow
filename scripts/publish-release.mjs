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

const apk = join(REPO_ROOT, "app", "build", "outputs", "apk", "debug", "app-debug.apk");

/**
 * Puts the APK somewhere the app can actually download it, and returns that URL.
 *
 * Google Drive cannot do this job. A restricted file redirects an anonymous
 * download to a sign-in page, and Drive interstitials APKs it cannot
 * virus-scan even when they are shared -- either way the app downloads HTML
 * and Android refuses to install a web page. That is not a setting to get
 * right; it is the wrong host for the file.
 *
 * The releases bucket is public on purpose, and it is the only public one. An
 * APK is not a secret: it is the app, and anybody with it installed already
 * has a copy. No company's jobs, customers or money live in that bucket.
 */
function uploadApk(code) {
  if (!existsSync(apk)) {
    console.warn("No built APK found. Run assembleDebug first, or pass --url.\n");
    return null;
  }
  // A new name every publish.
  //
  // Storage refuses to overwrite an existing object, so reusing one name means
  // a republish silently keeps the OLD apk and hands people a build that is
  // not the one just made -- the worst possible failure for an update
  // mechanism, because everything reports success.
  //
  // The commit hash makes each upload distinct without needing a delete first,
  // and it also makes the URL say exactly which build it is. Old files can be
  // cleared out of the bucket whenever; nothing points at them once a newer
  // release row exists.
  const stamp = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: REPO_ROOT, encoding: "utf8",
  }).trim();
  const remote = `fenceflow-${code}-${stamp}.apk`;

  try {
    // A RELATIVE path, run from the repo root.
    //
    // shell:true is needed to launch npx.cmd on Windows, and the shell eats the
    // backslashes in an absolute Windows path -- the CLI received
    // "C:UsersmarchAndroidProjects..." and could not parse it. Going relative
    // sidesteps the quoting problem instead of fighting it.
    execFileSync(
      "npx.cmd",
      [
        "-y", "supabase", "storage", "cp", "--experimental",
        "app/build/outputs/apk/debug/app-debug.apk",
        `"ss:///releases/${remote}"`,
        "--linked", "--project-ref", PROJECT_REF
      ],
      { encoding: "utf8", shell: true, cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] }
    );
    return `https://${PROJECT_REF}.supabase.co/storage/v1/object/public/releases/${remote}`;
  } catch (e) {
    // The CLI's own message, not just "command failed" -- which says nothing
    // about why and sent me chasing the wrong cause twice.
    const detail = String(e.stderr || e.stdout || e.message || "").trim();
    console.warn("Could not upload the APK.\n  " + detail.slice(0, 400));
    return null;
  }
}

const esc = (s) => String(s).replace(/'/g, "''");

// An explicit --url wins. Otherwise the APK is uploaded and that URL is used,
// so publishing is one command and the link can never point at a build that
// is not the one just made.
const hostedUrl = downloadUrl === null ? uploadApk(code) : null;
const effectiveUrl = downloadUrl !== null ? downloadUrl : hostedUrl;

const urlExpr = effectiveUrl === null
  ? "coalesce((select download_url from public.app_releases order by version_code desc limit 1), '')"
  : "'" + esc(effectiveUrl) + "'";

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

  if (hostedUrl) console.log(`  hosted at ${hostedUrl}`);

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
