package com.fenceestimator.app.ui.components

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.CalendarContract

/**
 * All of these open a pre-filled draft in the user's own email/SMS/calendar
 * app -- Android does not allow (and this app does not attempt) silently
 * sending on the user's behalf. The user always taps Send/Save themselves.
 */
object IntentHelpers {
    /**
     * Opens an email draft. Returns whether it actually opened, because a
     * caller that stamps "sent" or "told" the moment it fires, without
     * checking, records that on a phone with no mail app configured -- where
     * nothing opened at all.
     */
    fun openEmailDraft(context: Context, to: String, subject: String, body: String): Boolean {
        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:")).apply {
            putExtra(Intent.EXTRA_EMAIL, arrayOf(to))
            putExtra(Intent.EXTRA_SUBJECT, subject)
            putExtra(Intent.EXTRA_TEXT, body)
        }
        return runCatching {
            context.startActivity(Intent.createChooser(intent, "Send Email"))
        }.isSuccess
    }

    /**
     * Hands text to whatever the person actually uses.
     *
     * Email and SMS both assume you know how this customer wants to be reached,
     * and half the time you do not -- they message on WhatsApp, or the number
     * on file is a landline. The share sheet lets the person holding the phone
     * decide, which is the only one who knows.
     */
    fun shareText(context: Context, subject: String, body: String, chooserTitle: String) {
        val intent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
            type = "text/plain"
            if (subject.isNotBlank()) putExtra(android.content.Intent.EXTRA_SUBJECT, subject)
            putExtra(android.content.Intent.EXTRA_TEXT, body)
        }
        context.startActivity(android.content.Intent.createChooser(intent, chooserTitle))
    }

    /**
     * Opens the dialler with a number ready, without placing the call.
     *
     * ACTION_DIAL rather than ACTION_CALL on purpose: dialling needs no
     * permission and leaves the last tap to the person, which is right for a
     * number an app decided to ring.
     */
    fun dial(context: Context, phone: String) {
        runCatching {
            context.startActivity(
                android.content.Intent(
                    android.content.Intent.ACTION_DIAL,
                    android.net.Uri.parse("tel:" + phone)
                ).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }
    }

    /**
     * Opens a texting-app draft. Returns whether it actually opened -- a
     * device with nothing registered for smsto: throws instead of doing
     * nothing, and a caller that stamps a record on the throw would claim a
     * text was sent when no app even opened.
     */
    fun openSmsDraft(context: Context, phone: String, body: String): Boolean {
        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:$phone")).apply {
            putExtra("sms_body", body)
        }
        return runCatching { context.startActivity(intent) }.isSuccess
    }

    fun addToCalendar(context: Context, title: String, description: String, location: String, startMillis: Long, durationHours: Double = 4.0) {
        val durationMillis = (durationHours.coerceAtLeast(0.25) * 60 * 60 * 1000).toLong()
        val intent = Intent(Intent.ACTION_INSERT).apply {
            data = CalendarContract.Events.CONTENT_URI
            putExtra(CalendarContract.Events.TITLE, title)
            putExtra(CalendarContract.Events.DESCRIPTION, description)
            putExtra(CalendarContract.Events.EVENT_LOCATION, location)
            putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startMillis)
            putExtra(CalendarContract.EXTRA_EVENT_END_TIME, startMillis + durationMillis)
            putExtra(CalendarContract.Events.ALL_DAY, false)
        }
        context.startActivity(intent)
    }

    /**
     * Opens a "near me" search in the user's maps app -- no API key, no
     * location permission needed on our side, since the maps app resolves
     * "near me" using its own location access.
     */
    /**
     * Opens turn-by-turn directions through several stops in the order given.
     * Google Maps takes waypoints via the dir/ URL form; there's no intent
     * equivalent, so this deliberately uses the web URL, which the Maps app
     * intercepts when installed.
     */
    fun routeThrough(context: Context, addresses: List<String>) {
        val stops = addresses.filter { it.isNotBlank() }
        if (stops.isEmpty()) return
        val destination = Uri.encode(stops.last())
        val waypoints = stops.dropLast(1).joinToString("|") { Uri.encode(it) }
        val url = buildString {
            append("https://www.google.com/maps/dir/?api=1&destination=$destination")
            if (waypoints.isNotEmpty()) append("&waypoints=$waypoints")
            append("&travelmode=driving")
        }
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }

    /**
     * Opens a plain web link. Returns whether it actually opened.
     *
     * This is the one every reference-link button on the help screen goes
     * through: a foreman looking up a pool-barrier code in the field is on
     * whatever browser the phone has, and a device with none configured must
     * not take the whole screen down with an uncaught ActivityNotFoundException.
     */
    fun openWebLink(context: Context, url: String): Boolean =
        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }.isSuccess

    fun searchNearby(context: Context, query: String) {
        val encoded = Uri.encode(query)
        val geoIntent = Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=$encoded"))
        if (geoIntent.resolveActivity(context.packageManager) != null) {
            context.startActivity(geoIntent)
        } else {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.google.com/maps/search/$encoded")))
        }
    }
}
