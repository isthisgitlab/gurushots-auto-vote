package com.isthisgitlab.gurushotsautovote

import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * Decodes ordered JPEG frames from one downloaded Snap video.
 *
 * Trust boundary: the media parser used to run inside the WebView renderer (a `<video>` element
 * fed a Blob URL). It now runs in [MediaMetadataRetriever], which on current Android parses in
 * the out-of-process `media.extractor`/`media.codec` services. Nothing from the clip reaches
 * JavaScript except the bounded JPEG data URLs this class returns.
 */
internal class VideoFrameExtractor(
    private val retrieverFactory: () -> MediaMetadataRetriever = { MediaMetadataRetriever() },
    private val maxJpegBytes: Int = MAX_JPEG_BYTES,
) {

    companion object {
        internal const val MAX_JPEG_BYTES = 2 * 1024 * 1024
        internal const val JPEG_PREFIX = "data:image/jpeg;base64,"
        private const val JPEG_QUALITY = 85
        private const val MAX_SOURCE_DIMENSION = 3840L
        private const val MAX_FRAME_WIDTH = 1280.0
        private const val MAX_FRAME_HEIGHT = 720.0
        private const val MAX_VIDEO_DURATION_MS = 120_000L

        /**
         * The shared clamp rule of `videoFrameTimestampMs` (src/ts/core/platform/videoMedia.ts): the
         * shorter of the server and the decoded duration, never seeking exactly to the end.
         */
        internal fun frameTimestampMs(serverDurationMs: Long, actualDurationMs: Long, position: Double): Double {
            val durationMs = min(serverDurationMs, actualDurationMs).toDouble()
            return min(durationMs * position, max(0.0, durationMs - 1))
        }
    }

    /** Returns one JPEG data URL per position, in order; [isCancelled] is checked before each frame. */
    fun extract(file: File, serverDurationMs: Long, positions: List<Double>, isCancelled: () -> Boolean): List<String> {
        val retriever = retrieverFactory()
        try {
            retriever.setDataSource(file.absolutePath)
            val width = metadataNumber(retriever, MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
            val height = metadataNumber(retriever, MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
            // Fail closed before any decode: a crafted 8K clip would need ~133 MB for one bitmap.
            if (
                width == null || height == null || width <= 0 || height <= 0 ||
                max(width, height) > MAX_SOURCE_DIMENSION
            ) {
                throw VideoMediaDownloader.Rejection("Video dimensions are outside the supported range")
            }
            val actualDurationMs = metadataNumber(retriever, MediaMetadataRetriever.METADATA_KEY_DURATION)
            if (actualDurationMs == null || actualDurationMs <= 0 || actualDurationMs > MAX_VIDEO_DURATION_MS) {
                throw VideoMediaDownloader.Rejection("Decoded video duration is outside the supported range")
            }
            return positions.map { position ->
                if (isCancelled()) throw VideoJobCancelled()
                val timestampUs =
                    (frameTimestampMs(serverDurationMs, actualDurationMs, position) * 1000).roundToLong()
                frameDataUrl(retriever, timestampUs)
            }
        } catch (_: OutOfMemoryError) {
            throw VideoMediaDownloader.Rejection("Video frame decoding ran out of memory")
        } finally {
            retriever.release()
        }
    }

    private fun metadataNumber(retriever: MediaMetadataRetriever, key: Int): Long? =
        retriever.extractMetadata(key)?.toLongOrNull()

    private fun frameDataUrl(retriever: MediaMetadataRetriever, timestampUs: Long): String {
        val frame = retriever.getFrameAtTime(timestampUs, MediaMetadataRetriever.OPTION_CLOSEST)
            ?: throw VideoMediaDownloader.Rejection("Video frame decoding failed")
        try {
            val scaled = fitFrame(frame)
            try {
                val jpeg = ByteArrayOutputStream()
                if (!scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, jpeg)) {
                    throw VideoMediaDownloader.Rejection("Video frame encoding failed")
                }
                if (jpeg.size() > maxJpegBytes) throw VideoMediaDownloader.Rejection("Video frame JPEG is too large")
                return JPEG_PREFIX + Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP)
            } finally {
                if (scaled !== frame) scaled.recycle()
            }
        } finally {
            frame.recycle()
        }
    }

    /** The frame itself when it already fits 1280x720, otherwise a scaled copy. */
    private fun fitFrame(frame: Bitmap): Bitmap {
        val ratio = min(1.0, min(MAX_FRAME_WIDTH / frame.width, MAX_FRAME_HEIGHT / frame.height))
        if (ratio >= 1.0) return frame
        val width = max(1, (frame.width * ratio).roundToInt())
        val height = max(1, (frame.height * ratio).roundToInt())
        return Bitmap.createScaledBitmap(frame, width, height, true)
    }
}
