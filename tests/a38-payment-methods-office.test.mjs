// The office side of "how customers can pay you": website/dashboard.html's
// Settings panel where the owner TYPES his Cash App tag, Zelle address, wire
// details and cash switch, which quote-view then shows on the customer's link.
//
// Run with:  node --test tests/a38-payment-methods-office.test.mjs
//
// The REAL functions are lifted out of dashboard.html (brace-matched, the same
// grab() idiom as tests/a24-dash-company-record-fields.test.mjs) and run against
// a stand-in page and a stand-in database. This file only READS dashboard.html.
//
// WHAT THIS GUARDS
//   1. NOTHING IS SAVED THAT THE CUSTOMER'S PAGE WOULD REFUSE, and nothing the
//      owner typed is silently cut: bad input is refused with a message naming
//      it, over-long input is refused (never truncated), and the limits here are
//      under quote-view's own.
//   2. "Saved" is only said about what is really stored. save_company_settings()
//      returns nothing, so the page reads the row back; a write the server
//      quietly ignored must read as a FAILURE, not as good news.
//   3. A failed load must never leave an editable empty form -- pressing Save on
//      it would write blanks over the real thing. It locks, says why, and Save
//      then does nothing at all.
//   4. The ONLY write is one save_company_settings call carrying the one key
//      payment_methods, whole. Never a write to the companies row (every member
//      of a company can read that, crew included), and never a partial object
//      (the RPC merges with || -- shallow -- so a partial one erases siblings).
//   5. The panel is for people who can change it, and it is wired in.
//   6. The wording is true: the page says no card fee is added only while
//      create-payment-link really adds none, in all three languages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// A38_DASH_MUTANT points at a deliberately broken copy of dashboard.html so the
// tests can be shown to FAIL when the page is wrong. Unset (every normal run)
// this reads the real page.
const src = readFileSync(
  process.env.A38_DASH_MUTANT ? pathToFileURL(process.env.A38_DASH_MUTANT) : new URL("../website/dashboard.html", import.meta.url),
  "utf8");

const grab = (name) => {
  let start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("not found: " + name);
  if (src.slice(start - 6, start) === "async ") start -= 6;
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
};
const grabLine = (prefix) => {
  const start = src.indexOf(prefix);
  if (start < 0) throw new Error("not found: " + prefix);
  return src.slice(start, src.indexOf("\n", start));
};

const FUNCTIONS = [
  "paymentMethodsFromForm", "canonPaymentMethods", "livePaymentMethodNames", "samePaymentMethods",
  "readPayMethodsForm", "fillPayMethodsForm", "readStoredPaymentMethods", "loadPaymentMethods", "savePaymentMethods",
];
const LIFTED = [
  grabLine("const PAY_INVISIBLE = "), grabLine("const PAY_TAG = "), grabLine("const PAY_LIMITS = "),
  "let payMethodsLoaded = false;",
  ...FUNCTIONS.map(grab),
].join("\n");

// ================================================================ harness =====
const IDS = ["pm_cashApp_on", "pm_cashApp_tag", "pm_zelle_on", "pm_zelle_to", "pm_wire_on", "pm_wire_details",
  "pm_cash_on", "savePayMethods", "payMethMsg", "payMethSummary", "payMethodsPanel"];

/**
 * A page and a database. The database behaves like the real one where it
 * matters: save_company_settings() merges with || (shallow) and refuses anyone
 * who is not OWNER/MANAGER; company_settings honours `alias:settings->key`.
 */
function world({ role = "OWNER", settings, readFails: readFailsAtStart = false, dropWrites = false, readFailsAfterWrite = false, rpcError = null, mismatch = false } = {}) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, { id, value: "", checked: false, disabled: false, style: {}, textContent: "", className: "" });
    return els.get(id);
  };
  IDS.forEach($);
  $("payMethodsPanel").style.display = "none";
  $("savePayMethods").disabled = true;

  const flags = { readFails: readFailsAtStart };
  const store = { row: settings === undefined ? null : { company_id: "co1", settings: structuredClone(settings) } };
  const calls = [];
  let wrote = false;
  const db = {
    from(table) {
      calls.push({ kind: "from", table });
      const q = {
        select(cols) { q.cols = cols; return q; },
        eq() { return q; },
        async maybeSingle() {
          calls.push({ kind: "read", table, cols: q.cols });
          if (table !== "company_settings") throw new Error("the payment panel read a table other than company_settings: " + table);
          if (flags.readFails || (readFailsAfterWrite && wrote)) return { data: null, error: { message: "planted: read failed" } };
          const m = /^(\w+):settings->(\w+)$/.exec(String(q.cols).trim());
          assert.ok(m, "the panel must read ONE key of the blob, not the whole of it: " + q.cols);
          return { data: store.row ? { [m[1]]: store.row.settings[m[2]] } : null, error: null };
        },
      };
      return q;
    },
    async rpc(name, args) {
      calls.push({ kind: "rpc", name, args: structuredClone(args) });
      if (rpcError) return { data: null, error: { message: rpcError } };
      if (name !== "save_company_settings") throw new Error("unexpected rpc " + name);
      if (!["OWNER", "MANAGER"].includes(role)) return { data: null, error: { message: "Only owners and managers can change business settings." } };
      wrote = true;
      if (dropWrites) return { data: null, error: null }; // the "empty answer reads as good news" trap
      const next = structuredClone(args.new_settings);
      if (mismatch && next.payment_methods) next.payment_methods.cash = { on: !next.payment_methods.cash.on };
      store.row = { company_id: "co1", settings: { ...(store.row?.settings ?? {}), ...next } }; // || is SHALLOW
      return { data: null, error: null };
    },
  };
  const shown = [];
  const msg = (id, text, kind) => { shown.push({ id, text, kind }); $(id).textContent = text; $(id).className = "msg " + (kind || "info"); };
  const tr = (k, ...a) => [k, ...a].join("|");
  const profile = { company_id: "co1", role };
  const canEdit = () => role === "OWNER" || role === "MANAGER";
  const api = new Function("$", "db", "profile", "canEdit", "msg", "tr", "console",
    LIFTED + "\nreturn { " + FUNCTIONS.join(", ") + ", PAY_LIMITS, get loaded(){ return payMethodsLoaded; } };")
    ($, db, profile, canEdit, msg, tr, { error() {} });
  return { api, $, els, db, store, calls, shown, profile, flags };
}

const typed = (w, f) => {
  const set = (id, v) => { w.$(id)[typeof v === "boolean" ? "checked" : "value"] = v; };
  if ("cashAppOn" in f) set("pm_cashApp_on", f.cashAppOn);
  if ("cashAppTag" in f) set("pm_cashApp_tag", f.cashAppTag);
  if ("zelleOn" in f) set("pm_zelle_on", f.zelleOn);
  if ("zelleTo" in f) set("pm_zelle_to", f.zelleTo);
  if ("wireOn" in f) set("pm_wire_on", f.wireOn);
  if ("wireDetails" in f) set("pm_wire_details", f.wireDetails);
  if ("cashOn" in f) set("pm_cash_on", f.cashOn);
};
const rpcs = (w) => w.calls.filter((c) => c.kind === "rpc");
/** What the owner is looking at in the message line right now. */
const said = (w) => ({ text: w.$("payMethMsg").textContent, cls: w.$("payMethMsg").className });
const BLANK = { cashAppOn: false, cashAppTag: "", zelleOn: false, zelleTo: "", wireOn: false, wireDetails: "", cashOn: false };

// ============================================================ the form rules =====

test("harness control: the lifted functions are the real ones, and every one of them exists", () => {
  const { api } = world();
  for (const n of FUNCTIONS) assert.equal(typeof api[n], "function", n);
  assert.deepEqual(api.PAY_LIMITS, { zelle: 120, wire: 1000 });
  // Under what quote-view will accept (200 / 1500), so what the office saves the customer's page never drops.
  const qv = readFileSync(new URL("../supabase/functions/quote-view/index.ts", import.meta.url), "utf8");
  assert.ok(api.PAY_LIMITS.zelle <= Number(/MAX_ZELLE_CHARS = (\d+)/.exec(qv)[1]));
  assert.ok(api.PAY_LIMITS.wire <= Number(/MAX_WIRE_CHARS = (\d+)/.exec(qv)[1]));
});

test("a filled-in form becomes the stored shape: tag without its $, text tidied, switches kept apart from the details", () => {
  const { api } = world();
  const r = api.paymentMethodsFromForm({
    cashAppOn: true, cashAppTag: "  $TestOnlyTag ", zelleOn: true, zelleTo: " test-only@example.invalid ",
    wireOn: true, wireDetails: "  Bank: TEST ONLY \r\n\r\n Account: 1  \r\n", cashOn: true,
  });
  assert.deepEqual(r, { value: {
    cash_app: { on: true, tag: "TestOnlyTag" },
    zelle: { on: true, to: "test-only@example.invalid" },
    wire: { on: true, details: "Bank: TEST ONLY\n\nAccount: 1" },
    cash: { on: true },
  } });
});

test("an empty form is valid and stores everything OFF -- nothing is invented for him", () => {
  const { api } = world();
  assert.deepEqual(api.paymentMethodsFromForm(BLANK), { value: {
    cash_app: { on: false, tag: "" }, zelle: { on: false, to: "" }, wire: { on: false, details: "" }, cash: { on: false },
  } });
});

test("a method switched OFF keeps what was typed, so turning Zelle off for a week does not lose the address", () => {
  const { api } = world();
  const r = api.paymentMethodsFromForm({ ...BLANK, zelleOn: false, zelleTo: "813-555-0100" });
  assert.deepEqual(r.value.zelle, { on: false, to: "813-555-0100" });
});

test("Zelle takes a phone, an email, or both -- and refuses text that is neither", () => {
  const { api } = world();
  for (const ok of ["813-555-0100", "(813) 555-0100", "+1 813 555 0100", "8135550100", "test-only@example.invalid",
    "813-555-0100 or test-only@example.invalid"]) {
    assert.ok(api.paymentMethodsFromForm({ ...BLANK, zelleOn: true, zelleTo: ok }).value, ok);
  }
  for (const bad of ["zelle me", "call the office", "813-555", "test-only@", "@example.invalid", "12345"]) {
    assert.equal(api.paymentMethodsFromForm({ ...BLANK, zelleOn: true, zelleTo: bad }).error, "payMethZelleBad", bad);
  }
});

test("Cash App takes a plain tag and refuses anything that is not one, naming the box", () => {
  const { api } = world();
  for (const ok of ["TestOnlyTag", "$TestOnlyTag", "Test_Only.Tag-1", "x".repeat(30)]) {
    assert.ok(api.paymentMethodsFromForm({ ...BLANK, cashAppOn: true, cashAppTag: ok }).value, ok);
  }
  for (const bad of ["Test Only", "https://cash.app/$TestOnlyTag", "a/b", "<b>x</b>", "x".repeat(31), "ünï"]) {
    assert.equal(api.paymentMethodsFromForm({ ...BLANK, cashAppOn: true, cashAppTag: bad }).error, "payMethCashAppBad", bad);
  }
  // Refused even while switched off: a typo caught now is one the customer never sees later.
  assert.equal(api.paymentMethodsFromForm({ ...BLANK, cashAppTag: "Test Only" }).error, "payMethCashAppBad");
});

test("invisible characters pasted in from a text message are stripped before anything is judged or stored", () => {
  const { api } = world();
  const u = (h) => String.fromCharCode(parseInt(h, 16));
  const r = api.paymentMethodsFromForm({ ...BLANK, cashAppOn: true, cashAppTag: u("200e") + "$Test" + u("200b") + "Only" + u("202e") + u("feff") });
  assert.equal(r.value.cash_app.tag, "TestOnly");
});

test("over-long input is REFUSED, never cut short (Zelle 120, wire 1000)", () => {
  const { api } = world();
  assert.equal(api.paymentMethodsFromForm({ ...BLANK, zelleOn: true, zelleTo: "a@b.co" + "x".repeat(115) }).error, "payMethZelleLong");
  assert.ok(api.paymentMethodsFromForm({ ...BLANK, zelleOn: true, zelleTo: "a@b.co" + "x".repeat(114) }).value);
  assert.equal(api.paymentMethodsFromForm({ ...BLANK, wireOn: true, wireDetails: "9".repeat(1001) }).error, "payMethWireLong");
  const at = api.paymentMethodsFromForm({ ...BLANK, wireOn: true, wireDetails: "9".repeat(1000) });
  assert.equal(at.value.wire.details, "9".repeat(1000), "a value at the limit was altered");
});

test("switched on but nothing typed is refused, naming which method", () => {
  const { api } = world();
  assert.deepEqual(api.paymentMethodsFromForm({ ...BLANK, cashAppOn: true }), { error: "payMethOnButEmpty", which: "payMethCashAppLabel" });
  assert.deepEqual(api.paymentMethodsFromForm({ ...BLANK, zelleOn: true, zelleTo: "   " }), { error: "payMethOnButEmpty", which: "payMethZelleLabel" });
  assert.deepEqual(api.paymentMethodsFromForm({ ...BLANK, wireOn: true, wireDetails: "\n \n" }), { error: "payMethOnButEmpty", which: "payMethWireLabel" });
  // Cash needs nothing typed.
  assert.ok(api.paymentMethodsFromForm({ ...BLANK, cashOn: true }).value);
});

test("the summary names exactly the methods a customer would see: on AND filled in", () => {
  const { api } = world();
  const pm = { cash_app: { on: true, tag: "X" }, zelle: { on: false, to: "a@b.co" }, wire: { on: true, details: "  " }, cash: { on: true } };
  assert.deepEqual(api.livePaymentMethodNames(pm), ["payMethCashAppLabel", "payMethNameCash"]);
  assert.deepEqual(api.livePaymentMethodNames(null), []);
  assert.deepEqual(api.livePaymentMethodNames("garbage"), []);
  assert.deepEqual(api.livePaymentMethodNames({ cash_app: { on: "true", tag: "X" } }), []);
});

// ================================================================== loading =====

test("an owner with nothing stored sees a blank, ENABLED form and an honest 'nothing shown' summary", async () => {
  const w = world({ settings: { labor_rate: 8 } });
  await w.api.loadPaymentMethods();
  assert.equal(w.$("payMethodsPanel").style.display, "");
  assert.equal(w.api.loaded, true);
  assert.equal(w.$("savePayMethods").disabled, false);
  assert.equal(w.$("pm_cashApp_tag").value, "");
  assert.equal(w.$("pm_zelle_on").checked, false);
  assert.equal(w.$("payMethSummary").textContent, "payMethSummaryNone");
  assert.deepEqual(w.calls.filter((c) => c.kind === "read").map((c) => c.cols), ["payment_methods:settings->payment_methods"]);
});

test("stored details come back into the form, the tag shown with its $", async () => {
  const w = world({ settings: { payment_methods: {
    cash_app: { on: true, tag: "TestOnlyTag" }, zelle: { on: false, to: "813-555-0100" },
    wire: { on: true, details: "Bank: X\nAcct: 1" }, cash: { on: true },
  } } });
  await w.api.loadPaymentMethods();
  assert.equal(w.$("pm_cashApp_tag").value, "$TestOnlyTag");
  assert.equal(w.$("pm_cashApp_on").checked, true);
  assert.equal(w.$("pm_zelle_to").value, "813-555-0100");
  assert.equal(w.$("pm_zelle_on").checked, false);
  assert.equal(w.$("pm_wire_details").value, "Bank: X\nAcct: 1");
  assert.equal(w.$("pm_cash_on").checked, true);
  assert.equal(w.$("payMethSummary").textContent, "payMethSummaryOn|payMethCashAppLabel, payMethWireLabel, payMethNameCash");
});

test("someone who cannot change business settings never sees the panel, and nothing is read for them", async () => {
  for (const role of ["CREW", "FOREMAN", "SALES", "ACCOUNTANT"]) {
    const w = world({ role, settings: { payment_methods: { cash: { on: true } } } });
    await w.api.loadPaymentMethods();
    assert.equal(w.$("payMethodsPanel").style.display, "none", role);
    assert.equal(w.calls.length, 0, role + " triggered a database call");
  }
  // Control: an owner and a manager do see it.
  for (const role of ["OWNER", "MANAGER"]) {
    const w = world({ role, settings: {} });
    await w.api.loadPaymentMethods();
    assert.equal(w.$("payMethodsPanel").style.display, "", role);
  }
});

test("a FAILED load locks the form with the reason, and Save then writes nothing", async () => {
  const w = world({ settings: { payment_methods: { cash: { on: true } } }, readFails: true });
  await w.api.loadPaymentMethods();
  assert.equal(w.api.loaded, false);
  assert.equal(w.$("savePayMethods").disabled, true);
  for (const id of ["pm_cashApp_on", "pm_cashApp_tag", "pm_zelle_on", "pm_zelle_to", "pm_wire_on", "pm_wire_details", "pm_cash_on"]) {
    assert.equal(w.$(id).disabled, true, id + " is editable after a failed load");
  }
  assert.deepEqual(said(w), { text: "payMethLoadFailed", cls: "msg err" });
  // Even if something clicks Save anyway, nothing is sent.
  typed(w, { cashOn: true });
  await w.api.savePaymentMethods();
  assert.equal(rpcs(w).length, 0, "a save went out after a failed load");
});

test("a failed load that THROWS is treated the same way", async () => {
  const w = world({ settings: {} });
  w.db.from = () => { throw new Error("planted: network down"); };
  await w.api.loadPaymentMethods();
  assert.equal(w.api.loaded, false);
  assert.equal(w.$("savePayMethods").disabled, true);
  assert.equal(said(w).text, "payMethLoadFailed");
});

test("a retry after a failed load unlocks the form", async () => {
  const w = world({ settings: { payment_methods: { cash: { on: true } } }, readFails: true });
  await w.api.loadPaymentMethods();
  assert.equal(w.$("pm_cash_on").disabled, true);
  // The network comes back, the page is loaded again: the same form unlocks.
  w.flags.readFails = false;
  await w.api.loadPaymentMethods();
  assert.equal(w.$("pm_cash_on").disabled, false);
  assert.equal(w.$("pm_cash_on").checked, true);
  assert.equal(w.api.loaded, true);
  assert.equal(w.$("savePayMethods").disabled, false);
});

// =================================================================== saving =====

test("saving writes ONE save_company_settings call carrying ONE key, the WHOLE object -- and nothing to the companies row", async () => {
  const w = world({ settings: { labor_rate: 8, markup: 15 } });
  await w.api.loadPaymentMethods();
  typed(w, { cashAppOn: true, cashAppTag: "$TestOnlyTag", zelleOn: true, zelleTo: "test-only@example.invalid", cashOn: true });
  await w.api.savePaymentMethods();

  const writes = rpcs(w);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, "save_company_settings");
  assert.deepEqual(Object.keys(writes[0].args), ["new_settings"]);
  assert.deepEqual(Object.keys(writes[0].args.new_settings), ["payment_methods"], "something besides payment_methods was sent");
  assert.deepEqual(writes[0].args.new_settings.payment_methods, {
    cash_app: { on: true, tag: "TestOnlyTag" }, zelle: { on: true, to: "test-only@example.invalid" },
    wire: { on: false, details: "" }, cash: { on: true },
  });
  // No other table was written, and none other than company_settings was even touched.
  assert.deepEqual([...new Set(w.calls.filter((c) => c.kind === "from").map((c) => c.table))], ["company_settings"]);
  // The rest of the blob (what the PHONE reads) is exactly as it was.
  assert.equal(w.store.row.settings.labor_rate, 8);
  assert.equal(w.store.row.settings.markup, 15);
  // Said once, truthfully.
  assert.deepEqual(said(w), { text: "payMethSavedMsg", cls: "msg ok" });
});

test("switching one method off and saving again keeps the others -- the object is replaced whole, not half-merged", async () => {
  const w = world({ settings: { payment_methods: {
    cash_app: { on: true, tag: "TestOnlyTag" }, zelle: { on: true, to: "813-555-0100" },
    wire: { on: true, details: "Bank: X" }, cash: { on: true },
  } } });
  await w.api.loadPaymentMethods();
  w.$("pm_zelle_on").checked = false;
  await w.api.savePaymentMethods();
  assert.deepEqual(w.store.row.settings.payment_methods, {
    cash_app: { on: true, tag: "TestOnlyTag" }, zelle: { on: false, to: "813-555-0100" },
    wire: { on: true, details: "Bank: X" }, cash: { on: true },
  });
});

test("the form shows what is STORED after a save (normalised), not just what was typed", async () => {
  const w = world({ settings: {} });
  await w.api.loadPaymentMethods();
  typed(w, { cashAppOn: true, cashAppTag: "  $$TestOnlyTag  " });
  await w.api.savePaymentMethods();
  assert.equal(w.$("pm_cashApp_tag").value, "$TestOnlyTag");
  assert.equal(w.$("payMethSummary").textContent, "payMethSummaryOn|payMethCashAppLabel");
});

test("invalid input sends NOTHING and says which box and why", async () => {
  const w = world({ settings: {} });
  await w.api.loadPaymentMethods();
  typed(w, { cashAppOn: true, cashAppTag: "Test Only" });
  await w.api.savePaymentMethods();
  assert.equal(rpcs(w).length, 0);
  assert.deepEqual(said(w), { text: "payMethCashAppBad|", cls: "msg err" });

  typed(w, { cashAppOn: false, cashAppTag: "", zelleOn: true, zelleTo: "" });
  await w.api.savePaymentMethods();
  assert.equal(rpcs(w).length, 0);
  assert.deepEqual(said(w), { text: "payMethOnButEmpty|payMethZelleLabel", cls: "msg err" });
});

test("a refused write (not an owner or manager) is an error, never 'Saved'", async () => {
  // Reached only if the UI gate were bypassed; the server is the truth and the page must report it.
  const w = world({ settings: {}, rpcError: "Only owners and managers can change business settings." });
  await w.api.loadPaymentMethods();
  typed(w, { cashOn: true });
  await w.api.savePaymentMethods();
  assert.equal(said(w).cls, "msg err");
  assert.match(said(w).text, /^payMethSaveFailed\|Only owners and managers/);
});

test("a write the server QUIETLY IGNORED is reported as a failure -- the empty answer must not read as good news", async () => {
  const w = world({ settings: {}, dropWrites: true });
  await w.api.loadPaymentMethods();
  typed(w, { cashAppOn: true, cashAppTag: "TestOnlyTag" });
  await w.api.savePaymentMethods();
  assert.equal(rpcs(w).length, 1, "the write was attempted");
  assert.deepEqual(said(w), { text: "payMethVerifyFailed", cls: "msg err" });
  // And the form shows the truth (nothing stored), not the lie that was typed.
  assert.equal(w.$("pm_cashApp_tag").value, "");
});

test("a stored value that differs from what was sent is reported, and the stored one is what the form shows", async () => {
  const w = world({ settings: {}, mismatch: true });
  await w.api.loadPaymentMethods();
  typed(w, { cashOn: true });
  await w.api.savePaymentMethods();
  assert.equal(said(w).text, "payMethVerifyFailed");
  assert.equal(w.$("pm_cash_on").checked, false, "the form kept the typed value instead of the stored one");
});

test("if the read-back itself fails, the save is not announced as good", async () => {
  const w = world({ settings: {}, readFailsAfterWrite: true });
  await w.api.loadPaymentMethods();
  typed(w, { cashOn: true });
  await w.api.savePaymentMethods();
  assert.equal(said(w).text, "payMethVerifyFailed");
});

test("the Save button is released again after every outcome (a failed save does not strand the form)", async () => {
  for (const opts of [{}, { rpcError: "boom" }, { dropWrites: true }]) {
    const w = world({ settings: {}, ...opts });
    await w.api.loadPaymentMethods();
    typed(w, { cashOn: true });
    await w.api.savePaymentMethods();
    assert.equal(w.$("savePayMethods").disabled, false, JSON.stringify(opts));
  }
});

// ============================================================ the page itself =====

test("the panel is in the page, hidden and locked until a successful load, and inside the Settings tab", () => {
  for (const id of IDS) assert.ok(src.includes(`id="${id}"`), `#${id} is missing from dashboard.html`);
  const panel = src.indexOf('id="payMethodsPanel"');
  assert.match(src.slice(panel - 60, panel + 80), /display:none/, "the panel must start hidden");
  const btn = src.slice(src.indexOf('id="savePayMethods"') - 40, src.indexOf('id="savePayMethods"') + 160);
  assert.match(btn, /\bdisabled\b/, "Save must start disabled");
  assert.ok(src.indexOf('id="tab-settings"') > 0 && src.indexOf('id="tab-settings"') < panel, "the panel is not after the Settings tab opens");
  assert.ok(panel < src.indexOf('id="tab-billing"'), "the panel is not inside the Settings tab");
});

test("it is wired in: loads when Settings opens, Save is bound, and neither can throw unhandled", () => {
  assert.match(src, /if\(name==='settings'\) loadPaymentMethods\(\)\.catch\(/);
  assert.match(src, /\$\('savePayMethods'\)\.addEventListener\('click'/);
});

test("the office code writes through save_company_settings only and never touches the companies row", () => {
  const code = FUNCTIONS.map(grab).join("\n");
  assert.match(code, /rpc\('save_company_settings'/);
  assert.doesNotMatch(code, /from\('companies'\)/);
  assert.doesNotMatch(code, /\.update\(/);
  assert.doesNotMatch(code, /select\('\*'\)|select\('settings'\)/, "the panel must read one key, not the blob");
});

test("PLANTED FAILURE: the harness really does notice a save that goes to the wrong table", async () => {
  // Proves the 'only company_settings was touched' assertion above can fail.
  const w = world({ settings: {} });
  await w.api.loadPaymentMethods();
  w.db.from("companies");
  assert.notDeepEqual([...new Set(w.calls.filter((c) => c.kind === "from").map((c) => c.table))], ["company_settings"]);
});

// ================================================================ the wording =====

const TL = (() => {
  const start = src.indexOf("const TL = {");
  let depth = 0, end = -1;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return eval("(" + src.slice(src.indexOf("{", start), end) + ")");
})();

test("every payMeth string used by the page exists in English, Spanish and French, and is really translated", () => {
  const used = new Set([...src.matchAll(/data-t="(payMeth\w+)"/g)].map((m) => m[1]));
  for (const code of grabAll(["paymentMethodsFromForm", "livePaymentMethodNames", "fillPayMethodsForm", "loadPaymentMethods", "savePaymentMethods"])) used.add(code);
  assert.ok(used.size >= 20, "found too few keys to mean anything: " + used.size);
  for (const lang of ["en", "es", "fr"]) {
    for (const k of used) assert.ok(typeof TL[lang][k] === "string" && TL[lang][k].length > 0, `${lang} is missing ${k}`);
  }
  const keys = (lang) => Object.keys(TL[lang]).filter((k) => k.startsWith("payMeth")).sort();
  assert.deepEqual(keys("es"), keys("en"));
  assert.deepEqual(keys("fr"), keys("en"));
  for (const k of keys("en")) {
    if (["payMethCashAppLabel", "payMethZelleLabel"].includes(k)) continue; // brand names, the same in every language
    for (const lang of ["es", "fr"]) assert.notEqual(TL[lang][k], TL.en[k], `${lang} ${k} is just the English`);
  }
});
function grabAll(names) {
  const keys = [];
  // Quoted payMeth... names in the code are translation keys, except the ids of
  // the page's own elements, which share the prefix.
  for (const n of names) for (const m of grab(n).matchAll(/'(payMeth\w+)'/g)) if (!IDS.includes(m[1])) keys.push(m[1]);
  return keys;
}

test("the wording is TRUE: 'no card fee' is said only while create-payment-link adds none, and no string claims one", () => {
  const pay = readFileSync(new URL("../supabase/functions/create-payment-link/index.ts", import.meta.url), "utf8");
  assert.match(pay, /^\s*const stripeFee = 0;/m, "a card fee is now charged -- payMethCardNote (three languages) says there is none and must be rewritten");
  // The note says it, in English...
  assert.match(TL.en.payMethCardNote, /No card fee is added/);
  // ...and no payMeth string in any language says a fee IS charged.
  for (const lang of ["en", "es", "fr"]) {
    for (const [k, v] of Object.entries(TL[lang])) {
      if (!k.startsWith("payMeth") || k === "payMethCardNote") continue;
      assert.doesNotMatch(v, /\bfee\b|\bfees\b|frais|cargo|comisi/i, `${lang}.${k} talks about a fee`);
    }
  }
  // Spanish and French say the same thing as the English: none is added.
  assert.match(TL.es.payMethCardNote, /No se suma ningún cargo/);
  assert.match(TL.fr.payMethCardNote, /Aucun frais de carte n’est ajouté/);
});
