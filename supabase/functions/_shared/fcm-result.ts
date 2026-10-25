/**
 * What an FCM send actually means, in one place.
 *
 * Three call sites each carried the same line:
 *
 *     if (send.status === 404 || send.status === 400) stale.push(token);
 *     else sent++;
 *
 * and it is wrong in both directions at once.
 *
 * IT COUNTED FAILURES AS DELIVERIES. A 401, a 403 or a 500 fell into the
 * `else`, so the function incremented `sent` and answered `{sent: N}` having
 * delivered nothing. That is the shape this project keeps being bitten by:
 * code reporting success while doing nothing, where the only visible symptom
 * is a silence nobody can tell from "there was nothing to send".
 *
 * IT DELETED LIVE TOKENS. FCM returns 400 INVALID_ARGUMENT for a malformed
 * MESSAGE as readily as for a bad token -- a field the payload should not
 * carry, a value too long. So one bad push deleted the device_tokens row of
 * every phone it was addressed to, and those phones went silent until they
 * happened to re-register. The cause and the blast radius are nowhere near
 * each other: a payload bug silently unsubscribes the whole company.
 *
 * Only 404 UNREGISTERED is unambiguous: that token is dead. A 400 is only
 * about the token when FCM says so, which it does in the error body, so the
 * body is what decides rather than the status alone.
 */

/** What to do about one phone after one send. */
export interface FcmOutcome {
  /** It reached FCM and was accepted. Count this one as sent, and nothing else. */
  delivered: boolean;
  /** This token is dead and the row should go. NEVER true merely because the request failed. */
  removeToken: boolean;
  /** For the log, when it is neither -- so a failure is readable afterwards. */
  reason: string;
}

/**
 * FCM's own words for a token that no longer exists. Matched on the body
 * because the status alone cannot tell "your message was malformed" from
 * "that phone is gone", and the difference is whether a working phone gets
 * unsubscribed.
 */
const DEAD_TOKEN = /UNREGISTERED|NOT_FOUND|registration token is not|invalid registration|InvalidRegistration/i;

export function classifyFcmSend(status: number, body: string): FcmOutcome {
  if (status >= 200 && status < 300) {
    return { delivered: true, removeToken: false, reason: "" };
  }
  // The only unambiguous one. FCM documents 404 as "the token no longer
  // exists", and nothing else produces it on this endpoint.
  if (status === 404) {
    return { delivered: false, removeToken: true, reason: "token unregistered (404)" };
  }
  if (status === 400) {
    // A 400 is about the MESSAGE unless FCM names the token. Deleting on a
    // bare 400 is what let one malformed payload unsubscribe a whole company.
    if (DEAD_TOKEN.test(body)) {
      return { delivered: false, removeToken: true, reason: "token rejected (400)" };
    }
    return {
      delivered: false,
      removeToken: false,
      reason: "FCM refused the message, not the token (400): " + body.slice(0, 200),
    };
  }
  // 401/403 are our credentials, 429 and 5xx are transient. None of them is
  // the phone's fault and none of them is a delivery.
  return { delivered: false, removeToken: false, reason: "FCM " + status + ": " + body.slice(0, 200) };
}
