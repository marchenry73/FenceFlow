package com.fenceestimator.app.ui.jobs

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.ui.theme.ErrorRed
import com.fenceestimator.app.ui.theme.Graphite40
import com.fenceestimator.app.ui.theme.Graphite90
import com.fenceestimator.app.ui.theme.Neutral30
import com.fenceestimator.app.ui.theme.SafetyOrange20
import com.fenceestimator.app.ui.theme.SafetyOrange40
import com.fenceestimator.app.ui.theme.SafetyOrange80
import com.fenceestimator.app.ui.theme.Space
import com.fenceestimator.app.ui.theme.SteelTeal20
import com.fenceestimator.app.ui.theme.SteelTeal40
import com.fenceestimator.app.ui.theme.SteelTeal80

/**
 * One row for one job, wherever a list draws one.
 *
 * The job list, the home screen's This Week card and the schedule each grew
 * their own version of this card, each with its own re-typed status colours.
 * A fix to how a long address wraps -- or a corner radius, or a status tint --
 * only ever reached whichever one of the three somebody happened to be
 * touching. One composable now, so a fix here reaches every list at once.
 */
@Composable
fun JobRow(
    customerName: String,
    address: String,
    status: JobStatus,
    trailingText: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    /** Only the jobs list asks for this -- the status is already the row's
     *  own colour stripe everywhere else, and repeating it as a pill too is
     *  noise on a card whose only content is one job. */
    showStatusPill: Boolean = false,
    /** The day badge on the home screen's This Week card; nothing elsewhere. */
    leading: (@Composable () -> Unit)? = null,
    /** A second line under the address -- the schedule's crew summary. */
    caption: String? = null,
    /** The jobs list's owner-only delete icon; nothing elsewhere. */
    action: (@Composable () -> Unit)? = null
) {
    Card(
        onClick = onClick,
        modifier = modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium,
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Row(Modifier.fillMaxWidth()) {
            Box(
                Modifier
                    .width(4.dp)
                    .fillMaxHeight()
                    .background(statusPalette.getValue(status).stripe)
            )
            Row(
                modifier = Modifier.weight(1f).padding(Space.card),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Space.row)
            ) {
                leading?.invoke()
                Column(Modifier.weight(1f)) {
                    Text(
                        customerName,
                        style = MaterialTheme.typography.titleSmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    if (address.isNotBlank()) {
                        Text(
                            address,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                    if (caption != null) {
                        Text(
                            caption,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        trailingText,
                        style = MaterialTheme.typography.labelLarge.copy(fontFeatureSettings = "tnum"),
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    if (showStatusPill) {
                        Spacer(Modifier.height(4.dp))
                        JobStatusPill(status)
                    }
                }
                action?.invoke()
            }
        }
    }
}

@Composable
private fun JobStatusPill(status: JobStatus) {
    val palette = statusPalette.getValue(status)
    Box(
        modifier = Modifier
            .background(palette.pillBg, RoundedCornerShape(50))
            .padding(horizontal = 8.dp, vertical = 3.dp)
    ) {
        Text(
            statusLabel(status),
            color = palette.pillFg,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

/** One job-status colour per status, in one place. Everywhere a status needs
 *  a stripe or a pill reads from here rather than re-typing the hex. Two of
 *  the five statuses (draft, declined) don't line up with a theme constant --
 *  drafts read as a plain "not yet the brand's colours" grey, and declined
 *  needed a lighter tint than [ErrorRed] to work as a filled pill background
 *  -- so those two stay literal. */
private data class StatusPalette(val stripe: Color, val pillBg: Color, val pillFg: Color)

private val statusPalette: Map<JobStatus, StatusPalette> = mapOf(
    JobStatus.DRAFT to StatusPalette(
        stripe = Color(0xFF8A93A3), pillBg = Color(0xFFE3E7ED), pillFg = Neutral30
    ),
    JobStatus.SENT to StatusPalette(
        stripe = SafetyOrange40, pillBg = SafetyOrange80, pillFg = SafetyOrange20
    ),
    JobStatus.ACCEPTED to StatusPalette(
        stripe = SteelTeal40, pillBg = SteelTeal80, pillFg = SteelTeal20
    ),
    JobStatus.COMPLETED to StatusPalette(
        stripe = Graphite40, pillBg = Graphite90, pillFg = Graphite40
    ),
    JobStatus.DECLINED to StatusPalette(
        stripe = ErrorRed, pillBg = Color(0xFFFBD3D4), pillFg = Color(0xFF8C1114)
    )
)
