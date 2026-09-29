package com.fenceestimator.app.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Owner's list, item C1: "Cancellation is not filled in -- make it work."
 *
 * Scouting found the CANCELLATION clause already existed in
 * [DEFAULT_CONTRACT_TERMS] (and its ES/FR twins), was already editable (the
 * free-text box in Settings), and already reached the customer's PDF
 * ([com.fenceestimator.app.estimate.PdfExporter] prints
 * `business.contractTerms` whenever `docKind.showsContractTerms`). What was
 * actually thin: the clause only covered two of three real phases -- before
 * and after materials are ordered -- and said nothing about labor already
 * performed once installation starts, or that any deposit left over after
 * covering materials is returned. It also left the owner's own
 * notice-period and restocking-charge numbers with no visible prompt to set
 * them, unlike the existing right-to-cancel block.
 *
 * These tests lock in that all three shipped languages still carry a real
 * CANCELLATION clause -- not a blank, and not the old two-sentence stub --
 * covering all three phases, and that the new "fill this in" bracket is a
 * SEPARATE marker from the statutory right-to-cancel block. That separation
 * matters: [contractTermsNeedLegalReview] must not fire on the new bracket,
 * or every company would be told to "ask your attorney" (the exact wording
 * of that warning, see strings.xml `set_contract_terms_review_body`) about a
 * restocking fee, which is a business choice, not a legal one.
 */
class CancellationTermsTest {

    private val allDefaults = listOf(DEFAULT_CONTRACT_TERMS, DEFAULT_CONTRACT_TERMS_ES, DEFAULT_CONTRACT_TERMS_FR)

    @Test
    fun `every shipped default still has a cancellation heading and a refund promise`() {
        allDefaults.forEach { terms ->
            // Per language, like the refund check below it. The French clause
            // is ANNULATION and the verb is "annuler" -- there is no "cancel"
            // anywhere in it, so a bare contains("CANCEL") could only ever
            // fail on FR. English CANCELLATION and Spanish CANCELACION both
            // carry "cancel"; French carries "annul".
            assertTrue(
                terms.contains("CANCEL", ignoreCase = true) ||
                    terms.contains("ANNUL", ignoreCase = true)
            )
            assertTrue(
                terms.contains("refund", ignoreCase = true) ||
                    terms.contains("reembols", ignoreCase = true) ||
                    terms.contains("rembours", ignoreCase = true)
            )
        }
    }

    @Test
    fun `the english default covers all three cancellation phases, not just two`() {
        val t = DEFAULT_CONTRACT_TERMS
        // Phase 1: before materials are ordered -- full refund.
        assertTrue(t.contains("before materials are ordered", ignoreCase = true))
        // Phase 2: after materials are ordered -- any leftover deposit comes back.
        assertTrue(t.contains("left over", ignoreCase = true))
        assertTrue(t.contains("refunded to you", ignoreCase = true))
        // Phase 3: once installation has begun, labor already done is owed too.
        assertTrue(t.contains("installation has begun", ignoreCase = true))
        assertTrue(t.contains("work already done", ignoreCase = true))
    }

    @Test
    fun `the spanish and french defaults mirror all three phases`() {
        val es = DEFAULT_CONTRACT_TERMS_ES
        assertTrue(es.contains("antes de pedir los materiales", ignoreCase = true))
        assertTrue(es.contains("se le reembolsa", ignoreCase = true))
        assertTrue(es.contains("instalación haya comenzado", ignoreCase = true))
        assertTrue(es.contains("trabajo ya realizado", ignoreCase = true))

        val fr = DEFAULT_CONTRACT_TERMS_FR
        assertTrue(fr.contains("avant la commande des matériaux", ignoreCase = true))
        assertTrue(fr.contains("remboursé", ignoreCase = true))
        assertTrue(fr.contains("début de l'installation", ignoreCase = true))
        assertTrue(fr.contains("travail déjà effectué", ignoreCase = true))
    }

    @Test
    fun `the owner fill-in bracket for notice and restocking charge is present in all three languages`() {
        assertTrue(DEFAULT_CONTRACT_TERMS.contains("[FILL THIS IN BEFORE USING THIS CONTRACT]"))
        assertTrue(DEFAULT_CONTRACT_TERMS_ES.contains("[COMPLETE ESTO ANTES DE USAR ESTE CONTRATO]"))
        assertTrue(DEFAULT_CONTRACT_TERMS_FR.contains("[REMPLISSEZ CECI AVANT D'UTILISER CE CONTRAT]"))
    }

    @Test
    fun `the new fill-in bracket is a distinct string from the statutory replace block`() {
        // Both brackets are deliberately different literal text. If someone
        // later "simplifies" the new one to reuse REPLACE-style wording, it
        // would start tripping the legal-review gate for a business decision
        // that is not a legal one -- this pins the two markers apart.
        assertFalse("[FILL THIS IN BEFORE USING THIS CONTRACT]".contains("[REPLACE THIS BLOCK"))
        assertTrue(DEFAULT_CONTRACT_TERMS.contains("[REPLACE THIS BLOCK BEFORE USING THIS CONTRACT]"))
        assertTrue(DEFAULT_CONTRACT_TERMS.contains("[FILL THIS IN BEFORE USING THIS CONTRACT]"))
    }

    @Test
    fun `replacing only the statutory block clears the legal gate, fill-in bracket notwithstanding`() {
        // Simulates an owner who has done exactly what the app asks: pasted
        // their attorney's wording over the right-to-cancel paragraph, but
        // has NOT yet touched the new notice/restocking bracket above it.
        // contractTermsNeedLegalReview must go false regardless -- it is
        // scoped to the statutory marker only, not to "any bracket at all".
        val ownerEdited = DEFAULT_CONTRACT_TERMS
            .replace(
                "[REPLACE THIS BLOCK BEFORE USING THIS CONTRACT]",
                "as required by state law: [attorney's actual wording]"
            )
        assertTrue(ownerEdited.contains("[FILL THIS IN BEFORE USING THIS CONTRACT]"))
        assertFalse(contractTermsNeedLegalReview(ownerEdited))

        val ownerEditedEs = DEFAULT_CONTRACT_TERMS_ES
            .replace(
                "[REEMPLACE ESTE BLOQUE ANTES DE USAR ESTE CONTRATO]",
                "según lo exige la ley estatal: [redacción real del abogado]"
            )
        assertFalse(contractTermsNeedLegalReview(ownerEditedEs))

        val ownerEditedFr = DEFAULT_CONTRACT_TERMS_FR
            .replace(
                "[REMPLACEZ CE BLOC AVANT D'UTILISER CE CONTRAT]",
                "comme l'exige la loi de l'État : [formulation réelle de l'avocat]"
            )
        assertFalse(contractTermsNeedLegalReview(ownerEditedFr))
    }

    @Test
    fun `the shipped defaults still need legal review until the owner replaces the statutory block`() {
        allDefaults.forEach { terms -> assertTrue(contractTermsNeedLegalReview(terms)) }
    }

    @Test
    fun `the rewritten defaults are still recognised as the shipped default, and an edit is not`() {
        assertTrue(isDefaultContractTerms(DEFAULT_CONTRACT_TERMS))
        assertTrue(isDefaultContractTerms(DEFAULT_CONTRACT_TERMS_ES))
        assertTrue(isDefaultContractTerms(DEFAULT_CONTRACT_TERMS_FR))
        assertFalse(isDefaultContractTerms(DEFAULT_CONTRACT_TERMS.replace("CANCELLATION", "CANCELLATION (edited)")))
    }

    @Test
    fun `defaultContractTermsFor still returns the matching language`() {
        assertTrue(defaultContractTermsFor(AppLanguage.SPANISH) == DEFAULT_CONTRACT_TERMS_ES)
        assertTrue(defaultContractTermsFor(AppLanguage.FRENCH) == DEFAULT_CONTRACT_TERMS_FR)
        assertTrue(defaultContractTermsFor(AppLanguage.ENGLISH) == DEFAULT_CONTRACT_TERMS)
    }
}
