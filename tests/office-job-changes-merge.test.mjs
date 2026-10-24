// OWNER LIST F2, office half: "merge 'Drawing changes since approval' with
// 'Changes from the field' into one section that looks good and saves space."
//
// The phone's half is pinned by tests/a21-feeds-merge-permissions.test.mjs,
// which is a static read of Kotlin. This is the office half, in
// website/dashboard.html, and it does not stop at reading the source: the
// field-changes renderer and the one function that decides whether the merged
// section is on screen are LIFTED OUT OF THE SHIPPED FILE and run, the same
// idiom tests/a7-dashboard-money-regressions.test.mjs and
// tests/downstream-pay-overtime.test.mjs use.
//
// What it is here to catch, in order of how badly it would hurt:
//
//  1. THE MERGE HIDING ONE HALF. Before the merge each feed owned its own
//     panel, and the withdrawn-approval half hid that panel when it had no
//     rows -- which is most jobs. Sharing one panel means that line now hides
//     the FIELD half too, on almost every job: the new section would simply
//     never appear and would look like it was never built. Section 3 runs the
//     real visibility function against exactly that case, with a planted
//     failure that reproduces the old behaviour.
//  2. INFORMATION DROPPED IN THE MOVE. A merge that saves space by leaving
//     out a column is not a merge. Section 2 asserts every non-empty field of
//     a field_changes row reaches the screen.
//  3. THE ONE ACTION BUTTON LOST. The drawing half carries "Put this drawing
//     back"; the field half carries no office action and never did. Section 4
//     asserts the first survived with its gate intact and that the second did
//     not quietly grow one.
//
// Run: node tests/office-job-changes-merge.test.mjs

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " -- " + detail : ""}`); }
};

const src = readFileSync("website/dashboard.html", "utf8");

const grabFn = (name) => {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("not found: " + name);
  let depth = 0;
  for (let j = src.indexOf("{", src.indexOf(")", start)); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
};
const count = (needle) => src.split(needle).length - 1;

// The real English table, lifted rather than guessed, so every assertion below
// compares against the words the page actually ships. Comparing against a
// hand-typed copy of a label is how a translation silently breaks a test that
// still passes.
const tlStart = src.indexOf("const TL = {");
let tlDepth = 0, tlEnd = -1;
for (let i = src.indexOf("{", tlStart); i < src.length; i++) {
  if (src[i] === "{") tlDepth++;
  else if (src[i] === "}") { tlDepth--; if (!tlDepth) { tlEnd = i + 1; break; } }
}
const TL = eval("(" + src.slice(src.indexOf("{", tlStart), tlEnd) + ")");
const trIn = (lang) => (k, ...a) => {
  let t = TL[lang][k] ?? k;
  for (const v of a) t = String(t).replace("%s", v);
  return t;
};
const tr = trIn("en");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ===========================================================================
console.log("\n0. positive controls -- the harness can see the file and the file is the real one:");
// ===========================================================================
{
  ok("sanity: dashboard.html read in full (a truncated or unreadable file would false-pass everything below)",
    src.length > 1_000_000, `length=${src.length}`);
  ok("sanity: the English translation table was really evaluated, not matched empty",
    TL && TL.en && Object.keys(TL.en).length > 300, `en keys=${TL && TL.en ? Object.keys(TL.en).length : 0}`);
  // The absence checks in section 1 only mean something if this id idiom is
  // one the file genuinely uses.
  ok("the panel-id idiom used by the absence checks below is real in this file (#panelChangeOrders exists)",
    count('id="panelChangeOrders"') === 1);
}

// ===========================================================================
console.log("\n1. ONE section, not two -- and both feeds live inside it:");
// ===========================================================================
{
  ok("the merged section exists exactly once in the markup, as #jobChangesPanel",
    count('id="jobChangesPanel"') === 1, `found ${count('id="jobChangesPanel"')}`);
  ok("the withdrawn-approval half no longer has a panel of its own: #reapprovalHistoryPanel is gone from the markup",
    count('id="reapprovalHistoryPanel"') === 0, `found ${count('id="reapprovalHistoryPanel"')}`);
  ok("and nothing in the script still reaches for that removed panel by id " +
     "(a $('reapprovalHistoryPanel') left behind would be null and throw where it is used)",
    count("reapprovalHistoryPanel") === 0, `mentions=${count("reapprovalHistoryPanel")}`);

  // Both halves' containers, and the waiting strip, have to be INSIDE the one
  // panel -- a container that drifted outside it would render in the wrong
  // place while every id check above still passed.
  const panelStart = src.indexOf('<div class="panel" id="jobChangesPanel"');
  const panelEnd = src.indexOf("</div>", src.indexOf('id="reapprovalHistoryMsg"'));
  const panel = src.slice(panelStart, panelEnd);
  ok("the field-changes rows (#jobFieldChangeRows) are inside the merged panel",
    panel.includes('id="jobFieldChangeRows"'));
  ok("the withdrawn-approval rows (#reapprovalHistoryRows) are inside the same panel",
    panel.includes('id="reapprovalHistoryRows"'));
  ok("the waiting strip (#jobChangesWaiting) is inside it too, outside the two columns, " +
     "so a crew member waiting on an answer is never buried in one column's history",
    panel.includes('id="jobChangesWaiting"') &&
    panel.indexOf('id="jobChangesWaiting"') < panel.indexOf('class="chg-cols"'));
  ok("the restore-outcome line (#reapprovalHistoryMsg) is still in the panel, " +
     "so a restore that landed still has somewhere to say so",
    panel.includes('id="reapprovalHistoryMsg"'));
  ok("the two halves sit in one responsive two-column grid, and an empty half is taken out of flow " +
     "so the surviving half gets the whole width instead of half of it beside a blank",
    /\.chg-cols\{[^}]*grid-template-columns:repeat\(auto-fit/.test(src) &&
    src.includes(".chg-cols>div:empty{display:none}"));

  // Both halves keep their own name as a sub-heading rather than being poured
  // into one undifferentiated list -- they are not the same kind of thing.
  ok("each half keeps its own sub-heading: the drawing half reuses its old panel title verbatim " +
     `("${TL.en.reapprovalHistoryTitle}")`,
    grabFn("reapprovalHalfHead").includes("tr('reapprovalHistoryTitle')"));
  ok(`the field half is headed with the owner's own name for it ("${TL.en.jobChangesFieldHead}")`,
    grabFn("fieldHalfHead").includes("tr('jobChangesFieldHead')"));
  for (const lang of ["en", "es", "fr"]) {
    const keys = ["jobSecChanges", "jobChangesBody", "jobChangesFieldHead", "jobChangesWaitingHead",
                  "jobChangesWaitingBody", "jobChangesRaisedBy", "jobChangesAnsweredBy",
                  "jobChangesSeenOn", "jobChangesFieldLoadFailed"];
    const missing = keys.filter(k => !TL[lang] || !TL[lang][k]);
    ok(`every string the merged section adds is in the ${lang} table (a missing one falls back to English silently)`,
      missing.length === 0, `missing: ${missing.join(", ")}`);
  }
}

// ===========================================================================
console.log("\n2. The field half, run for real -- nothing the crew wrote is dropped:");
// ===========================================================================

// A DOM small enough to be obviously honest: four boxes with the four ids the
// shipped code writes to.
function fakeDom() {
  const boxes = {
    jobChangesWaiting: { innerHTML: "" },
    jobFieldChangeRows: { innerHTML: "" },
    reapprovalHistoryRows: { innerHTML: "" },
    reapprovalHistoryMsg: { innerHTML: "", textContent: "" },
    jobChangesPanel: { style: { display: "none" }, innerHTML: "" },
  };
  return { boxes, $: (id) => boxes[id] };
}

// jobFieldChanges is a module-level `let` in the page; passed in as a parameter
// here so the lifted code reads the fixture instead.
function runRender(rows, { syncSrc = grabFn("syncJobChangesPanel") } = {}) {
  const dom = fakeDom();
  const code = grabFn("fieldChangeIsWaiting") + "\n" + grabFn("fieldHalfHead") + "\n"
    + grabFn("renderJobFieldChanges") + "\n" + syncSrc;
  new Function("$", "d", "esc", "tr", "jobFieldChanges", code + "\nrenderJobFieldChanges();")(
    dom.$, (x) => new Date(x), esc, tr, rows);
  return dom;
}

const REPORT = {
  id: "fc-1", at: "2026-03-04T15:00:00Z", summary: "Run A came out 12 ft longer",
  detail: "Neighbour's shed is not where the survey has it", changed_by: "John Rivera",
  changed_by_role: "FOREMAN", acknowledged_at: "2026-03-05T09:00:00Z",
  is_request: false, approved_at: null, rejected_at: null, decided_by: "", decision_note: "",
};
const WAITING_REQUEST = {
  id: "fc-2", at: "2026-03-06T13:30:00Z", summary: "Move the gate to the far corner?",
  detail: "Driveway slopes too hard where it is drawn", changed_by: "Marc Henry",
  changed_by_role: "CREW", acknowledged_at: null,
  is_request: true, approved_at: null, rejected_at: null, decided_by: "", decision_note: "",
};
const SETTLED_REQUEST = {
  id: "fc-3", at: "2026-03-02T11:00:00Z", summary: "Add a second gate",
  detail: "Customer asked on site", changed_by: "John Rivera", changed_by_role: "FOREMAN",
  acknowledged_at: null, is_request: true, approved_at: "2026-03-02T12:00:00Z", rejected_at: null,
  decided_by: "Marc Henry", decision_note: "Priced as a change order",
};

{
  const dom = runRender([WAITING_REQUEST, REPORT, SETTLED_REQUEST]);
  const waitHtml = dom.boxes.jobChangesWaiting.innerHTML;
  const colHtml = dom.boxes.jobFieldChangeRows.innerHTML;

  ok("a request still waiting on a decision is pinned to the waiting strip above both halves, " +
     "not left in the settled column",
    waitHtml.includes(esc(WAITING_REQUEST.summary)) && !colHtml.includes(esc(WAITING_REQUEST.summary)),
    `wait: ${waitHtml.slice(0, 200)}`);
  ok("the waiting strip says, in the page's own words, where the answer has to be given -- " +
     `"${TL.en.jobChangesWaitingHead}" / the phone app`,
    waitHtml.includes(esc(tr("jobChangesWaitingHead"))) && waitHtml.includes(esc(tr("jobChangesWaitingBody"))),
    `wait: ${waitHtml.slice(0, 300)}`);

  // Nothing dropped: every non-empty column of a field_changes row reaches the
  // screen. This is the check that would catch a merge that "saved space" by
  // leaving a column out.
  const shown = (needle) => (waitHtml + colHtml).includes(needle);
  for (const [what, needle] of [
    ["the summary", esc(REPORT.summary)],
    ["the longer detail", esc(REPORT.detail)],
    ["who raised it", esc(tr("jobChangesRaisedBy", REPORT.changed_by))],
    ["the role they raised it as", esc(REPORT.changed_by_role)],
    ["whether it was a report or a question", esc(tr("repScReported"))],
    ["that it has been marked seen", esc(tr("jobChangesSeenOn", new Date(REPORT.acknowledged_at).toLocaleDateString()))],
    ["the date it came in", new Date(REPORT.at).toLocaleDateString()],
  ]) ok(`a crew REPORT keeps ${what}`, shown(needle), `looked for: ${needle}`);

  for (const [what, needle] of [
    ["who answered it", esc(tr("jobChangesAnsweredBy", SETTLED_REQUEST.decided_by))],
    ["the note they answered with", esc(SETTLED_REQUEST.decision_note)],
    ["that it was approved", esc(tr("repScApproved"))],
    ["that it was a question, not a report", esc(tr("repScAsked"))],
  ]) ok(`a DECIDED crew request keeps ${what}`, shown(needle), `looked for: ${needle}`);

  // CANARY: the same renderer, handed nothing, must produce nothing -- so the
  // "it is all on screen" checks above are reading output this function really
  // built from the fixture, not boilerplate it prints either way.
  const empty = runRender([]);
  ok("CANARY: with no field changes the same renderer writes nothing at all into either box -- " +
     "so the checks above are reading the fixture's own content, not a fixed template",
    empty.boxes.jobChangesWaiting.innerHTML === "" && empty.boxes.jobFieldChangeRows.innerHTML === "",
    `wait=${JSON.stringify(empty.boxes.jobChangesWaiting.innerHTML)} col=${JSON.stringify(empty.boxes.jobFieldChangeRows.innerHTML)}`);

  // A row with only a summary must not print empty "Raised by" / "Answered by"
  // lines -- the page's own habit everywhere else.
  const bare = runRender([{ id: "fc-4", at: "2026-03-07T10:00:00Z", summary: "Post hole hit rock",
    detail: "", changed_by: "", changed_by_role: "", acknowledged_at: null,
    is_request: false, approved_at: null, rejected_at: null, decided_by: "", decision_note: "" }]);
  const bareHtml = bare.boxes.jobFieldChangeRows.innerHTML;
  ok("a row the app left half-empty prints no blank 'Raised by' or 'Answered by' line",
    bareHtml.includes(esc("Post hole hit rock"))
    && !bareHtml.includes(esc(tr("jobChangesRaisedBy", "")))
    && !bareHtml.includes(esc(tr("jobChangesAnsweredBy", ""))),
    `html: ${bareHtml}`);
}

// ===========================================================================
console.log("\n3. The merge must not hide either half -- visibility, run for real:");
// ===========================================================================
{
  const runSync = (fill, syncSrc = grabFn("syncJobChangesPanel")) => {
    const dom = fakeDom();
    Object.assign(dom.boxes.jobChangesWaiting, { innerHTML: fill.waiting || "" });
    Object.assign(dom.boxes.jobFieldChangeRows, { innerHTML: fill.field || "" });
    Object.assign(dom.boxes.reapprovalHistoryRows, { innerHTML: fill.drawing || "" });
    Object.assign(dom.boxes.reapprovalHistoryMsg, { textContent: fill.note || "" });
    new Function("$", syncSrc + "\nsyncJobChangesPanel();")(dom.$);
    return dom.boxes.jobChangesPanel.style.display;
  };

  ok("THE REGRESSION THE MERGE COULD HAVE SHIPPED: a job with field changes but NO withdrawn " +
     "approval -- which is nearly every job that has either -- shows the section",
    runSync({ field: "<div>a field change</div>" }) === "block");
  ok("a job with a withdrawn approval and no field changes still shows it, exactly as before the merge",
    runSync({ drawing: "<div>a withdrawn approval</div>" }) === "block");
  ok("a crew request waiting on an answer shows it even when both columns are empty",
    runSync({ waiting: "<div>waiting</div>" }) === "block");
  ok("a restore outcome shows it even with nothing else in either half, so that sentence is never lost",
    runSync({ note: "The drawing is back to how it was" }) === "block");
  ok("and with genuinely nothing on either side it stays hidden -- which is most jobs, and is the " +
     "'saves space' half of what was asked for",
    runSync({}) === "none");

  // Section 3's runtime checks prove the shipped RULE is right. This one
  // proves the rule is actually in charge at the one call site that used to
  // decide for itself: the drawing half's "this job has no withdrawn approval"
  // branch, which before the merge hid its own panel there and would now take
  // the field half down with it on nearly every job.
  const loadHistSrc = grabFn("loadReapprovalHistory");
  const emptyBranch = loadHistSrc.slice(
    loadHistSrc.indexOf("if (!data || !data.length) {"),
    loadHistSrc.indexOf("reapprovalRows = data;"));
  // CODE ONLY. The branch carries a comment that spells out the line it no
  // longer runs ("NOT panel.style.display = 'none' any more"), and a regex over
  // the raw text matched the comment and called correct code broken -- the
  // oldest way a source probe lies. Comments are stripped before the test.
  const codeOf = (s) => s.split("\n").map(l => l.replace(/\/\/.*$/, "")).join("\n");
  const emptyCode = codeOf(emptyBranch);
  ok("sanity: the drawing half's empty branch was located in the shipped source, and stripping its " +
     "comments left real code behind (an empty slice would false-pass the check below)",
    emptyCode.includes("reapprovalRows = []"), `slice length=${emptyCode.length}`);
  ok("that branch no longer hides the shared panel on its own -- it hands the decision to " +
     "syncJobChangesPanel(), which looks at both halves",
    !/panel\.style\.display\s*=\s*'none'/.test(emptyCode) && emptyCode.includes("syncJobChangesPanel()"),
    `empty branch code: ${emptyCode.replace(/\s+/g, " ").slice(0, 300)}`);

  // CANARY (planted failure): the pre-merge rule, where the drawing half alone
  // decided the panel. It must hide the section on a job that has field
  // changes -- the exact bug section 3 exists to forbid.
  const PRE_MERGE_SYNC =
    "function syncJobChangesPanel(){ const el = $('reapprovalHistoryRows');" +
    " $('jobChangesPanel').style.display = (el && el.innerHTML.trim()) ? 'block' : 'none'; }";
  ok("CANARY: the pre-merge rule (the drawing half deciding alone) hides the section on a job that " +
     "has field changes -- proving the first check above can fail and is not vacuous",
    runSync({ field: "<div>a field change</div>" }, PRE_MERGE_SYNC) === "none");
  ok("CANARY: that same pre-merge rule still shows it for a withdrawn approval, so the canary " +
     "differs from the shipped rule only in the case that matters",
    runSync({ drawing: "<div>a withdrawn approval</div>" }, PRE_MERGE_SYNC) === "block");
}

// ===========================================================================
console.log("\n4. Actions: the one the drawing half had survived; the field half did not grow one:");
// ===========================================================================
{
  const loadHist = grabFn("loadReapprovalHistory");
  ok("the drawing half still offers its restore button, by the same data-reapprestore hook its " +
     "click handler listens for",
    loadHist.includes("data-reapprestore=") && loadHist.includes("tr('reapprovalRestoreBtn')"));
  ok("the button is still decided per row by reapprovalRestoreState(), not by the merge",
    loadHist.includes("reapprovalRestoreState(row, job)"));
  ok("and its two job-wide gates are untouched: the job must actually be waiting on a re-approval, " +
     "and the account must be able to edit",
    loadHist.includes("!job.reapproval_required_at ? 'notpending' : !canEdit() ? 'noedit' : ''"));
  ok("the click handler that performs the restore still exists and still reads that hook",
    src.includes("btn.dataset.reapprestore"));

  // The field half has no office action and never did -- the alert on Home
  // sends the office to the phone app for the decision, because deciding needs
  // the drawing. If a button ever appears here it is a new product decision,
  // not a merge, and this is the line that will say so.
  const fieldRender = grabFn("renderJobFieldChanges");
  ok("the field half renders no button, link or form control: it shows the request and says where to " +
     "answer it, which is what the office could do before the merge too",
    !/<button|<a |<input|<select/i.test(fieldRender), "a control appeared in renderJobFieldChanges");
  ok("the field half reads field_changes and never writes it (no insert/update/upsert/delete anywhere " +
     "in the loader or the renderer)",
    !/\.(insert|update|upsert|delete)\(/.test(grabFn("loadJobFieldChanges") + fieldRender));
  ok("no money column is read into this section -- the drawing half's prior_contract_total stays " +
     "behind canSeeMoney(), and the field half has no money in it at all",
    loadHist.includes("row.prior_contract_total != null && canSeeMoney()") &&
    !/contract_total|deposit|amount_paid|money\(/.test(grabFn("loadJobFieldChanges") + fieldRender));

  // A failed read must not look like a job with nothing on it -- the mistake
  // the drawing half had already been fixed for once.
  const loadField = grabFn("loadJobFieldChanges");
  ok("a field_changes read that FAILED says so, instead of leaving through the same door as a job " +
     "that genuinely has no field changes",
    loadField.includes("tr('jobChangesFieldLoadFailed', error.message)"));
  ok("it is fetched per job rather than filtered out of loadAll()'s recent-window list, so an old " +
     "job's field changes are not silently missing",
    loadField.includes("db.from('field_changes')") && loadField.includes("eq('job_sync_id', job.sync_id)")
    && !loadField.includes("fieldChanges.filter"));
  ok("and the previous job's rows are cleared before the fetch, so they are never on screen under " +
     "this job's name",
    loadField.indexOf("box.innerHTML = ''") < loadField.indexOf("await db.from('field_changes')"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
