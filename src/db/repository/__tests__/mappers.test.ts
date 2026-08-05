import type { AlbumID3, ArtistID3, Child } from 'subsonic-api';

import { getDb } from '../../../store/persistence/db';
import { ensureNormalizedSchema } from '../../createNormalizedTables';
import { upsertAlbums } from '../albums';
import { upsertArtists } from '../artists';
import { markStarredAlbums, markStarredArtists, markStarredSongs } from '../favorites';
import { albumRow, artistRow, songRow } from '../mappers';
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
