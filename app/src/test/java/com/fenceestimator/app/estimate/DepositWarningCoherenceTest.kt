package com.fenceestimator.app.estimate

import com.fenceestimator.app.R
import com.fenceestimator.app.data.Job
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * "I have 3000 as deposit and it's still telling me that it does not cover the
 * estimated material cost, would be buying it with my own money when the cost
 * is 2828.48, I already have enough." -- 1 Oct 2026.
 *
 * He was right, and the sentence gave itself away: $3,000 is more than
 * $2,828.48. The check had drifted into testing one number and printing a
 * different one. The CONDITION asked whether money COLLECTED covered the
 * materials -- nothing had been collected, so 0.00 < 2828.48 fired -- and the
 * MESSAGE then printed the DEPOSIT, so the warning read as a claim about 3,000
 * that nothing had ever tested.
 *
 * That is a defect CLASS, not one typo: a condition and its message free to
 * talk about different figures. So the last test in this file is not about
 * deposits at all. It sweeps a grid of jobs and asserts that whatever warning
 * fires is arithmetic about its own printed numbers -- the figure a message
 * shows as the money available must itself fall short of the figure it shows as
 * the material cost, and the shortfall it quotes must be the difference between
 * the two. Any future edit that tests one number and prints another fails it,
 * whichever way round the mix-up goes.
 *
 * Warnings are structured (a string resource plus pre-formatted arguments), so
 * these assert on which resource fired and what figures it carries, never on
 * English wording -- renaming a string must not be able to break or silence
 * them.
 */
class DepositWarningCoherenceTest {

    private fun totals(materials: Double, grand: Double) = EstimateEngine.Totals(
        materialsSubtotal = materials,
        taxableSubtotal = materials,
        tax = 0.0,
        laborCost = 0.0,
        teardownCost = 0.0,
        markupAmount = 0.0,
        discountAmount = 0.0,
        grandTotal = grand
    )

    private fun warnings(
        deposit: Double = 0.0,
        paid: Double = 0.0,
        refunded: Double = 0.0,
        materials: Double,
        grand: Double = 6000.0
    ): List<EstimateWarning> = EstimateEngine.estimateWarnings(
        Job(
            customerName = "Test",
            depositAmount = deposit,
            amountPaid = paid,
            refundedAmount = refunded
        ),
        emptyList(), emptyList(), totals(materials, grand)
    )

    private fun List<EstimateWarning>.has(textRes: Int) = any { it.textRes == textRes }

    /** Either of the two "can I afford the materials" variants, or null. */
    private fun List<EstimateWarning>.affordability(): EstimateWarning? =
        firstOrNull { it.textRes == R.string.warn_deposit_short || it.textRes == R.string.warn_fronting_material }

    // --------------------------------------------- his numbers, exactly

    @Test
    fun `a 3000 deposit covers 2828 48 of materials and says nothing`() {
        val found = warnings(deposit = 3000.0, materials = 2828.48)
        assertNull(
            "3,000 is more than 2,828.48 -- there is nothing to warn about, and " +
                "saying so was the bug he reported",
            found.affordability()
        )
    }

    @Test
    fun `a deposit exactly equal to the materials covers them`() {
        // The boundary: "covers" has to include covering it to the cent, or the
        // warning fires on a job that is precisely funded.
        assertNull(warnings(deposit = 2828.48, materials = 2828.48).affordability())
    }

    // ------------------------------- the case the warning exists for

    @Test
    fun `no deposit at all against real materials still warns, naming both figures`() {
        // This must survive the fix. It is a fresh job -- nothing stores a
        // deposit until a person types or taps one -- and it is the case his
        // earlier report hit.
        val found = warnings(deposit = 0.0, materials = 2828.48)
        val short = found.first { it.textRes == R.string.warn_deposit_short }
        assertEquals(listOf("0.00", "2828.48"), short.args)
        assertFalse(found.has(R.string.warn_fronting_material))
    }

    @Test
    fun `a deposit that is short warns with the deposit that is short`() {
        val found = warnings(deposit = 1000.0, materials = 2828.48)
        val short = found.first { it.textRes == R.string.warn_deposit_short }
        // The figures in the message are the ones this test set, not a third
        // number from somewhere else.
        assertEquals(listOf("1000.00", "2828.48"), short.args)
    }

    // ------------------------------------------- once money has moved

    @Test
    fun `part paid is told what is actually being fronted, not what was intended`() {
        // A deposit is set AND is larger than the materials, but only $500 has
        // landed, so the 3,000 is an intention and the 500 is the money.
        // Buying materials today costs him 2,328.48 of his own.
        //
        // THE RULE IS UNCHANGED AND THE REASON IT USED TO GIVE IS NOT. This
        // comment said the app "stops asking for the deposit the moment any
        // payment arrives (JobMoney.nextRequestAmount asks for the balance)",
        // which stopped being true on 2 Oct 2026: the phone now asks for the
        // rest of the deposit first, because the customer's own page always
        // did and the two were on screen side by side. The warning is still
        // right, for a different reason -- what this line answers is "what
        // would buying the materials cost me TODAY", and the answer is cash in
        // hand, not money somebody has promised.
        val found = warnings(deposit = 3000.0, paid = 500.0, materials = 2828.48)
        val fronting = found.first { it.textRes == R.string.warn_fronting_material }
        assertEquals(listOf("500.00", "2828.48", "2328.48"), fronting.args)
        assertFalse(
            "the deposit stopped being the figure that decides this",
            found.has(R.string.warn_deposit_short)
        )
    }

    @Test
    fun `paid in full says nothing at all`() {
        // The original defect: it went on warning about covering materials
        // after the customer had paid the whole job.
        val found = warnings(deposit = 100.0, paid = 6000.0, materials = 2828.48)
        assertNull(found.affordability())
    }

    @Test
    fun `collected above the materials but below the price says nothing`() {
        val found = warnings(deposit = 100.0, paid = 3000.0, materials = 2828.48)
        assertNull(found.affordability())
    }

    @Test
    fun `money given back is money not collected, and the deposit decides again`() {
        // netPaid is zero, so this is the no-money-in case: the deposit is what
        // is left to arrive, and here it is short.
        val found = warnings(deposit = 500.0, paid = 6000.0, refunded = 6000.0, materials = 2828.48)
        val short = found.first { it.textRes == R.string.warn_deposit_short }
        assertEquals(listOf("500.00", "2828.48"), short.args)
    }

    @Test
    fun `a job with no materials priced is never told to cover them`() {
        assertNull(warnings(deposit = 0.0, materials = 0.0).affordability())
    }

    // ------------------------------------------------- the defect class

    /**
     * THE RULE THIS FILE EXISTS FOR, and it is not about deposits.
     *
     * Every figure a warning prints has to be a figure its own condition
     * tested. Checked by reading the message back as arithmetic: the money it
     * says is available must be less than the material cost it says is owed --
     * because that shortfall is the only thing that justifies printing it at
     * all -- and any third figure must be the difference.
     *
     * This fails on the shipped defect. Deposit 3,000, nothing collected,
     * materials 2,828.48 printed "3000.00" against "2828.48": the message's own
     * two numbers do not support the message.
     */
    @Test
    fun `no warning ever prints a figure its condition did not test`() {
        val deposits = listOf(0.0, 1.0, 500.0, 1000.0, 2828.47, 2828.48, 3000.0, 9000.0)
        val payments = listOf(0.0, 0.004, 500.0, 2828.48, 3000.0, 6000.0)
        val materials = listOf(0.0, 0.01, 1630.0, 2828.48, 5999.0)

        var sawDepositShort = 0
        var sawFronting = 0
        var checked = 0

        for (deposit in deposits) for (paid in payments) for (material in materials) {
            val found = warnings(deposit = deposit, paid = paid, materials = material)
            val warning = found.affordability() ?: continue
            checked++
            val case = "deposit=$deposit paid=$paid materials=$material args=${warning.args}"

            // Materials is always the SECOND figure in both variants, and it
            // must be the materials this case actually had.
            val printedMaterials = warning.args[1].toString().toDouble()
            assertEquals("$case: printed material cost", material, printedMaterials, 0.005)

            // The first figure is the money available. The warning only has a
            // reason to exist if that figure falls short.
            val printedAvailable = warning.args[0].toString().toDouble()
            assertTrue(
                "$case: printed ${warning.args[0]} as the money available against " +
                    "${warning.args[1]} of materials -- that covers it, so this " +
                    "sentence is nonsense and the condition tested some other number",
                printedAvailable < printedMaterials
            )

            when (warning.textRes) {
                R.string.warn_fronting_material -> {
                    sawFronting++
                    assertEquals(3, warning.args.size)
                    val printedShortfall = warning.args[2].toString().toDouble()
                    assertEquals(
                        "$case: shortfall must be the gap between its own two figures",
                        printedMaterials - printedAvailable, printedShortfall, 0.005
                    )
                    // Money has moved, so the figure shown is the money, never
                    // the deposit -- unless the two happen to be equal.
                    assertTrue(
                        "$case: fronting must report collected money",
                        kotlin.math.abs(printedAvailable - paid) <= 0.005
                    )
                }
                R.string.warn_deposit_short -> {
                    sawDepositShort++
                    assertEquals(2, warning.args.size)
                    assertTrue(
                        "$case: with no money in, the figure shown must be the deposit",
                        kotlin.math.abs(printedAvailable - deposit) <= 0.005
                    )
                }
                else -> throw AssertionError("$case: unexpected resource")
            }
        }

        // A sweep that fired nothing would pass every assertion above without
        // testing anything. Both variants have to have been exercised.
        assertTrue("the sweep must reach warn_deposit_short", sawDepositShort > 0)
        assertTrue("the sweep must reach warn_fronting_material", sawFronting > 0)
        assertTrue("the sweep must have checked a real number of cases", checked > 20)
    }
}
