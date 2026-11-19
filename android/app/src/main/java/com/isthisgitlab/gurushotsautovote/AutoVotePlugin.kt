package com.isthisgitlab.gurushotsautovote

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File

/**
 * Capacitor plugin entry point for native background voting.
 *
 * Exposes start / stop / getStatus / wipeLocalData to JavaScript. The actual cycle
 * loop and HTTP work lives in AutoVoteService — this class is just the
 * thin bridge between window.api calls and the Service lifecycle.
 *
 * Why native: Android destroys the WebView when the user swipes the
 * app from recents, so the JS-side setInterval that drives voting
 * dies. The Service + AlarmManager schedule survives that and Doze
 * deep-sleep, so cycles fire on time even while the app is closed.
 */
@CapacitorPlugin(name = "AutoVoteBackground")
class AutoVotePlugin : Plugin() {

    @PluginMethod
    fun start(call: PluginCall) {
        val ctx = context
        val intent = Intent(ctx, AutoVoteService::class.java).apply {
            action = AutoVoteService.ACTION_START
        }
        ctx.startForegroundService(intent)
        val ret = JSObject()
        ret.put("running", true)
        call.resolve(ret)
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        val ctx = context
        val intent = Intent(ctx, AutoVoteService::class.java).apply {
            action = AutoVoteService.ACTION_STOP
        }
        ctx.startService(intent)
        val ret = JSObject()
        ret.put("running", false)
        call.resolve(ret)
    }

    /**
     * A full Stop, straight to the native side: it cancels the service's new work and its alarms first, then records the
     * Stop in the priority fence (`stopEpoch` one higher, `blocked`), by compare-and-set on the fence alone, and only then
     * ends the service. It never
     * reads or writes the control inbox or any other store, so nothing else can make it wait or refuse it. Repeating the
     * same `requestId` advances the epoch once.
     *
     * Resolves `stopped` (always true: the work was cancelled here) and `durable`: whether the fence holds the Stop. With
     * `durable` true it also resolves the `epoch` the fence is at; with false, the `reason` (`unreadable`, `oversize` or
     * `not-saved`), and the cancellation stands. Rejects a call without a valid `requestId` and a numeric `at`.
     */
    @PluginMethod
    fun stopAll(call: PluginCall) {
        val requestId = call.getString("requestId")
        // A JSON number reaches the plugin as an Int, a Long (a millisecond time) or a Double: read it as the number it is,
        // not through getDouble/getLong, which each take only some of them. JSON holds no NaN or infinity.
        val at = call.data.opt("at") as? Number
        if (requestId == null || !StopFence.isRequestId(requestId) || at == null) {
            call.reject("invalid stop")
            return
        }
        val ctx = context
        // New work is cancelled first (and the running cycle told to stop at its next boundary); the fence then holds the
        // Stop before the service is torn down, so nothing the service checks in between finds the fence still open.
        AutoVoteService.cancelWork(ctx)
        val recorded = StopFence.recordStop(ctx, requestId, at.toLong())
        AutoVoteService.endService(ctx)
        val ret = JSObject()
        ret.put("stopped", true)
        ret.put("durable", recorded.durable)
        if (recorded.durable) ret.put("epoch", recorded.epoch) else ret.put("reason", recorded.reason)
        call.resolve(ret)
    }

    /**
     * Saves one side store, or the settings blob, only if it still holds what the window read (`expected`; absent or
     * null: nothing was stored), under the lock the background service's bridge takes too. Resolves `saved` and, when
     * it did not save because the store had changed, `current`: what is stored. Rejects a key that is neither, a value
     * that is not one JSON object and a commit that failed ("not saved"), and a value past the key's size cap with the
     * code `too-large`, which a caller can tell from a change it could retry.
     */
    @PluginMethod
    fun compareAndWrite(call: PluginCall) {
        val key = call.getString("key")
        val value = call.getString("value")
        if (key == null || value == null || !SideStores.isAllowed(key)) {
            call.reject("not a side store")
            return
        }
        val result = SideStores.compareAndSet(context, key, call.getString("expected"), value)
        if (result.outcome == SideStores.Outcome.TOO_LARGE) {
            call.reject("too large", SideStores.TOO_LARGE)
            return
        }
        if (result.outcome == SideStores.Outcome.REFUSED) {
            call.reject("not saved")
            return
        }
        val ret = JSObject()
        ret.put("saved", result.outcome == SideStores.Outcome.SAVED)
        ret.put("current", result.current ?: JSONObject.NULL)
        call.resolve(ret)
    }

    /**
     * What the service last persisted (not the process's statics, which a restart loses): `running` is whether
     * automation is enabled, so it holds across the system stopping the foreground service between alarms.
     */
    @PluginMethod
    fun getStatus(call: PluginCall) {
        val status = ServiceState.status(context)
        val ret = JSObject()
        ret.put("running", status.running)
        ret.put("cycleCount", status.cycleCount)
        ret.put("lastRunAt", status.lastRunAt)
        ret.put("lastError", status.lastError ?: "")
        call.resolve(ret)
    }

    /**
     * Deletes everything the app holds on this device: stops the service and its alarm, forgets the service's state, the
     * whole `CapacitorStorage` file (settings with the token, every side store, whatever else JS saved), the WebView's
     * storage, cookies and HTTP cache (the photos it fetched), and the downloaded updates. Resolves `ok`: whether all of
     * it was removed.
     */
    @PluginMethod
    fun wipeLocalData(call: PluginCall) {
        val ctx = context
        // First, so that nothing the service still has queued writes its state back after the clear.
        AutoVoteService.isRunning = false
        ctx.stopService(Intent(ctx, AutoVoteService::class.java))
        AutoVoteService.cancelAlarm(ctx)
        val updates = File(ctx.cacheDir, "updates")
        // Every step runs, whether or not an earlier one failed.
        val stateGone = ServiceState.clear(ctx)
        // Under the lock every write takes, and holding the service's writes back: a cycle already running cannot put back
        // what this clears.
        val storageGone = SideStores.wipe(ctx)
        val updatesGone = !updates.exists() || updates.deleteRecursively()
        val filesGone = stateGone and storageGone and updatesGone
        // WebView storage is touched on the main thread, the one the WebView lives on.
        Handler(Looper.getMainLooper()).post {
            val webGone = try {
                WebStorage.getInstance().deleteAllData()
                // The HTTP cache is shared by every WebView of the app, so a throwaway one clears it for all.
                val cacheWiper = newWebView(ctx)
                // Also locked here, not only in the default factory: it holds when a test swaps the factory, and CodeQL
                // tracks each WebView source separately, so neither call is redundant.
                noContentAccess(cacheWiper)
                cacheWiper.clearCache(true)
                cacheWiper.destroy()
                CookieManager.getInstance().apply {
                    removeAllCookies(null)
                    flush()
                }
                true
            } catch (t: Throwable) {
                Log.w(AutoVoteService.TAG, "Could not clear the WebView storage (${t.javaClass.simpleName})")
                false
            }
            val ret = JSObject()
            ret.put("ok", filesGone and webGone)
            call.resolve(ret)
        }
    }

    internal companion object {
        /** How the wipe obtains the WebView that clears the HTTP cache; a test swaps it for one it can inspect. */
        @JvmField var newWebView: (Context) -> WebView = {
            val webView = WebView(it)
            noContentAccess(webView)
            webView
        }

        /** The throwaway WebView loads nothing, so it reads neither files nor content:// URIs. */
        private fun noContentAccess(webView: WebView) {
            webView.settings.allowFileAccess = false
            webView.settings.allowContentAccess = false
        }
    }
}
