package com.isthisgitlab.gurushotsautovote

import android.app.AlarmManager
import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowAlarmManager

@RunWith(RobolectricTestRunner::class)
class AutoVoteAlarmReceiverTest {

    private lateinit var app: Application

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        ShadowAlarmManager.setCanScheduleExactAlarms(true)
    }

    @Test
    fun forwardsAlarmToServiceAsRunCycleWhileAutomationIsEnabled() {
        ServiceState.setEnabled(app, true)
        AutoVoteAlarmReceiver().onReceive(app, Intent(AutoVoteService.ACTION_RUN_CYCLE))
        val started = shadowOf(app).nextStartedService
        assertEquals(AutoVoteService::class.java.name, started.component!!.className)
        assertEquals(AutoVoteService.ACTION_RUN_CYCLE, started.action)
    }

    @Test
    fun aStaleAlarmAfterStopStartsNothing() {
        ServiceState.setEnabled(app, false)
        AutoVoteAlarmReceiver().onReceive(app, Intent(AutoVoteService.ACTION_RUN_CYCLE))
        assertNull(shadowOf(app).nextStartedService)
    }

    @Test
    fun aServiceStartTheSystemRefusesIsRetriedAtTheNextAlarmAndRecorded() {
        ServiceState.setEnabled(app, true)
        ServiceState.record(app, 4, 99L, null)
        TestSupport.writeConfig(app, """{"app":{"checkFrequencyMin":5}}""")
        val refusing = object : ContextWrapper(app) {
            override fun startForegroundService(service: Intent?): ComponentName? =
                throw IllegalStateException("not allowed to start service Intent")
        }

        AutoVoteAlarmReceiver().onReceive(refusing, Intent(AutoVoteService.ACTION_RUN_CYCLE))

        assertNull(shadowOf(app).nextStartedService)
        val status = ServiceState.status(app)
        assertTrue(status.running)
        assertEquals(4, status.cycleCount)
        assertEquals(99L, status.lastRunAt)
        assertEquals(AutoVoteService.ERROR_FGS_NOT_ALLOWED, status.lastError)
        val alarm = shadowOf(app.getSystemService(Context.ALARM_SERVICE) as AlarmManager).peekNextScheduledAlarm()!!
        val delta = alarm.triggerAtMs - System.currentTimeMillis()
        assertTrue("expected ~5 min, got $delta", delta in (5 * 60_000L - 1_000)..(5 * 60_000L))
    }
}
