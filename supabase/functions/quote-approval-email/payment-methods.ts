/**
 * Where and how this company asks to be paid, reduced to what a customer may
 * be told -- the SAME reduction quote-view applies to the page, for the same
 * reasons, so the email can never show a payment destination the page would
 * not.
 *
 * THIS IS A COPY of publicPaymentMethods() in ../quote-view/index.ts, and the
 * reason it is a copy is a constraint, not a preference: the test harnesses
 * that run quote-view (a15, a29, a38, a47, accepted-price-functions and
 * money-push-audience) load that file with a fixed list of allowed imports and
 * fail on any new module, so the original cannot be moved into a shared module
 * without editing six test files this change does not own.
 * tests/a55-approval-email-builder.test.mjs runs both functions over the same
 * inputs -- the payment-method fixtures from a38, every character code from 0
 * to 65535 through the invisible-character filter, and a fuzz of malformed
 * blocks -- and fails if they ever disagree. When the two can be merged,
 * delete this file and import the original.
 *
 * What goes out, and ONLY this (all four, nothing else, ever):
 *   cashApp  "$Tag"   a Cash App $cashtag is handed out so people can pay it
 *   zelle    "..."    the phone and/or email the company's Zelle is registered to
 *   wire     "..."    free text: bank, account name, routing and account
 *                     number. Bank details reach the customer KNOWINGLY: they
 *                     are what a company gives a customer so the customer can
 *                     wire it money.
 *   cash     boolean  "we take cash"
 *
 * A method is included only when the owner switched it ON (=== true, not
 * merely truthy) AND filled it in. Off, empty, malformed or over-long all come
 * out as "" / false. An over-long value is DROPPED, never cut short: half a
 * bank account number is a payment sent nowhere.
 *
 * (Built without backslash-u escapes on purpose: see the note at the top of
 * email.ts. The character set is the one quote-view's regex spells out.)
 */

import type { PaymentMethodsFact } from "./email.ts";

const ch = (n: number) => String.fromCharCode(n);
const span = (a: number, b?: number) => (b === undefined ? ch(a) : `${ch(a)}-${ch(b)}`);

/**
 * Control characters except tab, line feed and carriage return; the soft
 * hyphen; zero-width and bidirectional marks; the line and paragraph
 * separators; the byte-order mark. They arrive when a handle or address is
 * pasted from a text message, they make a $cashtag fail to match without
 * anyone being able to see why, and a right-to-left override can make an
 * address read differently from what it is.
 */
export const INVISIBLE_CHARS = new RegExp(
  "[" + [
    span(0x0000, 0x0008), span(0x000B), span(0x000C), span(0x000E, 0x001F), span(0x007F),
    span(0x00AD), span(0x200B, 0x200F), span(0x2028), span(0x2029), span(0x202A, 0x202E),
    span(0x2060, 0x2069), span(0xFEFF),
  ].join("") + "]",
  "g",
);

const CASH_APP_TAG = /^[A-Za-z0-9_.-]{1,30}$/;
const MAX_ZELLE_CHARS = 200;
const MAX_WIRE_CHARS = 1500;

export function publicPaymentMethods(raw: unknown): PaymentMethodsFact {
  const out: PaymentMethodsFact = { cashApp: "", zelle: "", wire: "", cash: false };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const stored = raw as Record<string, unknown>;
  // The method's own object, but only when it is switched on.
  const switchedOn = (key: string): Record<string, unknown> | null => {
    const m = stored[key];
    if (!m || typeof m !== "object" || Array.isArray(m)) return null;
    return (m as Record<string, unknown>).on === true ? m as Record<string, unknown> : null;
  };
  const text = (v: unknown) => typeof v === "string" ? v.replace(INVISIBLE_CHARS, "") : "";

  const cashApp = switchedOn("cash_app");
  if (cashApp) {
    const tag = text(cashApp.tag).trim().replace(/^\$+/, "");
    if (CASH_APP_TAG.test(tag)) out.cashApp = "$" + tag;
  }

  const zelle = switchedOn("zelle");
  if (zelle) {
    // One line. Not classified as phone or email and not validated: the bank's
    // own Zelle screen works out which it is, and a company may give both.
    const to = text(zelle.to).replace(/\s+/g, " ").trim();
    if (to.length > 0 && to.length <= MAX_ZELLE_CHARS) out.zelle = to;
  }

  const wire = switchedOn("wire");
  if (wire) {
    // Free text, line breaks kept. A bank's wording is the owner's to paste;
    // this only tidies it (line endings, stray spaces, runs of blank lines).
    const lines = text(wire.details).replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
    while (lines.length && lines[0] === "") lines.shift();
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    const details = lines.join("\n").replace(/\n{3,}/g, "\n\n");
    if (details.length > 0 && details.length <= MAX_WIRE_CHARS) out.wire = details;
  }

  out.cash = switchedOn("cash") !== null;
  return out;
}
