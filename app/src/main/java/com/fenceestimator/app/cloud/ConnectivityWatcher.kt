package com.fenceestimator.app.cloud

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Watches for the network coming back, and syncs the moment it does.
 *
 * Fence work happens in yards, at the far end of properties, in places with
 * one bar. Everything the crew does is written to the phone first and uploaded
 * afterwards, but "afterwards" used to mean the next heartbeat -- up to fifteen
 * minutes after they were back on signal, and never at all if they closed the
 * app in between. Reacting to the network itself closes that window.
 */
class ConnectivityWatcher(
    private val context: Context,
    private val onBackOnline: () -> Unit
) {
    private val _online = MutableStateFlow(true)
    /** Whether the phone currently has a usable internet connection. */
    val online: StateFlow<Boolean> = _online

    private var callback: ConnectivityManager.NetworkCallback? = null

    fun start() {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return

        _online.value = hasInternet(manager)

        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()

        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                // Only act on the transition. Android fires onAvailable for each
                // network that appears -- WiFi arriving while mobile data is
                // already up would otherwise trigger a redundant sync.
                if (!_online.value) {
                    _online.value = true
                    onBackOnline()
                } else {
                    _online.value = true
                }
            }

            override fun onLost(network: Network) {
                _online.value = hasInternet(manager)
            }

            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                // Connected to a network is not the same as being able to reach
                // anything -- a captive-portal hotspot is "available" and still
                // useless. VALIDATED is what actually means the internet works.
                val usable = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                    caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                if (usable && !_online.value) {
                    _online.value = true
                    onBackOnline()
                }
            }
        }

        // Registering can throw if the app is restricted from network callbacks;
        // failing here must never stop the app from working offline.
        runCatching {
            manager.registerNetworkCallback(request, cb)
            callback = cb
        }
    }

    fun stop() {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        callback?.let { cb -> runCatching { manager?.unregisterNetworkCallback(cb) } }
        callback = null
    }

    private fun hasInternet(manager: ConnectivityManager): Boolean {
        val caps = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }
}
