/**
 * Emails the HOA details to the CUSTOMER, for them to forward.
 *
 * "I also want to send the verbiage to the HOA to the customer's email so the
 *  customer can send it to the HOA with every information needed."
 *
 * TO THE CUSTOMER, not to the association, and that is not a shortcut: an
 * architectural-review request has to come from the homeowner who owns the
 * lot. The contractor has no standing with the HOA, and a packet arriving
 * from a fence company reads as a sales letter. So this sends the homeowner
 * everything a board asks for, formatted to forward or paste into the
 * association's own form.
 *
 * IT MEASURES NOTHING OF ITS OWN. The footage comes from the pricing
 * engine's own linearFeet()/teardownLinearFeet(), called one run at a time,
 * so the letter can never state a length the quote disagrees with. The
 * wording lives in _shared/job-spec.ts, which is pure and tested under Node
 * (tests/job-spec.test.mjs) -- this file is only the impure half: read, send,
 * stamp.
 *
 * WHY THE ENGINE IS NOT RUN IN FULL: priceJob() needs the catalog, the
 * manufacturers, the change orders and the existing line items, none of which
 * a letter cares about. linearFeet(job, [oneRun]) is the engine's own
 * footage, reached without any of that -- and without adding an export to
 * _shared/pricing, which would make price-job stale and drag a redeploy and
 * the parity fixtures into a letter.
 */
import { mailCaller } from "../_shared/mail/caller.ts";
import { MESSAGES, toMailError } from "../_shared/mail/errors.ts";
import { describeJob, hoaLetter } from "../_shared/job-spec.ts";
import { fenceRunRowToInput, jobRowToInput } from "../_shared/pricing/load.ts";
import { jobFromRow, runFromRow } from "../_shared/pricing/index.ts";
import { linearFeet, teardownLinearFeet } from "../_shared/pricing/totals.ts";

const FN = "hoa-letter";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Exactly price-job's list, so the two read the same runs. */
const RUN_COLUMNS =
  "sync_id, label, fence_type, color_or_finish, points_encoded, gates_encoded, " +
  "closed_loop, manual_linear_feet, manual_corner_count, panel_width_ft, panel_height_ft, " +
  "post_spacing_ft, concrete_bags_per_post, aluminum_style, wood_style, wood_rail_count, " +
  "picket_width_in, picket_gap_in, fabric_height_ft, include_top_rail, include_tension_wire, " +
  "include_barbed_wire_arms, include_privacy_slats, split_rail_count, suppressed_roles, " +
  "is_teardown, sort_order, start_joint, end_joint";

function senderWithName(name: string, address: string): string {
  const clean = String(name ?? "").replace(/[\r\n<>"]/g, "").trim().slice(0, 70);
  if (!clean || address.includes("<")) return address;
  return `"${clean}" <${address}>`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only." }, 405);

  // The gate first, and nothing is read before it passes.
  let caller;
  try {
    caller = await mailCaller(req);
  } catch (e) {
    const err = toMailError(e);
    return json({ error: MESSAGES[err.code] ?? err.code, code: err.code }, err.status);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const jobSyncId = String((body as Record<string, unknown>)?.job_sync_id ?? "").trim();
    if (!jobSyncId) return json({ error: "Which job? job_sync_id is required." }, 400);

    // Read as the CALLER, so their own row security decides what they may
    // see. The service-role client exists on `caller` but is used only for
    // the bookkeeping stamp at the end.
    const { data: job, error: jobError } = await caller.userClient
      .from("jobs").select("*")
      .eq("company_id", caller.companyId)
      .eq("sync_id", jobSyncId)
      .is("deleted_at", null)
      .maybeSingle();
    if (jobError) {
      console.error(`${FN}: read job`, jobError.message ?? String(jobError));
      return json({ error: "Could not read that job." }, 500);
    }
    if (!job) return json({ error: "That job is not in this company." }, 404);

    const to = String(job.email ?? "").trim();
    if (!to) {
      // Said plainly, because the fix is on the job and nowhere else.
      return json({ error: "This job has no customer email address to send to." }, 400);
    }

    const { data: runRows, error: runError } = await caller.userClient
      .from("fence_runs").select(RUN_COLUMNS)
      .eq("company_id", caller.companyId)
      .eq("job_sync_id", jobSyncId)
      .is("deleted_at", null)
      .order("sort_order");
    if (runError) {
      console.error(`${FN}: read runs`, runError.message ?? String(runError));
      return json({ error: "Could not read this job's fence runs." }, 500);
    }
    const runs = runRows ?? [];
    if (runs.length === 0) {
      // An HOA packet for a job with nothing drawn would be a letter with no
      // fence in it. Refused rather than sent empty.
      return json({ error: "Nothing is drawn on this job yet, so there is nothing to describe." }, 400);
    }

    // license_no and phone are not on mailCaller's company read, and
    // companies carries PER-COLUMN grants -- these four were confirmed
    // readable by authenticated before this line was written.
    const { data: company, error: companyError } = await caller.userClient
      .from("companies").select("name, license_no, phone, email")
      .eq("id", caller.companyId).maybeSingle();
    if (companyError) {
      console.error(`${FN}: read company`, companyError.message ?? String(companyError));
      return json({ error: "Could not read your company details." }, 500);
    }

    // The engine's own footage, one run at a time. The empty manufacturer set
    // is safe here because it only affects which MATERIALS a run would use,
    // and nothing below prices anything.
    // runFromRow is STRICT: a run whose fence_type this build does not know
    // throws rather than guessing, and so does jobFromRow on the job's own
    // enums. That is right for pricing and it is right here too -- but it
    // must not surface as "something went wrong", because the owner can
    // neither find nor fix that. Such a job cannot be priced either, so the
    // message says which side is unreadable and stops.
    const feetBySyncId: Record<string, number> = {};
    try {
      const engineJob = jobFromRow(jobRowToInput(job as never), new Set<string>());
      runs.forEach((row, i) => {
        const engineRun = runFromRow(fenceRunRowToInput(row as never), i);
        feetBySyncId[String(row.sync_id)] = engineRun.isTeardown
          ? teardownLinearFeet(engineJob, [engineRun])
          : linearFeet(engineJob, [engineRun]);
      });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      console.error(`${FN}: job will not load into the engine`, jobSyncId, why);
      return json({
        error: "One of this job's sides cannot be read by this version, so its " +
          "length cannot be stated. The same thing stops this job pricing.",
        detail: why.slice(0, 200),
      }, 400);
    }

    const spec = describeJob(job as never, runs as never, feetBySyncId);
    const { subject, text, html } = hoaLetter(spec, (company ?? {}) as never);

    const mailKey = Deno.env.get("MAIL_API_KEY");
    const mailFrom = Deno.env.get("MAIL_FROM");
    const mailUrl = Deno.env.get("MAIL_API_URL") ?? "https://api.resend.com/emails";
    if (!mailKey || !mailFrom) {
      return json({ error: "Email is not configured on the server." }, 503);
    }

    // Replies go to the company's own address when it has one. Deliberately
    // NOT the inbound-threading address customerReplyTo() builds: this letter
    // is for the homeowner to forward, and a reply address that routes into
    // the office mail thread would put the association's questions somewhere
    // nobody is watching for them. A reply here should land in the inbox the
    // owner already reads.
    const replyTo = String(company?.email ?? "").trim();

    const res = await fetch(mailUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${mailKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: senderWithName(String(company?.name ?? ""), mailFrom),
        to: [to],
        subject,
        html,
        text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`${FN}: mail provider refused`, res.status, detail.slice(0, 300));
      // The status is reported rather than flattened to a 500: a 422 from the
      // provider is usually a bad recipient address, which the owner can fix,
      // and "something went wrong" would send them looking in the wrong place.
      return json({
        error: res.status === 422
          ? "The mail provider refused that recipient address."
          : "The mail provider would not accept the message.",
        provider_status: res.status,
      }, 502);
    }

    const sent = await res.json().catch(() => ({}));

    // The marker (r54). Quiet in touch_updated_at, so stamping it cannot beat
    // a phone's offline edit of the same job. A failure here is logged, not
    // raised: the email HAS gone, and turning a sent letter into an error
    // would have the owner send it again.
    const { error: stampError } = await caller.admin
      .from("jobs")
      .update({ hoa_letter_sent_at: new Date().toISOString() })
      .eq("company_id", caller.companyId)
      .eq("sync_id", jobSyncId);
    if (stampError) {
      console.error(`${FN}: sent but not stamped`, jobSyncId, stampError.message ?? String(stampError));
    }

    return json({
      sent: true,
      to,
      message_id: sent?.id ? String(sent.id) : null,
      // Handy for the caller to show without a second round trip.
      total_feet: spec.totalFeet,
      sections: spec.sides.length,
      gates: spec.gates.length,
      stamped: !stampError,
    });
  } catch (e) {
    const err = toMailError(e);
    console.error(`${FN}: unexpected`, err.code, err.detail);
    return json({ error: MESSAGES[err.code] ?? err.code, code: err.code }, err.status);
  }
});
