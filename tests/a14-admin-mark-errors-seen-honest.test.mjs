// DEFECT 1 (this wave) -- admin.html's Crashes panel has a "Mark seen" button
// that calls the RPC admin_mark_errors_seen(msg, wh). Read live from pg_proc
// (2026-09-28), that function is:
//
//   returns void
//   language sql security definer set search_path to 'public'
//   as $$
//       update app_errors
//          set seen = true
//        where is_platform_admin()
//          and message = msg
//          and where_at = wh;
//   $$;
//
// The platform-admin check sits INSIDE the UPDATE's WHERE clause, not as a
// raised exception, and the function RETURNS VOID. So a caller who fails that
// check -- most concretely, an admin whose second factor has gone stale on
// the SERVER in the window between this page's own secondFactorFresh() last
// checking and the RPC actually landing, the same race
// tests/a10-admin-save-zero-rows.test.mjs documents for saveEdit() -- gets
// back { error: null } with zero rows changed: indistinguishable from a real
// success to a caller that only checks `{ error }`. This is not a security
// hole (nobody who fails the gate can mark a row seen); it is a button that
// lies about having worked.
//
// supabase_admin_mark_errors_seen_fix.sql (additive, UNAPPLIED) brings this
// function into the same shape as every other admin_* RPC in this database
// (admin_suspend, admin_unsuspend, admin_promote_release, admin_create_company):
// a plpgsql body that raises when the caller is not a platform admin, instead
// of matching zero rows silently. Until that file is run, the live function is
// untouched and this suite still passes -- it is written to hold BOTH before
// and after that SQL lands, per the file's own "page behaviour" comment.
//
// What actually needed a CODE change, independent of the SQL file: the
// multi-row loop in markCrashGroupSeen() used to set $('msg') to the RPC's
// error and only then `await loadAll()` -- but loadAll() overwrites $('msg')
// with its own loading/success text the moment it runs, so the very message
// this branch exists to show got erased before anyone could read it. Once the
// SQL half raises for real, that ordering bug would have kept the button
// silent in a NEW way even though the underlying refusal was by then correctly
// signalled. This file's first section proves the shipped ordering (reload,
// THEN report) actually surfaces the message; its PLANTED FAILURE section
// proves the OLD ordering (report, then reload) would not have, so this check
// has teeth (see MEMORY.md "Audit blind spots").
//
// DEFECT 2 (this wave) -- website/dashboard.html cited
// tests/a12-dash-settings-email-zero-rows.test.mjs, a file that does not
// exist; the real file covering that fix is
// tests/a12-dash-zero-row-writes.test.mjs. Fixed in this wave. This file's
// second section is a general regression guard: every tests/*.mjs path named
// in a comment in either website/admin.html or website/dashboard.html must
// exist on disk, so a rename or a typo like that one fails here in seconds
// instead of teaching the next reader that a covered area is untested.
//
// Same grab()/new Function() idiom as tests/a10-admin-save-zero-rows.test.mjs,
// tests/a12-admin-drift-mark-seen-zero-rows.test.mjs and
// tests/a8-company-email-guard.test.mjs: section 1 runs the REAL
// markCrashGroupSeen() lifted out of website/admin.html, not a reimplementation
// that could silently drift from what ships.
//
// Run:
//   node tests/a14-admin-mark-errors-seen-honest.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const adminSrc = readFileSync("website/admin.html", "utf8");
const dashSrc = readFileSync("website/dashboard.html", "utf8");

// Brace-counted function extraction, identical to tests/a10-admin-save-zero-rows
// .test.mjs's makeGrab() and tests/a12-admin-drift-mark-seen-zero-rows.test.mjs's.
function makeGrab(src) {
  return (name) => {
    let start = src.indexOf("function " + name + "(");
    if (start < 0) throw new Error("not found: " + name + " in this file");
    if (src.slice(start - 6, start) === "async ") start -= 6;
    let i = src.indexOf("{", src.indexOf(")", start)), depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
    }
    throw new Error("unbalanced: " + name);
  };
}
const adminGrab = makeGrab(adminSrc);

// =============================================================================
// Section 1 -- markCrashGroupSeen()'s multi-row loop actually surfaces a
// refusal instead of losing it to the reload that follows.
// =============================================================================

// Builds a runnable markCrashGroupSeen() from whatever source string is
// passed in (the real, current one by default -- the PLANTED FAILURE test
// below passes the pre-fix text instead). adminAction is stubbed out: the
// open.length <= 1 branch that calls it is not what this defect is about
// (that path already skips the reload on error) -- see
// tests/a10-admin-save-zero-rows.test.mjs for adminAction's own coverage.
function buildMarkSeen(fnSrc, { rpcResults }) {
  const els = { msg: { textContent: "" } };
  const $ = (id) => els[id] || (els[id] = { textContent: "" });
  const tr = (key, ...args) => key + (args.length ? "|" + args.join("|") : "");
  const secondFactorFresh = async () => true;
  const adminAction = async () => { throw new Error("adminAction should not be called for a multi-row group"); };
  let call = 0;
  const rpcCalls = [];
  const db = {
    rpc: async (fn, args) => {
      rpcCalls.push({ fn, args });
      return rpcResults[call++];
    },
  };
  const loadAllCalls = { count: 0 };
  const loadAll = async () => {
    loadAllCalls.count++;
    // Mirrors the real loadAll() (website/admin.html): the very first thing
    // it does is stomp $('msg') with its own loading text, and a normal run
    // ends by clearing it to '' -- exactly what makes the ORDER of the
    // error-message assignment in markCrashGroupSeen() matter.
    $("msg").textContent = tr("companiesLoading");
    $("msg").textContent = "";
  };
  const markCrashGroupSeen = new Function(
    "adminAction", "secondFactorFresh", "tr", "$", "db", "loadAll",
    fnSrc + "\nreturn markCrashGroupSeen;"
  )(adminAction, secondFactorFresh, tr, $, db, loadAll);
  return { markCrashGroupSeen, $, rpcCalls, loadAllCalls };
}

function fakeBtn() {
  return { disabled: false, textContent: "" };
}

const twoMemberGroup = {
  members: [
    { message: "Cannot read properties of undefined", where_at: "JobDetail", any_unseen: true },
    { message: "Cannot read properties of undefined", where_at: "JobsList", any_unseen: true },
  ],
};

test("a real multi-row success marks every member and reloads", async () => {
  const btn = fakeBtn();
  const { markCrashGroupSeen, $, rpcCalls, loadAllCalls } = buildMarkSeen(adminGrab("markCrashGroupSeen"), {
    rpcResults: [{ error: null }, { error: null }],
  });
  const ok = await markCrashGroupSeen(twoMemberGroup, btn);
  assert.equal(ok, true);
  assert.equal(rpcCalls.length, 2, "both open members must be sent to admin_mark_errors_seen");
  assert.equal(loadAllCalls.count, 1);
  assert.equal($("msg").textContent, "", "a real success must not leave a stale message behind");
});

test("DEFECT: a refusal partway through the group is reported, not erased by the reload", async () => {
  const btn = fakeBtn();
  const refusal = { message: "Only a FenceFlow admin may mark errors seen." };
  const { markCrashGroupSeen, $, rpcCalls, loadAllCalls } = buildMarkSeen(adminGrab("markCrashGroupSeen"), {
    // First member succeeds (already-marked before the second factor lapsed
    // mid-batch), second is refused -- exactly the shape
    // supabase_admin_mark_errors_seen_fix.sql produces once applied.
    rpcResults: [{ error: null }, { error: refusal }],
  });
  const ok = await markCrashGroupSeen(twoMemberGroup, btn);
  assert.equal(ok, false);
  assert.equal(rpcCalls.length, 2, "the loop must stop AT the failing member, not run past it");
  assert.equal(loadAllCalls.count, 1, "still reloads once, so any member marked before the failure shows as handled");
  assert.equal(
    $("msg").textContent, refusal.message,
    "the refusal must be the message left on screen -- not '' and not loadAll()'s own loading text"
  );
  assert.equal(btn.disabled, false, "the button must be re-enabled so the admin can retry");
  assert.equal(btn.textContent, "crashMarkSeen", "the button label must be restored, not left saying 'working…'");
});

// =============================================================================
// PLANTED FAILURE -- proves section 1 would have caught the pre-fix ordering
// =============================================================================

test("PLANTED FAILURE: reporting the error BEFORE reloading loses it to loadAll()'s own status text", async () => {
  // Exactly what this file carried before this wave's fix (website/admin.html,
  // markCrashGroupSeen()): the error was written to $('msg') and only THEN did
  // the code await loadAll() -- which immediately overwrites $('msg') with its
  // own "loading" text and can leave it at '' when it resolves, wiping the
  // refusal before anyone could read it.
  const old = `async function markCrashGroupSeen(g, btn) {
  const open = g.members.filter(m => m.any_unseen);
  if (open.length <= 1) {
    const m = open[0] || g.members[0];
    return adminAction('admin_mark_errors_seen', { msg: m.message, wh: m.where_at }, null, btn);
  }
  if (!(await secondFactorFresh())) return false;
  btn.disabled = true; btn.textContent = tr('workingEllipsis');
  $('msg').textContent = tr('workingEllipsis');
  for (const m of open) {
    const { error } = await db.rpc('admin_mark_errors_seen', { msg: m.message, wh: m.where_at });
    if (error) {
      $('msg').textContent = error.message;
      btn.disabled = false; btn.textContent = tr('crashMarkSeen');
      await loadAll();
      return false;
    }
  }
  $('msg').textContent = '';
  await loadAll();
  return true;
}`;
  const real = adminGrab("markCrashGroupSeen");
  assert.notEqual(old.replace(/\s+/g, " "), real.replace(/\s+/g, " "), "the plant must actually differ from the shipped function");

  const btn = fakeBtn();
  const refusal = { message: "Only a FenceFlow admin may mark errors seen." };
  const { markCrashGroupSeen, $ } = buildMarkSeen(old, {
    rpcResults: [{ error: null }, { error: refusal }],
  });
  await markCrashGroupSeen(twoMemberGroup, btn);
  assert.notEqual(
    $("msg").textContent, refusal.message,
    "the pre-fix ordering loses the refusal to loadAll()'s own status text -- this is the bug this wave fixed"
  );
});

// =============================================================================
// Section 2 -- no comment in either page cites a test file that does not exist
// =============================================================================

test("DEFECT: dashboard.html no longer cites the nonexistent a12-dash-settings-email-zero-rows.test.mjs", () => {
  assert.doesNotMatch(dashSrc, /a12-dash-settings-email-zero-rows/);
  assert.match(dashSrc, /tests\/a12-dash-zero-row-writes\.test\.mjs/, "the real file must be named instead");
});

test("every tests/*.mjs path named in a comment in admin.html or dashboard.html exists on disk", () => {
  const missing = [];
  for (const [page, src] of [["admin.html", adminSrc], ["dashboard.html", dashSrc]]) {
    for (const m of src.matchAll(/tests\/[A-Za-z0-9._-]+\.mjs/g)) {
      const path = m[0].replace(/\.$/, "");
      if (!existsSync(path)) missing.push(`${page} -> ${path}`);
    }
  }
  assert.deepEqual(missing, [], "a comment pointing at a missing test file teaches the next reader the area is untested when it may not be");
});

test("PLANTED FAILURE: the check above catches a dangling reference", () => {
  const missing = [];
  const planted = dashSrc.replace(
    "tests/a12-dash-zero-row-writes.test.mjs",
    "tests/a12-dash-settings-email-zero-rows.test.mjs"
  );
  assert.notEqual(planted, dashSrc, "the plant must actually differ from the shipped page");
  for (const m of planted.matchAll(/tests\/[A-Za-z0-9._-]+\.mjs/g)) {
    const path = m[0].replace(/\.$/, "");
    if (!existsSync(path)) missing.push(path);
  }
  assert.ok(missing.length > 0, "the dangling reference this wave fixed must be caught by the same sweep");
});
