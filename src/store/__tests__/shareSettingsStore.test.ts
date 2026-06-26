import { authStore } from '../authStore';
import {
  getEffectiveShareBaseUrl,
  rewriteShareUrl,
  shareSettingsStore,
} from '../shareSettingsStore';

jest.mock('../persistence/kvStorage', () => require('../persistence/__mocks__/kvStorage'));

beforeEach(() => {
  shareSettingsStore.setState({ shareBaseUrl: null });
  authStore.setState({
    serverUrl: 'https://music.example.com',
    primaryServerUrl: null,
    username: 'user',
    password: 'pass',
    apiVersion: '1.16',
    isLoggedIn: true,
    rehydrated: true,
  });
});

describe('getEffectiveShareBaseUrl', () => {
  it('returns custom URL when set', () => {
    shareSettingsStore.setState({ shareBaseUrl: 'https://share.example.com' });
    expect(getEffectiveShareBaseUrl()).toBe('https://share.example.com');
  });

  it('falls back to serverUrl when no custom URL', () => {
    expect(getEffectiveShareBaseUrl()).toBe('https://music.example.com');
  });
});

describe('rewriteShareUrl', () => {
  it('rewrites origin when alternate configured', () => {
    shareSettingsStore.setState({ shareBaseUrl: 'https://share.example.com' });
    const original = 'https://music.example.com/rest/stream.view?id=123';
    expect(rewriteShareUrl(original)).toBe(
      'https://share.example.com/rest/stream.view?id=123',
    );
  });

  it('returns original when no alternate', () => {
    const original = 'https://music.example.com/rest/stream.view?id=123';
    expect(rewriteShareUrl(original)).toBe(original);
  });

  it('returns original when serverUrl missing', () => {
    authStore.setState({ serverUrl: null });
    shareSettingsStore.setState({ shareBaseUrl: 'https://share.example.com' });
    const original = 'https://music.example.com/rest/stream.view?id=123';
    expect(rewriteShareUrl(original)).toBe(original);
  });

  it('returns original for invalid URL', () => {
    shareSettingsStore.setState({ shareBaseUrl: 'not-a-url' });
    const original = 'https://music.example.com/rest/stream.view?id=123';
    expect(rewriteShareUrl(original)).toBe(original);
  });

  it('returns original unchanged when URL does not contain server origin', () => {
    shareSettingsStore.setState({ shareBaseUrl: 'https://share.example.com' });
    const original = 'https://other-server.com/rest/stream.view?id=123';
    expect(rewriteShareUrl(original)).toBe(original);
  });

  it('restores a port the server stripped from a same-host share link (#208)', () => {
    // Navidrome behind a reverse proxy returns the share URL without the port
    // because req.Host carried no port. We connect on :4533, so restore it.
    authStore.setState({
      primaryServerUrl: 'http://192.168.88.96:4533',
      serverUrl: 'http://192.168.88.96:4533',
    });
    const original = 'http://192.168.88.96/share/abc123';
    expect(rewriteShareUrl(original)).toBe('http://192.168.88.96:4533/share/abc123');
  });

  it('uses the PRIMARY server origin, not the active (failover) server', () => {
    authStore.setState({
      primaryServerUrl: 'http://192.168.88.96:4533',
      serverUrl: 'http://192.168.88.96:9999', // active server drifted (failover)
    });
    const original = 'http://192.168.88.96/share/abc123';
    expect(rewriteShareUrl(original)).toBe('http://192.168.88.96:4533/share/abc123');
  });

  it('alternate base URL overrides the origin and carries its own port', () => {
    authStore.setState({ primaryServerUrl: 'http://192.168.88.96:4533' });
    shareSettingsStore.setState({ shareBaseUrl: 'https://share.example.com:8443' });
    const original = 'http://192.168.88.96/share/abc123';
    expect(rewriteShareUrl(original)).toBe('https://share.example.com:8443/share/abc123');
  });
});

describe('getEffectiveShareBaseUrl edge cases', () => {
  it('returns null when both shareBaseUrl and serverUrl are null', () => {
    shareSettingsStore.setState({ shareBaseUrl: null });
    authStore.setState({ serverUrl: null } as any);
    expect(getEffectiveShareBaseUrl()).toBeNull();
  });
});

describe('setShareBaseUrl', () => {
  it('stores URL when provided', () => {
    shareSettingsStore.getState().setShareBaseUrl('https://alt.example.com');
    expect(shareSettingsStore.getState().shareBaseUrl).toBe('https://alt.example.com');
  });

  it('converts empty string to null', () => {
    shareSettingsStore.getState().setShareBaseUrl('https://alt.example.com');
    shareSettingsStore.getState().setShareBaseUrl('');
    expect(shareSettingsStore.getState().shareBaseUrl).toBeNull();
  });

  it('stores null when null provided', () => {
    shareSettingsStore.getState().setShareBaseUrl('https://alt.example.com');
    shareSettingsStore.getState().setShareBaseUrl(null);
    expect(shareSettingsStore.getState().shareBaseUrl).toBeNull();
  });
});
