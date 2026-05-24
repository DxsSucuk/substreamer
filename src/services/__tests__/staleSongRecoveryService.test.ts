/**
 * Tests for the stale-song-ID recovery service (#146). Cover both the
 * pure `findMatchingSong` matcher and the full `recoverStaleSongId`
 * orchestration with album refresh, identity check, and persistence
 * delegation.
 */

jest.mock('../subsonicService');
jest.mock('../musicCacheService', () => ({
  renameCachedSongFile: jest.fn(() => 'missing' as const),
}));
jest.mock('../../store/persistence/musicCacheTables', () => ({
  remapCachedSongId: jest.fn(() => false),
}));

const mockFetchAlbum = jest.fn();
const mockAlbums: Record<string, any> = {};
jest.mock('../../store/albumDetailStore', () => ({
  albumDetailStore: {
    getState: () => ({
      albums: mockAlbums,
      fetchAlbum: mockFetchAlbum,
    }),
  },
}));

import { search3 } from '../subsonicService';
import { renameCachedSongFile } from '../musicCacheService';
import { remapCachedSongId } from '../../store/persistence/musicCacheTables';
import { findMatchingSong, recoverStaleSongId } from '../staleSongRecoveryService';

const mockSearch3 = search3 as jest.Mock;
const mockRename = renameCachedSongFile as jest.Mock;
const mockRemap = remapCachedSongId as jest.Mock;

const makeSong = (overrides: any = {}) => ({
  id: 'song-1',
  isDir: false,
  title: 'Track Title',
  artist: 'Artist Name',
  duration: 200,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockAlbums)) delete mockAlbums[k];
  mockFetchAlbum.mockResolvedValue(null);
  mockSearch3.mockResolvedValue({ albums: [], artists: [], songs: [] });
  mockRename.mockReturnValue('missing');
  mockRemap.mockReturnValue(false);
});

describe('findMatchingSong', () => {
  it('returns null for empty haystack', () => {
    expect(findMatchingSong(makeSong(), [])).toBeNull();
    expect(findMatchingSong(makeSong(), undefined)).toBeNull();
  });

  it('prefers MusicBrainz ID over everything else', () => {
    const needle = makeSong({ musicBrainzId: 'mbid-xyz', title: 'X', artist: 'A' });
    const haystack = [
      makeSong({ id: 'a', title: 'X', artist: 'A', duration: 200 }),
      makeSong({ id: 'b', musicBrainzId: 'mbid-xyz', title: 'Different', artist: 'Other' }),
    ];
    expect(findMatchingSong(needle, haystack)?.id).toBe('b');
  });

  it('matches by title + artist when MBID absent and there is exactly one candidate', () => {
    const needle = makeSong({ title: 'Song', artist: 'Band' });
    const haystack = [
      makeSong({ id: 'fresh-1', title: 'Song', artist: 'Band', duration: 195 }),
      makeSong({ id: 'other', title: 'Other', artist: 'Band' }),
    ];
    expect(findMatchingSong(needle, haystack)?.id).toBe('fresh-1');
  });

  it('uses duration to disambiguate multiple title+artist matches', () => {
    const needle = makeSong({ title: 'Song', artist: 'Band', duration: 240 });
    const haystack = [
      makeSong({ id: 'studio', title: 'Song', artist: 'Band', duration: 180 }),
      makeSong({ id: 'live', title: 'Song', artist: 'Band', duration: 241 }),
    ];
    expect(findMatchingSong(needle, haystack)?.id).toBe('live');
  });

  it('allows up to 2s drift in duration tiebreaker', () => {
    const needle = makeSong({ title: 'X', artist: 'A', duration: 100 });
    const haystack = [
      makeSong({ id: 'far', title: 'X', artist: 'A', duration: 105 }),
      makeSong({ id: 'close', title: 'X', artist: 'A', duration: 98 }),
    ];
    expect(findMatchingSong(needle, haystack)?.id).toBe('close');
  });

  it('falls back to title-only when artist differs (single match)', () => {
    const needle = makeSong({ title: 'Unique', artist: 'Old Name' });
    const haystack = [makeSong({ id: 'renamed', title: 'Unique', artist: 'New Name' })];
    expect(findMatchingSong(needle, haystack)?.id).toBe('renamed');
  });

  it('returns null when no match is good enough', () => {
    const needle = makeSong({ title: 'Nope', artist: 'Nobody' });
    const haystack = [
      makeSong({ id: 'x', title: 'X', artist: 'A' }),
      makeSong({ id: 'y', title: 'Y', artist: 'B' }),
    ];
    expect(findMatchingSong(needle, haystack)).toBeNull();
  });
});

describe('recoverStaleSongId — identity check', () => {
  it('returns null when the album refresh produces the SAME id', async () => {
    const stale = makeSong({ id: 'unchanged', albumId: 'a1' });
    mockFetchAlbum.mockResolvedValue({
      id: 'a1',
      song: [makeSong({ id: 'unchanged', title: 'Track Title', artist: 'Artist Name' })],
    });

    const result = await recoverStaleSongId(stale);
    expect(result).toBeNull();
    expect(mockFetchAlbum).toHaveBeenCalledWith('a1');
    // No swap, no persistence.
    expect(mockRename).not.toHaveBeenCalled();
    expect(mockRemap).not.toHaveBeenCalled();
  });
});

describe('recoverStaleSongId — album refresh', () => {
  it('builds an album-wide swap map from the diff of old vs fresh', async () => {
    mockAlbums['a1'] = {
      album: {
        id: 'a1',
        song: [
          makeSong({ id: 'old-1', title: 'T1', artist: 'A' }),
          makeSong({ id: 'old-2', title: 'T2', artist: 'A' }),
          makeSong({ id: 'unchanged-3', title: 'T3', artist: 'A' }),
        ],
      },
    };
    mockFetchAlbum.mockResolvedValue({
      id: 'a1',
      song: [
        makeSong({ id: 'new-1', title: 'T1', artist: 'A' }),
        makeSong({ id: 'new-2', title: 'T2', artist: 'A' }),
        makeSong({ id: 'unchanged-3', title: 'T3', artist: 'A' }),
      ],
    });
    const stale = makeSong({ id: 'old-1', albumId: 'a1', title: 'T1', artist: 'A' });

    const result = await recoverStaleSongId(stale);
    expect(result).not.toBeNull();
    expect(result!.current.id).toBe('new-1');
    // Album-wide swap covers the two changed tracks but NOT the unchanged one.
    expect(result!.swaps.get('old-1')?.id).toBe('new-1');
    expect(result!.swaps.get('old-2')?.id).toBe('new-2');
    expect(result!.swaps.has('unchanged-3')).toBe(false);
  });

  it('includes the current track in the swap map even when album was not previously cached', async () => {
    // No mockAlbums entry — the album wasn't cached before.
    mockFetchAlbum.mockResolvedValue({
      id: 'a1',
      song: [makeSong({ id: 'fresh-only', title: 'T', artist: 'A' })],
    });
    const stale = makeSong({ id: 'orphan-old', albumId: 'a1', title: 'T', artist: 'A' });

    const result = await recoverStaleSongId(stale);
    expect(result!.swaps.get('orphan-old')?.id).toBe('fresh-only');
  });

  it('persists each swap via rename + SQL remap', async () => {
    mockAlbums['a1'] = {
      album: { id: 'a1', song: [makeSong({ id: 'old-1', title: 'T', artist: 'A', suffix: 'flac' })] },
    };
    mockFetchAlbum.mockResolvedValue({
      id: 'a1',
      song: [makeSong({ id: 'new-1', title: 'T', artist: 'A', suffix: 'flac' })],
    });
    mockRename.mockReturnValue('renamed');
    mockRemap.mockReturnValue(true);

    const stale = makeSong({ id: 'old-1', albumId: 'a1', title: 'T', artist: 'A' });
    await recoverStaleSongId(stale);

    expect(mockRename).toHaveBeenCalledWith('a1', 'old-1', 'new-1', 'flac');
    expect(mockRemap).toHaveBeenCalled();
  });

  it('skips SQL remap when the file rename reports missing', async () => {
    // 'missing' means the song was never downloaded — no SQL row exists either.
    mockAlbums['a1'] = {
      album: { id: 'a1', song: [makeSong({ id: 'old-1', title: 'T', artist: 'A', suffix: 'mp3' })] },
    };
    mockFetchAlbum.mockResolvedValue({
      id: 'a1',
      song: [makeSong({ id: 'new-1', title: 'T', artist: 'A', suffix: 'mp3' })],
    });
    mockRename.mockReturnValue('missing');

    await recoverStaleSongId(makeSong({ id: 'old-1', albumId: 'a1', title: 'T', artist: 'A' }));

    expect(mockRename).toHaveBeenCalled();
    expect(mockRemap).not.toHaveBeenCalled();
  });

  it('skips SQL remap when the file rename fails (avoids orphaning the row)', async () => {
    mockAlbums['a1'] = {
      album: { id: 'a1', song: [makeSong({ id: 'old-1', title: 'T', artist: 'A', suffix: 'mp3' })] },
    };
    mockFetchAlbum.mockResolvedValue({
      id: 'a1',
      song: [makeSong({ id: 'new-1', title: 'T', artist: 'A', suffix: 'mp3' })],
    });
    mockRename.mockReturnValue('failed');

    await recoverStaleSongId(makeSong({ id: 'old-1', albumId: 'a1', title: 'T', artist: 'A' }));

    expect(mockRemap).not.toHaveBeenCalled();
  });
});

describe('recoverStaleSongId — search3 fallback', () => {
  it('falls back to search3 when album refresh yields no match', async () => {
    mockFetchAlbum.mockResolvedValue({ id: 'a1', song: [] });
    mockSearch3.mockResolvedValue({
      albums: [],
      artists: [],
      songs: [makeSong({ id: 'fresh-from-search', title: 'X', artist: 'A' })],
    });

    const stale = makeSong({ id: 'old-id', albumId: 'a1', title: 'X', artist: 'A' });
    const result = await recoverStaleSongId(stale);
    expect(mockSearch3).toHaveBeenCalledWith('A X');
    expect(result?.current.id).toBe('fresh-from-search');
    // Search3 fallback only swaps the one song, not an album-wide map.
    expect(result?.swaps.size).toBe(1);
    expect(result?.swaps.get('old-id')?.id).toBe('fresh-from-search');
  });

  it('skips fetchAlbum entirely when no albumId is present', async () => {
    const stale = makeSong({ id: 'old', title: 'X', artist: 'A' });
    mockSearch3.mockResolvedValue({
      albums: [],
      artists: [],
      songs: [makeSong({ id: 'fresh', title: 'X', artist: 'A' })],
    });

    await recoverStaleSongId(stale);
    expect(mockFetchAlbum).not.toHaveBeenCalled();
    expect(mockSearch3).toHaveBeenCalled();
  });

  it('returns null when both paths fail', async () => {
    const stale = makeSong({ id: 'old', albumId: 'a1', title: 'X', artist: 'Y' });
    mockFetchAlbum.mockResolvedValue({ id: 'a1', song: [] });
    mockSearch3.mockResolvedValue({ albums: [], artists: [], songs: [] });

    expect(await recoverStaleSongId(stale)).toBeNull();
  });

  it('returns null with no anchor (no album, no title)', async () => {
    const result = await recoverStaleSongId({ id: 'naked', isDir: false, title: '' } as any);
    expect(result).toBeNull();
    expect(mockFetchAlbum).not.toHaveBeenCalled();
    expect(mockSearch3).not.toHaveBeenCalled();
  });

  it('swallows fetchAlbum exceptions and falls through to search3', async () => {
    mockFetchAlbum.mockRejectedValue(new Error('network'));
    mockSearch3.mockResolvedValue({
      albums: [],
      artists: [],
      songs: [makeSong({ id: 'recovered', title: 'X', artist: 'A' })],
    });

    const result = await recoverStaleSongId(
      makeSong({ id: 'old', albumId: 'a1', title: 'X', artist: 'A' }),
    );
    expect(result?.current.id).toBe('recovered');
  });
});
