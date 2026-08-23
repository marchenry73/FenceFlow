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
You may cancel in writing before materials are ordered for a full refund of the
deposit. After materials are ordered, the deposit covers materials already
bought and restocking charges.

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
Usted puede cancelar por escrito antes de que se pidan los materiales, con
reembolso total del depósito. Después de pedidos los materiales, el depósito
cubre los materiales ya comprados y los cargos de devolución.

SU DERECHO A CANCELAR -- [REEMPLACE ESTE BLOQUE ANTES DE USAR ESTE CONTRATO]
La mayoría de los estados exigen que un contrato de mejoras al hogar indique,
con una redacción específica y a menudo en un tamaño de letra específico, que el
cliente puede cancelar dentro de los tres días hábiles siguientes a la firma. La
Regla federal de Enfriamiento añade sus propios requisitos para contratos
firmados fuera del lugar habitual de negocios del vendedor -- que es la mayoría
de los trabajos de cerca, ya que se firman en casa del cliente. Omitirlo puede
hacer el contrato inexigible y acarrear una sanción por sí mismo. Pida a su
abogado la redacción exacta que exige su estado y reemplace este párrafo.
"""

/** The same default terms in French. See [DEFAULT_CONTRACT_TERMS_ES]. */
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
Vous pouvez annuler par écrit avant la commande des matériaux, avec
remboursement intégral de l'acompte. Une fois les matériaux commandés,
l'acompte couvre les matériaux déjà achetés et les frais de reprise.

VOTRE DROIT D'ANNULATION -- [REMPLACEZ CE BLOC AVANT D'UTILISER CE CONTRAT]
La plupart des États exigent qu'un contrat de rénovation résidentielle indique,
dans une formulation précise et souvent dans une taille de caractères précise,
que le client peut annuler dans les trois jours ouvrables suivant la signature.
La règle fédérale dite « Cooling-Off » ajoute ses propres exigences pour les
contrats signés ailleurs qu'au lieu d'affaires habituel du vendeur -- soit la
plupart des chantiers de clôture, signés chez le client. L'omettre peut rendre
le contrat inopposable et entraîner une pénalité en soi. Demandez à votre
avocat la formulation exacte exigée par votre État et remplacez ce paragraphe.
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

/** True when [terms] is one of the shipped defaults in any language. */
fun isDefaultContractTerms(terms: String): Boolean {
    val t = terms.trim()
    return t == DEFAULT_CONTRACT_TERMS.trim() ||
        t == DEFAULT_CONTRACT_TERMS_ES.trim() ||
        t == DEFAULT_CONTRACT_TERMS_FR.trim()
}
