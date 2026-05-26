import { Text, type TextStyle, type StyleProp } from 'react-native';

import { useTheme } from '../../hooks/useTheme';
import { settingsStyles } from '../../styles/settingsStyles';

/**
 * Section title rendered above every settings card. Wraps the shared
 * `sectionTitle` style + the per-theme label color so call sites no
 * longer need to compose them manually.
 */
export function SettingsSectionTitle({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
}) {
  const { colors } = useTheme();
  return (
    <Text style={[settingsStyles.sectionTitle, { color: colors.label }, style]}>
      {children}
    </Text>
  );
}
