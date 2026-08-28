/**
 * Connecting a contractor's own Stripe account.
 *
 * The mirror of square-oauth, and deliberately the same shape:
 *
 *   ?action=start     signed-in contractor -> the Stripe consent screen
 *   ?action=callback  Stripe -> here, with a code to exchange
 *
 * The money never touches FenceFlow. Payment links are created ON the
 * contractor's account (create-payment-link sets the Stripe-Account header),
 * so this only has to obtain the account id -- with Standard Connect the
 * platform key acts on the connected account from then on, and there is no
 * token of theirs to store or refresh.
 *
 * This flow simply did not exist before: choosing Stripe on the dashboard
 * showed "not connected yet" with nothing to press, which read as the
 * product being broken rather than the flow being missing.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "start";

  const clientId = Deno.env.get("STRIPE_CONNECT_CLIENT_ID") ?? "";
  const secretKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  const site = Deno.env.get("SITE_URL") ?? "https://marchenry73.github.io/FenceFlow";
  const redirectUri = Deno.env.get("STRIPE_CONNECT_REDIRECT_URI") ?? "";

  if (!clientId || !secretKey || !redirectUri) {
    return json({
      error: "Stripe Connect is not set up on this FenceFlow yet. " +
             "It needs a Connect client id and redirect URL.",
    }, 501);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ---------------------------------------------------------------- start ---
  if (action === "start") {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Sign in first." }, 401);

    const { data: userData } = await admin.auth.getUser(jwt);
    const userId = userData?.user?.id;
    if (!userId) return json({ error: "Sign in first." }, 401);

    const { data: profile } = await admin
      .from("profiles").select("company_id, role").eq("id", userId).maybeSingle();
    if (!profile?.company_id) return json({ error: "You are not part of a business yet." }, 400);
    if (profile.role !== "OWNER") {
      return json({ error: "Only the owner can connect the business's Stripe account." }, 403);
    }

    // One-time value tying the round trip together, exactly as the Square
    // flow does it, so a forwarded link cannot attach one person's Stripe
    // account to another person's company.
    const state = crypto.randomUUID();
    await admin.from("payment_connections").upsert({
      company_id: profile.company_id,
      processor: "stripe",
      refresh_token: `pending:${state}`,
      updated_at: new Date().toISOString(),
    }, { onConflict: "company_id" });

    const authorize = "https://connect.stripe.com/oauth/authorize" +
      `?response_type=code` +
      `&client_id=${encodeURIComponent(clientId)}` +
      `&scope=read_write` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;

    return json({ url: authorize });
  }

  // ------------------------------------------------------------- callback ---
  if (action === "callback") {
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const denied = url.searchParams.get("error");

    const back = (msg: string) =>
      Response.redirect(`${site}/dashboard.html?stripe=${encodeURIComponent(msg)}`, 302);

    if (denied) return back("cancelled");
    if (!code || !state) return back("failed");

    const { data: conn } = await admin
      .from("payment_connections")
      .select("company_id")
      .eq("refresh_token", `pending:${state}`)
      .maybeSingle();
    if (!conn?.company_id) return back("expired");

    // Stripe's OAuth token endpoint is form-encoded, not JSON -- JSON is
    // accepted and then ignored, which fails with a message about a missing
    // grant type rather than anything naming the real problem.
    const res = await fetch("https://connect.stripe.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_secret: secretKey,
        code,
        grant_type: "authorization_code",
      }),
    });
    const body = await res.json().catch(() => ({}));
    const account = String(body?.stripe_user_id ?? "");
    if (!res.ok || !account) return back("failed");

    // What the contractor will see, so they can tell it is the right account.
    const who = await fetch(`https://api.stripe.com/v1/accounts/${account}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    }).then((r) => r.json()).catch(() => null);
    const displayName = who?.business_profile?.name ??
      who?.settings?.dashboard?.display_name ?? who?.email ?? "";

    await admin.from("payment_connections").update({
      processor: "stripe",
      external_id: account,
      // Standard Connect: the platform key acts on the connected account, so
      // there is no token of theirs to keep. Clearing the parked state is what
      // marks the round trip finished.
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      display_name: displayName,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("company_id", conn.company_id);

    return back("connected");
  }

  return json({ error: "Unknown action." }, 400);
});
