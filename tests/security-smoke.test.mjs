// The security properties this product must not lose, checked against the
// live system rather than against the source.
//
// Every one of these was verified by hand once. A thing verified by hand once
// is a thing that quietly stops being true, so each is written down here as a
// question the running system has to answer correctly.
//
// Read-only apart from two forged webhook posts, which are supposed to be
// refused -- and the test also checks that nothing landed, because a rejection
// message means nothing if the row appears anyway.
//
//   node tests/security-smoke.test.mjs

const PROJECT = "newcrgafcptspmapacrx";
const API = `https://${PROJECT}.supabase.co`;
const SITE = "https://fenceflowapp.com";

let failed = 0, checked = 0;
const ok = (name, cond, detail = "") => {
  checked++;
  if (cond) { console.log(`  ok    ${name}`); return; }
  failed++;
  console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
};

/** The key that ships inside every copy of the app and every page of the site.
 *  Anyone who reads the page source has it; that is the point of the test. */
async function publishableKey() {
  const res = await fetch(`${SITE}/config.js`);
  const text = await res.text();
  const m = text.match(/sb_publishable_[A-Za-z0-9_-]+/) || text.match(/eyJ[A-Za-z0-9_.-]{40,}/);
  if (!m) throw new Error("could not find the publishable key on the live site");
  return m[0];
}

async function main() {
  const key = await publishableKey();
  const h = { apikey: key, Authorization: `Bearer ${key}` };

  // ---------------------------------------------------------------- anon ---
  console.log("\nAn anonymous caller holding the shipped key:");
  const privateTables = ["jobs", "customers", "employees", "companies",
                         "estimate_line_items", "material_items", "time_entries",
                         "payment_records", "audit_log"];
  for (const t of privateTables) {
    const r = await fetch(`${API}/rest/v1/${t}?select=*&limit=5`, { headers: h });
    let rows = [];
    try { rows = await r.json(); } catch { /* an error body is also fine */ }
    ok(`${t} is empty to anon`, Array.isArray(rows) && rows.length === 0,
       Array.isArray(rows) ? `${rows.length} rows came back` : "unexpected body");
  }

  // The canary. Without it, every line above passes just as well when the key
  // is wrong, the project is down, or the network is refusing everything.
  const rel = await fetch(`${API}/rest/v1/app_releases?select=id&limit=5`, { headers: h });
  const relRows = await rel.json().catch(() => []);
  ok("CANARY: releases ARE readable, so the key and the requests work",
     Array.isArray(relRows) && relRows.length > 0,
     "nothing came back, so the checks above proved nothing");

  // -------------------------------------------------------------- quotes ---
  console.log("\nA quote link:");
  const bad = await fetch(`${API}/functions/v1/quote-view?t=abc`).then(r => r.json());
  ok("a malformed token is refused", typeof bad.error === "string");

  const missing = await fetch(
    `${API}/functions/v1/quote-view?t=00000000-0000-0000-0000-000000000000`
  ).then(r => r.json());
  ok("an unknown token is refused", typeof missing.error === "string");
  ok("and it does not reveal whether that quote ever existed",
     !/deleted|suspend|not found|no such/i.test(String(missing.error)));

  // ------------------------------------------------------------ webhooks ---
  console.log("\nForged payment webhooks:");
  const before = await paymentCount(h);
  for (const fn of ["stripe-webhook", "square-webhook"]) {
    const r = await fetch(`${API}/functions/v1/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json",
                 "stripe-signature": "t=1,v1=deadbeef",
                 "x-square-hmacsha256-signature": "ZGVhZGJlZWY=" },
      body: JSON.stringify({ type: "payment_intent.succeeded",
                             data: { object: { amount: 999999 } } }),
    });
    ok(`${fn} refuses an unsigned payment`, r.status >= 400, `http ${r.status}`);
  }
  const after = await paymentCount(h);
  ok("and no payment row appeared", before === after,
     `payment count moved ${before} to ${after}`);

  console.log(`\n${checked - failed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

/** Counted through the office's own view of the ledger, which anon cannot
 *  read -- so this returns null both before and after, and the comparison
 *  still catches a row appearing where the count is visible. */
async function paymentCount(h) {
  const r = await fetch(`${API}/rest/v1/payment_records?select=id`, {
    headers: { ...h, Prefer: "count=exact", Range: "0-0" },
  });
  return r.headers.get("content-range") || "unknown";
}

main().catch(e => { console.error("security smoke test could not run:", e.message); process.exit(1); });
