// A131 -- invite-company must ask is_platform_admin() AS THE CALLER, so the
// admin's second factor is actually in the way, and must record the
// invitation as the caller too, so the database checks the row it writes.
//
// WHAT WAS WRONG. The function read the profiles column with the SERVICE
// ROLE and gated on it:
//
//     admin.from("profiles").select("is_platform_admin").eq("id", user.id)
//
// Live, that column is one third of the gate. is_platform_admin() in the
// database (read out of pg_proc, not out of any .sql file in this repo) is:
//
//     flag AND lower(u.email) = lower('marchenry73@gmail.com')
//               AND public.admin_second_factor_ok()
//
// and admin_second_factor_ok() is true only when the account has no verified
// MFA factor at all, or the session is aal2. The owner's account HAS a
// verified factor -- one row in auth.mfa_factors with status 'verified',
// owned by the one profile carrying the flag -- so the factor is not
// vacuously true for him: it wants aal2. Reading the column skipped the
// address lock and the second factor both, and the only thing left asking
// for the factor was admin.html's secondFactorFresh(), which is a prompt in
// a browser and so not a gate at all.
//
// The second half of the same defect: admin_mark_invited was called with the
// service-role client, which has no auth.uid(), so the function took its
// `if auth.uid() is null then if not is_service_role() then raise` branch --
// verifying nothing -- and then ran
//
//     update companies set invited_at = now(), invited_email = ...,
//            email = coalesce(to_email, email) where id = target
//
// for whatever id it was handed. Eleven companies live.
//
// This runs the REAL invite-company function file, not a copy of its rules --
// same harness recipe as tests/a128-stripe-webhook-dual-signing-secret.test.mjs.
// The model database below reproduces the LIVE bodies of is_platform_admin(),
// admin_second_factor_ok() and admin_mark_invited(), and records which branch
// of admin_mark_invited each call took, so "asked as the caller" is proved by
// the branch the database would have run and not by reading the source.
//
// CANARY RESULTS are at the foot of this file.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const FN_PATH = new URL("../supabase/functions/invite-company/index.ts", import.meta.url);
const SRC = readFileSync(FN_PATH, "utf8");

const OWNER_EMAIL = "marchenry73@gmail.com";
const OWNER_ID = "a0000000-0000-4000-8000-00000000000a";
const IMPOSTOR_ID = "b0000000-0000-4000-8000-00000000000b";
const CREW_ID = "c0000000-0000-4000-8000-00000000000c";
const COMPANY = "11111111-2222-4333-8444-555555555555";
const OTHER_COMPANY = "99999999-8888-4777-8666-555555555555";

const env = {
  SUPABASE_URL: "https://project.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
  SUPABASE_ANON_KEY: "anon-placeholder",
  // The provider path: one outgoing call, to the mail API, which the harness
  // intercepts. Chosen over Supabase's own mailer because it is the path the
  // live deployment takes and because it makes "did anything get sent?"
  // answerable.
  MAIL_API_KEY: "mail-key-placeholder",
  MAIL_FROM: "marc@fenceflowapp.com",
  SITE_URL: "https://fenceflowapp.com",
};

// ---------------------------------------------------------------- the world --

/**
 * The accounts, as auth and profiles hold them, plus the session's aal.
 *
 * `verifiedFactor` is a row in auth.mfa_factors with status 'verified' --
 * live, the owner has exactly one. `aal` is what the session/claim says.
 */
function world({ caller, aal = "aal1", verifiedFactor = true, markFails = null } = {}) {
  const accounts = {
    [OWNER_ID]: { email: OWNER_EMAIL, is_platform_admin: true, company_id: null },
    // The flag alone, on an address that is not the owner's. The address lock
    // exists because the flag is a column somebody could be given.
    [IMPOSTOR_ID]: { email: "someone.else@example.com", is_platform_admin: true, company_id: null },
    [CREW_ID]: { email: "crew@example.com", is_platform_admin: false, company_id: OTHER_COMPANY },
  };
  const companies = {
    [COMPANY]: { id: COMPANY, email: "contact@acme.test", invited_at: null, invited_email: null },
    [OTHER_COMPANY]: { id: OTHER_COMPANY, email: "owner@other.test", invited_at: null, invited_email: null },
  };
  return { accounts, companies, caller, aal, verifiedFactor, markFails, marks: [], mail: [], stamped: [] };
}

/** The LIVE body of admin_second_factor_ok(), in JavaScript. */
const secondFactorOk = (w) => (!w.verifiedFactor) || w.aal === "aal2";

/** The LIVE body of is_platform_admin(), in JavaScript. auth.uid() is the
 * caller, so with no caller it is false -- which is the whole point. */
function isPlatformAdmin(w) {
  if (!w.caller) return false;
  const a = w.accounts[w.caller];
  if (!a) return false;
  return a.is_platform_admin === true
    && String(a.email).toLowerCase() === OWNER_EMAIL
    && secondFactorOk(w);
}

/**
 * The two Supabase clients the function builds, told apart the way PostgREST
 * tells them apart: by whether a caller's Authorization header rides on the
 * request. A client built with the service key and NO such header is the
 * service role, and auth.uid() is null for it.
 */
function makeCreateClient(w) {
  return function createClient(url, key, opts) {
    const asCaller = Boolean(opts?.global?.headers?.Authorization);
    const role = asCaller ? "authenticated" : "service_role";

    const rpc = async (name, args) => {
      if (name === "is_platform_admin") {
        // SECURITY DEFINER, but auth.uid() comes from the request's claims,
        // so for the service role there is no user and it is false.
        const uid = asCaller ? w.caller : null;
        const saved = w.caller;
        w.caller = uid;
        const out = isPlatformAdmin(w);
        w.caller = saved;
        return { data: out, error: null };
      }
      if (name === "admin_mark_invited") {
        if (w.markFails) {
          w.marks.push({ branch: "errored", target: args?.target });
          return { data: null, error: { message: w.markFails } };
        }
        // The LIVE body, branch for branch.
        const uid = asCaller ? w.caller : null;
        let branch;
        if (uid == null) {
          if (role !== "service_role") {
            w.marks.push({ branch: "refused", target: args?.target });
            return { data: null, error: { message: "Only a FenceFlow admin may invite a company." } };
          }
          branch = "service_role_unchecked";
        } else {
          const saved = w.caller;
          w.caller = uid;
          const ok = isPlatformAdmin(w);
          w.caller = saved;
          if (!ok) {
            w.marks.push({ branch: "refused_not_admin", target: args?.target });
            return { data: null, error: { message: "Only a FenceFlow admin may invite a company." } };
          }
          branch = "caller_is_platform_admin";
        }
        const to = String(args?.to_email ?? "").trim();
        const row = w.companies[args?.target];
        if (row) {
          row.invited_at = "now";
          row.invited_email = to || null;
          row.email = to || row.email;
        }
        w.marks.push({ branch, target: args?.target, to_email: to });
        return { data: null, error: null };
      }
      throw new Error("unexpected rpc: " + name);
    };

    const from = (table) => {
      const q = {
        _col: null,
        select(cols) { this._col = cols; return this; },
        eq(k, v) { this._k = k; this._v = v; return this; },
        async single() { return this._run(); },
        async maybeSingle() { return this._run(); },
        _run() {
          if (table === "profiles") {
            const a = w.accounts[this._v];
            if (!a) return { data: null, error: { message: "no row" } };
            return { data: { is_platform_admin: a.is_platform_admin, company_id: a.company_id }, error: null };
          }
          throw new Error("unexpected table: " + table);
        },
      };
      return q;
    };

    return {
      rpc,
      from,
      auth: {
        // Modelled although the fixed function does not call it: the gate it
        // replaced did, and a harness that cannot run the old shape cannot
        // prove the new one catches anything. The canary at the foot of this
        // file restores that shape verbatim and this is what it leans on.
        async getUser(jwt) {
          const id = jwt === "caller-jwt" ? w.caller : null;
          return { data: { user: id ? { id, email: w.accounts[id]?.email } : null }, error: null };
        },
        admin: {
          async generateLink(opts2) {
            if (opts2.type === "invite") {
              return {
                data: {
                  properties: {
                    action_link: "https://project.test/auth/v1/verify?token=tok&redirect_to=" +
                      encodeURIComponent(String(opts2.options?.redirectTo ?? "")),
                    redirect_to: opts2.options?.redirectTo ?? null,
                    verification_type: "signup",
                  },
                  user: { id: OWNER_ID, user_metadata: {} },
                },
                error: null,
              };
            }
            throw new Error("unexpected generateLink type: " + opts2.type);
          },
          async updateUserById(id, patch) {
            w.stamped.push({ id, patch });
            return { data: null, error: null };
          },
        },
      },
    };
  };
}

// ---------------------------------------------------------------- harness --

function load(w) {
  let js = stripTypeScriptTypes(SRC);
  const importRe = /^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";?[ \t]*$/gm;
  for (const [, list, from] of js.matchAll(importRe)) {
    const names = list.split(",").map((n) => n.trim()).filter(Boolean);
    assert.match(from, /supabase-js/, `an import the harness does not supply: ${from}`);
    assert.deepEqual(names, ["createClient"]);
  }
  js = js.replace(importRe, "").replace(/^export /gm, "");
  assert.doesNotMatch(js, /^import /m);

  let handler = null;
  const Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith("https://api.resend.com/emails")) {
      w.mail.push({ body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ id: "mail_1" }), { status: 200 });
    }
    throw new Error("unexpected fetch: " + url);
  };
  // Silence the function's own JSON logging.
  const console_ = { log: () => {} };
  new Function("Deno", "createClient", "fetch", "console", js)(
    Deno, makeCreateClient(w), fetchImpl, console_,
  );
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

async function invite(w, { token = "caller-jwt", companyId = COMPANY, email = "new@acme.test" } = {}) {
  const handler = load(w);
  const res = await handler(new Request("https://fn.test/invite-company", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ companyId, email, companyName: "Acme Fencing" }),
  }));
  return { status: res.status, body: await res.json() };
}

// ====================================================== 1. the gate itself ==

test("POSITIVE CONTROL -- the owner, aal2, is let through and the invitation really goes", async () => {
  const w = world({ caller: OWNER_ID, aal: "aal2" });
  const r = await invite(w);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sent, true);
  assert.equal(w.mail.length, 1, "the mail provider must have been called exactly once");
  assert.equal(w.mail[0].body.to[0], "new@acme.test");
  assert.equal(w.companies[COMPANY].invited_at, "now", "the invitation must be recorded");
});

test("THE DEFECT -- the owner with the flag and the right address but NO fresh second factor is refused", async () => {
  // Exactly the live shape: a verified MFA factor is enrolled, the session is
  // aal1. The old code read profiles.is_platform_admin, which is true here,
  // and sent the invitation.
  const w = world({ caller: OWNER_ID, aal: "aal1", verifiedFactor: true });
  const r = await invite(w);
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.match(r.body.error, /second factor/i, "the refusal must say why");
  assert.equal(w.mail.length, 0, "nothing may be sent when the factor is not current");
  assert.equal(w.marks.length, 0, "no company row may be touched");
  assert.equal(w.companies[COMPANY].invited_at, null);
});

test("the address lock -- the raw flag on somebody else's account is not enough, even at aal2", async () => {
  const w = world({ caller: IMPOSTOR_ID, aal: "aal2" });
  assert.equal(w.accounts[IMPOSTOR_ID].is_platform_admin, true, "fixture check: the flag IS set");
  const r = await invite(w);
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(w.mail.length, 0);
  assert.equal(w.marks.length, 0);
});

test("an ordinary crew login is refused", async () => {
  const w = world({ caller: CREW_ID, aal: "aal2" });
  const r = await invite(w);
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(w.mail.length, 0);
});

test("no Authorization header at all is refused before anything is read", async () => {
  const w = world({ caller: OWNER_ID, aal: "aal2" });
  const r = await invite(w, { token: null });
  assert.equal(r.status, 401, JSON.stringify(r.body));
  assert.equal(w.mail.length, 0);
});

test("a token that belongs to nobody is refused -- auth.uid() null makes the gate false", async () => {
  const w = world({ caller: null, aal: "aal2" });
  const r = await invite(w);
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(w.mail.length, 0);
  assert.equal(w.marks.length, 0);
});

test("the account with no verified factor at all still gets in at aal1 -- the factor is not invented here", async () => {
  // admin_second_factor_ok() is deliberately true for an account with nothing
  // to ask. If this test ever fails, the gate has grown a rule the database
  // does not have.
  const w = world({ caller: OWNER_ID, aal: "aal1", verifiedFactor: false });
  const r = await invite(w);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(w.mail.length, 1);
});

// ======================================== 2. recording it, as the caller ====

test("admin_mark_invited takes its is_platform_admin branch, NOT the unchecked service-role one", async () => {
  const w = world({ caller: OWNER_ID, aal: "aal2" });
  const r = await invite(w);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const marks = w.marks.filter((m) => m.target === COMPANY);
  assert.equal(marks.length, 1, "recorded exactly once");
  assert.equal(
    marks[0].branch,
    "caller_is_platform_admin",
    "the write must be checked by the database. 'service_role_unchecked' means it was handed the " +
      "service-role client again, and that branch verifies nothing for ANY company id.",
  );
  assert.equal(w.companies[COMPANY].invited_email, "new@acme.test");
  assert.equal(w.companies[COMPANY].email, "new@acme.test", "live it also moves companies.email");
});

test("a company id the caller did not earn is still only reachable through a checked branch", async () => {
  // The function trusts its caller for the id -- it always did. What it must
  // not do is reach the branch that checks nothing: on the service-role
  // client, admin_mark_invited rewrites invited_at/invited_email/email for
  // any of the eleven live companies with no verification whatever.
  const w = world({ caller: OWNER_ID, aal: "aal2" });
  const r = await invite(w, { companyId: OTHER_COMPANY, email: "x@other.test" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(w.marks.length, 1);
  assert.equal(w.marks[0].branch, "caller_is_platform_admin");
});

test("if the recording is refused the admin is told, not shown a bare success", async () => {
  // The mail has already gone by the time admin_mark_invited runs, so a
  // failure there must be reported rather than turned into a 4xx -- and must
  // never be swallowed, which is how "Invitation sent" used to sit above a
  // company still reading "Not started".
  const w = world({ caller: OWNER_ID, aal: "aal2", markFails: "permission denied for function admin_mark_invited" });
  const r = await invite(w);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sent, true, "the mail did go, and saying otherwise would be a lie too");
  assert.match(r.body.warning ?? "", /recording it failed/i);
  assert.match(r.body.warning ?? "", /permission denied for function admin_mark_invited/);
  assert.equal(w.companies[COMPANY].invited_at, null, "and the row really was not written");
});

test("the same run with nothing failing carries no warning -- the warning means something", async () => {
  const w = world({ caller: OWNER_ID, aal: "aal2" });
  const r = await invite(w);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.warning, undefined);
});

// ============================================ 3. the shape, not the prose ===

/** The source with every comment removed, so a sentence in a comment can
 * never stand in for code. */
const codeOnly = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

test("the code gates on the RPC and no longer reads the raw profiles column for the gate", async () => {
  assert.match(
    codeOnly,
    /asCaller\s*\.\s*rpc\(\s*"is_platform_admin"\s*\)/,
    "the gate must be is_platform_admin() asked as the caller",
  );
  assert.doesNotMatch(
    codeOnly,
    /select\(\s*"is_platform_admin"\s*\)/,
    "gating on the raw profiles column skips the address lock and the second factor",
  );
  assert.match(
    codeOnly,
    /asCaller\s*\.\s*rpc\(\s*"admin_mark_invited"/,
    "the recording must be asked as the caller too, so the database checks the row it writes",
  );
  assert.doesNotMatch(
    codeOnly,
    /\badmin\s*\.\s*rpc\(\s*"admin_mark_invited"/,
    "the service-role client takes admin_mark_invited's unchecked branch",
  );
  // The caller client must carry the caller's own Authorization header, or
  // "as the caller" is a name and nothing else.
  assert.match(codeOnly, /global:\s*\{\s*headers:\s*\{\s*Authorization:\s*auth\s*\}\s*\}/);
});

// ------------------------------------------------------------- CANARIES ----
//
// Each was applied to supabase/functions/invite-company/index.ts, this file
// run, then the file restored from a copy taken before the canary and the
// restore verified byte for byte by sha256
// (bd738ebb0bfd612945be604fcff467f7f87156dad527d289acf31e6044ee4a47).
//
// CANARY 1 -- the old gate restored verbatim: admin.auth.getUser(jwt) and
//   admin.from("profiles").select("is_platform_admin").eq("id", user.id)
// in place of the RPC. RED, as it must be -- 8 pass, 4 fail:
//   not ok 2 - THE DEFECT -- the owner with the flag and the right address but NO fresh second factor is refused
//     {"sent":true,"to":"new@acme.test","via":"provider","path":"provider:invite","landing":"welcome", ...}
//     200 !== 403
//   not ok 3 - the address lock -- the raw flag on somebody else's account is not enough, even at aal2
//   not ok 6 - a token that belongs to nobody is refused -- auth.uid() null makes the gate false
//   not ok 12 - the code gates on the RPC and no longer reads the raw profiles column for the gate
// Tests 8 and 9 stayed green under this canary, because the recording was
// still asked as the caller: the two halves of the defect are caught apart.
//
// CANARY 2 -- only the recording reverted: asCaller.rpc("admin_mark_invited")
// changed back to admin.rpc(...). RED -- 9 pass, 3 fail:
//   not ok 8 - admin_mark_invited takes its is_platform_admin branch, NOT the unchecked service-role one
//     + 'service_role_unchecked'  - 'caller_is_platform_admin'
//   not ok 9 - a company id the caller did not earn is still only reachable through a checked branch
//   not ok 12 - the code gates on the RPC and no longer reads the raw profiles column for the gate
