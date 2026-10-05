// Starts a FenceFlow subscription. Website only, on purpose.
//
// This one IS a digital service, so selling it inside the Android app would
// pull in Google Play billing and its 15-30% cut. Keeping checkout on the
// website avoids that entirely.
//
// Secrets: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//          SUPABASE_ANON_KEY, SITE_URL
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const STRIPE = "https://api.stripe.com/v1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

/** A Stripe failure that still knows WHICH failure it was.
 *
 *  This used to be `throw new Error(body?.error?.message)`, which threw away
 *  the HTTP status and the error code -- so "that subscription does not exist"
 *  and "Stripe is down" arrived identical. Nothing can branch safely on that,
 *  and the branch that matters here decides whether to create a second
 *  subscription next to one the customer is already paying for. */
class StripeError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "StripeError";
  }
  /** Stripe's own word for "I looked, and there is no such object." */
  get missing(): boolean {
    return this.code === "resource_missing" || this.status === 404;
  }
}

async function stripe(method: string, path: string, form?: Record<string, string>) {
  const res = await fetch(`${STRIPE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  // Read as text first. A 502 from a gateway is an HTML page, and res.json()
  // on it throws a SyntaxError that reads like a bug in this function rather
  // than an outage -- which then lands in the outer catch as a 400, telling
  // the owner their request was bad when Stripe was simply unreachable.
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  // deno-lint-ignore no-explicit-any
  const err = (body as any)?.error;
  if (!res.ok) {
    throw new StripeError(
      err?.message ?? `Stripe returned ${res.status}`, res.status, err?.code);
  }
  if (body === null) {
    throw new StripeError(`Stripe returned a body that is not JSON`, res.status);
  }
  return body;
}

// A subscription Stripe has finished with. Everything NOT in this set is still
// capable of billing the customer, or of becoming capable (an `incomplete` can
// still have its first payment succeed), so a second one beside it is a second
// monthly charge.
const FINISHED = new Set(["canceled", "incomplete_expired"]);
// The only two that may have their price swapped in place.
const SWAPPABLE = new Set(["active", "trialing"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "No login sent with the request" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Validate the token explicitly rather than relying on a header handed to
    // a client -- see the note in create-payment-link.
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    const { data: userData, error: authError } = await admin.auth.getUser(jwt);
    const user = userData?.user;
    if (!user) {
      return json({ error: `Login not accepted: ${authError?.message ?? "unknown"}` }, 401);
    }

    const { data: profile } = await admin
      .from("profiles").select("company_id, role").eq("id", user.id).single();
    if (!profile?.company_id) return json({ error: "No company" }, 403);
    if (profile.role !== "OWNER") {
      return json({ error: "Only the owner can change the subscription" }, 403);
    }

    // "from" says which page started this, so Stripe returns them to it.
    //
    // Both URLs used to point at the dashboard whatever page the checkout
    // began on. Onboarding therefore never reached its own last screen -- the
    // one that tells a new contractor to install the app and sign in with the
    // same email -- and cancelling dropped them into a blocked dashboard
    // rather than back on the plan step they were reading.
    const { priceId, from } = await req.json();
    const back = from === "welcome" ? "welcome.html" : "dashboard.html";
    if (!priceId) return json({ error: "Missing priceId" }, 400);

    // The plan name comes from the PRICE, never from the browser.
    //
    // It used to be posted alongside the price id, and the webhook wrote it
    // straight onto the company -- so anyone could send the $99 price id with
    // plan "Pro" and buy the top tier at the bottom price. Every limit in the
    // app and the website reads that label. Stripe is now the only thing that
    // says what a price is worth.
    const price = await stripe("GET", `/prices/${priceId}?expand[]=product`);
    const plan: string = price?.metadata?.plan ??
      String(price?.product?.name ?? "").replace(/^FenceFlow\s+/i, "").trim();
    if (!plan) {
      return json({ error: "That price is not set up as a FenceFlow plan." }, 400);
    }
    if (price?.recurring?.interval !== "month") {
      return json({ error: "That price is not a monthly subscription." }, 400);
    }

    // A smaller plan must not silently strand people. Seat caps match
    // join_company's; going down while over the new cap is refused with the
    // number to remove, because quietly cutting a company's crew list loose
    // would be destroying something the owner never agreed to lose.
    const SEATS: Record<string, number> = { solo: 1, crew: 6 };
    const cap = SEATS[plan.toLowerCase()];
    if (cap !== undefined) {
      const { count } = await admin
        .from("profiles").select("id", { count: "exact", head: true })
        .eq("company_id", profile.company_id);
      const inUse = count ?? 0;
      if (inUse > cap) {
        return json({
          error: `${plan} includes ${cap} ${cap === 1 ? "login" : "logins"}, and you have ${inUse}. ` +
            `Remove ${inUse - cap} from Crew first, then switch plans.`,
        }, 409);
      }
    }

    const { data: company } = await admin
      .from("companies")
      .select("name, stripe_customer_id, stripe_subscription_id, subscription_status, pass_card_fee")
      .eq("id", profile.company_id).single();

    // Staff-only switch (admin portal): this company's monthly price includes
    // the Stripe fee. Same plan product, a price raised so FenceFlow nets the
    // list price after 2.9% + 30c. Plan metadata rides along so the webhook
    // and the check above read it the same way.
    //
    // LAZY, because it CREATES A STRIPE PRICE OBJECT every time it runs. It
    // used to run here, before any decision, so every refusal and every
    // click on the plan already held left a brand-new Price behind in the
    // account forever. Called only on a branch that will actually use it.
    const base = Number(price?.unit_amount ?? 0);
    let billedPriceIdCache: string | null = null;
    async function billedPrice(): Promise<string> {
      if (billedPriceIdCache) return billedPriceIdCache;
      if (company?.pass_card_fee !== true || base <= 0) return (billedPriceIdCache = priceId);
      const productId = typeof price.product === "string" ? price.product : price.product?.id;
      const raised = await stripe("POST", "/prices", {
        product: String(productId ?? ""),
        currency: String(price.currency ?? "usd"),
        unit_amount: String(priceWithCardFee(base)),
        "recurring[interval]": "month",
        "metadata[plan]": plan,
        "metadata[includes_card_fee]": "true",
        "metadata[base_price]": priceId,
      });
      return (billedPriceIdCache = raised.id);
    }

    // WHAT IS THIS COMPANY ACTUALLY PAYING FOR? ASK STRIPE.
    //
    // The guard here used to be:
    //
    //   if (company.stripe_subscription_id &&
    //       ["active","trialing"].includes(company.subscription_status))
    //        ... change the price in place
    //   ... otherwise fall through and open a NEW checkout
    //
    // with the comment above it correctly warning that sending a live
    // subscriber through checkout again "would quietly stack a second monthly
    // charge next to the first". It then did exactly that in two ways.
    //
    // ONE: a `past_due` subscription is still live -- Stripe is retrying the
    // card -- and it is not in that whitelist, so it fell through.
    //
    // TWO, and wider: `stripe_subscription_id` is written in exactly one place
    // in this whole codebase, stripe-webhook/index.ts on
    // checkout.session.completed. `stripe_customer_id` is written HERE, before
    // checkout. So between a customer paying and the webhook landing, the row
    // has a customer and no subscription id -- and a guard that opens with
    // "if the row has a subscription id" skips entirely and opens a second
    // checkout. Double-clicking the plan button is enough.
    //
    // So the row is no longer asked. Stripe is, BY CUSTOMER, which is the only
    // question whose answer covers both holes, plus the stored id in case the
    // customer pointer is the stale one.
    //
    // THE DEFAULT IS REFUSAL. The old shape whitelisted what to change and let
    // everything else fall through to creating a subscription; the safe shape
    // is the reverse, because the costly outcome is creating one. A status
    // this code has never heard of -- one Stripe adds next year -- now refuses
    // instead of billing twice.
    const storedSubId: string | null = company?.stripe_subscription_id ?? null;
    const knownCustomerId: string | null = company?.stripe_customer_id ?? null;

    // deno-lint-ignore no-explicit-any
    const live: any[] = [];
    let customerGone = false;

    if (knownCustomerId) {
      try {
        const list = await stripe(
          "GET", `/subscriptions?customer=${encodeURIComponent(knownCustomerId)}&status=all&limit=100`);
        // deno-lint-ignore no-explicit-any
        const page = (list as any);
        if (page?.has_more === true) {
          return json({
            error: "This company has more than 100 subscriptions on file, which should not happen. " +
              "Nothing has been changed. Please contact support@fenceflowapp.com.",
          }, 409);
        }
        for (const s of page?.data ?? []) live.push(s);
      } catch (e) {
        if (e instanceof StripeError && e.missing) {
          // The customer id points at nothing -- a test-mode id read under a
          // live key is the realistic case. Fall through to making a new
          // customer below, and do NOT treat it as "no subscriptions", which
          // would be true by accident rather than by evidence.
          customerGone = true;
        } else {
          throw e;
        }
      }
    }

    if (storedSubId && !live.some((s) => s?.id === storedSubId)) {
      try {
        live.push(await stripe("GET", `/subscriptions/${storedSubId}`));
      } catch (e) {
        // Only "there is no such subscription" means it is gone. A 429, a 500
        // or a timeout means we do not know, and not knowing must never end
        // with a second subscription being created.
        if (!(e instanceof StripeError && e.missing)) throw e;
      }
    }

    // The judgement itself is a pure function (below), so it can be driven
    // through every Stripe status without a network, a database or a Deno.
    // What is left here is only the doing.
    const action = decideSubscriptionAction({
      live,
      storedSubId,
      customerGone,
      priceId,
      passCardFee: company?.pass_card_fee === true,
    });

    if (action.kind === "refuse") return json({ error: action.error }, action.status);

    if (action.kind === "unchanged") {
      await admin.from("companies")
        .update({ subscription_plan: plan }).eq("id", profile.company_id);
      return json({ upgraded: true, plan, unchanged: true });
    }

    if (action.kind === "swap") {
      await stripe("POST", `/subscriptions/${action.subscriptionId}`, {
        "items[0][id]": action.itemId,
        "items[0][price]": await billedPrice(),
        // The metadata is what the webhook writes back as the plan name;
        // without this an upgrade kept billing the new price under the old
        // plan's label and the old plan's limits.
        "metadata[plan]": plan,
        proration_behavior: "create_prorations",
      });
      const patch: Record<string, string> = { subscription_plan: plan };
      // Repair the pointer when Stripe's answer and the row disagree -- the
      // webhook-lag window above is exactly how they come to.
      if (action.repairPointer) patch.stripe_subscription_id = action.subscriptionId;
      await admin.from("companies").update(patch).eq("id", profile.company_id);
      return json({ upgraded: true, plan });
    }

    // action.kind === "checkout": a genuine first signup, or a company coming
    // back after cancelling.
    const everHadOne = !action.trial;

    // Reuse the Stripe customer so a company that resubscribes keeps one
    // billing history instead of scattering across duplicate customers.
    let customerId = customerGone ? null : knownCustomerId;
    if (!customerId) {
      const customer = await stripe("POST", "/customers", {
        email: user.email ?? "",
        name: company?.name ?? "",
        "metadata[company_id]": profile.company_id,
      });
      customerId = customer.id;
      await admin.from("companies")
        .update({ stripe_customer_id: customerId }).eq("id", profile.company_id);
    }

    const site = Deno.env.get("SITE_URL") ?? "https://fenceflowapp.com";

    const session = await stripe("POST", "/checkout/sessions", {
      mode: "subscription",
      customer: customerId!,
      "line_items[0][price]": await billedPrice(),
      "line_items[0][quantity]": "1",
      // Card up front, first charge when the trial ends -- what the pricing
      // page promises. Companies that already had a subscription do not get a
      // second trial: the trial sells the product, not repeated free months.
      //
      // Decided from what Stripe just said, not by re-reading the row. The
      // old helper asked the database again for stripe_subscription_id, which
      // made clearing that column -- an obvious-looking tidy-up when a
      // subscription turns out to be gone -- hand the company a fresh 14-day
      // trial on its next click. The id is deliberately left alone here for
      // the same reason; the webhook replaces it when checkout completes.
      ...(everHadOne ? {} : { "subscription_data[trial_period_days]": "14" }),
      success_url: `${site}/${back}?billing=success`,
      cancel_url: `${site}/${back}?billing=canceled`,
      "subscription_data[metadata][company_id]": profile.company_id,
      "subscription_data[metadata][plan]": plan,
      "metadata[company_id]": profile.company_id,
      "metadata[plan]": plan,
    });

    return json({ url: session.url });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 400);
  }
});

/** What to do about a company's subscriptions, decided from Stripe's answer.
 *
 *  Pure on purpose. The costly outcome of this function is CREATING a
 *  subscription beside one the customer is already paying for, and that
 *  decision was previously spread through an if/else in a Deno handler that
 *  nothing could run. Here it takes plain objects and returns a plain verb, so
 *  every Stripe status can be driven through it in a test.
 *
 *  THE DEFAULT IS REFUSAL. The old code whitelisted what to CHANGE and let
 *  everything else fall through to creating; this whitelists what may be
 *  changed and what is safely finished, and refuses the rest. A status Stripe
 *  invents next year refuses rather than double-charging.
 */
export type SubAction =
  | { kind: "refuse"; status: number; error: string }
  | { kind: "swap"; subscriptionId: string; itemId: string; repairPointer: boolean }
  | { kind: "unchanged" }
  | { kind: "checkout"; trial: boolean };

export function decideSubscriptionAction(input: {
  // deno-lint-ignore no-explicit-any
  live: any[];
  storedSubId: string | null;
  customerGone: boolean;
  priceId: string;
  passCardFee: boolean;
}): SubAction {
  const { live, storedSubId, customerGone, priceId, passCardFee } = input;

  const unfinished = live.filter((s) => !FINISHED.has(String(s?.status ?? "")));

  // Two open at once means this has already happened to them. Picking one and
  // carrying on would hide it; the owner needs telling.
  if (unfinished.length > 1) {
    return {
      kind: "refuse",
      status: 409,
      error: "This company already has more than one open subscription, so nothing has been " +
        "changed. Please contact support@fenceflowapp.com so it can be sorted out before " +
        "you are billed twice.",
    };
  }

  if (unfinished.length === 1) {
    const sub = unfinished[0];
    const status = String(sub?.status ?? "");

    if (!SWAPPABLE.has(status)) {
      // past_due, unpaid, incomplete, paused, or anything new.
      //
      // Swapping the price here is the other tempting fix, and it is wrong.
      // The plan label is written on success and the service gate lets a
      // past_due company in during its grace period, so the owner would hold
      // the bigger plan with nothing collected. Stripe also leaves the
      // already-finalised invoice at the OLD price, so the change does not
      // settle what is owed -- and both the office and the welcome page throw
      // the response away and simply say "You're on X now."
      //
      // `incomplete` matters for a different reason: its first payment can
      // still succeed. Opening a second checkout beside it is how one company
      // ends up paying two subscriptions from the same afternoon.
      const owed = status === "past_due" || status === "unpaid";
      return {
        kind: "refuse",
        status: 409,
        error: owed
          ? "Your last payment did not go through, so the plan cannot be changed yet. " +
            "Changing it would not settle what is owed. Email support@fenceflowapp.com " +
            "and we will sort the card out, then switch the plan."
          : `This subscription is ${status}, so it cannot be changed from here right now. ` +
            "Nothing has been changed. Please email support@fenceflowapp.com.",
      };
    }

    const itemId = sub?.items?.data?.[0]?.id;
    if (!itemId) {
      return { kind: "refuse", status: 400, error: "Subscription has no item to change" };
    }

    // Already on the plan being asked for: do nothing rather than POST a
    // proration of zero and, with the card-fee switch on, mint another Price
    // object that lives in the account for ever.
    const current = sub?.items?.data?.[0]?.price;
    const currentId = typeof current === "string" ? current : current?.id;
    const currentBase = typeof current === "object" ? current?.metadata?.base_price : undefined;
    if (passCardFee ? currentBase === priceId : currentId === priceId) {
      return { kind: "unchanged" };
    }

    return {
      kind: "swap",
      subscriptionId: String(sub.id),
      itemId: String(itemId),
      // The row and Stripe disagreeing is the webhook-lag window; repair it
      // rather than leaving a pointer at a subscription that is not the one
      // being billed.
      repairPointer: Boolean(sub.id) && sub.id !== storedSubId,
    };
  }

  // Nothing open. A trial is for people who have never had one -- and "ever
  // had one" is judged from what Stripe just said, never by re-reading the
  // company row. The old helper did re-read it, which meant clearing a stale
  // subscription id (an obvious-looking tidy-up) handed the company a fresh
  // 14-day trial on its next click.
  //
  // customerGone means the customer id pointed at nothing, so Stripe's silence
  // is an accident of a bad pointer rather than evidence of a first-timer. The
  // stored subscription id is then the only testimony left that they have
  // subscribed before, and it is believed.
  const everHadOne = live.length > 0 || (customerGone && Boolean(storedSubId));
  return { kind: "checkout", trial: !everHadOne };
}

/** Monthly price in cents that nets `baseCents` after Stripe's 2.9% + 30c. */
export function priceWithCardFee(baseCents: number): number {
  if (!Number.isFinite(baseCents) || baseCents <= 0) return 0;
  return Math.ceil((baseCents + 30) / (1 - 0.029));
}
