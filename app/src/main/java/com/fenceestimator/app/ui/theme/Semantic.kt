package com.fenceestimator.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * The meanings the Material palette has no word for.
 *
 * Material gives us primary, secondary, tertiary and error. A fencing job
 * needs more than that: money that came in is good, a quote gone quiet is a
 * warning, an overrun is serious, and a chart needs four series that stay
 * apart from each other and from all of the above. Every screen that needed
 * one of those invented it on the spot, so the app ended up with the same
 * red typed twice in two files, a green that means "paid" on one screen and
 * nothing on another, and -- the actual bug -- a set of pale mint and pink
 * chips that were only ever chosen against a white card and stayed pale
 * when the phone went dark.
 *
 * So: named once, defined for both themes, reached through
 * `MaterialTheme.semantic`. A colour that carries meaning belongs here; a
 * colour that decorates a drawing belongs in [PlanColors]; everything else
 * is Material's.
 *
 * Contrast: every `on*` value is chosen against its own container, and every
 * base value against the theme's surface. Colour is never the only carrier --
 * status also has a word, a chart bar also has a printed value.
 */
@Immutable
data class SemanticColors(
    /** Money in, a job won, a shift approved, anything finished cleanly. */
    val success: Color,
    val successContainer: Color,
    val onSuccessContainer: Color,

    /** Needs a person soon: a quiet quote, an unapproved shift, a thin margin. */
    val warning: Color,
    val warningContainer: Color,
    val onWarningContainer: Color,

    /**
     * Something is wrong and it costs money or time: an overrun, an expired
     * locate, a declined quote. Distinct from Material's `error`, which
     * stays reserved for a control that failed or an action that destroys.
     */
    val danger: Color,
    val dangerContainer: Color,
    val onDangerContainer: Color,

    /** Neutral fact worth noticing. Never used for a state that needs action. */
    val info: Color,
    val infoContainer: Color,
    val onInfoContainer: Color,

    /**
     * The four chart series, in fixed order. Assigned by what the series IS,
     * never by its rank in the data, so a filter that drops a series does not
     * repaint the survivors.
     */
    val chartMoney: Color,
    val chartCost: Color,
    val chartSales: Color,
    val chartCrew: Color,
) {
    /** The pair a status pill wears: container behind, ink on top. */
    fun containerFor(kind: SemanticKind): Pair<Color, Color> = when (kind) {
        SemanticKind.SUCCESS -> successContainer to onSuccessContainer
        SemanticKind.WARNING -> warningContainer to onWarningContainer
        SemanticKind.DANGER -> dangerContainer to onDangerContainer
        SemanticKind.INFO -> infoContainer to onInfoContainer
    }

    /** The single colour a stripe, dot or bar wears. */
    fun baseFor(kind: SemanticKind): Color = when (kind) {
        SemanticKind.SUCCESS -> success
        SemanticKind.WARNING -> warning
        SemanticKind.DANGER -> danger
        SemanticKind.INFO -> info
    }
}

enum class SemanticKind { SUCCESS, WARNING, DANGER, INFO }

/**
 * Light. Bases are dark enough to read as text on white; containers are pale
 * enough to sit under their own ink at better than 7:1.
 */
internal val LightSemantics = SemanticColors(
    success = Color(0xFF0B6B4F),
    successContainer = Color(0xFFE6F6F1),
    onSuccessContainer = Color(0xFF07452F),

    warning = Color(0xFF8A5200),
    warningContainer = Color(0xFFFDEED8),
    onWarningContainer = Color(0xFF5C3600),

    danger = Color(0xFF8C1114),
    dangerContainer = Color(0xFFFBD3D4),
    onDangerContainer = Color(0xFF6B0C0F),

    info = Color(0xFF14508F),
    infoContainer = Color(0xFFE1EDFB),
    onInfoContainer = Color(0xFF0D3765),

    chartMoney = Color(0xFF2A78D6),
    chartCost = Color(0xFFEB6834),
    chartSales = Color(0xFF1BAF7A),
    chartCrew = Color(0xFFEDA100),
)

/**
 * Dark. Not an inversion: the bases are lifted until they read on graphite,
 * and the containers are deep tints of their own hue rather than the light
 * theme's pale washes, which turned into bright patches on a dark card.
 */
internal val DarkSemantics = SemanticColors(
    success = Color(0xFF4FD1B0),
    successContainer = Color(0xFF123029),
    onSuccessContainer = Color(0xFF8FE7D0),

    warning = Color(0xFFF2B544),
    warningContainer = Color(0xFF3A2B12),
    onWarningContainer = Color(0xFFFAD79A),

    danger = Color(0xFFFF8A80),
    dangerContainer = Color(0xFF3E1A1A),
    onDangerContainer = Color(0xFFFFBDB6),

    info = Color(0xFF7FB6F0),
    infoContainer = Color(0xFF12263D),
    onInfoContainer = Color(0xFFB6D6F7),

    chartMoney = Color(0xFF5FA8F0),
    chartCost = Color(0xFFFF8A5C),
    chartSales = Color(0xFF3FD1A0),
    chartCrew = Color(0xFFF0B840),
)

internal val LocalSemanticColors = staticCompositionLocalOf { LightSemantics }

/**
 * `MaterialTheme.semantic.success` reads the way `MaterialTheme.colorScheme.primary`
 * does, so nobody has to remember a second import to reach a colour.
 */
val MaterialTheme.semantic: SemanticColors
    @Composable @ReadOnlyComposable get() = LocalSemanticColors.current
