/**
 * Per-row SQLite persistence for `pendingScrobbleStore` — query helpers
 * only. Mirrors `scrobbleTable.ts` (completed scrobbles) so the pair
 * stays on a single consistent model.
 *
 * Writes become silent no-ops when `getDb()` returns null (DB init failed)
 * — callers don't need to handle exceptions.
 */
import { getDb, serializeDbWrite } from './db';
import { type PendingScrobble } from '../pendingScrobbleStore';

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

/** Pending rows parsed per macrotask yield during async hydration. */
const PENDING_PARSE_CHUNK = 1000;

/**
 * Read every pending scrobble row in time order on the background thread, with
 * chunked `JSON.parse` + `setTimeout(0)` yields so the boot path doesn't block
 * the JS thread (setTimeout, not rAF — rAF can stall on RN 0.85/Fabric).
 * Unparseable rows are skipped; invalid rows (missing id / song.id / song.title)
 * are filtered so the store never sees garbage. Used by `rehydrateAllStores`.
 */
export async function hydratePendingScrobblesAsync(): Promise<PendingScrobble[]> {
  const db = getDb();
  if (db === null) return [];
  try {
    const rows = await db.getAllAsync<{ id: string; song_json: string; time: number }>(
      'SELECT id, song_json, time FROM pending_scrobble_events ORDER BY time ASC;',
    );
    const out: PendingScrobble[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (i > 0 && i % PENDING_PARSE_CHUNK === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (!row.id || seen.has(row.id)) continue;
      let song: unknown;
      try {
        song = JSON.parse(row.song_json);
      } catch {
        continue;
      }
      if (
        !song ||
        typeof song !== 'object' ||
        !(song as { id?: unknown }).id ||
        !(song as { title?: unknown }).title
      ) {
        continue;
      }
      seen.add(row.id);
      out.push({ id: row.id, song: song as PendingScrobble['song'], time: row.time });
    }
    return out;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  Writes                                                             */
/* ------------------------------------------------------------------ */

/**
 * Insert one pending scrobble. Uses INSERT OR IGNORE so re-inserting
 * the same id is a silent no-op (the store already dedupes in memory
 * but this protects against concurrent-call edge cases without throwing).
 */
export async function insertPendingScrobble(scrobble: PendingScrobble): Promise<void> {
  const db = getDb();
  if (db === null) return;
  if (!scrobble.id || !scrobble.song?.id || !scrobble.song.title) return;
  try {
    await serializeDbWrite(() =>
      db.runAsync(
        'INSERT OR IGNORE INTO pending_scrobble_events (id, song_json, time) VALUES (?, ?, ?);',
        [scrobble.id, JSON.stringify(scrobble.song), scrobble.time],
      ),
    );
  } catch {
    /* dropped */
  }
}

/**
 * Remove a single pending scrobble row. Called from
 * `scrobbleService.processScrobbles` after a successful server
 * submission (or when the item is already in the completed store).
 */
export async function deletePendingScrobble(id: string): Promise<void> {
  const db = getDb();
  if (db === null || !id) return;
  try {
    await serializeDbWrite(() =>
      db.runAsync('DELETE FROM pending_scrobble_events WHERE id = ?;', [id]),
    );
  } catch {
    /* dropped */
  }
}

/**
 * Wipe and bulk-insert the full pending set inside a single
 * transaction. Used by the one-shot blob → per-row migration.
 * Invalid/duplicate records are filtered before insertion.
 */
export async function replaceAllPendingScrobbles(
  scrobbles: readonly PendingScrobble[],
): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await serializeDbWrite(() =>
      db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM pending_scrobble_events;');
        const seen = new Set<string>();
        for (const s of scrobbles) {
          if (!s?.id || !s.song?.id || !s.song.title) continue;
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          // eslint-disable-next-line no-await-in-loop
          await db.runAsync(
            'INSERT OR IGNORE INTO pending_scrobble_events (id, song_json, time) VALUES (?, ?, ?);',
            [s.id, JSON.stringify(s.song), s.time],
          );
        }
      }),
    );
  } catch {
    /* dropped */
  }
}

/** Remove every row. Used on logout via resetAllStores. */
export async function clearPendingScrobbles(): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await serializeDbWrite(() => db.runAsync('DELETE FROM pending_scrobble_events;'));
  } catch {
    /* dropped */
  }
}
