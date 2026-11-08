// ONE GUEST DEMO PER DEVICE.
//
// Owner's decision, 7 Nov 2026: somebody who installs the app gets ONE
// 15-minute look, and after it they buy or sign in. Before this, the clock was
// GuestSession.DURATION_MS (1 hour) kept in the handset's own DataStore --
// "Device-local only, never synced: guest mode never talks to the cloud" -- so
// deleting the app and reinstalling started a fresh hour, for ever.
//
// This is the only thing in the product that remembers a device with no
// account attached to it, so it is deliberately the smallest record that can
// answer one question: has this device already had its free demo?
//
// WHAT IT STORES. sha256(pepper || ANDROID_ID), hex. Never the identifier.
// The pepper is a server secret this function reads and the table never sees,
// so the stored value cannot be turned back into a device id by anyone who
// gets the table. The row carries no account, no company, no name and no
// location: it cannot be joined to a person.
//
// WHY ANDROID_ID AND NOT SOMETHING STRONGER. It survives deleting the app,
// clearing its data and reinstalling, because it is keyed to the app's signing
// key and the device. It does NOT survive a factory reset. The only sanctioned
// way to survive a reset is Play Integrity's device recall, which requires the
// app to be distributed through Google Play -- FenceFlow is a direct APK
// download served by apk-proxy -- and is in any case still beta behind an
// interest form. Checked and parked by the owner on 7 Nov 2026: a factory
// reset wipes the whole phone to save the price of one month.
//
// THE OFFLINE RULE. A phone with no signal cannot ask us anything, so the app
// runs a SHORTER demo on its own (OFFLINE_MS) and tells us how much of it it
// used the first time it can reach us. We then grant the remainder of the full
// demo, not a fresh one -- otherwise airplane mode is worth an extra five
// minutes to anybody who notices. A device that never comes online keeps
// getting the short demo on each reinstall, which is the cost the owner
// accepted when choosing a shorter offline demo over no offline demo at all.
//
// NO LOGIN: a guest has no session, so config.toml sets verify_jwt = false for
// this function. What stands in for the gateway's check is that the endpoint
// can do exactly one thing -- claim or read one device's demo -- writes
// nothing an attacker would want, and returns nothing about anybody else.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const env = (k: string) => Deno.env.get(k) ?? "";

/** The full demo, and the most the app may award itself with no signal. */
const FULL_MS = 15 * 60 * 1000;
const OFFLINE_MS = 5 * 60 * 1000;

/**
 * ANDROID_ID is 16 hex characters. Accepting a wider range because a handful
 * of devices return something longer, and because refusing a real device is a
 * worse failure here than accepting a made-up one: a made-up id only ever
 * buys the person who made it up one demo under a name nobody else will use.
 */
const DEVICE_RE = /^[0-9a-f]{16,64}$/i;

async function sha256Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  // Before the method check, or the preflight collects the 405 instead.
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error_code: "method", message: "POST only" }, 405);

  const url = env("SUPABASE_URL");
  const service = env("SUPABASE_SERVICE_ROLE_KEY");
  const pepper = env("GUEST_TRIAL_PEPPER");
  // FAILS CLOSED. Hashing with an empty pepper would produce a plain sha256 of
  // the device id -- reversible by anyone with a rainbow table of 16-hex
  // strings -- and it would be stable, so the table would quietly fill with
  // weak hashes that a later fix could not undo. Refusing is the safe
  // direction: no pepper, no demo.
  if (!url || !service || !pepper) {
    return json({ error_code: "not_configured", message: "the server is not configured" }, 503);
  }

  let body: { device_id?: unknown; offline_ms_used?: unknown; app_version?: unknown };
  try { body = await req.json(); } catch { return json({ error_code: "bad_json" }, 400); }

  const deviceId = String(body.device_id ?? "").trim();
  if (!DEVICE_RE.test(deviceId)) {
    return json({ error_code: "bad_device", message: "device_id is not a device identifier" }, 400);
  }

  // Clamped, not trusted. The app reports how long it ran with no signal; a
  // value larger than the offline demo would be a phone claiming it had
  // already used more than we ever grant offline.
  const offlineRaw = Number(body.offline_ms_used ?? 0);
  const offlineUsed = Number.isFinite(offlineRaw)
    ? Math.min(Math.max(offlineRaw, 0), OFFLINE_MS) : 0;
  const appVersion = String(body.app_version ?? "").slice(0, 40);

  const deviceHash = await sha256Hex(pepper + deviceId);
  const admin = createClient(url, service, { auth: { persistSession: false } });

  const { data: existing, error: readErr } = await admin
    .from("guest_device_trials")
    .select("device_hash, expires_at, started_online, first_seen_at")
    .eq("device_hash", deviceHash)
    .maybeSingle();

  // A read that FAILED must not look like a device with no row: that would
  // hand out a fresh demo every time the database hiccuped, which is the
  // opposite of what this endpoint is for.
  if (readErr) {
    return json({ error_code: "read_failed", message: "could not check this device" }, 503);
  }

  const now = Date.now();

  if (existing) {
    const remaining = Math.max(0, new Date(existing.expires_at).getTime() - now);
    // Bookkeeping only, and deliberately not awaited into the answer: a failed
    // last_seen write must never cost somebody their demo.
    admin.from("guest_device_trials")
      .update({ last_seen_at: new Date(now).toISOString(), app_version: appVersion })
      .eq("device_hash", deviceHash).then(() => {}, () => {});
    return json({
      allowed: remaining > 0,
      remainingMs: remaining,
      expiresAt: existing.expires_at,
      fullMs: FULL_MS,
      offlineMs: OFFLINE_MS,
      reason: remaining > 0 ? "running" : "used",
    });
  }

  // First time we have ever heard of this device. Grant the REMAINDER of the
  // full demo, so five minutes taken offline is five minutes off the fifteen.
  const grantMs = Math.max(0, FULL_MS - offlineUsed);
  const expiresAt = new Date(now + grantMs).toISOString();

  const { error: writeErr } = await admin.from("guest_device_trials").insert({
    device_hash: deviceHash,
    expires_at: expiresAt,
    started_online: offlineUsed === 0,
    app_version: appVersion,
  });

  if (writeErr) {
    // A race: two requests from the same handset at once, the second losing on
    // the primary key. Read what the winner wrote rather than refusing -- the
    // row exists, which is all this endpoint actually cares about.
    const { data: raced } = await admin
      .from("guest_device_trials")
      .select("expires_at")
      .eq("device_hash", deviceHash).maybeSingle();
    if (!raced) {
      return json({ error_code: "write_failed", message: "could not start the demo" }, 503);
    }
    const remaining = Math.max(0, new Date(raced.expires_at).getTime() - now);
    return json({
      allowed: remaining > 0, remainingMs: remaining, expiresAt: raced.expires_at,
      fullMs: FULL_MS, offlineMs: OFFLINE_MS, reason: remaining > 0 ? "running" : "used",
    });
  }

  return json({
    allowed: grantMs > 0,
    remainingMs: grantMs,
    expiresAt,
    fullMs: FULL_MS,
    offlineMs: OFFLINE_MS,
    reason: "granted",
  });
});
