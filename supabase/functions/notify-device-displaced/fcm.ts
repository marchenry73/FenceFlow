/**
 * Getting a Firebase access token and sending one message to one phone.
 *
 * This is the same OAuth dance notify-job-change does inline. It is duplicated
 * here rather than shared, deliberately and with a cost: _shared/ belongs to
 * other work in flight and adding a file to it now would collide. If a third
 * sender ever needs this, the right move is to lift ONE copy into
 * _shared/fcm.ts and have notify-job-change and this function both import it --
 * not to add a third copy.
 *
 * Nothing in here decides who gets a message. That is index.ts's job, and it
 * addresses exactly one handset.
 */

const b64 = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

/** A short-lived token for the FCM v1 API, signed with the service account. */
export async function accessToken(sa: {
  client_email: string;
  private_key: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  })}`;
  const pem = sa.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${sig}`,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).access_token;
}

/** What FCM answered, so the caller can drop a token the device no longer has. */
export interface SendOutcome {
  ok: boolean;
  /** 404 or 400: this token is gone. Any other failure may be transient. */
  stale: boolean;
  status: number;
}

/**
 * One data message to one token.
 *
 * A DATA message, not a notification message, so the app is what decides
 * whether anything appears on screen -- which is the whole point here: the
 * phone has to go and ask the server before it says anything, and a
 * notification message would have Android draw the words before any code ran.
 */
export async function sendData(
  token: string,
  projectId: string,
  bearer: string,
  data: Record<string, string>,
): Promise<SendOutcome> {
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          token,
          data,
          // The phone may be dozing. This message is the difference between a
          // stale handset stopping now and stopping whenever somebody next
          // picks it up, so it is worth a high-priority wake.
          android: { priority: "HIGH" },
        },
      }),
    },
  );
  return { ok: res.ok, stale: res.status === 404 || res.status === 400, status: res.status };
}
