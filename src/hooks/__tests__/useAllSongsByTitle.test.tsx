jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

import { act, renderHook, waitFor } from '@testing-library/react-native';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { songSortKeys } from '../../db/sortKeys';
import { getDb } from '../../store/persistence/db';
import { layoutPreferencesStore } from '../../store/layoutPreferencesStore';
import { musicCacheStore } from '../../store/musicCacheStore';
import { useAllSongsByTitle } from '../useAllSongsByTitle';

const db = () => getDb()!;

/** Writes the `sort_*` keys through the same derivation the download writer uses — the
 *  read ORDERs BY them now, so a seed without them would order on NULLs and pass on the
 *  `song_id` tiebreak alone. */
const seedCachedSong = (
  id: string,
  title: string,
  extra: {
    artist?: string;
    albumId?: string;
    coverArt?: string;
    duration?: number;
    sortName?: string;
  } = {},
): void => {
  const keys = songSortKeys({ title, artist: extra.artist, sortName: extra.sortName });
  db().runSync(
    'INSERT INTO cached_songs (song_id, album_id, suffix, bytes, format_captured_at, ' +
      'downloaded_at, title, duration, artist, cover_art, sort_name, sort_title, sort_artist) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
      extra.sortName ?? null,
      keys.sort_title,
      keys.sort_artist,
    ],
  );
};

beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(() => {
  db().runSync('DELETE FROM cached_item_songs');
  db().runSync('DELETE FROM cached_songs');
  musicCacheStore.setState({ revision: 0 } as never);
  layoutPreferencesStore.setState({ songSortOrder: 'title' });
});

describe('useAllSongsByTitle', () => {
  it('returns nothing when the downloaded filter is off, and never reads the table', async () => {
    seedCachedSong('s1', 'Alpha');
    const { result } = renderHook(() => useAllSongsByTitle());
    expect(result.current.rows).toEqual([]);
    expect(result.current.totalCount).toBe(0);
    // The short-circuit is the point: the unfiltered Songs tab pages `songs` and must not
    // pay for a whole-set read of the download table.
    expect(result.current.loading).toBe(false);
    await act(async () => {});
    expect(result.current.rows).toEqual([]);
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

  it('returns the downloaded set in title order', async () => {
    // Ids run OPPOSITE to the titles, so the `song_id` tiebreak alone gives the other
    // answer — this fails if the ORDER BY is dropped.
    seedCachedSong('s1', 'Zulu');
    seedCachedSong('s2', 'Alpha');
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(result.current.rows.map((r) => r.title)).toEqual(['Alpha', 'Zulu']);
    expect(result.current.totalCount).toBe(2);
  });

  it('follows the song sort preference into the query', async () => {
    layoutPreferencesStore.setState({ songSortOrder: 'artist' });
    seedCachedSong('s1', 'Alpha', { artist: 'Zebra' });
    seedCachedSong('s2', 'Zulu', { artist: 'Alpaca' });
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(result.current.rows.map((r) => r.id)).toEqual(['s2', 's1']);
  });

  it('RE-READS when the preference changes — the ORDER BY is the DB\'s now', async () => {
    seedCachedSong('s1', 'Zulu', { artist: 'Alpaca' });
    seedCachedSong('s2', 'Alpha', { artist: 'Zebra' });
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(['s2', 's1']));

    await act(async () => {
      layoutPreferencesStore.setState({ songSortOrder: 'artist' });
    });
    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(['s1', 's2']));
  });

  it('returns the ROWS, keys included, not a parallel array of envelopes', async () => {
    // The rows go straight to `SongListView`, which converts one per RENDERED row and
    // letters the scroller off `sort_title`/`sort_artist`. A hook that mapped here would
    // re-map the whole array on every read AND throw away the key it just ordered by.
    seedCachedSong('s1', 'Alpha', {
      artist: 'Artist A',
      albumId: 'dir-1',
      coverArt: 'cov-1',
      duration: 42,
      sortName: 'Alpha Sorted',
    });
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.rows[0]).toEqual({
      id: 's1',
      title: 'Alpha',
      artist: 'Artist A',
      album_id: 'dir-1',
      duration: 42,
      cover_art: 'cov-1',
      sort_name: 'Alpha Sorted',
      sort_title: 'alpha sorted',
      sort_artist: 'artist a',
    });
  });

});

describe('useAllSongsByTitle — the loading flag is real now', () => {
  it('is loading on the FIRST render, before the SQL read resolves', () => {
    seedCachedSong('s1', 'Alpha');
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    // The read runs in an effect. Without this frame reporting loading, the list view
    // renders an empty, non-loading frame and flashes "No songs found".
    expect(result.current).toMatchObject({ rows: [], loading: true });
  });

  it('clears loading once the read lands, even when the set is empty', async () => {
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows).toEqual([]);
  });

  it('never reports loading while the filter is off', async () => {
    const { result, rerender } = renderHook(
      ({ on }: { on: boolean }) => useAllSongsByTitle({ downloadedOnly: on }),
      { initialProps: { on: true } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ on: false });
    // A stale `loadedKey` must not leak a spinner into the unfiltered list.
    expect(result.current.loading).toBe(false);
  });
});

describe('useAllSongsByTitle — reactivity on musicCacheStore.revision', () => {
  it('re-reads when a download completes', async () => {
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows).toEqual([]);

    seedCachedSong('s1', 'Alpha');
    // SQL has no Zustand subscription; `revision` is the only signal this read gets.
    await act(async () => {
      musicCacheStore.setState({ revision: 1 } as never);
    });
    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(['s1']));
  });

  it('re-reads when a download is deleted', async () => {
    seedCachedSong('s1', 'Alpha');
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));

    db().runSync('DELETE FROM cached_songs');
    await act(async () => {
      musicCacheStore.setState({ revision: 1 } as never);
    });
    await waitFor(() => expect(result.current.rows).toEqual([]));
  });

  it('keeps the previous rows on screen while the re-read is in flight', async () => {
    // The step-3 trade: a bump means "re-read", not "you know nothing" — blanking a
    // populated list on every completing download would be worse than a stale frame.
    seedCachedSong('s1', 'Alpha');
    const frames: { count: number; loading: boolean }[] = [];
    const { result } = renderHook(() => {
      const r = useAllSongsByTitle({ downloadedOnly: true });
      frames.push({ count: r.rows.length, loading: r.loading });
      return r;
    });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));

    seedCachedSong('s2', 'Bravo');
    frames.length = 0;
    await act(async () => {
      musicCacheStore.setState({ revision: 1 } as never);
    });
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(frames.filter((f) => f.count === 0)).toEqual([]);
  });

  it('refresh() re-reads without a revision bump', async () => {
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows).toEqual([]);

    // Pull-to-refresh is wired to this; a no-op stub would leave the list stale.
    seedCachedSong('s1', 'Alpha');
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(['s1']));
  });
});
