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
    const val REPORTS = "reports"
    const val PIPELINE = "pipeline"
    const val HELP = "help"
    const val FEEDBACK = "feedback"
    const val JOB_DETAIL = "job/{jobId}"
    const val SURVEY = "job/{jobId}/survey"
    const val ESTIMATE = "job/{jobId}/estimate"
    const val INVENTORY = "job/{jobId}/inventory"
    const val RUN_EDIT = "run/{runId}"
    const val CREW_JOB = "job/{jobId}/crew"

    /** Read-only plan for the crew. Deliberately not the editable survey screen. */
    const val CREW_PLAN = "job/{jobId}/crew/plan"

    fun jobDetail(jobId: Long) = "job/$jobId"
    fun survey(jobId: Long) = "job/$jobId/survey"
    fun estimate(jobId: Long) = "job/$jobId/estimate"
    fun inventory(jobId: Long) = "job/$jobId/inventory"
    fun runEdit(runId: Long) = "run/$runId"
    fun crewJob(jobId: Long) = "job/$jobId/crew"
    fun crewPlan(jobId: Long) = "job/$jobId/crew/plan"
}
