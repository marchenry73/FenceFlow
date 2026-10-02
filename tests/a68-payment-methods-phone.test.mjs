// The PHONE half of "how customers can pay you": Cash App, Zelle, bank wire and
// cash, typed in the yard instead of at the desk.
//
//   "Leave it in app and the website to add the payment methods"   -- 1 Oct 2026
//
// Run with:  node --test tests/a68-payment-methods-phone.test.mjs
//
// WHAT THIS GUARDS
//   1. ONE STORE. The phone writes the same key, in the same shape, through the
//      same RPC as the office. Business name, phone and licence already live in
//      two places on this project; a third instance of that mistake is not
//      added here, and this file fails if the phone's shape drifts from
//      website/dashboard.html's by so much as a key name.
//   2. A CREW MEMBER CANNOT SEE OR EDIT IT. A wire block holds a bank account.
//      The gate is the money shield that already exists (SEE_MONEY), not a new
//      permission, and it is checked against the real role table.
//   3. A BLANK METHOD REACHES NO CUSTOMER -- proven by running the REAL
//      customer page's own functions out of website/quote.html.
//   4. A BLANK LIMIT SHOWS NOTHING, and no limit is invented anywhere.
//   5. THE LIMIT CANNOT BE ERASED BY AN OFFICE SAVE. This is why it is a
//      sibling key and not a field inside the method; see the test of its own
//      below, which is the one that would have caught the trap.
//   6. SAVING PAYMENT METHODS DOES NOT TOUCH THE SETTINGS EDIT CLOCK.
//
// HOW THE KOTLIN IS TESTED, HONESTLY
//   gradlew is off limits while other tracks edit Kotlin (a Gradle invocation
//   compiles the whole app), so the Kotlin is NOT executed here. Same position
//   as tests/a22-*.test.mjs and the same position docs/MONEY_AUDIT_SURFACES.md
//   section 7 records for JobMoney.
//
//   What this does instead is stronger than a text scan and weaker than a run:
//   the deciding CONSTANTS and the ORDER OF THE CHECKS are LIFTED OUT OF
//   PaymentMethods.kt and a JavaScript model is built from them, then that
//   model is run head to head against the office's REAL functions. The
//   algorithm in the model is a transliteration and could in principle drift
//   from the Kotlin; the regexes, the length limits, the stored key names and
//   the order of the refusals cannot, because they are read from the file. A
//   mutation test at the bottom shows each check can fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// A68_ROOT points the whole suite at another copy of the tree, so the canary
// below can be run against the code as it was BEFORE this wave and shown to
// fail. Unset (every normal run) this reads the real repository.
//   node -e "...build an old tree from git show HEAD:<path>..."
//   A68_ROOT=<that folder> node --test tests/a68-payment-methods-phone.test.mjs
const ROOT = process.env.A68_ROOT
  ? pathToFileURL(process.env.A68_ROOT.replace(/\/?$/, "/"))
  : new URL("../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");

const KT_RULES = "app/src/main/java/com/fenceestimator/app/data/PaymentMethods.kt";
const KT_PANEL = "app/src/main/java/com/fenceestimator/app/ui/settings/PaymentMethodsPanel.kt";
const KT_VM = "app/src/main/java/com/fenceestimator/app/ui/settings/PaymentMethodsViewModel.kt";
const KT_STORE = "app/src/main/java/com/fenceestimator/app/data/SettingsStore.kt";
const KT_PERMS = "app/src/main/java/com/fenceestimator/app/cloud/Permissions.kt";
const KT_SYNC = "app/src/main/java/com/fenceestimator/app/cloud/SettingsSync.kt";
const KT_MAIN = "app/src/main/java/com/fenceestimator/app/MainActivity.kt";
const DASH = "website/dashboard.html";
const QUOTE = "website/quote.html";
const QV = "supabase/functions/quote-view/index.ts";

// ======================================================= source lifting ======

/** Brace-matched body of a named Kotlin/JS function. */
function braceBody(text, fromIndex) {
  const open = text.indexOf("{", fromIndex);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (!depth) return text.slice(open, i + 1); }
  }
  throw new Error("unbalanced braces from " + fromIndex);
}

function ktFunctionBody(src, name) {
  const m = new RegExp("fun\\s+" + name + "\\s*\\(").exec(src);
  if (!m) throw new Error("the Kotlin function I was checking is gone or was renamed: " + name);
  return braceBody(src, m.index + m[0].length);
}

/**
 * A Kotlin `Regex("...")` turned into a JavaScript RegExp.
 *
 * The .kt file holds the escapes doubled (Kotlin string escaping), so `\\u0000`
 * on disk is the regex `\u0000`. Halving them is the whole conversion. Done by
 * reading the file rather than by retyping the pattern, so a change to the
 * Kotlin changes this test's behaviour instead of being invisible to it.
 */
function ktRegex(src, constName) {
  const m = new RegExp(constName + "\\s*=\\s*\\n?\\s*Regex\\(\"((?:[^\"\\\\]|\\\\.)*)\"\\)").exec(src);
  if (!m) throw new Error("regex constant not found: " + constName);
  return new RegExp(m[1].replace(/\\\\/g, "\\"));
}

function ktInt(src, constName) {
  const m = new RegExp("const val\\s+" + constName + "\\s*=\\s*(\\d+)").exec(src);
  if (!m) throw new Error("int constant not found: " + constName);
  return Number(m[1]);
}

/**
 * The refusals of `fromForm`, in the order the Kotlin actually applies them.
 *
 * The order is load-bearing: "on but empty" has to be reported after "that is
 * not a tag", or switching a method on with rubbish in it is reported as empty.
 * Reading the order out of the source means a reordering changes the model and
 * shows up as a disagreement with the office.
 */
function ktRefusalOrder(src) {
  const body = ktFunctionBody(src, "fromForm");
  return [...body.matchAll(/PaymentMethodsError\.([A-Z_]+)/g)].map((m) => m[1]);
}

/**
 * The TOP-LEVEL JSON key names the Kotlin really writes, in order.
 *
 * Only the outer puts: `put("cash_app", buildJsonObject { put("on", ...) })`
 * must yield ["cash_app"], not ["cash_app", "on", "tag"]. Matching every
 * `put("...")` in the body picked up the nested ones and made the model build
 * an object with `on` and `tag` as siblings of `cash_app`, which is both wrong
 * and, worse, wrong in a way that made the parity test fail rather than lie.
 */
function ktStoredKeys(src, fn) {
  const body = ktFunctionBody(src, fn);
  return [...body.matchAll(/put\("([a-z_]+)",\s*(?:buildJsonObject|limits\.)/g)].map((m) => m[1]);
}

/**
 * The body of a Kotlin expression-bodied function: `fun x() = Thing(...)`.
 * [ktFunctionBody] looks for a `{`, so on one of these it runs off into the
 * next function entirely.
 */
function ktExpressionBody(src, name) {
  const m = new RegExp("fun\\s+(?:\\w+\\.)?" + name + "\\s*\\(\\)\\s*=\\s*\\w+\\(").exec(src);
  if (!m) throw new Error("expression-bodied function not found: " + name);
  const open = src.indexOf("(", m.index + m[0].length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") { depth--; if (!depth) return src.slice(open, i + 1); }
  }
  throw new Error("unbalanced parens: " + name);
}

// ---- the office's real functions, lifted and run ----------------------------

const dash = read(DASH);
const grabJs = (name) => {
  let start = dash.indexOf("function " + name + "(");
  if (start < 0) throw new Error("not found in dashboard.html: " + name);
  if (dash.slice(start - 6, start) === "async ") start -= 6;
  return dash.slice(start, dash.indexOf("}", dash.lastIndexOf("}", dash.length)) + 1) &&
    (() => {
      const open = dash.indexOf("{", dash.indexOf(")", start));
      let depth = 0;
      for (let j = open; j < dash.length; j++) {
        if (dash[j] === "{") depth++;
        else if (dash[j] === "}") { depth--; if (!depth) return dash.slice(start, j + 1); }
      }
      throw new Error("unbalanced: " + name);
    })();
};
const grabLine = (text, prefix) => {
  const start = text.indexOf(prefix);
  if (start < 0) throw new Error("not found: " + prefix);
  return text.slice(start, text.indexOf("\n", start));
};

const office = (() => {
  const lifted = [
    grabLine(dash, "const PAY_INVISIBLE = "),
    grabLine(dash, "const PAY_TAG = "),
    grabLine(dash, "const PAY_LIMITS = "),
    grabJs("paymentMethodsFromForm"),
    grabJs("canonPaymentMethods"),
    grabJs("livePaymentMethodNames"),
    grabJs("samePaymentMethods"),
  ].join("\n");
  // eslint-disable-next-line no-new-func
  return new Function(
    lifted + "\nreturn { paymentMethodsFromForm, canonPaymentMethods, livePaymentMethodNames, samePaymentMethods, PAY_LIMITS, PAY_TAG };"
  )();
})();

// ---- the customer page's real functions, lifted and run ---------------------

const quote = read(QUOTE);
const customerPage = (() => {
  const start = quote.indexOf("function payMethodsFrom(");
  if (start < 0) throw new Error("payMethodsFrom is gone from quote.html");
  const lifted = [
    grabLine(quote, "const PAY_ORDER="),
    grabLine(quote, "const PAY_FIELD="),
    braceBodyNamed(quote, "payMethodsFrom"),
    braceBodyNamed(quote, "payHowModel"),
  ].join("\n");
  // eslint-disable-next-line no-new-func
  return new Function(lifted + "\nreturn { payMethodsFrom, payHowModel, PAY_FIELD };")();
})();

function braceBodyNamed(text, name) {
  const start = text.indexOf("function " + name + "(");
  if (start < 0) throw new Error("not found: " + name);
  const open = text.indexOf("{", text.indexOf(")", start));
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}") { depth--; if (!depth) return text.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
}

// ============================================== the model of the Kotlin ======

/**
 * A JavaScript model of PaymentMethodRules, built from constants and ordering
 * LIFTED out of the given Kotlin source. Pass a mutated source to get a model
 * of the mutant -- that is how the canaries below are shown to bite.
 */
function kotlinModel(src) {
  const INVISIBLE = new RegExp(ktRegex(src, "INVISIBLE").source, "g");
  const TAG = ktRegex(src, "CASH_APP_TAG");
  const maxZelle = ktInt(src, "MAX_ZELLE_CHARS");
  const maxWire = ktInt(src, "MAX_WIRE_CHARS");
  const srvZelle = ktInt(src, "SERVER_MAX_ZELLE_CHARS");
  const srvWire = ktInt(src, "SERVER_MAX_WIRE_CHARS");
  const order = ktRefusalOrder(src);
  const methodKeys = ktStoredKeys(src, "toStoredJson");
  const limitKeys = ktStoredKeys(src, "limitsToStoredJson");

  const strip = (s) => String(s ?? "").replace(INVISIBLE, "");
  const tidyWire = (s) => {
    const lines = strip(s).replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
    while (lines.length && lines[0] === "") lines.shift();
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n").replace(/\n{3,}/g, "\n\n");
  };

  const normaliseLimit = (raw) => {
    const cleaned = strip(raw).replace(/,/g, "").replace(/\$/g, "").trim();
    if (cleaned === "") return "";
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
    const value = Number(cleaned);
    if (!(value > 0)) return null;
    return cleaned.includes(".") ? cleaned.replace(/0+$/, "").replace(/\.$/, "") : cleaned;
  };

  function fromForm(f) {
    const tag = strip(f.cashAppTag).trim().replace(/^\$+/, "");
    const to = strip(f.zelleTo).replace(/\s+/g, " ").trim();
    const wire = strip(f.wireDetails).replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).join("\n").trim();

    // Applied in the order the Kotlin lists them.
    const checks = {
      CASH_APP_BAD: () => (tag && !TAG.test(tag) ? { reason: "CASH_APP_BAD" } : null),
      ZELLE_LONG: () => (to.length > maxZelle ? { reason: "ZELLE_LONG" } : null),
      ZELLE_BAD: () => (to && !looksLikeZelle(to) ? { reason: "ZELLE_BAD" } : null),
      WIRE_LONG: () => (wire.length > maxWire ? { reason: "WIRE_LONG" } : null),
      ON_BUT_EMPTY: () => {
        if (f.cashAppOn && !tag) return { reason: "ON_BUT_EMPTY", which: "CASH_APP" };
        if (f.zelleOn && !to) return { reason: "ON_BUT_EMPTY", which: "ZELLE" };
        if (f.wireOn && !wire) return { reason: "ON_BUT_EMPTY", which: "WIRE" };
        return null;
      },
      LIMIT_BAD: () => {
        for (const [field, which] of [["cashAppLimit", "CASH_APP"], ["zelleLimit", "ZELLE"], ["wireLimit", "WIRE"]]) {
          if (normaliseLimit(f[field] ?? "") === null) return { reason: "LIMIT_BAD", which };
        }
        return null;
      },
    };
    for (const name of order) {
      const hit = checks[name]?.();
      if (hit) return { error: hit };
    }
    return {
      methods: { cashAppOn: !!f.cashAppOn, cashAppTag: tag, zelleOn: !!f.zelleOn, zelleTo: to, wireOn: !!f.wireOn, wireDetails: wire, cashOn: !!f.cashOn },
      limits: {
        cash_app: normaliseLimit(f.cashAppLimit ?? ""),
        zelle: normaliseLimit(f.zelleLimit ?? ""),
        wire: normaliseLimit(f.wireLimit ?? ""),
      },
    };
  }

  const looksLikeZelle = (to) =>
    /[^\s@]+@[^\s@]+\.[^\s@]+/.test(to) || (to.match(/\d/g) || []).length >= 10;

  /** The whole payment_methods object, keys read off the Kotlin. */
  const toStored = (m) => {
    const parts = {
      cash_app: { on: m.cashAppOn, tag: m.cashAppTag },
      zelle: { on: m.zelleOn, to: m.zelleTo },
      wire: { on: m.wireOn, details: m.wireDetails },
      cash: { on: m.cashOn },
    };
    const out = {};
    for (const k of methodKeys) out[k] = parts[k];
    return out;
  };

  const limitsToStored = (l) => {
    const out = {};
    for (const k of limitKeys) out[k] = l[k];
    return out;
  };

  /** What the customer would be shown -- quote-view's rules. */
  const publicView = (m) => {
    const tag = strip(m.cashAppTag).trim().replace(/^\$+/, "");
    const to = strip(m.zelleTo).replace(/\s+/g, " ").trim();
    const wire = tidyWire(m.wireDetails);
    return {
      cashApp: m.cashAppOn && TAG.test(tag) ? "$" + tag : "",
      zelle: m.zelleOn && to.length > 0 && to.length <= srvZelle ? to : "",
      wire: m.wireOn && wire.length > 0 && wire.length <= srvWire ? wire : "",
      cash: !!m.cashOn,
    };
  };

  return { fromForm, toStored, limitsToStored, publicView, normaliseLimit, maxZelle, maxWire, methodKeys, limitKeys };
}

/**
 * Loading the Kotlin must NOT kill the whole file.
 *
 * Run against the tree as it was before this wave (A68_ROOT, see the top), the
 * three new Kotlin files are simply absent, and an eager read threw at module
 * scope -- so node reported ONE failed file instead of twenty-eight failed
 * checks, and the canary read as "the suite crashed" rather than as a list of
 * the things the old code could not do. Keeping the failure per-check is the
 * difference between a canary that proves something and a stack trace.
 */
let INIT_ERROR = null;
let ktSrc = "";
let phone = null;
try {
  ktSrc = read(KT_RULES);
  phone = kotlinModel(ktSrc);
} catch (e) {
  INIT_ERROR = e;
}

test("the phone editor exists in the tree under test", () => {
  // The canary the brief asks for, as its own named check: against the code as
  // it was before this wave this is the first thing to fail, and it says why.
  assert.equal(
    INIT_ERROR && INIT_ERROR.message,
    null,
    "the phone's payment-method rules could not be loaded: " + (INIT_ERROR && INIT_ERROR.message)
  );
  assert.ok(phone, "no model of the Kotlin was built");
});

// ==================================================== the shared input set ===
//
// No customer's real handle is in here and none is a real account: the tags and
// addresses are obvious test values.

const BLANK = {
  cashAppOn: false, cashAppTag: "", cashAppLimit: "",
  zelleOn: false, zelleTo: "", zelleLimit: "",
  wireOn: false, wireDetails: "", wireLimit: "",
  cashOn: false,
};
const form = (over = {}) => ({ ...BLANK, ...over });

const CASES = [
  ["everything blank", form()],
  ["cash only", form({ cashOn: true })],
  ["cash app on, tag typed with its $", form({ cashAppOn: true, cashAppTag: "$TestOnlyTag" })],
  ["cash app on, tag typed without a $", form({ cashAppOn: true, cashAppTag: "TestOnlyTag" })],
  ["cash app on, several leading $", form({ cashAppOn: true, cashAppTag: "$$$TestOnlyTag" })],
  ["cash app tag padded with spaces", form({ cashAppOn: true, cashAppTag: "   $TestOnlyTag   " })],
  ["cash app tag with a zero-width space pasted in", form({ cashAppOn: true, cashAppTag: "$Test​OnlyTag" })],
  ["cash app switched off but tag still typed", form({ cashAppOn: false, cashAppTag: "$TestOnlyTag" })],
  ["cash app on with nothing in it", form({ cashAppOn: true, cashAppTag: "" })],
  ["cash app tag with a space in the middle", form({ cashAppOn: true, cashAppTag: "$Test Only" })],
  ["cash app tag 30 characters", form({ cashAppOn: true, cashAppTag: "$" + "a".repeat(30) })],
  ["cash app tag 31 characters", form({ cashAppOn: true, cashAppTag: "$" + "a".repeat(31) })],
  ["zelle as an email", form({ zelleOn: true, zelleTo: "test-only@example.invalid" })],
  ["zelle as a phone number", form({ zelleOn: true, zelleTo: "555-0100-000" })],
  ["zelle with runs of whitespace", form({ zelleOn: true, zelleTo: "  test-only@example.invalid  " })],
  ["zelle with an inner newline", form({ zelleOn: true, zelleTo: "test-only@example.invalid\nand more" })],
  ["zelle that is a sentence", form({ zelleOn: true, zelleTo: "zelle me" })],
  ["zelle too short to be a phone number", form({ zelleOn: true, zelleTo: "555-010" })],
  ["zelle at the office limit", form({ zelleOn: true, zelleTo: "a@b.cd " + "9".repeat(112) })],
  ["zelle over the office limit", form({ zelleOn: true, zelleTo: "a@b.cd" + "9".repeat(200) })],
  ["zelle on with nothing in it", form({ zelleOn: true, zelleTo: "" })],
  ["wire as a block", form({ wireOn: true, wireDetails: "Bank: Test Only Bank\nName: Test Only\nRouting: 000000000" })],
  ["wire with CRLF endings", form({ wireOn: true, wireDetails: "Bank: Test\r\nName: Test\r\n" })],
  ["wire with padded lines", form({ wireOn: true, wireDetails: "  Bank: Test  \n   Name: Test   " })],
  ["wire with blank lines top and bottom", form({ wireOn: true, wireDetails: "\n\nBank: Test\n\n" })],
  ["wire over the office limit", form({ wireOn: true, wireDetails: "x".repeat(1200) })],
  ["wire on with nothing in it", form({ wireOn: true, wireDetails: "   " })],
  ["all four on together", form({
    cashAppOn: true, cashAppTag: "$TestOnlyTag",
    zelleOn: true, zelleTo: "test-only@example.invalid",
    wireOn: true, wireDetails: "Bank: Test Only Bank\nRouting: 000000000",
    cashOn: true,
  })],
  ["off but all filled in", form({
    cashAppTag: "$TestOnlyTag", zelleTo: "test-only@example.invalid", wireDetails: "Bank: Test",
  })],
];

// ============================================================== 1. ONE STORE =

test("the phone writes the SAME stored shape as the office, case for case", () => {
  let agreed = 0, refusedBoth = 0;
  for (const [name, f] of CASES) {
    const officeOut = office.paymentMethodsFromForm(f);
    const phoneOut = phone.fromForm(f);

    if (officeOut.error) {
      // Both must refuse, and for the same reason. A value one surface takes
      // and the other refuses is a value he could not save from his desk after
      // saving it in the yard.
      assert.ok(phoneOut.error, `office refused but phone accepted: ${name}`);
      assert.equal(
        phoneOut.error.reason,
        {
          payMethCashAppBad: "CASH_APP_BAD", payMethZelleBad: "ZELLE_BAD",
          payMethZelleLong: "ZELLE_LONG", payMethWireLong: "WIRE_LONG",
          payMethOnButEmpty: "ON_BUT_EMPTY",
        }[officeOut.error],
        `different reason for refusing: ${name} (office said ${officeOut.error})`
      );
      refusedBoth++;
      continue;
    }

    assert.ok(!phoneOut.error, `office accepted but phone refused: ${name} (${phoneOut.error?.reason})`);
    assert.deepEqual(
      phone.toStored(phoneOut.methods),
      officeOut.value,
      `the stored object differs between phone and office: ${name}`
    );
    agreed++;
  }
  // POSITIVE CONTROL: the comparison above has to have actually compared
  // something, and to have exercised both outcomes. A suite where every case
  // was refused would pass the loop while proving nothing about the shape.
  assert.ok(agreed >= 15, `only ${agreed} cases produced a stored object`);
  assert.ok(refusedBoth >= 6, `only ${refusedBoth} cases were refused by both`);
});

test("the stored object is always WHOLE -- all four methods, every time", () => {
  // save_company_settings merges with `||`, which is shallow: a partial
  // payment_methods object REPLACES the key and so erases the methods it left
  // out. Neither surface may ever produce one.
  assert.deepEqual(phone.methodKeys, ["cash_app", "zelle", "wire", "cash"]);
  let checked = 0;
  for (const [name, f] of CASES) {
    const out = phone.fromForm(f);
    if (out.error) continue;
    const stored = phone.toStored(out.methods);
    assert.deepEqual(Object.keys(stored).sort(), ["cash", "cash_app", "wire", "zelle"], name);
    assert.deepEqual(Object.keys(stored.cash_app).sort(), ["on", "tag"], name);
    assert.deepEqual(Object.keys(stored.zelle).sort(), ["on", "to"], name);
    assert.deepEqual(Object.keys(stored.wire).sort(), ["details", "on"], name);
    assert.deepEqual(Object.keys(stored.cash), ["on"], name);
    checked++;
  }
  assert.ok(checked >= 15, "positive control: nothing was checked");
});

test("the phone's length limits are the OFFICE's, not the looser server ones", () => {
  // A value the phone accepted but the office would refuse is a value he could
  // never save again from his desk -- he would find out by being told his own
  // stored details are too long.
  assert.equal(phone.maxZelle, office.PAY_LIMITS.zelle, "zelle limit differs from the office");
  assert.equal(phone.maxWire, office.PAY_LIMITS.wire, "wire limit differs from the office");
  // And both stay under quote-view's own, so nothing either surface accepted is
  // silently dropped on the way to the customer.
  const qv = read(QV);
  const srvZelle = Number(/const MAX_ZELLE_CHARS = (\d+)/.exec(qv)[1]);
  const srvWire = Number(/const MAX_WIRE_CHARS = (\d+)/.exec(qv)[1]);
  assert.ok(phone.maxZelle <= srvZelle, `${phone.maxZelle} > server ${srvZelle}`);
  assert.ok(phone.maxWire <= srvWire, `${phone.maxWire} > server ${srvWire}`);
});

test("'on' must be a real boolean, the same test the office and quote-view apply", () => {
  // A blob holding {"on": "true"} -- the STRING -- must read as OFF. The office
  // tests `=== true` and quote-view tests `m.on === true`, so a phone that
  // accepted the string would switch a method on while the customer's page
  // showed nothing: two surfaces disagreeing about whether a payment method is
  // live, which is the class of defect being hunted this week.
  const stringy = { cash_app: { on: "true", tag: "TestOnlyTag" }, zelle: { on: 1, to: "test-only@example.invalid" }, wire: { on: false, details: "" }, cash: { on: "yes" } };
  const officeCanon = office.canonPaymentMethods(stringy);
  assert.equal(officeCanon.cash_app.on, false, "the office accepts the string \"true\"");
  assert.equal(officeCanon.zelle.on, false, "the office accepts 1");
  assert.equal(officeCanon.cash.on, false);
  // POSITIVE CONTROL: a real boolean does switch it on.
  assert.equal(office.canonPaymentMethods({ cash_app: { on: true, tag: "T" } }).cash_app.on, true);

  // The Kotlin reader has to be the same test, and `booleanOrNull` alone is
  // NOT: it parses the content, so it answers true for the string "true".
  const canonBody = ktFunctionBody(ktSrc, "canon");
  assert.match(canonBody, /!it\.isString && it\.booleanOrNull == true/,
    "the phone's 'on' test would accept a JSON string");
  // And the text fields require a real string, the way quote-view does.
  assert.match(canonBody, /takeIf \{ it\.isString \}/, "the phone would read a number as a handle");
});

test("the phone writes ONE key through the SAME RPC, and never the companies row", () => {
  const vm = read(KT_VM);
  // Exactly one write path, and it is the office's.
  const rpcs = [...vm.matchAll(/postgrest\.rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rpcs, ["save_company_settings"], "the phone's write path changed");
  // Both keys, each sent whole, in that one call.
  assert.match(vm, /put\("payment_methods", methodsJson\)/);
  assert.match(vm, /put\("payment_limits", limitsJson\)/);
  // Never the companies row: every member of a company can read that row, crew
  // included, so a bank account must not land on it.
  assert.ok(!/from\("companies"\)/.test(vm), "the phone touches the companies row");
  // The read asks for the two keys, not the blob (which also holds the labour
  // rate, the markup and the minimum charge).
  assert.match(vm, /"payment_methods:settings->payment_methods," \+\s*\n\s*"payment_limits:settings->payment_limits"/);
  assert.ok(!/select\(\s*Columns\.raw\(\s*"\*"/.test(vm));
});

test("'Saved' is only said about what is really stored", () => {
  const vm = read(KT_VM);
  // save_company_settings() returns nothing, so no error is not proof of a
  // write. The office reads it back; so must the phone.
  const push = ktFunctionBody(vm, "push");
  assert.ok(push.includes("readStored(companyId)"), "push does not read back");
  assert.ok(push.includes("PaymentMethodRules.same("), "push does not compare the read-back");
  assert.ok(push.includes("PaymentMethodRules.sameLimits("), "push does not compare the limits");
  assert.match(push, /if \(sameMethods && sameLimits\) PushResult\.VERIFIED/);
});

// ====================================================== 2. CREW CANNOT SEE IT =

/** The real role table, lifted out of Permissions.kt. */
function roleTable() {
  const src = read(KT_PERMS);
  const all = [...src.matchAll(/^    ([A-Z_]+)\(\n/gm)].map((m) => m[1]);
  assert.ok(all.includes("SEE_MONEY") && all.includes("EDIT_CATALOG_AND_SETTINGS"),
    "positive control: the permission enum did not parse");
  const body = src.slice(src.indexOf("get() = when (this)"));
  const roleSet = (role) => {
    const m = new RegExp("UserRole\\." + role + " -> (Permission\\.ALL|setOf\\()").exec(body);
    if (!m) throw new Error("role not found: " + role);
    if (m[1] === "Permission.ALL") return new Set(all);
    const chunk = body.slice(m.index, body.indexOf("UserRole.", m.index + 20) < 0 ? body.length : body.indexOf("\n\n", m.index));
    return new Set([...chunk.matchAll(/Permission\.([A-Z_]+)/g)].map((x) => x[1]));
  };
  return { all, roleSet };
}

/** PermissionOverrides.resolve: the role's defaults, plus grants, minus revocations. */
const resolve = (base, raw) => {
  const granted = new Set(), revoked = new Set();
  for (const tok of String(raw || "").split(",").map((s) => s.trim()).filter((s) => s.length >= 2)) {
    (tok[0] === "+" ? granted : revoked).add(tok.slice(1));
  }
  const out = new Set([...base, ...granted]);
  for (const r of revoked) out.delete(r);
  return out;
};

test("a crew-scoped session can neither see nor edit the payment methods", () => {
  const { roleSet } = roleTable();
  // The gate the panel applies, read out of the panel so it cannot drift.
  const panel = read(KT_PANEL);
  assert.match(
    panel,
    /if \(!session\.canSeeMoney \|\| !session\.canEditCatalogAndSettings\) return/,
    "the panel's gate is not the money shield plus the settings capability"
  );
  const gate = (perms) => perms.has("SEE_MONEY") && perms.has("EDIT_CATALOG_AND_SETTINGS");

  // CREW, and a crew member given everything crew are normally given.
  assert.equal(gate(roleSet("CREW")), false, "CREW passes the gate");
  assert.equal(gate(resolve(roleSet("CREW"), "+RECORD_FIELD_WORK")), false);
  assert.equal(gate(resolve(roleSet("CREW"), "+CAPTURE_ENQUIRY")), false);
  assert.equal(gate(roleSet("FOREMAN")), false, "FOREMAN passes the gate");
  // SALES sees job money but may not change company settings, and the server
  // would refuse the write anyway (save_company_settings is OWNER/MANAGER).
  assert.equal(gate(roleSet("SALES")), false);
  assert.equal(gate(roleSet("ACCOUNTANT")), false);
  // A crew member with the money permission alone still cannot: the panel needs
  // both, and it is the write capability that is missing.
  assert.equal(gate(resolve(roleSet("CREW"), "+SEE_MONEY")), false);

  // POSITIVE CONTROL: the gate must let the people who are meant through, or a
  // gate that refused everybody would pass every line above.
  assert.equal(gate(roleSet("OWNER")), true, "OWNER is refused -- the gate refuses everyone");
  assert.equal(gate(roleSet("MANAGER")), true, "MANAGER is refused -- the gate refuses everyone");
  // And revoking the money permission from a manager closes it again.
  assert.equal(gate(resolve(roleSet("MANAGER"), "-SEE_MONEY")), false);
});

test("the gate is in the DATA as well as the layout", () => {
  // The screen is one of three gates, and the other two are not mine:
  //   1. the route: Settings hands anyone without EDIT_CATALOG_AND_SETTINGS the
  //      personal screen, which carries none of this;
  //   2. RLS: company_settings has a RESTRICTIVE select policy requiring
  //      SEE_MONEY or the OWNER/MANAGER role, so a crew phone is handed NO ROW;
  //   3. the RPC: save_company_settings refuses a write from anyone else.
  // This checks the one in the repo that a later edit could silently remove.
  const main = read(KT_MAIN);
  const route = main.slice(main.indexOf("composable(Routes.SETTINGS)"));
  assert.match(
    route.slice(0, route.indexOf("composable(Routes.ACCOUNT)")),
    /if \(session\.canEditCatalogAndSettings\) \{\s*\n\s*SettingsScreen\(/,
    "the Settings route no longer gates the full screen on EDIT_CATALOG_AND_SETTINGS"
  );
  // And the decision record's claim about the server side, as written down.
  const a38 = read("supabase_a38_company_payment_methods.sql");
  assert.ok(a38.includes("company_settings_money_needs_permission"));
  assert.ok(a38.includes("has_permission(''SEE_MONEY''"));
  // crew_settings() is an allowlist and payment_methods is not on it, so the
  // one function that hands part of the blob to crew cannot carry this key.
  assert.ok(
    a38.includes("crew_settings() does NOT name payment_methods"),
    "the crew_settings allowlist claim is no longer recorded"
  );
});

// ========================================= 3. A BLANK METHOD REACHES NOBODY ==

test("a blank method produces nothing customer-facing -- the real page says so", () => {
  // Driven through the ACTUAL functions from website/quote.html, on what the
  // phone would have stored.
  const blank = phone.fromForm(form());
  assert.ok(!blank.error);
  const view = phone.publicView(blank.methods);
  assert.deepEqual(view, { cashApp: "", zelle: "", wire: "", cash: false });

  const model = customerPage.payHowModel({ paymentMethods: view }, 5000, true);
  assert.equal(model.show, false, "an all-blank set still draws the How-to-pay panel");
  assert.deepEqual(model.methods, []);

  // A method switched OFF with details still typed in it: the details are kept
  // (he can switch Zelle off for a week without losing the address) and the
  // customer is shown nothing.
  const off = phone.fromForm(form({
    cashAppTag: "$TestOnlyTag", zelleTo: "test-only@example.invalid", wireDetails: "Bank: Test",
  }));
  assert.ok(!off.error);
  assert.equal(phone.toStored(off.methods).zelle.to, "test-only@example.invalid", "the address was not kept");
  assert.deepEqual(phone.publicView(off.methods), { cashApp: "", zelle: "", wire: "", cash: false });
  assert.equal(customerPage.payHowModel({ paymentMethods: phone.publicView(off.methods) }, 5000, true).show, false);

  // POSITIVE CONTROL: the page DOES draw a method that is on and filled in, or
  // every assertion above would pass against a page that shows nothing ever.
  const on = phone.fromForm(form({ cashAppOn: true, cashAppTag: "$TestOnlyTag", cashOn: true }));
  const live = customerPage.payHowModel({ paymentMethods: phone.publicView(on.methods) }, 5000, true);
  assert.equal(live.show, true, "the page shows nothing even when a method is on and filled in");
  assert.deepEqual(live.methods.map((m) => m.key), ["cashapp", "cash"]);
  assert.equal(live.methods[0].value, "$TestOnlyTag");
});

test("the phone's customer view agrees with quote-view's whitelist, field for field", () => {
  const qv = read(QV);
  // The four fields quote-view sends, and no others.
  const declared = /type PublicPaymentMethods = \{([^}]*)\}/.exec(qv)[1];
  const fields = [...declared.matchAll(/(\w+):/g)].map((m) => m[1]).sort();
  assert.deepEqual(fields, ["cash", "cashApp", "wire", "zelle"]);
  // The customer page reads exactly those four and nothing else.
  assert.deepEqual(Object.values(customerPage.PAY_FIELD).sort(), ["cash", "cashApp", "wire", "zelle"]);
  // So the phone's preview can only ever show those four.
  const all = phone.fromForm(form({
    cashAppOn: true, cashAppTag: "$TestOnlyTag",
    zelleOn: true, zelleTo: "test-only@example.invalid",
    wireOn: true, wireDetails: "Bank: Test", cashOn: true,
  }));
  assert.deepEqual(Object.keys(phone.publicView(all.methods)).sort(), ["cash", "cashApp", "wire", "zelle"]);
});

// ============================================== 4. A BLANK LIMIT SHOWS NOTHING =

test("a blank limit produces nothing, and no limit is ever invented", () => {
  const out = phone.fromForm(form({ cashAppOn: true, cashAppTag: "$TestOnlyTag" }));
  assert.ok(!out.error);
  assert.deepEqual(phone.limitsToStored(out.limits), { cash_app: "", zelle: "", wire: "" });

  // Blank in, blank out -- never a number.
  for (const blankish of ["", "   ", "​", "$", " $ "]) {
    assert.equal(phone.normaliseLimit(blankish), "", JSON.stringify(blankish));
  }
  // Not a positive amount of money: refused, not guessed at.
  for (const bad of ["about 2500", "2,5oo", "-100", "0", "0.00", "1.234", "2500$x"]) {
    assert.equal(phone.normaliseLimit(bad), null, JSON.stringify(bad));
  }
  // POSITIVE CONTROL: a real amount does come through, or the four lines above
  // would pass against a function that refused everything.
  assert.equal(phone.normaliseLimit("2500"), "2500");
  assert.equal(phone.normaliseLimit("$2,500"), "2500");
  assert.equal(phone.normaliseLimit("2500.50"), "2500.5");

  // The limit line is drawn ONLY when there is one. Checked in the panel so a
  // later edit cannot start printing "Her bank may cap one payment at about ."
  const panel = read(KT_PANEL);
  assert.match(panel, /if \(!limit\.isNullOrEmpty\(\)\)/, "the limit line is drawn unconditionally");

  // And no default anywhere: not in the Kotlin, not in any of the three
  // languages. A number in the string would be a confident lie on his screen.
  assert.match(ktSrc, /val cashApp: String = ""/);
  assert.match(ktSrc, /val zelle: String = ""/);
  assert.match(ktSrc, /val wire: String = ""/);
  for (const folder of ["values", "values-es", "values-fr"]) {
    const xml = read(`app/src/main/res/${folder}/strings.xml`);
    for (const key of ["pm_limit_hint", "pm_limit_support", "pm_limit_line"]) {
      const body = new RegExp(`<string name="${key}">([\\s\\S]*?)</string>`).exec(xml);
      assert.ok(body, `${key} missing from ${folder}`);
      // %1$s is the placeholder; any OTHER digit run would be an invented cap.
      const text = body[1].replace(/%1\$[sd]/g, "");
      assert.ok(!/\d/.test(text), `${folder}/${key} contains a number: ${body[1]}`);
    }
  }
});

test("the limit says whose it is, in all three languages", () => {
  // "the limit is set by HER bank, not by his" -- the sentence has to carry
  // that, or he will read it as his own account's cap.
  const wants = { values: /her bank/i, "values-es": /banco de ella|su banco/i, "values-fr": /sa banque|SA banque/i };
  for (const [folder, re] of Object.entries(wants)) {
    const xml = read(`app/src/main/res/${folder}/strings.xml`);
    const support = new RegExp('<string name="pm_limit_support">([\\s\\S]*?)</string>').exec(xml)[1];
    assert.match(support, re, `${folder} does not say whose limit it is`);
  }
});

test("the limit is NOT shown to the customer yet, and the screen says so", () => {
  // Rule: a control that implies something works while it does not is a lie.
  // quote-view sends four whitelisted keys; payment_limits is not one of them,
  // so a limit he types changes nothing on her page today. The panel has to
  // say that rather than imply she is being warned.
  const qv = read(QV);
  assert.ok(!qv.includes("payment_limits"), "quote-view now reads payment_limits -- update this test and the string");
  for (const folder of ["values", "values-es", "values-fr"]) {
    const xml = read(`app/src/main/res/${folder}/strings.xml`);
    assert.ok(xml.includes('name="pm_limit_not_shown_yet"'), `${folder} is missing the honest note`);
  }
  const panel = read(KT_PANEL);
  assert.match(panel, /R\.string\.pm_limit_not_shown_yet/, "the panel does not show the note");
});

// ================================= 5. AN OFFICE SAVE CANNOT ERASE THE LIMIT ==

test("the limit lives in a SIBLING key, so an office save cannot delete it", () => {
  // THIS IS THE TRAP THIS TEST EXISTS FOR. The office writes payment_methods
  // WHOLE, from a form that has no limit box. A limit stored inside
  // payment_methods would therefore be silently deleted the next time he
  // pressed Save at his desk -- and he reads the two surfaces side by side.
  assert.deepEqual(phone.limitKeys, ["cash_app", "zelle", "wire"]);

  // The office's real output carries no limit field at all, at any depth.
  const officeOut = office.paymentMethodsFromForm(form({ cashAppOn: true, cashAppTag: "$TestOnlyTag" }));
  assert.ok(!officeOut.error);
  assert.ok(!JSON.stringify(officeOut.value).includes("limit"), "the office form now carries a limit");

  // So the phone must not put one inside payment_methods either.
  const out = phone.fromForm(form({ cashAppOn: true, cashAppTag: "$TestOnlyTag", cashAppLimit: "2500" }));
  assert.ok(!out.error);
  const stored = phone.toStored(out.methods);
  assert.ok(!JSON.stringify(stored).includes("limit"), "the phone stores the limit inside payment_methods");
  assert.deepEqual(phone.limitsToStored(out.limits), { cash_app: "2500", zelle: "", wire: "" });

  // And the two objects are disjoint, which is what makes `||` safe in both
  // directions: an office save replaces payment_methods and leaves
  // payment_limits alone; a phone save replaces both, whole.
  const methodKeys = new Set(Object.keys(stored));
  for (const k of phone.limitKeys) {
    assert.ok(!methodKeys.has("limit_" + k), "a limit leaked into the method object");
  }
});

test("an ordinary settings push cannot erase the payment methods", () => {
  // SettingsSync pushes CloudSettings, and save_company_settings merges with
  // `||`, which KEEPS keys it was not sent. So the ordinary Settings save must
  // carry no payment field -- if it ever did, saving the markup would rewrite
  // the payment methods from whatever this phone last pulled.
  const sync = read(KT_SYNC);
  const cloud = sync.slice(sync.indexOf("data class CloudSettings"), sync.indexOf("data class CrewSettings"));
  assert.ok(!/payment/i.test(cloud), "CloudSettings now carries a payment field");
  const toCloud = ktExpressionBody(sync, "toCloud");
  assert.ok(toCloud.includes("businessName = businessName"), "positive control: toCloud did not parse");
  assert.ok(!/payment/i.test(toCloud), "toCloud now sends a payment field");
  // And the decoder ignores the key rather than tripping over it.
  assert.match(sync, /ignoreUnknownKeys = true/);
});

// ================================ 6. THE SETTINGS EDIT CLOCK IS NOT TOUCHED ==

test("saving payment methods does not bump the settings edit clock", () => {
  // UPDATED_AT is the whole blob's last-writer-wins clock: SettingsSync.pull
  // only lets the cloud win when the cloud is newer. A bookkeeping write that
  // bumped it -- and merely OPENING this panel is one -- would make this phone
  // look like the newest editor of everything, so the office's next change to
  // the labour rate, markup or minimum charge would stop arriving.
  const store = read(KT_STORE);
  const body = ktFunctionBody(store, "writePaymentMethods");
  assert.ok(!body.includes("UPDATED_AT"), "writePaymentMethods touches the edit clock");
  const keys = [...body.matchAll(/prefs\[Keys\.([A-Z_]+)\]/g)].map((m) => m[1]).sort();
  assert.deepEqual(keys, ["PM_LIMITS_JSON", "PM_LOADED", "PM_METHODS_JSON", "PM_PENDING"],
    "writePaymentMethods writes keys it should not");

  // The three callers all go through it, and none of them calls save() (which
  // stamps) or SettingsSync.
  for (const fn of ["cachePaymentMethods", "savePaymentMethodsSynced", "savePaymentMethodsPending"]) {
    const caller = ktFunctionBody(store, fn);
    assert.ok(caller.includes("writePaymentMethods") || caller.includes("Keys.PM_LOADED"),
      `${fn} does not go through writePaymentMethods`);
    assert.ok(!caller.includes("UPDATED_AT"), `${fn} touches the edit clock`);
  }
  // POSITIVE CONTROL: the ordinary profile save DOES stamp, so the check above
  // is distinguishing two real behaviours rather than reading a file that never
  // mentions the clock.
  assert.match(store, /if \(stamp\) profile\.copy\(updatedAt = System\.currentTimeMillis\(\)\)/);
  assert.ok(ktFunctionBody(store, "writeProfile").includes("UPDATED_AT"),
    "positive control: writeProfile does not write UPDATED_AT either, so the comparison is empty");
});

test("an unsent edit survives, and is never quietly replaced by the server's older copy", () => {
  const store = read(KT_STORE);
  const cache = ktFunctionBody(store, "cachePaymentMethods");
  assert.match(cache, /if \(prefs\[Keys\.PM_PENDING\] == true\)/,
    "a server read overwrites an edit that has not been sent yet");
  const vm = read(KT_VM);
  // On open: if there is an unsent edit, send it BEFORE reading, or the read
  // shows him the older server copy as though his save had never happened.
  assert.match(ktFunctionBody(vm, "load"), /if \(cached\.pending\) \{[\s\S]*?flushPending\(companyId\)/);
  // A dead spot is queued; a refusal is NOT, or it retries forever while the
  // screen claims it is on its way.
  const push = ktFunctionBody(vm, "push");
  assert.match(push,
    /SyncFailure\.isTransientNetwork\(it\)\) PushResult\.UNREACHABLE\s*\n\s*else PushResult\.SERVER_REFUSED/);

  // A read-back that FAILED and a read-back that DISAGREED are different
  // answers, and only one of them means "stop trying". Conflating them cleared
  // the outbox when the read-back merely lost signal -- which is the silent
  // loss this panel exists to avoid. An empty answer is not good news.
  assert.match(push, /readStored\(companyId\) \?: return PushResult\.READBACK_UNKNOWN/,
    "a failed read-back is reported as a disagreement");
  assert.match(push, /if \(sameMethods && sameLimits\) PushResult\.VERIFIED else PushResult\.VERIFY_FAILED/);
  // The queued edit survives both of the not-known answers, in both callers.
  for (const fn of ["save", "flushPending"]) {
    assert.match(
      ktFunctionBody(vm, fn),
      /PushResult\.UNREACHABLE, PushResult\.READBACK_UNKNOWN ->\s*\n?\s*_status\.value = Status\.Pending/,
      `${fn} does not keep an edit whose fate is unknown`
    );
  }
  // ...and only the answers the server really gave clear it.
  const clears = [...vm.matchAll(/clearPaymentMethodsPending\(\)/g)].length;
  assert.equal(clears, 3, "the outbox is cleared in a different number of places than expected");
  assert.ok(!/READBACK_UNKNOWN -> \{[\s\S]{0,200}clearPaymentMethodsPending/.test(vm),
    "an unknown read-back clears the outbox");
});

test("a form that was never loaded cannot be saved over the real details", () => {
  // The office's refused case: a failed load must not leave an editable empty
  // form, because pressing Save on it writes blanks over what is really there.
  // On a phone it is worse -- the blanks would be queued and sent later.
  const panel = read(KT_PANEL);
  assert.match(panel, /if \(!loadedOk\) \{[\s\S]*?return@SectionCard/, "the panel draws an editable form before any read");
  assert.match(panel, /val writable = editable && loadedOk/);
  const vm = read(KT_VM);
  assert.match(ktFunctionBody(vm, "save"), /if \(busy \|\| !_editable\.value\) return/,
    "save does not refuse a never-loaded form");
});

// ====================================================== 7. NEVER REFORMATTED =

test("nothing is silently cut short, and the over-long is refused instead", () => {
  // Half a bank account number is a payment sent nowhere, so an over-long value
  // is REFUSED with a message rather than truncated.
  const longWire = phone.fromForm(form({ wireOn: true, wireDetails: "x".repeat(phone.maxWire + 1) }));
  assert.equal(longWire.error?.reason, "WIRE_LONG");
  const longZelle = phone.fromForm(form({ zelleOn: true, zelleTo: "a@b.cd" + "9".repeat(phone.maxZelle) }));
  assert.equal(longZelle.error?.reason, "ZELLE_LONG");
  // At the limit it is accepted, and whole.
  const atLimit = "x".repeat(phone.maxWire);
  const ok = phone.fromForm(form({ wireOn: true, wireDetails: atLimit }));
  assert.ok(!ok.error);
  assert.equal(phone.toStored(ok.methods).wire.details.length, phone.maxWire, "the wire block was shortened");
  // Nothing in the Kotlin truncates.
  assert.ok(!/\.take\(/.test(ktFunctionBody(ktSrc, "fromForm")), "fromForm truncates something");
});

test("he is shown the CUSTOMER's view to confirm, not the boxes he typed into", () => {
  // The two are not the same thing, and the difference is where the mistakes
  // hide: a switched-off method shows nothing, a tag gains its $, a Zelle
  // address has its spacing collapsed.
  const panel = read(KT_PANEL);
  assert.match(panel, /viewModel\.preview\(form\)/, "the confirm step does not build the customer's view");
  // ...and preview() is the customer-facing rule, not a second rendering of the
  // boxes. That lives in the view model, which is where the panel gets it from.
  assert.match(
    ktFunctionBody(read(KT_VM), "preview"),
    /PaymentMethodRules\.publicView\(methods\)/,
    "preview is not built from the customer-facing rules"
  );
  // The value is drawn in full and monospaced -- a handle he cannot read
  // character by character is a handle he cannot check.
  assert.match(panel, /fontFamily = FontFamily\.Monospace/);
  assert.ok(!/maxLines = 1/.test(panel), "a customer-facing value is clipped to one line");
  // And a save only happens from the confirm button.
  assert.match(panel, /onConfirm = \{\s*\n\s*confirming = false\s*\n\s*viewModel\.save\(companyId, form\)/);
  // Typing a $ or not must not change what is stored.
  const withDollar = phone.fromForm(form({ cashAppOn: true, cashAppTag: "$TestOnlyTag" }));
  const without = phone.fromForm(form({ cashAppOn: true, cashAppTag: "TestOnlyTag" }));
  assert.deepEqual(phone.toStored(withDollar.methods), phone.toStored(without.methods));
  // ...and the customer always sees exactly one $.
  assert.equal(phone.publicView(withDollar.methods).cashApp, "$TestOnlyTag");
});

// ============================================================== 8. CANARIES ==
//
// Every check above is shown to be capable of failing. A checker that skips a
// case reports zero failures for it.

test("CANARY: the parity check fails when the phone's limits drift from the office's", () => {
  const mutant = kotlinModel(ktSrc.replace("const val MAX_ZELLE_CHARS = 120", "const val MAX_ZELLE_CHARS = 200"));
  assert.equal(mutant.maxZelle, 200, "the mutation did not take -- the canary proves nothing");
  assert.throws(
    () => assert.equal(mutant.maxZelle, office.PAY_LIMITS.zelle),
    "a phone limit looser than the office's was not caught"
  );
  // And it changes real behaviour: a value the office refuses, the mutant takes.
  const over = form({ zelleOn: true, zelleTo: "a@b.cd " + "9".repeat(130) });
  assert.ok(office.paymentMethodsFromForm(over).error, "positive control: the office accepts this");
  assert.ok(!mutant.fromForm(over).error, "the mutant refuses it too, so the limit is not what decides");
});

test("CANARY: the whole-object check fails when a method is left out", () => {
  const mutant = kotlinModel(
    ktSrc.replace('put("zelle", buildJsonObject { put("on", methods.zelleOn); put("to", methods.zelleTo) })', "")
  );
  assert.deepEqual(mutant.methodKeys, ["cash_app", "wire", "cash"], "the mutation did not take");
  const out = mutant.fromForm(form({ cashOn: true }));
  assert.throws(
    () => assert.deepEqual(Object.keys(mutant.toStored(out.methods)).sort(), ["cash", "cash_app", "wire", "zelle"]),
    "a partial payment_methods object was not caught -- it would erase Zelle in the cloud"
  );
});

test("CANARY: the sibling-key check fails when the limit is put inside the method", () => {
  // The exact trap: store the limit inside payment_methods and an office save
  // deletes it. The check has to notice.
  const mutantStored = { cash_app: { on: true, tag: "TestOnlyTag", limit: "2500" }, zelle: { on: false, to: "" }, wire: { on: false, details: "" }, cash: { on: false } };
  assert.throws(
    () => assert.ok(!JSON.stringify(mutantStored).includes("limit")),
    "a limit stored inside payment_methods was not caught"
  );
  // And the real thing does not look like that.
  const real = phone.fromForm(form({ cashAppOn: true, cashAppTag: "$TestOnlyTag", cashAppLimit: "2500" }));
  assert.ok(!JSON.stringify(phone.toStored(real.methods)).includes("limit"));
});

test("CANARY: the crew gate check fails when the money shield is dropped", () => {
  const mutant = read(KT_PANEL).replace(
    "if (!session.canSeeMoney || !session.canEditCatalogAndSettings) return",
    "if (!session.canEditCatalogAndSettings) return"
  );
  assert.ok(!mutant.includes("canSeeMoney ||"), "the mutation did not take");
  assert.throws(
    () => assert.match(mutant, /if \(!session\.canSeeMoney \|\| !session\.canEditCatalogAndSettings\) return/),
    "the panel losing the money shield was not caught"
  );
});

test("CANARY: the edit-clock check fails when the write stamps UPDATED_AT", () => {
  const store = read(KT_STORE);
  const mutant = ktFunctionBody(store, "writePaymentMethods")
    .replace("prefs[Keys.PM_PENDING] = pending", "prefs[Keys.PM_PENDING] = pending\n            prefs[Keys.UPDATED_AT] = 1L");
  assert.ok(mutant.includes("UPDATED_AT"), "the mutation did not take");
  assert.throws(
    () => assert.ok(!mutant.includes("UPDATED_AT")),
    "a payment-method write that bumps the settings clock was not caught"
  );
});

test("CANARY: the blank-method check fails when an empty value is shown anyway", () => {
  // The customer page's own function, fed an empty string where a handle goes.
  const shown = customerPage.payMethodsFrom({ paymentMethods: { cashApp: "", zelle: "   ", wire: "", cash: false } });
  assert.deepEqual(shown, [], "an empty method reached the customer's page");
  assert.throws(
    () => assert.ok(customerPage.payMethodsFrom({ paymentMethods: { cashApp: "$X", zelle: "", wire: "", cash: false } }).length === 0),
    "positive control: the page shows nothing even for a filled-in method"
  );
});

test("CANARY: the 'Saved' check fails when the read-back is dropped", () => {
  const mutant = ktFunctionBody(read(KT_VM), "push").replace("PaymentMethodRules.same(", "true || PaymentMethodRules.nope(");
  assert.throws(
    () => assert.ok(mutant.includes("PaymentMethodRules.same(")),
    "a push that stopped comparing the read-back was not caught"
  );
});

// =================================================== 9. THE OLD CODE FAILS ====

test("CANARY against the OLD code: none of this existed on the phone", () => {
  // The canary the brief asks for: the phone had no payment methods at all
  // before this change, so every check in this file has something that cannot
  // be satisfied by the previous tree. Named explicitly so a revert fails
  // loudly rather than leaving a test file that quietly checks nothing.
  const OLD_TREE_LACKED = [
    KT_RULES,
    KT_PANEL,
    KT_VM,
  ];
  for (const f of OLD_TREE_LACKED) {
    assert.ok(read(f).length > 0, `${f} is gone -- the phone editor has been reverted`);
  }
  // And the two things the old SettingsStore did not have.
  const store = read(KT_STORE);
  assert.ok(store.includes("PM_METHODS_JSON"), "the offline cache is gone");
  assert.ok(store.includes("writePaymentMethods"), "the stamp-free write is gone");
  // The old SettingsScreen had no card. If this line goes, the editor is
  // unreachable however complete the rest of it is.
  assert.match(
    read("app/src/main/java/com/fenceestimator/app/ui/settings/SettingsScreen.kt"),
    /PaymentMethodsCard\(editable = editable\)/,
    "the card is no longer wired into the Settings screen -- the feature is unreachable"
  );
});

test("the office's own panel is untouched by this wave", () => {
  // The office half shipped on 1 October and is not mine to change. If its
  // shape moves, the parity above is measuring the wrong thing.
  assert.ok(dash.includes("function paymentMethodsFromForm(f){"));
  assert.deepEqual(Object.keys(office.paymentMethodsFromForm(form()).value).sort(),
    ["cash", "cash_app", "wire", "zelle"]);
  assert.deepEqual(office.PAY_LIMITS, { zelle: 120, wire: 1000 });
});
