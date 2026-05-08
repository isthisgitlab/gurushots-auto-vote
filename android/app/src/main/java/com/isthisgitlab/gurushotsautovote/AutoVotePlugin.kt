package com.isthisgitlab.gurushotsautovote

import android.content.Intent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

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
