jest.mock('../persistence/kvStorage', () => require('../persistence/__mocks__/kvStorage'));

import { bookmarksStore, type PlayQueueBookmark } from '../bookmarksStore';

function makeBookmark(id: string, name = id, createdAt = 1): PlayQueueBookmark {
  return {
    id,
    name,
    createdAt,
    queue: [{ id: 't1', title: 'Track', isDir: false } as any],
    currentIndex: 0,
    positionSec: 0,
  };
}

beforeEach(() => {
  bookmarksStore.setState({ bookmarks: {}, autoName: true, sortOrder: 'newest' });
});

describe('bookmarksStore', () => {
  describe('addBookmark / removeBookmark / renameBookmark', () => {
    it('adds a bookmark keyed by id', () => {
      bookmarksStore.getState().addBookmark(makeBookmark('b1', 'First'));
      expect(bookmarksStore.getState().bookmarks.b1.name).toBe('First');
    });

    it('removes a bookmark by id without touching others', () => {
      bookmarksStore.getState().addBookmark(makeBookmark('b1'));
      bookmarksStore.getState().addBookmark(makeBookmark('b2'));
      bookmarksStore.getState().removeBookmark('b1');
      expect(bookmarksStore.getState().bookmarks.b1).toBeUndefined();
      expect(bookmarksStore.getState().bookmarks.b2).toBeDefined();
    });

    it('renames an existing bookmark', () => {
      bookmarksStore.getState().addBookmark(makeBookmark('b1', 'Old'));
      bookmarksStore.getState().renameBookmark('b1', 'New');
      expect(bookmarksStore.getState().bookmarks.b1.name).toBe('New');
    });

    it('renaming a non-existent bookmark is a no-op', () => {
      bookmarksStore.getState().renameBookmark('nope', 'X');
      expect(bookmarksStore.getState().bookmarks).toEqual({});
    });
  });

  describe('preferences', () => {
    it('toggles autoName', () => {
      bookmarksStore.getState().setAutoName(false);
      expect(bookmarksStore.getState().autoName).toBe(false);
    });

    it('sets sort order', () => {
      bookmarksStore.getState().setSortOrder('oldest');
      expect(bookmarksStore.getState().sortOrder).toBe('oldest');
    });
  });

  describe('persistence config', () => {
    it('has the correct persist key', () => {
      const persistOptions = (bookmarksStore as any).persist;
      expect(persistOptions.getOptions().name).toBe('substreamer-bookmarks');
    });

    it('partializes to persist data + prefs but exclude actions', () => {
      bookmarksStore.getState().addBookmark(makeBookmark('b1'));
      const persistOptions = (bookmarksStore as any).persist;
      const partialized = persistOptions.getOptions().partialize(bookmarksStore.getState());
      expect(partialized).toHaveProperty('bookmarks');
      expect(partialized).toHaveProperty('autoName');
      expect(partialized).toHaveProperty('sortOrder');
      expect(partialized).not.toHaveProperty('addBookmark');
      expect(partialized).not.toHaveProperty('mergeBookmarks');
    });

    it('drops the bookmarks blob once the rows are authoritative, keeping the prefs', () => {
      bookmarksStore.getState().addBookmark(makeBookmark('b1'));
      bookmarksStore.setState({ sqlAuthoritative: true });
      const partialized = (bookmarksStore as any).persist
        .getOptions()
        .partialize(bookmarksStore.getState());
      expect(partialized).not.toHaveProperty('bookmarks');
      expect(partialized).toHaveProperty('autoName');
      expect(partialized).toHaveProperty('sortOrder');
    });
  });

  describe('mergeBookmarks', () => {
    it('unions disjoint ids', () => {
      bookmarksStore.getState().addBookmark(makeBookmark('b1', 'Local'));
      const result = bookmarksStore.getState().mergeBookmarks({
        b2: makeBookmark('b2', 'Incoming'),
      });
      expect(result).toEqual({ added: 1, skipped: 0 });
      expect(bookmarksStore.getState().bookmarks.b1.name).toBe('Local');
      expect(bookmarksStore.getState().bookmarks.b2.name).toBe('Incoming');
    });

    it('keeps the local entry on id conflict (existing-wins)', () => {
      bookmarksStore.getState().addBookmark(makeBookmark('b1', 'Local'));
      const result = bookmarksStore.getState().mergeBookmarks({
        b1: makeBookmark('b1', 'Backup'),
      });
      expect(result).toEqual({ added: 0, skipped: 1 });
      expect(bookmarksStore.getState().bookmarks.b1.name).toBe('Local');
    });

    it('skips invalid entries (missing id or queue)', () => {
      const result = bookmarksStore.getState().mergeBookmarks({
        bad1: null as any,
        bad2: { id: '', name: 'no id', queue: [], currentIndex: 0, positionSec: 0 } as any,
        bad3: { id: 'b3', name: 'no queue', currentIndex: 0, positionSec: 0 } as any,
      });
      expect(result).toEqual({ added: 0, skipped: 3 });
    });
  });
});
