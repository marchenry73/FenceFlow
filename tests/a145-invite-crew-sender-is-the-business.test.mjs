// a145 -- invite-crew: "business name as the sender" never happened.
//
// The comment over the send said:
//
//     // Business name as the sender, the platform address underneath. A
//     // display name matching the brand the reader expects keeps it out of
//     // spam; the address stays on the verified domain.
//     from: senderWithName(company?.name ?? "", mailFrom),
//
// and senderWithName was:
//
//     if (!clean || address.includes("<")) return address;
//
// -- the bare MAIL_FROM whenever MAIL_FROM already carried a display name.
// The runbook at the top of that same file says MAIL_FROM is expected to be
// exactly that: `"FenceFlow <crew@fenceflowapp.com>"`. So the one branch that
// could ever have put the business's name on the letter was unreachable for
// every value the file tells the owner to configure, and every crew invitation
// went out as "FenceFlow".
//
// The repo had already settled which behaviour is right: fenceflowFrom() in
// _shared/mail/mime-build.ts takes the BARE address out of MAIL_FROM and puts
// the company's name on it, and its own doc names this trap ("the older
// senderWithName returns such a MAIL_FROM unchanged and the company name is
// lost"). mail-send, mail-connect and quote-approval-email all use it. So the
// comment was right and the code was wrong; invite-crew now composes the name
// with the bare address, with the same two helpers (bareAddressOf,
// cleanDisplayName) fenceflowFrom is built from.
//
// The real function file runs unmodified (harness recipe from a136/a133).
//
//   node tests/a145-invite-crew-sender-is-the-business.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as inviteEmail from "../supabase/functions/_shared/invite-crew-email.ts";
import * as mimeBuild from "../supabase/functions/_shared/mail/mime-build.ts";

const FN_PATH = new URL("../supabase/functions/invite-crew/index.ts", import.meta.url);
const SRC = readFileSync(FN_PATH, "utf8");

const COMPANY = "a1450000-0000-4000-8000-000000000001";
const UID = "a1450000-0000-4000-8000-0000000000u1";
const JOIN_CODE = "a1450000-0000-4000-8000-00000000c0de";
const MAIL_HOST = "https://mail.fake.example.test/emails";
const CREW_EMAIL = "newhire@crew.example.test";
/** The exact value the file's own runbook tells the owner to set. */
const RUNBOOK_MAIL_FROM = "FenceFlow <crew@fenceflowapp.com>";

const ENV = {};
function resetEnv(over = {}) {
  for (const k of Object.keys(ENV)) delete ENV[k];
  Object.assign(ENV, {
    SUPABASE_URL: "https://project.fake.example.test",
    SUPABASE_ANON_KEY: "a145-FAKE-anon-key",
    MAIL_API_KEY: "re_FAKE_a145_key",
    MAIL_FROM: RUNBOOK_MAIL_FROM,
    MAIL_API_URL: MAIL_HOST,
  }, over);
}

// ---------------------------------------------------------------- harness --

function load({ db, fetchImpl }) {
  let js = stripTypeScriptTypes(SRC);
  const importRe = /^import\s*(?:\{([\s\S]*?)\}|\w+)\s*from\s*"([^"]+)";?[ \t]*$/gm;
  const shared = {};
  for (const [, list, from] of js.matchAll(importRe)) {
    const names = (list ?? "").split(",").map((n) => n.trim().replace(/^type\s+/, "")).filter(Boolean);
    if (/supabase-js/.test(from)) assert.deepEqual(names, ["createClient"]);
    else {
      const mod = from === "../_shared/invite-crew-email.ts"
        ? inviteEmail
        : from === "../_shared/mail/mime-build.ts"
        ? mimeBuild
        : assert.fail(`an import the harness does not supply: ${from}`);
      for (const n of names) { assert.ok(n in mod, `no ${n} in ${from}`); shared[n] = mod[n]; }
    }
  }
  js = js.replace(importRe, "").replace(/^export /gm, "");
  assert.doesNotMatch(js, /^import /m);
  const names = Object.keys(shared);
  let handler = null;
  const Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
  new Function("Deno", "createClient", "fetch", ...names, js)(
    Deno, () => db, fetchImpl, ...names.map((n) => shared[n]),
  );
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

// --------------------------------------------------------------------- db --

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function fakeDb({ companyName = "Acme Fence & Deck", companyEmail = "office@acme.example.test" } = {}) {
  const t = {
    profiles: [{ id: UID, company_id: COMPANY, role: "OWNER", full_name: "Dana Lee" }],
    companies: [{ id: COMPANY, name: companyName, phone: "555-0100", email: companyEmail }],
    app_releases: [{ version_name: "1.400", version_code: 400, download_url: "https://dl.fake.example.test/app.apk" }],
  };
  class Query {
    constructor(table) { this.table = table; this.cols = "*"; this.filters = []; }
    select(cols = "*") { this.cols = cols; return this; }
    eq(k, v) { this.filters.push((r) => String(r[k]) === String(v)); return this; }
    order() { return this; }
    limit() { return this; }
    maybeSingle() { this.mode = "maybe"; return this.run(); }
    then(ok, bad) { return this.run().then(ok, bad); }
    async run() {
      const rows = t[this.table] ?? [];
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      const cols = String(this.cols).split(",").map((c) => c.trim()).filter(Boolean);
      const out = hit.map((r) => (cols.includes("*") ? clone(r) : Object.fromEntries(cols.map((c) => [c, clone(r[c]) ?? null]))));
      if (this.mode === "maybe") return { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    }
  }
  return {
    tables: t,
    auth: { getUser: async () => ({ data: { user: { id: UID } }, error: null }) },
    from: (table) => new Query(table),
    rpc: async (name) => {
      if (name === "company_allowed") return { data: true, error: null };
      if (name === "crew_join_code_for_invite") return { data: [{ join_code: JOIN_CODE, may_show: true }], error: null };
      if (name === "note_invite_send") return { data: 1, error: null };
      return { data: null, error: { code: "PGRST202", message: `no rpc ${name}` } };
    },
  };
}

/** A model mail provider, and a wall for everything else. */
function fakeMail() {
  const sent = [];
  const refused = [];
  return {
    sent,
    refused,
    fetchImpl: async (url, init = {}) => {
      const u = String(url);
      if (u === MAIL_HOST) {
        sent.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ id: `prov_${sent.length}` }), { status: 200 });
      }
      refused.push(u);
      throw new Error(`REFUSED by the a145 harness: ${u}`);
    },
  };
}

async function invite({ db, mail, body = { name: "New Hire", email: CREW_EMAIL } } = {}) {
  const handler = load({ db, fetchImpl: mail.fetchImpl });
  const res = await handler(new Request("https://fn.test/invite-crew", {
    method: "POST",
    headers: { authorization: "Bearer a145-FAKE-jwt", "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

// ======================================================================= ==

test("with MAIL_FROM exactly as the runbook says, the letter is FROM the business -- on the platform's own address", async () => {
  resetEnv();
  const mail = fakeMail();
  const db = fakeDb();
  const r = await invite({ db, mail });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { sent: true, to: CREW_EMAIL });
  assert.deepEqual(mail.refused, [], "the harness refused a request that would have left the process");
  assert.equal(mail.sent.length, 1);

  const from = mail.sent[0].from;
  // The whole defect, stated as a value: the old code sent RUNBOOK_MAIL_FROM
  // back unchanged, so the crew member saw "FenceFlow" and not their employer.
  assert.notEqual(from, RUNBOOK_MAIL_FROM, "the sender is still the bare MAIL_FROM: the business name was dropped");
  assert.equal(from, '"Acme Fence & Deck" <crew@fenceflowapp.com>');
  // And it says the same thing the shared helper every other mail path uses says.
  const canonical = mimeBuild.fenceflowFrom("Acme Fence & Deck", RUNBOOK_MAIL_FROM);
  assert.equal(from, `"${canonical.name}" <${canonical.address}>`);
  // The address is still the verified one -- the name changed, not the domain.
  assert.match(from, /<crew@fenceflowapp\.com>$/);
  // Replies still go to the company, as before.
  assert.equal(mail.sent[0].reply_to, "office@acme.example.test");
  // And the team code is in the letter, never in the response or the sender line.
  assert.ok(mail.sent[0].text.includes(JOIN_CODE));
  assert.ok(!from.includes(JOIN_CODE));
});

test("a bare MAIL_FROM gets the same sender line: one rule, not two", async () => {
  resetEnv({ MAIL_FROM: "crew@fenceflowapp.com" });
  const mail = fakeMail();
  const r = await invite({ db: fakeDb(), mail });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(mail.sent[0].from, '"Acme Fence & Deck" <crew@fenceflowapp.com>');
});

test("a company name that could forge a header cannot: no CR, LF, quote, backslash or angle bracket survives", async () => {
  resetEnv();
  const mail = fakeMail();
  const r = await invite({
    db: fakeDb({ companyName: 'Evil"\r\nBcc: victim@elsewhere.example.test <spoof@evil.example.test>' }),
    mail,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const from = mail.sent[0].from;
  assert.doesNotMatch(from, /[\r\n\\]/, "a line break or backslash in the sender line");
  // Exactly one quoted display name, and exactly one angle-bracketed address:
  // ours. The planted text survives INSIDE the quoted name (it is a name, and
  // reads as a strange one), which is harmless -- what it may not do is become
  // a second address or a second header line.
  assert.equal([...from].filter((c) => c === '"').length, 2, from);
  assert.match(from, /^"[^"]*" <crew@fenceflowapp\.com>$/, from);
  assert.deepEqual(from.match(/<[^>]*>/g), ["<crew@fenceflowapp.com>"], from);
  assert.doesNotMatch(from, /Bcc:\s*victim@elsewhere\.example\.test\s*$/i, "a Bcc that reads as a header continuation");
});

test("no company name falls back to MAIL_FROM_NAME, then to FenceFlow -- never to a nameless address", async () => {
  for (const [over, expected] of [
    [{ MAIL_FROM_NAME: "FenceFlow Crew" }, '"FenceFlow Crew" <crew@fenceflowapp.com>'],
    [{}, '"FenceFlow" <crew@fenceflowapp.com>'],
  ]) {
    resetEnv(over);
    const mail = fakeMail();
    const r = await invite({ db: fakeDb({ companyName: "   " }), mail });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(mail.sent[0].from, expected, JSON.stringify(over));
  }
});

test("a MAIL_FROM that is not an address is 'not set up yet', not a letter handed to the provider to refuse", async () => {
  resetEnv({ MAIL_FROM: "not an address" });
  const mail = fakeMail();
  const r = await invite({ db: fakeDb(), mail });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.match(r.body.error, /not set up yet/i);
  // The owner may be shown the code, so they are handed it to pass on by hand.
  assert.equal(r.body.code, JOIN_CODE);
  assert.deepEqual(mail.sent, [], "nothing may be handed to the provider");
  assert.deepEqual(mail.refused, []);
});
