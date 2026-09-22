/* Who a push that carries money reaches -- and every other push outside
   notify-job-change (stripe-webhook, square-webhook, quote-view,
   attention-sweep).

   Until 2026-09-22 the payment pushes read every device_tokens row in the
   company and sent to all of them: "Payment received: $4200.00 -- Dana Smith
   paid ...", every chargeback and every declined card went to the crew's
   phones with the amount in the headline, and quote-view's "Quote approved"
   went to crew on jobs they cannot open. Live on the day: one crew login with
   three phones registered. Crew never sees money; now it is never told any.

   Three parts, each checker proven by a planted failure.

   A. PURE: moneyAudience and standingJobEvent in
      supabase/functions/_shared/job-push.ts. The role table they share with
      the job audience is held to has_permission() by
      tests/notify-job-change.test.mjs, so it is not re-proven here.

   B. THE READS: supabase/functions/_shared/push-recipients.ts against an
      in-memory client, called exactly as the functions call it, including
      every read failing in turn. A failure must tell fewer people, never
      more.

   C. THE FUNCTIONS: the real stripe-webhook, square-webhook and quote-view
      handlers, TypeScript stripped by Node's own stripper, imports swapped
      for the fake client and the REAL shared modules, requests signed the
      way Stripe and Square sign them, FCM and Google's token endpoint faked.
      Asserted on which phones were actually sent what. The versions before
      this change (from git) run through the same harness and must be caught
      broadcasting.

   node tests/money-push-audience.test.mjs      (no network, no database)
   (Node 24 strips the TypeScript types itself.) */
import { spawnSync } from 'node:child_process';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import * as jobPush from '../supabase/functions/_shared/job-push.ts';
import * as pushRecipients from '../supabase/functions/_shared/push-recipients.ts';
import * as quoteDeposit from '../supabase/functions/_shared/quote-deposit.ts';
import * as recordPayment from '../supabase/functions/_shared/record-payment.ts';

const { jobPushAudience, moneyAudience, seesAllJobs, standingJobEvent } = jobPush;
const { jobDevices, moneyDevices } = pushRecipients;

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++;
  else { fail++; console.log('FAIL  ' + label + (detail ? ' -- ' + detail : '')); }
};

// The commit before this change: stripe-webhook and square-webhook as they
// shipped, broadcasting. Pinned rather than HEAD, which carries the fix once
// it is committed.
const BEFORE = '01a67b1';

// ---------------------------------------------------------------------------
// The company
// ---------------------------------------------------------------------------
const C1 = 'c1000000-0000-4000-8000-000000000001';
const C2 = 'c2000000-0000-4000-8000-000000000002';
const JOB = '22222222-bbbb-4bbb-8bbb-000000000001';
const E_LEAD = '11111111-aaaa-4aaa-8aaa-000000000001';
const E_OTHER = '11111111-aaaa-4aaa-8aaa-000000000002';
const E_HELPER = '11111111-aaaa-4aaa-8aaa-000000000003';
const TOKEN = 'b0000000-0000-4000-8000-00000000000b';

const P = (id, role, ov = '', company = C1) => ({ id, company_id: company, role, permission_overrides: ov });
const PROFILES = [
  P('owner', 'OWNER'), P('manager', 'MANAGER'), P('sales', 'SALES'), P('accountant', 'ACCOUNTANT'),
  P('foreman', 'FOREMAN'),
  P('crewLead', 'CREW'),                     // leads the job
  P('crewHelper', 'CREW'),                   // open job_assignments row on it
  P('crewOther', 'CREW'),                    // on another job
  P('crewMoney', 'CREW', '+SEE_MONEY'),      // an owner let them see money
  P('crewEditor', 'CREW', '+EDIT_JOBS'),     // sees every job, but no money
  P('managerNoMoney', 'MANAGER', '-SEE_MONEY'),
  P('owner2', 'OWNER', '', C2),              // another company
  P('leaver', 'SALES', '', C2),              // left C1 for C2; an old phone row still says C1
];
const EMPLOYEES = [
  { company_id: C1, sync_id: E_LEAD, profile_id: 'crewLead', is_active: true, deleted_at: null },
  { company_id: C1, sync_id: E_HELPER, profile_id: 'crewHelper', is_active: true, deleted_at: null },
  { company_id: C1, sync_id: E_OTHER, profile_id: 'crewOther', is_active: true, deleted_at: null },
];
const ASSIGNMENTS = [
  { company_id: C1, job_sync_id: JOB, employee_sync_id: E_HELPER, ended_at: null },
  { company_id: C1, job_sync_id: JOB, employee_sync_id: E_OTHER, ended_at: '2026-09-01T00:00:00Z' },
];
const DEVICES = [
  ...PROFILES.map((p) => ({ token: `tok-${p.id}`, user_id: p.id, company_id: p.company_id })),
  { token: 'tok-leaver-old', user_id: 'leaver', company_id: C1 },
];

/** Who may be told an amount, in C1. */
const MONEY = ['accountant', 'crewMoney', 'manager', 'owner', 'sales'];
/** Who may be told about JOB (lead E_LEAD, helper E_HELPER), in C1. */
const JOB_PEOPLE = ['accountant', 'crewEditor', 'crewHelper', 'crewLead', 'crewMoney', 'foreman',
  'manager', 'managerNoMoney', 'owner', 'sales'];
const tokensOf = (ids) => ids.map((id) => `tok-${id}`);

// ===========================================================================
// A. Pure
// ===========================================================================

/** Every way `fn` (profiles -> ids) disagrees with the money rule. */
function moneyChecks(fn, label) {
  const results = [];
  const check = (name, cond, detail = '') => results.push({ name: `${label}: ${name}`, cond, detail });
  const got = (ps) => new Set(fn(ps));

  const defaults = got([P('o', 'OWNER'), P('m', 'MANAGER'), P('s', 'SALES'), P('a', 'ACCOUNTANT'), P('f', 'FOREMAN'), P('c', 'CREW')]);
  check('owner, manager, sales and accountant are told money by role',
    ['o', 'm', 's', 'a'].every((id) => defaults.has(id)), [...defaults].join(','));
  check('foreman is not told money', !defaults.has('f'));
  check('crew is not told money', !defaults.has('c'));
  check('crew with +SEE_MONEY is told', got([P('c', 'CREW', '+SEE_MONEY')]).has('c'));
  check('manager with -SEE_MONEY is not told', !got([P('m', 'MANAGER', '-SEE_MONEY')]).has('m'));
  // has_permission tests the revoke before the role, OWNER included, so an
  // owner whose money was switched off cannot read it and is not pushed it.
  check('owner with -SEE_MONEY is not told (revoke before role, as in SQL)', !got([P('o', 'OWNER', '-SEE_MONEY')]).has('o'));
  check('crew with +EDIT_JOBS sees every job but is not told money', !got([P('c', 'CREW', '+EDIT_JOBS')]).has('c'));
  check('foreman with +SEE_MONEY is told', got([P('f', 'FOREMAN', '+SEE_MONEY')]).has('f'));
  check('a grant and a revoke of SEE_MONEY: the revoke wins', !got([P('c', 'CREW', '+SEE_MONEY,-SEE_MONEY')]).has('c'));
  check('accountant with -SEE_PAY still sees money', got([P('a', 'ACCOUNTANT', '-SEE_PAY')]).has('a'));
  check('crew with +SEE_PAY is not told money', !got([P('c', 'CREW', '+SEE_PAY')]).has('c'));
  check('an unknown, lower-case or null role holds nothing',
    got([P('x', 'SUPERVISOR'), P('y', 'owner'), P('z', null)]).size === 0);
  check('a row with no id is skipped', !got([P('', 'OWNER')]).has(''));
  const all = got(PROFILES.filter((p) => p.company_id === C1));
  check('the company: exactly the SEE_MONEY holders',
    JSON.stringify([...all].sort()) === JSON.stringify(MONEY), [...all].sort().join(','));
  check('nobody outside the profiles given is ever added', got([]).size === 0);
  return results;
}

for (const r of moneyChecks(moneyAudience, 'moneyAudience')) ok(r.name, r.cond, r.detail);

// PLANTED: each wrong rule must fail the checks above.
{
  const failed = (fn, label) => moneyChecks(fn, label).filter((r) => !r.cond);
  const broadcast = (ps) => ps.map((p) => p.id);
  ok('PLANTED: the old broadcast (every profile) fails', failed(broadcast, 'broadcast').length >= 5);
  // The easy mistake: reuse the job audience for money. A foreman sees every
  // job and holds no money.
  const jobRule = (ps) => ps.filter(seesAllJobs).map((p) => p.id);
  const f = failed(jobRule, 'seesAllJobs');
  ok('PLANTED: the job audience used for money is caught (foreman, +EDIT_JOBS crew)',
    f.some((r) => /foreman is not/.test(r.name)) && f.some((r) => /\+EDIT_JOBS/.test(r.name)), f.map((r) => r.name).join(' | '));
  // A role list that ignores overrides.
  const byRole = (ps) => ps.filter((p) => ['OWNER', 'MANAGER', 'SALES', 'ACCOUNTANT'].includes(p.role)).map((p) => p.id);
  const g = failed(byRole, 'role names');
  ok('PLANTED: a role-name list that ignores overrides is caught (+SEE_MONEY crew, -SEE_MONEY manager)',
    g.some((r) => /\+SEE_MONEY is told/.test(r.name)) && g.some((r) => /manager with -SEE_MONEY/.test(r.name)));
}

// standingJobEvent: quote-view's approval, addressed like notify-job-change.
{
  const rec = { sync_id: JOB.toUpperCase(), customer_name: '  Dana Smith ', assigned_employee_sync_id: ` ${E_LEAD.toUpperCase()}` };
  const e = standingJobEvent(rec, 'ACCEPTED');
  ok('standingJobEvent: the job and its lead, case-blind; nobody is the new lead',
    e.kind === 'ACCEPTED' && e.jobSyncId === JOB && e.leadSyncId === E_LEAD && e.newLeadSyncId === '' && e.customer === 'Dana Smith');
  ok('standingJobEvent: no lead and no name read as none', (() => {
    const n = standingJobEvent({ sync_id: JOB, customer_name: ' ', assigned_employee_sync_id: null }, 'ACCEPTED');
    return n.leadSyncId === '' && n.customer === null;
  })());
  const aud = jobPushAudience({
    event: e,
    profiles: PROFILES.filter((p) => p.company_id === C1),
    employees: EMPLOYEES,
    crewSyncIds: [E_HELPER],
  });
  ok('standingJobEvent + jobPushAudience: exactly who can open the job',
    JSON.stringify([...aud.keys()].sort()) === JSON.stringify(JOB_PEOPLE), [...aud.keys()].sort().join(','));
  ok('... and nobody is told "You were assigned"', [...aud.values()].every((v) => !v.newLead));
  // PLANTED: dropping the lead leaves the lead's crew login out.
  const leadless = jobPushAudience({ event: { ...e, leadSyncId: '' }, profiles: PROFILES.filter((p) => p.company_id === C1), employees: EMPLOYEES, crewSyncIds: [E_HELPER] });
  ok('PLANTED: an event without its lead is caught', !leadless.has('crewLead'));
}

// ===========================================================================
// B. The reads (push-recipients.ts) against an in-memory client
// ===========================================================================

/**
 * An in-memory service-role client. Records every call. `failing` names
 * tables whose every read answers an error; `missing` names tables that are
 * not there (PostgREST's PGRST205).
 */
function fakeDb(tables, { failing = [], missing = [] } = {}) {
  const t = structuredClone(tables);
  const log = [];
  class Query {
    constructor(table) { Object.assign(this, { table, op: 'select', cols: '*', filters: [], returning: false, lim: Infinity }); }
    select(cols) { if (this.op === 'select') this.cols = cols ?? '*'; else this.returning = true; return this; }
    eq(k, v) { this.filters.push((r) => String(r[k]) === String(v)); return this; }
    is(k, v) { this.filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return this; }
    in(k, vs) { this.filters.push((r) => vs.map(String).includes(String(r[k]))); return this; }
    not(k, op, v) {
      if (op !== 'is' || v !== null) throw new Error(`fake client: not(${op}, ${v}) is not modelled`);
      this.filters.push((r) => r[k] != null); return this;
    }
    or() { return this; }
    order() { return this; }
    limit(n) { this.lim = n; return this; }
    update(p) { this.op = 'update'; this.payload = p; return this; }
    insert(p) { this.op = 'insert'; this.payload = p; return this; }
    upsert(p) { this.op = 'upsert'; this.payload = p; return this; }
    delete() { this.op = 'delete'; return this; }
    maybeSingle() { this.mode = 'maybe'; return this.run(); }
    single() { this.mode = 'one'; return this.run(); }
    then(res, rej) { return this.run().then(res, rej); }
    async run() {
      log.push({ op: this.op, table: this.table, cols: this.cols });
      if (missing.includes(this.table)) return { data: null, error: { code: 'PGRST205', message: `planted: no table ${this.table}` } };
      if (failing.includes(this.table)) return { data: null, error: { code: 'XX000', message: `planted: ${this.table} unreadable` } };
      const rows = (t[this.table] ??= []);
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === 'update') {
        hit.forEach((r) => Object.assign(r, this.payload));
        return { data: this.returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
      }
      if (this.op === 'insert' || this.op === 'upsert') { rows.push({ ...this.payload }); return { data: null, error: null }; }
      if (this.op === 'delete') { t[this.table] = rows.filter((r) => !hit.includes(r)); return { data: null, error: null }; }
      const cols = String(this.cols).split(',').map((c) => c.trim()).filter(Boolean);
      const project = (r) => (cols.includes('*') ? r : Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])));
      const out = hit.slice(0, this.lim).map(project);
      if (this.mode === 'maybe') return { data: out[0] ?? null, error: null };
      if (this.mode === 'one') return out[0] ? { data: out[0], error: null } : { data: null, error: { message: 'no row' } };
      return { data: out, error: null };
    }
  }
  return {
    tables: t,
    log,
    from: (table) => new Query(table),
    rpc: async (fn) => { log.push({ op: 'rpc', table: fn }); return { data: fn === 'quote_phone_try' ? 'OK' : true, error: null }; },
  };
}

const world = (extra = {}) => ({
  profiles: PROFILES, employees: EMPLOYEES, job_assignments: ASSIGNMENTS, device_tokens: DEVICES, ...extra,
});

/** Everything wrong with a set of phones addressed, against the allowed people. */
function addressProblems(tokens, allowedIds) {
  const out = [];
  const allowed = new Set(tokensOf(allowedIds));
  for (const tok of tokens) if (!allowed.has(tok)) out.push(`${tok} would be told`);
  for (const tok of allowed) if (!tokens.includes(tok)) out.push(`${tok} would not be told`);
  if (new Set(tokens).size !== tokens.length) out.push('a phone would be told twice');
  return out;
}
const toks = (rows) => rows.map((r) => r.token);
const readDevices = (db) => db.log.some((e) => e.table === 'device_tokens');

// The quiet warnings a failing read prints are expected here; keep the
// output to the verdicts.
const warn = console.warn;
console.warn = () => {};
try {
  {
    const db = fakeDb(world());
    const p = addressProblems(toks(await moneyDevices(db, C1)), MONEY);
    ok('moneyDevices: exactly the SEE_MONEY holders\' phones, none from another company or a leaver', p.length === 0, p.join(' | '));
  }
  {
    // The company filter, which only a push to the leaver's NEW company can
    // see: leaver is SALES in C2 and holds SEE_MONEY there, and the phone
    // they last used at C1 still says C1. By user id alone it would be told
    // C2's money. (C1's push above cannot show this: the leaver is not in
    // C1's profiles, so no C1 read ever names them.)
    const db = fakeDb(world());
    const p = addressProblems(toks(await moneyDevices(db, C2)), ['leaver', 'owner2']);
    ok('moneyDevices: a phone still registered under the company its owner left hears nothing of the new one', p.length === 0, p.join(' | '));
  }
  {
    const db = fakeDb(world(), { failing: ['profiles'] });
    const got = await moneyDevices(db, C1);
    ok('moneyDevices: profiles unreadable -> nobody, and no phone is even read', got.length === 0 && !readDevices(db));
  }
  {
    const db = fakeDb(world(), { failing: ['device_tokens'] });
    ok('moneyDevices: device_tokens unreadable -> nobody, no throw', (await moneyDevices(db, C1)).length === 0);
  }
  {
    const db = fakeDb(world({ profiles: PROFILES.map((p) => ({ ...p, role: 'CREW', permission_overrides: '' })) }));
    const got = await moneyDevices(db, C1);
    ok('moneyDevices: nobody holds SEE_MONEY -> no phone read at all (never "no filter")', got.length === 0 && !readDevices(db));
  }
  {
    const db = fakeDb(world());
    const got = await jobDevices(db, C1, standingJobEvent({ sync_id: JOB, customer_name: 'Dana Smith', assigned_employee_sync_id: E_LEAD }, 'ACCEPTED'));
    const p = addressProblems(toks(got), JOB_PEOPLE);
    ok('jobDevices: exactly the phones of people who can open the job', p.length === 0, p.join(' | '));
  }
  {
    const db = fakeDb(world(), { failing: ['employees'] });
    const got = await jobDevices(db, C1, standingJobEvent({ sync_id: JOB, assigned_employee_sync_id: E_LEAD }, 'ACCEPTED'));
    const p = addressProblems(toks(got), JOB_PEOPLE.filter((id) => !['crewLead', 'crewHelper'].includes(id)));
    ok('jobDevices: employees unreadable -> the see-all users only, no crew', p.length === 0, p.join(' | '));
  }
  {
    const db = fakeDb(world(), { missing: ['job_assignments'] });
    const got = await jobDevices(db, C1, standingJobEvent({ sync_id: JOB, assigned_employee_sync_id: E_LEAD }, 'ACCEPTED'));
    const p = addressProblems(toks(got), JOB_PEOPLE.filter((id) => id !== 'crewHelper'));
    ok('jobDevices: before job_assignments exists -> the lead still, no helper', p.length === 0, p.join(' | '));
  }
  {
    const db = fakeDb(world(), { failing: ['profiles'] });
    const got = await jobDevices(db, C1, standingJobEvent({ sync_id: JOB, assigned_employee_sync_id: E_LEAD }, 'ACCEPTED'));
    ok('jobDevices: profiles unreadable -> nobody, no throw', got.length === 0 && !readDevices(db));
  }
  // PLANTED: the read every one of these functions used to make.
  {
    const db = fakeDb(world());
    const { data } = await db.from('device_tokens').select('token').eq('company_id', C1);
    const p = addressProblems(toks(data), MONEY);
    ok('PLANTED: the old company-wide read is caught telling crew', p.some((s) => s.startsWith('tok-crewOther would be told')), p.join(' | '));
  }
} finally {
  console.warn = warn;
}

// ===========================================================================
// C. The functions, end to end
// ===========================================================================

const SHARED = {
  '../_shared/job-push.ts': jobPush,
  '../_shared/push-recipients.ts': pushRecipients,
  '../_shared/quote-deposit.ts': quoteDeposit,
  '../_shared/record-payment.ts': recordPayment,
};

/**
 * TypeScript source made runnable: types stripped, `export` dropped, and
 * every import line answered by `resolve` (import path -> module, or null).
 * An import it cannot answer fails loudly, because the harness would no
 * longer describe the file.
 */
function link(src, resolve) {
  let js = stripTypeScriptTypes(src);
  const importRe = /^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";?[ \t]*$/gm;
  const provided = {};
  for (const [, list, from] of js.matchAll(importRe)) {
    const mod = resolve(from);
    if (!mod) throw new Error(`an import the harness does not supply: ${from}`);
    for (const n of list.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!(n in mod)) throw new Error(`${from} exports no ${n}`);
      provided[n] = mod[n];
    }
  }
  js = js.replace(importRe, '').replace(/^export /gm, '');
  if (/^import /m.test(js)) throw new Error('an import the harness did not strip');
  return { js, names: Object.keys(provided), values: Object.values(provided) };
}

/**
 * Runs an edge function's source against the fake client and fetch. Its
 * imports are createClient (the fake) and the REAL shared modules.
 */
function load(src, { env, db, fetchImpl }) {
  const { js, names, values } = link(src, (from) => (/supabase-js/.test(from)
    ? { createClient: () => db }
    : Object.hasOwn(SHARED, from) ? SHARED[from] : null));
  let handler = null;
  const Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
  new Function('Deno', 'fetch', ...names, js)(Deno, fetchImpl, ...values);
  if (typeof handler !== 'function') throw new Error('Deno.serve was never called');
  return handler;
}

/**
 * push-recipients.ts built from its source rather than imported, so a plant
 * can edit it first. Its one import is the real job-push.ts.
 */
function recipientsFrom(src) {
  const { js, names, values } = link(src, (from) => (from === './job-push.ts' ? jobPush : null));
  return new Function(...names, `${js}\nreturn { devicesOf, moneyDevices, jobDevices };`)(...values);
}

// A real key, so each function's own JWT signing runs; Google is faked.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const SA = JSON.stringify({ client_email: 'push@test.invalid', private_key: privateKey, project_id: 'fenceflow-test' });

/** Google's token endpoint and FCM, recording every message sent. */
function fakeGoogle(sent) {
  return async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'at-test' }), { status: 200 });
    if (/^https:\/\/fcm\.googleapis\.com\/v1\/projects\/fenceflow-test\/messages:send$/.test(u)) {
      const m = JSON.parse(init.body).message;
      const words = m.data ?? m.notification ?? {};
      sent.push({ token: m.token, title: words.title, body: words.body });
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
}

const STRIPE_SECRET = 'whsec_test_only';
const SQUARE_KEY = 'square-key-test-only';
const SQUARE_URL = 'https://fn.test/square-webhook';
// SQUARE_ENVIRONMENT unset is sandbox, so that is the host a dispute asks.
const SQUARE_API = 'https://connect.squareupsandbox.com';
const SQUARE_PAYMENT = 'sqpay_1';

/**
 * Square's payment lookup in front of Google: a Square dispute names the
 * payment it came from, not the order, and the function asks Square which
 * order that was (ord_1, jp2's).
 */
function fakeSquareAndGoogle(sent) {
  const google = fakeGoogle(sent);
  return async (url, init) => (String(url) === `${SQUARE_API}/v2/payments/${SQUARE_PAYMENT}`
    ? new Response(JSON.stringify({ payment: { id: SQUARE_PAYMENT, order_id: 'ord_1' } }), { status: 200 })
    : google(url, init));
}

const JOB_ROW = {
  id: 41, sync_id: JOB, company_id: C1, customer_name: 'Dana Smith', address: '1 Oak St', phone: '',
  status: 'SENT', deleted_at: null, quote_token: TOKEN, assigned_employee_sync_id: E_LEAD,
  contract_total: 4200, deposit_amount: 4200, amount_paid: 0, refunded_amount: 0,
  tax_rate_percent: 0, discount_percent: 0, accepted_total: null, signed_at: null,
  quote_viewed_at: null, quote_approved_at: null, quote_approved_name: '', calibration_pixels_per_foot: 20,
  quote_phone_attempts: 0, quote_phone_locked_until: null, reapproval_required_at: null, reapproval_reason: '',
};
const PAYMENT_ROWS = [
  { id: 'jp1', processor: 'stripe', stripe_id: 'plink_1', external_id: 'pi_1', job_sync_id: JOB, company_id: C1,
    amount_cents: 420000, fee_cents: 0, status: 'pending', livemode: true },
  { id: 'jp2', processor: 'square', external_id: 'ord_1', job_sync_id: JOB, company_id: C1,
    amount_cents: 420000, fee_cents: 0, status: 'pending' },
];

const paymentWorld = (opts) => fakeDb(world({
  jobs: [structuredClone(JOB_ROW)], job_payments: PAYMENT_ROWS, payment_records: [],
  payment_connections: [{ processor: 'square', external_id: 'm1', company_id: C1, access_token: 'sq-at-test-only' }],
}), opts);

async function stripe(src, event, opts = {}) {
  const db = paymentWorld(opts);
  const sent = [];
  const handler = load(src, { env: { STRIPE_WEBHOOK_SECRET: STRIPE_SECRET, FIREBASE_SERVICE_ACCOUNT: SA }, db, fetchImpl: fakeGoogle(sent) });
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', STRIPE_SECRET).update(`${t}.${raw}`).digest('hex');
  const res = await handler(new Request('https://fn.test/stripe-webhook', {
    method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}` }, body: raw,
  }));
  return { status: res.status, text: await res.text(), sent, db };
}

async function square(src, event, opts = {}) {
  const db = paymentWorld(opts);
  const sent = [];
  const handler = load(src, {
    env: { SQUARE_WEBHOOK_SIGNATURE_KEY: SQUARE_KEY, SQUARE_WEBHOOK_URL: SQUARE_URL, FIREBASE_SERVICE_ACCOUNT: SA },
    db, fetchImpl: fakeSquareAndGoogle(sent),
  });
  const raw = JSON.stringify(event);
  const sig = createHmac('sha256', SQUARE_KEY).update(SQUARE_URL + raw).digest('base64');
  const res = await handler(new Request(SQUARE_URL, {
    method: 'POST', headers: { 'x-square-hmacsha256-signature': sig }, body: raw,
  }));
  return { status: res.status, text: await res.text(), sent, db };
}

async function quoteApprove(src, opts = {}) {
  const db = fakeDb(world({
    jobs: [structuredClone(JOB_ROW)], companies: [{ id: C1, name: 'Test Fence Co' }],
    estimate_line_items: [], change_orders: [], payment_connections: [],
  }), opts);
  const sent = [];
  const handler = load(src, { env: { FIREBASE_SERVICE_ACCOUNT: SA }, db, fetchImpl: fakeGoogle(sent) });
  const res = await handler(new Request(`https://fn.test/quote-view?t=${TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'approve', name: 'Pat Buyer' }),
  }));
  return { status: res.status, body: await res.json(), sent, db };
}

const SRC = (fn) => readFileSync(join(ROOT, `supabase/functions/${fn}/index.ts`), 'utf8');
const gitSrc = (fn) => {
  const r = spawnSync('git', ['show', `${BEFORE}:supabase/functions/${fn}/index.ts`], { encoding: 'utf8', cwd: ROOT });
  return r.status === 0 && r.stdout && !r.stdout.includes('push-recipients') ? r.stdout : null;
};
const tokensSent = (r) => r.sent.map((s) => s.token);

const T = Math.floor(Date.now() / 1000);
const EVENTS = {
  paid: { type: 'checkout.session.completed', livemode: true,
    data: { object: { mode: 'payment', payment_link: 'plink_1', payment_intent: 'pi_1', metadata: { company_id: C1 } } } },
  dispute: { type: 'charge.dispute.created', livemode: true,
    data: { object: { id: 'dp_1', payment_intent: 'pi_1', amount: 420000, currency: 'usd', reason: 'fraudulent', status: 'needs_response', created: T } } },
  declined: { type: 'checkout.session.async_payment_failed', livemode: true,
    data: { object: { mode: 'payment', payment_link: 'plink_1' } } },
  squareDeclined: { type: 'payment.updated', merchant_id: 'm1',
    data: { object: { payment: { status: 'FAILED', order_id: 'ord_1', amount_money: { amount: 420000, currency: 'USD' } } } } },
  // Opened, not yet lost: the warning, with the amount in the body.
  squareDispute: { type: 'dispute.created', merchant_id: 'm1',
    data: { object: { dispute: { id: 'dsp_1', state: 'EVIDENCE_REQUIRED', reason: 'NOT_AS_DESCRIBED',
      amount_money: { amount: 420000, currency: 'USD' }, disputed_payment: { payment_id: SQUARE_PAYMENT },
      created_at: '2026-09-20T12:00:00Z' } } } },
};
const SQUARE_DISPUTE_WORDS = { title: 'A customer has disputed a payment', body: '$4200.00 — NOT AS DESCRIBED. Open the job in FenceFlow.' };

console.warn = () => {};
try {
  // ---- stripe-webhook: every push carries an amount ----
  {
    const r = await stripe(SRC('stripe-webhook'), EVENTS.paid);
    const p = addressProblems(tokensSent(r), MONEY);
    ok('stripe payment received: only SEE_MONEY phones', r.status === 200 && p.length === 0, `${r.status} ${r.text} | ${p.join(' | ')}`);
    ok('... with the same words as before',
      r.sent[0]?.title === 'Payment received: $4200.00'
      && r.sent[0]?.body === 'Dana Smith paid $4200.00. Total paid on this job is now $4200.00.', JSON.stringify(r.sent[0]));
  }
  {
    const r = await stripe(SRC('stripe-webhook'), EVENTS.dispute);
    const p = addressProblems(tokensSent(r), MONEY);
    ok('stripe chargeback: only SEE_MONEY phones', r.status === 200 && p.length === 0, `${r.status} ${r.text} | ${p.join(' | ')}`);
    ok('... with the same words as before',
      r.sent[0]?.title === 'A customer has disputed a payment' && r.sent[0]?.body === '$4200.00 — fraudulent. Open the job in FenceFlow.',
      JSON.stringify(r.sent[0]));
  }
  {
    const r = await stripe(SRC('stripe-webhook'), EVENTS.declined);
    const p = addressProblems(tokensSent(r), MONEY);
    ok('stripe card declined: only SEE_MONEY phones', r.status === 200 && p.length === 0, `${r.status} ${r.text} | ${p.join(' | ')}`);
    ok('... with the same words as before', r.sent[0]?.title === "A customer's card was declined"
      && r.sent[0]?.body === '$4200.00 did not go through. Open the job in FenceFlow to try again.', JSON.stringify(r.sent[0]));
  }
  {
    const r = await stripe(SRC('stripe-webhook'), EVENTS.dispute, { failing: ['profiles'] });
    ok('stripe chargeback, profiles unreadable: nobody told, and the webhook still answers 200 (no retry storm)',
      r.status === 200 && r.sent.length === 0 && r.db.tables.jobs[0].dispute_reason === 'fraudulent', `${r.status} ${r.sent.length}`);
  }

  // ---- square-webhook ----
  {
    const r = await square(SRC('square-webhook'), EVENTS.squareDeclined);
    const p = addressProblems(tokensSent(r), MONEY);
    ok('square card declined: only SEE_MONEY phones', r.status === 200 && p.length === 0, `${r.status} ${r.text} | ${p.join(' | ')}`);
    ok('... with the same words as before', r.sent[0]?.title === "A customer's card was declined"
      && r.sent[0]?.body === '$4200.00 did not go through. Open the job in FenceFlow to try again.', JSON.stringify(r.sent[0]));
  }
  {
    const r = await square(SRC('square-webhook'), EVENTS.squareDispute);
    const p = addressProblems(tokensSent(r), MONEY);
    ok('square chargeback: only SEE_MONEY phones', r.status === 200 && r.text === 'dispute recorded' && p.length === 0,
      `${r.status} ${r.text} | ${p.join(' | ')}`);
    ok('... with the same words as before', r.sent[0]?.title === SQUARE_DISPUTE_WORDS.title
      && r.sent[0]?.body === SQUARE_DISPUTE_WORDS.body, JSON.stringify(r.sent[0]));
  }
  {
    const r = await square(SRC('square-webhook'), EVENTS.squareDispute, { failing: ['profiles'] });
    ok('square chargeback, profiles unreadable: recorded, nobody told, and still 200',
      r.status === 200 && r.sent.length === 0 && r.db.tables.jobs[0].dispute_status === 'EVIDENCE_REQUIRED', `${r.status} ${r.text} ${r.sent.length}`);
  }

  // ---- quote-view: no amount, so the job's audience ----
  {
    const r = await quoteApprove(SRC('quote-view'));
    const p = addressProblems(tokensSent(r), JOB_PEOPLE);
    ok('quote approved: exactly the phones that can open the job (lead and helper in, other crew out)',
      r.status === 200 && p.length === 0, `${r.status} ${JSON.stringify(r.body)} | ${p.join(' | ')}`);
    ok('... with the same words as before', r.sent[0]?.title === 'Quote approved 🎉'
      && r.sent[0]?.body === 'Pat Buyer approved the quote for Dana Smith.', JSON.stringify(r.sent[0]));
    ok('... and the push carries no amount', r.sent.every((s) => !/\$|\d{3}/.test(`${s.title} ${s.body}`)));
  }
  {
    const r = await quoteApprove(SRC('quote-view'), { failing: ['profiles'] });
    ok('quote approved, profiles unreadable: the approval stands and nobody is told',
      r.status === 200 && r.body.ok === true && r.sent.length === 0, `${r.status} ${r.sent.length}`);
  }

  // ---- the structure: every device read names the people AND the company ----
  // The people, or it is the old company-wide broadcast; the company, or a
  // phone last registered under a company its owner has left hears this one.
  const DEVICE_READ = /\.from\("device_tokens"\)\s*\.select\([^;]*;/g;
  const deviceReadProblems = (src) => [...src.matchAll(DEVICE_READ)].map((m) => m[0])
    .filter((s) => !/\.in\("user_id"|\.eq\("user_id"/.test(s) || !/\.eq\("company_id"/.test(s))
    .map((s) => 'a device_tokens read not limited to chosen users in this company: ' + s.replace(/\s+/g, ' ').slice(0, 90));
  for (const fn of ['stripe-webhook', 'square-webhook', 'quote-view', 'attention-sweep', 'notify-job-change']) {
    const p = deviceReadProblems(SRC(fn));
    ok(`${fn}: every device_tokens read is by user and by company`, p.length === 0, p.join(' | '));
  }
  {
    const p = deviceReadProblems(readFileSync(join(ROOT, 'supabase/functions/_shared/push-recipients.ts'), 'utf8'));
    ok('push-recipients.ts: its one device read is by user and by company', p.length === 0, p.join(' | '));
  }
  {
    // attention-sweep cannot run here (it needs the candidates RPC and the
    // quiet-hours clock), so its recipient filter is held by shape: the
    // role list is only where it starts, SEE_MONEY decides.
    const c = SRC('attention-sweep');
    ok('attention-sweep: OWNER/MANAGER filtered through moneyAudience, reading the overrides',
      /select\("id, role, permission_overrides"\)[\s\S]{0,200}\.in\("role", \["OWNER", "MANAGER"\]\)[\s\S]{0,120}moneyAudience\(/.test(c));
  }

  // ---- PLANTED: the versions before this change must be caught ----
  {
    const old = gitSrc('stripe-webhook');
    if (old) {
      const r = await stripe(old, EVENTS.paid);
      const p = addressProblems(tokensSent(r), MONEY);
      ok('PLANTED: the previous stripe-webhook is caught telling crew the payment',
        p.some((s) => s.startsWith('tok-crewOther would be told')) && p.some((s) => s.startsWith('tok-foreman would be told')), p.join(' | '));
      ok('PLANTED: ... and caught by the structural check', deviceReadProblems(old).length === 3);
    } else console.log(`  (skipped the stripe-webhook plant: commit ${BEFORE} is not in this clone)`);
  }
  {
    const old = gitSrc('square-webhook');
    if (old) {
      const r = await square(old, EVENTS.squareDeclined);
      const p = addressProblems(tokensSent(r), MONEY);
      ok('PLANTED: the previous square-webhook is caught telling crew the declined amount',
        p.some((s) => s.startsWith('tok-crewOther would be told')), p.join(' | '));
      const d = await square(old, EVENTS.squareDispute);
      const q = addressProblems(tokensSent(d), MONEY);
      ok('PLANTED: the previous square-webhook is caught telling crew the chargeback',
        d.text === 'dispute recorded' && q.some((s) => s.startsWith('tok-crewOther would be told')), `${d.text} | ${q.join(' | ')}`);
      // And the words asserted above are the ones that shipped, not ones
      // copied from the new file.
      ok('... in the same words the chargeback test asserts',
        d.sent[0]?.title === SQUARE_DISPUTE_WORDS.title && d.sent[0]?.body === SQUARE_DISPUTE_WORDS.body, JSON.stringify(d.sent[0]));
    } else console.log(`  (skipped the square-webhook plant: commit ${BEFORE} is not in this clone)`);
  }
  {
    // The chargeback push cut off from its caller -- a rename that missed
    // the call, or the call lost in an edit. The dispute is still recorded
    // and answered 200, so nothing else here would notice.
    const now = SRC('square-webhook');
    const planted = now.replace(/await notifyDispute\([^;]*\);/, '');
    ok('PLANTED: the square no-push plant really changed the file', planted !== now);
    const r = await square(planted, EVENTS.squareDispute);
    const p = addressProblems(tokensSent(r), MONEY);
    ok('PLANTED: a square chargeback that tells nobody is caught',
      r.text === 'dispute recorded' && p.some((s) => s.startsWith('tok-owner would not be told')), `${r.text} | ${p.join(' | ')}`);
  }
  {
    // The square chargeback routed through the JOB audience: the foreman and
    // the crew on the job would hear the amount.
    const now = SRC('square-webhook');
    const planted = now.replace(/(async function notifyDispute[\s\S]*?)await moneyDevices\(admin, companyId\)/,
      `$1await jobDevices(admin, companyId, standingJobEvent({ sync_id: "${JOB}", assigned_employee_sync_id: "${E_LEAD}" }, "ACCEPTED"))`)
      .replace('import { moneyDevices } from "../_shared/push-recipients.ts";',
        'import { moneyDevices, jobDevices } from "../_shared/push-recipients.ts";\nimport { standingJobEvent } from "../_shared/job-push.ts";');
    ok('PLANTED: the square job-audience plant really changed the file', planted !== now && planted.includes('jobDevices(admin'));
    const r = await square(planted, EVENTS.squareDispute);
    const p = addressProblems(tokensSent(r), MONEY);
    ok('PLANTED: a square chargeback sent to the job audience is caught telling the foreman and the lead',
      p.some((s) => s.startsWith('tok-foreman would be told')) && p.some((s) => s.startsWith('tok-crewLead would be told')), p.join(' | '));
  }
  {
    // devicesOf with its company filter taken out. First the file as it is,
    // built the same way, so a pass below is the filter and not the loader.
    const src = readFileSync(join(ROOT, 'supabase/functions/_shared/push-recipients.ts'), 'utf8');
    const asIs = addressProblems(toks(await recipientsFrom(src).moneyDevices(fakeDb(world()), C2)), ['leaver', 'owner2']);
    ok('push-recipients.ts built from source answers as the import does', asIs.length === 0, asIs.join(' | '));
    const planted = src.replace('.eq("company_id", companyId).in("user_id", [...userIds])', '.in("user_id", [...userIds])');
    ok('PLANTED: the devicesOf plant really changed the file', planted !== src);
    const p = addressProblems(toks(await recipientsFrom(planted).moneyDevices(fakeDb(world()), C2)), ['leaver', 'owner2']);
    ok('PLANTED: devicesOf without the company filter is caught telling the leaver\'s old phone the new company\'s money',
      p.some((s) => s.startsWith('tok-leaver-old would be told')), p.join(' | '));
    ok('PLANTED: ... and caught by the structural check', deviceReadProblems(planted).length === 1);
  }
  {
    // attention-sweep's device read by user alone, as it was.
    const now = SRC('attention-sweep');
    const planted = now.replace('.eq("company_id", companyId).eq("user_id", userId)', '.eq("user_id", userId)');
    ok('PLANTED: the attention-sweep plant really changed the file', planted !== now);
    ok('PLANTED: an attention-sweep device read by user alone is caught by the structural check', deviceReadProblems(planted).length === 1);
  }
  {
    // quote-view carries other uncommitted work, so its plant is the current
    // file with the old company-wide read put back.
    const now = SRC('quote-view');
    const planted = now.replace(/const toks = await jobDevices\([\s\S]*?\)\);\n/,
      'const { data: toksRaw } = await admin.from("device_tokens").select("token").eq("company_id", job.company_id);\n        const toks = toksRaw ?? [];\n');
    ok('PLANTED: the quote-view plant really changed the file', planted !== now);
    const r = await quoteApprove(planted);
    const p = addressProblems(tokensSent(r), JOB_PEOPLE);
    ok('PLANTED: a company-wide quote-view push is caught telling crew on other jobs',
      p.some((s) => s.startsWith('tok-crewOther would be told')), p.join(' | '));
    ok('PLANTED: ... and caught by the structural check', deviceReadProblems(planted).length === 1);
  }
  {
    // A money push routed through the JOB audience instead would still tell
    // the foreman and the crew on the job the amount.
    const planted = SRC('stripe-webhook').replace(/await moneyDevices\(admin, job\.company_id\)/,
      'await jobDevices(admin, job.company_id, standingJobEvent(job, "ACCEPTED"))')
      .replace('import { moneyDevices } from "../_shared/push-recipients.ts";',
        'import { moneyDevices, jobDevices } from "../_shared/push-recipients.ts";\nimport { standingJobEvent } from "../_shared/job-push.ts";');
    const r = await stripe(planted, EVENTS.paid);
    const p = addressProblems(tokensSent(r), MONEY);
    ok('PLANTED: a payment push sent to the job audience is caught telling the foreman',
      p.some((s) => s.startsWith('tok-foreman would be told')), p.join(' | '));
  }
} finally {
  console.warn = warn;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
