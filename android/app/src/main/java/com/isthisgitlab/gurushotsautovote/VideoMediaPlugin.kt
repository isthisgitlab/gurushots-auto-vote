package com.isthisgitlab.gurushotsautovote

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.annotation.VisibleForTesting
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import okhttp3.Call
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Schedules [action] after [delayMs]; the returned runnable cancels it. */
internal fun interface TimeoutSource {
    fun schedule(delayMs: Long, action: Runnable): Runnable
}

/**
 * Foreground-only bridge for Snap video frames.
 *
 * The clip is downloaded and decoded natively; only bounded JPEG data URLs cross
 * the bridge. The headless service does not register this plugin and therefore
 * cannot download or decode video.
 *
 * One job runs at a time. A new call replaces the current job; `cancel` stops the
 * job with the given id only. Every PluginCall settles exactly once, whichever of
 * result, error, cancel or watchdog comes first.
 *
 * A clip is never refused for its length or size. Hang protection follows progress: the
 * download has an idle read timeout, and each blocking native step (opening the clip, one
 * frame decode) has a [STEP_TIMEOUT_MS] watchdog. A stop or an overrun settles the JS call at
 * once; a native `getFrameAtTime` that is already running keeps its IO thread until it
 * returns, then sees the job dropped and cleans up.
 */
@CapacitorPlugin(name = "VideoMedia")
class VideoMediaPlugin : Plugin() {

    companion object {
        private const val STEP_TIMEOUT_MS = 30_000L
        private const val MIN_DURATION_MS = 1L
        private const val MAX_POSITIONS = 8
        private const val CANCELLED = "Video extraction was cancelled"
        private val JOB_ID = Regex("[A-Za-z0-9-]{1,64}")

        @VisibleForTesting
        internal var downloaderFactory: () -> VideoMediaDownloader = {
            VideoMediaDownloader(VideoMediaDownloader.newClient())
        }

        @VisibleForTesting
        internal var extractorFactory: () -> VideoFrameExtractor = { VideoFrameExtractor() }

        @VisibleForTesting
        internal var dispatcher: CoroutineDispatcher = Dispatchers.IO

        @VisibleForTesting
        internal var timeoutSource: TimeoutSource = TimeoutSource { delayMs, action ->
            val handler = Handler(Looper.getMainLooper())
            handler.postDelayed(action, delayMs)
            Runnable { handler.removeCallbacks(action) }
        }

        /** Where a job keeps its downloaded clip: `cacheDir/snap-video`. */
        @VisibleForTesting
        internal var videoDirProvider: (Context) -> File = { File(it.cacheDir, "snap-video") }
    }

    private class VideoRequest(
        val jobId: String,
        val url: String,
        val durationMs: Long,
        val positions: List<Double>,
    )

    /** One extraction. Every state change is atomic; [settle] runs its action for the first caller only. */
    private class Job(
        val id: String,
        private val call: PluginCall,
        private val timeouts: TimeoutSource,
    ) {
        private val settled = AtomicBoolean(false)
        private val cancelled = AtomicBoolean(false)

        @Volatile
        private var httpCall: Call? = null

        fun isCancelled(): Boolean = cancelled.get()

        /** Records the download call; a cancel that came first cancels it now. */
        fun attach(active: Call) {
            httpCall = active
            if (cancelled.get()) active.cancel()
        }

        fun settle(action: (PluginCall) -> Unit) {
            if (settled.compareAndSet(false, true)) action(call)
        }

        /** Starts the watchdog of one blocking native step; the returned call stops it. */
        fun startStep(): Runnable = timeouts.schedule(STEP_TIMEOUT_MS) { cancel("Video extraction timed out") }

        /** Stops the job's work, drops its result and rejects its call with [message]. */
        fun cancel(message: String) {
            cancelled.set(true)
            httpCall?.cancel()
            settle { it.reject(message) }
        }
    }

    private val scope = CoroutineScope(SupervisorJob())
    private val current = AtomicReference<Job?>()
    private val downloader: VideoMediaDownloader by lazy { downloaderFactory() }
    private val extractor: VideoFrameExtractor by lazy { extractorFactory() }

    private fun videoDir(): File = videoDirProvider(context)

    /** A file left by a killed process would otherwise stay in the cache. */
    override fun load() {
        videoDir().deleteRecursively()
    }

    @PluginMethod
    fun extractFrames(call: PluginCall) {
        val request = try {
            parse(call)
        } catch (error: VideoMediaDownloader.Rejection) {
            call.reject(error.message)
            return
        }
        val job = Job(request.jobId, call, timeoutSource)
        current.getAndSet(job)?.cancel(CANCELLED)
        scope.launch(dispatcher) { runJob(job, request) }
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val job = current.get()
        if (job != null && job.id == call.getString("jobId")) {
            current.compareAndSet(job, null)
            job.cancel(CANCELLED)
        }
        call.resolve()
    }

    public override fun handleOnDestroy() {
        current.getAndSet(null)?.cancel(CANCELLED)
        scope.cancel()
    }

    private fun parse(call: PluginCall): VideoRequest {
        val jobId = call.getString("jobId")
        if (jobId == null || !JOB_ID.matches(jobId)) throw VideoMediaDownloader.Rejection("Invalid video job id")
        val url = call.getString("url")
        if (url.isNullOrEmpty()) throw VideoMediaDownloader.Rejection("No video media URL provided")
        VideoMediaDownloader.validateUrl(url)
        // The bridge parses a small JSON number as an Integer and a large one as a Long.
        val durationMs = call.getLong("durationMs") ?: call.getInt("durationMs")?.toLong()
        if (durationMs == null || durationMs < MIN_DURATION_MS) {
            throw VideoMediaDownloader.Rejection("Video duration is outside the supported range")
        }
        val array = call.getArray("positions")
        if (array == null || array.length() < 1 || array.length() > MAX_POSITIONS) {
            throw VideoMediaDownloader.Rejection("Video frame positions are invalid")
        }
        val positions = List(array.length()) { index ->
            val value = array.opt(index)
            if (value !is Number || value.toDouble() < 0.0 || value.toDouble() > 1.0) {
                throw VideoMediaDownloader.Rejection("Video frame positions are invalid")
            }
            value.toDouble()
        }
        return VideoRequest(jobId, url, durationMs, positions)
    }

    /** Download, decode, settle. The clip file is deleted whichever way the job ends. */
    private fun runJob(job: Job, request: VideoRequest) {
        val dir = videoDir()
        val file = File(dir, "${request.jobId}.mp4")
        try {
            dir.mkdirs()
            downloader.download(request.url, file, job::isCancelled, job::attach)
            val frames = extractor.extract(file, request.durationMs, request.positions, job::isCancelled, job::startStep)
            job.settle { it.resolve(JSObject().put("frames", JSArray(frames))) }
        } catch (error: VideoMediaDownloader.Rejection) {
            job.settle { it.reject(error.message) }
        } catch (_: Exception) {
            job.settle { it.reject("Video extraction failed") }
        } finally {
            file.delete()
            current.compareAndSet(job, null)
        }
    }
}
