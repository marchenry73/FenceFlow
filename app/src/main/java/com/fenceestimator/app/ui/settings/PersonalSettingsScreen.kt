package com.fenceestimator.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.HelpOutline
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.BuildConfig
import com.fenceestimator.app.R
import com.fenceestimator.app.data.AppLanguage
import com.fenceestimator.app.data.ThemeMode
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp

/**
 * Settings for everyone who may not change the company's.
 *
 * Settings used to be one screen behind "Change catalog and settings", and the
 * only way in was an overflow menu drawn for the same people. So crew -- and a
 * foreman, seller or bookkeeper on their default access -- could not switch to
 * dark mode, change language, set auto-lock, find Help, or reach Account to
 * sign out unless the sync chip happened to say they needed to sign in.
 *
 * Opening the full screen to them was never the answer: it carries prices,
 * pricing tiers, backups and an "export everything" with every payment in it,
 * and its save writes company settings. This is the other screen. It holds only
 * what belongs to the phone in the person's hand, and it cannot reach the
 * cloud -- [PersonalSettingsViewModel] writes four device-local keys and
 * nothing else.
 *
 * Built from SettingsScreen's own pieces so the two read as one app.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PersonalSettingsScreen(
    onBack: () -> Unit,
    onOpenAccount: () -> Unit,
    onOpenHelp: () -> Unit,
    onOpenFeedback: () -> Unit
) {
    val app = currentApp()
    val viewModel: PersonalSettingsViewModel = viewModel(
        factory = GenericViewModelFactory { PersonalSettingsViewModel(app.settingsStore, app.applicationScope) }
    )
    val loaded by viewModel.prefs.collectAsState()
    val loadedPrefs = loaded

    if (loadedPrefs == null) {
        // Same rule as SettingsScreen: never seed the buffer below from a
        // placeholder, or a stored Dark flashes up as System for a frame and a
        // tap in that frame saves the placeholder over the real choice.
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }

    val context = LocalContext.current

    // Seeded once, from the stored values, and never re-seeded -- the switches
    // show what was tapped at once rather than waiting on DataStore.
    var local by remember { mutableStateOf(loadedPrefs) }

    // Saved the moment each choice is made, with no debounce. SettingsScreen
    // waits a second because people type into it; nothing here is typed, every
    // change is one deliberate tap, and theme and language only visibly apply
    // once the write lands. Somebody who picks Dark should see Dark, not a
    // pause that looks like the tap missed.
    val change: (DevicePrefs) -> Unit = { next ->
        if (next != local) {
            local = next
            viewModel.save(next)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
                    }
                }
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxWidth().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            item {
                // Said up front, so nobody goes looking for the prices or the
                // crew list here and decides the app is missing them.
                Text(
                    stringResource(R.string.pset_intro),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 4.dp)
                )
            }
            item { GroupHeading(stringResource(R.string.set_group_app)) }
            item {
                // Every card starts open. SettingsScreen shuts its cards because
                // it has fourteen; four do not need hiding. Open also survives a
                // language change: the card remembers its state by its title,
                // so a card that started shut would snap closed the instant a
                // new language renamed it, right under the finger that chose it.
                SectionCard(
                    stringResource(R.string.settings_appearance),
                    startExpanded = true,
                    icon = Icons.Filled.Palette
                ) {
                    val themeLabels = mapOf(
                        ThemeMode.SYSTEM to stringResource(R.string.set_theme_system),
                        ThemeMode.LIGHT to stringResource(R.string.set_theme_light),
                        ThemeMode.DARK to stringResource(R.string.set_theme_dark)
                    )
                    SettingsEnumDropdown(
                        stringResource(R.string.settings_theme),
                        listOf(ThemeMode.SYSTEM, ThemeMode.LIGHT, ThemeMode.DARK),
                        local.themeMode,
                        { themeLabels[it] ?: it.name }
                    ) { change(local.copy(themeMode = it)) }
                    // Language only. SettingsScreen also swaps the company's
                    // default email templates when the language changes; those
                    // are the company's words, and this screen never writes them.
                    SettingsEnumDropdown(
                        stringResource(R.string.settings_language),
                        AppLanguage.values().toList(),
                        local.language,
                        { it.displayName }
                    ) { change(local.copy(language = it)) }
                    Text(
                        stringResource(R.string.pset_language_note),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            item {
                SectionCard(
                    stringResource(R.string.set_security),
                    startExpanded = true,
                    icon = Icons.Filled.Lock
                ) {
                    Text(
                        stringResource(R.string.set_security_explain),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    val autoLockNever = stringResource(R.string.set_auto_lock_never)
                    val autoLockOneMinute = stringResource(R.string.set_auto_lock_one_minute)
                    SettingsEnumDropdown(
                        stringResource(R.string.set_auto_lock_after),
                        listOf(0, 1, 5, 15, 30, 60),
                        local.autoLockMinutes,
                        {
                            when (it) {
                                0 -> autoLockNever
                                1 -> autoLockOneMinute
                                else -> context.getString(R.string.set_auto_lock_minutes, it)
                            }
                        }
                    ) { change(local.copy(autoLockMinutes = it)) }

                    // Only offered where the phone can actually do it. A switch
                    // that turns on and then never asks for a fingerprint reads
                    // as the app being broken.
                    val biometricReady = remember { com.fenceestimator.app.ui.lock.biometricAvailable(context) }
                    if (biometricReady) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(stringResource(R.string.set_biometric_unlock), modifier = Modifier.weight(1f))
                            Switch(
                                checked = local.biometricUnlockEnabled,
                                onCheckedChange = { change(local.copy(biometricUnlockEnabled = it)) }
                            )
                        }
                        Text(
                            stringResource(R.string.set_biometric_fallback),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    } else {
                        Text(
                            stringResource(R.string.set_biometric_unavailable),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
            item { GroupHeading(stringResource(R.string.pset_group_account)) }
            item {
                // Account holds sign-out, and with it the warning about work
                // that has not reached the cloud yet. Linking there rather than
                // copying a sign-out button here keeps that warning in the one
                // place it is maintained.
                SectionCard(
                    stringResource(R.string.pset_account_title),
                    startExpanded = true,
                    icon = Icons.Filled.AccountCircle
                ) {
                    Text(
                        stringResource(R.string.pset_account_explain),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    OutlinedButton(onClick = onOpenAccount, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.pset_open_account))
                    }
                }
            }
            item { GroupHeading(stringResource(R.string.set_group_help)) }
            item {
                SectionCard(
                    stringResource(R.string.settings_help_feedback),
                    startExpanded = true,
                    icon = Icons.Filled.HelpOutline
                ) {
                    OutlinedButton(onClick = onOpenHelp, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.set_how_to_use))
                    }
                    OutlinedButton(onClick = onOpenFeedback, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.set_send_suggestion))
                    }
                }
            }
            item {
                // Everything above has already saved itself, so this is really
                // "I'm done" -- but the owner asked for Save to save and close,
                // and a settings screen without one leaves people wondering
                // whether anything stuck. It writes once more and leaves, the
                // same as SettingsScreen's.
                Button(
                    onClick = { viewModel.save(local); onBack() },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(stringResource(R.string.settings_save))
                }
            }
            item {
                // Which build this is, for the same reason SettingsScreen shows
                // it: when a crew member reports a problem, the first useful
                // question is which version is on their phone.
                Text(
                    stringResource(
                        R.string.set_version_line,
                        BuildConfig.VERSION_NAME,
                        BuildConfig.VERSION_CODE
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp),
                    textAlign = TextAlign.Center
                )
                // Crew phones need a fix as much as anyone's, and the automatic
                // check only runs when the process starts (see UpdateCheckRow).
                // Only where the app updates itself; a Play build leaves it to
                // the Store.
                if (BuildConfig.SELF_UPDATE) {
                    UpdateCheckRow(modifier = Modifier.fillMaxWidth().padding(bottom = 24.dp))
                }
            }
        }
    }
}
