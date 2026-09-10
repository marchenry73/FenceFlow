/**
 * Square telling us a customer paid one of our contractors.
 *
 * The money never passes through FenceFlow. It goes from the homeowner to the
 * contractor's own Square account; this endpoint exists only so the job stops
 * showing a balance the customer has already settled.
 *
 * The recording itself is deliberately not written here -- it lives in
 * _shared/record-payment.ts and Stripe uses the same module. Two
 * implementations of "how much has this customer paid" is exactly how this
 * product once had a job reading $42,301 paid against $10,755 of records.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { recordClearedPayment, recordRefund, minorToMajor } from "../_shared/record-payment.ts";

/**
 * Is this really from Square?
 *
 * Taken from Square's own SDK rather than from memory: the signed string is
 * the notification URL followed by the raw request body, HMAC-SHA256 with the
 * endpoint's signature key, base64 encoded, compared against the
 * x-square-hmacsha256-signature header.
 *
 * Square's own example compares with a plain string equality. This does not:
 * response timing would otherwise leak the signature one character at a time,
 * which their documentation warns about while their sample ignores.
 */
async function verify(
  rawBody: string,
  header: string | null,
  notificationUrl: string,
  signatureKey: string,
): Promise<boolean> {
  if (!header || !signatureKey || !notificationUrl) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signatureKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(notificationUrl + rawBody),
  );
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * A money write that is allowed to fail loudly.
 *
 * supabase-js does not throw when a write fails -- it returns { error } -- so
 * awaiting the builder succeeded no matter what the database said. A ledger
 * or dispute-column write that failed on a constraint, an outage or a policy
 * would otherwise return 200 to Square, Square would never retry, and a
 * chargeback would exist only in Square's own dashboard while the books here
 * said nothing had happened.
 *
 * Throwing reaches the catch at the bottom, which already answers 500, and
 * Square already retries a 500. Retrying is safe because every write here is
 * an upsert keyed on Square's own id, or an update scoped to one job.
 */
async function mustWrite(what: string, p: PromiseLike<{ error: unknown }>): Promise<void> {
  const { error } = await p;
  if (error) {
    const detail = typeof error === "object" && error && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
    console.error("payment write failed:", what, detail);
    throw new Error("could not " + what + ": " + detail);
  }
}

const b64url = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

/** Service-account JWT exchanged for an FCM access token. Same recipe the
 * Stripe webhook uses -- copied rather than imported, so each webhook stays
 * deployable on its own. */
async function fcmAccessToken(sa: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  })}`;
  const pem = sa.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned),
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${sig}`,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).access_token;
}

/**
 * Tells the company's phones that money is being taken back.
 *
 * Reuses the payment notifier's channel rather than inventing a quieter one,
 * matching the Stripe side of this: a chargeback is more urgent than an
 * arrival, and a company that turned notifications on has already said how
 * it wants to hear about money.
 *
 * Failures are swallowed on purpose -- the webhook must not fail for want of
 * a push. If it did, Square would retry the whole event and the dispute rows
 * above would be written a second time.
 */
async function notifyDispute(admin: any, companyId: string, amount: number,
                             reason: string, state: string) {
  const headline =
    state === "LOST" || state === "ACCEPTED" ? "Chargeback: money taken back" :
    state === "WON" ? "Chargeback reversed in your favour" :
    state === "INQUIRY_CLOSED" ? "A chargeback was closed" :
    "A customer has disputed a payment";
  const body = "$" + amount.toFixed(2) +
    (reason ? " — " + reason.replace(/_/g, " ") : "") +
    ". Open the job in FenceFlow.";

  const raw = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
  if (!raw) return;
  const { data: devices } = await admin.from("device_tokens")
    .select("token").eq("company_id", companyId);
  if (!devices?.length) return;

  const sa = JSON.parse(raw);
  const token = await fcmAccessToken(sa);
  for (const d of devices) {
    await fetch("https://fcm.googleapis.com/v1/projects/" + sa.project_id + "/messages:send", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          token: d.token,
          data: { title: headline, body },
          android: { priority: "HIGH" },
        },
      }),
    }).catch(() => {});
  }
}

/**
 * Tells the company's phones a customer's card did not go through.
 *
 * Same channel, same reasoning as the Stripe side: a failed deposit used to
 * leave no trace at all, indistinguishable from nobody having asked for
 * money in the first place.
 */
async function notifyPaymentFailed(admin: any, companyId: string, amount: number) {
  const headline = "A customer's card was declined";
  const body = "$" + amount.toFixed(2) + " did not go through. Open the job in FenceFlow to try again.";

  const raw = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
  if (!raw) return;
  const { data: devices } = await admin.from("device_tokens")
    .select("token").eq("company_id", companyId);
  if (!devices?.length) return;

  const sa = JSON.parse(raw);
  const token = await fcmAccessToken(sa);
  for (const d of devices) {
    await fetch("https://fcm.googleapis.com/v1/projects/" + sa.project_id + "/messages:send", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          token: d.token,
          data: { title: headline, body },
          android: { priority: "HIGH" },
        },
      }),
    }).catch(() => {});
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");

  const signatureKey = Deno.env.get("SQUARE_WEBHOOK_SIGNATURE_KEY") ?? "";
  // Must match, character for character, the URL registered with Square --
  // it is part of what was signed.
  const notificationUrl = Deno.env.get("SQUARE_WEBHOOK_URL") ?? "";

  const raw = await req.text();
  const ok = await verify(
    raw,
    req.headers.get("x-square-hmacsha256-signature"),
    notificationUrl,
    signatureKey,
  );
  if (!ok) return new Response("Bad signature", { status: 400 });

  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response("Bad body", { status: 400 });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // Square fires several payment events; only a completed one is money in
    // the bank. APPROVED means authorised and not yet captured, which is not
    // the same thing and must not mark a job paid.
    const type = String(event?.type ?? "");

    // ---- money went back ---------------------------------------------
    //
    // A refund issued from the contractor's Square dashboard or POS. Only a
    // COMPLETED one is money that has actually left; PENDING can still be
    // rejected. Placed by the same order id the payment was placed by: a
    // refund on a card taken at the counter has no FenceFlow row and is not
    // ours to record.
    if (type === "refund.created" || type === "refund.updated") {
      const refund = event?.data?.object?.refund;
      if (!refund || String(refund.status ?? "") !== "COMPLETED") {
        return new Response("not a completed refund");
      }
      const merchantId = String(event?.merchant_id ?? "");
      if (!merchantId) return new Response("no merchant on the event");
      const { data: conn } = await admin
        .from("payment_connections")
        .select("company_id")
        .eq("processor", "square")
        .eq("external_id", merchantId)
        .maybeSingle();
      if (!conn?.company_id) return new Response("no company for that merchant");

      const orderId = String(refund.order_id ?? "").trim();
      if (!orderId) return new Response("no order on the refund");
      const { data: requests } = await admin
        .from("job_payments")
        .select("job_sync_id, company_id")
        .eq("processor", "square")
        .eq("external_id", orderId)
        .order("created_at", { ascending: true })
        .limit(1);
      const request = requests?.[0];
      if (!request?.job_sync_id) return new Response("not a FenceFlow payment request");

      const outcome = await recordRefund(admin, {
        companyId: request.company_id ?? conn.company_id,
        jobSyncId: request.job_sync_id,
        amount: minorToMajor(Number(refund?.amount_money?.amount ?? 0), String(refund?.amount_money?.currency ?? "USD")),
        refundId: String(refund.id ?? ""),
        processor: "square",
        reason: String(refund.reason ?? ""),
        liveMode: String(Deno.env.get("SQUARE_ENVIRONMENT") ?? "sandbox") === "production",
      });
      return new Response(outcome.reason);
    }

    // ---- a customer disputed a charge --------------------------------
    //
    // Same two facts as Stripe, on Square's own shape and states. A dispute
    // opening is a warning and a deadline; the money is usually still there.
    // Square has no separate "funds withdrawn" event the way Stripe does --
    // the state IS the fact: Square withdraws the disputed amount the moment
    // the seller loses (LOST) or accepts (ACCEPTED) the dispute, and returns
    // it if the seller wins (WON). Booked through the same recordRefund path
    // a refund uses, so money leaves a job one way, not two.
    if (type === "dispute.created" || type === "dispute.state.updated" || type === "dispute.evidence.added") {
      const dispute = event?.data?.object?.dispute;
      if (!dispute) return new Response("no dispute on the event");

      const merchantId = String(event?.merchant_id ?? "");
      if (!merchantId) return new Response("no merchant on the event");
      const { data: conn } = await admin
        .from("payment_connections")
        .select("company_id, access_token")
        .eq("processor", "square")
        .eq("external_id", merchantId)
        .maybeSingle();
      if (!conn?.company_id) return new Response("no company for that merchant");

      // A dispute names the payment it came from, not the order -- unlike a
      // refund, which carries the order id directly. One extra call to
      // Square's own API translates payment id to order id, using the same
      // connected account's token the payment itself was taken with.
      const paymentId = String(dispute?.disputed_payment?.payment_id ?? "");
      if (!paymentId || !conn.access_token) return new Response("no payment on the dispute");

      const host = (Deno.env.get("SQUARE_ENVIRONMENT") ?? "sandbox") === "production"
        ? "https://connect.squareup.com"
        : "https://connect.squareupsandbox.com";
      const payRes = await fetch(`${host}/v2/payments/${paymentId}`, {
        headers: {
          Authorization: `Bearer ${conn.access_token}`,
          "Square-Version": "2025-01-23",
        },
      });
      const payBody = await payRes.json().catch(() => ({}));
      const orderId = String(payBody?.payment?.order_id ?? "").trim();
      if (!orderId) return new Response("could not resolve the disputed payment to an order");

      const { data: requests } = await admin
        .from("job_payments")
        .select("job_sync_id, company_id")
        .eq("processor", "square")
        .eq("external_id", orderId)
        .order("created_at", { ascending: true })
        .limit(1);
      const request = requests?.[0];
      // A dispute against a charge that did not come from a FenceFlow link.
      // Nothing to attach it to, and inventing a job to hang it on would be
      // worse than the gap.
      if (!request?.job_sync_id) return new Response("not a FenceFlow payment request");

      const amount = minorToMajor(Number(dispute?.amount_money?.amount ?? 0), String(dispute?.amount_money?.currency ?? "USD"));
      const state = String(dispute?.state ?? "");
      // Terminal states. INQUIRY_CLOSED is Square closing an inquiry with no
      // formal dispute filed; treated as closed the same as WON/LOST/ACCEPTED.
      const closed = ["WON", "LOST", "ACCEPTED", "INQUIRY_CLOSED"].includes(state);
      const liveMode = String(Deno.env.get("SQUARE_ENVIRONMENT") ?? "sandbox") === "production";
      const disputeId = String(dispute?.dispute_id ?? dispute?.id ?? paymentId);

      await mustWrite("record the dispute on the job",
        admin.from("jobs").update({
          dispute_opened_at: new Date(dispute.created_at ? Date.parse(dispute.created_at) : Date.now()).toISOString(),
          dispute_closed_at: closed ? new Date().toISOString() : null,
          dispute_status: state,
          dispute_reason: String(dispute?.reason ?? ""),
          dispute_amount: amount,
          // Deliberately not touching amount_paid here -- most of these
          // states haven't moved any money yet, matching the Stripe side.
        }).eq("sync_id", request.job_sync_id).eq("company_id", request.company_id));

      if (state === "LOST" || state === "ACCEPTED") {
        await recordRefund(admin, {
          companyId: request.company_id,
          jobSyncId: request.job_sync_id,
          amount,
          refundId: "dispute-" + disputeId,
          processor: "square",
          reason: "chargeback: " + String(dispute?.reason ?? state.toLowerCase()),
          liveMode,
        });
      }

      // And back again if the seller wins it.
      if (state === "WON") {
        await mustWrite("book the reinstated funds",
          admin.from("payment_records").upsert({
            sync_id: "square-dispute-reinstated-" + disputeId,
            company_id: request.company_id,
            job_sync_id: request.job_sync_id,
            amount: Math.abs(amount),
            method: "CARD",
            received_at: new Date().toISOString(),
            reference: disputeId,
            note: "chargeback reversed in your favour",
            recorded_by: "Square",
          }, { onConflict: "company_id,sync_id" }));
      }

      // Told, not left to a bank statement. Same channel as a payment
      // arriving, because this is the more urgent of the two.
      await notifyDispute(admin, request.company_id, amount, String(dispute?.reason ?? ""), state);
      return new Response("dispute recorded");
    }

    if (type !== "payment.created" && type !== "payment.updated") {
      return new Response("no action needed");
    }

    const payment = event?.data?.object?.payment;

    // ---- a customer's card failed -------------------------------------
    //
    // This used to fall straight through the COMPLETED check below and
    // answer 200 with no record at all: a declined card looked exactly like
    // silence, the same gap the dispute handling above closes for
    // chargebacks. No money moved, so the ledger and amount_paid are not
    // touched -- only the request itself is marked, and the office is told,
    // so they can call the customer rather than wonder why a deposit link
    // never got paid.
    const paymentStatus = String(payment?.status ?? "");
    if (payment && (paymentStatus === "FAILED" || paymentStatus === "CANCELED")) {
      const orderId = String(payment.order_id ?? "").trim();
      if (!orderId) return new Response("no order on the failed payment");

      const { data: requests } = await admin
        .from("job_payments")
        .select("id, company_id, status")
        .eq("processor", "square")
        .eq("external_id", orderId)
        .order("created_at", { ascending: true })
        .limit(1);
      const request = requests?.[0];
      if (!request) return new Response("not a FenceFlow payment request");

      // Never overwrite a request that already cleared -- a delayed or
      // out-of-order failure notification must not relabel a paid request.
      if (request.status !== "paid") {
        await admin.from("job_payments")
          .update({ status: paymentStatus === "CANCELED" ? "canceled" : "failed" })
          .eq("id", request.id);
        await notifyPaymentFailed(admin, request.company_id,
          minorToMajor(Number(payment?.amount_money?.amount ?? 0), String(payment?.amount_money?.currency ?? "USD")));
      }
      return new Response("payment failure recorded");
    }

    if (!payment || String(payment.status ?? "") !== "COMPLETED") {
      return new Response("not a completed payment");
    }

    // Which of our contractors this Square account belongs to. The merchant id
    // is on the event; the connection table maps it back to a company.
    const merchantId = String(event?.merchant_id ?? "");
    if (!merchantId) return new Response("no merchant on the event");

    const { data: conn } = await admin
      .from("payment_connections")
      .select("company_id")
      .eq("processor", "square")
      .eq("external_id", merchantId)
      .maybeSingle();
    if (!conn?.company_id) {
      // A payment from a Square account we do not have on file. Answering 200
      // stops Square retrying something that will never succeed; there is
      // nothing here to record it against.
      return new Response("no company for that merchant");
    }

    // Which job it pays for.
    //
    // Square's event carries Square's own ids and nothing of ours, so the row
    // written when the link was created is the only thing that can place the
    // money. Looked up by order id, which is what a quick-pay link returns and
    // what the payment then reports.
    const orderId = String(payment.order_id ?? "").trim();
    if (!orderId) return new Response("no order on the payment");

    // First of however many. maybeSingle() throws when two rows carry the
    // same order id, and until this morning a double-tap on Pay made exactly
    // that -- so the webhook gave up, answered "not ours", Square stopped
    // retrying, and the money sat in the account with nothing recorded. The
    // duplicate is now prevented at the source; this makes sure that if one
    // ever slips through anyway, the payment still lands.
    const { data: requests } = await admin
      .from("job_payments")
      .select("job_sync_id, company_id, status")
      .eq("processor", "square")
      .eq("external_id", orderId)
      .order("created_at", { ascending: true })
      .limit(1);
    const request = requests?.[0];

    if (!request?.job_sync_id) {
      // A payment on their Square account that did not come from a FenceFlow
      // link -- a card taken at the counter, say. Not ours to record, and
      // answering 200 stops Square retrying it for ever.
      return new Response("not a FenceFlow payment request");
    }
    const jobSyncId = request.job_sync_id;

    // Mark the request itself paid, so the office's Payments list matches the
    // job.
    await admin.from("job_payments")
      .update({ status: "paid", paid_at: new Date().toISOString() })
      .eq("processor", "square").eq("external_id", orderId);

    const amountMinor = Number(payment?.amount_money?.amount ?? 0);
    const currency = String(payment?.amount_money?.currency ?? "USD");
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
      return new Response("no amount on the payment");
    }
    // Square reports the smallest unit, and which unit depends on the
    // currency. Zero-decimal currencies would be wrong divided by a hundred.
    const zeroDecimal = ["JPY", "KRW", "VND", "CLP", "ISK"];
    const amount = zeroDecimal.includes(currency) ? amountMinor : amountMinor / 100;

    const outcome = await recordClearedPayment(admin, {
      companyId: request.company_id ?? conn.company_id,
      jobSyncId,
      amount,
      externalId: String(payment.id ?? ""),
      processor: "square",
      // Square marks sandbox activity on the payment itself. Anything not
      // explicitly production is treated as a test and never reaches the books.
      liveMode: event?.data?.object?.payment?.location_id !== undefined
        && String(Deno.env.get("SQUARE_ENVIRONMENT") ?? "sandbox") === "production",
    });

    return new Response(outcome.reason);
  } catch (e) {
    // 500 so Square retries rather than dropping the event.
    return new Response(String(e), { status: 500 });
  }
});
