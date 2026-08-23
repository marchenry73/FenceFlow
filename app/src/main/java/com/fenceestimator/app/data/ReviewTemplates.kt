package com.fenceestimator.app.data

/**
 * Ways of asking for a review, because one wording does not fit every job.
 *
 * A single generic message is what people stop sending. Asking the customer
 * whose gate you went back to fix reads badly in the same words you would use
 * on a job that went perfectly, and the job that went perfectly is the one
 * worth asking properly.
 *
 * These are starting points. Every one is editable, and the wording a
 * contractor uses is theirs -- it goes out under their name, not the app's.
 *
 * The picker wording for each template (its label and description) lives in
 * string resources -- see `ReviewTemplate.label()` / `describes()` in
 * EnumLabels -- so only the editable message body is carried here.
 */
enum class ReviewTemplate(val body: String) {

    STRAIGHTFORWARD(
        body = "Hi {customerName}, thanks again for choosing {businessName}. " +
            "We're really pleased with how the fence turned out. " +
            "If you have a minute, a short review would genuinely help us -- " +
            "it's how most of our work comes in.\n\n{reviewLink}"
    ),

    /**
     * The one people forget to send. A customer who has just been apologised to
     * is the last person you feel like asking -- and the most likely to write
     * something warm, because being looked after after a problem is the part
     * people actually tell others about.
     */
    AFTER_A_PROBLEM(
        body = "Hi {customerName}, thanks for bearing with us on this one. " +
            "We'd rather sort something out properly than leave it, and I'm glad " +
            "we got there. If you felt looked after, a short review would mean a " +
            "lot -- and it's fair to mention the hiccup, we'd rather people saw " +
            "how we handle things.\n\n{reviewLink}"
    ),

    REPEAT_CUSTOMER(
        body = "Hi {customerName}, always good to work with you again. " +
            "If you've got a spare minute, a review from someone who's used us " +
            "more than once carries a lot of weight with people deciding.\n\n{reviewLink}"
    ),

    BIG_JOB(
        body = "Hi {customerName}, thanks for trusting us with this one -- it was a " +
            "good project to be part of. If you write a review, mentioning what the " +
            "job involved helps more than anything: people looking for something " +
            "similar want to know it's been done before.\n\n{reviewLink}"
    ),

    QUIET_NUDGE(
        body = "Hi {customerName}, hope the fence is still looking good. " +
            "No pressure at all -- but if you get a moment for a quick review, " +
            "we'd really appreciate it.\n\n{reviewLink}"
    );

    companion object {
        /**
         * Which one to offer first, from what the app already knows.
         *
         * A suggestion, never a decision -- the person sending it knows things
         * the job record does not. But defaulting to the right one is what makes
         * the difference between picking a template and sending the generic one
         * because choosing was work.
         */
        fun suggestFor(job: Job, isRepeatCustomer: Boolean): ReviewTemplate = when {
            job.blockedReason.isNotBlank() || job.overrunReason.isNotBlank() -> AFTER_A_PROBLEM
            isRepeatCustomer -> REPEAT_CUSTOMER
            // Net of refunds: a large job that was mostly refunded is not the
            // one to ask for a glowing review about.
            com.fenceestimator.app.estimate.JobMoney.netPaid(job) >= LARGE_JOB_THRESHOLD -> BIG_JOB
            else -> STRAIGHTFORWARD
        }

        /** Above this, a job is worth asking about in detail rather than in passing. */
        private const val LARGE_JOB_THRESHOLD = 6_000.0
    }
}
