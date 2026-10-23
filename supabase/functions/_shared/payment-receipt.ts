/**
 * THE RECEIPT. What the customer gets when money lands.
 *
 * "After customer pays, they should receive a receipt on their email and it
 *  should look like a company made it."
 * "...and it should also send an email when the person make a payment even if
 *  it was a test one"
 *
 * There was no receipt anywhere in this product -- not from either webhook,
 * not from the app, not from the office -- and he takes Zelle, Cash App and
 * cash by hand as well, so for most payments the only record she had was her
 * own bank statement.
 *
 * WHAT THIS FILE IS, AND IS NOT. It is the WORDS and nothing else: the text of
 * the receipt, in three languages, as a pure function of facts. It does not
 * read the database, does not send, and does not decide whether a receipt is
 * owed -- the caller claims the send (public.claim_payment_receipt, see
 * supabase_r34_receipt_claim_on_stripe_row.sql) and hands the plain text to
 * mail's composeBody(), which makes the branded HTML twin with his logo and
 * his colour. That split is what lets every sentence be tested without a
 * network, a key or a row.
 *
 * A FIGURE BELONGS IN A RECEIPT. The quote-send email is forbidden from naming
 * one -- see _shared/email-templates.ts, where the price is still moving while
 * the letter sits in her inbox -- and the opposite is true here: a receipt with
 * no amount on it is not a receipt. What is still owed is named only when the
 * caller is sure of it, because that one CAN go stale, and a receipt that
 * understates the balance reads as a discount.
 *
 * A TEST PAYMENT'S RECEIPT GOES TO HIM, NOT TO HER, and the caller enforces
 * that. This file marks it: [TEST] in the subject, and a first line saying no
 * money moved. Emailing a real customer a receipt for a payment she never made
 * is a false record of money, whoever asked for it.
 */

export type Lang = "en" | "es" | "fr";
export const LANGS: readonly Lang[] = ["en", "es", "fr"];

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function oneLine(raw: unknown, max: number): string {
  const s = String(raw ?? "").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  return Array.from(s).slice(0, max).join("").trim();
}

const LINKISH = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*/gi;

/**
 * oneLine, and no links: for text a STRANGER typed.
 *
 * lead-intake runs with verify_jwt = false and writes customer_name and
 * address straight onto a new job from the public website form, so both are
 * stranger-typed. A link in either would become clickable in the HTML twin of
 * an email arriving from HIS company. Same line quote-email.mjs draws.
 */
export function typedByStranger(raw: unknown, max: number): string {
  return oneLine(String(raw ?? "").replace(INVISIBLE, " ").replace(LINKISH, ""), max);
}

export const NAME_MAX = 120;
export const ADDRESS_MAX = 200;
export const PHONE_MAX = 40;

export const money = (n: number): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
    .format(Number.isFinite(n) ? n : 0);

const LOCALE: Record<Lang, string> = { en: "en-US", es: "es-US", fr: "fr-FR" };

/**
 * The payment's date as a person writes it, in the company's time zone -- not
 * UTC, which turns an evening payment into tomorrow on the receipt for it.
 */
export function longDate(iso: string, lang: Lang, timeZone?: string): string {
  // A NON-EMPTY STRING, checked before Date sees it. new Date(null) is not an
  // invalid date -- it is EPOCH 0 -- and new Date(undefined) is NaN while
  // new Date("") is NaN too, so the three arrive differently. Without this a
  // payment whose paid_at had not been written yet produced a receipt dated
  // 1 January 1970, which is worse than a receipt with no date on it.
  if (typeof iso !== "string" || !iso.trim()) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const make = (tz: string | undefined) =>
    new Intl.DateTimeFormat(LOCALE[lang], {
      year: "numeric", month: "long", day: "numeric", ...(tz ? { timeZone: tz } : {}),
    }).format(d);
  try {
    return make(timeZone);
  } catch {
    return make("America/New_York");
  }
}

/**
 * HOW the money arrived, in her language.
 *
 * The keys are the ones the ledger stores (payment_records.method) plus the
 * two the processors report. An unrecognised method falls back to a sentence
 * with no method in it rather than printing the raw enum at a customer -- she
 * does not need to read BANK_TRANSFER.
 */
export type Method =
  | "CARD" | "CASH" | "CHECK" | "BANK_TRANSFER" | "ZELLE" | "CASHAPP" | "OTHER";

const METHOD_WORDS: Record<Lang, Partial<Record<Method, string>>> = {
  en: {
    CARD: "card", CASH: "cash", CHECK: "check", BANK_TRANSFER: "bank transfer",
    ZELLE: "Zelle", CASHAPP: "Cash App",
  },
  es: {
    CARD: "tarjeta", CASH: "efectivo", CHECK: "cheque", BANK_TRANSFER: "transferencia bancaria",
    ZELLE: "Zelle", CASHAPP: "Cash App",
  },
  fr: {
    CARD: "carte", CASH: "espèces", CHECK: "chèque", BANK_TRANSFER: "virement bancaire",
    ZELLE: "Zelle", CASHAPP: "Cash App",
  },
};

export function methodWord(method: unknown, lang: Lang): string {
  const key = String(method ?? "").toUpperCase().replace(/[^A-Z_]/g, "") as Method;
  return METHOD_WORDS[lang]?.[key] ?? "";
}

export interface ReceiptFacts {
  companyName: string;
  companyPhone?: string | null;
  customerName?: string | null;
  /** The job's address, so she can tell two jobs apart on two receipts. */
  address?: string | null;
  /** What arrived, in dollars. The one figure this letter exists to state. */
  amount: number;
  method?: unknown;
  /** ISO 8601. The payment's own time, never "now". */
  paidAt: string;
  /** The company's time zone, for the date. */
  timeZone?: string | null;
  /**
   * What is left on the job after this payment, in dollars -- or null when the
   * caller cannot be sure. Null prints no balance line at all, which is the
   * honest answer: a figure that has gone stale between the payment and the
   * send would read as a discount she can hold the company to.
   */
  stillOwed?: number | null;
  /**
   * Stripe (or Square) test mode. Marks the letter, and the caller sends it to
   * the COMPANY rather than to the customer.
   */
  test?: boolean;
}

interface Words {
  subject: (company: string) => string;
  subjectTest: (company: string) => string;
  testNote: string;
  hello: (name: string) => string;
  /** The line that is the receipt. Amount first -- it is what she opened this for. */
  received: (amount: string, company: string) => string;
  on: (date: string) => string;
  by: (method: string) => string;
  forJob: (address: string) => string;
  stillOwed: (amount: string) => string;
  settled: string;
  keep: string;
  questions: (company: string, phone: string) => string;
}

const RECEIPT: Record<Lang, Words> = {
  en: {
    subject: (c) => `Your payment receipt from ${c}`,
    subjectTest: (c) => `[TEST] Payment receipt from ${c} -- no money moved`,
    testNote:
      "This is a TEST receipt. It was produced by a test-mode card payment, " +
      "nothing has been charged to anyone, and nothing has been recorded against the job. " +
      "It is here so you can see exactly what your customer will receive.",
    hello: (n) => (n ? `Hi ${n},` : "Hello,"),
    received: (a, c) => `Thank you -- ${c} has received your payment of ${a}.`,
    on: (d) => `Date: ${d}`,
    by: (m) => `Paid by: ${m}`,
    forJob: (a) => `Work at: ${a}`,
    stillOwed: (a) => `Still to pay on this job: ${a}`,
    settled: "This settles the balance on this job. Nothing further is due.",
    keep: "Keep this email as your receipt.",
    questions: (c, p) =>
      `Questions about this payment? Just reply to this email${p ? `, or call ${c} at ${p}` : ""}.`,
  },
  es: {
    subject: (c) => `Su recibo de pago de ${c}`,
    subjectTest: (c) => `[PRUEBA] Recibo de pago de ${c}: no se movió dinero`,
    testNote:
      "Este es un recibo de PRUEBA. Lo generó un pago con tarjeta en modo de prueba, " +
      "no se le cobró nada a nadie y no se registró nada en el trabajo. " +
      "Está aquí para que vea exactamente lo que recibirá su cliente.",
    hello: (n) => (n ? `Hola ${n},` : "Hola,"),
    received: (a, c) => `Gracias: ${c} ha recibido su pago de ${a}.`,
    on: (d) => `Fecha: ${d}`,
    by: (m) => `Pagado con: ${m}`,
    forJob: (a) => `Trabajo en: ${a}`,
    stillOwed: (a) => `Queda por pagar en este trabajo: ${a}`,
    settled: "Con esto queda saldado este trabajo. No queda nada por pagar.",
    keep: "Guarde este correo como su recibo.",
    questions: (c, p) =>
      `¿Preguntas sobre este pago? Responda a este correo${p ? `, o llame a ${c} al ${p}` : ""}.`,
  },
  fr: {
    subject: (c) => `Votre reçu de paiement de ${c}`,
    subjectTest: (c) => `[TEST] Reçu de paiement de ${c} : aucun montant débité`,
    testNote:
      "Ceci est un reçu de TEST. Il a été produit par un paiement par carte en mode test : " +
      "personne n’a été débité et rien n’a été enregistré sur le chantier. " +
      "Il est là pour que vous voyiez exactement ce que votre client recevra.",
    hello: (n) => (n ? `Bonjour ${n},` : "Bonjour,"),
    received: (a, c) => `Merci : ${c} a bien reçu votre paiement de ${a}.`,
    on: (d) => `Date : ${d}`,
    by: (m) => `Payé par : ${m}`,
    forJob: (a) => `Chantier : ${a}`,
    stillOwed: (a) => `Reste à payer sur ce chantier : ${a}`,
    settled: "Ce paiement solde ce chantier. Il n’y a plus rien à payer.",
    keep: "Conservez ce courriel comme reçu.",
    questions: (c, p) =>
      `Des questions sur ce paiement ? Répondez simplement à ce courriel${p ? `, ou appelez ${c} au ${p}` : ""}.`,
  },
};

export const RECEIPT_WORDS = RECEIPT;

export type ReceiptRefusal = "no_address" | "bad_address" | "no_amount" | "no_company_name";

const ADDRESS = /^[^\s<>()[\],;:\\"]+@[^\s<>()[\],;:\\"@]+\.[^\s<>()[\],;:\\"@]{2,}$/;

/**
 * Can this receipt be sent at all, and if not, why? Null when it can.
 *
 * A zero or negative amount is refused rather than printed: a $0.00 receipt is
 * not a receipt, and a negative one is a refund, which is a different letter
 * with different words and is not this.
 */
export function receiptRefusal(facts: {
  recipient?: unknown; amount?: unknown; companyName?: unknown;
}): ReceiptRefusal | null {
  const to = oneLine(facts.recipient, 320);
  if (!to) return "no_address";
  if (!ADDRESS.test(to)) return "bad_address";
  const amount = Number(facts.amount);
  if (!Number.isFinite(amount) || amount <= 0.005) return "no_amount";
  if (!oneLine(facts.companyName, NAME_MAX)) return "no_company_name";
  return null;
}

export const REFUSAL_REASON: Record<Lang, Record<ReceiptRefusal, string>> = {
  en: {
    no_address: "There is no email address on this job, so the receipt has nowhere to go. Add one in the customer's details.",
    bad_address: "The email address on this job is not a valid address, so the receipt was not sent.",
    no_amount: "There is no amount on this payment, so there is nothing to receipt.",
    no_company_name: "Add your business name in Settings first, so the receipt does not arrive from nobody.",
  },
  es: {
    no_address: "Este trabajo no tiene correo electrónico, así que el recibo no tiene a dónde ir. Agregue uno en los datos del cliente.",
    bad_address: "El correo electrónico de este trabajo no es válido, así que no se envió el recibo.",
    no_amount: "Este pago no tiene importe, así que no hay nada que recibir.",
    no_company_name: "Agregue el nombre de su negocio en Ajustes, para que el recibo no llegue sin remitente.",
  },
  fr: {
    no_address: "Ce chantier n’a pas d’adresse courriel, le reçu n’a donc nulle part où aller. Ajoutez-en une dans les coordonnées du client.",
    bad_address: "L’adresse courriel de ce chantier n’est pas valide, le reçu n’a donc pas été envoyé.",
    no_amount: "Ce paiement n’a pas de montant : il n’y a rien à attester.",
    no_company_name: "Ajoutez le nom de votre entreprise dans les Réglages, pour que le reçu n’arrive pas sans expéditeur.",
  },
};

/**
 * The receipt, in `lang`. Plain text; the branded HTML twin is composeBody's
 * job, the same as every other letter this product sends.
 */
export function buildReceiptEmail(facts: ReceiptFacts, lang: Lang): { subject: string; text: string } {
  const w = RECEIPT[lang] ?? RECEIPT.en;
  const company = oneLine(facts.companyName, NAME_MAX);
  const phone = oneLine(facts.companyPhone, PHONE_MAX);
  // Stranger-typed (lead-intake, verify_jwt = false): links removed, so one
  // cannot become clickable in an email arriving from his company.
  const name = typedByStranger(facts.customerName, NAME_MAX);
  const address = typedByStranger(facts.address, ADDRESS_MAX);
  const amount = money(Number(facts.amount));
  const date = longDate(facts.paidAt, lang, facts.timeZone ?? undefined);
  const method = methodWord(facts.method, lang);
  const test = facts.test === true;

  const lines: string[] = [];
  if (test) lines.push(w.testNote, "");
  lines.push(w.hello(name), "", w.received(amount, company), "");

  // The facts of the payment, one per line, so she can read it as a record
  // rather than hunt through a paragraph for the date.
  const block: string[] = [];
  if (date) block.push(w.on(date));
  if (method) block.push(w.by(method));
  if (address) block.push(w.forJob(address));
  if (block.length) lines.push(block.join("\n"), "");

  // The balance, only when the caller vouched for it.
  const owed = facts.stillOwed;
  if (typeof owed === "number" && Number.isFinite(owed)) {
    lines.push(owed > 0.005 ? w.stillOwed(money(owed)) : w.settled, "");
  }

  lines.push(w.keep, "", w.questions(company, phone));

  return {
    subject: (test ? w.subjectTest(company) : w.subject(company))
      .replace(/\s+/g, " ").trim().slice(0, 200),
    text: lines.join("\n"),
  };
}
