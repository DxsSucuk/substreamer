jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

import React from 'react';
import { Text, View } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      background: '#000',
      card: '#111',
      textPrimary: '#fff',
      textSecondary: '#888',
      border: '#333',
      primary: '#1D9BF0',
      red: '#e91429',
      orange: '#FF9500',
      inputBg: '#222',
    },
  }),
}));

const mockHapticsSelection = jest.fn();
const mockHapticsImpact = jest.fn();
jest.mock('@/utils/haptics', () => ({
  selectionAsync: () => mockHapticsSelection(),
  impactAsync: () => mockHapticsImpact(),
  ImpactFeedbackStyle: { Heavy: 'heavy' },
}));

// Captures the last props ReanimatedSwipeable received, so tests can assert
// what SwipeableRow forwards (e.g. the edge-reserving hitSlop).
const mockSwipeableProps: { hitSlop?: unknown } = {};

// ReanimatedSwipeable is the gesture-handling wrapper. The SwipeableRow
// passes `enabled={!disabled}` which the gesture handler honours at
// runtime. The mock forwards the `enabled` flag as a testID so tests can
// assert it; no actual swipe gesture is simulated here.
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const RN = require('react-native');
  return {
    __esModule: true,
    default: ({
      children,
      enabled,
      hitSlop,
    }: {
      children: React.ReactNode;
      enabled?: boolean;
      hitSlop?: unknown;
    }) => {
      mockSwipeableProps.hitSlop = hitSlop;
      return (
        <RN.View testID={`swipeable-${enabled === false ? 'gesture-disabled' : 'gesture-enabled'}`}>
          {children}
        </RN.View>
      );
    },
  };
});

jest.mock('react-native-reanimated', () => {
  const RN = require('react-native');
  return {
    __esModule: true,
    default: { View: RN.View },
    interpolate: () => 0,
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
    useAnimatedReaction: () => {},
    useAnimatedStyle: () => ({}),
    useSharedValue: () => ({ value: 0 }),
    withSequence: () => 0,
    withTiming: () => 0,
  };
});

import { SwipeableRow } from '../SwipeableRow';

beforeEach(() => {
  mockHapticsSelection.mockClear();
  mockHapticsImpact.mockClear();
});

describe('SwipeableRow — disabled prop', () => {
  it('forwards `enabled={true}` to the gesture handler when not disabled (default)', () => {
    const { queryByTestId } = render(
      <SwipeableRow>
        <View testID="content" />
      </SwipeableRow>,
    );
    expect(queryByTestId('swipeable-gesture-enabled')).toBeTruthy();
    expect(queryByTestId('swipeable-gesture-disabled')).toBeNull();
  });

  it('forwards `enabled={false}` to the gesture handler when disabled', () => {
    const { queryByTestId } = render(
      <SwipeableRow disabled>
        <View testID="content" />
      </SwipeableRow>,
    );
    expect(queryByTestId('swipeable-gesture-disabled')).toBeTruthy();
    expect(queryByTestId('swipeable-gesture-enabled')).toBeNull();
  });

  it('does not invoke onPress or fire haptic when disabled', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <SwipeableRow disabled onPress={onPress}>
        <Text testID="content">child</Text>
      </SwipeableRow>,
    );
    fireEvent.press(getByTestId('content'));
    expect(onPress).not.toHaveBeenCalled();
    expect(mockHapticsSelection).not.toHaveBeenCalled();
  });

  it('does not invoke onLongPress or fire haptic when disabled', () => {
    const onLongPress = jest.fn();
    const { getByTestId } = render(
      <SwipeableRow disabled onLongPress={onLongPress}>
        <Text testID="content">child</Text>
      </SwipeableRow>,
    );
    fireEvent(getByTestId('content'), 'longPress');
    expect(onLongPress).not.toHaveBeenCalled();
    expect(mockHapticsImpact).not.toHaveBeenCalled();
  });

  it('invokes onPress + selection haptic when not disabled', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <SwipeableRow onPress={onPress}>
        <Text testID="content">child</Text>
      </SwipeableRow>,
    );
    fireEvent.press(getByTestId('content'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(mockHapticsSelection).toHaveBeenCalledTimes(1);
  });

  it('invokes onLongPress + impact haptic when not disabled', () => {
    const onLongPress = jest.fn();
    const { getByTestId } = render(
      <SwipeableRow onLongPress={onLongPress}>
        <Text testID="content">child</Text>
      </SwipeableRow>,
    );
    fireEvent(getByTestId('content'), 'longPress');
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(mockHapticsImpact).toHaveBeenCalledTimes(1);
  });
});

describe('SwipeableRow — edge-back gesture', () => {
  it('reserves the left edge via negative-left hitSlop so the OS back-swipe wins', () => {
    render(
      <SwipeableRow>
        <View testID="content" />
      </SwipeableRow>,
    );
    // Negative-left hitSlop insets the pan begin-region off the screen edge.
    expect(mockSwipeableProps.hitSlop).toEqual({ left: -25 });
  });
});
