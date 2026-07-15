/**
 * Recall-oriented candidate generation for local fuzzy search over the full
 * synced library (`song_index`, `library_albums`). Casts a wide net cheaply —
 * exact/prefix on the indexed `norm_*` columns, then infix + phonetic over
 * `dmeta_*`, capped per tier. Precision is the JS re-rank's job in
 * `searchService`; the SQL only surfaces a bounded shortlist.
 *
 * NULL columns (rows written before the backfill) still match via exact/prefix
 * on the base columns. Empty dmeta ('') is never matched — the query side only
 * issues dmeta clauses for non-empty codes.
 */
import type { AlbumID3, Child } from '../../services/subsonicService';
import { getDb } from './db';

// Per-tier row caps. Exact is tiny (near-unique); the looser tiers are bounded
// so a pathological one-letter token can't drag the whole library into JS.
const CAP_EXACT = 50;
const CAP_PREFIX = 60;
const CAP_INFIX = 80;
const CAP_PHONETIC = 60;

interface RawRow {
  id: string;
  raw_json: string;
}

/** Parse `raw_json` envelopes into entities, deduping by id in first-seen
 *  (tier-priority) order. Unparseable rows are skipped. */
function collect<T>(into: T[], seen: Set<string>, rows: RawRow[]): void {
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    try {
      into.push(JSON.parse(r.raw_json) as T);
    } catch {
      /* skip unparseable envelope */
    }
  }
}

/** Build an `OR`-joined LIKE clause + its `%token%` params for a set of tokens
 *  across one or more columns. Returns null when there are no tokens. */
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

/**
 * Candidate songs from `song_index` for a normalized query. Runs the tiers as
 * separate capped queries (exact → prefix → infix title/artist → phonetic) and
 * merges them dedup'd, tier-priority order. `norm` is the whole normalized
 * query; `tokens` are its words; `dmetaTokens` are the non-empty per-token
 * Double-Metaphone codes (already length-gated by the caller).
 */
export async function querySongCandidates(
  norm: string,
  tokens: readonly string[],
  dmetaTokens: readonly string[],
): Promise<Child[]> {
  const db = getDb();
  if (db === null || !norm) return [];
  const out: Child[] = [];
  const seen = new Set<string>();
  const ORDER = 'ORDER BY length(si.norm_title), si.id';
  const base = 'SELECT si.id AS id, si.raw_json AS raw_json FROM song_index si';
  try {
    collect<Child>(
      out,
      seen,
      await db.getAllAsync<RawRow>(`${base} WHERE si.norm_title = ? ${ORDER} LIMIT ${CAP_EXACT};`, [norm]),
    );
    collect<Child>(
      out,
      seen,
      await db.getAllAsync<RawRow>(`${base} WHERE si.norm_title LIKE ? ${ORDER} LIMIT ${CAP_PREFIX};`, [`${norm}%`]),
    );
    const infix = infixClause(['si.norm_title', 'si.norm_artist'], tokens);
    if (infix) {
      collect<Child>(
        out,
        seen,
        await db.getAllAsync<RawRow>(`${base} WHERE ${infix.sql} ${ORDER} LIMIT ${CAP_INFIX};`, infix.params),
      );
    }
    const phon = infixClause(['si.dmeta_title', 'si.dmeta_artist'], dmetaTokens);
    if (phon) {
      collect<Child>(
        out,
        seen,
        await db.getAllAsync<RawRow>(`${base} WHERE ${phon.sql} ${ORDER} LIMIT ${CAP_PHONETIC};`, phon.params),
      );
    }
  } catch {
    /* best-effort recall — a malformed query or missing column yields no rows */
  }
  return out;
}

/** Candidate albums from `library_albums` (analogous tiers over `norm_name` /
 *  `dmeta_name` + artist). Returns parsed `AlbumID3` envelopes. */
export async function queryAlbumCandidates(
  norm: string,
  tokens: readonly string[],
  dmetaTokens: readonly string[],
): Promise<AlbumID3[]> {
  const db = getDb();
  if (db === null || !norm) return [];
  const out: AlbumID3[] = [];
  const seen = new Set<string>();
  const ORDER = 'ORDER BY length(la.norm_name), la.id';
  const base = 'SELECT la.id AS id, la.raw_json AS raw_json FROM library_albums la';
  try {
    collect<AlbumID3>(
      out,
      seen,
      await db.getAllAsync<RawRow>(`${base} WHERE la.norm_name = ? ${ORDER} LIMIT ${CAP_EXACT};`, [norm]),
    );
    collect<AlbumID3>(
      out,
      seen,
      await db.getAllAsync<RawRow>(`${base} WHERE la.norm_name LIKE ? ${ORDER} LIMIT ${CAP_PREFIX};`, [`${norm}%`]),
    );
    const infix = infixClause(['la.norm_name', 'la.norm_artist'], tokens);
    if (infix) {
      collect<AlbumID3>(
        out,
        seen,
        await db.getAllAsync<RawRow>(`${base} WHERE ${infix.sql} ${ORDER} LIMIT ${CAP_INFIX};`, infix.params),
      );
    }
    const phon = infixClause(['la.dmeta_name', 'la.dmeta_artist'], dmetaTokens);
    if (phon) {
      collect<AlbumID3>(
        out,
        seen,
        await db.getAllAsync<RawRow>(`${base} WHERE ${phon.sql} ${ORDER} LIMIT ${CAP_PHONETIC};`, phon.params),
      );
    }
  } catch {
    /* best-effort recall */
  }
  return out;
}

/** True iff the full-library song index has any rows — the routing gate for
 *  "do we have a local corpus to search, or must we go straight to the server?" */
export async function hasLocalLibraryRows(): Promise<boolean> {
  const db = getDb();
  if (db === null) return false;
  try {
    const row = await db.getFirstAsync<{ x: number }>('SELECT 1 AS x FROM song_index LIMIT 1;');
    return row != null;
  } catch {
    return false;
  }
}
