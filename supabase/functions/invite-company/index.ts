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

/**
 * The account an address already belongs to, or null.
 *
 * Only needed on the no-provider path, where Supabase sends a magic link
 * itself and never says which user it mailed. supabase-js's listUsers() takes
 * no filter, so this asks GoTrue's admin list directly: its `filter` is a
 * substring match on email (`email LIKE %filter%`), which is why the exact,
 * case-insensitive match is made here and every page is checked, not just the
 * first. The key is this function's own environment -- it never leaves it.
 */
async function findUserByEmail(address: string) {
  const want = String(address ?? "").trim().toLowerCase();
  if (!want) return null;
  const base = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const perPage = 100;
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(
      `${base}/auth/v1/admin/users?filter=${encodeURIComponent(want)}&page=${page}&per_page=${perPage}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    const users: Array<{ id?: string; email?: string; user_metadata?: Record<string, unknown> }> =
      Array.isArray(body?.users) ? body.users : [];
    const hit = users.find((u) => String(u.email ?? "").toLowerCase() === want);
    if (hit) return hit;
    if (users.length < perPage) return null;
  }
  return null;
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

    const site = Deno.env.get("SITE_URL") ?? "https://fenceflowapp.com";
    const redirectTo = `${site}/welcome.html`;

    const mailKey = Deno.env.get("MAIL_API_KEY");
    const mailFrom = Deno.env.get("MAIL_FROM");
    const mailUrl = Deno.env.get("MAIL_API_URL") ?? "https://api.resend.com/emails";
    const fromName = Deno.env.get("MAIL_FROM_NAME") ?? "FenceFlow";

    let sentVia = "supabase";

    // The same company id on every path, new account or existing one.
    const meta = { company_id: companyId, company_name: companyName ?? "" };

    // What actually happened, recorded as it happens.
    //
    // This function used to answer {sent:true} whichever of four send paths it
    // took, and two of them led nowhere: an existing account got a link with
    // no company on it, and a link GoTrue re-pointed at the Site URL landed on
    // a page with no Supabase client. Both looked exactly like success. The
    // path, where the link really lands, and whether the account had to be
    // stamped are now logged on every call and returned to the caller.
    //
    //   path     provider:invite | provider:magiclink | supabase:invite | supabase:magiclink
    //   landing  welcome   -- GoTrue confirmed the link returns to welcome.html
    //            site_url  -- GoTrue substituted its Site URL (index.html now forwards it)
    //            requested -- Supabase's own mailer sent it and does not say which
    const trace = {
      path: "",
      landing: "requested",
      effective_redirect: null as string | null,
      redirect_retried: false,
      account: "new",
      stamped: false,
    };
    let notice: string | undefined;
    const warnings: string[] = [];
    // No address in the log -- the company id says which invitation it was.
    const log = (outcome: string, extra: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({
        fn: "invite-company", outcome, company: companyId, ...trace, notice: notice ?? null, ...extra,
      }));

    // GoTrue does NOT refuse a redirect it does not allow: it quietly swaps in
    // the Site URL and hands back a link that goes there instead (v2.197.0,
    // adminGenerateLink: `if IsRedirectURLValid(...) { referrer = redirectTo }`).
    // The /redirect/ retries below therefore almost never fire; the redirect_to
    // it reports back is the only honest record of where the link will land.
    const noteLanding = (effective: unknown) => {
      if (typeof effective !== "string" || !effective) return;
      try {
        const u = new URL(effective);
        trace.effective_redirect = u.origin + u.pathname;
      } catch { trace.effective_redirect = null; }
      trace.landing = effective === redirectTo ? "welcome" : "site_url";
    };

    /**
     * Put this company's id on the account the link will sign into.
     *
     * GoTrue writes `data` only when it CREATES a user. For an address that
     * already has an account, generateLink({type:"magiclink", options:{data}})
     * and signInWithOtp({options:{data}}) both drop it without a word
     * (v2.197.0: adminGenerateLink only sets recovery_token for an existing
     * user; MagicLink passes data only to signup). So the old fallback signed
     * the owner into an account with no company_id, welcome.html -- which only
     * attempts the claim when user_metadata.company_id is there -- said
     * "Nothing to set up here yet", and this function reported {sent:true}.
     *
     * The admin update MERGES user_metadata key by key, so nothing else on the
     * account changes. It is a hint, never proof: claim_invited_company() only
     * honours it when companies.invited_email -- written below by
     * admin_mark_invited -- is this account's own address, and that check stays
     * the thing that decides. app_metadata is deliberately NOT written: the
     * claim trusts that branch outright, and an invitation to an account that
     * already existed must still pass the address check.
     */
    const stampInvitation = async (
      user: { id?: string; user_metadata?: Record<string, unknown> } | null | undefined,
    ): Promise<string | null> => {
      if (!user?.id) return "the account behind this address could not be found";
      if (user.user_metadata?.company_id !== companyId) {
        const { error } = await admin.auth.admin.updateUserById(user.id, { user_metadata: meta });
        if (error) return error.message;
        trace.stamped = true;
      }
      // Somebody already running a different business cannot claim this one --
      // claim_invited_company refuses "You already belong to a business." --
      // so the admin hears it now instead of wondering why nobody arrives.
      const { data: prof } = await admin
        .from("profiles").select("company_id").eq("id", user.id).maybeSingle();
      if (prof?.company_id && prof.company_id !== companyId) notice = "account_in_other_business";
      return null;
    };

    if (mailKey && mailFrom) {
      // Our own email, our own link. generateLink does not send anything --
      // it hands back the URL, which is exactly what lets the message look
      // like FenceFlow rather than like a database.
      trace.path = "provider:invite";
      let { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
        type: "invite",
        email,
        options: { redirectTo, data: meta },
      });

      // Same fallback as below: a redirect the auth settings do not allow must
      // not be the reason an invitation never arrives.
      if (linkError && /redirect/i.test(String(linkError.message ?? ""))) {
        trace.redirect_retried = true;
        ({ data: linkData, error: linkError } = await admin.auth.admin.generateLink({
          type: "invite", email, options: { data: meta },
        }));
      }

      let actionLink = linkData?.properties?.action_link;
      let linkUser = linkData?.user;
      let effective: unknown = linkData?.properties?.redirect_to;

      if (linkError || !actionLink) {
        // Already has an account: a sign-in link is the right thing, not an
        // invitation. Same destination, and the same company id -- which, for
        // an account that already exists, only stampInvitation() below can
        // actually put there. `data` is still sent so that the rare case of no
        // account at all (GoTrue turns that into a signup) gets it at creation.
        trace.path = "provider:magiclink";
        const { data: magic, error: magicError } = await admin.auth.admin.generateLink({
          type: "magiclink",
          email,
          options: { redirectTo, data: meta } as { redirectTo: string },
        });
        if (magicError || !magic?.properties?.action_link) {
          log("refused", { reason: "no link" });
          return json({ error: (linkError ?? magicError)?.message ?? "Could not make a link." }, 400);
        }
        actionLink = magic.properties.action_link;
        linkUser = magic.user;
        effective = magic.properties.redirect_to;
        trace.account = magic.properties.verification_type === "signup" ? "new" : "existing";
      }
      noteLanding(effective);

      // Before anything is sent: a link that cannot lead to the company is
      // worse than no email, because it reads as a finished invitation.
      const stampError = await stampInvitation(linkUser);
      if (stampError) {
        log("refused", { reason: "stamp failed" });
        return json({
          error: "Could not attach this company to the account for that address, so the link would lead nowhere. Nothing was sent. (" +
            stampError + ")",
        }, 400);
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
        log("refused", { reason: "mail provider", status: res.status });
        return json({ error: `Mail provider refused it: ${detail.slice(0, 300)}` }, 400);
      }
      sentVia = "provider";
    } else {
      // No provider configured. Supabase's own invite still gets somebody in,
      // which is better than nothing while a domain is being sorted out.
      trace.path = "supabase:invite";

      let { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo,
        data: meta,
      });

      // A redirect the auth settings do not allow is refused outright, and the
      // person clicking gets a bare error page with nowhere to go. Rather than
      // leave the invitation broken until somebody edits a settings screen,
      // send it again with no redirect at all: the link then lands on the site's
      // configured address, which index.html forwards to the welcome page.
      if (inviteError && /redirect/i.test(String(inviteError.message ?? ""))) {
        trace.redirect_retried = true;
        trace.landing = "site_url";
        ({ data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, { data: meta }));
      }

      if (inviteError) {
        const already = String(inviteError.message ?? "").toLowerCase()
          .includes("already been registered") ||
          (inviteError as { code?: string }).code === "email_exists";
        if (!already) {
          log("refused", { reason: "invite refused" });
          return json({ error: inviteError.message }, 400);
        }

        // An account already exists. Its company id has to be on it BEFORE the
        // link goes out -- here Supabase sends the mail itself, so there is no
        // later moment to fix it in. signInWithOtp does not say which user it
        // mailed, so the account is looked up by its address.
        trace.path = "supabase:magiclink";
        trace.account = "existing";
        trace.landing = "requested";
        trace.redirect_retried = false;
        const stampError = await stampInvitation(await findUserByEmail(email));
        if (stampError) {
          log("refused", { reason: "stamp failed" });
          return json({
            error: "Could not attach this company to the account for that address, so the link would lead nowhere. Nothing was sent. (" +
              stampError + ")",
          }, 400);
        }

        // shouldCreateUser:false -- this branch exists only for an account that
        // is already there, and must never mint one.
        let { error: linkError } = await admin.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: redirectTo, data: meta, shouldCreateUser: false },
        });
        if (linkError && /redirect/i.test(String(linkError.message ?? ""))) {
          trace.redirect_retried = true;
          trace.landing = "site_url";
          ({ error: linkError } = await admin.auth.signInWithOtp({
            email, options: { data: meta, shouldCreateUser: false },
          }));
        }
        if (linkError) {
          log("refused", { reason: "magic link refused" });
          return json({ error: linkError.message }, 400);
        }
      } else {
        // A fresh account carries `data` from creation. An account that was
        // invited before and never accepted does not: GoTrue re-sends to it and
        // ignores the new data, so a re-invite for a different company still
        // pointed at the old one. The mail has already gone at this point, so
        // a failure here is reported rather than refused -- and the invitation
        // is still recorded below, because it really was sent.
        const lateStampError = await stampInvitation(invited?.user);
        if (lateStampError) {
          warnings.push(
            "The invitation was sent, but this company could not be attached to that account, so its link may lead nowhere: " +
              lateStampError,
          );
        }
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
      warnings.unshift(
        "The invitation was sent, but recording it failed, so this company will still show as not yet invited: " +
          markError.message,
      );
    }

    log("sent", { warnings: warnings.length });
    return json({
      sent: true,
      to: email,
      via: sentVia,
      path: trace.path,
      landing: trace.landing,
      ...(notice ? { notice } : {}),
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    });
  } catch (e) {
    console.log(JSON.stringify({ fn: "invite-company", outcome: "error" }));
    return json({ error: String(e instanceof Error ? e.message : e) }, 400);
  }
});
