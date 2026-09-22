/**
 * Which mail servers FenceFlow will open a connection to.
 *
 * mail-connect takes a host name from the office. Without this file that is
 * a server-side request forgery: an owner (or anyone holding an owner's
 * session) could point FenceFlow's edge runtime at 169.254.169.254, at
 * something on Supabase's internal network, or at any machine on the
 * internet, and read the answer back through the error text. So:
 *
 *  - Zoho and Gmail are presets. Their host names are fixed here and never
 *    come from the request.
 *  - "Other" hosts must be a plain public DNS name (no IP literals, no
 *    single labels, no localhost/.local/.internal), are refused outright if
 *    they belong to Microsoft (app passwords cannot sign in there any more),
 *    and are resolved before connecting. If ANY address the name resolves
 *    to is private or reserved, the name is refused.
 *  - Ports are fixed at 993 and 465 (limits.ts), and the TLS certificate must
 *    validate for the name, which is what closes the gap between resolving
 *    and connecting: a name re-pointed at an internal address in between
 *    reaches a server that cannot present a certificate for it.
 *
 * Pure except for denoResolver(), which is only called by the Deno side.
 * tests/mail-hosts.test.mjs imports the rest under plain Node.
 */

import { MailError } from "./errors.ts";
import { DNS_TIMEOUT_MS, IMAP_PORT, SMTP_PORT } from "./limits.ts";

export type MailProvider = "zoho" | "gmail" | "custom";

export interface MailHosts {
  provider: MailProvider;
  imapHost: string;
  smtpHost: string;
  imapPort: number;
  smtpPort: number;
  /** True when the owner typed the host names. Errors about reaching a
   *  custom host are collapsed by errors.forCustomHost(). */
  custom: boolean;
}

// ---------------------------------------------------------------------------
// Presets.
// ---------------------------------------------------------------------------

/**
 * Zoho datacentres whose servers have been reached from the edge runtime.
 * Only the US one has: on 2026-09-21 the reach probe completed TLS and read
 * a greeting from imap.zoho.com, imappro.zoho.com, smtp.zoho.com and
 * smtppro.zoho.com on 993/465. Zoho also runs .eu, .in, .com.au and .jp;
 * each is added here only after the probe has resolved and greeted it, so
 * the office never offers a region that has not been shown to work. Until
 * then an EU owner can still use "Other" with Zoho's EU host names.
 */
export const ZOHO_REGIONS: Readonly<Record<string, string>> = { us: "zoho.com" };

/** Mailboxes that belong to Zoho itself rather than to an organisation's own
 *  domain. They use imap./smtp.; organisation mailboxes use imappro./smtppro. */
const ZOHO_PERSONAL_DOMAINS = new Set(["zohomail.com", "zoho.com"]);

const EMAIL_RE = /^[^\s@"<>(),;:\\[\]]+@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/;

/** Lowercased, trimmed, and plausibly an address, or bad_request. */
export function normalizeMailbox(email: unknown): { address: string; domain: string } {
  const address = String(email ?? "").trim().toLowerCase();
  const m = address.length <= 254 ? EMAIL_RE.exec(address) : null;
  if (!m) throw new MailError("bad_request", "Enter the mailbox's full email address.");
  return { address, domain: m[1] };
}

/** The fixed host names for a preset provider. */
export function resolvePreset(provider: string, email: string, zohoRegion = "us"): MailHosts {
  const { domain } = normalizeMailbox(email);
  if (provider === "gmail") {
    return { provider, imapHost: "imap.gmail.com", smtpHost: "smtp.gmail.com", imapPort: IMAP_PORT, smtpPort: SMTP_PORT, custom: false };
  }
  if (provider === "zoho") {
    const region = String(zohoRegion || "us").toLowerCase();
    const base = Object.prototype.hasOwnProperty.call(ZOHO_REGIONS, region) ? ZOHO_REGIONS[region] : null;
    if (!base) throw new MailError("bad_request", "That Zoho region is not available yet.");
    const pro = !ZOHO_PERSONAL_DOMAINS.has(domain);
    return {
      provider,
      imapHost: `${pro ? "imappro" : "imap"}.${base}`,
      smtpHost: `${pro ? "smtppro" : "smtp"}.${base}`,
      imapPort: IMAP_PORT,
      smtpPort: SMTP_PORT,
      custom: false,
    };
  }
  throw new MailError("bad_request", "Unknown mail provider.");
}

// ---------------------------------------------------------------------------
// Microsoft: refused with the real reason.
// ---------------------------------------------------------------------------

const MICROSOFT_HOST_SUFFIXES = [
  "outlook.com",
  "office365.com",
  "office.com",
  "office.net",
  "hotmail.com",
  "live.com",
  "msn.com",
  "microsoft.com",
  "microsoftonline.com",
  "exchangelabs.com",
];

export function isMicrosoftHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return MICROSOFT_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/** Microsoft's consumer mailbox domains, including the regional hotmail and
 *  outlook ones (hotmail.co.uk, outlook.fr). A business domain on Microsoft
 *  365 is caught at the host instead, because its IMAP host is Microsoft's. */
export function isMicrosoftMailboxDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return /^(hotmail|outlook)\.[a-z]{2,3}(\.[a-z]{2})?$/.test(d) || d === "live.com" || d === "msn.com" || d === "windowslive.com";
}

// ---------------------------------------------------------------------------
// Owner-typed host names.
// ---------------------------------------------------------------------------

/** Suffixes that only mean something on a private network, or never resolve
 *  publicly by definition (RFC 6761, RFC 8375, RFC 7686). */
const PRIVATE_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "localdomain",
  "home.arpa",
  "arpa",
  "onion",
  "test",
  "example",
  "invalid",
];

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A host name the owner typed, lowercased and checked for shape. Refuses IP
 * literals of every spelling, single labels, private-network suffixes,
 * underscores, over-long names and labels, and Microsoft's hosts. Does NOT
 * prove the name is safe to connect to: resolveAndCheck() does that.
 */
export function validateCustomHost(raw: unknown): string {
  const input = String(raw ?? "").trim().toLowerCase();
  const refuse = () => new MailError("host_not_allowed", "Enter the server's name, like imap.example.com.");
  if (!input || input.length > 253) throw refuse();
  // Any colon or bracket is an IPv6 literal or a port; a % is a zone id.
  if (/[:[\]%/@\s]/.test(input)) throw refuse();
  const host = input.endsWith(".") ? input.slice(0, -1) : input;
  const labels = host.split(".");
  if (labels.length < 2) throw refuse();
  if (!labels.every((l) => LABEL_RE.test(l))) throw refuse();
  // A last label of digits is an IPv4 literal (1.2.3.4) or a numeric
  // spelling of one (0x7f.1, 2130706433 needs no dot and failed above).
  if (/^[0-9]+$/.test(labels[labels.length - 1]) || /^0x/.test(labels[labels.length - 1])) throw refuse();
  if (labels.every((l) => /^(0x[0-9a-f]+|[0-9]+)$/.test(l))) throw refuse();
  if (PRIVATE_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) throw refuse();
  if (isMicrosoftHost(host)) throw new MailError("microsoft_oauth_only");
  return host;
}

// ---------------------------------------------------------------------------
// Addresses.
// ---------------------------------------------------------------------------

/** IPv4 ranges no mail server of a tenant's can legitimately be in. */
export const PRIVATE_V4_RANGES: ReadonlyArray<string> = [
  "0.0.0.0/8", // "this network"
  "10.0.0.0/8", // private
  "100.64.0.0/10", // carrier-grade NAT
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local, including cloud metadata at .169.254
  "172.16.0.0/12", // private
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // documentation
  "192.88.99.0/24", // deprecated 6to4 relay
  "192.168.0.0/16", // private
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // documentation
  "203.0.113.0/24", // documentation
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, including 255.255.255.255
];

/**
 * IPv6 prefixes refused inside global unicast (2000::/3). Everything outside
 * 2000::/3 is refused anyway -- that already covers ::, ::1, fc00::/7,
 * fe80::/10 and ff00::/8 -- except the two translation prefixes, whose
 * embedded IPv4 address is judged by the IPv4 table instead.
 */
export const PRIVATE_V6_RANGES: ReadonlyArray<string> = [
  "2001::/23", // IETF protocol assignments: Teredo, benchmarking, ORCHID
  "2001:db8::/32", // documentation
  "2002::/16", // 6to4, which embeds an arbitrary IPv4 address
  "3fff::/20", // documentation (RFC 9637)
];

function parseV4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    // Decimal only, no leading zeros: "010" is octal to some parsers.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function parseV6(s: string): number[] | null {
  if (!s || /[^0-9a-f:.]/i.test(s)) return null; // zone ids (%eth0) and brackets end here
  let head = s;
  let tail: number[] = [];
  // Embedded dotted IPv4 in the last 32 bits (::ffff:1.2.3.4).
  const lastColon = s.lastIndexOf(":");
  if (s.includes(".")) {
    const v4 = parseV4(s.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    head = s.slice(0, lastColon + 1);
    // "::1.2.3.4" keeps its double colon; "1:2:3:4:5:6:1.2.3.4" drops the
    // colon that separated the groups from the dotted part.
    if (!head.endsWith("::")) head = head.slice(0, -1);
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  if (!left || !right) return null;
  const known = left.length + right.length + tail.length;
  if (halves.length === 2) {
    if (known > 7) return null;
    return [...left, ...new Array(8 - known).fill(0), ...right, ...tail];
  }
  if (known !== 8) return null;
  return [...left, ...tail];
}

function v4InRange(ip: number[], cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const b = parseV4(base);
  const bits = Number(bitsStr);
  if (!b) return false;
  const toInt = (a: number[]) => ((a[0] << 24) >>> 0) + (a[1] << 16) + (a[2] << 8) + a[3];
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((toInt(ip) & mask) >>> 0) === ((toInt(b) & mask) >>> 0);
}

function v6InRange(ip: number[], cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const b = parseV6(base);
  let bits = Number(bitsStr);
  if (!b) return false;
  for (let i = 0; i < 8 && bits > 0; i++, bits -= 16) {
    const take = Math.min(16, bits);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((ip[i] & mask) !== (b[i] & mask)) return false;
  }
  return true;
}

export interface AddressTables {
  v4: ReadonlyArray<string>;
  v6: ReadonlyArray<string>;
}

/**
 * Builds the address check from its tables. Exported as a factory so the
 * test can prove the tables are what does the refusing: the same checker
 * built with an empty IPv4 table accepts 10.1.2.3.
 */
export function makeAddressChecker(tables: AddressTables): (ip: string) => boolean {
  const isPublicV4 = (v4: number[]) => !tables.v4.some((r) => v4InRange(v4, r));
  return (raw: string): boolean => {
    const ip = String(raw ?? "").trim().toLowerCase();
    const v4 = parseV4(ip);
    if (v4) return isPublicV4(v4);
    const v6 = parseV6(ip);
    if (!v6) return false; // anything unparseable is refused, never guessed at
    const embedded = [v6[6] >> 8, v6[6] & 0xff, v6[7] >> 8, v6[7] & 0xff];
    if (v6InRange(v6, "::ffff:0:0/96") || v6InRange(v6, "64:ff9b::/96")) return isPublicV4(embedded);
    if (!v6InRange(v6, "2000::/3")) return false;
    return !tables.v6.some((r) => v6InRange(v6, r));
  };
}

/** True only for an address a tenant's mail server could publicly live at. */
export const isPublicAddress = makeAddressChecker({ v4: PRIVATE_V4_RANGES, v6: PRIVATE_V6_RANGES });

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

/** Returns the addresses of one record type, or [] when there are none. */
export type Resolver = (host: string, type: "A" | "AAAA") => Promise<string[]>;

/**
 * Deno's resolver, or null where the runtime has none. With no way to see
 * where a name points, custom hosts are refused rather than trusted.
 */
export function denoResolver(): Resolver | null {
  // deno-lint-ignore no-explicit-any
  const D = (globalThis as any).Deno;
  if (!D || typeof D.resolveDns !== "function") return null;
  return async (host, type) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The signal is honoured by current runtimes; the race covers one
      // that ignores it, so a stalled lookup still ends on time.
      const lookup: Promise<string[]> = D.resolveDns(host, type, { signal: AbortSignal.timeout(DNS_TIMEOUT_MS) });
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MailError("dns_failed")), DNS_TIMEOUT_MS + 500);
      });
      lookup.catch(() => {});
      return await Promise.race([lookup, late]);
    } catch (e) {
      // "No records of this type" is an answer, not a failure: a host with
      // only AAAA records has no A records.
      const name = String((e as { name?: unknown })?.name ?? "");
      if (name === "NotFound") return [];
      throw e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

/**
 * Resolves a validated custom host and refuses it if any address is not
 * public. All of them, not just the first: a name with one public and one
 * internal address is exactly the shape of a rebinding attempt.
 */
export async function resolveAndCheck(host: string, resolver: Resolver | null): Promise<string[]> {
  if (!resolver) throw new MailError("host_not_allowed", "Custom mail servers cannot be checked here.");
  let results: string[][];
  try {
    results = await Promise.all([resolver(host, "A"), resolver(host, "AAAA")]);
  } catch {
    throw new MailError("dns_failed");
  }
  const addresses = results.flat().map((a) => String(a).trim()).filter(Boolean);
  if (addresses.length === 0) throw new MailError("dns_failed");
  if (!addresses.every((a) => isPublicAddress(a))) throw new MailError("host_not_allowed");
  return addresses;
}

export interface ConnectHostsInput {
  provider: unknown;
  email: unknown;
  zohoRegion?: unknown;
  imapHost?: unknown;
  smtpHost?: unknown;
}

/**
 * Everything mail-connect needs to know before opening a socket: which
 * hosts, which ports, and whether they are owner-typed. Presets never touch
 * DNS; custom hosts are shape-checked, Microsoft-checked and resolved, in
 * that order, so a refused name never costs a lookup.
 */
export async function planConnection(input: ConnectHostsInput, resolver: Resolver | null): Promise<MailHosts> {
  const { address, domain } = normalizeMailbox(input.email);
  if (isMicrosoftMailboxDomain(domain)) throw new MailError("microsoft_oauth_only");
  const provider = String(input.provider ?? "");
  if (provider === "zoho" || provider === "gmail") {
    return resolvePreset(provider, address, String(input.zohoRegion ?? "us"));
  }
  if (provider !== "custom") throw new MailError("bad_request", "Unknown mail provider.");
  const imapHost = validateCustomHost(input.imapHost);
  const smtpHost = validateCustomHost(input.smtpHost);
  await Promise.all([resolveAndCheck(imapHost, resolver), resolveAndCheck(smtpHost, resolver)]);
  return { provider: "custom", imapHost, smtpHost, imapPort: IMAP_PORT, smtpPort: SMTP_PORT, custom: true };
}
