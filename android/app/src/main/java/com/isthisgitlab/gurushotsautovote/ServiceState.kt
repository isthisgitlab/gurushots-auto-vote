package com.isthisgitlab.gurushotsautovote

import android.content.Context

/**
 * What the background service must remember across process death, in its own SharedPreferences file: whether
 * automation is enabled (set by START, cleared by STOP) and the last status the service reported.
 *
 * The enabled flag is what an alarm acts on. The process may be gone when it fires, and the in-memory flags with it, so
 * a fresh service instance resumes from this flag; a stale alarm (one that fired after a STOP) finds it cleared and
 * lets the service stop at once. The app window's plugin reads the status from here too, so it is right whether or not
 * the service's process is alive.
 */
internal object ServiceState {
    const val PREFS_FILE = "AutoVoteServiceState"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_CYCLE_COUNT = "cycleCount"
    private const val KEY_LAST_RUN_AT = "lastRunAt"
    private const val KEY_LAST_ERROR = "lastError"

    data class Status(val running: Boolean, val cycleCount: Int, val lastRunAt: Long, val lastError: String?)

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)

    fun isEnabled(context: Context): Boolean = prefs(context).getBoolean(KEY_ENABLED, false)

    /** Synchronous: an alarm that fires right after must find the flag as it was set. */
    fun setEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_ENABLED, enabled).commit()
    }

    fun record(context: Context, cycleCount: Int, lastRunAt: Long, lastError: String?) {
        prefs(context).edit()
            .putInt(KEY_CYCLE_COUNT, cycleCount)
            .putLong(KEY_LAST_RUN_AT, lastRunAt)
            .putString(KEY_LAST_ERROR, lastError)
            .apply()
    }

    fun status(context: Context): Status {
        val prefs = prefs(context)
        return Status(
            running = prefs.getBoolean(KEY_ENABLED, false),
            cycleCount = prefs.getInt(KEY_CYCLE_COUNT, 0),
            lastRunAt = prefs.getLong(KEY_LAST_RUN_AT, 0L),
            lastError = prefs.getString(KEY_LAST_ERROR, null),
        )
    }

    /** Forgets everything, the enabled flag included; false when the file could not be written. */
    fun clear(context: Context): Boolean = prefs(context).edit().clear().commit()
}
