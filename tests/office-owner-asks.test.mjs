// Four things the owner asked of the office, each tested by calling the real
// function lifted out of dashboard.html (the grab()/new Function() idiom of
// tests/dashboard-alert-severity.test.mjs) with the arguments the page gives
// it, and asserting on what comes back -- not on the source text.
//
//   "I want the email to be kept when I got the wrong password"  -> signIn
//   "Once I say that I have contacted them, change the thing so I don't have
//    to click it again"                                           -> recordFirstContact / markContactedNow
//   "When I click save changes, it should save and close"         -> saveJob
//
// The DOM, Supabase and storage are small stand-ins that record what was done
// to them. Each case that could pass by doing nothing has a partner case that
// only passes if the code actually acted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("website/dashboard.html", "utf8");

const grab = (name) => {
  const start = src.search(new RegExp("(?:async )?function " + name + "\\("));
  if (start < 0) throw new Error("not found: " + name);
  let i = src.indexOf("{", start), depth = 0;
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

// The real English table, so a message asserted here is the message shown.
const tlStart = src.indexOf("const TL = {");
let depth = 0, tlEnd = -1;
for (let i = src.indexOf("{", tlStart); i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}") { depth--; if (!depth) { tlEnd = i + 1; break; } }
}
const TL = eval("(" + src.slice(src.indexOf("{", tlStart), tlEnd) + ")");
const tr = (key, ...args) => { let out = TL.en[key] || ""; args.forEach((a) => { out = out.replace("%s", a); }); return out; };

const classList = (on) => {
  const s = new Set(on ? ["on"] : []);
  return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c, f) => (f ? s.add(c) : s.delete(c)) };
};
const el = (props = {}) => ({
  value: "", textContent: "", disabled: false, className: "", style: {}, focused: false,
  focus() { this.focused = true; }, classList: classList(props.on), ...props,
});
const dom = (ids) => { const m = {}; ids.forEach((id) => { m[id] = el(); }); return (id) => m[id] || (m[id] = el()); };
const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), dump: () => [...m.entries()] }; };

// ------------------------------------------------------------------ sign-in

const makeSignIn = ({ authError = null } = {}) => {
  const $ = dom(["email", "password", "signIn", "authMsg"]);
  const calls = { msg: [], boot: 0, signInArgs: null };
  const localStorage = store();
  const db = { auth: { signInWithPassword: async (a) => { calls.signInArgs = a; return { error: authError }; } } };
  const fn = new Function(
    "$", "msg", "tr", "db", "localStorage", "location", "history", "boot", "authMode", "signUp", "finishCompany",
    [grabConst("LAST_EMAIL_KEY"), grab("rememberEmail"), grab("rememberedEmail"), grab("signIn")].join("\n")
      + "\nreturn { signIn, rememberedEmail };"
  )($, (id, text, kind) => calls.msg.push({ id, text, kind }), tr, db, localStorage,
    { hash: "", pathname: "/dashboard.html", search: "" }, { replaceState() {} },
    async () => { calls.boot++; }, "signin", null, null);
  return { $, calls, localStorage, ...fn };
};

test("a wrong password keeps the email, clears only the password, and puts the cursor back in it", async () => {
  const s = makeSignIn({ authError: { message: "Invalid login credentials" } });
  s.$("email").value = "  owner@example.com ";
  s.$("password").value = "wrong-one";
  await s.signIn();
  assert.equal(s.$("email").value, "owner@example.com");
  assert.equal(s.$("password").value, "");
  assert.equal(s.$("password").focused, true);
  assert.equal(s.calls.boot, 0);
  assert.deepEqual(s.calls.msg.at(-1), { id: "authMsg", text: tr("authErrBadCredentials"), kind: "err" });
  assert.equal(s.$("signIn").disabled, false, "the button comes back for the next try");
  assert.deepEqual(s.localStorage.dump(), [], "a failed attempt remembers nothing");
});

test("a good sign-in remembers the email (never the password) and goes straight into boot()", async () => {
  const s = makeSignIn();
  s.$("email").value = "owner@example.com";
  s.$("password").value = "right-one";
  await s.signIn();
  assert.deepEqual(s.calls.signInArgs, { email: "owner@example.com", password: "right-one" });
  assert.equal(s.calls.boot, 1);
  assert.equal(s.$("password").value, "", "the password leaves the page");
  assert.equal(s.rememberedEmail(), "owner@example.com");
  assert.ok(!s.localStorage.dump().some(([, v]) => v.includes("right-one")), "no password anywhere in storage");
});

// ------------------------------------------------------------ first contact

const makeContact = ({ rows, error = null, openJobId = 5 }) => {
  const captured = {};
  const db = {
    from(t) { captured.table = t; return {
      update(p) { captured.patch = p; return {
        eq(c, v) { captured.eq = [c, v]; return {
          select(cols) { captured.select = cols; return Promise.resolve({ data: rows, error }); } }; } }; } }; },
  };
  const job = { id: 5, first_contact_at: null, first_contact_by: null, updated_at: "2026-09-21T10:00:00Z", created_at: "2026-09-21T09:00:00Z" };
  const state = { jobs: [job], allJobsLoaded: [job], openJob: openJobId === 5 ? job : null };
  const $ = dom(["contactState", "markContacted", "contactMsg"]);
  const calls = { msg: [], dash: 0, header: 0 };
  const lib = new Function(
    "db", "tr", "state", "$", "msg", "d", "sinceWords", "canEdit", "companyMembers", "profile", "renderDash", "renderJobHeader",
    `let jobs = state.jobs, allJobsLoaded = state.allJobsLoaded, openJob = state.openJob;
     ${grab("contactedLabel")}
     ${grab("recordFirstContact")}
     ${grab("renderContact")}
     ${grab("markContactedNow")}
     return { recordFirstContact, markContactedNow, contactedLabel };`
  )(db, tr, state, $, (id, text, kind) => calls.msg.push({ id, text, kind }),
    (s) => (s ? new Date(s) : null), () => "1 hour", () => true,
    [{ id: "u-1", full_name: "Dana Owner" }], { id: "u-1", full_name: "Dana Owner" },
    () => { calls.dash++; }, () => { calls.header++; });
  return { lib, captured, job, state, $, calls };
};

test("recording first contact writes who and when, and is judged on the row that comes back", async () => {
  const back = { id: 5, first_contact_at: "2026-09-21T11:00:00Z", first_contact_by: "u-1", updated_at: "2026-09-21T11:00:01Z" };
  const c = makeContact({ rows: [back] });
  const res = await c.lib.recordFirstContact(5);
  assert.equal(res.error, undefined);
  assert.equal(c.captured.table, "jobs");
  assert.equal(c.captured.patch.first_contact_by, "u-1");
  assert.ok(!Number.isNaN(Date.parse(c.captured.patch.first_contact_at)));
  assert.match(c.captured.select, /first_contact_at/);
  // The job this page already holds now says contacted -- no reload needed.
  assert.equal(c.job.first_contact_at, back.first_contact_at);
  assert.equal(c.job.first_contact_by, "u-1");
  assert.equal(c.job.updated_at, back.updated_at, "the new version, so a re-price does not 409 on a stale one");
});

test("an update that changed no row is an error, not a silent success", async () => {
  const c = makeContact({ rows: [] });
  const res = await c.lib.recordFirstContact(5);
  assert.equal(res.error, tr("contactNotRecordedErr"));
  assert.equal(c.job.first_contact_at, null, "nothing on screen pretends it worked");
});

test("the job sheet button turns into the 'Contacted ... by ...' label at once", async () => {
  const back = { id: 5, first_contact_at: "2026-09-21T11:00:00Z", first_contact_by: "u-1", updated_at: "2026-09-21T11:00:01Z" };
  const c = makeContact({ rows: [back] });
  await c.lib.markContactedNow();
  assert.equal(c.$("markContacted").style.display, "none", "the button is gone");
  assert.match(c.$("contactState").textContent, /^Contacted .+ by Dana Owner/);
  assert.deepEqual(c.calls.msg.at(-1), { id: "contactMsg", text: tr("contactRecordedMsg"), kind: "ok" });
  assert.equal(c.calls.dash, 1, "Home's alert, chase row and briefing repaint too");
});

test("a refused write leaves the button up and says why", async () => {
  const c = makeContact({ rows: null, error: { message: "permission denied for table jobs" } });
  await c.lib.markContactedNow();
  assert.notEqual(c.$("markContacted").style.display, "none");
  assert.equal(c.$("markContacted").disabled, false);
  assert.deepEqual(c.calls.msg.at(-1), { id: "contactMsg", text: "permission denied for table jobs", kind: "err" });
});

test("no name on record says when, and nothing about who", () => {
  const c = makeContact({ rows: [] });
  assert.match(c.lib.contactedLabel({ first_contact_at: "2026-09-21T11:00:00Z", first_contact_by: null }), /^Contacted [^]+$/);
  assert.doesNotMatch(c.lib.contactedLabel({ first_contact_at: "2026-09-21T11:00:00Z", first_contact_by: null }), / by /);
  assert.match(c.lib.contactedLabel({ first_contact_at: "2026-09-21T11:00:00Z", first_contact_by: "u-1" }), / by Dana Owner$/);
});

// ------------------------------------------------------------ save and close

const makeSaveJob = ({ rows, error = null }) => {
  const $ = dom(["j_scheduled_date", "j_assigned_employee_id", "saveJob", "jobMsg"]);
  const overlay = el({ on: true });
  const get = (id) => (id === "jobOverlay" ? overlay : $(id));
  const calls = { msg: [], notes: [], loadAll: 0, price: 0 };
  const db = { from: () => ({ update: () => ({ eq: () => ({ select: () => Promise.resolve({ data: rows, error }) }) }) }) };
  const openJob = { id: 9, sync_id: "s-9", tax_rate_percent: 7 };
  const saveJob = new Function(
    "$", "db", "tr", "msg", "savedNote", "loadAll", "showJob", "callPriceJob", "money", "officePricingErrorMessage",
    "num", "canEdit", "J_TEXT", "J_NUM", "J_SEL", "openJob",
    grab("saveJob") + "\nreturn saveJob;"
  )(get, db, tr, (id, text, kind) => calls.msg.push({ id, text, kind }),
    (text, kind) => calls.notes.push({ text, kind }), async () => { calls.loadAll++; }, () => {},
    async () => { calls.price++; return { status: 200, body: { output: { totals: { grand_total: 1 } } } }; },
    (v) => "$" + v, () => "", Number, () => true, [], [], [], openJob);
  return { saveJob, overlay, calls, $ };
};

test("Save changes saves and closes the sheet, and the confirmation survives the close", async () => {
  const s = makeSaveJob({ rows: [{ id: 9, sync_id: "s-9", updated_at: "2026-09-21T11:00:00Z" }] });
  await s.saveJob();
  assert.equal(s.overlay.classList.contains("on"), false, "the sheet closed");
  assert.equal(s.calls.notes.at(-1).kind, "ok");
  assert.match(s.calls.notes.at(-1).text, /^Saved\./);
  assert.equal(s.calls.loadAll, 1, "the list underneath refreshes");
  assert.equal(s.$("saveJob").disabled, false);
});

test("a failed save keeps the sheet open with the error in it", async () => {
  const s = makeSaveJob({ rows: null, error: { message: "new row violates row-level security policy" } });
  await s.saveJob();
  assert.equal(s.overlay.classList.contains("on"), true);
  assert.deepEqual(s.calls.msg.at(-1), { id: "jobMsg", text: "new row violates row-level security policy", kind: "err" });
  assert.equal(s.calls.loadAll, 0);
});

test("a save that changed no row keeps the sheet open instead of announcing it", async () => {
  const s = makeSaveJob({ rows: [] });
  await s.saveJob();
  assert.equal(s.overlay.classList.contains("on"), true);
  assert.deepEqual(s.calls.msg.at(-1), { id: "jobMsg", text: tr("jobSaveNothingChangedErr"), kind: "err" });
  assert.equal(s.calls.notes.length, 0);
});
