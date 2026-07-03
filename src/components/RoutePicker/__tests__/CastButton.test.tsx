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

import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { CastButton } from '../CastButton';
import { CAST_BUTTON_PREPOSITION, localRouteDisplayName } from '../copy';
import { useRoutePickerStore } from '../useRoutePickerStore';

describe('CastButton', () => {
  afterEach(() => {
    act(() => useRoutePickerStore.getState().close());
  });

  it('shows the local device when no cast session is active', () => {
    render(<CastButton />);
    // Default RNQP mock: local route + built-in speaker → local device label.
    expect(screen.getByText(CAST_BUTTON_PREPOSITION, { exact: false })).toBeTruthy();
    expect(screen.getByText(localRouteDisplayName())).toBeTruthy();
    // Built-in speaker maps to the phone glyph.
    expect(screen.getByTestId('icon-cellphone')).toBeTruthy();
  });

  it('opens the route picker when tapped', () => {
    render(<CastButton />);
    expect(useRoutePickerStore.getState().isOpen).toBe(false);
    fireEvent.press(screen.getByTestId('cast-button'));
    expect(useRoutePickerStore.getState().isOpen).toBe(true);
  });
});
