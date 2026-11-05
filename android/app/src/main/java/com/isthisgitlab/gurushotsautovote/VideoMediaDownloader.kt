package com.isthisgitlab.gurushotsautovote

import androidx.annotation.VisibleForTesting
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit

/**
 * Downloads one Snap video after enforcing the CDN boundary in native code.
 *
 * The WebView passes only an URL. This class neither accepts nor forwards
 * headers, cookies, or credentials from JavaScript.
 */
internal class VideoMediaDownloader(private val http: OkHttpClient) {

    internal class Rejection(message: String) : Exception(message)

    companion object {
        internal const val MAX_VIDEO_BYTES = 32L * 1024 * 1024
        private const val VIDEO_HOST = "media.gurushots.com"

        @VisibleForTesting
        internal fun newClient(builder: OkHttpClient.Builder = OkHttpClient.Builder()): OkHttpClient =
            builder
                .cookieJar(CookieJar.NO_COOKIES)
                .followRedirects(false)
                .followSslRedirects(false)
                .callTimeout(30, TimeUnit.SECONDS)
                .build()

        @VisibleForTesting
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

    /** Returns bounded bytes. The response and its stream close on every path. */
    fun download(rawUrl: String): ByteArray {
        val request = Request.Builder().url(validateUrl(rawUrl)).get().build()
        http.newCall(request).execute().use { response ->
            if (response.isRedirect) throw Rejection("Video media download redirected")
            if (response.code != 200) throw Rejection("Video media download failed")

            val body = response.body
            val declaredLength = body.contentLength()
            if (declaredLength > MAX_VIDEO_BYTES) throw Rejection("Video media is too large")

            return body.byteStream().use { input ->
                ByteArrayOutputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val read = input.read(buffer)
                        if (read == -1) break
                        total += read
                        if (total > MAX_VIDEO_BYTES) throw Rejection("Video media is too large")
                        output.write(buffer, 0, read)
                    }
                    output.toByteArray()
                }
            }
        }
    }
}
