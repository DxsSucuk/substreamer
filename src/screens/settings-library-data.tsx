import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useContext } from 'react';
import { ScrollView } from 'react-native';

import { BottomChrome } from '../components/BottomChrome';
import { GradientBackground } from '../components/GradientBackground';
import { BackupRestoreCard } from '../components/settings/BackupRestoreCard';
import { CachedLyricsCard } from '../components/settings/CachedLyricsCard';
import { LibrarySyncCard } from '../components/settings/LibrarySyncCard';
import { ListeningHistoryCard } from '../components/settings/ListeningHistoryCard';
import { MetadataCorrectionsCard } from '../components/settings/MetadataCorrectionsCard';
import { SharesCard } from '../components/settings/SharesCard';
import { settingsStyles } from '../styles/settingsStyles';

export function SettingsLibraryDataScreen() {
  const headerHeight = useContext(HeaderHeightContext) ?? 0;

  return (
    <GradientBackground scrollable>
      <ScrollView
        style={settingsStyles.container}
        contentContainerStyle={[settingsStyles.content, { paddingTop: headerHeight + 16 }]}
        showsVerticalScrollIndicator={false}
      >
        <LibrarySyncCard />
        <ListeningHistoryCard />
        <MetadataCorrectionsCard />
        <CachedLyricsCard />
        <BackupRestoreCard />
        <SharesCard />
      </ScrollView>
      <BottomChrome withSafeAreaPadding />
    </GradientBackground>
  );
}
