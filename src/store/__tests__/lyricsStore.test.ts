/**
 * Store behaviour with the `lyrics` table mocked out — the memory → SQL → network
 * ladder, the loading/error maps and the timeout budget. The real-SQL side of the
 * same feature lives in `persistence/__tests__/lyricsWritePath.test.ts`.
 */
jest.mock('../persistence/lyricsTable', () => ({
  __esModule: true,
  loadLyrics: jest.fn(),
  saveLyrics: jest.fn(),
  clearAllLyrics: jest.fn(),
}));
jest.mock('../../services/subsonicService', () => ({
  __esModule: true,
  getLyricsForTrack: jest.fn(),
}));

import { getLyricsForTrack, type LyricsData } from '../../services/subsonicService';
import { clearAllLyrics, loadLyrics, saveLyrics } from '../persistence/lyricsTable';
import { lyricsStore } from '../lyricsStore';

const mockGetLyrics = getLyricsForTrack as jest.MockedFunction<typeof getLyricsForTrack>;
const mockLoad = loadLyrics as jest.MockedFunction<typeof loadLyrics>;
const mockSave = saveLyrics as jest.MockedFunction<typeof saveLyrics>;
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
  mockClearAll.mockResolvedValue(undefined);
  // Reset the session cache directly — going through `clearLyrics` would count
  // against the `clearAllLyrics` assertions below.
  lyricsStore.setState({ entries: {}, loading: {}, errors: {} });
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
    expect(mockSave).toHaveBeenCalledWith('t1', sample);
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
    expect(mockSave).toHaveBeenNthCalledWith(1, 't1', sample);
    expect(mockSave).toHaveBeenNthCalledWith(2, 't2', other);
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
