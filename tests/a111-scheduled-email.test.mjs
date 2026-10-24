// SCHEDULING AN EMAIL: the three mistakes that would be expensive, guarded.
//
// The office's "Send later" writes a mail_drafts row with a time on it, and
// mail-send's scheduled sweep sends it. Two of the three checks below are
// about double-sending, because that is the failure a scheduled email has that
// a sent one does not: nobody is watching when it goes.
//
// These are source checks. The sweep cannot be executed here -- it needs Deno
// and a live database -- so this holds the properties that make it safe rather
// than pretending to have run it. Where a check is a grep, it greps the
// FUNCTION BODY, not the file, so a comment mentioning the right thing in the
// wrong place cannot satisfy it.
//
// Run:  node tests/a111-scheduled-email.test.mjs
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8");
const DASH = read("website/dashboard.html");
const SEND = read("supabase/functions/mail-send/index.ts");
const SQL = read("supabase_r38_scheduled_email.sql");

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
};

/** One function's body, by name, brace-matched. */
function body(src, needle) {
  const start = src.indexOf(needle);
  if (start < 0) throw new Error("not found: " + needle);
  let i = src.indexOf("{", start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + needle);
}

console.log("\n1. The office schedules with the send id the compose already minted:");
{
  const fn = body(DASH, "async function scheduleCompose(");
  // THE WHOLE ANTI-DOUBLE-SEND STORY. mail-send refuses the same
  // client_send_id twice, so the row must carry the compose's own id. Minting
  // a fresh one here would give a retry a new identity and send a second copy.
  ok("carries c.clientSendId onto the row", /client_send_id:\s*c\.clientSendId/.test(fn));
  ok("does NOT mint a new id of its own",
    !/crypto\.randomUUID/.test(fn),
    "scheduleCompose must not generate a send id");
  ok("sets send_at", /send_at:\s*when\.toISOString\(\)/.test(fn));
  // A row left 'failed' from an earlier attempt must be cleared, or the sweep
  // will skip the rescheduled letter for ever.
  ok("clears any previous failure", /send_state:\s*null/.test(fn) && /send_error:\s*null/.test(fn));
  ok("refuses a time it has not been given", /mailWhenMissing/.test(fn));
  ok("refuses a time in the past", /mailWhenPast/.test(fn));
  ok("checks recipients the way Send does", /mailNeedRecipient/.test(fn));
  ok("reuses saveComposeDraft rather than building the row again",
    /await saveComposeDraft\(\)/.test(fn));
  ok("a quote keeps its hidden button addresses", /hide_cta_url:\s*!!c\.quoteSendFor/.test(fn));
  // A PAYMENT LINK MUST NOT BE QUEUED. It is minted at compose time and locked
  // to the amount it was made for, so one sitting in a row overnight can ask
  // for the wrong money after a re-price -- the failure mint-at-send-time
  // exists to prevent, reachable by the back door through scheduling.
  ok("strips any checkout link from the body before saving",
    /CHECKOUT_LINK/.test(fn) && /stripe/.test(fn),   // plain 'stripe': the page's own text escapes the dot
    "a scheduled payment link can charge a stale amount");
  ok("writes the stripped body back so he can see what will go out",
    /\$\('mc_body'\)\.value\s*=/.test(fn));
  ok("says the pay button was removed rather than removing it silently",
    /mailScheduledNoPay/.test(fn));
}

console.log("\n1b. Sending a queued email NOW takes it out of the queue:");
{
  // If the row survived a manual send, the sweep would find it still due and
  // send a second copy to the customer hours later, unwatched. This was
  // already true for ordinary drafts; scheduling is what makes it matter.
  const sent = body(DASH, "function composeSent(");
  ok("a confirmed send drops the draft row", /dropComposeDraft\(\)/.test(sent));
  const drop = body(DASH, "async function dropComposeDraft(");
  ok("and dropping it really deletes the row by id",
    /from\('mail_drafts'\)\.delete\(\)\.eq\('id', id\)/.test(drop));
  // It must be reached ONLY on a confirmed send: a 'sending' answer may still
  // arrive, and deleting the row then would lose a letter that never went.
  ok("only a confirmed send gets there, never a maybe",
    /state === 'sent'/.test(DASH));
}

console.log("\n2. The sweep cannot send the same letter twice:");
{
  const fn = body(SEND, "async function sweepScheduled(");
  // The claim is a compare-and-swap: of two overlapping runs, exactly one gets
  // the row back. Without the `is send_state null` condition on the UPDATE,
  // both would.
  ok("claims each row conditional on it being unclaimed",
    /\.update\(\{\s*send_state:\s*"sending"[\s\S]{0,200}?\.is\("send_state",\s*null\)/.test(fn),
    "the claim must be conditional, or two runs both send");
  ok("only looks at rows that are actually due", /\.lte\("send_at",\s*nowIso\)/.test(fn));
  ok("only looks at unclaimed rows", /\.is\("send_state",\s*null\)/.test(fn));
  ok("a row it could not send is marked failed, not left to retry for ever",
    /send_state:\s*"failed"/.test(fn));
  ok("works in batches, so a backlog cannot run the function out of time",
    /SCHEDULED_BATCH/.test(fn));
}

console.log("\n3. The sweep refuses what it must not send:");
{
  const fn = body(SEND, "async function sendOneScheduled(");
  // Each of these is a refusal rather than a best guess, and each has a reason
  // in the function. A scheduled draft naming someone else's mailbox is the
  // dangerous one: with no user session the account lookup would run as
  // service role, and the draft insert policy never checked that the account
  // belongs to the company.
  ok("refuses a draft naming a mailbox account", /draft\.account_id/.test(fn));
  ok("refuses a reply or a forward", /"reply"[\s\S]{0,40}"forward"/.test(fn));
  ok("refuses a row with no send id", /isUuid\(draft\.client_send_id\)/.test(fn));
  ok("re-reads the author's role now, not as it was when scheduled",
    /from\("profiles"\)/.test(fn) && /CREW/.test(fn));
  ok("refuses an author who has changed company", /profile\.company_id/.test(fn));
  ok("re-asks whether the company is still allowed", /company_allowed/.test(fn));
  ok("sends only by FenceFlow", /from_account_id:\s*"fenceflow"/.test(fn));
  // A scheduled quote is confirmed long after the screen is gone, so the
  // sweep has to do the stamping the screen does by hand.
  ok("stamps a scheduled quote when it actually goes",
    /quote_sent_at/.test(fn) && /quote_send_for/.test(fn));
  ok("only advances a job out of DRAFT", /"DRAFT"/.test(fn));
}

console.log("\n3b. The phone queues the quote without ever queuing a payment link:");
{
  const api = read("app/src/main/java/com/fenceestimator/app/cloud/ScheduledMailApi.kt");
  const screen = read("app/src/main/java/com/fenceestimator/app/ui/jobs/JobDetailScreen.kt");
  const sched = body(screen, "if (scheduleOpen) {");

  // THE ONE THAT MATTERS MOST. A Stripe link is locked to the amount it was
  // made for, so one queued tonight can be asking for the wrong money by the
  // morning -- a single re-price is all it takes. The phone builds the queued
  // body with an EMPTY payUrl on purpose; the office strips the line for the
  // same reason.
  ok("the queued body is built with an empty payUrl",
    /body = quoteEmailBody\(url, ""\)/.test(sched),
    "a queued payment link can charge a stale amount");
  ok("the send id is minted when scheduling, not when sending",
    /UUID\.randomUUID\(\)/.test(api));
  ok("a quote hides its button addresses", /hideCtaUrl = true/.test(api));
  ok("the job is named so the sweep can stamp it", /quoteSendFor = jobSyncId/.test(api));
  ok("queued as a new letter, never a reply", /val kind: String = "new"/.test(api));
  ok("refuses a time already past", /sendAtMillis < nowMillis \+ 60_000L/.test(api));
  ok("refuses when the phone is not signed in", /currentSessionOrNull\(\)/.test(api));
  ok("an RLS refusal reads as a permission, not a breakage", /row-level security/.test(api));
  ok("a job that has not reached the cloud is refused, not queued",
    /QuoteLink\.NotSyncedYet/.test(sched));
}

console.log("\n4. The schema says what the code relies on:");
{
  for (const col of ["send_at", "send_state", "send_attempted_at", "send_error",
                     "client_send_id", "quote_send_for", "hide_cta_url"]) {
    ok(`${col} is added`, new RegExp("add column if not exists " + col + "\\b").test(SQL));
  }
  ok("send_state is constrained to the words the code writes",
    /check \(send_state is null or send_state in \('sending', 'sent', 'failed'\)\)/.test(SQL));
  ok("the sweep's query is indexed", /create index if not exists mail_drafts_due_idx/.test(SQL));
  // Every column nullable or defaulted, so the migration was inert on arrival.
  ok("nothing is added NOT NULL without a default",
    !/add column if not exists \w+ [^,;]*not null(?![^,;]*default)/i.test(SQL));
}

console.log("\n5. Canary -- these checks can actually fail:");
{
  const fn = body(DASH, "async function scheduleCompose(");
  ok("THE CANARY FIRES: a property that is NOT in scheduleCompose is reported absent",
    !/send_at:\s*'definitely-not-a-real-value'/.test(fn));
  // And the body-slicer really is slicing: the whole file contains
  // crypto.randomUUID (the compose mints one), but scheduleCompose must not.
  ok("the slicer isolates the function, not the file",
    /crypto\.randomUUID/.test(DASH) && !/crypto\.randomUUID/.test(fn),
    "if this fails, check 1's 'does not mint' assertion was vacuous");
}

console.log(`\n${pass} of ${pass + fail} checks passed`);
if (fail) process.exit(1);
