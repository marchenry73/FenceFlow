// Asks a homeowner to pay a deposit or an invoice.
//
// This is payment for a physical service, so it is allowed to live inside the
// Android app -- Google Play billing rules do not apply and Google takes no
// cut. Only the FenceFlow subscription itself has to stay on the website.
//
// Secrets: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Not signed in" }, 401);

    // Identify the caller from their own token, never from the request body --
    // otherwise anyone could bill on behalf of any company.
    const asUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData } = await asUser.auth.getUser();
    const uid = userData?.user?.id;
    if (!uid) return json({ error: "Not signed in" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: profile } = await admin
      .from("profiles").select("company_id, role").eq("id", uid).single();
    if (!profile?.company_id) return json({ error: "No company" }, 403);
    if (!["OWNER", "MANAGER"].includes(profile.role)) {
      return json({ error: "Only an owner or manager can request payment" }, 403);
    }

    const { jobSyncId, amountCents, kind = "deposit", description = "Fence work" } =
      await req.json();

    const amount = Math.round(Number(amountCents));
    if (!jobSyncId || !Number.isFinite(amount) || amount < 50) {
      return json({ error: "Amount must be at least $0.50" }, 400);
    }

    const { data: company } = await admin
      .from("companies").select("name, stripe_account_id").eq("id", profile.company_id).single();
    const account = company?.stripe_account_id ?? undefined;

    // A Price needs a Product; both are cheap and keep the Stripe dashboard
    // readable instead of a wall of identical ad-hoc charges.
    const product = await stripe("/products", {
      name: `${description} -- ${company?.name ?? "FenceFlow"}`,
    }, account);

    const price = await stripe("/prices", {
      product: product.id,
      unit_amount: String(amount),
      currency: "usd",
    }, account);

    const link = await stripe("/payment_links", {
      "line_items[0][price]": price.id,
      "line_items[0][quantity]": "1",
      "metadata[job_sync_id]": jobSyncId,
      "metadata[company_id]": profile.company_id,
      "metadata[kind]": kind,
    }, account);

    const { error: insertError } = await admin.from("job_payments").insert({
      company_id: profile.company_id,
      job_sync_id: jobSyncId,
      kind,
      amount_cents: amount,
      status: "pending",
      payment_url: link.url,
      stripe_id: link.id,
    });
    if (insertError) throw new Error(insertError.message);

    return json({ url: link.url, id: link.id });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 400);
  }
});
