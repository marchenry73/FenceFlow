// a147 -- resend-inbound: two small things the function was quietly wrong about.
//
// DEFECT 1 -- a company at its daily cap looked like a reply domain receiving
// nothing at all.
//
//     if (open.length === 0) {
//       await recordHandled(admin, svixId, emailId, targets[0].companyId);
//       return json({ ok: true, stored: 0, dropped: "daily_limit" });
//     }
//
// noteReceived()'s own comment said "last_inbound_at on every delivery that
// reached the reply domain", and the unknown-recipient branch just above
// already bumps it for a delivery it DROPS. This branch did not -- and it is
// the branch where a real address of a real company was hit, which is more
// than the unknown-recipient one can say. So the column mixed two very
// different states into one value: "receiving is broken" and "this company is
// over its cap". It is the only question that column exists to answer.
//
// The decision: last_inbound_at means MAIL ARRIVED, not mail was stored.
// "Was it stored" is already answered by mail_messages and by the
// inbound_dropped count in mail_events, which this branch writes. The comment
// on noteReceived now says that in those words, and the code matches it.
// `proved` stays false here: the message is never fetched from Resend on this
// path, so the delivery proves nothing about RESEND_RECEIVING_KEY and must not
// set inbound_verified_at.
//
// DEFECT 2 -- an attachment whose size Resend omitted was recorded as 0.
//
//     size: size ?? 0,
//
// `size` is already `number | null` from countOf(), and the inline decision
// three lines above correctly refuses to inline a part of unknown size
// (`size !== null && size <= INLINE_IMAGE_MAX_BYTES`). Only the stored row
// flattened the two together, so a part waiting for its background download
// was indistinguishable from a genuinely empty attachment -- and every size
// here is Resend's CLAIM until storeAttachments() replaces it with the bytes
// actually received.
//
// Neither has bitten production yet (read 2026-10-26: last_inbound_at is set,
// and no resend_inbound row has any attachment entry at all). Both are stated
// here as values so they cannot come back.
//
// The real function runs unmodified, through its exported handleRequest with
// model deps. Signatures are computed here with node:crypto.
//
//   node tests/a147-resend-inbound-cap-arrival-and-absent-size.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { registerHooks } from "node:module";

const SUPABASE_JS = "https://esm.sh/@supabase/supabase-js@2.39.0";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === SUPABASE_JS) {
      const src = "export const createClient = (...a) => globalThis.__a147CreateClient(...a);";
      return { url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const fn = await import("../supabase/functions/resend-inbound/index.ts");
const { INBOUND_PER_COMPANY_PER_DAY, INLINE_IMAGE_MAX_BYTES } =
  await import("../supabase/functions/_shared/mail/limits.ts");

// ------------------------------------------------------- made-up identities --
const SIGNING_KEY = Buffer.from("a147-resend-inbound-key-32-bytes", "utf8");
const WHSEC = `whsec_${SIGNING_KEY.toString("base64")}`;
const RKEY = "re_FAKE_a147_receiving_key_ABCDEFGH012345";
const SERVICE_KEY = "a147-FAKE-service-role-key";
const DOMAIN = "reply.fake.example.test";
const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const COMPANY = "a1470000-0000-4000-8000-000000000001";
const ACCOUNT = "a1470000-0000-4000-8000-0000000000a1";
const INBOUND_TOKEN = "a1b2c3d4e5f60718";
const EMAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

let world;
function newWorld(over = {}) {
  world = {
    now: NOW,
    env: {
      SUPABASE_URL: "https://project.fake.example.test",
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
      RESEND_WEBHOOK_SECRET: WHSEC,
      RESEND_RECEIVING_KEY: RKEY,
      MAIL_INBOUND_DOMAIN: DOMAIN,
    },
    created: [],
    fetchLog: [],
    mail_events: [],
    mail_inbound_events: [],
    mail_accounts: [{
      id: ACCOUNT, company_id: COMPANY, kind: "fenceflow", provider: "resend",
      email_address: "noreply@send.fake.example.test", inbound_token: INBOUND_TOKEN, status: "connected",
    }],
    mail_messages: [],
    mail_platform_settings: [{
      id: 1, inbound_domain: DOMAIN,
      inbound_verified_at: "2026-09-22T16:03:35.519Z",
      last_inbound_at: "2026-10-23T02:39:57.369Z",
    }],
    ...over,
  };
}

const settingsRow = () => world.mail_platform_settings[0];

// --------------------------------------------------------- the model client --
// Only the cap path is exercised, which returns before mail_ingest, so no
// ingest model is needed. A read with no filter at all is REFUSED: under the
// service role that would be every company's rows.

class Query {
  constructor(table, key) { this.table = table; this.key = key; this.op = "select"; this.filters = []; this.named = []; }
  select() { return this; }
  insert(row) { this.op = "insert"; this.payload = row; return this; }
  update(patch) { this.op = "update"; this.payload = patch; return this; }
  eq(k, v) { this.named.push(k); this.filters.push((r) => String(r[k]) === String(v)); return this; }
  in(k, vs) { this.named.push(k); this.filters.push((r) => vs.map(String).includes(String(r[k]))); return this; }
  maybeSingle() { this.mode = "maybe"; return this.run(); }
  then(ok, bad) { return this.run().then(ok, bad); }
  async run() {
    if (this.key !== SERVICE_KEY) return { data: null, error: { code: "42501", message: "permission denied" } };
    const rows = (world[this.table] ??= []);
    if (this.op === "insert") {
      const p = clone(this.payload);
      if (this.table === "mail_inbound_events" && rows.some((r) => r.svix_id === p.svix_id)) {
        return { data: null, error: { code: "23505", message: "duplicate key" } };
      }
      rows.push(p);
      return { data: null, error: null };
    }
    if (!this.named.length) {
      return { data: null, error: { code: "A143", message: `an unfiltered ${this.op} on ${this.table} would reach every company` } };
    }
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") { hit.forEach((r) => Object.assign(r, clone(this.payload))); return { data: null, error: null }; }
    if (this.mode === "maybe") return { data: clone(hit[0]) ?? null, error: null };
    return { data: clone(hit), error: null };
  }
}

const countEvents = (company, kind) =>
  world.mail_events.filter((e) => e.company_id === company && e.kind === kind && e.at > world.now - 86_400_000).length;

globalThis.__a147CreateClient = (url, key) => {
  world.created.push({ url, key });
  return {
    from: (table) => new Query(table, key),
    rpc: async (name, args) => {
      if (key !== SERVICE_KEY) return { data: null, error: { code: "42501", message: "permission denied" } };
      if (name === "note_mail_event") {
        assert.equal(args.p_window, "1 day");
        world.mail_events.push({ company_id: args.p_company, kind: args.p_kind, at: world.now });
        return { data: countEvents(args.p_company, args.p_kind), error: null };
      }
      return { data: null, error: { code: "PGRST202", message: `no rpc ${name}` } };
    },
    storage: { from: () => ({ upload: async () => ({ data: null, error: { message: "not used here" } }) }) },
  };
};

// ------------------------------------------------- the network: a model wall --
// The cap path must not fetch anything at all; everything is recorded so the
// test can assert that.
async function fakeFetch(url, init = {}) {
  world.fetchLog.push({ url: String(url), method: init.method });
  return new Response("{}", { status: 404 });
}

const deps = (over = {}) => ({
  fetch: fakeFetch,
  now: () => world.now,
  env: (k) => world.env[k],
  background: (work) => work,
  ...over,
});

// ------------------------------------------------------------- deliveries ---
const sign = (id, ts, body) => `v1,${createHmac("sha256", SIGNING_KEY).update(`${id}.${ts}.${body}`).digest("base64")}`;

let svixSeq = 0;
function delivery({ to = [`${INBOUND_TOKEN}@${DOMAIN}`], id = `msg_a147_${++svixSeq}` } = {}) {
  const raw = JSON.stringify({
    type: "email.received",
    created_at: "2026-10-26T11:59:31.000Z",
    data: {
      email_id: EMAIL_ID,
      created_at: "2026-10-26T11:59:30.000Z",
      from: "pat@customer.example.test",
      to,
      cc: [],
      bcc: [],
      subject: "Re: Your fence quote",
      message_id: "<reply-1@customer.example.test>",
      attachments: [],
    },
  });
  const ts = Math.floor(world.now / 1000);
  return new Request("https://project.fake.example.test/functions/v1/resend-inbound", {
    method: "POST",
    headers: {
      "svix-id": id,
      "svix-timestamp": String(ts),
      "svix-signature": sign(id, ts, raw),
      "content-type": "application/json",
    },
    body: raw,
  });
}

async function call(req, d = deps()) {
  const res = await fn.handleRequest(req, d);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

/** Puts the company exactly at its cap, so the next delivery is refused. */
function atCap() {
  for (let i = 0; i < INBOUND_PER_COMPANY_PER_DAY; i++) {
    world.mail_events.push({ company_id: COMPANY, kind: "inbound", at: world.now - 60_000 });
  }
}

// ================================================================ DEFECT 1 ==

test("a delivery dropped by the daily cap still records that mail ARRIVED", async () => {
  newWorld();
  atCap();
  const before = settingsRow().last_inbound_at;

  const r = await call(delivery());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.dropped, "daily_limit", JSON.stringify(r.body));
  assert.equal(r.body.stored, 0);

  // THE POINT: the reply domain is not reported as silent.
  assert.notEqual(settingsRow().last_inbound_at, before, "a company at its cap still looks like a domain receiving nothing");
  assert.equal(settingsRow().last_inbound_at, new Date(NOW).toISOString());

  // Nothing else about the delivery changed: not stored, counted as dropped,
  // recorded as handled so Resend's retry does not run it again.
  assert.deepEqual(world.mail_messages, []);
  assert.equal(countEvents(COMPANY, "inbound_dropped"), 1, "the drop is still counted, which is where 'was it stored' is answered");
  assert.deepEqual(world.mail_inbound_events.map((e) => [e.svix_id, e.company_id]), [["msg_a147_1", COMPANY]]);
  assert.deepEqual(world.fetchLog, [], "a capped message is still never fetched from Resend");
});

test("the capped path does NOT verify receiving: it never asked Resend for the message", async () => {
  newWorld();
  settingsRow().inbound_verified_at = null;
  settingsRow().inbound_domain = null;
  atCap();

  const r = await call(delivery());
  assert.equal(r.body.dropped, "daily_limit", JSON.stringify(r.body));
  assert.equal(settingsRow().last_inbound_at, new Date(NOW).toISOString(), "it arrived, and that much is recorded");
  assert.equal(settingsRow().inbound_verified_at, null, "but a delivery nobody fetched proves nothing about RESEND_RECEIVING_KEY");
  assert.equal(settingsRow().inbound_domain, null);
  assert.deepEqual(world.fetchLog, []);
});

test("an address at the reply domain belonging to nobody also records arrival -- the two drops agree", async () => {
  newWorld();
  const r = await call(delivery({ to: [`ffffffffffffffff@${DOMAIN}`] }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.dropped, "unknown_recipient", JSON.stringify(r.body));
  assert.equal(settingsRow().last_inbound_at, new Date(NOW).toISOString());
  assert.equal(countEvents(null, "inbound_dropped"), 1);
});

test("a delivery that never reached the reply domain does not touch last_inbound_at", async () => {
  newWorld();
  const before = settingsRow().last_inbound_at;
  const r = await call(delivery({ to: ["someone@a.different.example.test"] }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.dropped, "unknown_recipient", JSON.stringify(r.body));
  assert.equal(settingsRow().last_inbound_at, before, "'mail arrived' means arrived HERE");
});

// ================================================================ DEFECT 2 ==

test("an attachment whose size Resend omits records NULL, not 0 -- absent is not empty", () => {
  const parts = fn.partsFromResend([
    { id: "a1", filename: "unknown.pdf", content_type: "application/pdf" },
    { id: "a2", filename: "empty.txt", content_type: "text/plain", size: 0 },
    { id: "a3", filename: "real.pdf", content_type: "application/pdf", size: 4096 },
    { id: "a4", filename: "nonsense.pdf", content_type: "application/pdf", size: "quite big" },
    { id: "a5", filename: "negative.pdf", content_type: "application/pdf", size: -1 },
  ]);
  assert.deepEqual(parts.map((p) => p.filename), ["unknown.pdf", "empty.txt", "real.pdf", "nonsense.pdf", "negative.pdf"]);
  assert.deepEqual(parts.map((p) => p.size), [null, 0, 4096, null, null]);
  // Said as the distinction itself, because that is the whole fix: the two
  // cases that used to be the same value are now different values.
  assert.notEqual(parts[0].size, parts[1].size, "an unknown size is indistinguishable from a 0-byte attachment");
  assert.equal(parts[1].size, 0, "and a genuinely empty attachment is still 0, not null");
  assert.ok(parts.every((p) => p.state === "pending" && p.storage_path === null));
});

test("an unknown size still refuses to inline, and a known one inside the cap still inlines", () => {
  const parts = fn.partsFromResend([
    { id: "b1", filename: "no-size.png", content_type: "image/png", content_disposition: "inline", content_id: "c1" },
    { id: "b2", filename: "sized.png", content_type: "image/png", content_disposition: "inline", content_id: "c2", size: 1024 },
    { id: "b3", filename: "huge.png", content_type: "image/png", content_disposition: "inline", content_id: "c3", size: INLINE_IMAGE_MAX_BYTES + 1 },
  ]);
  assert.deepEqual(parts.map((p) => [p.filename, p.disposition, p.size]), [
    ["no-size.png", "attachment", null],
    ["sized.png", "inline", 1024],
    ["huge.png", "attachment", INLINE_IMAGE_MAX_BYTES + 1],
  ]);
});
