// A133 -- send-follow-ups: the company gate, the cap's day, and a read that
// stopped at a thousand rows.
//
// This function can email every customer of every company, so each of the
// three defects below is a letter going to a real homeowner that should not
// have gone, or one that should have and did not.
//
// DEFECT A -- the gate failed OPEN.
//
//     const { data: allowed } = await db.rpc("company_allowed", { cid });
//     if (allowed === false) { skip }
//
// The error was dropped, and `=== false` asks a narrower question than "did
// this company say yes". A failed rpc hands back data: null (revoked EXECUTE,
// schema-cache miss, timeout), and company_allowed itself is
// `select ... from companies where id = cid` -- a scalar subquery that
// answers NULL, not false, for a company id matching no row, which is exactly
// what a follow_up_settings row outliving its company looks like. Both
// answers walked past the gate and the run emailed that company's customers,
// against this file's own header ("never a suspended/expired company -- a
// company that has stopped paying does not get FenceFlow spending its Resend
// quota on their behalf"). Verified against the live function on 2026-10-25:
// an unknown uuid answers NULL, a real company answers true.
//
// DEFECT D1 -- the daily cap counted a UTC day while quiet hours ran on the
// company's own timezone:
//
//     const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
//
// The live database has exactly one company with follow-ups switched on
// (read 2026-10-25): America/New_York, cap 25, quiet hours 21->7. Its UTC day
// rolls at 20:00 local -- INSIDE its sending window -- so everything sent
// between 20:00 and 21:00 local counted against a fresh cap. One of the
// customer's days could carry 25 letters before eight o'clock and 25 more
// after it.
//
// DEFECT D2 -- the candidate-jobs read had no .limit and no .range, so it
// took whatever PostgREST returned: at most 1000 rows, with error null and
// the total unknown. A company past a thousand eligible jobs lost an
// arbitrary remainder from every run, for ever, and nothing said so.
//
// All three are driven through the REAL function file (harness recipe from
// a128), with the real follow-up-logic.ts deciding what is due.
//
//   node tests/a133-follow-ups-gate-cap-day-and-paging.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as followUpLogic from "../supabase/functions/_shared/follow-up-logic.ts";
import * as customerReply from "../supabase/functions/_shared/mail/customer-reply.ts";

const FN_PATH = new URL("../supabase/functions/send-follow-ups/index.ts", import.meta.url);
const SRC = readFileSync(FN_PATH, "utf8");

const SECRET = "followups-trigger-secret-placeholder";
const COMPANY = "aba5b097-afc4-48dd-9851-b50200d5e8f4";
const TZ = "America/New_York";
const OFFSET = followUpLogic.approximateUtcOffsetHours(TZ); // -4 today

const env = {
  FOLLOWUPS_TRIGGER_SECRET: SECRET,
  MAIL_API_KEY: "mail-key-placeholder",
  MAIL_FROM: "noreply@fenceflowapp.com",
  MAIL_API_URL: "https://mail.test/emails",
  SITE_URL: "https://fenceflowapp.com",
  SUPABASE_URL: "https://project.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
};

// ---------------------------------------------------------------- harness --

/** Runs the function's own source. `expose` hands back named top-level
 *  declarations so a pure helper can be tested as a helper, not only through
 *  a whole run. */
function load({ db, fetchImpl, expose = [] } = {}) {
  let js = stripTypeScriptTypes(SRC);
  const importRe = /^import\s*(?:\{([\s\S]*?)\}|\w+)\s*from\s*"([^"]+)";?[ \t]*$/gm;
  const shared = {};
  for (const [, list, from] of js.matchAll(importRe)) {
    const names = (list ?? "").split(",").map((n) => n.trim()).filter(Boolean);
    if (/supabase-js/.test(from)) assert.deepEqual(names, ["createClient"]);
    else if (from === "../_shared/follow-up-logic.ts") {
      for (const n of names) {
        // Types are erased by stripTypeScriptTypes, so an interface name is
        // not a runtime binding and nothing needs to be supplied for it.
        if (n in followUpLogic) shared[n] = followUpLogic[n];
      }
    } else if (from === "../_shared/mail/customer-reply.ts") {
      for (const n of names) { assert.ok(n in customerReply, `no ${n} in customer-reply.ts`); shared[n] = customerReply[n]; }
    } else assert.fail(`an import the harness does not supply: ${from}`);
  }
  js = js.replace(importRe, "").replace(/^export /gm, "");
  assert.doesNotMatch(js, /^import /m);
  const names = Object.keys(shared);
  let handler = null;
  const Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
  const tail = expose.length ? `\nreturn { ${expose.join(", ")} };` : "";
  const out = new Function("Deno", "createClient", "fetch", ...names, js + tail)(
    Deno, () => db, fetchImpl ?? (async (u) => { throw new Error("unexpected fetch: " + u); }),
    ...names.map((n) => shared[n]),
  );
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return { handler, ...(out ?? {}) };
}

// ------------------------------------------------------------------- db ----

/**
 * In-memory service-role client, with PostgREST's row cap MODELLED: a read
 * with no .range() returns at most PAGE_CAP rows and says nothing about it,
 * which is the whole of defect D2. `probe` records what was asked for.
 */
const PAGE_CAP = 1000;

function fakeDb({ settings = [], companies = [], jobs = [], log = [], rpc = { data: true, error: null } } = {}) {
  const t = {
    follow_up_settings: [...settings],
    companies: [...companies],
    jobs: [...jobs],
    follow_up_log: [...log],
  };
  const probe = { rpcCalls: [], logCountBounds: [], jobRanges: [], jobReadsWithoutRange: 0 };
  let seq = 0;

  class Query {
    constructor(table) {
      this.table = table; this.op = "select"; this.filters = []; this.rangeArgs = null;
      this.orderBy = null; this.count = null; this.head = false; this.returning = false;
    }
    select(_cols, opts) {
      if (this.op === "update" || this.op === "insert") { this.returning = true; return this; }
      if (opts?.count) { this.count = opts.count; this.head = Boolean(opts.head); }
      return this;
    }
    eq(k, v) { this.filters.push((r) => String(r[k]) === String(v)); return this; }
    is(k, v) { this.filters.push((r) => (v === null ? (r[k] === null || r[k] === undefined) : r[k] === v)); return this; }
    not(k, op, v) {
      assert.equal(op, "eq", "the fake only models .not(col, 'eq', v)");
      this.filters.push((r) => String(r[k] ?? "") !== String(v));
      return this;
    }
    gte(k, v) {
      if (this.table === "follow_up_log" && k === "sent_at") probe.logCountBounds.push(v);
      this.filters.push((r) => new Date(r[k]).getTime() >= new Date(v).getTime());
      return this;
    }
    order(col) { this.orderBy = col; return this; }
    range(from, to) { this.rangeArgs = [from, to]; return this; }
    limit(n) { this.lim = n; return this; }
    insert(row) { this.op = "insert"; this.payload = row; return this; }
    update(patch) { this.op = "update"; this.payload = patch; return this; }
    delete() { this.op = "delete"; return this; }
    maybeSingle() { this.mode = "maybe"; return this.run(); }
    then(ok, bad) { return this.run().then(ok, bad); }
    async run() {
      const rows = (t[this.table] ??= []);
      if (this.op === "insert") {
        // follow_up_log's unique constraint on (company, job, kind, stage).
        const p = this.payload;
        if (this.table === "follow_up_log" && rows.some((r) =>
          r.company_id === p.company_id && r.job_sync_id === p.job_sync_id &&
          r.kind === p.kind && r.stage_key === p.stage_key)) {
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        const made = { id: `log-${++seq}`, sent_at: new Date().toISOString(), ...p };
        rows.push(made);
        return { data: this.returning ? { id: made.id } : null, error: null };
      }
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") { hit.forEach((r) => Object.assign(r, this.payload)); return { data: null, error: null }; }
      if (this.op === "delete") {
        t[this.table] = rows.filter((r) => !hit.includes(r));
        return { data: null, error: null };
      }
      if (this.count) return { data: this.head ? null : hit, count: hit.length, error: null };
      let out = hit;
      if (this.orderBy) out = [...out].sort((a, b) => String(a[this.orderBy]).localeCompare(String(b[this.orderBy])));
      if (this.rangeArgs) {
        if (this.table === "jobs") probe.jobRanges.push([...this.rangeArgs]);
        out = out.slice(this.rangeArgs[0], this.rangeArgs[1] + 1);
      } else {
        if (this.table === "jobs") probe.jobReadsWithoutRange++;
        // PostgREST's cap, applied silently -- error stays null and nothing
        // in the answer says the list was cut.
        out = out.slice(0, PAGE_CAP);
      }
      if (this.mode === "maybe") return { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    }
  }
  return {
    tables: t,
    probe,
    from: (table) => new Query(table),
    rpc: async (name, args) => { probe.rpcCalls.push({ name, args }); return rpc; },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  };
}

// --------------------------------------------------------------- fixtures --

const SETTINGS = (over = {}) => ({
  company_id: COMPANY,
  enabled: true,
  quote_sent_no_view_enabled: true,
  quote_sent_no_view_days: 2,
  // start === end is the file's own documented "never quiet" case, so these
  // tests do not depend on the hour they are run at.
  quiet_hours_start: 0,
  quiet_hours_end: 0,
  timezone: TZ,
  daily_cap: 25,
  ...over,
});

const COMPANY_ROW = { id: COMPANY, name: "Acme Fence", email: "office@acmefence.test", logo_path: null };

const tenDaysAgo = () => new Date(Date.now() - 10 * 86400_000).toISOString();

/** A job that quote_sent_no_view is due for, by the real dueFollowUp(). */
const dueJob = (n) => ({
  id: `job-${String(n).padStart(5, "0")}`,
  sync_id: `0000000${String(n).padStart(4, "0")}-0000-4000-8000-000000000001`,
  company_id: COMPANY,
  status: "SENT",
  customer_name: `Customer ${n}`,
  email: `c${n}@example.test`,
  created_at: tenDaysAgo(),
  quote_sent_at: tenDaysAgo(),
  quote_viewed_at: null,
  quote_approved_at: null,
  deposit_amount: 0,
  amount_paid: 0,
  opted_out_at: null,
  is_test_fixture: false,
  deleted_at: null,
  quote_token: `tok${n}`,
});

/** Eligible for the read, but nothing is due for it. */
const quietJob = (n) => ({ ...dueJob(n), quote_sent_at: null, created_at: new Date().toISOString() });

/** A mail provider that always accepts, and counts what it was asked to send. */
function fakeMail() {
  const sent = [];
  return {
    sent,
    fetchImpl: async (url, init) => {
      assert.equal(url, env.MAIL_API_URL, "mail must go to MAIL_API_URL and nowhere else");
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: `msg-${sent.length}` }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  };
}

async function run(db, mail) {
  const { handler } = load({ db, fetchImpl: mail.fetchImpl });
  const res = await handler(new Request("https://fn.test/send-follow-ups", {
    method: "POST", headers: { "x-fenceflow-trigger": SECRET },
  }));
  return { status: res.status, body: await res.json() };
}

const skips = (body) => (body.results ?? []).filter((r) => r.skipped).map((r) => r.skipped);
const sentCount = (body) => (body.results ?? []).filter((r) => r.sent).length;

// ============================================================= DEFECT A ====

test("an rpc that FAILED stops this company's run instead of emailing its customers", async () => {
  const mail = fakeMail();
  const db = fakeDb({
    settings: [SETTINGS()], companies: [COMPANY_ROW], jobs: [dueJob(1)],
    rpc: { data: null, error: { message: "permission denied for function company_allowed" } },
  });
  const r = await run(db, mail);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(mail.sent.length, 0, "NOT ONE letter may go out when the company's standing is unknown");
  assert.deepEqual(skips(r.body), ["could not check whether the company is allowed"]);
  assert.equal(db.tables.follow_up_log.length, 0, "and nothing is claimed, so it is still due next run");
});

test("a NULL answer -- a settings row outliving its company -- is not a yes", async () => {
  const mail = fakeMail();
  const db = fakeDb({
    settings: [SETTINGS()], companies: [COMPANY_ROW], jobs: [dueJob(1)],
    rpc: { data: null, error: null },
  });
  const r = await run(db, mail);
  assert.equal(mail.sent.length, 0);
  assert.deepEqual(skips(r.body), ["company not allowed"]);
});

test("an explicit false still skips, as it always did", async () => {
  const mail = fakeMail();
  const db = fakeDb({
    settings: [SETTINGS()], companies: [COMPANY_ROW], jobs: [dueJob(1)],
    rpc: { data: false, error: null },
  });
  const r = await run(db, mail);
  assert.equal(mail.sent.length, 0);
  assert.deepEqual(skips(r.body), ["company not allowed"]);
});

test("POSITIVE CONTROL: an allowed company really does get its follow-up sent", async () => {
  const mail = fakeMail();
  const db = fakeDb({ settings: [SETTINGS()], companies: [COMPANY_ROW], jobs: [dueJob(1)] });
  const r = await run(db, mail);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(mail.sent.length, 1, "one letter");
  assert.equal(mail.sent[0].to[0], "c1@example.test");
  assert.equal(mail.sent[0].reply_to, "office@acmefence.test");
  assert.equal(sentCount(r.body), 1);
  assert.equal(db.probe.rpcCalls.length, 1);
  assert.deepEqual(db.probe.rpcCalls[0], { name: "company_allowed", args: { cid: COMPANY } });
  assert.equal(db.tables.follow_up_log.length, 1, "and the send is logged");
  assert.equal(db.tables.follow_up_log[0].message_id, "msg-1");
});

test("the old rule and the new one genuinely disagree", () => {
  const oldRuleWouldSkip = (answer) => answer.data === false;
  for (const answer of [{ data: null, error: { message: "boom" } }, { data: null, error: null }]) {
    assert.equal(oldRuleWouldSkip(answer), false,
      "by construction the old rule let this through: " + JSON.stringify(answer));
  }
  assert.equal(oldRuleWouldSkip({ data: false, error: null }), true, "and agreed where it was right");
});

// ============================================================ DEFECT D1 ====

/** Independently written: components via Date.UTC, not setUTCHours. */
function localDayStart(now, offsetHours) {
  const shifted = new Date(now.getTime() + offsetHours * 3_600_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
    - offsetHours * 3_600_000).toISOString();
}

const utcMidnight = (now) => { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };

test("the helper cuts the day in the company's timezone, and differs from UTC for every zone this app uses", () => {
  const { localDayStartUtc } = load({ db: fakeDb(), expose: ["localDayStartUtc"] });
  assert.equal(typeof localDayStartUtc, "function");

  // A fixed instant, checked by hand: 2026-10-26T01:00Z is 2026-10-25 21:00
  // in New York, so the company's day began at 2026-10-25T04:00Z -- while UTC
  // had already rolled over to the 26th.
  const evening = new Date("2026-10-26T01:00:00.000Z");
  assert.equal(localDayStartUtc(evening, -4), "2026-10-25T04:00:00.000Z");
  assert.equal(utcMidnight(evening), "2026-10-26T00:00:00.000Z");

  // Every zone in approximateUtcOffsetHours()'s table, every hour of two
  // days, against the independent implementation above.
  const zones = ["America/New_York", "America/Chicago", "America/Denver",
    "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];
  let differed = 0;
  for (const zone of zones) {
    const off = followUpLogic.approximateUtcOffsetHours(zone);
    for (let h = 0; h < 48; h++) {
      const at = new Date(Date.UTC(2026, 9, 25, h, 30));
      assert.equal(localDayStartUtc(at, off), localDayStart(at, off), `${zone} @ ${at.toISOString()}`);
      if (localDayStartUtc(at, off) !== utcMidnight(at)) differed++;
    }
  }
  assert.equal(differed, zones.length * 48,
    "a UTC midnight is the wrong bound at every hour for every one of these zones");
});

test("the cap counts from the COMPANY's midnight, not UTC's", async () => {
  // The discriminator, and it does not depend on the hour this is run at:
  // read back the bound the function actually asked the database for.
  const mail = fakeMail();
  const db = fakeDb({ settings: [SETTINGS()], companies: [COMPANY_ROW], jobs: [dueJob(1)] });
  const before = new Date();
  await run(db, mail);
  const after = new Date();

  assert.equal(db.probe.logCountBounds.length, 1, "the cap is counted once per company");
  const asked = db.probe.logCountBounds[0];
  const acceptable = [localDayStart(before, OFFSET), localDayStart(after, OFFSET)];
  assert.ok(acceptable.includes(asked),
    `the cap window must start at New York midnight (${acceptable.join(" or ")}), got ${asked}`);
  assert.notEqual(asked, utcMidnight(before),
    "and must NOT be UTC midnight, which is four hours out for this company");
});

test("sends inside the company's day DO count against the cap", async () => {
  const mail = fakeMail();
  const start = new Date(localDayStart(new Date(), OFFSET)).getTime();
  const alreadySent = Array.from({ length: 25 }, (_, i) => ({
    id: `old-${i}`, company_id: COMPANY, job_sync_id: `x${i}`, kind: "quote_sent_no_view",
    stage_key: `s${i}`, channel: "email", sent_at: new Date(start + 60_000).toISOString(),
  }));
  const db = fakeDb({ settings: [SETTINGS()], companies: [COMPANY_ROW], jobs: [dueJob(1)], log: alreadySent });
  const r = await run(db, mail);
  assert.equal(mail.sent.length, 0, "the cap is 25 and 25 have gone today");
  assert.deepEqual(skips(r.body), ["daily cap reached"]);
});

test("sends from BEFORE the company's day do not count against today's cap", async () => {
  const mail = fakeMail();
  const start = new Date(localDayStart(new Date(), OFFSET)).getTime();
  const yesterday = Array.from({ length: 25 }, (_, i) => ({
    id: `old-${i}`, company_id: COMPANY, job_sync_id: `x${i}`, kind: "quote_sent_no_view",
    stage_key: `s${i}`, channel: "email", sent_at: new Date(start - 60_000).toISOString(),
  }));
  const db = fakeDb({ settings: [SETTINGS()], companies: [COMPANY_ROW], jobs: [dueJob(1)], log: yesterday });
  const r = await run(db, mail);
  assert.equal(mail.sent.length, 1, "yesterday's letters must not eat today's cap");
  assert.equal(sentCount(r.body), 1);
});

// ============================================================ DEFECT D2 ====

test("the fake really does model PostgREST's silent thousand-row cap", async () => {
  // POSITIVE CONTROL for the test below: if an unpaged read in this harness
  // returned everything, the paging test would pass against unpaged code.
  const jobs = Array.from({ length: 1200 }, (_, i) => quietJob(i + 1));
  const db = fakeDb({ jobs });
  const { data, error } = await db.from("jobs").select("sync_id").eq("company_id", COMPANY);
  assert.equal(error, null, "and it is silent -- no error at all");
  assert.equal(data.length, 1000, "exactly a thousand rows came back out of 1200");
});

test("a company past a thousand eligible jobs does not lose the remainder", async () => {
  // 1200 eligible jobs, and the only three that are DUE sort last by id --
  // so an unpaged read sees none of them and the run goes green having sent
  // nothing, which is precisely how this defect looked in production.
  const jobs = [
    ...Array.from({ length: 1197 }, (_, i) => quietJob(i + 1)),
    dueJob(1198), dueJob(1199), dueJob(1200),
  ];
  const mail = fakeMail();
  const db = fakeDb({ settings: [SETTINGS()], companies: [COMPANY_ROW], jobs });
  const r = await run(db, mail);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(mail.sent.length, 3, "all three due letters go out: " + JSON.stringify(r.body.results));
  assert.deepEqual(mail.sent.map((m) => m.to[0]).sort(),
    ["c1198@example.test", "c1199@example.test", "c1200@example.test"]);
  assert.equal(db.probe.jobReadsWithoutRange, 0, "no read may go out without a range");
  assert.ok(db.probe.jobRanges.length >= 2,
    "more than one page was asked for: " + JSON.stringify(db.probe.jobRanges));
  assert.deepEqual(db.probe.jobRanges[0], [0, 999]);
  assert.deepEqual(db.probe.jobRanges[1], [1000, 1999]);
});

test("the ordinary small-company case asks for one page and stops", async () => {
  const mail = fakeMail();
  const db = fakeDb({ settings: [SETTINGS()], companies: [COMPANY_ROW], jobs: [dueJob(1), quietJob(2)] });
  const r = await run(db, mail);
  assert.equal(mail.sent.length, 1);
  assert.deepEqual(db.probe.jobRanges, [[0, 999]], "a short page means the end");
  assert.equal(sentCount(r.body), 1);
});

// ------------------------------------------------------------ unmoved -----

test("the door and the mail config are still checked first", async () => {
  // Scope guard: the secret and the refusals around these fixes must not have
  // been disturbed.
  const db = fakeDb({ settings: [SETTINGS()], companies: [COMPANY_ROW], jobs: [dueJob(1)] });
  const { handler } = load({ db, fetchImpl: fakeMail().fetchImpl });
  const wrong = await handler(new Request("https://fn.test/send-follow-ups", {
    method: "POST", headers: { "x-fenceflow-trigger": "guessed" },
  }));
  assert.equal(wrong.status, 401);
  const none = await handler(new Request("https://fn.test/send-follow-ups", { method: "POST" }));
  assert.equal(none.status, 401);
  assert.equal(db.tables.follow_up_log.length, 0);
});

test("a company with no reply address is still skipped before anything is claimed", async () => {
  const mail = fakeMail();
  const db = fakeDb({
    settings: [SETTINGS()], companies: [{ ...COMPANY_ROW, email: "" }], jobs: [dueJob(1)],
  });
  const r = await run(db, mail);
  assert.equal(mail.sent.length, 0);
  assert.deepEqual(skips(r.body), ["no reply address for the company"]);
  assert.equal(db.tables.follow_up_log.length, 0);
});
