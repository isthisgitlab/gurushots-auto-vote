package com.isthisgitlab.gurushotsautovote

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * BroadcastReceiver that fires on AlarmManager wake-up and forwards
 * the event into AutoVoteService so the cycle runs in service context
 * with a wakelock. Lives outside the service so AlarmManager can wake
 * us even when the service has been killed and re-instantiated.
 *
 * An alarm that fires after automation was stopped (the stop raced it, or it
 * outlived the process) starts nothing: starting a foreground service obliges
 * it to enter the foreground, which a service that is not wanted should not do.
 */
class AutoVoteAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!ServiceState.isEnabled(context)) return
        val svc = Intent(context, AutoVoteService::class.java).apply {
            action = AutoVoteService.ACTION_RUN_CYCLE
        }
        try {
            context.startForegroundService(svc)
        } catch (e: IllegalStateException) {
            // The system does not let the app start a foreground service right now (on Android 12+ a
            // ForegroundServiceStartNotAllowedException): try again at the next alarm.
            Log.w(AutoVoteService.TAG, "The system refused to start the service (${e.javaClass.simpleName})")
            val saved = ServiceState.status(context)
            ServiceState.record(context, saved.cycleCount, saved.lastRunAt, AutoVoteService.ERROR_FGS_NOT_ALLOWED)
            AutoVoteService.scheduleAlarm(context, AutoVoteService.cycleIntervalMs(context))
        }
    }
}
