// A SANDBOX COMPANY HAS TO SAY SO ON SCREEN -- in the admin console and in
// the office itself.
//
// supabase_r42_product_key_test_and_real.sql added companies.is_sandbox and
// said of it, in its own comment: "a label only until the mail path, the
// Stripe path and the office filter read it". Those first two are now closed
// -- refuse_sandbox_real_world() keeps a mailbox and a card connection off a
// sandbox company, and the twelve transactional mail functions refuse one --
// but nothing on any screen said which kind of company you were standing in.
// Two identical-looking offices, the same data, no label. That is how a test
// quote gets approved as a real one.
//
// The visible part has a failure mode the invisible part does not: it can be
// WRONG QUIETLY. A read that fails must leave the answer unknown, never
// "false" -- printing a sandbox company as an ordinary one is the exact
// mistake the badge exists to prevent, and it would look like a clean page.
// So every check here is paired with a planted failure, and the ones that
// matter run the REAL code lifted out of the shipped pages rather than a
// reimplementation that could drift from it.
//
// Run:
//   node tests/a156-a-sandbox-says-so-on-screen.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const adminSrc = readFileSync("website/admin.html", "utf8");
const dashSrc = readFileSync("website/dashboard.html", "utf8");

// Comments stripped before any "must not contain" check. A check that matches
// its own explanatory comment proves nothing, and this codebase has reported
// a FALSE failure on correct code that way (MEMORY.md, "My check matched my
// own comment").
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "")
  .replace(/(\S[ \t]+)\/\/[^\n'"`]*$/gm, "$1");

// ===========================================================================
// 1. THE ADMIN LIST'S FLAG MERGE, RUN FOR REAL
//
// admin_companies() does not return is_sandbox, so the list reads the column
// separately and stamps it on each row. Three things can go wrong and only
// one of them is loud.
// ===========================================================================

/** Lift the real merge out of admin.html's loadAll() and make it callable. */
function grabMerge(src) {
  const needle = "const ids = clients.map(c => c.id).filter(Boolean);";
  const at = src.indexOf(needle);
  if (at < 0) throw new Error("the sandbox flag merge is not in admin.html at all");
  const tryAt = src.lastIndexOf("try {", at);
  const tail = "} catch (e) { console.warn('sandbox flags unread', e); }";
  const endAt = src.indexOf(tail, at);
  if (tryAt < 0 || endAt < 0) throw new Error("could not bound the merge block");
  return src.slice(tryAt, endAt + tail.length);
}

const MERGE = grabMerge(adminSrc);

/** The fake PostgREST. Records every batch it was asked for. */
function makeDb({ failOnCall = 0 } = {}) {
  const asked = [];
  const db = {
    asked,
    from: (table) => ({
      select: (cols) => ({
        in: (col, vals) => {
          asked.push({ table, cols, col, vals: vals.slice() });
          if (failOnCall && asked.length === failOnCall) {
            return Promise.resolve({ data: null, error: { message: "permission denied" } });
          }
          // withheld ids come back ABSENT, with no error -- which is exactly
          // what an RLS policy does to a row it excludes.
          return Promise.resolve({
            data: vals.filter((id) => !db.withheld.has(id))
                      .map((id) => ({ id, is_sandbox: db.sandboxIds.has(id) })),
            error: null,
          });
        },
      }),
    }),
    sandboxIds: new Set(),
    withheld: new Set(),
  };
  return db;
}

async function runMerge(body, clients, db) {
  const warnings = [];
  const fn = new Function("clients", "db", "console",
    "return (async () => {\n" + body + "\n})();");
  await fn(clients, db, { warn: (...a) => warnings.push(a.map(String).join(" ")) });
  return { clients, warnings };
}

test("a sandbox company's row is stamped true and an ordinary one false", async () => {
  const db = makeDb();
  db.sandboxIds.add("co-sandbox");
  const clients = [{ id: "co-real" }, { id: "co-sandbox" }, { id: "co-other" }];
  await runMerge(MERGE, clients, db);
  assert.equal(clients[1].is_sandbox, true, "the sandbox company must be marked");
  assert.equal(clients[0].is_sandbox, false);
  assert.equal(clients[2].is_sandbox, false);
});

test("THE THOUSAND-ROW CAP: the flags are asked for in batches, by id, never as one bare select", async () => {
  const db = makeDb();
  const clients = Array.from({ length: 1450 }, (_, i) => ({ id: "co-" + i }));
  db.sandboxIds.add("co-1449");          // the LAST row, past any single page
  await runMerge(MERGE, clients, db);

  // Every call must be an .in() on a bounded list -- makeDb has no other way
  // to be called, so reaching this line at all means nothing read the table
  // unpaged. What is proven here is that the batches COVER every row.
  const askedFor = new Set(db.asked.flatMap((a) => a.vals));
  assert.equal(askedFor.size, 1450, "every company's id must be asked for");
  assert.ok(db.asked.length >= 2, `expected several batches, got ${db.asked.length}`);
  for (const a of db.asked) {
    assert.ok(a.vals.length <= 1000, `a batch of ${a.vals.length} is back inside the cap`);
  }
  assert.equal(clients[1449].is_sandbox, true,
    "the sandbox company in the last batch must still be marked");
});

test("A FAILED READ LEAVES THE FLAG UNKNOWN, NOT FALSE", async () => {
  const db = makeDb({ failOnCall: 1 });
  db.sandboxIds.add("co-sandbox");
  const clients = [{ id: "co-real" }, { id: "co-sandbox" }];
  const { warnings } = await runMerge(MERGE, clients, db);
  for (const c of clients) {
    assert.ok(!("is_sandbox" in c),
      `${c.id} was stamped ${JSON.stringify(c.is_sandbox)}; a company nobody could read must stay unknown`);
  }
  assert.ok(warnings.some((w) => /sandbox flags unread/.test(w)),
    "and it has to say so somewhere, not fail silently");
});

test("a failure PART WAY THROUGH stamps nothing, so no row claims to be ordinary", async () => {
  const db = makeDb({ failOnCall: 2 });
  const clients = Array.from({ length: 450 }, (_, i) => ({ id: "co-" + i }));
  db.sandboxIds.add("co-400");
  await runMerge(MERGE, clients, db);
  const stamped = clients.filter((c) => "is_sandbox" in c);
  assert.equal(stamped.length, 0,
    `${stamped.length} rows kept a flag from a partial read; the first batch succeeded, so a ` +
    `naive merge would print 200 companies as definitely-not-sandbox on the strength of half an answer`);
});

test("A WITHHELD ROW IS SAID OUT LOUD, because no error ever arrives for one", async () => {
  // The policy behind this read is is_platform_admin(), which includes
  // admin_second_factor_ok(). A stale second factor withholds EVERY row and
  // reports no error -- so an admin whose MFA quietly expired would see a list
  // with no badges on it and conclude there are no sandbox companies.
  const db = makeDb();
  db.sandboxIds.add("co-sandbox");
  db.withheld.add("co-sandbox").add("co-real");
  const clients = [{ id: "co-real" }, { id: "co-sandbox" }, { id: "co-seen" }];
  const { warnings } = await runMerge(MERGE, clients, db);

  assert.ok(warnings.some((w) => /1 of 3 companies answered/.test(w)),
    `expected a count in the warning, got: ${JSON.stringify(warnings)}`);
  assert.ok(!("is_sandbox" in clients[1]),
    "a withheld company must stay unknown, never false");
  assert.equal(clients[2].is_sandbox, false,
    "and the one that did answer is still stamped");
});

test("CANARY: dropping that warning is caught", async () => {
  // admin.html is CRLF, so this slice carries carriage returns. A bare
  // newline in the pattern matched nothing, and the canary then reported a
  // failure that was entirely its own.
  const deaf = MERGE.replace(/if \(flagsComplete && flags\.size < ids\.length\) \{[\s\S]*?\r?\n {4}\}\r?\n/, "");
  assert.notEqual(deaf, MERGE, "the plant must remove something");
  const db = makeDb();
  db.withheld.add("co-a");
  const { warnings } = await runMerge(deaf, [{ id: "co-a" }, { id: "co-b" }], db);
  assert.ok(!warnings.some((w) => /companies answered/.test(w)),
    "the check above cannot tell a counted warning from no warning at all");
});

test("PLANTED FAILURE: the obvious version of this merge fails the checks above", async () => {
  // One bare select, and the flag defaulted to false -- which is how anybody
  // would write it first, and what the four tests above exist to forbid.
  const naive = `
    try {
      const sb = await db.from('companies').select('id, is_sandbox');
      const flags = new Map((sb.data || []).map(r => [r.id, r.is_sandbox === true]));
      for (const c of clients) c.is_sandbox = flags.get(c.id) === true;
    } catch (e) { console.warn('sandbox flags unread', e); }`;
  assert.notEqual(stripComments(naive).trim(), stripComments(MERGE).trim(),
    "the plant must actually differ from what ships");

  // (a) It asks for no batches at all, so the thousand-row check sees it.
  const db = makeDb();
  db.sandboxIds.add("co-1449");
  const many = Array.from({ length: 1450 }, (_, i) => ({ id: "co-" + i }));
  await runMerge(naive, many, db);
  assert.equal(db.asked.length, 0,
    "sanity: the plant never pages, so no batch reaches the fake");
  assert.notEqual(new Set(db.asked.flatMap((a) => a.vals)).size, 1450,
    "the thousand-row check cannot tell a paged read from an unpaged one");

  // (b) And it answers FALSE about a company it never managed to read, which
  // is the quiet wrongness the whole feature exists to avoid.
  assert.equal(many[1449].is_sandbox, false,
    "the plant calls a sandbox company ordinary, and the unknown-not-false check sees that");

  const db2 = {
    asked: [],
    from: () => ({ select: () => Promise.resolve({ data: null, error: { message: "denied" } }) }),
  };
  const afterFailure = [{ id: "co-sandbox" }];
  await runMerge(naive, afterFailure, db2);
  assert.equal(afterFailure[0].is_sandbox, false,
    "and it does the same after an outright error");
  assert.ok("is_sandbox" in afterFailure[0],
    "which is what the real merge must never do -- proven in the two tests above");
});

// ===========================================================================
// 2. THE BADGE AND THE DIALOG
// ===========================================================================

const adminCode = stripComments(adminSrc);

test("the row badge appears only when the answer is exactly true", () => {
  assert.match(adminCode, /\$\{c\.is_sandbox === true \?/,
    "the badge must key off === true; `c.is_sandbox ?` would badge a row whose flag never arrived");
  assert.match(adminCode, />SANDBOX<\/span>/, "and there must be a badge to show");
});

test("CANARY: a truthy badge test is caught", () => {
  const loosened = adminCode.replace("${c.is_sandbox === true ?", "${c.is_sandbox ?");
  assert.notEqual(loosened, adminCode, "the plant must change something");
  assert.doesNotMatch(loosened, /\$\{c\.is_sandbox === true \?/,
    "the check above cannot tell an exact test from a truthy one");
});

test("the Manage dialog shows the line only for a sandbox, and starts hidden", () => {
  assert.match(adminSrc, /id="e_sandboxRow"/, "the dialog needs the row");
  assert.match(adminCode, /\$\('e_sandboxRow'\)\.style\.display = 'none';/,
    "it must start hidden, so a company read after a failure shows nothing");
  assert.match(adminCode, /editing\.is_sandbox = data\?\.is_sandbox === true;/,
    "and be set from an exactly-true read");
  assert.match(adminCode, /select\('pass_card_fee, is_sandbox'\)/,
    "read alongside the other column admin_companies() does not return");
});

test("NOTHING IN THE ADMIN CONSOLE CAN WRITE is_sandbox", () => {
  // The flag is what refuse_sandbox_real_world() keys off. A control here
  // would be a way to make a test company start mailing real people by
  // misclick -- and r42 made the column unwritable by any client anyway, so a
  // control would also just fail. Reading it is the whole feature.
  const writes = adminCode.match(/is_sandbox\s*:/g) || [];
  assert.equal(writes.length, 0,
    `admin.html has ${writes.length} object-literal is_sandbox key(s); it must only ever read the column`);
  assert.doesNotMatch(adminCode, /id="e_sandbox(?:Box|Check|Toggle)"/,
    "and no input bound to it");
});

test("CANARY: an is_sandbox write planted in the admin console is caught", () => {
  const planted = adminCode.replace("admin_notes: $('e_notes').value",
    "admin_notes: $('e_notes').value, is_sandbox: true");
  assert.notEqual(planted, adminCode, "the plant must change something");
  assert.ok((planted.match(/is_sandbox\s*:/g) || []).length > 0,
    "the no-writes check cannot see a write at all");
});

// ===========================================================================
// 3. THE OFFICE STRIP
//
// The dev office's REFUSAL is tested by
// tests/a155-dev-office-opens-only-for-a-sandbox.test.mjs. This is the other
// half: the LIVE office, where the flag is a label and must never become a
// gate.
// ===========================================================================

const dashCode = stripComments(dashSrc);

test("the office has a sandbox strip of its own, separate from the role strip", () => {
  assert.match(dashSrc, /id="sandboxStrip"/, "the element has to exist");
  assert.match(dashCode, /function showSandboxStrip\(\)\{/);
  assert.match(dashCode, /tr\('sandboxStripNote'\)/,
    "its words go through tr(), like every other strip on this page");
  // Its own element, because a crew member in a sandbox has to be told both
  // things and showRoleStrip() overwrites one slot.
  assert.doesNotMatch(
    dashCode.slice(dashCode.indexOf("function showSandboxStrip"),
      dashCode.indexOf("function hideRoleStrip")),
    /roleStrip/,
    "the sandbox strip must not write into the role strip's element");
});

test("the strip is worded in every language the office speaks", () => {
  const n = (dashSrc.match(/sandboxStripNote:/g) || []).length;
  const dicts = (dashSrc.match(/^  (?:en|es|fr): \{$/gm) || []).length;
  assert.equal(dicts, 3, "this page has three dictionaries");
  assert.equal(n, dicts, `${n} of ${dicts} dictionaries define the strip's text`);
});

test("THE LIVE OFFICE NEVER REFUSES ON THIS READ", () => {
  // Grab the label block: from its own `if(sandboxCompany === null` to the
  // line that shows the strip.
  const from = dashCode.indexOf("if(sandboxCompany === null");
  assert.ok(from > 0, "the label block is not in dashboard.html");
  const to = dashCode.indexOf("if(sandboxCompany === true) showSandboxStrip();", from);
  assert.ok(to > from, "the label block does not end where expected");
  const block = dashCode.slice(from, to);

  assert.doesNotMatch(block, /profile\s*=\s*null/,
    "a failed label read must not clear the profile -- that is the dev office's gate, not this");
  assert.doesNotMatch(block, /\breturn;/,
    "and must not abandon the sign-in; a blip must not lock a real business out of its own office");
  assert.match(block, /console\.warn\(/, "it says so instead");
  assert.match(block, /sbLabel\.is_sandbox===true/,
    "and answers exactly-true, so a missing column reads false rather than true");
});

test("the strip shows only when the answer is true, never when it is unknown", () => {
  assert.match(dashCode, /let sandboxCompany = null;/,
    "unknown has to be its own state, distinct from false");
  assert.match(dashCode, /if\(sandboxCompany === true\) showSandboxStrip\(\);/,
    "=== true, so null never shows the strip");
});

test("CANARY: a strip that shows on anything truthy is caught", () => {
  const loosened = dashCode.replace("if(sandboxCompany === true) showSandboxStrip();",
    "if(sandboxCompany) showSandboxStrip();");
  assert.notEqual(loosened, dashCode, "the plant must change something");
  assert.doesNotMatch(loosened, /if\(sandboxCompany === true\) showSandboxStrip\(\);/,
    "the check above cannot distinguish exactly-true from truthy");
});

test("CANARY: a refusal planted into the live label path is caught", () => {
  const from = dashCode.indexOf("if(sandboxCompany === null");
  const to = dashCode.indexOf("if(sandboxCompany === true) showSandboxStrip();", from);
  const planted = dashCode.slice(from, to)
    .replace("if(sbLabelErr) console.warn", "if(sbLabelErr) { profile=null; return; }\n    if(false) console.warn");
  assert.match(planted, /profile=null/,
    "the no-refusal check cannot see a refusal that was planted in this block");
});

test("the dev office's gate records the flag only AFTER its refusal", () => {
  // If `sandboxCompany = true` sat before the refusal, a live company in the
  // dev office would be refused and still have been recorded as a sandbox --
  // and the strip is driven by that same variable.
  const gateAt = dashCode.indexOf("dev office refused a non-sandbox company");
  const recordAt = dashCode.indexOf("sandboxCompany = true;");
  assert.ok(gateAt > 0 && recordAt > 0, "both halves must be present");
  assert.ok(recordAt > gateAt,
    "the recording must come after the refusal returns, or a refused company is marked a sandbox");
});
