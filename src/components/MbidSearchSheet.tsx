import Ionicons from "@react-native-vector-icons/ionicons/static";
import { FlashList } from '@shopify/flash-list';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { BottomSheet } from './BottomSheet';
import { CachedImage } from './CachedImage';
import { useTheme } from '../hooks/useTheme';
import {
  searchArtists,
  searchReleaseGroups,
  type MusicBrainzArtist,
  type MusicBrainzReleaseGroup,
} from '../services/musicbrainzService';
import { albumInfoStore } from '../store/albumInfoStore';
import { artistDetailStore } from '../store/artistDetailStore';
import { mbidOverrideStore } from '../store/mbidOverrideStore';
import { mbidSearchStore } from '../store/mbidSearchStore';
import { processingOverlayStore } from '../store/processingOverlayStore';

const ROW_HEIGHT = 80;
const DEBOUNCE_MS = 400;

/* ------------------------------------------------------------------ */
/*  Unified result type                                                */
/* ------------------------------------------------------------------ */

interface SearchResult {
  id: string;
  name: string;
  meta: string[];
  disambiguation?: string;
}

function artistToResult(a: MusicBrainzArtist): SearchResult {
  const meta: string[] = [];
  if (a.type) meta.push(a.type);
  if (a.country) meta.push(a.country);
  if (a.score != null) meta.push(`${a.score}%`);
  return { id: a.id, name: a.name, meta, disambiguation: a.disambiguation };
}

function releaseGroupToResult(rg: MusicBrainzReleaseGroup): SearchResult {
  const meta: string[] = [];
  if (rg['primary-type']) meta.push(rg['primary-type']);
  if (rg['first-release-date']) meta.push(rg['first-release-date'].slice(0, 4));
  const artistCredit = rg['artist-credit'];
  if (artistCredit && artistCredit.length > 0) {
    meta.push(artistCredit.map((ac) => ac.name).join(', '));
  }
  if (rg.score != null) meta.push(`${rg.score}%`);
  return { id: rg.id, name: rg.title, meta };
}

/* ------------------------------------------------------------------ */
/*  Result row                                                         */
/* ------------------------------------------------------------------ */

const ResultRow = memo(function ResultRow({
  result,
  isCurrentMbid,
  onSelect,
  colors,
}: {
  result: SearchResult;
  isCurrentMbid: boolean;
  onSelect: (result: SearchResult) => void;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelect(result), [result, onSelect]);

  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: colors.border },
        isCurrentMbid && { borderLeftColor: colors.primary, borderLeftWidth: 3 },
        pressed && styles.rowPressed,
      ]}
    >
      <View style={styles.rowContent}>
        <View style={styles.rowHeader}>
          <Text
            style={[
              styles.entityName,
              { color: colors.textPrimary },
              isCurrentMbid && { color: colors.primary },
            ]}
            numberOfLines={1}
          >
            {result.name}
          </Text>
          {isCurrentMbid && (
            <View style={[styles.currentBadge, { backgroundColor: colors.primary }]}>
              <Text style={styles.currentBadgeText}>{t('current')}</Text>
            </View>
          )}
        </View>
        {result.disambiguation ? (
          <Text style={[styles.disambiguation, { color: colors.textSecondary }]} numberOfLines={1}>
            {result.disambiguation}
          </Text>
        ) : null}
        <View style={styles.rowMeta}>
          <Text style={[styles.mbid, { color: colors.textSecondary }]} numberOfLines={1}>
            {result.id}
          </Text>
          {result.meta.length > 0 && (
            <Text style={[styles.metaText, { color: colors.textSecondary }]}>
              {result.meta.join(' \u00b7 ')}
            </Text>
          )}
        </View>
      </View>
    </Pressable>
  );
});

/* ------------------------------------------------------------------ */
/*  Main sheet                                                         */
/* ------------------------------------------------------------------ */

export function MbidSearchSheet() {
  const visible = mbidSearchStore((s) => s.visible);
  const entityType = mbidSearchStore((s) => s.entityType);
  const entityId = mbidSearchStore((s) => s.entityId);
  const entityName = mbidSearchStore((s) => s.entityName);
  const artistName = mbidSearchStore((s) => s.artistName);
  const currentMbid = mbidSearchStore((s) => s.currentMbid);
  const coverArtId = mbidSearchStore((s) => s.coverArtId);
  const hide = mbidSearchStore((s) => s.hide);

  const { colors } = useTheme();
  const { t } = useTranslation();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isArtist = entityType === 'artist';

  // Auto-search on open
  useEffect(() => {
    if (!visible || !entityName) return undefined;

    setQuery(entityName);
    setSearched(false);
    setResults([]);
    setLoading(true);

    const timer = setTimeout(async () => {
      if (isArtist) {
        const data = await searchArtists(entityName);
        setResults(data.map(artistToResult));
      } else {
        const data = await searchReleaseGroups(entityName, artistName ?? undefined);
        setResults(data.map(releaseGroupToResult));
      }
      setLoading(false);
      setSearched(true);
    }, 100);

    return () => clearTimeout(timer);
  }, [visible, entityName, artistName, isArtist]);

  const handleQueryChange = useCallback((text: string) => {
    setQuery(text);

    if (timerRef.current) clearTimeout(timerRef.current);

    const trimmed = text.trim();
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      setSearched(false);
      return;
    }

    setLoading(true);
    timerRef.current = setTimeout(async () => {
      const storeState = mbidSearchStore.getState();
      if (storeState.entityType === 'artist') {
        const data = await searchArtists(trimmed);
        setResults(data.map(artistToResult));
      } else {
        const data = await searchReleaseGroups(trimmed, storeState.artistName ?? undefined);
        setResults(data.map(releaseGroupToResult));
      }
      setLoading(false);
      setSearched(true);
    }, DEBOUNCE_MS);
  }, []);

  const handleSelect = useCallback(
    async (result: SearchResult) => {
      if (!entityId) return;
      const storeState = mbidSearchStore.getState();
      const type = storeState.entityType;
      const name = storeState.entityName ?? result.name;
      mbidOverrideStore.getState().setOverride(type, entityId, name, result.id);
      hide();

      if (type === 'artist') {
        processingOverlayStore.getState().show(t('updatingArtist'));
        try {
          await artistDetailStore.getState().fetchArtist(entityId);
          processingOverlayStore.getState().showSuccess(t('mbidOverrideSaved'));
        } catch {
          processingOverlayStore.getState().showError(t('failedToUpdateArtist'));
        }
      } else {
        processingOverlayStore.getState().show(t('updatingAlbum'));
        try {
          await albumInfoStore.getState().fetchAlbumInfo(entityId);
          processingOverlayStore.getState().showSuccess(t('mbidOverrideSaved'));
        } catch {
          processingOverlayStore.getState().showError(t('failedToUpdateAlbum'));
        }
      }
    },
    [entityId, hide],
  );

  const handleClose = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setQuery('');
    setResults([]);
    setLoading(false);
    setSearched(false);
    hide();
  }, [hide]);

  const renderItem = useCallback(
    ({ item }: { item: SearchResult }) => (
      <ResultRow
        result={item}
        isCurrentMbid={item.id === currentMbid}
        onSelect={handleSelect}
        colors={colors}
      />
    ),
    [currentMbid, handleSelect, colors],
  );

  const keyExtractor = useCallback((item: SearchResult) => item.id, []);

  const dynamicStyles = useMemo(
    () =>
      StyleSheet.create({
        input: {
          backgroundColor: colors.inputBg,
          color: colors.textPrimary,
          borderColor: colors.border,
        },
      }),
    [colors],
  );

  const entityLabel = isArtist ? t('artist').toLowerCase() : t('album').toLowerCase();
  const emptyLabel = isArtist ? t('noArtistsFound') : t('noAlbumsFound');

  return (
    <BottomSheet visible={visible} onClose={handleClose} maxHeight="80%" scrollable={false}>
      <View style={styles.header}>
        {coverArtId && (
          <CachedImage coverArtId={coverArtId} size={150} style={styles.coverArt} resizeMode="cover" />
        )}
        <View style={styles.headerText}>
          <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
            {t('setMusicBrainzId')}
          </Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]} numberOfLines={1}>
            {entityName ?? t('searchForEntity', { type: entityLabel })}
          </Text>
        </View>
      </View>

        <View style={styles.searchRow}>
          <Ionicons name="search-outline" size={18} color={colors.textSecondary} />
          <TextInput
            style={[styles.input, dynamicStyles.input]}
            value={query}
            onChangeText={handleQueryChange}
            placeholder={isArtist ? t('searchMusicBrainzArtists') : t('searchMusicBrainzAlbums')}
            placeholderTextColor={colors.textSecondary}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
          />
          {query.length > 0 && (
            <Pressable onPress={() => handleQueryChange('')} hitSlop={8}>
              <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
            </Pressable>
          )}
        </View>

        <View style={styles.listContainer}>
          {loading ? (
            <View style={styles.centered}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.loadingText, { color: colors.textSecondary }]}>
                {t('searchingMusicBrainz')}
              </Text>
            </View>
          ) : results.length === 0 && searched ? (
            <View style={styles.centered}>
              <Ionicons name="search-outline" size={32} color={colors.textSecondary} />
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                {emptyLabel}
              </Text>
            </View>
          ) : results.length > 0 ? (
            <FlashList
              data={results}
              renderItem={renderItem}
              keyExtractor={keyExtractor}
              keyboardShouldPersistTaps="handled"
            />
          ) : null}
        </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    marginBottom: 12,
  },
  coverArt: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: 'rgba(128,128,128,0.12)',
    marginRight: 12,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 14,
    fontWeight: '400',
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  input: {
    flex: 1,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  listContainer: {
    flexShrink: 1,
    minHeight: 200,
  },
  row: {
    minHeight: ROW_HEIGHT,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
  },
  rowPressed: {
    opacity: 0.6,
  },
  rowContent: {
    gap: 4,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  entityName: {
    fontSize: 16,
    fontWeight: '600',
    flexShrink: 1,
  },
  currentBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  currentBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  disambiguation: {
    fontSize: 14,
    fontStyle: 'italic',
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  mbid: {
    fontSize: 12,
    fontFamily: 'monospace',
    flexShrink: 1,
  },
  metaText: {
    fontSize: 12,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
  },
  emptyText: {
    fontSize: 14,
  },
});
