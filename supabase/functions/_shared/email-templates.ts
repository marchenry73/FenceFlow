/**
 * The emails FenceFlow writes for a contractor to send to a customer.
 *
 * Pure. No Deno, no network, no clock, no database: facts in, words out, so
 * tests/a72-quote-email.test.mjs runs it under plain Node and can read every
 * line it can ever produce, in all three languages.
 *
 * ---------------------------------------------------------------------------
 * HOW THIS FILE IS SHARED
 * ---------------------------------------------------------------------------
 * More than one track writes templates in here. Each template is its own
 * section, each with its own Words table and its own build function, and
 * nothing is shared between sections except the primitives at the top. Add a
 * section; do not edit somebody else's.
 *
 * Sections, in order:
 *   1. Primitives            (oneLine, safeUrl, LANGS, pickLang)
 *   2. THE QUOTE-SEND EMAIL  ("here is your quote" -- A72)
 *   3. THE REST OF THE SET   (re-approval, receipt, scheduled, finished -- A73)
 *
 * ---------------------------------------------------------------------------
 * WHY THE PRIMITIVES ARE A COPY
 * ---------------------------------------------------------------------------
 * `oneLine`, `safeUrl` and `pickLang` already exist, written for the approval
 * email, in supabase/functions/quote-approval-email/email.ts. They are copied
 * rather than imported because a module in `_shared/` must not depend on one
 * function's own folder: every other function importing this file would then
 * drag quote-approval-email's module graph in with it, and deleting or moving
 * that function would break senders that have nothing to do with it.
 *
 * tests/a72-quote-email.test.mjs asserts these copies behave identically to
 * the originals on the same inputs, so the two cannot drift silently. If that
 * test goes red, the originals moved and these must follow.
 *
 * (No backslash-u escapes in this file on purpose, for the same reason the
 * approval email avoids them: the character classes use Unicode property
 * escapes, and a literal U+2028 inside a regex literal is a syntax error.)
 */

// ===========================================================================
// 1. PRIMITIVES
// ===========================================================================

export type Lang = "en" | "es" | "fr";
export const LANGS: readonly Lang[] = ["en", "es", "fr"];
const isLang = (v: unknown): v is Lang => v === "en" || v === "es" || v === "fr";

/**
 * The language to write in: what the caller asked for, else the browser's
 * Accept-Language, else English. Only en/es/fr are ever returned -- the three
 * the app, the office and the quote page all speak.
 */
export function pickLang(requested: unknown, acceptLanguage?: unknown): Lang {
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

// Control characters, invisible "format" characters (zero-width, bidirectional
// overrides, soft hyphen, byte-order mark) and line / paragraph separators.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** One line of typing, fit for a plain-text email: control and invisible characters gone, whitespace collapsed, at most `max` characters. */
export function oneLine(raw: unknown, max: number): string {
  const s = String(raw ?? "").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  return Array.from(s).slice(0, max).join("").trim();
}

/** A link we built ourselves (the quote page): https only, no spaces, no markup characters. Anything else is no link at all. */
export function safeUrl(raw: unknown): string {
  const s = String(raw ?? "").trim();
  return /^https:\/\/[^\s<>"'\\]{1,400}$/.test(s) ? s : "";
}

/** Longest a name, an address or a company name may be in a line of this email. */
const LINKISH = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*/gi;

/**
 * oneLine, and no links: for text a STRANGER typed.
 *
 * A link in such text would be turned into a clickable link by the HTML twin
 * of an email that arrives from HIS company. This is not hypothetical, and it
 * is not only the customer's own typed name:
 * supabase/functions/lead-intake/index.ts runs with verify_jwt = false -- a
 * homeowner filling in the website form holds no session -- and inserts
 * customer_name, phone, email, address and notes straight onto a new job. So
 * jobs.customer_name and jobs.address are stranger-typed fields, and both are
 * printed in these emails.
 *
 * The COMPANY's own wording (its name, its phone, its wire instructions) is
 * the company's to write, links included, exactly as on the quote page. That
 * is the same line quote-approval-email/email.ts draws with its own
 * typedByCustomer.
 */
export function typedByStranger(raw: unknown, max: number): string {
  return oneLine(String(raw ?? "").replace(INVISIBLE, " ").replace(LINKISH, ""), max);
}

export const NAME_MAX = 120;
export const ADDRESS_MAX = 200;
export const PHONE_MAX = 40;

// ===========================================================================
// 2. THE QUOTE-SEND EMAIL
// ===========================================================================
/**
 * "Here is your quote." The email that carries a customer her quote LINK,
 * sent by the contractor from the phone or from the office, before she has
 * agreed to anything.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO PRICE IN THIS EMAIL, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * No total. No deposit. No balance. No percentage. Not one figure.
 *
 * This is the opposite decision to the approval email
 * (quote-approval-email/email.ts), which DOES state the total and the
 * deposit, and the difference is not taste -- it is which figures are frozen.
 *
 *   - The approval email is sent AT the moment of acceptance and is the
 *     customer's copy of the contract. Acceptance writes `accepted_total`,
 *     and from then on `billableTotal()` reads the accepted figure rather
 *     than the live one. The number is pinned by the act the email records.
 *
 *   - THIS email goes out BEFORE acceptance, and the price is still moving.
 *     Verified in the source rather than assumed: JobSync.kt's pricing block
 *     only declines to push a fresh `contract_total` over a sent quote in the
 *     branch where the OFFICE priced the job (`officePriced ->`, guarded by
 *     `if (cloudJob.quoteSentAt == null)`). The branch below it -- `else ->`,
 *     which is every job priced on the phone, i.e. nearly all of his -- calls
 *     `pushContractTotal(companyId, job.syncId, freshTotal)` with no
 *     quote_sent_at check at all. So he sends the quote at 9am, nudges a run
 *     or a catalog price at noon, and the job's total moves. A figure typed
 *     into the email at 9am is then wrong, permanently, in her inbox, while
 *     the page beside it is right.
 *
 * This project has paid for that exact shape of bug twice already and wrote
 * the rule down: quote-view invented a deposit the payment link refused, and
 * showed a "Balance due" it worked out differently from everyone else (see
 * _shared/quote-deposit.ts's own header). A second copy of a figure in a
 * second place is how the two come to disagree. The page owns every figure,
 * the page is live, and the email's job is to get her to the page.
 *
 * So instead of a number the email says, in her own language, that the page
 * always shows the current price. That sentence is true of the system as
 * built, costs nothing if he re-prices, and is why there is no figure above
 * it to contradict.
 *
 * tests/a72-quote-email.test.mjs renders this template against jobs whose
 * `depositFigures()` returns a real total and a real deposit -- so the
 * absence of a figure is proved to be a choice and not an unpriced job -- and
 * fails if any currency-shaped token reaches any line in any language.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES SAY, AND NOTHING MORE
 * ---------------------------------------------------------------------------
 * Her name; what the quote is for (the property address); the link; what the
 * page will show her; what happens if she approves; that the price on the
 * page is the current one; and how to reach him.
 *
 * NOT in it, deliberately: any date, any lead time, any warranty, any
 * cancellation window, any fee, any "we are excited", any emoji, any
 * marketing line, and no claim about when the work would start. He schedules
 * jobs himself and the weather moves them -- the approval email makes the
 * same choice and says so in its own header.
 *
 * Everything that arrives here from a person (the customer's name as he typed
 * it, the property address, his company name) goes into PLAIN TEXT, cleaned
 * by oneLine. No markup is built here at all, so nothing typed by anybody can
 * become markup. The office's compose window and mail-send's composeBody()
 * make the HTML twin later, and escape it there.
 */

/** Everything the quote-send email is allowed to know. Nothing else is read. */
export interface QuoteSendFacts {
  /** `companies.name`. */
  companyName: string;
  /** `companies.phone`. Blank is fine: the sentence drops the number. */
  companyPhone?: string | null;
  /** `jobs.customer_name`, as he typed it. Blank is fine: a plain "Hello,". */
  customerName?: string | null;
  /** `jobs.address`. Blank is fine: the sentence drops the address. */
  address?: string | null;
  /** https://<site>/quote.html?t=<jobs.quote_token> */
  quoteUrl: string;
}

/** Why a quote cannot be emailed. One code, one place, used by the phone and the office alike. */
export type QuoteSendRefusal =
  | "no_address"
  | "bad_address"
  | "no_link"
  | "no_company_name";

/** What a refusal means, in words the office and the phone both show. */
export const REFUSAL_REASON: Readonly<Record<Lang, Readonly<Record<QuoteSendRefusal, string>>>> = {
  en: {
    no_address: "There is no email address on this job, so there is nobody to send the quote to. Add one in the customer's details first.",
    bad_address: "The email address on this job is not a valid address, so the quote was not sent. Check it in the customer's details.",
    no_link: "This job has no customer link yet, so there is nothing to send. It gets one when the job reaches the cloud.",
    no_company_name: "Add your business name in Settings first, so the quote does not arrive from nobody.",
  },
  es: {
    no_address: "Este trabajo no tiene correo electrónico, así que no hay a quién enviarle el presupuesto. Agregue uno en los datos del cliente.",
    bad_address: "El correo electrónico de este trabajo no es válido, así que no se envió el presupuesto. Revíselo en los datos del cliente.",
    no_link: "Este trabajo todavía no tiene enlace para el cliente, así que no hay nada que enviar. Se crea cuando el trabajo llega a la nube.",
    no_company_name: "Agregue el nombre de su negocio en Ajustes, para que el presupuesto no llegue sin remitente.",
  },
  fr: {
    no_address: "Ce chantier n’a pas d’adresse courriel, il n’y a donc personne à qui envoyer le devis. Ajoutez-en une dans les coordonnées du client.",
    bad_address: "L’adresse courriel de ce chantier n’est pas valide, le devis n’a donc pas été envoyé. Vérifiez-la dans les coordonnées du client.",
    no_link: "Ce chantier n’a pas encore de lien client, il n’y a donc rien à envoyer. Il est créé quand le chantier arrive dans le nuage.",
    no_company_name: "Ajoutez le nom de votre entreprise dans les Réglages, pour que le devis n’arrive pas sans expéditeur.",
  },
};

/**
 * The same address test mail-send applies before it sends anything
 * (_shared/mail/mime-build.ts isValidAddress). Repeated here so the button
 * can be refused with a sentence instead of the send coming back failed --
 * and deliberately no laxer, so nothing this says yes to is refused later.
 */
const ADDRESS = /^[^\s<>()[\],;:\\"]+@[^\s<>()[\],;:\\"@]+\.[^\s<>()[\],;:\\"@]{2,}$/;

/**
 * Can this quote be emailed at all, and if not, why?
 *
 * Checked BEFORE any words are built, because a template with nowhere to go
 * is the fake-feature trap: the office and the phone both ask this first and
 * show [REFUSAL_REASON] rather than offering a Send button that cannot send.
 *
 * Returns null when the send may go ahead.
 */
export function quoteSendRefusal(
  facts: { recipient?: string | null; quoteUrl?: string | null; companyName?: string | null },
): QuoteSendRefusal | null {
  const to = oneLine(facts.recipient, 320);
  if (!to) return "no_address";
  // One address, not a list: this is a quote for one customer. A comma or a
  // space is somebody who typed two, and guessing which one she is would be
  // worse than asking.
  if (!ADDRESS.test(to)) return "bad_address";
  if (!safeUrl(facts.quoteUrl)) return "no_link";
  if (!oneLine(facts.companyName, NAME_MAX)) return "no_company_name";
  return null;
}

interface QuoteSendWords {
  subject: (company: string) => string;
  hello: (name: string) => string;
  /** What the quote is for. The address when there is one, else no address. */
  intro: (company: string, address: string) => string;
  open: (url: string) => string;
  /** What she will find on the page. Says "price"; never a price. */
  whatIsOnIt: string;
  /** What approving does. A place in the queue, never a date. */
  approving: (company: string) => string;
  /**
   * WHY THERE IS NO FIGURE IN THIS EMAIL, said to her as a convenience rather
   * than as an apology. True of the system as built: quote-view reads the
   * job's live figures through depositFigures() every time the page is
   * opened.
   */
  pageIsLive: string;
  questions: (company: string, phone: string) => string;
}

const QUOTE_SEND: Record<Lang, QuoteSendWords> = {
  en: {
    subject: (c) => `Your fence quote from ${c}`,
    hello: (n) => (n ? `Hi ${n},` : "Hello,"),
    intro: (c, a) =>
      a
        ? `Here is your quote from ${c} for the fence at ${a}.`
        : `Here is your fence quote from ${c}.`,
    open: (u) => `Open it here: ${u}`,
    whatIsOnIt: "The page shows the price, what is included, and your fence drawn in 3D so you can see it before anything is built.",
    approving: (c) => `If it looks right, you can approve and sign it on the page, and ${c} will be in touch to arrange the work.`,
    pageIsLive: "The page is live, so it always shows the current price. Open it again any time.",
    questions: (c, p) => `Questions? Just reply to this email${p ? `, or call ${c} at ${p}` : ""}.`,
  },
  es: {
    subject: (c) => `Su presupuesto de cerca con ${c}`,
    hello: (n) => (n ? `Hola ${n},` : "Hola,"),
    intro: (c, a) =>
      a
        ? `Aquí tiene su presupuesto de ${c} para la cerca en ${a}.`
        : `Aquí tiene su presupuesto de cerca con ${c}.`,
    open: (u) => `Ábralo aquí: ${u}`,
    whatIsOnIt: "En la página verá el precio, lo que incluye y su cerca dibujada en 3D, para verla antes de construir nada.",
    approving: (c) => `Si le parece bien, puede aprobarlo y firmarlo en la misma página, y ${c} se pondrá en contacto para coordinar el trabajo.`,
    pageIsLive: "La página está en línea, así que siempre muestra el precio actual. Ábrala cuando quiera.",
    questions: (c, p) => `¿Preguntas? Responda a este correo${p ? `, o llame a ${c} al ${p}` : ""}.`,
  },
  fr: {
    subject: (c) => `Votre devis de clôture avec ${c}`,
    hello: (n) => (n ? `Bonjour ${n},` : "Bonjour,"),
    intro: (c, a) =>
      a
        ? `Voici votre devis de ${c} pour la clôture au ${a}.`
        : `Voici votre devis de clôture avec ${c}.`,
    open: (u) => `Ouvrez-le ici : ${u}`,
    whatIsOnIt: "La page indique le prix, ce qui est inclus, et votre clôture dessinée en 3D, pour la voir avant que quoi que ce soit ne soit construit.",
    approving: (c) => `Si tout vous convient, vous pouvez l’approuver et le signer sur la page, et ${c} vous contactera pour organiser les travaux.`,
    pageIsLive: "La page est en ligne : elle affiche toujours le prix actuel. Ouvrez-la quand vous voulez.",
    questions: (c, p) => `Des questions ? Répondez simplement à ce courriel${p ? `, ou appelez ${c} au ${p}` : ""}.`,
  },
};

/** The words themselves, for the tests and for the parity check against the office's copy. */
export const QUOTE_SEND_WORDS: Readonly<Record<Lang, QuoteSendWords>> = QUOTE_SEND;

export interface BuiltEmail {
  subject: string;
  /** Plain text. The HTML twin is made by whoever sends it, never here. */
  text: string;
}

/**
 * The quote-send email, in `lang`.
 *
 * Throws nothing and invents nothing: a blank name, a blank address and a
 * blank phone each drop their own clause rather than printing a gap or a
 * placeholder. A link that is not an https URL produces no link line at all
 * -- which is why [quoteSendRefusal] must be asked FIRST, so an unsendable
 * quote is refused with a sentence instead of sent without its link.
 */
export function buildQuoteSendEmail(facts: QuoteSendFacts, lang: Lang): BuiltEmail {
  const w = QUOTE_SEND[lang] ?? QUOTE_SEND.en;
  const company = oneLine(facts.companyName, NAME_MAX);
  const phone = oneLine(facts.companyPhone, PHONE_MAX);
  // Stranger-typed: lead-intake writes both of these onto a job from a public
  // web form with no session, so a link in either must not become clickable in
  // an email that arrives from his company. See typedByStranger.
  const name = typedByStranger(facts.customerName, NAME_MAX);
  const address = typedByStranger(facts.address, ADDRESS_MAX);
  const url = safeUrl(facts.quoteUrl);

  const lines: string[] = [
    w.hello(name),
    "",
    w.intro(company, address),
  ];
  if (url) {
    lines.push("", w.open(url));
  }
  lines.push(
    "",
    w.whatIsOnIt,
    "",
    w.approving(company),
    "",
    w.pageIsLive,
    "",
    w.questions(company, phone),
  );

  return {
    subject: w.subject(company).replace(/\s+/g, " ").trim().slice(0, 200),
    text: lines.join("\n"),
  };
}

// ===========================================================================
// 3. THE REST OF THE SET -- A73
// ===========================================================================
/**
 * Four more emails, one per moment in his job that nothing speaks for today.
 * Written as section 3 of this file (appended; section 2 above is untouched)
 * so there is ONE place a sentence a customer reads is written.
 *
 * ---------------------------------------------------------------------------
 * WHICH MOMENTS, AND WHY THESE FOUR
 * ---------------------------------------------------------------------------
 * The lifecycle was read out of this repo, not off a list of marketing
 * emails: DefaultJobSteps.kt (walkthrough / install / final walkthrough),
 * JobStatus (DRAFT, SENT, ACCEPTED, COMPLETED, DECLINED), the four kinds in
 * _shared/follow-up-logic.ts, docs/REAPPROVAL_RULE.md, and the payment ledger
 * in _shared/record-payment.ts.
 *
 *   T1 reapproval_needed  The drawing changed after she approved, so the
 *                         database withdrew the approval (REAPPROVAL_RULE).
 *                         The office gets a badge and the quote page already
 *                         prints a notice in all three languages -- but
 *                         NOTHING tells her to go and look, so the job stops
 *                         dead and create-payment-link refuses any further
 *                         money. Three of his live jobs are in this state.
 *   T2 payment_received   Money arrived. There is no receipt anywhere in this
 *                         product -- not in the app, not in the office, not
 *                         from either webhook. He takes Zelle, Cash App and
 *                         cash by hand, and the only record the customer gets
 *                         is her own bank statement.
 *   T3 scheduled          He set jobs.scheduled_date. Nothing tells her, and
 *                         this is the one email that can carry his own
 *                         standing site rules BEFORE the crew turns up, which
 *                         is the difference between a change order and an
 *                         argument.
 *   T4 work_finished      The fence is in. Nothing closes the loop or points
 *                         at what is still owed.
 *
 * REJECTED on purpose, each because something already owns the moment:
 * the quote-send email (section 2 above); the four sales nudges
 * (send-follow-ups); the contract copy on approval
 * (quote-approval-email/email.ts); the review ask (ReviewTemplates.kt, five
 * wordings, already chosen for him by suggestFor()); and "sign the change
 * order", because website/quote.html has no change-order section at all --
 * an email asking her to sign one has nowhere to send her.
 *
 * ---------------------------------------------------------------------------
 * THE RULES ALL FOUR KEEP
 * ---------------------------------------------------------------------------
 * 1. NOTHING OPTIONAL IS EVER PRINTED EMPTY. His own words: "if I don't have
 *    any information on the payment method, don't even put it for the
 *    customer, I only want to present what is there." Every optional fact
 *    drops its WHOLE clause or its WHOLE line -- never a label with nothing
 *    after it, never "Dear ,", never a dangling "call us on".
 *
 * 2. NO FIGURE THIS FILE DOES NOT OWN. T1 and T3 carry no money at all, and
 *    cannot: T1 exists because the price just moved, and T3 is about a date.
 *    T2 and T4 carry at most two figures:
 *      - `amount`, the payment that just landed. That figure is the event
 *        itself; no other surface owns it.
 *      - `balance`, which MUST be depositFigures().balance and nothing else
 *        -- the same number the quote page labels "Left to pay". It is
 *        printed under the SAME WORDS the page uses, taken from the approval
 *        email's own table, because she reads the email and the page side by
 *        side and two labels for one number is how one number starts looking
 *        like two.
 *    Nothing here subtracts, adds, rounds or derives anything. No total, no
 *    deposit, no percentage. tests/a73-email-template-set.test.mjs feeds
 *    every builder extra fields named `total`, `deposit`, `contractTotal`,
 *    `amountPaid`, `materials` and asserts the output is byte-identical, and
 *    renders every template with sentinel figures and asserts that every
 *    digit in the finished text came from one of them.
 *
 * 3. NO TERM HE HAS NOT STATED. No warranty length, no lead time, no
 *    cancellation window, no fee, no time of day, no crew size, no duration,
 *    no weather promise, and no "we will come back and fix it" -- which is a
 *    remedy, not a sentence. The contract's cancellation clause
 *    (ContractTemplate.kt) is written the same way and that is the discipline
 *    matched here. Where a sentence had to commit somebody, it commits HER
 *    ("reply to this email if you need to move the date"), never him.
 *
 *    The one thing in the set that reads like a term is NOT invented: the
 *    debris sentence in T3 is his own standing rule, already read aloud on
 *    every job -- DefaultJobSteps.WALKTHROUGH's `wt_debris_clearing_rule`
 *    ("we clear leaves and loose debris only ... anything needing a tool they
 *    clear before we start, or it goes on a change order"). T3 is the first
 *    place the customer hears it BEFORE the crew is standing in her yard.
 *
 * 4. ONE TEMPLATE, ONE MOMENT. No two of these can be the right one at the
 *    same time, so he never has to choose under pressure.
 *
 * 5. THREE LANGUAGES, WRITTEN NOT TRANSLATED, and accented properly as the
 *    approval email is.
 *
 * Plain text only. No markup is built here, so nothing anybody typed can
 * become markup; the HTML twin is made by whoever sends it (mail-send's
 * composeBody(), which escapes).
 */

/** The four templates this section owns. One string, one moment. */
export type JobEmailTemplate =
  | "reapproval_needed"
  | "payment_received"
  | "scheduled"
  | "work_finished";

export const JOB_EMAIL_TEMPLATES: readonly JobEmailTemplate[] = [
  "reapproval_needed",
  "payment_received",
  "scheduled",
  "work_finished",
];

/**
 * Which of these a crew member may send at all.
 *
 * A figure is money whether it is a total or a balance, and crew never see
 * money. T2 and T4 can carry `balance`, so they are owner/office templates;
 * T1 and T3 carry no figure of any kind. This mirrors the office's SEE_MONEY
 * gate rather than replacing it -- the server is still the boundary, and a
 * role without SEE_MONEY never has the balance to pass in.
 */
export const JOB_EMAIL_CARRIES_MONEY: Readonly<Record<JobEmailTemplate, boolean>> = {
  reapproval_needed: false,
  payment_received: true,
  scheduled: false,
  work_finished: true,
};

/** What "the company" is called when the business name is blank. The approval
 *  email uses exactly these three words for exactly this reason. */
const COMPANY_FALLBACK: Readonly<Record<Lang, string>> = { en: "your contractor", es: "su contratista", fr: "votre entreprise" };

/** US dollars, formatted exactly as the approval email and the quote page format them. */
const money = (n: number): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
    .format(Number.isFinite(Number(n)) ? Number(n) : 0);

/** Longest a date string may be. Dates arrive ALREADY FORMATTED -- see JobEmailFacts.
 *  Nothing here owns a clock or a locale calendar. */
export const DATE_MAX = 60;

/**
 * Everything the four templates are allowed to know.
 *
 * Dates arrive as strings the CALLER formatted, not as ISO timestamps. That
 * is deliberate: the office, the phone and the server already each know how
 * to write a date in the customer's language and the company's time zone, and
 * a fifth copy of that arithmetic here is a fifth thing that can be a day out
 * on an evening job. A blank date drops its clause.
 *
 * Money arrives as a NUMBER, never a formatted string, so only this file
 * decides how a dollar looks.
 */
export interface JobEmailFacts {
  /** `companies.name`. Required: an email from nobody is not sendable. */
  companyName: string;
  /** `companies.phone`. Blank drops the "or call" clause. */
  companyPhone?: string | null;
  /** `jobs.customer_name`. Blank gives a plain "Hello," -- never "Hi ,". */
  customerName?: string | null;
  /** `jobs.address`. Blank drops the address clause. */
  address?: string | null;
  /** https://<site>/quote.html?t=<jobs.quote_token> */
  quoteUrl?: string | null;
  /** T1 only: `jobs.reapproval_required_at`, already written as a date. */
  changedOn?: string | null;
  /** T1 only: the fence line named in `jobs.reapproval_reason`, if it names one. */
  runLabel?: string | null;
  /** T1 only: true when any payment has actually been taken on this job. */
  paymentTaken?: boolean;
  /** T2 only: the payment that just landed. Required, and must be above zero. */
  amount?: number | null;
  /** T2 only: the day it landed, already written as a date. */
  paidOn?: string | null;
  /** T3 only: `jobs.scheduled_date`, already written as a date. Required. */
  scheduledOn?: string | null;
  /** T2 and T4 only: depositFigures().balance. NOTHING ELSE may be passed here. */
  balance?: number | null;
  /** T2 and T4 only: the day the figures above were read, already written as a date. */
  asOf?: string | null;
}

/** Why one of these four cannot be sent. */
export type JobEmailRefusal =
  | QuoteSendRefusal
  | "no_amount"
  | "no_date";

/**
 * What a refusal means, in words the office and the phone both show. The
 * three codes section 2 already has a sentence for are reused from its table
 * rather than written again, so the office cannot end up with two wordings
 * for "there is no email address on this job".
 */
export const JOB_EMAIL_REFUSAL_REASON:
  Readonly<Record<Lang, Readonly<Record<JobEmailRefusal, string>>>> = {
    en: {
      ...REFUSAL_REASON.en,
      no_amount: "There is no payment to write a receipt for. Record the payment on the job first.",
      no_date: "There is no date on this job yet, so there is nothing to tell the customer. Set the date first.",
    },
    es: {
      ...REFUSAL_REASON.es,
      no_amount: "No hay ningún pago para el cual hacer un recibo. Registre el pago en el trabajo primero.",
      no_date: "Este trabajo todavía no tiene fecha, así que no hay nada que decirle al cliente. Fije la fecha primero.",
    },
    fr: {
      ...REFUSAL_REASON.fr,
      no_amount: "Il n'y a aucun paiement pour lequel faire un reçu. Enregistrez d'abord le paiement sur le chantier.",
      no_date: "Ce chantier n'a pas encore de date : il n'y a donc rien à annoncer au client. Fixez d'abord la date.",
    },
  };

/**
 * Can this template be sent for this job, and if not, why?
 *
 * Asked BEFORE any words are built, by every caller, so an unsendable email
 * is refused with a sentence instead of a Send button that cannot send. Each
 * template is asked only for what IT needs: a receipt needs an amount, a
 * schedule notice needs a date, and the re-approval notice needs the link,
 * because its whole purpose is to get her back onto the page.
 *
 * Returns null when the send may go ahead.
 */
export function jobEmailRefusal(
  template: JobEmailTemplate,
  facts: { recipient?: string | null } & JobEmailFacts,
): JobEmailRefusal | null {
  const to = oneLine(facts.recipient, 320);
  if (!to) return "no_address";
  if (!ADDRESS.test(to)) return "bad_address";
  if (!oneLine(facts.companyName, NAME_MAX)) return "no_company_name";
  if (template === "reapproval_needed" && !safeUrl(facts.quoteUrl)) return "no_link";
  if (template === "payment_received" && !((Number(facts.amount) || 0) > 0.005)) return "no_amount";
  if (template === "scheduled" && !oneLine(facts.scheduledOn, DATE_MAX)) return "no_date";
  return null;
}

interface JobEmailWords {
  /** Between a label and its value. French puts a space before the colon. */
  sep: string;
  hello: (name: string) => string;
  /** The SAME label the quote page gives depositFigures().balance. Never a second wording. */
  balance: string;
  asOf: (date: string) => string;
  questions: (company: string, phone: string) => string;

  // T1 -- the drawing changed.
  t1Subject: (company: string) => string;
  /** With a date and with a named fence line; the page's own two sentences. */
  t1Changed: (date: string, run: string) => string;
  t1Open: (url: string) => string;
  t1Why: string;
  /** Only when a payment has actually been taken. REAPPROVAL_RULE: no money column is written. */
  t1MoneySafe: string;

  // T2 -- a payment arrived.
  t2Subject: (company: string) => string;
  t2Got: (amount: string, date: string) => string;
  t2Thanks: string;
  t2Page: (url: string) => string;

  // T3 -- on the schedule.
  t3Subject: (company: string) => string;
  t3On: (date: string, address: string) => string;
  t3BeforeHead: string;
  /** His own standing rule, told to her before the crew arrives. */
  t3Debris: string;
  t3Clear: string;
  t3Mark: string;
  t3Move: string;

  // T4 -- the fence is finished.
  t4Subject: (company: string) => string;
  t4Done: (address: string) => string;
  t4NotRight: (company: string, phone: string) => string;
  t4Page: (url: string) => string;
}

const JOB_EMAIL: Record<Lang, JobEmailWords> = {
  en: {
    sep: ": ",
    hello: (n) => (n ? `Hi ${n},` : "Hello,"),
    balance: "Left to pay",
    asOf: (d) => `That is where things stand as of ${d}. If you have paid since, ask us what is still due.`,
    questions: (c, p) => `Questions? Just reply to this email${p ? `, or call ${c} at ${p}` : ""}.`,

    t1Subject: (c) => `Please approve your updated fence quote from ${c}`,
    t1Changed: (d, r) =>
      d && r
        ? `We updated your drawing on ${d} - the ${r} line changed. Please review it and approve again.`
        : d
        ? `We updated your drawing on ${d}. Please review it and approve again.`
        : r
        ? `We updated your drawing - the ${r} line changed. Please review it and approve again.`
        : "We updated your drawing. Please review it and approve again.",
    t1Open: (u) => `Open your quote here: ${u}`,
    t1Why: "Your earlier approval covered the old drawing, so we need your approval on this one before we build it. The page shows the current price and the fence as it now stands.",
    t1MoneySafe: "Payments already taken are not affected.",

    t2Subject: (c) => `Payment received - ${c}`,
    t2Got: (a, d) => (d ? `We have received your payment of ${a} on ${d}.` : `We have received your payment of ${a}.`),
    t2Thanks: "Thank you.",
    t2Page: (u) => `Your page always shows where the money stands: ${u}`,

    t3Subject: (c) => `Your fence is on the schedule - ${c}`,
    t3On: (d, a) => (a ? `Your fence at ${a} is on the schedule for ${d}.` : `Your fence is on the schedule for ${d}.`),
    t3BeforeHead: "Before we start, please:",
    t3Debris: "We clear leaves and loose debris only. Anything that needs a tool - bushes, planters, sheds, tree limbs, old posts - please clear before we start, or it has to go on a change order.",
    t3Clear: "Move anything of yours that is sitting on the fence line.",
    t3Mark: "Show us, or mark, any sprinklers, septic or irrigation lines we cannot see.",
    t3Move: "If this date does not suit you, tell us as soon as you can.",

    t4Subject: (c) => `Your fence is finished - ${c}`,
    t4Done: (a) => (a ? `Your fence at ${a} is finished.` : "Your fence is finished."),
    t4NotRight: (c, p) => `If anything is not right, reply to this email${p ? ` or call ${c} at ${p}` : ` and tell ${c}`}.`,
    t4Page: (u) => `Your page is still there, and still shows where the money stands: ${u}`,
  },
  es: {
    sep: ": ",
    hello: (n) => (n ? `Hola ${n},` : "Hola,"),
    balance: "Queda por pagar",
    asOf: (d) => `Así están las cuentas al ${d}. Si ya pagó desde entonces, pregúntenos cuánto queda.`,
    questions: (c, p) => `¿Preguntas? Responda a este correo${p ? `, o llame a ${c} al ${p}` : ""}.`,

    t1Subject: (c) => `Apruebe su presupuesto de cerca actualizado con ${c}`,
    t1Changed: (d, r) =>
      d && r
        ? `Actualizamos su plano el ${d} - cambió el tramo ${r}. Revíselo y apruébelo de nuevo.`
        : d
        ? `Actualizamos su plano el ${d}. Revíselo y apruébelo de nuevo.`
        : r
        ? `Actualizamos su plano - cambió el tramo ${r}. Revíselo y apruébelo de nuevo.`
        : "Actualizamos su plano. Revíselo y apruébelo de nuevo.",
    t1Open: (u) => `Abra su presupuesto aquí: ${u}`,
    t1Why: "Su aprobación anterior era para el plano antiguo, así que necesitamos su aprobación de este antes de construirlo. En la página verá el precio actual y la cerca como queda ahora.",
    t1MoneySafe: "Los pagos ya recibidos no se ven afectados.",

    t2Subject: (c) => `Pago recibido - ${c}`,
    t2Got: (a, d) => (d ? `Recibimos su pago de ${a} el ${d}.` : `Recibimos su pago de ${a}.`),
    t2Thanks: "Gracias.",
    t2Page: (u) => `En su página siempre puede ver cómo van las cuentas: ${u}`,

    t3Subject: (c) => `Su cerca ya tiene fecha - ${c}`,
    t3On: (d, a) => (a ? `Su cerca en ${a} está programada para el ${d}.` : `Su cerca está programada para el ${d}.`),
    t3BeforeHead: "Antes de empezar, por favor:",
    t3Debris: "Nosotros retiramos solo hojas y basura suelta. Todo lo que necesite herramienta - arbustos, maceteros, cobertizos, ramas, postes viejos - hay que quitarlo antes de empezar, o tiene que ir en una orden de cambio.",
    t3Clear: "Retire lo que tenga puesto sobre la línea de la cerca.",
    t3Mark: "Muéstrenos, o marque, los aspersores, el séptico o las líneas de riego que no se ven.",
    t3Move: "Si esta fecha no le conviene, díganoslo cuanto antes.",

    t4Subject: (c) => `Su cerca está terminada - ${c}`,
    t4Done: (a) => (a ? `Su cerca en ${a} está terminada.` : "Su cerca está terminada."),
    t4NotRight: (c, p) => `Si algo no está bien, responda a este correo${p ? ` o llame a ${c} al ${p}` : ` y dígaselo a ${c}`}.`,
    t4Page: (u) => `Su página sigue ahí, y sigue mostrando cómo van las cuentas: ${u}`,
  },
  fr: {
    sep: " : ",
    hello: (n) => (n ? `Bonjour ${n},` : "Bonjour,"),
    balance: "Reste à payer",
    asOf: (d) => `Voilà où en sont les comptes au ${d}. Si vous avez payé depuis, demandez-nous ce qu'il reste.`,
    questions: (c, p) => `Des questions ? Répondez simplement à ce courriel${p ? `, ou appelez ${c} au ${p}` : ""}.`,

    t1Subject: (c) => `Veuillez approuver votre devis de clôture mis à jour avec ${c}`,
    t1Changed: (d, r) =>
      d && r
        ? `Nous avons mis à jour votre plan le ${d} - le tronçon ${r} a changé. Veuillez le vérifier et l'approuver à nouveau.`
        : d
        ? `Nous avons mis à jour votre plan le ${d}. Veuillez le vérifier et l'approuver à nouveau.`
        : r
        ? `Nous avons mis à jour votre plan - le tronçon ${r} a changé. Veuillez le vérifier et l'approuver à nouveau.`
        : "Nous avons mis à jour votre plan. Veuillez le vérifier et l'approuver à nouveau.",
    t1Open: (u) => `Ouvrez votre devis ici : ${u}`,
    t1Why: "Votre approbation précédente portait sur l'ancien plan ; il nous faut donc votre approbation sur celui-ci avant de construire. La page indique le prix actuel et la clôture telle qu'elle est maintenant.",
    t1MoneySafe: "Les paiements déjà reçus ne sont pas affectés.",

    t2Subject: (c) => `Paiement reçu - ${c}`,
    t2Got: (a, d) => (d ? `Nous avons reçu votre paiement de ${a} le ${d}.` : `Nous avons reçu votre paiement de ${a}.`),
    t2Thanks: "Merci.",
    t2Page: (u) => `Votre page montre toujours où en sont les comptes : ${u}`,

    t3Subject: (c) => `Votre clôture est planifiée - ${c}`,
    t3On: (d, a) => (a ? `Votre clôture au ${a} est planifiée pour le ${d}.` : `Votre clôture est planifiée pour le ${d}.`),
    t3BeforeHead: "Avant que nous commencions, merci de :",
    t3Debris: "Nous enlevons seulement les feuilles et les débris libres. Tout ce qui demande un outil - buissons, jardinières, cabanons, branches, vieux poteaux - doit être enlevé avant que nous commencions, sinon cela passe en avenant.",
    t3Clear: "Déplacer ce qui vous appartient et se trouve sur la ligne de clôture.",
    t3Mark: "Nous montrer, ou marquer, les arroseurs, la fosse septique ou les conduites d'arrosage qu'on ne voit pas.",
    t3Move: "Si cette date ne vous convient pas, dites-le nous au plus vite.",

    t4Subject: (c) => `Votre clôture est terminée - ${c}`,
    t4Done: (a) => (a ? `Votre clôture au ${a} est terminée.` : "Votre clôture est terminée."),
    t4NotRight: (c, p) => `Si quelque chose ne va pas, répondez à ce courriel${p ? ` ou appelez ${c} au ${p}` : ` et dites-le à ${c}`}.`,
    t4Page: (u) => `Votre page est toujours là, et indique toujours où en sont les comptes : ${u}`,
  },
};

/** The words themselves, for the tests and for the parity check against the office's copy. */
export const JOB_EMAIL_WORDS: Readonly<Record<Lang, JobEmailWords>> = JOB_EMAIL;

/**
 * One of the four, in `lang`.
 *
 * Throws nothing and invents nothing. Reads ONLY the fields named on
 * [JobEmailFacts] -- anything else passed in is ignored, which is what stops a
 * caller handing it a total and this file printing one. [jobEmailRefusal] must
 * be asked FIRST: this function will happily build a receipt with no amount
 * line if there is no amount, and that is not an email anybody should send.
 */
export function buildJobEmail(
  template: JobEmailTemplate,
  facts: JobEmailFacts,
  lang: Lang,
): BuiltEmail {
  const w = JOB_EMAIL[lang] ?? JOB_EMAIL.en;
  // A blank business name would leave "Payment received - " and "and tell ."
  // behind. jobEmailRefusal() already refuses the send, but the builder must
  // not be the thing that produces a dangling line; the approval email takes
  // the same precaution with the same three words.
  const company = oneLine(facts.companyName, NAME_MAX) || COMPANY_FALLBACK[lang] || COMPANY_FALLBACK.en;
  const phone = oneLine(facts.companyPhone, PHONE_MAX);
  // Stranger-typed, exactly as in buildQuoteSendEmail above -- and this is the
  // half that was missed. These two read oneLine() until 2026-10-02, which
  // strips nothing link-shaped, while the quote-send builder 450 lines up
  // already used typedByStranger() and said why in a comment. lead-intake runs
  // with verify_jwt = false (supabase/config.toml), so customer_name and
  // address are written onto a job by an unauthenticated stranger through the
  // public web form; mime-build.ts linkify() then turns any bare https:// in
  // the text into a real <a href> in the HTML part of a message that arrives
  // from HIS company's domain. That is a phishing link with his return address
  // on it, and all four of these templates print one or both fields.
  //
  // The company name and phone above stay on oneLine() deliberately: he types
  // those himself in settings, and stripping a link out of them would quietly
  // mangle a business whose name or number he wants shown as he wrote it.
  const name = typedByStranger(facts.customerName, NAME_MAX);
  const address = typedByStranger(facts.address, ADDRESS_MAX);
  const url = safeUrl(facts.quoteUrl);
  const asOf = oneLine(facts.asOf, DATE_MAX);
  const balance = Number(facts.balance);
  const hasBalance = Number.isFinite(balance) && balance > 0.005;

  const out: string[] = [w.hello(name), ""];
  const gap = () => {
    if (out.length && out[out.length - 1] !== "") out.push("");
  };
  /** The balance line, and the sentence that dates it -- both or neither. */
  const balanceBlock = () => {
    if (!hasBalance) return;
    gap();
    out.push(`${w.balance}${w.sep}${money(balance)}`);
    if (asOf) out.push(w.asOf(asOf));
  };
  let subject: string;

  if (template === "reapproval_needed") {
    subject = w.t1Subject(company);
    out.push(w.t1Changed(oneLine(facts.changedOn, DATE_MAX), oneLine(facts.runLabel, 60)));
    gap();
    out.push(w.t1Why);
    if (url) {
      gap();
      out.push(w.t1Open(url));
    }
    // Only when there is a payment to reassure her about. A job that has paid
    // nothing gets no sentence about payments, by rule 1.
    if (facts.paymentTaken === true) {
      gap();
      out.push(w.t1MoneySafe);
    }
  } else if (template === "payment_received") {
    subject = w.t2Subject(company);
    const amount = Number(facts.amount);
    if (Number.isFinite(amount) && amount > 0.005) {
      out.push(w.t2Got(money(amount), oneLine(facts.paidOn, DATE_MAX)), w.t2Thanks);
    } else {
      out.push(w.t2Thanks);
    }
    balanceBlock();
    if (url) {
      gap();
      out.push(w.t2Page(url));
    }
  } else if (template === "scheduled") {
    subject = w.t3Subject(company);
    out.push(w.t3On(oneLine(facts.scheduledOn, DATE_MAX), address));
    // His own standing rule is a STATEMENT of what the crew does, so it is its
    // own paragraph; the two things SHE has to do are the bulleted list under
    // the heading that asks her to do them. Putting all three under "please:"
    // read as though he were asking her to clear the leaves.
    gap();
    out.push(w.t3Debris);
    gap();
    out.push(w.t3BeforeHead, `- ${w.t3Clear}`, `- ${w.t3Mark}`);
    gap();
    out.push(w.t3Move);
  } else {
    subject = w.t4Subject(company);
    out.push(w.t4Done(address));
    gap();
    out.push(w.t4NotRight(company, phone));
    balanceBlock();
    if (url) {
      gap();
      out.push(w.t4Page(url));
    }
  }

  // T4 already gave her the same two ways to reach him, in a sentence that
  // says what to reach him ABOUT. A second "Questions? Just reply..." under it
  // is the same offer twice.
  if (template !== "work_finished") {
    gap();
    out.push(w.questions(company, phone));
  }
  out.push("", company);

  return {
    subject: subject.replace(/\s+/g, " ").trim().slice(0, 200),
    text: out.join("\n"),
  };
}
