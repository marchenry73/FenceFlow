// Item C3: an OPTIONAL drawn signature alongside the REQUIRED typed name on
// the customer-facing quote page. supabase/functions/quote-view/index.ts is
// the only thing that persists it -- the customer's browser never holds a
// database credential -- and it must land in the SAME UPDATE that already
// writes quote_approved_name and quote_approved_at, never a separate one.
//
// Run with:  node --test tests/a15-signature-approval.test.mjs
//
// The function runs for real: TypeScript stripped by Node's own stripper,
// its three real imports (quote-deposit.ts, job-push.ts, push-recipients.ts)
// wired in, Deno.serve handing over the real request handler, and a fake
// service-role client standing in for Supabase -- extended here with a fake
// job-files storage bucket, since this is the first thing in this function
// to touch Storage rather than just the database. Nothing touches the
// network, a real database or a card.
//
// Every refusal test asserts BOTH the HTTP response AND that nothing landed
// in the row or in storage: a check that only reads the status code cannot
// tell "refused" from "silently approved with the drawing quietly dropped",
// which is the exact failure mode this feature exists not to become.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as quoteDeposit from "../supabase/functions/_shared/quote-deposit.ts";
import * as jobPush from "../supabase/functions/_shared/job-push.ts";
import * as pushRecipients from "../supabase/functions/_shared/push-recipients.ts";

const COMPANY = "c5000000-0000-4000-8000-000000000005";
const JOB = "a5000000-0000-4000-8000-00000000000a"; // sync_id
const JOB_ID = "15000000-0000-4000-8000-000000000015";
const TOKEN = "b5000000-0000-4000-8000-00000000000b";

// ============================================================ harness =====
// The load() below is copied from tests/accepted-price-functions.test.mjs,
// which loads this same quote-view/index.ts the same way: an eval of the
// real source with its imports substituted. Kept local rather than shared,
// per this repo's convention of each test file stating its own contract
// with the source it loads.

const SHARED = {
  "../_shared/quote-deposit.ts": quoteDeposit,
  "../_shared/job-push.ts": jobPush,
  "../_shared/push-recipients.ts": pushRecipients,
};

function load(path, { env = {}, db, fetchImpl = async () => new Response("{}", { status: 404 }) }) {
  let js = stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), "utf8"));
  const importRe = /^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";?[ \t]*$/gm;
  const provided = {};
  for (const [, list, from] of js.matchAll(importRe)) {
    const names = list.split(",").map((n) => n.trim()).filter(Boolean);
    if (/supabase-js/.test(from)) {
      assert.deepEqual(names, ["createClient"], "supabase-js import changed");
      provided.createClient = () => db;
    } else if (Object.hasOwn(SHARED, from)) {
      for (const n of names) {
        assert.ok(n in SHARED[from], `${from} exports no ${n}`);
        provided[n] = SHARED[from][n];
      }
    } else {
      assert.fail(`an import the harness does not supply: ${from}`);
    }
  }
  assert.ok(provided.createClient && provided.depositFigures, "the file no longer imports what the harness expects");
  js = js.replace(importRe, "").replace(/^export /gm, "");
  assert.doesNotMatch(js, /^import /m, "an import the harness did not strip");
  let handler = null;
  const Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
  const names = Object.keys(provided);
  new Function("Deno", "fetch", ...names, js)(Deno, fetchImpl, ...names.map((n) => provided[n]));
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

/**
 * An in-memory service-role client, extended from the one in
 * accepted-price-functions.test.mjs with a fake job-files storage bucket.
 *
 * withoutSignatureColumn models a database supabase_quote_signature_patch.sql
 * has not reached yet: any read or write naming
 * quote_approved_signature_path fails the way PostgREST does on an unknown
 * column -- the same shape withoutAcceptance already models there for
 * accepted_total.
 */
function fakeDb(tables, { withoutSignatureColumn = false, failStorageUpload = false } = {}) {
  const t = structuredClone(tables);
  const log = [];
  const storageLog = [];
  const objects = new Map(); // "bucket/path" -> Uint8Array
  class Query {
    constructor(table) { this.table = table; this.op = "select"; this.cols = "*"; this.filters = []; this.returning = false; this.lim = Infinity; }
    select(cols) { if (this.op === "select") this.cols = cols ?? "*"; else this.returning = true; return this; }
    eq(k, v) { this.filters.push((r) => String(r[k]) === String(v)); return this; }
    is(k, v) { this.filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return this; }
    order() { return this; }
    limit(n) { this.lim = n; return this; }
    update(p) { this.op = "update"; this.payload = p; return this; }
    maybeSingle() { this.mode = "maybe"; return this.run(); }
    single() { this.mode = "one"; return this.run(); }
    then(ok, bad) { return this.run().then(ok, bad); }
    async run() {
      const named = this.op === "select" ? String(this.cols) : Object.keys(this.payload ?? {}).join(",");
      log.push({ op: this.op, table: this.table, cols: named, payload: this.payload });
      if (withoutSignatureColumn && this.table === "jobs" && /quote_approved_signature_path/.test(named)) {
        return { data: null, error: { message: "column jobs.quote_approved_signature_path does not exist" } };
      }
      const rows = (t[this.table] ??= []);
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") {
        hit.forEach((r) => Object.assign(r, this.payload));
        return { data: this.returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
      }
      const cols = String(this.cols).split(",").map((c) => c.trim()).filter(Boolean);
      const project = (r) => (cols.length === 0 || cols.includes("*"))
        ? r : Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]]));
      const out = hit.slice(0, this.lim).map(project);
      if (this.mode === "maybe") return { data: out[0] ?? null, error: null };
      if (this.mode === "one") return out[0] ? { data: out[0], error: null } : { data: null, error: { message: "no row" } };
      return { data: out, error: null };
    }
  }
  return {
    tables: t,
    log,
    storageLog,
    storageObjects: objects,
    from: (table) => new Query(table),
    rpc: async (fn) => ({ data: fn === "quote_phone_try" ? "OK" : true, error: null }),
    storage: {
      from: (bucket) => ({
        upload: async (path, bytes, opts) => {
          storageLog.push({
            op: "upload", bucket, path,
            bytes: bytes instanceof Uint8Array ? bytes.length : null,
            contentType: opts?.contentType, upsert: !!opts?.upsert,
          });
          if (failStorageUpload) return { data: null, error: { message: "planted: storage upload failed" } };
          objects.set(`${bucket}/${path}`, bytes);
          return { data: { path }, error: null };
        },
        createSignedUrl: async (path, expiresIn) => {
          storageLog.push({ op: "sign", bucket, path, expiresIn });
          if (!objects.has(`${bucket}/${path}`)) return { data: null, error: { message: "Object not found" } };
          return { data: { signedUrl: `https://fake.storage.test/${bucket}/${path}?exp=${expiresIn}` }, error: null };
        },
      }),
    },
  };
}

const sentJob = (o = {}) => ({
  id: JOB_ID, sync_id: JOB, company_id: COMPANY, customer_name: "Pat Buyer", address: "1 Oak St",
  phone: "", status: "SENT", deleted_at: null, quote_token: TOKEN,
  contract_total: 5000, accepted_total: null, signed_at: null,
  quote_approved_at: null, quote_approved_name: "", quote_approved_signature_path: null,
  reapproval_required_at: null, reapproval_reason: "",
  amount_paid: 0, refunded_amount: 0, deposit_amount: 0, tax_rate_percent: 0, discount_percent: 0,
  quote_viewed_at: "2026-09-01T00:00:00Z", calibration_pixels_per_foot: 20,
  quote_phone_attempts: 0, quote_phone_locked_until: null,
  ...o,
});

function quoteWorld({ job = {}, opts = {} } = {}) {
  const db = fakeDb({
    jobs: [sentJob(job)],
    companies: [{ id: COMPANY, name: "Test Fence Co", phone: "", email: "" }],
    estimate_line_items: [],
    change_orders: [],
    fence_runs: [],
    payment_connections: [],
  }, opts);
  // No FIREBASE_SERVICE_ACCOUNT: JSON.parse(... ?? "null") is null, so the
  // push branch no-ops, the same escape hatch accepted-price-functions.test.mjs
  // uses for the tests that are not about the push. These tests are about
  // the signature.
  const handler = load("../supabase/functions/quote-view/index.ts", { env: {}, db });
  return { handler, db };
}

async function view(w) {
  const res = await w.handler(new Request(`https://fn.test/quote-view?t=${TOKEN}`));
  return { status: res.status, body: await res.json() };
}
async function approve(w, extra = {}) {
  const res = await w.handler(new Request(`https://fn.test/quote-view?t=${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve", name: "Pat Buyer", ...extra }),
  }));
  return { status: res.status, body: await res.json() };
}
const jobRow = (w) => w.db.tables.jobs[0];

// Shaped like a canvas's own toDataURL() output. Only the first 8 bytes (the
// PNG signature) and the overall length matter to the code under test, so
// these are not hand-picked to please it -- they exercise exactly what it
// checks: real bytes, a real size.
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];
function bytesOf(length, magic) {
  const b = new Uint8Array(length);
  magic.forEach((byte, i) => { if (i < b.length) b[i] = byte; });
  return b;
}
function dataUrlOf(bytes) {
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}
const smallSignature = () => dataUrlOf(bytesOf(64, PNG_MAGIC));
const oversizedSignature = () => dataUrlOf(bytesOf(310 * 1024, PNG_MAGIC)); // over the 300KB cap
const notAnImageSignature = () => dataUrlOf(bytesOf(100, JPEG_MAGIC));

// ============================================================== tests =====

test("approval still works with a typed name and NO drawing", async () => {
  const w = quoteWorld();
  const r = await approve(w);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(jobRow(w).quote_approved_name, "Pat Buyer");
  assert.equal(jobRow(w).quote_approved_signature_path, null);
  assert.equal(w.db.storageLog.length, 0, "no drawing was sent; nothing should ever touch storage");
  const seen = await view(w);
  assert.equal(seen.body.signatureCaptureReady, true);
  assert.equal(seen.body.approvedSignatureUrl, null);
});

test("a drawn signature is decoded, stored under company/job, and returned as a signed URL", async () => {
  const w = quoteWorld();
  const r = await approve(w, { signatureDataUrl: smallSignature() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // The typed name is still on the record -- a drawing rides ALONGSIDE it,
  // never instead of it.
  assert.equal(jobRow(w).quote_approved_name, "Pat Buyer");
  const path = jobRow(w).quote_approved_signature_path;
  assert.match(path, new RegExp(`^${COMPANY}/${JOB}/quote-signature/\\d+\\.png$`));
  // Recorded in the SAME update as the name and timestamp -- one statement,
  // so an approval can never exist with one and not the other.
  const write = w.db.log.find((e) => e.op === "update" && e.table === "jobs" && e.payload?.quote_approved_at);
  assert.ok(write, "the approval was written");
  assert.equal(write.payload.quote_approved_name, "Pat Buyer");
  assert.equal(write.payload.quote_approved_signature_path, path);
  // The upload carries the actual decoded bytes, never the client's claimed
  // size or type.
  assert.equal(w.db.storageLog.length, 1);
  assert.equal(w.db.storageLog[0].bucket, "job-files");
  assert.equal(w.db.storageLog[0].contentType, "image/png");
  assert.equal(w.db.storageLog[0].bytes, 64);
  const seen = await view(w);
  assert.equal(seen.body.signatureCaptureReady, true);
  assert.match(seen.body.approvedSignatureUrl, /^https:\/\/fake\.storage\.test\/job-files\//);
  assert.notEqual(seen.body.approvedSignatureUrl, path, "never the raw storage path");
});

test("an oversized signature is refused with an actionable message, and nothing is written or uploaded", async () => {
  const w = quoteWorld();
  const r = await approve(w, { signatureDataUrl: oversizedSignature() });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "signature_invalid");
  assert.match(r.body.error, /too large/i);
  assert.equal(jobRow(w).quote_approved_at, null, "the whole approval refuses, not just the drawing");
  assert.equal(jobRow(w).quote_approved_name, "", "a rejected drawing must not leave a half-landed approval");
  assert.equal(w.db.storageLog.length, 0, "an oversized payload must never reach storage");
});

test("a payload that is not actually an image is refused, by its bytes, not by its claimed type", async () => {
  const w = quoteWorld();
  const r = await approve(w, { signatureDataUrl: notAnImageSignature() });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "signature_invalid");
  assert.doesNotMatch(r.body.error, /too large/i, "a bad image is a different problem from a big one");
  assert.equal(jobRow(w).quote_approved_at, null);
  assert.equal(w.db.storageLog.length, 0);

  // Neither a non-PNG prefix nor a non-string value gets any further either.
  const w2 = quoteWorld();
  const r2 = await approve(w2, { signatureDataUrl: "data:text/plain;base64,SGVsbG8=" });
  assert.equal(r2.status, 400);
  assert.equal(r2.body.code, "signature_invalid");

  const w3 = quoteWorld();
  const r3 = await approve(w3, { signatureDataUrl: 12345 });
  assert.equal(r3.status, 400);
  assert.equal(r3.body.code, "signature_invalid");
});

test("a second approval attempt cannot overwrite the first -- not the name, and not the signature", async () => {
  const w = quoteWorld();
  const first = await approve(w, { name: "Pat First", signatureDataUrl: smallSignature() });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const firstPath = jobRow(w).quote_approved_signature_path;
  assert.ok(firstPath);
  assert.equal(w.db.storageLog.length, 1);

  // A forwarded link, or a slow double-tap: a second approve call carrying a
  // DIFFERENT name and a DIFFERENT drawing.
  const second = await approve(w, { name: "Sneaky Neighbor", signatureDataUrl: dataUrlOf(bytesOf(80, PNG_MAGIC)) });
  assert.equal(second.status, 200, JSON.stringify(second.body)); // not an error -- a no-op reporting who really signed
  assert.equal(second.body.approvedBy, "Pat First");
  assert.equal(jobRow(w).quote_approved_name, "Pat First", "the second name must not land");
  assert.equal(jobRow(w).quote_approved_signature_path, firstPath, "the second drawing must not land");
  // The strongest check: the second drawing was never even uploaded, so
  // there is no orphan file and no window where a retry could ever rewrite
  // the pointer to something that IS sitting in storage.
  assert.equal(w.db.storageLog.length, 1, "a second approval must never touch storage at all");
});

test("signatureCaptureReady is false without the migration, and a signature is refused rather than silently dropped", async () => {
  const w = quoteWorld({ opts: { withoutSignatureColumn: true } });
  const seenBefore = await view(w);
  assert.equal(seenBefore.body.signatureCaptureReady, false);
  assert.equal(seenBefore.body.approvedSignatureUrl, null);

  const bad = await approve(w, { signatureDataUrl: smallSignature() });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "signature_unavailable");
  assert.equal(jobRow(w).quote_approved_at, null, "no fake feature: never approve minus the drawing that was promised");
  assert.equal(w.db.storageLog.length, 0);

  // The name-only path -- the one thing this deploy CAN honestly do -- still
  // works exactly as it always has.
  const good = await approve(w);
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.equal(jobRow(w).quote_approved_name, "Pat Buyer");
});

test("a failed storage upload refuses the approval instead of recording a name with a dangling path", async () => {
  const w = quoteWorld({ opts: { failStorageUpload: true } });
  const r = await approve(w, { signatureDataUrl: smallSignature() });
  assert.equal(r.status, 500);
  assert.equal(jobRow(w).quote_approved_at, null);
  assert.equal(jobRow(w).quote_approved_signature_path, null);
});
