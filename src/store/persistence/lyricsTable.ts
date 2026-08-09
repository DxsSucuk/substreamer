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
 */
export async function saveLyrics(songId: string, data: LyricsData): Promise<void> {
  const db = getDb();
  if (db === null) return;
  const commands: BatchCommand[] = [
    [
      `INSERT INTO lyrics (song_id, synced, lang, offset_ms, source) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(song_id) DO UPDATE SET
           synced = excluded.synced,
           lang = excluded.lang,
           offset_ms = excluded.offset_ms,
           source = excluded.source;`,
      [songId, data.synced ? 1 : 0, data.lang ?? null, data.offsetMs, data.source],
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
