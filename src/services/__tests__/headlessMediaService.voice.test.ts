jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);
// Keep ensureHeadlessDataReady() a no-op so the resolver runs deterministically
// without touching real store hydration.
jest.mock('../../store/persistence/rehydrate', () => ({
  rehydrateAllStores: async () => ({}),
  awaitKvHydration: async () => {},
}));

const mockOffline = jest.fn();
const mockOnline = jest.fn();
jest.mock('../searchService', () => ({
  performOfflineSearch: (...a: unknown[]) => mockOffline(...a),
  performOnlineSearch: (...a: unknown[]) => mockOnline(...a),
  getOfflineSongsByGenre: () => [],
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
  mockOffline.mockReset();
  mockOnline.mockReset();
  offlineModeStore.setState({ offlineMode: true } as any);
});

describe('resolveVoice — structured-field handling (Phase 0)', () => {
  it('searches the structured song term (NOT the concatenated query) and filters by artist', async () => {
    mockOffline.mockResolvedValue({ songs: [korn, other], albums: [], artists: [] });
    const songs = await __test.resolveVoice(
      req({ query: 'Freak on a Leash Korn', song: 'Freak on a Leash', artist: 'Korn', type: 'song' }),
    );
    // Used the clean song term, NOT the old concatenated blob ("Freak on a Leash Korn").
    expect(mockOffline).toHaveBeenCalledWith('Freak on a Leash');
    // Same-titled tracks by different artists → the artist filter keeps only Korn.
    expect(songs.map((s: any) => s.id)).toEqual(['sk']);
  });

  it('falls back to the query when no structured song, and does not filter without an artist', async () => {
    mockOffline.mockResolvedValue({ songs: [korn, other], albums: [], artists: [] });
    const songs = await __test.resolveVoice(req({ query: 'freak', origin: 'ios-siri' }));
    expect(mockOffline).toHaveBeenCalledWith('freak');
    expect(songs.map((s: any) => s.id)).toEqual(['sk', 'so']);
  });

  it('online path uses performOnlineSearch with the song term', async () => {
    offlineModeStore.setState({ offlineMode: false } as any);
    mockOnline.mockResolvedValue({ songs: [korn], albums: [], artists: [] });
    const songs = await __test.resolveVoice(
      req({ query: 'X', song: 'Freak on a Leash', artist: 'Korn', type: 'song' }),
    );
    expect(mockOnline).toHaveBeenCalledWith('Freak on a Leash');
    expect(songs.map((s: any) => s.id)).toEqual(['sk']);
  });
});
