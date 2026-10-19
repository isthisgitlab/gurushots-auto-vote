package com.isthisgitlab.gurushotsautovote

import android.content.Intent
import android.net.Uri
import androidx.annotation.VisibleForTesting
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Native APK updater. Downloads the release APK from GitHub to the app
 * cache dir (streaming progress to JS via the `downloadProgress` event),
 * then launches the system package installer through a FileProvider URI so
 * the user gets the standard install-confirmation prompt.
 *
 * What it installs is checked before the installer sees it:
 *  - the URL is a release download of this repository on github.com
 *  - redirects are followed here, by hand, at most [MAX_REDIRECTS] of them, each
 *    one https on GitHub's asset hosts (a redirect is where a request can be
 *    steered elsewhere)
 *  - the response is an APK / octet-stream within [maxApkBytes]
 *  - the bytes' SHA-256 equals the release asset's `digest`, which JS passes
 *    from the GitHub API
 * A refusal rejects the call with a typed code: `host`, `content-type`, `size`,
 * `digest` (mismatch) or `digest-missing` (none usable). The partial download
 * is deleted; a finished one stays, because the installer reads it through its
 * FileProvider URI after this call has resolved.
 *
 * The manifest already declares everything this needs:
 *  - REQUEST_INSTALL_PACKAGES permission
 *  - a FileProvider authority "<applicationId>.fileprovider" whose paths
 *    (res/xml/file_paths.xml) expose the cache dir
 *  - the Android 11+ package-archive ACTION_VIEW <queries> entry
 *
 * Mirrors the OkHttp patterns already used by AutoVoteService. JS callers reach this via window.api (download-update)
 * through the AndroidUpdateInstaller bridge.
 */
@CapacitorPlugin(name = "ApkInstaller")
class ApkInstallerPlugin : Plugin() {

    companion object {
        const val RELEASE_DOWNLOAD_PREFIX = "https://github.com/isthisgitlab/gurushots-auto-vote/releases/download/"
        private const val RELEASE_DOWNLOAD_PATH = "/isthisgitlab/gurushots-auto-vote/releases/download/"
        // GitHub answers a release download with a redirect to its asset storage.
        private val ASSET_HOSTS = setOf("release-assets.githubusercontent.com", "objects.githubusercontent.com")
        private const val MAX_REDIRECTS = 5
        private val APK_CONTENT_TYPES = setOf("application/vnd.android.package-archive", "application/octet-stream")
        private val DIGEST = Regex("sha256:([0-9a-fA-F]{64})")

        // Well above a release APK, which carries the local vision model; it stops a stream that never ends from filling
        // the cache.
        private const val DEFAULT_MAX_APK_BYTES = 300L * 1024 * 1024

        @VisibleForTesting
        internal var maxApkBytes = DEFAULT_MAX_APK_BYTES

        internal fun newClient(builder: OkHttpClient.Builder = OkHttpClient.Builder()): OkHttpClient =
            builder
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .callTimeout(15, TimeUnit.MINUTES)
                // Redirects are followed by hand, each vetted: never by OkHttp.
                .followRedirects(false)
                .followSslRedirects(false)
                .build()

        // Test seam: JVM unit tests swap in a client that reroutes the GitHub hosts to a local MockWebServer.
        @VisibleForTesting
        internal var httpClientFactory: () -> OkHttpClient = { newClient() }
    }

    /** A download the updater refuses; [code] is what the call rejects with. */
    private class Rejection(val code: String, val reason: String) : Exception(reason)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val http: OkHttpClient by lazy { httpClientFactory() }

    @PluginMethod
    fun downloadAndInstall(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrEmpty()) {
            call.reject("No download URL provided")
            return
        }
        val digest = call.getString("digest")

        scope.launch {
            try {
                val apk = downloadApk(url, digest)
                withContext(Dispatchers.Main) {
                    launchInstaller(apk)
                    val ret = JSObject()
                    ret.put("success", true)
                    call.resolve(ret)
                }
            } catch (e: Rejection) {
                withContext(Dispatchers.Main) {
                    call.reject(e.reason, e.code, e)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    call.reject(e.message ?: "APK download/install failed", e)
                }
            }
        }
    }

    /**
     * The first request must be a release download of this repository (its host is github.com by the URL prefix; the
     * parsed path must still be inside it, which dot segments could leave); every later hop an asset host.
     */
    private fun vetHop(url: HttpUrl, first: Boolean) {
        val onHost = if (first) {
            url.encodedPath.startsWith(RELEASE_DOWNLOAD_PATH)
        } else {
            url.host in ASSET_HOSTS
        }
        if (url.scheme != "https" || !onHost) throw Rejection("host", "The download is not on an allowed host")
    }

    /**
     * Streams the APK to cacheDir/updates/update.apk, emitting `downloadProgress`
     * events ({ percent }) as it goes. Throws on any HTTP / IO failure, and a
     * [Rejection] for a refused download, so the caller can reject.
     */
    private fun downloadApk(url: String, digest: String?): File {
        if (!url.startsWith(RELEASE_DOWNLOAD_PREFIX)) throw Rejection("host", "The download is not on an allowed host")
        // The prefix fixes scheme, host and the start of the path, so the rest cannot make this unparsable.
        var current = url.toHttpUrl()
        vetHop(current, first = true)
        val expected = DIGEST.matchEntire(digest.orEmpty().trim())?.groupValues?.get(1)
            ?: throw Rejection("digest-missing", "The release publishes no SHA-256 digest to check the download against")

        var redirects = 0
        while (true) {
            http.newCall(Request.Builder().url(current).build()).execute().use { response ->
                if (!response.isRedirect) return save(response, expected)
                if (++redirects > MAX_REDIRECTS) throw Rejection("host", "The download redirected too many times")
                val next = response.header("Location")?.let(current::resolve)
                    ?: throw Rejection("host", "The download redirected to an unusable address")
                vetHop(next, first = false)
                current = next
            }
        }
    }

    private fun save(response: Response, expectedSha256: String): File {
        if (!response.isSuccessful) {
            throw IllegalStateException("Download failed: HTTP ${response.code}")
        }
        // OkHttp 5's Response.body is non-null (an empty body, never null).
        val body = response.body
        val type = body.contentType()?.let { "${it.type}/${it.subtype}" }
        if (type !in APK_CONTENT_TYPES) throw Rejection("content-type", "The download is not an APK")
        val total = body.contentLength()
        if (total > maxApkBytes) throw Rejection("size", "The download is larger than an update may be")

        // An install upgraded from an older build still has its APK at the cache root.
        File(context.cacheDir, "update.apk").delete()
        val updatesDir = File(context.cacheDir, "updates").apply { mkdirs() }
        val outFile = File(updatesDir, "update.apk")
        // Drop any stale download so a partial file can never be installed.
        if (outFile.exists()) {
            outFile.delete()
        }

        val sha256 = MessageDigest.getInstance("SHA-256")
        try {
            body.byteStream().use { input ->
                outFile.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var downloaded = 0L
                    var lastPercent = -1
                    while (true) {
                        val read = input.read(buffer)
                        if (read == -1) break
                        downloaded += read
                        if (downloaded > maxApkBytes) throw Rejection("size", "The download is larger than an update may be")
                        output.write(buffer, 0, read)
                        sha256.update(buffer, 0, read)
                        if (total > 0) {
                            val percent = ((downloaded * 100) / total).toInt()
                            if (percent != lastPercent) {
                                lastPercent = percent
                                val data = JSObject()
                                data.put("percent", percent)
                                notifyListeners("downloadProgress", data)
                            }
                        }
                    }
                    output.flush()
                }
            }
            val actual = sha256.digest().joinToString("") { "%02x".format(it) }
            if (!actual.equals(expectedSha256, ignoreCase = true)) {
                throw Rejection("digest", "The download does not match the published SHA-256 digest")
            }
        } catch (e: Exception) {
            outFile.delete()
            throw e
        }
        return outFile
    }

    private fun launchInstaller(apk: File) {
        val authority = "${context.packageName}.fileprovider"
        val uri: Uri = FileProvider.getUriForFile(context, authority, apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }
}
