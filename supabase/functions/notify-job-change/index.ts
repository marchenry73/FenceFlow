// FenceFlow push notifications. Triggered by a Database Webhook on `jobs`.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

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

Deno.serve(async (req) => {
  try {
    const sa = JSON.parse(Deno.env.get("FIREBASE_SERVICE_ACCOUNT")!);
    const p = await req.json();
    const rec = p.record ?? {};
    const old = p.old_record ?? {};
    if (!rec.company_id) return new Response("ok");

    const who = rec.customer_name || "a job";
    let title = "", body = "";
    if (p.type === "INSERT") {
      title = "New job added";
      body = `${who} was added to the schedule.`;
    } else if (rec.status === "ACCEPTED" && old.status !== "ACCEPTED") {
      title = "Job marked complete";
      body = `${who} was finished by the crew.`;
    } else if (
      rec.assigned_employee_id &&
      rec.assigned_employee_id !== old.assigned_employee_id
    ) {
      title = "Crew assignment changed";
      body = `Someone was assigned to ${who}.`;
    } else {
      return new Response("no notification needed");
    }

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: rows } = await db
      .from("device_tokens").select("token").eq("company_id", rec.company_id);
    if (!rows?.length) return new Response("no devices");

    const tok = await accessToken(sa);
    const stale: string[] = [];
    for (const r of rows) {
      const send = await fetch(
        `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              token: r.token,
              data: { title, body, jobId: String(rec.id ?? "") },
              android: { priority: "HIGH" },
            },
          }),
        },
      );
      if (send.status === 404 || send.status === 400) stale.push(r.token);
    }
    if (stale.length) await db.from("device_tokens").delete().in("token", stale);

    return new Response(JSON.stringify({ sent: rows.length - stale.length }));
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
