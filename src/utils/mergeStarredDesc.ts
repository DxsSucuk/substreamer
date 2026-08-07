/**
 * The two halves of the favourites list — the marked library rows and the
 * `favorite_*` remainder — merged into one descending `(starred, id)` sequence.
 */

/** One favourite, carrying the raw sort key alongside the rendered entity. `starred`
 *  is epoch-ms, or 0 when the server sent no date (the entity's own `starred` is then
 *  `undefined` — absent means absent). */
export interface StarredEntry<T> {
  id: string;
  starred: number;
  item: T;
}

/**
 * Merge two arrays already sorted `starred DESC, id DESC` into one.
 *
 * No dedup, by design: the remainder query's `NOT EXISTS` clause enforces disjointness
 * at read time. A dedup here would mask a broken clause, and could not catch two copies
 * carrying different `starred` values — those sit at opposite ends of the sequence.
 *
 * The id tiebreak uses JS `<`/`>` (UTF-16 code units) to match SQLite's default BINARY
 * collation on TEXT. They agree on every BMP code point and diverge only on
 * supplementary-plane characters, which server ids do not contain in practice.
 */
export function mergeStarredDesc<T>(
  a: readonly StarredEntry<T>[],
  b: readonly StarredEntry<T>[],
): StarredEntry<T>[] {
  const out: StarredEntry<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    out.push(afterOrEqual(a[i], b[j]) ? a[i++] : b[j++]);
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

/** True when `x` sorts at or before `y` under `starred DESC, id DESC`. */
const afterOrEqual = <T>(x: StarredEntry<T>, y: StarredEntry<T>): boolean =>
  x.starred !== y.starred ? x.starred > y.starred : x.id >= y.id;
