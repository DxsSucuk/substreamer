jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);
// Keep ensureHeadlessDataReady() a no-op so the resolver runs deterministically
// without touching real store hydration.
jest.mock('../../store/persistence/rehydrate', () => ({
  rehydrateAllStores: async () => ({}),
  awaitKvHydration: async () => {},
}));

// resolveVoice delegates all offline/online routing to `searchLibrary`; the
// data-state matrix itself is covered in searchService.test. Here we only assert
// the resolver feeds it the clean structured term and applies the artist filter.
const mockSearchLibrary = jest.fn();
const mockFindAlbum = jest.fn();
const mockFindArtistSongs = jest.fn();
jest.mock('../searchService', () => ({
  searchLibrary: (...a: unknown[]) => mockSearchLibrary(...a),
  performOnlineSearch: async () => ({ songs: [], albums: [], artists: [] }),
  getOfflineSongsByGenre: () => [],
  findAlbum: (...a: unknown[]) => mockFindAlbum(...a),
  findArtistSongs: (...a: unknown[]) => mockFindArtistSongs(...a),
}));

const mockLogVoiceSearch = jest.fn();
jest.mock('../voiceSearchLogger', () => ({
  logVoiceSearch: (...a: unknown[]) => mockLogVoiceSearch(...a),
}));

import { __test } from '../headlessMediaService';
import { offlineModeStore } from '../../store/offlineModeStore';
import { albumDetailStore } from '../../store/albumDetailStore';

const korn = { id: 'sk', title: 'Freak on a Leash', artist: 'Korn', albumId: 'al-1' };
const other = { id: 'so', title: 'Freak on a Leash', artist: 'Other Band', albumId: 'al-2' };

function req(over: Record<string, unknown>): any {
  return {
    query: '',
    type: undefined,
    artist: undefined,
    album: undefined,
    song: undefined,
    playlist: undefined,
    genre: undefined,
    origin: 'android-assistant',
    ...over,
  };
}

beforeEach(() => {
  mockSearchLibrary.mockReset();
  mockFindAlbum.mockReset();
  mockFindArtistSongs.mockReset();
  mockLogVoiceSearch.mockReset();
  offlineModeStore.setState({ offlineMode: true } as any);
});

describe('resolveVoice — structured-field handling', () => {
  it('searches the structured song term (NOT the concatenated query) and filters by artist', async () => {
    mockSearchLibrary.mockResolvedValue({ songs: [korn, other], albums: [], artists: [] });
    const songs = await __test.resolveVoice(
      req({ query: 'Freak on a Leash Korn', song: 'Freak on a Leash', artist: 'Korn', type: 'song' }),
    );
    // Used the clean song term, NOT the old concatenated blob ("Freak on a Leash Korn").
    expect(mockSearchLibrary).toHaveBeenCalledWith('Freak on a Leash');
    // Same-titled tracks by different artists → the artist filter keeps only Korn.
    expect(songs.map((s: any) => s.id)).toEqual(['sk']);
  });

  it('falls back to the query when no structured song, and does not filter without an artist', async () => {
    mockSearchLibrary.mockResolvedValue({ songs: [korn, other], albums: [], artists: [] });
    const songs = await __test.resolveVoice(req({ query: 'freak', origin: 'ios-siri' }));
    expect(mockSearchLibrary).toHaveBeenCalledWith('freak');
    expect(songs.map((s: any) => s.id)).toEqual(['sk', 'so']);
  });

  it('delegates offline/online routing to searchLibrary (no branch in the resolver)', async () => {
    offlineModeStore.setState({ offlineMode: false } as any);
    mockSearchLibrary.mockResolvedValue({ songs: [korn], albums: [], artists: [] });
    const songs = await __test.resolveVoice(
      req({ query: 'X', song: 'Freak on a Leash', artist: 'Korn', type: 'song' }),
    );
    expect(mockSearchLibrary).toHaveBeenCalledWith('Freak on a Leash');
    expect(songs.map((s: any) => s.id)).toEqual(['sk']);
  });

  it('locks the artist in FUZZILY via scoreCandidate ("by corn" → Korn, not Other Band)', async () => {
    // The old code was a case-insensitive substring filter — "corn" would not
    // match "Korn". scoreCandidate scores it phonetically, so Korn still wins.
    mockSearchLibrary.mockResolvedValue({ songs: [korn, other], albums: [], artists: [] });
    const songs = await __test.resolveVoice(
      req({ song: 'Freak on a Leash', artist: 'corn', type: 'song' }),
    );
    expect(songs.map((s: any) => s.id)).toEqual(['sk']);
  });

  it('logs the classified intent + the request + the outcome', async () => {
    mockSearchLibrary.mockResolvedValue({ songs: [korn], albums: [], artists: [] });
    await __test.resolveVoice(
      req({ query: 'Freak on a Leash Korn', song: 'Freak on a Leash', artist: 'Korn', type: 'song' }),
    );
    const logged = mockLogVoiceSearch.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('song="Freak on a Leash"') && l.includes('artist="Korn"'))).toBe(true);
    expect(logged.some((l) => l.includes('intent=song'))).toBe(true);
    expect(logged.some((l) => l.includes('1 hit(s)') && l.includes('Freak on a Leash'))).toBe(true);
  });
});

describe('classifyVoiceIntent', () => {
  const c = (over: Record<string, unknown>) => __test.classifyVoiceIntent(req(over));

  it('uses the assistant type when present', () => {
    expect(c({ type: 'album', query: 'x' })).toBe('album');
    expect(c({ type: 'artist', query: 'x' })).toBe('artist');
    expect(c({ type: 'song', query: 'x' })).toBe('song');
    expect(c({ type: 'playlist', query: 'x' })).toBe('playlist');
    expect(c({ type: 'genre', query: 'x' })).toBe('genre');
  });

  it('infers from populated slots when type is absent', () => {
    expect(c({ album: 'Ten' })).toBe('album');
    expect(c({ song: 'Freak on a Leash' })).toBe('song');
    expect(c({ artist: 'Korn' })).toBe('artist');
    expect(c({ playlist: 'Roadtrip' })).toBe('playlist');
    expect(c({ genre: 'Metal' })).toBe('genre');
  });

  it('is free-text when only a bare query is present', () => {
    expect(c({ query: 'something mumbled' })).toBe('free-text');
  });
});

describe('resolveVoice — album + artist intents', () => {
  it('album intent → finds the album (artist-preferred) and plays it in track order', async () => {
    mockFindAlbum.mockResolvedValue({ id: 'al-1', name: 'Ten', artist: 'Pearl Jam' });
    const t1 = { id: 't1', title: 'Once', discNumber: 1, track: 1 };
    const t2 = { id: 't2', title: 'Alive', discNumber: 1, track: 2 };
    // albumSongs() → albumDetailStore.fetchAlbum(); return out-of-order to prove the sort.
    const spy = jest
      .spyOn(albumDetailStore.getState(), 'fetchAlbum')
      .mockResolvedValue({ song: [t2, t1] } as any);
    const songs = await __test.resolveVoice(req({ album: 'Ten', artist: 'Pearl Jam', type: 'album' }));
    expect(mockFindAlbum).toHaveBeenCalledWith('Ten', 'Pearl Jam');
    expect(songs.map((s: any) => s.id)).toEqual(['t1', 't2']); // disc/track order
    spy.mockRestore();
  });

  it('album intent with no match falls through to a song search', async () => {
    mockFindAlbum.mockResolvedValue(null);
    mockSearchLibrary.mockResolvedValue({ songs: [korn], albums: [], artists: [] });
    const songs = await __test.resolveVoice(req({ album: 'Nope', type: 'album' }));
    expect(mockSearchLibrary).toHaveBeenCalled();
    expect(songs.map((s: any) => s.id)).toEqual(['sk']);
  });

  it('artist intent → plays the tracks from findArtistSongs', async () => {
    mockFindArtistSongs.mockResolvedValue([korn]);
    const songs = await __test.resolveVoice(req({ artist: 'Korn', type: 'artist' }));
    expect(mockFindArtistSongs).toHaveBeenCalledWith('Korn');
    expect(songs.map((s: any) => s.id)).toEqual(['sk']);
  });
});
