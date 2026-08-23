package com.fenceestimator.app.ui.help

import android.content.Intent
import android.net.Uri
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.R
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.ui.components.currentApp

private data class Guide(val title: Int, val body: Int)

private val APP_GUIDES = listOf(
    Guide(R.string.rep_guide_start_job_title, R.string.rep_guide_start_job_body),
    Guide(R.string.rep_guide_draw_fence_title, R.string.rep_guide_draw_fence_body),
    Guide(R.string.rep_guide_set_scale_title, R.string.rep_guide_set_scale_body),
    Guide(R.string.rep_guide_material_list_title, R.string.rep_guide_material_list_body),
    Guide(R.string.rep_guide_price_send_title, R.string.rep_guide_price_send_body),
    Guide(R.string.rep_guide_job_day_title, R.string.rep_guide_job_day_body),
    Guide(R.string.rep_guide_get_paid_title, R.string.rep_guide_get_paid_body),
    Guide(R.string.rep_guide_backup_title, R.string.rep_guide_backup_body)
)

private val FENCE_GUIDES = listOf(
    Guide(R.string.rep_guide_before_dig_title, R.string.rep_guide_before_dig_body),
    Guide(R.string.rep_guide_property_lines_title, R.string.rep_guide_property_lines_body),
    Guide(R.string.rep_guide_post_spacing_title, R.string.rep_guide_post_spacing_body),
    Guide(R.string.rep_guide_setting_posts_title, R.string.rep_guide_setting_posts_body),
    Guide(R.string.rep_guide_post_types_title, R.string.rep_guide_post_types_body),
    Guide(R.string.rep_guide_slope_title, R.string.rep_guide_slope_body),
    Guide(R.string.rep_guide_gates_title, R.string.rep_guide_gates_body),
    Guide(R.string.rep_guide_mistakes_title, R.string.rep_guide_mistakes_body)
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HelpScreen(onBack: () -> Unit) {
    var tab by remember { mutableIntStateOf(0) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.help_title)) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back)) } }
            )
        }
    ) { padding ->
        Column(Modifier.padding(padding)) {
            TabRow(selectedTabIndex = tab) {
                Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text(stringResource(R.string.help_tab_app)) })
                Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text(stringResource(R.string.help_tab_fence)) })
                Tab(selected = tab == 2, onClick = { tab = 2 }, text = { Text(stringResource(R.string.help_tab_codes)) })
            }
            if (tab == 2) {
                CodesTab()
                return@Column
            }
            LazyColumn(
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                val guides = if (tab == 0) APP_GUIDES else FENCE_GUIDES
                items(guides.size) { index ->
                    GuideCard(guides[index])
                }
                if (tab == 1) {
                    item {
                        Text(
                            stringResource(R.string.rep_help_fence_disclaimer),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
    }
}

/**
 * Deliberately a set of links to official sources rather than a built-in code
 * database. Fence rules are set per city/county/HOA, change without notice,
 * and getting one wrong has real legal and financial consequences -- shipping
 * a stale copy inside the app would be worse than useless.
 */
@Composable
private fun CodesTab() {
    val context = LocalContext.current

    LazyColumn(
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Card(
                Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
            ) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(stringResource(R.string.rep_help_read_first), fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onErrorContainer)
                    Text(
                        stringResource(R.string.rep_help_no_code_db),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onErrorContainer
                    )
                }
            }
        }
        item {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(stringResource(R.string.rep_help_lookup_rules), style = MaterialTheme.typography.titleMedium)
                    LinkButton(stringResource(R.string.rep_help_link_811)) {
                        openUrl(context, "https://call811.com/")
                    }
                    LinkButton(stringResource(R.string.rep_help_link_building_dept)) {
                        openUrl(context, "https://www.google.com/search?q=" + Uri.encode("building department fence permit near me"))
                    }
                    LinkButton(stringResource(R.string.rep_help_link_height_setback)) {
                        openUrl(context, "https://www.google.com/search?q=" + Uri.encode("residential fence height setback code ordinance near me"))
                    }
                    LinkButton(stringResource(R.string.rep_help_link_pool)) {
                        openUrl(context, "https://www.google.com/search?q=" + Uri.encode("swimming pool barrier fence code requirements"))
                    }
                    LinkButton(stringResource(R.string.rep_help_link_icc)) {
                        openUrl(context, "https://www.iccsafe.org/")
                    }
                    LinkButton(stringResource(R.string.rep_help_link_osha)) {
                        openUrl(context, "https://www.osha.gov/construction")
                    }
                }
            }
        }
        item {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(stringResource(R.string.rep_help_protect_business), style = MaterialTheme.typography.titleMedium)
                    Text(
                        stringResource(R.string.rep_help_protect_body),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    LinkButton(stringResource(R.string.rep_help_link_insurance)) {
                        openUrl(context, "https://www.google.com/search?q=" + Uri.encode("fencing contractor general liability insurance quotes"))
                    }
                    LinkButton(stringResource(R.string.rep_help_link_license_board)) {
                        openUrl(context, "https://www.google.com/search?q=" + Uri.encode("state contractor license board fencing"))
                    }
                }
            }
        }
        item {
            Text(
                stringResource(R.string.rep_help_third_party_note),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun LinkButton(label: String, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Icon(Icons.Filled.OpenInNew, contentDescription = null)
        Text("  $label")
    }
}

private fun openUrl(context: android.content.Context, url: String) {
    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
}

@Composable
private fun GuideCard(guide: Guide) {
    var expanded by remember { mutableStateOf(false) }
    Card(Modifier.fillMaxWidth().clickable { expanded = !expanded }) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(guide.title), Modifier.weight(1f), fontWeight = FontWeight.Medium)
                Icon(
                    if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                    contentDescription = null
                )
            }
            AnimatedVisibility(visible = expanded) {
                Text(
                    stringResource(guide.body),
                    Modifier.padding(top = 8.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}
