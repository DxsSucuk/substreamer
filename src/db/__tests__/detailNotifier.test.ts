/**
 * The per-entity detail-changed notifier. Its whole contract is bookkeeping —
 * per-key fan-out, isolation between keys and kinds, and an unsubscribe that
 * actually removes the listener — so the cases below are exactly the ones a
 * detail screen mounting and unmounting produces.
 */
import { bumpDetailChanged, subscribeDetailChanged } from '../detailNotifier';

describe('detailNotifier', () => {
  it('calls every subscriber of the bumped entity', () => {
    const a = jest.fn();
    const b = jest.fn();
    subscribeDetailChanged('album', 'alb-1', a);
    subscribeDetailChanged('album', 'alb-1', b);

    bumpDetailChanged('album', 'alb-1');

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for an entity nobody subscribed to', () => {
    const fn = jest.fn();
    subscribeDetailChanged('album', 'alb-1', fn);

    expect(() => bumpDetailChanged('album', 'alb-2')).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it('keys on kind as well as id — same id, different kind, different listener', () => {
    const album = jest.fn();
    const playlist = jest.fn();
    subscribeDetailChanged('album', 'x', album);
    subscribeDetailChanged('playlist', 'x', playlist);

    bumpDetailChanged('artist', 'x');
    expect(album).not.toHaveBeenCalled();
    expect(playlist).not.toHaveBeenCalled();

    bumpDetailChanged('playlist', 'x');
    expect(album).not.toHaveBeenCalled();
    expect(playlist).toHaveBeenCalledTimes(1);
  });

  it('stops calling a listener after it unsubscribes, leaving the others', () => {
    const stays = jest.fn();
    const goes = jest.fn();
    subscribeDetailChanged('artist', 'art-1', stays);
    const unsubscribe = subscribeDetailChanged('artist', 'art-1', goes);

    unsubscribe();
    bumpDetailChanged('artist', 'art-1');

    expect(stays).toHaveBeenCalledTimes(1);
    expect(goes).not.toHaveBeenCalled();
  });

  it('survives unsubscribing twice, and after the last listener has gone', () => {
    const fn = jest.fn();
    const unsubscribe = subscribeDetailChanged('playlist', 'pl-1', fn);

    unsubscribe();
    // The second call finds the key already dropped — the branch a screen
    // unmounting after a StrictMode double-effect cleanup takes.
    expect(() => unsubscribe()).not.toThrow();

    bumpDetailChanged('playlist', 'pl-1');
    expect(fn).not.toHaveBeenCalled();
  });

  it('accepts a re-subscribe on a key whose listeners were all removed', () => {
    const first = jest.fn();
    subscribeDetailChanged('album', 'alb-9', first)();

    const second = jest.fn();
    subscribeDetailChanged('album', 'alb-9', second);
    bumpDetailChanged('album', 'alb-9');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
