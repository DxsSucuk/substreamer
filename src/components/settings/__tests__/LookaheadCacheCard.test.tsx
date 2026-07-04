jest.mock('../../../store/persistence/kvStorage', () =>
  require('../../../store/persistence/__mocks__/kvStorage'),
);

jest.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      primary: '#ff6600',
      textPrimary: '#ffffff',
      textSecondary: '#888888',
      border: '#333333',
      card: '#1e1e1e',
      inputBg: '#2a2a2a',
    },
  }),
}));

jest.mock('../../../hooks/useThemedAlert', () => ({
  useThemedAlert: () => ({
    confirm: ({ onConfirm }: { onConfirm: () => void }) => onConfirm(),
  }),
}));

import { fireEvent, render, screen } from '@testing-library/react-native';

import { LookaheadCacheCard } from '../LookaheadCacheCard';
import { playbackSettingsStore } from '../../../store/playbackSettingsStore';

const rnqp = require('react-native-queue-player');
const mockTP = rnqp.__trackPlayer;

describe('LookaheadCacheCard', () => {
  beforeEach(() => {
    mockTP.setLookaheadCache.mockClear();
    mockTP.clearLookaheadCache.mockClear();
    mockTP.getLookaheadCacheStatus.mockReturnValue({
      enabled: true,
      currentSizeMb: 12,
      maxSizeMb: 512,
      tracksFullyCached: 2,
      currentlyCaching: [],
    });
    playbackSettingsStore.setState({ lookaheadEnabled: true, lookaheadCount: 3 });
  });

  it('renders the enable toggle, size figure and clear button', () => {
    render(<LookaheadCacheCard />);
    expect(screen.getByText('Cache upcoming tracks')).toBeTruthy();
    expect(screen.getByText('Cache size')).toBeTruthy();
    expect(screen.getByText('Clear cache')).toBeTruthy();
    // Tracks-ready shows "2 of 3" while enabled.
    expect(screen.getByText('2 of 3')).toBeTruthy();
  });

  it('turning caching off hides the count selector + tracks-ready', () => {
    playbackSettingsStore.setState({ lookaheadEnabled: false });
    render(<LookaheadCacheCard />);
    expect(screen.queryByText('Tracks to cache')).toBeNull();
    expect(screen.queryByText('Tracks ready')).toBeNull();
  });

  it('toggling the switch updates the store and re-applies the cache config', () => {
    render(<LookaheadCacheCard />);
    fireEvent(screen.getByTestId('lookahead-toggle'), 'valueChange', false);
    expect(playbackSettingsStore.getState().lookaheadEnabled).toBe(false);
    // applyLookaheadCacheConfig() pushes the new config to the engine.
    expect(mockTP.setLookaheadCache).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, lookaheadCount: 3 }),
    );
  });

  it('clearing the cache confirms then wipes it', () => {
    render(<LookaheadCacheCard />);
    fireEvent.press(screen.getByText('Clear cache'));
    expect(mockTP.clearLookaheadCache).toHaveBeenCalled();
  });
});
