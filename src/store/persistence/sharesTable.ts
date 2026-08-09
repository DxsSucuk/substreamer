/**
 * Per-row SQLite persistence for `sharesStore` — the user's public links from
 * `getShares`, plus the shared songs each one carries. The shared handle, PRAGMAs,
 * schema and test injection live in `./db.ts`.
 *
 * `getShares` returns the whole set, so the write REPLACES it in one atomic batch
 * rather than diffing; deleting a single share is the one incremental path.
 *
 * `share_entries` is a SNAPSHOT of the fields the share list renders, never a reference
 * into `songs` — a shared song need not be in the library (AGENTS.md §11).
 *
 * Writes become silent no-ops when `getDb()` returns null (DB init failed) — callers
 * don't need to handle exceptions.
 */
import { getDb, type BatchCommand } from './db';
import { toEpoch } from '../../db/childSnapshot';

import { type Child, type Share } from '../../services/subsonicService';

/** The six entry fields the UI reads back: title/album for the heading, artist for the
 *  subtitle and the share message, `cover_art`/`album_id` for the thumbnail. */
const ENTRY_INSERT_SQL =
  'INSERT INTO share_entries (share_id, pos, song_id, title, artist, album, album_id, cover_art) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?);';

const SHARE_INSERT_SQL =
  'INSERT INTO shares ' +
  '(id, pos, url, description, created, expires, last_visited, username, visit_count) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);';

/** Anything that would not bind as a scalar becomes NULL, and a row whose NOT NULL key
 *  is missing is dropped — so a corrupt or hand-edited payload costs that row rather
 *  than aborting the whole batch. */
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const hasId = (v: { id?: unknown } | null | undefined): boolean =>
  !!v && typeof v.id === 'string' && v.id.length > 0;

/** The shares that will actually store — `id` is the PK. */
export const storableShares = (list: readonly Share[]): Share[] => (list ?? []).filter(hasId);

/** The entries of one share that will actually store — `song_id` is NOT NULL. */
export const storableEntries = (share: Share): Child[] => (share.entry ?? []).filter(hasId);

function shareCommands(share: Share, pos: number): BatchCommand[] {
  const commands: BatchCommand[] = [
    [
      SHARE_INSERT_SQL,
      [
        share.id,
        pos,
        text(share.url),
        text(share.description),
        // `num` also catches the NaN an Invalid `Date` yields, so nothing unbindable
        // reaches the batch.
        num(toEpoch(share.created)),
        num(toEpoch(share.expires)),
        num(toEpoch(share.lastVisited)),
        text(share.username),
        num(share.visitCount),
      ],
    ],
  ];
  storableEntries(share).forEach((entry, pos) => {
    commands.push([
      ENTRY_INSERT_SQL,
      [
        share.id,
        pos,
        entry.id,
        text(entry.title),
        text(entry.artist),
        text(entry.album),
        text(entry.albumId),
        text(entry.coverArt),
      ],
    ]);
  });
  return commands;
}

/**
 * Make the tables exactly `list`, as ONE atomic batch (`runAtomicBatchAsync` —
 * `runBatchAsync` is not atomic). The leading DELETE removes shares the server no
 * longer reports; each one's entries cascade with it.
 */
export async function replaceShares(list: readonly Share[]): Promise<void> {
  const db = getDb();
  if (db === null) return;
  const commands: BatchCommand[] = [['DELETE FROM shares;', []]];
  storableShares(list).forEach((share, pos) => commands.push(...shareCommands(share, pos)));
  try {
    await db.runAtomicBatchAsync(commands);
  } catch {
    /* dropped */
  }
}

/** Remove one share. Its entries cascade with it. */
export async function deleteShareRow(id: string): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await db.runAsync('DELETE FROM shares WHERE id = ?;', [id]);
  } catch {
    /* dropped */
  }
}

interface ShareRow {
  id: string;
  url: string | null;
  description: string | null;
  created: number | null;
  expires: number | null;
  last_visited: number | null;
  username: string | null;
  visit_count: number | null;
}

interface EntryRow {
  share_id: string;
  song_id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  album_id: string | null;
  cover_art: string | null;
}

/**
 * NULL columns stay ABSENT rather than becoming `null` or `''`, so a rebuilt entry is
 * shaped like the server object the snapshot was taken from. `title` in particular:
 * `getShareTitle` falls through to `album` when it is nullish, and an empty string
 * would be a title.
 */
function entryFromRow(row: EntryRow): Child {
  const entry = { id: row.song_id, isDir: false } as Child;
  if (row.title !== null) entry.title = row.title;
  if (row.artist !== null) entry.artist = row.artist;
  if (row.album !== null) entry.album = row.album;
  if (row.album_id !== null) entry.albumId = row.album_id;
  if (row.cover_art !== null) entry.coverArt = row.cover_art;
  return entry;
}

/**
 * Every stored share with its entries, both in the server's order — `pos` exists so this
 * list is identical to the one {@link replaceShares} was handed. The share browser
 * renders `shares.map(...)` unsorted, so an invented order here would reshuffle the list
 * between a cold start and the first fetch. Two queries whatever the share count.
 *
 * **Null means "could not read", `[]` means "no shares".** The caller replaces its whole
 * list from this, and a failed DB open answering `[]` would render the "no shares yet"
 * empty state over a set that is still on the server.
 */
export async function readShares(): Promise<Share[] | null> {
  const db = getDb();
  if (db === null) return null;
  try {
    const [rows, entryRows] = await Promise.all([
      db.getAllAsync<ShareRow>(
        'SELECT id, url, description, created, expires, last_visited, username, visit_count ' +
          'FROM shares ORDER BY pos, id;',
      ),
      db.getAllAsync<EntryRow>(
        'SELECT share_id, song_id, title, artist, album, album_id, cover_art ' +
          'FROM share_entries ORDER BY share_id, pos;',
      ),
    ]);
    const entries = new Map<string, Child[]>();
    for (const row of entryRows) {
      let list = entries.get(row.share_id);
      if (list === undefined) {
        list = [];
        entries.set(row.share_id, list);
      }
      list.push(entryFromRow(row));
    }
    return rows.map((r) => {
      const share: Share = {
        id: r.id,
        url: r.url ?? '',
        created: new Date(r.created ?? 0),
        username: r.username ?? '',
        visitCount: r.visit_count ?? 0,
        entry: entries.get(r.id) ?? [],
      };
      if (r.description !== null) share.description = r.description;
      if (r.expires !== null) share.expires = new Date(r.expires);
      if (r.last_visited !== null) share.lastVisited = new Date(r.last_visited);
      return share;
    });
  } catch {
    return null;
  }
}
