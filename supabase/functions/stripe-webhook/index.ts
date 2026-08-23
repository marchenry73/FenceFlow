// Stripe tells us what actually happened. This is the ONLY thing that marks a
// payment paid or a subscription active -- never the browser, never the app,
// because either of those can be faked by whoever is holding the phone.
//
// Secrets: STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Deploy with JWT verification OFF -- Stripe calls this, not a signed-in user.
// The signature check below is what authenticates the caller instead.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

/**
 * Verifies Stripe's signature header over the RAW body.
 *
 * Without this, anyone who learns the URL could POST "subscription active" or
 * "invoice paid" and help themselves to the product.
 */
async function verify(rawBody: string, header: string | null, secret: string): Promise<boolean> {
  if (!header) return false;

  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=", 2) as [string, string]),
  );
  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;

  // Reject anything older than five minutes so a captured request can't be
  // replayed later.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  if (expected.length !== signature.length) return false;
  // Compare every byte regardless of where the first mismatch is, so response
  // timing can't be used to guess the signature one character at a time.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Books a paid deposit or invoice against the job itself.
 *
 * Marking the payment row "paid" is only half the job: the money has to land
 * on the job, or the app still shows the customer owing what they just paid.
 * The balance is recomputed from the payments that actually cleared rather
 * than incremented, so a replayed webhook or a manual correction can't drift
 * the total.
 */
async function applyPaymentToJob(admin: any, payment: any) {
  const { data: job } = await admin.from("jobs")
    .select("id, sync_id, company_id, customer_name, deposit_amount")
    .eq("company_id", payment.company_id)
    .eq("sync_id", payment.job_sync_id)
    .maybeSingle();
  if (!job) return;

  // Within one Stripe mode only.
  //
  // Test and live payments live in the same table, and summing across both
  // meant testing the checkout four times on a real job left it reading
  // $57,240 paid against a $10,595 contract. The direction of that error is
  // what makes it dangerous: after go-live a test payment would still credit a
  // real customer as having paid, and the job would show settled with no money
  // moved. Scoped to the mode of the payment that just cleared.
  const livemode = payment.livemode === true;

  // A test payment is a test. It used to stop at the amount_paid scoping and
  // still write a LEDGER row -- which has no mode column, so every report,
  // the AR aging and the app itself summed it as real collected cash, and
  // the app then rebuilt amount_paid from that ledger, undoing the scoping
  // below. Nothing about a test checkout may touch the books.
  if (!livemode) return;



  // The ledger row first, so the paid figure below can be summed from the
  // ledger itself -- cash, check and card together, the same rule the app
  // uses. Summing job_payments here counted Stripe alone and stamped a
  // Stripe-only figure over a job that also had cash on it.
  await admin.from("payment_records").upsert({
    sync_id: "stripe-" + payment.id,
    company_id: payment.company_id,
    job_sync_id: payment.job_sync_id,
    amount: Number(payment.amount_cents || 0) / 100,
    method: "CARD",
    received_at: new Date().toISOString(),
    reference: String(payment.stripe_id ?? ""),
    note: "",
    recorded_by: "Stripe",
  }, { onConflict: "company_id,sync_id" });

  const { data: ledger } = await admin.from("payment_records")
    .select("amount")
    .eq("company_id", payment.company_id)
    .eq("job_sync_id", payment.job_sync_id)
    .is("deleted_at", null);
  const paidDollars = (ledger ?? [])
    .reduce((sum: number, r: any) => sum + Math.max(0, Number(r.amount || 0)), 0);

  // Records that money arrived, and no more than that. Whether the job is paid
  // in full depends on the contract total, which is computed in the app from
  // the line items, change orders and gate charges -- the server does not have
  // it and should not guess. The app promotes this to PAID_IN_FULL once the
  // amount actually covers the total.
  await admin.from("jobs").update({
    amount_paid: paidDollars,
    payment_status: "DEPOSIT_PAID",
    // Latches the paid figure read-only in the app. What the processor reports
    // is the record; typing over it is not a correction, it is a discrepancy
    // that only surfaces when the customer disputes the bill.
    payments_from_processor: true,
    updated_at: new Date().toISOString(),
  }).eq("id", job.id);


  await notifyPaid(admin, job, Number(payment.amount_cents || 0) / 100, paidDollars);
}

/** Tells the company's phones that money arrived, and how much. */
async function notifyPaid(admin: any, job: any, justPaid: number, totalPaid: number) {
  const raw = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
  if (!raw) return;

  const { data: devices } = await admin.from("device_tokens")
    .select("token").eq("company_id", job.company_id);
  if (!devices?.length) return;

  const sa = JSON.parse(raw);
  const token = await fcmAccessToken(sa);
  const who = job.customer_name || "a customer";

  for (const d of devices) {
    await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          token: d.token,
          data: {
            title: `Payment received: $${justPaid.toFixed(2)}`,
            body: `${who} paid $${justPaid.toFixed(2)}. Total paid on this job is now $${totalPaid.toFixed(2)}.`,
            jobId: String(job.id ?? ""),
          },
          android: { priority: "HIGH" },
        },
      }),
    }).catch(() => {});
  }
}

const b64url = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

/** Service-account JWT exchanged for an FCM access token. */
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

Deno.serve(async (req) => {
  const raw = await req.text();

  const ok = await verify(
    raw,
    req.headers.get("stripe-signature"),
    Deno.env.get("STRIPE_WEBHOOK_SECRET")!,
  );
  if (!ok) return new Response("Bad signature", { status: 400 });

  const event = JSON.parse(raw);
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    switch (event.type) {
      // ---- A homeowner paid a deposit or an invoice ----
      case "checkout.session.completed": {
        const session = event.data.object;
        const companyId = session.metadata?.company_id;

        if (session.mode === "payment") {
          // Payment Links carry the link id, which is what we stored.
          const linkId = session.payment_link;
          if (linkId) {
            // Only act on a payment we haven't already banked. Stripe retries
            // webhooks, and adding the same amount twice would silently
            // overstate what the customer has paid.
            const { data: pending } = await admin.from("job_payments")
              .select("id, job_sync_id, amount_cents, company_id, status, livemode, stripe_id")
              .eq("stripe_id", linkId).maybeSingle();

            if (pending && pending.status !== "paid") {
              await admin.from("job_payments")
                .update({ status: "paid", paid_at: new Date().toISOString() })
                .eq("id", pending.id);

              await applyPaymentToJob(admin, pending);
            }
          }
        } else if (session.mode === "subscription" && companyId) {
          await admin.from("companies").update({
            stripe_subscription_id: session.subscription,
            subscription_status: "active",
            subscription_plan: session.metadata?.plan ?? "",
          }).eq("id", companyId);
        }
        break;
      }

      // ---- Subscription created, renewed, lapsed, or cancelled ----
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const companyId = sub.metadata?.company_id;
        if (!companyId) break;

        const status = event.type === "customer.subscription.deleted"
          ? "canceled"
          : String(sub.status ?? "none");

        await admin.from("companies").update({
          stripe_subscription_id: sub.id,
          subscription_status: status,
          subscription_plan: sub.metadata?.plan ?? "",
          subscription_ends_at: sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : null,
        }).eq("id", companyId);
        break;
      }

      // ---- A renewal failed. Don't cut them off mid-job; just flag it. ----
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        if (invoice.subscription) {
          await admin.from("companies")
            .update({ subscription_status: "past_due" })
            .eq("stripe_subscription_id", invoice.subscription);
        }
        break;
      }
    }
  } catch (e) {
    // Return 500 so Stripe retries rather than dropping the event.
    return new Response(String(e), { status: 500 });
  }

  return new Response("ok", { status: 200 });
});
