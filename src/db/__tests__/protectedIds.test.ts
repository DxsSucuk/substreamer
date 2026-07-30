import { getProtectedIds } from '../protectedIds';
import { getDb } from '../../store/persistence/db';

const db = () => getDb()!;

const seedItem = (itemId: string, type: string, parentAlbumId: string | null = null): void => {
  db().runSync(
    `INSERT OR REPLACE INTO cached_items
       (item_id, type, name, expected_song_count, parent_album_id, last_sync_at, downloaded_at)
     VALUES (?, ?, ?, 0, ?, 0, 0)`,
    [itemId, type, itemId, parentAlbumId],
  );
};
const seedSong = (songId: string, albumId: string): void => {
  db().runSync(
    `INSERT OR REPLACE INTO cached_songs
       (song_id, title, album_id, bytes, duration, suffix, format_captured_at, downloaded_at)
     VALUES (?, ?, ?, 0, 0, 'mp3', 0, 0)`,
    [songId, songId, albumId],
  );
};
const seedEdge = (itemId: string, position: number, songId: string): void => {
  db().runSync(
    'INSERT OR REPLACE INTO cached_item_songs (item_id, position, song_id) VALUES (?, ?, ?)',
    [itemId, position, songId],
  );
};

beforeEach(() => {
  db().runSync('DELETE FROM cached_item_songs');
  db().runSync('DELETE FROM cached_items');
  db().runSync('DELETE FROM cached_songs');
});

describe('getProtectedIds', () => {
  it('returns empty sets when nothing is downloaded', async () => {
    const ids = await getProtectedIds(db());
    expect(ids.downloadedAlbumIds.size).toBe(0);
    expect(ids.parentAlbumIds.size).toBe(0);
    expect(ids.playlistIds.size).toBe(0);
  });

  it('collects downloaded albums and playlists by item type', async () => {
    seedItem('alb1', 'album');
    seedItem('pl1', 'playlist');
    const ids = await getProtectedIds(db());
    expect([...ids.downloadedAlbumIds]).toEqual(['alb1']);
    expect([...ids.playlistIds]).toEqual(['pl1']);
    // A playlist id is not an album id — the two sets must not bleed.
    expect(ids.downloadedAlbumIds.has('pl1')).toBe(false);
  });

  it("collects a downloaded single song's parent album", async () => {
    seedItem('song:s1', 'song', 'albX');
    const ids = await getProtectedIds(db());
    expect([...ids.parentAlbumIds]).toEqual(['albX']);
  });

  it("collects favorited songs' parent albums via the edge table", async () => {
    seedItem('__starred__', 'favorites');
    seedSong('s9', 'albF');
    seedEdge('__starred__', 0, 's9');
    const ids = await getProtectedIds(db());
    expect([...ids.parentAlbumIds]).toEqual(['albF']);
  });

  it("collects a downloaded playlist's member-song parent albums", async () => {
    seedItem('pl1', 'playlist');
    seedSong('s5', 'albP');
    seedEdge('pl1', 0, 's5');
    const ids = await getProtectedIds(db());
    expect([...ids.parentAlbumIds]).toEqual(['albP']);
  });

  it('does not treat an album item as a parent-only album', async () => {
    seedItem('alb1', 'album');
    seedSong('s1', 'alb1');
    seedEdge('alb1', 0, 's1');
    const ids = await getProtectedIds(db());
    // Album items are not in the favorites/playlist UNION, so the parent set stays clear
    // and the album is protected as a full download instead.
    expect(ids.downloadedAlbumIds.has('alb1')).toBe(true);
    expect(ids.parentAlbumIds.has('alb1')).toBe(false);
  });

  it('propagates a read failure instead of reporting "nothing is protected"', async () => {
    const handle = db();
    const spy = jest.spyOn(handle, 'getAllAsync').mockRejectedValue(new Error('db down'));
    await expect(getProtectedIds(handle)).rejects.toThrow('db down');
    spy.mockRestore();
  });
});
