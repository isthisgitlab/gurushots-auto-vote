package com.isthisgitlab.gurushotsautovote

import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Call
import okhttp3.CookieJar
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.Source
import okio.Timeout
import okio.buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

class VideoMediaDownloaderTest {

    private companion object {
        const val VIDEO = "https://media.gurushots.com/clip.mp4"
        const val DEADLINE_MS = 30_000L
    }

    @get:Rule
    val folder = TemporaryFolder()

    private lateinit var server: MockWebServer
    private lateinit var destination: File

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        destination = File(folder.newFolder(), "clip.mp4")
    }

    @After
    fun tearDown() {
        server.close()
    }

    private fun client(vararg extra: Interceptor): OkHttpClient {
        val builder = OkHttpClient.Builder()
        extra.forEach { builder.addInterceptor(it) }
        return VideoMediaDownloader.newClient(builder.addInterceptor(TestSupport.rerouting(server)))
    }

    private fun downloaderOver(client: OkHttpClient) = VideoMediaDownloader(client)

    private fun download(
        downloader: VideoMediaDownloader,
        deadlineMs: Long = DEADLINE_MS,
        isCancelled: () -> Boolean = { false },
        onCall: (Call) -> Unit = {},
    ) = downloader.download(VIDEO, destination, deadlineMs, isCancelled, onCall)

    private fun assertRejected(message: String, block: () -> Unit) {
        try {
            block()
        } catch (error: VideoMediaDownloader.Rejection) {
            assertEquals(message, error.message)
            return
        }
        throw AssertionError("expected a video media rejection")
    }

    /** A response with no declared length whose [total] zero bytes are produced on demand, never held in memory. */
    private fun generatedBody(total: Long, declared: Long = -1L) = Interceptor { chain ->
        var remaining = total
        val source = object : Source {
            override fun read(sink: Buffer, byteCount: Long): Long {
                if (remaining == 0L) return -1L
                val chunk = minOf(byteCount, remaining, 64L * 1024)
                sink.write(ByteArray(chunk.toInt()))
                remaining -= chunk
                return chunk
            }

            override fun timeout(): Timeout = Timeout.NONE
            override fun close() = Unit
        }.buffer()
        Response.Builder()
            .request(chain.request())
            .protocol(Protocol.HTTP_1_1)
            .code(200)
            .message("OK")
            .body(
                object : ResponseBody() {
                    override fun contentType(): MediaType? = null
                    override fun contentLength(): Long = declared
                    override fun source(): BufferedSource = source
                },
            )
            .build()
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
        for (url in rejected) {
            try {
                VideoMediaDownloader.validateUrl(url)
                fail("expected $url to be refused")
            } catch (_: VideoMediaDownloader.Rejection) {
                // refused, as required
            }
        }

        assertEquals(VIDEO, VideoMediaDownloader.validateUrl(VIDEO).toString())
        assertEquals(0, server.requestCount)
    }

    @Test
    fun configuresAHeaderlessNoCookieClientWithAnIdleLimitAndNoRedirects() {
        val client = VideoMediaDownloader.newClient()
        assertEquals(CookieJar.NO_COOKIES, client.cookieJar)
        assertFalse(client.followRedirects)
        assertFalse(client.followSslRedirects)
        assertEquals(30_000, client.readTimeoutMillis)
        assertEquals(0, client.callTimeoutMillis)
    }

    @Test
    fun streamsTheBodyToTheFileWithoutCookiesAuthorizationOrJavaScriptHeaders() {
        val body = ByteArray(200_000) { (it % 251).toByte() }
        server.enqueue(MockResponse.Builder().code(200).body(Buffer().write(body)).build())

        download(downloaderOver(client()))

        assertArrayEquals(body, destination.readBytes())
        val request = server.takeRequest()
        assertNull(request.headers["Cookie"])
        assertNull(request.headers["Authorization"])
        assertNull(request.headers["X-Requested-With"])
    }

    @Test
    fun handsOverTheCallBeforeItStartsAndBoundsItWithTheDeadline() {
        val events = mutableListOf<String>()
        val callTimeoutMs = AtomicReference<Long>()
        val watcher = Interceptor { chain ->
            events += "execute"
            callTimeoutMs.set(TimeUnit.NANOSECONDS.toMillis(chain.call().timeout().timeoutNanos()))
            chain.proceed(chain.request())
        }
        server.enqueue(MockResponse.Builder().code(200).body("ok").build())

        download(downloaderOver(client(watcher)), deadlineMs = 45_000) { events += "onCall" }

        assertEquals(listOf("onCall", "execute"), events)
        assertEquals(45_000L, callTimeoutMs.get())
    }

    @Test
    fun appliesTheDeadlineToTheWholeCallNotJustToIdleReads() {
        // Bytes keep arriving inside the 30 s idle limit, but the call as a whole runs past its deadline.
        server.enqueue(MockResponse.Builder().code(200).body("0123456789").throttleBody(1, 1, TimeUnit.SECONDS).build())

        try {
            download(downloaderOver(client()), deadlineMs = 300)
            fail("expected the call deadline to expire")
        } catch (_: InterruptedIOException) {
            assertTrue(destination.length() < 10)
        }
    }

    @Test
    fun rejectsRedirectsAndAllNon200Responses() {
        server.enqueue(MockResponse.Builder().code(302).addHeader("Location", "https://media.gurushots.com/other.mp4").build())
        assertRejected("Video media download redirected") { download(downloaderOver(client())) }
        assertEquals(1, server.requestCount)

        server.enqueue(MockResponse.Builder().code(403).build())
        assertRejected("Video media download failed") { download(downloaderOver(client())) }
    }

    @Test
    fun rejectsADeclaredLengthOverTheCapButAcceptsTheCapItself() {
        assertRejected("Video media is too large") {
            download(downloaderOver(client(generatedBody(0, VideoMediaDownloader.MAX_VIDEO_BYTES + 1))))
        }
        assertEquals(0, destination.length())

        download(downloaderOver(client(generatedBody(0, VideoMediaDownloader.MAX_VIDEO_BYTES))))
        assertEquals(0, destination.length())
    }

    @Test
    fun capsTheCountedBytesOfABodyWithNoLength() {
        assertEquals(256L * 1024 * 1024, VideoMediaDownloader.MAX_VIDEO_BYTES)

        download(downloaderOver(client(generatedBody(VideoMediaDownloader.MAX_VIDEO_BYTES))))
        assertEquals(VideoMediaDownloader.MAX_VIDEO_BYTES, destination.length())

        assertRejected("Video media is too large") {
            download(downloaderOver(client(generatedBody(VideoMediaDownloader.MAX_VIDEO_BYTES + 1))))
        }
        assertEquals(VideoMediaDownloader.MAX_VIDEO_BYTES, destination.length())
    }

    @Test
    fun capsAChunkedBodyOverTheWire() {
        server.enqueue(MockResponse.Builder().code(200).chunkedBody("0123456789", 4).build())
        val body = AtomicReference<Long>()
        val recorder = Interceptor { chain ->
            chain.proceed(chain.request()).also { body.set(it.body.contentLength()) }
        }

        download(downloaderOver(client(recorder)))

        assertEquals(-1L, body.get())
        assertEquals("0123456789", destination.readText())
    }

    @Test
    fun failsWithAnIdleTimeoutWhenTheBodyStallsMidStream() {
        server.enqueue(MockResponse.Builder().code(200).body("0123456789").throttleBody(5, 5, TimeUnit.SECONDS).build())
        val quickIdle = client().newBuilder().readTimeout(300, TimeUnit.MILLISECONDS).build()

        try {
            download(downloaderOver(quickIdle))
            fail("expected an idle timeout")
        } catch (_: SocketTimeoutException) {
            assertEquals("01234", destination.readText())
        }
    }

    @Test
    fun stopsTheReadLoopWhenCancelled() {
        server.enqueue(MockResponse.Builder().code(200).body("0123456789").build())
        var checks = 0

        try {
            download(downloaderOver(client()), isCancelled = { ++checks > 1 })
            fail("expected a cancellation")
        } catch (error: VideoJobCancelled) {
            assertEquals("Video extraction was cancelled", error.message)
        }
        assertEquals(2, checks)
    }

    @Test
    fun cancellingTheHandedOverCallInterruptsABlockedRead() {
        server.enqueue(MockResponse.Builder().code(200).body("0123456789").throttleBody(5, 20, TimeUnit.SECONDS).build())
        val active = AtomicReference<Call>()
        val finished = AtomicBoolean(false)
        val canceller = Thread {
            Thread.sleep(300)
            active.get().cancel()
        }

        try {
            canceller.start()
            download(downloaderOver(client()), onCall = { active.set(it) })
            fail("expected the read to be interrupted")
        } catch (_: IOException) {
            finished.set(true)
        }
        canceller.join()
        assertTrue(finished.get())
        assertTrue(active.get().isCanceled())
    }

    @Test
    fun closesTheResponseStreamWhenTheNetworkReadFails() {
        val closed = AtomicBoolean(false)
        val failing = VideoMediaDownloader.newClient(
            OkHttpClient.Builder().addInterceptor(TestSupport.failingBodyInterceptor { closed.set(true) }),
        )

        try {
            download(downloaderOver(failing))
            fail("expected the read to fail")
        } catch (_: IOException) {
            assertTrue(closed.get())
        }
    }
}
