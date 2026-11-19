package com.isthisgitlab.gurushotsautovote

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.annotation.VisibleForTesting
import androidx.core.app.NotificationCompat
import androidx.webkit.WebViewAssetLoader
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayInputStream
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Foreground Service that owns background voting.
 *
 * The AlarmManager/Doze/wakelock/notification scaffolding is native
 * (it survives the app being swiped from recents and Doze deep-sleep),
 * while the per-cycle work runs the SHARED JS voting strategy in a
 * service-owned headless WebView rather than a Kotlin re-implementation —
 * so boost / turbo / auto-fill / last-minute reach full parity with the
 * desktop scheduler from one codebase.
 *
 * Per cycle: an alarm fires -> handleRunCycle() acquires a wakelock and
 * calls window.GS.runOneCycle() in the WebView. The JS reaches the
 * network through AndroidHeadlessHttp (async OkHttp) and settings through
 * AndroidHeadlessStore (the same SharedPreferences @capacitor/preferences
 * uses), then reports {ok, nextDelayMs} via AndroidHeadlessBridge so we
 * schedule the next alarm at the JS-computed cadence. A watchdog releases
 * the wakelock and reschedules if the JS never reports back.
 */
class AutoVoteService : Service() {

    companion object {
        const val TAG = "AutoVoteService"
        const val ACTION_START = "com.isthisgitlab.gurushotsautovote.START"
        const val ACTION_STOP = "com.isthisgitlab.gurushotsautovote.STOP"
        const val ACTION_RUN_CYCLE = "com.isthisgitlab.gurushotsautovote.RUN_CYCLE"
        // The Stop epoch an alarm (and the RUN_CYCLE it forwards) was scheduled under: a delivery checks it against the fence.
        const val EXTRA_STOP_EPOCH = "com.isthisgitlab.gurushotsautovote.STOP_EPOCH"
        // What an intent without the extra reads as: no epoch a fence can hold, so it never passes the fence.
        const val NO_EPOCH = -1L
        const val NOTIFICATION_ID = 27782
        const val CHANNEL_ID = "autovote-foreground"
        // Recorded as the last error when the service stopped itself for the system's sake and left an alarm to resume.
        const val ERROR_FGS_TIMEOUT = "fgs-timeout"
        const val ERROR_FGS_NOT_ALLOWED = "fgs-start-not-allowed"

        @Volatile var isRunning: Boolean = false
        @Volatile var cycleCount: Int = 0
        @Volatile var lastRunAtMillis: Long = 0L
        @Volatile var lastError: String? = null

        private const val DEFAULT_CYCLE_INTERVAL_MS = 3L * 60L * 1000L
        private const val INITIAL_DELAY_MS = 1_000L
        // Retry the page is loading delay — first alarm can land before the
        // WebView finishes loading the headless bundle.
        private const val PAGE_RETRY_MS = 3_000L
        // Watchdog: if JS never reports completion, recover after this long.
        private const val CYCLE_TIMEOUT_MS = 120_000L
        // Clamp JS-supplied cadence to a sane band (1s .. 6h).
        private const val MAX_DELAY_MS = 6L * 60L * 60L * 1000L
        // @capacitor/preferences store the JS settings module reads/writes (the side stores live in it too: SideStores).
        private const val PREFS_FILE = SideStores.PREFS_FILE
        private const val CONFIG_KEY = SideStores.CONFIG_KEY
        // The one origin the headless WebView may load from or talk to: the asset loader's.
        private const val ASSET_HOST = "appassets.androidplatform.net"
        private const val HEADLESS_URL = "https://$ASSET_HOST/assets/public/headless.html"
        // The vision verifier fetches entry photos from here (src/ts/core/services/visionVerifier.ts): the one other origin.
        private const val PHOTO_HOST = "photos.gurushots.com"
        // Latches the headless page's cancellation flag (GS.cancel): the cycle in it stops at its next work boundary.
        private const val CANCEL_JS = "(function(){try{if(window.GS&&window.GS.cancel){window.GS.cancel();}}catch(e){}})()"

        private fun isPhotoFetch(url: Uri, method: String): Boolean =
            url.scheme == "https" && url.host == PHOTO_HOST && (url.port == -1 || url.port == 443) && method == "GET"

        // [stopEpoch] stamps the alarm with the Stop epoch it was scheduled under; the extras are not part of the
        // PendingIntent's identity, so a cancel (no stamp) still reaches the alarm a stamped schedule made.
        private fun alarmIntent(context: Context, stopEpoch: Long?): PendingIntent {
            val intent = Intent(context, AutoVoteAlarmReceiver::class.java).apply {
                action = ACTION_RUN_CYCLE
                stopEpoch?.let { putExtra(EXTRA_STOP_EPOCH, it) }
            }
            // minSdk is 26, so FLAG_IMMUTABLE (API 23) is always available.
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            return PendingIntent.getBroadcast(context, 0, intent, flags)
        }

        internal fun cycleIntervalMs(context: Context): Long {
            val configured = AutoVoteSettings.read(context).normalIntervalSeconds
            return if (configured > 0) configured * 1000L else DEFAULT_CYCLE_INTERVAL_MS
        }

        /**
         * Schedules the next cycle's alarm, stamped with [stopEpoch], the Stop epoch the run holds. Nothing is scheduled
         * (false) while the fence is unreadable, blocked or past that epoch: a Stop ends the run, and no alarm may carry on
         * what it ended.
         */
        internal fun scheduleAlarm(context: Context, delayMs: Long, stopEpoch: Long): Boolean {
            if (!StopFence.allows(context, stopEpoch)) {
                Log.w(TAG, "Not scheduling the next alarm: the Stop fence does not allow this run to continue")
                return false
            }
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val triggerAt = System.currentTimeMillis() + delayMs.coerceAtLeast(1_000L)
            val pending = alarmIntent(context, stopEpoch)
            try {
                // setExactAndAllowWhileIdle is the only Android primitive that
                // pierces Doze for sub-15-min cadence. Android 12+ requires
                // SCHEDULE_EXACT_ALARM; without it, fall back to the inexact
                // (best-effort) variant which does not throw.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending)
                } else {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending)
                }
            } catch (sec: SecurityException) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending)
            }
            return true
        }

        internal fun cancelAlarm(context: Context) {
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            am.cancel(alarmIntent(context, null))
        }

        // Set by the live service instance: asks the headless page to latch its cancellation flag, so a cycle already
        // running stops at its next work boundary (an event, not a poll). Null when no service instance is alive.
        @Volatile internal var cancelCycle: (() -> Unit)? = null

        /**
         * Cancels new work at once, in this process and without reading or writing any store: the running cycle is told to
         * stop at its next boundary, the running flag the queued cycles check and the enabled flag an alarm checks are
         * cleared, and the pending alarm is cancelled. A full Stop does this first, before it records anything.
         */
        internal fun cancelWork(context: Context) {
            cancelCycle?.invoke()
            isRunning = false
            ServiceState.setEnabled(context, false)
            cancelAlarm(context)
        }

        /**
         * Ends the service (its WebView, wake lock and foreground notification). A full Stop does this after the fence holds
         * the Stop, so nothing the service checks in between finds the fence still open.
         */
        internal fun endService(context: Context) {
            context.startService(Intent(context, AutoVoteService::class.java).apply { action = ACTION_STOP })
        }

        // Test seam: JVM unit tests swap in a client whose interceptor reroutes
        // the (allow-listed) api.gurushots.com requests to a local MockWebServer.
        // Production never reassigns it.
        @VisibleForTesting
        internal var httpClientFactory: () -> OkHttpClient = {
            OkHttpClient.Builder()
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                // The API never redirects; following one would replay the x-token header at the target.
                .followRedirects(false)
                .followSslRedirects(false)
                .build()
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    // True for debuggable (debug) builds — used to keep JS console output out
    // of release logcat without depending on a generated BuildConfig.
    private val isDebuggable: Boolean by lazy {
        (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
    }
    private var webView: WebView? = null
    @Volatile private var pageReady = false
    private val cycleDone = AtomicBoolean(true)
    private var cycleWakeLock: PowerManager.WakeLock? = null
    // The Stop epoch the run in this instance holds (NO_EPOCH until a start or an alarm admitted one): the stamp of every
    // alarm it schedules, so that a Stop that moves the fence ends what this run would carry on.
    @Volatile private var runEpoch: Long = NO_EPOCH

    private val http: OkHttpClient by lazy { httpClientFactory() }

    private val cycleWatchdog = Runnable {
        Log.w(TAG, "Cycle watchdog fired — JS did not report completion in time")
        lastError = "cycle-timeout"
        completeCycle(-1L)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()
        cancelCycle = ::cancelInFlightCycle
    }

    private fun cancelInFlightCycle() {
        mainHandler.post { webView?.evaluateJavascript(CANCEL_JS, null) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> handleStart()
            ACTION_RUN_CYCLE -> handleRunCycle(intent.getLongExtra(EXTRA_STOP_EPOCH, NO_EPOCH))
            ACTION_STOP -> {
                handleStop()
                return START_NOT_STICKY
            }
            null -> handleRecreated()
        }
        return START_STICKY
    }

    /**
     * The system started this service again with no intent (it was killed while started). It has no work of its own to
     * resume: an alarm carries on a run. On a fence that blocks every run (a Stop, or data that cannot be read) it ends.
     */
    private fun handleRecreated() {
        if (StopFence.armEpoch(this) != null) return
        Log.w(TAG, "Service restarted while the Stop fence blocks work — stopping")
        stopSelf()
    }

    /**
     * Answers the start request that brought the service here (startForegroundService obliges it to enter the foreground),
     * then leaves: no work was built.
     */
    private fun endWithoutWork() {
        enterForeground(localized().getString(R.string.notification_starting))
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun handleStart() {
        if (isRunning) {
            Log.i(TAG, "handleStart called but service already running")
            return
        }
        // A wipe held the service's writes back; this start is the user's, after it. The WebView of the run the wipe
        // stopped may still be around, with a cycle in it, so it is released first: the hold is lifted only once
        // nothing of the old run can write: its WebView, and with it the watchdog and the wake lock of the cycle that was
        // in it, which would otherwise end the new run's first cycle early. A restart without a wipe reuses the WebView.
        if (SideStores.isWiping()) {
            mainHandler.removeCallbacks(cycleWatchdog)
            cycleWakeLock?.let { if (it.isHeld) it.release() }
            cycleWakeLock = null
            cycleDone.set(true)
            webView?.destroy()
            webView = null
            pageReady = false
            SideStores.resume()
        }
        // The user's Run: the app lifted any Stop block before it asked for this start, so a fence that still blocks (or
        // cannot be read) means no run may begin. The run holds the epoch it begins under.
        val epoch = StopFence.armEpoch(this)
        if (epoch == null) {
            Log.w(TAG, "START refused: the Stop fence blocks work")
            endWithoutWork()
            return
        }
        runEpoch = epoch
        isRunning = true
        cycleCount = 0
        lastError = null
        ServiceState.setEnabled(this, true)
        ServiceState.record(this, cycleCount, lastRunAtMillis, lastError)
        if (!enterForeground(localized().getString(R.string.notification_starting))) {
            suspendUntilNextAlarm(ERROR_FGS_NOT_ALLOWED)
            return
        }
        mainHandler.post { ensureWebView() }
        scheduleNextAlarm(INITIAL_DELAY_MS)
    }

    private fun handleRunCycle(stamp: Long) {
        if (!ServiceState.isEnabled(this)) {
            // A stale alarm: the one that fired after a STOP. The start request that brought it here still has to be
            // answered with startForeground before the service may stop, or the system kills the app for not doing so.
            Log.i(TAG, "RUN_CYCLE received but background voting is not enabled — stopping")
            endWithoutWork()
            return
        }
        if (!StopFence.allows(this, stamp)) {
            // An alarm of a run a Stop ended (it was delayed past it, or the service was built again on a fence that
            // blocks): no work is built and nothing is scheduled.
            Log.w(TAG, "RUN_CYCLE refused: its Stop epoch is not the live one")
            endWithoutWork()
            return
        }
        runEpoch = stamp
        if (!isRunning) {
            // A new process (or instance): what the last one knew is in the persisted state.
            val saved = ServiceState.status(this)
            isRunning = true
            cycleCount = saved.cycleCount
            lastRunAtMillis = saved.lastRunAt
            lastError = saved.lastError
        }
        val text = if (lastRunAtMillis > 0L) formatStatus() else localized().getString(R.string.notification_starting)
        if (!enterForeground(text)) {
            suspendUntilNextAlarm(ERROR_FGS_NOT_ALLOWED)
            return
        }
        mainHandler.post {
            // A STOP may have been processed after this lambda was queued —
            // don't start a cycle (or acquire a wakelock) against a service
            // that's shutting down.
            if (!isRunning) return@post
            ensureWebView()
            if (!pageReady) {
                Log.i(TAG, "Headless page not ready yet — retrying shortly")
                scheduleNextAlarm(PAGE_RETRY_MS)
                return@post
            }
            cycleDone.set(false)
            cycleWakeLock = acquireWakelock()
            mainHandler.postDelayed(cycleWatchdog, CYCLE_TIMEOUT_MS)
            Log.i(TAG, "Cycle ${cycleCount + 1} starting (JS)")
            // ensureWebView() above set it on this (main) thread, and it is only
            // cleared on the main thread too (releaseResources' posted block,
            // handleStart after a wipe, onDestroy), so it can't be null here.
            webView!!.evaluateJavascript(
                "(function(){try{" +
                    "if(window.GS&&window.GS.runOneCycle){window.GS.runOneCycle();}" +
                    "else{AndroidHeadlessBridge.onCycleComplete(JSON.stringify({ok:false,error:'not-loaded'}));}" +
                    "}catch(e){AndroidHeadlessBridge.onCycleComplete(JSON.stringify({ok:false,error:'cycle-failed'}));}})()",
                null,
            )
        }
    }

    /** Single-shot cycle completion: cancel the watchdog, release the wakelock, schedule the next alarm. */
    private fun completeCycle(nextDelayMs: Long) {
        mainHandler.post {
            if (!cycleDone.compareAndSet(false, true)) return@post
            mainHandler.removeCallbacks(cycleWatchdog)
            cycleWakeLock?.let { if (it.isHeld) it.release() }
            cycleWakeLock = null
            cycleCount += 1
            lastRunAtMillis = System.currentTimeMillis()
            if (isRunning) {
                ServiceState.record(this, cycleCount, lastRunAtMillis, lastError)
                updateNotification(formatStatus())
                val delay = if (nextDelayMs in 1_000L..MAX_DELAY_MS) nextDelayMs else cycleIntervalMs()
                Log.i(TAG, "Cycle $cycleCount done; next in ${delay}ms")
                scheduleNextAlarm(delay)
            }
        }
    }

    private fun handleStop() {
        isRunning = false
        ServiceState.setEnabled(this, false)
        mainHandler.removeCallbacks(cycleWatchdog)
        cancelPendingAlarm()
        releaseResources()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /**
     * The system's limit on the foreground service was reached. The service stops cleanly and leaves the next alarm, so
     * that automation resumes (the enabled flag stays set) rather than ending here.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(TAG, "Foreground service timed out (type $fgsType) — stopping until the next alarm")
        suspendUntilNextAlarm(ERROR_FGS_TIMEOUT)
    }

    /** Stops this instance for [error] without disabling automation: records it, and an alarm resumes it. */
    private fun suspendUntilNextAlarm(error: String) {
        lastError = error
        ServiceState.record(this, cycleCount, lastRunAtMillis, error)
        isRunning = false
        mainHandler.removeCallbacks(cycleWatchdog)
        releaseResources()
        scheduleNextAlarm(cycleIntervalMs())
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // Touch cycleWakeLock + webView only on the main thread — completeCycle
    // also runs there, so the two can't race on these non-volatile fields.
    private fun releaseResources() {
        mainHandler.post {
            cycleWakeLock?.let { if (it.isHeld) it.release() }
            cycleWakeLock = null
            webView?.destroy()
            webView = null
            pageReady = false
        }
    }

    override fun onDestroy() {
        cancelCycle = null
        isRunning = false
        mainHandler.removeCallbacks(cycleWatchdog)
        // onDestroy runs on the main thread (like completeCycle and releaseResources' posted
        // block), so these fields can be touched directly — no race, and
        // no need to defer the WebView teardown to a later message.
        cycleWakeLock?.let { if (it.isHeld) it.release() }
        cycleWakeLock = null
        webView?.destroy()
        webView = null
        super.onDestroy()
    }

    // ---------- Headless WebView ----------

    /** Creates the service's headless WebView and starts loading it, unless it already exists. */
    private fun ensureWebView() {
        if (webView != null) return
        Log.i(TAG, "Creating headless WebView")
        val wv = WebView(this)
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.settings.allowFileAccess = false
        // The page is served from the asset-loader origin; it never reads content:// URIs.
        wv.settings.allowContentAccess = false
        // Local HTTPS origin lets the headless JS fetch packaged model and
        // lexicon assets without granting file:// cross-origin access.
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        wv.addJavascriptInterface(HeadlessHttp(), "AndroidHeadlessHttp")
        wv.addJavascriptInterface(HeadlessStore(), "AndroidHeadlessStore")
        wv.addJavascriptInterface(HeadlessBridge(), "AndroidHeadlessBridge")
        wv.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(cm: ConsoleMessage): Boolean {
                // Debug builds only — keeps JS console output out of release logcat.
                if (isDebuggable) {
                    Log.i("$TAG/JS", "${cm.message()} (${cm.sourceId()}:${cm.lineNumber()})")
                }
                return true
            }
        }
        wv.webViewClient = object : WebViewClient() {
            // The headless page never navigates: anything off the asset origin stays unloaded.
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url
                return !(url?.scheme == "https" && url.host == ASSET_HOST)
            }

            // Nothing leaves the asset loader (sub-frames included), except the photo fetches of the vision verifier:
            // a request it does not serve (it answers a missing asset with an empty response) is refused, not sent on
            // to the network.
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                val url = request?.url ?: return forbiddenResponse()
                // null: the WebView fetches it itself.
                if (isPhotoFetch(url, request.method)) return null
                return assetLoader.shouldInterceptRequest(url)?.takeIf { it.data != null } ?: forbiddenResponse()
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                // Only the headless document marks readiness — guards against a
                // subframe load firing this on older WebView versions.
                if (url == HEADLESS_URL) {
                    pageReady = true
                    Log.i(TAG, "Headless page loaded: $url")
                }
            }

            override fun onReceivedError(
                view: WebView?,
                request: android.webkit.WebResourceRequest?,
                error: android.webkit.WebResourceError?,
            ) {
                // Main-frame load failure — don't run cycles against a broken page.
                if (request?.isForMainFrame == true) {
                    pageReady = false
                    Log.w(TAG, "Headless page load error: ${error?.description}")
                }
            }
        }
        pageReady = false
        wv.loadUrl(HEADLESS_URL)
        webView = wv
    }

    /** OkHttp-backed HTTP bridge. Async so the WebView's JS thread never blocks on network. */
    inner class HeadlessHttp {
        @android.webkit.JavascriptInterface
        fun request(id: Int, method: String, url: String, headersJson: String, body: String) {
            val req = try {
                buildRequest(method, url, headersJson, body)
            } catch (e: RejectedRequest) {
                resolveHttp(id, JSONObject().put("error", e.reason))
                return
            } catch (t: Throwable) {
                // Only the exception type crosses into the WebView, never its message text.
                resolveHttp(id, JSONObject().put("error", "bad-request (${t.javaClass.simpleName})"))
                return
            }
            http.newCall(req).enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) = resolveNetworkError(id, e)

                override fun onResponse(call: Call, response: Response) {
                    // A body that fails mid-read must still resolve this id;
                    // otherwise JS only recovers via its own request timeout.
                    try {
                        response.use { resp ->
                            if (resp.code in 300..399) {
                                Log.w(TAG, "API request answered ${resp.code}, redirect not followed (Location: ${resp.header("Location")})")
                            }
                            val bodyStr = resp.body.string()
                            val headersObj = JSONObject()
                            for (name in resp.headers.names()) headersObj.put(name.lowercase(Locale.US), resp.header(name))
                            resolveHttp(
                                id,
                                JSONObject().put("status", resp.code).put("body", bodyStr).put("headers", headersObj),
                            )
                        }
                    } catch (e: IOException) {
                        resolveNetworkError(id, e)
                    }
                }
            })
        }
    }

    /** A request the bridge refuses by policy; [reason] is authored here and safe to hand back to JS. */
    private class RejectedRequest(val reason: String) : IllegalArgumentException(reason)

    private fun buildRequest(method: String, url: String, headersJson: String, body: String): Request {
        val parsed = url.toHttpUrlOrNull() ?: throw RejectedRequest("invalid url")
        // Defense in depth: the only caller is first-party JS targeting
        // api.gurushots.com over https. Reject anything else so a future bug
        // that fed an attacker-controlled URL here can't become an SSRF.
        // Dot-anchored so "evilgurushots.com" doesn't slip past a bare suffix.
        val host = parsed.host
        val hostAllowed = host == "gurushots.com" || host.endsWith(".gurushots.com")
        if (parsed.scheme != "https" || !hostAllowed) {
            throw RejectedRequest("blocked url host/scheme: $host")
        }
        val m = method.uppercase(Locale.US)
        // OkHttp rejects a body on GET/HEAD; the API is POST-only but the
        // bridge is generic, so guard it.
        val reqBody = if (m == "GET" || m == "HEAD") {
            null
        } else {
            body.toRequestBody("application/x-www-form-urlencoded; charset=utf-8".toMediaType())
        }
        val builder = Request.Builder().url(parsed).method(m, reqBody)
        val headers = JSONObject(headersJson)
        val keys = headers.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            builder.header(key, headers.optString(key, ""))
        }
        return builder.build()
    }

    // Like request()'s build failures: the exception type only, never its message text.
    private fun resolveNetworkError(id: Int, e: IOException) =
        resolveHttp(id, JSONObject().put("error", "network-error (${e.javaClass.simpleName})"))

    private fun resolveHttp(id: Int, payload: JSONObject) {
        val js = "window.__gsResolveHeadlessHttp && window.__gsResolveHeadlessHttp($id, ${JSONObject.quote(payload.toString())});"
        mainHandler.post { webView?.evaluateJavascript(js, null) }
    }

    /** Settings bridge — same store @capacitor/preferences uses, so token/settings stay in sync. */
    inner class HeadlessStore {
        // What this context's JS last read of the settings blob: the text its next write is a change of.
        @Volatile
        private var lastRead: String? = null

        @android.webkit.JavascriptInterface
        fun read(): String? =
            getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE).getString(CONFIG_KEY, null).also { lastRead = it }

        @android.webkit.JavascriptInterface
        fun readKey(key: String): String? = SideStores.read(this@AutoVoteService, key)

        /**
         * Persists one side store. Answers whether it did: false for a key that is not allowed, a value that is not
         * one JSON object (or is too large), or a commit that failed — JS treats the write-ahead of a scenario spend
         * as not made then. The commit is synchronous, so a true answer means the value is on disk, not queued.
         */
        @android.webkit.JavascriptInterface
        fun writeKey(key: String, data: String): Boolean = SideStores.write(this@AutoVoteService, key, data)

        /**
         * Persists one side store only if it still holds what the caller read (`expected`; empty: nothing was
         * there), under the lock the app window's plugin takes too: the one way two contexts change one store
         * without overwriting each other. True only when it was saved.
         */
        @android.webkit.JavascriptInterface
        fun compareAndWriteKey(key: String, expected: String?, data: String): Boolean =
            SideStores.compareAndSet(this@AutoVoteService, key, expected, data, fromService = true).outcome ==
                SideStores.Outcome.SAVED

        @Volatile private var writeRefusal = ""

        /**
         * Persists the settings blob only if it still holds what [read] last answered, under the lock the app window's
         * plugin takes too: a blob the window changed since is not overwritten, and JS reads it again and makes its
         * change on it. Answers whether it saved: false for that, for anything that is not one JSON object within
         * [SideStores.MAX_SETTINGS_BYTES], or for a commit that failed — a JS bug must not corrupt the blob the main
         * app reads (the token included). The commit is synchronous. [lastWriteRefusal] then says why.
         */
        @android.webkit.JavascriptInterface
        fun write(data: String): Boolean {
            val result = SideStores.compareAndSet(this@AutoVoteService, CONFIG_KEY, lastRead, data, fromService = true)
            val saved = result.outcome == SideStores.Outcome.SAVED
            if (saved) lastRead = data
            writeRefusal = when (result.outcome) {
                SideStores.Outcome.SAVED -> ""
                SideStores.Outcome.TOO_LARGE -> SideStores.TOO_LARGE
                SideStores.Outcome.MISMATCH -> "conflict"
                SideStores.Outcome.REFUSED -> "refused"
            }
            return saved
        }

        /** Why the last [write] saved nothing: `too-large`, `conflict` (the blob changed since [read]) or `refused`; empty if it saved. */
        @android.webkit.JavascriptInterface
        fun lastWriteRefusal(): String = writeRefusal
    }

    /** Cycle-completion bridge — JS reports {ok, nextDelayMs, error} when a cycle finishes. */
    inner class HeadlessBridge {
        @android.webkit.JavascriptInterface
        fun onCycleComplete(json: String) {
            var delay = -1L
            try {
                val o = JSONObject(json)
                delay = o.optLong("nextDelayMs", -1L)
                lastError = if (o.has("error") && o.optString("error", "").isNotEmpty()) o.optString("error") else null
            } catch (t: Throwable) {
                // Never the exception or its message: a JSONException's message quotes the payload.
                Log.w(TAG, "Bad onCycleComplete payload (${t.javaClass.simpleName})")
            }
            // lastError is JS-supplied, possibly API-derived text: log only its
            // presence. The headless JS already logs the detail through the
            // debug-only console path.
            Log.i(TAG, "Cycle reported complete: nextDelayMs=$delay${if (lastError != null) " (error)" else ""}")
            completeCycle(delay)
        }
    }

    // ---------- AlarmManager ----------

    private fun cycleIntervalMs(): Long = cycleIntervalMs(this)

    // A run the fence no longer allows is over: no alarm is left to resume it, so the service ends it.
    private fun scheduleNextAlarm(delayMs: Long) {
        if (!scheduleAlarm(this, delayMs, runEpoch)) handleStop()
    }

    private fun cancelPendingAlarm() = cancelAlarm(this)

    // ---------- Notification ----------

    /** This service's context in the app's own language (the `language` setting), not the device's. */
    private fun localized(): Context {
        val config = Configuration(resources.configuration)
        config.setLocale(Locale.forLanguageTag(AutoVoteSettings.read(this).language))
        return createConfigurationContext(config)
    }

    private fun ensureNotificationChannel() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            val text = localized()
            val channel = NotificationChannel(
                CHANNEL_ID,
                text.getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = text.getString(R.string.notification_channel_description)
                setShowBadge(false)
            }
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String): Notification {
        val openAppIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val openAppPi = openAppIntent?.let {
            PendingIntent.getActivity(this, 1, it, pendingFlags)
        }

        val stopIntent = Intent(this, AutoVoteService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPi = PendingIntent.getService(this, 2, stopIntent, pendingFlags)

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_rotate)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(openAppPi)
            .addAction(
                android.R.drawable.ic_delete,
                localized().getString(R.string.notification_stop),
                stopPi,
            )
            .build()
    }

    /**
     * Enters the foreground with [text]; false when the system refuses (on Android 12+ that is
     * ForegroundServiceStartNotAllowedException, an IllegalStateException; the caller then stops until the next alarm).
     */
    private fun enterForeground(text: String): Boolean {
        val notification = buildNotification(text)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: IllegalStateException) {
            Log.w(TAG, "The system refused to start the foreground service (${e.javaClass.simpleName})")
            return false
        }
        return true
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun formatStatus(): String {
        val text = localized()
        val time = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        val err = lastError ?: return text.getString(R.string.notification_last_cycle, time, cycleCount)
        // The runner reports stable codes only; a code this build does not know gets the generic text, never the raw one.
        val friendly = text.getString(
            when (err) {
                "no-token" -> R.string.notification_error_no_token
                "cycle-timeout" -> R.string.notification_error_cycle_timeout
                "voting-failed" -> R.string.notification_error_voting_failed
                "cycle-failed" -> R.string.notification_error_cycle_failed
                "not-loaded" -> R.string.notification_error_not_loaded
                ERROR_FGS_TIMEOUT -> R.string.notification_error_fgs_timeout
                ERROR_FGS_NOT_ALLOWED -> R.string.notification_error_fgs_not_allowed
                else -> R.string.notification_error_generic
            },
        )
        return text.getString(R.string.notification_last_error, time, friendly)
    }

    private fun acquireWakelock(): PowerManager.WakeLock? {
        return try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            val wl = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "GuruShotsAutoVote::CycleWakelock",
            )
            wl.setReferenceCounted(false)
            wl.acquire(CYCLE_TIMEOUT_MS) // upper bound; released as soon as the cycle reports back
            wl
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to acquire wakelock", t)
            null
        }
    }
}

private fun forbiddenResponse() =
    WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))

/**
 * The side stores that hold state across contexts: the background service (through its bridge) and the app window
 * (through the AutoVoteBackground plugin) write the same keys of the one `CapacitorStorage` SharedPreferences, in one
 * process. Every change of one goes through here, under one lock; a change that rests on what its writer read
 * (`compareAndSet`) is saved only if that is still what is stored.
 *
 * The name each key is logged under is a literal of the map, never the JS-supplied key (a newline in it would render
 * as a forged second log line: CodeQL java/log-injection).
 */
internal object SideStores {
    const val PREFS_FILE = "CapacitorStorage"

    /** The most a store may hold: they are small ledgers, and a value past this is a bug or an attack. */
    const val MAX_BYTES = 256 * 1024

    /** The configuration (what `@capacitor/preferences` stores for the JS settings module: `config.json` on a desktop). */
    const val CONFIG_KEY = "gurushots-config"

    /** The settings blob the one-time import reads (`settings.json` on a desktop). */
    const val LEGACY_SETTINGS_KEY = "gurushots-settings"

    /** The most the configuration and the settings.json blobs may hold: every challenge's overrides and profiles live in them, so they dwarf a side store. */
    const val MAX_SETTINGS_BYTES = 2 * 1024 * 1024

    /** The most the priority Stop fence may hold: one small cell, independent of every other store's capacity. */
    const val MAX_FENCE_BYTES = 1024

    /**
     * The most the scenario control inbox may hold: twice the scenario import size (SCENARIO_CAPS.importBytes, 256 KiB),
     * so one maximum-sized document and its bounded request metadata fit. Only this key; the side-store cap is unchanged.
     */
    const val MAX_CONTROLS_BYTES = 2 * 256 * 1024

    // Lexicon diagnostics; the scenario state and the resets of it the app asks for; the fills spent (what
    // autoExposureFillMax counts against: a service that started from an empty one after every restart would spend
    // past the cap) and the swap-back offers; the paid-join claims (an unlock that was charged and not yet submitted:
    // forgotten on a restart, it would be charged again); the marker that the settings import has run (the service reads
    // it to know not to import again) and the title pins (the import seeds them, and both contexts pin titles); the
    // entry-age ledger (when each entry went into a challenge: the window records the photos it submits, the service the
    // ones it submits and what it first sees, and the boost hold and the fill-new `pending` photo must outlast a cycle);
    // the priority Stop fence (the epoch and block of full Stops, which the alarm receiver and the service read before
    // they build work) and the ordinary control inbox (the requests the app queues for the service and what became of each).
    private val names = mapOf(
        CONFIG_KEY to "config",
        LEGACY_SETTINGS_KEY to "settings",
        "gs_v2_import" to "import marker",
        "gs_title_pins" to "title pins",
        "gs_lexicon_diagnostics" to "lexicon diagnostics",
        "gs_scenario_state" to "scenario state",
        "gs_scenario_resets" to "scenario resets",
        "gs_auto_spends" to "auto-spend ledger",
        "gs_swap_backs" to "swap-back ledger",
        "gs_join_state" to "join-state",
        "gs_entry_ages" to "entry-age ledger",
        StopFence.KEY to "stop fence",
        CONTROLS_KEY to "control inbox"
    )

    /** The scenario control inbox (`scenarioControls.json` on a desktop). */
    const val CONTROLS_KEY = "gs_scenario_controls"

    /** The `code` a plugin call rejects with, and the reason [HeadlessStore.lastWriteRefusal] answers, for a value past its cap. */
    const val TOO_LARGE = "too-large"

    enum class Outcome { SAVED, MISMATCH, REFUSED, TOO_LARGE }

    /** `current`: what is stored when nothing was saved. */
    data class Result(val outcome: Outcome, val current: String?)

    fun isAllowed(key: String): Boolean = key in names

    // The configuration and the settings.json blob hold every challenge's overrides and profiles: the settings cap.
    private val settingsKeys = setOf(CONFIG_KEY, LEGACY_SETTINGS_KEY)

    private fun maxBytes(key: String): Int = when (key) {
        in settingsKeys -> MAX_SETTINGS_BYTES
        StopFence.KEY -> MAX_FENCE_BYTES
        CONTROLS_KEY -> MAX_CONTROLS_BYTES
        else -> MAX_BYTES
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)

    /** Whether [data] is past [maxBytes]; a refusal is logged under the store's literal name. */
    private fun tooLarge(name: String, data: String, maxBytes: Int): Boolean {
        val large = data.toByteArray(Charsets.UTF_8).size > maxBytes
        if (large) Log.w(AutoVoteService.TAG, "Refusing to persist oversized $name blob")
        return large
    }

    /** Whether [data] is one JSON object and nothing after it; a refusal is logged under the store's literal name. */
    private fun isJsonObject(name: String, data: String): Boolean {
        val tokener = JSONTokener(data)
        val ok = try {
            tokener.nextValue() is JSONObject && tokener.nextClean() == '\u0000'
        } catch (e: JSONException) {
            false
        }
        if (!ok) Log.w(AutoVoteService.TAG, "Refusing to persist non-JSON $name blob")
        return ok
    }

    fun read(context: Context, key: String): String? = if (isAllowed(key)) prefs(context).getString(key, null) else null

    // Saves `data` under `key`, synchronously. SharedPreferences applies a commit to its in-memory map before it writes the
    // disk, so one that failed has still made the value readable: it is put back (and that committed), so that nothing
    // reads, or builds on, what was not saved.
    private fun commit(prefs: SharedPreferences, key: String, previous: String?, data: String): Boolean {
        if (prefs.edit().putString(key, data).commit()) return true
        val undo = prefs.edit()
        if (previous == null) undo.remove(key) else undo.putString(key, previous)
        undo.commit()
        return false
    }

    // Stores that are changed only by `compareAndSet`: a plain write would replace what another context saved (a spend
    // or a claim that one context recorded and the other, writing from an older read, then lost; a setting one context
    // toggled and the other, writing the whole blob from an older read, then undid; a title pin or the marker that one
    // context saved and the other, writing from the cache it hydrated at start, then dropped).
    private val compareAndSetOnly =
        setOf(
            "gs_join_state",
            "gs_auto_spends",
            "gs_entry_ages",
            "gs_v2_import",
            "gs_title_pins",
            StopFence.KEY,
            CONTROLS_KEY,
            CONFIG_KEY,
            LEGACY_SETTINGS_KEY
        )

    // Set by [wipe], cleared by [resume] (the service's next start): while set, the background service's bridge cannot
    // write, so a cycle already inside the headless WebView cannot bring back what the wipe deleted (a side store, or
    // the configuration through a compare-and-set against the now-empty value). The app window's own writes (the
    // plugin's) are not held back: they are the user's, and the app is used again right after a wipe.
    @Volatile
    private var wiping = false

    /** Deletes everything in the file and holds the service's writes back until [resume]; one lock with every write. */
    @Synchronized
    fun wipe(context: Context): Boolean {
        wiping = true
        return prefs(context).edit().clear().commit()
    }

    /** Whether a wipe is holding the service's writes back. */
    fun isWiping(): Boolean = wiping

    /** Lets the service write again (it is starting). */
    fun resume() {
        wiping = false
    }

    private fun refusedByWipe(name: String): Boolean {
        val refused = wiping
        if (refused) Log.w(AutoVoteService.TAG, "Refusing to persist $name blob: local data was just deleted")
        return refused
    }

    @Synchronized
    fun write(context: Context, key: String, data: String): Boolean {
        val name = names[key] ?: return false
        if (refusedByWipe(name)) return false
        if (key in compareAndSetOnly) {
            Log.w(AutoVoteService.TAG, "Refusing a plain write of $name blob: it is changed by compare-and-set only")
            return false
        }
        if (tooLarge(name, data, maxBytes(key)) || !isJsonObject(name, data)) return false
        val prefs = prefs(context)
        return commit(prefs, key, prefs.getString(key, null), data)
    }

    /**
     * @param expected what the caller read; null or empty: nothing was stored
     * @param fromService the background service's bridge is writing, which a wipe holds back until its next start
     */
    @Synchronized
    fun compareAndSet(
        context: Context,
        key: String,
        expected: String?,
        data: String,
        fromService: Boolean = false
    ): Result {
        val name = names[key] ?: return Result(Outcome.REFUSED, null)
        if (fromService && refusedByWipe(name)) return Result(Outcome.REFUSED, null)
        if (tooLarge(name, data, maxBytes(key))) return Result(Outcome.TOO_LARGE, null)
        if (!isJsonObject(name, data)) return Result(Outcome.REFUSED, null)
        // The fence is read natively before work is built: a value of another shape is never stored over it.
        if (key == StopFence.KEY && StopFence.parse(data) == null) {
            Log.w(AutoVoteService.TAG, "Refusing to persist malformed $name blob")
            return Result(Outcome.REFUSED, null)
        }
        val prefs = prefs(context)
        val current = prefs.getString(key, null)
        if (current != expected?.takeIf { it.isNotEmpty() }) return Result(Outcome.MISMATCH, current)
        return if (commit(prefs, key, current, data)) Result(Outcome.SAVED, null) else Result(Outcome.REFUSED, current)
    }
}

/**
 * The priority Stop fence (`scenarioStopFence.json` / `gs_scenario_stop_fence`): `{ stopEpoch, blocked, lastStop, lastArm }`,
 * exactly that shape, at most [SideStores.MAX_FENCE_BYTES]. The app window and the TypeScript scheduler keep it through
 * compare-and-set (SideStores); this object is the native side: it reads the fence before an alarm or the service builds work,
 * and records a full Stop in it. It reads and writes no other store, so nothing else (the control inbox included) can refuse
 * a Stop.
 *
 * A fence that was never created is epoch 0, not blocked (an install that never used scenarios has none). Data that cannot
 * be read as exactly this shape is never epoch 0: nothing runs on it.
 */
internal object StopFence {
    const val KEY = "gs_scenario_stop_fence"
    private const val MAX_COUNT = 9_007_199_254_740_991L
    private const val MAX_ATTEMPTS = 5
    private val REQUEST_ID = Regex("^[A-Za-z0-9@:._-]{1,64}$")

    /** What the stored fence is: never created, readable ([Present]), or data that is not exactly the shape. */
    sealed interface State

    object Missing : State

    object Unreadable : State

    /** A fence that reads: [lastStop] and [lastArm] are kept as stored, so a Stop writes back what it does not change. */
    class Present(val epoch: Long, val blocked: Boolean, val lastStop: JSONObject?, val lastArm: JSONObject?) : State

    /** What [recordStop] came to: saved in the fence ([durable], with the [epoch] it holds), or why it was not. */
    class Recorded(val durable: Boolean, val epoch: Long, val reason: String?)

    fun isRequestId(value: String): Boolean = REQUEST_ID.matches(value)

    private fun count(value: Any?): Long? =
        when (value) {
            is Int -> value.toLong()
            is Long -> value
            else -> null
        }?.takeIf { it in 0..MAX_COUNT }

    // JSON has no NaN or infinity, and the tokener reads a literal past the double range as a string: a Number is finite.
    private fun finite(value: Any?): Boolean = value is Number

    private fun hasOnly(obj: JSONObject, keys: List<String>): Boolean = obj.length() == keys.size && keys.all { obj.has(it) }

    private fun validStop(obj: JSONObject): Boolean =
        hasOnly(obj, listOf("requestId", "at", "durable")) &&
            obj.get("requestId") is String && finite(obj.get("at")) && obj.get("durable") is Boolean

    private fun validArm(obj: JSONObject): Boolean =
        hasOnly(obj, listOf("epoch", "at")) && count(obj.get("epoch")) != null && finite(obj.get("at"))

    /** Whether the member [key] is JSON null or an object that [valid] accepts. */
    private fun nullOrValid(obj: JSONObject, key: String, valid: (JSONObject) -> Boolean): Boolean {
        val value = obj.get(key)
        return value == JSONObject.NULL || (value is JSONObject && valid(value))
    }

    /** The fence a text holds: exactly the shape and within [SideStores.MAX_FENCE_BYTES], or null. */
    fun parse(raw: String): Present? {
        if (raw.toByteArray(Charsets.UTF_8).size > SideStores.MAX_FENCE_BYTES) return null
        val tokener = JSONTokener(raw)
        val obj = try {
            (tokener.nextValue() as? JSONObject)?.takeIf { tokener.nextClean() == '\u0000' }
        } catch (e: JSONException) {
            null
        } ?: return null
        if (!hasOnly(obj, listOf("stopEpoch", "blocked", "lastStop", "lastArm"))) return null
        val epoch = count(obj.get("stopEpoch")) ?: return null
        val blocked = obj.get("blocked") as? Boolean ?: return null
        if (!nullOrValid(obj, "lastStop", ::validStop) || !nullOrValid(obj, "lastArm", ::validArm)) return null
        return Present(epoch, blocked, obj.get("lastStop") as? JSONObject, obj.get("lastArm") as? JSONObject)
    }

    private fun read(context: Context): State {
        val raw = SideStores.read(context, KEY) ?: return Missing
        return parse(raw) ?: Unreadable
    }

    /**
     * Whether work stamped [stamp] may run now: the fence reads, is not blocked, and is still at that epoch (a never-created
     * fence is epoch 0). A stamp that is [AutoVoteService.NO_EPOCH] is no epoch, so it never does.
     */
    fun allows(context: Context, stamp: Long): Boolean =
        when (val fence = read(context)) {
            Missing -> stamp == 0L
            is Present -> !fence.blocked && fence.epoch == stamp
            Unreadable -> false
        }

    /** The epoch a run may begin under now, or null while the fence blocks or cannot be read. */
    fun armEpoch(context: Context): Long? =
        when (val fence = read(context)) {
            Missing -> 0L
            is Present -> fence.epoch.takeIf { !fence.blocked }
            Unreadable -> null
        }

    /**
     * Records a full Stop: the epoch one higher and `blocked`, with [requestId] and [at] as the last Stop, in compare-and-set
     * on the fence alone (a change by the other context in between is read again, up to [MAX_ATTEMPTS] times). The same
     * [requestId] twice advances the epoch once. A fence that cannot be read is not written over: its epoch is unknown.
     * Never throws; a Stop that was not saved says why.
     */
    fun recordStop(context: Context, requestId: String, at: Long): Recorded {
        repeat(MAX_ATTEMPTS) {
            val raw = SideStores.read(context, KEY)
            val before = raw?.let { parse(it) ?: return Recorded(false, 0L, "unreadable") }
            if (before?.lastStop?.getString("requestId") == requestId) return Recorded(true, before.epoch, null)
            val epoch = (before?.epoch ?: 0L) + 1
            val text = JSONObject()
                .put("stopEpoch", epoch)
                .put("blocked", true)
                .put("lastStop", JSONObject().put("requestId", requestId).put("at", at).put("durable", true))
                .put("lastArm", before?.lastArm ?: JSONObject.NULL)
                .toString()
            when (SideStores.compareAndSet(context, KEY, raw, text).outcome) {
                SideStores.Outcome.SAVED -> return Recorded(true, epoch, null)
                SideStores.Outcome.MISMATCH -> Unit
                SideStores.Outcome.TOO_LARGE -> return Recorded(false, 0L, "oversize")
                SideStores.Outcome.REFUSED -> return Recorded(false, 0L, "not-saved")
            }
        }
        return Recorded(false, 0L, "not-saved")
    }
}
