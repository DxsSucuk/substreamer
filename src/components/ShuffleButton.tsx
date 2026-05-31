import Ionicons from "@react-native-vector-icons/ionicons/static";
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet } from 'react-native';

import { useTheme } from '../hooks/useTheme';

export interface ShuffleButtonProps {
  onPress: () => void;
  disabled?: boolean;
  size?: number;
}

export const ShuffleButton = memo(function ShuffleButton({
  onPress,
  disabled = false,
  size = 20,
}: ShuffleButtonProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t('shuffleQueue')}
      style={({ pressed }) => [
        styles.container,
        (pressed || disabled) && styles.pressed,
      ]}
    >
      <Ionicons name="shuffle" size={size} color={colors.textPrimary} />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
  },
  pressed: {
    opacity: 0.6,
  },
});
