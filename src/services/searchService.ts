import {
  ensureCoverArtAuth,
  search3,
  SEARCH3_RESULT_LIMIT,
  type AlbumID3,
  type ArtistID3,
  type Child,
} from './subsonicService';
import { albumLibraryStore } from '../store/albumLibraryStore';
import { artistLibraryStore } from '../store/artistLibraryStore';
import { musicCacheStore, getSongEnvelope } from '../store/musicCacheStore';
import { playlistLibraryStore } from '../store/playlistLibraryStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { syncStatusStore } from '../store/syncStatusStore';
import { connectivityStore } from '../store/connectivityStore';
import {
  querySongCandidates,
  queryAlbumCandidates,
  hasLocalLibraryRows,
} from '../store/persistence/searchIndexQueries';
import { normalize, tokenize, metaphoneKey, scoreField, scoreCandidate, REJECT, CONFIDENT } from './searchMatch';
import { getGenreNames } from '../utils/genreHelpers';

export interface SearchResults {
  albums: AlbumID3[];
  artists: ArtistID3[];
  songs: Child[];
}

export async function performOnlineSearch(query: string): Promise<SearchResults> {
  await ensureCoverArtAuth();
  return search3(query);
}

/**
 * Construct a Child from a cached_songs row + its parent cached_item.
 *
 * Carries every field the cached row holds — including `coverArt`, which song
 * cover-art resolution reads (#202). Never narrow a reconstruction because "no
 * consumer reads it today"; the data is here, so pass it through.
 */
function childFromCachedSong(
  track: {
    id: string;
    title: string;
    artist?: string;
    albumId: string;
    duration: number;
    coverArt?: string;
  },
  parentItemName?: string,
): Child {
  return {
    id: track.id,
    albumId: track.albumId,
    title: track.title,
    artist: track.artist,
    album: parentItemName,
    duration: track.duration,
    coverArt: track.coverArt,
    isDir: false,
  };
}

/**
 * Offline search over the cached library.
 *
 * The per-song scan can sweep the entire downloaded catalog (tens of
 * thousands of rows on a heavily-cached device), so it runs as an async,
 * chunked loop that yields the JS thread every {@link OFFLINE_SCAN_CHUNK}
 * song iterations — without this, typing in the search box on a large
 * offline library froze the UI for the whole scan. `shouldAbort` lets the
 * caller cancel a superseded scan early when the user has typed further
 * (the keystroke that started this scan is no longer the current query).
 * setTimeout, not rAF — rAF can stall on RN 0.85/Fabric.
 */
const OFFLINE_SCAN_CHUNK = 1024;

export async function performOfflineSearch(
  query: string,
  shouldAbort?: () => boolean,
): Promise<SearchResults> {
  // Empty / whitespace query matches nothing (guards the scan too).
  if (!normalize(query)) return { albums: [], artists: [], songs: [] };
  const { cachedItems, cachedSongs } = musicCacheStore.getState();
  const cachedIds = new Set(Object.keys(cachedItems));

  // Relevance for a name (+ optional artist) — the best of the two field scores.
  const rel = (name: string, artist?: string | null): number =>
    Math.max(
      scoreField(query, name).score,
      artist ? scoreField(query, artist).score : 0,
    );

  const albums = albumLibraryStore
    .getState()
    .albums.filter((a) => cachedIds.has(a.id))
    .map((a) => ({ a, s: rel(a.name, a.artist) }))
    .filter((x) => x.s >= REJECT)
    .sort((x, y) => y.s - x.s)
    .map((x) => x.a);

  const playlists = playlistLibraryStore
    .getState()
    .playlists.filter((p) => cachedIds.has(p.id))
    .map((p) => ({ p, s: scoreField(query, p.name).score }))
    .filter((x) => x.s >= REJECT)
    .sort((x, y) => y.s - x.s)
    .map((x) => x.p);

  const playlistAlbums: AlbumID3[] = playlists.map((p) => ({
    id: p.id,
    name: p.name,
    artist: p.owner,
    coverArt: p.coverArt,
    songCount: p.songCount,
    duration: p.duration,
    created: p.created,
  }));

  const scored: Array<{ c: Child; s: number }> = [];
  const seen = new Set<string>();
  let ops = 0;
  for (const item of Object.values(cachedItems)) {
    for (const songId of item.songIds) {
      // Yield + abort check on a fixed iteration budget, counting every
      // song examined (including skips) so even a single huge item still
      // yields mid-scan.
      if (++ops % OFFLINE_SCAN_CHUNK === 0) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (shouldAbort?.()) return { albums: [], artists: [], songs: [] };
      }
      if (seen.has(songId)) continue;
      const track = cachedSongs[songId];
      if (!track) continue;
      const s = rel(track.title, track.artist);
      if (s >= REJECT) {
        seen.add(songId);
        scored.push({ c: childFromCachedSong(track, item.name), s });
      }
    }
  }
  scored.sort((a, b) => b.s - a.s);

  return {
    albums: [...albums, ...playlistAlbums].slice(0, ALBUM_RESULT_CAP),
    // No artists offline — a meaningful artist view needs online calls.
    artists: [],
    songs: scored.slice(0, SONG_RESULT_CAP).map((x) => x.c),
  };
}

const EMPTY_RESULTS: SearchResults = { albums: [], artists: [], songs: [] };

// Output caps. Local search can score hundreds of candidates; the on-screen
// results list (a SectionList) re-renders the whole set per keystroke, so an
// uncapped list makes the full Search screen janky. Mirror the server path's
// per-category cap (`search3` returns 20 each) so the two paths feel the same
// — not an arbitrary number. Ranked, so the cap keeps the best matches.
const SONG_RESULT_CAP = SEARCH3_RESULT_LIMIT;
const ALBUM_RESULT_CAP = SEARCH3_RESULT_LIMIT;
const ARTIST_RESULT_CAP = SEARCH3_RESULT_LIMIT;

/** The server call can't be allowed to hang the search on a slow/unreachable
 *  host — cap it (local results are already the primary answer). */
const SERVER_SEARCH_TIMEOUT_MS = 5000;

/** Fuzzy/phonetic-tolerant relevance for a name (+ optional artist): the best of
 *  the two field scores. Shared by the full-library SQL path below. */
function relevance(query: string, name: string, artist?: string | null): number {
  return Math.max(
    scoreField(query, name).score,
    artist ? scoreField(query, artist).score : 0,
  );
}

/**
 * Local fuzzy search over the ENTIRE synced library (`song_index` +
 * `library_albums`) via candidate SQL + JS re-rank. Distinct from
 * `performOfflineSearch`, which scans only the downloaded set held in memory.
 * Returns the ranked results plus the top relevance score — the routing gate for
 * whether the server is still worth consulting. `shouldAbort` bails a superseded
 * query (the user typed further).
 */
export async function searchFullLibraryScored(
  query: string,
  shouldAbort?: () => boolean,
): Promise<{ results: SearchResults; topScore: number }> {
  const norm = normalize(query);
  if (!norm) return { results: EMPTY_RESULTS, topScore: 0 };
  const tokens = tokenize(norm);
  // Phonetic tier is gated to tokens ≥4 chars (short tokens over-collide) and
  // to non-empty codes (non-Latin encodes to '' — never a phonetic candidate).
  const dmetaTokens = tokens
    .filter((t) => t.length >= 4)
    .map((t) => metaphoneKey(t))
    .filter((k) => k.length > 0);

  const [songCands, albumCands] = await Promise.all([
    querySongCandidates(norm, tokens, dmetaTokens),
    queryAlbumCandidates(norm, tokens, dmetaTokens),
  ]);
  if (shouldAbort?.()) return { results: EMPTY_RESULTS, topScore: 0 };

  const songs = songCands
    .map((c) => ({ c, s: relevance(query, c.title ?? '', c.artist) }))
    .filter((x) => x.s >= REJECT)
    .sort((a, b) => b.s - a.s);
  const albums = albumCands
    .map((a) => ({ a, s: relevance(query, a.name, a.artist) }))
    .filter((x) => x.s >= REJECT)
    .sort((a, b) => b.s - a.s);

  // Artists (online only): fuzzy-match names against the synced artist library.
  // CONFIDENT floor, not REJECT — this scores every artist un-prefiltered, so a
  // looser floor would admit weak Jaro-Winkler noise.
  const artists = artistLibraryStore
    .getState()
    .artists.map((a) => ({ a, s: scoreField(query, a.name).score }))
    .filter((x) => x.s >= CONFIDENT)
    .sort((x, y) => y.s - x.s);

  const topScore = Math.max(songs[0]?.s ?? 0, albums[0]?.s ?? 0, artists[0]?.s ?? 0);
  return {
    results: {
      albums: albums.slice(0, ALBUM_RESULT_CAP).map((x) => x.a),
      artists: artists.slice(0, ARTIST_RESULT_CAP).map((x) => x.a),
      songs: songs.slice(0, SONG_RESULT_CAP).map((x) => x.c),
    },
    topScore,
  };
}

/** `performOnlineSearch` (search3) wrapped with a timeout + error swallow so a
 *  slow or unreachable server can't hang the search — null on either. */
async function guardedServerSearch(
  query: string,
  shouldAbort?: () => boolean,
): Promise<SearchResults | null> {
  if (shouldAbort?.()) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      performOnlineSearch(query),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), SERVER_SEARCH_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Merge server results into local — local first (it ranked by real relevance),
 *  the server contributing only ids not already present. Per-type dedup by id. */
function mergeResults(local: SearchResults, server: SearchResults): SearchResults {
  const merge = <T extends { id: string }>(a: T[], b: T[]): T[] => {
    const seen = new Set(a.map((x) => x.id));
    return [...a, ...b.filter((x) => !seen.has(x.id))];
  };
  return {
    albums: merge(local.albums, server.albums),
    artists: merge(local.artists, server.artists),
    songs: merge(local.songs, server.songs),
  };
}

export interface SearchLibraryOptions {
  /** Bail early when the query has been superseded (the user typed further). */
  shouldAbort?: () => boolean;
  /**
   * Called with the LOCAL results the instant they're ready, BEFORE any server
   * augmentation. Lets an interactive caller (the search box) render locally
   * without waiting on the network. Only fires on the partial-sync path — the
   * fully-synced / offline / unreachable paths return local directly with
   * nothing further to wait for.
   */
  onLocalResults?: (results: SearchResults) => void;
}

/**
 * Data-state-aware search router shared by the in-app box AND voice. Keys off
 * the hard `offlineMode` toggle, the `isFullySynced` flags, and reachability:
 *   - offlineMode ON → downloaded-only local scan, never the server.
 *   - online, no local corpus → straight to the server (empty if unreachable).
 *   - online, fully synced (or unreachable) → local is authoritative and
 *     COMPLETE; return it immediately — NEVER block an interactive search on the
 *     network (a weak/typo/partial hit is still just local; the server can't
 *     hold anything a fully-synced library doesn't).
 *   - online, partially synced + reachable → surface local FIRST (via
 *     `onLocalResults`), then augment with a timeout-guarded server search for
 *     the entries not yet synced, MERGED into the returned value.
 */
export async function searchLibrary(
  query: string,
  options?: SearchLibraryOptions,
): Promise<SearchResults> {
  const { shouldAbort, onLocalResults } = options ?? {};
  if (!normalize(query)) return EMPTY_RESULTS;

  if (offlineModeStore.getState().offlineMode) {
    return performOfflineSearch(query, shouldAbort);
  }

  const { librarySyncComplete, songSyncComplete } = syncStatusStore.getState();
  const fullySynced = librarySyncComplete && songSyncComplete;
  const { hasConnection, isServerReachable } = connectivityStore.getState();
  const reachable = hasConnection && isServerReachable;

  if (!(await hasLocalLibraryRows())) {
    return reachable ? performOnlineSearch(query) : EMPTY_RESULTS;
  }

  const { results: local } = await searchFullLibraryScored(query, shouldAbort);
  if (shouldAbort?.()) return EMPTY_RESULTS;

  // Local is the complete answer — return instantly, no network wait.
  if (fullySynced || !reachable) return local;

  // Partial sync + reachable → show local now, then augment with the server.
  onLocalResults?.(local);
  const server = await guardedServerSearch(query, shouldAbort);
  if (!server || shouldAbort?.()) return local;
  return mergeResults(local, server);
}

/**
 * Best local album match for a voice "play album" intent. Fuzzy-matches the
 * album name over `library_albums`, weighting the (optional) artist via
 * `scoreCandidate` so "Ten by Pearl Jam" picks Pearl Jam's Ten, not some other
 * "Ten". Local-only (library_albums is on-device, so it works offline too);
 * null when nothing clears the reject floor. The caller fetches + plays the
 * album's tracks in order.
 */
export async function findAlbum(name: string, artist?: string): Promise<AlbumID3 | null> {
  const norm = normalize(name);
  if (!norm) return null;
  const tokens = tokenize(norm);
  const dmetaTokens = tokens
    .filter((t) => t.length >= 4)
    .map((t) => metaphoneKey(t))
    .filter((k) => k.length > 0);
  const candidates = await queryAlbumCandidates(norm, tokens, dmetaTokens);
  if (candidates.length === 0) return null;
  const scored = candidates
    .map((a) => ({ a, score: scoreCandidate({ song: name, artist }, { title: a.name, artist: a.artist }) }))
    .filter((x) => x.score >= REJECT)
    .sort((x, y) => y.score - x.score);
  return scored[0]?.a ?? null;
}

/**
 * Songs strongly attributed to an artist for a voice "play artist" intent. Runs
 * the shared offline/online-aware `searchLibrary` on the artist name, then keeps
 * only hits whose ARTIST field confidently matches (drops same-named-title
 * noise). Bounded by the search cap — the top tracks, plenty to seed a queue.
 */
export async function findArtistSongs(name: string): Promise<Child[]> {
  if (!normalize(name)) return [];
  const { songs } = await searchLibrary(name);
  return songs.filter((s) => scoreField(name, s.artist ?? '').score >= CONFIDENT);
}

/**
 * Every downloaded song, optionally filtered by genre.
 *
 * Iterates `cachedItems` (downloaded items including the `__starred__`
 * aggregate) → `songIds` → `cachedSongs`. Dedup by song id so a track
 * that lives under multiple cached items appears once.
 *
 * Genre filtering reads each song's full envelope via `getSongEnvelope()`
 * (lazy JSON parse with WeakMap memoisation) since the `cached_songs` hot
 * columns don't carry genre. For text-only paths (no genre filter) we
 * never touch the envelope, so the call is essentially free.
 */
function collectOfflineSongs(genreFilter?: string): Child[] {
  const g = genreFilter?.toLowerCase();
  const { cachedItems, cachedSongs } = musicCacheStore.getState();

  const out: Child[] = [];
  const seen = new Set<string>();

  for (const item of Object.values(cachedItems)) {
    for (const songId of item.songIds) {
      if (seen.has(songId)) continue;
      const track = cachedSongs[songId];
      if (!track) continue;
      if (g) {
        const envelope = getSongEnvelope(songId);
        const names = envelope ? getGenreNames(envelope) : [];
        if (!names.some((name) => name.toLowerCase() === g)) continue;
      }
      seen.add(songId);
      out.push(childFromCachedSong(track, item.name));
    }
  }

  return out;
}

export function getOfflineSongsByGenre(genre: string): Child[] {
  return collectOfflineSongs(genre);
}

/**
 * The set of genre names (lowercased) present anywhere in the offline (cached)
 * library. Single pass over all cached songs, parsing each envelope once.
 *
 * Replaces the O(genres × songs) pattern of calling `getOfflineSongsByGenre`
 * once per candidate genre (which re-walks the whole library per genre) — used
 * by the Tuned-In builder's offline genre list, which previously froze on a
 * large offline library at screen mount.
 */
export function getOfflineGenresPresent(): Set<string> {
  const { cachedItems, cachedSongs } = musicCacheStore.getState();
  const present = new Set<string>();
  const seen = new Set<string>();
  for (const item of Object.values(cachedItems)) {
    for (const songId of item.songIds) {
      if (seen.has(songId)) continue;
      seen.add(songId);
      if (!cachedSongs[songId]) continue;
      const envelope = getSongEnvelope(songId);
      if (!envelope) continue;
      for (const name of getGenreNames(envelope)) present.add(name.toLowerCase());
    }
  }
  return present;
}

export function getOfflineSongsAll(): Child[] {
  return collectOfflineSongs();
}
