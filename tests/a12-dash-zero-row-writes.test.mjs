// DEFECT (this wave) -- website/dashboard.html's saveSettings() wrote
// companies.email and judged the result on the absence of an error alone.
// companies_update is `for update using (id = current_company_id() and
// current_user_role() = 'OWNER')` with no separate WITH CHECK
// (supabase_schema.sql) -- Postgres RLS applies that USING clause on UPDATE
// as a plain row filter, so a row it excludes is simply not in the affected
// set: no exception, no error field, PostgREST answers with `data: []` and
// `error: null`. The one moment this owner's OWN session can lose the row is
// being demoted to MANAGER or CREW by someone else while this page sits open
// -- current_user_role() is read fresh on the SERVER for every request, but
// the client's cached profile.role still says OWNER, so saveSettings() still
// takes the write-email branch and reports the save as done. Same shape as
// the admin console's own company save (tests/a10-admin-save-zero-rows.
// test.mjs) and this file's saveFixTime/saveJob/recordFirstContact/saveEmp,
// which already read the row back.
//
// The sweep this wave did across every other direct table write in
// website/dashboard.html found two more of the identical shape, both fixed
// here too, each from ONE definition rather than patched at every call site
// (the file's own established convention -- see the labour-floor and
// deposit-cap fixes DEFECT 1/3 in tests/a7-dashboard-money-regressions.
// test.mjs):
//
//   - wizPatchJob(), the ONE function every setup-wizard step routes its job
//     patch through, destructured only {error} at all nine call sites and
//     never asked whether .select().maybeSingle() actually came back with a
//     row. A wizard step that changed nothing on the server (job deleted or
//     moved to another company since the wizard opened it) still advanced
//     to the next step as if it had saved.
//   - applyJobBatch(), the batch "assign crew" / "reschedule" bar, updated
//     with .in('id', ids) and no .select() at all, then printed an exact
//     count ("3 jobs scheduled for 10/1") no matter how many of those ids
//     the write actually touched.
//
// Same grab()/new Function() idiom as tests/a7-dashboard-money-regressions.
// test.mjs, tests/a8-company-email-guard.test.mjs and
// tests/a10-admin-save-zero-rows.test.mjs -- these run the REAL functions
// lifted out of website/dashboard.html, not a reimplementation that could
// silently drift from what ships. Every behavioural claim below is paired
// with a PLANTED FAILURE that reconstructs this file's own pre-fix code
// (the exact text website/dashboard.html carried before this wave -- see its
// git history) and proves this same test would have caught it -- a check
// that cannot go red is not a check (see MEMORY.md "Audit blind spots").
//
// Run:
//   node tests/a12-dash-zero-row-writes.test.mjs
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
  let start = src.indexOf("const " + name + "=");
  if (start < 0) start = src.indexOf("const " + name + " =");
  if (start < 0) throw new Error("not found: " + name);
  const end = src.indexOf(";\n", start);
  if (end < 0) throw new Error("no terminator for: " + name);
  return src.slice(start, end + 1);
};

const fakeEl = (props = {}) => ({ value: "", textContent: "", disabled: false, checked: false, ...props });
const tr = (key, ...args) => key + (args.length ? "|" + args.join("|") : "");

// =============================================================================
// PART 1 -- saveSettings() and companies.email
// =============================================================================

// Hybrid stand-in: offers BOTH .select(...) (the fixed code's chain) and its
// own .then (the pre-fix code just awaits .eq(...) directly), so the same
// mock runs the real fixed function and the PLANTED FAILURE's reconstructed
// old one without two different fakes. Same trick as tests/a8-company-
// email-guard.test.mjs's makeAdminDb, which explains why it is needed.
function makeSettingsDb(updateResult) {
  const state = { companiesUpdate: null };
  return {
    state,
    rpc: (name) => {
      if (name === "save_company_settings") return Promise.resolve({ error: null });
      if (name === "my_setup_progress") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: null, error: null });
    },
    from: (table) => ({
      update: (patch) => ({
        eq: (col, val) => {
          if (table === "companies") state.companiesUpdate = { patch, col, val };
          return {
            select: () => Promise.resolve(updateResult),
            then: (res, rej) => Promise.resolve({ error: updateResult.error ?? null }).then(res, rej),
          };
        },
      }),
    }),
  };
}

function buildSaveSettings(fnSrc, { emailValue, updateResult }) {
  const els = { s_email: fakeEl({ value: emailValue }) };
  const $ = (id) => els[id] || (els[id] = fakeEl());
  const db = makeSettingsDb(updateResult);
  const profile = { role: "OWNER", company_id: "co-1" };
  const msgCalls = [];
  const msg = (el, text, kind) => { msgCalls.push({ el, text, kind }); };
  const saveSettings = new Function(
    "canEdit", "$", "db", "profile", "msg", "tr", "buildTemplates", "renderSetup",
    grabConst("SET") + "\n" + grabConst("SET_NUM") + "\n" + fnSrc + "\nreturn saveSettings;"
  )(() => true, $, db, profile, msg, tr, [], () => {});
  return { saveSettings, db, msgCalls };
}

test("saveSettings() reads back companies.email with .select('id') before claiming the save happened", () => {
  const body = grab("saveSettings");
  assert.match(
    body,
    /\.update\(\{\s*email:\s*newEmail\s*\}\)\s*\.eq\('id',\s*profile\.company_id\)\.select\('id'\)/,
    "the companies update must chain .select('id') so PostgREST returns the rows it actually touched"
  );
  assert.match(
    body,
    /if\s*\(\s*!savedEmailRows\s*\|\|\s*!savedEmailRows\.length\s*\)/,
    "saveSettings must explicitly check for an empty result before treating the email write as done"
  );
});

test("a real one-row save reports success with no zero-rows message", async () => {
  const { saveSettings, db, msgCalls } = await buildSaveSettings(grab("saveSettings"), {
    emailValue: "owner@fenceflow.com",
    updateResult: { data: [{ id: "co-1" }], error: null },
  });
  await saveSettings();
  assert.equal(db.state.companiesUpdate?.patch.email, "owner@fenceflow.com");
  const last = msgCalls[msgCalls.length - 1];
  assert.doesNotMatch(last.text, /settingsEmailSaveNoRowsMsg/);
  assert.equal(last.kind, "ok");
});

test("DEFECT: an RLS-filtered zero-row update -- as a mid-session demotion produces -- is NOT reported as success", async () => {
  const { saveSettings, msgCalls } = await buildSaveSettings(grab("saveSettings"), {
    emailValue: "owner@fenceflow.com",
    updateResult: { data: [], error: null }, // exact PostgREST shape of an RLS-filtered UPDATE: no error, no rows
  });
  await saveSettings();
  const last = msgCalls[msgCalls.length - 1];
  assert.match(
    last.text, /settingsEmailSaveNoRowsMsg/,
    "the owner must be told the email did not save, naming a likely cause -- not told it saved"
  );
  assert.equal(last.kind, "err");
});

test("a null data array (same shape) is also NOT reported as success", async () => {
  const { saveSettings, msgCalls } = await buildSaveSettings(grab("saveSettings"), {
    emailValue: "owner@fenceflow.com",
    updateResult: { data: null, error: null },
  });
  await saveSettings();
  const last = msgCalls[msgCalls.length - 1];
  assert.match(last.text, /settingsEmailSaveNoRowsMsg/);
  assert.equal(last.kind, "err");
});

test("PLANTED FAILURE: the pre-fix saveSettings reports the email saved on a zero-row RLS-filtered update", async () => {
  const real = grab("saveSettings");
  // Exactly what website/dashboard.html carried before this wave's fix: no
  // .select(), so the only thing checked is `error`.
  const old = real.replace(
    /\/\/ \.select\('id'\) so the save is judged[\s\S]*?const \{ data: savedEmailRows, error: emailErr \} = await db\.from\('companies'\)\s*\n\s*\.update\(\{ email: newEmail \}\)\.eq\('id', profile\.company_id\)\.select\('id'\);\s*\n\s*if \(emailErr\) return msg\('setMsg', emailErr\.message, 'err'\);\s*\n\s*if \(!savedEmailRows \|\| !savedEmailRows\.length\) return msg\('setMsg', tr\('settingsEmailSaveNoRowsMsg'\), 'err'\);\s*\n/,
    "      const { error: emailErr } = await db.from('companies').update({ email: newEmail }).eq('id', profile.company_id);\n" +
    "      if (emailErr) return msg('setMsg', emailErr.message, 'err');\n"
  );
  assert.notEqual(old, real, "the plant must actually change the function");
  assert.doesNotMatch(old, /savedEmailRows/, "sanity: the plant must remove the row-count check entirely");

  const { saveSettings, msgCalls } = await buildSaveSettings(old, {
    emailValue: "owner@fenceflow.com",
    updateResult: { error: null }, // the pre-fix code never calls .select(), so it only ever sees this
  });
  await saveSettings();
  const last = msgCalls[msgCalls.length - 1];
  // This is the bug: a write RLS matched zero rows against is reported
  // exactly like a real save.
  assert.equal(last.kind, "ok", "sanity: the pre-fix code really does report success here");
  assert.doesNotMatch(last.text, /settingsEmailSaveNoRowsMsg/, "sanity: this key does not even exist to the pre-fix code");
});

// =============================================================================
// PART 2 -- wizPatchJob(), the wizard's one job-patch chokepoint
// =============================================================================

function makeWizDb(updateResult) {
  const state = { jobsUpdate: null };
  return {
    state,
    from: (table) => ({
      update: (patch) => ({
        eq: (col, val) => ({
          select: () => ({
            maybeSingle: () => {
              if (table === "jobs") state.jobsUpdate = { patch, col, val };
              return Promise.resolve(updateResult);
            },
          }),
        }),
      }),
    }),
  };
}

function buildWizPatchJob(fnSrc, { updateResult, jobId = "j1" }) {
  const wiz = { job: { id: jobId, sync_id: "sync-j1", wizard_step: 1, updated_at: "2026-01-01T00:00:00Z" } };
  const jobs = [wiz.job];
  const db = makeWizDb(updateResult);
  const wizPatchJob = new Function("wiz", "jobs", "db", "tr", fnSrc + "\nreturn wizPatchJob;")(wiz, jobs, db, tr);
  return { wizPatchJob, wiz, jobs, db };
}

test("wizPatchJob() reads back the job with .select().maybeSingle() and treats null as a failure", () => {
  const body = grab("wizPatchJob");
  assert.match(body, /\.select\(\)\.maybeSingle\(\)/, "must chain .select().maybeSingle() to get the affected row back");
  assert.match(body, /if\s*\(\s*!data\s*\)\s*return\s*\{\s*error:/, "must explicitly turn a null row into an error before merging it into wiz.job");
});

test("a real patch merges the returned row into wiz.job and the jobs array", async () => {
  const { wizPatchJob, wiz, jobs } = await buildWizPatchJob(grab("wizPatchJob"), {
    updateResult: { data: { id: "j1", sync_id: "sync-j1", wizard_step: 2, updated_at: "2026-01-02T00:00:00Z" }, error: null },
  });
  const { error, data } = await wizPatchJob({ wizard_step: 2 });
  assert.equal(error, undefined);
  assert.equal(data.wizard_step, 2);
  assert.equal(wiz.job.wizard_step, 2, "wiz.job must be updated from the row the server actually holds");
  assert.equal(jobs[0].wizard_step, 2);
});

test("DEFECT: a zero-row RLS-filtered patch (job deleted/moved since the wizard opened) is reported as an error, not silently accepted", async () => {
  const { wizPatchJob, wiz } = await buildWizPatchJob(grab("wizPatchJob"), {
    updateResult: { data: null, error: null }, // exact shape .maybeSingle() returns when nothing matched
  });
  const before = wiz.job.wizard_step;
  const { error } = await wizPatchJob({ wizard_step: 2 });
  assert.ok(error, "wizPatchJob must report a failure");
  assert.match(error.message, /wizSaveNothingChangedErr/);
  assert.equal(wiz.job.wizard_step, before, "wiz.job must not silently advance when nothing was actually written");
});

test("DEFECT, end to end: wizFinish() does NOT report success when the underlying patch changed nothing", async () => {
  const wiz = { job: { id: "j1", sync_id: "sync-j1", wizard_step: 5 } };
  const jobs = [wiz.job];
  const db = makeWizDb({ data: null, error: null });
  const msgCalls = [];
  const msg = (el, text, kind) => { msgCalls.push({ el, text, kind }); };
  const $ = () => fakeEl();
  const wizFinish = new Function(
    "wiz", "jobs", "db", "tr", "msg", "$",
    grab("wizPatchJob") + "\n" + grab("wizFinish") + "\nreturn wizFinish;"
  )(wiz, jobs, db, tr, msg, $);
  const result = await wizFinish();
  assert.equal(result, false, "wizFinish must report failure, not advance past the wizard");
  assert.match(msgCalls[msgCalls.length - 1].text, /wizSaveNothingChangedErr/);
});

test("PLANTED FAILURE: the pre-fix wizPatchJob silently accepts a zero-row update", async () => {
  const real = grab("wizPatchJob");
  const old = `async function wizPatchJob(patch){
  const { data, error } = await db.from('jobs').update(patch).eq('id', wiz.job.id).select().maybeSingle();
  if(error) return { error };
  Object.assign(wiz.job, data);
  const idx = jobs.findIndex(j2=>String(j2.id)===String(wiz.job.id));
  if(idx>=0) jobs[idx]=wiz.job; else jobs.push(wiz.job);
  return { data };
}`;
  assert.notEqual(old, real, "the plant must actually differ from the shipped function");
  assert.doesNotMatch(old, /if\(!data\)/, "sanity: the plant removes the null-row check entirely");

  const { wizPatchJob } = await buildWizPatchJob(old, { updateResult: { data: null, error: null } });
  const { error, data } = await wizPatchJob({ wizard_step: 2 });
  // This is the bug: a write that matched no row comes back with neither an
  // error nor any usable data, and the old code returns that as if it were
  // a normal (if empty) success -- every caller's `if(error){...}` guard
  // never fires.
  assert.equal(error, undefined, "sanity: the pre-fix code produces no error at all here");
  assert.equal(data, null);
});

// =============================================================================
// PART 3 -- applyJobBatch(), the Jobs tab's bulk assign/reschedule bar
// =============================================================================

function makeBatchDb(updateResult) {
  const state = { jobsUpdate: null };
  return {
    state,
    from: (table) => ({
      update: (patch) => ({
        in: (col, ids) => ({
          select: () => {
            if (table === "jobs") state.jobsUpdate = { patch, col, ids };
            return Promise.resolve(updateResult);
          },
        }),
      }),
    }),
  };
}

function buildApplyJobBatch(fnSrc, { selectedIds, updateResult }) {
  const jobSel = new Set(selectedIds);
  const db = makeBatchDb(updateResult);
  const msgCalls = [];
  const msg = (el, text, kind) => { msgCalls.push({ el, text, kind }); };
  const ask = async () => true;
  const loadAllCalls = { count: 0 };
  const loadAll = async () => { loadAllCalls.count++; };
  const applyJobBatch = new Function(
    "jobSel", "canEdit", "ask", "tr", "db", "msg", "loadAll",
    grab("jobsCountWords") + "\n" + fnSrc + "\nreturn applyJobBatch;"
  )(jobSel, () => true, ask, tr, db, msg, loadAll);
  return { applyJobBatch, db, msgCalls, loadAllCalls };
}

test("applyJobBatch() reads back the affected rows with .select('id') before claiming the batch count", () => {
  const body = grab("applyJobBatch");
  assert.match(body, /\.update\(patch\)\.in\('id',\s*ids\)\.select\('id'\)/);
  assert.match(body, /if\s*\(\s*changed\s*===\s*0\s*\)/, "must explicitly branch on zero rows changed");
});

test("all three selected jobs changing reports the full success message", async () => {
  const { applyJobBatch, msgCalls, loadAllCalls } = await buildApplyJobBatch(grab("applyJobBatch"), {
    selectedIds: ["1", "2", "3"],
    updateResult: { data: [{ id: "1" }, { id: "2" }, { id: "3" }], error: null },
  });
  const ok = await applyJobBatch({ scheduled_date: "2026-10-01" }, "Schedule 3 jobs?", "3 jobs scheduled.");
  assert.equal(ok, true);
  assert.deepEqual(msgCalls[msgCalls.length - 1], { el: "jobsMsg", text: "3 jobs scheduled.", kind: "ok" });
  assert.equal(loadAllCalls.count, 1);
});

test("DEFECT: none of the selected jobs matching (all removed/moved) is reported as failure, not as the batch's success line", async () => {
  const { applyJobBatch, msgCalls, loadAllCalls } = await buildApplyJobBatch(grab("applyJobBatch"), {
    selectedIds: ["1", "2", "3"],
    updateResult: { data: [], error: null }, // exact shape an all-RLS-filtered batch update returns
  });
  const ok = await applyJobBatch({ scheduled_date: "2026-10-01" }, "Schedule 3 jobs?", "3 jobs scheduled.");
  assert.equal(ok, false);
  const last = msgCalls[msgCalls.length - 1];
  assert.match(last.text, /jobBatchNothingChangedErr/);
  assert.equal(last.kind, "err");
  assert.equal(loadAllCalls.count, 0, "nothing changed, so there is nothing to reload");
});

test("a partial match (one of three jobs no longer eligible) is reported as partial, not as full success", async () => {
  const { applyJobBatch, msgCalls, loadAllCalls } = await buildApplyJobBatch(grab("applyJobBatch"), {
    selectedIds: ["1", "2", "3"],
    updateResult: { data: [{ id: "1" }, { id: "2" }], error: null },
  });
  const ok = await applyJobBatch({ scheduled_date: "2026-10-01" }, "Schedule 3 jobs?", "3 jobs scheduled.");
  assert.equal(ok, true, "two of three DID change, so this is not a total failure");
  const last = msgCalls[msgCalls.length - 1];
  assert.match(last.text, /jobBatchPartialMsg\|2\|3/);
  assert.equal(last.kind, "err", "a partial batch must not read exactly like the clean success message");
  assert.equal(loadAllCalls.count, 1, "reload so the screen shows which ones actually took");
});

test("PLANTED FAILURE: the pre-fix applyJobBatch reports the full count regardless of what the write actually touched", async () => {
  const real = grab("applyJobBatch");
  // Exactly what website/dashboard.html carried before this wave: no
  // .select(), so `done` (baked with the ORIGINAL selection count) is shown
  // unconditionally once there is no error.
  const old = `async function applyJobBatch(patch, question, done){
  const ids = [...jobSel];
  if(!ids.length || !canEdit()) return false;
  const ok = await ask({
    title: question,
    body: tr('jobBatchAskBody', ids.length),
    confirmLabel: tr('jobBatchAskBtn', ids.length),
  });
  if(!ok) return false;
  const { error } = await db.from('jobs').update(patch).in('id', ids);
  if(error){ msg('jobsMsg', error.message, 'err'); return false; }
  msg('jobsMsg', done, 'ok');
  await loadAll();
  return true;
}`;
  assert.notEqual(old, real, "the plant must actually differ from the shipped function");
  assert.doesNotMatch(old, /\.select\(/, "sanity: the plant removes the row-count check entirely");

  // makeBatchDb's chain ends in .select(); the pre-fix code never calls it,
  // so this plant needs one link fewer to resolve, ending at .in() instead.
  const jobSel = new Set(["1", "2", "3"]);
  const state = { jobsUpdate: null };
  const db = {
    state,
    from: (table) => ({
      update: (patch) => ({
        in: (col, ids) => {
          if (table === "jobs") state.jobsUpdate = { patch, col, ids };
          // The exact shape an all-RLS-filtered batch UPDATE returns: no
          // error, and (with no .select()) no data field to even look at.
          return Promise.resolve({ error: null });
        },
      }),
    }),
  };
  const msgCalls = [];
  const msg = (el, text, kind) => { msgCalls.push({ el, text, kind }); };
  const ask = async () => true;
  const loadAll = async () => {};
  const applyJobBatchOld = new Function(
    "jobSel", "canEdit", "ask", "tr", "db", "msg", "loadAll",
    old + "\nreturn applyJobBatch;"
  )(jobSel, () => true, ask, tr, db, msg, loadAll);

  const ok = await applyJobBatchOld({ scheduled_date: "2026-10-01" }, "Schedule 3 jobs?", "3 jobs scheduled.");
  // This is the bug: none of the three selected jobs actually changed (every
  // one filtered out by RLS), and the old code reports the full, exact
  // success line anyway.
  assert.equal(ok, true, "sanity: the pre-fix code really does report success here");
  assert.equal(msgCalls[msgCalls.length - 1].text, "3 jobs scheduled.");
});
