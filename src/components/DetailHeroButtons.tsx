import Ionicons from '@react-native-vector-icons/ionicons/static';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../hooks/useTheme';

/**
 * Round shuffle-play button shared by the album / artist / playlist detail
 * heroes. Owns the button visual only — spacing between siblings is a parent
 * concern, supplied via `style` (album/playlist pass a marginLeft; artist's
 * gap-based row passes nothing).
 */
export function ShufflePlayButton({
  onPress,
  style,
}: {
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.shuffleButton, style, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={t('shufflePlay')}
    >
      <Ionicons name="shuffle" size={18} color="#000" />
    </Pressable>
  );
}

/** Round primary play-all button shared by the detail heroes. See {@link ShufflePlayButton}. */
export function PlayAllButton({
  onPress,
  style,
}: {
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.playAllButton,
        { backgroundColor: colors.primary },
        style,
        pressed && styles.pressed,
      ]}
    >
      <Ionicons name="play" size={28} color="#fff" style={styles.playAllIcon} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  shuffleButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  playAllButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playAllIcon: {
    marginLeft: 3,
  },
  pressed: {
    opacity: 0.7,
  },
});
