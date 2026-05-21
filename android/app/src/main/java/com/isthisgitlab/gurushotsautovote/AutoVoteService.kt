package com.isthisgitlab.gurushotsautovote

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.app.NotificationCompat
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Foreground Service that owns background voting.
 *
 * The native AlarmManager/Doze/wakelock/notification scaffolding is kept
 * (it survives the app being swiped from recents and Doze deep-sleep),
 * but the per-cycle work now runs the SHARED JS voting strategy in a
 * service-owned headless WebView instead of a Kotlin re-implementation —
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
        const val NOTIFICATION_ID = 27782
        const val CHANNEL_ID = "autovote-foreground"

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
        // @capacitor/preferences store the JS settings module reads/writes.
        private const val PREFS_FILE = "CapacitorStorage"
        private const val SETTINGS_KEY = "gurushots-settings"
        private const val HEADLESS_URL = "file:///android_asset/public/headless.html"
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

    private val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }

    private val cycleWatchdog = Runnable {
        Log.w(TAG, "Cycle watchdog fired — JS did not report completion in time")
        lastError = "cycle-timeout"
        completeCycle(-1L)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> handleStart()
            ACTION_RUN_CYCLE -> handleRunCycle()
            ACTION_STOP -> {
                handleStop()
                return START_NOT_STICKY
            }
        }
        return START_STICKY
    }

    private fun handleStart() {
        if (isRunning) {
            Log.i(TAG, "handleStart called but service already running")
            return
        }
        isRunning = true
        cycleCount = 0
        lastError = null
        startForegroundNotification("Auto-vote starting…")
        mainHandler.post { createWebView() }
        scheduleNextAlarm(INITIAL_DELAY_MS)
    }

    private fun handleRunCycle() {
        if (!isRunning) {
            Log.i(TAG, "RUN_CYCLE received but service not in running state — ignoring")
            return
        }
        mainHandler.post {
            // A STOP may have been processed after this lambda was queued —
            // don't start a cycle (or acquire a wakelock) against a service
            // that's shutting down.
            if (!isRunning) return@post
            if (webView == null) createWebView()
            if (!pageReady) {
                Log.i(TAG, "Headless page not ready yet — retrying shortly")
                scheduleNextAlarm(PAGE_RETRY_MS)
                return@post
            }
            cycleDone.set(false)
            cycleWakeLock = acquireWakelock()
            mainHandler.postDelayed(cycleWatchdog, CYCLE_TIMEOUT_MS)
            Log.i(TAG, "Cycle ${cycleCount + 1} starting (JS)")
            webView?.evaluateJavascript(
                "(function(){try{" +
                    "if(window.GS&&window.GS.runOneCycle){window.GS.runOneCycle();}" +
                    "else{AndroidHeadlessBridge.onCycleComplete(JSON.stringify({ok:false,error:'not-loaded'}));}" +
                    "}catch(e){AndroidHeadlessBridge.onCycleComplete(JSON.stringify({ok:false,error:String(e)}));}})()",
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
            updateNotification(formatStatus())
            if (isRunning) {
                val delay = if (nextDelayMs in 1_000L..MAX_DELAY_MS) nextDelayMs else cycleIntervalMs()
                Log.i(TAG, "Cycle $cycleCount done; next in ${delay}ms")
                scheduleNextAlarm(delay)
            }
        }
    }

    private fun handleStop() {
        isRunning = false
        mainHandler.removeCallbacks(cycleWatchdog)
        cancelPendingAlarm()
        // Touch cycleWakeLock + webView only on the main thread — completeCycle
        // also runs there, so the two can't race on these non-volatile fields.
        mainHandler.post {
            cycleWakeLock?.let { if (it.isHeld) it.release() }
            cycleWakeLock = null
            webView?.destroy()
            webView = null
            pageReady = false
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(cycleWatchdog)
        cycleWakeLock?.let { if (it.isHeld) it.release() }
        cycleWakeLock = null
        mainHandler.post {
            webView?.destroy()
            webView = null
        }
        super.onDestroy()
    }

    // ---------- Headless WebView ----------

    private fun createWebView() {
        if (webView != null) return
        Log.i(TAG, "Creating headless WebView")
        val wv = WebView(this)
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.settings.allowFileAccess = true
        // Defense in depth: the page is a first-party local asset, but make
        // the cross-origin file-read defaults explicit so they can't drift.
        wv.settings.allowFileAccessFromFileURLs = false
        wv.settings.allowUniversalAccessFromFileURLs = false
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
            } catch (t: Throwable) {
                resolveHttp(id, JSONObject().put("error", t.message ?: "bad-request"))
                return
            }
            http.newCall(req).enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    resolveHttp(id, JSONObject().put("error", e.message ?: "network-error"))
                }

                override fun onResponse(call: Call, response: Response) {
                    response.use { resp ->
                        val bodyStr = resp.body?.string() ?: ""
                        val headersObj = JSONObject()
                        for (name in resp.headers.names()) headersObj.put(name.lowercase(Locale.US), resp.header(name))
                        resolveHttp(
                            id,
                            JSONObject().put("status", resp.code).put("body", bodyStr).put("headers", headersObj),
                        )
                    }
                }
            })
        }
    }

    private fun buildRequest(method: String, url: String, headersJson: String, body: String): Request {
        val parsed = url.toHttpUrlOrNull() ?: throw IllegalArgumentException("invalid url")
        // Defense in depth: the only caller is first-party JS targeting
        // api.gurushots.com over https. Reject anything else so a future bug
        // that fed an attacker-controlled URL here can't become an SSRF.
        // Dot-anchored so "evilgurushots.com" doesn't slip past a bare suffix.
        val host = parsed.host
        val hostAllowed = host == "gurushots.com" || host.endsWith(".gurushots.com")
        if (parsed.scheme != "https" || !hostAllowed) {
            throw IllegalArgumentException("blocked url host/scheme: $host")
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

    private fun resolveHttp(id: Int, payload: JSONObject) {
        val js = "window.__gsResolveHeadlessHttp && window.__gsResolveHeadlessHttp($id, ${JSONObject.quote(payload.toString())});"
        mainHandler.post { webView?.evaluateJavascript(js, null) }
    }

    /** Settings bridge — same store @capacitor/preferences uses, so token/settings stay in sync. */
    inner class HeadlessStore {
        @android.webkit.JavascriptInterface
        fun read(): String? = getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE).getString(SETTINGS_KEY, null)

        @android.webkit.JavascriptInterface
        fun write(data: String) {
            // Guard the shared settings store: only persist parseable JSON so a
            // JS bug can't corrupt the blob the main app reads (incl. the token).
            try {
                JSONObject(data)
            } catch (t: Throwable) {
                Log.w(TAG, "Refusing to persist non-JSON settings blob")
                return
            }
            getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE).edit().putString(SETTINGS_KEY, data).apply()
        }
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
                Log.w(TAG, "Bad onCycleComplete payload", t)
            }
            // lastError can carry API-derived content; keep the detail out of
            // release logcat (the JS console path is gated the same way).
            if (isDebuggable) {
                Log.i(TAG, "Cycle reported complete: nextDelayMs=$delay error=$lastError")
            } else {
                Log.i(TAG, "Cycle reported complete: nextDelayMs=$delay${if (lastError != null) " (error)" else ""}")
            }
            completeCycle(delay)
        }
    }

    // ---------- AlarmManager ----------

    private fun alarmIntent(): PendingIntent {
        val intent = Intent(this, AutoVoteAlarmReceiver::class.java).apply {
            action = ACTION_RUN_CYCLE
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        return PendingIntent.getBroadcast(this, 0, intent, flags)
    }

    private fun cycleIntervalMs(): Long {
        val configured = AutoVoteSettings.read(this).normalIntervalSeconds
        return if (configured > 0) configured * 1000L else DEFAULT_CYCLE_INTERVAL_MS
    }

    private fun scheduleNextAlarm(delayMs: Long) {
        val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val triggerAt = System.currentTimeMillis() + delayMs.coerceAtLeast(1_000L)
        try {
            // setExactAndAllowWhileIdle is the only Android primitive that
            // pierces Doze for sub-15-min cadence. Android 12+ requires
            // SCHEDULE_EXACT_ALARM; without it, fall back to the inexact
            // (best-effort) variant which does not throw.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, alarmIntent())
            } else {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, alarmIntent())
            }
        } catch (sec: SecurityException) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, alarmIntent())
        }
    }

    private fun cancelPendingAlarm() {
        val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        am.cancel(alarmIntent())
    }

    // ---------- Notification ----------

    private fun ensureNotificationChannel() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Auto-vote",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Persistent notification while auto-vote is running in the background."
                setShowBadge(false)
            }
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String): Notification {
        val openAppIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val openAppPi = openAppIntent?.let {
            PendingIntent.getActivity(this, 1, it, pendingFlags)
        }

        val stopIntent = Intent(this, AutoVoteService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPi = PendingIntent.getService(this, 2, stopIntent, pendingFlags)

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("GuruShots Auto Vote")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_rotate)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(openAppPi)
            .addAction(
                android.R.drawable.ic_delete,
                "Stop",
                stopPi,
            )
            .build()
    }

    private fun startForegroundNotification(text: String) {
        val notification = buildNotification(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun formatStatus(): String {
        val time = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        val err = lastError ?: return "Last cycle at $time (#$cycleCount)"
        // Map internal codes to something an end user can act on.
        val friendly = when (err) {
            "no-token" -> "Not logged in — open the app and log in"
            "cycle-timeout" -> "Timed out — will retry"
            else -> err
        }
        return "Last error at $time: $friendly"
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
