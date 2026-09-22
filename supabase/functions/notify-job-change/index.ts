// FenceFlow push notifications. Triggered by a Database Webhook on `jobs`.
//
// A job push goes only to people who can open that job (the rule and its
// reasons live in ../_shared/job-push.ts, which is pure and tested by
// tests/notify-job-change.test.mjs; the reads that feed it are
// ../_shared/push-recipients.ts, which quote-view shares so a quote approval
// reaches the same people). Until 2026-09-22 every job push went to
// every device in the company, crew included, so a crew phone was told the
// customer name of jobs it is not allowed to see.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { jobPushEvent, jobPushMessage } from "../_shared/job-push.ts";
import { jobAudience } from "../_shared/push-recipients.ts";

const b64 = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

async function accessToken(sa: any): Promise<string> {
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

/**
 * Constant-time string compare.
 *
 * `a === b` on a secret leaks its length and, in principle, how many leading
 * characters matched, because it stops at the first difference. This always
 * walks the whole string.
 */
function secretMatches(supplied: string | null, expected: string): boolean {
  if (!supplied || supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

Deno.serve(async (req) => {
  try {
    // This function is deployed with JWT verification off, so this header is
    // the only thing standing between the open internet and a push to every
    // device in a company. It is checked before the body is even read.
    //
    // It exists because the alternative was worse: the database trigger used
    // to authenticate with the service_role key, which meant a key that can
    // read and write every table for every company was sitting in plain text
    // in a trigger definition, just to say "a job changed". This secret can do
    // exactly one thing -- ask for a notification to be sent -- so leaking it
    // costs a spam notification rather than the whole database.
    const expected = Deno.env.get("NOTIFY_TRIGGER_SECRET");
    if (!expected) {
      // Fail closed. A missing secret must never mean "let everyone in".
      console.error("NOTIFY_TRIGGER_SECRET is not set; refusing to run.");
      return new Response("not configured", { status: 503 });
    }
    if (!secretMatches(req.headers.get("x-fenceflow-trigger"), expected)) {
      return new Response("unauthorized", { status: 401 });
    }

    const sa = JSON.parse(Deno.env.get("FIREBASE_SERVICE_ACCOUNT")!);
    const p = await req.json();
    const rec = p.record ?? {};
    const old = p.old_record ?? {};
    if (!rec.company_id) return new Response("ok");

    // Somebody joined the company. A different shape of record entirely --
    // this arrives from profiles, not jobs -- and it goes only to the owner,
    // because it is the owner's decision to make and because fanning it out
    // would notify the person who just joined that they had just joined.
    //
    // Everything else is a job, and goes only to the people who can open it:
    // everyone who sees every job, plus the crew whose own record is on it.
    // Each person gets their own words -- the one this change made the lead
    // is told "You were assigned", not "Someone was assigned".
    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const notes = new Map<string, { title: string; body: string }>(); // user id -> words
    if (p.table === "profiles") {
      const joined = rec.company_id && !old.company_id;
      if (!joined) return new Response("no notification needed");
      const name = rec.full_name?.trim() || "Somebody";
      const asked = rec.requested_role
        ? `${rec.requested_role.charAt(0)}${rec.requested_role.slice(1).toLowerCase()}`
        : null;
      const title = "Someone joined your crew";
      const body = asked
        ? `${name} joined and asked to be ${asked}. Say yes or no in the office.`
        : `${name} joined your company on FenceFlow.`;
      const { data: owners, error } = await db
        .from("profiles").select("id")
        .eq("company_id", rec.company_id).eq("role", "OWNER");
      if (error) throw new Error(`profiles: ${error.message}`);
      for (const o of owners ?? []) notes.set(o.id, { title, body });
      if (!notes.size) return new Response("no owner to tell");
    } else {
      const event = jobPushEvent(p);
      if (!event) return new Response("no notification needed");
      const audience = await jobAudience(db, rec.company_id, event);
      for (const [userId, who] of audience) notes.set(userId, jobPushMessage(event, who.newLead));
      if (!notes.size) return new Response("nobody can see this job");
    }

    // Only those people's phones. A device row whose user is not in `notes`
    // -- crew off this job, or anyone the reads above could not place -- is
    // never addressed.
    const { data: rows, error: devicesError } = await db
      .from("device_tokens").select("token, user_id")
      .eq("company_id", rec.company_id).in("user_id", [...notes.keys()]);
    if (devicesError) throw new Error(`device_tokens: ${devicesError.message}`);
    if (!rows?.length) return new Response("no devices");

    const tok = await accessToken(sa);
    const stale: string[] = [];
    let sent = 0;
    for (const r of rows) {
      const note = notes.get(r.user_id);
      if (!note) continue; // the .in() above already guarantees this; never guess
      const send = await fetch(
        `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              token: r.token,
              data: { title: note.title, body: note.body, jobId: String(rec.id ?? "") },
              android: { priority: "HIGH" },
            },
          }),
        },
      );
      if (send.status === 404 || send.status === 400) stale.push(r.token);
      else sent++;
    }
    if (stale.length) await db.from("device_tokens").delete().in("token", stale);

    return new Response(JSON.stringify({ sent }));
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
