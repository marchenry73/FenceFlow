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
 *   POST ?t=<token>  {action:"approve", name[, phone4][, total]}
 *                                        -> records the approval, and with it
 *                                           the total the page showed
 *                                           (jobs.accepted_total). A `total`
 *                                           that no longer matches -> 409
 *                                           {code:"quote_changed"}.
 *
 * Everything goes through an explicit whitelist. The jobs row also carries
 * labour rates, margins and markup; estimate lines carry supplier_unit_price,
 * which is what the contractor PAYS. None of that may ever reach the person
 * being quoted, so the shape sent out is built by hand rather than selecting
 * whole rows and hoping.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import {
  CHANGE_ORDER_COLUMNS,
  CHANGE_ORDER_COLUMNS_BEFORE_ACCEPTANCE_FLAG,
  changeOrderInputs,
  depositFigures,
  missingAcceptanceFlag,
} from "../_shared/quote-deposit.ts";
import { standingJobEvent } from "../_shared/job-push.ts";
import { jobDevices } from "../_shared/push-recipients.ts";

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
const ACCEPTANCE_COLUMNS = "accepted_total, signed_at";

/** Whether an error is only "this database has no accepted_total yet". */
const lacksAcceptanceColumns = (error: { message?: string } | null | undefined) =>
  /accepted_total/.test(String(error?.message ?? ""));

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
};

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
  // charges from and the app bills -- and rounded UP to the next ten only
  // when the page falls back to adding up the lines itself. It used to round
  // every source: harmless while the total was always the engine's (already
  // a multiple of ten), wrong once an accepted price plus a signed change
  // order of $455 became $10,165 -- the page said $10,170 while the balance
  // link charged from $10,165, and an approval then recorded $10,170 as the
  // accepted price, $5 above anything anybody agreed.
  const total = money.total > 0 ? money.total : Math.ceil((subtotal + tax) / 10) * 10;
  return { ok: !itemsRead.error && !ordersRead.error, total, money };
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
    .select(`${JOB_COLUMNS}, ${ACCEPTANCE_COLUMNS}`)
    .eq("quote_token", token)
    .maybeSingle();
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
      const approval = {
        quote_approved_at: new Date().toISOString(),
        quote_approved_name: name,
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
                    notification: {
                      title: "Quote approved 🎉",
                      body: `${name} approved the quote for ${job.customer_name || "the job"}.`,
                    },
                  },
                }),
              }).catch(() => null)
            ));
          }
        }
      }
    } catch (_e) { /* the approval stands regardless */ }

    return json({ ok: true, approvedBy });
  }

  // ---------------------------------------------------------------- view ---
  const [{ data: company }, figures, { data: runs }, { data: conn }] =
    await Promise.all([
      admin.from("companies").select("name, phone, email").eq("id", job.company_id).single(),
      pageFigures(admin, job),
      admin.from("fence_runs")
        .select("label, fence_type, color_or_finish, points_encoded, gates_encoded, " +
          "closed_loop, panel_height_ft, post_spacing_ft, manual_linear_feet, " +
          "wood_style, aluminum_style, fabric_height_ft, split_rail_count, is_teardown")
        .eq("company_id", job.company_id)
        .eq("job_sync_id", job.sync_id).is("deleted_at", null),
      admin.from("payment_connections")
        .select("processor, external_id, access_token")
        .eq("company_id", job.company_id).maybeSingle(),
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
    approvedAt: job.quote_approved_at,
    // The drawing changed after this quote was approved, so the approval was
    // withdrawn and the customer has to say yes again. The page shows this
    // above the approve button; the approve step itself is unchanged -- same
    // phone gate, same typed name, same link.
    reapprovalRequiredAt: job.reapproval_required_at,
    reapprovalReason: job.reapproval_reason ?? "",
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
    paymentsReady,
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
  });
});
