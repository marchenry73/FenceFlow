// Pure builder for the email FenceFlow sends when an owner or manager adds
// somebody to their crew. Split out of invite-crew/index.ts on purpose: this
// file touches nothing Deno-only (no Deno.serve, no Deno.env, no fetch), so
// tests/invite-crew.test.mjs can import it under plain Node with
// `npx -y tsx tests/invite-crew.test.mjs` and check the wording without
// standing up an Edge Function or a Supabase project.
//
// What the joiner actually types is the company's own id -- see join_company
// in supabase_join_company_guard.sql and AccountScreen.kt's joinCompany(),
// which both call it target_company_id / companyId. There is no separate
// "team code" table for crew; the id IS the code, exactly as the app's own
// "Team invite code" share sheet on the Account screen already shows it.

export interface InviteCrewEmailInput {
  /** The business the recipient is joining. */
  companyName: string;
  /** Phone shown in the footer as a second way to reach the company. Optional. */
  companyPhone?: string;
  /** Who added them -- the caller's own name, so the email reads as coming
   *  from a person, not a database. Falls back to the company name. */
  inviterName?: string;
  /** The email address they must sign up with. Joining fails silently
   *  otherwise: join_company attaches to whichever auth account calls it,
   *  so the wrong email creates a second, empty login instead of this one. */
  recipientEmail: string;
  /** The company id, exactly as join_company and the app's own share sheet
   *  use it. Not a human-friendly code -- it is what it is. */
  code: string;
  /** Where the APK actually lives (app_releases.download_url, normally an
   *  apk-proxy URL). Empty when no release has ever been published with a
   *  hosted link -- handled as a fallback, not an error, since the invite is
   *  still worth sending. */
  downloadUrl?: string;
  /** app_releases.version_name, e.g. "1.301". Shown next to the button when
   *  known; omitted rather than guessed when not. */
  appVersion?: string;
}

export interface InviteCrewEmailOutput {
  subject: string;
  html: string;
  text: string;
}

const escapeHtml = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

export function buildInviteCrewEmail(input: InviteCrewEmailInput): InviteCrewEmailOutput {
  const company = (input.companyName || "").trim() || "your new employer";
  const inviter = (input.inviterName || "").trim() || `Someone at ${company}`;
  const email = (input.recipientEmail || "").trim();
  const code = (input.code || "").trim();
  const link = (input.downloadUrl || "").trim();
  const version = (input.appVersion || "").trim();
  const phone = (input.companyPhone || "").trim();

  const subject = `${company} added you to their crew on FenceFlow`;

  const installLine = link
    ? `<a href="${escapeHtml(link)}" style="display:inline-block;margin-top:8px;background:#FF5A1F;` +
      `color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 18px;` +
      `border-radius:8px">Download FenceFlow${version ? ` (${escapeHtml(version)})` : ""}</a>` +
      `<div style="font-size:12px;color:#8A93A0;margin-top:8px;word-break:break-all">` +
      `Or paste this into your phone's browser:<br>${escapeHtml(link)}</div>`
    : `<span style="color:#5A6472">Ask ${escapeHtml(company)} for the download link &mdash; ` +
      `it has not been set up yet.</span>`;

  const installLineText = link
    ? `Download it here (open on your phone): ${link}`
    : `Ask ${company} for the download link -- it has not been set up yet.`;

  const html = `<!doctype html>
<html><body style="margin:0;background:#F7F8FA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#12151A">
  <div style="max-width:34rem;margin:0 auto;padding:28px 20px">
    <div style="font-weight:800;font-size:20px;letter-spacing:-.4px;margin-bottom:22px">
      Fence<span style="color:#FF5A1F">Flow</span>
    </div>
    <div style="background:#fff;border:1px solid #E3E7ED;border-radius:12px;padding:26px">
      <h1 style="font-size:20px;margin:0 0 10px">${escapeHtml(inviter)} added you to the crew at ${escapeHtml(company)}</h1>
      <p style="font-size:15px;line-height:1.55;color:#3a4250;margin:0 0 18px">
        FenceFlow is the app ${escapeHtml(company)} uses to run jobs, log hours and get paid &mdash;
        no more paper timesheets.
      </p>
      <ol style="font-size:15px;line-height:1.65;color:#171b22;margin:0 0 18px;padding-left:20px">
        <li style="margin-bottom:14px"><strong>Install the app.</strong><br>${installLine}</li>
        <li style="margin-bottom:14px"><strong>Open it and create an account</strong> using this
          email address &mdash; it is how FenceFlow knows it is you:<br>
          <span style="font-weight:600">${escapeHtml(email)}</span></li>
        <li style="margin-bottom:4px"><strong>Tap &ldquo;Join the team&rdquo;</strong> and enter this
          team code:<br>
          <span style="display:inline-block;margin-top:8px;font-family:'IBM Plex Mono',ui-monospace,monospace;
                font-size:15px;letter-spacing:.02em;background:#F3F4F6;border:1px solid #E3E7ED;
                border-radius:8px;padding:8px 14px">${escapeHtml(code)}</span></li>
      </ol>
      <p style="font-size:13.5px;line-height:1.55;color:#5A6472;margin:0">
        ${escapeHtml(company)} controls what you can see and do in FenceFlow once you are in &mdash;
        that is normal, not a limit on you specifically.
      </p>
    </div>
    <p style="font-size:12px;color:#5A6472;margin:18px 0 0;line-height:1.5">
      Questions about the app? Reply to this email${phone ? ` or call ${escapeHtml(company)} at ${escapeHtml(phone)}` : ""},
      or write to <a href="mailto:support@fenceflowapp.com" style="color:#5A6472">support@fenceflowapp.com</a>.
    </p>
  </div>
</body></html>`;

  const text = [
    `${inviter} added you to the crew at ${company}.`,
    "",
    "FenceFlow is the app they use to run jobs, log hours and get paid -- no more paper timesheets.",
    "",
    "1. Install the app.",
    `   ${installLineText}`,
    "",
    "2. Open it and create an account using this email address -- it is how FenceFlow knows it is you:",
    `   ${email}`,
    "",
    '3. Tap "Join the team" and enter this team code:',
    `   ${code}`,
    "",
    `${company} controls what you can see and do in FenceFlow once you are in -- that is normal,`,
    "not a limit on you specifically.",
    "",
    `Questions about the app? Reply to this email${phone ? ` or call ${company} at ${phone}` : ""},`,
    "or write to support@fenceflowapp.com.",
  ].join("\n");

  return { subject, html, text };
}
