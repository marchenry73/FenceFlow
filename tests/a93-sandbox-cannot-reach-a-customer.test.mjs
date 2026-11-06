// A sandbox company must not be able to email a real person.
//
// supabase_r64_sandbox_company.sql closes two of the six transports by taking
// the capability away: a sandbox can never hold a row in mail_accounts or
// payment_connections, so it has no mailbox and no card credential, and no
// future code can forget that.
//
// Transactional mail through Resend and Brevo needs neither, so for those the
// check lives in the function -- the weaker kind of guard, because the
// THIRTEENTH function to call one of those hosts will forget it and nothing
// will fail. This test is what fails instead.
//
// It enumerates the functions that call those two hosts from the source, rather
// than from a list typed in here, so a new one shows up on its own. Each must
// either ask the guard or be named below as covered by the capability, with the
// reason. A new sender is a test failure until somebody decides which it is.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FUNCTIONS = join(ROOT, "supabase", "functions");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? ` -- ${extra}` : ""}`); }
};

/** Strip line and block comments, so a host named only in prose is not counted. */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const PROVIDER = /api\.(resend|brevo)\.com/;

// ---------------------------------------------------------------------------
// Who sends, read from the source rather than from a list.
// ---------------------------------------------------------------------------
function tsFilesOf(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

const fnDirs = readdirSync(FUNCTIONS)
  .filter((d) => d !== "_shared" && statSync(join(FUNCTIONS, d)).isDirectory());

const senders = [];
for (const d of fnDirs) {
  const files = tsFilesOf(join(FUNCTIONS, d));
  const body = files.map((f) => stripComments(readFileSync(f, "utf8"))).join("\n");
  if (PROVIDER.test(body)) senders.push({ name: d, body, files });
}

ok("the source names at least ten functions that call Resend or Brevo",
  senders.length >= 10, `found ${senders.length}`);

// ---------------------------------------------------------------------------
// Covered by capability instead of code, with the reason stated here so the
// exemption is readable and not just an absence.
// ---------------------------------------------------------------------------
const CAPABILITY_COVERED = {
  "mail-message":
    "acts on the company's own mailbox, which requires a mail_accounts row; a " +
    "sandbox can never hold one (r64), so it cannot reach this path at all",
  "resend-inbound":
    "an inbound webhook that resolves the account by its inbound_token from " +
    "mail_accounts; a sandbox holds no such row, so nothing resolves to one",
};

const ASKS_THE_GUARD = /\b(refuseIfSandbox|refuseIfSandboxId|isSandbox)\s*\(/;
// admin-mail-send filters the recipient list itself rather than calling the
// helper, because its recipients come from an rpc that does not carry the flag.
const FILTERS_INLINE = /is_sandbox/;

for (const s of senders) {
  const exempt = CAPABILITY_COVERED[s.name];
  const guarded = ASKS_THE_GUARD.test(s.body) || FILTERS_INLINE.test(s.body);
  ok(`${s.name}: asks the sandbox guard, or is named as covered by capability`,
    guarded || Boolean(exempt),
    exempt ? "" : "it sends through Resend/Brevo and never mentions is_sandbox");
}

// Every exemption must still be a real function, or the list is stale and is
// quietly excusing nothing.
for (const [name, reason] of Object.entries(CAPABILITY_COVERED)) {
  ok(`the exemption for ${name} is for a function that exists and still sends`,
    senders.some((s) => s.name === name), "");
  ok(`the exemption for ${name} states a reason`, reason.length > 40);
}

// ---------------------------------------------------------------------------
// A guard that reads a company row needs is_sandbox IN that select, or it
// reads undefined, which is not true, and the mail goes out. The helper throws
// on a missing column at runtime; this catches it before deploying.
// ---------------------------------------------------------------------------
for (const s of senders) {
  if (CAPABILITY_COVERED[s.name]) continue;
  if (!ASKS_THE_GUARD.test(s.body) && !FILTERS_INLINE.test(s.body)) continue;
  const selectsCompanies = /from\(\s*["']companies["']\s*\)/.test(s.body);
  if (!selectsCompanies) continue; // uses the id form, which reads the flag itself
  ok(`${s.name}: is_sandbox is among the columns it selects from companies`,
    /is_sandbox/.test(s.body),
    "it loads a company row but never selects is_sandbox");
}

// ---------------------------------------------------------------------------
// The helper itself: every symbol a function imports must actually be exported.
// A wrong name is a runtime failure on a mail path, and nothing here type-checks.
// ---------------------------------------------------------------------------
const helperPath = join(FUNCTIONS, "_shared", "sandbox.ts");
ok("the shared guard exists", existsSync(helperPath));
const helper = readFileSync(helperPath, "utf8");
const exported = new Set(
  [...helper.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|type)\s+(\w+)/gm)]
    .map((m) => m[1]),
);
ok("it exports the four names the functions use",
  ["refuseIfSandbox", "refuseIfSandboxId", "isSandbox", "sandboxMessage"].every((n) => exported.has(n)),
  [...exported].join(","));

let importedSymbols = 0;
for (const s of senders) {
  for (const file of s.files) {
    const raw = readFileSync(file, "utf8");
    const m = raw.match(/import\s*\{([^}]*)\}\s*from\s*["']\.\.\/_shared\/sandbox\.ts["']/);
    if (!m) continue;
    const names = m[1].split(",").map((x) => x.trim()).filter(Boolean);
    for (const n of names) {
      importedSymbols++;
      ok(`${s.name}: imports ${n}, which the guard exports`, exported.has(n),
        `sandbox.ts exports ${[...exported].join(", ")}`);
    }
    // And every imported name is actually used -- an unused import here means
    // the guard was added to the imports and never called.
    const bodyAfterImports = stripComments(raw);
    for (const n of names) {
      const uses = (bodyAfterImports.match(new RegExp(`\\b${n}\\b`, "g")) || []).length;
      ok(`${s.name}: ${n} is used, not just imported`, uses >= 2, `${uses} mention(s)`);
    }
  }
}
ok("at least nine guard symbols were imported across the senders",
  importedSymbols >= 9, `${importedSymbols}`);

// ---------------------------------------------------------------------------
// THE CANARY. Plant a thirteenth sender that asks nothing, and the enumeration
// above must notice it. Without this, an empty `senders` list or a regex that
// matches nothing would read as every function being guarded.
// ---------------------------------------------------------------------------
{
  const planted = {
    name: "planted-thirteenth-sender",
    body: 'const url = "https://api.resend.com/emails"; await fetch(url, { body });',
    files: [],
  };
  const wouldBeFlagged =
    PROVIDER.test(planted.body) &&
    !ASKS_THE_GUARD.test(planted.body) &&
    !FILTERS_INLINE.test(planted.body) &&
    !CAPABILITY_COVERED[planted.name];
  ok("THE CANARY FIRES: a new sender that asks nothing would be caught",
    wouldBeFlagged,
    "the check cannot tell an unguarded sender from a guarded one, so the passes above prove nothing");

  const plantedGuarded = { ...planted, body: planted.body + " isSandbox(company, 'x');" };
  ok("CANARY: and the same sender WITH the guard is not flagged",
    ASKS_THE_GUARD.test(plantedGuarded.body),
    "the check flags everything, so it is not distinguishing anything");
}

console.log(`\npass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
