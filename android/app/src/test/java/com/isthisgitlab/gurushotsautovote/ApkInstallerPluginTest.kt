package com.isthisgitlab.gurushotsautovote

import android.app.Application
import android.content.Intent
import android.os.Looper
import androidx.core.content.FileProvider
import androidx.test.core.app.ApplicationProvider
import com.getcapacitor.Bridge
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.SocketEffect
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import java.io.File
import java.util.Collections
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
class ApkInstallerPluginTest {

    private lateinit var app: Application
    private lateinit var bridge: Bridge
    private lateinit var plugin: ApkInstallerPlugin
    private lateinit var server: MockWebServer
    private val progress: MutableList<Int> = Collections.synchronizedList(mutableListOf())
    private val settled = AtomicBoolean(false)
    private val resolvedWith = AtomicReference<JSObject?>()

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        // FileProvider memoises each authority's root paths in a static cache;
        // Robolectric gives every test a fresh cache dir, so drop stale roots.
        FileProvider::class.java.getDeclaredField("sCache").apply { isAccessible = true }
            .let { (it.get(null) as MutableMap<*, *>).clear() }
        bridge = mockk()
        every { bridge.context } returns app
        plugin = ApkInstallerPlugin()
        plugin.bridge = bridge
        server = MockWebServer()
        server.start()

        // Subscribe to downloadProgress the same way the JS bridge does.
        val listener = mockk<PluginCall>(relaxed = true)
        every { listener.getString("eventName") } returns "downloadProgress"
        every { listener.resolve(any()) } answers { progress += firstArg<JSObject>().getInt("percent") }
        plugin.addListener(listener)
    }

    @After
    fun tearDown() {
        server.close()
    }

    private fun callFor(url: String?): PluginCall {
        val call = mockk<PluginCall>(relaxed = true)
        every { call.getString("url") } returns url
        every { call.resolve(any()) } answers {
            resolvedWith.set(firstArg())
            settled.set(true)
        }
        every { call.reject(any<String>(), any<Exception>()) } answers { settled.set(true) }
        return call
    }

    /** Pumps the (paused) Robolectric main looper until the IO coroutine settles the call. */
    private fun awaitSettled() {
        val deadline = System.currentTimeMillis() + 10_000
        while (!settled.get()) {
            if (System.currentTimeMillis() > deadline) throw AssertionError("call never settled")
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
    }

    private fun apkFile() = File(app.cacheDir, "update.apk")

    @Test
    fun rejectsMissingUrl() {
        val call = callFor(null)
        plugin.downloadAndInstall(call)
        verify { call.reject("No download URL provided") }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun rejectsEmptyUrl() {
        val call = callFor("")
        plugin.downloadAndInstall(call)
        verify { call.reject("No download URL provided") }
    }

    @Test
    fun downloadsWithProgressAndLaunchesInstaller() {
        // A stale partial download must be replaced, never appended to.
        apkFile().writeText("stale")
        val payload = ByteArray(1_000_000) { (it % 251).toByte() }
        server.enqueue(MockResponse.Builder().code(200).body(Buffer().write(payload)).build())

        val call = callFor(server.url("/app.apk").toString())
        plugin.downloadAndInstall(call)
        awaitSettled()

        assertTrue(resolvedWith.get()!!.getBoolean("success"))
        assertArrayEquals(payload, apkFile().readBytes())
        // Progress is monotonic, de-duplicated, and ends at 100%.
        val seen = progress.toList()
        assertEquals(100, seen.last())
        assertEquals(seen.distinct(), seen)
        assertEquals(seen.sorted(), seen)

        val intent = shadowOf(app).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals("application/vnd.android.package-archive", intent.type)
        assertEquals("content", intent.data!!.scheme)
        assertEquals("${app.packageName}.fileprovider", intent.data!!.authority)
        assertTrue(intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        assertTrue(intent.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
    }

    @Test
    fun chunkedDownloadWithUnknownLengthEmitsNoProgress() {
        assertFalse(apkFile().exists())
        server.enqueue(MockResponse.Builder().code(200).chunkedBody("apk-bytes", 3).build())

        val call = callFor(server.url("/app.apk").toString())
        plugin.downloadAndInstall(call)
        awaitSettled()

        verify { call.resolve(any()) }
        assertEquals("apk-bytes", apkFile().readText())
        assertTrue(progress.isEmpty())
    }

    @Test
    fun httpErrorRejectsWithStatus() {
        server.enqueue(MockResponse.Builder().code(404).build())

        val call = callFor(server.url("/missing.apk").toString())
        plugin.downloadAndInstall(call)
        awaitSettled()

        verify { call.reject("Download failed: HTTP 404", any<Exception>()) }
        assertNull(shadowOf(app).nextStartedActivity)
    }

    @Test
    fun connectionDroppedMidDownloadRejects() {
        server.enqueue(
            MockResponse.Builder().code(200)
                .body(Buffer().write(ByteArray(500_000)))
                .onResponseBody(SocketEffect.ShutdownConnection)
                .build(),
        )

        val call = callFor(server.url("/app.apk").toString())
        plugin.downloadAndInstall(call)
        awaitSettled()

        verify { call.reject(any<String>(), any<java.io.IOException>()) }
        assertNull(resolvedWith.get())
        assertNull(shadowOf(app).nextStartedActivity)
    }

    @Test
    fun exceptionWithoutMessageRejectsWithFallbackText() {
        server.enqueue(MockResponse.Builder().code(200).body("x").build())
        // The context lookup (cacheDir) fails with a message-less exception.
        every { bridge.context } throws RuntimeException()

        val call = callFor(server.url("/app.apk").toString())
        plugin.downloadAndInstall(call)
        awaitSettled()

        verify { call.reject("APK download/install failed", any<Exception>()) }
    }
}
