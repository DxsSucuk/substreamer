import { useIsTabletPortrait } from '@/hooks/useIsTabletPortrait';
import { PlayerView } from '@/screens/player-view';
import { TabletPortraitPlayer } from '@/screens/tablet-portrait-player';

export default function PlayerRoute() {
  const tabletPortrait = useIsTabletPortrait();
  return tabletPortrait ? <TabletPortraitPlayer /> : <PlayerView />;
}
