package com.isthisgitlab.gurushotsautovote

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import com.getcapacitor.Bridge
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class AutoVotePluginTest {

    private lateinit var app: Application
    private lateinit var plugin: AutoVotePlugin

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        val bridge = mockk<Bridge>()
        every { bridge.context } returns app
        plugin = AutoVotePlugin()
        plugin.bridge = bridge
    }

    @After
    fun tearDown() {
        AutoVoteService.isRunning = false
        AutoVoteService.cycleCount = 0
        AutoVoteService.lastRunAtMillis = 0L
        AutoVoteService.lastError = null
    }

    private fun resolved(block: (PluginCall) -> Unit): JSObject {
        val call = mockk<PluginCall>(relaxed = true)
        val result = slot<JSObject>()
        every { call.resolve(capture(result)) } returns Unit
        block(call)
        verify(exactly = 1) { call.resolve(any()) }
        return result.captured
    }

    @Test
    fun startLaunchesForegroundServiceAndResolvesRunning() {
        val ret = resolved { plugin.start(it) }
        assertTrue(ret.getBoolean("running"))
        val started = shadowOf(app).nextStartedService
        assertEquals(AutoVoteService::class.java.name, started.component!!.className)
        assertEquals(AutoVoteService.ACTION_START, started.action)
    }

    @Test
    fun stopSendsStopActionAndResolvesNotRunning() {
        val ret = resolved { plugin.stop(it) }
        assertFalse(ret.getBoolean("running"))
        val started = shadowOf(app).nextStartedService
        assertEquals(AutoVoteService::class.java.name, started.component!!.className)
        assertEquals(AutoVoteService.ACTION_STOP, started.action)
    }

    @Test
    fun getStatusReportsServiceStateWithoutError() {
        AutoVoteService.isRunning = true
        AutoVoteService.cycleCount = 3
        AutoVoteService.lastRunAtMillis = 1234L
        AutoVoteService.lastError = null
        val ret = resolved { plugin.getStatus(it) }
        assertTrue(ret.getBoolean("running"))
        assertEquals(3, ret.getInt("cycleCount"))
        assertEquals(1234L, ret.getLong("lastRunAt"))
        assertEquals("", ret.getString("lastError"))
    }

    @Test
    fun getStatusReportsLastError() {
        AutoVoteService.lastError = "no-token"
        val ret = resolved { plugin.getStatus(it) }
        assertFalse(ret.getBoolean("running"))
        assertEquals("no-token", ret.getString("lastError"))
    }
}
