// a84 MUTATION HARNESS: prove every check in a84-office-shell-wired can go red.
//
// The checks all passed the first time they were run, which is exactly when a
// check is least trustworthy -- a grep for a string that is present passes
// whether or not it is the right string to be looking for. So: break a COPY of
// the page one way at a time, and require the named check to fail. A mutation
// that the suite survives is a check that is not watching anything.
//
// The real dashboard.html is never written to. Copies live in the scratch dir.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = "website/dashboard.html";
// tmpdir() rather than a Windows path, so this runs on the ubuntu Pages runner
// too. A gate that only works on one machine is a gate that stops running the
// first time it matters.
const OUT = join(tmpdir(), "a84-mutants");
mkdirSync(OUT, { recursive: true });
const original = readFileSync(SRC, "utf8");

/* Each mutation is a real regression somebody could plausibly commit, not a
   syntactic mangling. "Remove the reveal but leave the markup" is how a hidden
   control becomes permanently hidden; "point the tile back at Jobs" is the
   state this page was in yesterday. */
const MUTATIONS = [
  { id: "1d", what: "the reveal lines are deleted, so the controls are hidden forever",
    from: /\$\('osearchBox'\)\.style\.display = '';/g, to: "/* removed */" },
  { id: "2a", what: "search calls an RPC that does not exist",
    from: "db.rpc('search_office'", to: "db.rpc('search_everything'" },
  { id: "2c", what: "the stale-response guard is dropped, so an old query can overwrite a new one",
    from: "if (seq !== osearchSeq) return", to: "if (false) return" },
  { id: "3b", what: "+ New points at a button that is not on the page",
    from: 'id="newJob"', to: 'id="newJobButton"' },
  { id: "4a/4b", what: "a tab loses its panel",
    from: 'id="tab-cal"', to: 'id="tab-calendar"' },
  { id: "4e", what: "empty nav groups stop being hidden",
    from: "function syncNavGroups", to: "function syncNavGroupsDisabled" },
  { id: "5a", what: "the money tile goes back to opening the whole Jobs tab",
    from: "tile('reports', money(owedTotal)", to: "tile('jobs', money(owedTotal)" },
  { id: "5e", what: "Blocked gets its own definition instead of reading blocked_at",
    from: "return !!j.blocked_at", to: "return j.state === 'blocked'" },
];

let survived = 0;
for (const m of MUTATIONS) {
  const n = typeof m.from === "string"
    ? original.split(m.from).length - 1
    : (original.match(m.from) || []).length;
  if (n === 0) {
    console.log(`  SKIP  ${m.id} -- mutation target not found; the check may be stale`);
    survived++; continue;
  }
  const mutant = join(OUT, `mutant-${m.id.replace("/", "-")}.html`);
  writeFileSync(mutant, typeof m.from === "string"
    ? original.split(m.from).join(m.to)
    : original.replace(m.from, m.to), "utf8");

  let red = false, out = "";
  try {
    out = execFileSync(process.execPath, ["tests/a84-office-shell-wired.test.mjs"],
      { env: { ...process.env, A84_PAGE: mutant }, encoding: "utf8" });
  } catch (e) { red = true; out = String(e.stdout || ""); }

  // It must fail, AND it must fail on the check that claims to watch this.
  const named = out.split("\n").filter(l => l.startsWith("  FAIL"))
    .some(l => m.id.split("/").some(id => l.includes(` ${id} `)));
  if (red && named) { console.log(`  killed  ${m.id}  (${m.what})`); }
  else {
    survived++;
    console.log(`  SURVIVED  ${m.id}  (${m.what}) -- ${red ? "something else failed, not " + m.id : "the suite still passed"}`);
  }
}

console.log(`\n${survived === 0 ? "PASS" : "FAIL"}  ${MUTATIONS.length - survived}/${MUTATIONS.length} mutations killed`);
process.exit(survived === 0 ? 0 : 1);
