const listeners = new Set<() => void>();

/** Test double for the native module. `emit` stands in for a status-bar tap. */
export const mockScrollToTop = {
  armed: false,
  supported: true,
  emit: (): void => listeners.forEach((l) => l()),
  reset: (): void => {
    listeners.clear();
    mockScrollToTop.armed = false;
    mockScrollToTop.supported = true;
  },
};

export default {
  setArmed: (armed: boolean): void => {
    mockScrollToTop.armed = armed;
  },
  isSupported: (): boolean => mockScrollToTop.supported,
  addListener: (_event: string, listener: () => void) => {
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  },
  removeListeners: (): void => {},
};
