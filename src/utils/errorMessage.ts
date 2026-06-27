/**
 * Coerce an unknown caught value to a human-readable message string.
 * `catch (e)` gives `unknown`; this is the standard `e.message`-or-`String(e)`
 * narrowing used at every logging/error-surfacing site.
 */
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
