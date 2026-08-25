// Sends a new fencing company their invitation, and records that it went.
//
// The old way was a setup code read out over the phone. That works exactly
// once, only if the person writes it down correctly, and leaves nothing behind
// showing whether they ever used it. An emailed link puts the whole of
// onboarding -- their details, the agreement, choosing a plan -- behind one tap
// and gives the admin list something to report progress against.
//
// Two ways of sending, and it picks whichever is available:
//
//   1. MAIL_API_KEY + MAIL_FROM set  ->  the link is generated here and put
//      inside FenceFlow's own email, sent through a transactional provider
//      (Resend's API shape; Postmark and others accept the same fields). This
//      is the one to use once a domain exists: it looks like the product, it
//      says who it is from, and it is not rate-limited to a handful an hour.
//
//   2. Neither set  ->  Supabase's built-in invite, which needs no provider at
//      all but sends a generic template from a shared address and is throttled
//      hard. Fine for testing, wrong for customers.
//
// Sending from a domain you own is not decoration: mail from an address that
// cannot be verified goes to spam, and an invitation in a spam folder is a
// customer who never arrives.
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

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

/** FenceFlow's own invitation. Plain enough to survive every mail client. */
function invitationEmail(companyName: string, link: string, fromName: string) {
  const safeCompany = escapeHtml(companyName || "your company");
  const safeLink = escapeHtml(link);
  const html = `<!doctype html>
<html><body style="margin:0;background:#F7F8FA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#12151A">
  <div style="max-width:34rem;margin:0 auto;padding:28px 20px">
    <div style="font-weight:800;font-size:20px;letter-spacing:-.4px;margin-bottom:22px">
      Fence<span style="color:#FF5A1F">Flow</span>
    </div>
    <div style="background:#fff;border:1px solid #E3E7ED;border-radius:12px;padding:26px">
      <h1 style="font-size:21px;margin:0 0 10px">${safeCompany} is set up on FenceFlow</h1>
      <p style="font-size:15px;line-height:1.55;color:#3a4250;margin:0 0 16px">
        FenceFlow estimates fencing work from a drawing, orders the right
        materials, and keeps the money straight. Everything below takes a few
        minutes and you only do it once.
      </p>
      <p style="font-size:15px;line-height:1.55;color:#3a4250;margin:0 0 20px">
        The link signs you in &mdash; there is no password to invent yet.
      </p>
      <a href="${safeLink}"
         style="display:inline-block;background:#FF5A1F;color:#fff;text-decoration:none;
                font-weight:700;font-size:15px;padding:12px 22px;border-radius:8px">
        Set up ${safeCompany}
      </a>
      <p style="font-size:13px;line-height:1.5;color:#5A6472;margin:22px 0 0">
        You will confirm your business details, read a short service agreement,
        and pick a plan. Fourteen days are free and nothing is charged until
        that ends.
      </p>
    </div>
    <p style="font-size:12px;color:#5A6472;margin:18px 0 0;line-height:1.5">
      If the button does not work, paste this into your browser:<br>
      <span style="word-break:break-all">${safeLink}</span>
    </p>
    <p style="font-size:12px;color:#8A93A0;margin:14px 0 0">
      Sent by ${escapeHtml(fromName)}. If you were not expecting this, ignore it &mdash;
      nothing happens until somebody opens the link.
    </p>
  </div>
</body></html>`;

  const text = [
    `${companyName || "Your company"} is set up on FenceFlow.`,
    "",
    "FenceFlow estimates fencing work from a drawing, orders the right materials,",
    "and keeps the money straight.",
    "",
    "Open this link to set up. It signs you in - there is no password to invent yet:",
    link,
    "",
    "You will confirm your business details, read a short service agreement, and",
    "pick a plan. Fourteen days are free and nothing is charged until that ends.",
    "",
    "If you were not expecting this, ignore it - nothing happens until somebody",
    "opens the link.",
  ].join("\n");

  return { html, text };
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

    const mailKey = Deno.env.get("MAIL_API_KEY");
    const mailFrom = Deno.env.get("MAIL_FROM");
    const mailUrl = Deno.env.get("MAIL_API_URL") ?? "https://api.resend.com/emails";
    const fromName = Deno.env.get("MAIL_FROM_NAME") ?? "FenceFlow";

    let sentVia = "supabase";

    if (mailKey && mailFrom) {
      // Our own email, our own link. generateLink does not send anything --
      // it hands back the URL, which is exactly what lets the message look
      // like FenceFlow rather than like a database.
      const meta = { company_id: companyId, company_name: companyName ?? "" };
      let { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
        type: "invite",
        email,
        options: { redirectTo, data: meta },
      });

      // Same fallback as below: a redirect the auth settings do not allow must
      // not be the reason an invitation never arrives.
      if (linkError && /redirect/i.test(String(linkError.message ?? ""))) {
        ({ data: linkData, error: linkError } = await admin.auth.admin.generateLink({
          type: "invite", email, options: { data: meta },
        }));
      }

      let actionLink = linkData?.properties?.action_link;

      if (linkError || !actionLink) {
        // Already has an account: a sign-in link is the right thing, not an
        // invitation. Same destination either way.
        const { data: magic, error: magicError } = await admin.auth.admin.generateLink({
          type: "magiclink",
          email,
          options: { redirectTo },
        });
        if (magicError || !magic?.properties?.action_link) {
          return json({ error: (linkError ?? magicError)?.message ?? "Could not make a link." }, 400);
        }
        actionLink = magic.properties.action_link;
      }

      const body = invitationEmail(companyName ?? "", actionLink, fromName);
      const res = await fetch(mailUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mailKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: mailFrom,
          to: [email],
          subject: `${companyName || "Your company"} is set up on FenceFlow`,
          html: body.html,
          text: body.text,
        }),
      });
      if (!res.ok) {
        const detail = await res.text();
        return json({ error: `Mail provider refused it: ${detail.slice(0, 300)}` }, 400);
      }
      sentVia = "provider";
    } else {
      // No provider configured. Supabase's own invite still gets somebody in,
      // which is better than nothing while a domain is being sorted out.
      const meta = { company_id: companyId, company_name: companyName ?? "" };

      let { error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo,
        data: meta,
      });

      // A redirect the auth settings do not allow is refused outright, and the
      // person clicking gets a bare error page with nowhere to go. Rather than
      // leave the invitation broken until somebody edits a settings screen,
      // send it again with no redirect at all: the link then lands on the site's
      // configured address, and the dashboard forwards an owner who has not
      // started on to the welcome page.
      if (inviteError && /redirect/i.test(String(inviteError.message ?? ""))) {
        ({ error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, { data: meta }));
      }

      if (inviteError) {
        const already = String(inviteError.message ?? "").toLowerCase()
          .includes("already been registered");
        if (!already) return json({ error: inviteError.message }, 400);

        let { error: linkError } = await admin.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: redirectTo },
        });
        if (linkError && /redirect/i.test(String(linkError.message ?? ""))) {
          ({ error: linkError } = await admin.auth.signInWithOtp({ email }));
        }
        if (linkError) return json({ error: linkError.message }, 400);
      }
    }

    // Whether the invitation was recorded is reported, not swallowed.
    //
    // This call used to be fired and forgotten, and it raised every single
    // time: the function guarded on is_platform_admin(), which reads
    // auth.uid(), and this client is the service role, which has no user. So
    // the mail genuinely went out, admin.html said "Invitation sent", and the
    // company's onboarding stayed "Not started" forever with its button still
    // reading Invite -- no way to tell who had already been contacted, and the
    // same invitation sent again and again. The guard now lets a caller with
    // no user context through, and if the write still fails the admin is told
    // rather than shown a success that is only half true.
    const { error: markError } = await admin.rpc("admin_mark_invited", {
      target: companyId,
      to_email: email,
    });
    if (markError) {
      return json({
        sent: true,
        to: email,
        via: sentVia,
        warning:
          "The invitation was sent, but recording it failed, so this company will still show as not yet invited: " +
          markError.message,
      });
    }

    return json({ sent: true, to: email, via: sentVia });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 400);
  }
});
