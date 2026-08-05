jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

import React from 'react';
import { render } from '@testing-library/react-native';

/* ------------------------------------------------------------------ */
/*  Mutable mock state (read through closures by the mocks below)      */
/* ------------------------------------------------------------------ */

type CachedItem =
  | { type: 'album'; songIds: string[] }
  | { type: 'playlist'; songIds: string[] }
  | { type: 'song'; songIds: string[] };

let mockCachedItems: Record<string, CachedItem> = {};
let mockOfflineMode = false;
let mockDownloadStatus: 'none' | 'queued' | 'downloading' | 'partial' | 'complete' = 'none';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      background: '#000',
      card: '#111',
      textPrimary: '#fff',
      textSecondary: '#888',
      border: '#333',
      primary: '#1D9BF0',
      red: '#e91429',
    },
  }),
}));

// The sheet's chrome is irrelevant to option gating — render children inline so
// queries see the option rows without the Modal / gesture / reanimated stack.
jest.mock('../BottomSheet', () => {
  const { View } = require('react-native');
  return {
    BottomSheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? <View testID="bottom-sheet">{children}</View> : null,
  };
});

jest.mock('../CachedImage', () => {
  const { View } = require('react-native');
  return { CachedImage: () => <View /> };
});

jest.mock('../AlbumDetailsModal', () => ({ AlbumDetailsModal: () => null }));
jest.mock('../TrackDetailsModal', () => ({ TrackDetailsModal: () => null }));
jest.mock('../StarRating', () => ({ StarRatingDisplay: () => null }));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  usePathname: () => '/playlist/p1',
}));

jest.mock('../../hooks/useConfirmAlbumRemoval', () => ({
  useConfirmAlbumRemoval: () => ({ confirmRemove: jest.fn() }),
}));
jest.mock('../../hooks/useThemedAlert', () => ({
  useThemedAlert: () => ({ alert: jest.fn() }),
}));
jest.mock('../../hooks/useDownloadStatus', () => ({
  useDownloadStatus: () => mockDownloadStatus,
}));
jest.mock('../../hooks/useIsStarred', () => ({ useIsStarred: () => false }));
jest.mock('../../hooks/useRating', () => ({ useRating: () => 0 }));
jest.mock('../../hooks/useSongCoverArt', () => ({
  resolveEntityCoverArt: () => undefined,
}));

jest.mock('../../services/moreOptionsService', () => ({
  addAlbumToQueue: jest.fn(),
  addPlaylistToQueue: jest.fn(),
  addSongToQueue: jest.fn(),
  cancelDownload: jest.fn(),
  enqueueAlbumDownload: jest.fn(),
  enqueuePlaylistDownload: jest.fn(),
  handleDownloadSong: jest.fn(),
  handleRemoveSongDownload: jest.fn(),
  playMoreByArtist: jest.fn(),
  playMoreLikeThis: jest.fn(),
  playSimilarArtistsMix: jest.fn(),
  playSongNextInQueue: jest.fn(),
  removeDownload: jest.fn(),
  saveArtistTopSongsPlaylist: jest.fn(),
  songItemId: (songId: string) => `song:${songId}`,
  toggleStar: jest.fn(),
}));

jest.mock('../../services/musicCacheService', () => ({ deleteCachedItem: jest.fn() }));
jest.mock('../../services/subsonicService', () => ({
  deletePlaylist: jest.fn(),
  isVariousArtists: () => false,
}));
jest.mock('../../services/serverCapabilityService', () => ({
  canUserShare: () => true,
  supports: () => true,
}));

jest.mock('../../store/musicCacheStore', () => {
  const state = () => ({ cachedItems: mockCachedItems, downloadQueue: [] });
  return {
    musicCacheStore: Object.assign(
      (sel: (s: ReturnType<typeof state>) => unknown) => sel(state()),
      { getState: state },
    ),
  };
});

jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: Object.assign(
    (sel: (s: { offlineMode: boolean }) => unknown) => sel({ offlineMode: mockOfflineMode }),
    { getState: () => ({ offlineMode: mockOfflineMode }) },
  ),
}));

jest.mock('../../store/scrobbleExclusionStore', () => ({
  scrobbleExclusionStore: Object.assign(
    (sel: (s: Record<string, Record<string, unknown>>) => unknown) =>
      sel({ excludedAlbums: {}, excludedArtists: {}, excludedPlaylists: {} }),
    { getState: () => ({ addExclusion: jest.fn(), removeExclusion: jest.fn() }) },
  ),
}));

jest.mock('../../store/tabletLayoutStore', () => ({
  tabletLayoutStore: { getState: () => ({ setPlayerExpanded: jest.fn() }) },
}));
jest.mock('../../store/addToPlaylistStore', () => ({
  addToPlaylistStore: {
    getState: () => ({ showSong: jest.fn(), showAlbum: jest.fn(), showQueue: jest.fn() }),
  },
}));
jest.mock('../../store/createShareStore', () => ({
  createShareStore: {
    getState: () => ({ showAlbum: jest.fn(), showPlaylist: jest.fn(), showSong: jest.fn() }),
  },
}));
jest.mock('../../store/mbidOverrideStore', () => ({
  mbidOverrideStore: { getState: () => ({ overrides: {} }) },
  getOverride: () => undefined,
}));
jest.mock('../../store/mbidSearchStore', () => ({
  mbidSearchStore: { getState: () => ({ showArtist: jest.fn(), showAlbum: jest.fn() }) },
}));
jest.mock('../../store/playerStore', () => ({
  playerStore: { getState: () => ({ queue: [] }) },
}));
jest.mock('../../store/syncStatusStore', () => ({
  syncStatusStore: { getState: () => ({ bumpLibraryUpdated: jest.fn() }) },
}));
jest.mock('../../store/setRatingStore', () => ({
  setRatingStore: { getState: () => ({ show: jest.fn() }) },
}));
jest.mock('../../store/processingOverlayStore', () => ({
  runWithOverlay: jest.fn(),
}));
jest.mock('../../store/persistence/db', () => ({ getDb: () => null }));
jest.mock('../../db/repository/details', () => ({ getArtistBioRow: jest.fn() }));
jest.mock('../../db/repository/playlists', () => ({ deletePlaylist: jest.fn() }));
jest.mock('../../db/detailNotifier', () => ({ bumpDetailChanged: jest.fn() }));

import { MoreOptionsSheet } from '../MoreOptionsSheet';
import { moreOptionsStore, type MoreOptionsSource } from '../../store/moreOptionsStore';
import type { Child } from '../../services/subsonicService';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const song = {
  id: 's1',
  title: 'Test Track',
  artist: 'Test Artist',
  artistId: 'ar1',
  albumId: 'al1',
  duration: 180,
} as unknown as Child;

/** The two states that make a song's per-song "Remove Download" eligible. */
const songLevelClaim: Record<string, CachedItem> = {
  'song:s1': { type: 'song', songIds: ['s1'] },
};
const downloadedAlbumClaim: Record<string, CachedItem> = {
  al1: { type: 'album', songIds: ['s1', 's2'] },
};

function showSong(source?: MoreOptionsSource) {
  moreOptionsStore.getState().show({ type: 'song', item: song }, source);
}

beforeEach(() => {
  mockCachedItems = {};
  mockOfflineMode = false;
  mockDownloadStatus = 'none';
  moreOptionsStore.setState({ visible: false, entity: null, source: 'default' });
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('MoreOptionsSheet — per-song Remove Download gating', () => {
  it('shows Remove Download for a song-level claim from the default source', () => {
    mockCachedItems = songLevelClaim;
    mockDownloadStatus = 'complete';
    showSong();
    const { queryByText } = render(<MoreOptionsSheet />);
    expect(queryByText('Remove Download')).toBeTruthy();
  });

  it('shows Remove Download for a song pooled via a downloaded album (default source)', () => {
    mockCachedItems = downloadedAlbumClaim;
    mockDownloadStatus = 'complete';
    showSong();
    const { queryByText } = render(<MoreOptionsSheet />);
    expect(queryByText('Remove Download')).toBeTruthy();
  });

  it('hides Remove Download in playlist-detail even with a song-level claim', () => {
    mockCachedItems = songLevelClaim;
    mockDownloadStatus = 'complete';
    showSong('playlist-detail');
    const { queryByText } = render(<MoreOptionsSheet />);
    expect(queryByText('Remove Download')).toBeNull();
  });

  it('hides Remove Download in playlist-detail even when a downloaded album contains the song', () => {
    mockCachedItems = downloadedAlbumClaim;
    mockDownloadStatus = 'complete';
    showSong('playlist-detail');
    const { queryByText } = render(<MoreOptionsSheet />);
    expect(queryByText('Remove Download')).toBeNull();
  });

  it('hides Remove Download in playlist-detail when both claims exist', () => {
    mockCachedItems = { ...songLevelClaim, ...downloadedAlbumClaim };
    mockDownloadStatus = 'complete';
    showSong('playlist-detail');
    const { queryByText } = render(<MoreOptionsSheet />);
    expect(queryByText('Remove Download')).toBeNull();
  });

  it('still hides Remove Download from the default source when no claim exists', () => {
    mockCachedItems = {};
    showSong();
    const { queryByText } = render(<MoreOptionsSheet />);
    expect(queryByText('Remove Download')).toBeNull();
  });

  it('leaves the rest of the sheet intact in playlist-detail', () => {
    mockCachedItems = songLevelClaim;
    mockDownloadStatus = 'complete';
    showSong('playlist-detail');
    const { queryByText } = render(<MoreOptionsSheet />);
    // Only the download option is suppressed — everything else still renders.
    expect(queryByText('Test Track')).toBeTruthy();
    expect(queryByText('Add to Playlist')).toBeTruthy();
    expect(queryByText('Track Details')).toBeTruthy();
  });
});

describe('MoreOptionsSheet — isPlayerSource must not treat every non-default source as the player', () => {
  const playerSources: MoreOptionsSource[] = [
    'player-phone-portrait',
    'player-tablet-portrait',
    'player-tablet-splitview',
    'player-tablet-landscape',
  ];

  it('playlist-detail keeps the non-player queue actions', () => {
    showSong('playlist-detail');
    const { queryByText } = render(<MoreOptionsSheet />);
    expect(queryByText('Add to Queue')).toBeTruthy();
    expect(queryByText('Play Next')).toBeTruthy();
    expect(queryByText('Add Queue to Playlist')).toBeNull();
  });

  it('default keeps the non-player queue actions', () => {
    showSong();
    const { queryByText } = render(<MoreOptionsSheet />);
    expect(queryByText('Add to Queue')).toBeTruthy();
    expect(queryByText('Play Next')).toBeTruthy();
    expect(queryByText('Add Queue to Playlist')).toBeNull();
  });

  it.each(playerSources)('%s swaps in the player-queue action', (source) => {
    showSong(source);
    const { queryByText } = render(<MoreOptionsSheet />);
    expect(queryByText('Add Queue to Playlist')).toBeTruthy();
    expect(queryByText('Add to Queue')).toBeNull();
    expect(queryByText('Play Next')).toBeNull();
  });

  it('player sources still offer per-song Remove Download', () => {
    mockCachedItems = songLevelClaim;
    mockDownloadStatus = 'complete';
    showSong('player-phone-portrait');
    const { queryByText } = render(<MoreOptionsSheet />);
    expect(queryByText('Remove Download')).toBeTruthy();
  });
});
