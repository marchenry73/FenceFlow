// The job sheet's Email panel and Reports' money-owed "Email" button: the
// two places outside the Email tab where the office reaches company email.
//
// Run with:  node --test tests/mail-job-sheet.test.mjs
//
// The panel's functions are lifted out of dashboard.html and run in a vm
// against fake elements, called the way showJob() and the click handlers
// call them, and judged on what they leave on screen and what they hand to
// compose, the Email tab and the database. Anything that is only a string
// in the page is grepped, and every check that could pass vacuously has a
// planted failure beside it that must be caught.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseAddressList, cleanLine, mailTimeLabel } from "../website/js/lib/mail-render.mjs";

const PAGE = readFileSync("website/dashboard.html", "utf8");
const SQL = readFileSync("supabase_mail.sql", "utf8");

function translations() {
  const start = PAGE.indexOf("const TL = {");
  let depth = 0, end = -1;
  for (let i = PAGE.indexOf("{", start); i < PAGE.length; i++) {
    if (PAGE[i] === "{") depth++;
    else if (PAGE[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return eval("(" + PAGE.slice(PAGE.indexOf("{", start), end) + ")");
}
const TL = translations();

function between(src, a, b) {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i + a.length);
  return i >= 0 && j > i ? src.slice(i, j) : "";
}

const PANEL_START = "/* ---------- the job sheet's Email panel";
const WIRING = "/* ---------- wiring (every element here is in the static markup) ---------- */";
const SECTION = between(PAGE, PANEL_START, WIRING);
const J_TEXT = eval(PAGE.match(/const J_TEXT=(\[[\s\S]*?\]);/)[1]);
const J_NUM = eval(PAGE.match(/const J_NUM=(\[[\s\S]*?\]);/)[1]);
const J_SEL = eval(PAGE.match(/const J_SEL=(\[[\s\S]*?\]);/)[1]);
const esc = eval(PAGE.match(/const esc = (s => [^\n]*);/)[1]);

const tr = (key, ...args) => {
  let out = TL.en[key] || "";
  for (const a of args) out = out.replace("%s", a);
  return out;
};
const flush = () => new Promise((r) => setImmediate(r));
// Objects made inside the vm have its own prototypes; compare their data.
const plain = (x) => JSON.parse(JSON.stringify(x));

/** Just enough of an element. An <input> drops line breaks from a value it
    is given and a <textarea> turns CRLF into LF, as a browser does. */
function el(tag = "div", { display = "", classes = [] } = {}) {
  const set = new Set(classes);
  let v = "";
  const e = {
    tag, style: { display }, disabled: false, textContent: "", innerHTML: "", dataset: {},
    classList: { contains: (c) => set.has(c), add: (c) => set.add(c), remove: (c) => set.delete(c) },
  };
  Object.defineProperty(e, "value", {
    get: () => v,
    set: (x) => { v = tag === "input" ? String(x ?? "").replace(/[\r\n]/g, "") : String(x ?? "").replace(/\r\n?/g, "\n"); },
  });
  return e;
}

/** The panel's section, evaluated with fakes for everything it reaches. */
function harness({ src = SECTION, canUseMail = true, canEdit = true, rpc = null } = {}) {
  const els = new Map();
  const add = (id, e) => els.set(id, e);
  add("panelMail", el("div", { display: "none" }));
  add("jobMailRows", el());
  add("jobMailBtn", el("button"));
  add("jobMailNote", el("span"));
  add("jobOverlay", el("div", { classes: ["on"] }));
  for (const k of J_TEXT) add("j_" + k, el(k === "notes" ? "textarea" : "input"));
  for (const k of [...J_NUM, ...J_SEL, "scheduled_date", "assigned_employee_id"]) add("j_" + k, el("input"));
  const calls = { rpc: [], compose: [], ask: [], tab: [], thread: [] };
  const ctx = {
    $: (id) => { const e = els.get(id); if (!e) throw new Error(`no element #${id}`); return e; },
    db: {
      rpc: (name, args) => {
        calls.rpc.push(plain([name, args]));
        return rpc ? rpc(name, args) : Promise.resolve({ data: [], error: null });
      },
    },
    tr, esc, parseAddressList, cleanLine, mailTimeLabel,
    plainError: (s) => String(s),
    J_TEXT, J_NUM, J_SEL, LANG: "en",
    canUseMail, openJob: null,
    canEdit: () => canEdit,
    askAnswer: false,
    ask: async (o) => { calls.ask.push(plain(o)); return ctx.askAnswer; },
    openCompose: (o) => { calls.compose.push(plain(o)); },
    switchTab: (n) => { calls.tab.push(n); },
    openMailThread: (id) => { calls.thread.push(id); },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ctx, els, calls };
}

/** What showJob() does before it calls renderJobMail(): fill the fields. */
function openJobLike(h, job) {
  h.ctx.openJob = job;
  for (const k of J_TEXT) h.els.get("j_" + k).value = job[k] || "";
  for (const k of J_NUM) h.els.get("j_" + k).value = job[k] ?? 0;
  for (const k of J_SEL) h.els.get("j_" + k).value = job[k] || "NOT_REQUIRED";
  h.ctx.renderJobMail();
}

const JOB = {
  id: 1, sync_id: "11111111-1111-4111-8111-111111111111", customer_name: "Pat\nLee",
  email: "Pat@Example.com", notes: "Gate on the left.\r\nDog in yard.", status: "ACCEPTED",
};

// ---------------------------------------------------------------------------
// The markup.
// ---------------------------------------------------------------------------

function markupProblems(src) {
  const out = [];
  const tags = [...src.matchAll(/<div class="panel" id="panelMail"[^>]*>/g)];
  if (tags.length !== 1) out.push(`${tags.length} #panelMail panels`);
  else if (!/style="display:none"/.test(tags[0][0])) out.push("the panel shows before the gate");
  const panel = between(src, '<div class="panel" id="panelMail"', '<div class="panel" id="panelRuns"');
  if (!panel) out.push("the panel is not between the Customer panel and Fence Runs");
  if (!/id="jobMailBtn"/.test(panel)) out.push("no Email customer button in the panel");
  if (!/id="jobMailRows"/.test(panel)) out.push("no thread list in the panel");
  if (!/data-t="jobSecMail"/.test(panel)) out.push("the heading is not translated");
  const notes = src.indexOf('<textarea id="j_notes"></textarea>');
  if (notes < 0 || src.indexOf('id="panelMail"') < notes) out.push("the panel is above the Customer panel");
  return out;
}

test("the panel sits after the Customer panel, hidden until the gate says otherwise", () => {
  assert.deepEqual(markupProblems(PAGE), []);
  // PLANTED: a visible panel, or a second one, is caught.
  assert.ok(markupProblems(PAGE.replace('<div class="panel" id="panelMail" style="display:none">', '<div class="panel" id="panelMail">'))
    .includes("the panel shows before the gate"));
  assert.ok(markupProblems(PAGE + '<div class="panel" id="panelMail" style="display:none"></div>')
    .includes("2 #panelMail panels"));
});

// ---------------------------------------------------------------------------
// The gate and the rows.
// ---------------------------------------------------------------------------

test("without company email the panel stays hidden and nothing is asked", async () => {
  const h = harness({ canUseMail: false });
  openJobLike(h, JOB);
  await flush();
  assert.equal(h.els.get("panelMail").style.display, "none");
  assert.deepEqual(h.calls.rpc, []);
  // PLANTED: the same job with mail shows the panel and asks mail_for_job
  // for this job's sync id -- so the zero above came from the gate.
  const g = harness({ canUseMail: true });
  openJobLike(g, JOB);
  await flush();
  assert.equal(g.els.get("panelMail").style.display, "");
  assert.deepEqual(g.calls.rpc, [["mail_for_job", { p_job_sync_id: JOB.sync_id, p_limit: 30 }]]);
});

test("a job with no sync id asks nothing", async () => {
  const h = harness();
  openJobLike(h, { ...JOB, sync_id: null });
  await flush();
  assert.equal(h.els.get("panelMail").style.display, "none");
  assert.deepEqual(h.calls.rpc, []);
});

const EVIL = {
  id: '"><svg onload=alert(1)>', subject: "<img src=x onerror=alert(1)>", snippet: "<script>alert(2)</script>",
  last_message_at: "2026-09-20T15:00:00Z", message_count: 3, unread_count: 1, matched_customer: true, matched_hoa: false,
};
const HOA = { id: "t-hoa", subject: "Fence approval", snippet: "Board meets Tuesday", last_message_at: "2026-09-19T10:00:00Z",
  message_count: 1, unread_count: 0, matched_customer: false, matched_hoa: true };

// A stranger's tag that reached the markup as a tag. Escaped, "onerror=" is
// only text; an attribute that broke out of its quotes opens a raw tag too.
function leaks(html) {
  return /<(img|script|svg)\b/i.test(html);
}

test("rows escape every stranger-written string and tag the HOA's threads", async () => {
  const h = harness({ rpc: () => Promise.resolve({ data: [EVIL, HOA], error: null }) });
  openJobLike(h, JOB);
  await flush();
  const html = h.els.get("jobMailRows").innerHTML;
  assert.equal(leaks(html), false, html);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /data-jobthread="&quot;&gt;&lt;svg onload=alert\(1\)&gt;"/);
  // Unread, the count and "Open in Email" on the first; the HOA tag only on the second.
  const [first, second] = html.split('<button type="button" class="mail-row').slice(1);
  assert.match(first, /^ unread"/);
  assert.match(first, /<span class="mr-n">3<\/span>/);
  assert.match(first, new RegExp(TL.en.jobMailOpenInInbox));
  assert.doesNotMatch(first, /jm-tag/);
  assert.match(second, new RegExp(`<span class="pill na jm-tag">${TL.en.jobMailHoaTag}</span>`));
  // PLANTED: the same rows through a builder that forgot esc() are caught.
  const careless = harness({ src: SECTION.replace("${esc(subject)}", "${subject}"),
    rpc: () => Promise.resolve({ data: [EVIL], error: null }) });
  openJobLike(careless, JOB);
  await flush();
  assert.equal(leaks(careless.els.get("jobMailRows").innerHTML), true);
});

test("no threads says so, and an error says what went wrong -- never an empty box", async () => {
  const h = harness();
  openJobLike(h, JOB);
  await flush();
  assert.match(h.els.get("jobMailRows").innerHTML, new RegExp(TL.en.jobMailEmpty.slice(0, 30)));
  const bad = harness({ rpc: () => Promise.resolve({ data: null, error: { message: "permission denied" } }) });
  openJobLike(bad, JOB);
  await flush();
  assert.match(bad.els.get("jobMailRows").innerHTML, /permission denied/);
  assert.doesNotMatch(bad.els.get("jobMailRows").innerHTML, new RegExp(TL.en.jobMailEmpty.slice(0, 30)));
});

test("an answer for a job that is no longer on screen is thrown away", async () => {
  const run = async (src) => {
    const pending = [];
    const h = harness({ src, rpc: () => new Promise((res) => pending.push(res)) });
    openJobLike(h, { ...JOB, sync_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    openJobLike(h, { ...JOB, id: 2, sync_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    pending[1]({ data: [{ ...HOA, id: "b", subject: "Job B mail" }], error: null });
    await flush();
    pending[0]({ data: [{ ...HOA, id: "a", subject: "Job A mail" }], error: null });
    await flush();
    return h.els.get("jobMailRows").innerHTML;
  };
  const html = await run(SECTION);
  assert.match(html, /Job B mail/);
  assert.doesNotMatch(html, /Job A mail/);
  // PLANTED: without the guard the late answer paints job A's mail on job B.
  const guard = "if (seq !== jobMailSeq || openJob !== j) return;";
  assert.ok(SECTION.includes(guard));
  assert.match(await run(SECTION.replace(guard, "")), /Job A mail/);
});

// ---------------------------------------------------------------------------
// "Email customer".
// ---------------------------------------------------------------------------

test("Email customer writes to the address in the field above, tied to the job", async () => {
  const h = harness();
  openJobLike(h, JOB);
  await flush();
  assert.equal(h.els.get("jobMailBtn").disabled, false);
  assert.equal(h.els.get("jobMailNote").textContent, "");
  // Typed and not saved yet: that address is the one used.
  h.els.get("j_email").value = "  New.Owner@Example.com ";
  h.ctx.updateJobMailBtn();
  h.ctx.jobMailCompose();
  assert.deepEqual(h.calls.compose, [{ to: "new.owner@example.com", jobSyncId: JOB.sync_id }]);
});

test("with no usable address the button is off and says why", async () => {
  const h = harness();
  openJobLike(h, { ...JOB, email: "" });
  await flush();
  assert.equal(h.els.get("jobMailBtn").disabled, true);
  assert.equal(h.els.get("jobMailNote").textContent, TL.en.jobMailNoEmail);
  h.els.get("j_email").value = "call me maybe";
  h.ctx.updateJobMailBtn();
  assert.equal(h.els.get("jobMailBtn").disabled, true);
  assert.equal(h.els.get("jobMailNote").textContent, TL.en.jobMailBadEmail);
  // PLANTED: a press anyway (the button re-enabled by hand) still opens nothing.
  h.ctx.jobMailCompose();
  assert.deepEqual(h.calls.compose, []);
});

// ---------------------------------------------------------------------------
// "Open in Email".
// ---------------------------------------------------------------------------

test("Open in Email closes the sheet and opens the thread when nothing was edited", async () => {
  const h = harness();
  // A name with a line break and notes with CRLF: the browser changes both
  // on the way into the fields, which is not an edit.
  openJobLike(h, JOB);
  await h.ctx.openJobMailThread("t-1");
  assert.deepEqual(h.calls.ask, []);
  assert.equal(h.els.get("jobOverlay").classList.contains("on"), false);
  assert.deepEqual(h.calls.tab, ["mail"]);
  assert.deepEqual(h.calls.thread, ["t-1"]);
});

test("an unsaved edit is asked about, and No keeps the sheet open", async () => {
  const h = harness();
  openJobLike(h, JOB);
  h.els.get("j_notes").value = "Gate on the RIGHT.";
  await h.ctx.openJobMailThread("t-1");
  assert.equal(h.calls.ask.length, 1);
  assert.equal(h.calls.ask[0].title, TL.en.jobMailLeaveQ);
  assert.equal(h.els.get("jobOverlay").classList.contains("on"), true);
  assert.deepEqual(h.calls.tab, []);
  assert.deepEqual(h.calls.thread, []);
  // Yes goes.
  h.ctx.askAnswer = true;
  await h.ctx.openJobMailThread("t-1");
  assert.deepEqual(h.calls.thread, ["t-1"]);
  // PLANTED: a changed date or lead counts too, and someone who cannot save
  // is never asked about edits they could not keep.
  const d = harness();
  openJobLike(d, JOB);
  d.els.get("j_scheduled_date").value = "2026-10-01";
  await d.ctx.openJobMailThread("t-2");
  assert.equal(d.calls.ask.length, 1);
  const ro = harness({ canEdit: false });
  openJobLike(ro, JOB);
  ro.els.get("j_notes").value = "typed by a viewer";
  await ro.ctx.openJobMailThread("t-3");
  assert.deepEqual(ro.calls.ask, []);
  assert.deepEqual(ro.calls.thread, ["t-3"]);
});

test("a send tied to the open job reloads its rows, and only that", async () => {
  const h = harness();
  openJobLike(h, JOB);
  await flush();
  h.calls.rpc.length = 0;
  h.ctx.jobMailSent("99999999-9999-4999-8999-999999999999");
  h.ctx.jobMailSent(null);
  assert.deepEqual(h.calls.rpc, []);
  h.ctx.jobMailSent(JOB.sync_id);
  await flush();
  assert.deepEqual(h.calls.rpc, [["mail_for_job", { p_job_sync_id: JOB.sync_id, p_limit: 30 }]]);
  // The edit made before writing is still unsaved afterwards.
  h.els.get("j_notes").value = "changed before writing";
  h.ctx.jobMailSent(JOB.sync_id);
  await flush();
  await h.ctx.openJobMailThread("t-1");
  assert.equal(h.calls.ask.length, 1);
  // PLANTED: with the sheet closed nothing is reloaded.
  h.els.get("jobOverlay").classList.remove("on");
  h.calls.rpc.length = 0;
  h.ctx.jobMailSent(JOB.sync_id);
  assert.deepEqual(h.calls.rpc, []);
});

// ---------------------------------------------------------------------------
// How the page wires it.
// ---------------------------------------------------------------------------

function wiringProblems(src) {
  const out = [];
  const show = between(src, "async function showJob(id){", "\nasync function saveJob(){");
  const call = show.indexOf("renderJobMail();");
  if (call < 0) out.push("showJob never calls renderJobMail");
  else {
    for (const filled of ["J_TEXT.forEach", "J_SEL.forEach", "$('j_scheduled_date').value=", "sel.value=openJob.assigned_employee_sync_id"]) {
      const at = show.indexOf(filled);
      if (at < 0 || at > call) out.push(`renderJobMail runs before ${filled}`);
    }
  }
  const sent = between(src, "function composeSent(c, body){", "\nasync function closeCompose(){");
  if (!/jobMailSent\(c\.jobSyncId\);/.test(sent)) out.push("a send does not refresh the job's rows");
  if (!/\$\('jobMailBtn'\)\.addEventListener\('click', jobMailCompose\);/.test(src)) out.push("Email customer is not wired");
  if (!/\$\('jobMailRows'\)\.addEventListener\('click', e => \{\s*const b = e\.target\.closest\('\[data-jobthread\]'\);\s*if \(b\) openJobMailThread\(b\.dataset\.jobthread\);/.test(src)) {
    out.push("rows do not open the thread");
  }
  if (!/\$\('j_email'\)\.addEventListener\('input'/.test(src)) out.push("typing an address does not update the button");
  // Inside the Company email section, so tests/mail-render.test.mjs's
  // no-logging and no-storage checks cover it too.
  const a = src.indexOf("/* ===================== Company email");
  const b = src.indexOf("/* ---------- nav ---------- */", a);
  const p = src.indexOf(PANEL_START);
  if (!(a >= 0 && p > a && p < b)) out.push("the panel's code is outside the Company email section");
  return out;
}

test("showJob fills the fields first, sends refresh the rows, and the clicks are wired", () => {
  assert.deepEqual(wiringProblems(PAGE), []);
  // PLANTED: renderJobMail moved above the fields, or the send hook dropped, is caught.
  const moved = PAGE.replace("  renderJobMail();\n", "").replace("renderQuoteBlock(); renderReadiness();", "renderJobMail(); renderQuoteBlock(); renderReadiness();");
  assert.notEqual(moved, PAGE);
  assert.ok(wiringProblems(moved).some((p) => p.startsWith("renderJobMail runs before")));
  assert.ok(wiringProblems(PAGE.replace("  jobMailSent(c.jobSyncId);\n", "")).includes("a send does not refresh the job's rows"));
});

// ---------------------------------------------------------------------------
// Reports' money-owed "Email" button.
// ---------------------------------------------------------------------------

function decode(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** renderAging() lifted out and run, with its buttons found in what it drew. */
function aging(rows, { canUseMail = true } = {}) {
  const src = between(PAGE, "function renderAging(){", "\nfunction renderAudit(){");
  assert.ok(src.length > 500, "renderAging was found");
  const els = new Map(["arBuckets", "arRows", "arNote"].map((id) => [id, el()]));
  const composed = [];
  const buttons = [];
  const ctx = {
    $: (id) => els.get(id),
    hasAdvancedReports: () => true, onlyVisibleRows: (r) => r, jobs: [], arAging: rows,
    money: (n) => `$${Number(n || 0).toFixed(2)}`, esc, tr, jobStatusLabel: (s) => s,
    canUseMail, parseAddressList,
    openCompose: (o) => { composed.push(o); },
    window: { open: () => {} },
    document: {
      querySelectorAll: (sel) => {
        const attr = sel.match(/^\[(data-[a-z]+)\]$/)[1];
        const html = els.get("arRows").innerHTML;
        const out = [];
        for (const m of html.matchAll(new RegExp(`<button[^>]*\\b${attr}="[^"]*"[^>]*>`, "g"))) {
          const dataset = {};
          for (const [, k, v] of m[0].matchAll(/data-ar([a-z]+)="([^"]*)"/g)) dataset["ar" + k] = decode(v);
          const b = { dataset, handlers: [], addEventListener: (_, fn) => b.handlers.push(fn) };
          buttons.push(b);
          out.push(b);
        }
        return out;
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(src + "\nrenderAging();", ctx);
  return { html: els.get("arRows").innerHTML, composed, buttons };
}

const OWED = { job_sync_id: "22222222-2222-4222-8222-222222222222", customer_name: "O'Neil", status: "COMPLETED",
  contract_total: 5000, paid: 1000, owed: 4000, days_out: 70, bucket: "60", phone: null, email: "oneil@example.com" };

test("with company email the money-owed Email button opens compose on the job, nothing sent", () => {
  const r = aging([OWED]);
  assert.doesNotMatch(r.html, /mailto:/);
  const b = r.buttons.find((x) => x.dataset.armail);
  assert.ok(b, r.html);
  b.handlers.forEach((fn) => fn());
  assert.equal(r.composed.length, 1);
  assert.equal(r.composed[0].to, "oneil@example.com");
  assert.equal(r.composed[0].jobSyncId, OWED.job_sync_id);
  assert.equal(r.composed[0].subject, TL.en.repChaseMailSubject);
  assert.equal(r.composed[0].body, tr("repChaseSms", "O'Neil", "$4000.00"));
  // A phone still wins, as before: the text-message draft.
  const withPhone = aging([{ ...OWED, phone: "555-0100" }]);
  assert.match(withPhone.html, /data-arsms="555-0100"/);
  assert.doesNotMatch(withPhone.html, /data-armail/);
  // PLANTED: without company email it is the mailto link it always was, and
  // an address compose could not send to is never offered to compose.
  const off = aging([OWED], { canUseMail: false });
  assert.match(off.html, /href="mailto:oneil@example\.com"/);
  assert.doesNotMatch(off.html, /data-armail/);
  const junk = aging([{ ...OWED, email: "not an address" }]);
  assert.doesNotMatch(junk.html, /data-armail/);
});

// ---------------------------------------------------------------------------
// Words and the RPC behind them.
// ---------------------------------------------------------------------------

test("every key the panel and the button use exists in all three languages", () => {
  const src = SECTION + between(PAGE, "function renderAging(){", "\nfunction renderAudit(){");
  const used = new Set([
    ...[...src.matchAll(/tr\('((?:jobMail|jobSecMail|repChaseMail|mail)[A-Za-z0-9]*)'/g)].map((m) => m[1]),
    ...[...PAGE.matchAll(/data-t="((?:jobMail|jobSecMail)[A-Za-z0-9]*)"/g)].map((m) => m[1]),
  ]);
  assert.ok(used.size >= 10, `found ${used.size} keys`);
  const missing = [];
  for (const k of used) for (const lang of ["en", "es", "fr"]) if (!TL[lang][k]) missing.push(`${lang}.${k}`);
  assert.deepEqual(missing, []);
  // PLANTED: a key that is not there is reported.
  assert.equal(TL.es.jobMailNoSuchKey, undefined);
});

function rpcProblems(sql) {
  const out = [];
  const fn = between(sql, "create or replace function public.mail_for_job(", "\n$$;");
  const cols = between(fn, "returns table (", ")\nlanguage");
  for (const c of ["id", "subject", "last_message_at", "message_count", "unread_count", "snippet", "matched_hoa"]) {
    if (!new RegExp(`\\b${c}\\s+\\w`).test(cols)) out.push(`mail_for_job does not return ${c}`);
  }
  if (!/security invoker/.test(fn)) out.push("mail_for_job does not run as the caller");
  const grant = between(sql, "-- The office.\ngrant execute on function", "to authenticated, service_role;");
  if (!/public\.mail_for_job\(uuid, integer\)/.test(grant)) out.push("the office may not call mail_for_job");
  const revoke = sql.slice(0, sql.indexOf("-- The office.\ngrant execute on function"));
  if (!/public\.mail_for_job\(uuid, integer\),[\s\S]*?from public, anon, authenticated;/.test(revoke)) out.push("mail_for_job is not revoked from anon");
  return out;
}

test("mail_for_job returns what a row reads, runs as the caller, and anon cannot call it", () => {
  assert.deepEqual(rpcProblems(SQL), []);
  // PLANTED: a renamed column or a definer function is caught.
  assert.ok(rpcProblems(SQL.replace("    matched_hoa      boolean)", "    hoa_hit          boolean)")).includes("mail_for_job does not return matched_hoa"));
  const fnAt = SQL.indexOf("create or replace function public.mail_for_job(");
  const definer = SQL.slice(0, fnAt) + SQL.slice(fnAt).replace("security invoker", "security definer");
  assert.ok(rpcProblems(definer).includes("mail_for_job does not run as the caller"));
});
