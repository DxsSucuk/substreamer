import Ionicons from '@react-native-vector-icons/ionicons/static';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { settingsStyles } from '../../styles/settingsStyles';
import { lyricsStore } from '../../store/lyricsStore';
import { countLyricsBySynced, type LyricsCounts } from '../../store/persistence/lyricsTable';
import { SettingsSectionTitle } from './SettingsSectionTitle';

const NO_LYRICS: LyricsCounts = { synced: 0, unsynced: 0 };

export function CachedLyricsCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();

  // The counts are a SQL aggregate, not store state; `revision` is what tells us a
  // row was added, refreshed or deleted while this card stayed mounted behind the browser.
  const revision = lyricsStore((s) => s.revision);
  const [counts, setCounts] = useState<LyricsCounts>(NO_LYRICS);

  useEffect(() => {
    let alive = true;
    countLyricsBySynced().then((next) => {
      if (alive) setCounts(next);
    });
    return () => {
      alive = false;
    };
  }, [revision]);

  return (
    <View style={settingsStyles.section}>
      <SettingsSectionTitle>{t('cachedLyrics')}</SettingsSectionTitle>
      <View style={[settingsStyles.card, settingsStyles.cardPadded, { backgroundColor: colors.card }]}>
        <View style={[settingsStyles.infoRow, { borderBottomColor: colors.border }]}>
          <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>
            {t('lyricsSynced')}
          </Text>
          <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>
            {counts.synced}
          </Text>
        </View>
        <View style={[settingsStyles.infoRow, { borderBottomColor: colors.border }]}>
          <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>
            {t('lyricsUnsynced')}
          </Text>
          <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>
            {counts.unsynced}
          </Text>
        </View>
        <Pressable
          onPress={() => router.push('/lyrics-browser')}
          style={({ pressed }) => [
            settingsStyles.navRow,
            { borderTopColor: colors.border },
            pressed && settingsStyles.pressed,
          ]}
        >
          <View style={settingsStyles.navRowLeft}>
            <Ionicons name="musical-notes-outline" size={18} color={colors.textPrimary} />
            <Text style={[settingsStyles.navRowText, { color: colors.textPrimary }]}>
              {t('browseCachedLyrics')}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
        </Pressable>
      </View>
    </View>
  );
}
