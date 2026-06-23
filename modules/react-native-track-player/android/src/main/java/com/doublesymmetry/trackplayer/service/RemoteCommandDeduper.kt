package com.doublesymmetry.trackplayer.service

/**
 * Cross-channel de-duplicator for remote transport commands (Bluetooth/AVRCP,
 * notification, lock screen, Android Auto).
 *
 * A single physical press can reach the service through more than one native
 * channel — a legacy MEDIA_BUTTON broadcast (onStartCommand), the MediaSession
 * onMediaButtonEvent callback, and/or a Media3 player command — and Media3 1.9.2
 * can itself deliver one event twice on a single channel (androidx/media#3083).
 * Without de-duplication those fan out into multiple skips.
 *
 * The de-dup keys on RECEIPT TIME and CHANNEL — deliberately NOT on
 * KeyEvent.downTime, which is unreliable for synthesised Bluetooth key events
 * (frequently a constant 0) and was the cause of #205: a stale downTime suppressed
 * every later press forever because the comparison state never expired.
 *
 * Rules, per command, anchored on the last EMITTED occurrence:
 *  - a duplicate from a DIFFERENT channel within [crossWindowMs] is one press
 *    fanned out across routes  -> suppress.
 *  - a duplicate from the SAME channel within [sameWindowMs] is a near-instant
 *    redelivery (e.g. Media3 #3083)  -> suppress.
 *  - everything else is emitted. Distinct human presses are channel-consistent and
 *    arrive far more than a window apart, so they always pass. The anchor advances
 *    ONLY on emit, never on a suppressed event, so a burst of duplicates cannot
 *    keep extending the window.
 *
 * Bias is toward emitting: when in doubt, act rather than swallow a real press —
 * the bug being fixed is over-suppression.
 *
 * Pure and time-injected ([nowUptimeMs] is passed in) so it unit-tests without an
 * Android runtime. [shouldEmit] is @Synchronized so it is safe regardless of which
 * thread an emit site runs on (today they are all main-thread-confined).
 */
class RemoteCommandDeduper(
    private val crossWindowMs: Long = DEFAULT_CROSS_WINDOW_MS,
    private val sameWindowMs: Long = DEFAULT_SAME_WINDOW_MS,
) {
    enum class Channel { BROADCAST, SESSION_KEY, PLAYER_CMD }

    private data class Anchor(val channel: Channel, val uptimeMs: Long)

    private val lastByCommand = HashMap<String, Anchor>()

    /**
     * @param command the remote event name (e.g. MusicEvents.BUTTON_SKIP_NEXT).
     * @param channel the native route this delivery arrived on.
     * @param nowUptimeMs caller passes SystemClock.uptimeMillis() (injected for tests).
     * @return true if [command] should be emitted; false if it is a duplicate to drop.
     */
    @Synchronized
    fun shouldEmit(command: String, channel: Channel, nowUptimeMs: Long): Boolean {
        val last = lastByCommand[command]
        if (last != null) {
            val elapsed = nowUptimeMs - last.uptimeMs
            val window = if (channel == last.channel) sameWindowMs else crossWindowMs
            if (elapsed in 0 until window) return false
        }
        lastByCommand[command] = Anchor(channel, nowUptimeMs)
        return true
    }

    companion object {
        /** Broadcast vs in-process delivery skew is tens of ms, occasionally ~100. */
        const val DEFAULT_CROSS_WINDOW_MS = 200L

        /** Same-channel redelivery is near-instant; deliberate same-channel double
         *  presses are >= ~150 ms apart, so they pass. */
        const val DEFAULT_SAME_WINDOW_MS = 80L
    }
}
