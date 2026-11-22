package com.isthisgitlab.gurushotsautovote

import android.app.AlarmManager
import android.app.Application
import android.content.Context
import android.os.Looper
import android.webkit.WebStorage
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import com.getcapacitor.Bridge
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkObject
import io.mockk.mockkStatic
import io.mockk.slot
import io.mockk.unmockkObject
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

    private companion object {
        // The app's own factory, saved once before any test swaps it, so tearDown puts back the real one.
        val defaultNewWebView = AutoVotePlugin.newWebView
    }

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
        SideStores.resume()
        AutoVotePlugin.newWebView = defaultNewWebView
        unmockkObject(SideStores)
        app.getSharedPreferences(SideStores.PREFS_FILE, Context.MODE_PRIVATE).edit().clear().commit()
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
    fun compareAndWriteSavesTheSettingsBlobOnlyWhileItHoldsWhatTheWindowRead() {
        fun settingsWrite(expected: String?, value: String) = resolved {
            every { it.getString("key") } returns "gurushots-config"
            every { it.getString("expected") } returns expected
            every { it.getString("value") } returns value
            plugin.compareAndWrite(it)
        }
        assertTrue(settingsWrite(null, """{"theme":"dark"}""").getBoolean("saved"))
        // The service saved a different key meanwhile: the window's write built on the old text is not saved.
        assertTrue(
            SideStores.compareAndSet(app, "gurushots-config", """{"theme":"dark"}""", """{"theme":"dark","token":"t"}""")
                .outcome == SideStores.Outcome.SAVED
        )
        val lost = settingsWrite("""{"theme":"dark"}""", """{"theme":"light"}""")
        assertFalse(lost.getBoolean("saved"))
        assertEquals("""{"theme":"dark","token":"t"}""", lost.getString("current"))
        assertEquals("""{"theme":"dark","token":"t"}""", TestSupport.readConfig(app))
        // It carries the settings cap, not the side stores': past the side-store cap is saved, past its own is not.
        val past = """{"k":"${"x".repeat(SideStores.MAX_BYTES * 4)}"}"""
        assertTrue(settingsWrite("""{"theme":"dark","token":"t"}""", past).getBoolean("saved"))
        val call = mockk<PluginCall>(relaxed = true)
        every { call.getString("key") } returns "gurushots-config"
        every { call.getString("expected") } returns past
        every { call.getString("value") } returns """{"k":"${"x".repeat(SideStores.MAX_SETTINGS_BYTES)}"}"""
        plugin.compareAndWrite(call)
        // An oversize blob is rejected with its own code, which a conflict (resolved as saved:false) never carries.
        verify(exactly = 1) { call.reject("too large", "too-large") }
        verify(exactly = 0) { call.reject(any<String>()) }
        assertEquals(past, TestSupport.readConfig(app))
    }

    @Test
    fun compareAndWriteTakesTheConfigurationAndTheKeysOfTheImportButNotTheSetAsideCopies() {
        fun write(key: String, value: String) = resolved {
            every { it.getString("key") } returns key
            every { it.getString("expected") } returns null
            every { it.getString("value") } returns value
            plugin.compareAndWrite(it)
        }
        for (key in listOf("gurushots-config", "gurushots-settings", "gs_v2_import", "gs_title_pins")) {
            assertTrue(key, write(key, """{"a":1}""").getBoolean("saved"))
        }
        // The window sets a corrupt copy aside through Preferences itself; the plugin is not a way to write one.
        val call = mockk<PluginCall>(relaxed = true)
        every { call.getString("key") } returns "gurushots-config_corrupt-2026-10-16T08-00-00-000Z"
        every { call.getString("expected") } returns null
        every { call.getString("value") } returns """{"a":1}"""
        plugin.compareAndWrite(call)
        verify(exactly = 1) { call.reject("not a side store") }
        assertNull(
            app.getSharedPreferences(SideStores.PREFS_FILE, Context.MODE_PRIVATE)
                .getString("gurushots-config_corrupt-2026-10-16T08-00-00-000Z", null)
        )
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
        rejected("unrelated-key", "{}")
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
        assertTrue(AutoVoteService.scheduleAlarm(app, 60_000L, 0L))
        assertEquals(1, alarms().size)
        ServiceState.setEnabled(app, true)
        ServiceState.record(app, 5, 77L, "x")
        AutoVoteService.isRunning = true
        TestSupport.writeConfig(app, """{"token":"secret"}""")
        val prefs = app.getSharedPreferences(SideStores.PREFS_FILE, Context.MODE_PRIVATE)
        prefs.edit()
            .putString("gs_join_state", "{}")
            .putString("gs_scenario_state", "{}")
            .putString("photoStats", "{}")
            .putString("gurushots-settings", """{"token":"old"}""")
            .putString("gurushots-settings_original", """{"token":"older"}""")
            .putString("gs_v2_import", "{}")
            .putString("gs_title_pins", "{}")
            // A full wipe clears the Stop fence and the control inbox together.
            .putString(StopFence.KEY, """{"stopEpoch":4,"blocked":true,"lastStop":null,"lastArm":null}""")
            .putString(SideStores.CONTROLS_KEY, """{"targets":{}}""")
            .putString("gurushots-config_corrupt-2026-10-16T08-00-00-000Z", "{")
            .putString("gurushots-settings_corrupt-2026-10-16T08-00-00-000Z", "{")
            .putString("gurushots-settings_unimportable-2026-10-16T08-00-00-000Z", "{")
            .commit()
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
        // What the background service still has in flight cannot put anything back.
        assertFalse(SideStores.write(app, "gs_scenario_state", "{}"))
        assertEquals(SideStores.Outcome.REFUSED, SideStores.compareAndSet(app, "gurushots-config", null, "{}", fromService = true).outcome)
        assertTrue(prefs.all.isEmpty())
    }

    @Test
    fun wipeLocalDataClearsTheWebViewHttpCacheFromDiskToo() {
        val created = mutableListOf<WebView>()
        AutoVotePlugin.newWebView = { ctx -> WebView(ctx).also { created.add(it) } }

        assertTrue(wiped().getBoolean("ok"))

        val webView = created.single()
        assertTrue(shadowOf(webView).wasClearCacheCalled())
        assertTrue(shadowOf(webView).didClearCacheIncludeDiskFiles())
        assertTrue(shadowOf(webView).wasDestroyCalled())
        assertFalse(webView.settings.allowFileAccess)
        assertFalse(webView.settings.allowContentAccess)
    }

    @Test
    fun theDefaultWebViewFactoryTurnsFileAndContentAccessOff() {
        val webView = defaultNewWebView(app)

        assertFalse(webView.settings.allowFileAccess)
        assertFalse(webView.settings.allowContentAccess)
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
            TestSupport.writeConfig(app, """{"token":"secret"}""")

            assertFalse(wiped().getBoolean("ok"))

            // The rest is still wiped.
            assertNull(TestSupport.readConfig(app))
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

    // ---------- stopAll: the direct native Stop ----------

    private fun prefs() = app.getSharedPreferences(SideStores.PREFS_FILE, Context.MODE_PRIVATE)

    /** [at] is what the JS `Date.now()` becomes in the call data: a Long. */
    private fun callData(at: Any?): JSObject = JSObject().apply { if (at != null) put("at", at) }

    private fun stopAll(requestId: String?, at: Any? = 1_700_000_000_000L): JSObject =
        resolved {
            every { it.getString("requestId") } returns requestId
            every { it.data } returns callData(at)
            plugin.stopAll(it)
        }

    private fun rejected(requestId: String?, at: Any?) {
        val call = mockk<PluginCall>(relaxed = true)
        every { call.getString("requestId") } returns requestId
        every { call.data } returns callData(at)
        plugin.stopAll(call)
        verify(exactly = 1) { call.reject("invalid stop") }
        verify(exactly = 0) { call.resolve(any()) }
    }

    private fun fence() = StopFence.parse(prefs().getString(StopFence.KEY, null)!!)!!

    /** A run that is going: automation enabled, the service running, an alarm waiting under epoch 0. */
    private fun aRunningService() {
        ShadowAlarmManager.setCanScheduleExactAlarms(true)
        ServiceState.setEnabled(app, true)
        AutoVoteService.isRunning = true
        assertTrue(AutoVoteService.scheduleAlarm(app, 60_000L, 0L))
        assertEquals(1, alarms().size)
    }

    private fun assertLocallyCancelled() {
        assertFalse(ServiceState.isEnabled(app))
        assertFalse(AutoVoteService.isRunning)
        assertTrue(alarms().isEmpty())
        val stopped = shadowOf(app).nextStartedService
        assertEquals(AutoVoteService::class.java.name, stopped.component!!.className)
        assertEquals(AutoVoteService.ACTION_STOP, stopped.action)
    }

    @Test
    fun stopAllCancelsTheWorkThenRecordsTheStopInTheFence() {
        aRunningService()

        val ret = stopAll("stop-a")

        assertTrue(ret.getBoolean("stopped"))
        assertTrue(ret.getBoolean("durable"))
        assertEquals(1, ret.getInt("epoch"))
        assertFalse(ret.has("reason"))
        assertLocallyCancelled()
        val stored = fence()
        assertEquals(1L, stored.epoch)
        assertTrue(stored.blocked)
        assertEquals("stop-a", stored.lastStop!!.getString("requestId"))
        assertEquals(1_700_000_000_000L, stored.lastStop!!.getLong("at"))
    }

    @Test
    fun theRunningCycleIsLatchedFirstAndTheFenceHoldsTheStopBeforeTheServiceIsEnded() {
        aRunningService()
        val order = mutableListOf<String>()
        AutoVoteService.cancelCycle = { order.add("latch") }
        mockkObject(SideStores)
        every { SideStores.compareAndSet(any(), StopFence.KEY, any(), any(), any()) } answers {
            // The service has not been told to end yet, and new work is already cancelled.
            order.add(if (shadowOf(app).peekNextStartedService() == null) "fence-before-end" else "fence-after-end")
            assertFalse(ServiceState.isEnabled(app))
            callOriginal()
        }
        try {
            assertTrue(stopAll("stop-a").getBoolean("durable"))
        } finally {
            AutoVoteService.cancelCycle = null
        }
        assertEquals(listOf("latch", "fence-before-end"), order)
        assertEquals(AutoVoteService.ACTION_STOP, shadowOf(app).nextStartedService.action)
    }

    @Test
    fun stopAllWithNoServiceRunningStillRecordsTheStop() {
        // The foreground app with no service: nothing to cancel, and the fence still advances.
        val ret = stopAll("stop-a")
        assertTrue(ret.getBoolean("durable"))
        assertEquals(1, ret.getInt("epoch"))
        assertFalse(ServiceState.isEnabled(app))
        assertEquals(AutoVoteService.ACTION_STOP, shadowOf(app).nextStartedService.action)
    }

    @Test
    fun theTimeMayArriveAsAnIntAWholeLongOrADouble() {
        listOf(5, 1_700_000_000_000L, 12.5).forEachIndexed { index, at ->
            assertTrue(stopAll("stop-$index", at).getBoolean("durable"))
        }
        assertEquals(3L, fence().epoch)
        assertEquals(12L, fence().lastStop!!.getLong("at"))
    }

    @Test
    fun theSameStopTwiceAdvancesTheEpochOnce() {
        assertEquals(1, stopAll("stop-a").getInt("epoch"))
        assertEquals(1, stopAll("stop-a").getInt("epoch"))
        assertEquals(2, stopAll("stop-b").getInt("epoch"))
    }

    @Test
    fun aStopNeverWaitsBehindNorTouchesTheControlInbox() {
        // A full inbox, a busy one (a request pending) and one that cannot be read: the Stop advances the fence regardless,
        // and not a byte of the inbox changes.
        val head = """{"targets":{"installation":{"pending":""""
        val tail = """"}}}"""
        val full = head + "x".repeat(524_288 - head.length - tail.length) + tail
        listOf(
            full,
            """{"targets":{"installation":{"revision":1,"pending":{"requestId":"r1"},"results":[]}}}""",
            "not json at all",
        ).forEachIndexed { index, inbox ->
            prefs().edit().putString(SideStores.CONTROLS_KEY, inbox).commit()
            val ret = stopAll("stop-$index")
            assertTrue(ret.getBoolean("durable"))
            assertEquals(index + 1, ret.getInt("epoch"))
            assertEquals(inbox, prefs().getString(SideStores.CONTROLS_KEY, null))
        }
    }

    @Test
    fun aFenceThatCannotBeReadIsNotDurableButTheCancellationStands() {
        aRunningService()
        prefs().edit().putString(StopFence.KEY, "garbage").commit()

        val ret = stopAll("stop-a")

        assertTrue(ret.getBoolean("stopped"))
        assertFalse(ret.getBoolean("durable"))
        assertEquals("unreadable", ret.getString("reason"))
        assertFalse(ret.has("epoch"))
        assertLocallyCancelled()
        assertEquals("garbage", prefs().getString(StopFence.KEY, null))
    }

    @Test
    fun aFenceThatCannotBeSavedIsNotDurableButTheCancellationStands() {
        aRunningService()
        mockkObject(SideStores)
        every { SideStores.compareAndSet(any(), StopFence.KEY, any(), any(), any()) } returns
            SideStores.Result(SideStores.Outcome.REFUSED, null)

        val ret = stopAll("stop-a")

        assertTrue(ret.getBoolean("stopped"))
        assertFalse(ret.getBoolean("durable"))
        assertEquals("not-saved", ret.getString("reason"))
        assertLocallyCancelled()
        assertNull(prefs().getString(StopFence.KEY, null))
    }

    @Test
    fun aStopWithoutAValidRequestIdAndTimeIsRejectedAndCancelsNothing() {
        aRunningService()
        rejected(null, 1.0)
        rejected("has space", 1.0)
        rejected("a".repeat(65), 1.0)
        rejected("stop-a", null)
        rejected("stop-a", "now")
        assertTrue(ServiceState.isEnabled(app))
        assertEquals(1, alarms().size)
        assertNull(prefs().getString(StopFence.KEY, null))
        assertNull(shadowOf(app).nextStartedService)
    }
}
