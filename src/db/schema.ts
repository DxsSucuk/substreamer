/**
 * Drizzle schema — the normalized data model, and the source of truth for the library.
 * One column per typed Subsonic field (scalars on the entity tables,
 * arrays/nested objects as child tables or flattened columns) — NO raw_json blob.
 * Details are relationships, not blobs (album detail = songs WHERE album_id=?, etc.).
 *
 * Conventions:
 *  - `snake_case` columns; TEXT server-id primary keys on normal rowid tables. WITHOUT
 *    ROWID is not used — it breaks op-SQLite rowid-keyed reactivity and Drizzle can't
 *    emit it. Bulk-sync inserts MUST be id-sorted batches.
 *  - Timestamps stored as epoch-ms INTEGER (repository converts Date↔epoch).
 *  - Booleans stored as 0/1 via `{ mode: 'boolean' }`.
 *  - ReplayGain flattened to `rg_*` REAL columns (1:1, no child table).
 *  - Search keeps the existing tiered `norm_*` (accent-folded) + `dmeta_*`
 *    (double-metaphone) columns — not FTS5.
 *  - Child tables cascade-delete with their parent entity.
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
    // favorites: only starred rows, keyed exactly to the Favourites tab's
    // `ORDER BY starred DESC, id DESC` so the keyset page is a backward index scan
    // with no temp b-tree. Distinct name from the superseded idx_songs_starred, which
    // still exists on upgraded installs and is harmless.
    starredKeyIdx: index('idx_songs_starred_key')
      .on(t.starred, t.id)
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
    normName: text('norm_name'),
    normArtist: text('norm_artist'),
    dmetaName: text('dmeta_name'),
    dmetaArtist: text('dmeta_artist'),
  },
  (t) => ({
    sortIdx: index('idx_albums_sort').on(t.sortTitle, t.id),
    artistSortIdx: index('idx_albums_artist_sort').on(t.sortArtist, t.sortTitle, t.id),
    artistIdx: index('idx_albums_artist').on(t.artistId),
    starredKeyIdx: index('idx_albums_starred_key')
      .on(t.starred, t.id)
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
    normName: text('norm_name'),
    dmetaName: text('dmeta_name'),
  },
  (t) => ({
    sortIdx: index('idx_artists_sort').on(t.sortTitle, t.id),
    starredKeyIdx: index('idx_artists_starred_key')
      .on(t.starred, t.id)
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
    // Written ONLY by the playlist detail reconcile, never by an upsert: the LIST
    // envelope's `changed`/`songCount` at the last successful detail fetch. They can't
    // live on `changed`/`song_count` because `fetchPlaylistDetail` rewrites those from the
    // DETAIL envelope, so a server whose two endpoints disagree would refetch forever.
    // NULL = never fetched.
    detailChanged: integer('detail_changed'),
    detailSongCount: integer('detail_song_count'),
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
// Favourites remainder — the starred items the library does NOT hold
//
// Favourites are marked on the library row (`songs`/`albums`/`artists`.`starred`).
// A row in those tables means "the library sync put it here", so the favourites
// reconcile never INSERTs one; a starred item with no library row goes here instead,
// holding the verbatim `getStarred2` envelope so it renders at full fidelity.
// Normally EMPTY — the library sync enumerates everything the server has.
// ─────────────────────────────────────────────────────────────────────────────

/** Starred songs with no `songs` row. PK is `id` (not `song_id`) so the shared
 *  `keysetPage` primitive — which hardcodes the id column — pages these verbatim. */
export const favoriteSongs = sqliteTable(
  'favorite_songs',
  {
    id: text('id').primaryKey(),
    /** Epoch ms the item was starred, or 0 when the server sent no date. NOT NULL —
     *  it is the sort key; 0 reads back as `undefined`, never a fabricated date. */
    starred: integer('starred').notNull(),
    /** Hot column so the Favourites action-bar total is a SQL aggregate rather than a
     *  JSON parse of every row. Written from the same payload object as `json`. */
    duration: integer('duration'),
    /** The verbatim `getStarred2` `Child` envelope. */
    json: text('json').notNull(),
  },
  (t) => ({ starredKeyIdx: index('idx_favorite_songs_starred_key').on(t.starred, t.id) }),
);

/** Starred albums with no `albums` row — verbatim `AlbumID3` envelope. */
export const favoriteAlbums = sqliteTable(
  'favorite_albums',
  {
    id: text('id').primaryKey(),
    starred: integer('starred').notNull(),
    json: text('json').notNull(),
  },
  (t) => ({ starredKeyIdx: index('idx_favorite_albums_starred_key').on(t.starred, t.id) }),
);

/** Starred artists with no `artists` row — verbatim `ArtistID3` envelope. */
export const favoriteArtists = sqliteTable(
  'favorite_artists',
  {
    id: text('id').primaryKey(),
    starred: integer('starred').notNull(),
    json: text('json').notNull(),
  },
  (t) => ({ starredKeyIdx: index('idx_favorite_artists_starred_key').on(t.starred, t.id) }),
);

/**
 * `getAlbumInfo2` payload plus the client-side Wikipedia enrichment — fetched ONLY when
 * the user opens the player's album-info panel, never by the library sync. Its own table
 * rather than columns on `albums` because it carries state the album row has no business
 * holding (the enrichment, the MBID override used to resolve it, and when it was
 * fetched), and because `albums` is rewritten on every sync page.
 */
export const albumInfo = sqliteTable('album_info', {
  albumId: text('album_id')
    .primaryKey()
    .references(() => albums.id, { onDelete: 'cascade' }),
  notes: text('notes'),
  lastFmUrl: text('last_fm_url'),
  musicBrainzId: text('music_brainz_id'),
  imageUrlSmall: text('image_url_small'),
  imageUrlMedium: text('image_url_medium'),
  imageUrlLarge: text('image_url_large'),
  /** Wikipedia description, when the server returned no notes. */
  enrichedNotes: text('enriched_notes'),
  /** Attribution URL for the enriched notes. */
  enrichedNotesUrl: text('enriched_notes_url'),
  /** The MBID override this entry was resolved with, if any. */
  overrideMbid: text('override_mbid'),
  retrievedAt: integer('retrieved_at').notNull(),
});

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

/**
 * getArtistInfo2, on demand and with its own lifecycle — `artists` is rewritten by every
 * artist-list sync page, this is not. Parent (conceptually) of `artist_similar`, which
 * keeps its FK to `artists` because repointing it would need a table rebuild that
 * `ensureNormalizedSchema` cannot do.
 *
 * `biography` is the SERVER bio verbatim; NULL means this server has none (empty and
 * markup-only stubs are normalised to NULL on write, so a non-null value always renders).
 * The RESOLVED bio — which may have come from MusicBrainz instead — lives in `artist_bio`.
 */
export const artistInfo = sqliteTable('artist_info', {
  artistId: text('artist_id')
    .primaryKey()
    .references(() => artists.id, { onDelete: 'cascade' }),
  biography: text('biography'),
  lastFmUrl: text('last_fm_url'),
  musicBrainzId: text('music_brainz_id'),
  imageUrlSmall: text('image_url_small'),
  imageUrlMedium: text('image_url_medium'),
  imageUrlLarge: text('image_url_large'),
  retrievedAt: integer('retrieved_at').notNull(),
});

/**
 * The RESOLVED artist biography (server, else MusicBrainz) plus its negative cache.
 * A present row means "we have attempted this artist" — the presence predicate the MBID
 * override screens need. `biography` NULL = we looked and found none; `checkedAt` is
 * nullable so that marker can exist without claiming a negative-cache timestamp.
 */
export const artistBio = sqliteTable('artist_bio', {
  artistId: text('artist_id')
    .primaryKey()
    .references(() => artists.id, { onDelete: 'cascade' }),
  biography: text('biography'),
  resolvedMbid: text('resolved_mbid'),
  checkedAt: integer('checked_at'),
});

/**
 * Presence + freshness for `artist_top_songs`, which is a bare junction and cannot carry
 * either. `listLength` is the size REQUESTED (so an artist with fewer tracks than the
 * setting is not a permanent miss); `songCount` is the number of rows written, compared
 * against the count the read actually resolves — `artist_top_songs.song_id` has no FK, so
 * a song reaped by `deleteAlbumSongsNotIn` silently drops out of the join.
 */
export const artistTopSongsState = sqliteTable('artist_top_songs_state', {
  artistId: text('artist_id')
    .primaryKey()
    .references(() => artists.id, { onDelete: 'cascade' }),
  retrievedAt: integer('retrieved_at').notNull(),
  listLength: integer('list_length').notNull(),
  songCount: integer('song_count').notNull(),
});

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

/**
 * The four home-screen album lists, as ordered album ids. The albums themselves live in
 * `albums`, upserted by the same refresh with the MERGE policy — the list endpoints
 * return a partial view — so a list row and the library can never disagree.
 *
 * `album_id` cascades: an album deleted from the library should not linger in a home
 * list. Bounded by `listLength`, so each list is tens of rows.
 */
export const albumListEntries = sqliteTable(
  'album_list_entries',
  {
    /** `recentlyAdded` | `recentlyPlayed` | `frequentlyPlayed` | `randomSelection`. */
    listType: text('list_type').notNull(),
    pos: integer('pos').notNull(),
    albumId: text('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.listType, t.pos] }) }),
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
// The KV blob store (auth, settings, theme), scrobble history, the download tables and
// the image cache. They live here so `ensureNormalizedSchema` owns every
// CREATE/ALTER/INDEX in one ordered pass (tables → add missing columns → indexes); an
// unordered block can create an index before the column it references and take DB init
// down.
//
// They are classified as KEPT_TABLES in `createNormalizedTables.ts` so a resync,
// logout or dev spike can never drop them.
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

/**
 * Downloaded tracks — the full Subsonic `Child` in typed columns, alongside the
 * facts about the file on disk.
 *
 * THE FIRST SIX COLUMNS DESCRIBE THE FILE, NOT THE SERVER'S TRACK, and five of them
 * collide by name with `Child` fields — hence the `src_*` pairs below:
 *   - `album_id` is the file's DIRECTORY (`_unknown` when the server gave none)
 *   - `suffix` is the file's EXTENSION, post-transcode
 *   - `bit_rate`/`bit_depth`/`sampling_rate` are the EFFECTIVE downloaded format
 * `resolveSongFile` builds `{cache}/{album_id}/{song_id}.{suffix}`, and the reconcile
 * passes delete any file whose row disagrees — so a server value must never land here.
 *
 * `raw_json` is the legacy envelope, retained for rows the one-time promotion has not
 * converted yet and for rollback safety. `meta_v` is that promotion's marker: NULL means
 * "columns not populated yet, read the envelope". Only the promotion ever sets it.
 */
export const cachedSongs = sqliteTable(
  'cached_songs',
  {
    songId: text('song_id').primaryKey(),
    // --- the file on disk ---
    albumId: text('album_id').notNull(),
    suffix: text('suffix').notNull(),
    bitRate: integer('bit_rate'),
    bitDepth: integer('bit_depth'),
    samplingRate: integer('sampling_rate'),
    bytes: integer('bytes').notNull(),
    formatCapturedAt: integer('format_captured_at').notNull(),
    downloadedAt: integer('downloaded_at').notNull(),
    // --- the server's track (Child) ---
    title: text('title').notNull(),
    artist: text('artist'),
    album: text('album'),
    coverArt: text('cover_art'),
    duration: integer('duration').notNull(),
    srcAlbumId: text('src_album_id'),
    srcSuffix: text('src_suffix'),
    srcBitRate: integer('src_bit_rate'),
    srcBitDepth: integer('src_bit_depth'),
    srcSamplingRate: integer('src_sampling_rate'),
    artistId: text('artist_id'),
    displayArtist: text('display_artist'),
    displayAlbumArtist: text('display_album_artist'),
    displayComposer: text('display_composer'),
    track: integer('track'),
    discNumber: integer('disc_number'),
    year: integer('year'),
    genre: text('genre'),
    size: integer('size'),
    contentType: text('content_type'),
    transcodedContentType: text('transcoded_content_type'),
    transcodedSuffix: text('transcoded_suffix'),
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
    musicBrainzId: text('music_brainz_id'),
    explicitStatus: text('explicit_status'),
    bookmarkPosition: integer('bookmark_position'),
    isVideo: integer('is_video', { mode: 'boolean' }),
    isDir: integer('is_dir', { mode: 'boolean' }),
    parent: text('parent'),
    originalWidth: integer('original_width'),
    originalHeight: integer('original_height'),
    rgTrackGain: real('rg_track_gain'),
    rgAlbumGain: real('rg_album_gain'),
    rgTrackPeak: real('rg_track_peak'),
    rgAlbumPeak: real('rg_album_peak'),
    rgBaseGain: real('rg_base_gain'),
    rgFallbackGain: real('rg_fallback_gain'),
    // --- legacy envelope + promotion marker ---
    rawJson: text('raw_json'),
    metaV: integer('meta_v'),
  },
  (t) => ({ albumIdx: index('idx_cached_songs_album_id').on(t.albumId) }),
);

// Child's multi-valued fields, mirroring the library's song child tables. Written
// ONLY from a real `Child` — never rebuilt from an in-memory row, which carries the
// genres projection alone.

export const cachedSongGenres = sqliteTable(
  'cached_song_genres',
  {
    songId: text('song_id')
      .notNull()
      .references(() => cachedSongs.songId, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(),
    name: text('name').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.songId, t.pos] }) }),
);

export const cachedSongArtists = sqliteTable(
  'cached_song_artists',
  {
    songId: text('song_id')
      .notNull()
      .references(() => cachedSongs.songId, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(),
    artistId: text('artist_id'),
    artistName: text('artist_name'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.songId, t.pos] }) }),
);

export const cachedSongAlbumArtists = sqliteTable(
  'cached_song_album_artists',
  {
    songId: text('song_id')
      .notNull()
      .references(() => cachedSongs.songId, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(),
    artistId: text('artist_id'),
    artistName: text('artist_name'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.songId, t.pos] }) }),
);

export const cachedSongContributors = sqliteTable(
  'cached_song_contributors',
  {
    songId: text('song_id')
      .notNull()
      .references(() => cachedSongs.songId, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(),
    role: text('role').notNull(),
    subRole: text('sub_role'),
    artistId: text('artist_id'),
    artistName: text('artist_name'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.songId, t.pos] }) }),
);

export const cachedSongMoods = sqliteTable(
  'cached_song_moods',
  {
    songId: text('song_id')
      .notNull()
      .references(() => cachedSongs.songId, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(),
    mood: text('mood').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.songId, t.pos] }) }),
);

/** A downloaded album / playlist / favorites set / single song. `derived` marks a row
 *  created to hold an edge rather than an explicit user download. */
export const cachedItems = sqliteTable('cached_items', {
  itemId: text('item_id').primaryKey(),
  type: text('type').notNull(),
  name: text('name').notNull(),
  artist: text('artist'),
  // Captured at download time per the user's then-current per-track-vs-album cover-art
  // setting, so it matches the file actually in the image cache. NOT reconstructible
  // from `albums.cover_art` — the image-cache purge protection depends on it.
  coverArtId: text('cover_art_id'),
  expectedSongCount: integer('expected_song_count').notNull(),
  parentAlbumId: text('parent_album_id'),
  lastSyncAt: integer('last_sync_at').notNull(),
  downloadedAt: integer('downloaded_at').notNull(),
  rawJson: text('raw_json'),
  /** Promotion marker — NULL means the component row isn't populated yet, read `raw_json`. */
  metaV: integer('meta_v'),
  derived: integer('derived').default(0),
});

/**
 * Per-type metadata for a downloaded item, 1:1 with `cached_items`. Component tables
 * rather than a wide union: `favorites` and `song` items have no metadata at all, so a
 * union would leave 40-odd permanently-NULL columns and force everything nullable.
 * Mirrors the `artists` + `artist_info` pattern.
 */
export const cachedAlbums = sqliteTable('cached_albums', {
  itemId: text('item_id')
    .primaryKey()
    .references(() => cachedItems.itemId, { onDelete: 'cascade' }),
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
  isCompilation: integer('is_compilation', { mode: 'boolean' }),
  explicitStatus: text('explicit_status'),
  originalReleaseYear: integer('original_release_year'),
  originalReleaseMonth: integer('original_release_month'),
  originalReleaseDay: integer('original_release_day'),
  releaseYear: integer('release_year'),
  releaseMonth: integer('release_month'),
  releaseDay: integer('release_day'),
});

export const cachedPlaylists = sqliteTable('cached_playlists', {
  itemId: text('item_id')
    .primaryKey()
    .references(() => cachedItems.itemId, { onDelete: 'cascade' }),
  name: text('name'),
  comment: text('comment'),
  coverArt: text('cover_art'),
  created: integer('created'),
  changed: integer('changed'),
  duration: integer('duration'),
  owner: text('owner'),
  public: integer('public', { mode: 'boolean' }),
  songCount: integer('song_count'),
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
    // One item per slot, enforced. A NEW index name, not a redefinition of
    // `idx_download_queue_position`: `CREATE UNIQUE INDEX IF NOT EXISTS` under the
    // old name is a no-op against the existing non-unique index, so upgrading
    // installs would silently never get the constraint. The old one is dropped at
    // boot (persistence/db.ts).
    positionIdx: uniqueIndex('idx_download_queue_position_unique').on(t.queuePosition),
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
