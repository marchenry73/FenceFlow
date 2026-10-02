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
  if (!co) return json({ error: "That company is not taking requests right now." }, 404);
  // company_allowed, not the raw suspended flag. Nothing sets that flag when
  // a trial simply runs out -- the app and the office lock on the date, via
  // this function -- so a lapsed company's public form went on collecting
  // homeowners' requests into an account nobody could open.
  const { data: allowed } = await admin.rpc("company_allowed", { cid: co.id });
  if (allowed === false) return json({ error: "That company is not taking requests right now." }, 404);

  const body = await req.json().catch(() => ({}));
  const f = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
  const name = f(body.name, 120);
  const phone = f(body.phone, 40);
  const rawEmail = f(body.email, 120);
  const address = f(body.address, 200);
  const notes = f(body.notes, 1000);

  // ONE address, or none. This function runs with verify_jwt = false, so
  // everything above was typed by a stranger with no session, and it writes
  // straight to jobs.email through the service-role client. The only check here
  // used to be `email.includes("@")`, which accepts
  // "her@example.com, attacker@example.com" -- and the contractor's phone then
  // puts that whole string into Android's EXTRA_EMAIL, which takes a LIST. The
  // quote email it carries holds the quote link, and that link is a bearer
  // token: whoever opens it can approve and sign on her behalf.
  //
  // Refusing at this door is the point. IntentHelpers.openEmailDraft refuses a
  // list too (and tests/a76 holds it to that), but that is the far end; this is
  // where the value gets in, and a bad row here also reaches send-follow-ups,
  // which emails automatically with figures in it and no further tap from
  // anyone. Gate the funnel, not each consumer.
  //
  // Not a full RFC 5322 validator on purpose: that accepts a quoted local part
  // containing a comma, which is exactly the shape being refused, and no fence
  // customer has one. A refused address costs the homeowner a retype. An
  // accepted list costs the quote.
  const emailLooksSingle = (() => {
    if (rawEmail === "") return false;
    for (const ch of rawEmail) {
      if (ch === "," || ch === ";" || /\s/.test(ch) || ch.charCodeAt(0) < 0x20) return false;
    }
    const at = rawEmail.indexOf("@");
    if (at <= 0 || at !== rawEmail.lastIndexOf("@") || at === rawEmail.length - 1) return false;
    const domain = rawEmail.slice(at + 1);
    const dot = domain.indexOf(".");
    return dot > 0 && dot < domain.length - 1 && !domain.includes("..");
  })();
  // An address that was given but is not usable is dropped rather than stored:
  // a half-valid string in jobs.email is worse than an empty column, because
  // send-follow-ups selects on `email <> ''` and would mail it.
  const email = emailLooksSingle ? rawEmail : "";

  if (name.length < 2) return json({ error: "Your name, so they know who to call." }, 400);
  if (rawEmail !== "" && !emailLooksSingle) {
    return json({ error: "That email address does not look right — please check it, or leave it blank and give a phone number." }, 400);
  }
  if (phone.length < 7 && email === "") {
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
