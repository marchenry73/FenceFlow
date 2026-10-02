/**
 * The email a customer gets the moment they approve their quote: the contract,
 * the total price, the deposit required to start, and how to pay it.
 *
 * Pure. No Deno, no network, no clock, no database: facts in, words out, so
 * tests/a55-approval-email-builder.test.mjs runs it under plain Node and can
 * read every line it can ever produce, in all three languages.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THIS FILE EXISTS TO KEEP
 * ---------------------------------------------------------------------------
 * The deposit is ONE figure. The owner's rule (the deposit is the materials
 * rounded up to the next $100, plus another $100 for scheduling and
 * transport) is his own business, and he was explicit that the customer must
 * NEVER see it taken apart. So:
 *
 *   - ContractFacts has exactly one deposit field, `deposit`, plus
 *     `depositDue` (what is still owed on it after payments). Both are the
 *     STORED deposit, as quote-view serves it. There is no field for
 *     materials, for a rounding, for an extra amount or for a reason.
 *   - Nothing in this file imports the rule (ruleDeposit and friends live in
 *     _shared/quote-deposit.ts and are deliberately not reachable from here).
 *   - No sentence in any language gives the rule away: no transport, no
 *     surcharge, no rounding, no second amount, and no BASIS for the figure
 *     ("the cost of the materials", "calculated from ..."). What a sentence
 *     MAY do is say what the money is for -- it reserves a place in the queue
 *     and buys the materials, the rest is labour -- because the owner asked
 *     for exactly that and the purpose cannot be run backwards into the
 *     arithmetic. tests/a55-approval-email-builder.test.mjs reads every
 *     string this module can print and fails if one crosses that line, and
 *     feeds it poisoned extra fields to prove it reads nothing but the
 *     whitelist. tests/a67-deposit-purpose-sentence.test.mjs holds the
 *     purpose sentence itself to the same standard on all four surfaces.
 *
 * Figures the email states, and ONLY these: the total, the deposit, and --
 * only when part of the deposit has already come in -- what has been received
 * and what is left. The page's "left to pay" figure is deliberately not
 * restated: it is a different number from "total minus deposit", and a second
 * derived figure in a second place is how two surfaces come to disagree.
 *
 * Everything that arrives here from a person (the customer's typed name, a
 * run's label, the company's wire instructions) goes into PLAIN TEXT. The HTML
 * twin is made later by composeBody()/textToHtml(), which escapes it; no
 * markup is ever built here, so nothing typed by anybody can become markup.
 *
 * (No backslash-u escapes in this file on purpose: the character classes use
 * Unicode property escapes instead. A literal U+2028 inside a regex literal
 * is a syntax error, and an editor that "helpfully" decodes an escape into the
 * character it stands for would turn a working file into one that cannot load.)
 */

export type Lang = "en" | "es" | "fr";
export const LANGS: readonly Lang[] = ["en", "es", "fr"];
const isLang = (v: unknown): v is Lang => v === "en" || v === "es" || v === "fr";

/**
 * The language of the email: the page's own choice when it says one, else the
 * browser's Accept-Language (the approval request carries it), else English.
 * Only en/es/fr are ever returned -- the three the quote page speaks.
 */
export function pickLang(requested: unknown, acceptLanguage: unknown): Lang {
  const asked = typeof requested === "string" ? requested.trim().slice(0, 2).toLowerCase() : "";
  if (isLang(asked)) return asked;
  const header = String(acceptLanguage ?? "").slice(0, 300);
  const ranked = header.split(",").map((part, index) => {
    const [tag, ...params] = part.trim().split(";");
    const q = params.map((p) => /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p)).find(Boolean);
    const weight = q ? Number(q[1]) : 1;
    return { lang: tag.trim().slice(0, 2).toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, index };
  }).filter((r) => isLang(r.lang) && r.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  return (ranked[0]?.lang as Lang | undefined) ?? "en";
}

// ---------------------------------------------------------------------------
// The facts.
// ---------------------------------------------------------------------------

export interface RunFact {
  teardown: boolean;
  label: string;
  type: string;
  finish: string;
  /** fence_runs.points_encoded, "x:y,x:y". */
  points: string;
  /** fence_runs.gates_encoded: one comma-separated entry per gate. */
  gates: string;
  closed: boolean;
  heightFt: number;
  manualFeet: number;
}

/** What quote-view's publicPaymentMethods() returns: all four, "" / false when off or empty. */
export interface PaymentMethodsFact {
  cashApp: string;
  zelle: string;
  wire: string;
  cash: boolean;
}

export interface ContractFacts {
  companyName: string;
  companyPhone: string;
  customerName: string;
  address: string;
  /** quote_approved_name: what the customer typed. */
  approvedBy: string;
  /** quote_approved_at, ISO. */
  approvedAt: string;
  /** IANA zone the approval date is written in. */
  timeZone: string;
  runs: RunFact[];
  pxPerFoot: number;
  /** The total the customer accepted (the same figure the page shows). */
  total: number;
  /** The deposit as the page shows it ("Deposit to begin"). ONE figure. */
  deposit: number;
  /** What is still owed on that deposit after payments and refunds. */
  depositDue: number;
  /**
   * depositFigures().balance -- what is left on the WHOLE job once payments
   * and refunds are counted, the same figure the quote page labels "Balance
   * due". Absent reads as nothing to say, so an older caller that does not
   * pass it produces exactly the email it did before.
   */
  balance?: number;
  payments: PaymentMethodsFact;
  /** Whether the quote page has a working card button (a connected processor). */
  cardOnline: boolean;
  /** https://<site>/quote.html?t=<token> */
  quoteUrl: string;
}

// ---------------------------------------------------------------------------
// Cleaning what people typed.
// ---------------------------------------------------------------------------

// Control characters, invisible "format" characters (zero-width, bidirectional
// overrides, soft hyphen, byte-order mark) and line / paragraph separators.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
// A link in a name the CUSTOMER typed would be turned into a clickable link by
// the HTML twin of an email that arrives from the company. Only that one
// field is cleaned this way: the company's own wording (a label, its wire
// instructions) is the company's to write, links included, exactly as on the
// quote page.
const LINKISH = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*/gi;

/** One line of typing, fit for a plain-text email: control and invisible characters gone, whitespace collapsed, at most `max` characters. */
export function oneLine(raw: unknown, max: number): string {
  const s = String(raw ?? "").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  return Array.from(s).slice(0, max).join("").trim();
}

/** oneLine, and no links: for what the customer typed (the name they approved with). */
export function typedByCustomer(raw: unknown, max: number): string {
  return oneLine(String(raw ?? "").replace(INVISIBLE, " ").replace(LINKISH, ""), max);
}

/** Several lines of the company's own wording (a bank's wire instructions): line breaks kept. */
function lines(raw: unknown, maxLines: number, maxChars: number): string[] {
  return String(raw ?? "").replace(/\r\n?/g, "\n").split("\n")
    .map((l) => oneLine(l, maxChars)).filter((l) => l !== "").slice(0, maxLines);
}

/** A link we built ourselves (the quote page): https only, no spaces, no markup characters. Anything else is no link at all. */
export function safeUrl(raw: unknown): string {
  const s = String(raw ?? "").trim();
  return /^https:\/\/[^\s<>"'\\]{1,400}$/.test(s) ? s : "";
}

/** "j***@gmail.com": enough for her to recognise it, not enough to learn it. */
export function maskEmail(address: string): string {
  const s = String(address ?? "").trim();
  const at = s.lastIndexOf("@");
  if (at < 1) return "";
  return `${Array.from(s.slice(0, at))[0]}***${s.slice(at)}`;
}

// ---------------------------------------------------------------------------
// The scope, worked out exactly as the quote page works it out.
// ---------------------------------------------------------------------------

/** A run's length in feet: typed measurement first, else the drawing's pixels at the job's calibration. quote.html's runFeet(), same arithmetic. */
export function runFeet(r: Pick<RunFact, "manualFeet" | "points" | "closed">, pxPerFoot: number): number {
  let ft = Number(r.manualFeet) || 0;
  if (!ft && r.points) {
    const pts = String(r.points).split(",").map((p) => p.split(":").map(Number));
    let px = 0;
    for (let i = 1; i < pts.length; i++) px += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (r.closed && pts.length > 2) {
      px += Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
    }
    ft = px / (Number(pxPerFoot) || 20);
  }
  return Number.isFinite(ft) ? ft : 0;
}

export const gateCount = (r: Pick<RunFact, "gates">): number =>
  String(r.gates ?? "").split(",").filter((g) => g.trim()).length;

/** "WOOD_PRIVACY" -> "Wood Privacy", as the page prints it. */
export const typeLabel = (t: unknown): string =>
  String(t ?? "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export interface ScopeRow {
  teardown: boolean;
  type: string;
  finish: string;
  label: string;
  heightFt: number;
  feet: number;
  gates: number;
}

/** The runs as printable rows, in an order that does not depend on how the database happened to return them. */
export function scopeRows(runs: readonly RunFact[], pxPerFoot: number): ScopeRow[] {
  return (runs ?? []).map((r) => ({
    teardown: !!r.teardown,
    type: oneLine(typeLabel(r.type), 40),
    finish: oneLine(r.finish, 40),
    label: oneLine(r.label, 60),
    heightFt: Number(r.heightFt) || 6,
    feet: Math.round(runFeet(r, pxPerFoot)),
    gates: gateCount(r),
  })).sort((a, b) =>
    Number(a.teardown) - Number(b.teardown) || a.type.localeCompare(b.type) || a.finish.localeCompare(b.finish) ||
    a.label.localeCompare(b.label) || a.heightFt - b.heightFt || a.feet - b.feet || a.gates - b.gates
  );
}

/** The fence being INSTALLED: a teardown run is old fence coming out. */
export function installTotals(rows: readonly ScopeRow[]): { feet: number; gates: number } {
  return rows.filter((r) => !r.teardown).reduce((t, r) => ({ feet: t.feet + r.feet, gates: t.gates + r.gates }), { feet: 0, gates: 0 });
}

// ---------------------------------------------------------------------------
// Money and dates.
// ---------------------------------------------------------------------------

/** "$5,000.00", in every language: the quote page prints US dollars the same way whatever the language. */
export const money = (n: number): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number.isFinite(n) ? n : 0);

const cents = (n: number): number => Math.round((Number(n) || 0) * 100);

const LOCALE: Record<Lang, string> = { en: "en-US", es: "es-US", fr: "fr-FR" };

/** The approval date as a person writes it, in the company's time zone -- not UTC, which turns an evening approval into tomorrow. */
export function longDate(iso: string, lang: Lang, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const make = (tz: string | undefined) =>
    new Intl.DateTimeFormat(LOCALE[lang], { year: "numeric", month: "long", day: "numeric", ...(tz ? { timeZone: tz } : {}) }).format(d);
  try {
    return make(timeZone);
  } catch {
    return make("America/New_York");
  }
}

// ---------------------------------------------------------------------------
// The words. Every sentence the email can print is in this table, per
// language, so a test can read all of it. Nothing below states an amount
// beyond the total and the deposit, names a surcharge or a transport charge,
// or says what the deposit was worked out FROM -- and nothing may be added
// that does. Saying what the money BUYS is allowed and deliberate.
// ---------------------------------------------------------------------------

interface Words {
  /** Between a label and its value: French puts a space before the colon. */
  sep: string;
  subject: (company: string) => string;
  hello: (first: string) => string;
  intro: (company: string) => string;
  agreement: string;
  customer: string;
  property: string;
  approvedBy: (name: string, date: string) => string;
  scope: string;
  scopeSoon: string;
  fence: (type: string) => string;
  removeOld: (type: string) => string;
  tall: (ft: number) => string;
  gates: (n: number) => string;
  about: (ft: number) => string;
  totalLength: (ft: number) => string;
  price: string;
  total: string;
  deposit: string;
  /**
   * The label for depositFigures().balance. The SAME WORDS the quote page
   * uses for the same figure (quote.html's balanceDue: "Left to pay" / "Queda
   * por pagar" / "Reste à payer"), because she reads the email and the page
   * side by side and two labels for one number is how a figure starts looking
   * like two.
   */
  balance: string;
  depositReceived: (paid: string, due: string) => string;
  /**
   * WHAT the deposit is for, in plain words -- never how it was worked out.
   *
   * The owner asked for this in his own words: "let the customer [know] the
   * deposit is to put you on the schedule and to get the materials, the rest
   * is for labor". The PURPOSE is his to tell; the ARITHMETIC is not. So this
   * sentence names what the money buys and stops: no figure, no second
   * amount, no percentage, no basis ("the cost of the materials"), nothing a
   * reader could run backwards to find the extra hundred.
   *
   * It also promises a PLACE in the queue, not a DATE. He schedules jobs
   * himself and the weather moves them; a customer who reads a date into this
   * is a customer disappointed by the first rain.
   *
   * Printed only when a deposit is actually being asked for -- see the
   * `deposit > 0.005` gate in buildApprovalEmail.
   */
  depositPurpose: string;
  asOf: (date: string) => string;
  howToPay: string;
  cashApp: string;
  zelle: string;
  wire: string;
  cash: string;
  cashHow: (company: string) => string;
  nameNote: string;
  card: (url: string) => string;
  contact: (company: string, phone: string) => string;
  next: (company: string) => string;
  quoteLink: (url: string) => string;
  questions: (company: string, phone: string) => string;
}

const WORDS: Record<Lang, Words> = {
  en: {
    sep: ": ",
    subject: (c) => `Your approved fence quote from ${c}`,
    hello: (n) => (n ? `Hi ${n},` : "Hello,"),
    intro: (c) =>
      `Thank you for approving your fence quote with ${c}. This email is your copy of what you agreed to - please keep it.`,
    agreement: "Your agreement",
    customer: "Customer",
    property: "Property address",
    approvedBy: (n, d) => `Approved by ${n}${d ? ` on ${d}` : ""}.`,
    scope: "Scope of work",
    scopeSoon: "Full details of the work to follow.",
    fence: (t) => `${t} fence`,
    removeOld: (t) => `Remove old ${t} fence`,
    tall: (ft) => `${ft} ft tall`,
    gates: (n) => `${n} ${n === 1 ? "gate" : "gates"}`,
    about: (ft) => `about ${ft} ft`,
    totalLength: (ft) => `Total length: ${ft} ft`,
    price: "Price",
    total: "Total price",
    deposit: "Deposit required to start",
    balance: "Left to pay",
    depositReceived: (p, d) => `${p} of the deposit has already been received; ${d} is still due.`,
    depositPurpose: "Your deposit reserves your place on the schedule and pays for the materials. The rest covers the labor.",
    asOf: (d) => `The amounts above are as of ${d}. If you have paid since, ask us what is still due.`,
    howToPay: "How to pay",
    cashApp: "Cash App",
    zelle: "Zelle",
    wire: "Wire transfer",
    cash: "Cash",
    cashHow: (c) => `Cash is accepted. Ask ${c} when and where to hand it over.`,
    nameNote: "Please put your name in the payment note so we can match it to this quote.",
    card: (u) => `You can also pay the deposit by card from your quote page: ${u}`,
    contact: (c, p) => `To arrange payment, contact ${c}${p ? ` at ${p}` : ""}.`,
    next: (c) => `Next, ${c} will be in touch to arrange the work.`,
    quoteLink: (u) => `Your quote, any time: ${u}`,
    questions: (c, p) => `Questions? Just reply to this email${p ? `, or call ${c} at ${p}` : ""}.`,
  },
  es: {
    sep: ": ",
    subject: (c) => `Su presupuesto de cerca aprobado con ${c}`,
    hello: (n) => (n ? `Hola ${n},` : "Hola,"),
    intro: (c) =>
      `Gracias por aprobar su presupuesto de cerca con ${c}. Este correo es su copia de lo que aceptó; por favor, consérvelo.`,
    agreement: "Su acuerdo",
    customer: "Cliente",
    property: "Dirección de la propiedad",
    approvedBy: (n, d) => `Aprobado por ${n}${d ? ` el ${d}` : ""}.`,
    scope: "Alcance del trabajo",
    scopeSoon: "El detalle completo del trabajo se enviará a continuación.",
    fence: (t) => `Cerca ${t}`,
    removeOld: (t) => `Quitar la cerca ${t} existente`,
    tall: (ft) => `${ft} pies de alto`,
    gates: (n) => `${n} ${n === 1 ? "portón" : "portones"}`,
    about: (ft) => `unos ${ft} pies`,
    totalLength: (ft) => `Longitud total: ${ft} pies`,
    price: "Precio",
    total: "Precio total",
    deposit: "Depósito requerido para empezar",
    balance: "Queda por pagar",
    depositReceived: (p, d) => `Ya se recibieron ${p} del depósito; quedan ${d} por pagar.`,
    depositPurpose: "Su depósito aparta su turno en la agenda y paga los materiales. El resto cubre la mano de obra.",
    asOf: (d) => `Los importes de arriba son los del ${d}. Si ya pagó desde entonces, pregúntenos cuánto queda por pagar.`,
    howToPay: "Cómo pagar",
    cashApp: "Cash App",
    zelle: "Zelle",
    wire: "Transferencia bancaria",
    cash: "Efectivo",
    cashHow: (c) => `Se acepta efectivo. Pregunte a ${c} cuándo y dónde entregarlo.`,
    nameNote: "Escriba su nombre en la nota del pago para que podamos asociarlo con este presupuesto.",
    card: (u) => `También puede pagar el depósito con tarjeta desde su presupuesto: ${u}`,
    contact: (c, p) => `Para coordinar el pago, comuníquese con ${c}${p ? ` al ${p}` : ""}.`,
    next: (c) => `A continuación, ${c} se pondrá en contacto para coordinar el trabajo.`,
    quoteLink: (u) => `Su presupuesto, cuando quiera: ${u}`,
    questions: (c, p) => `¿Preguntas? Responda a este correo${p ? `, o llame a ${c} al ${p}` : ""}.`,
  },
  fr: {
    sep: " : ",
    subject: (c) => `Votre devis de clôture validé avec ${c}`,
    hello: (n) => (n ? `Bonjour ${n},` : "Bonjour,"),
    intro: (c) =>
      `Merci d’avoir validé votre devis de clôture avec ${c}. Ce courriel est votre copie de ce que vous avez accepté ; veuillez le conserver.`,
    agreement: "Votre accord",
    customer: "Client",
    property: "Adresse du chantier",
    approvedBy: (n, d) => `Validé par ${n}${d ? ` le ${d}` : ""}.`,
    scope: "Étendue des travaux",
    scopeSoon: "Le détail complet des travaux suivra.",
    fence: (t) => `Clôture ${t}`,
    removeOld: (t) => `Retirer l’ancienne clôture ${t}`,
    tall: (ft) => `${ft} pi de haut`,
    gates: (n) => `${n} ${n === 1 ? "portail" : "portails"}`,
    about: (ft) => `environ ${ft} pi`,
    totalLength: (ft) => `Longueur totale : ${ft} pi`,
    price: "Prix",
    total: "Prix total",
    deposit: "Acompte requis pour démarrer",
    balance: "Reste à payer",
    depositReceived: (p, d) => `${p} de l’acompte ont déjà été reçus ; il reste ${d} à payer.`,
    depositPurpose: "Votre acompte réserve votre place dans le planning et paie les matériaux. Le reste couvre la main-d’œuvre.",
    asOf: (d) => `Les montants ci-dessus sont ceux du ${d}. Si vous avez déjà payé depuis, demandez-nous ce qu’il reste à payer.`,
    howToPay: "Comment payer",
    cashApp: "Cash App",
    zelle: "Zelle",
    wire: "Virement bancaire",
    cash: "Espèces",
    cashHow: (c) => `Les espèces sont acceptées. Demandez à ${c} quand et où les remettre.`,
    nameNote: "Indiquez votre nom dans la note du paiement afin que nous puissions le rattacher à ce devis.",
    card: (u) => `Vous pouvez aussi payer l’acompte par carte depuis votre devis : ${u}`,
    contact: (c, p) => `Pour organiser le paiement, contactez ${c}${p ? ` au ${p}` : ""}.`,
    next: (c) => `Ensuite, ${c} vous contactera pour organiser les travaux.`,
    quoteLink: (u) => `Votre devis, à tout moment : ${u}`,
    questions: (c, p) => `Des questions ? Répondez simplement à ce courriel${p ? `, ou appelez ${c} au ${p}` : ""}.`,
  },
};

/** Every sentence template in every language, for the wording test to read. Not used at runtime. */
export const ALL_WORDS: Readonly<Record<Lang, Words>> = WORDS;

// ---------------------------------------------------------------------------
// The email.
// ---------------------------------------------------------------------------

export interface ApprovalEmail {
  subject: string;
  /** Plain text. composeBody() adds the footer and makes the HTML twin. */
  text: string;
}

export function buildApprovalEmail(facts: ContractFacts, lang: Lang): ApprovalEmail {
  const l: Lang = isLang(lang) ? lang : "en";
  const w = WORDS[l];
  const company = oneLine(facts.companyName, 70) || (l === "es" ? "su contratista" : l === "fr" ? "votre entreprise" : "your contractor");
  const phone = oneLine(facts.companyPhone, 40);
  const customer = oneLine(facts.customerName, 80);
  const first = customer.split(" ")[0] ?? "";
  const address = oneLine(facts.address, 160);
  const approvedBy = typedByCustomer(facts.approvedBy, 80) || customer;
  const date = longDate(facts.approvedAt, l, facts.timeZone);
  const rows = scopeRows(facts.runs, facts.pxPerFoot);
  const totals = installTotals(rows);
  const out: string[] = [];
  const blank = () => {
    if (out.length && out[out.length - 1] !== "") out.push("");
  };
  const heading = (s: string) => {
    blank();
    out.push(s.toLocaleUpperCase(LOCALE[l]));
  };

  out.push(w.hello(first), "", w.intro(company));

  heading(w.agreement);
  if (customer) out.push(`${w.customer}${w.sep}${customer}`);
  if (address) out.push(`${w.property}${w.sep}${address}`);
  out.push(w.approvedBy(approvedBy, date));

  heading(w.scope);
  if (!rows.length) out.push(w.scopeSoon);
  for (const r of rows) {
    const head = r.teardown ? w.removeOld(r.type) : w.fence(r.type);
    const parts = [r.finish ? `${head}, ${r.finish}` : head, w.tall(r.heightFt)];
    if (r.gates) parts.push(w.gates(r.gates));
    if (r.feet) parts.push(w.about(r.feet));
    out.push(`- ${parts.join(" - ")}${r.label ? ` (${r.label})` : ""}`);
  }
  if (totals.feet > 0) out.push("", w.totalLength(totals.feet));

  heading(w.price);
  out.push(`${w.total}${w.sep}${money(facts.total)}`);
  // The contractor's own figure, one line. A job with no deposit asked for
  // says nothing about one, exactly like the quote page.
  const deposit = Number(facts.deposit) || 0;
  if (deposit > 0.005) {
    out.push(`${w.deposit}${w.sep}${money(deposit)}`);
    const due = Math.max(0, Number(facts.depositDue) || 0);
    if (due < deposit - 0.005) out.push(w.depositReceived(money(deposit - due), money(due)));
    // WHAT the money is for, under the figure it explains, and inside this
    // gate on purpose: a sentence explaining a deposit that is not being
    // asked for is noise on the five of his jobs that ask for nothing.
    // Carries no figure of its own -- see the comment on Words.depositPurpose.
    out.push(w.depositPurpose);
  }
  // What is left on the WHOLE job. Outside the deposit block on purpose -- the
  // same rule the page follows (five of his jobs ask for no deposit and still
  // owe the whole price). Omitted when there is nothing left to pay rather
  // than printed as $0.00, again as the page does: a zero in a money column
  // reads as a figure somebody forgot to fill in. Omitted too when the caller
  // did not pass it, so an older deploy's email is unchanged.
  const balance = Number(facts.balance);
  if (Number.isFinite(balance) && balance > 0.005) out.push(`${w.balance}${w.sep}${money(balance)}`);
  out.push("", w.asOf(date));

  const pay = facts.payments;
  const methods: string[] = [];
  const addMethod = (label: string, body: string[]) => {
    if (body.length === 1) methods.push(`${label}${w.sep}${body[0]}`);
    else methods.push(`${label}${w.sep.trimEnd()}`, ...body.map((x) => `  ${x}`));
  };
  const cashApp = oneLine(pay?.cashApp, 40);
  if (cashApp) addMethod(w.cashApp, [cashApp]);
  const zelle = oneLine(pay?.zelle, 200);
  if (zelle) addMethod(w.zelle, [zelle]);
  const wire = lines(pay?.wire, 20, 200);
  if (wire.length) addMethod(w.wire, wire);
  if (pay?.cash === true) addMethod(w.cash, [w.cashHow(company)]);
  const link = safeUrl(facts.quoteUrl);
  const card = facts.cardOnline === true && link !== "";

  if (methods.length || card) {
    heading(w.howToPay);
    out.push(...methods);
    if (card) out.push(...(methods.length ? [""] : []), w.card(link));
    // "Put your name in the note" makes no sense for handing over cash.
    if (cashApp || zelle || wire.length) out.push("", w.nameNote);
  } else {
    blank();
    out.push(w.contact(company, phone));
  }

  blank();
  out.push(w.next(company));
  if (link) out.push(w.quoteLink(link));
  out.push("", w.questions(company, phone), "", company);

  return {
    subject: w.subject(company).replace(/\s+/g, " ").trim().slice(0, 200),
    text: out.join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Which contract this is.
// ---------------------------------------------------------------------------

/**
 * A fingerprint of what the email STATES -- the property, the scope, the total
 * and the deposit -- and nothing else: not the name, not the date, not the
 * language, not who approved. Two approvals of the same contract have the same
 * key (so approving, withdrawing and approving again does not email her again
 * and again), and an approval of a CHANGED contract has a different one (so
 * she is never left holding a copy with the old price on it).
 */
export async function contractKey(facts: ContractFacts): Promise<string> {
  const rows = scopeRows(facts.runs, facts.pxPerFoot);
  const canonical = JSON.stringify({
    v: 1,
    address: oneLine(facts.address, 160).toLowerCase(),
    total: cents(facts.total),
    deposit: cents(facts.deposit),
    scope: rows.map((r) => [r.teardown ? 1 : 0, r.type, r.finish, r.heightFt, r.feet, r.gates]),
  });
  return await sha256Hex(canonical);
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
