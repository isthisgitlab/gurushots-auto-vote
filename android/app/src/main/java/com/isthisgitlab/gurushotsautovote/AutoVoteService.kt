package com.isthisgitlab.gurushotsautovote

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Foreground Service that owns the native background voting loop.
 *
 * Lifecycle:
 *   ACTION_START — promote to foreground with persistent notification,
 *                  schedule the first alarm via AlarmManager. Returns
 *                  START_STICKY so the OS restarts us if killed.
 *   ACTION_RUN_CYCLE — fired by AutoVoteAlarmReceiver. Acquires a
 *                  wakelock, runs one voting cycle, updates the
 *                  notification, schedules the next alarm.
 *   ACTION_STOP — cancel pending alarm, stop foreground, stop self.
 *
 * The Service runs whether the WebView / Activity is alive or not,
 * which is the whole point of this plugin.
 */
class AutoVoteService : Service() {

    companion object {
        const val TAG = "AutoVoteService"
        const val ACTION_START = "com.isthisgitlab.gurushotsautovote.START"
        const val ACTION_STOP = "com.isthisgitlab.gurushotsautovote.STOP"
        const val ACTION_RUN_CYCLE = "com.isthisgitlab.gurushotsautovote.RUN_CYCLE"
        const val NOTIFICATION_ID = 27782
        const val CHANNEL_ID = "autovote-foreground"

        @Volatile var isRunning: Boolean = false
        @Volatile var cycleCount: Int = 0
        @Volatile var lastRunAtMillis: Long = 0L
        @Volatile var lastError: String? = null

        private const val DEFAULT_CYCLE_INTERVAL_MS = 3L * 60L * 1000L
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var cycleJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> handleStart()
            ACTION_RUN_CYCLE -> handleRunCycle()
            ACTION_STOP -> {
                handleStop()
                return START_NOT_STICKY
            }
        }
        return START_STICKY
    }

    private fun handleStart() {
        if (isRunning) {
            Log.i(TAG, "handleStart called but service already running")
            return
        }
        isRunning = true
        cycleCount = 0
        lastError = null
        startForegroundNotification("Auto-vote starting…")
        scheduleNextAlarm(initial = true)
    }

    private fun handleRunCycle() {
        if (!isRunning) {
            Log.i(TAG, "RUN_CYCLE received but service not in running state — ignoring")
            return
        }
        // Run the cycle on an IO coroutine. We allow a fresh job per
        // alarm tick; the previous job is cancelled to avoid overlap
        // if a previous cycle is still in flight when the next alarm
        // fires (rare but possible on slow networks).
        cycleJob?.cancel()
        cycleJob = scope.launch {
            val wakeLock = acquireWakelock()
            try {
                val started = System.currentTimeMillis()
                Log.i(TAG, "Cycle ${cycleCount + 1} starting")
                val result = withContext(Dispatchers.IO) {
                    AutoVoteCycle.run(this@AutoVoteService)
                }
                cycleCount += 1
                lastRunAtMillis = System.currentTimeMillis()
                lastError = result.error
                val durationMs = lastRunAtMillis - started
                val statusText = formatStatus(result, durationMs)
                updateNotification(statusText)
                Log.i(TAG, "Cycle $cycleCount done: $statusText")
            } catch (t: Throwable) {
                lastError = t.message ?: t.javaClass.simpleName
                updateNotification("Last cycle error: $lastError")
                Log.e(TAG, "Cycle threw", t)
            } finally {
                wakeLock?.release()
                if (isRunning) scheduleNextAlarm(initial = false)
            }
        }
    }

    private fun handleStop() {
        isRunning = false
        cycleJob?.cancel()
        cancelPendingAlarm()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        cycleJob?.cancel()
        super.onDestroy()
    }

    // ---------- AlarmManager ----------

    private fun alarmIntent(): PendingIntent {
        val intent = Intent(this, AutoVoteAlarmReceiver::class.java).apply {
            action = ACTION_RUN_CYCLE
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        return PendingIntent.getBroadcast(this, 0, intent, flags)
    }

    private fun cycleIntervalMs(): Long {
        // Read checkFrequencyMin from the persisted settings JSON.
        // Fall back to 3 minutes on parse error so a corrupted settings
        // store does not silently stop voting.
        val configured = AutoVoteSettings.read(this).normalIntervalSeconds
        return if (configured > 0) configured * 1000L else DEFAULT_CYCLE_INTERVAL_MS
    }

    private fun scheduleNextAlarm(initial: Boolean) {
        val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val triggerAt = System.currentTimeMillis() + if (initial) 1_000L else cycleIntervalMs()
        try {
            // setExactAndAllowWhileIdle is the only Android primitive
            // that pierces Doze for sub-15-min cadence. Android 12+
            // requires SCHEDULE_EXACT_ALARM permission; if the user
            // has not granted it, fall back to setAndAllowWhileIdle
            // which is best-effort but does not throw.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, alarmIntent())
            } else {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, alarmIntent())
            }
        } catch (sec: SecurityException) {
            // Some OEMs revoke exact-alarm permission silently. Fall back.
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, alarmIntent())
        }
    }

    private fun cancelPendingAlarm() {
        val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        am.cancel(alarmIntent())
    }

    // ---------- Notification ----------

    private fun ensureNotificationChannel() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Auto-vote",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Persistent notification while auto-vote is running in the background."
                setShowBadge(false)
            }
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String): Notification {
        val openAppIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val openAppPi = openAppIntent?.let {
            PendingIntent.getActivity(this, 1, it, pendingFlags)
        }

        val stopIntent = Intent(this, AutoVoteService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPi = PendingIntent.getService(this, 2, stopIntent, pendingFlags)

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("GuruShots Auto Vote")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_rotate)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(openAppPi)
            .addAction(
                android.R.drawable.ic_delete,
                "Stop",
                stopPi,
            )
            .build()
    }

    private fun startForegroundNotification(text: String) {
        val notification = buildNotification(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun formatStatus(result: AutoVoteCycle.Result, durationMs: Long): String {
        val time = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        return if (result.error != null) {
            "Last error at $time: ${result.error}"
        } else {
            "Voted ${result.votedCount} of ${result.processedCount} at $time (${durationMs}ms)"
        }
    }

    private fun acquireWakelock(): PowerManager.WakeLock? {
        return try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            val wl = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "GuruShotsAutoVote::CycleWakelock",
            )
            wl.setReferenceCounted(false)
            wl.acquire(60_000L) // 1-minute upper bound; cycle should be much faster
            wl
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to acquire wakelock", t)
            null
        }
    }
}
