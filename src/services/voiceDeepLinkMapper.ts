/**
 * Maps Android App Actions deep links into the RNQP `MediaSearchRequest` shape
 * so Google Assistant voice queries flow through the same headlessMediaService resolver
 * as `onPlayFromSearchRequest`.
 *
 * Flow: "Hey Google, play <artist> on Substreamer" → Assistant fires
 * `substreamer://play?artist=…` → Android routes it to the `play` Expo Router
 * route → this maps the query fields into a `MediaSearchRequest`.
 *
 * `shortcuts.xml` (see plugins/with-android-app-actions.js) declares the
 * schema.org → URL-key mappings: song.byArtist.name→artist, song.inAlbum.name→
 * album, song.name→song, playlist.name→playlist, song.genre→genre.
 */
import type { MediaSearchRequest, MediaSearchType } from 'react-native-queue-player';

export interface VoiceFields {
  artist?: string;
  album?: string;
  song?: string;
  playlist?: string;
  genre?: string;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function inferType(f: VoiceFields): MediaSearchType | undefined {
  if (f.song) return 'song';
  if (f.playlist) return 'playlist';
  if (f.album) return 'album';
  if (f.artist) return 'artist';
  if (f.genre) return 'genre';
  return undefined;
}

/** Build a MediaSearchRequest from parsed voice fields; null when all empty. */
export function buildMediaSearchRequest(fields: VoiceFields): MediaSearchRequest | null {
  const artist = nonEmpty(fields.artist);
  const album = nonEmpty(fields.album);
  const song = nonEmpty(fields.song);
  const playlist = nonEmpty(fields.playlist);
  const genre = nonEmpty(fields.genre);

  if (!artist && !album && !song && !playlist && !genre) return null;

  const type = inferType({ artist, album, song, playlist, genre });
  // Human-readable query for the resolver's substring fallback.
  const query = [song, album, artist, playlist, genre]
    .filter((v): v is string => v != null)
    .join(' ')
    .trim();

  return { query, type, artist, album, song, playlist, genre, origin: 'android-assistant' };
}

/** Parse a `substreamer://play?...` deep link into a MediaSearchRequest. */
export function parseVoiceDeepLink(url: string): MediaSearchRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'substreamer:' || parsed.host !== 'play') return null;

  const params = parsed.searchParams;
  return buildMediaSearchRequest({
    artist: params.get('artist') ?? undefined,
    album: params.get('album') ?? undefined,
    song: params.get('song') ?? undefined,
    playlist: params.get('playlist') ?? undefined,
    genre: params.get('genre') ?? undefined,
  });
}
