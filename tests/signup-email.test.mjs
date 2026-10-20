/* The signup email: the one a person gets when they CREATE an account, before
   they have told us anything about their business.

   Two halves, like welcome-email.test.mjs: the pure builder
   (supabase/functions/_shared/signup-email.ts), called the way
   send-signup-email calls it and asserted on what comes back; and a
   structural check of the function and the migration, for the orderings and
   the guards that make it safe.

   THE ONE THAT MATTERS MOST is the pair of skips that keep this email from
   arriving beside the welcome one: the function refuses a company whose
   details are already done, and the trigger refuses the same before it spends
   a pg_net call. Someone who signs up and finishes setup in one sitting must
   get the welcome email only.

   Run with:  node tests/signup-email.test.mjs
   (Node 24 strips the TypeScript types itself; npx -y tsx works too.) */
import { readFileSync } from 'node:fs';
import { buildSignupEmail } from '../supabase/functions/_shared/signup-email.ts';

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) pass++;
  else { fail++; console.log('FAIL  ' + label); }
};

const SETUP = 'https://fenceflowapp.com/welcome.html';
const SUPPORT = 'support@fenceflowapp.com';
const base = {
  companyName: 'Marc fence',
  ownerName: 'Marc Henry Beaunissant',
  recipientEmail: 'owner@example.com',
  setupUrl: SETUP,
  supportEmail: SUPPORT,
};

/* ---------- the builder ---------- */
{
  const { subject, html, text } = buildSignupEmail(base);

  ok('subject names the business', subject === 'Finish setting up Marc fence on FenceFlow');
  ok('subject is one line', !/[\r\n]/.test(subject));
  ok('greeting uses the first name only', html.includes('Hi Marc,') && !html.includes('Hi Marc Henry'));
  ok('html: the setup button points at welcome.html', html.includes(`href="${SETUP}"`));
  ok('html: the sign-in address is shown', html.includes('owner@example.com'));
  ok('html: says there is no password', /no password/i.test(html));
  ok('html: support address is a mailto', html.includes(`mailto:${SUPPORT}`));
  ok('html: nothing is fetched when it opens', !/<img|background-image|<script|<link/i.test(html));
  ok('html: the fallback URL is printed for a dead button', html.includes(SETUP));

  ok('text: has the setup link', text.includes(`Finish setting up: ${SETUP}`));
  ok('text: support address', text.includes(SUPPORT));
  ok('text: no markup leaked in', !/<[a-z!/]/i.test(text));

  /* A business name is genuinely optional at signup -- that is the whole
     point of this email -- so every line has to read without one. */
  const noName = buildSignupEmail({ ...base, companyName: '', ownerName: '' });
  ok('no company name: subject still reads',
    noName.subject === 'Finish setting up your FenceFlow account');
  ok('no company name: no empty gap or "undefined"',
    !/undefined|null|\s{2,}on FenceFlow/.test(noName.subject + noName.text));
  ok('no owner name: greeting falls back', noName.text.includes('Hi there,'));
  ok('null company name is handled like a blank one',
    buildSignupEmail({ ...base, companyName: null }).subject === noName.subject);

  /* Escaping: the business name is typed by the person signing up. */
  const nasty = buildSignupEmail({ ...base, companyName: '<script>x</script>&"' });
  ok('html: the typed business name is escaped',
    !nasty.html.includes('<script>x</script>') && nasty.html.includes('&lt;script&gt;'));
  ok('subject: control characters are stripped',
    !/[\r\n]/.test(buildSignupEmail({ ...base, companyName: 'A\r\nB' }).subject));
}

/* ---------- the function: the orderings and skips that make it safe ---------- */
{
  const src = readFileSync(new URL('../supabase/functions/send-signup-email/index.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ');
  const at = (needle) => src.indexOf(needle);

  ok('function: checks the secret with signup_email_trigger_ok', at('signup_email_trigger_ok') > 0);
  ok('function: the secret is checked before the body is read',
    at('signup_email_trigger_ok') < at('req.json('));
  ok('function: claims with "signup_sent_at is null" before sending',
    at('.is("signup_sent_at", null)') > 0 && at('.is("signup_sent_at", null)') < at('await fetch(mailUrl'));
  ok('function: sends only when the claim returned a row', /claimed\.length === 0/.test(src));
  ok('function: the recipient is the owner login address, not companies.email',
    at('getUserById') > 0 &&
    !/select\([^)]*\bemail\b[^)]*\)/.test(src.slice(at('.from("companies")'), at('.from("profiles")'))));

  /* THE SKIP. Without it, a fast signup gets two emails minutes apart. */
  ok('function: skips a company whose details are already done',
    /details_completed_at\)\s*\{[\s\S]{0,200}?details already done/.test(src));
  ok('function: that skip happens before the claim',
    at('details already done') < at('.is("signup_sent_at", null)'));
  ok('function: skips a ZZ TEST company', /\^\\s\*zz test/i.test(src));
  ok('function: a 4xx refusal gives the claim back',
    /status >= 400 && res\.status < 500/.test(src) && /signup_sent_at: null/.test(src));
  ok('function: no address is logged',
    !/log\([^)]*\b(to|email|recipient)\b\s*[,)]/.test(src));

  const toml = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
  ok('config.toml: the trigger can reach it (verify_jwt = false, pinned)',
    /\[functions\.send-signup-email\]\s*\nverify_jwt\s*=\s*false/.test(toml));
}

/* ---------- the migration ---------- */
{
  const sql = readFileSync(new URL('../supabase_r17_signup_email.sql', import.meta.url), 'utf8');

  ok('sql: adds the column without dropping anything',
    /add column if not exists signup_sent_at timestamptz/.test(sql) && !/\bdrop (table|column)\b/i.test(sql));
  ok('sql: fires on INSERT of an OWNER profile, not on the company row',
    /after insert on public\.profiles/.test(sql) && /when \(new\.role = 'OWNER'\)/.test(sql));
  ok('sql: never fires on existing rows (insert-only, so nobody is retro-emailed)',
    !/after (update|insert or update) on public\.profiles/.test(sql));
  ok('sql: the trigger skips an already-sent company', /co\.signup_sent_at is not null/.test(sql));
  ok('sql: the trigger skips a company past the details step', /co\.details_completed_at is not null/.test(sql));
  ok('sql: the trigger skips a ZZ TEST company', /zz test/i.test(sql));
  ok('sql: a failure cannot fail the signup', /exception when others then/.test(sql) && /raise warning/.test(sql));
  ok('sql: the column is protected from signed-in callers',
    /protect_signup_sent_at/.test(sql) && /auth\.uid\(\) is not null/.test(sql));
  ok('sql: the door is service_role only',
    /revoke all on function public\.signup_email_trigger_ok\(text\) from public, anon, authenticated/.test(sql) &&
    /grant execute on function public\.signup_email_trigger_ok\(text\) to service_role/.test(sql));
  ok('sql: the secret is generated, never written in the file',
    /gen_random_bytes\(32\)/.test(sql) && !/[0-9a-f]{64}/.test(sql));
  ok('sql: digests are compared, not the raw secrets', /extensions\.digest/.test(sql));
  ok('sql: posts to send-signup-email with the signup header',
    /functions\/v1\/send-signup-email/.test(sql) && /x-fenceflow-signup/.test(sql));

  /* The two emails must stay separate: this file must not touch r6's column. */
  ok('sql: does not touch welcome_sent_at', !/welcome_sent_at\s*:?=/.test(sql));
}

/* ---------- the two builders are not the same email ---------- */
{
  const signup = buildSignupEmail(base);
  ok('signup email points at setup, not the office',
    signup.html.includes('welcome.html') && !signup.html.includes('dashboard.html'));
  ok('signup email does not claim they are set up',
    !/all set up|your office is ready/i.test(signup.html));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
