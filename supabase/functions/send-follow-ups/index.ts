// Sales follow-up automation -- the part that acts.
//
// Companies with configurable settings, off by default (follow_up_settings,
// supabase_followups_settings.sql). This function finds jobs whose real
// timestamps (quote_sent_at, quote_viewed_at, quote_approved_at,
// first_contact_at) mean a follow-up is due, and emails the customer --
// via Resend, from the COMPANY's own name, same sender pattern as
// invite-crew (`senderWithName`), reply-to the COMPANY's own address --
// resolved by _shared/mail/customer-reply.ts, not read straight out of
// companies.email: its FenceFlow routing address when receiving is proven,
// else companies.email, else this company is skipped for the run (see
// "no reply address" below). A nudge whose answer reaches FenceFlow's own
// mailbox instead of the company is not a nudge worth sending.
//
// RUNBOOK -- how this gets invoked. There is no pg_cron in this project
// (checked: `select extname from pg_extension` on 2026-09-17 lists pg_net
// but not pg_cron). So this is NOT wired to any schedule yet -- see the
// "SCHEDULING" comment near the bottom of this file for what to set up
// when the owner is ready to turn it on for real. Nothing in this repo
// currently calls this function automatically.
//
// Safety rules, each with a reason a mistake here would be expensive:
//   - service role only, one door: NOTIFY-style shared-secret header
//     (`x-fenceflow-trigger`), same constant-time compare as
//     notify-job-change, because this function can email every customer of
//     every company and must not be reachable by a guessed URL.
//   - per-company settings + global `enabled` switch, both re-checked here,
//     never trusted from a cached/earlier read.
//   - quiet hours: a job otherwise due during quiet hours is skipped this
//     run, not dropped -- it is picked up the next run once quiet hours end.
//   - hard daily cap per company, counted from follow_up_log itself (the
//     log IS the count), so the cap cannot drift from what was actually sent.
//   - never a job.is_test_fixture=true job (office and phone hide these;
//     emailing one would be emailing a fictional customer or, worse, a real
//     inbox somebody reused for a fixture).
//   - never a suspended/expired company (company_allowed RPC) -- a company
//     that has stopped paying does not get FenceFlow spending its Resend
//     quota on their behalf.
//   - never an opted-out job (jobs.opted_out_at).
//   - the log row is claimed (`insert ... on conflict do nothing`) BEFORE
//     the email is sent, exactly the automation_runs / follow_up_log
//     pattern documented in supabase_followups_log.sql -- a crash after the
//     claim and before the send fails toward "logged, maybe not sent"
//     rather than "sent twice", the safer direction for a sales nudge.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import {
  DEFAULT_SETTINGS,
  FollowUpJob,
  FollowUpSettings,
  approximateUtcOffsetHours,
  dueFollowUp,
  isQuietHour,
} from "../_shared/follow-up-logic.ts";
import { customerReplyTo } from "../_shared/mail/customer-reply.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Constant-time compare -- same reasoning as notify-job-change/index.ts:
 *  `a === b` on a secret leaks timing on the first mismatched character. */
function secretMatches(supplied: string | null, expected: string): boolean {
  if (!supplied || supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** "Acme Fence <noreply@x>" -- copied verbatim from invite-crew/index.ts so
 *  the two functions cannot drift on how a company's display name is
 *  sanitized before going into a From header. */
function senderWithName(name: string, address: string): string {
  const clean = name.replace(/[\r\n<>"]/g, "").trim().slice(0, 70);
  if (!clean || address.includes("<")) return address;
  return `"${clean}" <${address}>`;
}

const escapeHtml = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Resend's default limit is 2 requests a second per account. This loop used
// to send as fast as the round trips allowed, so any run with more than a
// couple of due follow-ups met 429s -- and each refused one kept its claimed
// follow_up_log row, which meant it was never tried again and never sent.
const MIN_SEND_GAP_MS = 550;

// Supabase answers 504 for any function that has not responded within 150 s
// (its request idle timeout), and the workflow reads that as a failed run.
// Paced as above, a backlog -- up to daily_cap (25) per enabled company --
// can take longer than that. So the run stops claiming new sends once this
// much time has gone and returns normally; nothing unsent was claimed, so
// whatever is left is still due, and the next hourly run sends it.
const RUN_BUDGET_MS = 100_000;
// And no single send may eat the margin: an unanswered request is abandoned
// after this long and handled like any other "could not reach" (claim kept).
// Worst case after the last budget check is two of these plus the 429 wait,
// about 37 s, which still answers inside the 150 s.
const SEND_TIMEOUT_MS = 15_000;

/**
 * What a refusal from the mail provider means for the claimed log row.
 *
 *   release  -- the provider certainly did not send it (bad key, unverified
 *               domain, rate limit or quota). The claim is deleted so the
 *               next run tries again once the cause is fixed, and the run
 *               stops sending: every further attempt would fail the same way.
 *   keep     -- a problem with this one message (a malformed address). The
 *               claim stays, so a bad address is not retried every hour.
 *   unknown  -- the provider may or may not have sent it (5xx). The claim
 *               stays -- "logged, maybe not sent" beats "sent twice", the
 *               rule this file already follows for a crash mid-send -- and
 *               the run stops, because the provider is not answering sanely.
 *
 * Everything but "keep" is a real failure of the scheduler, reported with an
 * `error` in the response so the workflow run fails and somebody hears of it.
 * A refused send used to be logged to the console and nowhere else: the run
 * went green while nothing was going out.
 */
function refusalKind(status: number): "release" | "keep" | "unknown" {
  if (status === 401 || status === 403 || status === 429) return "release";
  if (status >= 500) return "unknown";
  return "keep";
}

/**
 * The UTC instant at which the COMPANY's own day started.
 *
 * `offsetHours` is the same fixed offset isQuietHour is given, so the daily
 * cap's day and the quiet window are cut by one clock. They used not to be:
 * the cap counted from UTC midnight while quiet hours ran on
 * settings.timezone, which hands every company away from Greenwich a stretch
 * of its own evening in which the cap quietly starts again.
 */
function localDayStartUtc(now: Date, offsetHours: number): string {
  const local = new Date(now.getTime() + offsetHours * 3600_000);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - offsetHours * 3600_000).toISOString();
}

/**
 * Reads every row, not the first thousand.
 *
 * PostgREST answers at most 1000 rows per request and does not say that it
 * did: error is null and the Content-Range header reads `0-999/*`, the star
 * meaning the total is unknown. So a read that takes what came back cannot
 * tell a complete answer from a truncated one -- and the candidate-jobs read
 * below was taking what came back, which means a company past a thousand
 * eligible jobs lost an arbitrary remainder of its customers from every run,
 * for ever, with nothing anywhere saying so.
 *
 * Same recipe as website/dashboard.html's pagedRows(), deliberately: order by
 * `id` so pages neither overlap nor skip, a short page means the end, a full
 * page means ask again, and fifty pages is a runaway guard rather than a
 * limit anybody should reach.
 *
 * `build` is called ONCE PER PAGE and must return a fresh query builder:
 * postgrest builders accumulate, so reusing one would stack the ranges.
 */
// deno-lint-ignore no-explicit-any
async function pagedRows<T>(build: () => any): Promise<{ data: T[]; error: any }> {
  const PAGE = 1000;
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = await build().order("id", { ascending: true }).range(from, from + PAGE - 1);
    // Handed back with whatever was already gathered, and with the error, so
    // a caller cannot mistake a failed read for an empty table.
    if (res.error) return { data: all, error: res.error };
    const got = (res.data ?? []) as T[];
    all.push(...got);
    if (got.length < PAGE) break;
    if (all.length >= PAGE * 50) {
      console.error("send-follow-ups: pagedRows stopped at " + all.length + " rows");
      break;
    }
  }
  return { data: all, error: null };
}

const SUBJECT: Record<string, string> = {
  new_lead_not_contacted: "Following up on your fence quote request",
  quote_sent_no_view: "Your fence quote is ready",
  quote_viewed_not_approved: "Still thinking it over?",
  approved_no_deposit: "One more step to get your fence scheduled",
};

function buildEmail(
  kind: string,
  job: { customer_name?: string | null },
  companyName: string,
  quoteUrl: string | null,
  /**
   * A signed https URL for the company's logo, or null. The HTML part gets it
   * as a letterhead; the plain-text part is untouched, so a text-only reader
   * sees the letter and not a line of URL. The alt text is the company name,
   * because most mail clients block remote images by default and the name is
   * what should appear in its place.
   */
  logoUrl: string | null = null,
): { subject: string; html: string; text: string } {
  const name = (job.customer_name || "").trim().split(" ")[0] || "there";
  const company = companyName || "your fence contractor";
  const subject = SUBJECT[kind] ?? "Following up";

  const lines: Record<string, string> = {
    new_lead_not_contacted:
      `Hi ${name}, thanks for reaching out to ${company} about a fence. ` +
      `We wanted to make sure your request didn't slip through the cracks -- ` +
      `someone will be in touch shortly, or feel free to call us directly.`,
    quote_sent_no_view:
      `Hi ${name}, ${company} sent you a fence quote and wanted to check ` +
      `you received it. You can view the full details and photos any time ` +
      `using the link below.`,
    quote_viewed_not_approved:
      `Hi ${name}, thanks for taking a look at the fence quote from ${company}. ` +
      `Let us know if you have any questions -- we're happy to walk through ` +
      `it with you. You can review and approve it any time below.`,
    approved_no_deposit:
      `Hi ${name}, thanks for approving your fence quote with ${company}! ` +
      `To get your job on the schedule, the next step is the deposit -- you ` +
      `can take care of that using the link below.`,
  };
  const body = lines[kind] ?? lines.quote_sent_no_view;

  const linkHtml = quoteUrl
    ? `<p><a href="${escapeHtml(quoteUrl)}" style="display:inline-block;background:#FF5A1F;color:#fff;` +
      `text-decoration:none;font-weight:700;padding:10px 18px;border-radius:8px">View your quote</a></p>` +
      `<p style="font-size:12px;color:#8A93A0;word-break:break-all">Or paste this into your browser: ${escapeHtml(quoteUrl)}</p>`
    : "";
  const linkText = quoteUrl ? `\nView your quote: ${quoteUrl}\n` : "";

  const html =
    `<!doctype html><html><body style="margin:0;background:#F7F8FA;font-family:-apple-system,` +
    `BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#12151A">` +
    `<div style="max-width:34rem;margin:0 auto;padding:28px 20px">` +
    `<div style="background:#fff;border:1px solid #E3E7ED;border-radius:12px;padding:26px">` +
    (logoUrl
      ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(companyName || "")}" ` +
        `style="display:block;max-height:52px;max-width:200px;width:auto;border:0;margin:0 0 16px">`
      : "") +
    `<p>${escapeHtml(body)}</p>${linkHtml}` +
    `<p style="font-size:12px;color:#8A93A0;margin-top:20px">` +
    `If you'd rather not receive these, just reply and let us know.</p>` +
    `</div></div></body></html>`;
  const text = `${body}${linkText}\n\nIf you'd rather not receive these, just reply and let us know.`;

  return { subject, html, text };
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  try {
    // Its OWN secret first, NOTIFY_TRIGGER_SECRET only as a fallback.
    //
    // The GitHub Action sends secrets.FOLLOWUPS_TRIGGER_SECRET, and this
    // function used to compare it against NOTIFY_TRIGGER_SECRET -- a value
    // four other functions also read (attention-sweep, notify-job-change,
    // quote-approval-email, quote-view). Matching them up meant either
    // knowing that shared value to paste into GitHub, or rotating it for all
    // five. Neither happened, so the scheduler was never switched on and
    // nothing was sent to any customer, ever: the hourly run exited green
    // with "not configured" and said so to nobody.
    //
    // Now the scheduler has a secret of its own, set on both sides on
    // 19 October 2026. The fallback keeps an older deployment working if the
    // new one is ever missing.
    const expected = Deno.env.get("FOLLOWUPS_TRIGGER_SECRET")
      ?? Deno.env.get("NOTIFY_TRIGGER_SECRET");
    if (!expected) {
      console.error("send-follow-ups: neither FOLLOWUPS_TRIGGER_SECRET nor NOTIFY_TRIGGER_SECRET is set; refusing to run.");
      return json({ error: "not configured" }, 503);
    }
    if (!secretMatches(req.headers.get("x-fenceflow-trigger"), expected)) {
      return json({ error: "unauthorized" }, 401);
    }

    const mailKey = Deno.env.get("MAIL_API_KEY");
    const mailFrom = Deno.env.get("MAIL_FROM");
    const mailUrl = Deno.env.get("MAIL_API_URL") ?? "https://api.resend.com/emails";
    const siteUrl = Deno.env.get("SITE_URL") ?? "https://fenceflowapp.com";
    if (!mailKey || !mailFrom) {
      console.error("send-follow-ups: MAIL_API_KEY/MAIL_FROM not set; refusing to run.");
      return json({ error: "mail not configured" }, 503);
    }

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: settingsRows, error: settingsErr } = await db
      .from("follow_up_settings")
      .select("*")
      .eq("enabled", true);
    if (settingsErr) {
      console.error("send-follow-ups: load settings", settingsErr.message);
      return json({ error: "could not load settings" }, 500);
    }

    const now = new Date();
    const results: Record<string, unknown>[] = [];
    // Scheduler-level failures (see refusalKind). Any entry here turns the
    // response into an error, and stops further sending for this run.
    const mailErrors: string[] = [];
    let lastSendAt = 0;
    // Set once RUN_BUDGET_MS is used up; checked before any new claim.
    let outOfTime = false;
    const timeLeft = () => {
      if (!outOfTime && Date.now() - startedAt >= RUN_BUDGET_MS) outOfTime = true;
      return !outOfTime;
    };

    for (const row of settingsRows ?? []) {
      if (mailErrors.length || !timeLeft()) break;
      const settings: FollowUpSettings = { ...DEFAULT_SETTINGS, ...row };
      const companyId = String((row as any).company_id);

      // NOT `allowed === false`. The header above promises "never a
      // suspended/expired company", and two answers that are not `false` are
      // not a yes either: a FAILED rpc hands back data: null with the reason
      // in `error` (revoked EXECUTE, schema-cache miss, timeout), and
      // company_allowed is `select ... from companies where id = cid`, a
      // scalar subquery that answers NULL for a company id matching no row --
      // which is exactly what a follow_up_settings row outliving its company
      // looks like. Either one used to let the whole run email that company's
      // customers. invite-crew, price-job and mail-send all read the error;
      // mail-send also demands a literal true.
      const { data: allowed, error: allowedError } = await db.rpc("company_allowed", { cid: companyId });
      if (allowedError) {
        console.error("send-follow-ups: company_allowed", companyId, allowedError.message);
        results.push({ company_id: companyId, skipped: "could not check whether the company is allowed" });
        continue;
      }
      if (allowed !== true) {
        results.push({ company_id: companyId, skipped: "company not allowed" });
        continue;
      }

      const offset = approximateUtcOffsetHours(settings.timezone);
      if (isQuietHour(now, settings.quiet_hours_start, settings.quiet_hours_end, offset)) {
        results.push({ company_id: companyId, skipped: "quiet hours" });
        continue;
      }

      // The cap's day is the COMPANY's day. This was UTC midnight while quiet
      // hours, three lines above, ran on settings.timezone -- and the two
      // disagree by exactly `offset`. For the one company with follow-ups
      // switched on in the live database today (America/New_York, cap 25,
      // quiet 21-7, read 2026-10-25) the UTC day rolls at 20:00 local, which
      // is INSIDE its sending window: everything sent between 20:00 and 21:00
      // local counted against a fresh cap, so one of the customer's days
      // could carry 25 letters before eight o'clock and 25 more after it.
      const todayStart = localDayStartUtc(now, offset);
      const { count: sentToday, error: sentErr } = await db
        .from("follow_up_log")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .gte("sent_at", todayStart);
      // A failed count is not a count of zero. Dropped, `sentToday` came back
      // null, `?? 0` made it nothing sent, and the cap -- the one thing
      // standing between a bad day and a company's whole customer list --
      // opened all the way up.
      if (sentErr) {
        console.error("send-follow-ups: count today's sends", companyId, sentErr.message);
        results.push({ company_id: companyId, skipped: "could not count today's sends" });
        continue;
      }
      let remaining = settings.daily_cap - (sentToday ?? 0);
      if (remaining <= 0) {
        results.push({ company_id: companyId, skipped: "daily cap reached" });
        continue;
      }

      const { data: company } = await db
        .from("companies").select("name, email, logo_path").eq("id", companyId).maybeSingle();

      // WHERE A CUSTOMER'S REPLY TO THIS NUDGE GOES, settled once per company
      // per run and before anything is claimed or sent.
      //
      // These letters go out from FenceFlow's own verified address with the
      // company's name on them, so this header is the whole of whether her
      // answer reaches the company. customerReplyTo() settles it the same way
      // the quote email and FenceFlow mail do -- the company's own FenceFlow
      // routing address when receiving is proven, else companies.email -- and
      // never throws: a failed read degrades to the company's own email.
      //
      // NEITHER means there is nowhere honest for a reply to land. Sending
      // anyway is what this function used to do, and it put her answer in
      // FenceFlow's own MAIL_FROM mailbox with no header at all. mail-send and
      // quote-approval-email refuse in exactly this case ("Add your business
      // email in Settings first"); so does this, with the reason in the run's
      // own results rather than in a log nobody reads. Skipped BEFORE the
      // follow_up_log claim, so the nudge is still due next run once an
      // address is on file -- nothing is consumed.
      const reply = await customerReplyTo(db, { companyId, companyEmail: company?.email });
      if (reply.mode === "unavailable") {
        results.push({ company_id: companyId, skipped: "no reply address for the company" });
        continue;
      }

      // One signature per company per run, not one per job: every follow-up
      // this company sends in this run carries the same letterhead, and
      // signing it four times would be four round trips for one URL. A year,
      // the same as mail-send's letterhead -- an email is read when it is
      // read, and nothing can re-sign a URL after it has gone out.
      let companyLogoUrl: string | null = null;
      {
        const path = String(company?.logo_path ?? "").trim();
        // The company id must be the first path segment, checked here because
        // this is the service role and no policy is doing it for us.
        if (path && path.startsWith(companyId + "/")) {
          try {
            const { data: signed } = await db.storage.from("company-logos")
              .createSignedUrl(path, 60 * 60 * 24 * 365);
            companyLogoUrl = signed?.signedUrl ?? null;
          } catch (e) {
            // A follow-up without a logo is still a follow-up.
            console.error("send-follow-ups logo", String((e as Error)?.message ?? e));
          }
        }
      }

      // Candidate jobs: not deleted, not a test fixture, not opted out, has
      // an email, and touches at least one of the timestamps any kind cares
      // about. The narrower per-kind filtering happens in dueFollowUp().
      //
      // PAGED (see pagedRows above). Unpaged, this stopped at PostgREST's
      // thousandth row with no error and no header anybody read, so a company
      // past a thousand eligible jobs silently lost the remainder -- and the
      // same jobs every run, since the truncation follows the server's own
      // ordering, not a cursor.
      const { data: jobs, error: jobsErr } = await pagedRows<FollowUpJob>(() => db
        .from("jobs")
        .select(
          "sync_id, status, customer_name, email, created_at, first_contact_at, " +
          "quote_sent_at, quote_viewed_at, quote_approved_at, deposit_amount, " +
          "amount_paid, opted_out_at, is_test_fixture, deleted_at, quote_token",
        )
        .eq("company_id", companyId)
        .eq("is_test_fixture", false)
        .is("deleted_at", null)
        .is("opted_out_at", null)
        .not("email", "eq", ""));
      // A failed read is not "this company has nothing due". It was dropped,
      // which made an outage indistinguishable from an empty pipeline.
      if (jobsErr) {
        console.error("send-follow-ups: read candidate jobs", companyId, jobsErr.message ?? String(jobsErr));
        results.push({ company_id: companyId, skipped: "could not read this company's jobs" });
        continue;
      }

      for (const j of jobs) {
        if (remaining <= 0 || mailErrors.length) break;
        const due = dueFollowUp(j, settings, now);
        if (!due) continue;
        if (!timeLeft()) break; // before the claim, so nothing is left claimed-but-unsent

        // Claim the log row FIRST. If another run (or a retry) already
        // claimed this exact (company, job, kind, stageKey), the insert is
        // refused by the unique constraint and nothing is sent again.
        const { data: claimed, error: claimErr } = await db
          .from("follow_up_log")
          .insert({
            company_id: companyId,
            job_sync_id: j.sync_id,
            kind: due.kind,
            stage_key: due.stageKey,
            channel: "email",
          })
          .select("id")
          .maybeSingle();
        if (claimErr && (claimErr as any).code !== "23505") {
          console.error("send-follow-ups: claim log row", claimErr.message);
          continue;
        }
        if (!claimed) continue; // 23505 = already sent for this stage

        const quoteUrl = j.quote_token ? `${siteUrl}/quote.html?t=${j.quote_token}` : null;
        const { subject, html, text } = buildEmail(due.kind, j, company?.name ?? "", quoteUrl, companyLogoUrl);

        const payload = JSON.stringify({
          from: senderWithName(company?.name ?? "", mailFrom),
          to: [j.email],
          subject,
          html,
          text,
          // Non-null here: an unavailable reply address skipped this company above.
          ...(reply.replyTo ? { reply_to: reply.replyTo } : {}),
        });
        const send = async () => {
          const wait = MIN_SEND_GAP_MS - (Date.now() - lastSendAt);
          if (wait > 0) await sleep(wait);
          lastSendAt = Date.now();
          return await fetch(mailUrl, {
            method: "POST",
            headers: { Authorization: `Bearer ${mailKey}`, "Content-Type": "application/json" },
            body: payload,
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          });
        };

        try {
          let res = await send();
          // One patient retry on a rate limit before counting it: a single
          // 429 is usually a burst, not a quota.
          if (res.status === 429) {
            await res.text().catch(() => "");
            const after = Number(res.headers.get("retry-after"));
            await sleep(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 1100, 5000));
            res = await send();
          }
          if (!res.ok) {
            const detail = await res.text();
            console.error("send-follow-ups: mail provider refused", res.status, detail.slice(0, 300));
            const kind = refusalKind(res.status);
            if (kind === "keep") {
              results.push({ company_id: companyId, job_sync_id: j.sync_id, kind: due.kind, refused: res.status });
              continue;
            }
            if (kind === "release") {
              // Certainly not sent, so the next run may try it again.
              await db.from("follow_up_log").delete().eq("id", claimed.id);
            }
            mailErrors.push(`mail provider answered ${res.status}` +
              (kind === "release" ? " (nothing was sent; it will be retried next run)" : " (may or may not have sent)"));
            break;
          }
          const sent = await res.json().catch(() => ({}));
          if (sent?.id) {
            await db.from("follow_up_log").update({ message_id: String(sent.id) }).eq("id", claimed.id);
          }
          remaining -= 1;
          results.push({ company_id: companyId, job_sync_id: j.sync_id, kind: due.kind, sent: true });
        } catch (e) {
          // No answer at all, or none within SEND_TIMEOUT_MS: the claim stays
          // (it may have gone out), and the run reports it rather than going green.
          console.error("send-follow-ups: send failed", String(e));
          mailErrors.push("could not reach the mail provider");
          break;
        }
      }
    }

    if (mailErrors.length) {
      return json({ error: `Sending stopped: ${mailErrors.join("; ")}.`, results }, 502);
    }
    // Running out of time is not a failure: the run did what fit, and the
    // rest is still due. The workflow turns this field into a notice.
    return json({
      ok: true,
      results,
      ...(outOfTime ? { unfinished: `Stopped after ${Math.round(RUN_BUDGET_MS / 1000)} s to answer inside Supabase's time limit; the remaining follow-ups go out next run.` } : {}),
    });
  } catch (e) {
    console.error("send-follow-ups:", e);
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});

// ---------------------------------------------------------------------------
// SCHEDULING
//
// This project has pg_net but NOT pg_cron (verified 2026-09-17 against the
// live database: `select extname from pg_extension`). That means the usual
// Supabase pattern of `select cron.schedule(...)` calling `net.http_post`
// cannot run here today -- there is no in-database scheduler to register
// with. Documenting, NOT enabling, both paths so the owner can pick one
// when ready. Turning either of these on will start sending real email the
// moment any company also has follow_up_settings.enabled = true.
//
// Option A -- if pg_cron is ever added to this project (Database ->
// Extensions -> pg_cron in the dashboard), the standard pattern is:
//
//   select cron.schedule(
//     'send-follow-ups-hourly',
//     '0 * * * *',
//     $$
//     select net.http_post(
//       url := 'https://newcrgafcptspmapacrx.supabase.co/functions/v1/send-follow-ups',
//       headers := jsonb_build_object(
//         'Content-Type', 'application/json',
//         'x-fenceflow-trigger', '<the NOTIFY_TRIGGER_SECRET value>'
//       ),
//       body := '{}'::jsonb
//     );
//     $$
//   );
//
// Option B -- no new extension, matches the "20 min a month" cost this repo
// already avoids paying for a third Supabase project: an external cron
// caller (a GitHub Actions workflow on a schedule trigger, or any existing
// always-on scheduler already in use elsewhere) does a single
//
//   curl -X POST https://newcrgafcptspmapacrx.supabase.co/functions/v1/send-follow-ups \
//     -H "x-fenceflow-trigger: $NOTIFY_TRIGGER_SECRET"
//
// once an hour. The secret lives in that scheduler's own secret store, same
// as it lives in Supabase's function secrets -- never in a committed file.
//
// Either way: NOTIFY_TRIGGER_SECRET must be set as a function secret before
// deploying (reuse notify-job-change's existing secret, or mint a new one
// with the same properties -- long, random, compared in constant time,
// checked before the body is even read). Nothing above enables a schedule;
// that step is explicitly left to the owner.
