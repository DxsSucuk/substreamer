/**
 * Merge `incoming` into `target` with existing-wins semantics: an id already
 * present in `target` is skipped (never overwritten), and entries failing
 * `isValid` are skipped. Mutates `target`; returns {added, skipped}. Used by
 * the backup-restore merge paths, where `isValid` is the per-store validator
 * for untrusted (imported) data.
 */
export function mergeExistingWins<T>(
  target: Record<string, T>,
  incoming: Record<string, T> | undefined,
  isValid: (value: T) => boolean,
): { added: number; skipped: number } {
  let added = 0;
  let skipped = 0;
  if (!incoming) return { added, skipped };
  for (const [id, value] of Object.entries(incoming)) {
    if (!isValid(value)) {
      skipped++;
      continue;
    }
    if (id in target) {
      skipped++;
      continue;
    }
    target[id] = value;
    added++;
  }
  return { added, skipped };
}
