/**
 * The quote-send email, for the OFFICE.
 *
 * This is the browser's copy of
 * supabase/functions/_shared/email-templates.ts. The office is an ES module
 * loaded by a browser and cannot import Deno TypeScript, and the server
 * cannot import out of website/ (only supabase/functions is deployed), so the
 * two copies exist because neither runtime can reach the other's file.
 *
 * THEY ARE NOT ALLOWED TO DRIFT. tests/a72-quote-email.test.mjs imports BOTH
 * modules and compares the RENDERED subject and body, for every language,
 * across a matrix of job shapes. Not a text search for a phrase -- the actual
 * output, character for character. Change a word here and that test goes red
 * until the same word changes there, and the other way round.
 *
 * Read the header of email-templates.ts for the reasoning, in particular WHY
 * THERE IS NO PRICE IN THIS EMAIL. The short version: this email goes out
 * before acceptance, while the job's total is still moving (JobSync.kt keeps
 * pushing a fresh contract_total for phone-priced jobs after quote_sent_at is
 * set), so a figure typed into it would be wrong in her inbox while the page
 * beside it was right. The page owns every figure.
 */

export const LANGS = ["en", "es", "fr"];
const isLang = (v) => v === "en" || v === "es" || v === "fr";

export function pickLang(requested, acceptLanguage) {
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
  return ranked[0]?.lang ?? "en";
}

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function oneLine(raw, max) {
  const s = String(raw ?? "").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  return Array.from(s).slice(0, max).join("").trim();
}

export function safeUrl(raw) {
  const s = String(raw ?? "").trim();
  return /^https:\/\/[^\s<>"'\\]{1,400}$/.test(s) ? s : "";
}

const LINKISH = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*/gi;

/**
 * oneLine, and no links: for text a STRANGER typed.
 *
 * supabase/functions/lead-intake/index.ts runs with verify_jwt = false and
 * inserts customer_name, phone, email, address and notes straight onto a new
 * job from the public website form, so jobs.customer_name and jobs.address are
 * stranger-typed. A link in either would become clickable in the HTML twin of
 * an email arriving from HIS company. The company's own wording is not cleaned
 * this way -- same line quote-approval-email/email.ts draws.
 */
export function typedByStranger(raw, max) {
  return oneLine(String(raw ?? "").replace(INVISIBLE, " ").replace(LINKISH, ""), max);
}

export const NAME_MAX = 120;
export const ADDRESS_MAX = 200;
export const PHONE_MAX = 40;

export const REFUSAL_REASON = {
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

const ADDRESS = /^[^\s<>()[\],;:\\"]+@[^\s<>()[\],;:\\"@]+\.[^\s<>()[\],;:\\"@]{2,}$/;

/** Can this quote be emailed at all, and if not, why? Returns null when it can. */
export function quoteSendRefusal(facts) {
  const to = oneLine(facts && facts.recipient, 320);
  if (!to) return "no_address";
  if (!ADDRESS.test(to)) return "bad_address";
  if (!safeUrl(facts && facts.quoteUrl)) return "no_link";
  if (!oneLine(facts && facts.companyName, NAME_MAX)) return "no_company_name";
  return null;
}

const QUOTE_SEND = {
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

export const QUOTE_SEND_WORDS = QUOTE_SEND;

/** The quote-send email, in `lang`. Plain text; the HTML twin is mail-send's job. */
export function buildQuoteSendEmail(facts, lang) {
  const w = QUOTE_SEND[lang] ?? QUOTE_SEND.en;
  const f = facts || {};
  const company = oneLine(f.companyName, NAME_MAX);
  const phone = oneLine(f.companyPhone, PHONE_MAX);
  // Stranger-typed (lead-intake, verify_jwt = false): links removed, so one
  // cannot become clickable in an email arriving from his company.
  const name = typedByStranger(f.customerName, NAME_MAX);
  const address = typedByStranger(f.address, ADDRESS_MAX);
  const url = safeUrl(f.quoteUrl);

  const lines = [
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
