import {
  coverArtIdForAlbum,
  coverArtIdForArtist,
  coverArtIdForEntity,
  coverArtIdForPlaylist,
  coverArtIdForSong,
} from '../coverArtId';
import {
  type AlbumID3,
  type ArtistID3,
  type Child,
  type Playlist,
} from '../../services/subsonicService';

/**
 * The single rule: cover-art keys off the entity ID, NEVER the server
 * `coverArt` field. These tests pin that — every helper must ignore a
 * (deliberately different) `coverArt` value and return the ID.
 */
describe('coverArtId helpers', () => {
  it('coverArtIdForAlbum returns the album id, ignoring coverArt', () => {
    const album = { id: 'al-1', coverArt: 'cover-xyz' } as AlbumID3;
    expect(coverArtIdForAlbum(album)).toBe('al-1');
  });

  it('coverArtIdForArtist returns the artist id, ignoring coverArt', () => {
    const artist = { id: 'ar-1', coverArt: 'cover-xyz' } as ArtistID3;
    expect(coverArtIdForArtist(artist)).toBe('ar-1');
  });

  it('coverArtIdForPlaylist returns the playlist id, ignoring coverArt', () => {
    const playlist = { id: 'pl-1', coverArt: 'cover-xyz' } as Playlist;
    expect(coverArtIdForPlaylist(playlist)).toBe('pl-1');
  });

  it('coverArtIdForSong returns the parent albumId, ignoring coverArt', () => {
    const song = { id: 's-1', albumId: 'al-1', coverArt: 'mf-9' } as Child;
    expect(coverArtIdForSong(song)).toBe('al-1');
  });

  it('coverArtIdForSong falls back to the song id when no albumId (orphan)', () => {
    const song = { id: 's-1', coverArt: 'mf-9' } as Child;
    expect(coverArtIdForSong(song)).toBe('s-1');
  });

  it('returns undefined when the entity has no usable id', () => {
    expect(coverArtIdForAlbum({ coverArt: 'c' } as AlbumID3)).toBeUndefined();
    expect(coverArtIdForSong({ coverArt: 'c' } as unknown as Child)).toBeUndefined();
  });

  describe('coverArtIdForEntity dispatch', () => {
    it('treats an entity with albumId as a song (albumId wins)', () => {
      const song = { id: 's-1', albumId: 'al-1', coverArt: 'mf-9' } as Child;
      expect(coverArtIdForEntity(song)).toBe('al-1');
    });

    it('treats an entity without albumId as id-keyed (album/artist/playlist)', () => {
      const album = { id: 'al-2', coverArt: 'al-cover' } as AlbumID3;
      const artist = { id: 'ar-2', coverArt: 'ar-cover' } as ArtistID3;
      const playlist = { id: 'pl-2', coverArt: 'pl-cover' } as Playlist;
      expect(coverArtIdForEntity(album)).toBe('al-2');
      expect(coverArtIdForEntity(artist)).toBe('ar-2');
      expect(coverArtIdForEntity(playlist)).toBe('pl-2');
    });
  });
});
