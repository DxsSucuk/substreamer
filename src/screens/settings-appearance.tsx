import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useContext } from 'react';
import { ScrollView } from 'react-native';

import { BottomChrome } from '../components/BottomChrome';
import { GradientBackground } from '../components/GradientBackground';
import { AccentColorCard } from '../components/settings/AccentColorCard';
import { AlbumSortOrderCard } from '../components/settings/AlbumSortOrderCard';
import { ArtistAlbumSortOrderCard } from '../components/settings/ArtistAlbumSortOrderCard';
import { ArtistPlayModeCard } from '../components/settings/ArtistPlayModeCard';
import { BookmarksCard } from '../components/settings/BookmarksCard';
import { DateFormatCard } from '../components/settings/DateFormatCard';
import { FavoritesLayoutCard } from '../components/settings/FavoritesLayoutCard';
import { FiltersCard } from '../components/settings/FiltersCard';
import { LanguageCard } from '../components/settings/LanguageCard';
import { LibraryLayoutCard } from '../components/settings/LibraryLayoutCard';
import { ListLengthCard } from '../components/settings/ListLengthCard';
import { SongCoverArtCard } from '../components/settings/SongCoverArtCard';
import { ThemeCard } from '../components/settings/ThemeCard';
import { settingsStyles } from '../styles/settingsStyles';

export function SettingsAppearanceScreen() {
  const headerHeight = useContext(HeaderHeightContext) ?? 0;

  return (
    <GradientBackground scrollable>
      <ScrollView
        style={settingsStyles.container}
        contentContainerStyle={[settingsStyles.content, { paddingTop: headerHeight + 16 }]}
        showsVerticalScrollIndicator={false}
      >
        <ThemeCard />
        <AccentColorCard />
        <BookmarksCard />
        <LanguageCard />
        <AlbumSortOrderCard />
        <ArtistAlbumSortOrderCard />
        <DateFormatCard />
        <SongCoverArtCard />
        <ListLengthCard />
        <ArtistPlayModeCard />
        <FiltersCard />
        <LibraryLayoutCard />
        <FavoritesLayoutCard />
      </ScrollView>
      <BottomChrome withSafeAreaPadding />
    </GradientBackground>
  );
}
