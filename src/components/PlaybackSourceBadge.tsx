import MaterialCommunityIcons from '@react-native-vector-icons/material-design-icons/static';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { playerStore } from '../store/playerStore';

/**
 * At-a-glance "where is this playing from" badge, overlaid on the cover art
 * (bottom-right). All three glyphs are circular MaterialCommunityIcons rendered
 * in the same white the SleepTimerCapsule uses for its text, so they read as a
 * consistent monochrome set — the glyph's own circle is the badge, no pill.
 * - `local`     → downloaded file on device → arrow-down-circle
 * - `cached`    → held in the lookahead cache → lightning-bolt-circle
 * - `streaming` → live from the server       → cloud-circle
 * Hidden when the source is unknown (nothing loaded / not yet reported).
 */
const SOURCE_ICON = {
  local: 'arrow-down-circle',
  cached: 'lightning-bolt-circle',
  streaming: 'cloud-circle',
} as const;

const SOURCE_LABEL = {
  local: 'sourceLocal',
  cached: 'sourceCached',
  streaming: 'sourceStreaming',
} as const;

export const PlaybackSourceBadge = memo(function PlaybackSourceBadge() {
  const { t } = useTranslation();
  const source = playerStore((s) => s.trackSource);

  if (source == null) return null;

  return (
    <View
      style={styles.badge}
      accessibilityRole="image"
      accessibilityLabel={t(SOURCE_LABEL[source])}
      testID={`source-badge-${source}`}
    >
      <MaterialCommunityIcons
        name={SOURCE_ICON[source]}
        size={24}
        color="#fff"
        style={styles.icon}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  badge: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  // A soft shadow keeps the white glyph legible over light cover art without
  // re-introducing a background pill.
  icon: {
    textShadowColor: 'rgba(0, 0, 0, 0.45)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});
