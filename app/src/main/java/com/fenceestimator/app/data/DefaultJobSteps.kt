package com.fenceestimator.app.data

import androidx.annotation.StringRes
import com.fenceestimator.app.R

/**
 * The standard on-site checklists, copied onto each job the first time its
 * crew view is opened. Having the walkthrough items confirmed with the
 * customer *before* digging starts is what prevents the "that's not what I
 * agreed to" argument after the fence is in the ground.
 *
 * Each entry carries a stable [Step.key] alongside its English [Step.text].
 * The key is what lets a step the app recognises be shown translated (see
 * [JobStepKind] usage in Repository.ensureJobStepsSeeded, which copies both
 * onto the [JobStep] row) -- the text is what a live job actually stores and
 * is never replaced afterward. A step typed by hand on a job has no entry
 * here and so gets no key, which is exactly right: there is nothing to
 * translate it against.
 */
object DefaultJobSteps {

    data class Step(val key: String, val text: String, @StringRes val res: Int)

    val WALKTHROUGH = listOf(
        Step("wt_walk_fence_line", "Walk the fence line with the customer and agree on where it runs", R.string.step_wt_walk_fence_line),
        Step("wt_gate_locations", "Confirm gate locations, widths, and which way they swing", R.string.step_wt_gate_locations),
        Step("wt_height_style_color", "Confirm fence height, style, and color", R.string.step_wt_height_style_color),
        Step("wt_mark_utilities", "Point out and mark sprinklers, septic, and utility lines", R.string.step_wt_mark_utilities),
        Step("wt_old_fence_debris", "Agree on where old fence and debris will go", R.string.step_wt_old_fence_debris),
        Step("wt_access_route", "Confirm access route for equipment and material drop", R.string.step_wt_access_route),
        Step("wt_trees_slopes_obstacles", "Note any trees, slopes, or obstacles that change the plan", R.string.step_wt_trees_slopes_obstacles),
        // Standing rule, on the checklist so it gets read aloud on every job.
        // A crew clearing a bush or a planter to make their day easier is how
        // you end up paying for something you never quoted.
        Step(
            "wt_debris_clearing_rule",
            "Tell the customer: we clear leaves and loose debris only. Anything " +
                "needing a tool -- bushes, planters, sheds, tree limbs, old posts -- " +
                "they clear before we start, or it goes on a change order",
            R.string.step_wt_debris_clearing_rule
        ),
        Step("wt_customer_must_move", "List anything on the fence line the customer must move themselves", R.string.step_wt_customer_must_move)
        // Deliberately no pricing here. This list is read out on site by the
        // crew with the customer standing next to them, and neither of them is
        // the person who should be discussing the money.
    )

    val INSTALL = listOf(
        Step("in_verify_property_line", "Verify property line before digging", R.string.step_in_verify_property_line),
        Step("in_confirm_utility_locates", "Call in / confirm utility locates are clear", R.string.step_in_confirm_utility_locates),
        Step("in_dig_post_holes", "Dig post holes", R.string.step_in_dig_post_holes),
        Step("in_set_posts_concrete", "Set posts and concrete", R.string.step_in_set_posts_concrete),
        Step("in_let_concrete_set", "Let concrete set", R.string.step_in_let_concrete_set),
        Step("in_install_rails_panels", "Install rails and panels", R.string.step_in_install_rails_panels),
        Step("in_hang_gates_hardware", "Hang gates and hardware", R.string.step_in_hang_gates_hardware),
        Step("in_clean_up_haul_debris", "Clean up property and haul debris", R.string.step_in_clean_up_haul_debris),
        Step("in_take_after_photos", "Take after photos", R.string.step_in_take_after_photos)
    )

    /**
     * The closing walkthrough, done with the customer before the crew leaves.
     *
     * Separate from the install list because it ends in a signature: this is
     * the moment the customer says the work is right, and it is the record that
     * settles a complaint three months later.
     */
    val FINAL = listOf(
        Step("fw_walk_finished_fence", "Walk the finished fence line with the customer", R.string.step_fw_walk_finished_fence),
        Step("fw_check_gates", "Check every gate opens, closes and latches", R.string.step_fw_check_gates),
        Step("fw_height_style_color", "Confirm height, style and colour match what was agreed", R.string.step_fw_height_style_color),
        Step("fw_posts_plumb", "Check posts are plumb and the line is straight", R.string.step_fw_posts_plumb),
        Step("fw_site_clean", "Confirm the site is clean and all debris is gone", R.string.step_fw_site_clean),
        Step("fw_point_out_corrections", "Point out anything the customer wants corrected", R.string.step_fw_point_out_corrections),
        Step("fw_ask_for_review", "Ask the customer for a review", R.string.step_fw_ask_for_review)
    )

    /** Every shipped step across all three lists, keyed by [Step.key], for resolving a [JobStep.stepKey]. */
    val BY_KEY: Map<String, Step> = (WALKTHROUGH + INSTALL + FINAL).associateBy { it.key }
}
