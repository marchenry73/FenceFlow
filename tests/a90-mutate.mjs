// Prove a90 catches a RUNTIME break, not just a missing string.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = readFileSync("website/dashboard.html", "utf8");
const MUTANTS = [
  ["a typo'd global: ALERT_DEFS -> ALERT_DEFSS", "ALERT_DEFS.find(x => x.key === f.detector)", "ALERT_DEFSS.find(x => x.key === f.detector)"],
  ["the severity class is dropped", "f.severity === 'critical' ? ' urgent' : ''", "''"],
  ["the message stops being escaped", "${esc(f.message)} &middot;", "${f.message} &middot;"],
];
let survived = 0;
for (const [what, from, to] of MUTANTS) {
  if (src.split(from).length - 1 !== 1) { console.log(`  SKIP  ${what} (anchor not unique)`); survived++; continue; }
  const p = join(tmpdir(), "a90-mutant.html");
  writeFileSync(p, src.split(from).join(to), "utf8");
  let red = false;
  try { execFileSync(process.execPath, ["tests/a90-attention-panel-renders.test.mjs"],
    { env: { ...process.env, A27_PAGE: p }, encoding: "utf8" }); }
  catch { red = true; }
  console.log(`  ${red ? "killed  " : "SURVIVED"}  ${what}`);
  if (!red) survived++;
}
console.log(`\n${survived === 0 ? "PASS" : "FAIL"}  ${MUTANTS.length - survived}/${MUTANTS.length} killed`);
process.exit(survived === 0 ? 0 : 1);
