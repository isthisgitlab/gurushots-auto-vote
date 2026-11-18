package com.isthisgitlab.gurushotsautovote

import android.app.AlarmManager
import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowAlarmManager
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
class AutoVoteAlarmReceiverTest {

    private lateinit var app: Application

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        ShadowAlarmManager.setCanScheduleExactAlarms(true)
        SideStores.resume()
        ShadowLog.clear()
    }

    @After
    fun tearDown() {
        ServiceState.clear(app)
        app.getSharedPreferences(SideStores.PREFS_FILE, Context.MODE_PRIVATE).edit().clear().commit()
    }

    /** The alarm as AlarmManager delivers it: carrying the Stop epoch it was scheduled under (none: [stamp] null). */
    private fun alarm(stamp: Long? = 0L) = Intent(AutoVoteService.ACTION_RUN_CYCLE).apply {
        stamp?.let { putExtra(AutoVoteService.EXTRA_STOP_EPOCH, it) }
    }

    private fun storeFence(raw: String) =
        app.getSharedPreferences(SideStores.PREFS_FILE, Context.MODE_PRIVATE).edit().putString(StopFence.KEY, raw).commit()

    private fun refusals() = ShadowLog.getLogsForTag(AutoVoteService.TAG).map { it.msg }

    @Test
    fun forwardsAlarmToServiceAsRunCycleWhileAutomationIsEnabled() {
        ServiceState.setEnabled(app, true)
        AutoVoteAlarmReceiver().onReceive(app, alarm())
        val started = shadowOf(app).nextStartedService
        assertEquals(AutoVoteService::class.java.name, started.component!!.className)
        assertEquals(AutoVoteService.ACTION_RUN_CYCLE, started.action)
        // The epoch travels on to the service, which checks it again.
        assertEquals(0L, started.getLongExtra(AutoVoteService.EXTRA_STOP_EPOCH, AutoVoteService.NO_EPOCH))
    }

    @Test
    fun anAlarmOfTheEpochTheFenceIsAtRuns() {
        ServiceState.setEnabled(app, true)
        storeFence("""{"stopEpoch":4,"blocked":false,"lastStop":null,"lastArm":null}""")
        AutoVoteAlarmReceiver().onReceive(app, alarm(4L))
        val started = shadowOf(app).nextStartedService
        assertEquals(4L, started.getLongExtra(AutoVoteService.EXTRA_STOP_EPOCH, AutoVoteService.NO_EPOCH))
    }

    @Test
    fun aStaleAlarmAfterStopStartsNothing() {
        ServiceState.setEnabled(app, false)
        AutoVoteAlarmReceiver().onReceive(app, alarm())
        assertNull(shadowOf(app).nextStartedService)
    }

    @Test
    fun anAlarmDelayedPastAStopBuildsNoWorkAndSchedulesNothing() {
        // The alarm was scheduled under epoch 0; the Stop recorded epoch 1 and blocked the fence. Even a service flag that
        // still says enabled (the Stop raced it) does not let the delivery start the service.
        ServiceState.setEnabled(app, true)
        assertTrue(StopFence.recordStop(app, "stop-a", 1L).durable)
        AutoVoteAlarmReceiver().onReceive(app, alarm(0L))
        assertNull(shadowOf(app).nextStartedService)
        assertNull(shadowOf(app.getSystemService(Context.ALARM_SERVICE) as AlarmManager).peekNextScheduledAlarm())
        assertEquals(listOf("Alarm refused: its Stop epoch is not the live one"), refusals())
        // The delivery decides nothing about the flag: a newer run's status is not touched.
        assertTrue(ServiceState.isEnabled(app))
    }

    @Test
    fun anAlarmOfAnEarlierRunIsRefusedWhileANewerRunHoldsTheFence() {
        // Stop, then the user's Run: the fence is open again, at epoch 1. The old run's alarm still carries epoch 0.
        ServiceState.setEnabled(app, true)
        storeFence("""{"stopEpoch":1,"blocked":false,"lastStop":{"requestId":"a","at":1,"durable":true},"lastArm":null}""")
        AutoVoteAlarmReceiver().onReceive(app, alarm(0L))
        assertNull(shadowOf(app).nextStartedService)
        assertEquals(listOf("Alarm refused: its Stop epoch is not the live one"), refusals())
        assertTrue(ServiceState.isEnabled(app))
    }

    @Test
    fun anAlarmWithNoEpochIsNeverALiveOne() {
        ServiceState.setEnabled(app, true)
        AutoVoteAlarmReceiver().onReceive(app, alarm(null))
        assertNull(shadowOf(app).nextStartedService)
        assertEquals(1, refusals().size)
    }

    @Test
    fun anAlarmOnAFenceThatCannotBeReadBuildsNoWork() {
        ServiceState.setEnabled(app, true)
        storeFence("""{"stopEpoch":0,"blocked":"?","lastStop":null,"lastArm":null}""")
        AutoVoteAlarmReceiver().onReceive(app, alarm(0L))
        assertNull(shadowOf(app).nextStartedService)
        assertEquals(1, refusals().size)
    }

    @Test
    @Suppress("DEPRECATION") // ScheduledAlarm exposes operation only as a (deprecated) field.
    fun aServiceStartTheSystemRefusesIsRetriedAtTheNextAlarmAndRecorded() {
        ServiceState.setEnabled(app, true)
        ServiceState.record(app, 4, 99L, null)
        TestSupport.writeConfig(app, """{"app":{"checkFrequencyMin":5}}""")
        val refusing = object : ContextWrapper(app) {
            override fun startForegroundService(service: Intent?): ComponentName? =
                throw IllegalStateException("not allowed to start service Intent")
        }

        AutoVoteAlarmReceiver().onReceive(refusing, alarm(0L))

        assertNull(shadowOf(app).nextStartedService)
        val status = ServiceState.status(app)
        assertTrue(status.running)
        assertEquals(4, status.cycleCount)
        assertEquals(99L, status.lastRunAt)
        assertEquals(AutoVoteService.ERROR_FGS_NOT_ALLOWED, status.lastError)
        val alarm = shadowOf(app.getSystemService(Context.ALARM_SERVICE) as AlarmManager).peekNextScheduledAlarm()!!
        val delta = alarm.triggerAtMs - System.currentTimeMillis()
        assertTrue("expected ~5 min, got $delta", delta in (5 * 60_000L - 1_000)..(5 * 60_000L))
        // The retry carries the epoch the refused alarm held.
        assertEquals(0L, shadowOf(alarm.operation).savedIntent.getLongExtra(AutoVoteService.EXTRA_STOP_EPOCH, AutoVoteService.NO_EPOCH))
    }
}
