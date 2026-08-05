jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

import React from 'react';
import { render, act, waitFor } from '@testing-library/react-native';

const mockPlayTrack = jest.fn();
jest.mock('../../services/playerService', () => ({ playTrack: (...a: unknown[]) => mockPlayTrack(...a) }));

// The list views are exercised by their own suites; stub them down to the props under test.
let songProps: {
  songs: { id: string }[];
  onEndReached?: () => void;
  onSongPress?: (s: unknown) => void;
  showAlphabetScroller?: boolean;
};
jest.mock('../SongListView', () => ({
  SongListView: (p: typeof songProps) => {
    songProps = p;
    return null;
  },
}));

import type { Child } from 'subsonic-api';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { markStarredSongs, replaceFavoriteSongs } from '../../db/repository/favorites';
import { upsertSongs } from '../../db/repository/songs';
import { getDb } from '../../store/persistence/db';
import { favoritesStore } from '../../store/favoritesStore';
import { StarredSongList } from '../StarredSongList';

const db = () => getDb()!;
const song = (id: string, extra: Partial<Child> = {}): Child =>
  ({ id, title: `Song ${id}`, isDir: false, duration: 10, ...extra }) as Child;

beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(async () => {
  mockPlayTrack.mockClear();
  for (const t of ['songs', 'favorite_songs', 'cached_songs']) db().runSync(`DELETE FROM ${t}`);
  favoritesStore.setState({ version: 0 });
  await upsertSongs(db(), [song('lib-a'), song('lib-b')]);
  await markStarredSongs(db(), [
    { id: 'lib-a', starredAt: 400 },
    { id: 'lib-b', starredAt: 200 },
  ]);
  await replaceFavoriteSongs(db(), [song('rem-a', { starred: new Date(300) })]);
});

const renderList = () =>
  render(<StarredSongList downloadedOnly={false} includePartial={false} />);

describe('StarredSongList', () => {
  it('renders the merged first page, newest favourite first', async () => {
    renderList();
    await waitFor(() => expect(songProps.songs).toHaveLength(3));
    expect(songProps.songs.map((s) => s.id)).toEqual(['lib-a', 'rem-a', 'lib-b']);
  });

  it('appends the next page on loadMore, across both halves', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => song(`s${String(i).padStart(3, '0')}`));
    db().runSync('DELETE FROM songs');
    await upsertSongs(db(), rows);
    await markStarredSongs(
      db(),
      rows.map((r, i) => ({ id: r.id, starredAt: 10_000 - i })),
    );
    renderList();
    await waitFor(() => expect(songProps.songs).toHaveLength(120));

    await act(async () => {
      songProps.onEndReached?.();
    });
    await waitFor(() => expect(songProps.songs.length).toBeGreaterThan(120));
  });

  it('reloads when the membership version bumps', async () => {
    renderList();
    await waitFor(() => expect(songProps.songs).toHaveLength(3));

    db().runSync("DELETE FROM songs WHERE id='lib-b'");
    await act(async () => {
      favoritesStore.setState({ version: 1 });
    });
    await waitFor(() => expect(songProps.songs).toHaveLength(2));
  });

  it('moves a newly starred track to the top when the version bumps', async () => {
    renderList();
    await waitFor(() => expect(songProps.songs).toHaveLength(3));

    await upsertSongs(db(), [song('fresh')]);
    await markStarredSongs(db(), [{ id: 'fresh', starredAt: 9_000 }]);
    await act(async () => {
      favoritesStore.setState({ version: 1 });
    });
    await waitFor(() => expect(songProps.songs).toHaveLength(4));
    expect(songProps.songs[0].id).toBe('fresh');
  });

  it('renders no A–Z scroller — the order is recency, not the alphabet', async () => {
    renderList();
    await waitFor(() => expect(songProps.songs).toHaveLength(3));
    expect(songProps.showAlphabetScroller).toBeFalsy();
  });

  it('queues the WHOLE favourites list from a tapped row, starting at that row', async () => {
    renderList();
    await waitFor(() => expect(songProps.songs).toHaveLength(3));

    await act(async () => {
      songProps.onSongPress?.(song('lib-b'));
    });
    await waitFor(() => expect(mockPlayTrack).toHaveBeenCalled());
    const [start, queue] = mockPlayTrack.mock.calls[0] as [Child, Child[]];
    expect(queue.map((s) => s.id)).toEqual(['lib-a', 'rem-a', 'lib-b']);
    expect(start.id).toBe('lib-b');
  });

  it('falls back to the single song when the tapped id is no longer starred', async () => {
    renderList();
    await waitFor(() => expect(songProps.songs).toHaveLength(3));

    await act(async () => {
      songProps.onSongPress?.(song('gone'));
    });
    await waitFor(() => expect(mockPlayTrack).toHaveBeenCalled());
    const [, queue] = mockPlayTrack.mock.calls[0] as [Child, Child[]];
    expect(queue.map((s) => s.id)).toEqual(['gone']);
  });

  it('applies the downloaded filter to both halves', async () => {
    db().runSync(
      'INSERT INTO cached_songs (song_id, album_id, suffix, bytes, format_captured_at, ' +
        'downloaded_at, title, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['rem-a', 'a1', 'mp3', 1, 0, 0, 'T', 10],
    );
    render(<StarredSongList downloadedOnly includePartial={false} />);
    await waitFor(() => expect(songProps.songs.map((s) => s.id)).toEqual(['rem-a']));
  });

  it('queues ONLY downloaded tracks under the downloaded filter', async () => {
    // The offline guarantee is about the QUEUE, not just the list: tapping a row builds
    // the whole favourites queue, and an undownloaded track in it is a row that cannot
    // play. The filter has to reach that build too.
    db().runSync(
      'INSERT INTO cached_songs (song_id, album_id, suffix, bytes, format_captured_at, ' +
        'downloaded_at, title, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['rem-a', 'a1', 'mp3', 1, 0, 0, 'T', 10],
    );
    db().runSync(
      'INSERT INTO cached_songs (song_id, album_id, suffix, bytes, format_captured_at, ' +
        'downloaded_at, title, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['lib-b', 'a1', 'mp3', 1, 0, 0, 'T', 10],
    );
    render(<StarredSongList downloadedOnly includePartial={false} />);
    await waitFor(() => expect(songProps.songs.map((s) => s.id)).toEqual(['rem-a', 'lib-b']));

    await act(async () => {
      songProps.onSongPress?.(song('lib-b'));
    });
    await waitFor(() => expect(mockPlayTrack).toHaveBeenCalled());
    const [start, queue] = mockPlayTrack.mock.calls[0] as [Child, Child[]];
    // `lib-a` is starred but not downloaded — it must not be in the queue.
    expect(queue.map((s) => s.id)).toEqual(['rem-a', 'lib-b']);
    expect(start.id).toBe('lib-b');
  });
});
