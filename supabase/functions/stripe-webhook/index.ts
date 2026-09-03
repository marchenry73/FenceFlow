// Stripe tells us what actually happened. This is the ONLY thing that marks a
// payment paid or a subscription active -- never the browser, never the app,
// because either of those can be faked by whoever is holding the phone.
//
// Secrets: STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Deploy with JWT verification OFF -- Stripe calls this, not a signed-in user.
// The signature check below is what authenticates the caller instead.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

/**
 * Verifies Stripe's signature header over the RAW body.
 *
 * Without this, anyone who learns the URL could POST "subscription active" or
 * "invoice paid" and help themselves to the product.
 */
async function verify(rawBody: string, header: string | null, secret: string): Promise<boolean> {
  if (!header) return false;

  // Every v1 in the header, not just the last one.
  //
  // Rotating the signing secret is the one moment this matters. Stripe signs
  // the request with every secret that is still active and sends them all in
  // the one header -- t=...,v1=<old>,v1=<new>. Folding that into an object
  // collapses the duplicate keys and keeps whichever came last, so for the
  // whole rotation window half the events fail their signature check and are
  // dropped: payments stop being marked paid, subscriptions stop activating,
  // and the only trace is 400s in the Stripe dashboard.
  const fields = header.split(",").map((p) => p.split("=", 2));
  const timestamp = fields.find((f) => f[0] === "t")?.[1];
  const signatures = fields.filter((f) => f[0] === "v1").map((f) => f[1]);
  if (!timestamp || signatures.length === 0) return false;

  // Reject anything older than five minutes so a captured request can't be
  // replayed later.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  // Compare every byte regardless of where the first mismatch is, so response
  // timing can't be used to guess the signature one character at a time. Every
  // candidate is compared for the same reason -- stopping early on a length
  // mismatch would leak which one was the right shape.
  let matched = false;
  for (const signature of signatures) {
    if (expected.length !== signature.length) continue;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    if (diff === 0) matched = true;
  }
  return matched;
}

/**
 * Where Stripe keeps the renewal date now.
 *
 * In API version 2025-03-31 ("Basil") current_period_start and
 * current_period_end were REMOVED from the Subscription object and moved onto
 * each subscription item, because one subscription can now bill its items on
 * different intervals.
 * https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end
 *
 * Nothing here pins a Stripe-Version, so events arrive rendered at whatever
 * version the webhook endpoint is set to, and this account was created well
 * after Basil. So sub.current_period_end was simply undefined and the renewal
 * date was written as null on every single subscription event -- while
 * trial_end, in the same UPDATE, kept working, because trial_end did not move.
 * That is exactly what the live data showed: one column populated, the column
 * beside it null.
 *
 * Both shapes are read, newest first, so this is correct whether the endpoint
 * is on a current version or pinned back to an older one. The latest period
 * end across the items is the subscription's own period end when items share
 * an interval, which is the only case this product creates.
 */
function periodEnd(sub: any): number | null {
  const items = sub?.items?.data;
  if (Array.isArray(items) && items.length) {
    const ends = items
      .map((i: any) => Number(i?.current_period_end))
      .filter((n: number) => Number.isFinite(n) && n > 0);
    if (ends.length) return Math.max(...ends);
  }
  // Pre-Basil shape.
  const legacy = Number(sub?.current_period_end);
  return Number.isFinite(legacy) && legacy > 0 ? legacy : null;
}

/**
 * Which subscription an invoice belongs to.
 *
 * Basil also deprecated invoice.subscription, moving it under a new "parent"
 * field that records what generated the invoice:
 * invoice.parent.subscription_details.subscription, valid when
 * invoice.parent.type is "subscription_details".
 * https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects
 *
 * Both invoice handlers opened with a check on the old field, so on a current
 * API version both of them returned immediately having done nothing -- and the
 * function still answered 200, so Stripe never retried and the Stripe
 * dashboard showed no failures. The one that matters is
 * invoice.payment_succeeded: it is what switches a suspended company back on
 * the moment their payment clears. A contractor who paid their bill stayed
 * locked out until somebody noticed by hand.
 */
function invoiceSubscription(invoice: any): string | null {
  const parent = invoice?.parent;
  if (parent?.type === "subscription_details" && parent?.subscription_details?.subscription) {
    const v = parent.subscription_details.subscription;
    return typeof v === "string" ? v : (v?.id ?? null);
  }
  // Pre-Basil shape.
  const legacy = invoice?.subscription;
  if (legacy) return typeof legacy === "string" ? legacy : (legacy?.id ?? null);
  return null;
}

/**
 * Books a paid deposit or invoice against the job itself.
 *
 * Marking the payment row "paid" is only half the job: the money has to land
 * on the job, or the app still shows the customer owing what they just paid.
 * The balance is recomputed from the payments that actually cleared rather
 * than incremented, so a replayed webhook or a manual correction can't drift
 * the total.
 */
async function applyPaymentToJob(admin: any, payment: any) {
  // Looked up, but not required.
  //
  // A cleared payment used to be thrown away entirely when this came back
  // null, and it comes back null routinely: the app creates a job locally and
  // uploads it on its next sync, so a deposit link sent from the dashboard can
  // easily be paid before the job row exists in the cloud. The Payments table
  // flipped to Paid, Stripe got its 200 and never retried, and the job on the
  // phone showed the full balance owing forever. The ledger below needs only
  // the company and the job's sync id, both of which are on the payment row,
  // so the money is recorded either way and the app rebuilds the paid figure
  // from the ledger when the job finally arrives.
  const { data: job } = await admin.from("jobs")
    .select("id, sync_id, company_id, customer_name, deposit_amount")
    .eq("company_id", payment.company_id)
    .eq("sync_id", payment.job_sync_id)
    .maybeSingle();

  // Within one Stripe mode only.
  //
  // Test and live payments live in the same table, and summing across both
  // meant testing the checkout four times on a real job left it reading
  // $57,240 paid against a $10,595 contract. The direction of that error is
  // what makes it dangerous: after go-live a test payment would still credit a
  // real customer as having paid, and the job would show settled with no money
  // moved. Scoped to the mode of the payment that just cleared.
  const livemode = payment.livemode === true;

  // A test payment is a test. It used to stop at the amount_paid scoping and
  // still write a LEDGER row -- which has no mode column, so every report,
  // the AR aging and the app itself summed it as real collected cash, and
  // the app then rebuilt amount_paid from that ledger, undoing the scoping
  // below. Nothing about a test checkout may touch the books.
  if (!livemode) return;



  // The ledger row first, so the paid figure below can be summed from the
  // ledger itself -- cash, check and card together, the same rule the app
  // uses. Summing job_payments here counted Stripe alone and stamped a
  // Stripe-only figure over a job that also had cash on it.
  await admin.from("payment_records").upsert({
    sync_id: "stripe-" + payment.id,
    company_id: payment.company_id,
    job_sync_id: payment.job_sync_id,
    amount: Number(payment.amount_cents || 0) / 100,
    method: "CARD",
    received_at: new Date().toISOString(),
    reference: String(payment.stripe_id ?? ""),
    note: "",
    recorded_by: "Stripe",
  }, { onConflict: "company_id,sync_id" });

  const { data: ledger } = await admin.from("payment_records")
    .select("amount")
    .eq("company_id", payment.company_id)
    .eq("job_sync_id", payment.job_sync_id)
    .is("deleted_at", null);
  const paidDollars = (ledger ?? [])
    .reduce((sum: number, r: any) => sum + Math.max(0, Number(r.amount || 0)), 0);

  // Records that money arrived, and no more than that. Whether the job is paid
  // in full depends on the contract total, which is computed in the app from
  // the line items, change orders and gate charges -- the server does not have
  // it and should not guess. The app promotes this to PAID_IN_FULL once the
  // amount actually covers the total.
  // No job row yet -- the ledger above is the record until it syncs.
  if (!job) return;

  await admin.from("jobs").update({
    amount_paid: paidDollars,
    payment_status: "DEPOSIT_PAID",
    // Latches the paid figure read-only in the app. What the processor reports
    // is the record; typing over it is not a correction, it is a discrepancy
    // that only surfaces when the customer disputes the bill.
    payments_from_processor: true,
    updated_at: new Date().toISOString(),
  }).eq("id", job.id);


  await notifyPaid(admin, job, Number(payment.amount_cents || 0) / 100, paidDollars);
}

/** Tells the company's phones that money arrived, and how much. */
async function notifyPaid(admin: any, job: any, justPaid: number, totalPaid: number) {
  const raw = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
  if (!raw) return;

  const { data: devices } = await admin.from("device_tokens")
    .select("token").eq("company_id", job.company_id);
  if (!devices?.length) return;

  const sa = JSON.parse(raw);
  const token = await fcmAccessToken(sa);
  const who = job.customer_name || "a customer";

  for (const d of devices) {
    await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          token: d.token,
          data: {
            title: `Payment received: $${justPaid.toFixed(2)}`,
            body: `${who} paid $${justPaid.toFixed(2)}. Total paid on this job is now $${totalPaid.toFixed(2)}.`,
            jobId: String(job.id ?? ""),
          },
          android: { priority: "HIGH" },
        },
      }),
    }).catch(() => {});
  }
}

const b64url = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

/** Service-account JWT exchanged for an FCM access token. */
async function fcmAccessToken(sa: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
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
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned),
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
  // No secret, no service. Both sibling webhooks already refuse in this
  // position and this one did not: the missing value arrived at verify() as
  // undefined, was encoded as the literal text "undefined", and became the
  // HMAC key -- so anyone who worked out the secret was unset could sign their
  // own events and have this function believe them. Refusing loudly also means
  // a deployment that forgot the secret fails visibly rather than quietly
  // accepting nothing.
  const signingSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
  if (!signingSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set; refusing to trust any event.");
    return new Response("Webhook not configured", { status: 500 });
  }

  const raw = await req.text();

  const ok = await verify(
    raw,
    req.headers.get("stripe-signature"),
    signingSecret,
  );
  if (!ok) return new Response("Bad signature", { status: 400 });

  const event = JSON.parse(raw);
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    switch (event.type) {
      // ---- A homeowner paid a deposit or an invoice ----
      case "checkout.session.completed": {
        const session = event.data.object;
        const companyId = session.metadata?.company_id;

        if (session.mode === "payment") {
          // Payment Links carry the link id, which is what we stored.
          const linkId = session.payment_link;
          if (linkId) {
            // Only act on a payment we haven't already banked. Stripe retries
            // webhooks, and adding the same amount twice would silently
            // overstate what the customer has paid.
            const { data: pending } = await admin.from("job_payments")
              .select("id, job_sync_id, amount_cents, company_id, status, livemode, stripe_id")
              .eq("stripe_id", linkId).maybeSingle();

            if (pending && pending.status !== "paid") {
              await admin.from("job_payments")
                .update({ status: "paid", paid_at: new Date().toISOString() })
                .eq("id", pending.id);

              await applyPaymentToJob(admin, pending);
            }
          }
        } else if (session.mode === "subscription" && companyId) {
          // The status is deliberately not written here.
          //
          // Every new signup starts on a 14-day trial, so the subscription
          // Stripe just created is "trialing", not "active". Stamping "active"
          // here recorded a company that has never been charged as a paying
          // customer -- the admin dashboard counted it in "Paying" and added
          // its price to Monthly recurring, inflating the two figures that are
          // supposed to say how the business is actually doing. The
          // customer.subscription.created/updated handler below writes the
          // real status and trial_end; this one only records which
          // subscription and which plan.
          await admin.from("companies").update({
            stripe_subscription_id: session.subscription,
            subscription_plan: session.metadata?.plan ?? "",
          }).eq("id", companyId);
          // Subscribing again is paying. A company that was switched off for
          // non-payment comes straight back rather than waiting on a human.
          await admin.rpc("release_for_payment", { cid: companyId });
        }
        break;
      }

      // ---- Subscription created, renewed, lapsed, or cancelled ----
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const companyId = sub.metadata?.company_id;
        if (!companyId) break;

        // Only the subscription the company currently points at may speak
        // for it. A canceled OLD subscription's deleted-event once arrived
        // after an admin repair and stamped a healthy company 'canceled'.
        const { data: current } = await admin.from("companies")
          .select("stripe_subscription_id").eq("id", companyId).single();
        const stored = current?.stripe_subscription_id;
        if (event.type === "customer.subscription.deleted") {
          if (stored !== sub.id) break;      // stale subscription; ignore
        } else if (stored && stored !== sub.id) {
          break;                              // a different sub owns this company
        } else if (!stored && sub.status === "canceled") {
          // A retried event from a subscription this company no longer points
          // at. There is nothing to cancel on a company with no subscription;
          // applying it is how a repaired company kept getting re-canceled.
          break;
        }

        const status = event.type === "customer.subscription.deleted"
          ? "canceled"
          : String(sub.status ?? "none");

        // What Stripe is actually charging, per month.
        //
        // monthly_price had exactly one writer: March typing a number into the
        // Manage dialog. Stripe has known the real figure the whole time and
        // it was never read, so the admin page's "Monthly recurring" was a
        // hand-kept note that nothing ever checked, and a company that
        // upgraded or downgraded kept its old price on screen for ever.
        //
        // Normalised to a month so the tile can add them up: Stripe quotes an
        // amount per interval, and a yearly plan is not twelve times a monthly
        // one. A cancelled subscription contributes nothing.
        const priceOf = (sub2: any): number | null => {
          const items = sub2?.items?.data;
          if (!Array.isArray(items) || !items.length) return null;
          let cents = 0;
          for (const it of items) {
            const p = it?.price;
            const unit = Number(p?.unit_amount);
            if (!Number.isFinite(unit)) continue;
            const qty = Number(it?.quantity ?? 1) || 1;
            const iv = p?.recurring?.interval;
            const count = Number(p?.recurring?.interval_count ?? 1) || 1;
            const perMonth = iv === "year" ? 1 / (12 * count)
                           : iv === "week" ? 52 / (12 * count)
                           : iv === "day"  ? 365 / (12 * count)
                           : 1 / count;                 // month
            cents += unit * qty * perMonth;
          }
          return Math.round(cents) / 100;
        };
        const monthly = status === "canceled" ? 0 : priceOf(sub);

        const patch: Record<string, unknown> = {
          stripe_subscription_id: sub.id,
          subscription_status: status,
          subscription_plan: sub.metadata?.plan ?? "",
          ...(monthly === null ? {} : { monthly_price: monthly }),
          // The access gate honors trial_ends_at; without this a checkout
          // trial set status='trialing' with no trial end recorded and the
          // brand-new subscriber was locked out on day one.
          //
          // Unlike the renewal date below, this one IS written as null when
          // absent: a trial that has converted or been cancelled has to stop
          // granting trial access, so it must be able to clear itself.
          trial_ends_at: sub.trial_end
            ? new Date(sub.trial_end * 1000).toISOString()
            : null,
        };

        // Left OUT rather than written as null when the shape is unreadable.
        //
        // Writing null here is pure loss: nothing else in the system can
        // recompute a paid-through date, and the gap does not show up as a
        // gap. The admin table falls through to the trial date when this is
        // null, so a missing renewal date is printed as a stale trial date
        // under a column headed "Renews / ends" -- the failure arrives looking
        // like an answer. Omitting the key leaves the last good value alone.
        const end = periodEnd(sub);
        if (end) patch.subscription_ends_at = new Date(end * 1000).toISOString();

        await admin.from("companies").update(patch).eq("id", companyId);
        if (status === "active" || status === "trialing") {
          await admin.rpc("release_for_payment", { cid: companyId });
        }
        break;
      }

      // ---- The money arrived. Turn the lights back on. ----
      //
      // This is the event that was missing. A company suspended for not
      // paying stayed suspended after paying, until somebody noticed and
      // un-ticked it by hand -- the worst possible moment to be slow, because
      // they have just paid and still cannot work. A suspension placed as a
      // deliberate hold is left alone; release_for_payment decides.
      case "invoice.payment_succeeded": {
        const invoice = event.data.object;
        const subId = invoiceSubscription(invoice);
        if (!subId) break;
        const { data: co } = await admin.from("companies")
          .select("id").eq("stripe_subscription_id", subId).maybeSingle();
        if (!co?.id) break;
        await admin.from("companies")
          .update({ subscription_status: "active" }).eq("id", co.id);
        await admin.rpc("release_for_payment", { cid: co.id });
        break;
      }

      // ---- A renewal failed. Don't cut them off mid-job; just flag it. ----
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const subId = invoiceSubscription(invoice);
        if (subId) {
          // A real, bounded grace window, written at the moment the card fails.
          //
          // company_allowed's past_due arm used to read
          // coalesce(grace_ends_at, now() + interval '2 days') > now(), and
          // nothing ever wrote grace_ends_at -- so the fallback was always in
          // the future and a failed card bought unlimited free service. The
          // gate no longer invents a grace period; this writes one, so a
          // contractor halfway through a job is not cut off the same afternoon
          // and is not carried for ever either.
          await admin.from("companies")
            .update({
              subscription_status: "past_due",
              grace_ends_at: new Date(Date.now() + 7 * 86400000).toISOString(),
            })
            .eq("stripe_subscription_id", subId);
        }
        break;
      }
    }
  } catch (e) {
    // Return 500 so Stripe retries rather than dropping the event.
    return new Response(String(e), { status: 500 });
  }

  return new Response("ok", { status: 200 });
});
