import { composeHomeAlbumSections, type ComposeHomeInput } from '../homeSectionsService';

const album = (id: string) => ({ id, name: `Album ${id}` } as any);

// With includePartial: true, an album counts as downloaded iff cachedItems has
// an entry for its id (the partial check is skipped), so `{ a1: {} }` marks a1.
// `downloadedAlbums` is now the caller-precomputed body of the Downloaded Albums
// section (the service no longer filters a full library list).
const base: ComposeHomeInput = {
  recentlyAdded: [album('a1'), album('a2')],
  recentlyPlayed: [album('a3')],
  frequentlyPlayed: [album('a4')],
  randomSelection: [album('a5')],
  downloadedAlbums: [],
  starredAlbumIds: new Set<string>(),
  cachedItems: {} as any,
  includePartial: true,
  offlineMode: false,
  downloadedOnly: false,
  favoritesOnly: false,
};

const types = (s: ReturnType<typeof composeHomeAlbumSections>) => s.map((x) => x.type);
const ids = (s: ReturnType<typeof composeHomeAlbumSections>, type: string) =>
  s.find((x) => x.type === type)!.albums.map((a) => a.id);

describe('composeHomeAlbumSections', () => {
  it('online, unfiltered: 4 curated lists in order, no downloaded-albums section', () => {
    const s = composeHomeAlbumSections(base);
    expect(types(s)).toEqual([
      'recentlyAdded',
      'recentlyPlayed',
      'frequentlyPlayed',
      'randomSelection',
    ]);
    expect(ids(s, 'recentlyAdded')).toEqual(['a1', 'a2']);
  });

  it('offline + downloadedOnly: drops Random, prepends Downloaded Albums, filters the rest', () => {
    const cachedItems = { a1: {}, a3: {} } as any; // a1 + a3 downloaded
    const s = composeHomeAlbumSections({
      ...base,
      cachedItems,
      downloadedAlbums: [album('a1'), album('a3')],
      offlineMode: true,
      downloadedOnly: true,
    });
    expect(types(s)).toEqual([
      'downloadedAlbums',
      'recentlyAdded',
      'recentlyPlayed',
      'frequentlyPlayed',
    ]); // no randomSelection offline
    expect(ids(s, 'downloadedAlbums')).toEqual(['a1', 'a3']);
    expect(ids(s, 'recentlyAdded')).toEqual(['a1']); // a2 not downloaded
    expect(ids(s, 'recentlyPlayed')).toEqual(['a3']);
    expect(ids(s, 'frequentlyPlayed')).toEqual([]); // a4 not downloaded
  });

  it('downloadedOnly while online: keeps Random, still prepends Downloaded Albums', () => {
    const cachedItems = { a1: {}, a5: {} } as any;
    const s = composeHomeAlbumSections({
      ...base,
      cachedItems,
      downloadedAlbums: [album('a1'), album('a5')],
      downloadedOnly: true,
    });
    expect(types(s)).toEqual([
      'downloadedAlbums',
      'recentlyAdded',
      'recentlyPlayed',
      'frequentlyPlayed',
      'randomSelection',
    ]);
    expect(ids(s, 'randomSelection')).toEqual(['a5']);
  });

  it('favoritesOnly: filters curated lists to starred, no downloaded-albums section', () => {
    const s = composeHomeAlbumSections({
      ...base,
      favoritesOnly: true,
      starredAlbumIds: new Set(['a1']),
    });
    expect(types(s)).toEqual([
      'recentlyAdded',
      'recentlyPlayed',
      'frequentlyPlayed',
      'randomSelection',
    ]);
    expect(ids(s, 'recentlyAdded')).toEqual(['a1']);
    expect(ids(s, 'recentlyPlayed')).toEqual([]); // a3 not starred
  });
});
