import { useIsTabletPortrait } from '@/hooks/useIsTabletPortrait';
import { PlayerPhonePortrait } from '@/screens/player/player-phone-portrait';
import { PlayerTabletPortrait } from '@/screens/player/player-tablet-portrait';

export default function PlayerRoute() {
  const tabletPortrait = useIsTabletPortrait();
  return tabletPortrait ? <PlayerTabletPortrait /> : <PlayerPhonePortrait />;
}
