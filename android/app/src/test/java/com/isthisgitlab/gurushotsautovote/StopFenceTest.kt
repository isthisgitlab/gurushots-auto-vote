package com.isthisgitlab.gurushotsautovote

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import io.mockk.every
import io.mockk.mockkObject
import io.mockk.unmockkObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowLog

/**
 * The priority Stop fence and the control inbox as native side stores: the allow-list, the byte bounds, strict reads, the
 * compare-and-set only rule, and what a full Stop records. The fence is its own cell: none of these tests give it a
 * neighbour's data to read.
 */
@RunWith(RobolectricTestRunner::class)
class StopFenceTest {

    private lateinit var app: Application

    private companion object {
        const val FENCE = "gs_scenario_stop_fence"
        const val CONTROLS = "gs_scenario_controls"
        const val OPEN = """{"stopEpoch":2,"blocked":false,"lastStop":null,"lastArm":null}"""
        const val STOPPED =
            """{"stopEpoch":3,"blocked":true,"lastStop":{"requestId":"stop-a","at":10,"durable":true},"lastArm":{"epoch":2,"at":7}}"""
    }

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        SideStores.resume()
        prefs().edit().clear().commit()
    }

    @After
    fun tearDown() {
        unmockkObject(SideStores)
        prefs().edit().clear().commit()
        SideStores.resume()
    }

    private fun prefs() = app.getSharedPreferences(SideStores.PREFS_FILE, Context.MODE_PRIVATE)

    /** Stored as the JS side or a damaged file would leave it: no validation. */
    private fun put(raw: String) = prefs().edit().putString(FENCE, raw).commit()

    private fun stored(): String? = prefs().getString(FENCE, null)

    private fun object1024(): String {
        val head = """{"stopEpoch":1,"blocked":true,"lastStop":{"requestId":""""
        val tail = """","at":1,"durable":true},"lastArm":null}"""
        return head + "x".repeat(1024 - head.length - tail.length) + tail
    }

    // ---------- the two keys are side stores with their own bounds ----------

    @Test
    fun theFenceAndTheInboxAreAllowedKeysChangedByCompareAndSetOnly() {
        ShadowLog.clear()
        assertTrue(SideStores.isAllowed(FENCE))
        assertTrue(SideStores.isAllowed(CONTROLS))
        assertFalse(SideStores.write(app, FENCE, OPEN))
        assertFalse(SideStores.write(app, CONTROLS, """{"targets":{}}"""))
        assertNull(SideStores.read(app, FENCE))
        assertNull(SideStores.read(app, CONTROLS))
        assertEquals(SideStores.Outcome.SAVED, SideStores.compareAndSet(app, FENCE, null, OPEN).outcome)
        assertEquals(SideStores.Outcome.SAVED, SideStores.compareAndSet(app, CONTROLS, null, """{"targets":{}}""").outcome)
        assertEquals(OPEN, SideStores.read(app, FENCE))
        assertEquals("""{"targets":{}}""", SideStores.read(app, CONTROLS))
        assertEquals(
            listOf(
                "Refusing a plain write of stop fence blob: it is changed by compare-and-set only",
                "Refusing a plain write of control inbox blob: it is changed by compare-and-set only",
            ),
            ShadowLog.getLogsForTag(AutoVoteService.TAG).map { it.msg },
        )
    }

    @Test
    fun theFenceHoldsAtMostOneKibibyteAndTheInboxTwiceTheScenarioImportSize() {
        ShadowLog.clear()
        val atBound = object1024()
        assertEquals(1024, atBound.toByteArray().size)
        assertEquals(SideStores.Outcome.SAVED, SideStores.compareAndSet(app, FENCE, null, atBound).outcome)
        val over = atBound.replace("x", "xx")
        assertEquals(SideStores.Outcome.TOO_LARGE, SideStores.compareAndSet(app, FENCE, atBound, over).outcome)
        assertEquals(atBound, SideStores.read(app, FENCE))

        // 524288 bytes is exactly twice the 262144-byte scenario import size.
        val head = """{"targets":{"installation":{"pending":""""
        val tail = """"}}}"""
        val maxInbox = head + "x".repeat(524_288 - head.length - tail.length) + tail
        assertEquals(524_288, maxInbox.toByteArray().size)
        assertEquals(SideStores.Outcome.SAVED, SideStores.compareAndSet(app, CONTROLS, null, maxInbox).outcome)
        val overInbox = maxInbox.replace("\"}}}", "x\"}}}")
        assertEquals(524_289, overInbox.toByteArray().size)
        val refused = SideStores.compareAndSet(app, CONTROLS, maxInbox, overInbox)
        assertEquals(SideStores.Outcome.TOO_LARGE, refused.outcome)
        assertEquals(maxInbox, SideStores.read(app, CONTROLS))
        assertEquals(
            listOf("Refusing to persist oversized stop fence blob", "Refusing to persist oversized control inbox blob"),
            ShadowLog.getLogsForTag(AutoVoteService.TAG).map { it.msg },
        )
    }

    @Test
    fun theKeysTheSideStoreCapAlreadyBoundedKeepTheirBound() {
        // The new bounds apply to the two new keys only: another side store still stops at the side-store cap.
        val big = "{\"k\":\"" + "x".repeat(SideStores.MAX_BYTES) + "\"}"
        assertEquals(SideStores.Outcome.TOO_LARGE, SideStores.compareAndSet(app, "gs_join_state", null, big).outcome)
        assertEquals(256 * 1024, SideStores.MAX_BYTES)
        assertEquals(1024, SideStores.MAX_FENCE_BYTES)
        assertEquals(2 * 256 * 1024, SideStores.MAX_CONTROLS_BYTES)
    }

    @Test
    fun theFenceIsNeverStoredInAnotherShape() {
        ShadowLog.clear()
        listOf("""{"stopEpoch":1}""", """{"epoch":1}""", "{}").forEach {
            assertEquals(SideStores.Outcome.REFUSED, SideStores.compareAndSet(app, FENCE, null, it).outcome)
        }
        assertNull(stored())
        assertEquals(
            List(3) { "Refusing to persist malformed stop fence blob" },
            ShadowLog.getLogsForTag(AutoVoteService.TAG).map { it.msg },
        )
    }

    // ---------- the shape ----------

    @Test
    fun aFenceIsExactlyItsShape() {
        val open = StopFence.parse(OPEN)!!
        assertEquals(2L, open.epoch)
        assertFalse(open.blocked)
        assertNull(open.lastStop)
        assertNull(open.lastArm)

        val stopped = StopFence.parse(STOPPED)!!
        assertEquals(3L, stopped.epoch)
        assertTrue(stopped.blocked)
        assertEquals("stop-a", stopped.lastStop!!.getString("requestId"))
        assertEquals(2, stopped.lastArm!!.getInt("epoch"))

        // An epoch past what a 32-bit integer holds is still a count.
        assertEquals(4_294_967_296L, StopFence.parse("""{"stopEpoch":4294967296,"blocked":false,"lastStop":null,"lastArm":null}""")!!.epoch)
    }

    @Test
    fun dataThatIsNotExactlyTheShapeIsNoFence() {
        val bad = listOf(
            "",
            "not json",
            "[]",
            "{}",
            OPEN + " trailing",
            OPEN.replace("}", ",\"extra\":1}"),
            """{"stopEpoch":1,"blocked":false,"lastStop":null}""",
            OPEN.replace("\"stopEpoch\":2", "\"stopEpoch\":-1"),
            OPEN.replace("\"stopEpoch\":2", "\"stopEpoch\":1.5"),
            OPEN.replace("\"stopEpoch\":2", "\"stopEpoch\":\"2\""),
            OPEN.replace("\"stopEpoch\":2", "\"stopEpoch\":9007199254740992"),
            OPEN.replace("\"blocked\":false", "\"blocked\":\"no\""),
            OPEN.replace("\"lastStop\":null", "\"lastStop\":\"x\""),
            OPEN.replace("\"lastStop\":null", "\"lastStop\":{}"),
            OPEN.replace("\"lastStop\":null", """"lastStop":{"requestId":1,"at":1,"durable":true}"""),
            OPEN.replace("\"lastStop\":null", """"lastStop":{"requestId":"a","at":"1","durable":true}"""),
            OPEN.replace("\"lastStop\":null", """"lastStop":{"requestId":"a","at":1e999,"durable":true}"""),
            OPEN.replace("\"lastStop\":null", """"lastStop":{"requestId":"a","at":1,"durable":"yes"}"""),
            OPEN.replace("\"lastStop\":null", """"lastStop":{"requestId":"a","at":1,"other":true}"""),
            OPEN.replace("\"lastArm\":null", "\"lastArm\":3"),
            OPEN.replace("\"lastArm\":null", """"lastArm":{"epoch":1}"""),
            OPEN.replace("\"lastArm\":null", """"lastArm":{"epoch":-1,"at":1}"""),
            OPEN.replace("\"lastArm\":null", """"lastArm":{"epoch":1,"at":"x"}"""),
        )
        bad.forEach { assertNull("should be refused: $it", StopFence.parse(it)) }
        // One more byte than the cell holds.
        assertNull(StopFence.parse(object1024().replace("x", "xx")))
    }

    // ---------- what may run ----------

    @Test
    fun aFenceThatWasNeverCreatedIsEpochZeroAndOpen() {
        assertTrue(StopFence.allows(app, 0L))
        assertFalse(StopFence.allows(app, 1L))
        assertFalse(StopFence.allows(app, AutoVoteService.NO_EPOCH))
        assertEquals(0L, StopFence.armEpoch(app))
    }

    @Test
    fun aReadableOpenFenceAllowsOnlyTheEpochItIsAt() {
        put(OPEN)
        assertTrue(StopFence.allows(app, 2L))
        assertFalse(StopFence.allows(app, 1L))
        assertFalse(StopFence.allows(app, AutoVoteService.NO_EPOCH))
        assertEquals(2L, StopFence.armEpoch(app))
    }

    @Test
    fun aBlockedFenceAllowsNothing() {
        put(STOPPED)
        assertFalse(StopFence.allows(app, 3L))
        assertFalse(StopFence.allows(app, 2L))
        assertNull(StopFence.armEpoch(app))
    }

    @Test
    fun aFenceThatCannotBeReadIsNeverEpochZero() {
        put("""{"stopEpoch":0,"blocked":"maybe","lastStop":null,"lastArm":null}""")
        assertFalse(StopFence.allows(app, 0L))
        assertNull(StopFence.armEpoch(app))
        put("garbage")
        assertFalse(StopFence.allows(app, 0L))
        assertNull(StopFence.armEpoch(app))
    }

    // ---------- recording a full Stop ----------

    @Test
    fun aStopOnAFenceThatWasNeverCreatedMakesEpochOneAndBlocksIt() {
        val recorded = StopFence.recordStop(app, "stop-a", 1_234L)
        assertTrue(recorded.durable)
        assertEquals(1L, recorded.epoch)
        assertNull(recorded.reason)
        val fence = StopFence.parse(stored()!!)!!
        assertEquals(1L, fence.epoch)
        assertTrue(fence.blocked)
        assertEquals("stop-a", fence.lastStop!!.getString("requestId"))
        assertEquals(1_234L, fence.lastStop.getLong("at"))
        assertTrue(fence.lastStop.getBoolean("durable"))
        assertNull(fence.lastArm)
        assertNull(StopFence.armEpoch(app))
    }

    @Test
    fun aStopAdvancesTheEpochKeepsTheLastArmAndRepeatsAreIdempotent() {
        put("""{"stopEpoch":2,"blocked":false,"lastStop":null,"lastArm":{"epoch":2,"at":7}}""")
        val first = StopFence.recordStop(app, "stop-a", 10L)
        assertEquals(3L, first.epoch)
        val afterFirst = stored()
        assertNotNull(StopFence.parse(afterFirst!!)!!.lastArm)
        assertEquals(2, StopFence.parse(afterFirst)!!.lastArm!!.getInt("epoch"))

        // The same request again advances nothing and writes nothing.
        val again = StopFence.recordStop(app, "stop-a", 99L)
        assertTrue(again.durable)
        assertEquals(3L, again.epoch)
        assertEquals(afterFirst, stored())

        // Another Stop advances once more.
        assertEquals(4L, StopFence.recordStop(app, "stop-b", 11L).epoch)
        assertEquals("stop-b", StopFence.parse(stored()!!)!!.lastStop!!.getString("requestId"))
    }

    @Test
    fun aFenceThatCannotBeReadIsNotWrittenOverByAStop() {
        put("garbage")
        val recorded = StopFence.recordStop(app, "stop-a", 1L)
        assertFalse(recorded.durable)
        assertEquals("unreadable", recorded.reason)
        assertEquals("garbage", stored())
    }

    @Test
    fun aStopTheStoreRefusesIsNotDurableAndSaysWhy() {
        mockkObject(SideStores)
        every { SideStores.compareAndSet(any(), FENCE, any(), any(), any()) } returns
            SideStores.Result(SideStores.Outcome.REFUSED, null)
        val refused = StopFence.recordStop(app, "stop-a", 1L)
        assertFalse(refused.durable)
        assertEquals("not-saved", refused.reason)

        every { SideStores.compareAndSet(any(), FENCE, any(), any(), any()) } returns
            SideStores.Result(SideStores.Outcome.TOO_LARGE, null)
        val large = StopFence.recordStop(app, "stop-a", 1L)
        assertFalse(large.durable)
        assertEquals("oversize", large.reason)
    }

    @Test
    fun aStopThatLostTheRaceReadsTheFenceAgainAndOneThatKeepsLosingGivesUp() {
        // The other context changes the fence once between the read and the save: the Stop is made again on what it saved.
        put(OPEN)
        mockkObject(SideStores)
        var lost = false
        every { SideStores.compareAndSet(any(), FENCE, any(), any(), any()) } answers {
            if (!lost) {
                lost = true
                put(OPEN.replace("\"stopEpoch\":2", "\"stopEpoch\":5"))
                SideStores.Result(SideStores.Outcome.MISMATCH, stored())
            } else {
                callOriginal()
            }
        }
        val recorded = StopFence.recordStop(app, "stop-a", 1L)
        assertTrue(recorded.durable)
        assertEquals(6L, recorded.epoch)

        every { SideStores.compareAndSet(any(), FENCE, any(), any(), any()) } returns
            SideStores.Result(SideStores.Outcome.MISMATCH, null)
        val gaveUp = StopFence.recordStop(app, "stop-b", 1L)
        assertFalse(gaveUp.durable)
        assertEquals("not-saved", gaveUp.reason)
    }

    @Test
    fun aRequestIdIsOneOfTheNamesAStopMayCarry() {
        assertTrue(StopFence.isRequestId("stop-lq2x-0"))
        assertTrue(StopFence.isRequestId("a".repeat(64)))
        assertFalse(StopFence.isRequestId(""))
        assertFalse(StopFence.isRequestId("a".repeat(65)))
        assertFalse(StopFence.isRequestId("has space"))
    }
}
