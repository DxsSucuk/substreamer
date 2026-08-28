import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useContext } from 'react';
import { ScrollView } from 'react-native';

import { BottomChrome } from '../components/BottomChrome';
import { GradientBackground } from '../components/GradientBackground';
import { DangerousActionsCard } from '../components/settings/DangerousActionsCard';
import { DownloadedMusicCard } from '../components/settings/DownloadedMusicCard';
import { ImageCacheCard } from '../components/settings/ImageCacheCard';
import { StorageLimitCard } from '../components/settings/StorageLimitCard';
import { StorageUsageCard } from '../components/settings/StorageUsageCard';
import { settingsStyles } from '../styles/settingsStyles';

export function SettingsStorageScreen() {
  const headerHeight = useContext(HeaderHeightContext) ?? 0;

  return (
    <GradientBackground scrollable>
      <ScrollView
        style={settingsStyles.container}
        contentContainerStyle={[settingsStyles.content, { paddingTop: headerHeight + 16 }]}
        showsVerticalScrollIndicator={false}
      >
        <StorageUsageCard />
        <StorageLimitCard />
        <DownloadedMusicCard />
        <ImageCacheCard />
        <DangerousActionsCard />
      </ScrollView>
      <BottomChrome withSafeAreaPadding />
    </GradientBackground>
  );
}
