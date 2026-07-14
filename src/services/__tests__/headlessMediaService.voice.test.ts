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
jest.mock('../searchService', () => ({
  searchLibrary: (...a: unknown[]) => mockSearchLibrary(...a),
  performOnlineSearch: async () => ({ songs: [], albums: [], artists: [] }),
  getOfflineSongsByGenre: () => [],
}));

const mockLogVoiceSearch = jest.fn();
jest.mock('../voiceSearchLogger', () => ({
  logVoiceSearch: (...a: unknown[]) => mockLogVoiceSearch(...a),
}));

import { __test } from '../headlessMediaService';
import { offlineModeStore } from '../../store/offlineModeStore';

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

  it('logs the request (revealing the transcribed query) and the outcome', async () => {
    mockSearchLibrary.mockResolvedValue({ songs: [korn], albums: [], artists: [] });
    await __test.resolveVoice(
      req({ query: 'Freak on a Leash Korn', song: 'Freak on a Leash', artist: 'Korn', type: 'song' }),
    );
    const logged = mockLogVoiceSearch.mock.calls.map((c) => String(c[0]));
    // The incoming request is captured verbatim (the key diagnostic).
    expect(logged.some((l) => l.includes('song="Freak on a Leash"') && l.includes('artist="Korn"'))).toBe(true);
    // …and the resolution outcome (hit count / top result).
    expect(logged.some((l) => l.includes('1 hit(s)') && l.includes('Freak on a Leash'))).toBe(true);
  });
});
