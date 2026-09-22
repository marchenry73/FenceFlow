// Asks a homeowner to pay a deposit or an invoice.
//
// This is payment for a physical service, so it is allowed to live inside the
// Android app -- Google Play billing rules do not apply and Google takes no
// cut. Only the FenceFlow subscription itself has to stay on the website.
//
// Secrets: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import {
  CHANGE_ORDER_COLUMNS,
  CHANGE_ORDER_COLUMNS_BEFORE_ACCEPTANCE_FLAG,
  changeOrderInputs,
  depositFigures,
  missingAcceptanceFlag,
} from "../_shared/quote-deposit.ts";
import type { ChangeOrderInput } from "../_shared/quote-deposit.ts";

const STRIPE = "https://api.stripe.com/v1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

// ---- the price the customer accepted -------------------------------------
//
// jobs.accepted_total (supabase_r6_price_stability.sql) is what the customer
// agreed to pay: the quote page's total when they approved online, the
// signed figure when they signed on the phone. While that acceptance stands,
// the balance and every cap below are measured against it -- plus change
// orders signed since -- and not against contract_total, which old phone
// builds went on moving after acceptance: job 4598 was signed at $9,710 and
// asked against $13,410, Marco was signed at $19,810 with a $10,930 link
// against $9,300. The rule is billableTotal in _shared/quote-deposit.ts,
// reached through depositFigures().total, so this file and quote-view (which
// shows the homeowner the same figures) read exactly one rule.

/**
 * Read beside a job's money whenever it is billed. quote_approved_at is not
 * here because both reads below already select it.
 */
const ACCEPTANCE_COLUMNS = "accepted_total, signed_at, reapproval_required_at";

/**
 * Whether a read failed only because this database has no accepted_total yet
 * -- the function deployed before the migration. The caller then reads its
 * old column list and bills against contract_total exactly as it did before,
 * instead of refusing every link until the SQL lands.
 */
export function lacksAcceptanceColumns(error: { message?: string } | null | undefined): boolean {
  return /accepted_total/.test(String(error?.message ?? ""));
}

type AcceptanceRow = {
  accepted_total?: number | string | null;
  signed_at?: string | null;
  quote_approved_at?: string | null;
  reapproval_required_at?: string | null;
};

/**
 * The acceptance half of depositFigures' input for one job. The change orders
 * are read only when an accepted figure is recorded -- they matter to no
 * other job, so a job accepted before accepted_total existed costs no extra
 * read and gains no new way to fail. Null when they were needed and could not
 * be read: the caller refuses, like every other failed read here, rather than
 * billing a total that silently leaves signed extra work out.
 */
async function acceptanceFor(
  admin: ReturnType<typeof createClient>,
  companyId: string,
  jobSyncId: string,
  job: AcceptanceRow,
): Promise<{
  acceptedTotal: number | null;
  signedAt: string | null;
  quoteApprovedAt: string | null;
  reapprovalRequiredAt: string | null;
  changeOrders: ChangeOrderInput[];
} | null> {
  const acceptedTotal = job.accepted_total == null ? null : Number(job.accepted_total);
  let changeOrders: ChangeOrderInput[] = [];
  if (acceptedTotal != null) {
    // in_accepted_total says which orders the accepted price already
    // contains, so they are not billed on top of it a second time. A
    // database without the column yet is read the old way.
    const read = (columns: string) => admin
      .from("change_orders")
      .select(columns)
      .eq("company_id", companyId)
      .eq("job_sync_id", jobSyncId);
    let { data, error } = await read(CHANGE_ORDER_COLUMNS);
    if (error && missingAcceptanceFlag(error)) ({ data, error } = await read(CHANGE_ORDER_COLUMNS_BEFORE_ACCEPTANCE_FLAG));
    if (error || !Array.isArray(data)) return null;
    changeOrders = changeOrderInputs(data);
  }
  return {
    acceptedTotal,
    signedAt: job.signed_at ?? null,
    quoteApprovedAt: job.quote_approved_at ?? null,
    reapprovalRequiredAt: job.reapproval_required_at ?? null,
    changeOrders,
  };
}

/** Stripe's API is form-encoded, not JSON. */
async function stripe(path: string, form: Record<string, string>, account?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  // When the company has connected its own Stripe account, the charge is
  // created on that account so the money lands with them, not with us.
  if (account) headers["Stripe-Account"] = account;

  const res = await fetch(`${STRIPE}${path}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(form),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? "Stripe rejected the request");
  return body;
}

/** Stripe's reads are GETs with the parameters in the query string. */
async function stripeGet(path: string, query: Record<string, string>) {
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${STRIPE}${path}${qs ? `?${qs}` : ""}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}` },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? "Stripe rejected the request");
  return body;
}

// ---- links already open on the job ---------------------------------------
//
// A job could carry several live payment links at once, and the over-owed cap
// below only counted money that had already SETTLED. Two links that each
// passed on their own could together ask the customer for more than the job
// owes -- on 2026-09-21 one $200 job held a $336.82 balance link and a $160
// deposit link, both payable, and another held two identical $4,937.93 links
// four minutes apart. Stripe payment links do not expire.
//
// Two rules now, both here rather than in any client:
//
//  * The cap counts what is already being asked for. Settled money, plus the
//    links that will stay open, plus this request, may not exceed what the job
//    owes.
//  * A new link REPLACES the open ones of the same kind on the same job. The
//    old link is switched off at the processor first, and only then is its row
//    marked superseded. If the processor will not confirm, no new link is
//    made: a row reading "superseded" while its link still takes money is
//    worse than two honest rows, and two live links is the fault itself.

/** One open (status = pending) job_payments row, as makeLink reads it. */
type OpenLink = {
  id: string;
  kind: string;
  amount_cents: number | string;
  processor?: string | null;
  livemode?: boolean | null;
  stripe_id?: string | null;
  external_id?: string | null;
};

type LivePair = { stripe: boolean; square: boolean };

type LinkPlan =
  | { ok: true; replace: OpenLink[] }
  | { ok: false; code: string; stillOwedCents: number; openCents: number };

/**
 * Whether each processor is taking real money right now. Read from the key's
 * own prefix and the Square environment -- never logged.
 */
function liveNow(): LivePair {
  const key = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  return {
    stripe: /^(sk|rk)_live_/.test(key),
    square: (Deno.env.get("SQUARE_ENVIRONMENT") ?? "sandbox") === "production",
  };
}

/**
 * Can this open link still take money that would count against the job?
 *
 * A test-mode link cannot once the processor is running live: it accepts only
 * test cards, and the webhooks refuse to book a test payment into the ledger
 * (record-payment.ts, stripe-webhook's livemode check), so it can never move
 * what the job owes. Everything else counts -- including a live link while
 * the key is a test key, and a processor this function does not recognise.
 */
export function stillTakesMoney(row: OpenLink, live: LivePair): boolean {
  const processor = String(row?.processor ?? "stripe").toLowerCase();
  const runningLive = processor === "square" ? live.square
    : processor === "stripe" ? live.stripe
    : false;
  return !(runningLive && row?.livemode !== true);
}

/**
 * Was this link made in the mode its processor is running in right now?
 *
 * Stricter than stillTakesMoney, which also counts a live link under a test
 * key (it could still take real money, so the cap must see it). Handing a link
 * BACK needs the modes to match exactly: a test link under a live key declines
 * every real card, and a live link under a test key charges one while we are
 * not recording real money. A missing livemode reads as test, as it does
 * everywhere else here. A processor this function does not know never matches.
 */
export function sameModeAsKey(row: OpenLink, live: LivePair): boolean {
  const processor = String(row?.processor ?? "stripe").toLowerCase();
  const runningLive = processor === "square" ? live.square
    : processor === "stripe" ? live.stripe
    : null;
  if (runningLive === null) return false;
  return (row?.livemode === true) === runningLive;
}

/** A pending row the hand-back lookup found: an open link plus its URL. */
type ReuseCandidate = OpenLink & { payment_url?: string | null };

/**
 * Pure apart from the check it is handed. Picks the open link that may be
 * handed back as it is, or null when none may.
 *
 * A row qualifies only if it was made in the processor's current mode (see
 * sameModeAsKey), can still take money (stillTakesMoney), and the processor
 * itself confirms, when asked now, that the link is still active. The mode
 * test runs first and costs nothing, so a live key is never sent to ask about
 * a test-mode link it cannot see.
 *
 * A check that throws is a no, never a yes: the caller then makes a new link
 * under the normal cap and replacement rules, which retire the rows passed
 * over here. So nothing that fails this test can block a correct new link.
 */
export async function pickReusableLink(
  rows: ReuseCandidate[],
  live: LivePair,
  confirmActive: (row: ReuseCandidate) => Promise<boolean>,
): Promise<ReuseCandidate | null> {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.payment_url) continue;
    if (!sameModeAsKey(row, live) || !stillTakesMoney(row, live)) continue;
    let active = false;
    try {
      active = (await confirmActive(row)) === true;
    } catch (e) {
      console.error("create-payment-link reuse check", row?.id, e instanceof Error ? e.message : String(e));
      active = false;
    }
    if (active) return row;
  }
  return null;
}

/**
 * Stripe: is this payment link still active, in the key's own mode? A read
 * only -- nothing is changed. Stripe will not show a key an object from the
 * other mode, so a mismatch normally fails the read; the livemode test is here
 * in case the row's own record of its mode is wrong.
 */
async function stripeLinkStillActive(row: OpenLink, live: LivePair): Promise<boolean> {
  const id = String(row.stripe_id ?? "").trim();
  if (!id.startsWith("plink_")) return false;
  const link = await stripeGet(`/payment_links/${encodeURIComponent(id)}`, {});
  return link?.id === id && link?.active === true && (link?.livemode === true) === live.stripe;
}

/**
 * Square: is the order behind this link still OPEN on the connected account?
 * Deleting a Square payment link cancels its order and paying it completes
 * the order, so OPEN is the state in which the link still takes money. The row
 * keeps the order id, which is what this reads. Without the current Square
 * token there is no way to ask, and that is a no.
 */
async function squareLinkStillActive(
  row: OpenLink,
  host: string,
  token: string | null | undefined,
): Promise<boolean> {
  if (!token) return false;
  const orderId = String(row.external_id ?? "").trim();
  if (!orderId) return false;
  const res = await fetch(`${host}/v2/orders/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Bearer ${token}`, "Square-Version": "2025-01-23" },
  });
  const body = await res.json().catch(() => ({}));
  return res.ok && String(body?.order?.id ?? "") === orderId && body?.order?.state === "OPEN";
}

/**
 * Pure. Decides whether a request may go ahead, given the job's settled money
 * and the links already open on it, and which open links it would replace.
 *
 * Same-kind links are not counted: they are the ones this request replaces,
 * and counting them would refuse every corrected deposit. Other kinds stay
 * open, so they are counted -- unless they can no longer take real money.
 *
 * Silent when the contract total is unknown, exactly as before: a job with no
 * total yet is normal early on. The replacement still happens then.
 */
export function planOpenLinks(
  job: { contract_total?: unknown; amount_paid?: unknown; refunded_amount?: unknown } | null,
  open: OpenLink[],
  request: { kind: string; amountCents: number },
  live: LivePair,
): LinkPlan {
  const rows = Array.isArray(open) ? open : [];
  const replace = rows.filter((r) => String(r.kind) === String(request.kind));
  const staying = rows.filter((r) =>
    String(r.kind) !== String(request.kind) && stillTakesMoney(r, live));
  const openCents = staying.reduce(
    (sum, r) => sum + Math.max(0, Math.round(Number(r.amount_cents) || 0)), 0);

  const contractTotal = Number(job?.contract_total ?? 0);
  if (contractTotal > 0) {
    const netPaid = Math.max(0,
      Number(job?.amount_paid ?? 0) - Number(job?.refunded_amount ?? 0));
    // Dollars in the jobs table, cents on the wire. Getting this backwards
    // would either refuse every honest request or cap nothing at all.
    const stillOwedCents = Math.round((contractTotal - netPaid) * 100);
    if (stillOwedCents <= 0) {
      return { ok: false, code: "paid_in_full", stillOwedCents, openCents };
    }
    // A pound of slack for rounding between the two units, and no more.
    if (request.amountCents + openCents > stillOwedCents + 100) {
      return {
        ok: false,
        code: openCents > 0 ? "over_owed_with_open_links" : "over_owed",
        stillOwedCents,
        openCents,
      };
    }
  }
  return { ok: true, replace };
}

/**
 * Switches off each link and only then marks its row superseded, in that
 * order, stopping at the first failure. The processor calls and the database
 * write are passed in, so the ordering is testable without either.
 *
 * A link that can no longer take money (see stillTakesMoney) is marked without
 * a processor call: a live key cannot even see a test-mode link to switch it
 * off, and refusing on that would block every replacement after go-live.
 *
 * markSuperseded answers false when the row was no longer pending -- it was
 * paid, or another request replaced it, in the moment between reading and
 * writing. That also stops: the cap was worked out against a state that has
 * just changed.
 */
export async function supersedeOpenLinks(
  rows: OpenLink[],
  deps: {
    takesMoney: (row: OpenLink) => boolean;
    switchOff: (row: OpenLink) => Promise<void>;
    markSuperseded: (row: OpenLink) => Promise<boolean>;
  },
): Promise<{ ok: true; ids: string[] } | { ok: false; code: string; row: OpenLink; detail: string }> {
  const ids: string[] = [];
  for (const row of rows) {
    if (deps.takesMoney(row)) {
      try {
        await deps.switchOff(row);
      } catch (e) {
        return { ok: false, code: "old_link_still_open", row, detail: e instanceof Error ? e.message : String(e) };
      }
    }
    let marked = false;
    try {
      marked = await deps.markSuperseded(row);
    } catch (e) {
      return { ok: false, code: "old_link_not_recorded", row, detail: e instanceof Error ? e.message : String(e) };
    }
    if (!marked) {
      return { ok: false, code: "open_link_changed", row, detail: "the earlier request was no longer open" };
    }
    ids.push(String(row.id));
  }
  return { ok: true, ids };
}

/**
 * Stripe: deactivate the Payment Link, then expire any checkout already opened
 * from it. Deactivating only stops NEW visits to the URL; a customer who
 * already had the checkout page open could otherwise still pay it.
 */
async function switchOffStripeLink(row: OpenLink): Promise<void> {
  const id = String(row.stripe_id ?? "").trim();
  if (!id.startsWith("plink_")) {
    throw new Error("the earlier link has no Stripe payment link id on record");
  }
  const link = await stripe(`/payment_links/${encodeURIComponent(id)}`, { active: "false" });
  if (link?.active !== false) {
    throw new Error("Stripe did not confirm the earlier link is switched off");
  }
  const open = await stripeGet("/checkout/sessions", { payment_link: id, status: "open", limit: "100" });
  for (const s of open?.data ?? []) {
    await stripe(`/checkout/sessions/${encodeURIComponent(String(s?.id ?? ""))}/expire`, {});
  }
  if (open?.has_more) {
    throw new Error("the earlier link has more open checkouts than one pass can close");
  }
}

/**
 * Square: delete the payment link, which also cancels its order.
 *
 * The row keeps the ORDER id (that is what Square's webhook reports), not the
 * link id DELETE needs, so the link is found by listing. A link that is not in
 * a complete listing counts as gone only if its order reads CANCELED on this
 * same account -- a listing from a different, reconnected Square account would
 * also come back without it, and that must not read as "switched off".
 */
async function switchOffSquareLink(
  row: OpenLink,
  host: string,
  token: string | null | undefined,
): Promise<void> {
  if (!token) {
    throw new Error("Square is no longer connected, so the earlier Square link cannot be switched off");
  }
  const orderId = String(row.external_id ?? "").trim();
  if (!orderId) throw new Error("the earlier link has no Square order id on record");
  const headers = { Authorization: `Bearer ${token}`, "Square-Version": "2025-01-23" };

  let linkId = "";
  let cursor = "";
  let pages = 0;
  do {
    const q = new URLSearchParams({ limit: "1000" });
    if (cursor) q.set("cursor", cursor);
    const res = await fetch(`${host}/v2/online-checkout/payment-links?${q}`, { headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body?.errors?.[0]?.detail ?? "Square would not list the payment links");
    }
    linkId = String((body?.payment_links ?? [])
      .find((l: any) => String(l?.order_id ?? "") === orderId)?.id ?? "");
    cursor = String(body?.cursor ?? "");
    pages++;
  } while (!linkId && cursor && pages < 20);

  if (linkId) {
    const res = await fetch(`${host}/v2/online-checkout/payment-links/${encodeURIComponent(linkId)}`, {
      method: "DELETE",
      headers,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body?.errors?.[0]?.detail ?? "Square would not delete the earlier payment link");
    }
    return;
  }
  if (cursor) throw new Error("Square has too many payment links to find the earlier one");

  const res = await fetch(`${host}/v2/orders/${encodeURIComponent(orderId)}`, { headers });
  const body = await res.json().catch(() => ({}));
  if (res.ok && body?.order?.state === "CANCELED") return;
  throw new Error("Square has no payment link for the earlier request and its order is not cancelled");
}

/** The refusal each plan or replacement failure turns into, per door. */
function openLinkRefusal(
  code: string,
  facts: { stillOwedCents?: number; openCents?: number; kind?: string; amountCents?: number; detail?: string },
  publicDoor: boolean,
): Response {
  const d = (cents: number | undefined) => (Number(cents ?? 0) / 100).toFixed(2);
  const status = code === "open_link_changed" ? 409
    : code === "old_link_still_open" || code === "old_link_not_recorded" ? 502
    : 400;
  // The homeowner's quote page is trilingual and shows its own translated
  // "could not open the payment page" sentence whenever no error text comes
  // back. None of these has anything the homeowner can act on except asking
  // their contractor, so they get that sentence in their own language rather
  // than a paragraph in English written for the office.
  if (publicDoor) return json({ code }, status);

  const still = d(facts.stillOwedCents);
  const open = d(facts.openCents);
  const room = Number(facts.stillOwedCents ?? 0) - Number(facts.openCents ?? 0);
  const earlier = `The earlier ${facts.kind ?? ""} link on this job (${d(facts.amountCents)})`;
  const messages: Record<string, string> = {
    over_owed_with_open_links: room >= 50
      ? `This job still owes ${still}, and payment links already open on it ask for ${open}, ` +
        `so a new link can ask for at most ${d(room)}. Check the amount before asking the customer for it.`
      : `Payment links already open on this job ask for ${open}, which covers everything it still owes ` +
        `(${still}). Another link would ask the customer for more than they owe.`,
    old_link_still_open:
      `${earlier} could not be switched off, so a new one was not made -- two open links could ask ` +
      `the customer for more than they owe. Try again in a moment. (${facts.detail ?? ""})`,
    old_link_not_recorded:
      `${earlier} was switched off but could not be recorded as replaced, so a new one was not made. ` +
      `Try again in a moment.`,
    open_link_changed:
      `${earlier} changed while this one was being made -- it may just have been paid. ` +
      `Reload the job and check what is still owed before asking again.`,
  };
  return json({ code, error: messages[code] ?? "Could not make the payment link. Try again." }, status);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => ({}));
    // Which door the caller came through decides what an error may say.
    let publicDoor = false;

    // ---- door two: a homeowner holding a quote link ----------------------
    //
    // The token authorises exactly one thing: paying THIS job's own deposit
    // or balance. The amount comes from the job row, never from the request
    // -- a homeowner picks whether to pay, not how much a deposit is.
    if (body?.quoteToken) {
      publicDoor = true;
      const tok = String(body.quoteToken).trim();
      if (!/^[0-9a-f-]{36}$/.test(tok)) return json({ error: "That link is not valid." }, 400);
      const tokenColumns =
        "sync_id, company_id, customer_name, deposit_amount, contract_total, amount_paid, refunded_amount, deleted_at, quote_approved_at";
      let { data: qjob, error: qjobError } = await admin
        .from("jobs")
        .select(`${tokenColumns}, ${ACCEPTANCE_COLUMNS}`)
        .eq("quote_token", tok).maybeSingle();
      if (qjobError && lacksAcceptanceColumns(qjobError)) {
        ({ data: qjob } = await admin.from("jobs").select(tokenColumns).eq("quote_token", tok).maybeSingle());
      }
      if (!qjob || qjob.deleted_at) return json({ error: "That quote is no longer available." }, 404);

      // Paying is a commitment, so it goes behind the same door as approving.
      //
      // Approving now asks for the last four digits of the phone on the job,
      // because a forwarded link let anyone commit to thousands of dollars.
      // This door never checked anything of the kind: it took a token and
      // handed back a live checkout page. The page happens to approve first,
      // but that ordering lived only in the page's own JavaScript -- a request
      // sent straight to this function skipped it entirely, and produced a
      // real payment link for a job nobody had agreed to buy.
      //
      // Requiring the approval stamp closes it without a second copy of the
      // phone check: nothing can be approved without passing that, so nothing
      // can be paid without having passed it either.
      //
      // Same wording as an unavailable quote, deliberately. A stranger
      // probing tokens learns nothing from the difference between "no such
      // quote" and "that one has not been approved yet".
      if (!qjob.quote_approved_at) {
        return json({ error: "That quote is no longer available." }, 404);
      }

      const kindWanted = body.kind === "balance" ? "balance" : "deposit";
      // What is actually still owed, for either button.
      //
      // The deposit branch used to ignore money already received entirely, so
      // the quote page went on offering the same deposit after it had been
      // paid -- and pressing it charged the homeowner a second time for the
      // same thing. A deposit is a part of the price, not a separate fee, so
      // it is reduced by what has come in exactly as the balance is, and can
      // never exceed the total of the job.
      // The deposit half of this is the shared rule, so what the quote page
      // shows and what this charges cannot come apart again.
      //
      // Both halves are measured against what the customer accepted while
      // that acceptance stands (depositFigures().total -- see the top of this
      // file), so the balance a homeowner pays is the price they agreed to
      // plus the extra work they signed for, never a later recompute.
      const acceptance = await acceptanceFor(admin, qjob.company_id, qjob.sync_id, qjob);
      if (!acceptance) {
        console.error("create-payment-link change orders unreadable", qjob.sync_id);
        return json({ code: "owed_unreadable" }, 500);
      }
      const netPaid = (Number(qjob.amount_paid) || 0) - (Number(qjob.refunded_amount) || 0);
      const deposit = depositFigures({
        depositAmount: qjob.deposit_amount,
        contractTotal: qjob.contract_total,
        amountPaid: qjob.amount_paid,
        refundedAmount: qjob.refunded_amount,
        ...acceptance,
      });
      const total = deposit.total;
      const dollars = kindWanted === "deposit"
        ? deposit.due
        : Math.max(0, total - netPaid);
      const cents = Math.round(dollars * 100);
      if (cents < 50) return json({ error: "There is nothing to pay on this quote yet." }, 400);

      return await makeLink(admin, {
        companyId: qjob.company_id,
        jobSyncId: qjob.sync_id,
        amount: cents,
        kind: kindWanted,
        description: "Fence work — " + (qjob.customer_name || "deposit"),
        publicDoor: true,
      });
    }

    // ---- door one: the office, signed in ---------------------------------
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "No login sent with the request" }, 401);

    // Validate the caller's token explicitly. Handing the header to a client
    // and calling getUser() with no argument does not reliably read it, which
    // is why a properly signed-in user was still being told "Not signed in".
    // The identity always comes from the token, never from the request body --
    // otherwise anyone could bill on behalf of any company.
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    const { data: userData, error: authError } = await admin.auth.getUser(jwt);
    const uid = userData?.user?.id;
    if (!uid) {
      return json({ error: `Login not accepted: ${authError?.message ?? "unknown"}` }, 401);
    }

    const { data: profile } = await admin
      .from("profiles").select("company_id, role").eq("id", uid).single();
    if (!profile?.company_id) return json({ error: "No company" }, 403);
    if (!["OWNER", "MANAGER"].includes(profile.role)) {
      return json({ error: "Only an owner or manager can request payment" }, 403);
    }

    const { jobSyncId, amountCents, kind = "deposit", description = "Fence work" } = body;

    const amount = Math.round(Number(amountCents));
    if (!jobSyncId || !Number.isFinite(amount) || amount < 50) {
      return json({ error: "Amount must be at least $0.50" }, 400);
    }

    return await makeLink(admin, {
      companyId: profile.company_id, jobSyncId, amount, kind, description,
    });
  } catch (e) {
    // The real reason goes to the function log, where somebody who can act
    // on it will read it. A homeowner holding a quote link gets a sentence
    // written for them; a signed-in contractor gets the processor's own
    // wording, which is usually the instruction they need ("reconnect
    // Square"). Neither gets a table name.
    console.error("create-payment-link", (e as Error).message);
    return json({
      error: publicDoor
        ? "Could not open the payment page right now. Please try again in a moment, or contact your contractor."
        : (e as Error).message,
    }, 500);
  }
});

/**
 * The one implementation of "produce a checkout for this job on this
 * company's own processor" -- both doors land here, so the homeowner's
 * deposit and the office's request cannot drift apart.
 */
async function makeLink(
  admin: ReturnType<typeof createClient>,
  a: { companyId: string; jobSyncId: string; amount: number; kind: string; description: string; publicDoor?: boolean },
): Promise<Response> {
  try {
    const profile = { company_id: a.companyId };
    const { jobSyncId, amount, kind, description } = a;
    const publicDoor = a.publicDoor === true;

    const { data: company } = await admin
      .from("companies").select("name, stripe_account_id, subscription_plan")
      .eq("id", profile.company_id).single();

    // No card fee on a customer's payment link. companies.pass_card_fee is
    // FenceFlow's own setting for the company's subscription price (see
    // create-checkout-session), not a surcharge a contractor passes on. The
    // fee_cents plumbing stays at zero so older rows and refunds still work.
    const stripeFee = 0;

    // Both gates sit ABOVE the processor branch and above the reuse of an
    // open link. They used to sit at the bottom, in the platform-Stripe path
    // only -- so a company that had connected Square walked straight past
    // them: a suspended company kept billing through us, and a Solo company
    // got the card payments the Crew plan is sold on, for the price of
    // choosing Square. The processor is a detail; who may raise money is not.
    // A company that is switched off may not raise money through us. This
    // function runs as the service role, so RLS is not watching it -- without
    // this check a suspended or lapsed company kept billing its customers
    // through FenceFlow while its own account was shut.
    const { data: entitled } = await admin
      .rpc("company_allowed", { cid: profile.company_id });
    if (entitled === false) {
      return json({ error: "This FenceFlow account is not active. Check the Billing tab." }, 403);
    }

    // Card payments are sold with the Crew plan. Enforced here rather than in
    // any client, because a client that forgets is not a paywall. A blank plan
    // is a hand-granted company from before plans existed -- no cap applies.
    if ((company?.subscription_plan ?? "").toLowerCase() === "solo") {
      return json({ error: "Card payments are part of the Crew plan. Upgrade in the dashboard's Billing tab." }, 403);
    }

    // A link may not ask for more than the job still owes.
    //
    // The office door takes its amount from the request body and checked only
    // that it was a number of at least fifty cents. Nothing recomputed it and
    // nothing capped it, so whatever the client sent became a real charge on a
    // real card. A report already exists that finds links exceeding the
    // contract total, which means this was known to be possible -- but a report
    // finds it after the customer has been asked, and by then it is a phone
    // call from somebody who trusted the number.
    //
    // This is not about a dishonest contractor. An owner overcharging their own
    // customer is their business, not a privilege they lack. It is about the
    // ordinary mistake: the app and the quote page disagree about what a
    // part-paid deposit means -- one offers the rest of the deposit, the other
    // the rest of the job -- so Request Payment can raise a five-figure link
    // when somebody meant to ask for a few hundred.
    //
    // Deliberately silent when the total is unknown. A job with no contract
    // total yet is normal early on, and refusing a deposit because the job has
    // not been priced would break the common case to prevent an unusual one.
    // The customer-facing door never trusts a supplied figure, it recomputes
    // from stored data -- but it still goes through the open-link half below,
    // because a deposit it computes correctly can still sit beside a balance
    // link the office sent.
    //
    // A failed read refuses rather than passing. The job read used to discard
    // its error, so a read that failed looked exactly like a job with no total
    // -- the one state in which the cap waves everything through. The
    // open-links read is held to the same rule: failing must not read as
    // "nothing open".
    //
    // The cap is measured against what the customer accepted while that
    // acceptance stands, not against a contract_total an old phone build may
    // have moved since (see the top of this file). The read falls back to the
    // old column list only when the database has no accepted_total yet.
    const jobColumns = "contract_total, amount_paid, refunded_amount, quote_approved_at";
    let { data: jobRow, error: jobReadError } = await admin
      .from("jobs")
      .select(`${jobColumns}, ${ACCEPTANCE_COLUMNS}`)
      .eq("company_id", profile.company_id)
      .eq("sync_id", jobSyncId)
      .maybeSingle();
    if (jobReadError && lacksAcceptanceColumns(jobReadError)) {
      ({ data: jobRow, error: jobReadError } = await admin
        .from("jobs")
        .select(jobColumns)
        .eq("company_id", profile.company_id)
        .eq("sync_id", jobSyncId)
        .maybeSingle());
    }
    const { data: openLinks, error: openReadError } = await admin
      .from("job_payments")
      .select("id, kind, amount_cents, processor, livemode, stripe_id, external_id")
      .eq("company_id", profile.company_id)
      .eq("job_sync_id", jobSyncId)
      .eq("status", "pending");
    if (jobReadError || openReadError || !Array.isArray(openLinks)) {
      console.error("create-payment-link open links",
        jobReadError?.message ?? openReadError?.message ?? "no rows array");
      return json(publicDoor ? { code: "open_links_unreadable" } : {
        code: "open_links_unreadable",
        error: "Could not check what this job already owes and has open, so no link was made. Try again in a moment.",
      }, 500);
    }

    // The same failed-read rule for the change orders an accepted price needs.
    const acceptance = jobRow ? await acceptanceFor(admin, profile.company_id, jobSyncId, jobRow) : null;
    if (jobRow && !acceptance) {
      console.error("create-payment-link change orders unreadable", jobSyncId);
      return json(publicDoor ? { code: "open_links_unreadable" } : {
        code: "open_links_unreadable",
        error: "Could not check what this job already owes and has open, so no link was made. Try again in a moment.",
      }, 500);
    }
    // planOpenLinks caps against contract_total; hand it the billable figure
    // in that slot, so its tested arithmetic is unchanged and only the total
    // it measures against moves.
    const billedJob = jobRow && acceptance
      ? {
        ...jobRow,
        contract_total: depositFigures({
          depositAmount: 0,
          contractTotal: jobRow.contract_total,
          amountPaid: 0,
          refundedAmount: 0,
          ...acceptance,
        }).total,
      }
      : jobRow;

    const live = liveNow();
    const plan = planOpenLinks(billedJob, openLinks as OpenLink[], { kind, amountCents: amount }, live);
    if (!plan.ok) {
      if (plan.code === "over_owed") {
        return json({
          code: plan.code,
          error: "That is more than this job still owes (" +
            (plan.stillOwedCents / 100).toFixed(2) +
            "). Check the amount before asking the customer for it.",
        }, 400);
      }
      if (plan.code === "paid_in_full") {
        return json({
          code: plan.code,
          error: "This job is already paid in full. Nothing further is owed.",
        }, 400);
      }
      return openLinkRefusal(plan.code, plan, publicDoor);
    }

    // Which processor this company takes card payments through.
    //
    // One place decides, so adding a third means adding a branch here and a
    // webhook, not rethinking the flow. The credential lives in
    // payment_connections, which no client can read -- only this function,
    // holding the service role. Read before the reuse below, because
    // switching off an older Square link needs the same token.
    const { data: conn } = await admin
      .from("payment_connections")
      .select("processor, external_id, access_token, display_name")
      .eq("company_id", profile.company_id)
      .maybeSingle();
    const processor = (conn?.processor ?? "none").toLowerCase();
    const squareHost = live.square
      ? "https://connect.squareup.com"
      : "https://connect.squareupsandbox.com";

    // Switch off the given open links (see supersedeOpenLinks), or say why not.
    const replaceOpenLinks = async (rows: OpenLink[]): Promise<{ refused: Response } | { ids: string[] }> => {
      if (!rows.length) return { ids: [] };
      const done = await supersedeOpenLinks(rows, {
        takesMoney: (row) => stillTakesMoney(row, live),
        switchOff: async (row) => {
          const p = String(row.processor ?? "stripe").toLowerCase();
          if (p === "stripe") return await switchOffStripeLink(row);
          if (p === "square") {
            return await switchOffSquareLink(row, squareHost,
              processor === "square" ? conn?.access_token : null);
          }
          throw new Error(`there is no way to switch off a ${p} link`);
        },
        markSuperseded: async (row) => {
          // Only a row still pending. One the webhook has just marked paid
          // must stay paid, and must stop this request.
          const { data, error } = await admin.from("job_payments")
            .update({ status: "superseded" })
            .eq("id", row.id)
            .eq("company_id", profile.company_id)
            .eq("status", "pending")
            .select("id");
          if (error) throw new Error(error.message);
          return Array.isArray(data) && data.length > 0;
        },
      });
      if (done.ok) return { ids: done.ids };
      console.error("create-payment-link supersede", done.code, done.row?.id, done.detail);
      return {
        refused: openLinkRefusal(done.code, {
          kind: String(done.row?.kind ?? ""),
          amountCents: Number(done.row?.amount_cents ?? 0),
          detail: done.detail,
        }, publicDoor),
      };
    };

    // Already asked for, and not yet paid? Hand back the same link.
    //
    // A homeowner pressing "Pay deposit" twice made two rows carrying the same
    // order id. The webhook looks that id up expecting one row, finds two,
    // gives up with "not a FenceFlow payment request", and is never retried --
    // so the money lands in the contractor's account, nothing is recorded, and
    // the job still shows the full balance owing.
    //
    // Deliberately before the processor is chosen. The first version of this
    // guard sat inside the Square branch because that is where the audit found
    // the fault; testing it produced two Stripe rows carrying one order id
    // within the minute. The defect was never Square's, it was this function's.
    //
    // Only a link in the processor's current mode that the processor says is
    // still active (pickReusableLink). This lookup used to hand back whatever
    // pending row matched on job, kind and amount. After go-live that included
    // a TEST-mode link: HTTP 200, no processor call, and a checkout that
    // declines the customer's real card. Rows passed over here are not an
    // error -- the request carries on to a new link, and the normal
    // replacement below retires them.
    const { data: openRows } = await admin
      .from("job_payments")
      .select("id, payment_url, processor, livemode, stripe_id, external_id")
      // Scoped to the company, and that is not decoration. A job's sync_id is
      // generated on a phone and the database only makes it unique PER COMPANY
      // -- jobs_company_sync_id_idx is on (company_id, sync_id), not on sync_id
      // alone. So two companies can hold the same job id, and this lookup
      // matched on job id, kind and amount with no company at all. It could
      // hand one company's contractor a live checkout link belonging to another
      // company's customer. Every other query in this file that touches
      // job_sync_id was already scoped; this one was the exception.
      .eq("company_id", profile.company_id)
      .eq("job_sync_id", jobSyncId)
      .eq("kind", kind)
      .eq("amount_cents", amount)
      // A link made before the fee setting changed must not be handed out.
      .or("processor.eq.square,fee_cents.eq." + stripeFee)
      // No deleted_at filter: this table has no such column, and asking for
      // one made the whole query fail, which left the guard silently never
      // firing. Found by testing it rather than by reading it back.
      .eq("status", "pending")
      // More than one, so a stale row that happens to come first cannot hide
      // a good one behind it. Each candidate may cost one processor read.
      .limit(10);
    const reusable = await pickReusableLink(
      Array.isArray(openRows) ? (openRows as ReuseCandidate[]) : [],
      live,
      async (row) => {
        const p = String(row.processor ?? "stripe").toLowerCase();
        if (p === "stripe") return await stripeLinkStillActive(row, live);
        if (p === "square") {
          return await squareLinkStillActive(row, squareHost,
            processor === "square" ? conn?.access_token : null);
        }
        return false;
      },
    );
    if (reusable) {
      // Handing it back is not a new link, but any OTHER open link of the
      // same kind is a duplicate beside it -- a double-tap from before this
      // guard, or two requests that raced past it -- and would let the
      // customer pay the same thing twice. Those are switched off first, by
      // the same rule a new link follows; if they cannot be, nothing is
      // handed out.
      const reusedId = String(reusable.id ?? "");
      const dupes = plan.replace.filter((r) => String(r.id) !== reusedId);
      const dupesOff = await replaceOpenLinks(dupes);
      if ("refused" in dupesOff) return dupesOff.refused;
      return json({ url: reusable.payment_url });
    }

    if (processor === "square") {
      if (!conn?.access_token || !conn?.external_id) {
        return json({
          error: "Square is your chosen card processor but the account is not connected yet. " +
                 "Connect it from the Billing tab, or take this payment as cash, check or " +
                 "card by phone and record it on the job.",
        }, 409);
      }

      const host = (Deno.env.get("SQUARE_ENVIRONMENT") ?? "sandbox") === "production"
        ? "https://connect.squareup.com"
        : "https://connect.squareupsandbox.com";

      // Which of the merchant's locations to bill against. Square requires one,
      // and a merchant can have several -- the main one is what a fencing
      // contractor means by "my business".
      const locRes = await fetch(`${host}/v2/locations`, {
        headers: {
          Authorization: `Bearer ${conn.access_token}`,
          "Square-Version": "2025-01-23",
        },
      });
      const locBody = await locRes.json().catch(() => ({}));
      const locationId = (locBody?.locations ?? [])
        .find((l: any) => l.status === "ACTIVE")?.id;
      if (!locationId) {
        return json({
          error: "Square did not return an active location for your account. " +
                 "Check the account is fully set up in Square, then try again.",
        }, 502);
      }

      // The older links of this kind go first -- after everything above that
      // can still refuse, and before a new link exists.
      const replacedSq = await replaceOpenLinks(plan.replace);
      if ("refused" in replacedSq) return replacedSq.refused;

      // Unchanged when nothing was replaced, so a double-tap still repeats the
      // same key and Square still refuses the second. When a link WAS
      // replaced the key has to move: asking for $A, then $B, then $A again
      // would otherwise replay the first $A link -- the one just deleted --
      // and leave the job with no live link at all.
      const idemSource = `${jobSyncId}-${kind}-${amount}` +
        (replacedSq.ids.length ? `-replaces-${[...replacedSq.ids].sort().join(",")}` : "");
    const idemDigest = await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(idemSource));
    const idemKey = [...new Uint8Array(idemDigest)]
      .map((n) => n.toString(16).padStart(2, "0")).join("").slice(0, 45);

    const linkRes = await fetch(`${host}/v2/online-checkout/payment-links`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${conn.access_token}`,
          "Square-Version": "2025-01-23",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // Square rejects a repeat of the same key, which is what stops a
          // double-tap becoming two payment requests for one job.
          //
          // Hashed rather than truncated. A job id is 36 characters and
          // "-deposit-" is nine, which is exactly the 45 the key was being cut
          // to -- so the amount, the one part that distinguishes one request
          // from the next, was sliced off every time. Change a deposit from
          // $3,680 to $5,000, send it again, and Square returned the original
          // $3,680 link while our own records said $5,000 was pending.
          idempotency_key: idemKey,
          quick_pay: {
            name: `${description} -- ${company?.name ?? "FenceFlow"}`,
            price_money: { amount, currency: "USD" },
            location_id: locationId,
          },
        }),
      });
      const linkBody = await linkRes.json().catch(() => ({}));
      const link = linkBody?.payment_link;
      if (!linkRes.ok || !link?.url) {
        const why = linkBody?.errors?.[0]?.detail ?? "Square would not create the payment link.";
        return json({ error: why }, 502);
      }

      // The mapping back, recorded BEFORE the customer can pay.
      //
      // Square's webhook arrives carrying its own ids and nothing of ours, so
      // this row is the only thing that can say which job the money belongs
      // to. Writing it after handing out the link would leave a window where a
      // fast payment could not be placed.
      const { error: insertError } = await admin.from("job_payments").insert({
        company_id: profile.company_id,
        job_sync_id: jobSyncId,
        kind,
        amount_cents: amount,
        currency: "USD",
        status: "pending",
        payment_url: link.url,
        processor: "square",
        external_id: String(link.order_id ?? link.id ?? ""),
        livemode: (Deno.env.get("SQUARE_ENVIRONMENT") ?? "sandbox") === "production",
      });
      if (insertError) {
        return json({
          error: "The payment link was created but could not be recorded against the job, " +
                 "so it has not been sent. Try again.",
        }, 500);
      }

      return json({ url: link.url });
    }

    const account = conn?.external_id || company?.stripe_account_id || undefined;

    // A connected account is refused rather than quietly taking money we
    // cannot record.
    //
    // Setting Stripe-Account creates the payment link on the company's OWN
    // Stripe account, which is the point -- the money lands with them. But
    // Stripe then raises checkout.session.completed on THAT account, and
    // stripe-webhook is a platform endpoint that never looks at
    // event.account. The event does not arrive. So the homeowner pays, the
    // money reaches the contractor, and nothing on our side ever hears about
    // it: the job_payments row sits on "Waiting" for ever, the ledger never
    // gets its row, and the job on the phone keeps showing the full balance
    // owing. The customer insisting they already paid is the only way anybody
    // finds out.
    //
    // No company has connected an account yet, so nothing has been lost. This
    // refuses the first one instead of losing their first payment. Making it
    // work needs a Connect webhook endpoint and an event.account branch in
    // stripe-webhook that resolves the company by connected account id --
    // that is a feature, not a line of code, and it should be built
    // deliberately rather than discovered.
    if (account) {
      return json({
        error: "Card payments through your own Stripe account are not switched on yet. " +
               "Payments would reach your bank but would not be recorded against the job, " +
               "so the balance would stay wrong. Contact FenceFlow and we will set it up.",
      }, 501);
    }

    // The older links of this kind go first -- after everything above that
    // can still refuse, and before any Stripe object for the new one exists.
    const replaced = await replaceOpenLinks(plan.replace);
    if ("refused" in replaced) return replaced.refused;

    // Create the product inline with the price. This used to be a separate
    // /products call first: three sequential Stripe round trips on top of a
    // cold start was slow enough to look like the button did nothing.
    const price = await stripe("/prices", {
      "product_data[name]": `${description} -- ${company?.name ?? "FenceFlow"}`,
      unit_amount: String(amount),
      currency: "usd",
    }, account);

    const feePrice = stripeFee > 0 ? await stripe("/prices", {
      "product_data[name]": "Card processing fee",
      unit_amount: String(stripeFee),
      currency: "usd",
    }, account) : null;

    const link = await stripe("/payment_links", {
      "line_items[0][price]": price.id,
      "line_items[0][quantity]": "1",
      ...(feePrice ? {
        "line_items[1][price]": feePrice.id,
        "line_items[1][quantity]": "1",
      } : {}),
      "metadata[job_sync_id]": jobSyncId,
      "metadata[company_id]": profile.company_id,
      "metadata[kind]": kind,
    }, account);

    const { error: insertError } = await admin.from("job_payments").insert({
      company_id: profile.company_id,
      job_sync_id: jobSyncId,
      kind,
      amount_cents: amount,
      fee_cents: stripeFee,
      status: "pending",
      payment_url: link.url,
      stripe_id: link.id,
      // Recorded at creation, not inferred later. Whether this is real money
      // is a property of the key that made the link, and a job's balance is
      // summed within one mode so a test payment can never credit a live job.
      livemode: link.livemode === true,
    });
    if (insertError) {
      console.error("create-payment-link insert", insertError.message);
      throw new Error("Could not record the payment request. Try again in a moment.");
    }

    // Report which mode the key is operating in. Test and live keys behave
    // identically right up until a real card is charged, and the only visible
    // difference is a test card being declined -- which reads like a broken
    // integration, not like "this is billing real money".
    return json({ url: link.url, id: link.id, livemode: link.livemode === true });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 400);
  }
}

/** Card fee passed to the customer, in cents: gross-up of 2.9% + 30c, capped at 3% of the amount. */
export function cardFeeCents(amountCents: number): number {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return 0;
  const grossUp = Math.ceil((amountCents + 30) / (1 - 0.029)) - amountCents;
  const cap = Math.floor(amountCents * 0.03);
  return Math.max(0, Math.min(grossUp, cap));
}
