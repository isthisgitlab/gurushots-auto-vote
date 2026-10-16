package com.isthisgitlab.gurushotsautovote

import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * Reads the JSON configuration that @capacitor/preferences stores in
 * SharedPreferences. The same document the JS settings module manages on
 * the WebView side; the Service consumes it read-only to get the
 * background cadence and the app's language, which the notification text
 * follows (voting itself runs in the headless WebView, which reads everything
 * else through the JS settings module).
 *
 * Capacitor's Preferences plugin stores values in a SharedPreferences
 * file named "CapacitorStorage" by default, where each key maps to a
 * String value. The configuration is stored under the single key
 * "gurushots-config" (see CONFIG_KEY in src/ts/settings/storage.ts), the two
 * values read here in its `app` object. Until the app window has imported
 * settings.json into it (the first start after an upgrade), the same two values
 * are read from the top level of the settings.json blob under "gurushots-settings".
 */
object AutoVoteSettings {

    private const val TAG = "AutoVoteSettings"
    private const val PREFS_FILE = "CapacitorStorage"
    private const val CONFIG_KEY = "gurushots-config"
    private const val LEGACY_SETTINGS_KEY = "gurushots-settings"
    private const val DEFAULT_CHECK_FREQUENCY_MIN = 3
    private const val DEFAULT_LANGUAGE = "en"
    private val LANGUAGES = setOf("en", "lv")

    /** [language] is one of the app's UI languages ("en" or "lv"). */
    data class Snapshot(
        val normalIntervalSeconds: Long,
        val language: String = DEFAULT_LANGUAGE,
    )

    fun read(context: Context): Snapshot {
        val prefs = context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
        val config = prefs.getString(CONFIG_KEY, null)
        if (!config.isNullOrEmpty()) return parse(config) { it.optJSONObject("app") }
        val legacy = prefs.getString(LEGACY_SETTINGS_KEY, null)
        if (legacy.isNullOrEmpty()) {
            Log.w(TAG, "No persisted settings found; using empty defaults")
            return empty()
        }
        return parse(legacy) { it }
    }

    /** The values of the object [section] picks out of [raw]; the defaults when there is none or [raw] is not JSON. */
    private fun parse(raw: String, section: (JSONObject) -> JSONObject?): Snapshot = try {
        val values = section(JSONObject(raw))
        if (values == null) {
            empty()
        } else {
            Snapshot(
                normalIntervalSeconds = values.optInt("checkFrequencyMin", DEFAULT_CHECK_FREQUENCY_MIN) * 60L,
                language = values.optString("language", DEFAULT_LANGUAGE).takeIf { it in LANGUAGES } ?: DEFAULT_LANGUAGE,
            )
        }
    } catch (t: Throwable) {
        Log.e(TAG, "Failed to parse settings JSON", t)
        empty()
    }

    private fun empty() = Snapshot(normalIntervalSeconds = DEFAULT_CHECK_FREQUENCY_MIN * 60L)
}
