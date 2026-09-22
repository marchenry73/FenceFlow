/**
 * Every number company email is bounded by, in one file.
 *
 * The mail functions talk to servers FenceFlow does not control (a tenant's
 * Zoho or Gmail, or a host the owner typed in) and handle mail FenceFlow did
 * not write. Each limit here exists so that one hostile or merely enormous
 * mailbox cannot hold an edge function past its 2 s of CPU, 150 s of wall
 * time or 256 MB of memory, and so that a stolen office session cannot turn
 * a tenant's mailbox into a relay.
 *
 * Nothing here imports anything. Deno functions and the Node tests read the
 * same constants, so a test that says "the cap is 200" is testing the number
 * production uses rather than a copy of it.
 */

// ---------------------------------------------------------------------------
// Ports. Implicit TLS only.
// ---------------------------------------------------------------------------

/** IMAP over implicit TLS. 143 + STARTTLS is never used: Deno's node:tls
 *  cannot upgrade a socket (denoland/deno#27087), and a plaintext first leg
 *  is the one place a password could cross the wire unencrypted. */
export const IMAP_PORT = 993;
/** SMTP submission over implicit TLS. 587 is blocked outbound by Supabase,
 *  and 25 is both blocked and not a submission port. */
export const SMTP_PORT = 465;

// ---------------------------------------------------------------------------
// One connection to a mail server.
// ---------------------------------------------------------------------------

/** Longest wait for any single read, write, connect or TLS handshake. */
export const OP_TIMEOUT_MS = 20_000;
/** Whole-session ceiling from connect to logout. Kept under the 150 s edge
 *  wall clock with room left over for the database work around it. */
export const SESSION_DEADLINE_MS = 120_000;
/** Bytes a server may send us in one session before we hang up. Counts
 *  reads only: what we write is bounded by our own request limits below. */
export const SESSION_BYTE_CAP = 20 * 1024 * 1024;
/** Longest protocol line. A UID SEARCH over a 30-day window of a busy
 *  mailbox is one line of numbers; 2 MB holds roughly 300 000 UIDs. */
export const MAX_LINE_BYTES = 2 * 1024 * 1024;
/** Largest single IMAP literal accepted. A whole message is fetched as one
 *  literal, and nothing over OPEN_MESSAGE_MAX_BYTES is ever fetched, so the
 *  slack only covers servers whose RFC822.SIZE differs slightly from the
 *  bytes they actually send. */
export const MAX_LITERAL_BYTES = 10 * 1024 * 1024 + 256 * 1024;
/** DNS lookups for an owner-typed host. */
export const DNS_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Sync.
// ---------------------------------------------------------------------------

/** How far back the first sync of a folder reaches. Older mail stays in the
 *  mailbox and the office says so. */
export const FIRST_SYNC_DAYS = 30;
/** Header blocks fetched per folder per run. Later runs continue where the
 *  last one stopped, so a burst of 5 000 new messages takes 25 runs rather
 *  than one run that dies at the byte cap. */
export const HEADERS_PER_FOLDER_PER_RUN = 200;
/** Bytes of one message's header block sync asks for (an IMAP partial
 *  fetch, <0.N>). Real mail needs a few KB for the fields sync reads, but an
 *  outside sender can make To, Cc or References as long as they like: 200
 *  uncapped blocks could spend the whole SESSION_BYTE_CAP in one FETCH, and
 *  the same batch would come back and die again every run. Capped, a folder
 *  costs at most 200 x 32 KB = 6.4 MB, so INBOX and Sent together stay well
 *  under the cap. A block cut short still parses; fields past the cut are
 *  read when the message is opened. */
export const HEADER_BLOCK_MAX_BYTES = 32 * 1024;
/** Header blocks per UID FETCH. mail-sync stores each batch and moves the
 *  folder's state past it before asking for the next, so a session cut short
 *  -- a slow server, the office's 60 s -- keeps every batch it finished. */
export const HEADER_FETCH_BATCH = 50;
/** Newest cached messages whose flags are re-read each run. Removals and
 *  read/unread changes older than this window are not noticed. */
export const FLAG_WINDOW = 300;
/** An office "Check for new mail" holds the account lock this long, which is
 *  also the manual sync rate limit. */
export const MANUAL_SYNC_LOCK_SECONDS = 60;
/** The office door answers within about this long, whatever is left over. */
export const OFFICE_SYNC_BUDGET_MS = 60_000;
/** The scheduled door stops starting new accounts after this many... */
export const TRIGGER_SYNC_MAX_ACCOUNTS = 8;
/** ...or after this long, whichever comes first. */
export const TRIGGER_SYNC_BUDGET_MS = 300_000;
/** An account in `error` is left alone this long before the schedule tries
 *  it again. `auth_failed` is never retried by the schedule at all. */
export const ERROR_BACKOFF_MINUTES = 15;

// ---------------------------------------------------------------------------
// Opening a message.
// ---------------------------------------------------------------------------

/** Messages larger than this are never downloaded; the office points the
 *  reader at their own webmail instead. */
export const OPEN_MESSAGE_MAX_BYTES = 10 * 1024 * 1024;
export const STORED_HTML_MAX_BYTES = 1024 * 1024;
export const STORED_TEXT_MAX_BYTES = 256 * 1024;
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const INLINE_IMAGE_MAX_BYTES = 512 * 1024;
export const INLINE_IMAGES_TOTAL_MAX_BYTES = 2 * 1024 * 1024;
export const SNIPPET_MAX_CHARS = 200;
/** Signed attachment download links live this long. */
export const SIGNED_URL_SECONDS = 60;

// ---------------------------------------------------------------------------
// Requests from the office, and sending.
// ---------------------------------------------------------------------------

/** Largest JSON body any mail function reads. Attachments go through
 *  storage, never through the request. */
export const REQUEST_JSON_MAX_BYTES = 200 * 1024;
export const SUBJECT_MAX_CHARS = 300;
export const SEND_TEXT_MAX_BYTES = 100 * 1024;
export const MAX_RECIPIENTS_SMTP = 20;
export const MAX_RECIPIENTS_RESEND = 10;
export const MAX_ATTACHMENTS = 5;
export const ATTACHMENTS_TOTAL_MAX_BYTES = 10 * 1024 * 1024;
/** In-Reply-To + References kept per stored message. */
export const PARENT_IDS_MAX = 50;
/** References carried on an outgoing reply (the most recent ones). */
export const REFERENCES_OUT_MAX = 20;
export const DISPLAY_NAME_MAX_CHARS = 70;
export const SIGNATURE_MAX_CHARS = 2000;
/** Longest app password accepted. Zoho's and Google's are 16 characters;
 *  the Vault wrapper refuses anything outside 1-256 as well. */
export const SECRET_MAX_CHARS = 256;
/** `mail_accounts.last_error` and every error detail returned to the office. */
export const LAST_ERROR_MAX_CHARS = 300;
/** Live IMAP mailboxes per company, checked in mail-connect. */
export const MAX_IMAP_ACCOUNTS_PER_COMPANY = 3;

// ---------------------------------------------------------------------------
// Rate limits, counted from the mail_events ledger.
// ---------------------------------------------------------------------------

export const CONNECT_ATTEMPTS_PER_HOUR = 10;
export const SMTP_SENDS_PER_HOUR = 20;
export const SMTP_SENDS_PER_DAY = 200;
export const RESEND_SENDS_PER_HOUR = 20;
export const RESEND_SENDS_PER_DAY = 100;
export const INBOUND_PER_COMPANY_PER_DAY = 300;
/** Mailbox sign-ins and Resend receiving calls made by mail-message, per
 *  company: opening mail FenceFlow has no copy of, read/unread marks, and
 *  attachments not stored yet. Every one of them is a fresh sign-in to the
 *  tenant's mailbox, and a stream of sign-ins is what Zoho and Google answer
 *  with a lock -- which classifyLoginFailure must read as a refused
 *  password, taking the mailbox down until the owner types a new one. A
 *  person reading mail stays far below these; a loop does not. */
export const MESSAGE_SESSIONS_PER_MINUTE = 20;
export const MESSAGE_SESSIONS_PER_HOUR = 240;

// ---------------------------------------------------------------------------
// Webhooks.
// ---------------------------------------------------------------------------

/** A svix-timestamp further than this from now is refused as a replay. */
export const SVIX_TOLERANCE_SECONDS = 5 * 60;
