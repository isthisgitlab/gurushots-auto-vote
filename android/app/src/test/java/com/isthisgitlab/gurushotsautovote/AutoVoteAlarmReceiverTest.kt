package com.isthisgitlab.gurushotsautovote

import android.app.Application
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class AutoVoteAlarmReceiverTest {

    @Test
    fun forwardsAlarmToServiceAsRunCycle() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        AutoVoteAlarmReceiver().onReceive(app, Intent(AutoVoteService.ACTION_RUN_CYCLE))
        val started = shadowOf(app).nextStartedService
        assertEquals(AutoVoteService::class.java.name, started.component!!.className)
        assertEquals(AutoVoteService.ACTION_RUN_CYCLE, started.action)
    }
}
