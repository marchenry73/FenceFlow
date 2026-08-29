/**
 * A homeowner asking for a fence, straight into the pipeline.
 *
 * The public get-a-quote page posts here with the company's leads token.
 * Every competitor sells this as "online booking"; the fence version is
 * simpler and better -- name, phone, address, what they want -- because
 * nobody schedules a fence install from a calendar widget, they schedule a
 * site visit after a human calls back.
 *
 *   POST ?c=<leads_token>   {name, phone, email, address, notes}
 *
 * The token names exactly one company and authorises exactly one thing:
 * creating a DRAFT lead there. Field lengths are capped and the per-company
 * flood check keeps a script from filling a pipeline with junk overnight.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only." }, 405);

  const url = new URL(req.url);
  const token = (url.searchParams.get("c") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/.test(token)) return json({ error: "That link is not valid." }, 400);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: co } = await admin
    .from("companies").select("id, name, suspended")
    .eq("leads_token", token).maybeSingle();
  if (!co || co.suspended) return json({ error: "That company is not taking requests right now." }, 404);

  const body = await req.json().catch(() => ({}));
  const f = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
  const name = f(body.name, 120);
  const phone = f(body.phone, 40);
  const email = f(body.email, 120);
  const address = f(body.address, 200);
  const notes = f(body.notes, 1000);
  if (name.length < 2) return json({ error: "Your name, so they know who to call." }, 400);
  if (phone.length < 7 && !email.includes("@")) {
    return json({ error: "A phone number or an email — they need a way to reach you." }, 400);
  }

  // Flood check: a real neighbourhood produces a handful of requests a day,
  // not a hundred an hour.
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await admin.from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("company_id", co.id)
    .eq("referral_source", "Website")
    .gte("created_at", hourAgo);
  if ((count ?? 0) >= 20) return json({ error: "Try again in a little while." }, 429);

  const { error } = await admin.from("jobs").insert({
    company_id: co.id,
    customer_name: name,
    phone, email, address,
    notes: notes ? "From the website: " + notes : "",
    referral_source: "Website",
  });
  if (error) return json({ error: "Could not save the request just now." }, 500);

  return json({ ok: true, company: co.name });
});
