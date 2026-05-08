package com.isthisgitlab.gurushotsautovote

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * BroadcastReceiver that fires on AlarmManager wake-up and forwards
 * the event into AutoVoteService so the cycle runs in service context
 * with a wakelock. Lives outside the service so AlarmManager can wake
 * us even when the service has been killed and re-instantiated.
 */
class AutoVoteAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val svc = Intent(context, AutoVoteService::class.java).apply {
            action = AutoVoteService.ACTION_RUN_CYCLE
        }
        context.startForegroundService(svc)
    }
}
