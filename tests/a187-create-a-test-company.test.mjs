/* a187: the admin portal can MAKE a sandbox, and cannot make one by accident.
 *
 * Owner list E2 asked for "a TEST product key that unlocks the test data, and
 * a REAL one -- a sandbox and the live app -- both controlled from the admin
 * portal." Asked which half he wanted, flipping an existing company or making
 * a new one, March said CREATE (21 Nov 2026). That is the safe half: creating
 * a company that is born sandboxed cannot endanger a real one, while flipping
 * an existing one is the misclick r64's comment is about.
 *
 * THE ONE THE PROBE CAUGHT, and the reason this file watches the SQL as well
 * as the page: company_settings carries the company's identity in its blob
 * (business_name, phone, license_number, email) and
 * company_settings_mirror_identity pushes all four into companies.* on every
 * write. r64's sandbox_refresh_from copied the whole blob, so the first run
 * of the probe produced a sandbox called "Legacy Solutions", wearing that
 * company's phone, licence and email -- indistinguishable from the real
 * business in every list, which is the precise thing r64 exists to prevent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const admin = readFileSync("website/admin.html", "utf8");
const sql = readFileSync("supabase_e2_create_test_company.sql", "utf8");

const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, "");
const stripJsComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
const stripSqlComments = (s) => s.replace(/^\s*--[^\n]*$/gm, "");

const code = stripJsComments(stripHtmlComments(admin));

const grabFn = (src, name) => {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("not found: " + name);
  let depth = 0;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
};

// ------------------------------------------------- a separate door, not a tick

test("the test door is its own button, and the live create form grew no checkbox", () => {
  assert.match(code, /id="newTestCreate"/, "there is no button to create a test company");
  const liveForm = code.slice(code.indexOf('id="newName"'), code.indexOf('id="newTestWrap"'));
  assert.equal(/type="checkbox"/.test(liveForm), false,
    "a tick on the live form is how a paying contractor gets a company that can never hold a mailbox");
});

test("the two doors do not share a handler", () => {
  assert.match(code, /\$\('newCreate'\)\.addEventListener\('click', submitNewCompany\)/);
  assert.match(code, /\$\('newTestCreate'\)\.addEventListener\('click', submitNewTestCompany\)/);
});

test("the test door calls the test RPC, by the argument names the function declares", () => {
  const fn = grabFn(code, "submitNewTestCompany");
  assert.match(fn, /db\.rpc\('admin_create_test_company', \{\s*company_name: name, copy_catalog_from: source\s*\}\)/);
  assert.match(sql, /create or replace function public\.admin_create_test_company\(\s*company_name text,\s*copy_catalog_from uuid default null\s*\)/,
    "the page's argument names must be the function's, or PostgREST cannot find it");
});

test("it asks for the second factor, and never sends an invitation", () => {
  const fn = grabFn(code, "submitNewTestCompany");
  assert.match(fn, /if \(!\(await secondFactorFresh\(\)\)\) return;/,
    "creating a company is a platform-admin action on both doors");
  assert.equal(/invite-company/.test(fn), false,
    "a sandbox has no business reaching a real inbox; the setup code IS the key");
  assert.match(fn, /if \(!name\)/, "a company still needs a name");
});

test("the live door is untouched: same RPC, still able to invite", () => {
  const fn = grabFn(code, "submitNewCompany");
  assert.match(fn, /db\.rpc\('admin_create_company'/);
  assert.match(fn, /invite-company/);
});

// ------------------------------------------------- the source list, run for real

/** fillTestSourceOptions, lifted out and driven against a fake list. */
function sourceOptions(clients) {
  const els = { newTestSource: { innerHTML: "" } };
  new Function("$", "esc", "tr", "clients",
    grabFn(code, "fillTestSourceOptions") + "\nreturn fillTestSourceOptions;")(
    (id) => els[id],
    (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
    (k) => k,
    clients,
  )();
  return els.newTestSource.innerHTML;
}

test("only LIVE companies are offered as a source", () => {
  // sandbox_refresh_from refuses a sandbox source, so offering one would be a
  // control that can only ever fail -- the fake control this project keeps
  // writing rules against.
  const html = sourceOptions([
    { id: "live-1", name: "Legacy Solutions" },
    { id: "sand-1", name: "ZZ TEST — Busy season", is_sandbox: true },
    { id: "live-2", name: "Coastal Fence" },
  ]);
  assert.match(html, /value="live-1"/);
  assert.match(html, /value="live-2"/);
  assert.equal(/sand-1/.test(html), false, "a sandbox was offered as a source");
  assert.match(html, /<option value="">/, "there must be a way to start one empty");
});

test("a company name is escaped, never interpreted as markup", () => {
  const html = sourceOptions([{ id: "x", name: '<img src=x onerror=alert(1)>' }]);
  assert.equal(/<img/.test(html), false, "a typed name reached the page as a tag");
});

test("a nameless row is left out rather than drawn as a blank line", () => {
  assert.equal(/value="ghost"/.test(sourceOptions([{ id: "ghost", name: "" }])), false);
});

// ---------------------------------------------------------- the SQL contract

test("the copy strips the four identity keys the mirror pushes into companies", () => {
  const body = stripSqlComments(sql);
  const fn = body.slice(body.indexOf("create or replace function public.sandbox_refresh_from"));
  const insert = fn.slice(fn.indexOf("insert into public.company_settings"));
  for (const key of ["business_name", "phone", "license_number", "email"]) {
    assert.match(insert, new RegExp("- '" + key + "'"),
      key + " is still copied, so the sandbox takes the live company's " + key);
  }
});

test("PLANTED: leave one key in and this file says which", () => {
  const body = stripSqlComments(sql).replace("- 'business_name'", "");
  const fn = body.slice(body.indexOf("create or replace function public.sandbox_refresh_from"));
  const insert = fn.slice(fn.indexOf("insert into public.company_settings"));
  assert.equal(/- 'business_name'/.test(insert), false,
    "the planted edit did not apply, so the check above proves nothing");
});

test("the function refuses to finish unless the row ends up stamped AND flagged", () => {
  // Belt and braces, and it matters: the identity mirror runs on a write the
  // function itself makes, so the name can change after it is set. A sandbox
  // wearing a live company's name is worse than no sandbox.
  const body = stripSqlComments(sql);
  const fn = body.slice(body.indexOf("create or replace function public.admin_create_test_company"));
  assert.match(fn, /where c\.id = new_id and c\.name like 'ZZ TEST %' and c\.is_sandbox/);
  assert.match(fn, /raise exception[\s\S]{0,200}nothing was created/);
  // And the check must come AFTER the copy, or it reads a name that has not
  // been through the mirror yet.
  assert.ok(fn.indexOf("sandbox_refresh_from") < fn.indexOf("ZZ TEST %"),
    "the post-condition is checked before the copy that can break it");
});

test("the new door is shut to anon and the old one stays shut to the office", () => {
  assert.match(sql, /revoke execute on function public\.admin_create_test_company\(text, uuid\) from public, anon;/);
  assert.match(sql, /grant {2}execute on function public\.admin_create_test_company\(text, uuid\) to authenticated;/);
  assert.match(sql, /revoke execute on function public\.sandbox_refresh_from\(uuid, uuid\) from public, anon, authenticated;/,
    "the office must not be able to copy into a sandbox directly");
});

// ------------------------------------------------------------------ the words

test("every new string exists in all three dictionaries", () => {
  for (const key of ["newTestSummary", "newTestHint", "newTestSourceLabel",
    "newTestSourceNone", "newTestCreateBtn", "newTestNoCode"]) {
    const n = (admin.match(new RegExp("^\\s*" + key + ":", "gm")) ?? []).length;
    assert.equal(n, 3, key + " appears in " + n + " of the 3 dictionaries");
  }
});
