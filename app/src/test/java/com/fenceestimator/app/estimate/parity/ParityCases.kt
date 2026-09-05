package com.fenceestimator.app.estimate.parity

import com.fenceestimator.app.data.AluminumStyle
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.MaterialCategory
import com.fenceestimator.app.data.MaterialItem
import com.fenceestimator.app.data.MaterialRole
import com.fenceestimator.app.data.SeedData
import com.fenceestimator.app.data.WoodStyle
import com.fenceestimator.app.estimate.EstimateEngine
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.geometry.GateMarker
import com.fenceestimator.app.geometry.GateMounting
import com.fenceestimator.app.geometry.GateSwing
import com.fenceestimator.app.ui.runs.FenceRunListViewModel
import com.fenceestimator.app.ui.survey.SurveyViewModel
import java.util.Locale
import java.util.UUID

/** One golden case: an invented job, and the reason it is in the set. */
class ParityCase(val id: String, val note: String, val input: PricingInput)

/**
 * The parity fixture set, as code.
 *
 * Every case is invented -- no customer, no address, no real job. Sync ids
 * are fixed per case (case number in the first group, slot in the last) so a
 * tie broken on sync id breaks the same way on every regenerate and on the
 * server. Catalog rows come from the shipped SeedData with a content-derived
 * sync id, so a template-started run prices off the same catalog the phone
 * seeds; a case that needs more adds rows of its own.
 *
 * The seeded catalog is trimmed to the fence types the case uses (plus
 * UNIVERSAL). The engine only ever matches within the run's type, so the
 * trim changes nothing and keeps each fixture readable.
 */
object ParityCases {

    fun all(): List<ParityCase> {
        val cases = geometryCases() + fenceTypeCases() + gateCases() + catalogCases() +
            carryOverCases() + totalsCases() + templateCases()
        require(cases.map { it.id }.distinct().size == cases.size) { "duplicate case id" }
        return cases
    }

    /* ---------------- geometry and footage ---------------- */

    private fun geometryCases() = listOf(
        case(1, "vinyl-typed-open") {
            note = "Typed footage, open run: 17 bays -> 16 line posts + 2 ends, 17 panels, 18 bags."
            run(FenceType.VINYL, feet = 100.0)
        },
        case(2, "vinyl-typed-closed") {
            note = "Typed footage, closed loop with 4 typed corners: no end posts and no closing post."
            run(FenceType.VINYL, feet = 120.0, corners = 4, closed = true)
        },
        case(3, "vinyl-drawn-open") {
            note = "Drawn L at 20 px/ft: 100 ft + 75 ft, one 90-degree corner, two ends."
            run(FenceType.VINYL, points = pts(0 to 0, 2000 to 0, 2000 to 1500))
        },
        case(4, "vinyl-drawn-closed") {
            note = "Drawn square, closed loop: four corners, no ends, the wrap segment counted."
            run(FenceType.VINYL, points = square(1600), closed = true)
        },
        case(5, "drawn-uncalibrated") {
            note = "No calibration on the job: the takeoff measures at the grid's 20 px/ft (materials appear), " +
                "but linear_feet is 0 so labour bills nothing. The phone's own asymmetry, reproduced."
            job = job.copy(calibrationPixelsPerFoot = null)
            run(FenceType.VINYL, points = pts(0 to 0, 2000 to 0))
        },
        case(6, "drawn-odd-calibration") {
            note = "Calibration 13.7 (not a float-exact decimal) and non-integer points: pins float division and sqrt."
            job = job.copy(calibrationPixelsPerFoot = 13.7.f32())
            run(FenceType.VINYL, points = pts(0 to 0, 1234.5 to 678.9, 2500 to 100))
        },
        case(7, "corner-14-9-degrees") {
            note = "A 14.9-degree bend (atan(532/2000)) is a LINE vertex: no corner post."
            run(FenceType.VINYL, points = pts(0 to 0, 2000 to 0, 4000 to 532))
        },
        case(8, "corner-15-1-degrees") {
            note = "A 15.1-degree bend (atan(540/2000)) is a CORNER: one corner post comes out of the line posts."
            run(FenceType.VINYL, points = pts(0 to 0, 2000 to 0, 4000 to 540))
        },
        case(9, "points-malformed-pairs") {
            note = "Malformed pairs are dropped, not fatal: only 0:0 and 4000:0 survive, a 200 ft straight run."
            run(FenceType.VINYL, points = "0.0:0.0,abc,2000.0:0.0:5,xx:yy,,4000.0:0.0")
        },
        case(10, "manual-feet-beats-drawing") {
            note = "Typed footage wins outright over a drawing; corners come from manual_corner_count."
            run(FenceType.VINYL, feet = 80.0, corners = 2, points = pts(0 to 0, 2000 to 0, 2000 to 2000))
        },
        case(11, "manual-feet-zero-uses-drawing") {
            note = "manual_linear_feet = 0 is 'not typed': the drawing is measured."
            run(FenceType.VINYL, feet = 0.0, points = pts(0 to 0, 2000 to 0))
        },
        case(12, "multi-run-mixed-types") {
            note = "Three runs of three types on one job: items concatenated in run order, sort_order restarting per run, " +
                "totals summed in (sort_order, sync_id) order across runs."
            run(FenceType.VINYL, feet = 100.0, gates = gates(gate(500, 0, 4.0)))
            run(FenceType.WOOD, points = pts(0 to 0, 1200 to 0, 1200 to 900), gates = gates(gate(300, 0, 4.0)))
            run(FenceType.CHAIN_LINK, feet = 60.0, corners = 1, gates = gates(gate(100, 0, 3.0, GateMounting.WALL)))
        }
    )

    /* ---------------- every fence type, typed and drawn ---------------- */

    private fun fenceTypeCases() = listOf(
        case(13, "wood-privacy-typed-open") {
            note = "Wood privacy 6 ft: pickets at 5.5 in pitch, 3 rails per bay, spacing 8, one line gate (frame kit)."
            run(FenceType.WOOD, feet = 100.0, corners = 1, gates = gates(gate(500, 0, 4.0)))
        },
        case(14, "wood-spaced-picket-drawn-closed") {
            note = "Wood spaced picket 4 ft, 2.5 in gap (pitch 8), drawn closed square."
            run(
                FenceType.WOOD, points = square(1600), closed = true, panelHeight = 4.0,
                woodStyle = WoodStyle.SPACED_PICKET, picketGap = 2.5
            )
        },
        case(15, "chain-link-typed-all-options") {
            note = "Chain link 6 ft fabric with top rail, tension wire, barbed arms and slats; " +
                "bands per terminal post = ceil(fabric height)."
            run(
                FenceType.CHAIN_LINK, feet = 150.0, corners = 2, panelHeight = 6.0, fabricHeight = 6.0,
                tensionWire = true, barbedArms = true, privacySlats = true, gates = gates(gate(500, 0, 4.0))
            )
        },
        case(16, "chain-link-drawn-no-top-rail") {
            note = "Chain link 4 ft without a top rail: no TOP_RAIL and no RAIL_END entries."
            run(FenceType.CHAIN_LINK, points = pts(0 to 0, 2000 to 0, 2000 to 1000), topRail = false)
        },
        case(17, "chain-link-fabric-5-nearest-height") {
            note = "Fabric height 5 sits exactly between the 4 ft and 6 ft rolls: equal distance, the cheaper wins."
            run(FenceType.CHAIN_LINK, feet = 100.0, panelHeight = 5.0, fabricHeight = 5.0)
        },
        case(18, "aluminum-typed-open") {
            note = "Aluminum pool fence 6x4 rackable, black, one 4 ft line gate."
            run(
                FenceType.ALUMINUM, feet = 100.0, panelHeight = 4.0, colour = "Black",
                gates = gates(gate(500, 0, 4.0))
            )
        },
        case(19, "aluminum-drawn-closed") {
            note = "Aluminum in White: the panel and line post narrow to the White rows, the rest fall back to all."
            run(FenceType.ALUMINUM, points = square(1200), closed = true, colour = "White")
        },
        case(20, "ornamental-iron-typed-closed") {
            note = "Ornamental iron spec'd at 8 ft panels: the 4'H x 8'W row is nearest by width, height is not matched."
            run(
                FenceType.ORNAMENTAL_IRON, feet = 200.0, corners = 4, closed = true,
                panelWidth = 8.0, panelHeight = 4.0
            )
        },
        case(21, "ornamental-iron-drawn-open-wall-gate") {
            note = "Ornamental iron with a wall-hung 5 ft gate: BLANK_POST has no catalog row (unmatched), hole plugs are universal."
            run(
                FenceType.ORNAMENTAL_IRON, points = pts(0 to 0, 2400 to 0),
                gates = gates(gate(600, 0, 5.0, GateMounting.WALL))
            )
        },
        case(22, "split-rail-typed-open") {
            note = "Split rail, 2 rails per bay at 8 ft spacing, one corner; no post caps for split rail."
            run(FenceType.SPLIT_RAIL, feet = 160.0, corners = 1)
        },
        case(23, "split-rail-drawn-3-rail-wide-gate") {
            note = "Split rail, 3 rails, drawn, one 10 ft line gate: frame kit 10 ft, second brace and hinge set."
            run(
                FenceType.SPLIT_RAIL, points = pts(0 to 0, 3200 to 0, 3200 to 1600), splitRails = 3,
                gates = gates(gate(800, 0, 10.0))
            )
        },
        case(24, "composite-typed-open") {
            note = "Composite privacy 6 ft, spacing 8, 3 rails."
            run(FenceType.COMPOSITE, feet = 100.0)
        },
        case(25, "composite-drawn-closed-gate") {
            note = "Composite, drawn closed, one 4 ft line gate (frame kit)."
            run(FenceType.COMPOSITE, points = square(1400), closed = true, gates = gates(gate(700, 0, 4.0)))
        },
        case(26, "universal-typed-with-gate") {
            note = "A UNIVERSAL run takes off nothing type-specific: concrete for its posts, the gate's hardware, " +
                "and only UNIVERSAL catalog rows can match, so most roles are unmatched."
            run(FenceType.UNIVERSAL, feet = 50.0, gates = gates(gate(500, 0, 4.0)))
        },
        case(75, "chain-link-drawn-closed") {
            note = "Chain link around a drawn closed square: four corners are terminal posts, no ends; bands and rail ends follow."
            run(FenceType.CHAIN_LINK, points = square(1000), closed = true)
        },
        case(76, "split-rail-typed-closed") {
            note = "Split rail, typed closed loop with 3 corners: bays with no closing post, no end posts."
            run(FenceType.SPLIT_RAIL, feet = 96.0, corners = 3, closed = true)
        },
        case(77, "universal-drawn-closed") {
            note = "A UNIVERSAL closed loop with no gate: bays give concrete and nothing else."
            run(FenceType.UNIVERSAL, points = square(600), closed = true)
        }
    )

    /* ---------------- gates ---------------- */

    private fun gateCases() = listOf(
        case(27, "gate-wall-mount") {
            note = "Wall-hung: blank post + end post + 4 hole plugs, one bag (latch side only)."
            run(FenceType.VINYL, feet = 100.0, colour = "White", gates = gates(gate(500, 0, 4.0, GateMounting.WALL)))
        },
        case(28, "gate-line-mount") {
            note = "In the line: two end posts, 1.5 + 1.0 bags."
            run(FenceType.VINYL, feet = 100.0, colour = "White", gates = gates(gate(500, 0, 4.0, GateMounting.LINE)))
        },
        case(29, "gate-line-to-wall-mount") {
            note = "Line to wall: three end posts and 3.5 bags, while gatePosts stays 2 -- the cap undercount, reproduced."
            run(FenceType.VINYL, feet = 100.0, colour = "White", gates = gates(gate(500, 0, 4.0, GateMounting.LINE_TO_WALL)))
        },
        case(30, "gate-7-99-ft") {
            note = "7.99 ft is under the wide-gate threshold: one brace, one hinge set."
            run(FenceType.VINYL, feet = 100.0, gates = gates(gate(500, 0, 7.99)))
        },
        case(31, "gate-8-0-ft") {
            note = "8.0 ft is a wide gate: second brace and second hinge set."
            run(FenceType.VINYL, feet = 100.0, gates = gates(gate(500, 0, 8.0)))
        },
        case(32, "gates-five-widths") {
            note = "Gates of 3.5, 4.0, 5.0, 10.0 and 12.0 ft on one run: five GATE_PANEL lines whose sync ids carry " +
                "the width as Kotlin Float.toString renders it (3.5, 4.0, 10.0 ...)."
            run(
                FenceType.VINYL, feet = 200.0,
                gates = gates(
                    gate(200, 0, 3.5), gate(600, 0, 4.0), gate(1000, 0, 5.0),
                    gate(1800, 0, 10.0), gate(2600, 0, 12.0)
                )
            )
        },
        case(33, "gates-two-same-width") {
            note = "Two 4 ft gates merge into one GATE_PANEL line of 2 with the unqualified sync id."
            run(FenceType.VINYL, feet = 100.0, gates = gates(gate(400, 0, 4.0), gate(1200, 0, 4.0)))
        },
        case(34, "gates-two-different-widths") {
            note = "A 4 ft and a 6 ft gate stay two GATE_PANEL lines, each id qualified by width."
            run(FenceType.VINYL, feet = 100.0, gates = gates(gate(400, 0, 4.0), gate(1200, 0, 6.0)))
        },
        case(35, "vinyl-gate-trim-with-waste") {
            note = "A vinyl gate takes 4 trim channels; at 10% waste that is ceil(4.4) = 5, panels ceil(17 * 1.1) = 19, " +
                "concrete padded then rounded once."
            job = job.copy(wastePercent = 10.0)
            run(FenceType.VINYL, feet = 100.0, gates = gates(gate(500, 0, 4.0)))
        },
        case(36, "gate-only-run") {
            note = "No points, one gate: 0 ft of fence, the gate's posts, stiffener and 3 bags still come through; " +
                "labour feet clamp to zero, the gate charge stands."
            run(FenceType.VINYL, gates = gates(gate(500, 0, 4.0)))
        },
        case(37, "gate-legacy-3-part") {
            note = "The three-part encoding (x:y:width) reads as LINE / IN."
            run(FenceType.VINYL, feet = 100.0, gates = "500.0:0.0:4.0")
        },
        case(38, "gate-legacy-4-part-wall") {
            note = "The four-part encoding (x:y:width:mounting) keeps its mounting and reads swing as IN."
            run(FenceType.VINYL, feet = 100.0, gates = "500.0:0.0:4.0:WALL")
        },
        case(39, "gate-malformed-entries") {
            note = "Two-part and non-numeric gates are dropped; an unknown mounting falls back to LINE and an " +
                "unknown swing to IN; the good one after them still counts."
            run(FenceType.VINYL, feet = 100.0, gates = "500:0,abc:0:4,500:0:4:SIDEWAYS:UP,600:0:5:LINE_TO_WALL:OUT")
        },
        case(40, "multi-gate-whole-bags") {
            note = "1.25 bags per post and three mountings: 16.25 + 2.5 + 1.0 + 3.5 = 23.25 bags, rounded up once to 24."
            run(
                FenceType.VINYL, feet = 100.0, bags = 1.25,
                gates = gates(
                    gate(300, 0, 4.0, GateMounting.LINE), gate(900, 0, 4.0, GateMounting.WALL),
                    gate(1500, 0, 5.0, GateMounting.LINE_TO_WALL)
                )
            )
        }
    )

    /* ---------------- catalog matching ---------------- */

    private fun catalogCases() = listOf(
        case(41, "waste-12-5-percent-wood") {
            note = "12.5% waste on wood: pickets and rails ceil'd per entry, posts and caps untouched."
            job = job.copy(wastePercent = 12.5)
            run(FenceType.WOOD, feet = 100.0, corners = 1)
        },
        case(42, "colour-narrowing-tan-lowercase") {
            note = "Colour 'tan' matches the Tan rows case-insensitively; roles with no Tan row fall back to every row."
            run(FenceType.VINYL, feet = 100.0, colour = "tan")
        },
        case(43, "colour-unknown-falls-back") {
            note = "A colour nothing carries narrows nothing."
            run(FenceType.VINYL, feet = 100.0, colour = "Purple")
        },
        case(44, "manufacturer-narrowing") {
            note = "The preferred manufacturer's dearer post beats the cheaper generic one."
            manufacturer(1, "Acme Vinyl")
            manufacturer(2, "Other Co")
            job = job.copy(preferredManufacturerSyncId = uuid(1))
            item(3, MaterialRole.LINE_POST, FenceType.VINYL, "Acme 5x5 Line Post", 18.0, MaterialCategory.POST, colour = "White", manufacturer = uuid(1))
            item(4, MaterialRole.LINE_POST, FenceType.VINYL, "Other Co Line Post", 15.5, MaterialCategory.POST, colour = "White", manufacturer = uuid(2))
            run(FenceType.VINYL, feet = 100.0, colour = "White")
        },
        case(45, "manufacturer-unknown-sync-id") {
            note = "A preferred manufacturer the input does not list resolves to none: cheapest priced wins."
            manufacturer(1, "Acme Vinyl")
            job = job.copy(preferredManufacturerSyncId = uuid(9))
            item(3, MaterialRole.LINE_POST, FenceType.VINYL, "Acme 5x5 Line Post", 18.0, MaterialCategory.POST, colour = "White", manufacturer = uuid(1))
            run(FenceType.VINYL, feet = 100.0, colour = "White")
        },
        case(46, "price-tie-by-sync-id") {
            note = "Two identical panels, the lower sync id listed second: sync id decides, list position does not."
            useSeed = false
            item(2, MaterialRole.PANEL, FenceType.VINYL, "Panel B", 60.0, MaterialCategory.PANEL, covers = 6.0)
            item(1, MaterialRole.PANEL, FenceType.VINYL, "Panel A", 60.0, MaterialCategory.PANEL, covers = 6.0)
            item(4, MaterialRole.LINE_POST, FenceType.VINYL, "Post B", 16.0, MaterialCategory.POST)
            item(3, MaterialRole.LINE_POST, FenceType.VINYL, "Post A", 16.0, MaterialCategory.POST)
            item(5, MaterialRole.END_POST, FenceType.VINYL, "End post", 16.0, MaterialCategory.POST)
            item(6, MaterialRole.CONCRETE_BAG, FenceType.UNIVERSAL, "Concrete", 5.0, MaterialCategory.CONCRETE)
            run(FenceType.VINYL, feet = 100.0)
        },
        case(47, "zero-placeholder-vs-priced") {
            note = "A \$0 row at the exact width loses to a priced row at the same width; a \$0 post loses to a priced post; " +
                "a role whose only row is \$0 (BLANK_POST) is chosen and reported as zero-priced."
            item(1, MaterialRole.PANEL, FenceType.VINYL, "Placeholder panel 6 ft", 0.0, MaterialCategory.PANEL, covers = 6.0, colour = "White")
            item(2, MaterialRole.LINE_POST, FenceType.VINYL, "Placeholder line post", 0.0, MaterialCategory.POST, colour = "White")
            item(3, MaterialRole.BLANK_POST, FenceType.VINYL, "Placeholder blank post", 0.0, MaterialCategory.POST)
            run(FenceType.VINYL, feet = 100.0, colour = "White", gates = gates(gate(500, 0, 4.0, GateMounting.WALL)))
        },
        case(48, "panel-width-reconciliation") {
            note = "Spec'd at 6 ft, only an 8 ft panel in that colour: 17 becomes ceil(100 / 8) = 13, from the true footage."
            item(1, MaterialRole.PANEL, FenceType.VINYL, "Panel 6'H x 8'W - Almond", 70.0, MaterialCategory.PANEL, covers = 8.0, colour = "Almond")
            item(2, MaterialRole.LINE_POST, FenceType.VINYL, "Line Post, Almond", 17.0, MaterialCategory.POST, colour = "Almond")
            run(FenceType.VINYL, feet = 100.0, colour = "Almond")
        },
        case(49, "inactive-row-ignored") {
            note = "The White 6 ft panel is inactive, so White narrows to the 8 ft row and the count is reconciled to 13."
            seedEdit = { row ->
                if (row.role == "PANEL" && row.coversFt == 6.0 && row.colorOrFinish == "White") row.copy(isActive = false) else row
            }
            run(FenceType.VINYL, feet = 100.0, colour = "White")
        },
        case(50, "suppressed-roles") {
            note = "HANDLE, BRACE and POST_CAP suppressed (with a bogus name and stray spaces): they never reach the entries."
            run(FenceType.VINYL, feet = 100.0, gates = gates(gate(500, 0, 4.0)), suppressed = "HANDLE,BRACE, POST_CAP ,BOGUS")
        },
        case(51, "catalog-empty") {
            note = "No catalog: every role unmatched, no items, labour and the gate charge still price."
            useSeed = false
            run(FenceType.VINYL, feet = 100.0, gates = gates(gate(500, 0, 4.0)))
        }
    )

    /* ---------------- existing rows: carry-over and survivors ---------------- */

    private fun carryOverCases() = listOf(
        case(52, "hand-edited-price-carry-over") {
            note = "An edited LINE_POST price is carried and flips the line to auto_generated=false; an edited price equal to " +
                "the catalog's does not flip; an edit on a role this run no longer produces is dropped."
            val r = run(FenceType.VINYL, feet = 100.0, colour = "White")
            existing(1, r.syncId, "LINE_POST", "5\"x5\" Co-Ex Line Post, White", 16.0, 14.0, auto = false, sort = 1)
            existing(2, r.syncId, "POST_CAP", "5\" External Pyramid PVC Post Cap, White", 18.0, 0.74, auto = false, sort = 4)
            existing(3, r.syncId, "CONCRETE_BAG", "Concrete Mix 60lb Bag", 18.0, 4.75, auto = true, sort = 5)
            existing(4, r.syncId, "GATE_PANEL", "Regular PVC Gate 6'H x 5'W, White", 1.0, 199.0, auto = false, sort = 6)
        },
        case(53, "supplier-price-carry-over") {
            note = "Supplier prices ride over by role whatever the auto flag; the totals use them; a supplier price plus " +
                "an edited catalog price carries both."
            val r = run(FenceType.VINYL, feet = 100.0, colour = "White")
            existing(1, r.syncId, "LINE_POST", "5\"x5\" Co-Ex Line Post, White", 16.0, 16.56, supplier = 15.0, auto = true, sort = 1)
            existing(2, r.syncId, "PANEL", "Panel T&G Vinyl Privacy 6'H x 6'W - White", 17.0, 52.35, supplier = 50.0, auto = false, sort = 0, taxable = false)
            existing(3, r.syncId, "END_POST", "5\"x5\" Co-Ex End Post, White", 2.0, 20.0, supplier = 18.0, auto = false, sort = 3)
        },
        case(54, "hand-added-extras-survive") {
            note = "Role-NONE rows on the run and any row with no run survive into the totals; a stale auto row and an edited " +
                "roled row on the run are replaced; a roled row with no run survives but feeds no carry-over."
            val r = run(FenceType.VINYL, feet = 100.0, colour = "White")
            existing(1, r.syncId, "NONE", "Permit fee", 1.0, 150.0, auto = false, sort = 50, taxable = false)
            existing(2, null, "NONE", "Delivery", 1.0, 75.0, auto = false, sort = 51)
            existing(3, r.syncId, "LINE_POST", "5\"x5\" Co-Ex Line Post, White", 99.0, 16.56, auto = true, sort = 1)
            existing(4, r.syncId, "HOLE_PLUG", "5/8\" Hole Plug, White", 4.0, 0.5, auto = false, sort = 9)
            existing(5, null, "LINE_POST", "Loose post", 1.0, 1.0, auto = false, sort = 2)
        }
    )

    /* ---------------- totals ---------------- */

    private fun totalsCases() = listOf(
        case(55, "change-orders") {
            note = "Two change orders: feet billed at the labour rate, cost added dollar for dollar, both marked up."
            job = job.copy(markupPercent = 15.0)
            run(FenceType.VINYL, feet = 100.0)
            changeOrder(1, 30.0, 400.0, 150.0)
            changeOrder(2, 0.0, 250.0, 0.0)
        },
        case(56, "teardown-typed-feet") {
            note = "Teardown on with typed feet: flat fee + rate x 80 + trash haul."
            job = job.copy(teardownEnabled = true, teardownFlatFee = 100.0, teardownRatePerFt = 3.0, teardownFeet = 80.0, trashHaulFee = 150.0)
            run(FenceType.VINYL, feet = 100.0)
        },
        case(57, "teardown-drawn-run") {
            note = "A run flagged is_teardown: its typed 60 ft prices the teardown, it is left out of linear_feet, " +
                "and it gets no line items."
            job = job.copy(teardownEnabled = true, teardownRatePerFt = 3.0)
            run(FenceType.VINYL, feet = 100.0)
            run(FenceType.WOOD, feet = 60.0, teardown = true, label = "old fence")
        },
        case(58, "teardown-fallback-billable-feet") {
            note = "Teardown on, nothing typed, no teardown run: priced along the new fence INCLUDING change-order feet."
            job = job.copy(teardownEnabled = true, teardownRatePerFt = 3.0)
            run(FenceType.VINYL, feet = 100.0)
            changeOrder(1, 20.0, 100.0, 0.0)
        },
        case(59, "teardown-disabled-ignores-fees") {
            note = "Teardown off: its rates, feet and the trash haul fee all count for nothing."
            job = job.copy(teardownEnabled = false, teardownFlatFee = 100.0, teardownRatePerFt = 3.0, teardownFeet = 80.0, trashHaulFee = 150.0)
            run(FenceType.VINYL, feet = 100.0)
        },
        case(60, "minimum-charge") {
            note = "A 10 ft job under the \$500 minimum: the floor applies before the round-up."
            job = job.copy(minimumJobCharge = 500.0)
            run(FenceType.VINYL, feet = 10.0)
        },
        case(61, "markup-on-tax") {
            note = "15% markup is taken on materials + tax + labour + gate charge: the tax dollars are marked up too."
            job = job.copy(markupPercent = 15.0)
            run(FenceType.VINYL, feet = 100.0, gates = gates(gate(500, 0, 4.0)))
        },
        case(62, "discount-after-markup") {
            note = "10% discount comes off the marked-up figure, so it discounts part of the markup."
            job = job.copy(markupPercent = 15.0, discountPercent = 10.0)
            run(FenceType.VINYL, feet = 100.0)
        },
        case(63, "round-up-ten") {
            note = "Cents in every component: the grand total rounds UP to the next \$10, never down."
            job = job.copy(laborRatePerFt = 8.25, taxRatePercent = 7.5, markupPercent = 12.5)
            run(FenceType.VINYL, feet = 101.0)
        },
        case(64, "flat-fee-and-gate-rate") {
            note = "A labour flat fee and a \$35/ft gate rate; the gate's feet leave the labour footage."
            job = job.copy(laborFlatFee = 250.0, laborRatePerFt = 9.5, gateRatePerFt = 35.0)
            run(FenceType.VINYL, feet = 100.0, gates = gates(gate(500, 0, 5.0)))
        }
    )

    /* ---------------- the ten shipped templates on a 100 ft open run ---------------- */

    private fun templateCases() = listOf(
        template(65, "template-01-vinyl-privacy-6ft", "6 ft Vinyl Privacy: 6x6 panels, spacing 6, 1 bag.") {
            run(FenceType.VINYL, feet = 100.0, panelWidth = 6.0, panelHeight = 6.0)
        },
        template(66, "template-02-vinyl-8ft-panels", "6 ft Vinyl on 8 ft panels: spacing 8.") {
            run(FenceType.VINYL, feet = 100.0, panelWidth = 8.0, panelHeight = 6.0)
        },
        template(67, "template-03-wood-privacy-6ft", "6 ft Wood Privacy: spacing 8, 3 rails, 5.5 in pickets, no gap.") {
            run(FenceType.WOOD, feet = 100.0, panelHeight = 6.0, woodStyle = WoodStyle.PRIVACY, rails = 3, picketWidth = 5.5, picketGap = 0.0)
        },
        template(68, "template-04-wood-spaced-picket-4ft", "4 ft Wood Spaced Picket: 2.5 in gap, the phone's other defaults.") {
            run(FenceType.WOOD, feet = 100.0, panelHeight = 4.0, woodStyle = WoodStyle.SPACED_PICKET, picketGap = 2.5)
        },
        template(69, "template-05-chain-link-4ft", "4 ft Chain Link: fabric 4, spacing 10, top rail.") {
            run(FenceType.CHAIN_LINK, feet = 100.0, panelHeight = 4.0, fabricHeight = 4.0, topRail = true)
        },
        template(70, "template-06-chain-link-6ft", "6 ft Chain Link: fabric 6, spacing 10, top rail.") {
            run(FenceType.CHAIN_LINK, feet = 100.0, panelHeight = 6.0, fabricHeight = 6.0, topRail = true)
        },
        template(71, "template-07-aluminum-pool-4ft", "4 ft Aluminum pool: 6x4, spacing 6, RACKABLE.") {
            run(FenceType.ALUMINUM, feet = 100.0, panelWidth = 6.0, panelHeight = 4.0, aluminumStyle = AluminumStyle.RACKABLE)
        },
        template(72, "template-08-ornamental-iron-6ft", "6 ft Ornamental Iron: 6x6, spacing 6.") {
            run(FenceType.ORNAMENTAL_IRON, feet = 100.0, panelWidth = 6.0, panelHeight = 6.0)
        },
        template(73, "template-09-split-rail-2-rail", "2-Rail Split Rail: spacing 8.") {
            run(FenceType.SPLIT_RAIL, feet = 100.0, splitRails = 2)
        },
        template(74, "template-10-composite-privacy-6ft", "6 ft Composite Privacy: spacing 8, 3 rails.") {
            run(FenceType.COMPOSITE, feet = 100.0, panelHeight = 6.0, rails = 3)
        }
    )

    /* ---------------- the DSL ---------------- */

    private fun case(no: Int, id: String, block: CaseBuilder.() -> Unit): ParityCase =
        CaseBuilder(no, id).apply(block).build()

    /** A shipped template priced the way a wizard job would be: Residential rates, tax 7, gate 20. */
    private fun template(no: Int, id: String, what: String, block: CaseBuilder.() -> Unit): ParityCase =
        case(no, id) {
            note = "Shipped template on a 100 ft open run. $what"
            job = job.copy(laborRatePerFt = 8.0, markupPercent = 15.0)
            block()
        }

    private class CaseBuilder(val no: Int, val id: String) {
        var note: String = ""
        var job: PricingJob = defaultJob()
        /** Seed the catalog from SeedData for the fence types in use. Off for a fully custom catalog. */
        var useSeed: Boolean = true
        /** A tweak to each seeded row, for cases about the catalog's own state. */
        var seedEdit: ((PricingCatalogItem) -> PricingCatalogItem)? = null

        private val runs = mutableListOf<PricingRun>()
        private val extraCatalog = mutableListOf<PricingCatalogItem>()
        private val manufacturers = mutableListOf<PricingManufacturer>()
        private val changeOrders = mutableListOf<PricingChangeOrder>()
        private val existingItems = mutableListOf<PricingExistingItem>()

        /** Case number in the first group, slot in the last: unique, fixed, readable. */
        fun uuid(slot: Int): String = String.format(Locale.US, "%08x-0000-4000-8000-%012x", no, slot)

        fun run(
            type: FenceType,
            slot: Int = runs.size + 1,
            label: String = type.name.lowercase(Locale.US).replace('_', ' '),
            feet: Double? = null,
            corners: Int = 0,
            closed: Boolean = false,
            points: String = "",
            gates: String = "",
            colour: String = "",
            panelWidth: Double = 6.0,
            panelHeight: Double = 6.0,
            // The phone's own default for the type (FenceRunListViewModel.defaultSpacingFor).
            spacing: Double = FenceRunListViewModel.defaultSpacingFor(type, panelWidth.toFloat(), 6f).toDouble(),
            bags: Double = 1.0,
            aluminumStyle: AluminumStyle = AluminumStyle.RACKABLE,
            woodStyle: WoodStyle = WoodStyle.PRIVACY,
            rails: Int = 3,
            picketWidth: Double = 5.5,
            picketGap: Double = 0.0,
            fabricHeight: Double = 4.0,
            topRail: Boolean = true,
            tensionWire: Boolean = false,
            barbedArms: Boolean = false,
            privacySlats: Boolean = false,
            splitRails: Int = 2,
            suppressed: String = "",
            teardown: Boolean = false
        ): PricingRun {
            val run = PricingRun(
                syncId = uuid(slot),
                label = label,
                fenceType = type.name,
                colorOrFinish = colour,
                pointsEncoded = points,
                gatesEncoded = gates,
                closedLoop = closed,
                manualLinearFeet = feet?.f32(),
                manualCornerCount = corners,
                panelWidthFt = panelWidth.f32(),
                panelHeightFt = panelHeight.f32(),
                postSpacingFt = spacing.f32(),
                concreteBagsPerPost = bags.f32(),
                aluminumStyle = aluminumStyle.name,
                woodStyle = woodStyle.name,
                woodRailCount = rails,
                picketWidthIn = picketWidth.f32(),
                picketGapIn = picketGap.f32(),
                fabricHeightFt = fabricHeight.f32(),
                includeTopRail = topRail,
                includeTensionWire = tensionWire,
                includeBarbedWireArms = barbedArms,
                includePrivacySlats = privacySlats,
                splitRailCount = splitRails,
                suppressedRoles = suppressed,
                isTeardown = teardown,
                sortOrder = runs.size
            )
            runs += run
            return run
        }

        fun item(
            slot: Int,
            role: MaterialRole,
            type: FenceType,
            name: String,
            price: Double,
            category: MaterialCategory,
            unit: String = "EA",
            taxable: Boolean = true,
            covers: Double? = null,
            colour: String = "",
            manufacturer: String? = null,
            active: Boolean = true
        ) {
            extraCatalog += PricingCatalogItem(
                syncId = uuid(slot), name = name, category = category.name, role = role.name,
                fenceType = type.name, colorOrFinish = colour, unit = unit, unitPrice = price,
                supplierUnitPrice = null, taxable = taxable, coversFt = covers?.f32(),
                isActive = active, manufacturerSyncId = manufacturer
            )
        }

        fun manufacturer(slot: Int, name: String) {
            manufacturers += PricingManufacturer(uuid(slot), name)
        }

        fun changeOrder(slot: Int, feet: Double, cost: Double, materialCost: Double) {
            changeOrders += PricingChangeOrder(uuid(slot), feet, cost, materialCost)
        }

        fun existing(
            slot: Int,
            runSyncId: String?,
            role: String?,
            description: String,
            quantity: Double,
            unitPrice: Double,
            supplier: Double? = null,
            auto: Boolean,
            sort: Int,
            unit: String = "EA",
            taxable: Boolean = true
        ) {
            // Slots 1..n are the runs; existing rows live at 100+ so they never collide.
            existingItems += PricingExistingItem(
                syncId = uuid(100 + slot), fenceRunSyncId = runSyncId, role = role, description = description,
                quantity = quantity, unit = unit, unitPrice = unitPrice, supplierUnitPrice = supplier,
                taxable = taxable, autoGenerated = auto, sortOrder = sort
            )
        }

        fun build(): ParityCase {
            require(runs.isNotEmpty()) { "$id has no runs" }
            val types = runs.map { FenceType.valueOf(it.fenceType) }.toSet()
            val seeded = if (useSeed) seedCatalog(types).map { seedEdit?.invoke(it) ?: it } else emptyList()
            val catalog = seeded + extraCatalog
            require(catalog.map { it.syncId }.distinct().size == catalog.size) { "$id: duplicate catalog sync id" }
            require(manufacturers.map { it.syncId }.distinct().size == manufacturers.size) { "$id: duplicate manufacturer" }
            val pixelsPerFoot = (job.calibrationPixelsPerFoot?.toFloat() ?: SurveyViewModel.PIXELS_PER_FOOT_GRID).toDouble()
            return ParityCase(
                id = id,
                note = note,
                input = PricingInput(
                    engineVersion = EstimateEngine.PRICING_ENGINE_VERSION,
                    pixelsPerFoot = pixelsPerFoot,
                    job = job,
                    runs = runs.toList(),
                    catalog = catalog,
                    manufacturers = manufacturers.toList(),
                    changeOrders = changeOrders.toList(),
                    existingItems = existingItems.toList()
                )
            )
        }
    }

    /** The Job defaults every case starts from: a calibrated grid job at \$8/ft, 7% tax, \$20/ft gates. */
    private fun defaultJob() = PricingJob(
        calibrationPixelsPerFoot = SurveyViewModel.PIXELS_PER_FOOT_GRID.toDouble(),
        taxRatePercent = 7.0,
        markupPercent = 0.0,
        discountPercent = 0.0,
        laborRatePerFt = 8.0,
        laborFlatFee = 0.0,
        minimumJobCharge = 0.0,
        wastePercent = 0.0,
        gateRatePerFt = 20.0,
        trashHaulFee = 0.0,
        teardownEnabled = false,
        teardownFlatFee = 0.0,
        teardownRatePerFt = 0.0,
        teardownFeet = 0.0,
        preferredManufacturerSyncId = null
    )

    /** Written after fround, as the contract requires of every float-valued field. */
    private fun Double.f32(): Double = this.toFloat().toDouble()

    private fun pts(vararg p: Pair<Number, Number>): String =
        FenceCodec.encodePoints(p.map { FencePoint(it.first.toFloat(), it.second.toFloat()) })

    /** A square of the given side in pixels, starting at the origin, clockwise on screen. */
    private fun square(side: Int): String = pts(0 to 0, side to 0, side to side, 0 to side)

    private fun gates(vararg g: GateMarker): String = FenceCodec.encodeGates(g.toList())

    private fun gate(
        x: Number, y: Number, widthFt: Double,
        mounting: GateMounting = GateMounting.LINE, swing: GateSwing = GateSwing.IN
    ) = GateMarker(x.toFloat(), y.toFloat(), widthFt.toFloat(), mounting, swing)

    /**
     * The shipped catalog, keyed by content rather than by the random uuid
     * SeedData mints, so the same row has the same id on every regenerate.
     */
    private fun seedCatalog(types: Set<FenceType>): List<PricingCatalogItem> =
        SeedData.materialItems()
            .filter { it.fenceType == FenceType.UNIVERSAL || it.fenceType in types }
            .map { m ->
                PricingCatalogItem(
                    syncId = seedSyncId(m), name = m.name, category = m.category.name, role = m.role.name,
                    fenceType = m.fenceType.name, colorOrFinish = m.colorOrFinish, unit = m.unit,
                    unitPrice = m.unitPrice, supplierUnitPrice = null, taxable = m.taxable,
                    coversFt = m.coversFt?.toDouble(), isActive = m.isActive, manufacturerSyncId = null
                )
            }

    private fun seedSyncId(m: MaterialItem): String = UUID.nameUUIDFromBytes(
        "fenceflow-parity-seed:${m.fenceType}:${m.role}:${m.name}:${m.colorOrFinish}".toByteArray()
    ).toString()
}
