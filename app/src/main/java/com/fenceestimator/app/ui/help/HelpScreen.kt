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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.ui.components.currentApp

private data class Guide(val title: String, val body: String)

private val APP_GUIDES = listOf(
    Guide(
        "1. Start a job",
        "Tap the + button on the home screen. Fill in the customer's name, address, phone, and email. " +
            "The address box suggests real addresses as you type, so you don't have to type the whole thing."
    ),
    Guide(
        "2. Draw the fence",
        "Open the job, tap Survey & Draw. You can either upload a photo of the survey or draw on the blank grid. " +
            "In Draw mode, tap once for each corner of the fence. Use Adjust mode to drag a point you got wrong. " +
            "Gate mode drops a gate anywhere you tap. Move View mode lets you drag around without drawing."
    ),
    Guide(
        "3. Set the scale",
        "If you uploaded a survey photo, use Calibrate mode: tap two points you know the real distance between " +
            "(a house wall, a property line marker), then type in the feet. Everything else measures off that. " +
            "On the blank grid the scale is already set, so you can skip this."
    ),
    Guide(
        "4. Get your material list",
        "Open Estimate and tap Suggest Quantities on each fence run. The app works out posts (line, corner, end, gate), " +
            "panels or pickets and rails, concrete bags, caps, and gate hardware from what you drew. " +
            "Every line is editable -- tap it to change the quantity or price."
    ),
    Guide(
        "5. Price it and send it",
        "Set your tax, markup, labor rate, and any discount on the job screen. Watch for the orange warning box on the " +
            "Estimate screen -- it flags a thin profit margin, missing concrete, or a deposit that won't cover materials. " +
            "Then Export & Share PDF Estimate to send it."
    ),
    Guide(
        "6. Job day",
        "Open the job and tap Open Job-Day Crew View. That's the screen for the crew: address with directions, what's being " +
            "built, the customer walkthrough checklist, install steps, and before/after photos."
    ),
    Guide(
        "7. Get paid and follow up",
        "Record the deposit and payments in Payment & Invoice. Generate & Share Invoice makes the final bill. " +
            "Once the job's done, use Ask for a Review to send a thank-you and review request."
    ),
    Guide(
        "Backing up your data",
        "Settings -> Backup & Restore. Back Up Now saves everything to a file you choose (Google Drive, Dropbox, your phone). " +
            "Do this regularly. If you sign in under Account & Team, jobs also sync with your crew."
    )
)

private val FENCE_GUIDES = listOf(
    Guide(
        "Before you dig -- always",
        "Call 811 (in the US) at least a few business days before digging. It's free and they mark buried gas, power, " +
            "and cable lines. Hitting a line is dangerous and expensive, and skipping the call can put the liability on you. " +
            "Also ask the homeowner about sprinkler lines and septic fields, which 811 does NOT mark."
    ),
    Guide(
        "Property lines and permits",
        "Never guess a property line. Use the survey, or have one done. Many people build a few inches inside their line " +
            "on purpose to avoid disputes. Check with the city or county about permits and with the HOA about approved styles " +
            "and colors before ordering material."
    ),
    Guide(
        "Post spacing and depth",
        "Typical post spacing is 6 to 8 feet on center, matched to your panel width. As a rule of thumb bury about a third " +
            "of the post length, and get below the frost line in cold climates -- your local code sets the real number. " +
            "Deeper and wider holes for gate posts and corners, since those carry the most load."
    ),
    Guide(
        "Setting posts",
        "Dig the hole wider at the bottom than the top so frost can't push the post up. Add a few inches of gravel for drainage. " +
            "Set the post, check plumb on two sides with a level, brace it, then pour concrete. Slope the top of the concrete " +
            "away from the post so water runs off instead of pooling."
    ),
    Guide(
        "Corner, end, and line posts",
        "End and corner posts take all the tension, so they're usually heavier and set deeper. Line posts just carry the panel " +
            "weight between them. Gate posts take the most abuse of all -- a sagging gate is almost always an undersized or " +
            "shallow gate post."
    ),
    Guide(
        "Building on a slope",
        "Two options. Stepped: panels stay level and step down like stairs, leaving triangular gaps at the bottom. " +
            "Racked: the panel follows the ground angle with no gaps. Racked looks better on gentle slopes; stepped works " +
            "on steep ground and is your only choice with rigid preassembled panels."
    ),
    Guide(
        "Gates that don't sag",
        "Use a diagonal brace running from the top of the hinge side down to the bottom of the latch side (for wire), or " +
            "a steel gate frame kit. Leave clearance so the gate swings over grass and snow. Hang hardware on the post, " +
            "not the panel."
    ),
    Guide(
        "Common mistakes",
        "Setting posts before the concrete on the corners cures. Not letting pressure-treated wood dry before staining. " +
            "Forgetting gate swing direction until the posts are in. Ordering material before HOA approval comes back. " +
            "Skipping the customer walkthrough and finding out afterward they wanted the good side facing their yard."
    )
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HelpScreen(onBack: () -> Unit) {
    var tab by remember { mutableIntStateOf(0) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Help & Guides") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") } }
            )
        }
    ) { padding ->
        Column(Modifier.padding(padding)) {
            TabRow(selectedTabIndex = tab) {
                Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Using the App") })
                Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("Fence Basics") })
                Tab(selected = tab == 2, onClick = { tab = 2 }, text = { Text("Codes & Permits") })
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
                            "These are general practices, not code. Requirements change by state, county, and HOA -- always " +
                                "confirm locally before you build.",
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
                    Text("Read this first", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onErrorContainer)
                    Text(
                        "This app does not contain a fence code database and cannot tell you what's legal where you're " +
                            "working. Height limits, setbacks, corner-visibility rules, pool-barrier requirements, and permit " +
                            "rules are set locally and change often. Always confirm with your city or county building " +
                            "department and the HOA before you order material or dig. Responsibility for compliance is " +
                            "yours, not the app's.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onErrorContainer
                    )
                }
            }
        }
        item {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Look up the rules for this job", style = MaterialTheme.typography.titleMedium)
                    LinkButton("Call 811 before you dig (utility locates)") {
                        openUrl(context, "https://call811.com/")
                    }
                    LinkButton("Find your local building department") {
                        openUrl(context, "https://www.google.com/search?q=" + Uri.encode("building department fence permit near me"))
                    }
                    LinkButton("Search fence height + setback rules near you") {
                        openUrl(context, "https://www.google.com/search?q=" + Uri.encode("residential fence height setback code ordinance near me"))
                    }
                    LinkButton("Pool barrier / safety fence requirements") {
                        openUrl(context, "https://www.google.com/search?q=" + Uri.encode("swimming pool barrier fence code requirements"))
                    }
                    LinkButton("International Code Council (model codes)") {
                        openUrl(context, "https://www.iccsafe.org/")
                    }
                    LinkButton("OSHA construction safety standards") {
                        openUrl(context, "https://www.osha.gov/construction")
                    }
                }
            }
        }
        item {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Protecting the business", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "The habits that keep jobs out of court: get the walkthrough confirmed before digging, " +
                            "photograph the site before and after, put every change in a signed change order, and keep " +
                            "your general liability and workers' comp current.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    LinkButton("Compare contractor liability insurance") {
                        openUrl(context, "https://www.google.com/search?q=" + Uri.encode("fencing contractor general liability insurance quotes"))
                    }
                    LinkButton("Check your state contractor license board") {
                        openUrl(context, "https://www.google.com/search?q=" + Uri.encode("state contractor license board fencing"))
                    }
                }
            }
        }
        item {
            Text(
                "These links open your browser and go to third-party sites -- FenceFlow doesn't control what they say.",
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
                Text(guide.title, Modifier.weight(1f), fontWeight = FontWeight.Medium)
                Icon(
                    if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                    contentDescription = null
                )
            }
            AnimatedVisibility(visible = expanded) {
                Text(
                    guide.body,
                    Modifier.padding(top = 8.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}
