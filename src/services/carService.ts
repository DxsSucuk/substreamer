/**
 * CarPlay / Android Auto browse + playback service.
 *
 * Feeds RNQP a browse snapshot built from the app's stores and resolves
 * taps/voice to the app's `playTrack()` (which carries all app bookkeeping —
 * offline filtering, streaming, artwork, scrobble). Registered at bootstrap
 * (AFTER `configure()`) so a cold car / Siri / Assistant wake is served before
 * any UI mounts. Mirrors the RNQP demo's `carService.ts` lifecycle:
 *   installCarService → registerPlaybackService(() => handler) + pushSnapshot,
 *   push on onCarConnect, re-install on onServiceReady('service-reborn').
 *
 * The four sections (platform ~4-tab limit): Home (curated album lists, offline
 * recomposed via homeSectionsService), Favorites (flat songs), Albums (A–Z
 * buckets), Playlists. See src/services/carService.helpers.ts for the id scheme
 * + A–Z bucketing, and plans/carplay-android-auto.md for the full design.
 */
import type {
  BrowseItem,
  BrowseSection,
  BrowseSnapshot,
  MediaSearchRequest,
  PlaybackServiceHandler,
  TrackItem,
} from 'react-native-queue-player';
import { getTrackPlayer, registerPlaybackService, SectionIcon } from 'react-native-queue-player';

import type { AlbumID3, Child, Playlist } from './subsonicService';
import { getCoverArtUrl } from './subsonicService';
import { buildPlayableQueue } from './playerHelpers';
import { playTrack } from './playerService';
import {
  performOfflineSearch,
  performOnlineSearch,
  getOfflineSongsAll,
  getOfflineSongsByGenre,
} from './searchService';
import { getLocalTrackUri } from './musicCacheService';
import { composeHomeAlbumSections } from './homeSectionsService';
import { albumLibraryStore } from '../store/albumLibraryStore';
import { playlistLibraryStore } from '../store/playlistLibraryStore';
import { favoritesStore } from '../store/favoritesStore';
import { albumListsStore } from '../store/albumListsStore';
import { albumDetailStore } from '../store/albumDetailStore';
import { playlistDetailStore } from '../store/playlistDetailStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { musicCacheStore } from '../store/musicCacheStore';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { albumPassesDownloadedFilter } from '../store/persistence/cachedItemHelpers';
import i18n from '../i18n/i18n';
import {
  CAR_ROOT_ID,
  CAR_MAX_ITEMS_PER_NODE,
  sectionId,
  listId,
  albumId,
  playlistId,
  albumTrackId,
  playlistTrackId,
  favTrackId,
  parseMediaId,
  albumLetterRows,
  albumsForLetter,
  albumsForBucket,
  resolveAlbumLetterNode,
  type AzItem,
} from './carService.helpers';

const LOG_TAG = '[carService]';
const ART_SIZE = 300;
const SEARCH_ID_PREFIX = 'search:';

/* ------------------------------------------------------------------ */
/*  Mode-appropriate data selectors                                    */
/* ------------------------------------------------------------------ */

function isOffline(): boolean {
  return offlineModeStore.getState().offlineMode;
}

/** Library albums, filtered to downloaded when offline. */
function albumSet(): AlbumID3[] {
  const albums = albumLibraryStore.getState().albums;
  if (!isOffline()) return albums;
  const cachedItems = musicCacheStore.getState().cachedItems;
  const includePartial = layoutPreferencesStore.getState().includePartialInDownloadedFilter;
  return albums.filter((a) => albumPassesDownloadedFilter(a, cachedItems, includePartial));
}

/** Favorite songs, filtered to downloaded when offline. */
function favoriteSongs(): Child[] {
  const songs = favoritesStore.getState().songs;
  if (!isOffline()) return songs;
  return songs.filter((s) => getLocalTrackUri(s.id) != null);
}

/** Playlists, filtered to cached when offline (playlists download atomically). */
function playlistSet(): Playlist[] {
  const pls = playlistLibraryStore.getState().playlists;
  if (!isOffline()) return pls;
  const cachedItems = musicCacheStore.getState().cachedItems;
  return pls.filter((p) => p.id in cachedItems);
}

function azItems(): AzItem[] {
  return albumSet().map((a) => ({ id: a.id, title: a.name, coverArt: a.coverArt ?? undefined }));
}

function homeInput() {
  const offline = isOffline();
  const lists = albumListsStore.getState();
  return {
    recentlyAdded: lists.recentlyAdded,
    recentlyPlayed: lists.recentlyPlayed,
    frequentlyPlayed: lists.frequentlyPlayed,
    randomSelection: lists.randomSelection,
    allLibraryAlbums: albumLibraryStore.getState().albums,
    offlineMode: offline,
    downloadedOnly: offline,
    favoritesOnly: false,
    starredAlbums: favoritesStore.getState().albums,
    cachedItems: musicCacheStore.getState().cachedItems,
    includePartial: layoutPreferencesStore.getState().includePartialInDownloadedFilter,
  };
}

/* ------------------------------------------------------------------ */
/*  Browse-item mappers                                                */
/* ------------------------------------------------------------------ */

function albumRow(album: AlbumID3): BrowseItem {
  return {
    id: albumId(album.id),
    title: album.name,
    subtitle: album.artist ?? undefined,
    artworkUrl: getCoverArtUrl(album.coverArt ?? album.id, ART_SIZE) ?? undefined,
    playable: false,
    hasChildren: true,
  };
}

/** A–Z leaf album row — artwork via the coverArt carried on the AzItem (no
 *  artist subtitle; the AzItem carries only id/title/coverArt). */
const toAzAlbumRow = (a: AzItem): BrowseItem => ({
  id: albumId(a.id),
  title: a.title,
  artworkUrl: getCoverArtUrl(a.coverArt ?? a.id, ART_SIZE) ?? undefined,
  playable: false,
  hasChildren: true,
});

function playlistRow(pl: Playlist): BrowseItem {
  return {
    id: playlistId(pl.id),
    title: pl.name,
    subtitle: i18n.t('cacheTracksValue', { count: pl.songCount }),
    artworkUrl: getCoverArtUrl(pl.coverArt ?? pl.id, ART_SIZE) ?? undefined,
    playable: false,
    hasChildren: true,
  };
}

function trackRow(track: Child, id: string): BrowseItem {
  return {
    id,
    title: track.title,
    subtitle: track.artist ?? undefined,
    artworkUrl: getCoverArtUrl(track.coverArt ?? track.albumId ?? track.id, ART_SIZE) ?? undefined,
    playable: true,
    hasChildren: false,
  };
}

/* ------------------------------------------------------------------ */
/*  Snapshot                                                           */
/* ------------------------------------------------------------------ */

function buildSnapshot(): BrowseSnapshot {
  // Home: curated album lists (offline recomposed — drop Random, add
  // Downloaded Albums, filter to downloaded) — one drill row per non-empty list.
  const homeItems: BrowseItem[] = composeHomeAlbumSections(homeInput())
    .filter((s) => s.albums.length > 0)
    .map((s) => ({
      id: listId(s.type),
      title: i18n.t(s.titleKey),
      playable: false,
      hasChildren: true,
    }));

  // Favorites: flat playable songs (display-capped; play uses the same list).
  const favItems: BrowseItem[] = favoriteSongs()
    .slice(0, CAR_MAX_ITEMS_PER_NODE)
    .map((s, i) => trackRow(s, favTrackId(i)));

  // Albums: A–Z letter buckets first (mandatory — libraries exceed the cap).
  const albumItems = albumLetterRows(azItems());

  // Playlists: shown directly (display-capped; play loads the full list).
  const playlistItems: BrowseItem[] = playlistSet()
    .slice(0, CAR_MAX_ITEMS_PER_NODE)
    .map(playlistRow);

  const sections: BrowseSection[] = [
    { id: sectionId('home'), title: i18n.t('home'), icon: SectionIcon.Home, items: homeItems },
    {
      id: sectionId('favorites'),
      title: i18n.t('favorites'),
      icon: SectionIcon.Favourites,
      items: favItems,
    },
    { id: sectionId('albums'), title: i18n.t('albums'), icon: SectionIcon.Albums, items: albumItems },
    {
      id: sectionId('playlists'),
      title: i18n.t('playlists'),
      icon: SectionIcon.Playlists,
      items: playlistItems,
    },
  ];
  return { rootId: CAR_ROOT_ID, sections };
}

/* ------------------------------------------------------------------ */
/*  Drilldown resolution                                               */
/* ------------------------------------------------------------------ */

/** Album tracks — server fetch, falling back to the offline cache. */
async function albumSongs(id: string): Promise<Child[]> {
  try {
    const album = await albumDetailStore.getState().fetchAlbum(id);
    if (album?.song?.length) return album.song;
  } catch (e) {
    console.warn(`${LOG_TAG} fetchAlbum(${id}) failed:`, e);
  }
  return getOfflineSongsAll().filter((s) => s.albumId === id);
}

/** Playlist entries — server fetch (best-effort; empty on failure). */
async function playlistSongs(id: string): Promise<Child[]> {
  try {
    const pl = await playlistDetailStore.getState().fetchPlaylist(id);
    if (pl?.entry?.length) return pl.entry;
  } catch (e) {
    console.warn(`${LOG_TAG} fetchPlaylist(${id}) failed:`, e);
  }
  return [];
}

async function resolveBrowseChildren(parentId: string): Promise<BrowseItem[]> {
  const p = parseMediaId(parentId);
  switch (p.kind) {
    case 'list': {
      const section = composeHomeAlbumSections(homeInput()).find((s) => s.type === p.list);
      return (section?.albums ?? []).map(albumRow);
    }
    case 'azLetter':
      return resolveAlbumLetterNode(albumsForLetter(azItems(), p.letter), p.letter, toAzAlbumRow);
    case 'azBucket':
      return albumsForBucket(azItems(), p.letter, p.lo, p.hi).map(toAzAlbumRow);
    case 'album':
      return (await albumSongs(p.albumId)).map((s, i) => trackRow(s, albumTrackId(p.albumId, i)));
    case 'playlist':
      return (await playlistSongs(p.playlistId))
        .slice(0, CAR_MAX_ITEMS_PER_NODE)
        .map((s, i) => trackRow(s, playlistTrackId(p.playlistId, i)));
    default:
      return [];
  }
}

/* ------------------------------------------------------------------ */
/*  Play resolution                                                    */
/* ------------------------------------------------------------------ */

interface ResolvedPlayback {
  queue: Child[];
  startIndex: number;
  sourcePlaylistId: string | null;
}

const clampIndex = (i: number, q: readonly Child[]): number =>
  i >= 0 && i < q.length ? i : 0;

/** Last search's songs — so a tapped search-result row resolves to playback. */
let lastSearchSongs: Child[] = [];

async function resolvePlayback(mediaId: string): Promise<ResolvedPlayback> {
  if (mediaId.startsWith(SEARCH_ID_PREFIX)) {
    const i = Number(mediaId.slice(SEARCH_ID_PREFIX.length));
    if (Number.isInteger(i) && i >= 0 && i < lastSearchSongs.length) {
      return { queue: lastSearchSongs, startIndex: i, sourcePlaylistId: null };
    }
    return { queue: [], startIndex: 0, sourcePlaylistId: null };
  }
  const p = parseMediaId(mediaId);
  if (p.kind === 'track') {
    if (p.ctx === 'album') {
      const queue = await albumSongs(p.ctxId);
      return { queue, startIndex: clampIndex(p.index, queue), sourcePlaylistId: null };
    }
    if (p.ctx === 'playlist') {
      const queue = await playlistSongs(p.ctxId);
      return { queue, startIndex: clampIndex(p.index, queue), sourcePlaylistId: p.ctxId };
    }
    // fav
    const queue = favoriteSongs();
    return { queue, startIndex: clampIndex(p.index, queue), sourcePlaylistId: null };
  }
  return { queue: [], startIndex: 0, sourcePlaylistId: null };
}

function findPlaylistByName(name: string): Playlist | undefined {
  const target = name.trim().toLowerCase();
  const pls = playlistSet();
  return (
    pls.find((p) => p.name.trim().toLowerCase() === target) ??
    pls.find((p) => p.name.trim().toLowerCase().includes(target))
  );
}

/** Resolve a voice request → a Child[] to play. Structured fields first
 *  (playlist by name, then genre), else the query's song matches. */
async function resolveVoice(request: MediaSearchRequest): Promise<Child[]> {
  if (request.playlist) {
    const pl = findPlaylistByName(request.playlist);
    if (pl) {
      const songs = await playlistSongs(pl.id);
      if (songs.length) return songs;
    }
  }
  if (request.genre) {
    const byGenre = isOffline()
      ? getOfflineSongsByGenre(request.genre)
      : await getOnlineSongsByGenre(request.genre);
    if (byGenre.length) return byGenre;
  }
  const results = isOffline()
    ? await performOfflineSearch(request.query)
    : await performOnlineSearch(request.query);
  return results.songs;
}

/**
 * Dispatch a voice request (Android App Actions deep link, from the `play`
 * route) through the same resolver + playback path as `onPlayFromSearchRequest`.
 */
export async function dispatchVoiceSearchRequest(request: MediaSearchRequest): Promise<void> {
  const queue = await resolveVoice(request);
  if (queue.length === 0) return;
  await playTrack(queue[0], queue, null);
}

/** Online genre → songs via a search fallback (no dedicated genre API here). */
async function getOnlineSongsByGenre(genre: string): Promise<Child[]> {
  const results = await performOnlineSearch(genre);
  return results.songs.filter((s) => (s.genre ?? '').toLowerCase() === genre.toLowerCase());
}

async function resolveSearch(query: string): Promise<BrowseItem[]> {
  if (query.trim().length === 0) return [];
  const results = isOffline()
    ? await performOfflineSearch(query)
    : await performOnlineSearch(query);
  lastSearchSongs = results.songs;
  const songRows = results.songs.map((s, i) => trackRow(s, `${SEARCH_ID_PREFIX}${i}`));
  const albumRows = results.albums.map(albumRow);
  // Songs first (most likely intent), then album drill rows; cap per node.
  return [...songRows, ...albumRows].slice(0, CAR_MAX_ITEMS_PER_NODE);
}

/* ------------------------------------------------------------------ */
/*  Snapshot push + voice vocabulary                                   */
/* ------------------------------------------------------------------ */

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function donateVocabulary(): void {
  try {
    const artists = uniqueSorted([
      ...albumLibraryStore.getState().albums.map((a) => a.artist).filter((a): a is string => !!a),
      ...favoritesStore.getState().artists.map((a) => a.name),
    ]);
    const playlists = playlistLibraryStore.getState().playlists.map((p) => p.name);
    getTrackPlayer().donateVoiceVocabulary({ artists, playlists });
  } catch (e) {
    console.warn(`${LOG_TAG} donateVoiceVocabulary failed:`, e);
  }
}

async function pushSnapshot(): Promise<void> {
  try {
    const snapshot = buildSnapshot();
    getTrackPlayer().setBrowseSnapshot(snapshot);
    donateVocabulary();
  } catch (e) {
    console.warn(`${LOG_TAG} pushSnapshot failed:`, e);
  }
}

/* ------------------------------------------------------------------ */
/*  Handler + lifecycle                                                */
/* ------------------------------------------------------------------ */

const handler: PlaybackServiceHandler = {
  onBrowseRequest: (parentId) => resolveBrowseChildren(parentId),
  onSearchRequest: (query) => resolveSearch(query),
  onPlayFromIdRequest: async (mediaId) => {
    const { queue, startIndex, sourcePlaylistId } = await resolvePlayback(mediaId);
    if (queue.length === 0) return [];
    // Fire-and-forget playTrack (carries app bookkeeping); native steps back and
    // does not double-apply. Return the TrackItem[] for the RNQP contract.
    void playTrack(queue[startIndex], queue, sourcePlaylistId);
    const { rnTracks } = await buildPlayableQueue(queue);
    return rnTracks;
  },
  onPlayFromSearchRequest: async (request) => {
    const queue = await resolveVoice(request);
    if (queue.length === 0) return [];
    void playTrack(queue[0], queue, null);
    const { rnTracks } = await buildPlayableQueue(queue);
    return rnTracks;
  },
  onCarConnect: () => {
    carConnected = true;
    void pushSnapshot();
  },
  onCarDisconnect: () => {
    carConnected = false;
  },
  onServiceReady: (reason) => {
    if (reason === 'service-reborn') {
      // The OS rebuilt the service after a kill; its BrowseDataProvider starts
      // empty. Drop the guard so installCarService re-registers + re-pushes.
      installed = false;
      installCarService();
    }
  },
};

let installed = false;
let carConnected = false;
let subscribed = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Coalesce library-change re-pushes into one push per ~30s, and only while a
 *  car is connected — never churn the native cache on every store write
 *  (anti-refresh-loop). */
function scheduleRefresh(): void {
  if (!carConnected || refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (carConnected) void pushSnapshot();
  }, 30_000);
}

/**
 * Idempotent install — register the handler + push the initial snapshot, and
 * (once) subscribe to offline-mode flips to re-push. Call at bootstrap AFTER
 * `configure()` resolves. RNQP's `registerPlaybackService` is itself idempotent
 * (replaces prior registrations); the guard is bookkeeping for our bootstrap.
 */
export function installCarService(): void {
  if (installed) return;
  installed = true;
  registerPlaybackService(() => handler);
  void pushSnapshot();
  if (!subscribed) {
    subscribed = true;
    // Offline flip rebuilds the whole tree — push immediately (connect-gated).
    offlineModeStore.subscribe((state, prev) => {
      if (state.offlineMode !== prev.offlineMode && carConnected) void pushSnapshot();
    });
    // Library changes → a debounced, connect-gated refresh so the car tree
    // stays current without churning on every write. Module-lifetime subs.
    albumListsStore.subscribe(scheduleRefresh);
    favoritesStore.subscribe(scheduleRefresh);
    playlistLibraryStore.subscribe(scheduleRefresh);
  }
}

/**
 * Re-push the snapshot once stores are hydrated (called from the app boot path
 * after `initPlayer()`), so a cold car wake that rendered an empty skeleton
 * self-corrects. No-op when no car is connected.
 */
export function refreshCarSnapshot(): void {
  if (carConnected) void pushSnapshot();
}

/** Internal resolvers exposed for unit tests (not part of the public API). */
export const __test = { buildSnapshot, resolveBrowseChildren, resolvePlayback };
