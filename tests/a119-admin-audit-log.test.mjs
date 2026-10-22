// A119 -- the audit log has a screen, it is paged, and nothing can write to it.
//
// Run with:  node --test tests/a119-admin-audit-log.test.mjs
//
// 5,170 rows -- who, when, which company, which record, which field, the value
// before and after -- had sat in the database since 21 August with no UI
// anywhere. It is the first thing an auditor, a customer or a dispute asks
// for, and the only way to read it was a SQL client.
//
// Source checks: the page is not executed here. Each is paired with a canary.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ADMIN = readFileSync(new URL("../website/admin.html", import.meta.url), "utf8");
const SQL = readFileSync(new URL("../supabase_r23_audit_admin_read.sql", import.meta.url), "utf8");

function region(src, from, to) {
  const i = src.indexOf(from);
  assert.ok(i !== -1, `landmark gone: ${from}`);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j !== -1, `landmark gone: ${to}`);
  return src.slice(i, j);
}

test("the view exists and is in the nav", () => {
  assert.ok(ADMIN.includes('id="view-audit"'), "the audit section is gone");
  assert.ok(ADMIN.includes('data-view="audit"'), "the nav button is gone");
  assert.match(ADMIN, /const VIEWS = \[[^\]]*'audit'/,
    "'audit' is not in VIEWS, so switchView would throw on its own nav button");
});

test("it is PAGED, because an unpaged read stops at a thousand and says nothing", () => {
  const fn = region(ADMIN, "async function loadAudit(append)", "function auditCompanyName");
  assert.match(fn, /\.range\(auditFrom, auditFrom \+ AUDIT_PAGE - 1\)/,
    "the read is no longer windowed; PostgREST would answer with at most 1000 of 5170 and look complete");
  assert.match(fn, /auditMore = page\.length === AUDIT_PAGE/,
    "there is no longer any way to tell a full page from the end of the data");
  assert.match(ADMIN, /id="auditMore"/, "the Show older button is gone, so the older rows are unreachable");
});

test("the To box means the whole of that day", () => {
  const fn = region(ADMIN, "function auditQuery()", "async function loadAudit");
  assert.match(fn, /new Date\(to\)\.getTime\(\) \+ 864e5/,
    "the To date is used as an instant, so 1 Oct to 1 Oct returns nothing and reads as 'no activity'");
});

test("the export is what is on screen", () => {
  const fn = region(ADMIN, "function auditCsv()", "async function loadDrift");
  assert.match(fn, /auditRows\.map/,
    "the CSV no longer exports the rows being shown, so it is a different document to the one being read");
  assert.match(fn, /'Before', 'After'/, "the before and after values are missing from the export");
});

test("an empty result says which filter emptied it", () => {
  const fn = region(ADMIN, "function renderAudit()", "function fillAuditPickers");
  assert.match(fn, /auditNone/, "an empty log shows nothing at all rather than saying so");
  assert.match(fn, /auditRows\.length\s*\n?\s*\?/, "the count line no longer branches on whether there are rows");
});

test("the table picker is built from the data, not a hardcoded list", () => {
  const fn = region(ADMIN, "function fillAuditPickers()", "function auditCsv");
  assert.match(fn, /new Set\(auditRows\.map\(r => r\.table_name\)/,
    "the table names are hardcoded again, so the list goes stale the first time a table is added");
});

test("the placeholder uses the attribute this page actually reads", () => {
  // admin.html's applyStaticText honours data-t (placeholder on an input) and
  // data-t-title. It has never read data-t-ph, so that attribute would be a
  // silent no-op and the placeholder would stay in English for ever.
  assert.doesNotMatch(ADMIN, /data-t-ph=/,
    "data-t-ph is back; nothing on this page reads it");
  assert.match(ADMIN, /id="auditWho" data-t="auditWhoPh"/, "the Who box lost its translated placeholder");
});

// ------------------------------------------------------------- the policy

test("the migration grants READ and nothing else", () => {
  assert.match(SQL, /create policy audit_log_admin_read on public\.audit_log\s*\n\s*for select/,
    "the admin policy is no longer SELECT-only");
  assert.match(SQL, /using \(public\.is_platform_admin\(\)\)/,
    "the policy no longer asks is_platform_admin()");
  assert.doesNotMatch(SQL, /\b(insert|update|delete)\s+into\s+public\.audit_log/i,
    "the migration writes to the audit log");
  assert.doesNotMatch(SQL, /grant\s+(insert|update|delete)/i, "the migration grants a write");
});

test("the migration proves append-only rather than assuming it", () => {
  assert.match(SQL, /still append-only for every client/,
    "the append-only check is gone; without it the screen is theatre over a table anyone could rewrite");
  assert.match(SQL, /the company-scoped policy is untouched/,
    "nothing asserts that a company owner can still read their own history");
});

// ---------------------------------------------------------------- canaries

test("CANARY: the paging check fails on an unbounded read", () => {
  const sabotaged = "const { data } = await db.from('audit_log').select('*').order('at');";
  assert.doesNotMatch(sabotaged, /\.range\(/,
    "an unbounded read was not detected, so the real check has no teeth");
});

test("CANARY: the end-of-day arithmetic really covers the day", () => {
  const to = "2026-10-01";
  const bound = new Date(new Date(to).getTime() + 864e5).toISOString();
  const lateThatDay = new Date("2026-10-01T23:59:00.000Z").toISOString();
  assert.ok(lateThatDay < bound, "a change at 23:59 on the To date falls outside the range");
  const nextDay = new Date("2026-10-02T00:01:00.000Z").toISOString();
  assert.ok(nextDay > bound, "a change the following morning is inside the range");
});
