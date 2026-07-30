import type { AlbumID3, ArtistID3, Playlist } from 'subsonic-api';

import { sortAlbumsByPreference, sortArtistsByName, sortPlaylistsByName } from '../librarySort';

const album = (id: string, name: string, artist: string, extra: Partial<AlbumID3> = {}): AlbumID3 =>
  ({ id, name, artist, ...extra }) as AlbumID3;

describe('sortAlbumsByPreference', () => {
  it("sorts by title (article-stripped, accent-folded) when order is 'title'", () => {
    const albums = [album('1', 'The Wall', 'Pink Floyd'), album('2', 'Abbey Road', 'The Beatles')];
    expect(sortAlbumsByPreference(albums, 'title', ['the']).map((a) => a.name)).toEqual([
      'Abbey Road',
      'The Wall', // "The" stripped → "wall" sorts after "abbey road"
    ]);
  });

  it("sorts by artist when order is 'artist'", () => {
    const albums = [album('1', 'Z', 'Zebra'), album('2', 'A', 'Alpha')];
    expect(sortAlbumsByPreference(albums, 'artist').map((a) => a.artist)).toEqual(['Alpha', 'Zebra']);
  });
});

describe('sortArtistsByName', () => {
  it('sorts A-Z, stripping articles', () => {
    const artists = [
      { id: '1', name: 'The Cure' } as ArtistID3,
      { id: '2', name: 'ABBA' } as ArtistID3,
    ];
    expect(sortArtistsByName(artists, ['the']).map((a) => a.name)).toEqual(['ABBA', 'The Cure']);
  });
});

describe('sortPlaylistsByName', () => {
  it('sorts A-Z by name', () => {
    const playlists = [
      { id: '1', name: 'Roadtrip' } as Playlist,
      { id: '2', name: 'Chill' } as Playlist,
    ];
    expect(sortPlaylistsByName(playlists).map((p) => p.name)).toEqual(['Chill', 'Roadtrip']);
  });
});
