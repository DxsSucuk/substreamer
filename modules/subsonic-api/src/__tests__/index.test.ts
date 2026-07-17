import SubsonicAPI from '../index';
import { md5 } from '../md5';

// Minimal valid configs for reuse
const PASSWORD_CONFIG = {
  url: 'https://demo.navidrome.org',
  auth: { username: 'testuser', password: 'testpass' },
  salt: 'fixedsalt',
  reuseSalt: true,
} as const;

const API_KEY_CONFIG = {
  url: 'https://demo.navidrome.org',
  auth: { apiKey: 'my-api-key-123' },
  salt: 'fixedsalt',
} as const;

// Helper to capture the URL/options passed to fetch
function createMockFetch(responseBody: Record<string, unknown> = {}, ok = true) {
  const calls: { url: string; options?: RequestInit }[] = [];
  const mockFetch = jest.fn(async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    return {
      ok,
      status: ok ? 200 : 500,
      statusText: ok ? 'OK' : 'Internal Server Error',
      json: async () => ({ 'subsonic-response': responseBody }),
    } as unknown as Response;
  }) as unknown as typeof fetch & { mock: jest.Mock['mock'] };
  return { mockFetch, calls };
}

function parseUrl(urlStr: string) {
  return new URL(urlStr);
}

// Typed no-op fetch for constructor tests where the fetch is never called
const noopFetch = jest.fn() as unknown as typeof fetch;

// ==================
// Constructor
// ==================

describe('SubsonicAPI constructor', () => {
  it('creates instance with password auth', () => {
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: jest.fn() });
    expect(api).toBeInstanceOf(SubsonicAPI);
  });

  it('creates instance with API key auth', () => {
    const api = new SubsonicAPI({ ...API_KEY_CONFIG, fetch: jest.fn() });
    expect(api).toBeInstanceOf(SubsonicAPI);
  });

  it('throws if no config provided', () => {
    expect(() => new SubsonicAPI(undefined as any)).toThrow('no config provided');
  });

  it('throws if no url provided', () => {
    expect(() => new SubsonicAPI({ auth: { username: 'u', password: 'p' } } as any)).toThrow('no url provided');
  });

  it('throws if no auth provided', () => {
    expect(() => new SubsonicAPI({ url: 'https://example.com' } as any)).toThrow('no auth provided');
  });

  it('throws if password auth missing username', () => {
    expect(() => new SubsonicAPI({
      url: 'https://example.com',
      auth: { username: '', password: 'pass' },
      fetch: noopFetch,
    })).toThrow('no username provided');
  });

  it('throws if password auth missing password', () => {
    expect(() => new SubsonicAPI({
      url: 'https://example.com',
      auth: { username: 'user', password: '' },
      fetch: noopFetch,
    })).toThrow('no password provided');
  });

  it('throws if no crypto and no salt provided', () => {
    const originalCrypto = globalThis.crypto;
    // Temporarily remove crypto
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      expect(() => new SubsonicAPI({
        url: 'https://example.com',
        auth: { username: 'user', password: 'pass' },
        fetch: noopFetch,
      })).toThrow('no crypto implementation available');
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true });
    }
  });

  it('accepts a custom crypto implementation', () => {
    const customCrypto = { getRandomValues: jest.fn() } as unknown as Crypto;
    const api = new SubsonicAPI({
      ...PASSWORD_CONFIG,
      crypto: customCrypto,
      fetch: noopFetch,
    });
    expect(api).toBeInstanceOf(SubsonicAPI);
  });
});

// ====================
// baseURL()
// ====================

describe('baseURL', () => {
  it('returns URL with trailing slash', () => {
    const { mockFetch } = createMockFetch();
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, url: 'https://demo.navidrome.org', fetch: mockFetch });
    expect(api.baseURL()).toBe('https://demo.navidrome.org/');
  });

  it('preserves existing trailing slash', () => {
    const { mockFetch } = createMockFetch();
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, url: 'https://demo.navidrome.org/', fetch: mockFetch });
    expect(api.baseURL()).toBe('https://demo.navidrome.org/');
  });

  it('prepends https:// if no protocol', () => {
    const { mockFetch } = createMockFetch();
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, url: 'demo.navidrome.org', fetch: mockFetch });
    expect(api.baseURL()).toBe('https://demo.navidrome.org/');
  });

  it('preserves http:// protocol', () => {
    const { mockFetch } = createMockFetch();
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, url: 'http://192.168.1.10:4533', fetch: mockFetch });
    expect(api.baseURL()).toBe('http://192.168.1.10:4533/');
  });
});

// ==========================
// Request building & params
// ==========================

describe('request building', () => {
  it('uses default clientName and clientVersion', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', version: '1.16.1' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.ping();

    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('c')).toBe('substreamer8');
    expect(url.searchParams.get('v')).toBe('1.15.0');
    expect(url.searchParams.get('f')).toBe('json');
  });

  it('uses custom clientName and clientVersion', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({
      ...PASSWORD_CONFIG,
      clientName: 'my-app',
      clientVersion: '1.16.1',
      fetch: mockFetch,
    });

    await api.ping();

    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('c')).toBe('my-app');
    expect(url.searchParams.get('v')).toBe('1.16.1');
  });

  it('builds correct REST endpoint path', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.ping();

    const url = parseUrl(calls[0].url);
    expect(url.pathname).toBe('/rest/ping.view');
  });

  it('includes password auth params (u, t, s)', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.ping();

    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('u')).toBe('testuser');
    expect(url.searchParams.get('t')).toBe(md5('testpass' + 'fixedsalt'));
    expect(url.searchParams.get('s')).toBe('fixedsalt');
    expect(url.searchParams.has('apiKey')).toBe(false);
  });

  it('includes API key auth param', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...API_KEY_CONFIG, fetch: mockFetch });

    await api.ping();

    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('apiKey')).toBe('my-api-key-123');
    expect(url.searchParams.has('u')).toBe(false);
    expect(url.searchParams.has('t')).toBe(false);
    expect(url.searchParams.has('s')).toBe(false);
  });

  it('uses GET method by default', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.ping();

    expect(calls[0].options?.method).toBe('GET');
  });

  it('uses POST method when post: true', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, post: true, fetch: mockFetch });

    await api.ping();

    expect(calls[0].options?.method).toBe('POST');
    expect((calls[0].options?.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    // Body should contain the search params (not the path)
    expect(calls[0].options?.body).toContain('v=1.15.0');
    expect(calls[0].options?.body).toContain('c=substreamer8');
  });

  it('passes scalar params as URL search params', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', album: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getAlbum({ id: 'album-123' });

    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('id')).toBe('album-123');
  });

  it('skips null and undefined params', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', indexes: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getIndexes({ musicFolderId: undefined, ifModifiedSince: undefined });

    const url = parseUrl(calls[0].url);
    expect(url.searchParams.has('musicFolderId')).toBe(false);
    expect(url.searchParams.has('ifModifiedSince')).toBe(false);
  });

  it('handles array params as repeated keys', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', shares: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.createShare({ id: ['id1', 'id2', 'id3'] });

    const url = parseUrl(calls[0].url);
    const allIds = url.searchParams.getAll('id');
    expect(allIds).toEqual(['id1', 'id2', 'id3']);
  });

  it('handles single string id in createShare', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', shares: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.createShare({ id: 'single-id' });

    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('id')).toBe('single-id');
  });

  it('reuses salt when reuseSalt is true', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({
      url: 'https://demo.navidrome.org',
      auth: { username: 'user', password: 'pass' },
      reuseSalt: true,
      fetch: mockFetch,
    });

    await api.ping();
    await api.ping();

    const salt1 = parseUrl(calls[0].url).searchParams.get('s');
    const salt2 = parseUrl(calls[1].url).searchParams.get('s');
    expect(salt1).toBe(salt2);
  });

  it('generates different salts by default', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({
      url: 'https://demo.navidrome.org',
      auth: { username: 'user', password: 'pass' },
      fetch: mockFetch,
    });

    await api.ping();
    await api.ping();

    const salt1 = parseUrl(calls[0].url).searchParams.get('s');
    const salt2 = parseUrl(calls[1].url).searchParams.get('s');
    // With random salt generation, salts should differ (extremely unlikely to collide)
    expect(salt1).not.toBe(salt2);
  });

  it('uses provided static salt when reuseSalt is true', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({
      url: 'https://demo.navidrome.org',
      auth: { username: 'testuser', password: 'testpass' },
      salt: 'my-static-salt',
      reuseSalt: true,
      fetch: mockFetch,
    });

    await api.ping();

    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('s')).toBe('my-static-salt');
    expect(url.searchParams.get('t')).toBe(md5('testpass' + 'my-static-salt'));
  });

  it('handles URL with path (e.g. reverse proxy)', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({
      ...PASSWORD_CONFIG,
      url: 'https://example.com/subsonic',
      fetch: mockFetch,
    });

    await api.ping();

    const url = parseUrl(calls[0].url);
    expect(url.pathname).toBe('/subsonic/rest/ping.view');
  });

  it('handles a .rest TLD hostname (does not mistake it for the /rest path)', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({
      ...PASSWORD_CONFIG,
      url: 'https://my.domain.rest',
      fetch: mockFetch,
    });

    await api.ping();

    const url = parseUrl(calls[0].url);
    expect(url.pathname).toBe('/rest/ping.view');
  });

  it('does not double the /rest path when the url already ends in /rest', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({
      ...PASSWORD_CONFIG,
      url: 'https://my.domain.rest/rest',
      fetch: mockFetch,
    });

    await api.ping();

    const url = parseUrl(calls[0].url);
    expect(url.pathname).toBe('/rest/ping.view');
  });
});

// =============================
// System API
// =============================

describe('system API', () => {
  it('ping returns subsonic-response', async () => {
    const responseData = { status: 'ok', version: '1.16.1' };
    const { mockFetch } = createMockFetch(responseData);
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    const result = await api.ping();
    expect(result).toEqual(responseData);
  });

  it('getLicense calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', license: { valid: true } });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getLicense();

    expect(calls[0].url).toContain('/rest/getLicense.view');
  });
});

// =============================
// Browsing API
// =============================

describe('browsing API', () => {
  it('getMusicFolders calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', musicFolders: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getMusicFolders();
    expect(calls[0].url).toContain('/rest/getMusicFolders.view');
  });

  it('getIndexes passes optional musicFolderId', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', indexes: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getIndexes({ musicFolderId: '42' });
    expect(parseUrl(calls[0].url).searchParams.get('musicFolderId')).toBe('42');
  });

  it('getIndexes works with no args', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', indexes: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getIndexes();
    expect(calls[0].url).toContain('/rest/getIndexes.view');
  });

  it('getMusicDirectory passes id', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', directory: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getMusicDirectory({ id: 'dir-1' });
    expect(parseUrl(calls[0].url).searchParams.get('id')).toBe('dir-1');
  });

  it('getGenres calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', genres: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getGenres();
    expect(calls[0].url).toContain('/rest/getGenres.view');
  });

  it('getArtists passes optional musicFolderId', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', artists: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getArtists({ musicFolderId: 5 });
    expect(parseUrl(calls[0].url).searchParams.get('musicFolderId')).toBe('5');
  });

  it('getArtist passes id', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', artist: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getArtist({ id: 'ar-123' });
    expect(parseUrl(calls[0].url).searchParams.get('id')).toBe('ar-123');
  });

  it('getAlbum passes id', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', album: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getAlbum({ id: 'al-456' });
    expect(parseUrl(calls[0].url).searchParams.get('id')).toBe('al-456');
  });

  it('getSong passes id', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', song: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getSong({ id: 'song-789' });
    expect(parseUrl(calls[0].url).searchParams.get('id')).toBe('song-789');
  });

  it('getArtistInfo2 passes all params', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', artistInfo2: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getArtistInfo2({ id: 'ar-1', count: 10, includeNotPresent: true });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('id')).toBe('ar-1');
    expect(url.searchParams.get('count')).toBe('10');
    expect(url.searchParams.get('includeNotPresent')).toBe('true');
  });

  it('getAlbumInfo calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', albumInfo: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getAlbumInfo({ id: 'al-1' });
    expect(calls[0].url).toContain('/rest/getAlbumInfo.view');
  });

  it('getAlbumInfo2 calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', albumInfo: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getAlbumInfo2({ id: 'al-2' });
    expect(calls[0].url).toContain('/rest/getAlbumInfo2.view');
  });

  it('getSimilarSongs passes id and count', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', similarSongs: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getSimilarSongs({ id: 's-1', count: 5 });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('count')).toBe('5');
  });

  it('getSimilarSongs2 calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', similarSongs2: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getSimilarSongs2({ id: 's-2' });
    expect(calls[0].url).toContain('/rest/getSimilarSongs2.view');
  });

  it('getTopSongs passes artist param', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', topSongs: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getTopSongs({ artist: 'Pink Floyd', count: 20 });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('artist')).toBe('Pink Floyd');
    expect(url.searchParams.get('count')).toBe('20');
  });

  it('getTopSongs works without artist', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', topSongs: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getTopSongs({});
    expect(calls[0].url).toContain('/rest/getTopSongs.view');
  });

  it('getVideos calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', videos: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getVideos();
    expect(calls[0].url).toContain('/rest/getVideos.view');
  });

  it('getVideoInfo calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', videoInfo: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getVideoInfo({ id: 'v-1' });
    expect(parseUrl(calls[0].url).searchParams.get('id')).toBe('v-1');
  });

  it('getArtistInfo calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', artistInfo: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getArtistInfo({ id: 'ar-1' });
    expect(calls[0].url).toContain('/rest/getArtistInfo.view');
  });
});

// =============================
// Album lists & search
// =============================

describe('album lists and search', () => {
  it('getAlbumList passes type and size', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', albumList: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getAlbumList({ type: 'newest', size: 20 });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('type')).toBe('newest');
    expect(url.searchParams.get('size')).toBe('20');
  });

  it('getAlbumList2 passes type and offset', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', albumList2: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getAlbumList2({ type: 'alphabeticalByName', offset: 50 });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('type')).toBe('alphabeticalByName');
    expect(url.searchParams.get('offset')).toBe('50');
  });

  it('getRandomSongs passes optional genre and size', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', randomSongs: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getRandomSongs({ size: 10, genre: 'Rock' });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('size')).toBe('10');
    expect(url.searchParams.get('genre')).toBe('Rock');
  });

  it('getRandomSongs works with no args', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', randomSongs: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getRandomSongs();
    expect(calls[0].url).toContain('/rest/getRandomSongs.view');
  });

  it('getSongsByGenre passes genre param', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', songsByGenre: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getSongsByGenre({ genre: 'Jazz', count: 50 });
    expect(parseUrl(calls[0].url).searchParams.get('genre')).toBe('Jazz');
  });

  it('getNowPlaying calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', nowPlaying: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getNowPlaying();
    expect(calls[0].url).toContain('/rest/getNowPlaying.view');
  });

  it('getStarred works with no args', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', starred: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getStarred();
    expect(calls[0].url).toContain('/rest/getStarred.view');
  });

  it('getStarred2 passes musicFolderId', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', starred2: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getStarred2({ musicFolderId: 3 });
    expect(parseUrl(calls[0].url).searchParams.get('musicFolderId')).toBe('3');
  });

  it('search2 passes query params', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', searchResult2: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.search2({ query: 'beatles', artistCount: 5, albumCount: 10, songCount: 20 });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('query')).toBe('beatles');
    expect(url.searchParams.get('artistCount')).toBe('5');
  });

  it('search3 calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', searchResult3: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.search3({ query: 'test' });
    expect(calls[0].url).toContain('/rest/search3.view');
  });

  it('deprecated search calls search2 endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', searchResult2: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.search({ newerThan: 1000 });
    expect(calls[0].url).toContain('/rest/search2.view');
  });
});

// =============================
// Playlist API
// =============================

describe('playlist API', () => {
  it('getPlaylists calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', playlists: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getPlaylists();
    expect(calls[0].url).toContain('/rest/getPlaylists.view');
  });

  it('getPlaylists passes username', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', playlists: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getPlaylists({ username: 'admin' });
    expect(parseUrl(calls[0].url).searchParams.get('username')).toBe('admin');
  });

  it('getPlaylist passes id', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', playlist: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getPlaylist({ id: 'pl-1' });
    expect(parseUrl(calls[0].url).searchParams.get('id')).toBe('pl-1');
  });

  it('createPlaylist passes name and songIds as array', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', playlist: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.createPlaylist({ name: 'My List', songId: ['s1', 's2'] });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('name')).toBe('My List');
    expect(url.searchParams.getAll('songId')).toEqual(['s1', 's2']);
  });

  it('updatePlaylist passes songIdToAdd and songIndexToRemove arrays', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', playlist: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.updatePlaylist({ playlistId: 'pl-1', songIdToAdd: ['s3'], songIndexToRemove: [0, 1] });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.getAll('songIdToAdd')).toEqual(['s3']);
    expect(url.searchParams.getAll('songIndexToRemove')).toEqual(['0', '1']);
  });

  it('deletePlaylist passes id', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.deletePlaylist({ id: 'pl-1' });
    expect(parseUrl(calls[0].url).searchParams.get('id')).toBe('pl-1');
  });
});

// =============================
// Media retrieval (raw response)
// =============================

describe('media retrieval', () => {
  it('stream returns raw fetch response', async () => {
    const mockResponse = { ok: true, status: 200 } as Response;
    const mockFetch = jest.fn(async () => mockResponse) as unknown as typeof fetch;
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    const result = await api.stream({ id: 'track-1', maxBitRate: 320 });
    expect(result).toBe(mockResponse);
  });

  it('stream passes format and estimateContentLength', async () => {
    const { mockFetch, calls } = createMockFetch();
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.stream({ id: 'track-1', format: 'mp3', estimateContentLength: true });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('format')).toBe('mp3');
    expect(url.searchParams.get('estimateContentLength')).toBe('true');
  });

  it('download passes id', async () => {
    const { mockFetch, calls } = createMockFetch();
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.download({ id: 'track-1' });
    expect(parseUrl(calls[0].url).searchParams.get('id')).toBe('track-1');
  });

  it('getCoverArt passes id and size', async () => {
    const { mockFetch, calls } = createMockFetch();
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getCoverArt({ id: 'cover-1', size: 300 });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('id')).toBe('cover-1');
    expect(url.searchParams.get('size')).toBe('300');
  });

  it('hls does not append .view suffix for .m3u8 method', async () => {
    const { mockFetch, calls } = createMockFetch();
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.hls({ id: 'track-1' });
    // .m3u8 methods skip the ${method}.view append — path ends at /rest/
    expect(calls[0].url).not.toContain('.view');
    expect(parseUrl(calls[0].url).searchParams.get('id')).toBe('track-1');
  });

  it('getCaptions passes format', async () => {
    const { mockFetch, calls } = createMockFetch();
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getCaptions({ id: 'v-1', format: 'vtt' });
    expect(parseUrl(calls[0].url).searchParams.get('format')).toBe('vtt');
  });

  it('getLyrics passes artist and title', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', lyrics: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getLyrics({ artist: 'Queen', title: 'Bohemian Rhapsody' });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('artist')).toBe('Queen');
    expect(url.searchParams.get('title')).toBe('Bohemian Rhapsody');
  });

  it('getAvatar passes username', async () => {
    const { mockFetch, calls } = createMockFetch();
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getAvatar({ username: 'admin' });
    expect(parseUrl(calls[0].url).searchParams.get('username')).toBe('admin');
  });
});

// =============================
// Annotation API
// =============================

describe('annotation API', () => {
  it('star passes id', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.star({ id: 'song-1' });
    expect(parseUrl(calls[0].url).searchParams.get('id')).toBe('song-1');
  });

  it('star passes albumId', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.star({ albumId: 'al-1' });
    expect(parseUrl(calls[0].url).searchParams.get('albumId')).toBe('al-1');
  });

  it('unstar passes artistId', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.unstar({ artistId: 'ar-1' });
    expect(parseUrl(calls[0].url).searchParams.get('artistId')).toBe('ar-1');
  });

  it('setRating passes id and rating', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.setRating({ id: 'song-1', rating: 5 });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('id')).toBe('song-1');
    expect(url.searchParams.get('rating')).toBe('5');
  });

  it('scrobble passes submission and time', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.scrobble({ id: 'song-1', submission: true, time: 1700000000 });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('submission')).toBe('true');
    expect(url.searchParams.get('time')).toBe('1700000000');
  });
});

// =============================
// Share API
// =============================

describe('share API', () => {
  it('getShares calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', shares: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getShares();
    expect(calls[0].url).toContain('/rest/getShares.view');
  });

  it('createShare with array emits repeated id params', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', shares: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.createShare({ id: ['a', 'b'], description: 'test', expires: 9999 });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.getAll('id')).toEqual(['a', 'b']);
    expect(url.searchParams.get('description')).toBe('test');
    expect(url.searchParams.get('expires')).toBe('9999');
  });

  it('updateShare passes id and description', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.updateShare({ id: 'share-1', description: 'updated' });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('id')).toBe('share-1');
    expect(url.searchParams.get('description')).toBe('updated');
  });

  it('deleteShare passes id', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.deleteShare({ id: 'share-1' });
    expect(parseUrl(calls[0].url).searchParams.get('id')).toBe('share-1');
  });
});

// =============================
// Podcast API
// =============================

describe('podcast API', () => {
  it('getPodcasts passes optional params', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', podcasts: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getPodcasts({ id: 'pod-1', includeEpisodes: false });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('id')).toBe('pod-1');
    expect(url.searchParams.get('includeEpisodes')).toBe('false');
  });

  it('getNewestPodcasts works with no args', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', newestPodcasts: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getNewestPodcasts();
    expect(calls[0].url).toContain('/rest/getNewestPodcasts.view');
  });

  it('refreshPodcasts calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.refreshPodcasts();
    expect(calls[0].url).toContain('/rest/refreshPodcasts.view');
  });

  it('createPodcastChannel passes url', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.createPodcastChannel({ url: 'https://feed.example.com/rss' });
    expect(parseUrl(calls[0].url).searchParams.get('url')).toBe('https://feed.example.com/rss');
  });

  it('deletePodcastChannel passes id', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.deletePodcastChannel({ id: 'ch-1' });
    expect(parseUrl(calls[0].url).searchParams.get('id')).toBe('ch-1');
  });

  it('deletePodcastEpisode passes id', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.deletePodcastEpisode({ id: 'ep-1' });
    expect(parseUrl(calls[0].url).searchParams.get('id')).toBe('ep-1');
  });

  it('downloadPodcastEpisode returns raw response', async () => {
    const mockResponse = { ok: true } as Response;
    const mockFetch = jest.fn(async () => mockResponse) as unknown as typeof fetch;
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    const result = await api.downloadPodcastEpisode({ id: 'ep-1' });
    expect(result).toBe(mockResponse);
  });

  it('getPodcastEpisode passes id (OpenSubsonic)', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', podcastEpisode: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getPodcastEpisode({ id: 'ep-42' });
    expect(parseUrl(calls[0].url).searchParams.get('id')).toBe('ep-42');
  });
});

// =============================
// Jukebox API
// =============================

describe('jukebox API', () => {
  it('jukeboxControl passes action and id array', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', jukeboxStatus: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.jukeboxControl({ action: 'add', id: ['s1', 's2'] });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('action')).toBe('add');
    expect(url.searchParams.getAll('id')).toEqual(['s1', 's2']);
  });

  it('jukeboxControl passes gain', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', jukeboxStatus: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.jukeboxControl({ action: 'setGain', gain: 0.5 });
    expect(parseUrl(calls[0].url).searchParams.get('gain')).toBe('0.5');
  });
});

// =============================
// Internet radio API
// =============================

describe('internet radio API', () => {
  it('getInternetRadioStations calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', internetRadioStations: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getInternetRadioStations();
    expect(calls[0].url).toContain('/rest/getInternetRadioStations.view');
  });

  it('createInternetRadioStation passes name and streamUrl', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.createInternetRadioStation({ name: 'Jazz FM', streamUrl: 'http://stream.jazzfm.com' });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('name')).toBe('Jazz FM');
    expect(url.searchParams.get('streamUrl')).toBe('http://stream.jazzfm.com');
  });

  it('updateInternetRadioStation passes id and optional fields', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.updateInternetRadioStation({ id: 'ir-1', name: 'New Name' });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('id')).toBe('ir-1');
    expect(url.searchParams.get('name')).toBe('New Name');
  });

  it('deleteInternetRadioStation passes id', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.deleteInternetRadioStation({ id: 'ir-1' });
    expect(parseUrl(calls[0].url).searchParams.get('id')).toBe('ir-1');
  });
});

// =============================
// Chat API
// =============================

describe('chat API', () => {
  it('getChatMessages passes since', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', chatMessages: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getChatMessages({ since: 1700000000 });
    expect(parseUrl(calls[0].url).searchParams.get('since')).toBe('1700000000');
  });

  it('addChatMessage passes message', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.addChatMessage({ message: 'Hello world' });
    expect(parseUrl(calls[0].url).searchParams.get('message')).toBe('Hello world');
  });
});

// =============================
// User management API
// =============================

describe('user management API', () => {
  it('getUser passes username', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', user: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getUser({ username: 'admin' });
    expect(parseUrl(calls[0].url).searchParams.get('username')).toBe('admin');
  });

  it('getUsers calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', users: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getUsers();
    expect(calls[0].url).toContain('/rest/getUsers.view');
  });

  it('createUser passes musicFolderId as array', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.createUser({
      username: 'newuser',
      password: 'pass123',
      email: 'user@example.com',
      musicFolderId: [1, 2, 3],
    });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('username')).toBe('newuser');
    expect(url.searchParams.getAll('musicFolderId')).toEqual(['1', '2', '3']);
  });

  it('deleteUser passes username', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.deleteUser({ username: 'olduser' });
    expect(parseUrl(calls[0].url).searchParams.get('username')).toBe('olduser');
  });

  it('changePassword passes username and password', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.changePassword({ username: 'user1', password: 'newpass' });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('username')).toBe('user1');
    expect(url.searchParams.get('password')).toBe('newpass');
  });
});

// =============================
// Bookmark API
// =============================

describe('bookmark API', () => {
  it('getBookmarks calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', bookmarks: {} });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getBookmarks();
    expect(calls[0].url).toContain('/rest/getBookmarks.view');
  });

  it('createBookmark passes id, position, and comment', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.createBookmark({ id: 'ep-1', position: 60000, comment: 'left off here' });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('id')).toBe('ep-1');
    expect(url.searchParams.get('position')).toBe('60000');
    expect(url.searchParams.get('comment')).toBe('left off here');
  });

  it('deleteBookmark passes id', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.deleteBookmark({ id: 'ep-1' });
    expect(parseUrl(calls[0].url).searchParams.get('id')).toBe('ep-1');
  });
});

// =============================
// Play queue API
// =============================

describe('play queue API', () => {
  it('getPlayQueue calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getPlayQueue();
    expect(calls[0].url).toContain('/rest/getPlayQueue.view');
  });

  it('savePlayQueue passes position and current', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.savePlayQueue({ id: 'q-1', current: 'song-3', position: 45000 });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('current')).toBe('song-3');
    expect(url.searchParams.get('position')).toBe('45000');
  });
});

// =============================
// Scan API
// =============================

describe('scan API', () => {
  it('getScanStatus calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', scanStatus: { scanning: false } });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getScanStatus();
    expect(calls[0].url).toContain('/rest/getScanStatus.view');
  });

  it('startScan passes fullScan param', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', scanStatus: { scanning: true } });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.startScan({ fullScan: true });
    expect(parseUrl(calls[0].url).searchParams.get('fullScan')).toBe('true');
  });

  it('startScan works with no args', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', scanStatus: { scanning: true } });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.startScan();
    expect(calls[0].url).toContain('/rest/startScan.view');
  });
});

// =============================
// Navidrome session
// =============================

describe('navidromeSession', () => {
  it('POSTs to auth/login with credentials', async () => {
    const sessionData = { id: '1', token: 'jwt-token', username: 'testuser', isAdmin: false, name: 'Test', subsonicSalt: 's', subsonicToken: 't' };
    const mockFetch = jest.fn(async () => ({ ok: true, json: async () => sessionData })) as unknown as typeof fetch;

    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });
    const result = await api.navidromeSession();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://demo.navidrome.org/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ username: 'testuser', password: 'testpass' }),
      }),
    );
    expect(result.token).toBe('jwt-token');
  });

  it('rejects when response is not ok', async () => {
    const mockFetch = jest.fn(async () => ({ ok: false, statusText: 'Unauthorized' })) as unknown as typeof fetch;

    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await expect(api.navidromeSession()).rejects.toBe('Unauthorized');
  });
});

// =============================
// custom / customJSON
// =============================

describe('custom requests', () => {
  it('custom returns raw response', async () => {
    const mockResponse = { ok: true } as Response;
    const mockFetch = jest.fn(async () => mockResponse) as unknown as typeof fetch;
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    const result = await api.custom('myMethod', { foo: 'bar' });
    expect(result).toBe(mockResponse);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/rest/myMethod.view'),
      expect.any(Object),
    );
  });

  it('customJSON returns parsed subsonic-response', async () => {
    const { mockFetch } = createMockFetch({ status: 'ok', myData: 42 });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    const result = await api.customJSON<{ status: string; myData: number }>('myMethod', {});
    expect(result).toEqual({ status: 'ok', myData: 42 });
  });
});

// ================================
// OpenSubsonic extension endpoints
// ================================

describe('OpenSubsonic extensions', () => {
  it('getOpenSubsonicExtensions calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', openSubsonicExtensions: [] });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getOpenSubsonicExtensions();
    expect(calls[0].url).toContain('/rest/getOpenSubsonicExtensions.view');
  });

  it('getLyricsBySongId passes id', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', lyricsList: [] });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getLyricsBySongId({ id: 'song-1' });
    expect(parseUrl(calls[0].url).searchParams.get('id')).toBe('song-1');
  });

  it('tokenInfo calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', tokenInfo: { username: 'user' } });
    const api = new SubsonicAPI({ ...API_KEY_CONFIG, fetch: mockFetch });

    await api.tokenInfo();
    expect(calls[0].url).toContain('/rest/tokenInfo.view');
  });

  it('getPlayQueueByIndex calls correct endpoint', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getPlayQueueByIndex();
    expect(calls[0].url).toContain('/rest/getPlayQueueByIndex.view');
  });

  it('savePlayQueueByIndex passes id array and currentIndex', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.savePlayQueueByIndex({ id: ['s1', 's2'], currentIndex: 1, position: 30000 });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.getAll('id')).toEqual(['s1', 's2']);
    expect(url.searchParams.get('currentIndex')).toBe('1');
    expect(url.searchParams.get('position')).toBe('30000');
  });

  it('savePlayQueueByIndex works with no args (clear queue)', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.savePlayQueueByIndex();
    expect(calls[0].url).toContain('/rest/savePlayQueueByIndex.view');
  });

  it('savePlayQueueByIndex works with single id string', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.savePlayQueueByIndex({ id: 'single-song' });
    expect(parseUrl(calls[0].url).searchParams.get('id')).toBe('single-song');
  });

  it('reportPlayback passes all params', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.reportPlayback({
      mediaId: 'song-1',
      mediaType: 'song',
      positionMs: 120000,
      state: 'playing',
      playbackRate: 1.0,
      ignoreScrobble: true,
    });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('mediaId')).toBe('song-1');
    expect(url.searchParams.get('mediaType')).toBe('song');
    expect(url.searchParams.get('positionMs')).toBe('120000');
    expect(url.searchParams.get('state')).toBe('playing');
    expect(url.searchParams.get('playbackRate')).toBe('1');
    expect(url.searchParams.get('ignoreScrobble')).toBe('true');
  });

  it('reportPlayback with podcast mediaType', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.reportPlayback({
      mediaId: 'ep-1',
      mediaType: 'podcast',
      positionMs: 0,
      state: 'starting',
    });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('mediaType')).toBe('podcast');
    expect(url.searchParams.get('state')).toBe('starting');
  });

  describe('getTranscodeDecision', () => {
    it('sends POST with JSON body and auth query params', async () => {
      const transcodeResponse = {
        status: 'ok',
        transcodeDecision: { canDirectPlay: true, canTranscode: false },
      };
      const { mockFetch, calls } = createMockFetch(transcodeResponse);
      const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

      const clientInfo = {
        name: 'substreamer8',
        platform: 'ios',
        directPlayProfiles: [{ containers: ['flac'], audioCodecs: ['flac'], protocols: ['http'], maxAudioChannels: 2 }],
        transcodingProfiles: [],
        codecProfiles: [],
      };

      await api.getTranscodeDecision({
        mediaId: 'song-1',
        mediaType: 'song',
        clientInfo,
      });

      // Must use POST
      expect(calls[0].options?.method).toBe('POST');
      // Content-Type is JSON for the body
      expect((calls[0].options?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      // Body is the clientInfo as JSON
      expect(JSON.parse(calls[0].options?.body as string)).toEqual(clientInfo);
      // Query params include auth and media params
      const url = parseUrl(calls[0].url);
      expect(url.searchParams.get('mediaId')).toBe('song-1');
      expect(url.searchParams.get('mediaType')).toBe('song');
      expect(url.searchParams.get('c')).toBe('substreamer8');
      expect(url.searchParams.get('v')).toBe('1.15.0');
    });

    it('uses password auth in query params', async () => {
      const { mockFetch, calls } = createMockFetch({ status: 'ok', transcodeDecision: {} });
      const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

      await api.getTranscodeDecision({
        mediaId: 'song-1',
        mediaType: 'song',
        clientInfo: { name: 'test', platform: 'android' },
      });

      const url = parseUrl(calls[0].url);
      expect(url.searchParams.get('u')).toBe('testuser');
      expect(url.searchParams.has('t')).toBe(true);
      expect(url.searchParams.has('s')).toBe(true);
    });

    it('uses API key auth in query params', async () => {
      const { mockFetch, calls } = createMockFetch({ status: 'ok', transcodeDecision: {} });
      const api = new SubsonicAPI({ ...API_KEY_CONFIG, fetch: mockFetch });

      await api.getTranscodeDecision({
        mediaId: 'song-1',
        mediaType: 'song',
        clientInfo: { name: 'test', platform: 'ios' },
      });

      const url = parseUrl(calls[0].url);
      expect(url.searchParams.get('apiKey')).toBe('my-api-key-123');
    });

    it('returns parsed transcodeDecision', async () => {
      const decision = { canDirectPlay: false, canTranscode: true, transcodeReason: ['codec unsupported'] };
      const { mockFetch } = createMockFetch({ status: 'ok', transcodeDecision: decision });
      const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

      const result = await api.getTranscodeDecision({
        mediaId: 'song-1',
        mediaType: 'song',
        clientInfo: { name: 'test', platform: 'ios' },
      });

      expect(result.transcodeDecision).toEqual(decision);
    });
  });

  it('getTranscodeStream returns raw response', async () => {
    const mockResponse = { ok: true, headers: new Headers({ 'content-type': 'audio/flac' }) } as Response;
    const mockFetch = jest.fn(async () => mockResponse) as unknown as typeof fetch;
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    const result = await api.getTranscodeStream({
      mediaId: 'song-1',
      mediaType: 'song',
      transcodeParams: 'codec=mp3&bitrate=320',
    });
    expect(result).toBe(mockResponse);
  });

  it('getTranscodeStream passes offset', async () => {
    const { mockFetch, calls } = createMockFetch();
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });

    await api.getTranscodeStream({
      mediaId: 'song-1',
      mediaType: 'song',
      transcodeParams: 'codec=mp3',
      offset: 30,
    });
    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('offset')).toBe('30');
    expect(url.searchParams.get('transcodeParams')).toBe('codec=mp3');
  });
});

// =============================
// md5 helper
// =============================

describe('md5', () => {
  it('computes correct hash for empty string', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('computes correct hash for "hello"', () => {
    expect(md5('hello')).toBe('5d41402abc4b2a76b9719d911017c592');
  });

  it('computes correct hash for longer string', () => {
    expect(md5('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });

  it('produces consistent results for same input', () => {
    const input = 'testpasswordsalt123';
    expect(md5(input)).toBe(md5(input));
  });

  it('produces different results for different inputs', () => {
    expect(md5('password1')).not.toBe(md5('password2'));
  });
});

// =============================
// utils - arrayBufferToBase64
// =============================

describe('arrayBufferToBase64', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { arrayBufferToBase64 } = require('../utils') as { arrayBufferToBase64: (bytes: Uint8Array) => string };

  it('encodes empty array', () => {
    const result = arrayBufferToBase64(new Uint8Array([]));
    expect(typeof result).toBe('string');
  });

  it('encodes single byte', () => {
    const result = arrayBufferToBase64(new Uint8Array([65]));
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('encodes multiple bytes consistently', () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]);
    const result1 = arrayBufferToBase64(bytes);
    const result2 = arrayBufferToBase64(bytes);
    expect(result1).toBe(result2);
  });

  it('produces URL-safe output (no +, /, or = characters)', () => {
    // Use bytes that would produce +, /, = in standard base64
    const bytes = new Uint8Array([255, 254, 253, 252, 251, 250]);
    const result = arrayBufferToBase64(bytes);
    expect(result).not.toContain('+');
    expect(result).not.toContain('/');
    expect(result).not.toContain('=');
  });

  it('uses btoa fallback when Buffer is not available', () => {
    // The function checks Buffer at call time, so we can test the btoa path
    // by temporarily making Buffer.isEncoding return false
    const origIsEncoding = Buffer.isEncoding;
    Buffer.isEncoding = (() => false) as unknown as typeof Buffer.isEncoding;
    try {
      const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const result = arrayBufferToBase64(bytes);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      // Should still produce URL-safe output
      expect(result).not.toContain('+');
      expect(result).not.toContain('/');
      expect(result).not.toContain('=');
    } finally {
      Buffer.isEncoding = origIsEncoding;
    }
  });
});

// =============================
// Type re-exports
// =============================

describe('exports', () => {
  it('exports SubsonicAPI as default export', () => {
    // Verify the default import is a constructor
    expect(typeof SubsonicAPI).toBe('function');
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: jest.fn() });
    expect(api).toBeInstanceOf(SubsonicAPI);
  });

  it('exports SubsonicAPI as named export', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../index');
    expect(mod.SubsonicAPI).toBeDefined();
    expect(typeof mod.SubsonicAPI).toBe('function');
    // Both default and named should resolve to the same class
    expect(mod.default.name).toBe(mod.SubsonicAPI.name);
  });
});

// ==========================
// Legacy Auth
// ==========================

const LEGACY_AUTH_CONFIG = {
  url: 'https://nextcloud.example.com',
  auth: { username: 'testuser', password: 'testpass' },
  legacyAuth: true,
  fetch: jest.fn(),
} as const;

describe('legacy auth', () => {
  it('constructs successfully without crypto when legacyAuth is true', () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      const api = new SubsonicAPI({
        url: 'https://example.com',
        auth: { username: 'user', password: 'pass' },
        legacyAuth: true,
        fetch: noopFetch,
      });
      expect(api).toBeInstanceOf(SubsonicAPI);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true });
    }
  });

  it('sends p param with hex-encoded password and no t or s', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', version: '1.16.1' });
    const api = new SubsonicAPI({ ...LEGACY_AUTH_CONFIG, fetch: mockFetch });
    await api.ping();

    const url = parseUrl(calls[0].url);
    // "testpass" → hex: 7465737470617373
    expect(url.searchParams.get('p')).toBe('enc:7465737470617373');
    expect(url.searchParams.get('u')).toBe('testuser');
    expect(url.searchParams.has('t')).toBe(false);
    expect(url.searchParams.has('s')).toBe(false);
  });

  it('hex-encodes special characters correctly', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', version: '1.16.1' });
    const api = new SubsonicAPI({
      url: 'https://example.com',
      auth: { username: 'user', password: 'p@ss!' },
      legacyAuth: true,
      fetch: mockFetch,
    });
    await api.ping();

    const url = parseUrl(calls[0].url);
    // p=0x70, @=0x40, s=0x73, s=0x73, !=0x21
    expect(url.searchParams.get('p')).toBe('enc:7040737321');
  });

  it('does not affect API key auth', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', version: '1.16.1' });
    const api = new SubsonicAPI({
      ...API_KEY_CONFIG,
      legacyAuth: true,
      fetch: mockFetch,
    });
    await api.ping();

    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('apiKey')).toBe('my-api-key-123');
    expect(url.searchParams.has('p')).toBe(false);
    expect(url.searchParams.has('t')).toBe(false);
  });

  it('uses t+s when legacyAuth is false (default)', async () => {
    const { mockFetch, calls } = createMockFetch({ status: 'ok', version: '1.16.1' });
    const api = new SubsonicAPI({ ...PASSWORD_CONFIG, fetch: mockFetch });
    await api.ping();

    const url = parseUrl(calls[0].url);
    expect(url.searchParams.has('t')).toBe(true);
    expect(url.searchParams.has('s')).toBe(true);
    expect(url.searchParams.has('p')).toBe(false);
  });

  it('uses legacy auth via #applyAuth in getTranscodeDecision', async () => {
    const { mockFetch, calls } = createMockFetch({
      status: 'ok',
      version: '1.16.1',
      transcodeDecision: { decision: 'transcode', format: 'mp3', bitRate: 320 },
    });
    const api = new SubsonicAPI({ ...LEGACY_AUTH_CONFIG, fetch: mockFetch });
    await api.getTranscodeDecision({
      mediaId: 'song-1',
      mediaType: 'song',
      clientInfo: { deviceName: 'test', deviceType: 'mobile' } as any,
    });

    const url = parseUrl(calls[0].url);
    expect(url.searchParams.get('p')).toBe('enc:7465737470617373');
    expect(url.searchParams.get('u')).toBe('testuser');
    expect(url.searchParams.has('t')).toBe(false);
    expect(url.searchParams.has('s')).toBe(false);
  });
});
