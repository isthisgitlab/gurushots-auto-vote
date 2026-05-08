package com.isthisgitlab.gurushotsautovote

import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * Reads the JSON settings blob that @capacitor/preferences stores in
 * SharedPreferences. The same blob the JS settings module manages on
 * the WebView side; the Service consumes it read-only at cycle start
 * to get the auth token, the spoofed-iOS header bag, and the cadence
 * configuration.
 *
 * Capacitor's Preferences plugin stores values in a SharedPreferences
 * file named "CapacitorStorage" by default, where each key maps to a
 * String value. Our entire settings JSON is stored under the single
 * key "gurushots-settings" (see SETTINGS_KEY in src/js/settings.js).
 */
object AutoVoteSettings {

    private const val TAG = "AutoVoteSettings"
    private const val PREFS_FILE = "CapacitorStorage"
    private const val SETTINGS_KEY = "gurushots-settings"

    data class Snapshot(
        val token: String,
        val mockMode: Boolean,
        val apiHeaders: Map<String, String>,
        val normalIntervalSeconds: Long,
        val lastMinuteIntervalSeconds: Long,
        val lastMinuteThresholdSeconds: Long,
        val exposureTarget: Int,
    )

    fun read(context: Context): Snapshot {
        val prefs = context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
        val raw = prefs.getString(SETTINGS_KEY, null)
        if (raw.isNullOrEmpty()) {
            Log.w(TAG, "No persisted settings found; using empty defaults")
            return empty()
        }
        return try {
            val json = JSONObject(raw)
            val headers = readHeaders(json)
            Snapshot(
                token = json.optString("token", ""),
                mockMode = json.optBoolean("mock", false),
                apiHeaders = headers,
                normalIntervalSeconds = json.optInt("checkFrequencyMin", 3) * 60L,
                lastMinuteIntervalSeconds = readGlobal(json, "lastMinuteCheckFrequency", 1) * 60L,
                lastMinuteThresholdSeconds = readGlobal(json, "lastMinuteThreshold", 10) * 60L,
                exposureTarget = readGlobal(json, "exposure", 100),
            )
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to parse settings JSON", t)
            empty()
        }
    }

    private fun readGlobal(root: JSONObject, key: String, default: Int): Int {
        return root.optJSONObject("challengeSettings")
            ?.optJSONObject("globalDefaults")
            ?.optInt(key, default)
            ?: default
    }

    private fun readHeaders(root: JSONObject): Map<String, String> {
        val obj = root.optJSONObject("apiHeaders") ?: return emptyMap()
        val out = mutableMapOf<String, String>()
        val it = obj.keys()
        while (it.hasNext()) {
            val key = it.next()
            // Skip the internal _version field used by JS to detect
            // app upgrades; the JS side regenerates if missing.
            if (key.startsWith("_")) continue
            val value = obj.optString(key, "")
            if (value.isNotEmpty()) out[key] = value
        }
        return out
    }

    private fun empty() = Snapshot(
        token = "",
        mockMode = false,
        apiHeaders = emptyMap(),
        normalIntervalSeconds = 180L,
        lastMinuteIntervalSeconds = 60L,
        lastMinuteThresholdSeconds = 600L,
        exposureTarget = 100,
    )
}
