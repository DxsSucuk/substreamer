/**
 * Dependency-free mirror of `serverInfoStore.ignoredArticles`, so the db /
 * persistence layer can read the effective ignored-article list WITHOUT importing a
 * store. Importing `serverInfoStore` from here (or from the modules that build sort
 * keys) creates a require cycle: persistence/index → detailTables →
 * normalizedSyncWriter → serverInfoStore → persistence/index. This module imports
 * nothing, so it can't participate in a cycle.
 *
 * `serverInfoStore` is the single writer: it calls `setSortArticles` on every
 * `ignoredArticles` change and on rehydrate. Readers get `undefined` until then —
 * `getSortKey` treats `undefined` as "use the local DEFAULT_IGNORED_ARTICLES", which
 * is the correct fallback anyway.
 */
let current: readonly string[] | undefined;

/** Called by serverInfoStore when its ignoredArticles changes / rehydrates. */
export const setSortArticles = (articles: readonly string[] | null | undefined): void => {
  current = articles ?? undefined;
};

/** The article list to pass to `getSortKey` when building DB sort keys. */
export const getSortArticles = (): readonly string[] | undefined => current;
