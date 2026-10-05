// FIVE FOLDER BUTTONS THAT ALL SHOWED THE INBOX.
//
// The office grew a filing layer on 3-4 Oct 2026: star, archive, snooze,
// trash, drafts and labels. The sidebar rendered a button for each. The click
// handler then read:
//
//     mailView.folder = b.dataset.folder === 'sent' ? 'sent' : 'inbox';
//
// so every button except Sent collapsed to the inbox. Mail he archived,
// snoozed or trashed left the inbox and could not be found again, and Drafts
// was worse: loadMailThreads() branches to loadMailDrafts() on
// `mailView.folder === 'drafts'`, a value that line could never produce. The
// branch was unreachable, so drafts were saved and could not be opened.
//
// None of it was missing on the server. mail_list_threads2 has always taken
// inbox, sent, all, starred, snoozed, archived and trash. The office simply
// never asked.
//
// Two things need to stay true, and they pull against each other:
//   - the handler must pass the chosen folder through, and
//   - it must never pass one the server will reject, because
//     mail_list_threads2 raises 'Unknown folder' (SQLSTATE 22023) for anything
//     outside its set.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DASH = readFileSync(join(ROOT, "website/dashboard.html"), "utf8");
const SQL = readFileSync(join(ROOT, "supabase_m3_mail_list_threads2.sql"), "utf8");

// The handler body only -- a comment elsewhere describing folders must not be
// able to satisfy any of this.
const handler = (s) => {
  const i = s.indexOf("$('mailFolders').addEventListener('click'");
  return i < 0 ? "" : s.slice(i, s.indexOf("\n});", i));
};

// What the client offers, read from the buttons it actually renders.
const renderedFolders = (s) => {
  const out = new Set();
  for (const m of s.matchAll(/item\('([a-z]+)',\s*(?:''|ffId|a\.id)/g)) out.add(m[1]);
  return [...out].sort();
};

// What the server will accept, read from the function itself.
const serverFolders = (s) => {
  const m = s.match(/folder not in \(([^)]*)\)/);
  return m ? [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort() : [];
};

// What the client is willing to send, read from its allow-list.
const clientFolders = (s) => {
  const m = s.match(/const MAIL_FOLDERS = \[([^\]]*)\]/);
  return m ? [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort() : [];
};

test("the chosen folder reaches mailView, rather than collapsing to the inbox", () => {
  const h = handler(DASH);
  assert.ok(h, "could not find the mailFolders click handler");
  assert.ok(
    !/dataset\.folder === 'sent' \? 'sent' : 'inbox'/.test(h),
    "the handler still collapses every folder but Sent to the inbox");
  assert.match(h, /MAIL_FOLDERS\.includes\(/,
    "the handler should pass the chosen folder through, against an allow-list");
});

test("every button the office renders is one the office will send", () => {
  const rendered = renderedFolders(DASH);
  const allowed = clientFolders(DASH);
  assert.ok(rendered.length >= 6, `expected the filing buttons, found ${rendered}`);
  const unreachable = rendered.filter((f) => !allowed.includes(f));
  assert.deepEqual(unreachable, [],
    `these buttons render but the handler would refuse them: ${unreachable}`);
});

test("every folder the office sends to the rpc is one the rpc accepts", () => {
  const allowed = clientFolders(DASH);
  const server = serverFolders(SQL);
  assert.ok(server.includes("archived"), `read the server set wrong: ${server}`);
  // drafts never reaches the rpc: loadMailThreads serves it from the client
  // before the call. Anything else the client sends must be understood, or the
  // function raises 'Unknown folder' and the folder looks broken.
  const wouldRaise = allowed.filter((f) => f !== "drafts" && !server.includes(f));
  assert.deepEqual(wouldRaise, [],
    `these would make mail_list_threads2 raise 'Unknown folder': ${wouldRaise}`);
});

test("the drafts branch is reachable", () => {
  assert.ok(clientFolders(DASH).includes("drafts"),
    "'drafts' must be a value the handler can set, or loadMailDrafts() is dead code");
  assert.match(DASH, /mailView\.folder === 'drafts'/,
    "loadMailThreads should still serve drafts from the client");
});

test("TEETH: each check turns red when the old handler is put back", () => {
  const old = DASH.replace(
    "  const asked = b.dataset.folder || 'inbox';\n  mailView.folder = MAIL_FOLDERS.includes(asked) ? asked : 'inbox';",
    "  mailView.folder = b.dataset.folder === 'sent' ? 'sent' : 'inbox';");
  assert.notEqual(old, DASH, "the mutation changed nothing -- the anchor is stale");
  const h = handler(old);
  assert.ok(/dataset\.folder === 'sent'/.test(h) && !/MAIL_FOLDERS\.includes\(/.test(h),
    "the restored handler should look like the bug again");

  // And the allow-list check must fail if a folder is dropped from it.
  const narrowed = DASH.replace(
    /const MAIL_FOLDERS = \[[^\]]*\]/,
    "const MAIL_FOLDERS = ['inbox', 'sent']");
  assert.notEqual(narrowed, DASH, "could not narrow the allow-list");
  const unreachable = renderedFolders(narrowed).filter((f) => !clientFolders(narrowed).includes(f));
  assert.ok(unreachable.length >= 4,
    `narrowing the list should strand the filing buttons, stranded: ${unreachable}`);
});
