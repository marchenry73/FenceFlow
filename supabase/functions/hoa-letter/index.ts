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
 * IT MEASURES NOTHING OF ITS OWN, AND IT DOES NOT BUNDLE THE ENGINE.
 *
 * The figures come from price-job itself, called in dry_run mode with the
 * caller's own token, and read off output.runs: gross_feet, gate_count and
 * gate_feet per run. dry_run writes nothing.
 *
 * The first version of this function imported the shared pricing module
 * directly to reach linearFeet(). tests/a94 refused the deploy, and it was
 * right to: exactly ONE function may bundle the engine, because two copies
 * can be deployed at different versions and then the office quotes a
 * different number from the phone -- the precise bug this project keeps
 * fighting. The figures still come from the one engine; they now arrive over
 * HTTP from the one function that owns it.
 *
 * (That check is a substring scan of this file, so even naming the import
 * path in a comment fails it, which is why this paragraph talks around it.)
 *
 * The wording lives in _shared/job-spec.ts, which is pure, imports nothing
 * from the engine, and is tested under Node (tests/job-spec.test.mjs). This
 * file is only the impure half: read, ask, send, stamp.
 */
import { mailCaller } from "../_shared/mail/caller.ts";
import { MESSAGES, toMailError } from "../_shared/mail/errors.ts";
import { describeJob, hoaLetter, RunMeasurement } from "../_shared/job-spec.ts";

const FN = "hoa-letter";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Only what the WORDS need. The measuring is price-job's job, so none of the
 * geometry columns are read here -- no points, no gate encoding, no
 * calibration. If this list and price-job's ever had to agree, that would be
 * a sign the measuring had crept back in.
 */
const RUN_COLUMNS =
  "sync_id, label, fence_type, color_or_finish, panel_height_ft, " +
  "post_spacing_ft, concrete_bags_per_post, is_teardown, sort_order";

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
    /* THE FIGURES COME FROM price-job, in dry_run, with the caller's own
       token forwarded. dry_run writes nothing (see price-job's header).

       The caller's token and not a service key: price-job then applies the
       same pricing permission it always does, so somebody who may not see
       pricing cannot get a specification out through this door instead. */
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    if (!supabaseUrl) return json({ error: "Server is not configured." }, 503);

    let measured: Record<string, RunMeasurement> = {};
    try {
      const priced = await fetch(`${supabaseUrl}/functions/v1/price-job`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: req.headers.get("Authorization") ?? "",
          apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
        },
        body: JSON.stringify({ job_sync_id: jobSyncId, mode: "dry_run" }),
        signal: AbortSignal.timeout(25_000),
      });
      const pricedBody = await priced.json().catch(() => ({}));
      if (!priced.ok) {
        // price-job's own sentence, passed through: it distinguishes "no
        // permission to see pricing" from "this job's fence data is invalid",
        // and both are things the owner can act on. A generic failure here
        // would send them looking in the wrong place.
        console.error(`${FN}: price-job refused`, priced.status, JSON.stringify(pricedBody).slice(0, 200));
        return json({
          error: pricedBody?.error ??
            "The job could not be measured, so the letter was not sent.",
          priced_status: priced.status,
        }, priced.status === 403 ? 403 : 400);
      }
      const runsOut = Array.isArray(pricedBody?.output?.runs) ? pricedBody.output.runs : [];
      if (runsOut.length === 0) {
        // Measured nothing, so every length would print as 0 ft. Refused
        // rather than sent as a specification full of zeroes.
        return json({ error: "This job measured as nothing, so there is no specification to send." }, 400);
      }
      for (const r of runsOut) {
        measured[String(r.run_sync_id)] = {
          feet: Number(r.gross_feet) || 0,
          gateCount: Number(r.gate_count) || 0,
          gateFeet: Number(r.gate_feet) || 0,
        };
      }
    } catch (e) {
      console.error(`${FN}: could not reach price-job`, String(e));
      return json({ error: "Could not measure the job just now. Nothing was sent." }, 502);
    }

    const spec = describeJob(job as never, runs as never, measured);
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
      gates: spec.gates.count,
      stamped: !stampError,
    });
  } catch (e) {
    const err = toMailError(e);
    console.error(`${FN}: unexpected`, err.code, err.detail);
    return json({ error: MESSAGES[err.code] ?? err.code, code: err.code }, err.status);
  }
});
