// The deposit rule now exists in a THIRD language.
//
// It was Kotlin (JobMoney.ruleDeposit) and TypeScript
// (_shared/quote-deposit.ts), both pinned against
// tests/a29-deposit-rule-vectors.json. supabase_r67 adds a SQL copy, because
// the figure has to be applied inside a BEFORE trigger: putting
// deposit_amount in price-job's own UPDATE would make that statement
// non-quiet and bump updated_at, which is how a phone's unsynced offline
// edits get silently discarded.
//
// A third copy of a money rule is a liability unless something compares them.
// So:
//
//   1. r67's inlined vectors must BE the JSON's vectors -- read from both
//      files here, never transcribed. A parity test that compares an
//      implementation to a hand copy of its own expected values is the shape
//      that already cost this repo a day.
//   2. the SQL must do the cents-first rounding, not float arithmetic.
//   3. price-job must write the materials figure, and it must be quiet.
//
// Every claim is paired with a canary.
//
//   node tests/a157-deposit-follows-materials.test.mjs
import { readFileSync } from "node:fs";

const SQL = readFileSync("supabase_r67_deposit_follows_the_materials.sql", "utf8");
const VEC = JSON.parse(readFileSync("tests/a29-deposit-rule-vectors.json", "utf8"));
const LOAD = readFileSync("supabase/functions/_shared/pricing/load.ts", "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? ` -- ${extra}` : ""}`); }
};

// Comments stripped before any must-not-contain check: a check that matches
// its own explanatory comment proves nothing.
const code = (s) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

// ---------------------------------------------------------------------------
// 1. The SQL's vectors ARE the shared vectors
// ---------------------------------------------------------------------------

/** The (outstanding, want) pairs inlined in the migration's proof block. */
function sqlVectors(text) {
  const start = text.indexOf("with vectors(outstanding, want) as (values");
  if (start < 0) throw new Error("r67 has no inlined vector block");
  // The terminator is the line that CLOSES the VALUES list. Looking for the
  // first ")\n" found the LAST ROW's own close, and slicing there dropped the
  // final pair -- so this read 18 of 19 and reported a mismatch of its own.
  const end = text.indexOf("\n)\n", start);
  if (end < 0) throw new Error("the inlined vector block is not terminated");
  const block = text.slice(start, end);
  return [...block.matchAll(/\(\s*(-?[0-9.e-]+)::numeric,\s*(-?[0-9.e-]+)::numeric\s*\)/gi)]
    .map((m) => ({ outstanding: Number(m[1]), out: Number(m[2]) }));
}

const inSql = sqlVectors(SQL);
const inJson = VEC.ruleDeposit;

ok("the migration inlines as many vectors as the shared JSON holds",
  inSql.length === inJson.length, `sql ${inSql.length}, json ${inJson.length}`);
ok("and every pair matches, value for value",
  inSql.length === inJson.length &&
  inSql.every((v, i) => v.outstanding === inJson[i].outstanding && v.out === inJson[i].out),
  JSON.stringify(inSql.filter((v, i) =>
    !inJson[i] || v.outstanding !== inJson[i].outstanding || v.out !== inJson[i].out).slice(0, 3)));
ok("the vectors are not a token set -- there are enough of them to pin a rule",
  inJson.length >= 15, `only ${inJson.length}`);
ok("...including the float-dust case, which is the one a naive rule fails",
  inJson.some((v) => String(v.outstanding).includes("999999")),
  "no 999.9999999999999-style row, so cents-first rounding is not under test");
ok("...and the already-a-whole-hundred case",
  inJson.some((v) => v.outstanding === 1000 && v.out === 1100));

ok("CANARY: a changed vector is detected", (() => {
  const tampered = SQL.replace("(1000::numeric, 1100::numeric)", "(1000::numeric, 1200::numeric)");
  if (tampered === SQL) return false;            // the row must exist to tamper with
  const v = sqlVectors(tampered);
  return !v.every((x, i) => inJson[i] && x.out === inJson[i].out);
})(), "the value-for-value comparison cannot see a changed expectation");

// ---------------------------------------------------------------------------
// 2. The SQL rule does cents-first rounding
// ---------------------------------------------------------------------------
const ruleBody = (() => {
  const at = code(SQL).indexOf("function public.rule_deposit");
  const end = code(SQL).indexOf("$fn$;", at);
  return code(SQL).slice(at, end);
})();

ok("rule_deposit takes the figure to CENTS before rounding",
  /round\(\s*outstanding\s*\*\s*100\s*\)/.test(ruleBody),
  "float dust would push a deposit into the next hundred");
ok("it rounds UP to the next hundred with integer division, not with ceil on a float",
  /div\(\s*cents\s*\+\s*9999\s*,\s*10000\s*\)/.test(ruleBody));
ok("it adds the extra $100", /\*\s*100\s*\+\s*100/.test(ruleBody));
ok("a zero or negative figure asks for nothing", /if cents <= 0 then return 0/.test(ruleBody));
ok("it is IMMUTABLE, so it cannot read a row and change answer",
  /\bimmutable\b/i.test(ruleBody));

// ---------------------------------------------------------------------------
// 3. The engine writes the materials figure, quietly
// ---------------------------------------------------------------------------
ok("price-job's patch carries materials_to_buy",
  /materials_to_buy:\s*output\.totals\.materials_subtotal\s*\+\s*output\.totals\.tax/
    .test(code(LOAD).replace(/\/\*[\s\S]*?\*\//g, "")),
  "the deposit rule has nothing to read, so every job falls back to scaling");
ok("r67 puts materials_to_buy on the quiet list",
  /position\('materials_to_buy' in d\)/.test(SQL) && /'materials_to_buy'/.test(SQL));
ok("it edits the LIVE quiet list by anchor rather than retyping it",
  /pg_get_functiondef\('public\.touch_updated_at\(\)'::regprocedure\)/.test(SQL),
  "a retyped quiet list can silently drop an entry");
ok("and it raises rather than guessing if the anchor has moved",
  /raise exception 'touch_updated_at: the anchor/.test(SQL));

// Scoped to the DO BLOCK THAT EDITS THE QUIET LIST, not the whole file. The
// migration's own proofs contain the string deposit_amount -- one of them
// asserts it is absent from the live list -- so a file-wide check matched its
// own proof and reported a failure that was entirely its own.
const quietBlock = (() => {
  const c = code(SQL);
  const at = c.indexOf("do $quiet$");
  return c.slice(at, c.indexOf("end $quiet$", at));
})();

ok("the quiet-list edit block is where this thinks it is", quietBlock.length > 100);
ok("DEPOSIT_AMOUNT IS NEVER ADDED TO THE QUIET LIST",
  !/deposit_amount/.test(quietBlock),
  "a deposit a person types is an edit; making it quiet would lose it");

ok("CANARY: the quiet-list check would notice deposit_amount being added", (() => {
  const tampered = quietBlock.replace("'materials_to_buy'", "'materials_to_buy', 'deposit_amount'");
  return tampered !== quietBlock && /deposit_amount/.test(tampered);
})());

// ---------------------------------------------------------------------------
// 4. The protections survived the rewrite
// ---------------------------------------------------------------------------
const trigBody = (() => {
  const c = code(SQL);
  const at = c.indexOf("function public.deposit_follows_price");
  return c.slice(at, c.indexOf("$fn$;", at));
})();

ok("the typed-deposit gate reads OLD", /if not coalesce\(old\.deposit_is_auto, false\)/.test(trigBody));
ok("...and never NEW, which any writer could set in the same statement",
  !/new\.deposit_is_auto/.test(trigBody));
ok("the customer freeze is still read off OLD too",
  /old\.quote_approved_at is not null or old\.signed_at is not null/.test(trigBody));
ok("a deposit typed in the same statement still wins",
  /abs\(coalesce\(new\.deposit_amount, 0\)::numeric - old_dep\) > 0\.005/.test(trigBody));
ok("the result is capped at the price", /least\(wanted, new_total\)/.test(trigBody));
ok("the rule is applied to materials, not to a proportion",
  /rule_deposit\(materials - net_paid\)/.test(trigBody));
ok("change-order materials are a plain SUM of a stored column, not a calculation",
  /sum\(co\.material_cost\)/.test(trigBody));
ok("net paid is read off OLD, never from the incoming row",
  /old\.amount_paid/.test(trigBody) && !/new\.amount_paid/.test(trigBody),
  "a rule that trusts a client-supplied paid figure is one anyone can switch off");
ok("and a job with no engine figure still scales, so nothing regresses",
  /old_dep \/ old_total \* new_total/.test(trigBody));

ok("CANARY: the typed-deposit check can fail", (() => {
  const loosened = trigBody.replace("if not coalesce(old.deposit_is_auto, false)", "if false");
  return loosened !== trigBody && !/if not coalesce\(old\.deposit_is_auto, false\)/.test(loosened);
})());

console.log(`\npass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
