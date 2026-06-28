import { playerStore } from '../store/playerStore';

/**
 * Derives the player's coarse playback flags from playerStore — the same
 * derivation every player surface needs. `isPlaying` treats buffering as
 * playing (so the pause icon stays shown); `isBuffering` covers the
 * buffering / loading transition (for the spinner).
 */
export function usePlaybackState() {
  const playbackState = playerStore((s) => s.playbackState);
  const isPlaying = playbackState === 'playing' || playbackState === 'buffering';
  const isBuffering = playbackState === 'buffering' || playbackState === 'loading';
  return { playbackState, isPlaying, isBuffering };
}
