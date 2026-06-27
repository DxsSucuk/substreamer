import { create } from 'zustand';

import { type BookmarkSnapshot } from '../services/bookmarkService';

/**
 * Drives the shared `BookmarkNameSheet` (mounted once at the root layout).
 * `create` mode prompts for a name before saving a new bookmark (used when
 * the "Autoname bookmarks" setting is off); `rename` mode edits an existing
 * bookmark's name.
 */
type BookmarkSheetMode = 'create' | 'rename';

interface BookmarkSheetState {
  visible: boolean;
  mode: BookmarkSheetMode;
  /** Target bookmark id for `rename` mode; null for `create`. */
  bookmarkId: string | null;
  /** Prefill value: suggested auto-name (create) or current name (rename). */
  initialName: string;
  /**
   * Player snapshot captured when the user tapped the bookmark button. Carried
   * through `create` so the saved bookmark reflects that moment, not whenever
   * the user finishes typing. Null in `rename` mode.
   */
  snapshot: BookmarkSnapshot | null;

  showCreate: (suggestedName: string, snapshot: BookmarkSnapshot) => void;
  showRename: (bookmarkId: string, currentName: string) => void;
  hide: () => void;
}

export const bookmarkSheetStore = create<BookmarkSheetState>()((set) => ({
  visible: false,
  mode: 'create',
  bookmarkId: null,
  initialName: '',
  snapshot: null,

  showCreate: (initialName, snapshot) =>
    set({ visible: true, mode: 'create', bookmarkId: null, initialName, snapshot }),
  showRename: (bookmarkId, initialName) =>
    set({ visible: true, mode: 'rename', bookmarkId, initialName, snapshot: null }),
  hide: () => set({ visible: false }),
}));
