// Three regressions this wave introduced in website/dashboard.html, all in
// the money path, all fixed from one place each rather than patched at every
// call site. Same grab()/new Function() idiom as
// tests/dashboard-alert-severity.test.mjs, tests/job-readiness.test.mjs and
// tests/dashboard-crew-access.test.mjs -- these run the REAL functions (and,
// for the two spots too entangled with the DOM/network to call standalone,
// the real source block) lifted out of dashboard.html, not a
// re-implementation that could silently drift from what ships. Every test
// below is paired with a PLANTED FAILURE that reconstructs the pre-fix code
// and proves the same assertion would have caught it -- a check that cannot
// go red is not a check.
//
// Defect 1 -- saveSettings() wiped companies.email on a blank or
//   domain-less box (the column is NOT NULL, so '' satisfies it while
//   breaking outgoing mail, the quote's contractor address, and crew
//   invites). Fixed the same way the numeric settings ten lines above
//   already handle a blank: skip the write, say why.
// Defect 2 -- labourVsQuoted(), labourEstVsActualTotals() and the
//   labour_over attention alert all re-derived "rate * feet + flat fee"
//   with no minimum_labor_charge floor, so a job priced under the $200
//   minimum read as over budget instead of under. Fixed by routing all
//   three through one quotedLaborOf(), which mirrors
//   supabase/functions/_shared/pricing/totals.ts: the floor applies to
//   rate+flat combined, not to the rate alone before the flat fee lands.
// Defect 3 -- the job-detail estimate panel printed the raw
//   jobs.deposit_amount instead of the capped "asked" figure every other
//   deposit readout on the page uses (depositAskedOf()), so a deposit set
//   before a re-price came down showed higher than the job is worth today.
//
// Run:
//   node tests/a7-dashboard-money-regressions.test.mjs
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
// For the two spots that are a few lines inside a much larger DOM-bound
// function (the labour_over alert lives inside the attention-list builder;
// the deposit panel lives inside showJob()) -- lifted verbatim by exact
// source markers rather than brace-counted, since the enclosing function is
// not something a standalone test can run at all.
const grabBetween = (startMarker, endMarkerInclusive) => {
  const s = src.indexOf(startMarker);
  if (s < 0) throw new Error("start not found: " + startMarker);
  const e = src.indexOf(endMarkerInclusive, s);
  if (e < 0) throw new Error("end not found: " + endMarkerInclusive);
  return src.slice(s, e + endMarkerInclusive.length);
};

// =============================================================================
// DEFECT 1 -- saveSettings() and the company email
// =============================================================================

const fakeEl = (props = {}) => ({ value: "", ...props });

function makeDb() {
  const state = { companiesUpdate: null, rpcCalls: [] };
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
          if (table === "companies") state.companiesUpdate = { patch, col, val };
          // saveSettings() now reads the affected rows back with .select('id')
          // before treating the email write as a success (see the comment above
          // that call in website/dashboard.html), so a bare
          // Promise.resolve({error:null}) here is one link short of the real
          // chain: "a real address still saves" below calls
          // .eq(...).select('id') and used to die on "select is not a function"
          // before reaching its assertion -- the two blank/invalid-email tests
          // never noticed, because they skip the write entirely and never
          // reach this call. Same shape as tests/a8-company-email-guard.
          // test.mjs's makeAdminDb(), which offers both links for the same
          // reason: awaitable directly for callers that never read rows back,
          // and a .select() link for the one that does.
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

// Builds a runnable saveSettings() bound to fresh stand-ins, from whatever
// source string is passed in (the real, current one by default -- the
// PLANTED FAILURE test below passes a deliberately reverted one instead).
function buildSaveSettings(fnSrc, { emailValue }) {
  const els = { s_email: fakeEl({ value: emailValue }) };
  const $ = (id) => els[id] || (els[id] = fakeEl());
  const db = makeDb();
  const profile = { role: "OWNER", company_id: "co-1" };
  const msgCalls = [];
  const msg = (el, text, kind) => { msgCalls.push({ el, text, kind }); };
  const tr = (key, ...args) => key + (args.length ? "|" + args.join("|") : "");
  const saveSettings = new Function(
    "canEdit", "$", "db", "profile", "msg", "tr", "buildTemplates", "renderSetup",
    grabConst("SET") + "\n" + grabConst("SET_NUM") + "\n" + fnSrc + "\nreturn saveSettings;"
  )(() => true, $, db, profile, msg, tr, [], () => {});
  return { saveSettings, db, msgCalls };
}

test("DEFECT 1: a blank company-email box saves nothing to companies.email, and says why", async () => {
  const { saveSettings, db, msgCalls } = buildSaveSettings(grab("saveSettings"), { emailValue: "  " });
  await saveSettings();
  assert.equal(db.state.companiesUpdate, null, "companies.email must not be written");
  const last = msgCalls[msgCalls.length - 1];
  assert.match(last.text, /settingsEmailBlankMsg/);
  assert.equal(last.kind, "err");
});

test("DEFECT 1: an address with no domain suffix saves nothing to companies.email, and says why", async () => {
  const { saveSettings, db, msgCalls } = buildSaveSettings(grab("saveSettings"), { emailValue: "owner@fenceflow" });
  await saveSettings();
  assert.equal(db.state.companiesUpdate, null, "companies.email must not be written");
  const last = msgCalls[msgCalls.length - 1];
  assert.match(last.text, /settingsEmailInvalidMsg/);
  assert.equal(last.kind, "err");
});

test("DEFECT 1: a real address still saves, with no skip note", async () => {
  const { saveSettings, db, msgCalls } = buildSaveSettings(grab("saveSettings"), { emailValue: "owner@fenceflow.com" });
  await saveSettings();
  assert.equal(db.state.companiesUpdate?.patch.email, "owner@fenceflow.com");
  const last = msgCalls[msgCalls.length - 1];
  assert.doesNotMatch(last.text, /settingsEmail(Blank|Invalid)Msg/);
  assert.equal(last.kind, "ok");
});

test("PLANTED FAILURE: the pre-fix saveSettings wipes the address on a blank box", async () => {
  const real = grab("saveSettings");
  // Exactly what shipped this wave: no blank guard, no shape check, a
  // straight write of whatever the trimmed box holds.
  const old = real.replace(
    /let emailSkippedMsg = '';\s*\n\s*if \(profile\.role === 'OWNER'\) \{\s*\n\s*const newEmail = \$\('s_email'\)\?\.value\.trim\(\) \?\? '';\s*\n[\s\S]*?\n  \}\n/,
    // emailSkippedMsg stays declared (later code still reads it) but is never
    // set -- exactly reproducing the shipped bug: an unconditional write with
    // no blank guard and no shape check, same as before this field existed.
    "  let emailSkippedMsg = '';\n" +
    "  if (profile.role === 'OWNER') {\n" +
    "    const newEmail = $('s_email')?.value.trim() ?? '';\n" +
    "    const { error: emailErr } = await db.from('companies').update({ email: newEmail }).eq('id', profile.company_id);\n" +
    "    if (emailErr) return msg('setMsg', emailErr.message, 'err');\n" +
    "  }\n"
  );
  assert.notEqual(old, real, "the plant must actually change the function");
  const { saveSettings, db } = buildSaveSettings(old, { emailValue: "  " });
  await saveSettings();
  assert.equal(db.state.companiesUpdate?.patch.email, "", "the old code writes an empty string over the real address");
});

// =============================================================================
// DEFECT 2 -- the $200 labour floor, from one definition
// =============================================================================

// The owner's worked example, reconstructed exactly: labor_rate_per_ft 8 *
// signed_linear_feet 4 = raw labour $32, floored by minimum_labor_charge 200
// to $200. Actual labour cost so far: $150. Correct verdict: $50 UNDER
// budget. The bug's verdict: quoted stays $32, so $150 actual reads as
// "$118.00 over budget" -- backwards, not just off by a little.
const floorJob = () => ({
  sync_id: "j1", id: 9,
  labor_rate_per_ft: 8, signed_linear_feet: 4, labor_flat_fee: 0,
  minimum_labor_charge: 200,
});
const floorCosting = () => ({ job_sync_id: "j1", labour_cost: 150 });

test("DEFECT 2: quotedLaborOf floors rate+flat to the minimum, and 0 means off", () => {
  const quotedLaborOf = new Function(grab("quotedLaborOf") + "\nreturn quotedLaborOf;")();
  assert.equal(quotedLaborOf(floorJob()), 200, "32 raw must be floored to the 200 minimum");
  assert.equal(quotedLaborOf({ ...floorJob(), minimum_labor_charge: 0 }), 32, "0 must mean off, raw arithmetic unchanged");
  assert.equal(
    quotedLaborOf({ ...floorJob(), labor_flat_fee: 500 }),
    500 + 32,
    "already above the floor (rate+flat combined) must be left alone, not re-floored"
  );
});

test("DEFECT 2: labourVsQuoted reads the $200-floor job as $50.00 UNDER, not over", () => {
  const money = (n) => "$" + Number(n).toFixed(2);
  const tr = (key, ...args) => key + (args.length ? "|" + args.join("|") : "");
  const esc = (s) => s;
  const jobs = [floorJob()];
  const labourVsQuoted = new Function(
    "jobs", "esc", "tr", "money",
    grab("quotedLaborOf") + "\n" + grab("labourVsQuoted") + "\nreturn labourVsQuoted;"
  )(jobs, esc, tr, money);
  const html = labourVsQuoted(floorCosting());
  assert.match(html, /\$50\.00/, "must show the correct $50.00 figure");
  assert.match(html, /repCostUnderWord/, "must say UNDER");
  assert.doesNotMatch(html, /repCostOverWord/, "must not say OVER");
});

test("DEFECT 2: the labour_over attention alert does not fire a false alarm on the floored job", () => {
  const quotedLaborOf = new Function(grab("quotedLaborOf") + "\nreturn quotedLaborOf;")();
  const items = [];
  const runAlert = new Function(
    "alertOn", "jobCosting", "jobs", "quotedLaborOf", "items", "tr", "money", "name",
    grabBetween(
      "if (alertOn('labour_over')) jobCosting.filter(r => Number(r.labour_cost || 0) > 0.005).forEach(r => {",
      "id: j.id, key:'labour_over:'+j.id, fp:j.updated_at });\n    }\n  });"
    )
  );
  runAlert(() => true, [floorCosting()], [floorJob()], quotedLaborOf, items,
    (k, ...a) => k + "|" + a.join("|"), (n) => "$" + Number(n).toFixed(2), (j) => j.sync_id);
  assert.deepEqual(items, [], "a job $50 UNDER its floored quote must raise no labour_over alert");
});

test("PLANTED FAILURE: without the floor, the same job falsely alerts '118.00 over budget'", () => {
  // The exact formula this wave shipped in all three spots, with no
  // minimum_labor_charge term at all.
  const brokenQuotedLaborOf = (j) =>
    Number(j.labor_rate_per_ft || 0) * Number(j.signed_linear_feet || 0) + Number(j.labor_flat_fee || 0);
  assert.equal(brokenQuotedLaborOf(floorJob()), 32, "sanity: the unfloored formula gives 32");

  const items = [];
  const runAlert = new Function(
    "alertOn", "jobCosting", "jobs", "quotedLaborOf", "items", "tr", "money", "name",
    grabBetween(
      "if (alertOn('labour_over')) jobCosting.filter(r => Number(r.labour_cost || 0) > 0.005).forEach(r => {",
      "id: j.id, key:'labour_over:'+j.id, fp:j.updated_at });\n    }\n  });"
    )
  );
  runAlert(() => true, [floorCosting()], [floorJob()], brokenQuotedLaborOf, items,
    (k, ...a) => k + "|" + a.join("|"), (n) => "$" + Number(n).toFixed(2), (j) => j.sync_id);
  assert.equal(items.length, 1, "the pre-fix formula raises a false labour_over alert");
  assert.match(items[0].text, /\$118\.00/, "and it is the exact wrong figure the owner reported");
});

test("DEFECT 2: labourEstVsActualTotals and the alert both read from the one shared quotedLaborOf(), not a second copy", () => {
  const estBody = grab("labourEstVsActualTotals");
  assert.match(estBody, /quotedLaborOf\(j\)/, "labourEstVsActualTotals must call the shared function");
  assert.doesNotMatch(estBody, /labor_rate_per_ft \|\| 0\) \* Number\(j\.signed_linear_feet/,
    "must not re-derive the formula inline");
  const alertBody = grabBetween(
    "if (alertOn('labour_over'))",
    "id: j.id, key:'labour_over:'+j.id, fp:j.updated_at });"
  );
  assert.match(alertBody, /quotedLaborOf\(j\)/, "the labour_over alert must call the shared function");
  assert.doesNotMatch(alertBody, /labor_rate_per_ft \|\| 0\) \* Number\(j\.signed_linear_feet/,
    "must not re-derive the formula inline");
});

// =============================================================================
// DEFECT 3 -- the job-detail estimate panel's deposit, capped like every
// other deposit readout on the page
// =============================================================================

const DEPOSIT_BLOCK_START = "if(li.length && canSeeMoney()){";
const DEPOSIT_BLOCK_END = "$('jobEstDepositBalance').innerHTML = '';\n  }";

function runDepositBlock(blockSrc, { depositAmount, contract }) {
  const el = { innerHTML: "" };
  const $ = (id) => (id === "jobEstDepositBalance" ? el : { innerHTML: "" });
  const runner = new Function(
    "li", "canSeeMoney", "billableTotalOf", "openJob", "anchorOrdersOf", "balanceOf", "depositAskedOf",
    "$", "esc", "tr", "money",
    blockSrc
  );
  runner(
    [{}], () => true,
    () => contract, { deposit_amount: depositAmount }, () => [],
    (j, c) => c - 0,
    new Function(grab("depositAskedOf") + "\nreturn depositAskedOf;")(),
    $, (s) => s, (k) => k, (n) => "$" + Number(n).toFixed(2)
  );
  return el.innerHTML;
}

test("DEFECT 3: a job-detail deposit set above the current price shows the capped figure, not the raw column", () => {
  const html = runDepositBlock(grabBetween(DEPOSIT_BLOCK_START, DEPOSIT_BLOCK_END), { depositAmount: 5000, contract: 3000 });
  assert.match(html, /\$3000\.00/, "must show the capped $3,000 asked figure");
  assert.doesNotMatch(html, /\$5000\.00/, "must not show the raw, uncapped $5,000 deposit_amount");
});

test("PLANTED FAILURE: the pre-fix panel prints the raw, uncapped deposit_amount", () => {
  const real = grabBetween(DEPOSIT_BLOCK_START, DEPOSIT_BLOCK_END);
  const old = real.replace(
    /const deposit = depositAskedOf\(openJob, contract\);\s*\n/,
    ""
  ).replace("money(deposit)", "money(openJob.deposit_amount)");
  assert.notEqual(old, real, "the plant must actually change the block");
  const html = runDepositBlock(old, { depositAmount: 5000, contract: 3000 });
  assert.match(html, /\$5000\.00/, "the old code shows the uncapped $5,000 on a $3,000 job");
});

test("DEFECT 3: a deposit already within the price is unaffected by the cap", () => {
  const html = runDepositBlock(grabBetween(DEPOSIT_BLOCK_START, DEPOSIT_BLOCK_END), { depositAmount: 500, contract: 3000 });
  assert.match(html, /\$500\.00/);
});
