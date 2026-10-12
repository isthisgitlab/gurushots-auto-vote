package com.isthisgitlab.gurushotsautovote

import android.app.AlarmManager
import android.app.Application
import android.content.Context
import android.os.Looper
import android.webkit.WebStorage
import androidx.test.core.app.ApplicationProvider
import com.getcapacitor.Bridge
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkStatic
import io.mockk.slot
import io.mockk.unmockkStatic
import io.mockk.verify
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowAlarmManager
import java.io.File

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
        ServiceState.clear(app)
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
    fun getStatusReportsThePersistedStateNotTheProcessStatics() {
        ServiceState.setEnabled(app, true)
        ServiceState.record(app, 3, 1234L, null)
        // The statics a restarted process starts from say nothing is running.
        AutoVoteService.isRunning = false
        AutoVoteService.cycleCount = 0
        val ret = resolved { plugin.getStatus(it) }
        assertTrue(ret.getBoolean("running"))
        assertEquals(3, ret.getInt("cycleCount"))
        assertEquals(1234L, ret.getLong("lastRunAt"))
        assertEquals("", ret.getString("lastError"))
    }

    @Test
    fun getStatusOfAFreshInstallIsNotRunning() {
        val ret = resolved { plugin.getStatus(it) }
        assertFalse(ret.getBoolean("running"))
        assertEquals(0, ret.getInt("cycleCount"))
        assertEquals(0L, ret.getLong("lastRunAt"))
        assertEquals("", ret.getString("lastError"))
    }

    @Test
    fun compareAndWriteSavesOnlyWhileTheStoreHoldsWhatTheWindowRead() {
        val saved = resolved {
            every { it.getString("key") } returns "gs_join_state"
            every { it.getString("expected") } returns null
            every { it.getString("value") } returns "{\"a\":1}"
            plugin.compareAndWrite(it)
        }
        assertTrue(saved.getBoolean("saved"))
        val lost = resolved {
            every { it.getString("key") } returns "gs_join_state"
            every { it.getString("expected") } returns null
            every { it.getString("value") } returns "{\"b\":1}"
            plugin.compareAndWrite(it)
        }
        assertFalse(lost.getBoolean("saved"))
        assertEquals("{\"a\":1}", lost.getString("current"))
        val matched = resolved {
            every { it.getString("key") } returns "gs_join_state"
            every { it.getString("expected") } returns "{\"a\":1}"
            every { it.getString("value") } returns "{\"a\":1,\"b\":1}"
            plugin.compareAndWrite(it)
        }
        assertTrue(matched.getBoolean("saved"))
    }

    @Test
    fun compareAndWriteAnswersCurrentAsJsonNullNotTheTextNullWhenNothingIsStored() {
        val lost = resolved {
            every { it.getString("key") } returns "gs_join_state"
            every { it.getString("expected") } returns "{\"a\":1}"
            every { it.getString("value") } returns "{\"b\":1}"
            plugin.compareAndWrite(it)
        }
        assertFalse(lost.getBoolean("saved"))
        assertTrue(lost.has("current"))
        assertTrue(lost.isNull("current"))
        assertSame(JSONObject.NULL, lost.get("current"))
    }

    @Test
    fun compareAndWriteRejectsWhatIsNotASideStoreOrNotAValidValue() {
        fun rejected(key: String?, value: String?) {
            val call = mockk<PluginCall>(relaxed = true)
            every { call.getString("key") } returns key
            every { call.getString("value") } returns value
            every { call.getString("expected") } returns null
            plugin.compareAndWrite(call)
            verify(exactly = 1) { call.reject(any<String>()) }
            verify(exactly = 0) { call.resolve(any()) }
        }
        rejected(null, "{}")
        rejected("gs_join_state", null)
        rejected("gurushots-settings", "{}")
        rejected("gs_join_state", "[1]")
        rejected("gs_join_state", "{} trailing")
    }

    @Test
    fun getStatusReportsLastError() {
        ServiceState.record(app, 0, 0L, "no-token")
        val ret = resolved { plugin.getStatus(it) }
        assertFalse(ret.getBoolean("running"))
        assertEquals("no-token", ret.getString("lastError"))
    }

    // ---------- wipeLocalData ----------

    private fun alarms() = shadowOf(app.getSystemService(Context.ALARM_SERVICE) as AlarmManager).scheduledAlarms

    private fun wiped(): JSObject {
        val call = mockk<PluginCall>(relaxed = true)
        val result = slot<JSObject>()
        every { call.resolve(capture(result)) } returns Unit
        plugin.wipeLocalData(call)
        shadowOf(Looper.getMainLooper()).idle()
        verify(exactly = 1) { call.resolve(any()) }
        return result.captured
    }

    @Test
    fun wipeLocalDataStopsTheServiceAndForgetsEverything() {
        ShadowAlarmManager.setCanScheduleExactAlarms(true)
        AutoVoteService.scheduleAlarm(app, 60_000L)
        assertEquals(1, alarms().size)
        ServiceState.setEnabled(app, true)
        ServiceState.record(app, 5, 77L, "x")
        AutoVoteService.isRunning = true
        TestSupport.writeSettings(app, """{"token":"secret"}""")
        val prefs = app.getSharedPreferences(SideStores.PREFS_FILE, Context.MODE_PRIVATE)
        prefs.edit().putString("gs_join_state", "{}").putString("gs_scenario_state", "{}").putString("photoStats", "{}").commit()
        val updates = File(app.cacheDir, "updates").apply { mkdirs() }
        File(updates, "update.apk").writeText("apk")

        val ret = wiped()

        assertTrue(ret.getBoolean("ok"))
        assertFalse(AutoVoteService.isRunning)
        assertEquals(AutoVoteService::class.java.name, shadowOf(app).nextStoppedService.component!!.className)
        assertTrue(alarms().isEmpty())
        assertEquals(ServiceState.Status(false, 0, 0L, null), ServiceState.status(app))
        assertTrue(prefs.all.isEmpty())
        assertFalse(updates.exists())
    }

    @Test
    fun wipeLocalDataOfAnEmptyAppSucceeds() {
        assertFalse(File(app.cacheDir, "updates").exists())
        assertTrue(wiped().getBoolean("ok"))
    }

    @Test
    fun wipeLocalDataReportsNotOkWhenTheWebViewStorageCannotBeCleared() {
        mockkStatic(WebStorage::class)
        try {
            every { WebStorage.getInstance() } throws RuntimeException("no WebView provider")
            TestSupport.writeSettings(app, """{"token":"secret"}""")

            assertFalse(wiped().getBoolean("ok"))

            // The rest is still wiped.
            assertNull(TestSupport.readSettings(app))
        } finally {
            unmockkStatic(WebStorage::class)
        }
    }

    @Test
    fun wipeLocalDataReportsNotOkWhenAFileSurvives() {
        val updates = File(app.cacheDir, "updates").apply { mkdirs() }
        val apk = File(updates, "update.apk").apply { writeText("apk") }
        // A directory that cannot be listed cannot be emptied, so deleting it fails.
        updates.setWritable(false)
        try {
            assertFalse(wiped().getBoolean("ok"))
        } finally {
            updates.setWritable(true)
            apk.delete()
        }
    }
}
