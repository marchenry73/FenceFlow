/**
 * The other four customer emails, for the OFFICE.
 *
 * This is the browser's copy of section 3 of
 * supabase/functions/_shared/email-templates.ts. The office is an ES module
 * loaded by a browser and cannot import Deno TypeScript, and the server
 * cannot import out of website/ (only supabase/functions is deployed), so the
 * two copies exist because neither runtime can reach the other's file. Same
 * reason website/js/lib/quote-email.mjs is a copy of section 2.
 *
 * THEY ARE NOT ALLOWED TO DRIFT. tests/a73-email-template-set.test.mjs
 * imports BOTH modules and compares the RENDERED subject and body, character
 * for character, for every template, every language and a matrix of job
 * shapes -- not a text search for a phrase. Change a word here and that test
 * goes red until the same word changes there, and the other way round.
 *
 * Read the header of section 3 in email-templates.ts for the reasoning. The
 * short version:
 *
 *   - nothing optional is ever printed empty, because he said it plainly
 *     about payment methods and it is true of every field: "I only want to
 *     present what is there";
 *   - the re-approval notice and the schedule notice carry no figure at all;
 *   - the receipt and the finished notice carry at most the payment itself
 *     and depositFigures().balance, under the SAME label the quote page uses
 *     for that number, and nothing is derived here;
 *   - no warranty length, no lead time, no cancellation window, no fee, no
 *     time of day. Nothing he has not stated.
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

export const NAME_MAX = 120;
export const ADDRESS_MAX = 200;
export const PHONE_MAX = 40;
export const DATE_MAX = 60;

export const JOB_EMAIL_TEMPLATES = [
  "reapproval_needed",
  "payment_received",
  "scheduled",
  "work_finished",
];

/** Which of these a crew member may send at all. A balance is money, and crew never see money. */
export const JOB_EMAIL_CARRIES_MONEY = {
  reapproval_needed: false,
  payment_received: true,
  scheduled: false,
  work_finished: true,
};

/** What "the company" is called when the business name is blank. The approval
 *  email uses exactly these three words for exactly this reason. */
const COMPANY_FALLBACK = { en: "your contractor", es: "su contratista", fr: "votre entreprise" };

/** US dollars, formatted exactly as the approval email and the quote page format them. */
const money = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
    .format(Number.isFinite(Number(n)) ? Number(n) : 0);

/** The same address test mail-send applies before it sends anything. */
const ADDRESS = /^[^\s<>()[\],;:\\"]+@[^\s<>()[\],;:\\"@]+\.[^\s<>()[\],;:\\"@]{2,}$/;

/**
 * What a refusal means. The first four sentences are section 2's, repeated
 * here only because this module stands alone in the browser; the test
 * compares them to the server's table so the two cannot drift.
 */
export const JOB_EMAIL_REFUSAL_REASON = {
  en: {
    no_address: "There is no email address on this job, so there is nobody to send the quote to. Add one in the customer's details first.",
    bad_address: "The email address on this job is not a valid address, so the quote was not sent. Check it in the customer's details.",
    no_link: "This job has no customer link yet, so there is nothing to send. It gets one when the job reaches the cloud.",
    no_company_name: "Add your business name in Settings first, so the quote does not arrive from nobody.",
    no_amount: "There is no payment to write a receipt for. Record the payment on the job first.",
    no_date: "There is no date on this job yet, so there is nothing to tell the customer. Set the date first.",
  },
  es: {
    no_address: "Este trabajo no tiene correo electrónico, así que no hay a quién enviarle el presupuesto. Agregue uno en los datos del cliente.",
    bad_address: "El correo electrónico de este trabajo no es válido, así que no se envió el presupuesto. Revíselo en los datos del cliente.",
    no_link: "Este trabajo todavía no tiene enlace para el cliente, así que no hay nada que enviar. Se crea cuando el trabajo llega a la nube.",
    no_company_name: "Agregue el nombre de su negocio en Ajustes, para que el presupuesto no llegue sin remitente.",
    no_amount: "No hay ningún pago para el cual hacer un recibo. Registre el pago en el trabajo primero.",
    no_date: "Este trabajo todavía no tiene fecha, así que no hay nada que decirle al cliente. Fije la fecha primero.",
  },
  fr: {
    no_address: "Ce chantier n’a pas d’adresse courriel, il n’y a donc personne à qui envoyer le devis. Ajoutez-en une dans les coordonnées du client.",
    bad_address: "L’adresse courriel de ce chantier n’est pas valide, le devis n’a donc pas été envoyé. Vérifiez-la dans les coordonnées du client.",
    no_link: "Ce chantier n’a pas encore de lien client, il n’y a donc rien à envoyer. Il est créé quand le chantier arrive dans le nuage.",
    no_company_name: "Ajoutez le nom de votre entreprise dans les Réglages, pour que le devis n’arrive pas sans expéditeur.",
    no_amount: "Il n'y a aucun paiement pour lequel faire un reçu. Enregistrez d'abord le paiement sur le chantier.",
    no_date: "Ce chantier n'a pas encore de date : il n'y a donc rien à annoncer au client. Fixez d'abord la date.",
  },
};

/** Can this template be sent for this job, and if not, why? Asked BEFORE any words are built. */
export function jobEmailRefusal(template, facts) {
  const f = facts || {};
  const to = oneLine(f.recipient, 320);
  if (!to) return "no_address";
  if (!ADDRESS.test(to)) return "bad_address";
  if (!oneLine(f.companyName, NAME_MAX)) return "no_company_name";
  if (template === "reapproval_needed" && !safeUrl(f.quoteUrl)) return "no_link";
  if (template === "payment_received" && !((Number(f.amount) || 0) > 0.005)) return "no_amount";
  if (template === "scheduled" && !oneLine(f.scheduledOn, DATE_MAX)) return "no_date";
  return null;
}

const JOB_EMAIL = {
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

export const JOB_EMAIL_WORDS = JOB_EMAIL;

/** One of the four, in `lang`. Reads only the fields the server copy names; everything else is ignored. */
export function buildJobEmail(template, facts, lang) {
  const w = JOB_EMAIL[lang] ?? JOB_EMAIL.en;
  const f = facts || {};
  // A blank business name would leave "Payment received - " behind; the
  // refusal already stops the send, but the builder must not produce a
  // dangling line either.
  const company = oneLine(f.companyName, NAME_MAX) || COMPANY_FALLBACK[lang] || COMPANY_FALLBACK.en;
  const phone = oneLine(f.companyPhone, PHONE_MAX);
  const name = oneLine(f.customerName, NAME_MAX);
  const address = oneLine(f.address, ADDRESS_MAX);
  const url = safeUrl(f.quoteUrl);
  const asOf = oneLine(f.asOf, DATE_MAX);
  const balance = Number(f.balance);
  const hasBalance = Number.isFinite(balance) && balance > 0.005;

  const out = [w.hello(name), ""];
  const gap = () => {
    if (out.length && out[out.length - 1] !== "") out.push("");
  };
  const balanceBlock = () => {
    if (!hasBalance) return;
    gap();
    out.push(`${w.balance}${w.sep}${money(balance)}`);
    if (asOf) out.push(w.asOf(asOf));
  };
  let subject;

  if (template === "reapproval_needed") {
    subject = w.t1Subject(company);
    out.push(w.t1Changed(oneLine(f.changedOn, DATE_MAX), oneLine(f.runLabel, 60)));
    gap();
    out.push(w.t1Why);
    if (url) {
      gap();
      out.push(w.t1Open(url));
    }
    if (f.paymentTaken === true) {
      gap();
      out.push(w.t1MoneySafe);
    }
  } else if (template === "payment_received") {
    subject = w.t2Subject(company);
    const amount = Number(f.amount);
    if (Number.isFinite(amount) && amount > 0.005) {
      out.push(w.t2Got(money(amount), oneLine(f.paidOn, DATE_MAX)), w.t2Thanks);
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
    out.push(w.t3On(oneLine(f.scheduledOn, DATE_MAX), address));
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
