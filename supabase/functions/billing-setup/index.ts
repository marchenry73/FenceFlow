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

Deno.serve(async (req) => {
  if (req.headers.get("x-setup-token") !== Deno.env.get("BILLING_SETUP_TOKEN")) {
    return new Response("no", { status: 401 });
  }
  try {
    const { action, plans } = await req.json();

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

    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: String(e instanceof Error ? e.message : e) }, { status: 400 });
  }
});
