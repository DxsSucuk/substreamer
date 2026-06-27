/**
 * Bump an entity's local play stats — increment `playCount` and stamp
 * `played` with `now`. Used by the optimistic `applyLocalPlay` store paths so
 * the UI reflects a just-scrobbled play before the server round-trip.
 */
export function bumpPlayStats<T extends { playCount?: number; played?: string }>(
  entity: T,
  now: string,
): T {
  return { ...entity, playCount: (entity.playCount ?? 0) + 1, played: now };
}
