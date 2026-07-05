import Ionicons from '@react-native-vector-icons/ionicons/static';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { settingsStyles } from '../../styles/settingsStyles';
import { completedScrobbleStore } from '../../store/completedScrobbleStore';
import { pendingScrobbleStore } from '../../store/pendingScrobbleStore';
import { scrobbleExclusionStore } from '../../store/scrobbleExclusionStore';
import {
  playbackSettingsStore,
  SCROBBLE_MILESTONES,
  type ScrobbleTrigger,
} from '../../store/playbackSettingsStore';
import { SettingsSectionTitle } from './SettingsSectionTitle';

export function ListeningHistoryCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [triggerSheetVisible, setTriggerSheetVisible] = useState(false);

  const pendingScrobbleCount = pendingScrobbleStore((s) => s.pendingScrobbles.length);
  const completedScrobbleCount = completedScrobbleStore((s) => s.completedScrobbles.length);
  const scrobbleExclusionCount = scrobbleExclusionStore((s) =>
    Object.keys(s.excludedAlbums).length +
    Object.keys(s.excludedArtists).length +
    Object.keys(s.excludedPlaylists).length,
  );
  const scrobbleTrigger = playbackSettingsStore((s) => s.scrobbleTrigger);
  const setScrobbleTrigger = playbackSettingsStore((s) => s.setScrobbleTrigger);

  const triggerLabel = (v: ScrobbleTrigger) =>
    v === 100 ? t('scrobbleAfterOnFinish') : t('scrobbleAfterPercent', { percent: v });

  return (
    <>
      <View style={settingsStyles.section}>
        <SettingsSectionTitle>{t('listeningHistory')}</SettingsSectionTitle>
        <View style={[settingsStyles.card, settingsStyles.cardPadded, { backgroundColor: colors.card }]}>
          <Pressable
            onPress={() => setTriggerSheetVisible(true)}
            style={({ pressed }) => [
              settingsStyles.infoRow,
              { borderBottomColor: colors.border },
              pressed && settingsStyles.pressed,
            ]}
          >
            <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>
              {t('scrobbleAfter')}
            </Text>
            <Text style={[settingsStyles.infoValue, { color: colors.primary }]}>
              {triggerLabel(scrobbleTrigger)}
            </Text>
          </Pressable>
          <View style={[settingsStyles.infoRow, { borderBottomColor: colors.border }]}>
            <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>{t('pendingScrobbles')}</Text>
            <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>
              {pendingScrobbleCount}
            </Text>
          </View>
          <View style={[settingsStyles.infoRow, { borderBottomColor: colors.border }]}>
            <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>{t('completedScrobbles')}</Text>
            <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>
              {completedScrobbleCount}
            </Text>
          </View>
          <View style={[settingsStyles.infoRow, { borderBottomColor: colors.border }]}>
            <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>{t('scrobbleExclusions')}</Text>
            <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>
              {scrobbleExclusionCount}
            </Text>
          </View>
          <Pressable
            onPress={() => router.push('/scrobble-browser')}
            style={({ pressed }) => [
              settingsStyles.navRow,
              { borderTopColor: colors.border },
              pressed && settingsStyles.pressed,
            ]}
          >
            <View style={settingsStyles.navRowLeft}>
              <Ionicons name="list-outline" size={18} color={colors.textPrimary} />
              <Text style={[settingsStyles.navRowText, { color: colors.textPrimary }]}>
                {t('browseScrobbles')}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </Pressable>
          <Pressable
            onPress={() => router.push('/scrobble-exclusion-browser')}
            style={({ pressed }) => [
              settingsStyles.navRow,
              { borderTopColor: colors.border },
              pressed && settingsStyles.pressed,
            ]}
          >
            <View style={settingsStyles.navRowLeft}>
              <Ionicons name="eye-off-outline" size={18} color={colors.textPrimary} />
              <Text style={[settingsStyles.navRowText, { color: colors.textPrimary }]}>
                {t('manageExclusions')}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </Pressable>
        </View>
      </View>

      <Modal
        visible={triggerSheetVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setTriggerSheetVisible(false)}
      >
        <Pressable style={settingsStyles.sheetBackdrop} onPress={() => setTriggerSheetVisible(false)} />
        <View
          style={[
            settingsStyles.sheet,
            { backgroundColor: colors.card, paddingBottom: Math.max(insets.bottom, 16) },
          ]}
        >
          <View style={[settingsStyles.sheetHandle, { backgroundColor: colors.border }]} />
          <Text style={[settingsStyles.sheetTitle, { color: colors.textPrimary }]}>
            {t('scrobbleAfter')}
          </Text>
          <Text style={[settingsStyles.sheetHint, { color: colors.textSecondary }]}>
            {t('scrobbleAfterHint')}
          </Text>
          {SCROBBLE_MILESTONES.map((opt) => (
            <Pressable
              key={opt}
              onPress={() => {
                setScrobbleTrigger(opt);
                setTriggerSheetVisible(false);
              }}
              style={({ pressed }) => [settingsStyles.sheetOption, pressed && settingsStyles.pressed]}
            >
              <Text style={[settingsStyles.sheetOptionLabel, { color: colors.textPrimary }]}>
                {triggerLabel(opt)}
              </Text>
              {scrobbleTrigger === opt && (
                <Ionicons name="checkmark" size={22} color={colors.primary} />
              )}
            </Pressable>
          ))}
        </View>
      </Modal>
    </>
  );
}
