import { getProtectedPlaylistIds } from '../protectedIds';
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

beforeEach(() => {
  db().runSync('DELETE FROM cached_item_songs');
  db().runSync('DELETE FROM cached_items');
  db().runSync('DELETE FROM cached_songs');
});

describe('getProtectedPlaylistIds', () => {
  it('returns an empty set when nothing is downloaded', async () => {
    expect((await getProtectedPlaylistIds(db())).size).toBe(0);
  });

  it('collects downloaded playlists and nothing else', async () => {
    seedItem('pl1', 'playlist');
    seedItem('alb1', 'album');
    seedItem('song:s1', 'song', 'albX');
    const ids = await getProtectedPlaylistIds(db());
    expect([...ids]).toEqual(['pl1']);
  });

  it('propagates a read failure instead of reporting "nothing is protected"', async () => {
    const handle = db();
    const spy = jest.spyOn(handle, 'getAllAsync').mockRejectedValue(new Error('db down'));
    await expect(getProtectedPlaylistIds(handle)).rejects.toThrow('db down');
    spy.mockRestore();
  });
});
