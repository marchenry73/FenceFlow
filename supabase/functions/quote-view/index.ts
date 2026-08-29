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
    .select("id, sync_id, company_id, customer_name, address, status, deleted_at, " +
      "contract_total, deposit_amount, tax_rate_percent, discount_percent, " +
      "quote_viewed_at, quote_approved_at, quote_approved_name, calibration_pixels_per_foot")
    .eq("quote_token", token)
    .maybeSingle();
  if (!job || job.deleted_at) return json({ error: "That quote is no longer available." }, 404);

  // ------------------------------------------------------------- approve ---
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body?.action !== "approve") return json({ error: "Unknown action." }, 400);
    const name = String(body?.name ?? "").trim().slice(0, 120);
    if (name.length < 2) return json({ error: "Type your name to approve." }, 400);

    // First signature wins. A second approval must not overwrite whose name
    // is on the record.
    if (!job.quote_approved_at) {
      await admin.from("jobs").update({
        quote_approved_at: new Date().toISOString(),
        quote_approved_name: name,
        // Approval is acceptance. DRAFT/SENT move forward; anything already
        // further along (deposit paid, completed) is left exactly where it is.
        ...(["DRAFT", "SENT"].includes(job.status) ? { status: "ACCEPTED" } : {}),
      }).eq("id", job.id);
    }
    return json({ ok: true, approvedBy: job.quote_approved_name || name });
  }

  // ---------------------------------------------------------------- view ---
  const [{ data: company }, { data: items }, { data: runs }, { data: conn }] =
    await Promise.all([
      admin.from("companies").select("name, phone, email").eq("id", job.company_id).single(),
      admin.from("estimate_line_items")
        .select("description, quantity, unit, unit_price, taxable, sort_order")
        .eq("job_sync_id", job.sync_id).is("deleted_at", null)
        .order("sort_order"),
      admin.from("fence_runs")
        .select("label, fence_type, color_or_finish, points_encoded, gates_encoded, " +
          "closed_loop, panel_height_ft, post_spacing_ft, manual_linear_feet, " +
          "wood_style, aluminum_style, fabric_height_ft, split_rail_count, is_teardown")
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
  const total = Number(job.contract_total) || (subtotal + tax);

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
    lines,
    subtotal, tax, taxRate, total,
    deposit: Number(job.deposit_amount) || 0,
    approvedAt: job.quote_approved_at,
    // The survey canvas draws on a 20px/ft grid unless the job was calibrated
    // against a known measurement; the 3D view must use the same number or
    // the fence is built at the wrong size entirely.
    pxPerFoot: Number(job.calibration_pixels_per_foot) || 20,
    approvedBy: job.quote_approved_name,
    paymentsReady,
    runs: (runs ?? []).filter((r) => !r.is_teardown).map((r) => ({
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
