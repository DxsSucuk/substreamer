/**
 * Drizzle schema — the fully-normalized data model for the persistence rebuild.
 * One column per typed Subsonic field (scalars on the entity tables,
 * arrays/nested objects as child tables or flattened columns) — NO raw_json blob.
 * Details are relationships, not blobs (album detail = songs WHERE album_id=?, etc.).
 *
 * Conventions:
 *  - `snake_case` columns; TEXT server-id primary keys on normal rowid tables
 *    (WITHOUT ROWID dropped — breaks op-SQLite rowid-keyed reactivity + Drizzle
 *    can't emit it). Bulk-sync inserts MUST be id-sorted batches (see the design doc).
 *  - Timestamps stored as epoch-ms INTEGER (repository converts Date↔epoch).
 *  - Booleans stored as 0/1 via `{ mode: 'boolean' }`.
 *  - ReplayGain flattened to `rg_*` REAL columns (1:1, no child table).
 *  - Search keeps the existing tiered `norm_*` (accent-folded) + `dmeta_*`
 *    (double-metaphone) columns — not FTS5.
 *  - Child tables cascade-delete with their parent entity.
 *
 * This schema is additive: it stands alongside the legacy blob tables until
 * consumers are cut over and the old tables dropped.
 */
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// ─────────────────────────────────────────────────────────────────────────────
// Entities
// ─────────────────────────────────────────────────────────────────────────────

/** The full library song set (the big table). One column per consumed `Child` field. */
export const songs = sqliteTable(
  'songs',
  {
    id: text('id').primaryKey(),
    albumId: text('album_id'),
    artistId: text('artist_id'),
    title: text('title'),
    album: text('album'),
    artist: text('artist'),
    displayArtist: text('display_artist'),
    displayAlbumArtist: text('display_album_artist'),
    displayComposer: text('display_composer'),
    track: integer('track'),
    discNumber: integer('disc_number'),
    year: integer('year'),
    genre: text('genre'),
    coverArt: text('cover_art'),
    duration: integer('duration'),
    size: integer('size'),
    contentType: text('content_type'),
    suffix: text('suffix'),
    transcodedContentType: text('transcoded_content_type'),
    transcodedSuffix: text('transcoded_suffix'),
    bitRate: integer('bit_rate'),
    bitDepth: integer('bit_depth'),
    samplingRate: integer('sampling_rate'),
    channelCount: integer('channel_count'),
    path: text('path'),
    userRating: integer('user_rating'),
    averageRating: real('average_rating'),
    playCount: integer('play_count'),
    created: integer('created'),
    starred: integer('starred'),
    played: text('played'),
    type: text('type'),
    bpm: integer('bpm'),
    comment: text('comment'),
    sortName: text('sort_name'),
    // article-stripped / accent-folded A–Z key (computed in JS via getSortKey)
    sortTitle: text('sort_title'),
    // article-stripped / accent-folded ARTIST key — A–Z key for the "sort by
    // artist" song browse (distinct from norm_artist, which is for search).
    sortArtist: text('sort_artist'),
    musicBrainzId: text('music_brainz_id'),
    explicitStatus: text('explicit_status'),
    bookmarkPosition: integer('bookmark_position'),
    isVideo: integer('is_video', { mode: 'boolean' }),
    isDir: integer('is_dir', { mode: 'boolean' }),
    parent: text('parent'),
    // video-only dimensions (Child.originalWidth/Height)
    originalWidth: integer('original_width'),
    originalHeight: integer('original_height'),
    // flattened ReplayGain (1:1)
    rgTrackGain: real('rg_track_gain'),
    rgAlbumGain: real('rg_album_gain'),
    rgTrackPeak: real('rg_track_peak'),
    rgAlbumPeak: real('rg_album_peak'),
    rgBaseGain: real('rg_base_gain'),
    rgFallbackGain: real('rg_fallback_gain'),
    // tiered search (accent-folded + double-metaphone), populated on upsert/migration
    normTitle: text('norm_title'),
    normArtist: text('norm_artist'),
    dmetaTitle: text('dmeta_title'),
    dmetaArtist: text('dmeta_artist'),
  },
  (t) => ({
    sortIdx: index('idx_songs_sort').on(t.sortTitle, t.id),
    artistSortIdx: index('idx_songs_artist_sort').on(t.sortArtist, t.sortTitle, t.id),
    albumIdx: index('idx_songs_album').on(t.albumId),
    artistIdx: index('idx_songs_artist').on(t.artistId),
    // favorites: only starred rows, pre-sorted to the list order
    starredIdx: index('idx_songs_starred')
      .on(t.starred, t.sortTitle, t.id)
      .where(sql`${t.starred} IS NOT NULL`),
    normTitleIdx: index('idx_songs_norm_title').on(t.normTitle),
    dmetaTitleIdx: index('idx_songs_dmeta_title').on(t.dmetaTitle),
    dmetaArtistIdx: index('idx_songs_dmeta_artist').on(t.dmetaArtist),
  }),
);

/** Album-browse set. One column per consumed `AlbumID3` field (dates flattened). */
export const albums = sqliteTable(
  'albums',
  {
    id: text('id').primaryKey(),
    artistId: text('artist_id'),
    name: text('name'),
    artist: text('artist'),
    displayArtist: text('display_artist'),
    coverArt: text('cover_art'),
    songCount: integer('song_count'),
    duration: integer('duration'),
    playCount: integer('play_count'),
    created: integer('created'),
    starred: integer('starred'),
    year: integer('year'),
    genre: text('genre'),
    played: text('played'),
    userRating: integer('user_rating'),
    version: text('version'),
    musicBrainzId: text('music_brainz_id'),
    sortName: text('sort_name'),
    sortTitle: text('sort_title'),
    // Article-stripped/folded ARTIST sort key (getSortKey of displayArtist) — the
    // A–Z key for the "sort by artist" browse; distinct from norm_artist (search).
    sortArtist: text('sort_artist'),
    isCompilation: integer('is_compilation', { mode: 'boolean' }),
    explicitStatus: text('explicit_status'),
    // flattened ItemDate (originalReleaseDate / releaseDate)
    originalReleaseYear: integer('original_release_year'),
    originalReleaseMonth: integer('original_release_month'),
    originalReleaseDay: integer('original_release_day'),
    releaseYear: integer('release_year'),
    releaseMonth: integer('release_month'),
    releaseDay: integer('release_day'),
    // AlbumInfo (getAlbumInfo2; fetched on demand, nullable until fetched)
    notes: text('notes'),
    lastFmUrl: text('last_fm_url'),
    imageUrlSmall: text('image_url_small'),
    imageUrlMedium: text('image_url_medium'),
    imageUrlLarge: text('image_url_large'),
    normName: text('norm_name'),
    normArtist: text('norm_artist'),
    dmetaName: text('dmeta_name'),
    dmetaArtist: text('dmeta_artist'),
  },
  (t) => ({
    sortIdx: index('idx_albums_sort').on(t.sortTitle, t.id),
    artistSortIdx: index('idx_albums_artist_sort').on(t.sortArtist, t.sortTitle, t.id),
    artistIdx: index('idx_albums_artist').on(t.artistId),
    starredIdx: index('idx_albums_starred')
      .on(t.starred, t.sortTitle, t.id)
      .where(sql`${t.starred} IS NOT NULL`),
    createdIdx: index('idx_albums_created').on(t.created),
    normNameIdx: index('idx_albums_norm_name').on(t.normName),
    dmetaNameIdx: index('idx_albums_dmeta_name').on(t.dmetaName),
    dmetaArtistIdx: index('idx_albums_dmeta_artist').on(t.dmetaArtist),
  }),
);

/** Artist-browse set: `ArtistID3` scalars + `ArtistInfo2` bio/image columns. */
export const artists = sqliteTable(
  'artists',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    sortName: text('sort_name'),
    sortTitle: text('sort_title'),
    coverArt: text('cover_art'),
    artistImageUrl: text('artist_image_url'),
    albumCount: integer('album_count'),
    starred: integer('starred'),
    userRating: integer('user_rating'),
    musicBrainzId: text('music_brainz_id'),
    // ArtistInfo2 (fetched on demand; nullable until fetched). `biography` holds the
    // RESOLVED bio (Subsonic → MusicBrainz fallback). `bioCheckedAt` is the detail-fetch
    // marker + MB negative-cache timestamp; `resolvedMbid` the MBID actually used.
    biography: text('biography'),
    bioCheckedAt: integer('bio_checked_at'),
    resolvedMbid: text('resolved_mbid'),
    lastFmUrl: text('last_fm_url'),
    imageUrlSmall: text('image_url_small'),
    imageUrlMedium: text('image_url_medium'),
    imageUrlLarge: text('image_url_large'),
    normName: text('norm_name'),
    dmetaName: text('dmeta_name'),
  },
  (t) => ({
    sortIdx: index('idx_artists_sort').on(t.sortTitle, t.id),
    starredIdx: index('idx_artists_starred')
      .on(t.starred, t.sortTitle, t.id)
      .where(sql`${t.starred} IS NOT NULL`),
    normNameIdx: index('idx_artists_norm_name').on(t.normName),
    dmetaNameIdx: index('idx_artists_dmeta_name').on(t.dmetaName),
  }),
);

/** Playlists. Membership is the `playlist_songs` junction (ordered, dup-allowed). */
export const playlists = sqliteTable(
  'playlists',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    comment: text('comment'),
    coverArt: text('cover_art'),
    created: integer('created'),
    changed: integer('changed'),
    duration: integer('duration'),
    owner: text('owner'),
    public: integer('public', { mode: 'boolean' }),
    songCount: integer('song_count'),
    // article-stripped / accent-folded A–Z key (getSortKey of name; playlists have
    // no server sortName). Article-aware sort, consistent with albums/songs/artists.
    sortTitle: text('sort_title'),
    normName: text('norm_name'),
    dmetaName: text('dmeta_name'),
  },
  (t) => ({
    // NEW index name (not the old idx_playlists_sort on `name`): CREATE INDEX IF NOT
    // EXISTS keys on the index NAME, so reusing it would be a no-op on existing DBs and
    // leave keyset paging unindexed. The old idx_playlists_sort lingers harmlessly.
    sortTitleIdx: index('idx_playlists_sort_title').on(t.sortTitle, t.id),
    normNameIdx: index('idx_playlists_norm_name').on(t.normName),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Song children (every typed array on `Child`)
// ─────────────────────────────────────────────────────────────────────────────

export const songGenres = sqliteTable(
  'song_genres',
  {
    songId: text('song_id')
      .notNull()
      .references(() => songs.id, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(),
    name: text('name').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.songId, t.pos] }) }),
);

export const songArtists = sqliteTable(
  'song_artists',
  {
    songId: text('song_id')
      .notNull()
      .references(() => songs.id, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(),
    artistId: text('artist_id'),
    // denormalized so the ref is self-contained even if the artist isn't in `artists`
    artistName: text('artist_name'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.songId, t.pos] }) }),
);

export const songAlbumArtists = sqliteTable(
  'song_album_artists',
  {
    songId: text('song_id')
      .notNull()
      .references(() => songs.id, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(),
    artistId: text('artist_id'),
    artistName: text('artist_name'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.songId, t.pos] }) }),
);

export const songContributors = sqliteTable(
  'song_contributors',
  {
    songId: text('song_id')
      .notNull()
      .references(() => songs.id, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(),
    role: text('role').notNull(),
    subRole: text('sub_role'),
    artistId: text('artist_id'),
    artistName: text('artist_name'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.songId, t.pos] }) }),
);

export const songMoods = sqliteTable(
  'song_moods',
  {
    songId: text('song_id')
      .notNull()
      .references(() => songs.id, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(),
    mood: text('mood').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.songId, t.pos] }) }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Album children
// ─────────────────────────────────────────────────────────────────────────────

export const albumGenres = sqliteTable(
  'album_genres',
  {
    albumId: text('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(),
    name: text('name').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.albumId, t.pos] }) }),
);

export const albumArtists = sqliteTable(
  'album_artists',
  {
    albumId: text('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(),
    artistId: text('artist_id'),
    artistName: text('artist_name'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.albumId, t.pos] }) }),
);

export const albumReleaseTypes = sqliteTable(
  'album_release_types',
  {
    albumId: text('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(),
    name: text('name').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.albumId, t.pos] }) }),
);

export const albumMoods = sqliteTable(
  'album_moods',
  {
    albumId: text('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(),
    mood: text('mood').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.albumId, t.pos] }) }),
);

export const albumRecordLabels = sqliteTable(
  'album_record_labels',
  {
    albumId: text('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(),
    name: text('name').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.albumId, t.pos] }) }),
);

export const albumDiscTitles = sqliteTable(
  'album_disc_titles',
  {
    albumId: text('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    disc: integer('disc').notNull(),
    title: text('title').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.albumId, t.disc] }) }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Artist children
// ─────────────────────────────────────────────────────────────────────────────

export const artistRoles = sqliteTable(
  'artist_roles',
  {
    artistId: text('artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(),
    role: text('role').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.artistId, t.pos] }) }),
);

export const artistSimilar = sqliteTable(
  'artist_similar',
  {
    artistId: text('artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(),
    similarArtistId: text('similar_artist_id'),
    name: text('name'),
    // Denormalized from getArtistInfo2's similarArtist payload so the artist-detail
    // "Similar Artists" cards render art + album count without a second fetch.
    coverArt: text('cover_art'),
    albumCount: integer('album_count'),
    userRating: integer('user_rating'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.artistId, t.pos] }) }),
);

// Artist "top songs" (Subsonic getTopSongs, by artist name) — ordered membership so the
// artist-detail screen resolves them from the DB. Songs themselves live in `songs`.
export const artistTopSongs = sqliteTable(
  'artist_top_songs',
  {
    artistId: text('artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(),
    songId: text('song_id').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.artistId, t.pos] }) }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Playlist children
// ─────────────────────────────────────────────────────────────────────────────

export const playlistSongs = sqliteTable(
  'playlist_songs',
  {
    playlistId: text('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    songId: text('song_id').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.playlistId, t.position] }),
    songIdx: index('idx_playlist_songs_song').on(t.songId),
  }),
);

export const playlistAllowedUsers = sqliteTable(
  'playlist_allowed_users',
  {
    playlistId: text('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(),
    username: text('username').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.playlistId, t.pos] }) }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Kept tables — permanent user data, NOT part of the library model
//
// These predate the normalized rebuild and survive it: the KV blob store (auth,
// settings, theme), scrobble history, the download tables and the image cache.
// They live here so `ensureNormalizedSchema` owns every CREATE/ALTER/INDEX in one
// ordered pass (tables → add missing columns → indexes) — the hand-written block in
// `db.ts` had no such ordering, which is how a `hour` index came to be created before
// the `hour` column and took DB init down.
//
// They are classified as KEPT_TABLES in `createNormalizedTables.ts` so a resync,
// server switch or dev spike can never drop them. Definitions transcribed 1:1 from the
// former `db.ts` block, which already includes every column ever ALTER-added.
// ─────────────────────────────────────────────────────────────────────────────

/** Generic key/value blob store — Zustand `persist` targets this. */
export const storage = sqliteTable('storage', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/** Completed scrobbles. The structured columns back the SQL analytics aggregates;
 *  `hour`/`day_key` are device-local buckets computed at write time. */
export const scrobbleEvents = sqliteTable(
  'scrobble_events',
  {
    id: text('id').primaryKey(),
    songJson: text('song_json').notNull(),
    time: integer('time').notNull(),
    songId: text('song_id'),
    artist: text('artist'),
    artistId: text('artist_id'),
    album: text('album'),
    albumId: text('album_id'),
    coverArt: text('cover_art'),
    genre: text('genre'),
    year: integer('year'),
    duration: integer('duration'),
    hour: integer('hour'),
    dayKey: text('day_key'),
  },
  (t) => ({
    timeIdx: index('idx_scrobble_events_time').on(t.time),
    hourIdx: index('idx_scrobble_events_hour').on(t.hour),
  }),
);

/** Offline transmit queue. Same row shape as `scrobble_events` but a separate table so
 *  a completed row and its still-pending sibling can legitimately share an id. */
export const pendingScrobbleEvents = sqliteTable(
  'pending_scrobble_events',
  {
    id: text('id').primaryKey(),
    songJson: text('song_json').notNull(),
    time: integer('time').notNull(),
  },
  (t) => ({ timeIdx: index('idx_pending_scrobble_events_time').on(t.time) }),
);

/** Downloaded tracks. `raw_json` preserves the full Subsonic `Child` envelope. */
export const cachedSongs = sqliteTable(
  'cached_songs',
  {
    songId: text('song_id').primaryKey(),
    title: text('title').notNull(),
    artist: text('artist'),
    album: text('album'),
    albumId: text('album_id').notNull(),
    coverArt: text('cover_art'),
    bytes: integer('bytes').notNull(),
    duration: integer('duration').notNull(),
    suffix: text('suffix').notNull(),
    bitRate: integer('bit_rate'),
    bitDepth: integer('bit_depth'),
    samplingRate: integer('sampling_rate'),
    formatCapturedAt: integer('format_captured_at').notNull(),
    downloadedAt: integer('downloaded_at').notNull(),
    rawJson: text('raw_json'),
  },
  (t) => ({ albumIdx: index('idx_cached_songs_album_id').on(t.albumId) }),
);

/** A downloaded album / playlist / favorites set / single song. `derived` marks a row
 *  created to hold an edge rather than an explicit user download. */
export const cachedItems = sqliteTable('cached_items', {
  itemId: text('item_id').primaryKey(),
  type: text('type').notNull(),
  name: text('name').notNull(),
  artist: text('artist'),
  coverArtId: text('cover_art_id'),
  expectedSongCount: integer('expected_song_count').notNull(),
  parentAlbumId: text('parent_album_id'),
  lastSyncAt: integer('last_sync_at').notNull(),
  downloadedAt: integer('downloaded_at').notNull(),
  rawJson: text('raw_json'),
  derived: integer('derived').default(0),
});

/** Ordered membership of a cached item. The UNIQUE index enforces one edge per
 *  (item, song) — the PK alone allows the same song at two positions. */
export const cachedItemSongs = sqliteTable(
  'cached_item_songs',
  {
    itemId: text('item_id')
      .notNull()
      .references(() => cachedItems.itemId, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    songId: text('song_id')
      .notNull()
      .references(() => cachedSongs.songId),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.itemId, t.position] }),
    songIdx: index('idx_cached_item_songs_song_id').on(t.songId),
    itemSongIdx: uniqueIndex('idx_cached_item_songs_item_song').on(t.itemId, t.songId),
  }),
);

/** Persistent music download queue. */
export const downloadQueue = sqliteTable(
  'download_queue',
  {
    queueId: text('queue_id').primaryKey(),
    itemId: text('item_id').notNull(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    artist: text('artist'),
    coverArtId: text('cover_art_id'),
    status: text('status').notNull(),
    totalSongs: integer('total_songs').notNull(),
    completedSongs: integer('completed_songs').notNull(),
    error: text('error'),
    addedAt: integer('added_at').notNull(),
    queuePosition: integer('queue_position').notNull(),
    songsJson: text('songs_json').notNull(),
  },
  (t) => ({
    statusIdx: index('idx_download_queue_status').on(t.status),
    positionIdx: index('idx_download_queue_position').on(t.queuePosition),
  }),
);

/** Per-variant record of on-disk cover art. No FK — cover art ids come from the server
 *  and aren't owned by any local table. At most one row per (id, size). */
export const cachedImages = sqliteTable(
  'cached_images',
  {
    coverArtId: text('cover_art_id').notNull(),
    size: integer('size').notNull(),
    ext: text('ext').notNull(),
    bytes: integer('bytes').notNull(),
    cachedAt: integer('cached_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.coverArtId, t.size] }),
    cachedAtIdx: index('idx_cached_images_cached_at').on(t.cachedAt),
    coverArtIdx: index('idx_cached_images_cover_art_id').on(t.coverArtId),
  }),
);

/** Persistent queue for user-initiated cover-art refresh cycles. */
export const imageDownloadQueue = sqliteTable(
  'image_download_queue',
  {
    coverArtId: text('cover_art_id').primaryKey(),
    scope: text('scope').notNull(),
    status: text('status').notNull(),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    addedAt: integer('added_at').notNull(),
    cycleId: text('cycle_id').notNull(),
  },
  (t) => ({
    statusIdx: index('idx_image_download_queue_status').on(t.status, t.addedAt),
    cycleIdx: index('idx_image_download_queue_cycle').on(t.cycleId),
  }),
);
