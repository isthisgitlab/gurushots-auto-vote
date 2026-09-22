package com.isthisgitlab.gurushotsautovote

import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * Reads the JSON settings blob that @capacitor/preferences stores in
 * SharedPreferences. The same blob the JS settings module manages on
 * the WebView side; the Service consumes it read-only to get the
 * background cadence (voting itself runs in the headless WebView, which
 * reads everything else through the JS settings module).
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
    private const val DEFAULT_CHECK_FREQUENCY_MIN = 3

    data class Snapshot(
        val normalIntervalSeconds: Long,
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
            Snapshot(
                normalIntervalSeconds = json.optInt("checkFrequencyMin", DEFAULT_CHECK_FREQUENCY_MIN) * 60L,
            )
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to parse settings JSON", t)
            empty()
        }
    }

    private fun empty() = Snapshot(normalIntervalSeconds = DEFAULT_CHECK_FREQUENCY_MIN * 60L)
}
