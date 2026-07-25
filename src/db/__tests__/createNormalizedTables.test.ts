import { getDb } from '../../store/persistence/db';
import { ensureNormalizedSchema } from '../createNormalizedTables';

const NORMALIZED_TABLES = [
  'songs',
  'albums',
  'artists',
  'playlists',
  'song_genres',
  'song_artists',
  'song_album_artists',
  'song_contributors',
  'song_moods',
  'album_genres',
  'album_artists',
  'album_release_types',
  'album_moods',
  'album_record_labels',
  'album_disc_titles',
  'artist_roles',
  'artist_similar',
  'playlist_songs',
  'playlist_allowed_users',
];

describe('ensureNormalizedSchema', () => {
  it('creates every normalized table and is idempotent', () => {
    const db = getDb();
    expect(db).not.toBeNull();
    ensureNormalizedSchema(db!);
    ensureNormalizedSchema(db!); // second run must be a no-op, not a throw

    const tables = db!
      .getAllSync<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .map((r) => r.name);
    for (const t of NORMALIZED_TABLES) {
      expect(tables).toContain(t);
    }
  });

  it('creates the keyset + favorites indexes on songs', () => {
    const db = getDb();
    ensureNormalizedSchema(db!);
    const indexes = db!
      .getAllSync<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='songs'",
      )
      .map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_songs_sort', 'idx_songs_album', 'idx_songs_starred']),
    );
  });

  it('round-trips a row through a created table (schema is usable)', () => {
    const db = getDb();
    ensureNormalizedSchema(db!);
    db!.runSync(
      "INSERT OR REPLACE INTO songs (id, title, sort_title, is_video) VALUES ('s1', 'Alpha', 'alpha', 0)",
    );
    const row = db!.getFirstSync<{ id: string; title: string }>(
      "SELECT id, title FROM songs WHERE id = 's1'",
    );
    expect(row?.title).toBe('Alpha');
  });

  it('cascade-deletes children with their parent', () => {
    const db = getDb();
    ensureNormalizedSchema(db!);
    db!.runSync("INSERT OR REPLACE INTO albums (id, name) VALUES ('a1', 'Album One')");
    db!.runSync("INSERT OR REPLACE INTO album_genres (album_id, pos, name) VALUES ('a1', 0, 'Rock')");
    db!.runSync("DELETE FROM albums WHERE id = 'a1'");
    const childCount = db!.getFirstSync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM album_genres WHERE album_id = 'a1'",
    );
    expect(childCount?.n).toBe(0);
  });
});
