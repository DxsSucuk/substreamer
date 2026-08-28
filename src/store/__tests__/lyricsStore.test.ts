/**
 * Store behaviour with the `lyrics` table mocked out — the memory → SQL → network
 * ladder, the loading/error maps and the timeout budget. The real-SQL side of the
 * same feature lives in `persistence/__tests__/lyricsWritePath.test.ts`.
 */
jest.mock('../persistence/lyricsTable', () => ({
  __esModule: true,
  loadLyrics: jest.fn(),
  saveLyrics: jest.fn(),
  deleteLyrics: jest.fn(),
  clearAllLyrics: jest.fn(),
}));
jest.mock('../../services/subsonicService', () => ({
  __esModule: true,
  getLyricsForTrack: jest.fn(),
}));

import { getLyricsForTrack, type LyricsData } from '../../services/subsonicService';
import { clearAllLyrics, deleteLyrics, loadLyrics, saveLyrics } from '../persistence/lyricsTable';
import { lyricsStore } from '../lyricsStore';

const mockGetLyrics = getLyricsForTrack as jest.MockedFunction<typeof getLyricsForTrack>;
const mockLoad = loadLyrics as jest.MockedFunction<typeof loadLyrics>;
const mockSave = saveLyrics as jest.MockedFunction<typeof saveLyrics>;
const mockDelete = deleteLyrics as jest.MockedFunction<typeof deleteLyrics>;
const mockClearAll = clearAllLyrics as jest.MockedFunction<typeof clearAllLyrics>;

const sample: LyricsData = {
  synced: true,
  lines: [
    { startMs: 0, text: 'one' },
    { startMs: 2000, text: 'two' },
  ],
  offsetMs: 0,
  source: 'structured',
  lang: 'en',
};

/** Let the awaited `loadLyrics` continuation run before advancing fake timers. */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  jest.clearAllMocks();
  mockLoad.mockResolvedValue(null);
  mockSave.mockResolvedValue(undefined);
  mockDelete.mockResolvedValue(undefined);
  mockClearAll.mockResolvedValue(undefined);
  // Reset the session cache directly — going through `clearLyrics` would count
  // against the `clearAllLyrics` assertions below.
  lyricsStore.setState({ entries: {}, loading: {}, errors: {}, revision: 0 });
});

describe('lyricsStore.fetchLyrics', () => {
  it('populates entries on successful fetch, writes one row, and clears loading', async () => {
    mockGetLyrics.mockResolvedValue(sample);

    const result = await lyricsStore.getState().fetchLyrics('t1', 'A', 'B');

    expect(result).toBe(sample);
    expect(lyricsStore.getState().entries['t1']).toBe(sample);
    expect(lyricsStore.getState().loading['t1']).toBeUndefined();
    expect(lyricsStore.getState().errors['t1']).toBeUndefined();
    expect(mockGetLyrics).toHaveBeenCalledWith('t1', 'A', 'B');
    // The row captures the names so the browser can label it and replay the
    // classic artist+title lookup on refresh.
    expect(mockSave).toHaveBeenCalledWith('t1', sample, 'B', 'A');
  });

  it('returns the memory entry without touching SQL or the network', async () => {
    mockGetLyrics.mockResolvedValue(sample);
    await lyricsStore.getState().fetchLyrics('t1', 'A', 'B');
    jest.clearAllMocks();

    const result = await lyricsStore.getState().fetchLyrics('t1', 'A', 'B');

    expect(result).toBe(sample);
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockGetLyrics).not.toHaveBeenCalled();
  });

  it('populates memory from the stored row without a network fetch', async () => {
    mockLoad.mockResolvedValue(sample);

    const result = await lyricsStore.getState().fetchLyrics('t1', 'A', 'B');

    expect(result).toBe(sample);
    expect(lyricsStore.getState().entries['t1']).toBe(sample);
    expect(mockGetLyrics).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('sets loading true during fetch and clears on success', async () => {
    let resolveFn: (value: LyricsData | null) => void;
    mockGetLyrics.mockReturnValue(
      new Promise((resolve) => {
        resolveFn = resolve;
      }),
    );

    const pending = lyricsStore.getState().fetchLyrics('t1', 'A', 'B');
    expect(lyricsStore.getState().loading['t1']).toBe(true);

    await flush();
    resolveFn!(sample);
    await pending;

    expect(lyricsStore.getState().loading['t1']).toBeUndefined();
  });

  it('no error, no entry and no row when the service returns null', async () => {
    mockGetLyrics.mockResolvedValue(null);

    const result = await lyricsStore.getState().fetchLyrics('t1', 'A', 'B');
    expect(result).toBeNull();
    expect(lyricsStore.getState().entries['t1']).toBeUndefined();
    expect(lyricsStore.getState().errors['t1']).toBeUndefined();
    expect(lyricsStore.getState().loading['t1']).toBeUndefined();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('sets error: "timeout" when withTimeout returns timeout sentinel', async () => {
    // Hang past the 15s budget. Use fake timers so we do not actually wait.
    jest.useFakeTimers();
    mockGetLyrics.mockImplementation(() => new Promise(() => {}));

    const pending = lyricsStore.getState().fetchLyrics('t1', 'A', 'B');
    await flush();
    jest.advanceTimersByTime(15_000);
    const result = await pending;

    expect(result).toBeNull();
    expect(lyricsStore.getState().errors['t1']).toBe('timeout');
    expect(lyricsStore.getState().entries['t1']).toBeUndefined();
    expect(lyricsStore.getState().loading['t1']).toBeUndefined();
    jest.useRealTimers();
  });

  it('sets error: "error" when the service throws', async () => {
    mockGetLyrics.mockRejectedValue(new Error('boom'));

    const result = await lyricsStore.getState().fetchLyrics('t1', 'A', 'B');
    expect(result).toBeNull();
    expect(lyricsStore.getState().errors['t1']).toBe('error');
    expect(lyricsStore.getState().loading['t1']).toBeUndefined();
  });

  it('sets error: "error" when the stored-row read throws', async () => {
    mockLoad.mockRejectedValue(new Error('db gone'));

    const result = await lyricsStore.getState().fetchLyrics('t1', 'A', 'B');
    expect(result).toBeNull();
    expect(lyricsStore.getState().errors['t1']).toBe('error');
    expect(mockGetLyrics).not.toHaveBeenCalled();
  });

  it('retry after error clears previous error before new fetch', async () => {
    mockGetLyrics.mockRejectedValueOnce(new Error('boom'));
    await lyricsStore.getState().fetchLyrics('t1', 'A', 'B');
    expect(lyricsStore.getState().errors['t1']).toBe('error');

    mockGetLyrics.mockResolvedValueOnce(sample);
    await lyricsStore.getState().fetchLyrics('t1', 'A', 'B');

    expect(lyricsStore.getState().errors['t1']).toBeUndefined();
    expect(lyricsStore.getState().entries['t1']).toBe(sample);
  });

  it('preserves entries for other tracks when fetching a different one', async () => {
    mockGetLyrics.mockResolvedValue(sample);
    await lyricsStore.getState().fetchLyrics('t1', 'A', 'B');

    const other: LyricsData = { ...sample, lines: [{ startMs: 0, text: 'other' }] };
    mockGetLyrics.mockResolvedValue(other);
    await lyricsStore.getState().fetchLyrics('t2', 'A', 'B');

    expect(lyricsStore.getState().entries['t1']).toBe(sample);
    expect(lyricsStore.getState().entries['t2']).toBe(other);
    expect(mockSave).toHaveBeenNthCalledWith(1, 't1', sample, 'B', 'A');
    expect(mockSave).toHaveBeenNthCalledWith(2, 't2', other, 'B', 'A');
  });
});

describe('lyricsStore.refreshLyrics', () => {
  it('bypasses both caches, refetches and overwrites the row', async () => {
    mockGetLyrics.mockResolvedValue(sample);
    await lyricsStore.getState().fetchLyrics('t1', 'A', 'B');
    jest.clearAllMocks();

    const fresher: LyricsData = { ...sample, synced: false, source: 'classic' };
    mockGetLyrics.mockResolvedValue(fresher);

    const result = await lyricsStore.getState().refreshLyrics('t1', 'A', 'B');

    expect(result).toBe(fresher);
    // Neither the memory hit nor the stored row short-circuited it.
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockGetLyrics).toHaveBeenCalledWith('t1', 'A', 'B');
    expect(mockSave).toHaveBeenCalledWith('t1', fresher, 'B', 'A');
    expect(lyricsStore.getState().entries['t1']).toBe(fresher);
    expect(lyricsStore.getState().loading['t1']).toBeUndefined();
  });

  it('leaves the stored row alone when the server now has no lyrics', async () => {
    mockGetLyrics.mockResolvedValue(sample);
    await lyricsStore.getState().fetchLyrics('t1', 'A', 'B');
    jest.clearAllMocks();
    mockGetLyrics.mockResolvedValue(null);

    expect(await lyricsStore.getState().refreshLyrics('t1', 'A', 'B')).toBeNull();
    expect(mockSave).not.toHaveBeenCalled();
    expect(lyricsStore.getState().entries['t1']).toBe(sample);
  });

  it('sets error: "error" when the refetch throws', async () => {
    mockGetLyrics.mockRejectedValue(new Error('boom'));

    expect(await lyricsStore.getState().refreshLyrics('t1', 'A', 'B')).toBeNull();
    expect(lyricsStore.getState().errors['t1']).toBe('error');
    expect(lyricsStore.getState().loading['t1']).toBeUndefined();
  });

  it('sets error: "timeout" when the refetch outruns the budget', async () => {
    jest.useFakeTimers();
    mockGetLyrics.mockImplementation(() => new Promise(() => {}));

    const pending = lyricsStore.getState().refreshLyrics('t1', 'A', 'B');
    await flush();
    jest.advanceTimersByTime(15_000);

    expect(await pending).toBeNull();
    expect(lyricsStore.getState().errors['t1']).toBe('timeout');
    jest.useRealTimers();
  });
});

describe('lyricsStore.removeLyrics', () => {
  it('drops the memory entry and the row, leaving other tracks alone', async () => {
    mockGetLyrics.mockResolvedValue(sample);
    await lyricsStore.getState().fetchLyrics('t1', 'A', 'B');
    await lyricsStore.getState().fetchLyrics('t2', 'A', 'B');

    await lyricsStore.getState().removeLyrics('t1');

    expect(mockDelete).toHaveBeenCalledWith('t1');
    expect(lyricsStore.getState().entries['t1']).toBeUndefined();
    expect(lyricsStore.getState().entries['t2']).toBe(sample);
  });
});

describe('lyricsStore.revision', () => {
  it('bumps on every table mutation so SQL-derived views re-read', async () => {
    mockGetLyrics.mockResolvedValue(sample);
    const start = lyricsStore.getState().revision;

    await lyricsStore.getState().fetchLyrics('t1', 'A', 'B');
    expect(lyricsStore.getState().revision).toBe(start + 1);

    await lyricsStore.getState().refreshLyrics('t1', 'A', 'B');
    expect(lyricsStore.getState().revision).toBe(start + 2);

    await lyricsStore.getState().removeLyrics('t1');
    expect(lyricsStore.getState().revision).toBe(start + 3);

    await lyricsStore.getState().clearLyrics();
    expect(lyricsStore.getState().revision).toBe(start + 4);
  });

  it('does not bump for a track the server has no lyrics for', async () => {
    mockGetLyrics.mockResolvedValue(null);
    const start = lyricsStore.getState().revision;

    await lyricsStore.getState().fetchLyrics('t1', 'A', 'B');

    expect(lyricsStore.getState().revision).toBe(start);
  });
});

describe('lyricsStore.clearLyrics', () => {
  it('wipes entries, loading and errors, and clears the table', async () => {
    mockGetLyrics.mockRejectedValue(new Error('boom'));
    await lyricsStore.getState().fetchLyrics('t1', 'A', 'B');
    mockGetLyrics.mockResolvedValue(sample);
    await lyricsStore.getState().fetchLyrics('t2', 'A', 'B');

    await lyricsStore.getState().clearLyrics();

    expect(lyricsStore.getState().entries).toEqual({});
    expect(lyricsStore.getState().loading).toEqual({});
    expect(lyricsStore.getState().errors).toEqual({});
    expect(mockClearAll).toHaveBeenCalledTimes(1);
  });
});
