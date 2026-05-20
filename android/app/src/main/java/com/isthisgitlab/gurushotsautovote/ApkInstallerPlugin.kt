package com.isthisgitlab.gurushotsautovote

import android.content.Intent
import android.net.Uri
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
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Native APK updater. Downloads the release APK from GitHub to the app
 * cache dir (streaming progress to JS via the `downloadProgress` event),
 * then launches the system package installer through a FileProvider URI so
 * the user gets the standard install-confirmation prompt.
 *
 * The manifest already declares everything this needs:
 *  - REQUEST_INSTALL_PACKAGES permission
 *  - a FileProvider authority "<applicationId>.fileprovider" whose paths
 *    (res/xml/file_paths.xml) expose the cache dir
 *  - the Android 11+ package-archive ACTION_VIEW <queries> entry
 *
 * Mirrors the OkHttp + coroutine patterns already used by AutoVoteCycle /
 * AutoVoteService. JS callers reach this via window.api (download-update)
 * through the AndroidUpdateInstaller bridge.
 */
@CapacitorPlugin(name = "ApkInstaller")
class ApkInstallerPlugin : Plugin() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .build()
    }

    @PluginMethod
    fun downloadAndInstall(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrEmpty()) {
            call.reject("No download URL provided")
            return
        }

        scope.launch {
            try {
                val apk = downloadApk(url)
                withContext(Dispatchers.Main) {
                    launchInstaller(apk)
                    val ret = JSObject()
                    ret.put("success", true)
                    call.resolve(ret)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    call.reject(e.message ?: "APK download/install failed", e)
                }
            }
        }
    }

    /**
     * Streams the APK to cacheDir/update.apk, emitting `downloadProgress`
     * events ({ percent }) as it goes. Throws on any HTTP / IO failure so
     * the caller can reject and the JS bridge can fall back to the browser.
     */
    private fun downloadApk(url: String): File {
        val request = Request.Builder().url(url).build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IllegalStateException("Download failed: HTTP ${response.code}")
            }
            val body = response.body ?: throw IllegalStateException("Empty download body")
            val total = body.contentLength()

            val outFile = File(context.cacheDir, "update.apk")
            // Drop any stale download so a partial file can never be installed.
            if (outFile.exists()) {
                outFile.delete()
            }

            body.byteStream().use { input ->
                outFile.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var downloaded = 0L
                    var lastPercent = -1
                    while (true) {
                        val read = input.read(buffer)
                        if (read == -1) break
                        output.write(buffer, 0, read)
                        downloaded += read
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
            return outFile
        }
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
