// Starts a FenceFlow subscription. Website only, on purpose.
//
// This one IS a digital service, so selling it inside the Android app would
// pull in Google Play billing and its 15-30% cut. Keeping checkout on the
// website avoids that entirely.
//
// Secrets: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//          SUPABASE_ANON_KEY, SITE_URL
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

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

async function stripe(method: string, path: string, form?: Record<string, string>) {
  const res = await fetch(`${STRIPE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? "Stripe rejected the request");
  return body;
}

// deno-lint-ignore no-explicit-any
async function hadSubscriptionBefore(admin: any, companyId: string): Promise<boolean> {
  const { data } = await admin
    .from("companies").select("stripe_subscription_id, subscription_status")
    .eq("id", companyId).single();
  return Boolean(data?.stripe_subscription_id) &&
    data?.subscription_status !== "trialing";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "No login sent with the request" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Validate the token explicitly rather than relying on a header handed to
    // a client -- see the note in create-payment-link.
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    const { data: userData, error: authError } = await admin.auth.getUser(jwt);
    const user = userData?.user;
    if (!user) {
      return json({ error: `Login not accepted: ${authError?.message ?? "unknown"}` }, 401);
    }

    const { data: profile } = await admin
      .from("profiles").select("company_id, role").eq("id", user.id).single();
    if (!profile?.company_id) return json({ error: "No company" }, 403);
    if (profile.role !== "OWNER") {
      return json({ error: "Only the owner can change the subscription" }, 403);
    }

    const { priceId, plan = "" } = await req.json();
    if (!priceId) return json({ error: "Missing priceId" }, 400);

    const { data: company } = await admin
      .from("companies")
      .select("name, stripe_customer_id, stripe_subscription_id, subscription_status")
      .eq("id", profile.company_id).single();

    // A live subscription is CHANGED, never duplicated. Sending an active
    // subscriber through checkout again would quietly stack a second monthly
    // charge next to the first.
    if (company?.stripe_subscription_id &&
        ["active", "trialing"].includes(company?.subscription_status ?? "")) {
      const sub = await stripe("GET", `/subscriptions/${company.stripe_subscription_id}`);
      const itemId = sub.items?.data?.[0]?.id;
      if (!itemId) return json({ error: "Subscription has no item to change" }, 400);
      await stripe("POST", `/subscriptions/${company.stripe_subscription_id}`, {
        "items[0][id]": itemId,
        "items[0][price]": priceId,
        // The metadata is what the webhook writes back as the plan name;
        // without this an upgrade kept billing the new price under the old
        // plan's label and the old plan's limits.
        "metadata[plan]": plan,
        proration_behavior: "create_prorations",
      });
      await admin.from("companies")
        .update({ subscription_plan: plan }).eq("id", profile.company_id);
      return json({ upgraded: true, plan });
    }

    // Reuse the Stripe customer so a company that resubscribes keeps one
    // billing history instead of scattering across duplicate customers.
    let customerId = company?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe("POST", "/customers", {
        email: user.email ?? "",
        name: company?.name ?? "",
        "metadata[company_id]": profile.company_id,
      });
      customerId = customer.id;
      await admin.from("companies")
        .update({ stripe_customer_id: customerId }).eq("id", profile.company_id);
    }

    const site = Deno.env.get("SITE_URL") ?? "https://marchenry73.github.io/FenceFlow";

    const session = await stripe("POST", "/checkout/sessions", {
      mode: "subscription",
      customer: customerId!,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      // Card up front, first charge when the trial ends -- what the pricing
      // page promises. Companies that already had a subscription (canceled,
      // past_due) do not get a second trial: the trial sells the product,
      // not repeated free months.
      ...(await hadSubscriptionBefore(admin, profile.company_id)
        ? {}
        : { "subscription_data[trial_period_days]": "14" }),
      success_url: `${site}/dashboard.html?billing=success`,
      cancel_url: `${site}/dashboard.html?billing=canceled`,
      "subscription_data[metadata][company_id]": profile.company_id,
      "subscription_data[metadata][plan]": plan,
      "metadata[company_id]": profile.company_id,
      "metadata[plan]": plan,
    });

    return json({ url: session.url });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 400);
  }
});
