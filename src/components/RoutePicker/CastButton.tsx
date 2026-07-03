import MaterialCommunityIcons from '@react-native-vector-icons/material-design-icons/static';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useAudioRoute, useCast } from 'react-native-queue-player';

import { CAST_BUTTON_PREPOSITION, castButtonLabel } from './copy';
import { iconForAudioRoute, iconForCastProtocol } from './iconForRoute';
import { type RoutePickerTheme } from './types';
import { useRoutePickerTheme } from './useRoutePickerTheme';
import { useRoutePickerStore } from './useRoutePickerStore';

export interface CastButtonProps {
  /** Optional theme override; falls back to the app theme. */
  theme?: Partial<RoutePickerTheme>;
}

/**
 * Player-screen cast affordance — an inline pill showing the current audio
 * route ("Listening on X"). Tap opens the RoutePickerSheet. Reads the active
 * cast session name (useCast) and the system audio route (useAudioRoute).
 */
export function CastButton({ theme }: CastButtonProps) {
  const t = useRoutePickerTheme(theme);
  const snapshot = useCast();
  const audioRoute = useAudioRoute();
  const openPicker = useRoutePickerStore((s) => s.open);

  const activeCastName =
    snapshot.route.castProtocol !== 'local' && snapshot.route.name.length > 0
      ? snapshot.route.name
      : null;
  const isCasting = activeCastName != null;
  const label = castButtonLabel(audioRoute, activeCastName);
  const iconName = isCasting
    ? iconForCastProtocol(snapshot.route.castProtocol)
    : iconForAudioRoute(audioRoute);
  const lineColor = isCasting ? t.accent : t.textSubtle;

  return (
    <Pressable
      onPress={openPicker}
      accessibilityRole="button"
      accessibilityLabel={`${CAST_BUTTON_PREPOSITION} ${label}. Tap to change.`}
      testID="cast-button"
      hitSlop={8}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
    >
      <MaterialCommunityIcons name={iconName} size={16} color={lineColor} />
      <Text numberOfLines={1} style={[styles.line, { color: lineColor }]}>
        {CAST_BUTTON_PREPOSITION}{' '}
        <Text style={styles.deviceName}>{label}</Text>
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 2,
  },
  line: {
    fontSize: 13,
    flexShrink: 1,
  },
  deviceName: {
    fontWeight: '700',
  },
});
