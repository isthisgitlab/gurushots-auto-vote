package com.isthisgitlab.gurushotsautovote

import android.app.AlarmManager
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Looper
import android.webkit.ConsoleMessage
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkObject
import io.mockk.unmockkObject
import io.mockk.verify
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowAlarmManager
import org.robolectric.shadows.ShadowContextImpl
import org.robolectric.shadows.ShadowPowerManager
import java.time.Duration
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
class AutoVoteServiceTest {

    private companion object {
        const val HEADLESS_URL = "https://appassets.androidplatform.net/assets/public/headless.html"
        const val MINUTE = 60_000L
    }

    private lateinit var app: Application
    private lateinit var originalFactory: () -> OkHttpClient
    private var originalAppFlags = 0
    private var server: MockWebServer? = null

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        originalFactory = AutoVoteService.httpClientFactory
        originalAppFlags = app.applicationInfo.flags
        resetStatics()
        ShadowAlarmManager.setCanScheduleExactAlarms(true)
        ShadowPowerManager.clearWakeLocks()
    }

    @After
    fun tearDown() {
        AutoVoteService.httpClientFactory = originalFactory
        app.applicationInfo.flags = originalAppFlags
        resetStatics()
        server?.close()
    }

    private fun resetStatics() {
        AutoVoteService.isRunning = false
        AutoVoteService.cycleCount = 0
        AutoVoteService.lastRunAtMillis = 0L
        AutoVoteService.lastError = null
    }

    // ---------- helpers ----------

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    private fun newService(): AutoVoteService =
        Robolectric.buildService(AutoVoteService::class.java).create().get()

    private fun AutoVoteService.command(action: String?): Int =
        onStartCommand(action?.let { Intent(it) }, 0, 1)

    private fun AutoVoteService.webView(): WebView? =
        AutoVoteService::class.java.getDeclaredField("webView").apply { isAccessible = true }.get(this) as WebView?

    private fun alarmManager() = app.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    private fun nextAlarm(): ShadowAlarmManager.ScheduledAlarm? = shadowOf(alarmManager()).peekNextScheduledAlarm()

    /** Asserts the single pending alarm fires [delayMs] from now at the AlarmReceiver. */
    @Suppress("DEPRECATION") // ScheduledAlarm exposes operation only as a (deprecated) field.
    private fun assertAlarmIn(delayMs: Long) {
        val alarms = shadowOf(alarmManager()).scheduledAlarms
        assertEquals(1, alarms.size)
        val alarm = alarms.single()
        assertEquals(AlarmManager.RTC_WAKEUP, alarm.getType())
        assertTrue(alarm.isAllowWhileIdle())
        val delta = alarm.getTriggerAtMs() - System.currentTimeMillis()
        assertTrue("expected ~$delayMs ms, got $delta", delta in (delayMs - 1_000)..delayMs)
        val intent = shadowOf(alarm.operation).savedIntent
        assertEquals(AutoVoteAlarmReceiver::class.java.name, intent.component!!.className)
        assertEquals(AutoVoteService.ACTION_RUN_CYCLE, intent.action)
    }

    @Suppress("DEPRECATION")
    private fun clearAlarms() {
        val am = alarmManager()
        shadowOf(am).scheduledAlarms.forEach { am.cancel(it.operation!!) }
    }

    private fun notificationText(): String? {
        val nm = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        return shadowOf(nm).getNotification(AutoVoteService.NOTIFICATION_ID)
            ?.extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString()
    }

    /** START + load the headless page so cycles can run. */
    private fun startedAndReady(): AutoVoteService {
        val svc = newService()
        assertEquals(Service.START_STICKY, svc.command(AutoVoteService.ACTION_START))
        idle()
        val wv = svc.webView()!!
        assertFalse(wv.settings.allowFileAccess)
        assertFalse(wv.settings.allowContentAccess)
        shadowOf(wv).webViewClient.onPageFinished(wv, HEADLESS_URL)
        clearAlarms()
        return svc
    }

    private fun runCycle(svc: AutoVoteService) {
        svc.command(AutoVoteService.ACTION_RUN_CYCLE)
        idle()
    }

    /** Replaces a system service for every context sharing the app's ContextImpl. */
    private fun systemService(name: String, service: Any) =
        Shadow.extract<ShadowContextImpl>(app.baseContext).setSystemService(name, service)

    private fun settings(json: String) = TestSupport.writeSettings(app, json)

    private fun httpResolution(svc: AutoVoteService, id: Int): JSONObject {
        val prefix = "window.__gsResolveHeadlessHttp && window.__gsResolveHeadlessHttp($id, "
        val deadline = System.currentTimeMillis() + 10_000
        while (true) {
            idle()
            val js = svc.webView()?.let { shadowOf(it).lastEvaluatedJavascript }
            if (js != null && js.startsWith(prefix)) {
                val quoted = js.removePrefix(prefix).removeSuffix(");")
                return JSONObject(JSONTokener(quoted).nextValue() as String)
            }
            if (System.currentTimeMillis() > deadline) throw AssertionError("no HTTP resolution for $id; last js=$js")
            Thread.sleep(5)
        }
    }

    // ---------- lifecycle ----------

    @Test
    fun bindIsUnsupported() {
        assertNull(newService().onBind(Intent()))
    }

    @Test
    fun createRegistersNotificationChannelOnce() {
        newService()
        val nm = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = nm.getNotificationChannel(AutoVoteService.CHANNEL_ID)
        assertNotNull(channel)
        assertEquals(NotificationManager.IMPORTANCE_LOW, channel.importance)
        assertFalse(channel.canShowBadge())
        // A second instance finds the channel and leaves it alone.
        channel.description = "user-tweaked"
        nm.createNotificationChannel(channel)
        newService()
        assertEquals("user-tweaked", nm.getNotificationChannel(AutoVoteService.CHANNEL_ID).description)
    }

    @Test
    fun unknownOrMissingActionKeepsStickyAndDoesNothing() {
        val svc = newService()
        assertEquals(Service.START_STICKY, svc.command(null))
        assertEquals(Service.START_STICKY, svc.command("something-else"))
        idle()
        assertFalse(AutoVoteService.isRunning)
        assertNull(svc.webView())
        assertNull(nextAlarm())
    }

    @Test
    fun startGoesForegroundCreatesWebViewAndSchedulesFirstAlarm() {
        AutoVoteService.cycleCount = 9
        AutoVoteService.lastError = "old"
        val svc = newService()

        assertEquals(Service.START_STICKY, svc.command(AutoVoteService.ACTION_START))

        assertTrue(AutoVoteService.isRunning)
        assertEquals(0, AutoVoteService.cycleCount)
        assertNull(AutoVoteService.lastError)
        val shadowSvc = shadowOf(svc)
        assertEquals(AutoVoteService.NOTIFICATION_ID, shadowSvc.lastForegroundNotificationId)
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC, svc.foregroundServiceType)
        val notification = shadowSvc.lastForegroundNotification
        assertEquals("Auto-vote starting…", notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals("GuruShots Auto Vote", notification.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertTrue(notification.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertNotNull(notification.contentIntent)
        val stopAction = notification.actions.single()
        assertEquals("Stop", stopAction.title.toString())
        val stopIntent = shadowOf(stopAction.actionIntent).savedIntent
        assertEquals(AutoVoteService.ACTION_STOP, stopIntent.action)
        assertEquals(AutoVoteService::class.java.name, stopIntent.component!!.className)
        assertTrue(shadowOf(stopAction.actionIntent).flags and PendingIntent.FLAG_IMMUTABLE != 0)
        assertAlarmIn(1_000L)

        // The WebView is built on the main thread.
        assertNull(svc.webView())
        idle()
        val wv = svc.webView()!!
        val shadowWv = shadowOf(wv)
        assertEquals(HEADLESS_URL, shadowWv.lastLoadedUrl)
        assertTrue(wv.settings.javaScriptEnabled)
        assertTrue(wv.settings.domStorageEnabled)
        assertFalse(wv.settings.allowFileAccess)
        assertTrue(shadowWv.getJavascriptInterface("AndroidHeadlessHttp") is AutoVoteService.HeadlessHttp)
        assertTrue(shadowWv.getJavascriptInterface("AndroidHeadlessStore") is AutoVoteService.HeadlessStore)
        assertTrue(shadowWv.getJavascriptInterface("AndroidHeadlessBridge") is AutoVoteService.HeadlessBridge)
    }

    @Test
    fun notificationWithoutLaunchableActivityHasNoContentIntent() {
        shadowOf(app.packageManager).removeActivity(ComponentName(app, MainActivity::class.java))
        val svc = newService()
        svc.command(AutoVoteService.ACTION_START)
        assertNull(shadowOf(svc).lastForegroundNotification.contentIntent)
    }

    @Test
    fun headlessAssetLoaderServesPackagedPageOnlyOnItsHttpsOrigin() {
        val svc = newService()
        svc.command(AutoVoteService.ACTION_START)
        idle()
        val wv = svc.webView()!!
        val client = shadowOf(wv).webViewClient
        val request = mockk<WebResourceRequest>()

        assertNull(client.shouldInterceptRequest(wv, null as WebResourceRequest?))
        every { request.url } returns Uri.parse(HEADLESS_URL)
        assertNotNull(client.shouldInterceptRequest(wv, request))

        every { request.url } returns Uri.parse("https://example.com/assets/public/headless.html")
        assertNull(client.shouldInterceptRequest(wv, request))
    }

    @Test
    fun headlessSideStoresUseOnlyTheAllowedPreferenceKeys() {
        val store = newService().HeadlessStore()
        store.writeKey("gs_lexicon_diagnostics", "{\"challenges\":1}")
        assertEquals("{\"challenges\":1}", store.readKey("gs_lexicon_diagnostics"))
        store.writeKey("unrelated-key", "{\"challenges\":2}")
        assertNull(store.readKey("unrelated-key"))
        store.writeKey("gs_lexicon_diagnostics", "invalid JSON")
        assertEquals("{\"challenges\":1}", store.readKey("gs_lexicon_diagnostics"))
        store.writeKey("gs_scenario_state", "{\"7\":{\"phase\":\"buildup\"}}")
        assertEquals("{\"7\":{\"phase\":\"buildup\"}}", store.readKey("gs_scenario_state"))
        store.writeKey("gs_scenario_state", "invalid JSON")
        assertEquals("{\"7\":{\"phase\":\"buildup\"}}", store.readKey("gs_scenario_state"))
    }

    @Test
    @Config(sdk = [30])
    fun preAndroid14UsesUntypedForegroundAndPreAndroid12AlwaysSchedulesExact() {
        val am = mockk<AlarmManager>(relaxed = true)
        systemService(Context.ALARM_SERVICE, am)
        val svc = newService()
        svc.command(AutoVoteService.ACTION_START)
        assertEquals(AutoVoteService.NOTIFICATION_ID, shadowOf(svc).lastForegroundNotificationId)
        assertEquals(0, svc.foregroundServiceType)
        // (canScheduleExactAlarms() doesn't even exist below API 31 — calling it would throw.)
        verify { am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, any(), any()) }
    }

    @Test
    fun withoutExactAlarmPermissionFallsBackToInexactAlarm() {
        val am = mockk<AlarmManager>(relaxed = true)
        every { am.canScheduleExactAlarms() } returns false
        systemService(Context.ALARM_SERVICE, am)
        newService().command(AutoVoteService.ACTION_START)
        verify { am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, any(), any()) }
        verify(exactly = 0) { am.setExactAndAllowWhileIdle(any(), any(), any<PendingIntent>()) }
    }

    @Test
    fun securityExceptionOnExactAlarmFallsBackToInexactAlarm() {
        val am = mockk<AlarmManager>(relaxed = true)
        every { am.canScheduleExactAlarms() } returns true
        every { am.setExactAndAllowWhileIdle(any(), any(), any<PendingIntent>()) } throws SecurityException("revoked")
        systemService(Context.ALARM_SERVICE, am)
        newService().command(AutoVoteService.ACTION_START)
        verify { am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, any(), any()) }
    }

    @Test
    fun secondStartWhileRunningIsANoOp() {
        val svc = startedAndReady()
        val wv = svc.webView()
        AutoVoteService.cycleCount = 4
        assertEquals(Service.START_STICKY, svc.command(AutoVoteService.ACTION_START))
        idle()
        assertEquals(4, AutoVoteService.cycleCount)
        assertSame(wv, svc.webView())
        assertNull(nextAlarm())
    }

    @Test
    fun restartAfterExternalStopReusesExistingWebView() {
        val svc = startedAndReady()
        val wv = svc.webView()
        // e.g. the flag was cleared by another instance without tearing this one down.
        AutoVoteService.isRunning = false
        svc.command(AutoVoteService.ACTION_START)
        idle()
        assertTrue(AutoVoteService.isRunning)
        assertSame(wv, svc.webView())
        assertEquals(HEADLESS_URL, shadowOf(wv!!).lastLoadedUrl)
    }

    // ---------- cycles ----------

    @Test
    fun runCycleIgnoredWhenNotRunning() {
        val svc = newService()
        assertEquals(Service.START_STICKY, svc.command(AutoVoteService.ACTION_RUN_CYCLE))
        idle()
        assertNull(svc.webView())
        assertNull(nextAlarm())
        assertNull(ShadowPowerManager.getLatestWakeLock())
    }

    @Test
    fun runCycleQueuedBeforeStopDoesNothing() {
        val svc = startedAndReady()
        svc.command(AutoVoteService.ACTION_RUN_CYCLE)
        // STOP lands before the queued RUN_CYCLE block runs.
        AutoVoteService.isRunning = false
        idle()
        assertNull(ShadowPowerManager.getLatestWakeLock())
        assertEquals(null, shadowOf(svc.webView()!!).lastEvaluatedJavascript)
    }

    @Test
    fun runCycleBeforePageLoadRetriesShortly() {
        val svc = newService()
        svc.command(AutoVoteService.ACTION_START)
        idle()
        val wv = svc.webView()!!
        // A sub-frame / other URL finishing doesn't mark the headless page ready.
        shadowOf(wv).webViewClient.onPageFinished(wv, "file:///android_asset/public/other.html")
        clearAlarms()

        runCycle(svc)

        assertAlarmIn(3_000L)
        assertNull(shadowOf(wv).lastEvaluatedJavascript)
        assertNull(ShadowPowerManager.getLatestWakeLock())
    }

    @Test
    fun runCycleOnFreshInstanceRebuildsWebView() {
        // The process was killed and the alarm re-created the service while
        // the static running flag survived: the new instance has no WebView.
        AutoVoteService.isRunning = true
        val svc = newService()
        runCycle(svc)
        val wv = svc.webView()!!
        assertEquals(HEADLESS_URL, shadowOf(wv).lastLoadedUrl)
        assertAlarmIn(3_000L)
    }

    @Test
    fun fullCycleRunsJsAndSchedulesJsCadence() {
        val svc = startedAndReady()
        runCycle(svc)

        val js = shadowOf(svc.webView()!!).lastEvaluatedJavascript
        assertTrue(js.contains("window.GS.runOneCycle()"))
        assertTrue(js.contains("AndroidHeadlessBridge.onCycleComplete"))
        val wakeLock = ShadowPowerManager.getLatestWakeLock()
        assertTrue(wakeLock.isHeld)
        assertNull(nextAlarm())

        svc.HeadlessBridge().onCycleComplete("""{"ok":true,"nextDelayMs":$MINUTE}""")
        idle()

        assertFalse(wakeLock.isHeld)
        assertEquals(1, AutoVoteService.cycleCount)
        assertNull(AutoVoteService.lastError)
        assertTrue(AutoVoteService.lastRunAtMillis > 0)
        assertTrue(notificationText()!!.matches(Regex("""Last cycle at \d\d:\d\d:\d\d \(#1\)""")))
        assertAlarmIn(MINUTE)

        // A late second report (or the watchdog) for the same cycle is ignored.
        clearAlarms()
        svc.HeadlessBridge().onCycleComplete("""{"ok":true,"nextDelayMs":$MINUTE}""")
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMinutes(3))
        assertEquals(1, AutoVoteService.cycleCount)
        assertNull(nextAlarm())
    }

    @Test
    fun outOfBandDelaysFallBackToConfiguredInterval() {
        settings("""{"checkFrequencyMin":5}""")
        val svc = startedAndReady()
        for (bad in listOf("""{"nextDelayMs":999}""", """{"nextDelayMs":${6L * 60 * MINUTE + 1}}""", "{}")) {
            runCycle(svc)
            svc.HeadlessBridge().onCycleComplete(bad)
            idle()
            assertAlarmIn(5 * MINUTE)
            clearAlarms()
        }
        // Both inclusive edges of the accepted band are honoured.
        for (edge in listOf(1_000L, 6L * 60 * MINUTE)) {
            runCycle(svc)
            svc.HeadlessBridge().onCycleComplete("""{"nextDelayMs":$edge}""")
            idle()
            assertAlarmIn(edge)
            clearAlarms()
        }
    }

    @Test
    fun zeroConfiguredIntervalUsesBuiltInDefault() {
        settings("""{"checkFrequencyMin":0}""")
        val svc = startedAndReady()
        runCycle(svc)
        svc.HeadlessBridge().onCycleComplete("""{"ok":false}""")
        idle()
        assertAlarmIn(3 * MINUTE)
    }

    @Test
    fun cycleErrorsAreRecordedAndShownFriendly() {
        val svc = startedAndReady()

        runCycle(svc)
        svc.HeadlessBridge().onCycleComplete("""{"ok":false,"error":"no-token"}""")
        idle()
        assertEquals("no-token", AutoVoteService.lastError)
        assertTrue(notificationText()!!.endsWith(": Not logged in — open the app and log in"))

        runCycle(svc)
        svc.HeadlessBridge().onCycleComplete("""{"ok":false,"error":"HTTP 503"}""")
        idle()
        assertEquals("HTTP 503", AutoVoteService.lastError)
        assertTrue(notificationText()!!.matches(Regex("""Last error at \d\d:\d\d:\d\d: HTTP 503""")))

        // An empty error string clears the error.
        runCycle(svc)
        svc.HeadlessBridge().onCycleComplete("""{"ok":true,"error":""}""")
        idle()
        assertNull(AutoVoteService.lastError)
        assertEquals(3, AutoVoteService.cycleCount)
    }

    @Test
    fun malformedCompletionPayloadStillCompletesTheCycle() {
        settings("""{"checkFrequencyMin":2}""")
        val svc = startedAndReady()
        AutoVoteService.lastError = "kept"
        runCycle(svc)
        svc.HeadlessBridge().onCycleComplete("not json")
        idle()
        assertEquals(1, AutoVoteService.cycleCount)
        // The parse failed before lastError was touched.
        assertEquals("kept", AutoVoteService.lastError)
        assertAlarmIn(2 * MINUTE)
    }

    @Test
    fun watchdogRecoversWhenJsNeverReports() {
        val svc = startedAndReady()
        runCycle(svc)
        val wakeLock = ShadowPowerManager.getLatestWakeLock()

        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(120_000))

        assertEquals("cycle-timeout", AutoVoteService.lastError)
        assertEquals(1, AutoVoteService.cycleCount)
        assertFalse(wakeLock.isHeld)
        assertTrue(notificationText()!!.endsWith(": Timed out — will retry"))
        assertAlarmIn(3 * MINUTE)
    }

    @Test
    fun completionAfterWakelockExpiredStillSchedules() {
        val svc = startedAndReady()
        runCycle(svc)
        // The OS released the timed wakelock before JS reported back.
        ShadowPowerManager.getLatestWakeLock().release()
        svc.HeadlessBridge().onCycleComplete("""{"nextDelayMs":$MINUTE}""")
        idle()
        assertEquals(1, AutoVoteService.cycleCount)
        assertAlarmIn(MINUTE)
    }

    @Test
    fun wakelockFailureDoesNotBlockTheCycle() {
        // PowerManager is final (mockk can't retransform it), so hand back a
        // non-PowerManager: the cast inside acquireWakelock() throws, like a
        // vendor ROM refusing the wakelock would.
        systemService(Context.POWER_SERVICE, Any())
        val svc = startedAndReady()
        runCycle(svc)
        assertTrue(shadowOf(svc.webView()!!).lastEvaluatedJavascript.contains("runOneCycle"))
        svc.HeadlessBridge().onCycleComplete("""{"nextDelayMs":$MINUTE}""")
        idle()
        assertEquals(1, AutoVoteService.cycleCount)
        assertAlarmIn(MINUTE)
    }

    // ---------- stop / destroy ----------

    @Test
    fun stopMidCycleTearsEverythingDown() {
        val svc = startedAndReady()
        runCycle(svc)
        val wv = svc.webView()!!
        val wakeLock = ShadowPowerManager.getLatestWakeLock()
        svc.HeadlessBridge().onCycleComplete("""{"nextDelayMs":$MINUTE}""")
        idle()
        assertAlarmIn(MINUTE)
        runCycle(svc)
        val cycleWakeLock = ShadowPowerManager.getLatestWakeLock()

        assertEquals(Service.START_NOT_STICKY, svc.command(AutoVoteService.ACTION_STOP))

        assertFalse(AutoVoteService.isRunning)
        assertNull(nextAlarm())
        assertTrue(shadowOf(svc).isForegroundStopped)
        assertTrue(shadowOf(svc).isStoppedBySelf)
        idle()
        assertFalse(wakeLock.isHeld)
        assertFalse(cycleWakeLock.isHeld)
        assertTrue(shadowOf(wv).wasDestroyCalled())
        assertNull(svc.webView())

        // JS reporting after the stop completes the cycle but schedules nothing.
        svc.HeadlessBridge().onCycleComplete("""{"nextDelayMs":$MINUTE}""")
        idle()
        assertNull(nextAlarm())
        // The watchdog was cancelled by the stop.
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMinutes(3))
        assertEquals(2, AutoVoteService.cycleCount)
        assertNull(AutoVoteService.lastError)
    }

    @Test
    fun stopWithoutCycleOrWebView() {
        val svc = newService()
        assertEquals(Service.START_NOT_STICKY, svc.command(AutoVoteService.ACTION_STOP))
        idle()
        assertNull(svc.webView())
        assertTrue(shadowOf(svc).isStoppedBySelf)
    }

    @Test
    fun stopAfterWakelockExpired() {
        val svc = startedAndReady()
        runCycle(svc)
        val wakeLock = ShadowPowerManager.getLatestWakeLock()
        wakeLock.release()
        svc.command(AutoVoteService.ACTION_STOP)
        idle()
        assertFalse(wakeLock.isHeld)
        assertNull(svc.webView())
    }

    @Test
    fun destroyReleasesHeldWakelockAndWebView() {
        val svc = startedAndReady()
        runCycle(svc)
        val wv = svc.webView()!!
        val wakeLock = ShadowPowerManager.getLatestWakeLock()
        svc.onDestroy()
        assertFalse(wakeLock.isHeld)
        assertTrue(shadowOf(wv).wasDestroyCalled())
        assertNull(svc.webView())
        // The cancelled watchdog never fires.
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMinutes(3))
        assertEquals(0, AutoVoteService.cycleCount)
    }

    @Test
    fun destroyWithExpiredWakelock() {
        val svc = startedAndReady()
        runCycle(svc)
        ShadowPowerManager.getLatestWakeLock().release()
        svc.onDestroy()
        assertNull(svc.webView())
    }

    @Test
    fun destroyWithNothingToRelease() {
        val svc = newService()
        svc.onDestroy()
        assertNull(svc.webView())
    }

    // ---------- WebView callbacks ----------

    @Test
    fun mainFrameLoadErrorMarksPageNotReady() {
        val svc = startedAndReady()
        val wv = svc.webView()!!
        val client = shadowOf(wv).webViewClient
        val subFrame = mockk<WebResourceRequest> { every { isForMainFrame } returns false }
        val mainFrame = mockk<WebResourceRequest> { every { isForMainFrame } returns true }
        val error = mockk<WebResourceError> { every { description } returns "net::ERR_FILE_NOT_FOUND" }

        // Neither a null request nor a sub-frame failure affects readiness.
        client.onReceivedError(wv, null, error)
        client.onReceivedError(wv, subFrame, error)
        runCycle(svc)
        assertNotNull(ShadowPowerManager.getLatestWakeLock())
        svc.HeadlessBridge().onCycleComplete("{}")
        idle()
        clearAlarms()

        client.onReceivedError(wv, mainFrame, null)
        runCycle(svc)
        assertAlarmIn(3_000L)
        clearAlarms()

        shadowOf(wv).webViewClient.onPageFinished(wv, HEADLESS_URL)
        client.onReceivedError(wv, mainFrame, error)
        runCycle(svc)
        assertAlarmIn(3_000L)
    }

    private fun consoleMessage() = ConsoleMessage("hello", "headless.js", 12, ConsoleMessage.MessageLevel.LOG)

    @Test
    fun consoleAndCompletionLoggingInDebuggableBuild() {
        app.applicationInfo.flags = originalAppFlags or ApplicationInfo.FLAG_DEBUGGABLE
        val svc = startedAndReady()
        assertTrue(shadowOf(svc.webView()!!).webChromeClient.onConsoleMessage(consoleMessage()))
        runCycle(svc)
        svc.HeadlessBridge().onCycleComplete("""{"error":"secret detail"}""")
        idle()
        assertEquals("secret detail", AutoVoteService.lastError)
    }

    @Test
    fun consoleAndCompletionLoggingInReleaseBuild() {
        app.applicationInfo.flags = originalAppFlags and ApplicationInfo.FLAG_DEBUGGABLE.inv()
        val svc = startedAndReady()
        assertTrue(shadowOf(svc.webView()!!).webChromeClient.onConsoleMessage(consoleMessage()))
        runCycle(svc)
        svc.HeadlessBridge().onCycleComplete("""{"error":"secret detail"}""")
        idle()
        runCycle(svc)
        svc.HeadlessBridge().onCycleComplete("""{"ok":true}""")
        idle()
        assertNull(AutoVoteService.lastError)
        assertEquals(2, AutoVoteService.cycleCount)
    }

    // ---------- settings bridge ----------

    @Test
    fun storeReadsAndWritesTheSharedSettingsBlob() {
        val svc = newService()
        val store = svc.HeadlessStore()
        TestSupport.writeSettings(app, null)
        assertNull(store.read())

        store.write("""{"token":"abc"}""")
        assertEquals("""{"token":"abc"}""", TestSupport.readSettings(app))
        assertEquals("""{"token":"abc"}""", store.read())

        // Non-JSON is refused so the token-bearing blob can't be corrupted.
        store.write("{oops")
        assertEquals("""{"token":"abc"}""", TestSupport.readSettings(app))
    }

    // ---------- HTTP bridge ----------

    private fun startServer(extra: Interceptor? = null): MockWebServer {
        val s = MockWebServer()
        s.start()
        server = s
        AutoVoteService.httpClientFactory = { TestSupport.reroutingClient(s, extra) }
        return s
    }

    @Test
    fun defaultHttpClientIsConfiguredWithTimeouts() {
        val client = originalFactory()
        assertEquals(30_000, client.connectTimeoutMillis)
        assertEquals(30_000, client.readTimeoutMillis)
        assertEquals(30_000, client.writeTimeoutMillis)
        assertTrue(client.retryOnConnectionFailure)
    }

    @Test
    fun postRequestIsForwardedAndResponseResolved() {
        val s = startServer()
        s.enqueue(
            MockResponse.Builder().code(201).body("""{"ok":1}""")
                .addHeader("X-Custom", "v1").build(),
        )
        val svc = startedAndReady()

        svc.HeadlessHttp().request(
            7,
            "post",
            "https://api.gurushots.com/rest_mobile/get_my_active_challenges",
            """{"x-token":"tok","x-api-version":"20"}""",
            "a=1&b=2",
        )

        val res = httpResolution(svc, 7)
        assertEquals(201, res.getInt("status"))
        assertEquals("""{"ok":1}""", res.getString("body"))
        assertEquals("v1", res.getJSONObject("headers").getString("x-custom"))
        val req = s.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("POST", req.method)
        assertEquals("/rest_mobile/get_my_active_challenges", req.url.encodedPath)
        assertEquals("a=1&b=2", req.body!!.utf8())
        assertEquals("tok", req.headers["x-token"])
        assertEquals("20", req.headers["x-api-version"])
        assertEquals("application/x-www-form-urlencoded; charset=utf-8", req.headers["Content-Type"])
    }

    @Test
    fun getAndHeadCarryNoBodyAndApexHostIsAllowed() {
        val s = startServer()
        s.enqueue(MockResponse.Builder().code(200).body("g").build())
        s.enqueue(MockResponse.Builder().code(200).build())
        val svc = startedAndReady()

        svc.HeadlessHttp().request(1, "GET", "https://gurushots.com/a", "{}", "ignored")
        assertEquals("g", httpResolution(svc, 1).getString("body"))
        svc.HeadlessHttp().request(2, "head", "https://cdn.gurushots.com/b", "{}", "ignored")
        assertEquals(200, httpResolution(svc, 2).getInt("status"))

        val get = s.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("GET", get.method)
        assertEquals(0L, get.bodySize)
        assertEquals("HEAD", s.takeRequest(5, TimeUnit.SECONDS)!!.method)
    }

    @Test
    fun disallowedOrInvalidUrlsAreRejectedWithoutNetwork() {
        val s = startServer()
        val svc = startedAndReady()
        val cases = listOf(
            "http://api.gurushots.com/x" to "blocked url host/scheme: api.gurushots.com",
            "https://evilgurushots.com/x" to "blocked url host/scheme: evilgurushots.com",
            "https://example.com/x" to "blocked url host/scheme: example.com",
            "not a url" to "invalid url",
        )
        cases.forEachIndexed { i, (url, expected) ->
            svc.HeadlessHttp().request(100 + i, "POST", url, "{}", "")
            assertEquals(expected, httpResolution(svc, 100 + i).getString("error"))
        }
        assertEquals(0, s.requestCount)
    }

    @Test
    fun malformedHeadersJsonIsRejected() {
        startServer()
        val svc = startedAndReady()
        svc.HeadlessHttp().request(5, "POST", "https://api.gurushots.com/x", "not-json", "")
        assertEquals("bad-request (JSONException)", httpResolution(svc, 5).getString("error"))
    }

    @Test
    fun requestBuildFailureReportsTypeOnly() {
        startServer()
        val svc = startedAndReady()
        mockkObject(HttpUrl.Companion)
        try {
            every { with(HttpUrl.Companion) { any<String>().toHttpUrlOrNull() } } throws RuntimeException("internal detail")
            svc.HeadlessHttp().request(6, "POST", "https://api.gurushots.com/x", "{}", "")
        } finally {
            unmockkObject(HttpUrl.Companion)
        }
        assertEquals("bad-request (RuntimeException)", httpResolution(svc, 6).getString("error"))
    }

    @Test
    fun networkFailuresResolveWithErrorTypeOnly() {
        startServer(Interceptor { throw java.net.SocketTimeoutException("timeout to 10.0.0.1") })
        val svc = startedAndReady()

        svc.HeadlessHttp().request(8, "POST", "https://api.gurushots.com/x", "{}", "")
        assertEquals("network-error (SocketTimeoutException)", httpResolution(svc, 8).getString("error"))
    }

    @Test
    fun bodyReadFailureResolvesWithError() {
        // An IOException while reading the body must still resolve the id,
        // so JS doesn't have to wait for its own request timeout.
        val closed = CountDownLatch(1)
        startServer(TestSupport.failingBodyInterceptor { closed.countDown() })
        val svc = startedAndReady()
        svc.HeadlessHttp().request(11, "POST", "https://api.gurushots.com/x", "{}", "")
        assertEquals("network-error (IOException)", httpResolution(svc, 11).getString("error"))
        assertTrue(closed.await(10, TimeUnit.SECONDS))
    }

    @Test
    fun resolutionAfterStopIsDropped() {
        startServer()
        val svc = startedAndReady()
        svc.command(AutoVoteService.ACTION_STOP)
        idle()
        assertNull(svc.webView())
        // No WebView to deliver to: must not throw.
        svc.HeadlessHttp().request(10, "POST", "http://blocked.example/", "{}", "")
        idle()
        assertNull(svc.webView())
    }
}
