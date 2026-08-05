import { useCallback, useEffect, useRef } from 'react';

import { getDb } from '../store/persistence/db';
import { favoritesStore } from '../store/favoritesStore';
import { starredAlbumsPage } from '../db/repository/favorites';
import { useKeysetList } from '../hooks/useKeysetList';
import type { Cursor } from '../db/repository/core';
import type { AlbumID3 } from '../services/subsonicService';
import { AlbumListView, type AlbumLayout } from './AlbumListView';

const PAGE = 120;

export interface StarredAlbumListProps {
  layout?: AlbumLayout;
  downloadedOnly: boolean;
  includePartial: boolean;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  refreshing?: boolean;
  emptyMessage?: string;
  emptySubtitle?: string;
  emptyIcon?: React.ComponentProps<typeof AlbumListView>['emptyIcon'];
  contentInsetTop?: number;
}

/** The Favourites tab's album list — see `StarredSongList` for the shape. */
export function StarredAlbumList({
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
}: StarredAlbumListProps) {
  const version = favoritesStore((s) => s.version);

  const loadPage = useCallback(
    async (cursor: Cursor | null) => {
      const db = getDb();
      if (!db) return { rows: [] as AlbumID3[], nextCursor: null };
      const page = await starredAlbumsPage(db, {
        cursor,
        limit: PAGE,
        downloadedOnly,
        includePartial,
      });
      return { rows: page.rows.map((e) => e.item), nextCursor: page.nextCursor };
    },
    [downloadedOnly, includePartial],
  );

  const { rows, initialLoading, loadMore, reload } = useKeysetList<AlbumID3>(loadPage);

  const seenVersionRef = useRef(version);
  useEffect(() => {
    if (version === seenVersionRef.current) return;
    seenVersionRef.current = version;
    reload();
  }, [version, reload]);

  return (
    <AlbumListView
      albums={rows}
      layout={layout}
      loading={initialLoading || loading}
      error={error}
      onRefresh={onRefresh}
      refreshing={refreshing}
      onEndReached={loadMore}
      emptyMessage={emptyMessage}
      emptySubtitle={emptySubtitle}
      emptyIcon={emptyIcon}
      scrollToTopTrigger={`${downloadedOnly}`}
      contentInsetTop={contentInsetTop}
    />
  );
}
