// a89: "ON" WITH EVERY RULE OFF MUST NOT LOOK LIKE WORKING.
//
// Found on live data, not by reading code: follow_up_settings.enabled was true
// for the company, all four individual rules were false, and follow_up_log had
// been empty since the day it shipped. Nothing was broken. It had simply never
// been asked to send anything.
//
// What made that invisible is that the "due follow-ups" preview honours the
// rules. With every rule off it renders an empty list under a ticked master
// switch, which reads as "nobody needs chasing". At the moment it was read,
// three people had opened a quote and never heard back -- $23,540 between them
// -- and two more had approved with no deposit.
//
// So this is the same rule as the alerts panel: the screen must distinguish
// "nothing to do" from "nothing is looking".

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const page = readFileSync(process.env.A89_PAGE || join(ROOT, "website/dashboard.html"), "utf8");

let passed = 0, failed = 0;
const ok = (id, what, cond, detail) => {
  if (cond) { passed++; console.log(`  ok    ${id} ${what}`); }
  else { failed++; console.log(`  FAIL  ${id} ${what}${detail ? " -- " + detail : ""}`); }
};
const count = (s) => page.split(s).length - 1;

console.log("\n1. THE PANEL SAYS WHICH KIND OF NOTHING THIS IS");
ok("1a", "there is somewhere to say it", page.includes('id="fuStateNote"'));
ok("1b", "and it starts hidden, so a company with rules on never sees an empty box",
  page.includes('id="fuStateNote" style="display:none"'));
ok("1c", "the renderer asks whether ANY rule is on, not just the master switch",
  page.includes("const anyKindOn = FOLLOW_UP_KIND_DEFS.some(def => !!s[def.enabledField]);"));
ok("1d", "on-with-no-rules is called out specifically -- it is the state that lies",
  page.includes("fuStateOnButNoRules"));
ok("1e", "and it is styled as a warning, not as ordinary help text",
  page.includes("warn ? 'sub bad' : 'sub'"));

console.log("\n2. THE EMPTY DUE-LIST EXPLAINS ITSELF");
ok("2a", "the empty message depends on whether anything is switched on",
  page.includes("(!s.enabled || !anyKindOn)") && page.includes("fuPreviewEmptyNoRules"));
ok("2b", "and the no-rules wording says plainly that empty is not the same as nobody waiting",
  /not the same as nobody needing a follow-up/.test(page));
ok("2c", "the ordinary empty message is still used when rules ARE on",
  page.includes("tr('fuPreviewEmptyMsg')"));

console.log("\n3. ALL THREE LANGUAGES, OR IT SAYS 'undefined' TO TWO THIRDS OF THE APP");
for (const k of ["fuStateOff", "fuStateOnButNoRules", "fuPreviewEmptyNoRules"]) {
  ok(`3-${k}`, `${k} is defined three times`, count(`    ${k}:`) === 3, `found ${count(`    ${k}:`)}`);
}

console.log("\n4. THE CHASE LIST SAYS WHICH KIND OF 'FOLLOW UP' THIS IS");
// Same principle one panel over: "Follow up" was the label whether they had
// read the quote, never opened it, or had no address to receive it at all.
// Three different situations needing three different actions.
ok("4a", "a quote that was opened reads differently from one that was not",
  page.includes("tr(j.quote_viewed_at ? 'chaseActFollowOpened' : 'chaseActFollowUnopened')"));
ok("4b", "and no address beats both, because whether they opened it is moot with nowhere to send",
  page.includes("action = !hasEmail"));
ok("4c", "hasEmail trims, so a single space is not an address",
  page.includes(`const hasEmail = !!String(j.email || '').trim();`));
ok("4d", "the generic 'Follow up' label is gone from the page entirely",
  !/chaseActFollow'/.test(page) && !/chaseActFollow:/.test(page));
for (const k of ["chaseActFollowOpened", "chaseActFollowUnopened", "chaseActNoEmail"]) {
  ok(`4-${k}`, `${k} is defined three times`, count(`    ${k}:`) + count(` ${k}:`) >= 3);
}
// The ranking must NOT have been touched: he is used to that order.
ok("4e", "the score is still value times days waiting, untouched by any of this",
  page.includes("score: value * ageDays"));

console.log("\n5. CANARIES");
ok("5a", "CANARY: checking the master switch alone would not have caught this -- 1c reads the RULES",
  !"const anyKindOn = !!s.enabled;".includes("FOLLOW_UP_KIND_DEFS.some"));
ok("5b", "CANARY: 2a is anchored to the condition, so reverting the empty message to a constant fails it",
  !"previewEmpty.textContent = tr('fuPreviewEmptyMsg');".includes("!anyKindOn"));
ok("5c", "CANARY: the real page defines FOLLOW_UP_KIND_DEFS, so 1c is not matching a name that does not exist",
  page.includes("FOLLOW_UP_KIND_DEFS") && count("FOLLOW_UP_KIND_DEFS") >= 3);

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
