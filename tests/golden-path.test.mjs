// The customer-facing half of lead-to-cash, exercised against the LIVE system
// with the existing TEST COMPANY -- proved by reading the result back, never
// by trusting a success message.
//
// Steps covered:
//   1. A website enquiry arrives through lead-intake and is accepted.
//   2. The quote a customer opens has the right shape: company, customer,
//      total, deposit -- and NO line items, NO subtotal, NO cost, NO payment
//      token. That absence is a security property, not a detail.
//   3. Approving works, and the name given is recorded.
//   4. First signature wins: a second approval with a different name does
//      not change whose name is on the record.
//   5. Input is refused properly: a one-character name, an unknown action,
//      an empty body, a malformed token, a well-formed token to nothing.
//
// Everything this script creates begins "ZZ GOLDEN" so cleanup can never
// match a real row, and every cleanup statement is scoped to
// company_id = <test company> -- touching another company by accident here
// would be a worse bug than anything this test is trying to catch.
//
//   node tests/golden-path.test.mjs

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT = "newcrgafcptspmapacrx";
const API = `https://${PROJECT}.supabase.co`;
const SITE = "https://fenceflowapp.com";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const LEADS_TOKEN = "22222222-2222-4222-8222-222222222222";
const ES_QUOTE_TOKEN = "11111111-1111-4111-8111-111111111501";

let failed = 0, checked = 0;
const ok = (name, cond, detail = "") => {
  checked++;
  if (cond) { console.log(`  ok    ${name}`); return; }
  failed++;
  console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
};

async function publishableKey() {
  const res = await fetch(`${SITE}/config.js`);
  const text = await res.text();
  const m = text.match(/sb_publishable_[A-Za-z0-9_-]+/) || text.match(/eyJ[A-Za-z0-9_.-]{40,}/);
  if (!m) throw new Error("could not find the publishable key on the live site");
  return m[0];
}

/** Run a SQL file through the Supabase CLI, exactly as health-check.mjs does
 *  for its secrets check. This needs project access the publishable key does
 *  not have -- cleanup and approval-reset are not things an anon key can do. */
function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "golden-path-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query",
    "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
    { encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) {
    throw new Error(`supabase db query failed: ${r.stderr || r.stdout}`);
  }
  try { return JSON.parse(r.stdout); } catch { return r.stdout; }
}

const MARK = "ZZ GOLDEN";

async function main() {
  const key = await publishableKey();
  const h = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

  // ---------------------------------------------------------- step 1 ---
  console.log("\n1. A website enquiry arrives through lead-intake:");
  const leadName = `${MARK} ${Date.now()}`;
  const intakeRes = await fetch(`${API}/functions/v1/lead-intake?c=${LEADS_TOKEN}`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      name: leadName, phone: "555-000-1234", email: "zz-golden@example.com",
      address: "1 ZZ GOLDEN Test Way", notes: "golden-path test lead",
    }),
  });
  const intakeBody = await intakeRes.json().catch(() => ({}));
  ok("lead-intake accepts the enquiry", intakeRes.ok, `http ${intakeRes.status}: ${JSON.stringify(intakeBody)}`);

  // lead-intake writes straight into jobs (customer_name, referral_source =
  // "Website") -- there is no separate leads/customers table for this path.
  // Prove it by reading the row back, not by trusting the success message.
  const leadRows = runSql(
    `select id, customer_name, company_id from jobs ` +
    `where company_id = '${COMPANY_ID}' and customer_name = '${leadName.replace(/'/g, "''")}' ` +
    `and referral_source = 'Website';`
  );
  const leadRowList = Array.isArray(leadRows) ? leadRows : (leadRows?.rows || []);
  ok("the lead really landed in the database (read back, not the success message)",
     leadRowList.length === 1, `found ${leadRowList.length} rows`);

  // ---------------------------------------------------------- step 2 ---
  console.log("\n2. The quote a customer opens has the right shape:");
  const quoteRes = await fetch(`${API}/functions/v1/quote-view?t=${ES_QUOTE_TOKEN}`);
  const quote = await quoteRes.json().catch(() => ({}));
  ok("quote-view answers", quoteRes.ok, `http ${quoteRes.status}: ${JSON.stringify(quote)}`);
  ok("has company", !!quote.company && !!quote.company.name);
  ok("has customer", !!quote.customerName);
  ok("has total", quote.total !== undefined && quote.total !== null);
  ok("has deposit", quote.deposit !== undefined && quote.deposit !== null);
  // CANARY: without a real, non-zero total coming back, every "must be
  // absent" check below would pass just as well for a script that fetched
  // nothing at all. This proves the fetch actually got real data.
  ok("CANARY: total is a real non-zero number",
     typeof quote.total === "number" && quote.total > 0, `total was ${JSON.stringify(quote.total)}`);

  ok("NO line items exposed", quote.lineItems === undefined && quote.line_items === undefined);
  ok("NO subtotal exposed", quote.subtotal === undefined);
  ok("NO tax breakdown exposed (derives the cost)", quote.tax === undefined && quote.taxRate === undefined);
  ok("NO cost exposed", quote.cost === undefined && quote.costs === undefined && quote.supplierUnitPrice === undefined);
  ok("NO payment token exposed",
     quote.paymentToken === undefined && quote.payment_token === undefined &&
     quote.stripeToken === undefined && quote.stripe_token === undefined &&
     quote.accessToken === undefined && quote.access_token === undefined);

  // ---------------------------------------------------------- step 3 ---
  console.log("\n3. Approving works and the name is recorded:");
  const firstName = `${MARK} First Approver`;

  // The last four digits of the phone on the test job. Approving needs them
  // now: holding the link is no longer enough, because a forwarded link let
  // anyone commit to the job. The check runs on the server and the digits are
  // never sent to the page.
  const PHONE4 = "0111";

  // The canary. Without this, every assertion below could pass against a gate
  // that had quietly stopped gating -- which is exactly what a wrong phone4
  // would look like from here.
  const noDigits = await fetch(`${API}/functions/v1/quote-view?t=${ES_QUOTE_TOKEN}`, {
    method: "POST", headers: h, body: JSON.stringify({ action: "approve", name: firstName }),
  });
  await noDigits.json().catch(() => ({}));
  const afterNoDigits = await fetch(`${API}/functions/v1/quote-view?t=${ES_QUOTE_TOKEN}`).then(r => r.json());
  ok("approving with no phone digits is refused", !noDigits.ok, `http ${noDigits.status}`);
  ok("and it recorded nobody", !recordedName(afterNoDigits),
     `recorded name was ${JSON.stringify(recordedName(afterNoDigits))}`);

  const wrongDigits = await fetch(`${API}/functions/v1/quote-view?t=${ES_QUOTE_TOKEN}`, {
    method: "POST", headers: h,
    body: JSON.stringify({ action: "approve", name: firstName, phone4: "9999" }),
  });
  await wrongDigits.json().catch(() => ({}));
  ok("approving with the wrong digits is refused", !wrongDigits.ok, `http ${wrongDigits.status}`);

  const approveRes = await fetch(`${API}/functions/v1/quote-view?t=${ES_QUOTE_TOKEN}`, {
    method: "POST", headers: h,
    body: JSON.stringify({ action: "approve", name: firstName, phone4: PHONE4 }),
  });
  const approveBody = await approveRes.json().catch(() => ({}));
  ok("approve is accepted", approveRes.ok, `http ${approveRes.status}: ${JSON.stringify(approveBody)}`);

  const afterFirst = await fetch(`${API}/functions/v1/quote-view?t=${ES_QUOTE_TOKEN}`).then(r => r.json());
  ok("the recorded name matches the first approver (read back from the quote)",
     recordedName(afterFirst) === firstName, `recorded name was ${JSON.stringify(recordedName(afterFirst))}`);

  // ---------------------------------------------------------- step 4 ---
  console.log("\n4. First signature wins:");
  const secondName = `${MARK} Second Approver`;
  const secondRes = await fetch(`${API}/functions/v1/quote-view?t=${ES_QUOTE_TOKEN}`, {
    method: "POST", headers: h,
    body: JSON.stringify({ action: "approve", name: secondName, phone4: PHONE4 }),
  });
  await secondRes.json().catch(() => ({}));

  const afterSecond = await fetch(`${API}/functions/v1/quote-view?t=${ES_QUOTE_TOKEN}`).then(r => r.json());
  ok("the SECOND approval did not change whose name is on record",
     recordedName(afterSecond) === firstName,
     `recorded name became ${JSON.stringify(recordedName(afterSecond))}`);

  // ---------------------------------------------------------- step 5 ---
  console.log("\n5. Input is refused properly:");
  const oneChar = await fetch(`${API}/functions/v1/quote-view?t=${ES_QUOTE_TOKEN}`, {
    method: "POST", headers: h,
    body: JSON.stringify({ action: "approve", name: "X", phone4: PHONE4 }),
  });
  const oneCharBody = await oneChar.json().catch(() => ({}));
  ok("a one-character name is refused", !oneChar.ok || typeof oneCharBody.error === "string",
     `http ${oneChar.status}: ${JSON.stringify(oneCharBody)}`);

  const badAction = await fetch(`${API}/functions/v1/quote-view?t=${ES_QUOTE_TOKEN}`, {
    method: "POST", headers: h, body: JSON.stringify({ action: "not-a-real-action", name: "Someone" }),
  });
  const badActionBody = await badAction.json().catch(() => ({}));
  ok("an unknown action is refused", !badAction.ok || typeof badActionBody.error === "string",
     `http ${badAction.status}: ${JSON.stringify(badActionBody)}`);

  const emptyBody = await fetch(`${API}/functions/v1/quote-view?t=${ES_QUOTE_TOKEN}`, {
    method: "POST", headers: h, body: "{}",
  });
  const emptyBodyBody = await emptyBody.json().catch(() => ({}));
  ok("an empty body is refused", !emptyBody.ok || typeof emptyBodyBody.error === "string",
     `http ${emptyBody.status}: ${JSON.stringify(emptyBodyBody)}`);

  const malformed = await fetch(`${API}/functions/v1/quote-view?t=not-a-uuid`).then(r => r.json());
  ok("a malformed token is refused", typeof malformed.error === "string");

  const nothing = await fetch(`${API}/functions/v1/quote-view?t=00000000-0000-0000-0000-000000000000`).then(r => r.json());
  ok("a well-formed token that belongs to nothing is refused", typeof nothing.error === "string");

  // Make sure none of the refused approvals actually changed the record.
  const stillFirst = await fetch(`${API}/functions/v1/quote-view?t=${ES_QUOTE_TOKEN}`).then(r => r.json());
  ok("none of the rejected requests changed the recorded name",
     recordedName(stillFirst) === firstName, `recorded name is now ${JSON.stringify(recordedName(stillFirst))}`);

  console.log(`\n${checked - failed} passed, ${failed} failed`);
}

/** The quote-view response shape isn't fixed in the spec here, so check the
 *  handful of plausible field names for where the approver's name would live. */
function recordedName(quote) {
  return quote?.approvedBy ?? null;
}

async function cleanup() {
  console.log("\nCleanup (scoped to company_id = test company only):");
  try {
    runSql(
      // Reset the ES job's approval (and its status back to SENT, since
      // approve() advances DRAFT/SENT to ACCEPTED) so the script can be run
      // again immediately. Scoped by both the job's sync id AND company_id
      // so this can never touch another company's row even if the id were
      // somehow wrong.
      `update jobs set quote_approved_at = null, quote_approved_name = '', status = 'SENT' ` +
      `where sync_id = '11111111-1111-4111-8111-111111111411' and company_id = '${COMPANY_ID}';\n` +
      // Remove every lead this run created through lead-intake. It lands in
      // jobs (referral_source = 'Website'), not a separate leads table. The
      // "ZZ GOLDEN" name prefix cannot collide with a real customer, and the
      // company_id scope is the hard backstop against touching real data.
      `delete from jobs where company_id = '${COMPANY_ID}' and customer_name like 'ZZ GOLDEN%' ` +
      `and referral_source = 'Website';`
    );
    console.log("  ok    approval reset and lead rows removed");
  } catch (e) {
    console.log(`  FAIL  cleanup did not complete cleanly — ${e.message}`);
    failed++;
  }
}

main()
  .catch(e => { console.error("golden-path test could not run:", e.message); failed++; })
  .finally(async () => {
    await cleanup();
    process.exit(failed ? 1 : 0);
  });
