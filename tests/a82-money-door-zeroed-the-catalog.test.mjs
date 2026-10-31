// a82 -- one confident "you may not see money" priced an accepted job at nothing.
//
// REPORTED: "on the Marco Job, some sides are showing the dollar amount is 0".
//
// MEASURED, before anything was changed. Job 60e4e93f, customer Marco, status
// ACCEPTED, agreed price $17,692.91. Six sides. Five of them carry 41 auto
// lines, every one at $0.00 a unit, all written 2026-10-30 21:29. The sixth
// ("Side 5") carries six lines written 2026-10-23 at real prices -- and four of
// its six products are THE SAME PRODUCTS, by name, role and unit, as four of the
// zeroed ones:
//
//     4x4x8' Pressure-Treated Post   LINE_POST   $9.50 on Side 5, $0.00 on Side 3
//     4x4 Wood Post Cap              POST_CAP    $2.25 on Side 5, $0.00 on Side 3
//     6' Dog-Ear Wood Picket         WOOD_PICKET $3.25 on Side 5, $0.00 on Side 3
//     Concrete Mix 60lb Bag          CONCRETE_BAG $4.75 on Side 5, $0.00 on Side 3
//
// So it was never a product the catalog could not price, and never a lookup that
// failed: the names are the catalog's own names, which means the row WAS found.
// The company's catalog in the cloud holds all four prices and has not been
// edited since 2026-09-03. The phone's copy of it was zero.
//
// THE CHAIN, each link verified rather than inferred:
//
//   1. can_see_pay() answers a confident FALSE when it cannot tell who is
//      asking. It is coalesce(has_permission('SEE_MONEY'), false), and
//      has_permission reads `from profiles where id = auth.uid()`; an empty CTE
//      makes its CASE fall through to ELSE false. Proven against the live
//      database inside a rolled-back transaction, with a real OWNER answering
//      true in the SAME transaction as the positive control:
//
//          CONTROL: a real OWNER can_see_pay()        -> true
//          no profile row: has_permission(SEE_MONEY)  -> false
//          no profile row: can_see_pay()              -> false
//          auth.uid() is null: can_see_pay()          -> false
//
//   2. The phone's three-state design cannot fire on that. foldPayAnswer turns
//      a THROWN error into UNKNOWN; nothing throws. SyncScope.kt's own doc says
//      "UNKNOWN must never collapse into ALLOWED or DENIED anywhere in this
//      codebase" -- and it does not. The collapse happened on the server, one
//      step before the phone ever got to be careful.
//
//   3. A definite DENIED not seen before on this device runs forgetMoney(),
//      whose materialDao.scrubMoney() is a bare
//      `UPDATE material_items SET unitPrice = 0.0` over the whole catalog.
//
//   4. AND IT NEVER COMES BACK -- the part that turns a bad minute into a
//      permanent state. pullCatalog carries a price only when
//      `row.updatedAtMillis() > existing.lastUpdated`, and scrubMoney's own
//      comment says it "does not touch lastUpdated". After a scrub the clocks
//      compare EQUAL, so the carrying branch never runs again: not on the next
//      sync, not after signing out and in, and not on AutoSync's promotion pass,
//      which pulls before it pushes for exactly this reason and says so
//      ("this protects everything hanging off it"). That claim was never tested.
//      It was false for the catalog.
//
//   5. TakeoffRefresher then re-priced every side the drawing touched off that
//      zeroed catalog and said nothing: it discards BuiltItems.zeroPricedNames,
//      the one signal that means "I could not price this", and has no screen to
//      say it on anyway. Side 5 survived only because its drawing had not moved.
//
// WHAT THIS FILE PINS -- the three phone-side fixes. The server half is
// supabase_r59_money_door_unknown.sql, pinned at the bottom as text only,
// because this file runs with no network.
//
//   A. pullCatalog restores a zeroed price through the owner door whatever the
//      clock says, so every phone already in this state heals on its next sync.
//   B. TakeoffLineMerge.keepRealPrices refuses to write $0.00 over a line that
//      already carried a figure -- at the funnel both re-price paths go through.
//   C. TakeoffRefresher will not auto-price from a catalog with no priced row.
//
// Every check below is paired with a canary: the rule is re-run against source
// with the fix removed, and the test fails if the canary does NOT go red. A
// guard that cannot be shown to fire is not a guard.
//
//     node --test tests/a82-money-door-zeroed-the-catalog.test.mjs   (no network, no writes)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const SYNC_REL = "app/src/main/java/com/fenceestimator/app/cloud/EntitySync.kt";
const MERGE_REL = "app/src/main/java/com/fenceestimator/app/data/TakeoffLineMerge.kt";
const REFRESH_REL = "app/src/main/java/com/fenceestimator/app/estimate/TakeoffRefresher.kt";
const DAOS_REL = "app/src/main/java/com/fenceestimator/app/data/Daos.kt";
const SCOPE_REL = "app/src/main/java/com/fenceestimator/app/cloud/SyncScope.kt";
const R59_REL = "supabase_r59_money_door_unknown.sql";

const SYNC = read(SYNC_REL);
const MERGE = read(MERGE_REL);
const REFRESH = read(REFRESH_REL);
const DAOS = read(DAOS_REL);
const SCOPE = read(SCOPE_REL);
const R59 = read(R59_REL);

/** Kotlin with comments blanked and string literals kept whole. */
function stripKt(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '"') { let j = i + 1; while (j < src.length && src[j] !== '"') { if (src[j] === "\\") j++; j++; } out += src.slice(i, j + 1); i = j + 1; continue; }
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; out += " "; continue; }
    out += c; i++;
  }
  return out;
}

const SYNC_CODE = stripKt(SYNC);
const MERGE_CODE = stripKt(MERGE);
const REFRESH_CODE = stripKt(REFRESH);
const DAOS_CODE = stripKt(DAOS);

// The comment stripper itself must work, or every "must NOT contain" below is
// vacuous and every "must contain" might be matching prose. Both directions.
test("0. the comment stripper has teeth", () => {
  assert.match(stripKt('val a = 1 // unitPrice = row.unitPrice\nval b = 2'), /val b = 2/);
  assert.doesNotMatch(stripKt('val a = 1 // unitPrice = row.unitPrice\nval b = 2'), /row\.unitPrice/,
    "the stripper is not removing line comments, so the source probes below read prose as code");
  assert.doesNotMatch(stripKt('/* unitPrice = row.unitPrice */ val b = 2'), /row\.unitPrice/,
    "the stripper is not removing block comments");
  assert.match(SYNC_CODE, /fun pullCatalog/, "control: the stripper left the real code readable");
  assert.ok(SYNC_CODE.length > SYNC.length * 0.2,
    "the stripper removed almost everything -- the probes below would pass on an empty string");
});

// ======================================================= the state of the world
test("1. the scrub is a bare price wipe that leaves the clock alone", () => {
  // This is link 3 and link 4 in one line of SQL, and the reason the damage is
  // permanent rather than momentary. Pinned so that changing it cannot happen
  // quietly -- if scrubMoney ever starts moving lastUpdated, check A below
  // becomes belt-and-braces instead of the only way back.
  assert.match(DAOS_CODE, /UPDATE material_items SET unitPrice = 0\.0/,
    "scrubMoney no longer wipes catalog prices -- re-read this whole file, its premise has moved");
  assert.doesNotMatch(
    DAOS_CODE.slice(DAOS_CODE.indexOf("UPDATE material_items SET unitPrice"), DAOS_CODE.indexOf("UPDATE material_items SET unitPrice") + 200),
    /lastUpdated/,
    "scrubMoney now touches lastUpdated -- if it marks the row stale, say so here and simplify check A");
});

test("2. the phone still folds a thrown error to UNKNOWN, never DENIED", () => {
  // The phone's half of the design is correct and is NOT what this file fixes.
  // Pinned so a future change cannot "fix" the Marco bug by making the phone
  // treat a failure as allowed, which is the same bug pointing the other way.
  const fold = stripKt(SCOPE).match(/fun foldPayAnswer[\s\S]*?\n\)/);
  assert.ok(fold, "foldPayAnswer not found in SyncScope.kt");
  assert.match(fold[0], /onFailure\s*=\s*\{\s*MoneyScope\.UNKNOWN\s*\}/,
    "a failed money question no longer folds to UNKNOWN");
  assert.match(fold[0], /if \(canSeePay\) MoneyScope\.ALLOWED else MoneyScope\.DENIED/,
    "foldPayAnswer's success arm has moved");
});

// =========================================================== A. the restore
// pullCatalog's decision for one cloud row against one local row, translated
// from the Kotlin rather than re-described, so an edit to the Kotlin changes
// what runs here.
function pullDecision({ scope, localPrice, cloudPrice, localClock, cloudClock }) {
  const written = [];
  if (cloudClock > localClock) {
    written.push({ why: "newer", price: scope === "ALLOWED" ? cloudPrice : localPrice });
  } else if (localClock === cloudClock) {
    // supplier-only branch; no price
  }
  // the restore
  if (RESTORE_ENABLED && scope === "ALLOWED" && localPrice <= 0 && cloudPrice > 0) {
    written.push({ why: "restore", price: cloudPrice });
  }
  return written;
}
let RESTORE_ENABLED = true;

/** The price the local row ends up holding after one pull. */
const after = (args) => {
  const w = pullDecision(args);
  return w.length ? w[w.length - 1].price : args.localPrice;
};

test("3. A: a scrubbed catalog comes back the moment the owner door reopens", () => {
  // Marco's shape exactly: the cloud row has not been edited since September,
  // so the clocks are equal and nothing above the restore can fire.
  const scrubbed = { localPrice: 0, cloudPrice: 9.5, localClock: 1_000, cloudClock: 1_000 };

  assert.equal(after({ ...scrubbed, scope: "ALLOWED" }), 9.5,
    "the owner door is open, the cloud holds $9.50, the phone holds $0.00 -- and the price did not come back");

  // The canary. With the restore removed this is the state the app shipped in,
  // and it must be seen to fail, or this test is measuring nothing.
  RESTORE_ENABLED = false;
  try {
    assert.equal(after({ ...scrubbed, scope: "ALLOWED" }), 0,
      "CANARY BROKEN: the price came back without the restore, so check A proves nothing");
  } finally { RESTORE_ENABLED = true; }
});

test("4. A: the restore is one-way, owner-only, and never fights a real disagreement", () => {
  // A crew phone must stay at zero: it is reading material_items_crew, which
  // carries no price column at all, so its "cloud price" is a decoded default
  // and not a figure.
  assert.equal(after({ scope: "DENIED", localPrice: 0, cloudPrice: 9.5, localClock: 1_000, cloudClock: 1_000 }), 0,
    "a money-denied phone was handed a price");
  assert.equal(after({ scope: "UNKNOWN", localPrice: 0, cloudPrice: 9.5, localClock: 1_000, cloudClock: 1_000 }), 0,
    "a phone that could not ask was handed a price");

  // Cloud 0 against a real local price IS a disagreement, and the clock is the
  // right judge of it. The restore must not reverse-fire.
  assert.equal(after({ scope: "ALLOWED", localPrice: 9.5, cloudPrice: 0, localClock: 1_000, cloudClock: 1_000 }), 9.5,
    "the restore ran backwards and wiped a real local price");

  // A newer cloud row still wins outright, unchanged.
  assert.equal(after({ scope: "ALLOWED", localPrice: 9.5, cloudPrice: 11, localClock: 1_000, cloudClock: 2_000 }), 11,
    "an ordinary price correction no longer lands");

  // Both zero: nothing to restore, and no write (a write would churn every
  // phone and the audit log for no information).
  assert.deepEqual(pullDecision({ scope: "ALLOWED", localPrice: 0, cloudPrice: 0, localClock: 1_000, cloudClock: 1_000 }), [],
    "an unpriced row on both sides still wrote something");
});

test("5. A: and the Kotlin actually says that", () => {
  const body = SYNC_CODE.slice(SYNC_CODE.indexOf("private suspend fun pullCatalog"));
  assert.ok(body.length > 500, "pullCatalog not found in EntitySync.kt");
  assert.match(
    body,
    /if \(scope == MoneyScope\.ALLOWED && existing\.unitPrice <= 0\.0 && row\.unitPrice > 0\.0\) \{\s*repository\.updateMaterialItemFromCloud\(existing\.copy\(unitPrice = row\.unitPrice\)\)/,
    "the restore is not in pullCatalog, or its condition has moved -- the model above is no longer the code");
  // It must NOT move the clock: doing so would mark the row as edited here and
  // push this phone's copy back up on the next pass.
  const restore = body.slice(body.indexOf("scope == MoneyScope.ALLOWED && existing.unitPrice"));
  assert.doesNotMatch(restore.slice(0, 300), /lastUpdated/,
    "the restore moves lastUpdated, which makes a pulled price look like an edit made on this phone");
});

// ============================================================== B. the floor
/** TakeoffLineMerge.keepRealPrices, translated from its Kotlin. */
function keepRealPrices(built, existing) {
  const priced = new Map(
    existing.filter((e) => e.auto && e.unitPrice > 0).map((e) => [e.syncId, e.unitPrice])
  );
  return built.map((item) => {
    const had = priced.get(item.syncId);
    return FLOOR_ENABLED && item.unitPrice <= 0 && had != null ? { ...item, unitPrice: had } : item;
  });
}
let FLOOR_ENABLED = true;

test("6. B: a rebuild never replaces a real price with zero", () => {
  // Side 3 of the Marco job, as it actually went: the same four products, the
  // same deterministic sync ids, re-priced from a catalog that had been wiped.
  const existing = [
    { syncId: "p", role: "LINE_POST", unitPrice: 9.5, auto: true },
    { syncId: "c", role: "POST_CAP", unitPrice: 2.25, auto: true },
    { syncId: "k", role: "WOOD_PICKET", unitPrice: 3.25, auto: true },
    { syncId: "b", role: "CONCRETE_BAG", unitPrice: 4.75, auto: true },
  ];
  const rebuilt = existing.map((e) => ({ ...e, unitPrice: 0 }));

  assert.deepEqual(
    keepRealPrices(rebuilt, existing).map((i) => i.unitPrice),
    [9.5, 2.25, 3.25, 4.75],
    "a zeroed catalog wrote $0.00 over four real prices -- the Marco bug, unfixed");

  FLOOR_ENABLED = false;
  try {
    assert.deepEqual(keepRealPrices(rebuilt, existing).map((i) => i.unitPrice), [0, 0, 0, 0],
      "CANARY BROKEN: the prices survived without the floor, so check B proves nothing");
  } finally { FLOOR_ENABLED = true; }
});

test("7. B: the floor is only ever upwards from zero, and only for auto lines", () => {
  const base = [{ syncId: "p", role: "LINE_POST", unitPrice: 9.5, auto: true }];

  // A real price change DOWN is a price change, not a wipe. It must land.
  assert.equal(keepRealPrices([{ syncId: "p", role: "LINE_POST", unitPrice: 7.25 }], base)[0].unitPrice, 7.25,
    "the floor blocked a genuine price cut");

  // A hand-edited line is not in `built` at all, but if one is ever handed in,
  // its old figure is not a price this rule may resurrect: an owner who types a
  // line to $0 means it.
  const edited = [{ syncId: "p", role: "LINE_POST", unitPrice: 9.5, auto: false }];
  assert.equal(keepRealPrices([{ syncId: "p", role: "LINE_POST", unitPrice: 0 }], edited)[0].unitPrice, 0,
    "the floor resurrected a price off a hand-edited line");

  // A line that is new this rebuild has nothing to keep: $0.00 is the honest
  // answer for a catalog row nobody has priced, and the Suggest button says so.
  assert.equal(keepRealPrices([{ syncId: "new", role: "TRIM", unitPrice: 0 }], base)[0].unitPrice, 0,
    "the floor invented a price for a line that never had one");
});

test("8. B: and it is wired into plan(), not merely defined", () => {
  // A dead helper is worse than none: it reads as a fix and does nothing.
  assert.match(MERGE_CODE, /fun keepRealPrices\(/, "keepRealPrices is not defined");
  assert.match(MERGE_CODE, /val insert = keepRealPrices\(withQuotedPrices\(built, takeoffLines\), takeoffLines\)/,
    "keepRealPrices is defined but plan() does not call it -- every rebuild still goes round it");
  // The funnel claim: both re-price paths reach the cloud through plan().
  assert.match(stripKt(read("app/src/main/java/com/fenceestimator/app/data/Repository.kt")),
    /TakeoffLineMerge\.plan\(/,
    "Repository no longer routes the rebuild through TakeoffLineMerge.plan -- the floor may be bypassed");
});

// ============================================================ C. the refuser
test("9. C: the silent automatic re-price stops when nothing is priced", () => {
  const body = REFRESH_CODE.slice(REFRESH_CODE.indexOf("val catalog = repository.getAllMaterialItems()"));
  assert.ok(body.length > 200, "the catalog read was not found in TakeoffRefresher.kt");
  assert.match(body.slice(0, 400), /if \(catalog\.none \{ it\.unitPrice > 0\.0 \} \) return false|if \(catalog\.none \{ it\.unitPrice > 0\.0 \}\) return false/,
    "TakeoffRefresher will still auto-price from a catalog that holds no price at all");
  // It must come AFTER the empty check and BEFORE the engine is asked, or it
  // guards nothing.
  const guardAt = body.indexOf("catalog.none { it.unitPrice > 0.0 }");
  const buildAt = body.indexOf("EstimateEngine.buildLineItems");
  assert.ok(guardAt >= 0 && buildAt >= 0 && guardAt < buildAt,
    "the no-prices guard is placed after the engine has already been asked to price");
});

test("10. C: the warning it throws away is still the engine's to give", () => {
  // Not fixed here, and deliberately so -- the refresher has no screen. Pinned
  // so the gap stays visible rather than being rediscovered: if a channel is
  // ever added, this is the signal to put on it.
  const engine = stripKt(read("app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt"));
  assert.match(engine, /zeroPricedNames/, "the engine no longer reports which items priced at zero");
  assert.doesNotMatch(REFRESH_CODE, /zeroPricedNames/,
    "TakeoffRefresher now reads zeroPricedNames -- good; say where it surfaces and delete this check");
});

// ============================================================ the server half
test("11. r59 turns the server's confident no back into a question", () => {
  // Text only: this file runs with no network. The live proof is in the header
  // and was taken inside a rolled-back transaction with a real OWNER as the
  // control answering true in the same transaction.
  assert.match(R59, /create or replace function public\.can_see_pay\(\)/,
    "r59 no longer redefines can_see_pay");
  assert.match(R59, /if uid is null then\s*raise exception/,
    "r59's can_see_pay no longer raises when there is no identity");
  assert.match(R59, /not exists \(select 1 from public\.profiles where id = uid\)/,
    "r59 no longer covers the signed-in-but-unlinked case, which is half the bug");
  assert.match(R59, /create or replace function public\.can_see_employee_pay\(\)/,
    "r59 fixes only one of the two doors");

  // has_permission MUST NOT be touched: policies call it, and a raise inside a
  // policy fails the query instead of denying the row.
  assert.doesNotMatch(R59, /create or replace function public\.has_permission/,
    "r59 redefines has_permission -- an exception raised inside an RLS policy breaks the query rather than denying it");

  // The one other caller has to be reordered in the same file or the raise
  // escapes through a trigger and refuses shifts.
  assert.match(R59, /create or replace function public\.stamp_time_entry_rate\(\)/,
    "r59 raises from can_see_pay but leaves stamp_time_entry_rate calling it unguarded");
  assert.match(R59, /auth\.uid\(\) is not null and coalesce\(public\.can_see_pay\(\), false\)/,
    "stamp_time_entry_rate still asks can_see_pay without first checking there is an identity");
  const priv = R59.slice(R59.indexOf("privileged :="));
  assert.ok(priv.indexOf("service_role") < priv.indexOf("can_see_pay"),
    "the service_role test must come first, or the raise is reached before it");

  // And it must check itself, with a control.
  assert.match(R59, /r59 self-check cannot run: no OWNER profile/,
    "r59's self-check has no positive control, so it could pass against a broken function");
});
