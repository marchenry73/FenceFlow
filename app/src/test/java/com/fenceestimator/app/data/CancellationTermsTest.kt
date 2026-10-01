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
 * covering all three phases.
 *
 * UPDATE, 2026-10-01: the owner asked for the notice-period and
 * restocking-charge blanks to be written for him. The clause now charges
 * what a cancelled job has actually cost, so no default asks the owner for a
 * figure, the "fill this in" bracket this class used to pin is gone, and the
 * tests below pin its absence instead. The statutory right-to-cancel block
 * is the only thing left for the owner, and [contractTermsNeedLegalReview]
 * must keep firing on exactly that marker and nothing else.
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
    fun `no default asks the owner to fill in a notice period or restocking charge`() {
        assertFalse(DEFAULT_CONTRACT_TERMS.contains("FILL THIS IN"))
        assertFalse(DEFAULT_CONTRACT_TERMS.contains("NOTICE AND RESTOCKING CHARGE"))
        assertFalse(DEFAULT_CONTRACT_TERMS_ES.contains("COMPLETE ESTO"))
        assertFalse(DEFAULT_CONTRACT_TERMS_FR.contains("REMPLISSEZ CECI"))
    }

    @Test
    fun `the cancellation clause charges actual costs and states no figure`() {
        val sections = listOf(
            DEFAULT_CONTRACT_TERMS.substringAfter("\nCANCELLATION\n")
                .substringBefore("\nYOUR RIGHT TO CANCEL"),
            DEFAULT_CONTRACT_TERMS_ES.substringAfter("\nCANCELACIÓN\n")
                .substringBefore("\nSU DERECHO A CANCELAR"),
            DEFAULT_CONTRACT_TERMS_FR.substringAfter("\nANNULATION\n")
                .substringBefore("\nVOTRE DROIT D'ANNULATION")
        )
        sections.forEach { section ->
            // A section that was not found would be empty and pass every
            // "contains no digit" check below for the wrong reason.
            assertTrue("cancellation section not found or truncated", section.length > 800)
            assertFalse("a figure crept into the cancellation clause", section.any { it.isDigit() })
            assertFalse("a percentage crept into the cancellation clause", section.contains('%'))
        }
        // The cases an owner actually meets, in the English text.
        val en = DEFAULT_CONTRACT_TERMS
        assertTrue(en.contains("must be in writing", ignoreCase = true))
        assertTrue(en.contains("already cut to", ignoreCase = true))
        assertTrue(en.contains("{COMPANY} cancels this agreement", ignoreCase = true))
    }

    @Test
    fun `the statutory replace block is still in every default and is the only bracketed marker`() {
        // Not removed on the owner's say-so, because the wording is the
        // attorney's: see ShippedDefaultsTest. And nothing else in the text may
        // be a bracketed "fill this in", or the owner is back to being asked
        // for figures this app cannot know.
        assertTrue(DEFAULT_CONTRACT_TERMS.contains("[REPLACE THIS BLOCK BEFORE USING THIS CONTRACT]"))
        assertTrue(DEFAULT_CONTRACT_TERMS_ES.contains("[REEMPLACE ESTE BLOQUE ANTES DE USAR ESTE CONTRATO]"))
        assertTrue(DEFAULT_CONTRACT_TERMS_FR.contains("[REMPLACEZ CE BLOC AVANT D'UTILISER CE CONTRAT]"))
        allDefaults.forEach { terms ->
            assertTrue("a second bracketed marker is back", terms.count { it == '[' } == 1)
        }
    }

    @Test
    fun `replacing the statutory block clears the legal gate`() {
        // Simulates an owner who has done exactly what the app asks: pasted
        // their attorney's wording over the right-to-cancel paragraph.
        // contractTermsNeedLegalReview must go false once that marker is
        // gone, and the rest of the shipped text needs nothing from them.
        val ownerEdited = DEFAULT_CONTRACT_TERMS
            .replace(
                "[REPLACE THIS BLOCK BEFORE USING THIS CONTRACT]",
                "as required by state law: [attorney's actual wording]"
            )
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
