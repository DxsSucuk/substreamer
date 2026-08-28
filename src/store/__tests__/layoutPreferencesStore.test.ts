jest.mock('../persistence/kvStorage', () => require('../persistence/__mocks__/kvStorage'));

import { layoutPreferencesStore } from '../layoutPreferencesStore';

beforeEach(() => {
  layoutPreferencesStore.setState({
    albumLayout: 'list',
    artistLayout: 'list',
    playlistLayout: 'list',
    favSongLayout: 'list',
    favAlbumLayout: 'list',
    favArtistLayout: 'list',
    albumSortOrder: 'artist',
    artistAlbumSortOrder: 'newest',
    dateFormat: 'yyyy/mm/dd',
    listLength: 20,
  });
});

describe('layoutPreferencesStore', () => {
  it('setAlbumLayout changes album layout', () => {
    layoutPreferencesStore.getState().setAlbumLayout('grid');
    expect(layoutPreferencesStore.getState().albumLayout).toBe('grid');
  });

  it('setArtistLayout changes artist layout', () => {
    layoutPreferencesStore.getState().setArtistLayout('grid');
    expect(layoutPreferencesStore.getState().artistLayout).toBe('grid');
  });

  it('setPlaylistLayout changes playlist layout', () => {
    layoutPreferencesStore.getState().setPlaylistLayout('grid');
    expect(layoutPreferencesStore.getState().playlistLayout).toBe('grid');
  });

  it('setFavSongLayout changes fav song layout', () => {
    layoutPreferencesStore.getState().setFavSongLayout('grid');
    expect(layoutPreferencesStore.getState().favSongLayout).toBe('grid');
  });

  it('setFavAlbumLayout changes fav album layout', () => {
    layoutPreferencesStore.getState().setFavAlbumLayout('grid');
    expect(layoutPreferencesStore.getState().favAlbumLayout).toBe('grid');
  });

  it('setFavArtistLayout changes fav artist layout', () => {
    layoutPreferencesStore.getState().setFavArtistLayout('grid');
    expect(layoutPreferencesStore.getState().favArtistLayout).toBe('grid');
  });

  it('setAlbumSortOrder changes sort order', () => {
    layoutPreferencesStore.getState().setAlbumSortOrder('title');
    expect(layoutPreferencesStore.getState().albumSortOrder).toBe('title');
  });

  it('defaults songSortOrder to title and setSongSortOrder changes it', () => {
    expect(layoutPreferencesStore.getState().songSortOrder).toBe('title');
    layoutPreferencesStore.getState().setSongSortOrder('artist');
    expect(layoutPreferencesStore.getState().songSortOrder).toBe('artist');
  });

  it('setArtistAlbumSortOrder changes artist album sort', () => {
    layoutPreferencesStore.getState().setArtistAlbumSortOrder('oldest');
    expect(layoutPreferencesStore.getState().artistAlbumSortOrder).toBe('oldest');
  });

  it('setDateFormat changes date format', () => {
    layoutPreferencesStore.getState().setDateFormat('yyyy/dd/mm');
    expect(layoutPreferencesStore.getState().dateFormat).toBe('yyyy/dd/mm');
  });

  it('has default listLength of 20', () => {
    expect(layoutPreferencesStore.getState().listLength).toBe(20);
  });

  it('setListLength changes list length', () => {
    for (const value of [30, 50, 100, 20] as const) {
      layoutPreferencesStore.getState().setListLength(value);
      expect(layoutPreferencesStore.getState().listLength).toBe(value);
    }
  });

  it('includePartialInDownloadedFilter defaults to false', () => {
    expect(layoutPreferencesStore.getState().includePartialInDownloadedFilter).toBe(false);
  });

  it('setIncludePartialInDownloadedFilter toggles the flag', () => {
    layoutPreferencesStore.getState().setIncludePartialInDownloadedFilter(true);
    expect(layoutPreferencesStore.getState().includePartialInDownloadedFilter).toBe(true);
    layoutPreferencesStore.getState().setIncludePartialInDownloadedFilter(false);
    expect(layoutPreferencesStore.getState().includePartialInDownloadedFilter).toBe(false);
  });
});
