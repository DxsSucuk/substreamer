import { create } from 'zustand';

import i18n from '../i18n/i18n';

import { promoteResolvedFavorites } from '../db/repository/favorites';
import { ensureCached, prefetchCoverArt } from '../services/imageCacheService';
import { coverArtForAlbum, coverArtForArtist } from '../utils/coverArtId';
import { runWhenIdle } from '../utils/runWhenIdle';
import { ensureCoverArtAuth, getApi, getStarred2 } from '../services/subsonicService';
import {
  importLegacyFavoritesBlob,
  readStarredIds,
  reconcileStarredFromServer,
  type StarredIds,
} from '../services/favoritesSyncService';
import { getDb } from './persistence/db';
import { ratingStore } from './ratingStore';
import { syncStatusStore } from './syncStatusStore';

/**
 * Favourites membership. **SQL is authoritative**; these three id sets are a mirror,
 * refreshed only by `fetchStarred`, `hydrateFromDbAsync` and `refreshFromDb`.
 *
 * Ids, not entities: `useIsStarred` runs per starred icon per row per render across a
 * dozen call sites, so membership must stay a synchronous O(1) `has()` — never a
 * per-row SQL query, and never an O(n) scan of a `Child[]`. The list SCREENS read the
 * rows from SQL; the store answers "is this starred?" and nothing else.
 *
 * **Always replace a Set, never mutate one in place.** `musicCacheService`'s
 * `__starred__` reactor guards on `state.songIds === prev.songIds`, and an in-place
 * mutation would silently stop it firing.
 */
export interface FavoritesState {
  /** Starred song ids — marked library rows ∪ the `favorite_songs` remainder. */
  songIds: ReadonlySet<string>;
  albumIds: ReadonlySet<string>;
  artistIds: ReadonlySet<string>;
  /** Whether a fetch is currently in progress */
  loading: boolean;
  /** Last error message, if any */
  error: string | null;
  /** Bumped whenever membership changed — the reload trigger for the SQL-backed lists. */
  version: number;
  /** True once the first SQL read has landed. */
  hydrated: boolean;
  /**
   * Optimistic overrides keyed by item ID.
   * When present, `useIsStarred` reads from here instead of the id sets,
   * giving instant UI feedback before `fetchStarred` completes.
   * Cleared automatically when `fetchStarred` succeeds.
   */
  overrides: Record<string, boolean>;

  /** Fetch all starred items from the server via getStarred2 and reconcile them into
   *  SQL. Pass `{ prefetchCovers: false }` to skip the eager cover-art cache —
   *  used by the background library sync. User-facing refreshes omit it. */
  fetchStarred: (opts?: { prefetchCovers?: boolean }) => Promise<void>;
  /** Set an optimistic override for a single item. */
  setOverride: (id: string, starred: boolean) => void;
  /** Read the membership sets from SQL and, once, import the legacy KV blob. */
  hydrateFromDbAsync: () => Promise<void>;
  /** Re-read the membership sets from SQL. No KV, no network. */
  refreshFromDb: () => Promise<void>;
}

const EMPTY: ReadonlySet<string> = new Set<string>();

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
};

let hydrateInFlight: Promise<void> | null = null;

export const favoritesStore = create<FavoritesState>()((set, get) => ({
  songIds: EMPTY,
  albumIds: EMPTY,
  artistIds: EMPTY,
  loading: false,
  error: null,
  version: 0,
  hydrated: false,
  overrides: {},

  fetchStarred: async (opts?: { prefetchCovers?: boolean }) => {
    const prefetchCovers = opts?.prefetchCovers ?? true;
    // Prevent duplicate fetches
    if (get().loading) return;

    set({ loading: true, error: null });
    try {
      await ensureCoverArtAuth();
      // Snapshot BEFORE the round trip. `getStarred2` answers with an empty payload
      // rather than throwing when there is no usable API, and offline mode can be
      // switched off (by the user or auto-offline) while that await is in flight — so
      // the reconcile's own `getApi()` gate could see a live API and treat "couldn't
      // ask" as "the server has none", clearing every mark. Both moments must agree.
      const apiAnswered = getApi() !== null;
      const { albums, artists, songs } = await getStarred2();

      const ratingEntries: Array<{ id: string; serverRating: number }> = [
        ...songs.map((s) => ({ id: s.id, serverRating: s.userRating ?? 0 })),
        ...albums.map((a) => ({ id: a.id, serverRating: a.userRating ?? 0 })),
        ...artists.map((a) => ({ id: a.id, serverRating: a.userRating ?? 0 })),
      ];
      ratingStore.getState().reconcileRatings(ratingEntries);

      const res = apiAnswered
        ? await reconcileStarredFromServer({ songs, albums, artists })
        : ({ skipped: true } as const);
      // A skipped reconcile means there was no usable API, so the payload above is the
      // empty stand-in `getStarred2` returns offline — adopting it would wipe the sets.
      set(res.skipped ? { loading: false } : { loading: false, overrides: {}, ...applyIds(get(), res) });

      // Proactively cache cover art for new IDs so they survive offline.
      // Skipped during bulk sync — see prefetchCovers contract above.
      if (prefetchCovers) {
        prefetchCoverArt(songs);
        for (const a of albums) {
          const albumArtId = coverArtForAlbum(a);
          if (albumArtId) ensureCached(albumArtId).catch(() => { /* non-critical */ });
        }
        for (const a of artists) {
          const artistArtId = coverArtForArtist(a);
          if (artistArtId) ensureCached(artistArtId).catch(() => { /* non-critical */ });
        }
      }
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : i18n.t('failedToLoadFavorites'),
      });
    }
  },

  setOverride: (id: string, starred: boolean) =>
    set((s) => ({ overrides: { ...s.overrides, [id]: starred } })),

  hydrateFromDbAsync: () => {
    if (hydrateInFlight) return hydrateInFlight;
    const run = (async () => {
      const ids = await readStarredIds();
      const next = applyIds(get(), ids);
      if (!get().hydrated || next.version !== get().version) set({ hydrated: true, ...next });
      // Boot is unblocked at this point. The legacy blob import runs off the critical
      // path — it is a full three-entity reconcile, and `hydrateFromDbAsync` is awaited
      // before `onStartup()`.
      runWhenIdle(() => {
        void importLegacyFavoritesBlob()
          .then(() => get().refreshFromDb())
          // Best-effort: a failed import leaves the KV key and `kvImportDone` false, so
          // the next launch retries. Nothing here should surface to the user.
          .catch(() => { /* retried next launch */ });
      });
    })().finally(() => {
      hydrateInFlight = null;
    });
    hydrateInFlight = run;
    return run;
  },

  refreshFromDb: async () => {
    const next = applyIds(get(), await readStarredIds());
    // Skip the `set` entirely when nothing moved: zustand notifies on every write, and
    // the `__starred__` download reactor and the CarPlay refresh both hang off that.
    if (next.version === get().version) return;
    set(next);
  },
}));

/**
 * Adopt new membership sets, keeping the OLD Set object (and the `version`) when the
 * membership is unchanged. Identity stability is what stops the `__starred__` download
 * reactor and the SQL-backed list reloads firing on every no-op refresh.
 */
function applyIds(
  prev: FavoritesState,
  next: StarredIds,
): Pick<FavoritesState, 'songIds' | 'albumIds' | 'artistIds' | 'version'> {
  const songSame = sameSet(prev.songIds, next.songIds);
  const albumSame = sameSet(prev.albumIds, next.albumIds);
  const artistSame = sameSet(prev.artistIds, next.artistIds);
  return {
    songIds: songSame ? prev.songIds : next.songIds,
    albumIds: albumSame ? prev.albumIds : next.albumIds,
    artistIds: artistSame ? prev.artistIds : next.artistIds,
    version: songSame && albumSame && artistSame ? prev.version : prev.version + 1,
  };
}

/**
 * A completed song sync means library rows have arrived for favourites that were in the
 * remainder — promote them onto their rows and repaint. Not load-bearing: the remainder
 * reads already hide a promoted duplicate, so this may fail silently.
 *
 * Module-scope `subscribe` from the DEPENDENT store's file, so `normalizedLibrarySync`
 * gains no import.
 */
syncStatusStore.subscribe((s, prev) => {
  if (s.songSyncComplete === prev.songSyncComplete) return;
  if (!s.songSyncComplete) return;
  void (async () => {
    const db = getDb();
    if (!db) return;
    await promoteResolvedFavorites(db);
    await favoritesStore.getState().refreshFromDb();
  })();
});
