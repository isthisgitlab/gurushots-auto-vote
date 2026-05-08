package com.isthisgitlab.gurushotsautovote

import android.content.Context
import android.util.Log
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * One-shot voting cycle, called from AutoVoteService when an alarm
 * fires. Runs entirely in Kotlin so it works whether or not the
 * WebView / Activity is alive.
 *
 * Scope intentionally limited for the first iteration: fetch active
 * challenges, vote up to the configured exposure target on each
 * non-flash challenge below target. Boost / Turbo / submit-photo /
 * threshold-mode logic stays in the JS scheduler for now and runs
 * when the user opens the app — those features can be ported to
 * Kotlin in follow-up changes once this baseline is verified on
 * the device.
 *
 * Skip behavior: if mock mode is on, we exit early. The native loop
 * is only meaningful against the real API; mock cycles can stay in
 * the JS side since the WebView is open during testing anyway.
 */
object AutoVoteCycle {

    private const val TAG = "AutoVoteCycle"
    private const val BASE = "https://api.gurushots.com"
    private const val FORM_TYPE = "application/x-www-form-urlencoded; charset=utf-8"

    private val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }

    data class Result(
        val processedCount: Int,
        val votedCount: Int,
        val skippedCount: Int,
        val error: String?,
    )

    fun run(context: Context): Result {
        val settings = AutoVoteSettings.read(context)
        if (settings.token.isBlank()) {
            return Result(0, 0, 0, "No token — log in via the app first")
        }
        if (settings.mockMode) {
            // Native loop intentionally no-ops in mock mode; mock
            // voting stays in the JS side where it's useful for UI dev.
            return Result(0, 0, 0, null)
        }

        val challenges = fetchActiveChallenges(settings)
            ?: return Result(0, 0, 0, "Failed to fetch challenges")

        var voted = 0
        var skipped = 0

        for (i in 0 until challenges.length()) {
            val challenge = challenges.optJSONObject(i) ?: continue
            val type = challenge.optString("type", "")
            if (type == "flash") {
                skipped++
                continue
            }
            val member = challenge.optJSONObject("member")
            val ranking = member?.optJSONObject("ranking")
            val exposure = ranking?.optJSONObject("exposure")
            val exposureFactor = exposure?.optInt("exposure_factor", 0) ?: 0

            if (exposureFactor >= settings.exposureTarget) {
                skipped++
                continue
            }

            val challengeId = challenge.optInt("id", 0)
            if (challengeId == 0) {
                skipped++
                continue
            }

            val voteImages = fetchVoteImages(settings, challenge)
            if (voteImages == null || voteImages.length() == 0) {
                skipped++
                continue
            }

            val ok = submitVotes(settings, challengeId, voteImages, settings.exposureTarget)
            if (ok) voted++ else skipped++

            // Be polite — small jitter between challenges so we don't
            // hammer the API in a tight loop. Matches the JS scheduler's
            // 2–5s gap between challenges.
            Thread.sleep((2_000L..5_000L).random())
        }

        return Result(challenges.length(), voted, skipped, null)
    }

    // ---------- HTTP helpers ----------

    private fun headersFor(settings: AutoVoteSettings.Snapshot): Map<String, String> {
        val h = settings.apiHeaders.toMutableMap()
        h["x-token"] = settings.token
        // Some headers must be present even if not in the saved bag.
        // OkHttp adds Host automatically, but Gurushots' cdn-fronting
        // appears to require an explicit host header matching the
        // saved spoof — let it pass through as-is.
        return h
    }

    private fun postForm(url: String, headers: Map<String, String>, body: RequestBody): String? {
        val req = Request.Builder()
            .url(url)
            .post(body)
            .apply {
                headers.forEach { (k, v) -> header(k, v) }
                header("Content-Type", FORM_TYPE)
            }
            .build()
        return try {
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    Log.w(TAG, "POST $url failed: HTTP ${resp.code}")
                    return null
                }
                resp.body?.string()
            }
        } catch (t: Throwable) {
            Log.e(TAG, "POST $url threw", t)
            null
        }
    }

    private fun fetchActiveChallenges(settings: AutoVoteSettings.Snapshot): org.json.JSONArray? {
        val response = postForm(
            "$BASE/rest_mobile/get_my_active_challenges",
            headersFor(settings),
            FormBody.Builder().build(),
        ) ?: return null
        return try {
            JSONObject(response).optJSONArray("challenges")
        } catch (t: Throwable) {
            Log.e(TAG, "active_challenges JSON parse failed", t)
            null
        }
    }

    private fun fetchVoteImages(
        settings: AutoVoteSettings.Snapshot,
        challenge: JSONObject,
    ): org.json.JSONArray? {
        val challengeId = challenge.optInt("id", 0)
        val voteUrl = challenge.optString("url", "")
        if (challengeId == 0 || voteUrl.isEmpty()) return null
        val body = FormBody.Builder()
            .add("c_id", challengeId.toString())
            .add("url", voteUrl)
            .build()
        val response = postForm(
            "$BASE/rest_mobile/get_vote_images",
            headersFor(settings),
            body,
        ) ?: return null
        return try {
            JSONObject(response).optJSONArray("images")
        } catch (t: Throwable) {
            Log.e(TAG, "get_vote_images JSON parse failed", t)
            null
        }
    }

    private fun submitVotes(
        settings: AutoVoteSettings.Snapshot,
        challengeId: Int,
        voteImages: org.json.JSONArray,
        targetExposure: Int,
    ): Boolean {
        val builder = FormBody.Builder().add("c_id", challengeId.toString())
        var added = 0
        // Prefer voting on the first half of returned images; the JS
        // logic is more nuanced (sorts by guru_pick / niceness) but
        // for a first cut we vote on every returned image — matching
        // the simplest possible cycle. The exposure jump is the same
        // either way.
        for (i in 0 until voteImages.length()) {
            val img = voteImages.optJSONObject(i) ?: continue
            val imageId = img.optString("id", "") ?: continue
            if (imageId.isEmpty()) continue
            builder.add("image_ids[]", imageId)
            added++
        }
        if (added == 0) return false
        builder.add("exposure", targetExposure.toString())
        val response = postForm(
            "$BASE/rest_mobile/submit_vote",
            headersFor(settings),
            builder.build(),
        )
        return response != null
    }
}
