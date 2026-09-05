/* The pure part of invite-crew: the email body builder. No Deno, no network,
   no Supabase client -- just the wording, so a regression here shows up
   without deploying anything or standing up a mail provider.

   Run with:  npx -y tsx tests/invite-crew.test.mjs
   tsx is what lets a plain Node run import a .ts file directly. */
import { buildInviteCrewEmail } from '../supabase/functions/_shared/invite-crew-email.ts';

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) pass++;
  else { fail++; console.log('FAIL  ' + label); }
};

const base = {
  companyName: 'Acme Fencing',
  companyPhone: '561-555-0142',
  inviterName: 'Dana Lee',
  recipientEmail: 'newguy@example.com',
  code: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  downloadUrl: 'https://newcrgafcptspmapacrx.supabase.co/functions/v1/apk-proxy?f=fenceflow-301-abc123.apk',
  appVersion: '1.301',
};

/* ---------- subject ---------- */
{
  const { subject } = buildInviteCrewEmail(base);
  ok('subject names the company', subject === 'Acme Fencing added you to their crew on FenceFlow');
}

/* ---------- required content, both bodies ---------- */
{
  const { html, text } = buildInviteCrewEmail(base);
  for (const [label, body] of [['html', html], ['text', text]]) {
    ok(`${label}: names who added them`, body.includes('Dana Lee'));
    ok(`${label}: names the company`, body.includes('Acme Fencing'));
    ok(`${label}: carries the recipient email for sign-up`, body.includes('newguy@example.com'));
    ok(`${label}: carries the team code`, body.includes('3fa85f64-5717-4562-b3fc-2c963f66afa6'));
    ok(`${label}: carries the download link`, body.includes(base.downloadUrl));
    ok(`${label}: says the owner controls what they see`,
      /controls what you can see and do/i.test(body));
    ok(`${label}: points to support`, body.includes('support@fenceflowapp.com'));
    ok(`${label}: never mentions a price or dollar figure`, !/\$\d/.test(body));
  }
}

/* ---------- HTML escaping: a company or person name is not code ---------- */
{
  const { html, text } = buildInviteCrewEmail({
    ...base,
    companyName: 'Bob\'s <Fencing> & "Sons"',
    inviterName: '<script>alert(1)</script>',
  });
  ok('html: escapes the company name', !html.includes('<Fencing>'));
  ok('html: escapes an injected script tag', !html.includes('<script>alert(1)</script>'));
  ok('html: still readable in plain text (unescaped)', text.includes('<script>alert(1)</script>'));
}

/* ---------- no hosted download link yet ---------- */
{
  const { html, text } = buildInviteCrewEmail({ ...base, downloadUrl: '', appVersion: '' });
  ok('html: falls back to asking the office, not a dead link', /ask acme fencing/i.test(html));
  ok('html: emits no empty href', !/href=""/.test(html));
  ok('text: falls back to asking the office', /ask acme fencing/i.test(text));
}

/* ---------- missing optional fields degrade instead of crashing ---------- */
{
  const { html, text, subject } = buildInviteCrewEmail({
    companyName: '',
    recipientEmail: 'x@y.com',
    code: 'company-id-here',
  });
  ok('blank company name still produces a subject', subject.length > 0);
  ok('blank inviter name falls back to something, not "undefined"', !html.includes('undefined'));
  ok('blank inviter name falls back to something, not "undefined" (text)', !text.includes('undefined'));
  ok('no phone number: no dangling "call" sentence', !/call .* at\s*\./i.test(text));
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
