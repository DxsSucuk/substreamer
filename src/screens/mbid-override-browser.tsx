import { HeaderHeightContext } from "expo-router/react-navigation";
import { FlashList } from '@shopify/flash-list';
import Ionicons from "@react-native-vector-icons/ionicons/static";
import { memo, useCallback, useContext, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '../components/EmptyState';
import { GradientBackground } from '../components/GradientBackground';
import { BottomChrome } from '../components/BottomChrome';
import { SegmentControl, type Segment } from '../components/SegmentControl';
import { SwipeableRow, type SwipeAction } from '../components/SwipeableRow';
import { useTheme } from '../hooks/useTheme';
import { defaultCollator } from '../utils/intl';
import { getAlbumInfoRow } from '../db/repository/albums';
import { getArtistBioRow } from '../db/repository/details';
import { fetchArtistBio } from '../services/detailFetchService';
import { getDb } from '../store/persistence/db';
import { albumInfoStore } from '../store/albumInfoStore';
import { mbidOverrideStore, type MbidOverride, type MbidOverrideType } from '../store/mbidOverrideStore';
import { mbidSearchStore } from '../store/mbidSearchStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { runWithOverlay } from '../store/processingOverlayStore';

const ROW_HEIGHT = 72;

/* ------------------------------------------------------------------ */
/*  Row                                                                */
/* ------------------------------------------------------------------ */

const OverrideRow = memo(function OverrideRow({
  override,
  offlineMode,
  colors,
}: {
  override: MbidOverride;
  offlineMode: boolean;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    if (offlineMode) return;
    if (override.type === 'artist') {
      mbidSearchStore
        .getState()
        .showArtist(override.entityId, override.entityName, override.mbid);
    } else {
      mbidSearchStore
        .getState()
        .showAlbum(override.entityId, override.entityName, null, override.mbid);
    }
  }, [override, offlineMode]);

  const handleDelete = useCallback(async () => {
    const { type, entityId } = override;
    mbidOverrideStore.getState().removeOverride(type, entityId);
    const db = getDb();
    // Only refetch what we actually hold: dropping an override changes the resolved bio /
    // album info, so there is nothing to correct for an entity we never fetched detail for.
    if (type === 'artist' && db) {
      // A bio row exists iff we have attempted this artist — nothing to correct otherwise.
      if (!(await getArtistBioRow(db, entityId))) return;
      // `reresolve`: the override just changed, so the resolution has to be redone even
      // though we already hold a bio.
      await runWithOverlay(() => fetchArtistBio(entityId, { reresolve: true }), {
        loading: t('updatingArtist'),
        success: t('artistUpdated'),
        error: t('failedToUpdateArtist'),
      });
    } else if (type === 'album' && db && (await getAlbumInfoRow(db, entityId)) != null) {
      await runWithOverlay(() => albumInfoStore.getState().fetchAlbumInfo(entityId), {
        loading: t('updatingAlbum'),
        success: t('albumUpdated'),
        error: t('failedToUpdateAlbum'),
      });
    }
  }, [override]);

  const rightActions: SwipeAction[] = useMemo(
    () => [
      {
        icon: 'trash-outline' as const,
        color: colors.red,
        label: t('delete'),
        onPress: handleDelete,
        removesRow: true,
      },
    ],
    [colors.red, handleDelete, t],
  );

  return (
    <View style={styles.rowWrapper}>
      <SwipeableRow
        rightActions={rightActions}
        enableFullSwipeRight
        onPress={handlePress}
        borderRadius={12}
      >
        <View style={styles.row}>
          <View style={styles.rowContent}>
            <Text style={[styles.entityName, { color: colors.textPrimary }]} numberOfLines={1}>
              {override.entityName}
            </Text>
            <View style={styles.mbidRow}>
              <Ionicons name="finger-print-outline" size={14} color={colors.primary} />
              <Text style={[styles.mbid, { color: colors.textSecondary }]} numberOfLines={1}>
                {override.mbid}
              </Text>
            </View>
          </View>
        </View>
      </SwipeableRow>
    </View>
  );
});

/* ------------------------------------------------------------------ */
/*  Screen                                                             */
/* ------------------------------------------------------------------ */

export function MbidOverrideBrowserScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const overrides = mbidOverrideStore((s) => s.overrides);
  const offlineMode = offlineModeStore((s) => s.offlineMode);
  const [selectedType, setSelectedType] = useState<MbidOverrideType>('artist');

  const segments = useMemo<Segment<MbidOverrideType>[]>(
    () => [
      { key: 'artist', label: t('artists') },
      { key: 'album', label: t('albums') },
    ],
    [t],
  );

  const allEntries = useMemo(() => Object.values(overrides), [overrides]);

  const data = useMemo(
    () =>
      allEntries
        .filter((o) => o.type === selectedType)
        .sort((a, b) => defaultCollator.compare(a.entityName, b.entityName)),
    [allEntries, selectedType],
  );

  const renderItem = useCallback(
    ({ item }: { item: MbidOverride }) => (
      <OverrideRow override={item} offlineMode={offlineMode} colors={colors} />
    ),
    [colors, offlineMode],
  );

  const keyExtractor = useCallback((item: MbidOverride) => `${item.type}:${item.entityId}`, []);

  const contentContainerStyle = useMemo(
    () => ({ paddingTop: headerHeight, paddingBottom: 32 }),
    [headerHeight],
  );

  return (
    <GradientBackground style={styles.container} scrollable>
      <FlashList
        data={data}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        ListHeaderComponent={
          <View style={styles.segmentWrapper}>
            <SegmentControl segments={segments} selected={selectedType} onSelect={setSelectedType} />
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            icon="finger-print-outline"
            title={selectedType === 'artist' ? t('noArtistOverrides') : t('noAlbumOverrides')}
            subtitle={selectedType === 'artist' ? t('artistOverridesAppearHere') : t('albumOverridesAppearHere')}
          />
        }
        contentContainerStyle={contentContainerStyle}
      />
      <BottomChrome withSafeAreaPadding />
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  segmentWrapper: {
    paddingBottom: 12,
  },
  rowWrapper: {
    marginHorizontal: 16,
    marginBottom: 10,
  },
  row: {
    minHeight: ROW_HEIGHT,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    justifyContent: 'center',
  },
  rowContent: {
    gap: 4,
  },
  entityName: {
    fontSize: 16,
    fontWeight: '600',
  },
  mbidRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  mbid: {
    fontSize: 12,
    fontFamily: 'monospace',
    flexShrink: 1,
  },
});
