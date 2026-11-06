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
        private const val VIDEO_HOST = "media.gurushots.com"
        private const val BUFFER_BYTES = 64 * 1024

        @VisibleForTesting
        internal fun newClient(builder: OkHttpClient.Builder = OkHttpClient.Builder()): OkHttpClient =
            builder
                .cookieJar(CookieJar.NO_COOKIES)
                .followRedirects(false)
                .followSslRedirects(false)
                // Idle limit only: a body that keeps arriving is never cut off.
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
                url.password.isNotEmpty()
            ) {
                throw Rejection("Video media URL is not an allowed GuruShots media URL")
            }
            return url
        }
    }

    /**
     * Streams the body into [destination]. A stalled connection ends with OkHttp's idle read
     * timeout; a body that keeps arriving is never cut off. [onCall] receives the active call
     * before it starts so the owner can cancel a blocking read, and the read loop also stops
     * once [isCancelled] says so. The response and both streams close on every path. A partial
     * file is left for the caller to delete.
     */
    fun download(
        rawUrl: String,
        destination: File,
        isCancelled: () -> Boolean,
        onCall: (Call) -> Unit,
    ) {
        val request = Request.Builder().url(validateUrl(rawUrl)).get().build()
        val call = http.newCall(request)
        onCall(call)
        call.execute().use { response ->
            if (response.isRedirect) throw Rejection("Video media download redirected")
            if (response.code != 200) throw Rejection("Video media download failed")

            response.body.byteStream().use { input ->
                destination.outputStream().use { output ->
                    val buffer = ByteArray(BUFFER_BYTES)
                    while (true) {
                        if (isCancelled()) throw VideoJobCancelled()
                        val read = input.read(buffer)
                        if (read == -1) break
                        output.write(buffer, 0, read)
                    }
                }
            }
        }
    }
}

/** Thrown by a video job that sees its cancel flag; the job's PluginCall was already settled by the canceller. */
internal class VideoJobCancelled : VideoMediaDownloader.Rejection("Video extraction was cancelled")
