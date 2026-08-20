jest.mock('../ExpoScrollToTopModule', () => require('../__mocks__/ExpoScrollToTopModule'));

import { addStatusBarTapListener, isSupported, setArmed } from '../index';
import { mockScrollToTop } from '../__mocks__/ExpoScrollToTopModule';

beforeEach(() => mockScrollToTop.reset());

describe('expo-scroll-to-top', () => {
  it('arms and disarms interception', () => {
    setArmed(true);
    expect(mockScrollToTop.armed).toBe(true);
    setArmed(false);
    expect(mockScrollToTop.armed).toBe(false);
  });

  it('delivers a declined tap to the listener', () => {
    const onTap = jest.fn();
    addStatusBarTapListener(onTap);

    mockScrollToTop.emit();

    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('stops delivering once unsubscribed', () => {
    // The listener outliving its screen would reset a list the user is no longer looking at.
    const onTap = jest.fn();
    const unsubscribe = addStatusBarTapListener(onTap);

    unsubscribe();
    mockScrollToTop.emit();

    expect(onTap).not.toHaveBeenCalled();
  });

  it('reports whether interception is actually in place', () => {
    // False on Android, and on any iOS build where the RN internals moved — callers fall
    // back to stock scroll-to-top rather than silently doing nothing.
    expect(isSupported()).toBe(true);
    mockScrollToTop.supported = false;
    expect(isSupported()).toBe(false);
  });
});
