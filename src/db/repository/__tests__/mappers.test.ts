import type { AlbumID3, ArtistID3, Child } from 'subsonic-api';

import { getDb } from '../../../store/persistence/db';
import { ensureNormalizedSchema } from '../../createNormalizedTables';
import { upsertAlbums } from '../albums';
import { upsertArtists } from '../artists';
import { markStarredAlbums, markStarredArtists, markStarredSongs } from '../favorites';
import { albumRow, artistRow, playlistRow, songRow } from '../mappers';
import { upsertSongs } from '../songs';

const db = () => getDb()!;
const song = (id: string, extra: Partial<Child> = {}): Child =>
  ({ id, title: `Song ${id}`, isDir: false, ...extra }) as Child;
const album = (id: string, extra: Partial<AlbumID3> = {}): AlbumID3 =>
  ({ id, name: `Album ${id}`, duration: 0, songCount: 0, ...extra }) as AlbumID3;
const artist = (id: string, extra: Partial<ArtistID3> = {}): ArtistID3 => ({
  id,
  name: `Artist ${id}`,
  albumCount: 0,
  ...extra,
});

beforeAll(() => ensureNormalizedSchema(db()));
beforeEach(() => {
  for (const t of ['songs', 'albums', 'artists']) db().runSync(`DELETE FROM ${t}`);
});

describe('conditional `starred` key', () => {
  it('omits the key entirely when the payload has no starred date', () => {
    expect('starred' in songRow(song('s1'))).toBe(false);
    expect('starred' in albumRow(album('a1'))).toBe(false);
    expect('starred' in artistRow(artist('ar1'))).toBe(false);
  });

  it('includes the epoch when the payload has one', () => {
    expect(songRow(song('s1', { starred: new Date(700) })).starred).toBe(700);
    expect(albumRow(album('a1', { starred: new Date(700) })).starred).toBe(700);
    expect(artistRow(artist('ar1', { starred: new Date(700) })).starred).toBe(700);
  });
});

describe('a library upsert can never CLEAR a mark', () => {
  // `buildUpsertRow` derives both the column list and `DO UPDATE SET` from
  // `Object.keys(row)`, so an omitted key survives; `starred: null` would not.
  it('preserves an existing song mark across an upsert whose payload omits starred', async () => {
    await upsertSongs(db(), [song('s1')]);
    await markStarredSongs(db(), [{ id: 's1', starredAt: 900 }]);
    await upsertSongs(db(), [song('s1', { title: 'Renamed' })]);
    const row = db().getFirstSync<{ title: string; starred: number }>(
      "SELECT title, starred FROM songs WHERE id='s1'",
    );
    expect(row?.title).toBe('Renamed');
    expect(row?.starred).toBe(900);
  });

  it('preserves an existing album mark — the `fetchAlbumDetail` path', async () => {
    await upsertAlbums(db(), [album('al1')]);
    await markStarredAlbums(db(), [{ id: 'al1', starredAt: 800 }]);
    await upsertAlbums(db(), [album('al1', { name: 'Renamed' })]);
    expect(
      db().getFirstSync<{ starred: number }>("SELECT starred FROM albums WHERE id='al1'")?.starred,
    ).toBe(800);
  });

  it('preserves an existing artist mark across an artist-library refresh', async () => {
    await upsertArtists(db(), [artist('ar1')]);
    await markStarredArtists(db(), [{ id: 'ar1', starredAt: 700 }]);
    await upsertArtists(db(), [artist('ar1', { name: 'Renamed' })]);
    expect(
      db().getFirstSync<{ starred: number }>("SELECT starred FROM artists WHERE id='ar1'")?.starred,
    ).toBe(700);
  });

  it('still lets a payload that CARRIES starred set the mark', async () => {
    await upsertSongs(db(), [song('s1')]);
    await upsertSongs(db(), [song('s1', { starred: new Date(500) })]);
    expect(
      db().getFirstSync<{ starred: number }>("SELECT starred FROM songs WHERE id='s1'")?.starred,
    ).toBe(500);
  });

  it('leaves a fresh row NULL when the payload omits starred', async () => {
    await upsertSongs(db(), [song('s1')]);
    expect(
      db().getFirstSync<{ starred: number | null }>("SELECT starred FROM songs WHERE id='s1'")
        ?.starred,
    ).toBeNull();
  });
});

/**
 * Every mapper derives its A–Z keys through `db/sortKeys`, so a filtered list, the
 * download tables and the favourites remainder all file a row in the same place. These
 * pin the derivations themselves — the fallback chains differ PER ENTITY on purpose.
 */
describe('the stored sort keys', () => {
  it('prefers a meaningful server sortName for the album title key', () => {
    expect(albumRow(album('a1', { name: 'The Wall', sortName: 'Zzz Sorted' })).sort_title).toBe(
      'zzz sorted',
    );
    // …and falls back to the article-stripped name when there is none.
    expect(albumRow(album('a2', { name: 'The Wall' })).sort_title).toBe('wall');
  });

  it('takes displayArtist ahead of the artist tag for the album artist key', () => {
    const row = albumRow(album('a1', { artist: 'Tagged', displayArtist: 'Displayed' }));
    expect(row.sort_artist).toBe('displayed');
    expect(albumRow(album('a2', { artist: 'Tagged' })).sort_artist).toBe('tagged');
  });

  it('falls back to the album NAME when an album has no artist at all', () => {
    expect(albumRow(album('a1', { name: 'Orphan' })).sort_artist).toBe('orphan');
  });

  it('derives the song artist key from the song artist, falling back to its TITLE', () => {
    // Deliberately NOT the album chain: a song's scroller reads `artist ?? title`.
    expect(songRow(song('s1', { artist: 'Tagged' })).sort_artist).toBe('tagged');
    expect(songRow(song('s2', { title: 'Lone Track' })).sort_artist).toBe('lone track');
  });

  it('prefers a meaningful sortName for the song title key too', () => {
    expect(songRow(song('s1', { title: 'The Track', sortName: 'Zzz' })).sort_title).toBe('zzz');
    expect(songRow(song('s2', { title: 'The Track' })).sort_title).toBe('track');
  });

  it('uses the artist sortName for the artist key', () => {
    expect(artistRow(artist('ar1', { name: 'U2', sortName: 'You Two' })).sort_title).toBe(
      'you two',
    );
    expect(artistRow(artist('ar2', { name: 'The Beatles' })).sort_title).toBe('beatles');
  });

  it('derives the playlist key from the name — playlists have no server sortName', () => {
    expect(playlistRow({ id: 'p1', name: 'The Roadtrip' } as never).sort_title).toBe('roadtrip');
    expect(playlistRow({ id: 'p2', name: '"Quoted"' } as never).sort_title).toBe('quoted"');
  });

  it('drops leading punctuation on every entity', () => {
    expect(albumRow(album('a1', { name: '"Heroes"', artist: '(The) Band' }))).toMatchObject({
      sort_title: 'heroes"',
      sort_artist: 'the) band',
    });
    expect(songRow(song('s1', { title: '"Track"', artist: '"Who"' }))).toMatchObject({
      sort_title: 'track"',
      sort_artist: 'who"',
    });
    expect(artistRow(artist('ar1', { name: '"Who"' })).sort_title).toBe('who"');
  });
});
