jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

import { switchToServer } from '../../services/failoverService';
import { connectivityStore } from '../../store/connectivityStore';
import { offlineModeStore } from '../../store/offlineModeStore';

const mockSwitchToServer = switchToServer as jest.Mock;

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      background: '#000',
      inputBg: '#111',
      textSecondary: '#888',
      red: '#ff0000',
    },
  }),
}));

jest.mock('../../services/connectivityService', () => ({
  handleSslCertPrompt: jest.fn(),
}));

jest.mock('../../services/failoverService', () => ({
  switchToServer: jest.fn(),
}));

jest.mock('react-native-reanimated', () => {
  const { View, Text } = require('react-native');
  return {
    __esModule: true,
    default: {
      View,
      Text,
    },
    useSharedValue: (init: number) => ({ value: init }),
    useAnimatedStyle: (fn: () => object) => fn(),
    withTiming: (val: number) => val,
    withDelay: (_: number, val: number) => val,
    withSpring: (val: number) => val,
    Easing: {
      out: (e: unknown) => e,
      in: (e: unknown) => e,
      inOut: (e: unknown) => e,
      cubic: (t: number) => t,
    },
  };
});

// Must import after mocks
const { ConnectivityBanner } = require('../ConnectivityBanner');

beforeEach(() => {
  connectivityStore.setState({
    bannerState: 'hidden',
    isInternetReachable: true,
    isServerReachable: true,
    failoverPrompt: null,
  });
  offlineModeStore.setState({ offlineMode: false });
  mockSwitchToServer.mockClear();
});

describe('ConnectivityBanner', () => {
  it('does not flash old content during hide animation', () => {
    // Start with reconnected state (green "Connected")
    connectivityStore.setState({ bannerState: 'reconnected' });
    const { rerender, queryByText } = render(<ConnectivityBanner />);
    expect(queryByText('Connected')).toBeTruthy();

    // Transition to hidden — should still show "Connected", not "Server unreachable"
    act(() => connectivityStore.setState({ bannerState: 'hidden' }));
    rerender(<ConnectivityBanner />);

    expect(queryByText('Connected')).toBeTruthy();
    expect(queryByText('Server unreachable')).toBeNull();
    expect(queryByText('No internet connection')).toBeNull();
  });

  it('shows "Server unreachable" when unreachable with internet', () => {
    connectivityStore.setState({
      bannerState: 'unreachable',
      isInternetReachable: true,
    });
    const { getByText } = render(<ConnectivityBanner />);
    expect(getByText('Server unreachable')).toBeTruthy();
  });

  it('shows "Connected" when reconnected', () => {
    connectivityStore.setState({ bannerState: 'reconnected' });
    const { getByText } = render(<ConnectivityBanner />);
    expect(getByText('Connected')).toBeTruthy();
  });

  it('shows "No internet connection" when internet is unreachable', () => {
    connectivityStore.setState({
      bannerState: 'unreachable',
      isInternetReachable: false,
    });
    const { getByText } = render(<ConnectivityBanner />);
    expect(getByText('No internet connection')).toBeTruthy();
  });

  it('shows "Certificate changed" when ssl-error', () => {
    connectivityStore.setState({ bannerState: 'ssl-error' });
    const { getByText } = render(<ConnectivityBanner />);
    expect(getByText('Certificate changed')).toBeTruthy();
  });

  it('offers to switch to secondary when the active server is down (failoverPrompt=secondary)', () => {
    connectivityStore.setState({
      bannerState: 'unreachable',
      isInternetReachable: true,
      failoverPrompt: 'secondary',
    });
    const { getByText } = render(<ConnectivityBanner />);
    expect(getByText('Server unreachable — tap to switch to secondary')).toBeTruthy();
  });

  it('tapping the failover offer switches to the offered server and clears the prompt', () => {
    connectivityStore.setState({
      bannerState: 'unreachable',
      isInternetReachable: true,
      failoverPrompt: 'secondary',
    });
    const { getByText } = render(<ConnectivityBanner />);
    fireEvent.press(getByText('Server unreachable — tap to switch to secondary'));
    expect(mockSwitchToServer).toHaveBeenCalledWith('secondary');
    expect(connectivityStore.getState().failoverPrompt).toBeNull();
  });

  it('shows "Both servers unavailable" and is NOT tappable when failoverPrompt=both-down', () => {
    connectivityStore.setState({
      bannerState: 'unreachable',
      isInternetReachable: true,
      failoverPrompt: 'both-down',
    });
    const { getByText } = render(<ConnectivityBanner />);
    fireEvent.press(getByText('Both servers unavailable'));
    expect(mockSwitchToServer).not.toHaveBeenCalled();
  });

  it('has collapsed height when offline mode suppresses banner', () => {
    offlineModeStore.setState({ offlineMode: true });
    connectivityStore.setState({
      bannerState: 'unreachable',
      isInternetReachable: false,
    });
    const { toJSON } = render(<ConnectivityBanner />);
    const root = toJSON() as import('react-test-renderer').ReactTestRendererJSON;
    // Wrapper height should be 0 — banner is suppressed in offline mode
    expect(root.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ height: 0 })]),
    );
  });
});
