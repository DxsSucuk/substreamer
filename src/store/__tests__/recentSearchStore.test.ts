jest.mock('../persistence/kvStorage', () => require('../persistence/__mocks__/kvStorage'));

import { MAX_RECENT_SEARCHES, recentSearchStore } from '../recentSearchStore';

beforeEach(() => {
  recentSearchStore.setState({ recentSearches: [] });
});

const terms = () => recentSearchStore.getState().recentSearches;

describe('recentSearchStore', () => {
  it('records a term', () => {
    recentSearchStore.getState().record('pink floyd');
    expect(terms()).toEqual(['pink floyd']);
  });

  it('trims whitespace and ignores empty/whitespace-only terms', () => {
    recentSearchStore.getState().record('  miles davis  ');
    recentSearchStore.getState().record('   ');
    recentSearchStore.getState().record('');
    expect(terms()).toEqual(['miles davis']);
  });

  it('newest term goes to the front', () => {
    recentSearchStore.getState().record('a');
    recentSearchStore.getState().record('b');
    expect(terms()).toEqual(['b', 'a']);
  });

  it('dedupes case-insensitively and moves the match to the front (keeping newest casing)', () => {
    recentSearchStore.getState().record('Radiohead');
    recentSearchStore.getState().record('miles davis');
    recentSearchStore.getState().record('RADIOHEAD');
    expect(terms()).toEqual(['RADIOHEAD', 'miles davis']);
  });

  it('caps the list at MAX_RECENT_SEARCHES', () => {
    for (let i = 0; i < MAX_RECENT_SEARCHES + 5; i++) {
      recentSearchStore.getState().record(`term ${i}`);
    }
    const list = terms();
    expect(list).toHaveLength(MAX_RECENT_SEARCHES);
    // Newest first: the last recorded term is at the front.
    expect(list[0]).toBe(`term ${MAX_RECENT_SEARCHES + 4}`);
  });

  it('removes a single term by exact match', () => {
    recentSearchStore.getState().record('a');
    recentSearchStore.getState().record('b');
    recentSearchStore.getState().remove('a');
    expect(terms()).toEqual(['b']);
  });

  it('clear empties the whole history', () => {
    recentSearchStore.getState().record('a');
    recentSearchStore.getState().record('b');
    recentSearchStore.getState().clear();
    expect(terms()).toEqual([]);
  });

  it('produces a new array reference on mutation (so selectors fire)', () => {
    recentSearchStore.getState().record('a');
    const first = terms();
    recentSearchStore.getState().record('b');
    expect(terms()).not.toBe(first);
  });
});
