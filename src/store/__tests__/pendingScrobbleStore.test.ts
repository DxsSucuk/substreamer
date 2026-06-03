// The store delegates persistence to `pendingScrobbleTable`. Tests mock that
// module so we can assert the wiring (SQL calls happen at the right moments)
// without needing a real SQLite handle.
jest.mock('../persistence/pendingScrobbleTable', () => ({
  insertPendingScrobble: jest.fn(),
  deletePendingScrobble: jest.fn(),
  clearPendingScrobbles: jest.fn(),
  hydratePendingScrobblesAsync: jest.fn(async () => []),
}));
jest.mock('../../services/subsonicService');

import {
  clearPendingScrobbleTable,
  pendingScrobbleStore,
  type PendingScrobble,
} from '../pendingScrobbleStore';
import {
  clearPendingScrobbles,
  deletePendingScrobble,
  hydratePendingScrobblesAsync,
  insertPendingScrobble,
} from '../persistence/pendingScrobbleTable';

const mockInsert = insertPendingScrobble as jest.Mock;
const mockDelete = deletePendingScrobble as jest.Mock;
const mockClear = clearPendingScrobbles as jest.Mock;
const mockHydrate = hydratePendingScrobblesAsync as jest.Mock;

beforeEach(() => {
  pendingScrobbleStore.setState({ pendingScrobbles: [], hasHydrated: false });
  mockInsert.mockClear();
  mockDelete.mockClear();
  mockClear.mockClear();
  mockHydrate.mockReset();
  mockHydrate.mockResolvedValue([]);
  mockHydrate.mockReturnValue([]);
});

describe('addScrobble', () => {
  it('adds a valid song to the queue and writes through to SQL', () => {
    pendingScrobbleStore.getState().addScrobble(
      { id: 's1', title: 'Song' } as any,
      1_700_000_000_000,
    );
    const pending = pendingScrobbleStore.getState().pendingScrobbles;
    expect(pending).toHaveLength(1);
    expect(pending[0].song.id).toBe('s1');
    expect(pending[0].id).toBeTruthy();
    expect(pending[0].time).toBe(1_700_000_000_000);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledWith(pending[0]);
  });

  it('rejects when song has no id and does not touch SQL', () => {
    pendingScrobbleStore.getState().addScrobble(
      { title: 'Song' } as any,
      Date.now(),
    );
    expect(pendingScrobbleStore.getState().pendingScrobbles).toHaveLength(0);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects when song has no title and does not touch SQL', () => {
    pendingScrobbleStore.getState().addScrobble(
      { id: 's1' } as any,
      Date.now(),
    );
    expect(pendingScrobbleStore.getState().pendingScrobbles).toHaveLength(0);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects null song and does not touch SQL', () => {
    pendingScrobbleStore.getState().addScrobble(null as any, Date.now());
    expect(pendingScrobbleStore.getState().pendingScrobbles).toHaveLength(0);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('adds multiple scrobbles with write-through per call', () => {
    pendingScrobbleStore.getState().addScrobble({ id: 's1', title: 'A' } as any, 1000);
    pendingScrobbleStore.getState().addScrobble({ id: 's2', title: 'B' } as any, 2000);
    expect(pendingScrobbleStore.getState().pendingScrobbles).toHaveLength(2);
    expect(mockInsert).toHaveBeenCalledTimes(2);
  });

  it('generated id follows `${time}-${rand}` shape', () => {
    pendingScrobbleStore.getState().addScrobble({ id: 's1', title: 'A' } as any, 1234);
    const id = pendingScrobbleStore.getState().pendingScrobbles[0].id;
    expect(id).toMatch(/^1234-[a-z0-9]+$/);
  });
});

describe('removeScrobble', () => {
  it('removes a scrobble by id and writes through to SQL', () => {
    pendingScrobbleStore.getState().addScrobble({ id: 's1', title: 'A' } as any, 1000);
    const id = pendingScrobbleStore.getState().pendingScrobbles[0].id;
    pendingScrobbleStore.getState().removeScrobble(id);
    expect(pendingScrobbleStore.getState().pendingScrobbles).toHaveLength(0);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith(id);
  });

  it('is a no-op for nonexistent id (still calls SQL delete)', () => {
    pendingScrobbleStore.getState().addScrobble({ id: 's1', title: 'A' } as any, 1000);
    pendingScrobbleStore.getState().removeScrobble('nonexistent');
    expect(pendingScrobbleStore.getState().pendingScrobbles).toHaveLength(1);
    expect(mockDelete).toHaveBeenCalledWith('nonexistent');
  });

  it('empty-string id is a no-op and does not touch SQL', () => {
    pendingScrobbleStore.getState().addScrobble({ id: 's1', title: 'A' } as any, 1000);
    pendingScrobbleStore.getState().removeScrobble('');
    expect(pendingScrobbleStore.getState().pendingScrobbles).toHaveLength(1);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('only removes the matching scrobble', () => {
    pendingScrobbleStore.getState().addScrobble({ id: 's1', title: 'A' } as any, 1000);
    pendingScrobbleStore.getState().addScrobble({ id: 's2', title: 'B' } as any, 2000);
    const firstId = pendingScrobbleStore.getState().pendingScrobbles[0].id;
    pendingScrobbleStore.getState().removeScrobble(firstId);
    expect(pendingScrobbleStore.getState().pendingScrobbles).toHaveLength(1);
    expect(pendingScrobbleStore.getState().pendingScrobbles[0].song.id).toBe('s2');
  });
});

describe('clearAll', () => {
  it('wipes in-memory state and the SQL table', () => {
    pendingScrobbleStore.getState().addScrobble({ id: 's1', title: 'A' } as any, 1000);
    pendingScrobbleStore.getState().addScrobble({ id: 's2', title: 'B' } as any, 2000);
    pendingScrobbleStore.getState().clearAll();
    expect(pendingScrobbleStore.getState().pendingScrobbles).toEqual([]);
    expect(mockClear).toHaveBeenCalledTimes(1);
  });
});

describe('hydrateFromDbAsync', () => {
  it('loads rows from SQL and flips hasHydrated', async () => {
    const rows: PendingScrobble[] = [
      { id: 'a', song: { id: 's1', title: 'A' } as any, time: 1 },
      { id: 'b', song: { id: 's2', title: 'B' } as any, time: 2 },
    ];
    mockHydrate.mockResolvedValue(rows);

    await pendingScrobbleStore.getState().hydrateFromDbAsync();

    const state = pendingScrobbleStore.getState();
    expect(state.hasHydrated).toBe(true);
    expect(state.pendingScrobbles).toEqual(rows);
  });

  it('is idempotent — second call re-reads and produces the same state', async () => {
    mockHydrate.mockResolvedValue([
      { id: 'a', song: { id: 's1', title: 'A' } as any, time: 1 },
    ]);

    await pendingScrobbleStore.getState().hydrateFromDbAsync();
    await pendingScrobbleStore.getState().hydrateFromDbAsync();

    expect(mockHydrate).toHaveBeenCalledTimes(2);
    expect(pendingScrobbleStore.getState().pendingScrobbles).toHaveLength(1);
    expect(pendingScrobbleStore.getState().hasHydrated).toBe(true);
  });

  it('hydrates empty when SQL returns no rows', async () => {
    mockHydrate.mockResolvedValue([]);
    await pendingScrobbleStore.getState().hydrateFromDbAsync();
    const state = pendingScrobbleStore.getState();
    expect(state.hasHydrated).toBe(true);
    expect(state.pendingScrobbles).toEqual([]);
  });
});

describe('clearPendingScrobbleTable', () => {
  it('proxies to clearPendingScrobbles on the persistence module', () => {
    clearPendingScrobbleTable();
    expect(mockClear).toHaveBeenCalledTimes(1);
  });
});
