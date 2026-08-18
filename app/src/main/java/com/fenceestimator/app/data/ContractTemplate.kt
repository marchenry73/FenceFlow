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
