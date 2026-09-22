package com.isthisgitlab.gurushotsautovote

import android.content.Context
import mockwebserver3.MockWebServer
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.Source
import okio.Timeout
import okio.buffer
import java.io.IOException

/** Shared fixtures for the JVM unit tests. */
internal object TestSupport {
    const val PREFS_FILE = "CapacitorStorage"
    const val SETTINGS_KEY = "gurushots-settings"

    fun writeSettings(context: Context, raw: String?) {
        context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
            .edit()
            .apply { if (raw == null) remove(SETTINGS_KEY) else putString(SETTINGS_KEY, raw) }
            .commit()
    }

    fun readSettings(context: Context): String? =
        context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE).getString(SETTINGS_KEY, null)

    /**
     * A client that keeps the request path/query/headers but sends every call
     * to [server] over plain HTTP — lets production code keep its hard-coded
     * https://api.gurushots.com URLs while tests assert against MockWebServer.
     */
    fun reroutingClient(server: MockWebServer, extra: Interceptor? = null): OkHttpClient {
        val builder = OkHttpClient.Builder()
        if (extra != null) builder.addInterceptor(extra)
        builder.addInterceptor { chain ->
            val original = chain.request()
            val target = original.url.newBuilder()
                .scheme("http")
                .host(server.hostName)
                .port(server.port)
                .build()
            chain.proceed(original.newBuilder().url(target).build())
        }
        return builder.build()
    }

    /**
     * Short-circuits the call with a 200 whose body fails on the first read
     * (a connection dropped mid-body). [onClose] runs when the body is closed,
     * which lets tests wait for the consumer to finish with it.
     */
    fun failingBodyInterceptor(onClose: () -> Unit = {}) = Interceptor { chain ->
        val source = object : Source {
            override fun read(sink: Buffer, byteCount: Long): Long = throw IOException("unexpected end of stream")
            override fun timeout(): Timeout = Timeout.NONE
            override fun close() = onClose()
        }
        Response.Builder()
            .request(chain.request())
            .protocol(Protocol.HTTP_1_1)
            .code(200)
            .message("OK")
            .body(
                object : ResponseBody() {
                    private val buffered = source.buffer()
                    override fun contentType(): MediaType? = null
                    override fun contentLength(): Long = -1L
                    override fun source(): BufferedSource = buffered
                },
            )
            .build()
    }
}
