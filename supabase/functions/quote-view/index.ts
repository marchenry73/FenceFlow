/**
 * The homeowner's view of a quote.
 *
 * A contractor sends a link; the person who owns the yard opens it, sees the
 * quote, walks around their fence in 3D, approves it with their name, and --
 * once the company's card processor is connected -- pays the deposit. No
 * account, no app, no sign-in: the unguessable token IS the authorisation,
 * exactly like a bank's document link.
 *
 *   GET  ?t=<token>                      -> the quote, whitelisted fields only
 *   POST ?t=<token>  {action:"approve", name[, phone4][, total][, signatureDataUrl]}
 *                                        -> records the approval, and with it
 *                                           the total the page showed
 *                                           (jobs.accepted_total). A `total`
 *                                           that no longer matches -> 409
 *                                           {code:"quote_changed"}. name stays
 *                                           required; signatureDataUrl is an
 *                                           OPTIONAL "data:image/png;base64,.."
 *                                           from the page's own drawing pad
 *                                           (see quote_approved_signature_path).
 *                                           An optional lang ("en"|"es"|"fr") is
 *                                           the language of the contract email.
 *                                           The answer carries `contractEmail`
 *                                           when THIS request's approval is the
 *                                           one that landed: see emailTheContract.
 *
 * Everything goes through an explicit whitelist. The jobs row also carries
 * labour rates, margins and markup; estimate lines carry supplier_unit_price,
 * which is what the contractor PAYS. None of that may ever reach the person
 * being quoted, so the shape sent out is built by hand rather than selecting
 * whole rows and hoping.
 *
 * The one deliberate addition is `paymentMethods`: where and how this company
 * asks to be paid (Cash App, Zelle, wire, cash). See publicPaymentMethods()
 * below, which says exactly what goes out and why, and
 * supabase_a38_company_payment_methods.sql for the contract and storage.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import {
  CHANGE_ORDER_COLUMNS,
  CHANGE_ORDER_COLUMNS_BEFORE_ACCEPTANCE_FLAG,
  changeOrderInputs,
  depositFigures,
  missingAcceptanceFlag,
  roundToCents,
} from "../_shared/quote-deposit.ts";
import { standingJobEvent } from "../_shared/job-push.ts";
import { jobDevices, moneyDevices } from "../_shared/push-recipients.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const JOB_COLUMNS = "id, sync_id, company_id, customer_name, address, phone, status, deleted_at, " +
  "contract_total, deposit_amount, amount_paid, refunded_amount, " +
  "tax_rate_percent, discount_percent, " +
  "quote_viewed_at, quote_approved_at, quote_approved_name, calibration_pixels_per_foot, " +
  "quote_phone_attempts, quote_phone_locked_until, reapproval_required_at, reapproval_reason";

/**
 * The price the customer accepted and what it is measured from
 * (supabase_r6_price_stability.sql). Read separately named so a database
 * without the column yet -- this function deployed before the migration --
 * can be read without them, and the page then behaves exactly as it did.
 */
const ACCEPTANCE_COLUMNS = "accepted_total, signed_at, signed_contract_total";

/**
 * Whether an error is only "this database has not got the acceptance columns
 * yet". signed_contract_total is in the same list and so is in the same test:
 * a database missing it must step down to the no-acceptance read like any
 * other missing column, not fall through and answer 404 on every quote.
 */
const lacksAcceptanceColumns = (error: { message?: string } | null | undefined) =>
  /accepted_total|signed_contract_total/.test(String(error?.message ?? ""));

/**
 * The storage path of a signature the customer DREW on this page, as an
 * alternative to typing their name (item C3). Deliberately its own column,
 * never jobs.signature_storage_path -- that column means the IN-PERSON SIGNED
 * CONTRACT (FileSync.kt, write-once, pinned by supabase_p2_contract_columns_pin.sql,
 * read by the office dashboard as proof a contract was signed). A remote web
 * approval and a crew-witnessed signing are not the same fact and must not
 * share a column. See supabase_quote_signature_patch.sql for the full
 * reasoning and the migration itself (NOT applied -- see that file).
 */
const SIGNATURE_COLUMN = "quote_approved_signature_path";

/** Whether an error is only "this database has no quote_approved_signature_path yet". */
const lacksSignatureColumn = (error: { message?: string } | null | undefined) =>
  /quote_approved_signature_path/.test(String(error?.message ?? ""));

type QuoteJob = {
  company_id: string;
  sync_id: string;
  contract_total: number | null;
  deposit_amount: number | null;
  amount_paid: number | null;
  refunded_amount: number | null;
  tax_rate_percent: number | null;
  quote_approved_at: string | null;
  reapproval_required_at: string | null;
  accepted_total?: number | string | null;
  signed_at?: string | null;
  signed_contract_total?: number | string | null;
  quote_approved_signature_path?: string | null;
};

/**
 * Where and how this company asks to be paid -- the ONE thing from
 * company_settings that reaches a customer, and every part of it is public on
 * purpose.
 *
 * WHAT GOES OUT (all four, nothing else, ever):
 *   cashApp  "$Tag"   a Cash App $cashtag is handed out precisely so people can
 *                     pay it
 *   zelle    "..."    the phone number and/or email the company's Zelle is
 *                     registered to -- the same: given out to be paid
 *   wire     "..."    free text: bank, account name, routing and account number.
 *                     BANK DETAILS ARE SENT TO ANY HOLDER OF THE LINK, KNOWINGLY.
 *                     They are what a company gives a customer so the customer
 *                     can wire it money, they are printed on invoices, and the
 *                     owner types them into the office page for exactly this
 *                     purpose. They are not "passed through by accident": this
 *                     comment and the whitelist below are the deliberate part.
 *   cash     boolean  "we take cash"
 *
 * WHAT DOES NOT: the rest of company_settings (labour rate, markup, minimum
 * charge, templates...) is never selected -- the read below asks for the one key
 * -- and nothing here is built by spreading an object, so a key added to the
 * blob tomorrow stays out until somebody adds it to this function on purpose.
 * Nothing from the companies row beyond name/phone/email is read either.
 *
 * A method reaches the customer only when the owner turned it ON (=== true,
 * not merely truthy) AND filled it in. Off, empty, malformed or over-long all
 * come out as "" / false, and the page draws nothing for those. An over-long
 * value is DROPPED rather than cut short: half a bank account number is a
 * payment sent nowhere. The office page enforces limits well under these, so a
 * value the office accepted is never dropped here.
 *
 * Invisible and direction-changing characters are stripped. They arrive when a
 * handle or address is pasted from a text message, they make a $cashtag fail
 * to match without anyone being able to see why, and a right-to-left override
 * can make an address read differently from what it is.
 *
 * No value is invented. A company that has not typed anything gets all-empty.
 */
const INVISIBLE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const CASH_APP_TAG = /^[A-Za-z0-9_.-]{1,30}$/;
const MAX_ZELLE_CHARS = 200;
const MAX_WIRE_CHARS = 1500;

type PublicPaymentMethods = { cashApp: string; zelle: string; wire: string; cash: boolean };

function publicPaymentMethods(raw: unknown): PublicPaymentMethods {
  const out: PublicPaymentMethods = { cashApp: "", zelle: "", wire: "", cash: false };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const stored = raw as Record<string, unknown>;
  // The method's own object, but only when it is switched on.
  const switchedOn = (key: string): Record<string, unknown> | null => {
    const m = stored[key];
    if (!m || typeof m !== "object" || Array.isArray(m)) return null;
    return (m as Record<string, unknown>).on === true ? m as Record<string, unknown> : null;
  };
  const text = (v: unknown) => typeof v === "string" ? v.replace(INVISIBLE_CHARS, "") : "";

  const cashApp = switchedOn("cash_app");
  if (cashApp) {
    const tag = text(cashApp.tag).trim().replace(/^\$+/, "");
    if (CASH_APP_TAG.test(tag)) out.cashApp = "$" + tag;
  }

  const zelle = switchedOn("zelle");
  if (zelle) {
    // One line. Not classified as phone or email and not validated: the bank's
    // own Zelle screen works out which it is, and a company may give both.
    const to = text(zelle.to).replace(/\s+/g, " ").trim();
    if (to.length > 0 && to.length <= MAX_ZELLE_CHARS) out.zelle = to;
  }

  const wire = switchedOn("wire");
  if (wire) {
    // Free text, line breaks kept. A bank's wording is the owner's to paste;
    // this only tidies it (line endings, stray spaces, runs of blank lines).
    const lines = text(wire.details).replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
    while (lines.length && lines[0] === "") lines.shift();
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    const details = lines.join("\n").replace(/\n{3,}/g, "\n\n");
    if (details.length > 0 && details.length <= MAX_WIRE_CHARS) out.wire = details;
  }

  out.cash = switchedOn("cash") !== null;
  return out;
}

/**
 * The company's stored payment methods, already reduced to what a customer may
 * see -- or null when the read FAILED, so that "this company set nothing up" (an
 * all-empty object) and "we could not look" (no key at all) are different
 * answers on the wire and in the logs. The page treats both as "show nothing";
 * a failed read must never take the quote itself down with it.
 *
 * Asks for the one key, not the blob: company_settings also holds the labour
 * rate, markup and minimum charge. Runs as the service role, so the policies
 * that hide the blob from crew do not apply here and the whitelist above is
 * the only gate -- which is why it is a whitelist.
 */
async function readPaymentMethods(
  admin: ReturnType<typeof createClient>,
  companyId: string,
): Promise<PublicPaymentMethods | null> {
  try {
    const { data, error } = await admin
      .from("company_settings")
      .select("payment_methods:settings->payment_methods")
      .eq("company_id", companyId)
      .maybeSingle();
    if (error) {
      console.error("quote-view payment methods", error.message);
      return null;
    }
    return publicPaymentMethods((data as { payment_methods?: unknown } | null)?.payment_methods);
  } catch (e) {
    console.error("quote-view payment methods", String((e as Error)?.message ?? e));
    return null;
  }
}

/**
 * job-files is private, so the path itself is useless to a browser -- and the
 * path is never handed out anyway (comment on quote_approved_signature_path
 * says why). A short-lived signed URL is what the page, and the downloadable
 * copy it builds from the same JSON, actually render an <img> from.
 */
async function approvedSignatureUrl(
  admin: ReturnType<typeof createClient>,
  path: string | null | undefined,
): Promise<string | null> {
  if (!path) return null;
  const { data } = await admin.storage.from("job-files").createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}

/**
 * A customer-drawn signature exactly as the page's canvas produces it via
 * `<canvas>.toDataURL()`: "data:image/png;base64,...". Nothing about the
 * client's claim is trusted -- the prefix, the length and the decoded bytes
 * are all checked here, and only the bytes decide whether this is really a
 * PNG (the client's own "image/png" text is just a string anyone can send).
 *
 * A real signature is a handful of KB; MAX_SIGNATURE_BYTES leaves generous
 * room for a messy one on a big phone screen without accepting an arbitrary
 * photo shaped like a data URL.
 */
const MAX_SIGNATURE_BYTES = 300 * 1024;
// Base64 costs 4 bytes for every 3 of input, plus the "data:image/png;base64,"
// prefix -- capping the STRING length before it is ever decoded means an
// oversized payload is refused without base64-decoding it first.
const MAX_SIGNATURE_DATA_URL_LEN = Math.ceil((MAX_SIGNATURE_BYTES * 4) / 3) + 64;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type SignatureDecode =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "too_large" | "invalid" };

function decodeSignaturePng(raw: unknown): SignatureDecode {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "invalid" };
  if (raw.length > MAX_SIGNATURE_DATA_URL_LEN) return { ok: false, reason: "too_large" };
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
  if (!match) return { ok: false, reason: "invalid" };
  let bytes: Uint8Array;
  try {
    const binary = atob(match[1]);
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (bytes.length === 0) return { ok: false, reason: "invalid" };
  if (bytes.length > MAX_SIGNATURE_BYTES) return { ok: false, reason: "too_large" };
  if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) return { ok: false, reason: "invalid" };
  return { ok: true, bytes };
}

/**
 * The price the page shows, the deposit under it and -- when the homeowner
 * approves -- the price recorded as accepted (jobs.accepted_total). One
 * function for all three, so what they approve is by construction the figure
 * they were shown.
 *
 * Why it records one at all: an online approval used to store only the time
 * and the name, and every figure downstream went on following contract_total,
 * which the phones kept moving after acceptance. The quote page, the payment
 * link and the deposit cap then asked for a price nobody had agreed to (job
 * 4598: signed at $9,710, asked against $13,410).
 *
 * While an acceptance stands the page shows that accepted price plus extra
 * work signed since -- the same depositFigures().total create-payment-link
 * bills against, so the page and the card machine agree. Before it, and while
 * a re-approval is pending, it shows contract_total as it always did, falling
 * back to the lines when nothing is priced yet.
 *
 * ok is false when a read failed. The page view shrugs that off, as it always
 * has; an approval refuses rather than record a figure built from half the
 * data.
 */
async function pageFigures(admin: ReturnType<typeof createClient>, job: QuoteJob) {
  // in_accepted_total says which orders the accepted price already contains;
  // a database without the column yet is read the old way.
  const readOrders = async () => {
    const read = (columns: string) => admin.from("change_orders")
      .select(columns)
      .eq("company_id", job.company_id)
      .eq("job_sync_id", job.sync_id);
    const first = await read(CHANGE_ORDER_COLUMNS);
    return first.error && missingAcceptanceFlag(first.error)
      ? await read(CHANGE_ORDER_COLUMNS_BEFORE_ACCEPTANCE_FLAG)
      : first;
  };
  const [itemsRead, ordersRead] = await Promise.all([
    // Pinned to the company as well as the job. The job id alone was the
    // key, so a row written under another company but carrying this job's
    // id would have been priced into this quote -- defence in depth against
    // exactly the cross-company write the rest of the system guards for.
    admin.from("estimate_line_items")
      .select("description, quantity, unit, unit_price, taxable, sort_order")
      .eq("company_id", job.company_id)
      .eq("job_sync_id", job.sync_id).is("deleted_at", null)
      .order("sort_order"),
    // Extra work signed since acceptance moves the accepted price; it matters
    // only once there is one, so no other quote pays for the read.
    job.accepted_total != null
      ? readOrders()
      : Promise.resolve({ data: [], error: null }),
  ]);

  const lines = (itemsRead.data ?? []).map((i: { quantity: number; unit_price: number; taxable: boolean }) => ({
    total: (Number(i.quantity) || 0) * (Number(i.unit_price) || 0),
    taxable: !!i.taxable,
  }));
  const subtotal = lines.reduce((s: number, l: { total: number }) => s + l.total, 0);
  const taxRate = Number(job.tax_rate_percent) || 0;
  const tax = lines.filter((l: { taxable: boolean }) => l.taxable)
    .reduce((s: number, l: { total: number }) => s + l.total, 0) * taxRate / 100;

  // The deposit exists so the materials can be bought before labour starts.
  //
  // This used to invent one from the material cost when the contractor had
  // not set any -- rounded up to the next hundred -- and print it on the
  // page. create-payment-link knew nothing about that invented figure and
  // refused to charge it, so the page asked for a deposit the product would
  // not take. Worse, it put a number in front of a customer that their
  // contractor had never agreed to. Both functions now read one rule
  // (_shared/quote-deposit.ts): a deposit is a thing the contractor asks
  // for, and what is shown is what is still owed on it.
  const money = depositFigures({
    depositAmount: job.deposit_amount,
    contractTotal: job.contract_total,
    amountPaid: job.amount_paid,
    refundedAmount: job.refunded_amount,
    acceptedTotal: job.accepted_total == null ? null : Number(job.accepted_total),
    signedAt: job.signed_at ?? null,
    quoteApprovedAt: job.quote_approved_at,
    reapprovalRequiredAt: job.reapproval_required_at,
    changeOrders: changeOrderInputs(ordersRead.data as Parameters<typeof changeOrderInputs>[0]),
  });

  // The billable total as it stands -- the same figure create-payment-link
  // charges from and the app bills. When nothing is priced yet the page falls
  // back to adding up the lines itself, and that sum is EXACT, to the cent
  // (roundToCents), like every other total now: the engine stopped rounding up
  // to the next ten in PRICING_ENGINE_VERSION 2026.10.1, and a fallback that
  // still rounded up to ten would make the page and the engine disagree by up
  // to $9.99 on the same job. Only the sum is rounded to cents, to clear float
  // dust -- the page must never print 2119.9999999999995.
  //
  // Only this fallback is ever rounded. It used to round every source: wrong
  // once an accepted price plus a signed change order of $455 became $10,165
  // -- the page said $10,170 while the balance link charged from $10,165, and
  // an approval then recorded $10,170 as the accepted price, $5 above
  // anything anybody agreed. An accepted or engine-stamped total is already
  // exact and is passed through untouched.
  const total = money.total > 0 ? money.total : roundToCents(subtotal + tax);
  return {
    ok: !itemsRead.error && !ordersRead.error,
    total,
    money,
    // Whether this job holds any priced line at all. Not used to change a
    // figure -- only to say WHY in the log when the guard below refuses, and
    // to tell the office whether the price fell because the material list is
    // gone or because somebody re-priced it.
    pricedLines: lines.length,
  };
}

// ---------------------------------------------------------------------------
// A PRICE THAT COLLAPSED MUST NOT BECOME THE AGREED PRICE.
//
// Added 2 Oct 2026. On 1 Oct at 21:26 UTC a sync pass tombstoned every
// generated line on five of this company's jobs and re-priced them from an
// empty material list (OVERNIGHT_2026-10-01.md, the 03:00 section). On three
// of them a signature is on file for the real price and the live figure is
// labour and gates only:
//
//   signed 15,540.00  live  5,853.81   (37.7% -- her link has been opened)
//   signed 35,240.00  live 13,266.87   (37.7% -- her link has been opened)
//   signed    870.00  live    200.00   (23.0%)
//
// Those three are flagged re-approval-pending, which is exactly right -- the
// re-approval was raised on 28 Sep to collect MORE, a tax correction worth
// $1,522.22 across the three (supabase_a70_protect_exposed_quote_links.sql) --
// and quote-deposit.ts deliberately turns the anchor OFF while that flag is
// set, so the page shows the live figure. With the material list destroyed,
// the live figure is wreckage, and this function would have written it into
// jobs.accepted_total the moment she tapped Approve. Measured against the real
// rows with the real handler, not reasoned about: tests/a69-after-approval.test.mjs.
//
// So: an approval is REFUSED when the price it would record is below a figure
// this customer has already agreed to. Nothing is written, her earlier
// agreement stands untouched, and the office is told.
//
// WHICH FIGURE SHE AGREED TO: the higher of signed_contract_total (a signature
// the contractor physically holds, stamped with the price at the time) and
// accepted_total (an online approval, which this function writes). While a
// re-approval is pending, accepted_total still holds the pre-withdrawal price,
// which is the whole point -- that is the figure the withdrawal was asking her
// to revisit, not one to quietly undercut.
//
// WHY A REFUSAL IS THE SAFE DIRECTION, AND HOW HE CLEARS IT: the phone already
// takes the same position from the other side -- signatureIsStale blocks
// sending the estimate and the invoice whenever the signed total and the live
// total disagree, and the way out is to capture a new signature, which
// restamps signed_contract_total at the new price. This guard is that same rule
// on the customer's side of the link. A deliberate re-price DOWNWARD therefore
// needs a fresh signature at the new figure before she can approve it online,
// and that is a real cost -- see docs/AFTER_APPROVAL.md, which asks him whether
// he wants a tolerance band instead.
// ---------------------------------------------------------------------------

/**
 * How far below an agreed figure counts as below it.
 *
 * Fifty cents, which is NOT a tolerance band -- it is the same float-dust
 * allowance the quote_changed check a few lines down already uses, and the
 * smallest amount a card processor will take. It is deliberately the
 * STRICTEST setting: any real shortfall refuses. Nothing here invents a
 * percentage or a dollar band, because what counts as an acceptable drop in
 * price is the owner's decision and not a number to guess on his behalf.
 * docs/AFTER_APPROVAL.md asks him for it.
 */
const AGREED_PRICE_SHORTFALL_TOLERANCE = 0.5;

/**
 * THE ONE SHORTFALL THAT IS NOT A SHORTFALL: the same price under the old
 * engine's rounding.
 *
 * Until PRICING_ENGINE_VERSION 2026.10.1 the engine rounded every total UP to
 * the next ten (`Math.ceil(x/10)*10`), and the deployed office re-price still
 * does. So a job signed before that change carries a signed_contract_total up
 * to $9.99 above the exact figure its own lines come to, and the moment it is
 * re-priced on the current engine the page shows the exact one. That is not a
 * price that fell; it is the same price with the rounding taken off, and a
 * guard that refused it would refuse an honest approval on every job he signed
 * before 1 Oct.
 *
 * Measured, live: fixture job G's lines come to $7,735.45 against a signed
 * $7,740.00 -- exactly `ceil(7735.45/10)*10`. The three collapsed jobs do not
 * fit this shape and are not excused by it (5,853.81 rounds to 5,860, not to
 * 15,540).
 *
 * This is deliberately an exact test and not a tolerance band: it excuses a
 * difference ONLY when the agreed figure is precisely what the old engine
 * would have printed for the figure now on the page. No dollar amount or
 * percentage is being guessed at.
 */
const OLD_ENGINE_ROUND_UP_TO = 10;
const isOldEngineRounding = (agreed: number, recording: number) =>
  Math.abs(agreed - Math.ceil(recording / OLD_ENGINE_ROUND_UP_TO) * OLD_ENGINE_ROUND_UP_TO) <= 0.005;

/** A figure already agreed, and the shortfall against it. Null when there is none. */
type PriceShortfall = { agreed: number; recording: number; short: number };

/**
 * The figure this customer has already agreed to, if the price now on the page
 * is below it. Null means there is nothing to protect (no signature and no
 * earlier approval) or the price has not fallen.
 *
 * A non-finite or absent column reads as nothing agreed, which turns the guard
 * OFF rather than refusing every quote: a database without the column (the
 * no-acceptance read above) must behave exactly as this function did before.
 */
function priceShortfall(job: QuoteJob, recording: number): PriceShortfall | null {
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const agreed = Math.max(num(job.signed_contract_total), num(job.accepted_total));
  if (!(agreed > 0.005) || !Number.isFinite(recording)) return null;
  if (isOldEngineRounding(agreed, recording)) return null;
  const short = roundToCents(agreed - recording);
  return short > AGREED_PRICE_SHORTFALL_TOLERANCE ? { agreed, recording, short } : null;
}

/**
 * One notification to each of these phones, through Firebase's v1 API: a short-lived OAuth token minted
 * from the service account, then one message per phone. This is the code the "Quote approved" push has
 * always run, moved here unchanged so the alarm below can use the same one; it throws when no token can
 * be had, and one phone failing never stops the others.
 */
async function fcmNotify(
  // deno-lint-ignore no-explicit-any
  sa: any,
  toks: Array<{ token: string }>,
  title: string,
  body: string,
) {
  const jwtHeader = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const now = Math.floor(Date.now() / 1000);
  const claims = btoa(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const keyDer = atob(sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""));
  const keyBytes = new Uint8Array([...keyDer].map((c) => c.charCodeAt(0)));
  const key = await crypto.subtle.importKey("pkcs8", keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key,
    new TextEncoder().encode(jwtHeader + "." + claims));
  const jwt = jwtHeader + "." + claims + "." +
    btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const tokRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt,
    }),
  });
  const accessTok = (await tokRes.json()).access_token;
  if (accessTok) {
    await Promise.all(toks.map((t: { token: string }) =>
      fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessTok}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: t.token,
            notification: { title, body },
          },
        }),
      }).catch(() => null)
    ));
  }
}

/**
 * The contract email could not even be asked for -- the sender is not deployed, its secret does not
 * match, or it did not answer -- so the sender could not tell the office itself. Push the phones that may
 * see the price (the email carries it), in words that match what is known. Only ever reached with the
 * trigger secret set, i.e. when the sender really was tried. Never throws.
 */
async function alarmOffice(
  admin: ReturnType<typeof createClient>,
  job: { company_id: string; customer_name?: string | null },
  mayHaveGone: boolean,
  // Another thing worth waking the money phones for, in its own words. The
  // audience, the "never throws" promise and the no-service-account early
  // return are all identical, so the price guard above borrows this rather
  // than growing a second copy of them. Absent means the contract-email
  // wording below, exactly as before.
  override?: { title: string; body: string },
) {
  try {
    const sa = JSON.parse(Deno.env.get("FIREBASE_SERVICE_ACCOUNT") ?? "null");
    if (!sa) return;
    const toks = await moneyDevices(admin, job.company_id);
    if (!toks.length) return;
    if (override) {
      await fcmNotify(sa, toks, override.title, override.body);
      return;
    }
    const who = String(job.customer_name ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || "A customer";
    await fcmNotify(
      sa,
      toks,
      mayHaveGone ? "Contract email: could not confirm" : "Contract email NOT sent",
      mayHaveGone
        ? `${who} approved the quote. FenceFlow could not confirm the contract email went out: the email service did not answer. Check Sent in company email before sending it again.`
        : `${who} approved the quote, but the contract email was not sent: the email service could not be reached. Send it yourself, or ask them to download a copy from their quote link.`,
    );
  } catch (_e) { /* the approval stands, and the failure is already on the record */ }
}

/**
 * What the page may be told about the contract email, and ONLY this:
 *   sent       the mail provider accepted it (to is the address, masked)
 *   pending    it is still going, or may have gone: do not say it was sent, do not say it failed
 *   no_address there is no usable email address on the job
 *   not_sent   it was not sent
 * Never an error to the customer: her approval has landed whatever this says, and a page that
 * told her the email failed in a way that read as "the approval failed" would make her approve twice.
 */
type ContractEmail = { state: "sent" | "pending" | "no_address" | "not_sent"; to?: string };

/** Longest the approval waits for the email. Past it the answer is "pending" and the email carries on. */
const CONTRACT_EMAIL_WAIT_MS = 8000;

/**
 * Asks quote-approval-email to send the customer their contract, now that the approval has landed.
 *
 * This function does not send mail and holds no mail credential: the sender is its own function, behind
 * the NOTIFY_TRIGGER_SECRET door, and builds every word from the database. What is passed is the job and
 * the customer's language, nothing else -- the recipient, the figures and the deposit are not the request's.
 *
 * Never throws and never touches the approval. The other side CLAIMS before it sends (one row per
 * contract, unique), so the one repeat made after a network failure or a server error cannot send twice.
 * Whatever verdict the sender reaches (sent, failed, no address, unconfirmed...) it records itself and, when
 * it is not "sent", pushes the office about. What only this function can know is that the sender could not
 * be asked, or gave no verdict: then nobody else will say so, and this function does -- on the same table
 * where the sender is known not to have run, and by push (alarmOffice) in every such case.
 */
async function emailTheContract(
  admin: ReturnType<typeof createClient>,
  job: { id: string; sync_id: string; company_id: string; customer_name?: string | null },
  lang: unknown,
  acceptLanguage: string | null,
  approvedAt: string,
): Promise<ContractEmail> {
  // The sender was never called, so nothing was sent: write that down, where the office reads it.
  const recordNotCalled = async (code: string, reason: string) => {
    try {
      const digest = new Uint8Array(await crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode(`unreached:${job.sync_id}:${approvedAt}`)));
      const key = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
      await admin.from("quote_approval_emails").insert({
        company_id: job.company_id, job_sync_id: job.sync_id, contract_key: key, state: "failed",
        reason_code: code, reason, settled_at: new Date().toISOString(),
      });
    } catch (e) {
      console.error("quote-view: could not record that the contract email was not sent", String((e as Error)?.message ?? e));
    }
  };
  try {
    const secret = Deno.env.get("NOTIFY_TRIGGER_SECRET") ?? "";
    const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
    if (!secret || !base) {
      console.error("quote-view: the contract email was NOT sent -- NOTIFY_TRIGGER_SECRET or SUPABASE_URL is not set on this function");
      await recordNotCalled("sender_not_configured", "Contract emails are not switched on for this server (the trigger secret is not set), so nothing was sent.");
      return { state: "not_sent" };
    }
    const payload = JSON.stringify({
      job_id: job.id,
      lang: typeof lang === "string" ? lang.slice(0, 8) : undefined,
      accept_language: (acceptLanguage ?? "").slice(0, 200),
    });
    const attempt = async (): Promise<{ status: number; answer: Record<string, unknown> } | null> => {
      try {
        const res = await fetch(`${base}/functions/v1/quote-approval-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-fenceflow-trigger": secret },
          body: payload,
        });
        return { status: res.status, answer: await res.json().catch(() => ({})) };
      } catch (_e) {
        return null;
      }
    };
    const call = (async () => {
      let r = await attempt();
      if (!r || r.status >= 500) r = await attempt();
      return r;
    })();
    // The runtime keeps the call alive after the answer goes out, so a slow send is not cut off with it.
    try {
      // deno-lint-ignore no-explicit-any
      (globalThis as any).EdgeRuntime?.waitUntil?.(call);
    } catch (_e) { /* no such runtime */ }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), CONTRACT_EMAIL_WAIT_MS); });
    const r = await Promise.race([call, late]);
    clearTimeout(timer);
    if (r === "late") return { state: "pending" };
    // From here on, the sender either answered or did not. When it answered with a verdict (sent, failed,
    // no address...) it has already recorded it and told the office. When it could not be asked, or its
    // answer is not one, nobody else will -- so this function does, on the record and by push.
    if (!r) {
      console.error("quote-view: could not reach quote-approval-email; the contract email may not have been sent");
      await alarmOffice(admin, job, true);
      return { state: "not_sent" };
    }
    if (r.status !== 200) {
      console.error(`quote-view: quote-approval-email answered ${r.status}; the contract email may not have been sent`);
      // A refusal (the secret does not match, no such function, not configured) means it never ran, so
      // nothing was sent. A server error is unknown -- it may have run -- so no verdict is written for it.
      const neverRan = (r.status >= 400 && r.status < 500) || r.status === 503;
      if (neverRan) {
        await recordNotCalled("sender_unavailable", "The contract email function could not be called (not deployed, or its secret does not match), so nothing was sent.");
      }
      await alarmOffice(admin, job, !neverRan);
      return { state: "not_sent" };
    }
    const state = String(r.answer?.state ?? "");
    if (state === "sent") return { state: "sent", to: String(r.answer?.to ?? "") };
    if (state === "unconfirmed" || state === "sending") return { state: "pending" };
    if (state === "no_address") return { state: "no_address" };
    if (["failed", "not_priced", "skipped"].includes(state)) return { state: "not_sent" };
    // 200 with no verdict at all: nothing was recorded and nothing is known.
    console.error("quote-view: quote-approval-email answered 200 with no usable verdict");
    await alarmOffice(admin, job, true);
    return { state: "not_sent" };
  } catch (e) {
    console.error("quote-view: contract email", String((e as Error)?.message ?? e));
    return { state: "not_sent" };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = new URL(req.url);
  const token = (url.searchParams.get("t") ?? "").trim();
  // A malformed token is not a lookup that found nothing; refuse it before
  // the database ever sees it.
  if (!/^[0-9a-f-]{36}$/.test(token)) return json({ error: "That link is not valid." }, 400);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let { data: job, error: jobError } = await admin
    .from("jobs")
    .select(`${JOB_COLUMNS}, ${ACCEPTANCE_COLUMNS}, ${SIGNATURE_COLUMN}`)
    .eq("quote_token", token)
    .maybeSingle();
  // supabase_quote_signature_patch.sql has not been applied yet, or this
  // function deployed before it was: step down to the select that doesn't
  // ask for the signature column. Conservative on purpose -- ANY error that
  // looks like a missing column (signature OR acceptance) drops the
  // signature half, so this never claims to be able to store a drawing it
  // cannot actually persist. canRecordSignature below is what tells the page
  // whether to show the drawing option at all.
  let canRecordSignature = true;
  if (jobError && (lacksSignatureColumn(jobError) || lacksAcceptanceColumns(jobError))) {
    canRecordSignature = false;
    ({ data: job, error: jobError } = await admin
      .from("jobs")
      .select(`${JOB_COLUMNS}, ${ACCEPTANCE_COLUMNS}`)
      .eq("quote_token", token)
      .maybeSingle());
  }
  // Deployed before supabase_r6_price_stability.sql: read as before, and
  // approve as before (without recording the figure) until the column lands.
  const canRecordAcceptance = !lacksAcceptanceColumns(jobError);
  if (!canRecordAcceptance) {
    ({ data: job } = await admin.from("jobs").select(JOB_COLUMNS).eq("quote_token", token).maybeSingle());
  }
  if (!job || job.deleted_at) return json({ error: "That quote is no longer available." }, 404);

  // Suspension reaches the public pages too. This runs as the service role,
  // so the RESTRICTIVE not-suspended policies that lock a switched-off
  // company out of the app and the office never see these reads -- and a
  // suspended company's quote links went on working: viewable, approvable,
  // and pushing "Quote approved" to every phone on a company that was shut.
  // Same answer as a deleted job, on purpose: the homeowner is not the one
  // who needs to know why.
  const { data: allowed } = await admin.rpc("company_allowed", { cid: job.company_id });
  if (allowed === false) return json({ error: "That quote is no longer available." }, 404);

  // ------------------------------------------------------------- approve ---
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body?.action !== "approve") return json({ error: "Unknown action." }, 400);
    const name = String(body?.name ?? "").trim().slice(0, 120);
    if (name.length < 2) return json({ error: "Type your name to approve." }, 400);

    // A drawn signature is OPTIONAL and rides ALONGSIDE the typed name above,
    // never instead of it -- a drawing alone is not identification, and
    // quote_approved_name stays "the name on record" everywhere else it is
    // read (job screens, the approval push below) regardless of which way the
    // customer signed. Checked here, before the phone gate spends an attempt
    // and before anything touches the database, so a bad payload never costs
    // the customer a guess or reaches storage.
    const rawSignature = body?.signatureDataUrl;
    let signatureBytes: Uint8Array | null = null;
    if (rawSignature != null) {
      if (!canRecordSignature) {
        // The migration in supabase_quote_signature_patch.sql has not run
        // (or this function predates it). Refusing loudly here is the whole
        // point of this feature's design: a signature the server cannot
        // persist must never be accepted and silently dropped.
        return json({
          code: "signature_unavailable",
          error: "Drawing a signature isn't available on this quote yet. Please type your name to approve, or reload the page.",
        }, 400);
      }
      const decoded = decodeSignaturePng(rawSignature);
      if (!decoded.ok) {
        return json({
          code: "signature_invalid",
          error: decoded.reason === "too_large"
            ? "That signature is too large to save. Clear it, draw a smaller signature, and try again -- or type your name instead."
            : "That doesn't look like a valid signature. Clear it and draw again, or type your name instead.",
        }, 400);
      }
      signatureBytes = decoded.bytes;
    }

    // First signature wins. A second approval must not overwrite whose name
    // is on the record.
    const justApproved = !job.quote_approved_at;

    // -------------------------------------------------- phone gate --------
    // A forwarded link lets anyone who has it -- a neighbour, a spouse who
    // was never the buyer, whoever the customer sent it to for an opinion --
    // sign for thousands of dollars. Only the approval step is gated; the
    // quote stays exactly as readable as it always was.
    //
    // The digits never reach the browser and the comparison never happens
    // there: the page holds nothing that decides the answer, so a client
    // patched to always say "match" still gets refused here.
    const phoneDigits = String(job.phone ?? "").replace(/\D/g, "");
    const hasPhone = phoneDigits.length >= 4;
    let approvedWithoutPhoneCheck = false;
    if (justApproved) {
      if (hasPhone) {
        const now = Date.now();
        const lockedUntilMs = job.quote_phone_locked_until
          ? Date.parse(job.quote_phone_locked_until)
          : 0;
        if (lockedUntilMs > now) {
          // Same shape of response as a wrong guess -- a lockout must not
          // read as a different, more informative kind of failure.
          return json({ error: "Too many attempts. Try again in a few minutes." }, 429);
        }

        // Spend an attempt BEFORE the digits are compared, and spend it in a
        // single UPDATE inside the database rather than read-here/write-back.
        // Reading the count and writing it back let N requests fired at once
        // all read the same number, so "five tries per fifteen minutes" never
        // bounded a burst -- and there are only ten thousand four-digit codes.
        // quote_phone_try() takes the row lock, so concurrent guesses queue up
        // instead of overlapping.
        const gate = await admin.rpc("quote_phone_try", { jid: job.id });
        if (gate.error || gate.data !== "OK") {
          // Anything that is not a clean OK is refused, an error included: a
          // counter that did not record the attempt must not hand out a free
          // guess. Only the lockout is told apart, and only by the status
          // code the caller already got for a lockout above.
          if (gate.data === "LOCKED") {
            return json({ error: "Too many attempts. Try again in a few minutes." }, 429);
          }
          return json({ error: "Those last four digits don't match our records." }, 400);
        }

        const submitted = String(body?.phone4 ?? "").replace(/\D/g, "");
        const last4 = phoneDigits.slice(-4);
        if (submitted.length !== 4 || submitted !== last4) {
          // One sentence for "wrong digits", "no phone on file" (this branch
          // is never reached when there isn't one) and "quote not found"
          // (handled earlier, above). None of them may be told apart by
          // wording, or the wording itself becomes a way to learn the phone
          // number four attempts at a time.
          return json({ error: "Those last four digits don't match our records." }, 400);
        }
        // Right answer: a stranger's earlier near-misses on this same job
        // must not carry forward and count against the person who just got
        // it right.
        // Unconditional now: the attempt this request just spent is on the
        // row, so "there was nothing to clear" is no longer a state that can
        // happen here.
        await admin.rpc("quote_phone_clear", { jid: job.id });
      } else {
        // DECISION: a job with no phone on it cannot be gated by a phone
        // digit nobody collected. Refusing every such quote would strand a
        // real customer over a field their contractor forgot to fill in;
        // approving with no check at all -- silently -- is the exact bug
        // this feature exists to close, just moved one field over. So this
        // approval is allowed to go through unchecked, but that fact is
        // written to the row rather than left implicit, so a look at the
        // job afterwards shows the gate did not run instead of assuming it
        // did.
        approvedWithoutPhoneCheck = true;
      }
    }

    // Whether this request's approval is the one that landed. Only that one
    // tells the company's phones.
    let landed = false;
    // The timestamp this request wrote, so the contract email names the same approval.
    let approvedAtIso = "";
    let approvedBy = job.quote_approved_name || name;
    if (justApproved) {
      // The figure the page shows right now (pageFigures -- the same function
      // the view below uses) is the price being agreed to, and it is recorded
      // with the approval, in the same UPDATE, so there is never an approved
      // quote without its price or a price without its approval.
      const figures = await pageFigures(admin, job);
      if (!figures.ok) {
        return json({ error: "We could not record your approval just now. Please try again in a moment." }, 500);
      }
      // A page may say which total it showed. If the contractor changed the
      // quote while it sat open, approving must not record a price the
      // homeowner never saw: they reload, see the new figure, and approve that.
      // A page that does not send it (every page cached before this) is
      // judged by the current figure, as before.
      const seen = Number(body?.total);
      if (body?.total != null && Number.isFinite(seen) && Math.abs(seen - figures.total) > 0.5) {
        return json({
          code: "quote_changed",
          error: "This quote was updated after you opened it. Reload the page to see the current price, then approve.",
        }, 409);
      }
      // THE PRICE HAS COLLAPSED BELOW SOMETHING SHE ALREADY AGREED TO.
      //
      // Refuse, write nothing, leave the earlier agreement exactly where it
      // is, and tell the office. See the block comment on priceShortfall
      // above for what happened on 1 Oct and why this is the safe direction.
      //
      // Placed AFTER the quote_changed check on purpose: a stale page is the
      // commoner and milder problem and keeps its own, reassuring wording.
      // Placed BEFORE the signature upload so a refused approval never leaves
      // an orphan PNG in storage.
      const shortfall = canRecordAcceptance ? priceShortfall(job, figures.total) : null;
      if (shortfall) {
        console.error(
          `quote-view REFUSED an approval below an agreed price: job ${job.id} would record ` +
            `${shortfall.recording.toFixed(2)} against an agreed ${shortfall.agreed.toFixed(2)} ` +
            `(short ${shortfall.short.toFixed(2)}); priced lines on the job: ${figures.pricedLines}` +
            (figures.pricedLines === 0
              ? " -- NO PRICED LINES, so this is the 1 Oct line-item loss, not a re-price"
              : ""),
        );
        // The same phones the contract-email alarm uses: the people who may
        // see a price. Never throws, and the refusal below stands either way.
        await alarmOffice(admin, job, false, {
          title: "A customer could not approve",
          body: `${job.customer_name || "A customer"} tried to approve, but the quote now shows ` +
            `$${shortfall.recording.toFixed(2)} against $${shortfall.agreed.toFixed(2)} already agreed. ` +
            `FenceFlow refused it rather than record the lower price. ` +
            (figures.pricedLines === 0
              ? "This job holds no priced lines -- its material list is missing."
              : "Re-price the job, or capture a new signature at the new price."),
        });
        return json({
          code: "price_below_agreed",
          // No figures to the customer. She is not the one who can judge
          // which of the two prices is right, and quoting both at her would
          // invite her to pick the lower one.
          error: "We can't record an approval on this quote right now -- the price on it doesn't match " +
            "what was agreed. Your contractor has been told and will be in touch. Nothing you had " +
            "already agreed to has changed.",
        }, 409);
      }
      // The drawing lands in storage BEFORE the approval row does, so a
      // successful UPDATE never points at bytes that don't exist. Scoped by
      // company and job the same way FileSync.kt scopes every other kind it
      // writes to this bucket, under a new "quote-signature" kind so it is
      // never confused with the crew's own write-once "signature" uploads.
      // If the upload fails, the whole approval refuses rather than record a
      // name with no drawing behind it when one was promised.
      let signaturePath: string | null = null;
      if (signatureBytes) {
        signaturePath = `${job.company_id}/${job.sync_id}/quote-signature/${Date.now()}.png`;
        const uploaded = await admin.storage.from("job-files")
          .upload(signaturePath, signatureBytes, { contentType: "image/png", upsert: false });
        if (uploaded.error) {
          console.error("quote-view signature upload", uploaded.error.message);
          return json({ error: "We could not save your signature just now. Please try again, or type your name instead." }, 500);
        }
      }
      const approval = {
        quote_approved_at: new Date().toISOString(),
        quote_approved_name: name,
        // Same UPDATE as the name and timestamp above -- never a signature
        // recorded without an approval, or an approval that silently drops
        // the signature it was sent with.
        ...(signaturePath ? { quote_approved_signature_path: signaturePath } : {}),
        ...(approvedWithoutPhoneCheck ? { quote_approved_without_phone_check: true } : {}),
        // Approval is acceptance. DRAFT/SENT move forward; anything already
        // further along (deposit paid, completed) is left exactly where it is.
        ...(["DRAFT", "SENT"].includes(job.status) ? { status: "ACCEPTED" } : {}),
      };
      // First signature wins, in the database rather than by the read above:
      // two approvals in flight at once both saw "not approved yet", and the
      // second used to overwrite the first's name. Only a row still
      // unapproved is written.
      const write = (fields: Record<string, unknown>) =>
        admin.from("jobs").update(fields).eq("id", job.id).is("quote_approved_at", null).select("id");
      let written = await write(canRecordAcceptance ? { ...approval, accepted_total: figures.total } : approval);
      if (written.error && lacksAcceptanceColumns(written.error)) written = await write(approval);
      // This used to be fire-and-forget: a failed write still answered "ok",
      // and the homeowner saw a thank-you for an approval that never landed.
      if (written.error) {
        console.error("quote-view approve", written.error.message);
        return json({ error: "We could not record your approval just now. Please try again in a moment." }, 500);
      }
      landed = (written.data ?? []).length > 0;
      if (landed) approvedAtIso = approval.quote_approved_at;
      if (!landed) {
        // Somebody else's approval landed first. Theirs stands; say whose.
        const { data: now } = await admin.from("jobs").select("quote_approved_name").eq("id", job.id).maybeSingle();
        approvedBy = now?.quote_approved_name || approvedBy;
      }
    }
    // The whole point of an approval is somebody hearing about it. Every
    // phone that can open this job gets the push the moment the name goes on
    // the record; failures are swallowed because the approval itself must
    // never fail for want of a notification.
    //
    // Only on the approval that actually landed, though. This sat outside the
    // guard above and fired on every request, with an attacker-supplied name
    // at the front of it -- so anyone holding a forwarded quote link could
    // buzz every phone in the company in a loop until the crew turned
    // notifications off and stopped seeing real job alerts.
    //
    // And only the people who can open the job: the same audience as
    // notify-job-change's "Quote accepted" (../_shared/push-recipients.ts).
    // It carries no amount, so the crew on this job are told too; crew on
    // other jobs are not. Until 2026-09-22 it went to every device in the
    // company. The lead is read here because the quote's own read does not
    // select it; if that read fails the lead is simply not told.
    if (landed) try {
      const sa = JSON.parse(Deno.env.get("FIREBASE_SERVICE_ACCOUNT") ?? "null");
      if (sa) {
        const { data: lead } = await admin
          .from("jobs").select("assigned_employee_sync_id").eq("id", job.id).maybeSingle();
        const toks = await jobDevices(admin, job.company_id,
          standingJobEvent({ ...job, assigned_employee_sync_id: lead?.assigned_employee_sync_id }, "ACCEPTED"));
        if (toks.length) {
          await fcmNotify(sa, toks, "Quote approved 🎉", `${name} approved the quote for ${job.customer_name || "the job"}.`);
        }
      }
    } catch (_e) { /* the approval stands regardless */ }

    // The contract, by email, to the address on the job -- only for the approval that landed (a re-opened
    // link, a second tab or a forwarded copy never gets here with landed true). The approval is already
    // written and nothing below can unwrite it: emailTheContract never throws and never changes the status.
    const contractEmail = landed
      ? await emailTheContract(admin, job, body?.lang, req.headers.get("accept-language"), approvedAtIso)
      : null;

    return json({ ok: true, approvedBy, ...(contractEmail ? { contractEmail } : {}) });
  }

  // ---------------------------------------------------------------- view ---
  // WHICH fence line changed, for the re-approval notice.
  //
  // jobs.reapproval_reason is already on the row and was tried first. It is a
  // full English sentence written by the trigger, and the page's own notice
  // already says the same two things in the reader's language -- the drawing
  // changed, approve again -- so printing it gave a Spanish reader the request
  // twice with half of it in English. The run's label is the one part they did
  // not already have, and a name the owner typed reads the same in every
  // language, so that is what goes on the wire.
  //
  // Newest unresolved withdrawal, matching what the notice is about. Empty
  // string when there is none, or when the run had no label -- the page falls
  // back to its plain wording rather than printing an empty gap.
  let reapprovalRunLabel = "";
  if (job.reapproval_required_at) {
    const { data: withdrawal } = await admin
      .from("quote_reapprovals")
      .select("run_label")
      .eq("job_id", job.id)
      .is("resolved_at", null)
      .order("at", { ascending: false })
      .limit(1)
      .maybeSingle();
    reapprovalRunLabel = String(withdrawal?.run_label ?? "").trim();
  }

  const [{ data: company }, figures, { data: runs }, { data: houseMarkers }, { data: conn },
         signatureUrl, paymentMethods] =
    await Promise.all([
      admin.from("companies").select("name, phone, email").eq("id", job.company_id).single(),
      pageFigures(admin, job),
      admin.from("fence_runs")
        .select("label, fence_type, color_or_finish, points_encoded, gates_encoded, " +
          "closed_loop, panel_height_ft, post_spacing_ft, manual_linear_feet, " +
          "wood_style, aluminum_style, fabric_height_ft, split_rail_count, is_teardown")
        .eq("company_id", job.company_id)
        .eq("job_sync_id", job.sync_id).is("deleted_at", null),
      // WHERE THE HOUSE IS. The page centres the aerial photo on the geocoded
      // address, and the address is the house -- so without this the fence can
      // only be drawn through the middle of it, which is how a back-yard fence
      // came to read as a fence across the front.
      //
      // kind = HOUSE and nothing else, on purpose. The other eight kinds are
      // the contractor's own notes about the site -- an easement he cannot
      // build in, a utility he has to dig around -- and a customer's quote
      // link is not where those belong. x/y only: a marker's free-text label
      // is his note to himself too.
      //
      // Same scoping as the runs read directly above (company + job sync id,
      // not-deleted) and the same admin client, so this reaches exactly the
      // rows that quote already shows a drawing of. No policy changes.
      admin.from("site_markers")
        .select("kind, x, y")
        .eq("company_id", job.company_id)
        .eq("job_sync_id", job.sync_id)
        .eq("kind", "HOUSE").is("deleted_at", null),
      admin.from("payment_connections")
        .select("processor, external_id, access_token")
        .eq("company_id", job.company_id).maybeSingle(),
      // Only ever set when canRecordSignature read it in the first place, so
      // this is never asked to sign a path from a column this deploy cannot
      // see.
      canRecordSignature ? approvedSignatureUrl(admin, job.quote_approved_signature_path) : Promise.resolve(null),
      // Its own read, deliberately NOT a column added to the companies select
      // above: that select answers for the company's name, and a database
      // without payment settings (or a failed read) must never blank it.
      readPaymentMethods(admin, job.company_id),
    ]);

  // The first open is worth knowing about; later opens are just reading.
  if (!job.quote_viewed_at) {
    await admin.from("jobs").update({ quote_viewed_at: new Date().toISOString() })
      .eq("id", job.id);
  }

  // The price and the deposit: pageFigures, the one function the approve
  // step above records from.
  const { total, money } = figures;
  const deposit = money.asked;

  // Whether pressing Approve would be refused (priceShortfall above). Sent so
  // the page can say so instead of offering a button that answers 409: on two
  // of the three affected jobs the customer has already opened her link, and
  // the first thing she would do is press it. A code, never the two figures --
  // see the refusal above for why she is not shown them.
  const approvalBlocked = (canRecordAcceptance && !job.quote_approved_at && priceShortfall(job, total))
    ? "price_below_agreed"
    : null;

  // Whether the deposit button can do anything. A connected processor means
  // create-payment-link's token path will produce a real checkout.
  const paymentsReady = !!(conn && (
    (conn.processor === "square" && conn.access_token && conn.external_id) ||
    (conn.processor === "stripe" && conn.external_id)
  ));

  return json({
    company: { name: company?.name ?? "", phone: company?.phone ?? "", email: company?.email ?? "" },
    customerName: job.customer_name,
    address: job.address,
    // Deliberately NO line items. The parts list -- 103 bags of concrete at
    // $4.75, panels at $52.35 -- is the contractor's working, and handing it
    // over invites pricing the job from a hardware-store receipt. The
    // customer buys a fence, not a bill of materials: they get what they are
    // getting and what it costs, enforced here rather than hidden by CSS.
    //
    // subtotal, tax and taxRate used to ride along in this object. Nothing on
    // the page ever read them, and subtotal IS the material cost -- so anyone
    // who opened the browser's network tab, or anyone the link was forwarded
    // to, could subtract it from the total and read the labour and margin
    // before sitting down to negotiate. The comment above was already the
    // right rule; the line under it was breaking it.
    total,
    deposit,
    // What pressing the button would actually collect. Differs from
    // [deposit] once part of it has been paid, and the page needs both: the
    // deposit is what was agreed, the amount due is what is left.
    depositDue: money.due,
    depositPayable: money.payable,
    // What is left on the whole job. The page used to subtract the deposit
    // ASKED from the total and call that the balance, which is a different
    // number from the one every other surface shows and contradicted the
    // page's own "paid in full" line. One label, one meaning.
    balanceDue: money.balance,
    approvedAt: job.quote_approved_at,
    // The drawing changed after this quote was approved, so the approval was
    // withdrawn and the customer has to say yes again. The page shows this
    // above the approve button; the approve step itself is unchanged -- same
    // phone gate, same typed name, same link.
    reapprovalRequiredAt: job.reapproval_required_at,
    // The label only, never jobs.reapproval_reason: see the comment where this
    // is read. Sending the sentence too would just invite the page to print it.
    reapprovalRunLabel,
    // "price_below_agreed", or null. Set when approving would be refused
    // because the price on this quote has fallen below a figure already
    // agreed. The page draws a notice and hides the approve controls.
    approvalBlocked,
    // Whether the approve step needs to ask for the last four digits of the
    // job's phone number. A boolean saying a phone is on file is not the
    // phone number -- this is the one fact about it the page is allowed to
    // hold, and it is not enough to guess the digits from.
    phoneGateRequired: String(job.phone ?? "").replace(/\D/g, "").length >= 4,
    // The survey canvas draws on a 20px/ft grid unless the job was calibrated
    // against a known measurement; the 3D view must use the same number or
    // the fence is built at the wrong size entirely.
    pxPerFoot: Number(job.calibration_pixels_per_foot) || 20,
    approvedBy: job.quote_approved_name,
    // Whether this deploy can actually store a drawn signature right now --
    // false until supabase_quote_signature_patch.sql is applied. The page
    // shows the "draw your signature" option only when this is true, so a
    // customer is never offered a control that would silently drop what they
    // drew.
    signatureCaptureReady: canRecordSignature,
    // A short-lived signed URL, never the raw storage path -- job-files is a
    // private bucket. Null before an approval, or when it was typed rather
    // than drawn.
    approvedSignatureUrl: signatureUrl,
    paymentsReady,
    // How else this company asks to be paid. Public by design -- see
    // publicPaymentMethods() for exactly what, and why bank details are in it.
    // Left out entirely when the read failed; "" / false per method otherwise.
    // There is NO card-fee field: create-payment-link adds no fee to a
    // customer's payment (stripeFee = 0), so nothing here may say there is one.
    ...(paymentMethods ? { paymentMethods } : {}),
    // Teardown runs ride along too. The old fence is half the sales pitch:
    // the customer sees the weathered thing they hate standing in the yard,
    // then removes it with one tap and looks at the new one alone.
    runs: (runs ?? []).map((r) => ({
      teardown: !!r.is_teardown,
      label: r.label,
      type: r.fence_type,
      finish: r.color_or_finish,
      points: r.points_encoded,
      gates: r.gates_encoded,
      closed: !!r.closed_loop,
      heightFt: Number(r.panel_height_ft) || Number(r.fabric_height_ft) || 6,
      postSpacingFt: Number(r.post_spacing_ft) || 8,
      manualFeet: Number(r.manual_linear_feet) || 0,
      woodStyle: r.wood_style, aluminumStyle: r.aluminum_style,
      splitRails: Number(r.split_rail_count) || 2,
    })),
    // The house, in the same drawing pixels as a run's points, so the page can
    // put the address under it instead of under the fence's middle. Normally
    // one row or none; the page refuses to guess when there are two (see
    // sceneHouseAnchor) and says on screen that the position is approximate.
    markers: (houseMarkers ?? []).map((m) => ({
      kind: String(m.kind),
      x: Number(m.x) || 0,
      y: Number(m.y) || 0,
    })),
  });
});
