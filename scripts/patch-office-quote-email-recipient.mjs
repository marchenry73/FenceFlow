/**
 * Fix: the office emails a quote to an address it never saves, and the
 * automatic follow-up then mails the OLD one, with money in it.
 *
 * THE BUG. jobQuoteMailCompose() takes the recipient from the LIVE, UNSAVED
 * j_email input (jobMailTo -> parseAddressList($('j_email').value)). On a
 * confirmed send, markQuoteSentAfterEmail() writes quote_sent_at and status --
 * and never writes jobs.email. So: a job carries a typo'd address, he fixes it
 * in the field, clicks "Email the quote", it sends correctly, he closes the
 * sheet without saving. The database now says the quote was sent, while
 * jobs.email still holds the OLD address. send-follow-ups/index.ts:306 then
 * sends `to: [j.email]` -- selected on nothing but `email <> ''` -- and A73's
 * follow-up templates carry figures. The wrong person gets his customer's
 * money details, automatically, with no further tap from him.
 *
 * THE FIX, and why this shape. Store the addresses the quote was ACTUALLY sent
 * to. Not "refuse to send while the sheet is dirty": fixing a typo and sending
 * is a legitimate thing to do, the send already went to the right place, and
 * making him press Save first is friction that buys nothing. The defect is that
 * the database disagrees with what happened; so reconcile it. Afterwards
 * jobs.email names the people who received the quote, which is exactly who
 * send-follow-ups should be chasing.
 *
 * A list is preserved. parseAddressList splits on , ; and newlines, so
 * jobs.email can legitimately hold several contacts; whatever the message
 * actually went to is what gets stored, joined the same way.
 *
 * WHY A SCRIPT. website/dashboard.html is 30k lines and was being written by
 * another agent when this was found; a heredoc or a hand-edit at the wrong
 * moment loses somebody's work. This does exact, anchored string replacement,
 * refuses if an anchor is missing or already patched, and buffers every edit
 * before writing a single byte -- so a failed run changes nothing and a rerun
 * cannot double-apply.
 *
 * Usage:  node scripts/patch-office-quote-email-recipient.mjs
 *         node scripts/patch-office-quote-email-recipient.mjs --check
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FILE = resolve(ROOT, 'website/dashboard.html');
const CHECK = process.argv.includes('--check');

const src = readFileSync(FILE, 'utf8');

/* Every edit is described, then all are verified, then all are applied. A
   half-written patch is how a rerun doubles the survivors. */
const edits = [
  {
    what: 'remember what the message actually went to',
    find:
      "  if (!to.ok.length) return msg('mc_msg', tr('mailNeedRecipient'), 'err');\n",
    replace:
      "  if (!to.ok.length) return msg('mc_msg', tr('mailNeedRecipient'), 'err');\n" +
      "  // Kept on the compose so composeSent() can reconcile jobs.email with the\n" +
      "  // address the quote was ACTUALLY sent to. Set here rather than at the\n" +
      "  // send call: every refusal above returns before this line, so a stashed\n" +
      "  // list can only ever belong to an attempt that got past validation.\n" +
      "  c.sentTo = to.ok.slice();\n",
    doneWhen: 'c.sentTo = to.ok.slice();',
  },
  {
    what: 'pass it to the stamp',
    find: "  if (c.quoteSendFor) markQuoteSentAfterEmail(c.quoteSendFor);\n",
    replace: "  if (c.quoteSendFor) markQuoteSentAfterEmail(c.quoteSendFor, c.sentTo);\n",
    doneWhen: 'markQuoteSentAfterEmail(c.quoteSendFor, c.sentTo);',
  },
  {
    what: 'save the address the quote went to',
    find:
      "async function markQuoteSentAfterEmail(syncId){\n" +
      "  const j = (jobs || []).find(x => x && x.sync_id === syncId) || (openJob && openJob.sync_id === syncId ? openJob : null);\n" +
      "  const patch = {};\n" +
      "  if (!j || !j.quote_sent_at) patch.quote_sent_at = new Date().toISOString();\n" +
      "  if (j && j.status === 'DRAFT') patch.status = 'SENT';\n",
    replace:
      "async function markQuoteSentAfterEmail(syncId, sentTo){\n" +
      "  const j = (jobs || []).find(x => x && x.sync_id === syncId) || (openJob && openJob.sync_id === syncId ? openJob : null);\n" +
      "  const patch = {};\n" +
      "  if (!j || !j.quote_sent_at) patch.quote_sent_at = new Date().toISOString();\n" +
      "  if (j && j.status === 'DRAFT') patch.status = 'SENT';\n" +
      "  // The address the quote WENT to, stored, because the recipient came from\n" +
      "  // the live j_email input and nothing else writes it back. Without this a\n" +
      "  // corrected typo sends to the right person and leaves the wrong one on the\n" +
      "  // row -- and send-follow-ups mails that row automatically, with figures in\n" +
      "  // it, selecting on nothing but `email <> ''`.\n" +
      "  //\n" +
      "  // Compared as a SET, not as text: parseAddressList lowercases, trims,\n" +
      "  // de-duplicates and accepts , ; and newlines, so \"A@x.com, b@x.com\" and\n" +
      "  // \"b@x.com;a@x.com\" are the same recipients and must not look like a\n" +
      "  // change. Only a genuine difference is written.\n" +
      "  if (Array.isArray(sentTo) && sentTo.length) {\n" +
      "    const stored = parseAddressList((j && j.email) || '').ok;\n" +
      "    const same = stored.length === sentTo.length &&\n" +
      "      stored.every(a => sentTo.includes(a));\n" +
      "    if (!same) patch.email = sentTo.join(', ');\n" +
      "  }\n",
    doneWhen: 'async function markQuoteSentAfterEmail(syncId, sentTo){',
  },
];

/* ---- verify every anchor before touching anything ----------------------- */
const already = edits.filter(e => src.includes(e.doneWhen));
if (already.length === edits.length) {
  console.log('Already patched, all ' + edits.length + ' edits present. Nothing to do.');
  process.exit(0);
}
if (already.length) {
  console.error('REFUSING: ' + already.length + ' of ' + edits.length +
    ' edits are already present. A half-applied patch means somebody else edited this\n' +
    'file, or an earlier run died. Resolve by hand rather than letting a rerun double up:');
  for (const e of edits) console.error('  ' + (src.includes(e.doneWhen) ? 'DONE   ' : 'missing') + '  ' + e.what);
  process.exit(2);
}

const missing = edits.filter(e => !src.includes(e.find));
if (missing.length) {
  console.error('REFUSING: ' + missing.length + ' anchor(s) not found. dashboard.html has moved under this patch:');
  for (const e of missing) console.error('  ' + e.what);
  console.error('\nRe-read the three functions (jobMailTo, sendCompose, markQuoteSentAfterEmail) and re-anchor.');
  process.exit(3);
}
for (const e of edits) {
  const n = src.split(e.find).length - 1;
  if (n !== 1) {
    console.error('REFUSING: the anchor for "' + e.what + '" appears ' + n + ' times, not once.');
    process.exit(4);
  }
}

if (CHECK) {
  console.log('All ' + edits.length + ' anchors found exactly once, none applied yet. Ready.');
  process.exit(0);
}

/* ---- apply, buffered, then one write ------------------------------------ */
let out = src;
for (const e of edits) out = out.replace(e.find, e.replace);

for (const e of edits) {
  if (!out.includes(e.doneWhen)) {
    console.error('REFUSING: "' + e.what + '" did not take. Nothing written.');
    process.exit(5);
  }
}

copyFileSync(FILE, FILE + '.bak-office-recipient');
writeFileSync(FILE, out, 'utf8');
console.log('Patched website/dashboard.html (' + edits.length + ' edits). Backup alongside it as .bak-office-recipient');
for (const e of edits) console.log('  - ' + e.what);
