package com.fenceestimator.app.data

/**
 * The starting contract terms, editable by each company in Settings.
 *
 * Deliberately plain. A contract a customer cannot read is one they will argue
 * they did not understand, and the clauses that actually prevent disputes on a
 * fencing job are mundane: where the line runs, who moves the shed, what
 * happens when the ground is full of rock.
 *
 * NOT legal advice. It covers the arguments that actually happen, but anyone
 * selling real work should have their own version read once by an attorney in
 * their own state -- particularly the lien, warranty and termination language,
 * which is state-specific.
 *
 * {PLACEHOLDERS} are filled in when the document is produced.
 *
 * CANCELLATION is complete as shipped, with no number for the owner to fill
 * in. It charges what a cancelled job has ACTUALLY cost the contractor --
 * materials that cannot be returned (vinyl cut to a height, say), any
 * return charge the supplier really bills, and work already done -- rather
 * than a fixed fee or a notice period, because this app does not know the
 * owner's figures and an invented one would print on a real customer's
 * contract as though it were his policy. The one thing still left to the
 * owner is the statutory right-to-cancel paragraph at the end of that
 * section: attorney wording this app cannot write (see
 * [contractTermsNeedLegalReview]). It stays a visible bracketed placeholder
 * rather than blank, because a blank clause reads as "no policy" and a
 * customer will assume whichever answer suits them.
 *
 * A STORED COPY IS NOT THIS CONSTANT. This text is only the starting value.
 * The first time a company's settings are saved, [SettingsStore] writes the
 * terms the profile holds into the phone's own storage, and from then on
 * that stored copy is what prints on the contract: changing this constant
 * does not change it. [isDefaultContractTerms] is what lets an untouched
 * stored default keep following this file -- it recognises the current
 * defaults and every earlier shipped one, by fingerprint (see
 * [SUPERSEDED_DEFAULT_TERMS_SHA256]). Terms an owner has edited, even by one
 * word, are never recognised and never replaced.
 */
const val DEFAULT_CONTRACT_TERMS: String = """
SCOPE OF WORK
{COMPANY} will supply all labor, materials and equipment to install the
fencing described in this agreement at {ADDRESS}. Work not described here is
not included and will be quoted separately as a written change order.

PRICE AND PAYMENT
The agreed price is {TOTAL}. A deposit of {DEPOSIT} is due before materials are
ordered; the balance is due on completion. Prices assume the materials
described. If a supplier price changes materially before ordering, we will tell
you in writing before we proceed, and you may cancel for a full refund of any
deposit.

PROPERTY LINES
You are responsible for identifying the property line. We build where you tell
us to build. If a survey is required to establish it, that is arranged and paid
for by you before work begins.

UNDERGROUND UTILITIES
We will arrange a public utility locate before digging. Private lines --
irrigation, landscape lighting, invisible fencing, septic, gas to a pool heater
or grill -- are not covered by that locate. Please mark them. We are not liable
for damage to unmarked private lines.

SITE ACCESS AND CLEARING
The fence line must be clear before we arrive. We remove leaves and loose
debris only. Anything needing a tool -- bushes, planters, sheds, tree limbs,
old posts -- is cleared by you beforehand, or it becomes a change order. If the
crew cannot work because the line is not clear, a return visit may be charged.

GROUND CONDITIONS
Prices assume normal soil. Rock, buried concrete, tree roots or a high water
table can require extra work; if we hit that we stop, tell you what it will
cost, and continue only once you agree.

CHANGES
Any change to the scope, materials or layout is priced in writing and signed
before the work is done.

WARRANTY
Workmanship is warranted for {WARRANTY_PERIOD} from completion. Materials carry
their manufacturer's warranty only. This warranty does not cover storm damage,
impact, ground movement, neglect, alterations by others, or the normal
weathering, movement and color change of wood.

COMPLETION
Fence lines are built to follow the ground. Minor variation in height and gaps
along uneven terrain is normal and is not a defect.

CANCELLATION
You may cancel this agreement at any time before the work is finished. Notice
must be in writing; a text message or an email to {COMPANY} counts. It takes
effect when {COMPANY} receives it. Please call as well, so that an order can
be stopped before it is placed.

If you cancel before materials are ordered, your deposit is refunded in
full.

If you cancel after materials are ordered, you pay what your job has actually
cost {COMPANY} so far: materials ordered for your job that cannot be returned
or used on another job -- for example vinyl or other material already cut to
your height and length -- and any return or restocking charge the supplier
actually bills us on materials that can be returned. On request we will show
you the supplier's invoice. There is no fixed cancellation fee, and you are
not charged for materials we can return or use elsewhere.

If you cancel after installation has begun, you also pay for the
work already done.

What you owe under this section comes out of your deposit first, and any part
of the deposit left over is refunded to you. If you owe more than the deposit,
we will bill you for the difference. {COMPANY} will total the amount and give
it to you in writing.

If {COMPANY} cancels this agreement, or cannot do the work as described, we
refund what you have paid, less the agreed price of any work already
finished, and you owe nothing for materials we ordered.

Nothing in this section limits any right to cancel that the law gives you.

YOUR RIGHT TO CANCEL -- [REPLACE THIS BLOCK BEFORE USING THIS CONTRACT]
Most states require a home-improvement contract to state, in specific wording
and often in a specific type size, that the customer may cancel within three
business days of signing. The federal Cooling-Off Rule adds its own
requirements for contracts signed somewhere other than the seller's usual
place of business -- which is most fence jobs, since they are signed at the
customer's home. Leaving this out can make the contract unenforceable and can
carry a penalty on its own. Ask your attorney for the exact wording your state
requires and replace this paragraph with it.

By signing, you confirm you have read this agreement, that you own the property
or are authorized to have this work done, and that the fence line has been
walked and agreed.
"""

/**
 * The same default terms in Spanish. Same clauses, same order, same
 * placeholders, so a Spanish-speaking company's first contract reads as
 * theirs rather than as a translation bolted on. The cancellation block
 * keeps its REPLACE marker: state wording is the attorney's, not ours.
 *
 * This is a plain, literal translation done without a native Spanish
 * speaker's review. Every other clause here shipped that way already, but
 * it is worth repeating for CANCELACIÓN specifically: it is customer-facing
 * legal-adjacent text, exactly where a mistranslation can change what a
 * document promises. Get it checked before relying on it with a real
 * customer.
 */
const val DEFAULT_CONTRACT_TERMS_ES: String = """
ALCANCE DEL TRABAJO
{COMPANY} suministrará toda la mano de obra, los materiales y el equipo para
instalar la cerca descrita en este acuerdo en {ADDRESS}. El trabajo no descrito
aquí no está incluido y se cotizará por separado como una orden de cambio por
escrito.

PRECIO Y PAGO
El precio acordado es {TOTAL}. Un depósito de {DEPOSIT} vence antes de pedir los
materiales; el saldo vence al terminar. Los precios suponen los materiales
descritos. Si el precio de un proveedor cambia de forma importante antes del
pedido, se lo informaremos por escrito antes de continuar, y usted podrá
cancelar con reembolso total del depósito.

LÍNEAS DE PROPIEDAD
Usted es responsable de identificar la línea de propiedad. Construimos donde
usted nos indique. Si se requiere un levantamiento topográfico para
establecerla, usted lo gestiona y lo paga antes de comenzar el trabajo.

SERVICIOS SUBTERRÁNEOS
Gestionaremos la localización de servicios públicos antes de excavar. Las
líneas privadas -- riego, iluminación de jardín, cerca invisible, séptico, gas
a calentador de piscina o parrilla -- no quedan cubiertas por esa localización.
Por favor márquelas. No somos responsables por daños a líneas privadas sin
marcar.

ACCESO Y DESPEJE DEL SITIO
La línea de la cerca debe estar despejada antes de nuestra llegada. Retiramos
solo hojas y escombros sueltos. Todo lo que requiera una herramienta --
arbustos, macetas, cobertizos, ramas, postes viejos -- lo despeja usted de
antemano, o se convierte en una orden de cambio. Si la cuadrilla no puede
trabajar porque la línea no está despejada, se podrá cobrar una nueva visita.

CONDICIONES DEL TERRENO
Los precios suponen suelo normal. Roca, concreto enterrado, raíces o un nivel
freático alto pueden requerir trabajo adicional; si lo encontramos, nos
detenemos, le informamos el costo y continuamos solo con su aprobación.

CAMBIOS
Cualquier cambio de alcance, materiales o trazado se cotiza por escrito y se
firma antes de realizar el trabajo.

GARANTÍA
La mano de obra está garantizada por {WARRANTY_PERIOD} a partir de la
terminación. Los materiales llevan únicamente la garantía de su fabricante.
Esta garantía no cubre daños por tormenta, impactos, movimiento del terreno,
descuido, alteraciones por terceros, ni el desgaste, movimiento y cambio de
color normales de la madera.

TERMINACIÓN
Las cercas se construyen siguiendo el terreno. Una variación menor de altura y
de separaciones en terreno irregular es normal y no constituye un defecto.

CANCELACIÓN
Usted puede cancelar este acuerdo en cualquier momento antes de que el trabajo
termine. El aviso debe ser por escrito; un mensaje de texto o un correo
electrónico a {COMPANY} es válido. Surte efecto cuando {COMPANY} lo recibe.
Le pedimos que también llame, para poder detener un pedido antes de que se
haga.

Si cancela antes de pedir los materiales, se le reembolsa el depósito en su
totalidad.

Si cancela después de pedir los materiales, usted paga lo que su trabajo le ha
costado realmente a {COMPANY} hasta ese momento: los materiales pedidos para su
trabajo que no se pueden devolver ni usar en otro trabajo -- por ejemplo,
vinilo u otro material ya cortado a su altura y largo -- y cualquier cargo de
devolución que el proveedor nos cobre realmente por materiales que sí se
pueden devolver. Si lo solicita, le mostraremos la factura del proveedor. No
hay una tarifa fija de cancelación, y no se le cobran los materiales que
podamos devolver o usar en otro lugar.

Si cancela después de que la instalación haya comenzado, usted también paga el
trabajo ya realizado.

Lo que usted deba según esta sección se descuenta primero de su depósito, y
cualquier parte del depósito que sobre se le reembolsa. Si debe más que el
depósito, le cobraremos la diferencia. {COMPANY} calculará el monto y se lo
entregará por escrito.

Si {COMPANY} cancela este acuerdo, o no puede hacer el trabajo como se
describe, le reembolsamos lo que haya pagado, menos el precio acordado por el
trabajo ya terminado, y usted no debe nada por los materiales que pedimos.

Nada en esta sección limita ningún derecho de cancelación que la ley le
otorgue.

SU DERECHO A CANCELAR -- [REEMPLACE ESTE BLOQUE ANTES DE USAR ESTE CONTRATO]
La mayoría de los estados exigen que un contrato de mejoras al hogar indique,
con una redacción específica y a menudo en un tamaño de letra específico, que el
cliente puede cancelar dentro de los tres días hábiles siguientes a la firma. La
Regla federal de Enfriamiento añade sus propios requisitos para contratos
firmados fuera del lugar habitual de negocios del vendedor -- que es la mayoría
de los trabajos de cerca, ya que se firman en casa del cliente. Omitirlo puede
hacer el contrato inexigible y acarrear una sanción por sí mismo. Pida a su
abogado la redacción exacta que exige su estado y reemplace este párrafo.

Al firmar, usted confirma que ha leído este acuerdo, que es propietario del
inmueble o está autorizado a encargar este trabajo, y que la línea de la cerca
se ha recorrido y acordado.
"""

/**
 * The same default terms in French. See [DEFAULT_CONTRACT_TERMS_ES] --
 * the same "get ANNULATION checked by a native speaker before relying on
 * it" note applies here.
 */
const val DEFAULT_CONTRACT_TERMS_FR: String = """
ÉTENDUE DES TRAVAUX
{COMPANY} fournira la main-d'œuvre, les matériaux et l'équipement nécessaires
pour installer la clôture décrite dans le présent accord à {ADDRESS}. Les
travaux non décrits ici ne sont pas inclus et feront l'objet d'un devis séparé
sous forme d'ordre de modification écrit.

PRIX ET PAIEMENT
Le prix convenu est de {TOTAL}. Un acompte de {DEPOSIT} est dû avant la
commande des matériaux ; le solde est dû à l'achèvement. Les prix supposent les
matériaux décrits. Si le prix d'un fournisseur change de façon notable avant la
commande, nous vous en informerons par écrit avant de poursuivre, et vous
pourrez annuler avec remboursement intégral de l'acompte.

LIMITES DE PROPRIÉTÉ
Il vous appartient d'identifier la limite de propriété. Nous construisons là où
vous nous l'indiquez. Si un relevé d'arpentage est nécessaire pour l'établir,
vous l'organisez et le payez avant le début des travaux.

RÉSEAUX ENTERRÉS
Nous ferons effectuer un repérage des réseaux publics avant de creuser. Les
lignes privées -- arrosage, éclairage de jardin, clôture invisible, fosse
septique, gaz vers un chauffe-piscine ou un barbecue -- ne sont pas couvertes
par ce repérage. Merci de les marquer. Nous ne sommes pas responsables des
dommages aux lignes privées non marquées.

ACCÈS ET DÉGAGEMENT DU SITE
La ligne de clôture doit être dégagée avant notre arrivée. Nous retirons
uniquement les feuilles et les débris meubles. Tout ce qui demande un outil --
arbustes, jardinières, abris, branches, anciens poteaux -- est dégagé par vous
au préalable, sinon cela devient un ordre de modification. Si l'équipe ne peut
pas travailler parce que la ligne n'est pas dégagée, un déplacement
supplémentaire pourra être facturé.

ÉTAT DU SOL
Les prix supposent un sol normal. La roche, le béton enterré, les racines ou une
nappe phréatique haute peuvent exiger un travail supplémentaire ; si nous en
rencontrons, nous arrêtons, vous indiquons le coût et ne poursuivons qu'avec
votre accord.

MODIFICATIONS
Toute modification de l'étendue, des matériaux ou du tracé est chiffrée par
écrit et signée avant l'exécution des travaux.

GARANTIE
La main-d'œuvre est garantie {WARRANTY_PERIOD} à compter de l'achèvement. Les
matériaux ne bénéficient que de la garantie de leur fabricant. Cette garantie ne
couvre pas les dégâts de tempête, les chocs, les mouvements de terrain, la
négligence, les modifications par des tiers, ni le vieillissement, le mouvement
et le changement de couleur normaux du bois.

ACHÈVEMENT
Les clôtures suivent le terrain. Une légère variation de hauteur et d'écart sur
un terrain irrégulier est normale et ne constitue pas un défaut.

ANNULATION
Vous pouvez annuler le présent accord à tout moment avant la fin des travaux.
L'avis doit être donné par écrit ; un SMS ou un courriel adressé à {COMPANY}
est valable. Il prend effet lorsque {COMPANY} le reçoit. Appelez-nous aussi,
afin que nous puissions arrêter une commande avant qu'elle soit passée.

Si vous annulez avant la commande des matériaux, votre acompte vous est
remboursé intégralement.

Si vous annulez après la commande des matériaux, vous payez ce que votre
chantier a réellement coûté à {COMPANY} jusque-là : les matériaux commandés
pour votre projet qui ne peuvent pas être retournés ni utilisés pour un autre
chantier -- par exemple du vinyle ou un autre matériau déjà coupé à votre
hauteur et à votre longueur -- ainsi que les frais de retour ou de reprise que
le fournisseur nous facture réellement sur les matériaux qui peuvent être
retournés. Sur demande, nous vous montrerons la facture du fournisseur. Il n'y
a pas de frais d'annulation fixes, et les matériaux que nous pouvons retourner
ou utiliser ailleurs ne vous sont pas facturés.

Si vous annulez après le début de l'installation, vous payez également le
travail déjà effectué.

Ce que vous devez au titre de cette section est déduit en premier de votre
acompte, et toute partie de l'acompte restante vous est remboursée. Si vous
devez plus que l'acompte, nous vous facturerons la différence. {COMPANY}
calculera le montant et vous le remettra par écrit.

Si {COMPANY} annule le présent accord, ou ne peut pas réaliser les travaux tels
que décrits, nous vous remboursons ce que vous avez payé, moins le prix convenu
pour les travaux déjà terminés, et vous ne devez rien pour les matériaux que
nous avons commandés.

Rien dans cette section ne limite un droit d'annulation que la loi vous
accorde.

VOTRE DROIT D'ANNULATION -- [REMPLACEZ CE BLOC AVANT D'UTILISER CE CONTRAT]
La plupart des États exigent qu'un contrat de rénovation résidentielle indique,
dans une formulation précise et souvent dans une taille de caractères précise,
que le client peut annuler dans les trois jours ouvrables suivant la signature.
La règle fédérale dite « Cooling-Off » ajoute ses propres exigences pour les
contrats signés ailleurs qu'au lieu d'affaires habituel du vendeur -- soit la
plupart des chantiers de clôture, signés chez le client. L'omettre peut rendre
le contrat inopposable et entraîner une pénalité en soi. Demandez à votre
avocat la formulation exacte exigée par votre État et remplacez ce paragraphe.

En signant, vous confirmez avoir lu le présent accord, être propriétaire du
bien ou autorisé à faire exécuter ces travaux, et que le tracé de la clôture a
été parcouru et convenu.
"""

/**
 * The default terms in the company's language.
 *
 * Used wherever the profile still holds the untouched English default: the
 * contract then prints in the language the company works in, and custom
 * terms an owner has edited print exactly as written.
 */
fun defaultContractTermsFor(language: AppLanguage): String = when (language) {
    AppLanguage.SPANISH -> DEFAULT_CONTRACT_TERMS_ES
    AppLanguage.FRENCH -> DEFAULT_CONTRACT_TERMS_FR
    else -> DEFAULT_CONTRACT_TERMS
}

/**
 * True when the terms still carry the unresolved right-to-cancel block.
 *
 * Stricter than [isDefaultContractTerms] on purpose: an owner who edited the
 * warranty wording and left this block alone has terms that are no longer
 * "the default" but are still missing the one clause whose absence can void
 * the whole agreement. Most states require a home-improvement contract to
 * state, in particular words and often at a particular size, that the
 * customer may cancel within three business days; the federal cooling-off
 * rule adds its own requirement for anything signed away from the seller's
 * usual place of business, which is nearly every fence job. Matched on the
 * marker in all three shipped languages.
 */
fun contractTermsNeedLegalReview(terms: String): Boolean =
    terms.contains("[REPLACE THIS BLOCK", ignoreCase = true) ||
        terms.contains("[REEMPLACE ESTE BLOQUE", ignoreCase = true) ||
        terms.contains("[REMPLACEZ CE BLOC", ignoreCase = true)

/**
 * SHA-256 (see [termsFingerprint]) of every default this app has shipped
 * before the current ones, in all three languages. A phone whose stored terms
 * hash to one of these still holds an untouched shipped default -- just an
 * older one -- so it is treated as the default and prints the current text.
 *
 * Fingerprints rather than the old texts themselves: nine near-copies of
 * contract language would sit in this file looking like live terms and
 * inviting someone to edit the wrong one. Each value was taken from the
 * constant as it stood in git at the commit named beside it.
 *
 * When a default is next changed, add the fingerprint of the one being
 * replaced here BEFORE editing it. Forgetting is silent: phones holding the
 * old default would keep printing it and nothing would say so.
 */
private val SUPERSEDED_DEFAULT_TERMS_SHA256: Set<String> = setOf(
    // English: 7f8031d (original), 7c91a1d (first cancellation notice),
    // 86d5aa3 (cancellation clause with the owner fill-in block).
    "a442a5c2352aafebe637f3ae85ab0e2f346ff2af014bd6093b895c0fb2257af4",
    "f648420a19ef31b382e7d714ed45d837115f9cfff825a583c74cd0005f98f366",
    "9c342e03fd66ef8d3edcd5377db6125f50d6ab5616ae44f64cbcf981c5d3bb44",
    // Spanish: 3240c1d, 834b7c8 (and 04ff2f9), 86d5aa3.
    "940853ffe7e0b906382b28dc9575c4295ad2f5cf5b7a19972bf8cea39d04ba36",
    "ac2bc2605e169c92b628273187f1e659f469170f3d1a1d23578f10d04d43135e",
    "d9eb19bbb58c50c71dc2206a7e1a4868845cdbce033be784a9d477c92050353f",
    // French: 3240c1d, 834b7c8 (and 04ff2f9), 86d5aa3.
    "9a93b59030cfc5c33bd5749178ecb8609a5fc906ef6482c83985c41e4e7dd537",
    "c24a059474b6ecc51cc438c3e275d4c82d0a5a22496b73a8a493d184455d523e",
    "98903a54ea80ba532b452f6c08c015047a64ec72002be97964001e2c86cff437"
)

/**
 * Hex SHA-256 of [terms] with the surrounding whitespace trimmed and line
 * endings normalised to \n, so a stored copy written on a machine that
 * saved CRLF still matches.
 */
private fun termsFingerprint(terms: String): String {
    val canonical = terms.trim().replace("\r\n", "\n")
    val digest = java.security.MessageDigest.getInstance("SHA-256")
        .digest(canonical.toByteArray(Charsets.UTF_8))
    return digest.joinToString("") { b -> "%02x".format(b.toInt() and 0xff) }
}

/** True when [terms] is an untouched default this app shipped in the past. */
fun isSupersededDefaultContractTerms(terms: String): Boolean =
    termsFingerprint(terms) in SUPERSEDED_DEFAULT_TERMS_SHA256

/**
 * True when [terms] is an untouched shipped default in any language, current
 * or earlier. Exact match only: anything an owner has edited is theirs.
 */
fun isDefaultContractTerms(terms: String): Boolean {
    val t = terms.trim()
    return t == DEFAULT_CONTRACT_TERMS.trim() ||
        t == DEFAULT_CONTRACT_TERMS_ES.trim() ||
        t == DEFAULT_CONTRACT_TERMS_FR.trim() ||
        isSupersededDefaultContractTerms(t)
}
