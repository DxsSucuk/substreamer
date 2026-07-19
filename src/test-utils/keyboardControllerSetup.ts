/**
 * Jest mock for react-native-keyboard-controller.
 *
 * BottomSheet derives its keyboard lift from
 * `useReanimatedKeyboardAnimation().height`, and the app root wraps everything
 * in `<KeyboardProvider>`. Neither has a native module under jest, so mock the
 * package: KeyboardProvider is a passthrough and the animation hook returns
 * inert shared values so the sheet renders as if the keyboard is closed.
 */

jest.mock('react-native-keyboard-controller', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    KeyboardProvider: ({ children }: { children: React.ReactNode }) => children,
    KeyboardAwareScrollView: View,
    useReanimatedKeyboardAnimation: () => ({
      height: { value: 0 },
      progress: { value: 0 },
    }),
    useKeyboardAnimation: () => ({
      height: { value: 0 },
      progress: { value: 0 },
    }),
  };
});
