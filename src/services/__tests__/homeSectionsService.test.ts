import { composeHomeAlbumSections, type ComposeHomeInput } from '../homeSectionsService';

const album = (id: string) => ({ id, name: `Album ${id}` } as any);

// Two caller-precomputed inputs, both plain sets — this stays a PURE function while the
// reads behind it are SQL. `downloadedAlbumIds` is the membership set (the partial gate is
// already applied by whoever read it); `downloadedAlbums` is the body of the Downloaded
// Albums section (the service no longer filters a full library list).
const base: ComposeHomeInput = {
  recentlyAdded: [album('a1'), album('a2')],
  recentlyPlayed: [album('a3')],
  frequentlyPlayed: [album('a4')],
  randomSelection: [album('a5')],
  downloadedAlbums: [],
  starredAlbumIds: new Set<string>(),
  downloadedAlbumIds: new Set<string>(),
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
    const s = composeHomeAlbumSections({
      ...base,
      downloadedAlbumIds: new Set(['a1', 'a3']),
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
    const s = composeHomeAlbumSections({
      ...base,
      downloadedAlbumIds: new Set(['a1', 'a5']),
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

  it('downloadedOnly with an EMPTY id set: every curated list filters to nothing', () => {
    // The contract every caller leans on while its SQL read is still in flight — an
    // unknown set must never fall through to "show everything", which under a Downloaded
    // filter means showing music that isn't on the device.
    const s = composeHomeAlbumSections({ ...base, downloadedOnly: true });
    expect(ids(s, 'recentlyAdded')).toEqual([]);
    expect(ids(s, 'recentlyPlayed')).toEqual([]);
    expect(ids(s, 'frequentlyPlayed')).toEqual([]);
    expect(ids(s, 'randomSelection')).toEqual([]);
  });

  it('does NOT apply the id set to the Downloaded Albums body', () => {
    // Membership vs visibility: the body is the caller's own (renderable) read and is
    // passed through verbatim. Filtering it by the membership set would be a second,
    // redundant gate that could only ever remove rows the caller meant to show.
    const s = composeHomeAlbumSections({
      ...base,
      downloadedOnly: true,
      downloadedAlbumIds: new Set<string>(),
      downloadedAlbums: [album('a1')],
    });
    expect(ids(s, 'downloadedAlbums')).toEqual(['a1']);
  });

  it('downloadedOnly + favoritesOnly: an album must be in BOTH sets', () => {
    const s = composeHomeAlbumSections({
      ...base,
      recentlyAdded: [album('a1'), album('a2'), album('a3')],
      downloadedOnly: true,
      favoritesOnly: true,
      downloadedAlbumIds: new Set(['a1', 'a2']),
      starredAlbumIds: new Set(['a2', 'a3']),
    });
    expect(ids(s, 'recentlyAdded')).toEqual(['a2']);
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
