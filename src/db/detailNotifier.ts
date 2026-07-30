/**
 * Tiny per-entity "detail changed" notifier — the reactivity substitute for the
 * doomed detail blob stores' Zustand subscriptions. An open detail screen reads its
 * data from the normalized tables (a one-shot repo read) and subscribes here; a
 * background mutation that rewrites that entity's normalized rows (e.g. an MBID
 * override refetch) calls `bumpDetailChanged` so the screen re-reads.
 *
 * Deliberately minimal: no payload, no state — just "entity X of kind K changed,
 * re-read it". Keyed by `kind:id`.
 */
export type DetailKind = 'album' | 'artist' | 'playlist';

const listeners = new Map<string, Set<() => void>>();
const keyFor = (kind: DetailKind, id: string): string => `${kind}:${id}`;

/** Notify subscribers that `kind:id`'s normalized detail changed → they should re-read. */
export function bumpDetailChanged(kind: DetailKind, id: string): void {
  const set = listeners.get(keyFor(kind, id));
  if (set) for (const fn of set) fn();
}

/** Subscribe to detail-changed for one entity. Returns an unsubscribe fn. */
export function subscribeDetailChanged(kind: DetailKind, id: string, fn: () => void): () => void {
  const k = keyFor(kind, id);
  let set = listeners.get(k);
  if (!set) {
    set = new Set();
    listeners.set(k, set);
  }
  set.add(fn);
  return () => {
    const s = listeners.get(k);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) listeners.delete(k);
  };
}
