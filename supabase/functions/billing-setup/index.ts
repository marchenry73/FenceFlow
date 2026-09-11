// TEMPORARY setup utility for going live with subscriptions.
//
// Exists so the Stripe secret key never has to leave the server: it reports
// whether the stored key is live or test, what webhook endpoints and products
// already exist, and can create the live product + prices once the owner has
// picked them. Deleted after go-live.
//
// Guarded by a shared token because it must run before any user context
// exists; the token is a throwaway minted only for this setup.
const STRIPE = "https://api.stripe.com/v1";

async function stripe(method: string, path: string, form?: Record<string, string>) {
  const res = await fetch(`${STRIPE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? `Stripe ${res.status}`);
  return body;
}

/**
 * Constant-time string compare, matching the same guard on every other
 * secret-gated function here (notify-job-change, the two payment webhooks).
 * `===` on a secret stops at the first mismatched byte, so response timing
 * can leak how many leading characters a guess got right -- an attacker who
 * can send enough requests can walk the token one character at a time
 * instead of guessing the whole thing at once. This function can create
 * Stripe products and cancel any subscription by id, so the token guarding
 * it deserves the same care as a webhook signature.
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
  const expectedToken = Deno.env.get("BILLING_SETUP_TOKEN");
  // Fail closed: an unset token must never mean "let everyone in" -- see the
  // identical rule in notify-job-change.
  if (!expectedToken || !secretMatches(req.headers.get("x-setup-token"), expectedToken)) {
    return new Response("no", { status: 401 });
  }
  try {
    const { action, plans, subscriptionId } = await req.json();

    if (action === "status") {
      const balance = await stripe("GET", "/balance");
      const hooks = await stripe("GET", "/webhook_endpoints?limit=10");
      const products = await stripe("GET", "/products?limit=10&active=true");
      const prices = await stripe("GET", "/prices?limit=20&active=true");
      return Response.json({
        keyIsLive: balance.livemode === true,
        webhooks: hooks.data.map((w: { url: string; status: string; livemode: boolean }) =>
          ({ url: w.url, status: w.status, livemode: w.livemode })),
        products: products.data.map((p: { id: string; name: string }) => ({ id: p.id, name: p.name })),
        prices: prices.data.map((p: {
          id: string; product: string; unit_amount: number;
          recurring?: { interval: string }; livemode: boolean;
        }) => ({
          id: p.id, product: p.product, amount: p.unit_amount,
          interval: p.recurring?.interval ?? "one_time", livemode: p.livemode,
        })),
      });
    }

    if (action === "create_plans") {
      // plans: [{ name, amountCents }] -- monthly, one product per plan so the
      // Stripe dashboard reads like the pricing page does.
      const out = [];
      for (const plan of plans) {
        const product = await stripe("POST", "/products", {
          name: `FenceFlow ${plan.name}`,
        });
        const price = await stripe("POST", "/prices", {
          product: product.id,
          currency: "usd",
          unit_amount: String(plan.amountCents),
          "recurring[interval]": "month",
        });
        out.push({ plan: plan.name, productId: product.id, priceId: price.id });
      }
      return Response.json({ created: out });
    }

    // cancel_subscription is gone, deliberately.
    //
    // It took a bare Stripe subscription id and deleted it. No company scope,
    // no check that the subscription belonged to anyone in particular, no
    // confirmation -- so anything holding this function's shared token could
    // end any paying customer's subscription, including one belonging to a
    // company nobody here has ever heard of. The token is a single shared
    // secret with no rotation and no audit trail behind it.
    //
    // Nothing was lost by removing it. Cancelling a subscription is a rare,
    // deliberate act that Stripe's own dashboard does properly: it shows whose
    // subscription it is before you confirm, and it records who did it. A
    // one-line HTTP call that does the same thing with none of that is a
    // liability standing in for a convenience.
    //
    // The rest of this file -- reading status, creating the plan objects -- is
    // read-mostly setup work and stays until go-live, when the header above
    // says the whole file goes.
    if (action === "cancel_subscription") {
      return Response.json({
        error: "Cancel a subscription in the Stripe dashboard, where it shows " +
          "you whose it is and records who cancelled it.",
      }, { status: 410 });
    }

    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: String(e instanceof Error ? e.message : e) }, { status: 400 });
  }
});
