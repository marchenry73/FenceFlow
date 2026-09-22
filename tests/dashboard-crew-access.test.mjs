// Crew beyond the lead, granted access, and access requests in the office
// console (website/dashboard.html, Track E of the crew-access work; the SQL is
// supabase_crew_job_scope.sql).
//
// These run the real functions lifted out of dashboard.html -- the same
// grab()/new Function() idiom as tests/dashboard-alert-severity.test.mjs --
// called the way the page calls them, and every one asserts on what comes
// back. Each group carries a PLANTED FAILURE: the check run against a broken
// version, which must fail, so a check that cannot fail is caught here and
// not in production.
//
// The two error objects below are what PostgREST on the live project
// actually answered on 2026-09-21 for a table and a function that
// supabase_crew_job_scope.sql has not created yet -- not a guess at the shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("website/dashboard.html", "utf8");

const grab = (name) => {
  let start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("not found: " + name);
  if (src.slice(start - 6, start) === "async ") start -= 6;
  let i = src.indexOf("{", src.indexOf(")", start)), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
};
const grabConst = (name) => {
  const start = src.indexOf("const " + name + " =");
  if (start < 0) throw new Error("not found: " + name);
  return src.slice(start, src.indexOf(";\n", start) + 1);
};

const lib = new Function(`
  ${grab("isNotDeployedYet")}
  ${grab("openAssignmentsFor")}
  ${grab("jobHasCrew")}
  ${grab("jobCrewList")}
  ${grab("employeeLoginState")}
  ${grab("assignableWorkers")}
  ${grab("accessRequestAttention")}
  return { isNotDeployedYet, openAssignmentsFor, jobHasCrew, jobCrewList,
           employeeLoginState, assignableWorkers, accessRequestAttention };
`)();

const LIVE_MISSING_TABLE = {
  code: "PGRST205", details: null,
  hint: "Perhaps you meant the table 'public.job_stage_events'",
  message: "Could not find the table 'public.job_access_requests' in the schema cache",
};
const LIVE_MISSING_FUNCTION = {
  code: "PGRST202",
  message: "Could not find the function public.set_job_crew(p_employee_sync_ids, p_job_sync_id) in the schema cache",
};

// ------------------------------------------------------- not deployed yet

test("a table or function the SQL has not created yet reads as 'not deployed', silently", () => {
  assert.equal(lib.isNotDeployedYet(LIVE_MISSING_TABLE), true);
  assert.equal(lib.isNotDeployedYet(LIVE_MISSING_FUNCTION), true);
  // Older PostgREST passed Postgres's own code through.
  assert.equal(lib.isNotDeployedYet({ code: "42P01", message: 'relation "public.job_assignments" does not exist' }), true);
  // No code at all, only the words.
  assert.equal(lib.isNotDeployedYet({ message: "Could not find the table 'public.job_assignments' in the schema cache" }), true);
});

test("every other error is a real one and is never swallowed", () => {
  for (const err of [
    { code: "42703", message: "column job_assignments.kindd does not exist" },
    { code: "42883", message: "operator does not exist: uuid = text" },
    { code: "42501", message: "permission denied for table job_assignments" },
    { message: "Failed to fetch" },
  ]) assert.equal(lib.isNotDeployedYet(err), false, err.message);
  assert.equal(lib.isNotDeployedYet(null), false);
  assert.equal(lib.isNotDeployedYet(undefined), false);
});

test("PLANTED FAILURE: a loose 'does not exist' test would hide a real bug", () => {
  const loose = (err) => /does not exist/i.test(String(err?.message || ""));
  const missingColumn = { code: "42703", message: "column job_assignments.kindd does not exist" };
  assert.equal(loose(missingColumn), true, "the loose version swallows a typo'd column");
  assert.notEqual(lib.isNotDeployedYet(missingColumn), loose(missingColumn), "the real one must disagree");
});

// ------------------------------------------------------------ who is on it

const A = (o) => ({ id: "a-" + Math.random(), job_sync_id: "J1", kind: "CREW", ended_at: null, assigned_at: "2026-09-20T10:00:00Z", ...o });

// The rows the Needs-attention "nobody booked" rule is judged against:
// [job, assignments, expected jobHasCrew].
const CASES = [
  [{ sync_id: "J1", assigned_employee_sync_id: "E1" }, [], true, "a lead, by sync id"],
  [{ sync_id: "J1", assigned_employee_sync_id: null }, [A({ employee_sync_id: "E2" })], true, "no lead, extra crew"],
  [{ sync_id: "J1", assigned_employee_sync_id: "" }, [A({ employee_sync_id: "E2", kind: "ACCESS" })], false, "granted access is not crew"],
  [{ sync_id: "J1", assigned_employee_sync_id: null }, [A({ employee_sync_id: "E2", ended_at: "2026-09-21T00:00:00Z" })], false, "an ended row is history"],
  [{ sync_id: "J1", assigned_employee_sync_id: null }, [A({ employee_sync_id: "E2", job_sync_id: "J2" })], false, "another job's crew"],
  [{ sync_id: "J1", assigned_employee_sync_id: "  " }, [], false, "a blank lead is nobody"],
  [{ sync_id: "J1", assigned_employee_sync_id: null }, [], false, "nobody at all"],
];

test("jobHasCrew: the lead by sync id, or open extra crew -- nothing else", () => {
  for (const [job, rows, want, why] of CASES) assert.equal(lib.jobHasCrew(job, rows), want, why);
  assert.equal(lib.jobHasCrew(null, []), false);
});

test("PLANTED FAILURE: the old predicate (assigned_employee_id, which nothing writes) fails this table", () => {
  // What renderDash used to ask: "is assigned_employee_id empty?".
  const old = (job) => !!job.assigned_employee_id;
  const wrong = CASES.filter(([job, rows, want]) => old(job, rows) !== want).map((c) => c[3]);
  assert.ok(wrong.includes("a lead, by sync id"), "it said a job with a lead had nobody");
  assert.ok(wrong.includes("no lead, extra crew"));
});

test("the Needs-attention rule and the calendar ask the new helpers, not the dead column", () => {
  // Comments may name the old column to say why it went; code may not.
  const code = (s) => s.replace(/\/\/[^\n]*/g, "");
  const dash = code(grab("renderDash"));
  const rule = dash.slice(dash.indexOf("alertOn('unassigned_scheduled')"), dash.indexOf("key:'unassigned_scheduled:'"));
  assert.ok(rule.length > 0, "the rule is still there to check");
  assert.match(rule, /jobHasCrew\(j, jobAssignments\)/);
  assert.doesNotMatch(rule, /assigned_employee_id\b/);
  const cal = code(grab("renderCal"));
  assert.match(cal, /jobCrewList\(j, jobAssignments, workerBySync\)/);
  assert.doesNotMatch(cal, /assigned_employee_id\b/);
});

test("jobCrewList: lead first, then extra crew in the order they joined, nobody twice", () => {
  const people = { E1: { name: "Lead Lu" }, E2: { name: "Second Sam" }, E3: { name: "Third Tia" } };
  const lookup = (sid) => people[sid] || null;
  const rows = [
    A({ employee_sync_id: "E3", assigned_at: "2026-09-21T09:00:00Z" }),
    A({ employee_sync_id: "E2", assigned_at: "2026-09-20T09:00:00Z" }),
    A({ employee_sync_id: "E1", assigned_at: "2026-09-19T09:00:00Z" }),   // the lead, also a crew row
    A({ employee_sync_id: "E9" }),                                         // no longer on the list
    A({ employee_sync_id: "E4", kind: "ACCESS" }),
  ];
  const got = lib.jobCrewList({ sync_id: "J1", assigned_employee_sync_id: "E1" }, rows, lookup).map((e) => e.name);
  assert.deepEqual(got, ["Lead Lu", "Second Sam", "Third Tia"]);
  assert.deepEqual(lib.jobCrewList({ sync_id: "J1" }, [], lookup), []);
});

// --------------------------------------------------------------- logins

test("'no login' is said only when the row itself says so", () => {
  assert.equal(lib.employeeLoginState({ sync_id: "E1", profile_id: null }), "none");
  assert.equal(lib.employeeLoginState({ sync_id: "E1", profile_id: "p-1" }), "linked");
  // crew_roster() has no profile_id column: unknown, not "none".
  assert.equal(lib.employeeLoginState({ sync_id: "E1", name: "Rosa" }), "unknown");
  assert.equal(lib.employeeLoginState(null), "unknown");
});

test("PLANTED FAILURE: a falsy test on profile_id would badge every roster row", () => {
  const naive = (e) => (e && e.profile_id ? "linked" : "none");
  const rosterRow = { sync_id: "E1", name: "Rosa" };
  assert.equal(naive(rosterRow), "none");
  assert.notEqual(lib.employeeLoginState(rosterRow), naive(rosterRow));
});

test("assignableWorkers: the whole roster for someone without SEE_PAY, active only", () => {
  // RLS gives a non-SEE_PAY manager their own employees row and nothing else.
  const own = [{ sync_id: "E1", name: "Me", profile_id: "p-me", is_active: true }];
  const roster = [
    { sync_id: "E1", name: "Me", is_active: true },
    { sync_id: "E2", name: "Rosa", is_active: true },
    { sync_id: "E3", name: "Gone", is_active: false },
  ];
  const got = lib.assignableWorkers(own, roster);
  assert.deepEqual(got.map((e) => e.sync_id), ["E1", "E2"]);
  assert.equal(got[0].profile_id, "p-me", "a login the employees read knew about is kept");
  assert.equal(lib.employeeLoginState(got[1]), "unknown", "and nothing is invented for the rest");
  // With SEE_PAY there is no roster and the employees read is the crew.
  const all = [{ sync_id: "E1", name: "A" }, { sync_id: "E2", name: "B", is_active: false }, { name: "no id" }];
  assert.deepEqual(lib.assignableWorkers(all, []).map((e) => e.sync_id), ["E1"]);
});

test("PLANTED FAILURE: the old picker (employees only) offers a non-SEE_PAY manager one name, their own", () => {
  const own = [{ sync_id: "E1", name: "Me", profile_id: "p-me" }];
  const roster = [{ sync_id: "E1", name: "Me" }, { sync_id: "E2", name: "Rosa" }];
  const oldPicker = own.filter((e) => e.is_active !== false);
  assert.equal(oldPicker.length, 1);
  assert.notEqual(lib.assignableWorkers(own, roster).length, oldPicker.length);
});

// ------------------------------------------------------ attention items

const jobsBySync = { J1: { id: 101, sync_id: "J1", customer_name: "Hale" } };
const attention = (reqs) => lib.accessRequestAttention(reqs, (sid) => jobsBySync[sid] || null,
  (r) => "Who " + r.requested_by, (j) => j.customer_name, (who, job) => `${who} wants ${job}`, "(gone)");

test("one warn item per request still waiting, keyed for the three-hour Seen snooze", () => {
  const items = attention([
    { id: "r1", job_sync_id: "J1", requested_by: "u1", status: "PENDING", created_at: "2026-09-21T08:00:00Z" },
    { id: "r2", job_sync_id: "J1", requested_by: "u2", status: "APPROVED", created_at: "2026-09-20T08:00:00Z" },
    { id: "r3", job_sync_id: "J1", requested_by: "u3", status: "DENIED", created_at: "2026-09-20T08:00:00Z" },
    { id: "r4", job_sync_id: "J1", requested_by: "u4", status: "WITHDRAWN", created_at: "2026-09-20T08:00:00Z" },
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], { urgent: true, severity: "warn", text: "Who u1 wants Hale", id: 101, go: "",
                               key: "access_request:r1", fp: "2026-09-21T08:00:00Z" });
});

test("a request on a job not on the list opens the Crew tab instead of vanishing", () => {
  const [it] = attention([{ id: "r9", job_sync_id: "GONE", requested_by: "u1", status: "PENDING", created_at: "2026-09-21T08:00:00Z" }]);
  assert.equal(it.id, null);
  assert.equal(it.go, "crew");
  assert.equal(it.text, "Who u1 wants (gone)");
});

test("PLANTED FAILURE: dropping the status test would nag about answered requests", () => {
  const all = [{ id: "a", status: "APPROVED", job_sync_id: "J1" }, { id: "b", status: "PENDING", job_sync_id: "J1" }];
  const naive = all.map((r) => "access_request:" + r.id);
  assert.notEqual(attention(all).length, naive.length);
});

test("the daily briefing files access requests under Crews, not the Risks fallback", () => {
  const map = new Function(`${src.slice(src.indexOf("const BRIEFING_SECTION_BY_KEY ="), src.indexOf("};", src.indexOf("const BRIEFING_SECTION_BY_KEY =")) + 2)}; return BRIEFING_SECTION_BY_KEY;`)();
  const [it] = attention([{ id: "r1", job_sync_id: "J1", requested_by: "u1", status: "PENDING", created_at: "2026-09-21T08:00:00Z" }]);
  assert.equal(map[it.key.split(":")[0]], "crews");
  // PLANTED FAILURE: a key the map does not list lands in the fallback.
  assert.equal(map["access_requestt"], undefined);
});

// The page's own snooze code, fed one of these items: Seen hides it for three
// hours and it comes back while the request is still waiting.
const snooze = (seen) => new Function("localStorage", "profile", "seenAlerts", `
  ${grabConst("ALERT_SNOOZE_MS")}
  ${grabConst("ALERT_SNOOZE_SKEW_MS")}
  ${grab("seenAlertsKey")}
  ${grab("loadSeenAlerts")}
  ${grab("alertFpToken")}
  ${grab("parseSeenStamp")}
  ${grab("alertSeenUntil")}
  ${grab("isAlertSeen")}
  return { isAlertSeen };
`)({ getItem: () => null }, { id: "me" }, seen);

test("Seen on an access request snoozes it for three hours, then it is back", () => {
  const [it] = attention([{ id: "r1", job_sync_id: "J1", requested_by: "u1", status: "PENDING", created_at: "2026-09-21T08:00:00Z" }]);
  const t0 = Date.parse("2026-09-21T12:00:00Z");
  const s = snooze(new Map([[it.key, "@" + t0 + "|" + it.fp]]));
  assert.equal(s.isAlertSeen(it, t0 + 60e3), true, "hidden a minute later");
  assert.equal(s.isAlertSeen(it, t0 + 2.9 * 36e5), true, "still hidden at 2h54m");
  assert.equal(s.isAlertSeen(it, t0 + 3.1 * 36e5), false, "back after three hours");
  // A different request from the same person is a different key.
  const other = { ...it, key: "access_request:r2" };
  assert.equal(s.isAlertSeen(other, t0 + 60e3), false);
});

// ---------------------------------------------------------------- loading

// A stand-in for supabase-js: every builder method chains, and awaiting the
// builder answers whatever this table was told to answer.
const fakeDb = (answers) => {
  const calls = [];
  const builder = (table) => {
    const b = {};
    for (const m of ["select", "is", "or", "order", "range", "limit", "eq"]) b[m] = (...a) => { calls.push([table, m, ...a]); return b; };
    b.then = (ok, bad) => Promise.resolve(answers[table] ?? { data: [], error: null }).then(ok, bad);
    return b;
  };
  return {
    calls,
    from: (t) => { calls.push([t, "from"]); return builder(t); },
    rpc: (fn) => { calls.push([fn, "rpc"]); return Promise.resolve(answers["rpc:" + fn] ?? { data: [], error: null }); },
  };
};
const loader = (db, perms) => new Function("db", "hasPerm", "console", `
  let jobAssignments = [], accessRequests = [], crewRoster = [], crewAccessReady = false;
  ${grabConst("ACCESS_ANSWERED_SHOWN_MS")}
  ${grab("isNotDeployedYet")}
  ${grab("loadOpenAssignments")}
  ${grab("loadJobCrewAccess")}
  return { run: loadJobCrewAccess,
           state: () => ({ jobAssignments, accessRequests, crewRoster, crewAccessReady }) };
`)(db, (p) => perms.includes(p), { warn() {} });

test("before the SQL is applied: no error, nothing shown, nothing thrown", async () => {
  const db = fakeDb({ job_assignments: { data: null, error: LIVE_MISSING_TABLE },
                      job_access_requests: { data: null, error: LIVE_MISSING_TABLE } });
  const l = loader(db, ["SCHEDULE_AND_ASSIGN", "SEE_PAY"]);
  const res = await l.run();
  assert.equal(res.error, null, "not a load warning");
  assert.equal(l.state().crewAccessReady, false, "the new sections stay hidden");
  assert.deepEqual(l.state().jobAssignments, []);
});

test("a real error is reported, not swallowed", async () => {
  const denied = { code: "42501", message: "permission denied for table job_assignments" };
  const l = loader(fakeDb({ job_assignments: { data: null, error: denied } }), ["SCHEDULE_AND_ASSIGN", "SEE_PAY"]);
  const res = await l.run();
  assert.deepEqual(res.error, denied);
  assert.equal(l.state().crewAccessReady, false);
});

test("applied: open rows and requests arrive, and the request read is pending-or-recent", async () => {
  const db = fakeDb({
    job_assignments: { data: [{ id: "a1", job_sync_id: "J1", kind: "CREW", ended_at: null }], error: null },
    job_access_requests: { data: [{ id: "r1", status: "PENDING" }], error: null },
  });
  const l = loader(db, ["SCHEDULE_AND_ASSIGN", "SEE_PAY"]);
  assert.deepEqual(await l.run(), { error: null });
  const s = l.state();
  assert.equal(s.crewAccessReady, true);
  assert.equal(s.jobAssignments.length, 1);
  assert.equal(s.accessRequests.length, 1);
  assert.ok(db.calls.some(([t, m, v]) => t === "job_assignments" && m === "is" && v === "ended_at"), "open rows only");
  const or = db.calls.find(([t, m]) => t === "job_access_requests" && m === "or");
  assert.match(or[2], /^status\.eq\.PENDING,decided_at\.gte\."\d{4}-\d\d-\d\dT[^"]+"$/);
  assert.equal(db.calls.some(([f, m]) => f === "crew_roster" && m === "rpc"), false, "SEE_PAY already has the whole crew");
});

test("without SEE_PAY the roster is fetched, so the pickers offer the whole crew", async () => {
  const db = fakeDb({ "rpc:crew_roster": { data: [{ sync_id: "E1", name: "A" }, { sync_id: "E2", name: "B" }], error: null } });
  const l = loader(db, ["SCHEDULE_AND_ASSIGN"]);
  await l.run();
  assert.equal(l.state().crewRoster.length, 2);
});

test("someone who does not assign work asks for none of it", async () => {
  const db = fakeDb({});
  const l = loader(db, ["SEE_MONEY", "EDIT_JOBS"]);
  assert.deepEqual(await l.run(), { error: null });
  assert.equal(db.calls.length, 0);
  assert.equal(l.state().crewAccessReady, false);
});

test("PLANTED FAILURE: the fake answers what it is told, so these loading tests can fail", async () => {
  // Same run, but the fake reports a missing COLUMN: it must surface.
  const col = { code: "42703", message: "column job_access_requests.decided_att does not exist" };
  const l = loader(fakeDb({ job_access_requests: { data: null, error: col } }), ["SCHEDULE_AND_ASSIGN", "SEE_PAY"]);
  const res = await l.run();
  assert.notEqual(res.error, null);
});

// ------------------------------------------- who and when need the permission

// guard_job_assignment() refuses the whole jobs update when the lead or the
// date moves without SCHEDULE_AND_ASSIGN. showJob locks both controls for
// such a person and saveJob leaves a locked control out of its patch. The
// real saveJob runs here against stand-ins, and the patch it sends is read.
const fakeEl = (props = {}) => ({ value: "", disabled: false, title: "", ...props,
  classList: { remove() {}, add() {}, contains: () => false } });
const runSave = async ({ locked }) => {
  const els = {
    j_scheduled_date: fakeEl({ value: "2030-06-01", disabled: locked }),
    j_assigned_employee_id: fakeEl({ value: "E2", disabled: locked }),
    j_notes: fakeEl({ value: "gate code 4411" }),
    saveJob: fakeEl(), jobMsg: fakeEl(), jobOverlay: fakeEl(),
  };
  const sent = [];
  const db = { from: () => ({ update: (p) => { sent.push(p); return { eq: () => ({ select: () =>
    Promise.resolve({ data: [{ id: 9, sync_id: "s-9", updated_at: "2026-09-22T10:00:00Z" }], error: null }) }) }; } }) };
  const saveJob = new Function(
    "$", "db", "tr", "msg", "savedNote", "loadAll", "showJob", "callPriceJob", "money", "officePricingErrorMessage",
    "num", "canEdit", "J_TEXT", "J_NUM", "J_SEL", "openJob",
    grab("saveJob") + "\nreturn saveJob;"
  )((id) => els[id] || (els[id] = fakeEl()), db, (k) => k, () => {}, () => {}, async () => {}, () => {},
    async () => ({ status: 200, body: {} }), String, () => "", Number, () => true, ["notes"], [], [], { id: 9, sync_id: "s-9" });
  await saveJob();
  assert.equal(sent.length, 1, "exactly one update was sent");
  return sent[0];
};

test("a locked lead and date are left out of the save; the rest of it still goes", async () => {
  const p = await runSave({ locked: true });
  assert.equal("assigned_employee_sync_id" in p, false);
  assert.equal("scheduled_date" in p, false);
  assert.equal(p.notes, "gate code 4411", "the save itself still happened");
});

test("unlocked, both are sent -- someone who assigns work still assigns it", async () => {
  const p = await runSave({ locked: false });
  assert.equal(p.assigned_employee_sync_id, "E2");
  assert.equal(p.scheduled_date, new Date("2030-06-01T08:00:00").toISOString());
});

test("PLANTED FAILURE: the old saveJob (reads the controls whatever their state) sends both when locked", async () => {
  // The same page with the two guards taken out, run through the same harness:
  // the lock must be what keeps the keys out, or this test proves nothing.
  const real = grab("saveJob");
  const old = real.replace("if (!dateEl.disabled) {", "if (true) {").replace("if (!leadEl.disabled) patch", "patch");
  assert.notEqual(old, real, "the plant changed the function");
  const els = { j_scheduled_date: fakeEl({ value: "2030-06-01", disabled: true }), j_assigned_employee_id: fakeEl({ value: "E2", disabled: true }) };
  const sent = [];
  const db = { from: () => ({ update: (p) => { sent.push(p); return { eq: () => ({ select: () => Promise.resolve({ data: [{ id: 9 }], error: null }) }) }; } }) };
  await new Function("$", "db", "tr", "msg", "savedNote", "loadAll", "showJob", "callPriceJob", "money",
    "officePricingErrorMessage", "num", "canEdit", "J_TEXT", "J_NUM", "J_SEL", "openJob", old + "\nreturn saveJob;")(
    (id) => els[id] || (els[id] = fakeEl()), db, (k) => k, () => {}, () => {}, async () => {}, () => {},
    async () => ({ status: 200, body: {} }), String, () => "", Number, () => true, [], [], [], { id: 9, sync_id: "s-9" })();
  assert.equal("assigned_employee_sync_id" in sent[0], true, "the old one sends the lead even when locked");
});

test("showJob locks both controls for anyone who cannot assign, with the reason on hover", () => {
  const show = grab("showJob");
  assert.match(show, /const assignLocked = !\(canEdit\(\) && hasPerm\('SCHEDULE_AND_ASSIGN'\)\);/);
  assert.match(show, /\[sel, \$\('j_scheduled_date'\)\]\.forEach\(el => \{\s*el\.disabled = assignLocked;\s*el\.title = assignLocked \? tr\('jobAssignNeedsPerm'\) : '';/);
  // The hover text exists in all three languages, and each is its own.
  const hover = src.match(/jobAssignNeedsPerm:'[^']+'/g) || [];
  assert.equal(hover.length, 3, "en, es and fr");
  assert.equal(new Set(hover).size, 3, "three different sentences, not one copied");
});
