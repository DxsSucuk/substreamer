/**
 * Per-row SQLite persistence for the ordered play queues: the LIVE player queue
 * (one row, `SNAPSHOT_LIVE_ID`) and the user's saved bookmarks. One table pair
 * serves both — they are the same thing (an ordered `Child[]` plus a cursor) and
 * differ only in `kind` and whether the user named it.
 *
 * The write is SPLIT, which is the whole point: a track change is
 * {@link updateSnapshotIndex} — one UPDATE on the parent row — while only a queue
 * change pays for {@link replaceSnapshotTracks}. The blob it replaces was rewritten
 * in full on every skip.
 *
 * Snapshots are SELF-CONTAINED: every row is a full `Child` copy, never a reference
 * into `songs`, so a library resync or a reap can never empty a saved queue.
 *
 * Writes become silent no-ops when `getDb()` returns null (DB init failed) — callers
 * don't need to handle exceptions.
 */
import { getDb, type BatchCommand, type InternalDb } from './db';
import {
  childFromSnapshotRow,
  childSnapshotArrayCommands,
  childSnapshotFields,
  type ChildSnapshotArrays,
  type ChildSnapshotRow,
} from '../../db/childSnapshot';

import type { Child } from 'subsonic-api';

/** The single live-queue row's id. Bookmarks carry their own UUIDs. */
export const SNAPSHOT_LIVE_ID = 'live';

export type QueueSnapshotKind = 'live' | 'bookmark';

/** A snapshot's parent row — everything the bookmarks list renders without
 *  touching the songs. */
export interface QueueSnapshotMeta {
  id: string;
  kind: QueueSnapshotKind;
  name: string | null;
  createdAt: number;
  currentIndex: number;
  /** Playback offset within the current track, seconds. */
  positionSec: number | null;
  trackCount: number;
}

/** A snapshot with its songs rebuilt into real `Child` objects. */
export interface QueueSnapshot extends QueueSnapshotMeta {
  tracks: Child[];
}

/* ------------------------------------------------------------------ */
/*  Column mapping                                                     */
/* ------------------------------------------------------------------ */

/**
 * `ChildSnapshotRow` key → its column. Typed as a TOTAL record, so a field added to
 * the shared mapping fails to compile until it is stored here — a queue snapshot has
 * to reproduce the whole `Child`, unlike the scrobble tables which take a subset.
 */
const SONG_COLUMNS = {
  id: 'song_id',
  title: 'title',
  artist: 'artist',
  album: 'album',
  coverArt: 'cover_art',
  duration: 'duration',
  albumId: 'album_id',
  suffix: 'suffix',
  bitRate: 'bit_rate',
  bitDepth: 'bit_depth',
  samplingRate: 'sampling_rate',
  artistId: 'artist_id',
  displayArtist: 'display_artist',
  displayAlbumArtist: 'display_album_artist',
  displayComposer: 'display_composer',
  track: 'track',
  discNumber: 'disc_number',
  year: 'year',
  genre: 'genre',
  size: 'size',
  contentType: 'content_type',
  transcodedContentType: 'transcoded_content_type',
  transcodedSuffix: 'transcoded_suffix',
  channelCount: 'channel_count',
  path: 'path',
  userRating: 'user_rating',
  averageRating: 'average_rating',
  playCount: 'play_count',
  created: 'created',
  starred: 'starred',
  played: 'played',
  type: 'type',
  bpm: 'bpm',
  comment: 'comment',
  sortName: 'sort_name',
  musicBrainzId: 'music_brainz_id',
  explicitStatus: 'explicit_status',
  bookmarkPosition: 'bookmark_position',
  isVideo: 'is_video',
  isDir: 'is_dir',
  parent: 'parent',
  originalWidth: 'original_width',
  originalHeight: 'original_height',
  rgTrackGain: 'rg_track_gain',
  rgAlbumGain: 'rg_album_gain',
  rgTrackPeak: 'rg_track_peak',
  rgAlbumPeak: 'rg_album_peak',
  rgBaseGain: 'rg_base_gain',
  rgFallbackGain: 'rg_fallback_gain',
} as const satisfies Record<keyof ChildSnapshotRow, string>;

type SongKey = keyof typeof SONG_COLUMNS;

const SONG_KEYS = Object.keys(SONG_COLUMNS) as SongKey[];

/** Stored 0/1 by SQLite; `Child` declares them boolean. */
const BOOL_KEYS: ReadonlySet<SongKey> = new Set<SongKey>(['isVideo', 'isDir']);

/** Aliased to the `ChildSnapshotRow` keys, so a selected row IS the shape
 *  `childFromSnapshotRow` takes and there is no second name mapping to drift. */
const SONG_SELECT = [
  'pos',
  ...SONG_KEYS.map((k) => (SONG_COLUMNS[k] === k ? k : `${SONG_COLUMNS[k]} AS ${k}`)),
].join(', ');

const INSERT_SONG_SQL =
  `INSERT INTO queue_snapshot_songs (snapshot_id, pos, ${SONG_KEYS.map((k) => SONG_COLUMNS[k]).join(', ')}) ` +
  `VALUES (${new Array(2 + SONG_KEYS.length).fill('?').join(', ')});`;

/** The shared `Child` mapping plus the identity/core fields it deliberately omits. */
function songRow(child: Child): ChildSnapshotRow {
  return {
    id: child.id,
    title: child.title,
    artist: child.artist,
    album: child.album,
    coverArt: child.coverArt,
    duration: child.duration,
    ...childSnapshotFields(child),
  };
}

function songParams(snapshotId: string, pos: number, child: Child): (string | number | null)[] {
  const row: Record<string, unknown> = { ...songRow(child) };
  return [
    snapshotId,
    pos,
    ...SONG_KEYS.map((k) => {
      const v = row[k];
      if (v === undefined || v === null) return null;
      if (BOOL_KEYS.has(k)) return v ? 1 : 0;
      return v as string | number;
    }),
  ];
}

/** Inverse of {@link songParams}: a selected row back into the shape
 *  `childFromSnapshotRow` consumes, NULL columns left absent. */
function rowToSnapshotRow(raw: Record<string, unknown>): ChildSnapshotRow {
  const out: Record<string, unknown> = {};
  for (const k of SONG_KEYS) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    out[k] = BOOL_KEYS.has(k) ? v === 1 || v === true : v;
  }
  return { ...out, id: String(raw.id ?? ''), title: String(raw.title ?? '') } as ChildSnapshotRow;
}

/* ------------------------------------------------------------------ */
/*  Writes                                                             */
/* ------------------------------------------------------------------ */

/**
 * Create or update a snapshot's parent row. `INSERT … ON CONFLICT DO UPDATE`, NEVER
 * `INSERT OR REPLACE` — the latter is DELETE-then-INSERT and would cascade the whole
 * queue away (AGENTS.md §11).
 *
 * `track_count` is owned by {@link replaceSnapshotTracks} and left alone on conflict,
 * so the count can never disagree with the rows that are actually stored.
 */
export async function upsertSnapshot(meta: Omit<QueueSnapshotMeta, 'trackCount'>): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await db.runAsync(
      `INSERT INTO queue_snapshots (id, kind, name, created_at, current_index, position_sec, track_count)
         VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           name = excluded.name,
           created_at = excluded.created_at,
           current_index = excluded.current_index,
           position_sec = excluded.position_sec;`,
      [meta.id, meta.kind, meta.name, meta.createdAt, meta.currentIndex, meta.positionSec],
    );
  } catch {
    /* dropped */
  }
}

/**
 * Replace a snapshot's songs wholesale, as ONE atomic batch (`runAtomicBatchAsync` —
 * `runBatchAsync` is not atomic). The leading DELETE is what makes a rewrite with
 * FEWER tracks correct: `pos` is positional, so without it a shorter queue leaves
 * stale tail rows — and it cascades each removed song's five array rows with it.
 *
 * Entries with no id are dropped: `childToTrack` cannot play them, and `song_id` is
 * NOT NULL so one would abort the whole batch.
 *
 * The parent row must already exist ({@link upsertSnapshot}); the songs FK to it.
 */
export async function replaceSnapshotTracks(
  snapshotId: string,
  tracks: readonly Child[],
): Promise<void> {
  const db = getDb();
  if (db === null) return;
  const usable = tracks.filter((c) => !!c?.id);
  const commands: BatchCommand[] = [
    ['DELETE FROM queue_snapshot_songs WHERE snapshot_id = ?;', [snapshotId]],
  ];
  usable.forEach((child, pos) => {
    commands.push(
      [INSERT_SONG_SQL, songParams(snapshotId, pos, child)],
      ...childSnapshotArrayCommands({
        tablePrefix: 'queue_snapshot_song',
        key: { snapshot_id: snapshotId, song_pos: pos },
        child,
      }),
    );
  });
  commands.push([
    'UPDATE queue_snapshots SET track_count = ? WHERE id = ?;',
    [usable.length, snapshotId],
  ]);
  try {
    await db.runAtomicBatchAsync(commands);
  } catch {
    /* dropped */
  }
}

/**
 * Move the playback cursor. ONE UPDATE on the parent row and nothing else — this is
 * the hot path a track change takes, and it is what the split buys: the songs are
 * never touched.
 */
export async function updateSnapshotIndex(
  snapshotId: string,
  currentIndex: number,
  positionSec: number,
): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await db.runAsync(
      'UPDATE queue_snapshots SET current_index = ?, position_sec = ? WHERE id = ?;',
      [currentIndex, positionSec, snapshotId],
    );
  } catch {
    /* dropped */
  }
}

/** Remove a snapshot. Its songs, and their five array tables, cascade with it. */
export async function deleteSnapshot(snapshotId: string): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await db.runAsync('DELETE FROM queue_snapshots WHERE id = ?;', [snapshotId]);
  } catch {
    /* dropped */
  }
}

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

interface SnapshotRow {
  id: string;
  kind: string;
  name: string | null;
  created_at: number;
  current_index: number;
  position_sec: number | null;
  track_count: number;
}

const metaFromRow = (r: SnapshotRow): QueueSnapshotMeta => ({
  id: r.id,
  kind: r.kind === 'bookmark' ? 'bookmark' : 'live',
  name: r.name,
  createdAt: r.created_at,
  currentIndex: r.current_index,
  positionSec: r.position_sec,
  trackCount: r.track_count,
});

const META_SELECT =
  'id, kind, name, created_at, current_index, position_sec, track_count FROM queue_snapshots';

/** Mutable twin of `ChildSnapshotArrays`, built by pushing the grouped rows. */
interface MutableArrays {
  genres?: string[];
  artists?: { artistId: string | null; artistName: string | null }[];
  albumArtists?: { artistId: string | null; artistName: string | null }[];
  contributors?: {
    role: string;
    subRole: string | null;
    artistId: string | null;
    artistName: string | null;
  }[];
  moods?: string[];
}

interface CreditRow {
  song_pos: number;
  artist_id: string | null;
  artist_name: string | null;
}

/** The five array tables for one snapshot: ONE query per table, grouped by song
 *  position in JS. A per-song query would be 5×N round trips on the restore path. */
function loadSnapshotArrays(
  db: InternalDb,
  snapshotId: string,
): Map<number, ChildSnapshotArrays> {
  const out = new Map<number, MutableArrays>();
  const select = (table: string, cols: string): string =>
    `SELECT song_pos, ${cols} FROM queue_snapshot_song_${table} ` +
    'WHERE snapshot_id = ? ORDER BY song_pos, pos;';
  const params = [snapshotId];
  const genres = db.getAllSync<{ song_pos: number; name: string }>(
    select('genres', 'name'),
    params,
  );
  const artists = db.getAllSync<CreditRow>(select('artists', 'artist_id, artist_name'), params);
  const albumArtists = db.getAllSync<CreditRow>(
    select('album_artists', 'artist_id, artist_name'),
    params,
  );
  const contributors = db.getAllSync<CreditRow & { role: string; sub_role: string | null }>(
    select('contributors', 'role, sub_role, artist_id, artist_name'),
    params,
  );
  const moods = db.getAllSync<{ song_pos: number; mood: string }>(select('moods', 'mood'), params);

  const bucket = (pos: number): MutableArrays => {
    const existing = out.get(pos);
    if (existing !== undefined) return existing;
    const fresh: MutableArrays = {};
    out.set(pos, fresh);
    return fresh;
  };
  const credit = (r: CreditRow): { artistId: string | null; artistName: string | null } => ({
    artistId: r.artist_id,
    artistName: r.artist_name,
  });
  for (const r of genres) (bucket(r.song_pos).genres ??= []).push(r.name);
  for (const r of artists) (bucket(r.song_pos).artists ??= []).push(credit(r));
  for (const r of albumArtists) (bucket(r.song_pos).albumArtists ??= []).push(credit(r));
  for (const r of contributors) {
    (bucket(r.song_pos).contributors ??= []).push({
      role: r.role,
      subRole: r.sub_role,
      ...credit(r),
    });
  }
  for (const r of moods) (bucket(r.song_pos).moods ??= []).push(r.mood);
  return out;
}

const NO_ARRAYS: ChildSnapshotArrays = {};

/**
 * Read one snapshot with its full `Child[]`, SYNCHRONOUSLY — `restorePersistedQueue`
 * seeds the store on the JS thread so the mini player paints immediately, and must
 * stay synchronous. Returns null when the snapshot does not exist.
 */
export function readSnapshotSync(snapshotId: string): QueueSnapshot | null {
  const db = getDb();
  if (db === null) return null;
  try {
    const meta = db.getFirstSync<SnapshotRow>(`SELECT ${META_SELECT} WHERE id = ?;`, [snapshotId]);
    if (meta === undefined || meta === null) return null;
    const rows = db.getAllSync<Record<string, unknown>>(
      `SELECT ${SONG_SELECT} FROM queue_snapshot_songs WHERE snapshot_id = ? ORDER BY pos;`,
      [snapshotId],
    );
    const arrays = loadSnapshotArrays(db, snapshotId);
    const tracks = rows.map((raw) =>
      childFromSnapshotRow(
        rowToSnapshotRow(raw),
        arrays.get(raw.pos as number) ?? NO_ARRAYS,
      ),
    );
    return { ...metaFromRow(meta), tracks };
  } catch {
    return null;
  }
}

/** Every saved bookmark's parent row, newest first. The songs are not read — the
 *  list renders from `name`/`created_at`/`track_count` alone. */
export async function listBookmarks(): Promise<QueueSnapshotMeta[]> {
  const db = getDb();
  if (db === null) return [];
  try {
    const rows = await db.getAllAsync<SnapshotRow>(
      `SELECT ${META_SELECT} WHERE kind = 'bookmark' ORDER BY created_at DESC;`,
    );
    return rows.map(metaFromRow);
  } catch {
    return [];
  }
}
