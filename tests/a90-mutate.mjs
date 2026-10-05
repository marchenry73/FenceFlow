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
  ["a90", "a permission-hidden list goes back to reading as all clear",
   "if (!canSeeMoney()) {", "if (false) {"],
  ["a90", "quiet hours stop being distinguished, so an unrecorded night reads as all clear",
   "if (isQuietHour(new Date(), qs.quiet_hours_start, qs.quiet_hours_end, offset)) {",
   "if (false) {"],
  ["a90", "a failed read goes back to reporting all clear",
   "if (attentionReadFailed) {", "if (false) {"],
  ["a90", "the Clear button is offered to everyone again, and silently does nothing for most",
   "${canFlip ? `<button class=\"btn btn-sm btn-grey attn-clear\"",
   "${true ? `<button class=\"btn btn-sm btn-grey attn-clear\""],
  ["a91", "already-sent follow-ups start counting as waiting again",
   "if (alreadySent.has(j.sync_id + '|' + def.key)) continue;", ""],
  // The customer-facing one: the guard that stops {{customer_first_name}}
  // reaching a real person. Three ways to neuter it, all must be caught.
  ["a85", "the placeholder refusal is switched off outright",
   "if (c.placeholderWarned !== names) {", "if (false) {"],
  ["a85", "the refusal warns but falls through, so the mail goes anyway",
   "return msg('mc_msg', tr('mailUnfilledPlaceholder', names), 'err');",
   "msg('mc_msg', tr('mailUnfilledPlaceholder', names), 'err');"],
  ["a85", "the guard stops looking at the subject",
   "unfilledPlaceholders(subject, text)", "unfilledPlaceholders(text)"],
  ["a91", "a failed settings read goes back to confidently reporting OFF",
   "followUpSettingsReadFailed ? tr('fuCouldNotAsk')", "false ? tr('fuCouldNotAsk')"],
  // The anchor stops at the opening bracket ON PURPOSE. It used to name the
  // whole list, `[renderFollowUps, renderAttention]`, and on 5 Oct 2026
  // renderBilling was added to it -- so the anchor stopped matching, the
  // mutation was SKIPPED, and the harness reported 17 of 18 killed. A skipped
  // mutation is correctly counted as not killed, which is the only reason this
  // was noticed rather than quietly passing.
  //
  // Anchoring on the part that cannot change keeps the mutation alive as the
  // list grows: emptying it is still exactly the failure being proved.
  ["a89", "setLang stops redrawing the panels, so a language switch undoes the honest message",
   "for (const redraw of [",
   "for (const redraw of []) { } if (false) for (const redraw of ["],
  // Proves the ranking assertion is real: reversing the sort must now fail.
  ["a93", "the chase ranking is reversed",
   ": b.score - a.score);", ": a.score - b.score);"],
  ["a93", "no-email stops beating opened, so a job with nowhere to send reads as a nudge",
   "action = !hasEmail", "action = false"],
  ["a93", "the opened/never-opened split collapses back to one label",
   "tr(j.quote_viewed_at ? 'chaseActFollowOpened' : 'chaseActFollowUnopened')",
   "tr('chaseActFollowOpened')"],
];

const TEST = { a90: "tests/a90-attention-panel-renders.test.mjs",
               a91: "tests/a91-followup-panel-renders.test.mjs",
               a93: "tests/a93-chase-labels.test.mjs",
               a89: "tests/a89-followup-state-is-honest.test.mjs",
               a85: "tests/a85-unfilled-placeholder-guard.test.mjs" };

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
      // Every page-path override these suites honour. a90/a91/a93 read the
      // page through a27's loader (A27_PAGE); a89 and a86 read it directly
      // under their own names. Setting only A27_PAGE meant a89 happily read
      // the REAL page and its mutation "survived" -- a harness that tests the
      // wrong file reports the check as toothless when it is fine.
      { env: { ...process.env, A27_PAGE: p, A89_PAGE: p, A86_PAGE: p, A84_PAGE: p, A85_PAGE: p }, encoding: "utf8" });
  } catch { red = true; }
  console.log(`  ${red ? "killed  " : "SURVIVED"}  [${suite}] ${what}`);
  if (!red) survived++;
}

console.log(`\n${survived === 0 ? "PASS" : "FAIL"}  ${MUTANTS.length - survived}/${MUTANTS.length} killed`);
process.exit(survived === 0 ? 0 : 1);
