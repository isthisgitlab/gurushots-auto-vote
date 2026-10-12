package com.isthisgitlab.gurushotsautovote

import android.content.Intent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

/**
 * Capacitor plugin entry point for native background voting.
 *
 * Exposes start / stop / getStatus to JavaScript. The actual cycle
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
     * Saves one side store only if it still holds what the window read (`expected`; absent or null: nothing was
     * stored), under the lock the background service's bridge takes too. Resolves `saved` and, when it did not save
     * because the store had changed, `current`: what is stored. Rejects a key that is not a side store, a value that
     * is not one JSON object within the size cap, and a commit that failed.
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
        if (result.outcome == SideStores.Outcome.REFUSED) {
            call.reject("not saved")
            return
        }
        val ret = JSObject()
        ret.put("saved", result.outcome == SideStores.Outcome.SAVED)
        ret.put("current", result.current ?: JSONObject.NULL)
        call.resolve(ret)
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        val ret = JSObject()
        ret.put("running", AutoVoteService.isRunning)
        ret.put("cycleCount", AutoVoteService.cycleCount)
        ret.put("lastRunAt", AutoVoteService.lastRunAtMillis)
        ret.put("lastError", AutoVoteService.lastError ?: "")
        call.resolve(ret)
    }
}
