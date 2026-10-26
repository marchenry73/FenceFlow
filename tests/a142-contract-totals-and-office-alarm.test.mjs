/* Two findings from the sweep of the never-examined code.
 *
 * A. THE CONTRACT EMAIL'S TOTAL FOOTAGE could disagree with the quote page the
 *    customer approved. quote.html sums the unrounded run lengths and rounds
 *    the sum once; email.ts rounded each run and added the rounded ones. Three
 *    runs of 40.4 / 30.4 / 25.4 ft read 96 ft on the page and 95 ft in the
 *    email -- one document contradicting the other about the figure the price
 *    is made of. Pinned here as PARITY against the page's own function, lifted
 *    out of quote.html, so the two cannot drift apart again by one being fixed
 *    alone.
 *
 * B. THE OFFICE ALARM was sent in the one FCM payload shape the app cannot act
 *    on. office-push.ts exists for exactly one message -- "the customer
 *    approved but their contract email did not go out" -- and its own header
 *    calls that the failure the owner cannot be allowed to miss. It sent a
 *    `notification` message. FenceFlowMessagingService says it expects `data`
 *    messages "so this runs even when the app is backgrounded", and a
 *    notification message to a backgrounded app never calls onMessageReceived
 *    at all: the app never draws it on the owner's channel, never controls how
 *    it looks, and never calls requestSync. Five of the seven senders in this
 *    repo already send data + android.priority HIGH.
 *
 *   node --test tests/a142-contract-totals-and-office-alarm.test.mjs
 *   (no network, no database, no Firebase)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as email from "../supabase/functions/quote-approval-email/email.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

// ===========================================================================
// A. The contract email's footage, against the page's own arithmetic.
// ===========================================================================

/** One function lifted out of quote.html by brace matching, source and all. */
function grabFromQuotePage(src, name) {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, `quote.html has no function ${name}`);
  let depth = 0;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (!depth) return src.slice(start, j + 1);
    }
  }
  assert.fail(`unbalanced braces in ${name}`);
}

const pageSrc = read("website/quote.html");
const page = new Function(
  [
    grabFromQuotePage(pageSrc, "runFeet"),
    grabFromQuotePage(pageSrc, "runGateCount"),
    grabFromQuotePage(pageSrc, "installTotals"),
    "return { runFeet, runGateCount, installTotals };",
  ].join("\n"),
)();

/** Lengths chosen so rounding each one and rounding the sum DISAGREE. */
const FRACTIONAL = [
  { type: "VINYL", manualFeet: 40.4, gates: "", heightFt: 6 },
  { type: "VINYL", manualFeet: 30.4, gates: "", heightFt: 6 },
  { type: "VINYL", manualFeet: 25.4, gates: "", heightFt: 6 },
];

test("the email's total footage is the page's total footage, to the foot", () => {
  const PX = 20;
  const fromPage = Math.round(page.installTotals(FRACTIONAL, PX).ft);
  const fromEmail = email.installTotals(email.scopeRows(FRACTIONAL, PX)).feet;
  // 40.4 + 30.4 + 25.4 = 96.2 -> 96. Rounding each first gives 40+30+25 = 95.
  assert.equal(fromPage, 96, "the page's own arithmetic moved; this parity check needs rewriting");
  assert.equal(
    fromEmail,
    fromPage,
    "the contract email states a different total footage than the page the customer approved",
  );
});

test("each row still prints a whole number of feet", () => {
  // A row showing 40.4 ft is not the fix: a scope row is read, not added.
  const rows = email.scopeRows(FRACTIONAL, 20);
  for (const r of rows) {
    assert.equal(r.feet, Math.round(r.feet), `a row printed ${r.feet} ft`);
  }
  // And the exact figure is carried alongside, which is what the total uses.
  assert.ok(rows.some((r) => r.feetExact !== r.feet), "no row carries an exact length");
});

test("a row built without an exact length still totals, using what it has", () => {
  // Optional on purpose, so a hand-built row keeps working. The fallback is
  // the old, slightly-off arithmetic -- stated rather than silent.
  const handBuilt = [
    { teardown: false, type: "Vinyl", finish: "", label: "A", heightFt: 6, feet: 40, gates: 1 },
    { teardown: false, type: "Vinyl", finish: "", label: "B", heightFt: 6, feet: 30, gates: 0 },
  ];
  assert.deepEqual(email.installTotals(handBuilt), { feet: 70, gates: 1 });
});

test("a teardown run is still not fence being installed", () => {
  // The behaviour the change had to preserve: the old fence coming out is in
  // the breakdown and out of the total.
  const withTeardown = [
    ...FRACTIONAL,
    { type: "WOOD", manualFeet: 120, gates: "4:SINGLE", heightFt: 6, teardown: true },
  ];
  const rows = email.scopeRows(withTeardown, 20);
  assert.equal(email.installTotals(rows).feet, 96);
  assert.equal(Math.round(page.installTotals(withTeardown, 20).ft), 96);
});

// ===========================================================================
// B. The office alarm's payload.
// ===========================================================================

const OFFICE_PUSH = "supabase/functions/quote-approval-email/office-push.ts";
const PROJECT = "fenceflow-test";

/** A real RSA key, because accessToken signs a JWT with crypto.subtle. */
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const SERVICE_ACCOUNT = JSON.stringify({
  client_email: "push@fenceflow-test.iam.gserviceaccount.com",
  private_key: privateKey,
  project_id: PROJECT,
});

/**
 * office-push.ts with its one import replaced by a stub, exactly the way the
 * other harnesses in this repo load an edge function.
 *
 * [mutate] lets a canary put the old payload back. It asserts its own mutation
 * point is still there, so a canary that quietly stopped mutating anything
 * cannot "pass" by testing the fixed code twice.
 */
function loadPush(devices, mutate = (js) => js) {
  let js = stripTypeScriptTypes(read(OFFICE_PUSH));
  const importRe = /^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";?[ \t]*$/gm;
  for (const [, list, from] of js.matchAll(importRe)) {
    assert.equal(from, "../_shared/push-recipients.ts", `an import the harness does not supply: ${from}`);
    assert.deepEqual(
      list.split(",").map((n) => n.trim()).filter(Boolean),
      ["moneyDevices"],
      "office-push.ts imports something new",
    );
  }
  js = mutate(js.replace(importRe, "").replace(/^export /gm, ""));
  assert.doesNotMatch(js, /^import /m, "an import the harness did not strip");

  const sent = [];
  const fetchFake = async (url, init) => {
    if (url === "https://oauth2.googleapis.com/token") {
      return { ok: true, json: async () => ({ access_token: "fake-bearer" }) };
    }
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return { ok: true, json: async () => ({}) };
  };
  const moneyDevices = async () => devices;
  const fn = new Function(
    "moneyDevices",
    js + "\nreturn pushToOffice;",
  )(moneyDevices);
  return {
    sent,
    run: () => fn({}, { fetch: fetchFake, env: (n) => (n === "FIREBASE_SERVICE_ACCOUNT" ? SERVICE_ACCOUNT : undefined) }, "c1", "Title", "Body"),
  };
}

const TWO_PHONES = [{ token: "phone-a" }, { token: "phone-b" }];

test("the alarm is a DATA message, high priority, and carries no notification block", async () => {
  const h = loadPush(TWO_PHONES);
  const told = await h.run();
  assert.equal(told, 2, "both phones should have been sent to");
  assert.equal(h.sent.length, 2);
  for (const { url, body } of h.sent) {
    assert.ok(url.includes(`/v1/projects/${PROJECT}/messages:send`), url);
    // THE WHOLE POINT. A notification message to a backgrounded app never
    // reaches onMessageReceived, so the app cannot draw it on the owner's
    // channel and never asks for a sync.
    assert.equal(body.message.notification, undefined, "still sending a notification message");
    assert.deepEqual(body.message.data, { title: "Title", body: "Body" });
    assert.equal(body.message.android?.priority, "HIGH", "not high priority, so it can be held back when dozing");
  }
  assert.deepEqual(h.sent.map((s) => s.body.message.token).sort(), ["phone-a", "phone-b"]);
});

test("no phones to tell means nothing is sent and nothing is claimed", async () => {
  const h = loadPush([]);
  assert.equal(await h.run(), 0);
  assert.equal(h.sent.length, 0);
});

test("PLANTED: the old notification payload is caught", async () => {
  const OLD = (js) => {
    const needle = "message: { token: d.token, data: { title, body }, android: { priority: \"HIGH\" } },";
    assert.ok(js.includes(needle), "the canary's mutation point has moved; this test no longer tests the old code");
    return js.replace(needle, "message: { token: d.token, notification: { title, body } },");
  };
  const h = loadPush(TWO_PHONES, OLD);
  await h.run();
  assert.equal(h.sent.length, 2);
  // Caught in both directions: the notification block is back AND the data
  // the app reads is gone.
  assert.notEqual(h.sent[0].body.message.notification, undefined);
  assert.equal(h.sent[0].body.message.data, undefined);
});

test("POSITIVE CONTROL: these checks read the real files, and the files say what they must", () => {
  // Each assertion above reads a file by path. A wrong path throws rather than
  // passes, but a regex that matched nothing could read as a pass elsewhere, so
  // the anchors are asserted present here too.
  const push = read(OFFICE_PUSH);
  assert.ok(push.includes("pushToOffice"), "office-push.ts is not the file this test thinks");
  assert.ok(push.includes("moneyDevices"), "the audience function is gone");
  // The app's side of the contract, in its own words.
  const service = read("app/src/main/java/com/fenceestimator/app/notify/FenceFlowMessagingService.kt");
  assert.match(
    service,
    /data\[\s*"title"\s*\]/,
    "the app no longer reads data[\"title\"], so the payload this test demands may be the wrong one now",
  );
  assert.ok(pageSrc.includes("function installTotals"), "quote.html no longer has installTotals");
});
