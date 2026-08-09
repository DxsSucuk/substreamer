/**
 * The stored A–Z keys. What matters here is the FALLBACK CHAINS: each one decides
 * which letter an entity is filed under when the field the key normally derives from
 * is missing, and a row filed under the wrong letter is invisible to the scroller.
 */
import { albumSortKeys, artistSortTitle, playlistSortTitle, songSortKeys } from '../sortKeys';

describe('albumSortKeys', () => {
  it('prefers the server sortName over the display name for the title key', () => {
    // The artist key never takes a sortName — it strips the article instead.
    expect(albumSortKeys({ name: 'The Wall', sortName: 'Wall' })).toEqual({
      sort_title: 'wall',
      sort_artist: 'wall',
    });
  });

  it('takes displayArtist ahead of artist for the artist key', () => {
    expect(
      albumSortKeys({ name: 'Album', artist: 'Plain', displayArtist: 'Display' }).sort_artist,
    ).toBe('display');
  });

  it('falls back to artist when there is no displayArtist', () => {
    expect(albumSortKeys({ name: 'Album', artist: 'Plain' }).sort_artist).toBe('plain');
  });

  it('files an artist-less album under its own title rather than at the top', () => {
    expect(albumSortKeys({ name: 'Zoo Station' }).sort_artist).toBe('zoo station');
  });

  it('yields empty keys for an album with no name at all', () => {
    expect(albumSortKeys({})).toEqual({ sort_title: '', sort_artist: '' });
  });

  it('strips leading articles, honouring a server-supplied list', () => {
    expect(albumSortKeys({ name: 'Los Lobos' }, ['los']).sort_title).toBe('lobos');
  });
});

describe('songSortKeys', () => {
  it('uses the songs own artist — NOT the album fallback chain', () => {
    expect(songSortKeys({ title: 'Track', artist: 'Guest' })).toEqual({
      sort_title: 'track',
      sort_artist: 'guest',
    });
  });

  it('falls back to the title when the song carries no artist', () => {
    expect(songSortKeys({ title: 'Untitled Instrumental' }).sort_artist).toBe(
      'untitled instrumental',
    );
  });

  it('prefers sortName for the title key, and yields empty keys for a bare row', () => {
    expect(songSortKeys({ title: 'A Horse With No Name', sortName: 'Horse With No Name' })
      .sort_title).toBe('horse with no name');
    expect(songSortKeys({})).toEqual({ sort_title: '', sort_artist: '' });
  });
});

describe('artistSortTitle / playlistSortTitle', () => {
  it('artists prefer sortName and tolerate a missing name', () => {
    expect(artistSortTitle({ name: 'Sinéad OConnor', sortName: 'OConnor Sinead' })).toBe(
      'oconnor sinead',
    );
    expect(artistSortTitle({ name: 'The Beatles' })).toBe('beatles');
    expect(artistSortTitle({})).toBe('');
  });

  it('playlists have no server sortName, so the name is the only input', () => {
    expect(playlistSortTitle({ name: 'The Road Trip' })).toBe('road trip');
    expect(playlistSortTitle({})).toBe('');
  });
});
