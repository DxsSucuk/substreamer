import { isOverlayOpen, overlayStore } from '../overlayStore';

beforeEach(() => overlayStore.setState({ count: 0 }));

describe('overlayStore', () => {
  it('reports nothing covering the screen by default', () => {
    expect(isOverlayOpen()).toBe(false);
  });

  it('counts rather than flags, so stacked sheets do not uncover each other', () => {
    // One sheet closing while another is still up must not hand screen-level input back
    // to the content underneath both.
    overlayStore.getState().open();
    overlayStore.getState().open();
    overlayStore.getState().close();

    expect(isOverlayOpen()).toBe(true);

    overlayStore.getState().close();
    expect(isOverlayOpen()).toBe(false);
  });

  it('never goes negative on an unbalanced close', () => {
    // A stray close would otherwise make the next open a no-op and silently break the gate.
    overlayStore.getState().close();
    overlayStore.getState().open();

    expect(isOverlayOpen()).toBe(true);
  });
});
