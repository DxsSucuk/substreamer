/**
 * Recompute every stored A–Z sort key, once per key-format version.
 *
 * `getSortKey` now drops leading punctuation (`"Heroes"` files under H, not `#`), and the
 * keys are derived at WRITE time — so every row written by an earlier build carries a key
 * that files it under the wrong letter, and the alphabet scroller, which computes its
 * letter live, disagrees with where the row actually sits.
 *
 * Recomputed from each row's OWN stored `name`/`sort_name`/`artist`, so this needs no
 * network and no resync — a resync could not do it anyway without also refetching
 * playlist membership and artist bios, which are unaffected.
 *
 * SORT KEYS ONLY. `norm_*`/`dmeta_*` come from `normTitle`/`metaphoneKeyFromNormalized`,
 * not `getSortKey`, so search is untouched and must stay out of this pass.
 *
 * OFF the boot path (idle-scheduled from `_layout.tsx`), chunked with a macrotask yield
 * between chunks, and RESUMABLE: the (table, last id) cursor is persisted after each
 * committed chunk, so a kill mid-pass resumes where it stopped. Idempotent — a re-run
 * over an already-converted row writes the same value.
 */
import { getSortArticles } from '../db/sortArticles';
import {
  albumSortKeys,
  artistSortTitle,
  playlistSortTitle,
  songSortKeys,
  type AlbumSortSource,
} from '../db/sortKeys';
import { errMessage } from '../utils/errorMessage';
import { getDb, type BatchCommand, type InternalDb } from '../store/persistence/db';
import { kvStorage } from '../store/persistence';

/** Bump when `getSortKey` changes what it produces, or when a table joins the pass —
 *  every install then rebuilds once. */
const REBUILD_VERSION = 3;
const STATE_KEY = 'substreamer-sort-key-rebuild';

/** Matches `bulkUpsert`'s chunk size: 500 single-row UPDATEs in one atomic batch. */
const CHUNK = 500;

/** Resume point. `complete` is the terminal state; until then `(tableIndex, lastId)` is
 *  the keyset cursor into `SPECS[tableIndex]`. */
interface RebuildState {
  version: number;
  complete?: boolean;
  tableIndex?: number;
  lastId?: string;
}

/** One table's rebuild: what to read, and the `sort_*` values for a row. */
interface RebuildSpec {
  table: string;
  /** Primary key — `item_id` on the download tables, `id` everywhere else. */
  idCol: string;
  /** Columns the derivation reads, beyond the id. */
  columns: readonly string[];
  /** Column → new value. An empty map skips the row (an unparseable envelope). */
  keysOf: (row: Record<string, unknown>, articles?: readonly string[]) => Record<string, string>;
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The stored album columns as an `AlbumSortSource`. `display_artist` is already
 *  `displayArtist ?? artist` at write time, so the chain resolves identically. */
const albumSourceOf = (r: Record<string, unknown>): AlbumSortSource => ({
  name: text(r.name),
  sortName: text(r.sort_name),
  artist: text(r.artist),
  displayArtist: text(r.display_artist),
});

/** The `favorite_*` remainder keeps the verbatim server envelope, so the inputs are in
 *  `json`. Unparseable rows are skipped — their keys stay NULL and they sort first,
 *  which is what a row with no key does anyway. */
function parseEnvelope(row: Record<string, unknown>): Record<string, unknown> | null {
  const raw = text(row.json);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const ALBUM_COLUMNS = ['name', 'sort_name', 'artist', 'display_artist'] as const;

/**
 * Ordered so the cheap tables finish first and a resumed pass makes visible progress
 * early; `songs` (the ~30k-row one on a large library) is last for the same reason.
 */
const SPECS: readonly RebuildSpec[] = [
  {
    table: 'albums',
    idCol: 'id',
    columns: ALBUM_COLUMNS,
    keysOf: (r, articles) => albumSortKeys(albumSourceOf(r), articles),
  },
  {
    table: 'artists',
    idCol: 'id',
    columns: ['name', 'sort_name'],
    keysOf: (r, articles): Record<string, string> => ({
      sort_title: artistSortTitle({ name: text(r.name), sortName: text(r.sort_name) }, articles),
    }),
  },
  {
    table: 'playlists',
    idCol: 'id',
    columns: ['name'],
    keysOf: (r, articles): Record<string, string> => ({
      sort_title: playlistSortTitle({ name: text(r.name) }, articles),
    }),
  },
  {
    table: 'favorite_albums',
    idCol: 'id',
    columns: ['json'],
    keysOf: (r, articles): Record<string, string> => {
      const a = parseEnvelope(r);
      return a
        ? albumSortKeys(
            {
              name: text(a.name),
              sortName: text(a.sortName),
              artist: text(a.artist),
              displayArtist: text(a.displayArtist),
            },
            articles,
          )
        : {};
    },
  },
  {
    table: 'favorite_artists',
    idCol: 'id',
    columns: ['json'],
    keysOf: (r, articles): Record<string, string> => {
      const a = parseEnvelope(r);
      return a
        ? { sort_title: artistSortTitle({ name: text(a.name), sortName: text(a.sortName) }, articles) }
        : {};
    },
  },
  {
    table: 'favorite_songs',
    idCol: 'id',
    columns: ['json'],
    keysOf: (r, articles): Record<string, string> => {
      const c = parseEnvelope(r);
      return c
        ? songSortKeys(
            { title: text(c.title), sortName: text(c.sortName), artist: text(c.artist) },
            articles,
          )
        : {};
    },
  },
  {
    table: 'cached_albums',
    idCol: 'item_id',
    columns: ALBUM_COLUMNS,
    keysOf: (r, articles) => albumSortKeys(albumSourceOf(r), articles),
  },
  {
    table: 'cached_playlists',
    idCol: 'item_id',
    columns: ['name'],
    keysOf: (r, articles): Record<string, string> => ({
      sort_title: playlistSortTitle({ name: text(r.name) }, articles),
    }),
  },
  {
    table: 'cached_songs',
    idCol: 'song_id',
    columns: ['title', 'sort_name', 'artist'],
    keysOf: (r, articles) =>
      songSortKeys(
        { title: text(r.title), sortName: text(r.sort_name), artist: text(r.artist) },
        articles,
      ),
  },
  {
    table: 'songs',
    idCol: 'id',
    columns: ['title', 'sort_name', 'artist'],
    keysOf: (r, articles) =>
      songSortKeys(
        { title: text(r.title), sortName: text(r.sort_name), artist: text(r.artist) },
        articles,
      ),
  },
];

async function readState(): Promise<RebuildState | null> {
  try {
    const raw = await kvStorage.getItem(STATE_KEY);
    return raw ? (JSON.parse(raw) as RebuildState) : null;
  } catch {
    return null;
  }
}

const writeState = async (s: RebuildState): Promise<void> => {
  await kvStorage.setItem(STATE_KEY, JSON.stringify(s));
};

const yieldMacrotask = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Rebuild one table from `lastId` (exclusive) to the end, persisting the cursor after
 * every committed chunk. Keyset on the primary key, so each chunk is an index range scan
 * and a resume costs one seek rather than an offset walk.
 */
async function rebuildTable(
  db: InternalDb,
  spec: RebuildSpec,
  tableIndex: number,
  startAfter: string,
): Promise<number> {
  const articles = getSortArticles();
  const cols = [spec.idCol, ...spec.columns].map((c) => `"${c}"`).join(', ');
  const sql =
    `SELECT ${cols} FROM "${spec.table}" WHERE "${spec.idCol}" > ? ` +
    `ORDER BY "${spec.idCol}" LIMIT ${CHUNK}`;
  let cursor = startAfter;
  let done = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await db.getAllAsync<Record<string, unknown>>(sql, [cursor]);
    if (rows.length === 0) return done;
    const commands: BatchCommand[] = [];
    for (const row of rows) {
      const keys = spec.keysOf(row, articles);
      const names = Object.keys(keys);
      if (names.length === 0) continue;
      commands.push([
        `UPDATE "${spec.table}" SET ${names.map((n) => `"${n}" = ?`).join(', ')} ` +
          `WHERE "${spec.idCol}" = ?`,
        [...names.map((n) => keys[n]), String(row[spec.idCol])],
      ]);
    }
    // All-or-nothing per chunk, so the cursor below can never claim rows that were not
    // written. A re-run of an already-written chunk recomputes the same values.
    if (commands.length > 0) await db.runAtomicBatchAsync(commands);
    cursor = String(rows[rows.length - 1][spec.idCol]);
    done += rows.length;
    // eslint-disable-next-line no-await-in-loop
    await writeState({ version: REBUILD_VERSION, tableIndex, lastId: cursor });
    // eslint-disable-next-line no-await-in-loop
    await yieldMacrotask();
  }
}

let inFlight: Promise<void> | null = null;

/**
 * Rebuild the stored sort keys if this install has not done so for the current key
 * format. Safe to call on every launch: it returns immediately once complete, and a run
 * already in flight is shared rather than started twice.
 */
export function runSortKeyRebuildIfNeeded(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const db = getDb();
      if (!db) return;
      const state = await readState();
      if (state?.version === REBUILD_VERSION && state.complete) return;
      // A state from an older format is a cursor into a rebuild that is no longer the one
      // we want — restart from the first table rather than resuming into it.
      const resumable = state?.version === REBUILD_VERSION ? state : null;
      let index = resumable?.tableIndex ?? 0;
      let lastId = resumable?.lastId ?? '';
      for (; index < SPECS.length; index++) {
        // eslint-disable-next-line no-await-in-loop
        await rebuildTable(db, SPECS[index], index, lastId);
        lastId = '';
      }
      await writeState({ version: REBUILD_VERSION, complete: true });
    } catch (e) {
      // Leave the cursor where it is; the next launch resumes from there.
      // eslint-disable-next-line no-console
      console.warn('[sort-key-rebuild] failed', errMessage(e));
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Test seam: drop the shared in-flight promise between cases. */
export const __resetSortKeyRebuildForTests = (): void => {
  inFlight = null;
};
