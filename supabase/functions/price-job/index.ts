/**
 * Prices a job on the server, with the same engine and the same rules the
 * phone uses (supabase/functions/_shared/pricing). This is the ONLY thing
 * that may write a price from the office: dashboard.html never gains a
 * formula of its own -- two formulas is how the office and the phone once
 * disagreed about the same job.
 *
 *   POST { job_sync_id, mode: "dry_run" | "commit" | "sample",
 *          expected_updated_at?, template_sync_id?, feet? }
 *
 * There is exactly one door, the signed-in office, and it is checked in
 * code rather than only at the gateway (verify_jwt = true in config.toml
 * rejects a request with no valid JWT before this ever runs, but the
 * company/role/permission checks below are what actually decide whether
 * THIS caller may see THIS job's money). Everything after the auth check
 * runs on a client built from the caller's own Authorization header --
 * never the service role -- so Postgres RLS enforces company isolation the
 * same way it does for every other read the app makes. A bug in this file
 * can leak at most what that person's own login already reaches.
 *
 * dry_run and sample never write. commit is the only mode that touches the
 * database, and it does so in the order TakeoffRefresher.replaceGeneratedForRun
 * uses on the phone: write the new lines, THEN tombstone what they replaced,
 * THEN stamp the job's total -- so a crash between steps leaves stray old
 * rows rather than a total with nothing behind it.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { PRICING_ENGINE_VERSION, priceJob } from "../_shared/pricing/index.ts";
import type { PricingInput, PricingOutput } from "../_shared/pricing/index.ts";
import { buildCommitPlan, buildPricingInput, buildSampleRun, isStale } from "../_shared/pricing/load.ts";
import type {
  DbBuildTemplateRow,
  DbChangeOrderRow,
  DbFenceRunRow,
  DbJobRow,
  DbLineItemRow,
  DbManufacturerRow,
  DbMaterialItemRow,
} from "../_shared/pricing/load.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Column lists, one place each, so the shape price-job asks Postgres for and
// the shape load.ts's Db*Row types expect can never quietly drift apart.
const JOB_COLUMNS = "sync_id, updated_at, calibration_pixels_per_foot, tax_rate_percent, " +
  "markup_percent, discount_percent, labor_rate_per_ft, labor_flat_fee, minimum_job_charge, " +
  "waste_percent, gate_rate_per_ft, trash_haul_fee, teardown_enabled, teardown_flat_fee, " +
  "teardown_rate_per_ft, teardown_feet, preferred_manufacturer_sync_id";
const RUN_COLUMNS = "sync_id, label, fence_type, color_or_finish, points_encoded, gates_encoded, " +
  "closed_loop, manual_linear_feet, manual_corner_count, panel_width_ft, panel_height_ft, " +
  "post_spacing_ft, concrete_bags_per_post, aluminum_style, wood_style, wood_rail_count, " +
  "picket_width_in, picket_gap_in, fabric_height_ft, include_top_rail, include_tension_wire, " +
  "include_barbed_wire_arms, include_privacy_slats, split_rail_count, suppressed_roles, " +
  "is_teardown, sort_order";
const CATALOG_COLUMNS = "sync_id, name, category, role, fence_type, color_or_finish, unit, " +
  "unit_price, taxable, covers_ft, manufacturer_sync_id, is_active";
const MANUFACTURER_COLUMNS = "sync_id, name";
const CHANGE_ORDER_COLUMNS = "sync_id, additional_feet, additional_cost, material_cost";
const LINE_ITEM_COLUMNS = "sync_id, fence_run_sync_id, role, description, quantity, unit, " +
  "unit_price, supplier_unit_price, taxable, auto_generated, sort_order";

type SupabaseClient = ReturnType<typeof createClient>;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "No login sent with the request" }, 401);

    // The CALLER's own client, built with the anon key, never the service
    // role. Every query below runs as this specific person under RLS, so
    // "which company" and "which rows" are enforced by Postgres itself, the
    // same way they are for the app -- this function does not re-implement
    // company isolation, it inherits it.
    const supabase: SupabaseClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    // Validate the token explicitly rather than trusting a header handed to
    // a client and calling getUser() with no argument -- see the note in
    // create-payment-link: that does not reliably read a header set only via
    // `global.headers`, and a properly signed-in caller reads as logged out.
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    const { data: userData, error: authError } = await supabase.auth.getUser(jwt);
    const uid = userData?.user?.id;
    if (!uid) return json({ error: `Login not accepted: ${authError?.message ?? "unknown"}` }, 401);

    const body = await req.json().catch(() => ({}));
    const jobSyncId = String(body?.job_sync_id ?? "").trim();
    const mode = body?.mode;
    if (!jobSyncId) return json({ error: "job_sync_id is required" }, 400);
    if (mode !== "dry_run" && mode !== "commit" && mode !== "sample") {
      return json({ error: "mode must be dry_run, commit, or sample" }, 400);
    }

    const { data: profile } = await supabase
      .from("profiles").select("company_id, role, permission_overrides").eq("id", uid).maybeSingle();
    if (!profile?.company_id) return json({ error: "No company" }, 403);

    // The gate the whole function exists to enforce: a crew session must
    // never receive a priced payload. Role first -- cheap, no RPC round
    // trip -- then the permission itself, which a MANAGER can have had taken
    // away and an OWNER cannot (has_permission's own resolve()). Both must
    // hold; neither alone is enough, so a SALES role that happens to default
    // to SEE_MONEY is still refused here.
    if (profile.role !== "OWNER" && profile.role !== "MANAGER") {
      return json({ error: "Pricing is restricted to owners and managers." }, 403);
    }
    const { data: seeMoney, error: permError } = await supabase.rpc("has_permission", { perm: "SEE_MONEY" });
    if (permError) {
      console.error("price-job: has_permission", permError.message);
      return json({ error: "Could not check your pricing permission." }, 500);
    }
    if (seeMoney !== true) {
      return json({ error: "You do not have permission to see pricing." }, 403);
    }
    const { data: allowed, error: allowedError } = await supabase.rpc("company_allowed", { cid: profile.company_id });
    if (allowedError) {
      console.error("price-job: company_allowed", allowedError.message);
      return json({ error: "Could not check your FenceFlow account." }, 500);
    }
    if (allowed === false) {
      return json({ error: "This FenceFlow account is not active. Check the Billing tab." }, 403);
    }

    const { data: jobData, error: jobError } = await supabase
      .from("jobs").select(JOB_COLUMNS)
      .eq("company_id", profile.company_id).eq("sync_id", jobSyncId).is("deleted_at", null)
      .maybeSingle();
    if (jobError) {
      console.error("price-job: load job", jobError.message);
      return json({ error: "Could not load the job." }, 500);
    }
    if (!jobData) return json({ error: "Job not found." }, 404);
    const job = jobData as DbJobRow;

    if (mode === "sample") return await handleSample(supabase, profile.company_id, job, body);

    // dry_run and commit both price the WHOLE job as it stands today -- the
    // office re-prices everything, never one run at a time, so a run's
    // material choices can still change the totals of the estimate as a
    // whole (minimum charge, waste, markup).
    const [
      { data: runsData, error: runsError },
      { data: catalogData, error: catalogError },
      { data: manufacturersData, error: mfrError },
      { data: changeOrdersData, error: coError },
      { data: existingItemsData, error: itemsError },
    ] = await Promise.all([
      supabase.from("fence_runs").select(RUN_COLUMNS)
        .eq("company_id", profile.company_id).eq("job_sync_id", job.sync_id)
        .is("deleted_at", null).order("sort_order"),
      supabase.from("material_items").select(CATALOG_COLUMNS)
        .eq("company_id", profile.company_id).is("deleted_at", null),
      supabase.from("manufacturers").select(MANUFACTURER_COLUMNS)
        .eq("company_id", profile.company_id).is("deleted_at", null),
      supabase.from("change_orders").select(CHANGE_ORDER_COLUMNS)
        .eq("company_id", profile.company_id).eq("job_sync_id", job.sync_id).is("deleted_at", null),
      supabase.from("estimate_line_items").select(LINE_ITEM_COLUMNS)
        .eq("company_id", profile.company_id).eq("job_sync_id", job.sync_id).is("deleted_at", null),
    ]);
    const loadError = runsError ?? catalogError ?? mfrError ?? coError ?? itemsError;
    if (loadError) {
      console.error("price-job: load takeoff inputs", loadError.message);
      return json({ error: "Could not load everything this job needs to be priced." }, 500);
    }
    const runs = (runsData ?? []) as DbFenceRunRow[];
    const existingItems = (existingItemsData ?? []) as DbLineItemRow[];

    const input: PricingInput = buildPricingInput({
      job,
      runs,
      catalog: (catalogData ?? []) as DbMaterialItemRow[],
      manufacturers: (manufacturersData ?? []) as DbManufacturerRow[],
      changeOrders: (changeOrdersData ?? []) as DbChangeOrderRow[],
      existingItems,
      engineVersion: PRICING_ENGINE_VERSION,
    });

    let output: PricingOutput;
    try {
      output = priceJob(input);
    } catch (e) {
      // Not a database error -- the engine refused this job's own data (an
      // unrecognised fence type, most likely a row a phone wrote with a
      // newer app version than this port knows about). Logged in full;
      // the caller gets enough to know it is a data problem, not a bug.
      console.error("price-job: engine", (e as Error).message);
      return json({ error: "Could not price this job -- its fence data looks invalid." }, 400);
    }

    const nowIso = new Date().toISOString();

    if (mode === "dry_run") {
      return json({ output, priced_by: "OFFICE", priced_at: nowIso, pricing_engine_version: PRICING_ENGINE_VERSION });
    }

    // ---------------------------------------------------------------- commit --
    if (isStale(job.updated_at, body?.expected_updated_at)) {
      return json({ error: "Somebody else changed this job. Reload it and try again." }, 409);
    }

    const plan = buildCommitPlan({
      output,
      companyId: profile.company_id,
      jobSyncId: job.sync_id,
      pricedRunSyncIds: runs.map((r) => r.sync_id),
      existingItems,
      nowIso,
    });

    // Replacing lines is a delete, and deletes are gated: the trash-bin
    // trigger refuses a tombstone from anyone without DELETE_RECORDS, which a
    // MANAGER does not hold by default. Asked BEFORE anything is written --
    // the first draft upserted the new lines first, so a manager's re-price
    // would have landed the new estimate on top of the old one and failed
    // only at the tombstone, leaving both sets of lines counting.
    if (plan.tombstoneSyncIds.length > 0) {
      const { data: mayDelete, error: delPermError } = await supabase
        .rpc("has_permission", { perm: "DELETE_RECORDS" });
      if (delPermError) {
        console.error("price-job: has_permission DELETE_RECORDS", delPermError.message);
        return json({ error: "Could not check your permissions." }, 500);
      }
      if (mayDelete !== true) {
        return json({
          error: "Re-pricing replaces this job's estimate lines, which needs the Delete records permission. Ask the owner to re-price it, or to grant you that permission.",
        }, 403);
      }
    }

    if (plan.tombstoneSyncIds.length > 0) {
      // Never delete -- update the same two columns every other table's
      // trash bin uses, so a mistaken re-price stays recoverable the same
      // way a mistaken delete anywhere else in FenceFlow is.
      const { error } = await supabase
        .from("estimate_line_items")
        .update({ deleted_at: nowIso, deleted_by: uid })
        .eq("company_id", profile.company_id)
        .in("sync_id", plan.tombstoneSyncIds);
      if (error) {
        console.error("price-job: tombstone items", error.message);
        return json({ error: "Could not clear the old estimate lines." }, 500);
      }
    }

    // Old lines first, new lines second, on purpose: if the second write
    // fails the job is briefly missing its estimate, which is visible and
    // fixed by pressing the button again -- the other order left the old
    // and the new lines counting together, which is invisible and wrong.
    if (plan.upsertItems.length > 0) {
      const { error } = await supabase
        .from("estimate_line_items")
        .upsert(plan.upsertItems, { onConflict: "company_id,sync_id" });
      if (error) {
        console.error("price-job: upsert items", error.message);
        return json({ error: "Could not save the estimate." }, 500);
      }
    }

    // NEVER updated_at, and never calibration_pixels_per_foot -- the four
    // columns in jobPatch (contract_total, priced_by, priced_at,
    // pricing_engine_version) are on touch_updated_at()'s quiet list
    // precisely so this write cannot make a phone's own unsynced offline
    // edits look older than it and lose them on the next merge.
    const { error: jobUpdateError } = await supabase
      .from("jobs")
      .update(plan.jobPatch)
      .eq("company_id", profile.company_id)
      .eq("sync_id", job.sync_id);
    if (jobUpdateError) {
      console.error("price-job: update job", jobUpdateError.message);
      return json({
        error: "The estimate saved, but the job total could not be updated. Reload and try again.",
      }, 500);
    }

    return json({
      output,
      written: {
        items_upserted: plan.upsertItems.length,
        items_tombstoned: plan.tombstoneSyncIds.length,
        contract_total: plan.jobPatch.contract_total,
        priced_by: plan.jobPatch.priced_by,
        priced_at: plan.jobPatch.priced_at,
        pricing_engine_version: plan.jobPatch.pricing_engine_version,
      },
    });
  } catch (e) {
    // Whatever this was, it never reached a specific, safer error above.
    // The real one goes to the log; the caller gets a sentence, never a
    // database message -- see the file header on why nothing here trusts
    // its errors to be safe to show.
    console.error("price-job", (e as Error).message);
    return json({ error: "Could not price this job right now. Try again in a moment." }, 500);
  }
});

/**
 * `sample`: a hypothetical -- a template's spec, typed footage, no drawing,
 * no gates -- priced against the company's own catalog and this job's rates.
 * Nothing is written; there is no run to write it to. Kept as its own
 * function only because the request needs a different pair of loads (a
 * template lookup instead of the job's actual runs); everything else about
 * pricing it is identical to dry_run.
 */
async function handleSample(
  supabase: SupabaseClient,
  companyId: string,
  job: DbJobRow,
  body: Record<string, unknown>,
): Promise<Response> {
  const templateSyncId = String(body?.template_sync_id ?? "").trim();
  const feet = Number(body?.feet);
  if (!templateSyncId) return json({ error: "template_sync_id is required for a sample" }, 400);
  if (!Number.isFinite(feet) || feet <= 0) return json({ error: "feet must be a number greater than zero" }, 400);

  // Shipped ∪ this company's own -- the same set the picker offers, read
  // through the one RPC that lists the spec columns so a template's shape
  // never has to be retyped here.
  const { data: templatesJson, error: templatesError } = await supabase.rpc("my_build_templates");
  if (templatesError) {
    console.error("price-job: my_build_templates", templatesError.message);
    return json({ error: "Could not load build templates." }, 500);
  }
  const template = ((templatesJson ?? []) as DbBuildTemplateRow[])
    .find((t) => t.sync_id === templateSyncId);
  if (!template) return json({ error: "That template was not found." }, 404);

  const [{ data: catalogData, error: catalogError }, { data: manufacturersData, error: mfrError }] =
    await Promise.all([
      supabase.from("material_items").select(CATALOG_COLUMNS)
        .eq("company_id", companyId).is("deleted_at", null),
      supabase.from("manufacturers").select(MANUFACTURER_COLUMNS)
        .eq("company_id", companyId).is("deleted_at", null),
    ]);
  const loadError = catalogError ?? mfrError;
  if (loadError) {
    console.error("price-job: load sample catalog", loadError.message);
    return json({ error: "Could not load the catalog to price this sample." }, 500);
  }

  const sampleRun = buildSampleRun(template, feet, crypto.randomUUID());
  const input: PricingInput = buildPricingInput({
    job,
    runs: [sampleRun],
    catalog: (catalogData ?? []) as DbMaterialItemRow[],
    manufacturers: (manufacturersData ?? []) as DbManufacturerRow[],
    changeOrders: [],
    existingItems: [],
    engineVersion: PRICING_ENGINE_VERSION,
  });

  try {
    const output = priceJob(input);
    return json({ output });
  } catch (e) {
    console.error("price-job: sample engine", (e as Error).message);
    return json({ error: "Could not price that sample -- the template's spec looks invalid." }, 400);
  }
}
