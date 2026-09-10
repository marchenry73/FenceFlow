package com.fenceestimator.app.estimate

/**
 * Where a SOLD job sits between approval and invoice, in the owner's own
 * words: "Materials, dig, set, build, punch, done."
 *
 * Pure ordering only -- moving a job is [set_production_stage] on the server,
 * the one door onto `jobs.production_stage`. This object exists so the crew
 * screen can offer exactly one obvious forward step and a smaller, separate
 * way back, instead of a picker of six stages a gloved thumb could land on
 * wrong.
 */
object ProductionStage {

    /** Server-side stage names, in pipeline order. */
    val ORDER: List<String> = listOf("MATERIALS", "DIG", "SET", "BUILD", "PUNCH", "DONE")

    /**
     * The stage one tap forward would move to.
     *
     * Null [current] (a job not yet started) advances to the first stage.
     * Null result means there is nowhere further to go -- DONE is DONE, and
     * an unrecognized stage name is treated the same way rather than
     * guessing where the crew meant to land.
     */
    fun next(current: String?): String? {
        if (current == null) return ORDER.first()
        val i = ORDER.indexOf(current)
        return if (i < 0 || i == ORDER.lastIndex) null else ORDER[i + 1]
    }

    /**
     * The stage one tap back would move to.
     *
     * Null at or before MATERIALS: there is no RPC destination earlier than
     * the first stage, so back is simply unavailable there, the same as
     * forward is unavailable past DONE.
     */
    fun previous(current: String?): String? {
        if (current == null) return null
        val i = ORDER.indexOf(current)
        return if (i <= 0) null else ORDER[i - 1]
    }
}
