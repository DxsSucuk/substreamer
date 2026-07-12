/**
 * Per-row SQLite persistence for `completedScrobbleStore` — query helpers
 * only. The shared handle, PRAGMAs, schema, health reporting, and test
 * injection live in `./db.ts`.
 *
 * Writes become silent no-ops when `getDb()` returns null (DB init failed)
 * — callers don't need to handle exceptions.
 */
import { getDb, serializeDbWrite } from './db';
import { type CompletedScrobble } from '../completedScrobbleStore';

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

/**
 * Read every scrobble row in time order. Used once on app start to hydrate
 * `completedScrobbleStore.completedScrobbles`. Unparseable rows are skipped;
 * invalid rows (missing id / song.id / song.title) are filtered out so the
 * store never sees the same garbage the old `onRehydrateStorage` guarded
 * against.
 */
export function hydrateScrobbles(): CompletedScrobble[] {
  const db = getDb();
  if (db === null) return [];
  try {
    const rows = db.getAllSync<{ id: string; song_json: string; time: number }>(
      'SELECT id, song_json, time FROM scrobble_events ORDER BY time ASC;',
    );
    const out: CompletedScrobble[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
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
      out.push({ id: row.id, song: song as CompletedScrobble['song'], time: row.time });
    }
    return out;
  } catch {
    return [];
  }
}

/** Scrobble rows parsed per macrotask yield during async hydration. */
const SCROBBLE_PARSE_CHUNK = 1000;

/**
 * Async counterpart of {@link hydrateScrobbles}. The read runs on
 * expo-sqlite's background thread (`getAllAsync`) and the per-row
 * `JSON.parse(song_json)` is chunked with `setTimeout(0)` yields so a large
 * scrobble history doesn't freeze the JS thread at boot. setTimeout, not
 * rAF — rAF can stall on RN 0.85/Fabric.
 */
export async function hydrateScrobblesAsync(): Promise<CompletedScrobble[]> {
  const db = getDb();
  if (db === null) return [];
  try {
    const rows = await db.getAllAsync<{ id: string; song_json: string; time: number }>(
      'SELECT id, song_json, time FROM scrobble_events ORDER BY time ASC;',
    );
    const out: CompletedScrobble[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (i > 0 && i % SCROBBLE_PARSE_CHUNK === 0) {
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
      out.push({ id: row.id, song: song as CompletedScrobble['song'], time: row.time });
    }
    return out;
  } catch {
    return [];
  }
}

/** Return the total scrobble row count. Used by diagnostics. */
export async function countScrobbles(): Promise<number> {
  const db = getDb();
  if (db === null) return 0;
  try {
    const row = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM scrobble_events;');
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/*  Writes                                                             */
/* ------------------------------------------------------------------ */

/**
 * Insert one scrobble. Uses INSERT OR IGNORE so re-inserting the same id is a
 * silent no-op (the store already dedupes in memory but this protects against
 * concurrent-call edge cases without throwing).
 */
export async function insertScrobble(scrobble: CompletedScrobble): Promise<void> {
  const db = getDb();
  if (db === null) return;
  if (!scrobble.id || !scrobble.song?.id || !scrobble.song.title) return;
  try {
    await serializeDbWrite(() =>
      db.runAsync(
        'INSERT OR IGNORE INTO scrobble_events (id, song_json, time) VALUES (?, ?, ?);',
        [scrobble.id, JSON.stringify(scrobble.song), scrobble.time],
      ),
    );
  } catch {
    /* dropped */
  }
}

/**
 * Merge the given scrobbles into the existing set, INSERT OR IGNORE per row.
 * Used by merge-mode backup restore so a backup from another device unifies
 * with locally-accumulated scrobbles instead of replacing them.
 *
 * Invalid records are filtered before insertion. Returns `{ added, skipped }`
 * where `added` is the number of rows actually inserted (not already present)
 * and `skipped` is the number of inputs ignored (duplicates or invalid).
 */
export async function mergeScrobbles(
  scrobbles: readonly CompletedScrobble[],
): Promise<{ added: number; skipped: number }> {
  const db = getDb();
  if (db === null) return { added: 0, skipped: scrobbles.length };
  try {
    const before = await countScrobbles();
    await serializeDbWrite(() =>
      db.withTransactionAsync(async () => {
        const seen = new Set<string>();
        for (const s of scrobbles) {
          if (!s?.id || !s.song?.id || !s.song.title) continue;
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          // eslint-disable-next-line no-await-in-loop
          await db.runAsync(
            'INSERT OR IGNORE INTO scrobble_events (id, song_json, time) VALUES (?, ?, ?);',
            [s.id, JSON.stringify(s.song), s.time],
          );
        }
      }),
    );
    const after = await countScrobbles();
    const added = Math.max(0, after - before);
    return { added, skipped: scrobbles.length - added };
  } catch {
    return { added: 0, skipped: scrobbles.length };
  }
}

/**
 * Wipe and bulk-insert the full scrobble set inside a single transaction.
 * Used by backup restore and the one-shot blob → per-row migration (task #13).
 * Invalid/duplicate records are filtered before insertion.
 */
export async function replaceAllScrobbles(scrobbles: readonly CompletedScrobble[]): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await serializeDbWrite(() =>
      db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM scrobble_events;');
        const seen = new Set<string>();
        for (const s of scrobbles) {
          if (!s?.id || !s.song?.id || !s.song.title) continue;
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          // eslint-disable-next-line no-await-in-loop
          await db.runAsync(
            'INSERT OR IGNORE INTO scrobble_events (id, song_json, time) VALUES (?, ?, ?);',
            [s.id, JSON.stringify(s.song), s.time],
          );
        }
      }),
    );
  } catch {
    /* dropped */
  }
}

/** Remove every row. Used on logout / server switch via resetAllStores. */
export async function clearScrobbles(): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await serializeDbWrite(() => db.runAsync('DELETE FROM scrobble_events;'));
  } catch {
    /* dropped */
  }
}
