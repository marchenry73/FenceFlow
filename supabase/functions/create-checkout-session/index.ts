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

async function stripe(path: string, form: Record<string, string>) {
  const res = await fetch(`${STRIPE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? "Stripe rejected the request");
  return body;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Not signed in" }, 401);

    const asUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData } = await asUser.auth.getUser();
    const user = userData?.user;
    if (!user) return json({ error: "Not signed in" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: profile } = await admin
      .from("profiles").select("company_id, role").eq("id", user.id).single();
    if (!profile?.company_id) return json({ error: "No company" }, 403);
    if (profile.role !== "OWNER") {
      return json({ error: "Only the owner can change the subscription" }, 403);
    }

    const { priceId, plan = "" } = await req.json();
    if (!priceId) return json({ error: "Missing priceId" }, 400);

    const { data: company } = await admin
      .from("companies").select("name, stripe_customer_id").eq("id", profile.company_id).single();

    // Reuse the Stripe customer so a company that resubscribes keeps one
    // billing history instead of scattering across duplicate customers.
    let customerId = company?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe("/customers", {
        email: user.email ?? "",
        name: company?.name ?? "",
        "metadata[company_id]": profile.company_id,
      });
      customerId = customer.id;
      await admin.from("companies")
        .update({ stripe_customer_id: customerId }).eq("id", profile.company_id);
    }

    const site = Deno.env.get("SITE_URL") ?? "https://marchenry73.github.io/FenceFlow";

    const session = await stripe("/checkout/sessions", {
      mode: "subscription",
      customer: customerId!,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
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
