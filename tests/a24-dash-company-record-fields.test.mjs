// DEFECT -- website/dashboard.html's Business Settings panel could not change
// the business name, phone or licence number a CUSTOMER sees.
//
// s_businessName / s_phone / s_license went through the SET map into
// save_company_settings(), whose live body (pg_proc.prosrc, checked 29
// September, project newcrgafcptspmapacrx) only ever writes the
// company_settings JSONB blob and never touches `companies`. But
// companies.name / .phone / .license_no is what quote-view prints on the
// public quote page, what invite-crew puts on crew invitations, what
// send-follow-ups and mail's caller.ts send from, and the name
// create-payment-link and lead-intake read. Nothing but welcome.html's
// one-time onboarding step (complete_company_details) had ever written them,
// so an office that renamed itself kept quoting under the old name for ever
// while this panel said "Saved" each time. Live proof of the divergence, and
// of the RLS/trigger clearances for the fix, is in
// supabase_company_business_record.sql.
//
// WHAT THIS FILE GUARDS THAT THE OBVIOUS FIX WOULD HAVE BROKEN
//
// The obvious fix -- move the three fields to `companies` and delete them from
// the SET map, exactly as the email field was moved -- is wrong here, and the
// second half of this file is what says so. The blob's `email` key really was
// read by nothing; these three are read by the PHONE:
// SettingsSync.kt decodes business_name / phone / license_number into
// SettingsStore.BusinessProfile, and PdfExporter.kt prints all three in the
// header of every PDF quote and contract. my_setup_progress()'s 'business'
// step is `coalesce(trim(settings->>'business_name'),'') <> ''` -- the
// checklist line renderSetup() clears at the end of saveSettings() itself.
// Deleting the SET entries would have traded one dead control for another:
// the office could no longer change what its own phones print, and the setup
// checklist could never be completed from this page again. So the save
// MIRRORS: blob first (unchanged), companies second (new). Both halves are
// asserted below, each with a planted failure, because a mirror with one side
// silently dropped looks exactly like a working one from the other side.
//
// Same grab()/new Function() idiom as tests/a7-dashboard-money-regressions.
// test.mjs and tests/a12-dash-zero-row-writes.test.mjs -- the REAL
// loadSettings()/saveSettings() lifted out of dashboard.html, not a
// reimplementation. This file only READS website/dashboard.html.
//
// Run:
//   node --test tests/a24-dash-company-record-fields.test.mjs
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

const fakeEl = (props = {}) => ({ value: "", style: {}, textContent: "", ...props });

// =============================================================================
// PART 1 -- loadSettings() shows the value that is actually in effect
// =============================================================================

// The stand-in HONOURS the column list it is handed, rather than returning the
// whole row whatever is asked for. That is deliberate: PostgREST gives back
// only the columns named in .select(), so a fix that reads company.data.name
// without ADDING name to the select gets `undefined`, falls silently back to
// the blob, and is the original bug again wearing the fix's clothes. A
// stand-in that ignores the argument could not tell those two apart.
function makeLoadDb({ companyRow, settings }) {
  const state = { selected: null };
  return {
    state,
    from: (table) => ({
      select: (cols) => {
        if (table === "companies") state.selected = cols;
        return {
          eq: () => ({
            maybeSingle: () => {
              if (table === "company_settings") {
                return Promise.resolve({ data: { settings }, error: null });
              }
              const picked = {};
              for (const c of cols.split(",").map((c) => c.trim())) {
                if (c in companyRow) picked[c] = companyRow[c];
              }
              return Promise.resolve({ data: picked, error: null });
            },
          }),
        };
      },
    }),
  };
}

function buildLoadSettings(fnSrc, { companyRow, settings, role = "OWNER" }) {
  const els = {};
  const $ = (id) => els[id] || (els[id] = fakeEl());
  const db = makeLoadDb({ companyRow, settings });
  const profile = { role, company_id: "co-1" };
  const tr = (key) => key;
  const loadSettings = new Function(
    "$", "db", "profile", "tr",
    grabConst("SET") + "\n" + fnSrc + "\nreturn loadSettings;"
  )($, db, profile, tr);
  return { loadSettings, els, $, db };
}

// "Fence solutions" as it stands in production on 29 September: a real name on
// the companies row, a DIFFERENT name plus a real phone and licence in the
// blob, and '' in the companies phone/licence columns.
const liveShapedCase = () => ({
  companyRow: { email: "marc@fenceflowapp.com", name: "Fence solutions", phone: "", license_no: "" },
  settings: {
    business_name: "Legacy solutions", phone: "8135779310", license_number: "1234567890",
    owner_name: "Marc", tax_rate: 7,
  },
});

test("the business name box shows the customer-facing companies.name, not the blob's stale copy", async () => {
  const { loadSettings, els } = buildLoadSettings(grab("loadSettings"), liveShapedCase());
  await loadSettings();
  assert.equal(els.s_businessName.value, "Fence solutions",
    "the box must show the name a customer actually reads on the quote page today -- showing the blob's " +
    "copy is what let this field look set while every quote went out under a different name");
});

test("a blank companies column falls back to the phone's copy rather than showing an empty box over a real value", async () => {
  const { loadSettings, els } = buildLoadSettings(grab("loadSettings"), liveShapedCase());
  await loadSettings();
  assert.equal(els.s_phone.value, "8135779310",
    "companies.phone is '' for every company that has ever used this panel while a real number sits in the " +
    "blob -- reading companies alone would hide it behind an empty box, and the next save would skip it as " +
    "'not set'");
  assert.equal(els.s_license.value, "1234567890");
});

test("loadSettings asks the server for the columns it reads (a select that omits them reads undefined and silently falls back)", async () => {
  const { loadSettings, db } = buildLoadSettings(grab("loadSettings"), liveShapedCase());
  await loadSettings();
  for (const col of ["name", "phone", "license_no"]) {
    assert.match(db.state.selected, new RegExp("\\b" + col + "\\b"),
      `companies.${col} must be in the .select() list -- PostgREST returns only what is asked for`);
  }
});

test("PLANTED FAILURE: with the companies read dropped, the box shows the blob's stale name again", async () => {
  const real = grab("loadSettings");
  // Precisely the pre-fix state: the SET loop fills these three boxes from the
  // blob and nothing overrides them afterwards.
  const old = real.replace(
    /\n {4}const pick=\(col,key\)=>\{[\s\S]*?\n {4}const companyOwnerNote=\$\('s_companyOwnerNote'\);\n {4}if\(companyOwnerNote\)[^\n]*\n/,
    "\n"
  );
  assert.notEqual(old, real, "the plant must actually change the function");
  const { loadSettings, els } = buildLoadSettings(old, liveShapedCase());
  await loadSettings();
  assert.equal(els.s_businessName.value, "Legacy solutions",
    "sanity: the pre-fix code shows the blob's copy -- which is what the assertions above would miss if " +
    "they were passing for some other reason");
});

// =============================================================================
// PART 2 -- saveSettings() writes BOTH stores
// =============================================================================

function makeSaveDb() {
  const state = { companiesUpdates: [], rpcCalls: [] };
  return {
    state,
    rpc: (name, args) => {
      state.rpcCalls.push({ name, args });
      if (name === "save_company_settings") return Promise.resolve({ error: null });
      if (name === "my_setup_progress") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: null, error: null });
    },
    from: (table) => ({
      update: (patch) => ({
        eq: (col, val) => {
          if (table === "companies") state.companiesUpdates.push({ patch, col, val });
          const rows = { data: [{ id: val }], error: null };
          return {
            select: () => Promise.resolve(rows),
            then: (res, rej) => Promise.resolve({ error: null }).then(res, rej),
          };
        },
      }),
    }),
  };
}

function buildSaveSettings(fnSrc, { values = {}, role = "OWNER", setSrc = grabConst("SET") } = {}) {
  const els = {};
  for (const [id, value] of Object.entries(values)) els[id] = fakeEl({ value });
  const $ = (id) => els[id] || (els[id] = fakeEl());
  const db = makeSaveDb();
  const profile = { role, company_id: "co-1" };
  const msgCalls = [];
  const msg = (el, text, kind) => { msgCalls.push({ el, text, kind }); };
  const tr = (key, ...args) => key + (args.length ? "|" + args.join("|") : "");
  const saveSettings = new Function(
    "canEdit", "$", "db", "profile", "msg", "tr", "buildTemplates", "renderSetup",
    setSrc + "\n" + grabConst("SET_NUM") + "\n" + fnSrc + "\nreturn saveSettings;"
  )(() => true, $, db, profile, msg, tr, [], () => {});
  return { saveSettings, db, msgCalls };
}

const filledIn = {
  s_email: "office@fencesolutions.com",
  s_businessName: "Fence Solutions LLC",
  s_phone: "813-577-9310",
  s_license: "FL-CFC-99213",
};

const recordPatchOf = (db) =>
  db.state.companiesUpdates.map((u) => u.patch).find((p) => "name" in p || "phone" in p || "license_no" in p);
const settingsPayloadOf = (db) =>
  db.state.rpcCalls.find((c) => c.name === "save_company_settings")?.args?.new_settings;

test("an OWNER's save reaches companies.name/.phone/.license_no -- the record the customer's quote page prints", async () => {
  const { saveSettings, db } = buildSaveSettings(grab("saveSettings"), { values: filledIn });
  await saveSettings();
  const patch = recordPatchOf(db);
  assert.deepEqual(patch, { name: "Fence Solutions LLC", phone: "813-577-9310", license_no: "FL-CFC-99213" });
  assert.equal(db.state.companiesUpdates.every((u) => u.col === "id" && u.val === "co-1"), true,
    "every companies write must be scoped to this company's own row");
});

test("...and STILL writes the blob the phones read -- the half the 'just move it' fix would have deleted", async () => {
  const { saveSettings, db } = buildSaveSettings(grab("saveSettings"), { values: filledIn });
  await saveSettings();
  const payload = settingsPayloadOf(db);
  assert.equal(payload.business_name, "Fence Solutions LLC",
    "SettingsSync.kt -> SettingsStore.BusinessProfile -> PdfExporter.kt prints this at the top of every PDF " +
    "quote, and my_setup_progress()'s 'business' step is settings->>'business_name' <> '' -- dropping it " +
    "makes the office unable to change what its own phones print and leaves the setup checklist stuck");
  assert.equal(payload.phone, "813-577-9310");
  assert.equal(payload.license_number, "FL-CFC-99213");
});

test("PLANTED FAILURE: dropping the three keys from the SET map silently empties the phones' half of the mirror", async () => {
  const realSet = grabConst("SET");
  const plantedSet = realSet
    .replace("s_businessName:'business_name',", "")
    .replace("s_phone:'phone',", "")
    .replace("s_license:'license_number',", "");
  assert.notEqual(plantedSet, realSet, "the plant must actually change the SET map");
  const { saveSettings, db } = buildSaveSettings(grab("saveSettings"), { values: filledIn, setSrc: plantedSet });
  await saveSettings();
  const payload = settingsPayloadOf(db);
  assert.equal("business_name" in payload, false,
    "sanity: this is exactly what deleting the SET entries does -- the companies half above keeps passing, " +
    "which is why the mirror needs its own assertion rather than being inferred from the customer-facing one");
  assert.deepEqual(recordPatchOf(db),
    { name: "Fence Solutions LLC", phone: "813-577-9310", license_no: "FL-CFC-99213" },
    "and the customer-facing write is untouched by the plant, so a suite without the test above would stay green");
});

test("a MANAGER writes nothing to companies, but their edit still reaches the phones", async () => {
  const { saveSettings, db, msgCalls } = buildSaveSettings(grab("saveSettings"), {
    values: filledIn, role: "MANAGER",
  });
  await saveSettings();
  assert.deepEqual(db.state.companiesUpdates, [],
    "companies_update is `using (id = current_company_id() and current_user_role() = 'OWNER')` with no " +
    "WITH CHECK -- a manager's UPDATE is filtered to zero rows with NO error, so attempting it would report " +
    "a save that never happened");
  assert.equal(settingsPayloadOf(db).business_name, "Fence Solutions LLC",
    "unlike the email box, these three are NOT owner-only overall: the blob half is a real capability a " +
    "manager keeps, which is why the boxes stay editable and #s_companyOwnerNote explains the limit instead");
  assert.equal(msgCalls[msgCalls.length - 1].kind, "ok",
    "nothing a manager was allowed to do failed, so the save is not reported as an error");
});

test("blank boxes are left alone rather than blanking the customer's record", async () => {
  // The state a failed loadSettings() leaves behind: every box empty, nothing
  // stopping a save on top of it. companies.name/.phone/.license_no are NOT
  // NULL with a '' default and would take the blank without complaint.
  const { saveSettings, db } = buildSaveSettings(grab("saveSettings"), {
    values: { s_email: "office@fencesolutions.com", s_businessName: "  ", s_phone: "", s_license: "" },
  });
  await saveSettings();
  assert.equal(recordPatchOf(db), undefined,
    "no companies write may carry '' for name, phone or license_no -- blanking the name empties it from " +
    "every quote page, crew invitation and payment link at once");
});

test("one filled box still saves, without dragging its blank neighbours along", async () => {
  const { saveSettings, db } = buildSaveSettings(grab("saveSettings"), {
    values: { s_email: "office@fencesolutions.com", s_businessName: "Fence Solutions LLC", s_phone: "", s_license: "" },
  });
  await saveSettings();
  assert.deepEqual(recordPatchOf(db), { name: "Fence Solutions LLC" },
    "control for the test above: skipping blanks must not degrade into skipping the whole write");
});

test("a zero-row companies write is reported, not read as success", async () => {
  // The demotion-mid-session case the email write already guards, now reached
  // through the record write too: RLS filters the row out, so the answer is
  // data [] with error null -- indistinguishable from a real save without an
  // explicit check on what came back.
  const { saveSettings, db, msgCalls } = buildSaveSettings(grab("saveSettings"), { values: filledIn });
  db.from = () => ({
    update: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }),
  });
  await saveSettings();
  const last = msgCalls[msgCalls.length - 1];
  assert.equal(last.kind, "err");
  assert.match(last.text, /settings(Email|Company)SaveNoRowsMsg/,
    "an UPDATE that changed nothing must say so -- see tests/a12-dash-zero-row-writes.test.mjs for the " +
    "email half of the same guard");
});
