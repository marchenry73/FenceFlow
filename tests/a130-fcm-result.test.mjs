// What an FCM send means, and the two ways the old rule got it wrong.
//
// Three call sites carried this line:
//
//     if (status === 404 || status === 400) stale.push(token); else sent++;
//
// It counted a 401/403/500 as a DELIVERY -- so a function could answer
// {sent: 12} having delivered nothing, and the only symptom was a silence
// indistinguishable from "nothing to send". And it DELETED the token on any
// 400, although FCM returns 400 INVALID_ARGUMENT for a malformed message just
// as readily as for a bad token -- so one bad payload unsubscribed every
// phone it was addressed to, and the cause was nowhere near the damage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFcmSend } from "../supabase/functions/_shared/fcm-result.ts";

test("a 2xx is the only thing that counts as delivered", () => {
  for (const s of [200, 201, 204]) {
    const o = classifyFcmSend(s, "");
    assert.equal(o.delivered, true, `${s} is a delivery`);
    assert.equal(o.removeToken, false, `${s} must not remove the token`);
  }
});

test("404 is the one unambiguous dead token", () => {
  const o = classifyFcmSend(404, '{"error":{"status":"NOT_FOUND"}}');
  assert.equal(o.removeToken, true);
  assert.equal(o.delivered, false);
});

test("a 400 about the MESSAGE does not delete the phone", () => {
  // The defect, stated as a case: FCM rejecting the payload used to cost the
  // device its row.
  const o = classifyFcmSend(400, '{"error":{"status":"INVALID_ARGUMENT","message":"Invalid value at \'message.android.priority\'"}}');
  assert.equal(o.removeToken, false, "a malformed message must never unsubscribe a working phone");
  assert.equal(o.delivered, false, "and it is certainly not a delivery");
  assert.match(o.reason, /refused the message/i);
});

test("a 400 that NAMES the token does delete it", () => {
  for (const body of [
    '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}',
    '{"error":{"message":"The registration token is not a valid FCM registration token"}}',
    '{"error":{"message":"InvalidRegistration"}}',
  ]) {
    const o = classifyFcmSend(400, body);
    assert.equal(o.removeToken, true, `FCM named the token: ${body}`);
  }
});

test("401, 403, 429 and 500 are failures, not deliveries and not dead tokens", () => {
  // Every one of these used to land in the `else` and increment `sent`.
  for (const s of [401, 403, 429, 500, 503]) {
    const o = classifyFcmSend(s, "upstream said no");
    assert.equal(o.delivered, false, `${s} must not be counted as sent`);
    assert.equal(o.removeToken, false, `${s} is not the phone's fault`);
    assert.ok(o.reason.length > 0, `${s} must explain itself for the log`);
  }
});

test("the old rule and the new one genuinely disagree", () => {
  // A guard against someone 'simplifying' this back. If these ever agree on
  // every case, the fix has been undone.
  const oldRule = (status) => ({ delivered: !(status === 404 || status === 400), removeToken: status === 404 || status === 400 });
  const disagreements = [401, 403, 500].filter((s) => oldRule(s).delivered !== classifyFcmSend(s, "").delivered);
  assert.equal(disagreements.length, 3,
    "the old rule called 401/403/500 deliveries; this one must not");
  const bare400 = classifyFcmSend(400, '{"error":{"status":"INVALID_ARGUMENT"}}');
  assert.notEqual(bare400.removeToken, oldRule(400).removeToken,
    "the old rule deleted the token on a bare 400; this one must not");
});
