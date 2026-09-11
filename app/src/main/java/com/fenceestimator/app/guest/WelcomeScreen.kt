package com.fenceestimator.app.guest

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.R

/**
 * First thing shown when nobody is signed in, no guest session is running,
 * and this phone has no real local data yet. See MainActivity for the exact
 * three-part test that decides when this appears -- getting that test wrong
 * in either direction is the whole risk of this screen, not anything drawn
 * here.
 *
 * [onTryGuest] is a suspend-shaped callback (fired from a coroutine at the
 * call site) because it seeds a small company's worth of jobs before the
 * guest session can be considered started; [seeding] disables the button and
 * shows that something is happening rather than letting a second tap queue a
 * second copy of the sample company.
 */
@Composable
fun WelcomeScreen(
    seeding: Boolean,
    onSignIn: () -> Unit,
    onTryGuest: () -> Unit
) {
    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                stringResource(R.string.welcome_title),
                style = MaterialTheme.typography.headlineMedium
            )
            androidx.compose.foundation.layout.Spacer(Modifier.height(8.dp))
            Text(
                stringResource(R.string.welcome_subtitle),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            androidx.compose.foundation.layout.Spacer(Modifier.height(32.dp))
            Button(
                onClick = onSignIn,
                enabled = !seeding,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(stringResource(R.string.welcome_sign_in))
            }
            androidx.compose.foundation.layout.Spacer(Modifier.height(12.dp))
            OutlinedButton(
                onClick = onTryGuest,
                enabled = !seeding,
                modifier = Modifier.fillMaxWidth()
            ) {
                if (seeding) {
                    CircularProgressIndicator(modifier = Modifier.padding(end = 8.dp), strokeWidth = 2.dp)
                }
                Text(stringResource(R.string.welcome_try_guest))
            }
            androidx.compose.foundation.layout.Spacer(Modifier.height(8.dp))
            Text(
                stringResource(R.string.welcome_try_guest_caption),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
