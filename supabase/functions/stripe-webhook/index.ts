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
            await admin.from("job_payments")
              .update({ status: "paid", paid_at: new Date().toISOString() })
              .eq("stripe_id", linkId);
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
