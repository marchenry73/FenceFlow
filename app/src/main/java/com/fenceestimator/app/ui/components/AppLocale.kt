package com.fenceestimator.app.ui.components

import android.content.Context
import android.content.ContextWrapper
import android.content.res.Configuration
import android.content.res.Resources
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import com.fenceestimator.app.data.AppLanguage
import java.util.Locale

/**
 * A context that speaks the chosen language but is still, underneath, the
 * Activity.
 *
 * This matters more than it looks. The obvious implementation --
 * `context.createConfigurationContext(config)` -- returns a bare ContextImpl
 * with no link back to the Activity. Compose finds the Activity by walking
 * the ContextWrapper chain (that's how rememberLauncherForActivityResult
 * locates the result registry), so handing it an unlinked context makes every
 * screen that opens a file picker or camera crash on entry.
 *
 * Keeping the Activity as the wrapper's base preserves that chain, and
 * overriding only getResources() is enough to localise the UI.
 */
private class LocalizedContext(
    base: Context,
    private val localizedResources: Resources
) : ContextWrapper(base) {
    override fun getResources(): Resources = localizedResources
}

/**
 * Applies the user's chosen language to everything drawn inside [content],
 * without changing the device language -- FenceFlow can be in Spanish while
 * the rest of the phone stays in English. Arabic also flips layout direction
 * so the interface mirrors rather than just showing translated text in a
 * left-to-right layout.
 */
@Composable
fun WithAppLanguage(language: AppLanguage, content: @Composable () -> Unit) {
    val context = LocalContext.current
    val configuration = LocalConfiguration.current

    val localizedContext = remember(context, language, configuration) {
        val locale = Locale.forLanguageTag(language.tag)
        val config = Configuration(configuration).apply { setLocale(locale) }
        val resources = context.createConfigurationContext(config).resources
        LocalizedContext(context, resources)
    }

    CompositionLocalProvider(
        LocalContext provides localizedContext,
        LocalLayoutDirection provides if (language.rtl) LayoutDirection.Rtl else LayoutDirection.Ltr
    ) {
        content()
    }
}
