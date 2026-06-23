jest.mock('../persistence/kvStorage', () => require('../persistence/__mocks__/kvStorage'));

import { authStore } from '../authStore';

beforeEach(() => {
  authStore.setState({
    serverUrl: null,
    username: null,
    password: null,
    apiVersion: null,
    legacyAuth: false,
    isLoggedIn: false,
    rehydrated: false,
    primaryServerUrl: null,
    secondaryServerUrl: null,
    activeServer: 'primary',
    serverSwitchMode: 'manual',
  });
});

describe('authStore', () => {
  it('setSession stores credentials and sets isLoggedIn', () => {
    authStore.getState().setSession('https://music.example.com', 'user', 'pass', '1.16');
    const state = authStore.getState();
    expect(state.serverUrl).toBe('https://music.example.com');
    expect(state.username).toBe('user');
    expect(state.password).toBe('pass');
    expect(state.apiVersion).toBe('1.16');
    expect(state.isLoggedIn).toBe(true);
  });

  it('setSession defaults legacyAuth to false when omitted', () => {
    authStore.getState().setSession('https://music.example.com', 'user', 'pass', '1.16');
    expect(authStore.getState().legacyAuth).toBe(false);
  });

  it('setSession stores legacyAuth when true', () => {
    authStore.getState().setSession('https://music.example.com', 'user', 'pass', '1.16', true);
    expect(authStore.getState().legacyAuth).toBe(true);
  });

  it('setLegacyAuth flips the auth scheme without disturbing the server slots', () => {
    authStore.getState().setSession('https://music.example.com', 'user', 'pass', '1.16');
    authStore.getState().setSecondaryServerUrl('https://backup.example.com');
    authStore.getState().setActiveServer('secondary');

    authStore.getState().setLegacyAuth(true);

    const state = authStore.getState();
    expect(state.legacyAuth).toBe(true);
    // Slots, active server, and credentials are untouched.
    expect(state.primaryServerUrl).toBe('https://music.example.com');
    expect(state.secondaryServerUrl).toBe('https://backup.example.com');
    expect(state.activeServer).toBe('secondary');
    expect(state.serverUrl).toBe('https://backup.example.com');
    expect(state.username).toBe('user');

    authStore.getState().setLegacyAuth(false);
    expect(authStore.getState().legacyAuth).toBe(false);
  });

  it('clearSession resets all credentials', () => {
    authStore.getState().setSession('https://music.example.com', 'user', 'pass', '1.16', true);
    authStore.getState().clearSession();
    const state = authStore.getState();
    expect(state.serverUrl).toBeNull();
    expect(state.username).toBeNull();
    expect(state.password).toBeNull();
    expect(state.apiVersion).toBeNull();
    expect(state.legacyAuth).toBe(false);
    expect(state.isLoggedIn).toBe(false);
  });

  it('setRehydrated updates rehydrated flag', () => {
    authStore.getState().setRehydrated(true);
    expect(authStore.getState().rehydrated).toBe(true);
  });

  describe('failover schema', () => {
    it('setSession populates primaryServerUrl and resets activeServer to primary', () => {
      authStore.getState().setSession('https://primary.example.com', 'user', 'pass', '1.16');
      const state = authStore.getState();
      expect(state.serverUrl).toBe('https://primary.example.com');
      expect(state.primaryServerUrl).toBe('https://primary.example.com');
      expect(state.activeServer).toBe('primary');
    });

    it('setSession on top of secondary-active resets back to primary', () => {
      authStore.setState({
        primaryServerUrl: 'https://old-primary.example.com',
        secondaryServerUrl: 'https://secondary.example.com',
        activeServer: 'secondary',
        serverUrl: 'https://secondary.example.com',
      });
      authStore.getState().setSession('https://new-primary.example.com', 'user', 'pass', '1.16');
      const state = authStore.getState();
      expect(state.serverUrl).toBe('https://new-primary.example.com');
      expect(state.primaryServerUrl).toBe('https://new-primary.example.com');
      expect(state.activeServer).toBe('primary');
    });

    it('clearSession wipes failover state along with credentials', () => {
      authStore.setState({
        primaryServerUrl: 'https://primary.example.com',
        secondaryServerUrl: 'https://secondary.example.com',
        activeServer: 'secondary',
        serverSwitchMode: 'automatic',
      });
      authStore.getState().clearSession();
      const state = authStore.getState();
      expect(state.primaryServerUrl).toBeNull();
      expect(state.secondaryServerUrl).toBeNull();
      expect(state.activeServer).toBe('primary');
      expect(state.serverSwitchMode).toBe('manual');
    });

    it('setSecondaryServerUrl stores the URL', () => {
      authStore.getState().setSecondaryServerUrl('https://secondary.example.com');
      expect(authStore.getState().secondaryServerUrl).toBe('https://secondary.example.com');
    });

    it('setSecondaryServerUrl(null) clears the URL', () => {
      authStore.setState({ secondaryServerUrl: 'https://secondary.example.com' });
      authStore.getState().setSecondaryServerUrl(null);
      expect(authStore.getState().secondaryServerUrl).toBeNull();
    });

    it('setServerSwitchMode toggles between manual and automatic', () => {
      authStore.getState().setServerSwitchMode('automatic');
      expect(authStore.getState().serverSwitchMode).toBe('automatic');
      authStore.getState().setServerSwitchMode('manual');
      expect(authStore.getState().serverSwitchMode).toBe('manual');
    });

    it('setActiveServer(secondary) updates serverUrl to secondary URL', () => {
      authStore.setState({
        primaryServerUrl: 'https://primary.example.com',
        secondaryServerUrl: 'https://secondary.example.com',
        serverUrl: 'https://primary.example.com',
        activeServer: 'primary',
      });
      authStore.getState().setActiveServer('secondary');
      const state = authStore.getState();
      expect(state.activeServer).toBe('secondary');
      expect(state.serverUrl).toBe('https://secondary.example.com');
    });

    it('setActiveServer(primary) swaps back from secondary', () => {
      authStore.setState({
        primaryServerUrl: 'https://primary.example.com',
        secondaryServerUrl: 'https://secondary.example.com',
        serverUrl: 'https://secondary.example.com',
        activeServer: 'secondary',
      });
      authStore.getState().setActiveServer('primary');
      const state = authStore.getState();
      expect(state.activeServer).toBe('primary');
      expect(state.serverUrl).toBe('https://primary.example.com');
    });

    it('setActiveServer is a no-op if target slot has no URL', () => {
      authStore.setState({
        primaryServerUrl: 'https://primary.example.com',
        secondaryServerUrl: null,
        serverUrl: 'https://primary.example.com',
        activeServer: 'primary',
      });
      authStore.getState().setActiveServer('secondary');
      const state = authStore.getState();
      expect(state.activeServer).toBe('primary');
      expect(state.serverUrl).toBe('https://primary.example.com');
    });

    it('setActiveServer is a no-op if already on the target slot', () => {
      authStore.setState({
        primaryServerUrl: 'https://primary.example.com',
        serverUrl: 'https://primary.example.com',
        activeServer: 'primary',
      });
      authStore.getState().setActiveServer('primary');
      expect(authStore.getState().activeServer).toBe('primary');
    });
  });
});

