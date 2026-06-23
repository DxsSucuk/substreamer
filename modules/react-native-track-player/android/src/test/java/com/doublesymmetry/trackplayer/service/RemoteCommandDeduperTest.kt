package com.doublesymmetry.trackplayer.service

import com.doublesymmetry.trackplayer.service.RemoteCommandDeduper.Channel
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Truth-table coverage for the cross-channel remote-command deduper.
 * Windows are pinned (cross=200, same=80) so the cases are exact.
 */
class RemoteCommandDeduperTest {
    private val NEXT = "remote-next"
    private val PLAY = "remote-play"

    private fun deduper() = RemoteCommandDeduper(crossWindowMs = 200, sameWindowMs = 80)

    @Test
    fun firstPressEmits() {
        assertTrue(deduper().shouldEmit(NEXT, Channel.BROADCAST, 1000))
    }

    @Test
    fun crossChannelFanoutWithinWindowSuppressed() {
        val d = deduper()
        assertTrue(d.shouldEmit(NEXT, Channel.BROADCAST, 1000))
        assertFalse(d.shouldEmit(NEXT, Channel.SESSION_KEY, 1015)) // same press, other route, 15ms
    }

    @Test
    fun threeChannelFanoutActsOnce() {
        val d = deduper()
        assertTrue(d.shouldEmit(NEXT, Channel.BROADCAST, 1000))
        assertFalse(d.shouldEmit(NEXT, Channel.SESSION_KEY, 1010))
        assertFalse(d.shouldEmit(NEXT, Channel.PLAYER_CMD, 1020))
    }

    @Test
    fun distinctPressesSameChannelBothEmit() {
        val d = deduper()
        assertTrue(d.shouldEmit(NEXT, Channel.BROADCAST, 1000))
        assertTrue(d.shouldEmit(NEXT, Channel.BROADCAST, 1300)) // deliberate skip 300ms later
    }

    @Test
    fun the205Wedge_distinctPressesPassWithNoDownTimeSignal() {
        // downTime is not an input. Distinct presses on one channel, each > window
        // apart, all pass — the #205 wedge (constant downTime) cannot recur.
        val d = deduper()
        assertTrue(d.shouldEmit(NEXT, Channel.BROADCAST, 1000))
        assertTrue(d.shouldEmit(NEXT, Channel.BROADCAST, 1250))
        assertTrue(d.shouldEmit(NEXT, Channel.BROADCAST, 1600))
    }

    @Test
    fun sameChannelRedeliveryWithinSameWindowSuppressed() {
        // Media3 1.9.2 double-fire on one channel (androidx/media#3083).
        val d = deduper()
        assertTrue(d.shouldEmit(NEXT, Channel.SESSION_KEY, 1000))
        assertFalse(d.shouldEmit(NEXT, Channel.SESSION_KEY, 1003)) // 3ms redelivery
    }

    @Test
    fun fastDoublePressSameChannelJustOutsideSameWindowEmits() {
        val d = deduper()
        assertTrue(d.shouldEmit(NEXT, Channel.SESSION_KEY, 1000))
        assertTrue(d.shouldEmit(NEXT, Channel.SESSION_KEY, 1090)) // 90ms > sameWindow(80)
    }

    @Test
    fun sameChannelUsesSameWindowNotCrossWindow() {
        // 150ms on the same channel: > same(80) but < cross(200) -> still a distinct press.
        val d = deduper()
        assertTrue(d.shouldEmit(NEXT, Channel.BROADCAST, 1000))
        assertTrue(d.shouldEmit(NEXT, Channel.BROADCAST, 1150))
    }

    @Test
    fun crossChannelOutsideWindowEmits() {
        val d = deduper()
        assertTrue(d.shouldEmit(NEXT, Channel.BROADCAST, 1000))
        assertTrue(d.shouldEmit(NEXT, Channel.SESSION_KEY, 1250)) // 250 > cross(200)
    }

    @Test
    fun interleavedCommandsAreIndependent() {
        val d = deduper()
        assertTrue(d.shouldEmit(NEXT, Channel.BROADCAST, 1000))
        assertTrue(d.shouldEmit(PLAY, Channel.BROADCAST, 1010))      // different command
        assertFalse(d.shouldEmit(NEXT, Channel.SESSION_KEY, 1015))   // NEXT twin vs NEXT anchor
        assertFalse(d.shouldEmit(PLAY, Channel.SESSION_KEY, 1020))   // PLAY twin vs PLAY anchor
    }

    @Test
    fun anchorNotAdvancedOnSuppress() {
        // A burst of suppressed duplicates must not keep extending the window.
        val d = deduper()
        assertTrue(d.shouldEmit(NEXT, Channel.BROADCAST, 1000))   // emit, anchor @1000
        assertFalse(d.shouldEmit(NEXT, Channel.SESSION_KEY, 1050)) // suppress, anchor stays @1000
        assertFalse(d.shouldEmit(NEXT, Channel.PLAYER_CMD, 1100))  // suppress, anchor stays @1000
        // 210ms after the EMIT (not the last suppress); if the anchor had advanced this would suppress.
        assertTrue(d.shouldEmit(NEXT, Channel.SESSION_KEY, 1210))
    }

    @Test
    fun multiRouteTwoPressesEachActOnce() {
        // Device fans every press across BROADCAST(lead)+SESSION; presses 300ms apart.
        val d = deduper()
        assertTrue(d.shouldEmit(NEXT, Channel.BROADCAST, 1000))    // press 1 lead
        assertFalse(d.shouldEmit(NEXT, Channel.SESSION_KEY, 1015)) // press 1 twin
        assertTrue(d.shouldEmit(NEXT, Channel.BROADCAST, 1300))    // press 2 lead (same channel, > same window)
        assertFalse(d.shouldEmit(NEXT, Channel.SESSION_KEY, 1315)) // press 2 twin
    }
}
