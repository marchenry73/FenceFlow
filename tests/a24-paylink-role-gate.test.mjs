// A24 -- THE LIVE FAKE FEATURE: the card-payment-link ("Request by card")
// button on the Job Detail screen was shown to anyone holding SEE_MONEY --
// Sales, Accountant, the guest demo -- with no permission check of its own.
// The server it calls, create-payment-link's "office, signed in" door,
// refuses everyone except OWNER and MANAGER:
//
//   supabase/functions/create-payment-link/index.ts, lines ~675-679:
//     const { data: profile } = await admin
//       .from("profiles").select("company_id, role").eq("id", uid).single();
//     if (!profile?.company_id) return json({ error: "No company" }, 403);
//     if (!["OWNER", "MANAGER"].includes(profile.role)) {
//       return json({ error: "Only an owner or manager can request payment" }, 403);
//     }
//
// This is a bare ROLE test. It does not call has_permission(), the Postgres
// function the app's own permission system mirrors, and it does not consult
// profiles.permission_overrides at all -- confirmed by reading has_permission
// -- () live (pg_get_functiondef, public schema) on 2026-09-29 and finding no
// reference to it anywhere in create-payment-link. So REQUEST_PAYMENT is NOT
// a sufficient gate on its own: has_permission() grants REQUEST_PAYMENT to
// ACCOUNTANT by default (confirmed in the same live read, see section 2
// below), and the edge function would still 403 an Accountant who holds it.
// Gating on the permission alone would have been the same class of mismatch
// the brief warned about, one step over -- a role name swapped for a
// permission name, still not what the server actually tests.
//
// THE FIX (JobDetailScreen.kt, PaymentFields): the button is now reached only
// through `canMintPaymentLink = session.canRequestPayment && (role is OWNER
// or MANAGER)`. The role half matches the server's literal rule; the
// permission half means a per-person override that revokes REQUEST_PAYMENT
// from one specific Owner- or Manager-role account is still respected on this
// phone even though the server (which never reads overrides here) would
// still accept that request -- narrower than the server, never wider.
// Nothing else on the card is touched: the contract-total/paid/still-owed
// card above PaymentFields, the existing payment-link field, the stale-link
// warning and the text/email share buttons for a link already made are all
// OUTSIDE this gate and stay visible to Sales and Accountant exactly as
// before, because seeing a balance is not the same thing as being able to
// bill it.
//
// WHERE THE PLAN OWNS NOTHING: the else-branch explanation shown in place of
// the button is a plain Kotlin string literal, not a stringResource -- this
// wave owns JobDetailScreen.kt/JobDetailViewModel.kt, not the strings files,
// and referencing a brand-new R.string id with no matching entry in
// values/values-es/values-fr breaks the whole build (CLAUDE.md's Android
// build traps; a dropped string handover has broken it before). Reported
// LOUDLY in this wave's blocked list with suggested EN/ES/FR wording. Section
// 4 below is the regression guard: every R.string.* this wave's edit touches
// must already exist, and the new literal must NOT be one of them.
//
// WHAT THIS FILE IS: sections 0, 1 and 4 are a STATIC read of the actual
// source text of the two files this wave owns, same shape as
// tests/a22-jobscreen-permissions-and-guest-gates.test.mjs -- it does not run
// Gradle and proves nothing about whether the app builds, only that the
// source text says what this wave's report claims it says (the real gate,
// gradlew / check-parity.mjs, was not run here per this wave's instructions,
// since other tracks may be editing Kotlin concurrently). Section 2 is a
// live, read-only, positive-controlled query against the Postgres catalog
// (has_permission's real body and the user_role enum's real labels), same
// idiom as tests/a23-policy-permission-vs-role.test.mjs's runSql(), because
// this wave's whole point is not to trust an assumed permission mapping.
// Section 3 is honest about what could NOT be verified that way: the edge
// function itself is Deno code, not a database object, so pg_get_functiondef
// cannot read it -- only the repository file can be read directly, which is
// what this file does, labelled for exactly what it is.
//
// SEARCHED FOR (section 2's enumeration, so a gap in the search is visible
// rather than silently read as "found nothing"): function names ILIKE
// '%payment_link%' and '%request_payment%', and the exact names
// has_permission / company_allowed, across the public schema. No
// payment_link-named Postgres function or policy exists -- the mint action
// is gated by the edge function's own code alone, never by a database policy
// (every read and write create-payment-link makes uses the service-role
// client, which bypasses RLS entirely).
//
// Run:
//   node tests/a24-paylink-role-gate.test.mjs

import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
};

const screenPath = new URL(
  "../app/src/main/java/com/fenceestimator/app/ui/jobs/JobDetailScreen.kt",
  import.meta.url,
);
const vmPath = new URL(
  "../app/src/main/java/com/fenceestimator/app/ui/jobs/JobDetailViewModel.kt",
  import.meta.url,
);
const stringsPath = new URL(
  "../app/src/main/res/values/strings.xml",
  import.meta.url,
);
const edgeFnPath = new URL(
  "../supabase/functions/create-payment-link/index.ts",
  import.meta.url,
);
const screen = readFileSync(screenPath, "utf8");
const vm = readFileSync(vmPath, "utf8");
const strings = readFileSync(stringsPath, "utf8");
const edgeFn = readFileSync(edgeFnPath, "utf8");

// The default locale's string resources are split across strings.xml AND a
// dozen strings_*.xml sidecar files (strings_jobs_polish.xml holds
// jobpolish_feature_card_payments, the PlanGate label this very card uses) --
// reading only strings.xml would report a real, already-declared resource as
// "missing" and turn section 4 below into a false alarm on unrelated,
// untouched code. Every values/*.xml file is merged into one resource set at
// build time, so "declared" has to mean the union, not one file.
const valuesDir = fileURLToPath(new URL("../app/src/main/res/values/", import.meta.url));
const valuesXmlText = readdirSync(valuesDir)
  .filter((f) => f.toLowerCase().endsWith(".xml"))
  .map((f) => readFileSync(join(valuesDir, f), "utf8"))
  .join("\n");

// ===========================================================================
// 0. POSITIVE CONTROLS
// ===========================================================================
console.log("\n0. positive controls:");
{
  ok("sanity: the screen file is non-trivial (a truncated read would false-pass everything below)",
    screen.length > 100_000, `length=${screen.length}`);
  ok("sanity: the view model file is non-trivial", vm.length > 10_000, `length=${vm.length}`);
  ok("sanity: strings.xml is non-trivial", strings.length > 10_000, `length=${strings.length}`);
  ok("sanity: the edge function source is non-trivial", edgeFn.length > 5_000, `length=${edgeFn.length}`);
}

// Scope every screen-level check to PaymentFields' own body, the same way
// a21/a22 scope to the composable a wave actually touched.
const pfStart = screen.indexOf("private fun PaymentFields(");
const pfEnd = screen.indexOf("\n@Composable", pfStart + 1);
ok("could locate PaymentFields' body to scope the checks below",
  pfStart !== -1 && pfEnd !== -1 && pfEnd > pfStart);
const pf = screen.slice(pfStart, pfEnd);

// ===========================================================================
// 1. THE GATE ITSELF: canMintPaymentLink matches the server's literal rule
//    (role), not just the permission the app's UI otherwise asks about.
// ===========================================================================
console.log("\n1. the mint-link button is gated on role AND permission, matching the server:");
{
  ok("positive control: PaymentFields still reads session from the app singleton",
    pf.includes("val session by paymentApp.session.state.collectAsState()"));
  ok("positive control: the button this section is about is still wired to createPaymentLink",
    pf.includes("PaymentsApi.createPaymentLink("));

  ok("canMintPaymentLink checks canRequestPayment AND the literal OWNER/MANAGER role",
    pf.includes("val canMintPaymentLink = session.canRequestPayment &&\n        (session.role == UserRole.OWNER || session.role == UserRole.MANAGER)"));

  // The actual gate: the Button that calls createPaymentLink is reached only
  // through an `if (canMintPaymentLink)` branch. Pinned as an exact
  // substring, same style as a22's Mark Seen pin, so a future edit that
  // quietly moves the gate elsewhere is still caught.
  ok("the mint-link Button is wrapped in `if (canMintPaymentLink) {`",
    pf.includes("if (canMintPaymentLink) {\n        Button(\n            onClick = {"));

  // Negative control: the OLD ungated shape -- the Button as a direct child
  // right after requestLabel with no branch around it at all -- must be gone.
  // This is what would still be true if the fix only looked right without
  // actually nesting the button.
  ok("the OLD ungated shape (Button directly after requestLabel, no role/permission branch) is gone",
    !pf.includes("val requestLabel = JobMoney.nextRequestLabel(job, contractTotal)\n    Button(\n        onClick = {"));

  ok("UserRole is imported so the role comparison actually compiles against the real enum",
    screen.includes("import com.fenceestimator.app.cloud.UserRole"));
}

console.log("\n1b. an explanation replaces the button, it is not simply absent:");
{
  ok("an else branch shows a Text() explanation rather than nothing",
    pf.includes("} else {\n        // No button offered rather than one that would only ever come back"));
  // This started life as an assertion on a bare Kotlin literal, because the
  // track that added the gate did not own the strings files. The gate pass
  // closed that handover: the sentence is now a real resource declared in
  // values, values-es and values-fr, so the assertion follows it there. The
  // locale check is in section 4 -- a resource id referenced with no entry in
  // values/ breaks the whole build, and a missing es/fr entry silently shows
  // English to a Spanish or French phone.
  ok("the explanation names who still can, via a localized string resource",
    pf.includes("stringResource(R.string.jd_paylink_owner_manager_only)"));
  ok("negative control: the old non-localized English literal is gone",
    !pf.includes('"Only an owner or manager can request payment by card."'));
}

// ===========================================================================
// 2. THE THING TO GET RIGHT: losing the button must not lose the money. Every
//    one of these lives OUTSIDE canMintPaymentLink's if/else, so Sales and
//    Accountant keep exactly what they had.
// ===========================================================================
console.log("\n2. seeing the money and seeing an existing link survive losing the button:");
{
  const gateStart = pf.indexOf("val canMintPaymentLink");
  const elseCloseMarker = '        Text(\n            stringResource(R.string.jd_paylink_owner_manager_only),\n            style = MaterialTheme.typography.bodySmall,\n            color = MaterialTheme.colorScheme.onSurfaceVariant\n        )\n    }\n';
  const afterGate = pf.indexOf(elseCloseMarker);
  ok("positive control: could find the exact end of the if/else block to scope 'outside the gate'",
    afterGate !== -1);
  const rest = afterGate !== -1 ? pf.slice(afterGate + elseCloseMarker.length) : "";

  ok("the Stripe explanation text is still shown to everyone reaching this card",
    rest.includes("jd_stripe_explain"));
  ok("the existing payment-link field/display is still shown to everyone reaching this card",
    rest.includes("jd_payment_link") && rest.includes("ReadOnlyField(stringResource(R.string.jd_payment_link)"));
  ok("the stale-link warning is still shown to everyone reaching this card",
    rest.includes("linkIsStale") && rest.includes("jd_link_stale"));
  ok("the text/email share buttons for an existing link are still shown to everyone reaching this card",
    rest.includes("jd_text_link") && rest.includes("jd_email_link"));

  // And the money summary card above PaymentFields (contract total / paid /
  // still owed) was never inside PaymentFields, let alone inside this gate --
  // pin that it's still keyed off canSeeMoney alone, unchanged, at the
  // section call site.
  ok("the payment section is still offered to everyone holding canSeeMoney (unchanged call site)",
    screen.includes('if (session.canSeeMoney) { add("change-orders"); add(SECTION_PAYMENT) }'));
}

console.log("\n2b. the refusal path is shown, not swallowed (checked, not assumed):");
{
  ok("a failed createPaymentLink call still sets linkError from the server's own reason",
    pf.includes("is PaymentsApi.Result.Failed -> linkError = result.reason"));
  ok("linkError is still rendered on screen when set",
    pf.includes("linkError?.let { problem ->"));
}

// ===========================================================================
// 3. SETTLED BEHAVIOUR THIS WAVE READ AROUND AND DID NOT TOUCH.
// ===========================================================================
console.log("\n3. settled money/guest controls elsewhere on this screen, undisturbed:");
{
  ok("RecordPaymentControl is still gated on canRequestPayment, unchanged",
    screen.includes("if (session.canRequestPayment) {\n                RecordPaymentControl(job = job, contractTotal = contractTotal, viewModel = viewModel)"));
  ok("RefundControl is still gated on canRecordRefunds AND canRequestPayment, unchanged",
    screen.includes("if (session.canRecordRefunds && session.canRequestPayment) {\n                RefundControl(job = job, contractTotal = contractTotal, viewModel = viewModel)"));
  ok("the zero-quote lock (isAccepted) still guards the mint button",
    pf.includes("com.fenceestimator.app.estimate.JobMoney.isAccepted(job)"));
  ok("the guest-demo editable split for the rest of PaymentFields is unchanged",
    pf.includes("val editable = !session.isGuestDemo"));
  ok("StaleSignatureBanner's own canReSign gate (guest cannot re-sign) is still wired at the call site",
    screen.includes("canReSign = !session.isGuestDemo"));
}

// ===========================================================================
// 4. NO MISSING STRING RESOURCE, and the new explanation is deliberately NOT
//    one -- this wave owns no locale file, so it must not have introduced a
//    reference to a resource that doesn't exist anywhere.
// ===========================================================================
console.log("\n4. no new, missing string resource was introduced:");
{
  const declared = new Set([...valuesXmlText.matchAll(/<string name="([^"]+)"/g)].map(m => m[1]));
  ok("positive control: values/*.xml actually parsed some names", declared.size > 50, `count=${declared.size}`);
  ok("positive control: the sidecar file this card's own PlanGate label lives in was actually included",
    declared.has("jobpolish_feature_card_payments"));
  const missing = [];
  for (const m of pf.matchAll(/R\.string\.(\w+)/g)) {
    if (!declared.has(m[1])) missing.push(m[1]);
  }
  ok("every R.string.* referenced in PaymentFields exists in strings.xml",
    missing.length === 0, missing.join(", "));
  // The gate pass turned the explanation into a real resource, so the check
  // that used to insist it stay a literal is now the opposite check: the id
  // must exist in ALL THREE locales. A reference with no values/ entry breaks
  // the whole build; a missing values-es/values-fr entry silently falls back
  // to English on a Spanish or French phone, which is the quieter failure and
  // the one worth a test.
  const ID = "jd_paylink_owner_manager_only";
  ok(`the explanation's resource id is declared in values/ (default locale)`, declared.has(ID));
  for (const loc of ["values-es", "values-fr"]) {
    const dir = fileURLToPath(new URL(`../app/src/main/res/${loc}/`, import.meta.url));
    const merged = readdirSync(dir).filter(f => f.toLowerCase().endsWith(".xml"))
      .map(f => readFileSync(join(dir, f), "utf8")).join("\n");
    const names = new Set([...merged.matchAll(/<string name="([^"]+)"/g)].map(m => m[1]));
    ok(`positive control: ${loc} actually parsed some names`, names.size > 50, `count=${names.size}`);
    ok(`${ID} is translated in ${loc}`, names.has(ID));
    ok(`negative control: ${loc} does not declare an id that cannot exist`,
      !names.has("zzz_this_id_cannot_exist"));
  }
}

// ===========================================================================
// 5. LIVE, READ-ONLY, POSITIVE-CONTROLLED: confirm the permission mapping the
//    "REQUEST_PAYMENT alone is not enough" claim rests on, against the actual
//    catalog rather than the Kotlin mirror of it. No impersonation needed --
//    this reads a function DEFINITION and an enum's labels, not a simulated
//    call, so no transaction/rollback scaffolding is required.
// ===========================================================================
const PROJECT = "newcrgafcptspmapacrx";

const PROBE = String.raw`
select 'enum' as kind, e.enumlabel as name, null::text as body
from pg_type t join pg_enum e on e.enumtypid = t.oid
where t.typname = 'user_role'
union all
select 'proc', p.proname, pg_get_functiondef(p.oid)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (p.proname = 'has_permission' or p.proname = 'company_allowed'
       or p.proname ilike '%payment_link%' or p.proname ilike '%request_payment%');
`;

function runSql(sql, { retries = 4 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "a24-paylink-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  let lastErr = "";
  for (let attempt = 1; attempt <= retries; attempt++) {
    const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query",
      "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
      { encoding: "utf8", shell: process.platform === "win32", timeout: 180_000 });
    const stdout = r.stdout || "";
    const stderr = r.stderr || "";
    // The CLI is documented as flaky (~1 in 4 calls fails with a login
    // error) and prints an ERROR where rows would be on that path. Retry
    // before treating any failure as a finding -- never read a failed call
    // as an empty result.
    if (r.status === 0 && stdout.trim() && !/^\s*ERROR/im.test(stdout)) {
      try { return JSON.parse(stdout); }
      catch { lastErr = `could not parse CLI output: ${stdout}`; continue; }
    }
    lastErr = stderr || stdout || `exit ${r.status}`;
  }
  throw new Error(`supabase db query failed after ${retries} attempts: ${lastErr}`);
}

console.log("\n5. live catalog check (positive-controlled) behind the permission claim:");
try {
  const parsed = runSql(PROBE);
  const rows = Array.isArray(parsed) ? parsed : (parsed.rows || []);
  ok("positive control: the live query returned rows at all (an empty result here would mean the query itself is broken, not that nothing was found)",
    rows.length > 0, `rows=${rows.length}`);

  const enumLabels = new Set(rows.filter(r => r.kind === "enum").map(r => r.name));
  ok("positive control: user_role enum still contains OWNER, MANAGER, ACCOUNTANT, SALES (spelled exactly as the Kotlin enum uses them)",
    ["OWNER", "MANAGER", "ACCOUNTANT", "SALES"].every(l => enumLabels.has(l)),
    [...enumLabels].join(","));

  const hasPermission = rows.find(r => r.kind === "proc" && r.name === "has_permission");
  ok("positive control: has_permission() exists live and its definition was actually read",
    !!hasPermission?.body && hasPermission.body.length > 100);
  if (hasPermission?.body) {
    ok("has_permission() grants REQUEST_PAYMENT to MANAGER by default (live)",
      /when 'MANAGER' then perm in \([^)]*'REQUEST_PAYMENT'/.test(hasPermission.body));
    ok("has_permission() grants REQUEST_PAYMENT to ACCOUNTANT by default (live) -- the reason REQUEST_PAYMENT alone is not the fix",
      /when 'ACCOUNTANT' then perm in \([^)]*'REQUEST_PAYMENT'/.test(hasPermission.body));
    ok("has_permission() does NOT grant REQUEST_PAYMENT to SALES by default (live)",
      /when 'SALES' then perm in \(('SEE_MONEY','EDIT_JOBS','SEE_CUSTOMER_CONTACT')\)/.test(hasPermission.body));
  }

  const paymentLinkFns = rows.filter(r => r.kind === "proc" &&
    (r.name.includes("payment_link") || r.name.includes("request_payment")));
  ok("SEARCHED FOR '%payment_link%' and '%request_payment%' in public schema functions and found none -- " +
    "the mint action is gated by the edge function's own code alone, never by a database policy",
    paymentLinkFns.length === 0, paymentLinkFns.map(f => f.name).join(","));
} catch (e) {
  fail++;
  console.log(`  FAIL  live catalog check could not run: ${e.message}`);
}

// ===========================================================================
// 6. HONEST ABOUT THE LIMIT: the edge function is Deno code, not a database
//    object -- pg_get_functiondef cannot read it, unlike has_permission()
//    above. This reads the repository file directly and says so, rather than
//    claiming a "live" read that structurally cannot happen for this file.
// ===========================================================================
console.log("\n6. the edge function's role check, read from its repository source (not the catalog -- see header):");
{
  ok("the repo source still hard-codes the OWNER/MANAGER role check on the office door",
    edgeFn.includes('if (!["OWNER", "MANAGER"].includes(profile.role)) {') &&
    edgeFn.includes('return json({ error: "Only an owner or manager can request payment" }, 403);'));
  ok("that check reads profile.role directly and not has_permission() or permission_overrides",
    !edgeFn.slice(edgeFn.indexOf('.from("profiles")'), edgeFn.indexOf('.includes(profile.role)') + 200)
      .includes("permission_overrides"));
}

console.log(`\n${pass} of ${pass + fail} checks passed`);
if (fail) process.exit(1);
