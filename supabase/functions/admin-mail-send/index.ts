/**
 * admin-mail-send -- emails YOUR CLIENTS from the admin console, as FenceFlow.
 *
 * "Email your clients from the admin portal."
 *
 * This sat on the not-started list for two reasons, and both are answered
 * here. It needs a sender that posts as FenceFlow rather than as one company's
 * own inbox -- mail-send is company-scoped, gated on can_use_company_mail(),
 * and a platform admin writing to another company's owner is not that. And it
 * sends real mail to real people, which deserves more than a textarea and a
 * POST.
 *
 *   POST {
 *     client_send_id: uuid,     one per compose window, the exactly-once key
 *     company_ids:    uuid[],   WHO, as ids -- never addresses
 *     subject:        string,
 *     text:           string,   plain text; the HTML is made from it
 *   }
 *
 * THE ANSWER is per company, because a send to nine people can half succeed:
 *
 *   200 {ok, sent, skipped, failed, results:[{company_id, name, state, ...}]}
 *        state is "sent" | "failed" | "unconfirmed" | "duplicate" | "skipped"
 *   4xx {error_code, message}      refused before anything was sent
 *
 * "unconfirmed" is not a failure and must never be shown as one: the provider
 * took the message and then did not answer, so it may well have gone. The
 * console says "could not confirm -- check before sending again".
 *
 * THE RECIPIENT IS NEVER IN THE REQUEST. The console sends company IDS and the
 * address comes from the company row, through admin_email_recipients(). That
 * is what stops this being an open relay wearing a FenceFlow return address:
 * a stolen admin token can mail his own clients, which is bad, but it can
 * never mail anybody who is not already a FenceFlow client. The same function
 * drops companies with no address, removed companies, and test companies
 * ('ZZ TEST%') -- so the count that gets mailed can be SMALLER than the count
 * he selected, and the answer says which were skipped rather than quietly
 * sending fewer.
 *
 * WHO MAY: is_platform_admin(), asked AS THE CALLER -- the one funnel every
 * admin action goes through, and the one that carries the second factor. Asked
 * directly here, and asked again inside every one of the four SQL functions,
 * so reaching this code is not itself permission. Proved against the live
 * database before this shipped: the admin with a second factor sees 6
 * mailable clients of 11 companies; the same admin WITHOUT a second factor,
 * another signed-in person, and an anonymous caller all see none.
 *
 * EXACTLY ONCE, per (client_send_id, company). admin_claim_client_email()
 * takes the claim BEFORE a byte goes to the provider; a second attempt with
 * the same id gets nothing back and is reported "duplicate" having sent
 * nothing. Then:
 *   accepted                -> 'sent'
 *   refused outright (4xx)  -> the claim is RELEASED for a bad address, so a
 *                              corrected retry can go out, and kept with the
 *                              provider's own words when it is worth showing
 *   no verdict (5xx, timeout, connection gone) -> left 'sending'
 * which fails toward not sending twice. Same rule send-welcome-email follows.
 *
 * THE PAYLOAD IS NOT A THIRD COPY. buildResendEmail / buildBrevoEmail in
 * _shared/mail/mime-build.ts are the same builders the office's own mail goes
 * through, with the same address validation, recipient caps and one-line
 * subject. The provider choice and its fallback come from
 * mail_platform_settings, the same row mail-send reads, so switching provider
 * in the console moves this too.
 *
 * ONE RECIPIENT PER MESSAGE, deliberately. Nine clients get nine separate
 * emails, not one with nine addresses on it: a single To: line would show
 * every client who else uses FenceFlow, which is his customer list.
 *
 * Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, MAIL_API_KEY / BREVO_API_KEY,
 * MAIL_FROM, MAIL_FROM_NAME, MAIL_API_URL, BREVO_API_URL, SUPPORT_EMAIL.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  buildBrevoEmail,
  buildResendEmail,
  composeBody,
  normalizeAddress,
} from "../_shared/mail/mime-build.ts";

const DEFAULT_RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_BREVO_URL = "https://api.brevo.com/v3/smtp/email";

/** At most this many clients in one press. The console shows the count first. */
const MAX_PER_SEND = 50;
const SUBJECT_MAX = 200;
const BODY_MAX = 20000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const env = (k: string) => Deno.env.get(k) ?? "";

type Sender = "resend" | "brevo";
const asSender = (v: unknown): Sender | null =>
  v === "resend" || v === "brevo" ? v : null;

/** "FenceFlow <x@y>" split into the shape the builders want. */
function platformFrom(): { name: string; address: string } {
  const address = normalizeAddress(env("MAIL_FROM"));
  const name = env("MAIL_FROM_NAME") || "FenceFlow";
  return { name, address };
}

/**
 * A Message-ID of our own. The builders require one and will not invent it:
 * a message with no Message-ID is a message no mail server can thread or
 * de-duplicate, and some will mark it as spam for that alone.
 */
function messageIdFor(clientSendId: string, companyId: string, address: string): string {
  const host = address.split("@")[1] || "fenceflowapp.com";
  // Deterministic, so a retry that reaches the provider twice looks like the
  // same message rather than two.
  return `admin-${clientSendId}-${companyId}@${host}`;
}

type PostOutcome =
  | { kind: "sent"; providerId: string | null }
  | { kind: "refused"; status: number; detail: string }
  | { kind: "unconfirmed"; detail: string };

async function post(provider: Sender, key: string, payload: unknown): Promise<PostOutcome> {
  const url = provider === "brevo"
    ? (env("BREVO_API_URL") || DEFAULT_BREVO_URL)
    : (env("MAIL_API_URL") || DEFAULT_RESEND_URL);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: provider === "brevo"
        ? { "api-key": key, "Content-Type": "application/json", accept: "application/json" }
        : { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // The request never completed. It may still have been delivered: the
    // connection can drop after the body is on its way. Not a failure.
    return { kind: "unconfirmed", detail: `no answer from the mail service: ${e}` };
  }
  const body = await res.json().catch(() => ({} as Record<string, unknown>));
  if (res.ok) {
    const id = provider === "brevo"
      ? (body as { messageId?: unknown }).messageId
      : (body as { id?: unknown }).id;
    return { kind: "sent", providerId: typeof id === "string" ? id : null };
  }
  const detail = typeof (body as { message?: unknown }).message === "string"
    ? String((body as { message?: unknown }).message).slice(0, 300)
    : `HTTP ${res.status}`;
  // 4xx is a verdict: the provider looked at it and said no. 5xx is not --
  // it may have been accepted and then lost on their side.
  return res.status >= 400 && res.status < 500
    ? { kind: "refused", status: res.status, detail }
    : { kind: "unconfirmed", detail };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error_code: "method", message: "POST only" }, 405);

  const url = env("SUPABASE_URL");
  const anon = env("SUPABASE_ANON_KEY");
  if (!url || !anon) {
    return json({ error_code: "not_configured", message: "the server is not configured" }, 503);
  }

  // THE GATE, as the caller. Not a check of our own invention beside it.
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return json({ error_code: "unauthorized", message: "sign in first" }, 401);
  }
  const asCaller = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: isAdmin, error: adminErr } = await asCaller.rpc("is_platform_admin");
  if (adminErr || isAdmin !== true) {
    return json({ error_code: "unauthorized", message: "not a FenceFlow admin" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error_code: "bad_request", message: "could not read the request" }, 400);
  }

  const clientSendId = String(body.client_send_id ?? "");
  if (!UUID_RE.test(clientSendId)) {
    return json({ error_code: "bad_request", message: "a send needs one client_send_id" }, 400);
  }
  const rawIds = Array.isArray(body.company_ids) ? body.company_ids : [];
  const companyIds = [...new Set(rawIds.map((v) => String(v)).filter((v) => UUID_RE.test(v)))];
  if (companyIds.length === 0) {
    return json({ error_code: "bad_request", message: "choose at least one client" }, 400);
  }
  if (companyIds.length > MAX_PER_SEND) {
    return json({
      error_code: "too_many",
      message: `At most ${MAX_PER_SEND} clients in one send.`,
    }, 400);
  }
  const subject = String(body.subject ?? "").trim();
  const text = String(body.text ?? "").trim();
  if (!subject) return json({ error_code: "bad_request", message: "the email needs a subject" }, 400);
  if (!text) return json({ error_code: "bad_request", message: "the email is empty" }, 400);
  if (subject.length > SUBJECT_MAX || text.length > BODY_MAX) {
    return json({ error_code: "too_long", message: "that is longer than an email can be" }, 400);
  }

  // WHO, from the database. Called as the caller, so the function's own
  // is_platform_admin() is asked a second time against a real session.
  const { data: recipients, error: recErr } = await asCaller
    .rpc("admin_email_recipients", { company_ids: companyIds });
  if (recErr) {
    return json({ error_code: "lookup_failed", message: "could not read the client list" }, 500);
  }
  const list = (recipients ?? []) as Array<{ company_id: string; name: string; to_email: string }>;

  // Which chosen companies have no address, are removed, or are test
  // companies. Reported rather than silently dropped.
  const found = new Set(list.map((r) => r.company_id));
  const skipped = companyIds.filter((id) => !found.has(id));

  const from = platformFrom();
  if (!from.address) {
    return json({ error_code: "not_configured", message: "no FenceFlow sending address is set" }, 503);
  }

  const { data: settings } = await asCaller
    .from("mail_platform_settings").select("sender_provider, fallback_provider").eq("id", 1)
    .maybeSingle();
  const primary = asSender(settings?.sender_provider) ?? "resend";
  const fallback = asSender(settings?.fallback_provider);
  const keyFor = (p: Sender) => (p === "brevo" ? env("BREVO_API_KEY") : env("MAIL_API_KEY"));
  if (!keyFor(primary)) {
    return json({
      error_code: "not_configured",
      message: primary === "brevo"
        ? "Brevo is the chosen sender but BREVO_API_KEY is not set."
        : "Resend is the chosen sender but MAIL_API_KEY is not set.",
    }, 503);
  }

  const replyTo = env("SUPPORT_EMAIL") || null;
  // Why it arrived and how to answer it. cleanSubject() runs over the footer
  // inside composeBody, so this stays one line.
  const footerLine = replyTo
    ? `You are receiving this because your company uses FenceFlow. Reply to reach us at ${replyTo}.`
    : "You are receiving this because your company uses FenceFlow.";
  const results: Array<Record<string, unknown>> = [];
  let sent = 0;
  let failed = 0;

  for (const r of list) {
    // THE CLAIM, before anything is sent.
    const { data: claimed, error: claimErr } = await asCaller.rpc("admin_claim_client_email", {
      p_client_send_id: clientSendId,
      p_company_id: r.company_id,
      p_to_email: r.to_email,
      p_subject: subject,
      p_body: text,
    });
    if (claimErr) {
      failed++;
      results.push({
        company_id: r.company_id, name: r.name, state: "failed",
        message: "could not record the send, so nothing was sent",
      });
      continue;
    }
    const rowId = typeof claimed === "number" ? claimed : Number(claimed);
    if (!Number.isFinite(rowId) || rowId <= 0) {
      // Somebody already holds this (client_send_id, company). NOTHING is
      // sent this time -- that is the whole point of the claim.
      results.push({ company_id: r.company_id, name: r.name, state: "duplicate" });
      continue;
    }

    // The same letter composer the office's own mail goes through, so the
    // plain-text and HTML parts are built one way across the product.
    //
    // NOT fenceflowFooter(). That reads "Sent by <company> using FenceFlow",
    // which is right when a fencing company writes to its customer and reads
    // "Sent by FenceFlow using FenceFlow" here. A client hearing from the
    // platform needs the other thing: why this arrived, and how to answer it.
    const composed = composeBody({ text, footer: footerLine });
    const mail = {
      from,
      to: [r.to_email],
      replyTo,
      subject,
      text: composed.text,
      html: composed.html,
      messageId: messageIdFor(clientSendId, r.company_id, from.address),
    };

    let payload: Record<string, unknown>;
    try {
      payload = primary === "brevo" ? buildBrevoEmail(mail) : buildResendEmail(mail);
    } catch (e) {
      // A bad address is the usual cause, and it is worth keeping on the
      // record so he can see which client needs fixing.
      await asCaller.rpc("admin_finish_client_email", {
        p_id: rowId, p_state: "failed", p_provider: primary,
        p_error: `could not build the message: ${e}`, p_keep_record: true,
      });
      failed++;
      results.push({
        company_id: r.company_id, name: r.name, state: "failed",
        message: "that address could not be used",
      });
      continue;
    }

    let outcome = await post(primary, keyFor(primary), payload);
    let usedProvider: Sender = primary;
    // The fallback is for "this service is down", never for "this service
    // looked at the message and refused it" -- the other one would refuse it
    // for the same reason, and trying twice risks sending twice.
    if (outcome.kind === "unconfirmed" && fallback && keyFor(fallback)) {
      const secondPayload = fallback === "brevo" ? buildBrevoEmail(mail) : buildResendEmail(mail);
      const second = await post(fallback, keyFor(fallback), secondPayload);
      if (second.kind === "sent") {
        outcome = second;
        usedProvider = fallback;
      }
    }

    if (outcome.kind === "sent") {
      await asCaller.rpc("admin_finish_client_email", {
        p_id: rowId, p_state: "sent", p_provider: usedProvider,
        p_provider_id: outcome.providerId, p_error: null, p_keep_record: true,
      });
      sent++;
      results.push({ company_id: r.company_id, name: r.name, state: "sent" });
    } else if (outcome.kind === "refused") {
      // Certainly not sent. The claim is released so a corrected retry with
      // the same id can go out, and the reason is returned to the console.
      await asCaller.rpc("admin_finish_client_email", {
        p_id: rowId, p_state: "failed", p_provider: usedProvider,
        p_error: outcome.detail, p_keep_record: false,
      });
      failed++;
      results.push({
        company_id: r.company_id, name: r.name, state: "failed",
        message: outcome.detail,
      });
    } else {
      // Left 'sending' on purpose: it may have gone out.
      failed++;
      results.push({
        company_id: r.company_id, name: r.name, state: "unconfirmed",
        message: "the mail service did not answer. It may have gone -- check before sending again.",
      });
    }
  }

  return json({
    ok: failed === 0,
    sent,
    failed,
    skipped: skipped.length,
    skipped_company_ids: skipped,
    results,
  });
});
