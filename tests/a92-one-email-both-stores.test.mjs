// a92 -- the office can change the company's email everywhere except on the
//        document the customer keeps.
//
// WHY THIS EXISTS. The overnight log flagged that a personal gmail address was
// printing where marc@fenceflowapp.com belongs, and said the contract header
// read `company_settings -> email`. Chasing it down, the document is not the
// contract email at all -- quote-approval-email reads `companies.email`, and
// quote-view reads nothing from the blob but payment methods and brand colour.
// The document is the PHONE'S PDF: PdfExporter draws business.email in its
// header, and BusinessProfile.email is filled by SettingsSync from the blob's
// `email` key.
//
// And the office cannot write that key. Three of the four customer-facing
// fields go to BOTH stores -- the SET map sends business_name, phone and
// license_number into the blob, and a second UPDATE sends name, phone and
// license_no to the companies row. Email is the only one of the four that goes
// to `companies` alone. So an owner who corrects the address in Settings sees
// it change on the quote page, in crew invitations and on payment links, and
// the PDF in the customer's hand keeps the old one, with nothing on screen
// saying so. Same shape as the "use this phone only" switch that had no UI.
//
// This file pins the fix: ONE box, BOTH stores, under the same rules the
// companies.email write already follows -- blank means "I did not set this",
// a malformed address is refused, and only an OWNER may write it (RLS makes
// the companies write OWNER-only, and the blob write is not RLS-filtered the
// same way, so the role check has to be explicit or a manager could change
// what every customer PDF prints).
//
// Same grab()/new Function() idiom as tests/a7-dashboard-money-regressions
// .test.mjs: this runs the REAL saveSettings() lifted out of dashboard.html,
// so it cannot drift from what ships.
//
//   node tests/a92-one-email-both-stores.test.mjs      (no network, no writes)
import { readFileSync } from "node:fs";

const src = readFileSync("website/dashboard.html", "utf8");
const settingsSyncKt = readFileSync(
  "app/src/main/java/com/fenceestimator/app/cloud/SettingsSync.kt", "utf8");
const pdfExporterKt = readFileSync(
  "app/src/main/java/com/fenceestimator/app/estimate/PdfExporter.kt", "utf8");

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? " — " + detail : "")); }
};

/** Comment-stripped source, so a value quoted in prose never reads as code. */
function stripCode(s) {
  let out = "", i = 0;
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      const q = c; let j = i + 1;
      while (j < s.length && s[j] !== q) { if (s[j] === "\\") j++; j++; }
      out += s.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === "/" && d === "/") { while (i < s.length && s[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && d === "*") { const e = s.indexOf("*/", i + 2); i = e < 0 ? s.length : e + 2; out += " "; continue; }
    out += c; i++;
  }
  return out;
}

const grab = (name, from = src) => {
  let start = from.indexOf("function " + name + "(");
  if (start < 0) throw new Error("not found: " + name);
  if (from.slice(start - 6, start) === "async ") start -= 6;
  let i = from.indexOf("{", from.indexOf(")", start)), depth = 0;
  for (let j = i; j < from.length; j++) {
    if (from[j] === "{") depth++;
    else if (from[j] === "}") { depth--; if (!depth) return from.slice(start, j + 1); }
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
          // LAST write wins in the recorded state, but the email write and the
          // name/phone/licence write are separate UPDATEs to the same table,
          // so keep every one of them rather than only the final patch.
          if (table === "companies") {
            state.companiesUpdate = { patch, col, val };
            (state.companiesUpdates ??= []).push(patch);
          }
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

/** Runs the real saveSettings() over stand-ins. `role` decides the owner gate. */
async function run(fnSrc, { emailValue, role = "OWNER" } = {}) {
  const els = { s_email: fakeEl({ value: emailValue }) };
  const $ = (id) => els[id] || (els[id] = fakeEl());
  const db = makeDb();
  const profile = { role, company_id: "co-1" };
  const msgCalls = [];
  const msg = (el, text, kind) => { msgCalls.push({ el, text, kind }); };
  const tr = (key, ...args) => key + (args.length ? "|" + args.join("|") : "");
  const saveSettings = new Function(
    "canEdit", "$", "db", "profile", "msg", "tr", "buildTemplates", "renderSetup",
    grabConst("SET") + "\n" + grabConst("SET_NUM") + "\n" + fnSrc + "\nreturn saveSettings;"
  )(() => true, $, db, profile, msg, tr, [], () => {});
  await saveSettings();
  const blob = db.state.rpcCalls.find((c) => c.name === "save_company_settings");
  return { db, msgCalls, blob: blob ? blob.args.new_settings : null };
}

const REAL = grab("saveSettings");
const GOOD = "marc@fenceflowapp.com";

console.log("\n0. The real saveSettings was extracted and runs:");
{
  const { db, blob } = await run(REAL, { emailValue: GOOD });
  ok("it writes the blob through save_company_settings", blob !== null);
  ok("and the blob carries the three fields that always went there",
    blob !== null && "business_name" in blob && "phone" in blob && "license_number" in blob,
    blob ? Object.keys(blob).join(",") : "(no blob write)");
  ok("and it writes companies.email", db.state.companiesUpdate !== null
    && db.state.companiesUpdates.some((p) => p.email === GOOD),
    JSON.stringify(db.state.companiesUpdates ?? null));
}

console.log("\n1. THE FIX: one box, both stores:");
// This is the assertion the whole file exists for. Before the fix the blob
// payload had no `email` key at all, so the phone's PDF header kept whatever
// address it last synced while every other surface showed the new one.
{
  const { blob } = await run(REAL, { emailValue: GOOD });
  ok("a valid address reaches the blob the phone's PDF prints from",
    blob !== null && blob.email === GOOD,
    "blob.email = " + JSON.stringify(blob ? blob.email : null)
      + " -- the office cannot change what PdfExporter draws in its header");
}

console.log("\n2. Blank means \"I did not set this\", in BOTH stores:");
// companies.email is NOT NULL and would take '' happily; the blob would too.
// A load that failed leaves every box empty, and a save on top of that must
// not wipe the address the customer's PDF, the quote page and crew invites
// all read.
for (const blankish of ["", "   ", "\t"]) {
  const { db, blob } = await run(REAL, { emailValue: blankish });
  ok(`${JSON.stringify(blankish)}: companies.email is not written`,
    !(db.state.companiesUpdates ?? []).some((p) => "email" in p));
  ok(`${JSON.stringify(blankish)}: the blob carries no email key either`,
    blob !== null && !("email" in blob),
    "blob.email = " + JSON.stringify(blob ? blob.email : null));
}

console.log("\n3. A malformed address is refused by both stores:");
for (const bad of ["owner@fenceflow", "no-at-sign.com", "two @@ signs.com", "a@b"]) {
  const { db, blob } = await run(REAL, { emailValue: bad });
  ok(`${JSON.stringify(bad)}: companies.email is not written`,
    !(db.state.companiesUpdates ?? []).some((p) => "email" in p));
  ok(`${JSON.stringify(bad)}: the blob carries no email key either`,
    blob !== null && !("email" in blob),
    "blob.email = " + JSON.stringify(blob ? blob.email : null));
}

console.log("\n4. Only an OWNER may change what a customer's PDF prints:");
// The companies write is OWNER-only because companies_update's USING clause
// filters it -- silently, to zero rows. save_company_settings is NOT filtered
// the same way, so without an explicit role check a MANAGER's save would
// change the address on every PDF while leaving the companies row alone:
// the two stores would then disagree in the opposite direction.
for (const role of ["MANAGER", "CREW"]) {
  const { db, blob } = await run(REAL, { emailValue: GOOD, role });
  ok(`${role}: companies.email is not written`,
    !(db.state.companiesUpdates ?? []).some((p) => "email" in p));
  ok(`${role}: the blob carries no email key either`,
    blob !== null && !("email" in blob),
    "blob.email = " + JSON.stringify(blob ? blob.email : null));
}
{
  const { blob } = await run(REAL, { emailValue: GOOD, role: "OWNER" });
  ok("CONTROL -- an OWNER with the same address DOES write it",
    blob !== null && blob.email === GOOD,
    "the role checks above would pass even with the write removed entirely");
}

console.log("\n5. THE CANARY: revert the fix and the check above must go red:");
// Reconstructs the pre-fix saveSettings -- the blob payload built from SET
// alone, with no email added -- and proves assertion 1 catches it. Counted
// relative to what the real source does, so this still tests the DETECTOR if
// the fix is ever genuinely lost.
{
  const marker = "if (isValidCompanyEmail(blobEmail)) payload.email = blobEmail;";
  ok("the fix is present in the shipped source as one line",
    REAL.includes(marker),
    "the marker moved -- update this canary to match, do not delete it");
  const reverted = REAL.replace(marker, "");
  ok("the reverted copy really differs", reverted !== REAL);
  const { blob } = await run(reverted, { emailValue: GOOD });
  ok("THE CANARY FIRES: without the fix the blob has no email key",
    blob !== null && !("email" in blob),
    "the planted revert still wrote the blob, so assertion 1 proves nothing");
}

console.log("\n6. The phone really does print the blob's email, not the companies row:");
// If this ever stops being true the fix above is pointless -- and worse,
// misleading, because it would be writing a key nothing reads. Read live out
// of the Kotlin rather than asserted in prose.
{
  const sync = stripCode(settingsSyncKt);
  const pdf = stripCode(pdfExporterKt);
  // The parameter list carries @SerialName("...") annotations, so a [^)]*
  // window cannot cross it -- take the declaration's own brace-free span by
  // slicing to the next `)` that is followed by a newline at column 0.
  const clsAt = sync.indexOf("data class CloudSettings(");
  const clsEnd = clsAt < 0 ? -1 : sync.indexOf("\n)", clsAt);
  const cloudSettingsDecl = clsAt < 0 || clsEnd < 0 ? "" : sync.slice(clsAt, clsEnd);
  ok("the CloudSettings declaration was located", cloudSettingsDecl.length > 200,
    `${cloudSettingsDecl.length} chars -- the class moved or was renamed`);
  ok("CloudSettings has a plain `email` field, so the blob key is `email`",
    /^\s*val email: String\? = null,?$/m.test(cloudSettingsDecl),
    "the blob's email field is gone, renamed, or carries a @SerialName override");
  // NEGATIVE CONTROL: the same window must NOT match a field that is spelled
  // with an explicit @SerialName, or the check above would pass for any name.
  ok("CONTROL -- the test can tell a plain field from an annotated one",
    /@SerialName\("license_number"\) val licenseNumber/.test(cloudSettingsDecl)
      && !/^\s*val licenseNumber: String\? = null,?$/m.test(cloudSettingsDecl),
    "the plain-field pattern also matches an annotated field, so it proves nothing");
  ok("and it is merged into the local profile",
    /email = cloud\.email \?: email/.test(sync),
    "SettingsSync no longer pulls the blob's email into BusinessProfile");
  ok("PdfExporter draws business.email in the header",
    /canvas\.drawText\(business\.email,/.test(pdf),
    "the PDF header no longer prints business.email");
  ok("and it draws the licence from the same profile",
    /business\.licenseNumber/.test(pdf));
  // NEGATIVE CONTROL: the PDF must not be reading a companies-row column.
  ok("CONTROL -- the PDF does not read a `companies` column directly",
    !/companies\./.test(pdf),
    "the PDF reads the companies row too, so this file's premise is wrong");
}

console.log(`\n${pass} of ${pass + fail} checks passed`);
if (fail) process.exit(1);
