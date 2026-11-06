package com.isthisgitlab.gurushotsautovote

import android.app.Application
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.getcapacitor.Bridge
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Call
import okhttp3.OkHttpClient
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowMediaMetadataRetriever
import java.io.File
import java.io.IOException
import java.time.Duration
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
class VideoMediaPluginTest {

    private companion object {
        const val VIDEO = "https://media.gurushots.com/clip.mp4"
        const val CANCELLED = "Video extraction was cancelled"
        const val FRAME = "data:image/jpeg;base64,AA=="
    }

    /** What a PluginCall was settled with; every settle is counted. */
    private class Probe(val call: PluginCall) {
        val resolved = CopyOnWriteArrayList<JSObject>()
        val rejected = CopyOnWriteArrayList<String?>()
        val settles: Int get() = resolved.size + rejected.size
    }

    /** A timeout source the test fires by hand. */
    private class ManualTimeouts : TimeoutSource {
        class Entry(val delayMs: Long, val action: Runnable) {
            @Volatile
            var cancelled = false
        }

        val entries = CopyOnWriteArrayList<Entry>()

        override fun schedule(delayMs: Long, action: Runnable): Runnable {
            val entry = Entry(delayMs, action)
            entries += entry
            return Runnable { entry.cancelled = true }
        }

        fun fire(index: Int = entries.lastIndex) = entries[index].action.run()
    }

    /** A download the test holds open until it releases it. */
    private class Gate {
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
    }

    @get:Rule
    val folder = TemporaryFolder()

    private lateinit var app: Application
    private lateinit var bridge: Bridge
    private lateinit var plugin: VideoMediaPlugin
    private lateinit var server: MockWebServer
    private lateinit var videoDir: File
    private lateinit var pool: ExecutorService
    private val timeouts = ManualTimeouts()
    private val downloader = mockk<VideoMediaDownloader>()
    private val extractor = mockk<VideoFrameExtractor>()
    private val httpCall = mockk<Call>(relaxed = true)
    private val gates = mutableMapOf<String, Gate>()
    private val extractions = AtomicInteger()

    private val originalDownloaderFactory = VideoMediaPlugin.downloaderFactory
    private val originalExtractorFactory = VideoMediaPlugin.extractorFactory
    private val originalDispatcher = VideoMediaPlugin.dispatcher
    private val originalTimeoutSource = VideoMediaPlugin.timeoutSource
    private val originalVideoDirProvider = VideoMediaPlugin.videoDirProvider

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        bridge = mockk()
        every { bridge.context } returns app
        server = MockWebServer()
        server.start()
        videoDir = File(folder.newFolder(), "snap-video")
        pool = Executors.newCachedThreadPool()

        VideoMediaPlugin.downloaderFactory = { downloader }
        VideoMediaPlugin.extractorFactory = { extractor }
        VideoMediaPlugin.dispatcher = Dispatchers.Unconfined
        VideoMediaPlugin.timeoutSource = timeouts
        VideoMediaPlugin.videoDirProvider = { videoDir }

        // Default mocked work: write the clip, hand over a call, return three frames' worth.
        stubDownload { _, file, _, onCall ->
            file.writeText("clip")
            onCall(httpCall)
        }
        every { extractor.extract(any(), any(), any(), any(), any()) } answers {
            extractions.incrementAndGet()
            listOf(FRAME)
        }

        plugin = VideoMediaPlugin()
        plugin.bridge = bridge
    }

    @After
    fun tearDown() {
        gates.values.forEach { it.release.countDown() }
        pool.shutdownNow()
        server.close()
        ShadowMediaMetadataRetriever.reset()
        VideoMediaPlugin.downloaderFactory = originalDownloaderFactory
        VideoMediaPlugin.extractorFactory = originalExtractorFactory
        VideoMediaPlugin.dispatcher = originalDispatcher
        VideoMediaPlugin.timeoutSource = originalTimeoutSource
        VideoMediaPlugin.videoDirProvider = originalVideoDirProvider
    }

    private fun useThreads() {
        VideoMediaPlugin.dispatcher = pool.asCoroutineDispatcher()
    }

    private fun stubDownload(handler: (String, File, () -> Boolean, (Call) -> Unit) -> Unit) {
        every { downloader.download(any(), any(), any(), any()) } answers {
            handler(arg(0), arg(1), arg(2), arg(3))
        }
    }

    /** Holds each job's download open on its own [Gate] until the test releases it. */
    private fun blockDownloads() {
        useThreads()
        stubDownload { _, file, isCancelled, onCall ->
            file.writeText("clip")
            onCall(httpCall)
            val gate = gate(file.nameWithoutExtension)
            gate.started.countDown()
            assertTrue(gate.release.await(10, TimeUnit.SECONDS))
            if (isCancelled()) throw VideoJobCancelled()
        }
    }

    /** Holds each job's decode open, inside a started step watchdog, on its own [Gate] until the test releases it. */
    private fun blockExtractions() {
        useThreads()
        every { extractor.extract(any(), any(), any(), any(), any()) } answers {
            val file = arg<File>(0)
            val isCancelled = arg<() -> Boolean>(3)
            val stop = arg<() -> Runnable>(4)()
            val gate = gate(file.nameWithoutExtension)
            gate.started.countDown()
            assertTrue(gate.release.await(10, TimeUnit.SECONDS))
            stop.run()
            if (isCancelled()) throw VideoJobCancelled()
            extractions.incrementAndGet()
            listOf(FRAME)
        }
    }

    @Synchronized
    private fun gate(jobId: String): Gate = gates.getOrPut(jobId) { Gate() }

    private fun awaitStarted(jobId: String) = assertTrue(gate(jobId).started.await(10, TimeUnit.SECONDS))

    private fun awaitTrue(what: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 10_000
        while (!condition()) {
            if (System.currentTimeMillis() > deadline) throw AssertionError("never happened: $what")
            Thread.sleep(5)
        }
    }

    private fun callFor(
        jobId: String? = "job-a",
        url: String? = VIDEO,
        durationMs: Long? = 10_000,
        positions: String? = "[0.5]",
    ): Probe {
        val call = mockk<PluginCall>(relaxed = true)
        val probe = Probe(call)
        every { call.getString("jobId") } returns jobId
        every { call.getString("url") } returns url
        // The bridge parses a small JSON number as an Integer and a large one as a Long; PluginCall reads each strictly.
        val fitsInt = durationMs != null && durationMs in Int.MIN_VALUE..Int.MAX_VALUE
        every { call.getInt("durationMs") } returns if (fitsInt) durationMs.toInt() else null
        every { call.getLong("durationMs") } returns if (fitsInt) null else durationMs
        every { call.getArray("positions") } returns positions?.let { JSArray(it) }
        every { call.resolve(any<JSObject>()) } answers { probe.resolved += firstArg<JSObject>() }
        every { call.reject(any<String>()) } answers { probe.rejected += firstArg<String>() }
        return probe
    }

    private fun cancelCall(jobId: String?): PluginCall {
        val call = mockk<PluginCall>(relaxed = true)
        every { call.getString("jobId") } returns jobId
        return call
    }

    private fun framesOf(probe: Probe): List<String> {
        val frames = probe.resolved.single().getJSONArray("frames")
        return List(frames.length()) { frames.getString(it) }
    }

    // --- validation ------------------------------------------------------------------------------

    @Test
    fun rejectsEveryInvalidRequestWithAFixedMessageBeforeAnyWork() {
        val cases = listOf(
            callFor(jobId = null) to "Invalid video job id",
            callFor(jobId = "") to "Invalid video job id",
            callFor(jobId = "../escape") to "Invalid video job id",
            callFor(jobId = "a/b") to "Invalid video job id",
            callFor(jobId = "x".repeat(65)) to "Invalid video job id",
            callFor(url = null) to "No video media URL provided",
            callFor(url = "") to "No video media URL provided",
            callFor(url = "http://media.gurushots.com/clip.mp4?sig=secret-token") to "Video media URL is not an allowed GuruShots media URL",
            callFor(url = "not an URL ?sig=secret-token") to "Video media URL is invalid",
            callFor(durationMs = null) to "Video duration is outside the supported range",
            callFor(durationMs = 0) to "Video duration is outside the supported range",
            callFor(durationMs = -5) to "Video duration is outside the supported range",
            callFor(positions = null) to "Video frame positions are invalid",
            callFor(positions = "[]") to "Video frame positions are invalid",
            callFor(positions = "[0,0,0,0,0,0,0,0,0]") to "Video frame positions are invalid",
            callFor(positions = "[\"half\"]") to "Video frame positions are invalid",
            callFor(positions = "[-0.1]") to "Video frame positions are invalid",
            callFor(positions = "[1.1]") to "Video frame positions are invalid",
            callFor(positions = "[0.5, 2]") to "Video frame positions are invalid",
        )

        for ((probe, message) in cases) {
            plugin.extractFrames(probe.call)
            assertEquals(message, listOf(message), probe.rejected)
            assertFalse(probe.rejected.single()!!.contains("secret-token"))
        }
        verify(exactly = 0) { downloader.download(any(), any(), any(), any()) }
        assertTrue(timeouts.entries.isEmpty())
    }

    @Test
    fun acceptsTheBoundsOfARequest() {
        val first = callFor(jobId = "a".repeat(64), durationMs = 1, positions = "[0, 1]")
        plugin.extractFrames(first.call)
        assertEquals(1, first.resolved.size)

        val second = callFor(jobId = "job-b", durationMs = 120_000, positions = "[0,0.1,0.2,0.3,0.4,0.5,0.6,1]")
        plugin.extractFrames(second.call)
        assertEquals(1, second.resolved.size)
        verify(exactly = 1) { extractor.extract(any(), 1L, listOf(0.0, 1.0), any(), any()) }
        verify(exactly = 1) {
            extractor.extract(any(), 120_000L, listOf(0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 1.0), any(), any())
        }
    }

    @Test
    fun doesNotRefuseAClipByItsLengthWhetherTheBridgeSendsAnIntegerOrALong() {
        val longerThanBefore = callFor(jobId = "job-a", durationMs = 121_000)
        plugin.extractFrames(longerThanBefore.call)
        val pastIntRange = callFor(jobId = "job-b", durationMs = 5_000_000_000L)
        plugin.extractFrames(pastIntRange.call)

        assertEquals(1, longerThanBefore.resolved.size)
        assertEquals(1, pastIntRange.resolved.size)
        verify(exactly = 1) { extractor.extract(any(), 121_000L, any(), any(), any()) }
        verify(exactly = 1) { extractor.extract(any(), 5_000_000_000L, any(), any(), any()) }
    }

    @Test
    fun anInvalidCallDoesNotDisturbTheRunningJob() {
        blockDownloads()
        val running = callFor("job-a")
        plugin.extractFrames(running.call)
        awaitStarted("job-a")

        val invalid = callFor("job-b", url = null)
        plugin.extractFrames(invalid.call)

        assertEquals(listOf<String?>("No video media URL provided"), invalid.rejected)
        assertEquals(0, running.settles)
        gate("job-a").release.countDown()
        awaitTrue("job-a resolved") { running.resolved.size == 1 }
    }

    // --- happy path and failures through the real downloader and extractor -----------------------

    private fun useRealWork(client: OkHttpClient = OkHttpClient.Builder().addInterceptor(TestSupport.rerouting(server)).build()) {
        VideoMediaPlugin.downloaderFactory = { VideoMediaDownloader(VideoMediaDownloader.newClient(client.newBuilder())) }
        VideoMediaPlugin.extractorFactory = originalExtractorFactory
    }

    private fun seedClip(jobId: String) {
        val path = File(videoDir, "$jobId.mp4").absolutePath
        ShadowMediaMetadataRetriever.addMetadata(path, MediaMetadataRetriever.METADATA_KEY_DURATION, "10000")
        ShadowMediaMetadataRetriever.addFrame(path, 5_000_000, Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888))
    }

    @Test
    fun downloadsDecodesAndResolvesFramesThenCleansUp() {
        useRealWork()
        server.enqueue(MockResponse.Builder().code(200).body(Buffer().write(byteArrayOf(1, 2, 3))).build())
        seedClip("job-ok")
        val probe = callFor("job-ok", url = "$VIDEO?sig=abc")

        plugin.extractFrames(probe.call)

        assertEquals(1, probe.settles)
        val frames = framesOf(probe)
        assertEquals(1, frames.size)
        assertTrue(frames.single().startsWith("data:image/jpeg;base64,"))
        assertTrue(videoDir.isDirectory)
        assertEquals(emptyList<String>(), videoDir.list()!!.toList())
        // One watchdog for opening the clip and one for the single frame, both stopped when their step returned.
        assertEquals(listOf(30_000L, 30_000L), timeouts.entries.map { it.delayMs })
        assertTrue(timeouts.entries.all { it.cancelled })
        assertEquals("/clip.mp4", server.takeRequest().url.encodedPath)
    }

    @Test
    fun passesAFixedRefusalFromTheDownloaderOrExtractorThrough() {
        useRealWork()
        server.enqueue(MockResponse.Builder().code(302).addHeader("Location", "https://media.gurushots.com/other.mp4").build())
        val redirected = callFor("job-redirect", url = "$VIDEO?sig=secret-token")
        plugin.extractFrames(redirected.call)
        assertEquals(listOf<String?>("Video media download redirected"), redirected.rejected)

        server.enqueue(MockResponse.Builder().code(200).body("ok").build())
        val noFrame = callFor("job-noframe")
        plugin.extractFrames(noFrame.call)
        assertEquals(listOf<String?>("Video frame decoding failed"), noFrame.rejected)
        assertEquals(emptyList<String>(), videoDir.list()!!.toList())
    }

    @Test
    fun hidesOtherFailuresBehindAFixedMessageWithoutTheUrl() {
        useRealWork(OkHttpClient.Builder().addInterceptor(TestSupport.failingBodyInterceptor()).build())
        val probe = callFor("job-io", url = "$VIDEO?sig=secret-token")

        plugin.extractFrames(probe.call)

        assertEquals(listOf<String?>("Video extraction failed"), probe.rejected)
        assertEquals(emptyList<String>(), videoDir.list()!!.toList())
    }

    @Test
    fun aDiskWriteErrorRejectsWithAFixedMessageAndDeletesThePartialFile() {
        stubDownload { _, file, _, _ ->
            file.writeText("partial")
            throw IOException("write failed: ENOSPC (No space left on device)")
        }
        val probe = callFor("job-full", url = "$VIDEO?sig=secret-token")

        plugin.extractFrames(probe.call)

        assertEquals(listOf<String?>("Video extraction failed"), probe.rejected)
        assertEquals(emptyList<String>(), videoDir.list()!!.toList())
    }

    @Test
    fun turnsOutOfMemoryDuringDecodeIntoAFixedRefusal() {
        val retriever = mockk<MediaMetadataRetriever>(relaxed = true)
        every { retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION) } returns "10000"
        every { retriever.getFrameAtTime(any<Long>(), any<Int>()) } throws OutOfMemoryError("bitmap")
        VideoMediaPlugin.extractorFactory = { VideoFrameExtractor(retrieverFactory = { retriever }) }
        val probe = callFor("job-oom")

        plugin.extractFrames(probe.call)

        assertEquals(listOf<String?>("Video frame decoding ran out of memory"), probe.rejected)
        verify(exactly = 1) { retriever.release() }
    }

    // --- job model --------------------------------------------------------------------------------

    @Test
    fun aNewCallReplacesTheCurrentJobAndDropsItsLateResult() {
        blockDownloads()
        val old = callFor("job-a")
        plugin.extractFrames(old.call)
        awaitStarted("job-a")

        val replacement = callFor("job-b")
        plugin.extractFrames(replacement.call)

        // The old call is rejected at once, while its native work is still blocked.
        assertEquals(listOf<String?>(CANCELLED), old.rejected)
        verify(atLeast = 1) { httpCall.cancel() }
        awaitStarted("job-b")
        assertEquals(0, replacement.settles)

        // The old job finishes its blocked step, sees it was cancelled and cleans up; it settles nothing more.
        gate("job-a").release.countDown()
        awaitTrue("old clip deleted") { !File(videoDir, "job-a.mp4").exists() }
        assertEquals(listOf<String?>(CANCELLED), old.rejected)
        assertEquals(0, old.resolved.size)
        assertEquals(0, replacement.settles)

        gate("job-b").release.countDown()
        awaitTrue("replacement resolved") { replacement.resolved.size == 1 }
        assertEquals(1, replacement.settles)
        assertEquals(1, extractions.get())
    }

    @Test
    fun aCancelForAnOldIdLeavesTheRunningJobAloneAndTheRightIdStopsIt() {
        blockDownloads()
        val old = callFor("job-a")
        plugin.extractFrames(old.call)
        awaitStarted("job-a")
        val current = callFor("job-b")
        plugin.extractFrames(current.call)
        awaitStarted("job-b")

        val staleCancel = cancelCall("job-a")
        plugin.cancel(staleCancel)
        verify(exactly = 1) { staleCancel.resolve() }
        val unknownCancel = cancelCall(null)
        plugin.cancel(unknownCancel)
        verify(exactly = 1) { unknownCancel.resolve() }
        assertEquals(0, current.settles)

        val rightCancel = cancelCall("job-b")
        plugin.cancel(rightCancel)
        verify(exactly = 1) { rightCancel.resolve() }
        assertEquals(listOf<String?>(CANCELLED), current.rejected)

        gate("job-b").release.countDown()
        awaitTrue("cancelled clip deleted") { !File(videoDir, "job-b.mp4").exists() }
        assertEquals(1, current.settles)
        assertEquals(0, extractions.get())

        // Nothing is current any more, so a repeated cancel is a no-op that still answers.
        val repeat = cancelCall("job-b")
        plugin.cancel(repeat)
        verify(exactly = 1) { repeat.resolve() }
        assertEquals(1, current.settles)
    }

    @Test
    fun cancelsTheDownloadCallThatStartsAfterTheCancel() {
        val probe = callFor("job-a")
        val late = mockk<Call>(relaxed = true)
        stubDownload { _, file, _, onCall ->
            file.writeText("clip")
            plugin.cancel(cancelCall("job-a"))
            onCall(late)
            throw IOException("Canceled")
        }

        plugin.extractFrames(probe.call)

        verify(exactly = 1) { late.cancel() }
        assertEquals(listOf<String?>(CANCELLED), probe.rejected)
        assertEquals(0, probe.resolved.size)
    }

    @Test
    fun aCancelledJobSeenByTheExtractorStaysCancelled() {
        every { extractor.extract(any(), any(), any(), any(), any()) } answers {
            plugin.cancel(cancelCall("job-a"))
            if (arg<() -> Boolean>(3)()) throw VideoJobCancelled()
            listOf(FRAME)
        }
        val probe = callFor("job-a")

        plugin.extractFrames(probe.call)

        assertEquals(listOf<String?>(CANCELLED), probe.rejected)
        assertEquals(0, probe.resolved.size)
    }

    @Test
    fun everyCallSettlesExactlyOnceWhicheverComesFirst() {
        // A result first: a later cancel changes nothing.
        val done = callFor("job-a")
        plugin.extractFrames(done.call)
        assertEquals(1, done.settles)
        plugin.cancel(cancelCall("job-a"))
        assertEquals(1, done.settles)
        assertEquals(1, done.resolved.size)

        // A watchdog first: the late result is dropped.
        blockExtractions()
        val timedOut = callFor("job-b")
        plugin.extractFrames(timedOut.call)
        awaitStarted("job-b")
        timeouts.fire()
        assertEquals(listOf<String?>("Video extraction timed out"), timedOut.rejected)
        gate("job-b").release.countDown()
        awaitTrue("timed-out clip deleted") { !File(videoDir, "job-b.mp4").exists() }
        assertEquals(1, timedOut.settles)

        // A cancel first: a later watchdog overrun changes nothing.
        val cancelled = callFor("job-c")
        plugin.extractFrames(cancelled.call)
        awaitStarted("job-c")
        plugin.cancel(cancelCall("job-c"))
        timeouts.fire()
        assertEquals(listOf<String?>(CANCELLED), cancelled.rejected)
        gate("job-c").release.countDown()
        awaitTrue("cancelled clip deleted") { !File(videoDir, "job-c.mp4").exists() }
        assertEquals(1, cancelled.settles)
    }

    @Test
    fun aWatchdogOverrunCancelsTheDownloadCallAndDropsTheJobsResult() {
        blockExtractions()
        val probe = callFor("job-a")
        plugin.extractFrames(probe.call)
        awaitStarted("job-a")

        timeouts.fire()

        assertEquals(listOf<String?>("Video extraction timed out"), probe.rejected)
        verify(atLeast = 1) { httpCall.cancel() }
        gate("job-a").release.countDown()
        awaitTrue("clip deleted") { !File(videoDir, "job-a.mp4").exists() }
        assertEquals(0, extractions.get())
        assertEquals(1, probe.settles)
    }

    @Test
    fun givesEveryStepTheSameThirtySecondsWhateverTheClipLength() {
        blockExtractions()
        val short = callFor("job-a", durationMs = 1_000)
        plugin.extractFrames(short.call)
        awaitStarted("job-a")
        val long = callFor("job-b", durationMs = 3_600_000)
        plugin.extractFrames(long.call)
        awaitStarted("job-b")

        assertEquals(listOf(30_000L, 30_000L), timeouts.entries.map { it.delayMs })
    }

    @Test
    fun theDefaultWatchdogFiresOnTheMainLooperOnlyWhenAStepOverrunsItsBudget() {
        VideoMediaPlugin.timeoutSource = originalTimeoutSource
        blockExtractions()
        val stuck = callFor("job-a")
        plugin.extractFrames(stuck.call)
        awaitStarted("job-a")

        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(29_999))
        assertEquals(0, stuck.settles)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1))
        assertEquals(listOf<String?>("Video extraction timed out"), stuck.rejected)

        // Steps that return within their budget stop their watchdog, so no amount of waiting rejects the call.
        VideoMediaPlugin.dispatcher = Dispatchers.Unconfined
        every { extractor.extract(any(), any(), any(), any(), any()) } answers {
            arg<() -> Runnable>(4)().run()
            listOf(FRAME)
        }
        val finished = callFor("job-b")
        plugin.extractFrames(finished.call)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMinutes(10))
        assertEquals(1, finished.resolved.size)
        assertEquals(0, finished.rejected.size)
    }

    // --- lifecycle --------------------------------------------------------------------------------

    @Test
    fun loadClearsClipsLeftByAKilledProcess() {
        File(videoDir, "nested").mkdirs()
        File(videoDir, "old.mp4").writeText("left over")
        File(videoDir, "nested/older.mp4").writeText("left over")

        plugin.load()

        assertFalse(videoDir.exists())
        plugin.load()
    }

    @Test
    fun destroyCancelsTheCurrentJobAndStopsNewWork() {
        blockDownloads()
        val running = callFor("job-a")
        plugin.extractFrames(running.call)
        awaitStarted("job-a")

        plugin.handleOnDestroy()

        assertEquals(listOf<String?>(CANCELLED), running.rejected)
        gate("job-a").release.countDown()
        awaitTrue("clip deleted") { !File(videoDir, "job-a.mp4").exists() }

        // The scope is gone: a call after destroy starts nothing.
        VideoMediaPlugin.dispatcher = Dispatchers.Unconfined
        val late = callFor("job-b")
        plugin.extractFrames(late.call)
        assertEquals(0, late.settles)
        verify(exactly = 1) { downloader.download(any(), any(), any(), any()) }

        // Destroying with nothing running is fine.
        plugin.handleOnDestroy()
    }

    @Test
    fun theDefaultSeamsPointAtTheRealImplementations() {
        assertEquals(VideoMediaDownloader::class, originalDownloaderFactory()::class)
        assertEquals(VideoFrameExtractor::class, originalExtractorFactory()::class)
        assertSame(Dispatchers.IO, originalDispatcher)
        assertEquals(File(app.cacheDir, "snap-video"), originalVideoDirProvider(app))
        val fired = CountDownLatch(1)
        val cancel = originalTimeoutSource.schedule(10) { fired.countDown() }
        assertNotNull(cancel)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(10))
        assertEquals(0, fired.count)
        val never = CountDownLatch(1)
        originalTimeoutSource.schedule(10) { never.countDown() }.run()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(10))
        assertEquals(1, never.count)
    }

    @Test
    fun theDefaultDispatcherRunsAJobOffTheCallingThread() {
        VideoMediaPlugin.dispatcher = originalDispatcher
        val caller = Thread.currentThread()
        val ran = CountDownLatch(1)
        var runner: Thread? = null
        stubDownload { _, file, _, _ ->
            runner = Thread.currentThread()
            file.writeText("clip")
            ran.countDown()
        }
        val probe = callFor("job-a")

        plugin.extractFrames(probe.call)

        assertTrue(ran.await(10, TimeUnit.SECONDS))
        awaitTrue("resolved") { probe.resolved.size == 1 }
        assertTrue(runner !== caller)
    }
}
