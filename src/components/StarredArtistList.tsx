import { useCallback, useEffect, useRef } from 'react';

import { getDb } from '../store/persistence/db';
import { favoritesStore } from '../store/favoritesStore';
import { starredArtistsPage } from '../db/repository/favorites';
import { useKeysetList } from '../hooks/useKeysetList';
import type { Cursor } from '../db/repository/core';
import type { ArtistID3 } from '../services/subsonicService';
import { ArtistListView, type ArtistLayout } from './ArtistListView';

const PAGE = 120;

export interface StarredArtistListProps {
  layout?: ArtistLayout;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  refreshing?: boolean;
  emptyMessage?: string;
  emptySubtitle?: string;
  emptyIcon?: React.ComponentProps<typeof ArtistListView>['emptyIcon'];
  contentInsetTop?: number;
}

/** The Favourites tab's artist list — see `StarredSongList` for the shape.
 *
 *  Takes no downloaded filter: artists cannot be downloaded, so the Favourites tab
 *  hides the Artists segment under that filter rather than narrowing this list. */
export function StarredArtistList({
  layout = 'list',
  loading = false,
  error = null,
  onRefresh,
  refreshing = false,
  emptyMessage,
  emptySubtitle,
  emptyIcon,
  contentInsetTop = 0,
}: StarredArtistListProps) {
  const version = favoritesStore((s) => s.version);

  const loadPage = useCallback(async (cursor: Cursor | null) => {
    const db = getDb();
    if (!db) return { rows: [] as ArtistID3[], nextCursor: null };
    const page = await starredArtistsPage(db, { cursor, limit: PAGE });
    return { rows: page.rows.map((e) => e.item), nextCursor: page.nextCursor };
  }, []);

  const { rows, initialLoading, loadMore, reload } = useKeysetList<ArtistID3>(loadPage);

  const seenVersionRef = useRef(version);
  useEffect(() => {
    if (version === seenVersionRef.current) return;
    seenVersionRef.current = version;
    reload();
  }, [version, reload]);

  return (
    <ArtistListView
      artists={rows}
      layout={layout}
      loading={initialLoading || loading}
      error={error}
      onRefresh={onRefresh}
      refreshing={refreshing}
      onEndReached={loadMore}
      emptyMessage={emptyMessage}
      emptySubtitle={emptySubtitle}
      emptyIcon={emptyIcon}
      contentInsetTop={contentInsetTop}
    />
  );
}
