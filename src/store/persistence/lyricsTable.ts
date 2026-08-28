/**
 * Per-row SQLite persistence for `lyricsStore` — one song's lyrics per write, never
 * the whole map. The shared handle, PRAGMAs, schema and test injection live in
 * `./db.ts`.
 *
 * Writes become silent no-ops when `getDb()` returns null (DB init failed) — callers
 * don't need to handle exceptions.
 */
import { getDb, type BatchCommand } from './db';

import { type LyricsData } from '../../services/subsonicService';

/** The scalars, as stored. `lang` is the only genuinely optional one. */
interface LyricsRow {
  synced: number;
  lang: string | null;
  offset_ms: number;
  source: LyricsData['source'];
}

/** One row as the cached-lyrics browser lists it — names, not the lines. */
export interface CachedLyricsEntry {
  songId: string;
  title: string | null;
  artist: string | null;
  synced: boolean;
}

export interface LyricsCounts {
  synced: number;
  unsynced: number;
}

/** Read one song's lyrics, or null when we have none stored. */
export async function loadLyrics(songId: string): Promise<LyricsData | null> {
  const db = getDb();
  if (db === null) return null;
  try {
    const row = await db.getFirstAsync<LyricsRow>(
      'SELECT synced, lang, offset_ms, source FROM lyrics WHERE song_id = ?;',
      [songId],
    );
    if (row === null) return null;
    const lines = await db.getAllAsync<{ start_ms: number; text: string }>(
      'SELECT start_ms, text FROM lyric_lines WHERE song_id = ? ORDER BY pos;',
      [songId],
    );
    const data: LyricsData = {
      synced: row.synced === 1,
      lines: lines.map((l) => ({ startMs: l.start_ms, text: l.text })),
      offsetMs: row.offset_ms,
      source: row.source,
    };
    if (row.lang !== null) data.lang = row.lang;
    return data;
  } catch {
    return null;
  }
}

/**
 * Write one song's lyrics as ONE atomic batch: the parent row, then its lines
 * delete-then-insert. Parent FIRST — the lines FK to it under
 * `PRAGMA foreign_keys = ON`. The DELETE is what makes a rewrite with fewer lines
 * correct: `pos` is positional, so without it a shorter set leaves stale tail rows.
 * ON CONFLICT DO UPDATE, never INSERT OR REPLACE, which would cascade the lines away
 * mid-batch.
 *
 * `title`/`artist` COALESCE: a caller without names must not blank a label an earlier
 * write captured — the browser needs it, and so does the classic artist+title refresh.
 */
export async function saveLyrics(
  songId: string,
  data: LyricsData,
  title?: string,
  artist?: string,
): Promise<void> {
  const db = getDb();
  if (db === null) return;
  const commands: BatchCommand[] = [
    [
      `INSERT INTO lyrics (song_id, title, artist, synced, lang, offset_ms, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(song_id) DO UPDATE SET
           title = COALESCE(excluded.title, title),
           artist = COALESCE(excluded.artist, artist),
           synced = excluded.synced,
           lang = excluded.lang,
           offset_ms = excluded.offset_ms,
           source = excluded.source;`,
      [
        songId,
        title ?? null,
        artist ?? null,
        data.synced ? 1 : 0,
        data.lang ?? null,
        data.offsetMs,
        data.source,
      ],
    ],
    ['DELETE FROM lyric_lines WHERE song_id = ?;', [songId]],
  ];
  data.lines.forEach((line, pos) => {
    commands.push([
      'INSERT INTO lyric_lines (song_id, pos, start_ms, text) VALUES (?, ?, ?, ?);',
      [songId, pos, line.startMs, line.text],
    ]);
  });
  try {
    await db.runAtomicBatchAsync(commands);
  } catch {
    /* dropped */
  }
}

/** Remove one song's lyrics. The lines cascade with the parent row. */
export async function deleteLyrics(songId: string): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await db.runAsync('DELETE FROM lyrics WHERE song_id = ?;', [songId]);
  } catch {
    /* dropped */
  }
}

/**
 * Cached-lyrics totals, split synced vs unsynced. Aggregated in SQL — the browser
 * card wants two numbers, not every row.
 */
export async function countLyricsBySynced(): Promise<LyricsCounts> {
  const db = getDb();
  const empty: LyricsCounts = { synced: 0, unsynced: 0 };
  if (db === null) return empty;
  try {
    const rows = await db.getAllAsync<{ synced: number | null; c: number }>(
      'SELECT synced, COUNT(*) AS c FROM lyrics GROUP BY synced;',
    );
    return rows.reduce<LyricsCounts>(
      (acc, row) => {
        if (row.synced === 1) acc.synced += row.c;
        else acc.unsynced += row.c;
        return acc;
      },
      { ...empty },
    );
  } catch {
    return empty;
  }
}

/** Every cached row, names only. Ordering is the caller's — it needs a collator. */
export async function listCachedLyrics(): Promise<CachedLyricsEntry[]> {
  const db = getDb();
  if (db === null) return [];
  try {
    const rows = await db.getAllAsync<{
      song_id: string;
      title: string | null;
      artist: string | null;
      synced: number | null;
    }>('SELECT song_id, title, artist, synced FROM lyrics;');
    return rows.map((row) => ({
      songId: row.song_id,
      title: row.title,
      artist: row.artist,
      synced: row.synced === 1,
    }));
  } catch {
    return [];
  }
}

/** Remove every row. The lines cascade with their parent. */
export async function clearAllLyrics(): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await db.runAsync('DELETE FROM lyrics;');
  } catch {
    /* dropped */
  }
}
