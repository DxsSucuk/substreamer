import { parseVoiceDeepLink, buildMediaSearchRequest } from '../voiceDeepLinkMapper';

describe('parseVoiceDeepLink', () => {
  it('maps an artist deep link → MediaSearchRequest (android-assistant)', () => {
    const r = parseVoiceDeepLink('substreamer://play?artist=Pearl%20Jam');
    expect(r).toEqual({
      query: 'Pearl Jam',
      type: 'artist',
      artist: 'Pearl Jam',
      album: undefined,
      song: undefined,
      playlist: undefined,
      genre: undefined,
      origin: 'android-assistant',
    });
  });

  it('query is the primary single term, NOT concatenated (structured fields kept)', () => {
    const r = parseVoiceDeepLink('substreamer://play?artist=Nirvana&song=Come%20As%20You%20Are');
    expect(r?.type).toBe('song');
    // The song term only — the artist stays in the structured `artist` field,
    // it is NOT joined into `query` (which could never substring-match).
    expect(r?.query).toBe('Come As You Are');
    expect(r?.song).toBe('Come As You Are');
    expect(r?.artist).toBe('Nirvana');
  });

  it('returns null for a non-play or wrong-scheme URL', () => {
    expect(parseVoiceDeepLink('substreamer://album/123')).toBeNull();
    expect(parseVoiceDeepLink('spotify://play?artist=X')).toBeNull();
    expect(parseVoiceDeepLink('not a url')).toBeNull();
  });

  it('returns null when no fields are present', () => {
    expect(parseVoiceDeepLink('substreamer://play')).toBeNull();
    expect(parseVoiceDeepLink('substreamer://play?artist=%20')).toBeNull();
  });
});

describe('buildMediaSearchRequest', () => {
  it('infers type by priority: song > playlist > album > artist > genre', () => {
    expect(buildMediaSearchRequest({ genre: 'Rock', artist: 'X' })?.type).toBe('artist');
    expect(buildMediaSearchRequest({ genre: 'Rock' })?.type).toBe('genre');
    expect(buildMediaSearchRequest({ playlist: 'Roadtrip', album: 'X' })?.type).toBe('playlist');
    expect(buildMediaSearchRequest({ album: 'X' })?.type).toBe('album');
  });

  it('trims + drops empty fields, returns null when all empty', () => {
    expect(buildMediaSearchRequest({ artist: '  ' })).toBeNull();
    expect(buildMediaSearchRequest({})).toBeNull();
    expect(buildMediaSearchRequest({ playlist: '  Chill  ' })?.playlist).toBe('Chill');
  });
});
