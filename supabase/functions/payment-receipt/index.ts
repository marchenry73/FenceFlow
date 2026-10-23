/**
 * THE RECEIPT, SENT. One Stripe or Square payment, one email, once.
 *
 * "After customer pays, they should receive a receipt on their email and it
 *  should look like a company made it."
 * "I also did a test payment and it did not show on the app. Work on it and it
 *  should also send an email when the person make a payment even if it was a
 *  test one"
 *
 * WHAT IT TAKES: a payment id, and nothing else. Not an amount, not an address,
 * not a subject. Every fact in the letter is read here from the row the id
 * names -- because the only caller is a webhook handling an event, and a
 * function that accepted "send $X to Y" would be a way to email anybody
 * anything over his company's name.
 *
 * WHO IT GOES TO, and this is the one decision worth reading twice:
 *
 *   livemode  -> the CUSTOMER. Money moved; she gets the record of it.
 *   test mode -> HIM, at the company's own address, marked [TEST].
 *
 * He asked for the email "even if it was a test one", and this is that, done
 * the only way it can honestly be done. A test-mode checkout charges nobody.
 * Emailing a real customer a receipt for a payment she never made is a false
 * record of money, and no flag on a request makes it not one. So the test
 * receipt is real, complete, and identical in every other way -- it is simply
 * delivered to the person who ran the test, which is also what makes it useful:
 * he sees exactly what she will get.
 *
 * ONCE. Stripe retries a webhook until it gets a 2xx and will deliver the same
 * event several times. public.claim_payment_receipt (r34) is one atomic
 * statement that answers true to exactly one caller; everybody else returns
 * "already_sent" and sends nothing. Claimed BEFORE the provider call, for r31's
 * reason: a customer who did not get a receipt for a payment she knows she made
 * is a phone call, and a customer who got five thinks she was charged five
 * times.
 *
 * THE WORDS ARE NOT IN THIS FILE. _shared/payment-receipt.ts holds every
 * sentence in three languages, as a pure function of facts, so all of it is
 * tested without a network or a key (tests/a73-payment-receipt.test.mjs). This
 * file reads rows, decides the recipient, claims, and posts.
 *
 * Secrets: NOTIFY_TRIGGER_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * MAIL_API_KEY, MAIL_FROM.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import {
  buildReceiptEmail,
  receiptRefusal,
  REFUSAL_REASON,
  type Lang,
} from "../_shared/payment-receipt.ts";
import { composeBody } from "../_shared/mail/mime-build.ts";

const FN = "payment-receipt";
const SEND_TIMEOUT_MS = 20_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Constant-time compare -- same reasoning as notify-job-change: `a === b` on a
 *  secret leaks timing on the first mismatched character. */
function secretMatches(supplied: string | null, expected: string): boolean {
  if (!supplied || supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** send-follow-ups' own sender shape, so every letter from this product is addressed the same way. */
function senderWithName(name: string, address: string): string {
  const clean = String(name ?? "").replace(/[\r\n<>"]/g, "").trim().slice(0, 70);
  if (!clean || address.includes("<")) return address;
  return `"${clean}" <${address}>`;
}

const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

const pickLang = (v: unknown): Lang =>
  v === "es" || v === "fr" ? v : "en";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // The door, before the body is read. An unset secret opens nothing.
  const expected = Deno.env.get("NOTIFY_TRIGGER_SECRET") ?? "";
  if (!expected) {
    console.error(`${FN}: NOTIFY_TRIGGER_SECRET is not set; refusing to run.`);
    return json({ error: "not configured" }, 503);
  }
  if (!secretMatches(req.headers.get("x-fenceflow-trigger"), expected)) {
    return json({ error: "unauthorized" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const mailKey = Deno.env.get("MAIL_API_KEY") ?? "";
  const mailFrom = Deno.env.get("MAIL_FROM") ?? "";
  const mailUrl = Deno.env.get("MAIL_API_URL") ?? "https://api.resend.com/emails";
  if (!url || !serviceKey) return json({ error: "not configured" }, 503);
  if (!mailKey || !mailFrom) {
    console.error(`${FN}: MAIL_API_KEY/MAIL_FROM not set; refusing to run.`);
    return json({ error: "not configured" }, 503);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad request" }, 400);
  }
  const paymentId = String(body.payment_id ?? "");
  if (!isUuid(paymentId)) return json({ error: "bad request" }, 400);
  const lang = pickLang(body.lang);

  const db = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ----- the payment, and whether it is one at all -------------------------
  const { data: payment, error: payErr } = await db
    .from("job_payments")
    .select("id, company_id, job_sync_id, amount_cents, status, livemode, processor, paid_at, created_at")
    .eq("id", paymentId)
    .maybeSingle();
  if (payErr) {
    console.error(`${FN}: could not read the payment`);
    return json({ error: "could not read the payment" }, 500);
  }
  if (!payment) return json({ state: "not_found" }, 404);
  // Only a payment that actually cleared. A pending or failed one has nothing
  // to attest, and a receipt for one would be a receipt for money that may
  // never arrive.
  if (String(payment.status) !== "paid") {
    return json({ state: "skipped", reason: "not paid" });
  }

  const [{ data: job }, { data: company }] = await Promise.all([
    db.from("jobs")
      .select("id, sync_id, customer_name, email, address, deleted_at, is_test_fixture")
      .eq("company_id", payment.company_id)
      .eq("sync_id", payment.job_sync_id)
      .maybeSingle(),
    db.from("companies")
      .select("name, phone, email, suspended, logo_path")
      .eq("id", payment.company_id)
      .maybeSingle(),
  ]);

  if (!job) return json({ state: "skipped", reason: "no job" });
  if (job.deleted_at) return json({ state: "skipped", reason: "deleted" });
  // Never email a fixture, and never email for a test company: both hold
  // addresses that may be a real person's, reused. send-follow-ups,
  // send-welcome-email and quote-approval-email all draw this same line.
  if (job.is_test_fixture === true) return json({ state: "skipped", reason: "test fixture" });
  if (company?.suspended === true) return json({ state: "skipped", reason: "suspended" });

  const live = payment.livemode === true;
  const companyEmail = String(company?.email ?? "").trim();
  const customerEmail = String(job.email ?? "").trim();

  // THE RECIPIENT. See the header: a test receipt goes to the company, never to
  // the customer, and that is decided here from the row rather than from the
  // request -- so no caller can turn a test into a letter to a homeowner.
  const to = live ? customerEmail : companyEmail;
  if (!live && !companyEmail) {
    return json({
      state: "skipped",
      reason: "test payment and the company has no email address of its own to send it to",
    });
  }

  const amount = Number(payment.amount_cents || 0) / 100;
  const refusal = receiptRefusal({
    recipient: to,
    amount,
    companyName: company?.name,
  });
  if (refusal) {
    return json({ state: "refused", reason: refusal, message: REFUSAL_REASON[lang][refusal] }, 409);
  }

  // ----- the claim: exactly one caller gets past here ----------------------
  const { data: won, error: claimErr } = await db.rpc("claim_payment_receipt", {
    p_payment_id: paymentId,
  });
  if (claimErr) {
    console.error(`${FN}: could not claim the receipt`);
    return json({ error: "could not claim the receipt" }, 500);
  }
  if (won !== true) return json({ state: "already_sent" });

  // ----- the letter --------------------------------------------------------
  //
  // WHAT IS STILL OWED IS NOT IN IT, and that is deliberate. The contract total
  // is computed in the app from the line items, change orders and gate charges;
  // the server does not have it and must not guess (the same sentence
  // stripe-webhook's creditPayment carries). _shared/payment-receipt.ts prints
  // no balance line when it is not given one, so the receipt states what
  // arrived and stops there -- which is the part this function can be sure of.
  const built = buildReceiptEmail({
    companyName: String(company?.name ?? ""),
    companyPhone: String(company?.phone ?? ""),
    customerName: job.customer_name,
    address: job.address,
    amount,
    // Stripe is the only processor that reaches here today and card is the only
    // thing it takes for these; the method word is translated for her.
    method: "CARD",
    paidAt: String(payment.paid_at ?? payment.created_at ?? ""),
    stillOwed: null,
    test: !live,
  }, lang);

  // The letterhead: his logo and his colour, so it looks like his company sent
  // it rather than like software did. mail-send's logoUrlFor carries the full
  // account of the expiry choice; a year, as the approval email signs it.
  //
  // Path-prefix checked before signing: logo_path is a column, and a row whose
  // value pointed into another company's folder would otherwise be signed and
  // sent. A receipt that reaches her without a logo is still a receipt.
  let logoUrl: string | null = null;
  const logoPath = String(company?.logo_path ?? "").trim();
  if (logoPath && logoPath.startsWith(String(payment.company_id) + "/")) {
    try {
      const { data: signed } = await db.storage
        .from("company-logos")
        .createSignedUrl(logoPath, 60 * 60 * 24 * 365);
      logoUrl = signed?.signedUrl ?? null;
    } catch (e) {
      console.error(`${FN}: logo`, String((e as Error)?.message ?? e));
    }
  }

  const { data: settings } = await db
    .from("company_settings")
    .select("brand_color:settings->brand_color")
    .eq("company_id", payment.company_id)
    .maybeSingle();

  const composed = composeBody({
    text: built.text,
    logoUrl,
    logoAlt: String(company?.name ?? ""),
    // Guarded as a string, the way mail-send and the approval email read the
    // same key: it comes out of a jsonb blob, so anything could be in it, and
    // brandColor() falls back to the product colour for anything it does not
    // recognise rather than repairing it.
    brandColor: typeof (settings as { brand_color?: unknown } | null)?.brand_color === "string"
      ? ((settings as { brand_color?: string }).brand_color as string)
      : null,
  });

  // ----- the send ----------------------------------------------------------
  const payload = JSON.stringify({
    from: senderWithName(String(company?.name ?? ""), mailFrom),
    to: [to],
    subject: built.subject,
    html: composed.html,
    text: composed.text,
    // Replies about a payment go to the company, not into a void.
    ...(companyEmail ? { reply_to: companyEmail } : {}),
  });

  let res: Response;
  try {
    res = await fetch(mailUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mailKey}`,
        "Content-Type": "application/json",
        // Same event, same key: the provider de-duplicates even if the claim
        // above were somehow won twice.
        "Idempotency-Key": `receipt-${paymentId}`,
      },
      body: payload,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (e) {
    // The claim stands. See the header: not retried, logged, and the office can
    // send it by hand from the job's mail panel.
    console.error(`${FN}: no answer from the mail provider`, String((e as Error)?.message ?? e));
    return json({ state: "unconfirmed", reason: "no answer from the mail provider" }, 502);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`${FN}: the mail provider refused`, res.status, detail.slice(0, 300));
    return json({ state: "failed", status: res.status }, 502);
  }

  const sent = await res.json().catch(() => ({}));
  return json({
    state: "sent",
    to_company: !live,
    provider_id: typeof sent?.id === "string" ? sent.id : null,
  });
});
