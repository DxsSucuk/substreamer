import Ionicons from '@react-native-vector-icons/ionicons/static';
import { Text, View } from 'react-native';

import { useTheme } from '../../hooks/useTheme';
import { settingsStyles } from '../../styles/settingsStyles';

/**
 * Inline "this isn't available offline" notice — a cloud-offline icon
 * followed by short explanatory text. Used below action buttons that
 * are disabled or constrained when offline.
 */
export function OfflineNotice({ text }: { text: string }) {
  const { colors } = useTheme();
  return (
    <View style={settingsStyles.offlineNotice}>
      <Ionicons name="cloud-offline-outline" size={16} color={colors.textSecondary} />
      <Text style={[settingsStyles.offlineNoticeText, { color: colors.textSecondary }]}>
        {text}
      </Text>
    </View>
  );
}
