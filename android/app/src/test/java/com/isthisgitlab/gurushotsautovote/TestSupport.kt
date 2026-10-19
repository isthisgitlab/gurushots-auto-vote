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
    const val CONFIG_KEY = "gurushots-config"
    const val LEGACY_SETTINGS_KEY = "gurushots-settings"

    private fun write(context: Context, key: String, raw: String?) {
        context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
            .edit()
            .apply { if (raw == null) remove(key) else putString(key, raw) }
            .commit()
    }

    private fun read(context: Context, key: String): String? =
        context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE).getString(key, null)

    /** The configuration, as the app window and the service store it. */
    fun writeConfig(context: Context, raw: String?) = write(context, CONFIG_KEY, raw)

    fun readConfig(context: Context): String? = read(context, CONFIG_KEY)

    /** The 1.x settings blob an upgrade leaves behind. */
    fun writeLegacySettings(context: Context, raw: String?) = write(context, LEGACY_SETTINGS_KEY, raw)

    fun readLegacySettings(context: Context): String? = read(context, LEGACY_SETTINGS_KEY)

    /**
     * A client that keeps the request path/query/headers but sends every call
     * to [server] over plain HTTP — lets production code keep its hard-coded
     * https://api.gurushots.com URLs while tests assert against MockWebServer.
     */
    fun reroutingClient(
        server: MockWebServer,
        extra: Interceptor? = null,
        builder: OkHttpClient.Builder = OkHttpClient.Builder(),
    ): OkHttpClient {
        if (extra != null) builder.addInterceptor(extra)
        builder.addInterceptor(rerouting(server))
        return builder.build()
    }

    /** The interceptor [reroutingClient] adds: every call goes to [server] over plain HTTP. */
    fun rerouting(server: MockWebServer) = Interceptor { chain ->
        val original = chain.request()
        val target = original.url.newBuilder()
            .scheme("http")
            .host(server.hostName)
            .port(server.port)
            .build()
        chain.proceed(original.newBuilder().url(target).build())
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
