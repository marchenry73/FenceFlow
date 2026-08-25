// Sends a new fencing company their invitation, and records that it went.
//
// The old way was a setup code read out over the phone. That works exactly
// once, only if the person writes it down correctly, and leaves nothing behind
// showing whether they ever used it. An emailed link puts the whole of
// onboarding -- their details, the agreement, choosing a plan -- behind one tap
// and gives the admin list something to report progress against.
//
// The mail goes out through Supabase Auth's invite, so no separate mail
// provider or API key is needed. Note that the built-in SMTP is rate-limited
// and meant for low volume; configuring a real SMTP in the Supabase dashboard
// (Zoho, when the domain is set up) is what makes this production-grade.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "No login sent with the request" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Validate the token rather than trusting a header a client handed us.
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    const { data: userData } = await admin.auth.getUser(jwt);
    const user = userData?.user;
    if (!user) return json({ error: "Login not accepted" }, 401);

    // Only the platform admin invites companies onto FenceFlow.
    const { data: profile } = await admin
      .from("profiles").select("is_platform_admin").eq("id", user.id).single();
    if (!profile?.is_platform_admin) {
      return json({ error: "Only a FenceFlow admin may invite a company." }, 403);
    }

    const { companyId, email, companyName } = await req.json();
    if (!companyId || !email) return json({ error: "Need a company and an email address." }, 400);

    const site = Deno.env.get("SITE_URL") ?? "https://marchenry73.github.io/FenceFlow";
    const redirectTo = `${site}/welcome.html`;

    // The company id travels in the invite's metadata, so the welcome page can
    // attach them to the right company without them typing a code at all.
    const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: { company_id: companyId, company_name: companyName ?? "" },
    });

    if (inviteError) {
      // An account may already exist for that address -- that is not a failure,
      // it just means they are already on FenceFlow and need a sign-in link
      // rather than an invitation.
      const already = String(inviteError.message ?? "").toLowerCase()
        .includes("already been registered");
      if (!already) return json({ error: inviteError.message }, 400);

      const { error: linkError } = await admin.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo },
      });
      if (linkError) return json({ error: linkError.message }, 400);
    }

    await admin.rpc("admin_mark_invited", { target: companyId, to_email: email });

    return json({ sent: true, to: email });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 400);
  }
});
