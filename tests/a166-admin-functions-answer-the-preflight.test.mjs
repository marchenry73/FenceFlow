/**
 * THE ADMIN CONSOLE COULD NOT CALL ITS OWN EDGE FUNCTIONS.
 *
 * REPORTED 7 Nov 2026 from the admin console's "Email clients" page, two
 * companies ticked, as the single red line "Failed to send a request to the
 * Edge Function". That sentence is supabase-js's FunctionsFetchError: the
 * FETCH failed, so the function never ran and there is nothing in its logs to
 * find. It names no header, no origin and no method.
 *
 * MEASURED against the live project:
 *
 *     admin-mail-send    OPTIONS=405      <- refused
 *     admin-special      OPTIONS=405      <- refused
 *     quote-view         OPTIONS=200
 *     invite-company     OPTIONS=200
 *     mail-send          OPTIONS=200
 *
 * db.functions.invoke() sends Authorization, apikey, x-client-info and
 * Content-Type: application/json, none of which is a CORS-simple header, so
 * the browser MUST preflight. Both admin functions began
 *
 *     if (req.method !== "POST") return json({...}, 405);
 *
 * and their json() helper carried no Access-Control headers at all. The
 * preflight was refused and the browser blocked the real request.
 *
 * IT HAD NEVER WORKED. Nothing regressed: these two were written without CORS,
 * so every call from admin.html had always been blocked. It only surfaced now
 * because that page's roster began rendering in full today -- until the <tr>
 * shadow was fixed (a161) the list aborted at the first company with no
 * address, so nobody ever reached the Send button.
 *
 * WHY THE HEADER LIST IS CHECKED AND NOT JUST THE STATUS. quote-view answers
 * the preflight with "content-type" alone, which is right for a function
 * nobody signs in to and WRONG here: a preflight carrying Authorization is
 * refused for one missing header name as surely as for all of them. Copying
 * the public function's shorter list would have left the page exactly as
 * broken while making every status check pass.
 *
 * Source checks plus a live preflight. The live half needs no CLI and no
 * credentials -- a preflight is unauthenticated by definition.
 *
 *     node --test tests/a166-admin-functions-answer-the-preflight.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'newcrgafcptspmapacrx';

/** Functions the admin console reaches with db.functions.invoke(). */
const ADMIN_FNS = ['admin-mail-send', 'admin-special'];

/** Every header db.functions.invoke() puts on the wire. */
const REQUIRED_HEADERS = ['authorization', 'apikey', 'content-type', 'x-client-info'];

const srcOf = (name) =>
  readFileSync(path.join(ROOT, 'supabase/functions', name, 'index.ts'), 'utf8');

/**
 * The file with comment lines removed. Every must-contain check below runs
 * against this: a check that reads comments passes on its own prose, which
 * has produced a false green in this project before.
 */
const codeOf = (name) =>
  srcOf(name).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

// ---------------------------------------------------------------------------
// SOURCE
// ---------------------------------------------------------------------------

for (const fn of ADMIN_FNS) {
  test(`${fn}: answers the CORS preflight instead of 405ing it`, () => {
    const code = codeOf(fn);
    assert.match(code, /req\.method === "OPTIONS"/,
      `${fn} does not handle OPTIONS, so the browser's preflight collects the ` +
      'method check\'s 405 and the real request is never sent');
  });

  test(`${fn}: handles OPTIONS BEFORE the method check`, () => {
    // Order is the whole bug. An OPTIONS branch placed after
    // `if (req.method !== "POST") return ... 405` is unreachable.
    const code = codeOf(fn);
    const opts = code.indexOf('req.method === "OPTIONS"');
    const post = code.indexOf('req.method !== "POST"');
    assert.ok(opts >= 0 && post >= 0, `${fn} lost one of the two method checks`);
    assert.ok(opts < post,
      `${fn} checks for POST before OPTIONS, so the preflight still gets a 405`);
  });

  test(`${fn}: allows every header db.functions.invoke() actually sends`, () => {
    // The trap: quote-view's "content-type" alone looks like CORS, passes any
    // status check, and still refuses an authenticated preflight.
    const code = codeOf(fn);
    const m = code.match(/"Access-Control-Allow-Headers":\s*"([^"]+)"/);
    assert.ok(m, `${fn} declares no Access-Control-Allow-Headers`);
    const allowed = m[1].toLowerCase();
    for (const h of REQUIRED_HEADERS) {
      assert.ok(allowed.includes(h),
        `${fn} does not allow "${h}", which db.functions.invoke() sends on ` +
        `every call -- the preflight is refused. Allowed: ${m[1]}`);
    }
  });

  test(`${fn}: CORS rides every reply, not only the preflight`, () => {
    // A 200 with no Access-Control-Allow-Origin is blocked exactly as the 405
    // was. Both files answer through a single json() helper, so the headers
    // belong there.
    const code = codeOf(fn);
    assert.match(code, /headers:\s*\{\s*\.\.\.cors/,
      `${fn}'s json() helper does not spread cors, so a SUCCESSFUL response is ` +
      'still blocked by the browser and the page still says it could not send');
    assert.ok(code.indexOf('const cors') < code.indexOf('const json'),
      `${fn} declares cors after json() uses it`);
  });

  test(`${fn}: every reply goes through that one helper`, () => {
    // If a branch builds its own Response, the helper's headers do not reach
    // it and that one path is blocked while every test above passes.
    const code = codeOf(fn);
    const responses = (code.match(/new Response\(/g) || []).length;
    assert.ok(responses <= 2,
      `${fn} builds ${responses} Responses by hand; each one outside json() ` +
      'needs the cors headers too');
  });
}

test('POSITIVE CONTROL: the header check rejects the public function\'s shorter list', () => {
  // quote-view is correct for what it is and must NOT be used as the template
  // here. If this ever passes, the check above has stopped distinguishing the
  // two and would accept the exact mistake that keeps the page broken.
  const m = codeOf('quote-view').match(/"Access-Control-Allow-Headers":\s*"([^"]+)"/);
  assert.ok(m, 'quote-view declares no Allow-Headers; this control cannot run');
  assert.ok(!m[1].toLowerCase().includes('authorization'),
    'quote-view now allows authorization -- this control no longer proves the ' +
    'admin check is stricter than a public function\'s');
});

// ---------------------------------------------------------------------------
// LIVE -- what the browser actually gets
// ---------------------------------------------------------------------------

async function preflight(fn) {
  const res = await fetch(`https://${PROJECT}.supabase.co/functions/v1/${fn}`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://fenceflowapp.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type,apikey,x-client-info',
    },
  });
  return { status: res.status, allow: res.headers.get('access-control-allow-headers') || '',
           origin: res.headers.get('access-control-allow-origin') || '' };
}

for (const fn of ADMIN_FNS) {
  test(`LIVE: ${fn} accepts a real browser preflight`, async () => {
    const r = await preflight(fn);
    assert.ok(r.status >= 200 && r.status < 300,
      `the deployed ${fn} answers the preflight with ${r.status}; the admin ` +
      'console shows "Failed to send a request to the Edge Function". ' +
      'Deploy it: npx supabase functions deploy ' + fn);
    assert.ok(r.origin,
      `the deployed ${fn} sent no Access-Control-Allow-Origin`);
    for (const h of ['authorization', 'apikey']) {
      assert.ok(r.allow.toLowerCase().includes(h),
        `the deployed ${fn} does not allow "${h}" (got "${r.allow}")`);
    }
  });
}

test('LIVE CONTROL: a function known to answer preflights still does', async () => {
  // If the network, the project or the gateway is down, the two tests above
  // fail for a reason that has nothing to do with this fix. This says which.
  const r = await preflight('quote-view');
  assert.ok(r.status >= 200 && r.status < 300,
    `quote-view's preflight returned ${r.status} -- the project or the network ` +
    'is the problem here, not the admin functions');
});
