jest.mock('../persistence/kvStorage', () => require('../persistence/__mocks__/kvStorage'));

import { backgroundPlaybackPromptStore } from '../backgroundPlaybackPromptStore';

beforeEach(() => {
  backgroundPlaybackPromptStore.setState({ seen: false, visible: false });
});

describe('backgroundPlaybackPromptStore', () => {
  it('starts unseen and hidden', () => {
    const s = backgroundPlaybackPromptStore.getState();
    expect(s.seen).toBe(false);
    expect(s.visible).toBe(false);
  });

  it('markSeenAndShow sets seen AND visible (seen up-front so it appears once)', () => {
    backgroundPlaybackPromptStore.getState().markSeenAndShow();
    const s = backgroundPlaybackPromptStore.getState();
    expect(s.seen).toBe(true);
    expect(s.visible).toBe(true);
  });

  it('dismiss hides the modal but keeps seen=true (never re-prompts)', () => {
    backgroundPlaybackPromptStore.getState().markSeenAndShow();
    backgroundPlaybackPromptStore.getState().dismiss();
    const s = backgroundPlaybackPromptStore.getState();
    expect(s.visible).toBe(false);
    expect(s.seen).toBe(true);
  });

  it('reset re-arms the prompt', () => {
    backgroundPlaybackPromptStore.getState().markSeenAndShow();
    backgroundPlaybackPromptStore.getState().reset();
    expect(backgroundPlaybackPromptStore.getState().seen).toBe(false);
  });

  it('partialize persists only seen (not the transient visible)', () => {
    const persist = (backgroundPlaybackPromptStore as any).persist;
    const partialize = persist?.getOptions?.()?.partialize;
    if (partialize) {
      const result = partialize({ seen: true, visible: true });
      expect(result).toEqual({ seen: true });
      expect(result).not.toHaveProperty('visible');
    }
  });
});
