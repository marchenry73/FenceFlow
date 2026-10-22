// A122 -- "is this company still using FenceFlow" is answered, and answered
// from three counts rather than one.
//
// Run with:  node --test tests/a122-company-health.test.mjs
//
// The console's company list showed people and jobs EVER. A total never goes
// down, so a company that stopped in August read exactly like one that used it
// this morning, and the only question an operator has about a customer had no
// answer anywhere in the product.
//
// admin_companies() now returns active_people_30d, jobs_30d and quotes_30d,
// and healthOf() turns them into one word. THREE counts, because they fail
// differently: last_seen_at is written by the phone, so a company that only
// opens the office website reads as nobody-seen -- a people-only rule would
// call it dormant while it quoted every day. The planted failures below are
// that exact case.
//
// The rule is arithmetic, so this file EXECUTES it rather than grepping for
// it. tr() is stubbed to return the key, so nothing here compares against
// display text: the assertions are on the state and on the pill class.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ADMIN = readFileSync(new URL("../website/admin.html", import.meta.url), "utf8");

function region(src, from, to) {
  const i = src.indexOf(from);
  assert.ok(i !== -1, `landmark gone: ${from}`);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j !== -1, `landmark gone: ${to}`);
  return src.slice(i, j);
}

const SRC = region(ADMIN, "function healthOf(c) {", "function statusPill(c) {");

// eslint-disable-next-line no-new-func
const { healthOf, healthRank, healthCell } = new Function(`
  const tr = (k) => k;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  ${SRC}
  return { healthOf, healthRank, healthCell };
`)();

// A row as admin_companies() hands it back. joined_at set, so the company has
// actually started; the three counts are what each case varies.
const row = (over) => Object.assign({
  id: "c1", name: "Co", joined_at: "2026-01-01T00:00:00Z",
  active_people_30d: 0, jobs_30d: 0, quotes_30d: 0
}, over);

test("a company that created a job in the last 30 days is active", () => {
  assert.equal(healthOf(row({ active_people_30d: 2, jobs_30d: 4, quotes_30d: 4 })).state, "active");
});

test("THE CASE A PEOPLE-ONLY RULE GETS WRONG: office-only work still counts", () => {
  // Nobody on a phone -- active_people_30d is 0, because last_seen_at is
  // written by the app -- but four quotes went out from the office website.
  // This company is the most active kind there is.
  const h = healthOf(row({ active_people_30d: 0, jobs_30d: 0, quotes_30d: 4 }));
  assert.equal(h.state, "active",
    "an office-only company is being called dormant while it quotes every day");
});

test("somebody opened it but built nothing is quiet, not active and not dormant", () => {
  assert.equal(healthOf(row({ active_people_30d: 1 })).state, "quiet");
});

test("nobody opened it at all is dormant", () => {
  assert.equal(healthOf(row()).state, "dormant");
});

test("invited and never signed in is not a verdict about usage", () => {
  const h = healthOf(row({ joined_at: null }));
  assert.equal(h.state, "notyet");
  assert.doesNotMatch(healthCell(row({ joined_at: null })), /pill bad/,
    "a company that has never started is painted red for it");
});

test("a row without the columns says nothing at all", () => {
  // The database has not had the health patch applied. Printing 'dormant'
  // here would be a red pill on every company in the list on the strength of
  // data this page never received.
  const bare = { id: "c1", name: "Co", joined_at: "2026-01-01T00:00:00Z" };
  assert.equal(healthOf(bare).state, "absent");
  assert.equal(healthCell(bare), "", "the cell invents a verdict from absent columns");
});

test("the three counts are printed under the pill, so the rule can be checked", () => {
  const cell = healthCell(row({ active_people_30d: 2, jobs_30d: 4, quotes_30d: 4 }));
  assert.match(cell, /pill ok/, "an active company no longer reads as the good state");
  assert.match(cell, /healthDetail/, "the counts behind the verdict are no longer shown");
});

test("dormant sorts ahead of active, and neither non-verdict outranks either", () => {
  const rank = {
    dormant: healthRank(row()),
    quiet: healthRank(row({ active_people_30d: 1 })),
    active: healthRank(row({ jobs_30d: 1 })),
    notyet: healthRank(row({ joined_at: null })),
    absent: healthRank({ id: "c1", joined_at: "2026-01-01T00:00:00Z" })
  };
  assert.ok(rank.dormant < rank.quiet && rank.quiet < rank.active,
    "clicking the header no longer brings the companies that stopped to the top");
  assert.ok(rank.notyet > rank.active && rank.absent > rank.active,
    "rows that carry no verdict are mixed in among the ones that do");
});

// ------------------------------------------------------------ wired in ----

test("the column exists and is sortable", () => {
  assert.match(ADMIN, /<th data-sort="health" data-t="colHealth">/,
    "the header is gone, so healthCell is computed for a column nobody sees");
  const cmp = region(ADMIN, "function compareClients(a, b) {", "function renderCompaniesTable()");
  assert.match(cmp, /sortKey === 'health'/,
    "health has no rank in the comparator, so a[sortKey] is undefined for every row and the click does nothing");
});

test("the cell is rendered on the row", () => {
  const rows = region(ADMIN, "$('rows').innerHTML = filtered.map", "document.querySelectorAll('[data-invite]')");
  assert.match(rows, /healthCell\(c\)/, "the column header has no cell under it");
});

test("the CSV carries the counts, not just the verdict", () => {
  const fn = region(ADMIN, "function exportCsv() {", "const csv = [head");
  for (const col of ["UsingIt", "PeopleSeen30d", "JobsCreated30d", "QuotesSent30d"]) {
    assert.ok(fn.includes(col), `${col} is missing from the export`);
  }
  assert.match(fn, /known \? h\.people : ''/,
    "an unmeasured count exports as 0, which reads as a measurement of zero");
});

test("the headline tile goes blank rather than zero when nothing is known", () => {
  const fn = region(ADMIN, "const health = clients.map(healthOf)", "$('stats').innerHTML");
  assert.match(fn, /healthKnown/, "the tile has no absent state");
  assert.match(ADMIN, /healthKnown \? usingIt \+ floorMark : '—'/,
    "a console whose database lacks the columns reports a bold 0 companies using FenceFlow");
});

test("the new words exist in all three languages", () => {
  for (const k of ["colHealth", "healthActive", "healthQuiet", "healthDormant",
                   "healthDetail", "healthRuleTitle", "healthNotYetTitle",
                   "kpiUsingIt", "kpiDormantNote"]) {
    const n = ADMIN.split(k + ":").length - 1;
    assert.equal(n, 3, `${k} appears in ${n} locales, expected 3`);
  }
});

// ---------------------------------------------------------------- canaries

test("CANARY: a people-only rule really would get the office-only company wrong", () => {
  // Proves the test above is discriminating rather than agreeing by accident.
  const officeOnly = row({ active_people_30d: 0, jobs_30d: 0, quotes_30d: 4 });
  const peopleOnlyRule = (c) => (Number(c.active_people_30d || 0) > 0 ? "active" : "dormant");
  assert.equal(peopleOnlyRule(officeOnly), "dormant",
    "the cheap rule now agrees with the real one, so that assertion proves nothing");
  assert.equal(healthOf(officeOnly).state, "active");
});

test("CANARY: treating absent columns as zeros really would paint it red", () => {
  const bare = { id: "c1", name: "Co", joined_at: "2026-01-01T00:00:00Z" };
  const naive = (c) => (Number(c.jobs_30d || 0) || Number(c.quotes_30d || 0)
    ? "active" : Number(c.active_people_30d || 0) ? "quiet" : "dormant");
  assert.equal(naive(bare), "dormant",
    "the naive reading no longer differs, so the absent state is guarding nothing");
  assert.equal(healthOf(bare).state, "absent");
});

test("CANARY: the rule really was extracted and executed, not matched as text", () => {
  assert.ok(SRC.length > 1200, `only ${SRC.length} chars of source lifted; the region landmarks have moved`);
  assert.equal(typeof healthOf, "function");
  assert.throws(() => healthOf(row({ joined_at: "x" })).nope.nope,
    "healthOf returned something that is not an object, so every state above is undefined === undefined");
});
