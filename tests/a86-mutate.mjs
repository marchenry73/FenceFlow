// a86 MUTATION HARNESS: prove the CROSS-FILE checks can go red.
//
// a86's whole claim is that it catches a page calling a server function that
// does not exist, or passing an argument name the function does not declare --
// the shape that is invisible until somebody clicks the button in production.
// A grep that passes proves only that a string is present. So: break a COPY of
// the page, or of the SQL, one way at a time, and require the NAMED check to
// fail.
//
// None of the real files is ever written to.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FILES = {
  page: "website/dashboard.html",
  settings: "supabase_p4_attention_settings.sql",
  findings: "supabase_p4_attention_findings.sql",
};
const ENV = { page: "A86_PAGE", settings: "A86_SQL_SETTINGS", findings: "A86_SQL_FINDINGS" };
const OUT = join(tmpdir(), "a86-mutants");
mkdirSync(OUT, { recursive: true });
const original = Object.fromEntries(
  Object.entries(FILES).map(([k, p]) => [k, readFileSync(p, "utf8")]));

/* Each is a regression somebody could plausibly commit -- a rename, a dropped
   grant, a tightened policy -- not a syntactic mangling. */
const MUTATIONS = [
  // The LOAD-path mount specifically. Removing the writers' own calls is not
  // the bug: a panel rendered only when you press its button still never shows
  // up when the page opens, which is the SideTypesCard shape exactly.
  { id: "1b", which: "page", what: "the panel is never mounted on load, only re-rendered by its own buttons",
    from: "try { renderAttention(); }", to: "try { /* unmounted */ }" },
  { id: "2b", which: "settings", what: "the function renames its argument and the page keeps passing the old name",
    from: "p_enabled boolean", to: "p_switched_on boolean" },
  { id: "2b", which: "page", what: "the page passes an argument name the function does not declare",
    from: "{ p_enabled: on }", to: "{ enabled: on }" },
  { id: "2d", which: "page", what: "the clear call passes the wrong argument name",
    from: "{ p_finding_id: id }", to: "{ finding_id: id }" },
  { id: "2e", which: "findings", what: "the clear function loses its grant to authenticated",
    from: "grant  execute on function public.clear_attention_finding(uuid) to authenticated;",
    to: "-- grant removed" },
  { id: "3d", which: "page", what: "it stops filtering out findings somebody already cleared",
    from: ".is('cleared_at', null)", to: "" },
  { id: "4a", which: "page", what: "an off switch shows an empty list instead of saying nothing is watching",
    from: "attnOffMeansBlind", to: "attnNoneOpen" },
  { id: "5a", which: "page", what: "the toggle is offered to somebody the server would refuse",
    from: "canFlip ? '' : 'disabled'", to: "''" },
];

let survived = 0;
for (const [i, m] of MUTATIONS.entries()) {
  const src = original[m.which];
  const n = src.split(m.from).length - 1;
  if (n === 0) {
    console.log(`  SKIP  ${m.id} (${m.which}) -- target not found; the check may be stale`);
    survived++; continue;
  }
  // Only the mutated file is replaced; the other two stay real, so a check that
  // passes by reading the wrong file cannot hide here.
  const env = { ...process.env };
  for (const [k, p] of Object.entries(FILES)) {
    const path = join(OUT, `${i}-${k.replace(/\W/g, "")}${k === "page" ? ".html" : ".sql"}`);
    writeFileSync(path, k === m.which ? src.split(m.from).join(m.to) : original[k], "utf8");
    env[ENV[k]] = path;
  }

  let red = false, out = "";
  try {
    out = execFileSync(process.execPath, ["tests/a86-attention-panel-wired.test.mjs"],
      { env, encoding: "utf8" });
  } catch (e) { red = true; out = String(e.stdout || ""); }

  const named = out.split("\n").filter(l => l.startsWith("  FAIL")).some(l => l.includes(` ${m.id} `));
  if (red && named) console.log(`  killed  ${m.id} (${m.which})  ${m.what}`);
  else {
    survived++;
    console.log(`  SURVIVED  ${m.id} (${m.which})  ${m.what} -- ${red ? "something else failed, not " + m.id : "the suite still passed"}`);
  }
}

console.log(`\n${survived === 0 ? "PASS" : "FAIL"}  ${MUTATIONS.length - survived}/${MUTATIONS.length} mutations killed`);
process.exit(survived === 0 ? 0 : 1);
