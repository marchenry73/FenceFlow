// Prove the two RENDER tests catch a runtime break, not just a missing string.
//
// a90 and a91 lift renderAttention and renderFollowUps out of the page and run
// them. That is the only coverage in this repo that would catch a typo'd global
// or a wrong property name in those panels, because the office cannot be driven
// headlessly without a login. So each mutation below has to make the matching
// suite go red -- and the first one is deliberately the case no grep anywhere
// in this repo would find.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = readFileSync("website/dashboard.html", "utf8");

const MUTANTS = [
  ["a90", "a typo'd global: ALERT_DEFS -> ALERT_DEFSS",
   "ALERT_DEFS.find(x => x.key === f.detector)", "ALERT_DEFSS.find(x => x.key === f.detector)"],
  ["a90", "the severity class is dropped, so critical stops looking critical",
   "f.severity === 'critical' ? ' urgent' : ''", "''"],
  ["a90", "a server-supplied message stops being escaped",
   "${esc(f.message)} &middot;", "${f.message} &middot;"],
  ["a91", "the warning reads the master switch instead of the rules",
   "const anyKindOn = FOLLOW_UP_KIND_DEFS.some(def => !!s[def.enabledField]);",
   "const anyKindOn = !!s.enabled;"],
  // RE-AIMED: the condition it pointed at was two-state and said "no rule is
  // switched on" to somebody whose master switch was off but whose rules WERE
  // ticked. Now three-state, so the mutation collapses the first two back
  // together -- which is the regression worth catching.
  ["a91", "master-off and no-rule-ticked collapse back into one message",
   "!s.enabled ? tr('fuPreviewEmptyOff')",
   "!s.enabled ? tr('fuPreviewEmptyNoRules')"],
  ["a93", "no-email stops beating opened, so a job with nowhere to send reads as a nudge",
   "action = !hasEmail", "action = false"],
  ["a93", "the opened/never-opened split collapses back to one label",
   "tr(j.quote_viewed_at ? 'chaseActFollowOpened' : 'chaseActFollowUnopened')",
   "tr('chaseActFollowOpened')"],
];

const TEST = { a90: "tests/a90-attention-panel-renders.test.mjs",
               a91: "tests/a91-followup-panel-renders.test.mjs",
               a93: "tests/a93-chase-labels.test.mjs" };

let survived = 0;
for (const [suite, what, from, to] of MUTANTS) {
  if (src.split(from).length - 1 !== 1) {
    console.log(`  SKIP  [${suite}] ${what} -- anchor not unique; the mutation may be stale`);
    survived++; continue;
  }
  const p = join(tmpdir(), `a90-mutant-${suite}.html`);
  writeFileSync(p, src.split(from).join(to), "utf8");
  let red = false;
  try {
    execFileSync(process.execPath, [TEST[suite]],
      { env: { ...process.env, A27_PAGE: p }, encoding: "utf8" });
  } catch { red = true; }
  console.log(`  ${red ? "killed  " : "SURVIVED"}  [${suite}] ${what}`);
  if (!red) survived++;
}

console.log(`\n${survived === 0 ? "PASS" : "FAIL"}  ${MUTANTS.length - survived}/${MUTANTS.length} killed`);
process.exit(survived === 0 ? 0 : 1);
