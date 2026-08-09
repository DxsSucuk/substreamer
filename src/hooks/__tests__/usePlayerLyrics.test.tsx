/**
 * Fetch policy for player lyrics (plan step 5.3): fetch only while a player
 * surface is on screen AND the app is foreground, fetch the in-progress track
 * when either gate opens, and never mark a track attempted while gated off.
 */
jest.mock('../../store/persistence/lyricsTable', () => ({
  __esModule: true,
  loadLyrics: jest.fn(),
  saveLyrics: jest.fn(),
  clearAllLyrics: jest.fn(),
}));
jest.mock('../../services/subsonicService', () => ({
  __esModule: true,
  getLyricsForTrack: jest.fn(),
}));

import { act, renderHook } from '@testing-library/react-native';

import { appStateStore } from '../../store/appStateStore';
import { lyricsStore } from '../../store/lyricsStore';
import { usePlayerLyrics } from '../usePlayerLyrics';

import { type LyricsData } from '../../services/subsonicService';

const LYRICS: LyricsData = {
  synced: false,
  lines: [{ startMs: 0, text: 'la' }],
  offsetMs: 0,
  source: 'classic',
};

const fetchLyrics = jest.fn(
  async (_trackId: string, _artist?: string, _title?: string): Promise<LyricsData | null> => null,
);

/** Drive the store transitions a real fetch makes: loading on, then loading off. */
const settleFetch = (trackId: string, outcome?: { entry?: LyricsData; error?: 'error' }) => {
  act(() => {
    lyricsStore.setState({ loading: { [trackId]: true } });
  });
  act(() => {
    lyricsStore.setState({
      loading: {},
      entries: outcome?.entry ? { [trackId]: outcome.entry } : {},
      errors: outcome?.error ? { [trackId]: outcome.error } : {},
    });
  });
};

const setUp = (initialProps: { trackId: string | null; enabled: boolean }) =>
  renderHook(
    ({ trackId, enabled }: { trackId: string | null; enabled: boolean }) =>
      usePlayerLyrics(trackId, 'Artist', 'Title', enabled),
    { initialProps },
  );

beforeEach(() => {
  fetchLyrics.mockClear();
  lyricsStore.setState({ entries: {}, loading: {}, errors: {}, fetchLyrics });
  appStateStore.setState({ isActive: true });
});

describe('usePlayerLyrics — the open-player gate', () => {
  it('fetches once on mount when the player is open and the app is foreground', () => {
    setUp({ trackId: 't1', enabled: true });

    expect(fetchLyrics).toHaveBeenCalledTimes(1);
    expect(fetchLyrics).toHaveBeenCalledWith('t1', 'Artist', 'Title');
  });

  it('never fetches while gated off — not on mount, not across track changes', () => {
    const { rerender } = setUp({ trackId: 't1', enabled: false });
    expect(fetchLyrics).not.toHaveBeenCalled();

    rerender({ trackId: 't2', enabled: false });
    rerender({ trackId: 't3', enabled: false });

    expect(fetchLyrics).not.toHaveBeenCalled();
  });

  it('fetches the already-playing track exactly once when the gate opens', () => {
    const { rerender } = setUp({ trackId: 't1', enabled: false });
    expect(fetchLyrics).not.toHaveBeenCalled();

    rerender({ trackId: 't1', enabled: true });

    expect(fetchLyrics).toHaveBeenCalledTimes(1);
    expect(fetchLyrics).toHaveBeenCalledWith('t1', 'Artist', 'Title');

    // The fetch settling with no lyrics must not re-arm the effect.
    settleFetch('t1');
    expect(fetchLyrics).toHaveBeenCalledTimes(1);
  });

  it('does not re-fetch when the gate closes and reopens on the same track', () => {
    const { rerender } = setUp({ trackId: 't1', enabled: true });
    expect(fetchLyrics).toHaveBeenCalledTimes(1);

    rerender({ trackId: 't1', enabled: false });
    rerender({ trackId: 't1', enabled: true });

    expect(fetchLyrics).toHaveBeenCalledTimes(1);
  });

  it('fetches each new track once while the player stays open', () => {
    const { rerender } = setUp({ trackId: 't1', enabled: true });
    settleFetch('t1', { entry: LYRICS });

    rerender({ trackId: 't2', enabled: true });

    expect(fetchLyrics).toHaveBeenCalledTimes(2);
    expect(fetchLyrics).toHaveBeenLastCalledWith('t2', 'Artist', 'Title');
  });

  it('fetches a lyric-less track once per mount, not once per loading cycle', () => {
    setUp({ trackId: 't1', enabled: true });
    expect(fetchLyrics).toHaveBeenCalledTimes(1);

    // No entry, no error — the "server has no lyrics" outcome (no negative cache).
    settleFetch('t1');

    expect(fetchLyrics).toHaveBeenCalledTimes(1);
  });

  it('leaves a track gated off unpoisoned — it still fetches after two skips', () => {
    const { rerender } = setUp({ trackId: 't1', enabled: false });
    rerender({ trackId: 't2', enabled: false });
    rerender({ trackId: 't3', enabled: false });
    expect(fetchLyrics).not.toHaveBeenCalled();

    rerender({ trackId: 't3', enabled: true });

    expect(fetchLyrics).toHaveBeenCalledTimes(1);
    expect(fetchLyrics).toHaveBeenCalledWith('t3', 'Artist', 'Title');
  });

  it('does not fetch without a track, and reports empty state', () => {
    const { result } = setUp({ trackId: null, enabled: true });

    expect(fetchLyrics).not.toHaveBeenCalled();
    expect(result.current.entry).toBeUndefined();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('does not re-fetch a track already cached in the store', () => {
    lyricsStore.setState({ entries: { t1: LYRICS } });

    const { result } = setUp({ trackId: 't1', enabled: true });

    expect(fetchLyrics).not.toHaveBeenCalled();
    expect(result.current.entry).toBe(LYRICS);
  });

  it('does not fetch a track whose fetch is already in flight', () => {
    lyricsStore.setState({ loading: { t1: true } });

    const { result } = setUp({ trackId: 't1', enabled: true });

    expect(fetchLyrics).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(true);
  });
});

describe('usePlayerLyrics — the foreground gate', () => {
  it('does not fetch on a track change while backgrounded, then fetches on return', () => {
    const { rerender } = setUp({ trackId: 't1', enabled: true });
    settleFetch('t1', { entry: LYRICS });
    expect(fetchLyrics).toHaveBeenCalledTimes(1);

    act(() => {
      appStateStore.setState({ isActive: false });
    });
    rerender({ trackId: 't2', enabled: true });
    expect(fetchLyrics).toHaveBeenCalledTimes(1);

    act(() => {
      appStateStore.setState({ isActive: true });
    });

    expect(fetchLyrics).toHaveBeenCalledTimes(2);
    expect(fetchLyrics).toHaveBeenLastCalledWith('t2', 'Artist', 'Title');
  });

  it('does not fetch on mount while backgrounded', () => {
    appStateStore.setState({ isActive: false });

    setUp({ trackId: 't1', enabled: true });

    expect(fetchLyrics).not.toHaveBeenCalled();
  });
});

describe('usePlayerLyrics — retry', () => {
  it('fetches on retry regardless of the gate', () => {
    const { result } = setUp({ trackId: 't1', enabled: false });

    act(() => {
      result.current.handleRetry();
    });

    expect(fetchLyrics).toHaveBeenCalledTimes(1);
    expect(fetchLyrics).toHaveBeenCalledWith('t1', 'Artist', 'Title');
  });

  it('does not double-fetch when a retry settles into an error', () => {
    const { result } = setUp({ trackId: 't1', enabled: true });
    expect(fetchLyrics).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.handleRetry();
    });
    expect(fetchLyrics).toHaveBeenCalledTimes(2);

    settleFetch('t1', { error: 'error' });

    expect(fetchLyrics).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe('error');
  });

  it('is a no-op without a track', () => {
    const { result } = setUp({ trackId: null, enabled: true });

    act(() => {
      result.current.handleRetry();
    });

    expect(fetchLyrics).not.toHaveBeenCalled();
  });
});
