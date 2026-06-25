import {
  coverArtForAlbum,
  coverArtForArtist,
  coverArtForEntity,
  coverArtForPlaylist,
  coverArtForSong,
} from '../coverArtId';
import {
  type AlbumID3,
  type ArtistID3,
  type Child,
  type Playlist,
} from '../../services/subsonicService';

/**
 * The single rule (#202): cover-art keys off the entity's `coverArt` VALUE,
 * NEVER the entity id. Songs additionally pick album-vs-own coverArt by mode.
 */
describe('coverArtId helpers', () => {
  it('coverArtForAlbum returns the coverArt value, never the id', () => {
    expect(coverArtForAlbum({ id: 'al-1', coverArt: 'cover-xyz' } as AlbumID3)).toBe('cover-xyz');
  });

  it('coverArtForArtist returns the coverArt value, never the id', () => {
    expect(coverArtForArtist({ id: 'ar-1', coverArt: 'cover-xyz' } as ArtistID3)).toBe('cover-xyz');
  });

  it('coverArtForPlaylist returns the coverArt value, never the id', () => {
    expect(coverArtForPlaylist({ id: 'pl-1', coverArt: 'cover-xyz' } as Playlist)).toBe('cover-xyz');
  });

  it('returns undefined when the entity has no coverArt', () => {
    expect(coverArtForAlbum({ id: 'al-1' } as AlbumID3)).toBeUndefined();
    expect(coverArtForArtist({ id: 'ar-1' } as ArtistID3)).toBeUndefined();
    expect(coverArtForPlaylist({ id: 'pl-1' } as Playlist)).toBeUndefined();
  });

  describe('coverArtForSong', () => {
    const song = { id: 's-1', albumId: 'al-1', coverArt: 'mf-9' } as Child;

    it('album mode resolves the parent album coverArt via the lookup', () => {
      const lookup = (id: string | null | undefined) => (id === 'al-1' ? 'album-cover' : undefined);
      expect(coverArtForSong(song, 'album', lookup)).toBe('album-cover');
    });

    it('album mode falls back to the song coverArt when the album is not cached', () => {
      expect(coverArtForSong(song, 'album', () => undefined)).toBe('mf-9');
    });

    it('per-track mode always returns the song coverArt, ignoring the album', () => {
      const lookup = () => 'album-cover';
      expect(coverArtForSong(song, 'perTrack', lookup)).toBe('mf-9');
    });

    it('returns undefined when the song has neither resolvable album nor own coverArt', () => {
      expect(coverArtForSong({ id: 's-2', albumId: 'al-2' } as Child, 'album', () => undefined)).toBeUndefined();
    });
  });

  describe('coverArtForEntity dispatch', () => {
    const lookup = (id: string | null | undefined) => (id === 'al-1' ? 'album-cover' : undefined);

    it('treats an entity with albumId as a song (mode-aware)', () => {
      const song = { id: 's-1', albumId: 'al-1', coverArt: 'mf-9' } as Child;
      expect(coverArtForEntity(song, 'album', lookup)).toBe('album-cover');
      expect(coverArtForEntity(song, 'perTrack', lookup)).toBe('mf-9');
    });

    it('treats an entity without albumId as coverArt-keyed (album/artist/playlist)', () => {
      const album = { id: 'al-2', coverArt: 'al-cover' } as AlbumID3;
      const artist = { id: 'ar-2', coverArt: 'ar-cover' } as ArtistID3;
      const playlist = { id: 'pl-2', coverArt: 'pl-cover' } as Playlist;
      expect(coverArtForEntity(album, 'album', lookup)).toBe('al-cover');
      expect(coverArtForEntity(artist, 'album', lookup)).toBe('ar-cover');
      expect(coverArtForEntity(playlist, 'album', lookup)).toBe('pl-cover');
    });
  });
});
