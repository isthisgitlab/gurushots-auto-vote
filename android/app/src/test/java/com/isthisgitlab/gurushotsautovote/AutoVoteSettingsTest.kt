package com.isthisgitlab.gurushotsautovote

import android.content.Context
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
class AutoVoteSettingsTest {

    private lateinit var context: Context

    private val defaults = AutoVoteSettings.Snapshot(normalIntervalSeconds = 180L)

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
    }

    private fun config(app: String) = TestSupport.writeConfig(context, """{"version":2,"app":$app}""")

    @Test
    fun nothingStoredFallsBackToDefaults() {
        assertEquals(defaults, AutoVoteSettings.read(context))
    }

    @Test
    fun emptyConfigurationAndEmptyOneXBlobFallBackToDefaults() {
        TestSupport.writeConfig(context, "")
        TestSupport.writeLegacySettings(context, "")
        assertEquals(defaults, AutoVoteSettings.read(context))
    }

    @Test
    fun malformedConfigurationFallsBackToDefaults() {
        TestSupport.writeConfig(context, "{not json")
        assertEquals(defaults, AutoVoteSettings.read(context))
    }

    @Test
    fun aParseFailureLogsOnlyTheExceptionClassNeverTheStoredText() {
        ShadowLog.clear()
        // The configuration holds the token: a JSONException's message quotes the text it could not parse.
        TestSupport.writeConfig(context, """{"token":"s3cr3t-token","apiHeaders":{"x":"s3cr3t-header"""")

        assertEquals(defaults, AutoVoteSettings.read(context))

        val errors = ShadowLog.getLogs().filter { it.type == Log.ERROR }
        assertEquals(listOf("Failed to parse settings JSON (JSONException)"), errors.map { it.msg })
        assertNull(errors.single().throwable)
        assertFalse(ShadowLog.getLogs().any { "s3cr3t" in it.msg || it.throwable?.message?.contains("s3cr3t") == true })
    }

    @Test
    fun aConfigurationWithoutAnAppObjectUsesTheDefaults() {
        TestSupport.writeConfig(context, "{}")
        assertEquals(defaults, AutoVoteSettings.read(context))
        TestSupport.writeConfig(context, """{"app":"lv"}""")
        assertEquals(defaults, AutoVoteSettings.read(context))
        TestSupport.writeConfig(context, """{"app":[5]}""")
        assertEquals(defaults, AutoVoteSettings.read(context))
        // The values of the 1.x layout, at the top level, are not the configuration's.
        TestSupport.writeConfig(context, """{"checkFrequencyMin":9,"language":"lv"}""")
        assertEquals(defaults, AutoVoteSettings.read(context))
    }

    @Test
    fun anEmptyAppObjectUsesPerFieldDefaults() {
        config("{}")
        assertEquals(defaults, AutoVoteSettings.read(context))
    }

    @Test
    fun parsesCheckFrequencyFromTheAppObject() {
        config("""{"checkFrequencyMin": 5, "theme": "dark"}""")
        assertEquals(AutoVoteSettings.Snapshot(normalIntervalSeconds = 300L), AutoVoteSettings.read(context))
    }

    @Test
    fun readsTheAppLanguageAndFallsBackToEnglishForAnythingElse() {
        config("""{"language": "lv"}""")
        assertEquals("lv", AutoVoteSettings.read(context).language)
        config("""{"language": "en"}""")
        assertEquals("en", AutoVoteSettings.read(context).language)
        for (app in listOf("""{"language": "de"}""", """{"language": ""}""", """{"language": 7}""", "{}")) {
            config(app)
            assertEquals(app, "en", AutoVoteSettings.read(context).language)
        }
    }

    @Test
    fun theConfigurationIsReadWhereverItsAppObjectSits() {
        TestSupport.writeConfig(context, """{"token":"x","auth":{"token":"t"},"app":{"language":"lv","checkFrequencyMin":4},"defaults":{}}""")
        assertEquals(AutoVoteSettings.Snapshot(normalIntervalSeconds = 240L, language = "lv"), AutoVoteSettings.read(context))
    }

    @Test
    fun theOneXBlobIsReadAtItsTopLevelWhileThereIsNoConfiguration() {
        TestSupport.writeLegacySettings(context, """{"token": "tok", "checkFrequencyMin": 5, "language": "lv"}""")
        assertEquals(AutoVoteSettings.Snapshot(normalIntervalSeconds = 300L, language = "lv"), AutoVoteSettings.read(context))
        // An empty configuration is none.
        TestSupport.writeConfig(context, "")
        assertEquals(AutoVoteSettings.Snapshot(normalIntervalSeconds = 300L, language = "lv"), AutoVoteSettings.read(context))
    }

    @Test
    fun theOneXBlobFallsBackToDefaultsWhenItIsNotJson() {
        TestSupport.writeLegacySettings(context, "{not json")
        assertEquals(defaults, AutoVoteSettings.read(context))
        TestSupport.writeLegacySettings(context, "{}")
        assertEquals(defaults, AutoVoteSettings.read(context))
    }

    @Test
    fun onceTheConfigurationExistsTheOneXBlobIsNeverRead() {
        TestSupport.writeLegacySettings(context, """{"checkFrequencyMin": 9, "language": "lv"}""")
        config("""{"checkFrequencyMin": 2}""")
        assertEquals(AutoVoteSettings.Snapshot(normalIntervalSeconds = 120L), AutoVoteSettings.read(context))
        // Not even when the configuration is unusable: the import has run, and the blob is a backup.
        TestSupport.writeConfig(context, "{not json")
        assertEquals(defaults, AutoVoteSettings.read(context))
    }
}
