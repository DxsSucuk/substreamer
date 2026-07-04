jest.mock('../../hooks/useTheme', () => ({
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

import { act, render, screen } from '@testing-library/react-native';

import { PlaybackSourceBadge } from '../PlaybackSourceBadge';
import { playerStore } from '../../store/playerStore';

describe('PlaybackSourceBadge', () => {
  afterEach(() => {
    act(() => playerStore.getState().setTrackSource(null));
  });

  it('renders nothing when the source is unknown', () => {
    act(() => playerStore.getState().setTrackSource(null));
    render(<PlaybackSourceBadge />);
    expect(screen.queryByTestId('source-badge-streaming')).toBeNull();
    expect(screen.queryByTestId('source-badge-cached')).toBeNull();
    expect(screen.queryByTestId('source-badge-local')).toBeNull();
  });

  it('shows the cloud glyph while streaming', () => {
    act(() => playerStore.getState().setTrackSource('streaming'));
    render(<PlaybackSourceBadge />);
    expect(screen.getByTestId('source-badge-streaming')).toBeTruthy();
    expect(screen.getByTestId('icon-cloud-outline')).toBeTruthy();
  });

  it('shows the storage glyph when cached', () => {
    act(() => playerStore.getState().setTrackSource('cached'));
    render(<PlaybackSourceBadge />);
    expect(screen.getByTestId('source-badge-cached')).toBeTruthy();
    expect(screen.getByTestId('icon-harddisk')).toBeTruthy();
  });

  it('shows the downloaded icon when playing a local file', () => {
    act(() => playerStore.getState().setTrackSource('local'));
    render(<PlaybackSourceBadge />);
    expect(screen.getByTestId('source-badge-local')).toBeTruthy();
    // DownloadedIcon renders the Ionicons arrow-down-circle glyph.
    expect(screen.getByTestId('icon-arrow-down-circle')).toBeTruthy();
  });
});
