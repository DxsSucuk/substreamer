jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

import { act, renderHook, waitFor } from '@testing-library/react-native';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { getDb } from '../../store/persistence/db';
import { musicCacheStore } from '../../store/musicCacheStore';
import { useAllSongsByTitle } from '../useAllSongsByTitle';

const db = () => getDb()!;

const seedCachedSong = (
  id: string,
  title: string,
  extra: { artist?: string; albumId?: string; coverArt?: string; duration?: number } = {},
): void => {
  db().runSync(
    'INSERT INTO cached_songs (song_id, album_id, suffix, bytes, format_captured_at, ' +
      'downloaded_at, title, duration, artist, cover_art) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      extra.albumId ?? 'al1',
      'mp3',
      1,
      0,
      0,
      title,
      extra.duration ?? 1,
      extra.artist ?? null,
      extra.coverArt ?? null,
    ],
  );
};

beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(() => {
  db().runSync('DELETE FROM cached_item_songs');
  db().runSync('DELETE FROM cached_songs');
  musicCacheStore.setState({ revision: 0 } as never);
});

describe('useAllSongsByTitle', () => {
  it('returns nothing when the downloaded filter is off, and never reads the table', async () => {
    seedCachedSong('s1', 'Alpha');
    const { result } = renderHook(() => useAllSongsByTitle());
    expect(result.current.songs).toEqual([]);
    expect(result.current.totalCount).toBe(0);
    // The short-circuit is the point: the unfiltered Songs tab pages `songs` and must not
    // pay for a whole-set read of the download table.
    expect(result.current.loading).toBe(false);
    await act(async () => {});
    expect(result.current.songs).toEqual([]);
  });

  it('never touches the database while the filter is off', async () => {
    // The short-circuit is load-bearing, not decoration: `FilteredSongList` mounts this
    // hook for the FAVOURITES filter too, and that branch must not pay for a whole-set
    // read of the download table it will not use.
    seedCachedSong('s1', 'Alpha');
    const spy = jest.spyOn(db(), 'getAllAsync');
    renderHook(() => useAllSongsByTitle());
    await act(async () => {});
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('returns the downloaded set title-sorted', async () => {
    seedCachedSong('s2', 'Zulu');
    seedCachedSong('s1', 'Alpha');
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    await waitFor(() => expect(result.current.songs).toHaveLength(2));
    expect(result.current.songs.map((s) => s.title)).toEqual(['Alpha', 'Zulu']);
    expect(result.current.totalCount).toBe(2);
  });

  it('projects the same six fields the map walk did', async () => {
    // Parity, deliberately: `cached_songs` holds ~55 columns and enriching these rows is a
    // separate, user-visible change. A wider projection here would be that change.
    seedCachedSong('s1', 'Alpha', {
      artist: 'Artist A',
      albumId: 'dir-1',
      coverArt: 'cov-1',
      duration: 42,
    });
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    await waitFor(() => expect(result.current.songs).toHaveLength(1));
    expect(result.current.songs[0]).toEqual({
      id: 's1',
      title: 'Alpha',
      artist: 'Artist A',
      albumId: 'dir-1',
      duration: 42,
      coverArt: 'cov-1',
      isDir: false,
    });
  });

  it('leaves the nullable columns undefined rather than null', async () => {
    seedCachedSong('s1', 'Alpha');
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    await waitFor(() => expect(result.current.songs).toHaveLength(1));
    expect(result.current.songs[0].artist).toBeUndefined();
    expect(result.current.songs[0].coverArt).toBeUndefined();
  });

  it('exposes a no-op refresh (the source is the local table, not a fetch)', async () => {
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(() => result.current.refresh()).not.toThrow();
  });
});

describe('useAllSongsByTitle — the loading flag is real now', () => {
  it('is loading on the FIRST render, before the SQL read resolves', () => {
    seedCachedSong('s1', 'Alpha');
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    // The read runs in an effect. Without this frame reporting loading, the list view
    // renders an empty, non-loading frame and flashes "No songs found".
    expect(result.current).toMatchObject({ songs: [], loading: true });
  });

  it('clears loading once the read lands, even when the set is empty', async () => {
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.songs).toEqual([]);
  });

  it('never reports loading while the filter is off', async () => {
    const { result, rerender } = renderHook(
      ({ on }: { on: boolean }) => useAllSongsByTitle({ downloadedOnly: on }),
      { initialProps: { on: true } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ on: false });
    // A stale `loadedRevision` must not leak a spinner into the unfiltered list.
    expect(result.current.loading).toBe(false);
  });
});

describe('useAllSongsByTitle — reactivity on musicCacheStore.revision', () => {
  it('re-reads when a download completes', async () => {
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.songs).toEqual([]);

    seedCachedSong('s1', 'Alpha');
    // SQL has no Zustand subscription; `revision` is the only signal this read gets.
    await act(async () => {
      musicCacheStore.setState({ revision: 1 } as never);
    });
    await waitFor(() => expect(result.current.songs.map((s) => s.id)).toEqual(['s1']));
  });

  it('re-reads when a download is deleted', async () => {
    seedCachedSong('s1', 'Alpha');
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    await waitFor(() => expect(result.current.songs).toHaveLength(1));

    db().runSync('DELETE FROM cached_songs');
    await act(async () => {
      musicCacheStore.setState({ revision: 1 } as never);
    });
    await waitFor(() => expect(result.current.songs).toEqual([]));
  });

  it('keeps the previous rows on screen while the re-read is in flight', async () => {
    // The step-3 trade: a bump means "re-read", not "you know nothing" — blanking a
    // populated list on every completing download would be worse than a stale frame.
    seedCachedSong('s1', 'Alpha');
    const frames: { count: number; loading: boolean }[] = [];
    const { result } = renderHook(() => {
      const r = useAllSongsByTitle({ downloadedOnly: true });
      frames.push({ count: r.songs.length, loading: r.loading });
      return r;
    });
    await waitFor(() => expect(result.current.songs).toHaveLength(1));

    seedCachedSong('s2', 'Bravo');
    frames.length = 0;
    await act(async () => {
      musicCacheStore.setState({ revision: 1 } as never);
    });
    await waitFor(() => expect(result.current.songs).toHaveLength(2));
    expect(frames.filter((f) => f.count === 0)).toEqual([]);
  });
});
