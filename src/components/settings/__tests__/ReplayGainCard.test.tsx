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

import { fireEvent, render, screen } from '@testing-library/react-native';

import { ReplayGainCard } from '../ReplayGainCard';
import { playbackSettingsStore } from '../../../store/playbackSettingsStore';

const rnqp = require('react-native-queue-player');
const mockTP = rnqp.__trackPlayer;

describe('ReplayGainCard', () => {
  beforeEach(() => {
    mockTP.setReplayGainMode.mockClear();
    playbackSettingsStore.setState({ replayGainMode: 'off' });
  });

  it('defaults to Off', () => {
    render(<ReplayGainCard />);
    expect(screen.getByText('Mode')).toBeTruthy();
    expect(screen.getByText('Off')).toBeTruthy();
  });

  it('selecting a mode persists it + pushes it to the engine', () => {
    render(<ReplayGainCard />);
    fireEvent.press(screen.getByText('Mode')); // open the dropdown
    fireEvent.press(screen.getByText('Album'));
    expect(playbackSettingsStore.getState().replayGainMode).toBe('album');
    expect(mockTP.setReplayGainMode).toHaveBeenCalledWith('album');
  });
});
