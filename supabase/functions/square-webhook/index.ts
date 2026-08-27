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
import { recordClearedPayment } from "../_shared/record-payment.ts";

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
    if (type !== "payment.created" && type !== "payment.updated") {
      return new Response("no action needed");
    }

    const payment = event?.data?.object?.payment;
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

    // Which job it pays for. The payment link carries it in reference_id --
    // set when the link was created -- and note is the fallback for a payment
    // taken some other way on the same account.
    const jobSyncId = String(payment.reference_id ?? "").trim();
    if (!jobSyncId) return new Response("no job reference on the payment");

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
      companyId: conn.company_id,
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
