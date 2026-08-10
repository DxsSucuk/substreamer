/**
 * `childSnapshotArrayCommands` against the REAL NOT NULL child columns, for BOTH
 * consumers of the shared builder.
 *
 * `cached_song_genres.name`, `cached_song_moods.mood` and
 * `cached_song_contributors.role` are NOT NULL (and so are their `scrobble_*`
 * twins), so a server sending `moods: [null]`, a blank genre or a role-less
 * contributor aborts the whole batch — losing the row, not just the entry. The
 * shared builder guards both tables at once, so both are asserted here.
 *
 * Per AGENTS.md §11 the seam proves SQL semantics, never concurrency.
 */
import type { Child } from 'subsonic-api';

import { getDb, type InternalDb } from '@/store/persistence/db';

import { childSnapshotArrayCommands } from '../childSnapshot';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite seam failed to open');
const realDb: InternalDb = handle;

/** Every shape a NOT NULL child column rejects, interleaved with good entries so a
 *  blanket "skip the array" fix fails and `pos` contiguity is observable. */
const hostileChild = {
  id: 'x-1',
  title: 'Hostile',
  isDir: false,
  genres: [{ name: 'Rock' }, { name: '' }, null, 'Indie'],
  artists: [{ id: 'ar-1', name: 'One' }, null, { id: 'ar-2', name: 'Two' }],
  albumArtists: [null, { id: 'ar-3', name: 'Three' }],
  contributors: [
    { role: '', artist: { id: 'ar-9', name: 'Blank Role' } },
    { role: 'producer', artist: { id: 'ar-4', name: 'Producer' } },
    { subRole: 'assistant' },
    { role: 'engineer' },
  ],
  moods: [null, 'calm', '', undefined, 'late night'],
} as unknown as Child;

const write = async (tablePrefix: string, keyColumn: string, keyValue: string): Promise<void> => {
  await realDb.runAtomicBatchAsync(
    childSnapshotArrayCommands({
      tablePrefix,
      key: { [keyColumn]: keyValue },
      child: hostileChild,
    }),
  );
};

const rows = <T,>(table: string, keyColumn: string, keyValue: string): T[] =>
  realDb.getAllSync<T>(`SELECT * FROM ${table} WHERE ${keyColumn} = ? ORDER BY pos;`, [keyValue]);

beforeEach(() => {
  realDb.runSync('DELETE FROM scrobble_events;');
  realDb.runSync('DELETE FROM cached_songs;');
});

describe('childSnapshotArrayCommands — NOT NULL child columns, scrobble_*', () => {
  beforeEach(async () => {
    realDb.runSync(
      "INSERT INTO scrobble_events (id, time, song_id, title) VALUES ('sc-1', 1, 'x-1', 'Hostile');",
    );
    await write('scrobble', 'scrobble_id', 'sc-1');
  });

  it('keeps the good entries and skips only the bad ones, with pos contiguous', () => {
    expect(rows('scrobble_genres', 'scrobble_id', 'sc-1')).toEqual([
      { scrobble_id: 'sc-1', pos: 0, name: 'Rock' },
      { scrobble_id: 'sc-1', pos: 1, name: 'Indie' },
    ]);
    expect(rows('scrobble_moods', 'scrobble_id', 'sc-1')).toEqual([
      { scrobble_id: 'sc-1', pos: 0, mood: 'calm' },
      { scrobble_id: 'sc-1', pos: 1, mood: 'late night' },
    ]);
    expect(rows('scrobble_contributors', 'scrobble_id', 'sc-1')).toEqual([
      {
        scrobble_id: 'sc-1',
        pos: 0,
        role: 'producer',
        sub_role: null,
        artist_id: 'ar-4',
        artist_name: 'Producer',
      },
      {
        scrobble_id: 'sc-1',
        pos: 1,
        role: 'engineer',
        sub_role: null,
        artist_id: null,
        artist_name: null,
      },
    ]);
    expect(rows('scrobble_artists', 'scrobble_id', 'sc-1')).toEqual([
      { scrobble_id: 'sc-1', pos: 0, artist_id: 'ar-1', artist_name: 'One' },
      { scrobble_id: 'sc-1', pos: 1, artist_id: 'ar-2', artist_name: 'Two' },
    ]);
    expect(rows('scrobble_album_artists', 'scrobble_id', 'sc-1')).toEqual([
      { scrobble_id: 'sc-1', pos: 0, artist_id: 'ar-3', artist_name: 'Three' },
    ]);
  });
});

describe('childSnapshotArrayCommands — NOT NULL child columns, cached_song_*', () => {
  beforeEach(async () => {
    realDb.runSync(
      `INSERT INTO cached_songs
         (song_id, album_id, suffix, bytes, format_captured_at, downloaded_at, title, duration)
         VALUES ('x-1', 'al-1', 'mp3', 1, 1, 1, 'Hostile', 100);`,
    );
    await write('cached_song', 'song_id', 'x-1');
  });

  it('keeps the good entries and skips only the bad ones, with pos contiguous', () => {
    expect(rows('cached_song_genres', 'song_id', 'x-1')).toEqual([
      { song_id: 'x-1', pos: 0, name: 'Rock' },
      { song_id: 'x-1', pos: 1, name: 'Indie' },
    ]);
    expect(rows('cached_song_moods', 'song_id', 'x-1')).toEqual([
      { song_id: 'x-1', pos: 0, mood: 'calm' },
      { song_id: 'x-1', pos: 1, mood: 'late night' },
    ]);
    expect(
      rows<{ role: string; artist_name: string | null }>(
        'cached_song_contributors',
        'song_id',
        'x-1',
      ).map((r) => [r.role, r.artist_name]),
    ).toEqual([
      ['producer', 'Producer'],
      ['engineer', null],
    ]);
    expect(
      rows<{ artist_id: string }>('cached_song_artists', 'song_id', 'x-1').map((r) => r.artist_id),
    ).toEqual(['ar-1', 'ar-2']);
    expect(
      rows<{ artist_id: string }>('cached_song_album_artists', 'song_id', 'x-1').map(
        (r) => r.artist_id,
      ),
    ).toEqual(['ar-3']);
  });
});
