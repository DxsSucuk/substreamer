import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useContext } from 'react';
import { ScrollView } from 'react-native';

import { BottomChrome } from '../components/BottomChrome';
import { GradientBackground } from '../components/GradientBackground';
import { OfflineCard } from '../components/settings/OfflineCard';
import { ServerFailoverCard } from '../components/settings/ServerFailoverCard';
import { TrustedCertificatesCard } from '../components/settings/TrustedCertificatesCard';
import { settingsStyles } from '../styles/settingsStyles';

export function SettingsConnectivityScreen() {
  const headerHeight = useContext(HeaderHeightContext) ?? 0;

  return (
    <GradientBackground scrollable>
      <ScrollView
        style={settingsStyles.container}
        contentContainerStyle={[settingsStyles.content, { paddingTop: headerHeight + 16 }]}
        showsVerticalScrollIndicator={false}
      >
        <OfflineCard />
        <ServerFailoverCard />
        <TrustedCertificatesCard />
      </ScrollView>
      <BottomChrome withSafeAreaPadding />
    </GradientBackground>
  );
}
