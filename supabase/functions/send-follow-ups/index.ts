// Sales follow-up automation -- the part that acts.
//
// Companies with configurable settings, off by default (follow_up_settings,
// supabase_followups_settings.sql). This function finds jobs whose real
// timestamps (quote_sent_at, quote_viewed_at, quote_approved_at,
// first_contact_at) mean a follow-up is due, and emails the customer --
// via Resend, from the COMPANY's own name, same sender pattern as
// invite-crew (`senderWithName`), reply-to the company's own email.
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
    `<p>${escapeHtml(body)}</p>${linkHtml}` +
    `<p style="font-size:12px;color:#8A93A0;margin-top:20px">` +
    `If you'd rather not receive these, just reply and let us know.</p>` +
    `</div></div></body></html>`;
  const text = `${body}${linkText}\n\nIf you'd rather not receive these, just reply and let us know.`;

  return { subject, html, text };
}

Deno.serve(async (req) => {
  try {
    const expected = Deno.env.get("NOTIFY_TRIGGER_SECRET");
    if (!expected) {
      console.error("send-follow-ups: NOTIFY_TRIGGER_SECRET is not set; refusing to run.");
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

    for (const row of settingsRows ?? []) {
      const settings: FollowUpSettings = { ...DEFAULT_SETTINGS, ...row };
      const companyId = String((row as any).company_id);

      const { data: allowed } = await db.rpc("company_allowed", { cid: companyId });
      if (allowed === false) {
        results.push({ company_id: companyId, skipped: "company not allowed" });
        continue;
      }

      const offset = approximateUtcOffsetHours(settings.timezone);
      if (isQuietHour(now, settings.quiet_hours_start, settings.quiet_hours_end, offset)) {
        results.push({ company_id: companyId, skipped: "quiet hours" });
        continue;
      }

      const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
      const { count: sentToday } = await db
        .from("follow_up_log")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .gte("sent_at", todayStart.toISOString());
      let remaining = settings.daily_cap - (sentToday ?? 0);
      if (remaining <= 0) {
        results.push({ company_id: companyId, skipped: "daily cap reached" });
        continue;
      }

      const { data: company } = await db
        .from("companies").select("name, email").eq("id", companyId).maybeSingle();

      // Candidate jobs: not deleted, not a test fixture, not opted out, has
      // an email, and touches at least one of the timestamps any kind cares
      // about. The narrower per-kind filtering happens in dueFollowUp().
      const { data: jobs } = await db
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
        .not("email", "eq", "");

      for (const j of (jobs ?? []) as FollowUpJob[]) {
        if (remaining <= 0) break;
        const due = dueFollowUp(j, settings, now);
        if (!due) continue;

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
        const { subject, html, text } = buildEmail(due.kind, j, company?.name ?? "", quoteUrl);
        const replyTo = (company?.email ?? "").trim();

        try {
          const res = await fetch(mailUrl, {
            method: "POST",
            headers: { Authorization: `Bearer ${mailKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: senderWithName(company?.name ?? "", mailFrom),
              to: [j.email],
              subject,
              html,
              text,
              ...(replyTo ? { reply_to: replyTo } : {}),
            }),
          });
          if (!res.ok) {
            const detail = await res.text();
            console.error("send-follow-ups: mail provider refused", res.status, detail.slice(0, 300));
            continue;
          }
          const sent = await res.json().catch(() => ({}));
          if (sent?.id) {
            await db.from("follow_up_log").update({ message_id: String(sent.id) }).eq("id", claimed.id);
          }
          remaining -= 1;
          results.push({ company_id: companyId, job_sync_id: j.sync_id, kind: due.kind, sent: true });
        } catch (e) {
          console.error("send-follow-ups: send failed", String(e));
        }
      }
    }

    return json({ ok: true, results });
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
