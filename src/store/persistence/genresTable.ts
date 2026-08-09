/**
 * Per-row SQLite persistence for `genreStore` — the server's genre list from
 * `getGenres`, which the genre chips and the Tuned In mix builder read. The shared
 * handle, PRAGMAs, schema and test injection live in `./db.ts`.
 *
 * The set is small and always fetched whole, so the write REPLACES it in one atomic
 * batch rather than diffing. Writes become silent no-ops when `getDb()` returns null
 * (DB init failed) — callers don't need to handle exceptions.
 */
import { getDb, type BatchCommand } from './db';

import { type Genre } from '../../services/subsonicService';

/** A name that would fail the NOT NULL PK, or a count that would not bind, costs that
 *  genre rather than the whole batch. Everything reaching the INSERT is text or a
 *  number, so a corrupt blob cannot abort the write. */
const storableGenres = (list: readonly Genre[]): Genre[] =>
  (list ?? []).filter(
    (g) => g !== null && g !== undefined && typeof g.value === 'string' && g.value.length > 0,
  );

const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Make the table exactly `list`, as ONE atomic batch (`runAtomicBatchAsync` —
 * `runBatchAsync` is not atomic). The leading DELETE is what removes a genre the
 * server no longer reports.
 */
export async function replaceGenres(list: readonly Genre[]): Promise<void> {
  const db = getDb();
  if (db === null) return;
  const commands: BatchCommand[] = [['DELETE FROM genres;', []]];
  storableGenres(list).forEach((g, pos) => {
    commands.push([
      'INSERT INTO genres (name, pos, song_count, album_count) VALUES (?, ?, ?, ?);',
      [g.value, pos, count(g.songCount), count(g.albumCount)],
    ]);
  });
  try {
    await db.runAtomicBatchAsync(commands);
  } catch {
    /* dropped */
  }
}

/**
 * Every stored genre, in the server's order — `pos` exists so this list is identical to
 * the one {@link replaceGenres} was handed. `useMixBuilder` slices the first eight
 * substring matches without sorting, so an invented order here would change what the
 * user sees between a cold start and the first fetch.
 *
 * **Null means "could not read", `[]` means "no genres".** The caller replaces its whole
 * list from this, and a failed DB open answering `[]` would blank the chips and the mix
 * builder with nothing to tell it apart from a server that has none.
 */
export async function readGenres(): Promise<Genre[] | null> {
  const db = getDb();
  if (db === null) return null;
  try {
    const rows = await db.getAllAsync<{
      name: string;
      song_count: number | null;
      album_count: number | null;
    }>('SELECT name, song_count, album_count FROM genres ORDER BY pos, name;');
    return rows.map((r) => ({
      value: r.name,
      songCount: r.song_count ?? 0,
      albumCount: r.album_count ?? 0,
    }));
  } catch {
    return null;
  }
}
