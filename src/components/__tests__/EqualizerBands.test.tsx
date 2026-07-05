jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      primary: '#ff6600',
      card: '#111111',
      border: '#333333',
      inputBg: '#222222',
      textPrimary: '#ffffff',
      textSecondary: '#888888',
    },
  }),
}));

jest.mock('../../utils/haptics', () => ({ selectionAsync: jest.fn() }));

jest.mock('react-native-reanimated', () => {
  const { View, Text } = require('react-native');
  return {
    __esModule: true,
    default: { View, Text },
    useSharedValue: (init: number) => ({ value: init }),
    useAnimatedStyle: (fn: () => object) => fn(),
    withTiming: (val: number) => val,
    runOnJS: (fn: Function) => fn,
  };
});

jest.mock('react-native-gesture-handler', () => {
  const makeChainable = () => {
    const g: Record<string, () => unknown> = {};
    const methods = [
      'enabled', 'activeOffsetY', 'failOffsetX', 'onBegin', 'onUpdate', 'onFinalize',
    ];
    for (const m of methods) g[m] = () => g;
    return g;
  };
  return {
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
    Gesture: { Pan: makeChainable },
  };
});

import React from 'react';
import { render } from '@testing-library/react-native';

// Must import after mocks
const { EqualizerBands } = require('../EqualizerBands');

const GAINS = [3, 0, -2, 0, 5, 0, 0, -4, 0, 6];

describe('EqualizerBands', () => {
  it('renders one slider per band with frequency labels', () => {
    const { getByTestId, getByText } = render(
      <EqualizerBands gains={GAINS} enabled onBandChange={jest.fn()} />,
    );
    for (let i = 0; i < 10; i++) {
      expect(getByTestId(`eq-band-${i}`)).toBeTruthy();
    }
    // 31 Hz .. 16k Hz endpoints render as compact labels.
    expect(getByText('31')).toBeTruthy();
    expect(getByText('16k')).toBeTruthy();
    expect(getByText('1k')).toBeTruthy();
  });

  it('tolerates a short gains array (missing bands default to 0)', () => {
    const { getByTestId } = render(
      <EqualizerBands gains={[1, 2]} enabled onBandChange={jest.fn()} />,
    );
    expect(getByTestId('eq-band-9')).toBeTruthy();
  });

  it('disables interaction when not enabled', () => {
    const { UNSAFE_root } = render(
      <EqualizerBands gains={GAINS} enabled={false} onBandChange={jest.fn()} />,
    );
    // The band row opts out of touches while the EQ is off.
    const dimmed = UNSAFE_root.findAll(
      (n) => n.props?.pointerEvents === 'none',
    );
    expect(dimmed.length).toBeGreaterThan(0);
  });
});
