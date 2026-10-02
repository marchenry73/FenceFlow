package com.fenceestimator.app.ui.nav

object Routes {
    const val JOBS = "jobs"
    const val CATALOG = "catalog"
    const val CATALOG_IMPORT = "catalog/import"
    const val SETTINGS = "settings"
    const val MANUFACTURERS = "manufacturers"
    const val EMPLOYEES = "employees"
    const val CUSTOMERS = "customers"
    const val SCHEDULE = "schedule"
    const val ACCOUNT = "account"
    const val ACCESS = "access"
    const val TRASH = "trash"
    const val SUPPLIER_PRICES = "supplier_prices/{jobId}"
    fun supplierPrices(jobId: Long) = "supplier_prices/$jobId"
    const val TIME_APPROVAL = "time_approval"
    const val REPORTS = "reports"
    const val PIPELINE = "pipeline"
    const val HELP = "help"
    const val FEEDBACK = "feedback"

    /** A scoped crew member asking to see a job they are not on. */
    const val REQUEST_ACCESS = "request_access"

    /** The crew's waiting access requests, for whoever answers them. */
    const val ACCESS_REQUESTS = "access_requests"
    const val JOB_DETAIL = "job/{jobId}"
    /**
     * The drawing screen, optionally opened on a particular fence run.
     *
     * `runId` is an OPTIONAL query parameter, not a second path segment, and
     * that is the whole point of the shape. "job/7/survey" still matches this
     * pattern exactly as it always did, so the caller that has only a job id
     * (JobDetailScreen's Survey button) needs no change and keeps the old
     * "first run" behaviour. "job/7/survey?runId=12" additionally says which
     * side to open on -- which is what RunEditScreen's "Next: Draw This
     * Fence" could not say before, so it opened the drawing on the job's
     * first run and quietly appended the user's corners to the wrong side.
     *
     * The argument is declared with `defaultValue = 0L` in MainActivity: a
     * NavType.LongType query parameter with no default makes the parameter
     * REQUIRED, which would stop the job-only route from matching at all.
     * Zero means "not asked", and SurveyViewModel.requestRun treats anything
     * <= 0 as no request (a Room id is always >= 1).
     */
    const val SURVEY = "job/{jobId}/survey?runId={runId}"
    const val ESTIMATE = "job/{jobId}/estimate"
    const val INVENTORY = "job/{jobId}/inventory"
    const val RUN_EDIT = "run/{runId}"
    const val CREW_JOB = "job/{jobId}/crew"

    /** Read-only plan for the crew. Deliberately not the editable survey screen. */
    const val CREW_PLAN = "job/{jobId}/crew/plan"

    /**
     * The pull sheet: what goes on the truck for this job, checked off at the
     * supply counter. Quantities, types and sizes only, no money anywhere
     * ([com.fenceestimator.app.ui.crew.PullSheetScreen]).
     *
     * Under the job rather than under `crew`, because it is not a crew-only
     * page: the owner works alone or with a small crew and is usually the
     * person standing at the counter, and there is only ONE version of this
     * page because there is nothing on it to withhold from anybody.
     *
     * NOT YET REGISTERED. Nothing navigates here until the composable is added
     * to MainActivity, which another wave holds today.
     */
    const val PULL_SHEET = "job/{jobId}/pull-sheet"

    fun jobDetail(jobId: Long) = "job/$jobId"
    /**
     * [SURVEY] for [jobId], opened on [runId] when one is given.
     *
     * The query parameter is omitted entirely rather than sent as 0 when
     * there is no run to ask for, so the URL a job-only caller produces is
     * byte-for-byte what it was before this parameter existed -- which is
     * what keeps popBackStack / launchSingleTop comparisons and anything
     * matching on the route string behaving the same.
     */
    fun survey(jobId: Long, runId: Long? = null): String {
        val base = "job/$jobId/survey"
        return if (runId != null && runId > 0L) "$base?runId=$runId" else base
    }
    fun estimate(jobId: Long) = "job/$jobId/estimate"
    fun inventory(jobId: Long) = "job/$jobId/inventory"
    fun runEdit(runId: Long) = "run/$runId"
    fun crewJob(jobId: Long) = "job/$jobId/crew"
    fun crewPlan(jobId: Long) = "job/$jobId/crew/plan"
    fun pullSheet(jobId: Long) = "job/$jobId/pull-sheet"
}
