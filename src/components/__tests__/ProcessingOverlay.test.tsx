jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: { card: '#111', textPrimary: '#fff', primary: '#007AFF', red: '#f00' },
  }),
}));

// Stub Reanimated to no-ops — the fix is JS-state-driven (mount/unmount,
// pointerEvents, retained content), so the animation internals are irrelevant
// here and the real module drags in native worklets that don't load in jest.
jest.mock('react-native-reanimated', () => {
  const RN = require('react-native');
  return {
    __esModule: true,
    default: { View: RN.View, Text: RN.Text },
    useAnimatedStyle: () => ({}),
    useSharedValue: () => ({ value: 0 }),
    withTiming: () => 0,
  };
});

import { render, screen, act } from '@testing-library/react-native';

import { ProcessingOverlay } from '../ProcessingOverlay';
import {
  processingOverlayStore,
  type OverlayStatus,
} from '../../store/processingOverlayStore';

const BACKDROP = 'processingOverlayBackdrop';

function setStore(patch: { status: OverlayStatus; label: string }) {
  act(() => {
    processingOverlayStore.setState(patch);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  act(() => {
    processingOverlayStore.setState({ status: 'idle', label: '', _showedAt: 0 });
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ProcessingOverlay', () => {
  it('renders nothing while idle', () => {
    render(<ProcessingOverlay />);
    expect(screen.queryByTestId(BACKDROP)).toBeNull();
  });

  it('shows content and blocks touches while processing', () => {
    render(<ProcessingOverlay />);
    setStore({ status: 'processing', label: 'Loading' });
    expect(screen.getByTestId(BACKDROP).props.pointerEvents).toBe('auto');
    expect(screen.getByText('Loading')).toBeTruthy();
  });

  it('stops blocking the instant status is idle and never renders an empty box', () => {
    render(<ProcessingOverlay />);
    setStore({ status: 'processing', label: 'Loading' });
    setStore({ status: 'idle', label: '' });
    const backdrop = screen.getByTestId(BACKDROP); // still mounted, fading out
    // Touches pass through immediately — independent of the fade animation.
    expect(backdrop.props.pointerEvents).toBe('none');
    // Retains the last content — never the empty idle card.
    expect(screen.getByText('Loading')).toBeTruthy();
  });

  it('unmounts after the fade via a JS timer, even if the animation never completes', () => {
    render(<ProcessingOverlay />);
    setStore({ status: 'processing', label: 'Loading' });
    setStore({ status: 'idle', label: '' });
    expect(screen.queryByTestId(BACKDROP)).not.toBeNull();
    act(() => {
      jest.advanceTimersByTime(400);
    });
    expect(screen.queryByTestId(BACKDROP)).toBeNull();
  });

  it('cancels the pending unmount when re-shown within the fade window', () => {
    render(<ProcessingOverlay />);
    setStore({ status: 'processing', label: 'A' });
    setStore({ status: 'idle', label: '' }); // schedules unmount (~330ms)
    act(() => {
      jest.advanceTimersByTime(150);
    });
    setStore({ status: 'processing', label: 'B' }); // re-show cancels the unmount
    act(() => {
      jest.advanceTimersByTime(300); // past the original unmount deadline
    });
    expect(screen.queryByTestId(BACKDROP)).not.toBeNull();
    expect(screen.getByText('B')).toBeTruthy();
  });
});
