package com.fenceestimator.app.ui.schedule

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowLeft
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.estimate.JobSchedule
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * A month at a glance.
 *
 * The list view answers "what is next"; it cannot answer "is the week of the
 * twelfth free", which is the question asked every time somebody rings up
 * wanting a date. Both views stay, because they answer different questions and
 * neither is a worse version of the other.
 *
 * A multi-day job fills every day it runs, not just its start. A three-day job
 * showing as one square is how a week looks empty right up until the crew are
 * already booked.
 */
@Composable
fun MonthCalendar(
    monthStart: Long,
    jobs: List<Job>,
    workdayHours: Double,
    selectedDay: Long?,
    onSelectDay: (Long) -> Unit,
    onPreviousMonth: () -> Unit,
    onNextMonth: () -> Unit
) {
    val monthFormat = remember { SimpleDateFormat("MMMM yyyy", Locale.US) }
    val cal = remember(monthStart) { Calendar.getInstance().apply { timeInMillis = monthStart } }

    // Which days each job occupies, so a job spanning a week colours the week.
    val jobsByDay = remember(jobs, monthStart, workdayHours) {
        val map = mutableMapOf<Long, MutableList<Job>>()
        jobs.forEach { job ->
            val start = job.scheduledDate ?: return@forEach
            val days = JobSchedule.plan(job, workdayHours).totalDays
            repeat(days) { offset ->
                val day = JobSchedule.startOfDay(JobSchedule.addDays(start, offset))
                map.getOrPut(day) { mutableListOf() }.add(job)
            }
        }
        map
    }

    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onPreviousMonth) {
                Icon(Icons.Filled.KeyboardArrowLeft, contentDescription = "Previous month")
            }
            Text(
                monthFormat.format(Date(monthStart)),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            IconButton(onClick = onNextMonth) {
                Icon(Icons.Filled.KeyboardArrowRight, contentDescription = "Next month")
            }
        }

        Row(Modifier.fillMaxWidth()) {
            listOf("S", "M", "T", "W", "T", "F", "S").forEach { day ->
                Text(
                    day,
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center
                )
            }
        }

        // Leading blanks so the first of the month lands on its real weekday.
        val firstDayOfWeek = Calendar.getInstance().apply {
            timeInMillis = monthStart
            set(Calendar.DAY_OF_MONTH, 1)
        }.get(Calendar.DAY_OF_WEEK) - 1
        val daysInMonth = cal.getActualMaximum(Calendar.DAY_OF_MONTH)
        val today = JobSchedule.startOfDay(System.currentTimeMillis())

        var dayCounter = 1
        val weeks = ((firstDayOfWeek + daysInMonth + 6) / 7)
        repeat(weeks) { week ->
            Row(Modifier.fillMaxWidth()) {
                repeat(7) { slot ->
                    val cellIndex = week * 7 + slot
                    if (cellIndex < firstDayOfWeek || dayCounter > daysInMonth) {
                        Box(Modifier.weight(1f).aspectRatio(1f))
                    } else {
                        val thisDay = dayCounter
                        val dayMillis = JobSchedule.startOfDay(
                            Calendar.getInstance().apply {
                                timeInMillis = monthStart
                                set(Calendar.DAY_OF_MONTH, thisDay)
                            }.timeInMillis
                        )
                        val onThisDay = jobsByDay[dayMillis].orEmpty()
                        DayCell(
                            day = thisDay,
                            jobCount = onThisDay.size,
                            isToday = dayMillis == today,
                            isSelected = selectedDay == dayMillis,
                            onClick = { onSelectDay(dayMillis) },
                            modifier = Modifier.weight(1f)
                        )
                        dayCounter++
                    }
                }
            }
        }
    }
}

@Composable
private fun DayCell(
    day: Int,
    jobCount: Int,
    isToday: Boolean,
    isSelected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Box(
        modifier
            .aspectRatio(1f)
            .padding(2.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(
                when {
                    isSelected -> MaterialTheme.colorScheme.primaryContainer
                    jobCount > 0 -> MaterialTheme.colorScheme.secondaryContainer
                    else -> MaterialTheme.colorScheme.surface
                }
            )
            .then(
                if (isToday) Modifier.border(
                    2.dp,
                    MaterialTheme.colorScheme.primary,
                    RoundedCornerShape(6.dp)
                ) else Modifier
            )
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                day.toString(),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (isToday) FontWeight.Bold else FontWeight.Normal
            )
            // A dot per job rather than a number, up to three. On a phone-sized
            // square "3" and "8" look identical at a glance; three dots and a
            // plus reads as "busy" without anyone counting.
            if (jobCount > 0) {
                Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    repeat(minOf(jobCount, 3)) {
                        Box(
                            Modifier
                                .size(4.dp)
                                .clip(CircleShape)
                                .background(MaterialTheme.colorScheme.primary)
                        )
                    }
                    if (jobCount > 3) {
                        Text("+", style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
    }
}
