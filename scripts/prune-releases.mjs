/**
 * Removes superseded APK builds from the `releases` bucket.
 *
 * The Supabase CLI's `storage rm` reports {"deleted":[]} and removes nothing,
 * so this goes at the storage REST API directly.
 *
 * The key is read from the environment and never printed. Run it as:
 *
 *   $env:SUPABASE_SERVICE_ROLE_KEY = "<the service_role key>"
 *   node scripts/prune-releases.mjs           # shows what it WOULD delete
 *   node scripts/prune-releases.mjs --delete  # actually deletes
 *
 * Then close that terminal so the key does not linger in its history.
 */
const REF = "newcrgafcptspmapacrx";
const BUCKET = "releases";

// Kept for rollback: a broken build has to be recoverable by sideloading a
// known-good APK onto a phone in the field, without waiting for a rebuild.
// 357 earns its place separately -- it is the floor the crew money change
// depends on.
const KEEP = new Set([366, 361, 360, 358, 357]);

const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!key) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is not set. Nothing was touched.");
  process.exit(1);
}
const DELETE = process.argv.includes("--delete");
const H = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
const api = `https://${REF}.supabase.co/storage/v1`;

const listed = await fetch(`${api}/object/list/${BUCKET}`, {
  method: "POST", headers: H,
  body: JSON.stringify({ prefix: "", limit: 1000, sortBy: { column: "name", order: "asc" } }),
});
if (!listed.ok) { console.error("Could not list:", listed.status, await listed.text()); process.exit(1); }
const files = (await listed.json()).map(o => o.name);

// A file is kept only if its version number is one of the KEEP set. Anything
// whose name carries no version -- the probe and release-test uploads -- has
// no release row behind it and goes.
const versionOf = n => { const m = /^fenceflow-(\d+)-[0-9a-f]+\.apk$/.exec(n); return m ? Number(m[1]) : null; };
const keep = files.filter(n => KEEP.has(versionOf(n)));
const drop = files.filter(n => !KEEP.has(versionOf(n)));

console.log(`${files.length} files in ${BUCKET}: keeping ${keep.length}, removing ${drop.length}`);
console.log("\nKEEPING:\n  " + keep.join("\n  "));

if (!DELETE) {
  console.log("\nWOULD REMOVE:\n  " + drop.join("\n  "));
  console.log("\nDry run. Nothing was deleted. Re-run with --delete to apply.");
  process.exit(0);
}

// In batches, because one oversized request that fails tells you nothing about
// which files it got to.
let gone = 0;
for (let i = 0; i < drop.length; i += 20) {
  const batch = drop.slice(i, i + 20);
  const res = await fetch(`${api}/object/${BUCKET}`, {
    method: "DELETE", headers: H, body: JSON.stringify({ prefixes: batch }),
  });
  if (!res.ok) { console.error("Batch failed:", res.status, await res.text()); process.exit(1); }
  const removed = await res.json();
  gone += removed.length;
  console.log(`  removed ${removed.length} of ${batch.length}`);
}

// Asked again, not inferred from the responses above -- a delete endpoint that
// answers with an empty list is exactly how this went wrong the first time.
const after = await fetch(`${api}/object/list/${BUCKET}`, {
  method: "POST", headers: H, body: JSON.stringify({ prefix: "", limit: 1000 }),
});
const left = (await after.json()).map(o => o.name);
console.log(`\nDeleted ${gone}. Bucket now holds ${left.length}:\n  ` + left.join("\n  "));
if (left.length !== keep.length) console.error("\nWARNING: expected " + keep.length + " to remain.");
