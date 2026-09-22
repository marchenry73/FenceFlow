package com.fenceestimator.app.ui.onboarding

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.R

/**
 * Shown when this launch came up without its database -- a process whose
 * class loader could not see the database classes, as happens around an
 * update (see [com.fenceestimator.app.StartupGuard]).
 *
 * It used to be a crash, as often as the phone tried: seven in a row from one
 * crew handset. The person needs two facts and one button. Their work is on
 * the phone, untouched -- nothing was opened, so nothing could be damaged --
 * and opening the app again, in a new process, is the whole fix. Close ends
 * this process on the way out (MainActivity.onDestroy), so the next tap gets
 * a clean start rather than this one back.
 *
 * Deliberately reads nothing from the database and asks nothing of the
 * network: it is drawn precisely when neither can be trusted.
 */
@Composable
fun UpdateSettlingScreen(onClose: () -> Unit) {
    // Back is Close. Left to the system, Back on the launcher's own screen
    // (Android 12 and later) only sends the task behind, so the process that
    // could not load the database lives on and the next tap brings it back.
    BackHandler(onBack = onClose)
    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(28.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                stringResource(R.string.startup_settling_title),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold
            )
            Text(
                stringResource(R.string.startup_settling_body),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Text(
                stringResource(R.string.startup_settling_nothing_lost),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Button(onClick = onClose, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.startup_settling_close))
            }
        }
    }
}
