package com.isthisgitlab.gurushotsautovote

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AutoVoteSettingsTest {

    private lateinit var context: Context

    private val defaults = AutoVoteSettings.Snapshot(normalIntervalSeconds = 180L)

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
    }

    @Test
    fun missingBlobFallsBackToDefaults() {
        TestSupport.writeSettings(context, null)
        assertEquals(defaults, AutoVoteSettings.read(context))
    }

    @Test
    fun emptyBlobFallsBackToDefaults() {
        TestSupport.writeSettings(context, "")
        assertEquals(defaults, AutoVoteSettings.read(context))
    }

    @Test
    fun malformedJsonFallsBackToDefaults() {
        TestSupport.writeSettings(context, "{not json")
        assertEquals(defaults, AutoVoteSettings.read(context))
    }

    @Test
    fun minimalObjectUsesPerFieldDefaults() {
        TestSupport.writeSettings(context, "{}")
        assertEquals(defaults, AutoVoteSettings.read(context))
    }

    @Test
    fun parsesCheckFrequency() {
        TestSupport.writeSettings(context, """{"token": "tok", "checkFrequencyMin": 5}""")
        assertEquals(AutoVoteSettings.Snapshot(normalIntervalSeconds = 300L), AutoVoteSettings.read(context))
    }
}
