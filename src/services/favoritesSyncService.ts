/**
 * Reconciles the `getStarred2` payload into SQL, and imports the legacy KV blob once.
 *
 * MARK, DON'T MATERIALISE: a favourite whose library row exists gets `UPDATE … SET
 * starred`; one without goes into the `favorite_*` remainder tables with its verbatim
 * envelope. The reconcile issues **no INSERT into `songs`/`albums`/`artists`, ever** —
 * a row there means "the library sync put it here", and sixteen production presence
 * checks read it that way.
 */
import {
  clearStarredAlbumsNotIn,
  clearStarredArtistsNotIn,
  clearStarredSongsNotIn,
  epochOf,
  listStarredAlbumIds,
  listStarredArtistIds,
  listStarredSongIds,
  markStarredAlbums,
  markStarredArtists,
  markStarredSongs,
  replaceFavoriteAlbums,
  replaceFavoriteArtists,
  replaceFavoriteSongs,
  type StarMark,
} from '../db/repository/favorites';
import { albumIdsPresent } from '../db/repository/albums';
import { artistIdsPresent } from '../db/repository/artists';
import { songIdsPresent } from '../db/repository/songs';
import { getDb } from '../store/persistence/db';
import { kvStorage } from '../store/persistence/kvStorage';
import { getApi } from './subsonicService';
import type { AlbumID3, ArtistID3, Child } from './subsonicService';

/** The zustand `persist` key the pre-SQL favourites blob was written under. */
export const FAVORITES_PERSIST_KEY = 'substreamer-favorites';

export interface StarredPayload {
  songs: Child[];
  albums: AlbumID3[];
  artists: ArtistID3[];
}

/** The three membership id sets after a reconcile — exactly the payload's ids. */
export interface StarredIds {
  songIds: Set<string>;
  albumIds: Set<string>;
  artistIds: Set<string>;
}

export type ReconcileResult = { skipped: true } | ({ skipped: false } & StarredIds);

/**
 * Set once the server has answered a reconcile. Its only job is to retire the legacy
 * blob: once the server has spoken, the blob has no remaining value.
 */
let serverReconciled = false;
/** Set once the blob has been imported (or found absent) — the in-process short-circuit. */
let kvImportDone = false;
/** The single in-flight reconcile. Both paths await it, so the stale blob's reconcile
 *  can never land after the server's. */
let reconcileLock: Promise<unknown> | null = null;

/** Clear the module-scope flags on logout. Zustand's `getInitialState()` returns a
 *  MEMOISED object and never re-runs the store initializer, so these cannot be reset
 *  through the store's reset path — `resetAllStores` calls this explicitly. */
export function resetFavoritesSyncFlags(): void {
  serverReconciled = false;
  kvImportDone = false;
  reconcileLock = null;
}

/** Mutual exclusion between the server reconcile and the blob import. A `serverReconciled`
 *  check alone is guard-then-act: the flag can flip while the import is awaiting its
 *  `getItem` + parse, and the stale blob's reconcile would then overwrite the server's. */
function withReconcileLock<T>(task: () => Promise<T>): Promise<T> {
  const run = (reconcileLock ?? Promise.resolve()).then(task, task);
  reconcileLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Diff one entity type's payload against the library and write both halves.
 *
 * `present` is a TOCTOU read: between it and `replaceFavoriteRows` a concurrent
 * `fetchAlbumDetail` can insert a library row for an id already classified as missing,
 * so that id lands in the remainder AND has a library row. The remainder read's
 * `NOT EXISTS` clause ignores it and `promoteResolvedFavorites` reclaims it later —
 * this is expected, not a bug.
 */
async function reconcileEntity<T extends { id: string; starred?: Date }>(
  items: readonly T[],
  presentIds: (ids: string[]) => Promise<Set<string>>,
  clearNotIn: (keepIds: readonly string[]) => Promise<unknown>,
  mark: (marks: readonly StarMark[]) => Promise<void>,
  replaceRemainder: (missing: readonly T[]) => Promise<void>,
): Promise<Set<string>> {
  const ids = items.map((i) => i.id);
  const present = await presentIds(ids);
  const missing = items.filter((i) => !present.has(i.id));
  const keep = [...present];
  await clearNotIn(keep);
  await mark(items.filter((i) => present.has(i.id)).map((i) => ({ id: i.id, starredAt: epochOf(i.starred) })));
  await replaceRemainder(missing);
  return new Set(ids);
}

/**
 * Reconcile a `getStarred2` payload into SQL.
 *
 * Refuses to run when there is no usable API. `getStarred2` returns
 * `{ albums: [], artists: [], songs: [] }` rather than throwing whenever `getApi()` is
 * null — which includes **offline mode**, not just missing auth — and reconciling
 * against that empty payload would clear every mark and empty the remainder. Same
 * guard, same reason as `normalizedLibrarySync`'s "prune only when the API answered".
 */
export async function reconcileStarred(payload: StarredPayload): Promise<ReconcileResult> {
  if (getApi() === null) return { skipped: true };
  const db = getDb();
  if (!db) return { skipped: true };

  const songIds = await reconcileEntity(
    payload.songs,
    (ids) => songIdsPresent(db, ids),
    (keep) => clearStarredSongsNotIn(db, keep),
    (marks) => markStarredSongs(db, marks),
    (missing) => replaceFavoriteSongs(db, missing),
  );
  const albumIds = await reconcileEntity(
    payload.albums,
    (ids) => albumIdsPresent(db, ids),
    (keep) => clearStarredAlbumsNotIn(db, keep),
    (marks) => markStarredAlbums(db, marks),
    (missing) => replaceFavoriteAlbums(db, missing),
  );
  const artistIds = await reconcileEntity(
    payload.artists,
    (ids) => artistIdsPresent(db, ids),
    (keep) => clearStarredArtistsNotIn(db, keep),
    (marks) => markStarredArtists(db, marks),
    (missing) => replaceFavoriteArtists(db, missing),
  );
  return { skipped: false, songIds, albumIds, artistIds };
}

/** The server's reconcile — takes the shared lock and, on success, retires the blob. */
export function reconcileStarredFromServer(payload: StarredPayload): Promise<ReconcileResult> {
  return withReconcileLock(async () => {
    const res = await reconcileStarred(payload);
    if (!res.skipped) serverReconciled = true;
    return res;
  });
}

/** Read the three membership id sets (marked library rows ∪ remainder) from SQL. */
export async function readStarredIds(): Promise<StarredIds> {
  const db = getDb();
  if (!db) return { songIds: new Set(), albumIds: new Set(), artistIds: new Set() };
  const [songIds, albumIds, artistIds] = await Promise.all([
    listStarredSongIds(db),
    listStarredAlbumIds(db),
    listStarredArtistIds(db),
  ]);
  return { songIds, albumIds, artistIds };
}

/** The zustand persist envelope the blob was written in. */
interface FavoritesBlob {
  state?: { songs?: Child[]; albums?: AlbumID3[]; artists?: ArtistID3[] };
}

/**
 * One-shot import of the pre-SQL favourites blob, replayed through the SAME reconcile.
 *
 * Version-stamped by the ABSENCE of the key, which is the re-runnable form the
 * no-migrations-on-migrations rule asks for — no migration id, no counter bump.
 *
 * The key is removed ONLY after a reconcile that both resolves and does not skip. A
 * skip resolves successfully, so deleting unconditionally would destroy the user's only
 * copy of their favourites in exactly the case this import exists for: an upgrader who
 * launches offline. Leaving both the key and `kvImportDone` false means the next launch
 * retries.
 */
export async function importLegacyFavoritesBlob(): Promise<void> {
  if (kvImportDone) return;
  await withReconcileLock(async () => {
    if (kvImportDone) return;
    if (serverReconciled) {
      // The server has answered on this launch, so the blob is dead weight.
      await kvStorage.removeItem(FAVORITES_PERSIST_KEY);
      kvImportDone = true;
      return;
    }
    const raw = await kvStorage.getItem(FAVORITES_PERSIST_KEY);
    if (raw == null) {
      kvImportDone = true;
      return;
    }
    let blob: FavoritesBlob;
    try {
      blob = JSON.parse(raw) as FavoritesBlob;
    } catch {
      // Unparseable blob: nothing to replay and nothing to preserve.
      await kvStorage.removeItem(FAVORITES_PERSIST_KEY);
      kvImportDone = true;
      return;
    }
    const res = await reconcileStarred({
      songs: blob.state?.songs ?? [],
      albums: blob.state?.albums ?? [],
      artists: blob.state?.artists ?? [],
    });
    if (res.skipped) return;
    await kvStorage.removeItem(FAVORITES_PERSIST_KEY);
    kvImportDone = true;
  });
}
