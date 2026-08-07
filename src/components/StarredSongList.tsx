import { useCallback, useEffect, useRef, type ReactNode } from 'react';

import { getDb } from '../store/persistence/db';
import { favoritesStore } from '../store/favoritesStore';
import { musicCacheStore } from '../store/musicCacheStore';
import { listAllStarredSongs, starredSongsPage } from '../db/repository/favorites';
import { useKeysetList } from '../hooks/useKeysetList';
import { playTrack } from '../services/playerService';
import type { Cursor } from '../db/repository/core';
import type { Child } from '../services/subsonicService';
import { SongListView, type SongLayout } from './SongListView';

const PAGE = 120;

export interface StarredSongListProps {
  layout?: SongLayout;
  downloadedOnly: boolean;
  includePartial: boolean;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  refreshing?: boolean;
  emptyMessage?: string;
  emptySubtitle?: string;
  emptyIcon?: React.ComponentProps<typeof SongListView>['emptyIcon'];
  contentInsetTop?: number;
  listHeaderExtra?: ReactNode;
}

/**
 * The Favourites tab's song list — bounded keyset pages over the marked `songs` rows
 * merged with the `favorite_songs` remainder, newest favourite first.
 *
 * No alphabet scroller: the order is "when you starred it", so an A–Z scroller over it
 * would be meaningless (and the tab never had one).
 */
export function StarredSongList({
  layout = 'list',
  downloadedOnly,
  includePartial,
  loading = false,
  error = null,
  onRefresh,
  refreshing = false,
  emptyMessage,
  emptySubtitle,
  emptyIcon,
  contentInsetTop = 0,
  listHeaderExtra,
}: StarredSongListProps) {
  const version = favoritesStore((s) => s.version);
  // `revision` is the download tables' change signal. This list reads download state
  // (`downloadedOnly` narrows the SQL), and SQL has no Zustand subscription, so without
  // it a download completing under the user leaves the list showing the rows it fetched
  // when nothing was downloaded — until the app restarts.
  const revision = musicCacheStore((s) => s.revision);

  const loadPage = useCallback(
    async (cursor: Cursor | null) => {
      const db = getDb();
      if (!db) return { rows: [] as Child[], nextCursor: null };
      const page = await starredSongsPage(db, {
        cursor,
        limit: PAGE,
        downloadedOnly,
        includePartial,
      });
      return { rows: page.rows.map((e) => e.item), nextCursor: page.nextCursor };
    },
    [downloadedOnly, includePartial],
  );

  const { rows, initialLoading, loadMore, reload } = useKeysetList<Child>(loadPage);

  // Repaint when the starred set OR the downloaded set changes. Skip the values seen at
  // mount so this never double-loads the first page.
  const seenRef = useRef(`${version}:${revision}`);
  const changeKey = `${version}:${revision}`;
  useEffect(() => {
    if (changeKey === seenRef.current) return;
    seenRef.current = changeKey;
    reload();
  }, [changeKey, reload]);

  // Tapping a track queues the WHOLE favourites list, as it always has — the loaded
  // keyset window is not the queue. Fetched at press time, O(favourites).
  const handleSongPress = useCallback(
    (song: Child) => {
      void (async () => {
        const db = getDb();
        const list = db ? await listAllStarredSongs(db, { downloadedOnly, includePartial }) : [];
        const i = list.findIndex((s) => s.id === song.id);
        if (i < 0) {
          void playTrack(song, [song]);
          return;
        }
        void playTrack(list[i], list);
      })();
    },
    [downloadedOnly, includePartial],
  );

  return (
    <SongListView
      songs={rows}
      layout={layout}
      loading={initialLoading || loading}
      error={error}
      onRefresh={onRefresh}
      refreshing={refreshing}
      onEndReached={loadMore}
      onSongPress={handleSongPress}
      emptyMessage={emptyMessage}
      emptySubtitle={emptySubtitle}
      emptyIcon={emptyIcon}
      scrollToTopTrigger={`${downloadedOnly}`}
      contentInsetTop={contentInsetTop}
      listHeaderExtra={listHeaderExtra}
    />
  );
}
