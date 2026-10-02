/**
 * Telling the office something went wrong, as a push notification.
 *
 * Used for ONE thing: "the customer approved, but their contract email did not
 * go out". That is the failure the owner cannot be allowed to miss -- a silent
 * one means he believes she has the contract and she does not -- so it is
 * pushed the moment it happens, to the people who can act on it.
 *
 * WHO: moneyDevices() from _shared/push-recipients.ts -- everyone who holds
 * SEE_MONEY (owner, manager, sales, accountant, plus per-person overrides),
 * and only their phones, in this company. Never crew, never "every device in
 * the company". The email carries the price; the people told it did not go out
 * are the people allowed to see the price. The push itself carries no amount.
 * Reads that fail make the audience smaller, never larger.
 *
 * HOW: the same Firebase v1 path quote-view and notify-job-change use. The
 * OAuth dance is repeated here (the fourth copy; notify-device-displaced/fcm.ts
 * says the right move is one shared copy, and when that exists this file
 * should import it). It is repeated rather than imported from a sibling
 * function's folder because a function's bundle is what its own imports reach,
 * and a deploy that quietly left a sibling's file out would turn this alarm
 * into a no-op without anything saying so.
 *
 * Never throws: the answer to the approval, and the ledger row that records
 * what happened, do not depend on a notification getting through. Returns how
 * many phones were sent to, so the caller can log "told 0 phones" -- which is
 * a different thing from "told nobody because there was nothing to tell".
 */
import { moneyDevices } from "../_shared/push-recipients.ts";

export interface PushDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  env: (name: string) => string | undefined;
}

const b64url = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function accessToken(
  deps: PushDeps,
  sa: { client_email: string; private_key: string },
): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const pem = sa.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)),
  );
  let bin = "";
  for (const byte of signature) bin += String.fromCharCode(byte);
  const jwt = `${unsigned}.${btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
  const res = await deps.fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) return null;
  const token = (await res.json().catch(() => ({})))?.access_token;
  return typeof token === "string" && token ? token : null;
}

// deno-lint-ignore no-explicit-any
export async function pushToOffice(db: any, deps: PushDeps, companyId: string, title: string, body: string): Promise<number> {
  try {
    const raw = deps.env("FIREBASE_SERVICE_ACCOUNT");
    const sa = raw ? JSON.parse(raw) : null;
    if (!sa?.client_email || !sa?.private_key || !sa?.project_id) {
      console.error("quote-approval-email: no Firebase service account, so the office was NOT pushed about an unsent contract email");
      return 0;
    }
    const devices = await moneyDevices(db, companyId);
    if (!devices.length) return 0;
    const bearer = await accessToken(deps, sa);
    if (!bearer) {
      console.error("quote-approval-email: could not get a Firebase token; the office was NOT pushed");
      return 0;
    }
    let told = 0;
    await Promise.all(devices.map(async (d) => {
      try {
        const res = await deps.fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
          body: JSON.stringify({ message: { token: d.token, notification: { title, body } } }),
        });
        if (res.ok) told++;
      } catch {
        // One phone not answering must not stop the others.
      }
    }));
    return told;
  } catch {
    console.error("quote-approval-email: the push to the office failed");
    return 0;
  }
}
