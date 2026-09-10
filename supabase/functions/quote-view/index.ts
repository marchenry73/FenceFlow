/**
 * The homeowner's view of a quote.
 *
 * A contractor sends a link; the person who owns the yard opens it, sees the
 * quote, walks around their fence in 3D, approves it with their name, and --
 * once the company's card processor is connected -- pays the deposit. No
 * account, no app, no sign-in: the unguessable token IS the authorisation,
 * exactly like a bank's document link.
 *
 *   GET  ?t=<token>                      -> the quote, whitelisted fields only
 *   POST ?t=<token>  {action:"approve", name} -> records the approval
 *
 * Everything goes through an explicit whitelist. The jobs row also carries
 * labour rates, margins and markup; estimate lines carry supplier_unit_price,
 * which is what the contractor PAYS. None of that may ever reach the person
 * being quoted, so the shape sent out is built by hand rather than selecting
 * whole rows and hoping.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { depositFigures } from "../_shared/quote-deposit.ts";

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

  const url = new URL(req.url);
  const token = (url.searchParams.get("t") ?? "").trim();
  // A malformed token is not a lookup that found nothing; refuse it before
  // the database ever sees it.
  if (!/^[0-9a-f-]{36}$/.test(token)) return json({ error: "That link is not valid." }, 400);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: job } = await admin
    .from("jobs")
    .select("id, sync_id, company_id, customer_name, address, phone, status, deleted_at, " +
      "contract_total, deposit_amount, amount_paid, refunded_amount, " +
      "tax_rate_percent, discount_percent, " +
      "quote_viewed_at, quote_approved_at, quote_approved_name, calibration_pixels_per_foot, " +
      "quote_phone_attempts, quote_phone_locked_until")
    .eq("quote_token", token)
    .maybeSingle();
  if (!job || job.deleted_at) return json({ error: "That quote is no longer available." }, 404);

  // Suspension reaches the public pages too. This runs as the service role,
  // so the RESTRICTIVE not-suspended policies that lock a switched-off
  // company out of the app and the office never see these reads -- and a
  // suspended company's quote links went on working: viewable, approvable,
  // and pushing "Quote approved" to every phone on a company that was shut.
  // Same answer as a deleted job, on purpose: the homeowner is not the one
  // who needs to know why.
  const { data: allowed } = await admin.rpc("company_allowed", { cid: job.company_id });
  if (allowed === false) return json({ error: "That quote is no longer available." }, 404);

  // ------------------------------------------------------------- approve ---
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body?.action !== "approve") return json({ error: "Unknown action." }, 400);
    const name = String(body?.name ?? "").trim().slice(0, 120);
    if (name.length < 2) return json({ error: "Type your name to approve." }, 400);

    // First signature wins. A second approval must not overwrite whose name
    // is on the record.
    const justApproved = !job.quote_approved_at;

    // -------------------------------------------------- phone gate --------
    // A forwarded link lets anyone who has it -- a neighbour, a spouse who
    // was never the buyer, whoever the customer sent it to for an opinion --
    // sign for thousands of dollars. Only the approval step is gated; the
    // quote stays exactly as readable as it always was.
    //
    // The digits never reach the browser and the comparison never happens
    // there: the page holds nothing that decides the answer, so a client
    // patched to always say "match" still gets refused here.
    const phoneDigits = String(job.phone ?? "").replace(/\D/g, "");
    const hasPhone = phoneDigits.length >= 4;
    let approvedWithoutPhoneCheck = false;
    if (justApproved) {
      if (hasPhone) {
        const now = Date.now();
        const lockedUntilMs = job.quote_phone_locked_until
          ? Date.parse(job.quote_phone_locked_until)
          : 0;
        if (lockedUntilMs > now) {
          // Same shape of response as a wrong guess -- a lockout must not
          // read as a different, more informative kind of failure.
          return json({ error: "Too many attempts. Try again in a few minutes." }, 429);
        }

        const submitted = String(body?.phone4 ?? "").replace(/\D/g, "");
        const last4 = phoneDigits.slice(-4);
        if (submitted.length !== 4 || submitted !== last4) {
          const MAX_ATTEMPTS = 5;
          const attempts = (Number(job.quote_phone_attempts) || 0) + 1;
          const update: Record<string, unknown> = { quote_phone_attempts: attempts };
          if (attempts >= MAX_ATTEMPTS) {
            update.quote_phone_locked_until = new Date(now + 15 * 60 * 1000).toISOString();
            update.quote_phone_attempts = 0;
          }
          await admin.from("jobs").update(update).eq("id", job.id);
          // One sentence for "wrong digits", "no phone on file" (this branch
          // is never reached when there isn't one) and "quote not found"
          // (handled earlier, above). None of them may be told apart by
          // wording, or the wording itself becomes a way to learn the phone
          // number four attempts at a time.
          return json({ error: "Those last four digits don't match our records." }, 400);
        }
        // Right answer: a stranger's earlier near-misses on this same job
        // must not carry forward and count against the person who just got
        // it right.
        if (job.quote_phone_attempts || job.quote_phone_locked_until) {
          await admin.from("jobs")
            .update({ quote_phone_attempts: 0, quote_phone_locked_until: null })
            .eq("id", job.id);
        }
      } else {
        // DECISION: a job with no phone on it cannot be gated by a phone
        // digit nobody collected. Refusing every such quote would strand a
        // real customer over a field their contractor forgot to fill in;
        // approving with no check at all -- silently -- is the exact bug
        // this feature exists to close, just moved one field over. So this
        // approval is allowed to go through unchecked, but that fact is
        // written to the row rather than left implicit, so a look at the
        // job afterwards shows the gate did not run instead of assuming it
        // did.
        approvedWithoutPhoneCheck = true;
      }
    }

    if (justApproved) {
      await admin.from("jobs").update({
        quote_approved_at: new Date().toISOString(),
        quote_approved_name: name,
        ...(approvedWithoutPhoneCheck ? { quote_approved_without_phone_check: true } : {}),
        // Approval is acceptance. DRAFT/SENT move forward; anything already
        // further along (deposit paid, completed) is left exactly where it is.
        ...(["DRAFT", "SENT"].includes(job.status) ? { status: "ACCEPTED" } : {}),
      }).eq("id", job.id);
    }
    // The whole point of an approval is somebody hearing about it. Every
    // phone signed into the company gets the push the moment the name goes
    // on the record; failures are swallowed because the approval itself must
    // never fail for want of a notification.
    //
    // Only on the approval that actually landed, though. This sat outside the
    // guard above and fired on every request, with an attacker-supplied name
    // at the front of it -- so anyone holding a forwarded quote link could
    // buzz every phone in the company in a loop until the crew turned
    // notifications off and stopped seeing real job alerts.
    if (justApproved) try {
      const sa = JSON.parse(Deno.env.get("FIREBASE_SERVICE_ACCOUNT") ?? "null");
      if (sa) {
        const { data: toks } = await admin
          .from("device_tokens").select("token").eq("company_id", job.company_id);
        if (toks?.length) {
          const jwtHeader = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }))
            .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          const now = Math.floor(Date.now() / 1000);
          const claims = btoa(JSON.stringify({
            iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
            aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
          })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          const keyDer = atob(sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""));
          const keyBytes = new Uint8Array([...keyDer].map((c) => c.charCodeAt(0)));
          const key = await crypto.subtle.importKey("pkcs8", keyBytes,
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
          const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key,
            new TextEncoder().encode(jwtHeader + "." + claims));
          const jwt = jwtHeader + "." + claims + "." +
            btoa(String.fromCharCode(...new Uint8Array(sig)))
              .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          const tokRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt,
            }),
          });
          const accessTok = (await tokRes.json()).access_token;
          if (accessTok) {
            await Promise.all(toks.map((t: { token: string }) =>
              fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${accessTok}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  message: {
                    token: t.token,
                    notification: {
                      title: "Quote approved 🎉",
                      body: `${name} approved the quote for ${job.customer_name || "the job"}.`,
                    },
                  },
                }),
              }).catch(() => null)
            ));
          }
        }
      }
    } catch (_e) { /* the approval stands regardless */ }

    return json({ ok: true, approvedBy: job.quote_approved_name || name });
  }

  // ---------------------------------------------------------------- view ---
  const [{ data: company }, { data: items }, { data: runs }, { data: conn }] =
    await Promise.all([
      admin.from("companies").select("name, phone, email").eq("id", job.company_id).single(),
      // Pinned to the company as well as the job. The job id alone was the
      // key, so a row written under another company but carrying this job's
      // id would have been priced into this quote -- defence in depth against
      // exactly the cross-company write the rest of the system guards for.
      admin.from("estimate_line_items")
        .select("description, quantity, unit, unit_price, taxable, sort_order")
        .eq("company_id", job.company_id)
        .eq("job_sync_id", job.sync_id).is("deleted_at", null)
        .order("sort_order"),
      admin.from("fence_runs")
        .select("label, fence_type, color_or_finish, points_encoded, gates_encoded, " +
          "closed_loop, panel_height_ft, post_spacing_ft, manual_linear_feet, " +
          "wood_style, aluminum_style, fabric_height_ft, split_rail_count, is_teardown")
        .eq("company_id", job.company_id)
        .eq("job_sync_id", job.sync_id).is("deleted_at", null),
      admin.from("payment_connections")
        .select("processor, external_id, access_token")
        .eq("company_id", job.company_id).maybeSingle(),
    ]);

  // The first open is worth knowing about; later opens are just reading.
  if (!job.quote_viewed_at) {
    await admin.from("jobs").update({ quote_viewed_at: new Date().toISOString() })
      .eq("id", job.id);
  }

  const lines = (items ?? []).map((i) => ({
    description: i.description,
    quantity: i.quantity,
    unit: i.unit,
    unitPrice: i.unit_price,
    total: (Number(i.quantity) || 0) * (Number(i.unit_price) || 0),
    taxable: !!i.taxable,
  }));
  const subtotal = lines.reduce((s, l) => s + l.total, 0);
  const taxRate = Number(job.tax_rate_percent) || 0;
  const tax = lines.filter((l) => l.taxable).reduce((s, l) => s + l.total, 0) * taxRate / 100;
  // Whatever the source, the customer-facing figure rounds UP to the next
  // ten -- the number on the page always covers the buy.
  const total = Math.ceil((Number(job.contract_total) || (subtotal + tax)) / 10) * 10;
  // The deposit exists so the materials can be bought before labour starts.
  //
  // This used to invent one from the material cost when the contractor had
  // not set any -- rounded up to the next hundred -- and print it on the
  // page. create-payment-link knew nothing about that invented figure and
  // refused to charge it, so the page asked for a deposit the product would
  // not take. Worse, it put a number in front of a customer that their
  // contractor had never agreed to. Both functions now read one rule
  // (_shared/quote-deposit.ts): a deposit is a thing the contractor asks
  // for, and what is shown is what is still owed on it.
  const money = depositFigures({
    depositAmount: job.deposit_amount,
    contractTotal: job.contract_total,
    amountPaid: job.amount_paid,
    refundedAmount: job.refunded_amount,
  });
  const deposit = money.asked;

  // Whether the deposit button can do anything. A connected processor means
  // create-payment-link's token path will produce a real checkout.
  const paymentsReady = !!(conn && (
    (conn.processor === "square" && conn.access_token && conn.external_id) ||
    (conn.processor === "stripe" && conn.external_id)
  ));

  return json({
    company: { name: company?.name ?? "", phone: company?.phone ?? "", email: company?.email ?? "" },
    customerName: job.customer_name,
    address: job.address,
    // Deliberately NO line items. The parts list -- 103 bags of concrete at
    // $4.75, panels at $52.35 -- is the contractor's working, and handing it
    // over invites pricing the job from a hardware-store receipt. The
    // customer buys a fence, not a bill of materials: they get what they are
    // getting and what it costs, enforced here rather than hidden by CSS.
    //
    // subtotal, tax and taxRate used to ride along in this object. Nothing on
    // the page ever read them, and subtotal IS the material cost -- so anyone
    // who opened the browser's network tab, or anyone the link was forwarded
    // to, could subtract it from the total and read the labour and margin
    // before sitting down to negotiate. The comment above was already the
    // right rule; the line under it was breaking it.
    total,
    deposit,
    // What pressing the button would actually collect. Differs from
    // [deposit] once part of it has been paid, and the page needs both: the
    // deposit is what was agreed, the amount due is what is left.
    depositDue: money.due,
    depositPayable: money.payable,
    approvedAt: job.quote_approved_at,
    // Whether the approve step needs to ask for the last four digits of the
    // job's phone number. A boolean saying a phone is on file is not the
    // phone number -- this is the one fact about it the page is allowed to
    // hold, and it is not enough to guess the digits from.
    phoneGateRequired: String(job.phone ?? "").replace(/\D/g, "").length >= 4,
    // The survey canvas draws on a 20px/ft grid unless the job was calibrated
    // against a known measurement; the 3D view must use the same number or
    // the fence is built at the wrong size entirely.
    pxPerFoot: Number(job.calibration_pixels_per_foot) || 20,
    approvedBy: job.quote_approved_name,
    paymentsReady,
    // Teardown runs ride along too. The old fence is half the sales pitch:
    // the customer sees the weathered thing they hate standing in the yard,
    // then removes it with one tap and looks at the new one alone.
    runs: (runs ?? []).map((r) => ({
      teardown: !!r.is_teardown,
      label: r.label,
      type: r.fence_type,
      finish: r.color_or_finish,
      points: r.points_encoded,
      gates: r.gates_encoded,
      closed: !!r.closed_loop,
      heightFt: Number(r.panel_height_ft) || Number(r.fabric_height_ft) || 6,
      postSpacingFt: Number(r.post_spacing_ft) || 8,
      manualFeet: Number(r.manual_linear_feet) || 0,
      woodStyle: r.wood_style, aluminumStyle: r.aluminum_style,
      splitRails: Number(r.split_rail_count) || 2,
    })),
  });
});
