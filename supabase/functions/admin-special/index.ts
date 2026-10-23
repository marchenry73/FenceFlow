// A SPECIAL ON A COMPANY'S FENCEFLOW SUBSCRIPTION.
//
// "I want to be able to make a special, like $50 for the first month and then
// comes back to the normal payment."
//
// WHY THIS IS A STRIPE DISCOUNT AND NOT A NUMBER IN A BOX. companies.
// monthly_price is a MIRROR, not a control: stripe-webhook overwrites it from
// the subscription on every event. Typing 50 into the Manage dialog would
// charge the customer the full amount, show the wrong figure until the next
// webhook, and then be erased by it. The only thing that takes money off a
// bill is a discount on the subscription, and Stripe is where the bill lives.
//
// WHAT IT DOES. Creates a coupon worth the DIFFERENCE between what they pay
// now and the special price, applies it to their subscription, and lets
// Stripe put them back on the normal price on its own when the months are up.
// Nothing here has to remember to end it, which is the whole reason to do it
// in Stripe rather than with a date column and a job that has to run.
//
//   normal $199, special $50, 1 month  ->  coupon: $149 off, duration "once"
//   normal $199, special $99, 3 months ->  coupon: $100 off, repeating x3
//
// THE AMOUNT IS DERIVED, NEVER TYPED. He says what they should PAY; the
// discount is worked out from what Stripe says they pay today. Asking for
// "amount off" instead would mean doing that subtraction in his head against
// a figure he cannot see, and being $10 out either way is money.
//
// Secrets: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
import { createClient } from "jsr:@supabase/supabase-js@2";

const STRIPE = "https://api.stripe.com/v1";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function stripe(path: string, form: Record<string, string>) {
  const res = await fetch(`${STRIPE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function stripeGet(path: string) {
  const res = await fetch(`${STRIPE}${path}`, {
    headers: { Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}` },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/** What Stripe charges this subscription a month, in cents. */
function monthlyCents(sub: Record<string, unknown>): number {
  const items = (sub?.items as { data?: unknown[] } | undefined)?.data;
  if (!Array.isArray(items) || !items.length) return 0;
  let cents = 0;
  for (const raw of items) {
    const it = raw as Record<string, unknown>;
    const p = it.price as Record<string, unknown> | undefined;
    const unit = Number(p?.unit_amount);
    if (!Number.isFinite(unit)) continue;
    const qty = Number(it.quantity ?? 1) || 1;
    const rec = p?.recurring as Record<string, unknown> | undefined;
    const iv = rec?.interval;
    const count = Number(rec?.interval_count ?? 1) || 1;
    // The same normalisation stripe-webhook does, for the same reason: a
    // yearly plan is not twelve times a monthly one.
    const perMonth = iv === "year" ? 1 / (12 * count)
      : iv === "week" ? 52 / (12 * count)
      : iv === "day" ? 365 / (12 * count)
      : 1 / count;
    cents += unit * qty * perMonth;
  }
  return Math.round(cents);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  if (!url || !serviceKey || !stripeKey) return json({ error: "not configured" }, 503);

  // THE GATE IS is_platform_admin(), asked AS THE CALLER -- the same one
  // funnel every admin action on this console goes through, including the
  // second factor. Not a check of our own invention sitting beside it.
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return json({ error: "unauthorized" }, 401);
  const asCaller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? serviceKey, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: isAdmin, error: adminErr } = await asCaller.rpc("is_platform_admin");
  if (adminErr || isAdmin !== true) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad request" }, 400);
  }
  const companyId = String(body.company_id ?? "");
  const months = Math.max(1, Math.min(24, Math.round(Number(body.months ?? 1)) || 1));
  const specialPrice = Number(body.special_price);
  const remove = body.remove === true;
  if (!/^[0-9a-f-]{36}$/i.test(companyId)) return json({ error: "bad request" }, 400);

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: company, error: compErr } = await admin
    .from("companies")
    .select("name, stripe_subscription_id")
    .eq("id", companyId)
    .maybeSingle();
  if (compErr) return json({ error: "could not read the company" }, 500);
  if (!company) return json({ error: "no such company" }, 404);

  const subId = String(company.stripe_subscription_id ?? "");
  // NOT AN ERROR THEY CAN FIX BY RETRYING. A company with no Stripe
  // subscription is not being billed by Stripe at all, so there is no bill to
  // take anything off -- and inventing a discount row here would show a
  // special on the console that charges nobody anything, which is the exact
  // failure this whole function exists to avoid.
  if (!subId) {
    return json({
      error: "no_subscription",
      message: `${company.name || "That company"} has no Stripe subscription, so there is no bill to discount. ` +
        "They are either on a hand-granted account or have not subscribed yet.",
    }, 409);
  }

  if (remove) {
    // Stripe's own way to end a discount early. The subscription keeps its
    // price; only the discount goes.
    const r = await stripe(`/subscriptions/${encodeURIComponent(subId)}`, { "discounts": "" });
    if (!r.ok) {
      return json({ error: "stripe_refused", message: String((r.body as any)?.error?.message ?? r.status) }, 502);
    }
    return json({ state: "removed" });
  }

  if (!Number.isFinite(specialPrice) || specialPrice < 0) return json({ error: "bad request" }, 400);

  const sub = await stripeGet(`/subscriptions/${encodeURIComponent(subId)}`);
  if (!sub.ok) {
    return json({ error: "stripe_refused", message: String((sub.body as any)?.error?.message ?? sub.status) }, 502);
  }
  const nowCents = monthlyCents(sub.body as Record<string, unknown>);
  const offCents = Math.round(nowCents - specialPrice * 100);
  if (nowCents <= 0) {
    return json({
      error: "no_price",
      message: "Stripe has no monthly amount on that subscription, so there is nothing to discount.",
    }, 409);
  }
  if (offCents <= 0) {
    return json({
      error: "not_a_discount",
      // Said with both figures, because "that is not a special" is useless
      // without the number it was measured against.
      message: `They pay $${(nowCents / 100).toFixed(2)} a month now, so $${specialPrice.toFixed(2)} is not a reduction.`,
    }, 409);
  }

  const coupon = await stripe("/coupons", {
    amount_off: String(offCents),
    currency: "usd",
    // "once" rather than "repeating x1": Stripe treats them the same for one
    // month and "once" is what the dashboard will show somebody reading it
    // later.
    duration: months === 1 ? "once" : "repeating",
    ...(months === 1 ? {} : { duration_in_months: String(months) }),
    name: `FenceFlow special: $${specialPrice.toFixed(2)} for ${months} month${months === 1 ? "" : "s"}`,
    "metadata[company_id]": companyId,
  });
  if (!coupon.ok) {
    return json({ error: "stripe_refused", message: String((coupon.body as any)?.error?.message ?? coupon.status) }, 502);
  }

  const applied = await stripe(`/subscriptions/${encodeURIComponent(subId)}`, {
    "discounts[0][coupon]": String((coupon.body as any)?.id ?? ""),
  });
  if (!applied.ok) {
    return json({ error: "stripe_refused", message: String((applied.body as any)?.error?.message ?? applied.status) }, 502);
  }

  // A note on the company, so the console says why their price looks odd
  // without anybody having to open Stripe. NOT the price itself: Stripe owns
  // that, and the webhook will report the discounted figure on its own.
  const stamp = new Date().toISOString().slice(0, 10);
  await admin.from("companies").update({
    admin_notes: `${stamp}: special $${specialPrice.toFixed(2)}/mo for ${months} month${months === 1 ? "" : "s"}, ` +
      `then back to $${(nowCents / 100).toFixed(2)}.`,
  }).eq("id", companyId);

  return json({
    state: "applied",
    was: nowCents / 100,
    now: specialPrice,
    months,
    reverts_to: nowCents / 100,
  });
});
