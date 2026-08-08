import { useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SettingsLinkRow } from '../components/settings/SettingsLinkRow';
import { VersionFooter } from '../components/settings/VersionFooter';
import { devOptionsStore } from '../store/devOptionsStore';
import { onboardingStore } from '../store/onboardingStore';
import { searchStore } from '../store/searchStore';

import type { IoniconsName } from '../utils/iconNames';

const SETTINGS_LINKS: {
  route: string;
  labelKey: string;
  subtitleKey: string;
  icon: IoniconsName;
}[] = [
  { route: '/settings-server', labelKey: 'serverAccount', subtitleKey: 'serverAccountSubtitle', icon: 'server-outline' },
  { route: '/settings-appearance', labelKey: 'appearanceLayout', subtitleKey: 'appearanceLayoutSubtitle', icon: 'color-palette-outline' },
  { route: '/settings-playback', labelKey: 'soundPlayback', subtitleKey: 'soundPlaybackSubtitle', icon: 'musical-notes-outline' },
  { route: '/settings-connectivity', labelKey: 'connectivity', subtitleKey: 'connectivitySubtitle', icon: 'globe-outline' },
  { route: '/settings-storage', labelKey: 'storage', subtitleKey: 'storageSubtitle', icon: 'folder-outline' },
  { route: '/settings-library-data', labelKey: 'libraryData', subtitleKey: 'libraryDataSubtitle', icon: 'library-outline' },
];

const DEV_SETTINGS_LINKS: typeof SETTINGS_LINKS = [
  { route: '/file-explorer', labelKey: 'fileExplorer', subtitleKey: 'fileExplorerSubtitle', icon: 'document-text-outline' },
  { route: '/logging', labelKey: 'logging', subtitleKey: 'loggingSubtitle', icon: 'list-outline' },
];

export function SettingsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const headerHeight = searchStore((s) => s.headerHeight);
  const devEnabled = devOptionsStore((s) => s.enabled);

  const visibleLinks = useMemo(
    () => (devEnabled ? [...SETTINGS_LINKS, ...DEV_SETTINGS_LINKS] : SETTINGS_LINKS),
    [devEnabled],
  );

  const handleShowOnboarding = useCallback(() => {
    onboardingStore.getState().reset();
    onboardingStore.getState().show();
  }, []);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: headerHeight + 16 }]}
      showsVerticalScrollIndicator={false}
    >
      {visibleLinks.map((link) => (
        <SettingsLinkRow
          key={link.route}
          label={t(link.labelKey)}
          subtitle={t(link.subtitleKey)}
          icon={link.icon}
          onPress={() => router.push(link.route as never)}
        />
      ))}
      <SettingsLinkRow
        label={t('helpWelcomeGuide')}
        subtitle={t('helpWelcomeGuideSubtitle')}
        icon="help-circle-outline"
        onPress={handleShowOnboarding}
      />
      <VersionFooter />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    padding: 16,
    paddingBottom: 32,
    gap: 12,
  },
});
