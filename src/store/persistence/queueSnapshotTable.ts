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
 * The parent-row write: `INSERT … ON CONFLICT DO UPDATE`, NEVER `INSERT OR REPLACE` —
 * the latter is DELETE-then-INSERT and would cascade the whole queue away
 * (AGENTS.md §11).
 *
 * `track_count` is owned by the songs write ({@link snapshotTrackCommands}) and left
 * alone on conflict, so the count can never disagree with the rows actually stored.
 */
const SNAPSHOT_UPSERT_SQL =
  `INSERT INTO queue_snapshots (id, kind, name, created_at, current_index, position_sec, track_count)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind,
       name = excluded.name,
       created_at = excluded.created_at,
       current_index = excluded.current_index,
       position_sec = excluded.position_sec;`;

const snapshotUpsertParams = (
  meta: Omit<QueueSnapshotMeta, 'trackCount'>,
): (string | number | null)[] => [
  meta.id,
  meta.kind,
  meta.name,
  meta.createdAt,
  meta.currentIndex,
  meta.positionSec,
];

/** Create or update a snapshot's parent row. See {@link SNAPSHOT_UPSERT_SQL}. */
export async function upsertSnapshot(meta: Omit<QueueSnapshotMeta, 'trackCount'>): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await db.runAsync(SNAPSHOT_UPSERT_SQL, snapshotUpsertParams(meta));
  } catch {
    /* dropped */
  }
}

/**
 * The statements that make a snapshot's songs exactly `tracks`. The leading DELETE is
 * what makes a rewrite with FEWER tracks correct: `pos` is positional, so without it a
 * shorter queue leaves stale tail rows — and it cascades each removed song's five array
 * rows with it.
 *
 * Entries with no id are dropped: `childToTrack` cannot play them, and `song_id` is
 * NOT NULL so one would abort the whole batch.
 */
function snapshotTrackCommands(snapshotId: string, tracks: readonly Child[]): BatchCommand[] {
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
  return commands;
}

/**
 * Replace a snapshot's songs wholesale, as ONE atomic batch (`runAtomicBatchAsync` —
 * `runBatchAsync` is not atomic).
 *
 * The parent row must already exist ({@link upsertSnapshot}); the songs FK to it.
 */
export async function replaceSnapshotTracks(
  snapshotId: string,
  tracks: readonly Child[],
): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await db.runAtomicBatchAsync(snapshotTrackCommands(snapshotId, tracks));
  } catch {
    /* dropped */
  }
}

/** A bookmark as {@link writeBookmarkSnapshots} takes it. `kind` and `track_count`
 *  are the table's own, so they are not part of the input. */
export interface BookmarkSnapshotInput {
  id: string;
  name: string | null;
  createdAt: number;
  currentIndex: number;
  positionSec: number | null;
  tracks: readonly Child[];
}

/**
 * Write a SET of bookmarks — parent rows and songs — as ONE atomic batch, which is what
 * a backup restore needs. `replaceExisting` puts a `DELETE … WHERE kind = 'bookmark'`
 * at the head of that same batch, so replace-mode restore removes the old set before
 * writing the file's and a statement failure part-way rolls the lot back to the old set
 * rather than leaving a mix of both (`runBatchAsync` would not — AGENTS.md §11).
 *
 * The live queue's row is never touched: the DELETE is scoped to `kind = 'bookmark'`.
 */
export async function writeBookmarkSnapshots(
  bookmarks: readonly BookmarkSnapshotInput[],
  options: { replaceExisting: boolean },
): Promise<void> {
  const db = getDb();
  if (db === null) return;
  const commands: BatchCommand[] = [];
  if (options.replaceExisting) {
    commands.push(["DELETE FROM queue_snapshots WHERE kind = 'bookmark';", []]);
  }
  for (const { tracks, ...meta } of bookmarks) {
    commands.push([SNAPSHOT_UPSERT_SQL, snapshotUpsertParams({ ...meta, kind: 'bookmark' })]);
    commands.push(...snapshotTrackCommands(meta.id, tracks));
  }
  if (commands.length === 0) return;
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

/** Every array row carries the song it belongs to: the snapshot plus the position. */
type ArrayRow<T> = T & { snapshot_id: string; song_pos: number };

type CreditCols = { artist_id: string | null; artist_name: string | null };

/** The five array tables' rows for whatever set of snapshots the caller selected. */
interface SnapshotArrayRows {
  genres: ArrayRow<{ name: string }>[];
  artists: ArrayRow<CreditCols>[];
  albumArtists: ArrayRow<CreditCols>[];
  contributors: ArrayRow<CreditCols & { role: string; sub_role: string | null }>[];
  moods: ArrayRow<{ mood: string }>[];
}

/** ONE query per array table, whatever the snapshot count — a per-song query would
 *  be 5×N round trips on the restore path. `where` restricts the snapshots. */
const arraySql = (table: string, cols: string, where: string): string =>
  `SELECT snapshot_id, song_pos, ${cols} FROM queue_snapshot_song_${table} ` +
  `WHERE ${where} ORDER BY snapshot_id, song_pos, pos;`;

function arrayRowsSync(
  db: InternalDb,
  where: string,
  params: readonly unknown[],
): SnapshotArrayRows {
  const q = <T>(table: string, cols: string): ArrayRow<T>[] =>
    db.getAllSync<ArrayRow<T>>(arraySql(table, cols, where), params);
  return {
    genres: q<{ name: string }>('genres', 'name'),
    artists: q<CreditCols>('artists', 'artist_id, artist_name'),
    albumArtists: q<CreditCols>('album_artists', 'artist_id, artist_name'),
    contributors: q<CreditCols & { role: string; sub_role: string | null }>(
      'contributors',
      'role, sub_role, artist_id, artist_name',
    ),
    moods: q<{ mood: string }>('moods', 'mood'),
  };
}

async function arrayRowsAsync(
  db: InternalDb,
  where: string,
  params: readonly unknown[],
): Promise<SnapshotArrayRows> {
  const q = <T>(table: string, cols: string): Promise<ArrayRow<T>[]> =>
    db.getAllAsync<ArrayRow<T>>(arraySql(table, cols, where), params);
  const [genres, artists, albumArtists, contributors, moods] = await Promise.all([
    q<{ name: string }>('genres', 'name'),
    q<CreditCols>('artists', 'artist_id, artist_name'),
    q<CreditCols>('album_artists', 'artist_id, artist_name'),
    q<CreditCols & { role: string; sub_role: string | null }>(
      'contributors',
      'role, sub_role, artist_id, artist_name',
    ),
    q<{ mood: string }>('moods', 'mood'),
  ]);
  return { genres, artists, albumArtists, contributors, moods };
}

/** Group the flat array rows by snapshot, then by song position. */
function groupArrays(rows: SnapshotArrayRows): Map<string, Map<number, ChildSnapshotArrays>> {
  const out = new Map<string, Map<number, MutableArrays>>();
  const bucket = (r: { snapshot_id: string; song_pos: number }): MutableArrays => {
    let bySong = out.get(r.snapshot_id);
    if (bySong === undefined) {
      bySong = new Map<number, MutableArrays>();
      out.set(r.snapshot_id, bySong);
    }
    let fields = bySong.get(r.song_pos);
    if (fields === undefined) {
      fields = {};
      bySong.set(r.song_pos, fields);
    }
    return fields;
  };
  const credit = (r: CreditCols): { artistId: string | null; artistName: string | null } => ({
    artistId: r.artist_id,
    artistName: r.artist_name,
  });
  for (const r of rows.genres) (bucket(r).genres ??= []).push(r.name);
  for (const r of rows.artists) (bucket(r).artists ??= []).push(credit(r));
  for (const r of rows.albumArtists) (bucket(r).albumArtists ??= []).push(credit(r));
  for (const r of rows.contributors) {
    (bucket(r).contributors ??= []).push({ role: r.role, subRole: r.sub_role, ...credit(r) });
  }
  for (const r of rows.moods) (bucket(r).moods ??= []).push(r.mood);
  return out;
}

const NO_ARRAYS: ChildSnapshotArrays = {};
const NO_SONG_ARRAYS = new Map<number, ChildSnapshotArrays>();

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
    const arrays =
      groupArrays(arrayRowsSync(db, 'snapshot_id = ?', [snapshotId])).get(snapshotId) ??
      NO_SONG_ARRAYS;
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

/** Predicate selecting every bookmark's rows in the child tables, so the bulk read
 *  needs no id list and no parameter-count ceiling. */
const BOOKMARK_SNAPSHOTS = "snapshot_id IN (SELECT id FROM queue_snapshots WHERE kind = 'bookmark')";

/**
 * Every bookmark with its full `Child[]`, newest first — what `bookmarksStore`
 * hydrates its in-memory map from. ASYNC and bulk: 7 queries for the whole set, not
 * 7 per bookmark, and off the JS thread because nothing paints from it before boot
 * completes (the live queue is the one that must read synchronously).
 */
export async function readBookmarkSnapshots(): Promise<QueueSnapshot[]> {
  const db = getDb();
  if (db === null) return [];
  try {
    const metas = await listBookmarks();
    if (metas.length === 0) return [];
    const [rows, arrayRows] = await Promise.all([
      db.getAllAsync<Record<string, unknown>>(
        `SELECT snapshot_id, ${SONG_SELECT} FROM queue_snapshot_songs ` +
          `WHERE ${BOOKMARK_SNAPSHOTS} ORDER BY snapshot_id, pos;`,
      ),
      arrayRowsAsync(db, BOOKMARK_SNAPSHOTS, []),
    ]);
    const arrays = groupArrays(arrayRows);
    const tracks = new Map<string, Child[]>();
    for (const raw of rows) {
      const snapshotId = String(raw.snapshot_id);
      let list = tracks.get(snapshotId);
      if (list === undefined) {
        list = [];
        tracks.set(snapshotId, list);
      }
      list.push(
        childFromSnapshotRow(
          rowToSnapshotRow(raw),
          arrays.get(snapshotId)?.get(raw.pos as number) ?? NO_ARRAYS,
        ),
      );
    }
    return metas.map((meta) => ({ ...meta, tracks: tracks.get(meta.id) ?? [] }));
  } catch {
    return [];
  }
}
