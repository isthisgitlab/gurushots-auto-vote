package com.isthisgitlab.gurushotsautovote

import android.util.Base64
import androidx.annotation.VisibleForTesting
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

/**
 * Foreground-only bridge for Snap video bytes.
 *
 * Frame decoding remains in the foreground WebView. The headless service does
 * not register this plugin and therefore cannot download or decode video.
 */
@CapacitorPlugin(name = "VideoMedia")
class VideoMediaPlugin : Plugin() {

    companion object {
        @VisibleForTesting
        internal var downloaderFactory: () -> VideoMediaDownloader = {
            VideoMediaDownloader(VideoMediaDownloader.newClient())
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val downloader: VideoMediaDownloader by lazy { downloaderFactory() }

    @PluginMethod
    fun download(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrEmpty()) {
            call.reject("No video media URL provided")
            return
        }
        scope.launch {
            try {
                val bytes = downloader.download(url)
                val result = JSObject()
                result.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                withContext(Dispatchers.Main) { call.resolve(result) }
            } catch (error: VideoMediaDownloader.Rejection) {
                withContext(Dispatchers.Main) { call.reject("Video media download refused", error) }
            } catch (error: Exception) {
                withContext(Dispatchers.Main) { call.reject("Video media download failed", error) }
            }
        }
    }
}
