// a84: THE OFFICE SHELL IS WIRED, NOT JUST PRESENT.
//
// Everything added to the office header and dashboard in the past day is a
// control that must DO something: the search box, + New, the account menu, the
// grouped navigation, the job views, the briefing rows, the grouped metrics.
//
// This file exists because of SideTypesCard, which was written, tested, and
// mounted on no screen for days while its test passed -- the test read the
// component's own text and never asked whether anything rendered it. A control
// that is not reached is not a feature, and the only thing that tells the two
// apart is a check that looks at the CALL SITE.
//
// Static, because the office page cannot be driven headlessly without a login.
// So these prove wiring, not behaviour, and say so: section 6 is the canary set
// that proves each check can fail.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Overridable so the checks can be MUTATION-TESTED. Section 6 canaries are
// string literals: they prove the comparison works, not that the check is
// pointed at anything real. tests/a84-mutate.sh breaks a COPY of the page one
// way at a time and asserts the matching check goes red. A check nobody has
// ever watched fail is a check nobody has tested.
const PAGE = process.env.A84_PAGE || join(ROOT, "website/dashboard.html");
const page = readFileSync(PAGE, "utf8");

let passed = 0, failed = 0;
const ok = (id, what, cond, detail) => {
  if (cond) { passed++; console.log(`  ok    ${id} ${what}`); }
  else { failed++; console.log(`  FAIL  ${id} ${what}${detail ? " -- " + detail : ""}`); }
};
const has = (s) => page.includes(s);
const count = (s) => page.split(s).length - 1;

console.log("\n1. THE HEADER CONTROLS EXIST AND ARE HIDDEN UNTIL SIGN-IN");
// They were on the sign-in screen: a search over nothing, a create menu that
// could create nothing, an account button with no account. Found by opening the
// page at phone width, which is the only reason this check exists.
for (const id of ["osearchBox", "newBox", "acctBox"]) {
  ok(`1-${id}`, `${id} starts hidden, so the signed-out page is right on the FIRST paint`,
    has(`id="${id}" style="display:none"`));
}
ok("1d", "and each is revealed by script once somebody is signed in",
  count("$('osearchBox').style.display = ''") >= 1 &&
  count("$('acctBox').style.display = ''") >= 1 &&
  count("$('newBox').style.display = ''") >= 1);
// CORRECTED 5 Oct 2026. This asserted all three controls appear on all three
// sign-in paths, which was my own mistake encoded as a rule. Two of the three
// paths are PARTIAL sign-ins -- somebody authenticated with no company at all
// (the "One last step" panel), and the blocked/billing screen with every tab
// hidden behind it. On both, Search has nothing to search and + New has
// nothing to create, so revealing them breaks the same "a visible control
// either works or is not there" rule this file exists to enforce.
//
// The account menu is different and DOES belong on all three: the sign-out
// button lives inside it, and being able to leave those screens is the whole
// reason it is revealed that early.
ok("1e", "the account menu is revealed on EVERY path, because sign out lives in it and those screens need a way out",
  count("$('acctBox').style.display = ''") >= 3);
ok("1f", "Search and + New are revealed ONLY on the fully-signed-in path -- not over a company that does not exist yet, nor behind a billing block",
  count("$('osearchBox').style.display = ''") === 1 &&
  count("$('newBox').style.display = ''") === 1,
  `search ${count("$('osearchBox').style.display = ''")}, new ${count("$('newBox').style.display = ''")}`);

console.log("\n2. SEARCH REACHES THE DATABASE AND OPENS REAL RECORDS");
ok("2a", "the box calls search_office, the function that actually exists",
  has("db.rpc('search_office'"));
ok("2b", "a result opens through the page's OWN doors (switchTab/showJob/openMailThread), not a second navigation path that could drift from them",
  has("function openSearchResult(") && has("openSearchResult(") && has("showJob(job.id)") && has("openMailThread(r.id)"));
ok("2c", "a slower earlier request cannot overwrite a newer one's results",
  has("if (seq !== osearchSeq) return"));
ok("2d", "it is a real combobox, not a div that happens to be clickable",
  has('role="combobox"') && has('role="listbox"') && has('role="option"'));

console.log("\n3. + NEW ONLY OFFERS WHAT THIS OFFICE CAN ACTUALLY CREATE");
ok("3a", "every item defers to the control that already exists rather than carrying its own copy",
  has("$('newJob').click()") && has("$('newEmp').click()") && has("openCompose({})"));
ok("3b", "and every one of those targets is really on the page",
  has('id="newJob"') && has('id="newEmp"') && has("function openCompose("));
ok("3c", "an item whose tab is hidden is hidden too, so the menu cannot offer a dead entry",
  has("function syncNewMenu("));
ok("3d", "and syncNewMenu runs after BOTH gates, because either can be the last to hide something",
  count("syncNewMenu();") >= 2);

console.log("\n4. THE NAVIGATION IS GROUPED WITHOUT ORPHANING A TAB");
{
  const navStart = page.indexOf('<div class="tabs">');
  const nav = page.slice(navStart, navStart + 6000);
  const tabs = [...nav.matchAll(/<button class="tab[^"]*" data-tab="([a-z]+)"/g)].map(m => m[1]);
  const panels = [...page.matchAll(/id="tab-([a-z]+)"/g)].map(m => m[1]);
  ok("4a", "every nav tab has the panel it shows", tabs.every(t => panels.includes(t)),
    `orphan tabs: ${tabs.filter(t => !panels.includes(t)).join(",") || "none"}`);
  ok("4b", "every panel still has a tab that reaches it -- a regroup that drops one hides a whole section with no way back",
    panels.every(p => tabs.includes(p)), `orphan panels: ${panels.filter(p => !tabs.includes(p)).join(",") || "none"}`);
  ok("4c", "no tab appears twice", new Set(tabs).size === tabs.length);
  ok("4d", "the groups exist", count('class="nav-group"') >= 6);
  // The open paren matters: without it this passed on a mutant that renamed the
  // function to syncNavGroupsDisabled, because the old name is a PREFIX of the
  // new one. And the declaration alone is not enough -- a function nobody calls
  // is the exact bug this file exists for.
  ok("4e", "a group that empties loses its heading, so a Solo plan never sees a heading over nothing",
    has("function syncNavGroups(") && count("syncNavGroups();") >= 2);
  ok("4f", "Calendar is relabelled Schedule but is STILL data-tab=cal -- the value keys switchTab, the panel id, the plan gate and the remembered tab",
    tabs.includes("cal") && has("tabCal:'Schedule'"));
}

console.log("\n5. THE DASHBOARD LEADS SOMEWHERE");
ok("5a", "money owed opens the Money owed table rather than the whole Jobs tab",
  has("tile('reports', money(owedTotal)") && has("'owed'"));
ok("5b", "and that table has the anchor it scrolls to",
  has('id="repOwedHead"'));
ok("5c", "the briefing rows are real buttons, so every one is reachable by Tab",
  has('class="brief-open brief-row'));
ok("5d", "severity is not colour alone -- the urgent dot is FILLED where a calm one is a ring",
  has(".brief-row.urgent .brief-dot{background:"));
ok("5e", "the job views filter by when, and Blocked reads blocked_at rather than a second definition that could disagree with the phone",
  has("function jobMatchesView(") && has("jobMatchesView(") && has("return !!j.blocked_at"));

console.log("\n6. CANARIES -- each proves the check above it can fail");
ok("6a", "CANARY: a control present but never revealed would fail 1d, because 1d looks for the reveal and not the markup",
  !'<div id="ghostBox" style="display:none"></div>'.includes("style.display = ''"));
ok("6b", "CANARY: a menu item calling a function that does not exist would fail 3b, which checks the TARGET and not the call",
  !page.includes('id="newNonexistentThing"'));
ok("6c", "CANARY: the orphan checks in 4 compare two independently gathered lists, so a tab with no panel really is detectable",
  !["dash", "jobs"].every(t => ["dash"].includes(t)));
ok("6d", "CANARY: 5a would not pass on the old tile, which pointed at Jobs",
  !"tile('jobs', money(owedTotal), esc(tr('dashTileOwed')));".includes("tile('reports'"));

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
