package com.fenceestimator.app.data

/**
 * The standard on-site checklists, copied onto each job the first time its
 * crew view is opened. Having the walkthrough items confirmed with the
 * customer *before* digging starts is what prevents the "that's not what I
 * agreed to" argument after the fence is in the ground.
 */
object DefaultJobSteps {
    val WALKTHROUGH = listOf(
        "Walk the fence line with the customer and agree on where it runs",
        "Confirm gate locations, widths, and which way they swing",
        "Confirm fence height, style, and color",
        "Point out and mark sprinklers, septic, and utility lines",
        "Agree on where old fence and debris will go",
        "Confirm access route for equipment and material drop",
        "Note any trees, slopes, or obstacles that change the plan",
        // Standing rule, on the checklist so it gets read aloud on every job.
        // A crew clearing a bush or a planter to make their day easier is how
        // you end up paying for something you never quoted.
        "Tell the customer: we clear leaves and loose debris only. Anything " +
            "needing a tool -- bushes, planters, sheds, tree limbs, old posts -- " +
            "they clear before we start, or it goes on a change order",
        "List anything on the fence line the customer must move themselves",
        "Review price, deposit, and payment terms"
    )

    val INSTALL = listOf(
        "Verify property line before digging",
        "Call in / confirm utility locates are clear",
        "Dig post holes",
        "Set posts and concrete",
        "Let concrete set",
        "Install rails and panels",
        "Hang gates and hardware",
        "Clean up property and haul debris",
        "Take after photos",
        "Final walkthrough with customer",
        "Ask the customer for a review"
    )
}
