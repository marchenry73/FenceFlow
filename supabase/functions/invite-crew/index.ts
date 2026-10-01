// Emails a new crew member: you're on the team, here is the app, here is the
// team code. This is the whole of "add a crew member" for the person being
// added -- today they get nothing at all unless the owner reads a UUID out
// loud or pastes it into a text message.
//
// RUNBOOK -- what the owner has to do before this can send anything:
//
//   1. Buy or confirm the domain: fenceflowapp.com is already registered at
//      IONOS. Resend needs to prove FenceFlow controls it before it will
//      relay mail from an @fenceflowapp.com address, or it lands in spam
//      exactly like invite-company/index.ts warns about.
//   2. In the Resend dashboard: Domains -> Add Domain -> fenceflowapp.com.
//      Resend then lists a handful of DNS records (typically an MX record
//      for the return-path subdomain, one or more DKIM CNAME records, and a
//      TXT record for SPF). Add each one exactly as shown, at IONOS, under
//      Domains & SSL -> fenceflowapp.com -> DNS. Propagation is usually
//      minutes, occasionally hours; Resend's domain page shows each record
//      flipping from "pending" to "verified".
//   3. Once verified, set these three secrets (Supabase dashboard, Edge
//      Functions -> Secrets, or `supabase secrets set`) -- never in a file
//      that gets committed:
//        MAIL_API_KEY       a Resend API key (Resend -> API Keys)
//        MAIL_FROM          an address on the verified domain, e.g.
//                           "FenceFlow <crew@fenceflowapp.com>"
//        MAIL_FROM_NAME     optional, defaults to "FenceFlow" if unset
//      Until both MAIL_API_KEY and MAIL_FROM exist, this function refuses to
//      guess and tells the caller to hand the code over by hand instead --
//      see the 503 branch below. Nothing here ever falls back to Supabase's
//      own throttled invite mail; that path is invite-company's, for a
//      brand-new OWNER, not a crew member joining one that already exists.
//
// -----------------------------------------------------------------------
//
//   POST { employee_sync_id?, name, email, role? }
//
// One door: the signed-in office. verify_jwt is OFF in config.toml (see the
// comment there) because the browser's own CORS preflight carries no bearer
// token and would otherwise be refused at the gateway before this code ever
// ran -- exactly the failure create-payment-link, quote-view and price-job
// each hit first and documented. The token is still validated here, on a
// client built from the caller's OWN Authorization header (never the service
// role), so every read below runs under that person's RLS exactly as it does
// for the rest of the office -- this function does not reimplement company
// isolation, it inherits it.
//
// What the joiner types to join is the company's TEAM CODE: a random uuid of
// its own, kept in company_join_codes and read here through
// crew_join_code_for_invite() (supabase_r18_join_door.sql). It is NOT the
// company id. The id identifies a company and authorises nothing, so an id
// that leaks -- from an old email, a job-file URL, a colleague's profile row --
// lets nobody in. The owner can replace the code (rotate_join_code()), which
// stops every earlier invitation from working without touching the company.
// This function never puts the company id in an email or in a response.
//
// It only READS the code, as the caller. crew_join_code_for_invite() is
// SECURITY DEFINER and checks the caller's role itself, and also says whether
// the caller may be SHOWN the code (the SHARE_INVITE_CODE permission): a
// manager may send an invitation without being handed the secret.
//
// Sequencing: the RPC exists only once supabase_r18_join_door.sql is applied.
// Until then this function fails closed -- 500, nothing sent -- and never falls
// back to emailing the company id, which join_company no longer accepts.
//
// Rate limiting: twenty invitations per company per hour, counted in
// invite_sends by the note_invite_send RPC further down
// (supabase_invite_sends_patch.sql); the twenty-first is refused with a 429
// before anything is sent.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { buildInviteCrewEmail } from "../_shared/invite-crew-email.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "No login sent with the request" }, 401);

    // The caller's own client, built with the anon key and their bearer
    // token -- never the service role. Every query below runs as this
    // specific person under RLS, the same as price-job.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    const { data: userData, error: authError } = await supabase.auth.getUser(jwt);
    const uid = userData?.user?.id;
    if (!uid) return json({ error: `Login not accepted: ${authError?.message ?? "unknown"}` }, 401);

    const body = await req.json().catch(() => ({}));
    const name = String(body?.name ?? "").trim();
    const email = String(body?.email ?? "").trim();
    const employeeSyncId = body?.employee_sync_id ? String(body.employee_sync_id).trim() : null;
    // role (a job title like "Foreman") is accepted so the caller can send
    // exactly the employees row it already has, but it plays no part in the
    // email or in what the joiner is granted -- join_company always lands
    // them as CREW regardless of anything typed anywhere before that call.

    if (!name) return json({ error: "Need the crew member's name." }, 400);
    if (!email || !EMAIL_RE.test(email)) return json({ error: "Need a valid email address." }, 400);

    const { data: profile, error: profileError } = await supabase
      .from("profiles").select("company_id, role, full_name").eq("id", uid).maybeSingle();
    if (profileError) {
      console.error("invite-crew: load profile", profileError.message);
      return json({ error: "Could not check your FenceFlow account." }, 500);
    }
    if (!profile?.company_id) return json({ error: "No company" }, 403);

    // Same gate price-job uses: role first (cheap), then the account itself.
    if (profile.role !== "OWNER" && profile.role !== "MANAGER") {
      return json({ error: "Only an owner or manager can invite crew." }, 403);
    }
    const { data: allowed, error: allowedError } = await supabase
      .rpc("company_allowed", { cid: profile.company_id });
    if (allowedError) {
      console.error("invite-crew: company_allowed", allowedError.message);
      return json({ error: "Could not check your FenceFlow account." }, 500);
    }
    if (allowed === false) {
      return json({ error: "This FenceFlow account is not active. Check the Billing tab." }, 403);
    }

    const companyId = String(profile.company_id);

    const { data: company, error: companyError } = await supabase
      .from("companies").select("name, phone, email").eq("id", companyId).maybeSingle();
    if (companyError) {
      console.error("invite-crew: load company", companyError.message);
      return json({ error: "Could not load your company." }, 500);
    }

    // The team code -- not the company id. Fetched as the caller. A missing
    // code, or an error, ends the request: this function must never fall back
    // to sending the company id. The code is never logged.
    const { data: codeData, error: codeError } = await supabase.rpc("crew_join_code_for_invite");
    const codeRow = Array.isArray(codeData) ? codeData[0] : codeData;
    const joinCode = String(codeRow?.join_code ?? "").trim();
    if (codeError || !joinCode) {
      console.error("invite-crew: crew_join_code_for_invite", codeError?.message ?? "no code returned");
      return json({ error: "Could not prepare the invitation. Try again in a moment." }, 500);
    }
    const mayShowCode = codeRow?.may_show === true;

    // app_releases is readable by anyone signed in (see
    // supabase_app_releases_patch.sql) -- no need for the service role here
    // either. A missing row, or one published with no hosted link, is
    // handled by the email builder as "ask the office", not treated as an
    // error: the invite is still worth sending.
    const { data: release } = await supabase
      .from("app_releases")
      .select("version_name, download_url")
      .order("version_code", { ascending: false })
      .limit(1)
      .maybeSingle();

    const mailKey = Deno.env.get("MAIL_API_KEY");
    // MAIL_FROM is expected to carry its own display name already, e.g.
    // "FenceFlow <crew@fenceflowapp.com>" -- see the runbook note up top.
    // MAIL_FROM_NAME exists for invite-company's own template; this one has
    // no separate use for it.
    const mailFrom = Deno.env.get("MAIL_FROM");
    const mailUrl = Deno.env.get("MAIL_API_URL") ?? "https://api.resend.com/emails";

    if (!mailKey || !mailFrom) {
      // Not an error the office caused -- tell them exactly what to do
      // instead of sending nothing and saying nothing. The team code comes back
      // only to somebody who may be shown it (the owner, or a manager the owner
      // granted SHARE_INVITE_CODE by name); anybody else is told to ask.
      if (mayShowCode) {
        return json({
          error: "Email is not set up yet. Give them the code by hand.",
          code: joinCode,
        }, 503);
      }
      return json({
        error: "Email is not set up yet. Ask the owner for the team code and give it to them by hand.",
      }, 503);
    }

    // Twenty invitations an hour per company. Real mail leaves the business's
    // own domain, so a stolen office session must not become a relay. The
    // ledger is written by the RPC alone and the count comes back with this
    // send included, so the twenty-first is refused before anything goes out.
    const { data: sendsThisHour, error: capError } = await supabase.rpc("note_invite_send", { p_email: email });
    if (capError) {
      console.error("invite-crew: note_invite_send", capError.message);
      return json({ error: "Could not record the invitation. Try again in a moment." }, 500);
    }
    if (Number(sendsThisHour) > 20) {
      return json({ error: "That is more than twenty invitations in an hour. Try again later." }, 429);
    }

    const inviterName = String(profile.full_name ?? "").trim();
    const { subject, html, text } = buildInviteCrewEmail({
      companyName: company?.name ?? "",
      companyPhone: company?.phone ?? "",
      inviterName,
      recipientEmail: email,
      code: joinCode,
      downloadUrl: release?.download_url ?? "",
      appVersion: release?.version_name ?? "",
    });

    const replyTo = (company?.email ?? "").trim();

    // Nothing is written from employeeSyncId -- employees has no invited_at
    // column to write it to -- but it is worth one line in the function log for
    // anyone chasing down a report that an invite never arrived. The log line
    // carries the address and the company id, never the team code.
    console.log(
      `invite-crew: sending to ${email} for company ${companyId}` +
      (employeeSyncId ? ` (employee ${employeeSyncId})` : ""),
    );

    const res = await fetch(mailUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mailKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Business name as the sender, the platform address underneath. A
        // display name matching the brand the reader expects keeps it out of
        // spam; the address stays on the verified domain.
        from: senderWithName(company?.name ?? "", mailFrom),
        to: [email],
        subject,
        html,
        text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error("invite-crew: mail provider refused", res.status, detail.slice(0, 300));
      return json({ error: `Mail provider refused it: ${detail.slice(0, 300)}` }, 400);
    }

    // The send was already counted by note_invite_send above, before anything
    // went out. This is genuine success: the mail provider accepted it.
    return json({ sent: true, to: email });
  } catch (e) {
    console.error("invite-crew:", e);
    return json({ error: String(e instanceof Error ? e.message : e) }, 400);
  }
});

/** "Acme Fence <noreply@x>"; the bare address when no name, or when MAIL_FROM already carries one. */
function senderWithName(name: string, address: string): string {
  const clean = name.replace(/[\r\n<>"]/g, "").trim().slice(0, 70);
  if (!clean || address.includes("<")) return address;
  return `"${clean}" <${address}>`;
}
