// a140 -- attention-sweep: notified_at was stamped on a CROSS PRODUCT, not on
// the pairs that were actually pushed.
//
//     const ids = forThisUser.map((c) => c.job_sync_id);
//     await db.from("attention_findings")
//       .update({ notified_at: new Date().toISOString() })
//       .eq("company_id", companyId)
//       .in("job_sync_id", ids)
//       .in("detector", forThisUser.map((c) => c.detector));
//
// Two .in() filters are not a list of pairs, they are every combination. For
// the findings (jobA, no_deposit) and (jobB, chargeback) that pair of lists
// also selects (jobA, chargeback) and (jobB, no_deposit) -- findings this
// person was never pushed, including the ones forThisUser had just finished
// REMOVING because they muted that detector on the dashboard.
//
// And attention_findings is unique on (company_id, detector, job_sync_id, fp)
// -- the fingerprint is part of the key, so several rows legitimately exist
// for the same three -- so it also stamped every OLDER FINGERPRINT for the
// same (company, job, detector): a finding whose message changed last week,
// marked as notified today.
//
// Nothing in the repo READS notified_at yet (grep: the only mention outside
// the schema dump is the write itself), and the live table holds 5 rows, no
// company/job pair with two detectors and no (company, job, detector) group
// with two fingerprints -- so no production row has been read wrongly. It
// would be wrong the first time anything trusts the column, which is exactly
// when nobody would be looking.
//
// The fix carries the attention_findings row id back from the claim (the
// insert already selects it) and stamps `.in("id", ...)`.
//
// The real function file runs unmodified (harness recipe from a136/a133).
//
//   node tests/a140-attention-sweep-notified-at-pairs.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import * as followUpLogic from "../supabase/functions/_shared/follow-up-logic.ts";
import * as jobPush from "../supabase/functions/_shared/job-push.ts";
import * as fcmResult from "../supabase/functions/_shared/fcm-result.ts";

const FN_PATH = new URL("../supabase/functions/attention-sweep/index.ts", import.meta.url);
const SRC = readFileSync(FN_PATH, "utf8");

const SECRET = "a140-FAKE-attention-trigger-secret-00000";
const COMPANY = "a1400000-0000-4000-8000-000000000001";
const JOB_A = "a1400000-0000-4000-8000-00000000000a";
const JOB_B = "a1400000-0000-4000-8000-00000000000b";
const OWNER = "a1400000-0000-4000-8000-0000000000u1";
const MANAGER = "a1400000-0000-4000-8000-0000000000u2";
const PROJECT = "p-a140-test";

const { privateKey: FCM_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const FIREBASE = JSON.stringify({
  client_email: "fake@a140.iam.example.test",
  private_key: FCM_KEY,
  project_id: PROJECT,
});

const env = {
  ATTENTION_SWEEP_TRIGGER_SECRET: SECRET,
  SUPABASE_URL: "https://project.fake.example.test",
  SUPABASE_SERVICE_ROLE_KEY: "a140-FAKE-service-role-key",
  FIREBASE_SERVICE_ACCOUNT: FIREBASE,
};

// ---------------------------------------------------------------- harness --

/** Runs the function's own source, with its three shared modules real. */
function load({ db, fetchImpl }) {
  let js = stripTypeScriptTypes(SRC);
  const importRe = /^import\s*(?:\{([\s\S]*?)\}|\w+)\s*from\s*"([^"]+)";?[ \t]*$/gm;
  const shared = {};
  for (const [, list, from] of js.matchAll(importRe)) {
    const names = (list ?? "").split(",").map((n) => n.trim().replace(/^type\s+/, "")).filter(Boolean);
    if (/supabase-js/.test(from)) assert.deepEqual(names, ["createClient"]);
    else {
      const mod = from === "../_shared/follow-up-logic.ts"
        ? followUpLogic
        : from === "../_shared/job-push.ts"
        ? jobPush
        : from === "../_shared/fcm-result.ts"
        ? fcmResult
        : assert.fail(`an import the harness does not supply: ${from}`);
      // Types are erased, so an interface name is not a runtime binding.
      for (const n of names) if (n in mod) shared[n] = mod[n];
    }
  }
  js = js.replace(importRe, "").replace(/^export /gm, "");
  assert.doesNotMatch(js, /^import /m);
  const names = Object.keys(shared);
  let handler = null;
  const Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
  new Function("Deno", "createClient", "fetch", ...names, js)(
    Deno,
    () => db,
    fetchImpl,
    ...names.map((n) => shared[n]),
  );
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

// --------------------------------------------------------------------- db --

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** attention_findings' real unique key: the FINGERPRINT is part of it, which
 *  is why several rows can share (company, job, detector). */
const FINDING_KEY = ["company_id", "detector", "job_sync_id", "fp"];

function fakeDb({ candidates = [], findings = [], settings = [], profiles = [], prefs = [], tokens = [] } = {}) {
  const t = {
    attention_findings: clone(findings),
    attention_sweep_settings: clone(settings),
    profiles: clone(profiles),
    notification_prefs: clone(prefs),
    device_tokens: clone(tokens),
  };
  const probe = { updates: [] };

  class Query {
    constructor(table) {
      this.table = table; this.op = "select"; this.filters = []; this.filterText = []; this.returning = false;
    }
    select() { if (this.op !== "select") this.returning = true; return this; }
    insert(row) { this.op = "insert"; this.payload = row; return this; }
    update(patch) { this.op = "update"; this.payload = patch; return this; }
    delete() { this.op = "delete"; return this; }
    eq(k, v) { this.filters.push((r) => String(r[k]) === String(v)); this.filterText.push(`eq:${k}`); return this; }
    in(k, vs) { this.filters.push((r) => vs.map(String).includes(String(r[k]))); this.filterText.push(`in:${k}`); return this; }
    maybeSingle() { this.mode = "maybe"; return this.run(); }
    then(ok, bad) { return this.run().then(ok, bad); }
    async run() {
      const rows = (t[this.table] ??= []);
      if (this.op === "insert") {
        const p = this.payload;
        if (this.table === "attention_findings" && rows.some((r) => FINDING_KEY.every((k) => r[k] === p[k]))) {
          return {
            data: null,
            error: { code: "23505", message: 'duplicate key value violates unique constraint "attention_findings_company_id_detector_job_sync_id_fp_key"' },
          };
        }
        const made = { id: randomUUID(), notified_at: null, cleared_at: null, ...clone(p) };
        rows.push(made);
        return { data: this.returning ? { id: made.id } : null, error: null };
      }
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") {
        if (this.table === "attention_findings") {
          probe.updates.push({ filters: this.filterText.slice(), matched: hit.length });
        }
        hit.forEach((r) => Object.assign(r, clone(this.payload)));
        return { data: null, error: null };
      }
      if (this.op === "delete") {
        t[this.table] = rows.filter((r) => !hit.includes(r));
        return { data: null, error: null };
      }
      if (this.mode === "maybe") return { data: clone(hit[0]) ?? null, error: null };
      return { data: clone(hit), error: null };
    }
  }

  return {
    tables: t,
    probe,
    from: (table) => new Query(table),
    rpc: async (name) => {
      if (name === "attention_sweep_candidates") return { data: clone(candidates), error: null };
      return { data: null, error: { code: "PGRST202", message: `no rpc ${name}` } };
    },
  };
}

// --------------------------------------------------------------- fixtures --

const NO_QUIET = {
  company_id: COMPANY,
  // start === end is follow-up-logic's documented "never quiet" case, so these
  // tests do not depend on the hour they are run at.
  quiet_hours_start: 0,
  quiet_hours_end: 0,
  timezone: "America/New_York",
};

const candidate = (job, detector, fp, message) => ({
  company_id: COMPANY, job_sync_id: job, detector, severity: "critical", message, fp,
});

/** A finding already in the table, never notified. */
const planted = (job, detector, fp) => ({
  id: `planted-${job.slice(-1)}-${detector}-${fp}`,
  company_id: COMPANY, job_sync_id: job, detector, fp,
  severity: "critical", message: `planted ${detector}`,
  notified_at: null, cleared_at: null,
});

/** A model FCM + Google OAuth, and a wall for everything else. */
function fakeNet() {
  const pushes = [];
  const refused = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "fake-fcm-bearer" }), { status: 200 });
    }
    if (u === `https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`) {
      const m = JSON.parse(String(init.body)).message;
      pushes.push({ token: m.token, title: m.data.title, body: m.data.body });
      return new Response("{}", { status: 200 });
    }
    refused.push(u);
    throw new Error(`REFUSED by the a140 harness: ${u}`);
  };
  return { pushes, refused, fetchImpl };
}

async function sweep(db, net) {
  const handler = load({ db, fetchImpl: net.fetchImpl });
  const res = await handler(new Request("https://fn.test/attention-sweep", {
    method: "POST", headers: { "x-fenceflow-trigger": SECRET },
  }));
  return { status: res.status, body: await res.json() };
}

/** Every finding row the run marked notified, as a stable "job/detector/fp". */
const stamped = (db) =>
  db.tables.attention_findings
    .filter((r) => r.notified_at !== null)
    .map((r) => `${r.job_sync_id.slice(-1)}/${r.detector}/${r.fp}`)
    .sort();

// ======================================================================= ==

test("notified_at marks exactly the (job, detector) pairs that were pushed -- not the cross product, and not an older fingerprint", async () => {
  const net = fakeNet();
  const db = fakeDb({
    candidates: [
      candidate(JOB_A, "no_deposit", "fp-new-a", "No deposit on Dana Smith"),
      candidate(JOB_B, "chargeback", "fp-new-b", "Chargeback on Sam Reed"),
    ],
    findings: [
      // The combination the two .in() lists invent: job A with job B's detector.
      planted(JOB_A, "chargeback", "fp-old-ax"),
      // Job B with job A's detector -- the other half of the cross product.
      planted(JOB_B, "no_deposit", "fp-old-by"),
      // Same (company, job, detector) as a candidate, DIFFERENT fingerprint:
      // a real row the unique key allows, and nobody was pushed about it.
      planted(JOB_A, "no_deposit", "fp-older-a"),
    ],
    settings: [NO_QUIET],
    profiles: [
      { id: OWNER, company_id: COMPANY, role: "OWNER", permission_overrides: "" },
      { id: MANAGER, company_id: COMPANY, role: "MANAGER", permission_overrides: "" },
    ],
    // The owner muted 'chargeback' on the dashboard, so forThisUser drops it
    // for them -- and the old filter stamped it anyway.
    prefs: [{ user_id: OWNER, muted_alerts: ["chargeback"] }],
    tokens: [
      { token: "tok-owner", user_id: OWNER, company_id: COMPANY },
      { token: "tok-manager", user_id: MANAGER, company_id: COMPANY },
    ],
  });

  const r = await sweep(db, net);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pushed, true, JSON.stringify(r.body));
  assert.deepEqual(net.refused, [], "the harness refused a request that would have left the process");

  // Both claimed, and the owner was told about one of the two, the manager both.
  assert.equal(db.tables.attention_findings.length, 5, "two claims on top of the three planted rows");
  assert.deepEqual(
    net.pushes.map((p) => p.token).sort(),
    ["tok-manager", "tok-owner"],
    "one push per phone",
  );
  assert.match(net.pushes.find((p) => p.token === "tok-owner").title, /^Needs attention$/, "the owner's single, unmuted finding");
  assert.match(net.pushes.find((p) => p.token === "tok-manager").title, /^2 things need attention$/, "the manager gets both");

  // THE POINT: only the two rows that were pushed carry notified_at.
  assert.deepEqual(stamped(db), ["a/no_deposit/fp-new-a", "b/chargeback/fp-new-b"]);

  // Said the other way round, so a future change to the fixture cannot make
  // this test pass by stamping nothing at all.
  for (const r2 of db.tables.attention_findings) {
    const isNew = r2.fp === "fp-new-a" || r2.fp === "fp-new-b";
    assert.equal(r2.notified_at === null, !isNew, `${r2.job_sync_id}/${r2.detector}/${r2.fp}`);
  }

  // And the filter it used is the row's own primary key, never the two lists
  // whose product was the whole defect.
  assert.ok(db.probe.updates.length > 0, "nothing stamped notified_at at all");
  for (const u of db.probe.updates) {
    assert.ok(u.filters.includes("in:id"), `stamped by ${u.filters.join(",")}`);
    assert.ok(!u.filters.includes("in:detector"), `stamped by ${u.filters.join(",")}`);
    assert.ok(!u.filters.includes("in:job_sync_id"), `stamped by ${u.filters.join(",")}`);
  }
});

test("a muted detector that is the ONLY finding leaves nothing stamped and nothing pushed", async () => {
  const net = fakeNet();
  const db = fakeDb({
    candidates: [candidate(JOB_A, "chargeback", "fp-new-a", "Chargeback on Dana Smith")],
    findings: [planted(JOB_A, "chargeback", "fp-old-ax")],
    settings: [NO_QUIET],
    profiles: [{ id: OWNER, company_id: COMPANY, role: "OWNER", permission_overrides: "" }],
    prefs: [{ user_id: OWNER, muted_alerts: ["chargeback"] }],
    tokens: [{ token: "tok-owner", user_id: OWNER, company_id: COMPANY }],
  });

  const r = await sweep(db, net);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(net.pushes, [], "a muted detector is not pushed");
  assert.deepEqual(stamped(db), [], "and nothing it would have been pushed with is stamped");
  // The finding is still RECORDED -- muting the push does not hide it from the
  // dashboard, which is the behaviour the function's own header claims.
  assert.equal(db.tables.attention_findings.length, 2);
});

test("a finding already recorded for this exact fingerprint is skipped, so it cannot be re-stamped", async () => {
  const net = fakeNet();
  const already = planted(JOB_A, "no_deposit", "fp-new-a");
  const db = fakeDb({
    candidates: [candidate(JOB_A, "no_deposit", "fp-new-a", "No deposit on Dana Smith")],
    findings: [already],
    settings: [NO_QUIET],
    profiles: [{ id: OWNER, company_id: COMPANY, role: "OWNER", permission_overrides: "" }],
    tokens: [{ token: "tok-owner", user_id: OWNER, company_id: COMPANY }],
  });

  const r = await sweep(db, net);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.results.map((x) => x.skipped), ["already recorded"]);
  assert.deepEqual(net.pushes, [], "notified once per occurrence, not once per sweep run");
  assert.deepEqual(stamped(db), [], "and the row it declined to re-notify is not re-stamped either");
});
