// Which mail servers FenceFlow will connect to. Pure: no DNS, no sockets.
// Every resolver below is a fake that returns what the test says.
//
// Run with:  node --test tests/mail-hosts.test.mjs
//
// This file is the SSRF guard's proof. The planted cases are the addresses
// an attacker would actually try (RFC 1918, loopback hidden inside an
// IPv4-mapped IPv6 address, cloud metadata, NAT64) and the Microsoft host
// that must be refused for a different reason. The "teeth" test builds the
// same checker with the private-range table emptied and shows it then lets
// 10.1.2.3 through -- so the table, not some accident, is what refuses it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  isMicrosoftHost,
  isMicrosoftMailboxDomain,
  isPublicAddress,
  makeAddressChecker,
  normalizeMailbox,
  planConnection,
  PRIVATE_V4_RANGES,
  PRIVATE_V6_RANGES,
  resolveAndCheck,
  resolvePreset,
  validateCustomHost,
  ZOHO_REGIONS,
} from "../supabase/functions/_shared/mail/hosts.ts";
import { MailError } from "../supabase/functions/_shared/mail/errors.ts";
import { IMAP_PORT, SMTP_PORT } from "../supabase/functions/_shared/mail/limits.ts";

function throwsCode(fn, code) {
  assert.throws(fn, (e) => e instanceof MailError && e.code === code, `expected ${code}`);
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (e) => e instanceof MailError && e.code === code, `expected ${code}`);
}

/** A fake resolver: { "host": { A: [...], AAAA: [...] } }, recording calls. */
function fakeResolver(table) {
  const calls = [];
  const resolve = async (host, type) => {
    calls.push(`${type} ${host}`);
    const row = table[host];
    if (row === "fail") throw new Error("SERVFAIL");
    return row?.[type] ?? [];
  };
  resolve.calls = calls;
  return resolve;
}

// ---------------------------------------------------------------------------
// Addresses.
// ---------------------------------------------------------------------------

test("PLANTED: private and reserved addresses are refused", () => {
  for (const ip of [
    "10.1.2.3",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1", // the same, in hex
    "169.254.169.254", // cloud metadata
    "127.0.0.1",
    "0.0.0.0",
    "100.64.0.1",
    "172.16.5.4",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.0.8",
    "192.0.2.10",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "2001:db8::1",
    "2001:0:4136:e378::1", // Teredo
    "2002:a01:203::1", // 6to4 around 10.1.2.3
    "64:ff9b::a01:203", // NAT64 around 10.1.2.3
    "64:ff9b::10.1.2.3",
    "::10.1.2.3", // IPv4-compatible, deprecated
    "3fff::1",
  ]) {
    assert.equal(isPublicAddress(ip), false, `${ip} must be refused`);
  }
});

test("malformed or ambiguous spellings are refused, never guessed at", () => {
  for (const ip of ["010.0.0.1", "1.2.3", "1.2.3.4.5", "256.1.1.1", "fe80::1%eth0", "[::1]", "1:2:3:4:5:6:7:8:9", "1::2::3", "", "localhost", "0x7f.1"]) {
    assert.equal(isPublicAddress(ip), false, `${JSON.stringify(ip)} must be refused`);
  }
});

test("ordinary public addresses pass", () => {
  for (const ip of ["8.8.8.8", "204.141.32.121", "172.32.0.1", "100.128.0.1", "2607:f8b0:4004:c07::6c", "2a00:1450:4001:82b::200e", "::ffff:8.8.8.8", "64:ff9b::808:808"]) {
    assert.equal(isPublicAddress(ip), true, `${ip} should pass`);
  }
});

test("teeth: with the private-range table emptied, the same checker lets 10.1.2.3 through", () => {
  const neutered = makeAddressChecker({ v4: [], v6: PRIVATE_V6_RANGES });
  assert.equal(neutered("10.1.2.3"), true);
  assert.equal(makeAddressChecker({ v4: PRIVATE_V4_RANGES, v6: PRIVATE_V6_RANGES })("10.1.2.3"), false);
  // And the v6 table does the same work for its own ranges.
  assert.equal(makeAddressChecker({ v4: PRIVATE_V4_RANGES, v6: [] })("2001:db8::1"), true);
});

// ---------------------------------------------------------------------------
// Host names.
// ---------------------------------------------------------------------------

test("validateCustomHost normalises an ordinary name", () => {
  assert.equal(validateCustomHost("  IMAP.Example.COM. "), "imap.example.com");
  assert.equal(validateCustomHost("mail.xn--bcher-kva.ch"), "mail.xn--bcher-kva.ch");
  assert.equal(validateCustomHost("mx-1.mail.example.co.uk"), "mx-1.mail.example.co.uk");
});

test("PLANTED: IP literals, single labels and private-network names are refused", () => {
  for (const host of [
    "10.1.2.3",
    "::ffff:127.0.0.1",
    "[::1]",
    "127.1",
    "0x7f.0x0.0x0.0x1",
    "2130706433",
    "localhost",
    "mail",
    "mail.local",
    "db.internal",
    "metadata.google.internal",
    "printer.lan",
    "x.home.arpa",
    "1.0.0.10.in-addr.arpa",
    "a..b.com",
    "-bad.example.com",
    "bad-.example.com",
    "under_score.example.com",
    "imap.example.com:143",
    "user@imap.example.com",
    "imap.example.com/x",
    `${"a".repeat(64)}.com`,
    `${"a.".repeat(127)}com`,
    "",
  ]) {
    throwsCode(() => validateCustomHost(host), "host_not_allowed");
  }
});

test("PLANTED: Microsoft hosts are refused with the OAuth reason, not a generic one", () => {
  for (const host of ["outlook.office365.com", "smtp.office365.com", "smtp-mail.outlook.com", "imap-mail.outlook.com", "x.mail.protection.outlook.com"]) {
    throwsCode(() => validateCustomHost(host), "microsoft_oauth_only");
  }
  assert.equal(isMicrosoftHost("outlook.example.com"), false);
  assert.equal(isMicrosoftHost("notoutlook.com"), false);
});

test("Microsoft consumer mailboxes are recognised by domain", () => {
  for (const d of ["outlook.com", "hotmail.com", "hotmail.co.uk", "outlook.fr", "live.com", "msn.com"]) {
    assert.equal(isMicrosoftMailboxDomain(d), true, d);
  }
  for (const d of ["acmefence.com", "outlook-fencing.com", "zoho.com", "gmail.com"]) {
    assert.equal(isMicrosoftMailboxDomain(d), false, d);
  }
});

// ---------------------------------------------------------------------------
// Presets.
// ---------------------------------------------------------------------------

test("resolvePreset: Zoho organisation mailboxes use the pro hosts", () => {
  assert.deepEqual(resolvePreset("zoho", "Owner@AcmeFence.com"), {
    provider: "zoho",
    imapHost: "imappro.zoho.com",
    smtpHost: "smtppro.zoho.com",
    imapPort: IMAP_PORT,
    smtpPort: SMTP_PORT,
    custom: false,
  });
});

test("resolvePreset: Zoho's own addresses use imap./smtp.", () => {
  const h = resolvePreset("zoho", "someone@zohomail.com");
  assert.equal(h.imapHost, "imap.zoho.com");
  assert.equal(h.smtpHost, "smtp.zoho.com");
});

test("resolvePreset: only regions the reach probe has proven are offered", () => {
  assert.deepEqual(Object.keys(ZOHO_REGIONS), ["us"]);
  throwsCode(() => resolvePreset("zoho", "owner@acmefence.com", "eu"), "bad_request");
  throwsCode(() => resolvePreset("zoho", "owner@acmefence.com", "__proto__"), "bad_request");
});

test("resolvePreset: Gmail and Workspace", () => {
  const h = resolvePreset("gmail", "owner@acmefence.com");
  assert.equal(h.imapHost, "imap.gmail.com");
  assert.equal(h.smtpHost, "smtp.gmail.com");
  assert.equal(h.imapPort, 993);
  assert.equal(h.smtpPort, 465);
});

test("normalizeMailbox refuses things that are not an address", () => {
  assert.deepEqual(normalizeMailbox(" Owner@AcmeFence.COM "), { address: "owner@acmefence.com", domain: "acmefence.com" });
  for (const bad of ["owner", "owner@", "@acmefence.com", "a b@x.com", "o@x", "o@-x.com", "o\r\n@x.com", `${"a".repeat(250)}@x.com`]) {
    throwsCode(() => normalizeMailbox(bad), "bad_request");
  }
});

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

test("resolveAndCheck: a public name passes and returns its addresses", async () => {
  const r = fakeResolver({ "imap.example.com": { A: ["93.184.216.34"], AAAA: ["2606:2800:220:1:248:1893:25c8:1946"] } });
  assert.deepEqual(await resolveAndCheck("imap.example.com", r), ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]);
});

test("PLANTED: one private address among public ones refuses the whole name", async () => {
  const r = fakeResolver({ "rebind.example.com": { A: ["93.184.216.34", "10.0.0.5"] } });
  await rejectsCode(resolveAndCheck("rebind.example.com", r), "host_not_allowed");
  const r6 = fakeResolver({ "v6.example.com": { A: ["93.184.216.34"], AAAA: ["::1"] } });
  await rejectsCode(resolveAndCheck("v6.example.com", r6), "host_not_allowed");
});

test("resolveAndCheck: no records is dns_failed; a resolver error is dns_failed; no resolver refuses", async () => {
  await rejectsCode(resolveAndCheck("nothing.example.com", fakeResolver({})), "dns_failed");
  await rejectsCode(resolveAndCheck("broken.example.com", fakeResolver({ "broken.example.com": "fail" })), "dns_failed");
  await rejectsCode(resolveAndCheck("imap.example.com", null), "host_not_allowed");
});

test("planConnection: presets never touch DNS", async () => {
  const r = fakeResolver({});
  const h = await planConnection({ provider: "zoho", email: "owner@acmefence.com", zohoRegion: "us" }, r);
  assert.equal(h.imapHost, "imappro.zoho.com");
  assert.deepEqual(r.calls, []);
});

test("planConnection: custom hosts are shape-checked, then resolved, then checked", async () => {
  const r = fakeResolver({
    "imap.acmefence.com": { A: ["93.184.216.34"] },
    "smtp.acmefence.com": { A: ["93.184.216.35"] },
  });
  const h = await planConnection(
    { provider: "custom", email: "owner@acmefence.com", imapHost: "IMAP.acmefence.com", smtpHost: "smtp.acmefence.com" },
    r,
  );
  assert.deepEqual(h, {
    provider: "custom",
    imapHost: "imap.acmefence.com",
    smtpHost: "smtp.acmefence.com",
    imapPort: 993,
    smtpPort: 465,
    custom: true,
  });
});

test("PLANTED: a refused name never costs a DNS lookup", async () => {
  const r = fakeResolver({});
  await rejectsCode(
    planConnection({ provider: "custom", email: "owner@acmefence.com", imapHost: "outlook.office365.com", smtpHost: "smtp.acmefence.com" }, r),
    "microsoft_oauth_only",
  );
  await rejectsCode(
    planConnection({ provider: "custom", email: "owner@acmefence.com", imapHost: "10.1.2.3", smtpHost: "smtp.acmefence.com" }, r),
    "host_not_allowed",
  );
  assert.deepEqual(r.calls, []);
});

test("planConnection: a Microsoft mailbox is refused whichever provider was picked", async () => {
  await rejectsCode(planConnection({ provider: "zoho", email: "someone@hotmail.com" }, null), "microsoft_oauth_only");
  await rejectsCode(planConnection({ provider: "gmail", email: "someone@outlook.com" }, null), "microsoft_oauth_only");
});

test("planConnection: an unknown provider is refused", async () => {
  await rejectsCode(planConnection({ provider: "yahoo", email: "owner@acmefence.com" }, null), "bad_request");
});
