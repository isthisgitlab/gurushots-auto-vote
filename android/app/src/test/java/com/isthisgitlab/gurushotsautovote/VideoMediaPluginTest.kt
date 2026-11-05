package com.isthisgitlab.gurushotsautovote

import android.app.Application
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.getcapacitor.Bridge
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.MediaType
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
class VideoMediaPluginTest {

    private companion object {
        const val VIDEO = "https://media.gurushots.com/clip.mp4"
    }

    private lateinit var app: Application
    private lateinit var bridge: Bridge
    private lateinit var plugin: VideoMediaPlugin
    private lateinit var server: MockWebServer
    private lateinit var originalFactory: () -> VideoMediaDownloader
    private val settled = AtomicBoolean(false)
    private val resolvedWith = AtomicReference<JSObject?>()
    private val rejectedWith = AtomicReference<String?>()

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        bridge = mockk()
        every { bridge.context } returns app
        server = MockWebServer()
        server.start()
        originalFactory = VideoMediaPlugin.downloaderFactory
        VideoMediaPlugin.downloaderFactory = {
            VideoMediaDownloader(
                VideoMediaDownloader.newClient(OkHttpClient.Builder().addInterceptor(TestSupport.rerouting(server))),
            )
        }
        plugin = VideoMediaPlugin()
        plugin.bridge = bridge
    }

    @After
    fun tearDown() {
        VideoMediaPlugin.downloaderFactory = originalFactory
        server.close()
    }

    private fun callFor(url: String?): PluginCall {
        val call = mockk<PluginCall>(relaxed = true)
        every { call.getString("url") } returns url
        every { call.resolve(any()) } answers {
            resolvedWith.set(firstArg())
            settled.set(true)
        }
        every { call.reject(any<String>(), any<Exception>()) } answers {
            rejectedWith.set(firstArg())
            settled.set(true)
        }
        return call
    }

    private fun awaitSettled() {
        val deadline = System.currentTimeMillis() + 10_000
        while (!settled.get()) {
            if (System.currentTimeMillis() > deadline) throw AssertionError("call never settled")
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
    }

    private fun nativeDownloader(client: OkHttpClient): VideoMediaDownloader = VideoMediaDownloader(client)

    private fun declaredOversizeClient(): OkHttpClient = VideoMediaDownloader.newClient(
        OkHttpClient.Builder().addInterceptor { chain ->
            Response.Builder()
                .request(chain.request())
                .protocol(Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .body(
                    object : ResponseBody() {
                        override fun contentType(): MediaType? = null
                        override fun contentLength(): Long = VideoMediaDownloader.MAX_VIDEO_BYTES + 1
                        override fun source(): BufferedSource = Buffer()
                    },
                )
                .build()
        },
    )

    private fun assertRejected(block: () -> Unit): VideoMediaDownloader.Rejection {
        try {
            block()
        } catch (error: VideoMediaDownloader.Rejection) {
            return error
        }
        throw AssertionError("expected a video media rejection")
    }

    @Test
    fun validatesEveryPartOfTheTrustedMediaUrlBeforeAnyRequest() {
        val rejected = listOf(
            "not an URL",
            "http://media.gurushots.com/clip.mp4",
            "https://other.example/clip.mp4",
            "https://media.gurushots.com:444/clip.mp4",
            "https://user@media.gurushots.com/clip.mp4",
            "https://user:password@media.gurushots.com/clip.mp4",
            "https://:password@media.gurushots.com/clip.mp4",
            "https://media.gurushots.com/clip.jpg",
        )
        for (url in rejected) assertRejected { VideoMediaDownloader.validateUrl(url) }

        assertEquals(VIDEO, VideoMediaDownloader.validateUrl(VIDEO).toString())
        assertEquals(0, server.requestCount)
    }

    @Test
    fun configuresAHeaderlessNoCookieClientWithBoundedCallsAndNoRedirects() {
        assertEquals(VideoMediaDownloader::class, originalFactory()::class)
        val client = VideoMediaDownloader.newClient()
        assertEquals(CookieJar.NO_COOKIES, client.cookieJar)
        assertFalse(client.followRedirects)
        assertFalse(client.followSslRedirects)
        assertEquals(30_000, client.callTimeoutMillis)
    }

    @Test
    fun downloadsMediaWithoutCookiesAuthorizationOrJavaScriptHeaders() {
        server.enqueue(MockResponse.Builder().code(200).body(Buffer().write(byteArrayOf(1, 2, 3))).build())

        assertArrayEquals(byteArrayOf(1, 2, 3), nativeDownloader(VideoMediaDownloader.newClient(OkHttpClient.Builder().addInterceptor(TestSupport.rerouting(server)))).download(VIDEO))

        val request = server.takeRequest()
        assertNull(request.headers["Cookie"])
        assertNull(request.headers["Authorization"])
        assertNull(request.headers["X-Requested-With"])
    }

    @Test
    fun rejectsRedirectsAndAllNon200Responses() {
        server.enqueue(MockResponse.Builder().code(302).addHeader("Location", "https://media.gurushots.com/other.mp4").build())
        assertRejected { nativeDownloader(VideoMediaDownloader.newClient(OkHttpClient.Builder().addInterceptor(TestSupport.rerouting(server)))).download(VIDEO) }
        assertEquals(1, server.requestCount)

        server.enqueue(MockResponse.Builder().code(403).build())
        assertRejected { nativeDownloader(VideoMediaDownloader.newClient(OkHttpClient.Builder().addInterceptor(TestSupport.rerouting(server)))).download(VIDEO) }
    }

    @Test
    fun rejectsDeclaredAndChunkedOversizeBodies() {
        assertRejected { nativeDownloader(declaredOversizeClient()).download(VIDEO) }

        server.enqueue(
            MockResponse.Builder().code(200).chunkedBody(Buffer().write(ByteArray(VideoMediaDownloader.MAX_VIDEO_BYTES.toInt() + 1)), 64 * 1024).build(),
        )
        assertRejected { nativeDownloader(VideoMediaDownloader.newClient(OkHttpClient.Builder().addInterceptor(TestSupport.rerouting(server)))).download(VIDEO) }
    }

    @Test
    fun closesTheResponseStreamWhenTheNetworkReadFails() {
        val closed = AtomicBoolean(false)
        val client = VideoMediaDownloader.newClient(
            OkHttpClient.Builder().addInterceptor(TestSupport.failingBodyInterceptor { closed.set(true) }),
        )

        try {
            nativeDownloader(client).download(VIDEO)
            fail("expected the read to fail")
        } catch (_: IOException) {
            assertTrue(closed.get())
        }
    }

    @Test
    fun pluginRejectsMissingInputBeforeARequest() {
        for (url in listOf<String?>(null, "")) {
            val call = callFor(url)
            plugin.download(call)
            verify(exactly = 1) { call.reject("No video media URL provided") }
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun pluginReturnsBase64AndRejectsNativeRefusalsAndErrors() {
        server.enqueue(MockResponse.Builder().code(200).body("ok").build())
        val successfulCall = callFor(VIDEO)
        plugin.download(successfulCall)
        awaitSettled()
        assertEquals("b2s=", resolvedWith.get()!!.getString("base64"))

        settled.set(false)
        server.enqueue(MockResponse.Builder().code(302).build())
        plugin.download(callFor(VIDEO))
        awaitSettled()
        assertEquals("Video media download refused", rejectedWith.get())

        settled.set(false)
        VideoMediaPlugin.downloaderFactory = {
            VideoMediaDownloader(
                VideoMediaDownloader.newClient(OkHttpClient.Builder().addInterceptor(TestSupport.failingBodyInterceptor())),
            )
        }
        val errorPlugin = VideoMediaPlugin().also { it.bridge = bridge }
        errorPlugin.download(callFor(VIDEO))
        awaitSettled()
        assertEquals("Video media download failed", rejectedWith.get())
    }
}
