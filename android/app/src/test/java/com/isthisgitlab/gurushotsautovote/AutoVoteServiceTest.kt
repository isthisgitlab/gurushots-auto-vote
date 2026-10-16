package com.isthisgitlab.gurushotsautovote

import android.app.AlarmManager
import android.app.Application
import android.app.ForegroundServiceStartNotAllowedException
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
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkObject
import io.mockk.unmockkObject
import io.mockk.verify
import io.mockk.verifyOrder
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
import org.robolectric.shadows.ShadowLog
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
        ServiceState.clear(app)
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

    private fun settings(json: String) = TestSupport.writeConfig(app, """{"app":$json}""")

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
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE, svc.foregroundServiceType)
        assertTrue(ServiceState.isEnabled(app))
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

    private fun request(url: String, mainFrame: Boolean = true, method: String = "GET") = mockk<WebResourceRequest> {
        every { this@mockk.url } returns Uri.parse(url)
        every { isForMainFrame } returns mainFrame
        every { this@mockk.method } returns method
    }

    private fun assertForbidden(response: WebResourceResponse?) {
        assertNotNull(response)
        assertEquals(403, response!!.statusCode)
        assertEquals("Forbidden", response.reasonPhrase)
        assertEquals(-1, response.data.read())
    }

    @Test
    fun headlessAssetLoaderServesPackagedPageOnlyOnItsHttpsOrigin() {
        val svc = newService()
        svc.command(AutoVoteService.ACTION_START)
        idle()
        val wv = svc.webView()!!
        val client = shadowOf(wv).webViewClient

        val page = client.shouldInterceptRequest(wv, request(HEADLESS_URL))
        assertNotNull(page)
        assertEquals(200, page!!.statusCode)
    }

    @Test
    fun headlessWebViewRefusesEveryRequestTheAssetLoaderDoesNotServe() {
        val svc = newService()
        svc.command(AutoVoteService.ACTION_START)
        idle()
        val wv = svc.webView()!!
        val client = shadowOf(wv).webViewClient

        assertForbidden(client.shouldInterceptRequest(wv, null as WebResourceRequest?))
        assertForbidden(client.shouldInterceptRequest(wv, request("https://example.com/assets/public/headless.html")))
        assertForbidden(client.shouldInterceptRequest(wv, request("https://api.gurushots.com/x", mainFrame = false)))
        assertForbidden(client.shouldInterceptRequest(wv, request("http://appassets.androidplatform.net/assets/public/headless.html")))
        // On the origin, but not a path the loader serves.
        assertForbidden(client.shouldInterceptRequest(wv, request("https://appassets.androidplatform.net/elsewhere/x")))
        assertForbidden(client.shouldInterceptRequest(wv, request("https://appassets.androidplatform.net/assets/public/none.html", mainFrame = false)))
    }

    @Test
    fun headlessWebViewLetsOnlyGetFetchesOfThePhotoHostReachTheNetwork() {
        val svc = newService()
        svc.command(AutoVoteService.ACTION_START)
        idle()
        val wv = svc.webView()!!
        val client = shadowOf(wv).webViewClient

        // null: not intercepted, the WebView fetches it.
        assertNull(client.shouldInterceptRequest(wv, request("https://photos.gurushots.com/photo/1.jpg?x=1", mainFrame = false)))
        assertNull(client.shouldInterceptRequest(wv, request("https://photos.gurushots.com:443/photo/1.jpg", mainFrame = false)))
        assertForbidden(client.shouldInterceptRequest(wv, request("https://photos.gurushots.com/photo/1.jpg", mainFrame = false, method = "POST")))
        assertForbidden(client.shouldInterceptRequest(wv, request("http://photos.gurushots.com/photo/1.jpg", mainFrame = false)))
        assertForbidden(client.shouldInterceptRequest(wv, request("https://photos.gurushots.com:8443/photo/1.jpg", mainFrame = false)))
        assertForbidden(client.shouldInterceptRequest(wv, request("https://other.gurushots.com/photo/1.jpg", mainFrame = false)))
        assertForbidden(client.shouldInterceptRequest(wv, request("https://photos.gurushots.com.evil.example/photo/1.jpg", mainFrame = false)))
        assertForbidden(client.shouldInterceptRequest(wv, request("https://example.com/photo/1.jpg", mainFrame = false)))
        // The photo host is not a place the page may navigate to.
        assertTrue(client.shouldOverrideUrlLoading(wv, request("https://photos.gurushots.com/photo/1.jpg")))
    }

    @Test
    fun headlessWebViewNavigatesOnlyWithinItsAssetOrigin() {
        val svc = newService()
        svc.command(AutoVoteService.ACTION_START)
        idle()
        val wv = svc.webView()!!
        val client = shadowOf(wv).webViewClient

        // false: let the WebView load it; true: it is cancelled.
        assertFalse(client.shouldOverrideUrlLoading(wv, request(HEADLESS_URL)))
        assertFalse(client.shouldOverrideUrlLoading(wv, request("https://appassets.androidplatform.net/assets/public/other.html")))
        assertTrue(client.shouldOverrideUrlLoading(wv, null as WebResourceRequest?))
        assertTrue(client.shouldOverrideUrlLoading(wv, request("https://example.com/")))
        assertTrue(client.shouldOverrideUrlLoading(wv, request("https://appassets.androidplatform.net.evil.example/")))
        assertTrue(client.shouldOverrideUrlLoading(wv, request("http://appassets.androidplatform.net/assets/public/headless.html")))
        assertTrue(client.shouldOverrideUrlLoading(wv, request("file:///android_asset/public/headless.html")))
        assertTrue(client.shouldOverrideUrlLoading(wv, request("intent://scan/#Intent;scheme=zxing;end")))
    }

    private fun sideStoreContext(): Context = ApplicationProvider.getApplicationContext()

    @Test
    fun aSideStoreIsSavedByCompareAndSetOnlyWhileItHoldsWhatTheCallerRead() {
        val ctx = sideStoreContext()
        // Nothing stored: an absent (null or empty) expectation matches, a value does not.
        assertEquals(SideStores.Outcome.MISMATCH, SideStores.compareAndSet(ctx, "gs_join_state", "{\"a\":1}", "{\"b\":1}").outcome)
        assertEquals(SideStores.Outcome.SAVED, SideStores.compareAndSet(ctx, "gs_join_state", null, "{\"a\":1}").outcome)
        // Stored now: the one who read nothing is told what is there, and saves nothing.
        val lost = SideStores.compareAndSet(ctx, "gs_join_state", "", "{\"b\":1}")
        assertEquals(SideStores.Outcome.MISMATCH, lost.outcome)
        assertEquals("{\"a\":1}", lost.current)
        assertEquals("{\"a\":1}", SideStores.read(ctx, "gs_join_state"))
        // The one who read it saves.
        assertEquals(SideStores.Outcome.SAVED, SideStores.compareAndSet(ctx, "gs_join_state", "{\"a\":1}", "{\"a\":1,\"b\":1}").outcome)
        assertEquals("{\"a\":1,\"b\":1}", SideStores.read(ctx, "gs_join_state"))
    }

    @Test
    fun aCompareAndSetRefusesWhatIsNotASideStoreOrNotOneBoundedJsonObject() {
        val ctx = sideStoreContext()
        ShadowLog.clear()
        assertEquals(SideStores.Outcome.REFUSED, SideStores.compareAndSet(ctx, "unrelated-key", null, "{}").outcome)
        assertEquals(SideStores.Outcome.REFUSED, SideStores.compareAndSet(ctx, "gs_join_state", null, "[1]").outcome)
        assertEquals(SideStores.Outcome.REFUSED, SideStores.compareAndSet(ctx, "gs_join_state", null, "{} trailing").outcome)
        assertEquals(SideStores.Outcome.REFUSED, SideStores.compareAndSet(ctx, "gs_join_state", null, "{}{}").outcome)
        assertEquals(SideStores.Outcome.REFUSED, SideStores.compareAndSet(ctx, "gs_join_state", null, "").outcome)
        val big = "{\"k\":\"" + "x".repeat(SideStores.MAX_BYTES) + "\"}"
        assertEquals(SideStores.Outcome.TOO_LARGE, SideStores.compareAndSet(ctx, "gs_join_state", null, big).outcome)
        assertNull(SideStores.read(ctx, "gs_join_state"))
        assertNull(SideStores.read(ctx, "unrelated-key"))
        // Refusals name the store from a literal, and the rejected key is silent.
        assertEquals(
            listOf(
                "Refusing to persist non-JSON join-state blob",
                "Refusing to persist non-JSON join-state blob",
                "Refusing to persist non-JSON join-state blob",
                "Refusing to persist non-JSON join-state blob",
                "Refusing to persist oversized join-state blob"
            ),
            ShadowLog.getLogsForTag(AutoVoteService.TAG).map { it.msg }
        )
        // A write takes the same checks.
        assertFalse(SideStores.write(ctx, "gs_join_state", "{} trailing"))
    }

    @Test
    fun aCompareAndSetThatCannotCommitIsRefusedAndSaysWhatIsStored() {
        val ctx = mockk<Context>()
        val prefs = mockk<android.content.SharedPreferences>()
        val editor = mockk<android.content.SharedPreferences.Editor>()
        every { ctx.getSharedPreferences(SideStores.PREFS_FILE, Context.MODE_PRIVATE) } returns prefs
        every { prefs.getString("gs_join_state", null) } returns "{\"a\":1}"
        every { prefs.edit() } returns editor
        every { editor.putString("gs_join_state", "{\"b\":1}") } returns editor
        every { editor.putString("gs_join_state", "{\"a\":1}") } returns editor
        every { editor.commit() } returnsMany listOf(false, true)
        val result = SideStores.compareAndSet(ctx, "gs_join_state", "{\"a\":1}", "{\"b\":1}")
        assertEquals(SideStores.Outcome.REFUSED, result.outcome)
        assertEquals("{\"a\":1}", result.current)
        // The commit that failed had already made the new value readable in memory: the old one is put back.
        verifyOrder {
            editor.putString("gs_join_state", "{\"b\":1}")
            editor.commit()
            editor.putString("gs_join_state", "{\"a\":1}")
            editor.commit()
        }
    }

    @Test
    fun aCommitThatFailsLeavesNeitherAPlainWriteNorACompareAndSetReadable() {
        val ctx = mockk<Context>()
        val prefs = mockk<android.content.SharedPreferences>()
        val editor = mockk<android.content.SharedPreferences.Editor>()
        every { ctx.getSharedPreferences(SideStores.PREFS_FILE, Context.MODE_PRIVATE) } returns prefs
        every { prefs.edit() } returns editor
        every { editor.putString(any(), any()) } returns editor
        every { editor.remove(any()) } returns editor
        every { editor.commit() } returnsMany listOf(false, true)
        // Nothing was stored: the failed value is removed again.
        every { prefs.getString("gs_swap_backs", null) } returns null
        assertFalse(SideStores.write(ctx, "gs_swap_backs", "{\"7\":{\"fills\":1,\"at\":1}}"))
        verifyOrder {
            editor.putString("gs_swap_backs", "{\"7\":{\"fills\":1,\"at\":1}}")
            editor.commit()
            editor.remove("gs_swap_backs")
            editor.commit()
        }
        // Something was: it is put back.
        every { editor.commit() } returnsMany listOf(false, true)
        every { prefs.getString("gs_swap_backs", null) } returns "{\"7\":{\"fills\":0,\"at\":1}}"
        assertFalse(SideStores.write(ctx, "gs_swap_backs", "{\"7\":{\"fills\":1,\"at\":1}}"))
        verify { editor.putString("gs_swap_backs", "{\"7\":{\"fills\":0,\"at\":1}}") }
    }

    @Test
    fun twoContextsChangingOneStoreFromTheSameReadSaveExactlyOne() {
        val ctx = sideStoreContext()
        repeat(40) { round ->
            val key = "gs_swap_backs"
            SideStores.write(ctx, key, "{}")
            val saved = java.util.concurrent.atomic.AtomicInteger(0)
            val start = java.util.concurrent.CountDownLatch(1)
            val threads = listOf("service", "window").map { who ->
                Thread {
                    start.await()
                    if (SideStores.compareAndSet(ctx, key, "{}", "{\"$who\":$round}").outcome == SideStores.Outcome.SAVED) {
                        saved.incrementAndGet()
                    }
                }
            }
            threads.forEach { it.start() }
            start.countDown()
            threads.forEach { it.join() }
            assertEquals(1, saved.get())
        }
    }

    @Test
    fun theBridgeComparesAndWritesThroughTheSameLock() {
        val store = newService().HeadlessStore()
        assertTrue(store.compareAndWriteKey("gs_join_state", null, "{\"a\":1}"))
        assertFalse(store.compareAndWriteKey("gs_join_state", "", "{\"b\":1}"))
        assertEquals("{\"a\":1}", store.readKey("gs_join_state"))
        assertTrue(store.compareAndWriteKey("gs_join_state", "{\"a\":1}", "{\"a\":1,\"b\":1}"))
        assertFalse(store.compareAndWriteKey("unrelated-key", null, "{}"))
        assertFalse(store.compareAndWriteKey("gs_join_state", "{\"a\":1,\"b\":1}", "{} x"))
        // A plain write is held to the same size and shape.
        assertFalse(store.writeKey("gs_join_state", "{} x"))
    }

    @Test
    fun headlessSideStoresUseOnlyTheAllowedPreferenceKeys() {
        val store = newService().HeadlessStore()
        ShadowLog.clear()
        // A write answers whether it persisted: true for an allowed key and valid JSON, false for anything refused.
        assertTrue(store.writeKey("gs_lexicon_diagnostics", "{\"challenges\":1}"))
        assertEquals("{\"challenges\":1}", store.readKey("gs_lexicon_diagnostics"))
        assertFalse(store.writeKey("unrelated-key", "{\"challenges\":2}"))
        assertNull(store.readKey("unrelated-key"))
        assertFalse(store.writeKey("gs_lexicon_diagnostics", "invalid JSON"))
        assertEquals("{\"challenges\":1}", store.readKey("gs_lexicon_diagnostics"))
        assertTrue(store.writeKey("gs_scenario_state", "{\"7\":{\"phase\":\"buildup\"}}"))
        assertEquals("{\"7\":{\"phase\":\"buildup\"}}", store.readKey("gs_scenario_state"))
        assertFalse(store.writeKey("gs_scenario_state", "invalid JSON"))
        assertEquals("{\"7\":{\"phase\":\"buildup\"}}", store.readKey("gs_scenario_state"))
        // The resets the app asks for are a side store of their own.
        assertTrue(store.writeKey("gs_scenario_resets", "{\"7\":1}"))
        assertEquals("{\"7\":1}", store.readKey("gs_scenario_resets"))
        assertFalse(store.writeKey("gs_scenario_resets", "invalid JSON"))
        assertEquals("{\"7\":1}", store.readKey("gs_scenario_resets"))
        // The ledger of the automatic currency spends is a side store too (the fills spent survive a restart), changed
        // by compare-and-set only: a plain write would replace what the other context saved.
        assertFalse(store.writeKey("gs_auto_spends", "{\"7\":{\"fills\":1,\"at\":1}}"))
        assertNull(store.readKey("gs_auto_spends"))
        assertTrue(store.compareAndWriteKey("gs_auto_spends", null, "{\"7\":{\"fills\":1,\"at\":1}}"))
        assertEquals("{\"7\":{\"fills\":1,\"at\":1}}", store.readKey("gs_auto_spends"))
        assertFalse(store.compareAndWriteKey("gs_auto_spends", "{\"7\":{\"fills\":1,\"at\":1}}", "invalid JSON"))
        assertEquals("{\"7\":{\"fills\":1,\"at\":1}}", store.readKey("gs_auto_spends"))
        assertTrue(store.writeKey("gs_swap_backs", "{\"7\":[]}"))
        assertEquals("{\"7\":[]}", store.readKey("gs_swap_backs"))
        assertFalse(store.writeKey("gs_swap_backs", "invalid JSON"))
        assertEquals("{\"7\":[]}", store.readKey("gs_swap_backs"))
        // The paid-join claims are a side store too (a claim that did not survive a restart would charge twice), but
        // changed by compare-and-set only: a plain write would replace what the other context saved.
        assertFalse(store.writeKey("gs_join_state", "{\"7:9\":{\"unlockedAt\":1}}"))
        assertNull(store.readKey("gs_join_state"))
        assertTrue(store.compareAndWriteKey("gs_join_state", null, "{\"7:9\":{\"unlockedAt\":1}}"))
        assertEquals("{\"7:9\":{\"unlockedAt\":1}}", store.readKey("gs_join_state"))
        assertFalse(store.compareAndWriteKey("gs_join_state", "{\"7:9\":{\"unlockedAt\":1}}", "invalid JSON"))
        assertEquals("{\"7:9\":{\"unlockedAt\":1}}", store.readKey("gs_join_state"))
        // A refusal names the store from a literal — the JS-supplied key never
        // reaches the log line (CodeQL java/log-injection), and the rejected
        // key is silent.
        assertEquals(
            listOf(
                "Refusing to persist non-JSON lexicon diagnostics blob",
                "Refusing to persist non-JSON scenario state blob",
                "Refusing to persist non-JSON scenario resets blob",
                "Refusing a plain write of auto-spend ledger blob: it is changed by compare-and-set only",
                "Refusing to persist non-JSON auto-spend ledger blob",
                "Refusing to persist non-JSON swap-back ledger blob",
                "Refusing a plain write of join-state blob: it is changed by compare-and-set only",
                "Refusing to persist non-JSON join-state blob"
            ),
            ShadowLog.getLogsForTag(AutoVoteService.TAG).map { it.msg }
        )
    }

    @Test
    fun theImportMarkerAndTheTitlePinsAreSideStoresTheServiceWritesPlainly() {
        val store = newService().HeadlessStore()
        ShadowLog.clear()
        // Neither is shared with the window by compare-and-set: the service reads and writes each as it is.
        assertNull(store.readKey("gs_v2_import"))
        assertTrue(store.writeKey("gs_v2_import", """{"importedAt":"2026-10-16T00:00:00.000Z"}"""))
        assertEquals("""{"importedAt":"2026-10-16T00:00:00.000Z"}""", store.readKey("gs_v2_import"))
        assertTrue(store.writeKey("gs_title_pins", """{"7":"Sunsets"}"""))
        assertEquals("""{"7":"Sunsets"}""", store.readKey("gs_title_pins"))
        // Both are held to the shape and the side stores' cap.
        assertFalse(store.writeKey("gs_v2_import", "invalid JSON"))
        assertFalse(store.writeKey("gs_title_pins", """{"7":"${"x".repeat(SideStores.MAX_BYTES)}"}"""))
        assertEquals("""{"importedAt":"2026-10-16T00:00:00.000Z"}""", store.readKey("gs_v2_import"))
        assertEquals("""{"7":"Sunsets"}""", store.readKey("gs_title_pins"))
        assertEquals(
            listOf(
                "Refusing to persist non-JSON import marker blob",
                "Refusing to persist oversized title pins blob"
            ),
            ShadowLog.getLogsForTag(AutoVoteService.TAG).map { it.msg }
        )
        // The window changes them by compare-and-set too (its plugin call takes the same lock).
        assertTrue(store.compareAndWriteKey("gs_title_pins", """{"7":"Sunsets"}""", """{"7":"Sunsets","8":"Dusk"}"""))
        assertFalse(store.compareAndWriteKey("gs_title_pins", """{"7":"Sunsets"}""", """{"7":"Other"}"""))
    }

    @Test
    fun theConfigurationIsReadAndSavedThroughTheBridgeByCompareAndSetOnly() {
        val store = newService().HeadlessStore()
        ShadowLog.clear()
        // The keyed calls reach it like any side store...
        assertNull(store.readKey("gurushots-config"))
        assertTrue(store.compareAndWriteKey("gurushots-config", null, """{"version":2}"""))
        assertEquals("""{"version":2}""", store.readKey("gurushots-config"))
        assertEquals("""{"version":2}""", TestSupport.readConfig(app))
        assertFalse(store.compareAndWriteKey("gurushots-config", "", """{"version":2,"x":1}"""))
        // ...but a plain write would replace what the window saved, so none is taken.
        assertFalse(store.writeKey("gurushots-config", """{"version":2,"x":2}"""))
        assertEquals("""{"version":2}""", TestSupport.readConfig(app))
        assertEquals(
            listOf("Refusing a plain write of config blob: it is changed by compare-and-set only"),
            ShadowLog.getLogsForTag(AutoVoteService.TAG).map { it.msg }
        )
        // It carries the settings cap (2 MiB), not the side stores' (256 KiB).
        val past = """{"k":"${"x".repeat(SideStores.MAX_BYTES * 4)}"}"""
        assertTrue(store.compareAndWriteKey("gurushots-config", """{"version":2}""", past))
        val over = """{"k":"${"x".repeat(SideStores.MAX_SETTINGS_BYTES)}"}"""
        assertEquals(SideStores.Outcome.TOO_LARGE, SideStores.compareAndSet(app, "gurushots-config", past, over).outcome)
        assertEquals(past, TestSupport.readConfig(app))
    }

    @Test
    fun theDedicatedReadAndWriteAreTheConfigurationsAndNeverTheOneXBlobs() {
        val store = newService().HeadlessStore()
        TestSupport.writeLegacySettings(app, """{"token":"old"}""")
        TestSupport.writeConfig(app, null)
        assertNull(store.read())
        assertTrue(store.write("""{"version":2}"""))
        assertEquals("""{"version":2}""", TestSupport.readConfig(app))
        assertEquals("""{"token":"old"}""", TestSupport.readLegacySettings(app))
        TestSupport.writeConfig(app, """{"version":2,"x":1}""")
        assertEquals("""{"version":2,"x":1}""", store.read())
    }

    @Test
    fun theSettingsJsonBlobIsReachableThroughTheKeyedCallsByCompareAndSetOnly() {
        val store = newService().HeadlessStore()
        ShadowLog.clear()
        TestSupport.writeLegacySettings(app, """{"token":"t","language":"lv"}""")
        assertEquals("""{"token":"t","language":"lv"}""", store.readKey("gurushots-settings"))
        // A plain write would replace what the window mirrored (or the import read).
        assertFalse(store.writeKey("gurushots-settings", """{"language":"lv"}"""))
        assertEquals("""{"token":"t","language":"lv"}""", TestSupport.readLegacySettings(app))
        assertEquals(
            listOf("Refusing a plain write of settings blob: it is changed by compare-and-set only"),
            ShadowLog.getLogsForTag(AutoVoteService.TAG).map { it.msg }
        )
        // The mirror of the configuration is a change of what was read.
        assertFalse(store.compareAndWriteKey("gurushots-settings", """{"token":"other"}""", """{"token":"","language":"lv"}"""))
        assertTrue(store.compareAndWriteKey("gurushots-settings", """{"token":"t","language":"lv"}""", """{"token":"","language":"lv"}"""))
        assertEquals("""{"token":"","language":"lv"}""", TestSupport.readLegacySettings(app))
        assertNull(TestSupport.readConfig(app))
        // It keeps the settings cap.
        val past = """{"k":"${"x".repeat(SideStores.MAX_BYTES * 4)}"}"""
        assertTrue(store.compareAndWriteKey("gurushots-settings", """{"token":"","language":"lv"}""", past))
        val over = """{"k":"${"x".repeat(SideStores.MAX_SETTINGS_BYTES)}"}"""
        assertEquals(SideStores.Outcome.TOO_LARGE, SideStores.compareAndSet(app, "gurushots-settings", past, over).outcome)
        assertEquals(past, TestSupport.readLegacySettings(app))
    }

    @Test
    fun theCopyKeptOfTheFileTheUserHadIsWrittenOnceByCompareAndSetOnly() {
        val store = newService().HeadlessStore()
        val key = SideStores.ORIGINAL_SETTINGS_KEY
        assertEquals("gurushots-settings_original", key)
        assertTrue(SideStores.isAllowed(key))
        assertNull(store.readKey(key))
        ShadowLog.clear()
        // A plain write would replace the copy: it is taken by compare-and-set only, as "nothing stored yet".
        assertFalse(store.writeKey(key, """{"token":"t"}"""))
        assertEquals(
            listOf("Refusing a plain write of settings copy blob: it is changed by compare-and-set only"),
            ShadowLog.getLogsForTag(AutoVoteService.TAG).map { it.msg }
        )
        assertTrue(store.compareAndWriteKey(key, "", """{"token":"t"}"""))
        assertEquals("""{"token":"t"}""", store.readKey(key))
        // Once it is there, a second copy does not replace it.
        assertFalse(store.compareAndWriteKey(key, "", """{"token":"other"}"""))
        assertEquals("""{"token":"t"}""", store.readKey(key))
        // It keeps the settings cap, not the side stores'.
        val past = """{"k":"${"x".repeat(SideStores.MAX_BYTES * 4)}"}"""
        assertTrue(store.compareAndWriteKey(key, """{"token":"t"}""", past))
        val over = """{"k":"${"x".repeat(SideStores.MAX_SETTINGS_BYTES)}"}"""
        assertEquals(SideStores.Outcome.TOO_LARGE, SideStores.compareAndSet(app, key, past, over).outcome)
    }

    @Test
    fun theSetAsideCopiesOfAnUnusableConfigurationAreNotKeysTheBridgeTakes() {
        // They are written and removed by the app window through Preferences itself, and the service never reads them.
        val store = newService().HeadlessStore()
        val prefs = app.getSharedPreferences(SideStores.PREFS_FILE, Context.MODE_PRIVATE)
        for (key in listOf(
            "gurushots-config_corrupt-2026-10-16T08-00-00-000Z",
            "gurushots-settings_corrupt-2026-10-16T08-00-00-000Z",
            "gurushots-settings_unimportable-2026-10-16T08-00-00-000Z",
            "gurushots-config_corrupt",
            "gurushots-config-extra",
            "gs_v2_import_extra"
        )) {
            prefs.edit().putString(key, """{"a":1}""").commit()
            assertFalse(key, SideStores.isAllowed(key))
            assertNull(key, store.readKey(key))
            assertFalse(key, store.writeKey(key, """{"a":2}"""))
            assertFalse(key, store.compareAndWriteKey(key, """{"a":1}""", """{"a":2}"""))
            assertEquals(key, """{"a":1}""", prefs.getString(key, null))
        }
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
    fun aStaleAlarmEntersTheForegroundBeforeItStopsTheService() {
        // The alarm fired after a STOP (or after a wipe): automation is not enabled.
        val svc = newService()
        assertEquals(Service.START_STICKY, svc.command(AutoVoteService.ACTION_RUN_CYCLE))
        idle()
        // startForeground answered the start request, then the service left the foreground and stopped.
        assertEquals(AutoVoteService.NOTIFICATION_ID, shadowOf(svc).lastForegroundNotificationId)
        assertTrue(shadowOf(svc).isForegroundStopped)
        assertTrue(shadowOf(svc).isStoppedBySelf)
        assertFalse(AutoVoteService.isRunning)
        assertNull(svc.webView())
        assertNull(nextAlarm())
        assertNull(ShadowPowerManager.getLatestWakeLock())
    }

    @Test
    fun aStaleAlarmStillStopsTheServiceWhenTheSystemRefusesTheForeground() {
        val svc = newService()
        shadowOf(svc).setThrowInStartForeground(ForegroundServiceStartNotAllowedException("background"))
        svc.command(AutoVoteService.ACTION_RUN_CYCLE)
        idle()
        assertTrue(shadowOf(svc).isStoppedBySelf)
        assertNull(nextAlarm())
        assertFalse(ServiceState.isEnabled(app))
    }

    @Test
    fun anAlarmAfterTheProcessWasKilledResumesFromThePersistedState() {
        ServiceState.setEnabled(app, true)
        ServiceState.record(app, 7, System.currentTimeMillis(), "no-token")
        // The statics a fresh process starts from.
        val svc = newService()
        assertFalse(AutoVoteService.isRunning)

        svc.command(AutoVoteService.ACTION_RUN_CYCLE)
        idle()

        assertTrue(AutoVoteService.isRunning)
        assertEquals(7, AutoVoteService.cycleCount)
        assertEquals("no-token", AutoVoteService.lastError)
        assertTrue(AutoVoteService.lastRunAtMillis > 0)
        // It entered the foreground, with the status it had, and went on to the cycle (the page is not loaded yet).
        val text = shadowOf(svc).lastForegroundNotification.extras.getCharSequence(Notification.EXTRA_TEXT).toString()
        assertTrue(text, text.matches(Regex("""Last error at \d\d:\d\d:\d\d: Not logged in — open the app and log in""")))
        assertNotNull(svc.webView())
        assertAlarmIn(3_000L)
        assertFalse(shadowOf(svc).isStoppedBySelf)
    }

    @Test
    fun aResumeThatHasRunNoCycleShowsTheStartingText() {
        ServiceState.setEnabled(app, true)
        val svc = newService()
        svc.command(AutoVoteService.ACTION_RUN_CYCLE)
        idle()
        assertEquals(
            "Auto-vote starting…",
            shadowOf(svc).lastForegroundNotification.extras.getCharSequence(Notification.EXTRA_TEXT).toString(),
        )
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
        // The alarm re-created the service while the process (and its running flag) survived: the new instance has
        // no WebView.
        ServiceState.setEnabled(app, true)
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
        // What the app window reads is persisted, not just the statics.
        val saved = ServiceState.status(app)
        assertTrue(saved.running)
        assertEquals(1, saved.cycleCount)
        assertEquals(AutoVoteService.lastRunAtMillis, saved.lastRunAt)
        assertNull(saved.lastError)

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
        assertEquals("no-token", ServiceState.status(app).lastError)
        assertTrue(notificationText()!!.endsWith(": Not logged in — open the app and log in"))

        // A code this build does not know — API-derived text included — is shown as the generic text, never as itself.
        runCycle(svc)
        svc.HeadlessBridge().onCycleComplete("""{"ok":false,"error":"HTTP 503 for user 42"}""")
        idle()
        assertEquals("HTTP 503 for user 42", AutoVoteService.lastError)
        assertTrue(
            notificationText()!!.matches(Regex("""Last error at \d\d:\d\d:\d\d: Something went wrong — will retry""")),
        )

        // An empty error string clears the error.
        runCycle(svc)
        svc.HeadlessBridge().onCycleComplete("""{"ok":true,"error":""}""")
        idle()
        assertNull(AutoVoteService.lastError)
        assertEquals(3, AutoVoteService.cycleCount)
    }

    @Test
    fun everyErrorCodeHasItsOwnTranslatedNotificationText() {
        val english = mapOf(
            "no-token" to "Not logged in — open the app and log in",
            "cycle-timeout" to "Timed out — will retry",
            "voting-failed" to "Voting did not finish — will retry",
            "cycle-failed" to "The cycle failed — will retry",
            "not-loaded" to "Background voting is not ready — will retry",
            AutoVoteService.ERROR_FGS_TIMEOUT to "Stopped by the system — will resume",
            AutoVoteService.ERROR_FGS_NOT_ALLOWED to "The system did not allow background voting — will retry",
            "anything-else" to "Something went wrong — will retry",
        )
        val latvian = mapOf(
            "no-token" to "Pieteikšanās nav veikta — atver lietotni un piesakies",
            "cycle-timeout" to "Laiks beidzies — mēģināšu vēlreiz",
            "voting-failed" to "Balsošana nav pabeigta — mēģināšu vēlreiz",
            "cycle-failed" to "Cikls neizdevās — mēģināšu vēlreiz",
            "not-loaded" to "Fona balsošana vēl nav gatava — mēģināšu vēlreiz",
            AutoVoteService.ERROR_FGS_TIMEOUT to "Sistēma apturēja fona darbu — atsāksies nākamajā reizē",
            AutoVoteService.ERROR_FGS_NOT_ALLOWED to "Sistēma neļāva palaist fona balsošanu — mēģināšu vēlreiz",
            "anything-else" to "Kaut kas nogāja greizi — mēģināšu vēlreiz",
        )
        for ((language, expected) in listOf("en" to english, "lv" to latvian)) {
            settings("""{"language":"$language"}""")
            val svc = startedAndReady()
            for ((code, text) in expected) {
                runCycle(svc)
                svc.HeadlessBridge().onCycleComplete("""{"ok":false,"error":"$code"}""")
                idle()
                assertTrue("$language $code", notificationText()!!.endsWith(": $text"))
            }
            svc.command(AutoVoteService.ACTION_STOP)
            idle()
        }
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
        assertFalse(ServiceState.isEnabled(app))
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
        // What was persisted while it ran stays what the window reads: the late report changes nothing there.
        assertEquals(1, ServiceState.status(app).cycleCount)
        assertFalse(ServiceState.status(app).running)
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
        TestSupport.writeConfig(app, null)
        assertNull(store.read())

        assertTrue(store.write("""{"token":"abc"}"""))
        assertEquals("""{"token":"abc"}""", TestSupport.readConfig(app))
        assertEquals("""{"token":"abc"}""", store.read())

        // Non-JSON is refused so the token-bearing blob can't be corrupted.
        assertFalse(store.write("{oops"))
        assertEquals("""{"token":"abc"}""", TestSupport.readConfig(app))
    }

    @Test
    fun theSettingsBlobMustBeOneJsonObjectWithinItsOwnCap() {
        val store = newService().HeadlessStore()
        ShadowLog.clear()
        assertTrue(store.write("""{"token":"abc"}"""))
        // Arrays, scalars and anything trailing are not settings.
        for (bad in listOf("[1]", "42", "\"x\"", "null", """{"token":"abc"} trailing""", """{}{}""", "")) {
            assertFalse(bad, store.write(bad))
        }
        assertEquals("""{"token":"abc"}""", TestSupport.readConfig(app))

        // The cap is the settings one (2 MiB), not the side stores' (256 KiB).
        val beyondSideStoreCap = """{"k":"${"x".repeat(SideStores.MAX_BYTES * 4)}"}"""
        assertTrue(store.write(beyondSideStoreCap))
        assertEquals(beyondSideStoreCap, TestSupport.readConfig(app))
        val exactlyAtCap = """{"k":"${"x".repeat(SideStores.MAX_SETTINGS_BYTES - 8)}"}"""
        assertEquals(SideStores.MAX_SETTINGS_BYTES, exactlyAtCap.toByteArray().size)
        assertTrue(store.write(exactlyAtCap))
        val overCap = """{"k":"${"x".repeat(SideStores.MAX_SETTINGS_BYTES - 7)}"}"""
        assertFalse(store.write(overCap))
        assertEquals(exactlyAtCap, TestSupport.readConfig(app))

        // The reason a write was not saved is told apart: an oversize blob is not a conflict.
        assertEquals("too-large", store.lastWriteRefusal())

        // A refusal says which blob and why, never what it held.
        val logged = ShadowLog.getLogsForTag(AutoVoteService.TAG).map { it.msg }
        assertEquals("Refusing to persist oversized config blob", logged.last())
        assertTrue(logged.dropLast(1).all { it == "Refusing to persist non-JSON config blob" })
        assertTrue(logged.none { it.contains("trailing") || it.contains("token") })

        assertFalse(store.write("[1]"))
        assertEquals("refused", store.lastWriteRefusal())
        assertTrue(store.write(exactlyAtCap))
        assertEquals("", store.lastWriteRefusal())
    }

    @Test
    fun aPlainSideStoreWriteIsRefusedPastTheSideStoreCap() {
        val ctx = sideStoreContext()
        assertFalse(SideStores.write(ctx, "gs_lexicon_diagnostics", """{"k":"${"x".repeat(SideStores.MAX_BYTES)}"}"""))
        assertNull(SideStores.read(ctx, "gs_lexicon_diagnostics"))
    }

    @Test
    fun aSettingsWriteOnABlobTheWindowChangedIsReportedAsAConflictNotTooLarge() {
        val store = newService().HeadlessStore()
        TestSupport.writeConfig(app, """{"a":1}""")
        assertEquals("""{"a":1}""", store.read())
        TestSupport.writeConfig(app, """{"a":2}""")
        assertFalse(store.write("""{"a":3}"""))
        assertEquals("conflict", store.lastWriteRefusal())
    }

    @Test
    fun aRealisticallyLargeSettingsBlobStaysFarBelowTheCap() {
        // 400 challenges, each with 60 overrides of mixed kinds: far more than anyone accumulates.
        val perChallenge = (1..60).joinToString(",") { i ->
            when (i % 3) {
                0 -> """"setting$i":true"""
                1 -> """"setting$i":${i * 7}"""
                else -> """"setting$i":"value-$i""""
            }
        }
        val blob = """{"token":"${"t".repeat(600)}","challengeSettings":{""" +
            (1..400).joinToString(",") { """"challenge-$it":{$perChallenge}""" } + "}}"
        val size = blob.toByteArray(Charsets.UTF_8).size
        assertTrue("$size bytes", size > 400 * 1024)
        assertTrue("$size bytes", size < SideStores.MAX_SETTINGS_BYTES / 4)
        assertTrue(newService().HeadlessStore().write(blob))
    }

    @Test
    fun aSettingsWriteThatCannotCommitIsRefusedAndTheOldBlobStays() {
        val ctx = mockk<Context>()
        val prefs = mockk<android.content.SharedPreferences>()
        val editor = mockk<android.content.SharedPreferences.Editor>()
        every { ctx.getSharedPreferences(SideStores.PREFS_FILE, Context.MODE_PRIVATE) } returns prefs
        every { prefs.getString("gurushots-config", null) } returns """{"token":"old"}"""
        every { prefs.edit() } returns editor
        every { editor.putString(any(), any()) } returns editor
        every { editor.commit() } returnsMany listOf(false, true)

        val result = SideStores.compareAndSet(ctx, "gurushots-config", """{"token":"old"}""", """{"token":"new"}""")
        assertEquals(SideStores.Outcome.REFUSED, result.outcome)

        verifyOrder {
            editor.putString("gurushots-config", """{"token":"new"}""")
            editor.commit()
            editor.putString("gurushots-config", """{"token":"old"}""")
            editor.commit()
        }
    }

    @Test
    fun aSettingsWriteFromAnOlderReadIsNotSavedAndTheNextReadSeesWhatTheWindowSaved() {
        val store = newService().HeadlessStore()
        TestSupport.writeConfig(app, """{"theme":"dark"}""")
        assertEquals("""{"theme":"dark"}""", store.read())

        // The window saved another setting after the service read.
        TestSupport.writeConfig(app, """{"theme":"dark","language":"lv"}""")
        assertFalse(store.write("""{"theme":"dark","token":"abc"}"""))
        assertEquals("""{"theme":"dark","language":"lv"}""", TestSupport.readConfig(app))

        // Read again, make the change on what is there: saved, and a following write builds on it.
        assertEquals("""{"theme":"dark","language":"lv"}""", store.read())
        assertTrue(store.write("""{"theme":"dark","language":"lv","token":"abc"}"""))
        assertTrue(store.write("""{"theme":"dark","language":"lv","token":"abc","x":1}"""))
        assertEquals("""{"theme":"dark","language":"lv","token":"abc","x":1}""", TestSupport.readConfig(app))
    }

    @Test
    fun aSettingsWriteBeforeAnyReadIsSavedOnlyWhereNothingIsStored() {
        val store = newService().HeadlessStore()
        TestSupport.writeConfig(app, null)
        assertTrue(store.write("""{"token":"abc"}"""))

        val other = newService().HeadlessStore()
        assertFalse(other.write("""{"token":"zzz"}"""))
        assertEquals("""{"token":"abc"}""", TestSupport.readConfig(app))
    }

    @Test
    fun theSettingsBlobIsNeverReplacedByAPlainWrite() {
        val ctx = sideStoreContext()
        TestSupport.writeConfig(app, """{"theme":"dark"}""")
        ShadowLog.clear()
        assertFalse(SideStores.write(ctx, "gurushots-config", """{"theme":"light"}"""))
        assertEquals("""{"theme":"dark"}""", TestSupport.readConfig(app))
        assertEquals(
            listOf("Refusing a plain write of config blob: it is changed by compare-and-set only"),
            ShadowLog.getLogsForTag(AutoVoteService.TAG).map { it.msg }
        )
    }

    @Test
    fun theWindowAndTheServiceChangingTheSettingsFromTheSameReadSaveExactlyOne() {
        val ctx = sideStoreContext()
        repeat(40) { round ->
            TestSupport.writeConfig(app, "{}")
            val saved = java.util.concurrent.atomic.AtomicInteger(0)
            val start = java.util.concurrent.CountDownLatch(1)
            val threads = listOf("service", "window").map { who ->
                Thread {
                    start.await()
                    val outcome = SideStores.compareAndSet(ctx, "gurushots-config", "{}", "{\"$who\":$round}").outcome
                    if (outcome == SideStores.Outcome.SAVED) saved.incrementAndGet()
                }
            }
            threads.forEach { it.start() }
            start.countDown()
            threads.forEach { it.join() }
            assertEquals(1, saved.get())
        }
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
    fun defaultHttpClientDoesNotFollowRedirects() {
        val client = originalFactory()
        assertFalse(client.followRedirects)
        assertFalse(client.followSslRedirects)
    }

    @Test
    fun serverErrorIsPassedThroughWithoutARedirectLog() {
        val s = startServer()
        s.enqueue(MockResponse.Builder().code(503).body("busy").build())
        val svc = startedAndReady()

        svc.HeadlessHttp().request(22, "POST", "https://api.gurushots.com/x", "{}", "")

        assertEquals(503, httpResolution(svc, 22).getInt("status"))
        assertTrue(ShadowLog.getLogsForTag(AutoVoteService.TAG).none { it.msg.contains("redirect not followed") })
    }

    @Test
    fun redirectToANonAllowlistedHostIsNotFollowedAndIsLogged() {
        val s = MockWebServer()
        s.start()
        server = s
        // The real default client, with only the host rerouted to the mock server.
        AutoVoteService.httpClientFactory = { TestSupport.reroutingClient(s, builder = originalFactory().newBuilder()) }
        s.enqueue(MockResponse.Builder().code(302).addHeader("Location", "https://evil.example/steal").build())
        val svc = startedAndReady()

        svc.HeadlessHttp().request(21, "POST", "https://api.gurushots.com/x", """{"x-token":"tok"}""", "")

        val res = httpResolution(svc, 21)
        assertEquals(302, res.getInt("status"))
        assertEquals("https://evil.example/steal", res.getJSONObject("headers").getString("location"))
        assertEquals(1, s.requestCount)
        assertTrue(
            ShadowLog.getLogsForTag(AutoVoteService.TAG).any {
                it.msg.contains("302") && it.msg.contains("redirect not followed") && it.msg.contains("https://evil.example/steal")
            },
        )
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

    // ---------- foreground limits ----------

    @Test
    fun aStartTheSystemRefusesIsRecordedAndRetriedAtTheNextAlarm() {
        settings("""{"checkFrequencyMin":4}""")
        val svc = newService()
        shadowOf(svc).setThrowInStartForeground(ForegroundServiceStartNotAllowedException("background"))

        assertEquals(Service.START_STICKY, svc.command(AutoVoteService.ACTION_START))
        idle()

        assertFalse(AutoVoteService.isRunning)
        assertEquals(AutoVoteService.ERROR_FGS_NOT_ALLOWED, AutoVoteService.lastError)
        val saved = ServiceState.status(app)
        // Automation stays enabled: the alarm tries again.
        assertTrue(saved.running)
        assertEquals(AutoVoteService.ERROR_FGS_NOT_ALLOWED, saved.lastError)
        assertAlarmIn(4 * MINUTE)
        assertTrue(shadowOf(svc).isStoppedBySelf)
        assertNull(svc.webView())
        assertTrue(
            ShadowLog.getLogsForTag(AutoVoteService.TAG).any {
                it.msg == "The system refused to start the foreground service (ForegroundServiceStartNotAllowedException)"
            },
        )
    }

    @Test
    fun anAlarmCycleTheSystemRefusesTheForegroundForIsRecordedAndRescheduled() {
        val svc = startedAndReady()
        AutoVoteService.cycleCount = 2
        shadowOf(svc).setThrowInStartForeground(IllegalStateException("not allowed"))

        runCycle(svc)

        assertFalse(AutoVoteService.isRunning)
        assertEquals(AutoVoteService.ERROR_FGS_NOT_ALLOWED, ServiceState.status(app).lastError)
        assertTrue(ServiceState.isEnabled(app))
        assertAlarmIn(3 * MINUTE)
        assertTrue(shadowOf(svc).isStoppedBySelf)
        assertNull(ShadowPowerManager.getLatestWakeLock())
        idle()
        assertNull(svc.webView())
    }

    @Test
    fun theForegroundTimeoutStopsTheServiceCleanlyAndLeavesTheNextAlarm() {
        settings("""{"checkFrequencyMin":2}""")
        val svc = startedAndReady()
        runCycle(svc)
        val wv = svc.webView()!!
        val wakeLock = ShadowPowerManager.getLatestWakeLock()
        assertTrue(wakeLock.isHeld)

        svc.onTimeout(1, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        idle()

        assertFalse(AutoVoteService.isRunning)
        assertEquals(AutoVoteService.ERROR_FGS_TIMEOUT, AutoVoteService.lastError)
        val saved = ServiceState.status(app)
        assertTrue(saved.running)
        assertEquals(AutoVoteService.ERROR_FGS_TIMEOUT, saved.lastError)
        assertTrue(shadowOf(svc).isForegroundStopped)
        assertTrue(shadowOf(svc).isStoppedBySelf)
        assertFalse(wakeLock.isHeld)
        assertTrue(shadowOf(wv).wasDestroyCalled())
        assertNull(svc.webView())
        assertAlarmIn(2 * MINUTE)
        // The cycle watchdog is gone with it.
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMinutes(3))
        assertEquals(0, AutoVoteService.cycleCount)

        // The alarm brings a new instance back, and a STOP then ends it for good.
        val next = newService()
        next.command(AutoVoteService.ACTION_RUN_CYCLE)
        idle()
        assertTrue(AutoVoteService.isRunning)
        assertNotNull(next.webView())
        next.command(AutoVoteService.ACTION_STOP)
        idle()
        assertFalse(ServiceState.isEnabled(app))
        assertNull(nextAlarm())
    }

    @Test
    fun aStopAfterATimeoutCancelsTheWaitingAlarm() {
        val svc = startedAndReady()
        svc.onTimeout(1, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        idle()
        assertNotNull(nextAlarm())

        // The window's stop reaches a fresh instance: the alarm and the flag go.
        newService().command(AutoVoteService.ACTION_STOP)
        idle()

        assertNull(nextAlarm())
        assertFalse(ServiceState.isEnabled(app))
        assertFalse(ServiceState.status(app).running)
    }

    @Test
    fun destroyEndsTheInProcessRunningFlagButNotTheEnabledOne() {
        val svc = startedAndReady()
        assertTrue(AutoVoteService.isRunning)
        svc.onDestroy()
        assertFalse(AutoVoteService.isRunning)
        assertTrue(ServiceState.isEnabled(app))
    }

    // ---------- notification language ----------

    @Test
    fun theNotificationFollowsTheAppLanguageSettingNotTheDeviceLocale() {
        settings("""{"language":"lv"}""")
        val svc = newService()
        val nm = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = nm.getNotificationChannel(AutoVoteService.CHANNEL_ID)
        assertEquals("Automātiskā balsošana", channel.name.toString())
        assertEquals("Pastāvīgs paziņojums, kamēr automātiskā balsošana darbojas fonā.", channel.description)

        svc.command(AutoVoteService.ACTION_START)
        idle()
        val started = shadowOf(svc).lastForegroundNotification
        assertEquals("Automātiskā balsošana sākas…", started.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals("GuruShots Auto Vote", started.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals("Apturēt", started.actions.single().title.toString())
        shadowOf(svc.webView()!!).webViewClient.onPageFinished(svc.webView()!!, HEADLESS_URL)

        runCycle(svc)
        svc.HeadlessBridge().onCycleComplete("""{"ok":true,"nextDelayMs":$MINUTE}""")
        idle()
        assertTrue(notificationText()!!, notificationText()!!.matches(Regex("""Pēdējais cikls plkst\. \d\d:\d\d:\d\d \(nr\. 1\)""")))

        runCycle(svc)
        svc.HeadlessBridge().onCycleComplete("""{"ok":false,"error":"no-token"}""")
        idle()
        assertTrue(notificationText()!!.endsWith(": Pieteikšanās nav veikta — atver lietotni un piesakies"))

        runCycle(svc)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(120_000))
        assertTrue(notificationText()!!.matches(Regex("""Pēdējā kļūda plkst\. \d\d:\d\d:\d\d: Laiks beidzies — mēģināšu vēlreiz""")))

        runCycle(svc)
        svc.HeadlessBridge().onCycleComplete("""{"ok":false,"error":"HTTP 503"}""")
        idle()
        assertTrue(notificationText()!!.matches(Regex("""Pēdējā kļūda plkst\. \d\d:\d\d:\d\d: Kaut kas nogāja greizi — mēģināšu vēlreiz""")))
    }

    @Test
    fun anUnknownLanguageSettingFallsBackToEnglish() {
        settings("""{"language":"de"}""")
        val svc = newService()
        svc.command(AutoVoteService.ACTION_START)
        assertEquals("Stop", shadowOf(svc).lastForegroundNotification.actions.single().title.toString())
    }
}
