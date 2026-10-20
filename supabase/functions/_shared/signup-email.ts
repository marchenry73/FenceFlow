// Pure builder for the email a person gets the moment they create a FenceFlow
// account -- before they have told us anything about their business.
//
// WHY THIS EXISTS. FenceFlow had exactly one email for a new company, and it
// goes out only when the company is READY: business details finished AND a
// trial or a plan. Someone who signed up and stopped before the details step
// therefore heard nothing at all, ever. On 19 October 2026 a real signup did
// exactly that -- account created, owner attached, details never filled in --
// and the owner asked why no email arrived. Nothing was broken; nothing was
// owed. This is the email that was missing.
//
// So there are now two, and they say different things:
//   signup  (this file)        "you are in, one step left"   -> welcome.html
//   welcome (welcome-email.ts) "you are set up, here is what to do first"
// A person who finishes setup in one sitting gets only the welcome one: the
// sender skips this email when the details are already done, so a fast signup
// is never emailed twice in a row.
//
// Same build rules as welcome-email.ts, for the same reasons: tables for
// layout, every style inline (Gmail drops most of <head>), a VML button for
// Outlook on Windows, no web fonts, no images, nothing fetched when it opens
// -- so no tracking of any kind and nothing that breaks with images blocked.
// Nothing here touches Deno, the network or the clock, so
// tests/signup-email.test.mjs can import it under plain Node.

export interface SignupEmailInput {
  /** The business name as typed at signup. Often blank at this point. */
  companyName?: string | null;
  /** profiles.full_name of the owner; only the first word is used. Optional. */
  ownerName?: string | null;
  /** Where this is going -- shown as the address to sign in with. */
  recipientEmail: string;
  /** The setup page, https://fenceflowapp.com/welcome.html by default. */
  setupUrl: string;
  /** Where replies and questions go. */
  supportEmail: string;
}

export interface SignupEmailOutput {
  subject: string;
  html: string;
  text: string;
}

const escapeHtml = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

/** One line, no control characters, a sane length: it goes into a Subject header. */
const oneLine = (s: unknown, max: number): string =>
  String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

// The same palette and fonts as welcome-email.ts. Duplicated rather than
// shared because these two files are read side by side when the wording
// changes, and an import between them would make each harder to read alone.
const INK = "#0B1220";
const ORANGE = "#FF5A1F";
const PAPER = "#F6F7F5";
const LINE = "#E1E5E1";
const TEXT = "#11151C";
const MUTED = "#5C6672";
const BODY_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const DISPLAY_FONT = "'Barlow Condensed','Arial Narrow',Arial,sans-serif";

/** Matches welcome-email.ts: FenceFlow has no passwords, and people ask. */
const NO_PASSWORD_HINT = "There is no password -- FenceFlow emails you a link each time.";

export function buildSignupEmail(input: SignupEmailInput): SignupEmailOutput {
  // A name is genuinely optional here: at signup the business may be unnamed,
  // and the email still has to read properly. Everything below falls back.
  const company = oneLine(input.companyName, 80);
  const first = oneLine(input.ownerName, 60).split(" ")[0] || "";
  const email = oneLine(input.recipientEmail, 254);
  const setup = String(input.setupUrl || "").trim();
  const support = oneLine(input.supportEmail, 254);

  const subject = company
    ? `Finish setting up ${company} on FenceFlow`
    : "Finish setting up your FenceFlow account";
  const greeting = first ? `Hi ${first},` : "Hi there,";
  const intro = company
    ? `Your FenceFlow account is created. One step left before ${company}'s office opens: tell us about the business.`
    : "Your FenceFlow account is created. One step left before your office opens: tell us about your business.";
  const preheader = "One step left before your office opens: your business details.";
  const why = "It takes about a minute -- your business name, phone and licence number. "
    + "That is what goes on your quotes and contracts, so it is worth getting right.";

  const e = escapeHtml;
  const setupHref = e(setup);

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${e(subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
  @media only screen and (max-width:620px){
    .ff-card{padding:28px 22px !important}
    .ff-head{padding:20px 22px !important}
    .ff-h1{font-size:27px !important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${PAPER};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${PAPER};">${e(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAPER}" style="background:${PAPER};">
  <tr>
    <td align="center" style="padding:32px 12px 40px 12px;">
      <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
        <tr>
          <td class="ff-head" bgcolor="${INK}" style="background:${INK};border-top:4px solid ${ORANGE};border-radius:14px 14px 0 0;padding:22px 40px;">
            <span style="font-family:${DISPLAY_FONT};font-size:26px;line-height:1;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#FFFFFF;">Fence<span style="color:${ORANGE};">Flow</span></span>
          </td>
        </tr>
        <tr>
          <td class="ff-card" bgcolor="#FFFFFF" style="background:#FFFFFF;border:1px solid ${LINE};border-top:0;border-radius:0 0 14px 14px;padding:38px 40px 34px 40px;">
            <p style="margin:0 0 10px 0;font-family:${BODY_FONT};font-size:12px;line-height:1;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${ORANGE};">One step left</p>
            <h1 class="ff-h1" style="margin:0 0 18px 0;font-family:${DISPLAY_FONT};font-size:34px;line-height:1.08;font-weight:700;color:${INK};">You&rsquo;re signed up.</h1>
            <p style="margin:0 0 8px 0;font-family:${BODY_FONT};font-size:16px;line-height:1.6;color:${TEXT};">${e(greeting)}</p>
            <p style="margin:0 0 8px 0;font-family:${BODY_FONT};font-size:16px;line-height:1.6;color:${TEXT};">${e(intro)}</p>
            <p style="margin:0 0 26px 0;font-family:${BODY_FONT};font-size:15px;line-height:1.6;color:#3A4250;">${e(why)}</p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 0 auto;">
              <tr>
                <td align="center" bgcolor="${ORANGE}" style="border-radius:10px;background:${ORANGE};">
                  <!--[if mso]>
                  <v:roundrect href="${setupHref}" style="height:52px;v-text-anchor:middle;width:300px;" arcsize="20%" stroke="f" fillcolor="${ORANGE}">
                    <w:anchorlock/>
                    <center style="color:#FFFFFF;font-family:Arial,sans-serif;font-size:17px;font-weight:bold;">Finish setting up</center>
                  </v:roundrect>
                  <![endif]-->
                  <!--[if !mso]><!-->
                  <a href="${setupHref}" style="display:inline-block;padding:16px 40px;font-family:${BODY_FONT};font-size:17px;line-height:20px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:10px;background:${ORANGE};">Finish setting up</a>
                  <!--<![endif]-->
                </td>
              </tr>
            </table>
            <p style="margin:14px 0 0 0;text-align:center;font-family:${BODY_FONT};font-size:13px;line-height:1.5;color:${MUTED};">Sign in with ${e(email)}. ${e(NO_PASSWORD_HINT)}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:30px 0 0 0;">
              <tr><td style="border-top:1px solid ${LINE};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr>
            </table>
            <p style="margin:20px 0 0 0;font-family:${BODY_FONT};font-size:14px;line-height:1.6;color:#3A4250;">Stuck, or not sure what to put? Reply to this email or write to <a href="mailto:${e(support)}" style="color:${ORANGE};text-decoration:none;font-weight:600;">${e(support)}</a>.</p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:22px 24px 0 24px;font-family:${BODY_FONT};font-size:12px;line-height:1.6;color:${MUTED};">
            You are getting this because a FenceFlow account was just created with this address.<br>
            It is a one-time message &mdash; FenceFlow will not send it again.<br>
            If the button does not work, paste this into your browser: <span style="word-break:break-all;">${e(setup)}</span>
          </td>
        </tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [
    company ? `Finish setting up ${company} on FenceFlow.` : "Finish setting up your FenceFlow account.",
    "",
    greeting,
    "",
    intro,
    "",
    why,
    "",
    `Finish setting up: ${setup}`,
    "",
    `Sign in with ${email}. ${NO_PASSWORD_HINT}`,
    "",
    `Stuck, or not sure what to put? Reply to this email or write to ${support}.`,
    "",
    "You are getting this because a FenceFlow account was just created with this address.",
    "It is a one-time message -- FenceFlow will not send it again.",
  ].join("\n");

  return { subject, html, text };
}
