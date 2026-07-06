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

  it('composes query from multiple fields (song before artist)', () => {
    const r = parseVoiceDeepLink('substreamer://play?artist=Nirvana&song=Come%20As%20You%20Are');
    expect(r?.type).toBe('song');
    expect(r?.query).toBe('Come As You Are Nirvana');
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
