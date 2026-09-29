// DEFECT (this wave) -- website/dashboard.html called three RPCs whose
// functions honestly report whether they changed anything (`found` /
// `n > 0`, the exact boolean shape live in pg_proc for each -- confirmed
// against the LIVE function bodies on the FenceFlow project, not the repo
// .sql files, 2026-09-28), and threw that answer away:
//
//   - mailUnlinkJob() called mail_unlink_thread(), which deletes a
//     mail_thread_jobs row and returns whether a row was actually deleted.
//     The page destructured only {error}, filtered the chip out of
//     `t.links` unconditionally, and never reloaded. A false answer --
//     the row this button pointed at is still there (stale read, another
//     tab, a company mismatch RLS enforces server-side) -- left the screen
//     saying the thread was unlinked from that job while the database
//     still had it linked. THE WORST of the three: nothing corrects it,
//     because nothing ever re-reads the thread.
//   - retireTemplate() called retire_build_template(), which UPDATEs
//     deleted_at and returns whether it touched a row. The page
//     destructured only {error}, closed the dialog, and said nothing
//     either way. A false answer (someone else already retired it, or
//     moved it off this company) closed the dialog exactly as if the
//     click had worked. A reload does show the truth afterwards, so this
//     one self-corrects -- but the refusal was never admitted.
//   - mailLinkJob() called mail_link_thread(), same discard. Its INSERT
//     uses ON CONFLICT DO NOTHING, so false only means "already linked" --
//     the thread ends up linked either way, so the existing behavior was
//     harmless. Fixed for consistency (the RPC's answer is now read, like
//     the other two) and commented so nobody "simplifies" the other two to
//     match this one's shrug.
//
// The correct shape was already in this file: revoke_device_key() and
// set_production_stage() (website/dashboard.html, Settings > device keys
// and the production board) both read their boolean answer and act on it.
// This wave copies that pattern rather than inventing a new one.
//
// A SECOND SHAPE, same class: renderCal()'s drag-to-reschedule drop handler
// wrote db.from('jobs').update({scheduled_date}).eq('id', job.id) with no
// .select(), then set job.scheduled_date and repainted unconditionally.
// Split the write out into rescheduleJobToDate() (mirroring how
// applyJobBatch/wizPatchJob centralize their own read-back, tests/a12-dash-
// zero-row-writes.test.mjs) so a zero-row write is caught before the
// calendar paints a move the database never made.
//
// Same grab()/new Function() idiom as tests/a12-dash-zero-row-writes.
// test.mjs, tests/a7-dashboard-money-regressions.test.mjs and tests/a8-
// company-email-guard.test.mjs -- these run the REAL functions lifted out
// of website/dashboard.html. Every DEFECT test below is paired with a
// PLANTED FAILURE that reconstructs this file's own pre-fix code and
// proves this same test would have caught it (MEMORY.md "Audit blind
// spots": a check that cannot go red is not a check).
//
// Run:
//   node tests/a15-dash-discarded-rpc-answers.test.mjs
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

const tr = (key, ...args) => key + (args.length ? "|" + args.join("|") : "");

// =============================================================================
// PART 1 -- mailUnlinkJob(): the worst of the three
// =============================================================================

function buildMailUnlinkJob(fnSrc, { rpcResult, openMailThreadCalls }) {
  const t = { id: "thread-1", links: ["job-A", "job-B"] };
  const mailThread = t;
  const mailView = { threads: [{ id: "thread-1", job_sync_ids: ["job-A", "job-B"] }] };
  const rpcCalls = [];
  const db = {
    rpc: (name, args) => { rpcCalls.push({ name, args }); return Promise.resolve(rpcResult); },
  };
  const msgCalls = [];
  const msg = (el, text, kind) => { msgCalls.push({ el, text, kind }); };
  const renderMailThreadsCalls = { count: 0 };
  const renderMailReaderCalls = { count: 0 };
  const openMailThread = (id) => { openMailThreadCalls.push(id); return Promise.resolve(); };
  const mailUnlinkJob = new Function(
    "mailThread", "db", "tr", "msg", "mailView", "renderMailThreads", "renderMailReader", "openMailThread",
    fnSrc + "\nreturn mailUnlinkJob;"
  )(mailThread, db, tr, msg, mailView, () => renderMailThreadsCalls.count++, () => renderMailReaderCalls.count++, openMailThread);
  return { mailUnlinkJob, t, mailView, db, rpcCalls, msgCalls, renderMailThreadsCalls, renderMailReaderCalls };
}

test("mailUnlinkJob() reads mail_unlink_thread's answer before touching local state", () => {
  const body = grab("mailUnlinkJob");
  assert.match(body, /const\s*\{\s*data:\s*unlinked\s*,\s*error\s*\}\s*=\s*await\s*db\.rpc\('mail_unlink_thread'/,
    "must destructure `data` (the function's `found`) alongside `error`");
  assert.match(body, /if\s*\(\s*!unlinked\s*\)/, "must branch on a false answer before filtering t.links");
});

test("a real unlink (found=true) removes the chip and does not reload", async () => {
  const openMailThreadCalls = [];
  const { mailUnlinkJob, t, mailView, renderMailReaderCalls } = buildMailUnlinkJob(grab("mailUnlinkJob"), {
    rpcResult: { data: true, error: null },
    openMailThreadCalls,
  });
  await mailUnlinkJob("job-A");
  assert.deepEqual(t.links, ["job-B"]);
  assert.deepEqual(mailView.threads[0].job_sync_ids, ["job-B"]);
  assert.equal(renderMailReaderCalls.count, 1);
  assert.equal(openMailThreadCalls.length, 0, "a real unlink needs no reload");
});

test("DEFECT: found=false (the link is still there server-side) does NOT paint the chip removed", async () => {
  const openMailThreadCalls = [];
  const { mailUnlinkJob, t, mailView, msgCalls } = buildMailUnlinkJob(grab("mailUnlinkJob"), {
    rpcResult: { data: false, error: null }, // exact shape mail_unlink_thread returns when its DELETE matched nothing
    openMailThreadCalls,
  });
  await mailUnlinkJob("job-A");
  assert.deepEqual(t.links, ["job-A", "job-B"], "the link must still be shown -- the database still has it");
  assert.deepEqual(mailView.threads[0].job_sync_ids, ["job-A", "job-B"]);
  const last = msgCalls[msgCalls.length - 1];
  assert.equal(last.kind, "err");
  assert.match(last.text, /mailUnlinkFailedMsg/);
  assert.deepEqual(openMailThreadCalls, ["thread-1"], "must reload the thread so the reader repaints from the truth");
});

test("PLANTED FAILURE: the pre-fix mailUnlinkJob paints the link gone regardless of what the database did", async () => {
  const real = grab("mailUnlinkJob");
  // Exactly what website/dashboard.html carried before this wave: only
  // {error} destructured, unconditional filter, no reload.
  const old = `async function mailUnlinkJob(syncId){
  const t = mailThread;
  if (!t || !syncId) return;
  const { error } = await db.rpc('mail_unlink_thread', { p_thread: t.id, p_job_sync_id: syncId });
  if (error) return msg('mailMsg', error.message, 'err');
  t.links = t.links.filter(x => x !== syncId);
  const row = mailView.threads.find(x => x.id === t.id);
  if (row) { row.job_sync_ids = (row.job_sync_ids || []).filter(x => x !== syncId); renderMailThreads(); }
  renderMailReader();
}`;
  assert.notEqual(old, real, "the plant must actually differ from the shipped function");
  assert.doesNotMatch(old, /unlinked/, "sanity: the plant removes the found-check entirely");

  const openMailThreadCalls = [];
  const { mailUnlinkJob, t, mailView } = buildMailUnlinkJob(old, {
    rpcResult: { data: false, error: null },
    openMailThreadCalls,
  });
  await mailUnlinkJob("job-A");
  // This is the bug: the database still holds the link (found=false said
  // so), but the pre-fix code shows it gone anyway.
  assert.deepEqual(t.links, ["job-B"], "sanity: the pre-fix code really does remove the chip here");
  assert.deepEqual(mailView.threads[0].job_sync_ids, ["job-B"]);
  assert.equal(openMailThreadCalls.length, 0, "sanity: the pre-fix code never reloads to catch its own mistake");
});

// =============================================================================
// PART 2 -- retireTemplate()
// =============================================================================

function fakeClassList(initiallyOn) {
  let on = initiallyOn;
  return { contains: (c) => c === "on" && on, add: (c) => { if (c === "on") on = true; }, remove: (c) => { if (c === "on") on = false; } };
}

function buildRetireTemplate(fnSrc, { rpcResult, dialogOpen }) {
  const buildTemplates = [{ sync_id: "tpl-1", name: "My Template" }];
  const overlay = { classList: fakeClassList(dialogOpen) };
  const $ = (id) => { if (id === "tplOverlay") return overlay; throw new Error("unexpected $(" + id + ")"); };
  const rpcCalls = [];
  const db = { rpc: (name, args) => { rpcCalls.push({ name, args }); return Promise.resolve(rpcResult); } };
  const msgCalls = [];
  const msg = (el, text, kind) => { msgCalls.push({ el, text, kind }); };
  const ask = async () => true;
  const canEdit = () => true;
  const reloadTemplatesCalls = { count: 0 };
  const reloadTemplates = async () => { reloadTemplatesCalls.count++; };
  const retireTemplate = new Function(
    "canEdit", "buildTemplates", "ask", "tr", "db", "$", "msg", "reloadTemplates",
    fnSrc + "\nreturn retireTemplate;"
  )(canEdit, buildTemplates, ask, tr, db, $, msg, reloadTemplates);
  return { retireTemplate, overlay, msgCalls, reloadTemplatesCalls, rpcCalls };
}

test("retireTemplate() reads retire_build_template's answer and admits a refusal", () => {
  const body = grab("retireTemplate");
  assert.match(body, /const\s*\{\s*data:\s*retired\s*,\s*error\s*\}\s*=\s*await\s*db\.rpc\('retire_build_template'/,
    "must destructure `data` (the function's `n > 0`) alongside `error`");
  assert.match(body, /if\s*\(\s*!retired\s*\)/, "must branch on a false answer before closing the dialog");
});

test("a real retire (n>0) closes the dialog with no error message", async () => {
  const { retireTemplate, overlay, msgCalls, reloadTemplatesCalls } = buildRetireTemplate(grab("retireTemplate"), {
    rpcResult: { data: true, error: null },
    dialogOpen: true,
  });
  await retireTemplate("tpl-1");
  assert.equal(overlay.classList.contains("on"), false, "the dialog must close on a real retire");
  assert.equal(reloadTemplatesCalls.count, 1);
  assert.ok(!msgCalls.some((m) => m.kind === "err"), "no error should be shown for a real retire");
});

test("DEFECT: n=0 (already retired elsewhere) does NOT close the dialog silently", async () => {
  const { retireTemplate, overlay, msgCalls, reloadTemplatesCalls } = buildRetireTemplate(grab("retireTemplate"), {
    rpcResult: { data: false, error: null }, // exact shape retire_build_template returns when its UPDATE matched nothing
    dialogOpen: true,
  });
  await retireTemplate("tpl-1");
  assert.equal(overlay.classList.contains("on"), true, "the dialog must stay open -- this click did not retire anything");
  const last = msgCalls[msgCalls.length - 1];
  assert.equal(last.el, "tplDialogMsg", "message goes to the dialog's own box since it is the one on screen");
  assert.equal(last.kind, "err");
  assert.match(last.text, /tplRetireGoneMsg/);
  assert.equal(reloadTemplatesCalls.count, 1, "still reload so the row list matches the truth");
});

test("the row-button path (dialog closed) routes the same refusal to tplMsg", async () => {
  const { retireTemplate, msgCalls } = buildRetireTemplate(grab("retireTemplate"), {
    rpcResult: { data: false, error: null },
    dialogOpen: false,
  });
  await retireTemplate("tpl-1");
  const last = msgCalls[msgCalls.length - 1];
  assert.equal(last.el, "tplMsg");
  assert.equal(last.kind, "err");
  assert.match(last.text, /tplRetireGoneMsg/);
});

test("PLANTED FAILURE: the pre-fix retireTemplate closes the dialog on a no-op retire", async () => {
  const real = grab("retireTemplate");
  // Exactly what website/dashboard.html carried before this wave: only
  // {error} destructured, dialog closes whenever there is no error.
  const old = `async function retireTemplate(syncId){
  if(!canEdit()) return;
  const t = buildTemplates.find(x=>x.sync_id===syncId);
  const okRetire = await ask({
    title: tr('tierRetireConfirmTitle', t?.name||tr('tplDefaultTemplateName')),
    body: tr('tplRetireConfirmBody'),
    confirmLabel: tr('tierRetireBtn'), danger: true
  });
  if(!okRetire) return;
  const { error } = await db.rpc('retire_build_template', { p_sync_id: syncId });
  const dialogOpen = $('tplOverlay').classList.contains('on');
  if(error){ msg(dialogOpen ? 'tplDialogMsg' : 'tplMsg', error.message, 'err'); return; }
  if(dialogOpen) $('tplOverlay').classList.remove('on');
  await reloadTemplates();
}`;
  assert.notEqual(old, real, "the plant must actually differ from the shipped function");
  assert.doesNotMatch(old, /retired/, "sanity: the plant removes the n>0 check entirely");

  const { retireTemplate, overlay, msgCalls } = buildRetireTemplate(old, {
    rpcResult: { data: false, error: null },
    dialogOpen: true,
  });
  await retireTemplate("tpl-1");
  // This is the bug: nothing was retired, but the dialog closes as if it was,
  // and nobody is ever told.
  assert.equal(overlay.classList.contains("on"), false, "sanity: the pre-fix code really does close the dialog here");
  assert.ok(!msgCalls.some((m) => m.kind === "err"), "sanity: the pre-fix code never says anything about the refusal");
});

// =============================================================================
// PART 3 -- mailLinkJob(): the benign one, fixed for consistency
// =============================================================================

function buildMailLinkJob(fnSrc, { rpcResult }) {
  const t = { id: "thread-1", links: ["job-B"], linking: true };
  const mailThread = t;
  const mailView = { threads: [{ id: "thread-1", job_sync_ids: ["job-B"] }] };
  const db = { rpc: () => Promise.resolve(rpcResult) };
  const msgCalls = [];
  const msg = (el, text, kind) => { msgCalls.push({ el, text, kind }); };
  const mailJobNames = () => new Map([["job-A", "123 Main St"]]);
  const mailLinkJob = new Function(
    "mailThread", "db", "tr", "msg", "mailView", "renderMailThreads", "renderMailReader", "mailJobNames",
    fnSrc + "\nreturn mailLinkJob;"
  )(mailThread, db, tr, msg, mailView, () => {}, () => {}, mailJobNames);
  return { mailLinkJob, t, mailView, msgCalls };
}

test("mailLinkJob() reads mail_link_thread's answer (for consistency), same as the other two", () => {
  const body = grab("mailLinkJob");
  assert.match(body, /const\s*\{\s*data:\s*linked\s*,\s*error\s*\}\s*=\s*await\s*db\.rpc\('mail_link_thread'/,
    "must destructure `data` alongside `error`, even though it is not branched on");
  // The comment is the whole point of item 3 in the brief: without it, a
  // future pass "simplifying" all three mail functions to look alike would
  // have a real reason to drop the checks in mailUnlinkJob/retireTemplate.
  assert.match(body, /benign/i);
  assert.match(body, /mailUnlinkJob/);
  assert.match(body, /retireBuildTemplate/);
});

test("linked=true (a fresh link) reports success", async () => {
  const { mailLinkJob, t, msgCalls } = await buildMailLinkJob(grab("mailLinkJob"), {
    rpcResult: { data: true, error: null },
  });
  await mailLinkJob("job-A");
  assert.ok(t.links.includes("job-A"));
  const last = msgCalls[msgCalls.length - 1];
  assert.equal(last.kind, "ok");
  assert.match(last.text, /mailLinkedOk/);
});

test("linked=false (ON CONFLICT DO NOTHING -- already linked) still reports success, not an error", async () => {
  const { mailLinkJob, t, msgCalls } = await buildMailLinkJob(grab("mailLinkJob"), {
    rpcResult: { data: false, error: null }, // exact shape mail_link_thread returns when the pair was already linked
  });
  await mailLinkJob("job-A");
  assert.ok(t.links.includes("job-A"), "the thread is linked to this job either way");
  const last = msgCalls[msgCalls.length - 1];
  assert.equal(last.kind, "ok", "false here is not a refusal -- the desired end state already holds");
  assert.match(last.text, /mailLinkedOk/);
  assert.ok(!msgCalls.some((m) => m.kind === "err"), "must never be shown as an error");
});

// =============================================================================
// PART 4 -- calendar drag-to-reschedule: the second shape
// =============================================================================

function makeCalDb(updateResult) {
  const state = { jobsUpdate: null };
  return {
    state,
    from: (table) => ({
      update: (patch) => ({
        eq: (col, val) => ({
          select: (cols) => {
            if (table === "jobs") state.jobsUpdate = { patch, col, val, cols };
            return Promise.resolve(updateResult);
          },
        }),
      }),
    }),
  };
}

test("rescheduleJobToDate() reads the write back with .select('id') before reporting a move", () => {
  const body = grab("rescheduleJobToDate");
  assert.match(body, /\.update\(\{\s*scheduled_date:\s*iso\s*\}\)\.eq\('id',\s*jobId\)\.select\('id'\)/);
  assert.match(body, /moved:\s*!!\(data\s*&&\s*data\.length\)/);
});

test("a real move (row comes back) reports moved:true", async () => {
  const db = makeCalDb({ data: [{ id: "j1" }], error: null });
  const rescheduleJobToDate = new Function("db", grab("rescheduleJobToDate") + "\nreturn rescheduleJobToDate;")(db);
  const res = await rescheduleJobToDate("j1", "2026-10-05T13:00:00.000Z");
  assert.equal(res.moved, true);
  assert.equal(res.error, undefined);
  assert.equal(db.state.jobsUpdate.patch.scheduled_date, "2026-10-05T13:00:00.000Z");
});

test("DEFECT: a zero-row RLS-filtered move reports moved:false, not an error and not silent success", async () => {
  const db = makeCalDb({ data: [], error: null }); // exact PostgREST shape of an RLS-filtered UPDATE
  const rescheduleJobToDate = new Function("db", grab("rescheduleJobToDate") + "\nreturn rescheduleJobToDate;")(db);
  const res = await rescheduleJobToDate("j1", "2026-10-05T13:00:00.000Z");
  assert.equal(res.moved, false);
  assert.equal(res.error, undefined);
});

test("the drop handler does not paint job.scheduled_date when rescheduleJobToDate reports moved:false", () => {
  // The handler is an inline arrow passed to addEventListener inside
  // renderCal(), not its own named function, so this checks its source
  // directly rather than re-deriving a DOM drag-and-drop event.
  const cal = grab("renderCal");
  const start = cal.indexOf("dayEl.addEventListener('drop'");
  assert.ok(start > 0, "the drop handler must still be there");
  const handler = cal.slice(start, cal.indexOf("});", start) + 3);
  assert.match(handler, /const\s*\{\s*moved\s*,\s*error\s*\}\s*=\s*await\s*rescheduleJobToDate\(job\.id,\s*iso\)/);
  assert.match(handler, /if\s*\(\s*!moved\s*\)\s*\{\s*renderCal\(\);\s*return;\s*\}/,
    "must bail out before the unconditional `job.scheduled_date=iso` when nothing moved");
  // The unconditional assignment must come strictly after the !moved guard.
  const guardAt = handler.indexOf("if(!moved)");
  const assignAt = handler.indexOf("job.scheduled_date=iso");
  assert.ok(guardAt > 0 && assignAt > guardAt, "the guard must run before the optimistic paint");
});

test("PLANTED FAILURE: the pre-fix drop handler paints the dropped-on date with no row-count check", () => {
  const oldHandler = `dayEl.addEventListener('drop',async e=>{
      e.preventDefault();
      dayEl.classList.remove('drop');
      const id=e.dataTransfer.getData('text/plain');
      const job=jobs.find(j=>String(j.id)===String(id));
      if(!job || !canEdit()) return;
      let hh=8, mm=0;
      if(job.scheduled_date){
        const old=d(job.scheduled_date);
        hh=old.getHours(); mm=old.getMinutes();
      }
      const [ny,nm,nd]=dayEl.dataset.date.split('-').map(Number);
      const next=new Date(ny, nm-1, nd, hh, mm);
      const iso=next.toISOString();
      const { error } = await db.from('jobs').update({scheduled_date: iso}).eq('id', job.id);
      if(error){ console.error(error); renderCal(); return; }
      job.scheduled_date=iso;
      renderCal();
    });`;
  // This is the bug: no .select(), so a zero-row RLS-filtered update comes
  // back with neither an error nor a way to tell -- and the old code paints
  // the date unconditionally right after.
  assert.doesNotMatch(oldHandler, /\.select\(/, "sanity: the plant has no way to read the write back");
  assert.doesNotMatch(oldHandler, /moved/, "sanity: the plant has no notion of whether anything actually moved");
  // The exact checks the fixed-code test above requires must fail against
  // this reconstruction -- proving that test would have caught it.
  assert.doesNotMatch(oldHandler, /const\s*\{\s*moved\s*,\s*error\s*\}\s*=\s*await\s*rescheduleJobToDate\(job\.id,\s*iso\)/);
  assert.doesNotMatch(oldHandler, /if\s*\(\s*!moved\s*\)\s*\{\s*renderCal\(\);\s*return;\s*\}/);
});
