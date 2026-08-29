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

    // "from" says which page started this, so Stripe returns them to it.
    //
    // Both URLs used to point at the dashboard whatever page the checkout
    // began on. Onboarding therefore never reached its own last screen -- the
    // one that tells a new contractor to install the app and sign in with the
    // same email -- and cancelling dropped them into a blocked dashboard
    // rather than back on the plan step they were reading.
    const { priceId, from } = await req.json();
    const back = from === "welcome" ? "welcome.html" : "dashboard.html";
    if (!priceId) return json({ error: "Missing priceId" }, 400);

    // The plan name comes from the PRICE, never from the browser.
    //
    // It used to be posted alongside the price id, and the webhook wrote it
    // straight onto the company -- so anyone could send the $99 price id with
    // plan "Pro" and buy the top tier at the bottom price. Every limit in the
    // app and the website reads that label. Stripe is now the only thing that
    // says what a price is worth.
    const price = await stripe("GET", `/prices/${priceId}?expand[]=product`);
    const plan: string = price?.metadata?.plan ??
      String(price?.product?.name ?? "").replace(/^FenceFlow\s+/i, "").trim();
    if (!plan) {
      return json({ error: "That price is not set up as a FenceFlow plan." }, 400);
    }
    if (price?.recurring?.interval !== "month") {
      return json({ error: "That price is not a monthly subscription." }, 400);
    }

    // A smaller plan must not silently strand people. Seat caps match
    // join_company's; going down while over the new cap is refused with the
    // number to remove, because quietly cutting a company's crew list loose
    // would be destroying something the owner never agreed to lose.
    const SEATS: Record<string, number> = { solo: 1, crew: 6 };
    const cap = SEATS[plan.toLowerCase()];
    if (cap !== undefined) {
      const { count } = await admin
        .from("profiles").select("id", { count: "exact", head: true })
        .eq("company_id", profile.company_id);
      const inUse = count ?? 0;
      if (inUse > cap) {
        return json({
          error: `${plan} includes ${cap} ${cap === 1 ? "login" : "logins"}, and you have ${inUse}. ` +
            `Remove ${inUse - cap} from Crew first, then switch plans.`,
        }, 409);
      }
    }

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

    const site = Deno.env.get("SITE_URL") ?? "https://fenceflowapp.com";

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
      success_url: `${site}/${back}?billing=success`,
      cancel_url: `${site}/${back}?billing=canceled`,
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
