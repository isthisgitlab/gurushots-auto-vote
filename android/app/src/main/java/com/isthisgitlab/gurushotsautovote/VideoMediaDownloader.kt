package com.isthisgitlab.gurushotsautovote

import androidx.annotation.VisibleForTesting
import okhttp3.Call
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Downloads one Snap video to a file after enforcing the CDN boundary in native code.
 *
 * The WebView passes only an URL. This class neither accepts nor forwards
 * headers, cookies, or credentials from JavaScript.
 */
internal class VideoMediaDownloader(private val http: OkHttpClient) {

    /** A refusal with a fixed, URL-free message that the plugin passes to the caller as is. */
    internal open class Rejection(message: String) : Exception(message)

    companion object {
        internal const val MAX_VIDEO_BYTES = 256L * 1024 * 1024
        private const val VIDEO_HOST = "media.gurushots.com"
        private const val BUFFER_BYTES = 64 * 1024

        @VisibleForTesting
        internal fun newClient(builder: OkHttpClient.Builder = OkHttpClient.Builder()): OkHttpClient =
            builder
                .cookieJar(CookieJar.NO_COOKIES)
                .followRedirects(false)
                .followSslRedirects(false)
                // Idle limit only: the whole-call bound is set per call from the clip length.
                .readTimeout(30, TimeUnit.SECONDS)
                .build()

        internal fun validateUrl(rawUrl: String): HttpUrl {
            val url = rawUrl.toHttpUrlOrNull()
                ?: throw Rejection("Video media URL is invalid")
            if (
                url.scheme != "https" ||
                url.host != VIDEO_HOST ||
                url.port != 443 ||
                url.username.isNotEmpty() ||
                url.password.isNotEmpty() ||
                !url.encodedPath.lowercase().endsWith(".mp4")
            ) {
                throw Rejection("Video media URL is not an allowed HTTPS MP4")
            }
            return url
        }
    }

    /**
     * Streams the body into [destination]. The whole call is bounded by [deadlineMs]; [onCall]
     * receives the active call before it starts so the owner can cancel a blocking read, and the
     * read loop also stops once [isCancelled] says so. The response and both streams close on
     * every path. A partial file is left for the caller to delete.
     */
    fun download(
        rawUrl: String,
        destination: File,
        deadlineMs: Long,
        isCancelled: () -> Boolean,
        onCall: (Call) -> Unit,
    ) {
        val request = Request.Builder().url(validateUrl(rawUrl)).get().build()
        val call = http.newCall(request)
        call.timeout().timeout(deadlineMs, TimeUnit.MILLISECONDS)
        onCall(call)
        call.execute().use { response ->
            if (response.isRedirect) throw Rejection("Video media download redirected")
            if (response.code != 200) throw Rejection("Video media download failed")

            val body = response.body
            if (body.contentLength() > MAX_VIDEO_BYTES) throw Rejection("Video media is too large")

            body.byteStream().use { input ->
                destination.outputStream().use { output ->
                    val buffer = ByteArray(BUFFER_BYTES)
                    var total = 0L
                    while (true) {
                        if (isCancelled()) throw VideoJobCancelled()
                        val read = input.read(buffer)
                        if (read == -1) break
                        total += read
                        if (total > MAX_VIDEO_BYTES) throw Rejection("Video media is too large")
                        output.write(buffer, 0, read)
                    }
                }
            }
        }
    }
}

/** Thrown by a video job that sees its cancel flag; the job's PluginCall was already settled by the canceller. */
internal class VideoJobCancelled : VideoMediaDownloader.Rejection("Video extraction was cancelled")
