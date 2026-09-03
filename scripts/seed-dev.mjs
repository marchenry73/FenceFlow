#!/usr/bin/env node
/**
 * Fills the dev project with one synthetic fencing company.
 *
 * Production data is never copied down. Real customers' names, addresses,
 * phone numbers and money do not belong in a database that exists to be broken
 * on purpose -- and dev is exactly where a stray "send" or a test Stripe
 * webhook would reach them. So dev gets invented people instead.
 *
 * What it makes: a company on the Pro plan, an owner, a foreman and a crew
 * member, three customers, and four jobs spread across the statuses that make
 * the rest of the product show something -- a quote waiting to be viewed, work
 * on the calendar, a job in progress with shifts and a deposit, and a finished
 * one paid in full. Fence runs carry real drawn geometry with gates, so the
 * takeoff, the estimate, the PDF and the 3D quote page all have something to
 * render.
 *
 * Usage (PowerShell):
 *   $env:SUPABASE_DEV_URL = "https://<dev-ref>.supabase.co"
 *   $env:SUPABASE_DEV_SERVICE_KEY = "<the dev project's service_role key>"
 *   $env:DEV_SEED_PASSWORD = "<a password you pick for the three test logins>"
 *   node scripts/seed-dev.mjs
 *
 * The service key is read from the environment and never written anywhere.
 * There is no default password on purpose: a default in a public repository is
 * a published password.
 *
 * Safe to re-run: it deletes its own company first, then rebuilds it. It
 * deletes nothing it did not create, and refuses to run against production.
 */

const PROD_REF = "newcrgafcptspmapacrx";

const URL_BASE = (process.env.SUPABASE_DEV_URL ?? "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_DEV_SERVICE_KEY ?? "";
const PASSWORD = process.env.DEV_SEED_PASSWORD ?? "";

function fail(message) { console.error(`\n${message}\n`); process.exit(1); }

if (!URL_BASE) fail("SUPABASE_DEV_URL is not set.");
if (!SERVICE_KEY) fail("SUPABASE_DEV_SERVICE_KEY is not set.");
if (!PASSWORD) {
  fail("DEV_SEED_PASSWORD is not set.\n" +
       "Pick one for the three synthetic logins. It is not stored in the repo.");
}
// The one check that matters. Everything below deletes before it inserts.
if (URL_BASE.includes(PROD_REF)) {
  fail(`SUPABASE_DEV_URL points at ${PROD_REF}, which is production.\n` +
       "This script deletes rows before writing them. Not there. Never there.");
}

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

/** One PostgREST call. Throws with the server's own words, which are usually right. */
async function rest(path, method = "GET", body, extraHeaders = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: { ...headers, Prefer: "return=minimal", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  }
  return res.status === 204 ? null : await res.json().catch(() => null);
}

async function auth(path, method = "GET", body) {
  const res = await fetch(`${URL_BASE}/auth/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`${method} auth/${path} -> ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

// Fixed ids, so re-running replaces the same rows instead of piling up copies.
const CO = "d0000000-0000-4000-8000-000000000001";
const uid = {
  owner: "d0000000-0000-4000-8000-00000000a001",
  foreman: "d0000000-0000-4000-8000-00000000a002",
  crew: "d0000000-0000-4000-8000-00000000a003",
};
const cust = {
  reyes: "d0000000-0000-4000-8000-00000000c001",
  okafor: "d0000000-0000-4000-8000-00000000c002",
  lindqvist: "d0000000-0000-4000-8000-00000000c003",
};
const job = {
  quote: "d0000000-0000-4000-8000-00000000j001",
  scheduled: "d0000000-0000-4000-8000-00000000j002",
  running: "d0000000-0000-4000-8000-00000000j003",
  done: "d0000000-0000-4000-8000-00000000j004",
};
const emp = {
  foreman: "d0000000-0000-4000-8000-00000000e001",
  crew: "d0000000-0000-4000-8000-00000000e002",
};

const DAY = 86400000;
const now = Date.now();
const at = days => new Date(now + days * DAY).toISOString();
const clockAt = (dayOffset, hour) => {
  const d = new Date(now + dayOffset * DAY);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

/**
 * Points are "x:y" pairs and gates are "x:y:width:mounting:swing", exactly as
 * FenceCodec writes them. Twenty units to the foot -- PIXELS_PER_FOOT_GRID,
 * the scale a drawing gets when nobody has calibrated against a photo. Every
 * job below sets calibration_pixels_per_foot to 20 to match, so the lengths
 * the estimate reports are the lengths intended here.
 */
const FT = 20;
const pt = (xFt, yFt) => `${xFt * FT}:${yFt * FT}`;
const line = (...pairs) => pairs.join(",");
const gate = (xFt, yFt, widthFt, mounting = "LINE", swing = "IN") =>
  `${xFt * FT}:${yFt * FT}:${widthFt}:${mounting}:${swing}`;

async function ensureUser(id, email, fullName) {
  // Deleted first so a re-run cannot collide with a leftover account whose id
  // no longer matches the profile pointing at it.
  await auth(`admin/users/${id}`, "DELETE").catch(() => {});
  const created = await auth("admin/users", "POST", {
    id,
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  return created?.id ?? id;
}

/** Removes only this seed's company. Nothing else in the project is touched. */
async function wipe() {
  const byCompany = [
    "time_entries", "payment_records", "job_payments", "estimate_line_items",
    "job_steps", "punch_list_items", "site_markers", "field_changes",
    "change_orders", "fence_runs", "expenses", "audit_log", "jobs",
    "customers", "employees", "material_items", "manufacturers",
    "pricing_tiers", "company_setup_codes", "payment_connections",
    "company_settings",
  ];
  for (const table of byCompany) {
    await rest(`${table}?company_id=eq.${CO}`, "DELETE").catch(e =>
      console.log(`  (skip ${table}: ${e.message.slice(0, 120)})`));
  }
  for (const id of Object.values(uid)) {
    await rest(`profiles?id=eq.${id}`, "DELETE").catch(() => {});
  }
  await rest(`companies?id=eq.${CO}`, "DELETE").catch(() => {});
}

async function main() {
  console.log(`Seeding ${URL_BASE}\n`);

  console.log("Clearing any previous seed...");
  await wipe();

  console.log("Creating the three logins...");
  await ensureUser(uid.owner, "owner@fenceflow.dev", "Dana Whitfield");
  await ensureUser(uid.foreman, "foreman@fenceflow.dev", "Marcus Bell");
  await ensureUser(uid.crew, "crew@fenceflow.dev", "Tomas Ruiz");

  console.log("Company...");
  await rest("companies", "POST", [{
    id: CO,
    name: "Palmetto Fence Co. (DEV)",
    email: "office@palmetto-dev.test",
    phone: "(813) 555-0142",
    billing_email: "billing@palmetto-dev.test",
    license_no: "DEV-FL-000000",
    subscription_plan: "PRO",
    subscription_status: "active",
    monthly_price: 149.0,
    trial_ends_at: at(30),
    subscription_ends_at: at(30),
    joined_at: at(-120),
    details_completed_at: at(-119),
    agreement_signed_at: at(-120),
    agreement_signed_name: "Dana Whitfield",
    agreement_version: "dev-seed",
    suspended: false,
  }]);

  await rest("company_settings", "POST", [{ company_id: CO, settings: {} }]);

  console.log("People...");
  await rest("profiles", "POST", [
    { id: uid.owner, company_id: CO, full_name: "Dana Whitfield", role: "OWNER" },
    { id: uid.foreman, company_id: CO, full_name: "Marcus Bell", role: "FOREMAN" },
    { id: uid.crew, company_id: CO, full_name: "Tomas Ruiz", role: "CREW" },
  ]);

  await rest("employees", "POST", [
    {
      id: emp.foreman, sync_id: emp.foreman, company_id: CO, profile_id: uid.foreman,
      name: "Marcus Bell", role: "FOREMAN", email: "foreman@fenceflow.dev",
      phone: "(813) 555-0188", pay_type: "HOURLY", hourly_rate: 32.0, is_active: true,
    },
    {
      id: emp.crew, sync_id: emp.crew, company_id: CO, profile_id: uid.crew,
      name: "Tomas Ruiz", role: "CREW", email: "crew@fenceflow.dev",
      phone: "(813) 555-0190", pay_type: "HOURLY", hourly_rate: 24.0, is_active: true,
    },
  ]);

  console.log("Customers...");
  await rest("customers", "POST", [
    {
      id: cust.reyes, sync_id: cust.reyes, company_id: CO, name: "Alicia Reyes",
      address: "1841 Bloomingdale Ave, Valrico, FL 33596",
      phone: "(813) 555-0201", email: "alicia.reyes@example.test",
      notes: "Wants the gate on the driveway side.",
    },
    {
      id: cust.okafor, sync_id: cust.okafor, company_id: CO, name: "Ben Okafor",
      address: "410 Symmes Rd, Riverview, FL 33578",
      phone: "(813) 555-0202", email: "ben.okafor@example.test",
      notes: "Dogs on site -- call before arriving.",
    },
    {
      id: cust.lindqvist, sync_id: cust.lindqvist, company_id: CO, name: "Nina Lindqvist",
      address: "7702 US-41, Gibsonton, FL 33534",
      phone: "(813) 555-0203", email: "nina.l@example.test", notes: "",
    },
  ]);

  console.log("Jobs...");
  const common = {
    company_id: CO, grid_extent_ft: 400, calibration_pixels_per_foot: FT,
    tax_rate_percent: 7.5, waste_percent: 5, markup_percent: 18,
    labor_rate_per_ft: 12.0, estimated_duration_hours: 8,
  };

  await rest("jobs", "POST", [
    {
      ...common, id: job.quote, sync_id: job.quote, customer_id: cust.reyes,
      customer_name: "Alicia Reyes", address: "1841 Bloomingdale Ave, Valrico, FL 33596",
      phone: "(813) 555-0201", email: "alicia.reyes@example.test",
      status: "SENT", payment_status: "UNPAID",
      quote_sent_at: at(-2), notes: "200 ft vinyl privacy, two gates.",
      deposit_amount: 1200, referral_source: "Google",
    },
    {
      ...common, id: job.scheduled, sync_id: job.scheduled, customer_id: cust.okafor,
      customer_name: "Ben Okafor", address: "410 Symmes Rd, Riverview, FL 33578",
      phone: "(813) 555-0202", email: "ben.okafor@example.test",
      status: "ACCEPTED", payment_status: "DEPOSIT_PAID",
      scheduled_date: at(4), quote_sent_at: at(-12), quote_approved_at: at(-9),
      quote_approved_name: "Ben Okafor", signed_at: at(-9),
      deposit_amount: 900, amount_paid: 900,
      notes: "Chain link, back three sides. Dogs on site.",
    },
    {
      ...common, id: job.running, sync_id: job.running, customer_id: cust.lindqvist,
      customer_name: "Nina Lindqvist", address: "7702 US-41, Gibsonton, FL 33534",
      phone: "(813) 555-0203", email: "nina.l@example.test",
      status: "ACCEPTED", payment_status: "DEPOSIT_PAID",
      scheduled_date: at(-1), quote_sent_at: at(-20), quote_approved_at: at(-15),
      quote_approved_name: "Nina Lindqvist", signed_at: at(-15),
      deposit_amount: 1500, amount_paid: 1500,
      assigned_employee_id: emp.foreman, assigned_employee_sync_id: emp.foreman,
      teardown_enabled: true, teardown_feet: 60, teardown_rate_per_ft: 4.0,
      notes: "Tear out the old wood before the aluminium goes in.",
    },
    {
      ...common, id: job.done, sync_id: job.done, customer_id: cust.reyes,
      customer_name: "Alicia Reyes", address: "1841 Bloomingdale Ave, Valrico, FL 33596",
      phone: "(813) 555-0201", email: "alicia.reyes@example.test",
      status: "COMPLETED", payment_status: "PAID_IN_FULL", is_invoiced: true,
      scheduled_date: at(-30), quote_sent_at: at(-45), quote_approved_at: at(-40),
      quote_approved_name: "Alicia Reyes", signed_at: at(-40),
      final_sign_off_at: at(-29), deposit_amount: 800, amount_paid: 3260,
      assigned_employee_id: emp.foreman, assigned_employee_sync_id: emp.foreman,
      notes: "Side yard run. Finished and signed off.",
    },
  ]);

  console.log("Fence runs (with gates)...");
  const run = (id, jobId, over) => ({
    id, sync_id: id, company_id: CO, job_sync_id: jobId,
    points_encoded: "", gates_encoded: "", closed_loop: false, sort_order: 0, ...over,
  });

  await rest("fence_runs", "POST", [
    // 60 + 80 + 60 = 200 ft, a walk gate and a double gate on the long side.
    run("d0000000-0000-4000-8000-00000000f001", job.quote, {
      label: "Back yard", fence_type: "VINYL", wood_style: "PRIVACY",
      panel_height_ft: 6, panel_width_ft: 8, post_spacing_ft: 8,
      points_encoded: line(pt(0, 0), pt(0, 60), pt(80, 60), pt(80, 0)),
      gates_encoded: [gate(40, 60, 4), gate(60, 60, 10, "LINE", "BOTH")].join(","),
    }),
    // 50 + 90 + 50 = 190 ft of 4 ft chain link, one walk gate.
    run("d0000000-0000-4000-8000-00000000f002", job.scheduled, {
      label: "Rear boundary", fence_type: "CHAIN_LINK", fabric_height_ft: 4,
      post_spacing_ft: 10, include_top_rail: true, include_tension_wire: true,
      points_encoded: line(pt(0, 0), pt(0, 50), pt(90, 50), pt(90, 0)),
      gates_encoded: gate(45, 50, 4),
    }),
    // The old fence coming out, billed as teardown rather than as new fence.
    run("d0000000-0000-4000-8000-00000000f003", job.running, {
      label: "Old wood (teardown)", fence_type: "WOOD", is_teardown: true,
      panel_height_ft: 6, sort_order: 0,
      points_encoded: line(pt(0, 0), pt(60, 0)),
    }),
    run("d0000000-0000-4000-8000-00000000f004", job.running, {
      label: "New aluminium", fence_type: "ALUMINUM", aluminum_style: "RACKABLE",
      panel_height_ft: 5, panel_width_ft: 6, post_spacing_ft: 6, sort_order: 1,
      points_encoded: line(pt(0, 0), pt(60, 0), pt(60, 45)),
      gates_encoded: gate(60, 20, 4, "LINE", "OUT"),
    }),
    run("d0000000-0000-4000-8000-00000000f005", job.done, {
      label: "Side yard", fence_type: "WOOD", wood_style: "PRIVACY",
      panel_height_ft: 6, panel_width_ft: 8, post_spacing_ft: 8,
      points_encoded: line(pt(0, 0), pt(0, 70), pt(35, 70)),
      gates_encoded: gate(0, 35, 4, "WALL", "IN"),
    }),
  ]);

  console.log("Estimate lines, checklists, shifts, payments...");
  const li = (id, jobId, description, qty, unit, price, sort) => ({
    id, sync_id: id, company_id: CO, job_sync_id: jobId, description,
    quantity: qty, unit, unit_price: price, sort_order: sort,
    auto_generated: true, taxable: true,
  });
  await rest("estimate_line_items", "POST", [
    li("d0000000-0000-4000-8000-0000000000b1", job.quote, "Vinyl privacy panel 6x8", 25, "EA", 92.0, 0),
    li("d0000000-0000-4000-8000-0000000000b2", job.quote, "Line post 5x5x8", 24, "EA", 28.5, 1),
    li("d0000000-0000-4000-8000-0000000000b3", job.quote, "Concrete 50lb", 52, "BAG", 6.25, 2),
    li("d0000000-0000-4000-8000-0000000000b4", job.quote, "Walk gate 4ft", 1, "EA", 310.0, 3),
    li("d0000000-0000-4000-8000-0000000000b5", job.quote, "Double drive gate 10ft", 1, "EA", 860.0, 4),
    li("d0000000-0000-4000-8000-0000000000b6", job.done, "Wood privacy panel 6x8", 9, "EA", 78.0, 0),
    li("d0000000-0000-4000-8000-0000000000b7", job.done, "Post 4x4x8 PT", 10, "EA", 14.75, 1),
  ]);

  const step = (id, jobId, description, sort, checked) => ({
    id, sync_id: id, company_id: CO, job_sync_id: jobId, description,
    kind: "INSTALL", sort_order: sort, checked,
    completed_at: checked ? at(-1) : null,
  });
  await rest("job_steps", "POST", [
    step("d0000000-0000-4000-8000-0000000000d1", job.running, "Call 811 and confirm locates", 0, true),
    step("d0000000-0000-4000-8000-0000000000d2", job.running, "Tear out old wood fence", 1, true),
    step("d0000000-0000-4000-8000-0000000000d3", job.running, "Set posts", 2, false),
    step("d0000000-0000-4000-8000-0000000000d4", job.running, "Hang panels and gate", 3, false),
    step("d0000000-0000-4000-8000-0000000000d5", job.scheduled, "Confirm dogs are inside", 0, false),
  ]);

  const shift = (id, jobId, employeeId, rate, dayOffset, from, to) => ({
    id, sync_id: id, company_id: CO, job_sync_id: jobId,
    employee_id: employeeId, employee_sync_id: employeeId, hourly_rate: rate,
    started_at: clockAt(dayOffset, from), ended_at: clockAt(dayOffset, to),
    approved_at: dayOffset <= -2 ? at(-1) : null,
    approved_by: dayOffset <= -2 ? "Dana Whitfield" : "",
  });
  await rest("time_entries", "POST", [
    shift("d0000000-0000-4000-8000-0000000000e1", job.running, emp.foreman, 32.0, -2, 7, 15),
    shift("d0000000-0000-4000-8000-0000000000e2", job.running, emp.crew, 24.0, -2, 7, 15),
    shift("d0000000-0000-4000-8000-0000000000e3", job.running, emp.foreman, 32.0, -1, 7, 16),
    shift("d0000000-0000-4000-8000-0000000000e4", job.running, emp.crew, 24.0, -1, 7, 16),
    shift("d0000000-0000-4000-8000-0000000000e5", job.done, emp.foreman, 32.0, -30, 8, 14),
  ]);

  const paid = (id, jobId, amount, method, whenDays, reference) => ({
    id, sync_id: id, company_id: CO, job_sync_id: jobId, amount, method,
    received_at: at(whenDays), recorded_by: "Dana Whitfield", reference,
  });
  await rest("payment_records", "POST", [
    paid("d0000000-0000-4000-8000-0000000000f1", job.scheduled, 900.0, "CARD", -9, "dev-seed"),
    paid("d0000000-0000-4000-8000-0000000000f2", job.running, 1500.0, "CHECK", -15, "ck 2041"),
    paid("d0000000-0000-4000-8000-0000000000f3", job.done, 800.0, "CARD", -40, "deposit"),
    paid("d0000000-0000-4000-8000-0000000000f4", job.done, 2460.0, "BANK_TRANSFER", -28, "final"),
  ]);

  // A processor-side row, so the billing screens have something that did not
  // come from somebody typing it in. Test mode, never live.
  await rest("job_payments", "POST", [{
    id: "d0000000-0000-4000-8000-000000000091", company_id: CO,
    job_sync_id: job.scheduled, amount_cents: 90000, currency: "usd",
    kind: "deposit", processor: "stripe", status: "paid", livemode: false,
    paid_at: at(-9), external_id: "dev_seed_pi_0001",
  }]);

  console.log("\nSeeded.");
  console.log("  Company : Palmetto Fence Co. (DEV)");
  console.log("  Owner   : owner@fenceflow.dev");
  console.log("  Foreman : foreman@fenceflow.dev");
  console.log("  Crew    : crew@fenceflow.dev");
  console.log("  Password: the DEV_SEED_PASSWORD you set for this run");
  console.log("\n  4 jobs, 5 fence runs with gates, 5 shifts, 4 payments.");
}

main().catch(e => {
  console.error(`\nSeeding stopped: ${e.message}`);
  console.error("Nothing was half-written that a re-run will not replace.");
  process.exit(1);
});
