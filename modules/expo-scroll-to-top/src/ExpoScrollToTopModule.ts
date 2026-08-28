import { requireNativeModule } from 'expo-modules-core';

export interface ExpoScrollToTopNativeModule {
  setArmed(armed: boolean): void;
  isSupported(): boolean;
  addListener(event: string, listener: () => void): { remove: () => void };
  removeListeners(count: number): void;
}

let module: ExpoScrollToTopNativeModule;

try {
  module = requireNativeModule('ExpoScrollToTop');
} catch {
  console.warn(
    '[expo-scroll-to-top] Native module not found. ' +
      'Run `npx expo run:ios` or `npx expo run:android` to rebuild with the native module.'
  );

  // Unlike the other local modules this surface has events, so the fallback has to stub
  // the subscription API too — a caller that only got `setArmed` would throw on mount.
  module = {
    setArmed: () => {},
    isSupported: () => false,
    addListener: () => ({ remove: () => {} }),
    removeListeners: () => {},
  } as unknown as ExpoScrollToTopNativeModule;
}

export default module;
