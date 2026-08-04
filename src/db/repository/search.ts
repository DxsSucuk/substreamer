/**
 * Tiered candidate generation for local fuzzy search over the normalized
 * `songs`/`albums`/`artists` tables (which carry `norm_*`/`dmeta_*` columns).
 * The sole search-candidate source (replaced the old blob-based path). Casts a wide, per-tier-capped
 * net (exact → prefix → infix on `norm_*` → phonetic on `dmeta_*`), deduped in
 * tier-priority order. Returns the same projected rows the list reads return (children
 * hydrated once over the deduped set); the precision re-rank stays in
 * `searchService`. Callers pass the already-normalized query, its word tokens, and
 * the non-empty per-token Double-Metaphone codes (same contract as the legacy fns).
 */
import type { InternalDb } from '../client';
import { ALBUM_LIST_COLS, hydrateAlbumRows, type AlbumListRow } from './albums';
import { ARTIST_LIST_COLS, hydrateArtistRows, type ArtistListRow } from './artists';
import { SONG_LIST_COLS, hydrateSongRows, type SongListRow } from './songs';

// Per-tier row caps: exact is near-unique; looser tiers bounded so a one-letter
// token can't drag the whole library into JS.
const CAP_EXACT = 50;
const CAP_PREFIX = 60;
const CAP_INFIX = 80;
const CAP_PHONETIC = 60;

/** OR-joined LIKE clause + `%token%` params across columns; null when no tokens. */
function infixClause(
  columns: readonly string[],
  tokens: readonly string[],
): { sql: string; params: string[] } | null {
  if (tokens.length === 0) return null;
  const parts: string[] = [];
  const params: string[] = [];
  for (const col of columns) {
    for (const t of tokens) {
      parts.push(`${col} LIKE ?`);
      params.push(`%${t}%`);
    }
  }
  return { sql: parts.join(' OR '), params };
}

interface SearchConfig<R> {
  table: string;
  columns: string;
  exactCol: string; // norm_title / norm_name
  normCols: readonly string[]; // e.g. [norm_title, norm_artist]
  dmetaCols: readonly string[]; // e.g. [dmeta_title, dmeta_artist]
  /** Attach the entity's array children to the deduped result — ONE batched query per
   *  child table for the whole candidate set, not per tier. */
  hydrate: (db: InternalDb, rows: R[]) => Promise<void>;
}

/** Run the capped tiers for one entity, deduping by id in tier-priority order. */
async function candidates<R extends { id: string }>(
  db: InternalDb,
  cfg: SearchConfig<R>,
  norm: string,
  tokens: readonly string[],
  dmetaTokens: readonly string[],
): Promise<R[]> {
  if (!norm) return [];
  const out: R[] = [];
  const seen = new Set<string>();
  const push = (rows: R[]): void => {
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  };
  const order = `ORDER BY length(${cfg.exactCol}), "id"`;
  const base = `SELECT ${cfg.columns} FROM "${cfg.table}"`;
  try {
    push(await db.getAllAsync<R>(`${base} WHERE ${cfg.exactCol} = ? ${order} LIMIT ${CAP_EXACT}`, [norm]));
    push(
      await db.getAllAsync<R>(`${base} WHERE ${cfg.exactCol} LIKE ? ${order} LIMIT ${CAP_PREFIX}`, [`${norm}%`]),
    );
    const infix = infixClause(cfg.normCols, tokens);
    if (infix) {
      push(await db.getAllAsync<R>(`${base} WHERE ${infix.sql} ${order} LIMIT ${CAP_INFIX}`, infix.params));
    }
    const phon = infixClause(cfg.dmetaCols, dmetaTokens);
    if (phon) {
      push(await db.getAllAsync<R>(`${base} WHERE ${phon.sql} ${order} LIMIT ${CAP_PHONETIC}`, phon.params));
    }
    // Inside the same best-effort guard: a hydration failure must degrade the rows'
    // fidelity, never fail the search.
    await cfg.hydrate(db, out);
  } catch {
    /* best-effort recall — a malformed query or missing column yields no rows */
  }
  return out;
}

export const searchSongs = (
  db: InternalDb,
  norm: string,
  tokens: readonly string[],
  dmetaTokens: readonly string[],
): Promise<SongListRow[]> =>
  candidates<SongListRow>(
    db,
    {
      table: 'songs',
      columns: SONG_LIST_COLS,
      exactCol: 'norm_title',
      normCols: ['norm_title', 'norm_artist'],
      dmetaCols: ['dmeta_title', 'dmeta_artist'],
      hydrate: hydrateSongRows,
    },
    norm,
    tokens,
    dmetaTokens,
  );

export const searchAlbums = (
  db: InternalDb,
  norm: string,
  tokens: readonly string[],
  dmetaTokens: readonly string[],
): Promise<AlbumListRow[]> =>
  candidates<AlbumListRow>(
    db,
    {
      table: 'albums',
      columns: ALBUM_LIST_COLS,
      exactCol: 'norm_name',
      normCols: ['norm_name', 'norm_artist'],
      dmetaCols: ['dmeta_name', 'dmeta_artist'],
      hydrate: hydrateAlbumRows,
    },
    norm,
    tokens,
    dmetaTokens,
  );

export const searchArtists = (
  db: InternalDb,
  norm: string,
  tokens: readonly string[],
  dmetaTokens: readonly string[],
): Promise<ArtistListRow[]> =>
  candidates<ArtistListRow>(
    db,
    {
      table: 'artists',
      columns: ARTIST_LIST_COLS,
      exactCol: 'norm_name',
      normCols: ['norm_name'],
      dmetaCols: ['dmeta_name'],
      hydrate: hydrateArtistRows,
    },
    norm,
    tokens,
    dmetaTokens,
  );

/** True iff the normalized song table has any rows — the routing gate for "do we have
 *  a local corpus to search, or go straight to the server?". Songs-only, matching the
 *  legacy `song_index`-only gate it replaces. Best-effort: any error → no corpus. */
export const hasLocalCorpus = async (db: InternalDb): Promise<boolean> => {
  try {
    return (await db.getFirstAsync<{ x: number }>('SELECT 1 AS x FROM songs LIMIT 1')) != null;
  } catch {
    return false;
  }
};
