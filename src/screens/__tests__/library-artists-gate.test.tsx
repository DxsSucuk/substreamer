jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

jest.mock('expo-router/react-navigation', () => ({ useIsFocused: () => true }));

// The four segment screens have their own suites; here they only need to be
// distinguishable, so the gate's two branches can be told apart.
jest.mock('../album-library-list', () => ({ AlbumLibraryListScreen: () => null }));
jest.mock('../playlist-list', () => ({ PlaylistListScreen: () => null }));
jest.mock('../song-library-list', () => ({ SongLibraryListScreen: () => null }));
jest.mock('../artist-list', () => {
  const { Text } = require('react-native');
  return { ArtistListScreen: () => <Text testID="artist-list">artist list</Text> };
});

import React from 'react';
import { fireEvent, render, waitFor, type RenderAPI } from '@testing-library/react-native';

import { filterBarStore } from '../../store/filterBarStore';
import { offlineModeStore } from '../../store/offlineModeStore';
import { LibraryScreen } from '../library';

/** Open the Artists segment — the gate under test only renders there. The screen defers
 *  segment content past an idle window (`runWhenIdle`), so callers assert inside
 *  `waitFor`; until it elapses only a spinner is mounted. */
const showArtists = (): RenderAPI => {
  const r = render(<LibraryScreen />);
  fireEvent.press(r.getByText('Artists'));
  return r;
};

beforeEach(() => {
  filterBarStore.setState({ downloadedOnly: false, favoritesOnly: false });
  offlineModeStore.setState({ offlineMode: false });
});

/**
 * Artists cannot be downloaded, so the DOWNLOADED filter — not offline mode — is what
 * hides the Artists segment. Offline mode merely enforces that filter
 * (`offlineModeStore` sets it and `FilterBar` locks it), which is why offline already
 * behaved this way.
 *
 * The implication runs ONE WAY: offline ⇒ downloaded-only, never the reverse. So the
 * copy still keys off `offlineMode` — telling a user who is online with just the
 * Downloaded chip on that artists are "not available offline" would be false.
 */
describe('LibraryScreen — the Artists segment under the Downloaded filter', () => {
  it('renders the artist list when no filter is on', async () => {
    const r = showArtists();
    await waitFor(() => expect(r.queryByTestId('artist-list')).not.toBeNull());
  });

  it('hides the artist list when the Downloaded filter is on, while ONLINE', async () => {
    filterBarStore.setState({ downloadedOnly: true });
    const r = showArtists();
    await waitFor(() => expect(r.queryByText("Artists can't be downloaded")).not.toBeNull());
    expect(r.queryByTestId('artist-list')).toBeNull();
  });

  it('explains it as a download limit, NOT as being offline, when online', async () => {
    filterBarStore.setState({ downloadedOnly: true });
    const r = showArtists();
    await waitFor(() => expect(r.queryByText("Artists can't be downloaded")).not.toBeNull());
    expect(r.getByText('Turn off the Downloaded filter to browse artists')).toBeTruthy();
    // The regression this guards: reusing the offline copy for an online user.
    expect(r.queryByText('Not available offline')).toBeNull();
    expect(r.queryByText('Artists are not available in offline mode')).toBeNull();
  });

  it('keeps the OFFLINE copy when actually offline — unchanged behaviour', async () => {
    offlineModeStore.setState({ offlineMode: true });
    filterBarStore.setState({ downloadedOnly: true }); // offline enforces this
    const r = showArtists();
    await waitFor(() => expect(r.queryByText('Not available offline')).not.toBeNull());
    expect(r.getByText('Artists are not available in offline mode')).toBeTruthy();
    expect(r.queryByTestId('artist-list')).toBeNull();
  });

  it('still shows the artist list with only the Favourites filter on', async () => {
    filterBarStore.setState({ favoritesOnly: true });
    const r = showArtists();
    await waitFor(() => expect(r.queryByTestId('artist-list')).not.toBeNull());
  });
});
