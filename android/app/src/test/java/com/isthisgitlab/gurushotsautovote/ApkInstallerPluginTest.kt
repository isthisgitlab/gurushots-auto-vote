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
import okhttp3.Interceptor
import okhttp3.OkHttpClient
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
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
class ApkInstallerPluginTest {

    private companion object {
        const val RELEASE = "https://github.com/isthisgitlab/gurushots-auto-vote/releases/download/v1.2.3/app.apk"
        const val APK = "application/vnd.android.package-archive"
        const val OCTET = "application/octet-stream"
    }

    private lateinit var app: Application
    private lateinit var bridge: Bridge
    private lateinit var plugin: ApkInstallerPlugin
    private lateinit var server: MockWebServer
    private lateinit var originalFactory: () -> OkHttpClient
    private var originalMax = 0L
    private val progress: MutableList<Int> = Collections.synchronizedList(mutableListOf())
    private val requested: MutableList<String> = Collections.synchronizedList(mutableListOf())
    private val settled = AtomicBoolean(false)
    private val resolvedWith = AtomicReference<JSObject?>()
    private val rejectCode = AtomicReference<String?>()

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        // FileProvider memoises each authority's root paths in a static cache;
        // Robolectric gives every test a fresh cache dir, so drop stale roots.
        FileProvider::class.java.getDeclaredField("sCache").apply { isAccessible = true }
            .let { (it.get(null) as MutableMap<*, *>).clear() }
        bridge = mockk()
        every { bridge.context } returns app
        server = MockWebServer()
        server.start()
        originalFactory = ApkInstallerPlugin.httpClientFactory
        originalMax = ApkInstallerPlugin.maxApkBytes
        // The production client, with the GitHub hosts rerouted to the mock server and the logical URLs recorded.
        ApkInstallerPlugin.httpClientFactory = {
            ApkInstallerPlugin.newClient(
                OkHttpClient.Builder()
                    .addInterceptor(Interceptor { chain -> requested += chain.request().url.toString(); chain.proceed(chain.request()) })
                    .addInterceptor(TestSupport.rerouting(server)),
            )
        }
        plugin = ApkInstallerPlugin()
        plugin.bridge = bridge

        // Subscribe to downloadProgress the same way the JS bridge does.
        val listener = mockk<PluginCall>(relaxed = true)
        every { listener.getString("eventName") } returns "downloadProgress"
        every { listener.resolve(any()) } answers { progress += firstArg<JSObject>().getInt("percent") }
        plugin.addListener(listener)
    }

    @After
    fun tearDown() {
        ApkInstallerPlugin.httpClientFactory = originalFactory
        ApkInstallerPlugin.maxApkBytes = originalMax
        server.close()
    }

    private fun sha256(bytes: ByteArray) = "sha256:" + MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun callFor(url: String?, digest: String? = null): PluginCall {
        val call = mockk<PluginCall>(relaxed = true)
        every { call.getString("url") } returns url
        every { call.getString("digest") } returns digest
        every { call.resolve(any()) } answers {
            resolvedWith.set(firstArg())
            settled.set(true)
        }
        every { call.reject(any<String>(), any<Exception>()) } answers { settled.set(true) }
        every { call.reject(any<String>(), any<String>(), any<Exception>()) } answers {
            rejectCode.set(secondArg())
            settled.set(true)
        }
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

    /** Runs a download of [url] with [digest] to the end and returns the call. */
    private fun download(url: String?, digest: String?): PluginCall {
        val call = callFor(url, digest)
        plugin.downloadAndInstall(call)
        awaitSettled()
        return call
    }

    private fun apkFile() = File(File(app.cacheDir, "updates"), "update.apk")

    private fun apk(body: ByteArray, type: String? = OCTET) =
        MockResponse.Builder().code(200).apply { if (type != null) addHeader("Content-Type", type) }.body(Buffer().write(body)).build()

    private fun redirect(location: String?, code: Int = 302) =
        MockResponse.Builder().code(code).apply { if (location != null) addHeader("Location", location) }.build()

    private fun assertRejected(call: PluginCall, code: String) {
        assertEquals(code, rejectCode.get())
        verify(exactly = 1) { call.reject(any<String>(), code, any<Exception>()) }
        verify(exactly = 0) { call.resolve(any()) }
        assertNull(shadowOf(app).nextStartedActivity)
        assertFalse(apkFile().exists())
    }

    // ---------- input ----------

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
    fun onlyAReleaseDownloadOfThisRepositoryOnGithubIsAccepted() {
        val digest = sha256(ByteArray(1))
        val refused = listOf(
            "http://github.com/isthisgitlab/gurushots-auto-vote/releases/download/v1/app.apk",
            "https://evil.example/isthisgitlab/gurushots-auto-vote/releases/download/v1/app.apk",
            "https://github.com.evil.example/isthisgitlab/gurushots-auto-vote/releases/download/v1/app.apk",
            "https://github.com@evil.example/isthisgitlab/gurushots-auto-vote/releases/download/v1/app.apk",
            "https://github.com/someone-else/gurushots-auto-vote/releases/download/v1/app.apk",
            "https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest",
            // Dot segments are resolved by the URL parser: the path no longer stays in this repository.
            "https://github.com/isthisgitlab/gurushots-auto-vote/releases/download/../../../../evil/x/raw/app.apk",
            "https://github.com/isthisgitlab/gurushots-auto-vote/releases/download/%2e%2e/%2e%2e/%2e%2e/%2e%2e/evil/x/raw/app.apk",
            "https://example.com/app.apk",
        )
        for (url in refused) {
            settled.set(false)
            rejectCode.set(null)
            val call = download(url, digest)
            assertRejected(call, "host")
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun aDownloadWithoutAUsableSha256DigestIsRefusedBeforeAnyRequest() {
        for (digest in listOf(null, "", "   ", "md5:d41d8cd98f00b204e9800998ecf8427e", "sha256:abc", "sha256:" + "g".repeat(64), "e".repeat(64))) {
            settled.set(false)
            rejectCode.set(null)
            val call = download(RELEASE, digest)
            assertRejected(call, "digest-missing")
        }
        assertEquals(0, server.requestCount)
    }

    // ---------- the download ----------

    @Test
    fun removesTheLegacyApkLeftAtTheCacheRoot() {
        val legacy = File(app.cacheDir, "update.apk")
        legacy.writeText("from an older build")
        server.enqueue(apk("new".toByteArray()))

        download(RELEASE, sha256("new".toByteArray()))

        assertFalse(legacy.exists())
        assertEquals("new", apkFile().readText())
    }

    @Test
    fun downloadsWithProgressChecksTheDigestAndLaunchesInstaller() {
        // A stale partial download must be replaced, never appended to.
        apkFile().parentFile!!.mkdirs()
        apkFile().writeText("stale")
        val payload = ByteArray(1_000_000) { (it % 251).toByte() }
        server.enqueue(apk(payload, APK))

        val call = download(RELEASE, sha256(payload))

        verify(exactly = 1) { call.resolve(any()) }
        assertTrue(resolvedWith.get()!!.getBoolean("success"))
        assertArrayEquals(payload, apkFile().readBytes())
        assertEquals(listOf(RELEASE), requested)
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
        // The installer reads the file through its URI after the call resolved: it is not deleted behind it.
        assertTrue(apkFile().exists())
    }

    @Test
    fun theDigestIsReadWhateverItsCaseAndPadding() {
        val payload = "bytes".toByteArray()
        server.enqueue(apk(payload))

        download(RELEASE, "  " + sha256(payload).uppercase().replace("SHA256:", "sha256:") + " ")

        assertEquals("bytes", apkFile().readText())
    }

    @Test
    fun chunkedDownloadWithUnknownLengthEmitsNoProgress() {
        assertFalse(apkFile().exists())
        server.enqueue(MockResponse.Builder().code(200).addHeader("Content-Type", OCTET).chunkedBody("apk-bytes", 3).build())

        val call = download(RELEASE, sha256("apk-bytes".toByteArray()))

        verify { call.resolve(any()) }
        assertEquals("apk-bytes", apkFile().readText())
        assertTrue(progress.isEmpty())
    }

    @Test
    fun aDownloadWhoseBytesDoNotMatchTheDigestIsRefusedAndDeleted() {
        server.enqueue(apk("tampered".toByteArray()))

        val call = download(RELEASE, sha256("genuine".toByteArray()))

        assertRejected(call, "digest")
    }

    // ---------- redirects ----------

    @Test
    fun followsGithubsRedirectChainToItsAssetHosts() {
        val payload = "apk".toByteArray()
        server.enqueue(redirect("https://objects.githubusercontent.com/github-production-release-asset/1?sig=a", 301))
        server.enqueue(redirect("https://release-assets.githubusercontent.com/github-production-release-asset/2?sig=b", 307))
        // A relative redirect stays on the asset host it was answered by.
        server.enqueue(redirect("/github-production-release-asset/3?sig=c", 308))
        server.enqueue(apk(payload))

        download(RELEASE, sha256(payload))

        assertEquals("apk", apkFile().readText())
        assertEquals(
            listOf(
                RELEASE,
                "https://objects.githubusercontent.com/github-production-release-asset/1?sig=a",
                "https://release-assets.githubusercontent.com/github-production-release-asset/2?sig=b",
                "https://release-assets.githubusercontent.com/github-production-release-asset/3?sig=c",
            ),
            requested,
        )
    }

    @Test
    fun fiveRedirectsAreFollowedAndASixthIsNot() {
        val payload = "apk".toByteArray()
        repeat(5) { server.enqueue(redirect("https://release-assets.githubusercontent.com/$it")) }
        server.enqueue(apk(payload))
        download(RELEASE, sha256(payload))
        assertEquals("apk", apkFile().readText())
        assertEquals(6, server.requestCount)

        settled.set(false)
        repeat(6) { server.enqueue(redirect("https://release-assets.githubusercontent.com/$it")) }
        val call = download(RELEASE, sha256(payload))
        verify(exactly = 1) { call.reject(any<String>(), "host", any<Exception>()) }
        assertEquals(6 + 6, server.requestCount)
    }

    @Test
    fun aRedirectOffTheAssetHostsOrOffHttpsOrBackToGithubIsRefused() {
        val digest = sha256(ByteArray(1))
        val refused = listOf(
            "https://evil.example/app.apk",
            "http://release-assets.githubusercontent.com/app.apk",
            "https://github.com/isthisgitlab/gurushots-auto-vote/releases/download/v9/app.apk",
            "https://release-assets.githubusercontent.com.evil.example/app.apk",
            "ftp://objects.githubusercontent.com/app.apk",
        )
        for (location in refused) {
            settled.set(false)
            rejectCode.set(null)
            server.enqueue(redirect(location))
            val call = download(RELEASE, digest)
            assertRejected(call, "host")
        }
        // A relative redirect on the first hop would stay on github.com, which only the first hop may be.
        settled.set(false)
        rejectCode.set(null)
        server.enqueue(redirect("/other/path"))
        assertRejected(download(RELEASE, digest), "host")
        assertEquals(refused.size + 1, server.requestCount)
    }

    @Test
    fun aRedirectWithoutAUsableLocationIsRefused() {
        val digest = sha256(ByteArray(1))
        for (location in listOf(null, "https://[bad")) {
            settled.set(false)
            rejectCode.set(null)
            server.enqueue(redirect(location))
            assertRejected(download(RELEASE, digest), "host")
        }
    }

    // ---------- content, size ----------

    @Test
    fun onlyAnApkOrOctetStreamResponseIsSaved() {
        val digest = sha256("x".toByteArray())
        for (type in listOf("text/html; charset=utf-8", "application/json", "application/zip", null)) {
            settled.set(false)
            rejectCode.set(null)
            server.enqueue(apk("x".toByteArray(), type))
            assertRejected(download(RELEASE, digest), "content-type")
        }
        // The two accepted types, with or without parameters.
        for (type in listOf(APK, OCTET, "$OCTET; charset=binary")) {
            settled.set(false)
            rejectCode.set(null)
            server.enqueue(apk("x".toByteArray(), type))
            download(RELEASE, digest)
            assertEquals("x", apkFile().readText())
        }
    }

    @Test
    fun aResponseDeclaredLargerThanTheCapIsRefusedBeforeItsBodyIsRead() {
        ApkInstallerPlugin.maxApkBytes = 100
        server.enqueue(apk(ByteArray(101)))

        assertRejected(download(RELEASE, sha256(ByteArray(101))), "size")
    }

    @Test
    fun aStreamThatPassesTheCapIsCutOffAndDeleted() {
        ApkInstallerPlugin.maxApkBytes = 100
        // No length is declared: only counting the bytes can catch it.
        server.enqueue(
            MockResponse.Builder().code(200).addHeader("Content-Type", OCTET).chunkedBody(ByteArray(101).decodeToString(), 10).build(),
        )

        assertRejected(download(RELEASE, sha256(ByteArray(101))), "size")
    }

    @Test
    fun aDownloadExactlyAtTheCapIsAccepted() {
        ApkInstallerPlugin.maxApkBytes = 100
        server.enqueue(apk(ByteArray(100)))

        download(RELEASE, sha256(ByteArray(100)))

        assertEquals(100, apkFile().length())
    }

    // ---------- failures ----------

    @Test
    fun httpErrorRejectsWithStatus() {
        server.enqueue(MockResponse.Builder().code(404).build())

        val call = download(RELEASE, sha256(ByteArray(1)))

        verify { call.reject("Download failed: HTTP 404", any<Exception>()) }
        assertNull(shadowOf(app).nextStartedActivity)
    }

    @Test
    fun connectionDroppedMidDownloadRejectsAndDeletesThePartialFile() {
        server.enqueue(
            MockResponse.Builder().code(200).addHeader("Content-Type", OCTET)
                .body(Buffer().write(ByteArray(500_000)))
                .onResponseBody(SocketEffect.ShutdownConnection)
                .build(),
        )

        val call = download(RELEASE, sha256(ByteArray(500_000)))

        verify { call.reject(any<String>(), any<java.io.IOException>()) }
        assertNull(resolvedWith.get())
        assertNull(shadowOf(app).nextStartedActivity)
        assertFalse(apkFile().exists())
    }

    @Test
    fun exceptionWithoutMessageRejectsWithFallbackText() {
        server.enqueue(apk("x".toByteArray()))
        // The context lookup (cacheDir) fails with a message-less exception.
        every { bridge.context } throws RuntimeException()

        val call = download(RELEASE, sha256("x".toByteArray()))

        verify { call.reject("APK download/install failed", any<Exception>()) }
    }

    @Test
    fun theDefaultClientFollowsNoRedirectsAndBoundsTheWholeCall() {
        val client = originalFactory()
        assertFalse(client.followRedirects)
        assertFalse(client.followSslRedirects)
        assertEquals(TimeUnit.MINUTES.toMillis(15).toInt(), client.callTimeoutMillis)
        assertEquals(30_000, client.connectTimeoutMillis)
        assertEquals(60_000, client.readTimeoutMillis)
    }
}
