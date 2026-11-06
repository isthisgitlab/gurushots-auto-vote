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

    private fun seedMetadata(width: String? = "640", height: String? = "360", duration: String? = "10000") {
        val path = clip.absolutePath
        if (width != null) ShadowMediaMetadataRetriever.addMetadata(path, MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH, width)
        if (height != null) ShadowMediaMetadataRetriever.addMetadata(path, MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT, height)
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
    ) = extractor.extract(clip, serverDurationMs, positions, isCancelled)

    private fun assertRejected(message: String, block: () -> Unit) {
        try {
            block()
        } catch (error: VideoMediaDownloader.Rejection) {
            assertEquals(message, error.message)
            return
        }
        throw AssertionError("expected a refusal: $message")
    }

    /** A retriever that reports [metadata] and never decodes, so a test can see whether a decode was attempted. */
    private fun fakeRetriever(
        width: String? = "640",
        height: String? = "360",
        duration: String? = "10000",
    ): MediaMetadataRetriever {
        val retriever = mockk<MediaMetadataRetriever>(relaxed = true)
        every { retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH) } returns width
        every { retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT) } returns height
        every { retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION) } returns duration
        return retriever
    }

    @Test
    fun clampsTimestampsLikeTheCoreRule() {
        // The same table is pinned in tests/platforms/webview/videoFrameTimestamps.test.ts against
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
        )
        for ((server, actual, position, expected) in table) {
            assertEquals(
                "server=$server actual=$actual position=$position",
                expected,
                VideoFrameExtractor.frameTimestampMs(server.toLong(), actual.toLong(), position),
                0.0,
            )
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
    fun failsClosedOnMissingOrGarbledOrNonPositiveDimensionsBeforeAnyDecode() {
        val cases = listOf(
            Triple<String?, String?, String>(null, "360", "no width"),
            Triple<String?, String?, String>("640", null, "no height"),
            Triple<String?, String?, String>("wide", "360", "garbled width"),
            Triple<String?, String?, String>("640", "tall", "garbled height"),
            Triple<String?, String?, String>("0", "360", "zero width"),
            Triple<String?, String?, String>("640", "0", "zero height"),
            Triple<String?, String?, String>("-640", "360", "negative width"),
            Triple<String?, String?, String>("640", "-360", "negative height"),
            Triple<String?, String?, String>("3841", "2160", "width past the bound"),
            Triple<String?, String?, String>("2160", "3841", "height past the bound"),
            Triple<String?, String?, String>("7680", "4320", "8K"),
        )
        for ((width, height, label) in cases) {
            val retriever = fakeRetriever(width = width, height = height)
            val extractor = VideoFrameExtractor(retrieverFactory = { retriever })

            assertRejected("Video dimensions are outside the supported range ($label)") {
                try {
                    extract(extractor = extractor)
                } catch (error: VideoMediaDownloader.Rejection) {
                    throw VideoMediaDownloader.Rejection("${error.message} ($label)")
                }
            }

            verify(exactly = 0) { retriever.getFrameAtTime(any<Long>(), any<Int>()) }
            verify(exactly = 1) { retriever.release() }
        }
    }

    @Test
    fun acceptsDimensionsAtTheBound() {
        seedMetadata(width = "3840", height = "2160")
        seedFrame(5_000_000, bitmap(64, 36))
        assertEquals(1, extract().size)

        ShadowMediaMetadataRetriever.reset()
        seedMetadata(width = "2160", height = "3840")
        seedFrame(5_000_000, bitmap(36, 64))
        assertEquals(1, extract().size)
    }

    @Test
    fun rejectsAMissingGarbledOrOutOfRangeDecodedDuration() {
        for (duration in listOf<String?>(null, "long", "0", "-5", "120001")) {
            val retriever = fakeRetriever(duration = duration)
            val extractor = VideoFrameExtractor(retrieverFactory = { retriever })

            assertRejected("Decoded video duration is outside the supported range") { extract(extractor = extractor) }

            verify(exactly = 0) { retriever.getFrameAtTime(any<Long>(), any<Int>()) }
        }

        seedMetadata(duration = "120000")
        seedFrame(60_000_000, bitmap(10, 10))
        assertEquals(1, extract(serverDurationMs = 120_000).size)
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
    fun theDefaultLimitIsTwoMebibytesAndTheDefaultRetrieverIsReal() {
        assertEquals(2 * 1024 * 1024, VideoFrameExtractor.MAX_JPEG_BYTES)
        seedMetadata()
        seedFrame(5_000_000, bitmap(64, 64))

        assertJpeg(extract()[0], 64, 64)
    }
}
