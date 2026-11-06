package com.isthisgitlab.gurushotsautovote

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.util.Base64
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowMediaMetadataRetriever
import java.io.File

@RunWith(RobolectricTestRunner::class)
class VideoFrameExtractorTest {

    @get:Rule
    val folder = TemporaryFolder()

    private lateinit var clip: File

    @Before
    fun setUp() {
        clip = folder.newFile("clip.mp4")
    }

    @After
    fun tearDown() {
        ShadowMediaMetadataRetriever.reset()
    }

    private fun bitmap(width: Int, height: Int): Bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)

    private fun seedMetadata(duration: String? = "10000") {
        val path = clip.absolutePath
        if (duration != null) ShadowMediaMetadataRetriever.addMetadata(path, MediaMetadataRetriever.METADATA_KEY_DURATION, duration)
    }

    private fun seedFrame(timestampUs: Long, frame: Bitmap) =
        ShadowMediaMetadataRetriever.addFrame(clip.absolutePath, timestampUs, frame)

    private fun decode(dataUrl: String): ByteArray {
        assertTrue(dataUrl.startsWith("data:image/jpeg;base64,"))
        return Base64.decode(dataUrl.removePrefix("data:image/jpeg;base64,"), Base64.DEFAULT)
    }

    private fun assertJpeg(dataUrl: String, width: Int, height: Int) {
        val bytes = decode(dataUrl)
        assertEquals(0xFF.toByte(), bytes[0])
        assertEquals(0xD8.toByte(), bytes[1])
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        assertEquals(width, decoded.width)
        assertEquals(height, decoded.height)
    }

    private fun extract(
        positions: List<Double> = listOf(0.5),
        serverDurationMs: Long = 10_000,
        extractor: VideoFrameExtractor = VideoFrameExtractor(),
        isCancelled: () -> Boolean = { false },
        startStep: () -> Runnable = { Runnable {} },
    ) = extractor.extract(clip, serverDurationMs, positions, isCancelled, startStep)

    private fun assertRejected(message: String, block: () -> Unit) {
        try {
            block()
        } catch (error: VideoMediaDownloader.Rejection) {
            assertEquals(message, error.message)
            return
        }
        throw AssertionError("expected a refusal: $message")
    }

    /** A retriever that reports [duration] and decodes only what a test stubs on it. */
    private fun fakeRetriever(duration: String? = "10000"): MediaMetadataRetriever {
        val retriever = mockk<MediaMetadataRetriever>(relaxed = true)
        every { retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION) } returns duration
        return retriever
    }

    @Test
    fun clampsTimestampsLikeTheCoreRule() {
        // The same table is pinned in tests/platform/videoFrameTimestamps.test.ts against
        // videoFrameTimestampMs (src/ts/core/platform/videoMedia.ts). Change both together.
        // columns: server ms, decoded ms, position, expected ms
        val table = listOf(
            listOf(10_000.0, 10_000.0, 0.0, 0.0),
            listOf(10_000.0, 10_000.0, 0.25, 2_500.0),
            listOf(10_000.0, 10_000.0, 0.5, 5_000.0),
            listOf(10_000.0, 10_000.0, 0.75, 7_500.0),
            listOf(10_000.0, 10_000.0, 1.0, 9_999.0),
            listOf(10_000.0, 2_000.0, 1.0, 1_999.0),
            listOf(10_000.0, 2_000.0, 0.5, 1_000.0),
            listOf(2_000.0, 10_000.0, 0.5, 1_000.0),
            listOf(2_000.0, 10_000.0, 1.0, 1_999.0),
            listOf(1.0, 1.0, 1.0, 0.0),
            listOf(1.0, 1.0, 0.5, 0.0),
            listOf(2.0, 2.0, 0.5, 1.0),
            listOf(120_000.0, 120_000.0, 1.0, 119_999.0),
            listOf(300_000.0, 300_000.0, 0.5, 150_000.0),
        )
        for ((server, actual, position, expected) in table) {
            assertEquals(
                "server=$server actual=$actual position=$position",
                expected,
                VideoFrameExtractor.frameTimestampMs(server.toLong(), actual.toLong(), position),
                0.0,
            )
        }
        // No decoded duration: the server duration alone is used.
        for ((server, position, expected) in listOf(
            Triple(10_000L, 0.5, 5_000.0),
            Triple(10_000L, 1.0, 9_999.0),
            Triple(1L, 1.0, 0.0),
        )) {
            assertEquals(expected, VideoFrameExtractor.frameTimestampMs(server, null, position), 0.0)
        }
    }

    @Test
    fun decodesEachPositionAtTheExactClampedTimestampAndKeepsTheOrder() {
        seedMetadata(duration = "8000")
        // Server 10 s, decoded 8 s: the shorter wins. Distinct widths tell the frames apart.
        seedFrame(2_000_000, bitmap(200, 100))
        seedFrame(4_000_000, bitmap(300, 100))
        seedFrame(7_999_000, bitmap(400, 100))

        val frames = extract(positions = listOf(0.25, 0.5, 1.0))

        assertEquals(3, frames.size)
        assertJpeg(frames[0], 200, 100)
        assertJpeg(frames[1], 300, 100)
        assertJpeg(frames[2], 400, 100)
    }

    @Test
    fun scalesAFrameToFitTheBoundingBoxAndLeavesASmallerOneAlone() {
        seedMetadata()
        seedFrame(1_000_000, bitmap(2560, 1440))
        seedFrame(2_000_000, bitmap(1080, 1920))
        seedFrame(3_000_000, bitmap(1280, 720))
        seedFrame(4_000_000, bitmap(320, 180))
        seedFrame(5_000_000, bitmap(4000, 2))

        val frames = extract(positions = listOf(0.1, 0.2, 0.3, 0.4, 0.5))

        assertJpeg(frames[0], 1280, 720)
        assertJpeg(frames[1], 405, 720)
        assertJpeg(frames[2], 1280, 720)
        assertJpeg(frames[3], 320, 180)
        assertJpeg(frames[4], 1280, 1)
    }

    @Test
    fun recyclesTheDecodedFrameAndTheScaledCopy() {
        val retriever = fakeRetriever()
        val large = bitmap(2560, 1440)
        val small = bitmap(100, 100)
        every { retriever.getFrameAtTime(any<Long>(), any<Int>()) } returnsMany listOf(large, small)
        val extractor = VideoFrameExtractor(retrieverFactory = { retriever })

        assertEquals(2, extract(positions = listOf(0.5, 0.1), extractor = extractor).size)

        assertTrue(large.isRecycled)
        assertTrue(small.isRecycled)
    }

    @Test
    fun releasesTheRetrieverOnEveryPath() {
        val retriever = fakeRetriever()
        every { retriever.getFrameAtTime(any<Long>(), any<Int>()) } returns bitmap(10, 10)
        val extractor = VideoFrameExtractor(retrieverFactory = { retriever })

        extract(extractor = extractor)
        verify(exactly = 1) { retriever.release() }
        verify(exactly = 1) { retriever.setDataSource(clip.absolutePath) }

        every { retriever.setDataSource(any<String>()) } throws IllegalArgumentException("corrupt")
        try {
            extract(extractor = extractor)
        } catch (_: IllegalArgumentException) {
            // a clip the platform cannot open surfaces as is
        }
        verify(exactly = 2) { retriever.release() }
    }

    @Test
    fun doesNotRefuseAnyFrameSizeAndNeverReadsTheDimensions() {
        // 8K metadata was refused before; now the frame is decoded at full size and fitted afterwards.
        val retriever = fakeRetriever()
        every { retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH) } returns "7680"
        every { retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT) } returns "4320"
        val large = bitmap(2560, 1440)
        every { retriever.getFrameAtTime(any<Long>(), any<Int>()) } returns large
        val extractor = VideoFrameExtractor(retrieverFactory = { retriever })

        val frames = extract(extractor = extractor)

        assertJpeg(frames.single(), 1280, 720)
        assertTrue(large.isRecycled)
        verify(exactly = 1) { retriever.getFrameAtTime(5_000_000L, MediaMetadataRetriever.OPTION_CLOSEST) }
        verify(exactly = 0) { retriever.getScaledFrameAtTime(any<Long>(), any<Int>(), any<Int>(), any<Int>()) }
        verify(exactly = 0) { retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH) }
        verify(exactly = 0) { retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT) }
    }

    @Test
    fun seeksByTheServerDurationWhenTheDecodedOneIsMissingGarbledOrNotPositive() {
        for (duration in listOf<String?>(null, "long", "0", "-5")) {
            val retriever = fakeRetriever(duration = duration)
            every { retriever.getFrameAtTime(any<Long>(), any<Int>()) } returns bitmap(10, 10)
            val extractor = VideoFrameExtractor(retrieverFactory = { retriever })

            assertEquals(1, extract(extractor = extractor).size)

            verify(exactly = 1) { retriever.getFrameAtTime(5_000_000L, MediaMetadataRetriever.OPTION_CLOSEST) }
        }
    }

    @Test
    fun acceptsAClipPastTheFormerOneHundredTwentySecondLimit() {
        seedMetadata(duration = "300000")
        seedFrame(150_000_000, bitmap(10, 10))

        assertEquals(1, extract(serverDurationMs = 300_000).size)
    }

    @Test
    fun rejectsAFrameTheDecoderCannotProduce() {
        seedMetadata()

        assertRejected("Video frame decoding failed") { extract() }
    }

    @Test
    fun checksCancellationBeforeEveryFrameAndStopsWithoutDecodingMore() {
        val retriever = fakeRetriever()
        every { retriever.getFrameAtTime(any<Long>(), any<Int>()) } returns bitmap(10, 10)
        val extractor = VideoFrameExtractor(retrieverFactory = { retriever })
        var checks = 0

        try {
            extract(positions = listOf(0.1, 0.2, 0.3), extractor = extractor, isCancelled = { ++checks > 1 })
            throw AssertionError("expected a cancellation")
        } catch (error: VideoJobCancelled) {
            assertEquals("Video extraction was cancelled", error.message)
        }

        assertEquals(2, checks)
        verify(exactly = 1) { retriever.getFrameAtTime(any<Long>(), any<Int>()) }
        verify(exactly = 1) { retriever.release() }
    }

    @Test
    fun turnsOutOfMemoryIntoARefusalAndStillReleases() {
        val retriever = fakeRetriever()
        every { retriever.getFrameAtTime(any<Long>(), any<Int>()) } throws OutOfMemoryError("bitmap")
        val extractor = VideoFrameExtractor(retrieverFactory = { retriever })

        assertRejected("Video frame decoding ran out of memory") { extract(extractor = extractor) }

        verify(exactly = 1) { retriever.release() }
    }

    @Test
    fun requestsClosestFramesAtMicrosecondTimestamps() {
        val retriever = fakeRetriever(duration = "9000")
        every { retriever.getFrameAtTime(any<Long>(), any<Int>()) } returns bitmap(10, 10)
        val extractor = VideoFrameExtractor(retrieverFactory = { retriever })

        extract(positions = listOf(0.5, 1.0), serverDurationMs = 10_000, extractor = extractor)

        verify(exactly = 1) { retriever.getFrameAtTime(4_500_000L, MediaMetadataRetriever.OPTION_CLOSEST) }
        verify(exactly = 1) { retriever.getFrameAtTime(8_999_000L, MediaMetadataRetriever.OPTION_CLOSEST) }
    }

    @Test
    fun rejectsAFrameTheEncoderCannotWrite() {
        val retriever = fakeRetriever()
        val frame = mockk<Bitmap>(relaxed = true)
        every { frame.width } returns 100
        every { frame.height } returns 100
        every { frame.compress(any(), any(), any()) } returns false
        every { retriever.getFrameAtTime(any<Long>(), any<Int>()) } returns frame
        val extractor = VideoFrameExtractor(retrieverFactory = { retriever })

        assertRejected("Video frame encoding failed") { extract(extractor = extractor) }

        verify(exactly = 1) { frame.recycle() }
    }

    @Test
    fun rejectsAJpegOverTheLimitAndAcceptsOneAtTheLimit() {
        seedMetadata()
        seedFrame(5_000_000, bitmap(300, 200))
        val size = decode(extract()[0]).size

        assertEquals(1, extract(extractor = VideoFrameExtractor(maxJpegBytes = size)).size)

        val retriever = fakeRetriever()
        val frame = bitmap(300, 200)
        every { retriever.getFrameAtTime(any<Long>(), any<Int>()) } returns frame
        assertRejected("Video frame JPEG is too large") {
            extract(extractor = VideoFrameExtractor(retrieverFactory = { retriever }, maxJpegBytes = size - 1))
        }
        assertTrue(frame.isRecycled)
    }

    @Test
    fun watchesOpeningTheClipAndEveryFrameDecodeAndStopsEachWatchdogWhenItsStepReturns() {
        val events = mutableListOf<String>()
        val retriever = fakeRetriever()
        every { retriever.setDataSource(any<String>()) } answers { events += "open" }
        every { retriever.getFrameAtTime(any<Long>(), any<Int>()) } answers {
            events += "frame"
            bitmap(10, 10)
        }
        val extractor = VideoFrameExtractor(retrieverFactory = { retriever })

        extract(
            positions = listOf(0.1, 0.9),
            extractor = extractor,
            startStep = {
                events += "start"
                Runnable { events += "stop" }
            },
        )

        assertEquals(
            listOf("start", "open", "stop", "start", "frame", "stop", "start", "frame", "stop"),
            events,
        )
    }

    @Test
    fun stopsTheWatchdogWhenAStepFails() {
        val stops = mutableListOf<String>()
        val retriever = fakeRetriever()
        every { retriever.setDataSource(any<String>()) } throws IllegalArgumentException("corrupt")
        val extractor = VideoFrameExtractor(retrieverFactory = { retriever })
        try {
            extract(extractor = extractor, startStep = { Runnable { stops += "open" } })
        } catch (_: IllegalArgumentException) {
            // surfaces as is
        }

        every { retriever.setDataSource(any<String>()) } returns Unit
        every { retriever.getFrameAtTime(any<Long>(), any<Int>()) } throws OutOfMemoryError("bitmap")
        assertRejected("Video frame decoding ran out of memory") {
            extract(extractor = extractor, startStep = { Runnable { stops += "frame" } })
        }
        // First run: the failed open stopped its watchdog. Second run: the open and the failed decode each stopped one.
        assertEquals(listOf("open", "frame", "frame"), stops)
    }

    @Test
    fun theDefaultLimitIsTwoMebibytesAndTheDefaultRetrieverIsReal() {
        assertEquals(2 * 1024 * 1024, VideoFrameExtractor.MAX_JPEG_BYTES)
        seedMetadata()
        seedFrame(5_000_000, bitmap(64, 64))

        assertJpeg(extract()[0], 64, 64)
    }
}
