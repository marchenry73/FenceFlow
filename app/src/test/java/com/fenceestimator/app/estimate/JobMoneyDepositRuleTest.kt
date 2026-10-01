package com.fenceestimator.app.estimate

import com.fenceestimator.app.R
import com.fenceestimator.app.data.EstimateLineItem
import com.fenceestimator.app.data.Job
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 1 Oct 2026: the total is EXACT to the cent, and the deposit is the materials
 * still to be bought, rounded up to the next $100, plus another $100 -- never
 * more than is still owed.
 *
 * The rows come from tests/a29-deposit-rule-vectors.json, the SAME file
 * tests/a29-deposit-and-rounding.test.mjs runs against the TypeScript side
 * (_shared/quote-deposit.ts). That is the point of sharing it: the phone and
 * the server cannot give two answers to one input without one of the two
 * suites going red. Every expected value in it was worked out by hand from the
 * owner's rules, not copied from either implementation.
 *
 * The engine tests call computeTotals the way the app calls it, with a Job
 * whose tax is explicit (Job defaults to 7%) and assert the exact double
 * (delta 0.0), because "exact" is the whole claim and a tolerance of a cent
 * would hide the thing being fixed.
 */
class JobMoneyDepositRuleTest {

    private val vectors: JsonObject by lazy {
        // Gradle runs unit tests with the module (app/) as the working
        // directory; from the repo root the same folder is one level up.
        val file = listOf(File("tests/a29-deposit-rule-vectors.json"), File("../tests/a29-deposit-rule-vectors.json"))
            .firstOrNull { it.isFile }
            ?: throw AssertionError("tests/a29-deposit-rule-vectors.json not found from ${File(".").absolutePath}")
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun rows(name: String): List<JsonObject> {
        val list = vectors.getValue(name).jsonArray.map { it.jsonObject }
        assertTrue("the vector file lost its $name rows", list.size >= 10)
        return list
    }

    private fun num(row: JsonObject, key: String): Double = row.getValue(key).jsonPrimitive.double

    private fun job(
        deposit: Double = 0.0,
        paid: Double = 0.0,
        refunded: Double = 0.0,
        signedAt: Long? = null,
        approvedAt: Long? = null,
        reapproval: Long? = null,
    ) = Job(
        customerName = "Test",
        depositAmount = deposit,
        amountPaid = paid,
        refundedAmount = refunded,
        signedAt = signedAt,
        quoteApprovedAt = approvedAt,
        reapprovalRequiredAt = reapproval,
    )

    // ------------------------------------------------------------ rounding

    @Test
    fun `roundToCents gives the shared vectors exactly`() {
        for (row in rows("roundToCents")) {
            assertEquals(
                "${row.getValue("name").jsonPrimitive.content}: roundToCents(${num(row, "in")})",
                num(row, "out"), EstimateEngine.roundToCents(num(row, "in")), 0.0
            )
        }
    }

    @Test
    fun `roundToCents leaves a non-finite value visibly broken instead of turning NaN into zero`() {
        // Math.round(NaN) is 0 on the JVM: without the guard a NaN total would
        // quietly become a $0.00 quote.
        assertTrue(EstimateEngine.roundToCents(Double.NaN).isNaN())
        assertEquals(Double.POSITIVE_INFINITY, EstimateEngine.roundToCents(Double.POSITIVE_INFINITY), 0.0)
        assertEquals(Double.NEGATIVE_INFINITY, EstimateEngine.roundToCents(Double.NEGATIVE_INFINITY), 0.0)
    }

    @Test
    fun `roundToCents halves go toward positive infinity, the way the server does`() {
        // kotlin.math.round would give 0.12 here (half to even); the server's
        // Math.round gives 0.13, so the phone must too.
        assertEquals(0.13, EstimateEngine.roundToCents(0.125), 0.0)
        assertEquals(0.12, kotlin.math.round(12.5) / 100.0, 0.0)
    }

    // -------------------------------------------------------------- engine

    private fun exactJob(minimum: Double = 0.0, tax: Double = 0.0, markup: Double = 0.0, discount: Double = 0.0) = Job(
        customerName = "Test", laborRatePerFt = 0.0, taxRatePercent = tax,
        markupPercent = markup, discountPercent = discount, minimumJobCharge = minimum,
    )

    private fun line(price: Double, taxable: Boolean = false, id: Long = 1) = EstimateLineItem(
        jobId = 1, description = "line $id", quantity = 1.0, unitPrice = price, taxable = taxable,
    )

    private fun grand(job: Job, vararg prices: Double): Double =
        EstimateEngine.computeTotals(job, prices.mapIndexed { i, p -> line(p, id = i + 1L) }, 0f).grandTotal

    @Test
    fun `the total is exact to the cent, not rounded up to the next ten`() {
        assertEquals(2113.01, grand(exactJob(), 2113.01), 0.0)
        // Planted: the old rule said 2120 for this job.
        assertEquals(2120.0, kotlin.math.ceil(2113.01 / 10.0) * 10.0, 0.0)
    }

    @Test
    fun `float dust is cleaned to cents, not stored (1000 plus 1269_32)`() {
        assertTrue("precondition: the double sum really is dust", 1000.0 + 1269.32 != 2269.32)
        assertEquals(2269.32, grand(exactJob(), 1000.0, 1269.32), 0.0)
    }

    @Test
    fun `tax markup and discount still compose and only the final figure is rounded`() {
        // 1000 taxable at 7% = 1070; +12% markup = 1198.4; -5% = 1138.48.
        val totals = EstimateEngine.computeTotals(
            exactJob(tax = 7.0, markup = 12.0, discount = 5.0), listOf(line(1000.0, taxable = true)), 0f
        )
        assertEquals(1138.48, totals.grandTotal, 0.0)
        // The parts are NOT rounded: only the final figure is, so the sum is not rounded twice.
        assertEquals(1000.0 * (7.0 / 100.0), totals.tax, 0.0)
    }

    @Test
    fun `a job at the minimum job charge reads exactly the minimum`() {
        assertEquals(450.0, grand(exactJob(minimum = 450.0), 183.47), 0.0)
        assertEquals(450.0, grand(exactJob(minimum = 450.0), 450.0), 0.0)
        // Nothing on the job at all still reads the minimum, as it always did.
        assertEquals(450.0, EstimateEngine.computeTotals(exactJob(minimum = 450.0), emptyList(), 0f).grandTotal, 0.0)
        // And a job above it is not pulled to it.
        assertEquals(451.23, grand(exactJob(minimum = 450.0), 451.23), 0.0)
    }

    @Test
    fun `a minimum typed with a stray fraction is still a figure on cents`() {
        assertEquals(450.0, grand(exactJob(minimum = 450.004), 10.0), 0.0)
    }

    @Test
    fun `the engine version moved off 2026_09_3`() {
        // Asserts what the name says -- that the version moved PAST the one the
        // round-up-to-ten engine shipped as -- rather than pinning one exact
        // string.
        //
        // It did pin "2026.10.1", and that broke the moment the next formula
        // change landed (height-aware panel choice, 2026.10.2), failing a
        // release for a version bump that was entirely correct. A test that
        // goes red on every legitimate future bump is not a guard, it is a toll.
        //
        // The real guard against a formula change shipping WITHOUT a bump is
        // elsewhere and is stronger: ParityFixtureCheck requires
        // PRICING_ENGINE_VERSION to equal the fixtures' manifest version, so
        // changing the maths without regenerating fails, and regenerating
        // without bumping fails too. This test only has to prove we are off the
        // old one and moving forwards.
        val now = EstimateEngine.PRICING_ENGINE_VERSION
        assertNotEquals("the engine still reports the round-up-to-ten version", "2026.09.3", now)

        // Compared component by component, the way JobSync decides which engine
        // is newer -- "2026.10.2" is NOT greater than "2026.09.3" as a string,
        // because "1" sorts below "9".
        fun parts(v: String) = v.split(".").map { it.toIntOrNull() ?: 0 }
        val old = parts("2026.09.3")
        val cur = parts(now)
        val newer = cur.zip(old).firstOrNull { (a, b) -> a != b }?.let { (a, b) -> a > b } ?: false
        assertTrue(
            "PRICING_ENGINE_VERSION is $now, which is not newer than 2026.09.3. A formula " +
            "change must move the version FORWARD on both engines, or a phone and the office " +
            "will disagree about which of them is out of date.",
            newer
        )
    }

    // ------------------------------------------------------------- deposit

    @Test
    fun `ruleDeposit gives the shared vectors exactly`() {
        for (row in rows("ruleDeposit")) {
            assertEquals(
                "ruleDeposit(${num(row, "outstanding")})",
                num(row, "out"), JobMoney.ruleDeposit(num(row, "outstanding")), 0.0
            )
        }
    }

    @Test
    fun `the rule is rounded up to the next hundred and then a hundred more`() {
        assertEquals(1800.0, JobMoney.ruleDeposit(1630.0), 0.0)
        // An exact hundred stays where it is before the $100 is added.
        assertEquals(1100.0, JobMoney.ruleDeposit(1000.0), 0.0)
        assertEquals(1200.0, JobMoney.ruleDeposit(1000.01), 0.0)
        // Float dust must not push a deposit into the next hundred.
        assertEquals(1100.0, JobMoney.ruleDeposit(1000.0000000000001), 0.0)
        // Planted: a bare ceil on the dusty figure jumps a whole hundred.
        assertEquals(1200.0, kotlin.math.ceil(1000.0000000000001 / 100.0) * 100.0 + 100.0, 0.0)
    }

    @Test
    fun `a deposit is never negative and non-numbers are nothing`() {
        assertEquals(0.0, JobMoney.ruleDeposit(-1.0), 0.0)
        assertEquals(0.0, JobMoney.ruleDeposit(Double.NaN), 0.0)
        assertEquals(0.0, JobMoney.ruleDeposit(Double.POSITIVE_INFINITY), 0.0)
        assertEquals(JobMoney.DepositSuggestion.NONE, JobMoney.depositSuggestion(job(), Double.NaN, 5000.0))
        assertEquals(JobMoney.DepositSuggestion.NONE, JobMoney.depositSuggestion(job(), 1000.0, Double.NaN))
    }

    @Test
    fun `depositSuggestion gives the shared vectors exactly`() {
        for (row in rows("suggestedDeposit")) {
            val name = row.getValue("name").jsonPrimitive.content
            val got = JobMoney.depositSuggestion(
                job(paid = num(row, "amountPaid"), refunded = num(row, "refundedAmount")),
                num(row, "materialCost"), num(row, "billableTotal")
            )
            assertEquals("$name: amount", num(row, "amount"), got.amount, 0.0)
            assertEquals("$name: capped", row.getValue("capped").jsonPrimitive.boolean, got.capped)
        }
    }

    @Test
    fun `suggestedMaterialsDeposit is the suggestion's amount`() {
        assertEquals(1800.0, JobMoney.suggestedMaterialsDeposit(job(), 1630.0, 6200.0), 0.0)
        // Woody: capped at the accepted price.
        assertEquals(3620.0, JobMoney.suggestedMaterialsDeposit(job(), 3963.44, 3620.0), 0.0)
    }

    @Test
    fun `on a small job the customer is asked for the whole job, never more`() {
        // 120 of materials rules to 300, which is more than the 150 job.
        val s = JobMoney.depositSuggestion(job(), 120.0, 150.0)
        assertEquals(150.0, s.amount, 0.0)
        assertTrue(s.capped)
        assertEquals(300.0, JobMoney.ruleDeposit(120.0), 0.0)
    }

    // ---------------------------------------------- the seeding decision

    @Test
    fun `a fresh job with materials and no deposit is offered the rule's figure`() {
        assertEquals(1800.0, JobMoney.depositToSeed(job(), 1630.0, 6200.0)!!, 0.0)
    }

    @Test
    fun `a deposit already on the job is never overwritten`() {
        // The old auto-fill overwrote one: a deposit moved from 9,910 to 5,730
        // ten seconds after the customer signed.
        assertNull(JobMoney.depositToSeed(job(deposit = 500.0), 1630.0, 6200.0))
    }

    @Test
    fun `nothing is seeded once the customer is in it`() {
        assertNull("signed", JobMoney.depositToSeed(job(signedAt = 1_000L), 1630.0, 6200.0))
        assertNull("approved online", JobMoney.depositToSeed(job(approvedAt = 1_000L), 1630.0, 6200.0))
        assertNull("money has landed", JobMoney.depositToSeed(job(paid = 100.0), 1630.0, 6200.0))
        assertTrue(JobMoney.customerIsInIt(job(signedAt = 1_000L)))
        assertTrue(JobMoney.customerIsInIt(job(paid = 100.0)))
        assertFalse(JobMoney.customerIsInIt(job()))
    }

    @Test
    fun `a withdrawn approval puts the job back in play`() {
        // The database's deposit_follows_price follows again when a drawing
        // change withdraws the approval; the phone agrees.
        assertEquals(
            1800.0,
            JobMoney.depositToSeed(job(signedAt = 1_000L, reapproval = 2_000L), 1630.0, 6200.0)!!, 0.0
        )
        assertFalse(JobMoney.customerIsInIt(job(signedAt = 1_000L, reapproval = 2_000L)))
    }

    @Test
    fun `no materials or no price means nothing to seed`() {
        assertNull(JobMoney.depositToSeed(job(), 0.0, 6200.0))
        assertNull(JobMoney.depositToSeed(job(), 1630.0, 0.0))
    }

    // ------------------------------------- the reported bug, reproduced

    private fun totalsOf(materials: Double, grand: Double) = EstimateEngine.Totals(
        materialsSubtotal = materials, taxableSubtotal = materials, tax = 0.0, laborCost = 0.0,
        teardownCost = 0.0, markupAmount = 0.0, discountAmount = 0.0, grandTotal = grand,
    )

    @Test
    fun `REPRODUCTION - a new job with substantial materials stores a deposit of zero and the estimate says so`() {
        // "after I do the run the deposit is not accurate on the estimate, it
        // showed zero for the new job that I just created but the materials are
        // a lot more."
        val fresh = job()
        // 1. Never stored: a new job's deposit is the column's default, and the
        //    only things that write it are a typed value and the one-tap button.
        assertEquals(0.0, fresh.depositAmount, 0.0)
        // 2. The suggestion IS computed -- the figure the job screen's button
        //    offers -- so "not being computed" is not the cause.
        assertEquals(1800.0, JobMoney.suggestedMaterialsDeposit(fresh, 1630.0, 6200.0), 0.0)
        // 3. The estimate screen reads the STORED deposit, so its warning
        //    carries $0.00 against the materials.
        val found = EstimateEngine.estimateWarnings(fresh, emptyList(), emptyList(), totalsOf(1630.0, 6200.0))
        val short = found.first { it.textRes == R.string.warn_deposit_short }
        assertEquals(listOf("0.00", "1630.00"), short.args)
    }
}
