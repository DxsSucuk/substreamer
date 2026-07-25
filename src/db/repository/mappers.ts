/**
 * Map Subsonic API objects to normalized row records (snake_case column keys) +
 * child-table row arrays. Derives `sort_title` (getSortKey), `norm_*`/`dmeta_*`
 * search columns (searchMatch), flattens ReplayGain → `rg_*` and ItemDate →
 * `*_year/_month/_day`. Dates are accepted as live `Date` OR ISO string (the
 * migration reads them back from JSON blobs where Dates are serialized to strings).
 */
import type { AlbumID3, ArtistID3, ArtistInfo2, Child, Playlist } from 'subsonic-api';

import { metaphoneKey, normalize, normalizeArtist } from '@/services/searchMatch';
import { getSortKey } from '@/utils/sortHelpers';

import type { Row } from './core';

const toEpoch = (v: Date | string | number | null | undefined): number | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
const toBool = (v: boolean | null | undefined): number | null => (v == null ? null : v ? 1 : 0);
const str = (v: string | null | undefined): string | null => v ?? null;
const num = (v: number | null | undefined): number | null => (v == null ? null : v);

/** Subsonic `genres` is declared `string[]` in our types, but real Subsonic/
 *  OpenSubsonic servers return `{name}[]` (ItemGenre). Accept either shape. */
const genreName = (g: unknown): string =>
  typeof g === 'string' ? g : String((g as { name?: unknown } | null)?.name ?? '');

// ── Songs (Child) ────────────────────────────────────────────────────────────

export function songRow(c: Child): Row {
  return {
    id: c.id,
    album_id: str(c.albumId),
    artist_id: str(c.artistId),
    title: str(c.title),
    album: str(c.album),
    artist: str(c.artist),
    display_artist: str(c.displayArtist),
    display_album_artist: str(c.displayAlbumArtist),
    display_composer: str(c.displayComposer),
    track: num(c.track),
    disc_number: num(c.discNumber),
    year: num(c.year),
    genre: str(c.genre),
    cover_art: str(c.coverArt),
    duration: num(c.duration),
    size: num(c.size),
    content_type: str(c.contentType),
    suffix: str(c.suffix),
    transcoded_content_type: str(c.transcodedContentType),
    transcoded_suffix: str(c.transcodedSuffix),
    bit_rate: num(c.bitRate),
    bit_depth: num(c.bitDepth),
    sampling_rate: num(c.samplingRate),
    channel_count: num(c.channelCount),
    path: str(c.path),
    user_rating: num(c.userRating),
    average_rating: num(c.averageRating),
    play_count: num(c.playCount),
    created: toEpoch(c.created),
    starred: toEpoch(c.starred),
    played: str(c.played),
    type: str(c.type),
    bpm: num(c.bpm),
    comment: str(c.comment),
    sort_name: str(c.sortName),
    sort_title: getSortKey(c.title ?? '', c.sortName),
    music_brainz_id: str(c.musicBrainzId),
    explicit_status: str(c.explicitStatus),
    bookmark_position: num(c.bookmarkPosition),
    is_video: toBool(c.isVideo),
    rg_track_gain: num(c.replayGain?.trackGain),
    rg_album_gain: num(c.replayGain?.albumGain),
    rg_track_peak: num(c.replayGain?.trackPeak),
    rg_album_peak: num(c.replayGain?.albumPeak),
    rg_base_gain: num(c.replayGain?.baseGain),
    rg_fallback_gain: num(c.replayGain?.fallbackGain),
    norm_title: normalize(c.title),
    norm_artist: normalizeArtist(c.artist),
    dmeta_title: metaphoneKey(c.title),
    dmeta_artist: metaphoneKey(c.artist),
  };
}

export const songGenreRows = (c: Child, id: string): Row[] =>
  ((c.genres ?? []) as unknown[]).map((g, pos) => ({ song_id: id, pos, name: genreName(g) }));
export const songArtistRows = (c: Child, id: string): Row[] =>
  (c.artists ?? []).map((a, pos) => ({ song_id: id, pos, artist_id: str(a.id), artist_name: str(a.name) }));
export const songAlbumArtistRows = (c: Child, id: string): Row[] =>
  (c.albumArtists ?? []).map((a, pos) => ({ song_id: id, pos, artist_id: str(a.id), artist_name: str(a.name) }));
export const songContributorRows = (c: Child, id: string): Row[] =>
  (c.contributors ?? []).map((ct, pos) => ({
    song_id: id,
    pos,
    role: ct.role,
    sub_role: str(ct.subRole),
    artist_id: str(ct.artist?.id),
    artist_name: str(ct.artist?.name),
  }));
export const songMoodRows = (c: Child, id: string): Row[] =>
  (c.moods ?? []).map((mood, pos) => ({ song_id: id, pos, mood }));

// ── Albums (AlbumID3) ─────────────────────────────────────────────────────────

export function albumRow(a: AlbumID3): Row {
  const displayArtist = a.displayArtist ?? a.artist;
  return {
    id: a.id,
    artist_id: str(a.artistId),
    name: str(a.name),
    artist: str(a.artist),
    display_artist: str(displayArtist),
    cover_art: str(a.coverArt),
    song_count: num(a.songCount),
    duration: num(a.duration),
    play_count: num(a.playCount),
    created: toEpoch(a.created),
    starred: toEpoch(a.starred),
    year: num(a.year),
    genre: str(a.genre),
    played: str(a.played),
    user_rating: num(a.userRating),
    version: str(a.version),
    music_brainz_id: str(a.musicBrainzId),
    sort_name: str(a.sortName),
    sort_title: getSortKey(a.name ?? '', a.sortName),
    is_compilation: toBool(a.isCompilation),
    explicit_status: str(a.explicitStatus),
    original_release_year: num(a.originalReleaseDate?.year),
    original_release_month: num(a.originalReleaseDate?.month),
    original_release_day: num(a.originalReleaseDate?.day),
    release_year: num(a.releaseDate?.year),
    release_month: num(a.releaseDate?.month),
    release_day: num(a.releaseDate?.day),
    norm_name: normalize(a.name),
    norm_artist: normalizeArtist(displayArtist),
    dmeta_name: metaphoneKey(a.name),
    dmeta_artist: metaphoneKey(displayArtist),
  };
}

export const albumGenreRows = (a: AlbumID3, id: string): Row[] =>
  ((a.genres ?? []) as unknown[]).map((g, pos) => ({ album_id: id, pos, name: genreName(g) }));
export const albumArtistRows = (a: AlbumID3, id: string): Row[] =>
  (a.artists ?? []).map((ar, pos) => ({ album_id: id, pos, artist_id: str(ar.id), artist_name: str(ar.name) }));
export const albumReleaseTypeRows = (a: AlbumID3, id: string): Row[] =>
  (a.releaseTypes ?? []).map((name, pos) => ({ album_id: id, pos, name }));
export const albumMoodRows = (a: AlbumID3, id: string): Row[] =>
  (a.moods ?? []).map((mood, pos) => ({ album_id: id, pos, mood }));
export const albumRecordLabelRows = (a: AlbumID3, id: string): Row[] =>
  (a.recordLabels ?? []).map((rl, pos) => ({ album_id: id, pos, name: rl.name }));
export const albumDiscTitleRows = (a: AlbumID3, id: string): Row[] =>
  (a.discTitles ?? []).map((dt) => ({ album_id: id, disc: dt.disc, title: dt.title }));

// ── Artists (ArtistID3 + ArtistInfo2) ─────────────────────────────────────────

export function artistRow(a: ArtistID3): Row {
  return {
    id: a.id,
    name: str(a.name),
    sort_name: str(a.sortName),
    sort_title: getSortKey(a.name ?? '', a.sortName),
    cover_art: str(a.coverArt),
    artist_image_url: str(a.artistImageUrl),
    album_count: num(a.albumCount),
    starred: toEpoch(a.starred),
    user_rating: num(a.userRating),
    music_brainz_id: str(a.musicBrainzId),
    norm_name: normalize(a.name),
    dmeta_name: metaphoneKey(a.name),
  };
}
export const artistRoleRows = (a: ArtistID3, id: string): Row[] =>
  (a.roles ?? []).map((role, pos) => ({ artist_id: id, pos, role }));

/** Bio/image columns from getArtistInfo2 — a PARTIAL row (id + info fields only)
 *  so upserting it never clears the base ArtistID3 columns. */
export function artistInfoRow(id: string, info: ArtistInfo2): Row {
  return {
    id,
    biography: str(info.biography),
    last_fm_url: str(info.lastFmUrl),
    image_url_small: str(info.smallImageUrl),
    image_url_medium: str(info.mediumImageUrl),
    image_url_large: str(info.largeImageUrl),
  };
}
export const artistSimilarRows = (info: ArtistInfo2, id: string): Row[] =>
  (info.similarArtist ?? []).map((s, pos) => ({
    artist_id: id,
    pos,
    similar_artist_id: str(s.id),
    name: str(s.name),
  }));

// ── Playlists (Playlist) ──────────────────────────────────────────────────────

export function playlistRow(p: Playlist): Row {
  return {
    id: p.id,
    name: str(p.name),
    comment: str(p.comment),
    cover_art: str(p.coverArt),
    created: toEpoch(p.created),
    changed: toEpoch(p.changed),
    duration: num(p.duration),
    owner: str(p.owner),
    public: toBool(p.public),
    song_count: num(p.songCount),
    norm_name: normalize(p.name),
    dmeta_name: metaphoneKey(p.name),
  };
}
export const playlistAllowedUserRows = (p: Playlist, id: string): Row[] =>
  (p.allowedUser ?? []).map((username, pos) => ({ playlist_id: id, pos, username }));
