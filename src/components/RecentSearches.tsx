import Ionicons from "@react-native-vector-icons/ionicons/static";
import { useCallback } from 'react';
import {
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../hooks/useTheme';
import { recentSearchStore } from '../store/recentSearchStore';
import { searchStore } from '../store/searchStore';

interface RecentSearchesProps {
  /** Top inset so the list clears the floating search header. */
  paddingTop: number;
}

/**
 * The search screen's empty-state history: the user's recent search terms as a
 * small set of rows (leading clock, term, trailing ✕). Tapping a row re-runs
 * the search; the ✕ removes just that term. Rendered only when the query box is
 * empty AND history exists (gated by the caller).
 */
export function RecentSearches({ paddingTop }: RecentSearchesProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const recentSearches = recentSearchStore((s) => s.recentSearches);

  const select = useCallback((term: string) => {
    Keyboard.dismiss();
    // Re-run through the same store path the header uses: set the query (the
    // header input is bound to searchStore.query, so the box fills in), run the
    // search, then bump the term to the front of history.
    searchStore.getState().setQuery(term);
    void searchStore.getState().performSearch();
    recentSearchStore.getState().record(term);
  }, []);

  const remove = useCallback((term: string) => {
    recentSearchStore.getState().remove(term);
  }, []);

  const clearAll = useCallback(() => {
    recentSearchStore.getState().clear();
  }, []);

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      style={[styles.container, { paddingTop }]}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={[styles.headerTitle, { color: colors.label }]}>
            {t('recentSearches')}
          </Text>
          <Pressable onPress={clearAll} hitSlop={8}>
            <Text style={[styles.clearAll, { color: colors.primary }]}>
              {t('clearAll')}
            </Text>
          </Pressable>
        </View>

        {recentSearches.map((term) => (
          <View key={term} style={styles.row}>
            <Pressable
              style={styles.termPressable}
              onPress={() => select(term)}
              accessibilityRole="button"
              accessibilityLabel={term}
            >
              <Ionicons
                name="time-outline"
                size={20}
                color={colors.textSecondary}
                style={styles.leadingIcon}
              />
              <Text
                style={[styles.term, { color: colors.textPrimary }]}
                numberOfLines={1}
              >
                {term}
              </Text>
            </Pressable>
            <Pressable
              style={styles.removeButton}
              hitSlop={8}
              onPress={() => remove(term)}
              accessibilityRole="button"
              accessibilityLabel={t('removeRecentSearch', { term })}
            >
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingBottom: 32,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginTop: 16,
    marginBottom: 8,
  },
  headerTitle: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  clearAll: {
    fontSize: 14,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  termPressable: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
  },
  leadingIcon: {
    marginRight: 14,
  },
  term: {
    flex: 1,
    fontSize: 16,
    fontWeight: '500',
  },
  removeButton: {
    marginLeft: 12,
    paddingVertical: 12,
  },
});
