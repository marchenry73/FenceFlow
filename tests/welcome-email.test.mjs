/* The welcome email a new company gets once its owner finishes signing up.

   Two halves, like invite-crew.test.mjs: the pure builder
   (supabase/functions/_shared/welcome-email.ts), called the way
   send-welcome-email calls it and asserted on what comes back; and a light
   structural check of the function itself, for the three orderings that make
   it safe -- the secret is checked before the body is read, the company is
   claimed before anything is sent, and the recipient is the owner's login
   address, never a field the owner can type.

   Run with:  node tests/welcome-email.test.mjs
   (Node 24 strips the TypeScript types itself; npx -y tsx works too.) */
import { readFileSync } from 'node:fs';
import { buildWelcomeEmail } from '../supabase/functions/_shared/welcome-email.ts';

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) pass++;
  else { fail++; console.log('FAIL  ' + label); }
};

const OFFICE = 'https://fenceflowapp.com/dashboard.html';
const SUPPORT = 'support@fenceflowapp.com';
// Exactly what send-welcome-email passes.
const base = {
  companyName: 'Coastal Fence & Gate',
  ownerName: 'Dana Lee',
  recipientEmail: 'dana@coastalfence.com',
  plan: 'crew',
  officeUrl: OFFICE,
  supportEmail: SUPPORT,
};

/** Every place the email could make a mail client fetch or send anything. */
function outboundProblems(html) {
  const problems = [];
  if (/<img\b/i.test(html)) problems.push('has an <img> (a tracking pixel or an image that breaks when blocked)');
  if (/<link\b/i.test(html)) problems.push('has a <link> (a web font or stylesheet fetched on open)');
  if (/\bsrc\s*=/i.test(html)) problems.push('has a src= attribute');
  if (/url\s*\(/i.test(html)) problems.push('has a CSS url()');
  for (const m of html.matchAll(/href="([^"]*)"/g)) {
    const href = m[1].replace(/&amp;/g, '&');
    if (href !== OFFICE && href !== 'mailto:' + SUPPORT) problems.push('links somewhere unexpected: ' + href);
  }
  return problems;
}

/* ---------- subject ---------- */
{
  const { subject } = buildWelcomeEmail(base);
  ok('subject welcomes the business by name', subject === 'Welcome to FenceFlow, Coastal Fence & Gate');
  const evil = buildWelcomeEmail({ ...base, companyName: 'Acme\r\nBcc: victim@example.com' });
  ok('a line break in the name cannot reach the Subject header', !/[\r\n]/.test(evil.subject));
  ok('an empty name still reads as a sentence', buildWelcomeEmail({ ...base, companyName: '  ' }).subject === 'Welcome to FenceFlow, your company');
}

/* ---------- html: what it says ---------- */
{
  const { html } = buildWelcomeEmail(base);
  ok('headline welcomes them by business name, escaped', html.includes('Welcome to FenceFlow, Coastal Fence &amp; Gate.'));
  ok('greets the owner by first name', html.includes('Hi Dana,'));
  ok('step 1: add your prices', html.includes('Add your prices') && html.includes('Catalog'));
  ok('step 2: invite your crew, with the real button name', html.includes('Invite your crew') && html.includes('+ Add'));
  ok('step 3: send your first quote', html.includes('Send your first quote') && html.includes('+ New Job'));
  ok('three step links plus the button, all to the office',
    (html.match(new RegExp('href="' + OFFICE.replace(/[.]/g, '\\.') + '"', 'g')) || []).length >= 5);
  ok('a big "Open your office" button', />\s*Open your office\s*</.test(html));
  ok('the button survives Outlook (VML fallback)', html.includes('<v:roundrect') && html.includes(`href="${OFFICE}"`));
  ok('support contact is there, as a mailto', html.includes(`mailto:${SUPPORT}`));
  ok('says which address to sign in with', html.includes('Sign in with dana@coastalfence.com.'));
  ok('tells an invited owner how to get a password', html.includes('Forgot your password?'));
  ok('says it is one-time', /one-time welcome/.test(html));
}

/* ---------- html: how it is built ---------- */
{
  const { html } = buildWelcomeEmail(base);
  ok('table layout, marked presentational', (html.match(/role="presentation"/g) || []).length >= 4);
  ok('light background, FenceFlow orange and ink', html.includes('#F6F7F5') && html.includes('#FF5A1F') && html.includes('#0B1220'));
  ok('600px max width', html.includes('max-width:600px'));
  ok('no scripts', !/<script\b/i.test(html));
  const problems = outboundProblems(html);
  ok('nothing fetched on open, no tracking, no stray links' + (problems.length ? ': ' + problems.join('; ') : ''), problems.length === 0);
  const x = buildWelcomeEmail({ ...base, companyName: '<b onmouseover=alert(1)>X</b>', ownerName: '"><script>' });
  ok('a hostile company name is escaped, not rendered', !x.html.includes('<b onmouseover') && x.html.includes('&lt;b onmouseover'));
  ok('a hostile owner name is escaped too', !x.html.includes('"><script>'));
}

/* ---------- PLANTED FAILURE: the outbound check has teeth ---------- */
{
  const { html } = buildWelcomeEmail(base);
  const pixel = html.replace('</body>', '<img src="https://t.example.com/open.gif" width="1" height="1"></body>');
  const tracked = html.replace(`href="${OFFICE}"`, 'href="https://click.example.com/r?u=1"');
  ok('planted: a tracking pixel is caught', outboundProblems(pixel).length > 0);
  ok('planted: a rewritten tracking link is caught', outboundProblems(tracked).some(p => p.includes('click.example.com')));
}

/* ---------- plan-aware crew step ---------- */
{
  const solo = buildWelcomeEmail({ ...base, plan: 'solo' });
  ok('Solo is told the truth: one login, move to Crew in Billing', solo.html.includes('one-login plan') && solo.html.includes('Billing'));
  ok('Solo is not told to press + Add in a tab its plan hides', !solo.html.includes('press + Add'));
  const unknown = buildWelcomeEmail({ ...base, plan: null });
  ok('no plan on record reads like Crew/Pro', unknown.html.includes('press + Add'));
}

/* ---------- plain-text alternative ---------- */
{
  const { text } = buildWelcomeEmail(base);
  ok('text: headline', text.startsWith('Welcome to FenceFlow, Coastal Fence & Gate.'));
  ok('text: all three steps, numbered', /1\. Add your prices/.test(text) && /2\. Invite your crew/.test(text) && /3\. Send your first quote/.test(text));
  ok('text: the office URL', text.includes(`Open your office: ${OFFICE}`));
  ok('text: support address', text.includes(SUPPORT));
  ok('text: no markup leaked in', !/<[a-z!/]/i.test(text));
  ok('text: greeting falls back without a name', buildWelcomeEmail({ ...base, ownerName: '' }).text.includes('Hi there,'));
}

/* ---------- the function: the three orderings that make it safe ---------- */
{
  const src = readFileSync(new URL('../supabase/functions/send-welcome-email/index.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ');
  const at = (needle) => src.indexOf(needle);
  ok('function: checks the secret with welcome_email_trigger_ok', at('welcome_email_trigger_ok') > 0);
  ok('function: the secret is checked before the body is read', at('welcome_email_trigger_ok') < at('req.json('));
  ok('function: claims with "welcome_sent_at is null" before sending',
    at('.is("welcome_sent_at", null)') > 0 && at('.is("welcome_sent_at", null)') < at('await fetch(mailUrl'));
  ok('function: sends only when the claim returned a row', /claimed\.length === 0/.test(src));
  ok('function: the recipient is the owner login address (auth admin), not companies.email',
    at('getUserById') > 0 && !/select\([^)]*\bemail\b[^)]*\)/.test(src.slice(at('.from("companies")'), at('.from("profiles")'))));
  const toml = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
  ok('config.toml: the trigger can reach it (verify_jwt = false, pinned)',
    /\[functions\.send-welcome-email\]\s*\nverify_jwt\s*=\s*false/.test(toml));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
