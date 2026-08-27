/**
 * Connecting a contractor's own Square account.
 *
 * Two jobs behind one URL, because Square needs a single registered redirect:
 *
 *   ?action=start     signed-in contractor -> the Square consent screen
 *   ?action=callback  Square -> here, with a code to exchange for a token
 *
 * The money never touches FenceFlow. This only obtains permission to create
 * payment links on the contractor's account and to hear when one is paid.
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

/** Sandbox and production are different hosts, and mixing them fails opaquely. */
function squareHost(): string {
  return (Deno.env.get("SQUARE_ENVIRONMENT") ?? "sandbox") === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "start";

  const appId = Deno.env.get("SQUARE_APPLICATION_ID") ?? "";
  const appSecret = Deno.env.get("SQUARE_APPLICATION_SECRET") ?? "";
  const site = Deno.env.get("SITE_URL") ?? "https://marchenry73.github.io/FenceFlow";
  const redirectUri = Deno.env.get("SQUARE_REDIRECT_URI") ?? "";

  if (!appId || !appSecret || !redirectUri) {
    return json({
      error: "Square is not set up on this FenceFlow yet. " +
             "It needs a Square application id, secret and redirect URL.",
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
      return json({ error: "Only the owner can connect the business's Square account." }, 403);
    }

    // A one-time value tying the round trip together, so nobody can hand a
    // contractor a link that attaches THEIR Square account to somebody else's
    // company.
    const state = crypto.randomUUID();
    await admin.from("payment_connections").upsert({
      company_id: profile.company_id,
      processor: "square",
      // Parked where the refresh token will go. No client can read this table,
      // and the real token overwrites it when the exchange completes.
      refresh_token: `pending:${state}`,
      updated_at: new Date().toISOString(),
    }, { onConflict: "company_id" });

    const scopes = [
      "MERCHANT_PROFILE_READ",
      "PAYMENTS_READ",
      "PAYMENTS_WRITE",
      "ORDERS_READ",
      "ORDERS_WRITE",
    ].join("+");

    const authorize = `${squareHost()}/oauth2/authorize` +
      `?client_id=${encodeURIComponent(appId)}` +
      `&scope=${scopes}` +
      `&session=false` +
      `&state=${encodeURIComponent(state)}`;

    return json({ url: authorize });
  }

  // ------------------------------------------------------------- callback ---
  if (action === "callback") {
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const denied = url.searchParams.get("error");

    const back = (msg: string) =>
      Response.redirect(`${site}/dashboard.html?square=${encodeURIComponent(msg)}`, 302);

    if (denied) return back("cancelled");
    if (!code || !state) return back("failed");

    // Which company started this. Anything else is somebody replaying a link.
    const { data: conn } = await admin
      .from("payment_connections")
      .select("company_id")
      .eq("refresh_token", `pending:${state}`)
      .maybeSingle();
    if (!conn?.company_id) return back("expired");

    const res = await fetch(`${squareHost()}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Square-Version": "2025-01-23" },
      body: JSON.stringify({
        client_id: appId,
        client_secret: appSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.access_token) return back("failed");

    // What the contractor will see, so they can tell it is the right account.
    const who = await fetch(`${squareHost()}/v2/merchants/${body.merchant_id}`, {
      headers: {
        Authorization: `Bearer ${body.access_token}`,
        "Square-Version": "2025-01-23",
      },
    }).then((r) => r.json()).catch(() => null);
    const displayName = who?.merchant?.business_name ?? "";

    await admin.from("payment_connections").update({
      processor: "square",
      external_id: String(body.merchant_id ?? ""),
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? null,
      // Square's tokens expire after 30 days and they ask you to renew well
      // before that. Storing the expiry is what makes an unattended refresh
      // possible, rather than finding out when a customer's payment fails.
      token_expires_at: body.expires_at ?? null,
      display_name: displayName,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("company_id", conn.company_id);

    return back("connected");
  }

  return json({ error: "Unknown action." }, 400);
});
