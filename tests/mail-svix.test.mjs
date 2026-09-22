// resend-inbound's front door: is a webhook really from Resend (svix.ts),
// and which company and thread does a reply belong to (reply.ts routing).
//
// Run with:  node --test tests/mail-svix.test.mjs
//
// Signatures here are computed with node:crypto, independently of svix.ts,
// so a mistake shared by the signer and the verifier cannot hide. The first
// test also checks the example published in Svix's own documentation
// (docs.svix.com, "Verifying webhooks manually"), which no code here wrote.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { decodeSvixSecret, svixHeaders, verifySvix } from "../supabase/functions/_shared/mail/svix.ts";
import { inboundReplyAddress, inboundRoutes } from "../supabase/functions/_shared/mail/reply.ts";
import { MailError } from "../supabase/functions/_shared/mail/errors.ts";
import { SVIX_TOLERANCE_SECONDS } from "../supabase/functions/_shared/mail/limits.ts";

// A made-up signing secret in Resend's whsec_ format.
const KEY = Buffer.from("fenceflow-test-signing-key-32byt", "utf8");
const SECRET = `whsec_${KEY.toString("base64")}`;
const ID = "msg_2mNq7Lx0fenceflowtest";
const NOW = 1790000000;
const BODY = JSON.stringify({
  type: "email.received",
  created_at: "2026-09-21T12:00:00.000Z",
  data: { email_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c", to: ["a1b2c3d4e5f6.0a0b0c0d0e0f@reply.fenceflowapp.com"], subject: "Re: Quote" },
});

function sign(body, { id = ID, ts = NOW, key = KEY } = {}) {
  return createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}

function input(extra = {}) {
  return {
    headers: { id: ID, timestamp: String(NOW), signature: `v1,${sign(BODY)}` },
    body: BODY,
    secret: SECRET,
    nowSeconds: NOW,
    ...extra,
  };
}

test("the example from Svix's documentation verifies (known answer, not written by this code)", async () => {
  const res = await verifySvix({
    headers: { id: "msg_p5jXN8AQM9LWM0D4loKWxJek", timestamp: "1614265330", signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=" },
    body: '{"test": 2432232314}',
    secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
    nowSeconds: 1614265330,
  });
  assert.deepEqual(res, { ok: true, id: "msg_p5jXN8AQM9LWM0D4loKWxJek", timestamp: 1614265330 });
});

test("a correctly signed delivery is accepted, from a string or the raw bytes", async () => {
  assert.deepEqual(await verifySvix(input()), { ok: true, id: ID, timestamp: NOW });
  assert.equal((await verifySvix(input({ body: new TextEncoder().encode(BODY) }))).ok, true);
  // The whsec_ prefix is optional, as in Svix's own libraries.
  assert.equal((await verifySvix(input({ secret: KEY.toString("base64") }))).ok, true);
});

test("several signatures (a secret being rotated): accepted if any one is valid", async () => {
  const old = Buffer.from("an-older-signing-key-of-32-bytes", "utf8");
  const header = `v1,${sign(BODY, { key: old })} v2,notused v1,${sign(BODY)}`;
  assert.equal((await verifySvix(input({ headers: { id: ID, timestamp: String(NOW), signature: header } }))).ok, true);
  const noneValid = `v1,${sign(BODY, { key: old })} v1,${Buffer.alloc(32).toString("base64")}`;
  assert.deepEqual(await verifySvix(input({ headers: { id: ID, timestamp: String(NOW), signature: noneValid } })), { ok: false, reason: "bad_signature" });
  // The right MAC under any label but v1 is not a v1 signature.
  assert.equal((await verifySvix(input({ headers: { id: ID, timestamp: String(NOW), signature: `v2,${sign(BODY)}` } }))).ok, false);
  // Nor is the first half of the right MAC.
  const half = Buffer.from(sign(BODY), "base64").subarray(0, 16).toString("base64");
  assert.equal((await verifySvix(input({ headers: { id: ID, timestamp: String(NOW), signature: `v1,${half}` } }))).ok, false);
});

test("the wrong secret fails", async () => {
  const other = `whsec_${Buffer.from("someone-elses-webhook-secret-key", "utf8").toString("base64")}`;
  assert.deepEqual(await verifySvix(input({ secret: other })), { ok: false, reason: "bad_signature" });
});

test("PLANTED: a tampered body fails, down to one byte and re-serialised JSON", async () => {
  const flipped = BODY.replace("Re: Quote", "Re: Quotf");
  assert.deepEqual(await verifySvix(input({ body: flipped })), { ok: false, reason: "bad_signature" });
  // Parsing and re-serialising (here: adding whitespace) changes the bytes.
  const reserialised = JSON.stringify(JSON.parse(BODY), null, 1);
  assert.equal((await verifySvix(input({ body: reserialised }))).ok, false);
  // The id and timestamp are signed too: moving a signature to another delivery fails.
  assert.equal((await verifySvix(input({ headers: { id: "msg_another", timestamp: String(NOW), signature: `v1,${sign(BODY)}` } }))).ok, false);
});

test("PLANTED: a timestamp 6 minutes old fails, and so does one 6 minutes ahead", async () => {
  const at = (ts) => input({ headers: { id: ID, timestamp: String(ts), signature: `v1,${sign(BODY, { ts })}` } });
  // Correctly signed, but replayed later: refused.
  assert.deepEqual(await verifySvix(at(NOW - 6 * 60)), { ok: false, reason: "stale" });
  assert.deepEqual(await verifySvix(at(NOW + 6 * 60)), { ok: false, reason: "stale" });
  // The edge of the window is still inside it.
  assert.equal((await verifySvix(at(NOW - SVIX_TOLERANCE_SECONDS))).ok, true);
  assert.equal((await verifySvix(at(NOW - SVIX_TOLERANCE_SECONDS - 1))).ok, false);
});

test("missing or malformed headers are refused before any HMAC is computed", async () => {
  const h = (headers) => input({ headers: { id: ID, timestamp: String(NOW), signature: `v1,${sign(BODY)}`, ...headers } });
  assert.deepEqual(await verifySvix(h({ id: null })), { ok: false, reason: "missing_headers" });
  assert.deepEqual(await verifySvix(h({ signature: "" })), { ok: false, reason: "missing_headers" });
  assert.deepEqual(await verifySvix(h({ timestamp: "1790000000.5" })), { ok: false, reason: "malformed" });
  assert.deepEqual(await verifySvix(h({ id: "msg with spaces" })), { ok: false, reason: "malformed" });
  assert.deepEqual(await verifySvix(h({ id: "x".repeat(201) })), { ok: false, reason: "malformed" });
  assert.deepEqual(await verifySvix(h({ signature: `v1,${"A".repeat(3000)}` })), { ok: false, reason: "malformed" });
  assert.deepEqual(await verifySvix(h({ signature: "v1,not base64!" })), { ok: false, reason: "bad_signature" });
  assert.deepEqual(await verifySvix(h({ signature: sign(BODY) })), { ok: false, reason: "bad_signature" }, "a signature without its v1, label");
});

test("a missing or non-whsec secret is a configuration error, not a 'bad signature'", async () => {
  for (const bad of [undefined, "", "whsec_", "whsec_c2hvcnQ=", "not base64 at all"]) {
    await assert.rejects(verifySvix(input({ secret: bad })), (e) => e instanceof MailError && e.code === "not_configured", String(bad));
  }
  assert.equal(decodeSvixSecret(SECRET).length, 32);
});

test("svixHeaders reads the three headers off a Request", () => {
  const req = new Request("https://example.invalid/functions/v1/resend-inbound", {
    method: "POST",
    headers: { "svix-id": ID, "svix-timestamp": String(NOW), "svix-signature": "v1,abc=" },
  });
  assert.deepEqual(svixHeaders(req.headers), { id: ID, timestamp: String(NOW), signature: "v1,abc=" });
  assert.deepEqual(svixHeaders(new Headers()), { id: null, timestamp: null, signature: null });
});

// ---------------------------------------------------------------------------
// Routing a verified reply to its company and thread.
// ---------------------------------------------------------------------------

test("inboundRoutes: only <inbound_token>[.<reply_token>] at exactly the reply domain", () => {
  const routes = inboundRoutes(
    [
      "Acme Fence <A1B2C3D4E5F6.0A0B0C0D0E0F@Reply.FenceFlowApp.com>",
      "a1b2c3d4e5f6@reply.fenceflowapp.com",
      "a1b2c3d4e5f6.0a0b0c0d0e0f@reply.fenceflowapp.com",
      "dana@example.org",
      "ffffffffffff@evil.reply.fenceflowapp.com",
      "eeeeeeeeeeee@notreply.fenceflowapp.com",
      "dddddddddddd@reply.fenceflowapp.com.evil.example",
      "a1b2c3d4e5f6.0a0b.0c0d0e0f@reply.fenceflowapp.com",
      "zzzzzzzzzzzz@reply.fenceflowapp.com",
      "a1b2c3@reply.fenceflowapp.com",
    ],
    "reply.fenceflowapp.com",
  );
  assert.deepEqual(routes, [
    { inboundToken: "a1b2c3d4e5f6", replyToken: "0a0b0c0d0e0f", address: "a1b2c3d4e5f6.0a0b0c0d0e0f@reply.fenceflowapp.com" },
    { inboundToken: "a1b2c3d4e5f6", replyToken: null, address: "a1b2c3d4e5f6@reply.fenceflowapp.com" },
  ]);
  assert.deepEqual(inboundRoutes(["a1b2c3d4e5f6@reply.fenceflowapp.com"], ""), []);
  assert.deepEqual(inboundRoutes("a1b2c3d4e5f6@reply.fenceflowapp.com", "reply.fenceflowapp.com"), []);
});

test("inboundReplyAddress builds exactly what inboundRoutes reads, and refuses malformed tokens", () => {
  const addr = inboundReplyAddress("a1b2c3d4e5f6", "0a0b0c0d0e0f", "reply.fenceflowapp.com");
  assert.equal(addr, "a1b2c3d4e5f6.0a0b0c0d0e0f@reply.fenceflowapp.com");
  assert.deepEqual(inboundRoutes([addr], "reply.fenceflowapp.com")[0], { inboundToken: "a1b2c3d4e5f6", replyToken: "0a0b0c0d0e0f", address: addr });
  assert.equal(inboundReplyAddress("a1b2c3d4e5f6", null, "reply.fenceflowapp.com"), "a1b2c3d4e5f6@reply.fenceflowapp.com");
  assert.throws(() => inboundReplyAddress("A1B2", null, "reply.fenceflowapp.com"), MailError);
  assert.throws(() => inboundReplyAddress("a1b2c3d4e5f6", "x\r\nBcc", "reply.fenceflowapp.com"), MailError);
  assert.throws(() => inboundReplyAddress("a1b2c3d4e5f6", null, "localhost"), MailError);
});
