import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../../hooks/useTheme';
import { settingsStyles } from '../../styles/settingsStyles';

/**
 * A settings list row: a label (+ optional hint) on the left and an optional
 * right-aligned control (a Switch, a checkmark, …). Pass `onPress` to make the
 * whole row tappable (selection rows); omit it for static toggle rows. `isLast`
 * drops the bottom hairline for the final row in a card.
 */
export function SettingsRow({
  label,
  hint,
  right,
  onPress,
  isLast,
}: {
  label: string;
  hint?: string;
  right?: ReactNode;
  onPress?: () => void;
  isLast?: boolean;
}) {
  const { colors } = useTheme();
  const rowStyle = [
    styles.row,
    isLast ? styles.rowLast : { borderBottomColor: colors.border },
  ];
  const body = (
    <>
      <View style={styles.textWrap}>
        <Text style={[styles.label, { color: colors.textPrimary }]}>{label}</Text>
        {hint != null && (
          <Text style={[styles.hint, { color: colors.textSecondary }]}>{hint}</Text>
        )}
      </View>
      {right}
    </>
  );
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [rowStyle, pressed && settingsStyles.pressed]}
      >
        {body}
      </Pressable>
    );
  }
  return <View style={rowStyle}>{body}</View>;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLast: { borderBottomWidth: 0 },
  textWrap: { flex: 1, marginRight: 12 },
  label: { fontSize: 16, fontWeight: '500' },
  hint: { fontSize: 12, marginTop: 4, lineHeight: 16 },
});
