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
    if (!authHeader) return json({ error: "No login sent with the request" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Validate the caller's token explicitly. Handing the header to a client
    // and calling getUser() with no argument does not reliably read it, which
    // is why a properly signed-in user was still being told "Not signed in".
    // The identity always comes from the token, never from the request body --
    // otherwise anyone could bill on behalf of any company.
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    const { data: userData, error: authError } = await admin.auth.getUser(jwt);
    const uid = userData?.user?.id;
    if (!uid) {
      return json({ error: `Login not accepted: ${authError?.message ?? "unknown"}` }, 401);
    }

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
      .from("companies").select("name, stripe_account_id, subscription_plan")
      .eq("id", profile.company_id).single();
    // Which processor this company takes card payments through.
    //
    // One place decides, so adding a third means adding a branch here and a
    // webhook, not rethinking the flow. The credential lives in
    // payment_connections, which no client can read -- only this function,
    // holding the service role.
    const { data: conn } = await admin
      .from("payment_connections")
      .select("processor, external_id, access_token, display_name")
      .eq("company_id", profile.company_id)
      .maybeSingle();
    const processor = (conn?.processor ?? "none").toLowerCase();

    if (processor === "square") {
      // Square is chosen but not yet connectable end to end: a payment taken
      // through it raises its webhook at Square, and nothing here listens for
      // that yet. Refusing is the only honest answer -- taking money we cannot
      // record is exactly the failure this whole page exists to avoid.
      return json({
        error: "Square is set as your card processor, but the connection is not finished yet, " +
               "so a payment could be taken without being recorded against the job. " +
               "Take this one as cash, check or card by phone and record it on the job, " +
               "and we will tell you the moment Square is ready.",
      }, 501);
    }

    const account = conn?.external_id || company?.stripe_account_id || undefined;

    // A connected account is refused rather than quietly taking money we
    // cannot record.
    //
    // Setting Stripe-Account creates the payment link on the company's OWN
    // Stripe account, which is the point -- the money lands with them. But
    // Stripe then raises checkout.session.completed on THAT account, and
    // stripe-webhook is a platform endpoint that never looks at
    // event.account. The event does not arrive. So the homeowner pays, the
    // money reaches the contractor, and nothing on our side ever hears about
    // it: the job_payments row sits on "Waiting" for ever, the ledger never
    // gets its row, and the job on the phone keeps showing the full balance
    // owing. The customer insisting they already paid is the only way anybody
    // finds out.
    //
    // No company has connected an account yet, so nothing has been lost. This
    // refuses the first one instead of losing their first payment. Making it
    // work needs a Connect webhook endpoint and an event.account branch in
    // stripe-webhook that resolves the company by connected account id --
    // that is a feature, not a line of code, and it should be built
    // deliberately rather than discovered.
    if (account) {
      return json({
        error: "Card payments through your own Stripe account are not switched on yet. " +
               "Payments would reach your bank but would not be recorded against the job, " +
               "so the balance would stay wrong. Contact FenceFlow and we will set it up.",
      }, 501);
    }

    // A company that is switched off may not raise money through us. This
    // function runs as the service role, so RLS is not watching it -- without
    // this check a suspended or lapsed company kept billing its customers
    // through FenceFlow while its own account was shut.
    const { data: entitled } = await admin
      .rpc("company_allowed", { cid: profile.company_id });
    if (entitled === false) {
      return json({ error: "This FenceFlow account is not active. Check the Billing tab." }, 403);
    }

    // Card payments are sold with the Crew plan. Enforced here rather than in
    // any client, because a client that forgets is not a paywall. A blank plan
    // is a hand-granted company from before plans existed -- no cap applies.
    if ((company?.subscription_plan ?? "").toLowerCase() === "solo") {
      return json({ error: "Card payments are part of the Crew plan. Upgrade in the dashboard's Billing tab." }, 403);
    }

    // Create the product inline with the price. This used to be a separate
    // /products call first: three sequential Stripe round trips on top of a
    // cold start was slow enough to look like the button did nothing.
    const price = await stripe("/prices", {
      "product_data[name]": `${description} -- ${company?.name ?? "FenceFlow"}`,
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
      // Recorded at creation, not inferred later. Whether this is real money
      // is a property of the key that made the link, and a job's balance is
      // summed within one mode so a test payment can never credit a live job.
      livemode: link.livemode === true,
    });
    if (insertError) throw new Error(insertError.message);

    // Report which mode the key is operating in. Test and live keys behave
    // identically right up until a real card is charged, and the only visible
    // difference is a test card being declined -- which reads like a broken
    // integration, not like "this is billing real money".
    return json({ url: link.url, id: link.id, livemode: link.livemode === true });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 400);
  }
});
