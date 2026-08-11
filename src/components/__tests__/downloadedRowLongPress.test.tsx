/**
 * Long-pressing a row in Library → Songs → Downloaded, end to end on REAL SQL:
 *
 *   cached_songs row → listDownloadedSongs → downloadedSongRowToChild (nine of ~58
 *   columns) → TrackRow long press → moreOptionsStore → the options sheet.
 *
 * The sheet gates "Go to Artist" and "Play More by This Artist" on `artistId`, and
 * renders the track-details modal straight off the same object — all of which the
 * list projection drops. Rendering a row needs nine columns; opening the sheet on ONE
 * song does not, so the track is completed when the sheet opens, never per row.
 */
jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

let mockOfflineMode = false;
let mockDownloadStatus: 'none' | 'partial' | 'complete' = 'complete';

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
      orange: '#FF9500',
    },
  }),
}));

jest.mock('../../hooks/useDownloadStatus', () => ({
  useDownloadStatus: () => mockDownloadStatus,
}));
jest.mock('../../hooks/useIsStarred', () => ({ useIsStarred: () => false }));
jest.mock('../../hooks/useRating', () => ({ useRating: () => 0 }));
jest.mock('../../hooks/useSongCoverArt', () => ({
  useSongCoverArt: () => undefined,
  resolveEntityCoverArt: () => undefined,
}));
jest.mock('../../hooks/useConfirmAlbumRemoval', () => ({
  useConfirmAlbumRemoval: () => ({ confirmRemove: jest.fn() }),
}));
jest.mock('../../hooks/useThemedAlert', () => ({
  useThemedAlert: () => ({ alert: jest.fn() }),
}));

jest.mock('../CachedImage', () => {
  const { View } = require('react-native');
  return { CachedImage: () => <View /> };
});
jest.mock('../NowPlayingIndicator', () => {
  const { View } = require('react-native');
  return { NowPlayingIndicator: () => <View /> };
});
jest.mock('../RowMetaLine', () => {
  const { View } = require('react-native');
  return { RowMetaLine: () => <View /> };
});
jest.mock('../AlbumDetailsModal', () => ({ AlbumDetailsModal: () => null }));
jest.mock('../StarRating', () => ({ StarRatingDisplay: () => null }));

// The sheet's chrome is irrelevant to option gating — render children inline.
jest.mock('../BottomSheet', () => {
  const { View } = require('react-native');
  return {
    BottomSheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? <View testID="bottom-sheet">{children}</View> : null,
  };
});

/** Capture what the details modal is actually handed — the reported symptom. */
const detailsTracks: Record<string, unknown>[] = [];
jest.mock('../TrackDetailsModal', () => ({
  TrackDetailsModal: ({ track, visible }: { track: Record<string, unknown>; visible: boolean }) => {
    if (visible) detailsTracks.push(track);
    return null;
  },
}));

jest.mock('../SwipeableRow', () => {
  const { Pressable, Text, View } = require('react-native');
  return {
    SwipeableRow: ({
      children,
      onLongPress,
      onPress,
    }: {
      children: React.ReactNode;
      onLongPress?: () => void;
      onPress?: () => void;
    }) => (
      <View>
        {children}
        <Pressable onPress={onPress} onLongPress={onLongPress}>
          <Text>swipe-row-press</Text>
        </Pressable>
      </View>
    ),
  };
});

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  usePathname: () => '/library',
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
jest.mock('../../services/playerService', () => ({ playTrack: jest.fn() }));
jest.mock('../../services/musicCacheService', () => ({ deleteCachedItem: jest.fn() }));
jest.mock('../../services/subsonicService', () => ({
  deletePlaylist: jest.fn(),
  isVariousArtists: () => false,
}));
jest.mock('../../services/serverCapabilityService', () => ({
  canUserShare: () => true,
  supports: () => true,
}));

jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: Object.assign(
    (sel: (s: { offlineMode: boolean }) => unknown) => sel({ offlineMode: mockOfflineMode }),
    { getState: () => ({ offlineMode: mockOfflineMode }) },
  ),
}));
jest.mock('../../store/playerStore', () => ({
  playerStore: Object.assign(
    (sel: (s: { queue: unknown[]; currentTrack: unknown }) => unknown) =>
      sel({ queue: [], currentTrack: null }),
    { getState: () => ({ queue: [], currentTrack: null }) },
  ),
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
jest.mock('../../store/syncStatusStore', () => ({
  syncStatusStore: { getState: () => ({ bumpLibraryUpdated: jest.fn() }) },
}));
jest.mock('../../store/setRatingStore', () => ({
  setRatingStore: { getState: () => ({ show: jest.fn() }) },
}));
jest.mock('../../store/processingOverlayStore', () => ({ runWithOverlay: jest.fn() }));
jest.mock('../../db/repository/details', () => ({ getArtistBioRow: jest.fn() }));
jest.mock('../../db/repository/playlists', () => ({ deletePlaylist: jest.fn() }));
jest.mock('../../db/detailNotifier', () => ({ bumpDetailChanged: jest.fn() }));

import type { Child } from 'subsonic-api';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { downloadedSongRowToChild, listDownloadedSongs } from '../../db/repository/downloads';
import { moreOptionsStore } from '../../store/moreOptionsStore';
import { musicCacheStore } from '../../store/musicCacheStore';
import { getDb } from '../../store/persistence/db';
import { upsertCachedSong, type CachedSongRow } from '../../store/persistence/musicCacheTables';
import { MoreOptionsSheet } from '../MoreOptionsSheet';
import { TrackRow } from '../TrackRow';

const db = () => getDb()!;

/** A downloaded track as the writer stores it; the `src*` twins are the SERVER's. */
const DOWNLOADED_ROW: CachedSongRow = {
  id: 's-dl',
  title: 'Shoegaze Anthem',
  artist: 'The Artist',
  album: 'The Album',
  albumId: 'dir-1',
  coverArt: 'cov-1',
  bytes: 9_000_000,
  duration: 210,
  suffix: 'mp3',
  bitRate: 320,
  formatCapturedAt: 0,
  downloadedAt: 0,
  srcAlbumId: 'srv-1',
  srcSuffix: 'flac',
  srcBitRate: 1000,
  srcBitDepth: 24,
  srcSamplingRate: 96_000,
  artistId: 'ar-1',
  track: 3,
  year: 1991,
  genre: 'Shoegaze',
  genres: ['Shoegaze'],
  size: 41_000_000,
  contentType: 'audio/flac',
  path: 'The Artist/The Album/03 Shoegaze Anthem.flac',
  userRating: 4,
};

const colors = {
  background: '#000',
  card: '#111',
  textPrimary: '#fff',
  textSecondary: '#888',
  border: '#333',
  primary: '#1D9BF0',
  red: '#e91429',
  orange: '#FF9500',
} as unknown as Parameters<typeof TrackRow>[0]['colors'];

/** The `Child` the Downloaded filter hands its rows — via the real SQL read. */
const listChild = async (): Promise<Child> =>
  downloadedSongRowToChild((await listDownloadedSongs(db()))[0]);

/** Long-press a Downloaded row and render the sheet it opens. */
const openSheetForDownloadedRow = async () => {
  const track = await listChild();
  const row = render(<TrackRow track={track} colors={colors} onPress={jest.fn()} />);
  fireEvent(row.getByText('swipe-row-press'), 'longPress');
  return render(<MoreOptionsSheet />);
};

beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(async () => {
  detailsTracks.length = 0;
  mockOfflineMode = false;
  mockDownloadStatus = 'complete';
  db().runSync('DELETE FROM cached_songs;');
  moreOptionsStore.setState({ visible: false, entity: null, source: 'default' });
  musicCacheStore.setState({ cachedItems: {}, cachedSongs: {} } as never);
  await upsertCachedSong(DOWNLOADED_ROW);
  musicCacheStore.setState({ cachedSongs: { [DOWNLOADED_ROW.id]: DOWNLOADED_ROW } } as never);
});

describe('the options sheet on a Downloaded row', () => {
  it('offers Go to Artist', async () => {
    const { queryByText } = await openSheetForDownloadedRow();
    expect(queryByText('Go to Artist')).toBeTruthy();
  });

  it('offers Play More by This Artist', async () => {
    const { queryByText } = await openSheetForDownloadedRow();
    expect(queryByText('Play More by This Artist')).toBeTruthy();
  });

  it('hands the track-details sheet the whole track, not nine columns', async () => {
    const { getByText } = await openSheetForDownloadedRow();

    fireEvent.press(getByText('Track Details'));
    // The sheet closes before the modal opens, and awaits the close.
    await waitFor(() => expect(detailsTracks.length).toBeGreaterThan(0));

    const track = detailsTracks[detailsTracks.length - 1];
    expect(track.album).toBe('The Album');
    expect(track.year).toBe(1991);
    expect(track.genre).toBe('Shoegaze');
    expect(track.suffix).toBe('flac');
    expect(track.bitRate).toBe(1000);
    expect(track.size).toBe(41_000_000);
    expect(track.contentType).toBe('audio/flac');
    expect(track.path).toBe('The Artist/The Album/03 Shoegaze Anthem.flac');
  });

  it('carries the stored rating the sheet renders', async () => {
    await openSheetForDownloadedRow();
    const entity = moreOptionsStore.getState().entity!;
    expect((entity.item as Child).userRating).toBe(4);
  });

  it('keeps the album id the list read resolved — the SERVER album, not the directory', async () => {
    await openSheetForDownloadedRow();
    const entity = moreOptionsStore.getState().entity!;
    expect((entity.item as Child).albumId).toBe('srv-1');
  });

  it('leaves a song we hold nothing for exactly as the row gave it', async () => {
    musicCacheStore.setState({ cachedSongs: {} } as never);
    const track = await listChild();

    const row = render(<TrackRow track={track} colors={colors} onPress={jest.fn()} />);
    fireEvent(row.getByText('swipe-row-press'), 'longPress');

    expect(moreOptionsStore.getState().entity!.item).toBe(track);
  });
});
