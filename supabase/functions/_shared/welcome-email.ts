// Pure builder for the one email FenceFlow sends a new company when its
// owner finishes signing up. Split out of send-welcome-email/index.ts for the
// same reason invite-crew-email.ts is split out of invite-crew: nothing here
// touches Deno, the network or the clock, so tests/welcome-email.test.mjs can
// import it under plain Node and check the wording and the markup without a
// mail provider or a Supabase project.
//
// Built for mail clients, not browsers: tables for layout, every style inline
// (Gmail drops most of <head>), a VML button for Outlook on Windows, no web
// fonts, no images and nothing fetched when it opens -- so no tracking of any
// kind, and nothing that breaks when images are blocked. The one <style>
// block only tightens the padding on a phone, for the clients that read it.
//
// Every claim in it is something the office actually does today: the
// Catalog tab (with "Start from FenceFlow's catalog"), the Crew tab's + Add
// (invite-crew emails the app link and the team code), and Jobs -> + New Job
// with a quote link the customer can approve. There are no deep links into a
// tab -- dashboard.html has no URL for one -- so each step names the tab and
// links to the office itself rather than pretending to land on the tab.

export interface WelcomeEmailInput {
  /** The business, as the owner typed it on the details step. */
  companyName: string;
  /** profiles.full_name of the owner; only the first word is used. Optional. */
  ownerName?: string;
  /** Where this is going -- shown as the address to sign in with. */
  recipientEmail: string;
  /** subscription_plan: 'solo' changes the crew step, since Solo is one login. */
  plan?: string | null;
  /** https://fenceflowapp.com/dashboard.html unless SITE_URL says otherwise. */
  officeUrl: string;
  /** Where replies and questions go. */
  supportEmail: string;
}

export interface WelcomeEmailOutput {
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

// FenceFlow's own palette, from website/index.html's :root.
const INK = "#0B1220";
const ORANGE = "#FF5A1F";
const PAPER = "#F6F7F5";
const LINE = "#E1E5E1";
const TEXT = "#11151C";
const MUTED = "#5C6672";
const BODY_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const DISPLAY_FONT = "'Barlow Condensed','Arial Narrow',Arial,sans-serif";

// An owner who came in through an invitation link was signed in by the link
// and never asked for a password (welcome.html has no password step), so on
// any other device the office's sign-in form would stop them cold.
const NO_PASSWORD_HINT =
  "Joined from an invitation and never set a password? Choose \u201cForgot your password?\u201d " +
  "on the sign-in screen to make one.";

interface Step {
  title: string;
  body: string;
  tab: string;
}

function steps(plan: string | null | undefined): Step[] {
  const solo = String(plan ?? "").trim().toLowerCase() === "solo";
  return [
    {
      title: "Add your prices",
      body:
        "Open the Catalog tab and put in what your supplier charges for posts, panels, " +
        "concrete and gate hardware \u2014 or press \u201cStart from FenceFlow\u2019s catalog\u201d " +
        "and change the numbers. Every estimate is priced from this list.",
      tab: "Catalog",
    },
    solo
      ? {
        title: "Invite your crew",
        body:
          "Solo is a one-login plan. When you are ready to bring installers in, move to Crew " +
          "from the Billing tab, then add each of them from the Crew tab.",
        tab: "Billing",
      }
      : {
        title: "Invite your crew",
        body:
          "In the Crew tab, press + Add and enter an installer\u2019s email. They get the app " +
          "download and a code that puts them on your team.",
        tab: "Crew",
      },
    {
      title: "Send your first quote",
      body:
        "In Jobs, press + New Job, draw the fence line (or measure it from the satellite " +
        "view) and send the quote as a link. Your customer opens it on their phone and can " +
        "approve it right there.",
      tab: "Jobs",
    },
  ];
}

export function buildWelcomeEmail(input: WelcomeEmailInput): WelcomeEmailOutput {
  const company = oneLine(input.companyName, 80) || "your company";
  const first = oneLine(input.ownerName, 60).split(" ")[0] || "";
  const email = oneLine(input.recipientEmail, 254);
  const office = String(input.officeUrl || "").trim();
  const support = oneLine(input.supportEmail, 254);
  const list = steps(input.plan);

  const subject = `Welcome to FenceFlow, ${company}`;
  const greeting = first ? `Hi ${first},` : "Hi there,";
  const intro = `${company} is set up and your office is ready. Three things are worth doing first:`;
  const preheader = "Your FenceFlow office is ready. Here are the three things to do first.";

  const e = escapeHtml;
  const officeHref = e(office);

  const stepRows = list.map((s, i) => `
          <tr>
            <td width="44" valign="top" style="padding:0 0 22px 0;width:44px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                <td align="center" valign="middle" width="30" height="30" bgcolor="${ORANGE}"
                    style="width:30px;height:30px;border-radius:15px;background:${ORANGE};color:#FFFFFF;
                           font-family:${BODY_FONT};font-size:15px;font-weight:700;line-height:30px;">${i + 1}</td>
              </tr></table>
            </td>
            <td valign="top" style="padding:0 0 22px 0;">
              <p style="margin:0 0 4px 0;font-family:${BODY_FONT};font-size:16px;line-height:1.35;font-weight:700;color:${TEXT};">${e(s.title)}</p>
              <p style="margin:0 0 6px 0;font-family:${BODY_FONT};font-size:15px;line-height:1.55;color:#3A4250;">${e(s.body)}</p>
              <a href="${officeHref}" style="font-family:${BODY_FONT};font-size:14px;font-weight:600;color:${ORANGE};text-decoration:none;">Open your office &rarr; ${e(s.tab)}</a>
            </td>
          </tr>`).join("");

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
            <p style="margin:0 0 10px 0;font-family:${BODY_FONT};font-size:12px;line-height:1;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${ORANGE};">You&rsquo;re all set up</p>
            <h1 class="ff-h1" style="margin:0 0 18px 0;font-family:${DISPLAY_FONT};font-size:34px;line-height:1.08;font-weight:700;color:${INK};">Welcome to FenceFlow, ${e(company)}.</h1>
            <p style="margin:0 0 8px 0;font-family:${BODY_FONT};font-size:16px;line-height:1.6;color:${TEXT};">${e(greeting)}</p>
            <p style="margin:0 0 26px 0;font-family:${BODY_FONT};font-size:16px;line-height:1.6;color:${TEXT};">${e(intro)}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${stepRows}
            </table>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 0 auto;">
              <tr>
                <td align="center" bgcolor="${ORANGE}" style="border-radius:10px;background:${ORANGE};">
                  <!--[if mso]>
                  <v:roundrect href="${officeHref}" style="height:52px;v-text-anchor:middle;width:300px;" arcsize="20%" stroke="f" fillcolor="${ORANGE}">
                    <w:anchorlock/>
                    <center style="color:#FFFFFF;font-family:Arial,sans-serif;font-size:17px;font-weight:bold;">Open your office</center>
                  </v:roundrect>
                  <![endif]-->
                  <!--[if !mso]><!-->
                  <a href="${officeHref}" style="display:inline-block;padding:16px 40px;font-family:${BODY_FONT};font-size:17px;line-height:20px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:10px;background:${ORANGE};">Open your office</a>
                  <!--<![endif]-->
                </td>
              </tr>
            </table>
            <p style="margin:14px 0 0 0;text-align:center;font-family:${BODY_FONT};font-size:13px;line-height:1.5;color:${MUTED};">Sign in with ${e(email)}. ${e(NO_PASSWORD_HINT)}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:30px 0 0 0;">
              <tr><td style="border-top:1px solid ${LINE};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr>
            </table>
            <p style="margin:20px 0 0 0;font-family:${BODY_FONT};font-size:14px;line-height:1.6;color:#3A4250;">Questions, or stuck on a step? Reply to this email or write to <a href="mailto:${e(support)}" style="color:${ORANGE};text-decoration:none;font-weight:600;">${e(support)}</a>.</p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:22px 24px 0 24px;font-family:${BODY_FONT};font-size:12px;line-height:1.6;color:${MUTED};">
            You are getting this because ${e(company)} was just set up on FenceFlow.<br>
            It is a one-time welcome &mdash; FenceFlow will not send another.<br>
            If the button does not work, paste this into your browser: <span style="word-break:break-all;">${e(office)}</span>
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
    `Welcome to FenceFlow, ${company}.`,
    "",
    greeting,
    "",
    intro,
    "",
    ...list.flatMap((s, i) => [
      `${i + 1}. ${s.title}`,
      `   ${s.body}`,
      `   Open your office -> ${s.tab}: ${office}`,
      "",
    ]),
    `Open your office: ${office}`,
    `Sign in with ${email}. ${NO_PASSWORD_HINT}`,
    "",
    `Questions, or stuck on a step? Reply to this email or write to ${support}.`,
    "",
    "--",
    `You are getting this because ${company} was just set up on FenceFlow.`,
    "It is a one-time welcome - FenceFlow will not send another.",
  ].join("\n");

  return { subject, html, text };
}
