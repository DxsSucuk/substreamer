import type { AlbumID3, ArtistID3, Playlist } from 'subsonic-api';

import {
  byTitle,
  sortAlbumsBy,
  sortAlbumsByPreference,
  sortArtistsByName,
  sortPlaylistsByName,
} from '../librarySort';

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

/** The browse rows hold the same three keys under SQL column names, so the projecting
 *  form is what lets a list sort its whole row set and convert only the rows it draws. */
describe('sortAlbumsBy', () => {
  interface Row {
    id: string;
    name: string | null;
    display_artist: string | null;
    sort_name: string | null;
  }
  const row = (id: string, name: string, artist: string, sortName?: string): Row => ({
    id,
    name,
    display_artist: artist,
    sort_name: sortName ?? null,
  });
  const keys = (r: Row) => ({
    id: r.id,
    name: r.name ?? '',
    artist: r.display_artist ?? undefined,
    sortName: r.sort_name ?? undefined,
  });

  it('sorts on the projected keys, not on the item itself', () => {
    const rows = [row('1', 'Z', 'Zebra'), row('2', 'A', 'Alpha')];
    expect(sortAlbumsBy(rows, keys, 'artist').map((r) => r.id)).toEqual(['2', '1']);
  });

  it("honours the projected sortName under the 'title' order", () => {
    // The server's sort name wins over the display name, exactly as the envelope form does.
    const rows = [row('1', 'The Wall', 'Pink Floyd', 'aaa'), row('2', 'Abbey Road', 'Beatles')];
    expect(sortAlbumsBy(rows, keys, 'title').map((r) => r.id)).toEqual(['1', '2']);
  });

  it('strips articles from the projected keys', () => {
    const rows = [row('1', 'The Cure Album', 'The Zebra'), row('2', 'B', 'Alpha')];
    expect(sortAlbumsBy(rows, keys, 'artist', ['the']).map((r) => r.id)).toEqual(['2', '1']);
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

  it('sorts a browse row, whose name is nullable, without widening it first', () => {
    const rows = [
      { id: '1', name: 'Roadtrip' as string | null },
      { id: '2', name: null as string | null },
      { id: '3', name: 'Chill' as string | null },
    ];
    // A null name sorts as empty — the same answer `playlistListRowToPlaylist` produces.
    expect(sortPlaylistsByName(rows).map((p) => p.id)).toEqual(['2', '3', '1']);
  });
});

describe('byTitle', () => {
  it('orders by title', () => {
    expect([{ title: 'Zulu' }, { title: 'Alpha' }].sort(byTitle).map((s) => s.title)).toEqual([
      'Alpha',
      'Zulu',
    ]);
  });

  it('treats a missing title as empty rather than throwing', () => {
    expect([{ title: 'Alpha' }, {}].sort(byTitle).map((s) => s.title)).toEqual([undefined, 'Alpha']);
    expect(byTitle({}, {})).toBe(0);
  });
});
