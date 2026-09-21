// Server-side sweep for the high-severity office alerts -- the part that
// runs whether or not a browser has the dashboard tab open.
//
// AUDIT_2026-09-18_PHASE1.md, P1 "Automation" cluster: "The 4 legacy rules
// only run while a dashboard tab is open, and production alerts reach
// nobody unless that tab is open." scratchpad/audit3/automation.md names
// the exact mechanism -- evaluateAutomationRules() and every ALERT_DEFS
// detector only ever run from website/dashboard.html's own JS, on load or
// on "Check now". There is no server-side cron or webhook walking jobs for
// any of it. This function is that missing half, for the nine detectors
// that matter most: money already at risk or gone, a crew about to be sent
// to a job that is not ready, and an 811/permit/HOA deadline.
//
// It does NOT act on anything (no set_production_stage, no note, no status
// change) -- it only detects and notifies, the same "detector, not actor"
// line supabase_automation.sql already drew for the 4 legacy rules. It does
// NOT touch website/dashboard.html or send-follow-ups; those are a
// different track's files.
//
// Three pieces, in order:
//   1. attention_sweep_candidates() (supabase_p4_attention_candidates_fn.sql)
//      -- one SQL function, the single place these nine predicates live.
//      This function does not reimplement any of them in TypeScript.
//   2. attention_findings (supabase_p4_attention_findings.sql) -- claim
//      each (company, detector, job, fingerprint) with an upsert BEFORE
//      notifying, same claim-before-send shape as send-follow-ups'
//      follow_up_log and automation_runs' double-fire guard. A row that
//      already exists for this exact fingerprint is skipped -- notified
//      once, not once per sweep run.
//   3. Push to device_tokens, same FCM path notify-job-change already uses
//      (copied, not re-invented, so the two functions cannot drift on how a
//      token is addressed or pruned) -- to OWNER/MANAGER only (see the
//      recipient-scope comment below), respecting each person's
//      notification_prefs.muted_alerts (the SAME keys ALERT_DEFS already
//      uses, reused rather than inventing a second mute list) and the
//      company's attention_sweep_settings quiet hours.
//
// RUNBOOK -- see docs/ATTENTION_SWEEP.md for the one owner step (setting
// the trigger secret) and the open questions this function deliberately
// does not resolve on its own (recipient scope, per-person quiet hours).
//
// Authentication: identical shape to notify-job-change and send-follow-ups
// -- one door, a shared secret compared in constant time, checked before
// the body is even read. Reuses NOTIFY_TRIGGER_SECRET (same value those two
// functions already have set) rather than minting a third secret with the
// same job.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { approximateUtcOffsetHours, isQuietHour } from "../_shared/follow-up-logic.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Constant-time compare -- same reasoning as notify-job-change/index.ts and
 *  send-follow-ups/index.ts: `a === b` on a secret leaks timing. */
function secretMatches(supplied: string | null, expected: string): boolean {
  if (!supplied || supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const b64 = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

/** Copied verbatim from notify-job-change/index.ts so the two functions
 *  cannot drift on how an FCM access token is minted. */
async function accessToken(sa: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
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
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
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

interface Candidate {
  company_id: string;
  job_sync_id: string;
  detector: string;
  severity: string;
  message: string;
  fp: string;
}

Deno.serve(async (req) => {
  try {
    const expected = Deno.env.get("NOTIFY_TRIGGER_SECRET");
    if (!expected) {
      console.error("attention-sweep: NOTIFY_TRIGGER_SECRET is not set; refusing to run.");
      return json({ error: "not configured" }, 503);
    }
    if (!secretMatches(req.headers.get("x-fenceflow-trigger"), expected)) {
      return json({ error: "unauthorized" }, 401);
    }

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // The ONE place these nine predicates live -- see
    // supabase_p4_attention_candidates_fn.sql's header for exactly which
    // detectors this is and which stay office-only. Already scoped, inside
    // the SQL function, to companies with attention_sweep_settings.enabled
    // = true AND company_allowed() = true -- a company with the setting off
    // contributes zero rows here, not "rows we then choose not to notify".
    const { data: candidates, error: candErr } = await db.rpc("attention_sweep_candidates");
    if (candErr) {
      console.error("attention-sweep: candidates", candErr.message);
      return json({ error: "could not load candidates" }, 500);
    }
    if (!candidates?.length) return json({ ok: true, results: [] });

    // Quiet hours are per-company (attention_sweep_settings), same shape as
    // follow_up_settings -- there is no per-person quiet-hours field
    // anywhere in this codebase to reuse instead (see
    // docs/ATTENTION_SWEEP.md's open question). Loaded once for every
    // company that produced at least one candidate.
    const companyIds = [...new Set((candidates as Candidate[]).map((c) => c.company_id))];
    const { data: settingsRows } = await db
      .from("attention_sweep_settings")
      .select("company_id, quiet_hours_start, quiet_hours_end, timezone")
      .in("company_id", companyIds);
    const settingsByCompany = new Map((settingsRows ?? []).map((s: any) => [s.company_id, s]));

    const now = new Date();
    const results: Record<string, unknown>[] = [];

    // Claim each finding before doing anything else with it -- same
    // claim-before-send shape as send-follow-ups' follow_up_log and
    // run_automation_rule()'s automation_runs insert. A finding whose
    // fingerprint has already been recorded for this (company, detector,
    // job) is skipped: notified once per occurrence, not once per sweep run
    // (the sweep may run hourly; a finding that is still true an hour later
    // must not re-notify).
    const toNotify: Candidate[] = [];
    for (const c of candidates as Candidate[]) {
      const settings = settingsByCompany.get(c.company_id);
      if (settings) {
        const offset = approximateUtcOffsetHours(settings.timezone);
        if (isQuietHour(now, settings.quiet_hours_start, settings.quiet_hours_end, offset)) {
          results.push({ company_id: c.company_id, detector: c.detector, job_sync_id: c.job_sync_id, skipped: "quiet hours" });
          continue;
        }
      }
      const { data: claimed, error: claimErr } = await db
        .from("attention_findings")
        .insert({
          company_id: c.company_id,
          job_sync_id: c.job_sync_id,
          detector: c.detector,
          severity: c.severity,
          message: c.message,
          fp: c.fp,
        })
        .select("id")
        .maybeSingle();
      if (claimErr && (claimErr as any).code !== "23505") {
        console.error("attention-sweep: claim finding", claimErr.message);
        continue;
      }
      if (!claimed) {
        results.push({ company_id: c.company_id, detector: c.detector, job_sync_id: c.job_sync_id, skipped: "already recorded" });
        continue;
      }
      toNotify.push(c);
      results.push({ company_id: c.company_id, detector: c.detector, job_sync_id: c.job_sync_id, recorded: true, finding_id: claimed.id });
    }

    if (!toNotify.length) return json({ ok: true, results });

    // FCM setup is optional -- a company can have the sweep on with push
    // not configured (same "log-only, don't crash" shape as send-follow-ups
    // refusing to run without a mail key, except here the finding is still
    // recorded either way so the office loses nothing by opening the panel
    // later; it just doesn't get pinged this run).
    const saRaw = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
    if (!saRaw) {
      console.error("attention-sweep: FIREBASE_SERVICE_ACCOUNT not set; findings recorded, nothing pushed.");
      return json({ ok: true, results, pushed: false });
    }
    const sa = JSON.parse(saRaw);
    const tok = await accessToken(sa);

    // Recipient scope: OWNER and MANAGER only, never CREW/FOREMAN/SALES/
    // ACCOUNTANT automatically. This is a business-rule choice the audit
    // did not specify for this new channel -- flagged in
    // docs/ATTENTION_SWEEP.md and the task's openQuestions rather than
    // guessed at silently. The default chosen here is the conservative one:
    // it mirrors notify-job-change's existing "ownersOnly" precedent (the
    // "somebody joined" notification already goes to owners only) and never
    // risks putting a money figure or a legal-liability detail (permit/HOA/
    // dispute) in front of someone who couldn't see it on the dashboard
    // anyway -- every one of these nine detectors requires SEE_MONEY or
    // EDIT_JOBS to even render as an alert on the page, and OWNER/MANAGER
    // are the only two roles that always hold both.
    for (const companyId of new Set(toNotify.map((c) => c.company_id))) {
      const { data: recipients } = await db
        .from("profiles")
        .select("id")
        .eq("company_id", companyId)
        .in("role", ["OWNER", "MANAGER"]);
      const recipientIds = (recipients ?? []).map((r: any) => r.id);
      if (!recipientIds.length) continue;

      const { data: prefRows } = await db
        .from("notification_prefs")
        .select("user_id, muted_alerts")
        .in("user_id", recipientIds);
      const mutedByUser = new Map(
        (prefRows ?? []).map((p: any) => [p.user_id, new Set(p.muted_alerts ?? [])]),
      );

      const companyFindings = toNotify.filter((c) => c.company_id === companyId);

      for (const userId of recipientIds) {
        const muted = mutedByUser.get(userId) ?? new Set();
        // Same key space as ALERT_DEFS in website/dashboard.html -- a
        // person who has already muted 'no_deposit' on the dashboard does
        // not get it pushed to their phone either, with no new preference
        // to set.
        const forThisUser = companyFindings.filter((c) => !muted.has(c.detector));
        if (!forThisUser.length) continue;

        const { data: tokens } = await db
          .from("device_tokens").select("token").eq("user_id", userId);
        if (!tokens?.length) continue;

        const title = forThisUser.length === 1 ? "Needs attention" : `${forThisUser.length} things need attention`;
        const body = forThisUser.length === 1
          ? forThisUser[0].message
          : `${forThisUser[0].message}${forThisUser.length > 1 ? ` (+${forThisUser.length - 1} more)` : ""}`;

        const stale: string[] = [];
        for (const t of tokens) {
          const send = await fetch(
            `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                message: {
                  token: t.token,
                  data: { title, body },
                  android: { priority: "HIGH" },
                },
              }),
            },
          );
          if (send.status === 404 || send.status === 400) stale.push(t.token);
        }
        if (stale.length) await db.from("device_tokens").delete().in("token", stale);

        const ids = forThisUser.map((c) => c.job_sync_id);
        await db.from("attention_findings")
          .update({ notified_at: new Date().toISOString() })
          .eq("company_id", companyId)
          .in("job_sync_id", ids)
          .in("detector", forThisUser.map((c) => c.detector));
      }
    }

    return json({ ok: true, results, pushed: true });
  } catch (e) {
    console.error("attention-sweep:", e);
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
