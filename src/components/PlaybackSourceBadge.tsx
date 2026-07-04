import Ionicons from '@react-native-vector-icons/ionicons/static';
import MaterialCommunityIcons from '@react-native-vector-icons/material-design-icons/static';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../hooks/useTheme';
import { playerStore } from '../store/playerStore';
import { DownloadedIcon } from './DownloadedIcon';

/**
 * At-a-glance "where is this playing from" badge, overlaid on the cover art
 * (bottom-right), styled to match the SleepTimerCapsule (translucent pill).
 * - `local`     → downloaded file on device → our two-tone DownloadedIcon
 * - `cached`    → held in the lookahead cache → storage (harddisk) glyph
 * - `streaming` → live from the server       → cloud glyph
 * Hidden when the source is unknown (nothing loaded / not yet reported).
 */
export const PlaybackSourceBadge = memo(function PlaybackSourceBadge() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const source = playerStore((s) => s.trackSource);

  if (source == null) return null;

  let icon: React.ReactNode;
  let label: string;
  if (source === 'local') {
    icon = <DownloadedIcon size={18} circleColor={colors.primary} arrowColor="#fff" />;
    label = t('sourceLocal');
  } else if (source === 'cached') {
    icon = <MaterialCommunityIcons name="harddisk" size={16} color="#fff" />;
    label = t('sourceCached');
  } else {
    icon = <Ionicons name="cloud-outline" size={16} color="#fff" />;
    label = t('sourceStreaming');
  }

  return (
    <View
      style={styles.badge}
      accessibilityRole="image"
      accessibilityLabel={label}
      testID={`source-badge-${source}`}
    >
      {icon}
    </View>
  );
});

const styles = StyleSheet.create({
  badge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },
});
