// The dev office at /dev/ must open only for a sandbox company.
//
// There is one Supabase project and a second is not free, so /dev/ shares the
// live database. Its red bar says "test data only, nothing here reaches a real
// customer". Signed in as the real company that sentence is FALSE, and a live
// office wearing a warning stripe is worse than no dev site at all: it invites
// exactly the experiment nobody would try on production.
//
// Two things therefore have to hold, and this is what checks them:
//
//   1. the generated dev config sets REQUIRE_SANDBOX, and the LIVE config does
//      not -- so none of this can ever run on the real office;
//   2. dashboard.html refuses under REQUIRE_SANDBOX unless is_sandbox is
//      exactly true, and fails CLOSED on an error or a missing row.
//
//   node tests/a155-dev-office-opens-only-for-a-sandbox.test.mjs
import { readFileSync, existsSync, rmSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_CONFIG = join(ROOT, "website", "config.js");
// Built in the OS temp directory, not in the repo. Cleaning up afterwards is
// not enough on its own: a run that dies leaves the folder behind, and a
// generated page inside the tree is counted by every repo-wide scan -- which
// is how the first version of this broke tests/a26-doors.test.mjs.
const BUILD = join(tmpdir(), `ff-a155-${process.pid}`);
const DEV_DIR = join(BUILD, "dev");
const DEV_CONFIG = join(DEV_DIR, "config.js");
const DASH = join(ROOT, "website", "dashboard.html");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? ` -- ${extra}` : ""}`); }
};

// ---------------------------------------------------------------------------
// 1. The generator, run for real.
// ---------------------------------------------------------------------------
rmSync(BUILD, { recursive: true, force: true });
ok("this starts from nothing", !existsSync(BUILD));

let built = "";
try {
  built = execFileSync(process.execPath, [join(ROOT, "scripts", "build-dev-site.mjs"), "--out", BUILD], { encoding: "utf8" });
} catch (e) {
  built = `FAILED: ${e.stdout ?? ""}${e.stderr ?? ""}`;
}
ok("scripts/build-dev-site.mjs builds the dev office", /differing in config\.js alone/.test(built), built.slice(0, 200));
ok("and it exists afterwards", existsSync(DEV_CONFIG));

const live = readFileSync(LIVE_CONFIG, "utf8");
const dev = existsSync(DEV_CONFIG) ? readFileSync(DEV_CONFIG, "utf8") : "";

ok("the dev config says ENV dev", /ENV:\s*'dev'/.test(dev));
ok("the dev config sets REQUIRE_SANDBOX true", /REQUIRE_SANDBOX:\s*true/.test(dev));
ok("THE LIVE CONFIG DOES NOT mention REQUIRE_SANDBOX, so the real office never runs this",
  !/REQUIRE_SANDBOX/.test(live));
ok("the live config still says ENV prod", /ENV:\s*'prod'/.test(live));
ok("both point at the same project, because there is only one",
  (dev.match(/SUPABASE_URL:\s*'([^']+)'/) || [])[1] === (live.match(/SUPABASE_URL:\s*'([^']+)'/) || [])[1]);
ok("the dev config carries the same red-bar block as live, not a reworded copy",
  dev.includes("nothing here reaches a real customer") && live.includes("nothing here reaches a real customer"));
ok("the dev copy of the office is byte for byte the live one",
  existsSync(join(DEV_DIR, "dashboard.html")) &&
  readFileSync(join(DEV_DIR, "dashboard.html")).equals(readFileSync(DASH)));

// ---------------------------------------------------------------------------
// 1b. The two guards the ORIGINAL script carried, which a rewrite dropped once
// already. Both are about a file that is served to every visitor.
// ---------------------------------------------------------------------------
function build(extraArgs) {
  try {
    return { ok: true, out: execFileSync(process.execPath,
      [join(ROOT, "scripts", "build-dev-site.mjs"), ...extraArgs], { encoding: "utf8" }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

{
  const prod = build(["https://newcrgafcptspmapacrx.supabase.co", "sb_publishable_x", "--out", BUILD + "-p"]);
  ok("a dev site pointed at PRODUCTION is refused",
    !prod.ok && /not a dev site/i.test(prod.out), prod.out.slice(0, 120));

  const secret = build(["https://other.supabase.co", "sb_secret_abc", "--out", BUILD + "-s"]);
  ok("a SECRET key is refused, because this file is served to every visitor",
    !secret.ok && /secret key/i.test(secret.out), secret.out.slice(0, 120));

  const sep = build(["https://devproj.supabase.co", "sb_publishable_devkey", "--out", BUILD + "-sep"]);
  ok("a separate dev project builds", sep.ok, sep.out.slice(0, 120));
  const sepCfg = existsSync(join(BUILD + "-sep", "dev", "config.js"))
    ? readFileSync(join(BUILD + "-sep", "dev", "config.js"), "utf8") : "";
  ok("...pointed at that project, not production", /devproj\.supabase\.co/.test(sepCfg));
  ok("...and WITHOUT REQUIRE_SANDBOX, which only exists because one database is shared",
    !/REQUIRE_SANDBOX/.test(sepCfg));
  ok("CANARY: the same-database build DOES set it, so the check above distinguishes",
    /REQUIRE_SANDBOX:\s*true/.test(dev));

  for (const suffix of ["-p", "-s", "-sep"]) rmSync(BUILD + suffix, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 1c. STAGING: /dev/ built from the dev BRANCH, live from main.
//
// Both copies used to come from one commit, so a change reached the live
// office and the dev office in the same second -- which made /dev/ a place to
// use test data, not a place to try code before it went live. --dev-from
// builds the /dev/ copy from a second tree, which in CI is a checkout of the
// dev branch.
//
// The thing that must hold however far the two trees drift: the dev config is
// still generated from the LIVE url and key with REQUIRE_SANDBOX, so nothing
// committed to the dev branch can repoint the dev office at another project or
// lift the sandbox restriction.
// ---------------------------------------------------------------------------
{
  const TREE = join(tmpdir(), `ff-a155-devtree-${process.pid}`);
  const OUT = join(tmpdir(), `ff-a155-staged-${process.pid}`);
  rmSync(TREE, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });

  // A dev tree is the live tree plus one marked change.
  cpSync(join(ROOT, "website"), join(TREE, "website"), { recursive: true });
  const MARK = "ZZ-STAGED-ONLY-" + process.pid;
  writeFileSync(join(TREE, "website", "index.html"),
    readFileSync(join(TREE, "website", "index.html"), "utf8") + `\n<!-- ${MARK} -->\n`, "utf8");

  const staged = build(["--out", OUT, "--dev-from", TREE]);
  ok("a dev tree builds, and says it is staging", staged.ok && /staging from/.test(staged.out),
    staged.out.slice(0, 200));

  const devIndex = existsSync(join(OUT, "dev", "index.html"))
    ? readFileSync(join(OUT, "dev", "index.html"), "utf8") : "";
  const liveIndex = existsSync(join(OUT, "index.html"))
    ? readFileSync(join(OUT, "index.html"), "utf8") : "";
  ok("THE STAGED CHANGE IS IN /dev/", devIndex.includes(MARK));
  ok("...and NOT on the live site, which is the whole point",
    !liveIndex.includes(MARK));

  const stagedCfg = existsSync(join(OUT, "dev", "config.js"))
    ? readFileSync(join(OUT, "dev", "config.js"), "utf8") : "";
  ok("the staged dev config STILL sets REQUIRE_SANDBOX",
    /REQUIRE_SANDBOX:\s*true/.test(stagedCfg));
  ok("...and still points at the live project, not somewhere the dev branch chose",
    stagedCfg.includes((live.match(/SUPABASE_URL:\s*'([^']+)'/) || [])[1]));

  // CANARY: the same build with no --dev-from must NOT carry the mark, or the
  // two checks above would pass for a build that staged nothing.
  const plain = build(["--out", OUT + "-plain"]);
  const plainDev = existsSync(join(OUT + "-plain", "dev", "index.html"))
    ? readFileSync(join(OUT + "-plain", "dev", "index.html"), "utf8") : "";
  ok("CANARY: without --dev-from the mark is absent, so staging really did something",
    plain.ok && !plainDev.includes(MARK));

  // It must refuse rather than quietly fall back to the live tree: a /dev/
  // that silently became a copy of live is a staging site that tests nothing.
  const empty = join(tmpdir(), `ff-a155-empty-${process.pid}`);
  rmSync(empty, { recursive: true, force: true });
  mkdirSync(empty, { recursive: true });
  const missing = build(["--out", OUT + "-m", "--dev-from", empty]);
  ok("a --dev-from with no website/ in it is REFUSED, not silently ignored",
    !missing.ok && /no website\/dashboard\.html/.test(missing.out), missing.out.slice(0, 160));

  const sameTree = build(["--out", OUT + "-s", "--dev-from", ROOT]);
  ok("--dev-from pointing at this same tree is refused, because it stages nothing",
    !sameTree.ok && /stages nothing/.test(sameTree.out), sameTree.out.slice(0, 160));

  for (const d of [TREE, OUT, OUT + "-plain", OUT + "-m", OUT + "-s", empty]) {
    rmSync(d, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 2. The guard in the office itself.
//
// Read from the REAL dashboard.html, with comments stripped first -- a check
// that matches its own explanatory comment proves nothing, and that has caught
// this codebase out before.
// ---------------------------------------------------------------------------
const dash = readFileSync(DASH, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

const guard = (dash.match(/if\(window\.FENCEFLOW_CONFIG[^]*?REQUIRE_SANDBOX[^]*?\n  \}/) || [""])[0];
ok("the office has a REQUIRE_SANDBOX guard, outside the comments", guard.length > 100,
  `matched ${guard.length} chars`);
ok("it reads is_sandbox for the signed-in company",
  /\.select\('is_sandbox'\)/.test(guard) && /profile\.company_id/.test(guard));
ok("it refuses unless is_sandbox is exactly true", /is_sandbox!==true/.test(guard.replace(/\s/g, "")));
ok("it fails CLOSED on a read error", /sbErr\s*\|\|/.test(guard));
ok("...and on a missing row", /!sbRow/.test(guard));
ok("it clears the profile so nothing loads behind the refusal", /profile=null/.test(guard));
ok("it returns rather than carrying on", /\breturn;/.test(guard));

// ---------------------------------------------------------------------------
// 3. THE CANARY. Put each half of the guard back the way it would be if
// somebody loosened it, and the checks above must notice. Without this, a
// regex that matches nothing reads as a guard that is present and correct.
// ---------------------------------------------------------------------------
{
  const loosened = guard.replace("is_sandbox!==true", "is_sandbox===false");
  ok("THE CANARY FIRES: a guard that opens for a company whose flag is merely not false is caught",
    loosened !== guard && !/is_sandbox!==true/.test(loosened.replace(/\s/g, "")),
    "the exactly-true check cannot be distinguished from a looser one");

  // Target the CONDITION, not every mention: `sbErr ||` also appears in the
  // console.error below it, and replacing the first occurrence left the second
  // behind -- which made this canary report a failure that was its own.
  const failOpen = guard.replace("if(sbErr || !sbRow", "if(false && !sbRow");
  ok("CANARY: a guard that stops failing closed on a read error is caught",
    failOpen !== guard && !/if\(sbErr \|\| !sbRow/.test(failOpen),
    "the fail-closed check proves nothing");

  ok("CANARY: the guard matcher finds nothing in a file that has no guard",
    !/if\(window\.FENCEFLOW_CONFIG[^]*?REQUIRE_SANDBOX/.test("const x = 1; // nothing here"),
    "the matcher matches anything, so the passes above are meaningless");
}

console.log(`\npass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
