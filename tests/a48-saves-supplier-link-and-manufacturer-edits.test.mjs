// a48-saves-supplier-link-and-manufacturer-edits -- two ways a supplier edit was saved on the phone and never survived.
//
// He reported: "I added information about the manufacturer and I tried to save it and it did not", and "there has been some data
// not saving issue". docs/SAVE_FAILURES.md has the diagnosis, the evidence and what was ruled out. This file holds the two
// defects that were found in EntitySync.kt and fixed there, and what is NOT fixed by it.
//
//   A. THE SUPPLIER ON A CATALOG ROW NEVER SYNCED, in either direction.
//      The phone's "Priced from" picker wrote MaterialItem.manufacturerId (a Room id) and the cloud shape had no
//      manufacturer_sync_id, so the choice stayed on the phone; a supplier set on the website (or the 32 supplier rows
//      loaded on 1 Oct 2026) was never read. And a catalog row's identity ignored its supplier, so "Duplicate for
//      supplier" -- same name, role, type and colour, different supplier -- read as a copy of the original under another
//      sync id, was never pushed (nothing logged, nothing on screen) and, pulled, was dropped.
//
//   B. A SUPPLIER EDIT COULD BE UNDONE BY THE SAME PASS THAT WAS MEANT TO CARRY IT.
//      Every supplier went up on every pass, unconditionally, and the pull wrote the cloud's copy over every supplier it
//      held, with nothing saying "changed here, not yet taken". So: an edit whose push failed was put back by the pull of the
//      same pass; an edit saved while a pass was in flight was put back; and a supplier changed on the website was put
//      back by the phone's next push, because the phone's copy was older and nothing asked which was newer.
//      The fix is an IN-MEMORY ledger (ManufacturerSyncLedger). It does not survive the process dying; the lasting fix is a
//      column on Manufacturer, which is Entities.kt + a Room migration and is not this file's to make. The KNOWN LIMIT tests
//      below pin exactly what the ledger does NOT cover, so that nobody reads this as the whole fix.
//
// HOW THIS FILE TESTS KOTLIN THAT WAS NOT COMPILED. A release publish was running its Gradle gates, and a second Gradle run
// starves it, so this change was written and read line by line but never compiled or run on a phone. Like
// tests/a40-height-carriers.test.mjs and tests/a46-catalog-height-phone-editor.test.mjs this reads the Kotlin as text, and:
//   - the small decision functions (catalogRowIsOwed, catalogSupplierSay, supplierNeedsPush, supplierPullMayOverwrite) are
//     TRANSLATED FROM THEIR KOTLIN TEXT by a deliberately tiny translator and run -- so an edit to the Kotlin changes what
//     runs here, and a construct the translator does not know fails loudly instead of being guessed at;
//   - catalogIdentity, supplierFromCloud and catalogPushBatches use Kotlin idioms the translator does not do; they are hand
//     ports, PINNED to the Kotlin text by regex;
//   - the orchestration (which function is called when, and what is remembered after a failure) is a JS model of
//     pushManufacturers / pullManufacturers, pinned to the Kotlin text the same way.
// The scenarios therefore prove the DECISION TABLE the Kotlin text encodes. They are not a substitute for compiling the app,
// and not a test on a device.
//
// WHY THIS FAILS AGAINST THE OLD CODE: the old EntitySync.kt has none of the functions below, no manufacturer_sync_id and an
// unconditional pushManufacturers, so every group here is red on it. Run it with A48_ENTITYSYNC=<path to an old copy> to see.
//
//   node --test tests/a48-saves-supplier-link-and-manufacturer-edits.test.mjs        (no network, no writes)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SYNC_REL = "app/src/main/java/com/fenceestimator/app/cloud/EntitySync.kt";
const syncPath = process.env.A48_ENTITYSYNC ? (isAbsolute(process.env.A48_ENTITYSYNC) ? process.env.A48_ENTITYSYNC : join(ROOT, process.env.A48_ENTITYSYNC)) : join(ROOT, SYNC_REL);
// Line endings normalised: a checkout with core.autocrlf turns every file CRLF, and these checks match across line breaks.
const SRC = readFileSync(syncPath, "utf8").replace(/\r\n/g, "\n");

// ================================================================== readers ==
/** Kotlin with comments blanked and string literals kept whole ("..." only; a backtick quotes an identifier in Kotlin). */
function stripKt(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '"') { let j = i + 1; while (j < src.length && src[j] !== '"') { if (src[j] === "\\") j++; j++; } out += src.slice(i, j + 1); i = j + 1; continue; }
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; out += " "; continue; }
    out += c; i++;
  }
  return out;
}
/** The text between the braces that open at the end of `headerRe`'s match. */
function braceBody(code, headerRe) {
  const m = headerRe.exec(code);
  assert.ok(m, "not found in EntitySync.kt: " + headerRe);
  let i = m.index + m[0].length, depth = 1;
  const start = i;
  while (i < code.length && depth > 0) { if (code[i] === "{") depth++; else if (code[i] === "}") depth--; i++; }
  assert.equal(depth, 0, "unbalanced braces after " + headerRe);
  return code.slice(start, i - 1);
}
/** The text between the parentheses that open at the end of `headerRe`'s match. */
function parenBody(code, headerRe) {
  const m = headerRe.exec(code);
  assert.ok(m, "not found in EntitySync.kt: " + headerRe);
  let i = m.index + m[0].length, depth = 1;
  const start = i;
  while (i < code.length && depth > 0) { if (code[i] === "(") depth++; else if (code[i] === ")") depth--; i++; }
  assert.equal(depth, 0, "unbalanced parentheses after " + headerRe);
  return code.slice(start, i - 1);
}
const CODE = stripKt(SRC);
const squash = (s) => s.replace(/\s+/g, " ").trim();

// ========================================================= the tiny translator ==
// Kotlin -> JS for the handful of small pure functions below, and for nothing else. It knows: typed parameters, a block body or
// an `= expr` body, `if (c) return x`, `return x`, `if (c) a else b` as an expression, `when { c -> v ... else -> v }`, enum
// constants (SupplierSay.X -> "X"), `&&`, `||`, `!`, `null`, and `==` / `!=` between names, which become DEEP equality (a Kotlin
// data class compares by value). Anything else in the body is refused rather than guessed: the check at the end lists what is
// left once the known constructs are out of the way.
const deepEq = (a, b) => (a ?? null) === (b ?? null) || (a != null && b != null && typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));
function translate(code, name) {
  const m = new RegExp("internal fun " + name + "\\(").exec(code);
  assert.ok(m, `internal fun ${name}( is not in EntitySync.kt`);
  let i = m.index + m[0].length, depth = 1;
  const ps = i;
  while (i < code.length && depth > 0) { if (code[i] === "(") depth++; else if (code[i] === ")") depth--; i++; }
  const params = code.slice(ps, i - 1).split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.split(":")[0].trim());
  const rest = code.slice(i);
  const hdr = /^\s*:\s*[A-Za-z0-9_<>?, ]+?\s*(\{|=)/.exec(rest);
  assert.ok(hdr, `${name}: could not read the return type`);
  let body;
  if (hdr[1] === "{") {
    let j = hdr[0].length, d = 1;
    const start = j;
    while (j < rest.length && d > 0) { if (rest[j] === "{") d++; else if (rest[j] === "}") d--; j++; }
    body = rest.slice(start, j - 1);
  } else {
    const after = rest.slice(hdr[0].length);
    const end = after.search(/\n\n/);
    body = "return " + (end < 0 ? after : after.slice(0, end)) + ";";
  }
  // when { c -> v ...  else -> v } as the expression of a `return`
  body = body.replace(/return\s+when\s*\{([\s\S]*?)\n?\s*\}\s*;?\s*$/, (_, arms) => {
    const lines = arms.split("\n").map((l) => l.trim()).filter(Boolean);
    let expr = "";
    let closing = "";
    for (const l of lines) {
      const arm = /^(.*?)\s*->\s*(.*)$/.exec(l);
      assert.ok(arm, `${name}: cannot read the when arm: ${l}`);
      if (arm[1] === "else") { expr += arm[2]; break; }
      expr += `(${arm[1]}) ? ${arm[2]} : `;
    }
    return "return " + expr + ";" + closing;
  });
  // `return if (c) a else b`
  body = body.replace(/return\s+if\s*\((.*?)\)\s*(.*?)\s+else\s+(.*?);/, "return ($1) ? $2 : $3;");
  body = body.replace(/\bSupplierSay\.(\w+)/g, '"$1"');
  body = body.replace(/([\w.]+)\s*==\s*([\w.]+|"[^"]*")/g, "eq($1, $2)").replace(/([\w.]+)\s*!=\s*([\w.]+|"[^"]*")/g, "!eq($1, $2)");
  // what is left must be plain JS the translator has no business guessing at
  const left = body.replace(/eq\([^)]*\)|"[A-Z]+"|\breturn\b|\bif\b|\bnull\b|\btrue\b|\bfalse\b|[A-Za-z_]\w*|[\s();!&|?:<>]+/g, "");
  assert.equal(left, "", `${name}: the translator met syntax it does not know: ${JSON.stringify(left)}\n${body}`);
  // eslint-disable-next-line no-new-func
  return new Function("eq", `return function ${name}(${params.join(", ")}) {\n${body}\n};`)(deepEq);
}
const FN = (code) => ({
  catalogRowIsOwed: translate(code, "catalogRowIsOwed"),
  catalogSupplierSay: translate(code, "catalogSupplierSay"),
  supplierNeedsPush: translate(code, "supplierNeedsPush"),
  supplierPullMayOverwrite: translate(code, "supplierPullMayOverwrite"),
});

// ======================================================== hand ports, pinned ==
/** catalogIdentity: name, role, fence type, colour and supplier, each trimmed and lower-cased, joined by a bar. */
function pinIdentity(code) {
  const body = squash(code.slice(code.indexOf("internal fun catalogIdentity("), code.indexOf("internal fun catalogRowIsOwed(")));
  assert.match(body, /listOf\(name, role, fenceType, colour, supplierSyncId\.orEmpty\(\)\)\.joinToString\("\|"\) \{ it\.trim\(\)\.lowercase\(\) \}/, "catalogIdentity no longer reads: the five fields, the supplier blank when absent, trimmed, lower-cased, joined by |");
}
const catalogIdentity = (name, role, fenceType, colour, supplier) => [name, role, fenceType, colour, supplier ?? ""].map((s) => s.trim().toLowerCase()).join("|");

/** supplierFromCloud: the cloud's supplier when this phone holds it, else what the phone has. */
function pinFromCloud(code) {
  const body = squash(code.slice(code.indexOf("internal fun supplierFromCloud("), code.indexOf("internal fun catalogPushBatches(")));
  assert.match(body, /cloudSupplier\?\.let \{ localIdBySyncId\[it\] \} \?: current/, "supplierFromCloud no longer reads: cloud's supplier if this phone holds it, else the phone's own");
}
const supplierFromCloud = (cloudSupplier, localIdBySyncId, current) => (cloudSupplier != null ? (localIdBySyncId.get(cloudSupplier) ?? null) : null) ?? current;

/** catalogPushBatches: rows encoded (null left out), a clear row gets an explicit null, grouped by the columns each names. */
function pinBatches(code) {
  const body = squash(code.slice(code.indexOf("internal fun catalogPushBatches("), code.indexOf("internal data class SupplierContent(")));
  assert.match(body, /if \(row\.syncId in clearSupplierFor\) put\("manufacturer_sync_id", JsonNull\)/, "a clear row no longer says null out loud");
  assert.match(body, /\.groupBy \{ it\.keys \}\.values\.toList\(\)/, "rows are no longer grouped by the columns they name");
}
const encodeRow = (row) => { const o = {}; for (const [k, v] of Object.entries(row)) if (v !== null && v !== undefined) o[k] = v; return o; };
const catalogPushBatches = (rows, clear) => {
  const groups = new Map();
  for (const row of rows) {
    const o = encodeRow(row);
    if (clear.has(row.sync_id)) o.manufacturer_sync_id = null;
    const key = Object.keys(o).sort().join(",");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  return [...groups.values()];
};

// =========================================================== the ledger model ==
// A JS model of pushManufacturers / pullManufacturers over a world of two maps, using the TRANSLATED decision functions. Pinned
// to the Kotlin text by pinOrchestration below.
const content = (s) => ({ name: s.name, email: s.email, phone: s.phone, address: s.address, hours: s.hours, notes: s.notes });
class Ledger {
  constructor() { this.agreed = new Map(); this.unsent = new Map(); }
  agree(id, c) { this.agreed.set(id, c); this.unsent.delete(id); }
  failedToSend(id, c) { this.unsent.set(id, c); }
  refused(id) { this.unsent.delete(id); }
}
const sup = (name, phone = "", extra = {}) => ({ name, email: "", phone, address: "", hours: "", notes: "", ...extra });
function world() { return { phone: new Map(), cloud: new Map(), ledger: new Ledger() }; }
const clone = (m) => new Map([...m].map(([k, v]) => [k, { ...v }]));

function newPush(fns, w, { readFails = false, pushFails = false, refused = false } = {}) {
  const local = [...w.phone];
  if (!local.length) return 0;
  if (readFails) {
    for (const [id, s] of local) { const mine = content(s); const agreed = w.ledger.agreed.get(id) ?? null; if (agreed == null || !deepEq(mine, agreed)) w.ledger.failedToSend(id, mine); }
    throw new Error("read failed");
  }
  const owed = [];
  for (const [id, s] of local) {
    const mine = content(s); const cloud = w.cloud.has(id) ? content(w.cloud.get(id)) : null;
    if (cloud != null && deepEq(mine, cloud)) w.ledger.agree(id, mine);
    if (fns.supplierNeedsPush(mine, cloud, w.ledger.agreed.get(id) ?? null)) owed.push([id, s]);
  }
  if (!owed.length) return 0;
  if (pushFails || refused) {
    for (const [id, s] of owed) { if (refused) w.ledger.refused(id); else w.ledger.failedToSend(id, content(s)); }
    throw new Error(refused ? "refused" : "push failed");
  }
  for (const [id, s] of owed) { w.cloud.set(id, { ...s }); w.ledger.agree(id, content(s)); }
  return owed.length;
}
function newPull(fns, w) {
  for (const [id, row] of w.cloud) {
    const theirs = content(row);
    if (!w.phone.has(id)) { w.phone.set(id, { ...row }); w.ledger.agree(id, theirs); continue; }
    const mine = content(w.phone.get(id));
    if (deepEq(mine, theirs)) { w.ledger.agree(id, theirs); continue; }
    if (fns.supplierPullMayOverwrite(mine, w.ledger.agreed.get(id) ?? null, w.ledger.unsent.get(id) ?? null)) {
      w.phone.set(id, { ...w.phone.get(id), ...theirs }); w.ledger.agree(id, theirs);
    }
  }
}
// What every pass did before: all suppliers up, the cloud's copy over all of them.
function oldPush(w, { pushFails = false } = {}) { if (pushFails) throw new Error("push failed"); for (const [id, s] of w.phone) w.cloud.set(id, { ...s }); }
function oldPull(w) { for (const [id, row] of w.cloud) w.phone.set(id, { ...(w.phone.get(id) ?? {}), ...row }); }
const attempt = (f) => { try { f(); return null; } catch (e) { return e; } };

// A pass is push then pull, exactly as AutoSync.runSync runs them on every pass but the promotion pass. The pull runs whether
// or not the push worked; that is the code, and several scenarios depend on it.
const newPass = (fns, w, opts, between) => { attempt(() => newPush(fns, w, opts)); if (between) between(); attempt(() => newPull(fns, w)); };
const oldPass = (w, opts, between) => { attempt(() => oldPush(w, opts)); if (between) between(); attempt(() => oldPull(w)); };

/** The scenarios. Each returns the list of things that went wrong under the NEW rules; the legacy twin returns what went wrong under the old ones. */
function scenarios(fns) {
  const out = {};
  const settled = () => { const w = world(); w.phone.set("s1", sup("Supplier One", "555-0100")); w.cloud.set("s1", sup("Supplier One", "555-0100")); newPass(fns, w); return w; };

  out["an ordinary edit on the phone reaches the cloud and comes back unchanged"] = () => {
    const w = settled(); w.phone.set("s1", { ...w.phone.get("s1"), phone: "555-0199" });
    newPass(fns, w);
    return w.cloud.get("s1").phone === "555-0199" && w.phone.get("s1").phone === "555-0199" ? [] : ["the edit did not make the round trip"];
  };
  out["a push that fails does not let the same pass's pull put the old copy back"] = () => {
    const w = settled(); w.phone.set("s1", { ...w.phone.get("s1"), hours: "Mon-Fri 7-4" });
    newPass(fns, w, { pushFails: true });
    const bad = []; if (w.phone.get("s1").hours !== "Mon-Fri 7-4") bad.push("the pull undid an edit whose push failed");
    newPass(fns, w);
    if (w.cloud.get("s1").hours !== "Mon-Fri 7-4") bad.push("the edit never reached the cloud once the push could succeed");
    return bad;
  };
  out["a push whose cloud read fails does not let the same pass's pull put the old copy back"] = () => {
    const w = settled(); w.phone.set("s1", { ...w.phone.get("s1"), notes: "ask for Dana" });
    newPass(fns, w, { readFails: true });
    const bad = []; if (w.phone.get("s1").notes !== "ask for Dana") bad.push("the pull undid an edit the push could not even compare");
    newPass(fns, w);
    if (w.cloud.get("s1").notes !== "ask for Dana") bad.push("the edit never reached the cloud");
    return bad;
  };
  out["a supplier this process has never seen agree, whose push fails, is not undone by the pull either"] = () => {
    const w = world(); w.phone.set("s1", sup("Supplier One", "555-0199")); w.cloud.set("s1", sup("Supplier One", "555-0100"));   // an edit made before the app was restarted, ledger empty
    newPass(fns, w, { pushFails: true });
    const bad = []; if (w.phone.get("s1").phone !== "555-0199") bad.push("the pull undid an edit whose push failed, on a phone with no history");
    newPass(fns, w);
    if (w.cloud.get("s1").phone !== "555-0199") bad.push("the edit never reached the cloud");
    return bad;
  };
  out["an edit saved while a pass is in flight (after the push read, before the pull) is kept and goes up next pass"] = () => {
    const w = settled();
    newPass(fns, w, {}, () => { w.phone.set("s1", { ...w.phone.get("s1"), address: "12 Yard Rd" }); });
    const bad = []; if (w.phone.get("s1").address !== "12 Yard Rd") bad.push("the pull overwrote an edit saved mid-pass");
    newPass(fns, w);
    if (w.cloud.get("s1").address !== "12 Yard Rd") bad.push("the mid-pass edit never reached the cloud");
    return bad;
  };
  out["a supplier changed on the website survives the phone's next push and arrives on the phone"] = () => {
    const w = settled(); w.cloud.set("s1", { ...w.cloud.get("s1"), phone: "555-0777" });   // the office edits it
    newPass(fns, w);
    const bad = [];
    if (w.cloud.get("s1").phone !== "555-0777") bad.push("the phone's push put its older copy back over the office's edit");
    if (w.phone.get("s1").phone !== "555-0777") bad.push("the office's edit did not reach the phone");
    return bad;
  };
  out["a phone the server refuses to take suppliers from keeps receiving the office's changes"] = () => {
    const w = world(); w.phone.set("s1", sup("Supplier One", "555-0100")); w.cloud.set("s1", sup("Supplier One", "555-0111"));
    newPass(fns, w, { refused: true });
    return w.phone.get("s1").phone === "555-0111" ? [] : ["a refused phone stopped taking the cloud's copy"];
  };
  out["a supplier new on the phone goes up, and one new in the cloud comes down"] = () => {
    const w = settled(); w.phone.set("s2", sup("Supplier Two")); w.cloud.set("s3", sup("Supplier Three"));
    newPass(fns, w);
    const bad = []; if (!w.cloud.has("s2")) bad.push("a new phone supplier never went up"); if (!w.phone.has("s3")) bad.push("a new cloud supplier never came down");
    return bad;
  };
  out["when both sides changed, the phone's copy wins, as every pass always did"] = () => {
    const w = settled();
    w.phone.set("s1", { ...w.phone.get("s1"), phone: "555-0001" }); w.cloud.set("s1", { ...w.cloud.get("s1"), phone: "555-0002" });
    newPass(fns, w);
    return w.cloud.get("s1").phone === "555-0001" && w.phone.get("s1").phone === "555-0001" ? [] : ["the both-changed rule moved"];
  };
  return out;
}
/** The same scenarios against what every pass did before the ledger. Returns, per scenario, whether the OLD rules lose something. */
function legacyLosses() {
  const losses = {};
  const settled = () => { const w = world(); w.phone.set("s1", sup("Supplier One", "555-0100")); w.cloud.set("s1", sup("Supplier One", "555-0100")); oldPass(w); return w; };
  { const w = settled(); w.phone.set("s1", { ...w.phone.get("s1"), hours: "Mon-Fri 7-4" }); oldPass(w, { pushFails: true }); losses.pushFailsThenPull = w.phone.get("s1").hours !== "Mon-Fri 7-4"; }
  { const w = settled(); oldPass(w, {}, () => { w.phone.set("s1", { ...w.phone.get("s1"), address: "12 Yard Rd" }); }); losses.editMidPass = w.phone.get("s1").address !== "12 Yard Rd"; }
  { const w = settled(); w.cloud.set("s1", { ...w.cloud.get("s1"), phone: "555-0777" }); oldPass(w); losses.websiteEditPutBack = w.cloud.get("s1").phone !== "555-0777"; }
  return losses;
}

// ====================================================== catalog scenarios ==
const item = (o) => ({ syncId: "i1", name: "Panel 6x6", role: "PANEL", fenceType: "VINYL", colour: "White", supplier: null, lastUpdated: 100, ...o });
const cloudRow = (o) => ({ syncId: "i1", name: "Panel 6x6", role: "PANEL", fenceType: "VINYL", colour: "White", supplier: null, updatedAt: 100, ...o });
/** The push filter before the change: identity without the supplier, and only a row claimed under its own id is gated by the clock. */
function oldOwed(local, cloud) {
  const ident = (r) => [r.name, r.role, r.fenceType, r.colour].map((s) => s.trim().toLowerCase()).join("|");
  const byIdentity = new Map(cloud.map((r) => [ident(r), r]));
  return local.filter((it) => { const claimed = byIdentity.get(ident(it)); return claimed == null || (claimed.syncId === it.syncId && it.lastUpdated > claimed.updatedAt); }).map((it) => it.syncId);
}
/** The push filter as pushCatalog now composes it from the translated pieces. */
function newOwed(fns, local, cloud) {
  const bySync = new Map(cloud.map((r) => [r.syncId, r]));
  const byIdentity = new Map(cloud.map((r) => [catalogIdentity(r.name, r.role, r.fenceType, r.colour, r.supplier), r]));
  return local.filter((it) => {
    const held = bySync.get(it.syncId) ?? null;
    const heldUnderAnotherId = held == null && byIdentity.get(catalogIdentity(it.name, it.role, it.fenceType, it.colour, it.supplier)) != null;
    return fns.catalogRowIsOwed(it.lastUpdated, held != null, held?.updatedAt ?? 0, heldUnderAnotherId);
  }).map((it) => it.syncId);
}

// ============================================================ orchestration pins ==
function pinOrchestration(code) {
  const problems = [];
  const need = (cond, what) => { if (!cond) problems.push(what); };
  const push = squash(braceBody(code, /private suspend fun pushManufacturers\(repository: Repository, companyId: String\): Int \{/));
  const pull = squash(braceBody(code, /private suspend fun pullManufacturers\(repository: Repository, companyId: String\): Int \{/));
  need(/supplierNeedsPush\(mine, cloud, manufacturerLedger\.agreedFor\(supplier\.syncId\)\)/.test(push), "pushManufacturers does not ask supplierNeedsPush with the ledger's agreed copy");
  need(/pagedList<CloudManufacturer>\("manufacturers"\)/.test(push), "pushManufacturers does not read what the cloud holds");
  need(/catch \(e: Exception\) \{ local\.forEach \{ supplier -> val mine = supplier\.supplierContent\(\) val agreed = manufacturerLedger\.agreedFor\(supplier\.syncId\) if \(agreed == null \|\| mine != agreed\) manufacturerLedger\.failedToSend\(supplier\.syncId, mine\) \} throw e \}/.test(push), "a failed cloud read does not protect the suppliers that might be edits");
  need(/if \(isNotOursToSync\(e\)\) \{ owed\.forEach \{ manufacturerLedger\.refused\(it\.syncId\) \} \} else \{ owed\.forEach \{ manufacturerLedger\.failedToSend\(it\.syncId, it\.supplierContent\(\)\) \} \} throw e/.test(push), "a failed upsert is not remembered as refused-or-unsent and rethrown");
  need(/val sent = upsert\("manufacturers", owed\.map \{ it\.toCloud\(companyId\) \}\) owed\.forEach \{ manufacturerLedger\.agree\(it\.syncId, it\.supplierContent\(\)\) \}/.test(push), "a successful upsert is not recorded as agreed");
  need(!/upsert\("manufacturers", rows\)/.test(push), "pushManufacturers still sends every supplier on every pass");
  need(/\} else if \(supplierPullMayOverwrite\( mine, manufacturerLedger\.agreedFor\(row\.syncId\), manufacturerLedger\.unsentFor\(row\.syncId\) \) \) \{/.test(pull), "pullManufacturers does not gate the overwrite on supplierPullMayOverwrite with the ledger's copies");
  need(!/val merged = existing\.copy/.test(pull), "pullManufacturers still overwrites every supplier it holds");
  need(/if \(existing == null\) \{ repository\.saveManufacturer\( Manufacturer\(.*?\) \) manufacturerLedger\.agree\(row\.syncId, theirs\)/.test(pull), "a supplier new to the phone is not recorded as agreed");
  return problems;
}

function pinCatalogSync(code) {
  const problems = [];
  const need = (cond, what) => { if (!cond) problems.push(what); };
  const dto = squash(parenBody(code, /data class CloudMaterialItem\(/));
  need(/@SerialName\("manufacturer_sync_id"\) val manufacturerSyncId: String\? = null/.test(dto), "CloudMaterialItem has no manufacturer_sync_id (a nullable String, defaulted)");
  const push = squash(braceBody(code, /private suspend fun pushCatalog\(repository: Repository, companyId: String\): Int \{/));
  need(/catalogRowIsOwed\(item\.lastUpdated, held != null,/.test(push), "pushCatalog does not decide with catalogRowIsOwed");
  need(/\.copy\(manufacturerSyncId = it\.manufacturerId\?\.let \{ id -> supplierSyncById\[id\] \}\)/.test(push), "pushCatalog does not send the row's supplier as a sync id");
  need(/catalogPushBatches\(rows, clears\)/.test(push), "pushCatalog does not send rows in same-column batches");
  need(!/claimed == null \|\| \(claimed\.syncId == item\.syncId/.test(push), "pushCatalog still drops a row whose identity another sync id holds, supplier ignored");
  need(/catalogIdentity\(it\.name, it\.role, it\.fenceType, it\.colorOrFinish, it\.manufacturerSyncId\)/.test(push), "pushCatalog identities ignore the supplier");
  const pull = squash(braceBody(code, /private suspend fun pullCatalog\(repository: Repository, companyId: String, scope: MoneyScope\): Int \{/));
  need((pull.match(/manufacturerId = supplierFromCloud\(/g) || []).length >= 2, "pullCatalog does not set manufacturerId from the cloud on both the update and the insert path");
  need(/else if \(existing\.lastUpdated == row\.updatedAtMillis\(\)\)/.test(pull), "pullCatalog cannot fill in a supplier that had not arrived when the row did");
  need(/catalogIdentity\( row\.name, row\.role, row\.fenceType, row\.colorOrFinish, row\.manufacturerSyncId \)/.test(pull), "pullCatalog identities ignore the supplier");
  need(!/fun identity\(name: String/.test(pull), "pullCatalog still carries its own identity() that ignores the supplier");
  const pullAll = squash(braceBody(code, /suspend fun pullAll\(\s*repository: Repository,\s*companyId: String,\s*scope: MoneyScope,\s*employeePayScope: MoneyScope\s*\): Result<Int> =\s*withContext\(Dispatchers\.IO\) \{/));
  need(/val suppliersPull = async \{ runCatching \{ netGate\.withPermit \{ pullManufacturers\(repository, companyId\) \} \} \}/.test(pullAll), "pullAll does not hold the suppliers' pull in a name");
  need(/async \{ suppliersPull\.join\(\) runCatching \{ netGate\.withPermit \{ if \(scope == MoneyScope\.UNKNOWN\) 0 else pullCatalog\(repository, companyId, scope\) \} \} \}/.test(pullAll), "the catalog pull does not wait for the suppliers' pull BEFORE taking a permit");
  return problems;
}

// ============================================================ THE TESTS ==
test("the decision functions are in EntitySync.kt and the translator can read every one of them", () => {
  const fns = FN(CODE);
  for (const [k, f] of Object.entries(fns)) assert.equal(typeof f, "function", k);
  pinIdentity(CODE); pinFromCloud(CODE); pinBatches(CODE);
});

test("A. CATALOG: a copy of a row priced from another supplier is owed to the cloud; before, it was dropped without a word", () => {
  const fns = FN(CODE);
  const original = item({ syncId: "a", supplier: null });
  const copy = item({ syncId: "b", supplier: "SUP-HARTFORD" });
  const cloud = [cloudRow({ syncId: "a" })];
  assert.deepEqual(oldOwed([original, copy], cloud), [], "model of the old filter: neither is owed -- the copy reads as the original's cloud row under another id");
  assert.deepEqual(newOwed(fns, [original, copy], cloud), ["b"], "the supplier copy is owed, the untouched original is not");
  // control: the old rule's own purpose is kept -- a starter row every phone seeds for itself is still not duplicated upward
  const seeded = item({ syncId: "zzz", supplier: null });
  assert.deepEqual(newOwed(fns, [seeded], cloud), [], "a seeded duplicate (same product, no supplier, another id) is still not sent");
});

test("A. CATALOG: a row the cloud holds under its own id is gated by the clocks even after a rename; before, a rename skipped the gate", () => {
  const fns = FN(CODE);
  const renamedLocal = item({ syncId: "a", name: "Panel 6x6 (renamed)", lastUpdated: 50 });   // older than the cloud's copy
  const cloud = [cloudRow({ syncId: "a", updatedAt: 100 })];
  assert.deepEqual(oldOwed([renamedLocal], cloud), ["a"], "model of the old filter: the rename made the identity unclaimed, so a STALE copy was sent");
  assert.deepEqual(newOwed(fns, [renamedLocal], cloud), [], "the cloud's newer copy stands");
  assert.deepEqual(newOwed(fns, [item({ syncId: "a", name: "Panel 6x6 (renamed)", lastUpdated: 200 })], cloud), ["a"], "a newer local rename still goes up");
});

test("A. CATALOG: the supplier a row says about itself -- named, silent, or an explicit none -- and what the cloud's supplier means here", () => {
  const fns = FN(CODE);
  const say = fns.catalogSupplierSay;
  assert.equal(say("S1", null, false), "SET");
  assert.equal(say("S1", "S2", true), "SET", "the phone's own choice wins over a different cloud supplier");
  assert.equal(say(null, "S1", true), "CLEAR", "none, on purpose: the cloud names a supplier this phone holds, so the phone has had every chance to learn it");
  assert.equal(say(null, "S1", false), "NOTHING", "the cloud names a supplier this phone has not got: the phone does not know, and must not erase the office's link");
  assert.equal(say(null, null, false), "NOTHING");
  assert.equal(say(null, null, true), "NOTHING");
  // the pull side
  const ids = new Map([["SUP-FLORI", 7], ["SUP-HARTFORD", 9]]);
  assert.equal(supplierFromCloud("SUP-FLORI", ids, null), 7, "the cloud's supplier, resolved to this phone's id");
  assert.equal(supplierFromCloud("SUP-FLORI", ids, 9), 7, "and it replaces a different local one");
  assert.equal(supplierFromCloud(null, ids, 9), 9, "the cloud names none: the phone's own choice is kept (it cannot be told from one that never uploaded)");
  assert.equal(supplierFromCloud("SUP-GONE", ids, 9), 9, "the cloud names a supplier this phone has not got: kept, set on a later pass");
  assert.equal(supplierFromCloud("SUP-GONE", ids, null), null);
});

test("A. CATALOG: rows go up in batches that name the same columns, so a row with no supplier is never sent beside one that has one", () => {
  pinBatches(CODE);   // the port below is only as good as this pin: the Kotlin must still group by column set and still say null out loud
  const withSupplier = { sync_id: "1", name: "A", manufacturer_sync_id: "S1", height_ft: 6 };
  const without = { sync_id: "2", name: "B", manufacturer_sync_id: null, height_ft: null };
  const clearing = { sync_id: "3", name: "C", manufacturer_sync_id: null, height_ft: null };
  const batches = catalogPushBatches([withSupplier, without, clearing], new Set(["3"]));
  // Under the old single batch the columns were the union {sync_id, name, manufacturer_sync_id, height_ft} and the rows that
  // lacked a key were sent as NULL for it (explicitNulls = false drops the key; PostgREST fills the union).
  assert.equal(batches.length, 3, "three different things to say, three batches: " + JSON.stringify(batches));
  const byId = Object.fromEntries(batches.flat().map((o) => [o.sync_id, o]));
  assert.equal("manufacturer_sync_id" in byId["2"], false, "a row with nothing to say about its supplier leaves the key out, so the cloud's value stands");
  assert.equal("height_ft" in byId["2"], false, "and the same for a height it does not hold");
  assert.equal(byId["3"].manufacturer_sync_id, null, "a deliberate none is an explicit null");
  assert.equal(byId["1"].manufacturer_sync_id, "S1");
  for (const b of batches) assert.equal(new Set(b.map((o) => Object.keys(o).sort().join(","))).size, 1, "every batch names one column set");
});

test("B. SUPPLIERS: the decision table (who owes whom)", () => {
  const f = FN(CODE);
  const A = sup("X", "1"), B = sup("X", "2"), C = sup("X", "3");
  const needs = f.supplierNeedsPush, may = f.supplierPullMayOverwrite;
  assert.equal(needs(A, null, A), true, "the cloud has none: up");
  assert.equal(needs(A, A, A), false, "they agree: nothing to send");
  assert.equal(needs(A, A, null), false, "they match and nothing is known of the last agreement: still nothing to send");
  assert.equal(needs(B, A, A), true, "the phone changed it since they agreed: up");
  assert.equal(needs(A, B, A), false, "only the cloud changed it: stays, the pull takes the cloud's");
  assert.equal(needs(B, A, null), true, "KNOWN LIMIT: nothing is known about the last agreement (a process that has just started), so the phone's copy goes up -- as every pass did");
  assert.equal(needs(B, C, A), true, "both changed: the phone's copy wins, as ever");
  assert.equal(may(A, A, null), true, "unchanged here: the cloud's copy may come in");
  assert.equal(may(B, A, null), false, "changed since they agreed: owed to the cloud, never overwritten");
  assert.equal(may(B, A, B), false, "a push of exactly this copy failed: kept");
  assert.equal(may(B, null, B), false, "a push of exactly this copy failed and nothing is known of the agreement: kept");
  assert.equal(may(B, null, null), true, "KNOWN LIMIT: a supplier that differs with no record at all is overwritten, as every pull always did");
  assert.equal(may(B, B, A), true, "an unsent mark for a copy this is no longer does not hold the pull off");
});

test("B. SUPPLIERS: every scenario passes under the new rules", () => {
  const fns = FN(CODE);
  const results = Object.entries(scenarios(fns)).map(([name, run]) => [name, run()]);
  const bad = results.filter(([, v]) => v.length);
  assert.deepEqual(bad, [], "scenarios that went wrong: " + JSON.stringify(bad, null, 1));
  assert.equal(results.length, 9, "control: every scenario ran");
});

test("B. SUPPLIERS: under what every pass did BEFORE, three of those scenarios lose the supplier edit (so the scenarios have something to catch)", () => {
  const l = legacyLosses();
  assert.deepEqual(l, { pushFailsThenPull: true, editMidPass: true, websiteEditPutBack: true }, "the old rules no longer reproduce the loss: the model or the finding is wrong");
});

test("B. SUPPLIERS: KNOWN LIMIT -- after a restart the ledger knows nothing, so a supplier edited on the website while the app was closed is put back by the first sync", () => {
  const fns = FN(CODE);
  const w = world();
  w.phone.set("s1", sup("Supplier One", "555-0100"));            // the phone's stale copy, from the last session
  w.cloud.set("s1", sup("Supplier One", "555-0777"));            // edited in the office while the app was closed
  newPass(fns, w);                                               // a new process: the ledger is empty
  assert.equal(w.cloud.get("s1").phone, "555-0100", "this is the limit, pinned: the office's edit is overwritten. If this ever stops being true, the ledger has been replaced by a persisted mark -- update docs/SAVE_FAILURES.md");
});

test("the Kotlin: the catalog sync carries the supplier both ways and no longer collapses two suppliers' copies of a product", () => {
  assert.deepEqual(pinCatalogSync(CODE), []);
});

test("the Kotlin: pushManufacturers sends only what the phone owes and remembers a failure; pullManufacturers does not undo it", () => {
  assert.deepEqual(pinOrchestration(CODE), []);
});

test("the Kotlin: the ledger is in memory and says so, and the pull's own documentation no longer claims what it did not do", () => {
  assert.match(SRC, /internal class ManufacturerSyncLedger \{\s*private val agreed = java\.util\.concurrent\.ConcurrentHashMap<String, SupplierContent>\(\)\s*private val unsent = java\.util\.concurrent\.ConcurrentHashMap<String, SupplierContent>\(\)/);
  assert.match(SRC, /IN MEMORY ONLY, and that is its limit/);
  assert.equal(/Existing local rows are not overwritten: the phone that has/.test(SRC), false, "pullAll's doc still says existing local rows are never overwritten");
  assert.equal(/the phone is the source of truth and\s*\*\s*there is no merge to arbitrate/.test(SRC), false, "the conflict-rule block still says there is no merge to arbitrate for suppliers");
  assert.match(SRC, /docs\/SAVE_FAILURES\.md/);
});

// =============================================================== the teeth ==
test("TEETH: each decision, each pin and each scenario turns red on a mutant of the thing it guards", () => {
  const mutate = (from, to, why) => { assert.ok(CODE.includes(from), `the mutation target is not in EntitySync.kt (${why}): ${from}`); const next = CODE.replace(from, to); assert.notEqual(next, CODE); return next; };
  const redScenarios = (code) => { try { return Object.values(scenarios(FN(code))).flatMap((run) => run()); } catch (e) { return ["threw: " + e.message]; } };

  // 1. the pull may overwrite an edit whose push failed
  assert.ok(redScenarios(mutate("if (unsent != null && mine == unsent) return false", "if (false) return false", "unsent guard")).length > 0);
  // 2. the pull may overwrite an edit saved since the two last agreed
  assert.ok(redScenarios(mutate("if (agreed != null && mine != agreed) return false", "if (false) return false", "agreed guard")).length > 0);
  // 3. a supplier the office changed is put back by the phone: always push
  assert.ok(redScenarios(mutate("return agreed == null || mine != agreed", "return true", "push decision")).length > 0);
  // 4. a supplier that already matches the cloud is still sent (no scenario can see this one: it is the decision table's)
  const decisions = FN(mutate("if (mine == cloud) return false", "if (false) return false", "no-op push"));
  const A = sup("X", "1");
  assert.equal(decisions.supplierNeedsPush(A, A, null), true, "mutant: a supplier that matches the cloud is sent when nothing is known of the agreement -- the decision table above asserts false");
  // 5. the catalog filter: a supplier copy is dropped again
  const dropAgain = FN(mutate("if (cloudHoldsThisId) lastUpdated > cloudUpdatedAt else !identityHeldUnderAnotherId", "if (cloudHoldsThisId) lastUpdated > cloudUpdatedAt else false", "catalog owed"));
  assert.notDeepEqual(newOwed(dropAgain, [item({ syncId: "b", supplier: "SUP-HARTFORD" })], [cloudRow({ syncId: "a" })]), ["b"], "mutant: a brand-new supplier copy is never owed -- the supplier-copy test above would be red");
  // 6. the catalog's explicit none is never sent / always sent
  const noClear = FN(mutate("cloudSupplier != null && cloudSupplierIsHeldHere -> SupplierSay.CLEAR", "cloudSupplier != null -> SupplierSay.CLEAR", "clear needs the supplier held here"));
  assert.equal(noClear.catalogSupplierSay(null, "S1", false), "CLEAR", "mutant: erases the office's link with a guess -- the table above would catch it");
  // 7. the structural pins
  assert.ok(pinOrchestration(mutate("if (supplierNeedsPush(mine, cloud, manufacturerLedger.agreedFor(supplier.syncId))) owed += supplier", "owed += supplier", "push gate")).length > 0);
  assert.ok(pinOrchestration(mutate("manufacturerLedger.failedToSend(it.syncId, it.supplierContent())", "Unit", "failed push remembered")).length > 0);
  assert.ok(pinOrchestration(mutate("} else if (supplierPullMayOverwrite(", "} else if (true || supplierPullMayOverwrite(", "pull gate")).length > 0);
  assert.ok(pinCatalogSync(mutate('@SerialName("manufacturer_sync_id") val manufacturerSyncId: String? = null', '@SerialName("manufacturer") val manufacturerSyncId: String? = null', "DTO column")).length > 0);
  assert.ok(pinCatalogSync(mutate("manufacturerId = supplierFromCloud(row.manufacturerSyncId, supplierIdBySync, null),", "", "insert path")).length > 0);
  assert.ok(pinCatalogSync(mutate("suppliersPull.join()", "", "pull order")).length > 0);
  assert.ok(pinCatalogSync(mutate("catalogPushBatches(rows, clears).forEach", "listOf(rows.map { SyncJson.encodeToJsonElement(CloudMaterialItem.serializer(), it).jsonObject }).forEach", "same-column batches")).length > 0);
  // 8. the translator refuses what it does not know instead of guessing
  assert.throws(() => translate("internal fun f(a: Int): Boolean { val x = a.foo(); return x }", "f"), /translator met syntax it does not know/);
  // 9. the hand ports are pinned
  assert.throws(() => pinIdentity(mutate("supplierSyncId.orEmpty()", "\"\"", "identity supplier")), /catalogIdentity no longer reads/);
  assert.throws(() => pinFromCloud(mutate("cloudSupplier?.let { localIdBySyncId[it] } ?: current", "current", "from cloud")), /supplierFromCloud no longer reads/);
  assert.throws(() => pinBatches(mutate("if (row.syncId in clearSupplierFor) put(\"manufacturer_sync_id\", JsonNull)", "", "clear row")), /clear row no longer says null/);
});
