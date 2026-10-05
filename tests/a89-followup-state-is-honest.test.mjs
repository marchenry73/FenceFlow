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
  page.includes("(warn || followUpSettingsReadFailed) ? 'sub bad' : 'sub'"));
// A failed settings read falls back to defaults, whose enabled is false -- so
// without this the panel states "Follow-ups are off. Nothing below will send"
// about a company that may be sending right now.
ok("1f", "a failed settings read is its own message, ahead of off and no-rules",
  page.includes("followUpSettingsReadFailed ? tr('fuCouldNotAsk')"));
ok("1g", "and the loader actually records the failure, rather than only the renderer asking about it",
  page.includes("else followUpSettingsReadFailed = true;") &&
  page.includes("} catch (e) { followUpSettingsReadFailed = true; }"));

console.log("\n2. THE EMPTY DUE-LIST EXPLAINS ITSELF");
// THREE states, not two. The first version collapsed "the master switch is
// off" and "it is on but no rule is ticked" into one message that said no rule
// was switched on -- which is false, and misdirecting, for somebody who HAD
// ticked rules and left the master off.
ok("2a", "the empty message tells apart master-off, no-rule-ticked, and genuinely-nothing-due",
  page.includes("!s.enabled ? tr('fuPreviewEmptyOff')") &&
  page.includes(": !anyKindOn ? tr('fuPreviewEmptyNoRules')") &&
  page.includes(": tr('fuPreviewEmptyMsg')"));
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

console.log("\n5. A LANGUAGE SWITCH MUST NOT UNDO THE HONEST MESSAGES");
// setLang() calls applyStaticText(), which writes tr(k) into every [data-t]
// element. #fuPreviewEmpty carries data-t="fuPreviewEmptyMsg", so picking
// Spanish replaced the specific "no rule is switched on" wording with the
// ambiguous static line it exists to replace -- and nothing re-rendered it
// afterwards, so it stayed wrong until a reload.
// The list is matched by CONTENTS, not as a literal.
//
// It was pinned as the exact string `[renderFollowUps, renderAttention]`, and
// on 5 Oct 2026 renderBilling was added to it -- for the same reason those two
// are in it, the billing line was being overwritten by applyStaticText and the
// owner lost sight of which plan he was on. That is this check's own argument
// applied to a third panel, and it turned the check red.
//
// A test that forbids the fix it exists to encourage is worse than no test.
// What matters is that these two panels are redrawn and that it happens after
// applyStaticText; whether a fourth joins them is not this file's business.
// a96 pins renderBilling's place in the list.
const redrawList = (page.match(/for \(const redraw of \[([^\]]*)\]\)/) || [, ""])[1];
ok("5a", "setLang redraws the panels that write their own translated text",
  /\brenderFollowUps\b/.test(redrawList) && /\brenderAttention\b/.test(redrawList),
  `the redraw list is [${redrawList}]`);
ok("5b", "and each redraw is guarded, so a failing panel cannot leave somebody stuck in the wrong language",
  /try \{ redraw\(\); \} catch/.test(page));
ok("5c", "it happens AFTER applyStaticText, or the static text would just overwrite it again",
  page.indexOf("applyStaticText();\n  // applyStaticText only rewrites") <
    page.indexOf("for (const redraw of ["));
ok("5d", "CANARY: 5a really reads the list, so emptying it turns 5a red",
  !(/\brenderFollowUps\b/.test("") && /\brenderAttention\b/.test("")));

console.log("\n6. CANARIES");
ok("6a", "CANARY: checking the master switch alone would not have caught this -- 1c reads the RULES",
  !"const anyKindOn = !!s.enabled;".includes("FOLLOW_UP_KIND_DEFS.some"));
ok("6b", "CANARY: 2a is anchored to the condition, so reverting the empty message to a constant fails it",
  !"previewEmpty.textContent = tr('fuPreviewEmptyMsg');".includes("!anyKindOn"));
ok("6c", "CANARY: the real page defines FOLLOW_UP_KIND_DEFS, so 1c is not matching a name that does not exist",
  page.includes("FOLLOW_UP_KIND_DEFS") && count("FOLLOW_UP_KIND_DEFS") >= 3);

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
